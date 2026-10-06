# Phase 2.3 — Ladder wiring: resume with variant/model on v2 (M5 in `delegate`)

> Plan: `D:\git\opencode-model-router\docs\plans\cost-aware-routing-engine-plan.md` §0.11, §1.2, §1.3 M5, D1, D2, D10, D11, amendments A1, A3, A5, A7, A9, A11, A15, A17, A17a, A20, A21, §3 "Phase 2.3".
> Worktree `D:\git\omr-car-p23`, branch `car/p23`, base directory `D:\git\opencode-model-router`. Issue #74.

## Pre-flight

| Item | Result |
|---|---|
| Worktree and branch | `D:\git\omr-car-p23`, branch `car/p23`, created from `car/main` @ `a2a132d`; `npm ci` done by the orchestrator; `git status --short` empty before the first subtask |
| Dependencies | **2.1 merged (`a08229c`)**; Phase 1.5 (`src\escalate\ladder.ts`, `variants.ts`) and Phase 1.1 (`resolveVariantSteps`, `resolveRouting`, `resolveCandidates`) are in the base |
| **Linear** | **Linear: not used** (`phase-0P.md`, `phase-2.1.md`; no Linear key in the repo) |
| **Parallel phase** | **Phase 2.2 runs in parallel in `D:\git\omr-car-p22`; it owns `src\compat\v2-hooks.ts` `execute.before` and the context hook.** This phase does not touch `src\compat\v2-hooks.ts` at all (`git diff a2a132d..HEAD --stat` lists no such file). Its `src\index.ts` edits are confined to the delegate runner, its start-up wiring and the plugin imports (hunk list below), none in the `/router` or `/annotate-plan` handlers (2.4's). |
| Spike verdicts used | S2 (resume with `sessionID` + higher variant, agent switch on resume: `phase-0P.md` S2, S2-agent-native, S2b), S6 (auto compaction does not guarantee fit: A5), S3/S3b (events delivered once per instance, A3) |
| Handoffs read | `phase-1.3.md` ("to 2.3"), `phase-1.4.md` (round 1 and round 2 "2.3" items), `phase-1.5.md` ("To 2.3", F5, R1, QA-1.5-2/13/20/22, F9), `phase-2.1.md` ("To 2.3", "Deferred by plan"), `phase-1.1.md` (A15 via 1.5), `phase-1.2.md` and `phase-0P.md` (nothing addressed to 2.3) |
| Typecheck | `npm run typecheck` green at every commit and at `HEAD` |

## Implementation notes

### What was built

| Task | Files | Commit |
|---|---|---|
| 2.3.1/2.3.2 registry: the child's last-step context (D11) | `src\router\sessions.ts` (`noteStepContext`, `lastStepContext`), `src\routing\outcomes\ingest.ts` (5 lines in `onStepEnded`, before the settings gate) | `a08df6e` |
| 2.3.1 runner design as code: one pure plan per attempt | `src\escalate\resume.ts` (`planFirstAttempt`, `planNextAttempt`, `createCatalogLookup`, `FreshReason`) | `b3492f6` |
| 2.3.2 v2 child runner resumes | `src\compat\child-session.ts` (`resumeSessionID`, `ResumeRejectedError`, `routerCatalog` type), `src\compat\v2-client.ts` | `f5be429` |
| 2.3.2 registry entry + decision row per attempt | `src\escalate\attempt-recorder.ts` (`createAttemptRecorder`, `classifyDelegation`, `describeAttempt`) | `6297945` |
| 2.3.2 the delegate runner | `src\index.ts` | `72837da` |
| tests | see "Tests" | same commits, `643646e`, `e2aefd6` |

### Behaviour (what the runner does now)

With a `routing` block (A15: `resolveVariantSteps` is `auto`), on a v2 host with a child runner and a model catalog, the delegate ladder is **session-aware**:

1. `buildEscalatePolicy(activeCfg, { host: "v2", variantSteps, maxContextFraction: resolveRouting(...).sessionReuse.maxContextFraction, catalog, warn })`. The catalog is `ctx.routerCatalog()` (the list the v2 adapter already queries), through a lookup keyed `providerID/id`, cached 15 s per plugin instance, bounded by 3 s; a missing, failing or slow catalog logs once and leaves the policy **without** `variants`, which is exactly today's ladder.
2. Every attempt is a plan (`AttemptPlan`): agent, `provider/model#variant`, resume target, effort override, step label, rung `costRatio`. `planFirstAttempt` is what the runner always dispatched. `planNextAttempt(action, advanced state, previous plan, cfg, policy, catalog)` follows the ladder's action: `model`/`variant` from the action, `agent` from `action.agent`, `resumeSessionID` only when `action.resume === true` and the runner has no reason to start fresh.
3. A **failed verification** with a higher variant: the same `sessionID`, `model: same#nextVariant`, the forcing message as the prompt (`${forcing}\n\n${task}`, once) (D10). A **plain retry** keeps the reached variant. An **escalation** switches `agent` (and model) and resumes under the threshold (D11: `lastStepTokens + estimate(forcing + task) < maxContextFraction × inputBudget(next model)`, strict), or starts a fresh child over it, with the old child discarded before the new one is created.
4. **Per-attempt discard**: with a session-aware policy the child is no longer disposed at the end of its attempt; the loop disposes it once the ladder has said retry/escalate and the next plan does not resume it, and the existing `finally` disposes every producer child on every other exit (accept, give up, safety net, throw). Without a session-aware policy the disposal is where it was.
5. **Cost**: `recordAttempt(state, rungCost ?? tier ratio, child)`, with `rungCost = startCostRatio(policy, state)` for attempt 1 and `action.costRatio` afterwards (A17, QA-1.5-2, QA-1.5-20). `nextAction` gets `{ dispatchPromptChars: args.task.length }` (A5, F8).
6. **Telemetry**: each attempt is a new registration of its child in the 2.1 registry (`attemptId` unique, `step` = `dispatch | variant | retry | escalate`, `variant` = the dispatched one), made from `onCreated` (which the v2 client now also calls for a resumed child, after the ownership check, before the host runs it). When `routing.engine` is not `static` it also enqueues one `DecisionRow` per attempt. The verdict of each gate goes to `ingest.onVerdict` on that registration, so a pass after a variant step is a `variantPass` of the `#medium` key and the fail before it is a `fail` of the `#low` key.
7. **Fresh fallbacks** (each logged, each tested): unknown context (`unknown-tokens`: no step event reached the registry, or the producer errored/timed out), a catalog variant that is no longer valid (`invalid-variant`), a bare model sent to a child whose variant was set by a step (`bare-model-after-variant`, 1.5 R1), an escalation across an effort-configured tier (`effort-path`, QA-1.5-22), a resume the host side refuses (`ResumeRejectedError`).

With **no `routing` block** (or `variantSteps: "none"`, or v1, or no catalog) the policy has no `variants` key and: `catalog` is not even fetched (when `none`), nothing is registered (`dispatchCount() === 0`), `nextAction` gets no 4th argument, each attempt's child is disposed at the end of the attempt, the dispatched `agent`/`model` are the tier's, and `ChildSessionRequest` carries no `resumeSessionID`. The existing `ladder-wiring`, `ladder-effort-wiring`, `session-lifecycle`, `depth-guard-wiring`, `delegate-timeout` and `ladder*.test.ts` suites pass unmodified (golden fixtures untouched).

### The v2 client (`src\compat\v2-client.ts`)

- `run({ resumeSessionID })` first checks, through `ctx.session.get`, that the session exists and that `parentID` is the calling session (`scope.context.sessionID`); otherwise it throws `ResumeRejectedError` **before** `onCreated`, `native.execute` or any interrupt (the host resumes any id it is given, so ownership is ours to check; this answers the QA question "resumed session not a child of the current session").
- It then registers the child (`onCreated(resumeSessionID)`), and calls the host `subagent` with `sessionID`, `agent` and `model: provider/model#variant` (the existing formatting). `cwd` is not applied again; a different `sessionID` in progress metadata is the existing "changed its child session ID" error; the deadline, the request signal, the tool call's signal and the plugin lifetime abort it and interrupt the resumed child exactly like a created one; `dispose()` of the runtime reaches it through `activeChildren`.
- The delegate catches `ResumeRejectedError` only (not host errors after the call started): the same attempt starts on a fresh child, the refused child is disposed, nothing is counted twice.

### Handoffs to 2.3: how each was addressed

| # | Handoff (source) | Addressed by |
|---|---|---|
| 1 | Every ladder attempt enqueues a `DecisionRow` with `step ∈ { variant, retry, escalate }`, `resume` per D11/A5, `chosen` = ladder pick, `best` null, `switched` false (1.3 "to 2.3") | `attempt-recorder.ts` `record`: one row per attempt, `mode` = the engine, `childSessionID` set (the row is written at `onCreated`, when the child is known), `chosen` = the dispatched key, `best: null`, `switched: false`, `pinned: false`, `unit: "ratio"`, `costs: {}`, `resume` = the final fact (a rejected resume that fell back is written as fresh), `reason` carries the D11 verdict **and both numbers**. Also written for the first attempt with `step: "dispatch"` (a delegation's first dispatch has no other row; flagged below). Tests: `escalate-attempt-recorder.test.ts`, `routing-ladder-resume.test.ts` "telemetry (engine shadow)". |
| 2 | Keep the runner consistent with `simulate.ts`: plain retry re-runs the last rung; a start on a non-base rung counts as stepped; the floor lifts the first attempt; after a native chain the same delegation continues from the owning tier (1.4 round 1, round 2, verdict) | Plain retry: `plainRetry` emits `variant = currentVariant ?? base` and the plan dispatches it (test "a plain retry keeps the reached variant", `escalate-resume.test.ts`, and the integration walk). Floor: `newLadderState`/`resolveStartTier` unchanged and the first plan is `planFirstAttempt(cfg, state.currentTier)`. Non-base start: the delegate always starts on a tier's base rung (no dispatch starts "stepped"). **Native chains: not applicable to `delegate`**: it dispatches router tiers only (D12 role agents are candidates of the `subagent` hook, 2.2); `simulate.ts` is therefore unchanged and nothing in the runner continues a native chain. |
| 3 | Build the policy with `buildEscalatePolicy(cfg, { host, variantSteps, maxContextFraction: resolveRouting(cfg, host).sessionReuse.maxContextFraction, catalog })` (1.5 "To 2.3") | `index.ts` `execute`: exactly that, `catalog` non-throwing (`createCatalogLookup` returns `undefined` on a miss). |
| 4 | Pass `{ dispatchPromptChars: taskText.length }` to `nextAction` | Passed as `args.task.length` (the ladder adds the forcing message's length itself, `sessionFields`); only when session-aware. |
| 5 | After each attempt `recordAttempt(state, cost, { sessionID, lastStepTokens: stepContextTokens(lastStep.tokens) })` | `recordAttempt(state, costRatio, { sessionID: producerSid, lastStepTokens })`; `lastStepTokens` is `lastStepContext(child)` (the registry value, which the ingest computes with `stepContextTokens`), or `null` when the producer errored or timed out. The plan said "from the registry (2.1)"; 2.1's registry did not hold it, so 2.3 added `noteStepContext`/`lastStepContext` (decision 1 below). |
| 6 | Dispatch with `modelRef(action.model, action.variant)`, `agent`, and `sessionID` only when `action.resume === true`; log `action.resumeBasis` | The plan carries `{providerID, modelID, variant}` and the v2 client formats `provider/model#variant` (same string as `modelRef`); `agent` from `action.agent`; `resumeSessionID` only when `resume` and no override. `resumeBasis` is logged on every retry/escalate (`logger.warn` line with reason, tokens, budget, threshold) and is in the decision row's `reason`. |
| 7 | Record a variant's `candidates[].costRatio` (F5) and **charge `action.costRatio ?? tier.costRatio`** (A17, QA-1.5-2, mandatory) | `rungCost = action.costRatio`; charged on the next `recordAttempt`; test "the cost ceiling counts resumed attempts at the rung's own ratio": candidates 1/5/8, 6× ceiling → exactly 3 attempts, `cost=14`, scorecard `final_tier=fast#high`. |
| 8 | **Charge `startCostRatio(policy, state) ?? tier.costRatio` for the first attempt** (QA-1.5-20, mandatory) | `let rungCost = startCostRatio(policy, state)` before the loop. |
| 9 | A15: take `variantSteps` from `resolveVariantSteps(cfg, host)` | `const variantMode = resolveVariantSteps(activeCfg, host)`; the catalog is not fetched and the policy gets no session input unless it is `auto`. Tests: no routing block, and `variantSteps: none` with a routing block (identical dispatch sequence, disposal order and registry emptiness). |
| 10 | Pass `warn` in `LadderSessionPolicyInput` (QA-1.5-15) | `warn: (message) => logger.warn(message)`. |
| 11 | Honour `action.carryVariant` and `action.rung` (A17a) | The plan dispatches `action.variant` (the carried rung); `advance` seeds `currentVariant`/`triedByModel` as before, the runner keeps no bookkeeping. Test "A17a: an escalation into a tier whose base the child already covered resumes it at the first rung above, with the new agent": `fast#low` → `fast#medium` → `medium` agent on `sonnet#high`, same child. |
| 12 | Take the policy's `variants` presence as the switch for the reserve (A17a, QA-1.5-21); `state.nextModelContext` is telemetry only (QA-1.5-14) | `sessionAware = policy.variants != null` is the only switch (also for the disposal deferral and the registration); `nextModelContext` is never read by the runner. |
| 13 | Verify R1 (bare-model resume) in `routing-ladder-resume.test.ts`; "if the old variant persists, the runner starts fresh for that case" (1.5 R1) | The host behaviour cannot be observed without a real host (no real host in this phase; 3.2 owns the smoke). The runner therefore takes the safe branch: **a bare model sent to a child whose stored variant was set by an earlier step starts fresh** (`bare-model-after-variant`). Tests: unit (`escalate-resume.test.ts`: fresh after a variant, resume when the previous attempt was `default`) and integration (default → `high` → `xhigh` → plain retry → bare `opus` escalation is a fresh `child-2`; the old child is disposed first). **The empirical check stays open for 3.2** (open item). |
| 14 | Verify, on a resumed child, what happens to agent-level effort options when an escalation switches agent/model; the target tier's effort exactly once, not the previous tier's (QA-1.5-22) | Same: not observable here. Conservative rule: **an escalation (agent switch) whose source or target tier is effort-configured starts fresh** (`effort-path`); a same-agent retry on an effort-configured tier resumes with its effort override re-set for the attempt (overrides are keyed by session, set in `registerProducer`, cleared at the end of every attempt) and a replaced, not stacked, effort. Unit tests pin both. **Open for 3.2.** |
| 15 | "Per-attempt discard skipped when the next action resumes; catalog variant validation before the call (ToolFailure otherwise → fall back to fresh session + `effortOverrides`, logged)" (plan 2.3.1) | Discard: see behaviour 4. Validation: `planNextAttempt` checks `action.variant` against the catalog's `variants[]` and the model's presence **before** the call; invalid → fresh child, logged (`runner: invalid-variant`), and, **since an effort override needs `tier.effort` and no `variant` (`effortCeilingFor`)**, the fallback dispatches the **bare** model and sets the override on a synthetic tier (`{...tier, variant: undefined, effort}`) when the variant names an effort level; otherwise the tier's own model and variant with no effort. Integration test mutates the catalog entry mid-delegation and observes `options.effort === "medium"` on the fresh bare child through `chat.params`. |
| 16 | `ingest.onVerdict`/`onFalseRefusal`/`onExecutionEnded`/`onSessionGone` for producer sessions from the runner; the plugin's own ingest (2.1 "To 2.3"); pass `step` and a per-attempt `attemptId` | `onVerdict` is called from the runner after each gate on the attempt's registration (the plugin's `ingest`, not a second one); `onExecutionEnded`/`onSessionGone` are already driven by the v2 event loop (`session.execution.*`, `session.deleted`) that 2.1 wired and a resumed child is re-registered per execution (QA-2.1-R2-10), which the v2 client's `onCreated(resume)` guarantees; `step` and the registry-generated unique `attemptId` are passed/used (test: three distinct attempt ids on one child). **`onFalseRefusal` is not called from the runner**: there is no zero-tool-call detection for delegate producers anywhere (the `FALSE-REFUSAL` banner site is the native `task` path, which stays as 2.1 wired it). |
| 17 | "False-refusal conversion stays as wired in 2.1" (dispatch) | Unchanged (`index.ts` ≈1412 call site untouched). |
| 18 | 2.1 deferred: verdicts of **deferred** verification (`finishDeferred`) and `router_verify` replays are not wired | **Not addressed.** A deferred delegation returns after its first attempt and runs no ladder, so it is outside this phase; recorded under "Deferred / not done" for 2.4. |
| 19 | QA-1.5-13 merge reconciliation (typed `tier.candidates`, `hasExplicitCandidates`, costs from `resolveCandidates`) | Already done in `ladder.ts` by `9338f64` ("reconcile phase 1.5 with typed tier candidates") in the base; nothing left for the runner. |
| 20 | F9: effective effort of a `default` → `high` step on the wire (1.5) | Phase 3.2's scenario 7 (plan); nothing observable here. |
| 21 | 1.4 handoffs to 2.2 and 2.4; 1.5 "To 2.4" (advisor findings) | Not 2.3's. One new input for 2.4 below (the shipped `anthropic` preset). |

### Findings recorded while implementing (not QA findings)

- **F-23-1 (important).** With the bundled presets, **variant steps do not occur**. `tiers.json` `anthropic` gives every tier both `variant` and `effort` (`fast` = `sonnet`, `variant: low`, `effort: low`, and so on; `hybrid-2` `medium` and `heavy` the same). A20 makes such a tier effort-configured: empty variant ladder, effort bump only. Measured with a throwaway probe on the real bundled config plus `routing: {}` and a live-like catalog: `fast`, `medium` and `heavy` all `effortConfigured: true`, `steps: []`. Consequences with that preset: no variant step; a plain retry on the same tier still resumes (its effort override is re-set); **an escalation across effort-configured tiers starts fresh** (QA-1.5-22 rule), so on the shipped `anthropic` preset the resume path is only the same-tier plain retry. The owner's own config per plan §1.1 lists `anthropic/claude-sonnet-5-5#low` etc. without effort; whether the owner's active config carries `effort` is for the orchestrator to check. The 2.4 advisor finding for "variant together with effort" (A20) is the place to tell the user.
- **F-23-2.** The first dispatch of the dispatch-hook path of 2.2 (`subagent`) and this runner's `native.execute` calls could both register the same child if the host runs plugin hooks for a nested direct call. The later registration wins (new attempt id) and its decision row would be the second row for that dispatch. Not observable without the host; for the orchestrator at merge (see Handoffs).
- **F-23-3.** A run of the related suite that had a failing test left 17 `omr-tmp-guard-*` directories in the real temp dir (process gone). They were this phase's own and were removed; the all-green runs leave none. Not investigated further (2.1's teardown).
- **F-23-4 (flaky under load, not 2.3).** `test/unit/v2-hooks.test.ts` "evicts the oldest verification call ID beyond the bounded limit" timed out once at 5 s (6.1 s) inside a 21 s parallel `related` run; it passes alone and in the next full `related` run.
- **F-23-5 (mine, fixed).** The first version of the resumed-child timeout test used a 60 ms real-timer ceiling that also applied to attempt 1 and made it flake under load; it now uses 1 000 ms, and `delegate-timeout.test.ts` carries the deterministic fake-timer version.

### Tests

| File | New / changed | What it pins |
|---|---|---|
| `test\integration\routing-ladder-resume.test.ts` (new, 19) | plan §3 2.3 list | variant step resumes the same `sessionID` with `model: same#next`, forcing message as the prompt, once; one child session for the whole delegation; each attempt a distinct registration with its step label; walk to the top variant, plain retry, escalation with agent switch, resume under the threshold; fresh over the threshold of the **next** model (old child discarded first); fresh on unknown context; A17a `carryVariant` escalation on a resumed child; R1 bare model → fresh; `variantSteps: none` and no routing block → today's behaviour (fresh child per attempt, tier agent/model, disposal order, no catalog call, empty registry); a routing block with an empty catalog → today's ladder; invalid variant → fresh bare child + effort override observed through `chat.params`; a refused resume → fresh child for the same attempt, refused child disposed, not counted as a failure; a timeout interrupts the resumed child through its signal and the next attempt is fresh; every producer child disposed when the ladder gives up; cost ceiling at the rung's ratio; max total bounds the ladder; engine `shadow`: decision rows (`dispatch`, `variant`, resume flags, D11 reason, `best` null, `switched` false), verdict rows with their step and decision ids, store keys `#low` fail and `#medium` pass with `variantPass`; engine static with a routing block writes nothing; v1 host with a routing block unchanged |
| `test\integration\delegate-timeout.test.ts` (appended, +1) | "timeouts and cancellation still interrupt resumed children" (fake timers) | the resumed child's signal aborts at `delegateTimeoutMs`, the attempt is a failed attempt, the next attempt is fresh with the next variant |
| `test\unit\escalate-resume.test.ts` (new, 20) | pure planning | catalog lookup; first plan; variant step resume; F5 rung ratios; the walk; over-threshold, unknown, no child; plain retry at the top variant; invalid variant (missing variant, missing model, forged non-effort variant); R1 both ways; QA-1.5-22 both ways; no session-aware policy (v1, none, no catalog) = today's plan; tier without variant info |
| `test\unit\escalate-attempt-recorder.test.ts` (new, 11) | recorder | registration + row; static registers only; unresolved model; four attempts, four attempt ids and decision ids; static ↔ live transitions release/re-acquire; failing acquire and throwing config never throw; dispose idempotent; v1; `describeAttempt`; `classifyDelegation` rules-only, never throws |
| `test\unit\v2-client.test.ts` (appended, +10) | v2 client resume | request shape; bare model; not-a-child and missing session rejected before anything is sent and without an interrupt; aborted lookup is not a rejection; foreign child id; deadline/abort/dispose interrupt the resumed child; failing `onCreated`; system prompt of a resumed grader |
| `test\integration\routing-ingest.test.ts` (appended, +7) | registry step context | token sum, every engine mode, unregistered/failed ignored, max per registration, reset on re-registration, malformed input, idle stamp |

### Verification

- `npm run typecheck`: green at `HEAD`.
- `npx vitest run test/unit/escalate-resume.test.ts test/unit/escalate-attempt-recorder.test.ts test/unit/v2-client.test.ts test/integration/routing-ingest.test.ts test/integration/routing-ladder-resume.test.ts test/integration/delegate-timeout.test.ts test/integration/ladder-wiring.test.ts test/integration/ladder-effort-wiring.test.ts test/integration/depth-guard-wiring.test.ts test/integration/session-lifecycle.test.ts test/unit/ladder.test.ts test/unit/ladder.session.test.ts test/unit/escalate-variants.test.ts` → `Test Files 13 passed (13)`, `Tests 819 passed (819)`.
- `npx vitest related src/index.ts src/router/sessions.ts src/routing/outcomes/ingest.ts src/compat/child-session.ts src/compat/v2-client.ts src/escalate/resume.ts src/escalate/attempt-recorder.ts --run` → `Test Files 61 passed | 3 skipped (64)`, `Tests 2064 passed | 55 skipped (2119)`.
- Default pool throughout (A14); no full suite.
- After the runs: `C:\Users\Marquinho\.config\opencode\opencode-model-router.overrides.jsonc` absent (`Test-Path` → `False`); `C:\Users\Marquinho\AppData\Local\Temp\opencode-model-router-trajectory`: 0 `outcomes*`, 0 `decisions*`; no `omr-tmp-guard-*` directory left in the real temp dir.
- No `as any`, `@ts-ignore` or `@ts-expect-error` in the new code or tests; the casts are `as unknown as RouterPluginInput` (the fake contexts, as in the neighbouring tests) and `EFFORT_LEVELS as readonly string[]` for a membership guard.

### `src\index.ts` hunks (every one; reproduce with `git diff -U0 a2a132d..HEAD -- src/index.ts`)

None is in `src\compat\v2-hooks.ts`, the `/router`, `/annotate-plan`, `/tiers`, `/preset` handlers, the system-prompt hook or the `tool.execute.*` hooks.

| New-file lines | Hunk |
|---|---|
| 3 | value import `ResumeRejectedError` next to `DEPTH_BANNER, TASK_VERIFICATION` |
| 18 | `resolveVariantSteps` in the `./router/config` import |
| 78 | `lastStepContext` in the `./router/sessions` import |
| 110–114 | `startCostRatio` in the ladder import; imports of `./escalate/resume` and `./escalate/attempt-recorder` |
| 389–390 | idle-sweeper entry `attemptRecorder?.sweep()` |
| 417–420 | `attemptRecorder` created next to `ingest`, v2 only |
| 601–623 | `loadRunnerCatalog` (TTL 15 s, timeout 3 s) before `return {` |
| 639 | `await attemptRecorder?.dispose()` in `dispose` |
| 723–741, 744–752 | delegate `execute`: `host`/`variantMode`/`catalog`, session-aware `buildEscalatePolicy`, `sessionAware`, `rungCost`, first `plan`, `recording`, `delegation` facts (replaces the one-line `buildEscalatePolicy(activeCfg)`) |
| 763 | removed `let effort` (the plan owns it) |
| 776–777, 782–783 | `runProducerAttempt(attemptPlan, forcingNote)` (the `tier`/`effort` parameters go); `producerFailed` in the result type |
| 790–791, 797–798, 801 | `tier`/`effort` read from the plan; `resumeTarget`; `producerSessions` de-duplicated (a resumed child is registered again) |
| 805–819 | `registerProducer`: effort override (synthetic tier for `invalid-variant`) and the registry/decision-row call |
| 847–855 | the resume-decision log line before the run |
| 872–880 | `runChild(resume)` (agent and model from the plan, `resumeSessionID` when resuming) |
| 882–895 | the `ResumeRejectedError` fresh fallback inside the timed call (replaces the single `ctx.routerChildRunner.run(...)` expression) |
| 1083–1088 | `if (!sessionAware) await disposeChildSession(producerSid)` and `producerFailed` in the return |
| 1099, 1112–1134 | loop: `runProducerAttempt(plan, forcing)`; rung cost; `recordAttempt(..., child)`; `ingest?.onVerdict`; `nextAction(..., { dispatchPromptChars })` |
| 1163–1168 | `rungCost = action.costRatio`; `planNextAttempt`; disposal of a child the next attempt does not resume (replaces `effort = action.effort`) |

### Decisions a QA reviewer should challenge

1. **Registry carries the step context (2.1 surface touched).** `noteStepContext`/`lastStepContext` live in `sessions.ts` and the ingest notes them **before the settings gate**, so resume works with `engine: static` plus a routing block; it keeps the **largest** value per registration (not the latest), which is conservative after a compaction and robust to duplicate delivery. The runner reads it right after the gate, with no wait: a late event degrades to `unknown-tokens` = fresh. Challenge: max vs latest; reading without a barrier; `session.step.failed` is ignored.
2. **Registration without the engine.** Attempts are registered (memory only) whenever the ladder is session-aware, even with `engine: static`; with no routing block nothing is registered. Challenge: registry growth is bounded by the 2.1 TTL/size limits, but a static engine now fills it.
3. **Facts of a delegation are rules-only** (`classifyDelegation`, no backend, D3), from `task` + the acceptance text; most delegations will classify low-confidence or `other`, in which case the ingest records no outcomes (the decision rows are still written). The orchestrator's `tier` argument is not a class.
4. **A separate recorder with its own refcounted outcomes bundle** instead of a method on `Ingest`, to avoid editing `ingest.ts` beyond five lines while 2.2 runs in parallel; 2.2 will need decision-row writing too and may duplicate it. Also: the first attempt is written as `step: "dispatch"` although the 1.3 handoff lists only variant/retry/escalate; `costs: {}`, `unit: "ratio"` and `confidence` = the class confidence (not a 1.4 `Decision.confidence`) for ladder rows.
5. **Disposal moved from the attempt to the loop** under a session-aware policy; a throw between the end of an attempt and the loop's disposal leaves the child to the `finally`. Challenge the orphan window and the double-dispose on terminal paths (fail-soft).
6. **Ownership pre-check by `ctx.session.get`**; any lookup error counts as a rejected resume (→ fresh). A host rejection *after* the pre-check (permission re-check after an agent switch, A11) is a failed attempt, not a fresh retry.
7. **R1 and QA-1.5-22 resolved conservatively, not verified.** Both start fresh instead of testing the host. Effect: with presets whose tiers have no variants, the escalation after a variant step is always fresh; with effort-configured tiers every escalation is fresh (F-23-1: this is the shipped `anthropic` preset). Challenge whether that makes resume too rare to matter, and whether 3.2 can flip them.
8. **The invalid-variant fallback is a reinterpretation of "fresh + effortOverrides"**: an effort override requires `effort` and **no** `variant` on the tier (`effortCeilingFor`), so the fallback goes bare and builds a synthetic tier; the store can still refuse it (ceiling `high` for OpenAI models), in which case the child runs bare without effort and a warning. The integration test triggers it by mutating the catalog mid-delegation; in production the policy and the plan read the same snapshot, so it is a defensive path.
9. **Every resume decision is logged with `logger.warn`** (the plugin logger has only `warn`); one line per retry/escalate, plus overrides. Challenge noise and level.
10. **Catalog source and cache**: `ctx.routerCatalog` (the 2.1 pricing list, now typed with `variants` and `limit`), `providerID/id` keys, 15 s cache per plugin instance, 3 s timeout; the model id in a tier is matched against the catalog `id`, not `modelID` (aliases).
11. **`delegateTimeoutMs` bounds the whole attempt including the fresh fallback after a refused resume** (one `withTimeout` around both calls).
12. **`effortOverrides` for a resumed same-agent retry** are re-set for the attempt and cleared at its end, on the assumption that the host re-applies agent options per request; unverified (3.2).
13. **Not done**: verdicts of deferred verification, false-refusal detection for delegate producers, native-agent chains in `delegate`, the 2.4 advisor findings.

## Findings

QA of this phase is the orchestrator's `[tier:heavy]` dispatch after this report; no QA finding exists yet. Implementation findings F-23-1 … F-23-5 are above (F-23-1 is a behavioural consequence for the shipped presets, not a defect of this phase).

## Deferred by plan

- **Phase 3.2**: R1 (does the host keep the old variant on a bare-model resume), QA-1.5-22 (agent options of a resumed child after an agent switch), F9 (effective effort of `default` → `high`), A7 (effort on the wire): all need the real host; the runner starts fresh in the first two until proven.
- **Phase 2.4**: advisor findings from 1.5 (A20 variant + effort, F5 ladder length vs `maxTotalAttempts`), 1.1 QA-1.1-9, 1.4 natives without a preset rung; `/router stats`.
- **Phase 2.2**: the `subagent` dispatch registration and decision rows (see F-23-2).
- **Phase 3.1**: document `variantSteps`/`sessionReuse` effects on the runner (fresh fallbacks and their reasons, F-23-1).

## Handoffs

- **To the orchestrator (merge with 2.2).** `src\index.ts` hunks above do not overlap the v2-hooks execute.before/context-hook sections; the one shared surface is the dispatch registry (`rememberDispatch` per child): if 2.2 registers the `subagent` call's child and the host also runs hooks for the runner's nested `native.execute`, there will be two registrations for one child (the later wins) and two decision rows; reconcile by letting one of them skip, or by giving the decision rows of 2.2 and of `attempt-recorder.ts` one writer. `ingest.ts` changed by one block (5 lines at the top of `onStepEnded`) and `sessions.ts` by two functions plus a slot field.
- **To the orchestrator (config).** F-23-1: check the owner's active preset for `effort` next to `variant`; with it, variant steps and cross-tier resume are off by design.
- **To 2.4.** Advisor: tiers with `variant` and `effort` (A20) and the consequence above; a tier whose variant ladder is as long as `maxTotalAttempts − 1` (F5, now observable: three variant steps on the owner's `fast` consume the default budget); rejected candidates (1.5). `/router stats` and `routing:stats` rows now include ladder rows with `step` ≠ `dispatch` and `resume` true/false, which the stats' resume-vs-fresh table (`ResumeFreshRow`, `types.ts`) is shaped to count.
- **To 3.1.** `docs\ROUTING_ENGINE.md`: the fresh-fallback reasons (`unknown-tokens`, `invalid-variant`, `bare-model-after-variant`, `effort-path`, a refused resume), that resume needs a routing block (A15) and a catalog, and the log lines.
- **To 3.2.** Scenarios for R1, QA-1.5-22 and F9; assert a single child session and `tokens` growth across a variant step (the integration test here asserts the single child and the request shape, not the host's token counts).

## Verdict

Implementation complete and green; **open findings: 0** pending the heavy QA review, which has not run. Branch `car/p23` pushed.
