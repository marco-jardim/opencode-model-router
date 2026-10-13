# origin/master sync 1 — release 2.8.0 into cpx/main

Owner decision 2026-10-13: sync before Phase 5.1. Base `5c2aa75` (tag `cpx/sync1-base`), theirs `6ec3faa` (v2.8.0,
cross-repo #107/#110), merge-base `b716ee9`, 170 commits. Worktree `D:\git\omr-cpx-sync1`, branch `cpx/sync1`,
fast-forwarded into `cpx/main` at `a7889e2`.

## Merge

`83f90e7`: 14 conflicted files (28 hunks) resolved keeping both sides. Decisions:
- `src\index.ts`: master's inline verification changes (check placements, tier refusal, capture root, deferred branch
  switch, new `prepareVerification` arguments) ported into cpx's `finishDispatch`.
- `src\verify\pending.ts`: master's `returnedTree`, `unattributedWriters`, `placements` journaled and validated on
  restore; `perimeter` journaled only as `hadPerimeter`, restored as UNVERIFIABLE `perimeter lost in restart`.
- `src\router\git-tools.ts`: cpx's lease listing filter also on master's `root=` path, keyed by the inspected
  checkout (DF-1.1-4).
- `src\router\roles.ts`: one work-root rule.
- Stale `test\unit\config-depth-effort.test.ts:406` assertion fixed (a587a80 notice change, QA-4.1-21; failed on
  cpx/main since a587a80, passed on master).

## Findings

| Round | Reviewer | Commit | Findings | Status |
|---|---|---|---|---|
| 1 | `ses_ecb6fb5b3ffe2slDGfrRvqg246` | `83f90e7` | 1 critical (QA-SYNC1-1 background carried resume could PASS with no process, pre-existing on cpx/main), 2 major (-2 cross-repo checks misfire in background role dispatches; -3 restored held entry re-gated with fewer checks), 4 minor (-4..-7), 4 nits (-8..-11) | fixed in `7d08a6e` |
| 2 | `ses_ecb6fb5b3ffe2slDGfrRvqg246` | `7d08a6e` | -2, -6 partial; no blocking/critical/major; 2 minor (-12 carried resume classed deferred; -13 restored gate lacks the routed-role record), 5 nits (-14..-18) | fixed in `a7889e2` |

## Fixes

- Round 1 `7d08a6e`: routed-role record kept until the finish settles (-1, -2); restored work root used (-2); dispatch
  head, unattributed writers and perimeter fact journaled for held entries, restored held entries re-run the branch check
  and settle in place (`noDefer`; a restored held entry was re-deferred only after a restart) (-3); VERIFICATION.md (-4);
  approvals refuse the router state directory and executor home (-5); `verifiedAtOnce` (-6); control test (-7);
  CHANGELOG (-8); reference pins/causes round-trip (-9); restored path weight (-10); work-root rule and drift pin (-11).
- Round 2 `a7889e2`: carried resumes held (-12); routed-role snapshot journaled and validated (-13); call args forgotten
  on settle and on `session.deleted`, FIFO skips held/background calls under a hard ceiling, bounds injectable for tests
  (-14); docs pins clause removed (-15); CHANGELOG under Added (-16); restart window wording (-17); one shared git deadline
  for the executor-home check (-18). Design change by the orchestrator in round 1: the dispatch-time head is journaled
  as data, not turned into UNVERIFIABLE, so restored handles keep real verdicts (DF2.4.a).

## Coverage

Orchestrator runs at `a7889e2`: `tsc --noEmit` clean; affected set (187 files: both sides' changed tests, verify,
wiring, pending, v2, git-tools, roles, config, help, protocol, docs-drift, golden, lease, approvals, executor, plan)
10451 passed / 73 skipped. Deviation: under 8 workers four `ladder-effort-wiring`/`v2-background` tests timed out once
(load); they pass in isolation at `7d08a6e` and at `a7889e2`'s predecessor state, and pass in the final 6-worker run.

## Deferred findings

- None open from rounds 1–2. `smoke:v1` not run (needs an OpenCode 1.x executable on `PATH`); the v1 paths were
  reviewed by reading (round 2: everything new is v2-only).

## Verdict

Done at `a7889e2`: two heavy QA rounds, every finding fixed. Fast-forwarded into `cpx/main`.
