# Dogfood record — critical-path execution plan

Plan §0.12-4 (fault policy) and §0.12-5 (metrics). Time windows: before DF-1 (build `cpx/df0` = `b716ee9`, release 2.7.0),
after DF-1, under DF-2. Deviations are recorded as `DF-<n>-<k>` with their evidence.

## Window "before DF-1" (2026-10-10 18:55 → 2026-10-12, build `cpx/df0`)

### Phase wall-clock (first → last commit on the phase branch, local time -03:00)

| Phase | Commits | First | Last | Notes |
|---|---|---|---|---|
| 0.P | — | 2026-10-10 18:55 | 2026-10-10 ≈20:45 | orchestrator shell in `cpx/main` (handover §7) |
| 0.1 | 27 | 2026-10-10 20:40 | 2026-10-11 05:20 | merged `915b96a` |
| 1.1 | 9 | 2026-10-11 02:04 | 2026-10-11 05:39 | merged `d4d731b` |
| 1.2 | 11 | 2026-10-11 02:35 | 2026-10-11 05:54 | merged `a9e32c1` |
| 1.3 | 7 | 2026-10-11 02:05 | 2026-10-11 05:55 | merged `6d310eb` |
| 1.4 | 9 | 2026-10-11 01:53 | 2026-10-11 05:55 | merged `12d42b7` |
| 2.1 | 24 | 2026-10-11 06:45 | 2026-10-12 11:08 | merged `bc0df8a`; includes an owner shutdown (2026-10-11 ≈11:30 → 2026-10-12 ≈08:00) |
| 2.2 | 9 | 2026-10-11 06:45 | 2026-10-12 08:29 | merged `ded2e88`; same shutdown |
| 2.3 | 12 | 2026-10-11 06:45 | 2026-10-12 08:29 | merged `9b44413`; same shutdown |
| 2.4 | 12 | 2026-10-11 06:45 | 2026-10-12 08:32 | merged `6eaf7f0`; same shutdown |

### Metrics

- **Background dispatches:** 0. `cpx/df0` has no background dispatch (Phase 2.1 ships it); every dispatch ran in the
  foreground, so the forced-foreground share is not meaningful for this window.
- **Dispatches recorded** (`node scripts/routing-stats.ts --since 2026-10-10T18:55:00-03:00`, run from `cpx/main` on
  2026-10-12 against the default outcome directory): 452 routed dispatches, 114 orchestrator resumes; by class: implement
  146, review 63, debug 45, design 40, mechanical 26, recon 15, search 2, other 1. Caveat: the default outcome directory is
  shared by every router on this machine (the other implementation's sessions included), so this is an upper bound for
  this plan.
- **Orchestrator cache-read share and dispatch durations:** not available for this window. The timing rows and the
  cache-read line come from Phase 1.1/1.2 telemetry, which `cpx/df0` does not have.
- **Idle-with-ready time:** not reconstructible. The handover's dispatch log has start/end bounds for 0.P and the start of
  0.1 only (QA-0.P-19); later dispatches are recorded per phase report by session id without timestamps.
- **Lease refusals / contaminated `router_run` annotations:** 0 (leases ship with Phase 2.1).
- **Pending verifications recovered after a restart:** none (persistent held results ship with Phase 2.1).

### Deviations

None recorded in this window (handover §7 "Dogfood faults: none").

## Window "after DF-1"

Build `cpx/df1` = `226d967` (`D:\git\omr-cpx-dogfood-df1`), loaded since 2026-10-12 12:03:38 -03:00 (server run
`27717102`). Orchestrator session after the restart: `ses_ecf5bd114ffe5QT3S5xVTAQcF4` (continues
`ses_ed82f88a7ffej5iKaRHuwIa6fd`'s plan; `OPENCODE_SESSION_ID` in the orchestrator shell).

### DF-1 self-check probes (DF1.4, 2026-10-12 12:04 → 12:25 -03:00)

| Probe | Result | Evidence |
|---|---|---|
| DF1.4.a build loaded | **pass** | Marker `omr-selfcheck-df1-c84e2b19a6` → newest `spawning process` line in run `27717102` (2026-10-12T15:04:09Z). That run's `cli starting` line: `version=2.0.26`. `loading plugin` ids per load pass: {`D:\\git\\opencode-anthropic-fix`, `D:\\git\\omr-cpx-dogfood-df1`}, each once per pass, router entrypoint exactly `file:///D:/git/omr-cpx-dogfood-df1/server.ts` (3 passes, one per booted location: `D:\git\omr-cpx-main`, `C:\Users\Marquinho`, `D:\git\opencode-model-router` — see DF-1-1). Config plugin list also has `D:\git\opencode-telegram-plugin`, not loaded (expected baseline difference, as at DF-0). Server processes 44768/66968: `C:\Users\Marquinho\AppData\Local\omr-cpx\bin\opencode2-2.0.26\opencode.exe`, created 12:03:38. `git -C D:\git\omr-cpx-dogfood-df1 rev-parse HEAD` = `git rev-parse cpx/df1^{commit}` = `226d96796c95b1cf526d0c9bf558f376cc333078`, worktree clean. Exactly one `router_verify` tool in the orchestrator's tool list. |
| DF1.4.b background | **pass** | Runner `ses_ecf59b94cffevkR0HUsEQiLxLh` (haiku-5-5#medium, `tier=fast pin`): the call returned `[router] Running in the background … Its result will arrive unverified` at once; the orchestrator made a shell call (12:06:15) before the child ended (child output: vitest "Start at 12:06:08", completion delivered after 12:06:15); the completion arrived with `vrf_a3e65a0e7217c54f3417aa79` in the router state; `router_verify` → `pass`, `verified: deterministic` (no changed files). turn-state 38/38. |
| DF1.4.c leases | **partial** (QA-DF1-3): criteria 1, 2 and "read allowed after" met; criterion 3 (the runner's *delivered* result carries the contamination annotation) not met — the delivered result was the stale first-turn text (DF-1-4); the annotation exists only in the host DB. Re-probe on the fix build. | Child 1 `ses_ecf58ce08ffexe2KbR1ddI3pKv` wrote `docs/dogfood-probe.md` (seen by `git status --porcelain` at the first poll, 12:07:15), then held the lease through a 428 s `test-files test/unit` run. Child 2 `ses_ecf57565cfferlWiIU4SXdZds4`: read refused and write refused, both naming `implementer "DF1.4.c lease child 1 [nonce 25246ebd-…]" (session ses_ecf58ce08ffexe2KbR1ddI3pKv)`; the write refusal: `… is being edited by implementer … Do not retry: the lease ends when that session ends.` Explorer `ses_ecf574ab3ffeoxuEgaOwUDWyNY`: read refused, holder named. Runner `ses_ecf573be9ffenpQvMKZMa91y0j` (second turn, 12:09:40, child 1 still holding): `[router] ran while implementer "DF1.4.c lease child 1 [nonce 25246ebd-…]" (session ses_ecf58ce08ffexe2KbR1ddI3pKv) edits 1 file(s); result may be contaminated` (recovered from the host DB, see DF-1-4). After child 1 ended, explorer `ses_ecf504c7cffe44IxPyJdMFPQGB` read the file (3 lines, verbatim). |
| DF1.4.d telemetry | **partial** (DF-1-5): duration rows yes, cache-read-share line no. Re-probe on the fix build. | `node D:\git\omr-cpx-dogfood-df1\scripts\routing-stats.ts --since 2026-10-12T12:03:00-03:00` (no `routing.outcomes.path` set): dispatch-duration rows present (explorer p50 5.4 s / p90 11.9 s n=2; implementer 26.5 s / 467.5 s n=2; runner 7.1 s / 10.2 s n=3), `timings.jsonl` rows carry `background: true`. **No orchestrator cache-read-share section**: the outcome directory has no `turns.jsonl`. Counts include the other implementation's sessions (shared default directory: 11 dispatches, of which 7 are this plan's probes). |
| DF1.4.e cache | **not measurable on df1** (DF-1-5, QA-DF1-3): the plan's source (`routing-stats.ts`, orchestrator turns) has no rows. Supporting evidence only: | From the host DB (`session_message.tokens` of `ses_ecf5bd114ffe5QT3S5xVTAQcF4`): first 5 orchestrator steps' cache-read share 0.221, 0.966, 0.569, 0.996, 0.987 (p50 0.966 ≥ 0.5); first 39 steps: p50 0.964, weighted 0.853 (read 2 687 836, write 461 600, uncached input 120). The router recorded one orchestrator turn for the whole session (no user prompt after `continue`), so "turns" here are host steps. Per-step table below ("Orchestrator steps"). Re-probe on the fix build. |
| DF1.4.f held results | **pass** (with DF-1-3) | C4/C15 hold (Phase 0.1). The gate ran no test ("no changed files, no affected tests", QA-DF1-15), so the probe shows the hold/verdict sequence, not a test run. Runner `ses_ecf4f55cdffe03G7QXLlHryk7o`, `VERIFY:required` in the background: the call returned `Its result is held until verification finishes`; the completion arrived as `held — verdict pending (vrf_02dc7ee3b0cb16b6cf986c47)`, then the verdict with the output and `[router ✓ verified: deterministic]`. |
| DF1.4.h cleanup | **pass** | Probe file deleted, `git worktree remove D:\git\omr-cpx-scratch`, `git branch -D cpx/scratch-df1` (was `d93d4d8`); `D:\git\omr-cpx-scratch` absent. Scratch worktree `D:\git\omr-cpx-scratch-pre` (for DF-1-2, detached at `cf7e5b6`, `node_modules` junction) removed the same way after removing the junction. |

### Deviations

- **DF-1-1 — the host booted a location for `D:\git\opencode-model-router`.** Run `27717102` booted location services
  for `D:\git\omr-cpx-main`, then `C:\Users\Marquinho` and `D:\git\opencode-model-router` (15:03:41.6Z), ran
  `git rev-parse --git-dir --git-common-dir --show-toplevel` and `git remote get-url origin` there, and loaded both
  plugins (the df1 router included) in that location. The DF-0 run `461f3bf1` booted only plan worktrees
  (`omr-cpx-p13`, `omr-cpx-p23`). Host-initiated, read-only git commands; the orchestrator then listed
  `D:\git\opencode-model-router\.opencode` modification times once to check for writes (newest: 2026-08-19) — a
  read of the off-limits directory (§0.13), recorded here; no further access. Disposition: DF1.QA.
- **DF-1-2 — `test\unit\roles.runtime.test.ts` fails on `cpx/main` since the 2.1 merge.** 4 failed / 50 passed /
  1 skipped at `d93d4d8` (orchestrator shell, with and without the `OPENCODE*` variables), 54 passed / 1 skipped at
  `cf7e5b6` (= `bc0df8a^1`). Failing: "v2 tiers mode: no role tool, today's protocol" (the system prompt has the new
  `## Background dispatches` section that `assembleSystemPrompt` does not produce), "roles mode: description nonce
  suffix, router model, foreground with verification off; tiers mode untouched", "QA-P21-1-1 …", "QA-P21-2-4 …". The
  DF-1 pre-flight's scoped test list did not include this file. Code/test fault → fix phase `pdf1-1`.
- **DF-1-3 — the background grader is denied, and an unverifiable result is tagged PASS.** Every background role
  dispatch without a deterministic check (`d=none`) came back `[router ⚠ UNVERIFIED: checker]` with
  `grader dispatch failed: Tool.Error: Subagent denied: model-router-grader`, inside `<router-verdict … verdict="PASS">`
  (5 of 5: `vrf_21531f37…`, `vrf_6ce1b679…`, `vrf_fb40aa63…`, `vrf_0d2f18e6…`, `vrf_b089dab8…`). Code fault → `pdf1-1`.
- **DF-1-4 — a resumed background dispatch delivered the previous turn's result.** Runner
  `ses_ecf573be9ffenpQvMKZMa91y0j` first returned `NEED MORE` with zero tool calls (DF-1-8); resumed in the background
  at 15:09:33.6Z. The router delivered `vrf_98eda506…` `verdict="PASS"` carrying the **first** turn's text at
  15:09:42Z, while the second turn's final text was created at 15:09:41.5Z and completed at 15:09:43.8Z; at 15:09:49Z a
  `held — verdict pending (vrf_98eda506…)` notice followed and no verdict ever came. The real second-turn answer
  (contamination annotation) was recovered from `opencode.db`. Reproduced at once on explorer
  `ses_ecf4ed9f3ffelNL9cKKhbCLor9`: its background resume (12:22 -03:00) delivered `vrf_9e44e784…` carrying the first
  turn's `NEED MORE: budget` text verbatim. Code fault → `pdf1-1`.
- **DF-1-5 — no orchestrator turn rows.** No `turns.jsonl` after 39 orchestrator steps: a turn closes on the next root
  prompt or on the idle sweep, which skips a root with an open dispatch; under background-first dispatch the
  orchestrator almost always has one open, and synthetic wake-ups are not root prompts. The cache-read-share section
  therefore never renders. Code fault → `pdf1-1`.
- **DF-1-6 — the cache prefix stops growing while background dispatches are in flight.** Cache read stays constant
  while writes grow: steps 13-18 (read 71 976, write 1 326 → 6 465), 19-24 (read 29 302 — inside the system/tools
  prefix — while held verdicts were pending, write ≈51-55 k **per step**), 33-39 (read 99 359, write 3 034 → 9 154).
  Outside those windows reads grow step by step. Each plateau re-writes the whole suffix at 1.25×. G4/C5 candidate; to
  be root-caused in `pdf1-1` (what changes at that position each step while a dispatch is running or held).
- **DF-1-7 — `tier=fast pin` on implementer dispatches ran on the heavy model.** Both implementer probes ran on
  `anthropic/claude-opus-5-5#xhigh` (`routing-stats`: implementer × heavy); explorer and runner pins ran on
  `claude-haiku-5-5#medium`. To check against the roles ladder (a pin below the role's floor may be clamped by
  design); disposition in DF1.QA.
- **DF-1-8 — a runner refused itself with zero tool calls**, citing the environment block's directory
  (`D:\git\omr-cpx-main`) as its work root although the route line set `root=D:\git\omr-cpx-scratch`; the resume with
  "attempt it now" ran it. Model behaviour on the fast tier; the role prompt's work-root wording is to be checked in
  `pdf1-1`.
- **DF-1-9 — a child session the plugin never saw created is treated as a root for the background decision**
  (found while fixing DF-1-2). Three of the four DF-1-2 failures are stale expectations (2.1 adds the v2
  `## Background dispatches` block and stops forcing `background: false` on a thin duration store). The fourth,
  `QA-P21-1-1`, is a product fault: `knownKindOf` (`src\compat\v2-hooks.ts` ≈1306) returns `root` for an unknown
  session, so `parentIsRoot` (≈2578) is true for a child the plugin did not record (e.g. after a reload), and the `auto`
  rows can background a child's dispatch, contrary to row 2 of the 2.1 decision table (`phase-2.1.md` ≈432-433). Code
  fault → `pdf1-1`.
- **DF-1-10 — a running background dispatch was settled "lost in restart" without a restart.** At ≈15:37Z the
  orchestrator received `<router-verdict handle="vrf_b09dfc0e…" verdict="UNVERIFIABLE">[router] not verified: lost in
  restart` for implementer `ses_ecf494a78ffeIBjqCOSUjN2KxX` (pdf1-1 H1), which was still producing steps (host DB: step
  77 at 15:39:29Z), and the router state still lists it as in flight and "verifying". No server restarted (processes
  44768/66968 since 12:03:38; one `cli starting` for run `27717102`). The host booted a new location
  `D:\git\omr-cpx-scratch` at 15:36:41.9Z and loaded a second router instance there (QA-DF1-1 probe worktree).
  Hypothesis: a router instance starting in a new location reloads the shared pending journal and settles the other
  instance's live handles as lost. Code fault → `pdf1-1` (hinders execution: every new worktree location — Wave 3 opens
  several — can void in-flight verifications). Reproduced 16:04:40Z: the host evicted the `C:\Users\Marquinho` and
  `D:\git\opencode-model-router` locations and booted them again (`loading plugin` df1 in both, no new worktree); the
  orchestrator then received `lost in restart` twice for implementer `ses_ecf25d227ffeXewxYpZq1dT44a` (pdf1-1 H3,
  `vrf_c8e40a80…`) while it was still running. DF-1-1 recurs with every such re-boot (host project probes only).
- **DF-1-11 — the restart opened a fresh session, not `-s ses_ed82f88a7ffej5iKaRHuwIa6fd` (QA-DF1-5).** The owner used
  the §0b fresh-session kickoff (`d93d4d8`, 12:02, after the DF1.2 record); the live orchestrator is
  `ses_ecf5bd114ffe5QT3S5xVTAQcF4`. DF1.3 and §0.12-3.5 say "continue the same session". Effect: the launch and revert
  commands in handover §7 named the old session (fixed with this record), and the "no user prompt after `continue`"
  wording above means "one kickoff prompt, no later user prompt". Probably also the trigger of DF-1-1 (DF-0, launched
  with `-s`, booted only plan worktrees); not proven.

**DF-1-1 follow-up (QA-DF1-7).** In run `27717102` every command with cwd `D:\git\opencode-model-router` is a host
project probe: `rev-parse --git-dir --git-common-dir --show-toplevel` (15:03:40.5Z, 15:03:55.9Z), `remote get-url
origin` (15:03:40.7Z), `symbolic-ref` / `remote` (15:03:50.6-50.8Z); plus MCP connections and config events for that
location. Every `git worktree list --porcelain` of the run (the reference GC included) has cwd `D:\git\omr-cpx-main`;
nothing ran there after 15:03:56Z. So the df1 router was loaded in that location (it reads that checkout's project
overrides at start) but ran no git command and wrote nothing there that the log shows. Disposition: host behaviour
triggered by the fresh-session launch, not a router regression; told to the owner on 2026-10-12 with a request for
acknowledgement; hardening (skip plugin-start side effects when `ctx.directory` is outside `routing.workRoots`) is
scheduled in `pdf1-1`.

**DF-1-7 disposition (QA-DF1-10): not a fault.** The DF1.4.c route lines ask for `needs=edit,shell` with `d=none`; the
authority floor for write + exec without a deterministic check is heavy (`src\router\policy.ts` ≈217-229) and a pin
below the floor is lifted with `lift:authority` (≈406-408). The plan's DF1.4.c / DF2 route lines run heavy by design.

**Workaround probes (QA-DF1-1, 2026-10-12 12:35-12:37 -03:00, scratch worktree `D:\git\omr-cpx-scratch` on branch
`cpx/scratch-df1b`, both removed afterwards).**
- (b) foreground `d=none` implementer `ses_ecf3dc9c5ffecP2uCAiksAhtgw` wrote the probe file →
  `[router ✓ verified: checker]`: the grader runs in the foreground. **pass**
- (a) foreground resume of the same session with a marker → delivered `DONE: turn 2 marker 4f1c appended` (this turn's
  answer), `[router ✓ verified: checker]`. **pass**

**Binding workaround until `cpx/df1.1` is loaded (§0.12-6):** every resume of a role session runs in the foreground
(`background: false`); producer dispatches without a deterministic acceptance check run in the foreground or carry an
`[acceptance]` block; `⚠ UNVERIFIED` means unverified whatever the `verdict=` attribute says, and the handles listed
in DF-1-3 do not count as verified; a `lost in restart` verdict for a dispatch that is still listed in flight is
ignored until its real completion (DF-1-10). With the workaround the plan continues on df1; `pdf1-1` ships as a
re-switch `cpx/df1.1` (these faults hinder execution, so it does not wait for DF-2).

**Other implementation unaffected (QA-DF1-8).** The other servers are the scoop 2.0.27 executables (processes
41232/48472/28388 and 2412/36096/46636, created 08:02 and 08:22, before the switch) and load their own config; the
global `C:\Users\Marquinho\.config\opencode\opencode.json` hash `CD913FB1…5709` equals the backup
`$env:LOCALAPPDATA\omr-cpx\opencode-config.backup\opencode-config.backup` (unchanged since 2026-10-10 00:39:51); run
`27717102` boots no location in `D:\git\opencode-model-router-cross-repo`, and in `D:\git\opencode-model-router` only
the host probes above (no prompt, no session). Shared state df1 now writes: `timings.jsonl` in the default outcome
directory (rows carry this plan's session ids only: parent `ses_ecf5bd114ffe5QT3S5xVTAQcF4`), the pending journal and
lease claim files (§0.13-5).

**Leftover state (QA-DF1-11).** `git worktree list` after cleanup: no `omr-ref*` or scratch worktree; `cpx/scratch-df1`
and `cpx/scratch-df1b` deleted. Probe handles left in the pending journal (24 h TTL): the DF-1-3 handles (settled with
a wrong `PASS`, QA-DF1-2), `vrf_98eda506…` and `vrf_9e44e784…` (stale deliveries, DF-1-4). They name the removed
scratch worktree; `pdf1-1`'s re-probe drains the journal with `router_verify pending:true` before the `cpx/df1.1` tag.

**Pre-flight correction (QA-DF1-9).** The DF-1 pre-flight claim "scoped tests of 2.1-2.4 green" was false: the list
missed `test\unit\roles.runtime.test.ts` (DF-1-2), so §0.12-3.1 was not met when `cpx/df1` was tagged. From now on the
pre-flight's scoped list includes every test that imports a changed module.

### Orchestrator steps (host DB, `ses_ecf5bd114ffe5QT3S5xVTAQcF4`; UTC; DF1.4.e and DF-1-6 evidence)

| Step | Time | Uncached input | Cache read | Cache write |
|---|---|---|---|---|
| 1 | 15:03:55 | 4 | 6857 | 24154 |
| 2 | 15:04:01 | 2 | 31011 | 1078 |
| 3 | 15:04:05 | 2 | 32089 | 24273 |
| 4 | 15:04:12 | 2 | 56362 | 211 |
| 5 | 15:04:19 | 2 | 56573 | 747 |
| 6 | 15:04:26 | 2 | 57320 | 1208 |
| 7 | 15:04:35 | 2 | 58528 | 7085 |
| 8 | 15:04:45 | 2 | 65613 | 3053 |
| 9 | 15:04:56 | 2 | 68666 | 1465 |
| 10 | 15:05:11 | 2 | 70131 | 1149 |
| 11 | 15:05:18 | 2 | 71280 | 371 |
| 12 | 15:05:50 | 2 | 71651 | 325 |
| 13 | 15:06:06 | 4 | 71976 | 1326 |
| 14 | 15:06:15 | 4 | 71976 | 2102 |
| 15 | 15:06:21 | 4 | 71976 | 2178 |
| 16 | 15:07:06 | 4 | 71976 | 3310 |
| 17 | 15:07:16 | 4 | 71976 | 3535 |
| 18 | 15:08:49 | 4 | 71976 | 6465 |
| 19 | 15:09:23 | 4 | 29302 | 51214 |
| 20 | 15:09:34 | 4 | 29302 | 51824 |
| 21 | 15:09:42 | 4 | 29302 | 53962 |
| 22 | 15:09:49 | 4 | 29302 | 54062 |
| 23 | 15:14:53 | 4 | 29302 | 53891 |
| 24 | 15:15:00 | 4 | 29302 | 55086 |
| 25 | 15:15:31 | 2 | 84388 | 2791 |
| 26 | 15:15:51 | 2 | 87179 | 3501 |
| 27 | 15:16:14 | 2 | 90680 | 1696 |
| 28 | 15:16:41 | 4 | 92376 | 2046 |
| 29 | 15:16:47 | 2 | 94422 | 581 |
| 30 | 15:16:53 | 2 | 95003 | 1684 |
| 31 | 15:17:05 | 2 | 96687 | 1152 |
| 32 | 15:17:16 | 2 | 97839 | 1520 |
| 33 | 15:17:34 | 4 | 99359 | 3034 |
| 34 | 15:17:44 | 4 | 99359 | 3758 |
| 35 | 15:17:58 | 4 | 99359 | 5198 |
| 36 | 15:18:26 | 4 | 99359 | 5234 |
| 37 | 15:18:28 | 4 | 99359 | 7913 |
| 38 | 15:18:35 | 4 | 99359 | 8264 |
| 39 | 15:18:45 | 4 | 99359 | 9154 |

Note: uncached input 4 (vs 2) marks the steps where the request carried the router-state tail (in flight or held);
every plateau coincides with those steps.

**DF-1-6 root cause (2026-10-12 ≈13:05).** Not the router's request shape: the new smoke scenario
`DF-1-6 background tail` (`test\smoke\cpx-cache-prefix.smoke.test.ts` on `cpx/pdf1-1`, real 2.0.26 host, background
dispatch in flight, held completion, verdict, release) passes — system and tools byte-identical, each request a
byte-prefix of the next through its last real message, exactly one message breakpoint on the last real message, none on
the tail. The live host also loads `D:\git\opencode-anthropic-fix`, which rewrites the Anthropic request body:
`lib\mimicry\request-body.mjs` ≈489-522 strips every incoming message `cache_control` and puts the one message
breakpoint on the last block of the **last user message** — the router's `<router-state>` tail whenever it is present.
Each such request therefore writes a cache entry that ends in a tail that the next request no longer has; the next
request can only read an older entry that ended on a tail-free request, inside the 20-block lookback (read frozen at
71 976 / 99 359), or only the system breakpoint once that entry is out of reach (29 302). Steps without a tail grow
normally. This is a cross-plugin interaction outside this repository (C5 assumed the host's breakpoint placement).
Fix (owner go-ahead 2026-10-12: "you may change it, no regressions, keep v1 compatibility"): in
`opencode-anthropic-fix`, branch `fix/router-state-breakpoint` (worktree `D:\git\opencode-anthropic-fix-cpx`), commit
`8a7a3cb`, PR marco-jardim/opencode-anthropic-fix#42 — the message breakpoint skips a trailing `<router-state>` block and
goes on the nearest earlier block (never thinking, redacted thinking or blank text); requests without the tail are
unchanged on v1 and v2 (shared body transform). Three conformance tests; that repo's full suite 2098 passed / 2 skipped,
eslint and prettier clean. The live host keeps loading `D:\git\opencode-anthropic-fix` (master) until the owner merges
the PR there; DF-1-6 is re-measured on the next switch after that merge. Not a blocker (cost only).

### DF1.QA

Round 1 (reviewer `ses_ecf4a6d14ffeI81Bz7erefp9TM`, heavy, at `30ff5b2`): 15 findings (1 critical, 8 major, 5 minor,
1 nit).

| Finding | Severity | Disposition |
|---|---|---|
| QA-DF1-1 no workaround / §0.12-4/-6 decision | critical | fixed: workaround probes (a), (b) pass; binding workaround and `cpx/df1.1` re-switch recorded above |
| QA-DF1-2 unverifiable settled as deterministic pass | major | added to DF-1-3; fix in `pdf1-1` (align `index.ts` ≈3541 with `heldVerdictKind`, no hard-coded `method: "deterministic"`, regression test) |
| QA-DF1-3 c/e passed on substitute evidence | major | fixed: rows relabelled (c partial, e not measurable); re-probe on `cpx/df1.1` |
| QA-DF1-4 no verdict / no re-probe plan | major | fixed: verdict below |
| QA-DF1-5 rollback resumes the wrong session | major | fixed: DF-1-11; handover §7 launch/revert use the live session id, revert drains holds first |
| QA-DF1-6 handover §7 stale | major | fixed in handover §7 (next action, DF-1 row, builds list, session line) |
| QA-DF1-7 DF-1-1 understated | major | fixed: follow-up above; owner told; hardening in `pdf1-1` |
| QA-DF1-8 other implementation not evidenced | major | fixed: paragraph above |
| QA-DF1-9 DF-1-2 mixes causes; pre-flight claim false | major | fixed: DF-1-9 split out; pre-flight correction above |
| QA-DF1-10 DF-1-7 by design | minor | fixed: closed as not a fault |
| QA-DF1-11 leftover state | minor | fixed: paragraph above; journal drain scheduled |
| QA-DF1-12 DF-1-8 is a prompt issue too | minor | `pdf1-1`: `root=` takes precedence over the host environment block in `WORK_ROOT_RULE` (`src\router\roles.ts` ≈166) |
| QA-DF1-13 self-check wording | minor | fixed: handover §7 self-check amended ("once per booted location; any location outside the plan's worktrees is a deviation"); 44768 = `opencode.exe --standalone` TUI, 66968 = its `serve --stdio` server child (run `27717102`) |
| QA-DF1-14 evidence outside the repo | minor | fixed: steps table above |
| QA-DF1-15 record gaps | nit | fixed: DF1.4.b end time and DF1.4.f "no test ran" notes; the probe window closes at the 12:22 commit, follow-ups to 12:40 |

### Verdict

DF-1 is **open**: DF1.4.a, b, f, h pass; c (runner criterion), d and e are re-probed on `cpx/df1.1` after `pdf1-1`
(DF-1-3, -4, -5, -6, -9, -10, QA-DF1-12 and the DF-1-1 hardening), with its own run-scoped self-check. Until then the plan
continues on df1 under the binding workaround.

### Fix phase `pdf1-1` (branch `cpx/pdf1-1`, worktree `D:\git\omr-cpx-pdf1-1`, from `30ff5b2`)

| Commit | Faults | Producer |
|---|---|---|
| `b871c00` | DF-1-3 (grader launched from the orchestrator on background and held gates; UNVERIFIABLE tag for accepted unverifiable results), DF-1-4 (a resumed attempt never takes the previous turn's completion element, parked end or answer), DF-1-2 (roles.runtime expectations refreshed for 2.1) | implementer `ses_ecf494a78ffeIBjqCOSUjN2KxX` (heavy), `ses_ecf48defcffeiMPXtA1KqK8UAC` |
| `12774fc` | DF-1-9 (unrecorded parent resolved, never root by default), DF-1-5 (a root run's end closes its turn row), QA-DF1-12 (route-line `root=` wins), DF-1-6 smoke scenario `DF-1-6 background tail` | `ses_ecf36b2c4ffevivgCiXW74CHnj` (heavy), `ses_ecf3498f9ffezzS1v2Zd7sE4E8` (heavy) |
| `51d3c51` | DF-1-10 (per-instance beat files; a same-pid claim with a fresh beat is refused across module copies, a dead owner is still taken over), DF-1-1 hardening (v2 start-up reference GC skipped for a location outside a configured `routing.workRoots`) | `ses_ecf25d227ffeXewxYpZq1dT44a` (heavy); orchestrator fixed one test (sentinel identity across module copies) |

DF-1-6 itself is fixed outside this repository (marco-jardim/opencode-anthropic-fix#42, see above).

Verification (orchestrator shell, at `51d3c51`): typecheck green; scoped run of the 109 test files importing the changed
hubs at `12774fc`: 6118 passed / 16 skipped; the H3 scoped files green. One unintended full-suite run (a pwsh array
splat expanded to no file filter): 229 files passed, 2 failed — the H3 sentinel test (fixed) and
`test\unit\exec.test.ts` "a deadline after the direct child exited kills what it left running within 3 s (QA-1.2-1,
G4)", which passes isolated (`--maxWorkers=1`): a load-sensitive timing flake, recorded for the 6.2 pre-flight.
`smoke:cpx` 57/57, `smoke:v2` 2/2, `smoke:v1` 27 passed / 11 skipped (1.18.35 on PATH).

### DF1.QA round 2 (reviewer `ses_ecef46ce5ffecJAxfColEb3eMV`, heavy, at `cpx/pdf1-1` @ `51d3c51`)

13 findings: 4 major, 8 minor, 1 nit; none blocking or critical. Reviewer runs at `51d3c51`: typecheck green;
`test/integration` and `test/golden` (101) green; `test/unit` green except the known `exec.test.ts` deadline flake (42/42
alone); DF test files 232 + 371 green; docs-drift 92. The review's own handle got `lost in restart` twice while it ran
(DF-1-10 again; ignored per the workaround).

| Finding | Severity | Disposition |
|---|---|---|
| QA-DF1-16 held entries still settled `method: "deterministic"`; held path untested | major | fix dispatch A (`src\index.ts`, `src\verify\*`) |
| QA-DF1-17 DF-1-4 element check depends on timing (element seen while `processing`) | major | fix dispatch B (`src\compat\*`) |
| QA-DF1-18 shared journal assumes one module copy per process (marks, compaction temp file) | major | fix dispatch C (`src\verify\pending.ts`) |
| QA-DF1-19 roles-mode start-up `git worktree list` ignores `workRoots`; DF-1-1 claims overstated | major | fix dispatch C (`role-agents.ts`) + A (comment) + CHANGELOG/dogfood wording |
| QA-DF1-20 content-matched elements (identical answers, lost seen set) | minor | dispatch B |
| QA-DF1-21 evicted owner location → running child read as lost | minor | dispatch B |
| QA-DF1-22 beat file robustness, stale beats, docs | minor | dispatch C |
| QA-DF1-23 DF-1-9 tests and lookup timeout | minor | dispatch B |
| QA-DF1-24 DF-1-5 prompt-boundary tests | minor | dispatch B |
| QA-DF1-25 work-roots matcher semantics and realpath | minor | dispatch C |
| QA-DF1-26 WORK_ROOT_RULE wording | minor | dispatch C |
| QA-DF1-27 CHANGELOG / record overclaims; evidence commit | minor | orchestrator, with the round-2 fixes |
| QA-DF1-28 tests that pass without the fix | nit | dispatch B (labelled as guards) |

Correction (QA-DF1-19/-27): the DF-1-1 follow-up above relied on host log lines, which do not show the router's own git
processes; in roles mode the router also ran `git worktree list --porcelain` at start in every booted location,
`D:\git\opencode-model-router` included (read-only). The `51d3c51` claim "no start-up git outside `workRoots`" covered
only the reference GC.
