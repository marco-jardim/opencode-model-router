# Phase P2.1 — Role dispatch runtime (#84)

Branch `rta/p21` (worktree `D:\git\omr-rta-p21`). Plan §5 P2.1, tasks T2.1.0–T2.1.5; handoffs from `docs/qa/role-tier/wave2-handoffs.md` (P2.1 list).

## Pre-flight

| Step | Result |
|---|---|
| Worktree | `D:\git\omr-rta-p21` on `rta/p21`, from `origin/rta/main` @ `e76f417` |
| `npm ci` | ok |
| Typecheck | exit 0 |
| Baseline | related run over the seven P2.1 files: 117 files / 9794 tests passed |
| Contract | `f9e2673` (annotation seam) merged into `rta/main` (`d1830ad`) |
| Parallel producer | second worktree `D:\git\omr-rta-p21b` (`rta/p21b`) carried the dispatch path (`2f568a2`), merged into `rta/p21` at `935f060` |

## Implementation

### P2.1 commits (`git log d1830ad..rta/p21 --no-merges`, P2.1 only)

| Commit | Purpose |
|---|---|
| `c69f15f` | Role agents registered on v2 (max policies, floor model fallback, steps, `explore → explorer` alias) — T2.1.1 |
| `2f568a2` | Role dispatch path in `dispatch.ts` (work root, grant, effective detection, bounds, kernel, per-call model, nonce, rows) — T2.1.2 |
| `60c6a2f` | v2 adapter: description nonce, binding before tools, authority resume, P-5 foreground, budget/authority annotations, eviction, bypass seam — T2.1.3/T2.1.4 |
| `dd2cbcf` | Plugin runtime: roles protocol switch, `router_run` / `router_request_authority` / bound `router_git_*`, guard profiles, signals, gate artefact budget and `returnContract`, role escalation hint — T2.1.3 |
| `32882b3` | Tests: role runtime wiring |
| `8b6e86d` | Deferred record carries the budget snapshot to `router_verify` (handoff 24) |
| `1a8763d` | Host step limit / context overflow as role budget stops (handoff 22) |
| `f245742` | P2.2 advisor extras, `/router` role lines, folded budget signals, R7 comments |
| `a71ea4c` | Tests: R7 identity, P2.2 wiring, deferred budget, host budget stops |
| `02c03ba` | QA round 1: dispatch path |
| `a67a8ae` | QA round 1: tiers mode registers no role agent before resolving |
| `937f89e` | QA round 1: v2 adapter |
| `391813d` | QA round 1: plugin runtime |
| `eb9a986` | Tests: QA round 1 + `test/integration/roles-dispatch.test.ts` (T2.1.5) |
| `dcb52b1` | `previewAuthority` (QA round 2, nit 2) |
| `ff1a29d` | QA round 2: resume path in the dispatch router |
| `036cb19` | QA round 2: v2 adapter |
| `1b59425` | QA round 2: plugin runtime |
| `e66e2d9` | Tests: QA round 2 |
| `d128e4c` | QA round 3: read-cap stop only on `NEED MORE`; a resume restarts the read counter |

### Merges

| Merge | Content |
|---|---|
| `935f060` | `rta/p21b` (dispatch path `2f568a2`) |
| `3d44edc` | `rta/p22`: roles protocol (`546bcc4`, `8603fa8`) |
| `5b24ebc` | `rta/p22`: advisor findings, role lines (`345dee6`, `2b38fff`) |
| `a8d4199` | `rta/p22`: P2.2 QA round 1 (`10f1d5e`, `f1b39db`) |
| `98a041c` | `rta/p22`: P2.2 QA round 2 (`b55736d`) |

No merge conflicts.

### Handoff checklist (wave2-handoffs.md, P2.1)

| # | Status |
|---|---|
| 1 | done — `resolveRolesRouting` notice at startup (`dd2cbcf`) |
| 2, 3, 38, 41, 42, 44, 45 | done — registration (`c69f15f`) |
| 4, 5, 6, 7, 8, 9, 10, 31, 33 | done — dispatch path (`2f568a2`) |
| 11, 13 | done — one work-root resolver; `recordRun` → `run` signal (`dd2cbcf`) |
| 12 | done — plugin tools listed by name in role allows (`c69f15f`) |
| 14 | informational (npm `globalconfig` residual) → P3.2 docs |
| 15–18, 21, 23 | done — signal call sites, re-dispatch with `expectDecisionID`, `DispatchText` fields, prompt without router lines, `roleAgentIds`, real guard state (`dd2cbcf`) |
| 19 | done — `role`/`tier` on role rows (`2f568a2`) |
| 20 | done — observed binding rows `note:binding:<kind>` at bind time (`02c03ba`, `937f89e`) |
| 22 | done — host step limit and context overflow (`1a8763d`); the overflow pattern is unmeasured (see Handoffs) |
| 24 | done — task artefact (`dd2cbcf`) and deferred record (`8b6e86d`) |
| 25, 26, 27, 28 | done (`dd2cbcf`) |
| 29 | no change needed — the class reader signal reads the dispatch registry, filled only when `routing.engine ≠ static` |
| 30 | done for tier dispatches (stripped `root=`); role dispatches carry no tier header |
| 32 | done — `firstText` from the first user message (`60c6a2f`) |
| 34, 35, 37, 40 | done (`60c6a2f`) |
| 36 | done (`60c6a2f`; preview/consume order `937f89e`, `036cb19`) |
| 39 | done — role hint; after a FAIL the router raises the resumed child itself (`ff1a29d`, `1b59425`) |
| 43 | done — `router_git_*` take the bound work root (`dd2cbcf`) |

## Tests

Counts from the last runs of this phase.

| Run | Result |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| Four role files (`test/integration/roles-dispatch.test.ts`, `test/unit/roles.runtime.test.ts`, `test/unit/roles.dispatch-path.test.ts`, `test/unit/roles.registration.test.ts`) | 4 files, 103/103 passed |
| `vitest related src/index.ts src/compat/v2-hooks.ts src/router/sessions.ts` (round 3) | 135 files passed, 3 skipped; 10503 passed, 56 skipped |
| `vitest related` over `index.ts`, `v2.ts`, `v2-hooks.ts`, `dispatch.ts`, `role-agents.ts`, `authority.ts` (round 2) | 51 files passed, 3 skipped; 1415 passed, 55 skipped |

No test of another phase was modified. P2.1's own assertions in `roles.dispatch-path.test.ts` and `roles.runtime.test.ts` were updated where a QA finding changed the behaviour they pinned (fresh-row binding, delegate dispatch, hint wording, exact-only authority).

## Findings

| Id | Severity | Finding (short) | Fix |
|---|---|---|---|
| QA-P21-1-1 | major | Delegate's role dispatch untouched (caller model unbounded, I2) | `02c03ba` |
| QA-P21-1-2 | major | Deferred verification still counted as a deterministic gate | `02c03ba` |
| QA-P21-1-3 | major | Budget read without the read-only CAP state | `937f89e`, `391813d` |
| QA-P21-1-4 | minor | Role hint replaced NEXT on `unverifiable` | `391813d` |
| QA-P21-1-5 | minor | Caller model won over a route-line pin | `02c03ba` |
| QA-P21-1-6 | minor | Variant drop kept the variant rung's rank | `02c03ba` |
| QA-P21-1-7 | minor | Edits under `/bypass` not recorded | `391813d` |
| QA-P21-1-8 | minor | Tools fixed at start vs registration on rebuild | `02c03ba`, `937f89e`, `391813d` |
| QA-P21-1-9 | minor | Tiers mode resolved roles before returning | `a67a8ae` |
| QA-P21-1-10 | minor | Authority consumed before `route()` succeeded | `937f89e` |
| QA-P21-1-11 | minor | Fresh rows claimed `binding: exact` | `02c03ba`, `937f89e` |
| QA-P21-1-12 | nit | Observer ignored `data.message`; retried steps | `937f89e` |
| QA-P21-1-13 | nit | `dispatchOf` `callID: ""` undocumented | `391813d` |
| Q1 | question | Widen only an exact binding on resume | `937f89e` |
| Q2 | question | P2.2 handoffs: budget note prefix; role hint never names a tier agent or model | `02c03ba`, `937f89e` |
| QA-P21-2-1 | major | Resume bounds lost the bound grant | `ff1a29d` |
| QA-P21-2-2 | major | "The router raises the tier" not implemented | `ff1a29d`, `1b59425` |
| QA-P21-2-3 | minor | No read-only cap from the role dispatch's own `CAP` | `1b59425` |
| QA-P21-2-4 | minor | Role live despite failed registration | `ff1a29d`, `036cb19`, `1b59425` |
| QA-P21-2 nit 1 | nit | `error.data.message` not read | `036cb19` |
| QA-P21-2 nit 2 | nit | Authority conditions duplicated (`previewAuthority`) | `dcb52b1`, `036cb19` |
| QA-P21-2 nit 3 | nit | Deferral assumed `router_verify` registered | `ff1a29d`, `036cb19`, `1b59425` |
| QA-P21-3-1 | major | `readCapReached` alone a stop; read counter never reset on resume | `d128e4c` |

| Round | Verdict |
|---|---|
| 1 | FAIL — 3 major, 8 minor, 2 nit + Q1/Q2; all fixed |
| 2 | FAIL — 2 major, 2 minor, 3 nit; all fixed |
| 3 | FAIL — 1 major (QA-P21-3-1); fixed in `d128e4c` |
| 4 (targeted) | PASS |

Router grader: two producer dispatches came back "NOT ACCEPTED". Both were false negatives — the cited changes were R7-exempt mode-independent behaviour (artefact budget snapshot, header naming the stripped `root=`, `incomplete` flag) and the update of P2.1's own test assertions.

### Accepted (QA round limit)

| Id | Residual |
|---|---|
| m1 | The resume raise is consumed before the call is committed |
| m2 | A resume by a delegate parent ignores the raise |
| m3 | The raise is recorded even when the hint is not shown |
| m4 | The attempt recorder's tier is the role name only for capped children |
| m5 | A `subagentTiers` mapping of a role can re-register the child under the tier's baseline cap on resume |
| — | A resume under `/bypass` does not reset the role read counter |

## Handoffs

| To | Item |
|---|---|
| P2.3 | Per-session permission narrowing (wave2-handoffs P2.3 list). Unknown-binding authority is exact-only at the resume call site (Q1), decided through `previewAuthority(…, { exactOnly: true })`; P2.3 owns the policy. |
| DF-2 | Roles mode is decided at plugin start (role tools and agent registration): the DF-2 migration needs a restart after the override write (plan amendment R8). |
| P3.1 | Real-host smoke of the host budget observer; the context-overflow pattern is unmeasured (spike S4 covered step limits only). |

## Takeovers

None.

## Verdict

PASS — 0 open blocking, critical or major findings after round 4.
