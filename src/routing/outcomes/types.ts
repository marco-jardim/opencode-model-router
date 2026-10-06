// ---------------------------------------------------------------------------
// Outcome store and cost accounting (M3) — shared types, outcome keys and persistence constants.
//
// Design: D:\git\opencode-model-router\docs\qa\cost-aware-routing\phase-1.3.md "Design (1.3.1)".
// Pure module: no I/O and no runtime import. Every module under src/routing/outcomes/ must stay
// runnable under Node's type stripping (scripts/routing-stats.ts runs without tsx), so:
//   - type-only symbols are imported/re-exported with `import type` / `export type`;
//   - no enum, namespace, parameter property or `import x = require(...)`;
//   - runtime imports stay inside src/routing/outcomes/ (plus `node:` builtins in persist.ts).
// ---------------------------------------------------------------------------

import type { Verdict as VerificationVerdict } from "../../verify/types";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Injected clock: epoch milliseconds. Defaults to `Date.now` in the implementations. */
export type Clock = () => number;

/** One reading of an injected clock; a non-finite reading (NaN, ±Infinity) falls back to `Date.now()` (QA-1.3-7). */
export function safeNow(clock: Clock): number {
  const t = clock();
  return Number.isFinite(t) ? t : Date.now();
}

/** D5: the unit every candidate of one decision is compared in. Never mixed. */
export type CostUnit = "usd" | "ratio";

/** D4: verified outcome of one attempt. `unverifiable` updates nothing in the store. */
export type Verdict = "pass" | "fail" | "unverifiable";

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type AssertTrue<T extends true> = T;
/** Compile-time guard: `Verdict` stays identical to the verifier's `outcome` union (src/verify/types.ts:14). */
export type VerdictMatchesVerifier = AssertTrue<Equals<Verdict, NonNullable<VerificationVerdict["outcome"]>>>;

/** Outcome of a verifier verdict, derived exactly like the existing call sites (`outcome ?? (pass ? "pass" : "fail")`). */
export function verdictOf(verdict: Pick<VerificationVerdict, "pass" | "outcome">): Verdict {
  return verdict.outcome ?? (verdict.pass ? "pass" : "fail");
}

/**
 * Kind of attempt a row or signal belongs to. `dispatch` = an orchestrator dispatch routed in
 * `execute.before` (2.2); the others are `delegate` ladder attempts (1.5 / 2.3): `variant` = same model,
 * next variant (D10); `retry` = within-tier retry (existing effortBump path); `escalate` = next model/agent.
 */
export type LadderStepKind = "dispatch" | "variant" | "retry" | "escalate";

/** Fixed rendering order of ladder step kinds (stats, markdown). */
export const LADDER_STEP_KINDS: readonly LadderStepKind[] = ["dispatch", "variant", "retry", "escalate"];

/** Modes that write decision rows. `static` writes nothing (§1.2, D2). */
export type LoggedRoutingMode = "shadow" | "advise" | "enforce";

// ---------------------------------------------------------------------------
// Outcome keys — `${class}|${agent}|${provider}/${model}#${variant ?? "default"}`
// ---------------------------------------------------------------------------

/**
 * Where an agent's behaviour comes from. A router tier agent (`fast`, `medium`, ... of the active
 * preset; system prompt and model set by this plugin) is `router`; every other agent the host knows
 * (native `explore`/`general`, or user-defined in opencode.json) is `host`. The origin is part of the
 * key, so a router tier and a native agent with the same id never share evidence.
 */
export type AgentOrigin = "router" | "host";

export interface AgentRef {
  readonly origin: AgentOrigin;
  readonly id: string;
}

/** Variant stored for a child dispatched without a variant (amendment A9). */
export const DEFAULT_VARIANT = "default";
/** Class stored when the class segment is empty (TaskClass catch-all of 1.2). */
export const FALLBACK_CLASS = "other";
/** Stored for an empty agent id, provider or model (makeKey never throws on the hot path). */
export const UNKNOWN_PART = "unknown";

/**
 * Canonical outcome key, e.g. `implement|router:medium|anthropic/claude-sonnet-5-5#medium` or
 * `search|host:explore|anthropic/claude-haiku-4-5#default`. Build it only with {@link makeKey}.
 */
export type OutcomeKey = `${string}|${string}:${string}|${string}/${string}#${string}`;

export interface OutcomeKeyParts {
  readonly cls: string;
  readonly agent: AgentRef;
  readonly provider: string;
  readonly model: string;
  readonly variant: string;
}

const ESCAPES: Readonly<Record<string, string>> = {
  "%": "%25",
  "|": "%7C",
  "#": "%23",
  ":": "%3A",
  "/": "%2F",
};
const UNESCAPES: Readonly<Record<string, string>> = {
  "%25": "%",
  "%7C": "|",
  "%23": "#",
  "%3A": ":",
  "%2F": "/",
};
/** Characters escaped in class, agent id, provider and variant segments. */
const STRICT_CHARS = "%|#:/";
/** Characters escaped in the model segment (model ids may contain `/` and `:`). */
const MODEL_CHARS = "%|#";

function escapePart(value: string, chars: string): string {
  let out = "";
  for (const ch of value) out += chars.includes(ch) ? (ESCAPES[ch] ?? ch) : ch;
  return out;
}

function unescapePart(value: string): string | null {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch !== "%") {
      out += ch;
      continue;
    }
    const decoded = UNESCAPES[value.slice(i, i + 3)];
    if (decoded === undefined) return null;
    out += decoded;
    i += 2;
  }
  return out;
}

/** A9: absent or empty variant → `"default"`. Other values are kept verbatim (catalog ids are case-sensitive). */
export function normalizeVariant(variant: string | null | undefined): string {
  return variant === undefined || variant === null || variant === "" ? DEFAULT_VARIANT : variant;
}

/**
 * Build the outcome key. Never throws: empty class → `other`, empty agent id/provider/model →
 * `unknown`, empty variant → `default`. Delimiters inside a part are percent-escaped so that
 * `parseKey(makeKey(...))` round-trips every input.
 */
export function makeKey(
  cls: string,
  agent: AgentRef,
  provider: string,
  model: string,
  variant?: string | null,
): OutcomeKey {
  const c = escapePart(cls === "" ? FALLBACK_CLASS : cls, STRICT_CHARS);
  const a = escapePart(agent.id === "" ? UNKNOWN_PART : agent.id, STRICT_CHARS);
  const p = escapePart(provider === "" ? UNKNOWN_PART : provider, STRICT_CHARS);
  const m = escapePart(model === "" ? UNKNOWN_PART : model, MODEL_CHARS);
  const v = escapePart(normalizeVariant(variant), STRICT_CHARS);
  return `${c}|${agent.origin}:${a}|${p}/${m}#${v}` as OutcomeKey;
}

/** Inverse of {@link makeKey}; `null` unless `makeKey(parts) === key` (anything makeKey cannot produce). */
export function parseKey(key: string): OutcomeKeyParts | null {
  const segments = key.split("|");
  if (segments.length !== 3) return null;
  const [clsSeg, agentSeg, modelSeg] = segments as [string, string, string];

  const colon = agentSeg.indexOf(":");
  if (colon < 0) return null;
  const origin = agentSeg.slice(0, colon);
  if (origin !== "router" && origin !== "host") return null;

  const hash = modelSeg.lastIndexOf("#");
  if (hash < 0) return null;
  const providerModel = modelSeg.slice(0, hash);
  const slash = providerModel.indexOf("/");
  if (slash < 0) return null;

  const cls = unescapePart(clsSeg);
  const id = unescapePart(agentSeg.slice(colon + 1));
  const provider = unescapePart(providerModel.slice(0, slash));
  const model = unescapePart(providerModel.slice(slash + 1));
  const variant = unescapePart(modelSeg.slice(hash + 1));
  if (!cls || !id || !provider || !model || !variant) return null;
  const parts: OutcomeKeyParts = { cls, agent: { origin, id }, provider, model, variant };
  // Canonical form only (QA-1.3-12): a key that makeKey would not have produced (an unescaped `:`/`/` in
  // a strict part, lowercase `%7c`, ...) would otherwise alias a canonical key in the store.
  return makeKey(cls, parts.agent, provider, model, variant) === key ? parts : null;
}

/** `"provider/model"` or `"provider/model#variant"` (host `subagent` model syntax) → parts; `null` when malformed. */
export function splitModelRef(
  ref: string,
): { readonly provider: string; readonly model: string; readonly variant: string | null } | null {
  const slash = ref.indexOf("/");
  if (slash <= 0) return null;
  const hash = ref.lastIndexOf("#");
  const end = hash > slash ? hash : ref.length;
  const model = ref.slice(slash + 1, end);
  if (model === "") return null;
  const variant = hash > slash ? ref.slice(hash + 1) : null;
  return { provider: ref.slice(0, slash), model, variant: variant === "" ? null : variant };
}

/** Origin rule: an id that names a router tier agent of the active preset is `router`; anything else is `host`. */
export function classifyAgentOrigin(
  agentId: string,
  routerAgentIds: ReadonlySet<string> | readonly string[],
): AgentOrigin {
  const isRouter = isIdList(routerAgentIds) ? routerAgentIds.includes(agentId) : routerAgentIds.has(agentId);
  return isRouter ? "router" : "host";
}

function isIdList(ids: ReadonlySet<string> | readonly string[]): ids is readonly string[] {
  return Array.isArray(ids);
}

// ---------------------------------------------------------------------------
// Beta posteriors (beta.ts) — D4, D7, decay, effective-sample cap
// ---------------------------------------------------------------------------

/** `routing.outcomes` tuning (1.1 validates: halfLifeDays ∈ [1, 365], maxEffectiveSamples ∈ [5, 1000]). */
export interface OutcomeTuning {
  readonly halfLifeDays: number;
  readonly maxEffectiveSamples: number;
}

export const DEFAULT_OUTCOME_TUNING: OutcomeTuning = Object.freeze({ halfLifeDays: 14, maxEffectiveSamples: 50 });

/**
 * Stored evidence of one key: decayed pseudo-counts of successes (`alpha`) and failures (`beta`),
 * **prior excluded** (the D7 prior depends on the live rank and is added on read). `updatedAt` is the
 * epoch-ms instant the counts are expressed at; it never moves backwards.
 */
export interface BetaState {
  readonly alpha: number;
  readonly beta: number;
  readonly updatedAt: number;
}

/** D7 prior pseudo-counts; `alpha + beta = 5`. */
export interface BetaPrior {
  readonly alpha: number;
  readonly beta: number;
}

/** Posterior at read time: prior + evidence decayed to `now` and capped. Always proper (alpha, beta > 0). */
export interface Posterior {
  readonly alpha: number;
  readonly beta: number;
  /** alpha / (alpha + beta) — the `p_k` of D8. */
  readonly mean: number;
  /** Effective evidence count after decay and cap (prior excluded). */
  readonly n: number;
  readonly prior: BetaPrior;
}

// ---------------------------------------------------------------------------
// Cost accounting (cost.ts) — D5, D6, A1, A10
// ---------------------------------------------------------------------------

/** One catalog price entry (`Model.Cost`; USD per million tokens). A10: `tier` selects by input size. */
export interface ModelPriceEntry {
  readonly tier?: { readonly type: "context"; readonly size: number };
  readonly input: number;
  readonly output: number;
  readonly cache?: { readonly read?: number; readonly write?: number };
}

/** Catalog `cost` of a model as delivered by the host (array) or by user config (object or array). */
export type ModelPricing = ModelPriceEntry | readonly ModelPriceEntry[] | null | undefined;

/** A1: `unpriced` = no valid entry, or every price field of every entry is 0 (also: model absent from the catalog). */
export type PricingState = "priced" | "unpriced";

/** `session.step.ended` `data.tokens` as observed in S3. */
export interface StepEndedTokens {
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly cache: { readonly read: number; readonly write: number };
}

/** Flattened token counts (one step, or the sum over an attempt's steps). */
export interface TokenSample {
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** Running mean: exact arithmetic mean while n ≤ maxEffectiveSamples, then EWMA with weight 1/maxEffectiveSamples. `mean` is 0 when n = 0. */
export interface MeanStat {
  readonly mean: number;
  /** Samples folded in (uncapped integer). */
  readonly n: number;
}

/** Per-field means of per-attempt token sums. */
export interface TokenMeans {
  readonly n: number;
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** Per-key cost statistics. One sample = one attempt (a child session's steps for one dispatch or ladder step). */
export interface CostStats {
  /** USD per attempt; attempts with any `null` step cost (D6/A1) are excluded. */
  readonly measuredUSD: MeanStat;
  /** Attempts folded whose USD is unknown (unpriced model). */
  readonly unpricedAttempts: number;
  /** Token sums per attempt, every attempt (tokens are kept for unpriced models, A1). */
  readonly tokens: TokenMeans;
  /** Steps per attempt. */
  readonly steps: MeanStat;
  /** `tokens.output` of the attempt's final step (the text handed back to the orchestrator; D8 `tax`). */
  readonly finalMessageTokens: MeanStat;
}

/** One `session.step.ended` for a registered child, as handed to `OutcomeStore.recordStep`. */
export interface StepSample {
  /** Opaque attempt id from the dispatch registry (2.1), e.g. `${childSessionID}:${attemptIndex}`. */
  readonly attemptID: string;
  /** Raw `data.cost` (host-computed USD). */
  readonly cost: number;
  /** `pricingState(catalog cost of the attempt's model)`; the store applies D6 with it. */
  readonly pricing: PricingState;
  readonly tokens: TokenSample;
  /** `data.finish !== "tool-calls"`: the attempt handed back its final message with this step. */
  readonly final: boolean;
}

/** In-memory accumulator of an attempt still receiving steps (never persisted). */
export interface OpenAttempt {
  readonly key: OutcomeKey;
  readonly attemptID: string;
  readonly steps: number;
  /** Sum of non-null step USD. Meaningful only when `usdKnown`. */
  readonly usd: number;
  /** false as soon as one step's USD is null. */
  readonly usdKnown: boolean;
  readonly tokens: TokenSample;
  /** Output tokens of the final step; null until a final step arrives. */
  readonly finalOutput: number | null;
  readonly lastStepAt: number;
}

/** Input of the D5 unit rule. */
export interface UnitCandidate {
  readonly key: OutcomeKey;
  /** Catalog pricing usable for an estimate (`pricingState(...) === "priced"`). */
  readonly priced: boolean;
  /** `cost(key).measuredUSD` (non-null samples only). */
  readonly measuredUSD: MeanStat;
  /** Token samples available to price (`cost(key).tokens.n`, else the class profile's n). */
  readonly tokenSamples: number;
}

// ---------------------------------------------------------------------------
// Store (store.ts)
// ---------------------------------------------------------------------------

/** Identifies the attempt an outcome signal belongs to; one attempt contributes at most one Beta observation. */
export interface AttemptSignal {
  readonly attemptID: string;
  readonly step: LadderStepKind;
}

/** Lifetime raw counters (integers, never decayed). */
export interface OutcomeCounts {
  readonly pass: number;
  readonly fail: number;
  readonly falseRefusals: number;
  /** Verdicts of `variant` attempts (variant-step successes, §0.11). */
  readonly variantPass: number;
  readonly variantFail: number;
}

export interface OutcomeEntrySnapshot {
  readonly beta: BetaState;
  readonly counts: OutcomeCounts;
  readonly cost: CostStats;
}

/** Store state as persisted (open attempts and dedupe sets excluded). `entries` keys are OutcomeKeys, sorted. */
export interface OutcomeSnapshot {
  readonly version: typeof OUTCOMES_SCHEMA_VERSION;
  readonly entries: Readonly<Record<string, OutcomeEntrySnapshot>>;
}

export interface SnapshotLoadReport {
  readonly accepted: number;
  readonly dropped: number;
}

export interface OutcomeStoreOptions extends Partial<OutcomeTuning> {
  readonly now?: Clock;
  /** Open attempts kept before the oldest is folded early (default 256). */
  readonly maxOpenAttempts?: number;
  /** Attempt ids remembered for single-observation dedupe (default 4096, LRU). */
  readonly maxScoredAttempts?: number;
}

export interface OutcomeStore {
  /** Bumps on every change a snapshot would show; the flusher persists when it moved. */
  readonly revision: number;
  /** Hot reload of `routing.outcomes` (applied lazily on the next read/write). */
  configure(tuning: Partial<OutcomeTuning>): void;
  /** D4: pass → success, fail → failure, unverifiable → strict no-op. Returns whether the Beta changed. */
  recordVerdict(key: OutcomeKey, verdict: Verdict, signal: AttemptSignal): boolean;
  /** D4: a false refusal is a failure of the key. Returns whether the Beta changed. */
  recordFalseRefusal(key: OutcomeKey, signal: AttemptSignal): boolean;
  /** Accumulate one step into its attempt; a `final` step folds the attempt into `cost(key)`. */
  recordStep(key: OutcomeKey, step: StepSample): void;
  /** Fold an open attempt without a final step (child gone/aborted). No-op when unknown. */
  closeAttempt(attemptID: string): void;
  /** Fold open attempts idle for ≥ maxIdleMs (default 30 min); returns how many were folded. */
  sweepAttempts(maxIdleMs?: number): number;
  /** Prior (default: same-rank `Beta(4, 1)`) + decayed, capped evidence. Unknown key → the prior. */
  posterior(key: OutcomeKey, prior?: BetaPrior): Posterior;
  /** Cost statistics; unknown key → empty stats (all n = 0). */
  cost(key: OutcomeKey): CostStats;
  /** n-weighted token means over every key of the class; null when the class has no token sample. */
  classTokenProfile(cls: string): TokenMeans | null;
  keys(): OutcomeKey[];
  snapshot(): OutcomeSnapshot;
  /** `replace` (default) swaps the persisted state; `merge` adds disk evidence to in-memory evidence. */
  fromSnapshot(snapshot: OutcomeSnapshot, options?: { readonly mode?: "replace" | "merge" }): SnapshotLoadReport;
}

/** What stats needs from a store. */
export type OutcomeStoreView = Pick<OutcomeStore, "cost" | "keys">;

// ---------------------------------------------------------------------------
// Decision log rows (decisions.jsonl) — §0.11 "What is measured", D15, D18
// ---------------------------------------------------------------------------

/** Structural view of 1.2's `TaskFacts` (assignable from it). */
export interface DecisionFacts {
  readonly class: string;
  readonly risk: string;
  readonly scope: string;
  readonly needs: readonly string[];
  readonly confidence: number;
  readonly source: string;
}

export interface RouteChoice {
  readonly key: OutcomeKey;
  readonly agent: string;
  readonly origin: AgentOrigin;
  /** `provider/model`. */
  readonly model: string;
  /** Normalized variant (`default` when none). */
  readonly variant: string;
}

export const LOG_ROW_VERSION = 1;

interface LogRowBase {
  readonly v: typeof LOG_ROW_VERSION;
  /** ISO-8601 UTC (`new Date(now()).toISOString()`). */
  readonly ts: string;
  /** Parent (orchestrator) session. */
  readonly sessionID: string;
}

/** One routed dispatch (2.2) or one ladder attempt (2.3). Fields of §0.11 plus kind/v/decisionID/step/resume. */
export interface DecisionRow extends LogRowBase {
  readonly kind: "decision";
  /** Unique per row; verdict/refusal rows reference it. */
  readonly decisionID: string;
  readonly mode: LoggedRoutingMode;
  /** Known for resumed children; null for a fresh dispatch decided before the host creates the child. */
  readonly childSessionID: string | null;
  readonly facts: DecisionFacts;
  /** The orchestrator's pick (ladder attempts: the ladder's pick). */
  readonly chosen: RouteChoice;
  /** Engine argmin; null when no candidate survived filtering. */
  readonly best: RouteChoice | null;
  /** `enforce` replaced `chosen` with `best`. The dispatched key is `switched ? best.key : chosen.key`. */
  readonly switched: boolean;
  readonly pinned: boolean;
  readonly unit: CostUnit;
  /** C(k) per candidate key, in `unit`; finite numbers only. */
  readonly costs: Readonly<Record<string, number>>;
  /** 1.4 `Decision.confidence` ∈ [0, 1]. */
  readonly confidence: number;
  readonly reason: string;
  readonly step: LadderStepKind;
  /** The attempt reuses an existing child session (D11 resume, or a `sessionID`/`task_id` dispatch). */
  readonly resume: boolean;
}

export interface VerdictRow extends LogRowBase {
  readonly kind: "verdict";
  readonly decisionID: string | null;
  readonly childSessionID: string;
  readonly attemptID: string;
  readonly key: OutcomeKey;
  readonly verdict: Verdict;
  readonly step: LadderStepKind;
}

export interface RefusalRow extends LogRowBase {
  readonly kind: "refusal";
  readonly decisionID: string | null;
  readonly childSessionID: string;
  readonly attemptID: string;
  readonly key: OutcomeKey;
  readonly step: LadderStepKind;
}

export type LogRow = DecisionRow | VerdictRow | RefusalRow;

// ---------------------------------------------------------------------------
// Persistence (persist.ts) — D15, A3
// ---------------------------------------------------------------------------

export const OUTCOMES_SCHEMA_ID = "opencode-model-router.outcomes";
export const OUTCOMES_SCHEMA_VERSION = 1;
/** Default directory name under `os.tmpdir()`: the `*.scorecard.log` directory located in 0.P.2. */
export const DEFAULT_OUTCOMES_DIRNAME = "opencode-model-router-trajectory";
export const OUTCOMES_FILE = "outcomes.json";
/** Quarantined unparseable/malformed stores: `outcomes.corrupt.<YYYYMMDDTHHMMSSmmmZ>-<pid>.json` (QA-1.3-11). */
export const OUTCOMES_CORRUPT_PREFIX = "outcomes.corrupt.";
export const OUTCOMES_CORRUPT_RE = /^outcomes\.corrupt\.(\d{8}T\d{9}Z)-(\d+)\.json$/;
/** Quarantine copies kept (the newest ones). */
export const MAX_CORRUPT_COPIES = 3;
/** Prefix of temp files used by the atomic write (`outcomes.json.tmp-<pid>-<seq>`). */
export const OUTCOMES_TMP_PREFIX = "outcomes.json.tmp-";
export const DECISIONS_FILE = "decisions.jsonl";
/** Rotated generations: `decisions.<YYYYMMDDTHHMMSSmmmZ>-<pid>.jsonl`. */
export const DECISIONS_ROTATED_RE = /^decisions\.(\d{8}T\d{9}Z)-(\d+)\.jsonl$/;
/** D15: rotate before the live log would exceed 5 MiB. */
export const DECISIONS_MAX_BYTES = 5 * 1024 * 1024;
export const DECISIONS_MAX_GENERATIONS = 3;
/** D15: at most one flush per 30 s. */
export const FLUSH_MIN_INTERVAL_MS = 30_000;
export const FLUSH_BATCH_ROWS = 1_000;
export const MAX_QUEUED_ROWS = 5_000;
/** Windows rename retries on EPERM/EBUSY/EACCES (≈ 465 ms worst case, off the hot path). */
export const RENAME_RETRY_DELAYS_MS: readonly number[] = [15, 30, 60, 120, 240];
export const STALE_TMP_MS = 60 * 60 * 1000;

/** Persisted envelope of `outcomes.json`. */
export interface OutcomesFile {
  readonly schema: typeof OUTCOMES_SCHEMA_ID;
  readonly version: number;
  readonly savedAt: string;
  readonly entries: Readonly<Record<string, OutcomeEntrySnapshot>>;
}

export interface PersistStat {
  readonly size: number;
  readonly mtimeMs: number;
}

/** Injected file system. Thrown errors carry a Node `code` (`ENOENT`, `EPERM`, `EBUSY`, ...). */
export interface PersistFs {
  /** `mkdir -p`; an existing directory is not an error. */
  mkdirp(dir: string): Promise<void>;
  /** UTF-8 content; null when the file does not exist. */
  readText(path: string): Promise<string | null>;
  /** Create/truncate, write, fsync, close. */
  writeDurable(path: string, data: string): Promise<void>;
  /** One append call (O_APPEND), creating the file when absent. */
  appendText(path: string, data: string): Promise<void>;
  /** Replaces an existing target. */
  rename(from: string, to: string): Promise<void>;
  /** ENOENT is not an error. */
  unlink(path: string): Promise<void>;
  /** null when the file does not exist. */
  stat(path: string): Promise<PersistStat | null>;
  /** Entry names; [] when the directory does not exist. */
  readdir(dir: string): Promise<string[]>;
}

/** Structural subset of the plugin logger. */
export interface OutcomeLogger {
  warn(message: string, extra?: Record<string, unknown>): void;
  info?(message: string, extra?: Record<string, unknown>): void;
}

export interface PersistDeps {
  readonly fs: PersistFs;
  readonly now: Clock;
  readonly sleep: (ms: number) => Promise<void>;
  readonly logger: OutcomeLogger;
  readonly pid: number;
}

export interface PersisterOptions {
  readonly maxBytes?: number;
  readonly maxGenerations?: number;
  readonly renameRetryDelaysMs?: readonly number[];
}

/**
 * `missing` = no file (fresh store, not an error); `corrupt` = unparseable JSON or a malformed version-1
 * envelope (quarantined); `unsupported-version` = a file this plugin must not touch: a newer version, another
 * schema or a non-numeric version (read-only, never quarantined).
 */
export type LoadStatus = "ok" | "missing" | "corrupt" | "unsupported-version";

export interface LoadResult {
  readonly status: LoadStatus;
  /** Valid entries (empty unless `ok`). */
  readonly snapshot: OutcomeSnapshot;
  /** Entries dropped by validation (status stays `ok`). */
  readonly dropped: number;
  readonly savedAt: string | null;
  /** Human-readable reason for any status other than `ok`/`missing`, or for dropped entries. */
  readonly message: string | null;
}

export type WriteResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly error: string;
      readonly code?: string;
      /** The store on disk must not be overwritten by this plugin (newer/unrecognized/unreadable): no retry will help (QA-1.3-2). */
      readonly readOnly?: true;
    };

export interface ReadRowsResult {
  /** Oldest generation first, file order within a file. */
  readonly rows: LogRow[];
  /** Lines that failed JSON parsing or row validation (a torn last line after a crash is expected). */
  readonly skipped: number;
  readonly files: string[];
}

export interface Persister {
  readonly dir: string;
  readonly outcomesPath: string;
  readonly decisionsPath: string;
  /**
   * Never throws. `quarantine: true` (plugin) moves an unparseable or malformed version-1 file to a unique
   * `outcomes.corrupt.<stamp>-<pid>.json`; a file that is not ours (other schema or a newer version) is never
   * moved or overwritten. The CLI passes false.
   */
  load(options?: { readonly quarantine?: boolean }): Promise<LoadResult>;
  /** Atomic: temp file + durable write + rename (with Windows retries). Never throws; the old file survives any failure. */
  saveSnapshot(snapshot: OutcomeSnapshot): Promise<WriteResult>;
  /** One append per call; rotates first when the live log would pass `maxBytes`. Never throws. */
  appendRows(rows: readonly LogRow[]): Promise<WriteResult>;
  /** Every generation, oldest first. Never throws. */
  readRows(): Promise<ReadRowsResult>;
}

/** Injected timers; the real implementation `unref()`s them so they never keep a process alive. */
export interface FlushScheduler {
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface FlusherDeps {
  readonly now: Clock;
  readonly scheduler: FlushScheduler;
  readonly logger: OutcomeLogger;
  /** Every flush waits for this first (the initial disk load), so a snapshot is never taken before it merged. Must not reject. */
  readonly ready?: Promise<unknown>;
}

export interface FlusherOptions {
  readonly minIntervalMs?: number;
  readonly batchRows?: number;
  readonly maxQueuedRows?: number;
}

/** Coalescing, throttled writer. Hooks only call `enqueue`/`requestFlush` (no await, no I/O on the hot path). */
export interface OutcomeFlusher {
  readonly pendingRows: number;
  /** O(1) push; never I/O, never throws; requests a flush. */
  enqueue(row: LogRow): void;
  /** Coalesced with any in-flight/scheduled flush, throttled to one per `minIntervalMs`. Never rejects. */
  requestFlush(): Promise<void>;
  /** Bypasses the throttle (shutdown, tests); still serialized with an in-flight flush. Never rejects. */
  flushNow(): Promise<void>;
  /** flushNow, then cancel timers; later calls are no-ops. */
  dispose(): Promise<void>;
}

/** Process-wide bundle per outcomes directory (A3: one store and one writer per process). */
export interface OutcomesBundle {
  readonly dir: string;
  readonly store: OutcomeStore;
  readonly persister: Persister;
  readonly flusher: OutcomeFlusher;
  /** Resolves when the on-disk snapshot has been merged into the store. Never rejects. */
  readonly ready: Promise<LoadResult>;
  /** Drop this holder's reference; the last release disposes the flusher. */
  release(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Statistics (stats.ts) — 1.3.3, D18
// ---------------------------------------------------------------------------

/** Epoch-ms window: `since ≤ ts < until`; null = unbounded. */
export interface StatsWindow {
  readonly since: number | null;
  readonly until: number | null;
}

/** A rate with its parts; `rate` is null (rendered `n/a`) when `den` is 0. */
export interface RatioCell {
  readonly num: number;
  readonly den: number;
  readonly rate: number | null;
}

export interface ClassStatsRow {
  readonly class: string;
  readonly dispatches: number;
}

export interface KeyStatsRow {
  readonly key: OutcomeKey;
  /** Windowed `dispatch` rows whose dispatched key is this key. */
  readonly dispatches: number;
  /** Windowed decision rows of any step whose dispatched key is this key. */
  readonly attempts: number;
  readonly pass: number;
  readonly fail: number;
  readonly unverifiable: number;
  /** pass / (pass + fail). */
  readonly passRate: RatioCell;
  readonly falseRefusals: number;
  /** falseRefusals / attempts. */
  readonly refusalRate: RatioCell;
  /** Store `cost(key).measuredUSD` (lifetime, per attempt); null when n = 0. */
  readonly measuredUSD: MeanStat | null;
}

/** Estimated savings Σ C(chosen) − C(best) over non-pinned dispatch rows of one unit. Units are never summed together. */
export interface SavingsRow {
  readonly unit: CostUnit;
  readonly total: number;
  readonly rows: number;
}

export interface ResumeFreshRow {
  readonly step: LadderStepKind;
  readonly resume: number;
  readonly fresh: number;
}

/** Exactly the columns of plan 1.3.3 (+ `switched.failed` for D17, see the design). */
export interface StatsTable {
  readonly version: 1;
  /** ISO strings of the window bounds; null = unbounded. */
  readonly window: { readonly since: string | null; readonly until: string | null };
  readonly dispatches: number;
  readonly pinned: number;
  readonly byClass: readonly ClassStatsRow[];
  readonly byKey: readonly KeyStatsRow[];
  /** best == chosen over non-pinned dispatch rows with a non-null best. */
  readonly agreement: RatioCell;
  readonly switched: {
    readonly count: number;
    /** count / non-pinned dispatch rows. */
    readonly share: RatioCell;
    /** Switched rows whose attempt ended in a `fail` verdict or a false refusal (D17 input). */
    readonly failed: number;
  };
  /** One entry per unit present in the window, sorted by unit name. */
  readonly savings: readonly SavingsRow[];
  readonly variantSteps: {
    readonly taken: number;
    /** pass / (pass + fail) over windowed verdict rows of `variant` attempts. */
    readonly passRate: RatioCell;
  };
  /** Fixed order: LADDER_STEP_KINDS. */
  readonly resumeVsFresh: readonly ResumeFreshRow[];
}

/** What the CLI reads from a directory (a Persister satisfies it). */
export type StatsSource = Pick<Persister, "load" | "readRows">;

export interface StatsCliIO {
  /** `resolveOutcomesDir(null, ...)`, used when `--dir` is absent. */
  readonly defaultDir: string;
  open(dir: string): StatsSource;
  stdout(text: string): void;
  stderr(text: string): void;
}

export const STATS_EXIT = Object.freeze({ ok: 0, corrupt: 1, usage: 2 } as const);
