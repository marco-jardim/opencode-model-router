import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "./jsonc";

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
 * OpenAI's `reasoning_effort` stops at `high`, so the registration path
 * downgrades those two with a warning (see `src/router/agent-options.ts`).
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
  envGate?: string;
  perTier?: Record<string, "off" | "advisory" | "enforced">;
  guard?: { readDraftCap?: number; sameOpRetryCap?: number; blockSelfScript?: boolean; deliverableFirst?: boolean; budget?: number; blockScriptWrites?: boolean };
  verify?: { require?: "never" | "whenDoDPresent" | "always"; requireExplicitDoD?: boolean; preferDeterministic?: boolean; graderPolicy?: "atLeastProducerTier"; graderTemperature?: number; minGraderTier?: string | null;
    /** Ceiling for one producer `session.prompt` turn, in ms. Default 600000. */
    delegateTimeoutMs?: number;
    /** Ceiling for one grader `session.prompt` turn, in ms. Default 60000. */
    graderTimeoutMs?: number;
    /** Ceiling for the whole acceptance gate, in ms. Default 90000. */
    gateBudgetMs?: number };
  escalate?: { floorTier?: string | null; ladder?: string[]; maxAttemptsPerTier?: number; maxTotalAttempts?: number; costCeiling?: { base?: string; multiple?: number } };
  proportional?: { trivialBypass?: boolean; trivialClassifier?: string };
}

export interface RouterConfig {
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
}

export interface RouterState {
  activePreset?: string;
  activeMode?: string;
  enforcementMode?: "off" | "advisory" | "enforced";
}

// ---------------------------------------------------------------------------
// Config loader with caching
// ---------------------------------------------------------------------------

let _cachedConfig: RouterConfig | null = null;
let _configDirty = true;

/** Mark config cache as stale so it is re-read on next access. */
export function invalidateConfigCache(): void {
  _configDirty = true;
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
 * (`.opencode/opencode-model-router.overrides.jsonc` in the current working
 * directory). This is the path to *create* the file at; the actual lookup walks
 * upward — see {@link findProjectOverride}. Used for display when no project
 * file is found.
 *
 * The project file is deep-merged *after* (and therefore wins over) the global
 * overrides file, so a team can commit a shared file that unifies routing for
 * the project on top of each member's personal global file.
 */
export function localOverridePath(): string {
  return join(process.cwd(), ".opencode", OVERRIDE_FILENAME);
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

/**
 * Locate the project-local overrides file by walking upward from the current
 * working directory, so the project config is found even when opencode is
 * launched from a subdirectory.
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
 */
export function findProjectOverride(): string | undefined {
  // Both sides of the $HOME comparison below have to be resolved the same way.
  // process.cwd() returns a realpath, while homedir() returns $HOME verbatim, so
  // on any system where $HOME contains a symlinked component (macOS temp dirs,
  // containers, some NFS homes) a raw string compare never matches and the home
  // boundary silently stops applying. Fail soft: an unresolvable path is used
  // as-is, which is no worse than not comparing at all.
  const resolve = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };

  let dir = resolve(process.cwd());
  const home = resolve(homedir());
  let depth = 0;

  for (;;) {
    const hasMarker = REPO_MARKERS.some((m) => existsSync(join(dir, m)));

    // $HOME is not a project directory. Only look inside it when it is itself a
    // repo root (a dotfiles repo), otherwise `~/.opencode/…` would be picked up
    // by any unrelated scratch directory below it.
    if (dir === home && !hasMarker) return undefined;

    const candidate = join(dir, ".opencode", OVERRIDE_FILENAME);
    if (existsSync(candidate)) return candidate;

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

function validateEnforcement(obj: Record<string, unknown>): void {
  // Validate enforcement if present (optional — absent means no enforcement)
  if (obj.enforcement !== undefined) {
    if (!isPlainObject(obj.enforcement)) {
      throw new Error("tiers.json: enforcement must be an object");
    }
    const enforcement = obj.enforcement as Record<string, unknown>;
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
    if (
      enforcement.verify !== undefined &&
      typeof enforcement.verify === "object" &&
      enforcement.verify !== null
    ) {
      const verify = enforcement.verify as Record<string, unknown>;
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
      if (verify.graderTemperature !== undefined) {
        if (
          typeof verify.graderTemperature !== "number" ||
          !Number.isFinite(verify.graderTemperature) ||
          verify.graderTemperature < 0
        ) {
          throw new Error(
            "tiers.json: enforcement.verify.graderTemperature must be a number >= 0",
          );
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
      ] as const) {
        const value = verify[key];
        if (value !== undefined) {
          if (!Number.isInteger(value) || (value as number) < 1) {
            throw new Error(
              `tiers.json: enforcement.verify.${key} must be an integer >= 1 (milliseconds)`,
            );
          }
        }
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
    if (
      enforcement.escalate !== undefined &&
      typeof enforcement.escalate === "object" &&
      enforcement.escalate !== null
    ) {
      const escalate = enforcement.escalate as Record<string, unknown>;
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
  }
}

/**
 * Validate a raw parsed config. Strict and throwing by design: the bundled
 * tiers.json must be valid on its own, and loadConfig turns a throw from an
 * override layer into a warning plus a fallback rather than a crash.
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
  validateEnforcement(obj);

  return raw as RouterConfig;
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
function readOverridesAt(op: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    if (!existsSync(op)) return undefined;
    text = readFileSync(op, "utf-8");
  } catch (err) {
    // The file is there but unreadable (permissions, a dangling symlink, a
    // race with a delete). Every other failure below says so; staying silent
    // here makes an unreadable override look exactly like an absent one.
    console.warn(
      `[model-router] ignoring ${op}: cannot read it — ${(err as Error).message}`,
    );
    return undefined;
  }

  try {
    const parsed = parseJsonc(text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.warn(
        `[model-router] ignoring ${op}: expected a JSON object at root`,
      );
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    console.warn(
      `[model-router] ignoring ${op}: invalid JSONC — ${(err as Error).message}`,
    );
    return undefined;
  }
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

function collectOverrideLayers(): OverrideLayer[] {
  const layers: OverrideLayer[] = [];
  // Lowest priority first: global, then project-local (found by upward search).
  const paths = [overridePath(), findProjectOverride()];
  for (const p of paths) {
    if (!p) continue;
    const data = readOverridesAt(p);
    if (data) layers.push({ path: p, data });
  }
  return layers;
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

/**
 * Fill in `costRatio`/`steps` for any tier that omits them, by tier name. Runs
 * after merge so override-defined presets behave well without restating the
 * conventional values; the effective numbers then show up in `/tiers` and the
 * injected protocol. Bundled presets already set both, so this is a no-op there.
 */
function applyTierDefaults(cfg: RouterConfig): void {
  for (const preset of Object.values(cfg.presets)) {
    for (const [tierName, tier] of Object.entries(preset)) {
      const d = TIER_DEFAULTS[tierName] ?? FALLBACK_TIER_DEFAULTS;
      if (tier.costRatio === undefined) tier.costRatio = d.costRatio;
      if (tier.steps === undefined) tier.steps = d.steps;
    }
  }
}

export function loadConfig(): RouterConfig {
  if (_cachedConfig && !_configDirty) {
    return _cachedConfig;
  }

  const base = JSON.parse(readFileSync(configPath(), "utf-8"));
  const layers = collectOverrideLayers();

  // Bundled config must be valid on its own — throw otherwise (unchanged
  // behaviour). Override layers are then applied on top.
  let cfg = validateConfig(base);

  if (layers.length > 0) {
    const merge = (ls: OverrideLayer[]): unknown =>
      ls.reduce<unknown>((acc, l) => deepMerge(acc, l.data), base);

    try {
      cfg = validateConfig(merge(layers));
    } catch (err) {
      // A bad override must never brick startup, and one broken file must not
      // discard a good one. Fall back to the highest-priority layer that
      // validates on its own (so a broken personal/global file still lets a
      // shared project file apply), else the bundled defaults.
      console.warn(
        `[model-router] combined overrides are invalid (${(err as Error).message}); dropping conflicting layer(s)`,
      );
      for (let i = layers.length - 1; i >= 0; i--) {
        try {
          cfg = validateConfig(merge([layers[i]!]));
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
          cfg = validateConfig(base);
        }
      }
    }
  }

  try {
    if (existsSync(statePath())) {
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
  } catch {
    // Ignore state read errors and keep tiers.json defaults
  }

  applyTierDefaults(cfg);

  _cachedConfig = cfg;
  _configDirty = false;
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

/** Returns the effective enforcement mode. Missing enforcement ⇒ mode:"advisory". */
export function normalizeEnforcement(
  e: EnforcementConfig | undefined,
): { mode: "off" | "advisory" | "enforced" } {
  return { mode: e?.mode ?? "advisory" };
}
