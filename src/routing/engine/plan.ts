/**
 * Plan fan-out (M4) — annotate every step of a plan with `[tier:X]` and a `[route …]` line in one pass.
 *
 * Design: `docs/qa/cost-aware-routing/phase-1.4.md` → "Design (1.4.1)" §5. Plan #74 §0.10.12 and 2.4.4
 * (`/annotate-plan`), D13 (`[route pin]`), A22 (a route line is recognised in trusted positions only).
 *
 *  - ONE batched classification per call (`deps.classifyMany`, which chunks to `MAX_BATCH_ITEMS` itself).
 *  - A `[tier:X]` or `[route …]` already in a step is authoritative and is never re-emitted or duplicated, so
 *    annotating an annotated plan returns byte-identical text.
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
  readonly facts: TaskFacts;
  readonly detection: Detection;
  readonly pin: boolean;
  readonly decision: Decision | null;
  /** Annotated step text. */
  readonly text: string;
  /** Route line FIRST (A22), then the annotated step text without route lines. */
  readonly dispatchPrompt: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const TIER_TAG_RE = /\[tier:([A-Za-z0-9_-]+)\]/;
const QA_RE = /\bQA\b/;
const LINE_SPLIT_RE = /(\r\n|\n|\r)/;
const DESCRIPTION_MAX_CHARS = 200;

function isMember<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
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

interface SplitText {
  /** Line contents, without terminators. */
  readonly lines: string[];
  /** `terminators[i]` follows `lines[i]`; one fewer than `lines`. */
  readonly terminators: string[];
}

function splitText(text: string): SplitText {
  const parts = text.split(LINE_SPLIT_RE);
  const lines: string[] = [];
  const terminators: string[] = [];
  parts.forEach((part, index) => {
    if (index % 2 === 0) lines.push(part);
    else terminators.push(part);
  });
  return { lines, terminators };
}

function isRouteLine(line: string): boolean {
  return parseRouteLine(line, { positions: "any" }).count > 0;
}

/** Index of the step's task line: the first non-empty line that is not itself a route line; -1 when none. */
function taskLineIndex(lines: readonly string[]): number {
  return lines.findIndex((line) => line.trim() !== "" && !isRouteLine(line));
}

/** First recognised route line of `text` (verbatim, trimmed) — the line `parseRouteLine` strips first. */
function firstRouteLine(text: string, stripped: string): string | null {
  const before = splitText(text).lines;
  const after = splitText(stripped).lines;
  let j = 0;
  for (const line of before) {
    if (j < after.length && after[j] === line) {
      j += 1;
      continue;
    }
    return line.trim();
  }
  return null;
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

/** Insert ` [tier:X]` on the task line and/or the route line right after it (§5 "Placement"). */
function placeAnnotations(text: string, tag: string | null, routeLine: string | null): string {
  if (tag === null && routeLine === null) return text;
  const { lines, terminators } = splitText(text);
  const at = taskLineIndex(lines);
  if (at < 0) return text; // nothing to annotate: blank step
  if (tag !== null) lines[at] = `${lines[at]!.trimEnd()} ${tag}`;
  if (routeLine !== null) {
    // Leading SPACES only, at most 3: the route-line parser ignores 4+ columns and counts a tab as 4.
    const indent = (/^ */.exec(lines[at]!)?.[0] ?? "").slice(0, 3);
    const eol = terminators[at] ?? terminators[0] ?? "\n";
    lines.splice(at + 1, 0, `${indent}${routeLine}`);
    terminators.splice(at, 0, eol);
  }
  return lines.map((line, index) => line + (terminators[index] ?? "")).join("");
}

// ---------------------------------------------------------------------------
// annotateSteps
// ---------------------------------------------------------------------------

/**
 * Annotate a plan's steps in one pass. Never throws for well-typed input: a classifier failure leaves the
 * steps with `UNKNOWN_FACTS` (confidence 0, so the engine keeps the static tier and never switches).
 * `steps` must already be split by the caller (2.4 owns plan parsing and fenced blocks).
 */
export async function annotateSteps(steps: readonly PlanStep[], deps: AnnotateDeps): Promise<AnnotatedStep[]> {
  if (steps.length === 0) return [];
  const { cfg, routing, agents, store } = deps;

  // --- one batched classification ---------------------------------------------------------------
  const split = steps.map((step) => splitText(step.text));
  const inputs: ClassifyInput[] = steps.map((step, index) => {
    const lines = split[index]!.lines;
    const at = taskLineIndex(lines);
    const description = (at < 0 ? "" : lines[at]!).trim().slice(0, DESCRIPTION_MAX_CHARS);
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
    const lines = split[index]!.lines;
    const at = taskLineIndex(lines);
    const taskLine = at < 0 ? "" : lines[at]!;

    // Existing tags are authoritative and kept verbatim.
    const tierMatch = TIER_TAG_RE.exec(step.text);
    const existingTier = tierMatch === null ? null : tierMatch[1]!;
    const parsed = parseRouteLine(step.text, { positions: "any" });
    const existingRouteLine = parsed.count > 0 ? firstRouteLine(step.text, parsed.stripped) : null;

    const detection: Detection = result.detection ?? detectionOf(step.text);
    const pin = result.pin === true || parsed.line?.pin === true || existingTier === "heavy" || QA_RE.test(taskLine);

    // The static tier of the class (the orchestrator's pick), unless the plan already chose one.
    // A mapped tier the active preset lacks falls back to the config's default tier (never tag a ghost tier).
    const mapped = CLASS_STATIC_TIER[facts.class] ?? cfg.defaultTier;
    const staticTier = tierIds.includes(mapped) || !tierIds.includes(cfg.defaultTier) ? mapped : cfg.defaultTier;
    const pickedTier = existingTier ?? staticTier;
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
          pin,
          routing,
          store,
          floorRank,
        });

    let tier = pickedTier;
    if (
      existingTier === null &&
      store !== null &&
      decision !== null &&
      decision.switched &&
      decision.best !== null &&
      decision.target !== null &&
      hasMinEvidence(store.posterior(decision.best.key).n)
    ) {
      tier = decision.target.tier;
    }

    const routeLine = existingRouteLine ?? formatRouteLine(facts, detection, pin);
    const text = placeAnnotations(
      step.text,
      existingTier === null ? `[tier:${tier}]` : null,
      existingRouteLine === null ? routeLine : null,
    );
    const withoutRoute = parseRouteLine(text, { positions: "any" }).stripped;
    annotated.push({
      id: step.id,
      tier,
      tierSource: existingTier === null ? "engine" : "existing",
      routeLine,
      routeSource: existingRouteLine === null ? "engine" : "existing",
      facts,
      detection,
      pin,
      decision,
      text,
      dispatchPrompt: `${routeLine}\n${withoutRoute}`,
    });
  });
  return annotated;
}
