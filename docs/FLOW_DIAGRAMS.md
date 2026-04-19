# Command Execution Flow Diagrams

## 1. Command Registration & Execution Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ Plugin Initialization                                           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ config hook (lines 539-607)                                     │
│ • opencodeConfig.agent[] = register tier agents                 │
│ • opencodeConfig.command[] = register slash commands            │
│   - "tiers" → template: ""                                      │
│   - "preset" → template: "$ARGUMENTS"                           │
│   - "budget" → template: "$ARGUMENTS"                           │
│   - "annotate-plan" → template: multiline string                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
          ┌───────────────────────────────────────┐
          │ User types: /preset openai             │
          └───────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ command.execute.before hook (lines 624-651)                     │
│                                                                 │
│ Receives:                                                       │
│  input.command = "preset"                                       │
│  input.arguments = "openai"                                     │
│                                                                 │
│ Logic:                                                          │
│  1. Check if input.command === "preset"                         │
│  2. Load config (cached or fresh)                               │
│  3. Call buildPresetOutput(cfg, "openai")                       │
│  4. Push response to output.parts[]                             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ buildPresetOutput() (lines 487-525)                             │
│                                                                 │
│ 1. Trim & validate: "openai" → valid preset ✓                  │
│ 2. resolvePresetName(cfg, "openai") → "openai"                 │
│ 3. saveActivePreset("openai")                                   │
│    └─ writeState({activePreset: "openai"})                      │
│    └─ invalidateConfigCache()                                   │
│ 4. Return confirmation message (Markdown)                       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ output.parts.push({                                             │
│   type: "text" as const,                                        │
│   text: "Preset switched to **openai**.\n..."                   │
│ })                                                              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
          ┌───────────────────────────────────────┐
          │ Response shown to user                 │
          └───────────────────────────────────────┘
```

---

## 2. State Persistence & Cache Invalidation

```
┌─────────────────────────────────────────────────────────────────┐
│ Initial State                                                   │
│                                                                 │
│ _cachedConfig = null                                            │
│ _configDirty = true                                             │
└─────────────────────────────────────────────────────────────────┘
                              │
                    User runs /preset openai
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ loadConfig() (lines 180-208)                                    │
│                                                                 │
│ Check: if (_cachedConfig && !_configDirty)                      │
│   NO → Read tiers.json from disk                                │
│ Merge: state from ~/.config/opencode/opencode-model-router... │
│ Cache: _cachedConfig = cfg; _configDirty = false                │
│ Return: RouterConfig                                            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ saveActivePreset("openai") (lines 234-248)                      │
│                                                                 │
│ Step 1: cfg.activePreset = "openai"                             │
│ Step 2: writeState({activePreset: "openai"})                    │
│         └─ ~/.config/opencode/opencode-model-router.state.json  │
│            {                                                    │
│              "activePreset": "openai",                          │
│              "activeMode": "normal"                             │
│            }                                                    │
│                                                                 │
│ Step 3: invalidateConfigCache()                                 │
│         └─ _configDirty = true                                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Next message arrives                                            │
│                                                                 │
│ experimental.chat.system.transform hook calls loadConfig()      │
│ → Sees _configDirty = true                                      │
│ → Re-reads tiers.json + state file                              │
│ → Loads activePreset = "openai" from state                      │
│ → Updates system prompt with new delegation protocol            │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Argument Parsing Pattern

```
┌─────────────────────────────────────────────────────────────────┐
│ Command Execution with Arguments                                │
│                                                                 │
│ User: /preset openai                                            │
│ OpenCode parses:                                                │
│  • input.command = "preset"                                     │
│  • input.arguments = "openai"                                   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ buildPresetOutput(cfg, "openai")                                │
│                                                                 │
│ const requestedPreset = "openai".trim()  // "openai"            │
│                                                                 │
│ Decision Tree:                                                  │
│                                                                 │
│   if (!requestedPreset) → "openai" is truthy                    │
│     └─ Jump to: switch preset                                   │
│                                                                 │
│   else                                                          │
│     const resolved = resolvePresetName(cfg, "openai")           │
│     ├─ Check cfg.presets["openai"] → ✓ exists                  │
│     └─ return "openai"                                          │
│                                                                 │
│     if (resolved) → "openai" is truthy                          │
│       ├─ saveActivePreset("openai")                             │
│       │  └─ writeState + invalidateConfigCache()                │
│       │                                                         │
│       └─ return "Preset switched to **openai**. ..."            │
│                                                                 │
│     else                                                        │
│       └─ return "Unknown preset..."                             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    Response sent to user
```

---

## 4. System Prompt Injection Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ User sends a message                                            │
│ (e.g., "Help me refactor this code")                            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ OpenCode chat processing:                                       │
│ 1. Build system prompt (starts with core instructions)          │
│ 2. Run experimental.chat.system.transform hook                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ experimental.chat.system.transform (lines 612-619)              │
│                                                                 │
│ async (input: any, output: any) => {                            │
│   try {                                                         │
│     cfg = loadConfig();  // Reload if _configDirty = true       │
│   } catch {                                                     │
│     // Use last known cfg                                       │
│   }                                                             │
│   // Append delegation protocol to system prompt                │
│   output.system.push(buildDelegationProtocol(cfg));             │
│ }                                                               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ buildDelegationProtocol(cfg) (lines 370-404)                    │
│                                                                 │
│ Builds multi-line string:                                       │
│                                                                 │
│ ## Model Delegation Protocol                                    │
│ Preset: anthropic. Tiers: @fast=claude-haiku-4-5(1x) ...       │
│ R: @fast→broader read-only exploration ... @medium→impl ...    │
│ @heavy→arch ...                                                │
│ Multi-phase: prefer explore(@fast)→execute(@medium) when sep... │
│ One-off direct lookups can stay direct when clearly faster;    │
│ gather extra context before @heavy only when needed.           │
│ 1.rule1 2.rule2 3.rule3 ...                                     │
│ Err→retry-alt-tier→fail→direct. Chain: anthropic→openai...      │
│ Delegate with Task(subagent_type="fast|medium|heavy"...)        │
│ Keep orchestration and final synthesis in primary agent.        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ output.system.push(protocolText)                                │
│                                                                 │
│ System prompt now contains:                                     │
│ • Core OpenCode instructions                                    │
│ • Model Delegation Protocol (injected by plugin)                │
│                                                                 │
│ Final system prompt sent to model ↓                             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Model (with updated system prompt) processes user request      │
│                                                                 │
│ Model now knows:                                                │
│ • Which tiers are available (@fast, @medium, @heavy)            │
│ • Which models each tier uses                                   │
│ • Rules for when to use each tier                               │
│ • How to delegate to subagents                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 5. Complete Minimal Command Example

```
┌────────────────────────────────────────────────────────────────┐
│ Plugin Definition                                              │
└────────────────────────────────────────────────────────────────┘

const MyPlugin: Plugin = async (_ctx: PluginInput) => {
  let state = { count: 0 };

  return {
    // ──────────────────────────────────────────────────────────

    config: async (opencodeConfig: any) => {
      opencodeConfig.command ??= {};
      opencodeConfig.command["counter"] = {
        template: "$ARGUMENTS",  // Accept args: /counter increment
        description: "Increment or show counter",
      };
    },

    // ──────────────────────────────────────────────────────────

    "command.execute.before": async (input: any, output: any) => {
      if (input.command === "counter") {
        const args = (input.arguments ?? "").trim();

        // No args: show current
        if (!args) {
          output.parts.push({
            type: "text" as const,
            text: `Counter: ${state.count}`,
          });
          return;
        }

        // "increment" arg: add 1
        if (args === "increment") {
          state.count++;
          output.parts.push({
            type: "text" as const,
            text: `Counter incremented to: **${state.count}**`,
          });
          return;
        }

        // Unknown arg
        output.parts.push({
          type: "text" as const,
          text: `Unknown arg: "${args}". Try: /counter increment`,
        });
      }
    },
  };
};

// ──────────────────────────────────────────────────────────────
// Usage Flow:
// ──────────────────────────────────────────────────────────────

// User: /counter
// ├─ input.command = "counter"
// ├─ input.arguments = null
// ├─ args = ""
// ├─ args check fails, goes to: if (!args) → true
// └─ Output: "Counter: 0"

// User: /counter increment
// ├─ input.command = "counter"
// ├─ input.arguments = "increment"
// ├─ args = "increment"
// ├─ args check fails, goes to: if (args === "increment") → true
// ├─ state.count++ → 1
// └─ Output: "Counter incremented to: **1**"

// User: /counter unknown
// ├─ input.command = "counter"
// ├─ input.arguments = "unknown"
// ├─ args = "unknown"
// ├─ Both if checks fail
// └─ Output: "Unknown arg: "unknown". Try: /counter increment"
```

---

## 6. Output Type System

```
┌─────────────────────────────────────────────────────────────────┐
│ Command Response Output                                         │
└─────────────────────────────────────────────────────────────────┘

output.parts is an array of message parts:

output.parts = [
  {
    type: "text" as const,
    text: "This is the response text"
  },
  // Could add other types in future:
  // { type: "image", url: "..." },
  // { type: "code", language: "ts", code: "..." },
  // etc.
]

Currently only "text" type is used in model-router plugin.

All responses are built as Markdown strings:
• **bold** for emphasis
• `code` for monospace
• # Headings
• - Bullet lists
• Line breaks with empty strings
```

---

## 7. File Organization

```
opencode-model-router/
│
├── tiers.json                    # Config: presets, modes, rules
│   ├── activePreset: "anthropic"
│   ├── presets:
│   │   ├── anthropic: {fast, medium, heavy}
│   │   ├── openai: {fast, medium, heavy}
│   │   └── github-copilot: {fast, medium, heavy}
│   ├── modes:
│   │   ├── normal
│   │   ├── budget
│   │   └── quality
│   └── rules: [...]
│
├── src/
│   └── index.ts                 # Plugin implementation
│       ├── Type definitions (lines 11-55)
│       ├── Config loading (lines 66-178)
│       ├── State persistence (lines 227-259)
│       ├── System prompt builder (lines 370-404)
│       ├── Output builders (lines 410-525)
│       └── Plugin hooks:
│           ├── config (lines 539-607)
│           ├── experimental.chat.system.transform (lines 612-619)
│           └── command.execute.before (lines 624-651)
│
├── ~/.config/opencode/
│   └── opencode-model-router.state.json  # Runtime state
│       ├── activePreset: "openai"  (user selection)
│       └── activeMode: "budget"    (user selection)
```

---

## 8. Decision Tree for Command Arguments

```
Handler receives: input.arguments = "user input" or null

                    ┌──────────────────────────┐
                    │ input.arguments          │
                    └──────────────────────────┘
                            │
                            ▼
                    ┌──────────────────────────┐
                    │ args = input.arguments   │
                    │      ?? ""               │
                    │                          │
                    │ Ensures string type      │
                    └──────────────────────────┘
                            │
                            ▼
                    ┌──────────────────────────┐
                    │ args = args.trim()       │
                    │ .toLowerCase()           │
                    │                          │
                    │ Normalize: remove spaces,│
                    │ standardize case         │
                    └──────────────────────────┘
                            │
                            ▼
                    ┌──────────────────────────┐
                    │ Is args empty?           │
                    │ if (!args)               │
                    └──────────────────────────┘
                        │           │
                      YES           NO
                        │           │
                        ▼           ▼
            ┌─────────────────┐ ┌────────────────┐
            │ Show help/      │ │ Is valid       │
            │ current state   │ │ value?         │
            │                 │ │ if(config[...])│
            │ /preset         │ │                │
            │ /budget         │ │ Yes    │ No    │
            │ (no args)       │ └─┬──────┬───────┘
            └─────────────────┘   │      │
                                  ▼      ▼
                        ┌────────────┐┌────────────┐
                        │ Process    ││ Error msg: │
                        │ Change:    ││ Unknown    │
                        │ • Save     ││ value      │
                        │ • Persist  ││            │
                        │ • Confirm  ││ List valid │
                        │            ││ options    │
                        └────────────┘└────────────┘
```
