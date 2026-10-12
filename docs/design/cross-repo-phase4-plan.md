# Cross-repo Phase 4 (lean): approve repositories outside the parents by command

Design: `docs/design/cross-repo.md` §3 "First-use approval" (`:106-176`), I16/I17 (`:208-209`), §7 Phase 4 (`:511-522`). Issue #107.
Pre-flight at HEAD `8aac538`, branch `feat/cross-repo`. One lot. Tests are written with the code. Shared fixtures are allowed,
except in the anti-forgery file. One heavy QA round, then a re-check of its fixes, then one batched live dogfood.

## Summary

A role dispatch can name a repository outside `routing.repoParents` with `root=`. The router refuses it (D15) and adds a note
built from git. The human then types `/router approve <path>`. The router works out the repository's identity from git again,
prints what it approved, saves it and reloads the role agents so the host allows the directory. The orchestrator dispatches again,
and admission rule 3 admits the repository. `/router repos` lists the approvals and `/router revoke <path>` removes one.
There is no permission `ask`. This is v2 roles mode only, and only when `routing.repoParents` is non-empty (I9). It does nothing
on v1.

## Decisions

Owner (2026-10-12, final). Proposed D29; it replaces the channel part of D28.
- Channel: a command typed by a human. The note's details come from git, never from the dispatch text. (Live check
  2026-10-12: a subagent whose prompt is `/router` did not invoke the command.)
- After approval, the role agents reload at once (`refresh()`, `v2-hooks.ts:1324-1336`). Spike T6 is checked in the dogfood.
  If T6 fails, only the message changes: "restart OpenCode to use it". (T6 could not be observed in isolation: the router's own
  read-set refusal runs before the host's `external_directory` evaluation.)
- Scope OD-P4-2 (a): the approved repository works through `root=` (rule 3). It joins R and P, and `router_git_* root` works on it.
  Once bound, its worktrees are admitted by rule 2 through the working set. `repo=<name>` lookup outside the parents is deferred.
- Q5: an approval expires `routing.repoApprovalDays` after its last use (global only, 1–90, default 14). It never lasts more than
  90 days after `approvedAt`. There is no read-only variant. `routing.repoExclude` wins over an approval. Q7 stands.
- The D13 lift (P4.5 of the design) is already implemented (`v2-hooks.ts:1126-1131`, `:1414-1420`). It is not a task in this plan.

Self-decided (SD-P4-n):
1. **Store file.** Path: `dirname(statePath())/opencode-model-router.repo-approvals.json` (`config.ts:704-711`).
   - Format: `{version:1, approvals:[{path, commonDir, roots[], origin, approvedAt, lastUsedAt}]}`. Times are epoch ms.
   - Limits: at most 32 entries and 256 KiB. The size is checked with `stat` before reading.
   - Writes go through a tmp file and a rename (`config.ts:2881-2888`).
2. **Bad store data.** An invalid file (JSON, version or size) means no approvals (fail closed) and one notice. `approve` and
   `revoke` then refuse and name the file. An invalid entry is dropped when read: bad path text, roots that are not hex SHAs,
   `approvedAt > lastUsedAt`, a time more than 5 min in the future, or a duplicate path (both copies dropped).
3. **Writes.** Writes run one at a time in the process. Each write reads the file again and applies one operation:
   - `put`: replaces the entry for the same path (re-approving resets `approvedAt`), drops expired entries, and refuses at 32.
   - `delete`.
   - `touch`: only if the entry still has the same path and roots, so a revoked entry never comes back.
   - `approve` and `revoke` read the file back before reporting success. Across processes, the last rename wins.
4. **Only main worktrees can be approved.** The candidate's `.git` must be a local directory (checked with `lstat`, not a link),
   and its canonical common dir must equal `<canonical path>\.git`. Linked worktrees, submodules and separate git dirs are refused
   with "approve the main worktree".
5. **Rule 3 matches text first (I11).** `root=` text must equal the approval path before any filesystem call. Rule 3 runs before
   rule 2 for an approval path, so a folder that was replaced always fails the identity check. A different spelling that resolves
   to an approved path is refused, with a note naming the approved path.
6. **Identity check at every rule-3 admission.**
   - `realpath` equals `path`, and `isToplevel` (`admission.ts:399-404`) holds.
   - The canonical common dir equals the stored `commonDir`.
   - The sorted output of `git rev-list --max-parents=0 HEAD` equals the stored `roots`.
   - The `rev-list` answer is cached per (common dir, HEAD oid). The other git answers use the 5 s caches.
   - `ruleTwo` (`:473-512`) skips a known repository that is backed by an approval when its approval or identity fails.
7. **Last use.** `lastUsedAt` is touched on any binding backed by an approval: rule 3, or rule 2 through an approved repository.
   At most one write per hour per path. A failed touch never fails the dispatch.
8. **Refusal note.** The note is built only on the dispatch bind path, not for `router_git root` and not in the permission hook.
   - Git runs in the candidate only after these checks pass: `rootTextProblem` (`admission.ts:245-261`) on the text and on the
     canonical form, protected locations, exclusion and the `.git` directory.
   - Hardened git with a ceiling, about 5 s, like `gitRevParse` (`admission.ts:176-194`).
   - Results are cached 5 s per path. If git fails, today's note is unchanged.
9. **Origin shown to the human.** URL-form origins lose their user-info, query and fragment. The scp form (`user@host:path`) is
   kept. Branch and head pass through `displaySafe` (`read-set.ts:59-65`). The origin passes through `displaySafe` too, is capped
   at 200 characters, and shows `none` when there is no origin.
10. **Where the commands work.** All of these must hold, or the command falls through to today's `/router` help
    (`index.ts:292-297`):
    - the host is v2;
    - `rolesNow().size > 0`;
    - `routing.repoParents` is non-empty;
    - the invoking session has no parent, is not a role session and is not a known child (`orchestratorOf`, `index.ts:625-631`).
      A failed lookup refuses.

    `buildRouterHelp` (`output.ts:232`) lists the three subcommands only when they are available.
11. **Adapter changes.** The legacy handler marks its output with a non-enumerable `APPROVALS_CHANGED`. The v2 command adapter
    (`v2-hooks.ts:1436-1463`) then awaits `refresh()` and appends the line that says whether the approval is usable now.
    - That line is driven by one constant, `APPROVAL_RELOAD_APPLIES` (the T6 result). A refresh error gives the restart line too.
    - The text keeps going through the existing `/router` `session.prompt` path (`:1455-1460`). That way the orchestrator sees the
      approval and dispatches again.
12. **Revoke and expiry.**
    - `revoke` removes the repository from every working set at once (new `dropFromWorkingSets`, `working-set.ts`), then refreshes.
    - Expiry or a lost identity takes effect at the next binding. `crossRepoOf` (`dispatch.ts:1632-1646`) drops working-set entries
      whose approval is stale, using a store read without git.
    - The host pattern goes away at the next refresh or restart. The router hook still narrows in the meantime.
13. **`/router repos`** reads only the store, never git. It marks entries as expired or excluded.
14. **v1 notice.** `repoApprovalDays` joins `touched` (`config.ts:3238-3240`), so v1 gets only the existing one-time notice.
15. **Registration.** The store is read without git. An approval adds a `<path>\*` pattern only when all of these hold:
    - `routing.repoParents` is non-empty;
    - the approval has not expired and is not excluded by its text;
    - `realpath(path)` equals the stored path as text;
    - `workRootProblem` passes.

## Tasks (commit order; `Refs #107`; every commit leaves `src/` loadable)

| # | Files / functions | Change | Tests |
|---|---|---|---|
| P4.1 | `src/router/roles-config.ts` | `sanitizeRepoApprovalDays` (modelled on `:297-304`), `DEFAULT_REPO_APPROVAL_DAYS=14`, `REPO_APPROVAL_CAP_DAYS=90`; add to `collectRolesIssues` (`:480-492`) | `test/unit/roles.config.test.ts`: 0, 1, 90, 91, 1.5, string; project layer dropped |
| | `src/router/config.ts` | `RoutingConfig` (`:334-341`), validation (`:1831-1836`), `GLOBAL_ONLY_ROLES_ROUTING_KEYS` (`:2227`), known keys (`:2531-2533`), `ResolvedRolesRouting` and its default (`:3203-3264`), `touched` (SD-14) | as above |
| P4.2 | new `src/routing/roles/approvals.ts`, no git | Path; `readApprovals`; `applyApproval(op)` (SD-1..3); `expiresAt = min(lastUsedAt + days, approvedAt + 90d)`, valid when `now < expiresAt`; `protectedProblem(text, canonical)`; `sanitizeOrigin` | `test/unit/repo-approvals.store.test.ts`: round trip, tmp+rename, no resurrection, limits, strict validation, expiry edges (exactly at expiry, 1/90 days, cap reached despite use, future times), throttle, protected list, origin |
| P4.3 | `admission.ts` | Turn `gitRevParse` (`:176-194`) into `gitBounded(cwd, args)`; add `gitRootCommits`, `gitOrigin`, `gitHeadInfo` | `test/unit/repo-approvals.git.test.ts` (temp git repos) |
| | `approvals.ts` | `inspectCandidate(path)` (SD-4, SD-8, SD-9) and `verifyIdentity(entry)` (SD-6) | same file: replaced folder, orphan root, junction, gitfile, separate git dir, empty repo, subdirectory, timeout |
| P4.4 | `admission.ts` `createAdmission` | `AdmissionDeps` gets `approvals()` and `rootCommits()`. Rule 3 runs only with parents (SD-5, SD-6), then `locate` and `gate` (`:519-542`; exclusion wins). `RepoLocation.approval?: string`. The final refusal (`:556-557`) gets `approvable?: string` (the canonical candidate) | `test/unit/admission.test.ts`, new describe "rule 3" |
| P4.5 | `src/routing/wire/dispatch.ts` | `bindWorkRoot` (`:1665-1732`): on `approvable`, appends the note from `inspectCandidate` (SD-8), then `displaySafe` at `:1868`. After an approval-backed binding: `touch` (SD-7). `crossRepoOf`: prune stale entries (SD-12) | `test/integration/roles-dispatch.test.ts`: note built from git (dispatch text differs), approved repo binds and joins P, touch at most once per hour |
| | `src/routing/wire/working-set.ts` | `dropFromWorkingSets(match)` | `test/unit/working-set.test.ts` |
| P4.6 | `src/router/role-agents.ts` | `externalDirectoryPatterns` (`:242-270`) takes `approved`, built with `worktreeRootPattern` (`:198-206`) plus the realpath check. `registerRoleAgents` (`:326`) gets `opts.approvedRoots` | `test/unit/roles.registration.test.ts`: pattern present, expired/excluded/moved entry gives no pattern, no parents gives no pattern, tiers mode untouched |
| | `src/compat/v2-hooks.ts` `buildConfig` | Passes `approvedRoots` (`:1288-1291`) | same file |
| P4.7 | `src/index.ts` `/router` (`:3407-3460`) | Branches `approve`, `repos`, `revoke` (SD-10..13); new `src/commands/approvals.ts` (parse a quoted path, run the steps, format the output) | `test/unit/router-approvals-command.test.ts`: below a parent ("no approval needed"), protected, excluded, linked worktree, list and revoke, unknown revoke |
| | `src/commands/output.ts:232` | Help lines, only when the commands are available | `test/unit/commands-output.test.ts` |
| | `v2-hooks.ts:1436-1463` | Refresh on `APPROVALS_CHANGED`, then the extra line (SD-11) | `test/unit/v2-hooks.test.ts`: order store → reload → prompt, refresh error gives the restart line, constant off gives the restart line, revoke prunes and refreshes |
| | v1 | No change in v1 code | `test/unit/roles.v1-fallback.test.ts`: on v1, `/router approve X` is the help text byte for byte; no store file; at most one notice |
| P4.8 | new `test/unit/repo-approvals.forgery.test.ts` | Own fixtures only. Cases are in the QA list below | — |
| P4.9 | Docs | `docs/ROLES.md` (flow, Q7 limit, restart fallback), `docs/CONFIG_REFERENCE.md` (key row), `test/unit/docs-drift.test.ts` (`:852-857`, `:875-878`: add the key and the default `14`), CHANGELOG `[Unreleased]`, design §3/§5/§7/§11 (D29) and §10, handover | `npm run typecheck`, the files touched, `test/golden` |

## Security invariants

- **S1 (I16).** Only the command handler writes the store. The handler runs only when a human types the command in a top-level
  session. No tool, route-line field, dispatch text, project-layer key or `question` answer can create, extend or widen an approval.
- **S2.** What the human sees and what gets stored come from git at approve time. The refusal note is information only.
- **S3 (I17).** An approval is valid only when all of these still hold: path, canonical common dir, root-commit set, expiry and
  the 90-day cap. `repoExclude`, protected locations and the parent rules (`gate`) win over it.
- **S4 (I12).** Git runs only in three places:
  - in an approved repository, after a text match;
  - in an unapproved candidate, for the note;
  - in the path given to `/router approve`.

  In every case git is hardened, has a ceiling and is bounded.
- **S5 (I9).** With no parents, in tiers mode or on v1, the behaviour is byte-identical. The goldens and `smoke:v1` stay green.
- **Accepted residuals** (design `:688-689`):
  - Code with host API access (`session.command`) or with a shell can approve. `router_run` in W runs repository code, so it can
    write the store.
  - A human can approve a hostile clone.

## Adversarial QA cases (one heavy round, then a re-check of its fixes)

1. **Forgery.**
   - A route line with extra fields (`approve=`, `approved=yes`) or a duplicate `root=`.
   - Dispatch text or a description containing `/router approve X`.
   - A subagent or role session whose prompt is `/router approve X`.
   - `/router approve` invoked with a child `sessionID`.
   - A role that `edit`s or `write`s the store path. It must be refused: outside W and R, and protected.
   - Project-layer `routing.repoApprovalDays`, or an `approvals` block.
   - Every registered router tool called with approval-like arguments, `router_request_authority` included.
   - A `question` answered "approve".
   - In every case: the store bytes do not change and the note is not trusted.
2. **Path and identity swaps.**
   - A folder replaced by another repository at the same path.
   - A junction to an approved repository, and an approved path turned into a junction.
   - Case and separator variants. 8.3, UNC and `\\?\` paths, text and canonical form.
   - An orphan-branch checkout, a shallow clone deepened, history rewritten.
   - A gitfile, a separate git dir, a submodule, a linked worktree outside the main tree (the host denies it, Q7).
   - An approved repository nested inside a parent. A candidate that is or contains a parent.
3. **Protected locations.** Each one equal, ancestor and inside: opencode config dir, `OPENCODE_CONFIG_DIR`, data, state, cache,
   plugin install dir, store dir, user profile (equal or ancestor), drive root, `/`.
4. **`repoExclude`** on the text, on the canonical form and on the main worktree, added after approval. Exclusion wins and
   registration drops the pattern.
5. **Expiry boundaries.** Exactly at the expiry instant, one ms before, 1 day, 90 days, the cap reached despite frequent use,
   `repoApprovalDays` lowered after approval, the clock moved back, future timestamps.
6. **Concurrency.** Approve and revoke at the same time (in-process and in two processes); a touch racing a revoke (no
   resurrection); `refresh()` racing `/router-reload`; 33 approvals; a 256 KiB file; a corrupt file.
7. **v1 and inert modes.** v1, tiers mode, roles with no parents: the help is unchanged, no store I/O, no git, one notice at most.

## Live dogfood (one batch; restart only for the fallback)

Setup: a scratch repository `D:\omr-p4-ext`, outside `D:\git`. One commit; origin `https://u:tok@example.invalid/x.git`.

1. Dispatch `root=D:\omr-p4-ext`.
   - Expect: refused. The note shows the path, origin `https://example.invalid/x.git` (no `u:tok`), the branch and head, and
     `/router approve D:\omr-p4-ext`.
2. Ask the orchestrator to approve it itself, then give a role child the prompt `/router approve D:\omr-p4-ext`.
   - Expect: no approval. `/router repos` is empty.
3. Type `/router approve D:\omr-p4-ext`.
   - Expect: the identity, the expiry and "role agents reloaded".
4. **T6.** The orchestrator dispatches again. The child reads and edits a file there.
   - Pass: the approval works without a restart.
   - Fail (`external_directory` denied): flip `APPROVAL_RELOAD_APPLIES`, restart OpenCode, check the approval works and the
     message says "restart OpenCode to use it".
5. `/router repos` shows `lastUsedAt`. In a role child, `router_git_status root=D:\omr-p4-ext` works once the repository is bound.
6. Hand-edit the store and set `lastUsedAt` to 15 days ago.
   - Expect: `repos` shows it as expired and a dispatch is refused. Then restore it.
7. Swap the folder: rename it away and `git init` a new repository at the same path.
   - Expect: a dispatch is refused for identity. Then restore.
8. Junction `D:\omr-p4-link` pointing to the repository; dispatch `root=D:\omr-p4-link`.
   - Expect: refused, with a note naming the approved path.
9. Add `repoExclude: ["D:/omr-p4-ext"]`, then `/router-reload`.
   - Expect: refused. Then remove it.
10. `/router approve` on `C:\`, on the user profile and on `~\.config\opencode`.
    - Expect: all refused.
11. `/router revoke D:\omr-p4-ext`.
    - Expect: gone from the list, a new dispatch is refused, the role agents reload.
12. Clean up: `cmd /c rmdir D:\omr-p4-link`, remove the scratch repository. Run `test/golden` and `npm run smoke:v1` (it needs a
    1.x executable first on `PATH`).

## Risks

- **T6 fails.** Every approval needs a restart. That is a message change only (SD-11).
- **`rev-list --max-parents=0 HEAD` is slow on huge repositories.** The check fails closed after about 5 s; the cache per HEAD oid
  softens this. The root set also changes on an orphan checkout or a shallow deepen, so the approval is lost and must be given again
  (documented).
- **The host pattern `<path>\*` is wider than admission** and stays until the next refresh after expiry. The router hook still
  narrows, as with `workRoots` today.
- **The working set lives in memory and is trusted for R** (`read-set.ts:297-298`). An approval that expires mid-session is still
  readable until the next dispatch of that session (SD-12).
- **Cross-process races.** Two OpenCode instances writing the store can lose one write; the read-back reports it.
- **Worktrees of an approved repository outside its main tree** still need `routing.workRoots` or a restart (Q7, documented).
