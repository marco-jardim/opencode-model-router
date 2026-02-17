import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ThinkingConfig {
  budgetTokens?: number;
}

interface ReasoningConfig {
  effort?: "low" | "medium" | "high";
  summary?: "auto" | "always" | "never";
}

interface TierConfig {
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

type Preset = Record<string, TierConfig>;

interface FallbackConfig {
  global?: Record<string, string[]>;
  presets?: Record<string, Record<string, string[]>>;
}

interface ModeConfig {
  defaultTier: string;
  description: string;
  overrideRules?: string[];
}

interface RouterConfig {
  activePreset: string;
  activeMode?: string;
  presets: Record<string, Preset>;
  rules: string[];
  defaultTier: string;
  fallback?: FallbackConfig;
  taskPatterns?: Record<string, string[]>;
  modes?: Record<string, ModeConfig>;
}

interface RouterState {
  activePreset?: string;
  activeMode?: string;
}

// ---------------------------------------------------------------------------
// Config loader with caching
// ---------------------------------------------------------------------------

let _cachedConfig: RouterConfig | null = null;
let _configDirty = true;

/** Mark config cache as stale so it is re-read on next access. */
function invalidateConfigCache(): void {
  _configDirty = true;
}

function getPluginRoot(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  return join(__dirname, ".."); // src/ -> plugin root
}

function configPath(): string {
  return join(getPluginRoot(), "tiers.json");
}

function statePath(): string {
  return join(homedir(), ".config", "opencode", "opencode-model-router.state.json");
}

function resolvePresetName(cfg: RouterConfig, requestedPreset: string): string | undefined {
  if (cfg.presets[requestedPreset]) {
    return requestedPreset;
  }

  const normalized = requestedPreset.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  return Object.keys(cfg.presets).find((name) => name.toLowerCase() === normalized);
}

function validateConfig(raw: unknown): RouterConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("tiers.json: expected a JSON object at root");
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.activePreset !== "string" || !obj.activePreset) {
    throw new Error("tiers.json: 'activePreset' must be a non-empty string");
  }
  if (typeof obj.presets !== "object" || obj.presets === null || Array.isArray(obj.presets)) {
    throw new Error("tiers.json: 'presets' must be a non-null object");
  }

  const presets = obj.presets as Record<string, unknown>;
  for (const [presetName, preset] of Object.entries(presets)) {
    if (typeof preset !== "object" || preset === null || Array.isArray(preset)) {
      throw new Error(`tiers.json: preset '${presetName}' must be an object`);
    }
    const tiers = preset as Record<string, unknown>;
    for (const [tierName, tier] of Object.entries(tiers)) {
      if (typeof tier !== "object" || tier === null) {
        throw new Error(`tiers.json: tier '${presetName}.${tierName}' must be an object`);
      }
      const t = tier as Record<string, unknown>;
      if (typeof t.model !== "string" || !t.model) {
        throw new Error(`tiers.json: '${presetName}.${tierName}.model' must be a non-empty string`);
      }
      if (typeof t.description !== "string") {
        throw new Error(`tiers.json: '${presetName}.${tierName}.description' must be a string`);
      }
      if (!Array.isArray(t.whenToUse)) {
        throw new Error(`tiers.json: '${presetName}.${tierName}.whenToUse' must be an array`);
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
    if (typeof obj.modes !== "object" || obj.modes === null || Array.isArray(obj.modes)) {
      throw new Error("tiers.json: 'modes' must be an object");
    }
    const modes = obj.modes as Record<string, unknown>;
    for (const [modeName, mode] of Object.entries(modes)) {
      if (typeof mode !== "object" || mode === null) {
        throw new Error(`tiers.json: mode '${modeName}' must be an object`);
      }
      const m = mode as Record<string, unknown>;
      if (typeof m.defaultTier !== "string") {
        throw new Error(`tiers.json: mode '${modeName}.defaultTier' must be a string`);
      }
      if (typeof m.description !== "string") {
        throw new Error(`tiers.json: mode '${modeName}.description' must be a string`);
      }
    }
  }

  // Validate taskPatterns if present
  if (obj.taskPatterns !== undefined) {
    if (typeof obj.taskPatterns !== "object" || obj.taskPatterns === null || Array.isArray(obj.taskPatterns)) {
      throw new Error("tiers.json: 'taskPatterns' must be an object");
    }
    const tp = obj.taskPatterns as Record<string, unknown>;
    for (const [tierName, patterns] of Object.entries(tp)) {
      if (!Array.isArray(patterns)) {
        throw new Error(`tiers.json: taskPatterns.'${tierName}' must be an array of strings`);
      }
    }
  }

  return raw as RouterConfig;
}

function loadConfig(): RouterConfig {
  if (_cachedConfig && !_configDirty) {
    return _cachedConfig;
  }

  const raw = JSON.parse(readFileSync(configPath(), "utf-8"));
  const cfg = validateConfig(raw);

  try {
    if (existsSync(statePath())) {
      const state = JSON.parse(readFileSync(statePath(), "utf-8")) as RouterState;
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
function readState(): RouterState {
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
function writeState(patch: Partial<RouterState>): void {
  const state = { ...readState(), ...patch };
  const p = statePath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

function saveActivePreset(presetName: string): void {
  const cfg = loadConfig();
  const resolved = resolvePresetName(cfg, presetName);
  if (!resolved) {
    return;
  }

  cfg.activePreset = resolved;

  // Persist user-selected preset to state file only — never mutate tiers.json
  writeState({ activePreset: resolved });

  // Invalidate cache so next read picks up the new active preset
  invalidateConfigCache();
}

function saveActiveMode(modeName: string): void {
  const cfg = loadConfig();
  if (!cfg.modes?.[modeName]) {
    return;
  }

  cfg.activeMode = modeName;
  writeState({ activeMode: modeName });
  invalidateConfigCache();
}

function getActiveTiers(cfg: RouterConfig): Preset {
  return cfg.presets[cfg.activePreset] ?? Object.values(cfg.presets)[0]!;
}

// ---------------------------------------------------------------------------
// Build agent options from tier config
// ---------------------------------------------------------------------------

function buildAgentOptions(tier: TierConfig): Record<string, unknown> {
  const opts: Record<string, unknown> = {};

  // Anthropic thinking config
  if (tier.thinking) {
    if (tier.thinking.budgetTokens) {
      opts.budget_tokens = tier.thinking.budgetTokens;
    }
  }

  // OpenAI reasoning config
  if (tier.reasoning) {
    if (tier.reasoning.effort) {
      opts.reasoning_effort = tier.reasoning.effort;
    }
    if (tier.reasoning.summary) {
      opts.reasoning_summary = tier.reasoning.summary;
    }
  }

  return Object.keys(opts).length > 0 ? opts : {};
}

// ---------------------------------------------------------------------------
// Mode helpers
// ---------------------------------------------------------------------------

function getActiveMode(cfg: RouterConfig): ModeConfig | undefined {
  if (!cfg.modes || !cfg.activeMode) return undefined;
  return cfg.modes[cfg.activeMode];
}

// ---------------------------------------------------------------------------
// Fallback instructions builder
// ---------------------------------------------------------------------------

function buildFallbackInstructions(cfg: RouterConfig): string {
  const fb = cfg.fallback;
  if (!fb) return "";

  const presetMap = fb.presets?.[cfg.activePreset];
  const map = presetMap && Object.keys(presetMap).length > 0 ? presetMap : fb.global;
  if (!map) return "";

  const providerLines = Object.entries(map).flatMap(([provider, presetOrder]) => {
    if (!Array.isArray(presetOrder)) return [];
    const validOrder = presetOrder.filter(
      (preset) => preset !== cfg.activePreset && Boolean(cfg.presets[preset]),
    );
    return validOrder.length > 0 ? [`- ${provider}: ${validOrder.join(" -> ")}`] : [];
  });

  if (providerLines.length === 0) return "";

  return [
    "Fallback on delegated task errors:",
    "1. If Task(...) returns provider/model/rate-limit/timeout/auth errors, retry once with a different tier suited to the same task.",
    "2. If retry also fails, stop delegating that task and complete it directly in the primary agent.",
    "3. Use the failing model prefix and this preset fallback order for next-run recovery (`/preset <name>` + restart):",
    ...providerLines,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Cost & taxonomy builders
// ---------------------------------------------------------------------------

function buildTaskTaxonomy(cfg: RouterConfig): string {
  if (!cfg.taskPatterns || Object.keys(cfg.taskPatterns).length === 0) return "";

  const lines = ["Coding task routing guide:"];
  for (const [tier, patterns] of Object.entries(cfg.taskPatterns)) {
    if (Array.isArray(patterns) && patterns.length > 0) {
      lines.push(`- @${tier}: ${patterns.join(", ")}`);
    }
  }
  return lines.join("\n");
}

function buildCostAwareness(cfg: RouterConfig): string {
  const tiers = getActiveTiers(cfg);
  const costs = Object.entries(tiers)
    .filter(([_, t]) => t.costRatio != null)
    .map(([name, t]) => `@${name}=${t.costRatio}x`)
    .join(", ");

  if (!costs) return "";
  return `Cost ratios: ${costs}. Always use the cheapest tier that can reliably handle the task.`;
}

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

function buildDelegationProtocol(cfg: RouterConfig): string {
  const tiers = getActiveTiers(cfg);

  const tierSummary = Object.entries(tiers)
    .map(([name, t]) => {
      const shortModel = t.model.split("/").pop() ?? t.model;
      const variant = t.variant ? ` (${t.variant})` : "";
      return `@${name}=${shortModel}${variant}`;
    })
    .join(" | ");

  // Build per-tier whenToUse descriptions so the agent knows when to pick each tier
  const tierDescriptions = Object.entries(tiers)
    .map(([name, t]) => {
      const uses = t.whenToUse.length > 0 ? t.whenToUse.join(", ") : t.description;
      return `- @${name}: ${uses}`;
    })
    .join("\n");

  // Task taxonomy from config
  const taxonomy = buildTaskTaxonomy(cfg);

  // Cost awareness
  const costLine = buildCostAwareness(cfg);

  // Mode-aware rules: if active mode has overrideRules, use those; otherwise use global rules
  const mode = getActiveMode(cfg);
  const effectiveRules = mode?.overrideRules?.length ? mode.overrideRules : cfg.rules;
  const numberedRules = effectiveRules
    .map((rule, i) => `${i + 1}. ${rule}`)
    .join("\n");

  const fallbackInstructions = buildFallbackInstructions(cfg);

  return [
    "## Model Delegation Protocol",
    `Preset: ${cfg.activePreset}. Tiers: ${tierSummary}.`,
    "",
    "Tier capabilities:",
    tierDescriptions,
    ...(taxonomy ? ["", taxonomy] : []),
    ...(costLine ? ["", costLine] : []),
    ...(mode ? [`\nActive mode: ${cfg.activeMode} (${mode.description})`] : []),
    "",
    "Apply to every user message (plan and ad-hoc):",
    numberedRules,
    ...(fallbackInstructions ? ["", fallbackInstructions] : []),
    "",
    `Delegate with Task(subagent_type="fast|medium|heavy", prompt="...").`,
    "Keep orchestration and final synthesis in the primary agent.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// /tiers command output
// ---------------------------------------------------------------------------

function buildTiersOutput(cfg: RouterConfig): string {
  const tiers = getActiveTiers(cfg);
  const lines: string[] = [
    `# Model Delegation Tiers`,
    `Active preset: **${cfg.activePreset}**\n`,
  ];

  for (const [name, tier] of Object.entries(tiers)) {
    const thinkingStr = tier.thinking
      ? ` | thinking: ${tier.thinking.budgetTokens} tokens`
      : tier.reasoning
        ? ` | reasoning: effort=${tier.reasoning.effort}`
        : "";
    lines.push(`## @${name} -> \`${tier.model}\`${thinkingStr}`);
    lines.push(tier.description);
    lines.push(`Steps: ${tier.steps ?? "default"}`);
    lines.push(`Use when: ${tier.whenToUse.join(", ")}\n`);
  }

  lines.push("## Delegation Rules");
  cfg.rules.forEach((r) => lines.push(`- ${r}`));
  lines.push(`\nDefault tier: @${cfg.defaultTier}`);
  lines.push(`\nAvailable presets: ${Object.keys(cfg.presets).join(", ")}`);
  lines.push(`Switch with: \`/preset <name>\``);
  lines.push(`Edit \`tiers.json\` to customize.`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// /budget command output
// ---------------------------------------------------------------------------

function buildBudgetOutput(cfg: RouterConfig, args: string): string {
  const modes = cfg.modes;
  if (!modes || Object.keys(modes).length === 0) {
    return 'No modes configured in tiers.json. Add a "modes" section to enable budget mode.';
  }

  const requested = args.trim().toLowerCase();
  const currentMode = cfg.activeMode || "normal";

  // No args: show current mode and available modes
  if (!requested) {
    const lines = ["# Routing Modes\n"];
    for (const [name, mode] of Object.entries(modes)) {
      const active = name === currentMode ? " <- active" : "";
      lines.push(`- **${name}**${active}: ${mode.description} (default tier: @${mode.defaultTier})`);
    }
    lines.push(`\nSwitch with: \`/budget <mode>\``);
    return lines.join("\n");
  }

  // Switch mode
  if (modes[requested]) {
    saveActiveMode(requested);
    const mode = modes[requested];
    return [
      `Routing mode switched to **${requested}**.`,
      "",
      mode.description,
      `Default tier: @${mode.defaultTier}`,
      ...(mode.overrideRules?.length
        ? ["", "Active rules:", ...mode.overrideRules.map((r) => `- ${r}`)]
        : []),
      "",
      "Mode change takes effect immediately on the next message.",
    ].join("\n");
  }

  return `Unknown mode: "${requested}". Available: ${Object.keys(modes).join(", ")}`;
}

// ---------------------------------------------------------------------------
// /preset command output
// ---------------------------------------------------------------------------

function buildPresetOutput(cfg: RouterConfig, args: string): string {
  const requestedPreset = args.trim();

  // No args: show available presets
  if (!requestedPreset) {
    const lines = ["# Available Presets\n"];
    for (const [name, tiers] of Object.entries(cfg.presets)) {
      const active = name === cfg.activePreset ? " <- active" : "";
      const models = Object.entries(tiers)
        .map(([tier, t]) => `${tier}: ${t.model.split("/").pop()}`)
        .join(", ");
      lines.push(`- **${name}**${active}: ${models}`);
    }
    lines.push(`\nSwitch with: \`/preset <name>\``);
    return lines.join("\n");
  }

  // Switch preset
  const resolvedPreset = resolvePresetName(cfg, requestedPreset);
  if (resolvedPreset) {
    saveActivePreset(resolvedPreset);
    cfg.activePreset = resolvedPreset;
    const tiers = cfg.presets[resolvedPreset]!;
    const models = Object.entries(tiers)
      .map(([tier, t]) => `  @${tier} -> ${t.model}`)
      .join("\n");
    return [
      `Preset switched to **${resolvedPreset}**.`,
      "",
      models,
      "",
      "Selection is now persisted in ~/.config/opencode/opencode-model-router.state.json.",
      "Restart OpenCode for subagent model registration to take effect.",
      "System prompt delegation rules update immediately.",
    ].join("\n");
  }

  return `Unknown preset: "${requestedPreset}". Available: ${Object.keys(cfg.presets).join(", ")}`;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const ModelRouterPlugin: Plugin = async (_ctx: PluginInput) => {
  let cfg = loadConfig();
  const activeTiers = getActiveTiers(cfg);

  return {
    // -----------------------------------------------------------------------
    // Register tier agents + commands at load time
    // -----------------------------------------------------------------------
    config: async (opencodeConfig: any) => {
      opencodeConfig.agent ??= {};

      for (const [name, tier] of Object.entries(activeTiers)) {
        const agentDef: Record<string, unknown> = {
          model: tier.model,
          mode: "subagent",
          description: tier.description,
          steps: tier.steps,
          prompt: tier.prompt,
          color: tier.color,
        };

        // Apply variant (thinking/reasoning mode)
        if (tier.variant) {
          agentDef.variant = tier.variant;
        }

        // Apply provider-specific options
        const opts = buildAgentOptions(tier);
        if (Object.keys(opts).length > 0) {
          agentDef.options = opts;
        }

        opencodeConfig.agent[name] = agentDef;
      }

      // Register commands
      opencodeConfig.command ??= {};
      opencodeConfig.command["tiers"] = {
        template: "",
        description: "Show model delegation tiers and rules",
      };
      opencodeConfig.command["preset"] = {
        template: "$ARGUMENTS",
        description: "Show or switch model presets (e.g., /preset openai)",
      };
      opencodeConfig.command["budget"] = {
        template: "$ARGUMENTS",
        description: "Show or switch routing mode (e.g., /budget, /budget budget, /budget quality)",
      };
      opencodeConfig.command["annotate-plan"] = {
        template: [
          "Annotate the plan with tier directives for model delegation.",
          "",
          'Plan file: "$ARGUMENTS"',
          "If no file was specified, search for the active plan: PLAN.md, plan.md, or the most recent .md with 'plan' in the name in the current directory or project root.",
          "",
          "## Available tiers",
          "- `[tier:fast]` — Fast/cheap model: exploration, search, file reads, grep, listing, research. Agent does NOT edit code.",
          "- `[tier:medium]` — Balanced model: implementation, refactoring, tests, code review, bug fixes, standard coding tasks.",
          "- `[tier:heavy]` — Most capable model: architecture, complex debugging (after failures), security, performance, multi-system tradeoffs.",
          "",
          "## Annotation rules",
          "1. Place `[tier:X]` at the START of each step, before the description",
          "2. Research/exploration -> `[tier:fast]`",
          "3. Implementation/code -> `[tier:medium]`",
          "4. Architecture/security/hard debugging -> `[tier:heavy]`",
          "5. If a step mixes exploration AND implementation, break it into two separate steps",
          "6. Verification (run tests, build) -> `[tier:medium]`",
          "7. Trivial (single grep or file read) -> `[tier:fast]`",
          "8. Final review of the complete plan -> `[tier:heavy]`",
          "",
          "## Output",
          "Rewrite the entire plan in the file with the tags. Do not change the substance — only add tags and break mixed steps.",
        ].join("\n"),
        description: "Annotate a plan with [tier:fast/medium/heavy] delegation tags",
      };
    },

    // -----------------------------------------------------------------------
    // Inject delegation protocol — uses cached config (invalidated on /preset or /budget)
    // -----------------------------------------------------------------------
    "experimental.chat.system.transform": async (_input: any, output: any) => {
      try {
        cfg = loadConfig(); // Returns cache unless invalidated
      } catch {
        // Use last known config if file read fails
      }
      output.system.push(buildDelegationProtocol(cfg));
    },

    // -----------------------------------------------------------------------
    // Handle /tiers, /preset, and /budget commands
    // -----------------------------------------------------------------------
    "command.execute.before": async (input: any, output: any) => {
      if (input.command === "tiers") {
        try {
          cfg = loadConfig();
        } catch {}
        output.parts.push({ type: "text" as const, text: buildTiersOutput(cfg) });
      }

      if (input.command === "preset") {
        try {
          cfg = loadConfig();
        } catch {}
        output.parts.push({
          type: "text" as const,
          text: buildPresetOutput(cfg, input.arguments ?? ""),
        });
      }

      if (input.command === "budget") {
        try {
          cfg = loadConfig();
        } catch {}
        output.parts.push({
          type: "text" as const,
          text: buildBudgetOutput(cfg, input.arguments ?? ""),
        });
      }
    },
  };
};

export default ModelRouterPlugin;
