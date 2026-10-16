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

pending 6.2.QA

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

## Deferred findings

pending 6.2.QA

## Handoffs

pending 6.2.QA

## Verdict

pending 6.2.QA

### Orchestrator validation of the 6.2.FIX batch (2026-10-16)

`npm run typecheck` exit 0. Scoped run (test/unit/executor*, verify*, v2*, docs-drift, exec*, test/golden and the
executor/v2/routing-advisor integration files): 81 files, 4497 passed, 1 failed, 7 skipped. The failure, G-9 below,
passes alone three times and with its whole file (384/384). Smoke helper tests (`--config vitest.smoke.config.ts
test/smoke/helpers`): 8 files, 226 passed. The R2-9 wording change required updating the docs-drift pin on
`routing.roleFloor` to the corrected text (verified against `GLOBAL_ONLY_ROLES_ROUTING_KEYS` and `sanitizeRoleFloor` in
`src/router/config.ts`); the pin keeps the same strength.

- **G-9 (minor, test, new): load-sensitive heartbeat test.** `test/unit/executor-integrate-queue.test.ts` "a re-armed
  heartbeat keeps beating on every period" timed out at 20 s once under the full scoped run (8 workers); it passes alone
  and with its file. Same family as G-6 (real timers under CPU contention). Next step: move it to the serial project
  added for G-6, keeping its assertion and timeout.
