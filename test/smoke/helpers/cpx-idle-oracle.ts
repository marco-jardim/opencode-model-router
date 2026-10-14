import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { checkV2ObservationStream, type ObservationRecord } from "../../../src/compat/v2-observations";

export const G8_IDLE_CEILING_MS = 10_000;
export interface ObservationFile { file: string; text: string }
export interface IdleFragment { fromAt: string; toAt: string; ms: number; readyTaskIds: readonly string[] }
export interface SlotDiagnostic {
  fromMs: number; toMs: number; ms: number; fromSeq: number; toSeq: number;
  status: "launchable" | "slot-blocked" | "slot-unknown"; reason: string; poolSeq: number | null;
}
export interface IdleEpisode {
  fromMs: number; toMs: number; ms: number; fromSeq: number; toSeq: number;
  readyTaskIds: string[]; endedBy: string;
  /** Predicate B only: NEVER used to shorten/split the asserted predicate-A episode. */
  slotDiagnostics: SlotDiagnostic[];
}
type SchedulerRow = Extract<ObservationRecord, { family: "scheduler" }>;
type Bag = Record<string, unknown>;
interface Task { id: string; state: string; kind: string; phase: string | null }
interface Graph {
  ledgerSeq: number; status: string; tasks: Task[];
  edges: { from: string; to: string }[];
  phases: { id: string; gate: string; paused: boolean }[];
}
interface Step { taskId: string; attempt: number; launch?: number; result?: string }
interface Route { provider: string; heavy: boolean }
interface Provider { limit: number; paused: boolean; queried: Set<boolean> }
interface Token extends Route { taskId: string; attempt: number; launched: boolean }
interface Pool {
  seq: number; maxParallel: number; opened: boolean; closed: boolean; corrupt: string[];
  slots: { slot: string; kind: string; state: string; taskId: string | null }[];
}
const SLOT_ACTIONS = new Set(["slot-pool-open", "slot-pool-close", "slot-state", "slot-acquire-start", "slot-claim",
  "slot-acquire-result", "slot-provision-start", "slot-provision-end", "slot-reset-start", "slot-reset-end",
  "slot-release-start", "slot-release-failed", "slot-release-complete"]);
// M14: runtime.makeCapacity uses the default per-provider heavy cap (types.ts), not a per-run override.
const HEAVY_PROVIDER_CAP = 2;
const RAW_ACTIONS = new Set(["capacity-init", "provider", "lease-acquire", "lease-release"]);
const RUNTIME_ACTIONS = new Set(["route", "route-unavailable", "capacity-free", "capacity-reserve", "capacity-release",
  "lease-eligibility", "launch-gate", "launch-prepare", "launch", "launch-step-end", "orchestrator", "runtime-attach",
  "activation", "activation-end", "promote", "schedule", "abort", "dispose", "detach", "lease-released-notification"]);

function requireFact(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`G8 observations: ${message}`);
}
function bag(value: unknown): Bag {
  requireFact(value !== null && typeof value === "object" && !Array.isArray(value), "missing object");
  return value as Bag;
}
function text(value: unknown): string {
  requireFact(typeof value === "string" && value.length > 0, "missing string");
  return value;
}
function number(value: unknown): number {
  requireFact(typeof value === "number" && Number.isFinite(value) && value >= 0, "invalid timestamp/sequence");
  return value;
}
function list(value: unknown): unknown[] {
  requireFact(Array.isArray(value), "missing array");
  return value;
}
function boolean(value: unknown): boolean {
  requireFact(typeof value === "boolean", "missing boolean");
  return value;
}
function slotName(value: unknown): string {
  const name = text(value);
  requireFact(/^(?:slot-[1-9][0-9]{0,2}|integration|ci)$/.test(name), "invalid physical slot name");
  return name;
}
function poolSnapshot(row: SchedulerRow): Pool {
  const state = bag(row.state);
  const slots = list(state.slots).map(value => {
    const s = bag(value);
    requireFact(["task", "integration", "ci"].includes(text(s.kind)), "unknown physical slot kind");
    requireFact(["creating", "provisioning", "ready", "leased", "resetting", "broken", "retired"].includes(text(s.state)), "unknown physical slot state");
    return { slot: slotName(s.slot), kind: text(s.kind), state: text(s.state), taskId: s.taskId === null ? null : text(s.taskId) };
  });
  requireFact(new Set(slots.map(s => s.slot)).size === slots.length, "duplicate physical slot");
  const maxParallel = number(state.maxParallel);
  requireFact(Number.isInteger(maxParallel) && maxParallel > 0, "invalid physical slot capacity");
  return { seq: row.seq, maxParallel, opened: boolean(state.opened), closed: boolean(state.closed),
    slots, corrupt: list(state.corrupt).map(slotName) };
}
function slotCondition(pool: Pool | undefined, ready: readonly string[]): Pick<SlotDiagnostic, "status" | "reason" | "poolSeq"> {
  const result = (status: SlotDiagnostic["status"], reason: string) => ({ status, reason, poolSeq: pool?.seq ?? null });
  if (!pool || !pool.opened) return result("slot-unknown", "no opened pool snapshot");
  if (pool.closed) return result("slot-blocked", "pool closed");
  const slots = pool.slots.filter(s => s.kind === "task" && s.state !== "retired");
  if (slots.some(s => s.state === "ready")) return result("launchable", "ready task slot");
  if (slots.some(s => s.state === "leased" && s.taskId !== null && ready.includes(s.taskId))) {
    return result("launchable", "task already owns a leased slot");
  }
  // The snapshot proves room under the cap, NOT an unused on-disk name or a successful claim.
  // Broken replacement likewise needs a claim. Do not turn unobserved filesystem facts into B=true.
  if (slots.length < pool.maxParallel || slots.some(s => s.state === "broken")) {
    return result("slot-unknown", pool.corrupt.length ? "creation/replacement unproven; corrupt markers present" : "creation/replacement within cap; physical claim unproven");
  }
  return result("slot-blocked", "task slots occupied or preparing");
}
function graph(value: unknown): Graph {
  const state = bag(value);
  const tasks = list(state.tasks).map(value => {
    const t = bag(value);
    requireFact(["pending", "ready", "dispatched", "running", "completed", "verifying", "verified", "integrating",
      "integrated", "done", "failed", "conflict", "parked", "blocked", "reverted", "cancelled"].includes(text(t.state)), "unknown task state");
    requireFact(["preflight", "task", "tests", "qa", "fix", "manual"].includes(text(t.kind)), "unknown task kind");
    return { id: text(t.id), state: text(t.state), kind: text(t.kind), phase: t.phase === null ? null : text(t.phase) };
  });
  const phases = list(state.phases).map(value => {
    const p = bag(value);
    requireFact(["pending", "suite-running", "suite-failed", "awaiting-qa", "qa-running", "passed"].includes(text(p.gate)), "unknown phase gate");
    return { id: text(p.id), gate: text(p.gate), paused: boolean(p.paused) };
  });
  const edges = list(state.edges).map(value => { const e = bag(value); return { from: text(e.from), to: text(e.to) }; });
  requireFact(new Set(tasks.map(t => t.id)).size === tasks.length, "duplicate task");
  requireFact(new Set(phases.map(p => p.id)).size === phases.length, "duplicate phase");
  for (const t of tasks) requireFact(t.phase === null || phases.some(p => p.id === t.phase), `unknown phase for ${t.id}`);
  for (const e of edges) {
    requireFact(tasks.some(t => t.id === e.to), `unknown edge target ${e.to}`);
    requireFact(e.from.startsWith("gate:") ? phases.some(p => p.id === e.from.slice(5)) : tasks.some(t => t.id === e.from), `unknown edge source ${e.from}`);
  }
  requireFact(["compiling", "awaiting-residue", "awaiting-approval", "running", "paused", "completed", "aborted"].includes(text(state.status)), "unknown plan status");
  return { ledgerSeq: number(state.ledgerSeq), status: text(state.status), tasks, phases, edges };
}

/** Collect every adapter's file, without clipping/filtering rows or manufacturing a seal. Also used on
 * failures before scratch removal: an unsealed capture is useful diagnostics, but is NEVER passing evidence.
 */
export async function collectObservationFiles(directory: string): Promise<ObservationFile[]> {
  const files = (await readdir(directory)).filter(file => file.endsWith(".jsonl")).sort();
  return Promise.all(files.map(async file => ({ file, text: await readFile(path.join(directory, file), "utf8") })));
}

/** Asserted contract A (provider capacity only): an episode is a maximal span with a running plan, idle
 * orchestrator, and at least one durably ready automatic task whose dependencies/phase admission are
 * satisfied AND whose observed route has provider capacity, with NO successful launch in its interior.
 * A launch, orchestrator step, pause/stop, genuinely empty ready set or exhausted/paused provider ends it.
 * Remaining eligible work can open another episode at the same launch timestamp.
 *
 * Choice: docs/plans/critical-path-execution-plan.md:4225 says "No idle-with-ready interval exceeds 10 s"
 * without defining physical availability. runtime.updateIdle uses provider-selected ready work BEFORE
 * slot acquisition; it never queries the physical pool. We therefore assert A, not the weaker B; the owner
 * confirmed A on 2026-10-14 (time spent waiting for a physical slot counts as idle). Route
 * and capacity-free observations establish queried facts; capacity-init/provider transitions and token
 * lifetimes independently reconstruct capacity (including M14's heavy cap). Unqueried routes/capacity
 * are UNKNOWN, never guessed eligible. Lease selection and launch-gate.ready are not readiness oracles.
 *
 * Provider tokens consume A's capacity only on a confirmed launch, not on provisional reservation:
 * an attempt that never launches must NOT fragment an episode. Actual provider exhaustion/pauses do.
 * Physical slot reservations and inFlight likewise cannot break A. A task's
 * provisional ready->dispatched (or failed->retry) journal swaps during preparation are retained until launch
 * (including its own QA gate's provisional qa-running state); a skipped invocation is not a launch.
 * Parking/cancellation, a failed step that finishes without requeue, or a phase pause still removes it.
 * We pair prepare/launch/step-end first:
 * `launch` precedes a possibly throwing call, so only `launch-step-end.result=launched` confirms that boundary.
 *
 * Alternative B (DIAGNOSTIC ONLY) is A plus a task slot ready/creatable within maxParallel. Each A episode
 * has a slot-blocked/launchable/unknown breakdown, never a second bound assertion. ONLY pool snapshots
 * establish physical state: provider/write-lease releases, ledger task.slot=null, release-start/failed,
 * `unchanged` releases and reset/provision completion cannot imply availability. An already-leased slot
 * is usable only by its observed owner. Creating/provisioning/resetting slots occupy the cap; integration
 * and ci slots do not. Missing pool facts, or mere room to create/replace without a proven on-disk claim,
 * remain UNKNOWN (unmarked directories are not in this schema). No diagnostic subspan can forgive >10 s.
 *
 * This fresh-throughput-run oracle requires the complete lifecycle in ONE owning stream, not a splice
 * across restarts. All files (including other adapters' streams) must pass the wire-format completeness
 * check. Hard-restart resilience captures remain diagnostics, not G8 evidence. Runtime boundaries use
 * clockMs; committed graph swaps use at (both epoch ms on the smoke host). No tolerance or ledger idle
 * endpoints are used to infer/extend episodes. Ledger fragments are checked separately, only afterwards.
 */
export function reconstructIdleEpisodes(files: readonly ObservationFile[], identity: {
  planId: string; parentSessionID: string;
  /** High-water mark of the complete exported ledger used for the fragment inventory. */
  finalLedgerSeq: number;
}): { predicate: "A: provider-capacity"; stream: string; episodes: IdleEpisode[]; streams: number; records: number } {
  requireFact(files.length > 0, "missing observation files");
  const streams = new Set<string>();
  const rows: SchedulerRow[] = [];
  let records = 0;
  for (const file of files) {
    requireFact(file.text.endsWith("\n"), `truncated JSONL file ${file.file}`);
    const lines = file.text.slice(0, -1).split(/\r?\n/);
    const checked = checkV2ObservationStream(lines);
    const stream = text(bag(JSON.parse(lines[0]!)).stream);
    requireFact(!streams.has(stream), `duplicate stream ${stream}`);
    streams.add(stream);
    records += checked.length;
    let at = -Infinity;
    for (const row of checked) {
      requireFact(row.at >= at, `clock moved backwards in ${stream}`);
      at = row.at;
      if (row.family === "scheduler" && row.planId === identity.planId) {
        requireFact(row.parentSessionID === identity.parentSessionID, "plan parent changed");
        rows.push(row);
      }
    }
    requireFact(number(bag(JSON.parse(lines.at(-1)!)).at) >= at, `end seal clock moved backwards in ${stream}`);
  }
  requireFact(rows.length > 0, `missing scheduler observations for ${identity.planId}`);
  const stream = rows[0]!.stream;
  requireFact(rows.every(row => row.stream === stream), "plan spans multiple streams; cannot prove a continuous episode");

  const steps = new Map<number, Step>();
  const pending = new Map<string, Step>();
  const successfulLaunches = new Set<number>();
  for (const row of rows) {
    if (!["launch-prepare", "launch", "launch-step-end"].includes(row.action)) continue;
    const detail = bag(bag(row.state).detail);
    const taskId = text(detail.taskId);
    const attempt = number(detail.attempt);
    if (row.action === "launch-prepare") {
      requireFact(!pending.has(taskId), `duplicate open launch step for ${taskId}`);
      const step: Step = { taskId, attempt };
      pending.set(taskId, step);
      steps.set(row.seq, step); // A skipped slot reservation may reuse the same attempt number.
    } else {
      const step = pending.get(taskId);
      requireFact(step && step.attempt === attempt, `launch step missing open for ${taskId}#${attempt}`);
      if (row.action === "launch") {
        requireFact(step.launch === undefined, `duplicate launch for ${taskId}#${attempt}`);
        step.launch = row.seq;
      } else {
        requireFact(detail.result === "launched" || detail.result === "skipped", "unknown launch step result");
        step.result = detail.result;
        if (step.result === "launched") {
          requireFact(step.launch !== undefined, `successful step missing launch for ${taskId}`);
          successfulLaunches.add(step.launch);
        }
        pending.delete(taskId);
      }
    }
  }
  requireFact(pending.size === 0, "launch step missing close");

  let ledger: Graph | undefined;
  let graphAttached = false;
  let attached = false;
  let detached = false;
  let idle: boolean | undefined;
  let stopped = false;
  let lastTime = -Infinity;
  let finalSeen = false;
  let maxParallel: number | undefined;
  let pool: Pool | undefined;
  const routes = new Map<string, Route>();
  const providers = new Map<string, Provider>();
  const tokens = new Map<string, Token>();
  const provider = (id: string): Provider => {
    requireFact(maxParallel !== undefined, "missing capacity-init");
    let p = providers.get(id);
    if (!p) { p = { limit: maxParallel, paused: false, queried: new Set() }; providers.set(id, p); }
    return p;
  };
  const free = (route: Route, launchedOnly: boolean): number => {
    const p = provider(route.provider);
    if (p.paused) return 0;
    const held = [...tokens.values()].filter(t => t.provider === route.provider && (!launchedOnly || t.launched));
    const normal = Math.max(0, p.limit - held.length);
    return route.heavy ? Math.min(normal, Math.max(0, Math.min(HEAVY_PROVIDER_CAP, p.limit) - held.filter(t => t.heavy).length)) : normal;
  };
  const eligible = (taskId: string): boolean => {
    const route = routes.get(taskId);
    return route !== undefined && provider(route.provider).queried.has(route.heavy) && free(route, true) > 0;
  };
  const preparing = new Map<string, { step: Step; admitted: boolean }>();
  const episodes: IdleEpisode[] = [];
  let open: { fromMs: number; fromSeq: number; ids: Set<string>; slotDiagnostics: SlotDiagnostic[];
    slot: Pick<SlotDiagnostic, "fromMs" | "fromSeq" | "status" | "reason" | "poolSeq"> } | undefined;
  const readyTasks = (seq: number): string[] => {
    if (!ledger) return [];
    const current = ledger;
    return current.tasks.filter(task => {
      const prep = preparing.get(task.id);
      const provisional = prep?.admitted && (task.state === "dispatched" || task.state === "failed")
        && !(prep.step.result === "launched" && prep.step.launch !== undefined && prep.step.launch <= seq);
      if (task.state !== "ready" && !provisional) return false;
      if (task.kind === "manual" || task.kind === "preflight") return false;
      const phase = current.phases.find(p => p.id === task.phase);
      if (task.phase !== null && (!phase || phase.paused)) return false;
      if (task.kind === "qa" && (!phase || (phase.gate !== "awaiting-qa" && !(provisional && phase.gate === "qa-running")))) return false;
      return current.edges.filter(e => e.to === task.id).every(e => e.from.startsWith("gate:")
        ? current.phases.some(p => p.id === e.from.slice(5) && p.gate === "passed")
        : current.tasks.some(t => t.id === e.from && (t.state === "integrated" || t.state === "done")));
    }).map(t => t.id);
  };
  const closeSlot = (row: SchedulerRow, time: number): void => {
    if (open && time > open.slot.fromMs) open.slotDiagnostics.push({ ...open.slot, toMs: time, toSeq: row.seq, ms: time - open.slot.fromMs });
  };
  const close = (row: SchedulerRow, time: number, reason: string): void => {
    if (!open) return;
    closeSlot(row, time);
    episodes.push({ fromMs: open.fromMs, toMs: time, ms: time - open.fromMs, fromSeq: open.fromSeq,
      toSeq: row.seq, readyTaskIds: [...open.ids], endedBy: reason, slotDiagnostics: open.slotDiagnostics });
    open = undefined;
  };
  for (const row of rows) {
    const state = bag(row.state);
    const isGraph = row.action === "attach" || row.action === "ledger";
    const isRaw = RAW_ACTIONS.has(row.action), isSlot = SLOT_ACTIONS.has(row.action);
    requireFact(isGraph || isRaw || isSlot || RUNTIME_ACTIONS.has(row.action), `unknown scheduler action ${row.action}`);
    const time = isGraph || isRaw ? row.at : number(state.clockMs);
    requireFact(time >= lastTime, `scheduler clock moved backwards at ${row.seq}`);
    lastTime = time;
    if (isSlot) pool = poolSnapshot(row);
    else if (isRaw) {
      if (row.action === "capacity-init") {
        requireFact(maxParallel === undefined, "duplicate capacity-init");
        maxParallel = number(state.maxParallel);
        requireFact(Number.isInteger(maxParallel) && maxParallel > 0, "invalid provider capacity");
        for (const value of list(state.providers)) {
          const p = bag(value);
          providers.set(text(p.provider), { limit: number(p.limit), paused: p.pausedUntilMs !== null, queried: new Set() });
        }
      } else if (row.action === "provider") {
        const p = provider(text(state.provider));
        const change = text(state.change);
        requireFact(["increase", "decrease", "pause", "resume", "retry-stop"].includes(change), "unknown provider transition");
        p.limit = number(state.to);
        if (change === "pause") p.paused = true;
        else if (change === "resume") p.paused = false;
      }
      // lease-acquire/release do not change provider or physical-slot capacity.
    } else if (isGraph) {
      const next = graph(state);
      if (row.action === "attach") {
        requireFact(!graphAttached, "unexpected graph reattach");
        graphAttached = true;
      }
      requireFact(!ledger || next.ledgerSeq >= ledger.ledgerSeq, "committed ledger sequence moved backwards");
      ledger = next;
      if (ledger.ledgerSeq >= identity.finalLedgerSeq && ledger.status === "completed") finalSeen = true;
    } else {
      requireFact(ledger && state.ledgerSeq === ledger.ledgerSeq, `missing committed graph at ${row.seq}`);
      const nextIdle = boolean(state.orchIdle);
      if (row.action === "runtime-attach") {
        requireFact(graphAttached && !attached && !nextIdle && !boolean(state.disposed), "missing fresh runtime open (or unexpected reattach)");
        attached = true;
        idle = nextIdle;
      } else {
        requireFact(attached, "runtime event missing attachment");
        if (row.action === "orchestrator") {
          const event = text(bag(state.detail).event);
          const expected = event === "step.started" ? false
            : ["execution.completed", "execution.failed", "execution.interrupted"].includes(event) ? true : idle;
          requireFact(nextIdle === expected, "orchestrator transition does not match idle state");
        } else requireFact(nextIdle === idle, "missing orchestrator open/close transition");
        idle = nextIdle;
      }
      if (row.action === "launch-prepare") {
        const step = steps.get(row.seq)!;
        preparing.set(step.taskId, { step, admitted: readyTasks(row.seq).includes(step.taskId) });
      } else if (row.action === "launch-step-end") preparing.delete(text(bag(state.detail).taskId));
      if (row.action === "route") {
        const d = bag(state.detail);
        routes.set(text(d.taskId), { provider: text(d.provider), heavy: boolean(d.heavy) });
      } else if (row.action === "route-unavailable") routes.delete(text(bag(state.detail).taskId));
      else if (row.action === "capacity-free") {
        const d = bag(state.detail), route = { provider: text(d.provider), heavy: boolean(d.heavy) };
        // UNROUTABLE also has free=0 observations, but has no real route. Never treat it as a provider.
        if ([...routes.values()].some(r => r.provider === route.provider)) {
          requireFact(number(d.free) === free(route, false), "provider free query disagrees with observed capacity/tokens");
          provider(route.provider).queried.add(route.heavy);
        }
      } else if (row.action === "capacity-reserve") {
        const d = bag(state.detail), token = text(d.token);
        requireFact(!tokens.has(token), "duplicate capacity reservation");
        tokens.set(token, { provider: text(d.provider), heavy: boolean(d.heavy), taskId: text(d.taskId),
          attempt: number(d.attempt), launched: boolean(d.force) });
      } else if (row.action === "capacity-release") {
        const d = bag(state.detail), token = text(d.token), held = tokens.get(token);
        requireFact(held && held.taskId === d.taskId && held.attempt === d.attempt, "capacity release missing reservation");
        tokens.delete(token);
      }
      if (successfulLaunches.has(row.seq)) {
        const d = bag(state.detail);
        const token = [...tokens.values()].find(t => t.taskId === d.taskId && t.attempt === d.attempt);
        requireFact(token && !token.launched, "launch missing capacity reservation");
        token.launched = true;
      }
      if (["abort", "dispose", "detach"].includes(row.action)) stopped = true;
      if (row.action === "detach") detached = true;
    }
    if (!attached) continue;
    const durable = readyTasks(row.seq);
    const ready = durable.filter(eligible);
    const reason = stopped ? "plan-stop" : ledger?.status !== "running" ? `plan-${ledger?.status}`
      : !idle ? "orchestrator-step" : durable.length === 0 ? "ready-empty" : ready.length === 0 ? "provider-unavailable-or-unknown" : undefined;
    if (successfulLaunches.has(row.seq)) close(row, time, "launch");
    if (reason !== undefined) close(row, time, reason);
    else {
      const slot = { ...slotCondition(pool, ready), fromMs: time, fromSeq: row.seq };
      open ??= { fromMs: time, fromSeq: row.seq, ids: new Set(), slotDiagnostics: [], slot };
      if (open.slot.status !== slot.status || open.slot.reason !== slot.reason) {
        closeSlot(row, time);
        open.slot = slot;
      }
      ready.forEach(id => open!.ids.add(id));
    }
  }
  requireFact(attached && detached, "runtime missing open/close");
  requireFact(maxParallel !== undefined, "missing capacity-init");
  requireFact(!open, "idle episode missing close");
  requireFact(finalSeen && ledger?.status === "completed", "missing completed plan snapshot");
  requireFact(ledger?.ledgerSeq === identity.finalLedgerSeq, "ledger advanced after fragment inventory; missing ledger tail");
  return { predicate: "A: provider-capacity", stream, episodes, streams: streams.size, records };
}

/** Coverage is one-way: metrics may omit gaps, but EVERY fragment (even free=0) must be contained in
 * one independently reconstructed episode. A fragment crossing a launch/step boundary is inconsistent
 * evidence, not permission to merge episodes or widen the 10,000 ms ceiling.
 */
export function assertG8IdleEpisodes(episodes: readonly IdleEpisode[], fragments: readonly IdleFragment[]): void {
  for (const fragment of fragments) {
    const from = Date.parse(fragment.fromAt), to = Date.parse(fragment.toAt);
    requireFact(Number.isFinite(from) && Number.isFinite(to) && to >= from && to - from === fragment.ms
      && fragment.readyTaskIds.length > 0, "invalid ledger idle fragment");
    requireFact(episodes.some(e => e.fromMs <= from && e.toMs >= to), `ledger idle fragment outside reconstructed episodes: ${fragment.fromAt}..${fragment.toAt}`);
  }
  for (const episode of episodes) {
    requireFact(Number.isFinite(episode.ms) && episode.ms >= 0 && episode.ms === episode.toMs - episode.fromMs, "invalid idle episode");
    requireFact(episode.ms <= G8_IDLE_CEILING_MS, `idle-with-ready episode ${episode.ms} ms exceeds 10,000 ms (${episode.fromSeq}..${episode.toSeq})`);
  }
}
