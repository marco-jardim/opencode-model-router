import { ExecutorError, type Edge, type Footprint, type TaskKind } from "../types";
import { overlaps, touchKey, UNKNOWN_WRITES } from "./footprint";
import type { CompileIssue, ExplicitPhrase, ParsedPhase, ParsedPlan } from "./parse";

// Edge derivation (memo 2.3.1 section 5). Passes in precedence order: structural, graph, explicit, contract,
// conflict. Edges are deduplicated by `${from}>${to}`; the first pass that produces a pair wins. llm and learned
// edges are never produced here.

/** One task as the edge passes see it; `writes === UNKNOWN_WRITES` is the top element (writes everything, D4). */
export interface EdgeTask {
  id: string;
  phase: string | null;
  kind: TaskKind;
  planIndex: number;
  writes: readonly string[] | typeof UNKNOWN_WRITES;
  reads: readonly string[];
  confidence: Footprint["confidence"];
  isContract: boolean;
}

// ---------------------------------------------------------------------------------------------------------------
// Small helpers

const LAUNCHABLE: ReadonlySet<TaskKind> = new Set<TaskKind>(["task", "tests", "fix", "qa"]);
const EVIDENCE_MAX = 120;
const MERGED_RE = /\bmerge[sd]?\b/i;
const LINE_IN_EVIDENCE_RE = /\bL(\d+):/;

function at<T>(a: readonly T[], i: number): T {
  return a[i] as T;
}

function gateOf(phaseId: string): string {
  return `gate:${phaseId}`;
}

function excerpt(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > EVIDENCE_MAX ? t.slice(0, EVIDENCE_MAX) : t;
}

function evidenceOf(rule: string, line: number, text: string): string {
  return `${rule} L${line}: ${excerpt(text)}`;
}

function lineOfEvidence(evidence: string): number {
  const m = LINE_IN_EVIDENCE_RE.exec(evidence);
  return m === null ? 0 : Number(m[1]);
}

function mkEdge(from: string, to: string, kind: Edge["kind"], confidence: Edge["confidence"], evidence: string): Edge {
  return { from, to, kind, confidence, evidence };
}

function isTop(t: EdgeTask): boolean {
  return t.writes === UNKNOWN_WRITES;
}

function writesOf(t: EdgeTask): readonly string[] {
  return t.writes === UNKNOWN_WRITES ? [] : t.writes;
}

/** A QA review runs on a fixed commit, so its reads never take part in conflicts (anti false-serialization). */
function conflictReadsOf(t: EdgeTask): readonly string[] {
  return t.kind === "qa" ? [] : t.reads;
}

/** Insertion-ordered edge collection, deduplicated by `${from}>${to}`. */
class EdgeSet {
  private readonly byKey = new Map<string, Edge>();
  add(e: Edge): boolean {
    const key = `${e.from}>${e.to}`;
    if (e.from === e.to || this.byKey.has(key)) return false;
    this.byKey.set(key, e);
    return true;
  }
  has(from: string, to: string): boolean {
    return this.byKey.has(`${from}>${to}`);
  }
  get(from: string, to: string): Edge | undefined {
    return this.byKey.get(`${from}>${to}`);
  }
  list(): Edge[] {
    return [...this.byKey.values()];
  }
}

function byPlanIndex(a: EdgeTask, b: EdgeTask): number {
  return a.planIndex - b.planIndex || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function groupByPhase(tasks: readonly EdgeTask[]): Map<string, EdgeTask[]> {
  const out = new Map<string, EdgeTask[]>();
  for (const t of tasks) {
    if (t.phase === null) continue;
    const l = out.get(t.phase);
    if (l === undefined) out.set(t.phase, [t]);
    else l.push(t);
  }
  return out;
}

function isPostPhase(ph: ParsedPhase): boolean {
  return ph.synthetic && ph.id.endsWith(".post");
}

// ---------------------------------------------------------------------------------------------------------------
// Reach: bitset transitive closure over tasks and phase gates

export class Reach {
  private readonly index = new Map<string, number>();
  private readonly words: number;
  private readonly rows: Uint32Array[];
  private readonly n: number;

  /**
   * Nodes are the tasks and `gate:P` for every phase. Every task t of phase P implicitly reaches `gate:P`
   * (a gate passes only once the phase is integrated, D7).
   */
  constructor(taskIds: readonly string[], phaseOf: (id: string) => string | null, phaseIds: readonly string[]) {
    for (const id of taskIds) if (!this.index.has(id)) this.index.set(id, this.index.size);
    for (const ph of phaseIds) {
      const g = gateOf(ph);
      if (!this.index.has(g)) this.index.set(g, this.index.size);
    }
    this.n = this.index.size;
    this.words = Math.max(1, Math.ceil(this.n / 32));
    this.rows = [];
    for (let i = 0; i < this.n; i += 1) this.rows.push(new Uint32Array(this.words));
    for (const id of taskIds) {
      const ph = phaseOf(id);
      if (ph === null) continue;
      const g = this.index.get(gateOf(ph));
      if (g === undefined) continue;
      this.setBit(this.row(this.slot(id)), g);
    }
  }

  private slot(id: string): number {
    const i = this.index.get(id);
    if (i === undefined) throw new ExecutorError("E_INVALID_INPUT", `unknown node ${id}`, { id });
    return i;
  }

  private row(i: number): Uint32Array {
    return at(this.rows, i);
  }

  private setBit(row: Uint32Array, bit: number): void {
    const w = bit >>> 5;
    row[w] = (row[w] as number) | (1 << (bit & 31));
  }

  private getBit(row: Uint32Array, bit: number): boolean {
    return (((row[bit >>> 5] as number) >>> (bit & 31)) & 1) === 1;
  }

  /** Adds the edge and closes the relation transitively; O(n * n/32) worst case. */
  add(from: string, to: string): void {
    const f = this.slot(from);
    const t = this.slot(to);
    if (f === t || this.getBit(this.row(f), t)) return;
    const below = new Uint32Array(this.row(t));
    this.setBit(below, t);
    for (let x = 0; x < this.n; x += 1) {
      const row = this.row(x);
      if (x !== f && !this.getBit(row, f)) continue;
      for (let w = 0; w < this.words; w += 1) row[w] = (row[w] as number) | (below[w] as number);
    }
  }

  /** True when a path from `a` to `b` of length >= 1 exists. */
  reaches(a: string, b: string): boolean {
    return this.getBit(this.row(this.slot(a)), this.slot(b));
  }

  concurrent(a: string, b: string): boolean {
    if (a === b) return false;
    return !this.reaches(a, b) && !this.reaches(b, a);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Structural pass

interface IntraCore {
  edges: Edge[];
  warnings: CompileIssue[];
  /** Per phase: its preflight items, else its tasks with no in-phase predecessor. */
  sources: Map<string, string[]>;
}

/** Edges between consecutive non-empty stages; `pre` feeds the first one. */
function stageEdges(pre: readonly EdgeTask[], stages: ReadonlyArray<readonly EdgeTask[]>, push: (a: string, b: string) => void): void {
  let prev: readonly EdgeTask[] = pre;
  for (const s of stages) {
    if (s.length === 0) continue;
    for (const a of prev) for (const b of s) push(a.id, b.id);
    prev = s;
  }
}

function intraCore(p: ParsedPlan, tasks: readonly EdgeTask[]): IntraCore {
  const byPhase = groupByPhase(tasks);
  const known = new Set(tasks.map((t) => t.id));
  const edges: Edge[] = [];
  const warnings: CompileIssue[] = [];
  const seen = new Set<string>();
  const pusher = (evidence: string) => (from: string, to: string): void => {
    const key = `${from}>${to}`;
    if (from === to || seen.has(key)) return;
    seen.add(key);
    edges.push(mkEdge(from, to, "structural", "high", evidence));
  };

  for (const ph of p.phases) {
    if (isPostPhase(ph)) continue;
    const mine = byPhase.get(ph.id) ?? [];
    const pre = mine.filter((t) => t.kind === "preflight");
    const qa = mine.filter((t) => t.kind === "qa");
    const rest = mine.filter((t) => t.kind !== "preflight" && t.kind !== "qa");
    const order = ph.order;
    if (order === null) {
      const work = rest.filter((t) => t.kind !== "tests");
      const tests = rest.filter((t) => t.kind === "tests");
      stageEdges(pre, [work, tests, qa], pusher(evidenceOf("stage", ph.span.line, `${ph.id}: preflight, tasks, tests, QA`)));
      continue;
    }

    const push = pusher(evidenceOf("order", order.line, order.raw));
    const succ = new Map<string, string[]>();
    const pred = new Map<string, string[]>();
    const link = (a: string, b: string): void => {
      if (a === b) return;
      const s = succ.get(a) ?? [];
      if (s.includes(b)) return;
      s.push(b);
      succ.set(a, s);
      const q = pred.get(b) ?? [];
      q.push(a);
      pred.set(b, q);
    };
    const groups = order.groups;
    for (let i = 0; i + 1 < groups.length; i += 1) {
      for (const a of at(groups, i)) for (const b of at(groups, i + 1)) link(a, b);
    }
    const listed = new Set(groups.flat());
    const first = groups.length > 0 ? at(groups, 0) : [];
    const last = groups.length > 0 ? at(groups, groups.length - 1) : [];
    for (const t of pre) if (!listed.has(t.id)) for (const b of first) link(t.id, b);
    const qaId = `${ph.id}.QA`;
    if (!listed.has(qaId) && known.has(qaId)) for (const b of last) link(b, qaId);

    // D3: items that are no task of the ledger (FIX, a missing QA) are contracted: preds(v) -> succs(v).
    const virtual: string[] = [];
    for (const id of groups.flat()) if (!known.has(id) && !virtual.includes(id)) virtual.push(id);
    for (const v of virtual) {
      const ps = [...(pred.get(v) ?? [])];
      const ss = [...(succ.get(v) ?? [])];
      for (const a of ps) for (const b of ss) link(a, b);
      for (const a of ps) succ.set(a, (succ.get(a) ?? []).filter((x) => x !== v));
      for (const b of ss) pred.set(b, (pred.get(b) ?? []).filter((x) => x !== v));
      succ.delete(v);
      pred.delete(v);
    }
    for (const [a, bs] of succ) {
      if (!known.has(a)) continue;
      for (const b of bs) if (known.has(b)) push(a, b);
    }

    const unlisted = rest.filter((t) => !listed.has(t.id));
    if (unlisted.length > 0) {
      warnings.push({
        code: "order-unlisted",
        line: order.line,
        message: `Order: of ${ph.id} omits ${unlisted.map((t) => t.id).join(", ")}; stage edges added`,
      });
      stageEdges(
        pre,
        [unlisted.filter((t) => t.kind !== "tests"), unlisted.filter((t) => t.kind === "tests"), qa],
        pusher(evidenceOf("stage", ph.span.line, `${ph.id}: tasks missing from Order:`)),
      );
    }
  }

  const phaseOfTask = new Map<string, string | null>(tasks.map((t) => [t.id, t.phase]));
  const hasIn = new Set<string>();
  for (const e of edges) {
    const pf = phaseOfTask.get(e.from);
    if (pf !== undefined && pf !== null && pf === phaseOfTask.get(e.to)) hasIn.add(e.to);
  }
  const sources = new Map<string, string[]>();
  for (const ph of p.phases) {
    const mine = byPhase.get(ph.id) ?? [];
    const pre = mine.filter((t) => t.kind === "preflight");
    const src = pre.length > 0 ? pre : mine.filter((t) => !hasIn.has(t.id));
    sources.set(ph.id, src.map((t) => t.id));
  }
  return { edges, warnings, sources };
}

/** Warnings of the structural pass (`order-unlisted`). */
export function structuralWarnings(p: ParsedPlan, tasks: readonly EdgeTask[]): CompileIssue[] {
  return intraCore(p, [...tasks].sort(byPlanIndex)).warnings;
}

export function structuralEdges(p: ParsedPlan, tasks: readonly EdgeTask[], crossPhase: "gate" | "inferred"): Edge[] {
  const sorted = [...tasks].sort(byPlanIndex);
  const core = intraCore(p, sorted);
  const out = new EdgeSet();
  for (const e of core.edges) out.add(e);

  const phaseById = new Map(p.phases.map((ph) => [ph.id, ph]));
  for (const ph of p.phases) {
    for (const dep of ph.dependsOn) {
      // An external dependency (a dogfood switch) is not a phase of this plan: no gate to wait for.
      if (dep.external || dep.id === ph.id || !phaseById.has(dep.id)) continue;
      for (const s of core.sources.get(ph.id) ?? []) {
        out.add(mkEdge(gateOf(dep.id), s, "structural", "high", evidenceOf("depends-on", dep.line, `${ph.id} depends on ${dep.id}`)));
      }
    }
  }

  if (crossPhase === "gate") {
    const waves = [...p.waves].sort((a, b) => a.line - b.line);
    // A wave made only of dogfood phases has no gates: the chain goes through to the previous gated wave.
    const gated = (w: (typeof waves)[number]): boolean => w.phases.some((pid) => {
      const pph = phaseById.get(pid);
      return pph !== undefined && !pph.dogfood;
    });
    let prev: (typeof waves)[number] | undefined;
    for (const cur of waves) {
      if (prev !== undefined) {
        for (const pid of prev.phases) {
          const pph = phaseById.get(pid);
          if (pph === undefined || pph.dogfood) continue;
          for (const qid of cur.phases) {
            for (const s of core.sources.get(qid) ?? []) {
              out.add(mkEdge(gateOf(pid), s, "structural", "high", evidenceOf("wave-gate", cur.line, `wave ${prev.id} before wave ${cur.id}`)));
            }
          }
        }
      }
      if (gated(cur)) prev = cur;
    }
  }
  return out.list();
}

// ---------------------------------------------------------------------------------------------------------------
// Node resolution shared by the graph and explicit passes

interface Ref {
  kind: "task" | "phase" | "wave";
  id: string;
  /** What must be done for this node to be finished: the task itself, or the gates of its phases. */
  pred: string[];
  /** What starts this node: the task itself, or the sources of its phases. */
  succ: string[];
  phases: string[];
}

function makeResolver(p: ParsedPlan, tasks: readonly EdgeTask[], sources: ReadonlyMap<string, string[]>): (id: string) => Ref | null {
  const taskIds = new Set(tasks.map((t) => t.id));
  const phases = new Map(p.phases.map((ph) => [ph.id, ph]));
  const waves = new Map(p.waves.map((w) => [w.id, w]));
  const gatesOf = (ids: readonly string[]): string[] =>
    ids.filter((id) => {
      const ph = phases.get(id);
      return ph !== undefined && !ph.dogfood;
    }).map(gateOf);
  return (id) => {
    if (taskIds.has(id)) return { kind: "task", id, pred: [id], succ: [id], phases: [] };
    if (phases.has(id)) return { kind: "phase", id, pred: gatesOf([id]), succ: sources.get(id) ?? [], phases: [id] };
    const w = waves.get(id);
    if (w !== undefined) {
      return { kind: "wave", id, pred: gatesOf(w.phases), succ: w.phases.flatMap((x) => sources.get(x) ?? []), phases: [...w.phases] };
    }
    return null;
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Graph pass

export function graphEdges(p: ParsedPlan, tasks: readonly EdgeTask[]): { edges: Edge[]; warnings: CompileIssue[] } {
  const sorted = [...tasks].sort(byPlanIndex);
  const resolve = makeResolver(p, sorted, intraCore(p, sorted).sources);
  const out = new EdgeSet();
  const warnings: CompileIssue[] = [];
  for (const g of p.graphs) {
    for (const e of g.edges) {
      const from = resolve(e.from);
      const to = resolve(e.to);
      // A node that is not a task, phase or wave of this run (a phase outside the run, or one the parser already
      // reported as `graph-node-unknown`) drops the edge, loudly.
      if (from === null || to === null) {
        const missing = [from === null ? e.from : null, to === null ? e.to : null].filter((x): x is string => x !== null);
        for (const m of missing) {
          warnings.push({ code: "ref-outside-run", line: e.line, message: `graph edge ${e.raw.trim()} dropped: ${m} is not part of this run` });
        }
        continue;
      }
      if (from.kind === to.kind && from.id === to.id) continue;
      const evidence = evidenceOf("graph", e.line, e.raw);
      for (const a of from.pred) for (const b of to.succ) out.add(mkEdge(a, b, "graph", "high", evidence));
    }
  }
  return { edges: out.list(), warnings };
}

// ---------------------------------------------------------------------------------------------------------------
// Explicit pass

/** Does `t` touch (read or write) anything `c` writes? Returns the path that proves it. */
function touchedBy(c: EdgeTask, t: EdgeTask, ci: boolean): string | null {
  const tAll = [...writesOf(t), ...conflictReadsOf(t)];
  if (isTop(c)) return isTop(t) ? "*" : (tAll[0] ?? null);
  if (isTop(t)) return writesOf(c)[0] ?? null;
  return firstOverlap(writesOf(c), tAll, ci);
}

/** The more specific path of the first overlapping pair, or null. */
function firstOverlap(a: readonly string[], b: readonly string[], ci: boolean): string | null {
  for (const x of a) {
    for (const y of b) {
      if (overlaps(x, y, ci)) return touchKey(x, ci).length >= touchKey(y, ci).length ? x : y;
    }
  }
  return null;
}

export function explicitEdges(p: ParsedPlan, tasks: readonly EdgeTask[]): { edges: Edge[]; warnings: CompileIssue[] } {
  const sorted = [...tasks].sort(byPlanIndex);
  const resolve = makeResolver(p, sorted, intraCore(p, sorted).sources);
  const out = new EdgeSet();
  const warnings: CompileIssue[] = [];
  const waveById = new Map(p.waves.map((w) => [w.id, w]));
  const ci = false;

  const emit = (a: readonly string[], b: readonly string[], conf: Edge["confidence"], evidence: string): void => {
    for (const x of a) for (const y of b) out.add(mkEdge(x, y, "explicit", conf, evidence));
  };
  const confidenceFor = (ref: Ref, text: string): Edge["confidence"] =>
    ref.kind === "task" || MERGED_RE.test(text) ? "high" : "medium";

  const waveMergedFirst = (ph: ExplicitPhrase, subject: Ref, ref: Ref | null, evidence: string): void => {
    const wave = waveById.get(subject.id);
    const contracts = ref === null
      ? []
      : sorted.filter((t) => t.isContract && (ref.kind === "task" ? t.id === ref.id : ref.phases.includes(t.phase ?? "")));
    if (wave === undefined || contracts.length === 0) {
      warnings.push({
        code: "explicit-merged-first-unresolved",
        line: ph.line,
        message: `"merged first" names no detectable contract task (residue candidate): ${excerpt(ph.excerpt)}`,
      });
      return;
    }
    const excluded = new Set(ref === null ? [] : ref.phases);
    const targets = sorted.filter((t) => t.phase !== null && wave.phases.includes(t.phase) && !excluded.has(t.phase));
    for (const c of contracts) {
      for (const t of targets) {
        if (t.id !== c.id && touchedBy(c, t, ci) !== null) out.add(mkEdge(c.id, t.id, "explicit", "medium", evidence));
      }
    }
  };

  for (const ph of p.phrases) {
    const subject = resolve(ph.subject.id);
    if (subject === null) {
      warnings.push({ code: "explicit-ref-unknown", line: ph.line, message: `unknown subject ${ph.subject.id}: ${excerpt(ph.excerpt)}` });
      continue;
    }
    const evidence = evidenceOf(`explicit-${ph.verb}`, ph.line, ph.excerpt);
    if (ph.verb === "merged-first" && subject.kind === "wave") {
      if (ph.refs.length === 0) waveMergedFirst(ph, subject, null, evidence);
      for (const r of ph.refs) {
        const ref = resolve(r);
        if (ref === null) {
          warnings.push({ code: "explicit-ref-unknown", line: ph.line, message: `unknown reference ${r}: ${excerpt(ph.excerpt)}` });
          continue;
        }
        waveMergedFirst(ph, subject, ref, evidence);
      }
      continue;
    }
    if (ph.verb !== "after" && ph.verb !== "before" && ph.verb !== "merged-first") {
      warnings.push({ code: "explicit-verb-unknown", line: ph.line, message: `unknown phrase verb ${ph.verb}: ${excerpt(ph.excerpt)}` });
      continue;
    }
    for (const r of ph.refs) {
      const ref = resolve(r);
      if (ref === null) {
        warnings.push({ code: "explicit-ref-unknown", line: ph.line, message: `unknown reference ${r}: ${excerpt(ph.excerpt)}` });
        continue;
      }
      if (ph.verb === "before") emit(subject.pred, ref.succ, confidenceFor(ref, ph.excerpt), evidence);
      else emit(ref.pred, subject.succ, confidenceFor(ref, ph.excerpt), evidence);
    }
  }
  return { edges: out.list(), warnings };
}

// ---------------------------------------------------------------------------------------------------------------
// Contract pass

export function contractEdges(tasks: readonly EdgeTask[], reach: Reach, ci: boolean): Edge[] {
  const sorted = [...tasks].sort(byPlanIndex);
  const byPhase = groupByPhase(sorted);
  const out: Edge[] = [];
  for (const c of sorted) {
    if (!c.isContract || c.phase === null) continue;
    for (const t of byPhase.get(c.phase) ?? []) {
      if (t.id === c.id || !reach.concurrent(c.id, t.id)) continue;
      const cw = writesOf(c);
      const tAll = [...writesOf(t), ...t.reads];
      let path: string | null;
      if (isTop(c)) path = isTop(t) ? "*" : (tAll[0] ?? null);
      else if (isTop(t)) path = cw[0] ?? null;
      else path = firstOverlap(cw, tAll, ci);
      if (path === null) continue;
      out.push(mkEdge(c.id, t.id, "contract", "medium", `contract: ${c.id} writes ${path}`));
      reach.add(c.id, t.id);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Conflict pass

function ancestorKeys(key: string): string[] {
  const out: string[] = [];
  let cut = key.lastIndexOf("/");
  while (cut > 0) {
    out.push(key.slice(0, cut));
    cut = key.lastIndexOf("/", cut - 1);
  }
  if (key !== "") out.push("");
  return out;
}

/** Path index: a path is keyed under itself (`exact`) and under every ancestor directory (`below`, root included). */
class PathIndex {
  private readonly exact = new Map<string, number[]>();
  private readonly below = new Map<string, number[]>();
  constructor(private readonly ci: boolean) {}

  private push(m: Map<string, number[]>, key: string, v: number): void {
    const l = m.get(key);
    if (l === undefined) m.set(key, [v]);
    else l.push(v);
  }

  add(path: string, v: number): void {
    const key = touchKey(path, this.ci);
    this.push(this.exact, key, v);
    for (const a of ancestorKeys(key)) this.push(this.below, a, v);
  }

  /** Every registered position whose path equals `path`, is a directory above it or lies below it. */
  collect(path: string, into: Set<number>): void {
    const key = touchKey(path, this.ci);
    for (const k of [key, ...ancestorKeys(key)]) for (const v of this.exact.get(k) ?? []) into.add(v);
    for (const v of this.below.get(key) ?? []) into.add(v);
  }
}

/** First overlap of two sets, either of which may be the top element; `*` stands for "everything". */
function overlapOf(aTop: boolean, a: readonly string[], bTop: boolean, b: readonly string[], ci: boolean): string | null {
  if (aTop) return bTop ? "*" : (b[0] ?? null);
  if (bTop) return a[0] ?? null;
  return firstOverlap(a, b, ci);
}

function classify(u: EdgeTask, v: EdgeTask, ci: boolean): string | null {
  const uTop = isTop(u);
  const vTop = isTop(v);
  const ww = overlapOf(uTop, writesOf(u), vTop, writesOf(v), ci);
  if (ww !== null) return `write/write ${ww}`;
  const wr = overlapOf(uTop, writesOf(u), false, conflictReadsOf(v), ci);
  if (wr !== null) return `write/read ${wr}`;
  const rw = overlapOf(false, conflictReadsOf(u), vTop, writesOf(v), ci);
  if (rw !== null) return `read/write ${rw}`;
  return null;
}

function conflictConfidence(u: EdgeTask, v: EdgeTask): Edge["confidence"] {
  if (isTop(u) || isTop(v)) return "low";
  const strong = (c: Footprint["confidence"]): boolean => c === "explicit" || c === "ownership";
  return strong(u.confidence) && strong(v.confidence) ? "high" : "medium";
}

export function conflictEdges(tasks: readonly EdgeTask[], reach: Reach, ci: boolean): Edge[] {
  const ord = tasks.filter((t) => LAUNCHABLE.has(t.kind)).sort(byPlanIndex);
  const index = new PathIndex(ci);
  const tops: number[] = [];
  const nonEmpty: number[] = [];
  const out: Edge[] = [];
  for (let j = 0; j < ord.length; j += 1) {
    const v = at(ord, j);
    const vPaths = [...writesOf(v), ...conflictReadsOf(v)];
    const vHas = isTop(v) || vPaths.length > 0;
    if (vHas) {
      const cand = new Set<number>();
      if (isTop(v)) for (const u of nonEmpty) cand.add(u);
      else {
        for (const path of vPaths) index.collect(path, cand);
        for (const u of tops) cand.add(u);
      }
      // Nearest predecessor first: once linked, earlier ones are no longer concurrent with v (linear, not quadratic).
      for (const ui of [...cand].sort((a, b) => b - a)) {
        const u = at(ord, ui);
        if (!reach.concurrent(u.id, v.id)) continue;
        const why = classify(u, v, ci);
        if (why === null) continue;
        out.push(mkEdge(u.id, v.id, "conflict", conflictConfidence(u, v), `conflict: ${why}`));
        reach.add(u.id, v.id);
      }
    }
    if (!vHas) continue;
    nonEmpty.push(j);
    if (isTop(v)) tops.push(j);
    else for (const path of vPaths) index.add(path, j);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Cycles

/** The shortest cycle (node ids, closing edge implied) of the graph, or null. Tarjan SCC, then BFS inside each SCC. */
export function minimalCycle(nodes: readonly string[], edges: readonly Pick<Edge, "from" | "to">[]): string[] | null {
  const idx = new Map<string, number>();
  nodes.forEach((n, i) => { if (!idx.has(n)) idx.set(n, i); });
  const n = nodes.length;
  const adj: number[][] = nodes.map(() => []);
  for (const e of edges) {
    const a = idx.get(e.from);
    const b = idx.get(e.to);
    if (a !== undefined && b !== undefined) at(adj, a).push(b);
  }

  const order: number[] = new Array<number>(n).fill(-1);
  const low: number[] = new Array<number>(n).fill(0);
  const onStack: boolean[] = new Array<boolean>(n).fill(false);
  const stack: number[] = [];
  const comps: number[][] = [];
  let counter = 0;
  for (let s = 0; s < n; s += 1) {
    if (at(order, s) !== -1) continue;
    const work: Array<{ v: number; i: number }> = [{ v: s, i: 0 }];
    order[s] = counter;
    low[s] = counter;
    counter += 1;
    stack.push(s);
    onStack[s] = true;
    while (work.length > 0) {
      const fr = at(work, work.length - 1);
      const succ = at(adj, fr.v);
      if (fr.i < succ.length) {
        const w = at(succ, fr.i);
        fr.i += 1;
        if (at(order, w) === -1) {
          order[w] = counter;
          low[w] = counter;
          counter += 1;
          stack.push(w);
          onStack[w] = true;
          work.push({ v: w, i: 0 });
        } else if (at(onStack, w)) {
          low[fr.v] = Math.min(at(low, fr.v), at(order, w));
        }
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const parent = at(work, work.length - 1).v;
        low[parent] = Math.min(at(low, parent), at(low, fr.v));
      }
      if (at(low, fr.v) === at(order, fr.v)) {
        const comp: number[] = [];
        let w: number;
        do {
          w = stack.pop() as number;
          onStack[w] = false;
          comp.push(w);
        } while (w !== fr.v);
        comps.push(comp);
      }
    }
  }

  let best: string[] | null = null;
  const better = (c: string[]): boolean => {
    if (best === null || c.length < best.length) return true;
    return c.length === best.length && c.join("\u0000") < best.join("\u0000");
  };
  const normalize = (ids: string[]): string[] => {
    let m = 0;
    for (let i = 1; i < ids.length; i += 1) if (at(ids, i) < at(ids, m)) m = i;
    return [...ids.slice(m), ...ids.slice(0, m)];
  };
  for (const comp of comps) {
    const members = new Set(comp);
    if (comp.length === 1) {
      const only = at(comp, 0);
      if (at(adj, only).includes(only)) {
        const c = [at(nodes, only)];
        if (better(c)) best = c;
      }
      continue;
    }
    for (const s of [...comp].sort((a, b) => a - b)) {
      const parent = new Map<number, number>([[s, -1]]);
      const queue: number[] = [s];
      let found = -1;
      for (let qi = 0; qi < queue.length && found < 0; qi += 1) {
        const u = at(queue, qi);
        for (const w of at(adj, u)) {
          if (!members.has(w)) continue;
          if (w === s) {
            found = u;
            break;
          }
          if (!parent.has(w)) {
            parent.set(w, u);
            queue.push(w);
          }
        }
      }
      if (found < 0) continue;
      const path: number[] = [];
      for (let c = found; c !== -1; c = parent.get(c) as number) path.push(c);
      path.reverse();
      const c = normalize(path.map((i) => at(nodes, i)));
      if (better(c)) best = c;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------------------------
// All passes

export function buildEdges(
  p: ParsedPlan,
  tasks: readonly EdgeTask[],
  o: { crossPhase: "gate" | "inferred"; ci: boolean },
): { edges: Edge[]; warnings: CompileIssue[] } {
  const sorted = [...tasks].sort(byPlanIndex);
  const warnings: CompileIssue[] = [];
  const set = new EdgeSet();

  // 1. structural, 2. graph
  for (const e of structuralEdges(p, sorted, o.crossPhase)) set.add(e);
  warnings.push(...structuralWarnings(p, sorted));
  const graph = graphEdges(p, sorted);
  for (const e of graph.edges) set.add(e);
  warnings.push(...graph.warnings);

  // Cycles among structural and graph edges are fatal (D6); every task also reaches the gate of its phase.
  const taskIds = sorted.map((t) => t.id);
  const phaseIds = p.phases.map((ph) => ph.id);
  const nodes = [...taskIds, ...phaseIds.map(gateOf)];
  const implicit: Array<Pick<Edge, "from" | "to">> = [];
  for (const t of sorted) if (t.phase !== null && phaseIds.includes(t.phase)) implicit.push({ from: t.id, to: gateOf(t.phase) });
  const cycle = minimalCycle(nodes, [...set.list(), ...implicit]);
  if (cycle !== null) {
    const evidence = cycle.map((from, i) => {
      const to = at(cycle, (i + 1) % cycle.length);
      return set.get(from, to)?.evidence ?? `phase-gate: ${from} -> ${to} (a task reaches the gate of its phase)`;
    });
    throw new ExecutorError("E_CYCLE", `dependency cycle: ${[...cycle, at(cycle, 0)].join(" -> ")}`, { cycle, evidence });
  }

  const phaseOfTask = new Map(sorted.map((t) => [t.id, t.phase]));
  const reach = new Reach(taskIds, (id) => phaseOfTask.get(id) ?? null, phaseIds);
  for (const e of set.list()) reach.add(e.from, e.to);

  // 3. explicit: an edge that would close a cycle is dropped; the pair stays ordered the other way.
  const explicit = explicitEdges(p, sorted);
  warnings.push(...explicit.warnings);
  for (const e of explicit.edges) {
    if (set.has(e.from, e.to)) continue;
    if (e.from === e.to || reach.reaches(e.to, e.from)) {
      warnings.push({
        code: "explicit-edge-cycle-dropped",
        line: lineOfEvidence(e.evidence),
        message: `explicit edge ${e.from} -> ${e.to} would close a cycle and was dropped: ${e.evidence}`,
      });
      continue;
    }
    set.add(e);
    reach.add(e.from, e.to);
  }

  // 4. contract, 5. conflict: only concurrent pairs, so no cycle can result.
  for (const e of contractEdges(sorted, reach, o.ci)) set.add(e);
  for (const e of conflictEdges(sorted, reach, o.ci)) set.add(e);
  return { edges: set.list(), warnings };
}
