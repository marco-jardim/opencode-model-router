# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- README: 90-second demo video below the title.

### Removed

- **Breaking (requirement): Node.js 20 is no longer supported.** Node.js 20 reached end-of-life in April 2026; the
  minimum is now Node.js 22 (`engines.node` is `>=22`, and the CI matrix runs Node 22 and 24).

## [2.6.1] - 2026-10-09

### Fixed

- **OpenCode v1 no longer drops `agent.<tier>.permission` and `.tools` for `@medium` and `@heavy`.** The v1 `config`
  hook replaced the user's `opencode.json` entry wholesale for every non-read-only tier except `fast`; it now keeps
  the user's `permission` and `tools` for every non-read-only tier (#97). Output without user entries is unchanged,
  and v2 was already correct.

## [2.6.0] - 2026-10-09

### Changed

- **Bundled `anthropic` preset values.** `@fast` is now `anthropic/claude-haiku-5-5` with variant/effort `medium`
  (was `low`); `@medium` is now `anthropic/claude-sonnet-5-5` with variant/effort `high` (was `medium`). `@heavy` is
  unchanged.
- **Bundled `hybrid` preset values.** `@fast` is now `anthropic/claude-haiku-5-5` with variant and effort `medium`
  (was OpenAI `gpt-6-luna-fast`); `@medium` is now `openai/gpt-6.1-sol-fast` with variant `xhigh` and no `effort`
  (was `gpt-6-astra-fast`). `@heavy` is unchanged.
- **A preset chosen with `/preset` that no layer defines is now reported.** The config load adds one notice,
  `the preset '<name>' chosen with /preset is not defined (defined: …); using '<active>'`, and keeps routing on the
  configured `activePreset` (OpenCode v1 and v2 alike, since both load the same config). An overrides file whose own
  `activePreset` names an undefined preset still drops that whole layer, as before.

### Removed

- **Bundled presets `hybrid-2` and `fable-effort`.** The bundled presets are now `anthropic`, `openai`,
  `github-copilot`, `google`, `hybrid` and `zai`.

  **Migration.** If you use `hybrid-2` or `fable-effort`, or want the previous `hybrid` values back, copy that block
  into `presets` in `opencode-model-router.overrides.jsonc` and keep `activePreset` pointing at it. The 2.5.0
  `fable-effort` block:

  ```jsonc
  {
    "presets": {
      "fable-effort": {
        "fast": {
          "readOnly": true,
          "model": "anthropic/claude-fable-5-1",
          "effort": "low",
          "costRatio": 1,
          "description": "Fable 5 at low effort for exploration, search, and simple reads (token-spend ratios are estimates; same model across tiers preserves prompt cache)",
          "steps": 30,
          "whenToUse": [
            "Codebase exploration and search",
            "Simple file reads and listing",
            "Grep/glob operations",
            "Quick lookups and research"
          ]
        },
        "medium": {
          "model": "anthropic/claude-fable-5-1",
          "effort": "high",
          "costRatio": 3,
          "description": "Fable 5 at high effort for implementation and standard coding (costRatio is an estimated token-spend multiplier, not a price difference)",
          "steps": 50,
          "whenToUse": [
            "Feature implementation",
            "Refactoring",
            "Writing tests",
            "Bug fixes"
          ]
        },
        "heavy": {
          "model": "anthropic/claude-fable-5-1",
          "effort": "xhigh",
          "costRatio": 6,
          "description": "Fable 5 at xhigh effort for architecture, complex debugging, and security (costRatio is an estimated token-spend multiplier, not a price difference)",
          "steps": 120,
          "whenToUse": [
            "Architecture decisions",
            "Complex debugging (after 2+ failures)",
            "Security review",
            "Performance optimization"
          ]
        }
      }
    },
    "activePreset": "fable-effort"
  }
  ```

  The 2.5.0 `hybrid-2` block and the previous `hybrid` block are in `git show v2.5.0:tiers.json` (or in the 2.5.0
  package's `tiers.json`); copy a block under its own name. For the previous `hybrid`, use a new name (for example `hybrid-2-5-0`) and set`n  `activePreset` to it: preset overrides merge key by key, so a block copied under `hybrid` would keep keys the new`n  bundled tiers set and the old ones do not (the new `@fast` has `effort: "medium"`).

  **Define the preset in the same file as `activePreset`.** An overrides file whose `activePreset` names a preset no
  layer defines is dropped as a whole layer, so its other settings are lost too. A preset you last chose with
  `/preset` and that is no longer defined only produces the notice above and routes on the configured `activePreset`.

## [2.5.0] - 2026-10-09

### Added

- **OpenCode v2 TUI status (#90).** The package ships a TUI entry, `tui.ts` (plugin id `opencode-model-router.status`),
  that OpenCode v2 (2.0.24 or later) auto-loads for every package listed in `opencode.json` `plugins` when the server
  entry loads. The main session's prompt footer shows `effort <value>` when no variant is selected; a delegated
  session's view shows `<agent> · <model> · <effort>` above the composer. Opt-in (off by default, so the main session
  shows only the footer's effort): with `"options": { "runningRow": true }` the main session lists running delegates
  above the composer, one `<agent> · <model> · <effort>` row each, at most `maxRows`, then `+<k> more`. Options
  `enabled`, `footer`, `childView`, `runningRow` and `maxRows` go in OpenCode v2's TUI config file `cli.json`; turn it
  off with `enabled: false` or `"-opencode-model-router.status"`. The v2 server plugin answers the plugin rpc
  `opencode-model-router.effort` (`effortOf`) with the effort each session's latest turn carried; while it has no
  answer, the footer shows `effort default` and the delegate rows show the message's variant. Inert on OpenCode v1,
  which never loads `tui.ts`. See [TUI status](docs/TUI_STATUS.md).

### Changed

- OpenCode v1 support is in feature freeze: v1 keeps working and gets fixes for regressions and security issues only;
  every new feature targets OpenCode v2 and stays inert on v1 (at most one notice, no behaviour). See
  [AGENTS.md](AGENTS.md#host-support-policy).

## [2.4.0] - 2026-10-09

Role × tier × assurance delegation (#84), opt-in on OpenCode v2: role agents, tier floors from authority × detection,
validated work roots, `router_run` and work-root-scoped `router_git_*`, and outcome signals from external verification
only. OpenCode v1 is unchanged apart from the changes listed below; the roles keys are validated and inert there. See
[Roles mode](docs/ROLES.md) and [ADR 0006](docs/adr/0006-role-tier-assurance-delegation.md).

**Upgrade notes.** Read these entries under [Changed](#changed) before upgrading:

- **Breaking (behaviour): `fast` is now host-enforced read-only on v1 and v2 (#77).**
- The #84 behaviour change: guard and verification fixes for every host and mode, OpenCode v1 included.
- Its **Downgrades** item: downgrading past this version is unsupported.

### Added

- **Roles mode: role × tier × assurance delegation (#84), OpenCode v2, opt-in.** With `routing.delegation: "roles"`
  the orchestrator dispatches seven role agents — `explorer`, `researcher`, `runner`, `implementer`, `reviewer`,
  `architect`, `general` — and the router picks the tier and the per-call model of every dispatch. Decided at plugin
  start: restart OpenCode after switching. See [Roles mode](docs/ROLES.md) and
  [ADR 0006](docs/adr/0006-role-tier-assurance-delegation.md).
  - Role contracts in code (`SHIPPED_ROLE_SPECS`): maximum authority, tier range, a descriptive default assurance,
    guard profile, call budget per tier; `roleAgents.<name>` (global only) can only narrow them. A role whose tier
    range the active preset's `costRatio` orders against the tier names is disabled with a notice.
  - Least privilege with capability separation: no grant mixes local, exec or write actions with egress; Code Mode
    `execute`, shell and delegation are denied to every role; `researcher` is web and docs only.
  - Tier floor from authority × effective detection (`authorityFloor`): edits reach `fast` only behind the router's
    own deterministic checks on a low-risk single-file change; edit + run never below `medium`. After a verification
    FAIL of a role child the router raises its tier on the next resume itself; the orchestrator never sets `tier=`
    or `model`.
  - Dynamic authority for `implementer` and `general`, with nonce-exact binding and a resume-based ladder
    (`router_request_authority` → `ESCALATE: authority` → resume the same session; widening only for exact bindings).
  - Work roots: `root=` on the route line (a git worktree of the repository) and `routing.workRoots` globs; the router
    narrows each session to its own root. A role dispatch's acceptance checks run in its work root; a `cwd:` outside
    it is refused. Role `edit` needs a validated work root (on the authority ladder too) and never falls back to the
    session or plugin directory; it never writes `.git` or anything below it, through any host edit tool.
    `router_git_*` are limited to the work root (a pathspec for a work root below the repository's top level) and are
    refused for a repository other than the dispatch's or a `.git` pointer to a network or device path. The
    `git worktree list` runs that validate work roots inherit the user's `safe.directory` values.
  - `router_run`: `package.json` scripts listed by exact name and `routing.run.commands` with fixed argv, argument
    patterns, pinned npm script shell and config files, refused `.npmrc` keys and a credential-stripped environment;
    single-dash arguments carrying `/`, `\` or `..` are refused. A network or device `cwd` is refused before any
    filesystem call. Credential-like variables (`PGPASSWORD`, `MYSQL_PWD` included; `PWD` and `OLDPWD` kept) are
    always stripped: `routing.run` has no passthrough option.
  - Role budgets (`budget=` up to 2×; a resume without `budget=` keeps the previous one), `NEED MORE: budget` with a
    `[router budget]` resume note, never a tier penalty. Role agents' host `steps` = 2 × max(the top role budget, 25)
    + `REFUSAL_CAP` (10) + 5. A dispatch that a floor lifts above its role's ceiling, on a tier the role has no budget
    for, gets max(the role's budget for its ceiling tier, 25). The cumulative ceiling is 3 × the largest round budget
    the child had. A role dispatch has a read-only call cap only when it carries `CAP:N` or `CAP:none`. A
    `subagentTiers` entry for a role name gives that role's children the mapped tier's default read-only cap (and, for
    `fast`, the trivial-dispatch bypass): remove such entries in roles mode.
  - Refused calls of a role child — role-authority refusals and structured host permission denials — count toward
    `denied_cap` in `advisory` mode too (`advisory` still never stops). In `advisory` mode a child out of budget that
    returns `NEED MORE: budget` records a `budget` signal and the parent's result gets the `[router budget]` note.
  - Resumes of a role child keep the dispatch's class and needs (risk and scope: the max of both), its `[acceptance]`
    block, `VERIFY:` lines and `d=` claim; a new block replaces them. Carried checks run at the resume's return (never
    deferred) on the child's cumulative changes, and are unverifiable when the attempt that introduced them was never
    gated. An authority request widens the grant only when the resuming session is the dispatch's parent, never on a
    delegate's resume.
  - A role dispatch's detection is `none` when no verification will run (enforcement `off`, `/bypass`,
    `verify.require: "never"`, a `cwd` outside the root the gate verifies in).
  - Dynamic roles: a route-line `needs=` replaces the needs the text implies (the listed needs plus the route class's
    implied needs, always inside the role max), and `class=` without `needs=` keeps the text's needs plus that class's
    implied needs, dropping those of the class it replaced; a role dispatch is classified in its work root. Decision rows carry
    `trace.needTerms` (vocabulary labels, `term-<n>`, `url`, `path`, never free task text).
  - In a role dispatch's result, child lines starting with `[router` are defanged to `(router`, so only the router's
    notes start with `[router`.
  - Outcome signals from external verification only (deterministic/run 1, independent grader 0.5, incomplete 0.5,
    re-dispatch 0.5, `DONE` alone 0; the `run` signal matches npm-script-form checks only and counts only the current
    attempt's runs). Only verdicts (deterministic, and independent graders at 0.5) move the outcome store the kernel
    reads; `run`, `incomplete` and `redispatch` rows are routing statistics only. An LLM grader's verdict of
    a role dispatch moves the outcome store by 0.5 with a `grader` signal row only when the grader is independent
    (tier ≥ the producer's, another model); any other grader records nothing (no store change, no verdict row), so
    `routing:stats` shows fewer verdict rows for role dispatches. Role × tier statistics and the advisor findings
    `role-separation`,
    `roles-on-legacy-host`, `role-budget-low`, `role-range-clamped`, `role-binding-unknown`,
    `native-explore-aliased`, `roles-none-enabled`, `role-usage-share`.
  - Exploration of cheaper rungs (`routing.exploration.rate`, off by default, at most 0.2, `enforce` and deterministic
    detection only).
  - New keys: `routing.delegation`, `roleAgents`, `routing.exploration`, `routing.run`, `routing.workRoots`. On
    OpenCode v1 they are validated and inert, with one notice.
- **`agents` block: subagents defined by the router (#81).** `tiers.json` and the global override can define
  subagents that run on a tier of the active preset (following `/preset`), with `readOnly`/`allowTools` or an
  explicit `permission`, on v1 and v2 with fail-closed permissions. Project overrides cannot define `agents`
  (A18). `/router` lists them under "Plugin agents". On OpenCode v2 a `permission` key naming `write`, `patch`,
  `multiedit` or `apply_patch` only narrows that tool and `edit` decides; a key that allows or asks for what the
  agent's `edit` rules deny gets a config notice.
- Six shell-free `router_git_*` inspection tools: status, log, diff, show, blame,
  ls_files. Fixed hardened argv, strict paths/refs, bounded output, timeout/tree
  cancellation, and remote-URL userinfo redaction; no write commands or arbitrary
  options. Read-only tiers can also use configured Context7 docs lookups.
  See [Read-only tiers](docs/READ_ONLY_TIERS.md) for policy, overrides and limits
  (not an OS sandbox).

### Fixed

- **Plugin agents round-1 fixes (#81).** `allowTools` can no longer grant edit, delegation, Code Mode `execute` or shell, rejects leading wildcards and never reaches the legacy `tools` booleans; grep output is redacted for every plugin agent on v1 and v2; v1 `subagentTiers` still maps host built-ins such as `explore`; stale plugin agents are removed on reload; one preset resolver; v2 skips colliding non-subagent host agents. See `docs/qa/plugin-agents.md`.
- `subagentTiers` no longer creates phantom primary, allow-all agents for names that no agent defines; such
  names are skipped with a notice. On v2 the router re-checks at the first prompt, so `opencode.json` agents
  registered after startup still get the tier model.

### Changed

- **Behaviour change (#84): guard and verification fixes for every host and mode** (v1, v2 tiers mode and roles mode;
  each ships with a before/after golden):
  - **Reader guard profile.** The read-only `fast` tier, dispatches routed `class=review|recon|search` (OpenCode v2
    with a routing engine other than `static`; never on v1), dispatches with `CAP:none` + `reason:` and reader roles are no longer denied or warned for "consecutive non-producing" reads;
    readers are told to emit their final answer instead of to take a producing action.
  - **Uncharged denials.** A refused call is no longer charged to the call budget nor recorded as executed by the
    repeat check; a round is stopped for refusals only when it has min(budget, 10) of them and its executed plus refused
    calls reach the budget.
  - **Whole criteria.** Verification never cuts a criterion: the inferred criterion is the first task line whole (or
    its leading whole sentences within 4000 code points), and grader criteria are kept whole within 4000 code points.
    **Explicit `[acceptance]` lists over 4000 code points are no longer graded in full:** the overflow is named
    ("n criteria omitted") and not graded, and a pass on the rest is unverifiable.
  - **Header strip.** The router's dispatch header (through its first `---` separator) and router directives
    (`CAP:`, `VERIFY:`, `VERIFY_WAIT:`, `reason:`, `[route …]`, `[router]`) are no longer gradable criteria.
  - **Progress notes are incomplete.** A contract follower's progress note, and a `NEED MORE: budget` return backed
    by the guard's state, is an `incomplete` verdict (`[router ⚠ INCOMPLETE]`): never accepted, no next tier, no
    evidence, resume the same session. The budget claim is read from the return prefix; a progress summary written
    before a line-start `NEED MORE: budget` still counts.
  - **`root=` in the header.** The dispatch header's `Working directory:` names the route line's `root=` when present
    (byte-identical otherwise).
  - **Verification reasons, in tiers mode too.** Verification reasons are rendered one per line with line breaks
    joined, at most 20 items plus a count of the rest; an LLM grader's text is cut at 500 characters. A list of at
    most 20 one-line reasons renders as before.
  - **Downgrades.** Outcome signals are written as annotation rows of the decision log, which earlier versions drop
    only through their decision-id dedupe: downgrading past this version is unsupported.
- `anthropic` preset: `fast` tier now uses Claude Haiku 5.5 (low) instead of Sonnet 5.5 (low).
- **Breaking (behaviour): `fast` is now host-enforced read-only on v1 and v2 (#77).** Shell, edits,
  Code Mode, delegation and unspecified MCP tools are denied, including inherited
  ask grants outside the permitted actions, even
  for existing configs without the new optional tier `readOnly` boolean.
  Opt out by setting `presets.<preset>.fast.readOnly: false` in a router override
  file. V2 inherited session grants no longer override the agent's own denies or
  asks, but remain intact for children resumed as medium/heavy. Drifted host
  defaults fail closed. Agent-specific resource overrides on
  permitted actions remain supported; other tiers are unchanged. Legacy v1
  hosts that honour only tool booleans cannot enforce sensitive-read approval.
  `rename` moves from the fast taxonomy to medium. Fast prompts distinguish
  direct tools from the separate Code Mode catalog.
  One shared sensitive-file policy now drives read asks, read-only grep output
  filtering, and Git patch exclusions/refusals. Git show accepts commits only
  (no blob ids or `rev:path`); log includes filtered patches. The list includes
  `*.env`/`*.env.*` and additional credential stores; exact SSH public-key `.pub`
  names and `*.env.example` are intentionally readable. Saved project-wide
  “always allow” approvals are applied after host deny checks (QA-77-P8), but the
  v2 router hook now restores the protected agent's ask. Auto-answer modes may
  still approve that ask; denies remain denied.

## [2.3.0] - 2026-10-07

### Added

- **Cost-aware routing engine (#74), OpenCode v2, opt-in.** A `routing` block
  turns on a decision engine that picks the `(agent, model#variant, retry path)`
  of each dispatch from an expected-cost formula fed by typed task facts decided
  in code and a scoreboard of verified outcomes per `(task class × agent ×
  model#variant)`. With no `routing` block the plugin behaves exactly as 2.2.0.
  Suggested in #73 by @javizuurc (giving custom agents and the context of the work
  to a routing step that decides who does it); implemented from scratch with the
  decision kept in code, and TypeSafe supported as an optional classifier backend.
  - `routing.engine`: `static` (default), `shadow` (decide and record), `advise`
    (generated `R:` line and a stable one-line `Route hint`, advise only) and `enforce` (no hint; reroute under
    a strict margin, an evidence gate of 5 effective (decayed) outcomes on the
    candidate's own key, permission and
    floor rules, and the D9 never-down gate: high-risk work without detection
    cannot run below the pick's capability rank or at lower effort on the same
    model; detection uses the weaker route-line/acceptance claim. A dispatch
    carrying `[route … pin]` is never rerouted).
  - A task classifier (rules, an optional first-line `[route …]` directive, and
    optional `host`, `openai-compatible` and `typesafe` backends; `host` is
    experimental). Backends see a bounded, scrubbed excerpt only, never a task
    that names a credential, and are configurable only from the global override.
  - An outcome store and a decision log under the trajectory directory, with
    cost units that never mix USD and `costRatio` and a zero cost for an unpriced
    model treated as unknown.
  - Same-session variant steps: a failed verification retries on the same
    model's next variant, resuming the child session, before the ladder pays for
    a bigger model (`enforcement.escalate.variantSteps`, `tiers.<t>.candidates`,
    `routing.sessionReuse`).
  - Native agents (`explore`, `general`) as default candidates on v2
    (`routing.roles`; `roles: {}` disables them). The plugin never raises
    `subagent_depth`.
  - A cost doctor: findings in `/router` (title model, unpriced and missing
    models, impossible variants, subscription pricing) and at most one notice,
    delivered as a synthetic transcript entry, throttled per project.
    `variant-effort` reports an empty variant ladder when a tier also sets effort
    options; it fires on bundled `hybrid-2`/`anthropic` once a `routing` block
    exists (unless variant steps are explicitly off). `effort-variant-mismatch`
    reports different `variant` and `effort` values with a live engine and variant
    steps off: the wire effort and learned outcome key would differ.
    Throttle/pending state is stored as `advisor-notice.<hash>.json` with an
    `advisor-notice.<hash>.lock` file in the outcomes directory, per project.
  - `/router stats` and `npm run routing:stats` (the script needs Node 22.18 / 23.6 or
    newer and is not part of the package); `/annotate-plan` emits `[route …]`
    lines and pins `[tier:heavy]` steps when the engine is live; the bare
    `/router` view prints `router: engine=<mode> build=<version>+<sha7>`.
    It also prints `router: config notice:` lines for findings from the last
    config load. A18: `routing.outcomes.path`, like classifier backend settings,
    is accepted only from bundled config or the global override; project-local
    values are dropped with a one-time warning.
  - Documentation: `docs/ROUTING_ENGINE.md`, `docs/adr/0005-cost-aware-routing-engine.md`
    and the `routing` section of `docs/CONFIG_REFERENCE.md`.

### Changed

- With a `routing` block, `enforcement.escalate.variantSteps` defaults to `auto`
  on OpenCode v2 (without one it stays `none`, so the 2.2.0 ladder is
  unchanged); `enforcement.escalate.effortBumpMax` also caps the variant ladders
  read from the model catalog.
- OpenCode v1: the `routing` block is validated and `routing.engine` is forced
  to `static` with one log line; setting `routing.roles` explicitly adds a
  prose-only destination suffix to the `R:` line.

## [2.2.0] - 2026-10-05

### Added

- Config hot reload: the router re-reads `tiers.json`, the global and project
  overrides files and the state file when their mtime/ctime/size fingerprint changes,
  with no restart. A source that turns invalid or unreachable keeps the last valid
  config (the reason is surfaced by `getConfigReloadError()`); only ENOENT/ENOTDIR
  count as a removed file. `/router-reload` forces a reload, and on OpenCode 2 the
  agent and command registry is refreshed on reload and after `/preset`.
- `hybrid-2` preset: `@fast` → `openai/gpt-6-luna-fast` (medium), `@medium` →
  `anthropic/claude-sonnet-5-5` (xhigh), `@heavy` → `anthropic/claude-opus-5-5`
  (xhigh).

### Fixed

- Project overrides are found again on opencode v2 service mode (#70): the override
  lookup and the config cache are now keyed by the host-provided project directory
  instead of `process.cwd()` (which the v2 server moves to `$HOME`), so several
  projects in one process each keep their own config, reload state and error.

## [2.1.0] - 2026-10-05

Observations by @MetalbolicX in opencode-smart-router (#17); implementation written from scratch.

### Added

- Delegation depth guard (#66), configured by `enforcement.maxDelegationDepth`
  (default `1`; `null` disables it).
- Effort bump before escalation (#67), configured by
  `enforcement.escalate.effortBump` (default `true`) and
  `enforcement.escalate.effortBumpMax` (default `"xhigh"`, further capped per model).

### Changed

- The automatic ladder's existing same-tier retry now runs one effort level higher
  by default on eligible tiers: explicit valid `effort`, no `variant`, a recognised
  Claude or OpenAI model family, no winning explicit provider setting, and room
  below the effective ceiling. This adds no attempt and
  still respects attempt and cost ceilings. It applies only to the optional
  `delegate` tool's automatic ladder, not native `task`/`subagent` or manual retries.
  Only `fable-effort` fast/medium are eligible among bundled presets; at the default
  cost ceiling, a run starting at fast stops before medium's bump. Set
  `enforcement.escalate.effortBump: false` to restore the previous retry behaviour.
- Dispatches past `enforcement.maxDelegationDepth` (default `1`) are warned in
  `advisory` mode (the bundled default) with `[⚠ GUARD:delegation_depth]` and refused
  in `enforced` mode. Set `enforcement.mode: "enforced"` to enforce it unless the
  caller tier's `enforcement.perTier` entry overrides `mode`; `MODEL_ROUTER_ENFORCE=1`
  overrides both and forces enforcement. Set `enforcement.maxDelegationDepth: null`
  to opt out of the guard. Enforcement mode `off`, a caller-tier `perTier: "off"`
  (unless the environment gate forces enforcement), and `/bypass on` also disable
  the check. OpenCode 2's own
  `experimental.subagent_depth` cap remains independent.
- On OpenCode 2, router-modified `subagent` results now keep the host's
  `<subagent sessionID=…>` envelope part and append the router's text as a separate
  part, preserving the resume handle instead of replacing the envelope with plain
  text. This applies when host text exists and the router output starts with the
  child's text after trimming trailing whitespace. Missing host text or a
  non-suffix rewrite uses the full router output as one text part instead, retaining
  non-text attachments without losing or duplicating the child's text. Structured
  output and metadata handling are unchanged.

### Fixed

- **OpenCode v1 behaviour change:** tier `effort` (for OpenAI-family models),
  `reasoning.*` and `thinking.budgetTokens` settings that v1 silently dropped now
  reach requests through provider-native registered keys: `reasoningEffort`,
  `reasoningSummary` and `thinking: { type: "enabled", budgetTokens }`. User config
  keys and provider-specific precedence/gates are unchanged; Claude `effort` was
  already registered with its native key.
  - OpenAI-family detection is regex-based: Copilot/OpenRouter/Azure `gpt-*`,
    `gpt-oss` through Ollama/Groq, and non-reasoning GPT models with configured
    `effort` or explicit `reasoning.effort` now receive `reasoningEffort` (and
    configured summaries use `reasoningSummary`). IDs containing `o1`/`o3`/`o4`
    delimited by `/`, `-` or `_` (or the start/end of the ID), including bare IDs
    and false positives such as `mistral/magistral-o1`, are also treated as OpenAI.
    OpenAI-family tiers with a truthy `thinking.budgetTokens` now also send
    `thinking: { type: "enabled", budgetTokens }`; non-Claude budgets are not gated.
    Whether the SDK strips unsupported options for non-reasoning models is unverified.
  - Claude tiers with an applicable `thinking.budgetTokens` now send `thinking`;
    adaptive-only Claude still drops manual budgets. Unknown-family tiers (such
    as Bedrock Claude or Gemini) with explicit `thinking.budgetTokens` or
    `reasoning.*` also receive the native keys; their provider effect is unverified.
  - Latency/cost may rise, or a provider may reject newly delivered settings.
    To restore the previous behaviour, remove `effort`, `reasoning.*` or `thinking`
    from the affected tier. **Bundled presets are unaffected by this registration
    fix:** none sets `reasoning` or `thinking`, and their explicit `effort` settings
    are Claude's already-native key.

## [2.0.0] - 2026-10-04

The router now runs on OpenCode v2 through a separate server entrypoint. **OpenCode v1
remains supported**: the callable v1 entrypoint and every config key are unchanged. The
major version marks the new host support and the updated bundled preset defaults. See
[the compatibility notes](docs/OPENCODE_V2.md).

### Added

- OpenCode v2 compatibility through a separate server entrypoint, fixing the
  `Expected object at ["default"]` plugin validation error while preserving the
  callable v1 entrypoint. The adapter translates agent registration, commands,
  prompts, tool guards and verification to v2's domain APIs, and uses native
  subagents for producer/grader sessions. A subagent's `background` request is
  kept unless the router verifies that dispatch. Only router-added instructions
  are translated to v2 tool names. V2 tier options reach requests through the
  context hook, not unused agent settings. V2 ≥2.0.21 removes temporary children
  after use; 2.0.20 retains their history. Anti-narration warnings appear as
  synthetic transcript entries. Includes an opt-in provider-backed v2 e2e smoke
  adapted from @ChronosWS (Cliff Hudson). See
  [the compatibility notes](docs/OPENCODE_V2.md).
- **Behavior note:** on v2, graders send no temperature (the provider default
  applies, not `graderTemperature`) unless the exact `provider/model` is listed in
  `enforcement.verify.graderTemperatureModels` (reported by @ChronosWS).

### Changed

- Bundled presets updated: `anthropic` fast → Sonnet 5.5 low, medium → Sonnet
  5.5 medium (was Opus 5.5 low); `openai` medium → `gpt-6.1-sol-fast` xhigh;
  `hybrid` fast → Luna medium, medium → Astra high, heavy → Opus 5.5 xhigh
  (was Fable 5.1 max). The orchestrator prompt grows by 11 characters:
  3,249 / 4,021 / 6,221 for base / Claude / Claude with enforcement.
- `hybrid` heavy now also sets `effort: "xhigh"`, like the `anthropic` preset's
  heavy tier, so Opus 5.5 receives the effort and not only the variant. The
  `github-copilot` heavy description names Fable 5.1, the model it runs.
- V1 graders no longer send `graderTemperature` to models whose capabilities
  report `temperature: false`.

### Fixed

- Setting `enforcement.verify.graderTemperature` to `null` removes any grader temperature,
  including pre-existing values and v2 allowlisted models. Numeric values still respect
  v1 model capabilities and the v2 allowlist. Grader response/API failures are reported as
  SDK errors with metadata-only details before verdict parsing, rather than as parse failures.
- Native `task` acceptance checks could run in the router directory instead of the producer's worktree: `[acceptance]` now supports `cwd:` (a supplied tool cwd wins), and the deterministic gate returns unverifiable without running checks when all changed paths are absolute and outside its base.
- Windows e2e self-check waits for sampler snapshots instead of a fixed 2.5 s window (#61).
- Parallel deferred finishes now share their gate-time tree snapshot, as dispatch
  starts already did. A run only serves finishes that asked before it started.
  Unshared, 20 parallel deferred delegations on a 4-core Windows host ran 20
  snapshots and 19 hit the 2 s finish bound, leaving their changes unattributed
  (risk high). Measured with that affinity: finish p50 2.11 s → 0.96 s, 19 → 0 capped.

### Documentation

- README updated for OpenCode v2 support, presets and requirements.

## [1.15.0] - 2026-09-28

The acceptance gate no longer runs a test suite per delegation. `testsPass` now runs only
the tests affected by the producer's changes, and the dispatch-time baseline is replaced
by a git reference captured in well under a second. **By default, delegations are no
longer verified unless the orchestrator asks for it**, either with `VERIFY:required` on
the dispatch or with a `router_verify` call on the returned handle, or unless
`enforcement.verify.background` is enabled. A deferred delegation is marked unverified,
carries a risk signal and stays in a pending list until it is checked. The full suite is
CI's job. See `docs/adr/0003-affected-test-verification.md`.

### Added

- **New `enforcement.verify` keys.** These are `testScope` (`"affected"`, or `"full"`
  as the explicit opt-in), `maxWorkers` (default 2), `lowPriority` (default `true`),
  `maxConcurrentVerifications` (default `max(1, floor(cores / 8))`), `defaultVerify`
  (default `"deferred"`), `captureWaitMs` (default 5 s, never more than
  `baselineTimeoutMs`), `background` (default `false`), `pendingTtlMs` (default 1 h),
  `slotWaitMs` (default 60 s), `batchWindowMs` (default 2 s), `failureRecheck` (default
  `true`) and `recheckTimeoutMs` (default 60 s). See `docs/CONFIG_REFERENCE.md`.

- **`VERIFY:` and `VERIFY_WAIT:` dispatch directives.** `VERIFY:required` gates a
  delegation synchronously and keeps the escalation ladder. `VERIFY:deferred`, the
  default, returns at once. `VERIFY_WAIT:<n>s` sets how long the dispatch waits for the
  reference capture before the producer starts. It never blocks beyond that.

- **`router_verify` tool.** A deferred delegation returns a `vrf_…` handle together with
  an "unverified" disclaimer and a deterministic risk signal. `router_verify` runs the
  verification for that handle on demand, within a deadline, and returns the verdict.

- **Pending list.** Unverified delegations are listed in the prompt until they are
  verified or their handle expires (`pendingTtlMs`), so the orchestrator can see what it
  is building on.

- **Opt-in background verification.** With `background: true`, deferred verifications
  also run in the background through the verification slot at low priority, and failures
  reach the orchestrator as late notices. It is off by default, so no CPU is spent on
  verdicts nobody asked for.

- **pytest support.** `testsPass` scopes pytest runs by module mapping, and `pytest` and
  `uv run pytest` are allowlisted. A green pytest scope passes. A failing one is always
  `unverifiable`, because an editable install imports the live tree, which makes the
  reference rerun impossible.

### Changed

- **Gate labels say what was verified.** A result the gate let through without verifying it
  (unverifiable: gate timeout, slot busy, budget exhausted, no reference; or a pass carrying a
  caveat) is headed `[router ⚠ UNVERIFIED: <method>]` above its `Verification caveats — NOT
  verified` list, instead of `[router ✓ accepted: …]` (plan G2, QA-3.1-21). A clean pass,
  which used to add no text on a native `Task()`, now ends with `[router ✓ verified: <method>]`,
  and a pass with notes uses the same label (QA-3.1-18). Accept/reject policy is unchanged.
- **`testsPass` runs only the affected tests.** The runner adapter builds the command
  (`vitest related`, `jest --findRelatedTests`, pytest module mapping) and spawns it
  without a shell. When scoped tests fail, only those test files are rerun in an
  ephemeral worktree at the dispatch reference. Failures that also fail there were
  already present, so they are excused with a note rather than blamed on the producer.
  The router never falls back to a full suite: when scoping is impossible (an unknown
  runner, a composite script, a config-file change) the result is `unverifiable` with a
  caveat, which is accepted unless `strictUnverifiable` is set.

- **Deferred verification is the default.** A delegation with no `VERIFY:` directive
  returns immediately as unverified. The synchronous cost is up to `VERIFY_WAIT`
  (default `captureWaitMs`, 5 s) at dispatch for the reference capture, paid in either
  mode, plus at most 2 s at return for the git-only snapshot of the producer's changes
  (measured at about 0.4–0.5 s).

- **`enforcement.verify.baselineTimeoutMs` now bounds the git-only reference capture.**
  It used to bound the dispatch-time baseline test run. Its default changed from 60 s to
  15 s.

- **The bundled `tiers.json` no longer sets `gateBudgetMs`.** The key is still supported;
  its in-code default of 90 s (90000 ms) applies.

- **Verification runs at low priority, through a machine-wide slot, in batches.**
  Commands run at below-normal OS priority with the runner's worker cap. A cross-process
  semaphore in the OS temp directory limits concurrent verifications across every
  opencode process on the machine. Requests for the same runner root that arrive within
  `batchWindowMs` are merged into one scoped run, and failures are attributed back to
  each request.

- **Deprecations.** `enforcement.verify.testBaseline` is deprecated in favour of
  `failureRecheck`. Any value logs a once-per-process warning, and `testBaseline: false`
  still turns the recheck off.

### Fixed

- **A gate that runs out of budget now kills the verification process tree.** The gate
  budget's abort signal reaches the running command instead of abandoning it.

- **The native `task` path's required gate has a budget.** `accept(…)` there was not
  wrapped in a timeout, so a slow check could hold the `task` result indefinitely. It is
  now bounded by `gateBudgetMs`, like the `delegate` path.

- **pytest: a changed module no longer passes as "no affected tests".** A changed module
  used to map only to test files named after it (`test_<stem>.py`, `<stem>_test.py`), so
  a test such as `tests/test_mod02_1.py` that imports it was never run. It now maps to
  the test files that name its stem as a whole word (`git grep -F -w`, which matches
  every import spelling), plus the name-matched tests. When no test maps, or a
  `conftest.py` names the module, the check is `unverifiable` (`unmapped-module`), never
  a pass. When `testpaths` decides the collection, only tests under it are inputs.
  Residual: only direct importers run. A test that reaches the module through another
  source module or a dynamic import is not run, and a change to non-`.py` files alone
  (for example a data file a module reads) still gives "no affected tests".

- **An unknown tool during the dispatch capture no longer seeds the baseline.** Only
  tools known not to write (read, glob, grep, list, ls, codesearch, webfetch, websearch,
  lsp, todoread, todowrite, question, skill, plan_enter, plan_exit, invalid, task, the MCP
  resource readers, delegate and router_verify) leave an in-flight snapshot or capture
  alone. Any other tool, MCP and custom tools included, that runs in that window makes
  the dispatch's change set unavailable and its reference none, so that dispatch is
  `unverifiable` instead of a possible clean pass. Residual: a write with no tool event
  (an external editor, an MCP server writing after its call returned), or a tool that
  writes under a non-writing name, is not seen.

## [1.14.0] - 2026-09-26

Test baselines could saturate every core on a machine running several delegations: a
full test suite was started on every dispatch, and on Windows a timed-out suite kept
running as orphaned workers after the router had given up on it.

### Changed

- **The bundled `anthropic` preset moves heavy to Opus 5.5 and lowers medium's
  effort.** `heavy` is now `anthropic/claude-opus-5-5` at `xhigh` effort (was
  `anthropic/claude-fable-5-1` at `max`), and `medium` stays on Opus 5.5 with
  `effort`/`variant` `low` (was `high`). Tier descriptions state the new settings.
  Presets overridden in `opencode-model-router.overrides.jsonc` are unaffected.

### Fixed

- **A timed-out or aborted test baseline no longer leaves the suite running.**
  Verification commands ran through `child_process.exec`, whose `timeout` and
  `signal` only kill the shell it spawned. A test command is a process tree
  (`cmd /c npm test` → npm → vitest → one worker per core), so on Windows the
  60-second baseline budget expired, the shell died, and every worker kept running
  until the suite finished on its own. Commands now run through a helper that kills
  the whole tree on timeout or abort: `taskkill /T /F` on Windows, the process group
  on POSIX. This also covers `testsPass`, `buildPasses`, `lintClean` and `run`
  checks.

- **Read-only dispatches no longer run the test suite.** Every `task` or `delegate`
  dispatch started a baseline capture of the default test command to warm the cache,
  including exploration fan-outs that are never judged by `testsPass`. Those captures
  were almost always discarded, because any shell or edit tool in the directory
  contaminates them, so each dispatch paid for a full suite and gained nothing. A
  baseline is now captured only when the dispatch's DoD carries a `testsPass` check.

- **At most one baseline capture runs per directory and command.** Captures are
  cached by tree fingerprint, which changes with every edit, so dispatches landing
  while a suite was already running each started another. A dispatch that finds a
  capture in flight for the same directory and command now gets no baseline — the
  same `unverifiable` outcome as a contaminated capture — instead of a second suite.

## [1.13.0] - 2026-09-24

A forced delegation of a request that carries no task produced a `task` call with no
prompt, which the harness rejected with a terse schema error. The router now repairs
such calls or refuses them readably. This release also gives the orchestrator's
read-only allowance a single consistent statement, and stops explicit thinking and
reasoning fields from reaching Claude models that cannot use them.

### Added

- **`taskPromptRepair` fills in or refuses prompt-less `task` calls.** A forced
  delegation of a request that carries no task — a bare greeting sent through an
  explicit tier mention, say — made the model emit a `task` call with a description
  and a tier but no prompt, and the harness rejected it with a bare schema error
  naming the missing key. The `task` before-hook now repairs the call ahead of the
  dispatch header: when `prompt` is absent, `null` or blank and `description` is a
  non-empty string, the trimmed description becomes the prompt and the call proceeds
  with the dispatch header applied normally. When there is no usable description the
  call is refused with a `[router]` error saying that `task` needs a non-empty
  `prompt`, and that a request carrying no task (a greeting, an acknowledgement)
  should be answered directly rather than delegated. A prompt of a non-string type
  is left for the harness, and frozen args that cannot be repaired are left alone.
  The flag defaults to `true`; set `taskPromptRepair: false` to restore the previous
  behaviour. Non-boolean values are rejected by `validateConfig`. See
  `docs/CONFIG_REFERENCE.md`.

### Changed

- **The orchestrator's read-only allowance is stated as one mechanism.** The injected
  protocol gave the same rule three incompatible readings: the orchestrator line said
  information-gathering should be dispatched to @fast rather than run directly, then
  capped direct read-only calls at about two per turn, and the rules array added a
  separate licence for trivial single-call work that acknowledged neither. Dispatch
  is now the stated default, and direct calls are a named allowance for lookups that
  settle a question outright; the trivial-work rules in the shipped `tiers.json` now
  spend that allowance instead of competing with it, and the per-mode overrides are
  reconciled the same way. No cap number moved: the base allowance is still two,
  budget mode is still one, and the dispatch baselines are unchanged. Only the
  protocol prose changed, so the injected prompt and the README's measured
  prompt-size figures move by the length of the new wording. The README's sample
  rules line is regenerated from the shipped configuration; it had shown eight rules
  where the shipped array has ten.

### Fixed

- **The invalid-effort warning goes through the plugin logger.** Every other
  `buildAgentOptions` warning passed the plugin logger, but an unrecognised `effort`
  value always went to `console.warn`, even when a logger was supplied. It now uses
  the logger like its siblings; without one the behaviour is unchanged.

- **Explicit `thinking` and `reasoning` fields are gated for Claude models.**
  `buildAgentOptions` emitted `budget_tokens` and `reasoning_effort` /
  `reasoning_summary` without consulting the model, so a tier on an adaptive-only
  model — the bundled `anthropic` preset's `@medium` is `anthropic/claude-opus-5-5` —
  that also set `thinking.budgetTokens` registered a manual thinking budget on a model
  that only accepts adaptive thinking (the HTTP 400 this is said to cause is reported,
  not reproduced here; see the provider gate in `docs/CONFIG_REFERENCE.md`), and the
  budget outranked the `effort` that would have applied. A Claude tier now never
  registers `reasoning_*` (OpenAI parameters), and a tier on a model whose wire-compat
  catalogue entry carries `rejects_disabled_thinking` (`claude-opus-5-5`,
  `claude-fable-5`, `claude-fable-5-1`, `claude-mythos-5-1`, matched by the new
  `isAdaptiveOnlyClaudeModel`) never registers `budget_tokens`; the budget is then
  treated as unset, so `effort` still applies. Each drop warns once per tier.
  Non-Claude tiers are unchanged. Ids of the form
  `<provider>/<namespace>.claude-…`, such as `bedrock/us.anthropic.claude-…`, are not
  recognised as Claude, so they get no Claude prompt prefix, no Anthropic effort
  routing and no gate; the README had claimed they were detected and now says so.

## [1.12.1] - 2026-09-23

The delegate instruction filter introduced in 1.12.0 never removed anything in a live
session, and the change that makes it take effect would, on its own, have deleted
unrelated system-prompt text. Both are fixed together.

### Fixed

- **`delegateInstructions` stripping now reaches the request.** The filter ended with
  `output.system = output.system.flatMap(...)`, which rebinds the hook's output
  property. opencode keeps its own reference to the array it passes to
  `experimental.chat.system.transform` and reads that reference back after the hook
  returns, so every removal was computed and then discarded. Protocol injection had
  always worked only because it used `push`, which mutates the same array. The
  filter now writes its result back with `splice` over the original array and never
  rebinds `output.system`. The 1.12.0 tests passed because they asserted on the
  rebound property rather than on the array the host still holds.

- **Removal is bounded to the instruction file's own text.** A block was defined as
  running from its `Instructions from:` marker to the next marker or the end of the
  entry, which was correct only while each instruction file arrived as its own array
  element. The runtime joins the agent prompt, every instruction file and any
  trailing system text into one string, so the last block extended to the end of
  everything: a reproduction with a trailing `<mcp_instructions>` block lost the whole
  MCP section along with `CLAUDE.md`, shrinking the prompt from 839 to 465 characters.
  The filter now reads the file named by the marker (cached per path and revalidated
  against its modification time) and removes exactly the marker line plus the longest
  rendering of the file's contents — as read, LF-to-CRLF, CRLF-to-LF, or any of those
  with trailing whitespace trimmed — that is an exact prefix of the block, keeping
  whatever follows. If the file cannot be read or does not match, the block is kept
  whole: leaving an instruction in place is unhelpful, deleting an unknown span of
  the system prompt is not recoverable. The reader is an optional fourth parameter
  (`InstructionFileReader`), so tests exercise the logic without touching disk; the
  plugin's call site is unchanged.

## [1.12.0] - 2026-09-23

A subagent was refusing dispatched work outright — returning `ESCALATE: The Task tool
is not available in this session` or `the available tools here are not the
Read/Grep/Glob/Bash tools described in the request` — without making a single tool
call. This release is about the several independent causes behind that, and about an
acceptance gate that was rejecting work for its own inability to check it.

### Fixed

- **The orchestrator delegation protocol no longer leaks into subagent sessions.**
  Classification was an allowlist of tier names: `if (!input.agent ||
  !tierNames.includes(input.agent))`. So `general`, `explore`, every
  markdown-defined agent and — by construction — every agent mapped through
  `subagentTiers` was never recognised as a child, because
  `resolveSubagentOverrides` deliberately skips any name that collides with a tier.
  The two features were mutually exclusive. Unrecognised children were then told
  `You are the orchestrator: route each task to the right tier and delegate it with
  Task(...)`, which is a MANDATORY instruction they have no tool to satisfy, and a
  literal-minded model refuses the dispatch rather than improvising. Children are now
  classified by `parentID`, from the `session.created` event with a memoised
  `session.get` fallback — the code comment had claimed this mechanism for some time,
  but the only event handler began `if (event?.type !== "session.idle") return;` and
  no `session.created` branch existed. Grader sessions are excluded too; they are
  created synchronously and would otherwise stall until their budget expired. The
  guard also now fails closed: a transform with no session id no longer injects.

- **Tier prompts no longer assert a missing capability.** All six shipped prompts
  ended their opening paragraph with `You have no Task tool and cannot sub-delegate.`
  The statement is true — the runtime denies `task` to children on its own — but
  training a hand-back reflex next to orchestrator text demanding delegation is what
  produced `I cannot invoke a medium subagent… dispatch it from the orchestrator`.
  The sentence is replaced with `You execute this dispatch yourself and do not
  re-delegate it`, and a provider-neutral tool-authority clause is appended once at
  agent assembly: your own schema is authoritative, tool names in a dispatch are
  descriptive and vary by provider, an empty search result is a result, and refusing
  because a named tool looks unavailable is not an acceptable answer. This matters
  most in a mixed-family setup, where a dispatch written in one vendor's tool
  vocabulary reads to another vendor's model as a list of tools it does not have.

- **Reading a different region of an already-opened file is no longer flagged as
  redundant.** The read fingerprint was the path alone, so lines 400–600 of a file
  whose first 200 lines had been read collided with the earlier call and produced
  `[⚠ REDUNDANT]`. Combined with prompts that said to stop immediately on that
  marker, it halted legitimate work. The fingerprint now includes any range
  arguments; a read with no range keeps its previous fingerprint exactly, so no
  banner output moved. The prompts now say the marker means stop repeating ground you
  already covered, and that a different region is not a repeat.

- **The announced read-only budget is the one actually charged.** The dispatch header
  resolved the cap from `tierCaps`, while enforcement resolved it from the dispatch's
  own `CAP:` directive and the `reason:` justification rule, so the header could
  announce a budget the guard would not honour. Both sides now read the same
  directive through the same parser, and a test pins their equality so neither can
  drift alone.

- **Subagent-tier mappings now carry a tier.** An agent listed in `subagentTiers` was
  correctly excluded from protocol injection but remained untiered, which silently
  disabled its caps, verification and escalation. It now resolves to its mapped tier.
  Alongside it: a non-2xx `session.get` is no longer cached as "root" (the generated
  client resolves rather than throws, so the error object was read as an absent
  `parentID`), failed lookups are retried after 30s instead of every step, and
  `session.deleted` evicts the classification state.

- **A polynomial-ReDoS finding in delegate instruction filtering.** CodeQL flagged the
  path normalizer behind `delegateInstructions`, the same class as the two 1.11.1
  fixes. Its trailing-slash strip, `/\/+$/`, re-scanned a run of slashes from every
  start offset, so a project directory or an `Instructions from:` marker path made of
  many slashes cost O(n²). It is now a linear backwards scan with identical semantics:
  trim, backslashes to slashes, lower-case, then drop trailing slashes.

### Added

- **Orchestrator instruction files are stripped from delegate sessions**
  (`delegateInstructions`, default `strip-global`). opencode injects instruction
  files — `AGENTS.md`, a global `CLAUDE.md` — into every session, children included.
  A global orchestrator persona therefore reached every delegate telling it to fire
  a `fast` agent via `Task` for any read-only work, and to treat a dispatch's
  `REQUIRED TOOLS` list as a whitelist. Project-local files are kept by default
  because they usually carry conventions the delegate needs; `strip-all` removes
  every instruction file, `keep` restores the previous behaviour.

- **A mechanical dispatch header on every tier dispatch** (`dispatchHeader`, default
  on). Roughly 260 tokens stating the tier identity, that the delegate executes the
  work itself, the working directory and that it is already there, that tool names
  are descriptive rather than restrictive, that empty results are results and
  `.gitignore` filtering is not a broken tool, and the resolved read budget with what
  the runtime's banners mean. This is dispatch hygiene that previously had to be
  retyped by hand into every prompt, which is exactly the kind of thing that stops
  being done.

- **Hand-backs made without trying are detected** (`falseRefusalDetection`, default
  on). A child that returns `ESCALATE:` / `NEED MORE:` / `SCOPE GROWTH:` with a
  capability complaint and **zero recorded tool calls** gets its result annotated for
  the orchestrator: no tool call was observed, so the capability claim is untested
  rather than demonstrated, and a tier escalation on that result is suppressed. The
  detector requires all three signals together, so a genuine scope hand-back after
  real work is untouched.

- **A third verification outcome: `unverifiable`, distinct from a failed check**
  (`enforcement.verify.strictUnverifiable`, default off). The gate was rejecting —
  and the ladder escalating a tier on — its own inability to check: a command the
  allowlist refused, `buildPasses` in a repo with no build script, a grader that
  timed out, a path it could not resolve. None of those are evidence that the
  producer failed. They are now reported as caveats on an accepted result, which
  never claims the check passed; `strictUnverifiable` restores rejection, but
  terminates the ladder instead of escalating. Grader timeouts also scale with tier
  (60s / 180s / 600s) rather than a flat 60s a thinking model cannot meet.

- **`testsPass` is judged against a measured baseline** (`enforcement.verify.testBaseline`,
  default on; `baselineTimeoutMs`, default 60s). A suite with pre-existing unrelated
  failures made every delegation unacceptable. A dispatch-time baseline is now
  captured out of band, keyed by working directory, `HEAD`, a working-tree
  fingerprint and the exact test command, and cached across dispatches. It is
  discarded the moment it could have been contaminated by the producer's own edits,
  because a contaminated baseline errs in the dangerous direction: a newly introduced
  failure would appear in both runs and be excused. Equal failure counts or equal
  non-zero exit codes do not prove the identities are unchanged, so they yield
  `unverifiable` rather than a pass. A green baseline followed by a failure still
  rejects. The grader is also handed the producer's own change delta instead of an
  unqualified dirty tree, so it stops reporting "no files were modified" against
  changes that predate the dispatch.

## [1.11.1] - 2026-08-24

### Added

- **Community health files.** `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, a
  pull request template, and a bug report form. The contributing guide writes down the
  parts that are easy to miss from outside: golden snapshots are parameterized over every
  preset and must be regenerated, model refs are only format-validated so the provider id
  has to be checked against the models.dev catalog, and a new preset also needs a
  `fallback.global` chain plus the README and config-reference counts.

### Fixed

- **Two polynomial-ReDoS findings on LLM-influenced input.** CodeQL flagged the guard's
  ad-hoc script detection (`isSelfScript`) and the subagent task-result parser. The guard
  now caps the command it scans at 20k characters and fails closed above that: truncating
  would let padding push a redirect past the scan window, and a shell command that long is
  itself a signal. The task-result parser dropped its regex entirely for a linear `indexOf`
  scan — even a lazy capture backtracks polynomially on repeated open tags with no close —
  keeping the same semantics: first open tag, first close tag after it, case-insensitive,
  trimmed at the use site, raw output as the fallback.

## [1.11.0] - 2026-08-24

### Added

- **A `zai` preset, routing GLM models through the Z.AI Coding Plan.** `@fast` takes
  `glm-4.7`, `@medium` and `@heavy` share `glm-5.3` at `high` and `max` effort. Contributed
  by @MarCYK in
  [#37](https://github.com/marco-jardim/opencode-model-router/pull/37), closing
  [#18](https://github.com/marco-jardim/opencode-model-router/issues/18).

  Landed with three fixes on top. The preset originally named the `zai` provider, but
  `glm-5.3` is not published under it in the models.dev catalog opencode resolves against
  — it exists only under `zai-coding-plan`, whose reasoning options (`low`/`high`/`max`)
  are also what make the `high` and `max` variants valid. All three tiers now point at
  `zai-coding-plan/*` and say so in their descriptions, since the plan is a prerequisite.
  `fallback.global` gained a `zai-coding-plan` chain, so a Z.AI outage now fails over
  instead of dead-ending. And `costRatio` follows the `fable-effort` precedent — `1`/`3`/`6`
  as an estimated token-spend multiplier, not a price difference, because `@medium` and
  `@heavy` are the same model on a flat-rate plan where the catalog prices every model at
  zero.

## [1.10.0] - 2026-08-20

Minor release. Config errors are caught at load instead of drifting to a later turn,
the logging path 1.9.0 introduced is finished — it was losing messages entirely in
short-lived processes, and one warning had never been routed through it at all — and
there is now a smoke lane that needs no credential and therefore actually runs.

### Added

- **A credential-free smoke lane, running on every push.** `opencode debug agent`
  loads the plugin, runs the `config` hook, resolves overrides and registers agents
  with no API key and no model call, so an end-to-end check of registration costs
  ~20s. The existing smoke lane is gated on secrets, which made it a green no-op on
  forks — and meant the only test covering the `config` hook had been asserting the
  pre-1.8.0 anthropic preset for a whole release without anyone finding out. Those
  pins are repaired, and the new lane asserts that **stderr is empty**, which is
  coverage unit tests structurally cannot provide: they hand the plugin a stub client,
  so they have neither a real SDK receiver nor a real process's stderr to check.

- **A malformed tier `model` is rejected when the config loads, not on some later
  turn.** `"model": "claude-sonnet-5"` — a ref missing its provider — used to validate
  clean and only surface as a catalog issue on a turn that happened to have the catalog
  in hand, or never, if the fetch failed. The `provider/model` shape needs no network,
  so it is now decided at load, alongside the existing `effort` and `promptStyle`
  checks. `parseModelRef` moved to `config.ts` (re-exported from `catalog.ts`) so load
  validation and catalog lookup share one definition of well-formed: passing the first
  now guarantees parsing in the second. Observed by @MetalbolicX in
  [#17](https://github.com/marco-jardim/opencode-model-router/issues/17); implementation
  is independent of the fork's.

  Behaviour change for an existing malformed config: an overrides file carrying a bad
  ref is now dropped with a warning naming the offending value, and the bundled
  defaults stand. Startup is never blocked — the layer-drop path already guaranteed
  that, and there is now a test pinning it for this case specifically.

### Fixed

- **The orphaned-pattern warning no longer suggests a fix that cannot apply.** It still
  told the user a provider rename was the likely cause and to update
  `modelGenerations.strong` to match. Since 1.9.0 normalizes separators, a rename is
  matched rather than orphaned, so the only way to reach the warning is a user-authored
  pattern naming something genuinely absent. The copy now says that and forecloses the
  separator fix explicitly.

- **Passive warnings are no longer lost in short-lived processes.** 1.9.0 sent them to
  opencode's log fire-and-forget, which is right for a hook — a warning must never
  block one — but in `opencode run` or `opencode debug` the post never settled before
  the process exited, and the console fallback never fired because nothing had failed.
  The warning reached neither the log nor the terminal. The plugin API has
  `dispose?: () => Promise<void>`, and opencode calls *and awaits* it even on a
  two-second run, so the logger now tracks in-flight posts and `dispose` drains them.
  The tracked promise is the already-`catch`-wrapped one, so a failing post can never
  reject out of teardown. ([#36](https://github.com/marco-jardim/opencode-model-router/issues/36))

- **The `opencode-anthropic-fix` dependency notice reaches the log instead of the
  terminal.** 1.9.0 routed five of the six `warnAgentOptionsEffortOnce` call sites
  through the logger and missed the one in `index.ts`, so that warning kept writing to
  stderr — the exact symptom the change existed to remove. Found by running a real
  process, not by a test; there is now a test.

## [1.9.0] - 2026-08-20

Minor release. One real bug — prompt-style resolution broke when a provider renamed a
model across separators — plus the diagnostics that were compensating for it, which are
gone now that the cause is fixed.

### Fixed

- **`promptStyle: "auto"` survives a provider renaming a model across separators.**
  `isStrongModel` matched patterns case-insensitively but not separator-insensitively, so
  the moment a provider shipped `claude-opus-4.8` where the pattern said `opus-4-8`, the
  tier silently stopped resolving as strong and dropped from `goal-oriented` to
  `prescriptive` — a different system prompt, with nothing said. Matching now normalizes
  case and `.`, `-`, `_` on both sides. The provider boundary is preserved: `/` is not
  normalized, so a pattern cannot match across it. A pattern consisting only of
  separators now matches nothing instead of everything.

  This is not hypothetical drift. Our own `tiers.json` carries the same model as
  `anthropic/claude-haiku-4-5` and `github-copilot/claude-haiku-4.5`, because each
  provider spells it its own way.

- **Passive warnings go to opencode's log instead of the terminal.** `console.warn`
  from a plugin lands on the server's stderr, which the TUI does not own, so a warning
  painted over whatever the terminal was drawing. Stale-model, orphaned-pattern and
  agent-option warnings now post to `POST /log` via `client.app.log` with a
  `model-router` service tag and structured `extra`. Fire-and-forget and fail-soft: a
  server without the endpoint, a rejected post, a post that resolves reporting an error,
  and a synchronous throw all fall back to `console.warn`, so a diagnostic is never
  silently dropped.

  Config-parse warnings deliberately still use `console.warn`. They are emitted from
  `loadConfig`, which runs before a client exists, and they only fire on a malformed
  override file — a case where being loud is the point.

### Removed

- **`modelGenerations.claude5x`.** The field was declared, type-validated on load and
  documented in three places, and never read by anything. `isStrongModel` reads
  `strong`, and the default `strong` list was a module-level constant computed once
  from the built-in array, so a user's `claude5x` could not reach it. Setting it did
  nothing, and passing validation implied otherwise. An existing config carrying the key
  still loads — unknown keys under `modelGenerations` are ignored, not rejected.

  The note that `strong` was "a superset of `claude5x` by construction — every Claude 5.x
  model is a strong model" is gone with it. It had stopped being true in both directions:
  `claude-opus-5` was strong without being in `claude5x`, and `claude-sonnet-5` ships on
  two tiers as a Claude 5 model that is deliberately not strong. `strong` is curated per
  model, and the docs now say so.

- **Near-miss detection for orphaned strong-model patterns.** It existed to spot exactly
  the rename the matcher now absorbs, so under the fixed matcher a near miss *is* a match
  and can no longer be an orphan — the code was unreachable. The `/router models` output
  and the passive warning both drop the "served under a different separator" hint. What
  remains is narrower and honest: a pattern **you** wrote in `modelGenerations.strong`
  that matches nothing your providers serve is still reported, because that is a claim
  about your environment that turned out to be wrong. Shipped defaults are never
  reported — most of a cross-provider union is unserved on any given install, and saying
  so is noise you cannot act on.

### Changed

- **`@opencode-ai/plugin` peer range is now `>=1.0.0 <2.0.0`.** The open-ended `>=1.0.0`
  claimed compatibility with a major version that does not exist yet and whose plugin API
  is by definition unknown.

## [1.8.0] - 2026-08-19

Minor release: every vendor preset is refreshed to the current generation of models.
No routing logic changed — the tier structure, patterns and enforcement behavior are
the same, only the model ids (and the reasoning effort attached to them) move forward.

### Changed

- **`anthropic` preset** now routes `fast` → `sonnet-5`, `medium` → `opus-5` at `high`
  effort, and `heavy` → `fable-5` at `max`.
- **`openai` preset** now routes `fast` → `gpt-5.6-luna-fast`, `medium` →
  `gpt-5.6-terra-fast` at `high` effort, and `heavy` → `gpt-5.6-sol-fast` at `xhigh`.
- **`google` preset** now routes `fast` → `gemini-3.5-flash-lite`, `medium` →
  `gemini-3.7-flash`, and `heavy` → `gemini-3.1-pro-preview`.
- **`github-copilot` preset** now routes `medium` → `claude-sonnet-5` and `heavy` →
  `claude-fable-5`.
- **`hybrid` preset** now routes `medium` → `gpt-5.6-terra-fast` and `heavy` →
  `claude-opus-5` at `max` effort.

## [1.7.0] - 2026-08-19

Minor release: live model-catalog discovery and validation — `/router models`, stale-model
and fallback-chain checks, orphaned strong-pattern detection with near-miss naming — plus
`subagentTiers` for routing pre-existing subagents, resolved prompt style in `/tiers`, and
a set of enforcement and noise fixes. Routing behavior is unchanged unless you opt into
the new keys.

### Added

- **Near-miss reporting for orphaned strong-model patterns.** When a pattern matches
  nothing served, `/router models` and the startup warning now name any served model
  that matches once `.`, `-` and `_` are normalized away. The known failure is a
  provider moving between separator styles rather than a wrong name, so this turns
  "this matches nothing" into "this matches nothing, and here is the id it means".

- **`subagentTiers`, opt-in routing for your own subagents.** A map of agent name to
  tier name repoints pre-existing custom subagents at the active preset's models, so
  they follow `/preset` instead of pinning a model id in their own agent files. A
  subagent that declares no `model` otherwise inherits the model of whoever invoked it,
  which quietly runs cheap read-only helpers at orchestrator prices. Absent or empty
  means no agent is touched.
- **`/router models [provider]`** lists valid model ids from opencode's live provider
  catalog, with each provider's default and any `deprecated`/`alpha`/`beta` status.
- **Stale-model validation.** Bare `/router` checks the active preset's tier models
  against the catalog and reports missing or deprecated ids with the closest valid
  suggestions; the same check is logged once per session. Report-only, so the plugin
  never changes a model for you. A bad model id previously failed silently on every
  subagent dispatch.

### Fixed

- **Orphaned-pattern warnings the user could not act on.** A pattern from the shipped
  default list is now reported only when a near-miss proves the model is served under a
  drifted separator; a pattern you wrote in `modelGenerations.strong` is still always
  reported. An anthropic-only install no longer warns that `claude-mythos-5` matches
  nothing — that provider simply does not sell it.

- **Dormant fallback chains reported as broken.** `fallback-provider-unknown` now fires
  only when the active preset actually routes to that provider. The shipped chains cover
  every provider, so a single-provider install was warning about chains that are inert by
  design. Chain entries naming a preset that does not exist are still reported.

- Removed a stale `buildAgentOptions` from `src/commands/output.ts`. It was live when
  the presentation layer was extracted, but `src/router/agent-options.ts` later became
  the real implementation and gained `effort` handling. The orphan was reachable only
  from its own test, and importing it by mistake would have silently dropped `effort`.

- **`thinking.budgetTokens: 0` no longer swallows a tier's `effort`.** Behavior change:
  suppression used `budgetTokens != null` while emission required a truthy value, so a
  Claude tier with `thinking: { budgetTokens: 0 }` plus `effort` warned that "explicit
  thinking wins" and then registered neither key. A truthy `budgetTokens` is now the
  single notion of "thinking was asked for": `0` is ignored (one-time notice per tier)
  and `effort` applies normally.
- **Enforced-mode hard blocks now apply to non-trivial `@fast` recon.** Trivial
  classification exempted *any* `fast`-tier dispatch whose text matched a `fast`
  taskPattern stem (`read`, `search`, `grep`, …) from enforcement, so a multi-file
  recon dispatch was treated as "trivial" and `guardBeforeCall` downgraded
  `enforced` → `advisory`. The `read_budget` guard could therefore never
  hard-block a `@fast` subagent — the precise runaway it exists to bound.
  `classifyTrivial` now additionally requires single-shot shape: at most one named
  file path (well-known extensionless files like `Makefile` or `LICENSE` count),
  no multi-step marker (numbered or colon-numbered lists, sequencing words, `;`,
  `&&`), no enumeration of three or more subjects, no multiple imperative lines,
  no distributive breadth quantifier (`every` / `all` over a plural or collective
  target class, as in `read all guard modules` — partitive depth over a single
  file such as `read every line of package.json` stays trivial), and a length
  backstop. Genuine single-shot lookups stay exempt, and real work
  was never trivial either way. Present since
  proportional enforcement landed (`80abf05`) and shipped in every release that
  included it. The `enforcement.proportional.trivialBypass` knob and its semantics
  are unchanged.

## [1.6.0] - 2026-08-18

Minor release: a salvage port of the features worth keeping from an abandoned branch —
per-tier reasoning effort, goal-oriented prompts, session-resume accounting, time-boxes
on every verification hop, and idle eviction for the delegation store. Routing behavior
is unchanged unless you opt into the new keys.

### Added

- **Per-tier `effort`.** Each tier may declare a reasoning-effort level that is forwarded
  to the provider on dispatch. The bundled `fable-effort` preset uses it to run all three
  tiers on the same model at different effort levels, so the cost ladder comes from
  reasoning depth rather than model size.
- **Goal-oriented prompt styles.** `promptStyle` (`auto` | `prescriptive` | `goal-oriented`),
  `modelGenerations`, and `tierPromptsGoalOriented` let a tier ship a goal-oriented prompt
  instead of the terse rule list. Under `auto` a tier switches to the goal-oriented text
  when its model matches a declared newer generation; everything else keeps the prescriptive
  prompt.
- **Session-resume accounting.** A resumed session no longer restarts its budget: the
  cumulative ceiling carries across resumes, and registration now returns a `RegisterResult`
  so callers can see whether a dispatch was newly counted or replayed.
- **Time-boxes on delegate, grader, and gate.** `delegateTimeoutMs` (default 600000),
  `graderTimeoutMs` (default 60000), and `gateBudgetMs` (default 90000) bound each hop.
  They are fail-closed: a hop that runs out of budget is reported as unmet, never as
  silently satisfied.
- **Idle-TTL eviction for the delegation store.** Entries idle for more than an hour are
  swept, throttled to at most one sweep every five minutes. The sweep is timer-less — it
  piggybacks on store access — so it adds no background handles and nothing to unref in
  tests.
- **`cwd`-scoped verification.** A delegation may carry a `cwd`, which scopes the
  deterministic file checks and the grader's session lookup to that directory.
- **Evidence-grounding clauses in the medium and heavy tier prompts.** Subagents are told
  to check each reported claim against a tool result from the same session and to say so
  explicitly when a claim is unverified.
- **An explicit `enforcement` block in `tiers.json`.** Every key is now written out at the
  value that was previously the effective default, so the shipped behavior is unchanged and
  readable rather than implicit. `validateEnforcement` type-checks every shipped key.

### Changed

- **`CAP:none` now requires a `reason:` line.** A dispatch that says `CAP:none` without a
  `reason:` line in its text falls back to the tier's baseline cap instead of lifting it.
  The protocol states this in two places (rule 7 and the per-dispatch paragraph), which is
  the whole of this release's prompt growth: the routing protocol goes from 2,970 to 3,089
  characters, and the Claude and enforcement paths grow by the same 119 characters. See the
  token-overhead table in the README.
- **Under `promptStyle: "auto"`, some bundled tiers switch to goal-oriented prompts.** Tiers
  whose model is `claude-fable-5` or `claude-opus-4-8` — `anthropic.heavy`, `hybrid.heavy`,
  and all three `fable-effort` tiers — now receive the goal-oriented text. Set
  `promptStyle` to `prescriptive` to keep the previous prompts.

### Fixed

- **Child-session disposal is idempotent.** Disposing a session that was already disposed
  is a no-op instead of throwing.
- **Gate-timeout aborts are scoped per delegation.** A gate that runs out of budget aborts
  only its own delegation; concurrent delegations are no longer cancelled with it.
- **`fileExists` reasons are honest about absolute paths.** The reason string reports the
  path that was actually checked rather than the relative form that was passed in.
- **No more orphan `lastTouch` entries.** Touch records are removed with their delegation
  instead of accumulating for the lifetime of the process.

### Deliberately not ported

Several things from the source branch were left behind on purpose. The **lessons memory store**
(~800 lines) has no measurement behind it — if it is revisited it must arrive opt-in and
default-false rather than as a new always-on subsystem. The **anti-context-anxiety clause**,
the **INTENT section**, and the **workspace-root line** would re-add the prose that [#21]
deliberately removed. Flipping `activePreset` to `"opus"` would change the default for every
user, and flipping `enforcement.mode` to `"enforced"` would turn an advisory layer into a
blocking one; both stay as they are. `src/guard/smoke-evidence.ts` is test-support only and
carries no runtime behavior, so it was left as optional and not ported.

### Credits

Refactors [#26], [#27], and [#28] by Lucas Húngaro were merged while this port was in
progress, and the ported code is built on top of them.

[#26]: https://github.com/marco-jardim/opencode-model-router/pull/26
[#27]: https://github.com/marco-jardim/opencode-model-router/pull/27
[#28]: https://github.com/marco-jardim/opencode-model-router/pull/28

## [1.5.0] - 2026-08-18

Minor release: update-safe configuration overrides, so customizations survive the plugin
updates that overwrite the cached package file.

### Added

- **Update-safe config overrides.** `~/.config/opencode/opencode-model-router.overrides.jsonc`
  (global) and `<repo>/.opencode/opencode-model-router.overrides.jsonc` (project) are
  deep-merged over the bundled `tiers.json` — specify only the keys you want to change.
  The project file is located by searching upward to the repo root and wins over the
  global file, which wins over the bundled defaults. Models, tiers, and whole presets can
  now be customized without editing the cached package file, which every plugin update
  overwrites. An overrides file can also define an entirely new preset — `model` is the
  only required field per tier: `costRatio`/`steps` default to the conventional `1`/`5`/`20`
  and `30`/`50`/`120` by tier name when omitted, and `description`/`whenToUse` are optional.
  Contributed by Lucas Húngaro. ([#22], closes [#2] and [#4])
- **JSONC in the override files.** `//` and `/* */` comments and trailing commas are
  accepted, via a small zero-dependency parser (`src/router/jsonc.ts`). No new runtime
  dependencies.
- **`/router overrides`** — prints the global and project override paths, which of them
  exist, and the merge precedence.

### Fixed

- **The upward search for the project override file is now bounded.** It stops at a
  `.git`, `.hg`, or `.svn` marker, at 16 levels above the working directory, or at the
  user's home directory. A tree containing no repo marker previously walked all the way
  to the filesystem root, so running opencode from a non-repo directory could silently
  adopt an unrelated ancestor's override file. `package.json` is deliberately not treated
  as a repo marker: in a monorepo it would stop the walk at `packages/<pkg>/` before
  reaching the repo-root `.opencode/`. ([`8710a84`])

[`8710a84`]: https://github.com/marco-jardim/opencode-model-router/commit/8710a84
[#2]: https://github.com/marco-jardim/opencode-model-router/issues/2
[#4]: https://github.com/marco-jardim/opencode-model-router/issues/4
[#22]: https://github.com/marco-jardim/opencode-model-router/pull/22

## [1.4.0] - 2026-08-18

Minor release: session lifecycle fixes, more reliable read-only delegation, and a
smaller routing protocol with measured overhead documentation.

### Fixed

- **Grader and producer child sessions are now parented and disposed.** The plugin
  previously created backend sessions for every grader and producer attempt but never
  aborted or deleted them, including on the happy path, leaving orphaned top-level
  sessions in the TUI. ([`40c9b94`])
- **Layer-2 grading now skips read-only research delegations** when the DoD is inferred,
  checker-only, and no files changed. This prevents false "not accepted" notes on
  legitimate research results. Contributed by Lucas Húngaro. ([#20])
- README prompt-overhead figures now use measured character counts and explicit token
  estimate ranges. The previous `~210 tokens` claim understated the former default
  Claude path by roughly eight to nine times.

### Added

- A drift test now pins the acceptance-check grammar shared by the `/annotate-plan`
  template, `parseAcceptanceBlock`, and the delegation protocol. ([`19171ea`])

### Changed

- **The delegation protocol was rewritten without dropping routing rules.** On the
  default Claude path it is 46.6% smaller, from 7,006 to 3,742 characters. Contributed
  by Lucas Húngaro. ([#21])
- **The anti-narration guardrail is now opt-in.** Set the top-level `antiNarration`
  boolean to `true` to restore the prompt clause and detector; the default is `false`.
  ([#21])
- The package now declares Node.js 20 or later through `engines.node`. ([`6fa9bab`])

[`19171ea`]: https://github.com/marco-jardim/opencode-model-router/commit/19171ea
[`40c9b94`]: https://github.com/marco-jardim/opencode-model-router/commit/40c9b94
[`6fa9bab`]: https://github.com/marco-jardim/opencode-model-router/commit/6fa9bab
[#20]: https://github.com/marco-jardim/opencode-model-router/pull/20
[#21]: https://github.com/marco-jardim/opencode-model-router/pull/21

## [1.3.1] - 2026-08-16

Patch release: bug fixes, documentation, and release-engineering only. No runtime
behaviour changes beyond the corrected `github-copilot` model identifiers.

### Fixed

- **`github-copilot` preset model IDs** now use the dot-separated form the provider
  actually serves (`claude-haiku-4.5`, `claude-sonnet-4.6`, `claude-opus-4.6`) instead of
  the dash-separated variants, and the non-existent `/thinking` suffix has been dropped
  from the `@heavy` tier. Delegations under this preset previously referenced models that
  could not be resolved. ([#10], fixes [#9])
- Golden snapshot for the `github-copilot` delegation protocol realigned with the
  corrected identifiers above.

### Added

- **Continuous integration.** A `Test` workflow runs `npm ci`, the full suite, and
  `npm run typecheck` on Node 24 for every pull request and every push to `master`.
- **Automated publishing via npm Trusted Publishing (OIDC).** Pushing a `v*` tag builds
  and publishes from GitHub Actions with SLSA provenance attestation and no long-lived
  npm token. Third-party actions are pinned by commit SHA.
- **`package-lock.json` is now tracked**, making installs reproducible across
  contributors and CI. It is not included in the published tarball.

### Changed

- README install and configuration instructions corrected and expanded, including how the
  `tiers.json` cache behaves. ([#7])
- Development dependencies `vitest` and `@vitest/coverage-v8` upgraded to 4.x. Both are
  bumped in lockstep because `@vitest/coverage-v8` pins an exact `vitest` peer; Dependabot
  is now configured to group them. Dev-only — no effect on the published package. ([#8])

[#7]: https://github.com/marco-jardim/opencode-model-router/pull/7
[#8]: https://github.com/marco-jardim/opencode-model-router/pull/8
[#9]: https://github.com/marco-jardim/opencode-model-router/issues/9
[#10]: https://github.com/marco-jardim/opencode-model-router/pull/10

## [1.3.0]

### Changed — advisory enforcement is now the default

- **Default enforcement mode flipped `off` → `advisory`.** With `enforcement.mode`
  unset, every non-trivial delegation is now verified and any miss surfaces a
  non-blocking forcing-note; the orchestrator system prompt grows by ~200 tokens for
  the DoD/acceptance section, and subagents may receive non-blocking guard banners.
  Nothing is ever hard-blocked in `advisory`. To restore the previous byte-identical
  behaviour (zero added tokens, zero new latency), set `"mode": "off"` explicitly, run
  `/router enforce off`, or set `MODEL_ROUTER_ENFORCE=0`.
- **The custom `delegate` tool is now hidden by default.** Delegation routes through the
  native `Task()` tool so subagents render inline in the TUI instead of running in an
  invisible orphan session (fixes the `delegate [tier=…, task=…]` stall). The
  independently-verified `delegate` tool remains available behind an opt-in flag.
- The acceptance forcing-note now includes tier-escalation guidance
  (`Task(subagent_type="<nextTier>")`) when a delegated result is not accepted.

### Added

- `experimental.verifiedDelegateTool` config flag in `tiers.json`, and the
  `MODEL_ROUTER_VERIFIED_DELEGATE=1` environment variable, to opt back into the
  authoritative `delegate` tool.

## [1.2.0]

### Added — Enforced delegation (opt-in, default OFF)

A three-layer enforcement system that makes tiered delegation *reliable* instead of
advisory. **It is opt-in and disabled by default**: with `enforcement.mode` unset (or
`"off"`), behaviour is byte-identical to previous releases — no added prompt tokens, no
new runtime behaviour. Enable per repo via `enforcement.mode` in `tiers.json`, per run
via the `MODEL_ROUTER_ENFORCE=1` environment variable, or per session via
`/router enforce <off|advisory|enforced>`. Enforcement applies only to subagent/delegate
sessions; the orchestrator session is never gated.

- **Layer 1 — hard-block guard** (`tool.execute.before`): an in-band, throw-to-block
  guard for subagent sessions. Enforces a tool-call budget ceiling, anti-redundancy
  (repeated identical reads), and anti-self-script (ad-hoc `bash` execution such as
  heredocs / `node -e` / `cat >`), with an optional deliverable-first rule. Writing
  source files is *never* blocked by default (`blockScriptWrites` is opt-in).
  `off` is a no-op, `advisory` surfaces a banner, `enforced` blocks.
- **Layer 2 — independent acceptance gate**: turns "the producer says it's done" into
  "the output was objectively accepted". A Definition-of-Done is parsed from an
  `[acceptance]` block (Mode B) or auto-inferred from the dispatch (Mode A) and checked
  either deterministically (`run` / `fileExists` / `schemaMatch` / `testsPass` /
  `buildPasses` / `lintClean` behind an allowlisted exec/fs seam) or by an **independent
  grader** in a fresh session at a tier ≥ the producer's. Fail-closed: any error,
  unparseable verdict, or non-independent grader counts as a failure. Never silently
  accepts a non-trivial delegation that lacks a checkable DoD.
- **Layer 3 — quality-escalation ladder**: on a failed gate the authoritative `delegate`
  tool retries, then escalates `fast → medium → heavy`, then returns an honest
  `status: unmet` — never a fake pass. Provably terminating (bounded by
  `maxAttemptsPerTier`, `maxTotalAttempts`, and a cost ceiling) and composes with the
  existing advisory provider-failover chain without double-counting attempts.

### Added — tooling & APIs

- New `delegate` tool (authoritative produce → verify → escalate in one call) alongside
  the existing raw `Task()` path (advisory-grade verify-dispatch).
- New `/router enforce <off|advisory|enforced>` command (persisted atomically).
- New `enforcement` configuration block in `tiers.json` (fully validated; see
  `docs/CONFIG_REFERENCE.md`). Per-mode example presets in `docs/ENFORCEMENT_PRESETS.md`.
- TypeScript + Vitest test infrastructure, golden-snapshot characterization tests, and a
  coverage gate. Documentation suite: `docs/ENFORCEMENT.md`, `docs/VERIFICATION.md`,
  `docs/ESCALATION.md`, `docs/CONFIG_REFERENCE.md`, `docs/MIGRATION.md`, and ADRs
  `docs/adr/0000`–`0002`.

### Security

- Secret scrubbing (`scrubText`) is applied to every model-visible string the enforcement
  layers emit — forcing messages, grader prompts, scorecards, and trajectory dumps.
- The deterministic verifier runs only allowlisted binaries, rejects shell
  metacharacters, and blocks interpreter eval flags (`node -e`, `python -c`, …).

### Notes

- Default is OFF; upgrading changes nothing until you opt in. See `docs/MIGRATION.md`.
- The bundled per-mode enforcement presets are **preliminary** (tuned from fixtures, not
  field telemetry) and are documented rather than written into `tiers.json`.
