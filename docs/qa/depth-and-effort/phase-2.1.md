# Phase 2.1: depth guard adapter (M2). QA review

Branch `de/p21` (worktree `D:\git\omr-de-p21`), reviewed range `15caba2..d120d69`:
`2c7b446` feat (`src/router/depth-guard.ts`), `d120d69` test (`test/unit/depth-guard.test.ts`). Issue #66.
Reviewer: adversarial senior QA (`[tier:heavy]`, CAP:none). The reviewer did not write this code.
Reviewed against: plan D1–D6 (`:368-409`), §1.7 A1 (`:474-530`), A2 (`:531-539`), A13 (`:674-680`), Phase 2.1
(`:1118-1161`). Also read: the tracker `src/router/depth.ts`, `BeforeResult` and `guardBeforeCall` in
`src/guard/enforce.ts:58-121`, `src/router/enforcement.ts`, and the existing block path in `src/index.ts:1192-1222`.

## Pre-flight

| Check | Result |
|---|---|
| Worktree base | `de/main` at `15caba2` (Phases 1.1 and 1.2 merged) |
| `npm ci` + `npm run typecheck` (base) | OK |
| Capped full suite, run once on the identical tree on `de/main` | **103 files passed / 3 skipped; 3857 tests passed / 65 skipped** |
| `npm run typecheck` at `HEAD` `d120d69` (this review) | Clean (`tsc --noEmit`, no diagnostics) |
| Scoped run at `HEAD`: `npx vitest run test/unit/depth-guard.test.ts test/unit/depth.test.ts --maxWorkers=50%` | **2 files, 217 tests passed** (102 in `depth-guard`, 115 in `depth`) |
| Coverage, `depth-guard.ts` only (`--coverage --coverage.include=src/router/depth-guard.ts`) | **100 %** statements (54/54), branches (31/31), functions (6/6), lines (51/51) |

Method and limits:
- The adversarial inputs below were run as scratch tests in `test/scratch/` (two files, 24 cases). They used the
  real `createDepthTracker`, the real `resolveEnforcementMode`, fake timers for the timeout case, and the plan file
  for the text comparison. The files were deleted before committing, and `git status` was clean afterwards.
- The full suite was not re-run at `HEAD`. The phase adds two new files and edits nothing else.

## Implementation notes

**Built (`2c7b446`):** `src/router/depth-guard.ts` (109 lines), the pure M2 decision. Wiring is Phase 2.3.
- `createDepthGuard({ tracker: Pick<DepthTracker, "depthOf">, limit, mode, logger })` returns
  `{ checkDispatch(callerSessionID) }`. Its result is `DepthGuardResult = BeforeResult & { banner?: string }`,
  as A1 supersedes 2.1.1. The mode seam is `(callerSessionID: string | undefined) => EnforcementMode`, and
  `tracker` is narrowed to `depthOf`. Both are compatible with the plan's interface.
- Order per call:
  1. **mode** (a throw → `"advisory"` plus a warning). `"off"` → `{ block: false, mode }`, without calling
     `limit` or the tracker.
  2. **limit** (a throw → `1` plus a warning). `null` → `{ block: false, mode }`, with no lookup. A value that is
     not an integer from 1 to `MAX_DELEGATION_DEPTH_LIMIT` → `1`, with one warning per guard lifetime.
  3. **caller.** A non-string or empty caller → allow, with one warning per guard lifetime.
  4. **depth.** A tracker throw, rejection or `undefined` → allow, with one warning per caller. The set of warned
     callers is FIFO-capped at 1 000. A depth that is not a non-negative integer → `MAX_DEPTH_HOPS` (fail closed),
     with a warning.
  5. **decision.** `depth + 1 > max` gives `{ block: true, mode: "enforced", message: D5, guard: "delegation_depth" }`
     in `enforced`. In any other active mode it gives `{ block: false, mode, guard: "delegation_depth", banner: A1 }`.
     Otherwise the result is `{ block: false, mode, guard: null }`.
- `depthLimitMessage` and `depthAdvisoryBanner` produce the D5 and A1 texts. `DELEGATION_DEPTH_GUARD = "delegation_depth"`.
- `checkDispatch` never rejects. A `Proxy` whose every `get` throws, passed as `deps`, resolved
  `{ block: false, mode: "advisory", guard: null }`.

**Tests (`d120d69`):** 102 cases.
- The truth table: depth {0, 1, 2, 31, 32, unknown} × limit {null, 1, 2, 32} × {off, advisory, enforced}, with
  spies on `depthOf`, `limit`, `mode` and `warn`.
- The A13 pin (`MAX_DEPTH_HOPS === MAX_DELEGATION_DEPTH_LIMIT`, `test:50-53`).
- D5 and A1 inline snapshots.
- A live limit change, per-caller mode, tracker reject/throw/undefined, the 1 000-entry warning cap, and invalid
  depth, limit and caller values.
- Throwing mode, limit and logger seams.
- The boundaries are pinned independently of the table's formula: 0/1 allow (`test:138-139`), 1/1 block
  (`test:62`) and 1/2 allow (`test:64`).

**Verified adversarially (no finding):**
- *Off-by-one:* none. 0/1 allow, 1/1 block, 31/32 allow and 32/32 block. By reading, integer overflow inputs
  (`2**53`, `1e308`) satisfy `Number.isInteger` and `depth + 1 > max`, so they block.
- *Malformed depth:* `NaN`, `-1`, `1.5`, `"2"`, `Infinity`, `null` and `{}` all become 32 and block in `enforced`
  (fail closed; tested at `test:113-119`). By reading, `2n` and `new Number(1)` fail `Number.isInteger` the same
  way. `-0` counts as 0.
- *Malformed limit:* `0`, `33`, `NaN`, `1.5`, `"2"` and `undefined` become 1, the strictest limit.
- *F1 floors are the second allow path, not only `undefined`.* With the real tracker, take
  `recordCreated("S","P")` with P unknown and the backend rejecting. `depthOf("S")` returns the floor 1.
  - Limit 2: S is **allowed**. The guard does not warn; the tracker warns once (`cannot resolve session S: offline`).
  - Limit 1: S is **refused**.

  A floor is ≤ the true depth (phase-1.2 F1), so it never allows a caller whose *proven* depth exceeds the limit.
  This is D2's fail-open for an unresolved ancestry, not a bypass.
- *No caller whose depth is known is allowed when the mode resolves to `"enforced"`.* The only paths that allow
  such a caller are a mode other than `"enforced"`, which includes the junk values of QA-2.1-1, and a `null` limit.
- *Hot path when disabled:* `"off"` makes 0 `limit` calls and 0 `depthOf` calls. A `null` limit makes 0 `depthOf`
  calls. A root recorded by an event makes 0 backend calls.
- *Concurrency:* with the real tracker, 50 concurrent `checkDispatch("C")` calls (chain C→B→A→root,
  backend 5 ms per hop) made **3 `getParent` calls in total, one per hop**. All 50 refused with the depth-2 text,
  and a repeat call made no further backend call. The guard does not coalesce calls itself; the tracker's shared walk does.
- *Lookup timeout:* the guard passes no `timeoutMs`, so the tracker's 2 s default applies (D2). Under fake timers,
  a never-settling backend left the call pending at 1 999 ms and allowed it at 2 000 ms.
- *Texts:* in a scratch test, the D5 (`:403`) and A1 (`:484`) template lines read from the plan, with `${d}` and
  `${max}` substituted, equal `depthLimitMessage` and `depthAdvisoryBanner` byte for byte for (1,1), (2,2), (32,32)
  and (0,7). Both texts are single-line. `⚠` is U+26A0 without U+FE0F, the same as `guardBeforeCall`'s
  `[\u26a0 GUARD:…]` (`enforce.ts:118`).
- *Block-path shape:* `if (res.block) throw new Error(res.message)` throws exactly D5, and the keys are
  `block, mode, message, guard`. `"off"`/`null` → `{ block, mode }` and an active allow → `guard: null`, the same as
  `guardBeforeCall` (`enforce.ts:96, 103`). The advisory result carries no `message`, as in `guardBeforeCall`
  (`:120`), so an existing `if (res.block)` path cannot misfire.
- *Warning cap:* the 1 000-entry set is FIFO, not LRU. A caller hit on every call is still evicted after 1 000
  newer unknown callers and warned again (scratch: 1 002 warnings). Memory and warnings stay bounded, and the test
  pins the behaviour (`test:103-111`). Accepted.
- **Started before Wave 1 closed.** 2.1 depends only on 1.1 and 1.2 in the §3 graph (`:752-753`), and both were
  merged at `15caba2`. 1.3 was still open, and 2.1 neither reads nor writes any 1.3 file.

## Findings

| id | severity | file:line | description | resolution |
|---|---|---|---|---|
| QA-2.1-1 | major | `src/router/depth-guard.ts:52-58, 101-104`; `src/router/config.ts:1323-1325` | **An unrecognised mode is silently treated as advisory and echoed back in `mode`. This is the mode confusion the QA-1.1 handoff required 2.1 to handle.** The mode seam's return value is never checked. Any value other than `"off"` and `"enforced"` takes the advisory branch, with no warning, and that value is returned as `BeforeResult.mode`, which is typed `EnforcementMode`. **Reachable:** the state file's `enforcementMode` is not validated (`config.ts:1323-1325` casts it to `RouterState` and copies it into `cfg.enforcement.mode`), and `resolveEnforcementMode` returns it unchanged (`enforcement.ts:36, 45`). The QA-1.1 handoff says: "The state-file `enforcementMode` is not validated … The depth guard must treat an unrecognised mode safely." **Failing inputs** (depth 1, limit 1, scratch): <br>• mode `"Enforced"`, `"ENFORCED"`, `"enforce"`, `"on"`, `""`, `1` or `null` → `{ block: false, mode: <the junk value>, guard: "delegation_depth", banner }`, with 0 warnings. <br>• `undefined` → the result has an own `mode: undefined`. <br>• `{ mode: "enforced" }` (the resolver's object passed without `.mode`, possible only with a cast) → the same, `mode` being an object. <br>• `"Off"` → a depth lookup (`depthOf` called once), although the user meant off. <br>• `resolveEnforcementMode({ config: { enforcement: { mode: "Enforced" } }, env: {} }).mode` → `"Enforced"`, then the result above. <br>The *decision* matches `guardBeforeCall`, which also treats an unknown mode as advisory (`enforce.ts:96, 105, 113-120`), so D6 is respected literally. Three problems remain: the junk value leaks into the result type, the guard is silent, though it warns for a *throwing* mode seam (`:56`), and the handoff is neither addressed nor tested. 2.3 code that branches on `res.mode` would misroute the banner. Fix: when the value is not one of `off\|advisory\|enforced`, warn once (latched, like the limit) and use `"advisory"`. That is D6-literal, and it is the default of the resolver and of the throwing-seam path. Return the normalised mode. Add tests for `"Enforced"`, `"Off"`, `undefined` and an object. | Resolved in `ff7990c`: exact mode validation; all listed malformed inputs and the real resolver covered. Invalid values warn once each (FIFO cap 100) and return advisory; `"Off"` remains active and performs the lookup. |
| QA-2.1-2 | minor | `src/router/depth-guard.ts:84-94`; `src/router/depth.ts:165, 590, 594`; `test/unit/depth-guard.test.ts:82-92` | **An unknown-depth caller gets two warnings through the plugin logger, but D2 says one per caller session.** The real tracker already warns once per id for every failed, timed-out or throttled resolution (`[router] depth: cannot resolve session S: <reason>`). The guard then adds its own line for the same caller (`[router] delegation depth: cannot resolve depth for session S; allowing dispatch.`). **Failing input** (real tracker and guard sharing one logger, as 2.3 will wire them): backend `getParent` rejects `offline`; `checkDispatch("S")` twice → **2 warnings**. The same happens on a 2 s timeout (fake timers): 2 warnings. The unit test asserts "warns once per caller" only because its mock tracker never warns. The guard's line cannot simply be dropped: the tracker returns `undefined` silently when `forget()` cancels a walk (`depth.ts:712, 764-766`), and then only the guard warns. Options: (a) record that D2's "one warning" means one per layer (cause + decision), or (b) give the guard a way to know the tracker already warned. Either way, add a test with the real tracker that pins the agreed count. | Resolved in `4dec0ca`: tracker owns undefined-depth warnings; guard warns only for invalid caller ids and tracker throws/rejections. Real tracker with rejecting backend and shared logger proves one warning per caller over repeated checks. Silent cancellation is accepted; see handoff. |
| QA-2.1-3 | minor | `src/router/depth-guard.ts:56, 64, 96` | **Three warning paths are not deduplicated: warning spam.** The mode-seam throw (`:56`), the limit-seam throw (`:64`) and the invalid-depth warning (`:96`) are logged on every call. The invalid-limit and invalid-caller warnings are latched, and the unknown-depth warning is deduplicated per caller. **Failing inputs** (scratch, 100 calls each): <br>• throwing mode and limit seams → **200 warnings**; <br>• tracker returning `NaN` → **100 warnings**; <br>• limit `null` (guard disabled) with a throwing mode seam → **100 warnings**, a hot-path side effect while disabled. <br>None is reachable with the real seams: `resolveEnforcementMode`/`resolveDepthLimit` do not throw on validated config, and the tracker returns only integers 0–32 or `undefined`. These are the defensive paths, and the plan's adversarial focus lists warning spam. Fix: latch the two seam warnings (or deduplicate them per caller with the existing set), and deduplicate the invalid-depth warning per caller. Optionally resolve `limit` before `mode`, so that a `null` limit skips the mode seam entirely. | Resolved in `c6c12f8`: separate FIFO-capped 100-cause sets for mode errors, limit errors, and caller/invalid-depth pairs. Error causes use name/message, not fresh Error identity. Tests cover 100 repeated calls, disabled limit, distinct causes and eviction. |
| QA-2.1-4 | minor | `test/unit/depth-guard.test.ts:82-101` | **Missing test: the plan's "the tracker … times out → allow, with exactly one warning per caller" (`:1153`).** The tests cover reject, a synchronous throw and `undefined`, but no timeout. The guard has no deadline of its own (`:86`): it relies on the tracker's 2 s default. **Input:** `depthOf: () => new Promise(() => {})` → `checkDispatch("S")` is **still pending after 3 000 ms**. With the real tracker under fake timers it settles at 2 000 ms (see Implementation notes). Add a test that uses the real `createDepthTracker` with a never-settling `getParent` and fake timers: pending at 1 999 ms, allowed at 2 000 ms, with the warning count agreed in QA-2.1-2. This pins both the D2 timeout and the guard's reliance on it. | Resolved in `4a32202`: real tracker, hanging backend and fake timers prove pending at 1999 ms, allowed at 2000 ms, exactly one shared-logger warning including a repeat check, and zero remaining timers. |
| QA-2.1-5 | nit | `src/router/depth-guard.ts:40-46` (vs `src/router/depth.ts:166-167`) | **A throwing logger loses the unknown-caller warning for good.** The caller is added to `warnedCallers` before `warn()`, and `warn()` swallows the throw. **Input:** the logger throws on the first `checkDispatch("S")` (depth `undefined`) and works on the second → 0 warnings delivered. The tracker does the opposite: "An undelivered warning is not remembered, so a later occurrence retries it." Fix: return a delivered flag from `warn()` and remove the caller from the set if the warning was not delivered (the same applies to the `warnedCaller` and `warnedLimit` latches). | Resolved in `abe3425`: warnings are remembered only after logger success; logger failures never escape. Seven defensive paths test failure, successful retry, then deduplication with unchanged decisions. Undefined depth remains owned by the tracker per QA-2.1-2. |
| QA-2.1-6 | nit | `src/router/depth-guard.ts:68-74, 102` | **The invalid-limit warning is latched for the guard's lifetime, and the refusal then misstates the configured value.** **Input:** limit `0`, then `2`, then `99` (live config, programmatic only, since `validateConfig` rejects both) → 1 warning in total, and the refusal reads `enforcement.maxDelegationDepth is 1` while the config says 99. Fix: reset the latch when a valid limit is seen, and optionally say in the warning that the limit used is 1. | Resolved in `4f0bdba`: one warning per distinct invalid value (FIFO cap 100), naming its type/value and effective limit 1. Live 0 → 2 → 99 → 0 → 99 and eviction tests added. D5 refusal deliberately retains effective limit 1. |

Severity summary at review: **0 critical, 1 major, 3 minor, 2 nits. Round-1 resolutions: 6 addressed, 0 open.**

### Round 2

Re-review of the round-1 fixes, range `abbcd9c..d22ed3b`: `ff7990c` (QA-2.1-1), `4dec0ca` (-2), `c6c12f8` (-3),
`4a32202` (-4), `abe3425` (-5), `4f0bdba` (-6), `d22ed3b` (report). Reviewer: adversarial senior QA (`[tier:heavy]`,
CAP:none), not the author of the fixes. Focus: regressions introduced by the fixes.

**Verification at `d22ed3b`:**
- `npx vitest run test/unit/depth-guard.test.ts test/unit/depth.test.ts --maxWorkers=50%`: **2 files, 246 tests passed**.
- The same run with `--coverage.enabled=true --coverage.include=src/router/depth-guard.ts`: **100 %** statements (73/73),
  branches (44/44), functions (8/8), lines (66/66).
- `npm run typecheck`: clean. `git diff --check abbcd9c..HEAD`: clean. The full suite was not run.
- Adversarial inputs ran as two scratch files in `test/scratch/` (11 cases). They used the real `createDepthTracker`,
  fake timers and a shared logger. Both files were deleted, and `git status` was clean afterwards.

**Round-1 findings:**

| id | status | evidence |
|---|---|---|
| QA-2.1-1 | **resolved** | Exact `===` against the three modes (`depth-guard.ts:76-81`), and the normalised value is returned. Scratch: `"enforced"` at depth 1 / limit 1 → `{ block: true, mode: "enforced", message: D5, guard }`. `"advisory"` → the banner. `"off"` → `{ block: false, mode: "off" }` with **0** `limit` calls, **0** `depthOf` calls and 0 warnings. No path turns a valid `"enforced"` into advisory or makes a lookup for a valid `"off"`. Junk values, `"Off"` included, become advisory with a lookup and a warning: `guardBeforeCall` also short-circuits only on an exact `"off"` (`enforce.ts:96`), so this is D6 parity. The real-resolver case is pinned (`test:98-105`). Residual: see QA-2.1-R2-1. |
| QA-2.1-2 | **resolved (double warning); fix introduced QA-2.1-R2-2** | The real tracker and the guard share one logger, and the result is one warning per caller in every case. **Reject:** `test:167-179`. **Timeout:** `test:181-203`. Scratch: 10 concurrent checks timing out → 1 warning, and 1 `getParent` call until the 30 s throttle expires. **Throttled ancestor** (scratch: A, B and C are recorded children of P, P rejects, U is unknown, 7 checks): 4 warnings, one each: `A: offline`, `B: throttled at P`, `C: throttled at P`, `U: offline`. **F1 lower bound:** `floor()` warns whenever the caller is incomplete (`depth.ts:590, 594`). **An ancestor forgotten mid-walk** → 1 warning (`cannot resolve session S: forgotten`). **The caller forgotten mid-walk** → **0 warnings**: see QA-2.1-R2-2. |
| QA-2.1-3 | **resolved; identity keying residual in QA-2.1-R2-1** | Mode and limit errors are keyed by `describe(error)`, and invalid depths by `[caller, cause]`. **100 calls with throwing seams and a NaN depth → 3 warnings** (`test:293-304`). Every set is bounded: five FIFO sets capped at 100, plus `warnedCallers` at 1 000; each evicts after it adds (`:57-60, 67-68`). |
| QA-2.1-4 | **resolved** | `test:181-203` uses the real tracker, a hanging `getParent` and fake timers. The check is pending at 1 999 ms and allowed at 2 000 ms. There is one warning, including after a repeat check, one backend call, and 0 timers left. |
| QA-2.1-5 | **resolved** | Warnings are remembered only after delivery (`:56, 66, 104`), as in the tracker (`depth.ts:166-167`). **Permanently throwing logger** (scratch, 1 000 calls, three failing paths): 3 000 logger attempts, one per path per call. Nothing is delivered, no call rejects, and nothing accumulates, so there is no output spam; the cost is one caught throw per path per call. A logger that writes and then throws would deliver on every call (scratch: 100/100). The plugin logger cannot do that: `createPluginLogger` catches a transport throw and falls back to `console.warn` (`logger.ts:120-134`). Accepted. |
| QA-2.1-6 | **resolved; identity keying residual in QA-2.1-R2-1** | Live `0 → 2 → 99 → 0 → 99` → 2 warnings, each naming the value and "effective limit 1" (`test:248-260`). The refusal text uses the effective limit. |

**Enforced-mode bypass (no finding).** Scratch fuzz, 2 624 cases: limit 1–32 × known depth 0–40 × a working or
throwing logger, mode `"enforced"`. `block` held exactly when `depth + 1 > max`. A limit seam that throws or returns
an invalid value still gives 1, and an invalid depth still gives 32 (`:91-99, 123-128`). The fixes change warnings
only. The decision path is the same as in round 1: no new early return, and nothing new outside a `try` can throw.
`JSON.stringify` receives only strings, so a `bigint` depth cannot make it throw.

**New findings:**

| id | severity | file:line | description | resolution |
|---|---|---|---|---|
| QA-2.1-R2-1 | minor | `src/router/depth-guard.ts:37, 41, 80, 98`; `test/unit/depth-guard.test.ts:84-96` | **Invalid mode and limit warnings are deduplicated by value identity, so a non-primitive invalid value warns on every call.** `warnOnce(warnedModes, resolved, …)` (`:80`) and `warnOnce(warnedLimits, max, …)` (`:98`) key their sets by the raw value, while the message prints `describe(value)`. A seam that builds a fresh object on every call never matches the set. That shape is the wiring mistake QA-2.1-1 listed: `mode: (sid) => resolveEnforcementMode({…})` without `.mode`. **Failing inputs** (scratch, depth 1, limit 1, 100 calls each): <br>• mode `() => ({ mode: "enforced", warning: undefined })` → **100 warnings**, all with the same text (`invalid enforcement mode object: [object Object]; using advisory.`); <br>• `() => []` → 100; <br>• `() => Symbol("m")` → 100; <br>• limit `() => ({})` → **100 warnings**. Round 1 gave 1 warning per guard lifetime here, so this is a regression from `4f0bdba`. <br>Controls: the same object returned each time → 1; `NaN` → 1; `"Enforced"` → 1. The decisions stay correct: advisory, or a refusal with effective limit 1. The test passes the object through `mockReturnValue` (`test:87`), a single shared instance, so it cannot catch this. The path is reachable only through a cast or from JavaScript, since the seams are typed, which puts it in the same class as QA-2.1-3. **Fix:** key both sets by `describe(value)`, as the error and depth sets already are. Add fresh-value-per-call tests for both seams. Optionally quote the printed value (`JSON.stringify` for strings), because a state-file mode string is now logged raw, newlines included. | open |
| QA-2.1-R2-2 | minor | `src/router/depth-guard.ts:116-121`; `src/router/depth.ts:712, 764-766, 781-784` | **`4dec0ca` leaves one unknown-depth path with zero warnings, against D2.** The guard no longer warns on `depth === undefined`. The real tracker returns `undefined` silently when `forget(caller)` cancels the caller's in-flight walk: `forget` → `cancelWalk` (`:784`) → `run` returns `undefined` (`:712`) → `depthOf` passes it on (`:764-766`). `forget` has also just cleared the caller's `warned` keys (`:781`). Round 1 named this path ("The guard's line cannot simply be dropped"). The resolution's "silent cancellation is accepted" re-opens D2 without an amendment. D2 (`plan:374-378`) requires one warning per caller session when the depth cannot be resolved, and it names "a session the backend no longer knows". **Failing inputs** (real tracker and guard on one logger, scratch): <br>(1) `getParent` hangs; `checkDispatch("S")`, then `forget("S")` 5 ms later → `{ block: false, mode: "enforced", guard: null }` and **0 warnings**. <br>(2) `recordCreated("S","P")` (event-proven floor 1), limit 1, enforced, P's lookup hangs, `forget("S")` mid-walk → **allowed, with 0 warnings**. The control without `forget` is **refused** at 2 000 ms with 1 warning (`cannot resolve session S: timed out after 2000 ms`). <br>The allow is D2's fail-open for a session that is gone, and the window is narrow: the caller's session must be deleted during its own before-hook. Only the warning is missing. **Fix, either:** <br>(a) In `depthOf`, when the walk settles `undefined` without a timeout, call `warn(id, "lookup", "forgotten")`. That emits exactly one line, deduplicated by the existing `lookup:<id>` key, and matches the message for a forgotten ancestor. It is a `depth.ts` change, so the orchestrator confirms §2 ownership. <br>(b) An owner amendment to D2 in §1.7 that records this residual. <br>Either way, update handoff 6 and pin the agreed count with a real-tracker test. | open |

Round-2 summary: **6 of 6 round-1 findings resolved; 2 new minor findings (QA-2.1-R2-1, -R2-2), both open.** Under
§0.7 every round-2 finding is fixed, whatever its severity.

## Round-1 resolution verification

The original review and implementation notes above describe `d120d69`; the resolution column supersedes
their warning behaviour. Changes are limited to the guard, its tests, and this report; `depth.ts` is unchanged.

- `npx vitest run test/unit/depth-guard.test.ts test/unit/depth.test.ts --maxWorkers=50%`:
  **2 files, 246 tests passed** (131 guard + 115 tracker).
- Same scoped run with `--coverage --coverage.include=src/router/depth-guard.ts`:
  **100% statements (73/73), branches (44/44), functions (8/8), lines (66/66)**.
- `npm run typecheck`: **clean**, no diagnostics.
- `git diff --check abbcd9c..HEAD`: clean for the six fix commits. No full-suite run.

## Deferred by plan

- All wiring is Phase 2.3:
  - the per-plugin `DepthTracker` with `getParent` on `session.get`, and its sweep;
  - `session.created` seeding and the authoritative `lookupRootSession` seeds (2.3.2.a/b);
  - the `task` before-hook and `delegate` calls (2.3.2.c/d), and plugin-child recording (2.3.2.e, 2.3.3, A7);
  - the A1 banner channels (v1 map, v2 symbol + bridge map), D4 recording, `/bypass` (A11), and the v2 refusal path.
- Integration proof through the plugin factory (2.3.6), and the end-to-end proof in real OpenCode (3.2.1(c)).
- D11 limits (shell-spawned `opencode`, other plugins' session tools) are for the ADR and README (3.1).
- The `trivial` downgrade is deliberately not applied (A1 orchestrator decision). The adapter takes no `trivial`
  input, so 2.3 must not wrap one in.

## Handoffs

**To 2.3 (apply in its pre-flight):**

1. **Construct one guard per plugin instance** next to the tracker:
   ```ts
   const depthGuard = createDepthGuard({
     tracker: depthTracker,
     limit: () => resolveDepthLimit(cfg),            // per call: live config, null disables
     mode: (sid) => resolveEnforcementMode({
       config: cfg,
       tier: (typeof sid === "string" ? sessionStore.getTier(sid) : null) ?? undefined,
       env: process.env,
     }).mode,                                         // .mode, not the { mode, warning } object
     logger: { warn: (m) => logger.warn(m) },
   });
   ```
   - Use the same `cfg` binding and the same tier source as `guardBeforeCall` (`index.ts:1201-1210`), so that both
     guards resolve one mode per call.
   - The tier is the **caller's** (`input.sessionID` / `toolCtx.sessionID`), never the target `subagent_type`.
   - Do **not** apply `sessionStore.isTrivial` (A1).
   - `getTier` takes a `string`, so guard `undefined` before calling it.
   - Ignore `.warning` per call, as every existing call site does (`index.ts:164, 183, 463, 1106, 1288`).
2. **`task` before-hook (v1 and the v2 bridge):** place the call after `if (bypassed) return;` (`:1100`) and
   **before** `observeEdit` (`:1103`), `startDispatch` (`:1116`) and the prompt repair (A11):
   `const res = await depthGuard.checkDispatch(input.sessionID)`. `checkDispatch` never rejects, so a `try` is not
   needed. If one is added for symmetry with `:1200-1213`, it must not swallow a block.
   - **D4 on block:** `trajectoryStore.recordToolEvent(input.sessionID, { tool: input.tool, readOnly: READ_ONLY_TOOLS.has(input.tool), blocked: true })`,
     then `throw new Error(res.message)` (`index.ts:1214-1221`). The existing record sits behind the `isSubagent`
     gate (`:1193`), but the depth guard runs before it. 2.3.1 must decide whether a refused caller that is not
     tracked by `sessionStore` is recorded, and whether that creates trajectory state for it.
   - **Advisory:** branch on `res.banner`, not on `res.mode` (see QA-2.1-1). Deliver it through the A1 channel:
     - v1: a bounded map (≤ 1 000) keyed `${input.sessionID}:${input.callID}`, delivered in `"tool.execute.after"`
       **before** the `isSubagent` branch (`:1262`), then deleted. A call without a `callID` gets no banner, with
       one warning per session.
     - v2: a symbol on `output` plus the bridge's own map keyed by `event.id`. The bridge delivers it for completed
       and background-`running` results.
     - Never use `guardStore.setPendingNote`. Drop the entry for a failed or non-completed call, and never deliver
       a banner twice.
3. **`delegate` tool:** call `checkDispatch(toolCtx?.sessionID)` before any session is created, and skip it when
   `bypassed` (A11). `res.block` → return `res.message` (A2). `res.banner` → append it to that call's returned
   string on every return path.
4. **Result shapes to rely on:**
   - `"off"` / `null` limit → `{ block: false, mode }`;
   - an active allow → `{ block: false, mode, guard: null }`;
   - advisory past the limit → `{ block: false, mode: "advisory", guard: "delegation_depth", banner }`;
   - enforced past the limit → `{ block: true, mode: "enforced", guard: "delegation_depth", message }`.
5. **Concurrency and cost:** the guard does not coalesce calls; the tracker does (50 concurrent calls → one walk,
   one `getParent` per hop). Assert this in 2.3.6 through the plugin factory, together with "a root `task` call →
   no backend call beyond the existing root lookup".
6. **Warnings (QA-2.1-2 decision):** pass the **same plugin logger to tracker and guard**. The tracker owns
   warnings when `depthOf(validCaller)` returns `undefined`; the guard adds none, including for silent
   cancellation by `forget()`. The guard warns once total for missing/empty/non-string caller ids (which never
   reach the tracker), and once per caller for tracker throws/rejections (contract violations; FIFO cap 1000).
   Real-tracker tests now pin one warning per caller for backend rejection and timeout. Phase 2.3.6 must
   retain this assertion through the plugin factory, not introduce a second decision-layer warning.

## Original round-1 verdict (superseded by resolutions above)

**Not ready to merge.** The adapter's core decision is sound. No input lets a caller whose depth is known
dispatch past the limit when the mode resolves to `"enforced"`:
- malformed depths fail closed to 32, and malformed limits fall back to 1;
- the D5 and A1 texts are byte-exact;
- `"off"` and `null` make no lookup;
- the block shape fits the existing throw path;
- the A13 pin is present, and coverage is 100 %.

Open: QA-2.1-1 (major: an unrecognised mode is silently treated as advisory and returned in `mode`; the QA-1.1
handoff is unaddressed), QA-2.1-2/-3/-4 (minor: double warning versus D2, three undeduplicated warning paths,
missing timeout test) and QA-2.1-5/-6 (nits). The phase DoD requires zero open findings.

**Resolution status:** all six round-1 findings are addressed and the scoped verification above passes.
Ready for independent QA re-review; this resolution record is not a new independent QA verdict.

## Verdict

**Pending fixes (round 2).** All six round-1 findings are resolved. The decision core is unchanged:
- no known depth is admitted past the limit in `enforced` mode;
- `"off"` and a `null` limit make no lookup;
- every warning set is bounded.

Open findings: **2** (QA-2.1-R2-1 minor, QA-2.1-R2-2 minor). Both are round-2 findings, so §0.7 requires them fixed
before the phase can report "Open findings: 0".
