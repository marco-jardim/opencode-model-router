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

pending 6.2.QA

## Deferred findings

pending 6.2.QA

## Handoffs

pending 6.2.QA

## Verdict

pending 6.2.QA
