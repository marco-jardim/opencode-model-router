# Phase 6.1 — End-to-end proof, documentation and ADR finalization

Runs under DF-2, through the plan executor (DF2.5): compiled with `phases=["6.1"] doneBefore="6.1"`, launched into
slots under `D:\git\.omr-cpx-slots\<planId>`, integrated into `omr/<planId>/integration`, landed into `cpx/main`.
Findings and fixes are written from `router_plan action=status` after the landing (freeze rule, DF-2).

## Pre-flight

Run by the orchestrator on `cpx/main` at `39067ce` (2026-10-13), before approve.

- §0.9: `cpx/main` clean; `tsc --noEmit` clean; Phase 5.1 merged (`272b82d`); the scoped tests of every phase merged
  since DF-1.3 green (76 executor/v2/golden/docs/roles files 4132 passed / 4 skipped after the 5.1 merge; sync-1 set
  187 files 10451 passed).
- `npm run smoke:cpx` green on `cpx/main`: 57/57. Also `smoke:cpx:provision` 4/4 and `smoke:v2` 2/2 (DF-2 pre-flight).
- Scripted-provider features still missing (`test\smoke\helpers\cpx-scripted-provider.ts` and the frozen base
  `scripted-provider.ts`):
  - scripted tool calls that write files: **missing** (tool calls carry an arbitrary name and input; nothing writes);
  - `ESCALATE:` replies: **missing** (fault kinds are rate-limit, overloaded, usage-limit, invalid-request);
  - structured QA findings: **missing** (replies are text or `tool_use` only);
  - per-call durations: **partial** (a scripted delay exists; no per-call duration is recorded on `CpxRequest`).
- `docs\ROLES.md`, `docs\OPENCODE_V2.md` and `docs\EXECUTOR.md` read as merged at `272b82d`: EXECUTOR.md has the 4.2
  sections, "Assembly and lifecycle" and "Verification of plan tasks"; OPENCODE_V2.md says the executor is registered on
  v2 only; ROLES.md "Work roots" covers the trusted slots root.
- Dry-run compile of this plan with the executor compiler (`phases=["6.1"] doneBefore="6.1"`, live repository view):
  - tasks: `6.1.PF1..PF3` preflight, `6.1.1`, `6.1.2`, `6.1.5` task, `6.1.3` tests, `6.1.4` manual, `6.1.QA` qa;
    `6.1.FIX` is a template, not a node (the QA loop creates fix tasks);
  - footprints equal the `Writes:` lines after amendment A-DF2-1, except `6.1.2`, whose `Writes:` is a directory with
    no tracked files and so writes ⊤ (A-DF2-2): a conflict edge `6.1.1 > 6.1.2` serialises the two;
  - 6.1 tasks without an `[acceptance]` block: `6.1.4` (manual) and `6.1.QA` (review); the executor verifies neither.

## Amendments (DF-2 pre-flight)

- **A-DF2-1:** 6.1.1's amendment note names the v1-frozen provider without a path, so the compiler no longer reads
  `test\smoke\helpers\scripted-provider.ts` as a write of 6.1.1.
- **A-DF2-2:** 6.1.2 keeps its directory `Writes:` (the fixture set is not known in advance); it writes ⊤ and runs after
  6.1.1 instead of in parallel. Recorded as a makespan caveat in the 6.1.4 metrics.

## Historical progress — 2026-10-14 (fallback; not accepted)

The dated entries in this section are historical snapshots. See **Current status** below for the committed corrections,
round 3 scope fix, Run 10 evidence and outstanding gates; earlier uncommitted/pending statements are not current status.

The owner selected the fallback on **2026-10-13**. **G13 remains unmet** and must be disclosed in the Phase 6.2 PR.
The pre-flight and amendments above are historical evidence, not a statement that the current worktree is clean:
the current state is dirty and in progress, with Phase 6.1 acceptance still unresolved.

### Observed results

- **6.1.3 is unfinished.** Run 8: **6 failed, 10 passed, 9 skipped; 518.58 s**. Run 9 is in progress with
  diagnostic-only instrumentation capturing arrival/probe timestamps; it is not acceptance evidence yet.
- Verified run 8 evidence: actual G6 contender refusals in three resilience cases; Node meaningful progress at
  **89024 / 89565 ms**, both before 90 s; the pip local G1 child was absent from provider capture. Unanswered Q1
  was not eligible because **2.1.4 had not succeeded**.
- The parent executed six targeted files: `lease-registry-modules`, `v2-leases`, `executor-compile-parse`,
  `executor-create`, `executor-integrate-bisect`, and `executor-runtime`: **561 tests passed in 15.66 s**.
  Separately, docs-drift: **123 tests passed in 3.67 s**. The typecheck tool exited **0**.
- First commit **`1d8d293`** (lease sharing) was created; read-only commit verification is still pending.
- Product automatic verification handles time out; these results do **not** establish phase acceptance.
  No verified Linear usage is recorded.

### Pending gates and forward obligations

- Detached **6.1.4** still requires **three green runs at the committed integration head**.
- **6.1.5 documentation** and **heavy QA** remain pending; no QA pass is claimed.
- Full-suite execution is deferred until **Phase 6.2**; no full-suite run is planned before 6.2, and no current
  full-suite result is claimed. Carry the unmet G13 disclosure into that phase's PR.

### Later progress update — 2026-10-14

- Four product commits have now been created: **`1d8d293`**, **`be3e4a6`**, **`f075c96`**, and **`ac61c34`**.
  This updates the earlier one-commit snapshot; commit creation does not establish smoke or phase acceptance.
- **Heavy product-correction QA round 1** is in progress at the fixed commit **`ac61c34`**. This is explicitly
  **not final phase QA**, and no QA pass is claimed.
- **Run 9 remains underway**, using the diagnostic-only arrival/probe timestamp instrumentation described above;
  no completed run 9 result or green smoke gate is claimed. **6.1.3 remains unfinished**.
- Detached **6.1.4's three green runs at the committed integration head**, **6.1.5 documentation**, and
  **final heavy phase QA** remain pending. The G13 disclosure and Phase 6.2 full-suite obligations above are unchanged.

### Round 1 remediation snapshot — 2026-10-14 (historical; not accepted)

This supersedes the in-progress Run 9 and QA-round-1 snapshots above; those entries remain historical evidence.

- **Heavy product-correction QA round 1 at `ac61c34`** reported **one P1** (CI-slot command/environment resolution)
  and **two P2s** (explicit writer-route grants and shared lease registry validation). The three corrections below are
  implemented in the worktree but **not yet committed**. This review was not final phase QA.
- **Shared leases:** `src/compat/background.ts` validates each shared registry entry independently without replacing
  an invalid entry or disturbing valid registries. `src/compat/v2-hooks.ts` refuses lease-checked file, search, git and
  run tools if enforced leases cannot start, rather than disabling enforcement.
- **CI checks:** `src/executor/integrate/run-resolver.ts` and `checks.ts` separate inherited command resolution from
  explicit overrides. Checks re-resolve the executable, environment and authorization against the prepared execution
  checkout, including base/bisect/revert checks, while preserving explicit working-directory and environment overrides.
- **Explicit writers:** `src/executor/create.ts` supplies the canonical selected `RoleSpec`; `compile/index.ts` checks
  its `grantFor` result, including configured narrowing. A general role without an `edit` grant is rejected.
  `test/unit/executor-create.test.ts` covers **five rejected routes and three valid routes**, retaining valid authored
  routes verbatim.

#### Scoped check evidence

Actual parent/producer executions reported for these corrections, not a full-suite run or validation of all subsequent
concurrent edits:

| Check scope | Result | Duration |
| --- | --- | --- |
| `lease-registry-modules` + `v2-leases` | 78 passed | 7.24 s |
| `executor-execution-slot` + `executor-integrate-bisect` | 186 passed | 23.77 s |
| `executor-create` + `executor-compile` filters | 13 files, 650 passed | 6.05 s |
| Last reported producer typecheck | Exit 0 | 4.2 s |

No tests were run for this documentation-only update. These scoped results do not establish smoke or phase acceptance.

#### Run 9 and remaining gates

- **Run 9 completed: 6 failed, 10 passed, 9 skipped; 540.07 s.** The diagnostic-only instrumentation did not yield a
  green smoke result; **6.1.3 remains unfinished**.
- In **`criticali-315`**, task **`1.1.4`** in **slot 4** reported `rebase --abort` exit **128**. The original stderr was
  lost, so the initiating failure is not established. The source error-masking fix is **underway and not yet validated**;
  it is separate from the three QA corrections above. **No new smoke run** has followed Run 9.
- Rebase/error-masking remediation and its checks, commits for the corrections, fresh smoke evidence, and **heavy
  product-correction QA round 2** remain pending; no QA pass is claimed.
- Detached **6.1.4's three green runs at the committed integration head**, **6.1.5 documentation**, and **final heavy
  phase QA** remain pending. **G13 remains unmet**; the Phase 6.2 PR disclosure and deferred full-suite obligations are
  unchanged. **Phase 6.1 is not complete or accepted.**

#### Rebase diagnostic follow-up — 2026-10-14

This supersedes the earlier rebase-fix status: **implementation is complete**, with scoped validation below.

- `src/executor/git.ts` checks rebase state before aborting and preserves the initiating failure alongside any cleanup
  error. `src/executor/integrate/queue.ts` persists bounded diagnostic details with URL credentials redacted.
- **Parent shell, unit checks:** `executor-git` + `executor-integrate-queue`: **493 tests passed across 2 files;
  45.83 s**.
- **Parent shell, real Git checks:** the targeted invalid-upstream and conflict-cleanup cases in
  `test/integration/executor-integrate-git.test.ts`: **2 passed, 33 filtered; 8.77 s**.
- The first combined **three-file invocation hit an external 200 s timeout without final results**. This is neither a
  test-pass nor a test-failure result. A separate run of the **whole affected real-Git integration file (35 tests)** is
  running in the background; **no result is available yet**.
- **Run 9's initiating cause remains unknown** because its original stderr was lost. The invalid-upstream regression
  case does not establish the cause of the `criticali-315` failure.
- Broader rebase validation, fresh smoke evidence and **heavy product-correction QA round 2** remain pending. No new
  smoke or QA pass is claimed; the other phase gates, G13 disclosure and deferred full-suite obligations above remain
  unchanged. **Phase 6.1 is still not complete or accepted.**

#### Completed rebase validation — 2026-10-14

- **Parent shell, completed real-Git integration file:** `test/integration/executor-integrate-git.test.ts`:
  **35 tests passed; 229.63 s**. The completed output in `.cpx-logs/qa-rebase-integration.log` belongs to the parent's
  background shell run, not this documentation-only edit.
- **Parent direct `npm run typecheck`: completed clean.**
- Together with the scoped unit results above, this completes **targeted rebase code validation**, superseding the
  earlier running/pending-validation snapshot. No repository-wide full-suite result is claimed.
- **Commits for the corrections, fresh smoke evidence and heavy product-correction QA round 2 remain pending.**
  Run 9's initiating cause remains unknown; the other phase gates, G13 disclosure and deferred full-suite obligations
  are unchanged. **Phase 6.1 is still not complete or accepted.**

## Round 2 validation snapshot — 2026-10-14 (historical; not accepted)

This **historical working-tree validation snapshot at HEAD `a066f4d`** records the round 2 corrections before commit.
Its pending statements apply only to that snapshot; see **Current status** below for the subsequent commits and evidence.

### Round 2 corrections

- **Committed corrections and notes:** **`4f98c05`** (shared leases), **`7cdb4f4`** (explicit writer grants and CI-slot
  resolution), **`ffb0475`** (rebase diagnostics), and **`183b984`** (documentation notes). These are existing commits,
  not pending work.
- **Heavy product-correction QA round 2 reviewed `183b984`** and verified that the original **one P1 and two P2s were
  resolved**. It raised one new P1, two P2s and one P3; this was **not a green review or final phase QA**.
- **Round 2 P3 — stale committed-status documentation:** already corrected in **`a066f4d`**; not pending work.
- **Round 2 P1/P2 code corrections are implemented with scoped checks passing; the two fixes await commit in this
  snapshot:**
  - **P1 — configured command substitution; P2 — scoped override loss:** `src/executor/integrate/checks.ts` executes
    configured commands and commands with explicit `cwd` or `env` overrides unchanged in full rather than substituting
    unsafe scoped runs, including rerun/bisect/revert paths. Ordinary equivalent package-script test scoping is retained.
  - **P2 — URL credentials in diagnostic keys:** `src/executor/integrate/queue.ts` redacts keys as well as string values
    before clipping, with bounded traversal and output handling and an unavailable-detail fallback.

### Scoped check evidence

Actual parent executions for the round 2 code corrections:

| Check scope | Result | Duration |
| --- | --- | --- |
| `executor-execution-slot` + `executor-integrate-bisect` | 2 files, 195 passed | 61.61 s |
| `executor-integrate-queue` | 373 passed | 54.08 s |

Producer typechecks passed. No tests were run for this documentation-only update. **Automatic verification still times
out or remains unattributable**; the scoped results do not establish a router-verification pass, green QA review, smoke
pass or phase acceptance.

### Remaining gates

- **Pending at this working-tree validation snapshot:** commits for the two code fixes, follow-up product-correction
  review limited to **major/critical blocking issues**, and fresh smoke evidence from **Run 10**. No Run 10 result or
  follow-up QA pass is claimed.
- **Run 9's initiating cause remains unknown** because its original stderr was lost; the committed rebase diagnostics
  and targeted regression checks do not establish that cause.
- **6.1.3 remains unfinished.** Detached **6.1.4's three green runs at the committed integration head**, **6.1.5
  documentation**, and **final heavy phase QA** remain pending. **G13 remains unmet**; the Phase 6.2 PR disclosure and
  deferred full-suite obligations are unchanged. **Phase 6.1 is not complete or accepted.**

## Current status — 2026-10-14 (round 3 / Run 10 snapshot; not accepted)

Recorded at **HEAD `20fd7b1`, before the round 3 fix commit**. This is a historical working-tree snapshot, not a claim
about later commit status; pending statements below apply only to this checkpoint and supersede the earlier snapshots.

### Bounded round 3 review and scope fix

- **Round 2 fixes are committed:** **`f802e9a`** (configured commands and explicit overrides), **`6c39d94`** (diagnostic
  key redaction), with notes in **`20fd7b1`**. They are no longer pending commits.
- **Bounded heavy product-correction QA round 3** identified one **major** bisect-scope issue. The **P3 `failingFiles`
  reporting issue for explicit `cwd` overrides is deferred**. This was not final phase QA or a green review.
- **The major fix is implemented and awaits commit at this checkpoint.** `src/executor/integrate/checks.ts` reports
  effective execution scope: any full-command execution makes the aggregate scope `full`, including mixed scoped/full
  runs. A requested file rerun that executes full commands cannot prove isolated-file evidence.
- `src/executor/integrate/phase-suite.ts` uses only genuinely scoped reruns as isolation evidence. With a red base and
  no valid isolation, the regression stays **unattributed**, rather than blaming an unrelated task. A file-scoped bisect
  also stops unattributed if a historical probe falls back to full commands. **Genuine scoped bisects remain**, including
  the regression that correctly identifies **T2**, not T1, against a red base.

### Scoped check evidence

Actual parent/producer executions reported for the scope fix, separate from the smoke evidence below:

- **Parent red regression run: six failures.** Five were behavioral wrong-culprit results selecting **T1**; the sixth
  expected the new scope metadata, not a sixth wrong-culprit observation.
- **Parent green run:** `executor-execution-slot`, `executor-integrate-bisect`, and `executor-integrate-queue`:
  **578 tests passed across 3 files; 98.86 s**.
- **Producer post-fix typecheck: exit 0.** No tests were run for this documentation-only update.

**Automatic verification still times out or remains unattributable.** These scoped results do not establish an automatic
verifier acceptance, green QA review, smoke pass or phase acceptance.

### Run 10 evidence and attribution limits

- **Run 10 completed: 6 failed, 10 passed, 9 skipped; 566.04 s** (`.cpx-logs/e2e-run10.log`). This is not a green smoke
  result or validation of the later scope fix; **6.1.3 remains unfinished**.
- G1 evidence is present in **all six cases**; **actual G6 contender refusals** were observed in the **three resilience
  cases**. The exported logs contain **zero critical `inbox-added` events**; that is an export-bounded observation, not
  proof of absence outside the capture.
- Captured progress continued **within 1.8 s of the 90 s deadlines**, and the **longest observed probe was under 3.6 s**
  (exports in `.cpx-logs/run10-evidence/`, summaries in `.cpx-logs/run10-summary.json` and
  `.cpx-logs/run10-lifecycle.json`). **No executor or probe stall is proven.** Timing-attribution investigation is ongoing;
  **time limits are unchanged**.
- **Run 9's initiating cause remains unknown** because its original stderr was lost. Run 10 and the diagnostic fixes do
  not retrospectively establish it.

### Remaining gates and next checkpoint

- The next checkpoint is the **atomic commit of the validated scope fix and notes**; keep commits frequent and atomic
  before future optimization. **No further broad product-correction review loop**, per owner; this does not replace final
  phase QA or resolve the deferred P3.
- Fresh green smoke evidence, detached **6.1.4's three green runs at the committed integration head**, **6.1.5
  documentation**, and **final heavy phase QA** remain pending. **G13 remains unmet**; disclose it in the Phase 6.2 PR.
- **Full-suite execution remains deferred to Phase 6.2**; no new full-suite result is claimed. **Phase 6.1 is not complete
  or accepted.**

## Owner amendment A-6.1-1 — 2026-10-14

This checkpoint supersedes the earlier current-status and time-limit statements; those dated snapshots remain historical
evidence. The owner approved **A-6.1-1 (G8 intrinsic-service accounting)** on **2026-10-14**. The plan's amendment log,
Target, 6.1.3 metrics, 6.1.QA focus, G8 row and Appendix D record the amended contract. This documentation records the
decision, not a completed oracle implementation, green run or phase acceptance.

### Amended G8 and related owner decisions

- On the **unchanged throughput fixture**, makespan must be at most
  **1.3 × max(CP_eff, W_auth/configuredMaxParallel, ΣI_service)**. W_auth and task work durations are fixed by the authored
  script before execution. CP_eff is the longest path of the **pre-run compiled dependency graph**, including semantic
  phase gates: task costs are authored work plus attributable intrinsic required-verification and integration service;
  phase-gate costs are intrinsic phase-suite service.
- Service-accounting boundaries and batch attribution are fixed before execution. A shared batch entry's **full service
  is assigned to each member**, members must be an **antichain**, and the entry is counted **once in ΣI_service**. Serial
  integration service uses **union accounting**. Missing or ambiguous service evidence **fails closed**.
- Queueing, resource waits, launch and preparation delays, cold initialization, idle and driver holds are **excluded from
  all bound terms**. The QA prohibition is extended, not removed: CP reconstructed from observed launch/integration
  ordering, task elapsed lifetimes, dependency-release waits or resource-serialization edges remains forbidden, as does
  observed parallelism. Negative controls must show that launch, queue, resource-wait and preparation padding cannot
  enlarge any denominator term. Keep **raw CP/ΣI as diagnostics**.
- The **1.3 factor, configured parallelism, authored workload and idle ceiling are unchanged**. The owner confirmed **G8
  idle predicate A** on **2026-10-14**: no episode may exceed **10,000 ms**. Authored durations remain **strict, with no
  additive slack**.
- The related **2026-10-14 owner watchdog decision** replaces the fixed **90 s** with a contract-derived per-host budget:
  **60 s setup**, then `1.3 × max(CP, W/p, entries × 5 s) + 60 s` after compilation, with a **300 s ceiling**. CP/W are
  authored, p is configured, and `entries × 5 s` is a pre-run integration allowance. This harness watchdog is not an
  additive allowance in the G8 acceptance bound.

### Run 13 remains a historical failure

- **run13 makespan: 173.836 s; legacy bound: 107.354 s — failure.** This result remains historical failure evidence.
- A deliberately generous **diagnostic ceiling under A-6.1-1 is ≤159.9 s**. Even this diagnostic-only reading leaves
  **≥ ~12.8 s still to be removed**; it does not establish complete, attributable service evidence or an oracle pass.
- **run13 must not be retroactively presented as an amended-oracle pass.** New runs must satisfy the implemented amended
  oracle, its fail-closed evidence requirements and negative controls, and the unchanged idle ceiling.

### Work and review in progress

In-flight work, not completed acceptance evidence:

- Service observations.
- Priority-preserving slot admission.
- Amended oracle implementation.
- Batching default for throughput.

**Heavy QA of `1d5f32c`, `eec5f1d`, `5b23547`, `cbdbd3f`, `2381219` and `9e079d8` is in progress.** No QA pass is claimed.
Fresh green smoke evidence, detached **6.1.4's three green runs at the committed integration head**, **6.1.5 documentation**
and **final heavy phase QA** remain outstanding. **G13 remains unmet** and must be disclosed in the Phase 6.2 PR; full-suite
execution remains deferred to Phase 6.2. **Phase 6.1 is not complete or accepted.** No tests were run for this
documentation-only amendment; docs-drift validation remains with the parent.

## Executor / observation / oracle heavy QA — 2026-10-14 (not accepted)

This checkpoint supersedes the in-progress heavy-QA status above; earlier snapshots remain historical evidence.
This cycle does not replace final phase QA or establish phase acceptance.

### Round 1 — `5b23547`

Scope: **`1d5f32c`, `eec5f1d`, `5b23547`, `cbdbd3f`, `2381219` and `9e079d8`**.

- **P1:** reset proof after provisioning.
- **P2:** oracle delayed closure.
- **P2:** unknown eligibility.
- **P2:** late-adopted child timing.

Fixed in **`7c57fca`, `d1118a2` and `39a1293`**.

### Round 2 — `b9155d3`

Also included first-round review of **`7c57fca` (slot admission)** and **`8d95663` (service observations)**.

- **P1:** moved-head fallback reset.
- **P2:** idle closure via inferred timestamps.
- **P2:** slot-admission rejected by oracle.
- **P2:** release wake swallowed by finishing step.
- **P2:** service spans included preparation/retry waits.
- **P2:** plan-task candidate null.

Fixed in **`7a9c3d9`, `0268f75` and `6edce3c`**. **Unknown eligibility and late adoption were confirmed resolved.**

### Round 3 — bounded review at `6edce3c`

- Scope was **major/critical/blocking only**: **CLEAN at that threshold (verified)**.
- The new amended G8 oracle in **`681966e`** was also reviewed: **no major/critical/blocking findings**.
- Lesser items remain deferred, with **no fix requested under the owner rule**:
  1. **P2:** the oracle does not correlate the verification candidate with the checked candidate.
  2. **P2:** required-service coverage is component-level, not operation-level.
  3. **P2:** a service span can include post-exit drain/kill tails on abnormal process lifecycles.

**Service-unattributed grading makes G8 evidence insufficient by design and can block acceptance.** The bounded clean
result does not mean the deferred items are fixed or that G8 has passed.

### Commit and smoke checkpoint

- **`681966e`:** amended G8 oracle and throughput default batching; resilience keeps **`batchMax: 1`**.
- **`9e079d8`:** Python pytest prerequisite.
- **Smoke Run 14 started** with **`CPX_E2E_PYTHON=C:\Users\Marquinho\miniconda3\python.exe`**; **result pending**.
  No green Run 14 result is claimed.

**Phase 6.1 is not accepted.** Outstanding phase gates, the G13 disclosure and the Phase 6.2 full-suite obligation remain
unchanged. No tests were run for this documentation-only update.
