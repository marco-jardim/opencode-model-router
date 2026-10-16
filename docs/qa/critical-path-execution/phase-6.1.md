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

## Owner amendment A-6.1-2 — 2026-10-15

The owner reclassified the **G8 makespan bound as a measured, disclosed metric**, like G13, on **2026-10-15**. This
supersedes A-6.1-1's makespan acceptance gate and the earlier statement that `service-unattributed` grading necessarily
blocks acceptance; the dated sections above remain historical evidence. It is **not a retroactive pass for historical
runs**, a green smoke result or Phase 6.1 acceptance.

### Amended acceptance and evidence contract

- Phase 6.1 acceptance **no longer requires makespan ≤ 1.3 × max(CP_eff, W_auth/p, ΣI_service)**. The throughput smoke
  still reconstructs and records **makespan, CP_eff, W_auth/p, ΣI_service, the bound, g8Ratio = makespan/bound and
  g8BoundMet**. The Phase 6.2 PR must disclose these alongside G13. **Raw CP/ΣI stay diagnostics.**
- **Still asserted:** every idle-with-ready episode under **predicate A is ≤ 10,000 ms**, and **service-evidence
  integrity** (pairing, identity/duration, attribution, makespan window and evidence before the passing verdict). Missing
  or malformed evidence fails closed. G8 therefore still has assertions that can fail, as required by 6.1.3.
- Delegated grading observed as **`service-unattributed`** is recognized verification evidence for the writer's final
  attempt, with the same attribution and integrity checks as `service`, but is **credited at zero intrinsic cost**.
  `V_service` sums only `service` spans; the unattributed verification duration union and span count are diagnostics.
  The computed bound is therefore **conservative (never larger than the true bound)**. A writer with neither kind of
  final-attempt verification evidence still fails closed; genuinely unknown span kinds/components remain rejected.
- The **1.3 factor, idle ceiling, configured parallelism, authored durations and watchdog are unchanged**.
  `assertG8Bound` remains available as a diagnostic predicate and for unit tests, not as a throughput acceptance gate.

### Rationale — Run 14, node-npm

- **Makespan: 166,163 ms**, versus an **amended bound ≤ ~108,900 ms**. These numbers motivate the owner decision;
  they do not establish a reconstructed-oracle pass for Run 14.
- All **20 writers** had exactly one **`service-unattributed` / `verify` / `grading` pair** and **zero `service` verify
  spans**. The prior oracle rejected this recognized producer evidence as `unknown service kind/component`.
- The serial integration lane costs **~4.3 s/entry**, of which **~1.24 s is intrinsic service**, dominated by **~36
  sequential git process launches**. Closing the gap needs a **speculative merge train changing invariants I3/I4**;
  that work is **deferred and requires a separate owner decision**, not a relaxation of those invariants here.

The plan's Target, 6.1.3.b, G8 row, Appendix D and amendment log record A-6.1-2. The oracle recognizes zero-credit
unattributed verification while retaining fail-closed evidence checks; the throughput smoke records the bound result
and keeps reconstruction and all idle assertions. **G13 remains unmet**, with its Phase 6.2 PR disclosure unchanged.
Outstanding phase gates and the Phase 6.2 full-suite obligation remain. **No fresh green smoke or phase acceptance is
claimed by this amendment.** Scoped validation (orchestrator shell, 2026-10-15): `cpx-g8-oracle.test.ts` 55/55 passed
under `vitest.smoke.config.ts`, `docs-drift.test.ts` 126/126 passed and `npm run typecheck` was clean; the real-host smoke
was not run for this change.

## Executor fixes, heavy QA rounds 1-2 and smoke runs 15-21 — 2026-10-15 (not accepted)

### Commits on `cpx/p61` since the handover (`78f2443`)

| Commit | Change |
|---|---|
| `40bad1e`, `26d0a8b` | QA fix-task route line is a launchable `[route …]` line; unsafe roots omitted; legacy lines launch. Fixed the run-14 critical (`2.1.FIX1-1`). |
| `2e0a78e`, `26d0a8b` | Integration checks skip the duplicate post-rebase slot reset; selection reads overlap the clean; `showFile` fails closed except git's explicit missing-path errors. |
| `a81bcef`, `edcfab9` | Owner amendment **A-6.1-2** (G8 bound measured/disclosed); idle oracle accepts the approval-time capacity re-init. |
| `541a0cb`, `d1983e6` | Opt-in `routing.roleFloor: "gated"` (v2, global, default strict) and its QA fixes. |
| `3df0230` | Role decision rows record `trace.riskSources`. |
| `ae84880`, `375a2d5` | Snapshot/grader failure reasons and git stage labels (diagnostics only). |
| `399e210` | A ledger graph observation for every nonempty batch, including metric-only. |
| `d2989e1`, `0ac00b8`, `7df9c76`, `85924bc` | Smoke driver: real deferred/held G2/G3 paths (fixture erratum: the ad hoc dispatch is `VERIFY:deferred`); restart recovery asserted by evidence; the root answers the post-restart stale-context wake with one status call; G9 compares counted attempts. |
| `422826e`, `22cad78` | Host contract **C16** (server-pid-only kill) and its R2-1 extension: 15/15 on OpenCode 2.0.26; observation **O16**. |
| `642f6de`, `66efe47` | Launcher-liveness recovery: a `running` child whose launcher is provably dead on this host and whose history shows no tool in flight is requeued at once; otherwise the 60 s probation. ADR 0007 D16. |
| `3d92c7e` | Slots are claimed in launch-priority order (base lookup awaited inside the claim). |

### Heavy QA

- **Round 1** (`40bad1e 2e0a78e a81bcef 541a0cb`): one major (gated floor without a reachable raise to heavy) and minors/nits; all
  fixed in `d1983e6` and `26d0a8b`.
- **Round 2** (`541a0cb..3d92c7e`, 14 commits): **one major, R2-1** (the dead-launcher fast path reset a slot a surviving tool
  process tree could still write in) — fixed in `66efe47`, premise proven by C16 (15/15) and O16. Round-1 fixes verified.
- **Deferred under the owner rule (round 2: fix major+ only):**
  - R2-2 (minor, `399e210`): a graph row per metric-only batch can exhaust the 16 MiB observation cap on large plans (fails closed,
    diagnostics only). Follow-up: a compact watermark row.
  - R2-3 (minor, `3d92c7e`): no `assertLive()` after the queued base lookup; a hung lookup (≤ 120 s) blocks queued claims.
  - R2-4 (minor, `85924bc`): G9 normalization would also excuse a lost attempt in the uninterrupted baseline. Follow-up: subtract
    only restart-checkpoint attempts and assert zero lost attempts in the baseline.
  - R2-5 (minor, hypothesis, `642f6de`): a future 2.x host that resumes orphaned children at boot would break the C16 premise; C16
    pins only 2.0.26.
  - R2-6..R2-10 (nits): open `\w*` risk-vocabulary terms logged verbatim; snapshot stage labels for `harden`/`finalize`; an
    always-true G9 session assertion; CHANGELOG/ROLES "global only" wording for `roleFloor`; the idle oracle accepts more than one
    pre-launch capacity re-init.
  - Pre-existing (not from these commits), recorded by the R2-1 design: an interrupted provisioning stage reruns while its install
    lock is already stale; reverify after a restart can overlap the dead server's verification tree; `resetSlotContents` swallows
    a failed reset.
- **Open product design item (resolved; see [Recovery dependency cycle fix and QA round (2026-10-15)](#recovery-dependency-cycle-fix-and-qa-round-2026-10-15)):** smoke 17 showed a recovery dependency cycle — a recovered task's reverify needs a
  grader, the grader needs a fresh orchestrator context, and the stale-context wake cannot be sent while recovery is in progress.
  It did not recur in runs 18-21 (no task was `verifying` at the kill). The grader-failure reason is now logged (`375a2d5`).

### Real-host smoke results (`npm run smoke:cpx:e2e`)

Runs 22–26 are appended at final QA, using the orchestrator shell and the real Claude Code host.
For runs 24–26, fixture triples are **makespan / g8Ratio / max idle-with-ready**.

| Run | Head | Result | Notes |
|---|---|---|---|
| 15 | `541a0cb` | 6 failed | Run-14 critical fixed; G2 driver defects, idle-oracle capacity re-init. |
| 16 | `d2989e1` | 6 failed | Metric-only commits not observed; restart resume refused; restart orphan probation. |
| 17 | `642f6de` | 3 failed | Throughput and resilience baselines green; restart wake not answered; recovery cycle (pnpm); snapshot git timeout (npm). |
| 18 | `375a2d5` | 3 failed | Restart runs complete; G9 attempt numbering; priority inversion in slot claims (py-pip). |
| 19 | `3d92c7e` | **green** (32 passed, 9 documented `unmeasured` skips) | |
| 20 | `3d92c7e` | **green** | |
| 21 | `66efe47` | **green** | First green after the R2-1 recovery change (restarts the consecutive count). |
| 22 | `66efe47` | **green** (32 passed, 9 documented `unmeasured` skips) | |
| 23 | `66efe47` | **green** (32 passed, 9 documented `unmeasured` skips) | Reported throughput: makespan 130.2 s, g8Ratio 1.51, max idle-with-ready 5.6 s. |
| 24 | `2b2cb58` | **green** (32 passed, 9 documented `unmeasured` skips) | Recovered-verification admission; ~1839 s. node-npm: 134.2 s / 1.47 / 6.6 s; node-pnpm: 141.3 s / 1.49 / 7.6 s; py-pip: 130.4 s / 1.52 / 6.3 s. |
| 25 | `2b2cb58` code (HEAD `9b8593f`, docs-only on top) | **green** (32 passed, 9 documented `unmeasured` skips) | ~1738 s. node-npm: 118.5 s / 1.35 / 6.5 s; node-pnpm: 128.6 s / 1.40 / 7.0 s; py-pip: 128.5 s / 1.50 / 8.8 s. |
| 26 | `2b2cb58` code (detached HEAD `9b8593f`) | **green** (32 passed, 9 documented `unmeasured` skips) | 6.1.4 clean checkout after `npm ci`; ~1854 s. node-npm: 125.9 s / 1.41 / 6.3 s; node-pnpm: 146.1 s / 1.53 / 8.0 s; py-pip: 132.4 s / 1.54 / 9.4 s. Third green under A-6.1-4. |

Evidence: `.cpx-logs\e2e-runNN.log`, `.cpx-logs\run23-evidence\`, `.cpx-logs\run24-evidence\`,
`.cpx-logs\run25-evidence\` and `.cpx-logs\run26-evidence\` are **untracked local scratch, not committed**.

Run 26 used the detached worktree `D:\git\omr-cpx-e2e` at `9b8593f`, after `npm ci` installed 357 packages.
npm blocked the optional `msgpackr-extract` install script (native acceleration with a JS fallback); the run was green
regardless. The worktree status was clean after the run, and the worktree was removed.

**Risk for the soak and 6.2:** run 26's py-pip max idle-with-ready reached **9.4 s** against the **10 s ceiling**,
up from the previous maximum of **8.8 s**. The margin is shrinking; the ceiling is unchanged.

Throughput (A-6.1-2, recorded): makespan 115-132 s in runs 19-21 versus 166 s in run 14; `g8Ratio` 1.32-1.47 (target ≤ 1.0, not met);
longest idle-with-ready episode ≤ 7.1 s (ceiling 10 s).

As coded in `test/smoke/helpers/cpx-g8-oracle.ts` and `test/smoke/cpx-e2e.smoke.test.ts`,
`bound = 1.3 × max(CP_eff, W_auth/p, ΣI_service)` and `g8Ratio = makespan/bound`;
the bound is met iff **`g8Ratio <= 1.0`** (`g8BoundMet = makespan <= bound`). The 1.3 factor is already in the bound;
ΣI_service is inside `max`, not added outside it. Under A-6.1-2 this is measured/disclosed, not an acceptance gate.

**Phase 6.1 is not accepted.** Outstanding: two more consecutive green runs at the final head; the mandatory subcases still listed as
`unmeasured` in the smoke; 6.1.4 (detached worktree, three green runs); 6.1.5 documentation; final heavy phase QA. G13 remains unmet.
(superseded by the Verdict section)

## Owner amendment A-6.1-3 — 2026-10-15

The owner amended the remaining evidence obligations on **2026-10-15**. This supersedes the earlier requirements for
three detached-worktree runs and new synthetic coverage of the `unmeasured` subcases; earlier sections remain dated
historical evidence. The plan's 6.1.3, 6.1.4 and amendment log record the decision. This is not phase acceptance.
**Narrowed by A-6.1-6:** only observable soak subcases remain in scope; see the owner amendments and Handoffs below.

- **6.1.4:** after `npm ci`, run `npm run smoke:cpx:e2e` **once**, not three times, in the detached worktree at the
  committed integration head (under the fallback, `cpx/p61`). This catches environment leakage on a clean checkout —
  dependencies outside the lockfile and untracked files — since runs **21–23** already proved the same code three
  consecutive times in the working worktree. Record the detached result separately; no detached pass is claimed here.
- The remaining `unmeasured` smoke subcases are **not accepted by new synthetic smoke scenarios**: G1 sampled/prior/off,
  G2 capture counters, G3 FAIL + forced C15 fallback, G5 frozen largest plans, G6 shared-tree read/search/run + deferred
  plugin verification, G8 idle telemetry completeness, G9 non-plan pending verification across restart, G11 usage-limit
  pause, and G12 full CI and smokes.
- Acceptance uses a **real-use soak of at least 5 working days**, with `MODEL_ROUTER_V2_OBSERVATIONS` enabled on real
  plans and offline analysis by `scripts\soak-analyze.mjs`. Each observable criterion (**G1, G2, G6, G8, G9**) requires
  **at least 3 observed occurrences and zero violations**.
- Criteria not observed in the window (expected: **G3, G11**) are **declared gaps**, disclosed in the **Phase 6.2 PR**
  alongside **G13 and G8's bound**. **G5 stays assigned to 2.3** and **G12's full matrix to 6.2**, as before.
- The soak also serves as executor dogfood evidence toward G13. **G13 remains unmet until the owner decides.** The
  owner may change the soak criteria; **absence of evidence is never a pass**.

The detached check, documentation, soak and final QA are separate evidence obligations. No completed soak, analyzer
result, fresh smoke result or phase acceptance is claimed by this amendment. No checks were run for this documentation
update; docs-drift validation belongs to the orchestrator.

## Recovery dependency cycle fix and QA round (2026-10-15)

The smoke-17 recovery dependency cycle (recorded above as an open product design item) is fixed by a change on
`cpx/p61` on top of `89b57f6`, together with the QA fixes below. Design:

- Recovery no longer re-verifies, or completes a finished child, inside the global barrier. Each becomes per-task
  `RecoveredWork` (task, attempt, nonce, state), registered in feed order; the task keeps its slot and leases while it waits.
- Recovered work is admitted after the barrier through the launcher's context gate, once any current router-tool context
  of the owning root exists. Until then the runtime requests the launch gate's wake (awaiting the first router call, or
  no context) even with no ready producer, also on a paused plan. Admission re-checks identity, context and leases under
  the task mutex and never spends a grader rerun.
- Each attachment has an `AbortController`. `closePlan` (dispose or adopt) aborts it: that attachment's graders and
  backoff are cut (verdict marked `cut`, never journaled, no attempt spent) and its pipelines are awaited before the
  writer closes. The process-wide verifier is not disposed.

Heavy QA verdict: **ship after major fixes**.

| ID | Finding | Status | Fix and regression test, or reason for deferral |
|---|---|---|---|
| M1 (major) | A cut observation leaked into the next same-process attachment: `observe` bound the cached observation to the attachment signal, so a cut cached a failed observation that the next attachment's re-verify graded as a counted `unverifiable`. | fixed | The observation is no longer bound to the attachment; only `observe`'s wait is. `verify-plan-task.test.ts`: "M1: an attachment cut during observe caches no failed observation; the next attachment grades the real one without begin". |
| m1 | The `closePlan` wait for attachment work is not bounded by `PLAN_TASK_ABORT_MS`; non-grader steps keep running. | deferred | Bounded in practice; no infinite wait with the production verifier. |
| m2 | An in-flight grader dispatch is not in the graders snapshot; `accept()` is abandoned instead of drained. | deferred | Draining needs a redesign of the abort contract; the overlap is with dying check processes of the cut attachment, and the slot is cleaned before the next attachment's checks. Follow-up. |
| m3 | `processEnd` diverted an end that no recovered work registered (closed attempt, or another work already registered) and skipped the end bookkeeping, so a forced capacity token leaked. | fixed | Only an open attempt's end carried by a registered `end` work is diverted; any other end takes the normal path (queued behind an active recovered pipeline without blocking the caller). `executor-runtime-recovery.test.ts`: "m3: an end that is not registered (its attempt already closed) is not diverted: its forced token is released and its binding evicted". |
| m4 | A lease-held task deferred all recovered end processing; a failed child's end was never recorded while the leases stayed held. | fixed | The admission hold covers only commit/verify work (a valid-slot re-verify, a completed child's end). "m4: a lease-held task's recovered FAILED child end is recorded at once and releases its token". |
| m5 | The re-bind map was the "adopted by recovery" marker; a failed `rebindChild` let the adopted child's end after the barrier run without a context (a counted `unverifiable`, the smoke-17 mode). | fixed | A dedicated `adoptedByRecovery` set, marked before the re-bind. "m5/m6: an adopted child's end after the barrier without a root context parks until admission (re-bind ok=false)". |
| m6 | No coverage for `parkWithoutContext` or for an adopted child's end after the barrier without a context. | fixed (tests) | "m6: a recovered re-verification whose context expires during cleanForChecks re-parks (parkWithoutContext) and verifies once on the next context"; "m5/m6: … (re-bind ok=true)". |
| m7 | No inbox item, counter or observation for parked recovered work. | deferred | Visibility, not correctness: the work is admitted on the owning root's next router call, and the plan line shows the launch block. Follow-up. |
| m8 | No `## [Unreleased]` CHANGELOG entry for a user-visible recovery change. | fixed | Fixed entry added (recovery deadlock and adopt cut), with the Added entry for `soak:analyze`. |
| nits | Stale comments: the `LaunchGate` wake rule (wakes also for unadmitted recovered work), the `PlanTaskVerdict` and verifier `dispose` docs (cuts also cover attachment cuts); log text now "cut by dispose or adopt"; a vacuous timer assertion in the D16 recovery test replaced by gate assertions that can fail; EXECUTOR.md wording ("any current router-tool context of the owning root") and the troubleshooting row (an owner whose session is gone runs `router_plan action=adopt`). | fixed | |
| nits | The unreachable `requeue-lost` guard in `applyFeed`; a spurious wake for lease-held recovered work; a stranded attempt-2 expectation in the recovery test (QA reference `:1310`); stale `recoveredWork` entries after an abort. | deferred | Deferred for this round by the orchestrator; follow-up. |

Orchestrator checks on the remediated tree: `npm run typecheck` exit 0; vitest on executor-runtime-coverage-b,
executor-runtime-recovery, executor-runtime-slots, v2-client, verify-plan-task, executor-runtime, executor-recovery,
verify-plan-task-observations and docs-drift: 9 files, 815 tests passed.

Heavy QA round 2 (remediation only) verdict: **ship**. Every round-1 fix verified; no new critical or major finding. Per
the project rule, round-2 minors and nits are deferred and recorded here:

| ID | Finding | Status | Reason for deferral |
|---|---|---|---|
| N1 (minor) | A new attachment's `observe` returns a cached observation that is still running; the old `snapshotTree` `git status` can briefly hold `index.lock` while the new attachment commits or runs `cleanForChecks`, giving a rare counted `commit-failed`/`verify-fail`. Fix: await the cached observation (cut-aware) before returning. | deferred | Narrow timing window after an adopt; follow-up together with m2. |
| N2 (minor, pre-existing) | A cut verification's `finally` drops the record and change-store ids, so the next attachment re-verifies through the fail-closed restart fallback (a counted `unverifiable` when the child committed itself or the perimeter would be planned). The M1 test re-calls `begin`, which the runtime never does. | deferred | Same behaviour as before this change; the CHANGELOG entry was narrowed so it does not claim otherwise. |
| N3 (minor) | An admission identity mismatch drops a parked `end` without its bookkeeping (queue row 34 closing a running dependent while an adopted child's end is parked), leaking the forced capacity token for the rest of the attachment. | deferred (later fixed on `cpx/pdf2-1`, round 4) | Bounded to one attachment; fix is to route `end` work through `processEndNow` unconditionally. |
| N4 (nit) | The background queuing added in m3 is effectively reached only by two tests that await `onChildEnd` before resolving the native end. | deferred | Correct and exactly-once per QA; document or revert with the test change later. |
| N5 (nit) | One unwrapped ~190-character line in `docs/EXECUTOR.md` (recovery paragraph). | deferred | Cosmetic. |
| N6 (nit) | `registerRecoveredWork` keys by the latest attempt rather than the end's `n`; safe under the ledger rule that the open attempt is the latest. | deferred | Make explicit with `if (a.n !== n) return` in the follow-up. |

The three consecutive green runs of 6.1.3 were earned at earlier heads; they must be re-earned at the new head that
carries this change. No smoke result is claimed in this section.

## Owner amendment A-6.1-4 — 2026-10-15

Commit `2b2cb58` (recovered verification admitted after the root context returns) changed `src\` after runs 21–23 were
green at `66efe47`, so 6.1.3's three consecutive greens must be re-earned at the new head. Owner decision: they are
**two consecutive green runs of `npm run smoke:cpx:e2e` in the working worktree plus the single 6.1.4 clean-checkout
run** (detached worktree, `npm ci`), which counts as the third. All three run the same code (commits between them may
touch only docs); any red resets the count.
The change touches only the executor recovery path and the plan-task verifier's attachment cut; runs 19–23 covered the
rest of the code. Recorded in the plan's amendment log.

**Count closed: runs 24, 25 and 26 are green on code `2b2cb58`.** Run 26 itself ran at detached HEAD `9b8593f`.
Between run 25 and run 26's evaluation, `6e643fd` (soak analyzer: `scripts/`, `test/unit/`, CHANGELOG) and `532f209`
(docs) landed, both after run 26 had started from `9b8593f`. Neither touches `src/` or anything the smoke loads;
run 26 did not run at either later head. This is the actual run attribution, not a claim that all intervening commits
were docs-only.

**A-6.1-5 (record only):** owner-approved out-of-plan additions are opt-in `routing.roleFloor: "gated"`
(`541a0cb`, `d1983e6`) and risk-origin recording in `trace.riskSources` (`3df0230`); v2-only, inert on v1;
no acceptance criterion changes. Mirrored in the plan's amendment log.

## Owner amendments A-6.1-6 and A-6.1-7 — 2026-10-15

- **A-6.1-6 (soak scope):** A-6.1-3 as written could never pass with current log formats. G6 shared-tree
  read/search/run and deferred plugin verification, and G9 non-held deferred pending verification across restart, are
  structurally unobservable; the analyzer in `6e643fd` reports them `not-observable`. The owner restricts the soak to
  observable subcases. These G6/G9 subcases are **DECLARED GAPS**, never passing, disclosed in the 6.2 PR alongside
  G3, G11, G13 and G8's bound. Instrumenting `src/` is a possible follow-up, not a 6.1/6.2 obligation.
- **A-6.1-7 (deferral rule):** owner-ratified on **2026-10-15**, superseding the plan's §0.7 fix-loop rules 1–2
  (`docs\plans\critical-path-execution-plan.md:322–323`) for Phase 6.1. The ratified wording and dispositions are
  recorded under Deferred findings. Both amendments are in the plan's amendment log.

## Findings

Final Phase 6.1 heavy QA: **accept after fixes (MA-1, MA-2)**; both are now closed below. Acceptance retains the
disclosures in Handoffs and Verdict.

- **MA-1 (major):** the report lacked §0.7's final findings/fixes/deferred/handoff/verdict structure and a consolidated
  disposition of open findings. These final sections supply it; dated progress sections above remain historical.
- **MA-2 (major):** soak-analyzer subcase statuses required correction; **fixed in `6e643fd`**.
- Final-QA minors **m-A, m-B, m-C, m-E, m-G, m-H** and prior open findings are consolidated below. Smoke attribution,
  the ratio target, **m-F**'s stale three-working-worktree-runs wording and the wake/wrapping nits are corrected here.

## Fixes

- Prior correction rounds fixed lease validation/enforcement, writer grants, CI execution scope, redaction and rebase
  diagnostics; executor/oracle rounds fixed reset proof, admission, idle closure and service accounting. Their commits
  and scoped evidence remain in the dated sections above; no new full-suite result is claimed.
- Executor rounds 1–2 fixed the gated role floor, QA fix routes and **R2-1**'s unsafe dead-launcher fast path
  (`d1983e6`, `26d0a8b`, `66efe47`), with C16/O16 evidence. The recovery-cycle fix is `2b2cb58`, including recovery
  round-1 **M1, m3–m6, m8** and the fixed nits recorded above; round 2 verified those corrections.
- The prior docs-only round fixed **MA-1**, recorded runs 22–25, corrected the same-code claim to
  runs 21–23 (with a bracketed correction in the plan's owner quote), stated the coded G8 formula/ratio threshold,
  annotated acceptance with A-6.1-4, recorded A-6.1-5, and fixed wake wording and **N5**'s line wrap. This closing
  update records run 26, A-6.1-6/A-6.1-7, final-code DoD evidence and the acceptance disclosures.
- **MA-2: fixed in `6e643fd`.** Not-observable subcases are distinguished from missing evidence and never pass.

### Final-code DoD evidence — 2026-10-15

Orchestrator-reported results at final code **`2b2cb58`**, not checks run by this documentation implementer:

- `npm run smoke:cpx`: **green, 5 files / 74 tests; 572 s**.
- Goldens (`test/golden`): **green, 13 files / 113 tests**.
- Scoped unit tests, docs-drift and `npm run typecheck`: **green**.
- `router_verify pending:true`: **no unverified delegations**.
- `smoke:v1`: **declared gap**, not a pass; the unavailable 1.x host is recorded in m-C and Handoffs.

No checks were run by this documentation implementer; the orchestrator runs docs-drift again after these closing edits.

## Deferred findings

**Owner-ratified on 2026-10-15 (A-6.1-7):** "After heavy QA round 2, only critical/major/blocking findings are fixed;
minors and nits are deferred with a recorded reason. Round-1 deferrals already recorded with a reason stand."
This supersedes the plan's §0.7 fix-loop rules 1–2 for Phase 6.1 (plan lines 322–323). Items marked
"no reason recorded; for owner decision in 6.2" remain unchanged and go to 6.2; no missing rationale is inferred.

This is the single consolidated disposition table for prior and final-QA open items. Local prefixes disambiguate
reused ids; the four deferred recovery nits and three pre-existing items receive local ids. **N5** is retained as fixed
in the prior docs round, and **MA-2** as fixed in `6e643fd`, not as a major deferral.

| ID | Origin round | Severity | Summary | Reason | Owner / next step |
|---|---|---|---|---|---|
| Scope-P3 | Product-correction R3 | P3 | `failingFiles` reporting is wrong for explicit `cwd` overrides. | no reason recorded; for owner decision in 6.2 | 6.2 owner: decide/report effective file paths. |
| Oracle-R3-P2-1 | Executor/oracle R3 | P2 | Oracle does not correlate verification candidate with checked candidate. | Bounded major/critical/blocking review; no fix requested under the recorded rule. | 6.2 owner: decide candidate correlation fix. |
| Oracle-R3-P2-2 | Executor/oracle R3 | P2 | Required-service coverage is component-level, not operation-level. | Bounded major/critical/blocking review; no fix requested under the recorded rule. | 6.2 owner: decide operation-level coverage. |
| Oracle-R3-P2-3 | Executor/oracle R3 | P2 | Abnormal service spans can include post-exit drain/kill tails. | Bounded major/critical/blocking review; no fix requested under the recorded rule. | 6.2 owner: decide lifecycle service boundaries. |
| R2-2 | Executor fixes R2 | minor | A graph row per metric-only batch can exhaust the 16 MiB observation cap. | Fails closed; diagnostics only; recorded major+ scope. | 6.2 owner: compact watermark row. |
| R2-3 | Executor fixes R2 | minor | No `assertLive()` after queued base lookup; a hung lookup blocks claims for ≤120 s. | no reason recorded; for owner decision in 6.2 | 6.2 owner: recheck liveness after lookup. |
| R2-4 | Executor fixes R2 | minor | G9 normalization can excuse a lost attempt in the uninterrupted baseline. | no reason recorded; for owner decision in 6.2 | 6.2 owner: subtract only restart-checkpoint attempts; assert zero baseline lost attempts. |
| R2-5 | Executor fixes R2 | minor (hypothesis) | A future host resuming orphaned children could invalidate C16's premise; only 2.0.26 is pinned. | no reason recorded; for owner decision in 6.2 | 6.2 owner: re-probe C16 on supported host upgrades. |
| R2-6 | Executor fixes R2 | nit | Open `\w*` risk-vocabulary terms are logged verbatim. | no reason recorded; for owner decision in 6.2 | 6.2 owner: decide vocabulary/log normalization. |
| R2-7 | Executor fixes R2 | nit | Snapshot stage labels omit `harden`/`finalize`. | no reason recorded; for owner decision in 6.2 | 6.2 owner: complete labels. |
| R2-8 | Executor fixes R2 | nit | G9 session assertion is always true. | no reason recorded; for owner decision in 6.2 | 6.2 owner: replace with an assertion that can fail. |
| R2-9 | Executor fixes R2 | nit | CHANGELOG/ROLES describe `roleFloor` as “global only”. | no reason recorded; for owner decision in 6.2 | 6.2 owner: reconcile wording with `tiers.json` and the global override. |
| R2-10 | Executor fixes R2 | nit | Idle oracle accepts multiple pre-launch capacity re-inits. | no reason recorded; for owner decision in 6.2 | 6.2 owner: decide stricter re-init cardinality. |
| R2-pre-1 | Executor fixes R2 / pre-existing | Not assigned | Interrupted provisioning reruns while its install lock is already stale. | Pre-existing; no reason recorded; for owner decision in 6.2 | 6.2 owner: assess install-lock recovery. |
| R2-pre-2 | Executor fixes R2 / pre-existing | Not assigned | Restart re-verification can overlap the dead server's verification tree. | Pre-existing; no reason recorded; for owner decision in 6.2 | 6.2 owner: assess verification-process lifetime/draining. |
| R2-pre-3 | Executor fixes R2 / pre-existing | Not assigned | `resetSlotContents` swallows a failed reset. | Pre-existing; no reason recorded; for owner decision in 6.2 | 6.2 owner: decide fail-closed reset handling. |
| Recovery-R1-m1 | Recovery fix R1 | minor | `closePlan` waits beyond `PLAN_TASK_ABORT_MS`; non-grader work continues. | Bounded in practice; no infinite wait with the production verifier. | 6.2 owner: decide bounded attachment shutdown. |
| Recovery-R1-m2 | Recovery fix R1 | minor | An in-flight grader dispatch is absent from the snapshot; `accept()` is abandoned, not drained. | Draining needs abort-contract redesign; overlap is with dying cut-attachment checks, and the slot is cleaned before new checks. | 6.2 owner: redesign/drain together with N1. |
| Recovery-R1-m7 | Recovery fix R1 | minor | Parked recovered work has no inbox item, counter or observation. | Visibility, not correctness; next root router call admits work and the plan line shows the block. | 6.2 owner: decide recovery visibility. |
| Recovery-R1-n1 | Recovery fix R1 | nit | `applyFeed` has an unreachable `requeue-lost` guard. | Orchestrator deferred; no reason recorded; for owner decision in 6.2 | 6.2 owner: reconcile with m-A before removing guards. |
| Recovery-R1-n2 | Recovery fix R1 | nit | Lease-held recovered work can request a spurious wake. | Orchestrator deferred; no reason recorded; for owner decision in 6.2 | 6.2 owner: suppress non-admissible wake. |
| Recovery-R1-n3 | Recovery fix R1 | nit | Recovery test has a stranded attempt-2 expectation (QA reference `:1310`). | Orchestrator deferred; no reason recorded; for owner decision in 6.2 | 6.2 owner: correct expectation. |
| Recovery-R1-n4 | Recovery fix R1 | nit | Aborted attachments leave stale `recoveredWork` entries. | **Fixed** on `cpx/pdf2-1` by merge `013a529`: abort clears the plan's recovered work. pdf2-1 round 4 (minor-1) also releases the cleared ends' bindings and tokens. | Closed; retained for traceability. |
| N1 | Recovery fix R2 | minor | Cached running observation's `git status` can briefly hold `index.lock` against a new attachment's commit/checks. | Narrow post-adopt timing window; follow-up together with m2. | 6.2 owner: await the cached observation, cut-aware. |
| N2 | Recovery fix R2 / pre-existing | minor | Cut verification drops record/change-store ids; restart fallback can cost a counted `unverifiable`. | Pre-existing behaviour; CHANGELOG claim was narrowed. | 6.2 owner: test runtime path without re-calling `begin`; decide retention. |
| N3 | Recovery fix R2 | minor | Admission identity mismatch drops a parked end's bookkeeping and leaks its forced token. | **Fixed** on `cpx/pdf2-1` in round 4 (minor-1): a parked end whose task moved on goes through `processEndNow`. That releases its token and binding, evicts its rebound binding and forgets its session (`docs\qa\critical-path-execution\pdf2-1.md`, Round 4). | Closed; retained for traceability. |
| N4 | Recovery fix R2 | nit | m3's background queuing is effectively reached only by two tests awaiting `onChildEnd` before native end. | Correct and exactly-once per QA. | 6.2 owner: document or revert with test change. |
| N5 | Recovery fix R2 | nit | Unwrapped recovery paragraph in EXECUTOR.md. | Cosmetic; fixed in this round, retained for traceability, not deferred. | Orchestrator: confirm docs-drift. |
| N6 | Recovery fix R2 | nit | `registerRecoveredWork` keys by latest attempt rather than the end's `n`. | Safe under the ledger rule that the open attempt is latest. | 6.2 owner: make `if (a.n !== n) return` explicit. |
| m-A | Final QA | minor | Lease-loss recovery can discard a finished end: `runtime.ts:3151/:3216` lack the `:3113–3117` guard, producing an uncounted lost attempt and relaunch. | no reason recorded; for owner decision in 6.2 | 6.2 owner: guard the lease-held requeue and regress a terminal end during interruption. |
| m-B | Final QA | minor | `2b2cb58` restart-while-verifying path has unit coverage only; no smoke restart point. | no reason recorded; for owner decision in 6.2 | 6.2 owner: deterministic restart-while-verifying smoke point. |
| m-C | Final QA | minor | Final-code `smoke:cpx` (5 files / 74 tests, 572 s), goldens (13 files / 113 tests), scoped units, docs-drift and typecheck are green; `router_verify pending:true` reports no unverified delegations. `smoke:v1` remains a declared gap. | Owner decision 2026-10-15: this machine has only Claude Code v2.0.29 (`opencode --version`), no 1.x executable for `scripts/smoke-v1-preflight.mjs`; no v1 smoke pass claimed. | 6.2 owner: fulfil `smoke:v1` in the full validation matrix with a 1.x executable. |
| m-E | Final QA | minor | Out-of-plan `routing.roleFloor: "gated"` and `trace.riskSources` need traceability/disclosure. | Owner-approved, v2-only and inert on v1; A-6.1-5 records them without changing acceptance. | Orchestrator / 6.2 owner: disclose both additions in the PR. |
| m-G | Final QA | minor | Analyzer imports test helpers at runtime and needs Node ≥22.13 for `stripTypeScriptTypes`. | no reason recorded; for owner decision in 6.2 | 6.2 owner: decide runtime dependency packaging and document the Node requirement. |
| m-H | Final QA | minor | Applicable executor fixes still need porting to `cpx/pdf2-1` and bounded re-check of `4070b22`. | no reason recorded; for owner decision in 6.2 | Orchestrator / 6.2 owner: fulfil `phase-6.1-handover.md`'s port obligation. |
| MA-2 | Final QA | major | Soak-analyzer subcase statuses needed correction. | Fixed in `6e643fd`; retained for traceability, not deferred. | Closed; preserve missing / not-observable distinctions in soak reporting. |

## Handoffs

- **Closing evidence:** run 26 completes 6.1.4 and A-6.1-4's three greens on code `2b2cb58`; MA-2 is fixed in
  `6e643fd`. Final-code DoD results are recorded above. The orchestrator runs docs-drift after these closing edits;
  this implementer claims no new check execution.
- **`smoke:v1` declared gap (owner decision 2026-10-15):** only Claude Code v2.0.29 is available via
  `opencode --version`; no 1.x executable meets `scripts/smoke-v1-preflight.mjs`. This is a **6.2 obligation** in the
  full matrix, not a pass or permanent waiver (m-C).
- **6.2 validation:** run the full suite with coverage, goldens, `smoke:v1`, all smokes and `router_verify pending:true`
  at the delivery head. Follow the plan's unavailable-v1-host rule if needed; absent evidence is not a pass. Add a
  deterministic restart-while-verifying smoke point for `2b2cb58`'s recovery path (m-B).
- **Soak pending, A-6.1-3 narrowed by A-6.1-6:** collect at least 5 working days of real plans with
  `MODEL_ROUTER_V2_OBSERVATIONS` enabled; analyse offline with `scripts/soak-analyze.mjs`. Only observable subcases
  of G1/G2/G6/G8/G9 are in scope; each observable criterion needs ≥3 occurrences and zero violations. G6 shared-tree
  read/search/run and deferred plugin verification, and G9 non-held deferred pending verification across restart, are
  `not-observable` **DECLARED GAPS**, disclosed alongside G3/G11, G13 and G8's bound, never reported as passing.
  Instrumenting `src/` is optional follow-up, not a 6.1/6.2 obligation. Preserve per-subcase statuses; missing evidence is not a pass.
  G5 remains with 2.3 and G12's full matrix with 6.2.
- **Soak / 6.2 timing risk:** py-pip max idle-with-ready rose from 8.8 s to **9.4 s** in run 26, leaving only **0.6 s**
  below the unchanged 10 s ceiling. Monitor the shrinking margin.
- **6.2 PR disclosures:** G13 remains unmet until the owner decides; **G8's bound was not met** (`g8Ratio` 1.35–1.54
  in runs 24–26, target `<= 1.0`; measured/disclosed under A-6.1-2). Disclose the pending soak and declared G3/G11
  and not-observable G6/G9 gaps, the `smoke:v1` gap, deferred findings per the table, and the owner-approved out-of-plan
  `roleFloor: "gated"` / `trace.riskSources` additions (v2-only, inert on v1).
- **Cross-phase obligation:** port applicable executor fixes to `cpx/pdf2-1` and finish its bounded heavy QA re-check
  of `4070b22`, as required by `phase-6.1-handover.md`. The consolidated table supplies the 6.2 owner-decision queue;
  A-6.1-7 ratifies the deferral rule on 2026-10-15 without changing entries that have no recorded reason.

## Verdict

Phase 6.1 ACCEPTED on 2026-10-15 at code `2b2cb58` (report head: this commit), subject to the disclosures listed in
Handoffs: G13 unmet; G8 bound not met (g8Ratio 1.35-1.54 in runs 24-26, target <= 1.0; A-6.1-2 measured/disclosed);
soak pending (A-6.1-3 narrowed by A-6.1-6) with declared gaps G3, G11 and the not-observable G6/G9 subcases;
smoke:v1 gap; deferred findings per the table.
