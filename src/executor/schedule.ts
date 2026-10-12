/**
 * Critical-path scheduler (3.1.2). Pure and deterministic; imports `./types` only (memo M1).
 *
 * - M9  bottomLevels: bl(t) = p50(t) + max bl(succ(t)), where succ(t) also holds the qa tasks of t's phase
 *       (they wait for its gate) and the targets of the `gate:<phase>` edges of t's phase.
 * - M10 planOrder: the index in Object.keys(ledger.tasks).
 * - M11 readySet: candidates sorted by bottom level desc then plan order, selected greedily with the soft write
 *       check, the in-selection overlap check and per-provider capacity counters.
 * - M12 promotable / manualReady.
 * - M13 addLearnedEdge: null when the edge exists or would close a cycle.
 */
import type {
  CapacityView, Edge, GateRef, LeaseView, LedgerV1, PhaseId, PhaseRecord, ScheduledTask, Scheduler, TaskId, TaskNode,
} from "./types";

const GATE_PREFIX = "gate:";

function isGateRef(from: TaskId | GateRef): from is GateRef {
  return from.startsWith(GATE_PREFIX);
}

function ownTask(ledger: Readonly<LedgerV1>, id: string): TaskNode | undefined {
  return Object.hasOwn(ledger.tasks, id) ? ledger.tasks[id] : undefined;
}

/** p50 in milliseconds; 0 for a cancelled task and for a non-finite or negative estimate. */
export function taskDurationMs(task: TaskNode): number {
  if (task.state === "cancelled") return 0;
  const p50 = task.estimate.p50;
  return Number.isFinite(p50) && p50 > 0 ? p50 : 0;
}

/**
 * Successor lists of every task (M9): (a) task edges of any kind, (b) for a non-qa task, the qa tasks of its phase,
 * (c) the targets of its phase's gate edges. Unknown ids and self loops are dropped; each list is deduplicated in
 * first-seen order.
 */
function successors(ledger: Readonly<LedgerV1>): Map<TaskId, TaskId[]> {
  const tasks = Object.entries(ledger.tasks);
  const qaByPhase = new Map<PhaseId, TaskId[]>();
  const gateTargets = new Map<PhaseId, TaskId[]>();
  const succ = new Map<TaskId, TaskId[]>();
  for (const [id, t] of tasks) {
    succ.set(id, []);
    if (t.kind === "qa" && t.phase !== null) qaByPhase.set(t.phase, [...(qaByPhase.get(t.phase) ?? []), id]);
  }
  for (const e of ledger.edges) {
    if (ownTask(ledger, e.to) === undefined) continue;
    if (isGateRef(e.from)) {
      const phase = e.from.slice(GATE_PREFIX.length);
      gateTargets.set(phase, [...(gateTargets.get(phase) ?? []), e.to]);
    } else {
      succ.get(e.from)?.push(e.to);
    }
  }
  for (const [id, t] of tasks) {
    const list = succ.get(id) as TaskId[];
    if (t.phase !== null) {
      if (t.kind !== "qa") list.push(...(qaByPhase.get(t.phase) ?? []));
      list.push(...(gateTargets.get(t.phase) ?? []));
    }
    succ.set(id, [...new Set(list)].filter((s) => s !== id));
  }
  return succ;
}

/**
 * Bottom level of every task (M9), static over the whole DAG. Iterative post-order DFS, so a long chain cannot
 * overflow the stack; a back edge (never present in a valid ledger) contributes 0 instead of looping.
 */
export function bottomLevels(ledger: Readonly<LedgerV1>): ReadonlyMap<TaskId, number> {
  const succ = successors(ledger);
  const bl = new Map<TaskId, number>();
  const onStack = new Set<TaskId>();
  for (const root of succ.keys()) {
    if (bl.has(root)) continue;
    const stack: Array<{ id: TaskId; next: number }> = [{ id: root, next: 0 }];
    onStack.add(root);
    while (stack.length > 0) {
      const top = stack[stack.length - 1] as { id: TaskId; next: number };
      const list = succ.get(top.id) as TaskId[];
      if (top.next < list.length) {
        const s = list[top.next] as TaskId;
        top.next += 1;
        if (!bl.has(s) && !onStack.has(s)) {
          onStack.add(s);
          stack.push({ id: s, next: 0 });
        }
        continue;
      }
      let tail = 0;
      for (const s of list) tail = Math.max(tail, bl.get(s) ?? 0);
      bl.set(top.id, taskDurationMs(ledger.tasks[top.id] as TaskNode) + tail);
      onStack.delete(top.id);
      stack.pop();
    }
  }
  return bl;
}

/** Plan order (M10): the index in Object.keys(ledger.tasks). */
export function planOrder(ledger: Readonly<LedgerV1>): ReadonlyMap<TaskId, number> {
  return new Map(Object.keys(ledger.tasks).map((id, i) => [id, i]));
}

/** A task source is satisfied when integrated or done; a `gate:<phase>` source when that gate has passed. */
export function edgeSatisfied(ledger: Readonly<LedgerV1>, edge: Edge): boolean {
  if (isGateRef(edge.from)) {
    const phase = edge.from.slice(GATE_PREFIX.length);
    return ledger.phases.some((p) => p.id === phase && p.gate === "passed");
  }
  const src = ownTask(ledger, edge.from);
  return src !== undefined && (src.state === "integrated" || src.state === "done");
}

function asciiFold(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/**
 * Conservative path overlap (M11): equal, or one is a '/'-segment prefix of the other, after ASCII case folding.
 * An empty path stands for the whole repository and overlaps everything.
 */
export function pathsOverlap(a: string, b: string): boolean {
  const x = asciiFold(a);
  const y = asciiFold(b);
  if (x === "" || y === "" || x === y) return true;
  return x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

function incomingEdges(ledger: Readonly<LedgerV1>): Map<TaskId, Edge[]> {
  const m = new Map<TaskId, Edge[]>();
  for (const e of ledger.edges) m.set(e.to, [...(m.get(e.to) ?? []), e]);
  return m;
}

function depsSatisfied(ledger: Readonly<LedgerV1>, incoming: Map<TaskId, Edge[]>, id: TaskId): boolean {
  return (incoming.get(id) ?? []).every((e) => edgeSatisfied(ledger, e));
}

/**
 * Phase conditions of a candidate (M11): its phase is null, or known and not paused; R16/QA7: a qa task only while
 * its phase gate is `awaiting-qa` (so never a qa task without a phase).
 */
function phaseAdmits(phases: ReadonlyMap<PhaseId, PhaseRecord>, task: TaskNode): boolean {
  if (task.phase === null) return task.kind !== "qa";
  const p = phases.get(task.phase);
  if (p === undefined || p.paused) return false;
  return task.kind !== "qa" || p.gate === "awaiting-qa";
}

function readySet(
  ledger: LedgerV1, inFlight: ReadonlySet<TaskId>, leases: LeaseView, capacity: CapacityView,
): ScheduledTask[] {
  if (ledger.status !== "running") return [];
  const phases = new Map(ledger.phases.map((p) => [p.id, p]));
  const incoming = incomingEdges(ledger);
  const candidates: TaskNode[] = [];
  for (const [id, t] of Object.entries(ledger.tasks)) {
    if (t.state !== "ready" || t.kind === "manual" || t.kind === "preflight" || inFlight.has(id)) continue;
    if (phaseAdmits(phases, t) && depsSatisfied(ledger, incoming, id)) candidates.push(t);
  }
  if (candidates.length === 0) return [];
  const bl = bottomLevels(ledger);
  const order = planOrder(ledger);
  const level = (id: TaskId): number => bl.get(id) as number;
  const rank = (id: TaskId): number => order.get(id) as number;
  candidates.sort((a, b) => level(b.id) - level(a.id) || rank(a.id) - rank(b.id));

  const claimed: string[] = [];
  const counters = new Map<string, { normal: number; heavy: number }>();
  const out: ScheduledTask[] = [];
  for (const t of candidates) {
    const writes = t.footprint.writes;
    const heldByOther = writes.some((w) => {
      const h = leases.holder(w);
      return h !== null && !(h.planId === ledger.planId && h.taskId === t.id);
    });
    if (heldByOther || writes.some((w) => claimed.some((c) => pathsOverlap(w, c)))) continue;
    const route = capacity.routeOf(t);
    let c = counters.get(route.provider);
    if (c === undefined) {
      c = { normal: capacity.free(route.provider, false), heavy: capacity.free(route.provider, true) };
      counters.set(route.provider, c);
    }
    if (c.normal <= 0 || (route.heavy && c.heavy <= 0)) continue;
    c.normal -= 1;
    if (route.heavy) c.heavy -= 1;
    claimed.push(...writes);
    out.push({ taskId: t.id, route, bottomLevelMs: level(t.id) });
  }
  return out;
}

function promotable(ledger: LedgerV1): { toReady: TaskId[]; unblock: TaskId[] } {
  const incoming = incomingEdges(ledger);
  const toReady: TaskId[] = [];
  const unblock: TaskId[] = [];
  for (const [id, t] of Object.entries(ledger.tasks)) {
    if (t.state !== "pending" && t.state !== "blocked") continue;
    if (!depsSatisfied(ledger, incoming, id)) continue;
    (t.state === "pending" ? toReady : unblock).push(id);
  }
  return { toReady, unblock };
}

function manualReady(ledger: LedgerV1): TaskId[] {
  return Object.entries(ledger.tasks)
    .filter(([, t]) => t.state === "ready" && (t.kind === "manual" || t.kind === "preflight"))
    .map(([id]) => id);
}

/** True when `to` is reachable from `from` over the M9 successor relation. */
function reaches(succ: ReadonlyMap<TaskId, TaskId[]>, from: TaskId, to: TaskId): boolean {
  const seen = new Set<TaskId>([from]);
  const stack: TaskId[] = [from];
  while (stack.length > 0) {
    const id = stack.pop() as TaskId;
    if (id === to) return true;
    for (const s of succ.get(id) as TaskId[]) {
      if (!seen.has(s)) {
        seen.add(s);
        stack.push(s);
      }
    }
  }
  return false;
}

function addLearnedEdge(ledger: LedgerV1, holder: TaskId, blocked: TaskId, evidence: string): Edge | null {
  if (holder === blocked || ownTask(ledger, holder) === undefined || ownTask(ledger, blocked) === undefined) return null;
  if (ledger.edges.some((e) => e.from === holder && e.to === blocked)) return null;
  if (reaches(successors(ledger), blocked, holder)) return null;
  return { from: holder, to: blocked, kind: "learned", confidence: "high", evidence };
}

/** The critical-path scheduler (types.ts Scheduler); stateless, so one instance may serve every plan. */
export function createScheduler(): Scheduler {
  return { readySet, promotable, manualReady, addLearnedEdge };
}
