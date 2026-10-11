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

### Round 2 (heavy reviewer `ses_ed63cb01fffeMdvA6wja2M3cx2`, at `11b66b1`) — 9 findings (2 major, 4 minor, 3 nit)

Round-1 status: 13 fixed, 4 partial (-2, -4, -9, -10). New: QA-1.1-18 (major) resumed / late-bound dispatches lose or get the wrong timing (single child→call link, irreversible close at start, outcome before bind dropped); -19 (major) label pattern rejected real model ids (`[1m]`) and dropped the row; -20 idle sweep flushed roots with open dispatches; -21 future rows kept in the window; -22 p90 provenance missing; -23 handoff not implementable as written; -24 (nit) silent first-wins acquire options; -25 (nit) untracked appends escaped `flush()`; -26 (nit) `isSideLogLabel` untested.

### Round 3 (heavy reviewer `ses_ed6205b9affePh10w331qTON9Q`, at `30a227e`; majors only) — 1 major

QA-1.1-19 fixed. QA-1.1-18 correct for the tested call orders but not under the handoff's wiring: QA-1.1-27 (major) `bindChild` closes older calls irreversibly, so it may only run on a host-confirmed child; binding at the result then dropped capacity signals for fresh foreground calls. Recorded: -28 (minor) docs stale on labels and the second start; -29 (minor) `cancelStart` on `onCallResult(callID, null)` also drops a child that ran then errored; -30 (minor) under `static` the start must not live inside `commit`; -31 (nit) `cancelStart` at the hook-chain rejection has nothing to drop.

## Fixes

- Round 1 (implementer `ses_ed6601246ffeg5yIFs04MASdh5`, `11b66b1`): starts keyed by `callID` with `bindChild`/`cancelStart`/`setBackground` (-1); a different callID closes the old timing as `unknown` (-2); `acquireTimingRecorder` ref-counted per dir, step/prompt event-id dedupe, end ids consumed only when open (-3); idle-based sweep (`turnIdleMs` 30 min) + `flush()` on release (-4); write-side round-trip validation (-5); handoff (-6); `onRow` + `durationSeamsFor` (-7); `classifyCapacity` (-8); clamped rows `unknown`, future rows ignored (-9); p90 needs ≥ 10 samples (-10); Set-based dedupe (-11); side-log notes on v2 only (-12); `--json` keys tested and documented, USAGE unchanged so v1 `--help` stays byte-identical (-13); docs (-14); recency, `isRootSession`, `onRootStep` boolean (-15); free-name probe + per-path append serialisation (-16); exports (-17).
- Round 2 (implementer `ses_ed628b789ffeHs4FfVhmuUahXi`, `30a227e`): per-child open-call lists, oldest closed first; outcomes for unbound children remembered (200, 10 min) and applied at bind; `cancelStart` leaves older calls alone (-18); labels `/^[!-~]{1,256}$/`, invalid non-id labels become `unknown` (-19); sweep keeps turns with open dispatches (-20); future rows dropped, shared `MAX_FUTURE_SKEW_MS` (-21); `p90Source`/`p90N` (-22); handoff rewritten (-23, below); acquire notices (-24); tracked appends (-25); label tests (-26).
- Round 3 (implementer `ses_ed6124f8affeqPxiGmF6k5KuZD`, `a42ec2a`): capacity signals for unbound children remembered and applied at bind (-27); ROUTING_ENGINE.md label and bind text (-28).
- Verification (orchestrator shell, `a42ec2a`): 8 files / 740 tests green (outcomes-*, persist, stats, routing-advisor, routing-ingest, docs-drift); typecheck 0; `ingest.ts` unchanged since the phase base; coverage timings.ts 94.49/90.21/89.23/95.33, persist.ts 92.56/89.74/96.29/94.1.

## Deferred findings

- QA-1.1-29, -30, -31: wiring concerns, scheduled by the plan in Phase 2.1 (2.1.5.c); carried in the handoff below.

## Handoffs

- **To 2.1 (task 2.1.5.c) — the calls 2.1 must make (replaces the plan's `createTimingRecorder` with `acquireTimingRecorder`):**
  - Construction: on v2, whatever `routing.engine` (incl. `static`), `acquireTimingRecorder({ dir, now, logger, turnIdleMs?, onRow? })` once per plugin instance; `dir` from `resolveOutcomesDir(...)`; instances in one process share the recorder (ref-counted per normalised dir). `/router stats` side-log wiring already exists (`src\routing\commands\stats.ts:88`): do not wire it twice.
  - **Start:** in `v2-hooks` right after the legacy `execute.before` hook succeeds (next to the router's `commit`, ≈1635-1637), only for `subagent`: `recordDispatchStart({ callID: event.id, childSessionID: <final input sessionID for a resume, else null>, parentSessionID, role, class, scope, tier, model, background: input.background === true, at })`. Not inside `commit` (it returns early under `static`, QA-1.1-30); class/scope `unknown` without a routing decision. A hook-chain rejection (≈1633) needs no call (QA-1.1-31).
  - **Bind / background / cancel:** only in `execute.after` (`onCallResult`, ≈1703): non-null child → `bindChild(event.id, child)`, plus `setBackground(event.id, true)` when the result status is `running`; null child → `cancelStart(event.id)` (accepts losing the row of a child that ran then errored, QA-1.1-29; the estimator only uses succeeded rows). Never bind at commit or at the `session.created` claim.
  - **Outcome:** event loop, `session.execution.succeeded|failed|interrupted` → `await onExecutionOutcome(data.sessionID, event.id, outcome, event.created)` (optionally skip when `isRootSession`).
  - **Capacity:** `session.retry.scheduled`, the retry hook, `session.step.failed` → `const c = classifyCapacity({ type, status })`; non-null → `onCapacitySignal(child, c, at)`.
  - **Root turns:** the `prompt` hook (≈1347) → `markRootSession` when `ctx.session.get` shows no `parentID`, then `onRootPrompt(sessionID, at, messageID)` (not awaited); a turn runs from one user prompt to the next including C2 wakes (wakes arrive as `session.synthetic`/execution events, not the prompt hook). Root step events → `onRootStep(sessionID, { input, cacheRead, cacheWrite }, event.id)`. Add a C2 smoke assertion: no `prompt` hook call between the ack and the wake request.
  - Sweep: `await sweep()` on an unref'd 5–10 min interval; dispose: `await holder.release()` (last holder flushes open turns).
  - Estimation: `createDurationModel(durationSeamsFor(createSideLogs(dir, deps), now))`, `await load()`, `observe(row)` from `onRow` only when `row.kind === "dispatch-timing"`.
- From 1.2: `docs\ROUTING_ENGINE.md` ≈122 sentence replaced (1.1.5.b).

## Verdict

PASS after QA round 3 (round-3 major QA-1.1-27 fixed in `a42ec2a`; no round 4 by rule). Remaining minors are 2.1 wiring items in the handoff.