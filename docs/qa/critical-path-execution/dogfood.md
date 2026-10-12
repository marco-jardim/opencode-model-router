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

Pending the DF-1 switch (build `cpx/df1`).
