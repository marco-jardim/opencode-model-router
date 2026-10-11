import { createHash } from "node:crypto";
import { splitPlan, structureMask, type PlacedStep } from "../../routing/commands/annotate-plan";
import { fenceMask } from "../../routing/classify/fences";
import { parseRouteLine } from "../../routing/classify/route-line";
import type { RouteLine } from "../../routing/classify/types";
import type { AnnotatedPlan, PlanStep } from "../../routing/engine";
import { parseAcceptanceBlock } from "../../verify/dod";
import { ExecutorError, PHASE_ID_PATTERN, isTaskId, type TaskKind, type Tier } from "../types";
// @@IMPORTS-CHECK

export interface Span { line: number; endLine: number }
export interface CompileIssue { code: string; line: number; message: string }
export interface LabeledList { line: number; text: string; none: boolean }
export type IdSource = "explicit" | "dogfood" | "preflight" | "block" | "hash";

export interface ParsedTask {
  id: string;
  idSource: IdSource;
  phase: string | null;
  kind: TaskKind;
  title: string;
  text: string;
  body: string;
  span: Span;
  subtasks: string[];
  tierTag: Tier | null;
  route: { line: string; fields: RouteLine | null; conflict: boolean } | null;
  verify: "required" | "deferred" | "none" | null;
  cap: number | "none" | null;
  acceptance: string | null;
  writesLine: LabeledList | null;
  readsLine: LabeledList | null;
  manual: boolean;
}

export interface OrderChain { groups: string[][]; line: number; raw: string }

export interface ParsedPhase {
  id: string;
  title: string;
  wave: string;
  span: Span;
  dogfood: boolean;
  synthetic: boolean;
  dependsOn: Array<{ id: string; external: boolean; line: number }>;
  order: OrderChain | null;
  fixTemplate: ParsedTask | null;
  intro: string;
  newTests: string | null;
}

export interface ParsedWave { id: string; title: string; line: number; phases: string[] }
export interface GraphBlock {
  line: number;
  edges: Array<{ from: string; to: string; line: number; raw: string }>;
}
export interface OwnershipRow { path: string; owners: string[]; format: "file-major" | "phase-major"; line: number }
export interface ExplicitPhrase {
  subject: { kind: "task" | "phase" | "wave"; id: string };
  verb: string;
  refs: string[];
  line: number;
  excerpt: string;
}

export interface ParsedPlan {
  waves: ParsedWave[];
  phases: ParsedPhase[];
  tasks: ParsedTask[];
  graphs: GraphBlock[];
  ownership: OwnershipRow[];
  phrases: ExplicitPhrase[];
  sharedContextRaw: string;
  sharedContextSource: "block" | "preamble";
  warnings: CompileIssue[];
}

// ---------------------------------------------------------------------------------------------------------------
// Id grammar (memo §3)

/** Explicit task id: the leading token of a top-level item, after the marker and optional checkbox. */
const EXPLICIT_ID_RE = /^(?:\*\*)?((?:T|P)?\d+(?:\.(?:\d+|[A-Z]{1,4}))+[a-z]?)(?:\*\*)?(?=\s|:|$)/;

/** Pure-tag code spans: a code span whose whole content is `[tier:X]` or `[route …]`. */
const PURE_TAG_SPAN_RE = /(`+)[ \t]*(\[(?:tier:[A-Za-z]+|route(?:[ \t][^\]`]*)?)\])[ \t]*\1/g;

/** Replaces pure-tag code spans (`` `[tier:medium]` ``, `` `[route …]` ``) by their plain text. */
export function unwrapPureTagSpans(line: string): string {
  return line.replace(PURE_TAG_SPAN_RE, "$2");
}

const LIST_MARKER_RE = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+/;
const HEADING_HASH_RE = /^[ \t]*#{1,6}[ \t]+/;
const CHECKBOX_RE = /^\[[ xX]\][ \t]*/;
const TIER_TAG_RE = /\[tier:[A-Za-z]+\]/g;
const ROUTE_TAG_RE = /\[route(?:[ \t][^\]]*)?\]/g;
const VERIFY_TOKEN_RE = /\bVERIFY:[A-Za-z]+\b/g;
const CAP_TOKEN_RE = /\bCAP:(?:\d+|none)\b/g;

/** The stable text an id hash is computed from; annotation tags and markup never change it. */
export function normalizeFirstLine(line: string): string {
  let s = line.replace(/\r?\n[\s\S]*$/, "");
  s = s.replace(HEADING_HASH_RE, "").replace(LIST_MARKER_RE, "").replace(CHECKBOX_RE, "");
  s = unwrapPureTagSpans(s);
  s = s.replace(TIER_TAG_RE, " ").replace(ROUTE_TAG_RE, " ").replace(VERIFY_TOKEN_RE, " ").replace(CAP_TOKEN_RE, " ");
  s = s.replace(/\*\*|__/g, "");
  return s.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

/** `S<8 hex of sha1(normalized first line)>-<ordinal among equal hashes>`; `seen` counts per hash, in plan order. */
export function fallbackTaskId(firstLine: string, seen: Map<string, number>): string {
  const hash = createHash("sha1").update(normalizeFirstLine(firstLine), "utf8").digest("hex").slice(0, 8);
  const n = (seen.get(hash) ?? 0) + 1;
  seen.set(hash, n);
  return `S${hash}-${n}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Errors and small helpers

function compileError(code: string, line: number, message: string): ExecutorError {
  return new ExecutorError("E_COMPILE", `${code} (line ${line}): ${message}`, { code, line });
}

function warn(out: CompileIssue[], code: string, line: number, message: string): void {
  out.push({ code, line, message });
}

// ---------------------------------------------------------------------------------------------------------------
// Headings and block labels (memo §2 steps 2-3)

const LINE_SPLIT_RE = /\r\n|\n|\r/;
const PID = "[A-Za-z0-9]+(?:\\.[A-Za-z0-9]+)*";
const WAVE_HEADING_RE = /^ {0,3}#{2,3}[ \t]+Wave[ \t]+(\d+[A-Za-z]?)\b(.*)$/;
const PHASE_WORD_HEADING_RE = new RegExp(`^ {0,3}#{2,4}[ \\t]+Phase[ \\t]+(${PID})(.*)$`);
const PHASE_P_HEADING_RE = /^ {0,3}#{2,4}[ \t]+(P\d+(?:\.\d+)+)\b(.*)$/;
const DOGFOOD_HEADING_RE = /^ {0,3}#{2,4}[ \t]+Dogfood switch DF-(\d+)\b(.*)$/;
const GENERIC_HEADING_RE = new RegExp(`^ {0,3}#{2,4}[ \\t]+(?:\\*\\*)?(${PID})(?:\\*\\*)?(?=[\\s:.)]|$)(.*)$`);
const ANY_HEADING_RE = /^ {0,3}#{1,6}[ \t]+(.*)$/;
/** `Task`/`Steps` (singular or looser wording) label a task list only when marked (heading or bold), never as plain prose. */
const BLOCK_LABEL_RE =
  /^ {0,3}(?:(?:#{1,6}[ \t]+|\*\*|__)(Task|Steps)(?=(?:\*\*|__)?[ \t]*:?(?:\*\*|__)?[ \t]*$)|(?:#{1,6}[ \t]+|\*\*|__)?(Pre-flight|Tasks|New tests|Acceptance criteria|Definition of Done|QA review|Order)\b)/;

/**
 * Any other bold label at the start of a line (`**Fallback:** …`, `**Goal:** …`) ends a Tasks block: the list under it is
 * not a task list (cpx:3904, the DF-2 fallback steps). `Writes:`/`Reads:` belong to the task above and do not end it.
 */
const OTHER_LABEL_RE = /^ {0,3}(?:\*\*|__)(?!Writes\b|Reads\b)[A-Z][^*_\n]{0,60}?(?::(?:\*\*|__)|(?:\*\*|__):)/;

type BlockName = "pre-flight" | "tasks" | "new-tests" | "acceptance" | "dod" | "qa-review" | "order";

function blockNameOf(label: string): BlockName {
  switch (label) {
    case "Pre-flight": return "pre-flight";
    case "Tasks":
    case "Task":
    case "Steps": return "tasks";
    case "New tests": return "new-tests";
    case "Acceptance criteria": return "acceptance";
    case "Definition of Done": return "dod";
    case "QA review": return "qa-review";
    default: return "order";
  }
}

interface HeadingInfo {
  /** 0-based line index. */
  idx: number;
  /** Markdown heading level (number of `#`). */
  level: number;
  /** Heading text without the hashes. */
  text: string;
  kind: "wave" | "phase" | "dogfood" | "generic" | "other";
  /** Wave id, phase id, `DF<n>` or the id-shaped first token of a generic heading. */
  id: string;
  /** What follows the id on the heading line. */
  rest: string;
}

function headingLevelOf(line: string): number {
  let n = 0;
  let i = 0;
  while (i < line.length && line[i] === " ") i += 1;
  while (line[i] === "#") {
    n += 1;
    i += 1;
  }
  return n;
}

/**
 * `## 3. Waves, phases, tasks`: a bare number with a trailing period labels a document section, not a phase, unless the section holds
 * list items with a task id of its own (`<n>.…`) before the next heading of any level.
 */
function isNumberedSectionHeading(lines: readonly string[], mask: readonly boolean[], idx: number, id: string, rest: string): boolean {
  if (!/^\d+$/.test(id) || !rest.startsWith(".")) return false;
  const own = new RegExp(`^ {0,3}(?:[-*+]|\\d{1,9}[.)])[ \\t]+(?:\\[[ xX]\\][ \\t]+)?(?:\\*\\*|__)?T?${id}\\.`);
  for (let j = idx + 1; j < lines.length; j += 1) {
    if (mask[j] === true) continue;
    const l = lines[j] as string;
    if (ANY_HEADING_RE.test(l)) break;
    if (own.test(l)) return false;
  }
  return true;
}

/** Headings on unmasked lines, classified (memo §2 step 2). */
function scanHeadings(lines: readonly string[], mask: readonly boolean[]): HeadingInfo[] {
  const out: HeadingInfo[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (mask[i] === true) continue;
    const line = lines[i] as string;
    const any = ANY_HEADING_RE.exec(line);
    if (any === null) continue;
    const level = headingLevelOf(line);
    const text = (any[1] as string).replace(/[ \t]+#+[ \t]*$/, "").trim();
    const base = { idx: i, level, text };
    const wave = WAVE_HEADING_RE.exec(line);
    if (wave !== null) {
      out.push({ ...base, kind: "wave", id: wave[1] as string, rest: wave[2] ?? "" });
      continue;
    }
    const df = DOGFOOD_HEADING_RE.exec(line);
    if (df !== null) {
      out.push({ ...base, kind: "dogfood", id: `DF${df[1] as string}`, rest: df[2] ?? "" });
      continue;
    }
    const pw = PHASE_WORD_HEADING_RE.exec(line) ?? PHASE_P_HEADING_RE.exec(line);
    if (pw !== null && level >= 2 && level <= 4) {
      out.push({ ...base, kind: "phase", id: pw[1] as string, rest: pw[2] ?? "" });
      continue;
    }
    const gen = level >= 2 && level <= 4 ? GENERIC_HEADING_RE.exec(line) : null;
    if (gen !== null && !isNumberedSectionHeading(lines, mask, i, gen[1] as string, gen[2] ?? "")) {
      out.push({ ...base, kind: "generic", id: gen[1] as string, rest: gen[2] ?? "" });
      continue;
    }
    out.push({ ...base, kind: "other", id: "", rest: "" });
  }
  return out;
}

/**
 * 1-based line of a top-level fence that is still open at the end of the text and swallows everything after it (the structure mask runs
 * to EOF), else 0. The probe lines let the shared `fenceMask` tell "open at EOF" from "closed": a long closer ends an open fence of its
 * character, so the probe's `x` stays unmasked only when a fence was open.
 */
function unclosedFenceLine(lines: readonly string[], fm: readonly boolean[], mask: readonly boolean[]): number {
  let start = -1;
  for (let i = lines.length - 1; i >= 0 && fm[i] === true; i -= 1) start = i;
  if (start < 0) return 0;
  for (const probe of ["`".repeat(200), "~".repeat(200)]) {
    const m = fenceMask([...lines, probe, "x"]);
    if (m[lines.length + 1] !== true) {
      for (let i = start; i < lines.length; i += 1) if (mask[i] !== true) return 0;
      return start + 1;
    }
  }
  return 0;
}

const ACCEPT_OPEN_RE = /^\s*\[(?:acceptance|dod)\]\s*$/i;
const ACCEPT_CLOSE_RE = /^\s*\[\/(?:acceptance|dod)\]\s*$/i;

/** 1-based line of an `[acceptance]` opener that never closes, else 0. */
function unclosedAcceptanceLine(lines: readonly string[], mask: readonly boolean[]): number {
  let open = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (mask[i] === true) continue;
    const line = lines[i] as string;
    if (open === 0) {
      if (ACCEPT_OPEN_RE.test(line)) open = i + 1;
    } else if (ACCEPT_CLOSE_RE.test(line)) {
      open = 0;
    }
  }
  return open;
}

// ---------------------------------------------------------------------------------------------------------------
// Per-step text (memo §2 step 7)

const ITEM_RE = /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+)\S/;
const ITEM_LEAD_RE = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+/;
const DOGFOOD_ID_RE = /^(?:\*\*)?DF-?(\d+)\.(\d+|QA|FIX)(?:\*\*)?(?=\s|:|$)/i;
const TIER_RE = /\[tier:(fast|medium|heavy)\]/i;
const VERIFY_RE = /\bVERIFY:([A-Za-z]+)\b/;
const CAP_RE = /\bCAP:(\d+|none)\b/;
const INLINE_CODE_RE = /`[^`\n]*`/g;
const WRITES_READS_LABEL_RE = /\b(Writes|Reads)(?:[ \t]*\([^)\n]*\))?(?:\*\*|__)?:(?:\*\*|__)?/g;
const ROUTE_START_LINE_RE = /^\s*\[route\b/;
const NESTED_ITEM_RE = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function columnsOf(ws: string): number {
  let n = 0;
  for (const ch of ws) n += ch === "\t" ? 4 : 1;
  return n;
}

/** Content column of a list item (0 for a heading-run step or an indented line). */
function contentColumn(firstLine: string): number {
  const m = ITEM_RE.exec(firstLine);
  if (m === null) return 0;
  return (m[1] as string).length + (m[2] as string).length + columnsOf(m[3] as string);
}

/** Removes up to `cols` columns of leading whitespace. */
function dedentLine(line: string, cols: number): string {
  let n = 0;
  let i = 0;
  while (i < line.length && n < cols) {
    const ch = line[i];
    if (ch === " ") n += 1;
    else if (ch === "\t") n += 4;
    else break;
    i += 1;
  }
  return line.slice(i);
}

function splitStepLines(text: string): string[] {
  const lines = text.split(LINE_SPLIT_RE);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** The item's lead (what follows the marker/heading hashes and the checkbox) of a step's first line. */
function leadOf(firstLine: string): string {
  return firstLine.replace(HEADING_HASH_RE, "").replace(ITEM_LEAD_RE, "").replace(CHECKBOX_RE, "");
}

function withoutInlineCode(line: string): string {
  return line.replace(INLINE_CODE_RE, " ");
}

function titleOf(firstLine: string, idToken: string | null): string {
  let s = unwrapPureTagSpans(leadOf(firstLine));
  s = s.replace(TIER_TAG_RE, " ").replace(ROUTE_TAG_RE, " ").replace(VERIFY_TOKEN_RE, " ").replace(CAP_TOKEN_RE, " ");
  s = s.replace(/\*\*|__/g, "").replace(/\s+/g, " ").trim();
  if (idToken !== null && s.startsWith(idToken)) s = s.slice(idToken.length).replace(/^[\s:.\-–—]+/, "");
  return s.slice(0, 120).trim();
}

/** Dedented body: fenced lines blanked, pure-tag code spans unwrapped. */
function bodyLinesOf(stepLines: readonly string[]): { body: string[]; fenced: boolean[] } {
  const first = stepLines[0] ?? "";
  const col = contentColumn(first);
  const dedented = stepLines.map((l, i) => (i === 0 ? l : dedentLine(l, col)));
  const fenced = fenceMask(dedented);
  const body = dedented.map((l, i) => (fenced[i] === true ? "" : unwrapPureTagSpans(l)));
  return { body, fenced };
}

/** Raw text of the first `[acceptance]`…`[/acceptance]` pair of non-fenced lines, validated by `parseAcceptanceBlock`. */
function firstAcceptance(body: readonly string[], line: number, out: CompileIssue[]): string | null {
  let open = -1;
  for (let i = 0; i < body.length; i += 1) {
    const l = body[i] as string;
    if (open < 0) {
      if (ACCEPT_OPEN_RE.test(l)) open = i;
    } else if (ACCEPT_CLOSE_RE.test(l)) {
      const raw = body.slice(open, i + 1).join("\n");
      if (parseAcceptanceBlock(raw) === null) warn(out, "acceptance-malformed", line + open, "acceptance block did not parse");
      return raw;
    }
  }
  return null;
}

/** The raw route line parseRouteLine removed from `body` (first line that differs from the stripped text). */
function removedRouteLine(body: string, stripped: string): string | null {
  const a = body.split(LINE_SPLIT_RE);
  const b = stripped.split(LINE_SPLIT_RE);
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return (a[i] as string).trim();
  }
  return null;
}

/** Matcher for the item line of a subtask of `parentId` (`2.3.2.a`), else null. */
function subtaskItemRe(parentId: string | null): RegExp | null {
  if (parentId === null) return null;
  const bare = parentId.replace(/^(?:T|P)(?=\d)/, "");
  return new RegExp(`^[ \\t]*(?:[-*+]|\\d{1,9}[.)])[ \\t]+(?:\\*\\*)?(?:T|P)?${escapeRe(bare)}\\.([a-z])\\b`);
}

interface LabelParse {
  writes: LabeledList | null;
  reads: LabeledList | null;
  subtasks: string[];
}

function mergeLabeled(prev: LabeledList | null, line: number, text: string): LabeledList {
  const trimmed = text.replace(/^(?:\*\*|__)/, "").replace(/\s+/g, " ").trim();
  const none = /^(?:`?none`?|\*\*none\*\*)[.;]?$/i.test(trimmed);
  if (prev === null) return { line, text: trimmed, none };
  return { line: prev.line, text: `${prev.text} ${trimmed}`.trim(), none: prev.none && none };
}

/**
 * `Writes:` / `Reads:` segments and subtask ids of a task body (memo §2 step 7). A segment runs to the other label, a blank line, the next
 * item at the task's indent, an acceptance block, a route line or a subtask item; a label with nothing after it takes the nested items that
 * follow. Several labels of one kind are merged (never dropped). Linear: every line is visited once per segment it belongs to, and a
 * segment never extends over a line another segment started on.
 */
function parseLabels(body: readonly string[], firstLine: number, parentId: string | null, hashItems: boolean): LabelParse {
  const sub = subtaskItemRe(parentId);
  let writes: LabeledList | null = null;
  let reads: LabeledList | null = null;
  const subtasks: string[] = [];
  const inAcceptance: boolean[] = new Array<boolean>(body.length).fill(false);
  let acc = false;
  for (let i = 0; i < body.length; i += 1) {
    const l = body[i] as string;
    if (!acc && ACCEPT_OPEN_RE.test(l)) acc = true;
    inAcceptance[i] = acc;
    if (acc && ACCEPT_CLOSE_RE.test(l)) acc = false;
  }
  const stops = (l: string): boolean =>
    // The body is dedented to the item's content column, so a nested item sits at column 0 here; a sibling item cannot be in a step.
    l.trim() === "" || ACCEPT_OPEN_RE.test(l) || ROUTE_START_LINE_RE.test(l) || (sub !== null && sub.test(l));
  for (let i = 0; i < body.length; i += 1) {
    const l = body[i] as string;
    if (inAcceptance[i] === true) continue;
    if (i > 0) {
      const m = sub?.exec(l) ?? null;
      if (m !== null) subtasks.push(`${parentId ?? ""}.${m[1] as string}`);
      else if (hashItems && NESTED_ITEM_RE.test(l)) {
        const n = normalizeFirstLine(l);
        if (n !== "") subtasks.push(n);
      }
    }
    const labels = [...l.matchAll(WRITES_READS_LABEL_RE)];
    for (let k = 0; k < labels.length; k += 1) {
      const lab = labels[k] as RegExpMatchArray;
      const start = (lab.index ?? 0) + lab[0].length;
      const end = k + 1 < labels.length ? (labels[k + 1]?.index ?? l.length) : l.length;
      let text = l.slice(start, end);
      if (k + 1 === labels.length) {
        for (let j = i + 1; j < body.length; j += 1) {
          const next = body[j] as string;
          if (inAcceptance[j] === true || stops(next) || [...next.matchAll(WRITES_READS_LABEL_RE)].length > 0) break;
          text += ` ${next.trim()}`;
        }
      }
      if (lab[1] === "Writes") writes = mergeLabeled(writes, firstLine + i, text);
      else reads = mergeLabeled(reads, firstLine + i, text);
    }
  }
  return { writes, reads, subtasks };
}

// ---------------------------------------------------------------------------------------------------------------
// `Order:` chains and `Depends on:` lines (memo §2 step 4)

const ORDER_LABEL_RE = /Order(?:\*\*|__)?:(?:\*\*|__)?/;
const ORDER_ID_Y = /(?:\*\*)?((?:T|P)?\d+(?:\.(?:\d+|[A-Z]{1,4}))+[a-z]?)(?:\*\*)?(?=[\s,;:.)∥|→-]|$)/y;
const ORDER_QA_Y = /QA(?![A-Za-z0-9_-])/y;
const ORDER_FIX_Y = /FIX(?:[ \t]*\([ \t]*[A-Za-z-]+[ \t]*\))?(?![A-Za-z0-9_])/y;
const ORDER_WORD_PAREN_Y = /[ \t]*\([ \t]*[A-Za-z-]+[ \t]*\)/y;
const ORDER_ARROW_Y = /[ \t]*(?:→|-->|->)[ \t]*/y;
const ORDER_SEP_Y = /[ \t]*(?:∥|\|\||,)[ \t]*/y;
const ORDER_OPEN_Y = /[ \t]*\([ \t]*/y;
const ORDER_CLOSE_Y = /[ \t]*\)/y;

function stickyAt(re: RegExp, s: string, at: number): RegExpExecArray | null {
  re.lastIndex = at;
  return re.exec(s);
}

/** `chain := group (ARROW group)*`; stops at the first token outside the grammar. QA → `<P>.QA`, FIX → `<P>.FIX`. */
function parseOrderChain(s: string, phaseId: string): string[][] {
  const groups: string[][] = [];
  let i = 0;
  const item = (at: number): { id: string; end: number } | null => {
    const id = stickyAt(ORDER_ID_Y, s, at);
    if (id !== null) {
      const end = at + id[0].length;
      // `6.2.FIX (loop)`: the FIX template spelled as an id keeps its optional parenthetical word.
      const tail = (id[1] as string).endsWith(".FIX") ? stickyAt(ORDER_WORD_PAREN_Y, s, end) : null;
      return { id: id[1] as string, end: tail === null ? end : end + tail[0].length };
    }
    const qa = stickyAt(ORDER_QA_Y, s, at);
    if (qa !== null) return { id: `${phaseId}.QA`, end: at + qa[0].length };
    const fix = stickyAt(ORDER_FIX_Y, s, at);
    if (fix !== null) return { id: `${phaseId}.FIX`, end: at + fix[0].length };
    return null;
  };
  const group = (at: number): { ids: string[]; end: number } | null => {
    const open = stickyAt(ORDER_OPEN_Y, s, at);
    if (open === null) {
      let p = at;
      while (s[p] === " " || s[p] === "\t") p += 1;
      const first = item(p);
      return first === null ? null : { ids: [first.id], end: first.end };
    }
    const ids: string[] = [];
    let pos = at + open[0].length;
    for (;;) {
      while (s[pos] === " " || s[pos] === "\t") pos += 1;
      const it = item(pos);
      if (it === null) return null;
      ids.push(it.id);
      pos = it.end;
      const sep = stickyAt(ORDER_SEP_Y, s, pos);
      if (sep === null) break;
      pos += sep[0].length;
    }
    const close = stickyAt(ORDER_CLOSE_Y, s, pos);
    return close === null ? null : { ids, end: pos + close[0].length };
  };
  for (;;) {
    const g = group(i);
    if (g === null) break;
    groups.push(g.ids);
    i = g.end;
    const arrow = stickyAt(ORDER_ARROW_Y, s, i);
    if (arrow === null) break;
    i += arrow[0].length;
  }
  return groups;
}

/**
 * The `Depends on:` label: at the start of a line (after an optional list marker and bold), or bold anywhere
 * (`**Worktree:** … · **Depends on:** 0.P`). The colon is required, so prose "depends on X" is not a label (D8).
 */
const DEPENDS_LABEL_RE =
  /(?:^[ \t>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?(?:\*\*|__)?|\*\*|__)Depends on(?:\*\*|__)?:(?:\*\*|__)?/i;
const DF_TOKEN_RE = /\bDF-(\d+)\b/g;
const PID_TOKEN_RE = /(?<![A-Za-z0-9.])[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*(?![A-Za-z0-9])/g;
const DOTTED_ID_RE = /^[A-Za-z]?\d+(?:\.[A-Za-z0-9]+)+$/;

/** End of the dependency clause: the next bold label, a middle dot, a sentence end (`. ` / `;`) or a "parallel with"-style phrase. */
const DEPENDS_CLAUSE_END_RE =
  /\*\*[A-Za-z][^*\n]*:\*\*|·|;|\.(?=\s|$)|\b(?:in parallel|parallel with|parallel to|alongside|independent of)\b/i;

/** The part of a `Depends on:` line that names dependencies (cut at the clause end, see DEPENDS_CLAUSE_END_RE). */
function dependsText(line: string): string | null {
  const m = DEPENDS_LABEL_RE.exec(line);
  if (m === null) return null;
  const rest = line.slice(m.index + m[0].length);
  const cut = rest.search(DEPENDS_CLAUSE_END_RE);
  return cut >= 0 ? rest.slice(0, cut) : rest;
}

function resolveDepends(
  text: string,
  line: number,
  selfId: string,
  known: ReadonlySet<string>,
  warnings: CompileIssue[],
): Array<{ id: string; external: boolean; line: number }> {
  const out: Array<{ id: string; external: boolean; line: number }> = [];
  const seen = new Set<string>();
  const add = (id: string, external: boolean): void => {
    if (id === selfId || seen.has(id)) return;
    seen.add(id);
    out.push({ id, external, line });
  };
  const cleaned = text.replace(/§\S+/g, " ").replace(/`/g, " ");
  const dfRemoved = cleaned.replace(DF_TOKEN_RE, (_all, n: string) => {
    // `DF-<n>` is external unless the plan has the `Dogfood switch DF-<n>` section; then it is a phase gate like any other.
    add(`DF${n}`, !known.has(`DF${n}`));
    return " ";
  });
  for (const m of dfRemoved.matchAll(PID_TOKEN_RE)) {
    const tok = m[0];
    if (known.has(tok)) add(tok, false);
    else if (DOTTED_ID_RE.test(tok)) warn(warnings, "depends-unknown", line, `Depends on: unknown id ${tok}`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Graph blocks, ownership tables and explicit phrases (memo §2 step 4)

const ARROW_LINE_RE = /\S\s*(?:->|→|-->)\s*\S/;
const ARROW_SPLIT_RE = /-->|->|→/;
const NODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const GRAPH_KEYWORDS: ReadonlySet<string> = new Set(["graph", "flowchart", "subgraph", "end", "TD", "TB", "BT", "LR", "RL"]);
const FENCE_CLOSER_RE = /^ {0,3}(?:`{3,}|~{3,})[ \t]*$/;

/** Node tokens of one side of an arrow: mermaid labels removed, `A, B` lists supported. */
function nodesOf(part: string): string[] {
  const cleaned = part.replace(/\|[^|\n]*\|/g, " ").replace(/\[[^\]\n]*\]/g, " ").replace(/\([^)\n]*\)/g, " ").replace(/\{[^}\n]*\}/g, " ");
  const out: string[] = [];
  for (const raw of cleaned.split(/[\s,&;]+/)) {
    const tok = raw.replace(/[.-]+$/, "");
    if (tok !== "" && NODE_RE.test(tok) && !GRAPH_KEYWORDS.has(tok)) out.push(tok);
  }
  return out;
}

function graphEdgesOfLine(line: string, lineNo: number): GraphBlock["edges"] {
  const parts = line.split(ARROW_SPLIT_RE).map(nodesOf).filter((p) => p.length > 0);
  const edges: GraphBlock["edges"] = [];
  for (let i = 0; i + 1 < parts.length; i += 1) {
    for (const from of parts[i] as string[]) {
      for (const to of parts[i + 1] as string[]) edges.push({ from, to, line: lineNo, raw: line.trim() });
    }
  }
  return edges;
}

/** Fenced blocks (any info string) with at least one arrow line. */
function scanGraphs(lines: readonly string[], fm: readonly boolean[]): GraphBlock[] {
  const out: GraphBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    if (fm[i] !== true) {
      i += 1;
      continue;
    }
    let end = i;
    while (end + 1 < lines.length && fm[end + 1] === true) end += 1;
    const last = end > i && FENCE_CLOSER_RE.test(lines[end] as string) ? end : end + 1;
    const edges: GraphBlock["edges"] = [];
    let hasArrow = false;
    for (let k = i + 1; k < last; k += 1) {
      const l = lines[k] as string;
      if (!ARROW_LINE_RE.test(l)) continue;
      hasArrow = true;
      edges.push(...graphEdgesOfLine(l, k + 1));
    }
    if (hasArrow) out.push({ line: i + 1, edges });
    i = end + 1;
  }
  return out;
}

const PHRASE_RES: ReadonlyArray<{ verb: string; re: RegExp }> = [
  { verb: "after", re: new RegExp(`\\bafter\\s+(?:Phase\\s+)?(${PID})\\b(?:\\s+(?:is\\s+|are\\s+)?(?:merged|merges|passed|done|lands))?`, "gi") },
  { verb: "before", re: new RegExp(`\\bbefore\\s+(?:Phase\\s+)?(${PID})\\b`, "gi") },
  { verb: "merged-first", re: new RegExp(`\\b(?:Phase\\s+)?(${PID})\\s+(?:(?:is|are|must|be)\\s+)*merged\\s+first\\b`, "gi") },
];
/** Further explicit-dependency phrases (memo §5 pass 3); all carry the `after` semantics (the reference precedes the subject). */
/** Id-shaped token: a dotted id (`2.3.4`, `P2.1`) or a `T`/`P`/`W` letter plus number; bare words and `QA`/`FIX` never match. */
const FULL_ID = "(?:[A-Za-z]{0,2}\\d+(?:\\.[A-Za-z0-9]+)+|[TPWtpw]\\d+)";
const ID_SHAPED_RE = new RegExp(`^${FULL_ID}$`);
const AFTER_LIKE_RES: readonly RegExp[] = [
  new RegExp(`\\bstarts?\\s+after\\s+(?:Phase\\s+)?(${FULL_ID})(?![A-Za-z0-9.]*[A-Za-z0-9])`, "gi"),
  new RegExp(`\\bdepend(?:s|ing)?\\s+on\\s+(?:Phase\\s+)?(${FULL_ID})(?![A-Za-z0-9.]*[A-Za-z0-9])`, "gi"),
  new RegExp(`\\brequires?\\s+(?:Phase\\s+)?(${FULL_ID})(?![A-Za-z0-9.]*[A-Za-z0-9])`, "gi"),
  new RegExp(`\\bblocked\\s+by\\s+(?:Phase\\s+)?(${FULL_ID})(?![A-Za-z0-9.]*[A-Za-z0-9])`, "gi"),
  new RegExp(`\\bonce\\s+(?:Phase\\s+)?(${FULL_ID})\\s+(?:is\\s+|are\\s+|has\\s+been\\s+)?(?:merged|merges|lands|done|passed)\\b`, "gi"),
  new RegExp(`(?<![A-Za-z0-9.])(?:Phase\\s+)?(${FULL_ID})\\s+merges\\b`, "gi"),
  new RegExp(`\\bbuilds?\\s+on\\s+(?:Phase\\s+)?(${FULL_ID})(?![A-Za-z0-9.]*[A-Za-z0-9])`, "gi"),
  new RegExp(`\\bcodes?\\s+against\\s+(?:Phase\\s+)?(${FULL_ID})(?![A-Za-z0-9.]*[A-Za-z0-9])`, "gi"),
  new RegExp(`\\buses?\\s+the\\s+API\\s+from\\s+(?:Phase\\s+)?(${FULL_ID})(?![A-Za-z0-9.]*[A-Za-z0-9])`, "gi"),
];
const MERGED_FIRST_BARE_RE = /\bmerged\s+first\b/i;

const QUOTED_RE = /"[^"\n]*"|“[^”\n]*”/g;
const CLAUSE_SPLIT_RE = /;|\.(?=\s|$)/;
const CLAUSE_MAX = 160;

/** Clauses of one line, bounded by `;`, `. ` and 160 characters; quoted spans are blanked first. */
function clausesOf(text: string): string[] {
  const out: string[] = [];
  for (const part of text.replace(QUOTED_RE, (q) => " ".repeat(q.length)).split(CLAUSE_SPLIT_RE)) {
    for (let i = 0; i < part.length; i += CLAUSE_MAX) out.push(part.slice(i, i + CLAUSE_MAX));
  }
  return out;
}

function scanAfterLike(text: string, line: number, subject: ExplicitPhrase["subject"], out: ExplicitPhrase[]): boolean {
  let any = false;
  for (const clause of clausesOf(text)) {
    for (const re of AFTER_LIKE_RES) {
      for (const m of clause.matchAll(re)) {
        any = true;
        const ref = m[1] as string;
        if (out.some((p) => p.line === line && p.subject.id === subject.id && p.verb === "after" && p.refs[0] === ref)) continue;
        out.push({ subject, verb: "after", refs: [m[1] as string], line, excerpt: m[0].slice(0, 160) });
      }
    }
  }
  return any;
}

function scanPhrases(raw: string, line: number, subject: ExplicitPhrase["subject"], out: ExplicitPhrase[]): void {
  const text = withoutInlineCode(raw);
  let any = scanAfterLike(text, line, subject, out);
  for (const { verb, re } of PHRASE_RES) {
    for (const m of text.matchAll(re)) {
      any = true;
      out.push({ subject, verb, refs: [m[1] as string], line, excerpt: m[0].slice(0, 160) });
    }
  }
  if (!any && MERGED_FIRST_BARE_RE.test(text)) {
    out.push({ subject, verb: "merged-first", refs: [], line, excerpt: text.trim().slice(0, 160) });
  }
}

function splitCells(row: string): string[] {
  let s = row.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

const TABLE_ROW_RE = /^ {0,3}\|/;
const TABLE_SEP_RE = /^[\s|:-]*-[\s|:-]*$/;
const BACKTICK_SPAN_RE = /`([^`\n]+)`/g;

function pathLike(s: string): boolean {
  return /[\\/]/.test(s) || /\.[A-Za-z0-9]{1,8}$/.test(s);
}

function phaseTokens(cell: string, known: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const m of cell.replace(/`/g, " ").matchAll(PID_TOKEN_RE)) if (known.has(m[0]) && !out.includes(m[0])) out.push(m[0]);
  return out;
}

/** Ownership tables, file-major and phase-major; phrases inside phase-major cells become phrases about that phase. */
function scanTables(
  lines: readonly string[],
  mask: readonly boolean[],
  known: ReadonlySet<string>,
  rows: OwnershipRow[],
  phrases: ExplicitPhrase[],
): void {
  let i = 0;
  while (i < lines.length) {
    if (mask[i] === true || !TABLE_ROW_RE.test(lines[i] as string)) {
      i += 1;
      continue;
    }
    let end = i;
    while (end + 1 < lines.length && mask[end + 1] !== true && TABLE_ROW_RE.test(lines[end + 1] as string)) end += 1;
    const header = splitCells(lines[i] as string);
    const hasSep = end > i && TABLE_SEP_RE.test(lines[i + 1] as string);
    const first = (header[0] ?? "").replace(/[`*_]/g, "").trim();
    const fileMajor = /^(?:File|Path)s?$/i.test(first);
    // An ownership table with named columns (`| Wave | Phase | Owns (writes) |`): the phase and the owned-paths column by header.
    const names = header.map((h) => h.replace(/[`*_]/g, "").trim());
    const namedPhase = names.findIndex((h) => /^Phases?$/i.test(h));
    const namedOwns = names.findIndex((h, c) => c !== namedPhase && /^(?:Owns|Writes)\b/i.test(h));
    const named = !fileMajor && namedPhase >= 0 && namedOwns >= 0;
    const phaseCol = named ? namedPhase : 0;
    const ownsCol = named ? namedOwns : -1;
    for (let r = hasSep ? i + 2 : i + 1; r <= end; r += 1) {
      const cells = splitCells(lines[r] as string);
      const c1 = cells[0] ?? "";
      if (fileMajor) {
        const span = /`([^`\n]+)`/.exec(c1);
        const path = (span?.[1] ?? c1.replace(/[*_]/g, "")).trim();
        if (path === "") continue;
        const owners: string[] = [];
        for (let c = 1; c < cells.length; c += 1) {
          const cell = cells[c] as string;
          const ids = phaseTokens(cell, known);
          const fromHeader = ids.length === 0 && /[^\s\-—–]/.test(cell.replace(/[`*_]/g, "")) && !/^(?:no|none|n\/a)$/i.test(cell.trim());
          for (const id of fromHeader ? phaseTokens(header[c] ?? "", known) : ids) if (!owners.includes(id)) owners.push(id);
        }
        rows.push({ path, owners, format: "file-major", line: r + 1 });
        continue;
      }
      const owner = phaseTokens(cells[phaseCol] ?? "", known)[0];
      if (owner === undefined || cells.length < 2) continue;
      const own = cells.slice(phaseCol + 1);
      const c2 = (ownsCol >= 0 ? cells[ownsCol] : own[0]) ?? "";
      for (const m of c2.matchAll(BACKTICK_SPAN_RE)) {
        const p = (m[1] as string).trim();
        if (pathLike(p)) rows.push({ path: p, owners: [owner], format: "phase-major", line: r + 1 });
      }
      scanPhrases(own.join(" | "), r + 1, { kind: "phase", id: owner }, phrases);
    }
    i = end + 1;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// One task's annotations (memo §2 step 7)

interface StepAnno {
  body: string;
  bodyLines: string[];
  tierTag: Tier | null;
  route: ParsedTask["route"];
  verify: ParsedTask["verify"];
  cap: ParsedTask["cap"];
  acceptance: string | null;
  writesLine: LabeledList | null;
  readsLine: LabeledList | null;
  subtasks: string[];
}

function isTier(v: unknown): v is Tier {
  return v === "fast" || v === "medium" || v === "heavy";
}

function annotateText(text: string, line: number, parentId: string | null, hashItems: boolean, warnings: CompileIssue[]): StepAnno {
  const { body: bodyLines } = bodyLinesOf(splitStepLines(text));
  const body = bodyLines.join("\n");
  const firstClean = withoutInlineCode(bodyLines[0] ?? "");

  let tierTag: Tier | null = null;
  for (let i = 0; i < bodyLines.length && tierTag === null; i += 1) {
    const l = bodyLines[i] as string;
    if (i > 0 && NESTED_ITEM_RE.test(l)) continue;
    const m = TIER_RE.exec(withoutInlineCode(l));
    if (m !== null) tierTag = (m[1] as string).toLowerCase() as Tier;
  }

  let route: ParsedTask["route"] = null;
  const parsed = parseRouteLine(body, { positions: "any" });
  if (parsed.line !== null) {
    route = { line: removedRouteLine(body, parsed.stripped) ?? "", fields: parsed.line, conflict: parsed.conflict };
    if (parsed.conflict) warn(warnings, "route-conflict", line, "step has conflicting route lines");
  } else if (parsed.malformed === true) {
    warn(warnings, "route-malformed", line, "first route line is malformed");
  }
  if (tierTag === null && route !== null && route.fields !== null && isTier(route.fields.tier)) tierTag = route.fields.tier;

  let verify: ParsedTask["verify"] = null;
  const vm = VERIFY_RE.exec(firstClean);
  if (vm !== null) {
    const w = vm[1] as string;
    if (w === "required" || w === "deferred" || w === "none") verify = w;
    else warn(warnings, "verify-unknown", line, `unknown VERIFY value ${w}`);
  }
  let cap: ParsedTask["cap"] = null;
  const cm = CAP_RE.exec(firstClean);
  if (cm !== null) cap = cm[1] === "none" ? "none" : Number(cm[1]);

  const acceptance = firstAcceptance(bodyLines, line, warnings);
  const labels = parseLabels(bodyLines, line, parentId, hashItems);
  return {
    body,
    bodyLines,
    tierTag,
    route,
    verify,
    cap,
    acceptance,
    writesLine: labels.writes,
    readsLine: labels.reads,
    subtasks: labels.subtasks,
  };
}

function onlyTestWrites(w: LabeledList | null): boolean {
  if (w === null || w.none) return false;
  const paths: string[] = [];
  for (const m of w.text.matchAll(BACKTICK_SPAN_RE)) if (pathLike((m[1] as string).trim())) paths.push((m[1] as string).trim());
  return paths.length > 0 && paths.every((p) => /^(?:\.\/)?test\//i.test(p.replace(/\\/g, "/")) || /\.(?:test|spec)\./i.test(p));
}

const MANUAL_TITLE_RE = /^(?:Orchestrator|Planned human action)/i;
const TESTS_TITLE_RE = /^(?:New tests|Tests)\b/i;
const META_LEAD_RE = /^(?:\*\*|__)?(Depends on|Worktree|Goal)\b/i;
const QA_LEAD_RE = /^(?:\*\*|__)?QA\b(?![-\w])/;

// ---------------------------------------------------------------------------------------------------------------
// parsePlan (memo §2)

interface PhaseDraft {
  phase: ParsedPhase;
  level: number;
  /** 0-based heading line, and the exclusive 0-based end of the section. */
  head: number;
  end: number;
  hasIds: boolean;
  hasLabels: boolean;
  hasTasksBlock: boolean;
  dependsTexts: Array<{ text: string; line: number }>;
  pfCount: number;
  dfOrdinal: number;
}

interface BlockSpan { draft: PhaseDraft; name: BlockName; start: number; end: number }

interface StepInfo {
  step: PlacedStep;
  /** Exclusive 0-based end line of the step. */
  endIdx: number;
  lead: string;
  ex: RegExpExecArray | null;
  df: RegExpExecArray | null;
}

const HEADING_START_RE = /^ {0,3}#{1,6}[ \t]/;
const RESERVED_AUTHORED_RE = /^(.+)\.(?:QA\d+|FIX\d+-\d+)$/;
const PLAN_CONTEXT_OPEN_RE = /^\s*<!--\s*plan-context\s*-->\s*$/;
const PLAN_CONTEXT_CLOSE_RE = /^\s*<!--\s*\/plan-context\s*-->\s*$/;

/** `T`/`P` prefixes are not part of the identity of a phase or task id prefix. */
function bareId(id: string): string {
  return id.replace(/^(?:T|P)(?=\d)/, "");
}

function trimmedEnd(lines: readonly string[], start: number, end: number): number {
  let e = end;
  while (e > start + 1 && (lines[e - 1] as string).trim() === "") e -= 1;
  return e;
}

function dedentJoin(lines: readonly string[], start: number, end: number): string {
  return lines.slice(start, end).join("\n");
}

export function parsePlan(text: string): ParsedPlan {
  const warnings: CompileIssue[] = [];
  const lines = text.split(LINE_SPLIT_RE);
  const mask = structureMask(lines);
  const fm = fenceMask(lines);

  const openFence = unclosedFenceLine(lines, fm, mask);
  if (openFence > 0) throw compileError("fence-unclosed", openFence, "a fenced block is never closed and would hide the rest of the plan");
  const openAcceptance = unclosedAcceptanceLine(lines, mask);
  if (openAcceptance > 0) throw compileError("acceptance-unclosed", openAcceptance, "[acceptance] has no matching [/acceptance]");

  // --- steps (step 5) ------------------------------------------------------------------------------------------
  const steps = splitPlan(text);
  const headingRun = steps.length > 0 && steps.every((s) => HEADING_START_RE.test(lines[s.line - 1] ?? ""));
  const inStep: boolean[] = new Array<boolean>(lines.length).fill(false);
  const infos: StepInfo[] = steps.map((step) => {
    const endIdx = Math.min(lines.length, step.line - 1 + splitStepLines(step.text).length);
    for (let i = step.line - 1; i < endIdx; i += 1) inStep[i] = true;
    const lead = leadOf(lines[step.line - 1] ?? "");
    return { step, endIdx, lead, ex: EXPLICIT_ID_RE.exec(lead), df: DOGFOOD_ID_RE.exec(lead) };
  });
  const explicitTasks: Array<{ idx: number; id: string }> = [];
  for (const info of infos) {
    if (info.ex !== null) explicitTasks.push({ idx: info.step.line - 1, id: bareId(info.ex[1] as string) });
  }

  // --- headings, waves, phases (step 2) ----------------------------------------------------------------------
  const scanned = scanHeadings(lines, mask);
  /** An id-shaped heading is confirmed only by explicit task ids inside its own section. */
  const confirmedByChildren = (hi: number): boolean => {
    const h = scanned[hi] as HeadingInfo;
    let end = lines.length;
    for (let j = hi + 1; j < scanned.length; j += 1) {
      if ((scanned[j] as HeadingInfo).level <= h.level) {
        end = (scanned[j] as HeadingInfo).idx;
        break;
      }
    }
    const prefix = `${bareId(h.id)}.`;
    return explicitTasks.some((t) => t.idx > h.idx && t.idx < end && t.id.startsWith(prefix));
  };
  const headings = scanned.map((h, hi): HeadingInfo => {
    if (headingRun) return { ...h, kind: "other" };
    if (h.kind === "generic" && !confirmedByChildren(hi)) return { ...h, kind: "other" };
    return h;
  });

  const waves: ParsedWave[] = [];
  const waveById = new Map<string, ParsedWave>();
  const drafts: PhaseDraft[] = [];
  const draftById = new Map<string, PhaseDraft>();
  const graphs: GraphBlock[] = [];
  const phrases: ExplicitPhrase[] = [];
  const allPhases: ParsedPhase[] = [];
  const phaseById = new Map<string, ParsedPhase>();

  const addWave = (id: string, title: string, line: number): ParsedWave => {
    const w: ParsedWave = { id, title, line, phases: [] };
    waves.push(w);
    waveById.set(id, w);
    return w;
  };
  const addPhase = (p: ParsedPhase): void => {
    if (!PHASE_ID_PATTERN.test(p.id)) throw compileError("phase-id-invalid", p.span.line, `invalid phase id ${p.id}`);
    if (phaseById.has(p.id)) throw compileError("phase-duplicate", p.span.line, `duplicate phase ${p.id}`);
    phaseById.set(p.id, p);
    allPhases.push(p);
  };
  const newPhase = (id: string, title: string, wave: string, line: number, endLine: number, dogfood: boolean, synthetic: boolean): ParsedPhase => ({
    id, title, wave, span: { line, endLine }, dogfood, synthetic, dependsOn: [], order: null, fixTemplate: null, intro: "", newTests: null,
  });

  let curWave: { w: ParsedWave; level: number } | null = null;
  const syntheticWaves = new Set<ParsedWave>();
  let curDraft: PhaseDraft | null = null;
  const closePhase = (idx: number): void => {
    if (curDraft !== null) curDraft.end = idx;
    curDraft = null;
  };
  for (const h of headings) {
    if (h.kind === "wave") {
      closePhase(h.idx);
      const clash = waveById.get(h.id);
      if (clash !== undefined && syntheticWaves.has(clash)) {
        // A synthetic wave never stands for a real `Wave N` heading: move it aside (it keeps its place in plan order).
        let moved = `${h.id}.w`;
        while (waveById.has(moved)) moved += "w";
        waveById.delete(h.id);
        for (const p of allPhases) if (p.wave === clash.id) p.wave = moved;
        clash.id = moved;
        waveById.set(moved, clash);
      }
      const existing = waveById.get(h.id);
      if (existing !== undefined) warn(warnings, "wave-duplicate", h.idx + 1, `duplicate wave ${h.id}`);
      const w = existing ?? addWave(h.id, h.text, h.idx + 1);
      curWave = { w, level: h.level };
      const paren = /\(([^)\n]*(?:→|->|-->)[^)\n]*)\)/.exec(h.rest);
      if (paren !== null) {
        const parts = (paren[1] as string).split(ARROW_SPLIT_RE).map((part) => [...part.matchAll(PID_TOKEN_RE)].map((m) => m[0]).filter((t) => /\d/.test(t)));
        const edges: GraphBlock["edges"] = [];
        for (let i = 0; i + 1 < parts.length; i += 1) {
          for (const from of parts[i] as string[]) for (const to of parts[i + 1] as string[]) edges.push({ from, to, line: h.idx + 1, raw: h.text });
        }
        if (edges.length > 0) graphs.push({ line: h.idx + 1, edges });
      }
      scanPhrases(h.rest, h.idx + 1, { kind: "wave", id: h.id }, phrases);
      continue;
    }
    if (h.kind === "phase" || h.kind === "dogfood" || h.kind === "generic") {
      closePhase(h.idx);
      let waveId: string;
      if (curWave !== null && h.level > curWave.level) {
        waveId = curWave.w.id;
      } else {
        curWave = null;
        waveId = h.id;
        while (waveById.has(waveId)) waveId = `${waveId}.w`;
        syntheticWaves.add(addWave(waveId, h.text, h.idx + 1));
      }
      const phase = newPhase(h.id, h.text, waveId, h.idx + 1, h.idx + 1, h.kind === "dogfood", false);
      addPhase(phase);
      const draft: PhaseDraft = {
        phase, level: h.level, head: h.idx, end: lines.length, hasIds: false, hasLabels: false, hasTasksBlock: false,
        dependsTexts: [], pfCount: 0, dfOrdinal: 0,
      };
      drafts.push(draft);
      draftById.set(h.id, draft);
      curDraft = draft;
      continue;
    }
    if (curDraft !== null && h.level <= (curDraft as PhaseDraft).level) closePhase(h.idx);
    if (curWave !== null && h.level <= curWave.level) curWave = null;
  }
  closePhase(lines.length);
  for (const d of drafts) d.phase.span = { line: d.head + 1, endLine: d.end };

  const phaseAt: number[] = new Array<number>(lines.length).fill(-1);
  drafts.forEach((d, di) => {
    for (let i = d.head; i < d.end; i += 1) phaseAt[i] = di;
  });
  for (const info of infos) {
    const di = phaseAt[info.step.line - 1] as number;
    if (di >= 0 && (info.ex !== null || info.df !== null)) (drafts[di] as PhaseDraft).hasIds = true;
  }

  // --- block labels (step 3) ---------------------------------------------------------------------------------
  const blockAt: Array<BlockName | null> = new Array<BlockName | null>(lines.length).fill(null);
  const blocks: BlockSpan[] = [];
  for (const d of drafts) {
    let cur: BlockSpan | null = null;
    const close = (end: number): void => {
      if (cur !== null) {
        cur.end = trimmedEnd(lines, cur.start, end);
        blocks.push(cur);
      }
      cur = null;
    };
    for (let i = d.head + 1; i < d.end; i += 1) {
      const l = lines[i] as string;
      if (mask[i] !== true && !(inStep[i] === true && columnsOf(/^[ \t]*/.exec(l)?.[0] ?? "") > 0)) {
        const m = BLOCK_LABEL_RE.exec(l);
        if (m !== null) {
          close(i);
          const name = blockNameOf((m[1] ?? m[2]) as string);
          cur = { draft: d, name, start: i, end: i + 1 };
          d.hasLabels = true;
          if (name === "tasks") d.hasTasksBlock = true;
        } else if (cur !== null && (cur as BlockSpan).name === "tasks" && OTHER_LABEL_RE.test(l)) {
          close(i);
        }
      }
      blockAt[i] = cur === null ? null : (cur as BlockSpan).name;
    }
    close(d.end);
  }

  // --- phase prose: Depends on, intro, phrases (step 4) --------------------------------------------------------
  for (const d of drafts) {
    let firstContent = d.end;
    for (const info of infos) {
      const idx = info.step.line - 1;
      if (idx > d.head && idx < d.end && idx < firstContent) firstContent = idx;
    }
    for (const b of blocks) if (b.draft === d && b.start < firstContent) firstContent = b.start;
    d.phase.intro = lines.slice(d.head + 1, firstContent).join("\n").trim();
    for (let i = d.head + 1; i < d.end; i += 1) {
      if (mask[i] === true || inStep[i] === true || ANY_HEADING_RE.test(lines[i] as string)) continue;
      const l = lines[i] as string;
      const dep = dependsText(l);
      if (dep !== null) {
        let t = dep;
        for (let j = i + 1; j < d.end && (lines[j] as string).trim() !== "" && mask[j] !== true && !ITEM_RE.test(lines[j] as string) &&
          !ANY_HEADING_RE.test(lines[j] as string) && !BLOCK_LABEL_RE.test(lines[j] as string); j += 1) {
          t += ` ${lines[j] as string}`;
        }
        d.dependsTexts.push({ text: t, line: i + 1 });
        continue;
      }
      if (blockAt[i] === "order") continue;
      scanPhrases(l, i + 1, { kind: "phase", id: d.phase.id }, phrases);
    }
  }

  // --- tasks (steps 5-7) ---------------------------------------------------------------------------------------
  const tasks: ParsedTask[] = [];
  const taskById = new Map<string, ParsedTask>();
  /** Id index while tasks are still being collected (duplicates are reported later, from the full list). */
  const early = new Map<string, ParsedTask>();
  const implicit = new Map<string, ParsedPhase>();
  const seenHash = new Map<string, number>();
  const hasHeadingPhases = drafts.length > 0;

  const ensureImplicit = (id: string, line: number): ParsedPhase => {
    const known = phaseById.get(id);
    if (known !== undefined) {
      known.span = { line: Math.min(known.span.line, line), endLine: Math.max(known.span.endLine, line) };
      return known;
    }
    let waveId = id;
    if (waveById.has(waveId)) waveId = `${id}.w`;
    addWave(waveId, id, line);
    const p = newPhase(id, id, waveId, line, line, false, true);
    addPhase(p);
    implicit.set(id, p);
    return p;
  };

  const build = (a: {
    id: string; idSource: IdSource; phase: string; text: string; line: number; endLine: number; idToken: string | null;
    title?: string; hashItems: boolean; dogfood: boolean; forceKind?: TaskKind;
  }): ParsedTask => {
    const anno = annotateText(a.text, a.line, a.hashItems ? null : a.id, a.hashItems, warnings);
    const first = splitStepLines(a.text)[0] ?? "";
    const title = a.title ?? titleOf(first, a.idToken === null ? null : a.idToken.replace(/\*\*|__/g, ""));
    let kind: TaskKind;
    if (a.forceKind !== undefined) kind = a.forceKind;
    else if (a.id.endsWith(".FIX")) kind = "fix";
    else if (a.id.endsWith(".QA")) kind = "qa";
    else if (a.dogfood || (anno.route === null && MANUAL_TITLE_RE.test(title))) kind = "manual";
    else if (TESTS_TITLE_RE.test(title) || onlyTestWrites(anno.writesLine)) kind = "tests";
    else kind = "task";
    return {
      id: a.id, idSource: a.idSource, phase: a.phase, kind, title, text: a.text, body: anno.body,
      span: { line: a.line, endLine: a.endLine }, subtasks: anno.subtasks, tierTag: anno.tierTag, route: anno.route,
      verify: anno.verify, cap: anno.cap, acceptance: anno.acceptance, writesLine: anno.writesLine, readsLine: anno.readsLine,
      manual: kind === "manual" || kind === "preflight" || a.dogfood,
    };
  };
  const addTask = (t: ParsedTask, owner: ParsedPhase): void => {
    if (t.kind === "fix") {
      if (owner.fixTemplate === null) owner.fixTemplate = t;
      else warn(warnings, "fix-template-duplicate", t.span.line, `second FIX template for phase ${owner.id}`);
      return;
    }
    tasks.push(t);
    early.set(t.id, t);
  };

  for (const info of infos) {
    const { step } = info;
    const idx = step.line - 1;
    const di = phaseAt[idx] as number;
    const d = di >= 0 ? (drafts[di] as PhaseDraft) : undefined;
    const block = d === undefined ? null : blockAt[idx] ?? null;
    const base = { text: step.text, line: step.line, endLine: info.endIdx };

    if (info.ex === null && info.df === null && META_LEAD_RE.test(info.lead)) {
      const dep = d !== undefined && /^(?:\*\*|__)?Depends on/i.test(info.lead) ? dependsText(lines.slice(idx, info.endIdx).join(" ")) : null;
      if (d !== undefined && dep !== null) d.dependsTexts.push({ text: dep, line: step.line });
      continue;
    }

    // A DF section's items outside the Tasks block (Worktrees, Acceptance, DoD lists) are not tasks unless they carry a DF id.
    if (d !== undefined && d.phase.dogfood && (block === "acceptance" || block === "dod" || (block === null && d.hasLabels && info.df === null))) continue;

    if (d !== undefined && d.phase.dogfood && block !== "pre-flight") {
      d.dfOrdinal += 1;
      const n = d.phase.id.slice(2);
      let id: string;
      if (info.df !== null) id = `DF${info.df[1] as string}.${(info.df[2] as string).toUpperCase()}`;
      else if (QA_LEAD_RE.test(info.lead)) id = `DF${n}.QA`;
      else id = `DF${n}.${d.dfOrdinal}`;
      addTask(build({ ...base, id, idSource: "dogfood", phase: d.phase.id, idToken: info.df === null ? null : info.df[0], hashItems: info.df === null, dogfood: true }), d.phase);
      continue;
    }

    if (d !== undefined && block === "pre-flight") {
      d.pfCount += 1;
      addTask(build({ ...base, id: `${d.phase.id}.PF${d.pfCount}`, idSource: "preflight", phase: d.phase.id, idToken: info.ex === null ? null : info.ex[0], hashItems: true, dogfood: false, forceKind: "preflight" }), d.phase);
      continue;
    }
    if (d !== undefined && (block === "new-tests" || block === "acceptance" || block === "dod" || block === "order" || block === "qa-review")) continue;

    const first = lines[idx] as string;
    const token = /^(?:\*\*|__)?([A-Za-z0-9][A-Za-z0-9.-]*)/.exec(info.lead)?.[1] ?? "";
    const reserved = RESERVED_AUTHORED_RE.exec(token);
    if (reserved !== null && (d === undefined || bareId(reserved[1] as string) === bareId(d.phase.id))) {
      throw compileError("id-reserved", step.line, `id ${token} is reserved for the QA loop`);
    }

    if (info.ex !== null) {
      const id = info.ex[1] as string;
      const prefix = bareId(id).split(".").slice(0, -1).join(".");
      let owner: ParsedPhase;
      if (d !== undefined) {
        owner = d.phase;
        if (bareId(d.phase.id) !== prefix) warn(warnings, "id-phase-mismatch", step.line, `id ${id} sits in phase ${d.phase.id}`);
      } else if (phaseById.has(id)) {
        // `- **0.P** …` outside every phase names a phase (a summary list), not a task of an implicit phase `0`.
        warn(warnings, "item-outside-phase", step.line, `list item ${id} outside any phase names a phase; not a task`);
        continue;
      } else {
        owner = ensureImplicit(prefix, step.line);
      }
      addTask(build({ ...base, id, idSource: "explicit", phase: owner.id, idToken: info.ex[0], hashItems: false, dogfood: false }), owner);
      continue;
    }

    // An item without an id.
    let owner: ParsedPhase | null = null;
    if (d !== undefined) {
      if (block === "tasks" || (block === null && !d.hasLabels)) {
        owner = d.phase;
        if (d.hasIds) warn(warnings, "id-less-item", step.line, "item without a task id in a phase that has ids");
      } else {
        warn(warnings, "intro-item-ignored", step.line, "list item outside the Tasks block is not a task");
      }
    } else if (!hasHeadingPhases) {
      owner = ensureImplicit("main", step.line);
    } else {
      warn(warnings, "item-outside-phase", step.line, "list item outside any phase is not a task");
    }
    if (owner === null) continue;
    addTask(build({ ...base, id: fallbackTaskId(first, seenHash), idSource: "hash", phase: owner.id, idToken: null, hashItems: true, dogfood: false }), owner);
  }

  // --- QA review and New tests blocks (step 6) -----------------------------------------------------------------
  for (const b of blocks) {
    const p = b.draft.phase;
    if (b.name === "new-tests") {
      const t = dedentJoin(lines, b.start, b.end);
      p.newTests = p.newTests === null ? t : `${p.newTests}\n${t}`;
      if (!b.draft.hasIds && !early.has(`${p.id}.TESTS`)) {
        addTask(build({ text: t, line: b.start + 1, endLine: b.end, id: `${p.id}.TESTS`, idSource: "block", phase: p.id, idToken: null, title: "New tests", hashItems: true, dogfood: false, forceKind: "tests" }), p);
      }
    } else if (b.name === "qa-review" && !p.dogfood) {
      const t = dedentJoin(lines, b.start, b.end);
      const qaId = `${p.id}.QA`;
      const existing = early.get(qaId);
      const made = build({ text: t, line: b.start + 1, endLine: b.end, id: qaId, idSource: "block", phase: p.id, idToken: null, title: "QA review", hashItems: true, dogfood: false, forceKind: "qa" });
      if (existing === undefined) {
        addTask(made, p);
      } else {
        existing.text = `${existing.text}\n${t}`;
        existing.body = `${existing.body}\n${made.body}`;
        existing.span = { line: existing.span.line, endLine: Math.max(existing.span.endLine, b.end) };
        existing.acceptance = existing.acceptance ?? made.acceptance;
        existing.writesLine = existing.writesLine ?? made.writesLine;
        existing.readsLine = existing.readsLine ?? made.readsLine;
        existing.tierTag = existing.tierTag ?? made.tierTag;
        existing.route = existing.route ?? made.route;
        existing.verify = existing.verify ?? made.verify;
        existing.cap = existing.cap ?? made.cap;
      }
    }
  }
  tasks.sort((a, b) => a.span.line - b.span.line);

  // --- ids: validity, reservation, uniqueness (§3) -------------------------------------------------------------
  const folded = new Map<string, string>();
  const templates = allPhases.flatMap((p) => (p.fixTemplate === null ? [] : [p.fixTemplate]));
  for (const t of [...tasks, ...templates]) {
    if (!isTaskId(t.id)) throw compileError("id-invalid", t.span.line, `invalid task id ${t.id}`);
    const key = t.id.toLowerCase();
    const prior = folded.get(key);
    if (prior !== undefined) throw compileError("id-duplicate", t.span.line, `duplicate task id ${t.id}${prior === t.id ? "" : ` (also ${prior})`}`);
    folded.set(key, t.id);
    taskById.set(t.id, t);
  }

  // --- Order chains, D3 post-QA phases ---------------------------------------------------------------------
  for (const b of blocks) {
    if (b.name !== "order" || b.draft.phase.order !== null) continue;
    const p = b.draft.phase;
    const joined = lines.slice(b.start, b.end).join(" ");
    const lab = ORDER_LABEL_RE.exec(joined);
    if (lab === null) continue;
    const groups = parseOrderChain(joined.slice(lab.index + lab[0].length), p.id);
    if (groups.length === 0) continue;
    for (const g of groups) {
      for (const id of g) {
        if (id === `${p.id}.QA` || id === `${p.id}.FIX`) continue;
        if (!taskById.has(id)) throw compileError("order-unknown-id", b.start + 1, `Order: names unknown task ${id}`);
      }
    }
    p.order = { groups, line: b.start + 1, raw: (lines[b.start] as string).trim() };
    const qaAt = groups.findIndex((g) => g.includes(`${p.id}.QA`));
    if (qaAt < 0) continue;
    const later = new Set(groups.slice(qaAt + 1).flat());
    const moved = tasks.filter((t) => t.phase === p.id && later.has(t.id));
    if (moved.length === 0) continue;
    const post = newPhase(`${p.id}.post`, `${p.title} (after QA)`, p.wave, p.span.line, p.span.endLine, false, true);
    post.dependsOn = [{ id: p.id, external: false, line: b.start + 1 }];
    addPhase(post);
    for (const t of moved) t.phase = post.id;
    warn(warnings, "post-qa-phase", b.start + 1, `${moved.length} task(s) after QA in ${p.id} moved to phase ${post.id}`);
  }

  // --- finish phases, waves, dependencies ----------------------------------------------------------------------
  const sortedPhases = [...allPhases].sort((a, b) => a.span.line - b.span.line || Number(a.id.endsWith(".post")) - Number(b.id.endsWith(".post")));
  const knownPhaseIds: ReadonlySet<string> = new Set(sortedPhases.map((p) => p.id));
  for (const d of drafts) {
    for (const dep of d.dependsTexts) {
      for (const r of resolveDepends(dep.text, dep.line, d.phase.id, knownPhaseIds, warnings)) {
        if (!d.phase.dependsOn.some((x) => x.id === r.id)) d.phase.dependsOn.push(r);
      }
    }
  }
  const sortedWaves = [...waves].sort((a, b) => a.line - b.line);
  for (const w of sortedWaves) w.phases = sortedPhases.filter((p) => p.wave === w.id).map((p) => p.id);

  // --- ownership, graphs, phrases ----------------------------------------------------------------------------------
  const ownership: OwnershipRow[] = [];
  scanTables(lines, mask, knownPhaseIds, ownership, phrases);
  graphs.push(...scanGraphs(lines, fm));
  graphs.sort((a, b) => a.line - b.line);
  const knownNodes = new Set<string>([...knownPhaseIds, ...taskById.keys(), ...waveById.keys()]);
  for (const g of graphs) {
    const unknown = new Set<string>();
    for (const e of g.edges) for (const n of [e.from, e.to]) if (!knownNodes.has(n)) unknown.add(n);
    for (const n of unknown) warn(warnings, "graph-node-unknown", g.line, `graph node ${n} is not a known phase, task or wave`);
  }
  for (const t of tasks) {
    const bodyLines = t.body.split(LINE_SPLIT_RE);
    for (let k = 0; k < bodyLines.length; k += 1) {
      const l = bodyLines[k] as string;
      if (DEPENDS_LABEL_RE.test(l)) continue;
      scanPhrases(l, t.span.line + k, { kind: "task", id: t.id }, phrases);
    }
  }
  const knownRefs = new Set<string>([...knownNodes]);
  const warnedRefs = new Set<string>();
  for (const p of phrases) {
    for (const r of p.refs) {
      if (knownRefs.has(r) || !ID_SHAPED_RE.test(r) || warnedRefs.has(`${p.line}:${r}`)) continue;
      warnedRefs.add(`${p.line}:${r}`);
      warn(warnings, "explicit-ref-unknown", p.line, `unknown reference ${r}: ${p.excerpt.slice(0, 80)}`);
    }
  }
  const keptPhrases = phrases
    .map((p) => ({ ...p, refs: p.refs.filter((r) => knownRefs.has(r) && r !== p.subject.id) }))
    .filter((p) => p.refs.length > 0 || (p.verb === "merged-first" && p.subject.kind === "wave"))
    .sort((a, b) => a.line - b.line);

  // --- shared context (step 9) -----------------------------------------------------------------------------
  let sharedContextRaw: string;
  let sharedContextSource: "block" | "preamble" = "preamble";
  let ctxOpen = -1;
  let ctxClose = -1;
  for (let i = 0; i < lines.length && ctxClose < 0; i += 1) {
    if (fm[i] === true) continue;
    if (ctxOpen < 0) {
      if (PLAN_CONTEXT_OPEN_RE.test(lines[i] as string)) ctxOpen = i;
    } else if (PLAN_CONTEXT_CLOSE_RE.test(lines[i] as string)) {
      ctxClose = i;
    }
  }
  if (ctxOpen >= 0 && ctxClose < 0) throw compileError("plan-context-unclosed", ctxOpen + 1, "<!-- plan-context --> has no closing marker");
  if (ctxOpen >= 0) {
    sharedContextRaw = lines.slice(ctxOpen + 1, ctxClose).join("\n").trim();
    sharedContextSource = "block";
  } else {
    const firstStructural = headings.find((h) => h.kind === "wave" || h.kind === "phase" || h.kind === "dogfood" || h.kind === "generic");
    sharedContextRaw = lines.slice(0, firstStructural === undefined ? lines.length : firstStructural.idx).join("\n").trim();
  }

  return {
    waves: sortedWaves,
    phases: sortedPhases,
    tasks,
    graphs,
    ownership,
    phrases: keptPhrases,
    sharedContextRaw,
    sharedContextSource,
    warnings,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// annotateUnrouted (step 8)

/** One `annotate` call over every routable task that carries no route line; existing tags and route lines are kept. */
export async function annotateUnrouted(
  p: ParsedPlan,
  annotate: (s: readonly PlanStep[]) => Promise<AnnotatedPlan>,
): Promise<ParsedPlan> {
  const pending = p.tasks.filter((t) => t.route === null && t.kind !== "manual" && t.kind !== "preflight");
  if (pending.length === 0) return p;
  const annotated = await annotate(pending.map((t): PlanStep => ({ id: t.id, text: t.body })));
  const byId = new Map<string, (typeof annotated)[number]>();
  for (const a of annotated) byId.set(a.id, a);
  const tasks = p.tasks.map((t): ParsedTask => {
    const a = t.route === null ? byId.get(t.id) : undefined;
    if (a === undefined) return t;
    const fields = parseRouteLine(a.routeLine, { positions: "any" }).line;
    return {
      ...t,
      tierTag: t.tierTag ?? (isTier(a.tier) ? a.tier : null),
      route: { line: a.routeLine, fields, conflict: false },
    };
  });
  return { ...p, tasks };
}

