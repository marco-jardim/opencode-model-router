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
import { applyRouteLine, parseRouteLine } from "./route-line";
import { analyzeRules } from "./rules";
import { hasCredentialSignal } from "./scrub";
import { buildClassifierState } from "./state";
import {
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

/** A backend result is trusted only when its status, class and confidence are in range. */
function isValidResult(value: unknown): value is BackendResult {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Partial<BackendResult>;
  if (typeof r.status !== "string" || !BACKEND_STATUSES.includes(r.status)) return false;
  const facts = r.facts;
  if (typeof facts !== "object" || facts === null) return false;
  if (!TASK_CLASSES.includes(facts.class)) return false;
  const confidence = facts.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return false;
  }
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
  readonly minClassConfidence: number;
  /** `classifyMany`: a label that does not agree with the rules is capped at CONFIDENCE.backendBatchCap. */
  readonly batch: boolean;
}

/**
 * Step 5 merge: what a backend result does to the rules facts (A19). A label
 * replaces the rules class only when the rules matched it (or matched nothing);
 * its confidence stays below `minClassConfidence` unless it agrees with the
 * rules, so a backend alone can never clear the bar the rules failed.
 */
function mergeBackend(
  facts: TaskFacts,
  result: BackendResult,
  ctx: MergeContext,
): { readonly facts: TaskFacts; readonly rejected: boolean } {
  if (result.status === "disagree") return { facts: { ...facts, confidence: 0 }, rejected: false };
  if (result.status !== "ok") return { facts, rejected: false };

  const taskClass = result.facts.class;
  const allowed = allowedClasses(ctx.matched);
  if (allowed !== null && !allowed.has(taskClass)) return { facts, rejected: true };

  const agrees = taskClass === facts.class && taskClass !== "other";
  let confidence = result.facts.confidence;
  if (agrees) {
    confidence = Math.max(confidence, CONFIDENCE.backendAgreesWithRules);
  } else {
    confidence = Math.min(confidence, Math.max(0, round2(ctx.minClassConfidence - 0.01)));
    if (ctx.batch) confidence = Math.min(confidence, CONFIDENCE.backendBatchCap);
  }
  return {
    facts: {
      class: taskClass,
      risk: maxOf<Risk>(RISKS, facts.risk, CLASS_BASE_RISK[taskClass], result.facts.risk ?? "low"),
      scope: maxOf<Scope>(SCOPES, facts.scope, result.facts.scope ?? "single"),
      needs: orderedNeeds([...facts.needs, ...CLASS_IMPLIED_NEEDS[taskClass]]),
      confidence,
      source: result.facts.source,
    },
    rejected: false,
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

/** Steps 1–3: route line, rules, route line applied. */
function prepare(input: ClassifyInput, deps: ClassifyDeps): Prepared {
  const parsed = parseRouteLine(typeof input.prompt === "string" ? input.prompt : "");
  const description = typeof input.description === "string" ? input.description.trim() : "";
  const ruleText = [description, parsed.stripped].filter(Boolean).join("\n");
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
function mentionsCredentials(prepared: Prepared): boolean {
  const description = typeof prepared.input.description === "string" ? prepared.input.description : "";
  return hasCredentialSignal(description.slice(0, RULES_MAX_CHARS) + "\n" + prepared.parsed.stripped.slice(0, RULES_MAX_CHARS));
}

function resultOf(
  prepared: Prepared,
  backend: ClassifierBackend | null,
  outcome: BackendResult | null,
  deps: ClassifyDeps,
  options: { readonly skipped?: "credentials"; readonly batch?: boolean } = {},
): ClassifyResult {
  const skipped = options.skipped;
  const merged =
    outcome === null
      ? { facts: prepared.facts, rejected: false }
      : mergeBackend(prepared.facts, outcome, {
          matched: prepared.matched,
          minClassConfidence: deps.minClassConfidence,
          batch: options.batch === true,
        });
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
              ...(merged.rejected ? { rejected: true as const } : {}),
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
    if (backend === null || !isGated(prepared.facts, deps)) return resultOf(prepared, null, null, deps);
    if (mentionsCredentials(prepared)) return resultOf(prepared, null, null, deps, { skipped: "credentials" });

    const state = buildClassifierState(
      { description: input.description, prompt: prepared.parsed.stripped },
      deps.settings.maxStateChars,
    );
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
    return resultOf(prepared, backend, outcome, deps);
  } catch (error) {
    safeWarn(deps.logger, `classifier failed: ${reasonOf(error)}`);
    return unknownResult(promptOf(input));
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
        results[index] = unknownResult(promptOf(input));
      }
    });

    const backend = deps.backend;
    const gated: GatedItem[] = [];
    const skipped = new Set<number>();
    prepared.forEach((item, index) => {
      if (item === undefined || backend === null || !isGated(item.facts, deps)) return;
      try {
        if (mentionsCredentials(item)) {
          skipped.add(index);
          return;
        }
        const input = list[index]!;
        const state = buildClassifierState(
          { description: input.description, prompt: item.parsed.stripped },
          deps.settings.maxStateChars,
        );
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
      results[index] = resultOf(item, backend, outcomes.get(index) ?? null, deps, {
        batch: true,
        ...(skipped.has(index) ? { skipped: "credentials" as const } : {}),
      });
    });
  } catch (error) {
    safeWarn(deps.logger, `classifier failed: ${reasonOf(error)}`);
  }

  return results.map((result, index) => {
    if (result !== undefined) return result;
    const item = prepared[index];
    return item === undefined ? unknownResult(promptOf(list[index]!)) : resultOf(item, null, null, deps, { batch: true });
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
