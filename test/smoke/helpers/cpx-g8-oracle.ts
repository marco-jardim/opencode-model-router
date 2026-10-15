import { checkV2ObservationStream, type ObservationRecord, type ServiceObservationData } from "../../../src/compat/v2-observations";
import type { Attempt, ExecutorEvent, IntegrationEntry, LedgerV1, TaskNode } from "../../../src/executor/types";
import type { ObservationFile } from "./cpx-idle-oracle";

export interface GraphEdge { readonly from: string; readonly to: string }
export interface PhaseGraph {
  readonly phases: readonly { readonly id: string }[];
  readonly tasks: Readonly<Record<string, { readonly phase: string | null }>>;
}
type AuthoredTasks = Readonly<Record<string, { readonly durationMs: number }>>;

function fact(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`G8 service oracle: ${message}`);
}
const nonnegative = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
const text = (s: unknown): s is string => typeof s === "string" && s.length > 0;

/** The same independent graph used by workBounds: ALL phase tasks precede their semantic gate,
 * including terminal gates. Neither observed launch order nor the compiler's estimates are costs.
 */
export function workGraph(tasks: AuthoredTasks, edges: readonly GraphEdge[], graph: PhaseGraph = { phases: [], tasks: {} }, label = "G8") {
  const costs = new Map(Object.entries(tasks).map(([id, task]) => {
    fact(nonnegative(task.durationMs), `invalid authored duration for ${id}`);
    return [id, task.durationMs] as const;
  }));
  for (const phase of graph.phases) {
    fact(!costs.has(`gate:${phase.id}`), `duplicate gate ${phase.id}`);
    costs.set(`gate:${phase.id}`, 0);
  }
  const links = [...edges, ...Object.entries(graph.tasks).flatMap(([id, task]) => task.phase === null ? [] : [{ from: id, to: `gate:${task.phase}` }])]
    .map(edge => Object.freeze({ from: edge.from, to: edge.to }));
  const cp = longestPath(costs, links, label);
  return { costs, links, cp, work: Object.values(tasks).reduce((sum, task) => sum + task.durationMs, 0) };
}

function longestPath(costs: ReadonlyMap<string, number>, links: readonly GraphEdge[], label = "G8"): number {
  for (const edge of links) for (const id of [edge.from, edge.to]) {
    if (!costs.has(id)) throw new Error(`${label}: unknown graph vertex ${id}`);
  }
  const visiting = new Set<string>(), longest = new Map<string, number>();
  const visit = (id: string): number => {
    const cached = longest.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) throw new Error(`${label}: cycle at ${id}`);
    visiting.add(id);
    const length = costs.get(id)! + Math.max(0, ...links.filter(edge => edge.to === id).map(edge => visit(edge.from)));
    visiting.delete(id);
    longest.set(id, length);
    return length;
  };
  return Math.max(0, ...[...costs.keys()].map(visit));
}

export interface G8Plan {
  readonly planId: string;
  readonly compiledLedgerSeq: number;
  readonly p: number;
  readonly rawCP: number;
  readonly W_auth: number;
  readonly tasks: Readonly<Record<string, { readonly authored: number; readonly writer: boolean; readonly phase: string | null; readonly kind: string }>>;
  readonly phases: readonly string[];
  readonly links: readonly GraphEdge[];
}

/** Call BEFORE approval. Copy and freeze every graph/cost/config input, not the mutable final ledger. */
export function freezeG8Plan(tasks: AuthoredTasks, compiled: PhaseGraph & {
  planId: string; seq: number; config: Pick<LedgerV1["config"], "maxParallel">;
  tasks: Readonly<Record<string, Pick<TaskNode, "phase" | "kind" | "footprint">>>;
  edges: readonly GraphEdge[];
}): G8Plan {
  fact(Object.keys(tasks).sort().join("\0") === Object.keys(compiled.tasks).sort().join("\0"), "authored/compiled task inventory differs");
  fact(Number.isInteger(compiled.config.maxParallel) && compiled.config.maxParallel > 0, "invalid configured p");
  fact(Number.isInteger(compiled.seq) && compiled.seq >= 0, "invalid pre-run ledger sequence");
  const graph = workGraph(tasks, compiled.edges, compiled);
  return Object.freeze({ planId: compiled.planId, compiledLedgerSeq: compiled.seq, p: compiled.config.maxParallel, rawCP: graph.cp, W_auth: graph.work,
    tasks: Object.freeze(Object.fromEntries(Object.entries(tasks).map(([id, task]) => {
      const node = compiled.tasks[id]!;
      return [id, Object.freeze({ authored: task.durationMs, writer: node.footprint.writes.length > 0, phase: node.phase, kind: node.kind })];
    }))), phases: Object.freeze(compiled.phases.map(phase => phase.id)), links: Object.freeze(graph.links) });
}

type ServiceRow = Extract<ObservationRecord, { family: "service" }>;
type SchedulerRow = Extract<ObservationRecord, { family: "scheduler" }>;
interface Span { start: ServiceRow; end: ServiceRow }
type Step = Extract<ExecutorEvent, { type: "integration-step" }>;
interface EntryEvidence { entry: IntegrationEntry; steps: { start: Step; end: Step }[]; spans: Span[] }
export interface G8Final {
  planId: string; status: LedgerV1["status"];
  tasks: Readonly<Record<string, { state: TaskNode["state"]; integrated: TaskNode["integrated"];
    attempts: readonly Pick<Attempt, "n" | "outcome" | "verdict">[] }>>;
  phases: readonly Pick<LedgerV1["phases"][number], "id" | "gate">[];
}
export interface VertexCost { authored: number; V_service: number; I_service: number; S_service: number; total: number; entryIds: string[] }
export interface G8Metrics {
  makespan: number; CP_eff: number; W_auth: number; p: number; "ΣI_service": number; rawCP: number; rawΣI: number;
  vertices: Record<string, VertexCost>; bound: number;
  window: { fromAt: number; toAt: number }; stream: string;
  diagnostics: { serviceSpans: number; unattributedVerifyMs: number; unattributedSpans: number;
    prepMs: number; waitMs: number; entryService: Record<string, number> };
}

function serviceRow(row: ServiceRow): void {
  fact(text(row.operationId) && text(row.stage) && text(row.planId), "invalid service identity");
  fact(["service", "service-prep", "service-wait", "service-unattributed"].includes(row.spanKind)
    && ["verify", "rebase", "checks", "fast-forward", "phase-suite"].includes(row.component), "unknown service kind/component");
  fact([row.taskId, row.phaseId, row.entryId, row.candidate].every(v => v === null || text(v)), "invalid service attribution");
  fact(row.attempt === null || (Number.isInteger(row.attempt) && row.attempt > 0), "invalid service attempt");
  fact(Array.isArray(row.taskIds) && row.taskIds.every(text) && new Set(row.taskIds).size === row.taskIds.length, "invalid/duplicate batch membership");
  fact(nonnegative(row.clockMs) && nonnegative(row.durationMs), "invalid service clock/duration");
  fact(row.action === "start" ? row.result === null && row.durationMs === 0
    : row.action === "end" && text(row.result), "invalid service action/result");
}
function spanIdentity(row: ServiceObservationData): string {
  return JSON.stringify([row.planId, row.taskId, row.attempt, row.phaseId, row.entryId, row.taskIds,
    row.component, row.candidate, row.spanKind, row.stage]);
}

/** Validate ALL files and ALL pairs (also prep/wait and other plans). Never splice clocks across hosts. */
function serviceSpans(files: readonly ObservationFile[], planId: string): { spans: Span[]; stream: string; commits: SchedulerRow[] } {
  fact(files.length > 0, "missing observation files");
  const streams = new Set<string>(), owners = new Set<string>(), spans: Span[] = [];
  const commits: SchedulerRow[] = [];
  for (const file of files) {
    fact(file.text.endsWith("\n"), `truncated observation file ${file.file}`);
    const lines = file.text.slice(0, -1).split(/\r?\n/);
    const rows = checkV2ObservationStream(lines);
    const seal: { stream: string; at: number } = JSON.parse(lines.at(-1)!);
    fact(!streams.has(seal.stream), `duplicate stream ${seal.stream}`);
    streams.add(seal.stream);
    const open = new Map<string, ServiceRow>(), seen = new Set<string>();
    let at = -Infinity, clock = -Infinity;
    for (const row of rows) {
      fact(row.at >= at, "observation clock moved backwards");
      at = row.at;
      if (row.family === "scheduler" && row.planId === planId && ["ledger", "attach"].includes(row.action)) {
        owners.add(row.stream);
        commits.push(row);
      }
      if (row.family !== "service") continue;
      serviceRow(row);
      fact(row.clockMs >= clock, "service clock moved backwards");
      clock = row.clockMs;
      if (row.planId === planId) owners.add(row.stream);
      if (row.action === "start") {
        fact(!seen.has(row.operationId), `duplicate operation ${row.operationId} (service counted twice)`);
        seen.add(row.operationId);
        open.set(row.operationId, row);
      } else {
        const start = open.get(row.operationId);
        fact(start, `unpaired service end ${row.operationId}`);
        fact(spanIdentity(start) === spanIdentity(row), `ambiguous paired attribution ${row.operationId}`);
        fact(row.durationMs === row.clockMs - start.clockMs, `service duration mismatch ${row.operationId}`);
        open.delete(row.operationId);
        if (row.planId === planId) spans.push({ start, end: row });
      }
    }
    fact(seal.at >= at, "seal clock moved backwards");
    fact(open.size === 0, "unpaired service start");
  }
  fact(owners.size === 1, "missing service stream or ambiguous attribution across streams");
  return { spans, stream: [...owners][0]!, commits };
}

function bag(value: unknown): Record<string, unknown> {
  fact(value !== null && typeof value === "object" && !Array.isArray(value), "invalid committed observation");
  return value as Record<string, unknown>;
}
/** Non-history events (task-integrated/no-changes/gate-changed) are compacted every 200 events.
 * The sealed scheduler stream records their actual committed swaps, including the no-changes QA
 * batch's running/completed -> done transition. Do not infer a no-op from absent service records.
 */
function committedCompletions(rows: readonly SchedulerRow[], plan: G8Plan, final: G8Final) {
  const noOperation = new Set<string>();
  const integrations = new Map<string, { beforeSeq: number; afterSeq: number }[]>();
  let beforeSeq = -1;
  let previous = new Map<string, string>();
  for (const row of rows) {
    const state = bag(row.state);
    fact(Number.isInteger(state.ledgerSeq) && Number(state.ledgerSeq) >= beforeSeq && Array.isArray(state.tasks), "invalid committed ledger sequence/tasks");
    const afterSeq = Number(state.ledgerSeq), next = new Map<string, string>();
    // Compilation may replace a draft before this oracle freezes it. Those are not execution facts.
    if (afterSeq < plan.compiledLedgerSeq) { beforeSeq = afterSeq; continue; }
    for (const raw of state.tasks) {
      const task = bag(raw);
      fact(text(task.id) && text(task.state) && !next.has(task.id) && Array.isArray(task.attempts), "invalid committed task");
      next.set(task.id, task.state);
      const authored = plan.tasks[task.id], outcome = final.tasks[task.id];
      fact(authored && outcome && task.kind === authored.kind && task.phase === authored.phase, "committed task differs from frozen DAG");
      if (task.state === previous.get(task.id)) continue;
      const attempt = task.attempts.length ? bag(task.attempts.at(-1)) : undefined;
      if (attempt?.n !== outcome.attempts.at(-1)?.n || attempt?.outcome !== "succeeded") continue;
      if (authored.writer && task.state === "integrated" && previous.get(task.id) === "integrating") {
        const batches = integrations.get(task.id) ?? [];
        batches.push({ beforeSeq, afterSeq }); integrations.set(task.id, batches);
      } else if (!authored.writer && authored.kind === "qa" && task.state === "done" && ["running", "completed"].includes(previous.get(task.id) ?? "")) {
        noOperation.add(task.id);
      }
    }
    fact(next.size === Object.keys(plan.tasks).length, "incomplete committed task inventory");
    previous = next; beforeSeq = afterSeq;
  }
  return { noOperation, integrations };
}

function unionMs(spans: readonly Span[]): number {
  let total = 0, end = -Infinity;
  for (const span of [...spans].sort((a, b) => a.start.clockMs - b.start.clockMs)) {
    total += Math.max(0, span.end.clockMs - Math.max(end, span.start.clockMs));
    end = Math.max(end, span.end.clockMs);
  }
  return total;
}
const members = (ids: readonly string[]): string => [...ids].sort().join("\0");
function antichain(plan: G8Plan, ids: readonly string[]): void {
  fact(ids.length > 0 && new Set(ids).size === ids.length && ids.every(id => plan.tasks[id]?.writer), "invalid batch membership");
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return plan.links.some(edge => edge.from === from && reaches(edge.to, to, seen));
  };
  for (const a of ids) for (const b of ids) if (a !== b) {
    fact(!reaches(a, b), `batch members are not an antichain: ${a} -> ${b} (entry duplicated on a path)`);
  }
}

/** A-6.1-1/A-6.1-2, fresh throughput runs only. The event inventory proves WHICH operations were required;
 * it never supplies their cost. Only service clockMs intervals supply that cost; unattributed verify is
 * recognized evidence with zero intrinsic credit. Prep/wait and enclosing journal durations cannot enlarge
 * a term. ΣI is the union of rebase/checks/fast-forward in the serial
 * task-entry lane; background phase-suite service belongs to gate vertices, not the serial lane.
 */
export function reconstructG8(plan: G8Plan, final: G8Final, events: readonly ExecutorEvent[], files: readonly ObservationFile[], rawΣI: number): G8Metrics {
  fact(final.planId === plan.planId && final.status === "completed", "missing completed plan");
  fact(members(Object.keys(final.tasks)) === members(Object.keys(plan.tasks)), "final task inventory differs from frozen DAG");
  fact(members(final.phases.map(p => p.id)) === members(plan.phases) && final.phases.every(p => p.gate === "passed"), "missing passed gates");
  fact(nonnegative(rawΣI), "invalid raw integration diagnostic");
  const launches = events.filter(e => e.type === "metric" && e.metric.name === "launch");
  const completions = events.filter(e => e.type === "metric" && e.metric.name === "wake" && e.metric.reason === "plan-completed" && e.metric.result === "sent");
  fact(launches.length > 0 && completions.length === 1, "missing/ambiguous makespan endpoints");
  const window = { fromAt: Math.min(...launches.map(e => Date.parse(e.at))), toAt: Date.parse(completions[0]!.at) };
  fact(nonnegative(window.fromAt) && nonnegative(window.toAt) && window.toAt >= window.fromAt, "invalid makespan window");
  const { spans, stream, commits } = serviceSpans(files, plan.planId);
  const committed = committedCompletions(commits, plan, final);
  const entries = new Map<string, EntryEvidence>(), open = new Map<string, Step>(), closed = new Set<string>();
  let seq = -Infinity;
  for (const event of events) {
    fact(event.seq > seq, "duplicate/out-of-order journal event");
    seq = event.seq;
    if (event.type !== "integration-step") continue;
    const entry = event.entry;
    let evidence = entries.get(entry.id);
    if (!evidence) {
      evidence = { entry, steps: [], spans: [] };
      entries.set(entry.id, evidence);
      if (entry.kind === "task" || entry.kind === "batch") {
        antichain(plan, entry.taskIds);
        fact((entry.kind === "task") === (entry.taskIds.length === 1), "invalid task/batch entry kind");
        fact(entry.taskIds.every(id => plan.tasks[id]!.phase === entry.phaseId), "ambiguous batch phase");
      }
    }
    fact(entry.kind === evidence.entry.kind && entry.phaseId === evidence.entry.phaseId
      && members(entry.taskIds) === members(evidence.entry.taskIds), `ambiguous entry membership ${entry.id}`);
    fact(!closed.has(entry.id), `duplicate closed entry ${entry.id}`);
    if (event.edge === "start") {
      fact(!open.has(entry.id), `unpaired/overlapping journal step ${entry.id}`);
      open.set(entry.id, event);
    } else {
      const start = open.get(entry.id);
      fact(start && start.step === event.step && Date.parse(start.at) <= Date.parse(event.at), `unpaired journal step ${entry.id}`);
      evidence.steps.push({ start, end: event });
      open.delete(entry.id);
      if (event.closes) closed.add(entry.id);
    }
  }
  fact(open.size === 0 && [...entries.keys()].every(id => closed.has(id)), "unclosed integration entry");
  const verify = new Map<string, Span[]>();
  for (const span of spans) {
    const row = span.start;
    if (row.spanKind !== "service" && row.spanKind !== "service-unattributed") continue;
    // at locates a span in the epoch makespan window; NEVER subtract it for a service cost. All required
    // operations of this fresh run must be enclosed. Crossing a boundary lacks a monotonic calibration:
    // fail closed rather than silently count outside-window time or invent an epoch/performance offset.
    fact(row.at >= window.fromAt && span.end.at <= window.toAt, `service outside makespan window ${row.operationId}`);
    if (row.component === "verify") {
      fact(row.taskId !== null && row.attempt !== null && row.entryId === null && row.phaseId === null
        && members(row.taskIds) === row.taskId && plan.tasks[row.taskId] !== undefined, "ambiguous verify attribution");
      fact(final.tasks[row.taskId]!.attempts.some(a => a.n === row.attempt), "unknown verify attempt");
      const key = `${row.taskId}#${row.attempt}`;
      const group = verify.get(key) ?? [];
      group.push(span); verify.set(key, group);
    } else {
      const evidence = row.entryId === null ? undefined : entries.get(row.entryId);
      fact(evidence && row.taskId === null && row.attempt === null && row.phaseId === evidence.entry.phaseId
        && members(row.taskIds) === members(evidence.entry.taskIds), "ambiguous entry service attribution");
      const suite = row.component === "phase-suite";
      fact(suite ? evidence.entry.kind === "phase-suite" && row.taskIds.length === 0 && plan.phases.includes(row.phaseId!)
        : ["task", "batch"].includes(evidence.entry.kind), "ineligible integration service entry");
      const steps = row.component === "checks" ? ["checks", "batch-checks", "bisect"]
        : suite ? ["phase-suite", "suite-rerun", "bisect"] : [row.component];
      fact(evidence.steps.some(step => steps.includes(step.start.step) && row.at >= Date.parse(step.start.at)
        && span.end.at <= Date.parse(step.end.at)
        && (row.component === "rebase" || (row.candidate !== null && row.candidate === step.start.entry.candidate))),
      `service lacks matching journal step/candidate ${row.operationId}`);
      if (row.spanKind === "service") evidence.spans.push(span);
    }
  }
  const vertices: Record<string, VertexCost> = {}, entryService: Record<string, number> = {};
  const serial: Span[] = [];
  for (const [id, evidence] of entries) {
    if (!["task", "batch", "phase-suite"].includes(evidence.entry.kind)) continue;
    fact(evidence.spans.length > 0, `missing entry service ${id}`);
    if (evidence.entry.kind !== "phase-suite") {
      for (const component of ["rebase", "checks", "fast-forward"]) {
        fact(evidence.spans.some(s => s.start.component === component), `missing entry service ${id}/${component}`);
      }
      // ONE entry inventory, not a flatMap over member vertices. Overlapping executions union, not sum.
      serial.push(...evidence.spans);
    }
    entryService[id] = unionMs(evidence.spans);
  }
  for (const [id, task] of Object.entries(plan.tasks)) {
    const outcome = final.tasks[id]!;
    const attempt = outcome.attempts.at(-1);
    fact(attempt?.outcome === "succeeded" && new Set(outcome.attempts.map(a => a.n)).size === outcome.attempts.length, `missing final successful attempt ${id}`);
    const taskVerify = verify.get(`${id}#${attempt.n}`) ?? [];
    const integrated = committed.integrations.get(id) ?? [];
    const attributed = [...entries.values()].filter(e => ["task", "batch"].includes(e.entry.kind) && e.entry.taskIds.includes(id));
    if (task.writer) {
      fact(outcome.state === "integrated" && outcome.integrated !== null && attempt.verdict === "pass", `writer not integrated/passing ${id}`);
      const verdicts = events.filter(e => e.type === "attempt-verdict" && e.taskId === id && e.n === attempt.n);
      fact(verdicts.length === 1 && verdicts[0]!.type === "attempt-verdict" && verdicts[0]!.verdict === "pass", `missing/ambiguous passing verdict ${id}`);
      fact(taskVerify.length > 0, `missing verify service for integrated writer ${id}`);
      fact(taskVerify.every(s => s.end.at <= Date.parse(verdicts[0]!.at)), `verify service after verdict ${id}`);
      fact(attributed.length === 1 && integrated.length === 1, `ambiguous/duplicate integration attribution ${id}`);
      const published = integrated[0]!;
      fact(attributed[0]!.steps.some(s => s.end.step === "fast-forward" && s.end.result === "ok"
        && published.beforeSeq < s.end.batch && published.afterSeq >= s.end.seq), `missing integrated entry ${id}`);
    } else {
      // QA's explicit completed->done/no-changes is the pipeline's no-operation evidence, not missing=0.
      fact(task.kind === "qa" && outcome.state === "done" && outcome.integrated === null && attempt.verdict === null
        && committed.noOperation.has(id),
      `missing explicit no-operation evidence for ${id}`);
      fact(![...verify.keys()].some(key => key.startsWith(`${id}#`)) && attributed.length === 0 && integrated.length === 0, `contradictory QA service ${id}`);
    }
    const I_service = attributed.reduce((sum, e) => sum + entryService[e.entry.id]!, 0);
    const V_service = taskVerify.filter(s => s.start.spanKind === "service")
      .reduce((sum, s) => sum + (s.end.clockMs - s.start.clockMs), 0);
    vertices[id] = { authored: task.authored, V_service, I_service, S_service: 0,
      total: task.authored + V_service + I_service, entryIds: attributed.map(e => e.entry.id) };
  }
  for (const phase of plan.phases) {
    const suites = [...entries.values()].filter(e => e.entry.kind === "phase-suite" && e.entry.phaseId === phase);
    fact(suites.length > 0 && suites.some(e => e.steps.some(s => s.end.result === "ok" && s.end.closes)), `missing phase-suite service for passed gate ${phase}`);
    const S_service = unionMs(suites.flatMap(e => e.spans));
    vertices[`gate:${phase}`] = { authored: 0, V_service: 0, I_service: 0, S_service, total: S_service, entryIds: suites.map(e => e.entry.id) };
  }
  const CP_eff = longestPath(new Map(Object.entries(vertices).map(([id, cost]) => [id, cost.total])), plan.links);
  const ΣI_service = unionMs(serial);
  return { makespan: window.toAt - window.fromAt, CP_eff, W_auth: plan.W_auth, p: plan.p, "ΣI_service": ΣI_service,
    rawCP: plan.rawCP, rawΣI, vertices, bound: 1.3 * Math.max(CP_eff, plan.W_auth / plan.p, ΣI_service), window, stream,
    diagnostics: { serviceSpans: spans.filter(s => s.start.spanKind === "service").length,
      unattributedVerifyMs: unionMs(spans.filter(s => s.start.spanKind === "service-unattributed" && s.start.component === "verify")),
      unattributedSpans: spans.filter(s => s.start.spanKind === "service-unattributed").length,
      prepMs: unionMs(spans.filter(s => s.start.spanKind === "service-prep")),
      waitMs: unionMs(spans.filter(s => s.start.spanKind === "service-wait")), entryService } };
}

export function assertG8Bound(metrics: G8Metrics): void {
  fact(nonnegative(metrics.makespan) && nonnegative(metrics.bound) && metrics.makespan <= metrics.bound,
    `amended makespan bound exceeded: ${metrics.makespan} > ${metrics.bound}`);
}
