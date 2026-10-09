# Phase P2.1 — real-host proof (#90)

Branch `msd/p21` (worktree `D:\git\omr-msd-p21`), merged into `msd/main` (`2bbfd11`, fixes `3c71fc1`).

## Pre-flight

`msd/main` `6fb528f` (P1.1–P1.3 merged); `npm ci`; typecheck green. Host log clean.

## Implementation

- `test\smoke\tui-status.smoke.test.ts` (gate `RUN_OC_SMOKE_TUI=1`, Windows only, script `npm run smoke:tui`,
  binaries `OMR_TUI_SMOKE_BINS`, evidence dir `OMR_TUI_SMOKE_OUT`), `test\smoke\helpers\tui-pty.ts` (isolated
  allow-list env, `--standalone`, pty + `@xterm/headless`, identity-checked process tree: CreationDate-filtered
  children, per-PID re-read, no `taskkill /T`, children first and root last, stray report), additive
  `RoutingProvider.holdMarked` in `test\smoke\helpers\routing-host.ts`, devDependencies `@lydell/node-pty`
  1.2.0-beta.15 and `@xterm/headless` 6.0.0 (exact).
- Flows per version: local path (worktree in the server config only, TUI auto-loaded) and npm install (packed tarball
  installed into a temp `node_modules`, server config only); scripted provider; fast tier variant `low` + effort
  `medium` so the screen must show `medium (low)`.

Commits: `f0b6f7c`, `b8a8766` (QA 1), `78fd594` (QA 2).

## Evidence

`D:\git\omr-msd-main\docs\qa\model-effort-status\p21-smoke-evidence.md`. Summary (runs `b61ffa82`, `549b8690`,
`72d7caea`: 49/49 each, 2.0.24, 2.0.25, 2.0.26, both flows):

| Scenario | Result |
|---|---|
| S1 G1 | footer `effort default`; `ctrl+t` selects a variant → host row shows it and our text disappears; cycling back restores `effort default` |
| S2 G3 | `fast · Claude Sonnet 5.5 · medium (low)` directly above the prompt box while the child runs; gone after it finishes |
| A6 | child request at 0.4–1.0 s, row at 0.5–1.2 s, first token released at 15.4–16.0 s → `status(child)` is `running` before the first token |
| S3 G2 | child view (picker Down, Down, Enter) shows the same row, running and idle |
| S4 | screen effort equals the wire (`claude-sonnet-5-5#low`, effort `medium`) |
| Width | rows on one line with the sidebar open and closed (short rows) |

T2.1.2 (`smoke:v1`): not run locally — the v1 keyless smokes pass the parent environment (provider keys, live
`OPENCODE_*`) to the v1 host (`test/smoke/deferred-catalog.smoke.test.ts:197`). Covered by CI `smoke-keyless`
(OpenCode 1.18.19) on PR #91; no `src` change is reachable from v1. Goldens unchanged (8 files / 88 tests green).

## QA

| Round | Verdict | Findings |
|---|---|---|
| 1 (heavy reviewer) | FAIL | P21-1 major (`taskkill /T` could reach pre-existing processes via stale parent PIDs), P21-2 major (npm-install flow missing), 7 minor (false child-view match, vacuous teardown, deny-list env, fixed sleeps, weak assertions, cleanup gaps, `smoke:v1`), 2 info. Fixed in `b8a8766`; P21-9 by executor decision (CI). |
| 2 | PASS | R2-1..R2-3, R2-5, R2-6 fixed in `78fd594`; R2-4 (node-pty upstream) and R2-7 (v1 smoke env) recorded as follow-ups. |

## Takeovers

The executor wrote the R2-4/R2-7 follow-up text in the evidence doc (the delegate lacked the review text).

## Follow-ups (outside #90)

`RoutingHost.doStop` still uses `taskkill /T`; v1 keyless smokes are not env-isolated. To be filed as an issue.

## Verdict

DONE. 0 open blocking/critical/major.
