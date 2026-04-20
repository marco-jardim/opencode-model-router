# opencode-model-router

> **Use the cheapest model that can do the job. Automatically.**

An [OpenCode](https://opencode.ai) plugin that routes every coding task to the right-priced AI tier — automatically, on every message, with ~210 tokens of overhead.

## Why it's different

Most AI coding tools give you one model for everything. You pay Opus prices to run `grep`. opencode-model-router changes that with a stack of interlocking ideas:

**Use a mid-tier model as orchestrator.**
The orchestrator runs on *every* message. Put Sonnet there, not Opus. Sonnet reads a routing protocol and delegates just as well as Opus — at 4x lower cost. Reserve Opus for when it genuinely matters.

**Inject a compressed, LLM-optimized routing protocol.**
Instead of verbose instructions, the plugin injects ~210 tokens of dense, machine-readable notation the orchestrator understands perfectly. Same routing intelligence as 870 tokens of prose — 75% smaller. Every message, every session.

**Match task to tier using a configurable taxonomy.**
A keyword routing guide (`@fast→search/grep/read`, `@medium→impl/refactor/test`, `@heavy→arch/debug/security`) tells the orchestrator exactly which tier fits each task type. Fully customizable. No ambiguity.

**Split separable composite tasks: explore cheap, execute smart.**
"Find how auth works and refactor it" shouldn't cost @medium for the whole thing. The multi-phase guidance prefers a split when phases are separable: @fast reads the files (1x cost), @medium does the rewrite (5x cost). ~36% savings on composite tasks, which are ~65% of real coding sessions.

**Skip delegation overhead for trivial work.**
Single grep? One file read (or a quick follow-up)? The orchestrator can execute directly — zero delegation cost, zero latency.

**Four routing modes for different budgets.**
`/budget normal` (balanced), `/budget budget` (aggressive savings, defaults everything to @fast), `/budget quality` (liberal use of stronger models), `/budget deep` (heavy-first for long architecture/debug runs). Mode persists across restarts.

**Cost ratios in the prompt.**
Every tier carries its `costRatio` (fast=1x, medium=5x, heavy=20x) injected into the system prompt. The orchestrator sees the price before deciding. It picks the cheapest tier that can reliably handle the task.

**Orchestrator-awareness.**
If the orchestrator is already running on Opus, the rule `self∈opus→never→@heavy` fires — it does the heavy work itself rather than delegating to another Opus instance.

**Multi-provider support with automatic fallback.**
Four presets out of the box: Anthropic, OpenAI, GitHub Copilot, Google. Switch with `/preset`. If a provider fails, the fallback chain tries the next one automatically.

**Plan annotation for long tasks.**
`/annotate-plan` reads a markdown plan and tags each step with `[tier:fast]`, `[tier:medium]`, or `[tier:heavy]` — removing all routing ambiguity from multi-step workflows.

**Fully configurable.**
Tiers, models, cost ratios, rules, task patterns, routing modes, fallback chains — all in `tiers.json`. No code changes needed.

## The problem

Vibe coding is expensive because most AI coding tools default to one model for everything. That model is usually the most capable available — and you pay for that capability even when the task is `grep for a function name`.

A typical coding session breaks down roughly like this:

| Task type | % of session | Example |
|-----------|-------------|---------|
| Exploration / search | ~40% | Find where X is defined, read a file, check git log |
| Implementation | ~45% | Write a function, fix a bug, add a test |
| Architecture / deep debug | ~15% | Design a new module, debug after 2+ failures |

If you're running Opus (20x cost) for all of it, you're overpaying by **3-10x** on most tasks.

## The solution

opencode-model-router injects a **delegation protocol** into the system prompt that teaches the orchestrator to:

1. **Match task to tier** using a configurable task taxonomy
2. **Split composite tasks** — explore first with a cheap model, then implement with a mid-tier model
3. **Skip delegation overhead** for trivial tasks (1-2 tool calls)
4. **Never over-qualify** — use the cheapest tier that can reliably handle the task
5. **Fallback** across providers when one fails

All of this adds ~210 tokens of system prompt overhead per message.

## Cost simulation

**Scenario: 50-message coding session with 30 delegated tasks**

Task distribution: 18 exploration (60%), 10 implementation (33%), 2 architecture (7%)

### Without model router (all-Opus)

| Task | Count | Tier | Cost ratio | Total |
|------|-------|------|-----------|-------|
| Exploration | 18 | Opus | 20x | 360x |
| Implementation | 10 | Opus | 20x | 200x |
| Architecture | 2 | Opus | 20x | 40x |
| **Total** | **30** | | | **600x** |

### With model router (normal mode, Sonnet orchestrator)

| Task | Count | Tier | Cost ratio | Total |
|------|-------|------|-----------|-------|
| Exploration (delegated) | 10 | @fast | 1x | 10x |
| Exploration (direct, trivial) | 8 | self | 0x | 0x |
| Implementation | 10 | @medium | 5x | 50x |
| Architecture | 2 | @heavy | 20x | 40x |
| **Total** | **30** | | | **100x** |

### With model router (budget mode, Sonnet orchestrator)

| Task | Count | Tier | Cost ratio | Total |
|------|-------|------|-----------|-------|
| Exploration | 18 | @fast | 1x | 18x |
| Implementation (simple) | 7 | @fast | 1x | 7x |
| Implementation (complex) | 3 | @medium | 5x | 15x |
| Architecture | 2 | @medium | 5x | 10x |
| **Total** | **30** | | | **50x** |

### Summary

| Setup | Session cost | vs all-Opus |
|-------|-------------|-------------|
| All-Opus (no router) | 600x | baseline |
| Sonnet orchestrator + router (normal) | 100x | **−83%** |
| Sonnet orchestrator + router (budget) | 50x | **−92%** |

> Cost ratios are relative units. Actual savings depend on your provider pricing and model selection.

## How it works

On every message, the plugin injects ~210 tokens into the system prompt. The notation is intentionally dense and compressed — it's **optimized for LLM comprehension, not human readability**. An agent reads it as a precise routing grammar; a human might squint at it. That's by design: verbose prose would cost 4x more tokens per message with no routing benefit.

What the orchestrator sees (Anthropic preset, normal mode):

```
## Model Delegation Protocol
Preset: anthropic. Tiers: @fast=claude-haiku-4-5(1x) @medium=claude-sonnet-4-5/max(5x) @heavy=claude-opus-4-6/max(20x). mode:normal
R: @fast→search/grep/read/git-info/ls/lookup-docs/types/count/exists-check/rename @medium→impl-feature/refactor/write-tests/bugfix(≤2)/edit-logic/code-review/build-fix/create-file/db-migrate/api-endpoint/config-update @heavy→arch-design/debug(≥3fail)/sec-audit/perf-opt/migrate-strategy/multi-system-integration/tradeoff-analysis/rca
Multi-phase: prefer explore(@fast)→execute(@medium) when phases are separable. Cheapest-first when practical.
1.[tier:X] tag in plan→delegate X 2.plan:fast/cheap→@fast | plan:medium→@medium | plan:heavy→@heavy 3.default preference: read-only→@fast | implementation→@medium 4.orchestrate=self,execute=subagent 5.trivial(≤1 tool call,no expected follow-up)→direct,skip-delegate 6.before @heavy: gather context first(usually via @fast); if already sufficient, dispatch directly 7.if self is opus: skip-@heavy(do locally), still route broader read-only exploration to @fast 8.min(cost,adequate-tier)
Err→retry-alt-tier→fail→direct. Chain: anthropic→openai→google→github-copilot
Delegate with Task(subagent_type="fast|medium|heavy", prompt="...").
Keep orchestration and final synthesis in the primary agent.
```

**What each line means (for humans):**

| Line | What it encodes |
|------|----------------|
| `Tiers: @fast=...(1x) @medium=...(5x) @heavy=...(20x)` | Model + cost ratio per tier, all in one compact token |
| `R: @fast→search/grep/... @medium→impl/...` | Full task taxonomy — keyword triggers for each tier |
| `Multi-phase: prefer explore(@fast)→execute(@medium) when phases are separable` | Preferred decomposition for separable composite tasks |
| `1.[tier:X]→... 5.trivial(≤1 tool call)... 6.before @heavy: gather context...` | Numbered routing rules in abbreviated form |
| `Err→retry-alt-tier→fail→direct. Chain: anthropic→...` | Fallback strategy in one line |

The orchestrator reads this once per message and applies it to every tool call and delegation decision in that turn.

### Multi-phase decomposition (key differentiator)

The most impactful optimization. A composite task like:

> "Find how the auth middleware works and refactor it to use JWT."

Without router → routed entirely to `@medium` (5x for all ~8K tokens)

With router → split:
- **@fast (1x)**: grep, read 4-5 files, trace call chain (~4K tokens)
- **@medium (5x)**: rewrite auth module (~4K tokens)

**Result: ~36% cost reduction on composite tasks**, which represent ~60-70% of real coding work.

## Why not just use another orchestrator?

| Feature | model-router | Claude native | oh-my-opencode | GSD | ralph-loop |
|---------|:---:|:---:|:---:|:---:|:---:|
| Multi-tier cost routing | ✅ | ❌ | ❌ | ❌ | ❌ |
| Configurable task taxonomy | ✅ | ❌ | ❌ | ❌ | ❌ |
| Budget / quality modes | ✅ | ❌ | ❌ | ❌ | ❌ |
| Multi-phase decomposition | ✅ | ❌ | ❌ | ❌ | ❌ |
| Cross-provider fallback | ✅ | ❌ | ❌ | ❌ | ❌ |
| Cost ratio awareness | ✅ | ❌ | ❌ | ❌ | ❌ |
| Plan annotation with tiers | ✅ | ❌ | ❌ | ❌ | ❌ |
| ~210 token overhead | ✅ | — | ❌ | ❌ | ❌ |

**Claude native**: single model for everything, no cost routing. If you're using claude.ai or OpenCode without plugins, you're paying the same price for `grep` as for architecture design.

**oh-my-opencode**: focused on workflow personality and prompt style, not cost optimization. No tier routing, no task taxonomy.

**GSD (Get Shit Done)**: prioritizes execution speed and low deliberation overhead. Excellent at pushing through tasks fast, but uses one model — no cost differentiation between search and architecture.

**ralph-loop**: iterative feedback-loop orchestrator. Excellent at self-correction and quality verification. No tier routing — every loop iteration runs on the same model regardless of task complexity.

**The core difference**: the others optimize for *how* the agent works (style, speed, quality loops). model-router optimizes for *what it costs* — with zero compromise on quality, because you can always put Opus in the heavy tier.

## Recommended setup

**Orchestrator**: use `claude-sonnet-4-5` (or equivalent mid-tier) as your primary/default model. Not Opus.

Why: the orchestrator runs on every message, including trivial ones. Sonnet can read the delegation protocol and make routing decisions just as well as Opus. You reserve Opus for when it's genuinely needed — via `@heavy` delegation.

In your `opencode.json`:
```json
{
  "model": "anthropic/claude-sonnet-4-5",
  "autoshare": false
}
```

Then install and configure model-router to handle the rest.

## Installation

### From npm (recommended)
```bash
# In your opencode project or globally
npm install -g opencode-model-router
```

Add to `~/.config/opencode/opencode.json`:
```json
{
  "plugin": {
    "opencode-model-router": {
      "type": "npm",
      "package": "opencode-model-router"
    }
  }
}
```

### Local clone
```bash
git clone https://github.com/your-username/opencode-model-router
cd opencode-model-router
npm install
```

In `~/.config/opencode/opencode.json`:
```json
{
  "plugin": {
    "opencode-model-router": {
      "type": "local",
      "path": "/absolute/path/to/opencode-model-router"
    }
  }
}
```

## Configuration

All configuration lives in `tiers.json` at the plugin root.

### Presets

The plugin ships with four presets (switch with `/preset <name>`):

**anthropic** (default):
| Tier | Model | Cost ratio |
|------|-------|-----------|
| @fast | `anthropic/claude-haiku-4-5` | 1x |
| @medium | `anthropic/claude-sonnet-4-5` (max) | 5x |
| @heavy | `anthropic/claude-opus-4-6` (max) | 20x |

**openai**:
| Tier | Model | Cost ratio |
|------|-------|-----------|
| @fast | `openai/gpt-5.3-codex-spark` | 1x |
| @medium | `openai/gpt-5.3-codex` | 5x |
| @heavy | `openai/gpt-5.3-codex` (xhigh) | 20x |

**github-copilot**:
| Tier | Model | Cost ratio |
|------|-------|-----------|
| @fast | `github-copilot/claude-haiku-4-5` | 1x |
| @medium | `github-copilot/claude-sonnet-4-5` | 5x |
| @heavy | `github-copilot/claude-opus-4-6` (thinking) | 20x |

**google**:
| Tier | Model | Cost ratio |
|------|-------|-----------|
| @fast | `google/gemini-2.5-flash` | 1x |
| @medium | `google/gemini-2.5-pro` | 5x |
| @heavy | `google/gemini-3-pro-preview` | 20x |

### Routing modes

Switch with `/budget <mode>`. Mode is persisted across restarts.

| Mode | Default tier | Behavior |
|------|-------------|----------|
| `normal` | @medium | Balanced — routes by task complexity |
| `budget` | @fast | Aggressive savings — defaults cheap, escalates only when necessary |
| `quality` | @medium | Quality-first — liberal use of @medium/@heavy |
| `deep` | @heavy | Deep-analysis mode — heavy-first for architecture/debug/security with longer heavy runs |

```json
{
  "modes": {
    "budget": {
      "defaultTier": "fast",
      "description": "Aggressive cost savings",
      "overrideRules": [
        "default→@fast unless edits/complex-reasoning needed",
        "@medium ONLY: multi-file-edit/refactor/test-suite/build-fix",
        "@heavy ONLY: user-requested OR ≥2 @medium failures"
      ]
    },
    "deep": {
      "defaultTier": "heavy",
      "description": "Deep analysis mode — prioritizes thorough architecture/debug work with long heavy runs",
      "overrideRules": [
        "default→@medium for implementation and multi-file changes",
        "@heavy for architecture/debug/security/tradeoff-analysis by default",
        "allow long heavy runs before fallback; avoid premature downshift",
        "trivial(grep/read/glob)→direct,no-delegate",
        "if task is composite and phases are separable: prefer explore@fast then execute@heavy"
      ]
    }
  }
}
```

**Heavy tool-call budget:** `@heavy.steps=120` by default across presets (raised from 60) to reduce premature cutoffs on long architecture/debug tasks.

### Task taxonomy (`taskPatterns`)

Keyword routing guide injected into the system prompt. Customize to match your workflow:

```json
{
  "taskPatterns": {
    "fast": ["search/grep/read", "git-info/ls", "lookup-docs/types", "count/exists-check/rename"],
    "medium": ["impl-feature/refactor", "write-tests/bugfix(≤2)", "build-fix/create-file"],
    "heavy": ["arch-design/debug(≥3fail)", "sec-audit/perf-opt", "migrate-strategy/rca"]
  }
}
```

### Cost ratios

Set `costRatio` on each tier to reflect your real provider pricing. These are injected into the system prompt so the orchestrator makes cost-aware decisions:

```json
{
  "fast":   { "costRatio": 1  },
  "medium": { "costRatio": 5  },
  "heavy":  { "costRatio": 20 }
}
```

Adjust to actual prices. Exact values don't matter — directional signals are enough.

### Rules

The `rules` array is injected verbatim (in compact form) into the system prompt. Default ruleset:

```json
{
  "rules": [
    "[tier:X]→delegate X",
    "plan:fast/cheap→@fast | plan:medium→@medium | plan:heavy→@heavy",
    "default preference: read-only work → @fast; implementation → @medium",
    "orchestrate=self,delegate=exec",
    "trivial (≤1 tool call, no expected follow-up) → direct, skip-delegate",
    "before dispatching @heavy: gather context first (usually via @fast); if context is already sufficient, dispatch directly",
    "if self is opus: skip-@heavy (do locally); still prefer routing broader read-only exploration to @fast",
    "min(cost,adequate-tier)"
  ]
}
```

Rules in `modes[x].overrideRules` replace this array entirely for that mode.

### Read-only call caps

Subagents carry a cap on their own read-only tool calls (grep/read/glob/ls) per dispatch. Enforcement is **two-layered**: prompt-level stop rules + runtime banners injected into tool results. Baselines (configurable via `tierCaps` — see below):

| Tier | Baseline cap | Orchestrator self-cap |
|------|-------------:|----------------------:|
| `@fast` | 8 | — |
| `@medium` | 5 | — |
| `@heavy` | 3 | — |
| Orchestrator (direct tools) | — | 2 per turn (prompt-level only) |

The orchestrator can override any subagent's cap per dispatch by including a directive in the `Task` prompt:

- `CAP:N` — tighten or loosen to N calls (e.g., `CAP:3` for a focused lookup).
- `CAP:none` — disable the numeric cap entirely (used in `quality` mode and for `@heavy` in `deep` mode).

Omitting the directive falls back to the tier baseline. Subagents may **exceed** their cap with a 1-line `reason:` in the return (target, not hard block).

#### Runtime enforcement (subagents only)

Prompt-level rules alone are unreliable: many models (including strong ones like Opus 4.7) ignore "please stop at N reads" and loop on reconnaissance for tens of minutes. To address this, the plugin tracks read-only tool calls per subagent session and **appends a banner to every read-only tool result** via the `tool.execute.after` hook. The subagent sees this banner inside the tool's own response text — not as advisory system prompt noise — which makes it very hard to ignore.

What the subagent sees inside each `grep`/`read`/`glob`/`ls` result:

```
...normal tool output...

[cap: 3/5]
```

Approaching or hitting the cap:

```
[cap: 4/5]
[⚠ CAP WARNING: 1 read-only call(s) remaining before forced return]
```

```
[cap: 5/5]
[⚠ CAP REACHED (5/5): your NEXT response MUST be a return — do NOT make another read-only call. Start the response with DONE:, NEED MORE:, NEED CONTEXT:, SCOPE GROWTH:, or ESCALATE:.]
```

Redundancy (same file re-read, same `grep` pattern re-run):

```
[cap: 3/5]
[⚠ REDUNDANT: this is the same grep you ran at call #1. STOP now — repeated reads add no information. Return with DONE/NEED MORE/NEED CONTEXT/SCOPE GROWTH/ESCALATE.]
```

The orchestrator session is **not tracked** — its self-cap of 2 direct reads per turn is prompt-only. Tool counting applies only to sessions whose `agent` matches a registered tier name.

#### Configuring caps (`tierCaps`)

```json
{
  "tierCaps": {
    "fast": 8,
    "medium": 5,
    "heavy": 3
  }
}
```

Values are positive integers. Missing tier → falls back to the hardcoded default (same numbers). Change these to tighten/loosen the baseline without editing any prompt.

#### Return protocol

Independent of the numeric cap, every subagent runs a redundancy check before each new tool call. On stop (cap reached, redundancy detected, scope satisfied, or runtime banner), the subagent returns with exactly one of:

| Return prefix | Meaning |
|--------------|---------|
| `DONE: …` | Dispatch request fully satisfied — synthesize into final answer. |
| `NEED MORE: …` (or `NEED CONTEXT:` for `@medium`, `SCOPE GROWTH:` for `@heavy`) | Subagent needs another targeted round — orchestrator decides what to dispatch. |
| `ESCALATE: …` | Scope grew beyond the subagent's role — orchestrator re-routes. |

This keeps subagents from burning tokens on repeated lookups when they already have enough context. `CAP:none` lifts the numeric cap but **does not** disable the redundancy check — the runtime still injects `[⚠ REDUNDANT]` banners regardless of cap setting.

**Mode interactions:**

| Mode | Dispatch directive | Orchestrator self-cap |
|------|-------------------|-----------------------|
| `normal` | baselines (omit directive) | ≤2 direct reads |
| `budget` | `CAP:5` @fast, `CAP:2` @medium, `CAP:2` @heavy | ≤1 direct read |
| `quality` | `CAP:none` on all dispatches | ≤2 direct reads |
| `deep` | `CAP:none` on `@heavy` only; baselines elsewhere | ≤2 direct reads |

### Tier prompts (`tierPrompts`)

Each tier (`@fast`, `@medium`, `@heavy`) has a system prompt that describes its role, scope, call cap, and return protocol. To avoid duplicating the same string across every preset, the router uses a **global default with per-tier override**:

```json
{
  "tierPrompts": {
    "fast":   "You are @fast — ... (full global prompt)",
    "medium": "You are @medium — ...",
    "heavy":  "You are @heavy — ..."
  },
  "presets": {
    "anthropic": {
      "fast":   { "model": "anthropic/claude-haiku-4-5", ... },
      "medium": { "model": "anthropic/claude-sonnet-4-6", ... },
      "heavy":  { "model": "anthropic/claude-opus-4-7", ... }
    }
  }
}
```

**Resolution order per tier:**

1. If the preset's tier defines `"prompt": "..."` inline → use it (per-tier override).
2. Otherwise → fall back to `tierPrompts[<tierName>]`.
3. If neither is set → the tier registers without a system prompt.

**When to customize:** if a specific provider/model in a preset needs different instructions (e.g. Gemini-specific tool format, tighter/looser caps for a weaker local model), add `"prompt": "..."` on that tier only. All other presets keep using the global.

```json
{
  "presets": {
    "google": {
      "fast": {
        "model": "google/gemini-2.5-flash",
        "prompt": "You are @fast (Gemini-tuned variant) — ...",
        ...
      }
    }
  }
}
```

### Tier fields reference

| Field | Type | Description |
|-------|------|-------------|
| `model` | string | Full model ID (`provider/model-name`) |
| `variant` | string | Optional variant (`"max"`, `"xhigh"`, `"thinking"`) |
| `costRatio` | number | Relative cost (1 = cheapest). Shown in prompt. |
| `thinking` | object | Anthropic thinking: `{ "budgetTokens": 10000 }` |
| `reasoning` | object | OpenAI reasoning: `{ "effort": "high", "summary": "detailed" }` |
| `description` | string | Shown in `/tiers` output |
| `steps` | number | Max agent turns |
| `prompt` | string | Optional per-tier system prompt override. Falls back to top-level `tierPrompts[<tierName>]` when omitted. |
| `whenToUse` | string[] | Use cases (shown in `/tiers`, not in system prompt) |

### Fallback

Defines provider fallback order when a delegated task fails:

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

## Commands

| Command | Description |
|---------|-------------|
| `/tiers` | Show active tier configuration, models, and rules |
| `/preset` | List available presets |
| `/preset <name>` | Switch preset (e.g., `/preset openai`) |
| `/budget` | Show available modes and which is active |
| `/budget <mode>` | Switch routing mode (`normal`, `budget`, `quality`, `deep`) |
| `/annotate-plan [path]` | Annotate a plan file with `[tier:X]` tags for each step |

## Plan annotation

For complex tasks, you can write a plan file and annotate each step with the correct tier. The `/annotate-plan` command reads the plan and adds `[tier:fast]`, `[tier:medium]`, or `[tier:heavy]` tags to each step based on the task taxonomy.

The orchestrator then reads these tags and delegates accordingly — removing ambiguity from routing decisions on long, multi-step tasks.

Example plan (before annotation):
```markdown
1. Find all API endpoints in the codebase
2. Add rate limiting middleware to each endpoint
3. Write integration tests for rate limiting
4. Design a token bucket algorithm for advanced rate limiting
```

After `/annotate-plan`:
```markdown
1. [tier:fast] Find all API endpoints in the codebase
2. [tier:medium] Add rate limiting middleware to each endpoint
3. [tier:medium] Write integration tests for rate limiting
4. [tier:heavy] Design a token bucket algorithm for advanced rate limiting
```

## Token overhead

The system prompt injection is ~210 tokens per message — roughly the same as v1.0 (before cost-aware features were added). Dense notation keeps overhead flat while adding full routing intelligence.

| Version | Tokens | Features |
|---------|--------|----------|
| v1.0.7 | ~208 | Basic tier routing |
| v1.1.0 | ~870 | All features, verbose format |
| v1.1.1+ | ~210 | All features, compressed format |

## Requirements

- [OpenCode](https://opencode.ai) v1.0 or later
- Node.js 18+
- Provider API keys configured in OpenCode

## License

GPL-3.0
