# Cross-repo work in roles mode

**Status:** Accepted 2026-10-10 (owner). Phase 0 in progress (P0.1 and P0.4 done).
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
| **R**, read set | W plus every admitted repository and its worktrees (section 3). | `read`, `glob`, `grep` |
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
- **Worktrees outside every parent are not covered by the parent pattern.** Registration lists only the session repository's worktrees (`role-agents.ts:339-347`). Until the hook-level allow lands (P4.5, D13):
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

**Replies.** `once` admits the repository for this dispatch only. `always` stores an approval. `reject` gives no work root and a note. No reply, or a non-interactive run (`opencode run`), gives no work root. An approval is never created automatically.

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
- **Hook-level allow (approved, D13).** In a role session with an exact binding, the router lifts the host's `ask` to `allow` for `external_directory` resources inside the grant's W or R. A configured `deny` stays final. This changes the current rule that the router only ever narrows a role's decision (`v2-hooks.ts:1257`). It also removes the restart and the `%TEMP%` gap for worktrees outside the parents (above).

**Revocation and listing.** Delete the entry or the file. A listing command (proposed: `/router repos`) shows approvals, last use and expiry.

**v1.** Inert, with the one-time notice (I9).

## 4. Invariants

- **I1 — One write root.** A role dispatch edits and runs only in W:
  - the edit branch of `roleAuthorityDecision` (`v2-hooks.ts:622`, `:632`);
  - the `execute.before` path check (`v2-hooks.ts:1000-1019`);
  - `router_run` `authorizeCwd` (`run-tools.ts:251-267`).

  `router_git_*` runs only in W.
- **I2 — Capture anchored at W.** The change baseline, change set and reference are captured in W and P, never in a check cwd.
- **I3 — Coverage.** If any absolute changed path lies outside the git top level of every check root, the verdict is never pass. This includes change sets that are partly inside.
- **I4 — Perimeter changes.** A change in P outside W during the dispatch:
  - if the producer lineage ran an unattributable writer → unverifiable;
  - otherwise → a note. The reference is handled by I6.
- **I5 — Empty change with writers.** If no change was observed in P and the lineage ran an unattributable writer, a pass carries a caveat. It renders as UNVERIFIED (`docs/VERIFICATION.md:242`).
  - *Unattributable writer:* a tool that is neither in `WRITE_TOOLS` (`src/verify/dispatch.ts:101`) nor in `NON_WRITING_TOOLS` (`dispatch.ts:114-119`), and is not a read-only router tool (`router_git_*`, `src/router/git-tools.ts:11`; `router_request_authority`, `src/routing/roles/authority.ts:28`). This covers `bash`, `router_run`, MCP tools and unknown tools.
- **I6 — Reference exactness.** A package link in a linked `node_modules` whose real path is outside the repository and has no `node_modules` segment makes the reference approximate unless it is pinned (Phase 2). An approximate reference never excuses a failure (`baseline.ts:162-165`).
- **I7 — Branch continuity.** W's branch at return equals its branch at dispatch. At `router_verify`, it equals its branch at return. A HEAD that moved by commits on the same branch is handled as today (`wiring.ts:1118-1140`).
- **I8 — Scoped pass.** When `routing.repoParents` is configured, a pass's evidence names P (repository, branch, short HEAD) and every link target that was not observed.
- **I9 — Inert by default.** Without `routing.repoParents` and without approvals, the protocol text, dispatch header, banners and goldens are byte-identical. On v1 the new keys are inert, with one notice (`touched`, `config.ts:3215-3216`).
- **I10 — Reads never widen writes.** Read authority never widens write authority or the change baseline.
- **I11 — Admission.** `routing.repoParents`, `routing.repoDepth`, `routing.repoExclude` and `routing.repoApprovalDays` are global-layer only. Parents are literal, absolute, canonical long-form directories: no glob, no `.` or `..`, no 8.3 segment, no UNC or device path. A directory is admitted only by git (top-level equality, depth 1..N below a parent, never the parent, canonical form stays below the parent), as a worktree that an admitted repository lists, or by a valid first-use approval (I16, I17). Text comparison comes before every filesystem call on a path outside the parents, except composing a first-use approval prompt.
- **I12 — Where git runs.** The router runs git only in admitted repositories, the session repository and its worktrees, and (Phase 4) in a candidate for a first-use approval prompt. A link target outside them is not snapshotted: it is reported as "not observed" and is never pinned.
- **I13 — P is fixed at dispatch.** P is the working set at dispatch start, plus W, plus the admitted link targets of W. A repository bound later is not observed by an earlier dispatch.
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
| `repo=<name>` | proposed (not implemented) | a repository name (section 3) |
| `branch=<ref>` | proposed (not implemented) | Taken from the raw value, case preserved. Values are lowercased at `route-line.ts:115`, which is why `root` uses `rawValue` at `:166`. Allowed: `[A-Za-z0-9._/-]`, 1–200 characters, no `..` or `//`, not starting with `-` or `/`, not ending in `/` or `.lock`. |

An invalid `branch=` or `repo=` gives no work root and a note. The router never silently binds to whatever branch happens to be checked out.

### Resolution

| Declared | Result |
|---|---|
| `root` | as today, plus admission (section 3) |
| `repo` | The repository's only worktree. With several worktrees: refused with the "worktree → branch" list. |
| `repo` + `branch` | the worktree of `repo` that has `refs/heads/<branch>` checked out |
| `branch` | the session repository's worktree on that branch |
| `root` + `branch` / `root` + `repo` / all three | All declarations must agree; otherwise no work root and a note with the agreeing values. |

On success, the binding records the repository name, the repository (main worktree), the worktree, the branch (or "detached") and HEAD. The router adds the worktree to the orchestrator session's working set.

### Notes and refusals (proposed wording)

At binding (no work root; edit and run withheld, `src/routing/roles/policy.ts:177-182`):

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

read: C:\Users\x\notes\a.md is outside this dispatch's work root D:\git\app-a-login and outside every repository
below routing.repoParents (D:\git).

router_run: cwd D:\git\lib-b is repository lib-b (branch main); this dispatch runs only in its work root
D:\git\app-a-login (repository app-a, branch feat/login).
```

- The corrected path in the first edit message is a fixed mapping: same repository, other worktree, same relative path.
- A host denial for a worktree outside the parents (section 3) is the host's own message, which the router cannot change.

### Dispatch header (only when `routing.repoParents` is configured or an approval exists)

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

- **At the gate:** I7 (branch continuity) and I4 (perimeter).
- **At `router_verify`:** W's branch is compared with its branch at return (I7).

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
| S8 | W=lib-b; app-a consumes lib-b; the change breaks app-a | Roles: cannot be expressed (lib-b cannot be W; `gate.ts:245`). Tier with cwd app-a: unverifiable (`gate.ts:257`). | P1: lib-b's checks decide, with the note "app-a links lib-b; not verified" when app-a is in the working set. P2: a working-set consumer without a check → caveat (UNVERIFIED). A consumer check with `scope=full`: fails → unverifiable, passes → pass. A scoped consumer check → S6 `attribution-unavailable`, unverifiable (`runner.ts:4306`). Consumers outside the working set are not discovered. |
| S9 | A script runs `git checkout main` in W; tests pass on main | **pass**: the commit diff becomes the change set (`wiring.ts:1118-1136`) | P0.2: **unverifiable** (I7) |
| S10 | Grader DoD; the producer wrote only through a script | grader **pass**; the prompt says an empty delta is valid (`src/verify/checker.ts:333`) | P0.3: caveat (I5) |
| S11 | Deferred; lib-b (linked by app-a) changes after return; app-a's tests pass against the new lib-b | pass (`checkDrift` checks stored paths only, `wiring.ts:1795-1803`) | P2: caveat "lib-b changed since the producer returned" (link targets only). Under the contract this is staleness, not a false pass. |
| S12 | Deferred; W's branch switched after return | pass | P0.2: **unverifiable** (I7) |
| S13 | W=`D:\git\app-a-login`; the agent edits `D:\git\app-a\src\auth.ts` | refused with a generic message (`v2-hooks.ts:638`) | P1: refused, naming repository, worktree and branch, with the corrected path |
| S14 | `root=D:\git\app-a-wt branch=feat/login`, but that worktree is on main | `branch=` is an unknown key and is ignored; work silently happens on main | P1: no work root (edit and run withheld); the note names the worktree on feat/login |
| S15 | `root=E:\clients\acme-api`, outside every parent, never approved | no work root (not a worktree of the session repository) | P4: no work root; the router asks the human with the prompt in section 3. `always` → admitted until expiry; `once` → this dispatch only; `reject`, no reply or non-interactive → no work root. |
| S16 | `E:\clients\acme-api` was approved, then the folder was replaced by a different repository | — | P4: the root-commit set differs → approval void → asked again (I17) |
| S17 | The orchestrator sends a `question` whose text differs from the router-issued challenge, and the human answers "yes" | — | P4: no approval (I16); the note repeats the exact text to send |

### Dependency effects

**Affected tests in A when only B changed.**
- The planner drops every path outside A's git root (`runner.ts:4411-4416`). When nothing is left, the result is S6 `attribution-unavailable` (`runner.ts:4306`, `:4368`).
- `vitest related` and `jest --findRelatedTests` follow static imports only, and a cross-package effect is not run (`docs/VERIFICATION.md:183`).
- **Rule:** a check in a consumer repository runs with `scope=full` (Phase 2); a scoped one stays unverifiable.
- **Phase 3 spike:** test whether `vitest related <real path in B>` run in A finds A's importers through symlinked packages. Jest stays S6.

**Reference contamination.**
- Materialize links the live `node_modules` (`reference.ts:1764-1798`). Workspace-link drift checks only targets inside the repository (`reference.ts:1820-1845`); a link to `D:\git\lib-b` is skipped (`:1833-1834`).
- **P0.4 rule.** A package entry (top level, and one level under each `@scope`, as `packageEntries` reads them) is a link whose real path is outside root and realRoot and contains no `node_modules` segment → the reason `external-link`, and the reference is approximate.
- **What stays exact:** a `node_modules` that is itself a junction to an outside store, as in `test/unit/reference.test.ts:1291-1358`, and a link into a store path that contains `node_modules`.

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
- **Working-set bound.** The working set holds at most 16 roots (proposed). Above the bound, the oldest root leaves it, and the evidence says so.
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
- `src/verify/tree.ts` `snapshotTree` (`:201-256`): add `branch`, from `git symbolic-ref -q HEAD`. Exit 1 means detached (`null`); any other failure means unknown.
- `wiring.ts` `observeChange` (`:1469-1520`): compare the dispatch snapshot's branch with the return snapshot's. When HEAD moved and either branch is unknown, treat it as a switch.
- `src/verify/pending.ts` registration (R3, `:41-71`): store the branch at return. `wiring.ts` `prepareClaim` (`:1818-1850`) compares it with the `snapshotFor` result (`:1773-1788`).
- `gate.ts`: a branch switch → unverifiable, for both branches of the gate. The reason: `the working tree <root> switched from branch <a> to <b> during the dispatch (since the producer returned); the checks would verify another branch`.

**P0.3 — Unattributable writers (S1, S3, S10)**
- `src/verify/dispatch.ts`:
  - `record` (`:468-488`): collect `writers` per session (definition in I5).
  - `DispatchRecord` (`:174-206`) and `fold`: union the writers over the lineage.
  - `delta` (`:374-446`): return `unattributedWriters`.
- `gate.ts`: a pass with an empty change set and writers gets the caveat `no change was observed in <P> but the producer ran <tools>; a write outside <P> cannot be seen, so this is not a verified pass`, on both branches.
- The deferred no-change shortcut (`wiring.ts:1639-1644`) already falls through to the required gate, which then applies the caveat.

**P0.4 — External link at the reference (S6, S7)**
- `src/verify/reference.ts` materialize step 7 (`:1820-1845`): apply the P0.4 rule from section 6. Add `"external-link"` to the cause union (`:802-812`).
- Docs: `docs/VERIFICATION.md` (the approximate-reference causes and the junction note).

**Phase 0 docs:** amend ADR 0002 (`docs/adr/0002-acceptance-gate.md:78` says attribution is "never a global diff", while `dispatch.ts:403-404` adds the status delta of the whole repository).

### Phase 1 — v2 only, inert on v1

| Step | File:function | Change |
|---|---|---|
| P1.1 | `src/router/config.ts` `RoutingConfig` (`:331`), `GLOBAL_ONLY_ROLES_ROUTING_KEYS` (`:2211`), `resolveRolesRouting` (`:3208-3238`, `touched` `:3215-3216`); `src/router/roles-config.ts` next to `sanitizeWorkRoots` (`:222-244`) | Add `repoParents`, `repoDepth`, `repoExclude`. Sanitise with `workRootProblem` plus the glob and UNC/device refusals. Setting them on v1 gives the one-time notice. |
| P1.2 | new `src/routing/roles/admission.ts`; `src/routing/wire/dispatch.ts` new `parseWorktreeEntries` next to `parseWorktreeList` (`:482-502`) | Implement `admit(path)`, `resolveName(name)` and `locationOf(path)` (repository, name, worktree, branch, HEAD) with hardened git and a 5 s cache. Parse HEAD, branch, detached and prunable from the worktree list. |
| P1.3 | `src/routing/classify/route-line.ts` `parseFields` (`:91-188`); `src/routing/classify/types.ts` `RouteLine` | Add `repo=` and `branch=` (raw value). |
| P1.4 | `dispatch.ts` `resolveRoleWorkRoot` (`:550-585`), route flow (`:1516-1569`), resume (`:835-849`); `src/routing/roles/policy.ts` `DispatchGrant` (`:15-27`) | Admission and declare-then-check. The resolution and the grant carry `repository` and `location`. |
| P1.5 | `src/compat/v2-hooks.ts` `roleAuthorityDecision` (`:588-642`), `checkWorktree` (`:913-919`); `src/index.ts:1312`, `resolveWorkRootFor` (`:567-572`) | **Only the external_directory branch (`:607-615`) and the read/glob/grep branch (`:629-639`) widen**, to R, through an injected location resolver so the decision stays pure. The edit branch (`:622`, `:632`) and the `execute.before` edit paths are unchanged. Refusal texts carry the location (section 5). `checkWorktree` lists the binding's repository instead of `ctx.location.directory`. `dispatchRepository` comes from the binding. The logic of `roleRepository` (`git-tools.ts:953-963`) is unchanged. |
| P1.6 | `src/router/role-agents.ts` `registerRoleAgents` (`:347`) | Pass `<parent>/*` for each parent into `externalDirectoryPatterns` (`:242-263`). |
| P1.7 | new `src/routing/wire/working-set.ts`; `dispatch-header.ts` `buildDispatchHeader` (`:29-53`); `src/router/protocol.ts` `buildRolesProtocol` | The working set per orchestrator session, cleared on `session.deleted`. The header gains its location and working-set lines. The protocol gains one sentence and the `repo=`/`branch=` template, only when configured. |
| P1.8 | new `src/verify/perimeter.ts` (link discovery reusing `packageEntries` from `reference.ts`); `wiring.ts` `captureDepsFor` (`:1321-1347`), `observeChange`; `dispatch.ts` `observeEdit` overlap (`:223-224`), `concurrentDispatches` (`:456-463`); `gate.ts` | Snapshot P at dispatch and at return. Apply I4 and the I8 evidence, add the consumer note, and treat P roots as overlapping for capture contamination and for the concurrency count. |
| P1.9 | `src/index.ts` `tool.execute.after` (near `:2347`) | Add the read-provenance line to role reads outside W, only when configured. |
| P1.10 | `docs/ROLES.md` "Work roots" (`:171-209`), `docs/CONFIG_REFERENCE.md`, `test/unit/docs-drift.test.ts:1126-1127` | Document the keys and add them to the docs-drift key list. Keep the pinned sentences at `docs/ROLES.md:207-208` (`docs-drift.test.ts:1078-1079`). |

### Phase 2 — consumer checks, pinning, deferred P

| Step | File:function | Change |
|---|---|---|
| P2.1 | `src/verify/dod.ts` `parseAcceptanceBlock` (`:261-275`), with `parseKvPairs` (`:208-218`) | Per-check `cwd=` and `scope=affected\|full` (proposed, not implemented), for example `check: testsPass cwd="D:\git\app-a" scope=full`. |
| P2.2 | `src/routing/roles/work-root.ts` `verificationScope` (`:121-132`) | Add `captureRoot` (always W). A per-check cwd must lie in R. The block-level `cwd:` is unchanged, so `docs-drift.test.ts:1078-1079` and `:1156` hold. |
| P2.3 | `src/index.ts:2164-2169` and the `delegate` path | Capture at `captureRoot`. |
| P2.4 | `gate.ts` `accept` (`:246-292`); `src/verify/deterministic.ts` (`:1307`, `:1506`) | Group checks by cwd. Apply I3 across the groups. A working-set consumer without a check gets a caveat. Per-check scope override; `scope=full` already bypasses batching (`src/verify/batch.ts:1766`). |
| P2.5 | `dispatch.ts` `roleGateOutsideWorkRoot` (`:671-678`) | Per-check cwd containment, so detection stays `deterministic` only when every check root is valid. |
| P2.6 | `reference.ts` `captureReference` and materialize step 7 | Pinning (section 6). |
| P2.7 | `pending.ts` R3; `wiring.ts` `prepareClaim` and `checkDrift` (`:1795-1850`) | Store P identities and the check groups. Add the link-target drift caveat (S11). Until this lands, a DoD with a check outside W is verified synchronously (reason `cross-repo`, as the unregistered path does at `wiring.ts:1683-1686`). |

### Phase 3

- The `vitest related` cross-link spike.
- A read-only `root` argument for `router_git_*` that names an admitted repository.
- Discovery of dependency edges that do not go through `node_modules` (no per-repository configuration).

### Phase 4 — first-use approval (v2 only, after spikes T1–T5)

| Step | File:function | Change |
|---|---|---|
| P4.0 | spikes | T1–T5 (section 3). The results decide between "ask on the orchestrator's `subagent` evaluation" and "router-issued `question` challenge". |
| P4.1 | `src/router/config.ts` (as P1.1) | Add `routing.repoApprovalDays` (global only, `1`–`90`, default `14`). |
| P4.2 | new `src/routing/roles/approvals.ts` | The approval store: read, write through a tmp file and rename (as `writeState`, `config.ts:2862-2868`), identity check (path and root-commit set), sliding expiry with the 90-day cap, protected locations. |
| P4.3 | `src/routing/roles/admission.ts` (P1.2); `dispatch.ts` `resolveRoleWorkRoot` | Admission rule 3. An unapproved candidate gives no work root and a note that carries the approval request. |
| P4.4 | `src/compat/v2-hooks.ts` evaluate hook (`:1228-1264`) | Either set `effect = "ask"` on the orchestrator's `subagent` evaluation for an unapproved candidate (T1), and record the reply from `permission.replied` (T3); or accept the router-issued challenge in `tool.execute.after` for `question` (`src/index.ts`, T5). |
| P4.5 | `src/compat/v2-hooks.ts` role branch of the evaluate hook (`:1257-1264`) | Lift `ask` to `allow` for `external_directory` resources inside the bound grant's W or R (D13, I18). A configured `deny` stays final. It does not depend on approvals and can land with Phase 1: it also removes the restart and the `%TEMP%` gap for worktrees outside the parents. |
| P4.6 | command registration (where the plugin registers its commands) | `/router repos`: list approvals, last use and expiry. |
| P4.7 | `docs/ROLES.md`, `docs/CONFIG_REFERENCE.md`, docs-drift key list | Document the approval flow, the store, expiry and revocation. |

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
| P0.2 | `test/unit/tree.test.ts`: branch, detached, unknown. Checkout during the dispatch → unverifiable (`test/unit/baseline-wiring.test.ts`). Checkout after return → unverifiable at `router_verify` (`test/integration/deferred-verification.test.ts`). |
| P0.3 | Changed-file store: writers per session and folded over the lineage; `router_git_*` and `router_request_authority` are not writers. Gate: empty set plus writers → caveat; non-empty set plus writers → no caveat. The deferred no-change shortcut → caveat. |
| P0.4 | `reference.test.ts`: a package link into a git repository outside root → `exact: false`, cause `external-link`; a link target under a `node_modules` segment → exact; the store junction case unchanged; judgement: approximate → unverifiable. |
| P1 | Config: sanitising (glob, UNC, 8.3, `..`), stripping from the project layer, the v1 notice once (reset with `resetRolesWarnings`, `config.ts:3196`). Route line: `repo=` and `branch=` (`test/unit/route-line.roles.test.ts`). Admission: depth, the parent itself, a junction leading out, exclude, a non-top-level directory, a worktree outside the parents found by text. Names: collision, several worktrees, `repo` + `branch`. `roleAuthorityDecision`: reads in R allowed, edits outside W refused with the location and corrected path (`test/unit/v2-hooks.test.ts`). `checkWorktree` uses the binding's repository. `router_git` in an admitted repository. Registration pattern `D:\git\*`. Working set and header. A new golden case for the configured protocol. Rows S1, S2, S8, S13 and S14 as integration tests (`test/integration/roles-dispatch.test.ts`) with temporary repositories and win32 junctions. |
| P2 | Per-check `cwd=`/`scope=` parsing; capture stays at W when checks move; consumer caveat; pinning exact and approximate; deferred P drift (S7, S8, S11). |
| P4 | Store round trip and atomic write; sliding expiry and the 90-day cap; identity mismatch (S16); `routing.repoExclude` wins over an approval; protected locations are never asked; `once` / `always` / `reject` / no reply; non-interactive run → no work root; challenge with altered text, wrong answer, replayed or expired code → no approval (S17); an agent tool call or route-line field cannot create an approval (I16); hook-level allow only inside the bound grant, never for other actions or unknown bindings, and a configured deny stays final (I18); v1 inert with one notice. |

## 9. Risks and known limits

- **Pass is scoped to P.** A script write outside P is not observed, and a pass names P (I8).
- **Fail-closed scope of P0.1.** Any absolute path outside the repository that a write tool touched (for example a scratch file in the temp directory), mixed with repository edits, makes the result unverifiable. This is deliberate; there is no temp-directory exemption.
- **Parallel cross-repo dispatches.** When dispatches that run `router_run` work in parallel in repositories that are in each other's P, each sees the other's changes, and both become unverifiable (I4) until Q3 is decided.
- **Worktrees outside the parents** need a `routing.workRoots` glob in long form, or a restart for the session repository's worktrees, until the hook-level allow lands (P4.5, D13). `%TEMP%` is often spelled in 8.3 form, which is refused.
- **Changing `routing.repoParents`** needs a restart for the host patterns.
- **The host pattern `<parent>\*` is wider than admission.** The router's hook narrows it, and an unknown binding gets no `external_directory` at all (`v2-hooks.ts:599`).
- **R is wide.** Every repository below the parents is readable by every local role, including files such as `.env`. Roles hold no egress together with local actions (`policy.ts:171-174`), but results flow through the orchestrator (`docs/ROLES.md:163-164`).
- **Names follow folder basenames.** Renaming a folder renames the repository.
- **Snapshot cost and failure.** Snapshot cost grows with the working set. A snapshot that times out leaves a root unobserved, and repositories with submodules are never observed (`tree.ts:233`).
- **Consumers** are discovered only in the working set, and only through `node_modules` links. Python editable installs, Go `replace`, Cargo path dependencies, and `../` or alias imports are not discovered (Q2).
- **A consumer check's failures** are unverifiable, never "fail". The dependency is the changed repository, so the reference can neither excuse nor prove them.
- **`router_run` scripts** remain trusted repository content (`run-tools.ts:11-13`).
- **The approval store is protected from role agents only.** It lies outside every W and R, and roles edit only in W. A tier agent with a shell can write it, the same trust level tiers have today. The store is not signed.
- **An approval is only as good as the human's reading of the prompt.** The router composes the prompt from git, so dispatch text cannot change what is shown, but a human can still approve a hostile clone.
- **Non-interactive runs never approve.** A repository outside the parents is unusable as W in `opencode run` until it is approved interactively or moved below a parent.

## 10. Open questions

- **Q1.** Should tier dispatches on v2 snapshot the working set (tiers run bash, which can write anywhere)?
- **Q2.** `../` imports and tsconfig/vite aliases that leave the repository resolve differently in the reference worktree under `%TEMP%`. Fail closed (a config scan for references outside the root makes the reference approximate) or document as a limit?
- **Q3.** Concurrent sibling writes into P. Phase 1 fails closed: unverifiable, with a reason naming the dispatches whose W is that repository. Should changes matching a sibling's tool-observed edits be attributed to the sibling instead?
- **Q4.** Decided 2026-10-10: hook-level allow approved (D13, I18).
- **Q5.** Approval defaults: 14 days after last use and a 90-day cap. Should an approval offer a read-only variant (R only, never W)?

**To verify during implementation**
- That the host's `*` matches across separators on the installed version.
- Whether a config hot reload re-registers role agents.
- The `git symbolic-ref` exit codes.
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
| D7 | 2026-10-10 | Contract: a pass is scoped to P, and P is named in evidence. No OS sandbox. |
| D8 | 2026-10-10 | First-use approval (trust on first use, with expiry) for repositories outside the parents is included as Phase 4, after spikes T1–T5. (Revises the earlier "deferred" decision.) |
| D9 | 2026-10-10 | Phase 0 order, test-first: S4, then S9, then unattributable writers (S1, S3, S10), then the external link (S6, S7). |
| D10 | 2026-10-10 | Prompt-injection detection is out of scope for this plugin. |
| D11 | 2026-10-10 | The approval prompt is composed by the router from git; approvals come only from a human reply, are bound to repository identity and expire (I16, I17). |
| D12 | 2026-10-10 | P0.1 fails closed for any outside path a write tool touched; no temp-directory exemption. |
| D13 | 2026-10-10 | Hook-level allow approved (Q4): in a role session with an exact binding, the router lifts the host's `ask` to `allow` for `external_directory` resources inside the grant's W or R; a configured `deny` stays final (I18). This replaces the rule that the router only narrows role decisions (`v2-hooks.ts:1257`). |

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
