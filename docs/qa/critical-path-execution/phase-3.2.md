# Phase 3.2 — Integration queue, phase suite, bisection and landing

Worktree `D:\git\omr-cpx-p32`, branch `cpx/p32` from `cpx/main` @ `9fa7607`. Started 2026-10-12 16:12.

## Pre-flight

- [x] Depends on 2.1 (`preemptBackgroundVerification`), 2.2, 2.4: merged.
- [x] Recon (explorer `ses_ecef3c4e2ffe3oaXFP5EjvrVma`): runner/slot/batch/wiring anchors, executor git and slot APIs, A1-3/A2 addenda, handoffs, config keys.
- [x] Exports needed: `planScopedRun`, `planRerun`, `readResult`, guards — already exported from `src\verify\runner.ts`; `acquireSlot`/`withSlot` exported from `src\verify\slot.ts` but `SlotOptions` has no priority option (memo M12: no new option; preempt + retry instead); `preemptBackgroundVerification` exported (`wiring.ts:451`), no caller yet. Plan anchors drifted: `wiring.ts` ≈1403-1410 → 451; `docs\VERIFICATION.md` ≈260 "transitive" note does not exist (nearest S6 `:255-258`, `:278`).
- [x] Config keys `land`/`batchMax`/`integrationChecks`/`phaseSuite` already typed in `ExecutorConfig` (`types.ts:276-281`); 4.1 declares and documents them.

## Implementation notes

Design memo 3.2.1 (architect `ses_eced7fde5ffesdmiLQ0u0TvlTz`, heavy), binding. §10 V1-V8 are checks the implementer runs first:
the binding memo for 3.2.2–3.2.6 is below, ready to paste under `## Implementation notes`. I ran out of read calls before I could check eight facts. They are listed in §10 (V1–V8) as checks the implementer runs first, escalating if any is false. The biggest unconfirmed assumption is V1: the "A1-3a rolled-back exemption" in the 2.2 store. The requeue in `resume()` depends on it. Two other places also go beyond the plan's wording and are labelled as my decisions: the extra flaky rerun inside integration checks (M11) and the cross-process repo lock (M5).

### 3.2.1 Design memo (binding for 3.2.2–3.2.6)

**Sources.**
- Plan §3.2: `docs/plans/critical-path-execution-plan.md:3108-3296`.
- Contract: `src/executor/types.ts`.
- Binding addenda in `docs/qa/critical-path-execution/phase-1.4.md`:
  - A1-2.4 row table: `:906-953`
  - A1-3: `:957-976`
  - A1-8: `:1085`
  - A1-12: `:1101`
  - A2: `:1107-1113`
  - A3 release callers: `:1119`

**Host policy and changelog.** 3.2 is executor code for Claude Code v2 only and has no v1 path (AGENTS.md host policy). It registers nothing; 5.1 wires it in. So 3.2 adds no CHANGELOG entry; the entry comes when 4.1/5.1 expose the feature.

**Abbreviations.**
- ISS / ISE: `integration-step` start / end.
- TT: `task-transition`.
- TS: `task-slot`.
- TI: `task-integrated`.
- IH: `integration-head`.
- AX: `attempt-context`.
- G: `gate-changed`.
- PP: `phase-paused`.
- IA: `inbox-added`.
- "head": `ledger.integration.head` (`types.ts:82`).
- "branch": `refs/heads/<integration.branch>`.

#### 1. Invariants (plan wording, `critical-path-execution-plan.md:3136-3141`) and enforcement

| # | Invariant | Enforced by |
|---|---|---|
| I1 | the integration branch advances only by `merge --ff-only`, to a commit whose integration checks passed in a slot, reverts included | Only `queue.ts#fastForward` moves the branch. It asserts `passed.has(candidate)`, the set of commits whose checks passed in a slot during this entry. It then runs `mergeFfOnly(integration.worktree, candidate)` followed by `branchForce(branch, candidate, head)` as a CAS (M6). Reverts go through the same function after `revert-checks` pass (M26). |
| I2 | published integration history changes only by new commits | Rebases and reverts run only on detached slot HEADs. The branch moves only by CAS to a descendant. Tags are create-only and never moved (M28). The code has no force and no reset of any branch. |
| I3 | one integration at a time per repository | One serial lane per queue, plus a repo lock keyed by `repo.key` (M4, M5). |
| I4 | every step is journaled before and after | Every git write sits between an ISS append that has resolved and the ISE that follows it (M7). The `StepJournal` seam enforces the entry rules (`phase-1.4.md:960`). |
| I5 | the owner's checkout is touched only by landing, fast-forward only, and only when clean | A write-cwd guard covers every git write (M30). The only write in the owner checkout is `Lander.fastForward`, and it runs only after `inspect` returns ok (M29). |

The phase suite is the backstop for breakage that affected-test scoping misses. The plan anchor `docs/VERIFICATION.md ≈260` is stale. The nearest text is S6, unmapped-module fail-closed (`:255-258`, `:278`), and "Unverifiable never counts as verified" (`:261`).

#### 2. Architecture

- **`queue.ts` (3.2.3)**
  - Is the only module that journals; owner code Q.
  - Owns every move of the integration branch and every entry kind.
  - Runs two lanes (M4).
  - Declares the seams `PhaseSuiteRunner`, `Lander` and `StepJournal`.
- **`checks.ts` (3.2.2)**
  - Prepares slots (reset and clean).
  - Selects checks.
  - Runs commands under the machine-wide verification slot.
  - Holds the extra git operations (`IntegrateGit`).
  - Journals nothing.
- **`bisect.ts` (3.2.4)**: pure search over the phase's ranges.
- **`phase-suite.ts` (3.2.4)**
  - Implements `PhaseSuiteRunner`: suite, reruns, base check, probes, and the revert build and check.
  - Journals only through the `StepJournal` the queue hands it.
- **`land.ts` (3.2.5)**: implements `Lander` structurally (it does not import `queue.ts`; 3.2.5 reads only `git.ts`).

#### 3. Decisions

- **M1 Single journaling owner.** Every Q row of A1-2.4 is written by `queue.ts` through `BatchBuilder`s (`types.ts:645`). Inside a builder, an entry id is `"i-" + (ledger.seq + 1 + k)`, where k is the 0-based index of the entry's first ISS in that batch (`phase-1.4.md:960`). Inbox ids are `formatInboxId(kind, nextInboxNumber(ledger))` (`:1061-1062`).
- **M2 Task split under fixed write sets.**
  - 3.2.3 writes only `queue.ts`, but 3.2.3.b needs "bisect by halves". So the batch halving driver (`integrateStack`) lives in `queue.ts`.
  - `bisect.ts` (3.2.4) is the range search the suite uses.
  - Revert entries are journaled and fast-forwarded by the queue. Building and checking a revert is `PhaseSuiteRunner.revert` (3.2.4).
  - Tags and landing are journaled by the queue and executed by `Lander` (3.2.5).
  - Tests for 3.2.3 use doubles of these seams.
- **M3 Config source.**
  - `ExecutorConfig` already carries `land`, `batchMax`, `integrationChecks` and `phaseSuite` (`types.ts:276-281`, limits `:293`).
  - 3.2 reads `ledger.config`, which is fixed at `plan-approved` (`types.ts:610`; D18 trust). It never reads the live routing config.
  - Declaring, validating and documenting the keys is 4.1 (`plan:3307`). 3.2 adds no config code.
- **M4 Lanes.**
  - **Serial lane** (task, batch, revert, tag, land).
    - At most one serial entry is open and in flight at a time.
    - Pick order:
      1. Resume reruns: requeued `integrating` tasks, then revert reruns, in `startSeq` order.
      2. Pending reverts.
      3. Tags.
      4. Task FIFO, batched.
      5. Land.
    - Reverts go before new tasks so the branch gets back to suite-green first.
  - **Background lane** (phase-suite).
    - One suite at a time per plan, because there is one `ci` slot. FIFO by phase.
    - Never takes the repo lock and never moves a ref.
  - Both lanes run only while `status === "running"`. Phase pause gates dequeue only. An entry that is already open, or reopened by resume, still runs while its phase is paused (A1-8 `:1085` restricts dequeue only).
- **M5 I3 per repository.**
  - An in-process async mutex keyed by `repo.key`, shared by every queue in the process.
  - A cross-process lock file `<executor state root>/repos/<sha256(repo.key)>/integration.lock`.
    - Content: `{pid, hostname, planId, entryId, heartbeatAt}`.
    - Created with O_EXCL.
    - Heartbeat every 30 s.
    - Take over when the holder is on the same host with a dead pid, or its heartbeat is older than 10 min.
  - Held from the first ISS of a serial entry until it closes, or until the lane stops.
  - The lock is outside `.git`, so I5 holds.
- **M6 Fast-forward mechanics.** Slots stay detached (2.4 handoff), so `merge --ff-only` cannot move the branch by itself. The step is:
  1. ISS(`fast-forward`, `entry.candidate` = target).
  2. `revParse(branch) === head`, else halt (M13b).
  3. Make sure the integration worktree is at head (`pool.reset("integration", head)` if HEAD differs or the tree is dirty).
  4. `mergeFfOnly(integration.worktree, candidate)`. This is git's own ff check; any failure ends the step `refused` and rolls back.
  5. `branchForce(integration.branch, candidate, head)`. The CAS publishes; a CAS failure halts.
  6. Row 30 batch.

  Crash between steps 4 and 5: tip equals head, so resume rolls back. Crash between step 5 and the row 30 batch: `candidate === tip`, so resume step 0 completes the entry.
- **M7 Write ordering and lock loss.**
  - No git write starts before its ISS append resolves (fsync'd).
  - Any rejected append stops both lanes before the next git write.
  - `E_LOCK_LOST` means the outcome is unknown (2.2 handoff). The queue makes no further git call and no listener call, marks itself disposed and rethrows. The next writer's `resume()` reconciles.
  - `E_ILLEGAL_TRANSITION` is a bug. Log it and pause through M13.
- **M8 Clean step before every check run.**
  - `prepare(slot, commit)` = `pool.reset(slot, commit)` (detached checkout, clean tracked files, re-provision if manifests drifted, `types.ts:1388`), then `pool.cleanForChecks(slot)` (`checkout --force`, `clean -ffdx -e keep`, empty status), then assert `revParse(slot, "HEAD") === commit`.
  - Runs before checks, batch-checks, every bisect probe, every rerun, the base check, revert-checks and the suite.
  - *Amended 2026-10-15 (Phase 6.1, integration lane latency):* for `checks`/`batch-checks` on the slot the queue's
    `stack()` has just rebased to exactly this candidate, the reset is skipped: `cleanForChecks` then the same
    `HEAD === commit` assertion, then a write-through marker update to the candidate commit. A HEAD mismatch or explicit
    provisioning/manifest drift returned by the clean falls back to the full `prepare`; bisect probes, reruns, the base
    check, revert-checks and the suite always use the full `prepare`.
  - Any failure is `error:"prepare"`, never pass.
  - The commit-only selection reads (`git show` and the base-to-candidate `git diff`) overlap the full or reused
    prepare. On a prepare failure all overlapped reads settle before returning; the prepare error is reported first.
- **M9 Check selection** (`select(tree)`, read at the candidate).
  - Commit-only file reads overlap M8 preparation, but command resolution waits for successful preparation. Only a
    git error explicitly reporting an absent path means "file missing"; other read errors fail as `error:"prepare"`,
    never a `no-checks` pass. A prepare error takes precedence over a concurrent selection-read error.
  1. typecheck, if `package.json` has a string `scripts.typecheck`; resolved as a package script with no args.
  2. tests:
     - Node: `scripts.test` exists and is not npm's placeholder `echo "Error: no test specified" && exit 1`.
     - pytest: `pytest.ini`, `conftest.py`, `[tool.pytest` in `pyproject.toml`, `[tool:pytest]` in `setup.cfg`, or `[pytest]` in `tox.ini`. Command `<python> -m pytest`, with python from `config.python` through `slots/env.ts`, and `isCommandAllowed` must be true.
     - Both run if both are present.
  3. extras: the trusted `integrationChecks` list in order, each through `RunResolver`. `"auto"` means no extras.

  Run order is fail-fast: typecheck, then tests, then extras. With zero components, the result is pass with note `"no-checks"` plus a counter; the suite is the backstop.
- **M10 Affected-test scoping.**
  - `changedFiles = diffNameStatus(base, candidate)`. Not `collectChanged`, which reads the work tree and is empty after the clean step.
  - Outcome of `planScopedRun`:
    - `ScopedSpec`: run it.
    - `NoAffected`: the component passes with label "no affected tests".
    - `Unscoped` or `Unverifiable`: run the full test command. Unverifiable is never counted as verified without a run (`VERIFICATION.md:261`).
  - Timeouts count as fail (`timedOut: true`).
- **M11 Confirmation inside integration checks (beyond the plan's wording; protects against blaming an innocent task).**
  - When the tests component fails with non-empty `failingIds`, `failingFiles` are rerun once inside the same step.
  - Ids that pass the rerun become `flakyIds` (in detail and a counter). They are not failures.
  - Failures of typecheck, extras or collection are final.
  - A "checks passed" verdict includes this one-rerun rule. Any culprit verdict therefore rests on two observed failures at the same commit.
- **M12 Verification slot.**
  - Foreground (all integration checks): `await preemptBackgroundVerification()` (`wiring.ts:451`), then `acquireSlot({max, waitMs: 2000, signal, meta:{cwd, command}, onLost})`.
    - On `{busy:true}`, if an in-process background suite holds a slot, abort it (`preemptBackground()`). Each suite can be preempted at most 3 times; after that the foreground waits. Then loop until the slot is acquired or the signal aborts.
  - Background (suite, reruns, probes, base check): no preempt call. Child processes get `os.setPriority(pid, PRIORITY_BELOW_NORMAL)`, best effort. Registered as preemptible.
  - `lost` is `error:"slot-lost"`.
  - No priority option is added to `slot.ts` (exports only).
- **M13 Infrastructure errors.**
  - (a) An `error` outcome (slot-lost, spawn, resolve, prepare, preempted) ends the step `refused` with the reason in detail. The same step is retried in the same entry, up to 3 tries. After that the queue writes [`status-changed running→paused` `"integration-infrastructure"` (only if running), IA(failure, critical)] and leaves the entry open, so resume handles it.
  - (b) A moved branch or a failed CAS gives [ISE(open step, `refused`), status-changed (only if running), IA critical `"integration-branch-moved"`]. The lane halts.
  - `refused` never blames a task.
- **M14 Rebase upstream.** `upstream = mergeBase(head, tip(task.branch))`. History is linear, so this is the task's base. Every rebase starts with `pool.reset(slot, tip)`, because `rebaseOnto` works on HEAD.
- **M15 Conflict summaries (3.2.3.a).**
  - After `rebaseAbort`, for each conflicting path (at most 20):
    - `ours` = `logPaths(upstream, head, path, 5)`: integrated commits that touched it.
    - `theirs` = `logPaths(upstream, tip, path, 5)`.
  - These go into the ISE detail and into the AX text used for the retry.
- **M16 Batching.**
  - Only when two or more dequeueable tasks are waiting (A1-8 gating).
  - Up to `batchMax`, in queue order.
  - Only tasks of the same phase as the first dequeueable task. `entry.phaseId` is fixed, and suite attribution is per phase. Phase-null tasks are batched with each other.
  - `batchMax = 1` disables batching.
  - No waiting for a batch to fill up.
- **M17 Stack in one slot.**
  - The entry slot is the slot of the last task of the batch or sub-batch. That task is always decided last, so its slot is never released mid-entry.
  - `entry.slot` may change (latest wins). Only `kind`, `phaseId` and `baseHead` are fixed (`phase-1.4.md:960`).
  - Stacking per task: `reset(slot, tip)`, then `rebaseOnto(slot, prev, upstream)`.
  - A conflict with `prev === head` is terminal (row 31).
  - A conflict against a co-batched commit makes the task **deferred**. It stays `integrating` in this entry and is retried after the main stack. So a task never gets `conflict` because of a batch-mate.
- **M18 Halving** (algorithm in §4.2).
  - A culprit is always the task whose commit at exactly `head + … + task` failed (observed, or memoized by commit sha within the entry).
  - Passing prefixes are fast-forwarded as checked commits (I1).
  - Every task gets exactly one terminal result.
  - Checks per stack ≤ 2n−1 plus deferred tasks.
  - Batch of 4 with one culprit at position 2: 4 checks.
- **M19 Partial fast-forward.**
  - Row 30 ISE has `closes: false` while any entry task is still `integrating`.
  - ISS(`fast-forward`) detail carries `ranges` (§5.2). Step-0 completion reads them from the entry's latest ISS in history, because `OpenIntegrationEntry` has no detail (`types.ts:240-248`).
- **M20 Phase precondition.**
  - `phaseIntegrated(ledger, P)` mirrors §3.3 exactly. Working reading: every non-qa task of P is in {integrated, done, cancelled}; if §3.3 says otherwise, §3.3 wins.
  - The queue calls `checkPhase(P)` after every row 30 and row 34 batch, and at the end of `resume()`. Table in §4.3.
- **M21 Suite resolution** (`PhaseSuiteRunner.resolve`).
  - Reads the suite commit through `git show`, so no slot is touched before the journal.
  - `"off"` → `pending→awaiting-qa` (`phase-integrated`, `types.ts:444`).
  - `"auto"` → the M9 tests at that commit. If there are none, same as off plus counter `integration.suite` with verdict `none`.
  - A list → `RunResolver` for each entry (`routing.run.commands` with its arg patterns, or an allowlisted package script with no args), cwd = `ci` slot.
  - A resolve refusal → PP + IA critical. The suite is never skipped silently.
- **M22 Suite classification.**
  - A full run gives `Failure {ids, files}`. `ids = []` means the failure cannot be attributed to ids (collection error or unparsed output); then reruns and probes run the full commands.
  - Rerun twice at the suite commit with `rerun(files)`, counting only the original ids:
    - `reproduced` = ids that fail in at least one rerun.
    - `flaky` = original ids minus `reproduced`.
    - Both reruns pass → `flaky` (result `flaky`).
  - Then check `reproduced` once at the phase base: ids that fail there are `pre-existing`; the rest are the `regression`.
  - `regression` empty → result `pre-existing`; the gate proceeds with an IA failure at severity info.
  - Otherwise bisect (M24) using only `regression.files`.
- **M23 Phase base.**
  - Defined as `baseHead` of the earliest (lowest `startSeq`) task or batch entry with `phaseId === P`, from history (never rotated, A1-3).
  - Not the `from` of the earliest task that is still integrated: after a culprit is reverted and integrated again, that commit would contain the culprit and hide the regression as pre-existing.
  - If P has no such entry, the suite is unattributed.
- **M24 Range bisect** (`bisect.ts`).
  - Ranges: the phase's tasks in state `integrated`, ordered by ancestry.
  - Lower-bound search for the first `to` that fails, then confirm the boundary: the culprit's `from` must pass (probe it unless it equals the previous observed commit).
  - A failing `from`, or a passing last `to` → `outside` (another phase's commit between the ranges) → unattributed: [ISE(last step, `failed`, closes), PP(`"suite-unattributed"`), IA critical]. The gate stays `suite-running`, and `checkPhase` restarts it after unpause (A2-1 "no open entry → start the suite, no gate event").
  - At most ⌈log2 n⌉ + 2 probes.
- **M25 Culprit hand-off.**
  - Closing batch: [ISE(`bisect`, `failed`, regression ids, closes), G `suite-running→suite-failed` (`suite-culprit-found`)].
  - The revert entry is opened at the front of the serial lane.
  - Crash between the two: `checkPhase` on `suite-failed` with no open entry for P looks at history.
    - Latest closed suite of P named a culprit, and no revert entry for P since → open the revert.
    - Otherwise → suite-rerun.
- **M26 Revert.**
  - Built in the `integration` slot (idle under I3, provisioned) at the **current** head.
  - `revList(from, to)`: each commit is reverted newest first with `GitOps.revert`. Message: `Revert "<subject>"\n\nomr: revert <taskId> <from>..<to> (phase <P> suite failure)`.
  - `revert-checks` = `checks.run({base: head, candidate: revertHead, extra: regression})`, foreground.
  - Plan step 4, "tasks integrated after the culprit are re-checked with the failing ids", is realized by `extra`. The revert candidate contains every later task, and running the ids **before** the fast-forward is the only placement where a failure still leaves a safe action (I1).
  - Revert conflict → [ISE(`revert-build`, `conflict`, closes), PP(`"revert-conflict"`), IA critical with paths and manual commands].
  - Checks fail → [ISE(`revert-checks`, `failed`, closes), PP(`"revert-insufficient"`), IA critical].
  - In both failure cases the branch is unchanged, the culprit stays `integrated` (`TASK_TRANSITIONS.integrated = ["reverted"]`, `types.ts:347`), and the gate stays `suite-failed`. This is the A1-12 reading "the culprit is parked = the phase is paused" (`phase-1.4.md:1101`).
- **M27 Row 34 batch.**
  - Order (`phase-1.4.md:906`): [ISE(`revert-fast-forward` ok, closes), IH, AX(culprit: suite commit, ids, range), TT `integrated→reverted` (`suite-culprit`), R9 dependents as rows 5/13/19 (`dep-reverted`), G `suite-failed→pending` (`culprit-reverted`)].
  - G must be in this batch, or a crash would leave the gate `suite-failed` with nothing to resume.
  - `reverted→ready|parked` is Rt/P through `listener.onReverted` (`types.ts:398,401,430-431`; separate batch, `phase-1.4.md:953`).
- **M28 Tags.**
  - Timing: when the gate is `passed`. The runtime calls `checkPhase` (handoff); the queue opens a tag entry with `candidate = head`.
  - Form: lightweight, `createRef(refs/tags/<phaseTagName(planId, P)>, candidate)`, create-only with zero old-oid.
  - `exists-same` → ok.
  - `exists-other` → [ISE(`tag`, `refused`, closes), IA failure info]; never moved (I2).
  - Ok → [ISE(`tag` ok, closes), `phase-tagged`].
- **M29 Landing.**
  - Only when `status === "completed"`, else `E_PLAN_STATE`. `candidate = head`, and `revParse(branch) === head`, else refuse.
  - `ff-when-clean`, all read-only, cwd = `repo.toplevel` only:
    1. `realpath(showToplevel(toplevel))` equals `repo.toplevel` (case-insensitive on win32).
    2. `symbolicHead === refs/heads/<baseBranch>`.
    3. `statusPorcelain` is empty (`--porcelain=v1 --untracked-files=all --ignore-submodules=none`).
    4. `isAncestor(baseTip, candidate)`.
    5. No ignored file in the owner checkout sits at a path that `baseTip..candidate` adds or changes. Git overwrites ignored files silently, so this check exists to protect them.
  - Then `fastForward` re-runs `inspect` and calls `mergeFfOnly(toplevel, candidate)`.
  - `baseTip === candidate` → landed (no-op).
  - Any refusal → IA(`landing`, blocking) with exact commands; landed false.
  - `manual` → IA(`landing`, info) report plus commands; ISE(`land`, `refused`, detail `"manual"`).
  - Never force, never non-ff.
  - `repo.toplevel` and `baseBranch` are set at compile time (`types.ts:80`, 3.2.5.d). `land.ts` re-validates them and computes nothing.
- **M30 Write-cwd guard (I5).** Every `GitOps` or `IntegrateGit` write goes through `assertWriteCwd(cwd, purpose)`. `realpath(cwd)` must be a slot path of this plan, or `integration.worktree`. For `purpose === "land"` it must equal `repo.toplevel`. Anything else throws (a bug).
- **M31 `resume()`** follows §4.8 (A1-3/A2 binding).
  - The rollback step is journaled under the entry rules: end the open step `rolled-back`, then ISS(`rollback`), then git, then ISE(`rollback`, `rolled-back`, closes). A1-3's "ISE(rollback, rolled-back, closes)" cannot legally end a different open step (`phase-1.4.md:960`).
  - Requeue relies on the A1-3a rolled-back exemption (2.2 handoff, V1).
  - Reruns are journaled by resume but run git only while running.
  - Also runs for `completed` plans, because the A1-3 land rule needs status completed.
  - A halted resume does not set the once-latch.
- **M32 `abort()` / `dispose()`**: §4.9.
- **M33 Metrics.** `MetricPayload` has no integration variant and `types.ts` is not in the 3.2 write sets, so use `{name:"counter", key, value, labels}` (`types.ts:593`). Keys in §5.3 (V8: align them with the Appendix D names).
- **M34 Detail encoding.** `detail = JSON.stringify(obj)` with the per-step schema of §5.2. At most 16 KiB; output keeps the last 4 KiB. AX text at most 4000 characters.
- **M35 Resource release (A3 `:1119`).**
  - Rows 30 and 33: after the fsync, `pool.release(slot)` then `leases.releaseTask`, by Q.
  - Rows 13 and 19 (live dependents): `deps.settle(taskId, release)`. Rt calls `release` after the child's completion settles.
  - `failed` and `conflict` keep their slot (rows 31 and 32).
  - Listener calls happen only after the fsync (`types.ts:1399`).

#### 4. Flows

**4.1 Step wrapper.**

```ts
step(j, s, patch, detail, fn): j.start → assertWriteCwd → fn() → j.end
```

An append that rejects is rethrown and stops both lanes.

**4.2 Task or batch entry.**

1. Row 28 batch: [TT `verified→integrating` (`dequeued`) for each task, ISS(`rebase`)]. For requeued tasks that are already `integrating`: ISS only.
2. Then `integrateStack(taskIds)`:

```
integrateStack(T): {stacked, deferred} = stack(T)
  if stacked: (check(T.length===1?"checks":"batch-checks", stacked)==="pass") ? integrate(stacked) : halve(stacked)
  if deferred: integrateStack(deferred)
halve(S):                       // pre: S on current head, tip observed failing
  if |S|===1: culprit(S[0])     // row 32; memo ⇒ ISS(bisect,{probe:"memo"}) then the row-32 batch
  L=S[0,⌈n/2⌉), R=rest
  if check("bisect",L)==="pass": integrate(L); halve(R)   // R unchanged on new head; its tip = S tip (memo fail)
  else: halve(L); integrateStack(R ids)                   // R re-stacked on the new head
```

**4.3 `checkPhase(P)`.** No-op unless status is running and P is not paused. Idempotent.

| Gate / state | Action |
|---|---|
| `pending`, precondition holds, suite resolves to runs | batch [G `pending→suite-running` (`phase-integrated`), ISS(`phase-suite`)], then background run |
| `pending`, precondition holds, off or none | [G `pending→awaiting-qa` (`phase-integrated`)] |
| `suite-running`, no open phase-suite entry for P | [ISS(`phase-suite`)] only (A2-1) |
| `suite-running`, suite in flight in this process | no-op |
| `suite-failed`, no open entry for P | M25: open the revert, or [G `suite-failed→suite-running` (`suite-rerun`), ISS] |
| `passed`, no `phase-tagged` for P | enqueue a tag entry |

**4.4 Suite** (`kind:"phase-suite"`, `slot:"ci"`, `taskIds: []`, `baseHead = candidate = head`).

1. Acquire `ci` with `acquireSpecial`, then prepare at the commit.
2. `run` → ISE ok closes + G `suite-passed`.
3. Failure: ISE(`phase-suite`, failed). Then 2× [ISS(`suite-rerun`,{n}), ISE].
4. If flaky, the second rerun's ISE is the closing one: [ISE(`suite-rerun`, `flaky`, closes), G `suite-passed`, IA(`flaky`, info)].
5. Otherwise ISS(`suite-rerun`, {at:"base"}). All pre-existing → [ISE(`pre-existing`, closes), G `suite-passed`, IA failure info].
6. Otherwise probes [ISS(`bisect`,{candidate}), ISE], then M25 or M24.
7. `interrupted` → the run

*(Memo continued by architect `ses_ece75f98affenAZs2QN72ln4Th`; V1 checked true.)*

**§4.4 step 7** (continues "7. `interrupted` → the run"):

7. `interrupted` → the run was stopped through its signal. What happens next depends on what stopped it:
   - **Foreground preemption (M12).**
     - The runner writes [ISE(open step, `refused`, `{reason:"preempted", n}`)], not closing.
     - It waits for `ci` as a background acquirer (no preempt), re-ISSes the same step with the same detail, and restarts from `prepare` (M8).
     - Budget: 3 preemptions per suite entry. After the third, `preemptBackground()` returns false for this entry and the foreground waits.
     - **M38 (new, clarification):** preemption does not use the M13a try budget. Otherwise three foreground checks could pause the plan.
   - **`abort()`:** the runner returns `{kind:"interrupted", by:"abort"}` with its step still open. `abort()` closes the entry (§4.9).
   - **`dispose()`:** nothing more is journaled. `resume()` rolls the entry back (§4.8, phase-suite) and `checkPhase` restarts it with the ISS only (A2-1, `phase-1.4.md:1107`).
8. `error` (prepare, spawn, resolve, slot-lost) → M13a inside the runner through `StepJournal`:
   - [ISE(step, `refused`, `{reason}`)], then re-ISS the same step. At most 3 tries per step.
   - After that the runner returns `{kind:"error"}` with no step open.
   - The queue writes [`status-changed running→paused` (`"integration-infrastructure"`, only if running), IA(failure, critical)]. The entry becomes **stalled** (M36).
9. Closing batches. A2-1 makes the closing ISE and the gate change one batch.
   - Passed → [ISE(`phase-suite`, ok, closes), G `suite-running→awaiting-qa` (`suite-passed`)].
   - Flaky and pre-existing: steps 4–5.
   - Culprit: M25.
   - `outside`, or no phase base (M23) → the M24 unattributed batch.
   - After the fsync: `onGate` / `onInbox`, then `pool.release(ci)` (V4), then the background lane takes the next phase in FIFO order.
10. **M36 (new): stalled entries.**
    - An entry left open by M13a exhaustion stays in memory as stalled.
    - The queue looks at status on every `enqueue`, on every `checkPhase`, and every 5 s while a stalled entry exists. Once status is `running` again, it applies the §4.8 step-1 rollback in-process (`reason:"stalled"`), then requeues or reruns exactly as `resume()` would.
    - So the restart path and the in-process path are one function: `rollbackEntry(open, reason)`.

**4.5 Revert entry**

Triggers:
- M25, right after the suite's culprit batch;
- `checkPhase` on `suite-failed` (M25 crash path);
- a `resume()` rerun.

The revert waits in memory as "pending revert" (M4 pick #2) until the serial lane picks it. Picking needs `status === "running"`, but not "phase not paused": a revert is not a task dequeue.

1. Repo lock (M5). ISS(`revert-build`) opens `{kind:"revert", phaseId:P, taskIds:[culprit], slot:"integration", baseHead:head, candidate:null}` with the §5.2 detail.
2. `acquireSpecial(planId, "integration")`, then `suite.revert(req, j)`:
   1. `prepare(integration, head)` (M8).
   2. For each `sha` of `revList(from, to)` taken newest first: `GitOps.revert(slot, sha, msg)` (M26 message).
      - On conflict: `revert --abort` (V3), then return `{kind:"conflict", paths, at: sha}` with `revert-build` still open.
   3. `revertHead = revParse(slot, "HEAD")`, then `j.end("ok", {revertHead, reverted})`.
   4. `j.start("revert-checks", {…}, {candidate: revertHead})`, then `checks.run({slot, base: head, candidate: revertHead, extra: regression, priority: "foreground"})`.
      - Pass → `j.end("ok")` and return `ok`.
      - Fail → return `failed` with the step still open.
      - Error → M13a inside the runner.
3. `ok` → the queue runs ISS(`revert-fast-forward`, candidate = revertHead), then M6 steps 2–5, then the row-34 batch (M27).
   - After the fsync, in this order:
     1. release for row-5 dependents; `deps.settle` for rows 13/19 (M35);
     2. `listener.onReverted(culprit)`;
     3. `onGate(P, "pending")`;
     4. `checkPhase(P)`. This is a no-op until the culprit integrates again.
4. `conflict` → [ISE(`revert-build`, `conflict`, closes, `{paths, at, commands}`), PP(P, true, `"revert-conflict"`), IA(failure, critical)].
   - The dirty integration slot is **not** reset now: that would be an unjournaled git write (I4). The next `prepare` resets it.
   - Commands are for inspection only, for example `git -C "<integration.worktree>" revert --no-commit <to>` on a scratch detached HEAD. The executor never runs them.
5. `failed` → [ISE(`revert-checks`, `failed`, closes, failingIds), PP(`"revert-insufficient"`), IA critical].
6. After the owner unpauses (cases 4 and 5), M25 sees a revert entry for P since the culprit suite. So it chooses `suite-rerun`; it does not retry the revert blindly. Breaking a repeat loop is left to the owner (R8).

**4.6 Tag entry** (serial pick #3; opened by `checkPhase` on gate `passed` with no `phase-tagged` for P)

1. `name = lander.tagName(planId, P)`.
2. ISS(`tag`) with entry `{kind:"tag", phaseId:P, taskIds:[], slot:null, baseHead: head, candidate: head}` and detail `{name, commit}`.
3. `r = lander.tag({cwd: integration.worktree, name, commit: candidate})`. `assertWriteCwd` uses purpose `"tag"`.
4. Results:
   - `created` or `exists-same` → [ISE(`tag`, ok, closes), `phase-tagged{phaseId, tag: name}`].
   - `exists-other` → [ISE(`tag`, `refused`, closes, `{at}`), IA(failure, info)]. The tag is never moved (I2).
   - `error` → M13a.
5. The tag ref lives in the common repository, not in the owner's work tree, so I5 holds.

**4.7 Land** (`land()`; single-flight)

1. Checks before any entry is opened:
   - `E_DISPOSED` once disposed.
   - `E_PLAN_STATE` unless `status === "completed"` (M29).
   - If the latest closed land entry in history is `ok` with `candidate === head`, and `revParse(toplevel, refs/heads/<baseBranch>) === head`, return `{landed:true, inbox:null}` and journal nothing (idempotent).
2. Take the serial mutex and the repo lock directly. The lanes' running-gate does not apply, because a completed plan has no queued work.
3. ISS(`land`) with entry `{kind:"land", phaseId:null, taskIds:[], slot:null, baseHead: head, candidate: head}` and detail `{mode, toplevel, baseBranch}`.
4. If `revParse(integration.worktree, branch) !== head`: M13b. Since the plan is completed, no status event is written: only [ISE(`land`, `refused`, closes), IA critical `"integration-branch-moved"`].
5. `manual` mode → [ISE(`land`, `refused`, closes, `{reason:"manual"}`), IA(landing, info, report + `lander.commands`)]. Returns `{landed:false}`.
6. `ff-when-clean`: `i = lander.inspect(req)`.
   - Not ok → [ISE(`land`, `refused`, closes, `{refusal}`), IA(landing, blocking, commands)].
   - Ok → `o = lander.fastForward(req)`, which runs `inspect` again (M29), then `mergeFfOnly(toplevel, candidate)`. The no-op case still writes ok.
     - `landed` → [ISE(`land`, ok, closes, `{from: baseTip, to: candidate}`)].
     - `refused` → same as the refusal row.
     - `error` → [ISE(`land`, `refused`, closes, `{reason:"error", message}`), IA(landing, blocking)].
7. Counter `integration.land`. Return `{landed, inbox}`.

Refusal commands (exact; `<T>` = `repo.toplevel`, `<C>` = candidate):

| Refusal | Commands |
|---|---|
| `dirty` | `git -C "<T>" status --porcelain=v1 --untracked-files=all`; commit or stash, then `git -C "<T>" merge --ff-only <C>` |
| `not-checked-out` | `git -C "<T>" switch <baseBranch>`, then `git -C "<T>" merge --ff-only <C>` |
| `diverged` | `git -C "<T>" log --oneline <C>..<baseBranch>`; the owner chooses: `git -C "<T>" merge refs/heads/<integration.branch>` (never run by the executor) |
| `ignored-overwrite` | list the paths; move them, then the ff command |
| `toplevel-mismatch`, `base-missing` | report only |

**4.8 `resume()`** (A1-3 `phase-1.4.md:974`, A2-5 `:1111`, M31; `types.ts:1420-1425`)

- **Entry.**
  - Single-flight. Once the once-latch is set, it returns the cached report.
  - `aborted` → return an empty report with no I/O.
  - Allowed statuses: running, paused, completed.
  - Takes the serial mutex, then the repo lock (it waits; M5).
- **Step 0.** `tip = revParse(integration.worktree, refs/heads/<branch>)`. A failure to resolve counts as moved.
  - (a) `tip === head` → go on.
  - (b) All of these hold:
    - `tip !== head`;
    - `isAncestor(head, tip)`;
    - some open entry `o` has `o.step ∈ {fast-forward, revert-fast-forward}`, `o.edge === "start"` and `o.entry.candidate === tip`.

    Then complete it with the row-30 batch (ranges from that ISS's detail, read from history, M19/V2; `closes` per `phase-1.4.md:953`) or the row-34 batch (culprit, range, suite commit and ids from the ISS detail). Then do the post-fsync release and listener calls. Report: `completed += taskIds`, action `completed`.
  - (c) Otherwise: no git action.
    - Write [`status-changed running→paused` (`"integration-branch-moved"`), only if running] and always IA(failure, critical).
    - Return `{halted:true}` **without** setting the latch.
    - The lanes stay closed: dequeue requires the latch.
- **Step 1.** For each open entry, oldest `startSeq` first:
  1. Normalize the entry to a started rollback step:
     - open step not `rollback` and `edge === "start"` → batch [ISE(step, `rolled-back`, `{reason:"resume"}`), ISS(`rollback`, `{of: step, reason}`)];
     - `edge === "end"` → [ISS(`rollback`)];
     - open `rollback` start → keep it ("redo, idempotent").
  2. Run the rollback git for the kind (none for tag, land and phase-suite).
  3. Close the entry and requeue or rerun:

| kind | rollback git | closing batch | after the fsync | action |
|---|---|---|---|---|
| task / batch | `rebaseAbort(slot)` (ignore "no rebase"), `pool.reset(entry.slot, tip(lastTask.branch))` | [ISE(`rollback`, `rolled-back`, closes)]; `entry.taskIds` = the **full** latest list (V1: the exemption is keyed by the closing event's taskIds, `ledger.ts:256-258`) | still-`integrating` tasks go to the queue front in entry order (dequeue gating A1-8 applies; no TT on re-dequeue, §4.2 step 1); tasks a partial batch already integrated stay integrated | `rolled-back`; `rolledBack +=` the requeued ids |
| revert | `pool.reset("integration", head)` | [ISE(`rollback`, `rolled-back`, closes)] | journal the rerun now: a new revert entry, [ISS(`revert-build`)] with the same culprit and range. Git runs only while running (M31) | `rerun` |
| phase-suite | none | [ISE(`rollback`, `rolled-back`, closes)] | `checkPhase(P)` after step 2; ISS only (A2-1) | `rerun` if started, else `rolled-back` |
| tag | instead of the generic normalization: `lander.tag` (creates it if missing) | §4.6 batches (end the open `tag` step directly) | — | `tagged` / `none` |
| land | instead: read `refs/heads/<baseBranch>` in `toplevel` (read-only) | `=== candidate` → [ISE(`land`, ok, closes)]; else [ISE(`land`, `rolled-back`, closes)] | `land()` again after the latch, iff `completed` and `land === "ff-when-clean"` | `completed` / `rerun` |

- **Step 2 (orphans).** Tasks that are `integrating`, in no open entry and exempt (A1-3a; the store refuses non-exempt ones at open, `ledger.ts:1892-1897`), go to the queue right after the step-1 requeues, in plan order. Example: a crash after a rollback closed, before the re-ISS.
- **Step 3.** Call `checkPhase(P)` for every phase whose gate is `pending` with the precondition holding, `suite-running`, `suite-failed`, or `passed` without a tag. Each call is a no-op unless the plan is running and P is not paused.
- **Step 4.** Set the latch, release the repo lock, kick the lanes (if running), then run a pending `land()`.
- **Errors.**
  - `E_LOCK_LOST` → disposed, rethrow (M7).
  - Any other rejected append → rethrow; the latch stays unset.

**4.9 `abort()` / `dispose()`**

`abort()` (A1-8 step 2, `phase-1.4.md:1085`; `types.ts:1438-1439`). Single-flight; returns the same promise.

1. Set the `aborting` latch:
   - `enqueue` throws `E_PLAN_STATE`;
   - lanes stop dequeuing;
   - `checkPhase` and the stalled-entry kick become no-ops.
2. Abort the `AbortController` of the serial step and the background run. It reaches check and suite processes only; a git command in flight is awaited and never killed. A step whose git finished writes its normal ISE. A fast-forward step that already passed CAS completes its row-30/34 batch first, so no branch move is left unjournaled.
3. Collect the targets:
   - every open entry (in memory plus `openIntegration()`);
   - every in-memory queued task that is `integrating` (requeued or orphan). Each gets a synthetic `{kind:"task"}` entry, opened by its ISS(`rollback`), so row 33 keeps its exact shape.
4. Batch A: per entry, [ISE(open step, `rolled-back`)] if a step is started, then ISS(`rollback`, `{reason:"abort"}`).
5. Run the rollback git (§4.8 table).
6. Batch B, the single row-33 batch: per entry [ISE(`rollback`, `rolled-back`, closes)], and per still-`integrating` task [TT `integrating→cancelled`, TS(null)] (trigger: V7).
7. After the fsync: `pool.release` + `leases.releaseTask` per task (A3 `:1119`). Gates and inbox are untouched.
8. Release the repo lock. On throw: rethrow; the runtime logs and goes on (A1-8).

`dispose()`. Idempotent.

1. Set `disposed`: every method afterwards throws `E_DISPOSED`, and `queued()` returns `[]`.
2. Abort the signals and await the git command in flight (at most 30 s).
3. Journal nothing more and call no listeners. Open steps stay open for `resume()`.
4. Stop the heartbeat and remove the lock file if it is still this holder's.
5. Slots and leases stay as recorded in the ledger (rebuilt at open).

#### 5. Schemas

**5.1 Seams** (`queue.ts` unless noted)

```ts
// queue.ts
export interface StepJournal {
  readonly entry: Readonly<IntegrationEntry>;
  readonly signal: AbortSignal;
  /** ISS for the open entry; rejects synchronously if a step is open. Resolves after the fsync. */
  start(step: IntegrationStep, detail: StepDetail,
        patch?: Partial<Pick<IntegrationEntry, "candidate" | "slot" | "taskIds">>): Promise<void>;
  /** Never closes; closing ends belong to the queue (M1, A2-1). Runners leave their final step open. */
  end(result: Exclude<IntegrationStepResult, "rolled-back">, detail: StepDetail, failingIds?: readonly string[]): Promise<void>;
  assertWriteCwd(cwd: string, purpose: WritePurpose): Promise<void>;
  /** Buffered; appended inside the next batch. */
  counter(key: IntegrationMetricKey, value: number, labels: Record<string, string>): void;
}
export interface PhaseSuiteRunner {
  resolve(ledger: Readonly<LedgerV1>, phaseId: PhaseId, commit: string): Promise<SuiteResolution>;
  run(req: SuiteRunRequest, j: StepJournal): Promise<SuiteVerdict>;
  revert(req: RevertRequest, j: StepJournal): Promise<RevertVerdict>;
  /** Aborts the in-flight background run if it still has preemption budget; true if aborted. */
  preemptBackground(): boolean;
}
export interface Lander {
  tagName(planId: PlanId, phaseId: PhaseId): string;
  tag(req: { cwd: string; name: string; commit: string }): Promise<TagOutcome>;
  inspect(req: LandRequest): Promise<LandInspection>;
  fastForward(req: LandRequest): Promise<LandOutcome>;
  commands(req: LandRequest, refusal: LandRefusal): string[];
}
/** V2: wired by 5.1 from the 2.2 store's history read; the queue caches it and appends its own writes. */
export interface IntegrationHistory {
  steps(): Promise<readonly Extract<ExecutorEvent, { type: "integration-step" }>[]>;
}
export interface RepoLock { readonly lost: AbortSignal; release(): Promise<void> }
export interface RepoLockFactory {
  acquire(repoKey: string, holder: { planId: PlanId; entryId: string | null }, signal: AbortSignal): Promise<RepoLock>;
}

// checks.ts
export type WritePurpose = "slot" | "integration" | "tag" | "land";
export interface WriteGuard { assertWriteCwd(cwd: string, purpose: WritePurpose): Promise<void> }
export interface NameStatus { status: "A" | "M" | "D" | "T"; path: string }   // --no-renames
export type CreateRefOutcome = "created" | "exists-same" | { kind: "exists-other"; at: string };
export interface IntegrateGit {
  /** git diff --name-status -z --no-renames <from> <to> */
  diffNameStatus(cwd: string, from: string, to: string): Promise<NameStatus[]>;
  /** git log -z --format=%H%x00%s -n <max> <from>..<to> -- <path> */
  logPaths(cwd: string, from: string, to: string, path: string, max: number): Promise<Array<{ sha: string; subject: string }>>;
  /** git rev-list --reverse --topo-order <from>..<to>; oldest first */
  revList(cwd: string, from: string, to: string): Promise<string[]>;
  /** git update-ref <ref> <commit> <zero-oid of commit's length>; on failure reads the ref → exists-same | exists-other. Write. */
  createRef(cwd: string, ref: string, commit: string): Promise<CreateRefOutcome>;
  /** git merge-base <a> <b> */
  mergeBase(cwd: string, a: string, b: string): Promise<string>;
  /** git merge-base --is-ancestor; exit 0 → true, 1 → false, else throw */
  isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean>;
  /** git show <commit>:<path>; null if absent (M9, M21) */
  showFile(cwd: string, commit: string, path: string): Promise<string | null>;
  /** git log -1 --format=%s <commit> */
  subject(cwd: string, commit: string): Promise<string>;
  /** git rev-parse --verify -q <ref>^{commit}; null if missing */
  readRef(cwd: string, ref: string): Promise<string | null>;
  /** git ls-files -z --others --ignored --exclude-standard --directory -- <paths and their parent dirs> (M29.5) */
  ignoredAt(cwd: string, paths: readonly string[]): Promise<string[]>;
  /** git revert --abort; tolerant of "no revert in progress". Write. */
  revertAbort(cwd: string): Promise<void>;
}
```

**5.2 `detail` schemas** (M34). Every object has `v: 1`. Ids go in the event's `failingIds` (`types.ts:629`), not in detail. Types live in `queue.ts` as `StepDetail = StepDetailMap[IntegrationStep]`.

| Step / edge | detail |
|---|---|
| `rebase` S | `{v, onto: head, tasks: [{taskId, tip, upstream}]}` |
| `rebase` E ok | `{v, stacked: [{taskId, from, to}], deferred: TaskId[]}` |
| `rebase` E conflict | `{v, taskId, paths: string[≤20], truncated, ours: {[path]: [{sha, subject}≤5]}, theirs: {…}}` |
| `checks` / `batch-checks` / `bisect` (queue halving) S | `{v, base, candidate, tasks: TaskId[], probe?: "memo"}` |
| same, E | `CheckDetail = {v, verdict: "pass"\|"fail"\|"error", components: [{name, label, exitCode, timedOut, durationMs, scope: "spec"\|"no-affected"\|"full"\|"rerun", flakyIds}], failingFiles, flakyIds, note: "no-checks"\|null, error: {reason, message}\|null, output /* last 4 KiB */}` |
| `fast-forward` S | `{v, from: head, to: candidate, ranges: [{taskId, from, to}]}` (M19; entry order) |
| `fast-forward` E | `{v, from, to}` or `{v, reason}` if `refused` |
| `phase-suite` S | `{v, commit, base: string\|null, commands: [{label, ref: RunCommandRef\|null}]}` |
| `phase-suite` E | `{v, files, idsUnparsed: boolean, durationMs, output}` |
| `suite-rerun` S | `{v, n: 1\|2, files}` or `{v, at: "base", commit, files}` |
| `suite-rerun` E | `{v, reproduced?: string[], durationMs, output}` |
| `bisect` (suite probe) S | `{v, candidate, taskId, probe: "to"\|"from"}` |
| `bisect` (suite probe) E | `{v, verdict: "pass"\|"fail", probes, culprit?: {taskId, from, to}, outside?: "from-fails"\|"last-passes"}` |
| `revert-build` S | `{v, culprit: {taskId, from, to}, suiteCommit, head, files}` (ids in failingIds) |
| `revert-build` E ok | `{v, revertHead, reverted: string[]}` |
| `revert-build` E conflict | `{v, at, paths, commands}` |
| `revert-checks` S / E | `{v, base, candidate, extraFiles}` / `CheckDetail` |
| `revert-fast-forward` S | `{v, from: head, to: revertHead, culprit: {taskId, from, to}, suiteCommit}` + failingIds (row 34 at step 0) |
| `rollback` S | `{v, of: IntegrationStep\|null, reason: "resume"\|"abort"\|"stalled"}` |
| `rollback` E | `{v, reset: string\|null}` |
| any E `refused` | `{v, reason: "preempted"\|"prepare"\|"slot-lost"\|"spawn"\|"resolve"\|"branch-moved"\|"cas"\|"manual"\|…, n?, message?}` |
| `tag` S / E | `{v, name, commit}` / `{v, outcome: "created"\|"exists-same"\|"exists-other", at?}` |
| `land` S / E | `{v, mode, toplevel, baseBranch}` / `{v, from?, to?, refusal?: LandRefusal}` |

**5.3 Counters** (`{name:"counter", key, value, labels}`, `types.ts:593`). They go in the batch of the ISE they describe. V8 aligns them with Appendix D.

`IntegrationMetricKey`:

| Key | value | labels |
|---|---|---|
| `integration.entry` | 1 | `{kind, outcome}` |
| `integration.step` | ms | `{step, result}` |
| `integration.checks` | ms | `{verdict, scope}` |
| `integration.checks.none` | 1 | — |
| `integration.flaky` | count | `{where: "checks"\|"suite"}` |
| `integration.batch` | size | `{outcome: "pass"\|"halved"}` |
| `integration.bisect.probes` | n | `{kind: "halves"\|"range"}` |
| `integration.suite` | ms | `{verdict: passed\|flaky\|pre-existing\|culprit\|unattributed\|none\|off}` |
| `integration.revert` | 1 | `{outcome: ok\|conflict\|insufficient}` |
| `integration.preempt` | 1 | — |
| `integration.slot.wait` | ms | `{priority}` |
| `integration.tag` | 1 | `{outcome}` |
| `integration.land` | 1 | `{mode, outcome}` |
| `integration.resume` | 1 | `{action}` |
| `integration.lock.takeover` | 1 | `{reason: "dead-pid"\|"stale"}` |

#### 6. File-by-file API

**`src/executor/integrate/checks.ts` (3.2.2)**

```ts
export interface ResolvedCommand { label: string; file: string; args: readonly string[];
  source: "package-script" | "run-command" | "pytest"; ref: RunCommandRef | null }
export interface CommandOutput { exitCode: number | null; timedOut: boolean; stdout: string; stderr: string; durationMs: number }
export type CommandRunner = (c: ResolvedCommand, o: { cwd: string; signal: AbortSignal; lowPriority: boolean }) => Promise<CommandOutput>;
export interface RunResolver {                       // V6: wired by 5.1 to router_run's resolution
  resolve(ref: RunCommandRef, cwd: string): Promise<{ ok: true; command: ResolvedCommand } | { ok: false; reason: string }>;
}
export interface TestComponent { framework: "node" | "pytest"; full: ResolvedCommand }
export interface CheckSelection { typecheck: ResolvedCommand | null; tests: TestComponent[]; extras: ResolvedCommand[] }
export type CheckErrorReason = "prepare" | "slot-lost" | "spawn" | "resolve" | "preempted" | "interrupted";
export interface ComponentResult { name: "typecheck" | "tests" | "extra" | "regression"; label: string;
  exitCode: number | null; timedOut: boolean; durationMs: number; scope: "spec" | "no-affected" | "full" | "rerun"; flakyIds: string[] }
export type CheckResult =
  | { verdict: "pass"; components: ComponentResult[]; flakyIds: string[]; note: "no-checks" | null; durationMs: number }
  | { verdict: "fail"; components: ComponentResult[]; failingIds: string[]; failingFiles: string[]; flakyIds: string[]; output: string; durationMs: number }
  | { verdict: "error"; reason: CheckErrorReason; message: string; components: ComponentResult[]; durationMs: number };
export interface CheckRequest { slot: SlotLease; base: string; candidate: string; priority: "foreground" | "background";
  extra?: { ids: string[]; files: string[]; commands: ResolvedCommand[] } | null; signal: AbortSignal }
export interface CommandRunRequest { slot: SlotLease; commit: string; commands: readonly ResolvedCommand[];
  mode: "full" | { rerun: readonly string[] }; priority: "foreground" | "background"; signal: AbortSignal; prepare: boolean }
export interface CommandRunResult { verdict: "pass" | "fail" | "error"; ids: string[]; files: string[]; idsUnparsed: boolean;
  output: string; durationMs: number; error: { reason: CheckErrorReason; message: string } | null }
export interface IntegrationChecks {
  prepare(slot: SlotLease, commit: string): Promise<void>;                 // M8; throws CheckPrepareError
  select(cwd: string, commit: string): Promise<CheckSelection>;            // M9, read at commit
  run(req: CheckRequest): Promise<CheckResult>;                            // M9-M12
  runCommands(req: CommandRunRequest): Promise<CommandRunResult>;          // suite/reruns/probes/base
}
export interface IntegrationChecksDeps { ledger: () => Readonly<LedgerV1>; pool: SlotPool; git: GitOps; igit: IntegrateGit;
  resolver: RunResolver; spawn: CommandRunner; guard: WriteGuard; background: BackgroundRuns; clock: Clock; logger: Logger;
  preemptForeground?: () => Promise<void>;                 // default: wiring.preemptBackgroundVerification
  acquire?: typeof acquireSlot }                           // default: slot.ts
export class BackgroundRuns { register(c: AbortController, budget: number): () => void; preemptOne(): boolean; get active(): number }
export class CheckPrepareError extends Error { readonly name: "CheckPrepareError" }
export function createIntegrationChecks(d: IntegrationChecksDeps): IntegrationChecks;
export function createIntegrateGit(run: GitRunner, guard: WriteGuard): IntegrateGit;
export function createWriteGuard(o: { ledger: () => Readonly<LedgerV1>; pool: SlotPool; realpath: (p: string) => Promise<string>; platform: NodeJS.Platform }): WriteGuard;
export function isPlaceholderTestScript(s: string): boolean;
export function selectFromFiles(f: { packageJson: string | null; pytestIni: boolean; conftest: boolean; pyproject: string | null;
  setupCfg: string | null; toxIni: string | null }, extras: readonly RunCommandRef[] | "auto"): { typecheck: boolean; node: boolean; pytest: boolean; extras: RunCommandRef[] };
export const CHECK_TRIES = 3, OUTPUT_TAIL_BYTES = 4096, DETAIL_MAX_BYTES = 16384, AX_MAX_CHARS = 4000;
```

**Exports from `src/verify/runner.ts` (export keyword only).**
- `planScopedRun`, `planRerun`, `readResult` (already exported).
- The types of their parameters and results: the scoped outcome union (`ScopedSpec | NoAffected | Unscoped | Unverifiable`) and the failure shape `{ids, files}`.
- Add `export` only where it is missing (V5).

**Exports from `src/verify/slot.ts`.**
- `acquireSlot`, `withSlot` (already exported).
- `SlotOptions` and the acquire result type (`{busy:true}` / handle with `lost`), if they are not exported yet.
- No new option (M12).

**`src/executor/integrate/queue.ts` (3.2.3)**: the §5.1 seams, the §5.2 detail types, plus:

```ts
export interface IntegrationQueueDeps { planId: PlanId; writer: LedgerWriter; history: IntegrationHistory; git: GitOps; igit: IntegrateGit;
  pool: SlotPool; leases: LeaseService; checks: IntegrationChecks; suite: PhaseSuiteRunner; lander: Lander; listener: IntegrationListener;
  settle: (taskId: TaskId, release: () => Promise<void>) => void; locks: RepoLockFactory; guard: WriteGuard; clock: Clock; logger: Logger }
export function createIntegrationQueue(d: IntegrationQueueDeps): IntegrationQueue;
export function createRepoLockFactory(o: { stateRoot: string; clock: Clock; pid: number; hostname: string;
  isPidAlive: (pid: number) => boolean; heartbeatMs?: number; staleMs?: number }): RepoLockFactory;
export function entryIdAt(l: Readonly<LedgerV1>, k: number): string;                 // "i-" + (l.seq + 1 + k), M1
export function phaseIntegrated(l: Readonly<LedgerV1>, p: PhaseId): boolean;          // M20
export function phaseBase(steps: readonly Extract<ExecutorEvent, { type: "integration-step" }>[], p: PhaseId): string | null; // M23
export function latestStartDetail(steps: readonly Extract<ExecutorEvent, { type: "integration-step" }>[], entryId: string): StepDetail | null;
export function pickBatch(l: Readonly<LedgerV1>, queue: readonly TaskId[], batchMax: number): TaskId[];   // M16 + A1-8
export const PREEMPT_LIMIT = 3, LOCK_HEARTBEAT_MS = 30_000, LOCK_STALE_MS = 600_000, STALLED_POLL_MS = 5_000;
export type SuiteResolution = { kind: "off" } | { kind: "none" } | { kind: "runs"; commands: ResolvedCommand[] }
  | { kind: "refused"; reason: string; ref: RunCommandRef | null };
export interface SuiteRunRequest { planId: PlanId; phaseId: PhaseId; commit: string; base: string | null;
  ranges: readonly TaskRange[]; commands: readonly ResolvedCommand[]; slot: SlotLease }
export type SuiteVerdict = { kind: "passed" } | { kind: "flaky"; ids: string[] } | { kind: "pre-existing"; ids: string[] }
  | { kind: "culprit"; range: TaskRange; ids: string[]; files: string[] }
  | { kind: "unattributed"; ids: string[]; reason: "outside" | "no-base" }
  | { kind: "error"; reason: CheckErrorReason; message: string } | { kind: "interrupted"; by: "abort" | "dispose" };
export interface RevertRequest { planId: PlanId; phaseId: PhaseId; culprit: TaskRange; suiteCommit: string; head: string;
  regression: { ids: string[]; files: string[]; commands: ResolvedCommand[] }; slot: SlotLease }
export type RevertVerdict = { kind: "ok"; revertHead: string; reverted: string[] } | { kind: "conflict"; at: string; paths: string[] }
  | { kind: "failed"; ids: string[]; files: string[]; output: string } | { kind: "error"; reason: CheckErrorReason; message: string }
  | { kind: "interrupted"; by: "abort" | "dispose" };
export interface LandRequest { toplevel: string; baseBranch: string; candidate: string; integrationBranch: string }
export type LandRefusal = { reason: "toplevel-mismatch"; actual: string } | { reason: "not-checked-out"; head: string | null }
  | { reason: "dirty"; paths: string[] } | { reason: "diverged"; baseTip: string } | { reason: "ignored-overwrite"; paths: string[] }
  | { reason: "base-missing" };
export type LandInspection = { ok: true; baseTip: string; noop: boolean } | { ok: false; refusal: LandRefusal; baseTip: string | null };
export type LandOutcome = { kind: "landed"; from: string; to: string } | { kind: "refused"; refusal: LandRefusal } | { kind: "error"; message: string };
export type TagOutcome = CreateRefOutcome | { kind: "error"; message: string };
```

`TaskRange` is imported from `bisect.ts`? No: `bisect.ts` comes later (3.2.4). So `queue.ts` declares `export interface TaskRange { taskId: TaskId; from: string; to: string }`, and `bisect.ts` imports it.

**`src/executor/integrate/bisect.ts` (3.2.4), pure.**

```ts
export type ProbeVerdict = "pass" | "fail";
export type RangeBisectResult = { kind: "culprit"; index: number; range: TaskRange; probes: number }
  | { kind: "outside"; reason: "from-fails" | "last-passes"; probes: number };
/** Orders by the position of `to` in `chain` (revList(base, suiteCommit), oldest first); throws on a `to` not in chain. */
export function orderRanges(ranges: readonly TaskRange[], chain: readonly string[]): TaskRange[];
export function bisectRanges(ordered: readonly TaskRange[], suiteCommit: string,
  probe: (commit: string) => Promise<ProbeVerdict>, known?: ReadonlyMap<string, ProbeVerdict>): Promise<RangeBisectResult>;
export function maxRangeProbes(n: number): number;   // ceil(log2 n) + 2
```

**`src/executor/integrate/phase-suite.ts` (3.2.4).**

```ts
export interface PhaseSuiteDeps { checks: IntegrationChecks; igit: IntegrateGit; git: GitOps; pool: SlotPool;
  resolver: RunResolver; background: BackgroundRuns; clock: Clock; logger: Logger }
export function createPhaseSuiteRunner(d: PhaseSuiteDeps): PhaseSuiteRunner;
export function classifyReruns(original: readonly string[], reruns: readonly [readonly string[], readonly string[]]): { reproduced: string[]; flaky: string[] };
export function revertMessage(subject: string, taskId: TaskId, from: string, to: string, phaseId: PhaseId): string;
```

**`src/executor/integrate/land.ts` (3.2.5)**: imports only `git.ts` and types; structural `Lander`.

```ts
export function phaseTagName(planId: PlanId, phaseId: PhaseId): string;   // `omr/${planId}/phase-${phaseId}`
export interface LanderDeps { git: GitOps; igit: IntegrateGit; guard: WriteGuard; realpath: (p: string) => Promise<string>; platform: NodeJS.Platform }
export function createLander(d: LanderDeps): {
  tagName(planId: PlanId, phaseId: PhaseId): string; tag(req: { cwd: string; name: string; commit: string }): Promise<TagOutcome>;
  inspect(req: LandRequest): Promise<LandInspection>; fastForward(req: LandRequest): Promise<LandOutcome>;
  commands(req: LandRequest, refusal: LandRefusal): string[] };
export function samePath(a: string, b: string, platform: NodeJS.Platform): boolean;
```

A conflict in the write sets: `land.ts` "reads only `git.ts`", but `IntegrateGit` and `WriteGuard` live in `checks.ts`. Resolution: `land.ts` imports **types** only from `checks.ts` and `queue.ts` (`import type`), and receives the instances by injection. Its return type is structural, so it needs no `queue.ts` runtime import.

#### 7. Tests (3.2.6)

- `test/unit/executor-integrate-queue.test.ts` (Q): uses the real 2.2 `LedgerStore` in a temp dir, so the entry rules and A1-3a are enforced by the code under test, plus doubles for git, checks, suite and lander.
- `test/unit/executor-integrate-bisect.test.ts` (B): pure functions.
- `test/integration/executor-integrate-git.test.ts` (G): real git, real `GitOps`, real 2.4 `SlotPool` in temp repos, `core.autocrlf=false`.
- A shared invariant checker runs after every appended batch in Q and G:
  - **I1:** tip ∈ passed set;
  - **I2:** every reflog step of the branch is ancestor→descendant, and tags never move;
  - **I3:** the lock mutex is never re-entered;
  - **I4:** every git-write spy call is between ISS and ISE;
  - **I5:** owner HEAD, index and status are unchanged except by `land`.

| Plan "New tests" bullet (`plan:3267-3284`) | File: cases |
|---|---|
| clean rebase fast-forwards | G: one task → `integrated`, TI range, branch = checked commit. Q: row-30 order |
| conflict → `conflict` with paths | G: same-line edit. Q: M15 summaries, AX, slot kept |
| failing checks → `failed`, branch unchanged | G + Q |
| stale `dist\` cleaned first | G: ignored `dist/out.js` stale and passing; `cleanForChecks` removes it, check fails. Fixture `stale-dist/` |
| batches of 4 with 0/1/2 failing | Q: culprits exact, innocents integrated, checks ≤ 2n−1; culprit at position 2 → 4 checks; co-batch conflict deferred and not blamed (M17). G: 4-task fixture with 1 failing |
| suite failure, culprit 3 of 6 | G: revert built in `integration`, revert-checks run with extra ids (spy argv), then ff. `onReverted`; row-34 order; G `suite-failed→pending`. B: `bisectRanges` for every position 1..8, n 1..8, probes ≤ bound; `outside` cases; `known` skips probes |
| flaky → inbox, no revert | Q: rerun pattern. G: test fails once via a counter file in the temp dir. B: `classifyReruns`. Q: M11 flaky ids in checks |
| `phaseSuite` naming `test-files` | G: fixture `routing-run.json`; the resolver resolves it; cwd = `ci` slot path |
| revert conflicts → parked, branch unchanged | G: a later task edits the culprit's lines. Q: PP `revert-conflict`, culprit stays `integrated`, gate stays `suite-failed`; unpause → M25 → suite-rerun |
| restart after every journaled step | Q: crash harness. The writer throws "crash" after append k (k = 1..N for each scenario), and also between `mergeFfOnly`/`branchForce` and between `branchForce`/row 30. New queue → `resume()` → quiesce. Same final ledger and head; exactly one TI per task. A1-3a orphan; halt on a moved branch (running vs paused, A2-5); tag and land entries; revert rerun; suite → ISS only. G: a subset (rebase, ff, revert-ff) |
| landing clean+ancestor / dirty / diverged / not checked out | G: each refusal → IA with commands, owner checkout byte-unchanged; `ignored-overwrite`; `manual`; idempotent second `land()`; `E_PLAN_STATE` |
| linked worktree, main worktree dirty on another branch | G: spy that every git cwd = toplevel; main worktree HEAD, status and index mtime unchanged |
| (memo) M13a/b, M5, abort, dispose, M4, checkPhase table | Q: 3 tries then pause, stalled kick (M36); CAS fail halts; two queues on one `repo.key` serialize; stale lock takeover; abort single row-33 batch incl. orphans, gates and inbox untouched; no journal after dispose; paused phase keeps its position; same-phase batch; `checkPhase` cell by cell |
| (memo) M9/M10/M12 | B (pure): `selectFromFiles`, placeholder script. Q: scoped outcomes, `preemptBackground` budget 3 (M38) |

Fixtures under `test/fixtures/cpx/integrate/`:
- `make-repo.ts`: builds commits from a JSON spec;
- `node-basic/`: `package.json` with `typecheck` and `test` → `node t/run.js`, which prints node-test-style ids;
- `pytest-basic/`;
- `stale-dist/`;
- `flaky/`;
- `routing-run.json`;
- `suite-6/`: six task patches, the third breaks a test in a file the task does not touch (a transitive breakage, `plan:3254`).

#### 8. Risks and order

**Order: 3.2.2 → 3.2.3 → (3.2.4 ∥ 3.2.5) → 3.2.6.**
- Run V1–V8 first. V2, V5 or V6 false → escalate before 3.2.3.
- 3.2.3 must freeze the §5.1 seams and the §6 types, because 3.2.4 and 3.2.5 build against them in parallel.
- 3.2.3 has no test file in its write set. Its acceptance (`testsPass`) covers existing tests only, and the real coverage arrives with 3.2.6. Plan 3.2.6 time for fixes.

**Risks:**
- **R1:** git's handling of ignored files during `merge --ff-only`, including file-vs-directory cases. Mitigated by M29.5 plus a G test (V3).
- **R2:** Windows open handles make `clean -ffdx` or `reset` fail. These are `error:"prepare"`, retried (M13a); never a pass.
- **R3:** a failure that does not repeat consistently makes bisect return `outside` → pause. Accepted: it fails closed.
- **R4:** cross-process lock takeover under clock skew. Use the same host plus pid liveness first; the 10-min stale rule only for other hosts.
- **R5:** history reads cost O(history). Cache once per process and append in memory.
- **R6:** SHA-256 repositories need a 64-zero old-oid in `createRef`, so derive its length from the commit.
- **R7:** background starvation is bounded by M38. Foreground waiting is bounded by the suite's own runtime.
- **R8:** after a revert conflict, recovery needs a human; that is by design (A1-12).
- **R9:** a crash during the owner checkout's ff can leave it mid-update. The re-land then refuses as `dirty` with commands, never forces.
- **R10:** real-git test time on win32. Keep repos tiny, and run the full restart matrix only in Q.

#### 10. Verification checks (the implementer runs these first; any false → `ESCALATE`)

- **V1: A1-3a rolled-back exemption. Checked: true.**
  - The exemption is implemented in `src/executor/ledger.ts`:
    - `HistoryTracker.rolledBack` (`:179-180`) is filled from the closing end's `entry.taskIds` when `result === "rolled-back"`, and cleared by any other closing result (`:254-259`);
    - `integratingWithoutEntry` skips exempt tasks (`:192-198`);
    - it is enforced per batch (`:1280-1288`), at open (`:1892-1897`) and on drafts (`:1957-1959`).
  - Consequence: the closing `rollback` ISE must list every requeued task, and its result must be `rolled-back` (§4.8).
  - Implementer check: a store test with a task `integrating`: [ISS rebase], [ISE rebase rolled-back + ISS rollback], [ISE rollback rolled-back closes], then reopen → loads. The same with closing result `refused` → `E_ILLEGAL_TRANSITION integrating-without-entry`.
- **V2:** the 2.2 store gives the queue a read of history `integration-step` events with `detail` (M19, M23, M25, land idempotence). `OpenIntegrationEntry` has no detail (`types.ts:240-248`). Check with `rg -n "history" src/executor/ledger.ts` for a public read or the `exportPlan` path. If none exists → escalate (3.2 cannot edit `ledger.ts`).
- **V3:** `git.ts` `GitOps` names and semantics:
  - `rebaseOnto` on a detached HEAD;
  - `rebaseAbort`;
  - `mergeFfOnly(cwd, commit)`;
  - `branchForce(branch, new, old)` is a CAS (`update-ref` with an old-oid) and works while the integration worktree is detached;
  - `revert` reports a conflict;
  - `revParse`, `showToplevel`, `symbolicHead`, and `statusPorcelain` flags as in M29.

  Read `src/executor/git.ts`. Add missing reads to `IntegrateGit`; a missing write → escalate.
- **V4:** `SlotPool` (`types.ts:1383-1397`):
  - `acquireSpecial` is idempotent;
  - `release` accepts the special slots;
  - `cleanForChecks` removes ignored build output (`dist/`) but keeps provisioned dependencies.

  Check `src/executor/slots/*.ts` and the 2.4 tests.
- **V5:** `planScopedRun` accepts explicit changed files and a cwd (M10), and `readResult` gives `{ids, files}` for Node and pytest. If `planScopedRun` reads the work tree itself → escalate: export-only cannot add a parameter. Also check `acquireSlot` options and result shape, and the `preemptBackgroundVerification` signature (`wiring.ts:451`).
- **V6:** a reusable `router_run` resolver exists for `{script, args}` (`routing.run.commands` with arg patterns; allowlisted script with no args), together with where the executor gets `routing.run.commands` under D18 (M3 uses `ledger.config` for `phaseSuite`, but the commands table is routing config). Check with `rg -n "run.commands|resolveRun" src`. If there is no injectable resolver → 5.1 wiring note, and escalate the ownership question.
- **V7:** `types.ts` names:
  - `InboxItem` severities (`info`/`blocking`/`critical`) and kinds `landing`/`flaky`/`failure`;
  - `GateTrigger` values `phase-integrated`, `suite-passed`, `suite-culprit-found`, `suite-rerun`, `culprit-reverted`;
  - `TransitionTrigger` values for rows 28, 33 and 34 (`dequeued`, abort, `suite-culprit`, `dep-reverted`) and `TRANSITION_OWNERS` for `integrating>cancelled` = Q;
  - `LedgerWriter`, `LeaseService`, `GitRunner`, `Clock`, `Logger` export names.

  Check with `rg -n "GateTrigger|TransitionTrigger|severity|TRANSITION_OWNERS" src/executor/types.ts`.
- **V8:**
  - The Appendix D metric names for integration: align §5.3 (`rg -n "Appendix D" docs/plans/critical-path-execution-plan.md`).
  - The §3.3 / A1-1 wording of "phase integrated" for M20.
  - The `TaskNode.integrated` shape `{from, to}` used for ranges (`rg -n "integrated:" src/executor/types.ts`).

## Findings

Three QA rounds by [tier:heavy] reviewers, plus a bounded fix round:

| Round | Reviewer session | Commit | Findings | Status |
|---|---|---|---|---|
| 1 | `ses_ecd78b6bdffe3dZy0K0H5o91Ed` | `2a1a3f6` | 1 critical (QA-3.2-1), 11 major (-2..-12), 9 minor (-13..-21), 6 nits | fixed in `47de105` |
| 2 | `ses_ecd1975afffeB5Ln022YbofC82` | `47de105` | 6 major (-22..-27), 9 minor (-28..-36), nits (-37) | fixed in `66dd24f`, coverage `6d77916` |
| 3 (bounded to the round-2 majors) | `ses_eccedfe13ffeXcwVtAuGD6is5R` | `66dd24f` | -22, -24, -26, -27 fixed, -25 fixed (risk m2), -23 partial; 2 new major fail-open paths (NEW-1, NEW-2); minors m1-m4 | NEW-1, NEW-2, m1 fixed in `e06b3f0` (§0.7: no further round) |

## Fixes

- Round 1 (`47de105`): the phase suite parses failing ids from full runs and fails closed on an unattributable failure with a
  red base (-1); A-3.2-1 stuck gate (-2); repo lock released on pause/halt (-3); cross-process lock with link-based create,
  rename heartbeat, two-poll takeover, pid liveness on the same host, compare-and-delete, `lost` checked before git writes
  (-4); stalled entries per lane (-5); revert checks rerun only the regression ids (-6); a pass needs a complete report
  (-7); suite preemption capped (-8); missing ref vs git failure (-9); reverted-culprit rebase base (-10); ignored-file
  landing check on exact paths (-12); abort -> interrupted (-13); case-safe phase tags (-14, A-3.2-2); tags after
  completion (-15); row-34 `endedAt` and G2 (-16); restart text (-18); task-less phases (-19); hardened land probes (-20);
  rollback slot ownership (-21); a busy loop between the lanes found while running the tests.
- Round 2 (`66dd24f`): a rerun that runs nothing is a failure (-22); collection errors make a run incomplete, and
  flaky/pre-existing need a full run (-23, A-3.2-3); revert checks with no usable file run the whole command, files read
  from history (-24); double-revert rebase base (-25); one id form, fail-closed probes and regression checks (-26, A-3.2-4);
  heartbeat/release race (-27); lost-lock latch and CAS-time lock verify (-28); stalled put-back (-29); bounded tag
  retries after completion (-30); dependent task-less phases woken (-31); cancelled-during-lock-wait tasks dropped (-32);
  lock-wait report and acquire errors surfaced (-33); stopped queue releases its lock, poll cleared (-34); land no-op
  first, `from = to = candidate` (-35); abort checks before the fast-forward and the suite close (-36); nits; probes
  rerun only files that do not fail at the base, new unattributed reason `base-overlap`.
- Round 3 (`e06b3f0`): a file-scoped bisect runs only when a file rerun at the suite commit failed with a regression id
  whose file is in the probe set; otherwise full-command probes and `files: []` (green base) or `base-overlap` (red
  base) (NEW-1); the full-run check runs whenever any id clears, cleared ids reported as flaky (NEW-2); truncated
  details revert-check the whole command (m1).

## Coverage

Orchestrator run on 2026-10-13 at `e06b3f0` (`executor-integrate-queue`, `executor-integrate-bisect` unit tests and
the `executor-integrate-git` real-git integration test): 576 passed, `tsc --noEmit` clean.

| File | Statements | Branches | Functions | Lines |
|---|---|---|---|---|
| `src/executor/integrate/bisect.ts` | 100 | 95.45 | 100 | 100 |
| `src/executor/integrate/checks.ts` | 100 | 98.37 | 100 | 100 |
| `src/executor/integrate/land.ts` | 100 | 98.33 | 100 | 100 |
| `src/executor/integrate/phase-suite.ts` | 99.21 | 94.65 | 100 | 99 |
| `src/executor/integrate/queue.ts` | 96.67 | 90.61 | 97.39 | 98.71 |

## Deferred findings

Round-3 minors (bounded round, §0.7):
- m2: `firstUpstream` takes the oldest journaled upstream; a retry branch rebuilt on a head containing R1 but not R2 and
  then reused could replay another task's reverted change. Prefer the newest ancestor-of-tip upstream.
- m3: `release()` swallows a failed compare-and-delete, leaving our lock file; same-host waiters then wait for this
  process to exit (the 5-minute wait item reports it).
- m4: a culprit with no ids rebuilt from history after the suite commands failed to resolve gets no regression run.
- Coverage-run note: a task cancelled after the post-lock re-check but before the `openEntry` batch is applied only
  logs `not-verified-at-batch` (`queue.ts` ≈1294-1307); not reproduced deterministically.

## Handoffs

- 5.1: create `omr/<plan>/integration` at `baseCommit` and acquire the integration slot before the queue's first
  `resume()` (QA-3.2-9); build a reverted culprit's retry on its old branch (QA-3.2-10/-25); rebuild state from the
  ledger at start (listener events are skipped on dispose); kick the queue on a user pause/unpause; wire
  `RunResolver` over `planRun` (V6) and `LedgerStore.exportPlan` (V2); wire a hardened `GitRunner` into
  `LanderDeps.run`.
- 3.1/5.1: the runtime is single-plan per process (A-3.1-1).

## Plan amendments

- A-3.2-1 (QA-3.2-2): a `suite-running`/`suite-failed` gate whose suite now resolves to none/off pauses the phase with a
  critical item, no gate event.
- A-3.2-2 (QA-3.2-14): phase tags use the `git.ts` `phase/<encoded id>` helper (plan 3.2.5.a, memo §6).
- A-3.2-3 (QA-3.2-23): `flaky`/`pre-existing` require a full-command run at the suite commit and a full base run.
- A-3.2-4 (QA-3.2-26): the revert regression check fails closed when a failing run names none of the regression ids.
- Memo M6 (a fast-forward refusal halts the lane) and M26 (one-line `revert(...)` message) amended as accepted deviations.

## Verdict

Done at `e06b3f0`. No CHANGELOG entry (nothing is registered until 5.1; memo :30). Merged into `cpx/main`.
