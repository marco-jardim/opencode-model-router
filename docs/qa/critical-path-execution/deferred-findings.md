# Critical-Path Execution — deferred findings, triaged (#142)

Compiled on **2026-11-27** at `master` `b678037`. One row per finding that a Critical-Path Execution report deferred
(minor/nit leftovers, known limitations, items handed on without a fix). The phase reports are historical and were not
edited; this file is the single backlog. Sources: the "Deferred findings" section of
[phase-0.1](phase-0.1.md#deferred-findings), [1.1](phase-1.1.md#deferred-findings),
[1.2](phase-1.2.md#deferred-findings), [1.3](phase-1.3.md#deferred-findings), [1.4](phase-1.4.md#deferred-findings),
[2.1](phase-2.1.md#deferred-findings), [2.2](phase-2.2.md#deferred-findings), [2.3](phase-2.3.md#deferred-findings),
[2.4](phase-2.4.md#deferred-findings), [3.1](phase-3.1.md#deferred-findings), [3.2](phase-3.2.md#deferred-findings),
[4.1](phase-4.1.md#deferred-findings), [4.2](phase-4.2.md#deferred-findings), [5.1](phase-5.1.md#deferred-findings),
[preflight](preflight.md#deferred-findings), [sync-1](sync-1.md#deferred-findings), the deferred rows of
[pdf2-1](pdf2-1.md) rounds 4 and 5, the [Phase 6.1 consolidated table](phase-6.1.md#deferred-findings) and
[global.md](global.md#deferred-findings) (plus two follow-ups recorded under its Handoffs). Phases 1.3 and 2.3 defer
nothing; phase 1.4 defers nothing but records one pre-existing item in its Handoffs, listed here.

## Summary

118 findings. 18 are fixed since they were deferred, 15 are obsolete or superseded, 85 are open (12 of them re-checked
in the code or docs today, 73 not re-verified).

| Area | Findings | Open | Fixed since | Obsolete / superseded |
|---|---|---|---|---|
| Executor fail-closed | 34 | 28 | 4 | 2 |
| Observation accuracy | 15 | 13 | 1 | 1 |
| POSIX | 2 | 2 | 0 | 0 |
| Test hygiene | 18 | 14 | 4 | 0 |
| Docs | 24 | 9 | 6 | 9 |
| Other | 25 | 19 | 3 | 3 |
| **Total** | **118** | **85** | **18** | **15** |

| Triage outcome | Findings |
|---|---|
| `file issue` (in nine proposed issues, below) | 49 |
| `fold into #140` (A-6.1-3 soak) | 5 |
| `fold into #162` (executor and repository-only filters) | 1 |
| `fold into #80` (override layer drop) | 1 |
| `won't fix` (reason in the row) | 44 |
| none: already fixed | 18 |
| **Total** | **118** |

Proposed issues (the `file issue (Nx)` tag in the table):

| Tag | Proposed issue | Findings |
|---|---|---|
| N1 | Executor: slot release, lock release and purge fail open | 5 |
| N2 | Executor: integration lineage, regression runs, breaker window and failing-file reporting | 5 |
| N3 | Executor: restart and recovery edge cases | 10 |
| N4 | Executor: start, adopt, hot reload and dispose lifecycle | 6 |
| N5 | Re-probe the host contract on OpenCode 2.3+ (C16, turn-state tail, role spikes) | 4 |
| N6 | Plan executor on POSIX | 2 |
| N7 | Test hygiene: flaky and vacuous tests, coverage leftovers, missing smoke points | 11 |
| N8 | Observation and visibility gaps outside the soak | 5 |
| N9 | Node engine floor vs `.ts` type stripping | 1 |

Most worth an issue:

1. **QA-5.1-28 (N1):** `purge` removes the refs and the ledger even when the pool reported slots it could not remove
   (EBUSY, lock mismatch). Checked in `src/executor/runtime.ts:6030-6041`. It fits what the 2026-11-27 close-out found:
   two DF-2 slots left as locked worktree entries with no ledger (not proven to be the cause).
2. **R2-5 (N5):** C16 (no orphaned child resumed after a host restart) was probed on 2.0.26 only. OpenCode 2.3+ changed
   native child handling (#167, #174), so the hypothesis is now worth testing.
3. **R2-pre-3 (N1):** `resetSlotContents` logs a failed `reset`/`clean` and returns, so the relaunched attempt starts in
   a slot that was not reset. Checked in `src/executor/runtime.ts:4798-4805`.
4. **3.2-m2 (N2):** `firstUpstream` still takes the oldest journaled upstream
   (`src/executor/integrate/queue.ts:1314-1326`), so a reused retry branch could replay another task's reverted change.
5. **N-3 (N1):** `slotHeldBy` answers "held" when the pool lookup throws (`src/executor/runtime.ts:1489-1495`), so a
   release gate fails open.
6. **QA-4.2-42 (N3):** `sameToplevel` uses plain `realpathSync` (`src/executor/recovery.ts:120-123`). An 8.3 short-name
   toplevel marks the repository's own plans as foreign. This is a one-line fix.
7. **G-16 and QA-62C-15 (N6):** the plan executor's slots, provisioning and environments are Windows-first, and the
   executor-home deny fails open off Windows for a repository shared with a Windows host.
8. **m-B (N7):** the `2b2cb58` restart-while-verifying path still has no smoke restart point (none found in
   `test/smoke`).
9. **Oracle-R3-P2-1..3, R2-2, R2-10 (fold into #140):** `scripts/soak-analyze.mjs:94, :671` loads the G8 and idle
   smoke oracles that the Oracle findings and R2-10 describe, and R2-2 can cut the observation stream the analyzer
   reads, so all five can skew the soak's evidence. Settle them before the soak is analysed.
10. **G-10 (N7):** load-sensitive tests keep failing under full parallel runs. This may overlap the flaky-test work on
    the `test/stabilize-flaky` branch (issue number not verified).

Limits: the scope of open issues #108 and #175 could not be read from this repository (no reference in the docs,
CHANGELOG or git history read for this file), so nothing is folded into them. No deferred finding was matched to #161.
"Not verified" means the row repeats the report and the current code was not checked. Severity is quoted as recorded
("not recorded" where the report gives none).

## Findings

Status: `open` (with `checked: file:line` when re-checked today, else "not verified"), `fixed since <ref>`, or
`obsolete` / `superseded` with its reason. Triage `none` means already fixed.

| ID | Source | Summary | Area | Severity | Status | Triage |
|---|---|---|---|---|---|---|
| 0.1-r3-a | phase-0.1.md:138 (deferred :143) | Withdrawal premise (tools breakpoint stays 5-minute) recorded, not asserted; two C6 check texts said "D5 decision". | docs | minor/nit (round 3) | obsolete: D5 TTL withdrawn; "D5 decision" no longer in ADR 0007 (grep) | won't fix (ADR 0007 Accepted; nothing left to assert) |
| 0.1-r3-b | phase-0.1.md:138 | ADR evidence header names `7b11504`; the D5 withdrawal and the C14 binding cite no run. | docs | minor/nit (round 3) | open: header still names `7b11504` (`docs/adr/0007-critical-path-execution.md:8`); citations not verified | won't fix (historical evidence header of an Accepted ADR) |
| 0.1-r3-c | phase-0.1.md:138 | Host-contract smoke does not assert `progressTookMs ≥ 2000` or `directoryAfter`. | test hygiene | minor/nit (round 3) | open, not verified | file issue (N7) |
| 0.1-r3-d | phase-0.1.md:138 | ADR D13 does not mention `interrupted` as uncounted. | docs | minor/nit (round 3) | open, not verified | won't fix (ADR wording; behaviour unaffected) |
| 0.1-r3-e | phase-0.1.md:138 (to 3.1) | ADR and plan show the launch header without ` nonce=<32 hex>`. | docs | minor/nit (round 3) | open, not verified | won't fix (ADR and plan are historical; the launcher code is the reference) |
| 0.1-r3-f | phase-0.1.md:138 (to 3.1) | Plan 3.1.4 acceptance does not pin the prompt order. | test hygiene | minor/nit (round 3) | not verified (3.1 owned the launcher tests; see QA-3.1-9/-16) | won't fix (plan acceptance text is historical) |
| 0.1-r3-g | phase-0.1.md:138 | O11(b) wording. | docs | nit (round 3) | open, not verified | won't fix (wording only) |
| 0.1-r3-h | phase-0.1.md:138 | Probe-mode list misses `cache-hint-1h-all`. | docs | nit (round 3) | open: not in ADR 0007 (grep) | won't fix (probe mode of the withdrawn TTL decision) |
| QA-1.1-29 | phase-1.1.md:43 | `cancelStart` on a null child loses the timing row of a child that ran, then errored. | observation accuracy | minor | obsolete: accepted in the 2.1 wiring contract (phase-1.1.md:50); the estimator reads succeeded rows only | won't fix (accepted trade-off) |
| QA-1.1-30 | phase-1.1.md:43 | Dispatch start must not be recorded inside `commit` (it returns early under `static`). | other | minor | obsolete: consumed by 2.1.5.c (phase-1.1.md:49); not re-verified | won't fix (wiring done in 2.1) |
| QA-1.1-31 | phase-1.1.md:43 | A hook-chain rejection needs no start call. | other | minor | obsolete: consumed by 2.1.5.c (phase-1.1.md:49); not re-verified | won't fix (wiring done in 2.1) |
| QA-1.2-12 | phase-1.2.md:107 | ADR 0007 D4/O12 text out of step with the implementation. | docs | not recorded | fixed since A-1.2-1, applied at the merge into `cpx/main` (per the report); not re-verified | none |
| QA-1.2-16 | phase-1.2.md:107 | Plan 1.2 text (≈1329/1409/1416) out of step with the implementation. | docs | not recorded | fixed since A-1.2-1, applied at the merge (per the report); not re-verified | none |
| 1.2-r3-a | phase-1.2.md:108 | Turn-state tail when no router hint qualifies (the host marks it); observable only on real hosts. | observation accuracy | minor (round 3) | not verified: carried to the DF-1 pre-flight; no record found in dogfood.md | file issue (N5) |
| 1.2-r3-b | phase-1.2.md:108 | Turn-state placement with provider-executed tool results; observable only on real hosts. | observation accuracy | minor (round 3) | not verified: carried to the DF-1 pre-flight; no record found in dogfood.md | file issue (N5) |
| 1.4-engines | phase-1.4.md:1150 (Handoffs) | `engines` allows Node 22.0–22.17, but the coverage-merge `.ts` imports need type stripping (≥ 22.18). | other | pre-existing, not assigned | open: checked `package.json:27` (`"node": ">=22"`) | file issue (N9) |
| 2.1-r3-a | phase-2.1.md:795 | `ref` records are not rewritten by a pending-journal recreate. | other | minor (round 3) | open, not verified | won't fix (fails safe: those references cannot be restored, nothing wrong is restored) |
| 2.1-r3-b | phase-2.1.md:795 | `restoredTaskArgs` ignores the journaled `workRoot`. | other | minor (round 3) | open, not verified | won't fix (same behaviour as the live background gate) |
| 2.1-r3-c | phase-2.1.md:795 | Test-only settled seam can hang on a held gate whose settle throws before `claim.settle`. | test hygiene | minor (round 3) | open, not verified | file issue (N7) |
| 2.2-cov | phase-2.2.md:47 | Eight unreachable `src/executor/ledger.ts` branches (e.g. the never-called `sameStrings`). | test hygiene | minor | open: `sameStrings` still defined (`src/executor/ledger.ts:304`); other branches not re-checked | file issue (N7) |
| 2.4-a | phase-2.4.md:603 | Provisioning M1/M2 measured on fixtures and stand-ins, not on a large pnpm project. | other | not recorded | open, not verified | won't fix (disclosed measurement limit; revisit if provisioning time shows in real use) |
| 2.4-b | phase-2.4.md:604 | git-lfs and submodules are not set up in slots. | executor fail-closed | known limitation | open, partly addressed: landing into a checkout with populated submodules is refused, and a global-only filter is not applied by the executor's git (CHANGELOG [Unreleased]) | fold into #162 |
| 2.4-c | phase-2.4.md:604 | Provisioning runs repository-controlled code (credentials stripped). | other | known limitation | open by design (memo §10.6) | won't fix (trust model by design) |
| 2.4-d | phase-2.4.md:605 | CHANGELOG entry left to the orchestrator until the executor ships. | docs | not recorded | obsolete: the executor shipped in 2.9.0 with CHANGELOG entries (`CHANGELOG.md:192`) | won't fix (obsolete) |
| 2.4-e | phase-2.4.md:606 | Per-finding dispositions of QA rounds 1–2 not recorded in the report. | docs | not recorded | open (record gap) | won't fix (reports are historical and not edited) |
| 3.1-r3-a | phase-3.1.md:610 | Tiers mode: a launcher prompt hand-dispatched through `task` gets the tier header first, so M41 treats it as ordinary. | other | minor (round 3) | open by design | won't fix (by design; roles mode is covered) |
| 3.1-r3-b | phase-3.1.md:612 | Interleaved captures C1, C2, C1 recount the loss streak (only the last capture is remembered). | observation accuracy | minor (round 3) | open, not verified | file issue (N8) |
| 3.1-r3-c | phase-3.1.md:613 | The capture key is `callID` only, not boot id or epoch. | observation accuracy | minor (round 3) | open, not verified | file issue (N8) |
| 3.1-r3-d | phase-3.1.md:614 | Test gaps: the streak's ignore branch, the parallel test's second-round count, an M41 fallback test with `{type:"user", text}`. | test hygiene | minor (round 3) | open, not verified | file issue (N7) |
| 3.1-wake | phase-3.1.md:616 | `WakeReason` has no `plan-refused`; the refusal wake goes out as `inbox`. | other | not recorded | open: checked `src/executor/runtime.ts:818-819` | won't fix (works through the inbox wake; type cleanup only) |
| 3.2-m2 | phase-3.2.md:892 | `firstUpstream` takes the oldest journaled upstream; a reused retry branch could replay another task's reverted change. | executor fail-closed | minor (round 3) | open: checked `src/executor/integrate/queue.ts:1314-1326` | file issue (N2) |
| 3.2-m3 | phase-3.2.md:894 | `release()` swallows a failed compare-and-delete and leaves its lock file; same-host waiters wait for the process to exit. | executor fail-closed | minor (round 3) | open, not verified | file issue (N1) |
| 3.2-m4 | phase-3.2.md:896 | A culprit with no ids, rebuilt from history after the suite commands failed to resolve, gets no regression run. | executor fail-closed | minor (round 3) | open, not verified | file issue (N2) |
| 3.2-cov | phase-3.2.md:897 | A task cancelled between the post-lock re-check and the `openEntry` batch only logs `not-verified-at-batch`. | executor fail-closed | not recorded (coverage note) | open, not reproduced, not verified | won't fix (no reproduction; revisit with one) |
| QA-4.1-r3-a | phase-4.1.md:65 | The `router_plan` tool description is shorter than the result text. | docs | minor (round 3) | open, not verified | won't fix (mitigated: the result text always precedes approval) |
| QA-4.1-r3-b | phase-4.1.md:66 | The auto-approve failure hint names `action=approve`. | docs | minor (round 3) | open, not verified | won't fix (correct for configured consent; `auto` is global-only) |
| 4.1-realpath | phase-4.1.md:67 | `realpathOfExistingPrefix` mangles a bare `C:` tail, consistently on both sides. | other | not recorded (no effect) | open: function unchanged at `src/router/config.ts:1984`; behaviour not re-checked | won't fix (no effect: both sides are mangled alike) |
| QA-4.2-31 | phase-4.2.md:435 | A held task whose slot record vanished while its leases are held elsewhere loses the hold and gets a misleading item; stuck until a restart. | executor fail-closed | minor (round 3) | open, not verified | file issue (N3) |
| QA-4.2-32 | phase-4.2.md:437 | The trailer search uses `log --all` but re-provisions from the task branch tip. | executor fail-closed | minor (round 3) | open, not verified | file issue (N2) |
| QA-4.2-33 | phase-4.2.md:439 | The takeover gate in `start` uses `recoverable`; a same-repo plan with a stale lock is not attached until adopt or restart. | executor fail-closed | minor (round 3) | open, not verified (executor ownership was re-scoped per repository since, CHANGELOG [Unreleased]) | file issue (N3) |
| QA-4.2-34 | phase-4.2.md:441 | The qa-unparsable park marker is not added to `p.fed`. | other | minor (round 3) | open, not verified | won't fix (one extra, harmless evaluation) |
| QA-4.2-35 | phase-4.2.md:442 | `reattachAfterFailedAdopt` attaches without the foreign flag. | executor fail-closed | minor (round 3) | superseded: A-5.1-14 decides foreignness of the failed-adopt re-attach from a read-only snapshot (phase-5.1.md:243); not verified in code | won't fix (superseded by A-5.1-14) |
| QA-4.2-36 | phase-4.2.md:443 | `RecoveryDeps.toplevel` and `RuntimeDeps.toplevel` are two sources of truth. | other | minor (round 3) | superseded: handed to the 5.1 assembly to derive one from the other (phase-4.2.md:460); not verified | won't fix (handled in 5.1 assembly per handoff) |
| QA-4.2-37 | phase-4.2.md:445 | Compile and approve never check foreignness; a plan file of another repo runs here. | executor fail-closed | minor (round 3), pre-existing | superseded: A-5.1-14 makes compile decide foreignness and refuses every mutation of a foreign plan (phase-5.1.md:243); not verified in code | won't fix (superseded by A-5.1-14) |
| QA-4.2-38 | phase-4.2.md:446 | A cancelled commit failure drops out of the circuit-breaker window. | executor fail-closed | minor (round 3) | open, not verified | file issue (N2) |
| QA-4.2-39 | phase-4.2.md:447 | `executor-runtime-coverage.test.ts` keeps a stale skip list and an unused `mk` harness. | test hygiene | minor (re-check) | open, not verified | file issue (N7) |
| QA-4.2-40 | phase-4.2.md:449 | `adoptChild` re-binds a child the attempt does not record before probation drops the watch. | executor fail-closed | minor (re-check) | open, not verified | file issue (N3) |
| QA-4.2-41 | phase-4.2.md:451 | Negative assertions after a fixed `pause(20)` or `pause(50)` can pass vacuously on a slow runner. | test hygiene | minor (re-check) | open, not verified | file issue (N7) |
| QA-4.2-42 | phase-4.2.md:453 | `sameToplevel` uses plain `realpathSync`; an 8.3 short-name toplevel marks this repository's plans foreign (fail-closed). | other | minor (re-check) | open: checked `src/executor/recovery.ts:120-123` | file issue (N3) |
| QA-4.2-43 | phase-4.2.md:455 | Coverage skip lists cite raw line numbers instead of function names. | test hygiene | minor (re-check) | open, not verified | file issue (N7) |
| QA-5.1-28 | phase-5.1.md:221 | `purge` ignores `reported` slots (EBUSY, lock mismatch) and still removes the refs and the ledger. | executor fail-closed | minor (deferred) | open: checked `src/executor/runtime.ts:6030-6041` (refuses only on unsaved-work notes) | file issue (N1) |
| QA-5.1-29 | phase-5.1.md:222 | A hot-reload copy that starts while the old copy still has `/plan` registered reads it as a user command. | other | minor (deferred) | open, not verified | file issue (N4) |
| QA-5.1-30 | phase-5.1.md:223 | A verdict in the dispose micro-window, or a check failure before a cut, is re-verified, not journaled. | executor fail-closed | minor (deferred) | open, not verified | won't fix (fails safe: re-verified, never lost) |
| QA-5.1-32 | phase-5.1.md:225 | An `adopt` that throws partway leaves the executor adopted but not started. | executor fail-closed | minor (deferred) | open, not verified | file issue (N4) |
| QA-5.1-33 | phase-5.1.md:226 | Start begins before the retry hook is awaited; `runtime.start()` does not check `disposed`. | executor fail-closed | minor (deferred), pre-existing | open, not verified | file issue (N4) |
| QA-5.1-34 | phase-5.1.md:227 | A narrow window where one early host retry of a plan child is not stopped. | executor fail-closed | minor (deferred) | open, not verified | file issue (N4) |
| 5.1-progress | phase-5.1.md:228 | "Now I'll run the tests" is not taken as a progress note (`checker.ts:85`); shared with dispatches. | other | not recorded | open, not verified | won't fix (shared heuristic, not a plan-task gap per the report) |
| QA-0.P-25 | preflight.md:228 | Handover §4.1 says a new worktree gets authority only by glob or restart; a refresh after a config change also re-registers. | docs | minor | obsolete: dogfood ended 2026-11-27 (6.2.5); the DF-1 pre-flight re-check is not verified | won't fix (obsolete) |
| QA-0.P-26 | preflight.md:230 | Plan DF-2 pre-flight misquotes the unknown-key notice ("…key: executor"). | docs | minor | obsolete: DF-2 is over | won't fix (obsolete) |
| QA-0.P-27 | preflight.md:233 | A build that knows `routing.executor` but rejects a value drops override layers; validate DF-2 keys with the DF-2 loader. | docs | minor | obsolete as a procedure; the layer drop itself is #80 (key-path drop in CHANGELOG [Unreleased]) | fold into #80 |
| QA-0.P-28 | preflight.md:236 | DF1.4.a / DF2.4.0 `git -C <root> rev-parse HEAD` no longer defines `<root>`. | docs | minor | obsolete: dogfood worktrees removed 2026-11-27 | won't fix (obsolete) |
| QA-0.P-29 | preflight.md:238 | DF1.4 / DF2.4 Reads lines omit the regenerated dogfood `opencode.json`. | docs | minor | obsolete: dogfood is over | won't fix (obsolete) |
| QA-0.P-30 | preflight.md:240 | Plan §0.12-6.1 still says "previous dogfood worktree" (0.P.6 governs). | docs | nit | obsolete: dogfood is over | won't fix (obsolete) |
| QA-0.P-31 | preflight.md:242 | Handover §7 policy wording: five patterns, which exclude `omr-cpx-dogfood-*`. | docs | nit | obsolete: dogfood is over | won't fix (obsolete) |
| sync1-v1 | sync-1.md:49 | `smoke:v1` not run (no OpenCode 1.x executable); v1 paths reviewed by reading. | test hygiene | not recorded | fixed since the 6.2 final gate: `smoke:v1` 27 passed, 11 skipped (global.md:389) | none |
| pdf2-1 minor-2 | pdf2-1.md:85 | A budget resume of a restart-adopted child loses its advisory `CAP:12` read cap. | other | minor | open, not verified | won't fix (caps are advisory) |
| pdf2-1 minor-5 | pdf2-1.md:88 | Adopting an aborted plan orphans the abort's cleanup. | executor fail-closed | minor, pre-existing | open, not verified | file issue (N3) |
| pdf2-1 minor-6 | pdf2-1.md:89 | On Windows the quarantine rename fails with `EXDEV` when `slotsDir` is on another drive. | other | minor | open, not verified | won't fix (EXECUTOR.md's Windows notes require slots on the same drive) |
| N-1 | pdf2-1.md:123 | A READY dependent's save in `releaseBlockedSlot` runs outside the task lock. | executor fail-closed | minor | fixed since G-1 (global.md:68, :124) | none |
| N-5 | pdf2-1.md:124 | READY dependents' saves delay cancelling the live dependents. | other | minor | fixed since G-1's N-1 change (global.md:69, :125) | none |
| relaunch-during-sweep | pdf2-1.md:125 | A blocked task relaunched while `sweepBlocked` is still saving would share the slot. | executor fail-closed | minor | open per the report; G-1's re-check just before `launcher.launch` (global.md:98-101) may cover it; not verified | won't fix (not reachable through row 34) |
| N-3 | pdf2-1.md:126 | `slotHeldBy` returns true when the pool lookup fails; as a release gate it should fail closed. | executor fail-closed | nit, pre-existing | open: checked `src/executor/runtime.ts:1489-1495` | file issue (N1) |
| N-4 | pdf2-1.md:127 | `blockedSweeps` entries are not removed when the queue's release never runs. | other | nit | open, not verified | won't fix (at most one entry per task) |
| Scope-P3 | phase-6.1.md:644 | `failingFiles` reporting is wrong for explicit `cwd` overrides. | observation accuracy | P3 | open, not verified | file issue (N2) |
| Oracle-R3-P2-1 | phase-6.1.md:645 | The oracle does not correlate the verification candidate with the checked candidate. | observation accuracy | P2 | open, not verified; the soak analyzer loads the smoke oracles (`scripts/soak-analyze.mjs:94, :671`) | fold into #140 |
| Oracle-R3-P2-2 | phase-6.1.md:646 | Required-service coverage is component-level, not operation-level. | observation accuracy | P2 | open, not verified | fold into #140 |
| Oracle-R3-P2-3 | phase-6.1.md:647 | Abnormal service spans can include post-exit drain/kill tails. | observation accuracy | P2 | open, not verified | fold into #140 |
| R2-2 | phase-6.1.md:648 | A graph row per metric-only batch can exhaust the 16 MiB observation cap. | observation accuracy | minor | open, not verified | fold into #140 |
| R2-3 | phase-6.1.md:649 | No `assertLive()` after the queued base lookup; a hung lookup blocks claims for up to 120 s. | executor fail-closed | minor | open, not verified | file issue (N3) |
| R2-4 | phase-6.1.md:650 | G9 normalization can excuse a lost attempt in the uninterrupted baseline. | test hygiene | minor | fixed since 6.2.FIX (global.md:72, :193) | none |
| R2-5 | phase-6.1.md:651 | A host that resumes orphaned children would invalidate C16's premise; only 2.0.26 is pinned. | other | minor (hypothesis) | open; OpenCode 2.3+ changed native child handling (#167, #174) and C16 was not re-probed there; not verified | file issue (N5) |
| R2-6 | phase-6.1.md:652 | Open `\w*` risk-vocabulary terms are logged verbatim. | observation accuracy | nit | open, not verified | file issue (N8) |
| R2-7 | phase-6.1.md:653 | Snapshot stage labels omit `harden`/`finalize`. | observation accuracy | nit | open, not verified | file issue (N8) |
| R2-8 | phase-6.1.md:654 | The G9 session assertion is always true. | test hygiene | nit | fixed since 6.2.FIX (global.md:73, :200) | none |
| R2-9 | phase-6.1.md:655 | CHANGELOG/ROLES describe `roleFloor` as "global only". | docs | nit | fixed since 6.2.FIX (global.md:74, :189) | none |
| R2-10 | phase-6.1.md:656 | The idle oracle accepts multiple pre-launch capacity re-inits. | observation accuracy | nit | open, not verified; the soak analyzer loads the idle oracle (`scripts/soak-analyze.mjs:94`) | fold into #140 |
| R2-pre-1 | phase-6.1.md:657 | Interrupted provisioning reruns while its install lock is already stale. | executor fail-closed | not assigned, pre-existing | open, not verified | file issue (N1) |
| R2-pre-2 | phase-6.1.md:658 | Restart re-verification can overlap the dead server's verification tree. | executor fail-closed | not assigned, pre-existing | open, not verified | file issue (N3) |
| R2-pre-3 | phase-6.1.md:659 | `resetSlotContents` swallows a failed reset. | executor fail-closed | not assigned, pre-existing | open: checked `src/executor/runtime.ts:4798-4805` (a failed WIP save now keeps the slot, :4794-4796) | file issue (N1) |
| Recovery-R1-m1 | phase-6.1.md:660 | `closePlan` waits beyond `PLAN_TASK_ABORT_MS`; non-grader work continues. | executor fail-closed | minor | open, not verified (the adapter's 30 s disposal bound in CHANGELOG [Unreleased] is another layer) | file issue (N4) |
| Recovery-R1-m2 | phase-6.1.md:661 | An in-flight grader dispatch is absent from the snapshot; `accept()` is abandoned, not drained. | executor fail-closed | minor | open, not verified | file issue (N4) |
| Recovery-R1-m7 | phase-6.1.md:662 | Parked recovered work has no inbox item, counter or observation. | observation accuracy | minor | open, not verified | file issue (N8) |
| Recovery-R1-n1 | phase-6.1.md:663 | `applyFeed` has an unreachable `requeue-lost` guard. | other | nit | open, not verified | won't fix (harmless guard; m-A, its reason to keep, was fixed by G-1) |
| Recovery-R1-n2 | phase-6.1.md:664 | Lease-held recovered work can request a spurious wake. | other | nit | open, not verified | file issue (N3) |
| Recovery-R1-n3 | phase-6.1.md:665 | The recovery test has a stranded attempt-2 expectation. | test hygiene | nit | open, not verified | file issue (N7) |
| Recovery-R1-n4 | phase-6.1.md:666 | Aborted attachments leave stale `recoveredWork` entries. | executor fail-closed | nit | fixed since `013a529` (pdf2-1 merge; round 4 minor-1) | none |
| N1 | phase-6.1.md:667 | A cached running observation's `git status` can hold `index.lock` against a new attachment's commit or checks. | executor fail-closed | minor | open, not verified | file issue (N3) |
| N2 | phase-6.1.md:668 | Cut verification drops record/change-store ids; the restart fallback can cost a counted `unverifiable`. | executor fail-closed | minor, pre-existing | open, not verified | file issue (N3) |
| N3 | phase-6.1.md:669 | An admission identity mismatch drops a parked end's bookkeeping and leaks its token. | executor fail-closed | minor | fixed since pdf2-1 round 4 (pdf2-1.md:84), merged in `992816b` | none |
| N4 | phase-6.1.md:670 | m3's background queuing is reached only by two tests that await `onChildEnd` before the native end. | test hygiene | nit | open, not verified | won't fix (correct and exactly-once per QA) |
| N5 | phase-6.1.md:671 | Unwrapped recovery paragraph in EXECUTOR.md. | docs | nit | fixed in the 6.1 docs round | none |
| N6 | phase-6.1.md:672 | `registerRecoveredWork` keys by the latest attempt rather than the end's `n`. | executor fail-closed | nit | open: checked `src/executor/runtime.ts:1261-1265` | won't fix (safe under the ledger rule that the open attempt is the latest) |
| m-A | phase-6.1.md:673 | Lease-loss recovery can discard a finished end (uncounted lost attempt and relaunch). | executor fail-closed | minor | fixed since G-1 (global.md:70, :126) | none |
| m-B | phase-6.1.md:674 | The `2b2cb58` restart-while-verifying path has unit coverage only; no smoke restart point. | test hygiene | minor | open: no such smoke point found in `test/smoke` (search) | file issue (N7) |
| m-C | phase-6.1.md:675 | `smoke:v1` declared gap (no OpenCode 1.x executable). | test hygiene | minor | fixed since the 6.2 final gate: 27 passed, 11 skipped (global.md:389) | none |
| m-E | phase-6.1.md:676 | Out-of-plan `routing.roleFloor: "gated"` and `trace.riskSources` need disclosure. | docs | minor | fixed since 2.9.0: both in its CHANGELOG (`CHANGELOG.md:200`, `:204`); the PR #116 body was not checked | none |
| m-G | phase-6.1.md:677 | The soak analyzer imports test helpers at runtime and needs Node ≥ 22.13. | docs | minor | fixed since 6.2.FIX: Node requirement documented (global.md:71, :187); the runtime import remains (`scripts/soak-analyze.mjs:94`, see 1.4-engines) | none |
| m-H | phase-6.1.md:678 | Port the applicable executor fixes to `cpx/pdf2-1` and re-check `4070b22`. | other | minor | fixed since pdf2-1 rounds 4–5 (re-check closed, pdf2-1.md:129), merged in `992816b` (global.md:5) | none |
| MA-2 | phase-6.1.md:679 | Soak-analyzer subcase statuses needed correction. | observation accuracy | major | fixed in `6e643fd` | none |
| G-10 | global.md:491 | Load-sensitive tests (QA-DF1-17, QA-2.3-2, the 50-concurrent depth-guard walk, the node-npm G8 case) fail under load. | test hygiene | minor, test | open, not verified | file issue (N7) |
| G minor-5 | global.md:494 | N-B residual window: low-confidence edge, no reproduction. | executor fail-closed | not stated (low confidence) | open | won't fix (no reproduction; a fix would be speculative) |
| G-14 | global.md:496 | role-spikes S11 fails identically at `origin/master` (host drift; cause not proven). | test hygiene | minor, pre-existing | open, not verified | file issue (N5) |
| PF-4 | global.md:498 | routing-engine smoke `5-advisor` fails (pre-existing, also at `7181165`). | test hygiene | not stated | open, not verified | file issue (N7) |
| QA-62C-15 | global.md:499 | Off Windows, a bare repository or a `gitdir: D:/…` pointer under WSL resolves no common directory, so no executor-home deny. | POSIX | low | open, not verified | file issue (N6) |
| QA-62C-18 | global.md:502 | A heartbeat side file is left on a write error; a long failure streak leaks tmp files. | other | low | open, not verified | won't fix (cleaned at the next acquire) |
| QA-62C-19 | global.md:504 | Wording cleanups: double log prefix, one 5 s in-flight wait, Windows leases-off asymmetry. | docs | info | open, not verified | won't fix (info-level wording) |
| G-4 follow-up | global.md:514 (Handoffs) | Ordinary verification's `verify/wiring.ts` test search and committed-diff call still use bare git. | other | minor (G-4) | fixed since #141: git by absolute path (`src/verify/wiring.ts:1398`, `:1414`; `CHANGELOG.md:125`) | none |
| G-16 | global.md:517 (Handoffs) | POSIX support for the plan executor (slots root, provisioning, environments). | POSIX | not stated | open, not verified | file issue (N6) |
