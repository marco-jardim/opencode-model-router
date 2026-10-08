# Roles mode: role × tier × assurance delegation (#84)

Roles mode replaces "the orchestrator picks a tier" with "the orchestrator picks a **role**; the router picks the
**tier**; the **assurance** of the dispatch decides how cheap that tier may be". It is opt-in and **OpenCode v2 only**:
with `routing.delegation: "tiers"` (the default) and on OpenCode v1 nothing on this page applies.

> **Decision record:** [`adr/0006-role-tier-assurance-delegation.md`](./adr/0006-role-tier-assurance-delegation.md).
> **Every key and default:** [`CONFIG_REFERENCE.md`](./CONFIG_REFERENCE.md#roles-delegation-84). **Engine side
> (role ladders, `decideRole`, exploration):** [`ROUTING_ENGINE.md`](./ROUTING_ENGINE.md#roles-mode-84). **Plan, spikes
> and QA reports:** [`plans/role-tier-assurance-delegation-plan.md`](./plans/role-tier-assurance-delegation-plan.md),
> [`qa/role-tier/spikes.md`](./qa/role-tier/spikes.md), [`qa/role-tier/`](./qa/role-tier/).
>
> Numbers on this page are the code's; `test/unit/docs-drift.test.ts` compares the roles table and the floor table
> with `SHIPPED_ROLE_SPECS` (`src/router/roles.ts`) and `authorityFloor` (`src/routing/roles/policy.ts`).

## Contents

- [The three axes](#the-three-axes)
- [Turning it on](#turning-it-on)
- [The shipped roles](#the-shipped-roles)
- [Action classes](#action-classes)
- [Separation rule and residual risks](#separation-rule-and-residual-risks)
- [Work roots](#work-roots)
- [Tier floor](#tier-floor)
- [Dynamic authority and the ladder](#dynamic-authority-and-the-ladder)
- [Budgets](#budgets)
- [Outcome signals](#outcome-signals)
- [Exploration](#exploration)
- [`router_run`](#router_run)
- [Roles mode is decided at plugin start](#roles-mode-is-decided-at-plugin-start)
- [OpenCode v1 fallback](#opencode-v1-fallback)
- [Migration from `subagentTiers` and `agents`](#migration-from-subagenttiers-and-agents)
- [Observability](#observability)
- [Limits](#limits)
- [Where things live](#where-things-live)

## The three axes

A role dispatch is **role × tier × assurance**:

- **Role** — chosen by the orchestrator, by intent (`subagent(agent="explorer", …)`). The role carries a capability
  contract (its maximum authority), a prompt with the return contract, a guard profile, a call budget per tier and a
  default assurance.
- **Tier** — chosen by the router for every dispatch: the class's static tier, clamped into the role's tier range and
  raised to the [authority floor](#tier-floor); with `routing.engine: "enforce"` the kernel's expected-cost decision
  (A27 evidence gate) may move it inside that window. The router always sets the per-call `model`; the orchestrator
  never does.
- **Assurance** — the **effective** detection of the dispatch: `deterministic` only when the router's own verification
  gate will run the acceptance checks for this dispatch; otherwise the weaker of the route line's `d=` claim and the
  prompt's `[acceptance]` block, capped at `grader` (`effectiveDetection`, A34). A claim alone is never deterministic.
  The role's default assurance applies only when the dispatch carries neither.

## Turning it on

In the global override file `~/.config/opencode/opencode-model-router.overrides.jsonc`, then **restart OpenCode**:

```jsonc
{
  "routing": {
    "delegation": "roles",
    // only when role dispatches work in git worktrees created after OpenCode started (see Work roots)
    "workRoots": ["D:/git/my-repo-wt-*"]
  }
}
```

What changes after the restart:

- The seven role agents below are registered as router-defined agents with their **max** policy (deny-by-default,
  fail-closed; `execute`, `subagent`, `task`, `delegate` and `shell` denied explicitly; sensitive-file reads ask, as on
  the read-only tiers). In roles mode the role `general` replaces the host's native `general`, and a dispatch of the
  host's native `explore` is sent to `explorer` instead.
- The tools `router_run` and `router_request_authority` (the latter only when a dynamic role is enabled) are
  registered, and `router_git_*` run in the dispatch's work root.
- The orchestrator's system prompt carries `## Role Delegation Protocol (MANDATORY)` instead of the tier protocol: a
  role menu, the route-line keys, "never set `model` and never pick a tier", the resume rules. The tier agents `fast`,
  `medium` and `heavy` stay registered and callable (an explicit tier dispatch behaves as in tiers mode); the protocol
  just stops advertising them.

`routing.engine` keeps its meaning: under `static` a role dispatch gets the static default of its window and no
decision row is written; under `shadow`/`advise` the decision is logged and the static default (or the pinned
tier) is dispatched; under
`enforce` the kernel's switch applies (never on a resume) and [exploration](#exploration) may run.

## The shipped roles

The roles live in code (`SHIPPED_ROLE_SPECS`), not in `tiers.json`, so no configuration can widen their authority.
`roleAgents.<name>` (global layer only) may disable a role, replace its description or prompt (the router contract
block is always appended), narrow its tier range, change its budget (at most 2 × the shipped value) and `deny`
actions. Tier ranges are placed on the active preset's cost order; the bundled presets all order
`fast` < `medium` < `heavy`, so the ranges below apply as written.

<!-- roles-table -->
| Agent | Kind | Shipped description (intent) | Authority mode | Authority (max) | Tier range | Default assurance | Guard | Budget (calls per tier) | Host steps |
|---|---|---|---|---|---|---|---|---|---|
| `explorer` | `explore` | Read-only codebase exploration: finds files, symbols and facts in the work root. | `fixed` | `read`, `glob`, `grep`, `router_git` | `fast`–`medium` | `none` | `reader` | `fast` 30 · `medium` 40 | 95 |
| `researcher` | `research` | Web and library documentation research (webfetch, websearch, context7); no local file access. | `fixed` | `webfetch`, `websearch`, `context7` | `fast`–`medium` | `none` | `reader` | `fast` 30 · `medium` 40 | 95 |
| `runner` | `run` | Runs the repository's checks (tests, typecheck, lint, build) with router_run and reports the results; never edits. | `fixed` | `read`, `glob`, `grep`, `router_git`, `router_run` | `fast`–`medium` | `deterministic` | `reader` | `fast` 25 · `medium` 40 | 95 |
| `implementer` | `implement` | Implements a scoped change in the work root; runs checks when the task needs them. | `dynamic` | `read`, `glob`, `grep`, `router_git`, `edit`, `router_run` | `fast`–`heavy` | `none` | `producer` | `fast` 40 · `medium` 80 · `heavy` 120 | 255 |
| `reviewer` | `review` | Read-only senior review: defects, risks and regressions, confirmed with router_run where a run settles them. | `fixed` | `read`, `glob`, `grep`, `router_git`, `router_run` | `heavy`–`heavy` | `none` | `reader` | `heavy` 120 | 255 |
| `architect` | `design` | Read-only design analysis: framing, options, tradeoffs and a recommendation. | `fixed` | `read`, `glob`, `grep`, `router_git` | `medium`–`heavy` | `none` | `reader` | `medium` 80 · `heavy` 120 | 255 |
| `general` | `general` | General-purpose work in the work root; its authority follows the task's needs (local, edit, router_run). | `dynamic` | `read`, `glob`, `grep`, `router_git`, `edit`, `router_run` | `fast`–`heavy` | `none` | `producer` | `fast` 40 · `medium` 80 · `heavy` 120 | 255 |

- **Fixed** roles get their whole max on every dispatch. **Dynamic** roles start from a base and add what the task
  needs: `implementer` starts with local + `edit`, `general` with local only; the classifier's `needs` and the route
  line's `needs=` add `edit` (`edit`) and `router_run` (`shell` or `network`), always inside the max.
- `router_git` stands for the six `router_git_*` tools; `context7` for the context7 documentation tools, present only
  when an MCP server named `context7` is configured. `execute` (Code Mode) is denied to every role: its inner calls
  are never permission-checked and its catalog cannot be filtered (spike S8). `brave_*` search is not available to
  `researcher`.
- Every prompt ends with the work-root rule and the return contract (`DONE:` / `NEED MORE:` / `ESCALATE:`, evidence as
  `file:line`); roles that can edit add "if `edit` is denied return `ESCALATE: authority`; never deliver a diff as
  text".
- **Host steps** is the host's `steps` limit of the role agent: 2 × the top budget of the role + `REFUSAL_CAP` (10) +
  5, so the router's `NEED MORE: budget` always comes before the host's own step limit, even with `budget=` at its
  maximum.

## Action classes

| Class | Actions |
|---|---|
| local | `read`, `glob`, `grep`, `router_git_*`; also `list`, `lsp`, `skill` and `external_directory` |
| exec | `router_run` |
| write | `edit` (and the host's `write`, `patch`, `multiedit`, `apply_patch`) |
| egress | `webfetch`, `websearch`, `context7_*`, `execute`, `shell`/`bash`, every MCP tool, `subagent`/`task`/`delegate`, and any tool name the router does not know (fail closed) |

`todowrite`, `todoread` and `question` are neutral (no repository data, no network). The classes are
`ACTION_CLASS` and `classifyAction` in `src/router/roles.ts`.

## Separation rule and residual risks

**No grant contains a local, exec or write action together with an egress action** (invariant I4). The validator
checks every shipped role, every `roleAgents` narrowing and, in roles mode, every #81 `agents` entry that has a role's
name. At dispatch time a grant that would mix them loses its egress, with a note. Consequences:

- A task that needs the web is split: `researcher` first, then its findings pasted into the `implementer` dispatch. A
  local role whose task mentions the web gets the note "web access is outside this role — use `researcher`".
- Raw shell is outside roles mode. A `shell`/`network` need maps to `router_run` (where the role allows it) and the
  note "raw shell is outside roles mode — dispatch a tier agent explicitly".
- No role can delegate (`subagent`, `task`, `delegate` are denied) and no role child may call a tool outside its
  role's action classes.

**What the rule does not cover** (documented residual risks):

- **Repository scripts may reach the network.** `router_run` runs `package.json` scripts and configured commands; what
  they do is repository content. The floor table raises write + exec to `medium`/`heavy` for that reason.
- **Untrusted repository content is a prompt-injection vector.** A file a role reads can carry instructions; the
  separation rule only removes the role's own read → egress path.
- **Flows routed through the orchestrator.** The orchestrator sees every role's result and can paste a local finding
  into a `researcher` prompt. The rule separates roles, not the session.
- **Host `grep` (ripgrep) may follow links inside the work root**, which the router does not see.
- **The host's tool-output folder.** Reading roles keep the host's inherited `external_directory` allow for its
  tool-output folder, so they can read their own truncated tool outputs; the router narrows it per session to the
  files the host names in that session's structured `outputPaths` (never free text).

## Work roots

Every role dispatch has exactly one **work root**: the session directory, or a git worktree of the same repository
named on the route line with `root=<absolute path>` (and repeated in ENVIRONMENT). `read`, `glob`, `grep`,
`router_git_*`, `edit` and `router_run` work inside it only; any other path is denied.

- **Resolution.** The `root=` text is normalised and compared with the session directory and with every entry of
  `git worktree list --porcelain` before any filesystem call on it; a match becomes its canonical long form. Anything
  else gives **no work root**: the dispatch keeps local reads in the session directory, and `edit` and `router_run` are
  withheld (note "no valid work root: write and run withheld").
- **Registration.** The role agents' max policy allows `external_directory` for the worktree roots git lists when the
  agents are registered, plus the `routing.workRoots` globs (global layer only, default `[]`), never `*`. A worktree
  created after registration is covered only by a matching `routing.workRoots` glob (or the next restart). Roles
  without local actions (`researcher`) get no `external_directory` rule.
- **Canonical long form.** Write `routing.workRoots` entries in their canonical long spelling: an 8.3 short segment
  (`PROGRA~1`) is refused, because the host compares spellings and a short name can alias another directory.
- **Over-match.** `*` crosses separators: `D:/git/omr-rta-*` allows every directory starting with `omr-rta-`, nested
  paths included, for every role agent. The registered policy cannot tell dispatches apart; the router's permission
  hook narrows each session to its own bound work root (re-checked against a fresh `git worktree list`), and unknown
  bindings get no `external_directory` at all.
- `router_run` takes `cwd`, which must name the bound work root; `router_git_*` run in the bound work root, never in
  the session location.

## Tier floor

The window of a role dispatch is `[floor, ceiling]`:

- floor = max(the role's range floor, the authority floor below, `enforcement.escalate.floorTier`, the child's running
  tier on a resume, a raise the router recorded after a verification FAIL of this child);
- ceiling = the role's range ceiling; when the floor is above it, the floor wins and the range widens upward only;
- risk and scope = max(classifier, route line): the route line can raise them, never lower them;
- a route-line `tier=` pin is honoured inside the window; below the floor it is lifted (reason `lift:authority` or
  `lift:floor`), above the ceiling it is clamped (`clamp:ceiling`).

`authorityFloor(grant, detection, risk, scope)` — the effective detection decides the column:

<!-- authority-floor-table -->
| Grant contains | `deterministic` | `grader` | `none` |
|---|---|---|---|
| no write (local, egress or exec only) | `fast` | `fast` | `fast` |
| write without exec | `fast` if risk `low` and scope `single`, else `medium` | `medium` | `medium`; `heavy` if risk `high` |
| write + exec | `medium` | `heavy` | `heavy` |

Write authority goes to the cheapest tier only behind checks the router runs itself, and edit + execution never runs
on `fast`: an edit can change what a script does, so write + exec is treated like running code the agent wrote. After
a verification FAIL the router raises the child's floor for its next resume itself; the orchestrator never sets
`tier=` or `model` for that.

## Dynamic authority and the ladder

**Grant** = role max ∩ (base ∪ needs-derived actions ∪ actions widened on resume) for dynamic roles; the whole max for
fixed roles. It is enforced three times: the agent's registered max policy (host), the router's permission hook
narrowing each session to its dispatch grant and work root, and the router's context hook removing non-granted tools
from that session's catalog. `router_run` and `router_git_*` check the binding themselves, because no permission hook
fires for plugin tools.

**Binding.** Each fresh role dispatch carries a router-made nonce: the description ends with ` [nonce <n>]` and the
prompt's last line is `OMR_NONCE=<n>`. The child is bound to its dispatch at its first context build. A binding is
**exact** only through that nonce; a missing, foreign or conflicting nonce makes it **unknown**: role max ∩ local
actions, no `router_run`, no `external_directory`, a note telling the child to call `router_request_authority`, a
decision row with `binding: unknown` and the advisor finding `role-binding-unknown`. Ambiguity never widens authority.
Errors fail closed: a context-hook error leaves the role child an empty tool catalog, a permission-hook error denies.

**The ladder** (dynamic roles only):

1. The child calls `router_request_authority({ actions, reason })`.
2. Inside the role max the request is recorded and the child is told to stop with `ESCALATE: authority`. Outside the
   max it is refused, naming the role that has the action (`researcher` for egress, …); fixed roles, `execute`, raw
   shell and `router_run` without a work root are refused too.
3. The router annotates the parent's `subagent` result with resume guidance.
4. The orchestrator resumes the **same** `sessionID`. The grant widens only for an **exact** binding (an unknown one
   drops the request with a notice), the floor is recomputed — the per-call model may rise — and the decision row
   records the widening.

## Budgets

| Item | Value |
|---|---|
| Role dispatch total | the role's budget for the routed tier (table above); `budget=<n>` on the route line raises it, never above 2 × |
| Cumulative ceiling across resumes | total × 3 |
| Refused calls | not charged to the budget, not recorded as executed by the repeat check; a round is stopped for refusals once it has min(budget, `REFUSAL_CAP` = 10) of them and executed + refused calls reach the budget |
| Host `steps` of a role agent | 2 × top role budget + `REFUSAL_CAP` + 5 (95 or 255 for the shipped roles) |
| Tier agents (`fast`, `medium`, `heavy`) | unchanged: 25 calls, cumulative × 3 |

Reader roles are never denied for "non-producing" reads; producer roles keep the read/draft guard. `CAP:N` (or
`CAP:none` with a `reason:` line) changes only the read-only call counter, and a role dispatch has a read-only cap only
when it carries one.

**Exhaustion is not failure.** When the budget runs out the child is told to return `NEED MORE: budget` with a
progress summary, and the parent's result gets a note starting with `[router budget]` (also when the host's step limit
or a context overflow stopped the child). Resume the **same** `sessionID` with "continue and finish"; the router keeps
the child's tier and a resumed round takes its own budget. Budget exhaustion is recorded as a `budget` signal with no
tier penalty.

## Outcome signals

Positive evidence comes only from external verification (invariant I6); budget and authority events never count as
failures (I7).

| Signal | Weight | When |
|---|---|---|
| `verdict` | 1 (pass or fail) | the router's deterministic gate |
| `run` | 1 (success only) | a router-observed `router_run` of every acceptance command, exit 0, started after the child's last edit |
| `grader` | 0.5 (pass or fail) | an independent grader: tier ≥ the producer's tier **and** another model |
| `incomplete` | 0.5 (failure) | an explicit `NEED MORE` / `ESCALATE` return without an observed budget stop or authority request |
| `redispatch` | 0.5 (failure, on the earlier attempt) | the same task (compared over its TASK section) sent again to a higher tier within 30 minutes |
| `budget`, `authority` | 0 (recorded, no tier penalty) | an observed budget stop; an authority request |
| `DONE` alone | 0 (no signal) | self-report never moves evidence |

A return without a contract prefix gives no signal. For verification, a progress note (no contract marker, ending with
a first-person "I'll continue …") or a budget stop is `incomplete`: never accepted, no next tier, no evidence. Signals are written as annotation rows of the decision log (`note:signal:<kind>:<pass|fail|none>`), which
is why downgrading below the release that introduced them is unsupported.

## Exploration

Off by default. `routing.exploration.rate` (global layer only, `0` by default, at most `0.2`; a larger or invalid
value falls back to `0` with a notice) lets `enforce` send a share of role dispatches to a **cheaper** rung on purpose,
so cheaper tiers can earn evidence. It runs only when the effective detection is `deterministic`
(`routing.exploration.requireDetection` is fixed), never on a pinned, resumed or high-risk dispatch, and only to a rung
at or above the floor and strictly below the static default. The draw is seeded by the decision id (replayable); rows
carry `explore` and `propensity` and the reason `explore`. It is the one documented exception to "never down". In
tiers mode the rate is always `0`.

## `router_run`

`router_run({ script, args?, cwd })` runs **one** allowlisted entry in the dispatch's work root and returns its exit
code. It never spawns a shell itself (fixed argv, `shell: false`).

- **Entries.** A `package.json` script named in `routing.run.scripts` (exact names; default
  `["test", "typecheck", "lint", "build"]`), or a `routing.run.commands` entry; a command wins over a script of the
  same name. Scripts take no caller arguments. To run another script (say `test:unit`), list it by name or add a
  command entry such as `{ "argv": ["npm", "run", "test:unit"] }`.
- **Arguments.** Only for a command entry that declares `args`: each pattern is an exact string or a prefix ending in
  `*` (`test/*`); an option-like argument (leading `-`, `@` or `+`) matches only a pattern with the same leading
  character. Every argument must also match `^[A-Za-z0-9_./:=@+-]{1,200}$` (at most 50 arguments). Confinement always
  applies: an absolute, drive, UNC or URL path or a `..` segment is refused, and a **single-dash** argument (`-x…`)
  carrying any `/`, `\` or `..` is refused (short-option clusters such as `-br../x` hide a path); pass paths through a
  checked `--long=value` argument instead.
- **Executables.** Shells (`cmd`, `powershell`, `sh`, `bash`, `env`, …) are refused as a command's executable, and no
  executable is resolved from inside the repository. npm runs as `node <npm-cli.js>` from the Node install, limited to
  `run`, `run-script`, `test`, `start`, `stop` and `restart` with the flags `--silent`, `-s`, `--quiet`, `-q`,
  `--if-present`, and with `--script-shell=<absolute system shell>`, `--node-options=`, `--workspaces=false`,
  `--update-notifier=false`, `--logs-max=0`, `--userconfig` and `--globalconfig` on its command line.
- **`.npmrc` refusals.** A work-root `.npmrc` that sets `workspace`, `workspaces` or `include-workspace-root` (npm
  would run another package's scripts) or `globalconfig`, `userconfig` or `prefix` (it would move npm's config files)
  makes the run refuse. Other repository `.npmrc` settings (cache, registry, …) still apply to npm. The user's own
  `~/.npmrc` may set `globalconfig`, which outranks the command line (user-owned, outside every work root).
- **Script bodies are trusted repository content**, run by npm's script shell exactly as `npm run <name>` would,
  including the `pre<name>` / `post<name>` hooks npm runs with them. `router_run` pins which npm, node and shell run
  them; it does not and cannot make a script safe.
- **Environment.** Dropped: every `npm_*` variable, `NODE_OPTIONS`, `PREFIX` and credential-like names (`TOKEN`,
  `SECRET`, `PASSWORD`, `API_KEY`, `ACCESS_KEY`, `PRIVATE_KEY`, `CREDENTIALS`, … and known provider keys); relative
  `PATH` entries are removed; `CI=1` is set. **What stays reachable:** the ssh-agent socket, git credential helpers
  and the OS keychain, cloud CLI caches in the home directory (`~/.aws`, `~/.config/gcloud`, `~/.azure`,
  `~/.docker/config.json`, …) and credentials carried by variables with other names. A script can use them as you can.
- **Bounds.** Timeout `routing.run.timeoutMs` (default 600000 ms) with a process-tree kill; output bounded to 64 KiB
  with a notice; best-effort redaction of URL userinfo and credential-like query parameters (not a secret scanner).

## Roles mode is decided at plugin start

Role agents, `router_run`, `router_request_authority` and the work-root resolver are registered only when the plugin
**started** with `routing.delegation: "roles"`. Switching the override to `roles` while OpenCode runs logs once

> roles mode (OpenCode v2 only): routing.delegation is now `roles`, but this OpenCode instance started in tiers mode;
> restart OpenCode to register the role agents and tools (tiers mode stays active until then)

and registers nothing.
Switching back to `tiers` drops the role agents at the next agent build, but the role tools stay registered until the
next start: restart OpenCode after either switch.

## OpenCode v1 fallback

On OpenCode v1, `routing.delegation: "roles"`, `roleAgents`, `routing.exploration`, `routing.run` and
`routing.workRoots` are validated but **inert**, with one log line per process at plugin start:
`roles delegation requires OpenCode v2; using tiers`. No role agent, tool, hook or prompt change is registered; v1
keeps the tier model.

## Migration from `subagentTiers` and `agents`

- **`subagentTiers.explore`.** In roles mode a dispatch of the host's `explore` goes to `explorer`, whose tier the
  router picks; remove the mapping (a `subagentTiers` entry for a role name can also put a resumed child back under
  the tier agents' 25-call cap).
- **#81 `agents` with a role name** (`runner`, `reviewer`, `researcher`, …). In roles mode an entry that passes the
  separation rule **replaces** the shipped role of that name (notice
  `agents.<name> replaces the shipped role agent <name> in roles mode`); one that fails it (for example `read` with
  `webfetch`) is dropped with a notice and the advisor finding `role-separation`, and the shipped role stays. Remove
  such entries to use the shipped roles. In tiers mode and on v1 they behave exactly as before.
- **Example** (the owner migration of this release): add `"delegation": "roles"` and `"workRoots"` to `routing`
  (keeping `engine`, `profile`, `margin`), remove `subagentTiers.explore`, remove the custom `agents` `runner`,
  `reviewer` and `researcher`, keep `routing.exploration` unset (`0`).
- **Kill switch.** Restore the previous override file (keep a backup before migrating) **and restart OpenCode**: tiers
  mode, the custom agents and the `explore` mapping come back, and the role agents and tools are unregistered.

## Observability

- `/router` lists the role table with ranges and authority, and the advisor findings `role-separation`,
  `roles-on-legacy-host`, `role-budget-low`, `role-range-clamped`, `role-binding-unknown`, `native-explore-aliased`,
  `roles-none-enabled` and `role-usage-share` ([cost doctor](./ROUTING_ENGINE.md#the-cost-doctor)).
- Decision rows of role dispatches carry `role`, `grant`, `detection`, `boundsReasons`, `budgetUsed`, `signal`,
  `explore`, `propensity` and `binding`; `/router stats` and `npm run routing:stats` break dispatches down by role and
  tier, with signals by kind, budget stops, authority requests, unknown bindings and exploration.

## Limits

- **Not an OS sandbox.** Roles are host permission policies plus router hooks. Script bodies, repository content, the
  user's credential stores and anything the host itself does (its own search, its tool-output store) are outside them.
- **Acceptance checks of a role dispatch** in a worktree run in the session directory unless the `[acceptance]` block
  names `cwd: <work root>` (dogfood finding DF2-F1); put the work root there.
- **The rules classifier is noisy.** It may attribute `edit` or `shell` to a task that does not mention them, which
  grants a dynamic role more of its max than the task needs (always within the max and the separation rule) and makes
  the ladder rarely needed (DF2-F2). Use `needs=` on the route line to be explicit.
- **No live learning yet.** Savings come from structural defaults (cheap tiers for reading roles); the engine only
  switches with evidence, and exploration is off by default.

## Where things live

| Part | Code |
|---|---|
| Role specs, action classes, separation validator, role table | `src/router/roles.ts`, `src/router/roles-config.ts` |
| Role agent registration (max policy, steps, aliases) | `src/router/role-agents.ts`, `src/compat/v2-hooks.ts` |
| Grant, authority floor, tier window | `src/routing/roles/policy.ts` |
| Binding and the authority ladder | `src/routing/roles/binding.ts`, `src/routing/roles/authority.ts` |
| Role dispatch path, work root resolution | `src/routing/wire/dispatch.ts` |
| Role ladders, `decideRole`, exploration | `src/routing/engine/ladders.ts`, `src/routing/engine/kernel.ts` |
| Guard profiles and budgets | `src/router/guard-profile.ts`, `src/guard/` |
| `router_run` | `src/router/run-tools.ts` |
| Outcome signals | `src/routing/outcomes/signals.ts` |
| Roles protocol | `src/router/protocol.ts` |
