# Phase 6.2 — Global senior QA, fixes and delivery

## Pre-flight

Orchestrator-shell evidence, **2026-10-16**, at **`cpx/main` `992816b`** (merge of `cpx/pdf2-1`),
with the clean reruns in `D:\git\omr-cpx-p62`. These are pre-flight observations, not a green global verdict.

- **`npm run typecheck`: exit 0.**
- **Full suite with coverage:** `npx vitest run --coverage --maxWorkers=8`.
  - First attempt in `D:\git\omr-cpx-main`: **8 failures**, **7 environment-caused**, involving the dogfood
    worktree's gitignored `.opencode\` project config: `config.routing` ×5, `routing-engine.protocol-line`
    ("the shipped config has no project override on this worktree"), and partly routing-advisor QA-2.4-3.
    These are not code regressions. The suite must run in a worktree **without `.opencode\` and without
    `OPENCODE_CONFIG_DIR`**.
  - Clean-worktree rerun in `D:\git\omr-cpx-p62`: **20221 passed, 2 failed, 86 skipped**.
  - Coverage rerun with `--coverage.reportOnFailure`: **20222 passed, 1 failed, 86 skipped**.
    Coverage: **statements 95.66%, branches 92.26%, functions 96.71%, lines 97.28%**. No threshold error:
    `vitest.config.ts` sets global statements/branches/functions/lines floors of **80/85/80/80** and
    per-directory **90/95** floors. Passing coverage thresholds does not make the failed suite green.

### Failed checks carried into 6.2.QA

- **P-1 — real, pre-existing since `f2182e5` / Phase 4.1.3.**
  `test/integration/routing-advisor.test.ts`, "QA-2.4-3: without a routing block a bare /router on v2 is
  byte-identical to 1fc94a3's…": v2 `/router` help now always appends the "Plan executor (`/plan`)" section.
  It also fails on `cpx/p61` `7181165`. Earlier phases ran scoped tests only, so they did not catch it.
  **6.2.QA/FIX input.** Orchestrator recommendation: show the `/plan` help lines only when the executor is
  configured/enabled, preserving "no routing block = byte-identical". This is a recommendation, not an applied fix.
- **P-2 — flaky process-lifecycle timing tests under load.** `test/unit/exec.test.ts`:
  "a deadline after the direct child exited kills what it left running within 3 s" failed in run 1;
  "runs grandchildren of runArgv below normal priority" failed in run 2. Each passes alone; neither failed in
  the coverage rerun. Load-sensitive with 8 workers. **6.2.QA input:** harden the tests, not the code.

### Smoke gate and carried inputs

- **No smokes at pre-flight**, per **A-6.2-1**; all local smoke lanes run once at the final gate on final code,
  with CI covering the coverage gate and `smoke:keyless` as the amendment specifies. Phase 6.1's `smoke:cpx`
  and `smoke:cpx:e2e` evidence is **not carried over**: the `cpx/pdf2-1` merge changed `src/`.
- **Mandatory input:** [pdf2-1, Round 5](pdf2-1.md#round-5--focused-re-review-of-e3a844a-2026-10-16),
  **N-2** (major impact, low likelihood): a running dependent absent from `launcher.inFlight` can keep writing
  after its slot is saved/reset/released. Open **6.2.QA/6.2.FIX** input, not deferrable under **A-6.2-2**.
- **Deferral queue:** the [Phase 6.1 consolidated table](phase-6.1.md#deferred-findings) remains authoritative.
  Under **A-6.2-2**, findings deferred with a recorded reason count as closed for pre-flight; those **without a
  recorded reason** go to **6.2.QA**, which decides whether 6.2.FIX fixes them. No missing rationale is inferred.

## Findings

Severities and statuses as recorded below in this file; "not stated" where the file gives none.

| id | severity | area | status | where recorded |
|---|---|---|---|---|
| P-1 | not stated (real, pre-existing since `f2182e5`) | `/router` v2 help, routing-advisor QA-2.4-3 | fixed as G-2 | Pre-flight; Fixes, G-2 |
| P-2 | not stated (flaky under load) | `exec.test.ts` process-lifecycle timing tests | fixed as G-6 | Pre-flight; Fixes, G-6 |
| N-2 (input, pdf2-1 Round 5) | major impact, low likelihood | running dependent absent from `launcher.inFlight` vs its slot's release | fixed under G-1 (see note) | Smoke gate and carried inputs; Fixes, G-1 |
| G-1 | major | executor: adopted child stopped before its slot goes back | fixed | Fixes |
| G-2 | major, P-1 | executor help gating in `/router` | fixed | Fixes |
| G-3 | major, docs | dogfood disclosure | fixed (disclosure completed; G13 remains UNMET, owner decision pending) | Fixes |
| G-4 | minor, security | guarded check executables, full-environment replacement | fixed (`verify/wiring.ts` bare git recorded for follow-up) | Fixes |
| G-5 | minor, registration | `router_plan` / `/plan` registration | fixed (owner decision 2026-10-16, option (a)) | Fixes; Orchestrator validation of G-5 and G-9 |
| G-6 | minor, P-2 | serial process-lifecycle project | fixed | Fixes |
| G-8 | minor, docs | automatic safety pauses disclosed and pinned | fixed | Fixes |
| G-9 | minor, test | serial heartbeat isolation | fixed | Orchestrator validation of the 6.2.FIX batch |
| G-10 | minor, test | load-sensitive integration tests | deferred: load-sensitive, each passes alone and with its file | Orchestrator validation of G-5 and G-9; of N-A, N-B and N-D |
| G-11 | minor, test, pre-existing | v2-provider-e2e Windows path assertion | fixed | Fixes |
| G-12 | major, regression of `7180ac8` / QA-DF1-19 | role registration worktree listing | fixed | Fixes |
| G-13 | minor, stale smoke | role-spikes S2 and S6 background path | fixed | Fixes |
| G-14 | minor, pre-existing, host drift | role-spikes S11 | deferred: identical failure at `origin/master` `6ec3faa`, out of scope (A-6.2-2) | Fixes; Focused QA of G-11..G-14 |
| N-1 | not stated | `releaseBlockedSlot` save outside the task lock | fixed (folded into G-1) | Fixes, G-1 |
| N-5 | not stated | latency of READY dependents' saves | fixed (cleared by G-1's N-1 change) | Fixes, G-1 |
| m-A | not stated (Phase 6.1 deferred) | `refuseHeldChild` requeue/reset | fixed (folded into G-1) | Fixes, G-1 |
| m-G | docs | soak analyzer runtime | fixed | Fixes |
| R2-4 | minor, smoke oracle | checkpoint-scoped G9 attempt normalization | fixed | Fixes |
| R2-8 | nit, smoke oracle | observed G9 wake-session evidence | fixed | Fixes |
| R2-9 | docs | role-floor configuration wording | fixed | Fixes; Orchestrator validation of the 6.2.FIX batch |
| N-A | major, regression of G-4 | integration-check pytest slot virtual environment | fixed | Fixes |
| N-A-1 | major, focused QA of 306ad9e | pytest command moved to another slot | fixed | Fixes |
| minor-1 | not stated | slot interpreter rewritten between selection and spawn | fixed (with N-A-1) | Fixes, N-A-1 |
| N-B | minor, G-1 gap | abort during a blocked task's adopted-child stop | fixed | Fixes |
| N-D | minor | late blocked-slot release vs relaunch | fixed (`cancelled` extension accepted by the orchestrator) | Fixes; Orchestrator validation of N-A, N-B and N-D |
| minor-2/3 | docs | N-A wording | fixed | Fixes |
| minor-4 | not stated | `releaseBlockedSlot` for a task ready again | fixed | Fixes |
| minor-5 | not stated (QA: low-confidence edge) | N-B residual window | deferred: no reproduction, a fix would be speculative | Fixes |
| minor-6 | not stated | pytest `ComSpec` on win32 | fixed | Fixes |
| QA-62F-1 | major, security | executor-home deny outside the work roots | fixed | Focused QA of G-11..G-14 |
| QA-62F-2 | minor, docs | outside-work-roots behaviour docs | fixed | Focused QA of G-11..G-14 |
| QA-62F-3 | minor, coverage | S6 `auto` run | fixed | Focused QA of G-11..G-14 |
| QA-62F-4 | nit | start-up `git worktree list` executable | fixed | Focused QA of G-11..G-14 |
| QA-62F-5 | nit | `v2-provider-e2e` system content | fixed | Focused QA of G-11..G-14 |
| QA-62F-6 | nit | G-14 root-cause wording | accepted (wording corrected) | Focused QA of G-11..G-14 |
| QA-62F-7 | nit (docs) | EXECUTOR/CHANGELOG/ROLES wording | fixed | Focused QA round 2 |
| QA-62F-8 | nit (wording) | unresolved-home warning | fixed | Focused QA round 2 |
| QA-62F-9 | nit (low confidence) | home lookup after a failed listing | fixed | Focused QA round 2 |
| PF-4 | not stated (known, pre-existing) | routing-engine smoke `5-advisor` | deferred: pre-existing, fails at `7181165` | Fixes, G-14; Final smoke gate |

Notes:
- N-2: G-1's entry names its fold-ins as N-1 and m-A, not N-2. **Orchestrator determination (2026-10-16): N-2 is
  closed by G-1.** `pdf2-1.md:122` prescribes the N-2 fix as (a) interrupt a restart-adopted child and await its end
  before the save in `releaseBlockedSlot`, and (b) re-check the task state just before the launch. G-1 does (a) with
  `sweepAdopted`/`stopAdoptedChild` (interrupt, then wait for the terminal event or idle context, then save and
  release once; a failed stop keeps the slot under `wipHold`) and `releaseBlockedSlot` keeping a held slot, and (b)
  with `launchStep`'s re-check after R4 and just before `launcher.launch`. G-3's "remaining N-2 handoff" wording
  predates G-1.
- G-7 and N-C have no record in this file; no row is invented for them.

## Fixes

- **G-1 (major): a child recovery adopted is stopped before its blocked or aborted task's slot goes back.**
  Folds in **N-1** (pdf2-1 Round 5) and **m-A** (Phase 6.1 deferred).
  - `sweepBlocked` also sweeps adopted children, which are in no `launcher.inFlight()` (`sweepAdopted`, registered in
    `blockedSweeps`). `stopAdoptedChild` marks the child `interrupting`, calls `hosts.interrupt`, evicts its binding,
    then waits for its terminal host event or an idle context. It polls every `RECOVERY_POLL_MS` for at most
    `RECOVERY_LIVENESS_MS`, the probation bounds; no new timeout. Only then is the slot saved and released, once.
  - A failed interrupt or an expired bound keeps the slot leased under `wipHold`, with one blocking item, and releases
    nothing. Until the child's terminal event or the item's answer, no collection retry saves or releases that slot,
    and no launch of the task takes it (`adoptedStopHolds`).
  - `abort` stops adopted children the same way. Their release is in `abortReleases`, so no collection removes the
    worktree while the child runs.
  - `ExecutorRuntimeHandle.childLive` reports a launch in flight, a live adopted child or a running stop. create.ts
    `settle` releases only when both it and `launcher.inFlight()` are clear. Asked for a blocked task, `childLive`
    starts the stop, so a queue that polls before `onReverted` cannot release early. `releaseBlockedSlot` does the
    same and keeps a held slot.
  - `launchStep` re-checks, after R4 and just before `launcher.launch`, that the task is still `dispatched` with
    attempt `n` open.
  - **N-1:** `releaseBlockedSlot` saves and releases under `withTask`. The queue no longer awaits a READY dependent's
    release in its serial lane, which avoids the `checkTaskPhase` deadlock and also clears N-5's latency.
  - **m-A:** `refuseHeldChild` skips its requeue and reset when a recovered end was registered while it interrupted,
    the same guard as `applyFeed` `requeue-lost`.
  - Tests:
    - `test/unit/executor-runtime-recovery.test.ts`, "G-1: a child recovery adopted is stopped before its slot goes
      back":
      - "row 34 + onReverted: the adopted child is interrupted and its binding evicted; the slot goes back once, after
        its end"
      - "an adopted child whose interrupt fails keeps its slot leased under the hold, with one blocking item; nothing
        is released"
      - "an adopted child that does not end within the bound after its interrupt keeps its slot held, as a failed
        interrupt"
      - "abort: the adopted child is interrupted and awaited; its slot is saved and released once, after its end"
      - "abort: an adopted child whose interrupt fails keeps its slot leased under the hold, with one blocking item"
      - "launchStep: an attempt that row 34 closed while R4 awaited the launcher gets no child"
      - "m-A: a finished end received while refuseHeldChild interrupts a lease-held child is processed, never
        requeued as lost"
    - `test/unit/executor-runtime-resume.test.ts`: "N-1: the queue's release of a READY dependent waits for a launch
      step of the same task: their saves never overlap".

- **G-3 (major, docs) — disclosure completed in 6.2.FIX.** `dogfood.md` now records DF-1.2/DF-1.3 and the
  under-DF-2 self-check alongside the existing attempt/fallback history; DF-2-1..7 have individual dispositions,
  including pdf2-1's merge into `cpx/main` `992816b` and its remaining N-2 handoff. Rollback paths are distinguished
  from executed rollbacks; the forced-foreground share is **not measured**, not invented. Dedicated §0.13 incidents
  disclose DF-1-1's orchestrator read and DF-1.1-3's base-build service interference. **G13 remains UNMET, owner
  decision pending**; later fixes/scripted fixtures are not a dogfood pass. The opening executor/landing claim in
  `phase-6.1.md` is marked superseded without deleting history. Sources: committed handover §7, `pdf2-1.md` and
  `phase-6.1.md`; no new measurements or check results claimed. EXECUTOR.md's measured-results section now agrees
  on all windows, DF-2-1..7 dispositions, rollback paths, fallback and the §0.13 incidents. The orchestrator runs
  docs-drift after these documentation edits; no green result is claimed here.

- **G-2 (major, P-1) — executor help gating.** `/router` now uses the executor discovery prerequisites from
  `src/v2.ts`: v2, roles delegation, enforced leases, verification not disabled, and a location inside the configured
  work roots. The QA-2.4-3 byte-identity pin and the v1 help pins are unchanged. Added positive coverage for every
  `PLAN_HELP_LINES` entry with executor-capable routing, and negative coverage for tiers, disabled leases and an
  out-of-roots location. The latter test canonicalizes its real work-root entry: Windows TEMP may use an 8.3 spelling,
  which the configuration deliberately drops. It now proves the entry survived config loading and the location is
  outside it before asserting the help gate. The production gate already matches `src/v2.ts`'s outside-work-roots
  discovery refusal; that prerequisite was not removed. Checks are for the orchestrator to run; no local green result claimed.
- **G-4 (minor, security) — fixed: guarded check executables and full-environment replacement.** Integration test searches now
  select `gitExecutable(workRootGuards(cwd))`, add `hardeningArgs()` and construct their environment from
  `gitEnvironment()` through `runEnvironment`. Pytest resolves an absolute interpreter outside guarded directories
  with `resolveCommandExecutable`, including full, scoped and rerun commands, and supplies the sanitized run
  environment. `runArgv` now accepts explicit `envMode: "replace"`; the check adapter forwards it for resolved
  environments and hardened git searches. Replacement neither merges `process.env` nor injects the automatic slot
  environment; other callers retain default merge behavior. Regression coverage includes an actual child through
  checks → create → runArgv, proving a provider credential in `process.env` is absent, plus replacement with an
  omitted/explicit environment and the unchanged default-merge assertion. The Windows marker regression models
  cwd-before-PATH at the spawn seam, with planted `git.exe`/`python.exe` names and positive controls for both old
  bare-name calls; hardened calls must be absolute and outside the slot, and leave no marker. It needs no compiler,
  PowerShell, batch files or native fixture process. Both security tests own separate temp roots, cleaned after each
  test even on failure; the pre-existing filesystem-seam test is unchanged.
  Ordinary verification's `verify/wiring.ts` test-search helper (line 1404), and its committed-diff call (line 1385),
  still use bare git through the inheriting argv seam. This is recorded for follow-up rather than included in the
  executor fix: changing that distinct verification path also requires updating its bare-argv test doubles and pins,
  not just a one-line executable substitution. Validation of this fix remains with the orchestrator.
- **G-6 (minor, P-2) — serial process-lifecycle project.** `exec.test.ts` is excluded only from the parallel project
  and included in `exec-serial`, a later sequential group with a single fork and no file parallelism. Both projects
  retain the home guard; the root global guard and all coverage thresholds remain intact. `npm test` and the default
  Vitest run still select both projects. Added a configuration regression pin. No existing assertion or timeout in
  `exec.test.ts` changed; the orchestrator must validate the full 8-worker run.
- **m-G (docs) — soak analyzer runtime.** `docs/EXECUTOR.md` now states Node >= 22.13 for `npm run soak:analyze`,
  alongside the existing offline analyzer description. The script header already documented the requirement.
- **R2-9 (docs) — role-floor configuration wording.** `CHANGELOG.md` and `docs/ROLES.md` now distinguish bundled
  `tiers.json` configuration and the global override from forbidden project overrides; `strict` is the code default.
  No configuration behavior changed and the Phase 6.1 deferred-table history was not edited by this implementer.

- **R2-4 (minor, smoke oracle) — checkpoint-scoped G9 attempt normalization.** The driver freezes the last
  observed pre-crash open-child inventory (task, attempt, nonce and child session), rather than inferring permitted
  losses from the final ledger. Uninterrupted baselines must have zero lost attempts; restart losses outside that
  inventory fail even for tasks with no commit subject. Only closed, matching checkpoint losses before an integrated
  attempt are subtracted. Other subject bytes, missing/duplicate commit counts, tree equality and normalized-ledger
  equality remain checked. Host-free `cpx-g9-oracle.test.ts` regressions cover the formerly hidden baseline loss,
  extra losses on the same/another task, identity mismatches and the retained commit-count controls. No `src` change.
- **R2-8 (nit, smoke oracle) — observed G9 wake-session evidence.** The restart assertion now reads the actual
  provider request's `x-proof-session` and requires a primary request from the bound root, instead of comparing the
  cached status-turn field populated with the expected root literal. Helper regressions reject a different actual
  session despite matching cached metadata, absent request/session evidence, and auxiliary requests. Existing
  recovery ordering, single-status-call and equivalence assertions are unchanged. Validation for both R2 fixes is
  pending the orchestrator's helper-test run with `--config vitest.smoke.config.ts` and typecheck; no smokes or local
  check runs were performed by this implementer.

- **G-8 (minor, docs) — automatic safety pauses disclosed and pinned.** EXECUTOR.md's unattended-operation and
  troubleshooting sections name `launch-lost-streak:<taskId>`, `lost-streak:<taskId>`, `integration-resume-failed`,
  `integration-bug` and `integration-infrastructure`, including inbox text/severity and owner recovery steps. They
  distinguish whole-plan stops from phase-only `revert-conflict` / `revert-insufficient` and suite resolution/attribution
  pauses. **G10 is recorded as "the circuit breaker plus these bounded safety pauses, each with one inbox item".**
  A new docs-drift pin derives reason literals from runtime/queue events and pause-helper calls; mutation self-tests
  cover every missing reason in either section and new source reasons. Existing pins are unchanged. Phase `F-`
  answers and whole-plan resume are not documented as a phase-unpause API: the code exposes no general such action.
  No checks run by this implementer; the orchestrator runs docs-drift.

- **G-5 (minor, registration) — fixed; owner decision 2026-10-16: option (a).** `router_plan` and `/plan` now use
  `rolesAtStart`, the same registration gate as `router_run`; v2 tiers sessions register neither. The `/router` help
  gate also checks start-time registration (and preserves a user-defined `/plan`), so switching tiers to roles without
  a restart cannot advertise an unregistered command. The v1 tool/command/help pins and goldens are untouched.
  Registration tests now start in roles for caller/access/conflict behavior instead of relying on the old all-v2
  premise; the unavailable-runtime case uses a missing lease prerequisite, and approval reloads retain roles mode.
  Added tiers/roles and tiers-to-roles-without-restart regressions; retained all caller, conflict and v1 assertions.
  EXECUTOR.md, README, OPENCODE_V2.md, ROLES.md and the registration sentence pins now state the roles-at-start rule.
  No checks run by this implementer; typecheck and tests remain with the orchestrator.

- **N-A (major, regression of G-4) — fixed: integration-check pytest uses the slot's virtual environment again.**
  G-4's `resolvePython` built the child environment from `runEnvironment` alone and took argv[0] from
  `resolveCommandExecutable`, which refuses anything inside the slot; with `envMode: "replace"` the slot environment
  was skipped too. Pytest therefore ran the host interpreter without the slot's `.venv`. `resolvePython`
  (`src/executor/integrate/checks.ts`) now matches router_run's `planRun`: the environment is
  `applySlotEnv(runEnvironment(...), slotEnvFor(cwd))` (VIRTUAL_ENV, `.venv\Scripts` / `.venv/bin` first on PATH,
  PYTHONPATH/PYTHONHOME unset), and argv[0] is `slotToolExecutable(...) ?? resolveCommandExecutable(...)`
  (`slotToolExecutable` is now exported from `src/router/run-tools.ts`). G-4's guarantees stay: credentials stripped,
  an absolute executable, never a bare name resolved from the cwd, `envMode: "replace"`. A file planted in the slot
  root is never selected. A `.venv` interpreter is accepted only from a registered Python-manager slot's tool
  directories and only when it matches the pool's post-provisioning snapshot (path, size and mtime), the same trust
  model as router_run; a file that no longer matches falls back to the host interpreter. As in router_run
  (`slots/env.ts` `buildSlotEnv`), a registered slot without a detected Python manager gets no virtual environment and
  unsets PYTHONPATH, PYTHONHOME and VIRTUAL_ENV; only a cwd outside every registered slot gets no slot environment, so
  the host's values pass through there (wording corrected in round 3, minor-2/3). 306ad9e's bare-name re-lookup of an
  earlier resolution's slot interpreter failed open and was replaced by N-A-1 below. Tests in
  `test/unit/executor-integrate-bisect.test.ts` (real `slotToolExecutable`, real files): the provisioned `.venv`
  interpreter with the slot environment and no credential; the absolute host
  python with the stripped environment for a slot without a provisioned interpreter and for one without a Python
  manager; a command resolved in one slot runs the other slot's interpreter; on Windows, the spawn seam with a
  registered slot still never selects the planted slot-root `python.exe`. Both G-4 tests are unchanged.
- **N-B (minor, G-1 gap) — fixed: an abort waits for a blocked task's adopted-child stop.** `abort` registers
  `abortReleases` only for dispatched/running tasks, so a blocked task whose sweep was still stopping its adopted child
  left `idle()` true and `collectFinished` could collect the slot while the child ran. `idle()` now returns false while
  a `blockedSweeps` entry of the plan stops an adopted child and has not settled; the settled sweep starts the finished
  plan's collection at once. Test: `test/unit/executor-runtime-recovery.test.ts`, "N-B: an abort during a blocked
  task's adopted-child stop collects and releases nothing until the stop settles".
- **N-D (minor) — fixed: a late blocked-slot release never frees a relaunched task's slot.** The queue's release of a
  READY dependent is fire-and-forget, so the task could be relaunched (same owner, same slot) before
  `releaseBlockedSlot` took the task's mutex. Under the mutex it now releases only while the task is still `blocked`
  (or `cancelled` by an abort, which never relaunches and releases no such slot itself), has no slot in the ledger and
  is at the attempt it was blocked in. Test: `test/unit/executor-runtime-resume.test.ts`, "N-D: a late queue release
  of a blocked dependent never frees the slot its relaunch leased again".
  No checks run by this implementer for N-A, N-B or N-D; typecheck and tests remain with the orchestrator.

- **N-A-1 (major, focused QA of 306ad9e) — fixed: a pytest command moved to another slot never runs the first slot's
  interpreter.** 306ad9e re-looked-up an earlier resolution's interpreter by its bare name only while it still matched
  its slot's snapshot; otherwise its absolute path was kept and `resolveCommandExecutable` accepted it, because
  `workRootGuards(B)` does not cover slot A (slots live in `<drive>:\.omr-slots\<plan>`). The phase suite selects in
  the integration worktree and re-resolves those commands in the `ci` slot on every run, rerun and bisect probe, so a
  re-provisioned, unregistered (broken) or rewritten slot A made B run A's interpreter (A's site-packages: the wrong
  commit tested, wrong blame or revert) or fail with "not found". Now no earlier resolution's absolute path is ever
  accepted: a full pytest command's argv[0] is derived from the configuration (`python`, "auto" meaning `python`) at
  every resolution (selection, `resolveForSlot`, each spawn) and resolved for the slot it runs in
  (`slotToolExecutable` for that slot, else the host fallback). The commands resolved from the configuration are
  tracked in a `WeakSet`; a scoped or rerun spec (a new object, planned in the same cwd) keeps its planner's argv[0]
  under the same rules. This also fixes **minor-1**: a slot's own interpreter rewritten between selection and spawn
  (check code) now falls back to the host interpreter as the selection would, instead of a `resolve` error. Tests in
  `test/unit/executor-integrate-bisect.test.ts`: "N-A-1: a command moved to another slot after its first slot's
  interpreter was rewritten runs the other slot's own", "… after its first slot was unregistered …", and "N-A-1
  (minor-1): the slot's own interpreter rewritten between selection and spawn falls back to the host python, as the
  selection would". The G-4 and earlier N-A tests are unchanged.
- **minor-2/3 (docs) — fixed:** the N-A wording in CHANGELOG.md and above no longer says a planted file "in the slot"
  is never run. A file planted in the slot root is never selected. The `.venv` interpreter is accepted only from the
  post-provisioning snapshot (path, size, mtime), the same trust model as router_run. Python variables pass through
  only outside a registered slot (a registered slot without a Python manager unsets them, `buildSlotEnv`); the QA
  note's "pass through for slots without a detected Python manager" does not match the code and is stated as coded.
- **minor-4 — fixed:** `releaseBlockedSlot` also releases a task that is `ready` again on the same attempt with a null
  ledger slot (its dependency recovered): the task's mutex orders the release before its next launch step, which then
  takes a fresh slot and restores the saved work. Tests in `test/unit/executor-runtime-resume.test.ts`: "N-D: a blocked
  dependent whose dependency recovered (ready again, same attempt) still has its slot saved and freed" and "N-D: a
  blocked dependent an abort cancelled still has its slot saved and freed by the queue's late release".
- **minor-6 — fixed:** `resolvePython` sets `ComSpec` to the validated system shell (`resolveSystemShell`, as
  `planRun`) on win32. Test: "N-A (minor-6): pytest's ComSpec is the validated system shell, never one planted in the
  slot" (win32 only).
- **minor-5 (N-B residual window) — deferred.** The QA reported a residual window in the N-B guard when the task's
  lease is missing from `slotLeases` (the sweep then knows no slot of its own). Reason for deferral: the QA rates it a
  low-confidence edge, there is no reproduction, and a fix without one would be speculative; recorded for 6.2.QA.
  No checks run by this implementer for N-A-1 or the minors; typecheck and tests remain with the orchestrator.

- **G-11 (minor, test, pre-existing): v2-provider-e2e Windows path assertion against a JSON-serialised body**
  — fixed. All four cases fail identically at `7181165` and `8c8c6e0`; this is not host drift. Supplied evidence:
  `D:\git\omr-cpx-p61\.cpx-logs\gate62-longtemp\v2-e2e.log` shows the exact working-directory expectation uses
  single Windows backslashes while the received JSON-serialised system messages escape them. The capture now
  reads system content from the already `JSON.parse`-decoded request; both working-directory assertions retain
  the same substring and exact project path. The created project directory is canonicalised with `realpath`
  so an 8.3 TEMP spelling matches the host's long-form path. The file imports no smoke helpers; inspection found
  no other Windows-path `toContain` checks against serialised bodies in this file. No new helper or unit test;
  no smokes or checks run by this implementer. Validation remains with the orchestrator.

- **G-12 (major, regression of `7180ac8` / QA-DF1-19) — fixed: role registration lists the project's worktrees
  again whatever `routing.workRoots` contains.** Final-gate evidence (`gate62\roles.log`, `8c8c6e0`): roles smoke
  I3+I4, I5+I9, ladder and "work roots and host handoffs" failed with `Permission denied: external_directory`; the
  registered rules held only the smoke's later-worktree glob `<tmp>\wt-late-*`. Isolated bisection of I3+I4 on
  2.0.26 (scratch worktree at each commit, `node_modules` junction): pass at `6ec3faa` (master), `b716ee9`,
  `226d967`, `b871c00`, `12774fc`, `51d3c51`; fail at `7180ac8`, `fa59281`, `9fa7607`, `92f09d1`, `4623f8d`,
  `b7642c7`, `83f90e7`, `992816b`. Cause: `registerRoleAgents` skipped `git worktree list` when the start directory
  lay outside every `workRoots` entry, so a glob meant for later worktrees dropped the existing ones (it also broke
  the documented `D:/git/my-repo-wt-*` example). Fix: the listing gate is `hasLocalActions` only, as on master;
  `locationOutsideWorkRoots` still gates the start-up reference GC (DF-1-1) and the executor-home lookup
  (QA-5.1-5). Accepted trade-off: a read-only `git worktree list` runs at start in every location again, as on
  master. QA-DF1-19 unit cases flipped to pin the listing; new test "G-12 a workRoots glob for later-created
  worktrees does not drop the project's existing worktrees" in `test/unit/role-agents-work-roots.test.ts`.
  `docs/ROLES.md`, `docs/CONFIG_REFERENCE.md` and `CHANGELOG.md` no longer claim the skip.
- **G-13 (minor, stale smoke) — fixed: role-spikes S2 and S6 pin the legacy background path explicitly.** They
  asserted that a model-flagged `background: true` reaches the host as `false`; Phase 2.1 honours an explicit
  `background: true` unless `routing.background.mode` is `off` (`decideBackground`, reason `explicit`). S2/S6 pass
  at `6eaf7f0` and fail from `bc0df8a` (2.1 merge) on. Their hosts now run with `routing.background.mode: "off"`;
  no assertion changed. The 2.1 path stays covered by `cpx-background`.
- **G-14 (minor, pre-existing, host drift) — deferred with reason.** role-spikes S11 "(1) default agent:
  external_directory is ASKED for the sibling worktree" receives `completed` on host 2.0.26. It fails identically at
  `origin/master` `6ec3faa` (`omr-evidence\gate62-master-roles.log`), so it is neither caused nor fixable by this
  plan's changes; it pins a host default, not router behaviour. Reason for deferral: out of the plan's scope (A-6.2-2);
  to be refreshed against the host in a separate change. The routing-engine smoke `5-advisor` failure is the known
  pre-existing PF-4 (fails at `7181165` too).

### Focused QA of G-11..G-14 (heavy, round 1, 2026-10-16) and fixes

Reviewer session `ses_ebb4fd859ffeqg4Z0Urjl0Ewwr` at `25fd915`: 1 major, 2 minor, 3 nits.
- **QA-62F-1 (major, security) — fixed.** With G-12 the worktree allows came back outside every work root, but the
  executor-home lookup (and its deny) stayed gated by `!outside`, so `<main>\*` covered `<git common dir>\omr-executor`.
  The lookup now runs when `!outside || worktrees.length > 0`; the slots-root grant alone stays inside the work roots.
  Tests in `test/unit/role-agents-work-roots.test.ts`: the outside and G-12 cases assert `externalDirectoryDenied` and
  a `deny` for `<wt>\.git\omr-executor\ledger.json`; new "QA-62F-1 …" cases for no slots root outside, no lookup
  without a listed worktree, and fail-closed on an unresolved home.
- **QA-62F-2 (minor, docs) — fixed.** `docs/ROLES.md` and `docs/CONFIG_REFERENCE.md` state the outside-work-roots
  behaviour (worktrees listed, home denied, no slots-root allowance); docs-drift pins added.
- **QA-62F-3 (minor, coverage) — fixed.** S6 has a third run (`routing.background.mode: "auto"`, verification
  enforced): the call reaches the host with `background: true`, returns in < 3 s with a `running` acknowledgement
  whose parts are the host ack, `[router] Running in the background (…). Its result is held until verification
  finishes.`, then the probe's note; one `execute.after` record; no host errors.
- **QA-62F-4 (nit) — fixed.** The start-up `git worktree list` picks its executable with `workRootGuards(directory)`,
  as the executor-home lookup does; unit test "QA-62F-4 …".
- **QA-62F-5 (nit) — fixed.** `v2-provider-e2e` flattens string or text-part system content (`contentText`).
- **QA-62F-6 (nit) — accepted:** G-14's deferral stands on the identical failure at `6ec3faa`; the root-cause
  sentence is reworded as unverified below.

G-14 wording correction: the cause (host default for `external_directory` on 2.0.26 versus the spike's expectation)
is not proven; only "identical failure at `origin/master` `6ec3faa`" is.

Orchestrator validation: `npm run typecheck` exit 0; `role-agents-work-roots`, `roles.registration`, `work-roots`,
`docs-drift`, `routing-advisor` integration: 326 passed, 1 skipped; on 2.0.26: role-spikes S2+S6 4/4 (with the
auto run), roles + role-spikes 22/24 before the S6 matcher fix (S6 matcher, S11 = G-14), `smoke:v2:e2e` 4/4.

### Focused QA round 2 (heavy, 2026-10-16)

Reviewer session `ses_ebb3c667dffeX2mkwSDnJR5PAb` at `10a8f1e`: QA-62F-1..-5 closed (inside-work-roots gating
identical to `8c8c6e0`; every new unit case except the boundary guard fails on `25fd915`); three new nits, all fixed:
- **QA-62F-7 (docs):** `docs/EXECUTOR.md` separates plan-executor assembly (no discovery outside the work roots)
  from role registration (read-only executor-home lookup to deny it); `CHANGELOG.md` states the home deny and the
  missing slots-root allowance outside; `docs/ROLES.md` names the start directory; docs-drift pins added/updated.
- **QA-62F-8 (wording):** the unresolved-home warning now says the home is not denied; test retitled.
- **QA-62F-9 (low confidence):** outside the work roots a failed listing also runs the home lookup (in the start
  directory), so a configured root covering the common directory still gets the deny; new unit test "QA-62F-9 …".

Orchestrator validation: typecheck exit 0; role-agents-work-roots, roles.registration, work-roots, docs-drift,
role-agents, dispatch.worktree-list, routing-advisor integration: 333 passed, 1 skipped. Round 2 had no major
finding, so no round 3 (§0.7).

### Final smoke gate (A-6.2-1), 2026-10-16

Head `fcf6b1b`, host OpenCode 2.0.26 (`OPENCODE_V2_BIN`), v1 lanes with 1.18.35 first on `PATH`, no
`OPENCODE_CONFIG_DIR`/XDG overrides. Logs: `D:\git\omr-cpx-p61\.cpx-logs\gate62-final\`.

- `smoke:cpx`: 74/74.
- `smoke:cpx:provision`: 4/4.
- `smoke:v2`: 2/2.
- `smoke:v2:e2e`: 4/4.
- `smoke:routing`: 12/13. The one failure is `5-advisor`, PF-4, pre-existing.
- roles + role-spikes: 23/24. The one failure is S11, G-14, identical at `origin/master`.
- `smoke:keyless`: 27 passed, 11 skipped.
- `smoke:v1`: 27 passed, 11 skipped.
- `smoke:cpx:e2e`: 22 passed, 3 failed, 9 skipped; the 3 failed cases rerun isolated: 3/3 passed.
  - Two py-pip cases were environmental: the gate shell lacked `CPX_E2E_PYTHON`, and `py -3` resolves Python 3.14,
    whose pytest is only in the user site, which the executor's venv does not see. This is the documented
    prerequisite; rerun with `CPX_E2E_PYTHON=C:\Users\Marquinho\miniconda3\python.exe` (Python 3.13.11, pytest 9.0.2).
  - One node-npm throughput case failed G8 ("idle with ready work at most 10,000 ms: expected 12831") and passed on
    the isolated rerun: timing-sensitive on the real host, recorded with G-10's family, no product change.

A power loss interrupted the gate after the keyless lane; the remaining lanes resumed on the same head (repository
fsck clean).

### 6.2.4 pre-flight rerun on `cpx/main` (2026-10-16)

Merge `87629fc` (`cpx/p62` into `cpx/main`): `git diff fcf6b1b 87629fc -- src test package.json package-lock.json` is
empty, so the smoke gate above stands for the merged code. Run in `D:\git\omr-cpx-p62` fast-forwarded to `87629fc`
(no `.opencode\`, no `OPENCODE_CONFIG_DIR`); logs `D:\git\omr-cpx-p61\.cpx-logs\p62-final-*.log`.
- `npm run typecheck`: exit 0.
- `npx vitest run --coverage --coverage.reportOnFailure --maxWorkers=8`: 314 files, **20265 passed, 1 failed, 87
  skipped**; coverage **statements 95.63%, branches 92.21%, functions 96.66%, lines 97.28%**, no threshold error.
- **G-15 (minor, test, load-sensitive) — deferred with G-10.** The failure, `test/unit/roles.runtime.test.ts`
  "annotates an ESCALATE: authority return …", hit the default 5 s timeout under the 8-worker coverage run. It passes
  alone three times and with its file (95/95). Not a G-12 regression: its own duration with its file at 8 workers is
  658 ms at `8c8c6e0` and 530 ms at `87629fc` (file totals 25.1 s and 26.9 s). CI's coverage gate reruns it; a CI
  failure becomes a 6.2 finding (6.2.4-2).
- CHANGELOG and `docs/CONFIG_REFERENCE.md` completed in `9829c3c` (docs only; docs-drift 135/135).

### 6.2.4-2: PR #116 CI findings and fixes (2026-10-16/17)

PR #116 (`7b34437`) failed CI: 34 tests on ubuntu (node 22/24, coverage), timing failures on every Windows job, and
CodeQL (4 new alerts). Fixed in `cpx/p62`, validated through a CI-only draft PR #117 (`cpx/p62` → `cpx/main`, closed
unmerged) and locally on Windows and on Linux (WSL Ubuntu, clean clone with the same diff).
- **G-16 (blocking): the plan executor only works on Windows** (`routing.executor.slotsDir` must be a drive-letter
  path; default `<drive>:\.omr-slots`). **Owner decision (option A):** Windows-only in this release. Off Windows on
  OpenCode v2: no `router_plan`, no `/plan`, no plan help, no start-up discovery, no slots grant, one notice per process
  (roles at start, leases `enforce`, verify not `never`); one seam `src/executor/platform.ts`. Real executor suites
  run on win32 only; an all-platform suite asserts the inert behaviour. Linux-only test fixes: tool-paths expectation
  (product splits on both separators, intended), hermetic provision PATH, v2-background polls the whole context,
  docs-drift reads EXECUTOR.md line-ending agnostic (the Windows CI checkout has CRLF). Commit `096da6b`.
- **G-17 (CI, test-only):** heartbeat and release waits synchronized on deterministic signals; git/IO-heavy tests
  bounded with measured per-test timeouts. Commit `d31cbbc`.
- **G-18 (CodeQL):** linear trailing-separator trim (`js/polynomial-redos`, `src/routing/roles/work-root.ts`) and a
  full regex escape in the host-contract smoke (`js/incomplete-sanitization`). Commit `0b7d853`. The two
  `js/bad-tag-filter` alerts in `src/executor/compile/parse.ts` are false positives (`-->` is the plan graph arrow,
  no HTML is parsed) and are dismissed as such.
- **Heavy QA of G-16..G-18** (`ses_eb9f914bbffeOjbtEi7ZYKrXrW`): round 1 — 6 minor, 6 nit (QA-62C-1..12), all fixed
  (`e0141ec`, `466c841`): an on-disk executor-home deny off Windows (a repo shared with a Windows host), executor
  config issues silenced off Windows, a process-global notice flag, the lock heartbeat retries after 1 s and warns
  after 3 failures, partial win32 gating that keeps portable coverage, docs wording. Round 2
  (`ses_eb9c68543ffezhPASg8VXqMMMU`): all 12 closed; 1 medium (QA-62C-13: the on-disk reader was unbounded and
  FIFO-unsafe → now the hardened `nearestRepository`/`gitPointers`), fixed with QA-62C-14 (deny before the home
  exists), -16, -17 in `3cde83b`. Round-2 lows QA-62C-15, -18, -19 deferred (below); no round 3 (no major).
- **G-20 (CI, test-only):** remaining CI races (lock polls fired before the poll sleep was armed, timing rows read
  before they were written, IO-bound cases) synchronized or bounded. Commit `6f2ba73`.
- **G-21 (CI): owner decision (options B + C).** GitHub's Windows runners took 12-28 min per job with timing flakes.
  Pull requests run Linux only; one Windows job (`test + coverage (node 22, windows-latest)`: typecheck + full default
  suite with coverage) runs on master pushes and manual runs. The coverage gate merges Windows unit coverage when
  present; without it `src/verify/exec.ts` and the `src/executor/` prefix are warn-only (`--warn-only-prefix`). No
  local pre-push hook (owner decision). Commits `8b81baf`, `977c84b`.
- **PR #117 CI at `977c84b`: all green** (test node 22/24, e2e, bun smoke, coverage, coverage gate, smoke-keyless;
  Windows job skipped on the PR by design).
- **PR #116 merged into `master` as `1e499a4`.** Its first master run: the Windows job and every Linux job green;
  the merged coverage gate (3 inputs) failed the `src/executor/` prefix on branches: `git.ts` 89.57%, `runtime.ts`
  89.76% (90% required).
- **G-23 (CI, tests only):** edge-branch tests for `src/executor/git.ts` (11 branches) and `runtime.ts` (18), each
  asserting behaviour. A manual run on `cpx/main` (38976927615): gate passed, `git.ts` 91.73%, `runtime.ts` 90.56%.
- **G-24 (CI, test only):** that run's Windows job failed one test, `edges.test.ts` "finds the finder MAPPING in
  linear time" (255 ms against a 200 ms wall-clock bound under coverage). Replaced by a scaling check (doubling
  every input stays under 2.5x the time, best of three); the property is linearity, not machine speed. Manual run
  38979038442 at `faf31e1`: every job green, Windows included, gate passed. Merged into `master` via PR #118.
  The file's other wall-clock bounds (≈712, ≈735, ≈1166) did not fail and are unchanged.
- **PR #118 merged into `master` as `7a498e4`.** Its master run 38980548142: every Linux job and the coverage gate
  green; the Windows job failed one test, `roles-dispatch.test.ts` "Phase 4 QA M1: a linked worktree of an approved
  repository binds marked…" (cross-repo, on master since 2.8.0): 5 s default timeout while creating real git
  worktrees, then EBUSY in the cleanup of the still-running test.
- **G-25 (CI):** each Windows run so far tripped a different git/IO-heavy test on the 5 s default (the suite takes
  1142 s there with coverage, about twice a developer machine). The Windows job alone now runs with
  `--testTimeout=20000 --hookTimeout=60000`; explicit per-test bounds are kept, and Linux and local runs keep 5 s.
- `verify-resource-budget.deferred` 3.1.2.f (e2e, p50 capture wait): measured 1101-7060 ms locally at `origin/master`
  and 2820-5181 ms on this branch with the same command, and passed on PR #117's Linux e2e; no product overhead found
  by QA (the measured hook is v1, unchanged); recorded with G-10's load-sensitive family.

## Deferred findings

- **G-10 (minor, test):** load-sensitive tests (`v2-background` "QA-DF1-17", `routing-ladder-resume` "QA-2.3-2",
  `depth-guard-wiring` "shares one two-session walk across 50 concurrent task calls") each pass alone and with their
  files. The final gate's node-npm G8 throughput case (passed on the isolated rerun) is recorded in the same family.
- **minor-5 (N-B residual window):** low-confidence edge per the QA, no reproduction; a fix without one would be
  speculative.
- **G-14 (minor, pre-existing, host drift):** role-spikes S11 fails identically at `origin/master` `6ec3faa`; out of
  the plan's scope (A-6.2-2). The cause is not proven (QA-62F-6).
- **PF-4:** routing-engine smoke `5-advisor`, pre-existing (fails at `7181165` too).
- **QA-62C-15 (low):** off Windows a bare repository or a Git-for-Windows `gitdir: D:/…` pointer under WSL resolves no
  common directory, so no executor-home deny (no warning for an unparsable `.git`). Fail-open only for a repo shared
  with a Windows host; the hardened reader already refuses unsafe pointers.
- **QA-62C-18 (low):** a heartbeat side file is left on a write error; with the 1 s retry a long failure streak
  leaks more tmp files until the next acquire cleans them.
- **QA-62C-19 (info):** wording cleanups (double log prefix, one 5 s in-flight wait, Windows leases-off asymmetry).
- **Phase 6.1 deferrals:** the [Phase 6.1 consolidated table](phase-6.1.md#deferred-findings) remains authoritative,
  by reference under **A-6.2-2**; m-A from that queue was fixed here (folded into G-1).

## Handoffs

- G-14: refresh role-spikes S11 against the host in a separate change.
- G-10: move the affected tests to the serial project if they recur.
- `smoke:cpx:e2e` py-pip cases need `CPX_E2E_PYTHON` pointing at an interpreter with pytest when `py -3` has none
  visible to the executor's venv.
- G-4 follow-up: ordinary verification's `verify/wiring.ts` test search and committed-diff call still use bare git.
- G-3: G13 remains UNMET, owner decision pending.
- G-16: POSIX support for the plan executor (slots root, provision, environments) in a separate change.
- G-21: the Windows CI job runs only on master pushes; a Windows regression first shows there. Watch its first run
  after the #116 merge.

## Verdict

Every finding of the global QA rounds and the focused rounds is fixed or deferred with a recorded reason (see
Findings and Deferred findings). The final smoke gate is green except the two pre-existing failures (PF-4, G-14)
and the node-npm timing case, which passed on its isolated rerun (the two py-pip cases were environmental and
passed when rerun with the documented `CPX_E2E_PYTHON` prerequisite). 6.2.FIX is ready to merge into `cpx/main` for
6.2.4.

### Orchestrator validation of the 6.2.FIX batch (2026-10-16)

`npm run typecheck` exit 0. Scoped run (test/unit/executor*, verify*, v2*, docs-drift, exec*, test/golden and the
executor/v2/routing-advisor integration files): 81 files, 4497 passed, 1 failed, 7 skipped. The failure, G-9 below,
passes alone three times and with its whole file (384/384). Smoke helper tests (`--config vitest.smoke.config.ts
test/smoke/helpers`): 8 files, 226 passed. The R2-9 wording change required updating the docs-drift pin on
`routing.roleFloor` to the corrected text (verified against `GLOBAL_ONLY_ROLES_ROUTING_KEYS` and `sanitizeRoleFloor` in
`src/router/config.ts`); the pin keeps the same strength.

- **G-9 (minor, test) — fixed: serial heartbeat isolation.** `test/unit/executor-integrate-queue.test.ts` "a re-armed
  heartbeat keeps beating on every period" timed out at 20 s once under the full scoped run (8 workers); it passes alone
  and with its file. Same family as G-6 (real timers under CPU contention). Moved only that case to
  `test/unit/executor-integrate-queue-heartbeat.test.ts`, included only in the later single-fork `exec-serial` project
  added for G-6. Its assertions, 20 s polling deadline, 60 s test/hook limits and helper retry limits are unchanged.
  `exec-project-config.test.ts` pins both project selections, removal from the original file, one copy in the new
  file, unchanged limits and `npm test`'s default `vitest run`, so default Vitest and npm runs still select it once.
  No test was skipped, weakened or retimed. Validation remains with the orchestrator.

### Orchestrator validation of G-5 and G-9 (2026-10-16)

Owner decision 2026-10-16 for G-5: option (a), `router_plan` and `/plan` registered in roles mode at start only. The A4
assembly test was updated to the new rule with stronger assertions (no `router_plan`, no `/plan`, no help; executor
absence kept). The five docs-drift pins on the old "every v2 session" sentence now pin the new sentence; the three
heartbeat assertions moved unchanged to `executor-integrate-queue-heartbeat.test.ts` (serial project).
`npm run typecheck` exit 0; registration, command, project-config, heartbeat, queue, docs-drift, v2 unit, goldens and all
of `test/integration`: 91 files, 2445 passed, 2 failed, 62 skipped. The two failures, `v2-background` "QA-DF1-17" and
`routing-ladder-resume` "QA-2.3-2", pass alone twice each and with their files (82/82): load-sensitive like G-6/G-9,
recorded as **G-10 (minor, test)**, deferred: move to the serial project if they recur at the final gate.

### Orchestrator validation of N-A, N-B and N-D (2026-10-16)

`npm run typecheck` exit 0. Scoped run (test/unit/executor*, verify*, v2*, docs-drift, exec*, run-tools*, router-run*,
test/golden and all of test/integration): 144 files, 5909 passed, 2 failed, 81 skipped; no `expect` removed versus
a95a6ed. Both failures are G-10 (load-sensitive): `routing-ladder-resume` "QA-2.3-2" (second occurrence) and
`depth-guard-wiring` "shares one two-session walk across 50 concurrent task calls"; each passes alone twice and with
its file (93/93). N-D's release also accepts a `cancelled` task (an abort that cancels a blocked task never releases
its slot itself, and a cancelled task cannot relaunch); the orchestrator accepts this extension.
