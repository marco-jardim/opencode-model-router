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

**Next action:** Wave 2 — pre-flight and design for 2.1, 2.2, 2.3, 2.4 in `D:\git\omr-cpx-p21`…`p24` (branches `cpx/p21`…`cpx/p24`, base tags `cpx/p2x-base` = `558e5b8`). Then DF-1 after 2.1.

**Orchestrator session:** `ses_ed82f88a7ffej5iKaRHuwIa6fd` (directory `D:\git\omr-cpx-main`).

**Worktrees:** working (plan home) `D:\git\omr-cpx-main` (branch `cpx/main`, upstream `origin/cpx/main`); dogfood
`D:\git\omr-cpx-dogfood-df0` (detached at `cpx/df0` = `b716ee9`, loaded by the plan's host); phase worktrees in
flight: `D:\git\omr-cpx-p21`, `p22`, `p23`, `p24` (Wave 2). Done and merged: `p01`, `p11`, `p12`, `p13`, `p14` (kept until the end; never edit). Base repository directory `D:\git\opencode-model-router` is off-limits (§0.13); so is the other
implementation's worktree `D:\git\opencode-model-router-cross-repo` (branch `feat/cross-repo`).

| Phase | State | QA round | Notes |
|---|---|---|---|
| 0.P | **done** 2026-10-10 ≈20:45 | 3 (r1: 14, r2: 9, r3: 1 — all fixed or dispositioned; 7 minor/nit deferred to the DF-1 pre-flight) | started 18:55; `preflight.md` verdict: done |
| 0.1 | **done** 2026-10-11 ≈06:20 | 3 (r1: 16, r2: 13, r3: 2 major — all fixed; r3 minors recorded) | D5 withdrawn (C6 `all`: tools breakpoint keeps 5 min); final gate 1× by owner decision: smoke:cpx 52/52 at `915b96a`, smoke:keyless = baseline; merged `915b96a` |
| 1.1 | **done** 2026-10-11 | 3 (r1: 17, r2: 9, r3: 1 major — fixed) | merged `d4d731b`; 2.1 handoff in `phase-1.1.md` |
| 1.2 | **done** 2026-10-11 | 3 (r1: 13, r2: 6, r3: clean) | merged `a9e32c1`; cache-prefix smoke and routing-engine 2/4 green on 2.0.26 |
| 1.3 | **done** 2026-10-11 | 3 (r1: 17, r2: 17, r3: clean) | merged `6d310eb` |
| 1.4 | **done** 2026-10-11 | 3 (r1: 20, r2: 11, r3: 3 major — fixed) | merged `12d42b7`; contract addenda A1–A3 in `phase-1.4.md` |
| 2.1 | waiting | — | |
| DF-1 | waiting | — | |
| 2.2 · 2.3 · 2.4 | waiting | — | |
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
- `OPENCODE_V2_BIN` = `C:\Users\Marquinho\scoop\apps\opencode2\2.0.26\opencode.exe` (v2.0.26, the version under test).
  Not set at user scope (removed by QA-0.P-8); set in the launch command and per orchestrator shell run.
- **Every orchestrator smoke shell** first runs `Remove-Item Env:OPENCODE_CONFIG_DIR -ErrorAction SilentlyContinue`
  (QA-0.P-17: the plan's host exports it; OpenCode 1.18.35 merges it additively, so a smoke host would load the
  dogfood router as a second router). This per-shell removal is the only mitigation: the harness fix `46dac26` was
  reverted (`9943abe`) because `test\smoke\deferred-catalog.smoke.test.ts` is v1-frozen (scenario `6-v1-untouched` of
  `test\smoke\routing-engine.smoke.test.ts` pins it to `bd1ecd1`).
- OpenCode 1.x: `C:\Users\Marquinho\scoop\apps\opencode\1.18.35\opencode.exe`. Every v1-host smoke (`smoke:v1`,
  `smoke:keyless`) runs with `C:\Users\Marquinho\scoop\apps\opencode\1.18.35` prepended to `PATH` (QA-0.P-7).
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
`461f3bf1`, 2026-10-10). In use now: df0, through the process-scoped config.

**Plugin-entry scope, launch and revert (0.P.3.f):** process-scoped (§0.12-2 option 1). Config directory
`$env:LOCALAPPDATA\omr-cpx\opencode-config` (files hard-linked and directories junctioned from
`C:\Users\Marquinho\.config\opencode`, except `opencode.json`, a copy whose router entry is the dogfood worktree).
Global `opencode.json` unchanged (backup `$env:LOCALAPPDATA\omr-cpx\opencode-config.backup`).
- **Launch (every DF-n restart; versioned executable, QA-0.P-9):** close the plan's OpenCode window, then in a new pwsh:
  `$env:OPENCODE_CONFIG_DIR = "$env:LOCALAPPDATA\omr-cpx\opencode-config"; $env:OPENCODE_V2_BIN = "C:\Users\Marquinho\scoop\apps\opencode2\2.0.26\opencode.exe"; & $env:OPENCODE_V2_BIN --standalone -s ses_ed82f88a7ffej5iKaRHuwIa6fd D:\git\omr-cpx-main`
  and type `continue`.
- **Switch (QA-0.P-14/-23):** regenerate `$env:LOCALAPPDATA\omr-cpx\opencode-config\opencode.json` from the current
  global `opencode.json`, changing only the router entry to `D:\\git\\omr-cpx-dogfood-df<n>[.<k>]`; mirror the global
  directory's current top-level entries (new files hard-linked, new directories junctioned, removed ones removed, same
  exclusions as 0.P.3.f); re-check every hard-linked file's hash against its global original (re-link any that
  differ); record it here.
- **Revert (QA-0.P-11/-18):**
  - *Back to before DF-0 only:* close the plan's window, then `Remove-Item Env:OPENCODE_CONFIG_DIR -ErrorAction SilentlyContinue; opencode -s ses_ed82f88a7ffej5iKaRHuwIa6fd D:\git\omr-cpx-main`
    (global config; loads the main checkout's moving build).
  - *After DF-1 or later:* set the copy's router entry back to the **last build that passed its self-check** (list
    above) and relaunch with the launch command (§0.12-6).

**DF self-check (amended 0.P.6, QA-0.P-6/-9/-16/-18):** run `Write-Output omr-selfcheck-<fresh literal nonce>`; take the
`run=` id of the newest `spawning process` line carrying it in `C:\Users\Marquinho\.local\share\opencode\log\opencode.log`
(shared by every server); in that run the `loading plugin` ids equal the regenerated config's plugin list, once each,
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
