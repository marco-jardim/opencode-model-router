# Phase 2.1 — Telemetry ingestion (M6)

> Plan: `D:\git\opencode-model-router\docs\plans\cost-aware-routing-engine-plan.md` §0.11 "What is measured", §1.2, §1.3 M6, D1, D4, D6, D15, amendments A1, A3, A14, A24, §3 "Phase 2.1".
> Worktree `D:\git\omr-car-p21`, branch `car/p21`, base directory `D:\git\opencode-model-router`. Issue #74.

## Pre-flight

| Item | Result |
|---|---|
| Worktree and branch | `D:\git\omr-car-p21`, branch `car/p21`, created from `car/main` @ `4e73f50`; `git status --short` empty before 2.1.1 |
| Baseline | Full suite on `car/main` @ `88847cb` (merge of phase 1.4) was green: **127 files / 11 036 tests**, as reported by the orchestrator in the dispatch. It was not re-run in this phase (§0.10.6: scoped runs only). |
| `npm ci` | Done in the worktree before the dispatch (orchestrator). |
| **Linear** | **Linear: not used.** There is no Linear key in `D:\git\opencode-model-router\.env` (0 matches for `linear`), and the only `linear` hits under `src`, `test` and `docs\qa\cost-aware-routing` are regex-complexity wording (`linear-time`, ReDoS) and the "Linear: not used" line of `phase-0P.md`. This is consistent with `phase-0P.md`. |
| Dependencies | Phase 1.3 merged: `src\routing\outcomes\{store,cost,persist,stats,types,index}.ts` exist at the base and `acquireOutcomes`, `makeKey` (with `router:`/`host:` origin), `recordStep`/`recordVerdict`/`recordFalseRefusal`, `createFlusher` were read and used as-is. |
| Spike verdicts | **S3 confirmed**: `session.step.ended` reaches `ctx.event.subscribe` with `cost` and `tokens` (`phase-0P.md`, S3 row: raw 1 = deduped 1, `cost 0.01073`, `tokens {input 5340, output 5, reasoning 0, cache {read 0, write 0}}`). **S3b confirmed**: with two live locations the same event (same id) is delivered once per plugin instance (raw 2, deduped 1) → A3: module-scope dedupe set, module-scope registry, single writer per process. |
| Handoffs read | `phase-0P.md` (A1, A3), `phase-1.2.md` ("to 1.3 / 2.1", QA-1.2-27), `phase-1.3.md` ("to 2.1", C5, QA-1.3-6, QA-1.3-15), `phase-1.5.md` ("to 2.3": nothing for 2.1) |
| Typecheck | `npm run typecheck` green after every commit below except `04bf585`, which carried an unused helper that referenced a removed import; `tsc` caught it, fixed in `59699f5` (see Implementation notes) |
| Scoped tests | `npx vitest run test/integration/routing-ingest.test.ts test/unit/v2-hooks.test.ts test/integration/routing-ingest.wiring.test.ts` → `Test Files 3 passed (3)`, `Tests 140 passed (140)`. `npx vitest related src/compat/v2-hooks.ts src/router/sessions.ts src/routing/outcomes/ingest.ts --run` → `Test Files 58 passed \| 3 skipped (61)`, `Tests 1961 passed \| 55 skipped (2016)`. Default pool both times (A14). |
| Real-directory checks (after the runs) | `Test-Path C:\Users\Marquinho\.config\opencode\opencode-model-router.overrides.jsonc` → `False`; `opencode-model-router-trajectory`: 0 `outcomes*`, 0 `decisions*` (one `outcomes.json` created by a deliberate mutation check was removed, see Implementation notes) |

## Implementation notes

### What was built

| Task | File | Commit |
|---|---|---|
| 2.1.1 | `src\router\sessions.ts` — process-scope dispatch registry | `c9d61b9` |
| 2.1.2 | `src\routing\outcomes\ingest.ts` (new), tests `test\integration\routing-ingest.test.ts` (45 tests) | `d921494`, `abd46bb` |
| 2.1.3 | `src\compat\v2-hooks.ts` event loop and cleanup; `src\index.ts` call sites; tests appended to `test\unit\v2-hooks.test.ts` (9 new) and new `test\integration\routing-ingest.wiring.test.ts` (10 tests) | `7e3db28`, `04bf585`, `59699f5` |

### 2.1.1 Registry (`sessions.ts`)

- `rememberDispatch(childSessionID, { facts, agent, model, variant?, tier?, acceptance?, parentSessionID?, attemptId?, decisionID?, step? }, nowMs?)`, `lookupDispatch`, `touchDispatch`, `forgetDispatch`, `forgetDispatchesOf(parent)`, `sweepDispatches(nowMs?, ttlMs?)`, `dispatchCount`, `resetDispatchRegistry` (tests).
- **Module scope** (A3), deliberately unlike the per-instance `createSessionStore`. TTL = `DEFAULT_IDLE_TTL_MS` (1 h) from the last touch, swept from the existing idle sweeper (`index.ts` adds one sweeper line). Bounded to `MAX_DISPATCH_RECORDS = 2000` (oldest registration dropped).
- A re-registration of the same child (a resume, or a ladder attempt) bumps `attemptIndex`; the default `attemptId` is `${childSessionID}:${attemptIndex}` (1.3 handoff). `attemptId` can be supplied.
- **Additions beyond the plan's argument list** (all optional, forward-compatible): `attemptId`, `decisionID` (so verdict/refusal rows can reference the 2.2 decision row, 1.3 handoff), `step` (`LadderStepKind`, default `dispatch`; `AttemptSignal` needs it and 2.3 ladder attempts will pass `variant|retry|escalate`). `acceptance` is typed `string | null` and is carried only; ingestion never reads it.
- `facts` is typed `DecisionFacts` (1.3's structural view; 1.2's `TaskFacts` is assignable).

### 2.1.2 Ingest (`ingest.ts`)

- `createIngest(deps)` returns `{ onStepEnded, onVerdict, onFalseRefusal, onSessionGone, requestFlush, sweep, dispose }`. `deps = { settings, logger, pricing?, now?, acquire? }`. Handlers never throw: every body is `try/catch` with `logger.warn` (no empty catch).
- `ingestSettings(cfg, host)` is `null` unless `host === "v2"` and `resolveRouting(cfg, "v2").engine !== "static"`. With `null`, **no bundle is acquired and nothing touches the disk** (§1.2). The bundle (`acquireOutcomes`, A3) is acquired lazily on the first signal that is actually recorded, and a changed `routing.outcomes.path` re-acquires.
- Order of checks per signal: registered child → settings non-null → class trusted (`facts.confidence ≥ routing.minClassConfidence`, `facts.class` not empty/`unknown`) → key buildable → (step events only) dedupe → record. Registry first because most `session.step.ended` events belong to unregistered sessions (the orchestrator's own) and `loadConfig` costs a fingerprint check.
- Key = `makeKey(facts.class, { origin: classifyAgentOrigin(agent, active tier ids), id: agent }, provider, model, variant)`. The registry only holds `facts.class`, so a backend label can never become a key (A19, QA-1.2-27). `model` comes from the registry (the step event carries no model); `variant` = registry variant, else the `#variant` of the model ref.
- Step: `recordStep(key, { attemptID, cost, pricing: pricingState(catalog cost), tokens: tokenSampleFromEvent(data.tokens), final: data.finish !== "tool-calls" })`. D6/A1 are applied by the store from `pricing`; ingest supplies the pricing from `createCatalogPricing(list)`, a cached (60 s) `provider/model → catalog cost` table over `ctx.model.list({ location: { directory } })` (the call the adapter already makes in `v2-client.ts`). A model absent from the catalog, or a failed load (logged once, retried after 15 s), is `unpriced`.
- Dedupe: module-scope LRU of event ids (`SEEN_EVENT_CAP = 4096`); an event with no id falls back to a content key. The id is marked **only after** the registry, settings, trust and key checks, so an instance whose own settings are static does not consume an event another instance records.
- Superseded attempts: the first step of a new attempt of the same child folds the previous open attempt (`closeAttempt`), so a resumed child is not double counted and a non-final attempt is not left to the 30-min sweep.
- Verdict: `recordVerdict(key, outcome, { attemptID, step })` and one `VerdictRow` per `(attempt, verdict value)`, `unverifiable` included (the store ignores it, the row stays for the statistics). False refusal: `recordFalseRefusal` and one `RefusalRow` per attempt. Order independence (C5/QA-1.3-6) is the store's: refusal first makes a later pass a no-op; a pass followed by a refusal converts the pass into a failure (both tested through ingest).
- A dispatch below `minClassConfidence` (or class `unknown`) gets **no store call and no verdict/refusal row**, so rows and store agree for `routing:stats`. The decision row is 2.2's.
- `onSessionGone(id)`: folds the child's open attempt and forgets its registration; also forgets (and folds) every child registered under `id` as parent; requests a flush if a bundle is held.
- Flush (D15): handlers only update memory and `flusher.enqueue`; `requestFlush()` (coalesced, throttled to 30 s by the 1.3 flusher, never awaited, no-op without a held bundle) is called on `session.idle`, `session.deleted` and the v2 idle equivalents `session.execution.{succeeded,failed,interrupted}` (`FLUSH_EVENT_TYPES`); `sweep()` (registry TTL + `store.sweepAttempts`) runs on the same events and from the idle sweeper. `dispose()` releases the holder, whose last release flushes.

### 2.1.3 Wiring

- `v2-hooks.ts` (event loop and cleanup only; `execute.before` and the context hook untouched): `session.step.ended` → `ingest.onStepEnded(event)` then `continue`; `session.deleted` → `ingest.onSessionGone` before the unchanged legacy translation; the idle equivalents → `ingest.sweep(); ingest.requestFlush()`. Each ingest call goes through a local `ingesting(...)` wrapper that logs and continues, so a throwing handler cannot skip the legacy `session.deleted`/`session.idle` translation. `cleanup` awaits the event task, then `ingest.dispose()`. `registerV2Hooks` gains an optional 4th parameter `{ ingest }` (test injection); by default it builds `createIngest({ settings: () => ingestSettings(loadConfig(ctx.location.directory), "v2"), logger: createPluginLogger(), pricing: createCatalogPricing(...) })`.
- `index.ts` (single-line additions, no behaviour change when `ingest` is undefined): `const ingest = ctx.routerHost === "v2" ? createIngest({ settings: () => ingestSettings(cfg, "v2"), logger }) : undefined`; the idle sweeper gets `() => { ingest?.sweep(); }`; `dispose` awaits `ingest?.dispose()`; the false-refusal block calls `ingest?.onFalseRefusal(childSessionID)` right after `trajectoryStore.recordFalseRefusal`; the native-task verification path calls `ingest?.onVerdict(childSessionID, verdictOf(res.verdict))` after `applyDispatchCaveats`, only for a non-skipped verdict. On v1 `ingest` is `undefined` (D1). The delegate runner is untouched.
- Merged 1.x modules: **no API change**. `src\routing\outcomes\*` gained only the new `ingest.ts`; `sessions.ts` and `index.ts` are router modules edited as listed.

### Self-checks run during the phase (not QA findings)

- `04bf585` carried a leftover helper (`readdirSyncSafe`) whose import I had removed; vitest does not typecheck, `npm run typecheck` caught it; fixed in `59699f5`.
- A mutation check (`if (engine !== "static" || engine === "static")` in `ingestSettings`) was run to prove the static tests bite: the static tests failed as intended (2 of the selected tests), and the mutated run wrote one `outcomes.json` (test data, 902 bytes) to the **real** default directory because a mutated static config resolves the default outcomes path. The file was removed and the source restored (`git diff` clean). Real-directory checks above were taken after that.
- No `as any`, `@ts-ignore` or `@ts-expect-error` in the new code or tests; the two narrow casts in `ingest.ts` are `data.tokens as unknown as StepEndedTokens` (sanitized field by field by `tokenSampleFromEvent`) and `value as ModelPricing` on a non-null object (validated entry by entry by `normalizePricing`).

### Tests (plan §3 "Phase 2.1" Tests paragraph → where)

| Required case | Test |
|---|---|
| fake `ctx.event.subscribe` stream | `v2-hooks.test.ts` "OpenCode 2 telemetry ingestion (M6, event loop)" (real `registerV2Hooks`, queued events, barrier on `session.deleted`) |
| unknown session ignored | integration "ignores a step event for an unknown session and acquires nothing"; v2-hooks "ignores step events of sessions that are not registered children" |
| registered child → cost/tokens | integration "records cost and tokens…"; v2-hooks "records a registered child's steps, with catalog pricing…" (also checks `outcomes.json` after cleanup) |
| `cost: 0` + unpriced → null | integration "D6/A1…" (empty, all-zero and absent pricing), catalog-lookup variant, priced zero kept, positive unpriced cost kept |
| verdict pass/fail/unverifiable | integration "pass, fail and unverifiable…" (store + rows), repeated verdict, unverifiable then pass; wiring tests drive the real `tool.execute.after` verification (pass and fail) |
| false refusal → failure, both orders | integration (alone, before verdict, after a pass); wiring test through the real banner site |
| registry TTL eviction stops ingestion | integration "TTL eviction stops ingestion", "a step refreshes the idle stamp", registry sweep tests |
| flush coalescing | integration "coalesces many rows and many requests into one scheduled flush" (1 timer, nothing on disk before it fires) |
| event loop survives a throwing handler | v2-hooks "survives a throwing handler…", "a throwing session cleanup does not stop the legacy event translation"; integration "an event loop error is logged, and the next event is still ingested" |
| duplicate event id from two instances | integration (same id, concurrent; static instance does not consume; no id → content key); v2-hooks "counts a step once when the same event id reaches two plugin instances (A3)" |
| engine static → no disk writes, no store | integration (settings null, every handler no-op, runtime switch to static); v2-hooks "with no routing block…"; wiring tests (v2 no block, v2 static, v1 shadow) |
| below-threshold confidence → nothing | integration (0.69 vs 0.7, `unknown`, hot-reloaded threshold); v2-hooks; wiring (0.95) |
| 1 000 events < 100 ms | integration "ingests 1 000 step events in under 100 ms" (warm bundle and catalog; one catalog load) |

All tests use `mkdtemp` directories and injected outcomes paths or a redirected `HOME`; none writes to the real trajectory directory or `~/.config/opencode`.

## Findings

None recorded. The adversarial `[tier:heavy]` QA of §0.7 has not run on this phase; this report is the implementation record. Candidate attack points for the reviewer are listed under Handoffs.

## Deferred by plan

- **2.2** — the callers of `rememberDispatch` (decision row, resolved model for host agents, `decisionID`), and the decision rows. Until 2.2 merges, production never registers a child, so ingestion is dormant even with `engine: shadow`.
- **2.3** — the `delegate` runner's producer sessions (verdict at `index.ts` ≈989–1000, `step` kinds, `attemptId` per ladder attempt, `closeAttempt` on a gone producer); QA-1.5-22/R1 resume checks.
- **2.4** — `/router stats` over the flusher/persister (1.3 "to 2.4"); advisor findings.
- **Not wired in 2.1, by the plan's wording** ("the verification `tool.execute.after` path"): verdicts of **deferred** verification (`finishDeferred`) and `router_verify` replays. A deferred dispatch gets no verdict row until a later phase calls `ingest.onVerdict` from `verifyHandles`; recorded here so 2.3/2.4 pick it up.
- **1.3 handoff QA-1.3-15** (existing integration tests writing `*.delegate.log` into the real trajectory directory) is not addressed here (outside this phase's write-set); the directory check above only looks for `outcomes*`/`decisions*`.

## Handoffs

- **To 2.2.** Call `rememberDispatch(childSessionID, …)` once per dispatch after the final input is known, **for every resume too** (a resume must bump the attempt, otherwise its steps land on a closed attempt and are dropped by the store). A fresh dispatch's child id is not known in `execute.before`: register on `session.created` with `parentID`, or from the tool result, whichever 2.2 designs. Supply a resolved `model` (`provider/model`) for host agents (from `ctx.agent.list()`); a `null` model records nothing (one warning per child). Pass `decisionID`, `facts` from `classify()` (class = rules class), `parentSessionID`. Decision rows are 2.2's: `flusher.enqueue` via the same `acquireOutcomes` bundle.
- **To 2.3.** Pass `step` and a per-attempt `attemptId` (or let the index bump), and call `ingest.onVerdict`/`onFalseRefusal`/`onSessionGone` for producer sessions from the runner (the module-level registry works for plugin-created children too). `onSessionGone` is the "closeAttempt on a gone child".
- **To 2.4.** `createIngest` exposes no store accessor; `/router stats` should use `acquireOutcomes` (same process bundle) as in the 1.3 handoff. `ingestSettings(cfg, "v2")` is the single place that answers "is the engine live".
- **To the orchestrator (DF2).** Nothing is recorded until 2.2 registers children. When `shadow` goes live the first outcome files appear in the D15 directory (`outcomes.json`, `decisions.jsonl`).
- **Decisions a QA reviewer should challenge:**
  1. Step events are deduped by event id **after** the registry/settings/trust checks, in one process-wide LRU. Two instances with different `routing.outcomes.path` for the same child would let only the first record; and an event whose id repeats after 4 096 other ids would be counted again.
  2. Below-threshold or `unknown`-class dispatches produce **no verdict/refusal rows** either (rows and store stay consistent), at the price of `routing:stats` not seeing their verdicts. The 1.3 handoff only mandated skipping the store calls and keeping the decision row.
  3. A child registered with `model: null` is never recorded (the step event has no model). If 2.2 cannot resolve host agents' models, most `host:` evidence silently stops.
  4. `unpriced` is also used when the catalog lookup fails or the model is absent: a priced model's real `0` cost then becomes `null` (undercount of measured samples), a positive cost is kept.
  5. Catalog pricing is cached for 60 s per instance (`ctx.model.list`); a price change inside the window is not seen. The list call runs inside the event loop's `await` (not on a dispatch path) but does block that instance's loop while loading.
  6. Idle-equivalent events: the plan says `session.idle`; v2 has `session.execution.succeeded|failed|interrupted`, which the adapter already maps to `session.idle`. Flush and sweep run on those, plus the literal `session.idle`.
  7. Two ingest instances exist per v2 plugin instance (`index.ts` for verdict/refusal/sweep, `v2-hooks.ts` for events/flush/pricing); each holds one reference to the same process bundle. Check the refcounting and that `index.ts`'s `settings` (live `cfg`) and `v2-hooks.ts`'s (`loadConfig(ctx.location.directory)`) cannot disagree for long.
  8. After a hot reload to `engine: static`, an already-held bundle keeps its queued rows and flushes them later (no new rows are produced). §1.2 speaks of "no new files" for a config that never had a routing block; for a live switch to static this is a judgement call.
  9. `onSessionGone(parent)` forgets every child of that parent, including a deferred verification still to be replayed.
  10. `lastAttemptByChild`, `seenEvents`, the signal set and the unkeyable-warning set are module-scope and bounded (2 000 / 4 096 / 4 096 / 500); `resetIngestState()` exists for tests only.
  11. Wiring only covers the native `task` verification path; see Deferred.
  12. The default ingest of the v2 adapter logs through `createPluginLogger()` without a client (console fallback, `extra` is dropped there), because the v2 runtime has no `app.log`; a real v2 host prints these warnings on the console.
  13. `acceptance` is a free `string | null` on the registry; 2.2 may want the detection depth (`deterministic | grader | none`) typed.

## Verdict

**Implementation complete; adversarial QA pending (§0.7).** No finding has been raised or fixed yet, so "open findings: 0" is not claimed. Verification: three scoped test files (140 tests) and `vitest related` (58 files, 1 961 tests) green on the default pool; `npm run typecheck` green at `HEAD`; the real override file is absent and the real trajectory directory holds no `outcomes*`/`decisions*`; branch `car/p21` pushed.
