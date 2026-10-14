import { observeV2, type ObservationValue, type ServiceIdentity, type ServiceSpanKind, type V2Observations } from "../compat/v2-observations";
import { pathsOverlap } from "./schedule";
import type { Clock, LedgerV1, LedgerWriter } from "./types";

/**
 * Service family (v2 opt-in only), amended G8 intrinsic-time oracle:
 * {family:"service",spanKind:"service"|"service-prep"|"service-wait"|"service-unattributed",action:"start"|"end",
 *  planId,taskId,attempt,phaseId,entryId,taskIds,component,candidate,operationId,stage,clockMs,durationMs,result}.
 * Task verification identifies taskId+attempt; integration identifies phaseId+entryId and copies ALL entry.taskIds
 * (also for a batch probe/subset). candidate is the checked commit/snapshot identity, null when not yet known.
 * Pre-entry queue/lane/repo-lock waits have entryId=null (no journal entry exists yet), retaining taskId+attempt
 * or phaseId and the queued taskIds. Never fabricate a future entry ID or attribute these waits as execution.
 * operationId is unique within the sink/stream, shared by exactly one start/end pair, including failed attempts.
 * stage distinguishes command/recheck/grading, rebase, merge and CAS, and named preparation/resource waits.
 * clockMs uses the process monotonic performance clock (NOT epoch `at` or journal duration); durationMs is zero
 * on start and end-start on end. result is null on start, a bounded outcome label on end, never output/error text.
 * Results describe that operation (pass/fail/error/timed-out/interrupted, completed for grading/preparation,
 * acquired/busy for a slot, dequeued/dropped/disposed/aborted for a queue wait), NOT the published task verdict.
 * Sum ONLY service intervals: mandatory verification execution/grading, actual rebase, mandatory integration
 * command execution, checked merge/CAS, and phase-suite command execution. No enclosing journal/gate durations.
 * Preparation (capture, snapshot/environment, checkout reset/provisioning, planning, grader startup) and resource
 * waits (leases, repo/verification slots, lanes) are separate, possibly nested, non-service spans. Publication,
 * release/cleanup and retry backoff are never service. No execution (memo/no-checks/aborted-before-run) means no
 * service pair. Repeated executions/retries have distinct IDs; do not deduplicate by candidate or taskIds.
 * End precedes result publication/cleanup. Exceptions still close pairs. Missing pairs/faulted streams are UNKNOWN,
 * not zero service. Unattributed spans (native grading without provider attempt events) are also UNKNOWN, never
 * zero or intrinsic service. Observations neither query for identity nor change admission, scheduling or verification.
 */
export interface ServiceObservation {
  start(kind: ServiceSpanKind, stage: string, candidate?: string | null): { end(result: string): void } | undefined;
  execution(stage: string, candidate?: string | null): ServiceExecution | undefined;
}

/** Per-call, diagnostic-only process hook. Methods are idempotent and contain observer failures. */
export interface ServiceExecution {
  /** A process adapter claims the call BEFORE preparing its executable/environment or refusing a spawn. */
  prepare(): void;
  /** Immediately before the actual spawn, after all preparation. */
  start(): void;
  /** At process settlement, before result conversion/publication/cleanup; also closes a refused preparation. */
  end(result: string): void;
}

const serviceSequences = new WeakMap<V2Observations, number>();

/** Lazy identity and clock; every diagnostic failure is contained, including injected observers/identity thunks. */
export function serviceObservation(sink: V2Observations | undefined, identity: () => ServiceIdentity,
  now: () => number = () => performance.now()): ServiceObservation | undefined {
  if (sink === undefined) return undefined;
  const open = (spanKind: ServiceSpanKind, stage: string, candidate?: string | null,
    project = identity, clock = now): ReturnType<ServiceObservation["start"]> => {
    let captured: ServiceIdentity | undefined;
    let operationId = "";
    let started = 0;
    observeV2(sink, () => {
      captured = { ...project(), ...(candidate === undefined ? {} : { candidate }) };
      captured = { ...captured, taskIds: [...captured.taskIds] };
      const n = (serviceSequences.get(sink) ?? 0) + 1;
      serviceSequences.set(sink, n);
      operationId = `service-${n}`;
      started = clock();
      return { ...captured, family: "service", spanKind, stage, operationId, action: "start", clockMs: started, durationMs: 0, result: null };
    });
    if (captured === undefined || operationId === "") return undefined;
    const fields = captured;
    let ended = false;
    return { end(result) {
      if (ended) return;
      ended = true;
      observeV2(sink, () => {
        const clockMs = now();
        return { ...fields, family: "service", spanKind, stage, operationId, action: "end", clockMs, durationMs: clockMs - started, result };
      });
    } };
  };
  return {
    start: open,
    execution(stage, candidate) {
      // Defer classification, not the clock/identity. An injected execution-only seam is itself the boundary;
      // production adapters call prepare/start/end to split preparation from the actual child lifetime.
      let captured: ServiceIdentity, started: number;
      try {
        captured = { ...identity(), ...(candidate === undefined ? {} : { candidate }) };
        captured = { ...captured, taskIds: [...captured.taskIds] };
        started = now();
      } catch (error) {
        observeV2(sink, () => { throw error; });
        return undefined;
      }
      let phase: "pending" | "preparation" | "execution" | "ended" = "pending";
      let span: ReturnType<ServiceObservation["start"]>;
      const begin = (kind: ServiceSpanKind, name: string, clock = now) => open(kind, name, undefined, () => captured, clock);
      return {
        prepare() {
          if (phase !== "pending") return;
          phase = "preparation";
          span = begin("service-prep", "process-preparation", () => started);
        },
        start() {
          if (phase === "execution" || phase === "ended") return;
          span?.end("completed");
          phase = "execution";
          span = begin("service", stage);
        },
        end(result) {
          if (phase === "ended") return;
          if (phase === "pending") span = begin("service", stage, () => started);
          phase = "ended";
          span?.end(result);
        },
      };
    },
  };
}

/** Same plan-scoped v2 port as physical slots; queue/checks need no runtime or scheduling hook. */
export function executorServiceObservation(clock: Clock, planId: string, identity: () => ServiceIdentity): ServiceObservation | undefined {
  return serviceObservation(slotObservers.get(clock)?.get(planId)?.sink, identity);
}

/**
 * Physical-slot schema (scheduler family; separate from provider tokens and write leases):
 * Ledger/attach tasks include `slot: string|null`. Clearing it does NOT assert a successful pool release.
 * Pool rows have {planId,parentSessionID,action,state}, where state is
 * {clockMs,maxParallel,opened,closed,slots:[{slot,kind,state,taskId}],corrupt:[slot],detail}.
 * `slot` is the pool-local name, never a path; identity is (planId,slot). `taskId` is null for special slots
 * and unrecognised owners. Slot states are creating/provisioning/ready/leased/resetting/broken/retired.
 * A ledger slot outside the pool's name grammar invalidates the observation, never emits arbitrary text/paths.
 * Every row copies the current in-memory records, never calls get/list or performs diagnostic I/O.
 * Actions/detail:
 * - slot-pool-open, slot-pool-close: null.
 * - slot-state: {slot}, immediately AFTER a committed in-memory record swap/removal (including recovery/GC).
 *   This observes creating, reset/provisioning, leased-to-task, broken and ready/available transitions.
 * - slot-acquire-start: {kind,taskId} (before the existing pool-lock wait).
 * - slot-claim: {slot,kind,taskId,mode}, after claim under the pool mutex, before work under the slot mutex.
 * - slot-acquire-result: {slot,kind,taskId,mode,result}; mode=same/reset/create/recreate, or null when claim failed;
 *   result=created/reused/unavailable/failed. A failed claim has slot=null; work failures retain the claimed slot.
 * - slot-provision-start, slot-reset-start: {slot}.
 * - slot-provision-end, slot-reset-end: {slot,result}, result=completed/failed. Completion is NOT availability:
 *   the slot can still be provisioning/resetting/leased; consult the accompanying records.
 * - slot-release-start, slot-release-failed: {slot}, under the slot mutex. Failure leaves the actual record unchanged.
 * - slot-release-complete: {slot,result}, result=released/unchanged. `released` follows the awaited marker write
 *   AND memory swap to ready/owner=null. `unchanged` is the existing no-op (missing or non-leased record), not availability.
 * A provider release, task.slot=null, lease-release or release-start is NOT evidence of physical availability.
 * ready records can be reused; live task records count against maxParallel (integration/ci do not).
 * Unused capacity/broken replacement still requires a successful claim; corrupt/unmarked directories can refuse it.
 * Missing pool facts are UNKNOWN. No scheduler decisions are inferred or changed by this stream.
 */

/**
 * Runtime idle-close schema (scheduler family, separate from physical-slot actions):
 * {family:"scheduler",planId,parentSessionID,action:"idle-close",state:{clockMs,ledgerSeq,...,detail:{fromMs,toMs,ms,
 *  metric:{name:"idle-with-ready",fromAt,toAt,ms,readyTaskIds,free}}}}.
 * Emitted inside closeIdle at the actual closing continuation, before the asynchronous metric append can run.
 * clockMs=toMs uses the metric endpoint's single Clock.now() sample; ms=max(0,toMs-fromMs). No extra clock read.
 * metric is a defensive copy of the full, unchanged ledger payload: correlate by planId, payload and occurrence
 * order, not by the later journal timestamp. ledgerSeq is the committed watermark at closure, NOT the metric's seq.
 * A row observes metric creation, not successful journal persistence or scheduling eligibility. Capture is lazy,
 * exception-contained and inert without the v2 observation sink; it neither queries nor changes scheduler state.
 */

// Runtime and its lazily-created plan pools already share the injected clock object. Scope the diagnostic port
// by that identity AND plan, so queue-owned operations are covered too, without wrapping pool methods or adding
// queries/awaits to assembly. No entry exists off/v1; detach drops the writer/sink, and the clock key is weak.
const slotObservers = new WeakMap<Clock, Map<string, { sink: V2Observations; writer: LedgerWriter }>>();

export function attachSlotObservations(sink: V2Observations | undefined, clock: Clock, writer: LedgerWriter): void {
  if (sink === undefined) return;
  try {
    let plans = slotObservers.get(clock);
    if (plans === undefined) { plans = new Map(); slotObservers.set(clock, plans); }
    plans.set(writer.planId, { sink, writer });
  } catch { /* Diagnostics must not affect attachment. */ }
}

export function detachSlotObservations(clock: Clock, writer: LedgerWriter): void {
  try {
    const plans = slotObservers.get(clock);
    if (plans?.get(writer.planId)?.writer === writer) plans.delete(writer.planId);
    if (plans?.size === 0) slotObservers.delete(clock);
  } catch { /* Diagnostics must not affect detachment. */ }
}

export function observeSlotPool(clock: Clock, planId: string, action: string, state: () => ObservationValue): void {
  const port = slotObservers.get(clock)?.get(planId);
  if (port === undefined) return;
  observeV2(port.sink, () => ({ family: "scheduler", planId,
    parentSessionID: port.writer.ledger.orchestrator.sessionID, action, state: state() }));
}

/** Raw committed scheduler inputs, not readySet/updateIdle output. No plan text, evidence, paths or commands. */
export function observeSchedulerLedger(sink: V2Observations | undefined, ledger: Readonly<LedgerV1>, action: "ledger" | "attach"): void {
  observeV2(sink, () => {
    const tasks = Object.values(ledger.tasks);
    if (tasks.length > 256) throw new Error("scheduler observation task bound");
    // The ledger accepts arbitrary strings here; unlike pool markers, it does not enforce the slot-name grammar.
    if (tasks.some(t => t.slot !== null && !/^(?:slot-[1-9][0-9]{0,2}|integration|ci)$/.test(t.slot))) {
      throw new Error("scheduler observation slot identity");
    }
    return { family: "scheduler", planId: ledger.planId, parentSessionID: ledger.orchestrator.sessionID, action,
      state: {
        ledgerSeq: ledger.seq, status: ledger.status, maxParallel: ledger.config.maxParallel,
        tasks: tasks.map((t) => ({ id: t.id, state: t.state, kind: t.kind, phase: t.phase, p50: t.estimate.p50, slot: t.slot,
          attempts: t.attempts.map((a) => ({ n: a.n, callID: a.callID, childSessionID: a.childSessionID, outcome: a.outcome })) })),
        edges: ledger.edges.map((e) => ({ from: e.from, to: e.to })),
        phases: ledger.phases.map((p) => ({ id: p.id, gate: p.gate, paused: p.paused })),
        // Pairwise conflict facts preserve the scheduler's prefix-overlap rule without disclosing paths.
        writeConflicts: tasks.flatMap((t, i) => tasks.slice(i + 1).filter((other) =>
          t.footprint.writes.some((a) => other.footprint.writes.some((b) => pathsOverlap(a, b)))).map((other) => [t.id, other.id])),
      } };
  });
}
