# Phase P1.4 — Outcome signals and role statistics (issue #84)

Plan: `docs/plans/role-tier-assurance-delegation-plan.md` §2.6, §2.8 (I6, I7), §5 P1.4. Branch `rta/p14`, worktree
`D:\git\omr-rta-p14`. Owned files: `src/routing/outcomes/{types,signals,ingest,stats,persist,index}.ts`,
`test/unit/routing-outcomes.signals.test.ts`.

## Pre-flight

| Step | Result |
|---|---|
| Worktree | `D:\git\omr-rta-p14` on `rta/p14` from `origin/rta/main` @ `2ab0c40` |
| `npm ci` | ok |
| `npm run typecheck` | 0 errors |
| Baseline (as recorded by the executor) | `npx vitest related` over the five outcomes files: 61 files / 1991 tests passed |
| Baseline (re-measured by the phase) | same five-file related set at `66dcdff` (after merging `origin/rta/main`): 56 files (53 passed, 3 skipped) / 1641 tests (1586 passed, 55 skipped) |
| Why two baselines | `vitest related` follows the import graph of the checked-out tree; the two figures were taken on different trees and were not reconciled. The phase's before/after comparison uses the re-measured set: 56 / 1641 before, 57 / 1691 at the first delivery (+1 file, +50 tests, 0 failures) |
| Ownership | no conflict with another active phase |
| Base checkout `D:\git\opencode-model-router` | `git status --porcelain` empty |

## Implementation

P1.4 commits (`git log --no-merges a024bba..rta/p14`; the contract commit precedes that range):

| Commit | Task | Purpose |
|---|---|---|
| `b5a4e40` | T1.4.1 | Contract: origin `role`, `SignalKind`, optional `DecisionRow` extension, `parseLogLine` parsing |
| `f7cefc3` | T1.4.2 | `signals.ts`: §2.6 weights, return-prefix detection, budget/authority exclusion, grader independence, run after last edit, re-dispatch detection, signal rows; `types.ts` `tier`/`signalWeight`/annotation rows |
| `66b6f4c` | T1.4.4 | `summarizeRoles`: role × tier statistics; `summarize` leaves annotation rows out |
| `b280bf8` | T1.4.3 | `Ingest.onSignal` (rows only), `IngestSettings.roleAgentIds`, barrel exports |
| `5f4e552` | T1.4.5 | Tests incl. `parseLogLine` round-trip of the contract fields and a tier-mode golden captured from `66dcdff` |
| `3986849` | QA round 1 | Fixes QA-P14-1-1 … 1-14 |
| `3326cc7` | QA round 1 | Regression tests, one per finding |
| `be713e4` | QA round 2 | Fixes QA-P14-2-1 … 2-5, residuals of 1-4 and 1-6, N1 |
| `de6e5a8` | QA round 2 | Regression tests, one per finding |
| `1da395f` | QA round 3 | QA-P14-3-1: one parse per dispatch, count map, cap of 100 earlier dispatches |

Also in the range, brought in by merges of `origin/rta/main` (not P1.4): `46ad5ac`, `66dcdff`, `40ed16d`, `bd1ecd1`.

Signal table (`src/routing/outcomes/signals.ts`):

| Event | Kind | Weight | Sign |
|---|---|---|---|
| Deterministic verdict pass / fail (written only by `onVerdict`, when the store takes it) | `verdict` | 1 | + / − |
| `router_run` exit 0 of every acceptance command, started after the last tracked edit | `run` | 1 | + |
| Grader pass / fail, grader tier ≥ producer tier and certainly another model | `grader` | 0.5 | + / − |
| Explicit `NEED MORE` / `ESCALATE`, both guards observed false | `incomplete` | 0.5 | − |
| Observed budget exhaustion (guard, host step limit, context overflow) | `budget` | 0 | none (I7) |
| Observed authority request | `authority` | 0 | none (I7) |
| Same task re-dispatched to a higher tier within 30 min of the previous attempt's end | `redispatch` | 0.5 | − on the previous attempt |
| `DONE`, no contract prefix, no text, or an unfinished return with a guard unobserved | none | 0 | (I6, I7) |

## Tests

| Measure | Result |
|---|---|
| `test/unit/routing-outcomes.signals.test.ts` | 76 / 76 passed |
| `npx vitest related` over the six outcomes files (incl. `types.ts`, at `de6e5a8`) | 62 files passed, 3 skipped / 2065 tests passed, 55 skipped, 0 failed |
| `npx vitest related src/routing/outcomes/signals.ts` (at `1da395f`) | 50 files passed, 3 skipped / 1608 tests passed, 55 skipped, 0 failed |
| Coverage `signals.ts` | 97 % branches (227/234), 100 % lines, 100 % functions |
| `npm run typecheck` | 0 errors |
| Tier-mode statistics | `summarize`/`renderMarkdown` equal the golden captured from `66dcdff` (JSON sha256 `e785746d…`, markdown `935fd21b…`), with and without annotation rows |
| Existing tests modified | none |

## Findings

| Round | Id | Severity | Subject | Fix |
|---|---|---|---|---|
| 1 | QA-P14-1-1 | critical | Shared boilerplate produced re-dispatch failures | `3986849` |
| 1 | QA-P14-1-2 | major | Any non-prefixed first line was `incomplete`; task tool wrapper not unwrapped | `3986849` |
| 1 | QA-P14-1-3 | major | Non-finite edit times ignored; untracked edits ≡ no edits | `3986849` |
| 1 | QA-P14-1-4 | major | Grader on the same model via another provider counted | `3986849` |
| 1 | QA-P14-1-5 | major | Re-dispatch penalty could not reach its attempt | `3986849` |
| 1 | QA-P14-1-6 | major | Verdict signal rows bypassed store gating | `3986849` |
| 1 | QA-P14-1-7 | minor | Third dispatch judged against its own history; window from start | `3986849` |
| 1 | QA-P14-1-8 | minor | Role from dispatch, tier from signal | `3986849` |
| 1 | QA-P14-1-9 | minor | Budget/authority rows dropped under untrusted class | `3986849` |
| 1 | QA-P14-1-10 | minor | Child's own budget/authority claim removed the penalty | `3986849` |
| 1 | QA-P14-1-11 | minor | Signal rows readable as dispatches by pre-P1.4 readers | `3986849` |
| 1 | QA-P14-1-12 | nit | `isAnnotationRow` keyed on `signal` too | `3986849` |
| 1 | QA-P14-1-13 | nit | Empty `tier` accepted | `3986849` |
| 1 | QA-P14-1-14 | nit | Stats vs ingest dedupe identity | `3986849` |
| 2 | Residual 1-4 | partial | Vertex `@date` ids escaped model folding | `be713e4` |
| 2 | Residual 1-6 | partial | Refusal-converted pass stayed +1 in role stats | `be713e4` |
| 2 | QA-P14-2-1 | major | Template siblings excluded as "same task" | `be713e4` |
| 2 | QA-P14-2-2 | major | Identifier cap broke annotated retries | `be713e4` |
| 2 | QA-P14-2-3 | minor | Unobserved `NEED MORE: budget` attempt penalised on re-dispatch | `be713e4` |
| 2 | QA-P14-2-4 | minor | Unanchored `<task_result>` unwrap | `be713e4` |
| 2 | QA-P14-2-5 | minor | Role dispatch row without `role` unattributed | `be713e4` |
| 2 | N1 | nit | `budgetExhausted` doc (host step limit, context overflow) | `be713e4` |
| 2 | N2 | nit | TASK-only comparison vs plan text | no code; plan amendment R7 (executor) |
| 3 | QA-P14-3-1 | major | `detectRedispatch` C × F² prompt parses | `1da395f` |
| 4 | — | — | PASS | — |

Round outcomes: round 1 FAIL (1 critical, 5 major, 5 minor, 3 nit — all fixed); round 2 FAIL (2 major, 3 minor,
2 partial residuals, 2 nit — all fixed, N2 as amendment R7); round 3 FAIL (1 major — fixed); round 4 PASS.

Accepted at the QA round limit:

| Item | Effect |
|---|---|
| QA-P14-2-3 residual | `penalisable` treats `returnPrefix: "none"` as finished; an unobserved host step-limit cutoff looks like that, so the unobserved case keeps an I7 gap (closed when P2.1 passes real guard state) |
| Refusal-converted verdict pass | The conversion is counted in the signal row's window, not the refusal's |
| Duplicate earlier-dispatch objects | The same object passed twice counts twice in the leave-one-out line counts |
| Fixed 500 ms performance bound | May flake on a heavily loaded CI runner (measured 74 ms locally) |

## Handoffs

| To | Item |
|---|---|
| P2.1 | Call `onSignal` / `onVerdict` from the hooks; verdict signal rows only through `onVerdict` |
| P2.1 | Re-dispatch: `onSignal(prev.childSessionID, obs, { expectDecisionID: prev.decisionID })` |
| P2.1 | Fill `DispatchText` `class`, `role`, `endedAt`, `returnPrefix`, `budgetExhausted`, `authorityRequested` |
| P2.1 | Pass the orchestrator's prompt without the router header |
| P2.1 | Write `role` and `tier` on role decision rows |
| P2.1 | Unknown-binding rows with reason `note:binding:unknown` |
| P2.1 | `IngestSettings.roleAgentIds` from `resolveRoles` |
| P2.1 | Fold host step limits and context overflow into `budgetExhausted` |
| P2.1 | Always pass the real guard state and `editsObserved` |
| P3.2 | CHANGELOG: downgrading past P1.4 is unsupported (signal rows are read by older versions only through the C7 decision-id dedupe) |

## Takeovers

None. Transport failures during QA round 1 were resumed in the same session.

## Verdict

PASS — 0 open blocking, critical or major findings after round 4.
