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
    (release 2.7.0), no upstream yet. Your session must run here.
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
| **Working directory (plan home, integration worktree)** | `D:\git\omr-cpx-main`, branch `cpx/main`, from `origin/master` `b716ee9` (release 2.7.0), **no upstream** (unset on purpose, so a bare `git push` cannot target `master`; 0.P.1 runs `push -u origin cpx/main`). Its `.git` is a file: `gitdir: D:/git/opencode-model-router/.git/worktrees/omr-cpx-main`. |
| **Base repository directory (main checkout) — OFF-LIMITS** | `D:\git\opencode-model-router`, local `master` at `71dcfab` ("docs(design): add cross-repo work design for roles mode"), 1 commit ahead of and 6 behind `origin/master` on 2026-10-10. Another implementation is in progress there. Its working tree was clean when the plan file was moved out of it. |
| Plan (binding) | `D:\git\omr-cpx-main\docs\plans\critical-path-execution-plan.md`, **untracked**, committed by 0.P.1 |
| This handover | `D:\git\omr-cpx-main\docs\plans\critical-path-execution-handover.md`, **untracked**, committed by 0.P.1 |
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
  `Writes:`/`Reads:` line, tool argument or shell command names it.

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

Anchors come from `b7984b3`; the base is `b716ee9`. 0.P.4 re-bases them.

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

**Next action:** 0.P.3.

**Worktrees:** working (plan home) `D:\git\omr-cpx-main` (branch `cpx/main`); phase worktrees in flight: none.
Base repository directory `D:\git\opencode-model-router` is off-limits (§0.13); so is the other implementation's
worktree `D:\git\opencode-model-router-cross-repo` (branch `feat/cross-repo`, seen in `git worktree list` on
2026-10-10).

| Phase | State | QA round | Notes |
|---|---|---|---|
| 0.P | running | — | started 2026-10-10; 0.P.1 done |
| 0.1 | waiting | — | |
| 1.1 · 1.2 · 1.3 · 1.4 | waiting | — | |
| 2.1 | waiting | — | |
| DF-1 | waiting | — | |
| 2.2 · 2.3 · 2.4 | waiting | — | |
| 3.1 · 3.2 | waiting | — | |
| 4.1 · 4.2 | waiting | — | |
| 5.1 | waiting | — | |
| DF-2 | waiting | — | |
| 6.1 · 6.2 | waiting | — | |

**In-flight dispatches** (role, session id, worktree, `Writes:`/`Reads:`): none.

**Plan base / `origin/master` sync:** `b716ee9` (fetched 2026-10-10 by 0.P.1; `origin/master` unchanged, no merge).

**Router build in use:** not yet recorded (0.P.3.f).

**Plugin-entry scope and revert command:** not yet recorded (0.P.3.f).

**Amendments:** none.

**Takeovers (§0.14-2):** none.

**Dogfood faults:** none.
