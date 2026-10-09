/**
 * Task classifier (M2) — composition. Design section 6 of
 * `docs/qa/cost-aware-routing/phase-1.2.md`.
 *
 * `classify` / `classifyMany` run the deterministic rules, apply the `[route]`
 * line, and consult a model backend ONLY when the rules are unsure (D4). They
 * never throw and always settle within `timeoutMs + INDEX_TIMEOUT_GRACE_MS`
 * of a hung backend: every failure leaves the rules facts (or `UNKNOWN_FACTS`
 * with confidence 0, which never switches a model, D9).
 */

import type { RouterConfig } from "../../router/config";
import { createHostBackend } from "./backends/host";
import { createOpenAICompatibleBackend } from "./backends/openai-compatible";
import {
  raceTimeout,
  reasonOf,
  round2,
  safeWarn,
} from "./backends/shared";
import { createTypeSafeBackend } from "./backends/typesafe";
import { applyRouteLine, parseRouteLine, type RouteLinePositions } from "./route-line";
import { analyzeRules, needMatchesOf, type NeedMatch } from "./rules";

export type { NeedMatch } from "./rules";
import { hasCredentialSignal } from "./scrub";
import { buildClassifierState, classifierStateRawParts } from "./state";
import {
  BACKEND_IDS,
  CLASS_BASE_RISK,
  CLASS_IMPLIED_NEEDS,
  CLASS_OPTIONS,
  CONFIDENCE,
  INDEX_TIMEOUT_GRACE_MS,
  MAX_BATCH_ITEMS,
  RULES_MAX_CHARS,
  NEEDS,
  RISKS,
  SCOPES,
  TASK_CLASSES,
  UNKNOWN_FACTS,
  type BackendResult,
  type BackendStatus,
  type ClassifierBackend,
  type ClassifierLogger,
  type ClassifierSettings,
  type ClassifierState,
  type ClassifyInput,
  type ClassifyResult,
  type EnvLike,
  type FetchLike,
  type HostGenerate,
  type Need,
  type Risk,
  type RouteLineParse,
  type Scope,
  type TaskClass,
  type TaskFacts,
} from "./types";

export * from "./types";

export interface ClassifyDeps {
  readonly cfg: Pick<RouterConfig, "taskPatterns">;
  /** Resolved, preset overrides applied. */
  readonly settings: ClassifierSettings;
  readonly minClassConfidence: number;
  /** From `createClassifierBackend`, built once per config load. */
  readonly backend: ClassifierBackend | null;
  readonly logger: ClassifierLogger;
  /** Uniform [0, 1) source for the option shuffle and nonces; default `Math.random`. */
  readonly random?: () => number;
  /**
   * Where a `[route]` line is recognised (A22): `first` (default) = only the first
   * non-empty line of the prompt; `edges` = first or last; `any` = anywhere
   * outside fences, quotes and indented code (tests and tooling).
   */
  readonly routeLinePositions?: RouteLinePositions;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BACKEND_STATUSES: readonly BackendStatus[] = ["ok", "disagree", "invalid", "timeout", "error", "disabled"];

function maxOf<T extends string>(order: readonly T[], ...values: T[]): T {
  let best = values[0]!;
  for (const value of values) {
    if (order.indexOf(value) > order.indexOf(best)) best = value;
  }
  return best;
}

function orderedNeeds(needs: Iterable<Need>): Need[] {
  const set = new Set<Need>(needs);
  return NEEDS.filter((need) => set.has(need));
}

function synthetic(status: BackendStatus, reason: string, latencyMs: number): BackendResult {
  return {
    facts: { class: "other", confidence: 0, source: "unknown" },
    raw: null,
    status,
    reason,
    latencyMs,
    calls: 0,
  };
}

const BACKEND_SOURCES: readonly string[] = [...BACKEND_IDS, "unknown"];

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * A backend result is trusted only when every field the merge or the decision
 * log reads is well formed: status, class, confidence in [0, 1], source, the
 * optional risk and scope, and the bookkeeping numbers (QA-1.2-20).
 */
function isValidResult(value: unknown): value is BackendResult {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Partial<BackendResult>;
  if (typeof r.status !== "string" || !BACKEND_STATUSES.includes(r.status)) return false;
  if (!isNonNegativeNumber(r.latencyMs) || !isNonNegativeNumber(r.calls)) return false;
  if (r.raw !== null && typeof r.raw !== "string") return false;
  if (r.reason !== undefined && typeof r.reason !== "string") return false;
  const facts = r.facts;
  if (typeof facts !== "object" || facts === null) return false;
  if (!TASK_CLASSES.includes(facts.class)) return false;
  const confidence = facts.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return false;
  }
  if (!BACKEND_SOURCES.includes(facts.source)) return false;
  if (facts.risk !== undefined && !RISKS.includes(facts.risk)) return false;
  if (facts.scope !== undefined && !SCOPES.includes(facts.scope)) return false;
  return true;
}
/** The classes a backend may pick: those the rules matched (search and recon are one family); null = any. */
function allowedClasses(matched: readonly TaskClass[]): ReadonlySet<TaskClass> | null {
  if (matched.length === 0) return null;
  const allowed = new Set<TaskClass>(matched);
  if (allowed.has("search") || allowed.has("recon")) {
    allowed.add("search");
    allowed.add("recon");
  }
  return allowed;
}

interface MergeContext {
  readonly matched: readonly TaskClass[];
}

interface Merged {
  readonly facts: TaskFacts;
  /** The backend's `ok` label is not a class the rules matched (A19). */
  readonly rejected: boolean;
  /** The backend's `ok` label, whatever became of it. */
  readonly label?: TaskClass;
  /** A matched label that differs from the rules class: kept in the trace only (QA-1.2-27). */
  readonly disagrees: boolean;
}

/**
 * Step 5 merge: what a backend result does to the rules facts (A19, QA-1.2-27).
 *
 * The rules class always stands in `facts`. The backend can only AGREE with it
 * (same class, not `other`): then confidence rises to at least 0.8 and its risk,
 * scope and needs are merged in. A label the rules did not match is `rejected`;
 * a matched label that differs from the rules class is recorded in the trace
 * (`label`, `disagrees`) and nothing else: a class the engine would have to
 * trust at a confidence below `minClassConfidence` must not exist in `facts`, so
 * no outcome can later be recorded under it.
 */
function mergeBackend(facts: TaskFacts, result: BackendResult, ctx: MergeContext): Merged {
  if (result.status === "disagree") return { facts: { ...facts, confidence: 0 }, rejected: false, disagrees: false };
  if (result.status !== "ok") return { facts, rejected: false, disagrees: false };

  const label = result.facts.class;
  const allowed = allowedClasses(ctx.matched);
  if (allowed !== null && !allowed.has(label)) return { facts, rejected: true, label, disagrees: false };
  if (label !== facts.class || label === "other") {
    return { facts, rejected: false, label, disagrees: label !== facts.class };
  }
  return {
    facts: {
      class: facts.class,
      risk: maxOf<Risk>(RISKS, facts.risk, CLASS_BASE_RISK[label], result.facts.risk ?? "low"),
      scope: maxOf<Scope>(SCOPES, facts.scope, result.facts.scope ?? "single"),
      needs: orderedNeeds([...facts.needs, ...CLASS_IMPLIED_NEEDS[label]]),
      confidence: Math.max(result.facts.confidence, CONFIDENCE.backendAgreesWithRules),
      source: result.facts.source,
    },
    rejected: false,
    label,
    disagrees: false,
  };
}
/** Step 6 invariants: every path ends here. */
function finalize(facts: TaskFacts): TaskFacts {
  let confidence = Number.isFinite(facts.confidence) ? Math.min(1, Math.max(0, facts.confidence)) : 0;
  if (facts.class === "mechanical" && facts.risk === "high") {
    confidence = Math.min(confidence, CONFIDENCE.mechanicalHighRiskCap);
  }
  return Object.freeze({
    class: facts.class,
    risk: facts.risk,
    scope: facts.scope,
    needs: Object.freeze(orderedNeeds(facts.needs)),
    confidence: round2(confidence),
    source: facts.source,
  });
}

function unknownResult(stripped: string): ClassifyResult {
  return {
    facts: UNKNOWN_FACTS,
    pin: false,
    detection: null,
    stripped,
    trace: {
      rules: UNKNOWN_FACTS,
      routeLine: null,
      routeLines: { count: 0, conflict: false, edgeOnly: true },
      backend: null,
    },
  };
}

/**
 * The prompt with its route lines removed, for the failure paths: whatever broke
 * the classification, the rewritten prompt must not carry a `[route …]` line to
 * the subagent. Its own `try`: stripping may succeed where the rest failed, and
 * if it does fail, a plain line filter (which cannot throw on a string) stands in.
 */
function strippedOf(input: ClassifyInput, deps: ClassifyDeps): string {
  const prompt = promptOf(input);
  try {
    return parseRouteLine(prompt, routeLineOptions(deps)).stripped;
  } catch (error) {
    safeWarn(deps.logger, `classifier could not strip route lines: ${reasonOf(error)}`);
    return prompt
      .split(/\r?\n/)
      .filter((line) => !/^\s*\[route\b/i.test(line))
      .join("\n");
  }
}

/** The prompt of an input that may be hostile (a throwing getter was already logged by the caller). */
function promptOf(input: ClassifyInput): string {
  try {
    return typeof input.prompt === "string" ? input.prompt : "";
  } catch {
    // The same access failure is logged by the caller as "classifier failed".
    return "";
  }
}

interface Prepared {
  readonly input: ClassifyInput;
  readonly parsed: RouteLineParse;
  readonly rules: TaskFacts;
  /** Classes the rules matched (A19), highest cost first. */
  readonly matched: readonly TaskClass[];
  readonly facts: TaskFacts;
}

function routeLineOptions(deps: ClassifyDeps): { readonly positions: RouteLinePositions } {
  return { positions: deps.routeLinePositions ?? "first" };
}

/** The text the rules layer reads: the description, then the prompt without its route lines. */
function ruleTextOf(input: ClassifyInput, parsed: RouteLineParse): string {
  const description = typeof input.description === "string" ? input.description.trim() : "";
  return [description.slice(0, RULES_MAX_CHARS), parsed.stripped.slice(0, RULES_MAX_CHARS)]
    .filter(Boolean)
    .join("\n");
}

/**
 * #84 QA-G-B-3: the needs the rules layer finds in the text of `input` itself, and why (rules.ts `needMatchesOf` on the same text
 * and `cwd` as `classify`; never the class-implied needs). Never calls a backend.
 */
export function classifyNeedMatches(input: ClassifyInput, deps: Pick<ClassifyDeps, "routeLinePositions">): NeedMatch[] {
  const parsed = parseRouteLine(typeof input.prompt === "string" ? input.prompt : "", { positions: deps.routeLinePositions ?? "first" });
  return needMatchesOf(ruleTextOf(input, parsed), { ...(input.cwd === undefined ? {} : { cwd: input.cwd }) });
}

/** Steps 1–3: route line, rules, route line applied. */
function prepare(input: ClassifyInput, deps: ClassifyDeps): Prepared {
  const parsed = parseRouteLine(typeof input.prompt === "string" ? input.prompt : "", routeLineOptions(deps));
  const ruleText = ruleTextOf(input, parsed);
  const analysis = analyzeRules(ruleText, deps.cfg, { cwd: input.cwd });
  const rules = analysis.facts;
  const facts = parsed.line ? applyRouteLine(rules, parsed.line) : rules;
  return { input, parsed, rules, matched: analysis.matched, facts };
}

/** Step 4: only unsure rules facts go to a backend. */
function isGated(facts: TaskFacts, deps: ClassifyDeps): boolean {
  return (
    deps.backend !== null &&
    deps.settings.backend !== "rules" &&
    facts.source === "rules" &&
    facts.confidence < deps.minClassConfidence
  );
}

/**
 * Policy gate (QA-1.2-1): a task that names a credential, or contains something
 * the scrubber had to redact, never reaches a backend; the rules facts stand.
 */
function mentionsCredentials(prepared: Prepared, acceptanceIncluded: boolean): boolean {
  const description = typeof prepared.input.description === "string" ? prepared.input.description : "";
  const raw = classifierStateRawParts({ description, prompt: prepared.parsed.stripped });
  return [raw.description, acceptanceIncluded ? raw.acceptance : null, raw.body].some((part) => part !== null && hasCredentialSignal(part));
}

function resultOf(
  prepared: Prepared,
  backend: ClassifierBackend | null,
  outcome: BackendResult | null,
  options: { readonly skipped?: "credentials" } = {},
): ClassifyResult {
  const skipped = options.skipped;
  const merged: Merged =
    outcome === null
      ? { facts: prepared.facts, rejected: false, disagrees: false }
      : mergeBackend(prepared.facts, outcome, { matched: prepared.matched });
  return {
    facts: finalize(merged.facts),
    pin: prepared.parsed.line?.pin ?? false,
    detection: prepared.parsed.line?.detection ?? null,
    stripped: prepared.parsed.stripped,
    trace: {
      rules: prepared.rules,
      routeLine: prepared.parsed.line,
      routeLines: {
        count: prepared.parsed.count,
        conflict: prepared.parsed.conflict,
        edgeOnly: prepared.parsed.edgeOnly,
        // QA-P12-2-2 (P2.1): surface a malformed first route line; absent otherwise (tier rows copy only the three fields above).
        ...(prepared.parsed.malformed === true ? { malformed: true as const } : {}),
      },
      ...(skipped ? { backendSkipped: skipped } : {}),
      backend:
        backend === null || outcome === null
          ? null
          : {
              id: backend.id,
              status: outcome.status,
              ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
              latencyMs: outcome.latencyMs,
              calls: outcome.calls,
              ...(merged.label === undefined ? {} : { label: merged.label }),
              ...(merged.rejected ? { rejected: true as const } : {}),
              ...(merged.disagrees ? { disagrees: true as const } : {}),
            },
    },
  };
}

function logSynthetic(deps: ClassifyDeps, backend: ClassifierBackend, result: BackendResult): void {
  safeWarn(deps.logger, `classifier ${backend.id}: ${result.status} (${result.reason ?? "no reason"})`, {
    latencyMs: result.latencyMs,
    calls: result.calls,
  });
}

function hangBudget(deps: ClassifyDeps): number {
  return deps.settings.timeoutMs + INDEX_TIMEOUT_GRACE_MS;
}

// ---------------------------------------------------------------------------
// classify
// ---------------------------------------------------------------------------

export async function classify(input: ClassifyInput, deps: ClassifyDeps): Promise<ClassifyResult> {
  try {
    const prepared = prepare(input, deps);
    const backend = deps.backend;
    if (backend === null || !isGated(prepared.facts, deps)) return resultOf(prepared, null, null);
    const state = buildClassifierState(
      { description: input.description, prompt: prepared.parsed.stripped },
      deps.settings.maxStateChars,
    );
    if (mentionsCredentials(prepared, state.acceptanceIncluded)) return resultOf(prepared, null, null, { skipped: "credentials" });
    const random = deps.random ?? Math.random;
    const budget = hangBudget(deps);
    const raced = await raceTimeout(
      (async () => backend.classify(state, { choices: CLASS_OPTIONS, random }))(),
      budget,
    );
    let outcome: BackendResult;
    if (raced.kind === "value" && isValidResult(raced.v)) {
      outcome = raced.v;
    } else {
      // The backend broke its contract (hung, rejected or returned garbage): the rules facts stand.
      outcome =
        raced.kind === "value"
          ? synthetic("invalid", "malformed backend result", 0)
          : raced.kind === "error"
            ? synthetic("error", reasonOf(raced.e), 0)
            : synthetic("timeout", `backend did not settle within ${budget} ms`, budget);
      logSynthetic(deps, backend, outcome);
    }
    return resultOf(prepared, backend, outcome);
  } catch (error) {
    safeWarn(deps.logger, `classifier failed: ${reasonOf(error)}`);
    return unknownResult(strippedOf(input, deps));
  }
}

// ---------------------------------------------------------------------------
// classifyMany
// ---------------------------------------------------------------------------

interface GatedItem {
  readonly index: number;
  readonly prepared: Prepared;
  readonly state: ClassifierState;
}

export async function classifyMany(
  inputs: readonly ClassifyInput[],
  deps: ClassifyDeps,
): Promise<ClassifyResult[]> {
  const list: readonly ClassifyInput[] = Array.isArray(inputs) ? inputs : [];
  const results: Array<ClassifyResult | undefined> = list.map(() => undefined);
  const prepared: Array<Prepared | undefined> = list.map(() => undefined);

  try {
    // Steps 1–3, one try per item: a failure costs only that item.
    list.forEach((input, index) => {
      try {
        prepared[index] = prepare(input, deps);
      } catch (error) {
        safeWarn(deps.logger, `classifier failed: ${reasonOf(error)}`);
        results[index] = unknownResult(strippedOf(input, deps));
      }
    });

    const backend = deps.backend;
    const gated: GatedItem[] = [];
    const skipped = new Set<number>();
    prepared.forEach((item, index) => {
      if (item === undefined || backend === null || !isGated(item.facts, deps)) return;
      try {
        const input = list[index]!;
        const state = buildClassifierState(
          { description: input.description, prompt: item.parsed.stripped },
          deps.settings.maxStateChars,
        );
        if (mentionsCredentials(item, state.acceptanceIncluded)) {
          skipped.add(index);
          return;
        }
        gated.push({ index, prepared: item, state });
      } catch (error) {
        safeWarn(deps.logger, `classifier failed: ${reasonOf(error)}`);
      }
    });

    const outcomes = new Map<number, BackendResult>();
    if (backend !== null && gated.length > 0) {
      const random = deps.random ?? Math.random;
      const budget = hangBudget(deps);
      // A failed chunk (QA-1.2-10) means the backend is down or broken: asking it again for each remaining
      // chunk would only burn one timeout per chunk, so the rest of the plan keeps its rules facts.
      let skipRest: BackendResult | null = null;
      for (let from = 0; from < gated.length; from += MAX_BATCH_ITEMS) {
        const chunk = gated.slice(from, from + MAX_BATCH_ITEMS);
        if (skipRest !== null) {
          const skippedAnswer = skipRest;
          chunk.forEach((item) => outcomes.set(item.index, skippedAnswer));
          continue;
        }
        const states = chunk.map((item) => item.state);
        const raced = await raceTimeout(
          (async () => backend.classifyMany(states, { choices: CLASS_OPTIONS, random }))(),
          budget,
        );
        let answers: BackendResult[];
        if (raced.kind === "timeout") {
          const failed = synthetic("timeout", `backend did not settle within ${budget} ms`, budget);
          logSynthetic(deps, backend, failed);
          answers = chunk.map(() => failed);
        } else if (raced.kind === "error") {
          const failed = synthetic("error", reasonOf(raced.e), 0);
          logSynthetic(deps, backend, failed);
          answers = chunk.map(() => failed);
        } else if (Array.isArray(raced.v) && raced.v.length === chunk.length) {
          answers = raced.v.map((entry: unknown) =>
            isValidResult(entry) ? entry : synthetic("invalid", "malformed backend result", 0),
          );
        } else {
          const failed = synthetic("invalid", "malformed backend batch result", 0);
          logSynthetic(deps, backend, failed);
          answers = chunk.map(() => failed);
        }
        chunk.forEach((item, i) => outcomes.set(item.index, answers[i]!));
        const failedChunk =
          raced.kind !== "value" ||
          !Array.isArray(raced.v) ||
          raced.v.length !== chunk.length ||
          answers.every((a) => a.status === "timeout" || a.status === "error" || a.status === "disabled");
        if (failedChunk && from + MAX_BATCH_ITEMS < gated.length) {
          skipRest = synthetic("disabled", "skipped: the previous batch failed", 0);
          safeWarn(
            deps.logger,
            `classifier ${backend.id}: skipping ${gated.length - from - MAX_BATCH_ITEMS} remaining items after a failed batch`,
          );
        }
      }
    }

    prepared.forEach((item, index) => {
      if (item === undefined) return;
      results[index] = resultOf(
        item,
        backend,
        outcomes.get(index) ?? null,
        skipped.has(index) ? { skipped: "credentials" as const } : {},
      );
    });
  } catch (error) {
    safeWarn(deps.logger, `classifier failed: ${reasonOf(error)}`);
  }

  return results.map((result, index) => {
    if (result !== undefined) return result;
    const item = prepared[index];
    return item === undefined
      ? unknownResult(strippedOf(list[index]!, deps))
      : resultOf(item, null, null);
  });
}

// ---------------------------------------------------------------------------
// createClassifierBackend
// ---------------------------------------------------------------------------

export interface ClassifierBackendDeps {
  readonly generate?: HostGenerate;
  readonly fetch?: FetchLike;
  readonly env?: EnvLike;
  readonly logger: ClassifierLogger;
  readonly now?: () => number;
}

/**
 * Build the configured backend once per config load (the log-once set and the
 * `response_format` memo live on the instance). Missing API keys are NOT
 * checked here: `apiKeyEnv` is read at call time, so setting the variable later
 * enables the backend without a reload.
 */
export function createClassifierBackend(
  settings: ClassifierSettings,
  deps: ClassifierBackendDeps,
): ClassifierBackend | null {
  const { logger, now } = deps;
  switch (settings.backend) {
    case "rules":
      return null;
    case "host":
      if (deps.generate === undefined) {
        safeWarn(logger, "classifier: host classifier needs the v2 plugin context; using rules");
        return null;
      }
      return createHostBackend({ generate: deps.generate, settings, logger, now });
    case "openai-compatible":
    case "typesafe": {
      const fetchFn = deps.fetch ?? defaultFetch();
      if (fetchFn === null) {
        safeWarn(logger, `classifier: ${settings.backend} needs fetch, which is not available; using rules`);
        return null;
      }
      const env: EnvLike = deps.env ?? process.env;
      return settings.backend === "typesafe"
        ? createTypeSafeBackend({ fetch: fetchFn, env, settings, logger, now })
        : createOpenAICompatibleBackend({ fetch: fetchFn, env, settings, logger, now });
    }
    default:
      safeWarn(logger, `classifier: unknown backend ${String(settings.backend)}; using rules`);
      return null;
  }
}

function defaultFetch(): FetchLike | null {
  if (typeof globalThis.fetch !== "function") return null;
  return (url, init) => globalThis.fetch(url, init);
}
