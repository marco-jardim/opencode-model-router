# Enforcement Configuration Reference

The `enforcement` block in `tiers.json`. Every field is optional; each one falls back to the default listed below, and the bundled `tiers.json` now **ships those defaults explicitly** so they are visible in the file rather than implicit in code — see [What the bundled `tiers.json` ships](#what-the-bundled-tiersjson-ships). Setting `mode: "off"` (or `MODEL_ROUTER_ENFORCE=0`) is a strict no-op.

> These settings (like anything in `tiers.json`) can also be placed in an overrides file — `~/.config/opencode/opencode-model-router.overrides.jsonc` (global) or `<repo>/.opencode/opencode-model-router.overrides.jsonc` (project) — and are deep-merged over the bundled defaults, so you don't have to edit the cached `tiers.json`. See the **Configuration** section of the README.

**Cross-references:** [ENFORCEMENT.md](./ENFORCEMENT.md) · [VERIFICATION.md](./VERIFICATION.md) · [ESCALATION.md](./ESCALATION.md) · [ENFORCEMENT_PRESETS.md](./ENFORCEMENT_PRESETS.md)

---

## `tiers.json` top-level keys

Everything below this table describes the `enforcement` block. These are the other top-level
keys of `tiers.json`, in the order the bundled file writes them. The router type is
`RouterConfig` in `src/router/config.ts`; `validateConfig` in the same file rejects a file that
gets any of them wrong.

| Key | Type | Bundled value | Notes |
|---|---|---|---|
| `activePreset` | `string` | `"anthropic"` | Names the entry of `presets` the router routes with. `validateConfig` rejects a name that is not a defined preset; matching is case-insensitive and trimmed. `/router preset <name>` rewrites it at runtime and persists the choice to the router's state file. Read by `getActiveTiers` in `src/router/protocol.ts`, which falls back to the first defined preset, and by the fallback-chain builder. |
| `activeMode` | `string` (optional) | `"normal"` | Names the entry of `modes` layered over the preset. Omit it — or point it at nothing — and no mode is applied. `/router mode <name>` rewrites it at runtime, rejecting a name that `modes` does not define, and persists it. Read by `getActiveMode` in `src/router/protocol.ts`. |
| `presets` | `Record<string, Preset>` | seven presets: `anthropic`, `openai`, `github-copilot`, `google`, `hybrid`, `fable-effort`, `zai` | Each preset maps a tier name (`fast`/`medium`/`heavy`) to its `TierConfig` — `model`, `costRatio`, `steps`, `effort`, and the optional per-tier `prompt`. |
| `rules` | `string[]` | 10 rules | The numbered routing rules rendered verbatim into the `Rules:` line of the delegation protocol. Order is significant: they are emitted `1.`…`N.` in array order. |
| `defaultTier` | `string` | `"medium"` | The tier used when nothing else selects one — no `[tier:X]` tag, no task-pattern match, no mode `defaultTier`. A mode's own `defaultTier` wins over this one; `src/index.ts` falls back to `"medium"` if the key is somehow absent. `validateConfig` requires it to be a string. |
| `taskPatterns` | `Record<string, string[]>` (optional) | `fast`/`medium`/`heavy` keyword lists | Per-tier keyword lists that teach the orchestrator which work belongs to which tier. `buildTaskTaxonomy` in `src/router/protocol.ts` renders them into the protocol's `R:` line, joining each tier's keywords with `/`; an empty or absent object drops that line entirely. |
| `modes` | `Record<string, ModeConfig>` (optional) | `normal`, `budget`, `quality`, `deep` | Named routing profiles. Each is `{ defaultTier, description, overrideRules? }`: `defaultTier` replaces the top-level one while the mode is active, `description` is what `/router mode` prints, and a non-empty `overrideRules` replaces the `rules` list for that mode and also suppresses the multi-phase decomposition hint, which would otherwise conflict with it. `validateConfig` checks the shape of every entry. |
| `tierPrompts` | `Record<string, string>` (optional) | one prompt per tier | Global prescriptive tier prompts. A preset-level `tier.prompt` overrides the entry for that tier. See [Prompt styles](#prompt-styles-promptstyle) for the goal-oriented counterpart. |
| `tierCaps` | `Record<string, number>` (optional) | `fast: 8`, `medium: 5`, `heavy: 3` | Read-only tool-call baselines per tier, enforced at runtime through cap banners. |
| `fallback` | `FallbackConfig` (optional) | `global` chains for the five shipped providers | Provider fallback chains, either `global` (keyed by provider) or `presets` (keyed by preset, then provider). Rendered into the protocol's `Chain:` line. A chain keyed by a provider the active preset never routes to is **dormant by design** and is not validated against the catalog — the shipped chains cover every provider, so on a single-provider install most of them are inert. A chain entry naming a preset that does not exist is still reported, since that is a config error whatever your providers are. |
| `enforcement` | object (optional) | shipped explicitly at the previous defaults | The verification/acceptance layer. Documented in the rest of this file. |

The next keys are **not in the bundled `tiers.json`** — they are override-only and opt-in.
`validateConfig` accepts them wherever they appear, but absent means the feature is off (or
falls back to its in-code default), so you only ever see them in an overrides file.

| Key | Type | Default when absent | Notes |
|---|---|---|---|
| `tierPromptsGoalOriented` | `Record<string, string>` | built-in goal-oriented prompts in `src/router/prompts.ts` | Goal-oriented twin of `tierPrompts`; an entry replaces the built-in for that tier. See [Prompt styles](#prompt-styles-promptstyle). |
| `modelGenerations` | `{ strong?: string[] }` | `DEFAULT_STRONG_MODEL_PATTERNS` in `src/router/config.ts` | Shared model-ID substring pattern lists. `strong` drives `promptStyle: "auto"` resolution. |
| `subagentTiers` | `Record<string, string>` | `{}` — no pre-existing agent is touched | Opt-in map of your own subagent names to tier names, repointing them at the active preset's model for that tier. Unknown tier names are skipped at resolve time rather than rejected. |
| `antiNarration` | `boolean` | `false` | Adds the anti-narration clause to Claude tier prompts and enables the non-blocking narration detector. |
| `experimental` | `{ verifiedDelegateTool?: boolean }` | `{}` — every experimental feature off | Opt-in features. `verifiedDelegateTool` exposes the independently-verified `delegate` tool, also settable via `MODEL_ROUTER_VERIFIED_DELEGATE=1`. |

---

## `enforcement` top-level fields

| Field | Type | Default | Notes |
|---|---|---|---|
| `mode` | `"off" \| "advisory" \| "enforced"` | `"advisory"` | Global enforcement mode. `off` = no-op. `advisory` = log violations, never block. `enforced` = block/escalate on violations. |
| `envGate` | `string` | `"MODEL_ROUTER_ENFORCE"` | Name of the env var that overrides mode at runtime. See env-gate truth table below. |
| `perTier` | `Record<string, "off" \| "advisory" \| "enforced">` | `{}` | Per-tier mode overrides. Keyed by tier name. Overrides base `mode` when the env gate is unset/empty. |
| `guard` | object | see below | Request-level hard guards (caps, script controls, budget). |
| `verify` | object | see below | Verification / grading policy. |
| `escalate` | object | see below | Escalation ladder and cost ceiling. |
| `proportional` | object | see below | Trivial-task bypass logic. |

---

## `guard`

| Field | Type | Default | Notes |
|---|---|---|---|
| `readDraftCap` | `number` | `3` | Max read-only tool calls before an edit must begin. |
| `sameOpRetryCap` | `number` | `1` | Max retries of the identical operation before escalation. |
| `blockSelfScript` | `boolean` | `true` | Block agent-written scripts that target the router's own config files. |
| `deliverableFirst` | `boolean` | `true` | Require a concrete deliverable token before prose commentary. |
| `budget` | `number` | `25` | Soft cost-unit ceiling per attempt. Must be ≥ 1. |
| `blockScriptWrites` | `boolean` | `false` | Block all script-write operations regardless of target. Must be a boolean. |

---

## `verify`

| Field | Type | Default | Notes |
|---|---|---|---|
| `require` | `"never" \| "whenDoDPresent" \| "always"` | _(unset)_ | When to run a verification pass after production. Has no code-level default: when the key is absent the call sites read `undefined` and decide per dispatch, so the bundled `tiers.json` ships nothing for it. |
| `requireExplicitDoD` | `boolean` | `false` | When `true`, a task with no explicit Definition of Done is treated as failing verification. |
| `preferDeterministic` | `boolean` | _(auto)_ | Defaults to `true` whenever the DoD contains runnable checks; omit to let the router decide. |
| `graderPolicy` | `"atLeastProducerTier"` | `"atLeastProducerTier"` | **Only valid value.** Grader tier = `max(producerTier, minGraderTier)` along the ladder; never below the producer. A deterministic check uses no grader. |
| `graderTemperature` | `number` | `0` | Applied via the `chat.params` hook to grader sessions only. |
| `minGraderTier` | `string \| null` | `null` | Optional floor for the grader tier, independent of producer. `null` means no floor and is identical to omitting the key. |
| `delegateTimeoutMs` | `integer ≥ 1` | `600000` (10 min) | Ceiling for **one** producer `session.prompt` turn in the `delegate` tool. Each ladder attempt gets its own budget. On expiry the child session is aborted and deleted, the attempt is recorded as failed with `producer failed: …`, and the ladder advances — the delegation never fabricates a pass. |
| `graderTimeoutMs` | `integer ≥ 1` | `60000` (1 min) | Ceiling for **one** grader `session.prompt` turn. On expiry the grader session is aborted and deleted and verification fails closed; there is no "inconclusive, therefore accepted" path. |
| `gateBudgetMs` | `integer ≥ 1` | `90000` (90 s) | Ceiling for the whole acceptance gate — deterministic checks plus the grader — for one attempt. On expiry any in-flight grader is aborted and the verdict is an honest `unmet`. |

> **Note:** `graderPolicy: "atLeastProducerTier"` ensures a cheap producer is never graded by an even cheaper model. A deterministic DoD check (shell command, test run, lint) skips the grader entirely.

> **Tuning the ceilings.** The 10-minute producer default is sized for a heavy-tier
> task that reads a codebase and writes a non-trivial patch, and it applies **per
> ladder attempt**, not per delegation. A genuinely long-running heavy task can
> still hit it — a large migration, or a task whose subagent shells out to a slow
> build. If that happens the symptom is unambiguous: `[router status: unmet]` with
> `producer failed: delegate producer prompt timed out after 600000ms` in the
> forcing note. Raise `delegateTimeoutMs` rather than removing the ceiling; `0` and
> negative values are **rejected at load** precisely so that "no timeout" cannot be
> requested by accident. `gateBudgetMs` bounds verification, not production, and
> should stay well under `delegateTimeoutMs`.

---

## `escalate`

| Field | Type | Default | Notes |
|---|---|---|---|
| `floorTier` | `string \| null` | `null` | Pin the minimum starting tier; skips cheaper rungs. Must be string or `null`. |
| `ladder` | `string[]` | `["fast","medium","heavy"]` | Ordered list of tier names to escalate through. Must be an array of strings. |
| `maxAttemptsPerTier` | `number` | `1` | Max attempts at each rung before advancing. Must be integer ≥ 0. |
| `maxTotalAttempts` | `number` | `4` | Hard ceiling across all tiers and retries. Must be integer ≥ 1. |
| `costCeiling.base` | `string` | `"firstAttemptCostUnits"` | Reference point for cost ceiling. `"firstAttemptCostUnits"` = cost of the first producing attempt. |
| `costCeiling.multiple` | `number` | `4` | Ceiling = `base × multiple`. Must be > 0. Escalation halts when cumulative cost would exceed this. |

> **`floorTier`** is useful when a task is known non-trivial: set `floorTier: "medium"` to skip `fast` entirely.  
> **`costCeiling`** is evaluated before each escalation step; the attempt is not started if it would breach the ceiling.

---

## `proportional`

| Field | Type | Default | Notes |
|---|---|---|---|
| `trivialBypass` | `boolean` | `true` | When `true`, tasks classified as trivial skip enforcement and route to `fast` directly. |
| `trivialClassifier` | `string` | `"dispatchIntent"` | Classifier strategy used to detect trivial tasks. |

> **Note:** `trivialBypass` defaults `true` but trivial classification is tier-gated to `fast` and biased toward non-trivial. Real work is never silently downgraded.

### What counts as "trivial"

Trivial means a **single-shot lookup**, not merely "read-only". A dispatch is
trivial only when *all* of the following hold (see `classifyTrivial` in
`src/router/sessions.ts`):

1. the dispatch tier is `fast` — `medium` / `heavy` is never trivial;
2. the dispatch text is non-empty;
3. it carries no `taskPatterns.medium` / `taskPatterns.heavy` signal;
4. it matches a `taskPatterns.fast` stem (`read`, `search`, `grep`, …);
5. it names **at most one** file path — counting both extensioned paths
   (`src/index.ts`) and well-known extensionless files (`Makefile`, `LICENSE`,
   `Dockerfile`, …, matched case-sensitively so "the license field" is prose, not
   a file);
6. it carries **no multi-step marker**. Markers include an ordered/bulleted/step
   list item (`1.`, `1)`, `1:`, `- `, `Step 2:`), a sequencing or distributive
   word (`then`, `one at a time`, `sequentially`, `in order`, `each`,
   `after that`, `for every`), and shell-style chaining (`;`, `&&`). This list is
   illustrative, not exhaustive — see `MULTI_STEP_RE` for the authoritative set;
7. it contains **no enumeration of three or more subjects** (`router, guard and
   verify`) and **no second imperative line** — both signal breadth even when no
   file is named;
8. it carries **no distributive breadth quantifier** — `every` / `all` scoping a
   plural or collective target class (`read all guard modules`, `search every
   config file`) is a fan-out even with no comma, connector, second line or named
   path. The quantifier must scope a *class*, so partitive depth over one file
   stays trivial (`read every line of package.json`, `read all of src/index.ts`).
   Illustrative, not exhaustive — see `DISTRIBUTIVE_RE` for the authoritative
   pattern (`each` and `for every` are covered by clause 6 instead);
9. it is **at most 240 characters** long.

So `read package.json and tell me the version` is trivial and is exempted from
enforced-mode hard blocks, while `read README.md, then package.json, then
src/index.ts, one at a time` is **not** — it is multi-file, sequenced recon, and
stays fully enforced.

> Clauses 5–9 were added to fix a bug in which *any* `fast` dispatch containing a
> stem like `read` was trivial. That exempted multi-file recon from enforcement,
> so the `read_budget` guard could never hard-block a `@fast` subagent — the exact
> runaway it exists to bound. Setting `trivialBypass: false` disables the exemption
> entirely; the knob's semantics are unchanged.

---

## Env-gate truth table

Env var name: value of `enforcement.envGate` (default `MODEL_ROUTER_ENFORCE`).  
Evaluated by `resolveEnforcementMode` on every dispatch.

| Env var value | Resolved mode | Notes |
|---|---|---|
| `"1"` | `"enforced"` | Hard override. Ignores `mode` **and** `perTier`. |
| `"0"` | `"off"` | Hard override. Ignores `mode`. |
| unset or `""` | config `mode`, with `perTier[tier]` taking precedence when present | Normal path. |
| any other value | config `mode` (fallback) | Emits one-time warning: `<gate>="<value>" is not "1" or "0"; ignoring env gate and using config.` |

---

## Validation rules

`validateConfig` throws on `tiers.json` load if any of these are violated:

| Rule |
|---|
| `mode` must be one of `off \| advisory \| enforced`. |
| `verify.graderPolicy` (when `verify` is an object) must be exactly `"atLeastProducerTier"`. |
| `escalate.costCeiling.multiple` must be a number > 0. |
| `escalate.ladder` must be an array of strings. |
| `escalate.maxAttemptsPerTier` must be an integer ≥ 0. |
| `escalate.maxTotalAttempts` must be an integer ≥ 1. |
| `escalate.floorTier` must be string or `null`. |
| `perTier` values must each be `off \| advisory \| enforced`. |
| `guard.budget` must be a number ≥ 1. |
| `guard.blockScriptWrites` must be a boolean. |
| `envGate` must be a non-empty string. |
| `guard.readDraftCap` and `guard.sameOpRetryCap` must each be an integer ≥ 0. |
| `guard.blockSelfScript` and `guard.deliverableFirst` must each be a boolean. |
| `verify.minGraderTier` must be a string or `null`. |
| `verify.graderTemperature` must be a number ≥ 0. |
| `verify.requireExplicitDoD` must be a boolean. |
| `verify.delegateTimeoutMs`, `verify.graderTimeoutMs` and `verify.gateBudgetMs` must each be an integer ≥ 1 (milliseconds). `0` and negatives are rejected, not read as "no timeout". |
| `proportional.trivialBypass` must be a boolean. |
| A tier's `effort` (when present) must be one of `low \| medium \| high \| xhigh \| max`. Error: `tiers.json: preset '<preset>' tier '<tier>': effort must be one of low, medium, high, xhigh, max`. |

An invalid value in the bundled `tiers.json` throws at load; the same value in an
overrides file is reported via `console.warn` and that override layer is dropped.

---

## Per-tier `effort`

`effort` is an optional, provider-agnostic tier field: one of `low`, `medium`, `high`,
`xhigh`, `max`. It lets one preset run the *same model* at three different reasoning
depths — that is what the bundled `fable-effort` preset does (`@fast`=`low`,
`@medium`=`high`, `@heavy`=`xhigh`, all on `anthropic/claude-fable-5`), which keeps the
prompt cache warm across tiers because the model string never changes.

```jsonc
{
  "presets": {
    "fable-effort": {
      "fast": { "model": "anthropic/claude-fable-5", "effort": "low" }
    }
  }
}
```

**When unset, nothing is registered.** The agent's `options` bag simply has no `effort`
(and no `reasoning_effort`) key — there is no implicit default and no "normal" value
written on your behalf.

### Precedence

Highest wins:

1. `thinking.budgetTokens` (Anthropic) or `reasoning.effort` (OpenAI) — an explicit,
   provider-specific setting always beats the generic one.
2. `effort`.

When both are set the explicit one is used and a one-time warning names the tier. Note
that `reasoning.effort` is a *different field* from `effort`: it is the nested OpenAI
knob (`low | medium | high` only) and it is also what `/tiers` renders.

### Provider matrix

| Model family | What is registered | Caveats |
|---|---|---|
| Anthropic (`isClaudeModel`) | `options.effort` verbatim, including `xhigh` and `max`. | Requires the `opencode-anthropic-fix` plugin (commit `307aea9`+ for fable/mythos). Non-adaptive Claude models (e.g. haiku) silently strip `effort` at the API layer, and without that plugin a top-level `effort` can break Claude-Code billing fingerprinting. |
| OpenAI (`openai/…`, `gpt-…`, `o1`/`o3`/`o4`) | `options.reasoning_effort`. | `reasoning_effort` only supports `low`, `medium`, `high`. `xhigh` and `max` are **downgraded to `high`** with a one-time warning per tier+level. |
| Anything else (Google, …) | nothing. | `effort` is dropped with a one-time warning naming the model — the field has no known mapping there. |

Detection is by model *family*, not by provider prefix: `isClaudeModel` matches any
`/claude-` segment and `isOpenAIModel` matches `\bgpt-` (plus `openai/…` and
`o1`/`o3`/`o4`). Copilot-proxied ids therefore land in the rows above —
`github-copilot/gpt-4o` gets `reasoning_effort`, `github-copilot/claude-sonnet-4` gets
`effort`. Only a model matching no family pattern at all falls through to the last row.

Warnings are emitted once per distinct problem (keyed by tier and, where it matters, by
the offending value), because agent registration re-runs on every `config` hook.

---

## Prompt styles (`promptStyle`)

Every tier default prompt ships in two wordings. `promptStyle` picks which one a tier is
registered with. It is a **per-tier** field and lives next to `model` in a preset:

```jsonc
{
  "presets": {
    "anthropic": {
      "heavy": { "model": "anthropic/claude-fable-5", "promptStyle": "auto" }
    }
  }
}
```

| Style | What the tier receives |
|---|---|
| `prescriptive` | The enumerated `tierPrompts[<tier>]` string from `tiers.json` — explicit STOP CONDITIONS, numbered rules. Better for weaker models that need the steps spelled out. |
| `goal-oriented` | A shorter goal + constraints prompt: `tierPromptsGoalOriented[<tier>]` if configured, else the built-in default in `src/router/prompts.ts`, else `tierPrompts[<tier>]`. |
| `auto` (default) | `goal-oriented` when the tier's model matches the strong-model pattern list, otherwise `prescriptive`. |

An explicit `prompt` on the tier still wins over both — `promptStyle` only selects which
*default* applies. A tier with no prompt in either style registers without a system
prompt, exactly as before.

### The `auto` rule

`auto` matches the tier's `model` string against `modelGenerations.strong`, as a
**substring test with case and separators normalized**. Any match makes the model
"strong".

| Field | Type | Default |
|---|---|---|
| `modelGenerations.strong` | `string[]` | `["claude-fable-5", "claude-mythos-5", "opus-4-8", "claude-opus-5"]` |

`strong` is curated per model, not by generation: being a Claude 5.x model does not make a
model strong — `claude-sonnet-5` ships on two tiers and is deliberately left out of the
list. Matching is a substring test with case **and** separators normalized, so `opus-4-8`
matches `opus-4.8`. Setting the key **replaces** the default list rather than extending it,
so `"strong": []` disables auto-detection entirely and every tier falls back to
`prescriptive`. A missing or empty model ID also resolves to `prescriptive` — the rule
fails safe toward the more explicit prompt.

Non-string entries inside the arrays are ignored at match time rather than rejected at
load, so one bad entry in an override file cannot drop the whole layer.

### When a dead pattern is reported

A pattern matching no model your configured providers serve can silently change which
prompt style `auto` picks. `/router models` and the passive startup check report those,
but only when the report is actionable:

| Where the pattern comes from | Reported when |
|---|---|
| `modelGenerations.strong` you wrote | Always — an explicit list is a claim about your environment, so a dead entry in it is yours to fix. |
| The shipped default list | Only when a **near-miss** exists: a served model that matches once `.`, `-` and `_` are normalized away (`opus-4-8` vs a served `opus-4.8`). |

The default list is a cross-provider union, so on any single-provider install most of it
is unserved — `claude-mythos-5` on an anthropic-only setup is not a problem, it is a model
that provider does not sell. Without near-miss evidence there is nothing to act on, so
nothing is said. The separator-drift case is the rename this check exists to catch, and it
is still reported, with the served id named.

Reporting is gated on at least one tier resolving its style by `auto`; with every tier
pinned to an explicit style the pattern list decides nothing.

### Which shipped presets are affected

No bundled preset sets `promptStyle`, so every tier resolves through `auto`. Against the
shipped `tiers.json` that is **seven tiers** now receiving the goal-oriented prompt:

| Preset / tier | Model | Resolved style |
|---|---|---|
| `anthropic.medium` | `anthropic/claude-opus-5` | `goal-oriented` |
| `anthropic.heavy` | `anthropic/claude-fable-5` | `goal-oriented` |
| `github-copilot.heavy` | `github-copilot/claude-fable-5` | `goal-oriented` |
| `hybrid.heavy` | `anthropic/claude-opus-5` | `goal-oriented` |
| `fable-effort.fast` | `anthropic/claude-fable-5` | `goal-oriented` |
| `fable-effort.medium` | `anthropic/claude-fable-5` | `goal-oriented` |
| `fable-effort.heavy` | `anthropic/claude-fable-5` | `goal-oriented` |

Everything else stays `prescriptive`, including `anthropic.fast`
(`claude-sonnet-5` matches no pattern in the list) and all three `zai` tiers
(no `glm-*` id matches a pattern either). To keep the previous wording on
a strong-model tier, set `"promptStyle": "prescriptive"` on it — either in the preset or in
an overrides file.

### Size of the switch

Measured character counts of the two default sets:

| Tier | `prescriptive` | `goal-oriented` | Delta |
|---|---|---|---|
| `fast` | 2072 | 1165 | −907 (−43.8%) |
| `medium` | 2337 | 1530 | −807 (−34.5%) |
| `heavy` | 2459 | 1595 | −864 (−35.1%) |

Both sets keep the same machine-readable contract: the `DONE:` / `NEED MORE:` /
`NEED CONTEXT:` / `SCOPE GROWTH:` / `ESCALATE:` return tokens, the `CAP:N` and `CAP:none`
directives, and the `[cap: N/MAX]` and redundancy markers. The counts are pinned by
`test/unit/prompt-style.test.ts`.

### Overriding the goal-oriented defaults

`tierPromptsGoalOriented` is the goal-oriented twin of `tierPrompts`: a top-level
`Record<string, string>` keyed by tier name, replacing the built-in default for that tier.

```jsonc
{
  "tierPromptsGoalOriented": {
    "heavy": "You are @heavy — your goal is …"
  }
}
```

### Enforcement is unaffected

Prompt text is advisory. Read-only caps come from `tierCaps` (and `DEFAULT_TIER_CAPS`), and
the only text the cap parser reads is the **dispatch text** of a task — never the tier
system prompt. Switching styles cannot change a cap, a banner, or a guard decision; this is
pinned by `test/unit/guard-style-independence.test.ts`.

---

## Resumed dispatches and the cumulative ceiling

### What counts as a resume

A **resume** is a `chat.message` for a session the plugin already tracks **at the same tier**.
That is exactly how an opencode `task_id` resume — re-prompting an existing subagent session
instead of spawning a new one — surfaces to the plugin: the hook sees the same `sessionID`
with the same `agent`. There is no `task_id` field to read; same-session same-tier
re-registration *is* the signal (`src/router/sessions.ts`, `registerFromChatMessage`).

These are **not** resumes:

| Case | Result |
|---|---|
| New `sessionID` (a retry, or an escalation to another tier) | Fresh session — own counters, empty redundancy map |
| Same `sessionID`, **different** tier | Fresh session (the tier changed, so the budget story changed) |
| Same `sessionID` after the idle-TTL sweep evicted it | Fresh session — accepted degradation of the TTL design |
| Message to a non-tier agent | Not tracked at all |

### What a resume does

| State | On resume |
|---|---|
| Per-dispatch cap (`calls`) | **Reset to 0**; the cap is re-parsed from the new dispatch text (including the `CAP:none` justification gate) |
| Redundancy fingerprints (`seen`) | **Preserved** — a re-read across dispatches still emits `[⚠ REDUNDANT: … call #N]` |
| Cumulative read count (`totalCalls`) | **Preserved and still counting** |
| Dispatch count (`dispatches`) | Incremented; reported in trajectory telemetry as `dispatches` |
| Guard state | `beginDispatch()` resets `toolCallCount`; `totalToolCallCount`, fingerprints and deliverable state survive |

### Cumulative ceiling

A resumed session gets a fresh per-dispatch budget every round, so the per-dispatch cap alone
cannot bound it. Both layers therefore carry a cumulative ceiling derived from the
**configured** budget — never a bare constant:

| Layer | Ceiling | Constant | Effect on breach |
|---|---|---|---|
| Read-only caps | `cap × 3`, where `cap` is the **current** dispatch's cap (`tierCaps`/`CAP:N`) | `CUMULATIVE_CAP_MULTIPLIER` in `src/router/sessions.ts` | Appends `[⚠ CUMULATIVE BUDGET EXCEEDED: total/ceiling across N dispatches — return now]` to the banner |
| Hard guard | `guard.budget × 3` | `CUMULATIVE_BUDGET_MULTIPLIER` in `src/guard/enforce.ts` | `cumulative_iteration_cap` — blocks in `enforced` mode, notes in `advisory` |

Because the read-only ceiling follows the *current* cap, a tighter resumed cap makes the
ceiling stricter — a resume can never buy more total budget than it declares. A `CAP:none`
dispatch has no per-dispatch budget to derive from and therefore **no cumulative ceiling**
(the redundancy check still applies). The banner ceiling is also **not emitted for a session
that has never been resumed**: a single dispatch that overruns is already covered by
`CAP REACHED`, so non-resumers see no new banner text at all.

#### Known limitations

- **The banner ceiling is advisory and follows the *declared* cap.** It is derived from the
  cap of the current dispatch, which comes from the dispatch text. An orchestrator that
  resumes with a larger `CAP:N` raises its own ceiling, and `CAP:none` removes it. This is
  not adversarial-proof, by design: banners inform a subagent, they do not block it. The
  **guard layer is the backstop** — `guard.budget` and its `× 3` cumulative ceiling come from
  config, never from dispatch text, and `cumulative_iteration_cap` genuinely blocks the tool
  call in `enforced` mode.
- **Residual: tier-switch re-registration does not reset guard state.** Re-registering the
  same `sessionID` under a *different* tier gives the session store fresh cap state, but the
  guard store keeps the previous state (its per-dispatch `toolCallCount` is not reset, and
  the policy for the new tier is applied to the old counters). The desync errs strictly
  toward over-strictness — the guard can only block sooner, never later — and the case is
  theoretical, since opencode assigns one agent per subagent session. Accepted as a known
  residual rather than fixed, because resetting guard state on a tier switch would also drop
  deliverable/fingerprint history that the guard needs.

### If you never resume

Nothing changes. On a first-and-only dispatch `totalCalls == calls <= cap`, so the cumulative
line is unreachable and every banner is byte-identical to previous versions — pinned by the
golden banner snapshots and by `test/integration/resume-flow.test.ts`.

### `CAP:none` now requires a reason

`CAP:none` is honored only when the dispatch text also contains a `reason:` line. An
unjustified `CAP:none` falls back to the tier baseline cap. The gate is re-applied on every
dispatch, so a justified first dispatch cannot launder an unjustified resume into an uncapped
one. `CAP:N` is unaffected. Prompt rules asked for a reason; this makes it deterministic.

---

### Validation

- `promptStyle` must be one of `prescriptive`, `goal-oriented`, `auto` — a typo throws at load.
- `tierPromptsGoalOriented` must be an object of strings.
- `modelGenerations` must be an object; `strong` must be an array when present.

---

## What the bundled `tiers.json` ships

The bundled file ships an explicit `enforcement` block. **Every value in it equals the
default the code already applied when the key was absent**, so shipping it changed no
behaviour — it only makes the defaults readable and reviewable. `test/unit/enforcement-defaults.test.ts`
pins this: it resolves the real policies from the shipped file and from the same file with
`enforcement` deleted and requires the results to be identical.

| Field | Shipped value | Applied by |
|---|---|---|
| `mode` | `"advisory"` | `src/router/enforcement.ts` — violations are logged, never blocked |
| `envGate` | `"MODEL_ROUTER_ENFORCE"` | `src/router/enforcement.ts` (`DEFAULT_ENV_GATE`) |
| `guard.budget` | `25` | `src/guard/enforce.ts` (`DEFAULT_GUARD_BUDGET`) — per dispatch; the cumulative ceiling across resumes is `budget × 3` |
| `guard.readDraftCap` | `3` | `src/guard/enforce.ts` |
| `guard.sameOpRetryCap` | `1` | `src/guard/enforce.ts` |
| `guard.blockSelfScript` | `true` | `src/guard/enforce.ts` |
| `guard.deliverableFirst` | `true` | `src/guard/enforce.ts` |
| `guard.blockScriptWrites` | `false` | `src/guard/enforce.ts` |
| `verify.minGraderTier` | `null` | `src/verify/wiring.ts` |
| `verify.graderTemperature` | `0` | `src/index.ts` (`chat.params` hook, grader sessions only) |
| `verify.requireExplicitDoD` | `false` | `src/router/protocol.ts` |
| `verify.delegateTimeoutMs` | `600000` | `src/index.ts` (`delegate` producer prompt) |
| `verify.graderTimeoutMs` | `60000` | `src/verify/wiring.ts` (`dispatchGrader`) |
| `verify.gateBudgetMs` | `90000` | `src/index.ts` (`accept()` call in `delegate`) |
| `escalate.ladder` | `["fast","medium","heavy"]` | `src/escalate/ladder.ts` |
| `escalate.floorTier` | `null` | `src/escalate/ladder.ts` |
| `escalate.maxAttemptsPerTier` | `1` | `src/escalate/ladder.ts` |
| `escalate.maxTotalAttempts` | `4` | `src/escalate/ladder.ts` |
| `escalate.costCeiling.multiple` | `4` | `src/escalate/ladder.ts` |
| `proportional.trivialBypass` | `true` | `src/guard/enforce.ts` |

Fields deliberately **not** shipped, because no code reads them and a written-down value
would document a fiction: `verify.require` (no default — see above), `verify.graderPolicy`,
`verify.preferDeterministic`, `proportional.trivialClassifier`, and
`escalate.costCeiling.base`. These are validated when present but never consumed.

### `mode` defaults to `advisory`, and what `enforced` would change

With no `enforcement` block at all, the resolved mode is **`advisory`** — not `off`. In
advisory mode every guard, ladder and verification rule is evaluated and reported in the
scorecard, but nothing is ever blocked or retried.

Changing `mode` to `"enforced"` turns those same evaluations into actions:

- **Guards block.** A call that violates `readDraftCap`, `sameOpRetryCap`, `blockSelfScript`,
  `deliverableFirst`, `blockScriptWrites` or `budget` is refused instead of noted.
- **Verification gates acceptance.** A failed grader or deterministic check makes the
  delegation `unmet` rather than accepted-with-a-note.
- **The ladder escalates.** An `unmet` result retries and climbs `escalate.ladder`, bounded
  by `maxAttemptsPerTier`, `maxTotalAttempts` and `costCeiling.multiple` — which costs real
  tokens that advisory mode never spends.
- **`proportional.trivialBypass` starts mattering.** It only has an effect in `enforced`
  mode, where a task classified trivial is demoted back to advisory for that dispatch.

`MODEL_ROUTER_ENFORCE=1` produces the same effect at runtime without editing the file, and
`=0` forces `off`.

---

## How to enable

Three independent mechanisms; env gate always wins:

1. **Config** — set `enforcement.mode` in `tiers.json` (persisted, version-controlled).
2. **Env var** — `MODEL_ROUTER_ENFORCE=1` (forces `enforced`) or `=0` (forces `off`). Overrides config and `/router` state.
3. **Runtime command** — `/router enforce <off|advisory|enforced>` (written to the router state file; env gate still overrides).

---

## Minimal example

```jsonc
// tiers.json (enforcement block only; all other tier config omitted)
{
  "enforcement": {
    "mode": "advisory",
    "envGate": "MODEL_ROUTER_ENFORCE",
    "perTier": {
      "fast": "off"
    },
    "guard": {
      "readDraftCap": 5,
      "budget": 50,
      "blockScriptWrites": false
    },
    "verify": {
      "require": "whenDoDPresent",
      "graderPolicy": "atLeastProducerTier",
      "graderTemperature": 0
    },
    "escalate": {
      "floorTier": null,
      "ladder": ["fast", "medium", "heavy"],
      "maxAttemptsPerTier": 1,
      "maxTotalAttempts": 4,
      "costCeiling": { "base": "firstAttemptCostUnits", "multiple": 4 }
    },
    "proportional": {
      "trivialBypass": true,
      "trivialClassifier": "dispatchIntent"
    }
  }
}
```

All fields are optional. An empty `{}` or omitted block resolves to the defaults above.
Note this example is **not** the bundled block: `readDraftCap: 5`, `budget: 50` and the
`perTier` override are illustrative non-default values. For what actually ships, see
[What the bundled `tiers.json` ships](#what-the-bundled-tiersjson-ships).
