// QaLoop (phase 4.2.3): parse findings, create fix and re-review tasks, close the QA gate.
import {
  canonicalFindingsJson, ExecutorError, fixTaskId, formatInboxId, isFindingsReport, nextInboxNumber, QA_CAP_OPTIONS,
  QA_ROUND_LIMIT, reviewTaskId,
  type Clock, type Edge, type ExecutorEventInput, type Finding, type FindingsReport, type InboxItem, type LedgerV1,
  type LedgerWriter, type PhaseId, type PhaseRecord, type QaCapChoice, type QaLoop, type TaskId, type TaskNode,
  type Waker,
} from "./types.js";
import { pathsOverlap } from "./schedule.js";

/** The part of the executor logger this module uses. */
export interface QaLoopLog { warn(message: string): void }

export interface QaLoopDeps { writer: LedgerWriter; waker: Waker; clock: Clock; log: QaLoopLog }

const FENCE_RE = /```json[ \t]*\r?\n([\s\S]*?)```/g;
const PARSE_ERROR_MAX = 500;

function boundError(s: string): string {
  return s.length > PARSE_ERROR_MAX ? `${s.slice(0, PARSE_ERROR_MAX - 1)}…` : s;
}

/** The last ```json fenced block of `text`, else the whole text (types.ts extraction rule). */
export function extractFindingsText(text: string): string {
  let last: string | null = null;
  for (const m of text.matchAll(FENCE_RE)) last = m[1] ?? "";
  return last ?? text;
}

export function parseFindings(text: string): { ok: true; report: FindingsReport } | { ok: false; error: string } {
  const body = extractFindingsText(text).trim();
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch (e) {
    return { ok: false, error: boundError(`findings are not valid JSON: ${e instanceof Error ? e.message : String(e)}`) };
  }
  if (!isFindingsReport(v)) return { ok: false, error: boundError("findings do not match FINDINGS_FORMAT") };
  return { ok: true, report: v };
}

type Outcome = "passed" | "next-round" | "cap-reached";

function inboxItem(l: Readonly<LedgerV1>, offset: number, i: Omit<InboxItem, "id">): ExecutorEventInput {
  return { type: "inbox-added", item: { id: formatInboxId("qa-cap", nextInboxNumber(l) + offset), ...i } };
}

function openCapItems(l: Readonly<LedgerV1>): InboxItem[] {
  return l.inbox.filter((x) => x.kind === "qa-cap" && x.severity === "critical" && x.answer === null);
}

function isPhaseTask(l: Readonly<LedgerV1>, phaseId: PhaseId, taskId: TaskId | null): boolean {
  if (taskId === null) return false;
  const t = taskOf(l, taskId);
  return t !== null && t.phase === phaseId;
}

export function createQaLoop(d: QaLoopDeps): QaLoop {
  const { writer, waker, clock, log } = d;

  /** Deferred minor/nit findings as closed info items (Q3). */
  function deferredEvents(l: Readonly<LedgerV1>, phaseId: PhaseId, taskId: TaskId, deferred: readonly Finding[], base: number): ExecutorEventInput[] {
    void phaseId;
    return deferred.map((f, i) =>
      inboxItem(l, base + i, {
        kind: "qa-cap", severity: "info", taskId, options: [], answer: "deferred", createdAt: clock.iso(),
        text: boundText(`deferred ${f.severity} ${f.id}: ${f.problem} [${f.files.join(", ")}]`),
      }));
  }

  /** Fix tasks for `groups`, then the re-review task, with the edges (Q5-Q7). */
  function roundTasks(l: Readonly<LedgerV1>, phase: PhaseRecord, qaTask: TaskNode, round: number,
    groups: ReturnType<typeof groupFindings>, previous: readonly Finding[]): ExecutorEventInput[] {
    const out: ExecutorEventInput[] = [];
    const template = taskOf(l, `${phase.id}.FIX`);
    const fixIds: TaskId[] = [];
    const filelessIds: TaskId[] = [];
    groups.forEach((g, idx) => {
      const id = fixTaskId(phase.id, round, idx + 1);
      const fileless = g.writes.length === 0;
      (fileless ? filelessIds : fixIds).push(id);
      const line = template !== null ? template.route.line : `${DEFAULT_FIX_ROUTE_LINE} ${phaseRootToken(l, phase.id)}`;
      const route = template !== null ? { ...template.route } : { line, role: FIX_ROLE_AGENT, tier: "medium" as const, pin: true };
      out.push({
        type: "task-created",
        task: {
          id, title: `Fix QA round ${round} findings (${idx + 1})`, phase: phase.id, kind: "fix",
          text: `TASK ${id}: fix the QA findings below. Touch only: ${g.writes.length === 0 ? "(no file named; request a lease with NEED MORE: lease <path>)" : g.writes.join(", ")}\n${bodyJson(g.findings)}`,
          subtasks: [], route,
          verify: template !== null ? template.verify : "required",
          acceptance: template !== null ? template.acceptance : null,
          footprint: { writes: [...g.writes], reads: [], confidence: "explicit", sources: ["writes-line"] },
          estimate: template !== null ? { ...template.estimate } : { p50: 0, p90: 0, source: "qa-loop" },
          state: "pending", attempts: [], slot: null, branch: null, integrated: null,
        },
      });
    });
    const reviewId = reviewTaskId(phase.id, round + 1);
    out.push({
      type: "task-created",
      task: {
        id: reviewId, title: `QA round ${round + 1}`, phase: phase.id, kind: "qa",
        text: `TASK ${reviewId}: re-review phase ${phase.id} after the round ${round} fixes. Previous findings:\n${bodyJson(previous)}\n${REVIEW_INSTRUCTION_MARKER}\n${originalReviewText(qaTask.text)}`,
        subtasks: [], route: { ...qaTask.route }, verify: qaTask.verify, acceptance: qaTask.acceptance,
        footprint: { writes: [], reads: [], confidence: "explicit", sources: ["writes-line"] },
        estimate: { ...qaTask.estimate }, state: "pending", attempts: [], slot: null, branch: null, integrated: null,
      },
    });
    const edge = (from: TaskId, to: TaskId): ExecutorEventInput => ({
      type: "edge-added",
      edge: { from, to, kind: "structural", confidence: "high", evidence: `qa round ${round}` } satisfies Edge,
    });
    for (const f of filelessIds) for (const o of fixIds) out.push(edge(o, f));
    for (const f of [...fixIds, ...filelessIds]) out.push(edge(f, reviewId));
    return out;
  }

  function derive(l: Readonly<LedgerV1>, phase: PhaseRecord, taskId: TaskId): Outcome {
    if (phase.gate === "passed") return "passed";
    const t = taskOf(l, taskId);
    let round = 1;
    for (let r = 1; r <= phase.qaRound; r++) if (isRoundQaTask(l, phase.id, r, taskId)) round = r;
    if (t !== null && phase.qaRound > round) return "next-round";
    if (l.inbox.some((x) => x.kind === "qa-cap" && x.severity === "critical" && x.answer === null && x.taskId === taskId)) return "cap-reached";
    throw new ExecutorError("E_ILLEGAL_TRANSITION", "QA result cannot be applied: the gate is not qa-running", { taskId, gate: phase.gate });
  }

  async function onQaResult(taskId: TaskId, report: FindingsReport): Promise<Outcome> {
    const l0 = writer.ledger;
    const t0 = taskOf(l0, taskId);
    if (t0 === null || t0.kind !== "qa" || t0.phase === null || phaseOf(l0, t0.phase) === null) {
      throw new ExecutorError("E_INVALID_INPUT", "not a qa task of a phase", { taskId });
    }
    let outcome: Outcome = "passed";
    let wrote = false;
    let capId: string | null = null;
    await writer.append((l) => {
      wrote = false;
      capId = null;
      const t = taskOf(l, taskId);
      const phase = t === null || t.phase === null ? null : phaseOf(l, t.phase);
      if (t === null || phase === null) throw new ExecutorError("E_INVALID_INPUT", "not a qa task of a phase", { taskId });
      const round = phase.qaRound;
      if (phase.gate !== "qa-running" || !isRoundQaTask(l, phase.id, round, taskId)) {
        outcome = derive(l, phase, taskId);
        return [];
      }
      wrote = true;
      const max = Math.min(l.config.qaMaxRounds, QA_ROUND_LIMIT);
      const dec = decideRound(report, round, max);
      const gate = (to: "passed" | "pending" | "awaiting-qa", trigger: "qa-clean" | "qa-next-round" | "qa-cap", qaRound: number): ExecutorEventInput =>
        ({ type: "gate-changed", phaseId: phase.id, from: "qa-running", to, trigger, qaRound });
      if (dec.kind === "clean") {
        outcome = "passed";
        return [...deferredEvents(l, phase.id, taskId, dec.deferred, 0), gate("passed", "qa-clean", round)];
      }
      if (dec.kind === "next-round") {
        outcome = "next-round";
        return [
          gate("pending", "qa-next-round", round + 1),
          ...roundTasks(l, phase, t, round, dec.groups, report.findings),
          ...deferredEvents(l, phase.id, taskId, dec.deferred, 0),
        ];
      }
      outcome = "cap-reached";
      capId = formatInboxId("qa-cap", nextInboxNumber(l));
      const lines = dec.remaining.map(findingLine).join("\n");
      return [
        gate("awaiting-qa", "qa-cap", round),
        ...(phase.paused ? [] : [{ type: "phase-paused", phaseId: phase.id, paused: true, reason: "qa-cap" } satisfies ExecutorEventInput]),
        inboxItem(l, 0, {
          kind: "qa-cap", severity: "critical", taskId, answer: null, createdAt: clock.iso(),
          options: round < QA_ROUND_LIMIT ? [...QA_CAP_OPTIONS] : ["accept"],
          text: boundText(`phase ${phase.id} QA round ${round} of ${max} still has blocking findings:\n${lines}`),
        }),
      ];
    });
    if (wrote && capId !== null) await wakeInbox(capId);
    return outcome;
  }

  async function wakeInbox(id: string): Promise<void> {
    try {
      await waker.wake("inbox", `inbox:${id}`);
    } catch (e) {
      log.warn(`qa-loop: wake for ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function onAwaitingQa(phaseId: PhaseId): Promise<void> {
    await writer.append((l) => {
      const phase = phaseOf(l, phaseId);
      if (phase === null || phase.gate !== "awaiting-qa") return [];
      const open = Object.values(l.tasks).filter((t) => t.phase === phaseId && t.kind === "qa" && t.state !== "done" && t.state !== "cancelled");
      if (open.length > 0) return [];
      if (openCapItems(l).some((x) => isPhaseTask(l, phaseId, x.taskId))) return [];
      return [{ type: "gate-changed", phaseId, from: "awaiting-qa", to: "passed", trigger: "no-open-qa", qaRound: phase.qaRound }];
    });
  }

  async function onCapAnswer(inboxId: string, choice: QaCapChoice): Promise<"passed" | "next-round"> {
    const l0 = writer.ledger;
    const item0 = l0.inbox.find((x) => x.id === inboxId);
    if (item0 === undefined || item0.kind !== "qa-cap" || item0.severity !== "critical" || item0.taskId === null) {
      throw new ExecutorError("E_INVALID_INPUT", "not a critical qa-cap item", { inboxId });
    }
    if (!item0.options.includes(choice)) throw new ExecutorError("E_INVALID_INPUT", "answer is not an option", { inboxId, choice });
    let outcome: "passed" | "next-round" = choice === "accept" ? "passed" : "next-round";
    await writer.append((l) => {
      const item = l.inbox.find((x) => x.id === inboxId);
      if (item === undefined || item.taskId === null) throw new ExecutorError("E_INVALID_INPUT", "not a critical qa-cap item", { inboxId });
      if (item.answer !== null) return [];
      const qa = taskOf(l, item.taskId);
      const phase = qa === null || qa.phase === null ? null : phaseOf(l, qa.phase);
      if (qa === null || phase === null) throw new ExecutorError("E_INVALID_INPUT", "qa task of the item is missing", { inboxId });
      const round = phase.qaRound;
      if (phase.gate !== "awaiting-qa" || !isRoundQaTask(l, phase.id, round, qa.id)) {
        throw new ExecutorError("E_ILLEGAL_TRANSITION", "the gate no longer waits on this cap item", { inboxId, gate: phase.gate });
      }
      const last = qa.attempts.at(-1);
      const parsed = parseFindings(last === undefined ? "" : last.context);
      if (!parsed.ok) throw new ExecutorError("E_INVALID_INPUT", "round findings cannot be re-read", { inboxId, error: parsed.error });
      const findings = parsed.report.findings;
      const answered: ExecutorEventInput = { type: "inbox-answered", id: inboxId, answer: choice };
      const othersCritical = l.inbox.some((x) => x.id !== inboxId && x.severity === "critical" && x.answer === null && (
        isPhaseTask(l, phase.id, x.taskId)));
      const unpause: ExecutorEventInput[] = phase.paused && !othersCritical
        ? [{ type: "phase-paused", phaseId: phase.id, paused: false, reason: `qa-cap ${choice}` }] : [];
      if (choice === "accept") {
        outcome = "passed";
        return [
          answered,
          ...deferredEvents(l, phase.id, qa.id, findings, 0),
          { type: "gate-changed", phaseId: phase.id, from: "awaiting-qa", to: "passed", trigger: "cap-accepted", qaRound: round },
          ...unpause,
        ];
      }
      outcome = "next-round";
      const blocking = findings.filter((f) => isBlockingSeverity(f.severity));
      return [
        answered,
        { type: "gate-changed", phaseId: phase.id, from: "awaiting-qa", to: "pending", trigger: "cap-fix", qaRound: round + 1 },
        ...roundTasks(l, phase, qa, round, groupFindings(blocking), findings),
        ...unpause,
      ];
    });
    return outcome;
  }

  return { parse: parseFindings, onQaResult, onAwaitingQa, onCapAnswer };
}

export type QaDecision =
  | { kind: "clean"; deferred: Finding[] }
  | { kind: "next-round"; groups: ReturnType<typeof groupFindings>; deferred: Finding[] }
  | { kind: "cap"; remaining: Finding[] };

/**
 * Q4 decision table. r = `round` (1-based), `qaMaxRounds` = max. Rounds 1-2 (with room left) fix every finding; from
 * round 3 only blocking/critical/major are fixed and minor/nit are deferred. At the cap (round >= max) blocking
 * findings give `cap`; minor/nit alone pass and are deferred (X8).
 */
export function decideRound(r: FindingsReport, round: number, qaMaxRounds: number): QaDecision {
  const blocking = r.findings.filter((x) => isBlockingSeverity(x.severity));
  const minor = r.findings.filter((x) => !isBlockingSeverity(x.severity));
  const atCap = round >= qaMaxRounds;
  if (blocking.length > 0) {
    if (atCap) return { kind: "cap", remaining: [...r.findings] };
    if (round <= 2) return { kind: "next-round", groups: groupFindings(r.findings), deferred: [] };
    return { kind: "next-round", groups: groupFindings(blocking), deferred: minor };
  }
  if (minor.length === 0) return { kind: "clean", deferred: [] };
  if (atCap || round >= 3) return { kind: "clean", deferred: minor };
  return { kind: "next-round", groups: groupFindings(minor), deferred: [] };
}

/** U3: at most this many characters of an inbox text, then an ellipsis. */
const INBOX_TEXT_LIMIT = 4000;
const DEFAULT_FIX_ROUTE_LINE = "class=implement d=deterministic tier=medium pin";
/**
 * The role agent a default fix task runs as (QA-4.2-11): class `implement` maps to the role KIND `implement`
 * (CLASS_ROLE_KIND) whose agent is `implementer` (ROLES.md), the one holding edit grants. Not the kind name.
 */
export const FIX_ROLE_AGENT = "implementer";

function boundText(s: string): string {
  return s.length > INBOX_TEXT_LIMIT ? `${s.slice(0, INBOX_TEXT_LIMIT)}…` : s;
}

function hasOwn(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

function taskOf(l: Readonly<LedgerV1>, id: TaskId): TaskNode | null {
  return hasOwn(l.tasks, id) ? (l.tasks[id] as TaskNode) : null;
}

function phaseOf(l: Readonly<LedgerV1>, id: PhaseId): PhaseRecord | null {
  return l.phases.find((p) => p.id === id) ?? null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True iff `taskId` is the qa task of round `round` of `phaseId` (QA1). */
function isRoundQaTask(l: Readonly<LedgerV1>, phaseId: PhaseId, round: number, taskId: TaskId): boolean {
  const t = taskOf(l, taskId);
  if (t === null || t.kind !== "qa" || t.phase !== phaseId) return false;
  if (round >= 2) return taskId === reviewTaskId(phaseId, round);
  return !new RegExp(`^${escapeRe(phaseId)}\\.QA\\d+$`).test(taskId);
}

function roundQaTask(l: Readonly<LedgerV1>, phaseId: PhaseId, round: number): TaskNode | null {
  for (const t of Object.values(l.tasks)) if (isRoundQaTask(l, phaseId, round, t.id)) return t;
  return null;
}

const ROOT_TOKEN_RE = /\broot=("[^"]*"|\S+)/;

/** The `root=` token of the first route line of the phase's tasks, else one built from the repo toplevel. */
function phaseRootToken(l: Readonly<LedgerV1>, phaseId: PhaseId): string {
  for (const t of Object.values(l.tasks)) {
    if (t.phase !== phaseId) continue;
    const m = ROOT_TOKEN_RE.exec(t.route.line);
    if (m !== null) return `root=${m[1] as string}`;
  }
  const top = l.repo.toplevel;
  return /\s/.test(top) ? `root="${top}"` : `root=${top}`;
}

/** Separates the previous findings from the original phase review instruction in a re-review task text. */
export const REVIEW_INSTRUCTION_MARKER = "--- original phase review instruction ---";
const REREVIEW_HEAD_RE = /^TASK [^\n]*: re-review phase [^\n]* after the round \d+ fixes\. Previous findings:\n/;

/**
 * The original phase review instruction of a qa task text. A re-review text built by `roundTasks` carries it after
 * `REVIEW_INSTRUCTION_MARKER`; that part is reused so a later round embeds the instruction once, not the whole
 * previous task text (which would grow every round). Any other text is the original instruction itself.
 */
export function originalReviewText(text: string): string {
  if (!REREVIEW_HEAD_RE.test(text)) return text;
  const at = text.indexOf(`\n${REVIEW_INSTRUCTION_MARKER}\n`);
  return at < 0 ? text : text.slice(at + REVIEW_INSTRUCTION_MARKER.length + 2);
}

function bodyJson(findings: readonly Finding[]): string {
  return canonicalFindingsJson({ findings: [...findings] });
}

function findingLine(f: Finding): string {
  return `${f.severity} ${f.id}: ${f.problem} [${f.files.join(", ")}]`;
}

const BLOCKING_SEVERITIES: ReadonlySet<string> = new Set(["blocking", "critical", "major"]);
const OVERFLOW_LIMIT = 999;

export function isBlockingSeverity(s: Finding["severity"]): boolean {
  return BLOCKING_SEVERITIES.has(s);
}

/** `\` to `/`, leading `./` stripped; null for absolute paths, `..` segments or empty paths. */
export function normalizeFindingPath(p: string): string | null {
  let s = p.replace(/\\/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  s = s.replace(/\/{2,}/g, "/");
  if (s.length > 1 && s.endsWith("/")) s = s.replace(/\/+$/, "");
  if (s === "" || s === "." || s.startsWith("/") || /^[A-Za-z]:/.test(s)) return null;
  const segs = s.split("/");
  if (segs.some((x) => x === ".." || x === "" )) return null;
  const kept = segs.filter((x) => x !== ".");
  return kept.length === 0 ? null : kept.join("/");
}

/**
 * Q5: components of findings that share a file; each component is one group with writes = the union of its files
 * (sorted). Components are ordered by their smallest path; findings without a usable file form one extra group with
 * `writes: []` (last). More than 999 file groups: the overflow is merged into the last one.
 */
export function groupFindings(f: readonly Finding[]): Array<{ writes: string[]; findings: Finding[] }> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r) as string;
    let c = x;
    while (parent.get(c) !== r) {
      const next = parent.get(c) as string;
      parent.set(c, r);
      c = next;
    }
    return r;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  };
  const filesOf = (x: Finding): string[] => {
    const out = new Set<string>();
    for (const p of x.files) {
      const n = normalizeFindingPath(p);
      if (n !== null) out.add(n);
    }
    return [...out].sort();
  };
  const withFiles: Array<{ finding: Finding; files: string[] }> = [];
  const fileless: Finding[] = [];
  for (const x of f) {
    const files = filesOf(x);
    if (files.length === 0) {
      fileless.push(x);
      continue;
    }
    withFiles.push({ finding: x, files });
    for (const p of files) if (!parent.has(p)) parent.set(p, p);
    for (let i = 1; i < files.length; i++) union(files[0] as string, files[i] as string);
  }
  // The scheduler serialises tasks whose footprints overlap (case-insensitive, directory prefix): one group, not two.
  const known = [...parent.keys()].sort();
  for (let i = 0; i < known.length; i++) {
    for (let j = i + 1; j < known.length; j++) {
      if (pathsOverlap(known[i] as string, known[j] as string)) union(known[i] as string, known[j] as string);
    }
  }
  const comps = new Map<string, { writes: Set<string>; findings: Finding[] }>();
  for (const { finding, files } of withFiles) {
    const root = find(files[0] as string);
    let c = comps.get(root);
    if (c === undefined) {
      c = { writes: new Set(), findings: [] };
      comps.set(root, c);
    }
    for (const p of files) c.writes.add(p);
    c.findings.push(finding);
  }
  let groups = [...comps.values()]
    .map((c) => ({ writes: [...c.writes].sort(), findings: c.findings }))
    .sort((a, b) => ((a.writes[0] as string) < (b.writes[0] as string) ? -1 : (a.writes[0] as string) > (b.writes[0] as string) ? 1 : 0));
  // The file-less task takes one of the 999 indices of the round, so the file groups leave it room.
  const fileGroupLimit = fileless.length > 0 ? OVERFLOW_LIMIT - 1 : OVERFLOW_LIMIT;
  if (groups.length > fileGroupLimit) {
    const head = groups.slice(0, fileGroupLimit - 1);
    const tail = groups.slice(fileGroupLimit - 1);
    const writes = new Set<string>();
    const findings: Finding[] = [];
    for (const g of tail) {
      for (const w of g.writes) writes.add(w);
      findings.push(...g.findings);
    }
    groups = [...head, { writes: [...writes].sort(), findings }];
  }
  if (fileless.length > 0) groups.push({ writes: [], findings: fileless });
  return groups;
}
