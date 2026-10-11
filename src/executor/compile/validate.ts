import {
  LAUNCH_HEADER_PATTERN,
  RESERVED_TASK_IDS,
  isTaskId,
  ledgerViolations,
  type Edge,
  type LedgerV1,
  type TaskId,
  type TaskKind,
  type TaskNode,
} from "../types";
import { Reach, minimalCycle } from "./edges";
import { overlaps } from "./footprint";

// Ledger validation (memo 2.3.1 section 7). Pure; returns errors only, warnings stay in `summary.warnings`.

export interface ValidationError { code: string; message: string; taskIds: TaskId[] }

export interface ValidateOptions {
  /** Case-insensitive path comparison; defaults to the platform default (win32). */
  ci?: boolean;
}

export const VALIDATION_CODES: readonly string[] = [
  "ledger:*",
  "cycle",
  "id-unknown",
  "id-duplicate",
  "id-invalid",
  "id-reserved",
  "path-outside",
  "closure",
  "qa-multiple",
  "shared-context-header",
];

const LAUNCHABLE_KINDS: ReadonlySet<TaskKind> = new Set<TaskKind>(["task", "tests", "fix", "qa"]);
const SETTLED_STATES: ReadonlySet<string> = new Set(["done", "cancelled", "integrated"]);
const DEAD_STATES: ReadonlySet<string> = new Set(["done", "cancelled"]);
const GATE_PREFIX = "gate:";

function gateOf(phase: string): string {
  return `${GATE_PREFIX}${phase}`;
}

/** A task that edits files: only these can be the top element (writes everything) when their footprint is unknown. */
export function isEditingNode(t: TaskNode): boolean {
  return t.kind === "task" || t.kind === "tests" || t.kind === "fix";
}

/** True when `t` writes everything (D4): an editing task whose write set is still unknown. */
export function isTopNode(t: TaskNode): boolean {
  return t.footprint.confidence === "unknown" && isEditingNode(t);
}

/** Stricter than the ledger's `isRepoPath`: '/'-separated, no '.'/'..'/empty/':' segment, no NUL, not rooted. */
export function isStrictRepoPath(p: string): boolean {
  if (p.length === 0 || p.includes("\\") || p.includes("\0") || p.startsWith("/")) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== ".." && !seg.includes(":"));
}

function ancestorsOf(key: string): string[] {
  const out: string[] = [];
  let i = key.lastIndexOf("/");
  while (i > 0) {
    out.push(key.slice(0, i));
    i = key.lastIndexOf("/", i - 1);
  }
  return out;
}

function defaultCi(): boolean {
  return process.platform === "win32";
}

function taskIdsAt(at: string, ids: readonly string[], edges: readonly Edge[]): TaskId[] {
  const em = /^\$\.edges\[(\d+)\]/.exec(at);
  if (em !== null) {
    const e = edges[Number(em[1])];
    if (e === undefined) return [];
    return e.from.startsWith(GATE_PREFIX) ? [e.to] : [e.from, e.to];
  }
  if (!at.startsWith("$.tasks")) return [];
  const rest = at.slice("$.tasks".length);
  let best: string | null = null;
  for (const id of ids) {
    const dot = `.${id}`;
    const br = `["${id}"]`;
    const hit = rest.startsWith(br) || (rest.startsWith(dot) && (rest.length === dot.length || /[.[]/.test(rest.charAt(dot.length))));
    if (hit && (best === null || id.length > best.length)) best = id;
  }
  return best === null ? [] : [best];
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export function validateLedger(l: LedgerV1, o: ValidateOptions = {}): ValidationError[] {
  const ci = o.ci ?? defaultCi();
  const errors: ValidationError[] = [];
  const tasks = Object.values(l.tasks) as TaskNode[];
  const ids = Object.keys(l.tasks);
  const idSet = new Set(ids);
  const phaseIds = l.phases.map((p) => p.id);
  const phaseSet = new Set(phaseIds);

  // id-invalid / id-reserved / id-duplicate
  const folded = new Map<string, string>();
  for (const id of ids) {
    if (!isTaskId(id)) errors.push({ code: "id-invalid", message: `task id ${JSON.stringify(id)} is not a valid task id`, taskIds: [id] });
    else if (RESERVED_TASK_IDS.has(id)) errors.push({ code: "id-reserved", message: `task id ${id} is reserved`, taskIds: [id] });
    const key = id.toLowerCase();
    const first = folded.get(key);
    if (first === undefined) folded.set(key, id);
    else errors.push({ code: "id-duplicate", message: `task ids ${first} and ${id} are equal after case folding`, taskIds: [first, id] });
  }

  // id-unknown (pre-empts the ledger's edge-endpoint violation)
  const badEdge = new Set<number>();
  const validEdges: Edge[] = [];
  l.edges.forEach((e, i) => {
    const fromOk = e.from.startsWith(GATE_PREFIX) ? phaseSet.has(e.from.slice(GATE_PREFIX.length)) : idSet.has(e.from);
    const toOk = idSet.has(e.to);
    if (fromOk && toOk) {
      validEdges.push(e);
      return;
    }
    badEdge.add(i);
    const unknown = [fromOk ? null : e.from, toOk ? null : e.to].filter((x): x is string => x !== null);
    errors.push({
      code: "id-unknown",
      message: `edge ${e.from} -> ${e.to} names unknown ${unknown.join(", ")}`,
      taskIds: [e.from, e.to].filter((x) => idSet.has(x)),
    });
  });

  // ledger:<c>
  for (const v of ledgerViolations(l)) {
    if (v.code === "edge-endpoint") {
      const m = /^\$\.edges\[(\d+)\]/.exec(v.at);
      if (m !== null && badEdge.has(Number(m[1]))) continue;
    }
    errors.push({ code: `ledger:${v.code}`, message: `${v.code} at ${v.at}`, taskIds: taskIdsAt(v.at, ids, l.edges) });
  }

  // path-outside
  for (const t of tasks) {
    for (const [access, list] of [["write", t.footprint.writes], ["read", t.footprint.reads]] as const) {
      for (const p of list) {
        if (!isStrictRepoPath(p)) {
          errors.push({ code: "path-outside", message: `${t.id} ${access} path ${JSON.stringify(p)} is not a repo-relative '/' path`, taskIds: [t.id] });
        }
      }
    }
  }

  // cycle: tasks and gates, plus the implicit t -> gate:phase(t)
  const nodes = [...ids, ...phaseIds.map(gateOf)];
  const graphEdges: Array<Pick<Edge, "from" | "to">> = validEdges.map((e) => ({ from: e.from, to: e.to }));
  for (const t of tasks) if (t.phase !== null && phaseSet.has(t.phase)) graphEdges.push({ from: t.id, to: gateOf(t.phase) });
  const cycle = minimalCycle(nodes, graphEdges);
  if (cycle !== null) {
    errors.push({ code: "cycle", message: `dependency cycle: ${[...cycle, cycle[0] ?? ""].join(" -> ")}`, taskIds: cycle });
  }

  // qa-multiple
  const qaByPhase = new Map<string, string[]>();
  for (const t of tasks) {
    if (t.kind !== "qa" || t.phase === null || DEAD_STATES.has(t.state)) continue;
    const list = qaByPhase.get(t.phase);
    if (list === undefined) qaByPhase.set(t.phase, [t.id]);
    else list.push(t.id);
  }
  for (const [phase, list] of qaByPhase) {
    if (list.length > 1) errors.push({ code: "qa-multiple", message: `phase ${phase} has ${list.length} live qa tasks: ${list.join(", ")}`, taskIds: list });
  }

  // shared-context-header
  const headerRe = new RegExp(LAUNCH_HEADER_PATTERN.source, LAUNCH_HEADER_PATTERN.flags.replace(/[gy]/g, ""));
  const alreadyReported = errors.some((e) => e.code === "ledger:shared-context-header");
  if (!alreadyReported && l.sharedContext.split(/\r\n|\n|\r/).some((line) => headerRe.test(line))) {
    errors.push({ code: "shared-context-header", message: "sharedContext contains a line shaped like a launch header", taskIds: [] });
  }

  errors.push(...closureErrors(l, tasks, validEdges, ci));
  return errors;
}

interface ClosureTask {
  node: TaskNode;
  top: boolean;
  writes: readonly string[];
  reads: readonly string[];
}

function closureErrors(l: LedgerV1, all: readonly TaskNode[], edges: readonly Edge[], ci: boolean): ValidationError[] {
  const live: ClosureTask[] = [];
  for (const t of all) {
    if (!LAUNCHABLE_KINDS.has(t.kind) || SETTLED_STATES.has(t.state)) continue;
    const strict = (p: string): boolean => isStrictRepoPath(p);
    // QA-2.3-1: a write path that is not a strict repo path cannot be compared, so the task writes ⊤ (the path itself is
    // reported as `path-outside`); it is never dropped silently.
    live.push({
      node: t,
      top: isTopNode(t) || !t.footprint.writes.every(strict),
      writes: t.footprint.writes.filter(strict),
      reads: t.kind === "qa" ? [] : t.footprint.reads.filter(strict),
    });
  }
  if (live.length < 2) return [];

  const reach = new Reach(
    all.map((t) => t.id),
    (id) => l.tasks[id]?.phase ?? null,
    l.phases.map((p) => p.id),
  );
  for (const e of edges) reach.add(e.from, e.to);

  const key = (p: string): string => (ci ? p.toLowerCase() : p);
  // exact: path -> tasks having it; below: ancestor dir -> tasks having a path strictly beneath it
  const exact = new Map<string, Set<number>>();
  const below = new Map<string, Set<number>>();
  const put = (m: Map<string, Set<number>>, k: string, i: number): void => {
    const s = m.get(k);
    if (s === undefined) m.set(k, new Set([i]));
    else s.add(i);
  };
  const tops: number[] = [];
  const nonEmpty: number[] = [];
  live.forEach((t, i) => {
    if (t.top) tops.push(i);
    if (t.top || t.writes.length > 0 || t.reads.length > 0) nonEmpty.push(i);
    for (const p of [...t.writes, ...t.reads]) {
      const k = key(p);
      put(exact, k, i);
      for (const a of ancestorsOf(k)) put(below, a, i);
    }
  });

  const conflicts = (u: ClosureTask, v: ClosureTask): string | null => {
    const hasAny = (t: ClosureTask): boolean => t.top || t.writes.length > 0 || t.reads.length > 0;
    if (u.top && hasAny(v)) return "unknown write set (top) overlaps everything";
    if (v.top && hasAny(u)) return "unknown write set (top) overlaps everything";
    for (const w of u.writes) {
      for (const x of v.writes) if (overlaps(w, x, ci)) return `write/write ${w}`;
      for (const x of v.reads) if (overlaps(w, x, ci)) return `write/read ${w}`;
    }
    for (const w of v.writes) for (const x of u.reads) if (overlaps(w, x, ci)) return `read/write ${w}`;
    return null;
  };

  const out: ValidationError[] = [];
  const seen = new Set<string>();
  const consider = (i: number, j: number): void => {
    if (i === j) return;
    const pk = pairKey(i, j);
    if (seen.has(pk)) return;
    seen.add(pk);
    const u = live[i] as ClosureTask;
    const v = live[j] as ClosureTask;
    if (!reach.concurrent(u.node.id, v.node.id)) return;
    const why = conflicts(u, v);
    if (why === null) return;
    out.push({
      code: "closure",
      message: `${u.node.id} and ${v.node.id} have no path between them and conflict: ${why}`,
      taskIds: [u.node.id, v.node.id],
    });
  };

  live.forEach((t, i) => {
    if (t.top) {
      for (const j of nonEmpty) consider(i, j);
      return;
    }
    for (const j of tops) consider(i, j);
    for (const w of t.writes) {
      const k = key(w);
      for (const j of exact.get(k) ?? []) consider(i, j);
      for (const j of below.get(k) ?? []) consider(i, j);
      for (const a of ancestorsOf(k)) for (const j of exact.get(a) ?? []) consider(i, j);
    }
  });
  return out;
}
