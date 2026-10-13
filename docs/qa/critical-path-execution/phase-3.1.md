# Phase 3.1 — Scheduler, adaptive capacity, launcher and executor runtime

Worktree `D:\git\omr-cpx-p31`, branch `cpx/p31` from `cpx/main` @ `9fa7607` (DF-1 fixes merged). Started 2026-10-12 16:12.

## Pre-flight

- [x] Depends on 2.1, 2.2, 2.3, 2.4: merged into `cpx/main`.
- [x] Recon (explorer `ses_ecef3f35affeeJjML8GgdluvGe`): ADR 0007 C10/C13/C14/D13/D14/D15, addenda A1-A3, Wave 2 APIs, child runner, binding API, routing and step-failure regions. Facts in the memo below.
- [x] Gaps found (scheduled by this phase, 3.1.5): `src\compat\v2-client.ts` still adds the tool context's `signal` (≈117) and forwards its `progress` (≈205); no `bootID`, context pin or `ContextSupersededError`. No `schedule`/`capacity`/`expand`/`launch`/`runtime` file exists. Plan anchor `src\index.ts` ≈2154-2158 ("legacy verification flag") is stale: only the `incomplete` option exists there.
- [x] Existing tests: `test\unit\v2-client.test.ts` (37), binding: `roles.binding.test.ts` (37), `roles.authority.test.ts` (31), `roles-dispatch.test.ts` (25). Coverage gate `src/executor/**` 90/90/90.

## Implementation notes

Design memo 3.1.1 (architect `ses_eced86d60ffe46SH1dJUW45YSf`, heavy), binding:
### 3.1.1 Design memo: scheduler, capacity, launcher A and executor runtime

**What this memo is bound by.** It implements plan §3.1 (`docs/plans/critical-path-execution-plan.md:2821-3106`) against the contract in `src/executor/types.ts:1290-1925`. It also follows the phase-1.4 memo (`docs/qa/critical-path-execution/phase-1.4.md:294-724`) and its addenda A1 (`:763-1101`), A2 (`:1103-1113`) and A3 (`:1115-1119`).

**Precedence:** A3 > A2 > A1 > memo 1.4.1 > this memo > the plan text. Where this memo departs from the plan text, the decision is marked **resolves**.

**Abbreviations** follow A1 (`phase-1.4.md:767`): AS, AC, AA, AE(o), AV, AX, TT, TS, TF, TI, ISS/ISE, G1/G2, PP, IA, IAn. Owners: Rt runtime, L launcher, Q queue, P policy, QL QaLoop, Rc recovery.

#### 0. Module map and layering

| File | Task | Imports |
|---|---|---|
| `src/executor/schedule.ts` | 3.1.2 | `./types` only |
| `src/executor/capacity.ts` | 3.1.3 | `./types` only |
| `src/executor/expand.ts` | 3.1.4 | `./types`, `node:path` (`win32`/`posix`) |
| `src/executor/launch.ts` | 3.1.5 | `./types` only |
| `src/executor/runtime.ts` | 3.1.6 | `./types`, `./schedule`, `./capacity`, `./expand`, `./launch` |
| `src/compat/v2-client.ts`, `src/routing/roles/binding.ts` | 3.1.5 | + `../executor/types` (`ContextRef`, `RetainedContextInfo`, `ContextSupersededError`, `leaseTaskRef`) |
| `src/compat/v2-hooks.ts`, `src/compat/background.ts` | 3.1.7 | + `../executor/*` |

- **M1.** Nothing under `src/executor/` imports `src/compat/` or `src/routing/`. All host contact goes through the seams in `types.ts:1795-1925`. This keeps the 90/90/90 gate measurable with doubles only. As a consequence, the turn-state provider "plan" is registered by 3.1.7 in v2-hooks, not by runtime.ts (**resolves** 3.1.6.e for layering). runtime.ts exposes `planLine` and `manualReady` for it.
- **M2.** Claude Code v1 is in feature freeze, so `src/index.ts` does not change. The executor is built only in the v2 adapter.
- **M3.** The 3.1.7 wiring holds `executor: ExecutorRuntimeHandle | null`, and every host feed does nothing while it is null.
  - Production keeps it null until 4.1 (the tool) and 3.2/4.2 (the queue, policy and QA loop) exist.
  - The integration test builds it with typed doubles.
  - This is how the existing v2-hooks tests stay unchanged.
  - Exception: the fail-closed check (M41) is always on.

#### 1. Runtime event model

- **M4. Serialization.**
  - **Ticks:** one tick per plan at a time, coalesced. A trigger arriving during a tick sets `again = true`.
  - **Tasks:** one pipeline per task (an async mutex keyed by task id). It covers the launch step, the late-adopt hook (`onChildCreated`) and the completion processing. This closes the race between a late adopt and a new slot reset (see M27).
  - **Appends:** serialized by the writer itself (`types.ts:1328-1333`).
  - **Post-fsync work:** anything that must follow an fsync happens only after `await writer.append(...)` resolves (`types.ts:1331`).
- **M5. Batch boundaries.**
  - One batch per A1-2.4 row (`phase-1.4.md:908-951`), with these exceptions:
    - Row 1: all promotions of one tick go in one batch.
    - Abort: A1-8 step 3 (`phase-1.4.md:1085`).
    - Retry/exhausted decisions (rows 35/36) are always a separate batch right after rows 12, 16, 23, 26, 31, 32 and 34 (`phase-1.4.md:953`).
  - Metrics are always their own one-event batch. They are appended through a non-blocking, serialized metric queue; a failed metric append is logged and never thrown.
  - Every lifecycle batch that depends on ledger state uses a `BatchBuilder` (`types.ts:1328`). The builder returns `[]` when its precondition no longer holds.
- **M6. Fsync points** are derived, not chosen: a batch is fsynced iff any of its events `isDurableEvent` (`types.ts:1330`). That is false only for `metric` and for a TT into a non-durable state (`phase-1.4.md:343-344`). In the table below, "no" means the batch is not fsynced.

| Lifecycle step | Batch (row) | Fsync | After the fsync (Rt) |
|---|---|---|---|
| promotion | TT pending→ready `deps-satisfied` for every `promotable().toReady` (row 1) | no | tick continues; manual-ready wake check (M33) |
| unblock | `policy.unblock()` (row 38, P) | P | — |
| launch | builder: [TS(slot)] if changed, AS(n, nonce, callID = gate capture), TT ready→dispatched `launch`, [G1] (row 4) | yes (nonce durable before any host call, D8) | R4 `cancel(old, "superseded")`; `launcher.launch`; `launch` metric |
| L1 prep `E_LAUNCH_TASK` | row 4b; a qa task adds G1 then G2 (A2-3) | yes | token `release(other)`; retry decision |
| L2, L8 | AE(failed), AX, TT dispatched→failed `launch-task-error`, [G2] (row 12) | yes | token `release(other)`; retry decision |
| L3, L5, L6, L7, L9 | AE(lost, detail = reason), TT dispatched→ready `launch-lost`, [G2] (row 11) | yes (AE) | token `release(other)`; slot and leases kept (R4); tick |
| L10 confirmed | AC, TT dispatched→running `child-created` (row 10), journaled inside `onChildCreated` | yes, before the child is prompted | return into the runner |
| L12 late adopt | AA, TT ready→running `adopt`, [G1] (row 7) + `acquire(..., {force: true})` | yes | — |
| completed, ordinary | AE(succeeded), TT running→completed `child-ended` (row 15) | yes | token `release(success)`; commit (M38) |
| commit: changes | TS(slot, branch), TT completed→verifying `committed` (row 21) | yes | `cleanForChecks`, `verify` |
| commit: none | row 22 (TT completed→done `no-changes`, TS(null)), or row 23 per M39 | yes | `releaseTask`, `slots.release`; tick |
| commit fails | AX(error), TT completed→failed `commit-failed` (row 23) | yes | retry decision |
| verify PASS | AV(pass, ref), TT verifying→verified `verify-pass` (row 25) | yes | `queue.enqueue([id])` |
| verify FAIL / unverifiable | AV, AX(findings), TT verifying→failed `verify-fail` (row 26) | yes | retry decision |
| retry decision | TT failed\|conflict→ready `retry` (row 35, 35b for reverted); else `policy.park(id, "exhausted", text)` (row 36, P) | no / P | tick |
| qa parsed | QA5 batch (`phase-1.4.md:797`) | yes | release slot, leases, token(success); `qa.onQaResult` |
| qa unparsable | QA6: c = 0 → row 16 + G2, then the retry decision; c ≥ 1 → `policy.park(id, "qa-unparsable", err)` (row 17) | yes | — |
| child failed | AE(failed), AX, TT running→failed `child-failed`, [G2] (row 16) | yes | token `release(other)`; retry decision |
| child capacity / capacity-stop | AE(capacity), TT running→ready `capacity-stop`, [G2] (row 18) | yes | token `release(other)`; tick |
| child lost (L13/L14) | AE(lost), TT running→ready `child-lost`, [G2] (row 18) | yes | token `release(other)`; lost-streak check (M40) |
| `NEED MORE: lease` | row 18b, or 18b′ (M13) | yes | `releaseTask`, `slots.release`, token(other); tick |
| ESCALATE / ambiguity | `policy.park(id, cause, text)` (row 17, P) | P | — |
| manual done | TT ready→done `reported-done` (row 8) | no | tick |
| wake | `wake` alone | yes (`types.ts:1687`) | `HostSessions.synthetic` |
| plan completion | `status-changed running→completed` | yes | `plan-completed` wake; `queue.land()` iff `config.land` is `ff-when-clean` (A1-3) |

- **M7. Token and resource accounting.** It follows the row table columns exactly. The capacity token is acquired before row 4 and released after the fsync of the row that closes the attempt. Slot and leases are held exactly while `task.slot !== null` (A1-2.4).
  - **Owners.** `releaseTask` and `slots.release` are called by the module that wrote TS(null), after that batch's fsync (A3, `phase-1.4.md:1119`).
  - **Integrated tasks (resolves 3.1.6.c).** Q releases them (row 30). Rt does not release on `onIntegrated`; it only promotes and ticks.
- **M8. Rows 13 and 19 (resolves A3 versus observability).** These are Q writing →blocked for a live child. Only Rt can observe the child settle, so in `onReverted` Rt calls `launcher.cancel(t, n, "blocked")` and then, once `completion` settles, `releaseTask` and `slots.release`. Both are idempotent. Handoff to 3.2: Q must not release for rows 13/19 while `launcher.inFlight()` holds the task.

#### 2. Ready set and priority

- **M9. Bottom level** (`schedule.ts`, static over the whole DAG; recomputed on each call, or cached by ledger object identity).
  - The formula is `bl(t) = p50(t) + max(bl(s))` over the successors s of t, and 0 when t has none. A cancelled task has p50 = 0.
  - `succ(t)` is the union of:
    - (a) the targets of every task edge from t, of any kind: plan, inferred cross-phase, learned;
    - (b) when t is a non-qa task of phase P, the qa tasks of P (they wait for P's gate);
    - (c) when t is in phase P, the targets of every edge whose source is `gate:P`.
  - **Resolves** the plan text "max successor bottom level": (b) and (c) are needed, or a gating task looks short-tailed and is deprioritized (priority inversion).
  - The p50 is the same field 2.3 uses for `criticalPathMs`.
- **M10. Plan order** is the index in `Object.keys(ledger.tasks)`: compile order, then add-tasks and QaLoop creation order. `TASK_ID_PATTERN` excludes integer-like ids (`phase-1.4.md:400,1079`), so JS key order is insertion order and survives a JSON round trip.
- **M11. `readySet(ledger, inFlight, leases, capacity)`** (`types.ts:1505-1509`). It returns `[]` unless `status === "running"`. Candidates are tasks that:
  - are in state `ready`;
  - are of kind neither `manual` nor `preflight`;
  - are not in `inFlight` (Rt's set of tasks inside a launch step);
  - have a phase that is null or not paused;
  - have every incoming edge satisfied (`edgeSatisfied`: a task source is `integrated|done`; a `gate:P` source has gate `passed`);
  - meet R16/QA7: a qa task only while its gate is `awaiting-qa` (`phase-1.4.md:799`).

  Candidates are sorted by bottom level descending, then plan order ascending, and selected greedily:
  - **Soft write check.** For each `w` in `footprint.writes`, a `leases.holder(w)` that is anything other than this task's own holder (same planId and taskId) excludes the candidate. This includes holders of other plans and ad-hoc holders (`types.ts:1508`).
  - **In-selection overlap.** A selected task's writes join a local claimed set; a later candidate overlapping it is skipped. `pathsOverlap` means equal, or one is a `/`-segment prefix of the other, after ASCII case-folding. That is conservative: it can only delay, never admit.
  - **Capacity.** `route = capacity.routeOf(task)`. Local counters per provider are initialised from `free(p, false)` and `free(p, true)`. A heavy pick decrements both; a non-heavy pick decrements only the normal counter. A candidate that does not fit is skipped; nothing blocks other providers or lower non-heavy candidates.
  - **Output.** `{ taskId, route, bottomLevelMs }`.
- **M12. `promotable`.** `toReady` = pending tasks with every incoming edge satisfied. `unblock` = blocked tasks whose dependencies are all `integrated|done`. Rt journals `toReady` as row 1 and hands `unblock` to `policy.unblock()`, the P owner of row 38. `manualReady` = ready tasks of kind `manual|preflight`, in plan order.
- **M13. Learned edges** (`NEED MORE: lease <path>`, the child's first line, path normalized to repo-relative `/`). Rt reads `h = leases.holder(path)`:
  - **h is another task H of this plan.** `e = addLearnedEdge(ledger, H, T, "NEED MORE: lease <path>")`. A non-null `e` gives row 18b: AE(interrupted), AX(evidence), TT running→ready `lease-needed`, TF(writes ∪ {path}, sources ∪ {"learned"}), `edge-added(e)`, TT ready→pending `dep-added`, TS(null), [G2]. T comes back through row 1 when H integrates.
  - **h is null (the path is free now).** Row 18b′ = 18b without `edge-added` and without the ready→pending TT. **Resolves** the missing row. It stays within the legal running→ready `lease-needed` pair. The next launch acquires the learned path atomically with the rest (`acquireTask`), so there is no loop.
  - **`e === null` (edge exists or cycle), h of another plan or ad-hoc, or h is T itself.** This is R6: row 16 with trigger `lease-unresolvable` (counts), then the retry decision.
  - **`addLearnedEdge`.** It returns null if a holder→blocked edge already exists, or if blocked reaches holder (DFS over task edges plus the M9 (b)/(c) successors). Otherwise it returns a `learned` edge carrying `evidence`.

#### 3. Capacity (AIMD) and the retry-hook stop

- **M14. Parameters.**
  - Initial limit = `config.maxParallel` (1-8, D13); floor 1; cap `maxParallel`.
  - Heavy cap = `min(HEAVY_CAP_PER_PROVIDER = 2, limit)` (`phase-1.4.md:364`).
  - Decrease: `limit ← max(1, floor(limit/2))`.
  - Hold: `holdUntil = now + capacityCooldownMs` (default 120 000, `types.ts:1291`).
  - Pause default: `capacityPauseMs` (900 000, `:1292`).
  - `canAcquire(p, h)`: not paused, `used < limit`, and, for heavy, `heavyUsed < min(2, limit)`.
  - `free(p, false) = paused ? 0 : max(0, limit − used)`.
  - `free(p, true) = min(free(p, false), max(0, min(2, limit) − heavyUsed))`.
  - A lowered limit never preempts: new acquires wait until `used < limit`. `acquire(..., {force: true})` may exceed the limit (late adopt only).
- **M15. Signals.** `onSignal(s)` classifies with `classifyProviderError` (`phase-1.4.md:533`): the type decides, and an unknown type maps by status (429 → rate-limit, 529 → overload). Quota is by type only (`provider.quota`).
  - **rate-limit / overload:**
    - `lastSignalAt[p] = now` on every such signal, including repeats.
    - The first signal of a `stepKey` (`firstSignalAt[stepKey]` unset) records the time and decreases the limit (metric `decrease`).
    - Later signals of the same step change nothing. Distinct steps decrease again, even while held: 8 → 4 → 2 → 1 → 1.
    - **Resolves** "deduped per session and attempt" as "per stepKey". This answers QA's "AIMD oscillation": repeats of one step never compound; the clamp in M16 bounds growth.
  - **quota** (any source): `pausedUntil = pauseUntilFromMessage(message, now) ?? now + capacityPauseMs`. A pause is extended if the new instant is later.
    - `inbox` is non-null only when a pause starts: `{kind: "usage-limit", taskId: <the plan child's task or null>, text: "provider <p> paused until <iso> (<error.type>)"}`, with the non-critical severity of the `InboxItem` enum.
    - Rt raises it once through `policy.raise` (the inbox wake follows).
  - **`step-failed` / `execution-failed`** with rate-limit/overload class feed the same stepKey dedupe, so a step that failed after its retries does not decrease twice.
- **M16. Growth.** On `release(token, "success")` the limit grows by 1 (up to `maxParallel`, metric `increase`) iff all of these hold:
  - not paused;
  - `now ≥ holdUntil`;
  - `lastSignalAt` is null or `now − lastSignalAt ≥ cooldown`;
  - `token.acquiredAt ≥ lastSignalAt`.

  The last clause clamps growth: a success of a child started before the last signal says nothing about the current limit, so a burst of old completions cannot jump 1 → 8.
- **M17. ISO instant.** `pauseUntilFromMessage` returns the first match of `\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})` with `Date.parse > now`. A zoneless string is ignored: an instant needs a zone, and guessing local time could misplace the pause by hours.
  - There is no upper cap; the inbox item lets a human act.
  - **Resume** is detected lazily on any call with `now ≥ pausedUntil` (metric `resume`, limit unchanged). Rt also arms a `Clock` timer at `pausedUntil` that ticks.
- **M18. Retry-hook stop.** `shouldStopRetry({sessionID, stepKey, provider, planChild})` returns true iff `planChild` and either (provider paused) or (`now − firstSignalAt[stepKey] > capacityCooldownMs`). It emits `retry-stop` once per stepKey.
  - `Rt.onRetryHook` does three things, in order:
    1. `capacity.onSignal({source: "retry-hook", ...})`, which may pause, so a quota retry stops immediately;
    2. `stop = shouldStopRetry({..., planChild: rt.isPlanChild(sessionID)})`;
    3. if `stop`, it adds the child to `capacityStopped`.
  - `isPlanChild` means an unsettled `launcher.inFlight()` entry with that `childSessionID`. Orchestrator, user and grandchild sessions feed signals (provider capacity is shared) but are never stopped.
  - **The attempt.** A later `ChildEnd` of kind `failed` for a child in `capacityStopped` is journaled as row 18 `capacity-stop` with AE(capacity), uncounted. **Resolves** the case where `executionFailureOutcome` would say `failed` for a non-capacity error after the stop. `completed` / `lost` / `interrupted` take their ordinary rows. Rt never cancels on a stop.
  - It never throws (`types.ts:1732`); on error it returns `{stop: false}`.
- **M19. stepKey (3.1.7).** `"<sessionID>:<k>"`. k advances on `session.step.started` only after the previous step of the session ended (finished or failed without a pending retry). A host retry resend keeps k, and the retry hook and `session.retry.scheduled` of one step share it.
  - 3.1.7 reuses the per-session step counting of `v2-hooks.ts` countStep (≈300-307) if it already satisfies this.
  - *Amended (QA-3.1-21):* the retry hook can run before the event loop processed the step's `session.step.started`. When the session has no open step, the hook opens it first (the same advance), so the key it reads names this step; that `step.started`, processed later, is then a no-op (no second advance, the pending retry kept).
  - The provider comes from the session's last `step.started` `model.providerID` (3.1.7.c).
- **M20. Scope and restore.**
  - **One controller per plan**, fed by every session's signals. Each plan respects its own `maxParallel`. *Amended by A-3.1-1:* one active plan per process (amendment A-3.1-1, QA-3.1-7), so two live plans in one process can no longer together exceed one plan's limit (the earlier R4 text).
  - **Restore after a restart.** At open, Rt calls `store.exportPlan` (lock-free) and seeds each provider with `capacityRestoreFromEvents`, which replays the history's `capacity` metrics: the last `to`, and a still-future hold or pause. This prevents "capacity drift after restarts".

#### 4. Launcher A

- **M21. Capture (v2-client) and identity.**
  - `bootID` is 16 lowercase hex from `randomBytes(8)`, created once per v2-client instance; production has one instance per process. A `bootID?` option exists for tests.
  - Each `withToolContext` call (`v2-client.ts:249-258`) stores `RetainedContextInfo {sessionID, callID, messageID, agent, capturedAt, bootID, epoch}`. `epoch` comes from one counter per instance, shared by all sessions, so `stale-context:<bootID>:<epoch>` is unique. Listeners of `onContextCaptured` are notified synchronously after the store, each in its own try/catch.
  - 3.1.7 wires `onContextCaptured(c => executor?.onRouterToolCall(c.sessionID))`. Rt ignores sessions other than the bound orchestrator. `onRouterToolCall` schedules a tick and never awaits.
- **M22. Staleness.** `gate(orch)` is a pure read (`types.ts:1667`):
  - `disposed` → `{ok: false, reason: "disposed", wake: null}`;
  - `cap = runner.retainedContext(orch)` is null and L has seen a capture of `orch` (it tracks `lastEpoch` by session through `onContextCaptured`) → `no-context` with key `no-context:<bootID>:<orch>:<lastEpoch>`;
  - null and never seen → `awaiting-first-router-call` with key `await-router-call:<bootID>:<orch>` (guard 6; a restart yields a new bootID and an empty map);
  - `cap.epoch ≤ staleEpoch[orch]` → `context-stale` with key `stale-context:<bootID>:<cap.epoch>`;
  - otherwise ok, with `ageMs = now − capturedAt`.

  `markStale` (L6/L7 only, `phase-1.4.md:1039`) sets `staleEpoch[orch] = req.context.epoch`. A newer capture lifts the stale state.
  - **There is no age-based staleness**: age is recorded (guard 4), not gated. The contract encodes no age bound (`types.ts:1667`), and validity is proven by host acceptance (guards 1 and 2). If ADR D14 (L650-663) states an age bound, it wins, and this is a 3.1 QA item.
- **M23. Pinning against eviction.** v2-client's returned runner also exposes `pin(sessionID): () => void`. This is a concrete-type extension; `types.ts` is unchanged. The LRU loop (`v2-client.ts:254-256`) skips pinned sessions.
  - Rt pins the bound orchestrator at open, approve and adopt, and unpins at close, dispose and rebind (through a `pinOrchestrator` dep supplied by 3.1.7).
  - Eviction anyway (e.g. plan children making many router calls) degrades to `no-context` plus one wake; it does not stall.
- **M24. The six D14 guards.** Constants are at `phase-1.4.md:362-363`.

| # | Guard | Mechanism | Timeout |
|---|---|---|---|
| 1 | Confirmation | `Clock.setTimer(LAUNCH_CONFIRM_TIMEOUT_MS)` started in `launch()`. In time = `onCreated` entered before the deadline; the confirmation then settles with that hook's own outcome. Otherwise `unconfirmed/timeout` | 30 000 ms |
| 2 | Stale context | `markStale` on `timeout`/`threw` → gate `context-stale` → no further launch with that epoch; row 11 (`lost`, uncounted) | — |
| 3 | Refresh wake | Rt wakes once per key (M31) iff the gate is not ok, `wake !== null` and `readySet` is non-empty | debounce `wakeDebounceMs` (5 000) |
| 4 | Recorded age | `context-age` metric when the confirmation settles (M35) | — |
| 5 | Unexpected interrupt | `execution.interrupted` for a child with no `cancel()` recorded → `lost/unrequested-interrupt` (L14) | — |
| 6 | After a restart | gate `awaiting-first-router-call` until a capture of the bound session exists in this process | — |

  **Resolves "settles within 30 s":** 30 s bounds the host's creation of the child, not our own fsync inside the hook. A hook still running at the deadline means the confirmation waits for it. This avoids a confirmed-and-timed-out split, where the ledger says `running` while Rt thinks `lost`.
- **M25. `launch(req, hooks)`.** The synchronous part, before any host call:
  1. `E_DISPOSED` if disposed.
  2. `E_NO_CONTEXT` unless `gate(orch).ok` and `runner.retainedContext(orch)` equals `req.context` on (bootID, epoch, callID).
  3. `E_LAUNCH_TASK` if any of these fails:
     - the prompt starts with `"PLAN CONTEXT\n"`;
     - the first `LAUNCH_HEADER_PATTERN` match equals (planId, taskId, attempt, nonce). The first match is the header because `sharedContext` cannot contain a header-shaped line (invariant `shared-context-header`, `phase-1.4.md:1068`);
     - `deps.knownAgent(route.agent)`;
     - `ABSOLUTE_PATH_PATTERN.test(workRoot)`.
  4. Dispatch-time work, done by the executor itself because a retained launch fires no subagent hook (C14 `routerDecisionRows === 0`): `bookkeeping.decisionRow(req)`, `bookkeeping.recordDispatchStart(req, startedAt)`, `bookkeeping.registerInFlight(t, n, null)`.
  5. `controller = new AbortController()`; `signal = AbortSignal.any([controller.signal, deps.lifetime])` (executor-owned).
  6. `runner.run({parentSessionID: orch, prompt, agent: route.agent, model: route.model, cwd: workRoot, signal, detached: true, context: req.context, onCreated})`. The agent and model are explicit (C14: honoured).
  7. Return the handle. Rt has already fsynced row 4 with the nonce (M6), so the nonce is durable before the await.
- **M26. `onCreated(child)`** (the runner awaits it before `session.move` and before prompting; `v2-client.ts:195-198`).
  - **In time:**
    1. Clear the timer.
    2. `bindings.bind({childSessionID, role, agent, workRoot, grant, planId, taskId, attempt})`. A throw gives `unconfirmed/task-error` (L8) and is rethrown.
    3. `bookkeeping.registerInFlight(t, n, child)`.
    4. `await hooks.onChildCreated(child)`, which journals row 10 and fsyncs. A throw gives `unconfirmed/hook-failed` (L9) and is rethrown.
    5. `confirmed {latencyMs}`.
  - **Late:** `await hooks.onLateChild(child)`. `"refuse"` → throw (L11). `"adopt"` → bind, register, `await hooks.onChildCreated(child)` (row 7, L12).
  - A rethrow makes the runner interrupt the child (`v2-client.ts:223-228`). The child is never prompted, so it cannot have run a tool.
- **M27. Why resetting a kept slot is safe.** An unconfirmed child is never prompted (`v2-client.ts:195-197`), so Rt may reset a kept slot (R4) for a new attempt. Rt's per-task mutex (M4) also serializes the late-adopt `onChildCreated` against the launch step. An adopt that loses the race finds the task `dispatched` with a newer n and refuses.
- **M28. Ending a launch** (the `completion` promise settles exactly once and never rejects).
  - **Before confirmation:**
    - `isContextSupersededError` → `lost/context-superseded` (L5, not stale);
    - any other throw → `lost/runner-error`, `markStale` (L6);
    - `cancel` before a child exists → `interrupted/<reason>`.
  - **After confirmation:**
    - runner `{text}` → `completed`;
    - runner throws → wait up to `CHILD_END_GRACE_MS` for the child's terminal event: `failed` → `executionFailureOutcome`; `interrupted` → `interrupted/<reason>` if `cancel()` was called, else `lost/unrequested-interrupt`; `completed` → `completed` with the last assistant text from `hosts.context`; none → `lost/runner-error` (L13).
  - **D2 fallback trigger:** a terminal event of the child before the runner settles settles immediately for `failed`/`interrupted`. For `execution.completed`, L waits up to `CHILD_END_GRACE_MS` for the runner's text, then falls back to `hosts.context`.
  - **On settle:** `unregisterInFlight(t, n)`, `bindings.evict(child)`.
  - **Events** reach L through `HostSessions.onEvent` (M46).
  - `cancel` records the reason, aborts the controller and calls `hosts.interrupt(child)` if the child is known; it is idempotent. `dispose` aborts every controller (L17).
- **M29. Gate re-read before row 4.** Rt reads the gate again just before the row-4 append, after the slow slot reset, and takes AS.callID from that read. Otherwise any orchestrator router call during a reset would turn every launch into L3/L5 losses.
- **M30. v2-client changes in 3.1.5** (additive; with `detached` absent, behaviour is byte-for-byte today's, so the 37 existing `v2-client.test.ts` tests pass unchanged).
  1. Request type: add optional `detached?: true` and `context?: ContextRef`. If `ChildSessionRunner` is declared outside v2-client.ts, declare locally `type V2RunRequest = Parameters<ChildSessionRunner["run"]>[0] & { detached?: true; context?: ContextRef }`, and `export type V2ChildRunner = ChildSessionRunner & ChildRunner & { pin(sessionID: string): () => void }`. No other file changes.
  2. Retained map value `{context, active}` gains `info: RetainedContextInfo`, set in `withToolContext` before line 252's re-insert. Add `bootID`, `retainedContext(sid)`, `onContextCaptured(fn)` and `pin(sid)` to the `childRunner` object. Make the LRU loop at 254-256 skip pinned sessions.
  3. `run()`, right after `lifetime.signal.throwIfAborted()` (line 98), when `request.detached === true`:
     - require `request.context` and `request.signal`;
     - `entry = retainedContexts.get(request.parentSessionID)`;
     - if `!entry` or (bootID, epoch, callID) differ, throw `new ContextSupersededError(request.context, entry ? refOf(entry.info) : null)`. This is before `ctx.tool.list()` (line 110), i.e. before any host call;
     - `scope = entry`. The AsyncLocalStorage `current` (line 99) is never used for detached runs.
  4. Line 117 becomes `...(scope.active && !detached ? [toolContext.signal] : [])`.
  5. Lines 204-207 forward only when `scope.active && !detached`. This is the record-only progress: progress is used for child detection (173-200) and confirmation (201) and is never forwarded.
  6. Unchanged: `background: false` (169), `markRunnerDispatch` (162), `onCreated` → `move` order (197-198), interrupt on failure (223-228).
- **M31. binding.ts change in 3.1.5** (additive; the existing tests in `roles.binding.test.ts`, `roles.authority.test.ts` and `roles-dispatch.test.ts` stay unchanged).
  - New export `bindPlanChild(i)`. It writes the same record `bind` (:421) produces (role, agent, grant, workRoot) plus `plan: {planId, taskId, attempt, taskRef: leaseTaskRef(planId, taskId), scope: "until-integrated"}`. This is the A3 handoff: the 2.1 guard joins plan-child leases with this identity (`phase-1.4.md:1117,1149`).
  - It needs no `registerPending` (:391), because there is no hook call to pair with.
  - It throws if the child already has a binding with a different role or root (fail closed; this becomes L8).
  - `currentBinding` (:454) returns the record, `plan` included. The adapter's `evict` maps to `evict` (:514).

#### 5. Liveness

- **M32.** There is one `Waker` per plan, created by Rt (`createWaker`) and passed to P, QL and Q through `collaborators`.
  - Dedupe uses `writer.wakeKeys()` (`types.ts:1338`). Rt checks `wakeKeys().has(key)` before calling, so the "duplicate" result appears only on races.
  - `sent`: journal `wake` (durable), then `synthetic({sessionID: ledger.orchestratorSessionID, text, description: "plan <planId>", metadata: {planId, reason, stateKey}, resume: true})`.
  - `debounced` (within `wakeDebounceMs` of the plan's last sent wake): Rt arms one tick timer at `lastWake + wakeDebounceMs`. Evaluation is state-based, so the wake is retried, never lost.
  - `failed`: Rt retries with `<key>#2` and then `<key>#3`, each at least `wakeDebounceMs` apart; then counter `wake-failed` and stop (A1-6, `phase-1.4.md:1049`).
- **M33. Wake sources and keys.** Every key is derivable from the ledger, so a restart never wakes twice.

| D15 reason | When | Who | stateKey |
|---|---|---|---|
| `inbox` | `inbox-added` (open item) | P (`raise`); Rt for Q's `onInbox` | `inbox:<id>` |
| `phase-paused` | a phase `paused === true` | Rt tick | `phase-paused:<phaseId>:<anchor>`, anchor = id of the newest inbox item whose task is in the phase, else `none`. Skipped when `inbox:<anchor>` is already burned (one wake per incident) |
| `plan-completed` | status → completed | Rt | `plan-completed:<planId>` |
| `manual-ready` | a manual/preflight task is `ready` | Rt tick | `manual-ready:<taskId>:<number of incoming edges>`. A reopened task (`dep-added`) gets a new key; a revert-then-unblock cycle does not re-wake (accepted) |
| `stale-context` | gate not ok with a wake and `readySet` non-empty | Rt tick | the A1-6 keys (M22) |

- **M34. Root-session idle (3.1.7.e).** Derived from the orchestrator's own `HostSessionEvent`s: `step.started` means busy; `execution.completed|failed|interrupted` means idle. Used only by `idle-with-ready` (M35).

#### 6. Plan-task verification path

- **M38.** After row 15, Rt calls `commitTaskInSlot(git, {slot, branch: "omr/<planId>/t/<taskId>", message: "<taskId>: <title> (attempt <n>)"})`.
  - Steps: `git status --porcelain` → none: `{changed: false}`; else `git switch -C <branch>`, `git add -A`, `git commit -m <message>` → `{changed: true, commit}`.
  - No AI attribution. `E_IDENTITY` and `E_GIT` → row 23.
  - Changes → row 21 → `slots.cleanForChecks(slot)`, so the verdict is about the committed tree → `verifier.verify(task, slot, attempt)`.
  - PASS → row 25, then `queue.enqueue([id])` after the fsync. Integration happens only after PASS, and the leases stay held, with the slot non-null, until Q's row 30.
  - FAIL / unverifiable → row 26, then the retry decision: `hasAttemptsLeft` → row 35, else `policy.park(id, "exhausted", findings)`.
  - The `SlotVerifier` adapter returns `pass` with findings "no checks" for a task with no acceptance block and `VERIFY` not required (3.1.7).
- **M39. No-change completion** (adopts `phase-1.4.md:747`). If `footprint.writes` is non-empty and VERIFY is `required`, the task gets row 23 (`commit-failed`, detail "no changes"), then the retry decision. Otherwise it gets row 22 (`done`). The plan's "no-change task reaching done" test uses a task with no writes.
- **Counting.** After each batch that settles a counted result (rows 12, 16, 23, 25, 26, and Q's 31/32), Rt calls `policy.recordAttempt(phaseId, attempt)`. §4 decides the counting; this memo does not redefine it. A trip pauses and wakes inside P.
- **Integration listener.**
  - `onIntegrated`: tick.
  - `onConflict`: `slots.reset(slot, integration.head)`, then the retry decision. Row 31 already wrote the conflict context in AX.
  - `onFailed`: the retry decision.
  - `onReverted`: M8, then the 35b/36 decision for the reverted task.
  - `onGate(p, "awaiting-qa")`: `qa.onAwaitingQa(p)`, then tick.
  - `onInbox`: wake `inbox:<id>`.
- **Child text classification** (first line):
  - `NEED MORE: lease <path>` → M13;
  - `ESCALATE:` → park `escalate`;
  - `NEED CONTEXT:` / `SCOPE GROWTH:` / any other `NEED MORE:` → park `ambiguity`;
  - otherwise (`DONE:` or unprefixed) → the ordinary path.
  - A qa task first goes through QA5/QA6.
- **M40. Runaway uncounted attempts** (adopts `phase-1.4.md:746`, scoped).
  - **Trigger:** three trailing attempts of one task with outcome `lost` and detail ∈ {`unrequested-interrupt`, `runner-error`} (L13/L14 only; context-level losses are already throttled by the gate).
  - **Action:** Rt journals `status-changed running→paused` (reason `lost-streak:<taskId>`), then `policy.raise({kind: "failure", ...})`.
  - It pauses the whole plan rather than the phase because un-pausing a single phase has no path yet (`phase-1.4.md:1133`), while `ExecutorRuntime.resume` exists.

#### 7. Metric events (`MetricPayload`, `phase-1.4.md:304-312` as amended at `:1003-1004`)

- **M35.** All metrics are `metric` events: non-durable, their own batch, history-class. The variants:
  - **`idle-with-ready`** `{fromAt, toAt, ms, readyTaskIds, free}`. The interval opens at a tick where the orchestrator is idle (M34), the plan is `running`, `readySet` is non-empty and nothing could be launched (gate not ok, slot unavailable, lease race). It closes at the first tick where any of these stops holding. It is emitted at close. `free` is the sum of `free(p, false)` at open.
  - **`wake`** `{reason, stateKey, result}`: emitted by the Waker for every `wake()` call.
  - **`launch`** `{taskId, attempt, agent, model: "<provider>/<model>[#variant]", provider, heavy}`: emitted by Rt after `launch()` returns.
  - **`context-age`** `{taskId, attempt, bootID, epoch, callID, capturedAt, ageMs, result: confirmed|timeout|threw|superseded|task-error|hook-failed}`: emitted by L through `deps.onMetric` once the confirmation settles, then journaled by Rt. "The launcher never journals" holds.
  - **`capacity`** `{provider, change: decrease|increase|pause|resume|retry-stop, from, to, until, errorType, status}`: emitted by the controller on every change through `onMetric`.
  - **`counter`** `{key, value: 1, labels}`, with these 3.1 keys:
    - `launch-skipped` {reason: slot-unavailable | lease-race | provision | capacity-race};
    - `launch-failed` {row: L1..L17};
    - `learned-edge` {result: added | free | exists | cycle | foreign};
    - `lost-streak-pause`;
    - `lease-rebuild-failed`;
    - `wake-failed`.

#### 8. File-by-file API and tests

**`schedule.ts` (3.1.2)**
```ts
export function taskDurationMs(task: TaskNode): number;                                   // p50 ms; cancelled -> 0
export function bottomLevels(ledger: Readonly<LedgerV1>): ReadonlyMap<TaskId, number>;    // M9
export function planOrder(ledger: Readonly<LedgerV1>): ReadonlyMap<TaskId, number>;       // M10
export function edgeSatisfied(ledger: Readonly<LedgerV1>, edge: Edge): boolean;
export function pathsOverlap(a: string, b: string): boolean;                              // M11
export function createScheduler(): Scheduler;                                             // types.ts:1504-1515
```
Tests (`executor-schedule.test.ts`, plan:3067-3073):
- diamond, chain, wide fan-out cut at `free`;
- two phases with a gate (blocked until `passed`), `crossPhase: inferred`;
- bottom-level order and plan-order ties; gate successors (M9 b/c);
- soft overlap: held by a lease, and inside one selection (the second task is delayed);
- learned edge: added, exists → null, cycle → null;
- `done` satisfies its dependents;
- the 100 seeded DAGs with p = 4 within `(2 − 1/p)·max(CP, W/p)`, and an in-test reference list scheduler giving a makespan ratio within [1.0, 1.15];
- also: manual/preflight excluded; paused phase; non-running plan; R16 qa task; a holder of another plan; heavy cap; independent providers; determinism; `promotable`; `manualReady`.

**`capacity.ts` (3.1.3)**
```ts
export interface CapacityProviderState { limit: number; holdUntilMs: number; lastSignalAtMs: number | null; pausedUntilMs: number | null }
export interface CapacityOptions {
  maxParallel: number; cooldownMs: number; pauseMs: number; heavyCap?: number; clock: Clock;
  onMetric(m: Extract<MetricPayload, { name: "capacity" }>): void;
  restore?: Readonly<Record<string, CapacityProviderState>>;
}
export function createCapacityController(o: CapacityOptions): CapacityController;       // types.ts:1528-1545
export function capacityView(c: CapacityController, routes: RouteResolver): CapacityView; // memoizes routeOf per task id
export function pauseUntilFromMessage(message: string, nowMs: number): number | null;    // M17
export function capacityRestoreFromEvents(events: readonly ExecutorEvent[], o: { maxParallel: number; nowMs: number }): Record<string, CapacityProviderState>;
```
Tests (`executor-capacity.test.ts`, plan:3074-3075):
- one 429 (8 → 4, held);
- three in a row on distinct steps (4, 2, 1, floor), while repeats of one step decrease once;
- recovery after the cooldown (+1 per qualifying success; none during the hold; none from a token acquired before the signal);
- usage-limit pause with one inbox item, extension without a second item, then `resume`;
- two providers independent;
- `shouldStopRetry` true for a plan child (paused; first signal older than the cooldown) and false for `planChild: false`;
- quota without a future instant → `capacityPauseMs` (past and zoneless instants ignored);
- unknown type by status (429, 529);
- heavy cap 2; `force`; a metric for every change; restore.

**`expand.ts` (3.1.4)**
```ts
export interface ExpansionEnv { worktrees: readonly string[]; longPaths: boolean }
export function loadExpansionEnv(git: GitRunner, i: { toplevel: string; slotPath: string; timeoutMs: number }): Promise<ExpansionEnv>;
export interface PathMap { mappable: readonly string[]; inRepo: readonly string[]; slot: string; longPaths: boolean }
export function rewriteAbsolutePaths(text: string, map: PathMap): string;     // E_LAUNCH_TASK on unmappable / > 260 chars
export function renderRouteLine(task: TaskNode, slotPath: string): string;   // whitelist re-serialization
export function renderTaskBlock(ledger: Readonly<LedgerV1>, task: TaskNode, slot: SlotLease, map: PathMap): string;
export interface ExpandInput { ledger: Readonly<LedgerV1>; taskId: TaskId; attempt: number; nonce: string; slot: SlotLease; env: ExpansionEnv }
export interface ExpandedTask { prompt: string; routeLine: string; acceptance: string | null; verify: string | null; workRoot: string }
export function expandTask(i: ExpandInput): ExpandedTask;                    // pure; throws ExecutorError E_LAUNCH_TASK
```
- **M36. Expansion.**
  - **Prompt:** `prompt = formatLaunchPrompt(ledger.sharedContext, {planId, taskId, attempt, nonce}, taskBlock)` (`phase-1.4.md:1077`).
  - **taskBlock order:**
    1. `TASK <id>: <title>`, then the text;
    2. `SUBTASKS`;
    3. `Writes:`, then `Reads:`;
    4. `ENVIRONMENT` (working directory = slot path, base commit = `slot.commit`, the `slotEnvFor` (`slots/env.ts:103`) entries sorted by key);
    5. `ACCEPTANCE` (the criteria as prose);
    6. `ATTEMPT CONTEXT` (the latest attempt's context, if any);
    7. `MUST NOT DO` (the three plan rules, verbatim);
    8. for qa only, `FINDINGS FORMAT`: the instruction to end with one json fenced block matching `JSON.stringify(FINDINGS_FORMAT)`.
  - **Formatting:** `\n` only, no trailing spaces.
  - **Prefixes:** `mappable` = the worktrees plus this task's declared `root=`, longest first. `inRepo` = `mappable` ∪ `repo.toplevel` ∪ every declared `root=` of the plan.
  - **Matching:** a prefix matches at a segment boundary (end of string, `\` or `/`), case-insensitively for drive/UNC paths and through `path.win32` on every OS, case-sensitively for POSIX paths.
  - **Route line:** re-serialized from the tokens class, risk, scope, needs, d, `root=<slot>`, tier, pin. A value outside its token pattern, or containing whitespace, `]` or a newline, fails. `[tier:X]` gives `tier=X pin`. Plan text is never concatenated into it.

Tests (`executor-expand.test.ts`, plan:3076-3081):
- byte-stable per attempt, different for n + 1;
- header round trip through `parseLaunchHeader(prompt, sharedContext)`; no launcher B grammar;
- route `root` and tier; acceptance `cwd`; findings instruction; MUST NOT DO;
- Phase 6.1 with the injected worktree list (`D:\git\omr-cpx-main`, root `D:\git\omr-cpx-p61`) through `GitRunner`, with no p61 or main path left. Use the existing frozen fixture if 2.3 has one; otherwise embed the excerpt in the test file (3.1.8 Writes);
- a prefix ending inside a segment is not rewritten;
- unmappable path; > 260 characters without `core.longpaths` (and passing with it);
- S-style fallback ids accepted; an injection attempt (`]`, newline, `[route`) never reaches the route line.

**`launch.ts` (3.1.5)**
```ts
export type PlanBindInput = Parameters<RoleBindings["bind"]>[0] & { planId: PlanId; taskId: TaskId; attempt: number };
export interface PlanRoleBindings { bind(i: PlanBindInput): void; evict(childSessionID: string): void }
export interface TaskLauncherDeps {
  runner: ChildRunner; hosts: HostSessions; bindings: PlanRoleBindings; bookkeeping: DispatchBookkeeping;
  clock: Clock; lifetime: AbortSignal; knownAgent(agent: string): boolean;
  onMetric(planId: PlanId, m: Extract<MetricPayload, { name: "context-age" }>): void;
  confirmTimeoutMs?: number;   // default LAUNCH_CONFIRM_TIMEOUT_MS
  endGraceMs?: number;         // default CHILD_END_GRACE_MS
}
export function createTaskLauncher(d: TaskLauncherDeps): TaskLauncher;     // types.ts:1666-1684
export function staleContextKey(bootID: string, epoch: number): string;
export function noContextKey(bootID: string, sessionID: string, lastEpoch: number): string;
export function awaitRouterCallKey(bootID: string, sessionID: string): string;
```
Tests (`executor-launch.test.ts`, plan:3082-3091):
- table-driven L1-L17 rows (confirmation, completion, stale), as far as they are launcher-observable;
- bound before the first tool call (bind inside `onCreated`, before the runner continues);
- a refreshed context lifts the stale state; an expired context gives `context-stale`;
- the confirmation timeout on a fake clock;
- unrequested interrupt → `lost`; restart → `awaiting-first-router-call`;
- the age metric per result;
- no `synthetic` and no parent prompt during a launch (no parent-history message);
- bookkeeping order (decision row, dispatch start, in-flight registration, before `run`);
- `signal` is executor-owned; `detached: true`; `context` passed.

Additions to `v2-client.test.ts` (existing cases untouched):
- detached ignores an aborted retained `toolContext.signal`;
- progress is not forwarded while the call is active;
- `ContextSupersededError` is thrown before `ctx.tool.list`;
- epoch and `capturedAt` on capture; pinned sessions survive the LRU.

Additions to the binding tests: `bindPlanChild` record and conflict throw.

**`runtime.ts` (3.1.6)**
```ts
export interface LeaseRegistryPort {
  acquireWrite(holder: { holderID: string; tree: string; isChild: true; taskRef: string; scope: "until-integrated" }, writes: readonly string[]):
    | { ok: true } | { ok: false; reason: "held" | "unknown-target"; holders: Array<{ holderID: string; taskRef: string | null }> }
    | { ok: false; reason: "cap" | "invalid"; message: string };
  releaseTask(taskRef: string): void;
  holderOf(path: string): { holderID: string; taskRef: string | null } | null;
}
export function createLeaseService(planId: PlanId, registry: LeaseRegistryPort): LeaseService;   // A3; never restore
export interface WakerDeps { writer: LedgerWriter; hosts: HostSessions; clock: Clock; debounceMs: number;
  text(reason: WakeReason, stateKey: string): string; onMetric(m: Extract<MetricPayload, { name: "wake" }>): void }
export function createWaker(d: WakerDeps): Waker;
export function commitTaskInSlot(git: GitRunner, i: { slot: SlotLease; branch: string; message: string; timeoutMs: number }):
  Promise<{ changed: false } | { changed: true; commit: string }>;
export interface PlanCollaborators { queue: IntegrationQueue; policy: UnattendedPolicy; qa: QaLoop }
export interface RuntimeDeps {
  store: LedgerStore; compiler: PlanCompiler; slots: SlotPool; scheduler: Scheduler; launcher: TaskLauncher;
  routes: RouteResolver; verifier: SlotVerifier; git: GitRunner; hosts: HostSessions; clock: Clock;
  leaseRegistry: LeaseRegistryPort; recovery: RecoveryService | null; holder(sessionID: string): LockHolder;
  capacity(o: CapacityOptions): CapacityController;
  collaborators(i: { writer: LedgerWriter; leases: LeaseService; waker: Waker; listener: IntegrationListener }): PlanCollaborators;
  pinOrchestrator(sessionID: string): () => void;
  log(level: "info" | "warn" | "error", msg: string, detail?: JsonValue): void;
}
export interface ExecutorRuntimeHandle extends ExecutorRuntime {
  settled(): Promise<void>;                                  // no tick, pipeline or metric append pending
  manualReady(sessionID: string): Array<{ taskId: TaskId; kind: string }>;
  isPlanChild(sessionID: string): boolean;
}
export function createExecutorRuntime(d: RuntimeDeps): ExecutorRuntimeHandle;
```
- **M37. Launch step** (inside the per-task mutex):
  1. `capacity.acquire`;
  2. `slots.acquire(planId, leaseHolderID(planId, id), integration.head)`, then `reset`;
  3. `leases.acquireTask({taskId, tree: slot.path, writes})`. This is re-entrant for a kept slot. A `held` result is a lease race: release only what this step newly acquired (the slot iff it was null before), then skip;
  4. prep: `loadExpansionEnv`, `expandTask`, `routes.route`, `nonce = clock.randomHex(16)`. `E_LAUNCH_TASK` → row 4b; `E_GIT` → skip, counter;
  5. gate re-read (M29);
  6. row-4 builder; `[]` or a throw → release what was newly acquired, token `release(other)`;
  7. R4 cancel `superseded`;
  8. `launch`.

  The thin interface methods delegate. `compile`/`residue` → compiler + `draft-replaced`. `approve` → `plan-approved` + `status-changed`, pin. `done` → row 8. `pause`/`resume` → status, and `resume` calls `checkPhase` per A2-1. `abort` follows A1-8 exactly. `land`/`gc`/`exportPlan`/`purge` delegate. `adopt` → `recovery.adopt`, then repin. At open, `leases.rebuild` failures raise one inbox item each (A3 handoff).

Tests (`executor-runtime.test.ts`, plan:3092-3094, with typed doubles for `IntegrationQueue`, `UnattendedPolicy` and `QaLoop`):
- full lifecycle to `integrated`, and to `done`;
- FAIL with attempts left, and exhausted (park);
- conflict (slot reset, then ready with context);
- no-change task `done`, and the M39 variant;
- commit failure;
- leases held until Q's row 30, never released by Rt on `onIntegrated`;
- a manual task ready wakes once (none after a restart);
- a stale context gives exactly one wake, debounce retry, `#2`/`#3`;
- nonce durable before `launch` (doubles record the order);
- learned edge 18b, 18b′, and R6;
- QA result to `QaLoop`;
- capacity-stop is uncounted, while a non-plan session's retry is untouched;
- lost streak; abort order;
- the late-adopt/launch race (M27);
- every metric variant emitted.

**3.1.7 wiring** (`v2-hooks.ts`, `background.ts`)
- **W1.** Build the executor host adapters where the v2 client is created:
  - `HostSessions` over `ctx.session` plus an emitter;
  - `RouteResolver` over `dispatchRouter.route` (≈2555-2578), with the tier pin and agent/model;
  - `PlanRoleBindings` over `bindPlanChild`/`evict`;
  - `DispatchBookkeeping` over the existing decision-row writer, `recordDispatchStart` and the background.ts in-flight registry, with rows tagged `source: "executor"`;
  - `SlotVerifier` over the verification engine;
  - `LeaseRegistryPort` over the Phase 1.3 registry;
  - `pinOrchestrator` → `childRunner.pin`.
- **W2 (3.1.7.a).** `childRunner.onContextCaptured(c => executor?.onRouterToolCall(c.sessionID))`.
- **M41 (3.1.7.a, always on).** The fail-closed check.
  - **Where:** in the first context hook where v2-hooks sees a session's first user message.
  - **Refused when:** `looksLikePlanPrompt(text)` is true and either `currentBinding(sid)` is null, or the header's planId/taskId differs from `binding.plan`.
    *Amended (QA-3.1-16):* the check is prefix-anchored, not `looksLikePlanPrompt` (QA-3.1-9 (a)). The text is a launcher prompt only when the §7 grammar (`"PLAN CONTEXT\n"`, the shared context, the launch header read by `parseLaunchHeader` at its grammar position) starts at offset 0, or right after exactly the one preamble line the v2 host puts before a native subagent's first user message (`You are a subagent spawned by another session.`, ending in `\n` or `\r\n`). Any other leading text makes it an ordinary prompt, never refused.
  - **Effect:** the session joins `refusedPlanChildren`, and `tool.execute.before` throws for every tool of it.
  - **Fallback:** if a session's first tool call arrives before that hook ran, `tool.execute.before` performs the same check first.
- **W3 (3.1.7.b).** The 2.1 guard: for a session whose binding has `plan`, it acquires with the holderID = child, `taskRef`, `scope: "until-integrated"` and tree = slot. It never releases at child end; release is `releaseTask` only.
- **W4 (3.1.7.c).** `session.step.started` records the provider and the stepKey (M19). `session.retry.scheduled`, `session.step.failed` (branch ≈354) and `session.execution.*` → `HostSessionEvent` → emitter. The registered `session.hook("retry")` (≈3250): `if (executor?.onRetryHook({sessionID, stepKey, error}).stop) decision.retry = false`, wrapped in try/catch so the decision stays unchanged on error. The existing `countStep` and `classify` logic is untouched.
- **M46.** There is one event path. v2-hooks only `emit(e)`s. The runtime subscribes `onHostEvent` through `hosts.onEvent` in `start()`, and the launcher subscribes for child ends. v2-hooks must never call `executor.onHostEvent` directly as well (no double delivery).
- **W5 (3.1.7.d, background.ts).** Entries registered through `DispatchBookkeeping.registerInFlight` are `executor`-owned and excluded from the ordinary completion and verification path. On settle, the launcher submits a `Trigger {kind: "runner"}` (`background.ts:1300-1306`), so the `CompletionProcessor`'s D2 dedupe (`:1342-1357`) marks the child finished, and a later `execution.*` trigger for it is a duplicate. `LaunchHandle.completion` is the only settle point.
- **W6 (3.1.7.e).** The orchestrator's events also go through the emitter (M34). Register the turn-state provider "plan" (`turn-state.ts:26-39`, `PLAN_PROVIDER_NAME`) with `planLine` plus a ready section listing `manual (<kind>)` from `manualReady`.
- **W7.** Plugin dispose → `executor?.dispose()` → `launcher.dispose()`.

Tests:
- `v2-hooks.test.ts`: capture → `onRouterToolCall`; stop only for a plan child; provider from `step.started`; unbound plan child refused; executor-owned completion not double-processed; root idle; with the executor null, nothing changes.
- `test/integration/v2-executor-launch.test.ts`: real v2-client, launcher and runtime with doubles for Q, P and QL. The child is bound with role and root = slot before its first tool call; `routerDecisionRows === 0` from hooks and exactly one executor row; no task is launched twice.

#### 9. Risks and order of implementation

**Risks**
1. **stepKey semantics (M19).** If the host emits `step.started` per retry resend, a naive count compounds decreases. Mitigation: the "advance only after an end" rule, and a test with a recorded host sequence.
2. **Rows 13/19 release ownership (M8).** This needs 3.2 to agree. Until then, both releases are idempotent.
3. **Per-plan capacity (M20).** Two plans in one process can exceed one plan's limit. Accepted and documented. *Amended by A-3.1-1:* one active plan per process (amendment A-3.1-1, QA-3.1-7), so this risk no longer arises.
4. **Eviction (M23).** If pinning is not wired, it degrades to wakes, not a stall.
5. **Gate-to-launch races (M29).** Mitigated; the residual is the fsync window only (L3/L5, uncounted).
6. **A hook outliving the 30 s guard (M24).** A deliberate refinement of "settles within".
7. **Coverage gate.** 3.1.2-3.1.6 write no tests (3.1.8 owns them), so `src/executor` is below 90/90/90 until 3.1.8. Do not push before 3.1.8 lands.
8. **Byte stability against worktree drift.** Only prefixes that match matter, and the prompt is rendered once per attempt; recovery uses `parseLaunchHeader` only.
9. **No age-based staleness (M22).** QA should confirm this against ADR D14 L650-663.
10. **Wake noise.** Mitigated by one wake per incident (M33) and the key pre-check (M32).
11. **Heavy starvation under the heavy cap.** Bounded: priorities are static, the task set is finite, and the highest bottom level is picked first whenever capacity frees.

**Order** (the plan's, `:2852`; each item stands alone against `types.ts`):
1. 3.1.2 `schedule.ts`, 3.1.3 `capacity.ts` and 3.1.4 `expand.ts`, in parallel.
2. 3.1.5 `launch.ts`, then the additive changes to v2-client.ts and binding.ts. The existing v2-client and binding tests must stay green after each edit.
3. 3.1.6 `runtime.ts`, including `createLeaseService` and `createWaker`.
4. 3.1.7 wiring with a nullable executor (M3), so existing v2-hooks tests pass unchanged.
5. 3.1.8 tests and coverage.
6. QA.

Inside 3.1.6, build in this order: lifecycle rows → launch step → liveness → metrics → the thin interface methods.

## WIP notes (2026-10-12, interrupted by DF-1.1-3)

Commit `7f375f3` holds untested partial work: `schedule.ts` + `executor-schedule.test.ts` (implementer ended by a host
error), `capacity.ts` complete per M14-M18/M20 with a placeholder test only, `expand.ts` partial. Decisions the capacity
implementer took (confirm in the next session, then write the memo §8 tests): inbox severity `info`; inbox `taskId`
always `null` (the runtime fills the plan child's task); a signal at the floor (limit 1) still renews the hold and emits
a `decrease` 1→1 metric so restore sees it, returning `decreased: false`; metric `until` = hold end for a decrease,
pause end for a pause, `null` otherwise (`capacityRestoreFromEvents` relies on it); `capacityView` reads used counts via
a module-level WeakMap and answers `canAcquire ? 1 : 0` for foreign controllers; `onMetric` errors propagate (metrics
are emitted after the state change).
