# P3.3 — global QA of role × tier × assurance delegation (#84)

Scope: `eeab36b..rta/main` (the whole change). Executor: the orchestrator session, dispatching role agents (roles mode live
since DF-2). Reviewers ran on the heavy tier and never reviewed their own code.

## Pre-flight

- `rta/main` @ `7c798e7` (P3.1 and P3.2 merged): capped suite 176 files passed / 3 skipped, 12902 tests passed; CI 17/17
  green on PR #85.
- Open self-test items handed to the review: DF2-F2 (classifier attributes `edit` to edit-free prompts).

## Reviews

| Area | Rounds | Result |
|---|---|---|
| A — security | round 1 blocked twice by the provider ("Provider blocked the response"); split into A1 grants/binding/hooks, A2 `router_run`/`router_git`/paths, A3 guards/child text | A1: R1 FAIL (1 major, 1 minor, 2 nit) → R2 PASS (2 nit, fixed). A2: R1 FAIL (2 major, 2 minor, 2 nit) → R2 PASS (1 minor, 2 nit, fixed) → R3 PASS. A3: R1 FAIL (1 major, 3 minor, 3 nit) → R2 FAIL (2 minor, 2 nit) → R3 PASS |
| B — economy and engine | 3 | R1 FAIL (3 major, 4 minor, 3 nit) → R2 FAIL (1 major, 1 minor, 3 nit) → R3 PASS (4 minors accepted at the round limit) |
| C — docs, v1, tests, release | 3 | R1 FAIL (2 major, 6 minor, 3 nit) → R2 FAIL (2 major) → R3 see below |

## Findings and fixes

| Id | Sev | Summary | Fix |
|---|---|---|---|
| QA-G-A1-1 | major | context filter dropped `apply_patch`/`multiedit` for roles granted `edit` | fix-3 `28bf396` |
| QA-G-A1-2 | minor | any resuming session could apply another session's authority request | fix-4 `2051692`, fix-6 `b586caa` |
| QA-G-A1-3, A1-4 | nit | `consumeAuthority` exact-only; unknown-binding note | fix-4 |
| QA-G-A1-2-1, 2-2 | nit | escalated session owns the request; untouched routes never consume | fix-6 `b586caa` |
| QA-G-A2-1 | major | `router_run` cwd reached the network (realpath of a UNC path) before the root check | fix-3 |
| QA-G-A2-2 | major | role `edit` could rewrite `.git` and redirect `router_git_*` | fix-3 |
| QA-G-A2-3, A2-4 | minor | bare `git worktree list`; `router_git_*` not limited to a subdirectory root | fix-3 |
| QA-G-A2-5, A2-6 | nit | whitespace trimming; `PGPASSWORD`/`MYSQL_PWD`; unwired `envPassthrough` (removed, R10(3)) | fix-3 |
| QA-G-A2-2-1 + 2 nits | minor | `safe.directory` lost in hardened listings; realpath far from the root; #81 edit-key notice | fix-8 `3093c70` |
| QA-G-A3-1 | major | advisory `NEED MORE: budget` scored as `incomplete` (I7) | fix-5 `17be54e` |
| QA-G-A3-2…A3-7 | minor/nit | refusals outside `denied_cap`; resume `budget=` ignored; forged `[router` lines; grader reasons unbounded; step/fallback budgets | fix-5 |
| QA-G-A3-2-1…2-4 | minor/nit | router reasons cut at 500; resume lost `budget=` raise; defang bypasses; OS errors counted as refusals | fix-8 `56d5a60` |
| QA-G-B-1 | major | resume decided on the resume text (risk, class, checks lost; I2) | fix-4 |
| QA-G-B-2 | major | ladder granted `edit` without a work root (edits in the base checkout) | fix-4 |
| QA-G-B-3 | major | DF2-F2: classifier cwd was the session directory; `needs=` could not narrow; class-implied `edit` survived `class=other` | fix-4 |
| QA-G-B-4 | minor | `run`/`incomplete`/`redispatch` never reach the store | decided statistics-only (R10(1)), docs fix-6 |
| QA-G-B-5, B-6, B-7, N1–N3 | minor/nit | run signal not attempt-scoped; simulate parity; `grader` detection without verification; explore flag; counts doc; exploration doc | fix-4, fix-5, fix-6 |
| QA-G-B-2-1 | major | carried `[acceptance]` passed vacuously on a resume with no changes | fix-7 `0335760` |
| QA-G-B-2-2 + N-a…N-c | minor/nit | raw prompt text in `needTerms`; `d=` not carried; null root; protocol sentence | fix-7 |
| QA-G-C-1, C-2 | major | ENFORCEMENT.md guard table and README v1 sentence stale | fix-6 `3784caf` |
| QA-G-C-2-1, C-2-2 | major | `needs=` "only narrows" (it replaces); `subagentTiers` role-name claim | fix-6 `b586caa` |
| QA-G-C-3 | minor | edited pre-existing tests without a deviation record | this report (below), R10(4) |
| QA-G-C-4, C-5, C-6 | minor | handover §2 stale; dogfood Wave 3 section; scenario-6/smoke:v1 output not committed | executor close-out (this commit) |
| QA-G-C-7 | minor | I8 hash proof compares HEAD with/without roles keys only | criterion 2 recorded below |
| QA-G-C-8, C-9, C-10, C-11 | minor/nit | merge commit for PR #85; ADR R-range; CI count; smoke redactor | R10(5), fix-6, plan, fix-6 |

Accepted at the round limit (round 3, minor): a carried `testsPass`/`lintClean` stays unverifiable when the introducing
attempt was deferred or ungated (fails safe, accepted with a caveat; a new `[acceptance]` block resets it); a repeated
identical block starts a new lineage; network-rule labels may log up to 40 letters; a delegate's resume resets the
lineage; untagged host refusals are not counted toward `denied_cap`; a line-start `[router.ts](…)` link in a role result is
defanged; `roleBudgetPeaks` is LRU-bounded; a POSIX root of `/`; a same-drive symlink to a share reaches realpath.

## Criterion 3 deviation record (pre-existing tests edited, R10(4))

Pre-existing (at `eeab36b`) test files with removed or changed lines, and why:

| File | Commit | Reason |
|---|---|---|
| `test/integration/concurrency.test.ts`, `test/integration/guard-enforcement.test.ts` | `fb185db`, `f73edad` (P1.5) | §2.9 reader profile / uncharged denials (behaviour change in CHANGELOG) |
| `test/unit/dod.test.ts` | `6c59af8` (P1.5) | §2.9 whole criteria |
| `test/unit/v2-hooks.test.ts` | `cab74ec` (Wave 2 CI) | timeouts under Windows CI load; assertions unchanged |
| `test/unit/baseline-wiring.test.ts`, `test/unit/v2-client.test.ts`, `test/unit/wiring.test.ts` | `d48bc91` (fix-2) | `onVerdict`/grader signature; expected `dispatchGrader` objects gained `model` |
| `test/integration/routing-ingest.test.ts`, `test/unit/escalate-attempt-recorder.test.ts` | `7556fcb` (fix-2) | required `grader` parameter; role grader rows pinned to the fixed behaviour |
| `test/smoke/routing-engine.smoke.test.ts` | `2d3eaa2`, `a976569`, `0c31c8f` (P3.1) | scenario 6 repinned from the stale `71815eb` to `bd1ecd1`, narrowed to v1 entry points |
| `test/smoke/subagent-tiers.smoke.test.ts` | `bd1ecd1` | Haiku 5.5 fast model alignment (pre-#84 drift) |
| `test/unit/docs-drift.test.ts` | P1.1, P3.2, P3.3 | pins updated to the new documented rules |

`test/smoke/helpers/routing-host.ts` (pre-existing helper) was extended additively in P0.1/P3.1 and its redactor fixed in P3.3 (C-11). Every other pre-existing test file only gained tests. Goldens: only `test/golden/roles-protocol.golden.test.ts` is new;
no pre-existing golden changed.

## Criterion 2 (v1 untouched, I8) — how it is met

Combined pins: unchanged goldens since `eeab36b` (v1 prompts and agents); `test/unit/roles.v1-fallback.test.ts` (roles keys
on v1 register nothing, hash-equal system prompt, agent set, tool set and argument schemas against the same HEAD without
roles keys, one notice); smoke scenario "6 v1 untouched" against `bd1ecd1`; `smoke:v1` on OpenCode 1.18.35. Accepted
v1-visible changes: the §2.9 behaviour changes and R10(2), all in the CHANGELOG.

## Final runs (rta/main @ `952de94`, all P3.3 code fixes merged)

- Unit + integration + golden: 179 files passed / 3 skipped, 12969 tests passed (at `0afbf95`, before the docs merge).
- Real-host roles smoke on OpenCode v2.0.24: 1 file, 7/7 passed; evidence regenerated in `evidence\`.
- Smoke scenario "6 v1 untouched": 1 passed (evidence `docs\qa\cost-aware-routing\evidence-3.2\6-v1-untouched.json`).
- `smoke:v1` with OpenCode 1.18.35 first on PATH: preflight OK, 5 files passed, 27 passed / 11 skipped (same as the
  P3.1 baseline).

## Process notes

- The router's independent grader timed out (60 s) on most large fix reports and twice returned NOT ACCEPTED on
  truncated criteria; each fix was re-verified by the executor (typecheck and the touched tests) and by the next QA round.
- Transport failures (`socket connection was closed`, `Overloaded`) were resumed on the same session.
- Takeovers: none (the executor resolved merge conflicts and handled evidence files, which are executor-owned).

## Verdict

**PASS** — areas A1, A2, A3, B and C pass (0 open blocking/critical/major); round-limit minors listed above. Committed evidence predates the C-11 redactor fix, so some paths read `<home>\<user>\Local\Temp` (cosmetic). Release gate: CI on the final head (recorded on #84).
