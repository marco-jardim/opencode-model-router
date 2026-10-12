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
| DF1.4.b background | **pass** | Runner `ses_ecf59b94cffevkR0HUsEQiLxLh` (haiku-5-5#medium, `tier=fast pin`): the call returned `[router] Running in the background … Its result will arrive unverified` at once; the orchestrator made a shell call (12:06:15) before the child ended; the completion arrived with `vrf_a3e65a0e7217c54f3417aa79` in the router state; `router_verify` → `pass`, `verified: deterministic` (no changed files). turn-state 38/38. |
| DF1.4.c leases | **pass** (with DF-1-3, DF-1-4, DF-1-8) | Child 1 `ses_ecf58ce08ffexe2KbR1ddI3pKv` wrote `docs/dogfood-probe.md` (seen by `git status --porcelain` at the first poll, 12:07:15), then held the lease through a 428 s `test-files test/unit` run. Child 2 `ses_ecf57565cfferlWiIU4SXdZds4`: read refused and write refused, both naming `implementer "DF1.4.c lease child 1 [nonce 25246ebd-…]" (session ses_ecf58ce08ffexe2KbR1ddI3pKv)`; the write refusal: `… is being edited by implementer … Do not retry: the lease ends when that session ends.` Explorer `ses_ecf574ab3ffeoxuEgaOwUDWyNY`: read refused, holder named. Runner `ses_ecf573be9ffenpQvMKZMa91y0j` (second turn, 12:09:40, child 1 still holding): `[router] ran while implementer "DF1.4.c lease child 1 [nonce 25246ebd-…]" (session ses_ecf58ce08ffexe2KbR1ddI3pKv) edits 1 file(s); result may be contaminated` (recovered from the host DB, see DF-1-4). After child 1 ended, explorer `ses_ecf504c7cffe44IxPyJdMFPQGB` read the file (3 lines, verbatim). |
| DF1.4.d telemetry | **partial** (DF-1-5) | `node D:\git\omr-cpx-dogfood-df1\scripts\routing-stats.ts --since 2026-10-12T12:03:00-03:00` (no `routing.outcomes.path` set): dispatch-duration rows present (explorer p50 5.4 s / p90 11.9 s n=2; implementer 26.5 s / 467.5 s n=2; runner 7.1 s / 10.2 s n=3), `timings.jsonl` rows carry `background: true`. **No orchestrator cache-read-share section**: the outcome directory has no `turns.jsonl`. Counts include the other implementation's sessions (shared default directory: 11 dispatches, of which 7 are this plan's probes). |
| DF1.4.e cache | **pass on the host's numbers; router telemetry missing** (DF-1-5, DF-1-6) | From the host DB (`session_message.tokens` of `ses_ecf5bd114ffe5QT3S5xVTAQcF4`): first 5 orchestrator steps' cache-read share 0.221, 0.966, 0.569, 0.996, 0.987 (p50 0.966 ≥ 0.5); first 39 steps: p50 0.964, weighted 0.853 (read 2 687 836, write 461 600, uncached input 120). The router recorded one orchestrator turn for the whole session (no user prompt after `continue`), so "turns" here are host steps. Per-step table: `$env:TEMP\omr-evidence\df1-orchestrator-steps.txt`. |
| DF1.4.f held results | **pass** (with DF-1-3) | C4/C15 hold (Phase 0.1). Runner `ses_ecf4f55cdffe03G7QXLlHryk7o`, `VERIFY:required` in the background: the call returned `Its result is held until verification finishes`; the completion arrived as `held — verdict pending (vrf_02dc7ee3b0cb16b6cf986c47)`, then the verdict with the output and `[router ✓ verified: deterministic]`. |
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
