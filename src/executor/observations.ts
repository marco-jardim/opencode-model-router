import { observeV2, type ObservationValue, type V2Observations } from "../compat/v2-observations";
import { pathsOverlap } from "./schedule";
import type { Clock, LedgerV1, LedgerWriter } from "./types";

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
