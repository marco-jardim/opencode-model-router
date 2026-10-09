# Phase P1.5 — guard profiles, budgets and verification text (issue #84)

| Item | Value |
|---|---|
| Plan | `docs/plans/role-tier-assurance-delegation-plan.md` §2.6, §2.9, §5 P1.5, §9 R6/R7 |
| Branch / worktree | `rta/p15` in `D:\git\omr-rta-p15` |
| Commits | `9c486e5`, `fb185db`, `6c59af8`, `f73edad`, `93dedfc` (+ this report) |
| Verdict | **PASS** (QA round 3) |

## Pre-flight

| Check | Result |
|---|---|
| Worktree | `D:\git\omr-rta-p15` on `rta/p15`, from `origin/rta/main` @ `2ab0c40`; `origin/rta/main` merged before work (fast-forward to `66dcdff`, brings `RouteLine.root`) |
| `npm ci` | ok |
| Typecheck | 0 errors |
| Baseline | `vitest related` over the six P1.5 files: 71 files / 2180 tests passed |
| Spikes read | S4, S5, S10 (+ P-4, P-5, P-15, P-16) |
| Ownership | no conflicts; R7 grants used: `src/verify/gate.ts` (accept mapping), `src/guard/store.ts`, `src/router/sessions.ts` (cap getters), `src/index.ts` (≈1724, ≈1732, ≈1758 pass-through lines), `src/escalate/ladder.ts` (2-9), `src/verify/wiring.ts` (2-4) |
| Base checkout | `D:\git\opencode-model-router` clean before and after |

## Implementation

### Commits

| Sha | Purpose |
|---|---|
| `9c486e5` | Contract: `GuardProfile {kind, budget, cumulative}`; `buildGuardPolicy(cfg, tier, _profile?)` source-compatible (T1.5.0) |
| `fb185db` | T1.5.1 reader profile, refused calls uncharged; T1.5.2 role budgets, `budgetExhausted`; goldens |
| `6c59af8` | T1.5.3 whole criteria, header strip (P-15), router directives not gradable, progress note → incomplete; T1.5.3a header work root; goldens |
| `f73edad` | QA round 1 fixes (QA-P15-1-1 … 1-12) |
| `93dedfc` | QA round 2 fixes (QA-P15-2-1 … 2-11; 2-8 by amendment R7) |

### Behaviour changes (before → after)

| Area | Before | After |
|---|---|---|
| E6 reader profile | 3 consecutive non-producing calls → `read_budget` denial / `[⚠ GUARD:read_budget]` footer for every dispatch | No read/draft denial or footer for: the read-only `fast` tier (#78), routed `class=review\|recon\|search` (dispatch registry), `CAP:none` + `reason:` (session-store cap per dispatch round, `getCap`), reader roles. Producer profile unchanged |
| E6 refused calls | Charged to the budget and recorded as executed by the repeat check ("DENIED: you already ran this exact read") | Not charged, not recorded; refusals capped (`denied_cap`) when refused ≥ min(budget, `REFUSAL_CAP` = 10) **and** executed + refused ≥ budget |
| E6 wording | Readers told "take a producing action (write/edit)" | Readers: "emit your final answer"; `redundant_read`: "continue with a different call or finish" |
| E7 / role budgets | Every delegation 25 / ×3 | `buildGuardPolicy(cfg, tier, profile?)`: role total from `roleGuardProfile` (`budget=` raise-only, ≤ 2×), cumulative ×3, `NEED MORE: budget` + progress summary on exhaustion; a resumed round takes its own budget. Tier agents keep 25 / ×3 and their message |
| Budget signal | none | `budgetExhausted(sid)` = enforced stop (`iteration_cap` / `cumulative_iteration_cap` / `denied_cap`) in the current round, never advisory; `captureBudget(sid, readCapReached?)` snapshot for the gate |
| E8 criterion | First line cut at 120 chars (`dod.ts:62`), header's first line was the criterion ("…re-dispa") | Router header stripped through the first `\n\n---\n\n` (v1 and v2-translated); whole-line `CAP:`/`VERIFY:`/`VERIFY_WAIT:` (wrappers/punctuation allowed), `reason:` with a CAP line, `[route …]`, `[router]` skipped; first task line whole, or its leading whole sentences within 4000 code points |
| E8 grader budget | No budget, no omission | Whole criteria within 4000 code points; overflow named "n criteria omitted", not graded; a partial pass is unverifiable with a caveat; nothing fits → unverifiable |
| E8 incomplete | Progress notes graded and failed; next-tier hint | Contract followers' progress notes (final-sentence first-person finish/continue, no deferral/conditional/question) and budget stops (enforced stop, or a `NEED MORE: budget` claim the snapshot backs) → structured `incomplete` verdict: unverifiable, never accepted, no next tier, no evidence; rendered `[router ⚠ INCOMPLETE]`; delegate ladder gives up with a resume reason |
| T1.5.3a | `Working directory:` = project directory | Names the route line's `root=` when present (`routeLineRoot`, wired at `index.ts` ≈1732); byte-identical otherwise |

### Changed existing tests (§2.9 goldens, round 0)

| Test | Before | After |
|---|---|---|
| `test/integration/guard-enforcement.test.ts` test 4 | blocked self-script messages `budget 1/25`, then `budget 2/25` | `budget 0/25` both times (refusals uncharged) |
| `test/integration/concurrency.test.ts` setup | sessions on agent `fast` (4th read denied) | agent `medium` (fast is now a reader); the fast-reader case is covered by a new hooks-level test (round 1) |
| `test/unit/dod.test.ts` "slices to 120 chars max" | result ≤ 120 chars | "returns the whole line, never cut": 149 chars |

No other pre-existing test changed; round 1 added two new tests to `concurrency.test.ts` (fast-tier 4th read allowed; CAP:none reader only for its dispatch round).

## Tests

| Run | Result |
|---|---|
| New files | `test/unit/guards.roles.test.ts` 44 passed; `test/unit/verify.criteria.test.ts` 84 passed; with `concurrency.test.ts`: 133 passed |
| Final `vitest related` (13 files incl. `index.ts`) | 97 files / 3871 tests passed, 55 skipped (`--maxWorkers=4 --testTimeout=30000 --hookTimeout=60000`) |
| Coverage | `src/router/guard-profile.ts` 100 % branches (24/24) |
| Typecheck | 0 errors before each commit |
| Flakes | With 97 node processes on the host, default-timeout runs showed 1–5 load-induced timeouts in different tests each run (failover-compose, modeB-e2e, resume-flow, routing-ladder-resume, depth-guard-wiring, baseline-wiring, v2-hooks); every one passed in isolation and the full run was green with the longer timeouts. The reviewer confirmed no changed code can cause slowness |

## Findings

| Id | Severity | Summary | Fix |
|---|---|---|---|
| QA-P15-1-1 | critical | `isProgressNote` matched finished wording; incomplete accepted with caveat | `f73edad` |
| QA-P15-1-2 | major | `NEED MORE: budget` graded as failure (I7) | `f73edad` |
| QA-P15-1-3 | major | CAP:none learned only after the first read; `uncapped` survived a resume | `f73edad` |
| QA-P15-1-4 | major | uncharged refusals ~2× steps; no refusal stop signal | `f73edad` |
| QA-P15-1-5 | minor | `denied_cap` message / NEXT ignored the profile | `f73edad` |
| QA-P15-1-6 | minor | INCOMPLETE chosen by reason prefix | `f73edad` |
| QA-P15-1-7 | minor | 4000 budget degraded inferred lines / explicit lists | `f73edad` |
| QA-P15-1-8 | minor | directive skip dropped "Verify: …", "Reason: …" | `f73edad` |
| QA-P15-1-9 | minor | `budget=` raise on resume ignored | `f73edad` |
| QA-P15-1-10 | nit | header prefix literal in `index.ts` | `f73edad` |
| QA-P15-1-11 | nit | reader `redundant_read` wording | `f73edad` |
| QA-P15-1-12 | nit | hooks-level fast-reader test | `f73edad` |
| QA-P15-2-1 | major | advisory / exact-budget counted as exhausted | `93dedfc` |
| QA-P15-2-2 | major | bare `NEED MORE: budget` skipped grading for any agent | `93dedfc` |
| QA-P15-2-3 | minor | refusal cap stopped tier children before base budget | `93dedfc` |
| QA-P15-2-4 | minor | incomplete carried only by reason strings | `93dedfc` |
| QA-P15-2-5 | minor | budget stop read live at verification time | `93dedfc` (+ P2.1 handoff) |
| QA-P15-2-6 | minor | progress notes under a deterministic DoD failed | `93dedfc` |
| QA-P15-2-7 | minor | conditional offers matched as progress notes | `93dedfc` |
| QA-P15-2-8 | minor | header root line / I7 rule vs I1/I8 | amendment R7 (I1/I8 exempt T1.5.3a and the I7 budget-incomplete rule); no code |
| QA-P15-2-9 | nit | delegate path rendered incomplete as "verification unavailable" | `93dedfc` |
| QA-P15-2-10 | nit | wrapped/punctuated directives not skipped | `93dedfc` |
| QA-P15-2-11 | nit | over-budget first sentence fell back to generic criterion | `93dedfc` |

Rounds: 1 FAIL (1 critical, 3 major, 5 minor, 3 nit — all fixed); 2 FAIL (2 major, 6 minor, 3 nit — all fixed); 3 PASS.

### Accepted at the QA round limit

| Residual | Effect |
|---|---|
| Deferred `router_verify` reads live guard state | Until P2.1 stores the return-time snapshot in the deferred record |
| `readCapReached` not wired | A `NEED MORE: budget` claim made at the read-only cap is graded as before |
| `buildForcingNote` exact-reason fallback | Renders INCOMPLETE when any router incomplete reason is present without the flag (merged verdicts only) |
| Broad deferral words (`if/once/when/unless/would/want`) | Some genuine progress notes are graded (safe side) |
| Inferred first sentence > 4000 code points | Unverifiable (accepted with caveat by default) |

## Handoffs

| To | Item |
|---|---|
| P2.1 | `captureBudget(child, sessionStore.readCapReached(child))` into the task artefact at return (`index.ts` ≈1934) and into the deferred record (≈1902) |
| P2.1 | Pass `incomplete: isIncompleteVerdict(verdict)` to `buildForcingNote` (≈2026, ≈1397) and to `nextAction` (≈1376) |
| P2.1 | `returnContract: true` on the gate artefact for role agents |
| P2.1 | `profile` to `guardBeforeCall` / `guardAfterCall` (≈1758, ≈1849) from `roleGuardProfile(role, tier, routeLine.budget)` |
| P2.1 | `budgetExhausted` annotation of the parent result in `execute.after` (P-5); host `steps` = top budget + `REFUSAL_CAP` + margin (P-4) |
| P2.1 | The `class=review\|recon\|search` reader signal needs a non-static routing engine (the dispatch registry is empty under `static`) |
| P2.1 | v2 shadow/advise/enforce strip the route line before the header: pass the routed decision's `root` to `buildDispatchHeader` |
| P3.2 | CHANGELOG: explicit `[acceptance]` lists over 4000 code points are no longer graded in full (overflow omitted, partial pass unverifiable); the §2.9 behaviour changes above |

## Takeovers

None. Transport failures during round 1 were resumed in the same session.

## Verdict

**PASS** — 0 open blocking, critical or major findings after round 3.
