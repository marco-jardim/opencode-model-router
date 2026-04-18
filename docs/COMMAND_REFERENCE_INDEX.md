# OpenCode Custom Slash Command Reference Index

## Overview

This folder contains comprehensive documentation on how custom slash commands are registered and handled in OpenCode plugins, extracted from the `opencode-model-router` plugin.

**Source:** `D:\git\opencode-model-router\src\index.ts` (655 lines)

---

## Documentation Files

### 1. **COMMAND_PATTERNS.md** ⭐ START HERE
**Size:** 13 KB  
**Best for:** Understanding the complete patterns with explanations

**Contains:**
- Command registration via `config` hook
- Command handler signature and input/output structure
- Argument handling pattern with real examples
- State management and cache invalidation
- System prompt injection pattern
- User feedback and message formatting
- Configuration file structure
- Complete working example walkthrough
- Summary reference table

**Read this first** to get a complete mental model of how commands work.

---

### 2. **QUICK_REFERENCE.ts** 🚀 COPY-PASTE FRIENDLY
**Size:** 8.4 KB  
**Best for:** Quick lookup and copy-paste templates

**Contains:**
- Command registration template
- Command handler template
- Argument parsing pattern
- State persistence & cache invalidation
- System prompt injection template
- User feedback examples
- Complete minimal working example
- Key takeaways checklist

**Use this** when you need code snippets to copy into your plugin.

---

### 3. **LINE_REFERENCES.md** 🔍 EXACT CITATIONS
**Size:** 16 KB  
**Best for:** Finding exact code locations

**Contains:**
- Line-by-line code blocks with exact line numbers
- Complete function definitions with line ranges
- Argument processing examples with line numbers
- Configuration caching details with line numbers
- State persistence with line numbers
- System prompt injection with line numbers
- Output builders with line numbers
- Type definitions with line numbers
- Summary table with line ranges

**Use this** when you need to verify exact locations or understand specific lines.

---

### 4. **FLOW_DIAGRAMS.md** 📊 VISUAL UNDERSTANDING
**Size:** 27 KB  
**Best for:** Understanding execution flow visually

**Contains:**
- Command registration & execution flow diagram
- State persistence & cache invalidation diagram
- Argument parsing decision tree
- System prompt injection flow
- Complete minimal command example with usage flow
- Output type system explanation
- File organization structure
- Decision tree for command arguments

**Use this** when you want to see how everything connects and flows.

---

### 5. **src/index.ts** 📄 SOURCE CODE
**Size:** 655 lines  
**Location:** `D:\git\opencode-model-router\src\index.ts`

The actual plugin implementation. Contains:
- Lines 1-10: Imports
- Lines 11-61: Type definitions
- Lines 66-208: Config loading with caching
- Lines 214-259: State persistence
- Lines 270-404: System prompt builders
- Lines 410-525: Output format builders (responses)
- Lines 531-653: Plugin definition with hooks

---

## Quick Navigation by Task

### 🎯 I want to...

**Register a new slash command**
1. Read: QUICK_REFERENCE.ts → "COMMAND REGISTRATION" section
2. Reference: COMMAND_PATTERNS.md → "1. Command Registration" section
3. Verify: LINE_REFERENCES.md → "Command Registration Details" (lines 566-606)

**Handle command arguments**
1. Read: QUICK_REFERENCE.ts → "ARGUMENT PARSING PATTERN" section
2. Deep dive: COMMAND_PATTERNS.md → "3. Argument Handling Pattern" section
3. Visualize: FLOW_DIAGRAMS.md → "8. Decision Tree for Command Arguments"

**Persist state across sessions**
1. Read: QUICK_REFERENCE.ts → "STATE PERSISTENCE & CACHE INVALIDATION" section
2. Reference: COMMAND_PATTERNS.md → "4. Configuration Files Reference"
3. Lines: LINE_REFERENCES.md → "Configuration Caching & State Persistence" (lines 66-259)

**Inject content into system prompt**
1. Read: QUICK_REFERENCE.ts → "SYSTEM PROMPT INJECTION" section
2. Deep dive: COMMAND_PATTERNS.md → "5. System Prompt Injection Pattern"
3. Visualize: FLOW_DIAGRAMS.md → "4. System Prompt Injection Flow"

**Format user-facing messages**
1. Read: QUICK_REFERENCE.ts → "USER FEEDBACK FORMAT" section
2. Reference: COMMAND_PATTERNS.md → "6. User Feedback Pattern"
3. Examples: LINE_REFERENCES.md → "/tiers, /budget, /preset outputs" (lines 410-525)

**Create a minimal example**
1. Read: QUICK_REFERENCE.ts → "COMPLETE MINIMAL EXAMPLE" section
2. Visualize: FLOW_DIAGRAMS.md → "5. Complete Minimal Command Example"
3. Adapt: Copy from QUICK_REFERENCE.ts and modify

---

## Key Code Patterns Summary

### Pattern 1: Command Registration
```typescript
// In config hook (lines 566-606)
opencodeConfig.command ??= {};
opencodeConfig.command["mycommand"] = {
  template: "$ARGUMENTS",  // or "" for no args
  description: "Description shown to user",
};
```

### Pattern 2: Command Handler
```typescript
// In command.execute.before hook (lines 624-651)
"command.execute.before": async (input: any, output: any) => {
  if (input.command === "mycommand") {
    const args = input.arguments ?? "";
    output.parts.push({
      type: "text" as const,
      text: buildResponse(args),
    });
  }
}
```

### Pattern 3: State Persistence
```typescript
// Save & invalidate cache
function saveActiveValue(value: string): void {
  cfg.activeValue = value;
  writeState({ activeValue: value });
  invalidateConfigCache();  // Forces reload on next use
}
```

### Pattern 4: System Prompt Injection
```typescript
// Runs on every message
"experimental.chat.system.transform": async (_input, output) => {
  cfg = loadConfig();
  output.system.push(buildDelegationProtocol(cfg));
}
```

### Pattern 5: User Feedback
```typescript
// Markdown formatted responses
return [
  `Command executed: **${result}**`,
  "",
  "Additional details...",
  `Next: \`/command arg\``,
].join("\n");
```

---

## File Dependencies

```
opencode-model-router/
│
├── src/index.ts (655 lines)
│   ├── Exports: ModelRouterPlugin (default)
│   ├── Dependencies: @opencode-ai/plugin
│   ├── Config: tiers.json
│   └── State: ~/.config/opencode/opencode-model-router.state.json
│
├── tiers.json
│   ├── Presets: anthropic, openai, github-copilot
│   ├── Modes: normal, budget, quality
│   └── Read by: src/index.ts loadConfig()
│
├── COMMAND_REFERENCE_INDEX.md (this file)
├── COMMAND_PATTERNS.md (explanations & concepts)
├── QUICK_REFERENCE.ts (code snippets & templates)
├── LINE_REFERENCES.md (exact code locations)
└── FLOW_DIAGRAMS.md (visual flows & diagrams)
```

---

## Common Questions Answered

### Q1: How do I register a command?
**A:** See QUICK_REFERENCE.ts line ~15-25 or COMMAND_PATTERNS.md section 1

### Q2: How do I access arguments passed by the user?
**A:** Use `input.arguments` in the command handler. See COMMAND_PATTERNS.md section 3

### Q3: How do I return a response to the user?
**A:** Push to `output.parts` with `{ type: "text" as const, text: string }`. See QUICK_REFERENCE.ts line ~80

### Q4: How do I persist state between sessions?
**A:** Use `writeState()` to persist to ~/.config/opencode/*.state.json. See COMMAND_PATTERNS.md section 4

### Q5: How do I invalidate my cached config?
**A:** Call `invalidateConfigCache()` after state changes. See QUICK_REFERENCE.ts line ~55

### Q6: Can I inject content into the system prompt?
**A:** Yes, use `experimental.chat.system.transform` hook and append to `output.system`. See COMMAND_PATTERNS.md section 5

### Q7: Should I use `tui.showToast()` for feedback?
**A:** No. Return text responses via `output.parts.push()` instead. The model-router plugin doesn't use `tui.showToast()`.

### Q8: What's the difference between `config` hook and `command.execute.before`?
**A:** `config` runs once at plugin load to register. `command.execute.before` runs every time a command executes. See FLOW_DIAGRAMS.md section 1

### Q9: Why do I need to call `invalidateConfigCache()`?
**A:** Because config is cached for performance. After state changes, you need to mark it as dirty so next read fetches fresh data. See COMMAND_PATTERNS.md section 4

### Q10: Can I have commands without arguments?
**A:** Yes, use `template: ""` instead of `template: "$ARGUMENTS"`. See QUICK_REFERENCE.ts line ~20

---

## Exported Commands in model-router Plugin

The opencode-model-router plugin registers 4 commands:

| Command | Template | Arguments | Handler | Output Builder |
|---------|----------|-----------|---------|-----------------|
| `/tiers` | `""` | None | Line 625-630 | `buildTiersOutput()` (lines 410-437) |
| `/preset` | `$ARGUMENTS` | Preset name | Line 632-640 | `buildPresetOutput()` (lines 487-525) |
| `/budget` | `$ARGUMENTS` | Mode name | Line 642-650 | `buildBudgetOutput()` (lines 443-481) |
| `/annotate-plan` | Multi-line | File path | Not shown | User delegates to agent |

---

## Implementation Checklist

When creating a new command plugin:

- [ ] Define `config` hook to register commands in `opencodeConfig.command`
- [ ] Define `command.execute.before` hook to handle command execution
- [ ] Accept `input.command` and `input.arguments` as parameters
- [ ] Push responses to `output.parts` with `{ type: "text", text: string }`
- [ ] Handle empty arguments (show help/current state)
- [ ] Validate arguments and provide helpful error messages
- [ ] Use `writeState()` for persistence across sessions
- [ ] Call `invalidateConfigCache()` after state changes
- [ ] Use `loadConfig()` to access cached configuration
- [ ] Format responses as Markdown (bold, code, lists, etc.)
- [ ] **Don't** use `tui.showToast()` for feedback
- [ ] Optionally: Use `experimental.chat.system.transform` to inject system prompt

---

## File Reading Order Recommendation

**For first-time learners:**
1. COMMAND_PATTERNS.md (complete overview)
2. QUICK_REFERENCE.ts (practice with templates)
3. FLOW_DIAGRAMS.md (see it in action)
4. src/index.ts (read actual code)

**For implementation:**
1. QUICK_REFERENCE.ts (copy templates)
2. LINE_REFERENCES.md (verify line numbers)
3. src/index.ts (cross-reference)

**For debugging:**
1. FLOW_DIAGRAMS.md (trace execution)
2. LINE_REFERENCES.md (find relevant code)
3. src/index.ts (read implementation details)

**For reference:**
1. QUICK_REFERENCE.ts (quick lookup)
2. COMMAND_REFERENCE_INDEX.md (this file)
3. LINE_REFERENCES.md (find exact code)

---

## Testing Your Command

```bash
# Verify command is registered
/help  # Should show your command in the list

# Test with no arguments
/mycommand

# Test with arguments
/mycommand arg1

# Test argument validation
/mycommand invalid-arg  # Should show error message

# Verify state persistence
# 1. Run /mycommand <something>
# 2. Close and reopen OpenCode
# 3. Verify state persisted to ~/.config/opencode/yourplugin.state.json
```

---

## Version Information

- **Source File:** `D:\git\opencode-model-router\src\index.ts`
- **Total Lines:** 655
- **Commands Documented:** 4 (tiers, preset, budget, annotate-plan)
- **Hooks Used:** 3 (config, command.execute.before, experimental.chat.system.transform)
- **Generated:** March 21, 2025

---

## Support Files

All documentation is self-contained in this folder:
- `.md` files for reading
- `.ts` file for code reference
- Original source: `src/index.ts`

No external dependencies needed for understanding the patterns.

