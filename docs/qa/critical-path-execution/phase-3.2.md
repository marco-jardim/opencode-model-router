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
  - Any failure is `error:"prepare"`, never pass.
- **M9 Check selection** (`select(tree)`, read at the candidate).
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
