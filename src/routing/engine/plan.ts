/**
 * Plan fan-out (M4) — annotate every step of a plan with `[tier:X]` and a `[route …]` line in one pass.
 *
 * Design: `docs/qa/cost-aware-routing/phase-1.4.md` → "Design (1.4.1)" §5. Plan #74 §0.10.12 and 2.4.4
 * (`/annotate-plan`), D13 (`[route pin]`), A22 (a route line is recognised in trusted positions only).
 *
 *  - ONE batched classification per call (`deps.classifyMany`, which chunks to `MAX_BATCH_ITEMS` itself).
 *  - A `[tier:X]` or `[route …]` already in a step (outside fenced code blocks, QA-1.4-9) is authoritative and
 *    is never re-emitted or duplicated, so annotating an annotated plan returns byte-identical text. The one
 *    edit made to an existing route line is appending ` pin` when the step must be pinned (`[tier:heavy]` or a
 *    QA step, QA-1.4-7), which is reported (`routeEdited`).
 *  - A QA step (QA-1.4-13: a leading `QA` word or `QA review|round|pass|…`) without a tier tag gets `heavy` if
 *    the preset has it, else the default tier, and is pinned (QA-1.4-8). The match is deliberately narrow: a
 *    false positive forces the heavy tier, a false negative only leaves the engine's normal choice.
 *  - Without a tier tag the engine picks the class's static tier and lets the kernel move it only on
 *    evidence (`MIN_EVIDENCE_TO_MOVE`, the same gate as the `R:` line): an empty store annotates exactly the
 *    static mapping.
 *  - The route line is placed right after the step's first task line, indented at most 3 columns (the
 *    parser ignores 4+), and `dispatchPrompt` always starts with it (A22).
 *
 * Pure apart from awaiting the injected `classifyMany`: no I/O, no clock, no randomness, no module state.
 */

import type { ResolvedRouting, RouterConfig } from "../../router/config";
import { parseAcceptanceBlock } from "../../verify/dod";
import { fenceMask } from "../classify/fences";
import { parseRouteLine } from "../classify/route-line";
import {
  CLASS_STATIC_TIER,
  DETECTIONS,
  NEEDS,
  RISKS,
  SCOPES,
  TASK_CLASSES,
  UNKNOWN_FACTS,
  type ClassifyInput,
  type ClassifyResult,
  type Detection,
  type TaskFacts,
} from "../classify/types";
import type { ModelPricing } from "../outcomes/types";
import { decide, hasMinEvidence } from "./kernel";
import { buildLadder, type LadderBuildInput, floorRankOf, resolveChosen, routerTierIds } from "./ladders";
import type { Decision, EngineStoreView, HostAgentInfo } from "./types";

export interface PlanStep {
  readonly id: string;
  /** First line = the step's task line. */
  readonly text: string;
}

export interface AnnotateDeps {
  readonly cfg: RouterConfig;
  readonly routing: ResolvedRouting;
  readonly agents: readonly HostAgentInfo[] | null;
  readonly store: EngineStoreView | null;
  readonly pricing?: (model: string) => ModelPricing;
  /** Forwarded to `buildLadder`: the runner policy's session input (A25), the parent model, the pricing logger. */
  readonly session?: LadderBuildInput["session"];
  readonly parentModel?: string | null;
  readonly logger?: LadderBuildInput["logger"];
  /** 1.2 `classifyMany` bound to its deps with `routeLinePositions: "any"` (tooling); called exactly once. */
  readonly classifyMany: (inputs: readonly ClassifyInput[]) => Promise<ClassifyResult[]>;
}

export interface AnnotatedStep {
  readonly id: string;
  readonly tier: string;
  readonly tierSource: "existing" | "engine";
  readonly routeLine: string;
  readonly routeSource: "existing" | "engine";
  /** An existing route line was minimally edited to add ` pin` (a `[tier:heavy]` or QA step, QA-1.4-7). */
  readonly routeEdited: boolean;
  readonly facts: TaskFacts;
  readonly detection: Detection;
  readonly pin: boolean;
  readonly decision: Decision | null;
  /** Annotated step text. */
  readonly text: string;
  /** `text` differs from the step the caller passed in. */
  readonly changed: boolean;
  /** Route line FIRST (A22), then the annotated step text without route lines; joined with the step's own line ending. */
  readonly dispatchPrompt: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const TIER_TAG_RE = /\[tier:([A-Za-z0-9_-]+)\]/;
/**
 * QA-1.4-13 / QA-1.4-18: a QA step
 *  - starts with the word `QA` (after list, heading or emphasis markers: `QA the release`, `- QA: verify`,
 *    `## QA round 2`), or
 *  - names a QA activity (`QA review`, `QA round`, `QA pass`, `QA sign-off`, `QA gate`, `QA cycle`, `QA phase`), or
 *  - puts a verb or an adjective in front of it (`Run QA on phase 3`, `Perform the QA`, `Do QA for …`,
 *    `Final QA`, `Adversarial QA`, `Senior QA review`), or
 *  - has `QA` followed by `on` / `of` / `for`, a colon, or the end of the line (`Phase 3 QA on the build`).
 * Case-sensitive for `QA`. The word never continues into a finding or ticket id (`QA-1.4-3`, `QA2`) or a longer
 * word (`QAT`). `Write the QA notes`, `Update the QA docs` and `Fix QA-1.4-3 finding` are routine work: a false
 * positive forces the heavy tier, a false negative only leaves the engine's normal choice.
 */
const QA_WORD = "QA(?![A-Za-z0-9_]|-[A-Za-z0-9])";
const QA_LEADING_RE = new RegExp(`^(?:[-*+>#]+\\s*|\\d+[.)]\\s+|\\*\\*|__|\\s)*${QA_WORD}`);
const QA_PHRASE_RE = /\bQA[ -](?:review|round|pass|sign-?off|gate|cycle|phase)\b/;
const QA_VERB_RE = new RegExp(`\\b(?:[Rr]un|[Pp]erform|[Dd]o|[Ff]inal|[Aa]dversarial|[Ss]enior)(?:\\s+(?:the|a|an))?\\s+${QA_WORD}`);
const QA_CONTEXT_RE = new RegExp(`\\b${QA_WORD}(?:\\s+(?:on|of|for)\\b|\\s*:|\\s*$)`);
const LINE_SPLIT_RE = /(\r\n|\n|\r)/;
const DESCRIPTION_MAX_CHARS = 200;

function isMember<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function isQaLine(line: string): boolean {
  return QA_LEADING_RE.test(line) || QA_PHRASE_RE.test(line) || QA_VERB_RE.test(line) || QA_CONTEXT_RE.test(line);
}

/**
 * Verification depth of a step (`d = routing.detection[detection]`): the verifier's own `[acceptance]`
 * parser decides. Any machine check → `deterministic`; only `criteria:` (an LLM grader is scheduled) →
 * `grader`; otherwise `none`.
 */
export function detectionOf(stepText: string): Detection {
  const dod = parseAcceptanceBlock(typeof stepText === "string" ? stepText : "");
  if (dod === null) return "none";
  if (dod.checks.length > 0) return "deterministic";
  if (dod.criteria.length > 0) return "grader";
  return "none";
}

/**
 * `[route class=<c> risk=<r> scope=<s>[ needs=<a,b>] d=<d>[ pin]]` — fixed field order, `needs` omitted
 * when empty, values from the 1.2 vocabularies only (anything else would be ignored by the parser).
 */
export function formatRouteLine(facts: TaskFacts, detection: Detection, pin: boolean): string {
  const cls = isMember(TASK_CLASSES, facts.class) ? facts.class : "other";
  const risk = isMember(RISKS, facts.risk) ? facts.risk : "medium";
  const scope = isMember(SCOPES, facts.scope) ? facts.scope : "single";
  const needs = NEEDS.filter((need) => Array.isArray(facts.needs) && facts.needs.includes(need));
  const d = isMember(DETECTIONS, detection) ? detection : "none";
  const parts = [`class=${cls}`, `risk=${risk}`, `scope=${scope}`];
  if (needs.length > 0) parts.push(`needs=${needs.join(",")}`);
  parts.push(`d=${d}`);
  if (pin) parts.push("pin");
  return `[route ${parts.join(" ")}]`;
}

const PIN_FIELD_RE = /(\s)pin(?:\s*=\s*[^\s\]]*)?(?=[\s\]])/i;

/**
 * The minimal edit that pins an existing route line: an explicit `pin=false`-style field becomes `pin`, a
 * line without the field gets ` pin` before its closing bracket. Everything else (indentation, fields,
 * trailing whitespace) is kept byte for byte. A line that already pins is returned as is.
 */
function withPin(line: string): string {
  if (PIN_FIELD_RE.test(line)) return line.replace(PIN_FIELD_RE, (_whole, space: string) => `${space}pin`);
  return line.replace(/\s*\](\s*)$/, (_whole, tail: string) => ` pin]${tail}`);
}

/** One step's text, split into lines with the structure the annotation needs (QA-1.4-9). */
interface Scan {
  /** Line contents, without terminators. */
  readonly lines: string[];
  /** `terminators[i]` follows `lines[i]`; one fewer than `lines`. */
  readonly terminators: string[];
  /** The step's own line ending (its first terminator, else `\n`). */
  readonly eol: string;
  /** Indices of the recognised route lines: outside fenced code blocks, plain, unindented, unquoted. */
  readonly routeAt: readonly number[];
  /** The task line: first non-empty line that is unfenced (so no fence marker either) and not a route line; -1 = none. */
  readonly taskAt: number;
  /** The first `[tier:X]` tag outside fenced blocks. */
  readonly tierTag: string | null;
}

function scanStep(text: string): Scan {
  const parts = text.split(LINE_SPLIT_RE);
  const lines: string[] = [];
  const terminators: string[] = [];
  parts.forEach((part, index) => {
    if (index % 2 === 0) lines.push(part);
    else terminators.push(part);
  });
  const fenced = fenceMask(lines);
  const routeAt: number[] = [];
  let taskAt = -1;
  let tierTag: string | null = null;
  lines.forEach((line, index) => {
    if (fenced[index] === true) return;
    if (parseRouteLine(line, { positions: "any" }).count > 0) {
      routeAt.push(index);
      return;
    }
    if (taskAt < 0 && line.trim() !== "") taskAt = index;
    if (tierTag === null) tierTag = TIER_TAG_RE.exec(line)?.[1] ?? null;
  });
  return { lines, terminators, eol: terminators[0] ?? "\n", routeAt, taskAt, tierTag };
}

/** What `placeAnnotations` changes in a step. */
interface Edits {
  /** ` [tier:X]` appended to the task line. */
  readonly tag: string | null;
  /** A new route line inserted right after the task line. */
  readonly insertRoute: string | null;
  /** The first existing route line replaced by this (a minimal edit of it). */
  readonly replaceRoute: string | null;
}

function placeAnnotations(scan: Scan, edits: Edits): string {
  const lines = [...scan.lines];
  const terminators = [...scan.terminators];
  if (edits.replaceRoute !== null && scan.routeAt[0] !== undefined) lines[scan.routeAt[0]] = edits.replaceRoute;
  const at = scan.taskAt;
  if (at >= 0) {
    if (edits.tag !== null) lines[at] = `${lines[at]!.trimEnd()} ${edits.tag}`;
    if (edits.insertRoute !== null) {
      // Leading SPACES only, at most 3: the route-line parser ignores 4+ columns and counts a tab as 4.
      const indent = (/^ */.exec(lines[at]!)?.[0] ?? "").slice(0, 3);
      lines.splice(at + 1, 0, `${indent}${edits.insertRoute}`);
      terminators.splice(at, 0, terminators[at] ?? scan.eol);
    }
  }
  return lines.map((line, index) => line + (terminators[index] ?? "")).join("");
}

/** What the classifier itself returns when it fails (`UNKNOWN_FACTS`, confidence 0 ⇒ never switches). */
function unknownResult(text: string): ClassifyResult {
  return {
    facts: UNKNOWN_FACTS,
    pin: false,
    detection: null,
    stripped: text,
    trace: {
      rules: UNKNOWN_FACTS,
      routeLine: null,
      routeLines: { count: 0, conflict: false, edgeOnly: true },
      backend: null,
    },
  };
}

// ---------------------------------------------------------------------------
// annotateSteps
// ---------------------------------------------------------------------------

/**
 * Annotate a plan's steps in one pass. Never throws for well-typed input: a classifier failure leaves the
 * steps with `UNKNOWN_FACTS` (confidence 0, so the engine keeps the static tier and never switches).
 * `steps` must already be split by the caller (2.4 owns plan parsing); fenced code blocks inside a step are
 * respected (nothing inside a fence is a tag, a route line or a task line).
 */
export async function annotateSteps(steps: readonly PlanStep[], deps: AnnotateDeps): Promise<AnnotatedStep[]> {
  if (steps.length === 0) return [];
  const { cfg, routing, agents, store } = deps;

  // --- one batched classification ---------------------------------------------------------------
  const scans = steps.map((step) => scanStep(step.text));
  const inputs: ClassifyInput[] = steps.map((step, index) => {
    const scan = scans[index]!;
    const description = (scan.taskAt < 0 ? "" : scan.lines[scan.taskAt]!).trim().slice(0, DESCRIPTION_MAX_CHARS);
    return { description, prompt: step.text };
  });
  let results: readonly ClassifyResult[];
  try {
    results = await deps.classifyMany(inputs);
  } catch {
    results = steps.map((step) => unknownResult(step.text));
  }

  const floorRank = floorRankOf(cfg);
  const tierIds = routerTierIds(cfg);
  const annotated: AnnotatedStep[] = [];
  steps.forEach((step, index) => {
    const result = results[index] ?? unknownResult(step.text);
    const facts = result.facts;
    const scan = scans[index]!;
    const taskLine = scan.taskAt < 0 ? "" : scan.lines[scan.taskAt]!;

    // Existing tags are authoritative and kept verbatim.
    const existingTier = scan.tierTag;
    const existingRoute = scan.routeAt[0] === undefined ? null : scan.lines[scan.routeAt[0]]!;
    const parsed = parseRouteLine(step.text, { positions: "any" });
    const routePins = result.pin === true || parsed.line?.pin === true;

    const detection: Detection = result.detection ?? detectionOf(step.text);
    // A `[tier:heavy]` step and a QA step are pinned (D13): the engine never moves them.
    const qaStep = isQaLine(taskLine);
    const decisionPin = routePins || existingTier === "heavy" || qaStep;

    // The orchestrator's pick: the plan's tag; else heavy for a QA step; else the class's static tier. A tier
    // the active preset lacks falls back to the config's default tier (never tag a ghost tier).
    const mapped = CLASS_STATIC_TIER[facts.class] ?? cfg.defaultTier;
    const staticTier = tierIds.includes(mapped) || !tierIds.includes(cfg.defaultTier) ? mapped : cfg.defaultTier;
    const qaTier = tierIds.includes("heavy") ? "heavy" : cfg.defaultTier;
    const pickedTier = existingTier ?? (qaStep ? qaTier : staticTier);
    const chosen = resolveChosen({ cfg, agents, agent: pickedTier });
    const decision = chosen === null
      ? null
      : decide({
          facts,
          chosen,
          ladder: buildLadder({
            cfg,
            routing,
            facts,
            agents,
            ...(deps.pricing === undefined ? {} : { pricing: deps.pricing }),
            ...(deps.session === undefined ? {} : { session: deps.session }),
            ...(deps.parentModel === undefined ? {} : { parentModel: deps.parentModel }),
            ...(deps.logger === undefined ? {} : { logger: deps.logger }),
          }),
          detection,
          pin: decisionPin,
          routing,
          store,
          floorRank,
        });

    let tier = pickedTier;
    if (
      existingTier === null &&
      !qaStep &&
      store !== null &&
      decision !== null &&
      decision.switched &&
      decision.best !== null &&
      decision.target !== null &&
      hasMinEvidence(store.posterior(decision.best.key).n)
    ) {
      tier = decision.target.tier;
    }

    // A step that ends up tagged `[tier:heavy]` is pinned, because that is how the next pass and the dispatch
    // read the tag: annotating the annotated plan must change nothing (QA-1.4-9). The decision above was made
    // before the tier was final, so an engine-chosen heavy could still have moved on evidence.
    const pin = decisionPin || tier === "heavy";
    // The route line: an existing one stays (plus ` pin` when the step must be pinned and it is not).
    const editedRoute = existingRoute !== null && pin && !routePins ? withPin(existingRoute) : null;
    const routeLine = (editedRoute ?? existingRoute ?? formatRouteLine(facts, detection, pin)).trim();
    const text = placeAnnotations(scan, {
      tag: existingTier === null ? `[tier:${tier}]` : null,
      insertRoute: existingRoute === null ? routeLine : null,
      replaceRoute: editedRoute,
    });
    const withoutRoute = parseRouteLine(text, { positions: "any" }).stripped;
    annotated.push({
      id: step.id,
      tier,
      tierSource: existingTier === null ? "engine" : "existing",
      routeLine,
      routeSource: existingRoute === null ? "engine" : "existing",
      routeEdited: editedRoute !== null,
      facts,
      detection,
      pin,
      decision,
      text,
      changed: text !== step.text,
      dispatchPrompt: `${routeLine}${scan.eol}${withoutRoute}`,
    });
  });
  return annotated;
}