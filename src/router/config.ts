import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { formatRouterLine } from "./build-info";
import { parseJsonc } from "./jsonc";
import type { DelegateInstructionsPolicy } from "./instructions";
import type { PluginLogger } from "./logger";

/**
 * Filename of the optional user overrides file (global and project copies share
 * it). `.jsonc` so comments and trailing commas are allowed; mirrors the
 * `opencode-model-router.*` prefix of the state file.
 */
export const OVERRIDE_FILENAME = "opencode-model-router.overrides.jsonc";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ThinkingConfig {
  budgetTokens?: number;
}

export interface ReasoningConfig {
  effort?: "low" | "medium" | "high";
  summary?: "auto" | "always" | "never";
}

/**
 * Provider-agnostic reasoning effort for a tier.
 *
 * `xhigh` and `max` exist because Anthropic's adaptive models accept them;
 * OpenAI's reasoning effort parameter (`reasoningEffort`) stops at `high`, so
 * the registration path downgrades those two with a warning (see
 * `src/router/agent-options.ts`).
 */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/**
 * Wording style of the default system prompt handed to a tier agent.
 *
 * `prescriptive` uses the enumerated `tierPrompts` from tiers.json; `goal-oriented`
 * uses the goal + constraints defaults in `src/router/prompts.ts`; `auto` (the
 * default when unset) picks goal-oriented for strong models and prescriptive for
 * the rest.
 */
export const PROMPT_STYLES = ["prescriptive", "goal-oriented", "auto"] as const;

export type PromptStyle = (typeof PROMPT_STYLES)[number];

/**
 * Model-ID patterns, matched as substrings of a tier's model ID with case and
 * separators normalized (see flattenModelID in ./prompts).
 */
export interface ModelGenerationsConfig {
  strong?: string[];
}

// Curated per model, NOT by generation. There used to be a `claude5x` list that
// this one spread, with a note claiming "strong is a superset of claude5x by
// construction — every Claude 5.x model is a strong model". Both halves stopped
// being true: `claude-opus-5` was added here without being added there, and
// `claude-sonnet-5` ships on two tiers as a Claude 5.x model that is
// deliberately not strong. Worse, the `claude5x` config field was validated and
// documented but never read — the spread happened once at module load from the
// default array, so a user override could not reach it. Generation is not the
// criterion; whether goal-oriented prompting suits the model is.
export const DEFAULT_STRONG_MODEL_PATTERNS = [
  "claude-fable-5",
  "claude-mythos-5",
  "opus-4-8",
  "claude-opus-5",
];

export interface TierConfig {
  model: string;
  variant?: string;
  /**
   * Provider-agnostic effort. Loses to an explicit `thinking` budget on
   * Anthropic and to an explicit `reasoning.effort` on OpenAI. When unset, no
   * effort key is registered at all.
   */
  effort?: EffortLevel;
  thinking?: ThinkingConfig;
  reasoning?: ReasoningConfig;
  costRatio?: number;
  color?: string;
  /** Optional human-readable blurb shown in `/tiers` and the agent registration. */
  description?: string;
  steps?: number;
  prompt?: string;
  /**
   * Wording style of the default prompt for this tier. Ignored when `prompt` is
   * set — an explicit per-tier prompt always wins. Defaults to `auto`.
   */
  promptStyle?: PromptStyle;
  /** Optional use-case hints shown in `/tiers`. */
  whenToUse?: string[];
  /**
   * Ordered `(model, variant, costRatio)` rungs the routing engine may use for
   * this tier. Absent or empty = the tier's own single `(model, variant,
   * costRatio)`. See {@link resolveCandidates}.
   */
  candidates?: TierCandidate[];
}

export type Preset = Record<string, TierConfig>;

export interface FallbackConfig {
  global?: Record<string, string[]>;
  presets?: Record<string, Record<string, string[]>>;
}

export interface ModeConfig {
  defaultTier: string;
  description: string;
  overrideRules?: string[];
}

export interface EnforcementConfig {
  mode?: "off" | "advisory" | "enforced";
  /** Default 1; warned in "advisory" mode (bundled default), refused in "enforced" mode, ignored in "off"; null disables. */
  maxDelegationDepth?: number | null;
  envGate?: string;
  perTier?: Record<string, "off" | "advisory" | "enforced">;
  guard?: { readDraftCap?: number; sameOpRetryCap?: number; blockSelfScript?: boolean; deliverableFirst?: boolean; budget?: number; blockScriptWrites?: boolean };
  verify?: { require?: "never" | "whenDoDPresent" | "always"; requireExplicitDoD?: boolean; preferDeterministic?: boolean; graderPolicy?: "atLeastProducerTier"; graderTemperature?: number | null; graderTemperatureModels?: string[]; minGraderTier?: string | null;
    /** Ceiling for one producer `session.prompt` turn, in ms. Default 600000. */
    delegateTimeoutMs?: number;
    /** Reject unavailable verification. Default false; never escalates it. */
    strictUnverifiable?: boolean;
    /** Deprecated: `false` maps to `failureRecheck: false` (explicit `failureRecheck` wins). No default. */
    testBaseline?: boolean;
    /** Bounds the whole git-only reference capture, in ms. Default 15000. */
    baselineTimeoutMs?: number;
    /** Override tier ceilings: fast 60000 / medium 180000 / heavy 600000 ms. */
    graderTimeoutMs?: number;
    /** Deadline for every synchronous verification, in ms. Default 90000. */
    gateBudgetMs?: number;
    /** Which tests a verification runs. Default "affected". */
    testScope?: "affected" | "full";
    /** Worker cap passed to runners that support one (integer >= 1). Default 2. */
    maxWorkers?: number;
    /** Run verification commands at below-normal priority. Default true. */
    lowPriority?: boolean;
    /** Machine-wide verification slots (integer >= 1). Default max(1, floor(cores / 8)). */
    maxConcurrentVerifications?: number;
    /** Mode for dispatches without a `VERIFY:` directive. Default "deferred". */
    defaultVerify?: "deferred" | "required";
    /** Longest wait for the reference capture before the producer starts, in ms (0 = never wait). Default 5000. */
    captureWaitMs?: number;
    /** Also run deferred verifications in the background. Default false. */
    background?: boolean;
    /** How long an unverified delegation stays verifiable, in ms (integer >= 1). Default 3600000. */
    pendingTtlMs?: number;
    /**
     * Maximum wait for a verification slot, in ms (0 = no wait). Default 60000.
     *
     * Residual (QA-1.4-21): a lock whose owner is not provably dead is reclaimed
     * only by a caller that waits or stays alive through ~8 s of observation, so
     * a very short wait may give up on a slot that a longer one would reclaim.
     */
    slotWaitMs?: number;
    /** Coalescing window, in ms (0 = no batching). Default 2000. */
    batchWindowMs?: number;
    /** Capture a reference and recheck scoped failures against it. Default true. */
    failureRecheck?: boolean;
    /** Budget for the reference re-run, in ms (integer >= 1). Default 60000. */
    recheckTimeoutMs?: number };
  escalate?: EscalateConfig;
  proportional?: { trivialBypass?: boolean; trivialClassifier?: string };
}

export interface EscalateConfig {
  floorTier?: string | null;
  ladder?: string[];
  maxAttemptsPerTier?: number;
  maxTotalAttempts?: number;
  costCeiling?: { base?: string; multiple?: number };
  /** Bump reasoning effort before escalating tiers. Default true. */
  effortBump?: boolean;
  /** Maximum reasoning effort for a bump. Default "xhigh". */
  effortBumpMax?: EffortLevel;
  /**
   * Retry on the same model's next variant before escalating the model (D10).
   * OpenCode v2 only; ignored on v1. Default "auto".
   */
  variantSteps?: VariantStepsMode;
}

// ---------------------------------------------------------------------------
// Cost-aware routing (#74): the `routing` block, tier candidates, variant steps
// ---------------------------------------------------------------------------

/** `static` = the shipped taxonomy only; the others add the engine of #74. */
export const ROUTING_ENGINES = ["static", "shadow", "advise", "enforce"] as const;
export type RoutingEngine = (typeof ROUTING_ENGINES)[number];

/** How much a wrong, undetected result is worth in the expected-cost formula (D8). */
export const ROUTING_PROFILES = ["frugal", "balanced", "safe"] as const;
export type RoutingProfile = (typeof ROUTING_PROFILES)[number];

export const CLASSIFIER_BACKENDS = ["rules", "host", "openai-compatible", "typesafe"] as const;
export type ClassifierBackend = (typeof CLASSIFIER_BACKENDS)[number];

/**
 * The task classes `routing.roles` may name. The classifier (Phase 1.2) assigns
 * one of these to every dispatch; `other` is the catch-all.
 */
export const ROUTING_TASK_CLASSES = [
  "search",
  "recon",
  "mechanical",
  "implement",
  "debug",
  "design",
  "review",
  "other",
] as const;
export type RoutingTaskClass = (typeof ROUTING_TASK_CLASSES)[number];

export const VARIANT_STEP_MODES = ["auto", "none"] as const;
export type VariantStepsMode = (typeof VARIANT_STEP_MODES)[number];

/** Which host runs the plugin; `v2` is OpenCode v2 (D1). */
export type RouterHost = "v1" | "v2";

/**
 * One rung of a tier's ladder. `model` falls back to the tier's own model;
 * `variant` is NOT inherited (omitted = the model's default variant); `costRatio`
 * falls back to the tier's.
 */
export interface TierCandidate {
  model?: string;
  variant?: string;
  costRatio?: number;
}

/** Verification-depth → probability that a wrong result is caught (D8). */
export interface DetectionConfig {
  deterministic?: number;
  grader?: number;
  none?: number;
}

/** Per-preset override of the classifier's `backend` / `model`. */
export interface ClassifierPresetOverride {
  backend?: ClassifierBackend;
  model?: string | null;
}

export interface ClassifierConfig {
  backend?: ClassifierBackend;
  /** Catalog ref `provider/model[#variant]`; required when the effective backend is not `rules` (D3). */
  model?: string | null;
  /** `openai-compatible` / `typesafe` only. */
  baseUrl?: string | null;
  apiKeyEnv?: string | null;
  timeoutMs?: number;
  samples?: 1 | 3;
  maxStateChars?: number;
  presets?: Record<string, ClassifierPresetOverride>;
}

export interface OutcomesConfig {
  path?: string | null;
  halfLifeDays?: number;
  maxEffectiveSamples?: number;
}

export interface SessionReuseConfig {
  maxContextFraction?: number;
}

export interface AdvisorConfig {
  enabled?: boolean;
  noticeIntervalHours?: number;
}

export interface RoutingConfig {
  engine?: RoutingEngine;
  profile?: RoutingProfile;
  margin?: number;
  minClassConfidence?: number;
  detection?: DetectionConfig;
  classifier?: ClassifierConfig;
  /** Task class → ordered agent ids. Absent = host default (D12); `{}` = none. */
  roles?: Record<string, string[]>;
  outcomes?: OutcomesConfig;
  sessionReuse?: SessionReuseConfig;
  advisor?: AdvisorConfig;
}

export interface RouterConfig {
  /**
   * Detect a delegate that hands a dispatch back having made zero tool calls
   * while complaining about tool availability, and annotate the result so the
   * orchestrator retries instead of escalating a tier on a refusal that was
   * never tested. Defaults to true.
   */
  falseRefusalDetection?: boolean;
  /**
   * Prepend a short mechanical header to every task dispatch: tier identity,
   * working directory, tool-schema authority, empty-results-are-results, the
   * read-only budget, and the false-refusal notice. Defaults to true. Set false
   * to restore the pre-feature behaviour where this guidance existed only if the
   * orchestrator remembered to write it.
   */
  dispatchHeader?: boolean;
  /**
   * Repair a task dispatch that arrives without a prompt: copy a non-empty
   * description into the prompt, or refuse the call with a readable
   * explanation when neither carries any work. Defaults to true. Set false to
   * restore the pre-feature behaviour where the harness rejected such a call
   * with a bare schema error.
   */
  taskPromptRepair?: boolean;
  /**
   * DELEGATE sessions only, never the orchestrator. `strip-global` (default)
   * removes instruction files outside the project, where orchestrator personas
   * normally live, and keeps project-local files. `strip-all` removes every
   * instruction file; `keep` restores pre-feature behaviour.
   */
  delegateInstructions?: DelegateInstructionsPolicy;
  activePreset: string;
  activeMode?: string;
  presets: Record<string, Preset>;
  rules: string[];
  defaultTier: string;
  fallback?: FallbackConfig;
  taskPatterns?: Record<string, string[]>;
  modes?: Record<string, ModeConfig>;
  /** Global default prompts per tier name. A preset-level tier.prompt overrides this. */
  tierPrompts?: Record<string, string>;
  /**
   * Optional user overrides for the goal-oriented tier prompts. The defaults ship
   * in code (`src/router/prompts.ts`); an entry here replaces the built-in for
   * that tier name.
   */
  tierPromptsGoalOriented?: Record<string, string>;
  /** Shared model-generation pattern lists; see {@link ModelGenerationsConfig}. */
  modelGenerations?: ModelGenerationsConfig;
  /** Read-only tool-call caps per tier, enforced at runtime via tool.execute.after banner injection. */
  tierCaps?: Record<string, number>;
  enforcement?: EnforcementConfig;
  /**
   * Claude-model anti-narration guardrail. When true, appends the anti-narration
   * clause to Claude orchestrator/tier prompts and runs the post-hoc narration
   * detector. Off by default: the clause costs ~162 tokens per Claude dispatch
   * and the detector is non-blocking telemetry that false-positives on normal
   * "Now I'll add X" phrasing.
   */
  antiNarration?: boolean;
  /**
   * Opt-in map of pre-existing agent name → tier name, e.g.
   * `{ "ContextScout": "fast" }`. Listed agents are repointed at the active
   * preset's model for that tier, so they follow `/preset` instead of pinning
   * a model id in their own definition. Absent or empty ⇒ feature is off and
   * no agent is touched.
   *
   * Keys are opencode agent names — the frontmatter `name:` field when a
   * markdown agent declares one, otherwise its path-derived name. List only
   * subagents; a primary agent is the orchestrator.
   */
  subagentTiers?: Record<string, string>;
  /** Experimental, opt-in features. Off by default. */
  experimental?: { verifiedDelegateTool?: boolean };
  /** Cost-aware routing engine (#74). Absent = today's static routing, byte for byte. */
  routing?: RoutingConfig;
}

export interface RouterState {
  activePreset?: string;
  activeMode?: string;
  enforcementMode?: "off" | "advisory" | "enforced";
}

// ---------------------------------------------------------------------------
// Config loader with caching
// ---------------------------------------------------------------------------

/**
 * Cache state for one project directory. Hosts such as OpenCode v2 run one
 * plugin instance per project directory inside a single process, so the cache
 * cannot be a single module-level slot: each directory has its own project
 * override file and therefore its own config, fingerprint and last-good state.
 */
interface ConfigCacheEntry {
  config: RouterConfig | null;
  dirty: boolean;
  fingerprint: string;
  /** Source locations (paths only, no mtimes) that produced `config`. */
  sourceKey: string;
  /** Sources that were already failing when `config` was built (tolerated). */
  tolerated: Set<string>;
  /** Last hot-reload failure (null when the most recent rebuild succeeded). */
  reloadError: string | null;
  /** Fingerprint a reload-failure warning was last emitted for (warn once each). */
  warnedFingerprint: string | null;
  /** Non-fatal findings of the build that produced `config` (see {@link getConfigNotices}). */
  notices: ConfigNotice[];
}

/** Keyed by {@link normalizeProjectDir}. */
const _configCaches = new Map<string, ConfigCacheEntry>();

function getCacheEntry(key: string): ConfigCacheEntry {
  let entry = _configCaches.get(key);
  if (!entry) {
    entry = {
      config: null,
      dirty: true,
      fingerprint: "",
      sourceKey: "",
      tolerated: new Set<string>(),
      reloadError: null,
      warnedFingerprint: null,
      notices: [],
    };
    _configCaches.set(key, entry);
  }
  return entry;
}

/**
 * `realpathSync` that fails soft: an unresolvable path is used as-is, which is
 * no worse than not resolving at all.
 */
function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Canonical form of a project directory: absolute and symlink-resolved, so the
 * same directory reached through different spellings shares one cache entry
 * and compares equal to the (resolved) home directory. A missing or empty `dir`
 * means "the process working directory at call time".
 */
function normalizeProjectDir(dir?: string): string {
  return realpathOrSelf(dir ? resolvePath(dir) : process.cwd());
}

/**
 * A non-fatal finding of a config build: something was ignored or looks wrong,
 * but the config still loaded. `source` is the file concerned, when one is.
 */
export interface ConfigNotice {
  source?: string;
  message: string;
}

/**
 * The notices of the config last built for `dir` (default: the working
 * directory): keys dropped from the project layer, unknown `routing` keys, and
 * the like. Empty when there are none. `/router` lists them.
 */
export function getConfigNotices(dir?: string): readonly ConfigNotice[] {
  return _configCaches.get(normalizeProjectDir(dir))?.notices ?? [];
}

/**
 * Why the last config rebuild failed for `dir` (default: the working
 * directory), or null when it succeeded. When a source (tiers.json, an
 * overrides file, or the state file) becomes invalid after a successful load,
 * loadConfig() keeps serving the last valid config and records the reason here
 * instead of throwing or silently dropping layers.
 */
export function getConfigReloadError(dir?: string): string | null {
  return _configCaches.get(normalizeProjectDir(dir))?.reloadError ?? null;
}

/** Mark every directory's config cache as stale so it is re-read on next access. */
export function invalidateConfigCache(): void {
  for (const entry of _configCaches.values()) entry.dirty = true;
}

function getPluginRoot(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  return join(__dirname, "../.."); // src/router/ -> plugin root
}

export function configPath(): string {
  return join(getPluginRoot(), "tiers.json");
}

/**
 * Path to the global user overrides file. Lives in the stable opencode config
 * dir (next to the state file) so it survives plugin updates — unlike the
 * bundled tiers.json, which sits in the cache dir and is overwritten on every
 * update. Anything here is deep-merged over the bundled config.
 */
export function overridePath(): string {
  return join(homedir(), ".config", "opencode", OVERRIDE_FILENAME);
}

/**
 * Default location of the project-local overrides file
 * (`.opencode/opencode-model-router.overrides.jsonc` in the project directory,
 * or in the current working directory when `dir` is omitted). This is the path
 * to *create* the file at; the actual lookup walks upward — see
 * {@link findProjectOverride}. Used for display when no project file is found.
 *
 * The project file is deep-merged *after* (and therefore wins over) the global
 * overrides file, so a team can commit a shared file that unifies routing for
 * the project on top of each member's personal global file.
 */
export function localOverridePath(dir?: string): string {
  return join(dir ? resolvePath(dir) : process.cwd(), ".opencode", OVERRIDE_FILENAME);
}

/**
 * Repo-root markers. Each is one-per-repository, so finding one means the
 * ancestor is a project root. `package.json` is deliberately NOT a marker: in a
 * monorepo, `<repo>/packages/app/package.json` would stop the walk before it
 * ever reached `<repo>/.opencode/`.
 */
const REPO_MARKERS = [".git", ".hg", ".svn"] as const;

/**
 * Hard ceiling on how many levels the walk may climb above the starting
 * directory. Deep working directories in a monorepo
 * (`<repo>/packages/<pkg>/src/<area>/<sub>/…`) sit roughly 8 levels below the
 * root, so 16 leaves generous headroom while keeping the walk bounded on trees
 * that contain no repo marker at all.
 */
const MAX_WALK_DEPTH = 16;

/** errno code of a thrown fs error, or "UNKNOWN" when it carries none. */
function errnoCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : "UNKNOWN";
}

/**
 * ENOENT (nothing there) and ENOTDIR (a path component is a file) both mean the
 * path is gone. Every other errno (EACCES, EIO, ELOOP, …) means "cannot tell",
 * which is NOT the same as "removed".
 */
function isGoneError(err: unknown): boolean {
  const code = errnoCode(err);
  return code === "ENOENT" || code === "ENOTDIR";
}

/** A stat that failed for a reason other than the path being gone. */
interface StatFailure {
  code: string;
  message: string;
}

/**
 * Outcome of looking at a config source: it is there, it is definitely gone, or
 * it could not be inspected. Unlike `existsSync` — which folds every error into
 * `false` — this keeps "removed" and "unreachable" apart, so a transient I/O
 * error or a directory that lost search permission is never mistaken for the
 * user deleting the file.
 */
type StatKind = "present" | "missing" | StatFailure;

function statKind(p: string): StatKind {
  try {
    statSync(p);
    return "present";
  } catch (err) {
    if (isGoneError(err)) return "missing";
    return { code: errnoCode(err), message: (err as Error).message };
  }
}

/**
 * Locate the project-local overrides file by walking upward from `dir` (the
 * host-provided project directory), so the project config is found even when
 * opencode is launched from a subdirectory. When `dir` is omitted the walk
 * starts at the process working directory; hosts that change the working
 * directory away from the project (OpenCode v2 server mode chdirs to $HOME)
 * must pass the project directory explicitly.
 *
 * The walk stops at the first of these, whichever comes first:
 *   - an ancestor containing a repo marker (`.git`, `.hg`, `.svn`), after
 *     checking that ancestor;
 *   - `MAX_WALK_DEPTH` levels above the starting directory;
 *   - the user's home directory, which is never treated as a project directory
 *     unless it is itself a repo root;
 *   - the filesystem root.
 *
 * The depth ceiling and the home-directory boundary matter because a directory
 * tree with no repo marker anywhere would otherwise be walked all the way to the
 * filesystem root, silently adopting an unrelated ancestor's override file.
 * Returns the resolved path, or undefined when no file applies.
 *
 * Only ENOENT/ENOTDIR count as "no file here". A candidate that cannot be
 * inspected for any other reason (EACCES on a parent directory, a transient
 * I/O error) is still returned and ends the walk — the nearest override wins,
 * so it must not be skipped in favour of an ancestor's file — and the later
 * read reports it as a failure instead of the source silently vanishing. A
 * repo marker that cannot be inspected is likewise treated as present, so the
 * walk never climbs past a project root it merely failed to stat.
 */
export function findProjectOverride(dir?: string): string | undefined {
  return walkForProjectOverride(normalizeProjectDir(dir));
}

/** `startDir` must already be normalized (see {@link normalizeProjectDir}). */
function walkForProjectOverride(startDir: string): string | undefined {
  // Both sides of the $HOME comparison below have to be resolved the same way.
  // process.cwd() returns a realpath, while homedir() returns $HOME verbatim, so
  // on any system where $HOME contains a symlinked component (macOS temp dirs,
  // containers, some NFS homes) a raw string compare never matches and the home
  // boundary silently stops applying. A host-provided project directory gets
  // the same treatment (normalizeProjectDir). Fail soft: an unresolvable path
  // is used as-is, which is no worse than not comparing at all.
  let dir = startDir;
  const home = realpathOrSelf(homedir());
  let depth = 0;

  for (;;) {
    const hasMarker = REPO_MARKERS.some((m) => statKind(join(dir, m)) !== "missing");

    // $HOME is not a project directory. Only look inside it when it is itself a
    // repo root (a dotfiles repo), otherwise `~/.opencode/…` would be picked up
    // by any unrelated scratch directory below it.
    if (dir === home && !hasMarker) return undefined;

    const candidate = join(dir, ".opencode", OVERRIDE_FILENAME);
    if (statKind(candidate) !== "missing") return candidate;

    if (hasMarker) return undefined; // reached the project root, no file
    if (dir === home) return undefined; // home was a repo root; never go above it
    if (++depth >= MAX_WALK_DEPTH) return undefined;

    const parent = dirname(dir);
    if (parent === dir) return undefined; // filesystem root
    dir = parent;
  }
}

export function statePath(): string {
  return join(
    homedir(),
    ".config",
    "opencode",
    "opencode-model-router.state.json",
  );
}

export function resolvePresetName(
  cfg: RouterConfig,
  requestedPreset: string,
): string | undefined {
  if (cfg.presets[requestedPreset]) {
    return requestedPreset;
  }

  const normalized = requestedPreset.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  return Object.keys(cfg.presets).find(
    (name) => name.toLowerCase() === normalized,
  );
}

/** True for a non-null, non-array object literal. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Split a tier model reference (`"provider/model"`) into its parts. Splits on
 * the FIRST slash only, so multi-segment model ids (e.g.
 * `openrouter/deepseek/deepseek-v3.2`) keep their full model id.
 *
 * Lives here rather than in catalog.ts because the `provider/model` shape is a
 * property of the config format, not of the catalog. Config load and catalog
 * lookup have to agree on what a well-formed ref is; sharing one function is
 * what makes "it validated at load" mean "it will parse later". catalog.ts
 * re-exports it so the reference is still reachable from where it is used.
 */
export function parseModelRef(
  ref: string,
): { providerId: string; modelId: string } | undefined {
  const i = ref.indexOf("/");
  if (i <= 0 || i === ref.length - 1) return undefined;
  return { providerId: ref.slice(0, i), modelId: ref.slice(i + 1) };
}

/**
 * Shape of every preset and every tier within it. Returns the presets map so
 * the caller can hand it to validateActivePreset without re-narrowing.
 */
function validatePresets(obj: Record<string, unknown>): Record<string, unknown> {
  if (!isPlainObject(obj.presets)) {
    throw new Error("tiers.json: 'presets' must be a non-null object");
  }

  const presets = obj.presets as Record<string, unknown>;
  for (const [presetName, preset] of Object.entries(presets)) {
    if (
      typeof preset !== "object" ||
      preset === null ||
      Array.isArray(preset)
    ) {
      throw new Error(`tiers.json: preset '${presetName}' must be an object`);
    }
    const tiers = preset as Record<string, unknown>;
    for (const [tierName, tier] of Object.entries(tiers)) {
      if (typeof tier !== "object" || tier === null) {
        throw new Error(
          `tiers.json: tier '${presetName}.${tierName}' must be an object`,
        );
      }
      const t = tier as Record<string, unknown>;
      // `model` is the only required tier field — so an overrides file can define
      // a new preset/tier with just `{ "model": "..." }`. The rest are optional
      // and only type-checked when present.
      if (typeof t.model !== "string" || !t.model) {
        throw new Error(
          `tiers.json: '${presetName}.${tierName}.model' must be a non-empty string`,
        );
      }
      // Same reasoning as effort and promptStyle below, one step earlier: a ref
      // missing its provider (`claude-sonnet-5`) or missing its model
      // (`anthropic/`) used to load clean and only surface much later, as a
      // catalog issue on a turn that happened to fetch the catalog — or never,
      // if the fetch failed. The shape is knowable without the network, so it
      // is decided here. parseModelRef is the same function the catalog lookup
      // uses, so passing this guarantees the ref parses there too.
      if (!parseModelRef(t.model)) {
        throw new Error(
          `tiers.json: '${presetName}.${tierName}.model' must be 'provider/model' (got '${t.model}')`,
        );
      }
      if (t.description !== undefined && typeof t.description !== "string") {
        throw new Error(
          `tiers.json: '${presetName}.${tierName}.description' must be a string`,
        );
      }
      if (t.whenToUse !== undefined && !Array.isArray(t.whenToUse)) {
        throw new Error(
          `tiers.json: '${presetName}.${tierName}.whenToUse' must be an array`,
        );
      }
      // A typo'd effort would otherwise load clean and be silently dropped at
      // registration time, leaving a tier running at the provider default with
      // only a warning nobody reads.
      if (
        t.effort !== undefined &&
        !EFFORT_LEVELS.some((level) => level === t.effort)
      ) {
        throw new Error(
          `tiers.json: preset '${presetName}' tier '${tierName}': effort must be one of ${EFFORT_LEVELS.join(", ")}`,
        );
      }
      // Same reasoning as effort: a typo'd style would otherwise load clean and
      // silently fall back to the prescriptive prompt with nothing said.
      if (
        t.promptStyle !== undefined &&
        !PROMPT_STYLES.some((style) => style === t.promptStyle)
      ) {
        throw new Error(
          `tiers.json: preset '${presetName}' tier '${tierName}': promptStyle must be one of ${PROMPT_STYLES.join("|")}`,
        );
      }
      validateTierCandidates(t, `${presetName}.${tierName}`, tierName);
    }
  }

  return presets;
}

/** `activePreset` names a preset that exists. */
function validateActivePreset(
  obj: Record<string, unknown>,
  presets: Record<string, unknown>,
): void {
  // `activePreset` has to name a preset that actually exists. It is the key most
  // likely to be typo'd in a hand-edited override file, and without this the bad
  // name loads clean and routing quietly runs on whatever the state file or the
  // bundled default left behind, with nothing said. Matching is case-insensitive
  // to agree with resolvePresetName, which is what `/preset` uses.
  const activePresetName = obj.activePreset as string;
  const presetNames = Object.keys(presets);
  const activeExists =
    Object.prototype.hasOwnProperty.call(presets, activePresetName) ||
    presetNames.some(
      (n) => n.toLowerCase() === activePresetName.trim().toLowerCase(),
    );
  if (!activeExists) {
    throw new Error(
      `tiers.json: 'activePreset' is '${activePresetName}', which is not a defined preset (defined: ${presetNames.join(", ")})`,
    );
  }
}

/** Top-level keys that are required, or optional with a fixed type. */
function validateCoreKeys(obj: Record<string, unknown>): void {
  if (!Array.isArray(obj.rules)) {
    throw new Error("tiers.json: 'rules' must be an array of strings");
  }
  if (typeof obj.defaultTier !== "string") {
    throw new Error("tiers.json: 'defaultTier' must be a string");
  }
  if (obj.antiNarration !== undefined && typeof obj.antiNarration !== "boolean") {
    throw new Error("tiers.json: 'antiNarration' must be a boolean");
  }
}

function validateDispatchHeader(obj: Record<string, unknown>): void {
  if (obj.dispatchHeader !== undefined && typeof obj.dispatchHeader !== "boolean") {
    throw new Error("tiers.json: 'dispatchHeader' must be a boolean");
  }
}

function validateTaskPromptRepair(obj: Record<string, unknown>): void {
  if (obj.taskPromptRepair !== undefined && typeof obj.taskPromptRepair !== "boolean") {
    throw new Error("tiers.json: 'taskPromptRepair' must be a boolean");
  }
}

function validateFalseRefusalDetection(obj: Record<string, unknown>): void {
  if (obj.falseRefusalDetection !== undefined && typeof obj.falseRefusalDetection !== "boolean") {
    throw new Error("tiers.json: 'falseRefusalDetection' must be a boolean");
  }
}

function validateDelegateInstructions(obj: Record<string, unknown>): void {
  if (obj.delegateInstructions === undefined) return;
  if (!["strip-global", "strip-all", "keep"].some((policy) => policy === obj.delegateInstructions)) {
    throw new Error(
      "tiers.json: 'delegateInstructions' must be one of strip-global|strip-all|keep",
    );
  }
}

function validateModes(obj: Record<string, unknown>): void {
  // Validate modes if present
  if (obj.modes !== undefined) {
    if (!isPlainObject(obj.modes)) {
      throw new Error("tiers.json: 'modes' must be an object");
    }
    const modes = obj.modes as Record<string, unknown>;
    for (const [modeName, mode] of Object.entries(modes)) {
      if (typeof mode !== "object" || mode === null) {
        throw new Error(`tiers.json: mode '${modeName}' must be an object`);
      }
      const m = mode as Record<string, unknown>;
      if (typeof m.defaultTier !== "string") {
        throw new Error(
          `tiers.json: mode '${modeName}.defaultTier' must be a string`,
        );
      }
      if (typeof m.description !== "string") {
        throw new Error(
          `tiers.json: mode '${modeName}.description' must be a string`,
        );
      }
    }
  }
}

function validateTierCaps(obj: Record<string, unknown>): void {
  // Validate tierCaps if present
  if (obj.tierCaps !== undefined) {
    if (!isPlainObject(obj.tierCaps)) {
      throw new Error("tiers.json: 'tierCaps' must be an object");
    }
    const tc = obj.tierCaps as Record<string, unknown>;
    for (const [tierName, cap] of Object.entries(tc)) {
      if (typeof cap !== "number" || !Number.isFinite(cap) || cap < 1) {
        throw new Error(
          `tiers.json: tierCaps.'${tierName}' must be a positive integer`,
        );
      }
    }
  }
}

function validateTierPrompts(obj: Record<string, unknown>): void {
  // Validate tierPrompts if present
  if (obj.tierPrompts !== undefined) {
    if (!isPlainObject(obj.tierPrompts)) {
      throw new Error("tiers.json: 'tierPrompts' must be an object");
    }
    const tp = obj.tierPrompts as Record<string, unknown>;
    for (const [tierName, prompt] of Object.entries(tp)) {
      if (typeof prompt !== "string") {
        throw new Error(
          `tiers.json: tierPrompts.'${tierName}' must be a string`,
        );
      }
    }
  }
}

function validateTierPromptsGoalOriented(obj: Record<string, unknown>): void {
  // Validate tierPromptsGoalOriented if present
  if (obj.tierPromptsGoalOriented !== undefined) {
    if (!isPlainObject(obj.tierPromptsGoalOriented)) {
      throw new Error("tiers.json: 'tierPromptsGoalOriented' must be an object");
    }
    const tp = obj.tierPromptsGoalOriented as Record<string, unknown>;
    for (const [tierName, prompt] of Object.entries(tp)) {
      if (typeof prompt !== "string") {
        throw new Error(
          `tiers.json: tierPromptsGoalOriented.'${tierName}' must be a string`,
        );
      }
    }
  }
}

function validateModelGenerations(obj: Record<string, unknown>): void {
  // Validate modelGenerations if present. Element-level non-strings are tolerated
  // and filtered at match time rather than rejected here, so one bad entry in an
  // override file cannot drop the whole layer.
  if (obj.modelGenerations !== undefined) {
    if (!isPlainObject(obj.modelGenerations)) {
      throw new Error("tiers.json: modelGenerations must be an object");
    }
    const modelGenerations = obj.modelGenerations as Record<string, unknown>;
    // Only `strong` is validated because only `strong` is read. Unknown keys —
    // including the removed `claude5x` — are ignored rather than rejected, so an
    // existing tiers.json carrying one still loads.
    if (
      modelGenerations.strong !== undefined &&
      !Array.isArray(modelGenerations.strong)
    ) {
      throw new Error("tiers.json: modelGenerations.strong must be an array");
    }
  }
}

function validateSubagentTiers(obj: Record<string, unknown>): void {
  if (obj.subagentTiers === undefined) return;
  if (!isPlainObject(obj.subagentTiers)) {
    throw new Error("tiers.json: 'subagentTiers' must be an object");
  }
  for (const [agentName, tierName] of Object.entries(obj.subagentTiers)) {
    if (typeof tierName !== "string" || tierName === "") {
      throw new Error(
        `tiers.json: subagentTiers.'${agentName}' must be a non-empty tier name`,
      );
    }
  }
  // Deliberately not checking that the tier exists: a map may name a tier that
  // only some presets define, and switching preset must never brick startup.
  // Unknown tiers are skipped at resolve time (see resolveSubagentOverrides).
}

function validateTaskPatterns(obj: Record<string, unknown>): void {
  // Validate taskPatterns if present
  if (obj.taskPatterns !== undefined) {
    if (!isPlainObject(obj.taskPatterns)) {
      throw new Error("tiers.json: 'taskPatterns' must be an object");
    }
    const tp = obj.taskPatterns as Record<string, unknown>;
    for (const [tierName, patterns] of Object.entries(tp)) {
      if (!Array.isArray(patterns)) {
        throw new Error(
          `tiers.json: taskPatterns.'${tierName}' must be an array of strings`,
        );
      }
    }
  }
}

/**
 * Largest delay `setTimeout` honours (2^31 - 1 ms). Node and bun clamp any
 * larger delay to 1 ms, turning a "huge" budget into an immediate timeout.
 */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Equals the depth tracker's MAX_DEPTH_HOPS (src/router/depth.ts, Phase 1.2),
 * so a cycle or over-long chain counted as 32 is refused under every configured limit.
 */
export const MAX_DELEGATION_DEPTH_LIMIT = 32;

/** Total, typed and bounded rendering of an invalid config value. */
function describeValue(value: unknown): string {
  let description: string;
  try {
    if (typeof value === "string") description = JSON.stringify(value);
    else if (typeof value === "number") description = Object.is(value, -0) ? "-0" : String(value);
    else if (typeof value === "bigint") description = `${value}n`;
    else if (value === null) description = "null";
    else if (typeof value === "object") {
      const tag = Array.isArray(value) ? "array" : "object";
      description = `${tag} ${JSON.stringify(value) ?? "<unserializable>"}`;
    } else if (typeof value === "function") description = "<function>";
    else description = String(value);
  } catch {
    description = `<${typeof value}>`;
  }
  if (description.length <= 80) return description;
  // Keep the 80-code-unit bound without splitting a surrogate pair.
  const end = /[\uD800-\uDBFF]/.test(description[78]!) && /[\uDC00-\uDFFF]/.test(description[79]!) ? 78 : 79;
  return `${description.slice(0, end)}…`;
}

/** Copy without invoking accessors again; include defined get-only Proxy values. */
function withValidatedSnapshots<T extends object>(
  obj: T,
  snapshots: Record<string, unknown>,
): T {
  const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(obj);
  let changed = false;
  for (const [key, value] of Object.entries(snapshots)) {
    if (value !== undefined || Object.hasOwn(descriptors, key) || key in obj) {
      descriptors[key] = { value, writable: true, enumerable: true, configurable: true };
      changed = true;
    }
  }
  if (!changed) return obj;
  // Keep inherited config values and array identity, not just own descriptors.
  const copy: object = Array.isArray(obj) ? [] : Object.create(Object.getPrototypeOf(obj));
  if (Array.isArray(obj)) Object.setPrototypeOf(copy, Object.getPrototypeOf(obj));
  Object.defineProperties(copy, descriptors);
  if (Object.isFrozen(obj)) Object.freeze(copy);
  return copy as T;
}

/** Reject keys that could reparent a later Object.assign copy. */
function rejectPrototypeKeys(obj: object, path: string): void {
  for (const key of ["__proto__", "constructor", "prototype"] as const) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      throw new Error(`tiers.json: ${path} must not contain the key "${key}"`);
    }
  }
}

function validateEnforcement(value: unknown): Record<string, unknown> | undefined {
  // Validate enforcement if present (optional — absent means no enforcement)
  if (value !== undefined) {
    if (!isPlainObject(value)) {
      throw new Error("tiers.json: enforcement must be an object");
    }
    const enforcement = value as Record<string, unknown>;
    rejectPrototypeKeys(enforcement, "enforcement");
    const maxDelegationDepth = enforcement.maxDelegationDepth;
    if (
      maxDelegationDepth !== undefined &&
      maxDelegationDepth !== null &&
      (typeof maxDelegationDepth !== "number" ||
        !Number.isSafeInteger(maxDelegationDepth) ||
        maxDelegationDepth < 1 ||
        maxDelegationDepth > MAX_DELEGATION_DEPTH_LIMIT)
    ) {
      throw new Error(
        `tiers.json: enforcement.maxDelegationDepth must be null or an integer from 1 to 32 (got ${describeValue(maxDelegationDepth)})`,
      );
    }
    if (enforcement.mode !== undefined) {
      if (!["off", "advisory", "enforced"].includes(enforcement.mode as string)) {
        throw new Error(
          "tiers.json: enforcement.mode must be one of off|advisory|enforced",
        );
      }
    }
    if (enforcement.envGate !== undefined) {
      if (typeof enforcement.envGate !== "string" || !enforcement.envGate) {
        throw new Error(
          "tiers.json: enforcement.envGate must be a non-empty string",
        );
      }
    }
    if (enforcement.verify !== undefined) {
      // A non-object (including `null`) would skip every check below, and an
      // override `verify: null` would erase the whole bundled block on merge.
      if (!isPlainObject(enforcement.verify)) {
        throw new Error("tiers.json: enforcement.verify must be an object");
      }
      const verify = enforcement.verify as Record<string, unknown>;
      rejectPrototypeKeys(verify, "enforcement.verify");
      if (verify.testBaseline !== undefined && typeof verify.testBaseline !== "boolean") {
        throw new Error("tiers.json: enforcement.verify.testBaseline must be a boolean");
      }
      if (verify.strictUnverifiable !== undefined && typeof verify.strictUnverifiable !== "boolean") {
        throw new Error("tiers.json: enforcement.verify.strictUnverifiable must be a boolean");
      }
      if (
        verify.graderPolicy !== undefined &&
        verify.graderPolicy !== "atLeastProducerTier"
      ) {
        throw new Error(
          'tiers.json: enforcement.verify.graderPolicy must be "atLeastProducerTier"',
        );
      }
      // `null` is the shipped default and means "no floor" — same as absent.
      if (
        verify.minGraderTier !== undefined &&
        verify.minGraderTier !== null &&
        typeof verify.minGraderTier !== "string"
      ) {
        throw new Error(
          "tiers.json: enforcement.verify.minGraderTier must be a string or null",
        );
      }
      if (verify.graderTemperature !== undefined && verify.graderTemperature !== null) {
        if (
          typeof verify.graderTemperature !== "number" ||
          !Number.isFinite(verify.graderTemperature) ||
          verify.graderTemperature < 0
        ) {
          throw new Error(
            "tiers.json: enforcement.verify.graderTemperature must be a number >= 0 or null",
          );
        }
      }
      if (verify.graderTemperatureModels !== undefined) {
        if (!Array.isArray(verify.graderTemperatureModels)) {
          throw new Error("tiers.json: enforcement.verify.graderTemperatureModels must be an array");
        }
        for (const entry of verify.graderTemperatureModels) {
          const slash = typeof entry === "string" ? entry.indexOf("/") : -1;
          if (typeof entry !== "string" || slash < 1 || !entry.slice(0, slash).trim() || !entry.slice(slash + 1).trim()) {
            throw new Error("tiers.json: enforcement.verify.graderTemperatureModels entries must be non-empty provider/model strings");
          }
        }
      }
      // Time-box ceilings. `>= 1` and not `>= 0`: a 0 or negative budget is
      // almost always meant as "no timeout", and silently reading it as an
      // immediately-expiring one would make every delegation fail. Reject it
      // at the config boundary and say so, rather than guessing.
      for (const key of [
        "delegateTimeoutMs",
        "graderTimeoutMs",
        "gateBudgetMs",
        "baselineTimeoutMs",
        "pendingTtlMs",
        "recheckTimeoutMs",
      ] as const) {
        const value = verify[key];
        if (value !== undefined) {
          if (
            !Number.isInteger(value) ||
            (value as number) < 1 ||
            (value as number) > MAX_TIMER_MS
          ) {
            throw new Error(
              `tiers.json: enforcement.verify.${key} must be an integer >= 1 and <= ${MAX_TIMER_MS} (milliseconds)`,
            );
          }
        }
      }
      // Waits/windows where 0 is meaningful ("no wait", "no batching").
      for (const key of ["captureWaitMs", "slotWaitMs", "batchWindowMs"] as const) {
        const value = verify[key];
        if (
          value !== undefined &&
          (!Number.isInteger(value) || (value as number) < 0 || (value as number) > MAX_TIMER_MS)
        ) {
          throw new Error(
            `tiers.json: enforcement.verify.${key} must be an integer >= 0 and <= ${MAX_TIMER_MS} (milliseconds)`,
          );
        }
      }
      // Safe integers only: `1e21` passes `Number.isInteger` but stringifies to
      // `1e+21`, which no test runner parses as a worker count.
      for (const key of ["maxWorkers", "maxConcurrentVerifications"] as const) {
        const value = verify[key];
        if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 1)) {
          throw new Error(`tiers.json: enforcement.verify.${key} must be an integer >= 1`);
        }
      }
      for (const key of ["lowPriority", "background", "failureRecheck"] as const) {
        const value = verify[key];
        if (value !== undefined && typeof value !== "boolean") {
          throw new Error(`tiers.json: enforcement.verify.${key} must be a boolean`);
        }
      }
      if (
        verify.testScope !== undefined &&
        verify.testScope !== "affected" &&
        verify.testScope !== "full"
      ) {
        throw new Error(
          'tiers.json: enforcement.verify.testScope must be "affected" or "full"',
        );
      }
      if (
        verify.defaultVerify !== undefined &&
        verify.defaultVerify !== "deferred" &&
        verify.defaultVerify !== "required"
      ) {
        throw new Error(
          'tiers.json: enforcement.verify.defaultVerify must be "deferred" or "required"',
        );
      }
      if (
        verify.requireExplicitDoD !== undefined &&
        typeof verify.requireExplicitDoD !== "boolean"
      ) {
        throw new Error(
          "tiers.json: enforcement.verify.requireExplicitDoD must be a boolean",
        );
      }
    }
    const escalateValue = enforcement.escalate;
    const snapshots: Record<string, unknown> = { maxDelegationDepth, escalate: escalateValue };
    if (
      escalateValue !== undefined &&
      typeof escalateValue === "object" &&
      escalateValue !== null
    ) {
      const escalate = escalateValue as Record<string, unknown>;
      rejectPrototypeKeys(escalate, "enforcement.escalate");
      const effortBump = escalate.effortBump;
      if (effortBump !== undefined && typeof effortBump !== "boolean") {
        throw new Error(`tiers.json: enforcement.escalate.effortBump must be a boolean (got ${describeValue(effortBump)})`);
      }
      const effortBumpMax = escalate.effortBumpMax;
      if (
        effortBumpMax !== undefined &&
        !EFFORT_LEVELS.some((level) => level === effortBumpMax)
      ) {
        throw new Error(
          `tiers.json: enforcement.escalate.effortBumpMax must be one of ${EFFORT_LEVELS.join("|")} (got ${describeValue(effortBumpMax)})`,
        );
      }
      const variantSteps = escalate.variantSteps;
      if (variantSteps !== undefined && !pickEnum(VARIANT_STEP_MODES, variantSteps)) {
        throw new Error(
          `tiers.json: enforcement.escalate.variantSteps must be one of ${VARIANT_STEP_MODES.join("|")} (got ${describeValue(variantSteps)})`,
        );
      }
      snapshots.escalate = withValidatedSnapshots(escalate, { effortBump, effortBumpMax, variantSteps });
      if (
        escalate.costCeiling !== undefined &&
        typeof escalate.costCeiling === "object" &&
        escalate.costCeiling !== null
      ) {
        const costCeiling = escalate.costCeiling as Record<string, unknown>;
        if (costCeiling.multiple !== undefined) {
          if (
            typeof costCeiling.multiple !== "number" ||
            costCeiling.multiple <= 0
          ) {
            throw new Error(
              "tiers.json: enforcement.escalate.costCeiling.multiple must be a number > 0",
            );
          }
        }
      }
      if (escalate.ladder !== undefined) {
        if (
          !Array.isArray(escalate.ladder) ||
          !escalate.ladder.every((s: unknown) => typeof s === "string")
        ) {
          throw new Error(
            "tiers.json: enforcement.escalate.ladder must be an array of strings",
          );
        }
      }
      if (escalate.maxAttemptsPerTier !== undefined) {
        if (
          typeof escalate.maxAttemptsPerTier !== "number" ||
          !Number.isInteger(escalate.maxAttemptsPerTier) ||
          escalate.maxAttemptsPerTier < 0
        ) {
          throw new Error(
            "tiers.json: enforcement.escalate.maxAttemptsPerTier must be an integer >= 0",
          );
        }
      }
      if (escalate.maxTotalAttempts !== undefined) {
        if (
          typeof escalate.maxTotalAttempts !== "number" ||
          !Number.isInteger(escalate.maxTotalAttempts) ||
          escalate.maxTotalAttempts < 1
        ) {
          throw new Error(
            "tiers.json: enforcement.escalate.maxTotalAttempts must be an integer >= 1",
          );
        }
      }
      if (
        escalate.floorTier !== undefined &&
        escalate.floorTier !== null &&
        typeof escalate.floorTier !== "string"
      ) {
        throw new Error(
          "tiers.json: enforcement.escalate.floorTier must be a string or null",
        );
      }
    }
    if (
      enforcement.perTier !== undefined &&
      typeof enforcement.perTier === "object" &&
      enforcement.perTier !== null &&
      !Array.isArray(enforcement.perTier)
    ) {
      const perTier = enforcement.perTier as Record<string, unknown>;
      for (const [tierName, tierMode] of Object.entries(perTier)) {
        if (!["off", "advisory", "enforced"].includes(tierMode as string)) {
          throw new Error(
            `tiers.json: enforcement.perTier.${tierName} must be one of off|advisory|enforced`,
          );
        }
      }
    }
    if (
      enforcement.guard !== undefined &&
      typeof enforcement.guard === "object" &&
      enforcement.guard !== null
    ) {
      const guard = enforcement.guard as Record<string, unknown>;
      if (guard.budget !== undefined) {
        if (
          typeof guard.budget !== "number" ||
          !Number.isFinite(guard.budget) ||
          guard.budget < 1
        ) {
          throw new Error("tiers.json: enforcement.guard.budget must be a number >= 1");
        }
      }
      if (guard.blockScriptWrites !== undefined) {
        if (typeof guard.blockScriptWrites !== "boolean") {
          throw new Error(
            "tiers.json: enforcement.guard.blockScriptWrites must be a boolean",
          );
        }
      }
      for (const key of ["readDraftCap", "sameOpRetryCap"] as const) {
        if (guard[key] !== undefined) {
          if (
            typeof guard[key] !== "number" ||
            !Number.isInteger(guard[key]) ||
            (guard[key] as number) < 0
          ) {
            throw new Error(
              `tiers.json: enforcement.guard.${key} must be an integer >= 0`,
            );
          }
        }
      }
      for (const key of ["blockSelfScript", "deliverableFirst"] as const) {
        if (guard[key] !== undefined && typeof guard[key] !== "boolean") {
          throw new Error(
            `tiers.json: enforcement.guard.${key} must be a boolean`,
          );
        }
      }
    }
    if (
      enforcement.proportional !== undefined &&
      typeof enforcement.proportional === "object" &&
      enforcement.proportional !== null
    ) {
      const proportional = enforcement.proportional as Record<string, unknown>;
      if (
        proportional.trivialBypass !== undefined &&
        typeof proportional.trivialBypass !== "boolean"
      ) {
        throw new Error(
          "tiers.json: enforcement.proportional.trivialBypass must be a boolean",
        );
      }
    }
    return withValidatedSnapshots(enforcement, snapshots);
  }
}

// ---------------------------------------------------------------------------
// Cost-aware routing validation (#74)
//
// Unknown keys inside `routing` are ignored, not rejected: that is the policy of
// every other block in this file (see modelGenerations), so a config written for
// a newer release still loads on an older one. The only keys refused are the
// prototype-reparenting ones (rejectPrototypeKeys), as for `enforcement`.
// Validators read every value exactly once and return a plain snapshot of what
// they validated, so a config object cannot change between check and use.
// ---------------------------------------------------------------------------

/**
 * Agent ids in `routing.roles`: host agent names, case-sensitive (an agent may be
 * called `ContextScout` or `team/helper`; QA-1.1-5). Nothing that could not be a
 * name: no empty id, no whitespace, no `#`.
 */
const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_./-]*$/;
/** Environment variable names (`classifier.apiKeyEnv`). */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A variant id: non-empty, no whitespace, no `#` (the ref separator). */
const VARIANT_ID_PATTERN = /^[^\s#]+$/;

/** `value` as a member of `allowed`, narrowed without a cast. */
function pickEnum<T extends string>(allowed: readonly T[], value: unknown): T | undefined {
  return allowed.find((candidate) => candidate === value);
}

function readEnum<T extends string>(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  allowed: readonly T[],
): T | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  const hit = pickEnum(allowed, value);
  if (hit === undefined) {
    throw new Error(
      `tiers.json: ${path}.${key} must be one of ${allowed.join("|")} (got ${describeValue(value)})`,
    );
  }
  return hit;
}

interface NumberRule {
  min: number;
  max: number;
  /** `min` itself is not allowed (an open lower bound). */
  minExclusive?: boolean;
  integer?: boolean;
}

function readNumber(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  rule: NumberRule,
): number | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  const inRange =
    typeof value === "number" &&
    Number.isFinite(value) &&
    (!rule.integer || Number.isInteger(value)) &&
    (rule.minExclusive ? value > rule.min : value >= rule.min) &&
    value <= rule.max;
  if (typeof value !== "number" || !inRange) {
    const lower = rule.minExclusive ? `> ${rule.min}` : `>= ${rule.min}`;
    throw new Error(
      `tiers.json: ${path}.${key} must be ${rule.integer ? "an integer" : "a number"} ${lower} and <= ${rule.max} (got ${describeValue(value)})`,
    );
  }
  return value;
}

function readBoolean(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): boolean | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`tiers.json: ${path}.${key} must be a boolean (got ${describeValue(value)})`);
  }
  return value;
}

/** A nested object block; `null` and arrays are refused (an override `null` would erase a block). */
function readBlock(
  parent: Record<string, unknown>,
  key: string,
  path: string,
): Record<string, unknown> | undefined {
  const value = parent[key];
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new Error(`tiers.json: ${path}.${key} must be an object (got ${describeValue(value)})`);
  }
  rejectPrototypeKeys(value, `${path}.${key}`);
  return value;
}

/** `provider/model` or `provider/model#variant` (a catalog reference). */
function isCatalogRef(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const hash = value.indexOf("#");
  if (hash === -1) return parseModelRef(value) !== undefined;
  return VARIANT_ID_PATTERN.test(value.slice(hash + 1)) && parseModelRef(value.slice(0, hash)) !== undefined;
}

/** `model` / `backend` pair read from a classifier block or a per-preset override. */
function readClassifierModel(obj: Record<string, unknown>, path: string): string | null | undefined {
  const model = obj.model;
  if (model === undefined || model === null) return model;
  if (!isCatalogRef(model)) {
    throw new Error(
      `tiers.json: ${path}.model must be null or a 'provider/model[#variant]' string (got ${describeValue(model)})`,
    );
  }
  return model;
}

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** D3: a backend other than `rules` needs a model; the HTTP backends also need a URL. */
function assertClassifierUsable(
  path: string,
  backend: ClassifierBackend,
  model: string | null | undefined,
  baseUrl: string | null | undefined,
  modelKeys: string,
): void {
  if (backend === "rules") return;
  if (typeof model !== "string" || model === "") {
    throw new Error(
      `tiers.json: ${modelKeys} must be a non-empty 'provider/model[#variant]' string when ${path}.backend is "${backend}" (the classifier is never picked automatically)`,
    );
  }
  if ((backend === "openai-compatible" || backend === "typesafe") && !baseUrl) {
    throw new Error(
      `tiers.json: routing.classifier.baseUrl must be an http(s) URL when ${path}.backend is "${backend}"`,
    );
  }
}

function validateClassifier(routing: Record<string, unknown>): ClassifierConfig | undefined {
  const c = readBlock(routing, "classifier", "routing");
  if (c === undefined) return undefined;
  const path = "routing.classifier";
  const out: ClassifierConfig = {};

  const backend = readEnum(c, "backend", path, CLASSIFIER_BACKENDS);
  if (backend !== undefined) out.backend = backend;

  const model = readClassifierModel(c, path);
  if (model !== undefined) out.model = model;

  const baseUrl = c.baseUrl;
  if (baseUrl !== undefined && baseUrl !== null) {
    if (typeof baseUrl !== "string" || !isHttpUrl(baseUrl)) {
      throw new Error(
        `tiers.json: ${path}.baseUrl must be null or an http(s) URL (got ${describeValue(baseUrl)})`,
      );
    }
  }
  if (baseUrl !== undefined) out.baseUrl = baseUrl;

  const apiKeyEnv = c.apiKeyEnv;
  if (apiKeyEnv !== undefined && apiKeyEnv !== null) {
    if (typeof apiKeyEnv !== "string" || !ENV_NAME_PATTERN.test(apiKeyEnv)) {
      throw new Error(
        `tiers.json: ${path}.apiKeyEnv must be null or an environment variable name (got ${describeValue(apiKeyEnv)})`,
      );
    }
  }
  if (apiKeyEnv !== undefined) out.apiKeyEnv = apiKeyEnv;

  const timeoutMs = readNumber(c, "timeoutMs", path, { min: 100, max: 30_000, integer: true });
  if (timeoutMs !== undefined) out.timeoutMs = timeoutMs;

  const samples = c.samples;
  if (samples !== undefined) {
    if (samples !== 1 && samples !== 3) {
      throw new Error(`tiers.json: ${path}.samples must be 1 or 3 (got ${describeValue(samples)})`);
    }
    out.samples = samples;
  }

  const maxStateChars = readNumber(c, "maxStateChars", path, { min: 200, max: 20_000, integer: true });
  if (maxStateChars !== undefined) out.maxStateChars = maxStateChars;

  const presets = readBlock(c, "presets", path);
  if (presets !== undefined) {
    const snapshot: Record<string, ClassifierPresetOverride> = {};
    for (const [presetName, entry] of Object.entries(presets)) {
      const entryPath = `${path}.presets.'${presetName}'`;
      if (!isPlainObject(entry)) {
        throw new Error(`tiers.json: ${entryPath} must be an object (got ${describeValue(entry)})`);
      }
      rejectPrototypeKeys(entry, entryPath);
      const override: ClassifierPresetOverride = {};
      const entryBackend = readEnum(entry, "backend", entryPath, CLASSIFIER_BACKENDS);
      if (entryBackend !== undefined) override.backend = entryBackend;
      const entryModel = readClassifierModel(entry, entryPath);
      if (entryModel !== undefined) override.model = entryModel;
      snapshot[presetName] = override;
    }
    out.presets = snapshot;
  }

  // The top level and every per-preset override must each resolve to a usable
  // classifier, whichever layer supplied which key.
  const effectiveBackend = out.backend ?? "rules";
  assertClassifierUsable(path, effectiveBackend, out.model, out.baseUrl, `${path}.model`);
  for (const [presetName, override] of Object.entries(out.presets ?? {})) {
    const entryPath = `${path}.presets.'${presetName}'`;
    assertClassifierUsable(
      entryPath,
      override.backend ?? effectiveBackend,
      override.model !== undefined ? override.model : out.model,
      out.baseUrl,
      `${path}.model or ${entryPath}.model`,
    );
  }
  return out;
}

function validateRoles(routing: Record<string, unknown>): Record<string, string[]> | undefined {
  const roles = readBlock(routing, "roles", "routing");
  if (roles === undefined) return undefined;
  const out: Record<string, string[]> = {};
  for (const [taskClass, agents] of Object.entries(roles)) {
    if (!pickEnum(ROUTING_TASK_CLASSES, taskClass)) {
      throw new Error(
        `tiers.json: routing.roles class '${taskClass}' must be one of ${ROUTING_TASK_CLASSES.join("|")}`,
      );
    }
    // An empty list is allowed: it means "no native candidates for this class"
    // (a deliberate deviation from "non-empty arrays", QA-1.1-7).
    if (!Array.isArray(agents)) {
      throw new Error(
        `tiers.json: routing.roles.'${taskClass}' must be an array of agent ids (got ${describeValue(agents)})`,
      );
    }
    const ids: string[] = [];
    for (const agent of agents as unknown[]) {
      if (typeof agent !== "string" || !AGENT_ID_PATTERN.test(agent)) {
        throw new Error(
          `tiers.json: routing.roles.'${taskClass}' entries must be agent ids matching ${AGENT_ID_PATTERN.source} (got ${describeValue(agent)})`,
        );
      }
      ids.push(agent);
    }
    out[taskClass] = ids;
  }
  return out;
}

/**
 * Validate `routing` and return a snapshot of the validated values (or
 * `undefined` when absent). Defaults are NOT applied here; see resolveRouting.
 */
function validateRouting(value: unknown): RoutingConfig | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new Error(`tiers.json: 'routing' must be an object (got ${describeValue(value)})`);
  }
  rejectPrototypeKeys(value, "routing");
  const routing = value;
  const out: RoutingConfig = {};

  const engine = readEnum(routing, "engine", "routing", ROUTING_ENGINES);
  if (engine !== undefined) out.engine = engine;
  const profile = readEnum(routing, "profile", "routing", ROUTING_PROFILES);
  if (profile !== undefined) out.profile = profile;
  const margin = readNumber(routing, "margin", "routing", { min: 0, max: 0.9 });
  if (margin !== undefined) out.margin = margin;
  const minClassConfidence = readNumber(routing, "minClassConfidence", "routing", { min: 0, max: 1 });
  if (minClassConfidence !== undefined) out.minClassConfidence = minClassConfidence;

  const detection = readBlock(routing, "detection", "routing");
  if (detection !== undefined) {
    const d: DetectionConfig = {};
    for (const key of ["deterministic", "grader", "none"] as const) {
      const v = readNumber(detection, key, "routing.detection", { min: 0, max: 1 });
      if (v !== undefined) d[key] = v;
    }
    out.detection = d;
  }

  const classifier = validateClassifier(routing);
  if (classifier !== undefined) out.classifier = classifier;
  const roles = validateRoles(routing);
  if (roles !== undefined) out.roles = roles;

  const outcomes = readBlock(routing, "outcomes", "routing");
  if (outcomes !== undefined) {
    const o: OutcomesConfig = {};
    const path = outcomes.path;
    if (path !== undefined) {
      if (path !== null && (typeof path !== "string" || path === "")) {
        throw new Error(
          `tiers.json: routing.outcomes.path must be null or a non-empty string (got ${describeValue(path)})`,
        );
      }
      o.path = path;
    }
    const halfLifeDays = readNumber(outcomes, "halfLifeDays", "routing.outcomes", { min: 1, max: 365 });
    if (halfLifeDays !== undefined) o.halfLifeDays = halfLifeDays;
    const maxEffectiveSamples = readNumber(outcomes, "maxEffectiveSamples", "routing.outcomes", {
      min: 5,
      max: 1000,
    });
    if (maxEffectiveSamples !== undefined) o.maxEffectiveSamples = maxEffectiveSamples;
    out.outcomes = o;
  }

  const sessionReuse = readBlock(routing, "sessionReuse", "routing");
  if (sessionReuse !== undefined) {
    const s: SessionReuseConfig = {};
    const maxContextFraction = readNumber(sessionReuse, "maxContextFraction", "routing.sessionReuse", {
      min: 0,
      max: 0.95,
      minExclusive: true,
    });
    if (maxContextFraction !== undefined) s.maxContextFraction = maxContextFraction;
    out.sessionReuse = s;
  }

  const advisor = readBlock(routing, "advisor", "routing");
  if (advisor !== undefined) {
    const a: AdvisorConfig = {};
    const enabled = readBoolean(advisor, "enabled", "routing.advisor");
    if (enabled !== undefined) a.enabled = enabled;
    const noticeIntervalHours = readNumber(advisor, "noticeIntervalHours", "routing.advisor", {
      min: 1,
      max: 720,
    });
    if (noticeIntervalHours !== undefined) a.noticeIntervalHours = noticeIntervalHours;
    out.advisor = a;
  }

  return out;
}

/**
 * `tiers.<t>.candidates`: ordered rungs of a tier's ladder, in escalation order.
 *
 * - `model` falls back to the tier's own; an omitted `variant` is the model's
 *   default variant; an omitted `costRatio` is the tier's.
 * - No two rungs may name the same effective `(model, variant)`.
 * - A non-empty list must contain the tier's own effective `(model, variant)`
 *   (QA-1.1-3): the static choice must be one of the rungs, or the engine's
 *   degenerate case (D2) would have nothing to start from. That rung's
 *   `costRatio` is the tier's own, so it must equal it or be omitted.
 * - Effective `costRatio` must not decrease along the list (QA-1.1-12): the list
 *   is walked upward on failure, and a cheaper later rung is not an escalation.
 */
function validateTierCandidates(
  tier: Record<string, unknown>,
  label: string,
  tierName: string,
): void {
  const candidates = tier.candidates;
  if (candidates === undefined) return;
  if (!Array.isArray(candidates)) {
    throw new Error(`tiers.json: '${label}.candidates' must be an array`);
  }
  const seen = new Map<string, number>();
  const tierCostRatio =
    typeof tier.costRatio === "number" && Number.isFinite(tier.costRatio) && tier.costRatio > 0
      ? tier.costRatio
      : tierDefaultsFor(tierName).costRatio;
  const effectiveCosts: number[] = [];
  const declaredCosts: Array<number | undefined> = [];
  for (let i = 0; i < candidates.length; i++) {
    const entry: unknown = candidates[i];
    const where = `${label}.candidates[${i}]`;
    if (!isPlainObject(entry)) {
      throw new Error(`tiers.json: '${where}' must be an object`);
    }
    rejectPrototypeKeys(entry, `${label}.candidates[${i}]`);
    const model = entry.model;
    if (model !== undefined && (typeof model !== "string" || !parseModelRef(model))) {
      throw new Error(
        `tiers.json: '${where}.model' must be 'provider/model' (got ${describeValue(model)})`,
      );
    }
    const variant = entry.variant;
    if (variant !== undefined && (typeof variant !== "string" || !VARIANT_ID_PATTERN.test(variant))) {
      throw new Error(
        `tiers.json: '${where}.variant' must be a non-empty string without whitespace or '#' (got ${describeValue(variant)})`,
      );
    }
    const costRatio = entry.costRatio;
    if (
      costRatio !== undefined &&
      (typeof costRatio !== "number" || !Number.isFinite(costRatio) || costRatio <= 0)
    ) {
      throw new Error(
        `tiers.json: '${where}.costRatio' must be a number > 0 (got ${describeValue(costRatio)})`,
      );
    }
    const effectiveModel = typeof model === "string" ? model : String(tier.model);
    const key = `${effectiveModel}\u0000${typeof variant === "string" ? variant : ""}`;
    const first = seen.get(key);
    if (first !== undefined) {
      throw new Error(
        `tiers.json: '${where}' repeats (model, variant) = (${effectiveModel}, ${typeof variant === "string" ? variant : "default"}) of candidates[${first}]`,
      );
    }
    seen.set(key, i);
    declaredCosts.push(typeof costRatio === "number" ? costRatio : undefined);
    effectiveCosts.push(typeof costRatio === "number" ? costRatio : tierCostRatio);
  }
  if (candidates.length === 0) return;

  const ownVariant = typeof tier.variant === "string" ? tier.variant : "";
  const ownIndex = seen.get(`${String(tier.model)}\u0000${ownVariant}`);
  if (ownIndex === undefined) {
    throw new Error(
      `tiers.json: '${label}.candidates' must include the tier's own rung (model ${String(tier.model)}, variant ${ownVariant === "" ? "default" : ownVariant}): the static choice has to be one of the candidates`,
    );
  }
  const ownCost = declaredCosts[ownIndex];
  if (ownCost !== undefined && ownCost !== tierCostRatio) {
    throw new Error(
      `tiers.json: '${label}.candidates[${ownIndex}].costRatio' (${ownCost}) must equal the tier's costRatio (${tierCostRatio}) because it is the tier's own rung, or be omitted`,
    );
  }
  for (let i = 1; i < effectiveCosts.length; i++) {
    if (effectiveCosts[i]! < effectiveCosts[i - 1]!) {
      throw new Error(
        `tiers.json: '${label}.candidates[${i}]' has costRatio ${effectiveCosts[i]}, lower than candidates[${i - 1}] (${effectiveCosts[i - 1]}): candidates are listed in escalation order, so costRatio must not decrease`,
      );
    }
  }
}

/** True when the tier lists at least one explicit candidate (an empty list counts as none). */
export function hasExplicitCandidates(tier: TierConfig): boolean {
  return Array.isArray(tier.candidates) && tier.candidates.length > 0;
}

/**
 * Validate a raw parsed config. Strict and throwing by design: the bundled
 * tiers.json must be valid on its own, and loadConfig turns a throw from an
 * override layer into a warning plus a fallback rather than a crash.
 * Returns a copy when enforcement is present (even an undefined accessor),
 * snapshotting its depth/effort values without mutating the caller. Copies
 * preserve prototypes, arrays, unrelated descriptors and source frozenness.
 *
 * Section order matters and is preserved from when this was one function: a
 * config with several problems reports the same first error it always did.
 */
export function validateConfig(raw: unknown): RouterConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("tiers.json: expected a JSON object at root");
  }


  const obj = raw as Record<string, unknown>;

  if (typeof obj.activePreset !== "string" || !obj.activePreset) {
    throw new Error("tiers.json: 'activePreset' must be a non-empty string");
  }

  const presets = validatePresets(obj);
  validateActivePreset(obj, presets);
  validateCoreKeys(obj);
  validateModes(obj);
  validateTierCaps(obj);
  validateTierPrompts(obj);
  validateTierPromptsGoalOriented(obj);
  validateModelGenerations(obj);
  validateTaskPatterns(obj);
  validateSubagentTiers(obj);
  const enforcement = validateEnforcement(obj.enforcement);
  validateDelegateInstructions(obj);
  validateDispatchHeader(obj);
  validateTaskPromptRepair(obj);
  validateFalseRefusalDetection(obj);
  const routing = validateRouting(obj.routing);

  const cfg = raw as RouterConfig;
  return withValidatedSnapshots(cfg, { enforcement, routing });
}

/**
 * Recursively merge `override` onto `base`. Plain objects merge key-by-key;
 * arrays and scalars are replaced wholesale (so e.g. an overridden `rules` or
 * `whenToUse` list replaces rather than appends). `undefined` values in the
 * override are skipped so they never blow away a base value.
 */
export function deepMerge(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override;
  }

  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    // `__proto__` from a parsed override would replace the merged object's own
    // prototype rather than becoming a key. Whoever writes the config file can
    // already do worse, so this is tidiness rather than a boundary, but a merge
    // helper should not be the thing that reparents an object.
    if (key === "__proto__" || key === "constructor") continue;
    result[key] =
      key in result && isPlainObject(result[key]) && isPlainObject(value)
        ? deepMerge(result[key], value)
        : value;
  }
  return result;
}

/**
 * Read and parse the optional user overrides file. Returns the parsed object,
 * or undefined when the file is absent/unreadable/invalid. Parse and shape
 * errors are surfaced via console.warn (never thrown) so a typo in the
 * overrides file can never brick opencode startup — but the user still gets a
 * visible reason why their override was ignored.
 */
function readOverridesAt(
  op: string,
  failures?: SourceFailure[],
): Record<string, unknown> | undefined {
  // Only ENOENT/ENOTDIR mean the file is absent. Any other stat error (EACCES on
  // a parent directory, a transient I/O error) is a failure, never a removal —
  // otherwise a reload would swap the last valid config for lower-priority
  // defaults.
  const kind = statKind(op);
  if (kind === "missing") return undefined;

  let text: string;
  try {
    if (kind !== "present") throw new Error(kind.message);
    text = readFileSync(op, "utf-8");
  } catch (err) {
    // The file is there but unreadable (permissions, a dangling symlink, a
    // race with a delete). Every other failure below says so; staying silent
    // here makes an unreadable override look exactly like an absent one.
    const reason = `cannot read it — ${(err as Error).message}`;
    console.warn(`[model-router] ignoring ${op}: ${reason}`);
    failures?.push({ source: op, message: `${op}: ${reason}` });
    return undefined;
  }

  try {
    const parsed = parseJsonc(text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      const reason = "expected a JSON object at root";
      console.warn(`[model-router] ignoring ${op}: ${reason}`);
      failures?.push({ source: op, message: `${op}: ${reason}` });
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    const reason = `invalid JSONC — ${(err as Error).message}`;
    console.warn(`[model-router] ignoring ${op}: ${reason}`);
    failures?.push({ source: op, message: `${op}: ${reason}` });
    return undefined;
  }
}

/**
 * A source that exists on disk but could not be used while building the
 * config. `source` is a stable key (a file path, or the joined layer paths for
 * a combined-merge failure); `message` is the user-facing reason.
 */
interface SourceFailure {
  source: string;
  message: string;
}

/**
 * The ordered override layers (lowest priority first): global, then
 * project-local. Each present, well-formed file becomes a layer that is
 * deep-merged over the ones before it.
 */
export interface OverrideLayer {
  path: string;
  data: Record<string, unknown>;
}

/**
 * `routing` keys that decide where task text is sent or where outcome data is
 * written. A repository-controlled file must not be able to set them (A18,
 * QA-1.1-2): cloning a project would otherwise let its author point the
 * classifier at their own server. Only the global override may.
 */
const GLOBAL_ONLY_ROUTING_KEYS: ReadonlyArray<readonly [block: string, key: string]> = [
  ["classifier", "backend"],
  ["classifier", "model"],
  ["classifier", "baseUrl"],
  ["classifier", "apiKeyEnv"],
  ["classifier", "presets"],
  ["outcomes", "path"],
];

/** Remove the global-only `routing` keys from a project layer; returns what was dropped. */
function stripGlobalOnlyRoutingKeys(data: Record<string, unknown>): string[] {
  const routing = data.routing;
  if (!isPlainObject(routing)) return [];
  const dropped: string[] = [];
  for (const [block, key] of GLOBAL_ONLY_ROUTING_KEYS) {
    const target = routing[block];
    if (isPlainObject(target) && Object.hasOwn(target, key)) {
      delete target[key];
      dropped.push(`routing.${block}.${key}`);
    }
  }
  return dropped;
}

function collectOverrideLayers(
  dir: string,
  failures?: SourceFailure[],
  notices?: ConfigNotice[],
): OverrideLayer[] {
  const layers: OverrideLayer[] = [];
  // Lowest priority first: global, then project-local (found by upward search
  // from the project directory).
  const sources = [
    { path: overridePath(), project: false },
    { path: walkForProjectOverride(dir), project: true },
  ];
  for (const { path: p, project } of sources) {
    if (!p) continue;
    const data = readOverridesAt(p, failures);
    if (!data) continue;
    if (project) {
      const dropped = stripGlobalOnlyRoutingKeys(data);
      if (dropped.length > 0) {
        notices?.push({
          source: p,
          message: `ignoring ${dropped.join(", ")} from ${p}: only the global override may set it`,
        });
      }
    }
    layers.push({ path: p, data });
  }
  return layers;
}

/**
 * Notices already reported to the console, so a rebuild with the same files does
 * not repeat itself: a notice about a file is reported once per (file, text); one
 * about the merged config, once per config fingerprint.
 */
const warnedNotices = new Set<string>();

function warnNoticesOnce(fingerprint: string, notices: readonly ConfigNotice[]): void {
  for (const notice of notices) {
    const key = `${notice.source ?? fingerprint}\n${notice.message}`;
    if (warnedNotices.has(key)) continue;
    if (warnedNotices.size >= 256) warnedNotices.clear();
    warnedNotices.add(key);
    console.warn(`[model-router] ${notice.message}`);
  }
}

/**
 * Canonical per-tier defaults, keyed by the conventional tier names. These are
 * the same values every bundled preset uses, so a preset defined in an overrides
 * file with only `model` per tier gets a sensible cost ladder and turn budgets.
 */
const TIER_DEFAULTS: Record<string, { costRatio: number; steps: number }> = {
  fast: { costRatio: 1, steps: 30 },
  medium: { costRatio: 5, steps: 50 },
  heavy: { costRatio: 20, steps: 120 },
};
const FALLBACK_TIER_DEFAULTS = { costRatio: 1, steps: 50 };

/** Defaults of a tier by name; own keys only, so `constructor` or `toString` are not tiers (QA-1.1-19). */
function tierDefaultsFor(tierName: string): { costRatio: number; steps: number } {
  return Object.hasOwn(TIER_DEFAULTS, tierName) ? TIER_DEFAULTS[tierName]! : FALLBACK_TIER_DEFAULTS;
}

/**
 * Fill in `costRatio`/`steps` for any tier that omits them, by tier name. Runs
 * after merge so override-defined presets behave well without restating the
 * conventional values; the effective numbers then show up in `/tiers` and the
 * injected protocol. Bundled presets already set both, so this is a no-op there.
 */
function applyTierDefaults(cfg: RouterConfig): void {
  for (const preset of Object.values(cfg.presets)) {
    for (const [tierName, tier] of Object.entries(preset)) {
      const d = tierDefaultsFor(tierName);
      if (tier.costRatio === undefined) tier.costRatio = d.costRatio;
      if (tier.steps === undefined) tier.steps = d.steps;
    }
  }
}

/**
 * Every file location that feeds loadConfig() for the (normalized) project
 * directory `dir` (undefined = none applicable).
 */
function sourcePaths(dir: string): Array<string | undefined> {
  return [configPath(), overridePath(), walkForProjectOverride(dir), statePath()];
}

/**
 * mtime/ctime/size fingerprint of every file that feeds loadConfig(). ctime is
 * included because restoring access to a previously unreadable file (chmod)
 * changes ctime but not mtime/size, and that must trigger a retry. Only
 * ENOENT/ENOTDIR map to `missing` (removal); any other stat error maps to
 * `error:<code>`, a distinct marker, so losing access to a file is never
 * fingerprinted — or reloaded — as if it had been deleted.
 */
function sourceFingerprint(paths: Array<string | undefined>): string {
  return paths
    .map((p) => {
      if (!p) return "none";
      try {
        const st = statSync(p);
        return `${p}:${st.mtimeMs}:${st.ctimeMs}:${st.size}`;
      } catch (err) {
        return isGoneError(err) ? `${p}:missing` : `${p}:error:${errnoCode(err)}`;
      }
    })
    .join("|");
}

/**
 * Load the effective config for the project directory `dir` (the host-provided
 * project dir; defaults to the process working directory). Each directory has
 * its own cache entry, so several project instances sharing one process never
 * see or overwrite each other's config.
 */
export function loadConfig(dir?: string): RouterConfig {
  const projectDir = normalizeProjectDir(dir);
  const entry = getCacheEntry(projectDir);
  const paths = sourcePaths(projectDir);
  const fingerprint = sourceFingerprint(paths);
  if (entry.config && !entry.dirty && fingerprint === entry.fingerprint) {
    return entry.config;
  }

  // A previous config is only a valid fallback when it was built for the same
  // project identity: HOME + the normalized project dir (the cache key) + the
  // state path. Deliberately NOT the resolved override file paths: a project
  // override created after startup must not turn a broken file into a
  // tolerated "first load".
  const sourceKey = [homedir(), projectDir, statePath()].join("|");
  const previous =
    entry.config !== null && sourceKey === entry.sourceKey ? entry.config : null;

  const failures: SourceFailure[] = [];
  const notices: ConfigNotice[] = [];
  let cfg: RouterConfig;
  try {
    cfg = buildConfig(projectDir, failures, notices);
  } catch (err) {
    // First load: unchanged behaviour — throw. Reload: keep the last good one.
    if (!previous) throw err;
    return keepLastValidConfig(
      entry,
      previous,
      fingerprint,
      `${configPath()}: ${(err as Error).message}`,
    );
  }

  if (previous) {
    // Sources that were already failing when `previous` was built are an
    // accepted state (e.g. a broken override at startup); only a source that
    // newly broke counts as a failed reload.
    const regressions = failures.filter((f) => !entry.tolerated.has(f.source));
    if (regressions.length > 0) {
      return keepLastValidConfig(
        entry,
        previous,
        fingerprint,
        regressions.map((f) => f.message).join("\n"),
      );
    }
  }

  entry.config = cfg;
  entry.fingerprint = fingerprint;
  entry.sourceKey = sourceKey;
  entry.tolerated = new Set(failures.map((f) => f.source));
  entry.dirty = false;
  entry.reloadError = null;
  entry.warnedFingerprint = null;
  entry.notices = notices;
  warnNoticesOnce(fingerprint, notices);
  return cfg;
}

/**
 * Reload failed: keep serving `previous` (same object reference), remember the
 * fingerprint so we do not retry on every message until a file changes (or
 * invalidateConfigCache() is called), record the reason, and warn once per
 * failed fingerprint. All state lives on the directory's own cache `entry`.
 */
function keepLastValidConfig(
  entry: ConfigCacheEntry,
  previous: RouterConfig,
  fingerprint: string,
  message: string,
): RouterConfig {
  entry.fingerprint = fingerprint;
  entry.dirty = false;
  entry.reloadError = message;
  if (entry.warnedFingerprint !== fingerprint) {
    entry.warnedFingerprint = fingerprint;
    console.warn(
      `[model-router] config reload failed — keeping last valid config: ${message}`,
    );
  }
  return previous;
}

/** Keys each `routing` block understands; anything else is ignored (and noticed). */
const ROUTING_KNOWN_KEYS: Readonly<Record<string, readonly string[]>> = {
  routing: [
    "engine",
    "profile",
    "margin",
    "minClassConfidence",
    "detection",
    "classifier",
    "roles",
    "outcomes",
    "sessionReuse",
    "advisor",
  ],
  detection: ["deterministic", "grader", "none"],
  classifier: ["backend", "model", "baseUrl", "apiKeyEnv", "timeoutMs", "samples", "maxStateChars", "presets"],
  preset: ["backend", "model"],
  outcomes: ["path", "halfLifeDays", "maxEffectiveSamples"],
  sessionReuse: ["maxContextFraction"],
  advisor: ["enabled", "noticeIntervalHours"],
};

/**
 * Paths of the keys inside a raw `routing` block that nothing reads
 * (`routing.margn`, `routing.classifier.bakend`, …). Validation ignores them, as
 * it does everywhere in this file; this makes the typo visible (QA-1.1-10).
 */
export function findUnknownRoutingKeys(routing: unknown): string[] {
  if (!isPlainObject(routing)) return [];
  const unknown: string[] = [];
  const check = (obj: Record<string, unknown>, known: readonly string[], path: string): void => {
    for (const key of Object.keys(obj)) {
      if (!known.includes(key)) unknown.push(`${path}.${key}`);
    }
  };
  check(routing, ROUTING_KNOWN_KEYS.routing!, "routing");
  for (const block of ["detection", "classifier", "outcomes", "sessionReuse", "advisor"] as const) {
    const value = routing[block];
    if (isPlainObject(value)) check(value, ROUTING_KNOWN_KEYS[block]!, `routing.${block}`);
  }
  const classifier = routing.classifier;
  const presets = isPlainObject(classifier) ? classifier.presets : undefined;
  if (isPlainObject(presets)) {
    for (const [name, entry] of Object.entries(presets)) {
      if (isPlainObject(entry)) check(entry, ROUTING_KNOWN_KEYS.preset!, `routing.classifier.presets.${name}`);
    }
  }
  return unknown;
}

/**
 * OpenCode's built-in primary and internal agents. None of them can be a
 * subagent candidate, so `routing.roles` naming one is useless (QA-1.1-18); it is
 * accepted (the host's agent set is not known at load) but noticed, and the
 * engine must skip it.
 */
export const ROUTING_RESERVED_AGENTS = ["build", "plan", "title", "summary", "compaction"] as const;

/**
 * Findings about a routing block that loaded fine but probably is not what the
 * author meant: unknown keys, `roles` naming reserved agents, per-preset
 * classifier overrides naming no preset. `rawRouting` is the merged block as
 * written (validation drops unknown keys from the snapshot); `cfg` is the
 * validated config.
 */
export function collectRoutingNotices(rawRouting: unknown, cfg: RouterConfig): string[] {
  const messages: string[] = [];
  const unknown = findUnknownRoutingKeys(rawRouting);
  if (unknown.length > 0) {
    messages.push(`ignoring unknown routing key${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }
  for (const [taskClass, agents] of Object.entries(cfg.routing?.roles ?? {})) {
    for (const agent of agents) {
      if (ROUTING_RESERVED_AGENTS.some((reserved) => reserved === agent)) {
        messages.push(
          `routing.roles.'${taskClass}' names '${agent}', an OpenCode primary/internal agent that cannot be a subagent; it will be skipped`,
        );
      }
    }
  }
  for (const name of Object.keys(cfg.routing?.classifier?.presets ?? {})) {
    if (resolvePresetName(cfg, name) === undefined) {
      messages.push(
        `routing.classifier.presets.'${name}' matches no preset (defined: ${Object.keys(cfg.presets).join(", ")}); the override is unused`,
      );
    }
  }
  return messages;
}
/**
 * `routing.roles` is replaced wholesale by the highest-priority layer that sets
 * it, not merged class by class (QA-1.1-7): the default is replaced as a whole
 * too, so a layer's `roles` is the complete list of what it wants, and a class
 * it leaves out cannot be re-enabled by a lower layer.
 */
function replaceRolesWholesale(merged: unknown, layers: readonly OverrideLayer[]): unknown {
  if (!isPlainObject(merged) || !isPlainObject(merged.routing)) return merged;
  for (let i = layers.length - 1; i >= 0; i--) {
    const routing = layers[i]!.data.routing;
    if (isPlainObject(routing) && Object.hasOwn(routing, "roles") && routing.roles !== undefined) {
      return { ...merged, routing: { ...merged.routing, roles: routing.roles } };
    }
  }
  return merged;
}

/**
 * Build a fresh config from tiers.json + override layers + persisted state.
 * Throws only when tiers.json itself is unreadable/invalid. Override and state
 * problems are warned about, skipped, and appended to `failures`.
 */
function buildConfig(
  dir: string,
  failures: SourceFailure[],
  notices: ConfigNotice[],
): RouterConfig {
  const base = JSON.parse(readFileSync(configPath(), "utf-8"));
  const layers = collectOverrideLayers(dir, failures, notices);

  // Bundled config must be valid on its own — throw otherwise (unchanged
  // behaviour). Override layers are then applied on top.
  let cfg = validateConfig(base);
  let rawUsed: unknown = base;

  if (layers.length > 0) {
    const merge = (ls: OverrideLayer[]): unknown =>
      replaceRolesWholesale(
        ls.reduce<unknown>((acc, l) => deepMerge(acc, l.data), base),
        ls,
      );

    try {
      const merged = merge(layers);
      cfg = validateConfig(merged);
      rawUsed = merged;
    } catch (err) {
      // A bad override must never brick startup, and one broken file must not
      // discard a good one. Fall back to the highest-priority layer that
      // validates on its own (so a broken personal/global file still lets a
      // shared project file apply), else the bundled defaults.
      console.warn(
        `[model-router] combined overrides are invalid (${(err as Error).message}); dropping conflicting layer(s)`,
      );
      const layerPaths = layers.map((l) => l.path).join(" + ");
      failures.push({
        source: layerPaths,
        message: `${layerPaths}: combined overrides are invalid — ${(err as Error).message}`,
      });
      for (let i = layers.length - 1; i >= 0; i--) {
        try {
          const single = merge([layers[i]!]);
          cfg = validateConfig(single);
          rawUsed = single;
          for (let j = 0; j < layers.length; j++) {
            if (j !== i) {
              console.warn(`[model-router] dropped override layer ${layers[j]!.path}`);
            }
          }
          break;
        } catch (singleErr) {
          console.warn(
            `[model-router] ignoring ${layers[i]!.path}: ${(singleErr as Error).message}`,
          );
          failures.push({
            source: layers[i]!.path,
            message: `${layers[i]!.path}: ${(singleErr as Error).message}`,
          });
          cfg = validateConfig(base);
          rawUsed = base;
        }
      }
    }
  }

  try {
    const stateKind = statKind(statePath());
    if (stateKind !== "missing") {
      // Present-but-uninspectable (EACCES, EIO, …) is a failure, not an absent
      // state file: reverting the persisted preset on a transient error would
      // be silent data loss.
      if (stateKind !== "present") throw new Error(`cannot read it — ${stateKind.message}`);
      const state = JSON.parse(
        readFileSync(statePath(), "utf-8"),
      ) as RouterState;
      if (state.activePreset) {
        const resolved = resolvePresetName(cfg, state.activePreset);
        if (resolved) {
          cfg.activePreset = resolved;
        }
      }
      if (state.activeMode && cfg.modes?.[state.activeMode]) {
        cfg.activeMode = state.activeMode;
      }
      if (state.enforcementMode) {
        cfg.enforcement = { ...(cfg.enforcement ?? {}), mode: state.enforcementMode };
      }
    }
  } catch (err) {
    // State read errors never block startup: keep tiers.json defaults. They are
    // recorded so a state file that breaks on a later reload is reported (and
    // the last valid config kept) rather than silently reverting the preset.
    failures.push({
      source: statePath(),
      message: `${statePath()}: ${(err as Error).message}`,
    });
  }

  applyTierDefaults(cfg);
  const rawRouting = isPlainObject(rawUsed) ? rawUsed.routing : undefined;
  for (const message of collectRoutingNotices(rawRouting, cfg)) notices.push({ message });
  return cfg;
}

// ---------------------------------------------------------------------------
// State persistence helpers
// ---------------------------------------------------------------------------

/** Read current persisted state (or empty object on failure). */
export function readState(): RouterState {
  try {
    if (existsSync(statePath())) {
      return JSON.parse(readFileSync(statePath(), "utf-8")) as RouterState;
    }
  } catch {
    // ignore
  }
  return {};
}

/** Write state to disk atomically (merges with existing keys). */
export function writeState(patch: Partial<RouterState>): void {
  const state = { ...readState(), ...patch };
  const p = statePath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8");
  renameSync(tmp, p);
}

// ---------------------------------------------------------------------------
// Enforcement helpers
// ---------------------------------------------------------------------------

/** The single place the delegation-depth default is applied; null disables it. */
export function resolveDepthLimit(cfg: RouterConfig): number | null {
  const depth = cfg.enforcement?.maxDelegationDepth;
  return depth === undefined ? 1 : depth;
}

/** The single place effort-bump defaults are applied, without mutating config. */
export function resolveEffortBump(cfg: RouterConfig): { enabled: boolean; max: EffortLevel } {
  const escalate = cfg.enforcement?.escalate;
  return {
    enabled: escalate?.effortBump ?? true,
    max: escalate?.effortBumpMax ?? "xhigh",
  };
}

/** Returns the effective enforcement mode. Missing enforcement ⇒ mode:"advisory". */
export function normalizeEnforcement(
  e: EnforcementConfig | undefined,
): { mode: "off" | "advisory" | "enforced" } {
  return { mode: e?.mode ?? "advisory" };
}

/** Fully defaulted verification budget (§1.4). */
export interface VerifyBudget {
  testScope: "affected" | "full";
  maxWorkers: number;
  lowPriority: boolean;
  maxConcurrentVerifications: number;
  defaultVerify: "deferred" | "required";
  captureWaitMs: number;
  background: boolean;
  pendingTtlMs: number;
  slotWaitMs: number;
  batchWindowMs: number;
  failureRecheck: boolean;
  recheckTimeoutMs: number;
  baselineTimeoutMs: number;
  gateBudgetMs: number;
}

export interface ResolveVerifyBudgetOptions {
  /** Core count; defaults to `os.availableParallelism()`. Injected by tests. */
  cores?: number;
}

let warnedTestBaselineDeprecated = false;

/** Test-only: re-arm the once-per-process `testBaseline` deprecation warning. */
export function resetVerifyBudgetWarnings(): void {
  warnedTestBaselineDeprecated = false;
}

/**
 * Logs the once-per-process deprecation warning for `enforcement.verify.testBaseline`
 * (any value) through the plugin logger. Call once after every `loadConfig()`.
 * Kept apart from `resolveVerifyBudget` so that function stays pure.
 */
export function warnDeprecatedVerifyKeys(
  cfg: RouterConfig | undefined,
  logger: PluginLogger,
): void {
  const v = cfg?.enforcement?.verify;
  if (
    warnedTestBaselineDeprecated ||
    !isPlainObject(v) ||
    !Object.prototype.hasOwnProperty.call(v, "testBaseline") ||
    v.testBaseline === undefined
  ) {
    return;
  }
  warnedTestBaselineDeprecated = true;
  logger.warn(
    "enforcement.verify.testBaseline is deprecated; use enforcement.verify.failureRecheck",
    { key: "testBaseline" },
  );
}

/**
 * The single place verification-budget defaults are applied. Pure and
 * synchronous: no module state, no logging (see `warnDeprecatedVerifyKeys`).
 * Reads own properties only, so a value inherited through a prototype is never
 * applied. A non-finite or `< 1` core count (including `Infinity`) counts as 1.
 */
export function resolveVerifyBudget(
  cfg: RouterConfig | undefined,
  opts: ResolveVerifyBudgetOptions = {},
): VerifyBudget {
  const raw = cfg?.enforcement?.verify;
  const v: Record<string, unknown> = isPlainObject(raw) ? raw : {};
  const own = <T>(key: string): T | undefined =>
    Object.prototype.hasOwnProperty.call(v, key) && v[key] !== undefined
      ? (v[key] as T)
      : undefined;

  const testBaseline = own<boolean>("testBaseline");

  const failureRecheck =
    own<boolean>("failureRecheck") ?? (testBaseline === false ? false : true);

  const cores = opts.cores ?? availableParallelism();
  const coreCount = Number.isFinite(cores) && cores >= 1 ? Math.floor(cores) : 1;

  // QA-1.6-8: waiting for the reference capture longer than the capture itself
  // may take is pointless, so the wait never exceeds baselineTimeoutMs.
  const baselineTimeoutMs = own<number>("baselineTimeoutMs") ?? 15_000;
  const captureWaitMs = Math.min(own<number>("captureWaitMs") ?? 5000, baselineTimeoutMs);

  return {
    testScope: own<"affected" | "full">("testScope") ?? "affected",
    maxWorkers: own<number>("maxWorkers") ?? 2,
    lowPriority: own<boolean>("lowPriority") ?? true,
    maxConcurrentVerifications:
      own<number>("maxConcurrentVerifications") ?? Math.max(1, Math.floor(coreCount / 8)),
    defaultVerify: own<"deferred" | "required">("defaultVerify") ?? "deferred",
    captureWaitMs,
    background: own<boolean>("background") ?? false,
    pendingTtlMs: own<number>("pendingTtlMs") ?? 3_600_000,
    slotWaitMs: own<number>("slotWaitMs") ?? 60_000,
    batchWindowMs: own<number>("batchWindowMs") ?? 2000,
    failureRecheck,
    recheckTimeoutMs: own<number>("recheckTimeoutMs") ?? 60_000,
    baselineTimeoutMs,
    gateBudgetMs: own<number>("gateBudgetMs") ?? 90_000,
  };
}

// ---------------------------------------------------------------------------
// Cost-aware routing helpers (#74)
// ---------------------------------------------------------------------------

/** The single log line of D1; also the exact text tests pin. */
export const ROUTING_ENGINE_IGNORED_ON_V1 = "routing.engine ignored on OpenCode v1";

/**
 * D12: the roles applied on OpenCode v2 when `routing.roles` is not set. On v1
 * the default is `{}` (D1). Setting `roles: {}` disables native candidates.
 */
export const DEFAULT_V2_ROLES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  search: Object.freeze(["explore"]),
  implement: Object.freeze(["general"]),
  debug: Object.freeze(["general"]),
  review: Object.freeze(["general"]),
});

/**
 * Every default of the `routing` block except `roles`, whose default depends on
 * the host. `docs/CONFIG_REFERENCE.md` documents exactly these values and a
 * test keeps the two in step.
 */
export const ROUTING_DEFAULTS = Object.freeze({
  engine: "static" as RoutingEngine,
  profile: "balanced" as RoutingProfile,
  margin: 0.2,
  minClassConfidence: 0.7,
  detection: Object.freeze({ deterministic: 0.95, grader: 0.7, none: 0.3 }),
  classifier: Object.freeze({
    backend: "rules" as ClassifierBackend,
    model: null,
    baseUrl: null,
    apiKeyEnv: null,
    timeoutMs: 1500,
    samples: 1 as 1 | 3,
    maxStateChars: 2000,
  }),
  outcomes: Object.freeze({ path: null, halfLifeDays: 14, maxEffectiveSamples: 50 }),
  sessionReuse: Object.freeze({ maxContextFraction: 0.6 }),
  advisor: Object.freeze({ enabled: true, noticeIntervalHours: 24 }),
});

export interface ResolvedClassifier {
  readonly backend: ClassifierBackend;
  readonly model: string | null;
  readonly baseUrl: string | null;
  readonly apiKeyEnv: string | null;
  readonly timeoutMs: number;
  readonly samples: 1 | 3;
  readonly maxStateChars: number;
  readonly presets: Readonly<Record<string, Readonly<ClassifierPresetOverride>>>;
}

/** What {@link resolveRouting} applied on top of the file, so `/router` can show it. */
export interface RoutingApplied {
  readonly host: RouterHost;
  /** `routing.engine` as written (or the default), before the v1 coercion. */
  readonly requestedEngine: RoutingEngine;
  /** True when the engine was forced to `static` because the host is v1. */
  readonly engineCoerced: boolean;
  /** `configured`: `routing.roles` was set; `default`: the D12 v2 default; `none`: v1 without roles. */
  readonly rolesSource: "configured" | "default" | "none";
}

/** A fully populated, deeply frozen view of `routing` for one host. */
export interface ResolvedRouting {
  /** The effective engine: `static` on v1 whatever the file says (D1). */
  readonly engine: RoutingEngine;
  readonly profile: RoutingProfile;
  readonly margin: number;
  readonly minClassConfidence: number;
  readonly detection: Readonly<Required<DetectionConfig>>;
  readonly classifier: ResolvedClassifier;
  /** Class → ordered, de-duplicated agent ids. */
  readonly roles: Readonly<Record<string, readonly string[]>>;
  readonly outcomes: Readonly<{ path: string | null; halfLifeDays: number; maxEffectiveSamples: number }>;
  readonly sessionReuse: Readonly<Required<SessionReuseConfig>>;
  readonly advisor: Readonly<Required<AdvisorConfig>>;
  readonly applied: RoutingApplied;
}

let warnedEngineIgnoredOnV1 = false;

/** Test-only: re-arm the once-per-process "engine ignored on v1" notice. */
export function resetRoutingWarnings(): void {
  warnedEngineIgnoredOnV1 = false;
  warnedNotices.clear();
}

/** Roles as fresh, de-duplicated, frozen arrays; never aliases the config. */
function freezeRoles(
  roles: Readonly<Record<string, readonly string[]>>,
): Readonly<Record<string, readonly string[]>> {
  const out: Record<string, readonly string[]> = {};
  for (const [taskClass, agents] of Object.entries(roles)) {
    out[taskClass] = Object.freeze([...new Set(agents)]);
  }
  return Object.freeze(out);
}

/**
 * The single place the `routing` defaults are applied. Pure apart from the
 * once-per-process notice below, and never mutates `cfg`.
 *
 * - `host: "v2"` applies the D12 default for `roles` when the key is absent.
 * - `host: "v1"` forces `engine` to `static` (D1) and defaults `roles` to `{}`;
 *   an explicit `routing.roles` is kept (the text-only v1 opt-in).
 *
 * The coercion is reported once per process through `logger` (its console
 * fallback adds the `[model-router]` prefix) or, without one, `console.warn`.
 */
export function resolveRouting(
  cfg: RouterConfig | undefined,
  host: RouterHost,
  logger?: Pick<PluginLogger, "warn">,
): ResolvedRouting {
  const r: RoutingConfig = cfg?.routing ?? {};
  const d = ROUTING_DEFAULTS;
  const requestedEngine = r.engine ?? d.engine;
  const engineCoerced = host === "v1" && requestedEngine !== "static";
  if (engineCoerced && !warnedEngineIgnoredOnV1) {
    warnedEngineIgnoredOnV1 = true;
    if (logger) logger.warn(ROUTING_ENGINE_IGNORED_ON_V1);
    else console.warn(`[model-router] ${ROUTING_ENGINE_IGNORED_ON_V1}`);
  }

  const c: ClassifierConfig = r.classifier ?? {};
  const presets: Record<string, Readonly<ClassifierPresetOverride>> = {};
  for (const [name, override] of Object.entries(c.presets ?? {})) {
    presets[name] = Object.freeze({ ...override });
  }

  const rolesSource: RoutingApplied["rolesSource"] =
    r.roles !== undefined ? "configured" : host === "v2" ? "default" : "none";
  const roles = freezeRoles(r.roles ?? (host === "v2" ? DEFAULT_V2_ROLES : {}));

  return Object.freeze({
    engine: host === "v1" ? "static" : requestedEngine,
    profile: r.profile ?? d.profile,
    margin: r.margin ?? d.margin,
    minClassConfidence: r.minClassConfidence ?? d.minClassConfidence,
    detection: Object.freeze({
      deterministic: r.detection?.deterministic ?? d.detection.deterministic,
      grader: r.detection?.grader ?? d.detection.grader,
      none: r.detection?.none ?? d.detection.none,
    }),
    classifier: Object.freeze({
      backend: c.backend ?? d.classifier.backend,
      model: c.model ?? d.classifier.model,
      baseUrl: c.baseUrl ?? d.classifier.baseUrl,
      apiKeyEnv: c.apiKeyEnv ?? d.classifier.apiKeyEnv,
      timeoutMs: c.timeoutMs ?? d.classifier.timeoutMs,
      samples: c.samples ?? d.classifier.samples,
      maxStateChars: c.maxStateChars ?? d.classifier.maxStateChars,
      presets: Object.freeze(presets),
    }),
    roles,
    outcomes: Object.freeze({
      path: r.outcomes?.path ?? d.outcomes.path,
      halfLifeDays: r.outcomes?.halfLifeDays ?? d.outcomes.halfLifeDays,
      maxEffectiveSamples: r.outcomes?.maxEffectiveSamples ?? d.outcomes.maxEffectiveSamples,
    }),
    sessionReuse: Object.freeze({
      maxContextFraction: r.sessionReuse?.maxContextFraction ?? d.sessionReuse.maxContextFraction,
    }),
    advisor: Object.freeze({
      enabled: r.advisor?.enabled ?? d.advisor.enabled,
      noticeIntervalHours: r.advisor?.noticeIntervalHours ?? d.advisor.noticeIntervalHours,
    }),
    applied: Object.freeze({ host, requestedEngine, engineCoerced, rolesSource }),
  });
}

/**
 * The key of `presets` that names `presetName`: an exact match, else a
 * case-insensitive, trimmed one, like {@link resolvePresetName} (what `/preset`
 * uses), so `Anthropic` and `anthropic` are the same preset (QA-1.1-14).
 * Own keys only.
 */
function findPresetOverrideKey(
  presets: Readonly<Record<string, unknown>>,
  presetName: string,
): string | undefined {
  if (Object.hasOwn(presets, presetName)) return presetName;
  const normalized = presetName.trim().toLowerCase();
  if (normalized === "") return undefined;
  return Object.keys(presets).find((key) => key.trim().toLowerCase() === normalized);
}

/**
 * The classifier settings that apply while `presetName` is the active preset:
 * the top-level block with that preset's `backend` / `model` override on top.
 * The preset name is matched like `/preset` matches it (exact, then
 * case-insensitive); a `presets` key that matches no preset is noticed at load.
 */
export function resolveClassifierForPreset(
  classifier: ResolvedClassifier,
  presetName: string,
): ResolvedClassifier {
  const key = findPresetOverrideKey(classifier.presets, presetName);
  const override = key === undefined ? undefined : classifier.presets[key];
  if (override === undefined) return classifier;
  return Object.freeze({
    ...classifier,
    backend: override.backend ?? classifier.backend,
    model: override.model !== undefined ? override.model : classifier.model,
  });
}

/**
 * `enforcement.escalate.variantSteps` for one host (A15, QA-1.1-4).
 *
 * - On v1 it is always `none`: variant steps do not exist there (D1), so even an
 *   explicit value is ignored.
 * - On v2 an explicit value always wins. Absent, the default is `auto` when the
 *   config has a `routing` block and `none` when it has not, so that a config
 *   without `routing` keeps today's ladder byte for byte (D2).
 */
export function resolveVariantSteps(cfg: RouterConfig | undefined, host: RouterHost): VariantStepsMode {
  if (host === "v1") return "none";
  const explicit = cfg?.enforcement?.escalate?.variantSteps;
  if (explicit !== undefined) return explicit;
  return cfg?.routing !== undefined ? "auto" : "none";
}

/** One rung of a tier's ladder, fully resolved. */
export interface ResolvedCandidate {
  readonly model: string;
  /** Absent = the model's default variant. */
  readonly variant?: string;
  readonly costRatio: number;
}

const NO_CANDIDATES: readonly ResolvedCandidate[] = Object.freeze([]);

/**
 * The ladder of rungs for `tierName` in the active preset (D10, D12).
 *
 * Without `candidates` (or with an empty list) it is exactly one rung: the
 * tier's own `(model, variant, costRatio)`. With `candidates` it is those
 * entries, in order, each completed from the tier: `model` and `costRatio`
 * are inherited when omitted, `variant` is not. An unknown tier yields an
 * empty ladder. Never throws.
 */
export function resolveCandidates(tierName: string, cfg: RouterConfig): readonly ResolvedCandidate[] {
  const presetName = resolvePresetName(cfg, cfg.activePreset);
  const preset = presetName !== undefined && Object.hasOwn(cfg.presets, presetName) ? cfg.presets[presetName] : undefined;
  const tier = preset !== undefined && Object.hasOwn(preset, tierName) ? preset[tierName] : undefined;
  if (tier === undefined) return NO_CANDIDATES;

  const tierCostRatio = tier.costRatio ?? tierDefaultsFor(tierName).costRatio;
  const rung = (model: string, variant: string | undefined, costRatio: number): ResolvedCandidate =>
    Object.freeze(variant === undefined ? { model, costRatio } : { model, variant, costRatio });

  if (!hasExplicitCandidates(tier)) {
    return Object.freeze([rung(tier.model, tier.variant, tierCostRatio)]);
  }
  return Object.freeze(
    (tier.candidates ?? []).map((c) => rung(c.model ?? tier.model, c.variant, c.costRatio ?? tierCostRatio)),
  );
}
/**
 * The extra lines of the bare `/router` status view: the marker
 * `router: engine=<mode> build=<version>+<sha7>` (the engine is the one
 * *applied* on `host`, so always `static` on v1) followed by one
 * `router: config notice: …` line per notice of the config last loaded for `dir`
 * (QA-1.1-10). Passing `logger` makes the once-per-process v1 notice go through
 * the plugin logger.
 */
export function routerStatusLines(
  cfg: RouterConfig,
  host: RouterHost,
  logger?: Pick<PluginLogger, "warn">,
  dir?: string,
): string[] {
  return [
    formatRouterLine(resolveRouting(cfg, host, logger).engine),
    ...getConfigNotices(dir).map((notice) => `router: config notice: ${notice.message}`),
  ];
}