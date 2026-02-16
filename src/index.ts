import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { readFileSync, writeFileSync } from "fs";
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
  color?: string;
  description: string;
  steps?: number;
  prompt?: string;
  whenToUse: string[];
}

type Preset = Record<string, TierConfig>;

interface RouterConfig {
  activePreset: string;
  presets: Record<string, Preset>;
  rules: string[];
  defaultTier: string;
}

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

function getPluginRoot(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  return join(__dirname, ".."); // src/ -> plugin root
}

function configPath(): string {
  return join(getPluginRoot(), "tiers.json");
}

function loadConfig(): RouterConfig {
  return JSON.parse(readFileSync(configPath(), "utf-8")) as RouterConfig;
}

function saveActivePreset(presetName: string): void {
  const cfg = loadConfig();
  cfg.activePreset = presetName;
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + "\n", "utf-8");
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
// System prompt builder
// ---------------------------------------------------------------------------

function buildDelegationProtocol(cfg: RouterConfig): string {
  const tiers = getActiveTiers(cfg);

  const tierRows = Object.entries(tiers)
    .map(([name, t]) => {
      const shortModel = t.model.split("/").pop() ?? t.model;
      const thinkingInfo = t.variant ? ` (${t.variant})` : "";
      return `| @${name} | \`${shortModel}\`${thinkingInfo} | ${t.description} |`;
    })
    .join("\n");

  const whenToUse = Object.entries(tiers)
    .map(([name, t]) => `- **@${name}**: ${t.whenToUse.join(", ")}`)
    .join("\n");

  const rules = cfg.rules.map((r, i) => `${i + 1}. ${r}`).join("\n");

  return [
    "## Model Delegation Protocol",
    "",
    `Active preset: **${cfg.activePreset}** (switch with \`/preset <name>\`)`,
    `Available presets: ${Object.keys(cfg.presets).join(", ")}`,
    "",
    "| Agent | Model | Purpose |",
    "|-------|-------|---------|",
    tierRows,
    "",
    "### When to use each tier:",
    whenToUse,
    "",
    "### Rules:",
    rules,
    "",
    "### How to delegate:",
    "Use the Task tool with the tier name as `subagent_type`:",
    '- `Task(subagent_type="fast", prompt="Find all files importing AuthContext")`',
    '- `Task(subagent_type="medium", prompt="Implement the UserService class per the spec")`',
    '- `Task(subagent_type="heavy", prompt="Review this auth flow for security vulnerabilities")`',
    "",
    `Default tier when unspecified: **@${cfg.defaultTier}**`,
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
  if (cfg.presets[requestedPreset]) {
    saveActivePreset(requestedPreset);
    const tiers = cfg.presets[requestedPreset]!;
    const models = Object.entries(tiers)
      .map(([tier, t]) => `  @${tier} -> ${t.model}`)
      .join("\n");
    return [
      `Preset switched to **${requestedPreset}**.`,
      "",
      models,
      "",
      "Restart OpenCode for agent registration to take effect.",
      "System prompt delegation rules will update immediately.",
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
    // Inject delegation protocol — re-reads config each time for live updates
    // -----------------------------------------------------------------------
    "experimental.chat.system.transform": async (_input: any, output: any) => {
      try {
        cfg = loadConfig(); // Re-read for live preset switches
      } catch {
        // Use cached config if file read fails
      }
      output.system.push(buildDelegationProtocol(cfg));
    },

    // -----------------------------------------------------------------------
    // Handle /tiers and /preset commands
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
    },
  };
};

export default ModelRouterPlugin;
