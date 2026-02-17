# opencode-model-router

An [OpenCode](https://opencode.ai) plugin that automatically routes tasks to tiered subagents based on complexity. Instead of running everything on your most expensive model, the orchestrator delegates exploration to a fast model, implementation to a balanced model, and architecture/security to the most capable model.

## How it works

The plugin injects a **delegation protocol** into the system prompt that teaches the primary agent to route work:

| Tier | Default (Anthropic) | Cost | Purpose |
|------|---------------------|------|---------|
| `@fast` | Claude Haiku 4.5 | 1x | Exploration, search, file reads, grep |
| `@medium` | Claude Sonnet 4.5 | 5x | Implementation, refactoring, tests, bug fixes |
| `@heavy` | Claude Opus 4.6 | 20x | Architecture, complex debugging, security review |

The agent automatically delegates via the Task tool when it recognizes the task complexity, or when plan steps are annotated with `[tier:fast]`, `[tier:medium]`, or `[tier:heavy]` tags.

This applies both to plan-driven execution and direct ad-hoc requests. For every new user message, the orchestrator performs an intent gate, splits multi-task requests into atomic units, and routes each unit to `@fast`, `@medium`, or `@heavy`.

### Token overhead disclaimer

The injected protocol is compact, but it still adds tokens on every iteration.

- Estimated average injection: ~208 tokens per iteration
- Preset breakdown (default `tiers.json`): `anthropic` ~209, `openai` ~206
- Estimation method: `prompt_characters / 4` (rough heuristic)

Real token usage varies by tokenizer/model and any custom changes you make to `tiers.json`.

## Installation

### Option A: npm package (recommended)

Add the plugin package in your `opencode.json`:

```json
{
  "plugin": [
    "opencode-model-router@latest"
  ]
}
```

If you prefer always getting the latest release, use:

```json
{
  "plugin": [
    "opencode-model-router"
  ]
}
```

### Option B: Local plugin clone

Clone directly into your OpenCode plugins directory:

```bash
cd ~/.config/opencode/plugin
git clone https://github.com/marco-jardim/opencode-model-router.git
```

Then add it to your `opencode.json`:

```json
{
  "plugin": [
    "./plugin/opencode-model-router"
  ]
}
```

### Option C: Reference from anywhere

Clone wherever you want:

```bash
git clone https://github.com/marco-jardim/opencode-model-router.git /path/to/opencode-model-router
```

Then reference the absolute path in `opencode.json`:

```json
{
  "plugin": [
    "/path/to/opencode-model-router"
  ]
}
```

Restart OpenCode after adding the plugin.

## Configuration

All configuration lives in `tiers.json` at the plugin root. Edit it to match your available models and providers.

### Presets

The plugin ships with four presets:

**anthropic** (default):
| Tier | Model | Cost | Notes |
|------|-------|------|-------|
| fast | `anthropic/claude-haiku-4-5` | 1x | Cheapest, fastest |
| medium | `anthropic/claude-sonnet-4-5` | 5x | Extended thinking (variant: max) |
| heavy | `anthropic/claude-opus-4-6` | 20x | Extended thinking (variant: max) |

**openai**:
| Tier | Model | Cost | Notes |
|------|-------|------|-------|
| fast | `openai/gpt-5.3-codex-spark` | 1x | Cheapest, fastest |
| medium | `openai/gpt-5.3-codex` | 5x | Default settings (no variant/reasoning override) |
| heavy | `openai/gpt-5.3-codex` | 20x | Variant: `xhigh` |

**github-copilot**:
| Tier | Model | Cost | Notes |
|------|-------|------|-------|
| fast | `github-copilot/claude-haiku-4-5` | 1x | Cheapest, fastest |
| medium | `github-copilot/claude-sonnet-4-5` | 5x | Balanced coding model |
| heavy | `github-copilot/claude-opus-4-6` | 20x | Variant: `thinking` |

**google**:
| Tier | Model | Cost | Notes |
|------|-------|------|-------|
| fast | `google/gemini-2.5-flash` | 1x | Cheapest, fastest |
| medium | `google/gemini-2.5-pro` | 5x | Balanced coding model |
| heavy | `google/gemini-3-pro-preview` | 20x | Strongest reasoning in default set |

Switch presets with the `/preset` command:

```
/preset openai
```

### Creating custom presets

Add a new preset to the `presets` object in `tiers.json`:

```json
{
  "presets": {
    "my-preset": {
      "fast": {
        "model": "provider/model-name",
        "costRatio": 1,
        "description": "What this tier does",
        "steps": 30,
        "prompt": "System prompt for the subagent",
        "whenToUse": ["Use case 1", "Use case 2"]
      },
      "medium": { "costRatio": 5, "..." : "..." },
      "heavy": { "costRatio": 20, "..." : "..." }
    }
  }
}
```

Each tier supports these fields:

| Field | Type | Description |
|-------|------|-------------|
| `model` | string | Full model ID (`provider/model-name`) |
| `variant` | string | Optional variant (e.g., `"max"` for extended thinking) |
| `costRatio` | number | Relative cost multiplier (e.g., 1 for cheapest, 20 for most expensive). Injected into the system prompt so the agent considers cost when delegating. |
| `thinking` | object | Anthropic thinking config: `{ "budgetTokens": 10000 }` |
| `reasoning` | object | OpenAI reasoning config: `{ "effort": "high", "summary": "detailed" }` |
| `description` | string | Human-readable description shown in `/tiers` |
| `steps` | number | Max agent turns (default: varies by tier) |
| `prompt` | string | System prompt for the subagent |
| `color` | string | Optional display color |
| `whenToUse` | string[] | List of use cases (shown in delegation protocol) |

### Routing modes

The plugin supports three routing modes that control how aggressively the agent delegates to cheaper tiers. Switch modes with the `/budget` command:

| Mode | Default Tier | Behavior |
|------|-------------|----------|
| `normal` | `@medium` | Balanced quality and cost — delegates based on task complexity |
| `budget` | `@fast` | Aggressive cost savings — defaults to cheapest tier, escalates only when needed |
| `quality` | `@medium` | Quality-first — uses stronger models more liberally for better results |

When a mode has `overrideRules`, those replace the global `rules` array in the system prompt. This lets each mode have fundamentally different delegation behavior.

Configure modes in `tiers.json`:

```json
{
  "modes": {
    "normal": {
      "defaultTier": "medium",
      "description": "Balanced quality and cost"
    },
    "budget": {
      "defaultTier": "fast",
      "description": "Aggressive cost savings",
      "overrideRules": [
        "Default ALL tasks to @fast unless they clearly require code edits",
        "Use @medium ONLY for: multi-file edits, complex refactors, test suites",
        "Use @heavy ONLY when explicitly requested or after 2+ failed @medium attempts"
      ]
    },
    "quality": {
      "defaultTier": "medium",
      "description": "Quality-first",
      "overrideRules": [
        "Default to @medium for all tasks including exploration",
        "Use @heavy for architecture, debugging, security, or multi-file coordination",
        "Use @fast only for trivial single-tool operations"
      ]
    }
  }
}
```

The active mode is persisted in `~/.config/opencode/opencode-model-router.state.json` and survives restarts.

### Task taxonomy

The `taskPatterns` object maps common coding task descriptions to tiers. This is injected into the system prompt as a routing guide so the agent can quickly look up which tier to use:

```json
{
  "taskPatterns": {
    "fast": [
      "Find, search, locate, or grep files and code patterns",
      "Read or display specific files or sections",
      "Check git status, log, diff, or blame"
    ],
    "medium": [
      "Implement a new feature, function, or component",
      "Refactor or restructure existing code",
      "Write or update tests",
      "Fix a bug (first or second attempt)"
    ],
    "heavy": [
      "Design system or module architecture from scratch",
      "Debug a problem after 2+ failed attempts",
      "Security audit or vulnerability review"
    ]
  }
}
```

Customize these patterns to match your workflow. The agent uses them as heuristics, not hard rules.

### Cost ratios

Each tier's `costRatio` is injected into the system prompt so the agent is aware of relative costs:

```
Cost ratios: @fast=1x, @medium=5x, @heavy=20x.
Always use the cheapest tier that can reliably handle the task.
```

Adjust `costRatio` values in each tier to reflect your actual provider pricing. The ratios don't need to be exact — they're directional signals for the agent.

### Rules

The `rules` array in `tiers.json` controls when delegation happens. These are injected into the system prompt verbatim:

```json
{
  "rules": [
    "When a plan step contains [tier:fast], [tier:medium], or [tier:heavy], delegate to that agent",
    "Default to @medium for implementation tasks you could delegate",
    "Use @fast for any read-only exploration or research task",
    "Keep orchestration (planning, decisions, verification) for yourself -- delegate execution",
    "For trivial tasks (single grep, single file read), execute directly without delegation",
    "Never delegate to @heavy if you are already running on an opus-class model -- do it yourself",
    "If a task takes 1-2 tool calls, execute directly -- delegation overhead is not worth the cost",
    "Consult the task routing guide below to match task type to the correct tier",
    "Consider cost ratios when choosing tiers -- always use the cheapest tier that can reliably handle the task"
  ]
}
```

When a routing mode has `overrideRules`, those replace this array entirely for that mode.

### Fallback

The `fallback` section defines which presets to try when a provider fails:

```json
{
  "fallback": {
    "global": {
      "anthropic": ["openai", "google", "github-copilot"],
      "openai": ["anthropic", "google", "github-copilot"]
    }
  }
}
```

When a delegated task fails with a provider/model/rate-limit error, the agent is instructed to retry with the next preset in the fallback chain.

## Commands

| Command | Description |
|---------|-------------|
| `/tiers` | Show active tier configuration and delegation rules |
| `/preset` | List available presets |
| `/preset <name>` | Switch to a different preset |
| `/budget` | Show available routing modes and which is active |
| `/budget <mode>` | Switch routing mode (`normal`, `budget`, or `quality`) |
| `/annotate-plan [path]` | Annotate a plan file with `[tier:X]` tags for each step |

## Plan annotation

The `/annotate-plan` command reads a plan file (defaults to `PLAN.md`) and adds tier tags to each step based on complexity:

**Before:**
```markdown
## Steps
1. Search the codebase for all authentication handlers
2. Implement the new OAuth2 flow
3. Review the auth architecture for security vulnerabilities
```

**After:**
```markdown
## Steps
1. [tier:fast] Search the codebase for all authentication handlers
2. [tier:medium] Implement the new OAuth2 flow
3. [tier:heavy] Review the auth architecture for security vulnerabilities
```

When the agent executes an annotated plan, it delegates each step to the appropriate subagent automatically.

## Provider setup

The models referenced in your preset must be configured in your `opencode.json` providers. For example, to use the default `anthropic` preset:

```json
{
  "provider": {
    "anthropic": {
      "models": {
        "claude-haiku-4-5": {},
        "claude-sonnet-4-5": {},
        "claude-opus-4-6": { "thinking": true }
      }
    }
  }
}
```

## How delegation looks in practice

```
You: Implement the user settings page based on PLAN.md

Agent (Opus): I'll execute the plan. Step 1 is tagged [tier:fast] -- delegating exploration.
  -> Task(@fast): "Find all existing settings-related components and their patterns"
  <- @fast returns: Found SettingsLayout at src/components/..., uses React Hook Form...

Agent (Opus): Step 2 is [tier:medium] -- delegating implementation.
  -> Task(@medium): "Implement UserSettingsForm component following the patterns from..."
  <- @medium returns: Created src/components/UserSettingsForm.tsx, added tests...

Agent (Opus): Step 3 is [tier:heavy] -- this is an architecture review and I'm already on Opus, so I'll handle it myself.
  [Reviews the implementation directly]
```

## Requirements

- OpenCode v1.0+ with plugin support
- Models configured in your `opencode.json` providers matching your preset

## License

[GPL-3.0](LICENSE)
