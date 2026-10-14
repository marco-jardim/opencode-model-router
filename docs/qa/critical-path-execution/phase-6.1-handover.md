# Handover prompt — Phase 6.1 (fallback) continuation

## Starting OpenCode after the reboot (pwsh)

New session in the p61 worktree:

```pwsh
$env:OPENCODE_CONFIG_DIR = "$env:LOCALAPPDATA\omr-cpx\opencode-config"; $env:XDG_DATA_HOME = "$env:LOCALAPPDATA\omr-cpx\xdg-data"; $env:XDG_STATE_HOME = "$env:LOCALAPPDATA\omr-cpx\xdg-state"; $env:OPENCODE_V2_BIN = "C:\Users\Marquinho\AppData\Local\omr-cpx\bin\opencode2-2.0.26\opencode.exe"; & $env:OPENCODE_V2_BIN --standalone D:\git\omr-cpx-p61
```

Or resume the previous orchestrator session instead (same environment, add `-s`):

```pwsh
$env:OPENCODE_CONFIG_DIR = "$env:LOCALAPPDATA\omr-cpx\opencode-config"; $env:XDG_DATA_HOME = "$env:LOCALAPPDATA\omr-cpx\xdg-data"; $env:XDG_STATE_HOME = "$env:LOCALAPPDATA\omr-cpx\xdg-state"; $env:OPENCODE_V2_BIN = "C:\Users\Marquinho\AppData\Local\omr-cpx\bin\opencode2-2.0.26\opencode.exe"; & $env:OPENCODE_V2_BIN --standalone D:\git\omr-cpx-p61 -s ses_ece022575ffeHA4667snTmxoLu
```

The private config/state directories (`opencode-config`, `xdg-data`, `xdg-state`) and `OPENCODE_V2_BIN` are not set at
user scope; they must be set in the launch command, as above.

## Archived scratch data (2026-10-14, before the reboot)

`C:\Users\Marquinho\AppData\Local\omr-cpx\archive-20261014\`:
- `p61-cpx-logs\` — copy of `D:\git\omr-cpx-p61\.cpx-logs\` (smoke logs run 7–14, run evidence, parsed timelines; the
  original also stays in place, untracked).
- `temp-omr-cpx-e2e\` — raw smoke evidence from `%TEMP%\omr-cpx-e2e\`.
- `temp-omr-evidence\` — `%TEMP%\omr-evidence\` (`OMR_SMOKE_EVIDENCE_DIR`).
- `temp-opencode-model-router-trajectory\` — router outcome/decision/timing logs from
  `%TEMP%\opencode-model-router-trajectory\` (the live copy stays in `%TEMP%`; restore from here if `%TEMP%` was cleaned).
- `handover-df2.md` — copy of the live DF-2 handover.

Paste everything below the line into the new session.

---

You are resuming the critical-path execution plan for the opencode-model-router plugin, Phase 6.1, running under the
owner-approved DF-2 **fallback** (Phase 6.1 runs normally in a worktree; G13 is recorded as unmet in the Phase 6.2 PR).

## Environment

- Working directory / work root: `D:\git\omr-cpx-p61` (git worktree, branch `cpx/p61`, HEAD `1469639`, tracks
  `origin/cpx/p61`). Main checkout: `D:\git\omr-cpx-main` (do not edit). Platform win32, shell pwsh 7.
- Binding plan: `D:\git\omr-cpx-p61\docs\plans\critical-path-execution-plan.md` (§0, §0.9 pre-flight, §0.14, Phase 6.1
  at ~3953–4095, G1–G13 at ~4218–4230, amendment log ~4592). Phase report:
  `docs\qa\critical-path-execution\phase-6.1.md`. Live handover/history: `C:\Users\Marquinho\AppData\Local\omr-cpx\handover-df2.md`.
- Repo rules: `D:\git\omr-cpx-p61\AGENTS.md` (OpenCode v1 is feature-frozen: new behaviour v2-only and inert on v1;
  typecheck; docs-drift pins never weakened; CHANGELOG `## [Unreleased]`; Conventional Commits with `Refs #109`).
- Working tree is clean except the untracked scratch directory `.cpx-logs\` (logs/evidence; never commit it).
  A copy of this handover is committed as `docs\qa\critical-path-execution\phase-6.1-handover.md`; scratch data is
  archived in `C:\Users\Marquinho\AppData\Local\omr-cpx\archive-20261014\`.
- **Never read, write or execute anything in `D:\git\opencode-model-router` or `D:\git\opencode-model-router-cross-repo`.**

## Owner rules (binding)

- Owner communication in Portuguese; code, docs, commits and QA reports in English. No flattery, radical candor.
- Iterate continuously; stop only for blocking or critical problems.
- Pre-flight before each phase; fix findings, or document them when the plan assigns them to a later phase.
- Heavy adversarial senior QA after each phase/implementation (QA is always heavy tier). Rounds 1–2 on the same
  implementation: fix every finding. After round 2: fix only major/critical/blocking; defer the rest explicitly.
- Commit often (atomic, explicit paths, `git diff --cached --check`, Conventional Commits + `Refs #109`).
  **Never** add Co-Authored-By/AI attribution to commits or PRs; tell every delegate the same.
- Delegate through the model-router roles (atomic tasks; heavy for complex coding/design/QA). If the router blocks the
  same work repeatedly (budget guards, leases, refusals, provider usage limits), do the blocked read/edit/run yourself.
- Never run the full test suite before the Phase 6.2 pre-flight; run only tests the change touches, in parallel batches.
- Never weaken assertions, add skips, raise G8 bounds or timeouts to hide a stall. Bugfix rule: fix minimally.
- Linear is not used (plan §, checked); GitHub issue reference is `#109`.

## Owner decisions in force (2026-10-13/14)

- DF-2 fallback chosen; executor dogfood not used for 6.1; G13 unmet, disclosed in the 6.2 PR.
- G6 lease registry is process-wide (`globalThis`/`Symbol.for`), restore-once; malformed entries fail closed.
- M39 amended: declared writers with no diff fail (bounded retry → park) in every verification mode.
- Read-only, opt-in v2 observations approved (`MODEL_ROUTER_V2_OBSERVATIONS=<dir>`), including intrinsic service spans.
- **G8 strict**: authored fixture durations (no 0.1 scale), no additive slack, idle-with-ready ≤ 10,000 ms.
- **G8 idle predicate A** confirmed: ready work + provider capacity; waiting for a physical slot counts as idle.
- **Watchdog derived from the contract** (replaces fixed 90 s): 60 s setup, then
  `1.3 × max(CP, W/p, entries × 5 s) + 60 s`, ceiling 300 s/host; aggregate 2,790 s.
- **Amendment A-6.1-1** (recorded in the plan): `makespan ≤ 1.3 × max(CP_eff, W_auth/p, ΣI_service)`; CP_eff = longest
  path over the pre-run compiled DAG (incl. phase gates) with authored work + intrinsic verification/integration/
  phase-suite service only; waits, queueing, preparation, launch, cold start, idle and driver holds excluded; missing or
  ambiguous service evidence fails closed; batch entry service assigned to each member (antichain), counted once in ΣI.
  Run 13 remains a historical failure (makespan 173.8 s vs legacy 107.4 s; generous A-6.1-1 ceiling ≤ 159.9 s).
- Throughput fixture uses the product default batching; resilience keeps `batchMax: 1`.
- The three historical `binding: unknown` child sessions (09–12 Oct) are kept and never reused.

## Work completed in the previous session (commits since `153ec6e`)

Lease sharing/fail-closed (`1d8d293`, `4f98c05`); CI-slot suites and slot command resolution (`be3e4a6`, `7cdb4f4`);
inferred/explicit writer routing (`f075c96`, `7cdb4f4`); no-diff policy + gate reconciliation (`ac61c34`); rebase error
preservation + redacted journal diagnostics (`ffb0475`, `6c39d94`); configured-check scoping and attribution
(`f802e9a`, `4b81d96`); v2 observations + fixes (`b16241b`, `357c3b1`, `c6755a4`, `ceaa0f1`, `7e5dd2e`, `9ef5d09`,
`8d95663`, `0268f75`); executor timing binding incl. late adoption (`1d5f32c`, `39a1293`); idle metric single clock read
(`eec5f1d`); single slot reset, priority slot admission, release-driven scheduling, reset proof withheld after
provisioning, fallback reset verified after install, physical reservations (`5b23547`, `7c57fca`, `7a9c3d9`); smoke driver,
strict G8, derived watchdog, pytest prerequisite, idle episode oracle (`73cce9f`, `cbdbd3f`, `2381219`, `9e079d8`,
`d1118a2`, `6edce3c`); amended G8 oracle `test\smoke\helpers\cpx-g8-oracle.ts` (`681966e`); docs/QA records
(`121970e`, `183b984`, `a066f4d`, `20fd7b1`, `b9155d3`, `1469639`).

Heavy QA on the executor/observation/oracle work: rounds 1–2 fixed; **round 3 (bounded) clean at
major/critical/blocking**. Deferred P2s (no fix requested): G8 oracle does not correlate the verification candidate with
the checked candidate; required-service coverage is component-level, not operation-level; service spans may include
post-exit drain/kill tails on abnormal process lifecycles. Native grading without provider-attempt events is emitted as
`service-unattributed` and makes G8 evidence insufficient by design.

## Current state — STOPPED on a critical finding (smoke run 14)

Run 14 (`.cpx-logs\e2e-run14.log`, evidence `.cpx-logs\run14-evidence\`): 6 failed / 11 passed / 9 skipped, 1441.6 s.

1. **CRITICAL (all three resilience runs):** the QA-generated fix task `2.1.FIX1-1` fails at launch with
   `route line cannot be rendered: the task's route line is not one well-formed [route ...] line`, is retried, fails again,
   and the phase 2.1 circuit breaker raises a `critical` inbox item (`B-2`). Likely cause (unconfirmed): the writer-route
   reconciliation added in `f075c96`/`7cdb4f4` (src/executor/compile/index.ts, src/executor/create.ts) produces an
   unrenderable route for tasks created at runtime from QA findings; tests never covered QA-fix tasks.
2. **Throughput (npm, pnpm):** the amended G8 oracle throws `G8 service oracle: unknown service kind/component`.
   Run-14 observation rows include `stage` values such as `command-planning`, `process-preparation`, `git-preparation`,
   `git-result`, `checkout-and-selection`, `verification-slot`, `grader-startup`, `change-capture`, `slot-snapshot`,
   `repo-lock`, `integration-queue`, `checkout-reset`, `lock-validation`, `integration-checkout`, `cas`, `merge`,
   `background-lane`, `ci-slot` across components verify/rebase/checks/fast-forward/phase-suite. The oracle's accepted
   kind/component/stage set (and/or the field it reads for `kind`) does not match the producer schema in
   `src\executor\observations.ts` — reconcile against the schema, keep fail-closed for genuinely unknown kinds.
3. Throughput py-pip and remaining resilience failures: not yet diagnosed for run 14.

The owner was asked whether to proceed with: (a) regression test with a QA-generated fix task, then fix route rendering;
(b) align the service observation names with the G8 oracle; (c) heavy QA on both, then smoke run 15. **Confirm with the
owner before resuming** (the stop was due to a critical item).

## How to run things

- Scoped unit tests: run in the orchestrator shell (router `router_run` refuses arguments to the `test` script):
  `npx vitest run <files>`; smoke helpers: `npx vitest run --config vitest.smoke.config.ts <files> -t "<filter>"`.
  `test/smoke/**` is excluded from the default config.
- Typecheck: `npm run typecheck`. Docs pins: `npx vitest run test/unit/docs-drift.test.ts` (123 tests).
- Real smoke (orchestrator shell, background; 20–46 min):
  ```pwsh
  $env:OMR_SMOKE_EVIDENCE_DIR = Join-Path $env:TEMP 'omr-evidence'
  $env:CPX_E2E_PYTHON = 'C:\Users\Marquinho\miniconda3\python.exe'   # py -3 (3.14) lacks system pytest
  npm run smoke:cpx:e2e *> .cpx-logs\e2e-run15.log
  ```
  `OPENCODE_V2_BIN` is set by the launch command to
  `C:\Users\Marquinho\AppData\Local\omr-cpx\bin\opencode2-2.0.26\opencode.exe` (check `$env:OPENCODE_V2_BIN` first).
  The plan's convention is to `Remove-Item Env:OPENCODE_CONFIG_DIR -ErrorAction SilentlyContinue` in the shell that
  runs a smoke, so the smoke host does not inherit the orchestrator's private config.
  Evidence lands in `%TEMP%\omr-cpx-e2e\<uuid>\`; copy it into `.cpx-logs\runNN-evidence\` before it is cleaned.
  Baseline JSON is single-line and large; parse with `ConvertFrom-Json -Depth 100` and write pretty extracts for agents.

## Router/delegation lessons

- Delegates often fail verification for "producer delta" attribution when other agents edit in parallel; validate
  by direct diff + scoped tests instead of re-dispatching. Do not `router_verify` a handle while the same files are still
  being edited.
- Pattern that works: delegate writes the regression first → parent runs it to confirm red → delegate implements →
  parent runs green + typecheck → parent commits with explicit paths.
- File edit leases serialize implementers per file; plan parallel work on disjoint files.
- Delegates' read-only budgets can trip; give `CAP:none` with a reason for heavy work. Hidden/ignored `.cpx-logs` paths
  must be read by absolute path (globs hide them).
- The provider once returned `subscription_sharing_usage_limit_exceeded`; if it recurs, do the work directly and note
  that heavy QA needs a delegated reviewer.

## Remaining Phase 6.1 / 6.2 obligations

- 6.1.3: three consecutive green `smoke:cpx:e2e` runs with G1–G12 asserted; the seven mandatory missing smoke subcases
  (G1 sampled/prior/off; G2 deferred exactly-once in fg/bg/user-bg; G3 FAIL + forced C15 fallback; G6 shared-tree
  read/search/run + deferred plugin verification; G8 idle completeness — done via episode oracle; G9 non-plan pending
  verification across restart; G11 usage-limit pause) per the architect design recorded in the session (G5 → 2.3,
  G12 full matrix → 6.2).
- 6.1.4: detached worktree `D:\git\omr-cpx-e2e` at the committed integration head, `npm ci`, three green runs there,
  Appendix D metrics in the phase report, remove the worktree.
- 6.1.5: EXECUTOR.md safety model/Windows notes/troubleshooting/metrics/owner checklist; README "Executing plans";
  OPENCODE_V2/ROLES cross-links; ADR 0007 Accepted; plans README done; drift pins (every command, action and config key
  in code appears in docs/EXECUTOR.md).
- 6.1.QA heavy (fixed commit), fixes, push, merge Phase 6.1 into `cpx/main`.
- Port applicable executor fixes to `cpx/pdf2-1` and finish its bounded heavy QA re-check of `4070b22`.
- Phase 6.2: pre-flight (full suite + coverage once, all smokes, `smoke:v1` if available), measured results, global
  heavy QA, PR into master (G13 recorded unmet), cleanup.
