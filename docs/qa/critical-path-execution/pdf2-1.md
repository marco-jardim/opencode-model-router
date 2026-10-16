# Dogfood fix phase pdf2-1 — executor work loss, stale base, orchestrator-shell criteria, read cap

Base `a682009` (tag `cpx/pdf2-1-base`), worktree `D:\git\omr-cpx-pdf2-1`, branch `cpx/pdf2-1`. Opened during DF2.5
(Phase 6.1 through the executor), which is paused on these faults. Design: architect `ses_ec90ae674ffe8Nf6KIa9NkfQaB`.

## Faults (from the ledger of `critical-path-execution-plan-6-1-db-6-1`)

- **DF-2-4 (blocking):** work of an interrupted attempt is destroyed. Every child stop (`ESCALATE:`, `NEED MORE:`) parks
  the task and releases its slot; the next attempt's `launchStep` always resets the slot (`runtime.ts:1430-1432`);
  `NEED MORE: budget` is classified as an ambiguity (`runtime.ts:269`), never resumed. 6.1.1 lost a finished attempt;
  6.1.2 cannot finish inside one dispatch and loops.
- **DF-2-5:** executor launches carry no `CAP:` line and drop the route's `budget=` (`expand.ts:307`).
- **DF-2-6:** the compile takes `baseCommit = rev-parse HEAD` in the plan file's checkout (`compile/index.ts:343-351,
  657`), not the base branch tip; `acquireSpecial` starts at the toplevel's live HEAD (`pool.ts:1400`).
- **DF-2-7:** `criteria:` lines marked "(orchestrator shell)" reach the child prompt and the grader, so children escalate
  for checks only the orchestrator may run.

## Design

- **(a) Resume on `NEED MORE: budget`.** New classification `budget` (and the router budget note). The same attempt
  resumes the same child session (`ChildRunRequest.resumeSessionID`, honoured by the runner, `v2-client.ts:194`) with
  "continue and finish", keeping slot, leases and branch; event `attempt-resumed`, `Attempt.resumes` (optional); cap
  `BUDGET_RESUMES = 3`, then park with cause `budget-cap`. `E_NO_CONTEXT` parks (work kept by (b)). No new
  `verifier.begin`. The launcher confirms a resume on its first step and creates no child.
- **(b) No lost work.** Before any reset or release of a slot the task still holds, a WIP snapshot (`git add -A`,
  commit with trailer `Omr-Wip: <plan>/<task>/<n>/<nonce>`, never `Omr-Attempt`) is stored at
  `refs/heads/omr/<plan>/wip/<task>`. After the reset, the next attempt restores it with `cherry-pick --no-commit` on top
  of the integration head (HEAD stays the base) and its prompt says the previous work is in the work root. Conflict:
  reset and park, ref kept. A dirty slot with no owner goes to `omr/<plan>/orphan/<slot>-<ts>`. Purge removes the refs.
  The verifier's base/candidate is unchanged (one task commit with every attempt's work); integration sees one
  `Omr-Attempt` commit per task.
- **(c) Fresh base.** `baseBranch` from the toplevel (detached HEAD refused), `baseCommit = rev-parse
  refs/heads/<baseBranch>` at compile; approve re-reads it and refuses `E_STALE_BASE` when it moved; `acquireSpecial`
  starts at the ledger's integration head. `ff-when-clean` landing unchanged.
- **(d)** One predicate `/\(orchestrator shell\)/i` in `expand.ts` (prompt: skipped, plus a note that the orchestrator
  runs them) and `plan-task.ts` (dropped from the grader's criteria).
- **(e)** `expand.ts` keeps `budget=` and writes one `CAP:` line (task CAP, else `CAP:12` for editing tasks). Also check
  why a `CAP:none` + `reason:` dispatch was capped at 12 (`index.ts:1711-1716`).

## Recovery of the paused 6.1 plan (orchestrator decision)

Abort and recompile under `cpx/df2.1` (base becomes the live `cpx/main` tip; no landing amendment). Q-7/Q-8 are not
answered. Salvage (`%LOCALAPPDATA%\omr-cpx\df2-salvage`) is seeded before approve as WIP refs of the new plan from a
scratch worktree (never a slot); the executor restores them at attempt 1 (A-DF2-4). The "(orchestrator shell)"
smoke criterion is run by the orchestrator after 6.1.1 integrates (A-DF2-3).

## Tasks

- W1 [heavy] runtime/types/ledger/unattended/git: (a) runtime + (b) snapshot/restore + contract types.
- W2 [medium] launch/expand/plan-task: (a) launcher resume, (d), (e).
- W3 [medium] compile/pool/create + docs/CHANGELOG: (c), EXECUTOR.md.
- W4 [medium] `test/integration/v2-executor-resume.test.ts`: A13 budget resume, A14 escalate with a dirty slot keeps
  work across attempts, A15 stale base refused.
- QA [heavy], fixes per §0.7, tag `cpx/df2.1` on the head.

## Round 4 — merge of cpx/main and re-check of 4070b22 (2026-10-15)

**Merge `013a529`** (cpx/main into cpx/pdf2-1) brings the Phase 6.1 executor fixes onto the DF-2-4..DF-2-7 fixes:
launcher-liveness recovery and R2-1, call-order slot claims, opt-in observations, and recovered-work admission after
the recovery barrier. Both fix sets survive. The four interaction points hold:

- Special slots start from the ledger's integration head; claims stay in call order and lookup rejections stay isolated.
- Abort latches, requests the attachment cut and cancels tasks without waiting for a verdict. Slot cleanup waits for the
  attachment's work in tracked background work and still saves unsaved work before the release.
- `closePlan` keeps its drain.
- Compile keeps the base branch tip and `E_STALE_BASE` alongside main's compile changes.

**Heavy QA verdict:** commit the merge. The R3 re-check of `4070b22` stays open until M1 is fixed. M1 is fixed in this
round, together with minor-1, minor-3, minor-4 and the nit. minor-2, minor-5 and minor-6 are deferred with the
reasons below.

**Orchestrator checks already run on `013a529`'s tree:**

- `npm run typecheck`: exit 0.
- Scoped executor, verify, v2, docs-drift and golden tests: 70 files, 4145 passed.
- Integration plus roles, lease, completion, tree, soak and service tests: 27 files, 1124 passed.
- Smoke helper tests: 7 files, 208 passed.

The fixes below were not part of those runs; the orchestrator runs typecheck and the scoped tests on this round's tree.

| ID | Severity | Finding | Status |
|---|---|---|---|
| M1 | major | From `4070b22`; DF-2-4 not fully closed. Reverting a dependency loses a blocked dependent's unsaved work. Row 34 (`completeReverted`) gave dependents' slots back with plain `pool.release`, skipping the save. A READY dependent can hold an unsaved slot: a lost or capacity-stopped attempt keeps it. The next `acquire` resets that slot, and the launch's own save comes after that reset, so the work is lost without a WIP ref. A RUNNING dependent was released by the queue's `settle`, racing `sweepBlocked`, which saves first. | **fixed**: the queue releases through the new `IntegrationQueueDeps.releaseSlot`. The runtime backs it with `releaseSlotSaved`, so the save comes first and a failed save keeps the slot leased. `sweepBlocked` is the only releaser of a slot whose child it cancelled: once per attempt, with the queue's release waiting for it. |
| minor-1 | minor | Merge interaction. Abort, `closePlan` and the admission identity-mismatch drop cleared recovered work without `releaseChildBinding` for a recovered `completed` end. Since `4070b22` the launcher holds completed bindings, so the binding leaked until dispose. | **fixed**: `dropRecoveredWork` releases the binding of every recovered end, and on abort its capacity token too. On an identity mismatch, an `end` now goes through `processEndNow`, which ignores a closed attempt and still does the bookkeeping (token, binding, rebound eviction, session). This also closes deferred 6.1 finding N3. |
| minor-2 | minor | A budget resume of a restart-adopted child loses its advisory `CAP:12` read cap. | **deferred**: caps are advisory. |
| minor-3 | minor | Merge ordering. `rebuildHeldSlots` opened the pool before `attachSlotObservations` was registered, so `slot-pool-open` and the initial slot rows of a restart or adopt were dropped. | **fixed**: the observations are registered first. |
| minor-4 | minor | Resolver addition. When the save before the re-provisioning reset fails, the hold is raised and false returned, but `p.slotLeases` kept the newly acquired slot while the ledger names the stale one. | **fixed**: the new slot stays leased under its hold (its work has no ref, so it is never released unsaved). The cached lease is dropped, so cache and ledger agree. |
| minor-5 | minor | Adopting an aborted plan orphans the abort's cleanup. | **deferred**: pre-existing; the pool's dirty-slot refusal limits the damage. |
| minor-6 | minor | On Windows, the quarantine rename fails with `EXDEV` when `slotsDir` is on another drive. | **deferred**: the EXECUTOR.md Windows notes already require slots on the same drive. |
| nit | nit | `slotGone("")` returns false, so `gitPointers("")` resolved against the process's cwd. | **fixed**: `saveSlotWork` treats an empty path as a failed save (logged and counted `wip-failed`); no git runs. |

**Regression tests:**

| Finding | File | Test |
|---|---|---|
| M1 | `test/unit/executor-integrate-queue.test.ts` | "M1: a blocked dependent's slot goes back through the runtime's saved release, never pool.release directly" |
| M1 | `test/unit/executor-runtime-resume.test.ts` | "M1: a READY dependent blocked by a reverted dependency keeps its unsaved work at its WIP ref" |
| M1 | `test/unit/executor-runtime-resume.test.ts` | "M1: a RUNNING dependent blocked by a reverted dependency is saved once and released by the runtime only" |
| minor-1 | `test/unit/executor-runtime-recovery.test.ts` | "an abort releases the binding and the capacity token of a registered, unadmitted recovered end" |
| minor-1 / N3 | `test/unit/executor-runtime-recovery.test.ts` | "N3: an admitted recovered end whose task moved on still releases its token, its bindings and its session" |
| minor-3 | `test/unit/executor-runtime.test.ts` | "the attach after a restart observes slot-pool-open before any other slot row" |
| minor-4 | `test/unit/executor-runtime-resume.test.ts` | "minor-4: a failed save before the re-provisioning reset keeps the new slot leased under its hold and drops its cached lease" |
| nit | `test/unit/executor-runtime-resume.test.ts` | "nit: a slot whose path is empty fails its save without running git in the process's cwd" |

The first run of the RUNNING-dependent test counted two `status` reads of the slot. The second read was not a second
save. The test's T1 had no dependency, so after row 34 the scheduler unblocked it at once (`promotable`: blocked with
satisfied dependencies) and relaunched it. That launch's own pre-reset check of the slot was the second read. The test
now gives T1 an unsatisfied dependency, as a reverted dependency is. The assertion is unchanged: one save, one release,
both by the runtime.
