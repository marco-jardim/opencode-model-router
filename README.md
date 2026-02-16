# opencode-model-router

An [OpenCode](https://opencode.ai) plugin that automatically routes tasks to tiered subagents based on complexity. Instead of running everything on your most expensive model, the orchestrator delegates exploration to a fast model, implementation to a balanced model, and architecture/security to the most capable model.

## How it works

The plugin injects a **delegation protocol** into the system prompt that teaches the primary agent to route work:

| Tier | Default (Anthropic) | Purpose |
|------|---------------------|---------|
| `@fast` | Claude Haiku 4.5 | Exploration, search, file reads, grep |
| `@medium` | Claude Sonnet 4.5 | Implementation, refactoring, tests, bug fixes |
| `@heavy` | Claude Opus 4.6 | Architecture, complex debugging, security review |

The agent automatically delegates via the Task tool when it recognizes the task complexity, or when plan steps are annotated with `[tier:fast]`, `[tier:medium]`, or `[tier:heavy]` tags.

This applies both to plan-driven execution and direct ad-hoc requests. For every new user message, the orchestrator performs an intent gate, splits multi-task requests into atomic units, and routes each unit to `@fast`, `@medium`, or `@heavy`.

## Installation

### Option A: npm package (recommended)

Add the plugin package in your `opencode.json`:

```json
{
  "plugin": [
    "opencode-model-router@1.0.0"
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

The plugin ships with two presets:

**anthropic** (default):
| Tier | Model | Notes |
|------|-------|-------|
| fast | `anthropic/claude-haiku-4-5` | Cheapest, fastest |
| medium | `anthropic/claude-sonnet-4-5` | Extended thinking (variant: max) |
| heavy | `anthropic/claude-opus-4-6` | Extended thinking (variant: max) |

**openai**:
| Tier | Model | Notes |
|------|-------|-------|
| fast | `openai/gpt-5.3-codex-spark` | Cheapest, fastest |
| medium | `openai/gpt-5.3-codex` | Default settings (no variant/reasoning override) |
| heavy | `openai/gpt-5.3-codex` | Variant: `xhigh` |

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
        "description": "What this tier does",
        "steps": 30,
        "prompt": "System prompt for the subagent",
        "whenToUse": ["Use case 1", "Use case 2"]
      },
      "medium": { ... },
      "heavy": { ... }
    }
  }
}
```

Each tier supports these fields:

| Field | Type | Description |
|-------|------|-------------|
| `model` | string | Full model ID (`provider/model-name`) |
| `variant` | string | Optional variant (e.g., `"max"` for extended thinking) |
| `thinking` | object | Anthropic thinking config: `{ "budgetTokens": 10000 }` |
| `reasoning` | object | OpenAI reasoning config: `{ "effort": "high", "summary": "detailed" }` |
| `description` | string | Human-readable description shown in `/tiers` |
| `steps` | number | Max agent turns (default: varies by tier) |
| `prompt` | string | System prompt for the subagent |
| `color` | string | Optional display color |
| `whenToUse` | string[] | List of use cases (shown in delegation protocol) |

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
    "Never delegate to @heavy if you are already running on an opus-class model -- do it yourself"
  ]
}
```

## Commands

| Command | Description |
|---------|-------------|
| `/tiers` | Show active tier configuration and delegation rules |
| `/preset` | List available presets |
| `/preset <name>` | Switch to a different preset |
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
