/**
 * Session-aware ladder algebra, catalog half (M5; plan #74 §1.5 D10/D11,
 * amendments A5, A7, A9, A10).
 *
 * Pure helpers over structural slices of the host's `Model.Info`: the variant
 * ladder of one model, the next variant step, the position of the stored
 * `default` variant, a model's input budget and the resume-vs-fresh decision.
 * No I/O, no clock, no host types. `ladder.ts` composes these into
 * `nextAction`; nothing here knows about tiers or attempts.
 *
 * Invariant: every id this module returns as a step target comes from the
 * catalog's `variants[]` of that model. `default` (A9) is never returned.
 */

/** The host's effort order (@opencode/ai ReasoningEfforts); 0.P S4 found every live variant list in this order. */
export const HOST_EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Variant the host stores for a child created without one (A9). It is not a member of `variants[]` and sends no effort. */
export const DEFAULT_VARIANT = "default";

/**
 * Position of {@link DEFAULT_VARIANT} on the host effort scale: strictly
 * between `medium` and `high`.
 *
 * A child without a variant sends no effort (0.P S2b), so its effective effort
 * is the provider's own default: no thinking on `claude-haiku-4-5`, `high` on
 * the Anthropic Messages API, at most `medium` on OpenAI reasoning models
 * (documented provider defaults; 0.P observed only that nothing is sent).
 * Placing `default` just below `high` makes the first step from it the lowest
 * ladder variant ranked `high` or above: never below any of those defaults,
 * and never a `none`/`low` step that would reduce reasoning.
 */
export const DEFAULT_VARIANT_POSITION = HOST_EFFORT_ORDER.indexOf("high") - 0.5;

/** Structural slice of the host's `Model.Info` that this module reads. */
export interface CatalogModel {
  readonly variants?: ReadonlyArray<{ readonly id?: unknown } | null | undefined> | null;
  readonly limit?: {
    readonly context?: unknown;
    readonly input?: unknown;
    readonly output?: unknown;
  } | null;
}

/** Structural slice of a configured `tiers.<t>.candidates[]` entry. */
export interface VariantCandidate {
  /** Inherits the ladder's model when omitted (§1.1.2). */
  readonly model?: string | null;
  readonly variant?: string | null;
}

export interface VariantLadder {
  /** `provider/model`, as configured. */
  readonly model: string;
  /** Step targets in step order; always a subset of the catalog's `variants[].id`. */
  readonly variants: readonly string[];
  /** `candidates` when explicit candidates named a variant of this model, `none` without a catalog. */
  readonly source: "catalog" | "candidates" | "none";
  /** Candidate variants dropped because the catalog does not offer them (for the advisor and logs). */
  readonly rejected: readonly string[];
}

export interface VariantLadderInput {
  /** `provider/model` the ladder is for. */
  model: string;
  /** Catalog entry of `model`; absent or without a `variants` array means no variant steps. */
  catalog: CatalogModel | null | undefined;
  /**
   * The tier's configured `candidates` exactly as written — never the
   * defaulted single-entry list of `resolveCandidates`, which would pin the
   * ladder to the tier's own variant.
   */
  candidates?: readonly (VariantCandidate | null | undefined)[] | null;
  /**
   * Highest ranked variant a catalog ladder may reach (the resolved
   * `effortBumpMax`). `null`/omitted: no cap. An id outside
   * {@link HOST_EFFORT_ORDER} admits nothing. Explicit candidates are not capped.
   */
  maxEffort?: string | null;
}

/** Index of `id` in {@link HOST_EFFORT_ORDER}, or -1 for an unranked id. */
export function variantRank(id: string): number {
  return (HOST_EFFORT_ORDER as readonly string[]).indexOf(id);
}

/** Position on the effort scale: rank, {@link DEFAULT_VARIANT_POSITION} for `default`, `null` when unranked. */
export function variantPosition(id: string | null | undefined): number | null {
  if (id == null || id === "" || id === DEFAULT_VARIANT) return DEFAULT_VARIANT_POSITION;
  const rank = variantRank(id);
  return rank >= 0 ? rank : null;
}

/** Interval a variant occupies on the effort scale. */
export interface VariantRange {
  readonly low: number;
  readonly high: number;
}

/**
 * The effort interval of a variant (QA-1.5-3). A ranked id is a point. `default` is a range, because
 * the provider's own default effort is unobserved (F9): from "below everything" (-1) up to `high`.
 * `null` for an unranked id.
 */
export function variantRange(id: string | null | undefined): VariantRange | null {
  if (id == null || id === "" || id === DEFAULT_VARIANT) return { low: -1, high: variantRank("high") };
  const rank = variantRank(id);
  return rank >= 0 ? { low: rank, high: rank } : null;
}

/**
 * Whether a tier whose base is `base` adds nothing once `reached` has been tried on the same model:
 * the very same variant, or a base whose highest possible effort is at most the lowest possible
 * effort of `reached`. `default` as a base is only covered by `high` or above; `default` as the
 * reached variant covers nothing but `default` itself.
 */
export function variantCovered(base: string | null | undefined, reached: string | null | undefined): boolean {
  const normalized = (id: string | null | undefined): string => (id == null || id === "" ? DEFAULT_VARIANT : id);
  if (normalized(base) === normalized(reached)) return true;
  const b = variantRange(base);
  const r = variantRange(reached);
  return b !== null && r !== null && b.high <= r.low;
}

/** Catalog variant ids in catalog order, deduplicated; `null` when the entry has no `variants` array. */
export function catalogVariantIds(catalog: CatalogModel | null | undefined): readonly string[] | null {
  const variants = catalog?.variants;
  if (!Array.isArray(variants)) return null;
  const ids: string[] = [];
  for (const entry of variants) {
    const id: unknown = entry?.id;
    if (typeof id !== "string" || id.length === 0 || id === DEFAULT_VARIANT || ids.includes(id)) continue;
    ids.push(id);
  }
  return ids;
}

function namedCandidateVariants(
  model: string,
  candidates: VariantLadderInput["candidates"],
): string[] {
  if (!Array.isArray(candidates)) return [];
  const named: string[] = [];
  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== "object") continue;
    const candidateModel = candidate.model ?? model;
    const variant = candidate.variant;
    if (candidateModel !== model || typeof variant !== "string" || variant.length === 0) continue;
    if (!named.includes(variant)) named.push(variant);
  }
  return named;
}

function freezeLadder(
  model: string,
  variants: string[],
  source: VariantLadder["source"],
  rejected: string[],
): VariantLadder {
  return Object.freeze({
    model,
    variants: Object.freeze(variants),
    source,
    rejected: Object.freeze(rejected),
  });
}

/**
 * The variant ladder of one model (D10).
 *
 * - Explicit candidates naming a variant of `model` define the ladder in
 *   their own order, minus ids the catalog does not offer (`rejected`).
 * - Otherwise the catalog's `variants[].id` in catalog order, keeping only
 *   ranked ids at or below `maxEffort` that strictly raise the rank, so a
 *   catalog ladder never steps down even if a catalog is out of order.
 * - Without a catalog `variants` array there is no ladder.
 */
export function buildVariantLadder(input: VariantLadderInput): VariantLadder {
  const { model } = input;
  const catalogIds = catalogVariantIds(input.catalog);
  const named = namedCandidateVariants(model, input.candidates);
  if (catalogIds === null) return freezeLadder(model, [], "none", named);
  if (named.length > 0) {
    return freezeLadder(
      model,
      named.filter((id) => catalogIds.includes(id)),
      "candidates",
      named.filter((id) => !catalogIds.includes(id)),
    );
  }
  const cap = input.maxEffort == null ? Number.POSITIVE_INFINITY : variantRank(input.maxEffort);
  const variants: string[] = [];
  let last = -1;
  for (const id of catalogIds) {
    const rank = variantRank(id);
    if (rank < 0 || rank > cap || rank <= last) continue;
    variants.push(id);
    last = rank;
  }
  return freezeLadder(model, variants, "catalog", []);
}

/**
 * The next variant step from `current` on `ladder`, or `null` when none.
 *
 * - `current` on the ladder: the following entry.
 * - `current` absent, `null`, empty or `default` (A9): the first ladder entry
 *   positioned above {@link DEFAULT_VARIANT_POSITION}, i.e. ranked `high` or above.
 * - Any other ranked `current` off the ladder (a configured base the ladder
 *   skips): the first ladder entry ranked above it.
 * - An unranked `current` off the ladder: `null` (it cannot be placed).
 *
 * Every non-null result is a ladder member, so repeated stepping terminates
 * within `ladder.variants.length` steps.
 */
export function nextVariant(ladder: VariantLadder, current: string | null | undefined): string | null {
  const ids = ladder.variants;
  if (ids.length === 0) return null;
  const effective = current == null || current === "" ? DEFAULT_VARIANT : current;
  const at = ids.indexOf(effective);
  if (at >= 0) return ids[at + 1] ?? null;
  const position = variantPosition(effective);
  if (position === null) return null;
  for (const id of ids) {
    const rank = variantRank(id);
    if (rank >= 0 && rank > position) return id;
  }
  return null;
}

/** `provider/model#variant` for the host's `subagent` `model` field; bare model for `default`/none. */
export function modelRef(model: string, variant: string | null | undefined): string {
  return variant == null || variant === "" || variant === DEFAULT_VARIANT ? model : `${model}#${variant}`;
}

function finiteAtLeast(value: unknown, min: number, inclusive: boolean): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value > min || (inclusive && value === min) ? value : null;
}

/**
 * Input budget of a model (A5, A10): `limit.input ?? (limit.context − limit.output)`.
 * `null` when unknown or not positive — callers treat that as "do not resume".
 */
export function inputBudget(limit: CatalogModel["limit"]): number | null {
  if (limit === null || typeof limit !== "object") return null;
  if (limit.input !== undefined && limit.input !== null) return finiteAtLeast(limit.input, 0, false);
  const context = finiteAtLeast(limit.context, 0, false);
  const output = finiteAtLeast(limit.output, 0, true);
  if (context === null || output === null) return null;
  return context > output ? context - output : null;
}

/** Structural slice of the host's `TokenUsage.Info` of one finished step. */
export interface StepTokens {
  readonly input?: unknown;
  readonly output?: unknown;
  readonly reasoning?: unknown;
  readonly cache?: { readonly read?: unknown; readonly write?: unknown } | null;
}

/**
 * Context a resumed child carries (D11): `input + cache.read + cache.write + output`
 * of its last step. Reasoning tokens are not counted (D11 lists four fields).
 * Missing cache counts as 0; any other missing or invalid field gives `null`.
 */
export function stepContextTokens(tokens: StepTokens | null | undefined): number | null {
  if (tokens === null || typeof tokens !== "object") return null;
  const input = finiteAtLeast(tokens.input, 0, true);
  const output = finiteAtLeast(tokens.output, 0, true);
  const cache = tokens.cache ?? {};
  if (typeof cache !== "object") return null;
  const read = cache.read === undefined ? 0 : finiteAtLeast(cache.read, 0, true);
  const write = cache.write === undefined ? 0 : finiteAtLeast(cache.write, 0, true);
  if (input === null || output === null || read === null || write === null) return null;
  return input + read + write + output;
}

/** Token estimate of a prompt (A5: characters / 4, rounded up); `null` for an invalid count. */
export function estimateTokensFromChars(chars: number): number | null {
  const valid = finiteAtLeast(chars, 0, true);
  return valid === null ? null : Math.ceil(valid / 4);
}

/** Ladder-state fields the resume decision reads (a structural slice of `LadderState`). */
export interface ResumeState {
  readonly childSessionID?: string | null;
  readonly lastStepTokens?: number | null;
  /** Input budget of the model the next attempt runs on. */
  readonly nextModelContext?: number | null;
}

export interface ResumeConfig {
  /** `routing.sessionReuse.maxContextFraction`. */
  readonly maxContextFraction: number;
  /** Estimate of forcing message + dispatch prompt ({@link estimateTokensFromChars}). */
  readonly nextPromptTokens: number | null;
}

export type ResumeReason =
  | "no-child"
  | "unknown-tokens"
  | "unknown-budget"
  | "unknown-estimate"
  | "invalid-fraction"
  | "under-threshold"
  | "at-or-over-threshold";

/** The decision and the numbers D11 requires to be logged. */
export interface ResumeDecision {
  resume: boolean;
  reason: ResumeReason;
  /** `lastStepTokens + nextPromptTokens`, when both are known. */
  tokens: number | null;
  /** Input budget of the next model. */
  budget: number | null;
  /** `maxContextFraction × budget`, when both are valid. */
  threshold: number | null;
}

/**
 * Resume vs fresh (D11 as amended by A5): resume only when
 * `lastStepTokens + nextPromptTokens < maxContextFraction × nextModelContext`.
 * Exactly at the threshold, and whenever any input is unknown, start fresh.
 */
export function resumeDecision(state: ResumeState, cfg: ResumeConfig): ResumeDecision {
  const child = state.childSessionID;
  const last = finiteAtLeast(state.lastStepTokens, 0, true);
  const budget = finiteAtLeast(state.nextModelContext, 0, false);
  const estimate = finiteAtLeast(cfg.nextPromptTokens, 0, true);
  const fraction = finiteAtLeast(cfg.maxContextFraction, 0, false);
  const validFraction = fraction !== null && fraction <= 1 ? fraction : null;
  const tokens = last !== null && estimate !== null ? last + estimate : null;
  const threshold = budget !== null && validFraction !== null ? validFraction * budget : null;
  const decide = (reason: ResumeReason): ResumeDecision => ({
    resume: reason === "under-threshold",
    reason,
    tokens,
    budget,
    threshold,
  });
  if (typeof child !== "string" || child.length === 0) return decide("no-child");
  if (last === null) return decide("unknown-tokens");
  if (budget === null) return decide("unknown-budget");
  if (estimate === null) return decide("unknown-estimate");
  if (validFraction === null) return decide("invalid-fraction");
  return decide(tokens! < threshold! ? "under-threshold" : "at-or-over-threshold");
}
