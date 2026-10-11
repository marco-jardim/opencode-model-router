# Phase 1.1 — Telemetry: dispatch timings, duration model, orchestrator turns

Worktree `D:\git\omr-cpx-p11`, branch `cpx/p11`, base tag `cpx/p11-base` = `4161324`. Started 2026-10-11 01:36.

## Pre-flight

- [x] Depends on 0.1: merged into `cpx/main` (`4161324`) on the owner's instruction to proceed while the 0.1 round-2 follow-ups finish in `cpx/p01`.
- [x] No in-flight phase writes this phase's files (1.2 owns `src\index.ts`; this phase does not touch it — the timing-recorder wiring is the 2.1 handoff).
- [x] Worktree from `cpx/main`, tag pushed, `npm ci`, clean. `npm run typecheck` green.
- [x] Anchors (explorer `ses_ed6bffcdaffenUaigZQ7rRvObZ`) hold: `persist.ts` ≈114-125 `resolveOutcomesDir`, ≈139-164 durable writes/`appendText`, ≈223-254 retry/rename, ≈620 rotation target; `ingest.ts` ≈771-787 `onExecutionEnded` with the `eventId` dedupe at ≈782 (the plan's ≈705-717 is `onStepEnded`), ≈109-131 `ingestSettings` (engine `static` gate at ≈116); `types.ts` `DecisionRow` ≈583-603, constants ≈710-724; `src\index.ts` ≈665 creates ingest only on v2 and `ingestSettings` returns null under `static` (confirms timings need their own module); `runStatsCommand` `src\routing\commands\stats.ts:59`; D18 equality `test\integration\routing-advisor.test.ts` ≈645-661; `routing-ingest.test.ts` ≈1454-1533; `docs\ROUTING_ENGINE.md:122` "It is the last system part…".
- [x] Scoped baseline: `routing-outcomes.persist`, `routing-outcomes.store`, `routing-outcomes.stats`, `routing-ingest` — green (0.P baseline; no change since).
- [x] `smoke:cpx` green (3× at `7b11504`).

## Implementation notes

- 1.1.1 (implementer `ses_ed6afb33effe4jQekcTcdnLjQC`): `DispatchTimingRow` / `OrchestratorTurnRow` in `types.ts` (`startedAt`/`endedAt` epoch ms, `ts` ISO), `SIDE_ROW_VERSION`, `TIMINGS_FILE`, `TURNS_FILE`, rotated-name regexes; `persist.ts` `createSideLogs(dir, deps, options?)` with `appendTimings`/`appendTurns`/`readTimings`/`readTurns` (parallel code to the decision log, decision path untouched), `parseTimingLine`/`parseTurnLine` (declared fields only; labels ≤ 256 chars; finite non-negative counters; future `v` skipped; one warning per read for torn/invalid lines). Router gate timed out (90 s); verified in the orchestrator shell: 4 files / 444 tests green, typecheck 0.

## Findings

## Fixes

## Deferred findings

## Handoffs

- To 2.1 (task 2.1.5.c): create the timing recorder on v2 whatever the engine (recorded when 1.1.2 lands).

## Verdict
