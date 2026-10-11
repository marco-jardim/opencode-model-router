import type { DurationModel } from "../../routing/outcomes/durations";
import type { RouteLine } from "../../routing/classify/types";
import type { CompileSummary, Edge, LedgerV1, TaskKind, TaskNode, TaskState, Tier } from "../types";

/** Prior for one integration until 3.2 records integration timings (memo §8). */
export const INTEGRATION_ESTIMATE_MS = 60_000;

const NOT_LAUNCHABLE_KINDS: ReadonlySet<TaskKind> = new Set<TaskKind>(["manual", "preflight"]);
const FINISHED_STATES: ReadonlySet<TaskState> = new Set<TaskState>(["done", "cancelled", "integrated"]);

export interface TaskEstimateInput {
  kind: TaskKind;
  state: TaskState;
  role: string;
  tier: Tier | null;
  route: RouteLine | null;
}

/** Per-task estimate (memo §8): manual/preflight and finished tasks cost 0, the rest come from the duration model. */
export function taskEstimate(m: DurationModel, t: TaskEstimateInput): TaskNode["estimate"] {
  if (NOT_LAUNCHABLE_KINDS.has(t.kind)) return { p50: 0, p90: 0, source: "manual" };
  if (t.state === "done") return { p50: 0, p90: 0, source: "done: merged before the run" };
  const e = m.estimate({
    role: t.role !== "" ? t.role : (t.tier ?? "unknown"),
    class: t.route?.class ?? "other",
    scope: t.route?.scope ?? "single",
  });
  const p50 = Math.max(0, e.p50);
  const p90 = Math.max(p50, e.p90);
  const source = e.p90Source === e.source ? e.source : `${e.source}/p90:${e.p90Source}`;
  return { p50, p90, source };
}

function isLaunchable(t: TaskNode): boolean {
  return !NOT_LAUNCHABLE_KINDS.has(t.kind) && !FINISHED_STATES.has(t.state);
}

/** W, CP, width and expected makespan over the ledger graph (tasks plus phase gates, memo §8). */
export function planEstimate(
  l: Pick<LedgerV1, "tasks" | "edges" | "phases">,
  maxParallel: number,
): Pick<CompileSummary, "workMs" | "criticalPathMs" | "width" | "expectedMakespanMs"> {
  const ids: string[] = [];
  const index = new Map<string, number>();
  const cost: number[] = [];
  const launchable: boolean[] = [];
  const addNode = (id: string, c: number, lau: boolean): void => {
    index.set(id, ids.length);
    ids.push(id);
    cost.push(c);
    launchable.push(lau);
  };
  for (const t of Object.values(l.tasks)) {
    const lau = isLaunchable(t);
    addNode(t.id, lau ? t.estimate.p50 : 0, lau);
  }
  for (const p of l.phases) addNode(`gate:${p.id}`, 0, false);

  const n = ids.length;
  const succ: number[][] = Array.from({ length: n }, () => []);
  const indeg: number[] = new Array<number>(n).fill(0);
  const seen = new Set<string>();
  const link = (from: string, to: string): void => {
    const a = index.get(from);
    const b = index.get(to);
    if (a === undefined || b === undefined || a === b) return;
    const key = `${a}>${b}`;
    if (seen.has(key)) return;
    seen.add(key);
    succ[a]?.push(b);
    indeg[b] = (indeg[b] ?? 0) + 1;
  };
  for (const e of l.edges as readonly Edge[]) link(e.from, e.to);
  for (const t of Object.values(l.tasks)) {
    if (t.phase !== null) link(t.id, `gate:${t.phase}`);
  }

  // Kahn order; nodes left over by a cycle keep es = 0 (validate reports cycles, the estimate stays total).
  const order: number[] = [];
  const queue: number[] = [];
  for (let i = 0; i < n; i += 1) if ((indeg[i] ?? 0) === 0) queue.push(i);
  for (let h = 0; h < queue.length; h += 1) {
    const v = queue[h] as number;
    order.push(v);
    for (const w of succ[v] ?? []) {
      indeg[w] = (indeg[w] ?? 0) - 1;
      if (indeg[w] === 0) queue.push(w);
    }
  }
  const es: number[] = new Array<number>(n).fill(0);
  for (const v of order) {
    const end = (es[v] ?? 0) + (cost[v] ?? 0);
    for (const w of succ[v] ?? []) if (end > (es[w] ?? 0)) es[w] = end;
  }
  const bl: number[] = new Array<number>(n).fill(0);
  let cp = 0;
  for (let k = order.length - 1; k >= 0; k -= 1) {
    const v = order[k] as number;
    let best = 0;
    for (const w of succ[v] ?? []) best = Math.max(best, bl[w] ?? 0);
    bl[v] = (cost[v] ?? 0) + best;
    cp = Math.max(cp, bl[v] ?? 0);
  }

  let work = 0;
  let count = 0;
  const events: Array<[number, number]> = [];
  for (let i = 0; i < n; i += 1) {
    if (launchable[i] !== true) continue;
    count += 1;
    const c = cost[i] ?? 0;
    work += c;
    if (c > 0) {
      events.push([es[i] ?? 0, 1]);
      events.push([(es[i] ?? 0) + c, -1]);
    }
  }
  events.sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]));
  let cur = 0;
  let width = 0;
  for (const [, d] of events) {
    cur += d;
    if (cur > width) width = cur;
  }
  if (count > 0 && width === 0) width = 1;

  const pEff = Math.min(Math.max(1, maxParallel), Math.max(1, width));
  const integration = INTEGRATION_ESTIMATE_MS * count;
  return {
    workMs: Math.round(work),
    criticalPathMs: Math.round(cp),
    width,
    expectedMakespanMs: Math.round(Math.max(cp, work / pEff, integration)),
  };
}

function hours(ms: number): string {
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/**
 * One-line summary (memo §8). `CompileSummary` carries no plan id or parallelism, so the caller may pass them;
 * `ctx.maxParallel` is the effective p used for the makespan.
 */
export function formatSummary(s: CompileSummary, ctx: { planId?: string; maxParallel?: number } = {}): string {
  const p = Math.min(Math.max(1, ctx.maxParallel ?? s.width), Math.max(1, s.width));
  return [
    `plan ${ctx.planId ?? "?"}: ${s.tasks} tasks`,
    `${s.phases} phases`,
    `${s.edges} edges`,
    `W ${hours(s.workMs)}`,
    `CP ${hours(s.criticalPathMs)}`,
    `width ${s.width}`,
    `≈${hours(s.expectedMakespanMs)} (p=${p})`,
    `manual ${s.manual.length}`,
    `${s.warnings.length} warnings`,
  ].join(" · ");
}
