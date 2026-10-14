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
- [Background dispatches](#background-dispatches)
- [File leases](#file-leases)
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
  descriptive default assurance (what its dispatches usually carry; never an input of the routing).
- **Tier** — chosen by the router for every dispatch: the class's static tier, clamped into the role's tier range and
  raised to the [authority floor](#tier-floor); with `routing.engine: "enforce"` the kernel's expected-cost decision
  (A27 evidence gate) may move it inside that window. The router always sets the per-call `model`; the orchestrator
  never does.
- **Assurance** — the **effective** detection of the dispatch, computed from three inputs only: whether the router's
  own verification gate will run the acceptance checks for this dispatch in its work root (`deterministic`), the route
  line's `d=` claim and the prompt's `[acceptance]` block. Without the gate it is the weaker of the claim and the block,
  capped at `grader` (`effectiveDetection`, A34): a claim alone is never deterministic, and a dispatch with neither is
  `none` — for every role. **Unlike a tier dispatch, a role dispatch without a `d=` claim is `none` even when its prompt
  has an `[acceptance]` block** (unless the gate runs its checks): write `d=grader` (or `d=deterministic`, which counts
  as `grader` without the gate) on the route line to claim it. The role's default assurance in the table below is descriptive only: it never raises or
  lowers a dispatch's detection. When no verification will run at all — enforcement `off`, `/bypass`,
  `enforcement.verify.require: "never"`, or a requested `cwd` outside the root the gate verifies in — the detection is
  `none`, whatever the claim or the block says.

## Turning it on

In the global override file `~/.config/opencode/opencode-model-router.overrides.jsonc`, then **restart OpenCode**:

```jsonc
{
  "routing": {
    "delegation": "roles",
    // only for later-created worktrees outside the trusted executor slots root (see Work roots)
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
  role menu, the route-line keys, "never set `model` or pick a tier; name the role", the resume rules (a resume keeps
the dispatch's `[acceptance]` and `VERIFY:` lines; a new block replaces them). The tier agents `fast`,
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

- **Default assurance is descriptive.** `runner` ships `deterministic` because its results are router-observed runs,
  every other role ships `none`; neither value enters the routing. A runner dispatch is `deterministic` only when the
  router's gate runs its acceptance checks, like any other role's.
- **Fixed** roles get their whole max on every dispatch. **Dynamic** roles start from a base and add what the task
  needs: `implementer` starts with local + `edit`, `general` with local only; the classifier's `needs` add `edit`
  (`edit`) and `router_run` (`shell` or `network`), always inside the max. For a dynamic role a route-line `needs=`
  replaces the needs the text implies: the listed needs plus the route class's implied needs (`network` ⇒ `shell`)
  are the dispatch's needs, whether or not the text names them, always inside the role max. Without `needs=`, a
  `class=` keeps the needs the text names plus that class's implied needs, so the class it replaced takes its implied
  needs with it.
- `router_git` stands for the six `router_git_*` tools; `context7` for the context7 documentation tools, present only
  when an MCP server named `context7` is configured. `execute` (Code Mode) is denied to every role: its inner calls
  are never permission-checked and its catalog cannot be filtered (spike S8). `brave_*` search is not available to
  `researcher`.
- Every prompt ends with the work-root rule and the return contract (`DONE:` / `NEED MORE:` / `ESCALATE:`, evidence as
  `file:line`); roles that can edit add "if `edit` is denied return `ESCALATE: authority`; never deliver a diff as
  text".
- **Host steps** is the host's `steps` limit of the role agent: 2 × max(the top budget of the role, 25) +
  `REFUSAL_CAP` (10) + 5, so the router's `NEED MORE: budget` always comes before the host's own step limit, even with
  `budget=` at its maximum and on a tier the role has no budget for.

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
  tool-output folder; the router narrows it per session to the files the host names in that session's structured
  `outputPaths` (never free text). On OpenCode 2.0.24 those events carry no `outputPaths`, so nothing is allowed there
  (see [Limits](#limits)).

## Work roots

Every role dispatch has exactly one **work root**: the session directory, or a git worktree of the same repository
named on the route line with `root=<absolute path>` (and repeated in ENVIRONMENT). `read`, `glob`, `grep`,
`router_git_*`, `edit` and `router_run` work inside it only; any other path is denied. A role child gets its task
without the route line, so the role prompt says: "The router's `Working directory:` line and the work root in this
dispatch's ENVIRONMENT win over the working directory in the host's environment block." The host's block can name the
parent's directory.

- **Resolution.** The `root=` text is normalised and compared with the session directory and with every entry of
  `git worktree list --porcelain` before any filesystem call on it; a match becomes its canonical long form. Anything
  else gives **no work root**, and a route line that declared `root=`, `repo=` or `branch=` and got none **refuses the
  dispatch**: the task call fails with `[router] role dispatch @<agent> refused: <note>` and the child never runs in the
  session directory instead. A dispatch that declared nothing is not refused (no declared target, no refusal); if it still has no work root, it keeps
  local reads in the session directory, and `edit` and `router_run` are withheld (note "no valid work root: write and
  run withheld").
- **`edit` and `router_run` need a validated work root.** On a fresh dispatch, on a resume and through the
  [ladder](#dynamic-authority-and-the-ladder) alike, a dispatch without one gets neither; `edit` never falls back to
  the session or plugin directory (only the local reads do).
- **`.git` is never edited.** A role's `edit` — every host edit tool (`edit`, `write`, `patch`, `multiedit`,
  `apply_patch`) — is refused for `.git` and anything under it, the work root's own or a nested repository's: every
  segment of the path as written and of its canonical form below the root is checked (case-insensitively, ignoring
  trailing dots and spaces and an NTFS `:stream` suffix; a link or junction into `.git` counts).
- **Registration.** The role agents' max policy allows `external_directory` for the worktree roots git lists when the
  agents are registered, plus the `routing.workRoots` globs (global layer only, default `[]`), never `*`. A worktree
  created after the plugin started outside the trusted executor slots root is covered only by a matching
  `routing.workRoots` glob (or a restart). Roles without local actions (`researcher`) get no `external_directory`
  rule. When `routing.workRoots` is set and the
  directory OpenCode started in lies outside every entry (compared in its canonical form), the router runs no
  `git worktree list` at start. The role agents then get the `routing.workRoots` globs and, when safely resolved, the
  trusted executor slots-root allowance below.
- **Executor slots root.** On v2, role agents with local actions may work under the trusted slots root:
  `routing.executor.slotsDir` from the bundled configuration or global override, or `<repo drive>:\.omr-slots` by
  default. Each plan uses `<root>\<planId>`. `routing.workRoots` is not needed for it, including slots created after
  registration. This registered allowance does not widen a dispatch: each child still works only in its own validated
  work root. The executor home (`<git common dir>\omr-executor`) is denied, even if another directory allowance would
  cover it. A project-local `slotsDir` is ignored; a repository cannot grant itself an external slots root. If the
  executor home cannot be resolved, no slots-root allowance is added (fail closed). See
  [Assembly and lifecycle](./EXECUTOR.md#assembly-and-lifecycle).
- **Canonical long form.** Write `routing.workRoots` entries in their canonical long spelling: an 8.3 short segment
  (`PROGRA~1`) is refused, because the host compares spellings and a short name can alias another directory.
- **Over-match.** `*` crosses separators: `D:/git/omr-rta-*` allows every directory starting with `omr-rta-`, nested
  paths included, for every role agent. The registered policy cannot tell dispatches apart; the router's permission
  hook narrows each session to its own bound work root (re-checked against a fresh `git worktree list`), and unknown
  bindings get no `external_directory` at all.
- `router_run` takes `cwd`, which must name the bound work root; a network or device `cwd` (`\\host\share\…`,
  `//host/…`, `\\?\…`, `\\.\…`) that differs from the work root as text is refused before any filesystem call, unless the
  work root itself lies on that share.
- `router_git_*` run in the bound work root, never in the session location, and are limited to it: for a work root
  below the repository's top level every path and listing is limited to that subdirectory (a pathspec). They are
  refused when the work root belongs to another repository than the one the dispatch listed its worktrees in, or when
  a `.git` pointer (or a directory git reports) names a network or device path. With cross-repo configured, a role
  agent may pass `root` to read another repository of its read set instead (see **`router_git_*` in other
  repositories** below); the work root's limits above still apply to every call without it.
- The `git worktree list` runs that validate work roots inherit the user's system and global `safe.directory` values
  (only those), so a repository trusted that way does not fail with "dubious ownership".
- **Acceptance checks run in the work root.** The deterministic checks of a role dispatch's `[acceptance]` block run in
  its routed work root by default; a `cwd:` outside that root is refused. When the checks cannot run in the work root,
  the dispatch's detection is not `deterministic`, so the [floor](#tier-floor) is computed without the router's gate.

### Repositories below parent directories (cross-repo)

`routing.repoParents`, `routing.repoDepth` (1–4, default 2) and `routing.repoExclude` are global-only keys (OpenCode v2
roles mode, inert on v1). They name the directories whose repositories role dispatches may work in besides the session
repository, without a per-repository list:

```jsonc
{ "routing": { "delegation": "roles", "repoParents": ["D:/git"] } }
```

Registration adds a `<parent>/*` `external_directory` allow pattern to the local roles, so a repository cloned later
needs no restart. Changing `repoParents` does need one, and a parent must exist when the agents are registered.

**Naming the work root.** A dispatch still has one work root and edits only there. The route line names it with
`root=`, or by repository name and branch, which the router checks against git (values keep their case; an invalid
value refuses the dispatch, see below):

```text
[route class=implement needs=edit repo=app-a branch=feat/login]
```

`repo=` looks up `<parent>\<name>`, then `<parent>\*\<name>`; `<name>` is a repository name, or the directory name of
one of its linked worktrees below the parents (that worktree is the work root; with `branch=`, the worktree of its
repository on that branch). A name that matches several repositories or worktree directories (each listed as
`<worktree path> (repository <name>, branch <branch>)`), or a repository
with several worktrees and no `branch=`, refuses the dispatch and the candidates are listed. `root=<dir> branch=<b>` must
agree: the worktree at `<dir>` must be on `<b>`. `repo=<dir> branch=<b>` instead binds the worktree of that directory's
repository that is on `<b>`, which may lie outside the parents (admission rule 2 below). `root`, `repo` and `branch` must
agree when given together. With parents set, the protocol tells the orchestrator: name another repository with
`repo=<name>` (and `branch=<ref>` when it has several worktrees) instead of `root=`; each dispatch edits one
repository, and a role may read the others below `routing.repoParents`. A routed role dispatch that has a work root and
read access starts with a role header (`[router] You are @<role>. Execute this dispatch yourself.`), so the delegate is
told where it works. The header is emitted only when cross-repo is configured (`routing.repoParents` is set), the route
line declares a target (`repo=`, `branch=` or `root=`), or the work root differs from the session directory; otherwise the
dispatch prompt is byte-identical to what it was before the header existed (invariant I9). A fresh dispatch gets the header, the work root, and, when the grant is located, the repository,
branch and head: `Working directory: <root> (repository app-a, branch feat/login at 3f2c1a9). You are already there —
do not ask permission to read or write inside it.` A read-only role is told `read` instead of `read or write`. With
parents set, a second paragraph lists the session's repositories and where the role may read. The nonce line (or the
carried `[acceptance]` block of a resume) stays the last line of the prompt. A resume gets the header only when its
binding is exact, and without the head clause, which may be stale. A header the orchestrator copied from another dispatch
is always removed, and replaced only when the router adds its own (so a dispatch that gets no header keeps no copied one
either). A read-only role's repositories paragraph says only where it may read. No
header: no work root, no `read`/`glob`/`grep` (`researcher`), a delegate's dispatch, a non-exact resume, a dispatch for
which the header is not relevant (see above), or `dispatchHeader: false` (which still sends the role name and the `Working directory:` paragraph when the work root is not
the session directory).

**Admission.** On a v2 roles dispatch, when parents are set or `repo=`/`branch=` is given, the work root is bound
through admission. It is admitted when either:

1. it is a git top level 1 to `repoDepth` levels below a parent (never the parent itself), its canonical path stays
   below that parent, and it is not excluded by `repoExclude`; or
2. it is a worktree that a known repository lists: the session repository, or a repository in the session's working
   set. Its `git rev-parse --git-common-dir` must match that repository's, and it must still resolve to itself. What
   backs the admission is the repository that lists the worktree (git's main worktree, canonical), never the known
   entry's text: it must be the session repository, a repository with an approval that applies now and whose identity
   holds (the binding is then tagged with that approval), or a repository 1 to `repoDepth` levels below a parent. Any
   other known entry is skipped.

Text checks come before any git call: UNC, device, 8.3 and `..` paths are refused, and the refusal ends the dispatch
(`[router] role dispatch @<agent> refused: <note>`). A final gate runs on every
admission: `repoExclude` applies to both the shown and the canonical path, a candidate is never a configured parent or
an ancestor of one, and a path whose text lies below a parent must also lie below it canonically. An excluded or
link-escaping candidate is refused outright, with no fallback to rule 2. The linked worktrees of a repository excluded
by `routing.repoExclude` are excluded with it: a `repo=`, `branch=` or `root=` route line that names one is refused, and
they are kept out of the read set. When admission is in use, a `root=` other than
the session directory binds only through admission. The `repo=` lookup needs a `.git` entry before it runs git, skips
dot-directories, `node_modules` and excluded directories, visits at most 2000 directories and lists at most 10 notes.
The grant carries the repository, branch and worktree. The orchestrator session keeps a working set of up to 16 bound
roots, forgotten when the session is deleted. It grows only when `routing.repoParents` is set, from the accepted
grant's location and after the dispatch is registered; `branch=` alone still binds through declare-then-check but does
not grow it.

**Invalid route fields.** An invalid or duplicated `repo=` or `branch=`, or one that conflicts between route lines,
is an invalid declaration and refuses the dispatch with the note `<key>=<value> is not a valid repository name / branch
name: no work root. Fix the route line.` The same holds for a `root=` the route-line parser rejected (an invalid value, a
bare `root`, a duplicate or a conflicting one): the dispatch is refused with `root=<value> is not a valid absolute work root: no work root. Fix the route line.`
A refused dispatch fails the `task` call with `[router] role dispatch @<agent> refused: <note>`.

**Resume and the work root.** A resume of an exactly bound child keeps that child's work root. If its route line declares
another target (a `root=` that is neither the bound work root nor its worktree, another `repo=` name, another `branch=`,
or an invalid declaration), the resume is refused: `this child is bound to <work root> (repository <name>, branch
<branch>); a resume cannot change its work root: dispatch a new child`. A resume that declares nothing, or the bound
target, is unchanged. A route line is read from the first line of the prompt only: one placed after a copied header is
ignored (the copied header is stripped).

Branch names follow `git check-ref-format`, so `renovate/foo+bar` and `feat/ação` are valid. Names,
branches and paths echoed in refusals are quoted when they contain unsafe characters; an invalid branch shows as
`(unknown)`.

**Session in a subdirectory.** The work root stays the session directory when the bound worktree contains it and no
other git top level lies between them. A session in a worktree nested inside another (for example `.wt/feat` inside
main) is not kept.

**Read set.** A role may read, `glob` and `grep` in the work root, in the worktrees of the working set, and in
directories inside an admissible repository below the parents (checked with a synchronous `.git` probe, cached for 5
seconds). `external_directory` access to those directories is allowed in addition when the action is a read. Only paths
written fully qualified, or explicit search roots, reach the read set. A relative path, in any argument (`filePath`,
`path`, `file_path`, patch paths), or a pathless search is judged against the work root only and keeps the earlier
refusal. A repository in the read set needs a real `.git` (`HEAD` plus `objects` or `commondir`, or a gitdir file whose
target has `HEAD`); links are refused, a gitdir target is checked for network paths after realpath, and `HEAD` is read
only from a regular file of at most 4 KiB. `repoExclude` applies to every ancestor, and `.git` internals are never read
outside the work root: `read`, `glob` and `grep` still never open `.git` files there, while `router_git_*` read history
through hardened git, now also in another repository of the read set with `root` (see below). A read outside the work
root but inside the read set is annotated:

```text
[router: read from lib-b (main) at D:\git\lib-b — read-only in this dispatch]
```

**Edit refusals.** Edits stay in the work root. An edit elsewhere in the read set is refused with a message that says
where the path lives and what to do:

- same repository, other worktree: `edit: <path> is in worktree <wt> (repository <name>, branch <b>); this dispatch
  edits only in <W> (branch <wb>). The same file in your work root is <W>\<rel>.`
- another admitted repository: `edit: <path> is in repository <name> (branch <b>), which this dispatch may read but
  not edit. Finish the <W name> part and return NEED MORE: naming the <name> change; it needs a dispatch with
  repo=<name>.`

Any other path outside the read set keeps the earlier text (`read: <path> is outside this dispatch's work root <root>
(use an absolute path inside it)`). The worktree re-checks and `router_git_*` check against the binding's repository;
a `router_git_*` call with `root` checks against the repository it names.
A host `ask` for `external_directory` inside the work root or the read set is lifted to `allow` for an exactly bound
session when cross-repo is in use; a deny is never changed, and the session's own tool-output directory is never
lifted.

**`router_git_*` in other repositories.** A role agent reads the history of another repository of its read set by
passing `root` to a `router_git_*` tool: the absolute top-level path of a repository in the read set, or its name below
`routing.repoParents`. A name has the `repo=` semantics (a repository name, or the directory name of one of its linked
worktrees), with no branch argument: a name that matches several repositories, or a repository with several worktrees,
is refused and the paths to pass are listed. `root` is for role agents only, with an exact binding and `read`, `glob` or
`grep` in the grant. The argument is registered only on OpenCode v2 in roles mode when `routing.repoParents` is
non-empty at start; the tool map is fixed at start, so a restart is needed after adding parents. `root` equal to the
work root behaves as no `root`. Otherwise the tool runs in the admitted worktree with the same hardened git, read-only
(it never refreshes the index), and its output starts with the provenance line
`[router: read from <name> (<branch>) at <worktree> — read-only in this dispatch]`. Refusals start with
`[router_git] error: refused: ` and nothing runs; the reason names the value as `root=<value>`:

- not a role session (a tier agent or the orchestrator): `root is only for role agents (roles mode); this session
  inspects its own repository: omit root`; no exact binding: the I9 refusal of the tool; `router_git` without a local
  read action: `root reads another repository and needs read, glob or grep in this dispatch's grant (<actions>);
  router_git alone stays in the work root`; parents emptied by a reload after start: `root needs routing.repoParents
  (cross-repo is not configured); nothing ran`.
- the text, before any filesystem call: `has leading or trailing whitespace`, `is longer than 4096 characters`, an
  invalid path or name, or `names a .git directory`, each followed by `; pass the absolute top level of a repository or
  its name`.
- inside the work root: `root=<value> is inside your work root <W>; omit root and pass path=<rel>`.
- outside the read set, on the text alone (a junction from outside the parents is refused without being resolved):
  `root=<value> is outside this dispatch's read set (the work root, the session's repositories and the repositories
  below <parents>); nothing ran`; after `realpath`: `root=<value> resolves to <path>, outside this dispatch's read set;
  nothing ran`, or `root=<value> is not a directory; nothing ran`.
- below a repository's top level: `root=<value> is inside the repository at <top>; pass root=<top> and path=<rel>`.
- admission (depth, `repoExclude`, working set) refuses: its reason, with `; nothing ran.` in place of `: no work
  root.`; an absolute path in it outside the read set is shown as `<outside the read set>`. A worktree that admits
  as another path: `root=<value>: the admitted worktree <worktree> resolves to <path>; nothing ran`.
- a name: `root=<name> matches no repository below routing.repoParents (searched <parents>); nothing ran` (followed by
  `. The search stopped after 2000 directories` when the lookup was capped); `root=<name> matches <n> repositories:
  <paths>; nothing ran. Pass root as one of these absolute paths`; `root=<name> has <n> worktrees: <path> → <branch>;
  …; nothing ran. Pass root as one of these absolute paths`.
- the call's deadline or abort: `resolving the repository timed out; nothing ran`, `resolving the repository was
  aborted; nothing ran`; an unexpected failure fails closed with `resolving the repository failed; nothing ran`.

On OpenCode v1, in tiers mode or without parents at start the argument does not exist.

**Verification perimeter.** The perimeter is planned for every routed role dispatch with a work root when
`routing.repoParents` is set, even without `repo=`, and also when the grant has a cross-repo location or the session
working set holds other roots. It is the work root's repository, the working-set worktrees, and the admitted
repositories the work root links to through `node_modules` (store links excluded) or declares a dependency on outside
`node_modules` (a `file:` spec, tsconfig `references`, a Python editable install, a Go `replace`; read as text and never
pinned, see [Dependencies outside node_modules](./VERIFICATION.md#dependencies-outside-node_modules)), at most 16 (roots
past the cap are kept as unobserved), snapshotted at dispatch and at the gate. Links are de-duplicated by repository top level, found by
walking up to `.git` with no git call. Repositories are admitted (depth, `repoExclude`, working set) before any git
runs, and snapshotted with hardened git that keeps the inherited core settings (`autocrlf`, `eol`, `safecrlf`,
`longpaths`, `quotepath`) unless the repository sets them. A link or edge target that is not admitted is named `(not
admitted)` (at most 8 edge targets), never refused; one that could not be snapshotted is named `(not observed)`. A pending snapshot of another repository is
discarded when an unattributable writer runs, not only when it writes an overlapping directory, and that repository is
then "could not be observed". A planning failure fails closed, with a placeholder root "the verification perimeter
could not be planned…". When a root in the perimeter changed, or could not be observed, while the producer ran a tool
that can write anywhere, the result is unverifiable (for a sibling worktree of the work root's own repository the
reason suggests `branch=` instead of `repo=`): `the repository <name> at <root> also changed during the dispatch, and the
producer ran <tools>; a write there cannot be attributed, so the checks in <W> do not cover it. Dispatch that work with
repo=<name>, or verify it there.` (`could not be observed during the dispatch` for a missing snapshot). A pass with
more than one root shows its scope as a note, `verified scope: <W> (<branch> @ <head7>); also observed: …`; a changed
repository without writers is marked `changed during the dispatch`. A dispatch whose I4 already refuses at return (the
unattributable-writer case above) is not deferred: it is verified at once, before the return.

**Deferred verification across repositories.** A role dispatch with a perimeter, or with per-check `cwd=`/`scope=`, may
be deferred (`VERIFY:deferred`, the default; OpenCode v2). At return the router freezes the perimeter (the statuses for
I4 and I8, the working-set roots, the observed link and edge targets (those the producer added during the dispatch
included), the check placements and the link pins). The I4 window is the dispatch and is never decided again;
`router_verify` discovers consumers over the frozen working-set roots (through `node_modules` links and declared edges)
and observes the link and edge targets again (a changed one turns a pass UNVERIFIED; an unobservable one leaves a
would-be pass not judged and the handle open for another `router_verify`; a dependency the
producer removed during the dispatch is skipped unless the work root declares it again). The dispatch is verified at
once, not deferred, when I4 already refuses at return, when a linked repository could not be observed within the
deferral bound, when a dependency added during the dispatch could not be observed or more were added than the perimeter
has room for, and when a placement or a v2 tier per-check `cwd=` is refused (a refusal never reaches the deferred finish). Details are in
[Deferred verification across repositories](./VERIFICATION.md#deferred-verification-across-repositories).

- **With `routing.repoParents` set**, role dispatches are deferred by default where they used to be synchronous. A
  "continue and finish" resume of a deferred attempt therefore finds an attempt that was never gated (see "What a resume
  keeps"), and the detection is no longer `deterministic` for its change-set checks.

- **Checks in other repositories.** A check may run in another repository of the read set with `cwd=` and `scope=full`
  (`check: testsPass cwd="D:\git\app-a" scope=full`); the change is still captured in the work root. Syntax, refusals
  and the consumer caveat are in [Checks in other repositories](./VERIFICATION.md#checks-in-other-repositories). A
  `testsPass` in a consumer of the work root may use `scope=affected` instead: it runs `vitest related` (vitest 5 only)
  across the link, and any doubt is unverifiable; see
  [A consumer check with scope=affected](./VERIFICATION.md#a-consumer-check-with-scopeaffected).

**Limits.**

- A worktree outside the parents and the trusted executor slots root (for example under `%TEMP%`) is admitted by rule
  2, but the registered policy ends in
  a catch-all `deny` that the hook-level allow cannot override, so it still needs a `routing.workRoots` glob in long
  form or a restart; the same holds for a worktree of the session repository created after registration outside the
  trusted slots root. Creating worktrees below a parent or using executor slots avoids this.
- Changing `routing.repoParents` needs a restart.
- The role header is built only for a routed role dispatch (not for a delegate's) and names the work root and location
  the router bound; a role still cannot read or write outside its grant.

The rest of the design is in [the cross-repo design](./design/cross-repo.md).

### Repositories outside routing.repoParents

A repository outside `routing.repoParents` becomes a work root for role dispatches only after a human approved it with
`/router approve` (OpenCode v2, roles mode, owner decision D29). The flow:

1. A role dispatch names the repository with `root=<path>` and admission refuses it. When the refused candidate is one
   a human could approve, the router asks git about it (never the dispatch text) and appends to the refusal:
   `<path> is a git repository outside routing.repoParents (origin <origin>, branch <branch> at <head7>). Only the user
   can approve it: ask the user to run /router approve <path>, then dispatch again.` A detached HEAD reads `detached at
   <head7>`, and a path with spaces is quoted in the command. When the candidate cannot be approved, the note says why
   instead: `No approval can be requested for <path>: it <problem>.` When git does not answer within 8 seconds, the
   refusal stays as it is.
2. The human types `/router approve <path>` (quote a path with spaces: `/router approve "D:\my repo"`). The router
   inspects the path again, from git, and shows the identity it stored:

   ```text
   Approved repository D:\other\lib-c
     origin:  https://github.com/acme/lib-c.git
     branch:  main @ 3f2c1a9b4d5e
     roots:   1 root commit
     expires: 2026-10-26 (14 days after its last use; at the latest 2027-01-10)
   Stored in C:\Users\me\.config\opencode\opencode-model-router.repo-approvals.json.
   ```

3. The router reloads the role agents, so that their directory permission covers the repository, and adds
   `Role agents reloaded; dispatch again with root=<path>.`
4. The orchestrator dispatches again with `root=<path>`.

An approved repository works through `root=` only (scope OD-P4-2 (a)): the `root=` text must equal the approved path
before any filesystem call, and a different spelling that resolves to it is refused with a note that names the approved
path. `repo=<name>` does not look outside the parents. Once bound, the repository joins the working set and the read
set, `router_git_* root` works on it, and its linked worktrees are admitted by rule 2 through the working set (see
Limits below for the host's side). Registration gives each approved repository a `<path>\*` `external_directory` allow
pattern on the local roles, only while `routing.repoParents` is non-empty, the approval has not expired and is not
excluded by its text, the path still resolves to itself, and it passes the work-root checks.

**What is checked.** What the human sees and what gets stored come from git at approve time, never from the dispatch
text or the refusal note. `/router approve` refuses with `Not approved: <path> <reason>.` and `Nothing was stored.`
(the first three checks run before any git call):

- a path that fails the work-root text checks, or does not resolve to an existing directory;
- a path excluded by `routing.repoExclude`, as typed or resolved: `repoExclude` wins over an approval;
- a protected location, as typed or resolved: a drive or filesystem root, the user profile or an ancestor of it, and
  the OpenCode config directory (also `$XDG_CONFIG_HOME/opencode` and `OPENCODE_CONFIG_DIR`), the directory of the
  config file named by `OPENCODE_CONFIG`, `~/.opencode`, the OpenCode data, state and cache directories, the plugin
  install directory and the approvals store directory (each equal, an ancestor, or inside);
- anything but the main worktree of a repository: `<path>\.git` must be a local directory (not a link, not a `.git`
  file of a linked worktree, a submodule or a separate git dir), the path must be the git top level, and the git common
  directory must be its own `.git`. These refusals end with `; approve the main worktree`.

A repository below `routing.repoParents` needs no approval: `No approval needed: <path> is inside routing.repoParents
(<parent>); dispatch with root=<path>.` A repository that is or contains a parent is refused: `Not approved: <path>
is routing.repoParents entry <parent>; a repository that is or contains a parent cannot be approved.` (or `contains
routing.repoParents entry <parent>`); registration also skips a stored approval that is or contains a parent (text or
canonical form). One below a parent but deeper than `routing.repoDepth` is refused too: `No approval applies: <path>
is below <parent> but deeper than routing.repoDepth (<n>); the router refuses it with or without an approval.` Each of
these ends with `Nothing was stored.` The stored identity is the canonical path, the git common directory and the
root commits (`git rev-list --max-parents=0 HEAD`); the origin (credentials stripped) and the branch are shown but are
not part of the identity. The identity is checked again with git at every use: an entry whose path no longer resolves
to itself, whose common directory changed, or whose root commits differ no longer admits anything.

**The commands.** `/router` lists them only where they run:

```text
- `/router approve <path>` — approve a repository outside `routing.repoParents` for role dispatches with `root=<path>` (identity from git; quote a path with spaces)
- `/router repos` — list the approved repositories, their last use and expiry
- `/router revoke <path>` — remove an approval and drop the repository from every working set
```

They run only on OpenCode v2, in roles mode, with `routing.repoParents` non-empty, and only when typed by the human in a
top-level session: not a role session, not a known child of a dispatch, and a session the host reports without a
parent (a failed lookup refuses). Anywhere else `approve`, `repos` and `revoke` are not commands, and `/router` shows its
usual output. Only `approve` and `revoke` add or remove approvals (a binding through one only moves its last use); no
tool call, route-line field, dispatch text or project-layer key can create, extend or widen one.

- `/router repos` reads the store only (no git) and lists each entry with its origin, `approved:`, `last used:` and
  `expires:` times, marked `[expired]` or `[excluded by routing.repoExclude (<pattern>)]` where that applies.
- `/router revoke <path>` removes the entry (named by its text or its realpath), drops the repository from every
  working set and says so: `Revoked the approval of <path>.`, then `It was not in any working set.` or `Removed from the
  working sets (<n> bindings).`, then `A new dispatch with root=<path> is refused.` The role agents are then reloaded:
  `Role agents reloaded; root=<path> is no longer allowed.`

**Reload and restart.** After an `approve` or `revoke` that wrote the store, the v2 command adapter reloads the role
agents before it sends the text on, so the host's directory permission follows the store. When the reload fails, the
added line names the error and falls back to a restart: `The role agents could not be reloaded (<error>). Restart
OpenCode to use it.` after an approval, and `The role agents could not be reloaded (<error>). The router refuses
root=<path> now; restart OpenCode to remove its directory permission from the role agents.` after a revocation.
After a revocation or expiry, a child bound through the approval stops working in it (a store read, no git): an exact
resume, `router_run` and `router_git_*` refuse with `approval for <path> was revoked or expired: no work root. Only the
user can approve it again (/router approve <path>).` (a resume's note starts `resume refused: `).

**Expiry.** An approval expires `routing.repoApprovalDays` days (global only, 1–90, default 14) after its last use, and
90 days after it was approved at the latest, whatever its use. Each binding through an approval records the use (at
most one write per hour per repository). An expired entry admits nothing; approve it again to renew it. Expiry or a
lost identity takes effect at the next binding, when the stale entry is also dropped from the working set.

**The store.** The approvals live in `opencode-model-router.repo-approvals.json` next to the router state file
(`~/.config/opencode/`); its format is in [the configuration reference](./CONFIG_REFERENCE.md#roles-delegation-84). A file
that is not valid as a whole means no approvals (fail closed) and one notice; `/router repos` then says `The approvals
file <file> is invalid (<reason>); no approvals apply until it is fixed or removed.`, and `approve` and `revoke` refuse.

**Limits.**

- Worktrees of an approved repository outside its main tree are admitted by rule 2 once the repository is bound, but
  the host's directory permission covers only `<path>\*`, so they still need a `routing.workRoots` glob or a restart
   (Q7), as for any worktree outside the parents and the trusted executor slots root.
- The root commits change on an orphan-branch checkout, a deepened shallow clone or rewritten history; the approval is
  then lost and must be given again.
- At most 32 approvals and 256 KiB. Two OpenCode instances writing the store at the same time can lose one write; the
  command reads the file back and reports it.
- An approval that expires mid-session can still be read through the working set until the next dispatch of that
  session.

**Accepted residuals.**

- Code with host API access (`session.command`) or with a shell can approve: `router_run` in the work root runs
  repository code, so it can write the store.
- A human can approve a hostile clone; the command shows the origin, branch and root commits so the human can check.
- The host's `<path>\*` pattern is wider than admission and lingers after an expiry until the next reload of the role
  agents or a restart; the router's hook still narrows access in the meantime, as for `routing.workRoots`.

**OpenCode v1, tiers mode, no parents.** The feature is inert on OpenCode v1, in tiers mode and in roles mode without
`routing.repoParents`: `/router approve <path>` shows the usual `/router` output byte for byte, there is no store I/O
and no git call for approvals, and no approval admits anything. On v1, `routing.repoApprovalDays` gets at most the
existing one-time notice (see [OpenCode v1 fallback](#opencode-v1-fallback)).

## Tier floor

The window of a role dispatch is `[floor, ceiling]`:

- floor = max(the role's range floor, the authority floor below, `enforcement.escalate.floorTier`, the child's running
  tier on a resume, a raise the router recorded after a verification FAIL of this child);
- ceiling = the role's range ceiling; when the floor is above it, the floor wins and the range widens upward only
  (when the role has no budget for the tier it then runs on, the dispatch gets max(the role's budget for its ceiling
  tier, 25) calls, see [Budgets](#budgets));
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

Write authority goes to the cheapest tier only behind checks the router runs itself in the dispatch's work root, and
edit + execution never runs on `fast`: an edit can change what a script does, so write + exec is treated like running
code the agent wrote. After a verification FAIL the router raises the child's floor for its next resume itself; the
orchestrator never sets `tier=` or `model` for that.

## Dynamic authority and the ladder

**Grant** = role max ∩ (base ∪ needs-derived actions ∪ actions widened on resume) for dynamic roles; the whole max for
fixed roles. It is enforced three times: the agent's registered max policy (host), the router's permission hook
narrowing each session to its dispatch grant and work root, and the router's context hook removing non-granted tools
from that session's catalog. `router_run` and `router_git_*` check the binding themselves, because no permission hook
fires for plugin tools.

**Binding.** Each fresh role dispatch carries a router-made nonce: the description ends with ` [nonce <n>]` and the
prompt's last line is `OMR_NONCE=<n>`. The child is bound to its dispatch at its first context build. A binding is
**exact** only through that nonce; a missing, foreign or conflicting nonce makes it **unknown**: role max ∩ local
actions, no `router_run`, no `external_directory`, a note telling the child that authority is not widened for it
("… authority is not widened for it: dispatch a fresh task"), a `note:binding:unknown` annotation row and the advisor
finding `role-binding-unknown`. Ambiguity never widens authority: dispatch a fresh task instead of resuming.
Errors fail closed: a context-hook error leaves the role child an empty tool catalog, a permission-hook error denies.

**The ladder** (dynamic roles only):

1. The child calls `router_request_authority({ actions, reason })`.
2. Inside the role max the request is recorded and the child is told to stop with `ESCALATE: authority`. Outside the
   max it is refused, naming the role that has the action (`researcher` for egress, …); fixed roles, `execute`, raw
   shell, and `router_run` or `edit` without a work root bound to the dispatch are refused too.
3. The router annotates the parent's `subagent` result with resume guidance.
4. The orchestrator resumes the **same** `sessionID`. The grant widens only for an **exact** binding (an unknown one
   drops the request with the notice "authority request not applied: binding unknown: dispatch a fresh task.") and
   only when the resuming session is the dispatch's parent, the session the request was escalated to (any other
   resuming session drops it; a delegate's resume never applies it and leaves it for that parent). The floor is then
   recomputed — the per-call model may rise — and the decision row records the widening.

**What a resume keeps.** A resume prompt ("continue and finish") is not the task, so a resume of a role child is
decided on the facts of the dispatch it resumes: its class, confidence and needs (plus the resume's own needs), with
risk and scope the max of that dispatch's and the resume's own (raise-only). A resume that names no `[acceptance]`
block carries the dispatch's block, its `VERIFY:` lines (unless the resume names its own) and its `d=` claim (note
`acceptance carried from the resumed dispatch`); a resume with a new block replaces them. A carried block is checked
when the resume returns — a carried resume is never deferred — and judged on the child's cumulative changes since the
attempt that introduced the block. When that attempt was never gated (its verification was deferred, say), the
cumulative changes are unknown: the block's change-set checks (`testsPass`, `lintClean`) are unverifiable and cannot
back a `deterministic` detection.

## Budgets

| Item | Value |
|---|---|
| Role dispatch total | the role's budget for the routed tier (table above); `budget=<n>` on the route line raises it, never above 2 ×; a resume without `budget=` keeps the child's previous `budget=` (applied to the resume's own tier), one with `budget=` takes its own |
| Routed tier outside the role's range | when a floor (`enforcement.escalate.floorTier`, a running rung, the authority floor) lifts the dispatch above the role's ceiling, and when the role has no budget for that tier, the dispatch gets max(the role's budget for its ceiling tier, 25) calls — never less than the role on its ceiling, nor less than a tier agent (raised by `budget=` up to 2 ×) |
| Cumulative ceiling across resumes | 3 × the largest round budget the child had (total × 3 on the first round; a later round with a smaller budget never shrinks it) |
| Refused calls | not charged to the budget, not recorded as executed by the repeat check; a round is stopped for refusals once it has min(budget, `REFUSAL_CAP` = 10) of them and executed + refused calls reach the budget. Role-authority refusals and structured host permission denials count as refused calls too, in `advisory` mode as well (`advisory` never stops) |
| Host `steps` of a role agent | 2 × max(top role budget, 25) + `REFUSAL_CAP` + 5 (95 or 255 for the shipped roles) |
| Tier agents (`fast`, `medium`, `heavy`) | unchanged: 25 calls, cumulative × 3 |

Reader roles are never denied for "non-producing" reads; producer roles keep the read/draft guard. `CAP:N` (or
`CAP:none` with a `reason:` line) changes only the read-only call counter, and a role dispatch has a read-only call cap
only when it carries `CAP:N` or `CAP:none` (or when a `subagentTiers` entry maps the role's name to a tier, see
[Migration](#migration-from-subagenttiers-and-agents)); without one, only the total budget above bounds it.

**Budgets stop a child only in `enforced` mode.** The router's guard enforces total role budgets only
when the effective `enforcement.mode` is `enforced`; numeric read-only caps are advisory banners, not hard stops.
In `advisory` mode (the shipped default) it only warns: the child
is never stopped by the router, and only the host's own `steps` limit (above) ends a run that goes on. A child that
is out of budget (or of refusals) in `advisory` mode and returns `NEED MORE: budget` is still a budget stop: the
router records a `budget` signal and the parent's result gets the `[router budget]` note. In `off` mode the guard does
nothing.

**Exhaustion is not failure.** When the budget runs out the child is told to return `NEED MORE: budget` with a
progress summary, and the parent's result gets a note starting with `[router budget]` (also when the host's step limit
or a context overflow stopped the child). Resume the **same** `sessionID` with "continue and finish"; the router keeps
the child's tier and a resumed round takes its own budget. Budget exhaustion is recorded as a `budget` signal with no
tier penalty.

## Outcome signals

Positive evidence comes only from external verification (invariant I6); budget and authority events never count as
failures (I7).

**Only verdicts move the outcome store.** The outcome store the kernel reads is moved only by verdicts: the router's
deterministic verdicts (weight 1) and independent grader verdicts (weight 0.5). `run`, `incomplete` and `redispatch`
are routing statistics only: decision-log annotation rows that `routing:stats` reads, never an input of a routing
decision. Their weights below are the mass those rows carry in the statistics.

| Signal | Weight | When |
|---|---|---|
| `verdict` | 1 (pass or fail) | the router's deterministic checks (never an LLM grader) |
| `run` | 1 (success only) | the child's own `router_run` of every npm-script-form acceptance check in the current attempt (runs of an earlier attempt of the same child never count), the latest run of each exited 0 and started after the child's last edit (see below) |
| `grader` | 0.5 (pass or fail) | an independent LLM grader: tier ≥ the producer's tier **and** another model (see below) |
| `incomplete` | 0.5 (failure) | an explicit `NEED MORE` / `ESCALATE` return without an observed budget stop or authority request |
| `redispatch` | 0.5 (failure, on the earlier attempt) | the same task (compared over its TASK section) sent again to a higher tier within 30 minutes |
| `budget`, `authority` | 0 (recorded, no tier penalty) | an observed budget stop; an authority request |
| `DONE` alone | 0 (no signal) | self-report never moves evidence |

**The `run` signal matches npm-script-form checks only.** An acceptance check counts for it only when its command is
exactly `npm test` or `npm run <name>` (also `npm t`, `npm run-script <name>` and the `npm.cmd` spellings), with no
further arguments. It is matched by **`router_run` entry name**: the check `npm test` needs a run of the entry `test`,
`npm run <name>` a run of the entry `<name>`, whether that entry is a `package.json` script or a `routing.run.commands`
entry of the same name (a command named `test` counts for `npm test`; one named `test-files` never does). A dispatch
with no check of that form gets no `run` signal. A check of any other form (a file check, another command) is never
matched to a run, so a `run` signal never shows that such a check passed: that is the deterministic gate's `verdict`.
The child's edits must also have been observed. A dispatch where any acceptance check has its own `cwd=` (even a relative
one inside the work root) gets no run signal at all: such a check may not run in the work root, so no check of that
dispatch is credited.

**Graders weigh half, and only when independent.** When an LLM grader (not the deterministic checks) judges a role
dispatch, there is never a weight-1 `verdict` signal. An independent grader's pass or fail writes a verdict row that
moves the outcome store by 0.5 (not one full observation) and a `grader` signal row. A grader that is not independent
— below the producer's tier, on the same model, or not known to be independent — records nothing at all: no store
change, no verdict row, no signal row. A false refusal after an independent grader's pass takes back only that 0.5 and
adds one failure; after its failure it tops the failure up to one. Tier dispatches keep full-weight grader verdicts.

A return without a contract prefix gives no signal. For verification, a progress note (no contract marker, ending with
a first-person "I'll continue …") or a budget stop is `incomplete`: never accepted, no next tier, no evidence. Signals
are written as annotation rows of the decision log (`note:signal:<kind>:<pass|fail|none>`), which is why downgrading
below the release that introduced them is unsupported.

## Exploration

Off by default. `routing.exploration.rate` (global layer only, `0` by default, at most `0.2`; a larger or invalid
value falls back to `0` with a notice) lets `enforce` send a share of role dispatches to a **cheaper** rung on purpose,
so cheaper tiers can earn evidence. It runs only when the effective detection is `deterministic`
(`routing.exploration.requireDetection` is fixed), never on a pinned, resumed or high-risk dispatch, and only to a rung
at or above the floor and strictly below the static default. The draw is seeded by the decision id (replayable); rows
carry `explore` and `propensity` and the reason `explore`. It is the one documented exception to "never down". In
tiers mode the rate is always `0`.

**Exploration effectively never touches `implementer`, nor `general` with an `edit` grant.** Their grants hold `edit`,
and their tasks are mostly classed `implement`, `debug` or `other`, whose base risk is `medium`: with `edit` the
[authority floor](#tier-floor) is then `medium`, which is the static default of `implement` and `debug`, so no rung is
at or above the floor and strictly below the default. Class `other` has no static tier, so its default is the floor
itself. Only a dispatch whose floor sits below its class's static tier can be explored — for these roles, in
practice a `general` dispatch classed `review` whose grant holds no `edit`.

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
  `SECRET`, `API_KEY`, `ACCESS_KEY`, `PRIVATE_KEY`, `CREDENTIALS`, anything containing `PASSWORD` or `PASSWD` such as
  `PGPASSWORD`, `PWD` at the end or before a `_` such as `MYSQL_PWD`, … and known provider keys); the working-directory
  variables `PWD` and `OLDPWD` themselves are kept. There is no passthrough option: credential-like names are always
  stripped. Relative `PATH` entries are removed; `CI=1` is set. **What stays reachable:** the ssh-agent socket, git credential helpers
  and the OS keychain, cloud CLI caches in the home directory (`~/.aws`, `~/.config/gcloud`, `~/.azure`,
  `~/.docker/config.json`, …) and credentials carried by variables with other names. A script can use them as you can.
- **Bounds.** Timeout `routing.run.timeoutMs` (default 600000 ms) with a process-tree kill; output bounded to 64 KiB
  with a notice; best-effort redaction of URL userinfo and credential-like query parameters (not a secret scanner).

## Background dispatches

On OpenCode v2 the roles protocol carries a `Background dispatches` block, the same one the tiers protocol gets,
so a role orchestrator is told to:

- continue any independent work after dispatching background work, and end the turn when none remains (the router
  wakes it);
- never poll or sleep;
- treat a held result as unusable until its verdict, and never report a task done while dispatches are listed in
  flight;
- resolve a lease refusal by waiting for the holder, not by retrying.

The whole block, the lease rule included, is left out when `routing.background.mode` is `off` (leases are still
enforced; only the prompt line goes), and the lease rule alone when `routing.leases.mode` is `off`.

Whether a `subagent` call to a role agent runs in the background is decided per call by `routing.background.mode`
(`auto` by default, `model`, `off`) and `routing.background.minPredictedMs` (default `45000`); the rules, the held
results and the per-turn lists are in [OPENCODE_V2.md](OPENCODE_V2.md#background-dispatches). A role call that
needs required verification is backgrounded only where its result can be held. A role dispatch that `auto` does not
select with a thin outcome store gets no `background` key, so the host default applies; with `off` it is sent as
before (`background: false` for a role-routed call).

## File leases

On OpenCode v2 every child session (a role dispatch or a tier dispatch) takes a lease on the files it writes, for as
long as it runs. Root orchestrator sessions take none: a root write is refused only while a child holds that file,
and a root read, search or run is never refused. `routing.leases.mode` (`enforce`, the default, or `off`) switches
the leases; `routing.leases.run` (`annotate`, the default, or `refuse`) sets what `router_run` does when its work root
has files under edit by another session. A lease covers the file in its checkout: a child in another linked worktree
of the repository may edit its own copy of the same path. A plan task's lease also refuses another plan task's edit of
that path in any worktree of the repository.

What a child sees while another session holds a lease (`<holder>` is `<role> "<description>" (session <id>)`):

| Access | Result |
| --- | --- |
| Write to a leased file | `[router] Refused: <path> is being edited by <holder>. Finish without that file, or return `NEED MORE: lease <path>`. Do not retry: the lease ends when that session ends.` |
| Read of a file under edit | `[router] Refused: <path> is under edit by <holder>. Finish without it, or return `NEED MORE: lease <path>`.` |
| Write whose target the router cannot name while a holder edits in that checkout (for a plan task: in any worktree of that repository) | `[router] Refused: this <tool> call names no file the router can check, and <holder> is editing files in this checkout. Pass the file path explicitly, or return `NEED MORE: lease <tree>`.` (a plan task's refusal says `in this repository`) |
| More files leased than the limit | `[router] Refused: too many files are leased (<limit>). Return `NEED MORE: lease <path>`.` |
| `glob` or `grep` listing files under edit | The listed files are removed and one line is added: `[router] <n> result(s) omitted: under edit by <holders>.` |
| `router_run` in a tree with files under edit | `annotate`: the result gets `[router] ran while <holder> edits <n> file(s); result may be contaminated`. `refuse`: `[router] Refused: router_run in <tree> while <holder> edits <n> file(s) there. Wait for that session to end, or return `NEED MORE: lease <tree>`.` |
| Root write to a file a child holds | `[router] Refused: <path> is being edited by <holder>. Wait for that session to end.` |

A refusal is final for that attempt: the lease ends when the holder's execution ends, is interrupted or fails, when
its session is deleted, or after the six-hour sweep, so a retry in the same turn fails the same way. The child either
finishes without the file or returns `NEED MORE: lease <path>`, and the orchestrator re-dispatches once the holder
is done. If the session kind cannot be determined the session is treated as a root, which never blocks the
orchestrator and never overrides a child's lease. A required verification that would run in a tree where a child is
editing waits for those leases to end (checked on release, with a five-second poll) up to its deadline, then runs
with the usual caveat; the producer's own task never makes its own check wait. A lease table that cannot identify its
holder makes writes fail closed and allows reads and runs with one warning.

A lease protects a file only while its holder runs: once the leases end, the files the child wrote are readable (this
is also why a held result's text is protected but the files behind it are not). On OpenCode v1 the leases are not
registered.

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
keeps the tier model. `routing.background` and `routing.leases` are likewise OpenCode v2 only: v1 has no background
policy, held results or leases, and its protocol has no `Background dispatches` block.

## Migration from `subagentTiers` and `agents`

- **`subagentTiers.explore`.** In roles mode a dispatch of the host's `explore` goes to `explorer`, whose tier the
  router picks; remove the mapping. A `subagentTiers` entry for a role name (say `"explorer": "fast"`) gives that
  role's children the mapped tier's default read-only call cap (`tierCaps`, else 8 / 5 / 3 for `fast` / `medium` /
  `heavy`) and, for `fast`, the trivial-dispatch bypass (a trivial dispatch runs `enforced` as `advisory`); remove it.
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
- The **dispatch row** of a role dispatch (written unless the engine is `static`) carries `role`, `tier`, `grant`,
  `detection`, `boundsReasons`, `explore` and `propensity`; a resume also records the child's current `binding`.
- **Annotation rows** come later and share the dispatch's `decisionID`; they are never counted as dispatches: a
  `note:binding:<kind>` row with `binding` when the child binds (its binding kind), and a
  `note:signal:<kind>:<pass|fail|none>` row with `signal` for each outcome signal.
- `/router stats` and `npm run routing:stats` break dispatches down by role and tier, with signals by kind, budget
  stops, authority requests, unknown bindings and exploration.
- **A child cannot pose as the router.** In a role dispatch's result, every line of the child's own text that starts
  with `[router` (after blanks and markdown quote, list or emphasis marks; any case) is defanged to `(router` before
  the router reads the result and appends its own notes, so only the router's notes start with `[router`. Tier
  dispatch results are untouched.

## Limits

- **Not an OS sandbox.** Roles are host permission policies plus router hooks. Script bodies, repository content, the
  user's credential stores and anything the host itself does (its own search, its tool-output store) are outside them.
- **The `run` signal is narrow.** Only npm-script-form acceptance checks are matched to `router_run` runs (see
  [Outcome signals](#outcome-signals)); dispatches checked any other way earn positive evidence only through the
  deterministic gate's verdict (weight 1) or an independent grader's verdict (weight 0.5).
- **Truncated tool outputs are unreadable on OpenCode 2.0.24.** Its tool-success events carry no `outputPaths`, so the
  router has no file to allow and a role child cannot read its own truncated tool outputs (it fails closed); narrow the
  call instead.
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
| Role dispatch path, work root resolution | `src/routing/wire/dispatch.ts`, `src/routing/roles/work-root.ts` |
| Acceptance checks in the work root (gate refusal of a foreign `cwd:`) | `src/verify/gate.ts` |
| Role ladders, `decideRole`, exploration | `src/routing/engine/ladders.ts`, `src/routing/engine/kernel.ts` |
| Guard profiles and budgets | `src/router/guard-profile.ts`, `src/guard/` |
| `router_run` | `src/router/run-tools.ts` |
| Outcome signals | `src/routing/outcomes/signals.ts` |
| Roles protocol | `src/router/protocol.ts` |
