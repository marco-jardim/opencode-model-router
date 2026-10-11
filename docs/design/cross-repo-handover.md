# Cross-repo work — session handover

Read this first in a new session. The design is `docs/design/cross-repo.md`, and the issue is
[#107](https://github.com/marco-jardim/opencode-model-router/issues/107). Each phase has a status comment on the issue.

## Environment

- **Worktree:** `D:\git\opencode-model-router-cross-repo`, branch `feat/cross-repo`. All work happens here; nothing is pushed.
- **Base:** `71dcfab` on `master` (the design commit). Every commit after it on the branch belongs to this work.
- **Do not touch:**
  - `D:\git\opencode-model-router`, the main tree on `master`. The owner works there in another session (`docs/plans/critical-path-execution-plan.md` is theirs).
  - `D:\git\omr-cpx-*` and `%LOCALAPPDATA%\omr-cpx\`, which belong to the owner's other implementation.
- **Dogfood instance:** this branch's plugin runs in a standalone OpenCode with its own config dir. `opencode.json` there points its plugin entry at the worktree.
  ```powershell
  $env:OPENCODE_CONFIG_DIR = "$env:LOCALAPPDATA\omr-cross-repo\opencode-config"; opencode --standalone -s <session> D:\git\opencode-model-router-cross-repo
  ```
  A change in `src/` takes effect only after restarting that instance. Ask the owner, then stop.
- **Router overrides:** `~\.config\opencode\opencode-model-router.overrides.jsonc` is read from a fixed path, shared by every instance. It now has `"repoParents": ["D:/git"]` (added for the Phase 1 dogfood) and the owner's existing `workRoots`.
- **Platform:** win32, pwsh 7, git 2.51.0.windows.1, OpenCode v2.0.26. No OpenCode 1.x is on PATH, so `smoke:v1` cannot run.

## Status

| Phase | State |
|---|---|
| P0: integrity fixes in the shared verification engine (both hosts) | Done. QA'd twice. Live check: the unobservable-writers caveat appeared on a real dispatch. |
| P1: v2 roles cross-repo (P1.1–P1.10) | Done. QA'd twice. Docs updated. Live dogfood done (see "Phase 1 live dogfood"). |
| P2 lot 1: P2a–P2d + P2g (plan `docs/design/cross-repo-phase2-plan.md`) | Done. QA'd twice (round 1: 4 major + 9 minor fixed; round 2: 3 major fixed, minors recorded in design §9). Docs and CHANGELOG updated. Live dogfood done (see "Phase 2 live dogfood"); findings F-D1, F-D2 wait for the owner. |
| P2 lot 2: P2e (deferred P), owner decision OD4 | Not started. Until it lands, a dispatch with per-check keys or a perimeter is verified synchronously. |
| P3 / P4 | Not started |

Last checks (HEAD after the round 2 fixes):
- `npm run typecheck`: clean.
- Goldens: all `test/golden/` pass; only the configured roles-protocol golden changed (OD5) and the new `dispatch-header.golden.test.ts` was added.
- Full `npx vitest run`: 50 failures in 15 files, every time it ran next to a reviewer's own test runs. Every failing file passes when run alone or in small groups, except the known `test/unit/exec.test.ts` timing tests. New in the load-sensitive list: `test/integration/unattributed-writers.test.ts`, `test/integration/branch-switch.test.ts`, `test/integration/branch-switch-deferred.test.ts`, `test/unit/tree-kill.test.ts`, `test/integration/perimeter.test.ts`, `test/integration/roles-authority.test.ts`, `test/integration/failover-compose.test.ts`, `test/integration/layer2-wiring.test.ts`, `test/integration/modeB-e2e.test.ts` (possibly related to round 2 m8, the extra pin snapshots). A clean full run with nothing else running has not been done yet.

## Next steps

1. ~~Phase 2 live dogfood~~: done (see "Phase 2 live dogfood"). Owner decisions Q9 (F-D1) and Q10 (F-D2) are open.
2. **Owner decision Q8** (design §10): the role dispatch header is emitted for every roles-mode dispatch with a work root. I9 says routing output is unchanged when cross-repo is not configured. Keep it always on, or only when `repoParents`, `repo=`/`branch=`/`root=` is used, or W differs from the session directory?
3. **Open owner decision Q7:** role agents are registered from a catch-all `*: deny`, so D13 cannot open worktrees outside the parents. The fix would turn the generated catch-all into `ask`; the risk is a background child waiting on a prompt. Do not change this without the owner.
4. **Phase 2 lot 2 (P2e)**, plan `docs/design/cross-repo-phase2-plan.md`: store P and placements in the pending registration, observe P in the deferred finish, `prepareClaim` sets `prepared.perimeter`, S11 drift caveat, lift the interim rule; fix `noChangeGateSpawnsNothing` with `testScope:"full"` (F13). Own heavy QA after it.
5. **Accepted minors** from the P0, P1 and P2 QA rounds are listed in design §9 ("Known follow-ups"). Revisit them only if they become relevant.

## Phase 2 live dogfood script

Run in the restarted dogfood instance, from an orchestrator session in this worktree.
- Setup: `New-Item -ItemType Junction -Path D:\git\opencode-model-router-cross-repo\node_modules\omr-xr-dogfood-lib -Target D:\git\omr-xr-dogfood-lib`. The scratch repository `D:\git\omr-xr-dogfood-lib` (branch `main`) must be clean.
- Remove the junction with `cmd /c rmdir <path>`, never `Remove-Item -Recurse` (it follows the junction).
- Dispatches (expected result in parentheses):
  1. Any role in this worktree: the delegate's prompt starts with `[router] You are @<role>` and a `Working directory:` line naming this worktree, branch and head.
  2. `implementer` `repo=omr-xr-dogfood-lib`, edit a file there, `check: fileExists`: UNVERIFIED by the consumer caveat naming this worktree (it links the lib), with the suggested check line.
  3. Same, plus a `check: run command="node -e ..."` or `testsPass ... cwd="D:\git\opencode-model-router-cross-repo" scope=full`: ✓ verified, no caveat.
  4. A consumer check that fails: UNVERIFIED, never FAIL.
  5. A consumer `testsPass` without `scope=full`: unverifiable ("must use scope=full").
  6. Only a consumer check, no check in the lib: unverifiable ("is not covered by any check root").
  7. `cwd="C:\Windows"`: refused, nothing ran. `scope=everything`: refused.
  8. `VERIFY:deferred` with per-check keys: verified at once, no handle.
  9. Tier `medium` with a per-check `cwd=`: unverifiable, "honoured only in roles mode".
  10. A role in this worktree with an untracked failing test and `testsPass ... scope=full`, lib unchanged: the reference has no `external-link` cause (pin exact); "no worse than before" only if `core.autocrlf` is false.

## Phase 2 live dogfood (2026-10-11)

Run in the restarted dogfood instance at HEAD `97fa7fb`..`eb9c78d`, `repoParents: ["D:/git"]`, `core.autocrlf=input`, with the junction `node_modules\omr-xr-dogfood-lib` → `D:\git\omr-xr-dogfood-lib` (removed afterwards with `cmd /c rmdir`; the scratch repository was cleaned).

| # | Dispatch | Result |
|---|---|---|
| 1 | `explorer` `repo=opencode-model-router branch=feat/cross-repo` | Pass. The child's prompt starts with `[router] You are @explorer…`, `Working directory: D:\git\opencode-model-router-cross-repo (repository opencode-model-router, branch feat/cross-repo at eb9c78d)…`, `Repositories in this session: opencode-model-router (feat/cross-repo). You may read any repository below D:/git.`, then the separator; nonce last. |
| 2 | `implementer` `repo=omr-xr-dogfood-lib`, `fileExists` only | Pass. UNVERIFIED: `opencode-model-router at D:\git\opencode-model-router-cross-repo links this work root (node_modules/omr-xr-dogfood-lib) and no check ran there; add a check such as: check: testsPass cwd="D:\git\opencode-model-router-cross-repo" scope=full`. |
| 3 | Same + `check: run command="node .dogfood-consumer.cjs" expect=value=1 cwd="<this worktree>"` | Pass. `✓ verified`, `verified scope: omr-xr-dogfood-lib (main @ 2d133c4); also observed: opencode-model-router (feat/cross-repo @ eb9c78d)`. (`node -p` is refused by the allowlist; an unquoted `command=` stops at the first space.) |
| 4 | A failing consumer check | Pass. UNVERIFIED, never FAIL: `a check in another repository (…) failed; … can be neither excused nor attributed: expected substring not found: "1"`. |
| 5 | Consumer `testsPass` without `scope=full` | Pass. `check 2 (testsPass) runs in another repository (…) and must use scope=full: …`. |
| 6 | Only a consumer check | Pass. `the change in D:\git\omr-xr-dogfood-lib\index.js is not covered by any check root (D:\git\opencode-model-router-cross-repo); nothing ran`. |
| 7 | `cwd="C:\Windows"`; `scope=everything` | Pass. `check 2 (fileExists) cwd=C:\Windows is outside the work root D:\git\omr-xr-dogfood-lib and its read set; nothing ran`; `check 1 (fileExists) scope=everything is not affected or full; nothing ran`. |
| 8 | `VERIFY:deferred` with per-check keys | Pass. Verified at once, no handle. |
| 9 | Tier `medium` with a per-check `cwd=` | Pass. `check 2 (fileExists) cwd=D:\git\omr-xr-dogfood-lib: a per-check cwd= is honoured only in roles mode; nothing ran`. |
| 10 | Role in this worktree, an untracked failing test that requires the lib, `testsPass command="npx vitest run <file>" scope=full`, lib untouched | Partial, as planned for autocrlf on: `the dispatch reference is approximate (checkout-conversion)`. The causes list every reason (`baseline.ts:163`), and `external-link` is absent, so the pinned link stayed exact. |

Findings:
- **F-D1 (medium, owner decision Q9).** A role dispatch whose declared `repo=`/`branch=`/`root=` is refused at admission runs anyway with no work root, and nobody is told: the note is stored on the routed decision (`dispatch.ts:1883`, `:1987`) and the decision row only. The child gets no header, keeps read access in the plugin's directory (`v2-hooks.ts:706` fallback), and its refusals call that fallback "this dispatch's work root". No write is possible (`policy.ts:184-189`), so it is a silent wrong-repository read, not a false pass. Reproduced with `repo=opencode-model-router-cross-repo` (the worktree directory, not the repository name). Options: refuse the dispatch with the note (preferred; flips `roles-dispatch.test.ts:817-830`, `:898` and ROLES.md:179, :268-269), or keep it running and add the note to the result notices and the child's header.
- **F-D2 (owner decision Q10).** `repo=` takes the repository name only. A delegate fix that also matched a linked worktree's directory name was reverted as a design change; a regression test for the correct form (`repo=<repository> branch=<branch>`, with the session in a linked worktree) was added (`eb9c78d`).

## Phase 2 lot 1 session notes (2026-10-11)

- **The live router loads this worktree's `src/`.** Every edit by a delegate must leave `src/` loadable. A half-applied edit once broke a dispatch with `captureRootOf is not defined`. Put this rule in every implementer dispatch.
- **"Agent not found" on parallel implementer dispatches** usually means the child did start: its edits appear in the tree. Check `git status`, then resume the same `sessionID` with "continue and finish". Fresh dispatches of one at a time fail less.
- **Delegates often skip "tests first"** under the read-budget guard. They say so in their reports; the tests exist and were reviewed.
- **The gate's `testsPass` cannot scope this repo's changes** ("attribution-unavailable"), so every implementer result came back UNVERIFIED. Every change was verified in the shell: typecheck plus the touched test files.
- **`subagent` no longer contaminates captures or pins** (round 2 M3), like `task` and `delegate`.

## Phase 1 live dogfood (2026-10-10)

Run in the dogfood instance at HEAD `7ecbfda`, with `repoParents: ["D:/git"]`.

| Check | Dispatch | Result |
|---|---|---|
| Work root and cross-repo read | `explorer`, `[route class=recon repo=mcp-reader]` | Pass. The work root resolved to `D:\git\mcp-reader` (`router_git_log` ran there). Reading this worktree returned `[router: read from opencode-model-router-cross-repo (feat/cross-repo) at D:\git\opencode-model-router-cross-repo — read-only in this dispatch]`. |
| Located refusal | `implementer`, `repo=mcp-reader needs=edit`, writes a new file in this worktree | Pass. `[router] Refused for role agent implementer in this dispatch: write: …\.dogfood-wrong-repo-probe.txt is in repository opencode-model-router-cross-repo (branch feat/cross-repo), which this dispatch may read but not edit. Finish the mcp-reader part and return NEED MORE: naming the opencode-model-router-cross-repo change; it needs a dispatch with repo=opencode-model-router-cross-repo.` |
| Scope note on a pass | `implementer` in this worktree, `VERIFY:required`, `fileExists` | Pass. `verified scope: opencode-model-router-cross-repo (feat/cross-repo @ 7ecbfda); also observed: mcp-reader (main @ fe7d775)`. mcp-reader comes from the working set (the parallel `repo=` dispatch). |
| I4, tier with `bash` | `medium`, writes through `node_modules\omr-xr-dogfood-lib` (a junction to the scratch repository `D:\git\omr-xr-dogfood-lib`) | `✓ verified` with no note. As designed: tier dispatches plan no perimeter (`perimeter.ts:167`; design S3, Q1). |
| I4, role with `router_run` | `implementer`, `router_run test-files` running a scratch test that writes through the same junction | Pass. UNVERIFIED: `the repository omr-xr-dogfood-lib at D:\git\omr-xr-dogfood-lib also changed during the dispatch, and the producer ran router_run; a write there cannot be attributed, so the checks in D:\git\opencode-model-router-cross-repo do not cover it. Dispatch that work with repo=omr-xr-dogfood-lib, or verify it there.` |

Observations:
- Role delegates are never told their work root: role dispatches get no header (the known "location line is dead code" follow-up). With `repo=`, every role delegate had to infer its work root from the prompt's ENVIRONMENT text. Fixed in Phase 2 (P2g, role dispatch header).
- In this instance the host's `<env>` block names `D:\git\Claude-model-router-cross-repo`, which does not exist. The AGENTS.md path in the system prompt is rewritten the same way (`omr-cross-repo\Claude-config`), so this is a text substitution in the prompt pipeline, not the router. It still misleads delegates.
- `fast` has no write or shell tool in this config; a write dispatched to it escalates to `medium`.
- The scratch repository `D:\git\omr-xr-dogfood-lib` (one commit, branch `main`) is kept for the Phase 2 dogfood. The junction and the scratch test were removed.

## Owner's working rules (from the session)

- Answer in Portuguese. Write code, docs and commits in English.
- Delegate through the model-router to subagents, with atomic tasks. QA is always heavy-tier and adversarial, and runs after every phase.
- Pre-flight before each phase. Fix every finding, or document it if a later phase covers it.
- QA rounds: after the second round on the same implementation, fix only blocking, critical and major findings.
- Commit often: Conventional Commits with a `Refs #107` trailer. **Never** add `Co-Authored-By` or "Generated with" lines.
- Test only what a change touches, in parallel. Run the full suite only at the end of a phase.
- Stop and ask the owner when an OpenCode restart is needed, or on anything blocking or critical.
- The owner approved Q4 (D13 hook-level allow) and every decision D1–D13 in the design.

## Practical lessons from this session

- **Delegate budgets:** the router stops every delegate at about 25 tool calls even with `CAP:none` and a `reason:`, and many dispatches end partway through. What worked:
  - give delegates exact file:line locations from a recon pass;
  - resume the same `sessionID` with "continue and finish";
  - for small edits that stall repeatedly, take over directly (the owner allowed this).
- **Agent names:** they are sometimes "not found" (`heavy`/`medium`) on a fresh dispatch; retrying, or resuming the session, worked.
- **Running tests:** `router_run` refuses outside role sessions, so run tests with `npx vitest run <files>` and `npm run typecheck` in the shell.
- **Probe files:** QA delegates left probe files (`test/unit/__qa*`) behind several times. Check `git status --short` after every QA and delete them.
- **Parallel agents:** they share this one worktree. Give each one a disjoint file list, and stage only explicit paths (`git add -- <paths>`).
- **Flaky under full-suite load, green alone:**
  - `test/unit/exec.test.ts`
  - `test/integration/depth-guard-wiring.test.ts`
  - `test/integration/ladder-effort-wiring.test.ts`
  - `test/integration/ladder-wiring.test.ts`
  - `test/integration/routing-ladder-resume.test.ts`
  - `test/unit/v2-hooks.test.ts`
  - `test/unit/roles.runtime.test.ts`
  - `test/unit/run-tools.test.ts`
  - `test/integration/modeA-e2e.test.ts`

## Map of the change

- **P0, verification engine:**
  - `src/verify/{gate,dispatch,wiring,pending,tree,head,branch,reference}.ts`
  - `src/index.ts` (artefact threading, `noteWriter`, deferred switch)
  - `src/compat/v2-hooks.ts` (tier `subagent` child ID)
  - `src/routing/wire/dispatch.ts` and `src/router/sessions.ts` (roles lineage)
- **P1:**
  - `src/router/{config,roles-config,role-agents,git-tools,dispatch-header,protocol}.ts`
  - `src/routing/classify/{route-line,types}.ts`
  - `src/routing/roles/{admission,read-set,policy,binding}.ts`
  - `src/routing/wire/{dispatch,working-set}.ts`
  - `src/compat/v2-hooks.ts` (read set, refusals, D13 lift)
  - `src/verify/perimeter.ts` (perimeter)
- **Main tests:**
  - `test/integration/{branch-switch,branch-switch-deferred,unattributed-writers,change-root-threading,perimeter,roles-dispatch,roles-authority,v2-tier-child}.test.ts`
  - `test/unit/{admission,head,branch,gate,baseline,reference,working-set,route-line.roles,roles.runtime}.test.ts`
