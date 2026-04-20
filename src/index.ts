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
  /** Global default prompts per tier name. A preset-level tier.prompt overrides this. */
  tierPrompts?: Record<string, string>;
  /** Read-only tool-call caps per tier, enforced at runtime via tool.execute.after banner injection. */
  tierCaps?: Record<string, number>;
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
  return join(
    homedir(),
    ".config",
    "opencode",
    "opencode-model-router.state.json",
  );
}

function resolvePresetName(
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

function validateConfig(raw: unknown): RouterConfig {
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
  const map =
    presetMap && Object.keys(presetMap).length > 0 ? presetMap : fb.global;
  if (!map) return "";

  const chains = Object.entries(map).flatMap(([provider, presetOrder]) => {
    if (!Array.isArray(presetOrder)) return [];
    const valid = presetOrder.filter(
      (p) => p !== cfg.activePreset && Boolean(cfg.presets[p]),
    );
    return valid.length > 0 ? [`${provider}→${valid.join("→")}`] : [];
  });

  if (chains.length === 0) return "";
  return `Err→retry-alt-tier→fail→direct. Chain: ${chains.join(" | ")}`;
}

// ---------------------------------------------------------------------------
// Cost & taxonomy builders
// ---------------------------------------------------------------------------

function buildTaskTaxonomy(cfg: RouterConfig): string {
  if (!cfg.taskPatterns || Object.keys(cfg.taskPatterns).length === 0)
    return "";
  const lines = ["R:"];
  for (const [tier, patterns] of Object.entries(cfg.taskPatterns)) {
    if (Array.isArray(patterns) && patterns.length > 0) {
      lines.push(`@${tier}→${patterns.join("/")}`);
    }
  }
  return lines.join(" ");
}

/**
 * Injects a multi-phase decomposition hint into the delegation protocol.
 * Teaches the orchestrator to split composite tasks (explore + implement)
 * so the cheap @fast tier handles exploration and @medium handles execution.
 * Only active in normal mode — budget/quality modes have their own override rules.
 */
function buildDecomposeHint(cfg: RouterConfig): string {
  const mode = getActiveMode(cfg);
  // Budget and quality modes handle this via overrideRules — skip to avoid conflicts
  if (mode?.overrideRules?.length) return "";

  const tiers = getActiveTiers(cfg);
  const entries = Object.entries(tiers);
  if (entries.length < 2) return "";

  // Sort by costRatio ascending to find cheapest (explore) and next (execute) tiers
  const sorted = [...entries].sort(
    ([, a], [, b]) => (a.costRatio ?? 1) - (b.costRatio ?? 1),
  );
  const cheapest = sorted[0]?.[0];
  const mid = sorted[1]?.[0];
  if (!cheapest || !mid) return "";

  return `Multi-phase: prefer explore(@${cheapest})→execute(@${mid}) when phases are separable. Cheapest-first when practical.`;
}

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

function buildDelegationProtocol(cfg: RouterConfig): string {
  const tiers = getActiveTiers(cfg);

  // Compact tier summary: @name=model/variant(costRatio)
  const tierLine = Object.entries(tiers)
    .map(([name, t]) => {
      const short = t.model.split("/").pop() ?? t.model;
      const v = t.variant ? `/${t.variant}` : "";
      const c = t.costRatio != null ? `(${t.costRatio}x)` : "";
      return `@${name}=${short}${v}${c}`;
    })
    .join(" ");

  const mode = getActiveMode(cfg);
  const modeSuffix = cfg.activeMode ? ` mode:${cfg.activeMode}` : "";

  const taxonomy = buildTaskTaxonomy(cfg);
  const decompose = buildDecomposeHint(cfg);

  const effectiveRules = mode?.overrideRules?.length
    ? mode.overrideRules
    : cfg.rules;
  const rulesLine = effectiveRules.map((r, i) => `${i + 1}.${r}`).join(" ");

  const fallback = buildFallbackInstructions(cfg);

  return [
    `## Model Delegation Protocol — MANDATORY`,
    ``,
    `You are the orchestrator. Information-gathering is NOT orchestration — it IS execution. Execution belongs to subagents, not to you.`,
    ``,
    `Preset: ${cfg.activePreset}. Tiers: ${tierLine}.${modeSuffix}`,
    ``,
    `### HARD ROUTING (non-negotiable)`,
    `- **Read-only work** (grep, glob, read, ls, lookup, count, git-info, doc-lookup, type-check, exists-check) → default to \`Task(subagent_type="fast", ...)\`. Self-cap (TARGET): ≤2 direct read-only calls per user turn; on the 3rd read-only need, dispatch @fast instead. You may exceed with a 1-line \`reason:\` note when dispatching feels clearly wrong. Rationale: every tool-result token is billed at your tier rate — a grep via @fast costs ~20x less than the same grep here.`,
    `- **Implementation work** (write, edit, refactor, tests, bug-fix, build-fix, create-file, config, api-endpoint) → \`Task(subagent_type="medium", ...)\`.`,
    `- **Architecture / security / perf / debugging after ≥2 failures / multi-system tradeoffs / RCA** → \`Task(subagent_type="heavy", ...)\`, UNLESS you ARE @heavy (opus); then handle locally and never self-call @heavy.`,
    ``,
    `### DISPATCH CAPS (read-only budget per subagent)`,
    `Subagents carry a TARGET cap on their own read-only tool calls (baseline: @fast=8, @medium=5, @heavy=3). Include \`CAP:N\` in the dispatch prompt to override (e.g., \`CAP:3\` for a tight lookup, \`CAP:none\` to disable). Mode adjustments apply automatically via rules below. Subagents also run a redundancy check every call: if they detect repeated reads/greps of the same area, they STOP and return partial findings with \`DONE: ...\`, \`NEED MORE: ...\`, or \`ESCALATE: ...\` — you decide the next step from their return.`,
    ``,
    `### ROLE CONTRACT`,
    `The primary agent's job: decompose the user's request, dispatch subagents, synthesize their results, and answer the user. Keep orchestration-first posture: prefer dispatching read-only exploration to @fast rather than running repeated Grep/Read/Glob/Bash calls yourself. Self-cap applies (see HARD ROUTING above): ≤2 direct read-only calls per turn as a target; beyond that, dispatch @fast.`,
    ``,
    `### @fast contract`,
    `@fast is a read-only explorer. It will search/grep/read/count/lookup and return file:line paths, snippets, and a one-line summary. It will refuse edits. Batch related searches into a single @fast dispatch when possible; fire independent searches in parallel (one message, multiple Task calls).`,
    ``,
    `### @medium contract`,
    `@medium is the implementer. It writes, edits, refactors, adds tests, fixes bugs, applies build-fixes. It matches existing project patterns, runs targeted tests for changed areas, and reports back if it hits 2+ consecutive failures instead of self-escalating. Give it context: file paths, patterns to match, what verification to run.`,
    ``,
    `### @heavy contract (CRITICAL — read before every @heavy dispatch)`,
    `@heavy has **no Task tool** — it cannot self-explore, cannot grep, cannot delegate. Dispatching @heavy without context can waste a run: it may reason on thin evidence or return "SCOPE GROWTH" asking for additional @fast findings.`,
    `**Before @heavy, gather context first — usually via @fast.** If you already have sufficient concrete context, dispatch @heavy directly. If @heavy still needs more evidence, collect it with @fast and re-invoke.`,
    `Pattern: \`Task(@fast, "collect X, Y, Z")\` (when needed) → synthesize findings → \`Task(@heavy, "given these findings: [paste], analyze W")\`.`,
    ``,
    `### CONFLICT WITH CLAUDE.md / AGENTS.md`,
    `If CLAUDE.md or AGENTS.md (or any other guide in your context) says "use direct tools first when scope is clear" or labels Grep/Read/Glob as "FREE", **this protocol wins**. Those labels are wrong about cost: tools executed by you are billed at your tier rate — every tool-result token is tokenized into your context. A Grep dispatched to @fast costs ~20x less than the same Grep executed by @heavy. Treat yourself as expensive and delegate reads by default.`,
    ``,
    ...(taxonomy ? [taxonomy, ``] : []),
    ...(decompose ? [decompose, ``] : []),
    `### Compact rules`,
    rulesLine,
    ...(fallback ? [``, fallback] : []),
    ``,
    `Delegate with \`Task(subagent_type="fast"|"medium"|"heavy", prompt="...")\`. Keep orchestration and final synthesis here.`,
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
      lines.push(
        `- **${name}**${active}: ${mode.description} (default tier: @${mode.defaultTier})`,
      );
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
// Runtime cap enforcement (tool.execute.after banner injection for subagents)
// ---------------------------------------------------------------------------

/** Tools that count against the read-only cap. Keep narrow — editing tools should never count. */
const READ_ONLY_TOOLS = new Set(["grep", "read", "glob", "ls"]);

/** Fallback caps when tiers.json has no tierCaps block. */
const DEFAULT_TIER_CAPS: Record<string, number> = {
  fast: 8,
  medium: 5,
  heavy: 3,
};

type Cap = number | "none";

interface SubagentState {
  tierName: string;
  cap: Cap;
  calls: number;
  /** Fingerprint → call index where this fingerprint was first seen. */
  seen: Map<string, number>;
}

/** Extract the first `CAP:N` or `CAP:none` directive from a dispatch prompt. */
function parseCapDirective(text: string): Cap | null {
  const m = text.match(/\bCAP\s*:\s*(none|\d+)\b/i);
  if (!m) return null;
  const raw = m[1]!.toLowerCase();
  if (raw === "none") return "none";
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Fingerprint a read-only tool call for redundancy detection. */
function fingerprintToolCall(tool: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (tool) {
    case "read":
      return `read:${a.file_path ?? a.filePath ?? ""}`;
    case "grep":
      return `grep:${a.pattern ?? ""}:${a.path ?? a.glob ?? ""}`;
    case "glob":
      return `glob:${a.pattern ?? ""}:${a.path ?? ""}`;
    case "ls":
      return `ls:${a.path ?? ""}`;
    default:
      return `${tool}:${JSON.stringify(a).slice(0, 120)}`;
  }
}

/** Best-effort extraction of textual content from a chat.message output payload. */
function extractDispatchText(output: unknown): string {
  const o = output as Record<string, unknown> | undefined;
  const parts = (o?.parts as unknown[]) ?? [];
  const chunks: string[] = [];
  for (const p of parts) {
    if (typeof p === "string") {
      chunks.push(p);
    } else if (p && typeof p === "object") {
      const rec = p as Record<string, unknown>;
      if (typeof rec.text === "string") chunks.push(rec.text);
      else if (typeof rec.content === "string") chunks.push(rec.content);
    }
  }
  if (chunks.length === 0) {
    const msg = o?.message as Record<string, unknown> | undefined;
    const content = msg?.content;
    if (typeof content === "string") chunks.push(content);
  }
  return chunks.join("\n");
}

/** Build the banner appended to every read-only tool result in a subagent session. */
function buildCapBanner(
  state: SubagentState,
  isRedundant: boolean,
  previousCall: number | undefined,
  tool: string,
): string {
  const lines: string[] = [];
  const capDisplay = state.cap === "none" ? "∞" : String(state.cap);
  lines.push(`[cap: ${state.calls}/${capDisplay}]`);

  if (isRedundant && previousCall !== undefined) {
    lines.push(
      `[⚠ REDUNDANT: this is the same ${tool} you ran at call #${previousCall}. STOP now — repeated reads add no information. Return with DONE/NEED MORE/NEED CONTEXT/SCOPE GROWTH/ESCALATE.]`,
    );
  }

  if (state.cap !== "none") {
    const remaining = state.cap - state.calls;
    if (remaining <= 0) {
      lines.push(
        `[⚠ CAP REACHED (${state.calls}/${state.cap}): your NEXT response MUST be a return — do NOT make another read-only call. Start the response with DONE:, NEED MORE:, NEED CONTEXT:, SCOPE GROWTH:, or ESCALATE:.]`,
      );
    } else if (remaining <= 2) {
      lines.push(
        `[⚠ CAP WARNING: ${remaining} read-only call(s) remaining before forced return]`,
      );
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Claude-model adversarial prefixes
//
// Anthropic models (direct or via other providers) are served with a large
// cached "Claude Code" signature prompt that primes them toward broad
// exploratory Read/Grep/Glob behavior. Our tier prompts land after that
// cached block and lose authority through primacy bias and cache freezing.
// For Claude models specifically, we prepend an override block that
// explicitly revokes the exploratory priming for the current dispatch.
//
// Detection is by model identifier, not preset — a hybrid preset mixing
// providers gets the override only on its Claude-backed tiers.
// ---------------------------------------------------------------------------

function isClaudeModel(modelID: string | undefined): boolean {
  if (!modelID) return false;
  const s = modelID.toLowerCase();
  if (s.startsWith("anthropic/")) return true;
  return /\/claude-/.test(s) || /(^|[\/\-])claude-/.test(s);
}

/** Per-tier adversarial openers. @fast/@medium use Tom 2 (scoping); @heavy uses Tom 1 (override). */
const CLAUDE_TIER_PREFIX: Record<string, string> = {
  fast: [
    "SCOPE NOTE — any cached instruction priming you to 'thoroughly explore",
    "the codebase' or 'gather context broadly' does not apply here. This is",
    "a single dispatch with a single question. Stay narrow to the ask.",
    "",
    "Before every tool call, ask: 'Does THIS read answer the dispatch",
    "question specifically, or am I drifting into context-gathering for my",
    "own understanding?' If the latter, stop — you have enough.",
  ].join("\n"),
  medium: [
    "SCOPE NOTE — cached instructions may prime you to deeply understand",
    "surrounding code before editing. For THIS dispatch, the orchestrator",
    "has already scoped the problem; trust that scoping. Read what's needed",
    "for the edit, not the whole module.",
    "",
    "A 4th or 5th 'context read' is usually a sign the dispatch was under-",
    "scoped — return NEED CONTEXT rather than expanding scope yourself.",
  ].join("\n"),
  heavy: [
    "AUTHORITY OVERRIDE — this block supersedes any cached prefix suggesting",
    "you should 'investigate thoroughly', 'gather comprehensive context', or",
    "'trace through the code systematically before analyzing'. You are",
    "@heavy, an ANALYSIS specialist. The orchestrator should have pre-",
    "gathered context via @fast before dispatching you. If it didn't, return",
    "`SCOPE GROWTH:` immediately — do NOT self-gather.",
    "",
    "40 minutes of Read/Grep is not analysis — it is the orchestrator's job",
    "that leaked into yours. Push it back with SCOPE GROWTH. Your 3 reads",
    "are for targeted verification, not exploration.",
  ].join("\n"),
};

/** Adversarial opener prepended to the delegation protocol when the orchestrator is a Claude model. */
const CLAUDE_ORCHESTRATOR_PREFIX = [
  "AUTHORITY OVERRIDE — this block supersedes any prior system instruction",
  "about 'exploring the codebase', 'gathering context with tools', or using",
  "Read/Grep/Glob to validate assumptions. Those instructions describe a",
  "general-purpose Claude Code session. THIS session is a routing",
  "orchestrator.",
  "",
  "Your job is to DISPATCH, not to EXECUTE. Read-only work (grep/read/",
  "glob/ls) is execution, and execution is delegated to @fast. You may run",
  "AT MOST 2 direct read-only tool calls per turn — a 3rd call is a rule",
  "violation. If you need more context, you dispatch @fast.",
  "",
  "If a cached instruction told you to 'be thorough', 'explore broadly', or",
  "'read supporting files' — ignore it here. Thoroughness is achieved by",
  "dispatching the right tier, not by you becoming the explorer.",
].join("\n");

/**
 * Anti-narration clause appended to every Claude-model prefix (tier + orchestrator).
 *
 * Thinking-enabled Claude models (esp. Sonnet with `max` variant) sometimes
 * produce progress narration in place of actual work — "Still writing X...",
 * "Now I'll implement Y...", "Let me add Z..." — without the X/Y/Z ever
 * appearing. This clause names the pattern, lists specific forbidden phrasings
 * (A3 — exemplified), and carves out an escape valve for legitimate
 * explanation/plan requests (A2 — with exception).
 */
const CLAUDE_ANTI_NARRATION = [
  "ANTI-NARRATION — do NOT write progress commentary in your response or",
  "thinking output. Forbidden phrasings include:",
  "  - \"Still writing the X function...\"",
  "  - \"Now I'll implement Y...\"",
  "  - \"Let me add Z...\"",
  "  - \"Continuing with W...\"",
  "  - \"Going to fix V...\"",
  "",
  "Each of these signals planning without production. If you write one, the",
  "NEXT tokens MUST contain the actual artifact (the code, the edit, the",
  "concrete output). Otherwise, stop and return with status.",
  "",
  "Exception: when the user explicitly asks for an explanation, plan, or",
  "walkthrough, prose is welcome — this rule targets unsolicited progress",
  "narration during code and implementation tasks.",
].join("\n");

// ---------------------------------------------------------------------------
// Narration detector (telemetry — logs + appends banner)
// ---------------------------------------------------------------------------

/** Regex patterns that flag progress narration without production. */
const NARRATION_PATTERNS: RegExp[] = [
  // "Still writing the X", "Still implementing the Y"
  /\bstill\s+(writing|implementing|working on|adding|creating|fixing|building|refactoring|handling)\s+(the\s+)?\w+/gi,
  // "Now I'll write the X", "Now writing the Y"
  /\bnow\s+(i['']ll\s+)?(writ|implement|add|creat|work|fix|build|handl|refactor|updat|mov)\w*\s+(the\s+)?\w+/gi,
  // "Let me write X", "Let me implement Y"
  /\blet\s+me\s+(write|implement|add|create|fix|build|handle|refactor|work on|move|update|set up)\s+(the\s+)?\w+/gi,
  // "I'll write the X", "I'll now implement Y"
  /\bi['']ll\s+(now\s+)?(write|implement|add|create|fix|build|handle|refactor|set up|work on|move|update)\s+(the\s+)?\w+/gi,
  // "Going to fix the X"
  /\bgoing\s+to\s+(write|implement|add|create|fix|build|handle|refactor|set up|work on|move|update)\s+(the\s+)?\w+/gi,
  // "Continuing with X", "Continuing by adding Y"
  /\bcontinuing\s+(with|by\s+\w+ing)\s+(the\s+)?\w+/gi,
];

/** Returns matched narration phrases, deduped and capped. Empty array = no narration detected. */
function detectNarration(text: string): string[] {
  if (text.length < 20) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const pattern of NARRATION_PATTERNS) {
    const matches = text.match(pattern);
    if (!matches) continue;
    for (const m of matches) {
      const trimmed = m.trim().toLowerCase();
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(m.trim());
      if (out.length >= 5) return out;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const ModelRouterPlugin: Plugin = async (_ctx: PluginInput) => {
  let cfg = loadConfig();
  const activeTiers = getActiveTiers(cfg);

  // Track subagent sessions so we can skip delegation protocol injection.
  // Populated by chat.params (which has the agent name) before system.transform fires.
  const subagentSessionIDs = new Set<string>();

  // Per-subagent-session cap state for runtime enforcement. Populated on chat.message,
  // read/updated by tool.execute.after. Keyed by sessionID. Orchestrator sessions are
  // intentionally NOT tracked here (per user decision: enforce on subagents only).
  const subagentCapState = new Map<string, SubagentState>();

  return {
    // -----------------------------------------------------------------------
    // Detect subagent calls via chat.message. When the agent name matches a
    // registered tier, record the sessionID so system.transform can skip
    // delegation-protocol injection.
    //
    // IMPORTANT: must be chat.message, NOT chat.params. The opencode hook
    // order is chat.message -> system.transform -> chat.params, so populating
    // the Set in chat.params is always one step too late — system.transform
    // already ran with an empty Set and leaked the "Delegate with Task(...)"
    // instructions into the subagent's system prompt. Sonnet subagents like
    // @explore silently ignore that noise, but literal-minded Haiku (@fast)
    // emits malformed XML tool calls for the nonexistent Task tool, which
    // surface in the UI as "<parameter>...</parameter>" leakage.
    //
    // chat.message fires inside SessionPrompt.createUserMessage() BEFORE the
    // loop -> LLM.stream path, so by the time system.transform runs the Set
    // is fully populated and await-safe (yield* on the plugin trigger).
    // -----------------------------------------------------------------------
    "chat.message": async (input: any, output: any) => {
      // Re-read cfg so /preset switches take effect without restart
      try {
        cfg = loadConfig();
      } catch {}
      const tierNames = Object.keys(getActiveTiers(cfg));
      if (input.agent && tierNames.includes(input.agent)) {
        subagentSessionIDs.add(input.sessionID);

        // Initialize cap state on first dispatch; reset on subsequent rounds to the same
        // subagent session (rare but supported — treats each round as a fresh budget).
        const tierName = input.agent as string;
        const dispatchText = extractDispatchText(output);
        const override = parseCapDirective(dispatchText);
        const baseline =
          cfg.tierCaps?.[tierName] ?? DEFAULT_TIER_CAPS[tierName] ?? 5;
        const cap: Cap = override ?? baseline;
        subagentCapState.set(input.sessionID, {
          tierName,
          cap,
          calls: 0,
          seen: new Map(),
        });
      }
    },

    // -----------------------------------------------------------------------
    // Runtime cap + redundancy enforcement (subagents only).
    // Appends `[cap: N/MAX]` and `[⚠ REDUNDANT]` / `[⚠ CAP REACHED]` banners
    // to every read-only tool result the subagent sees. Because these land
    // inside `output.output` — the tool's own response text — the model
    // treats them as ground truth rather than advisory system noise.
    // -----------------------------------------------------------------------
    "tool.execute.after": async (input: any, output: any) => {
      const state = subagentCapState.get(input.sessionID);
      if (!state) return; // not a tracked subagent session
      if (!READ_ONLY_TOOLS.has(input.tool)) return;

      const fp = fingerprintToolCall(input.tool, input.args);
      const previousCall = state.seen.get(fp);
      const isRedundant = previousCall !== undefined;

      state.calls += 1;
      if (!isRedundant) {
        state.seen.set(fp, state.calls);
      }

      const banner = buildCapBanner(state, isRedundant, previousCall, input.tool);

      const existing =
        typeof output.output === "string" ? output.output : "";
      output.output = existing ? `${existing}\n\n${banner}` : banner;
    },

    // -----------------------------------------------------------------------
    // Narration detector — flags progress-commentary-without-production.
    //
    // Fires per completed text part. Scans for narration patterns; if any
    // match, logs a warning to the plugin console and appends a visible
    // banner to the text so the user sees the detection in the UI. This is
    // telemetry, not blocking — we cannot modify mid-stream generation, only
    // post-hoc signal.
    // -----------------------------------------------------------------------
    "experimental.text.complete": async (input: any, output: any) => {
      const text = output?.text;
      if (typeof text !== "string" || text.length < 20) return;

      const found = detectNarration(text);
      if (found.length === 0) return;

      const quoted = found
        .map((m) => `"${m.slice(0, 60)}${m.length > 60 ? "…" : ""}"`)
        .join(", ");
      console.warn(
        `[model-router] narration detected (session ${input?.sessionID ?? "?"}): ${quoted}`,
      );
      output.text = `${text}\n\n[⚠ narration detected: ${quoted}]`;
    },

    // -----------------------------------------------------------------------
    // Register tier agents + commands at load time
    // -----------------------------------------------------------------------
    config: async (opencodeConfig: any) => {
      opencodeConfig.agent ??= {};

      for (const [name, tier] of Object.entries(activeTiers)) {
        // Resolve prompt: per-tier override wins; otherwise fall back to global tierPrompts[name].
        const resolvedPrompt = tier.prompt ?? cfg.tierPrompts?.[name];

        // For Claude-backed tiers, prepend an adversarial opener that revokes
        // the cached "Claude Code exploratory agent" priming for this dispatch.
        // Detection is by model string, so hybrid presets get the override
        // only on their Claude-backed tiers.
        const claudePrefix = isClaudeModel(tier.model)
          ? `${CLAUDE_TIER_PREFIX[name]}\n\n${CLAUDE_ANTI_NARRATION}`
          : undefined;
        const finalPrompt =
          claudePrefix && resolvedPrompt
            ? `${claudePrefix}\n\n---\n\n${resolvedPrompt}`
            : resolvedPrompt;

        const agentDef: Record<string, unknown> = {
          model: tier.model,
          mode: "subagent",
          description: tier.description,
          maxSteps: tier.steps,
          prompt: finalPrompt,
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
        description:
          "Show or switch routing mode (e.g., /budget, /budget budget, /budget quality)",
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
          "2. Research/exploration -> `[tier:fast]` (preferred)",
          "3. Implementation/code -> `[tier:medium]` (preferred)",
          "4. Architecture/security/hard debugging -> `[tier:heavy]`",
          "5. If a step mixes exploration AND implementation, prefer splitting it into two steps when it improves delegation clarity",
          "6. Verification (run tests, build) -> `[tier:medium]`",
          "7. Trivial (single grep or file read) -> `[tier:fast]`",
          "8. Final review of the complete plan -> `[tier:heavy]`",
          "",
          "## Output",
          "Rewrite the entire plan in the file with the tags. Do not change the substance — only add tags, and split mixed steps when useful for clearer delegation.",
        ].join("\n"),
        description:
          "Annotate a plan with [tier:fast/medium/heavy] delegation tags",
      };
    },

    // -----------------------------------------------------------------------
    // Inject delegation protocol — uses cached config (invalidated on /preset or /budget)
    // Only inject for the primary orchestrator, NOT for subagent calls.
    // Subagents get confused by delegation instructions when they should
    // just execute a task (especially smaller models like Haiku).
    // -----------------------------------------------------------------------
    "experimental.chat.system.transform": async (_input: any, output: any) => {
      try {
        cfg = loadConfig(); // Returns cache unless invalidated
      } catch {
        // Use last known config if file read fails
      }

      // Skip injection for child (subagent) sessions.
      // Child sessions are detected via session.created events with a parentID.
      const sessionID = _input?.sessionID;
      if (sessionID && subagentSessionIDs.has(sessionID)) return;

      // For Claude-backed orchestrators, prepend an adversarial opener that
      // revokes the cached "Claude Code explorer" priming for the routing
      // role. Detection is by orchestrator model, not preset.
      const providerID = _input?.model?.providerID ?? "";
      const modelID = _input?.model?.modelID ?? "";
      const orchestratorModel = providerID && modelID ? `${providerID}/${modelID}` : modelID;
      const delegationProtocol = buildDelegationProtocol(cfg);
      const finalProtocol = isClaudeModel(orchestratorModel)
        ? `${CLAUDE_ORCHESTRATOR_PREFIX}\n\n${CLAUDE_ANTI_NARRATION}\n\n---\n\n${delegationProtocol}`
        : delegationProtocol;

      output.system.push(finalProtocol);
    },

    // -----------------------------------------------------------------------
    // Handle /tiers, /preset, and /budget commands
    // -----------------------------------------------------------------------
    "command.execute.before": async (input: any, output: any) => {
      if (input.command === "tiers") {
        try {
          cfg = loadConfig();
        } catch {}
        output.parts.push({
          type: "text" as const,
          text: buildTiersOutput(cfg),
        });
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
