# Custom Slash Command Patterns in OpenCode Plugins

## Source File Location
**File:** `D:\git\opencode-model-router\src\index.ts`

---

## 1. Command Registration via `config` Hook

### Pattern: Modifying `opencodeConfig.command`

**File:** `src/index.ts`  
**Lines:** 566-606

```typescript
config: async (opencodeConfig: any) => {
  // ... agent registration ...

  // Register commands by adding to opencodeConfig.command object
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
      // ... multi-line template as array ...
    ].join("\n"),
    description: "Annotate a plan with [tier:fast/medium/heavy] delegation tags",
  };
}
```

### Command Configuration Object Structure

| Field | Type | Purpose |
|-------|------|---------|
| `template` | `string` \| `string[]` | Command template. Can be empty (`""`) or contain `$ARGUMENTS` placeholder |
| `description` | `string` | Help text shown to user |

---

## 2. Command Handler Signature

### Pattern: The `command.execute.before` Hook

**File:** `src/index.ts`  
**Lines:** 624-651

```typescript
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
}
```

### Handler Input Parameter Structure

| Property | Type | Content |
|----------|------|---------|
| `input.command` | `string` | Command name (without `/`) |
| `input.arguments` | `string \| null` | Raw argument string passed after command |

### Handler Output Parameter Structure

The handler writes to `output.parts`, which is an array of message parts:

```typescript
output.parts.push({
  type: "text" as const,  // Content type
  text: string            // The actual message content
});
```

### Important Handler Patterns

1. **Check command name**: Use `if (input.command === "commandName")`
2. **Retrieve raw arguments**: Access via `input.arguments ?? ""`
3. **Output text response**: Push object with `{ type: "text" as const, text: ... }` to `output.parts`
4. **No return value needed** — side effects are written to `output` object

---

## 3. Argument Handling Pattern

### Pattern: Parsing Arguments in Command Handlers

**File:** `src/index.ts`  
**Lines:** 443-481 (buildBudgetOutput example)

```typescript
function buildBudgetOutput(cfg: RouterConfig, args: string): string {
  const modes = cfg.modes;
  if (!modes || Object.keys(modes).length === 0) {
    return 'No modes configured...';
  }

  const requested = args.trim().toLowerCase();  // Normalize input
  const currentMode = cfg.activeMode || "normal";

  // No args: show current state and help
  if (!requested) {
    const lines = ["# Routing Modes\n"];
    for (const [name, mode] of Object.entries(modes)) {
      const active = name === currentMode ? " <- active" : "";
      lines.push(`- **${name}**${active}: ${mode.description}...`);
    }
    lines.push(`\nSwitch with: \`/budget <mode>\``);
    return lines.join("\n");
  }

  // Switch mode
  if (modes[requested]) {
    saveActiveMode(requested);
    const mode = modes[requested];
    return [...].join("\n");  // Return confirmation message
  }

  return `Unknown mode: "${requested}". Available: ${Object.keys(modes).join(", ")}`;
}
```

### Argument Processing Checklist

- [ ] Trim and normalize input: `args.trim().toLowerCase()`
- [ ] Handle empty args case (show help/current state)
- [ ] Validate input against allowed values
- [ ] Return helpful error messages if validation fails
- [ ] Return success/confirmation messages for state changes

---

## 4. Hook Lifecycle and Caching Pattern

### Pattern: State Management with Cache Invalidation

**File:** `src/index.ts`  
**Lines:** 66-73, 234-259, 612-619

```typescript
// Global config cache
let _cachedConfig: RouterConfig | null = null;
let _configDirty = true;

/** Mark config cache as stale so it is re-read on next access. */
function invalidateConfigCache(): void {
  _configDirty = true;
}

// Save state and invalidate cache
function saveActivePreset(presetName: string): void {
  const cfg = loadConfig();
  const resolved = resolvePresetName(cfg, presetName);
  if (!resolved) {
    return;
  }
  cfg.activePreset = resolved;
  writeState({ activePreset: resolved });
  invalidateConfigCache();  // Force reload next time
}

// In command handler, reload config if cache is dirty
"command.execute.before": async (input: any, output: any) => {
  if (input.command === "preset") {
    try {
      cfg = loadConfig();  // Returns cache unless invalidated
    } catch {}
    output.parts.push({ ... });
  }
}

// In system prompt injection hook, also reload
"experimental.chat.system.transform": async (_input: any, output: any) => {
  try {
    cfg = loadConfig(); // Returns cache unless invalidated
  } catch {
    // Use last known config if file read fails
  }
  output.system.push(buildDelegationProtocol(cfg));
}
```

---

## 5. System Prompt Injection Pattern

### Pattern: Using `experimental.chat.system.transform` Hook

**File:** `src/index.ts`  
**Lines:** 612-619

```typescript
"experimental.chat.system.transform": async (_input: any, output: any) => {
  try {
    cfg = loadConfig(); // Returns cache unless invalidated
  } catch {
    // Use last known config if file read fails
  }
  output.system.push(buildDelegationProtocol(cfg));
}
```

This hook:
- **Runs on every message** to inject custom system prompt content
- **Accesses `output.system`** array to append instructions
- **Gracefully handles errors** and falls back to last known config
- **Works with cached config** to avoid repeated disk I/O

### Output System Prompt Content Example

The injected content is built dynamically (lines 370-404):

```
## Model Delegation Protocol
Preset: anthropic. Tiers: @fast=claude-haiku-4-5(1x) @medium=claude-sonnet-4-6/max(5x) @heavy=claude-opus-4-6/max(20x). mode:normal
R: @fast→search/grep/read/git-info/ls/lookup-docs/types/count/exists-check/rename @medium→impl-feature/refactor/write-tests/bugfix(≤2)/edit-logic/code-review/build-fix/create-file/db-migrate/api-endpoint/config-update @heavy→arch-design/debug(≥3fail)/sec-audit/perf-opt/migrate-strategy/multi-system-integration/tradeoff-analysis/rca
Multi-phase: split explore(@fast)→execute(@medium). Cheapest-first.
1.priority rules 2.more rules ...
Err→retry-alt-tier→fail→direct. Chain: anthropic→openai→github-copilot
Delegate with Task(subagent_type="fast|medium|heavy", prompt="...").
Keep orchestration and final synthesis in the primary agent.
```

---

## 6. User Feedback Pattern

### Pattern: Message Formatting and Confirmation

**File:** `src/index.ts`  
**Lines:** 513-521 (preset confirmation), 467-477 (budget confirmation)

```typescript
// Preset switch confirmation
return [
  `Preset switched to **${resolvedPreset}**.`,  // Bold markdown
  "",
  models,  // Multi-line content
  "",
  "Selection is now persisted in ~/.config/opencode/opencode-model-router.state.json.",
  "Restart OpenCode for subagent model registration to take effect.",
  "System prompt delegation rules update immediately.",
].join("\n");

// Budget mode switch confirmation
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
```

### Key Patterns

1. **Markdown formatting**: Use `**bold**`, `` `code` ``, bullet lists (`-`)
2. **Multi-line messages**: Build as array, join with `"\n"`
3. **Confirmation messages**: Clearly state what changed
4. **Side effects disclosure**: Tell user when persistence/restart is needed
5. **Help text**: Always show usage hints (e.g., `\nSwitch with: \`/preset <name>\``)

### No `tui.showToast` Usage

The model-router plugin **does not use `tui.showToast()`**. All feedback is returned as text parts in the command output.

---

## 7. Configuration Files Reference

### tiers.json Structure

**File:** `tiers.json`  
**Lines:** 1-100+

```json
{
  "activePreset": "anthropic",
  "activeMode": "normal",
  "presets": {
    "anthropic": {
      "fast": {
        "model": "anthropic/claude-haiku-4-5",
        "costRatio": 1,
        "description": "Haiku 4.5 for exploration, search, and simple reads",
        "steps": 30,
        "prompt": "You are a fast exploration agent...",
        "whenToUse": [...]
      },
      "medium": {...},
      "heavy": {...}
    },
    "openai": {...},
    "github-copilot": {...}
  },
  "rules": [...],
  "defaultTier": "medium",
  "modes": {
    "normal": {...},
    "budget": {...},
    "quality": {...}
  }
}
```

---

## 8. Complete Command Registration Flow Example

### Full Working Example: /preset Command

```typescript
// 1. REGISTER COMMAND (in config hook)
opencodeConfig.command["preset"] = {
  template: "$ARGUMENTS",
  description: "Show or switch model presets (e.g., /preset openai)",
};

// 2. HANDLE COMMAND (in command.execute.before hook)
"command.execute.before": async (input: any, output: any) => {
  if (input.command === "preset") {
    try {
      cfg = loadConfig();
    } catch {}
    output.parts.push({
      type: "text" as const,
      text: buildPresetOutput(cfg, input.arguments ?? ""),
    });
  }
}

// 3. BUILD RESPONSE
function buildPresetOutput(cfg: RouterConfig, args: string): string {
  const requestedPreset = args.trim();
  
  // Show available presets if no args
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
    saveActivePreset(resolvedPreset);  // Persists state
    cfg.activePreset = resolvedPreset;
    // ... return confirmation ...
  }
  
  return `Unknown preset: "${requestedPreset}"...`;
}

// 4. STATE PERSISTENCE
function saveActivePreset(presetName: string): void {
  const cfg = loadConfig();
  const resolved = resolvePresetName(cfg, presetName);
  if (!resolved) return;
  
  cfg.activePreset = resolved;
  writeState({ activePreset: resolved });      // Write to disk
  invalidateConfigCache();                      // Mark cache as dirty
}
```

---

## Summary Reference Table

| Aspect | Location | Key Details |
|--------|----------|------------|
| **Command Registration** | `config` hook, lines 566-606 | Add to `opencodeConfig.command` object |
| **Command Handler** | `command.execute.before` hook, lines 624-651 | Check `input.command`, access `input.arguments`, write to `output.parts` |
| **Template Syntax** | Command config | `""` for no args, `"$ARGUMENTS"` for args |
| **Output Format** | `output.parts.push()` | `{ type: "text" as const, text: string }` |
| **State Persistence** | `writeState()`, lines 227-232 | Writes to `~/.config/opencode/opencode-model-router.state.json` |
| **Config Caching** | Lines 66-73, 180-208 | Use `invalidateConfigCache()` after state changes |
| **System Prompt Injection** | `experimental.chat.system.transform` hook, lines 612-619 | Append to `output.system` array |
| **User Feedback** | Helper functions, lines 410-525 | Markdown formatted strings, no `tui.showToast()` |

