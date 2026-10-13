# Phase 5.1 — Assembly and registration

Worktree `D:\git\omr-cpx-p51`, branch `cpx/p51`, base `d2b4d55` (tag `cpx/p51-base`, `cpx/main` after origin/master
sync 1). Design memo: architect `ses_ecb1dd57cffe3S1VyNQlse8f3R` (2026-10-13), option 2 revision included.

## Pre-flight

- `cpx/main` synced with v2.8.0 first (owner decision; `sync-1.md`); p51 recreated on the synced base.
- The plan's 5.1 line anchors in `src\index.ts` are stale. Current: `isV2Host` `:605`, plugin dispose `:1769-1793`,
  tool map `:1794`, `router_verify` `:2414`, commands `:3272-3283`, help `:306-312`.
- `src\v2.ts:14-62` builds the plugin, then `registerV2Hooks`. The executor seam already exists in
  `src\compat\v2-hooks.ts`: options `executor`, `leaseRegistry`, `slotVerifier` (`:1184-1191`), `V2ExecutorHost`
  (`:1108-1134`, `routes: null`, `activity` stub "unknown"), factory call `:3886-3960`, adapter dispose disposes runtime
  then launcher (`:2624-2641`), adapter calls `runtime.start()` (`:4006`). No production caller: `v2.ts` passes none of
  them, `index.ts` imports nothing from `./executor`.
- `RuntimeDeps` (`src\executor\runtime.ts:384-425`): every field required (`recovery` nullable). `realCollaborators`
  `:444`. Assembly template: `test\fixtures\cpx\recovery\restart-child.ts:257-473`.
- No golden snapshots the v1 tool or command map: 5.1.2 adds one, captured before the change.
- Existing tests: v2 `test\unit\v2-hooks.test.ts`, `v2-setup-input.test.ts`, `v2-client.test.ts`,
  `v2-executor-host.test.ts`, `test\smoke\v2-registration.smoke.test.ts`; role agents
  `test\unit\role-agents-work-roots.test.ts`, `plugin-agents-v2.test.ts`; executor surface `executor-tool`,
  `executor-command`, `executor-instructions`, `config-executor`.
- Handoffs read: `phase-2.4.md:608-613`, `phase-4.1.md:69-75`, `phase-4.2.md` `## Handoffs`; EXECUTOR.md 4.2 text in
  `%LOCALAPPDATA%\omr-cpx\executor-4.2-sections.md`.

## Design

### Decisions

| # | Decision |
|---|---|
| D1 | `v2.ts` creates a late-binding `ExecutorAccess` (`create.ts`: `createExecutorAccess`, `lateRuntime`) before plugin init and passes it as `routerExecutor`; `index.ts` builds `router_plan`/`/plan` over `lateRuntime(access)`; the factory fills it, dispose clears it; unset → `E_PLAN_STATE` "the plan executor is not available: <reason>". `index.ts` also hands over the plan-task verifier (`routerOnSlotVerifier`) and the annotate port (`routerOnPlanAnnotate`); `v2.ts` passes `slotVerifier` to `registerV2Hooks`. |
| D2 | One executor per process (A-3.1-1 across plugin instances): module-level claim in `create.ts`, released at dispose. `prepareExecutor(dir)` (async, never rejects: hardened `rev-parse --show-toplevel` 5 s + `realpathSync.native`, then `resolveExecutorHome`) runs in `v2.ts` alongside plugin init, because the factory is synchronous. One `prepared.toplevel` feeds `RuntimeDeps.toplevel`, `RecoveryDeps.toplevel`, the lease port, the pools and `slotsDirOf` (QA-4.2-36). |
| D3 | Per-plan slot pools behind `PlanSlotPools` (`of(planId)` lazy + memoized `open()`, closed stub after gc; facade `gc`; `markerOf(slotName)` for recovery, null unless exactly one active plan owns it); runtime reaches them through optional `RuntimeDeps.slotsFor(planId)` (A-5.1-1). |
| D4 | The adapter keeps calling `runtime.start()`; `create.ts` never does. Recovery once: process claim + service flag. Dispose: clear access → inner `runtime.dispose()` → `pools.closeAll()` → clear settle timers → release claim; launcher dispose idempotent. Slot gc via `collectFinished` (A-5.1-5). |
| D5 | v1: nothing registered, maps byte-identical (golden), existing once-per-process notice for executor keys; guarded `/plan` branch shares it (A-5.1-3). |
| D6 | Role agents: `external_directory` allow `<canonical slots root>\*` (local-action roles only), then deny `<canonical executor home>\*`, computed in `role-agents.ts` from the merged config (project-layer `slotsDir` is stripped earlier). Home unresolved → no allow, one warning. |
| D7 | Executor built only on v2, in a git repository, with `routing.delegation: roles` at start, `routing.leases.mode: enforce`, a plan-task verifier present, and `enforcement.verify.require` not `never`. Otherwise absent with that reason, which `/plan` and `router_plan` show. |
| D8 | Plan-task verification (option 2, owner decision): `createPlanTaskVerifier` in new `src\verify\plan-task.ts`, built in `index.ts` over that instance's dispatch verification engine, runs `finishDispatch`'s required-gate path (DoD, scope, placements, change observation, `buildGateDeps`, `accept`, independent grader, timeouts, caveats) on base = slot reset commit, candidate = slot HEAD after the router's commit; never deferred, no handle, no footer. Runtime hooks `begin` (after reset, before launch), `observe` (before `commitTaskInSlot`, again in `verifyAttempt`, idempotent), `forget` (A-5.1-7). `changedFiles` = union of observed files and `git diff --name-status -z -M <base> <candidate>`. Pre-checks: HEAD on the task branch, base is an ancestor, fresh snapshot after `cleanForChecks`. Restart fallbacks fail closed (child commits or a planned perimeter → unverifiable). |
| D9 | Mixed blocks (owner decision, A-5.1-8): checks first; on pass, the grader on the criteria; PASS only if both pass; a check fail dispatches no grader. |
| D10 | R11 lineage skipped for plan tasks (owner decision): every attempt starts from a fresh reset at base; lineage only lowers a pass. |
| D11 | Lease self-exemption: during a plan-task gate, the task's own holders (child, `plan:<plan>:<task>`) are excluded from the `testsPass` lease wait for that slot only (`index.ts` `leaseGate` wrapper). |

### Assembly (`createExecutor`, synchronous, factory path)

`store` `createLedgerStore({home})`; `compiler` adapter over `createPlanCompiler` (fs, hardened RepoGit, `durations`
from the host or a static per-tier model, `annotate` port or rules-only, `roleOf`, `integrationWorktree` =
`join(slotsDirOf(id, toplevel), "integration")`; sets `draft.config.slotsDir`, asserts the integration worktree, runs
`validateSlotsDir`, refuses with `E_INVALID_INPUT`); `slots`/`slotsFor` `PlanSlotPools`; `scheduler`
`createScheduler()`; `launcher` `createTaskLauncher({runner, hosts, bindings, bookkeeping, clock, lifetime, knownAgent,
onMetric})` with idempotent dispose; `routes` synchronous resolver (role spec from `resolveRoles(loadConfig(dir),"v2")`,
tier clamped into the role's range with pins, model from `resolveActiveTiers`; unknown role throws → unroutable);
`verifier` `host.verifier`; `git` hardened runner; `hosts`, `bindings`, `pinOrchestrator` from the host; `clock` node
clock; `leaseRegistry` port over `host.leases` (`holderOf` → `planHolderOf(toplevel, path)`, release then
`notifyReleased`); `recovery` `createRecoveryService({store, host, toplevel, holder, slotMarker: pools.markerOf, clock,
log})`; `holder`; `capacity`; `collaborators` `realCollaborators({queue: buildQueue, clock, log})`; `config` reads
`loadConfig(dir)` each time (`slotsDir: null`); `toplevel`; `checkSlotsDir` `validateSlotsDir`.

`buildQueue` per plan (template `restart-child.ts:339-380`): write guard, integrate git, integration checks with a
`RunResolver` over `planRun`, phase-suite runner, lander over a hardened runner, history from `exportPlan`
`integration-step` events, repo locks under `<home>\locks`, `settle` polling `launcher.inFlight()` with tracked timers.
`resume()` wrapped by `ensureIntegration`: create `refs/heads/omr/<plan>/integration` at `baseCommit` if missing (never
forced or moved), then `acquireSpecial(planId, "integration")`; failure throws → runtime pauses with one critical item.

### Handoff triage

| Handoff | Decision | Task | DF-2 |
|---|---|---|---|
| `router_plan` with the approve getter, `/plan`, help `plan:true` | IN | 5.1.2 | B |
| Instructions provider, order 61 | IN (`v2-hooks.ts`, local turn-state registry) | 5.1.2 | B |
| `validateSlotsDir` at compile and approve | IN | 5.1.1 | B |
| Integration branch and slot before `resume()` | IN (`ensureIntegration`) | 5.1.1 | B |
| `holderOf` → `planHolderOf` | IN | 5.1.1 | B |
| Real v2 `activity`; adopt refuses a live bound session | DEFERRED (needs an ADR check of the host status API; "unknown" → probation) | follow-up | – |
| Adopt/approve root-only; `router_plan` for orchestrator sessions only | IN (no parent, or a plan child; fail closed) | 5.1.2 | – |
| Rebuild from the ledger at start | DONE 4.2.5; pinned by A2 | 5.1.5 | B |
| Queue kick on pause/unpause | plan resume done; breaker unpause tested (A12), fixed in `runtime.ts` only if it fails | 5.1.1/5.1.5 | R |
| Reverted culprit retries on its old branch (QA-3.2-10) | DEFERRED; a DF-2 fault if it occurs | post-DF-2 | R |
| Role children's own slot; executor home denied; D18 slotsDir | IN | 5.1.3 / 5.1.1 | B |
| One toplevel source (QA-4.2-36) | IN | 5.1.1 | B |
| Ownership before side effects (QA-4.1-13) | IN (`mine()` reads the ledger before `planFor`) | 5.1.1 | – |
| Route resolver, run resolver, history, hardened lander, compiler ports | IN | 5.1.1 | B |
| Slot verifier over the dispatch engine (`phase-3.1.md:501`) | IN, option 2 | 5.1.1b | B |
| "No block → pass, no checks" (`phase-3.1.md:280`) | SUPERSEDED by dispatch DoD inference | 5.1.1b | B |
| EXECUTOR.md 4.2 sections | IN | 5.1.4 | – |

### Order and Writes

Order: **5.1.1 → 5.1.1b → 5.1.2 → (5.1.3 ∥ 5.1.4) → 5.1.5 → QA**.

| Task | Writes |
|---|---|
| 5.1.1 | `src\executor\create.ts` (new); `src\executor\runtime.ts` (A-5.1-1, A-5.1-7); `src\compat\v2-hooks.ts` (host fields `leases`, `durations`; `verifier: PlanTaskVerifier \| null`) |
| 5.1.1b | `src\verify\plan-task.ts` (new); `src\index.ts` (verifier construction on v2, `routerOnSlotVerifier`, lease self-exemption); `src\v2.ts`; `src\verify\perimeter.ts` (A-5.1-12, additive) |
| 5.1.2 | `test\golden\v1-plugin-maps.golden.test.ts` + snapshots (first commit); `src\index.ts`; `src\v2.ts`; `src\compat\v2-hooks.ts` (instructions provider) |
| 5.1.3 | `src\router\role-agents.ts` |
| 5.1.4 | `docs\EXECUTOR.md` (4.2 sections, "Assembly and lifecycle", "Verification of plan tasks"); `docs\ROLES.md`; `test\unit\docs-drift.test.ts` |
| 5.1.5 | `test\integration\v2-executor-assembly.test.ts`, `test\unit\verify-plan-task.test.ts`, `test\unit\executor-runtime-slots.test.ts` (new); `test\unit\role-agents-work-roots.test.ts`; `test\unit\v2-setup-input.test.ts`; `test\unit\v2-hooks.test.ts` (only if needed) |

`src\index.ts` and `src\verify\perimeter.ts` carry fresh sync-1 QA; their edits are additive and v2-only.

### 5.1.5 tests

- Assembly A1–A12: v2 surface and provider order; recovery once and second instance absent, foreign ledger passive;
  not a git repo; tiers mode or leases off; dispose leaves no timers, locks, children, check processes, claim released;
  gc once after quiescence on `completed` and `aborted`, paused plan's slots kept; per-plan slot dirs and passive abort
  releasing its own slot; integration branch and slot before the first dequeue; approve with an invalid slotsDir
  refused; child session refused; `planHolderOf` sees slot leases; breaker unpause integrates a queued task.
- v1 G1–G3: golden maps; one notice; `createExecutor` on v1 returns `undefined` with no fs or git.
- Runtime U1: `slotsFor` routing, gc predicate, approve-time check, ownership before attach.
- Role agents R1–R6: allow then deny order; sibling `<root>-evil` refused; project-local slotsDir ignored; unresolved
  home → no allow; root inside or above a worktree → no allow; existing tests unchanged.
- Verification V1–V16: checks in the slot; grader parent, cwd, tier, independence; grader timeout → two internal
  retries → unverifiable → retry/park, one breaker sample; deadline cut aborts graders; mixed blocks (D9); union
  `changedFiles`; router's own switch is not a switch, a child branch switch is; restart fallbacks; perimeter I4; `cwd`
  outside the slot refused; inferred DoD; `VERIFY:deferred` verified synchronously; lease self-exemption; non-strict
  unverifiable stays unverifiable; absent reasons; existing verify/dispatch/perimeter suites unchanged.

## Plan amendments

- **A-5.1-1** `src\executor\runtime.ts` joins 5.1.1's Writes (optional `slotsFor`, `collectFinished` gc, optional
  `checkSlotsDir` at approve, ownership before `planFor`, breaker-unpause kick only if A12 fails);
  `test\unit\executor-runtime-slots.test.ts` joins 5.1.5.
- **A-5.1-2** `src\compat\v2-hooks.ts`, executor seam only: (a) 5.1.1 host fields; (b) 5.1.2 instructions provider.
- **A-5.1-3** On v1 the observable guarantee is the existing notice for configured executor keys; the `/plan` branch is
  best-effort (an unregistered v1 command may never reach a hook).
- **A-5.1-4** (owner decision, option 2) The `SlotVerifier` is `createPlanTaskVerifier` over the dispatch verification
  engine (D8). `phase-3.1.md:280` is superseded by the dispatch DoD inference.
- **A-5.1-5** Slot gc runs once a finished plan is quiescent (no live child, no open integration entry, passed phases
  tagged), not at the status change.
- **A-5.1-6** A configured `routing.executor.slotsDir` is a root; each plan's slots are `<root>\<planId>`, fixed in the
  draft at compile. DF-2's slots: `D:\git\.omr-cpx-slots\<planId>`.
- **A-5.1-7** `PlanTaskVerifier extends SlotVerifier` with optional `begin`/`observe`/`forget`, defined in
  `runtime.ts`; `V2ExecutorHost.verifier` retyped.
- **A-5.1-8** (owner decision) Plan tasks grade mixed blocks in two passes (D9).
- **A-5.1-9** Plan-task gate deadlines: checks `max(gateBudgetMs, 600000)`; grader pass
  `max(gateBudgetMs, graderTimeoutMs(tier, override) + 60000)`; at most two internal re-runs of a transient
  unverifiable (`isRetryableVerdict` or "grader dispatch failed:"), 30 s then 60 s backoff. Code constants, pinned by
  docs-drift.
- **A-5.1-10** D7 absence reasons include "no plan-task verifier" and `enforcement.verify.require: never`.
- **A-5.1-11** New task 5.1.1b "Slot verifier over the dispatch verification engine", route
  `[route class=implement risk=high scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p51 tier=heavy pin]`.
- **A-5.1-12** `src\verify\perimeter.ts` `planPerimeter` also plans `plan:<orchestrator>:<planId>/<taskId>#<n>` ids
  (W = slot, orchestrator working set, link targets); additive.
- **A-5.1-13** (owner decision) R11 lineage is skipped for plan tasks (D10).

## Risks before DF-2

1. Grader timeouts become attempts and breaker samples → A-5.1-9, DF-2 pre-flight: `enforcement.verify.graderTimeoutMs`
   unset or ≥ 300000, grader capacity under §0.6-11, orchestrator pinned; V3/V4.
2. Regressions in fresh-QA code (`index.ts`, `perimeter.ts`) → additive v2-only edits, unchanged suites green, QA
   focus on dispatch parity.
3. Router's own `switch -C` read as a switch → `observe` before the commit; V7.
4. Verification slot contention → transient re-runs, DF-2 `maxParallel`, lease self-exemption.
5. Inferred DoDs for 6.1 tasks without a block → DF-2 pre-flight lists them; add blocks before approve.
6. Restart fallbacks fail closed and cost an attempt → no planned restart during the 6.1 run.
7. Long verifications (≈11 min per pass) slow integration → recorded as a DF-2 metric caveat.

## Tasks

- 5.1.1 `8a4fb46`: `src\executor\create.ts` (access, late runtime, `prepareExecutor`, assembly, process claim, per-plan
  pools, `buildQueue` with `ensureIntegration`, route resolver, lease port, recovery over one toplevel); runtime
  `slotsFor`, quiescent slot gc, approve-time `checkSlotsDir`, ownership before attach, verifier hooks.
- 5.1.1b `2270ebc`: `src\verify\plan-task.ts` over the dispatch engine (D8–D11); `perimeter.ts` plans `plan:` ids;
  the runtime passes the child's final text to `observe`.
- 5.1.2 `a513976` (v1 golden, committed alone before registration) and `7ed1f2b` (v2-only registration, root-only
  actions, provider order 61).
- 5.1.3 `f91e4f7`: role-agent slots-root allow and executor-home deny.
- 5.1.4 `443f308`: EXECUTOR.md (4.2 sections written from the code, Assembly and lifecycle, Verification of plan
  tasks), ROLES.md work roots, OPENCODE_V2.md, docs-drift pins.
- 5.1.5 `16614a9`: `v2-executor-assembly` A1–A12, `executor-runtime-slots` U1, `executor-create` coverage. Product
  fixes the tests found: foreign ledgers opened with a writer at start (A2) and queued verified work not restarted after
  a breaker or QA-cap answer (A12).

## Findings

| Round | Reviewer | Commit | Findings | Status |
|---|---|---|---|---|
| 1 | `ses_ec9ebbc96ffeUM4fvmerxD5oon` | `16614a9` | 1 critical (QA-5.1-1 per-module claim: one executor per module copy), 6 major (-2 bound plan child could approve/adopt; -3 plan tasks skipped the return contract; -4 dispose waited on uncancellable gates; -5 start-up git outside workRoots, regression of QA-DF1-19; -6 a failed orchestrator lookup cached for life; -7 automatic gc could wait forever at 100 ms), 7 minor (-8..-14), 2 nits (-15, -16) | fixed in `31a5867` |
| 2 | same | `31a5867` | -7, -11, -13 partial; 1 major (-17 existing slot worktrees refused the slots-root allow after a restart), 6 minor (-18..-23), 2 nits (-24, -25) | fixed in `93765cb3` |
| 3 (bounded, §0.7) | same | `93765cb3` | -17, -20, -24 partial; 2 major (-26 a handed-over executor was not wired into the v2 adapter; -27 a missing registered worktree refused the slots-root allow); minors -28..-31 | fixed in `ed39fbb` |
| 3 re-check | same | `ed39fbb` | -26, -27 fixed; no new blocking/critical/major; minors -32..-34 | closed; ready for DF-2 |

## Fixes

- Round 1 `31a5867`: process-wide claim on `globalThis` with token release (-1); mutating plan actions root-only, bound
  children read only their own plan (-2); `returnContract` for the child's text (-3); verifier `dispose()` first, a cut
  verify leaves the task `verifying` (-4); discovery and the slots grant only under D7 inside workRoots (-5, -8); the
  orchestrator passed per call (-6, -14); `planTagsSettled`, capped backoff, manual gc without tag waits (-7);
  enqueue failure after an answer still schedules (-9); terminal-only pool gc (-10); purge through a gc-only handle
  (-11); the child-runner reason (-12); user `/plan` preserved (-13); golden disposal (-15); CHANGELOG (-16); the node
  `rm` adapter removes an empty directory non-recursively (marker dirs were left behind).
- Round 2 `93765cb3`: slot worktrees inside the slots root skipped in the overlap check (-17); the adapter keeps a
  host-defined `/plan` (-18); manual gc waits for pending tags (-19); claim handover to a waiting copy, recovery once
  (-20); only cut verifications discarded (-21); `open({create:false})`, empty plan dir removed, invalid slotsDir
  without markers tolerated (-22); earlier reasons kept and documented (-23); drive from the toplevel (-24); golden
  checkpoint line normalised (-25).
- Round 3 `ed39fbb`: one idempotent `adopt` path for start and handover, W7 disposal for either (-26, -31); missing
  registered worktrees skipped only on ENOENT, per-worktree drive resolution (-27).

## Coverage

Orchestrator runs on 2026-10-13 at `ed39fbb`: `tsc --noEmit` clean; 80 affected files (executor, v2, golden,
docs-drift, roles, plan-registration, verify-plan-task, verify.criteria, gate) 4346 passed / 4 skipped; real-restart
integration 4/4. Branches: `create.ts` 95.1, `runtime.ts` 92.6, `slots\pool.ts` 94.8, `plan-task.ts` 96.3 (gate 90).

- Deviations:
  - The orchestrator ran the full suite once by mistake (`vitest run -u <file>` parsed the path as the `-u` value;
    19370 tests, 31 load timeouts, no snapshot changed).
  - Hand-applied by the orchestrator when delegates had exhausted their budgets or write scopes: the `queuedAnswerRig`
    fixture edits, the `ledger.ts` `rm` fallback, two dead `index.ts` lines, the docs-drift re-anchors, the
    OPENCODE_V2.md sentence, the golden snapshot EOF, the recovery test rewrite for read-only foreign plans, the
    EXECUTOR.md handover paragraph and CHANGELOG entries.
  - The EXECUTOR.md 4.2 sections were written from the code, not compared with the architect's draft (the draft file is
    outside the repository).
  - Provider outages during the phase (Anthropic OAuth revoked twice, an invalid OpenAI key once) were resumed in the
    same sessions after the owner fixed them.

## Deferred findings

- QA-5.1-28: `purge` ignores `reported` slots (EBUSY, lock mismatch) and still removes refs and the ledger.
- QA-5.1-29: a hot-reload copy that starts while the old copy still has `/plan` registered reads it as a user command.
- QA-5.1-30: a verdict in the dispose micro-window, or a check failure recorded before a cut, is re-verified, not
  journaled.
- QA-5.1-32: an `adopt` that throws partway leaves the executor adopted but not started.
- QA-5.1-33: start begins before the retry hook is awaited; `runtime.start()` does not check `disposed` (pre-existing).
- QA-5.1-34: a narrow window where one early host retry of a plan child is not stopped.
- Shared with dispatches, not a plan-task gap: "Now I'll run the tests" is not a progress note (`checker.ts:85`).

## Handoffs

- 6.1 README tool-list entries (5.1.4.c):
  - `| router_plan | OpenCode v2 only: compile, approve, inspect and control written plans executed in isolated worktree slots, with verification before serial integration. See [Plan executor](docs/EXECUTOR.md). |`
  - `| /plan <run|approve|status|inbox|answer|pause|resume|abort|land|adopt> … | OpenCode v2 only: control the plan executor; run compiles the plan and, by default, approve starts it. See [Plan executor](docs/EXECUTOR.md#plan-command). |`
- Follow-up (not DF-2 blockers): real v2 `activity` and refusing adopt of a live bound session; a reverted culprit
  retrying on its old branch (QA-3.2-10); the deferred minors above.
- DF-2 pre-flight: `enforcement.verify.graderTimeoutMs` unset or ≥ 300000; list the 6.1 tasks without an
  `[acceptance]` block; `routing.delegation: roles` and `routing.leases.mode: enforce` in the dogfood config; slots
  under `D:\git\.omr-cpx-slots\<planId>`.

## Amendments (added during the phase)

- **A-5.1-14** (5.1.5 A2): a plan of another repository is never opened with a writer. Start, `planFor`, the failed-adopt
  re-attach and compile decide foreignness from a read-only snapshot; foreign status stays available and every
  mutation is refused (stricter than the 4.2 passive attach, which accepted a pause).
- **A-5.1-15** (QA-5.1-2): plan authority is root-only for every state-changing action; a bound plan child reads only its
  own plan. Supersedes the 5.1.2 bound-child exception.
- **A-5.1-16** (QA-5.1-20, -26): one executor per process with a claim handover to a waiting copy, wired through the
  same adapter path as at start.

## Verdict

Done at `ed39fbb`: three heavy QA rounds plus a bounded round-3 re-check; every blocking, critical and major finding
fixed, minors deferred. Merged into `cpx/main`.
