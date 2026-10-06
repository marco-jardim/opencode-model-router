/**
 * `/annotate-plan` with route lines (M8, plan F3, Phase 2.4.4).
 *
 * The command itself stays what it was: a prompt template that tells the model to tag a plan's steps (`[tier:X]`) and add
 * `[acceptance]` blocks, byte for byte. What this adds, when the engine is live on v2 (shadow, advise or enforce; static and v1 add
 * nothing, §1.2), is the part a model should not guess: it reads the plan file, splits it into steps (fence-aware), classifies every step
 * with ONE batched `classifyMany` call (rules per step, then the configured backend, rules again on any failure), runs 1.4's
 * `annotateSteps` (class → start tier, pins, route lines) and hands the model the exact lines to insert as an extra message part.
 *
 *  - Additive: no line is removed or reordered. An existing `[tier:X]` or `[route …]` is authoritative. The only edits to an existing line
 *    are `[tier:X]` inserted after the step's list marker (the template's "at the START of each step") and ` pin` appended to an existing
 *    route line when its step is `[tier:heavy]` or a QA step (A26); both are reported as such.
 *  - Safe with code: nothing inside a fenced block (``` or ~~~, nested or not) starts a step, is a tag, or receives a route line.
 *  - The hook does not write the plan file. `annotatePlanText` produces the whole annotated text (used by the tests and by anyone who wants
 *    to write it); the message part lists, step by step, the exact lines the model has to write, derived from the same additions.
 *
 * Pure apart from the injected `classifyMany`, and the file reads of `locatePlan`.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { RouterConfig } from "../../router/config";
import { classifyMany as classifyManyWith, type ClassifyDeps } from "../classify";
import { parseRouteLine } from "../classify/route-line";
import type { ClassifyInput, ClassifyResult } from "../classify/types";
import { annotateSteps } from "../engine";
import type { AnnotateDeps, AnnotatedStep, PlanStep } from "../engine";
import type { HostAgentInfo } from "../engine";
import { agentModelRef, grantsOfRules, parseRules } from "../wire/host-info";
import type { EngineRuntime } from "../wire/runtime";

// ---------------------------------------------------------------------------
// Splitting a plan into steps
// ---------------------------------------------------------------------------

export interface PlacedStep extends PlanStep {
  /** 1-based line of the step's first line. */
  readonly line: number;
  /** Character range of the step in the plan text (`to` exclusive; it includes the terminator of the step's last line when there is one). */
  readonly from: number;
  readonly to: number;
}

const LINE_SPLIT_RE = /(\r\n|\n|\r)/;
const LIST_ITEM_RE = /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+)\S/;
const HEADING_RE = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const THEMATIC_RE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const ACCEPT_OPEN_RE = /^\s*\[acceptance\]\s*$/i;
const ACCEPT_CLOSE_RE = /^\s*\[\/acceptance\]\s*$/i;
const STEP_HEADING_RE = /^ {0,3}#{2,6}[ \t]+(?:step|task|phase|stage|milestone)\b/i;

/** Columns of leading whitespace (a tab counts as four, like the route-line parser). */
function indentOf(line: string): number {
  let columns = 0;
  for (const ch of line) {
    if (ch === " ") columns += 1;
    else if (ch === "\t") columns += 4;
    else break;
  }
  return columns;
}

/** A fence run at the start of `text` (indentation already measured): the character and length, or `null` (a backtick run's info string may not hold a backtick). */
function fenceRunOf(text: string): { readonly char: string; readonly length: number } | null {
  const match = /^(`{3,}|~{3,})(.*)$/.exec(text);
  const run = match?.[1];
  if (match === null || run === undefined || (run[0] === "`" && (match[2] ?? "").includes("`"))) return null;
  return { char: run[0] as string, length: run.length };
}

/**
 * Which lines are code or comment, the way the step scanner needs it (QA-2.4-12, QA-2.4-R2-2, -R2-8, -R2-9). Like the shared `fenceMask`
 * (an opener, a closer of the same character at least as long, nothing but whitespace after it) with differences that matter inside a plan:
 *  - a fence opened inside a list item ends where the item does: a non-blank line indented less than the item's content column closes it
 *    (CommonMark), so a closer that is not valid (`closerWithInfo`: ``` followed by an info string) can no longer swallow every later
 *    step to the end of the file;
 *  - indentation is measured from the container: a fence (and its closer, and a comment) inside an item may be indented up to 3 columns
 *    PAST the item's content column (`10. step` has its content at column 4), not 3 columns from the margin;
 *  - an item whose content STARTS with a fence opener (`1. ```bash`) opens the fence on its own line: the item line stays a step line (it
 *    is not masked), everything after it up to the closer is code;
 *  - an HTML comment block (`<!--` … `-->`, at most 3 columns from its container) is masked, so a list inside one is never a step.
 * A fence at the top level (not inside an item) still runs to its closer, or to the end of the text.
 */
export function structureMask(lines: readonly string[]): boolean[] {
  const mask: boolean[] = new Array<boolean>(lines.length).fill(false);
  let fence: { readonly char: string; readonly length: number; readonly itemOffset: number | null } | null = null;
  let comment = false;
  let itemOffset: number | null = null; // content column of the list item we are in, if any
  let gap = false;
  /** The column a line is measured from: the item's content column when the line reaches it, else the margin. */
  const baseOf = (line: string, offset: number | null): number => (offset !== null && indentOf(line) >= offset ? offset : 0);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (fence !== null) {
      const relative = indentOf(line) - (fence.itemOffset ?? 0);
      const closer = relative >= 0 && relative <= 3 ? /^(`{3,}|~{3,})[ \t]*$/.exec(line.trimStart()) : null;
      if (closer !== null && (closer[1] as string)[0] === fence.char && (closer[1] as string).length >= fence.length) {
        mask[i] = true;
        fence = null;
        continue;
      }
      if (line.trim() === "" || fence.itemOffset === null || indentOf(line) >= fence.itemOffset) {
        mask[i] = true;
        continue;
      }
      fence = null; // the item ended: so did its code block; this line is an ordinary line
    }
    if (comment) {
      mask[i] = true;
      if (line.includes("-->")) comment = false;
      continue;
    }
    if (line.trim() === "") {
      gap = true;
      continue;
    }
    if (HEADING_RE.test(line) || THEMATIC_RE.test(line)) {
      itemOffset = null;
      gap = false;
      continue;
    }
    const relative = indentOf(line) - baseOf(line, itemOffset);
    const run = relative <= 3 ? fenceRunOf(line.trimStart()) : null;
    if (run !== null) {
      if (itemOffset !== null && indentOf(line) < itemOffset) itemOffset = null; // not indented as the item's content: not part of it
      mask[i] = true;
      fence = { ...run, itemOffset };
      gap = false;
      continue;
    }
    if (relative <= 3 && line.trimStart().startsWith("<!--")) {
      if (itemOffset !== null && indentOf(line) < itemOffset) itemOffset = null;
      mask[i] = true;
      comment = !line.slice(line.indexOf("<!--") + 4).includes("-->");
      gap = false;
      continue;
    }
    const item = LIST_ITEM_RE.exec(line);
    if (item !== null) {
      const indent = indentOf(line);
      const spaces = indentOf(item[3] as string);
      const own = indent + (item[2] as string).length + spaces; // this item's content column
      if (itemOffset === null || indent < itemOffset) itemOffset = own;
      // `1. ```bash`: the item's content opens a code block on the item line itself (QA-2.4-R2-2)
      const opened = spaces <= 4 ? fenceRunOf(line.slice((item[1] as string).length + (item[2] as string).length + (item[3] as string).length)) : null;
      if (opened !== null) fence = { ...opened, itemOffset: own };
      gap = false;
      continue;
    }
    if (itemOffset !== null && gap && indentOf(line) < itemOffset) itemOffset = null; // a paragraph after a blank line ends the item
    gap = false;
  }
  return mask;
}

/** The step's first line is a list item whose content opens a code block (`1. ```bash`): a tag or a route line cannot be added to it. */
export function opensCodeBlock(line: string): boolean {
  const item = LIST_ITEM_RE.exec(line);
  if (item === null || indentOf(item[3] as string) > 4) return false;
  return fenceRunOf(line.slice((item[1] as string).length + (item[2] as string).length + (item[3] as string).length)) !== null;
}
interface Run {
  start: number;
  end: number;
}

/** Top-level list items, with their continuation lines, nested items, fenced blocks and a following `[acceptance]` block. */
function listRuns(lines: readonly string[], fenced: readonly boolean[]): Run[] {
  const runs: Run[] = [];
  let current: (Run & { offset: number }) | null = null;
  let gap = false; // a blank line since the last line included in the step
  let acceptance = false;
  let joinFence = false;
  const close = (): void => {
    if (current !== null) runs.push({ start: current.start, end: current.end });
    current = null;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (fenced[i] === true) {
      if (i === 0 || fenced[i - 1] !== true) {
        // A block joins the step when nothing separates them, or it is indented as the item's content (CommonMark).
        joinFence = current !== null && (!gap || indentOf(line) >= current.offset);
        if (!joinFence) close();
      }
      if (current !== null && joinFence) {
        current.end = i + 1;
        gap = false;
      }
      continue;
    }
    if (acceptance) {
      if (ACCEPT_CLOSE_RE.test(line)) acceptance = false;
      if (current !== null) {
        current.end = i + 1;
        gap = false;
      }
      continue;
    }
    if (line.trim() === "") {
      gap = true;
      continue;
    }
    if (HEADING_RE.test(line) || THEMATIC_RE.test(line)) {
      close();
      gap = false;
      continue;
    }
    if (ACCEPT_OPEN_RE.test(line)) {
      acceptance = true;
      if (current !== null) {
        current.end = i + 1;
        gap = false;
      }
      continue;
    }
    const item = LIST_ITEM_RE.exec(line);
    if (item !== null) {
      const indent = indentOf(line);
      if (current !== null && indent >= current.offset) {
        current.end = i + 1; // a nested item belongs to its parent step
        gap = false;
        continue;
      }
      if (indent <= 3) {
        close();
        current = { start: i, end: i + 1, offset: indent + (item[2] as string).length + indentOf(item[3] as string) };
        gap = false;
        continue;
      }
    }
    if (current !== null && (!gap || indentOf(line) >= current.offset)) {
      current.end = i + 1;
      gap = false;
      continue;
    }
    close();
    gap = false;
  }
  close();
  return runs;
}

/** Fallback for a plan with no list at all: `## Step 1`, `### Task: …`, `## Phase 2` headings, each running to the next heading. */
function headingRuns(lines: readonly string[], fenced: readonly boolean[]): Run[] {
  const runs: Run[] = [];
  let current: Run | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (fenced[i] !== true && HEADING_RE.test(line)) {
      if (current !== null) runs.push(current);
      current = STEP_HEADING_RE.test(line) ? { start: i, end: i + 1 } : null;
      continue;
    }
    if (current !== null && (fenced[i] === true || line.trim() !== "")) current.end = i + 1;
  }
  if (current !== null) runs.push(current);
  return runs;
}

/**
 * The steps of a markdown plan, in order. A step is a top-level list item (up to three spaces of indentation) with everything that
 * belongs to it; headings, paragraphs and thematic breaks between steps are never steps. A fenced block (``` or ~~~, any nesting of
 * the other kind inside) belongs to the step it sits in and hides its content from the step scanner. A plan without any list falls back to
 * `Step`/`Task`/`Phase`/`Stage`/`Milestone` headings.
 */
export function splitPlan(text: string): PlacedStep[] {
  const parts = text.split(LINE_SPLIT_RE);
  const lines: string[] = [];
  const offsets: number[] = [];
  let at = 0;
  parts.forEach((part, index) => {
    if (index % 2 === 0) {
      lines.push(part);
      offsets.push(at);
    }
    at += part.length;
  });
  const fenced = structureMask(lines);
  let runs = listRuns(lines, fenced);
  if (runs.length === 0) runs = headingRuns(lines, fenced);
  return runs.map((run) => {
    const from = offsets[run.start] as number;
    // The step includes the terminator of its last line (so `annotateSteps` inserts a route line with the file's own line ending); the
    // last line of a text that has no final terminator simply ends at the end of the text.
    const to = run.end < lines.length ? (offsets[run.end] as number) : text.length;
    return { id: `L${run.start + 1}`, text: text.slice(from, to), line: run.start + 1, from, to };
  });
}
// ---------------------------------------------------------------------------
// Annotating
// ---------------------------------------------------------------------------

/**
 * One step's additions, in terms of lines of the ORIGINAL plan: the single definition of "what `/annotate-plan` adds". The annotated text
 * ({@link applyAdditions}) and the message part ({@link renderDirectives}) are both made from it, so what the model is asked to write is
 * exactly what the tests snapshot.
 *  - the tier tag goes at the START of the step, after its list marker or heading hashes (the command template's rule 1:
 *    `1. [tier:fast] Find all …`), and only when the step has none;
 *  - the route line goes on the line directly BELOW the step's first line (plan 2.4.4: `[route …]` after each `[tier:X]`), indented like
 *    that line (at most 3 spaces). The first line of a step is never inside a fenced block, so neither is the insertion point;
 *  - an existing route line is edited in place only to add ` pin` (A26).
 */
export interface PlanAddition {
  /** 1-based line of the step's first line (the anchor), as it is in the file now. */
  readonly line: number;
  /** That line, verbatim. */
  readonly anchor: string;
  /** The anchor rewritten with `[tier:X]` after its marker; `null` when the step already carries a tier tag. */
  readonly tag: { readonly tier: string; readonly line: string } | null;
  /** A new route line to put directly below the anchor (`indent` + `text`); `null` when the step has a route line already. */
  readonly insertRoute: { readonly indent: string; readonly text: string } | null;
  /** An existing route line that only gains ` pin`: its 1-based line, what it is now and what it becomes. */
  readonly replaceRoute: { readonly line: number; readonly before: string; readonly text: string } | null;
  /** Where the step's facts came from (`rules`, `host`, `plan`, …). */
  readonly source: string;
}

/**
 * A step that would have changed but cannot take an addition: its first line is a list item whose content opens a code block
 * (`1. ```bash`), so a tag after the marker would corrupt the fence opener and a route line below it would be inside the code
 * (QA-2.4-R2-2). Skipped, never guessed at, and reported so the user can annotate it by hand.
 */
export interface SkippedStep {
  /** 1-based line of the step's first line. */
  readonly line: number;
  /** That line, verbatim. */
  readonly anchor: string;
  /** The tier the engine would have written, for the by-hand edit. */
  readonly tier: string;
  /** The route line the engine would have written, for the by-hand edit. */
  readonly routeLine: string;
}

export interface AnnotatedPlanText {
  /** The whole plan with every step annotated; equal to the input when nothing had to change. */
  readonly text: string;
  readonly placed: readonly PlacedStep[];
  readonly steps: readonly AnnotatedStep[];
  /** Steps this annotation pinned (A26). */
  readonly pinnedCount: number;
  /** What was added, step by step (only steps that change). */
  readonly additions: readonly PlanAddition[];
  /** Steps that start with a code block: nothing was added to them (see {@link SkippedStep}). */
  readonly skipped: readonly SkippedStep[];
}

const TAG_SLOT_RE = /^(?: {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?| {0,3}#{1,6}[ \t]+)/;

/** `line` with `[tier:X]` after its list marker (and checkbox) or heading hashes; at the start of the text when there is neither. */
export function withTagAtStart(line: string, tier: string): string {
  const prefix = TAG_SLOT_RE.exec(line)?.[0] ?? /^[ \t]*/.exec(line)?.[0] ?? "";
  const rest = line.slice(prefix.length);
  return rest === "" ? `${prefix}[tier:${tier}]` : `${prefix}[tier:${tier}] ${rest}`;
}

function additionsOf(placed: readonly PlacedStep[], steps: readonly AnnotatedStep[]): { additions: PlanAddition[]; skipped: SkippedStep[]; pinned: number } {
  const out: PlanAddition[] = [];
  const skipped: SkippedStep[] = [];
  let pinned = 0;
  placed.forEach((where, index) => {
    const step = steps[index] as AnnotatedStep;
    if (!step.changed) return;
    const original = where.text.split(LINE_SPLIT_RE).filter((_, i) => i % 2 === 0);
    const annotated = step.text.split(LINE_SPLIT_RE).filter((_, i) => i % 2 === 0);
    const anchor = original[0] ?? "";
    if (opensCodeBlock(anchor)) {
      skipped.push({ line: where.line, anchor, tier: step.tier, routeLine: step.routeLine });
      return;
    }
    if (step.pin && (step.routeEdited || step.routeSource === "engine")) pinned += 1;
    let replaceRoute: PlanAddition["replaceRoute"] = null;
    if (step.routeEdited) {
      // The engine edited an existing, unfenced route line in place: the same line index in both texts. The mask is the scanner's own
      // (indentation measured from the item's content column, QA-2.4-R2-8), so a route line inside a code block is never the one edited.
      const mask = structureMask(original);
      const at = original.findIndex((line, i) => mask[i] !== true && parseRouteLine(line, { positions: "any" }).count > 0);
      if (at >= 0 && annotated[at] !== undefined && annotated[at] !== original[at]) {
        replaceRoute = { line: where.line + at, before: original[at] as string, text: annotated[at] as string };
      }
    }
    out.push({
      line: where.line,
      anchor,
      tag: step.tierSource === "engine" ? { tier: step.tier, line: withTagAtStart(anchor, step.tier) } : null,
      insertRoute: step.routeSource === "engine" ? { indent: (/^ */.exec(anchor)?.[0] ?? "").slice(0, 3), text: step.routeLine } : null,
      replaceRoute,
      source: step.facts.source,
    });
  });
  return { additions: out, skipped, pinned };
}

/** Apply additions to the plan they were computed for: the mechanical meaning of {@link PlanAddition}. Line endings are the file's own. */
export function applyAdditions(text: string, additions: readonly PlanAddition[]): string {
  const parts = text.split(LINE_SPLIT_RE);
  const lines: string[] = [];
  const terminators: string[] = [];
  parts.forEach((part, index) => {
    if (index % 2 === 0) lines.push(part);
    else terminators.push(part);
  });
  const docEol = terminators[0] ?? "\n";
  const byLine = new Map(additions.map((addition) => [addition.line, addition]));
  const replacements = new Map<number, string>();
  for (const addition of additions) if (addition.replaceRoute !== null) replacements.set(addition.replaceRoute.line, addition.replaceRoute.text);
  let out = "";
  lines.forEach((line, index) => {
    const addition = byLine.get(index + 1);
    const current = addition?.tag != null ? addition.tag.line : (replacements.get(index + 1) ?? line);
    const eol = terminators[index];
    if (addition?.insertRoute != null) out += `${current}${eol ?? docEol}${addition.insertRoute.indent}${addition.insertRoute.text}${eol ?? ""}`;
    else out += `${current}${eol ?? ""}`;
  });
  return out;
}

/**
 * `splitPlan` + one `annotateSteps` call (one batched classification). Idempotent: annotating the result again changes nothing.
 * Never throws for well-typed input (a classifier failure leaves rules facts, see `annotateSteps`).
 */
export async function annotatePlanText(text: string, deps: AnnotateDeps): Promise<AnnotatedPlanText> {
  const placed = splitPlan(text);
  if (placed.length === 0) return { text, placed, steps: [], pinnedCount: 0, additions: [], skipped: [] };
  // A step that ends the text has no terminator of its own: give it the file's, so the engine joins an inserted route line with the same
  // line ending as everything else (only its tier, route and pin DECISIONS are used from the engine, not its text).
  const eol = /\r\n|\n|\r/.exec(text)?.[0] ?? "\n";
  const annotated = await annotateSteps(
    placed.map((step) => ({ id: step.id, text: step.to === text.length && !/[\r\n]$/.test(step.text) ? `${step.text}${eol}` : step.text })),
    deps,
  );
  const steps = [...annotated];
  const { additions, skipped, pinned } = additionsOf(placed, steps);
  // `pinned` is the engine's figure minus the steps that were skipped (nothing was written for them, so nothing was pinned)
  return { text: applyAdditions(text, additions), placed, steps, pinnedCount: pinned, additions, skipped };
}

// ---------------------------------------------------------------------------
// The message part
// ---------------------------------------------------------------------------

export interface ClassificationReport {
  /** `rules`, or the configured backend (`host`, `openai-compatible`, `typesafe`). */
  readonly backend: string;
  /** Count of backend outcomes by status (`ok`, `timeout`, …); empty when no backend was consulted. */
  readonly statuses: Readonly<Record<string, number>>;
  /** The slowest backend call of the batch, in ms; `null` when none was made. */
  readonly latencyMs: number | null;
  /** The first backend failure reason, verbatim, when there was one. */
  readonly error: string | null;
}

const MAX_LISTED_STEPS = 300;
const q = (value: string): string => JSON.stringify(value);

/**
 * What the model is told to write, one line per step that changes, anchored on line numbers of the file as it is now and quoting the
 * anchor line so it can be found even after earlier insertions moved the numbers. Each piece is a complete instruction with the exact
 * line to write (JSON-quoted), so nothing is left to the model's judgement: `rewrite line N as "…"`, `insert directly below line N
 * (outside any code fence) the line "…"`, `replace line M (was "…") with "…"`.
 */
export function renderDirectives(
  result: AnnotatedPlanText,
  info: { readonly path: string; readonly engine: string; readonly classification: ClassificationReport },
): string {
  const { steps, additions, skipped } = result;
  const sources = new Map<string, number>();
  for (const step of steps) sources.set(step.facts.source, (sources.get(step.facts.source) ?? 0) + 1);
  const statuses = Object.entries(info.classification.statuses).map(([status, count]) => `${status} ${count}`).join(", ");
  const lines = [
    `## Router route lines (model-router, engine=${info.engine})`,
    `Computed by the router for ${info.path}: ${steps.length} step${steps.length === 1 ? "" : "s"} found, ${additions.length} need${additions.length === 1 ? "s" : ""} an addition${skipped.length === 0 ? "" : ` (${skipped.length} more start${skipped.length === 1 ? "s" : ""} with a code block and ${skipped.length === 1 ? "is" : "are"} skipped)`}, ${result.pinnedCount} pinned by this annotation (a \`[tier:heavy]\` or QA step is never moved by the engine).`,
    `Classification: backend=${info.classification.backend}; sources: ${[...sources].map(([source, count]) => `${source} ${count}`).join(", ") || "none"}${statuses === "" ? "" : `; backend outcomes: ${statuses}`}${info.classification.latencyMs === null ? "" : `; backend latency ${info.classification.latencyMs} ms`}${info.classification.error === null ? "" : `; first error: ${info.classification.error}`}.`,
  ];
  // A step whose first line is a list item that opens a code block (`1. ```bash`) takes neither a tag (it would break the fence opener)
  // nor a route line below (it would be inside the code): skipped, and said so (QA-2.4-R2-2).
  const skippedLines = skipped.slice(0, MAX_LISTED_STEPS).map(
    (step) => `- line ${step.line} ${q(step.anchor)}: step at line ${step.line} starts with a code block: add nothing to it here; to annotate it by hand, put ${q(`[tier:${step.tier}]`)} and ${q(step.routeLine)} on their own lines directly above the list item, or after the closing fence.`,
  );
  if (additions.length === 0) {
    lines.push(skipped.length === 0 ? "Every step already carries its tier and route line: add nothing." : "No step can take an addition automatically. Make no change to the file for these steps:");
    lines.push(...skippedLines);
    return lines.join("\n");
  }
  lines.push(
    "Make exactly these changes, keeping every other line as it is. Line numbers are those of the file now: apply the list from the last step to the first (or find each line by its quoted text) so earlier insertions do not move the later ones. Each quoted string is the complete line to write. Where a tier tag is listed it replaces the template's tag rule for that step (it is already at the start, as the template says); never write a `[route …]` line inside a fenced code block, and do not invent others.",
  );
  for (const addition of additions.slice(0, MAX_LISTED_STEPS)) {
    const pieces: string[] = [];
    if (addition.tag !== null) pieces.push(`rewrite line ${addition.line} as ${q(addition.tag.line)}`);
    if (addition.insertRoute !== null) pieces.push(`insert directly below line ${addition.line} (outside any code fence) the line ${q(`${addition.insertRoute.indent}${addition.insertRoute.text}`)}`);
    if (addition.replaceRoute !== null) pieces.push(`replace line ${addition.replaceRoute.line} (was ${q(addition.replaceRoute.before)}) with ${q(addition.replaceRoute.text)}`);
    lines.push(`- line ${addition.line} ${q(addition.anchor)}: ${pieces.join("; ")} [facts source: ${addition.source}]`);
  }
  if (additions.length > MAX_LISTED_STEPS) lines.push(`- … ${additions.length - MAX_LISTED_STEPS} more steps: run /annotate-plan again after applying these.`);
  if (skippedLines.length > 0) lines.push("Make no change to these steps (each starts with a code block; a tag or a route line cannot be added to its first line):", ...skippedLines);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Locating the plan file
// ---------------------------------------------------------------------------

const MAX_PLAN_BYTES = 1_048_576;

async function readPlan(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_PLAN_BYTES) return null;
    return await readFile(path, "utf-8");
  } catch {
    return null; // not there (or not readable): the next candidate, or the plain template as before
  }
}

/**
 * The plan the command was pointed at: the path argument (quotes stripped; relative to the project directories), else, like the
 * template says, `PLAN.md`, `plan.md` or the most recently changed `*plan*.md` of those directories. `null` when there is none.
 */
export async function locatePlan(args: string, dirs: readonly string[]): Promise<{ path: string; text: string } | null> {
  const named = args.trim().replace(/^(["'])(.*)\1$/, "$2").trim();
  const candidates: string[] = [];
  if (named !== "") {
    for (const dir of dirs) candidates.push(isAbsolute(named) ? named : resolve(dir, named));
  } else {
    for (const dir of dirs) {
      candidates.push(join(dir, "PLAN.md"), join(dir, "plan.md"));
      try {
        const entries = (await readdir(dir)).filter((name) => /plan/i.test(name) && /\.md$/i.test(name));
        const dated: Array<{ path: string; mtime: number }> = [];
        for (const name of entries) {
          try {
            dated.push({ path: join(dir, name), mtime: (await stat(join(dir, name))).mtimeMs });
          } catch {
            continue; // vanished between readdir and stat
          }
        }
        dated.sort((a, b) => b.mtime - a.mtime || (a.path < b.path ? -1 : 1));
        candidates.push(...dated.map((entry) => entry.path));
      } catch {
        continue; // an unreadable directory has no plan
      }
    }
  }
  for (const path of [...new Set(candidates)]) {
    const text = await readPlan(path);
    if (text !== null) return { path, text };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/** Host agents as the plan annotation needs them: dispatchable by any caller (the command has no parent agent), grants from their own rules. */
export function agentInfosForPlan(raw: readonly unknown[]): HostAgentInfo[] {
  const infos: HostAgentInfo[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const agent = entry as Record<string, unknown>;
    if (typeof agent.id !== "string" || agent.id === "") continue;
    infos.push({
      id: agent.id,
      model: agentModelRef(agent.model),
      mode: typeof agent.mode === "string" ? agent.mode : "primary",
      hidden: agent.hidden === true,
      permitted: true,
      grants: grantsOfRules(parseRules(agent.permissions)),
    });
  }
  return infos;
}

export interface AnnotateCommandDeps {
  readonly cfg: RouterConfig;
  readonly runtime: EngineRuntime;
  /** `ctx.agent.list().data`. */
  readonly listAgents: () => Promise<readonly unknown[]>;
  /** The project directories searched for a plan, in order. */
  readonly dirs: readonly string[];
  readonly logger: { warn(message: string, extra?: Record<string, unknown>): void };
}

/**
 * The text to add to `/annotate-plan`, or `null` when there is nothing to add: the engine is static (or the host is v1), no plan file can be
 * found, or the plan has no steps. Never throws.
 */
export async function buildAnnotateDirectives(args: string, deps: AnnotateCommandDeps): Promise<string | null> {
  try {
    const prepared = await deps.runtime.prepare(deps.cfg);
    if (prepared === null) return null; // static, or not v2: the command is exactly what it was
    const plan = await locatePlan(args, deps.dirs);
    if (plan === null) return null;
    let agents: HostAgentInfo[] | null = null;
    try {
      agents = agentInfosForPlan(await deps.listAgents());
    } catch (error) {
      deps.logger.warn("[router] /annotate-plan: the agent list is unavailable; tiers are annotated without it", { error: error instanceof Error ? error.message : String(error) });
    }
    const classifyDeps: ClassifyDeps = { ...deps.runtime.classifyDeps(prepared), routeLinePositions: "any" };
    let classified: readonly ClassifyResult[] = [];
    const classifyMany = async (inputs: readonly ClassifyInput[]): Promise<ClassifyResult[]> => {
      classified = await classifyManyWith(inputs, classifyDeps);
      return [...classified];
    };
    const result = await annotatePlanText(plan.text, {
      cfg: deps.cfg,
      routing: prepared.routing,
      agents,
      store: prepared.store,
      pricing: (model) => prepared.catalog.pricing(model),
      session: prepared.session,
      logger: deps.logger,
      classifyMany,
    });
    if (result.steps.length === 0) return null;
    const outcomes = classified.map((c) => c.trace.backend).filter((b): b is NonNullable<typeof b> => b !== null);
    const statuses: Record<string, number> = {};
    for (const outcome of outcomes) statuses[outcome.status] = (statuses[outcome.status] ?? 0) + 1;
    const failure = outcomes.find((o) => o.status !== "ok" && o.reason !== undefined);
    return renderDirectives(result, {
      path: plan.path,
      engine: prepared.routing.engine,
      classification: {
        backend: classifyDeps.settings.backend,
        statuses,
        latencyMs: outcomes.length === 0 ? null : Math.max(...outcomes.map((o) => o.latencyMs)),
        error: failure?.reason ?? null,
      },
    });
  } catch (error) {
    deps.logger.warn("[router] /annotate-plan: route lines unavailable; the plan is annotated without them", { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}
