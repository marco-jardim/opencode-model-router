# Handover — execute the Critical-Path Execution plan

This file is the starting point for the session that implements
`D:\git\omr-cpx-main\docs\plans\critical-path-execution-plan.md`. The plan is binding. This file:
- gives the kickoff prompt;
- records where everything is;
- restates the owner's execution rules;
- passes on the troubleshooting notes from the planning session (2026-10-10).

It is also the plan's live handover file (§0.11): the orchestrator keeps §7 ("Live state") current.

---

## 0. Kickoff prompt (paste this to start the next session)

```
You are the orchestrator executing the plan
D:\git\omr-cpx-main\docs\plans\critical-path-execution-plan.md
end to end, from Pre-flight 0.P to Phase 6.2 (PR merged into master, dogfood left). Read the plan's header, §0
and §3 in full first, then this handover:
D:\git\omr-cpx-main\docs\plans\critical-path-execution-handover.md (sections 1-7). Read each later phase of the plan
when you reach it, not all at once (the plan is ~4,300 lines).

Environment:
- The work happens in a git worktree OUTSIDE the base repository directory:
  - working directory (the plan's home): D:\git\omr-cpx-main, branch cpx/main, created from origin/master b716ee9
    (release 2.7.0), no upstream yet [historical: 0.P.1 set it to origin/cpx/main]. Your session must run here.
  - base repository directory (main checkout): D:\git\opencode-model-router. It holds ANOTHER implementation in
    progress (local master 71dcfab). It is off-limits: never read, write, run commands, check out, stash or pull
    there, and never push to master except through the final PR (plan §0.13).
  - every phase works in its own worktree D:\git\omr-cpx-p<id>; dogfood builds in D:\git\omr-cpx-dogfood-df<n>;
    create them with `git -C D:\git\omr-cpx-main worktree add …` (plan §0.6-2, §0.12).
- Platform win32, shell pwsh 7 (not bash). Temp dir: C:\Users\Marquinho\AppData\Local\Temp\opencode.

Rules (plan §0 and §0.14 are binding; these matter most):
1. Iterate continuously, phase after phase, wave after wave. Stop ONLY for a blocking or critical problem (an
   ambiguity counts only when it blocks all reasonable progress; otherwise take the recommended option, record it
   and continue). Planned human actions (restarts for the dogfood switches) are not stops.
2. If the model-router blocks you repeatedly (verbose, circular or off-target output from a less capable agent,
   zero-tool-call hand-backs, budget exhaustion on the same task, NEED MORE/ESCALATE loops), take over momentarily
   and do the blocked read or implementation yourself. You are a top-tier model, extremely intelligent and capable.
   Log the takeover in the handover, then go back to delegating.
3. Pre-flight check before every phase. Fix everything it finds; if a finding is scheduled for a later phase in the
   plan, only document it ("deferred by plan").
4. QA is always a heavy tier task. Always apply this rule. After every phase, delegate to heavy QA an adversarial
   senior-engineer review of the work done. Fix every finding of rounds 1 and 2. After the 2nd QA round on the same
   implementation, fix only blocking, critical and major findings, and do not keep re-reviewing until the findings
   run out (plan §0.7).
5. Always delegate through the model-router, preferring atomic tasks. Coding goes to implementer roles; complex
   coding (concurrency, state machines, git invariants, races) may be pinned [tier:heavy]. Give heavy the heavy lift
   and have lighter dispatches run the tests and collect the results, and apply mechanical fixes. Gather context with
   explorer before any heavy dispatch and paste it in. CAP:none needs a `reason:` line in the same dispatch.
6. Never run the full suite unless the plan requires it (only the Phase 6.2 pre-flight; CI runs it on the PR). Test
   only what the change touches, and accelerate those runs (parallel scoped runs, high worker counts) — plan §0.6-9.
7. Commit often: the orchestrator commits each finished, verified task (plan §0.3), conventional commits, push right
   away. No AI attribution and no Co-Authored-By trailer, in any commit, PR, code comment or doc.
8. Linear is not used by this project (checked 2026-10-10). There is no GitHub issue for this plan; if the owner
   opens one, add `Refs #<n>` and comment at each wave boundary.
9. Talk to the human in Portuguese (short, direct, no flattery). Code, docs, commits, QA reports and PRs are in
   English.

Start now with Pre-flight 0.P (order: 0.P.1 → 0.P.3 → 0.P.6 → 0.P.2 → 0.P.4 → 0.P.5 → QA).
```

---

## 0b. Resume kickoff for a fresh session (DF-1 onward, written 2026-10-12)

Launch (new pwsh, NEW session — no `-s`):
`$env:OPENCODE_CONFIG_DIR = "$env:LOCALAPPDATA\omr-cpx\opencode-config"; $env:OPENCODE_V2_BIN = "C:\Users\Marquinho\AppData\Local\omr-cpx\bin\opencode2-2.0.26\opencode.exe"; & $env:OPENCODE_V2_BIN --standalone D:\git\omr-cpx-main`

Paste:
```
You are the orchestrator of D:\git\omr-cpx-main\docs\plans\critical-path-execution-plan.md (binding). Read
D:\git\omr-cpx-main\docs\plans\critical-path-execution-handover.md first: §2 (operating rules), §4 (troubleshooting) and
§7 (live state; the "NEXT ACTION" paragraph is authoritative). Then the plan's section "Dogfood switch DF-1" (≈line 2050)
and, after DF-1, "Wave 3" (≈line 2819). Read later phases only when you reach them.

Environment: working directory D:\git\omr-cpx-main (branch cpx/main). Platform win32, shell pwsh. Never read or write
D:\git\opencode-model-router, D:\git\opencode-model-router-cross-repo or D:\git\omr-cpx-dogfood-* (dogfood worktrees:
read-only script runs only). Talk to the owner in Portuguese; code, docs, commits, QA reports in English.

State: Wave 2 (2.1-2.4) is done and merged. DF-1 switch prepared (tag cpx/df1 = 226d967, worktree
D:\git\omr-cpx-dogfood-df1, config copy points at it, pendingTtlMs override set). This session was launched on the df1
build. Start with DF1.4.a (run-scoped self-check: fresh nonce, run id, loading-plugin set, entrypoint
file:///D:/git/omr-cpx-dogfood-df1/server.ts, 2.0.26 executable, one router_verify tool), then DF1.4.b-h, DF1.5
(dogfood.md), DF1.QA (heavy), fixes, then Wave 3 (3.1 ∥ 3.2) with pre-flight, implementation, heavy QA per phase.
If the self-check fails: revert per §7 and stop.

Owner rules: iterate continuously; stop only for blocking/critical problems. Pre-flight before every phase (fix what it
finds; document what the plan schedules later). QA is always heavy: rounds 1-2 fix every finding; after round 2 fix only
blocking/critical/major; round 3 only when round 2 had majors, bounded to those fixes. Delegate through the model-router
roles with atomic tasks; heavy coding may be pinned [tier:heavy]; lighter dispatches run tests. Take over briefly when the
router keeps blocking (log it). Commit often, push, Conventional Commits, no AI attribution or Co-Authored-By anywhere.
Progress goes to GitHub issue #109 (comment at each phase/wave boundary; `Refs #109` in commits). Linear is not used.

Operational lessons (do not re-derive):
- router_run cannot run vitest with file args: implementers write tests, the orchestrator runs them in its shell:
  `npx vitest run --maxWorkers=14 <files>`. Never the full suite (only the 6.2 pre-flight). Coverage:
  `npx vitest run --coverage --coverage.include=<file> <tests>`; uncovered-branch lister: %TEMP%\opencode\uncov.mjs.
- Every dispatch says "alternate one read, one edit" and names its first 2-3 calls (read guard denies a 4th read).
- Pass the file-ownership split explicitly when two implementers share a worktree; prefer one writer per worktree.
- Smokes run only in the orchestrator shell: first `Remove-Item Env:OPENCODE_CONFIG_DIR -ErrorAction SilentlyContinue`,
  then OPENCODE_V2_BIN=%LOCALAPPDATA%\omr-cpx\bin\opencode2-2.0.26\opencode.exe, OMR_SMOKE_EVIDENCE_DIR=$env:TEMP\omr-evidence,
  RUN_OC_SMOKE_CPX=1, `npx vitest run --config vitest.smoke.config.ts test/smoke/<file>` (or the npm scripts). v1 smokes:
  prepend %LOCALAPPDATA%\omr-cpx\bin\opencode-1.18.35 to PATH. scoop removed 2.0.26/1.18.35: never `scoop update opencode*`.
- Real-host smokes are timing-sensitive: repeat a failing scenario isolated and at the pre-change commit (scratch
  worktree with a node_modules junction) before blaming the product.
- Kill stray vitest processes before a rerun that writes the same log file.
- Subagent outputs can be recovered from %USERPROFILE%\.local\share\opencode\opencode.db (session/part tables, node:sqlite read-only).
- Pre-existing: routing-engine smoke scenario 5-advisor (PF-4). Deferred minors: see each phase report.
```

## 1. Where things are

| What | Where |
|---|---|
| **Working directory (plan home, integration worktree)** | `D:\git\omr-cpx-main`, branch `cpx/main`, from `origin/master` `b716ee9` (release 2.7.0). Upstream `origin/cpx/main` since 0.P.1 (it had none at plan time, on purpose, so a bare `git push` could not target `master`). Its `.git` is a file: `gitdir: D:/git/opencode-model-router/.git/worktrees/omr-cpx-main`. |
| **Base repository directory (main checkout) — OFF-LIMITS** | `D:\git\opencode-model-router`, local `master` at `71dcfab` ("docs(design): add cross-repo work design for roles mode"), 1 commit ahead of and 6 behind `origin/master` on 2026-10-10. Another implementation is in progress there. Its working tree was clean when the plan file was moved out of it. |
| Plan (binding) | `D:\git\omr-cpx-main\docs\plans\critical-path-execution-plan.md`, committed by 0.P.1 (`d6a6610`); amendments committed in `D:\git\omr-cpx-main` |
| This handover | `D:\git\omr-cpx-main\docs\plans\critical-path-execution-handover.md`, committed by 0.P.1 (`d6a6610`) |
| Orchestrator session | Moved to `D:\git\omr-cpx-main` on 2026-10-10. After any restart, continue the same session there. |
| Worktrees to be created | Phases: `D:\git\omr-cpx-p<id>` (branch `cpx/p<id>`, base tag `cpx/p<id>-base`). Dogfood: `D:\git\omr-cpx-dogfood-df<n>`. Probes: `D:\git\omr-cpx-scratch`, `D:\git\omr-cpx-e2e`. Dogfood fixes: `D:\git\omr-cpx-pdf<n>-<k>`. All are created from `cpx/main` with `git -C D:\git\omr-cpx-main …`, all sit outside the base directory, under `D:\git\`. |
| QA reports | `D:\git\omr-cpx-main\docs\qa\critical-path-execution\`: `preflight.md`, `phase-<id>.md` (written in the phase worktree), `dogfood.md`, `global.md` |
| ADR | `D:\git\omr-cpx-main\docs\adr\0007-critical-path-execution.md` (Phase 0.1) |
| Reference plans (same conventions, already executed) | `D:\git\omr-cpx-main\docs\plans\delegation-depth-and-effort-bump-plan.md` and its handover; `D:\git\omr-cpx-main\docs\plans\verification-resource-budget-handover.md` §4 (shell, harness, processes, git safety, CI) |
| Tracking | Linear: not used. GitHub: no issue yet. The final PR is the record. |

**Every dispatch** gives the delegate its worktree as working directory and names the base directory only to forbid
it. Example ENVIRONMENT line:
`Working directory is D:\git\omr-cpx-p12 (git worktree of the opencode-model-router repository, branch cpx/p12; the plan's home is D:\git\omr-cpx-main). Platform: win32. Shell: pwsh. Paths are absolute. You are already here; do not ask for permission to read or write inside it. Never read or write D:\git\opencode-model-router.`

---

## 2. Operating rules (summary; the plan's §0 and §0.14 are binding)

- **Iterate continuously**, and stop only for blocking or critical problems (§0.1).
- **Take over momentarily** when the router blocks you repeatedly (§0.14-2):
  1. Re-dispatch once with an explicit instruction to attempt the work.
  2. If it still fails, do it yourself.
  3. Log the takeover and go back to delegating.
- **Pre-flight before each phase:** fix everything it finds. A finding the plan schedules for a later phase is
  documented as "deferred by plan" (§0.7).
- **QA is always a heavy tier task. Always apply this rule.** Run an adversarial heavy review after every phase,
  including 0.P, DF-1 and DF-2, plus the global review (6.2).
  - Rounds 1 and 2: fix every finding.
  - After round 2: fix only `blocking`, `critical` and `major` findings, with no review to exhaustion (§0.7).
- **Delegate atomically through the router.** Implementers code; heavy takes complex coding, design and every QA;
  explorer gathers context; runner runs the tests. Split the heavy lift from the test runs (§0.14-3).
- **Parallelism with file safety** (§0.6):
  - one owner per file (§3.2);
  - one worktree per phase;
  - phases start as soon as their dependencies are merged;
  - serial merges by the orchestrator only;
  - never two writers on a file, never a read of a file under edit.
- **Tests:** scoped to what changed and accelerated. The full suite runs only in the 6.2 pre-flight (§0.6-9).
- **Commit often**, push immediately, conventional commits (§0.3).
- **Full paths everywhere** (prefix `D:\git\omr-cpx-main\`, substituted to the dispatch's worktree, §0.4). The only
  exception is command-line arguments.
- **Never touch `D:\git\opencode-model-router`** (§0.13). Before every dispatch, check that no `root=`, `cwd:`,
  `Writes:`/`Reads:` line, tool argument or shell command names it. The guard compares normalized paths (case-folded,
  `/` → `\`, prefix match) and has one scope list (plan §0.4 as amended by QA-0.P-10/-20): the main checkout and
  `D:\git\opencode-model-router-cross-repo` are never touched; `D:\git\omr-cpx-dogfood-*` is never a `root=`, `cwd:`,
  `Writes:` or a write target (read-only script runs allowed). Prose and log-search patterns are allowed.

---

## 3. Background you need (do not re-derive)

### 3.1 What the plan builds

1. **Background-first dispatch** on OpenCode v2 (Phases 1.1–2.1):
   - long dispatches return at once;
   - every router guarantee runs at child completion: budget and authority annotations, deferred and required
     verification, change-set capture, timing;
   - per-turn router state moves out of the system prompt into a tail, so the orchestrator's prompt cache survives;
   - pending verifications survive restarts;
   - file leases: one writer per file, no read under another agent's edit.
2. **A plan executor** (Phases 1.4, 2.2–5.1):
   - compiles any plan (annotated or not) into a durable ledger (DAG);
   - launches ready tasks in parallel into isolated worktree slots, verifies them, and integrates them through a
     serial queue into an always-green integration branch;
   - phase suites with culprit bisection;
   - an automated QA → fix loop, adaptive capacity per provider, an inbox for questions, restart recovery.
3. **Dogfood (§0.12):**
   - DF-0 (0.P.6) pins the router build;
   - DF-1 (after 2.1) switches the running host to the plan's build;
   - DF-2 (after 5.1): the executor itself runs Phase 6.1 of this plan;
   - G13 measures it by time window.

### 3.2 Why (the evidence, re-verified in 0.P.4)

- Every role dispatch is forced to the foreground: `D:\git\omr-cpx-main\src\compat\v2-hooks.ts`, `nativeArgs` ≈78-87
  and `roleForeground` ≈1604. A dispatch the user backgrounds loses verification and annotations (early return
  ≈1746-1761).
- The pending list and late notices are pushed into the system prompt (`D:\git\omr-cpx-main\src\index.ts`
  ≈3057-3074). This breaks the cache whenever they change.
- `router_run` blocks the caller, with a 600 s timeout.
- Nothing records dispatch durations.
- A plan is a flat list keyed by line numbers.

Anchors come from `b7984b3`; the base is `b716ee9`. 0.P.4 re-based them: `src\verify\reference.ts` is the only anchored file that changed between the two (table in §7; QA-0.P-21).

### 3.3 Host facts gathered during planning (Phase 0.1 pins them; do not trust them blindly)

- **OpenCode v2 background subagents:**
  - the host answers at once with `{status: "running", sessionID}`;
  - on completion, `SubagentCompletion.deliver` calls `sessions.synthetic` on the parent, which wakes an idle parent;
  - pending notifications are persisted in KV;
  - `Session.background(sessionID)` moves running work to the background.

  (anomalyco/opencode dev, `packages/core/src/session/`.)
- **The plugin session API** offers `get`, `prompt`, `synthetic`, `context`, `interrupt`, `move` and `remove`, but no
  `create`. The router already launches children outside LLM tool calls through the native `subagent` tool with a
  retained context (`D:\git\omr-cpx-main\src\compat\v2-client.ts` ≈96-242). That is contract C14, launcher A.
- **Anthropic prompt caching:**
  - read costs 0.05× base for Opus and Sonnet 5.5; a write costs 1.25× (5 min TTL) or 2× (1 h TTL);
  - the TTL is refreshed on every hit;
  - invalidation follows the order tools → system → messages;
  - a mid-conversation system message keeps the cache on Opus, Sonnet and Haiku 5.5;
  - cache reads do not count toward ITPM.
- **OpenCode v2 Anthropic lowering** supports 5 m and 1 h cache buckets per part. Whether a plugin can set them is
  unverified (C6).
- **uv** hardlinks from its cache only when the cache is on the same drive (set `UV_CACHE_DIR` on `D:`). pnpm
  imports clone → hardlink → copy on Windows. Never share `node_modules` or `.venv` across worktrees: workspace links
  and editable installs load another checkout's code.

### 3.4 Review history of the plan

The plan went through five adversarial [tier:heavy] review rounds, about 180 findings in total, all fixed. See the
"Plan QA record" at the end of the plan. These owner directives were added during planning:
- run on its own implementation (dogfood, §0.12);
- a dedicated worktree, because another implementation is in progress (§0.13);
- the execution rules of §0.14 (this handover's kickoff rules).

---

## 4. Troubleshooting notes from the planning session

### 4.1 Model-router and delegation

- **Work-root binding sticks to a session.**
  - What happens: a role session's work root is bound at its first dispatch. Resuming that `sessionID` keeps the old
    root, even when the new prompt's route line says `root=…`.
  - Seen: after the planning session moved to `D:\git\omr-cpx-main`, a resumed reviewer was refused every read
    ("outside this dispatch's work root D:\git\opencode-model-router").
  - Fix: start a NEW dispatch, with `root=<worktree>` on its route line, whenever the target worktree changes.
- **New worktrees need authority.** A worktree created after OpenCode started gets role authority (read, write and
  run) only through a `routing.workRoots` glob in the global override, or after a restart
  (`D:\git\omr-cpx-main\docs\ROLES.md` ≈179-193). 0.P.3.c sets it up. If a delegate is refused in a new worktree,
  check this first.
- **No shell for `agent: fast` here.**
  - Seen: a git dispatch to `fast` came back `ESCALATE` with zero tool calls ("tools are read-only").
  - What worked: the orchestrator's own shell tool, for git (worktree, commit, push, merge, tag), `npm ci`, `npx`
    and `gh`.
  - 0.P.3.d re-checks this. If you have no shell either, that is a stop.
- **Budget exhaustion is not failure.**
  - Seen: big edit batches (about 45 edits) stopped twice at the implementer's 120-call budget with
    `NEED MORE: budget`.
  - What worked: resuming the SAME `sessionID` with "continue and finish". Do not start a new task; that loses its
    context.
  - Keep batches atomic, about 20 edits or one module.
- **Foreign `[acceptance]` blocks.**
  - What happens: the router takes the first `[acceptance]` block in a dispatch prompt as that dispatch's DoD.
  - Seen: pasting plan text that contained 6.1.2's block (`cwd: D:\git\omr-cpx-p61`) produced
    `UNVERIFIED: cwd … outside this role dispatch's work root`.
  - Fix: put the dispatch's own block first, and never paste another task's block with its tags.
- **False-refusal suspects.** A hand-back with zero tool calls is untested, not a capability limit. Re-dispatch the
  same `sessionID` with "attempt it now: call Read on <full path>". Two failures → take over (§0.14-2).
- **Budgets for recon.** Use `CAP:none` with a `reason:` line for wide recon. Explorers still stopped once at their
  tool-call budget (40) → resume. The orchestrator itself has about 2 direct read-only calls per turn, except under
  the takeover rule.
- **Path labels can lie.**
  - Seen: the environment block once said `D:\git\Claude-model-router` while the enforced root was
    `D:\git\opencode-model-router`.
  - Fix: trust `git rev-parse --show-toplevel` and the router's refusal messages.
- **Cost doctor** reported two child sessions with "binding: unknown". These were the resumed sessions after the
  directory move. It is informational only.

### 4.2 Commands and tests

- **`router_run`**:
  - runs only allowlisted `package.json` scripts and `routing.run.commands` entries;
  - refuses `npx`;
  - has a default timeout of 600 s;
  - allows no `\` in arguments (use repo-relative forward-slash paths);
  - needs `cwd`.

  The shipped `test-files` entry accepts `test/*` paths and `--maxWorkers=*`. Smoke suites, coverage, `npm ci` and
  long runs go through your shell.
- **`node_modules` is absent in a fresh worktree.** Run `npm ci` first, one worktree at a time (npm-cache
  EBUSY/EPERM on Windows). The host typings (`@opencode/plugin`, `@opencode/client`) exist only after `npm ci`.
- **Smoke tests need `OPENCODE_V2_BIN`** (an absolute path) and, from Phase 0.1 on, `OMR_SMOKE_EVIDENCE_DIR`.
  Otherwise the routing smoke rewrites tracked evidence files
  (`D:\git\omr-cpx-main\test\smoke\helpers\routing-host.ts` ≈1070).
- **`scripts\routing-stats.ts`** needs Node ≥ 22.18 and reads the default store unless `--dir` is given. It is the
  orchestrator's stand-in for `/router stats`, which is a user-only slash command. The orchestrator cannot type slash
  commands, so use `router_plan` actions and shell scripts instead.
- **Pending TTL:** the key is `verify.pendingTtlMs`, read at plugin start (DF1.2 sets 24 h for the dogfood probes).
- **Windows flakes** (#88 history): EBUSY on temp-dir cleanup while a spawned process still has that directory as
  its cwd. Use `D:\git\omr-cpx-main\test\helpers\remove-dir.ts`. Timing tests use virtual clocks. A failure that
  vanishes on an isolated rerun (`--maxWorkers=1`) is a flake to record and fix, never to skip.
- **Fast scoped tests:**
  - list the tests of the touched files (the test named after the source, or whose `describe` targets it, plus the
    tests that import a changed non-hub module);
  - run independent scoped runs in parallel across worktrees;
  - use high worker counts for scoped runs;
  - `--pool=threads` / `--no-isolate` only for pure-unit files, after checking
    `D:\git\omr-cpx-main\vitest.config.ts` (setup files, the home-guard);
  - smoke suites stay serialized (`fileParallelism: false`).

### 4.3 Git and isolation

- **`D:\git\omr-cpx-main\.git` points into the main checkout's `.git`.** The executor home
  (`<git common dir>\omr-executor\`) therefore lives there. Reach it only through `router_plan`
  (`status`/`export`/`purge`), never by path.
- **Never run `git worktree prune`** (it could remove another implementation's stale entries), and never `gc`. Remove
  only worktrees this plan created, with `git worktree remove`.
- **Ref namespaces** of this plan: `cpx/*` (branches and tags) and `omr/<planId>/*` (executor). Before creating a
  ref, check that it does not exist.
- **The other implementation** (cross-repo work design for roles mode) will likely land changes on `origin/master`
  that touch the same hubs (`D:\git\omr-cpx-main\src\compat\v2-hooks.ts`, role work roots). Expect conflicts at
  `origin/master` syncs (§0.6-10). Resolve them in `D:\git\omr-cpx-main`, record an amendment when design is
  affected, and re-run the affected phases' QA.

### 4.4 Known risks to watch

- **Host contracts with fallbacks** (Phase 0.1): C4/C15 (no held results → required verification stays foreground),
  C5 (tail placement → G4 may be unattainable), C6 (1 h TTL), C14 (launcher A vs B). A fallback is a decided branch,
  not a failure. Only a contradiction that no fallback covers is a stop.
- **Dogfood switches need the owner:** consent at 0.P.3.f, then restarts at DF-0 (if needed), DF-1, DF-2 and 6.2.5.
  - Prepare each so the owner only restarts OpenCode, continues this session in `D:\git\omr-cpx-main`, and types
    `continue`.
  - Before each restart, write the exact revert command into §7 and show it to the owner.
  - Prefer a plugin-entry scope that leaves the other implementation's sessions alone (§0.12-2).
- **The session runs ON the build it edits after DF-1.** Phase worktrees never feed the running host; only
  `D:\git\omr-cpx-dogfood-df<n>` does. If a dogfood build misbehaves, roll back (§0.12-6) instead of debugging live.
- **Subscriptions with unknown rate limits:** at most 4 dispatches in flight per provider, 2 of them heavy, with
  halving on 429 (§0.6-11). Rate and usage limits are never stops.

---

## 5. Kickoff sequence

1. Read the plan's header, §0 (all of it, including §0.12–§0.14) and §3, then this handover.
2. **0.P.1:**
   - verify the worktree state: `git status` shows only this plan and this handover, untracked;
   - fetch, and fast-forward `cpx/main` if `origin/master` moved past `b716ee9`;
   - run `npm ci`;
   - add the plans README entry;
   - commit the plan, the handover and the README, then `push -u origin cpx/main`.
3. **0.P.3:** environment, configuration and authority (`routing.workRoots`; project-layer roles mode; `test-files`;
   dogfood scope and owner consent). This is one stop at most, listing every missing item.
4. **0.P.6:** DF-0 pin if the router loads from a moving working tree. Then 0.P.2 (scoped baseline), 0.P.4 (re-base
   anchors), 0.P.5, and heavy QA.
5. **Wave 0:** Phase 0.1 (host contracts and ADR 0007). Then Wave 1 phases in parallel as their dependencies allow,
   then 2.1 → DF-1 → the rest of Wave 2, then Waves 3–5 → DF-2 (the executor runs 6.1) → 6.2.
6. At every dispatch boundary, update §7. Commit it at every merge and every 10 updates. During the DF-2 freeze,
   write to `$env:LOCALAPPDATA\omr-cpx\handover-df2.md` instead.
7. Send the final report to the human in Portuguese, with the PR link, G1–G13 status, the dogfood numbers, and the
   reminder to pull `master` when the other implementation allows and to restart OpenCode.

## 6. When to stop and ask (only these)

- **A critical problem:**
  - a security regression;
  - data-loss risk in a repository, worktree or ref;
  - any effect on `D:\git\opencode-model-router` or on the other implementation;
  - a change to v1 behaviour;
  - a corrupted git state with no known-good commit to restore.
- **A blocking problem:**
  - a host contract that no fallback covers;
  - §0.8 recovery exhausted (3 attempts, then heavy, then 2 more);
  - a blocking or critical QA finding still open after the bounded rounds;
  - an ambiguity that blocks all reasonable progress.

Everything else is work: resolve it, record it, continue.

---

## 7. Live state (§0.11 — keep current)

**NEXT ACTION (2026-10-12 ≈16:45): fresh session on an isolated session DB, then resume Wave 3.** Why: DF-1.1-3
(`dogfood.md`) — the owner's scoop OpenCode 2.0.27 `serve --service` shares `~/.local/share/opencode/opencode.db`, boots
every project in it and drained this plan's sessions with the base build; the owner keeps working on other
implementations, so the plan now runs on its own data/state dirs (owner decision 2026-10-12).
- **Launch (new; replaces the one below):** close the plan's window, then in a new pwsh:
  `$env:OPENCODE_CONFIG_DIR = "$env:LOCALAPPDATA\omr-cpx\opencode-config"; $env:XDG_DATA_HOME = "$env:LOCALAPPDATA\omr-cpx\xdg-data"; $env:XDG_STATE_HOME = "$env:LOCALAPPDATA\omr-cpx\xdg-state"; $env:OPENCODE_V2_BIN = "C:\Users\Marquinho\AppData\Local\omr-cpx\bin\opencode2-2.0.26\opencode.exe"; & $env:OPENCODE_V2_BIN --standalone D:\git\omr-cpx-main`
  then paste the kickoff prompt of §0b with "NEXT ACTION (≈16:45)" as the starting point. `opencode debug paths` with
  these variables gives data/log/db under `%LOCALAPPDATA%\omr-cpx\xdg-data\opencode`, state under `xdg-state`, config =
  the process-scoped copy (checked). `auth.json`, `account.json`, `mcp-auth.json` copied there (re-copy if a login
  expires). **The files are not enough on v2:** the active provider connection lives in `opencode.db` table `credential`.
  With an empty table, opencode-anthropic-fix loads but does not take over `anthropic` (`lib\host\v2.mjs` ≈79-104,
  `managed` needs an active credential with `methodID` `opencode-anthropic-fix`), so the native transport sends the
  OAuth token and every turn fails with `Your credit balance is too low` (runs `07c4890a`, `3e7551fc`, `0b4f83a8`,
  `0f7045b4`). Fixed 2026-10-12 ≈18:20 (orchestrator takeover: roles cannot write outside the work root), with no
  isolated 2.0.26 process running: the shared DB's active credential `cred_108ab2d13001yBMlonTsRHUSlx` and the kv
  marker `migration.v1-v2` were copied into the isolated DB (`quick_check` ok). Script:
  `%TEMP%\Claude\copy-credential.mjs`. Backup: `%LOCALAPPDATA%\omr-cpx\db-backup-20261012-pre-credential`. If the
  `[anthropic] ... could not be resolved` warning or the credit error comes back, use `/connect` → Anthropic → "Claude
  Pro/Max (multi-account)" in the isolated session (the script refuses to run once an `anthropic` row exists). The isolated server also boots the location `C:\Users\Marquinho`, so each
  plugin loads twice; record it as a deviation in the self-check (QA-DF1-13). The host log for self-checks is now `%LOCALAPPDATA%\omr-cpx\xdg-data\opencode\log\opencode.log`; subagent
  outputs are in that directory's `opencode.db`. Still shared with the owner's servers: the router's pending journal
  (`~/.local/state/opencode-model-router`, guarded by the DF-1-10 beats) and the outcome dir under `%TEMP%`.
- **First steps in the new session:** (1) run-scoped self-check against the new log (df1.1 entrypoint, 2.0.26, one
  load per location; expect no `D:\git\opencode-model-router` location now); (2) DF-1.1-1 fix (background grader runs
  with the role's agent: record the caller's agent in `CallRecord` at decide, `src\compat\v2-hooks.ts` ≈2727, and use it
  in the background/held finish wrappers ≈2932/≈2952; root cause in `dogfood.md`), as fix phase `pdf1-2`, then
  `cpx/df1.2`; (3) Wave 3: `D:\git\omr-cpx-p31` @ `7f375f3` has WIP `schedule.ts` (+test), `capacity.ts` (impl done, test
  placeholder; decisions listed by implementer `ses_ece758056ffewdDJqblIpj8yCs` in this session's history — inbox
  severity `info`, taskId null, floor renewals, metric `until`, capacityView WeakMap, onMetric errors propagate),
  `expand.ts` (partial) — finish 3.1.2-3.1.4 per `phase-3.1.md`; `D:\git\omr-cpx-p32` @ `c7df8d6` has the complete 3.2.1
  memo (run V1-V8 first; V1 true). DF-1.1 re-probes c passed, d passed with DF-1.1-2 (duplicate turn rows per module
  copy, fix in `pdf1-2`), e fails until opencode-anthropic-fix#42 is merged.
- **Revert:** as below; drop the two XDG variables to return to the shared DB.
- **Self-check (2026-10-12 18:22, fresh session on the isolated DB):** nonce `omr-selfcheck-c41e9a07b3d2`, run
  `c39fd4cd` in `%LOCALAPPDATA%\omr-cpx\xdg-data\opencode\log\opencode.log`: `cli starting version=2.0.26`; locations
  `D:\git\omr-cpx-main` and `C:\Users\Marquinho` (deviation QA-DF1-13, known), no `D:\git\opencode-model-router`
  location; per location the loaded plugins are {`opencode-anthropic-fix`, `omr-cpx-dogfood-df1.1`} (telegram absent,
  the recorded baseline difference); router entrypoint `file:///D:/git/omr-cpx-dogfood-df1.1/server.ts`; one
  `router_verify` tool. **Pass.** Provider turns work (credential fix holds). The session was started with the
  §0 kickoff prompt; the orchestrator resumed from this NEXT ACTION instead of re-running 0.P (done 2026-10-10).
- **In flight (18:30):** fix phase `pdf1-2` created (`D:\git\omr-cpx-pdf1-2`, branch `cpx/pdf1-2`, tag
  `cpx/pdf1-2-base` = `b452dea`, `npm ci` done); explorer `ses_ece005aeaffe2vkqwiYeU6Grv0` (DF-1.1-1/-2 recon, R only).
  Wave 3: p31 implementers 3.1.2 `ses_ecdffdc99ffemfi24BJRhggi5C` (W `schedule.ts` + test), 3.1.3
  `ses_ecdffab07ffeTDH3rknizw7W4E` (W `capacity.ts` + test), 3.1.4 `ses_ecdff6ed1ffeBXU36iCqBmtU3b` (W `expand.ts` + test);
  p32 implementer 3.2.2 + V2-V8 `ses_ecdff07afffeZ3PYj1J2dNUrcQ` (W `integrate\checks.ts`, exports in `verify\runner.ts`,
  `verify\slot.ts`).
- **Progress (18:40):** p31: 3.1.2 `1ed3bac` (43 tests), 3.1.3 `7ebcff7` (47; test fixed by the orchestrator: a "future"
  instant equal to now), 3.1.4 `8129e1f` (30; expected needs order fixed to the canonical `shell,edit`). Router verdicts
  for these were FAIL/UNVERIFIABLE only from cross-writer contamination in the shared worktree; verified independently
  (scoped vitest + `tsc --noEmit`). p32: 3.2.2 `d22c9ba` (V1-V8 true; memo name mismatches: `diffNames` not
  `diffNameStatus`, no `Logger` in types — local structural one). pdf1-2: DF-1.1-2 `7026208` (326 tests), DF-1.1-1
  `3add1e5` (`callerAgent` on CallRecord/holds/journal; process-wide claims registry; 9 files 536 green). In flight:
  DF-1.1-1 e2e tests `ses_ecdfe09a6ffeMGnvsNK1wSzy70` (W `test\helpers\v2-bg-host.ts`, the two v2-background tests),
  3.2.3 `ses_ecdf84ce9ffeiY9wIfIxfw89cK` (W `integrate\queue.ts`), 3.1.5 `ses_ecdf80bd8ffeyBecf1KQWEe3AT` (W `launch.ts`,
  `v2-client.ts`, `binding.ts`, their tests).
- **Progress (18:50):** pdf1-2 e2e tests `c8a2782` (85 green). 3.1.5 `899559d` (130 green; one ordering test awaited
  "prompted"). 3.2.3 `c6e6b93` (tsc clean; tests in 3.2.6). pdf1-2 QA round 1 (heavy reviewer
  `ses_ecdf2665affeWpa09Pka5hipSy`): 9 findings (1 major QA-PDF12-1 old-entry fallback; minors -2..-6; nits -7..-9), all
  being fixed: A `ses_ecde49833ffeB6QJ3P9dWdhhr5` [tier:heavy] (W `src\compat\{v2-hooks,background,v2-client}.ts`, v2
  background tests, helper) for -1/-2/-5/-6/-7/-9; B `ses_ecde4683affevrB19VMMzc8n6t` (W `timings.ts`, its test,
  `CHANGELOG.md`) for -3/-4/-8. In flight Wave 3: 3.1.6 `ses_ecded6271ffe2CdyUJ3Qx8P3CD` (W `runtime.ts`), 3.2.4
  `ses_ecde5881bffeulfqr317KFYVDP` (W `phase-suite.ts`, `bisect.ts`), 3.2.5 `ses_ecde55d3affeYnsX1ugioHtVgp` (W `land.ts`).
- **Progress (19:05):** pdf1-2 QA fixes B `41158dc` (422 green). 3.2.5 `f49ec35`, 3.2.4 `b8a110f`, 3.1.6 `b00d5e0` (tsc
  clean; tests in 3.2.6/3.1.8). Deviation: the 3.1.6 implementer ran the full `test` script through router_run (330 s,
  35 timeouts/failures, no baseline) against the plan's scoped-test rule; runtime.ts is imported by nothing, so no
  attribution; later dispatches say "router_run typecheck only". In flight: 3.2.6 unit `ses_ecddf99f8ffe9MdfUHeXEBV3QO`,
  real-git `ses_ecddf6e4affeIYzoSyo9Cyj5Nk`; 3.1.7 `ses_ecdde066fffe5ybmYFw3oy0i7a` waiting for a lease.
- **Dogfood fault DF-1.1-4 (to record in `dogfood.md`):** the 3.1.7 implementer (root `D:\git\omr-cpx-p31`) was
  refused an edit of `D:\git\omr-cpx-p31\src\compat\v2-hooks.ts` because the pdf1-2 fixer
  `ses_ecde49833ffeB6QJ3P9dWdhhr5` (root `D:\git\omr-cpx-pdf1-2`) holds a lease on its own worktree's `v2-hooks.ts`:
  leases collide across worktrees (keyed by repo-relative path, or by the common git dir, instead of the tree). Plan
  §0.6 assumes one worktree per phase is isolation enough. Workaround: serialize hub-file writers across worktrees.
  Fix candidate for `pdf1-2` round 2 or a later fix phase (lease key must include the work tree).
  QA-PDF12 round 2 root cause: `repositoryIdentity` returns the common git dir as `repo`
  (`src\router\git-tools.ts:960/:969`), `keyOfIn` keys writes `r:${repo}\0${rel}` (`src\router\leases.ts:474`); ADR
  0007 D7 says "keyed by repository". Minimal fix: v2-hooks `repoKeyOf` seam (≈1678) returns `{repo: id.tree, tree:
  id.tree}`; needs a D7 amendment (repository-wide keys only for plan-task holders), CHANGELOG wording, a v2 test with a
  real `git worktree add` (`test\integration\v2-leases.test.ts:124-136` never used real git). **Deferred by decision to
  its own fix phase after Wave 3** (touches 3.1's lease wiring). Until then: hub-file writers serialized across worktrees.
- **Progress (19:30):** pdf1-2 QA r1 fixes `acc6728` + `a702885` (622/623 then 19/19 after a test-premise fix by the
  orchestrator); QA r2 (`ses_ecdd4be53ffeRBnheWrUeEH1E3`): no blocking/critical, minors -10..-13, nits -14/-15, all
  being fixed (`ses_ecdbda6feffe5Pznwl5j9WSNcp`). 3.1.7 `2330b88` (nullable executor; enablement belongs to 5.1;
  open: retry stop has no writable host field, no sync RouteResolver, no executor decision-row writer, DispatchBookkeeping
  lacks planId). 3.2.6 unit tests + `revertMessage` fix `d01ff2c` (163 green). Real-git test file uncommitted: 19/25
  green, 5 queue-settle timeouts suspected from the `kick()` lost-wake gap (fix in flight) + 1 assertion.
- **Progress (20:05):** pdf1-2 QA r2 fixes `e62b115` (501 + 856 green); **pdf1-2 merged into `cpx/main` as `92f09d1`**
  (12 files 856 green, tsc clean); tag `cpx/df1.2` = `92f09d1` pushed; worktree `D:\git\omr-cpx-dogfood-df1.2`
  (detached, `npm ci` done, clean). Config copy switched to df1.2 (regenerated from the global `opencode.json`, router
  entry only; directory entries and hard-linked hashes checked equal; previous copy saved as
  `%LOCALAPPDATA%\omr-cpx\opencode.json.df1.1.bak`). **Deviation DF-1.2-1:** the running 2.0.26 server hot-reloaded the
  config at 23:02:16Z and loaded `file:///D:/git/omr-cpx-dogfood-df1.2/server.ts` twice (one per location) in the SAME
  run `c39fd4cd`, without an owner restart; a background dispatch in flight then (3.2.6b `ses_ecddf6e4affeIYzoSyo9Cyj5Nk`)
  vanished from the in-flight list and was resumed. Plan §0.12 assumed a switch needs a restart; it does not on this host.
  Rollback = restore the `.df1.1.bak` copy (also hot). DF-1.2 probes still owed (DF-1.1-1 re-probe: a background `d=none`
  dispatch's grader must not be denied — the QA dispatches since 23:02 are the probe). p31: 3.1.7 `2330b88`, 3.1.8
  `f4a59e9` + `e9699c3` (runtime.ts dispose no longer waits on a live child; retry hook only with a built executor);
  414 green. p31 coverage below gate (runtime 64.7 branches, launch 88.2, expand 86.6): top-ups in flight
  `ses_ecda3f914ffecrInDmoj6twQ26` (runtime test), `ses_ecda3de14ffeip6TaGO8Wk009l` (launch/expand tests). p32: `kick()`
  fix `9b81022` (165 unit green); real-git file still 19/25.

*(superseded)* **NEXT ACTION (2026-10-12 ≈16:30): DF-1.1 re-switch — waiting for the owner restart; then the DF-1.1 self-check and
re-probes (DF1.4.a with `df1.1`, c runner criterion, d, e), then Wave 3.** `cpx/pdf1-1` merged into `cpx/main` as
`9fa7607` (DF1.QA rounds 1-3 closed; record in `dogfood.md`). Tag `cpx/df1.1` = `9fa7607`, pushed. Worktree
`D:\git\omr-cpx-dogfood-df1.1` (detached at `cpx/df1.1`, `npm ci` done, clean). Switch: the copy
`$env:LOCALAPPDATA\omr-cpx\opencode-config\opencode.json` regenerated from the current global `opencode.json`, only the
router entry changed to `D:\\git\\omr-cpx-dogfood-df1.1`; directory entries match the global ones except the 0.P.3.f
exclusions (`.git`, backups `*.bak*`, `opencode - Copia pre v2.json`, `rich-footer-backup-*`, lock/`nul` files);
hard-linked files equal their originals. Override `pendingTtlMs` unchanged. Launch: the command below with
`-s ses_ecf5bd114ffe5QT3S5xVTAQcF4`. Revert: drain holds (`router_verify pending:true`), set the copy's router entry back
to `D:\\git\\omr-cpx-dogfood-df1`, relaunch. Wave 3 is prepared: design memos 3.1.1 and 3.2.1 in
`$env:TEMP\omr-evidence\memo-3.1.md` / `memo-3.2.md` (to paste into `phase-3.1.md` / `phase-3.2.md`); worktrees
`p31`/`p32` are created from `cpx/main` @ `9fa7607` after the restart. Unjudged handles `vrf_e7dbd395…`,
`vrf_8bd03f89…`, `vrf_ef89f090…` (pdf1-1 fixes): the router never judged them (gate timeout / slot busy); verified
independently by the orchestrator (`dogfood.md`); they expire with the restart.

*(superseded)* **NEXT ACTION (2026-10-12 ≈12:45): fix phase `pdf1-1` → re-switch `cpx/df1.1`, then Wave 3.** DF-1 ran on `cpx/df1`
(server run `27717102`, orchestrator session `ses_ecf5bd114ffe5QT3S5xVTAQcF4`): DF1.4.a/b/f/h pass, c (runner
criterion)/d/e re-probe on `cpx/df1.1`; faults DF-1-1..DF-1-11 and DF1.QA round 1 (15 findings, all dispositioned) in
`docs\qa\critical-path-execution\dogfood.md`. The plan continues on df1 under the **binding workaround** recorded
there (resumes and `d=none` producers in the foreground; `⚠ UNVERIFIED` is unverified whatever `verdict=` says;
ignore `lost in restart` for a dispatch still listed in flight). `pdf1-1`: worktree `D:\git\omr-cpx-pdf1-1`, branch
`cpx/pdf1-1`; H1 (DF-1-3 + DF-1-4, implementer `ses_ecf494a78ffeIBjqCOSUjN2KxX`) and the DF-1-2 test refresh
(`ses_ecf48defcffeiMPXtA1KqK8UAC`, uncommitted) in flight; DF-1-5/-6 analysis done (architect
`ses_ecf48a2c7ffeywA7V8TN9lyjYW`); then DF-1-9, DF-1-10, QA-DF1-12, DF-1-1 hardening, DF1.QA round 2.

*(superseded)* **DF-1 self-check (2026-10-12 ≈11:50).** Wave 2 is done and merged (2.1 `bc0df8a` + smoke-harness follow-up `226d967`; 2.2 `ded2e88`; 2.3 `9b44413`; 2.4 `6eaf7f0`; amendments A-2.1-1..A-2.4-1). DF-1 pre-flight on `cpx/main` @ `226d967`: typecheck green; scoped tests of 2.1-2.4 green; `smoke:cpx` 56/56 (after `cpx/p21f`: the contract probes C3/C13 read the router's `<router-state>` tail as the caller's last message — harness fix, no product change); `smoke:v2` 2/2; `smoke:v1` 27 pass / 11 skipped on 1.18.35 (no failure); `router_verify pending:true` → nothing pending; `dogfood.md` baseline `5370e76`. Tracking issue: GitHub #109.
- DF1.1: tag `cpx/df1` = `226d967`, pushed.
- DF1.2: worktree `D:\git\omr-cpx-dogfood-df1` (detached at `cpx/df1`, `npm ci` done). Switch: `$env:LOCALAPPDATA\omr-cpx\opencode-config\opencode.json` regenerated from the current global `opencode.json`, only the router entry changed `D:\\git\\opencode-model-router` → `D:\\git\\omr-cpx-dogfood-df1`; hard-linked files re-checked against the global originals (all equal), top-level entries unchanged. Override `D:\git\omr-cpx-main\.opencode\opencode-model-router.overrides.jsonc` = `{ "enforcement": { "verify": { "pendingTtlMs": 86400000 } } }` (git-ignored; DF2.4.a removes it).
- DF1.3 launch (owner): close this window, then in a new pwsh:
  `$env:OPENCODE_CONFIG_DIR = "$env:LOCALAPPDATA\omr-cpx\opencode-config"; $env:OPENCODE_V2_BIN = "C:\Users\Marquinho\AppData\Local\omr-cpx\bin\opencode2-2.0.26\opencode.exe"; & $env:OPENCODE_V2_BIN --standalone -s ses_ed82f88a7ffej5iKaRHuwIa6fd D:\git\omr-cpx-main` and type `continue`.
- Revert (last build that passed its self-check = df0): in `$env:LOCALAPPDATA\omr-cpx\opencode-config\opencode.json` set the router entry back to `D:\\git\\omr-cpx-dogfood-df0`, then relaunch with the command above.
- After the restart: DF1.4.a-h probes (scratch worktree `D:\git\omr-cpx-scratch`, branch `cpx/scratch-df1`), DF1.5 record in `dogfood.md`, DF1.QA (heavy), then Wave 3 (3.1 ∥ 3.2).

**Update 2026-10-12 ≈08:40:** 2.2, 2.3 and 2.4 merged into `cpx/main` (coverage top-ups, reports, M1-M10, amendments A-2.2-1/A-2.3-1/A-2.4-1 in `8439081`). 2.1 round-1 fixes in progress in `D:\git\omr-cpx-p21` (uncommitted; dispatch A done, dispatch B running). Lesson: `router_run` refuses vitest with file arguments (package scripts take no arguments; `vitest`/`npx` not allowlisted) — implementers write tests, the orchestrator runs them. The host restarted twice this morning; the AGENTS.md source flipped between the process-scoped config and the global one (reported to the owner).

**Next action (paused 2026-10-11 ≈11:30 for an owner shutdown; resume with the fan-out below):** Wave 2 in flight. All four phase branches are pushed and clean: `cpx/p21` @ `bc0a9b4`, `cpx/p22` @ `073e5bf`, `cpx/p23` @ `6d1c994`, `cpx/p24` @ `0b73acc`. `cpx/main` @ this commit.

**Resume fan-out (dispatch in parallel, one message; every dispatch says "alternate one read, one edit"):**
1. **2.1 — QA round 1 DONE** (13 findings: 2 critical, 7 major, 4 minor; recorded in `phase-2.1.md` Findings on `cpx/p21`). Resume with the round-1 fix dispatches (split by file: A = `src\index.ts` + `src\verify\*` for -1, -4, -5, -7, -9, -11 producer exclusion, -12 v1 notices; B = `src\compat\background.ts` + `v2-hooks.ts` + `pending.ts` journal for -2, -3, -6, -8, -10, -11 cache/wording, -13; docs part of -12), then QA round 2, then rerun `cpx-background` smoke.
2. **2.2 — close the phase:** QA rounds 1–3 done (r1 14, r2 9, r3 1 major QA-2.2-24 fixed in `073e5bf`). Orchestrator: write `phase-2.2.md` Findings/Fixes/Deferred/Handoffs/Verdict (A1-3a rolled-back exemption + 3.2 `resume()` handoff; E_LOCK_LOST = unknown outcome; per-epoch snapshot names `ledger.<epoch>.json`, `events.<first>.<epoch>.jsonl`, beat files; plan 2.2.2.b text amendment A-2.2-1), measure coverage (ledger.ts ≥ 90 branches), merge into `cpx/main`.
3. **2.3 — close the phase:** QA rounds 1–3 done (r1 17, r2 15, r3 1 major QA-2.3-33 fixed in `6d1c994`). Orchestrator: re-measure coverage of `src/executor/compile/*.ts` (last: estimate branches 81, index 86, parse 88 — top-up tests were added after; if any file < 90, one more tests-only push), write `phase-2.3.md` (approved extensions: ownership fallback as `inferred` + `ownership-assumed`, other-worktree new files, synchronous addTasks; handoffs: 3.1.4 path rewrite, 4.2 fixTemplate, 3.2 `.post` phases), merge.
4. **2.4 — close the phase:** QA rounds 1–3 done (r1 21, r2 9, r3 1 major QA-2.4-31 fixed in `0b73acc`). Remaining: coverage of `provision.ts` (89.95 branches) and `pool.ts` (re-measure) ≥ 90 — tests-only push; `## Measurements` M1–M10 in `phase-2.4.md` (M4 recorded: git clean did not follow a junction here); write the report (handoffs: 3.1 passes `trustedSlotsDirs`, LeaseService after `acquire`, `pool.close()`; 3.2 detached slots, `branchForce` with CAS); `npm run smoke:cpx:provision` (needs `py -3` with pytest — installed `--user`) then merge.
5. **After the merges:** ADR/plan amendments for Wave 2 in `cpx/main` (A-2.1-1 memo §15 decisions, A-2.2-1, A-2.3-1, A-2.4-1), CHANGELOG `[Unreleased]` for 2.1 (v2 background dispatch, held results, leases, `routing.background.*`, `routing.leases.*`), full `smoke:cpx` + `smoke:keyless` + `smoke:v1` (v1 smokes with OpenCode 1.18.35 first on PATH), then **DF-1** (dogfood switch; owner restart) and Wave 3.

**Session ids worth resuming (if the host kept them):** 2.1 fixers `ses_ed4e80b99ffeXBvANNxkTAYv3E` (smoke debug), `ses_ed52eedd8ffeqZGXqHcrcKhiY6` (D1–D6); 2.3 coverage `ses_ed5073436ffeO0sghh9IZsv43C`; 2.4 coverage `ses_ed4d09b82ffeev34Qgn4lmBrLM`. Memos are recorded in each `phase-2.x.md`; subagent outputs can also be recovered from `%USERPROFILE%\.local\share\opencode\opencode.db` (`session_message`/`part` by `session_id`).

**Orchestrator session:** `ses_ecf5bd114ffe5QT3S5xVTAQcF4` since the DF-1 restart (fresh session, DF-1-11; before it: `ses_ed82f88a7ffej5iKaRHuwIa6fd`), directory `D:\git\omr-cpx-main`.

**Worktrees:** working (plan home) `D:\git\omr-cpx-main` (branch `cpx/main`, upstream `origin/cpx/main`); dogfood
`D:\git\omr-cpx-dogfood-df0` (detached at `cpx/df0` = `b716ee9`, loaded by the plan's host); phase worktrees in
flight: `D:\git\omr-cpx-p21`, `p22`, `p23`, `p24` (Wave 2; all pushed and clean at the pause). Done and merged: `p01`, `p11`, `p12`, `p13`, `p14` (kept until the end; never edit). Base repository directory `D:\git\opencode-model-router` is off-limits (§0.13); so is the other
implementation's worktree `D:\git\opencode-model-router-cross-repo` (branch `feat/cross-repo`).

| Phase | State | QA round | Notes |
|---|---|---|---|
| 0.P | **done** 2026-10-10 ≈20:45 | 3 (r1: 14, r2: 9, r3: 1 — all fixed or dispositioned; 7 minor/nit deferred to the DF-1 pre-flight) | started 18:55; `preflight.md` verdict: done |
| 0.1 | **done** 2026-10-11 ≈06:20 | 3 (r1: 16, r2: 13, r3: 2 major — all fixed; r3 minors recorded) | D5 withdrawn (C6 `all`: tools breakpoint keeps 5 min); final gate 1× by owner decision: smoke:cpx 52/52 at `915b96a`, smoke:keyless = baseline; merged `915b96a` |
| 1.1 | **done** 2026-10-11 | 3 (r1: 17, r2: 9, r3: 1 major — fixed) | merged `d4d731b`; 2.1 handoff in `phase-1.1.md` |
| 1.2 | **done** 2026-10-11 | 3 (r1: 13, r2: 6, r3: clean) | merged `a9e32c1`; cache-prefix smoke and routing-engine 2/4 green on 2.0.26 |
| 1.3 | **done** 2026-10-11 | 3 (r1: 17, r2: 17, r3: clean) | merged `6d310eb` |
| 1.4 | **done** 2026-10-11 | 3 (r1: 20, r2: 11, r3: 3 major — fixed) | merged `12d42b7`; contract addenda A1–A3 in `phase-1.4.md` |
| 2.1 | **done** 2026-10-12 | 3 (r1 13, r2 19, r3 2 major — all fixed; round-3 minors deferred) | merged `bc0df8a`; follow-up `cpx/p21f` merged `226d967` |
| DF-1 | **open** 2026-10-12: df1 loaded and self-checked (DF1.4.a); c/d/e re-probe on `cpx/df1.1` | 1 (15 findings, all dispositioned; round 2 after `pdf1-1`) | tag `cpx/df1` = `226d967`; record in `dogfood.md`; fix phase `pdf1-1` |
| 2.2 | **done** 2026-10-12 | 3 (r1 14, r2 9, r3 1 major — fixed) | merged `ded2e88`; ledger.ts 96.01 branches after top-up `fe3a178` |
| 2.3 | **done** 2026-10-12 | 3 (r1 17, r2 15, r3 1 major — fixed) | merged `9b44413`; estimate 97.5 / index 92.46 branches after top-up `ca5cb81` |
| 2.4 | **done** 2026-10-12 | 3 (r1 21, r2 9, r3 1 major — fixed) | merged `6eaf7f0`; M1-M10 measured (all constants kept); `smoke:cpx:provision` 4/4 |
| 3.1 · 3.2 | waiting | — | |
| 4.1 · 4.2 | waiting | — | |
| 5.1 | waiting | — | |
| DF-2 | waiting | — | |
| 6.1 · 6.2 | waiting | — | |

**In-flight dispatches** (role, session id, worktree, `Writes:`/`Reads:`): Wave 2 pre-flight (see the phase reports).

**Plan amendments since A-0.1-2:** A-0.1-3, A-1.1-1, A-1.2-1, A-1.3-1, A-1.4-1 (logged in the plan's Plan QA record "Amendment log"). Wave 1 dispatch details are in each phase report (session ids per task and QA round).

**Owner decisions 2026-10-11:** proceed to Wave 1 while 0.1 round-2 follow-ups finished; 0.1 final gate reduced to one `smoke:cpx` run.

**Lessons (Wave 1):** the router's read guard denies reads after 3 consecutive non-producing actions — every dispatch says "read, edit, read"; v1 smokes (`smoke:keyless`, `smoke:v1`) must run with OpenCode 1.18.35 first on PATH (a run without it fails 18 tests, all environmental).

**Dispatch log** (local time, 2026-10-10). *QA-0.P-19:* until now times were not taken at dispatch boundaries; the
host log does not record child sessions, so each row gives bounds from the git commit times; from now on the
orchestrator takes `Get-Date` at every dispatch start and end.
| Start → end | Role | Session | Worktree | Writes / Reads | Result |
|---|---|---|---|---|---|
| after the 0.P.2 rerun → before 19:08:13 (`7e6903f`) | implementer | `ses_ed8271885ffegiA4OlgFaJZA4W` | `D:\git\omr-cpx-main` | W: `test\unit\v2-hooks.test.ts` / R: same | done, verified deterministic, `7e6903f` |
| after 19:47:09 (`d39a700`) → before 20:03:23 | reviewer (heavy, QA-0.P r1) | `ses_ed7ffbdc8ffe4mtPc6Vrr3VI5Y` | `D:\git\omr-cpx-main` @ `d39a700` | W: none / R: `D:\git\omr-cpx-main\` | 14 findings |
| after r1 → before 20:03:23 (`9c8efd6`) | implementer (QA-0.P-3) | `ses_ed7f25ed7ffe2aF7jc1XBiILR2` | `D:\git\omr-cpx-main` | W: `test\unit\v2-hooks.test.ts`, `test\unit\roles.registration.test.ts` / R: same | `9c8efd6`, reverted `674f037` (it lowered a 60 s describe timeout) |
| after 20:07:20 (`add3cd4`) → ≈20:15 | reviewer (heavy, QA-0.P r2) | `ses_ed7ed7507ffeGyZbT2YjMmOSjj` | `D:\git\omr-cpx-main` @ `add3cd4` | W: none / R: `D:\git\omr-cpx-main\` | 9 findings |
| ≈20:18 → before 20:26:39 (`46dac26`) | implementer (QA-0.P-17) | `ses_ed7dd3c29ffeOXxyWz6FDP0VQs` | `D:\git\omr-cpx-main` | W: `test\smoke\deferred-catalog.smoke.test.ts` / R: same, `test\smoke\registration.smoke.test.ts` | done, verified deterministic, `46dac26` |
| after 20:30 (`093ade6`) → ≈20:36 | reviewer (heavy, QA-0.P r3) | `ses_ed7d93d91ffeKN16UPoxY33h3p` | `D:\git\omr-cpx-main` @ `093ade6` | W: none / R: `D:\git\omr-cpx-main\` | 15/16/17 fixed; 1 new major (QA-0.P-24, fixed) |
| 20:38 → 20:43 | explorer (0.1 pre-flight) | `ses_ed7d1437fffefP40S5OZKDZqXM` | `D:\git\omr-cpx-p01` | W: none / R: harness files | anchors, harness facts |
| 20:45 → 20:50 | implementer (0.1.0) | `ses_ed7caa421ffe2GuCUQq18En3n1` | `D:\git\omr-cpx-p01` | W: `routing-host.ts`, `cpx-scripted-provider(.test).ts` | `06e9840`; provider tests 22/22 |
| 20:50 → 20:55 | implementer (0.1.1) | `ses_ed7c5ff2dffeQKgDuOStO4Kr40` | `D:\git\omr-cpx-p01` | W: `test\smoke\probe\cpx-probe-plugin.js` | `b996991` |
| 20:55 → 21:19 | implementer (0.1.2, 4 resumes) | `ses_ed7c16461ffeBRBUvVmPUV3FQ6` | `D:\git\omr-cpx-p01` | W: `cpx-host-contract.smoke.test.ts`, `package.json`, probe (C14) | C1-C15 observed on 2.0.26 |

The DF-0 run-scoped self-check (marker `omr-selfcheck-7f3a91c2d4`, server executable) ran between 19:47 and 20:07.

**Plan base / `origin/master` sync:** `b716ee9` (fetched 2026-10-10 by 0.P.1; `origin/master` unchanged, no merge).

**Environment:**
- 2026-10-12: scoop upgraded OpenCode to 2.0.27 / 1.19.0 and removed 2.0.26 / 1.18.35. Verified copies (npm sha512 for 2.0.26; scoop manifest sha256 `c90d248c…` for 1.18.35) live in `%LOCALAPPDATA%\omr-cpx\bin\`; every path below points there. Do not `scoop update` until the plan ends.
- `OPENCODE_V2_BIN` = `C:\Users\Marquinho\AppData\Local\omr-cpx\bin\opencode2-2.0.26\opencode.exe` (v2.0.26, the version under test).
  Not set at user scope (removed by QA-0.P-8); set in the launch command and per orchestrator shell run.
- **Every orchestrator smoke shell** first runs `Remove-Item Env:OPENCODE_CONFIG_DIR -ErrorAction SilentlyContinue`
  (QA-0.P-17: the plan's host exports it; OpenCode 1.18.35 merges it additively, so a smoke host would load the
  dogfood router as a second router). This per-shell removal is the only mitigation: the harness fix `46dac26` was
  reverted (`9943abe`) because `test\smoke\deferred-catalog.smoke.test.ts` is v1-frozen (scenario `6-v1-untouched` of
  `test\smoke\routing-engine.smoke.test.ts` pins it to `bd1ecd1`).
- OpenCode 1.x: `C:\Users\Marquinho\AppData\Local\omr-cpx\bin\opencode-1.18.35\opencode.exe`. Every v1-host smoke (`smoke:v1`,
  `smoke:keyless`) runs with `C:\Users\Marquinho\AppData\Local\omr-cpx\bin\opencode-1.18.35` prepended to `PATH` (QA-0.P-7).
- Scoped test workers: `--maxWorkers=14` (16 cores).
- Smoke evidence: every smoke run sets `OMR_SMOKE_EVIDENCE_DIR=$env:TEMP\omr-evidence`.
- Global override has `routing.workRoots` `D:/git/omr-cpx-main`, `D:/git/omr-cpx-p*`, `D:/git/omr-cpx-pdf*`,
  `D:/git/omr-cpx-scratch*`, `D:/git/omr-cpx-e2e*` (backup `$env:LOCALAPPDATA\omr-cpx\overrides.backup.jsonc`).
  *QA-0.P-15:* registration re-runs at plugin start **and at every refresh after a config-file change**, so the edit
  is already live in this server and reached every other running router (the background service and the other
  implementation's server) at their next prompt. Effect there: their role agents' max policy now also allows
  `D:\git\omr-cpx-*` as an external directory (no other change; told to the owner). Any further global-override edit
  (DF-2 pre-flight executor keys) is announced to the owner first.

**Router builds that passed their self-check:** `cpx/df0` (`b716ee9`, `D:\git\omr-cpx-dogfood-df0`, server run
`461f3bf1`, 2026-10-10); `cpx/df1` (`226d967`, `D:\git\omr-cpx-dogfood-df1`, server run `27717102`, 2026-10-12 —
self-check passed; known faults DF-1-3/-4/-10 under the binding workaround in `dogfood.md`). In use now: df1, through
the process-scoped config. Rollback target for `cpx/df1.1`: df1.

**Plugin-entry scope, launch and revert (0.P.3.f):** process-scoped (§0.12-2 option 1). Config directory
`$env:LOCALAPPDATA\omr-cpx\opencode-config` (files hard-linked and directories junctioned from
`C:\Users\Marquinho\.config\opencode`, except `opencode.json`, a copy whose router entry is the dogfood worktree).
Global `opencode.json` unchanged (backup `$env:LOCALAPPDATA\omr-cpx\opencode-config.backup`).
- **Launch (every DF-n restart; versioned executable, QA-0.P-9):** close the plan's OpenCode window, then in a new pwsh:
  `$env:OPENCODE_CONFIG_DIR = "$env:LOCALAPPDATA\omr-cpx\opencode-config"; $env:OPENCODE_V2_BIN = "C:\Users\Marquinho\AppData\Local\omr-cpx\bin\opencode2-2.0.26\opencode.exe"; & $env:OPENCODE_V2_BIN --standalone -s ses_ecf5bd114ffe5QT3S5xVTAQcF4 D:\git\omr-cpx-main`
  and type `continue` (QA-DF1-5: the live orchestrator session since DF-1; a fresh session instead is a deviation to record).
- **Switch (QA-0.P-14/-23):** regenerate `$env:LOCALAPPDATA\omr-cpx\opencode-config\opencode.json` from the current
  global `opencode.json`, changing only the router entry to `D:\\git\\omr-cpx-dogfood-df<n>[.<k>]`; mirror the global
  directory's current top-level entries (new files hard-linked, new directories junctioned, removed ones removed, same
  exclusions as 0.P.3.f); re-check every hard-linked file's hash against its global original (re-link any that
  differ); record it here.
- **Revert (QA-0.P-11/-18):**
  - *Back to before DF-0 only:* close the plan's window, then `Remove-Item Env:OPENCODE_CONFIG_DIR -ErrorAction SilentlyContinue; opencode -s ses_ed82f88a7ffej5iKaRHuwIa6fd D:\git\omr-cpx-main`
    (global config; loads the main checkout's moving build).
  - *After DF-1 or later:* first drain held verifications (`router_verify pending:true`; a build cannot release another
    build's holds), then set the copy's router entry back to the **last build that passed its self-check** (list
    above) and relaunch with the launch command (§0.12-6).

**DF self-check (amended 0.P.6, QA-0.P-6/-9/-16/-18):** run `Write-Output omr-selfcheck-<fresh literal nonce>`; take the
`run=` id of the newest `spawning process` line carrying it in `C:\Users\Marquinho\.local\share\opencode\log\opencode.log`
(shared by every server); in that run the `loading plugin` ids equal the regenerated config's plugin list, once per booted location (list the
locations; any location outside the plan's worktrees is a deviation, QA-DF1-13),
router entrypoint exactly `file:///D:/git/omr-cpx-dogfood-df<n>[.<k>]/server.ts`; the server process executable is the
2.0.26 path above; exactly one `router_verify` tool. DF1.4.a and DF2.4.0 are amended to use it. DF-0 result: run
`461f3bf1` — plugins {`D:\\git\\omr-cpx-dogfood-df0`, `D:\\git\\opencode-anthropic-fix`}; the config also lists
`D:\\git\\opencode-telegram-plugin`, which no server on this machine loads (same before the switch) — recorded as the
expected baseline difference for later switches.

**Owner consent (0.P.3.f):** **Granted 2026-10-10** ("autorizo tudo"): DF-1 and DF-2 restarts, dogfood spend,
process-scoped config.

**Re-based anchors (0.P.4; `b7984b3` → `b716ee9`; `src\verify\reference.ts` is the only anchored file that changed):**
| Plan location | At `b7984b3` | At `b716ee9` |
|---|---|---|
| §1.1 D10 | ≈71-78 | ≈71-78 |
| Phase 2.1 (reference GC at plugin start) | ≈2052 | ≈2120 |
| Phase 2.2 pre-flight (`--git-common-dir`) | ≈2056 | ≈2124 |
| Phase 2.4 pre-flight | ≈236-238 · ≈346-356 · ≈859-907 · ≈1296 · ≈1663-1673 · ≈1764-1845 | ≈245-247 · ≈366-376 · ≈885-935 · ≈1324 · ≈1691-1701 · ≈1792-1886 (drift region rewritten by #88: `driftDiff`, `driftReasons`) + new step 7b ≈1913-1953 |

**QA round counters:** 0.P: closed after round 3 (QA-0.P-24 fixed in plan 0.P.6; QA-0.P-25..31 deferred to the DF-1
pre-flight, listed in `preflight.md` "Deferred findings").

**Amendments:**
1. QA-0.P-1/-15 — plan 0.P.3.c: scratch/e2e `workRoots` are globs; global-override edits are live at the next prompt of
   every running router and are announced to the owner.
2. QA-0.P-6/-9/-16/-18 — plan 0.P.6, DF1.4.a, DF2.4.0 (and their Reads lines), Wave-6 fallback, 2.1.5.f: run-scoped
   self-check (fresh nonce, plugin-set equality, exact entrypoint, versioned server); rollback to the last passing
   build; the 2.1.5.f line is supporting evidence only.
3. QA-0.P-10/-20 — plan §0.4: the pre-dispatch guard works on normalized paths with one scope list.
4. QA-0.P-15 — DF-2 pre-flight: owner notice before writing the executor keys to the global override.
5. A-0.1-1 (Phase 0.1 pre-flight) — Phases 0.1 and 6.1 write `test\smoke\helpers\cpx-scripted-provider.ts` and its
   test (new) instead of the v1-frozen `scripted-provider.ts` / `scripted-provider.test.ts` (pinned to `V1_BASE_COMMIT`
   `bd1ecd1` by scenario `6-v1-untouched`); `smoke:cpx` also runs the new unit tests. The same pin made `46dac26` a v1
   regression; reverted in `9943abe`.
6. A-0.1-2 (QA-0.1-8) — applies ADR 0007 revision 2026-10-11 to the plan (56 edits: D4 hint, D5 reinstated behind a real-provider gate, C10 branch, D6 `capacity`, D13 range 1–8, launcher A only, D14 guards, D15 wakes, D16 attempt counting, Appendices A–D). Amendment text: the ADR architect dispatch `ses_ed6ed6d71ffe03JQRRB4s1CT2F`; applied by implementer `ses_ed6d74d7effe09Cn074msuezGc`.
7. Recorded deviations (QA-0.P-5): (a) `7e6903f` and `46dac26` wrote test files outside 0.P's write set — pre-flight
   fixes under §0.7 ("fix everything it finds"), done in `cpx/main` while no phase was in flight; `v2-hooks.test.ts`'s
   owning phases (1.2, 2.1, 3.1) inherit the first; `deferred-catalog.smoke.test.ts` is owned by no phase. (b) 0.P.2,
   0.P.4 and the first implementer dispatch ran before the 0.P.6 restart (order 0.P.1 → 0.P.3 → 0.P.6 → 0.P.2 →
   0.P.4), i.e. on the main checkout's unpinned build; their results do not depend on the router build (typecheck,
   vitest, `git diff`), and the dispatch was verified deterministically. (c) The DF-0 self-check criterion was
   re-scoped (amendment 2) and re-run.

**Handoffs:** to Phase 2.1 (owner of `D:\git\omr-cpx-main\docs\ROLES.md`): PF-2 — ROLES.md ≈188-190 says a worktree
created after the plugin started is covered "only by a matching `routing.workRoots` glob (or a restart)"; a refresh
after any config-file change also re-lists worktrees. Exact text to apply: "A worktree created after the role agents
were last registered (at plugin start, or at a refresh after a config change) is covered only by a matching
`routing.workRoots` glob until the next registration."

**Takeovers (§0.14-2):** 0.P.4 anchor re-base and its QA-0.P-2 completion done by the orchestrator in its shell (a
`git diff` and line reads at two commits settled them; plan §0.P lists 0.P steps as orchestrator-shell work).

**Dogfood faults:** none.

**Pre-existing findings:** PF-1 `npm audit` critical ×2 (`seroval` via the devDependency `solid-js@1.9.15`, pinned to the
host typings) — reported to the owner, out of plan scope. PF-2 ROLES.md registration wording (handoff above). PF-3
`D:\git\omr-cpx-main\test\smoke\deferred-catalog.smoke.test.ts` leaked `OPENCODE_*` into its host — fixed in `46dac26`
(QA-0.P-17), then reverted in `9943abe` (v1-frozen file); the leak stays mitigated per shell. `test\setup\smoke-tmp-guard.ts` `keyedSmokeEnv` also passes the environment through (keyed smokes use the
real config on purpose); covered by the per-shell `OPENCODE_CONFIG_DIR` removal. PF-4 `test\smoke\routing-engine.smoke.test.ts` scenario `5-advisor` fails on OpenCode 2.0.26 also at `cpx/p01-base` (checked in a scratch worktree, removed afterwards) — host catalog drift, not caused by this plan; to be fixed by the phase that next owns that smoke, or recorded for the owner.

