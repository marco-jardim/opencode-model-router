# Global QA Report — Enforced Delegation Architecture

> **Phase:** Wave 5 / Phase 5.2 (global adversarial Senior-QA)
> **Scope:** The three-layer enforcement-and-verification architecture (Layer 1 hard-block guard, Layer 2 independent acceptance gate, Layer 3 quality-escalation ladder) and both usage modes (A on-the-fly, B plan-annotation).
> **Method:** Adversarial review against the global acceptance criteria (GA-1..GA-8, plan §6.1) and the global Definition of Done (§6.2), plus the eight break-it attempts in plan §5.2 (a–h). Evidence is the offline test suite (deterministic, no live model) plus the gated real-OpenCode smokes.
> **Build under review:** 38 test files, 843 tests green; `npx tsc --noEmit` exit 0; coverage gate on and passing; 35 golden snapshots byte-identical.

---

## 1. Global acceptance criteria

| GA | Criterion | Status | Primary evidence |
|----|-----------|--------|------------------|
| **GA-1** | `enforcement.mode:"off"` (default) is byte-for-byte identical to the pre-plan plugin | **PASS** | 35 golden snapshots unchanged across the whole feature; `test/unit/overhead-ga1.test.ts` (off === explicit-false, no DoD markers); off-mode no-ops in `test/integration/guard-before-wiring.test.ts` + `trajectory-wiring.test.ts` |
| **GA-2** | Under `"enforced"`, a budget/redundancy/self-script/pre-deliverable violation is hard-blocked | **PASS** | `test/unit/guards.test.ts`, `test/integration/guard-enforcement.test.ts`, `guard-before-wiring.test.ts`; **live**: `test/smoke/guard-hardblock.smoke.test.ts` (a real subagent hard-blocked on `read_budget`) |
| **GA-3** | A delegation is not accepted until an independent grader (≥ producer tier) or a deterministic check returns PASS; a lying `DONE` is rejected | **PASS** | `test/unit/gate.test.ts` (#6/#8/#9), `test/unit/checker.test.ts` (calibration set), `test/integration/layer2-wiring.test.ts`, `test/integration/modeA-e2e.test.ts` (T1) |
| **GA-4** | A FAIL retries then escalates, never silently returns a FAIL, bounded by attempts + cost ceiling; `floorTier` honoured | **PASS** | `test/unit/ladder.test.ts` (property-based termination, 60 seeds), `test/integration/ladder-wiring.test.ts`, `modeA-e2e.test.ts` (T3 honest give_up) |
| **GA-5** | The full loop works for on-the-fly **and** plan-annotation, sharing one gate/ladder path | **PASS** | `test/integration/modeA-e2e.test.ts` + `modeB-e2e.test.ts` (B3 proves `parseDoDFromAnnotation` and `parseDoDFromDispatch` converge on the same normalized DoD → same gate) |
| **GA-6** | Trivial dispatches bypass verification/escalation overhead | **PASS** | `test/unit/gate.test.ts` (#2/#2b/#2c), `modeA-e2e.test.ts` (T4 grader uncalled), `test/integration/proportional-downgrade.test.ts` |
| **GA-7** | Off adds 0 tokens; on adds a measured, bounded amount | **PASS** | `test/unit/overhead-ga1.test.ts`: **+798 chars (~200 tokens)** when on, **0** when off, injected only when enforcement on; within the documented ≤4000-char budget |
| **GA-8** | Every enforcement primitive is confirmed by the spike and re-confirmed by a live smoke | **PASS** | `docs/adr/0000-spike-results.md` (capabilities A/B/C empirically confirmed); live smokes re-confirm load + Layer-1 abort after each major wiring change |

---

## 2. Adversarial attempts (plan §5.2 a–h)

Each row is an active attempt to break an invariant.

| # | Attack | Outcome | Why it fails / evidence |
|---|--------|---------|-------------------------|
| **(a)** | Make off-mode behave differently from pre-plan | **Could not** | The guard before-hook, the verify-dispatch, and the DoD prompt section all early-return when the resolved mode is `off`; no guard/gate state is created. Golden snapshots are byte-identical; `overhead-ga1` asserts the off contract. |
| **(b)** | Get a FAIL silently accepted | **Could not** | `accept()` returns `accepted` **only** when `verdict.pass === true`; the ladder returns `accept` **only** when `pass === true`; every verifier and both wirings are fail-closed (errors → non-passing verdict, never acceptance). Evidence: `gate.test.ts` #6/#8/#9/#11/#12, `ladder.test.ts` invariants, `modeA-e2e` T3. |
| **(c)** | Self-grade, or use a grader weaker than the producer | **Could not** | The grader is always a **fresh** session; `runChecker` fail-closes when `graderSessionID === producerSessionID` or is empty; `atLeastProducerTier` raises the grader to ≥ producer (and ≥ `minGraderTier`). Evidence: `gate.test.ts` #10, `checker.test.ts`. |
| **(d)** | Cause infinite escalation / cost blow-up | **Could not** | `nextAction` checks `maxTotalAttempts` and the cost ceiling **before** retry/escalate (provable termination, property-tested over 60 random seeds); the delegate loop adds an **independent** `safetyMax` cap; cost ceiling = `firstAttemptCost × multiple`. Evidence: `ladder.test.ts`, `ladder-wiring.test.ts` C. |
| **(e)** | Leak a secret into an observation / forcing note / grader prompt / scorecard / log | **Could not** | `scrubText` redacts Anthropic/OpenAI/AWS/Bearer/`key=value` secrets and is applied at every emission boundary; the grader prompt scrubs the artefact text, changed-file paths, and declared outputs; the scorecard is counts-only. Evidence: `security-scrub.test.ts`, `scrub.test.ts`. |
| **(f)** | Trigger a false self-script block on a legitimate code/script-authoring task | **Could not** | `blockScriptWrites` defaults **false**, so writing `.ts/.js/.py/.sh` source is never blocked by default; the always-on signal is only bash **ad-hoc execution** (heredoc / `node -e` / `cat >` / `bash -c`); `deliverableIsScript`/`deliverablePath` exempt declared script deliverables. Evidence: `guards.test.ts` source-write cases. |
| **(g)** | Stall a live Mode-A session by demanding a DoD | **Could not** | Mode A **auto-infers** a DoD (`requireExplicitDoD` defaults false) so a session never stalls waiting for one; trivial+inferred dispatches bypass entirely; the gate never blocks *production*, it only judges the *result* (Option i appends an advisory note; Option ii returns an honest `unmet`). |
| **(h)** | Race two concurrent subagents through the gate | **Isolated (now tested)** | All per-session state is keyed by `sessionID` in per-instance Maps (`sessionStore`, `guardStore`, `trajectoryStore`, `changedFileStore`); `verifyMutex` serializes whole-repo deterministic checks. A gap was found — **no interleaved two-session test existed** — and was **closed** by adding `test/integration/concurrency.test.ts` (per-session read-budget isolation; self-script block isolation; independent blockability). |

---

## 3. Findings

| ID | Severity | Finding | Resolution |
|----|----------|---------|------------|
| F-1 | Medium | No automated test exercised two interleaved subagent sessions (plan §5.6 / risk R11 required one). | **FIXED** — added `test/integration/concurrency.test.ts` (3 tests). Proves guard state and self-script enforcement are isolated per session under interleaving. |
| F-2 | Low (accepted) | The deterministic `run` allowlist gates the **binary**, and now also blocks interpreter eval-flags (`node -e`, `python3 -c`, …), but an `npx <interpreter> -e` wrapper is not detected (only the first token's basename is inspected). | **Accepted / documented.** DoD check commands are author-controlled (orchestrator / plan / inference), never written by the graded producer; Layer-1 independently blocks producer self-scripts. Revisit if check authorship ever becomes untrusted. |

No open findings remain. No silent-accept, secret-leak, self-grade, non-termination, or off-mode-drift path was found.

---

## 4. Global Definition of Done (§6.2) status

- [x] Phase 0.0 spike report committed; architecture (Option ii buildable) recorded; GA-8 satisfied.
- [x] All wave/phase DoDs green.
- [x] Coverage gate on: ≥90% branch on `guard/`, `verify/`, `escalate/`, `telemetry/`; ≥80% lines overall on extracted modules; characterization + property + (gated) smoke suites green.
- [x] `enforcement.mode:"off"` regression green (GA-1).
- [x] GA-2..GA-6 have passing fake-harness tests; Layer-1 has a passing **live** smoke; Layer-2 has a deterministic real-factory proof + a best-effort gated live smoke.
- [x] No secret leakage in any emitted string incl. grader prompts (security test).
- [x] Docs updated: README section, `docs/ENFORCEMENT.md`, `docs/VERIFICATION.md`, `docs/ESCALATION.md`, `docs/CONFIG_REFERENCE.md`, `docs/ENFORCEMENT_PRESETS.md`, `docs/MIGRATION.md`, `docs/LINE_REFERENCES.md`.
- [x] `tsconfig.json` present; `npm run typecheck` and `npm test` green; tests confirmed excluded from the published package (`npm pack --dry-run`).
- [x] Global Senior-QA review completed; all findings resolved; this report committed.
- [ ] **Deferred to Phase 5.3 (release):** version bump + CHANGELOG entry + opt-in default decision (ship `off`).

---

## 5. Sign-off

All global acceptance criteria (GA-1..GA-8) are satisfied and zero adversarial attempts succeeded. The one gap (F-1, concurrency coverage) was closed during this review; F-2 is an accepted, documented residual. **The architecture passes global QA and is ready for Phase 5.3 (release).**

The default ship state remains `enforcement.mode:"off"` — installing/loading the plugin is byte-identical to the pre-plan behaviour, and enforcement is opt-in via `enforcement.mode`, `MODEL_ROUTER_ENFORCE=1`, or `/router enforce`.
