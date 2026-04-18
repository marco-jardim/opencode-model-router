/**
 * QUICK REFERENCE: Custom Slash Commands in OpenCode Plugins
 * 
 * Source: D:\git\opencode-model-router\src\index.ts
 * Reference Documentation: COMMAND_PATTERNS.md
 */

// ============================================================================
// 1. COMMAND REGISTRATION (in config hook)
// ============================================================================

// Lines 566-606 in src/index.ts
const modelRouterPlugin = {
  config: async (opencodeConfig: any) => {
    // ALWAYS initialize if missing
    opencodeConfig.command ??= {};

    // Basic command (no arguments)
    opencodeConfig.command["tiers"] = {
      template: "",  // Empty string = no arguments accepted
      description: "Show model delegation tiers and rules",
    };

    // Command with arguments
    opencodeConfig.command["preset"] = {
      template: "$ARGUMENTS",  // $ARGUMENTS placeholder for user input
      description: "Show or switch model presets (e.g., /preset openai)",
    };

    // Multi-line template (join array with \n)
    opencodeConfig.command["annotate-plan"] = {
      template: [
        "Line 1 of instructions",
        "Line 2 with $ARGUMENTS",
        'File: "$ARGUMENTS"',
      ].join("\n"),
      description: "Annotate a plan with tier directives",
    };
  },
};

// ============================================================================
// 2. COMMAND HANDLER (command.execute.before hook)
// ============================================================================

// Lines 624-651 in src/index.ts
const handleCommands = {
  "command.execute.before": async (input: any, output: any) => {
    // input.command      : string  (command name without /)
    // input.arguments    : string | null  (raw user input after command)
    // output.parts       : MessagePart[]  (where to write responses)

    if (input.command === "preset") {
      const args = input.arguments ?? "";  // Default to empty string

      // Build response
      const response = buildPresetOutput(cfg, args);

      // Write to output
      output.parts.push({
        type: "text" as const,  // Always "text" for string responses
        text: response,
      });
    }
  },
};

// ============================================================================
// 3. ARGUMENT PARSING PATTERN
// ============================================================================

// Lines 443-481 in src/index.ts
function buildBudgetOutput(cfg: RouterConfig, args: string): string {
  const requested = args.trim().toLowerCase();  // Normalize

  // Empty args: show help/current state
  if (!requested) {
    return ["# Current State", "...", `Usage: /budget <mode>`].join("\n");
  }

  // Validate input
  if (!cfg.modes?.[requested]) {
    return `Unknown mode: "${requested}". Available: ${Object.keys(cfg.modes || {}).join(", ")}`;
  }

  // Process valid input
  saveActiveMode(requested);
  return `Switched to mode: ${requested}`;
}

// ============================================================================
// 4. STATE PERSISTENCE & CACHE INVALIDATION
// ============================================================================

// Lines 66-73 (cache), 227-232 (persistence), 234-248 (save & invalidate)
let _cachedConfig: RouterConfig | null = null;
let _configDirty = true;

function invalidateConfigCache(): void {
  _configDirty = true;
}

function loadConfig(): RouterConfig {
  // Return cached version if valid
  if (_cachedConfig && !_configDirty) {
    return _cachedConfig;
  }
  // Otherwise reload from disk
  const raw = JSON.parse(readFileSync(configPath(), "utf-8"));
  _cachedConfig = validateConfig(raw);
  _configDirty = false;
  return _cachedConfig;
}

function saveActivePreset(presetName: string): void {
  const cfg = loadConfig();
  const resolved = resolvePresetName(cfg, presetName);
  if (!resolved) return;

  cfg.activePreset = resolved;

  // Persist to state file (separate from tiers.json)
  writeState({ activePreset: resolved });

  // Force cache invalidation so next loadConfig() re-reads
  invalidateConfigCache();
}

function writeState(patch: Partial<RouterState>): void {
  const state = { ...readState(), ...patch };
  const p = statePath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

// ============================================================================
// 5. SYSTEM PROMPT INJECTION (every message)
// ============================================================================

// Lines 612-619 in src/index.ts
const systemPromptInjection = {
  "experimental.chat.system.transform": async (_input: any, output: any) => {
    // output.system is a string[] array
    try {
      cfg = loadConfig();  // Uses cache (invalidated by /preset, /budget)
    } catch {
      // Gracefully use last known config on error
    }

    // Build and append system prompt content
    const protocolText = buildDelegationProtocol(cfg);
    output.system.push(protocolText);  // Appends to system prompt
  },
};

// ============================================================================
// 6. USER FEEDBACK FORMAT (Markdown)
// ============================================================================

// Lines 513-521 in src/index.ts
function buildPresetOutput(cfg: RouterConfig, args: string): string {
  if (!args) {
    // Show available options
    const lines = ["# Available Presets\n"];
    for (const [name, tiers] of Object.entries(cfg.presets)) {
      const active = name === cfg.activePreset ? " <- active" : "";
      lines.push(`- **${name}**${active}: ${description}`);
    }
    lines.push(`\nSwitch with: \`/preset <name>\``);
    return lines.join("\n");
  }

  // Switch preset
  const resolved = resolvePresetName(cfg, args);
  if (resolved) {
    saveActivePreset(resolved);
    return [
      `Preset switched to **${resolved}**.`,  // Bold markdown
      "",
      "Selection is now persisted in ~/.config/opencode/opencode-model-router.state.json.",
      "System prompt delegation rules update immediately.",
    ].join("\n");
  }

  return `Unknown preset: "${args}". Available: ${Object.keys(cfg.presets).join(", ")}`;
}

// ============================================================================
// 7. COMPLETE MINIMAL EXAMPLE
// ============================================================================

import type { Plugin, PluginInput } from "@opencode-ai/plugin";

const MinimalPlugin: Plugin = async (_ctx: PluginInput) => {
  let state = { mode: "normal" };

  return {
    // Register command
    config: async (opencodeConfig: any) => {
      opencodeConfig.command ??= {};
      opencodeConfig.command["mycommand"] = {
        template: "$ARGUMENTS",
        description: "My custom command",
      };
    },

    // Handle command
    "command.execute.before": async (input: any, output: any) => {
      if (input.command === "mycommand") {
        const args = (input.arguments ?? "").trim();

        if (!args) {
          output.parts.push({
            type: "text" as const,
            text: `Current mode: ${state.mode}\nUsage: /mycommand <mode>`,
          });
          return;
        }

        if (!["normal", "fast", "slow"].includes(args)) {
          output.parts.push({
            type: "text" as const,
            text: `Unknown mode. Available: normal, fast, slow`,
          });
          return;
        }

        state.mode = args;
        output.parts.push({
          type: "text" as const,
          text: `Mode changed to: **${args}**`,
        });
      }
    },
  };
};

// ============================================================================
// KEY TAKEAWAYS
// ============================================================================
/*
1. REGISTER: opencodeConfig.command["name"] = { template: string, description: string }
   - template: "" (no args) or "$ARGUMENTS" (with args) or multi-line string
   
2. HANDLE: "command.execute.before" hook checks input.command and input.arguments
   - Push responses to output.parts array: { type: "text" as const, text: string }
   - NO return value needed — work with output object directly
   
3. PARSE ARGS: Trim, normalize, validate, provide helpful errors
   
4. PERSIST STATE: Use separate state file, cache config with invalidation
   
5. INJECT SYSTEM: Use "experimental.chat.system.transform" to modify output.system
   
6. USER FEEDBACK: Markdown format (bold **text**, code `text`, bullets -), no tui.showToast
*/
