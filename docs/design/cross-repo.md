# Cross-repo work in roles mode

**Status:** Accepted 2026-10-10 (owner). Phase 0 and Phase 1 implemented, two QA rounds each; dogfooding pending.
**Scope:** roles mode on OpenCode v2 (`routing.delegation: "roles"`). Phase 0 changes the shared verification engine and applies to both hosts.
**Configuration keys** marked *proposed (not implemented)* do not exist yet.
**File references** are `path:line` as of 2026-10-10. Line numbers drift; the function names are the stable reference.

## 1. Context

- The owner works on about six projects a week. Almost all of them span several repositories, and projects come and go. Every repository lives under `D:\git`. The owner does not want to configure each repository by hand.
- Today a role dispatch has exactly one work root: the session directory, or a worktree of the session's repository (`docs/ROLES.md:173-180`, `src/routing/wire/dispatch.ts:550-585`). Another repository cannot be a work root.
- The work root does two jobs today:
  - **Authority:** it is where the role may read, edit and run (`src/compat/v2-hooks.ts:588-642`, `src/router/run-tools.ts:251-267`).
  - **Verification scope:** the gate snapshots the git tree of the verification cwd (`src/verify/tree.ts:209-212`, `src/index.ts:2164-2169`) and runs checks there (`src/verify/gate.ts:230-251`).

  Cross-repo work needs these two jobs separated.
- Verification can give a false pass today, without any cross-repo feature:
  - **F1.** A change made only by a script or shell records nothing. An empty change set passes as "no affected tests" (`src/verify/runner.ts:4298`, `src/verify/baseline.ts:123-124`).
  - **F2.** A tier dispatch's verification cwd is not checked (`src/routing/roles/work-root.ts:126`), and a tier can edit anywhere.
  - **F3.** A change set with paths both inside and outside the verified repository skips the outside check (`gate.ts:257`). The planner drops the outside paths with a note (`runner.ts:4413-4415`).
  - **F4.** The reference rerun links live `node_modules`. A package link into another repository is skipped by the drift check (`src/verify/reference.ts:1833-1834`), so a failure caused by that repository's change can be excused as pre-existing.
  - **F5.** Deferred drift checks only the stored paths (`src/verify/wiring.ts:1795-1803`).
- **Non-goals:**
  - prompt-injection detection (a separate plugin);
  - an OS write sandbox for scripts;
  - more than one write root per dispatch.
- First-use approval of repositories outside the configured parents is in scope as Phase 4, after the spikes listed in section 3.

## 2. Model

| Term | Meaning | Authority |
|---|---|---|
| **W**, write root | The one directory a role dispatch edits and runs in. It is the session directory, a worktree of the session repository, an admitted repository, or a worktree of one. | `edit`, `router_run`, `router_git` |
| **R**, read set | W plus every admitted repository and its worktrees (section 3). | `read`, `glob`, `grep`; `router_git` with `root` (role agents, read-only; Phase 3 (b)) |
| **Working set** | Every worktree root bound as W by any dispatch of the same orchestrator session, with its repository name and branch. | none (observation and display only) |
| **P**, perimeter | W's repository, plus the admitted repositories W links to (package links in W's `node_modules` whose real path is outside W and has no `node_modules` segment), plus the working set as it is when the dispatch starts. | none (observation only) |
| **C**, check roots | Where acceptance checks run: W by default; in Phase 2 also a per-check `cwd=` inside R. | none |

**Why the capture is anchored at W.** `VerificationScope.cwd` is today "the directory the change capture, the change set, the checks and a deferral use" (`work-root.ts:102`). If checks could move to another repository while the capture followed them, the change set would be the empty delta of a tree the producer never touched, and it would pass as "no affected tests". That is the DF2-F1 failure (`test/integration/roles-authority.test.ts:833`). The change capture therefore always uses W and P. The DoD can choose where checks run, never where changes are captured.

**What a pass means.** A pass is scoped to P: every change observed in P was covered by a check that ran, and some change was observed. When repositories are configured, the pass names P. Writes by scripts outside P are not observed; this is a documented limit.

## 3. Configuration and admission

### Keys

| Key | Layer | Default | Status |
|---|---|---|---|
| `routing.repoParents` | global only | `[]` | proposed (not implemented) |
| `routing.repoDepth` | global only | `2` (allowed `1`–`4`) | proposed (not implemented) |
| `routing.repoExclude` | global only | `[]` | proposed (not implemented) |
| `routing.repoApprovalDays` | global only | `14` (allowed `1`–`90`) | proposed (not implemented), Phase 4 |

Example (proposed):

```json
{ "routing": { "delegation": "roles", "repoParents": ["D:/git"] } }
```

**Sanitising `routing.repoParents`.** The rules of `routing.workRoots` apply (`workRootProblem`, `src/router/roles-config.ts:200-220`): an absolute static prefix with at least one real segment, no `.` or `..` segment, no 8.3 segment. Two more rules apply because a parent is a literal directory:
- no glob character;
- no UNC or device path (`\\host\share`, `//host/…`, `\\?\`, `\\.\`). `workRootProblem` accepts a `//host/share` prefix (`roles-config.ts:207`), so this refusal is new.

Entries must be written in canonical long form. A refused entry is dropped with an issue, as `sanitizeWorkRoots` does (`roles-config.ts:222-244`). The keys join `GLOBAL_ONLY_ROLES_ROUTING_KEYS` (`src/router/config.ts:2211`).

**`routing.repoExclude`** holds absolute globs matched against the canonical path of a candidate. The owner needs none today.

### Admission

A directory D is **admitted** when any rule holds:

1. **Below a parent.** All of these hold:
   - D's canonical long form lies 1 to `repoDepth` segments below the canonical form of a parent;
   - D is never the parent itself;
   - D's canonical form stays below that parent (a junction that leads out is refused);
   - D is not excluded;
   - hardened git (`gitExecutable(workRootGuards(D))`, `hardeningArgs()`, `gitEnvironment()`, as `gitWorktreeList` does at `dispatch.ts:526-539`) prints D for `rev-parse --show-toplevel` (canonical comparison, case-folded on win32).
2. **A worktree of an admitted repository**, wherever it lives. The path appears in that repository's `git worktree list --porcelain`, with prunable entries dropped as `parseWorktreeList` does (`dispatch.ts:482-502`).
3. **Approved on first use** (Phase 4, below). D is the main worktree of a repository with a valid approval, or a worktree of one.

**Order of checks.** Text is compared before any filesystem call on a path outside the parents:
- A `root=` whose text lies below a parent continues with filesystem calls inside that parent.
- Any other `root=` is compared as text with the worktree lists of the session repository, of the working-set repositories, of approved repositories, and of the `repo=` repository when one is named.
- With no match, there is no work root (Phase 4: a first-use approval may be requested). Git never runs in a directory that the text did not place below a parent and that git did not list, except to compose a first-use approval prompt (Phase 4).

**When admission runs.** Admission is lazy: it runs at dispatch and in the permission hook, per path, with a 5 s cache like `stillAWorktree` (`v2-hooks.ts:943-952`). Nothing is scanned at startup.

### Names

- **A repository's name** is the basename of its main worktree's top level (the first `worktree` entry of `git worktree list --porcelain`). A linked worktree carries its repository's name, not its folder's.
- **`repo=X` lookup** checks `<parent>\X`, then, while `repoDepth` allows, `<parent>\*\X` (one directory listing per level, then `lstat`), then approved repositories. A candidate counts when it is admitted and its name is X.
- **Name collision.** When two admitted repositories share a name, `repo=X` is refused. The refusal lists the candidate paths and asks for `root=`.
- **Several worktrees.** When repository X has more than one worktree and no `branch=` is given, `repo=X` is refused with a "worktree → branch" list.

### Host `external_directory` allow patterns (checked against the code)

- Each parent is passed to the existing glob machinery as `<parent>/*`. `workRootPattern("D:/git/*")` (`src/router/role-agents.ts:215-236`) takes the static directory `D:/git/`, resolves it with `realpathSync.native`, and builds `D:\git\*`. That pattern passes `workRootProblem`. `externalDirectoryPatterns` (`role-agents.ts:242-263`) adds it like any `routing.workRoots` entry, and `registerRoleAgents` writes it into every local role (`role-agents.ts:347-354`).
- The host's `*` crosses separators (`docs/ROLES.md:194-197`; the v2 permissions docs say "`*` Zero or more characters, including /", with backslashes normalised and case-insensitive matching on Windows), so the one pattern covers every depth and every clone made later. **New clones under a parent need no restart.** Depth, exclusion and the git top-level test are enforced by the router's permission hook, not by the host pattern. The host pattern is wider than admission, as with `routing.workRoots` today.
- **The parent must exist when the agents are registered.** Otherwise it gets no pattern and a warning (`role-agents.ts:229-231`, `:348`).
- **Worktrees outside every parent are not covered by the parent pattern.** Registration lists only the session repository's worktrees (`role-agents.ts:339-347`). The hook-level allow (P4.5, D13) does not close this gap: role agents are registered from a catch-all `*: deny` policy, so a directory outside the registered patterns gets a static deny, which the lift never overrides (see Q7). Therefore:
  - A worktree of another repository outside the parents (for example under `%TEMP%`) is admitted by the router, but the host has no allow rule for its directory. It needs a `routing.workRoots` glob that covers it, written in long form. The usual 8.3 spelling of `%TEMP%` is refused (`roles-config.ts:218`).
  - A worktree of the session repository is covered if it existed at registration. One created later needs a glob or a restart (`docs/ROLES.md:188-191`).
  - Recommendation: create worktrees under a parent (for example `D:\git\app-a-login`).
- **Changing `routing.repoParents`** changes the registered patterns and takes effect after a restart. Whether a config hot reload re-registers the role agents has not been verified.

### First-use approval (Phase 4, proposed)

Purpose: admit a repository outside `routing.repoParents` without editing configuration, after a human approves it once. The approval expires when the repository is not used.

**What the plugin can do today (from the code and the host docs):**
- The v2 evaluate hook can set `effect` to `allow`, `ask` or `deny`; a configured `deny` is final and does not invoke the hook (v2 plugin docs, `build/plugins/index.mdx`, dev branch). The router uses it only to narrow: role sessions are only ever turned into `deny` (`v2-hooks.ts:1257-1264`), and other agents return early (`v2-hooks.ts:1245-1247`). `execute.before` can only throw (`v2-hooks.ts:1504-1638`).
- Nothing in `src/` handles `permission.replied`, calls a tool-context `ask`, or stores an approval. The v2 `ToolContext.ask` stub throws for legacy tools (`v2-hooks.ts:1331`).
- The plugin already persists state outside tmp: `~/.config/opencode/opencode-model-router.state.json` (`statePath()`, `config.ts:694-699`), written through a tmp file and rename (`writeState`, `config.ts:2862-2868`).
- The host's own "Allow always" saves a durable, project-scoped allow rule with no expiry (v2 permissions docs). It is keyed by the tool's proposed patterns, not by a repository, so it cannot carry this approval by itself.
- `router_request_authority` widens a grant on the orchestrator's resume (`authority.ts:7-16`, `v2-hooks.ts:374-376`, `:1576`): the approver there is the orchestrator agent, not a human. It is not a model for this feature.

**Spikes before implementation (not verified):**
- **T1.** Does the v2 evaluate event for the orchestrator's `subagent` call carry the dispatch prompt (or a call ID that links it to the `execute.before` arguments)? The event has `sessionID`, `agent`, `action`, `resources`, `metadata`, `source`; the content of `metadata` is unconfirmed.
- **T2.** Does an `ask` raised inside a child session reach the human in the TUI and desktop app, and what does a background child do while it waits? The S11 probe turned an `ask` into a deny to avoid hangs (`docs/qa/role-tier/spikes.md:191`).
- **T3.** The payload of `permission.replied` (request ID, reply `once` / `always` / `reject`) and whether the plugin can correlate it with the request it raised.
- **T4.** After a human answers "Allow always" to a router-raised ask, does the host's saved rule change later evaluations in a way the hook cannot override? (Hooks run for allow decisions too, so the router should still be able to ask again.)
- **T5.** Does the `tool.execute.after` hook of the `question` tool see the human's answer, unmodified?

**Trigger.** A dispatch names `root=` for a git top level outside every parent that:
- passes the sanitising rules (no UNC or device path, no 8.3 segment, no `.` or `..`);
- is not excluded by `routing.repoExclude`;
- is not a protected location: a drive root, the user profile root, `~/.config/opencode`, the OpenCode data directories, or the plugin's install directory;
- has no valid approval.

Without an approval the dispatch gets no work root, as today, and the router requests one.

**The prompt is composed by the router from git, never from the dispatch text:**

```text
Allow role agents to read, edit and run in this repository?
  path:    E:\clients\acme-api            (main worktree; its worktrees are included)
  origin:  git@github.com:acme/acme-api.git
  branch:  main at 3f2c1a9
  expires: 14 days after the last use, at most 90 days (2027-01-08)
Allow once = this dispatch only. Allow always = until it expires. Reject = no work root.
```

**Where the human is asked**, in order of preference:
1. **The orchestrator session**, by setting `effect = "ask"` on the evaluation of the orchestrator's `subagent` call (needs T1, T3). The orchestrator session is the one the human is watching.
2. **A router-issued challenge through the orchestrator's `question` tool** (needs T5). The refusal note gives the exact question text, including a one-time code. The router accepts the approval only if the `question` input equals the issued text byte for byte and the human's answer is the approve option. The agent controls the question it sends, not the human's answer, and the code is single-use and expires with the dispatch.
3. **Not in a child session** until T2 shows that the prompt reaches the human and a waiting child does not hang.

**Replies.** `once` admits the repository for this dispatch only. `always` stores an approval. `reject` gives no work root and a note, and the declared `root=` refuses the dispatch (D15). No reply, or a non-interactive run (`opencode run`), gives no work root and refuses it the same way. An approval is never created automatically.

**Store.** A separate file next to the state file: `~/.config/opencode/opencode-model-router.repo-approvals.json` (proposed), written through a tmp file and rename like `writeState`. One entry per repository:
- canonical path of the main worktree and of the git common directory;
- identity: the sorted root-commit set (`git rev-list --max-parents=0 HEAD`);
- `origin` URL at approval (shown, not used as identity);
- `approvedAt`, `lastUsedAt`.

**Validity.**
- The path and the root-commit set must still match. A folder replaced by another repository loses its approval and is asked again.
- An approval expires `routing.repoApprovalDays` after its last use, and at most 90 days after it was given. Each binding refreshes `lastUsedAt`.
- `routing.repoExclude` wins over an approval.

**Effect.** An approved repository and its worktrees are admitted exactly as a repository below a parent: they join R, can be W, and follow the same P rules.

**Host permission for approved repositories.** An approved repository outside the parents has no registered `external_directory` allow pattern. Two ways to grant it; the second is chosen (D13):
- Re-register the role agents (a restart, or a verified hot reload). This breaks "no restart".
- **Hook-level allow (approved, D13).** In a role session with an exact binding, the router lifts the host's `ask` to `allow` for `external_directory` resources inside the grant's W or R. A configured `deny` stays final. This changes the current rule that the router only ever narrows a role's decision (`v2-hooks.ts:1257`). It does not remove the restart or the `%TEMP%` gap for worktrees outside the parents (above): the registered catch-all is `*: deny`, a static deny, which the lift never overrides. Only an `ask` is lifted, so a directory the registered patterns do not cover still needs a `routing.workRoots` glob or a restart (Q7).

**Revocation and listing.** Delete the entry or the file. A listing command (proposed: `/router repos`) shows approvals, last use and expiry.

**v1.** Inert, with the one-time notice (I9).

## 4. Invariants

- **I1 — One write root.** A role dispatch edits and runs only in W:
  - the edit branch of `roleAuthorityDecision` (`v2-hooks.ts:622`, `:632`);
  - the `execute.before` path check (`v2-hooks.ts:1000-1019`);
  - `router_run` `authorizeCwd` (`run-tools.ts:251-267`).

  `router_git_*` runs only in W, unless a role agent passes `root` naming a repository in R that admission admits; that call is read-only (Phase 3 (b)).
- **I2 — Capture anchored at W.** The change baseline, change set and reference are captured in W and P, never in a check cwd.
- **I3 — Coverage.** If any absolute changed path lies outside the git top level of every check root, the verdict is never pass. This includes change sets that are partly inside, and change sets that are entirely outside. It holds on both verifiers (deterministic and grader), and a relative path that climbs out (`../x`, resolved against the base) counts as outside.
- **I4 — Perimeter changes.** A change in P outside W during the dispatch:
  - if the producer lineage ran an unattributable writer → unverifiable;
  - otherwise → a note. The reference is handled by I6.

  The window of I4 ends at return: for a deferred dispatch the statuses are frozen at return and are never decided again at `router_verify`. A dispatch for which I4 already refuses at return is verified synchronously (reason `cross-repo`).
- **I5 — Empty change with writers.** If no change was observed in P and the lineage ran an unattributable writer, a pass carries a caveat. It renders as UNVERIFIED (`docs/VERIFICATION.md:242`).
  - *Unattributable writer:* a tool that is not a write tool (`WRITE_TOOLS`, `src/verify/dispatch.ts`) and not non-writing. Non-writing is the existing `NON_WRITING_TOOLS` names plus these exact names: `router_git_status`, `router_git_log`, `router_git_diff`, `router_git_show`, `router_git_blame`, `router_git_ls_files`, `router_request_authority`, `context7_resolve-library-id`, `context7_query-docs`, `context7_get-library-docs` and the Brave search tools. This covers `bash`, `router_run`, MCP tools and unknown tools.
  - The delegating tools `task`, `delegate` and `subagent` always count as writers, because a nested child's writes are not in the producer lineage. They still do not contaminate captures.
  - A writer is also counted in the before-hook once the guard allows the call, so a call that errors still counts. Tool names in the caveat are sanitised.
  - Known limit: the allow-list is exact names, so a user MCP server named `router`, `context7` or `brave` that exposes those exact names would be treated as non-writing.
- **I6 — Reference exactness.** A package link in a linked `node_modules` whose real path is outside the repository (and is not a package store: a real path whose parent is `node_modules` or `node_modules/@scope`), or is the repository root or an ancestor (`root-link`), makes the reference approximate unless it is pinned (Phase 2). An approximate reference never excuses a failure (`baseline.ts:162-165`).
- **I7 — Branch continuity.** W's branch at return equals its branch at dispatch. At `router_verify`, it equals its branch at return. I7 concerns W only: the link targets of P fall under S11 (re-observed at `router_verify`, a change turns a pass UNVERIFIED). A HEAD that moved by commits on the same branch is handled as today (`wiring.ts:1118-1140`). A carried role attempt is compared with the tree of the attempt that introduced its acceptance block; the reflog window applies within one dispatch and between return and router_verify.
- **I8 — Scoped pass.** When `routing.repoParents` is configured, a pass's evidence names P (repository, branch, short HEAD) and every link target that was not observed.
- **I9 — Inert by default.** Without `routing.repoParents` and without approvals, the protocol text, dispatch header, banners and goldens are byte-identical. The role dispatch header follows I9 (Q8, D14): it is emitted only when cross-repo is configured, a target is declared, or the work root differs from the session directory. On v1 the new keys are inert, with one notice (`touched`, `config.ts:3215-3216`).
- **I10 — Reads never widen writes.** Read authority never widens write authority or the change baseline.
- **I11 — Admission.** `routing.repoParents`, `routing.repoDepth`, `routing.repoExclude` and `routing.repoApprovalDays` are global-layer only. Parents are literal, absolute, canonical long-form directories: no glob, no `.` or `..`, no 8.3 segment, no UNC or device path. A directory is admitted only by git (top-level equality, depth 1..N below a parent, never the parent, canonical form stays below the parent), as a worktree that an admitted repository lists, or by a valid first-use approval (I16, I17). Text comparison comes before every filesystem call on a path outside the parents, except composing a first-use approval prompt.
- **I12 — Where git runs.** The router runs git only in admitted repositories, the session repository and its worktrees, and (Phase 4) in a candidate for a first-use approval prompt. A link target outside them is not snapshotted: it is reported as "not observed" and is never pinned.
- **I13 — P is fixed at dispatch.** P is the working set at dispatch start, plus W, plus the admitted link targets of W. A repository bound later is not observed by an earlier dispatch. For a deferred dispatch P is frozen at return (statuses for I4 and I8, working-set roots, observed link targets, placements, link pins); the consumers of W are discovered over the frozen working-set roots at the gate that runs the checks, not at return. The perimeter is planned for every routed role dispatch with a work root whenever `routing.repoParents` is set, even without `repo=`; it is also planned when the grant has a location or the working set holds other roots.
- **I14 — Names are resolved, never guessed.** An ambiguous name or worktree is refused with the candidates listed.
- **I15 — Hosts.** Phase 0 applies to both hosts. Phase 1 and later are v2-only.
- **I16 — Approvals come from a human.** An approval is created only by a human reply to a prompt the router composed from git. No agent tool call, route-line field, dispatch text or project-layer configuration can create, extend or widen one.
- **I17 — Approvals are bound and expire.** An approval is bound to the repository identity (canonical path and root-commit set) and expires after `routing.repoApprovalDays` without use, and at most 90 days after it was given.
- **I18 — Lift only inside the grant.** The router lifts a host `ask` to `allow` only for `external_directory` resources inside the W or R of an exact binding (D13). It never lifts another action, never overrides a configured `deny`, and never lifts for an unknown binding.

## 5. Declare-then-check

Each check compares a value the orchestrator declared with git metadata. Nothing is inferred from file content.

### Route-line fields

| Field | Exists | Value |
|---|---|---|
| `root=<abs path>` | yes (`src/routing/classify/route-line.ts:164-169`) | as today; may now name an admitted repository or worktree |
| `repo=<name>` | yes (Phase 1, D16) | a repository name (section 3) |
| `branch=<ref>` | yes (Phase 1, D16) | Taken from the raw value, case preserved. Values are lowercased at `route-line.ts:115`, which is why `root` uses `rawValue` at `:166`. Allowed: `[A-Za-z0-9._/-]`, 1–200 characters, no `..` or `//`, not starting with `-` or `/`, not ending in `/` or `.lock`. |

An invalid `branch=`, `repo=` or `root=` (rejected, bare, duplicate or conflicting) is an invalid declaration: it refuses the dispatch with `[router] role dispatch @<agent> refused: <note>` (D15, D17). The router never silently binds to whatever branch happens to be checked out.

### Resolution

| Declared | Result |
|---|---|
| `root` | as today, plus admission (section 3) |
| `repo` | The repository's only worktree. With several worktrees: refused with the "worktree → branch" list. |
| `repo` + `branch` | the worktree of `repo` that has `refs/heads/<branch>` checked out |
| `repo` = directory name of a linked worktree (D16, Q10) | That worktree, found as `<parent>\<name>` or `<parent>\*\<name>`. With `branch`: the worktree of the repository it belongs to on that branch, whatever its directory is called. A repository named `<name>` and a worktree directory `<name>` of another repository, or two such directories of different repositories, are refused as ambiguous, each listed as `<worktree path> (repository <name>, branch <branch>)`. |
| `branch` | the session repository's worktree on that branch |
| `root` + `branch` / `root` + `repo` / all three | All declarations must agree; otherwise the dispatch is refused (`[router] role dispatch @<agent> refused: <note>`, D15) with a note that names the agreeing values. |

On success, the binding records the repository name, the repository (main worktree), the worktree, the branch (or "detached") and HEAD. The router adds the worktree to the orchestrator session's working set.

### Notes and refusals (proposed wording)

At binding (the dispatch is refused with `[router] role dispatch @<agent> refused: <note>`, D15; the note is the text below):

```text
root=D:\git\app-a-wt declares branch=feat/login, but that worktree is on main (HEAD 3f2c1a9): no work root.
The worktree on feat/login is D:\git\app-a-login — use repo=app-a branch=feat/login.

repo=app matches two repositories: D:\git\app and D:\git\clients\app: no work root. Name one with root="<path>".

repo=app-a has 3 worktrees: D:\git\app-a → main; D:\git\app-a-login → feat/login;
C:\Temp\app-a-hotfix → detached at 3f2c1a9: no work root. Add branch=<name>, or name one with root="<path>".

root=E:\work\x is not below routing.repoParents (D:\git) and is not a worktree of a repository in this session:
no work root. A first-use approval was requested (Phase 4); or clone it or add a worktree below D:\git.

root=D:\git\a\b\c is 3 levels below D:\git; repositories are admitted 1 to 2 levels below a parent (routing.repoDepth).
```

In the guards (the child sees these and can correct itself):

```text
edit: D:\git\app-a\src\auth.ts is in worktree D:\git\app-a (repository app-a, branch main); this dispatch edits only
in D:\git\app-a-login (branch feat/login). The same file in your work root is D:\git\app-a-login\src\auth.ts.

edit: D:\git\lib-b\src\index.ts is in repository lib-b (branch main), which this dispatch may read but not edit.
Finish the app-a part and return NEED MORE: naming the lib-b change; it needs a dispatch with repo=lib-b.

read: C:\Users\x\notes\a.md is outside this dispatch's work root D:\git\app-a-login (use an absolute path inside it)

router_run: cwd D:\git\lib-b is repository lib-b (branch main); this dispatch runs only in its work root
D:\git\app-a-login (repository app-a, branch feat/login).
```

- The corrected path in the first edit message is a fixed mapping: same repository, other worktree, same relative path.
- A host denial for a worktree outside the parents (section 3) is the host's own message, which the router cannot change.

### Dispatch header (only when `routing.repoParents` is configured or an approval exists)

Implemented for tier dispatches and, since P2g (OD6), for routed role dispatches with a work root and read access (the role header, `buildRoleDispatchHeader`; a read-only role is told `read` instead of `read or write`).

```text
Working directory: D:\git\app-a-login (repository app-a, branch feat/login at 3f2c1a9). You are already there — do not ask permission to read or write inside it.

Repositories in this session: app-a (feat/login), lib-b (main). You may read any repository below D:\git; you edit and run only in your working directory.
```

The first sentence of the working-directory paragraph is today's text (`src/router/dispatch-header.ts:40`). Without the configuration, the header is byte-identical (`dispatch-header.ts:25-27`).

**Read provenance.** A role's `read` or `grep` result from outside W gets one more line:

```text
[router: read from lib-b (main) at D:\git\lib-b — read-only in this dispatch]
```

### Re-checks

- **At the gate:** I7 (branch continuity) and I4 (perimeter). For a deferred dispatch the gate is the return: I4 is decided there and frozen, and never decided again.
- **At `router_verify`:** W's branch is compared with its branch at return (I7). The link targets of P are observed again (S11): a changed or unobservable one turns a pass UNVERIFIED (D18); when every such link is only unobservable, the pass is "not judged" and the handle stays open for another `router_verify` (retryable, P2e QA round 1). Each frozen check placement must still resolve to the same repository (same path and git top as at return); otherwise nothing runs: `check <n> (<kind>) cwd=<cwd> no longer resolves to the same repository since the producer returned; nothing ran` (placement identity).

## 6. Verification

### Scenarios

| # | Scenario | Today | After |
|---|---|---|---|
| S1 | Role, W=app-a. A `router_run` script writes only lib-b (a tracked file). No edit in app-a. Check: `testsPass` in app-a. | **pass**: no changed files (`runner.ts:4298`, `baseline.ts:123-124`). The deferred no-change shortcut gives the same result (`wiring.ts:1639-1644`). | P0.3: caveat (I5), UNVERIFIED. P1: lib-b in P (linked by app-a, or bound in this session) → **unverifiable** (I4). |
| S2 | Same as S1, plus edits in app-a | **pass** on app-a's scoped tests | P1: lib-b in P → unverifiable (I4). lib-b not in P → pass naming P (I8); this is the known limit. |
| S3 | Tier; bash writes only lib-b | **pass** | P0.3: caveat (I5). Whether tiers snapshot the working set is open (Q1). |
| S4 | Tier edits app-a and lib-b with write tools; DoD cwd app-a | **pass**: `gate.ts:257` needs every path outside; the planner drops lib-b (`runner.ts:4413-4415`). Pinned by `test/unit/gate.test.ts:128-138`. | P0.1: **unverifiable** (I3) |
| S5 | Tier edits only lib-b with write tools; DoD cwd app-a | unverifiable (`gate.ts:257-269`) | unchanged |
| S6 | W=app-a; `node_modules\lib-b` → `D:\git\lib-b`. lib-b changes during the dispatch, an app-a test fails, and the reference rerun loads live lib-b and fails too. | **pass, "no worse than before"** (`baseline.ts:186-190`); the link is skipped (`reference.ts:1833-1834`) | P0.4: reference approximate (`external-link`) → **unverifiable** |
| S7 | Same as S6, but lib-b untouched; the failure really is pre-existing | pass, "no worse than before" | P0.4: unverifiable (the cost of failing closed). P2: link pinned → pass "no worse than before" again. |
| S8 | W=lib-b; app-a consumes lib-b; the change breaks app-a | Roles: cannot be expressed (lib-b cannot be W; `gate.ts:245`). Tier with cwd app-a: unverifiable (`gate.ts:257`). | P1: lib-b's checks decide, with the note "app-a links lib-b; not verified" when app-a is in the working set. P2: a working-set consumer without a check → caveat (UNVERIFIED). A consumer check with `scope=full`: fails → unverifiable, passes → pass. A scoped consumer check is refused before it runs, unverifiable ("must use scope=full", `src/verify/deterministic.ts:1872-1876` since P2). P3 (a): a consumer `testsPass` with an explicit `scope=affected` runs across the link into W instead (X11, D22); a `lintClean`, or a `testsPass` without an explicit scope, keeps the refusal. Consumers outside the working set are not discovered. |
| S9 | A script runs `git checkout main` in W; tests pass on main | **pass**: the commit diff becomes the change set (`wiring.ts:1118-1136`) | P0.2: **unverifiable** (I7) |
| S10 | Grader DoD; the producer wrote only through a script | grader **pass**; the prompt says an empty delta is valid (`src/verify/checker.ts:333`) | P0.3: caveat (I5) |
| S11 | Deferred; lib-b (linked by app-a) changes after return; app-a's tests pass against the new lib-b | Phase 2 implemented: the frozen link targets are observed again at `router_verify`; a changed target, or one that cannot be observed again, turns a pass **UNVERIFIED** with the caveat `the linked repository <name> at <root> changed since the producer returned; the checks ran against its new state` (or `… could not be observed again since the producer returned`); a fail stays a fail and carries it (`LINK_DRIFT_CAVEAT`, `wiring.ts`; D18). A pass held back only by targets that cannot be observed again is "not judged" and the handle stays open (retryable, P2e QA round 1). Before Phase 2 this was a pass (`checkDrift` checked stored paths only). | P2: unchanged by Phase 3. Under the contract this is staleness, not a false pass. |
| S12 | Deferred; W's branch switched after return | pass | P0.2: **unverifiable** (I7) |
| S13 | W=`D:\git\app-a-login`; the agent edits `D:\git\app-a\src\auth.ts` | refused with a generic message (`v2-hooks.ts:638`) | P1: refused, naming repository, worktree and branch, with the corrected path |
| S14 | `root=D:\git\app-a-wt branch=feat/login`, but that worktree is on main | `branch=` is an unknown key and is ignored; work silently happens on main | P1: the dispatch is refused (`[router] role dispatch @<agent> refused: <note>`, D15); the note names the worktree on feat/login |
| S15 | `root=E:\clients\acme-api`, outside every parent, never approved | no work root (not a worktree of the session repository) | P4: no work root; the router asks the human with the prompt in section 3. `always` → admitted until expiry; `once` → this dispatch only; `reject`, no reply or non-interactive → no work root. |
| S16 | `E:\clients\acme-api` was approved, then the folder was replaced by a different repository | — | P4: the root-commit set differs → approval void → asked again (I17) |
| S17 | The orchestrator sends a `question` whose text differs from the router-issued challenge, and the human answers "yes" | — | P4: no approval (I16); the note repeats the exact text to send |

### Dependency effects

**Affected tests in A when only B changed.**
- The planner drops every path outside A's git root (`runner.ts:4411-4416`). When nothing is left, the result is S6 `attribution-unavailable` (`runner.ts:4306`, `:4368`).
- `vitest related` and `jest --findRelatedTests` follow static imports only, and a cross-package effect is not run (`docs/VERIFICATION.md:183`).
- **Rule:** a check in a consumer repository runs with `scope=full` (Phase 2); a scoped one stays unverifiable, except a consumer `testsPass` with an explicit `scope=affected`, which runs across the link (Phase 3 (a), D22, below).

**Phase 3 (a) spike result (2026-10-12): yes, with a path-spelling amendment.** vitest 5.0.3, vite 8.3.1, node v24.21.0, pwsh. Each run is `vitest related <paths> --run --passWithNoTests` in a scratch consumer with a junction `node_modules\p3a-lib` → `lib`, whose stored target text differs in case from the disk (`Temp\Claude` against `Temp\claude`). Jest stays S6 (`cross-link-unsupported`).

| Run | Path passed | Selected |
|---|---|---|
| R1, R2, R5 | native real path (`realpathSync.native`) of an imported lib file, also with `/` | **none** |
| R3, B2 | junction spelling (`app\node_modules\p3a-lib\…`) | none (ids with `node_modules` are skipped) |
| R6 | upper-cased path | none |
| R7a/b | any spelling, with `resolve.preserveSymlinks: true` | none |
| C1, C3, C4 | real path as the junction stores it, or JS `fs.realpathSync` of the link path | the importing test |
| R4 | native real path of a lib file imported with `../../lib/other.js` | the importing test |
| R8a, C6 / C5 | consumer loads `dist/`: a `src/` file / the built `dist/` file | none / the importing test |
| B1 | this repository's config, junction case matching the disk, native real path | only the importing test, 6.2 s |

Conclusions:
- vite resolves the link with JS `fs.realpathSync`, which keeps the junction's stored target text (its case), and vitest matches the related set by exact string. Every changed W file is passed in the union of spellings: its native real path; W's top as the gate knows it + the relative path; for every consumer link into W, `fs.realpathSync(<link>)` + the relative path. Never the junction spelling.
- `resolve.preserveSymlinks: true`, a consumer that loads a build not in the change set, or no importing test all select 0 tests. A cross-link run that selects 0 tests is incomplete → unverifiable (the zero guard); a consumer test file that names a W package and did not run makes it incomplete too (D27).
- A consumer that loads `dist/` is selected only through the built file: W's ignored modules modified since the dispatch start are added (D23).
- A relative `../` import outside the consumer root is followed (R4).
- Cost: about 6 s for a related run over this repository's whole test graph, against minutes for `scope=full`.
- Details: `docs/design/cross-repo-phase3-plan.md`, "Item (a)".

**Reference contamination.**
- Materialize links the live `node_modules` (`reference.ts:1764-1798`). Workspace-link drift checks only targets inside the repository (`reference.ts:1820-1845`); a link to `D:\git\lib-b` was skipped there before P0.4.
- **P0.4 rule.** A package entry (top level, and one level under each `@scope`, as `packageEntries` reads them) is a link whose real path is outside root and realRoot and is not a package store (its parent is not `node_modules` or `node_modules/@scope`) → the reason `external-link`, and the reference is approximate. A link to the root or an ancestor → `root-link`.
- **What stays exact:** a `node_modules` that is itself a junction to an outside store, as in `test/unit/reference.test.ts:1291-1358`, and a link into a package store (a real path whose parent is `node_modules`).

**Pinning (Phase 2).**
- At dispatch, snapshot each admitted link target as part of P. Add a bounded digest of the ignored files under the target, excluding `node_modules`. The digest matters because `snapshotTree` hashes status, diffs and untracked files only (`tree.ts:214-243`), while linked packages often load an ignored `dist/`.
- At materialize, the link counts as exact when both are unchanged. It is `external-link` when:
  - the target changed;
  - the digest is over its bounds;
  - the target is not admitted (I12);
  - the target is not a git repository.
- A target's own external links are followed one level; deeper links are unpinned.

**Consumer discovery.** For each working-set worktree other than W, read the `node_modules` entries that `packageEntries` reads, looking for links whose real path is inside W. Repositories outside the working set are not scanned.

**Sequential workflows.** A later dispatch in app-a, made after lib-b changed, has an empty change set. Its full-suite failures caused by lib-b are pre-existing relative to that dispatch and can be excused. That verdict is about the later dispatch, not about lib-b's change. A change in lib-b is verified in lib-b's own dispatch, with consumer checks (Phase 2).

### Perimeter costs and bounds

- **Snapshot cost.** Every dispatch snapshots each root in P at dispatch and at return. `sharedSnapshots` runs one snapshot per key, so parallel dispatches share them (`wiring.ts:1331-1335`).
- **Snapshot failure.** A snapshot that times out or fails leaves that root unobserved. With an unattributable writer in the lineage, the result is unverifiable.
- **Working-set bound.** The working set holds at most 16 roots (implemented: `WORKING_SET_MAX`, `src/routing/wire/working-set.ts:10`). Above the bound, the oldest root leaves it, and the evidence says so.
- **Submodules.** A repository with submodules gives no snapshot (`tree.ts:233`), so it is unobserved.

## 7. Change map

Each slice lands test-first: the failing test reproduces the scenario row, then the code follows. CHANGELOG entries go under `## [Unreleased]`: Phase 0 under "Fixed", Phase 1 and later under "Added" ("OpenCode v2, roles mode").

### Phase 0 — integrity fixes in the shared engine, both hosts

**P0.1 — Mixed change set (S4)**
- `src/verify/gate.ts` `accept` (`:155-310`; the mixed check is `refuseMixedOutside`):
  - The coverage root is the git top level of the base: the gate snapshot's root (`observeChange` returns it, `wiring.ts:1514-1519`), else the base. On the deferred path, the root recorded at registration.
  - Any absolute changed path outside it → unverifiable, for both the deterministic and the grader branch. A relative path that climbs out of the root counts as outside.
  - The all-outside reason stays byte-identical. Mixed sets get a new reason that lists at most five outside paths.
- `src/verify/gate.ts` `Artefact`: add `changeRoot?`. It is set where artefacts are assembled: the native `task` after-hook and the `delegate` tool in `src/index.ts`, and `runClaimGate` (`wiring.ts:1876-1886`).
- Docs: `docs/VERIFICATION.md` (the safety net covers mixed sets; the artefact is not "a global git diff": it unions tool-observed edits, the status delta of the whole repository and commits).
- Follow-up: `snapshotTree` gives up on repositories with submodules (`tree.ts:233`) and returns no root, so the coverage root falls back to the base there.

**P0.2 — Branch switch (S9, S12)**
- `src/verify/tree.ts` `snapshotTree` (`:201-256`): add `branch`, first from `git symbolic-ref -q HEAD`; after QA round 1 from the same `git rev-parse HEAD --symbolic-full-name HEAD` call as the head (`HEAD` means detached, `null`).
- `wiring.ts` `observeChange` (`:1469-1520`): compare the dispatch snapshot's branch with the return snapshot's. When HEAD moved and either branch is unknown, treat it as a switch.
- `src/verify/pending.ts` registration (R3, `:41-71`): store the branch at return. `wiring.ts` `prepareClaim` (`:1818-1850`) compares it with the `snapshotFor` result (`:1773-1788`).
- `gate.ts`: a branch switch → unverifiable, for both branches of the gate. The reason: `the working tree <root> switched from branch <a> to <b> during the dispatch (since the producer returned); the checks would verify another branch`.
- Implemented: `src/verify/branch.ts` (`branchSwitched`, `branchSwitchReason`, `branchUnconfirmedReason`), `GitExitError` / `readBranch` in `tree.ts`; a switch during the dispatch on the deferred path returns `{ deferred: false, reason: "branch-switched" }` so the required gate refuses.
- Detached → detached at another commit counts as a switch (the verb is "moved"): commits on a detached HEAD cannot be told from a checkout without the reflog.
- Known difference: when the gate snapshot is missing on the synchronous path, behaviour is unchanged (the change baseline is unavailable); the deferred path refuses in the same situation with "cannot confirm the branch". After QA round 1 the `router_verify` form of "cannot confirm" is retryable (see below).
- Roles lineage: the carried baseline (`VerificationBaseline` in `src/router/sessions.ts`) records the introducing attempt's tree and any switch already found; a carried attempt is checked against it ("since the attempt that introduced this acceptance").

**After QA round 1 (head-state design)**
- The dispatch reads a cheap head state: one `git rev-parse --show-toplevel HEAD --symbolic-full-name HEAD` plus `git rev-list --walk-reflogs --count HEAD`. It is kept even when the full snapshot is contaminated or unavailable. The gate, and `router_verify` for a deferred result, read it again and apply `treeMove`, in this order:
  1. another top-level → relocated;
  2. another branch name → switched ("moved" when both sides are detached);
  3. both reflog counts known: a count that shrank → rewritten ("the reflog has fewer entries than before"); the same count with another HEAD → rewritten ("HEAD moved without a reflog entry");
  4. a reflog window since the dispatch (`readReflogWindow`: `git log -g -n <k+1> --format=%H%x09%gs HEAD`), judged by what moved HEAD. It must start at the dispatch head and end at the current head, otherwise → rewritten ("the reflog window does not line up with the recorded HEAD"). An entry whose commit equals the previous entry's is HEAD-neutral and ignored (`git stash`, an unstaging `git reset`, a checkout of the current branch, `merge --abort`, `cherry-pick --abort`). An entry that moved HEAD is accepted only for commits (including amend, initial and merge), `merge`, `cherry-pick`, `revert`, `am` and `pull` without rebase; anything else (checkout, reset, rebase, `pull --rebase`, an unnamed `update-ref`: "an unnamed reflog entry") → rewritten. The reason quotes `reflog: "<detail>"`, cleaned, at most 120 characters. Commits only, including commits on a detached HEAD, are no move;
  5. no window, or a reflog count of 0 (reflogs disabled) → the old fail-closed name rule.
- Reason texts (`<when>` is "during the dispatch" or "since the producer returned"):
  - switched: `the working tree <root> switched from <A> to <B> <when>; the checks would verify another branch. Check out <A> again and re-dispatch, or send a fresh [acceptance] block on the current branch.`
  - rewritten: `the working tree <root> moved or was rewritten <when> (reflog: "<detail>"); the checks could verify a tree without the producer's work. Re-dispatch, or send a fresh [acceptance] block.`
  - relocated: `the working tree <root> is now <root2> <when>; the checks would verify another tree. Re-dispatch in the intended worktree.`
- Fail-closed cases:
  - No repository, or an unborn HEAD, when the dispatch started (the producer runs `git init` or makes the first commit) → nothing is compared and nothing is refused.
  - Dispatch head read failed → the dispatch snapshot's head and branch stand in. Only when both are unknown → "cannot confirm the branch of <root>: the working tree could not be read when the dispatch started, so the checks could verify another branch. Re-dispatch, or send a fresh [acceptance] block." The dispatch-time head read gets the whole `baselineTimeoutMs` per git process.
  - A reflog that grew but whose entries cannot be read → rewritten ("the reflog entries could not be read").
  - Gate head unreadable → the snapshot name comparison is the fallback.
  - On a move the commit diff is not run (`committed` "unavailable"), so no cross-branch path enters the change set.
- `router_verify`: the registration records the head state at return (root, head, branch, reflog count). `router_verify` reads the head state again in parallel with its other work and applies `treeMove` "since the producer returned"; it no longer depends on the full snapshot for this check. "Cannot confirm the branch of <root>: the working tree could not be read at router_verify, …" is given only when the head state cannot be read, and it is retryable: the tool reports the handle as not judged and asks for another `router_verify` call. Entries registered without root or reflog use the name rule only. A switch the deferred finish detected is carried to the required gate even if the gate's own read misses it.
- Roles carried attempts: a "cannot confirm" reason is no longer recorded as the lineage's switch, and a switch the deferred finish saw is folded into the attempt before the role lineage records it. A switch found by any attempt is stored in the lineage and inherited; an inherited reason is prefixed "in an earlier attempt of this acceptance: ". A carried attempt with no readable tree, while the introducing attempt recorded a branch, gives "cannot confirm the branch of <root>: the working tree could not be read for this carried attempt, …". Carried attempts compare names and heads only (Q6).
- Known limit: one branch checked out in two worktrees (`--ignore-other-worktrees`): commits made in the other worktree move this HEAD on the same branch and become part of the change set.

**P0.3 — Unattributable writers (S1, S3, S10)**
- `src/verify/dispatch.ts`:
  - `record` (`:468-488`): collect `writers` per session (definition in I5).
  - `DispatchRecord` (`:174-206`) and `fold`: union the writers over the lineage.
  - `delta` (`:374-446`): return `unattributedWriters`.
- `gate.ts`: a pass with an empty change set and writers gets the caveat `no change was observed in <root> but the producer ran <tools>; a write those tools made cannot be seen, so this is not a verified pass` (`<root>`: the change root, else the base directory; at most five tools, then "and N more"), on both branches.
- The deferred no-change shortcut (`wiring.ts:1639-1644`) already falls through to the required gate, which then applies the caveat.
- Implemented: `isUnattributedWriter` / `isNonWritingTool` in `src/verify/dispatch.ts` (exact names for read-only router, context7 and Brave tools; prefixes are not trusted; `task`, `delegate` and `subagent` always count as writers); `unattributedWritersCaveat` in `src/verify/gate.ts`; carried to the gate on the task, delegate and deferred paths and through the roles carried baseline (`VerificationBaseline.writers`).
- The rule turns a passing verdict into `unverifiable` (accepted with a caveat, rejected under `strictUnverifiable`), like the other P0 refusals.

**P0.4 — External link at the reference (S6, S7)**
- `src/verify/reference.ts` materialize step 7 (`:1820-1845`): apply the P0.4 rule from section 6. Add `"external-link"` to the cause union (`:802-812`).
- After QA round 1: a package link to the repository root or an ancestor gives cause `root-link`; labels are root-relative even when the linked `node_modules` lives outside the repository; only a real path whose parent is `node_modules` (or `node_modules/@scope`) counts as a package store; dot-entries such as `node_modules/.cache` are ignored. Residual limits: nested links and yarn PnP `portal:`/`link:` are not detected. Cost: a worktree whose `node_modules` is a junction to another checkout makes every package link into that checkout `external-link`.
- Docs: `docs/VERIFICATION.md` (the approximate-reference causes and the junction note).

**Phase 0 docs:** amend ADR 0002 (`docs/adr/0002-acceptance-gate.md:78` says attribution is "never a global diff", while `dispatch.ts:403-404` adds the status delta of the whole repository).

### Phase 1 — v2 only, inert on v1

| Step | File:function | Change |
|---|---|---|
| P1.1 | `src/router/config.ts` `RoutingConfig` (`:331`), `GLOBAL_ONLY_ROLES_ROUTING_KEYS` (`:2211`), `resolveRolesRouting` (`:3208-3238`, `touched` `:3215-3216`); `src/router/roles-config.ts` next to `sanitizeWorkRoots` (`:222-244`) | Add `repoParents`, `repoDepth`, `repoExclude`. Sanitise with `workRootProblem` plus the glob and UNC/device refusals. Setting them on v1 gives the one-time notice. |
| P1.2 | new `src/routing/roles/admission.ts`; `src/routing/wire/dispatch.ts` new `parseWorktreeEntries` next to `parseWorktreeList` (`:482-502`) | Implement `admit(path)`, `resolveName(name)` and `locationOf(path)` (repository, name, worktree, branch, HEAD) with hardened git and a 5 s cache. Parse HEAD, branch, detached and prunable from the worktree list. |
| P1.3 | `src/routing/classify/route-line.ts` `parseFields` (`:91-188`); `src/routing/classify/types.ts` `RouteLine` | Add `repo=` and `branch=` (raw value). |
| P1.4 | `dispatch.ts` `resolveRoleWorkRoot` (`:550-585`), route flow (`:1516-1569`), resume (`:835-849`); `src/routing/roles/policy.ts` `DispatchGrant` (`:15-27`) | Admission and declare-then-check. The resolution and the grant carry `repository` and `location`. |
| P1.5 | `src/compat/v2-hooks.ts` `roleAuthorityDecision` (`:588-642`), `checkWorktree` (`:913-919`); `src/index.ts` `gitTools` registration (`:1460-1461`), `resolveWorkRootFor` (`:593-601`) | **Only the external_directory branch (`:607-615`) and the read/glob/grep branch (`:629-639`) widen**, to R, through an injected location resolver so the decision stays pure. The edit branch (`:622`, `:632`) and the `execute.before` edit paths are unchanged. Refusal texts carry the location (section 5). `checkWorktree` lists the binding's repository instead of `ctx.location.directory`. `dispatchRepository` comes from the binding. The logic of `roleRepository` (`git-tools.ts:980-992`) is unchanged. |
| P1.6 | `src/router/role-agents.ts` `registerRoleAgents` (`:347`) | Pass `<parent>/*` for each parent into `externalDirectoryPatterns` (`:242-263`). |
| P1.7 | new `src/routing/wire/working-set.ts`; `dispatch-header.ts` `buildDispatchHeader` (`:29-53`); `src/router/protocol.ts` `buildRolesProtocol` | The working set per orchestrator session, cleared on `session.deleted`. The header gains its location and working-set lines. The protocol gains one sentence and the `repo=`/`branch=` template, only when configured. |
| P1.8 | new `src/verify/perimeter.ts` (link discovery reusing `packageEntries` from `reference.ts`); `wiring.ts` `captureDepsFor` (`:1321-1347`), `observeChange`; `dispatch.ts` `observeEdit` overlap (`:223-224`), `concurrentDispatches` (`:456-463`); `gate.ts` | Snapshot P at dispatch and at return. Apply I4 and the I8 evidence, add the consumer note, and treat P roots as overlapping for capture contamination and for the concurrency count. |
| P1.9 | `src/index.ts` `tool.execute.after` (near `:2347`) | Add the read-provenance line to role reads outside W, only when configured. |
| P1.10 | `docs/ROLES.md` "Work roots" (`:171-209`), `docs/CONFIG_REFERENCE.md`, `test/unit/docs-drift.test.ts:1126-1127` | Document the keys and add them to the docs-drift key list. Keep the pinned sentences at `docs/ROLES.md:207-208` (`docs-drift.test.ts:1078-1079`). |

**Implemented (notes).** Deviations from the steps above, checked against the code at HEAD 2511f68:

- **Working set at grant time.** The orchestrator session's working set (up to 16 bound roots, forgotten on session deletion) is filled when a grant is bound, not when the dispatch returns.
- **Role dispatch header (P2g, OD6).** A routed role dispatch with a work root and read access gets a role header (not a delegate's, not a non-exact resume). A header the orchestrator copied from another dispatch is stripped and replaced by the router's own. With `dispatchHeader: false` the header is off, except that a work root other than the session directory is still told: a minimal header (the identity paragraph and the `Working directory:` paragraph, no repositories paragraph). When cross-repo is in use it names the session's repositories and the readable parents. The nonce line (or the carried acceptance block) stays last.
- **D13 limit.** The hook-level allow lifts an `ask` for `external_directory` inside W or R for an exactly bound session; a deny is never changed. Role agents are registered from a catch-all `*: deny`, so a directory outside the registered patterns (parents, `workRoots`, the session repository's worktrees at registration) is a static deny. A worktree outside the parents still needs a `routing.workRoots` glob or a restart (Q7).
- **Read refusal text kept.** A read outside W and outside the read set keeps today's text (`read: <path> is outside this dispatch's work root <root> (use an absolute path inside it)`); only edit refusals carry the location.
- **Link roots named by basename.** The perimeter names a repository reached through `node_modules` links by the basename of its root.
- **The perimeter does not defer.** A role dispatch with a cross-repo location, or whose session working set holds other repositories, is not deferred (reason `cross-repo`).

After QA rounds 1 and 2 (facts checked at HEAD effcdb3):

- **Admission.**
  - A final gate runs on every admission: `repoExclude` on both the shown and the canonical path; a candidate is never a configured parent or an ancestor of one; a path whose text lies below a parent must also lie below it canonically.
  - An excluded or link-escaping candidate is refused outright; there is no fallback to rule 2.
  - Rule 2 also requires the candidate's `git rev-parse --git-common-dir` to match its repository's.
  - When admission is in use, a `root=` other than the session directory binds only through admission. The admitted worktree must still realpath to itself.
  - The `repo=` lookup needs a `.git` entry before running git, skips dot-dirs, `node_modules` and excluded dirs, visits at most 2000 directories and lists at most 10 notes.
- **Route line.**
  - An invalid or duplicated `repo=`/`branch=`, or one that conflicts between lines, is an invalid declaration and refuses the dispatch (D15) with the note `<key>=<value> is not a valid repository name / branch name: no work root. Fix the route line.` An invalid `root=` (rejected, bare, duplicate or conflicting between lines) refuses the same way with `root=<value> is not a valid absolute work root: no work root. Fix the route line.` (D17).
  - Branch names follow git check-ref-format, so `renovate/foo+bar` and `feat/ação` are valid.
- **Working set.** It grows only when `routing.repoParents` is set, from the accepted grant's location, after the dispatch is registered. `branch=` alone still binds through declare-then-check but does not grow it.
- **Session in a subdirectory.** W stays the session directory when the bound worktree contains it and no other git top level lies between them. A session in a worktree nested inside another (for example `.wt/feat` inside main) is not kept.
- **Read set R.**
  - Only paths written fully qualified, or explicit search roots, reach R. A relative path, as written in any argument (`filePath`, `path`, `file_path`, patch paths), or a pathless search, is judged against W only and keeps the old refusal.
  - A repository in R needs a real `.git`: either `HEAD` plus `objects` or `commondir`, or a gitdir file whose target has `HEAD`. Links are refused. The gitdir target is checked for network paths after realpath. `HEAD` is read only from a regular file of at most 4 KiB.
  - `repoExclude` applies to every ancestor. `.git` internals are never read outside W.
- **Echoed values.** Names, branches and paths in edit refusals and provenance are quoted when they contain unsafe characters (`quoteGitPath` style, `[`/`]` escaped). An invalid branch shows as `(unknown)`.
- **D13 lift.** Only for the work root and the read set (never the session's own tool-output directory), and only when cross-repo is in use.
- **Perimeter.**
  - Planned for every routed role dispatch with a work root when `routing.repoParents` is set, even without `repo=`; also when the grant has a location or the working set holds other roots.
  - A pending snapshot of another repository is discarded when an unattributable writer runs, not only when it writes an overlapping cwd. That repository is then "could not be observed".
  - Roots past the cap of 16 are kept as unobserved.
  - Links are de-duplicated by repository top level, found by walking up to `.git` with no git call.
  - Repositories are admitted (depth, `repoExclude`, working set) before any git runs, and snapshotted with hardened git that keeps the inherited core settings (`autocrlf`, `eol`, `safecrlf`, `longpaths`, `quotepath`) unless the repository sets them.
  - A link target that is not admitted is named `(not admitted)`; an unobserved one is named `(not observed)`.
  - A pass shows the scope as a note: `verified scope: <W> (<branch> @ <head7>); also observed: …`. A changed repository without writers is marked `changed during the dispatch`.
  - A planning failure fails closed (placeholder root "the verification perimeter could not be planned…").
  - For a sibling worktree of W's own repository the I4 reason suggests `branch=` instead of `repo=`.

### Phase 2 — consumer checks, pinning, deferred P

| Step | File:function | Change |
|---|---|---|
| P2.1 | `src/verify/dod.ts` `parseAcceptanceBlock` (`:261-275`), with `parseKvPairs` (`:208-218`) | Per-check `cwd=` and `scope=affected\|full`. Implemented (see "Phase 2 implemented (notes)" and Phase 3 (a)), for example `check: testsPass cwd="D:\git\app-a" scope=full`. |
| P2.2 | `src/routing/roles/work-root.ts` `verificationScope` (`:121-132`) | Add `captureRoot` (always W). A per-check cwd must lie in R. The block-level `cwd:` is unchanged, so `docs-drift.test.ts:1078-1079` and `:1156` hold. |
| P2.3 | `src/index.ts:2164-2169` and the `delegate` path | Capture at `captureRoot`. |
| P2.4 | `gate.ts` `accept` (`:246-292`); `src/verify/deterministic.ts` (`:1307`, `:1506`) | Group checks by cwd. Apply I3 across the groups. A working-set consumer without a check gets a caveat. Per-check scope override; `scope=full` already bypasses batching (`src/verify/batch.ts:1766`). |
| P2.5 | `dispatch.ts` `roleGateOutsideWorkRoot` (`:671-678`) | Per-check cwd containment, so detection stays `deterministic` only when every check root is valid. |
| P2.6 | `reference.ts` `captureReference` and materialize step 7 | Pinning (section 6). |
| P2.7 | `pending.ts` R3; `wiring.ts` `finishDeferred` (`:2153`), `checkDrift` (`:2450`), `prepareClaim` (`:2483`), `runClaimGate` (`:2658`) and `judgeVerdict` (`:2744`) | Implemented (see "Phase 2 implemented (notes)"). Freeze P at return (statuses for I4 and I8, working-set roots, observed link targets, placements, link pins) and store the check groups; at `router_verify` observe the link targets again and add the link-target drift caveat (S11, `LINK_DRIFT_CAVEAT`, D18). A deferred dispatch stays synchronous (reason `cross-repo`) only when I4 already refuses at return, when a linked repository could not be observed within the deferral bound, or when a placement or a v2 tier per-check `cwd=` is refused. |

### Phase 3

- (a) A consumer `testsPass` with an explicit `scope=affected` runs `vitest related` across the link into W (the spike result is in section 6, "Dependency effects"). **Implemented** (`830d5db..9ccabd0`; plan and QA in [cross-repo-phase3-plan.md](cross-repo-phase3-plan.md), "Item (a)", decisions D22, D23 and D27; limits in section 9, "Known follow-ups (P3a QA)").
- A read-only `root` argument for `router_git_*` that names an admitted repository. **Implemented** (`3b6aec8..219e5c5`; plan and QA in [cross-repo-phase3-plan.md](cross-repo-phase3-plan.md), decisions D20 and D21; limits in section 9, "Known follow-ups (P3b QA)").
- Discovery of dependency edges that do not go through `node_modules` (no per-repository configuration).

### Phase 4 — first-use approval (v2 only, after spikes T1–T5)

| Step | File:function | Change |
|---|---|---|
| P4.0 | spikes | T1–T5 (section 3). The results decide between "ask on the orchestrator's `subagent` evaluation" and "router-issued `question` challenge". |
| P4.1 | `src/router/config.ts` (as P1.1) | Add `routing.repoApprovalDays` (global only, `1`–`90`, default `14`). |
| P4.2 | new `src/routing/roles/approvals.ts` | The approval store: read, write through a tmp file and rename (as `writeState`, `config.ts:2862-2868`), identity check (path and root-commit set), sliding expiry with the 90-day cap, protected locations. |
| P4.3 | `src/routing/roles/admission.ts` (P1.2); `dispatch.ts` `resolveRoleWorkRoot` | Admission rule 3. An unapproved candidate gives no work root and a note that carries the approval request. |
| P4.4 | `src/compat/v2-hooks.ts` evaluate hook (`:1228-1264`) | Either set `effect = "ask"` on the orchestrator's `subagent` evaluation for an unapproved candidate (T1), and record the reply from `permission.replied` (T3); or accept the router-issued challenge in `tool.execute.after` for `question` (`src/index.ts`, T5). |
| P4.5 | `src/compat/v2-hooks.ts` role branch of the evaluate hook (`:1257-1264`) | Lift `ask` to `allow` for `external_directory` resources inside the bound grant's W or R (D13, I18). A configured `deny` stays final. It does not depend on approvals and can land with Phase 1. It does not remove the restart or the `%TEMP%` gap for worktrees outside the parents: the registered catch-all is a static `*: deny` that the lift never overrides (Q7). |
| P4.6 | command registration (where the plugin registers its commands) | `/router repos`: list approvals, last use and expiry. |
| P4.7 | `docs/ROLES.md`, `docs/CONFIG_REFERENCE.md`, docs-drift key list | Document the approval flow, the store, expiry and revocation. |

### Phase 2 implemented (notes)

- **What a deferred dispatch freezes.** At return, `finishDeferred` freezes the perimeter for the handle: the statuses for I4 and I8, the working-set roots, the observed link targets, the check placements and the link pins. The I4 window is the dispatch and is never decided again.
- **Stays synchronous (reason `cross-repo`).** I4 already refuses at return (`a repository of the perimeter changed during the dispatch while an unattributable writer ran; verified synchronously`); a linked repository could not be observed within the deferral bound (`a linked repository could not be observed within the deferral bound; verified synchronously`); a check placement is refused; or a v2 tier dispatch carries a per-check `cwd=`.
- **At `router_verify`.** Consumers are discovered over the frozen working-set roots (I13). The link targets are observed again (S11, D18): one that changed since the producer returned, or cannot be observed again, turns a pass UNVERIFIED with `LINK_DRIFT_CAVEAT`; a fail keeps its verdict and carries the caveat. Since P2e QA round 1, a would-be pass held back only by links that cannot be observed again is "not judged" instead: the handle stays open (retryable) for another `router_verify`; one changed link makes it final. A placement whose path or git top changed since return runs nothing (`check <n> (<kind>) cwd=<cwd> no longer resolves to the same repository since the producer returned; nothing ran`); one that cannot be checked now runs nothing either and stays open (`… could not be checked since the producer returned (<code>); nothing ran`). The link pins kept for the entry keep the reference exact.
- **F13 (D19).** A full-scope `testsPass`/`lintClean` is never the cheap no-change shortcut: per-check `scope=full`, and config `testScope: "full"` on OpenCode v2 only (v1 unchanged).
- **X12.** With `routing.repoParents` set, role dispatches are deferred by default where they used to be synchronous: a "continue and finish" resume of a deferred attempt cannot back a `deterministic` detection (`docs/ROLES.md`).
- **User docs.** `docs/VERIFICATION.md` → "Deferred verification across repositories", `docs/ROLES.md`, `docs/CONFIG_REFERENCE.md` → "Which delegations defer".
- **P2e QA round 1.** The perimeter cap, retargeted links (S11), nested pin admission, I12 before re-observation, retryable unobserved drift, and a neutral full-scope risk reason were fixed (`2c6e39e` and its follow-up).

## 8. Test plan

**Changed on purpose**
- `test/unit/gate.test.ts:128-138`: `[inside, outside]` and `["relative.ts", outside]` now expect unverifiable and no exec. `["relative.ts"]` and `[]` stay pass. The all-outside reason tests (`gate.test.ts:122`, `:312`) stay byte-identical.

**Must stay green**
- Every golden in `test/golden/`, including the default roles protocol (`test/golden/roles-protocol.golden.test.ts:26-55`, template test `:101-108`), the dispatch header and the banners.
- `test/unit/runner.test.ts:741-777`.
- `test/unit/reference.test.ts:1291-1358` (`node_modules` as a junction to an outside store stays exact).
- The docs-drift pins.
- `npm run smoke:v1`.

**New, per slice**

| Slice | Tests |
|---|---|
| P0.1 | gate: role and tier mixed sets, grader branch with an outside path, coverage root from the snapshot, a relative path that climbs out, the reason capped at five paths; one integration test that fails when the `changeRoot` threading is removed (synchronous and deferred paths). |
| P0.2 | `test/unit/tree.test.ts`: branch, detached, unknown. Checkout during the dispatch → unverifiable (`test/unit/baseline-wiring.test.ts`). Checkout after return → unverifiable at `router_verify` (`test/integration/branch-switch.test.ts`, `test/integration/branch-switch-deferred.test.ts`). |
| P0.3 | Changed-file store: writers per session and folded over the lineage; `router_git_*` and `router_request_authority` are not writers. Gate: empty set plus writers → caveat; non-empty set plus writers → no caveat. The deferred no-change shortcut → caveat. |
| P0.4 | `reference.test.ts`: a package link into a git repository outside root → `exact: false`, cause `external-link`; a link target in a package store (parent `node_modules`) → exact; a link to the root or an ancestor → `root-link`; the store junction case unchanged; judgement: approximate → unverifiable. |
| P1 | Config: sanitising (glob, UNC, 8.3, `..`), stripping from the project layer, the v1 notice once (reset with `resetRolesWarnings`, `config.ts:3196`). Route line: `repo=` and `branch=` (`test/unit/route-line.roles.test.ts`). Admission: depth, the parent itself, a junction leading out, exclude, a non-top-level directory, a worktree outside the parents found by text. Names: collision, several worktrees, `repo` + `branch`. `roleAuthorityDecision`: reads in R allowed, edits outside W refused with the location and corrected path (`test/unit/v2-hooks.test.ts`). `checkWorktree` uses the binding's repository. `router_git` in an admitted repository. Registration pattern `D:\git\*`. Working set and header. A new golden case for the configured protocol. Rows S1, S2, S8, S13 and S14 as integration tests (`test/integration/roles-dispatch.test.ts`) with temporary repositories and win32 junctions. |
| P2 | Per-check `cwd=`/`scope=` parsing; capture stays at W when checks move; consumer caveat; pinning exact and approximate; deferred P drift (S7, S8, S11). |
| P4 | Store round trip and atomic write; sliding expiry and the 90-day cap; identity mismatch (S16); `routing.repoExclude` wins over an approval; protected locations are never asked; `once` / `always` / `reject` / no reply; non-interactive run → no work root; challenge with altered text, wrong answer, replayed or expired code → no approval (S17); an agent tool call or route-line field cannot create an approval (I16); hook-level allow only inside the bound grant, never for other actions or unknown bindings, and a configured deny stays final (I18); v1 inert with one notice. |

## 9. Risks and known limits

- **Pass is scoped to P.** A script write outside P is not observed, and a pass names P (I8).
- **Fail-closed scope of P0.1.** Any absolute path outside the repository that a write tool touched (for example a scratch file in the temp directory), mixed with repository edits, makes the result unverifiable. This is deliberate; there is no temp-directory exemption.
- **Parallel cross-repo dispatches.** When dispatches that run `router_run` work in parallel in repositories that are in each other's P, each sees the other's changes, and both become unverifiable (I4) until Q3 is decided.
- **Worktrees outside the parents** need a `routing.workRoots` glob in long form, or a restart for the session repository's worktrees; the hook-level allow (D13) does not change this, because the registered catch-all is a static deny (Q7). `%TEMP%` is often spelled in 8.3 form, which is refused.
- **Changing `routing.repoParents`** needs a restart for the host patterns.
- **The host pattern `<parent>\*` is wider than admission.** The router's hook narrows it, and an unknown binding gets no `external_directory` at all (`v2-hooks.ts:599`).
- **R is wide.** Every repository below the parents is readable by every local role, including files such as `.env`. Roles hold no egress together with local actions (`policy.ts:171-174`), but results flow through the orchestrator (`docs/ROLES.md:163-164`).
- **Names follow folder basenames.** Renaming a folder renames the repository.
- **Snapshot cost and failure.** Snapshot cost grows with the working set. A snapshot that times out leaves a root unobserved, and repositories with submodules are never observed (`tree.ts:233`).
- **Branch detection costs git processes.** The cheap head state is one `git rev-parse` plus one `git rev-list --walk-reflogs --count`, read at dispatch, at the gate and at `router_verify`; the snapshot reads its head and branch in the same `git rev-parse HEAD --symbolic-full-name HEAD` call it already made for the head, so it adds no process. Measured on this machine, a full snapshot of a typical repository takes 0.15–0.4 s, up to 1.8 s on the slowest repository under D:\git.
- **Known follow-ups (QA round 2, minor), accepted for now:**
  - **F5.** Dispatch head known but gate head unreadable falls back to the snapshot name rule; `router_verify` refuses in the same case.
  - **F8.** Carried attempts compare the snapshot name and head only (no root, no reflog).
  - **F9.** The dispatch head read may complete after the producer's first git command when `VERIFY_WAIT:0s`.
  - **F10.** The retryable "cannot confirm" is matched by text.
  - **F11.** The wording of the anchor and count rewrite reasons.
  - **N2.** The grader path refuses a deliverable written outside the cwd.
  - **N3.** Every delegating producer with an empty change set gets the unobservable-writer caveat.
  - **N4.** Entries created only by `noteWriter` are not swept.
  - **N5.** The comment about `subagent` and `observeEdit`.
  - **N6.** Relative paths are resolved against different bases by the two refusals.
  - **N7.** An empty or null child ID in metadata blocks the fallback.
  - **N8.** A call that throws after `noteWriter` counts as a writer.
  - **N9.** `storeLike` exempts an outside real path whose parent is named `node_modules`.
  - **N10.** File paths in refusal reasons are not sanitised.
- **Known follow-ups (Phase 1 QA), accepted for now:**
  - Rule 2 can still be fooled by a junction to a directory whose `.git` file points at the right repository's `worktrees/x` (needs write access to both paths).
  - An invalid `root=` next to a valid `repo=` is dropped silently.
  - The conflict note says "not a valid name" for two conflicting lines.
  - Admission notes and the plain "outside this dispatch's work root" refusal are not escaped.
  - R's exclude globs match only the canonical parent spelling.
  - A `root=` in the canonical spelling of a junctioned parent is refused on the route line. The `root` argument of `router_git_*` accepts it (Phase 3 (b), QA-1 F1).
  - A configured parent inside the session repository refuses that repository for `branch=`.
  - Contamination of perimeter snapshots is global across parallel dispatches.
  - Planning reruns on retries that already had no perimeter.
  - The fail-closed planning catch wraps the role check.
  - Ignored build output (for example `dist/`) in a linked repository is not observed, so a pass covers tracked and untracked files only (P2 pinning).
  - A repository with submodules is never observed, so with writers its dispatches are unverifiable.
  - The dispatch-header location line was dead code for roles; resolved by the role dispatch header (P2g, OD6).
  - The evaluate hook still accepts host-relative resources (`hostRelative`), and relies on `execute.before` refusing the relative form first.
- **Known follow-ups (Phase 2 QA round 1), accepted for now:**
  - Placements are resolved with the read set at return, while dispatch-time detection uses the read set at dispatch, so a working set that changes in between can make them disagree (the gate is authoritative). For a deferred entry the placements are frozen at return and are not resolved again: `router_verify` only checks that each still resolves to the same repository (path and git top), and runs nothing otherwise.
  - Pins are freed after the first gate of a synchronous dispatch, so a retry gate of the same dispatch treats links as approximate (fails safe). This no longer applies to a deferred entry: its pins are kept for the entry and keep the reference exact at `router_verify`.
  - A gate deadline that fires mid-scan is only tested with a pre-aborted signal.
  - The role header was emitted for every roles user with a work root; resolved by Q8 (D14): it is emitted only when relevant.
- **Known follow-ups (Phase 2 QA round 2, minor), accepted for now:**
  - m1: A copied router header is stripped only when the router adds its own header. It is not stripped with `dispatchHeader: false` and W equal to the session directory, without read access, or on a non-exact resume.
  - m2: Stripping a copied header removes everything up to the first `\n\n---\n\n`. A partial header without its separator, followed by a markdown rule, can cut the task text.
  - m3: The UNC check covers only the first hop of a link's text. Relative links to UNC links, symlinked `node_modules`/`@scope` directories, symlinked `package.json`/workspace directories and materialize steps 6 and 7 can still reach a network path. Skipped UNC links are dropped instead of kept as unadmitted (I12), and a local `\\?\C:\` or POSIX `//x` link is treated as UNC.
  - m4: The manifest size bound for the package-name lookup is checked after reading the file. A symlinked `package.json` to a device or FIFO is not bounded.
  - m5: `admittedLinks` can leak an entry when a pin finishes after its dispatch's pins were freed.
  - m6: An attributed write into a link target during the pin window is not detected. Only unattributable writers drop pins.
  - m7: Working-set seeds now carry the admission predicate the gate uses. A top spelled differently (junction, subst drive) and not below a parent is reported unobserved. A pin keyed by the working-set spelling is not found at materialize, which fails safe.
  - m8: Each link target gets a second hardened snapshot per role dispatch for its pin, and consumer discovery is sequential. The P0 timing tests (`unattributed-writers`, `branch-switch`, `branch-switch-deferred`) became sensitive to full-suite load.
  - `subagent` (like `task` and `delegate`) no longer contaminates captures or pins (round 2 M3 fix). The child's own writes are still observed.
  - Nits: `CONFIG_REFERENCE.md` and a comment in `src/routing/wire/dispatch.ts` say the work-root rule points to ENVIRONMENT, while `roles.ts` uses the `Working directory:` line first. A read-only role is told "You read only in your working directory." although R includes the working set. With `dispatchHeader: false`, a junction-spelled W equal to the session directory gets a minimal header. QA comment labels mix "QA-1"/"QA-2"/"QA-3" for round-1 items. A block-level `cwd: .git` is still accepted.
- **Known follow-ups (Q8–Q10 QA), accepted for now:** a route line placed after a copied header is not on the first line of the prompt, so its target is ignored and the dispatch runs in the session directory (the copied header itself is stripped). m1 above is superseded: a copied header is stripped, and replaced only when the router adds its own.
- **Known follow-ups (Q8–Q10 QA round 2, minor), accepted for now:**
  - A copied header is stripped only when the prompt starts with it: one behind leading blank lines (left by removing a route line), with CRLF separators, or without its separator survives, so the delegate can read two work roots.
  - Stripping drops everything up to the first `\n\n---\n\n` when the prompt starts with `[router] You are @`, which can remove orchestrator text after a header-like opening; it should check that every paragraph before the separator is a header paragraph.
  - A refusal note is quoted as a whole by `displaySafe` when any character is unsafe, so backslashes double and non-ASCII text becomes escapes.
  - Detached worktrees are worded three ways (`branch (detached)`, `detached at <sha>`, `branch detached`).
  - A duplicate or conflicting valid value is reported as "is not a valid …", and an identical duplicate `root=` repeats the note.
  - A child bound by `root=` without admission refuses any `repo=`/`branch=` on resume.
  - When `repo=` matches nothing, the hint "name a worktree of <repo> with root=" reads oddly.
  - An explicit `root=` with `repo=X` is accepted by directory name even when a repository named X also exists (`root=` is explicit).
- **Known follow-ups (P2e QA round 1), accepted for now:**
  - A placement whose directory did not exist at return is reported at `router_verify` as "no longer resolves to the same repository since the producer returned". The synchronous gate would have failed the `fileExists` check instead.
  - Consumer discovery is not shared between the entries of one `router_verify` call (up to 32 entries).
  - Link snapshots digest every dirty file of the linked repository, at return inside the 2 s deferral bound and again at `router_verify`.
  - A DoD that I3 across check roots will certainly refuse still defers. The refusal comes at `router_verify`.
  - The `branch-switched` early return of the deferred finish leaves the perimeter snapshots running until their own timeouts.
  - The `cross-repo` reason and its details are internal: nothing shows them to the orchestrator.
  - S11 covers W's direct link targets only. Nested link targets, ignored files (`dist/`) and skip-worktree/assume-unchanged edits in a linked repository are not re-observed.
- **Known follow-ups (P2e QA round 2, minor), accepted for now:**
  - A link the producer created during the dispatch (`file:`/`npm link`), or one added after return, is reported at `router_verify` as "changed since the producer returned" (final), where the synchronous gate passes. Registry installs and package-store links are not affected.
  - A link whose `at` is missing, or now resolves outside its frozen root, is "unobserved" and therefore retryable ("not judged" until the TTL); each retry runs the whole DoD first. Placements treat ENOENT as final drift.
  - A temporary read error on W's `node_modules` (EBUSY/EPERM) makes every frozen link "changed" (final) instead of retryable.
  - With config `testScope: "full"` on OpenCode v2, every deferred dispatch gets at least medium risk with the reason "the full suite runs (scope=full)", even when the scope comes from config. A foreign check without `scope=full` also gets that reason although the gate refuses it.
  - The "new link" check counts links into any observed root (working-set roots included) as covered, so a link added after return into a working-set root is not flagged.
  - Fixed 2026-10-12 (docs): user docs and D18 said an unobservable link makes a pass UNVERIFIED, while the code leaves the handle open ("not judged", retryable; `judgeVerdict`, `src/verify/wiring.ts:3217-3220`). `docs/VERIFICATION.md`, `docs/CONFIG_REFERENCE.md`, `docs/ROLES.md`, D18 and section 7 now say so, and `docs/VERIFICATION.md` documents the message `could not be checked since the producer returned (<code>); nothing ran` (`placementDriftOf`, `wiring.ts:2754`).
  - The new-link check calls `gitTopOf` without a ceiling: an outer repository (e.g. a dotfiles repo in the home folder) can hide a new link, and a mapped drive whose realpath is UNC makes blocking network calls.
  - I12 can still be bypassed if `<link.at>/.git` is removed after return: the hardened snapshot sets no `GIT_CEILING_DIRECTORIES`. The checks after the snapshot keep the verdict correct.
  - A capped working-set root that is also W's link target is deduplicated and never sets `linkUnobserved`, so it defers and S11 does not re-check it (needs 16 other working-set roots).
  - When perimeter planning fails, the dispatch still defers, and every outside link is later reported as "changed".
  - The missing-directory placement message holds only if the directory is still missing at `router_verify`.
  - `linkedTargets` runs once per entry per `router_verify` call, not shared.
- **Known follow-ups (P3b QA), accepted for now** (the `root` argument of `router_git_*`; step numbers refer to the resolution in [cross-repo-phase3-plan.md](cross-repo-phase3-plan.md)):
  - Names resolve only below the parents. `root` also reaches working-set worktrees outside the parents, where the host's static catch-all deny (Q7) blocks `read`.
  - A junction from outside the parents into R is refused for `router_git_*` but allowed for `read`.
  - Inspection errors keep the work-root wording behind the `root=<v>:` prefix.
  - A bare main repository is refused.
  - The provenance branch can be up to 5 s stale (admission cache).
  - N3: `{root: W}` is refused by the session gates while `{}` succeeds.
  - N4: `root` set to the top level of W's repository lifts W's subdirectory scope, as the read set allows.
  - N5: host `permission.read` and `external_directory` denies inside a parent are not consulted; only `routing.repoExclude` is.
  - F5 (rest): admission's `find()` directory walk is synchronous (at most 2000 stats), and admission's git calls are not aborted by the tool's deadline.
  - F3 changes dispatch-time behaviour: route lines refuse worktrees of excluded repositories. The read set agrees (M1).
- **Known follow-ups (P3b QA round 2, minor), accepted for now:**
  - m1: The "has N worktrees" refusal lists worktrees outside R, and treats a repository with one worktree in R and one outside as ambiguous.
  - m2: With overlapping parents, `root=<name>` is handed to admission in the first matching parent's spelling, which can give a depth refusal.
  - m3: F3 matches exact paths. An exclude glob on an ancestor of the repository, or one written in a link parent's spelling, does not refuse its linked worktree at admission. The read set checks ancestors since `219e5c5`.
  - m4: F6 redaction is regex-based: paths with spaces or `,;()'"<>|` leak or are mis-redacted. Structured paths from admission would fix it.
  - Nits: n1 the orchestrator lookup runs before the step-2 text checks, and the `readProvenanceLine` lookup is unbounded; n3 `objects/info/alternates` lets `show <sha>` read another object store, and a directory can be swapped between the last check and the spawn; n4 the step-5 refusal prints a junction's real target outside R; n5 `isDirectory` runs before `eligible` in `find()`; n7 a single capped match is kept, as for `repo=`; n8 each parent is resolved with a synchronous realpath on a refusal.
- **Known follow-ups (P3a QA), accepted for now** (the cross-link run of a consumer `testsPass` with `scope=affected`; D22, D23, D27; plan in [cross-repo-phase3-plan.md](cross-repo-phase3-plan.md), "Item (a)"):
  - Round 1, m1: a deleted build module is caught by the completeness check (D27) only when the test names a W package.
  - Round 1, m2: the hardened ignored listing ignores the user's global `core.excludesFile`; the change set honours it.
  - Round 1, m3: static scoping lacks D23's ignored modules; with `fullScope` it skips the check as full, while the gate runs it as cross-link.
  - Round 1, nits: the alias provider does synchronous fs work inside `withTimeout` and before the allowlist check; one note per compiled W test file; a W test-only change is NoAffected, and `__tests__` helpers are dropped.
  - Round 2, completeness-list gaps (D27): tests that reach W through consumer source, helper or setup modules; a non-default consumer `include`; a link name different from W's package name; one test file run by two projects is merged; vite aliases; a consumer config that imports a W preset.
  - Round 2: a declaration-only W change is "no affected tests" (type tests run only with `--typecheck`).
  - Round 2, clock and mtime precision: SMB/NFS, WSL2 `/mnt`, Docker bind mounts, FAT (2 s).
  - Round 2, unscanned link spellings: the own `node_modules` of W's workspace packages, and links above the consumer's git top. They are caught at file level by the zero guard and the completeness check.
  - Round 2, nits: the no-per-file-results branch is unreachable from the text fallback; up to 64 greps run outside `SEARCH_LIMIT`; a large fresh `dist` on win32 hits `argv-too-long`.
  - Round 2, fix choices that fail closed: any changed non-test W file edited after the build (docs too) makes the run `cross-link-build-stale`; any consumer vitest `projects`/workspace is S6 `cross-link-unchecked`; the `SETUP_REF_LIMIT` path is untested.
- **Known follow-ups (P3c QA), accepted for now** (dependency edges outside `node_modules`, Phase 3 lot 3; D24, D25, D26; plan in [cross-repo-phase3-plan.md](cross-repo-phase3-plan.md), "Tasks (lot 3)"):
  - Round 1, m1: an edge into another worktree of W's own repository is skipped (`sameRepository`, `src/verify/perimeter.ts:324`), so it is neither observed nor pinned. Accepted: an edge into another checkout of W's own repository is rare, and a `node_modules` link there is still a seed (`perimeter.ts:1145`).
  - Round 1, m3: P3c.6 fail-open gaps: the dependencies W declares at return are not read when the dispatch has no frozen admission (an entry planned before P3c.4) or no deferral deadline (`src/verify/wiring.ts:2116`), so neither a dependency added during the dispatch nor one removed is frozen. Accepted: only those entries take this path, and they keep the behaviour from before P3c.6 (P2e QA round 2 above).
  - Round 1, m6: I11 residual: text-first admission (`src/verify/perimeter.ts:264`, SD-P3c-3) checks where a spec leads, but symlinks inside an admitted root can still lead out of it. Accepted: I11 covers the spec, which is repository text; what lies inside an admitted root is trusted as the target of a `node_modules` link is (compare m3 of Phase 2 QA round 2 above).
  - Round 1, nits: reported with the minors and fixed where cheap (`d151fbd`, `18a15a0`); the rest were not itemized in this record (the round 1 list was not kept). Accepted: cosmetic.
  - Round 2, unescaped repository text in other router lines: the I4 reason prints `root.name`, `root.root` and the branch as they are (`src/verify/gate.ts:608-609`), and so does the consumer caveat with the consumer's name and root (`gate.ts:573`, `:578`; only its `via` goes through `displaySafe`, `:570`). Accepted: directory and branch text, not edge text, and it predates lot 3.
  - Round 2, silent read failures: a stat or read error (`src/verify/edges.ts:585-591`, `:599-603`, `readText`) or a JSON parse failure (`edges.ts:640-644`, `package.json`) skips the file without setting `incomplete`, so a transient EBUSY/EPERM at return can freeze a dependency W still declares as `removedAtReturn`; `router_verify` fails closed only when its own read succeeds. Accepted: it needs a transient error on W's own manifest at the moment of return, and a malformed file is skipped by design (SD-P3c-7).
  - Round 2: at `router_verify`, an incomplete read (or `unadmittedMore > 0`) still skips a link frozen `removedAtReturn` instead of failing closed (`src/verify/wiring.ts:2933-2935`). Accepted: the link is frozen removed only after a complete return read with no cut unadmitted targets, so this needs the producer to remove the dependency and a bound to cut the later read.
  - Round 2: the dispatch-time prefix covering through `frozen.observation.roots` (`wiring.ts:2994`) still covers any target below an unadmitted dispatch-time root. The F-3 rule ("same key, still unadmitted") does not apply there, because those roots are stored under a refused top level or real path, not under the edge's text. Accepted: such a root is already named `(not admitted)` at dispatch, and the covering predates lot 3 (P2e).
  - Round 2, nits: `displayEdgeText` and `EDGE_TEXT_DISPLAY_MAX` (`src/verify/perimeter.ts`) are used only by tests, while their comment says router lines use them; `scopeText` (`gate.ts`) and `linkCaveatText` (`wiring.ts`) duplicate `cappedDisplay` and cap before escaping, so a capped name can reach about 4 KiB once escaped; an edge whose last segment is literally the unplanned placeholder prints without `(not admitted)` (`gate.ts:622`); the m4 warning is not logged when `planPerimeter` returns `undefined`, fires on harmless incompleteness (a site-packages listing past 4000 entries), and is not logged for the return and `router_verify` reads; the m2 room-cap reason says "within the deferral bound", not the real cause (`wiring.ts:2475`, set through `linkUnobserved` at `:2127`). Accepted: wording, logging and test-only exports; no verdict depends on them.
- **Consumers** are discovered only in the working set: through a `node_modules` link into W, and, for a root without one, through its declared dependency edges read in reverse (P3c.5, `discoverConsumers`, `src/verify/perimeter.ts:723-730`): `package.json` path specs (for example `file:../lib`), tsconfig keys, Python editable installs in an in-repo venv, and Go `replace`/`go.work use`. An edge counts when its spec, resolved as text against its declaring file's directory, lies inside W's top level and not under a `node_modules` segment; nothing is resolved on the filesystem (I11). A root whose edge reading a bound cut (or whose scan stopped on its budget) and that has no consumer is reported incomplete. Cargo path dependencies, plain `../` imports and bundler aliases (vite, webpack) are not discovered (Q2, D25).
- **A consumer check's failures** are unverifiable, never "fail". The dependency is the changed repository, so the reference can neither excuse nor prove them.
- **`router_run` scripts** remain trusted repository content (`run-tools.ts:11-13`).
- **The approval store is protected from role agents only.** It lies outside every W and R, and roles edit only in W. A tier agent with a shell can write it, the same trust level tiers have today. The store is not signed.
- **An approval is only as good as the human's reading of the prompt.** The router composes the prompt from git, so dispatch text cannot change what is shown, but a human can still approve a hostile clone.
- **Non-interactive runs never approve.** A repository outside the parents is unusable as W in `opencode run` until it is approved interactively or moved below a parent.

## 10. Open questions

- **Q1.** Should tier dispatches on v2 snapshot the working set (tiers run bash, which can write anywhere)?
- **Q2.** Decided 2026-10-12: `../` imports and tsconfig/vite aliases that leave the repository resolve differently in the reference worktree under `%TEMP%`. They are documented as a limit (D25, OD-P3c-2 (a)); failing closed (a config scan for references outside the root makes the reference approximate) is recorded as a follow-up.
- **Q3.** Concurrent sibling writes into P. Phase 1 fails closed: unverifiable, with a reason naming the dispatches whose W is that repository. Should changes matching a sibling's tool-observed edits be attributed to the sibling instead?
- **Q4.** Decided 2026-10-10: hook-level allow approved (D13, I18).
- **Q5.** Approval defaults: 14 days after last use and a 90-day cap. Should an approval offer a read-only variant (R only, never W)?
- **Q6.** Same-branch history rewrite across a roles lineage: carried attempts compare names and heads only.
- **Q7.** Decided 2026-10-12: keep the generated external_directory catch-all `deny`. A worktree outside `routing.repoParents` is reached by adding its parent to `repoParents`; turning the catch-all into `ask` could leave a background child waiting on a prompt.
- **Q8.** Decided 2026-10-11: the role dispatch header (OD6) follows I9. It is emitted only when `routing.repoParents` is set, the route line declares `repo=`, `branch=` or `root=`, or the work root differs from the session directory; otherwise the dispatch prompt is byte-identical to what it was before the header existed (D14).
- **Q9.** Decided 2026-10-11: a role dispatch whose route line declared `repo=`, `branch=` or `root=` (or an invalid `repo=`/`branch=`) and whose work root was refused is refused: the `task` call fails with `[router] role dispatch @<agent> refused: <note>`. It no longer runs with no work root in the session directory. A dispatch that declares nothing is unchanged (D15). QA of Q9 (D17): an invalid `root=` also refuses, and an exact resume whose route line names a different target is refused (`a resume cannot change its work root: dispatch a new child`).
- **Q10.** Decided 2026-10-11: `repo=` also matches the directory name of a linked worktree below the parents; a name shared by a repository and a worktree directory is ambiguous (D16).

**To verify during implementation**
- That the host's `*` matches across separators on the installed version.
- Whether a config hot reload re-registers role agents.
- The `git symbolic-ref` exit codes (settled: the snapshot no longer uses `symbolic-ref`; head and branch come from one `rev-parse`).
- Snapshot time for a working set of 5–10 repositories within `baselineTimeoutMs`.
- Which agent grader sessions run as (`wiring.ts:1299-1306` passes none).
- Spikes T1–T5 (section 3).

## 11. Decision log

| # | Date | Decision |
|---|---|---|
| D1 | 2026-10-10 | Option A′: one write root per dispatch. W, R, P and C are separate. The capture is anchored at W. |
| D2 | 2026-10-10 | Automatic admission through `routing.repoParents` (proposed) replaces a per-repository `routing.repos` map. No per-repository configuration. Lazy resolution; no scan at startup. |
| D3 | 2026-10-10 | Repository name = basename of the main worktree's top level. A collision, or several worktrees without `branch=`, is refused with candidates. |
| D4 | 2026-10-10 | P = W's repository + the admitted repositories W links to + the session working set. R = all admitted repositories. The header shows the working set. |
| D5 | 2026-10-10 | Phase 0 applies to both hosts as integrity fixes to the shared engine, as allowed by the v1 freeze policy for security fixes. |
| D6 | 2026-10-10 | An unverified consumer gets a caveat (UNVERIFIED). |
| D7 | 2026-10-10 | Contract: a pass is scoped to P, and P is named in evidence. No OS sandbox. A deferred pass names P as it was at return (P is frozen then; the link targets are re-observed at `router_verify`, D18). |
| D8 | 2026-10-10 | First-use approval (trust on first use, with expiry) for repositories outside the parents is included as Phase 4, after spikes T1–T5. (Revises the earlier "deferred" decision.) |
| D9 | 2026-10-10 | Phase 0 order, test-first: S4, then S9, then unattributable writers (S1, S3, S10), then the external link (S6, S7). |
| D10 | 2026-10-10 | Prompt-injection detection is out of scope for this plugin. |
| D11 | 2026-10-10 | The approval prompt is composed by the router from git; approvals come only from a human reply, are bound to repository identity and expire (I16, I17). |
| D12 | 2026-10-10 | P0.1 fails closed for any outside path a write tool touched; no temp-directory exemption. |
| D13 | 2026-10-10 | Hook-level allow approved (Q4): in a role session with an exact binding, the router lifts the host's `ask` to `allow` for `external_directory` resources inside the grant's W or R; a configured `deny` stays final (I18). This replaces the rule that the router only narrows role decisions (`v2-hooks.ts:1257`). |
| D14 | 2026-10-11 | Q8 decided: the role dispatch header follows I9. It is emitted only when `routing.repoParents` is set, the route line declares `repo=`/`branch=`/`root=`, or the work root differs from the session directory (`dispatch.ts`, `headerRelevant`); `dispatchHeader: false` keeps its minimal-header exception. Without any of these the dispatch prompt is unchanged. |
| D15 | 2026-10-11 | Q9 decided: a declared target (`repo=`, `branch=`, `root=`, or an invalid `repo=`/`branch=`) whose binding was refused refuses the role dispatch with `RoleDispatchRefusal(agent, note)`; the task call fails with `[router] role dispatch @<agent> refused: <note>`. A dispatch that declared nothing, a delegate's dispatch and a resume of an exactly bound child are unchanged. |
| D16 | 2026-10-11 | Q10 decided: `repo=<name>` also matches a linked worktree whose directory name is `<name>` below `routing.repoParents` (`createAdmission` lookup/resolve). It binds that worktree; with `branch=`, the worktree of the repository it belongs to on that branch. A repository and a worktree directory sharing the name, or two such directories of different repositories, are refused as ambiguous with each candidate listed. |
| D17 | 2026-10-11 | QA of D15. (1) A `root=` the route-line parser rejected (invalid value, bare key, duplicate, or conflicting between lines) is an invalid declaration like `repo=`/`branch=`: it refuses the dispatch with `root=<value> is not a valid absolute work root: no work root. Fix the route line.` (`dispatch.ts`, `bindWorkRoot`). (2) An exact resume whose route line declares a target other than the child's bound root (`root=` not equal to the bound work root or its worktree, `repo=` not the bound repository's name, `branch=` not the bound branch, an invalid declaration, or a bound grant without a work root) is refused: `this child is bound to <work root> (repository <name>, branch <branch>); a resume cannot change its work root: dispatch a new child` (`declaresBoundRoot`, `boundRootRefusal`). A resume that declares nothing, or the bound target, is unchanged. |
| D18 | 2026-10-11 | OD-P2e-1 (S11): at `router_verify`, a frozen link target that changed since the producer returned, or cannot be observed again, turns a would-be pass **UNVERIFIED** with a caveat (`the linked repository <name> at <root> changed since the producer returned; the checks ran against its new state` / `… could not be observed again since the producer returned`, `LINK_DRIFT_CAVEAT`). A fail stays a fail and carries the caveat. Staleness is not silently accepted. Amended by P2e QA round 1 (`2c6e39e`): when every drifted link is only unobservable, a would-be pass is "not judged" and the handle stays open (retryable) instead of a final UNVERIFIED. |
| D19 | 2026-10-11 | OD-P2e-2 (F13): a full-scope `testsPass`/`lintClean` is never the cheap no-change shortcut. It applies to per-check `scope=full`, and to config `testScope: "full"` on OpenCode v2 only; v1 is unchanged (feature freeze). |
| D20 | 2026-10-12 | OD-P3b-1 = (b): the `root` argument of `router_git_*` is an absolute top-level path, or a bare name with the route-line `repo=` semantics (D16). There is no `branch` argument. Implemented (Phase 3 (b), `3b6aec8..219e5c5`). |
| D21 | 2026-10-12 | OD-P3b-2 = (a): only role agents may pass `root`, with an exact binding and `read`/`glob`/`grep` in the grant. Tiers and the orchestrator may not. Implemented (Phase 3 (b), `3b6aec8..219e5c5`). |
| D22 | 2026-10-12 | OD-P3a-1 = (a): a consumer `testsPass` opts in to the cross-link run only with an explicit `scope=affected`. Implemented (Phase 3 (a), `830d5db..9ccabd0`). |
| D23 | 2026-10-12 | OD-P3a-2 = (b): ignored build output in W (`dist/`): a bounded gate-time list of W's ignored JS/TS/JSON files is added to the related inputs; amended 2026-10-12 after QA-1 C1: only W's ignored modules modified since the dispatch start are added; a build older than a W source changed after it is S6 `cross-link-build-stale` (QA-2 M-A). Implemented (Phase 3 (a), `830d5db..9ccabd0`). |
| D24 | 2026-10-12 | OD-P3c-1 = (a): the dependency edge kinds that ship are Tier A: `package.json` path specs, tsconfig, Python editable installs in an in-repo venv, Go `replace`/`go.work`. Decided, not yet implemented. |
| D25 | 2026-10-12 | OD-P3c-2 = (a): Q2 (approximate reference for edges leaving the repository) is closed as a documented, narrower limit; failing closed is recorded as a follow-up. Decided, not yet implemented. |
| D26 | 2026-10-12 | OD-P3c-3 = (b): W's dependency targets are read again at return, and the new admitted ones are frozen, so a dependency added during the dispatch is not "changed" at `router_verify`. Decided, not yet implemented. |
| D27 | 2026-10-12 | QA-1 M2, owner decision: a post-run completeness check for the cross-link run: every consumer test file that names a W package in an import/require specifier must have run, else the result is incomplete. Implemented (Phase 3 (a), `830d5db..9ccabd0`). |

## 12. Alternatives considered

| Alternative | Outcome |
|---|---|
| A: one root plus a hand-maintained `routing.repos` map, reads relaxed outside the root | Replaced by D2. Reads are bounded to R and labelled. |
| B: several write roots per dispatch (`roots=`) | Rejected for now. A wrong-repository edit becomes allowed and silent, every path guard changes, and a grader can scope only one directory (`wiring.ts:1272-1275`). Possible later, built on the same per-root records. |
| C: named workspaces with a declared dependency graph | Rejected: per-repository configuration, and a stale graph is a false-pass risk. Discovered links are used instead. |
| D: read anywhere, write declared | Rejected: least privilege, and nothing signals when a stale checkout is read. |
| E: approval through a router tool the agent calls | Rejected: the agent could approve itself (I16). |
| F: rely on the host's "Allow always" saved approvals | Rejected: no expiry, project-scoped, and keyed by tool patterns rather than by a repository. |
| G: ask inside the child session | Not before spike T2: the prompt may not reach the human, and a background child may hang (`docs/qa/role-tier/spikes.md:191`). |
