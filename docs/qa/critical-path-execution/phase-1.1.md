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

- 1.1.2 (`ses_ed6a54827ffeGEh5umaUj1W1Sj`) timing recorder `0e99c2b`; 1.1.3 (`ses_ed69d1fb0ffeAvIxLjYMgPpUBL`) estimator + exports `3cec126`; 1.1.4 (`ses_ed698fb89ffeD0zysewZLRltcQ`) stats sections (v2 gate at the call site; v1 output byte-identical; D18 extended) and 1.1.5 (`ses_ed698d377ffeEW2rl7pk7KUPog`) docs `6272d1c`; 1.1.6 (`ses_ed6896031ffeUcgfSzGNP8zPGg`) tests `fe67fd6`. Coverage (orchestrator shell, `npx vitest run --coverage --coverage.include=…`): persist.ts 92.56/89.74/96.29/94.1, timings.ts 96.15/93.44/95/98.21.

## Findings

### Round 1 (heavy reviewer `ses_ed6769b78ffeqw44DhhikTYlg0`, at `fe67fd6`) — 17 findings (1 critical, 5 major, 10 minor, 1 nit)

QA-1.1-1 (critical) starts keyed by child id that 2.1/3.1 do not have; -2 (major) second start with a different callID kept the first; -3 (major) dedupe weaker than ingest (per-instance state, no step/prompt ids); -4 (major) sweep split live turns; -5 (major) labels only validated on read; -6 (major) 2.1 handoff not recorded; -7 no row callback / estimator seam; -8 no shared capacity classifier; -9 clock skew; -10 p90 = max for 5–9 samples; -11 quadratic stats summary; -12 stats notes ignore side logs; -13 `--json` keys untested/undocumented; -14 docs describe unwired behaviour; -15 root-session recency and turn numbering; -16 side-log rotation races; -17 (nit) missing exports.

## Fixes

### Round 1 (implementer `ses_ed6601246ffeg5yIFs04MASdh5`)

All 17 addressed: starts keyed by `callID` with `bindChild`/`cancelStart`/`setBackground` (-1); a different callID closes the old timing as `unknown` (-2); `acquireTimingRecorder` ref-counted per dir, step/prompt event-id dedupe, end ids consumed only when open (-3); idle-based sweep (`turnIdleMs` 30 min) + `flush()` on release (-4); write-side round-trip validation with a token label pattern (-5); handoff written above (-6); `onRow` + `durationSeamsFor` (-7); `classifyCapacity` (-8); clamped rows `unknown`, future rows ignored (-9); p90 needs ≥ 10 samples (else a coarser level or the prior; stats table keeps per-role p90 with `p90MinSamples: 1`) (-10); Set-based dedupe (-11); side-log notes and "no data" on v2 only (-12); `--json` keys tested and documented in ROUTING_ENGINE.md (USAGE text unchanged so v1 `--help` stays byte-identical) (-13); docs corrected (-14); recency on every step/prompt, `isRootSession`, `onRootStep` boolean (-15); free-name probe + per-path append serialisation + two-writer test (-16); exports (-17). Additional choice: p90 is `max(p90, p50)`. Verified in the orchestrator shell: 9 files / 734 tests green, typecheck 0, `ingest.ts` unchanged.

## Fixes

## Deferred findings

## Handoffs

- **To 2.1 (task 2.1.5.c) — the calls 2.1 must make (QA-1.1-6):**
  - Construction: on v2, whatever `routing.engine` (incl. `static`), `acquireTimingRecorder({ dir, now, logger, turnIdleMs?, onRow? })` once per plugin instance; `dir` from `resolveOutcomesDir(routing.outcomes.path, …)`; instances in one process share the recorder (ref-counted per normalised dir).
  - `execute.before` (the router's own dispatch): `recordDispatchStart({ callID, childSessionID: null, parentSessionID, role, class, scope, tier, model, background, at })`; labels must be single tokens (`/^[A-Za-z0-9._:#/@+-]{1,256}$/`) — use `unknown` for an empty scope/class, never free text.
  - Child known (`session.created` / the child match / the tool result carrying the child id / the launcher's `onCreated`): `bindChild(callID, childSessionID)` (re-callable, last wins).
  - `execute.after` with the call rejected (no child ran): `cancelStart(callID)`. Background acknowledgement: `setBackground(callID, true)`.
  - Child `session.execution.*`: `await onExecutionOutcome(childSessionID, event.id, "succeeded" | "failed" | "interrupted", at)` (event id dedupes; consumed only when a start is open).
  - `session.retry.scheduled`, `session.hook("retry")`, `session.step.failed`: `const c = classifyCapacity({ type: error.type, status: error.status })`; if non-null `onCapacitySignal(childSessionID, c, at)`.
  - Root detection (no parent): `markRootSession(id)`; `isRootSession(id)`. Root prompt: `await onRootPrompt(sessionID, at, event.id)`. Root step: `onRootStep(sessionID, { input, cacheRead, cacheWrite }, event.id)` (returns whether counted).
  - Sweep: `await sweep()` on an unref'd 5–10 min interval (closes starts open > 6 h as `unknown`; writes turns idle ≥ 30 min). Dispose: `await holder.release()` (last holder of a dir `flush()`es every open turn).
  - Estimation: observe rows via `onRow`; `createDurationModel(durationSeamsFor(createSideLogs(dir, deps), now))`, `await load()`, `observe(row)` from `onRow`. `/router stats` passes `runStatsCli` a `StatsSideLogs` (`open: dir => createSideLogs(dir, deps)`) on v2 only.

## Verdict
