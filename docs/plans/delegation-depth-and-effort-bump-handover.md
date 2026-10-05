# Handover — execute the Delegation Depth (#66) and Effort Bump (#67) plan

This file is the starting point for the session that implements
`D:\git\opencode-model-router\docs\plans\delegation-depth-and-effort-bump-plan.md` (revision 3).
The plan is binding; this handover summarizes it, records the owner's decisions and gives the
troubleshooting notes from the planning session.

---

## 0. Kickoff prompt (paste this to start the next session)

```
You are the orchestrator executing the plan
D:\git\opencode-model-router\docs\plans\delegation-depth-and-effort-bump-plan.md
end to end, from Phase 0.P to Phase 3.4 (release 2.1.0 included). Read it in full first, then read
D:\git\opencode-model-router\docs\plans\delegation-depth-and-effort-bump-handover.md (this handover)
and §4 of D:\git\opencode-model-router\docs\plans\verification-resource-budget-handover.md.

Environment:
- Base repository directory (main checkout, branch master, v2.0.0):
  D:\git\opencode-model-router. Your session's working directory may show D:\git\Claude-model-router;
  it is the same repository. Always write paths in the D:\git\opencode-model-router form.
- All implementation happens in git worktrees OUTSIDE the base directory:
  - merge worktree D:\git\omr-de-main (branch de/main);
  - phase worktrees D:\git\omr-de-p<NN> (branches de/p<NN>).

  Never edit the main checkout before Phase 3.4.
- Platform win32, shell pwsh 7 (not bash). Temp dir: C:\Users\Marquinho\AppData\Local\Temp\Claude.

Rules (the plan's §0 is binding; these are the ones that matter most):
1. Iterate continuously, wave after wave, and stop ONLY for a blocking or critical problem, or an
   ambiguity that only the human can resolve (plan §0.1).
2. If the model-router blocks you repeatedly (verbose, circular or off-target output from a less
   capable agent, zero-tool-call hand-backs, cap exhaustion, NEED MORE/ESCALATE loops), take over
   momentarily and do the blocked read or implementation yourself. You are a top-tier model,
   extremely intelligent and capable. Log the takeover in the run log, then go back to delegating.
3. Pre-flight check before every phase. Fix everything it finds. If a finding is scheduled for a
   later phase in the plan, only document it ("deferred by plan").
4. QA is always a heavy tier task. Always apply this rule. After every phase, delegate to heavy QA an
   adversarial senior-engineer review of the work done. Fix every finding from rounds 1 and 2. From
   round 3 on (a further review of the same implementation), fix only blocking, critical and major
   findings, and do not keep re-reviewing until the findings run out.
5. Always delegate through the model-router, preferring atomic tasks. Coding goes to @medium; complex
   coding may go to @heavy. Give @heavy the heavy lift and have lighter delegations run the tests and
   collect the results (@fast) and apply the mechanical fixes (@medium). Gather context with @fast
   before any @heavy dispatch and paste it in. CAP:none needs a reason: line in the same dispatch.
6. Never run the full suite unless the plan requires it (the per-phase pre-flight, post-merge,
   release). Test only what the change touches, and accelerate those runs (high vitest parallelism,
   threads pool, no-isolate for pure units, concurrent independent runs). Full-suite runs are always
   `npx vitest run --maxWorkers=2`, serialized, one at a time across all worktrees.
7. Commit often: after every green subtask, conventional commits, and push immediately. No AI
   attribution and no Co-authored-by trailer for anyone, in any commit or PR.
8. Update Linear issues only if Phase 0.P finds Linear in use (none was known at planning time).
   GitHub: post a progress comment on #66 and #67 at each wave boundary.
9. Talk to the human in Portuguese (short, direct, no flattery). Code, docs, commits, QA reports and
   PRs are in English.

Start now with Phase 0.P.
```

---

## 1. Where things are

| What | Where |
|---|---|
| Base repository (main checkout, loaded by the live opencode sessions, including yours) | `D:\git\opencode-model-router`, branch `master`, `v2.0.0` (merge commit `46f443f`) |
| Alias of the base directory | `D:\git\Claude-model-router` (`git rev-parse --show-toplevel` → `D:\git\opencode-model-router`) |
| Plan (binding) | `D:\git\opencode-model-router\docs\plans\delegation-depth-and-effort-bump-plan.md` — **untracked** in the main checkout |
| This handover | `D:\git\opencode-model-router\docs\plans\delegation-depth-and-effort-bump-handover.md` — **untracked** in the main checkout |
| Worktrees | **None exist yet.** Phase 0.P creates the merge worktree `D:\git\omr-de-main` (branch `de/main`, from `origin/master`). Phases create `D:\git\omr-de-p11`, `-p12`, `-p13`, `-p21`, `-p22`, `-p23`, `-p31` and `-p32` (branches `de/p<NN>`). All are **outside** the base directory, under `D:\git\`. |
| Wave-base tags | `de/wave-1-base`, `de/wave-2-base`, `de/wave-3-base`: read-only snapshots for cross-phase reads (plan §0.6.3) |
| QA reports and run log | `D:\git\omr-de-main\docs\qa\depth-and-effort\` (`phase-<id>.md`, `global.md`, `run-log.md`) |
| GitHub issues | [#66](https://github.com/marco-jardim/opencode-model-router/issues/66) depth limit, [#67](https://github.com/marco-jardim/opencode-model-router/issues/67) effort bump; context in [#17](https://github.com/marco-jardim/opencode-model-router/issues/17) (closed) |
| Reference plan (same conventions, executed before) | `D:\git\opencode-model-router\docs\plans\verification-resource-budget-plan.md` and `D:\git\opencode-model-router\docs\plans\verification-resource-budget-handover.md`; QA examples in `D:\git\opencode-model-router\docs\qa\verification-resource-budget\` |
| Linear | No known usage (the previous plan's search found none). Phase 0.P re-checks. |

**Every dispatch** gives the delegate both directories: the worktree it works in (its working
directory) and the base directory (for context only, never written). Example ENVIRONMENT line:
`Working directory: D:\git\omr-de-p12 (git worktree of the base repo D:\git\opencode-model-router, branch de/p12). Platform: win32. Shell: pwsh. You are already here; do not ask for permission to read or write inside it. Never write to D:\git\opencode-model-router.`

---

## 2. Operating rules (summary; the plan's §0 is binding)

- **Iterate continuously.** Stop only for blocking, critical, or human-only ambiguity (§0.1).
- **Take over momentarily** when the router blocks you repeatedly (§0.10.2). Re-dispatch once with an
  explicit instruction to attempt the work, then do it yourself, log it, and go back to delegating.
- **Pre-flight before each phase:** fix everything, except findings that the plan schedules later;
  document those (§0.7, §0.10.3).
- **QA is always a heavy tier task. Always apply this rule.** An adversarial heavy review after every
  phase, 0.P and 3.4 included, plus the global review (3.3). Bounded rounds (§0.7): fix everything in
  rounds 1 and 2; from round 3 on, fix only `blocking`, `critical` and `major` findings.
- **Delegate atomically through the router.** `@medium` codes; `@heavy` takes complex coding, design
  and every QA; `@fast` gathers context and runs tests. Split the heavy lift from the test runs.
- **Parallelism with file safety** (§0.6): one owner per file per wave (§2 map), one worktree per
  phase, serial merges by the orchestrator only, cross-phase reads from the wave-base tag.
- **Tests:** scoped and accelerated; full suite only when the plan requires it, capped and serialized.
- **Commit often**, push immediately, conventional commits, `Refs #66` / `Refs #67`.
- **Full paths** everywhere.
- **No AI attribution** and no `Co-authored-by` for @MetalbolicX (credit goes in CHANGELOG and the PR
  body only).

---

## 3. Background you need (do not re-derive)

### 3.1 The two issues

- **#66:** today only the prompt tells delegates not to sub-delegate. Nothing in code stops a
  delegate holding a `task` tool from dispatching, and its child from dispatching again. The plan
  adds a depth tracker (M1) and a guard (M2) on every in-process dispatch path (native `task` on v1,
  v2, v2 background and `task_id` resume, plus the `delegate` tool).
- **#67:** the escalation ladder (`src\escalate\ladder.ts`) retries the same tier with a forcing
  message, then escalates; effort never changes within a tier. The plan makes the same-tier retry run
  one effort level higher (M3/M4), delivered per producer session through the existing
  `"chat.params"` hook (M5).

### 3.2 History with #17 (relevant for credit and tone)

- #17 was the owner's offer to @MetalbolicX (José), author of the fork `opencode-smart-router`, to
  port three ideas with his blessing. He never replied. The self-imposed date (2026-09-03) passed.
- On 2026-10-04, #17 was closed with a comment:
  - the config-load validation of model IDs had shipped in `c1b9f39`;
  - the depth guard moved to #66;
  - a correction about the session cleanup that already existed;
  - the effort bump, treated as unclaimed, moved to #67.
- **Credit policy:** the observations are credited to him in CHANGELOG and the PR body, linking #17.
  **No** `Co-authored-by` trailer, because none of his code is used; a trailer is a claim of
  authorship. Never read or port code from his fork.

### 3.3 The owner's decisions (plan §1.5-D12, 2026-10-05)

1. `enforcement.maxDelegationDepth` defaults to **`1`**: only orchestrators dispatch.
2. `enforcement.escalate.effortBumpMax` defaults to **`"xhigh"`**, clamped per family. OpenAI tiers
   stop at `high`; Claude tiers can reach `xhigh`.
3. **The whole plan is approved for autonomous execution through the release:** merge, tag
   `v2.1.0`, `npm publish` and local sync. There is no approval gate before releasing.

### 3.4 Review history of the plan

- **Revision 1:** the first draft. Its effort mechanism was derived hidden subagents.
- **Revision 2:** a senior engineering review with 13 findings, R1–R13 in plan §7. The key changes:
  - the effort override moved to `chat.params`, the grader-temperature precedent;
  - tiers with a `variant` are excluded from the bump;
  - roots are recorded only from authoritative evidence, and the larger depth wins on conflict;
  - a refused dispatch counts as an attempted tool call, so the false-refusal detector does not fire;
  - wave-base tags;
  - handling of the untracked plan file;
  - QA added to 0.P and 3.4;
  - realistic smoke tests plus a mutation check;
  - the guard's scope limits (D11).
- **Revision 3:** the owner's decisions and the execution rules (O1–O4 in plan §7).

### 3.5 What was verified directly versus reported by subagents

**Read directly by the planning orchestrator (trust these):**
- `D:\git\opencode-model-router\src\index.ts` ≈980–993: the `"chat.params"` hook pins
  `output.temperature` for sessions in `graderSessions`, inside an **empty `catch`** (do not copy that
  pattern; plan §0.10.10). Its comment at ≈962–979 documents the hook order
  `chat.message → system.transform → chat.params`.
- `D:\git\opencode-model-router\src\compat\v2-hooks.ts` ≈217–222: the v2 bridge calls
  `legacy["chat.params"]?.(input, event.options)`. **On v2, the legacy hook's `output` is
  `event.options` itself**, so its shape differs from v1's `output.options`. Spike B (0.P.4) must
  establish where provider options live on each version.
- `parentID` usage: `src\index.ts` ≈253–306 (root lookup), ≈629 (producer `parentID` only when
  `toolCtx.sessionID`), ≈1511–1524 (`session.created` classifier); `src\verify\wiring.ts` ≈1238
  (grader); `src\compat\v2-hooks.ts` ≈249.
- The structure and §0 of the previous plan, `verification-resource-budget-plan.md` (this plan
  mirrors it).

**Reported by `@fast` subagents (approximate lines, re-read in each pre-flight):** the ladder internals
and defaults, the `agent-options.ts` effort rules, the `config.ts` validation lines, the `sessions.ts`
internals, the task-hook throw-to-block mechanism, the `delegate` tool and producer creation, the v2
`execute.before` bridge, and the package scripts.

**Not verified at all:**
- Whether OpenCode's `task` tool lists `hidden: true` subagents. This came from the planner's memory;
  it no longer matters, because the design avoids new agents.
- Whether `xhigh` is accepted by every Claude model in the bundled presets. See §4.3.

---

## 4. Troubleshooting notes from the planning session

### 4.1 Delegation and the model-router

- **`@fast` often returns `NEED MORE:` with zero tool calls**, claiming it only has the `execute`
  catalog and no file tools. This happened 4 times in a row. **What worked every time:** continue
  the same `sessionID` with: "You made zero tool calls. Grep, Glob, Read and Bash are top-level tools
  in your schema, separate from `execute`. Call Read on <full path> now, then complete the task." If
  it fails twice, take over (§0.10.2).
- **`CAP:N` above the baseline was not honoured.** Dispatches carrying `CAP:22` and `CAP:25` still
  stopped at 8 read-only calls. Split gathers into chunks of at most 8 reads and run them in
  parallel, or use `CAP:none` with a `reason:` line on its own line (untested in this session; check
  it on the first heavy QA dispatch).
- **The orchestrator's own allowance** is about 2 direct read-only calls per turn. Use them for
  lookups that settle a question outright; dispatch `@fast` for anything more.
- **Acceptance:** the installed plugin is `2.0.0`, so `check: testsPass` runs affected tests only and
  **defers by default** (it returns an unverified result with a `vrf_…` handle). Use `VERIFY:required`
  when later work builds on the output, and call `router_verify` with `pending: true` before each
  phase QA (plan §0.5). Always set `cwd:` to the phase worktree in the acceptance block.

### 4.2 Shell, paths and tools

- pwsh 7, not bash: use `$env:TEMP`, `Get-ChildItem`, `Stop-Process`, and `Get-CimInstance
  Win32_Process` for orphan checks. Ignore LF→CRLF warnings.
- **GitHub bodies:** write the text to a file under `C:\Users\Marquinho\AppData\Local\Temp\Claude\`
  and pass `--body-file`. For `gh issue close --comment`, `"$(Get-Content -Raw <file>)"` worked.
- **Docs lookups:** context7's `/sst/opencode` redirects to `/anomalyco/opencode` and returns no
  content under the old id. Use `/anomalyco/opencode`. For OpenCode internals (option merge order,
  hook payloads), the installed package source under the worktree's `node_modules` is the most
  reliable evidence.
- All line numbers in the plan are approximate (`≈`), taken from `v2.0.0`. Re-read them in each
  pre-flight; merges move them.

### 4.3 Known risks to watch during execution

- **`xhigh` on Claude models.** The owner chose `effortBumpMax: "xhigh"`. If a spike, a smoke test or
  the e2e shows a bundled Claude model rejecting `xhigh`, that is a **critical** finding: the release
  would publish a default that breaks a bundled preset. Stop and ask the human; do not change the
  owner's default on your own. Elsewhere, the documented remedy is `effortBumpMax: "high"`.
- **The bump may be inert for most bundled presets.** D7 excludes tiers without an explicit `effort`
  and tiers with a `variant`. 0.P.2.g measures this. It is **not** a stop: 0.P.5 records it, the ADR
  and CONFIG_REFERENCE publish the preset table, and the final report states it. Editing
  `tiers.json` is forbidden by the plan (§2).
- **The v2 `chat.params` shape** (§3.5) is the most likely place for Spike B to surprise you. If the
  primary mechanism fails on v2, use D9's fallback (a per-prompt `variant`). If both fail, it is a
  blocking problem: ask.
- **The false-refusal detector** (`src\index.ts` ≈1240–1245) must not fire on a delegate that obeyed
  a depth refusal (D4). The 2.3 integration test covers it; do not drop it.
- **The main checkout** holds the two untracked plan files. 0.P.1.a expects exactly those two;
  anything else is a stop. 3.4.5 deletes them, after checking their hashes, before `pull --ff-only`.

### 4.4 Inherited notes

Read §4 of `D:\git\opencode-model-router\docs\plans\verification-resource-budget-handover.md`
(shell and harness, processes, git and data safety, CI and release, your own session's plugin). The
same machine, CI workflows and release pipeline apply.

---

## 5. Kickoff sequence

1. Read the plan in full, this handover, and §4 of the previous handover.
2. Create the run log entry "session start" once `D:\git\omr-de-main` exists (Phase 0.P.1.b).
3. Execute Phase 0.P exactly as written: baseline, unknowns, Spikes A and B, the heavy verdict, plan
   amendments on `de/main`, `phase-0P.md`, the heavy QA of 0.P, and the `de/wave-1-base` tag.
4. Wave 1: create the three worktrees (with `npm ci` one at a time), then run 1.1, 1.2 and 1.3 in
   parallel. Each has its pre-flight, tasks, tests and heavy QA. Merge serially. 1.3.4 starts after
   1.1 merges.
5. Wave 2: tag `de/wave-2-base`; 2.1 ∥ 2.2; then 2.3.
6. Wave 3: tag `de/wave-3-base`; 3.1 ∥ 3.2; then 3.3 (global QA); then 3.4 (release and sync).
7. Post a progress comment on #66 and #67 at each wave boundary. Send the final report to the human in
   Portuguese (plan §4.2), including the reminder to restart the opencode sessions.

## 6. When to stop and ask (only these)

- An ambiguity that only the human can resolve, which neither the plan nor the code settles.
- A critical problem:
  - a depth-guard bypass that the plan cannot close;
  - data-loss risk to the main checkout, a git ref or a user file;
  - a release that would publish a broken default (for example `xhigh` rejected by a bundled Claude
    preset);
  - unexpected files in the main checkout.
- A blocking problem: a spike disproves an assumption and the plan has no written alternative (for
  example both D9 mechanisms fail on v2), or the same failure persists after §0.8's heavy escalation.

Everything else is work.
