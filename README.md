# opencode-model-router

> **Use the cheapest model that can do the job. Automatically.**

An [OpenCode](https://opencode.ai) plugin that routes every coding task to the right-priced AI tier — automatically, on every message, with 3,116–4,686 characters of system-prompt overhead depending on the orchestrator and enforcement mode.

## Why it's different

Most AI coding tools give you one model for everything. You pay Opus prices to run `grep`. opencode-model-router changes that with a stack of interlocking ideas:

**Use a mid-tier model as orchestrator.**
The orchestrator runs on *every* message. Put Sonnet there, not Opus. Sonnet reads a routing protocol and delegates just as well as Opus — at 4x lower cost. Reserve Opus for when it genuinely matters.

**Inject a compressed, LLM-optimized routing protocol.**
Instead of duplicated prose, the plugin injects a dense, machine-readable routing protocol. The protocol itself is 3,116 characters; a Claude orchestrator receives 3,888 characters after its authority prefix (roughly 965–1,075 tokens at 3.6–4.0 characters per token). Every message, every session.

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
Seven presets out of the box: Anthropic, OpenAI, GitHub Copilot, Google, hybrid, fable-effort, and Zai (GLM). Switch with `/preset`. If a provider fails, the fallback chain tries the next one automatically.

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

All of this adds 3,116 characters for a non-Claude orchestrator or 3,888 characters for a Claude orchestrator (roughly 770–1,075 tokens at 3.6–4.0 characters per token).

## Understanding how it works

> This intuition-first walkthrough was written by [Lucas Húngaro](https://github.com/lucashungaro) for [his fork](https://github.com/lucashungaro/opencode-model-router), and is included here with his permission.

There are a lot of moving parts, so let's use an analogy to explain how the plugin works.

### Picking who does the work

Think of your main orchestrator model as a head chef in a restaurant. You give it an order, and instead of cooking everything itself, it hands tasks to line cooks of different skill and price: a fast, cheap cook for simple tasks, a mid-level cook for everyday work, and an expensive expert for the hard problems.

The chef assigns each task by what the task is, not by who is the "fanciest" cook. Reading a file, searching the codebase, or looking something up goes to the cheap cook. Writing and editing code goes to the mid-level cook. Gnarly architecture, security work, or debugging that has already failed a couple of times goes to the expert. Trivial one-off lookups the chef just handles itself, since delegating those would cost more than it saves.

That is the routing in a nutshell. You pay expert prices only when a task genuinely needs an expert, which is exactly the point.

### Making sure the work actually got done

The enforcement layer is the kitchen's quality control. It exists because a cook saying "all done" is not the same as the dish being good.

It works in two parts. First, a recipe card travels with each order, so the chef and the cook agree up front on what "done" means (say, the tests pass, or a specific file exists). Second, when the work comes back, someone other than the cook who made it tastes it, and that taster is at least as senior as the cook who executed it. They check it against the recipe card, and if it falls short, a note goes back to the chef suggesting a redo, maybe by a more capable cook.

How strict all of this is comes down to one setting:

- **Off:** no checking. A cook says done and it goes out.
- **Advisory (the default):** everything still gets tasted and notes still get left, but nothing is ever held back. Gentle nudges only.
- **Enforced:** a dish that fails its check is held back and redone, or handed to a better cook, before it can leave the kitchen.

You can disable the enforcement layer entirely to save some tokens in the system prompt, at the cost of possible re-work if a subagent fails to meet the agreed-upon definition of "done." This is the enforcement feature.

### The standing rule: limited trips to the pantry

Separate from that optional quality control, the kitchen has one rule that is always in force, no matter which setting above you pick: a cook only gets so many trips to the pantry on a given task before they have to either start cooking or hand back what they have so far. And if a cook keeps checking the same shelf over and over, they get a sticky note telling them to stop. This is not about whether the dish is any good, it just keeps anyone from vanishing into the walk-in for an hour of "research" instead of producing something. It applies even with enforcement layer turned off.

This is the read-only call cap feature. It prevents runaway "exploration" loops and redundant tool calls, which are a common source of wasted time and money.

### Planning a big job up front

For a large, multi-step job you do not have to let the chef work out each step on the fly. You can write the plan down and have the kitchen label every step on the ticket ahead of time with the cook who should handle it. Think of prepping a banquet where each course is pre-assigned to a station, so nobody is deciding in the middle of service.

This is the plan annotation feature. You can invoke it with `/annotate-plan`. More details in [Plan annotation](#plan-annotation).

### Keeping certain cooks on task

Some cooks arrive with strong habits from their previous job. Left alone they tend to wander the whole pantry "just to be thorough," or they announce what they are about to do ("now I'll dice the onions") instead of actually doing it.

For those cooks the plugin clips a short note to the top of their instructions: in this kitchen your job is the dish in front of you, not a tour of the pantry. It keeps them from burning time and money on busywork. This is the adversarial prefix. There is also an optional, off-by-default add-on (the anti-narration guardrail) that tells them to cook rather than describe cooking; turn it on only if a model keeps announcing it will do work but never really does it (this can be common on small/older models).

### Setting the kitchen's priorities

You can also tell the kitchen how to lean. One setting keeps things balanced, one pushes hard for savings and sends almost everything to the cheap cook (with the obvious quality trade-offs), one spends more freely when you want quality, and one goes expert-first for long, hard jobs. You also choose which suppliers the cooks come from (Anthropic, OpenAI, Google, GitHub Copilot, or a mix), and if a supplier is unavailable the kitchen falls back to another automatically. These are the budget modes, presets, and fallback chain features.

In summary, the chef decides who cooks, the quality control decides whether the finished plate is good enough to serve, and the remaining knobs let you set the kitchen's budget, priorities, and suppliers.

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

On every message, the plugin injects a 3,116-character routing protocol. A Claude orchestrator receives 3,888 characters after its authority prefix (roughly 965–1,075 tokens at 3.6–4.0 characters per token). The notation is intentionally dense and compressed — it's **optimized for LLM comprehension, not human readability**. An agent reads it as a precise routing grammar; a human might squint at it.

What the orchestrator sees (Anthropic preset, normal mode):

```
## Model Delegation Protocol
Preset: anthropic. Tiers: @fast=claude-sonnet-5(1x) @medium=claude-opus-5/high(5x) @heavy=claude-fable-5/max(20x). mode:normal
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
| Measured prompt overhead: 3,116–4,686 chars | ✅ | — | ❌ | ❌ | ❌ |

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
  "plugin": [
    [
      "opencode-model-router",
      {
        "type": "npm",
        "package": "opencode-model-router"
      }
    ]
  ]
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
  "plugin": [
    [
      "opencode-model-router",
      {
        "type": "local",
        "package": "/absolute/path/to/opencode-model-router"
      }
    ]
  ]
}
```

## Configuration

The full default configuration lives in `tiers.json` at the plugin root. There are two ways to customize it.

### Recommended: overrides files (survive updates)

Anything in an overrides file is **deep-merged** over the bundled `tiers.json` on load — you only specify the keys you want to change; everything else falls back to the defaults. These files live outside the cache dir, so they are **not** wiped when the plugin updates. They're `.jsonc`, so `//` and `/* */` comments and trailing commas are allowed.

There are two layers, applied lowest→highest priority:

| Layer | Path | Scope |
|-------|------|-------|
| **Global** | `~/.config/opencode/opencode-model-router.overrides.jsonc` | Your personal defaults across all projects |
| **Project** | `<project>/.opencode/opencode-model-router.overrides.jsonc` | Per-project; commit it to share one routing config with your team |

The project file deep-merges over (and wins against) the global file, which in turn merges over the bundled defaults. So you can keep personal preferences globally while a committed project file unifies routing for everyone on the repo. The project file is found by searching upward from the working directory to the repo root (the nearest ancestor containing `.git`), so it is picked up even when you launch opencode from a subdirectory.

```json
{
  "presets": {
    "github-copilot": {
      "heavy": { "model": "github-copilot/claude-opus-4.8", "variant": "high" }
    }
  }
}
```

The example above changes only the `@heavy` model/variant for the `github-copilot` preset; every other tier, preset, and setting keeps its bundled value. You can also override `costRatio`, `tierCaps`, `rules`, `modes`, `enforcement`, add an entirely new preset, etc. — any top-level key from `tiers.json`.

Run `/router overrides` to see both file paths, whether each exists, and the precedence order.

Merge semantics: objects merge recursively; arrays and scalars are replaced wholesale (so an overridden `rules`/`whenToUse` list *replaces* the default, it does not append). If a file is missing, malformed, or produces an invalid config, the plugin logs a `[model-router]` warning and drops just that layer (keeping the others) — a typo in one file can never break startup or discard a valid file.

#### Defining a whole new preset

An overrides file can add a brand-new preset, not just tweak the bundled ones. `model` is the only required field per tier. `costRatio` and `steps` are optional — when omitted they fall back to the conventional **`1` / `5` / `20`** and **`30` / `50` / `120`** (by tier name, the same values the bundled presets use); `description`/`whenToUse` are display-only.

```jsonc
{
  "presets": {
    "openrouter": {
      "fast":   { "model": "openrouter/deepseek/deepseek-v3.2" },
      "medium": { "model": "openrouter/qwen/qwen3-coder", "costRatio": 3, "steps": 60 },
      "heavy":  { "model": "openrouter/google/gemini-3-pro", "costRatio": 9, "steps": 140 },
    },
  },
  // make it the active preset (or switch at runtime with `/preset openrouter`)
  "activePreset": "openrouter",
}
```

`@fast` omits `costRatio`/`steps`, so it gets the defaults (`1` / `30`); `@medium` and `@heavy` set their own to match their real economics. **Set `costRatio` whenever your models' relative costs differ from the default ladder** — it's the price signal the orchestrator uses to pick the cheapest adequate tier. (Routing by *task type* — `@fast`=read-only, `@medium`=implementation, `@heavy`=architecture — comes from the shared `taskPatterns`/`rules`, so it works for any preset automatically.)

The effective values, including any defaults, are shown by `/tiers`.

Restart opencode after adding a new preset so its tier subagents get registered. (Each model's provider must itself be configured in your `opencode.json`.)

> **`activePreset` / `activeMode` / `enforcement.mode` in an override file are _defaults_.** Runtime selections — `/preset`, `/budget`, `/router enforce` — are persisted to the state file (`~/.config/opencode/opencode-model-router.state.json`), which is applied **after** the override files and therefore wins. So the override's `activePreset` takes effect until you switch at runtime; if it ever "isn't taking", it's because a past `/preset` left a value in the state file — run `/preset <name>` again or delete that file. (The state file is machine-written, so the plugin never rewrites your hand-authored, commented override file.)

### Keeping models current

You do not have to wait on a plugin release when providers ship new models. opencode already resolves a live model catalog (models.dev plus your configured and authenticated providers), and the plugin reads it directly. No external fetch, no hardcoded list.

- **`/router models [provider]`** lists the valid model ids for your configured providers, each annotated with the provider's default and any `deprecated`, `alpha` or `beta` status. Copy an id straight into an overrides file.
- **Validation.** Bare `/router` checks the active preset's tier models against the catalog and reports any that are missing or deprecated, with the closest valid suggestions. A stale id surfaces immediately instead of failing silently on every subagent dispatch. The same check is logged once per session to the plugin console.

This is report-only. The plugin never changes your models for you: it tells you what is available and what to change, and you set it in the overrides file.

### Advanced: edit the bundled `tiers.json` directly

For an npm install, `tiers.json` is **inside the cached package directory**, not your `~/.config/opencode/` folder — typically:

```
~/.cache/opencode/packages/opencode-model-router@latest/node_modules/opencode-model-router/tiers.json
```

> ⚠️ Editing a copy elsewhere (e.g. under your global `npm` `node_modules`) has no effect, and this cached file is **overwritten on each plugin update**. Prefer the overrides file above unless you are developing the plugin from a local clone.

### Presets

The plugin ships with seven presets (switch with `/preset <name>`):

**anthropic** (default):
| Tier | Model | Cost ratio |
|------|-------|-----------|
| @fast | `anthropic/claude-sonnet-5` | 1x |
| @medium | `anthropic/claude-opus-5` (high) | 5x |
| @heavy | `anthropic/claude-fable-5` (max) | 20x |

**openai**:
| Tier | Model | Cost ratio |
|------|-------|-----------|
| @fast | `openai/gpt-5.6-luna-fast` | 1x |
| @medium | `openai/gpt-5.6-terra-fast` (high) | 5x |
| @heavy | `openai/gpt-5.6-sol-fast` (xhigh) | 20x |

**github-copilot**:
| Tier | Model | Cost ratio |
|------|-------|-----------|
| @fast | `github-copilot/claude-haiku-4.5` | 1x |
| @medium | `github-copilot/claude-sonnet-5` | 5x |
| @heavy | `github-copilot/claude-fable-5` | 20x |

**google**:
| Tier | Model | Cost ratio |
|------|-------|-----------|
| @fast | `google/gemini-3.5-flash-lite` | 1x |
| @medium | `google/gemini-3.7-flash` | 5x |
| @heavy | `google/gemini-3.1-pro-preview` | 20x |

**hybrid** — Anthropic for exploration and heavy analysis, OpenAI for implementation:
| Tier | Model | Cost ratio |
|------|-------|-----------|
| @fast | `anthropic/claude-haiku-4-5` | 1x |
| @medium | `openai/gpt-5.6-terra-fast` (high) | 5x |
| @heavy | `anthropic/claude-opus-5` (max) | 20x |

**fable-effort** — one model, three reasoning depths (see [per-tier `effort`](#per-tier-effort)):
| Tier | Model | Effort | Cost ratio |
|------|-------|--------|-----------|
| @fast | `anthropic/claude-fable-5` | `low` | 1x |
| @medium | `anthropic/claude-fable-5` | `high` | 3x |
| @heavy | `anthropic/claude-fable-5` | `xhigh` | 6x |

Because the model string is identical across tiers, escalating a task keeps the prompt
cache warm. The cost ratios are estimated token-spend multipliers, not price differences.

**zai** — GLM through the Z.AI Coding Plan (the `zai-coding-plan` provider, which is where `glm-5.3` lives):
| Tier | Model | Variant | Cost ratio |
|------|-------|---------|-----------|
| @fast | `zai-coding-plan/glm-4.7` | — | 1x |
| @medium | `zai-coding-plan/glm-5.3` | `high` | 3x |
| @heavy | `zai-coding-plan/glm-5.3` | `max` | 6x |

@medium and @heavy share one model, so — as with `fable-effort` — the cost ratios are
estimated token-spend multipliers, not price differences.

### Per-tier `effort`

Any tier may set `effort`: `low`, `medium`, `high`, `xhigh`, or `max`. Precedence,
highest first:

1. `thinking.budgetTokens` (Anthropic) / `reasoning.effort` (OpenAI) — the explicit,
   provider-specific setting always wins, and a one-time warning names the tier.
2. `effort`.

**Unset means unset**: no `effort` (and no `reasoning_effort`) key is registered at all.

| Model family | Registered as | Caveats |
|---|---|---|
| Anthropic | `options.effort`, incl. `xhigh`/`max` | Requires the `opencode-anthropic-fix` plugin (commit `307aea9`+ for fable/mythos). Non-adaptive Claude models (e.g. haiku) silently strip `effort` at the API layer, and without the plugin a top-level `effort` can break Claude-Code billing fingerprinting. |
| OpenAI | `options.reasoning_effort` | Supports only `low`/`medium`/`high`; `xhigh` and `max` are downgraded to `high` with a warning. |
| Other (Google, …) | nothing | Dropped with a warning — no known mapping. Detection is by model family, not provider prefix, so Copilot-proxied ids (`github-copilot/gpt-4o`, `github-copilot/claude-sonnet-4`) take their family's knob above. |

An out-of-set value in `tiers.json` fails validation at load; one that arrives any other
way is ignored with a single warning. Full detail in
[docs/CONFIG_REFERENCE.md](docs/CONFIG_REFERENCE.md#per-tier-effort).

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
- `CAP:none` — disable the numeric cap entirely (used in `quality` mode and for `@heavy` in `deep` mode). **`CAP:none` is honored only when the dispatch prompt also contains a `reason:` line.** An unjustified `CAP:none` silently falls back to the tier baseline — uncapped work must be justified in the dispatch, not just requested. `CAP:N` is unaffected.

Omitting the directive falls back to the tier baseline. Subagents may **exceed** their cap with a 1-line `reason:` in the return (target, not hard block).

#### Resumed dispatches

A "resume" is a second `chat.message` to a session already tracked at the **same tier** — how an opencode `task_id` resume (re-prompting an existing subagent session instead of spawning a new one) reaches the plugin. On resume:

- the **per-dispatch cap resets** (`[cap: 1/8]` again) — the resumed round gets a full budget, and re-reads the `CAP:` directive from the new dispatch text, gate included;
- the **redundancy map persists** — re-reading a file you already read in the previous round still emits `[⚠ REDUNDANT: … call #1]`;
- **cumulative usage persists** and is bounded by a ceiling of `cap × 3` (the current dispatch's cap). Exceeding it appends:

```
[cap: 2/3]
[⚠ CUMULATIVE BUDGET EXCEEDED: 10/9 across 4 dispatches — return now]
```

The ceiling follows the *current* cap, so a tighter resumed cap tightens the ceiling. `CAP:none` has no per-dispatch budget to derive from and therefore no cumulative ceiling. A **retry** (new session, e.g. an escalation to another tier) is not a resume: it gets fresh counters and an empty redundancy map. A session evicted by the idle-TTL sweep also comes back fresh.

The sweep exists so per-session bookkeeping does not grow without bound in a long-running
opencode process. A session is evicted once it has been idle for **1 hour**; every mutating
entry point refreshes its stamp, and a tool call refreshes at *start* so a single long call
cannot age out mid-flight. There are no timers: the sweep runs opportunistically off chat
activity, throttled to at most once every **5 minutes**, and covers the four session-keyed
stores (subagent sessions, guard state, trajectory telemetry, and changed-file tracking).

The same accounting exists at the hard-guard layer: `guard.budget` resets per dispatch, with a cumulative ceiling of `guard.budget × 3` enforced as `cumulative_iteration_cap`.

**If you never resume a subagent session, nothing changes** — a first dispatch's cumulative count equals its per-dispatch count, so the ceiling is unreachable and every banner is byte-identical to before.

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
      "fast":   { "model": "anthropic/claude-sonnet-5", ... },
      "medium": { "model": "anthropic/claude-opus-5", ... },
      "heavy":  { "model": "anthropic/claude-fable-5", ... }
    }
  }
}
```

**Resolution order per tier:**

1. If the preset's tier defines `"prompt": "..."` inline → use it (per-tier override).
2. Otherwise → fall back to the default for the tier's **prompt style**: `tierPromptsGoalOriented[<tierName>]` (or the built-in goal-oriented default) when the tier resolves to `goal-oriented`, else `tierPrompts[<tierName>]`.
3. If neither is set → the tier registers without a system prompt.

Two wordings of every default prompt ship: the enumerated `tierPrompts` above, and a shorter goal-oriented set. Which one a tier gets is decided by `promptStyle`, which defaults to `auto` (goal-oriented for strong models). See [Prompt styles](docs/CONFIG_REFERENCE.md#prompt-styles-promptstyle) in the config reference — including which shipped presets are affected.

To replace a built-in goal-oriented prompt, set `tierPromptsGoalOriented` in the overrides
file. It is the goal-oriented twin of `tierPrompts`: an entry replaces the built-in default
for that tier name only, and tiers you do not list keep theirs.

```jsonc
{
  // Only affects tiers that resolve to the goal-oriented style.
  "tierPromptsGoalOriented": {
    "medium": "You are @medium. Ship the change described in the dispatch, match the surrounding code, and return the files you touched plus the verification you ran."
  }
}
```

#### `modelGenerations`

`modelGenerations` holds substring patterns matched against a tier's model ID, with case
and separators (`.`, `-`, `_`) normalized on both sides — so `opus-4-8` matches
`opus-4.8`, and a provider renaming a model across separators cannot silently change how
it resolves. One list exists:

| List | Default | What it drives |
|------|---------|----------------|
| `strong` | `["claude-fable-5", "claude-mythos-5", "opus-4-8", "claude-opus-5"]` | `promptStyle: "auto"` resolution — a match resolves to `goal-oriented`, everything else to `prescriptive` (`isStrongModel` in `src/router/prompts.ts`). |

Setting `strong` replaces the default list outright rather than extending it — include the
built-in patterns you still want. The list is curated per model, not by generation:
`claude-sonnet-5` is a Claude 5 model that is deliberately not in it. Claude-specific
prompt prefixes and the anti-narration detector do **not** use these lists; they match the
model ID directly (`isClaudeModel` in `src/router/protocol.ts`).

```jsonc
{
  "modelGenerations": {
    // Keep the shipped patterns and add a locally-hosted strong model.
    "strong": ["claude-fable-5", "claude-mythos-5", "opus-4-8", "claude-opus-5", "my-org/big-coder"]
  }
}
```

See [Prompt styles](docs/CONFIG_REFERENCE.md#prompt-styles-promptstyle) in the config
reference for the full description.

**When to customize:** if a specific provider/model in a preset needs different instructions (e.g. Gemini-specific tool format, tighter/looser caps for a weaker local model), add `"prompt": "..."` on that tier only. All other presets keep using the global.

```json
{
  "presets": {
    "google": {
      "fast": {
        "model": "google/gemini-3.5-flash-lite",
        "prompt": "You are @fast (Gemini-tuned variant) — ...",
        ...
      }
    }
  }
}
```

### Claude-model adversarial prefixes (automatic)

Anthropic models (served directly via `anthropic/*` or routed through other providers as `*/claude-*`) ship with a large cached system prompt that primes them toward broad exploratory Read/Grep/Glob behavior. When such a prompt sits in front of your router instructions, primacy bias and prompt caching weaken the router's authority — subagents ignore caps, orchestrators run read-only work themselves instead of dispatching.

To counteract this, the router **automatically prepends an adversarial opener** to:

- The tier prompt for any tier whose `model` matches a Claude identifier
- The orchestrator delegation protocol when the session model is a Claude identifier

Detection is by model string, not preset. A `hybrid` preset that mixes providers (e.g. `openai/*` for @fast, `anthropic/*` for @medium and @heavy) gets the override only on its Claude-backed tiers.

**Tone assignment:**

| Target | Tone | Opener label |
|--------|------|--------------|
| `@fast` (Claude) | Scoping — conversational | `SCOPE NOTE` |
| `@medium` (Claude) | Scoping — conversational | `SCOPE NOTE` |
| `@heavy` (Claude) | Override — firm | `AUTHORITY OVERRIDE` |
| Orchestrator (Claude) | Override — firm | `AUTHORITY OVERRIDE` |

`@heavy` and the orchestrator use the firmer tone because that's where reconnaissance loops were worst in observed sessions. `@fast` and `@medium` use a softer scoping note to avoid over-correcting legitimate multi-read tasks.

**Detection rules:**

- `anthropic/<anything>` → Claude
- `<provider>/claude-<anything>` (e.g. `github-copilot/claude-sonnet-4-6`) → Claude
- `<provider>/<namespace>.claude-<anything>` (e.g. `bedrock/us.anthropic.claude-3-5-sonnet-...`) → Claude
- Everything else → untouched

No configuration is needed — the prefixes are always applied for Claude-backed tiers. If you want to disable them, override the tier's `prompt` field (per-tier overrides replace the whole prompt, including the prefix).

### Anti-narration guardrail (Claude models, opt-in)

Some Claude models (historically, thinking-enabled Sonnet with the `max` variant) can produce progress narration instead of actual work, phrasings like *"Still writing the X function..."*, *"Now I'll implement Y..."*, *"Let me add Z..."*, without the X/Y/Z ever appearing.

This guardrail is **off by default**. On the Claude orchestrator path, enabling it adds 650 characters per message (roughly 160–180 tokens at 3.6–4.0 characters per token), and its detector false-positives on normal productive phrasing like "Now I'll add the test" when the test does follow, so it is opt-in. Enable it only if you actually observe narration-without-production on your models:

```jsonc
{ "antiNarration": true }
```

When enabled, it works on two layers:

**1. Prompt-level clause (prevention).** A dedicated `ANTI-NARRATION` block is appended to every Claude-backed tier prompt and to the Claude-backed orchestrator delegation protocol. It names the forbidden phrasings explicitly and requires concrete output to follow any such phrase. A carve-out preserves legitimate explanation/plan requests from the user.

**2. Post-hoc detector (telemetry).** An `experimental.text.complete` hook scans completed text for narration regex patterns. On match, it:

- Logs a warning to the plugin console:
  ```
  [model-router] narration detected (session abc123): "Still writing the auth", "Now I'll add the tests"
  ```
- Appends a visible banner to the text as it's rendered to the user:
  ```
  [⚠ narration detected: "Still writing the auth", "Now I'll add the tests"]
  ```

The detector is not blocking — plugin hooks cannot modify tokens mid-stream. It signals post-hoc so you can spot the pattern in the UI and in logs, and judge whether the prompt-level clause is holding up.

Detected patterns (conservative set to minimize false positives):

- `Still (writing|implementing|working on|...) the X`
- `Now (I'll)? (write|implement|add|...) the X`
- `Let me (write|implement|add|...) (the )? X`
- `I'll (now)? (write|implement|...) the X`
- `Going to (write|implement|...) the X`
- `Continuing (with|by ...ing) (the )? X`

When `antiNarration` is enabled, the detector runs for all models (not only Claude), while the prompt-level clause is Claude-only, so non-Claude models get detector-only. With the default (`antiNarration` off), neither layer runs.

### Tier fields reference

| Field | Type | Description |
|-------|------|-------------|
| `model` | string | Full model ID (`provider/model-name`) |
| `variant` | string | Optional variant (`"max"`, `"xhigh"`, `"thinking"`) |
| `costRatio` | number | Relative cost (1 = cheapest). Shown in prompt. |
| `thinking` | object | Anthropic thinking: `{ "budgetTokens": 10000 }` |
| `reasoning` | object | OpenAI reasoning: `{ "effort": "high", "summary": "detailed" }` |
| `effort` | string | Provider-agnostic reasoning effort: `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`. See [Per-tier `effort`](#per-tier-effort). |
| `color` | string | Optional agent colour passed through to the opencode agent registration. |
| `description` | string | Shown in `/tiers` output |
| `steps` | number | Max agent turns |
| `prompt` | string | Optional per-tier system prompt override. Falls back to the style-appropriate default when omitted. |
| `promptStyle` | string | `"prescriptive"`, `"goal-oriented"` or `"auto"` (default). Picks which default prompt the tier gets; ignored when `prompt` is set. |
| `whenToUse` | string[] | Use cases (shown in `/tiers`, not in system prompt) |

### Routing your own subagents (`subagentTiers`, opt-in)

If you already have custom subagents (`.opencode/agents/**`), they do **not** get routed by default. An agent that declares no `model` inherits the model of whoever invoked it, usually your orchestrator, so a cheap read-only helper quietly runs at orchestrator prices.

`subagentTiers` maps your agent names to tiers, and the plugin repoints them at the active preset's models:

```jsonc
{
  "subagentTiers": {
    "ContextScout": "fast",
    "CodeReviewer": "medium",
    "SecurityReviewer": "heavy"
  }
}
```

The point of doing this here rather than in `opencode.json` is that these agents then **follow `/preset`**. Switch to `openai` and `ContextScout` moves to that preset's fast model along with `@fast`. No model IDs live in your agent files, and a committed project overrides file gives the whole team the same routing.

**Getting the names right.** The key is opencode's agent name: the frontmatter `name:` field when the agent declares one, otherwise the file's path-derived name (`agents/team/helper.md` becomes `team/helper`). Frontmatter wins, so an agent in `subagents/core/contextscout.md` with `name: ContextScout` is keyed `ContextScout`. Matching is case-sensitive.

**Rules, all deliberate:**

- **Opt-in.** No map, or an empty one, and nothing is touched.
- **The map wins over the agent's own `model`.** This is the point, and it is what lets you delete hardcoded model IDs from agent files. If you want an agent to keep its pinned model, leave it out of the map.
- **List subagents only.** Primary agents are the orchestrator, so pinning one to a tier defeats the routing. Agents already registered with a non-`subagent` mode are skipped, but a *markdown* agent's mode is not visible when the map is applied, so a primary agent listed there would still be repointed.
- **Unknown tier names are skipped**, not fatal. A map written for a preset that defines a tier this one does not must never break startup.
- **Tier names are never overwritten.** An entry keyed `fast`/`medium`/`heavy` is ignored so it cannot clobber the plugin's own agents.
- **Variants are set explicitly.** If the target tier has no `variant`, any variant already on the agent is removed rather than inherited. An inherited variant from another provider fails at dispatch, not at load.

Anything not listed is left exactly as opencode built it.

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

## Delegation enforcement (advisory by default)

The read-only cap banners described above are advisory: a well-behaved subagent will respect them, but nothing prevents a model from making one more read after the `[⚠ CAP REACHED]` banner. The **enforcement layer** turns delegation into a produce → verify → accept/escalate loop with independent acceptance and quality escalation. As of v1.3.0 it runs in **`advisory` mode by default**: every non-trivial delegation is verified and any miss surfaces a forcing-note, but nothing is ever hard-blocked (the DoD/acceptance section adds 798 characters to the orchestrator system prompt, roughly 200–220 tokens at 3.6–4.0 characters per token, and subagents may receive non-blocking guard banners). Set `"mode": "off"` — or run `/router enforce off` — to restore byte-for-byte-unchanged routing with zero added prompt tokens and zero new latency. Hard-blocks only activate in `"mode": "enforced"`.

### The three enforcement layers

- **Layer 1 — hard-block guard.** A `tool.execute.before` hook throws before a disallowed tool call executes, stopping budget overruns, redundant reads, and throwaway-script sidesteps in subagent sessions.
- **Layer 2 — independent acceptance gate.** A non-trivial delegation carries a Definition-of-Done (DoD) that is checked — deterministically or by an independent grader at ≥ the producer's tier — before the result is trusted. The producer never grades its own output. Two cases are skipped rather than checked: a trivial dispatch carrying only an inferred DoD, and a dispatch whose inferred DoD has no deterministic checks and which changed no files. An explicit `[acceptance]` block is always verified. See [docs/VERIFICATION.md](docs/VERIFICATION.md).
- **Layer 3 — quality-escalation ladder.** On a failed check: retry once, then escalate fast → medium → heavy, bounded by attempt and cost ceilings. The loop ends in an honest `status: unmet` rather than a fabricated pass.

### Two operating modes

- **Mode A — on-the-fly.** The orchestrator delegates through the native `Task()` tool — observed and verified automatically by the enforcement pipeline, and rendered inline in the TUI. (An optional, independently-verified `delegate` tool can be enabled via `experimental.verifiedDelegateTool` in `tiers.json` or `MODEL_ROUTER_VERIFIED_DELEGATE=1`; it is hidden by default so delegation stays visible.)
- **Mode B — plan-annotated.** `/annotate-plan` emits `[tier:X]` plus an `[acceptance]` block per task; the enforcement loop is wired up at execution time based on those annotations.

### Tuning enforcement

Advisory is the default. To change the level:

1. Add or edit the `enforcement` block in `tiers.json` — `"mode": "off"`, `"advisory"`, or `"enforced"` (see `docs/CONFIG_REFERENCE.md`).
2. Set `MODEL_ROUTER_ENFORCE=1` to force `enforced` for a session, or `MODEL_ROUTER_ENFORCE=0` to force `off`.
3. Run `/router enforce <off|advisory|enforced>` from the chat to toggle at runtime.

**Modes:** `off` — no-op, byte-for-byte-unchanged routing (must now be set explicitly, since `advisory` is the default); `advisory` (default) — evaluates and surfaces guidance, never blocks; `enforced` — hard-blocks active, full produce → verify → accept/escalate pipeline.

> Enforcement applies to subagent/delegate sessions only. The orchestrator session is never hard-blocked.

**Per-tier override.** `enforcement.perTier` maps a tier name to `off`, `advisory` or
`enforced` and wins over the global `mode` for delegations to that tier — useful to keep
`@fast` advisory while `@medium` and `@heavy` are enforced:

```jsonc
{
  "enforcement": {
    "mode": "enforced",
    "perTier": { "fast": "advisory" }
  }
}
```

#### Time-boxes

Three ceilings bound the verification pipeline so a stuck model cannot hang a delegation
forever. All are integers in milliseconds, live under `enforcement.verify`, and ship
explicitly in `tiers.json`:

| Key | Bundled default | Bounds |
|-----|-----------------|--------|
| `delegateTimeoutMs` | `600000` (10 min) | One producer turn. |
| `graderTimeoutMs` | `60000` (1 min) | One grader turn. |
| `gateBudgetMs` | `90000` (90 s) | The whole acceptance gate. |

Each budget is per **ladder attempt**, not per delegation: a fast → medium → heavy
escalation gives every attempt its own fresh clock. On expiry the child session is
cancelled for real via `session.abort` rather than left running, and the attempt is
recorded as failed so the ladder advances — an expired budget never yields a fabricated
pass, only an honest `status: unmet`.

Raise a ceiling rather than removing it; `0` and negative values are rejected by
`validateConfig`, not read as "no timeout".

```jsonc
{
  "enforcement": {
    "verify": {
      // A slow local model needs longer than the 10-minute default.
      "delegateTimeoutMs": 1800000
    }
  }
}
```

Full field notes are in [docs/CONFIG_REFERENCE.md](docs/CONFIG_REFERENCE.md).

### Deep-dive documentation

- `docs/ENFORCEMENT.md` — architecture, hook wiring, session lifecycle
- `docs/VERIFICATION.md` — DoD schema, deterministic checks, grader dispatch
- `docs/ESCALATION.md` — escalation ladder configuration and cost ceilings
- `docs/CONFIG_REFERENCE.md` — full `enforcement` block schema
- `docs/ENFORCEMENT_PRESETS.md` — ready-to-paste enforcement presets

> These files are not included in the npm tarball. This section is the self-contained summary; the docs are available in the repository for contributors and advanced users.

## Commands

| Command | Description |
|---------|-------------|
| `/tiers` | Show active tier configuration, models, rules, and each tier's resolved prompt style |
| `/preset` | List available presets |
| `/preset <name>` | Switch preset (e.g., `/preset openai`) |
| `/budget` | Show available modes and which is active |
| `/budget <mode>` | Switch routing mode (`normal`, `budget`, `quality`, `deep`) |
| `/annotate-plan [path]` | Annotate a plan file with `[tier:X]` tags for each step |
| `/router overrides` | Show the global + project override file paths and merge precedence |
| `/router models [provider]` | List valid model ids from your configured providers (with defaults and deprecated flags) |
| `/router enforce <off\|advisory\|enforced>` | Set delegation-enforcement mode (persisted) |
| `/router` | With no subcommand — or an unrecognized one — prints the `/router` help and the current enforcement mode |
| `/bypass [on\|off]` | Toggle the router off/on for the session |

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

Measured with the bundled Anthropic preset in normal mode (the shipped `activePreset`/`activeMode` defaults), the routing protocol is 3,116 characters for a non-Claude orchestrator. A Claude orchestrator receives 3,888 characters after its authority prefix, or 4,686 characters when the 798-character DoD/enforcement section is enabled. That is roughly 770–1,295 tokens across the three paths at 3.6–4.0 characters per token. The optional anti-narration clause adds another 650 characters to the Claude path.

These are character counts of the prompts the shipped config actually produces, so they move whenever the protocol text does. `test/unit/docs-drift.test.ts` recomputes all three from `tiers.json` on every run and fails unless this section still quotes them, so a change that grows the protocol cannot land without updating these numbers.

| Version | Measured overhead | Features |
|---------|-------------------|----------|
| Before v1.4.0 | Earlier README token estimates were not measured and were inaccurate | Routing, caps, and enforcement evolved across releases |
| v1.4.0 | 2,970–4,540 chars (~740–1,260 tokens at 3.6–4.0 chars/token) | Trimmed protocol; path-dependent Claude and enforcement prefixes |
| v1.6.0 | 3,089–4,659 chars (~770–1,295 tokens at 3.6–4.0 chars/token) | +119 chars on every path: `CAP:none` now has to be justified by a `reason:` line, and the protocol says so twice (rule 7 and the per-dispatch paragraph) |

## Requirements

- [OpenCode](https://opencode.ai) v1.0 or later
- Node.js 20+
- Provider API keys configured in OpenCode

## License

GPL-3.0
