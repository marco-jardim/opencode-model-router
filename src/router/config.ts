import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

export interface TierConfig {
  model: string;
  variant?: string;
  thinking?: ThinkingConfig;
  reasoning?: ReasoningConfig;
  costRatio?: number;
  color?: string;
  description: string;
  steps?: number;
  prompt?: string;
  whenToUse: string[];
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
  guard?: { readDraftCap?: number; sameOpRetryCap?: number; blockSelfScript?: boolean; deliverableFirst?: boolean };
  verify?: { require?: "never" | "whenDoDPresent" | "always"; requireExplicitDoD?: boolean; preferDeterministic?: boolean; graderPolicy?: "atLeastProducerTier"; graderTemperature?: number; minGraderTier?: string };
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
  /** Read-only tool-call caps per tier, enforced at runtime via tool.execute.after banner injection. */
  tierCaps?: Record<string, number>;
  enforcement?: EnforcementConfig;
}

export interface RouterState {
  activePreset?: string;
  activeMode?: string;
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

export function validateConfig(raw: unknown): RouterConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("tiers.json: expected a JSON object at root");
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.activePreset !== "string" || !obj.activePreset) {
    throw new Error("tiers.json: 'activePreset' must be a non-empty string");
  }
  if (
    typeof obj.presets !== "object" ||
    obj.presets === null ||
    Array.isArray(obj.presets)
  ) {
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
      if (typeof t.model !== "string" || !t.model) {
        throw new Error(
          `tiers.json: '${presetName}.${tierName}.model' must be a non-empty string`,
        );
      }
      if (typeof t.description !== "string") {
        throw new Error(
          `tiers.json: '${presetName}.${tierName}.description' must be a string`,
        );
      }
      if (!Array.isArray(t.whenToUse)) {
        throw new Error(
          `tiers.json: '${presetName}.${tierName}.whenToUse' must be an array`,
        );
      }
    }
  }

  if (!Array.isArray(obj.rules)) {
    throw new Error("tiers.json: 'rules' must be an array of strings");
  }
  if (typeof obj.defaultTier !== "string") {
    throw new Error("tiers.json: 'defaultTier' must be a string");
  }

  // Validate modes if present
  if (obj.modes !== undefined) {
    if (
      typeof obj.modes !== "object" ||
      obj.modes === null ||
      Array.isArray(obj.modes)
    ) {
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

  // Validate tierCaps if present
  if (obj.tierCaps !== undefined) {
    if (
      typeof obj.tierCaps !== "object" ||
      obj.tierCaps === null ||
      Array.isArray(obj.tierCaps)
    ) {
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

  // Validate tierPrompts if present
  if (obj.tierPrompts !== undefined) {
    if (
      typeof obj.tierPrompts !== "object" ||
      obj.tierPrompts === null ||
      Array.isArray(obj.tierPrompts)
    ) {
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

  // Validate taskPatterns if present
  if (obj.taskPatterns !== undefined) {
    if (
      typeof obj.taskPatterns !== "object" ||
      obj.taskPatterns === null ||
      Array.isArray(obj.taskPatterns)
    ) {
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

  // Validate enforcement if present (optional — absent means no enforcement)
  if (obj.enforcement !== undefined) {
    if (
      typeof obj.enforcement !== "object" ||
      obj.enforcement === null ||
      Array.isArray(obj.enforcement)
    ) {
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
  }

  return raw as RouterConfig;
}

export function loadConfig(): RouterConfig {
  if (_cachedConfig && !_configDirty) {
    return _cachedConfig;
  }

  const raw = JSON.parse(readFileSync(configPath(), "utf-8"));
  const cfg = validateConfig(raw);

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
    }
  } catch {
    // Ignore state read errors and keep tiers.json defaults
  }

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

/** Write state to disk (merges with existing keys). */
export function writeState(patch: Partial<RouterState>): void {
  const state = { ...readState(), ...patch };
  const p = statePath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Enforcement helpers
// ---------------------------------------------------------------------------

/** Returns the effective enforcement mode. Missing enforcement ⇒ mode:"off". */
export function normalizeEnforcement(
  e: EnforcementConfig | undefined,
): { mode: "off" | "advisory" | "enforced" } {
  return { mode: e?.mode ?? "off" };
}
