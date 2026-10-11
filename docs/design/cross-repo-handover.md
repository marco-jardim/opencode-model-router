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
| P1: v2 roles cross-repo (P1.1–P1.10) | Done. QA'd twice. Docs updated. **Live dogfood pending.** |
| P2 / P3 / P4 | Not started |

Last checks (HEAD `be7c0b3`):
- `npm run typecheck`: clean.
- Goldens unchanged.
- Full `npx vitest run`: 9 failures in 6 files. Five of those files pass in full when run alone. The sixth, `test/unit/exec.test.ts`, is a known late-sweep timing test that fails under load; its isolated run was not confirmed.

## Next steps

1. **Dogfood P1 live** (needs the restart above, with `repoParents` already set):
   - dispatch a role with `[route class=recon repo=<some repo under D:\git>]` and confirm the work root, the read-provenance line, and a cross-repo read;
   - dispatch an edit into the wrong repository and confirm the located refusal;
   - check the perimeter scope note on a pass, and the I4 refusal when a linked repository changes while `bash` runs.
2. **Open owner decision Q7:** role agents are registered from a catch-all `*: deny`, so D13 cannot open worktrees outside the parents. The fix would turn the generated catch-all into `ask`; the risk is a background child waiting on a prompt. Do not change this without the owner.
3. **Phase 2** (design §7): per-check `cwd=` / `scope=`, consumer checks, pinning of linked repositories (including ignored `dist/`), and deferred verification across the perimeter.
4. **Accepted minors** from the P0 and P1 QA rounds are listed in design §9 ("Known follow-ups"). Revisit them only if they become relevant.

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
