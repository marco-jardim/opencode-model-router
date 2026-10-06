/**
 * `/annotate-plan` with route lines (M8, plan F3, Phase 2.4.4).
 *
 * The command itself stays what it was: a prompt template that tells the model to tag a plan's steps (`[tier:X]`) and add
 * `[acceptance]` blocks, byte for byte. What this adds, when the engine is live on v2 (shadow, advise or enforce; static and v1 add
 * nothing, §1.2), is the part a model should not guess: it reads the plan file, splits it into steps (fence-aware), classifies every step
 * with ONE batched `classifyMany` call (rules per step, then the configured backend, rules again on any failure), runs 1.4's
 * `annotateSteps` (class → start tier, pins, route lines) and hands the model the exact lines to insert as an extra message part.
 *
 *  - Additive: existing lines are never changed. An existing `[tier:X]` or `[route …]` is authoritative; the one edit an existing route
 *    line can get is ` pin` appended when its step is `[tier:heavy]` or a QA step (A26), and that is reported as such.
 *  - Safe with code: nothing inside a fenced block (``` or ~~~, nested or not) starts a step, is a tag, or receives a route line.
 *  - The hook does not write the plan file. `annotatePlanText` produces the whole annotated text (used by the tests and by anyone who wants
 *    to write it); the message part lists only the lines the model has to add.
 *
 * Pure apart from the injected `classifyMany`, and the file reads of `locatePlan`.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { RouterConfig } from "../../router/config";
import { classifyMany as classifyManyWith, type ClassifyDeps } from "../classify";
import { fenceMask } from "../classify/fences";
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
  const fenced = fenceMask(lines);
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

export interface AnnotatedPlanText {
  /** The whole plan with every step annotated; equal to the input when nothing had to change. */
  readonly text: string;
  readonly placed: readonly PlacedStep[];
  readonly steps: readonly AnnotatedStep[];
  /** Steps this annotation pinned (A26). */
  readonly pinnedCount: number;
}

/**
 * `splitPlan` + one `annotateSteps` call (one batched classification). Idempotent: annotating the result again changes nothing.
 * Never throws for well-typed input (a classifier failure leaves rules facts, see `annotateSteps`).
 */
export async function annotatePlanText(text: string, deps: AnnotateDeps): Promise<AnnotatedPlanText> {
  const placed = splitPlan(text);
  if (placed.length === 0) return { text, placed, steps: [], pinnedCount: 0 };
  // A step that ends the text has no terminator of its own: give it the file's, so an inserted route line is joined with the same line
  // ending as everything else, and take it off again afterwards.
  const eol = /\r\n|\n|\r/.exec(text)?.[0] ?? "\n";
  const synthetic = (step: PlacedStep): boolean => step.to === text.length && !/[\r\n]$/.test(step.text);
  const annotated = await annotateSteps(
    placed.map((step) => ({ id: step.id, text: synthetic(step) ? `${step.text}${eol}` : step.text })),
    deps,
  );
  let out = "";
  let last = 0;
  placed.forEach((step, index) => {
    const annotatedText = (annotated[index] as AnnotatedStep).text;
    out += text.slice(last, step.from) + (synthetic(step) && annotatedText.endsWith(eol) ? annotatedText.slice(0, -eol.length) : annotatedText);
    last = step.to;
  });
  out += text.slice(last);
  return { text: out, placed, steps: [...annotated], pinnedCount: annotated.pinnedCount };
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

const EXCERPT_CHARS = 80;
const MAX_LISTED_STEPS = 300;

function excerptOf(text: string): string {
  const first = text.split(LINE_SPLIT_RE)[0] ?? "";
  const clean = first.trim().replace(/"/g, "'");
  return clean.length > EXCERPT_CHARS ? `${clean.slice(0, EXCERPT_CHARS - 1)}…` : clean;
}

/** What the model is told to add, step by step, plus the facts a checkpoint records (source per step, latency, errors). */
export function renderDirectives(
  result: AnnotatedPlanText,
  info: { readonly path: string; readonly engine: string; readonly classification: ClassificationReport },
): string {
  const { steps, placed } = result;
  const needing = steps
    .map((step, index) => ({ step, placed: placed[index] as PlacedStep }))
    .filter(({ step }) => step.changed);
  const sources = new Map<string, number>();
  for (const step of steps) sources.set(step.facts.source, (sources.get(step.facts.source) ?? 0) + 1);
  const statuses = Object.entries(info.classification.statuses).map(([status, count]) => `${status} ${count}`).join(", ");
  const lines = [
    `## Router route lines (model-router, engine=${info.engine})`,
    `Computed by the router for ${info.path}: ${steps.length} step${steps.length === 1 ? "" : "s"} found, ${needing.length} need${needing.length === 1 ? "s" : ""} an addition, ${result.pinnedCount} pinned by this annotation (a \`[tier:heavy]\` or QA step is never moved by the engine).`,
    `Classification: backend=${info.classification.backend}; sources: ${[...sources].map(([source, count]) => `${source} ${count}`).join(", ") || "none"}${statuses === "" ? "" : `; backend outcomes: ${statuses}`}${info.classification.latencyMs === null ? "" : `; backend latency ${info.classification.latencyMs} ms`}${info.classification.error === null ? "" : `; first error: ${info.classification.error}`}.`,
  ];
  if (needing.length === 0) {
    lines.push("Every step already carries its tier and route line: add nothing.");
    return lines.join("\n");
  }
  lines.push(
    "Add exactly these lines, keeping every existing line as it is. A `[route …]` line goes on its own line directly after the step's first line, indented like that line (at most 3 spaces); never put one inside a fenced code block, and do not invent others. A tier tag is added only where it says so.",
  );
  for (const { step, placed: where } of needing.slice(0, MAX_LISTED_STEPS)) {
    const tag = step.tierSource === "engine" ? `tag [tier:${step.tier}] (the step has none); ` : `already tagged [tier:${step.tier}]; `;
    const route = step.routeEdited
      ? `replace its existing route line with \`${step.routeLine}\` (the only change is \`pin\`)`
      : step.routeSource === "engine"
        ? `insert \`${step.routeLine}\``
        : "keep its existing route line";
    // The excerpt is the line as it is in the file (the annotated text already carries the tag the model is about to add).
    lines.push(`- line ${where.line} "${excerptOf(where.text)}": ${tag}${route} [facts source: ${step.facts.source}]`);
  }
  if (needing.length > MAX_LISTED_STEPS) lines.push(`- … ${needing.length - MAX_LISTED_STEPS} more steps: run /annotate-plan again after applying these.`);
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
