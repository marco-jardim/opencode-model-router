# Enforcement Configuration Reference

The `enforcement` block in `tiers.json`. Every field is optional; each one falls back to the default listed below, and the bundled `tiers.json` now **ships those defaults explicitly** so they are visible in the file rather than implicit in code — see [What the bundled `tiers.json` ships](#what-the-bundled-tiersjson-ships). Effective mode `off` disables enforcement guards and skips native-task verification; `MODEL_ROUTER_ENFORCE=0` forces that mode. It does not disable the opt-in `delegate` tool: whenever enabled, its produce → verify → accept/escalate pipeline runs in every mode, subject to its verification policy and attempt/cost limits.

> These settings (like anything in `tiers.json`) can also be placed in an overrides file — `~/.config/opencode/opencode-model-router.overrides.jsonc` (global) or `<repo>/.opencode/opencode-model-router.overrides.jsonc` (project) — and are deep-merged over the bundled defaults, so you don't have to edit the cached `tiers.json`. See the **Configuration** section of the README.

**Cross-references:** [ENFORCEMENT.md](./ENFORCEMENT.md) · [VERIFICATION.md](./VERIFICATION.md) · [ESCALATION.md](./ESCALATION.md) · [ENFORCEMENT_PRESETS.md](./ENFORCEMENT_PRESETS.md)

---

## `tiers.json` top-level keys

Everything below this table describes the `enforcement` block. These are the other top-level
keys of `tiers.json`, in the order the bundled file writes them. The router type is
`RouterConfig` in `src/router/config.ts`; `validateConfig` in the same file rejects a file that
gets any of them wrong.

### Per-tier `readOnly`

`presets.<preset>.<tier>.readOnly` is an optional **boolean**, validated by the
`TierConfig` schema/`validateConfig` in `src/router/config.ts`. Missing means
`true` for the name `fast`, `false` for every other tier. All eight bundled
presets explicitly set `fast.readOnly: true`. This policy is independent of
`enforcement.mode`, the environment enforcement gate, and prompt style.

The field is deep/layer-mergeable; a project or global router override can opt out
without restating the model or any other tier field:

```jsonc
{ "presets": { "anthropic": { "fast": { "readOnly": false } } } }
```

Replace `anthropic` with each preset you intend to opt out of. Setting a custom
tier's `readOnly: true` opts it in. Opt-out removes the plugin policy, not any
separate host/user permission restrictions. Prompts still describe exploration;
opt-out does not rewrite them. Non-read-only tier definitions are unchanged.

The policy allows external-directory lookups by default. To tighten that, set
host `agent.fast.permission.external_directory: "deny"` (v1-compatible config),
or append native v2 `agents.fast.permissions` rules with
`{ "action": "external_directory", "resource": "*", "effect": "deny" }`.
Agent-specific resource rules on permitted actions retain precedence as described
in [Read-only tiers](READ_ONLY_TIERS.md). V2 inherited session allows cannot
override agent-own denies or asks; the session grants remain intact for later
medium/heavy resumes. Inherited agent asks are projected onto permitted actions;
broad inherited agent allow-all is dropped. Global-rule
precedence for newly created router agents is unverified: use agent-specific rules.
This changes the default capabilities even when an existing config has neither
`readOnly` nor an enforcement block.

### Top-level key table

| Key | Type | Bundled value | Notes |
|---|---|---|---|
| `activePreset` | `string` | `"anthropic"` | Names the entry of `presets` the router routes with. `validateConfig` rejects a name that is not a defined preset; matching is case-insensitive and trimmed. `/router preset <name>` rewrites it at runtime and persists the choice to the router's state file. A saved choice that no layer defines (for example the removed `hybrid-2` or `fable-effort`) adds one config notice, `the preset '<name>' chosen with /preset is not defined (defined: …); using '<active>'`, and the router keeps the configured `activePreset`; an overrides layer whose own `activePreset` names an undefined preset is dropped as a whole. Read by `getActiveTiers` in `src/router/protocol.ts`, which falls back to the first defined preset, and by the fallback-chain builder. |
| `activeMode` | `string` (optional) | `"normal"` | Names the entry of `modes` layered over the preset. Omit it — or point it at nothing — and no mode is applied. `/router mode <name>` rewrites it at runtime, rejecting a name that `modes` does not define, and persists it. Read by `getActiveMode` in `src/router/protocol.ts`. |
| `presets` | `Record<string, Preset>` | six presets: `anthropic`, `openai`, `github-copilot`, `google`, `hybrid`, `zai` | Each preset maps a tier name (`fast`/`medium`/`heavy`) to its `TierConfig` — `model`, `costRatio`, `steps`, `effort`, and the optional per-tier `prompt`. |
| `rules` | `string[]` | 10 rules | The numbered routing rules rendered verbatim into the `Rules:` line of the delegation protocol. Order is significant: they are emitted `1.`…`N.` in array order. |
| `defaultTier` | `string` | `"medium"` | The tier used when nothing else selects one — no `[tier:X]` tag, no task-pattern match, no mode `defaultTier`. A mode's own `defaultTier` wins over this one; `src/index.ts` falls back to `"medium"` if the key is somehow absent. `validateConfig` requires it to be a string. |
| `taskPatterns` | `Record<string, string[]>` (optional) | `fast`/`medium`/`heavy` keyword lists | Per-tier keyword lists that teach the orchestrator which work belongs to which tier. `buildTaskTaxonomy` in `src/router/protocol.ts` renders them into the protocol's `R:` line, joining each tier's keywords with `/`; an empty or absent object drops that line entirely. |
| `modes` | `Record<string, ModeConfig>` (optional) | `normal`, `budget`, `quality`, `deep` | Named routing profiles. Each is `{ defaultTier, description, overrideRules? }`: `defaultTier` replaces the top-level one while the mode is active, `description` is what `/router mode` prints, and a non-empty `overrideRules` replaces the `rules` list for that mode and also suppresses the multi-phase decomposition hint, which would otherwise conflict with it. `validateConfig` checks the shape of every entry. |
| `tierPrompts` | `Record<string, string>` (optional) | one prompt per tier | Global prescriptive tier prompts. A preset-level `tier.prompt` overrides the entry for that tier. See [Prompt styles](#prompt-styles-promptstyle) for the goal-oriented counterpart. |
| `tierCaps` | `Record<string, number>` (optional) | `fast: 8`, `medium: 5`, `heavy: 3` | Read-only tool-call baselines per tier, enforced at runtime through cap banners. |
| `fallback` | `FallbackConfig` (optional) | `global` chains for the five shipped providers | Provider fallback chains, either `global` (keyed by provider) or `presets` (keyed by preset, then provider). Rendered into the protocol's `Chain:` line. A chain keyed by a provider the active preset never routes to is **dormant by design** and is not validated against the catalog — the shipped chains cover every provider, so on a single-provider install most of them are inert. A chain entry naming a preset that does not exist is still reported, since that is a config error whatever your providers are. |
| `enforcement` | object (optional) | shipped explicitly at the previous defaults | The verification/acceptance layer. Documented in the rest of this file. |

The next keys are **not in the bundled `tiers.json`** — they use in-code defaults and can be overridden.
`validateConfig` accepts them wherever they appear, but absent means the feature is off (or
falls back to its in-code default), so you only ever see them in an overrides file.

| Key | Type | Default when absent | Notes |
|---|---|---|---|
| `delegateInstructions` | `"strip-global" \| "strip-all" \| "keep"` | `"strip-global"` | Instruction-file filtering for delegate sessions only; never changes the orchestrator. See below. |
| `dispatchHeader` | `boolean` | `true` | Prepends mechanical guidance to tier-targeted `task` prompts. See below. |
| `falseRefusalDetection` | `boolean` | `true` | Annotates capability-complaining hand-backs with zero recorded child tool calls. See below. |
| `taskPromptRepair` | `boolean` | `true` | Fills a missing `task` prompt from its description, or refuses the call readably. See below. |
| `tierPromptsGoalOriented` | `Record<string, string>` | built-in goal-oriented prompts in `src/router/prompts.ts` | Goal-oriented twin of `tierPrompts`; an entry replaces the built-in for that tier. See [Prompt styles](#prompt-styles-promptstyle). |
| `modelGenerations` | `{ strong?: string[] }` | `DEFAULT_STRONG_MODEL_PATTERNS` in `src/router/config.ts` | Shared model-ID substring pattern lists. `strong` drives `promptStyle: "auto"` resolution. |
| `subagentTiers` | `Record<string, string>` | `{}` — no pre-existing agent is touched | Opt-in map of your own subagent names to tier names, repointing them at the active preset's model for that tier. Unknown tier names are skipped at resolve time rather than rejected. |
| `antiNarration` | `boolean` | `false` | Adds the anti-narration clause to Claude tier prompts and enables the non-blocking narration detector. |
| `experimental` | `{ verifiedDelegateTool?: boolean }` | `{}` — every experimental feature off | Opt-in features. `verifiedDelegateTool` exposes the independently-verified `delegate` tool, also settable via `MODEL_ROUTER_VERIFIED_DELEGATE=1`. |
| `agents` | `Record<string, PluginAgent>` | `{}` — no router-defined subagent | Subagents defined by the router instead of `opencode.json` (#81). See [`agents`](#agents--router-defined-subagents-81). Only `tiers.json` and the global override may set it. |
| `routing` | object | `{}` — engine `static`, today's behaviour | The cost-aware routing engine (#74): engine mode, profile, margin, classifier, roles, outcome store, session reuse, advisor. Per-tier `candidates` and `escalate.variantSteps` belong to the same feature. See [`routing`](#routing--cost-aware-routing-engine-74). |

---

## `agents` — router-defined subagents (#81)

`agents` registers extra subagents from the router config, on OpenCode 1 and 2, without editing
`opencode.json`. Each runs on the model and variant of a **tier of the active preset**, so it follows
`/preset`. Its mode is always `subagent` and its permissions are always published by the router.

```jsonc
{
  "agents": {
    "reviewer": { "tier": "heavy", "description": "Reviews diffs", "readOnly": true, "allowTools": ["router_git_*"] },
    "runner": {
      "tier": "fast", "description": "Runs the tests",
      "permission": { "read": "allow", "grep": "allow", "shell": { "allow": ["npm test*"], "deny": ["*;*", "*&*", "*|*", "*>*", "*\n*", "*`*", "*$(*"] }, "edit": "deny" }
    }
  }
}
```

| Field | Type | Notes |
|---|---|---|
| `tier` | `string` (required) | A tier of the **active** preset. Model, variant and (by default) `steps` come from it. |
| `description` | `string` (required) | Non-empty. |
| `prompt` | `string` | System prompt, used verbatim (never rewritten for the host vocabulary). |
| `steps` | positive integer | Turn budget; defaults to the tier's `steps`. |
| `readOnly` | `boolean` | Reuses the [#77 read-only policy](READ_ONLY_TIERS.md): deny `*`, then read/glob/grep/`router_git_*`, sensitive-path asks. |
| `allowTools` | `string[]` | Extra actions allowed on top of the policy (MCP tools, `webfetch`, …); wildcards allowed, but only after a literal first character (`web*`, `context7_*`; a leading `*` or `?` such as `*_*` is rejected). `allowTools` can never grant edit (`edit`/`write`/`patch`, including `multiedit` and `apply_patch`), delegation (`subagent`/`task`/`delegate`), Code Mode `execute`, shell (`shell`/`bash`) or `read`: those belong in `permission`. Entries are permission rules only; they are never copied into the legacy `tools` booleans (a host maps `write`/`edit`/`patch` tools to the `edit` permission). |
| `permission` | object | v1-style rules, canonical v2 names (`shell`, `subagent`; `bash`/`task` accepted as aliases). Each action maps to an effect or an ordered `{ pattern: effect }` object (`{ effect: [patterns] }` is accepted too). In the `{ effect: [patterns] }` form the groups are applied in the order written and **later groups win**: `{ "allow": ["npm test*"], "deny": ["*"] }` denies everything, so put the broad deny first or the narrow allow last. `npm test*` also matches `npm test; rm -rf x`, which is why the runner example adds later denies for `;`, `&` (covers `&&`), `|` (covers `||`), `>`, a newline (`"*\n*"`: the host matcher is dotAll, so `*` crosses newlines and a JSON `\n` is a literal newline in the pattern), a backtick and `$(`. The example is illustrative, not a sandbox: shell patterns are permission rules, and other expansions or redirections the list misses still reach the shell.

On a host where the global config also denies an action, the two hosts differ. On v2 the inherited global denies are copied **after** the agent's own rules, so a global `bash: deny` also denies the runner's `npm test`. On v1 the agent's own rule wins. With `readOnly: true` it may only add `deny`/`ask` rules, and never `ask` for shell, edit or delegation. |

An entry needs `readOnly: true` or a `permission`: a router agent never inherits the host's allow-all
defaults. Without `readOnly`, the policy is `* deny`, then `allowTools`, then your `permission`; the
sensitive-path asks are re-applied after every `read` grant. A narrow wildcard `read` grant (anything other than `*`) denies the sensitive globs **globally**, overriding earlier asks and an explicit `*.env: allow`. A later deny stays a deny: plugin agents copy only the *inherited denies* of the host defaults (never its allows), and a monotonicity check on the final rule list verifies that no later rule re-opens an earlier deny; the old `exempt` escape hatch is gone.

### Validation

Per entry, never throwing: an invalid entry is **removed** and reported as a `router: config notice:`
line (key path and file); the other entries, the rest of the layer and `routing` stay in force. Rejected:
unknown keys (`model`, `variant` and `mode` get a specific message: the model follows the tier and the
mode is always `subagent`); names that are invalid (letters, digits, `.`, `_`, `-`, at most 64 characters),
reserved (`fast`, `medium`, `heavy`, every tier of the active preset, `model-router-grader`, `build`,
`plan`, `title`, `summary`, `compaction`); an unknown `tier`; a missing policy; an `allowTools` entry
matching a policy action or starting with a wildcard. A name that collides with a host built-in agent that is not a subagent (v2 setup seed, for example a primary agent) is skipped with the notice `collides with a host built-in agent`. A `tier` the active preset lacks skips the entry for that preset only; a
`/preset` rebuild re-checks it.

### Layer rules (A18)

Only `tiers.json` and the **global** override may define `agents`. A project override
(`.opencode/opencode-model-router.overrides.jsonc`) is stripped of its `agents` block with a notice
(`ignoring agents from <path>: only tiers.json or the global override may define agents (A18)`); the rest
of that layer still applies. A cloned repository must not be able to register agents with permissions.

### Precedence with `opencode.json`

If `opencode.json` also defines `agent.<name>`, it **wins for the fields it sets**; its permission rules are
placed after the router's (last match wins) and its `tools` are merged over ours. A one-time notice says:
`agent <name> is defined both in the router `agents` block and in opencode.json; opencode.json wins for the
fields it sets` (on v2 a name present in the host setup seed reads "a host built-in agent" instead of "opencode.json"). The v2 seed no longer carries the host `description`, so the router entry supplies it.

When the v1 config hook runs again in the same process (a preset refresh, for example), plugin agents it built earlier but that are no longer defined or valid are removed, restoring the `opencode.json` entry if there was one. Detection uses the non-enumerable marker plus a closure record of the names built last run, so it also works when the host hands back a cloned config; a restart simply rebuilds from scratch. One limit: if a name was built with no `opencode.json` entry and the user adds one before the next run, a cloned config cannot tell it from the router's own and it is removed. Validation, registration and `/router` all use one preset resolver (`resolveActiveTiers`: case-insensitive like `/preset`, falling back to the first preset).

### Grep redaction

Grep output is redacted of sensitive-file matches for **every** plugin agent, including explicit-permission ones such as `runner` whenever their rules do not deny `grep`, on v1 (the session is recorded at `chat.message`, since `tool.execute.after` carries no agent) and on v2.

### `agents.<name>.tier` vs `subagentTiers`

`agents.<name>.tier` wins: a `subagentTiers[<name>]` entry for a plugin agent is skipped with a notice.

### `subagentTiers` no longer creates agents

A `subagentTiers` name that is neither an existing agent nor a plugin agent is skipped (once-per-process
notice), never created. Previously it produced an unrestricted agent with only a model (mode `all` on v1, `primary` on v2). On
OpenCode 2 the host registers `opencode.json` agents after the router starts, so the router re-checks at the
first prompt and refreshes once when a pending name appears; the "no such agent" notice is only given after
that first check. Existing agents still get the tier model: on v1 the host built-ins (`general`, `explore`, `build`, `plan`, `title`, `summary`, `compaction`) are known to the router even though they are absent from the config record, so `subagentTiers: { "explore": "fast" }` works; `opencode.json` custom agents do too.
---

## `falseRefusalDetection`

Defaults to `true`; set `falseRefusalDetection: false` to disable. Non-boolean
values are rejected. For `task` results with a child session ID, the first
non-empty line must start with `ESCALATE:`, `NEED MORE:`, `NEED CONTEXT:`,
`SCOPE GROWTH:`, or `BLOCKED:` and the text must complain about capabilities.
Only zero recorded tool calls triggers the advisory `[router] FALSE-REFUSAL SUSPECT`
prefix, recommending retry in the same session, not tier escalation. No automatic
retry occurs. Metadata IDs take precedence over task-wrapper IDs.

Counts are retained internally per child in the existing TTL-managed trajectory
store as `falseRefusalCount`. Existing trajectory metrics and the pinned scorecard
format are unchanged; surfacing the counter on idle is deferred to a follow-up.
Runtime child-ID propagation and complete, correctly ordered child tool events
remain assumptions; zero observed calls does not prove tools were available.

---

## `dispatchHeader`

Defaults to `true`; set `dispatchHeader: false` to restore pre-feature behaviour,
where dispatch hygiene depended on the orchestrator writing it. Non-boolean values
are rejected by `validateConfig`.

The `task` before-hook prepends tier identity, the current project directory,
tool-schema authority, empty-result/gitignore guidance, the read-only budget, and
a zero-tool-call false-refusal notice. It accepts `subagent_type` or `subagentType`
only when the tier belongs to the active preset. Other tools, missing or unknown
tiers, non-string prompts, router bypass, and prompts already beginning with
`[router] You are @` are unchanged. An absent or empty directory omits that paragraph.
The cap follows `tierCaps[tier] ?? DEFAULT_TIER_CAPS[tier] ?? 5`.

Measured using the pure builder's string length: **1,031 characters** for `@fast`,
cap `8`, and cwd `D:\git\opencode-model-router`, including LF paragraph separators
and no trailing newline. The dispatch adds a separate `\n\n---\n\n` separator.
This does not change `assembleSystemPrompt` or its pinned snapshots.

Diagnostic escape hatch: set `MODEL_ROUTER_DISPATCH_DEBUG=1` to append one JSON
record per plugin instance to `opencode-model-router-trajectory/dispatch.log`
under the OS temp directory, recording `headerApplied`, `tier`, and the resulting
`promptLength` without prompt contents. It is silent by default and best-effort.
**Propagation of the mutated before-hook args to the actual child session remains
unverified**; the diagnostic proves hook application, not child receipt.

---

## `taskPromptRepair`

Defaults to `true`; set `taskPromptRepair: false` to restore pre-feature behaviour,
where the harness rejected a prompt-less `task` call with a bare schema error.
Non-boolean values are rejected by `validateConfig`.

The `task` before-hook runs this guard ahead of the dispatch header. A call whose
`prompt` is absent, `null`, or blank has it filled from the trimmed `description`
when that is a non-empty string; the repaired call then proceeds and receives the
dispatch header normally. When there is no usable description the call is refused
with a `[router]` error explaining that `task` needs a non-empty `prompt`, and that
a request carrying no task (a greeting, an acknowledgement) should be answered
directly instead of delegated. Calls with a real prompt, other tools, non-object
args, and prompts of a non-string type are unchanged. Frozen args that cannot be
repaired are left for the harness to reject.

---

## `delegateInstructions`

Controls instruction files injected by opencode into **delegate (child) sessions only**.
The orchestrator's instruction files are never filtered.

- `"strip-global"` (default): removes instruction files outside the project directory and keeps project-local files. If the project directory is undefined or empty, every instruction file is treated as global and removed.
- `"strip-all"`: removes every injected instruction-file block.
- `"keep"`: restores pre-feature behaviour, leaving all instruction files untouched.

opencode injects instruction files into children too. A user's global orchestrator
persona can therefore tell a delegate to delegate work through Task, or obey a
dispatch's REQUIRED TOOLS whitelist, even though that delegate has no task tool.
The default removes that conflict while retaining project-local coding conventions.
Paths are compared case- and separator-insensitively with a directory boundary;
`project-other` is not inside `project`.

Removal is bounded by the instruction file itself. opencode joins the agent prompt,
every instruction file and any trailing system text (such as MCP server
instructions) into one string, so the end of the last block cannot be inferred
from the prompt. For each block to remove, the router reads the absolute path
named on its `Instructions from:` line and removes exactly that marker line plus
the file's contents, provided they are an exact prefix of the text following the
marker (line-ending and trailing-whitespace differences are tolerated). Anything
after the file's contents is kept, and a following marker still caps a block.
File reads are cached per path and revalidated against the modification time.

When in doubt, the block stays. If the file cannot be read, or its current
contents do not match the prompt (for example, it was edited after the session
started), the whole block is left untouched. A leftover instruction is
unhelpful; deleting an unknown span of the system prompt is not recoverable.
Text before the first marker and retained local sections are preserved.

For layout diagnostics, set `MODEL_ROUTER_SYSTEM_DEBUG=1`. On the first child
transform per plugin instance, the router appends the original entry count and
each entry's first 60 characters to `opencode-model-router-trajectory/system.log`
under the OS temp directory. This is silent and inert by default; opt-in previews
may contain instruction text or paths.

---

## `enforcement` top-level fields

| Field | Type | Default | Notes |
|---|---|---|---|
| `mode` | `"off" \| "advisory" \| "enforced"` | `"advisory"` | Global enforcement mode. `off` disables enforcement guards and skips native-task verification. `advisory` warns on guard violations without blocking; `enforced` blocks them. Native-task verification annotates results in both advisory and enforced modes, subject to verification policy. The enabled `delegate` tool's gate, retries, escalation and effort bump run independently of this mode. |
| `maxDelegationDepth` | `integer 1–32 \| null` | `1` | Deepest session a model-initiated dispatch may create; root/orchestrator = depth 0. `null` disables the depth guard. |
| `envGate` | `string` | `"MODEL_ROUTER_ENFORCE"` | Name of the env var that overrides mode at runtime. See env-gate truth table below. |
| `perTier` | `Record<string, "off" \| "advisory" \| "enforced">` | `{}` | Per-tier mode overrides. Keyed by tier name. Overrides base `mode` whenever the env gate is not `"1"` or `"0"` (unset, empty, or any other value). |
| `guard` | object | see below | Request-level hard guards (caps, script controls, budget). |
| `verify` | object | see below | Verification / grading policy. |
| `escalate` | object | see below | Escalation ladder and cost ceiling. |
| `proportional` | object | see below | Trivial-task bypass logic. |

### Delegation depth

`enforcement.maxDelegationDepth` defaults to `1`: only orchestrators may
dispatch in `enforced` mode; in the default `advisory` mode, deeper dispatches
are warned rather than blocked. Set it to `2` to let a delegate dispatch one more level, or `null` to
disable the guard.

A dispatch past the limit is **warned**, not blocked, in `advisory` mode (the
bundled default), with a `[⚠ GUARD:delegation_depth]` banner. It is **refused** in
`enforced` mode and ignored in `off`. To enforce the limit, set
`enforcement.mode: "enforced"` or `MODEL_ROUTER_ENFORCE=1`.
An `enforcement.perTier` entry for the caller's tier overrides `mode` when the
env gate is not `"1"` or `"0"` (unset, empty, or any other value); an `advisory`
entry keeps that tier warn-only. Other non-empty values produce a warning and
fall through to config resolution. The env gate `MODEL_ROUTER_ENFORCE=1`
overrides both to `enforced`, and `MODEL_ROUTER_ENFORCE=0` overrides both to `off`.

For caller depth `d` and limit `max`, the advisory banner is:

```text
[⚠ GUARD:delegation_depth] this session is at delegation depth ${d}; enforcement.maxDelegationDepth is ${max}. In enforced mode this dispatch would have been refused. Do not dispatch further subagents from this session; do that work yourself.
```

The enforced refusal is:

```text
[router] DELEGATION DEPTH LIMIT — this session is at delegation depth ${d}; enforcement.maxDelegationDepth is ${max}, so it cannot dispatch another subagent. Do this part of the work yourself and report the result; do not retry the dispatch.
```

`delegate` returns this refusal as a normal tool result; native `task` (v2:
`subagent`) reports it as a tool error. The depth guard does **not** apply the
`proportional.trivialBypass` downgrade. A caller-tier `perTier: "off"` disables
the guard unless the env gate forces enforcement; `/bypass` disables it on both
dispatch paths.

For accepted and deferred `delegate` results, the depth banner follows the producer
text and precedes the verification suffix or deferred footer. On unmet, safety-net
and failure returns, it is appended last, after the router text and any forcing note.
For native dispatch results, it precedes verification text on v1
and follows it on v2. It is delivered once and is not part of the text graded by
the verifier. V2 retains the host envelope when appending it (see
[OpenCode v2 compatibility](./OPENCODE_V2.md#child-sessions-cancellation-and-verification)).

The guard covers the native `task` tool (including `task_id` resume and OpenCode 2
background dispatches) and the `delegate` tool. Unknown depth caused by a backend
failure or timeout fails open with one warning per caller session. A cycle or a parent chain over
32 hops counts as depth 32. Limits must be safe integers from 1 to 32 so such
chains exceed every configured limit on their next dispatch.

This is a dispatch guard, not a sandbox: shell-spawned `opencode` processes and
other plugins' session-creation tools are outside its coverage.

**OpenCode v1 host limits (spike and host-proof evidence):** the default `general`
agent has no `task` tool, so nesting needs an agent with task permission (see
[Spike A2, R4](./qa/depth-and-effort/phase-0P.md)). The
[plan §1.7 A9](./plans/delegation-depth-and-effort-bump-plan.md) records that the
host otherwise turns the attempted call into its `invalid` tool.
The [Phase 2.3 host proof](./qa/depth-and-effort/phase-2.3.md#handoffs) on OpenCode
1.18.19 used top-level `subagent_depth: 4` to lift a host cap; the cap's default
and upstream documentation are **unverified**. Raising only the router limit does
not lift that cap. The same host proof records that v1 native-path graders run on
the default `build` agent, which has `task`; their depth is recorded at creator
depth + 1, so their own dispatches are subject to the depth guard.

**OpenCode 2 also has a host limit:** `experimental.subagent_depth` in the host's
configuration defaults to `1`. When the router depth guard is enforced, the
effective nesting limit is the **lower of the two limits**. Raising only
`enforcement.maxDelegationDepth` does not lift the host cap, and a top-level
`subagent_depth` is not the v2 setting. The host cap still applies when the router
only warns or is disabled. V2's `general` agent also needs an explicit `subagent`
permission to dispatch at all. See the [host-proof handoff](./qa/depth-and-effort/phase-2.3.md#handoffs).

```json
{
  "enforcement": {
    "mode": "enforced",
    "maxDelegationDepth": 2
  }
}
```

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
| `require` | `"never" \| "whenDoDPresent" \| "always"` | _(unset)_ | When to run a verification pass after production. Has no code-level default: when the key is absent the call sites read `undefined` and decide per dispatch, so the bundled `tiers.json` ships nothing for it. In roles mode `"never"` makes every role dispatch's detection `none` ([Roles delegation](#roles-delegation-84)). |
| `requireExplicitDoD` | `boolean` | `false` | When `true`, a task with no explicit Definition of Done is treated as failing verification. |
| `preferDeterministic` | `boolean` | _(auto)_ | Defaults to `true` whenever the DoD contains runnable checks; omit to let the router decide. |
| `graderPolicy` | `"atLeastProducerTier"` | `"atLeastProducerTier"` | **Only valid value.** Grader tier = `max(producerTier, minGraderTier)` along the ladder; never below the producer. A deterministic check uses no grader. |
| `graderTemperature` | `number \| null` | `0` | Grader sessions only. Numeric values respect v1 host temperature capability and are sent on v2 only for listed models. Set `null` to remove any temperature value, including one set earlier or on a v2 listed model. |
| `graderTemperatureModels` | `string[]` | absent | V2 only: exact `providerID/modelID` entries allowed to receive grader temperature. Absent means none. Override arrays replace, not concatenate; `[]` clears the list. |
| `minGraderTier` | `string \| null` | `null` | Optional floor for the grader tier, independent of producer. `null` means no floor and is identical to omitting the key. |
| `delegateTimeoutMs` | `integer ≥ 1` | `600000` (10 min) | Ceiling for **one** producer `session.prompt` turn in the `delegate` tool. Each ladder attempt gets its own budget. On expiry the child session is aborted and deleted, the attempt is recorded as failed with `producer failed: …`, and the ladder advances — the delegation never fabricates a pass. |
| `graderTimeoutMs` | `integer ≥ 1` | tier-dependent | Explicit override wins over grader-tier defaults: fast `60000`, medium `180000`, heavy/custom `600000` ms, defined in `GRADER_TIMEOUT_MS_BY_TIER` in `src/verify/timeout.ts`. Timeout produces `unverifiable`; the grader is aborted and deleted. |
| `gateBudgetMs` | `integer ≥ 1` | `90000` (90 s) | Deadline for every synchronous verification: one delegate attempt's gate, one required `task` gate, one `router_verify` call. Expiry aborts that invocation's graders and test runs and produces `unverifiable`, not producer failure. Raise this too if a medium/heavy grader should use its full tier timeout. **No longer shipped in the bundled `tiers.json`** (removed; the in-code default applies — set it in an overrides file to change it). |
| `strictUnverifiable` | `boolean` | `false` | Restores the former fail-closed rejection for unavailable verification. It does not buy producer retries or tier escalations. |
| `testScope` | `"affected" \| "full"` | `"affected"` | Which tests a verification runs. `"affected"` runs only the tests related to the producer's changed files (see [Affected-test verification](#affected-test-verification)). `"full"` runs the configured `testsPass` command once, unscoped. |
| `maxWorkers` | `integer ≥ 1` | `2` | Worker cap passed to runners that support one (vitest/jest). |
| `lowPriority` | `boolean` | `true` | Run verification commands at below-normal OS priority. |
| `maxConcurrentVerifications` | `integer ≥ 1` | `max(1, floor(cores / 8))` | Machine-wide verification slots, shared by every opencode process on the machine. `cores` is `os.availableParallelism()`. |
| `slotWaitMs` | `integer ≥ 0` | `60000` (60 s) | Maximum wait for a verification slot (`0` = no wait); a verification that gets no slot in time is `unverifiable`. **Residual (QA-1.4-21):** a lock whose owner is not provably dead is reclaimed only by a caller that waits or stays alive through ~8 s of observation, so a very short wait may give up on a slot that a longer one would reclaim. |
| `baselineTimeoutMs` | `integer ≥ 1` | `15000` (15 s) | Bounds the whole git-only reference capture taken at dispatch. It runs no tests. |
| `captureWaitMs` | `integer ≥ 0` | `5000` (5 s) | Longest wait for the reference capture before the producer starts (`0` = never wait). **Clamped to `baselineTimeoutMs`.** A `VERIFY_WAIT:` directive overrides it per dispatch. |
| `failureRecheck` | `boolean` | `true` | Capture a dispatch-time reference and recheck scoped failures against it. `false` = no reference and no recheck; any scoped failure is then `unverifiable` (accepted with a caveat unless `strictUnverifiable`), never a fail. |
| `recheckTimeoutMs` | `integer ≥ 1` | `60000` (60 s) | Budget for the reference rerun (the recheck). |
| `batchWindowMs` | `integer ≥ 0` | `2000` (2 s) | Coalescing window for concurrent gates (`0` = no batching). The effective window is `min(batchWindowMs, gateBudgetMs / 10)`. |
| `defaultVerify` | `"deferred" \| "required"` | `"deferred"` | Mode for dispatches without a `VERIFY:` directive. See [Deferred verification](#deferred-verification). |
| `background` | `boolean` | `false` | Also run deferred verifications in the background. Opt-in. **Read at plugin start: changing it needs a restart.** |
| `pendingTtlMs` | `integer ≥ 1` | `3600000` (1 h) | How long an unverified delegation stays verifiable. **Read at plugin start: changing it needs a restart.** |
| `testBaseline` | `boolean` | _(none)_ | **Deprecated** (logs a one-time warning whenever the key is present, whatever its value). `false` maps to `failureRecheck: false`; `true` changes nothing; an explicit `failureRecheck` wins. Use `failureRecheck`. |

Verification has three outcomes: `pass` means checks ran successfully, `fail` means
the work did not satisfy a performed check, and `unverifiable` carries the reason
a check could not be performed. The gate accepts when there is no genuine failure,
appending a **Verification caveats — NOT verified** list for every unavailable check;
acceptance does not turn those checks into passes. Such a result is headed
`[router ⚠ UNVERIFIED: <method>]`, never "accepted" or "verified"; only a clean pass
reads `[router ✓ verified: <method>]` (`deterministic` or `checker`). Mixed failure/unavailable results
still reject and may escalate. Strict mode rejects unavailable-only results without
escalation. `run`, build and lint exit failures remain genuine failures. `testsPass`
runs only the affected tests and rechecks their failures against a dispatch-time
reference instead of blaming the producer for every non-zero exit.

### Affected-test verification

A `testsPass` check does **not** run the whole suite, and nothing runs tests at
dispatch. What happens instead:

1. **Scoped run (after the producer returns).** With `testScope: "affected"` (the
   default) the gate runs only the tests related to the producer's changed files:
   `vitest related <files>` / `jest --findRelatedTests <files>`-style related runs
   for JS runners, and the affected test files for pytest. `maxWorkers` caps the
   runner's workers where the runner supports it. With `testScope: "full"` the
   configured `testsPass` command runs **once**, unscoped. Changed files that cannot
   be scoped make the check `unverifiable`, never a silent full run.
2. **Dispatch-time reference (git only).** At dispatch the router records the tree
   with `git stash create` (a commit object holding tracked changes, without
   touching your working tree or stash list) plus copies of untracked files. This
   capture runs no tests and is bounded by `baselineTimeoutMs`; the producer waits
   for it at most `captureWaitMs`. Only when a scoped run **fails** and needs a
   recheck is the reference materialized, as a detached `git worktree` whose
   `node_modules` are linked to the live ones (directory junctions on Windows).
3. **Recheck.** The failing tests are rerun in the reference (bounded by
   `recheckTimeoutMs`). A failure that also fails at an **exact** reference is
   pre-existing and does not count against the producer: the accepted result means
   **"no worse than before," not "the suite is green,"** and says so. An
   approximate or unusable reference (the capture was incomplete, timed out, or the
   rerun could not be planned) makes the check `unverifiable`, not a pass.
   `failureRecheck: false` skips the reference and the recheck.
4. **Machine-wide slot.** Every verification run takes one of
   `maxConcurrentVerifications` slots shared by all opencode processes on the
   machine, runs at below-normal priority when `lowPriority` is `true`, and waits
   at most `slotWaitMs` for a slot (see the QA-1.4-21 residual in the table above).
5. **Batching.** Concurrent gates with the same runner and options that arrive
   within the effective window `min(batchWindowMs, gateBudgetMs / 10)` share one
   run. Each gate still gets the verdict it would have got alone.

Outcomes: a scoped failure that is not pre-existing rejects and can escalate. An
`unverifiable` result is **accepted with a caveat** unless `strictUnverifiable` is
`true`; it is never reported as a pass.

**pytest.** A green pytest run passes. A failing pytest run is always
`unverifiable`: the reference rerun is not supported for pytest, because an
editable install imports the live tree rather than the reference worktree, so the
rerun could not prove anything. A changed module maps to the test files that name
its stem as a whole word (a `git grep -w` content search), plus the tests named after
it. When no test maps to it, or a `conftest.py` names it, the check is
`unverifiable` (`unmapped-module`), never "no affected tests". When `testpaths`
decides the collection, only tests under it are inputs. Only direct importers run: a
test that reaches the module through another source module is not run, and a change
to non-`.py` files alone gives "no affected tests". See
`docs/VERIFICATION.md` → "pytest module mapping".

**Windows.** The reference worktree links `node_modules` with directory junctions,
which need no elevation. A project directory (`ctx.directory`) or `%TEMP%` spelled as
an 8.3 short path (for example `C:\Users\ABCDEF~1\…`) is supported: the recheck
resolves the runner and maps paths with the native realpath. Before Phase 3.1
(QA-2.4-23, E2E-2), every reference rerun on such a setup was unplannable.

**Deprecations.** `testBaseline` is deprecated (`false` maps to
`failureRecheck: false`; a one-time warning is logged).

**Bundled defaults.** The bundled `tiers.json` no longer sets `gateBudgetMs`. The
key is still supported, not deprecated; its in-code default of 90 s (90000 ms)
applies.

### Grader changed-file set

For the LLM grader, the dispatch snapshot is a changed-path set. Grader input is
the child's editing-tool paths union paths newly present in the current changed
set, not the raw dirty tree. The prompt identifies other dirty files as predating
dispatch and permits empty deltas for read-only tasks. Missing snapshots/current
Git state get an explicit disclaimer and only the child edit log. This path-set
delta cannot detect shell edits to an already-dirty path; editing-tool records
cover that case when available. Concurrent work can add paths too: this is not
exclusive attribution in a shared tree.

Refused commands, grader dispatch exceptions/timeouts, gate-budget exhaustion, and
relative file/schema paths without a resolvable working directory are unavailable.
A path resolved against a declared directory or the project root but absent is still
a failure. `buildPasses` honors explicit commands; otherwise it probes `package.json`
for a build script, then root `tsconfig.json` for `npx tsc --noEmit`, else reports
unavailable. No arbitrary `npm run build` is attempted when neither exists.

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

## Deferred verification

**By default an unverified delegation is not checked unless the orchestrator asks
(`router_verify` / `VERIFY:required`) or `background` is enabled.**

With `defaultVerify: "deferred"` (the default), a qualifying delegation returns at
once, marked unverified, with a handle the orchestrator can verify later.

### Which delegations defer

All of these must hold:

- the mode is `deferred`: `defaultVerify` is `"deferred"` and the dispatch carries no
  `VERIFY:required`, or the dispatch carries `VERIFY:deferred`;
- `verify.require` is not `"never"`;
- `router_verify` is registered. This is fixed once at plugin start: `verify.require`
  is not `"never"` **and** (the start-time enforcement mode is not `off` **or** the
  `delegate` tool is enabled);
- the caller is a proven root orchestrator (a subagent cannot defer its own work);
- on the native `task` path, the enforcement mode at dispatch time is not `off` (for
  example after `/router enforce off`);
- the DoD carries a `testsPass` check, and the dispatch is not a trivial dispatch with
  an inferred DoD;
- on the `delegate` path, the producer did not error;
- the producer changed files, **or** the DoD has any check besides `testsPass`, or a
  criterion. Only a `testsPass`-only DoD with an attributed, empty change set falls
  back: the required gate passes it ("no changed files") without running a process. A
  change set that cannot be attributed still defers, with risk `high`.

A DoD with a `testsPass` check defers **as a whole**: its build, lint, `run` and
criteria checks are deferred too, and run only when the handle is verified. This holds
when the producer changed nothing: the delegation is deferred with risk `low` (no
changes attributed), and its build, lint, `run` and criteria checks never run before
the result returns.

Otherwise the dispatch is handled as before deferred verification: the required
(synchronous) gate, or no gate when `require` is `"never"` or, on the native `task`
path, when the enforcement mode at dispatch time is `off`. In particular, a DoD
**without** `testsPass` (for example `buildPasses` or `fileExists` only) is gated
before return in either mode, and its checks run synchronously; `VERIFY:deferred`
does not change that.

When registration fails (for example a handle collision), the delegation falls
back to the required gate. It is never marked accepted or verified by that failure.
In either mode, the dispatch first waits up to `VERIFY_WAIT` (default
`captureWaitMs`, 5 s) for the reference capture before the producer starts. The
deferred return then adds up to 2 s (typically ~0.4–0.5 s) for a git-only snapshot
of the producer's changes.

While that snapshot or capture is still in flight, only tools known not to write
(`NON_WRITING_TOOLS` in `src/verify/dispatch.ts`: read, glob, grep, list, ls,
codesearch, webfetch, websearch, lsp, todoread, todowrite, question, skill,
plan_enter, plan_exit, invalid, task, the MCP resource readers, delegate,
router_verify) leave it alone. Any other tool in that window, MCP and custom tools
included, makes that dispatch's change set unavailable and its reference none, so it
is `unverifiable`, never a pass. A write with no tool event (an external editor) is
not seen. See `docs/VERIFICATION.md` → "Dispatch capture and unknown tools".

### Directives

| Directive | Effect |
|---|---|
| `VERIFY:required` | Gate this dispatch synchronously, whatever `defaultVerify` says. |
| `VERIFY:deferred` | Defer this dispatch (if it qualifies, see above). |
| `VERIFY_WAIT:<n>s` | Wait at most `<n>` seconds for the reference capture before the producer starts (`<n>ms` also accepted). `0` is allowed; the value is capped at `baselineTimeoutMs`. |

Write the keys in upper case. Lower-case keys go through a prose guard and are
often ignored. Directives are parsed **only from the orchestrator's own dispatch
arguments**, never from tool results or a subagent's text: on the native `task` path,
from `prompt`, or from `description` when `prompt` is missing or blank (never both);
on the `delegate` path, from the `task` argument. Because the **first valid occurrence wins**, put the directives
before any quoted text: a quoted `VERIFY:deferred` that appears earlier would win.

### The footer

A deferred result ends with this footer (from `buildDeferredFooter` in
`src/verify/pending.ts`):

```text
[router] unverified · vrf_<24 hex> · risk …
[router] Call `router_verify` with this handle before building on this work if the risk matters.
```

The risk part is the level and up to a few reasons. The router always appends its
footer last, so **only the last `[router]` footer counts**. A producer can print a
fake footer earlier in its text.

### Risk levels

From `src/verify/risk.ts`. The level is the maximum of every matching row, then
row 12 applies once. Rows 1–2 stop evaluation.

| #  | Condition | Level / effect |
|----|---|---|
| 1  | no changed files | low, stop |
| 2  | every changed file is documentation | low, stop |
| 3  | 1–5 changed files | low |
| 4  | 6–15 changed files | medium |
| 5  | 16 or more changed files | high |
| 6  | a test file was deleted, or renamed to a non-test path | high |
| 7  | a test file (incl. snapshots) was modified (added, changed, renamed) | medium |
| 8  | a non-test file was deleted or any file was renamed | medium |
| 9  | config / lock / CI / test-setup file changed | medium |
| 10 | scoping impossible (unverifiable) | medium |
| 11 | producer tier `fast` | medium |
| 12 | no reference captured | +1 step (max high) |

### `router_verify`

Pass **exactly one** of `handles` (the `vrf_` handles from the footers) or
`pending: true` (every still-unverified delegation of the calling session). The
tool runs the same checks as a required verification (affected tests, batched,
under the verification slot) with **one `gateBudgetMs` deadline per call**, and
returns one verdict per handle: pass, fail (with the introduced failures and a
suggested next tier) or unverifiable. Nothing is retried or escalated for you.

Verification runs on the **current** tree, not a copy of the tree as the producer
left it. Drift is checked only on the producer's own files: if any of them changed
since the producer returned, a pass becomes `unverifiable`. Changes to other files
are not detected. Handles live in memory: after an opencode restart they are
unknown. An entry expires after `pendingTtlMs`.

### Pending list

While a session has unverified delegations, the router injects a list into the
orchestrator's system prompt: **at most 5, newest first** (then `... and N more`),
ending with a reminder to call `router_verify` before the final answer.

### `background`

Off by default, opt-in. When `true`, deferred delegations are also verified in the
background at low priority, and foreground test runs preempt them. A background
result that does not pass is shown **once** as a late notice in the orchestrator's
next system prompt (`buildLateNoticeBlock`):

```text
[router] Background verification found introduced failures:
- vrf_… · <description> · failing: <test ids>
[router] Nothing was retried; decide whether to re-dispatch.
[router] Call `router_verify` with a handle for its full verdict; nothing is run again.
```

When some notices are unverifiable rather than failures, the header reads
`[router] Background verification did not pass these delegations:`. A pass
produces no notice. `background` and `pendingTtlMs` are read at plugin start, so
**changing either needs a restart**.

---

## `escalate`

| Field | Type | Default | Notes |
|---|---|---|---|
| `floorTier` | `string \| null` | `null` | Pin the minimum starting tier; skips cheaper rungs. Must be string or `null`. |
| `ladder` | `string[]` | `["fast","medium","heavy"]` | Ordered list of tier names to escalate through. Must be an array of strings. |
| `maxAttemptsPerTier` | `number` | `1` | Same-tier retries after the initial attempt at each rung. Must be integer ≥ 0. |
| `maxTotalAttempts` | `number` | `4` | Hard ceiling across all tiers and retries. Must be integer ≥ 1. |
| `effortBump` | `boolean` | `true` | Retry a failed router-ladder attempt on the same tier one effort level higher before escalating. `false` restores the previous ladder exactly. |
| `effortBumpMax` | `"low" \| "medium" \| "high" \| "xhigh" \| "max"` | `"xhigh"` | Upper bound for bumped attempts, further clamped per model. On v2 it also caps the variant ladders read from the model catalog (see [`escalate.variantSteps`](#escalatevariantsteps)). |
| `variantSteps` | `"auto" \| "none"` | `"auto"` with a `routing` block (v2), else `"none"` | OpenCode v2 only: retry on the same model's next variant before escalating the model. Always `none` on v1. See [`escalate.variantSteps`](#escalatevariantsteps). |
| `costCeiling.base` | `string` | `"firstAttemptCostUnits"` | Reference point for cost ceiling. `"firstAttemptCostUnits"` = cost of the first producing attempt. |
| `costCeiling.multiple` | `number` | `4` | Ceiling = first-attempt cost × multiple. Must be > 0. Further retries/escalation halt once recorded cumulative cost exceeds this. |

> **`floorTier`** is useful when a task is known non-trivial: set `floorTier: "medium"` to skip `fast` entirely.  
> **`costCeiling`** checks cost already recorded after an attempt, not the projected
> cost of the next attempt. An attempt can therefore take cumulative cost over the
> ceiling; the ladder then stops rather than starting another retry or escalation.

### Effort bump before escalation

`enforcement.escalate.effortBump` applies only to the `delegate` tool's automatic
ladder, not native `task` / v2 `subagent` calls or manual re-dispatches. Eligibility
requires all of the following:

- an explicit valid `effort` and no `variant`;
- a recognised Claude or OpenAI model family;
- no explicit setting that wins over `effort`: a truthy `thinking.budgetTokens`
  on a non-adaptive-only Claude model, or `reasoning.effort` on an OpenAI model;
- a base effort below the effective bound (the lower of the model ceiling and
  `effortBumpMax`). A budget dropped by the adaptive-only Claude gate does not
  disqualify the tier.

A failed attempt's existing same-tier retry moves one step through
`low → medium → high → xhigh → max`, up to the bound, before tier escalation.
It adds no retries: `maxAttemptsPerTier`, `maxTotalAttempts`, and the cost ceiling
still apply. Set `effortBump: false` to restore the previous ladder exactly.
Cost remains **ratio-based**, not measured tokens: a bumped attempt is charged
the same tier `costRatio`, even if its actual token use rises. `/bypass` does not
disable the `delegate` ladder or its effort override; use `effortBump: false` to
disable the bump.

`enforcement.escalate.effortBumpMax` caps bumped attempts and is further clamped
per model: OpenAI tiers stop at `high`, while Claude tiers may reach
`effortBumpMax` (default `xhigh`; `max` if configured).
Set it to `"high"` if a Claude model you use rejects `xhigh`.
These are router-side ceilings, not a guarantee of provider acceptance for every
model or proxy. The keyless host proofs establish forwarding, not live-provider
acceptance.

### Where the bump applies with the bundled presets

With the default `effortBumpMax: "xhigh"`:

| Preset | Eligible tiers / effort range | Exclusions |
|---|---|---|
| `anthropic` (active by default) | None | Every tier sets a `variant`. |
| `hybrid` | None | The Anthropic tiers (`fast`, `heavy`) set a `variant`; the OpenAI `medium` tier has no `effort`. |
| `openai`, `github-copilot`, `google`, `zai` | None | No tier sets `effort`. |

No bundled preset has an eligible tier. The bump applies to presets of your own that
set `effort` without a `variant`. These ranges describe eligibility, not a promise to
reach the bound: with the default `enforcement.escalate.costCeiling.multiple: 4` a
failing ladder that starts at the cheapest tier can stop with `cost ceiling exceeded`
before a later tier's bump runs. Raise `enforcement.escalate.costCeiling.multiple` to
allow it. The bump does not itself expand the attempt limits.

```json
{
  "enforcement": {
    "escalate": {
      "effortBump": true,
      "effortBumpMax": "high"
    }
  }
}
```

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
| `"0"` | `"off"` | Hard override. Ignores `mode` **and** `perTier`. |
| unset or `""` | config `mode`, with `perTier[tier]` taking precedence when present | Normal path. |
| any other value | config `mode`, with `perTier[tier]` taking precedence when present | Returns warning: `<gate>="<value>" is not "1" or "0"; ignoring env gate and using config.` |

---

## `routing` — cost-aware routing engine (#74)

The `routing` block configures the cost-aware routing engine: typed task decisions, outcome-calibrated tiers and session-aware effort bumps. It is **entirely optional**. With **no `routing` block at all** every behaviour is exactly that of 2.2.0: identical protocol text, identical `R:` line, identical ladder decisions. `engine: "static"` keeps the protocol text and the `R:` line, but **any `routing` block, even `{ "engine": "static" }` or `{}`, turns variant steps on for OpenCode v2** (`enforcement.escalate.variantSteps` then defaults to `auto`, see below); write `"variantSteps": "none"` to keep the 2.2.0 ladder under a `routing` block. The block lives in `tiers.json` or, like everything else, in an overrides file; the global file `~/.config/opencode/opencode-model-router.overrides.jsonc` is the usual place, and a change to it is picked up by the normal hot reload (no restart, no `/router` command).

This section is the reference: every key, its type, default and range. What the engine does with them (the four modes, the expected-cost formula, the classifier backends, roles, the session-aware ladder, the cost doctor, privacy) is in [`ROUTING_ENGINE.md`](./ROUTING_ENGINE.md); the decisions behind them are in [ADR 0005](./adr/0005-cost-aware-routing-engine.md).

**Host.** The engine, the ladder's variant/session steps, telemetry ingestion and the advisor run on **OpenCode v2** only (D1). On **v1** the block is still parsed and validated, but `routing.engine` is coerced to `static` with one logged line per process, `[model-router] routing.engine ignored on OpenCode v1`, and `enforcement.escalate.variantSteps` is ignored. The single v1 effect, opt-in only, is [`roles`](#roles).

`/router` (the bare status view) prints one marker line with the **applied** engine and the build of the running code: `router: engine=<mode> build=<version>+<sha7>`, e.g. `router: engine=shadow build=2.3.0+3b3dba4` (`unknown` when the checkout has no readable `.git`, or keeps its refs in the `reftable` format, which is not read). On v1 it always shows `engine=static`. Below it, one `router: config notice: …` line per finding of the last config load (unknown `routing` keys, keys dropped from the project layer, `roles` naming a built-in agent, classifier presets that match no preset).

### Keys

Every key is optional. Types and ranges are enforced by `validateConfig`; defaults are applied by `resolveRouting(cfg, host)` in `src/router/config.ts`, the only place they live, and are checked against this table by a test.

| Key | Type | Default | Values / range | Notes |
|---|---|---|---|---|
| `engine` | `string` | `"static"` | `static \| shadow \| advise \| enforce` | See [Engine modes](#engine-modes). Forced to `static` on v1. |
| `profile` | `string` | `"balanced"` | `frugal \| balanced \| safe` | Price of giving up on a task, per risk level, in cost units where `fast = 1`: `frugal` {low 3, medium 8, high 20}, `balanced` {5, 15, 40}, `safe` {10, 30, 100}. |
| `margin` | `number` | `0.2` | `[0, 0.9]` | `enforce` only: the engine replaces the orchestrator's choice only if `C(best) < (1 − margin) · C(chosen)` — **strictly** less: exactly at the boundary the choice is kept, and a `best` equal to the `chosen` is never a switch. |
| `minClassConfidence` | `number` | `0.7` | `[0, 1]` | Below this the engine does not trust the task class: it asks the classifier backend (when one is configured) and otherwise keeps the orchestrator's choice. The extremes: `0` never calls the backend (the rules class is always trusted); `1` calls it on every dispatch, each call bounded by `classifier.timeoutMs`. |
| `detection.deterministic` | `number` | `0.95` | `[0, 1]` | Probability that a wrong result is caught, by verification depth: a deterministic `[acceptance]` check is present. The three values must satisfy `deterministic ≥ grader ≥ none` (a deeper check cannot catch less), compared on the effective values, defaults included. |
| `detection.grader` | `number` | `0.7` | `[0, 1]` | …an LLM grader is scheduled. |
| `detection.none` | `number` | `0.3` | `[0, 1]` | …neither. |
| `classifier.backend` | `string` | `"rules"` | `rules \| host \| openai-compatible \| typesafe` | Where an uncertain task class is decided. `rules` is local and free. The classifier is never an agent and never appears in the protocol. **`host` is experimental** (the plan's live criterion, `source: "host"` for both steps of a batched sample, was not observed; see [Known limits](./ROUTING_ENGINE.md#known-limits-and-experimental-parts)). Examples for Ollama, OpenCode Go and TypeSafe: [Classifier backends](./ROUTING_ENGINE.md#the-classifier-and-its-backends). |
| `classifier.model` | `string \| null` | `null` | `provider/model` or `provider/model#variant` | **Required** (non-empty) whenever the effective backend is not `rules`; the classifier model is never picked automatically. |
| `classifier.baseUrl` | `string \| null` | `null` | `http(s)` URL | **Required** for `openai-compatible` and `typesafe`; validated whenever set. |
| `classifier.apiKeyEnv` | `string \| null` | `null` | environment variable name, `[A-Za-z_][A-Za-z0-9_]*` | Optional; the key itself is never stored in the config. |
| `classifier.timeoutMs` | `integer` | `1500` | `[100, 30000]` | A backend that does not answer in time yields an `unknown` class; it never blocks a dispatch. |
| `classifier.samples` | `integer` | `1` | `1` or `3` | Samples per classification. `3` takes a majority vote and uses the agreement as confidence; the `typesafe` backend ignores it (it returns its own calibrated confidence). |
| `classifier.maxStateChars` | `integer` | `2000` | `[200, 20000]` | The size of the whole state a model backend may see: the description, the first `[acceptance]` block and the prompt head together are cut to this many characters (scrubbed, code blocks replaced by a placeholder); never file contents. See [Privacy](./ROUTING_ENGINE.md#privacy). |
| `classifier.presets` | `Record<string, { backend?, model? }>` | `{}` | each entry as above | Per-preset override of `backend` / `model`. The key is matched to the active preset like `/preset` matches names (exact, then case-insensitive); a key that matches no preset is accepted (switching presets never bricks startup) but noticed. Each entry, merged over the top level, must itself satisfy the model / `baseUrl` rule. |
| `roles` | `Record<string, string[]>` | v2: see [Roles](#roles); v1: `{}` | class → array of agent ids | Classes: `search \| recon \| mechanical \| implement \| debug \| design \| review \| other` (`ROUTING_TASK_CLASSES`). Agent ids match `^[A-Za-z0-9][A-Za-z0-9_./-]*$`, case-sensitive (`ContextScout`, `team/helper`). An empty array means no native candidates for that class. See [Roles](#roles). |
| `outcomes.path` | `string \| null` | `null` | absolute path | Where the outcome store persists. Must be absolute (on Windows: a drive letter, `C:\dir` or `C:/dir`, or a UNC path, `\\server\share`; a rooted `\dir` without a drive is refused); a leading `~` (`~`, `~/dir`) means the home directory and is expanded when the block is resolved. `null` = the directory that already holds the `*.scorecard.log` files. Only the global override may set it (see Trust). |
| `outcomes.halfLifeDays` | `number` | `14` | `[1, 365]` | Older verdicts weigh less. |
| `outcomes.maxEffectiveSamples` | `number` | `50` | `[5, 1000]` | Cap on the effective sample size of one `(class × agent × model#variant)` posterior. |
| `sessionReuse.maxContextFraction` | `number` | `0.6` | `(0, 0.95]` | A retry or escalation resumes the child session only while the next model's input budget has room under this fraction. |
| `advisor.enabled` | `boolean` | `true` | | The cost doctor's findings (the `/router` section) and its notice. Inert without a `routing` block. See [The cost doctor](./ROUTING_ENGINE.md#the-cost-doctor). |
| `advisor.noticeIntervalHours` | `number` | `24` | `[1, 720]` | Hours between cost-doctor checks (never more often than hourly). A notice goes out only when a notice-worthy finding the user was not told about appears, or as a reminder after 7 days; a set that only shrank is not news. |
| `advisor.notify` | `boolean` | `true` | | `false` = never notify; the `/router` section stays. Findings on unmodified tiers of a bundled preset are never notified either way. |

Fully resolved defaults on **OpenCode v2** (this block is parsed by a test and compared with `resolveRouting`, so it cannot drift from the code; on v1 only `roles` differs: `{}`):

<!-- routing-defaults: v2 -->
```jsonc
{
  "engine": "static",
  "profile": "balanced",
  "margin": 0.2,
  "minClassConfidence": 0.7,
  "detection": { "deterministic": 0.95, "grader": 0.7, "none": 0.3 },
  "classifier": {
    "backend": "rules",
    "model": null,
    "baseUrl": null,
    "apiKeyEnv": null,
    "timeoutMs": 1500,
    "samples": 1,
    "maxStateChars": 2000,
    "presets": {}
  },
  "roles": { "search": ["explore"], "implement": ["general"], "debug": ["general"], "review": ["general"] },
  "outcomes": { "path": null, "halfLifeDays": 14, "maxEffectiveSamples": 50 },
  "sessionReuse": { "maxContextFraction": 0.6 },
  "advisor": { "enabled": true, "noticeIntervalHours": 24, "notify": true }
}
```

**Unknown keys** inside `routing` (and its blocks) are ignored, not rejected, like every other block of this file, so a config written for a newer release still loads. They are not silent, though: the path of each one (`routing.margn`, `routing.classifier.bakend`, …) is logged once per process (per message text) through the plugin logger as `ignoring unknown routing keys: …` and listed under the marker in the bare `/router` view as `router: config notice: …`. Only the prototype-reparenting keys `__proto__`, `constructor` and `prototype` are refused. A value of the wrong type or outside its range throws; in an overrides file that drops the layer with a warning, and a reload that turns invalid keeps serving the last valid config and logs why.

### Trust: which file may set what

`routing.classifier.{backend, model, baseUrl, apiKeyEnv, presets}` and `routing.outcomes.path` decide where task text is sent and where outcome data is written, so a file that arrives with a repository must not be able to set them. They are honoured from the bundled `tiers.json` and from the **global** override file only. In the **project-local** override (`<repo>/.opencode/opencode-model-router.overrides.jsonc`) they are dropped before the layers are merged (a `classifier` or `outcomes` block, or a `routing` block, left empty by that is removed too, so a project file whose only `routing` content was forbidden does not switch variant steps on), with one log line per process and text, e.g. `ignoring routing.classifier.baseUrl from <path>: only the global override may set it`; `/router` lists the notice. The HTTP classifier backends additionally refuse to send an API key over plain `http:` to a non-loopback host.

**A35 (A18 budget protection):** a project override may only tighten `routing.classifier.maxStateChars`, `routing.classifier.samples` and `routing.classifier.timeoutMs`. Each effective value is `min(lower-layer value or default, project value)`, with an A18 notice when clamped. A project may still set `routing.engine`, `routing.profile` and `routing.margin`: they choose among the user's configured tiers, and the D9 never-down guards hold in every mode. Other allowed keys still apply normally.

### Engine modes

`engine` is the one switch. Modes are raised one step at a time; each is a config-only change.

**`static`** (default) — the shipped taxonomy only: no decisions are made or recorded, and the protocol text and `R:` line are those of 2.2.0. It is **not** the same as having no `routing` block: the block itself switches `variantSteps` to `auto` on v2 unless you set it to `none`.

<!-- routing-example: static -->
```jsonc
{ "routing": { "engine": "static" } }
```

**`shadow`** — decide and record, change nothing: every dispatch writes a decision row (what the engine would have chosen and why) while the orchestrator's choice stands.

<!-- routing-example: shadow -->
```jsonc
{ "routing": { "engine": "shadow", "profile": "balanced" } }
```

**`advise`** — as `shadow`, and the engine's generated `R:` line and a short per-turn hint reach the orchestrator, which still decides. (The example below uses the experimental `host` classifier backend; leave `classifier` out to stay on the local rules.)

<!-- routing-example: advise -->
```jsonc
{
  "routing": {
    "engine": "advise",
    "profile": "balanced",
    "classifier": { "backend": "host", "model": "opencode-go/deepseek-v4.1-flash", "timeoutMs": 10000 }
  }
}
```

**`enforce`** — as `advise`, and the engine reassigns the dispatch's `model` / `agent` when its choice is cheaper by more than `margin` (strictly), the class confidence reaches `minClassConfidence`, the candidate agent's permissions cover what the task needs, the candidate is not below `floorTier`, and it has at least 5 **effective** outcomes on its own key (decayed by `outcomes.halfLifeDays`, capped by `outcomes.maxEffectiveSamples`) or ranks above the orchestrator's pick. A dispatch carrying `[route pin]` is never switched.

<!-- routing-example: enforce -->
```jsonc
{
  "routing": {
    "engine": "enforce",
    "profile": "balanced",
    "margin": 0.2,
    "minClassConfidence": 0.7,
    "roles": { "search": ["explore"], "implement": ["general"] }
  }
}
```

### Roles

`roles` maps a task class to an ordered list of **agent ids** that are appended, as candidates, to the ladders of the router tiers. The router tiers are always in every ladder; roles only add native or user agents. Class names are one of `search`, `recon`, `mechanical`, `implement`, `debug`, `design`, `review`, `other` (an unknown class is rejected). Agent ids match `^[A-Za-z0-9][A-Za-z0-9_./-]*$` and are case-sensitive host agent names (`ContextScout`, `team/helper`); an id with whitespace, `#` or a leading `-`/`.`/`/` is rejected, and so is anything path-like: an empty, `.` or `..` segment (`a//b`, `a/./b`, `a/../b`) and a trailing `/` or `.`. Duplicates within a class are dropped, order kept. An agent id need not name a tier or an agent of the active preset (it may be a native agent such as `explore`). The built-in primary/internal agents `build`, `plan`, `title`, `summary` and `compaction` cannot be subagents: naming one is accepted (the host's agents are not known at load) but noticed, and the engine skips it. A class may be an **empty array**: no native candidates for that class (this relaxes "non-empty array" so that one class can be switched off without writing `{}`).

- **OpenCode v2, key absent:** the default applies — `{ "search": ["explore"], "implement": ["general"], "debug": ["general"], "review": ["general"] }`.
- **`roles: {}`** disables native candidates (on either host).
- **A `roles` you write replaces the default as a whole.** A class you leave out has no native candidates; there is no per-class merge. The same holds **across override layers**: the highest-priority layer that sets `roles` (project over global over bundled) supplies the entire map; the layers below it contribute nothing to it, and a layer that does not mention `roles` leaves the one below untouched.
- **OpenCode v1:** the default is `{}`. Setting `roles` explicitly is the one opt-in effect on v1, and it is text-only: the static `R:` line lists those agents as destinations for their classes. No model override and no engine.

### Tier `candidates`

A tier may list the `(model, variant, costRatio)` rungs the engine can use for it:

<!-- routing-example: candidates -->
```jsonc
{
  "presets": {
    "anthropic": {
      "medium": {
        "model": "anthropic/claude-sonnet-5-5", "variant": "medium", "costRatio": 5,
        "candidates": [
          { "variant": "medium", "costRatio": 5 },
          { "variant": "high", "costRatio": 8 },
          { "model": "openai/gpt-6-luna", "variant": "high", "costRatio": 9 }
        ]
      }
    }
  }
}
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `model` | `string` | the tier's `model` | `provider/model`. |
| `variant` | `string` | none — the model's default variant | **Not** inherited from the tier. Non-empty, no whitespace, no `#`. |
| `costRatio` | `number` | the tier's `costRatio` (or its conventional default: `fast` 1, `medium` 5, `heavy` 20, other 1) | Must be `> 0`. |

- Without `candidates`, or with `candidates: []`, the tier's ladder is exactly one rung: its own `(model, variant, costRatio)`.
- With `candidates` the ladder is those rungs, **in escalation order**: a failed attempt moves to the next rung. The list **should contain the tier's own rung** (the tier's `model` and `variant`, a variant-less tier being the variant-less entry of its model), because the static choice has to be one of the candidates, and that rung's `costRatio` must equal the tier's or be omitted. This is checked at load but is **not an error**: if the list lacks the own rung or states another `costRatio` for it (for instance after a plugin update changed the bundled tier's variant), the whole list is ignored (and removed from the loaded config, so nothing can read it by mistake), the tier's ladder is just its own rung, and a config notice says so; the rest of your override file still applies. A malformed entry is an error as before. The effective `costRatio` (an omitted one is the tier's) **must not decrease** along the list; equal ratios are fine, and rungs cheaper than the own rung may precede it.
- No two rungs may name the same effective `(model, variant)` once the omitted `model` is filled in from the tier; two variant-less rungs of one model count as the same rung.
- Within one preset a `(model, variant)` has **one `costRatio`**: a candidates list may not quote another ratio for a pair that another tier's own rung or candidates list quotes (the engine prices a candidate by that pair). Only pairs involving an explicit `candidates` entry are compared; the tiers' own rungs among themselves are not (shipped tiers share a model at different effort levels and ratios).
- A tier's own `variant`, when set, must be a non-empty string without whitespace or `#`.
- `resolveCandidates(tierName, cfg)` returns the resolved ladder for the active preset (an unknown tier yields `[]`); `hasExplicitCandidates(tier)` says whether a tier lists any (an empty list counts as none).

### `escalate.variantSteps`

| Field | Type | Default | Notes |
|---|---|---|---|
| `enforcement.escalate.variantSteps` | `"auto" \| "none"` | `"auto"` when the config has a `routing` block, otherwise `"none"` | OpenCode v2 only; an explicit value always wins. Only the **absence of a `routing` block** preserves the 2.2.0 ladder (default `none`); any `routing` block, even `{}` or `engine: "static"`, makes the default `auto` on v2 unless you write `"variantSteps": "none"`. `auto`: a failed verification first retries on the same model's next variant (resuming the child session) before the ladder escalates the model; variant steps do not consume `maxAttemptsPerTier` but do count toward `maxTotalAttempts` and the cost ceiling. `none`: the previous behaviour. Always `none` on v1 (an explicit value is ignored there), where the `effortBump` path stays as is. `resolveVariantSteps(cfg, host)` applies this rule. |

How the variant ladder is built and bounded:

- **Source.** The ladder of a tier is its explicit [`candidates`](#tier-candidates) when it has any, otherwise the variants the live catalog lists for the tier's model, in catalog order.
- **`effortBumpMax` caps catalog ladders.** `enforcement.escalate.effortBumpMax` (default `xhigh`) caps a **catalog** ladder on v2 **independently of `effortBump`**: with `effortBump: false` the cap still applies. With the default, a model whose catalog ladder is `[high, max]` (the live `claude-haiku-4-5`) loses `max` and has the single rung `high`. Set `effortBumpMax: "max"`, or list `max` in `candidates`, to use it. **Explicit `candidates` are not capped.**
- **`variantSteps: "none"` disables both** the variant steps **and** the session resume that goes with them: every attempt starts a fresh child, as in `2.2.0`.
- **A tier that sets both `variant` and `effort`/`thinking`/`reasoning`** has an empty variant ladder (effort is never delivered twice) and stays on the effort-bump path; list `candidates` and drop `effort` if you want variant steps on it. The cost doctor reports it as `variant-effort`.
- **A same-model tier is skipped on escalation** only when the tier already tried covered its base **and** it has no variant above the one reached; a covered tier with headroom is entered at the reached variant. The ladder never re-runs a `(model, variant)` that already failed in the same ladder.
- **Budget reserve.** With variant steps on, a variant step or a plain retry is taken only if `maxTotalAttempts − totalAttempts − 1` is at least the number of tiers above the current one; otherwise the ladder escalates.
- **Resume.** A retry or escalation resumes the child instead of starting a new one while the next model's input budget has room under [`sessionReuse.maxContextFraction`](#keys); the reasons a resume is refused are in [the ladder guide](./ROUTING_ENGINE.md#the-session-aware-ladder).

---

## Roles delegation (#84)

Opt-in, **OpenCode v2 only**. With `routing.delegation: "tiers"` (the default) nothing below has any effect and v2 behaves exactly as before; `routing.exploration.rate` is then `0` whatever it is set to. On v1 these keys are validated but inert, with one logged line per process, `roles delegation requires OpenCode v2; using tiers`, when any of `routing.delegation: "roles"`, `roleAgents`, `routing.exploration`, `routing.run` or `routing.workRoots` is set (logged at plugin start). **Roles mode is decided at plugin start:** role agents, `router_run`, `router_request_authority` and the work-root resolver are registered only when the plugin started with `delegation: "roles"`. Switching to `roles` while OpenCode runs logs one restart notice and registers nothing (tiers mode stays active); switching back to `tiers` drops the role agents at the next agent build, but the role tools stay registered until the next start. Restart OpenCode after either switch. The user guide is [`ROLES.md`](./ROLES.md). A bad entry is dropped with a notice (`/router` lists it); it never drops the layer or the `routing` block. With `delegation: "roles"`, resolving the role table adds its own notices to `/router`, each starting with `roles mode (OpenCode v2 only): ` (they describe what v2 does; on v1 the keys stay inert): an unknown `roleAgents` name, a clamped range or budget, a role disabled by its range or by `deny`, and the #81 `agents` decisions below. If the table cannot be resolved at all, the config still loads and one notice says so: `roles: the role table could not be resolved (<reason>); no role agent will be registered`.

The seven shipped role agents (`explorer`, `researcher`, `runner`, `implementer`, `reviewer`, `architect`, `general`) are defined in code (`SHIPPED_ROLE_SPECS`, `src/router/roles.ts`), not in `tiers.json`, so no configuration can widen their authority. `roleAgents` only narrows them. No role is granted `execute` (Code Mode), `subagent`, `task` or `delegate`, and no grant combines local, exec or write actions with egress (`webfetch`, `websearch`, `context7`).

- **`general` replaces the host's native `general`, in roles mode only.** With `delegation: "roles"` the router registers `general` with its own prompt and policy in place of the host's native agent of that name; in tiers mode and on v1 the native `general` is untouched.
- **Assurance.** `runner` ships `deterministic` (its result is a router-observed run); every other role ships `none`. This default is descriptive only and never enters the routing: a dispatch's effective detection is `deterministic` when the router's gate runs its acceptance checks in the dispatch's work root, else the weaker of the route line's `d=` claim and the prompt's `[acceptance]` block (capped at `grader`), and `none` for every role when the dispatch carries neither. Unlike a tier dispatch, a role dispatch without `d=` is `none` even when its prompt has an `[acceptance]` block (unless the gate runs its checks): write `d=grader` or `d=deterministic` on the route line to claim it. When no verification will run at all, a role dispatch's detection is `none` whatever its claim or block: `enforcement.verify.require: "never"`, enforcement `off`, `/bypass`, or a requested `cwd` outside the root the gate verifies in.
- **#81 `agents` with a role name** (roles mode only; in tiers mode and on v1 they are validated and registered exactly as before). An entry that passes the separation rule replaces the shipped role of that name (notice `agents.<name> replaces the shipped role agent <name> in roles mode`). One that fails it (for example `read` together with `webfetch`, or a read-only agent that also gets the context7 tools) is dropped in roles mode with a notice, and the shipped role stays.
- **#81 `agents` edit-tool keys on OpenCode v2** (every `agents` entry, in either delegation mode). The v2 host checks the `edit` permission for `write`, `patch`, `multiedit` and `apply_patch`, so a `permission` key naming one of them can only narrow it (a deny of the tool's own name removes it) and `edit` decides. A key that allows or asks for something the agent's own `edit` rules deny gets a config notice (the agent is kept; the notice starts ``on OpenCode v2 the host checks `edit` for these tools``), and the tool is not offered there: grant `edit` instead.
- **Tier ranges** are positions in the active preset's cost order (`costRatio`, else listing order). A role keeps the preset's tiers inside its shipped range, starting at the cheapest one: a `fast`/`medium`/`heavy` tier outside the range ends it, and a tier with another name (`mini`) between two of its tiers is kept with the role's smallest shipped budget (notice; `roleAgents.<name>.budget` may raise it to twice that). A role with no tier of the preset inside its range is disabled with a notice. So is a role whose range spans tiers that the preset's `costRatio` orders against their names (say `heavy` cheaper than `medium`): its tier floors are names, and on such an order they would invert, so the role fails closed. The bundled presets are all ordered `fast` < `medium` < `heavy`.
- **`deny` cannot gut a role.** A role left without any action of the class it is defined by (`researcher`: egress; `runner`: `router_run`; every other role: local reads) is disabled with a notice.

| Key | Type | Default | Values / range | Layers |
|---|---|---|---|---|
| `routing.delegation` | `string` | `"tiers"` | `tiers \| roles` | tiers.json, global, project |
| `roleAgents` | `Record<string, object>` | `{}` | keys are shipped role names; unknown names are noticed and ignored | tiers.json, global (stripped from the project layer) |
| `roleAgents.<name>.enabled` | `boolean` | `true` | `false` removes the role; `true` cannot revive a role that is disabled by default | as `roleAgents` |
| `roleAgents.<name>.description` | `string` | shipped text | non-empty, at most 1000 characters | as `roleAgents` |
| `roleAgents.<name>.prompt` | `string` | shipped text | non-empty, at most 20000 characters; always followed by a fixed block, `Router contract (overrides the text above):`, with the work-root rule, the return contract and (roles that can edit) the `ESCALATE: authority` rule | as `roleAgents` |
| `roleAgents.<name>.tierRange` | `{ floor?, ceiling? }` | shipped range | tier names of the active preset; clamped into the shipped range with a notice | as `roleAgents` |
| `roleAgents.<name>.budget` | `Record<tier, number>` | shipped budget | tiers the role already has; `> 0` and at most 2 × the shipped value (clamped with a notice) | as `roleAgents` |
| `roleAgents.<name>.deny` | `string[]` | `[]` | actions to remove: `read \| glob \| grep \| router_git \| router_run \| edit \| webfetch \| websearch \| context7 \| execute`; can only narrow | as `roleAgents` |
| `routing.exploration.rate` | `number` | `0` | `[0, 0.2]` | global only; `0` unless `delegation` is `roles` on v2 |
| `routing.exploration.requireDetection` | `string` | `"deterministic"` | fixed; any other value is ignored with a notice | global only |
| `routing.run.scripts` | `string[]` | `["test", "typecheck", "lint", "build"]` | `package.json` script names `router_run` may run, matched exactly (no wildcards, R9: a `*` entry is dropped with a notice); to run another script such as `test:unit`, list it by name or add a `commands` entry | global only |
| `routing.run.commands` | `Record<string, { argv, args? }>` | `{ "test-files": … }` (below) | `argv`: non-empty array of non-empty strings; `args`: patterns for the caller's arguments | global only |
| `routing.run.timeoutMs` | `integer` | `600000` | `[1000, 3600000]` | global only |
| `routing.workRoots` | `string[]` | `[]` | absolute globs, see below | global only |

**`routing.run.commands`.** `package.json` scripts take no caller arguments, so a run with arguments needs a command entry. The shipped default (replaced as a whole when you set `commands`) is `"test-files": { "argv": ["npm", "run", "test", "--"], "args": ["test/*", "--maxWorkers=*"] }`: a scoped test run through `router_run`'s hardened npm path. `args` lists the arguments a caller may pass: each pattern is an exact string or a prefix ending in `*` (`test/*`); an argument starting with `-` only matches a pattern that itself starts with `-`; an entry without `args` takes none. Every argument must also match `^[A-Za-z0-9_./:=@+-]{1,200}$`. Confinement is enforced by `router_run` itself, whatever the patterns say: an argument with a `..` segment, an absolute, drive or UNC path is refused, and an option-like argument (leading `-`, `@` or `+`) only matches a pattern with the same leading character — so `test/*` admits `test/unit/x.test.ts` but never `test/../../x`. A single-dash argument (`-x…`) carrying any `/`, `\` or `..` is refused as well (a short-option cluster such as `-br../x` can hide a path). `routing.run` has no `envPassthrough` key (removed: it was never wired) and no other credential passthrough: credential-like environment variables (`PGPASSWORD` and `MYSQL_PWD` included) are always stripped from a run. npm pins, `.npmrc` refusals, the run environment and what stays reachable: [`ROLES.md`](./ROLES.md#router_run).

**`routing.workRoots`.** Absolute globs naming where role dispatches may work besides the session directory and the worktrees git lists at registration (for example `D:/git/omr-rta-*`). Each entry needs an absolute static prefix with at least one real directory (`*`, `/**` and `D:/**` are refused), no `.` or `..` segment, and must be written in the **canonical long form**: a segment such as `PROGRA~1` is an 8.3 short name that can alias another directory and is refused, in every segment (`D:/git/OMR-RT~1*` and `D:/git/*/PROGRA~1/x` included). Never put `*` alone. **Over-match:** `*` crosses separators, so `D:/git/omr-rta-*` grants every directory that starts with `omr-rta-`; the registered policy cannot tell dispatches apart, and the router narrows each session to its own work root when it evaluates a permission.

Fully resolved defaults (parsed by a test and compared with `resolveRolesRouting`):

<!-- roles-defaults: v2 -->
```jsonc
{
  "delegation": "tiers",
  "exploration": { "rate": 0, "requireDetection": "deterministic" },
  "run": {
    "scripts": ["test", "typecheck", "lint", "build"],
    "commands": { "test-files": { "argv": ["npm", "run", "test", "--"], "args": ["test/*", "--maxWorkers=*"] } },
    "timeoutMs": 600000
  },
  "workRoots": []
}
```

## TUI status options (OpenCode v2)

**OpenCode v2 only** (2.0.24 or later); inert on v1, which never loads the TUI entry `tui.ts`. These options are not
`tiers.json` or override-file keys: they are the `options` of the plugin's entry in `cli.json`, OpenCode v2's TUI
config file: `<config dir>/cli.json` (for example `~/.config/opencode/cli.json`). Without such an entry the TUI
status is auto-loaded, with the defaults below, whenever the package is listed in the server config (`opencode.json`
`plugins`) and the server entry loads. The entry's `package` is the package name (npm install) or the package
directory (local checkout), never the plugin id `opencode-model-router.status`: an entry whose `package` equals an
already-loaded plugin id is an enable selector, and its `options` are dropped. To turn the status off, set
`enabled: false` or add the selector `"-opencode-model-router.status"` after any explicit entry for the same plugin.
The guide, with examples, is [`TUI_STATUS.md`](./TUI_STATUS.md).

<!-- tui-status-options -->
| Key | Type | Default | Values / range | Controls |
|---|---|---|---|---|
| `enabled` | `boolean` | `true` | `true \| false` | `false` turns every view off |
| `footer` | `boolean` | `true` | `true \| false` | `effort <value>` in the main session's prompt footer (`prompt.footer.status`) |
| `childView` | `boolean` | `true` | `true \| false` | `<agent> · <model> · <effort>` above a delegated session's composer (`session.composer.top`) |
| `runningRow` | `boolean` | `false` | `true \| false` | one row per running delegate above the main session's composer (`session.composer.top`); opt-in |
| `maxRows` | `integer` | `4` | `[1, 20]` | the most running-delegate rows; the rest is `+<k> more` |

The running-delegates rows are opt-in: with the defaults the main session shows only the footer's `effort <value>`;
set `"options": { "runningRow": true }` to show them.

A key with an invalid value keeps its default and an unknown key is ignored; one warning toast names every invalid
and every unknown key, for example
`model-router status: invalid TUI options ("maxRows" must be an integer from 1 to 20); using defaults for those keys`.

## Validation rules

`validateConfig` throws on `tiers.json` load if any of these are violated:

| Rule |
|---|
| `mode` must be one of `off \| advisory \| enforced`. |
| `maxDelegationDepth` must be a safe integer from 1 to 32 or `null`. |
| `verify.graderPolicy` (when `verify` is an object) must be exactly `"atLeastProducerTier"`. |
| `escalate.costCeiling.multiple` must be a number > 0. |
| `escalate.ladder` must be an array of strings. |
| `escalate.maxAttemptsPerTier` must be an integer ≥ 0. |
| `escalate.maxTotalAttempts` must be an integer ≥ 1. |
| `escalate.floorTier` must be string or `null`. |
| `escalate.effortBump` must be a boolean. |
| `escalate.effortBumpMax` must be one of `low \| medium \| high \| xhigh \| max`. |
| `perTier` values must each be `off \| advisory \| enforced`. |
| `guard.budget` must be a number ≥ 1. |
| `guard.blockScriptWrites` must be a boolean. |
| `envGate` must be a non-empty string. |
| `guard.readDraftCap` and `guard.sameOpRetryCap` must each be an integer ≥ 0. |
| `guard.blockSelfScript` and `guard.deliverableFirst` must each be a boolean. |
| `verify.minGraderTier` must be a string or `null`. |
| `verify.graderTemperature` must be a number ≥ 0 or `null`. |
| `verify.graderTemperatureModels` must be an array of non-empty `provider/model` strings, with non-empty provider and model parts; multi-segment model IDs are allowed. |
| `verify.requireExplicitDoD` must be a boolean. |
| `verify.delegateTimeoutMs`, `verify.graderTimeoutMs`, `verify.gateBudgetMs`, `verify.baselineTimeoutMs`, `verify.recheckTimeoutMs` and `verify.pendingTtlMs` must each be an integer ≥ 1 (milliseconds). `0` and negatives are rejected, not read as "no timeout". |
| `verify.maxWorkers` and `verify.maxConcurrentVerifications` must each be an integer ≥ 1. |
| `verify.captureWaitMs`, `verify.slotWaitMs` and `verify.batchWindowMs` must each be an integer ≥ 0 and ≤ 2147483647 (milliseconds). |
| `verify.lowPriority`, `verify.background`, `verify.failureRecheck` and the deprecated `verify.testBaseline` must each be a boolean. |
| `verify.testScope` must be `"affected"` or `"full"`; `verify.defaultVerify` must be `"deferred"` or `"required"`. |
| `proportional.trivialBypass` must be a boolean. |
| A tier's `effort` (when present) must be one of `low \| medium \| high \| xhigh \| max`. Error: `tiers.json: preset '<preset>' tier '<tier>': effort must be one of low, medium, high, xhigh, max`. |
| `escalate.variantSteps` must be `auto` or `none`. |
| A tier's `candidates` (when present) must be an array of objects; `model` (when present) must be `provider/model`, `variant` a non-empty string without whitespace or `#`, `costRatio` a number > 0; no two entries may share an effective `(model, variant)`; the effective `costRatio` must not decrease along the list; within a preset one `(model, variant)` has one `costRatio` (pairs involving a candidates entry). A tier's own `variant` must be a non-empty string without whitespace or `#`. (A list that lacks the tier's own rung, or states another `costRatio` for it, is **not** an error: it is ignored with a notice.) |
| `routing` must be an object; every key of the [`routing` table](#keys) must be of its type and within its range, and a classifier backend other than `rules` needs a `provider/model[#variant]` model (plus an `http(s)` `baseUrl` for `openai-compatible` and `typesafe`) — for the top level and for every `classifier.presets` entry. `roles` classes must be one of `search|recon|mechanical|implement|debug|design|review|other`, agent ids must match `^[A-Za-z0-9][A-Za-z0-9_./-]*$` without `.`/`..`/empty segments or a trailing `/` or `.`, and each class is an array (empty allowed). |

An invalid value in the bundled `tiers.json` throws at load; the same value in an
overrides file is reported via `console.warn` and that override layer is dropped.

---

## Per-tier `effort`

`effort` is an optional, provider-agnostic tier field: one of `low`, `medium`, `high`,
`xhigh`, `max`. It lets one preset run the *same model* at three different reasoning
depths (for example `@fast`=`low`, `@medium`=`high`, `@heavy`=`xhigh`, all on one model),
which keeps the prompt cache warm across tiers because the model string never changes. No
bundled preset does this any more; the removed `fable-effort` preset did (its block is in the
[changelog](../CHANGELOG.md#260---2026-10-09)).

```jsonc
{
  "presets": {
    "one-model": {
      "fast": { "model": "anthropic/claude-fable-5-1", "effort": "low" }
    }
  }
}
```

**When `effort` is unset, it registers nothing.** There is no implicit default or
"normal" value written to the agent's `options.effort` / `options.reasoningEffort`.
Explicit `reasoning.*` or `thinking` fields can still register their own options.

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
| OpenAI (`openai/…`, `gpt-…`, `o1`/`o3`/`o4`) | `options.reasoningEffort`. | The router emits `low`, `medium`, or `high`: `xhigh` and `max` are **downgraded to `high`** with a one-time warning per tier+level. |
| Anything else (Google, …) | nothing. | `effort` is dropped with a one-time warning naming the model — the field has no known mapping there. |

Detection is by model *family*, not by provider prefix: `isClaudeModel` matches any
`/claude-` segment and `isOpenAIModel` matches `\bgpt-` (plus `openai/…` and
`o1`/`o3`/`o4`). Copilot-proxied ids therefore land in the rows above —
`github-copilot/gpt-4o` gets `reasoningEffort`, `github-copilot/claude-sonnet-4` gets
`effort`. Only a model matching no family pattern at all falls through to the last row.

Warnings are emitted once per distinct problem (keyed by tier and, where it matters, by
the offending value), because agent registration re-runs on every `config` hook.

**V1 behaviour change:** registration now uses provider-native `reasoningEffort`,
`reasoningSummary`, and `thinking: { type: "enabled", budgetTokens }`. Previously
the snake-case registration keys were silently dropped on v1; configured reasoning
or thinking may now increase cost/latency or expose provider incompatibilities,
including on proxied or unrecognised model families. Remove `effort`, `reasoning.*`
or `thinking` from an affected tier if necessary. User-facing `reasoning.effort`,
`reasoning.summary`, and `thinking.budgetTokens` are unchanged. See the
[CHANGELOG](../CHANGELOG.md) for the registration fix and affected cases.

### Provider gate for explicit `thinking` and `reasoning` fields

The matrix above describes what happens to the **generic** `effort` field. The two
explicit provider-specific fields are gated too, but only for Claude models
(`isClaudeModel`), in `buildAgentOptions` (`src/router/agent-options.ts`).
“Claude” here is whatever `isClaudeModel` accepts, including proxied spellings such as
`github-copilot/claude-…` and `openrouter/anthropic/claude-…`; on those tiers
`reasoning.*` is dropped as well, matching how the `effort` matrix above already routes
them to the Anthropic column.
See [PER_TURN_EFFORT.md](./PER_TURN_EFFORT.md) for how this meets Claude Code 2.1.280's per-turn effort and the bundled `@heavy` tier.

| Configuration | What is registered | Warning (once per tier) |
|---|---|---|
| `thinking.budgetTokens` on an adaptive-only Claude model (below) | nothing — the budget is ignored as if unset, so a sibling `effort` is still registered | the model only accepts adaptive thinking and rejects a manual budget, so `thinking.budgetTokens` is ignored; use `effort` instead |
| Truthy `thinking.budgetTokens` on any other Claude model | `options.thinking = { type: "enabled", budgetTokens }` | none |
| `reasoning.effort` / `reasoning.summary` on any Claude model | nothing — both are OpenAI parameters | `reasoning.effort` and `reasoning.summary` are ignored for the Claude model; use `effort` instead |

The adaptive-only set is `isAdaptiveOnlyClaudeModel` in `src/router/protocol.ts`: the
Anthropic models whose catalogue entry carries `rejects_disabled_thinking` in
claude-code-wire-compat's 2.1.280 profile — `claude-opus-5-5`, `claude-fable-5`,
`claude-fable-5-1` and `claude-mythos-5-1`. Neighbours are not in it: `claude-opus-5`
and `claude-mythos-5` still register a budget. Matching is exact on the model name
(after any provider prefix, with dots read as dashes), optionally followed by a date
stamp (`-YYYYMMDD`, or the Vertex `@YYYYMMDD` form) and a bracketed tag such as `[1m]`.
Any other suffix — `-preview`, `-latest`, a Bedrock `-v1:0` — is not matched, and such a
tier keeps registering its budget as before: the gate fires only on a positive match.

The reason for the budget rule is a **newer upstream constraint**. Anthropic's
`claude-opus-5-5` has adaptive thinking always on: `{"type": "disabled"}` is rejected (the
wire-compat catalogue records this as `rejects_disabled_thinking`), and a manually
supplied thinking budget is **reported to be rejected with HTTP 400** — a report this
repository has not reproduced (see [PER_TURN_EFFORT.md](./PER_TURN_EFFORT.md)). Effort
on that model is expressed through `effort` / `output_config.effort`, never through a
token budget. The bundled `anthropic` preset already points `@heavy` at
`anthropic/claude-opus-5-5`, so a tier written as:

```jsonc
{
  "presets": {
    "anthropic": {
      "heavy": {
        "model": "anthropic/claude-opus-5-5",
        "thinking": { "budgetTokens": 32000 }
      }
    }
  }
}
```

registers no `thinking` option and logs the adaptive-thinking warning once. The budget no
longer outranks `effort` on these models: a tier that sets both registers its `effort`
and warns only about the ignored budget, not about a conflict.

**Guidance:** on Anthropic tiers use `effort`, not `thinking.budgetTokens`. Reserve
`thinking.budgetTokens` for older Anthropic models that still accept an explicit budget,
and reserve `reasoning.*` for OpenAI tiers.

**Remaining limitation:** the gate is Claude-only. On non-Claude tiers the explicit
fields are still passed through unchecked — `thinking.budgetTokens` on an OpenAI or
Google tier still registers `options.thinking = { type: "enabled", budgetTokens }`, and
`reasoning.*` on a Google tier still registers `options.reasoningEffort` /
`options.reasoningSummary`. Provider acceptance of those options is unverified.
A model id that `isClaudeModel` does not recognise
(for example a dotted Bedrock namespace, `us.anthropic.claude-…`) is not gated either.

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
shipped `tiers.json` that is **three tiers** now receiving the goal-oriented prompt:

| Preset / tier | Model | Resolved style |
|---|---|---|
| `anthropic.heavy` | `anthropic/claude-opus-5-5` | `goal-oriented` |
| `github-copilot.heavy` | `github-copilot/claude-fable-5-1` | `goal-oriented` |
| `hybrid.heavy` | `anthropic/claude-opus-5-5` | `goal-oriented` |

Everything else stays `prescriptive`, including `anthropic.medium`
(`claude-sonnet-5-5` matches no pattern in the list) and all three `zai` tiers
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
| `maxDelegationDepth` | not shipped; code default `1` | `src/router/config.ts` (`resolveDepthLimit`) |
| `escalate.effortBump` | not shipped; code default `true` | `src/router/config.ts` (`resolveEffortBump`) |
| `escalate.effortBumpMax` | not shipped; code default `"xhigh"` | `src/router/config.ts` (`resolveEffortBump`) |
| `envGate` | `"MODEL_ROUTER_ENFORCE"` | `src/router/enforcement.ts` (`DEFAULT_ENV_GATE`) |
| `guard.budget` | `25` | `src/guard/enforce.ts` (`DEFAULT_GUARD_BUDGET`) — per dispatch; the cumulative ceiling across resumes is `budget × 3` |
| `guard.readDraftCap` | `3` | `src/guard/enforce.ts` |
| `guard.sameOpRetryCap` | `1` | `src/guard/enforce.ts` |
| `guard.blockSelfScript` | `true` | `src/guard/enforce.ts` |
| `guard.deliverableFirst` | `true` | `src/guard/enforce.ts` |
| `guard.blockScriptWrites` | `false` | `src/guard/enforce.ts` |
| `verify.minGraderTier` | `null` | `src/verify/wiring.ts` |
| `verify.graderTemperature` | `0` | `src/index.ts` (`chat.params`, grader sessions only; respects v1 host capability); v2 filtered by the allowlist below |
| `verify.graderTemperatureModels` | absent | `src/compat/v2-hooks.ts` (context hook; v2 grader temperature exact-model allowlist, absent means none) |
| `verify.requireExplicitDoD` | `false` | `src/router/protocol.ts` |
| `verify.delegateTimeoutMs` | `600000` | `src/index.ts` (`delegate` producer prompt) |
| `verify.graderTimeoutMs` | fast `60000` / medium `180000` / heavy/custom `600000` | `src/verify/timeout.ts` (`graderTimeoutMs`), consumed by `dispatchGrader` |
| `verify.strictUnverifiable` | `false` | `src/verify/gate.ts` |
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
`verify.gateBudgetMs` was removed from the bundled file; its in-code default (`90000`)
still applies, as do the defaults of the other §1.4 `verify` keys (see the `verify` table).
Also not shipped, but resolved by code rather than unread: `maxDelegationDepth`
defaults to `1` in `resolveDepthLimit`, and `escalate.effortBump` / `escalate.effortBumpMax`
default to `true` / `"xhigh"` in `resolveEffortBump`.

### `mode` defaults to `advisory`, and what `enforced` would change

With no `enforcement` block at all, the resolved mode is **`advisory`** — not `off`.
Advisory guards warn rather than block. Native `task` (v2: `subagent`) verification
annotates completed results in both advisory and enforced modes; it cannot automatically
retry a native call that has already finished. Enforcement `off` skips that native verification.

The optional **`delegate` tool's acceptance gate and automatic ladder are independent
of enforcement mode**: they run in `off`, `advisory` and `enforced`, subject to the
verification policy (including `verify.require: "never"` and deferred verification).
Failed verification can retry and climb `escalate.ladder` in any of these modes,
bounded by `maxAttemptsPerTier`, `maxTotalAttempts` and `costCeiling.multiple`.
With `escalate.effortBump` enabled, an eligible same-tier retry raises effort up to
`escalate.effortBumpMax` (further clamped per model), within those same limits.
These retries spend tokens even in advisory mode. Deferred results do not retry,
and unavailable verification does not trigger producer escalation.

Changing the effective mode to `"enforced"` changes guard behaviour:

- **Guards block.** A call that violates `readDraftCap`, `sameOpRetryCap`, `blockSelfScript`,
  `deliverableFirst`, `blockScriptWrites` or `budget` is refused instead of noted.
- **The depth guard refuses.** Dispatches past `maxDelegationDepth` are refused
  instead of warned (`null` disables this guard).
- **`proportional.trivialBypass` starts mattering.** It only has an effect in `enforced`
  mode, where a task classified trivial is demoted back to advisory for that dispatch.
  The delegation-depth guard is explicitly exempt from this downgrade.

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
