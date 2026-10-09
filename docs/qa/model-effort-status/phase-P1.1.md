# Phase P1.1 — pure status model (#90)

Branch `msd/p11` (worktree `D:\git\omr-msd-p11`), merged into `msd/main` at `ce11159`.

## Pre-flight

`npm run typecheck` green at `439862f` (implementer, `router_run`). Host log: no new `failed to load plugin` lines.

## Implementation

`D:\git\omr-msd-p11\src\tui\status-model.ts` (no imports at all): structural host types (`ModelRef`, `ModelInfo`,
`SessionLike`, `MessageLike` with `type` and legacy `role`, `CreatedTime = number | DateTime.Utc-like`,
`AppliedEffort` with `variant`), `modelLabel`, `effortLabel`, `effectiveMainEffort` (A3 + stale-variant guard),
`latestAssistant`, `childStatus` (A5), `runningChildren` (status checked before session lookup; grandchildren included),
`clampMax`, `displayWidth` / `truncate` / `formatRow` (grapheme-aware, control and bidi characters sanitised to spaces,
first part shrinks first), `parseOptions` (own keys only, one notice).

Commits: `a312beb` (feature), `0dad861` (QA round 1), `675b552` (QA round 2).

## Tests

`D:\git\omr-msd-p11\test\unit\tui.status-model.test.ts`: 148 tests green; v8 coverage of the module 100% statements
(184/184), branches (179/179), functions (37/37), lines (151/151) (executor run). Typecheck green. On `msd/main` after the
merge: 8 touched files, 495 passed / 1 skipped.

## QA

| Round | Verdict | Findings |
|---|---|---|
| 1 (heavy reviewer) | FAIL | F1 major (v2 messages carry `type`, not `role`); F2–F12 minor/nit (host `variants` shape, `DateTime` time, ZWJ, control/bidi characters, row shrink order, header, one notice + own keys, status-before-session, applied variant, `max` clamp, Mc/soft hyphen). All fixed in `0dad861`. |
| 2 (same reviewer) | FAIL | F3 major still open (`epochMilliseconds`, not `epochMillis`; `null` crash); minors F4-r, F5-r, F8 nit. All fixed in `675b552`; executor verified `CreatedTime`/`createdOf` (`status-model.ts:44,202`) and the 100% coverage run. |

No round 3 (round-2 major was a one-line, test-pinned fix verified by the executor). Router verify: `vrf_f7a1ea5c…` pass
(deterministic).

## Takeovers

None (coverage measured by the executor because `router_run test-files` does not accept `--coverage`).

## Verdict

DONE. 0 open blocking/critical/major.
