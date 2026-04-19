# Exact Line References for Custom Command Patterns

**File:** `D:\git\opencode-model-router\src\index.ts`

---

## Command Registration Details

### Location: Lines 566-606 (config hook)

#### Complete Registration Block
```
Line 566:       opencodeConfig.command ??= {};
Line 567-571:   opencodeConfig.command["tiers"] = {
                  template: "",
                  description: "Show model delegation tiers and rules",
                };
Line 572-575:   opencodeConfig.command["preset"] = {
                  template: "$ARGUMENTS",
                  description: "Show or switch model presets (e.g., /preset openai)",
                };
Line 576-579:   opencodeConfig.command["budget"] = {
                  template: "$ARGUMENTS",
                  description: "Show or switch routing mode (e.g., /budget, /budget budget, /budget quality)",
                };
Line 580-606:   opencodeConfig.command["annotate-plan"] = {
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
                    "2. Research/exploration (especially broader lookups) -> `[tier:fast]`; one-off direct lookups are fine when clearly faster",
                    "3. Implementation/code -> `[tier:medium]`",
                    "4. Architecture/security/hard debugging -> `[tier:heavy]`",
                    "5. If a step mixes exploration AND implementation, prefer splitting it into two steps when it improves delegation clarity",
                    "6. Verification (run tests, build) -> `[tier:medium]`",
                    "7. Trivial one-off lookups (single grep/read) can stay direct; use `[tier:fast]` when delegation is still useful",
                    "8. Final review of the complete plan -> `[tier:heavy]`",
                    "",
                    "## Output",
                    "Rewrite the entire plan in the file with the tags. Do not change the substance — only add tags and split mixed steps when clarity improves.",
                  ].join("\n"),
                  description: "Annotate a plan with [tier:fast/medium/heavy] delegation tags",
                };
```

---

## Command Handler Details

### Location: Lines 624-651 (command.execute.before hook)

#### Handler Function Signature
```
Line 624:     "command.execute.before": async (input: any, output: any) => {
```

#### Individual Command Handlers

**tiers command:**
```
Line 625-630:   if (input.command === "tiers") {
                  try {
                    cfg = loadConfig();
                  } catch {}
                  output.parts.push({ type: "text" as const, text: buildTiersOutput(cfg) });
                }
```

**preset command:**
```
Line 632-640:   if (input.command === "preset") {
                  try {
                    cfg = loadConfig();
                  } catch {}
                  output.parts.push({
                    type: "text" as const,
                    text: buildPresetOutput(cfg, input.arguments ?? ""),
                  });
                }
```

**budget command:**
```
Line 642-650:   if (input.command === "budget") {
                  try {
                    cfg = loadConfig();
                  } catch {}
                  output.parts.push({
                    type: "text" as const,
                    text: buildBudgetOutput(cfg, input.arguments ?? ""),
                  });
                }
```

---

## Argument Processing Examples

### /budget Command Argument Handler
**Location:** Lines 443-481 (buildBudgetOutput function)

```
Line 449:   const requested = args.trim().toLowerCase();  // Normalize
Line 452-461: if (!requested) {  // Empty args case
                const lines = ["# Routing Modes\n"];
                for (const [name, mode] of Object.entries(modes)) {
                  const active = name === currentMode ? " <- active" : "";
                  lines.push(`- **${name}**${active}: ${mode.description}...`);
                }
                lines.push(`\nSwitch with: \`/budget <mode>\``);
                return lines.join("\n");
              }
              
Line 464:   if (modes[requested]) {  // Validation
Line 465:     saveActiveMode(requested);  // State change
Line 467:     return [...].join("\n");  // Confirmation
              }
              
Line 480:   return `Unknown mode: "${requested}"...`;  // Error message
```

### /preset Command Argument Handler
**Location:** Lines 487-525 (buildPresetOutput function)

```
Line 488:   const requestedPreset = args.trim();  // Normalize
Line 491-502: if (!requestedPreset) {  // Empty args case
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
              
Line 505:   const resolvedPreset = resolvePresetName(cfg, requestedPreset);  // Validation
Line 506-521: if (resolvedPreset) {  // Success path
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
              
Line 524:   return `Unknown preset: "${requestedPreset}"...`;  // Error message
```

---

## Configuration Caching & State Persistence

### Cache Management
**Location:** Lines 66-73

```
Line 66-67:   let _cachedConfig: RouterConfig | null = null;
              let _configDirty = true;
              
Line 70-72:   function invalidateConfigCache(): void {
                _configDirty = true;
              }
```

### Config Loading with Cache
**Location:** Lines 180-208

```
Line 180-183: function loadConfig(): RouterConfig {
                if (_cachedConfig && !_configDirty) {
                  return _cachedConfig;
                }
Line 185-186:   const raw = JSON.parse(readFileSync(configPath(), "utf-8"));
                const cfg = validateConfig(raw);
Line 188-203:   try {
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
Line 205-208:   _cachedConfig = cfg;
                _configDirty = false;
                return cfg;
              }
```

### State Persistence
**Location:** Lines 227-232

```
Line 227-232: function writeState(patch: Partial<RouterState>): void {
                const state = { ...readState(), ...patch };
                const p = statePath();
                mkdirSync(dirname(p), { recursive: true });
                writeFileSync(p, JSON.stringify(state, null, 2) + "\n", "utf-8");
              }
```

### Save Preset with Cache Invalidation
**Location:** Lines 234-248

```
Line 234-248: function saveActivePreset(presetName: string): void {
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
```

### Save Mode with Cache Invalidation
**Location:** Lines 250-259

```
Line 250-259: function saveActiveMode(modeName: string): void {
                const cfg = loadConfig();
                if (!cfg.modes?.[modeName]) {
                  return;
                }
                
                cfg.activeMode = modeName;
                writeState({ activeMode: modeName });
                invalidateConfigCache();
              }
```

---

## System Prompt Injection Hook

### Location: Lines 612-619

```
Line 612-619: "experimental.chat.system.transform": async (_input: any, output: any) => {
                try {
                  cfg = loadConfig(); // Returns cache unless invalidated
                } catch {
                  // Use last known config if file read fails
                }
                output.system.push(buildDelegationProtocol(cfg));
              },
```

---

## Delegation Protocol Builder

### System Prompt Content Generation
**Location:** Lines 370-404

```
Line 370-404: function buildDelegationProtocol(cfg: RouterConfig): string {
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
                
                const effectiveRules = mode?.overrideRules?.length ? mode.overrideRules : cfg.rules;
                const rulesLine = effectiveRules.map((r, i) => `${i + 1}.${r}`).join(" ");
                
                const fallback = buildFallbackInstructions(cfg);
                
                return [
                  `## Model Delegation Protocol`,
                  `Preset: ${cfg.activePreset}. Tiers: ${tierLine}.${modeSuffix}`,
                  ...(taxonomy ? [taxonomy] : []),
                  ...(decompose ? [decompose] : []),
                  rulesLine,
                  ...(fallback ? [fallback] : []),
                  `Delegate with Task(subagent_type="fast|medium|heavy", prompt="...").`,
                  "Keep orchestration and final synthesis in the primary agent.",
                ].join("\n");
              }
```

---

## Output Builders (User Feedback)

### /tiers Command Output
**Location:** Lines 410-437

```
Line 410-437: function buildTiersOutput(cfg: RouterConfig): string {
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
```

### /budget Command Output
**Location:** Lines 443-481 (see Argument Processing section above)

### /preset Command Output  
**Location:** Lines 487-525 (see Argument Processing section above)

---

## Type Definitions

### RouterConfig Interface
**Location:** Lines 46-55

```
Line 46-55:   interface RouterConfig {
                activePreset: string;
                activeMode?: string;
                presets: Record<string, Preset>;
                rules: string[];
                defaultTier: string;
                fallback?: FallbackConfig;
                taskPatterns?: Record<string, string[]>;
                modes?: Record<string, ModeConfig>;
              }
```

### ModeConfig Interface
**Location:** Lines 40-44

```
Line 40-44:   interface ModeConfig {
                defaultTier: string;
                description: string;
                overrideRules?: string[];
              }
```

### TierConfig Interface
**Location:** Lines 20-31

```
Line 20-31:   interface TierConfig {
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
```

---

## Summary: Critical Line Ranges

| Feature | Lines | Purpose |
|---------|-------|---------|
| Command registration | 566-606 | Register /tiers, /preset, /budget, /annotate-plan |
| Command handler | 624-651 | Handle input.command and output.parts |
| /budget handler | 443-481 | Argument parsing example |
| /preset handler | 487-525 | Full state change example |
| Cache invalidation | 66-73 | Mark config as dirty |
| Load config (cached) | 180-208 | Load with fallback to state file |
| Write state | 227-232 | Persist to .config/opencode |
| Save preset + invalidate | 234-248 | Combined state change pattern |
| System prompt injection | 612-619 | Append to output.system |
| Delegation protocol builder | 370-404 | Build system prompt content |
