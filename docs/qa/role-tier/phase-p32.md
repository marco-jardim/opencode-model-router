# Phase P3.2 — Documentation, ADR 0006, changelog and docs-drift pins (#84)

Branch `rta/p32` (worktree `D:\git\omr-rta-p32`). Plan §5 P3.2, tasks T3.2.1–T3.2.4; handoffs from
`docs/qa/role-tier/wave2-handoffs.md` (P3.1 / P3.2 list) and the phase reports `phase-p11.md`, `phase-p13.md`,
`phase-p14.md`, `phase-p15.md`, `phase-p21.md`, `phase-p22.md`. Executed through the `implementer` role (Wave 3 runs
through role agents, §0.10).

## Pre-flight

| Step | Result |
|---|---|
| Worktree | `D:\git\omr-rta-p32` on `rta/p32`, from `origin/rta/main` @ `19b6fec` |
| `npm ci` | ok |
| Typecheck | exit 0 |
| Ownership | P3.2 files of §4 only; no `src` change (doc/code divergences reported to the executor instead) |
| Sources read | plan §1, §2, §9 R5–R8 (later R9); `docs/qa/role-tier/spikes.md`; phase reports P0.1–P2.3; the code each claim quotes |

## Implementation

### Commits (`rta/p32`)

| Commit | Purpose |
|---|---|
| `be52432` | `docs(roles)`: new `docs/ROLES.md` and `docs/adr/0006-role-tier-assurance-delegation.md`; roles sections in `README.md`, `docs/CONFIG_REFERENCE.md`, `docs/ROUTING_ENGINE.md`, `docs/READ_ONLY_TIERS.md`; `CHANGELOG.md` `[Unreleased]`; `docs/plans/README.md` |
| `76d7f51` | `test(docs)`: docs-drift pins of the roles table, the floor table, the roles docs and their links |
| `c15c270` | `docs(roles)`: QA round 1 fixes |
| `16e8133` | `test(docs)`: pins of the QA round 1 fixes |
| `441cd03` | merge of `origin/rta/main` (DF2-F1 fix, grader-signal fix, plan amendment R9) |
| `9293045` | `docs(roles)`: QA round 2 fixes |
| `c7f0459` | `test(docs)`: R9 scripts pin after the merge; pins of the QA round 2 fixes |

### What each document covers

| File | Content |
|---|---|
| `docs/ROLES.md` (new) | The three axes; turning roles mode on; the shipped roles table (generated from `SHIPPED_ROLE_SPECS`: agent, kind, description, authority mode and max, tier range, descriptive default assurance, guard, budgets per tier, host steps); action classes (local / exec / write / egress); separation rule and residual risks (repo scripts may reach the network, repository content as injection, orchestrator-routed flows, host `grep` following links, the tool-output folder); work roots (`root=`, worktrees, `routing.workRoots` globs, canonical long form, over-match, acceptance checks in the work root); the tier floor and the authority-floor table (from `authorityFloor`); dynamic authority, nonce binding and the ladder (exact-binding-only widening); budgets (`budget=` up to 2×, cumulative × 3, refusals, host steps, the 25-call fallback above a role's ceiling, budgets enforced only in `enforced` mode, `NEED MORE: budget`, `[router budget]`, resume the same session); outcome signals (weights, the npm-script-form `run` signal matched by entry name, graders at 0.5 only when independent); exploration; `router_run` (entries, argument patterns, single-dash rule, executables, npm pins, `.npmrc` refusals, trusted script bodies with pre/post hooks, environment stripping and what stays reachable, bounds); roles mode decided at plugin start (R8); OpenCode v1 fallback; migration from `subagentTiers` and #81 `agents` with the kill switch; observability (dispatch rows vs `note:binding:` / `note:signal:` annotation rows); limits (not an OS sandbox, the narrow `run` signal, no `outputPaths` on host 2.0.24, the noisy classifier); where things live |
| `docs/adr/0006-role-tier-assurance-delegation.md` (new) | Context with evidence E1–E13 (plan §1.1); decisions D1–D13; alternatives rejected; consequences; literature L1–L14 only (plan §1.2) with the RH1–RH10 qualifier table (plan §1.3) |
| `docs/CONFIG_REFERENCE.md` | Roles keys checked against the code; plugin-start rule and restart wording; descriptive assurance and the missing-`d=` rule; `routing.run.scripts` exact names (R9); single-dash rule; link to ROLES.md |
| `docs/ROUTING_ENGINE.md` | New "Roles mode (#84)" section: one tier order, the window, `buildRoleLadder`, `decideRole`, exploration and its propensity, dispatch vs annotation rows; grader weight in the posterior, the evidence gate and `routing:stats`; exploration limit restricted to tiers mode |
| `docs/READ_ONLY_TIERS.md` | Reader guard profile (§2.9) and its relation to the reader roles; `class=review\|recon\|search` qualified as v2 with a non-`static` engine |
| `README.md` | Short "Roles mode (opt-in, OpenCode v2)" section and deep-dive links |
| `CHANGELOG.md` `[Unreleased]` | Roles mode feature entry (incl. R7/R8/R9 rules) and the §2.9 behaviour-change entry (reader profile, uncharged denials, whole criteria, header strip, progress notes incomplete, `root=` in the header, `[acceptance]` lists over 4000 code points, budget claim from the return prefix, downgrades unsupported) |
| `docs/plans/README.md` | The plan's entry links the ADR, the guide, the config keys and the QA reports; ADR 0006 under related records |
| `test/unit/docs-drift.test.ts` | Roles table vs `SHIPPED_ROLE_SPECS` cell by cell (header pinned); floor table vs `authorityFloor` for every grant × detection × risk × scope; action classes (each action in exactly one row); numbers, notices and grant notes quoted from code; ADR structure (D1–D13, E1–E13, only L1–L14, RH1–RH10); changelog items; QA-round pins (descriptive assurance, missing `d=`, `run` signal, grader weight, work-root checks, annotation rows, 25-call fallback, R9 scripts); negative fixtures for each table check; link check over the roles docs |

## Tests

| Run | Result |
|---|---|
| `npx vitest run test/unit/docs-drift.test.ts` (via `router_run`, `test-files`) | 60 / 60 passed |
| `npm run typecheck` (via `router_run`) | exit 0 |

## Findings

| Id | Severity | Finding (short) | Fix |
|---|---|---|---|
| QA-P32-1-1 | major | Role default assurance documented as an input of detection; it is descriptive (detection = router gate, `d=` claim, `[acceptance]` block) | `c15c270`, `16e8133` |
| QA-P32-1-2 | major | DF2-F1 documented as a limit; the code fix runs checks in the work root, refuses a foreign `cwd:`, drops deterministic detection | `c15c270`, `16e8133` |
| QA-P32-1-3 | major | `run` signal limited to npm-script-form checks not documented | `c15c270`, `16e8133` |
| QA-P32-1-4 | major | `budgetUsed` documented but never written; dispatch-row fields mixed with annotation rows | `c15c270`, `16e8133` |
| QA-P32-1-5 | minor | CHANGELOG lacked R8(2), R8(3), R8(7), R7 single-dash and cost-inverted roles; `class=review\|recon\|search` case not qualified | `c15c270`, `16e8133` |
| QA-P32-1-6 | minor | CONFIG_REFERENCE runtime-switch wording | `c15c270` |
| QA-P32-1-7 | minor | `test:*` scripts (exact names only) | `c15c270`, `16e8133` |
| QA-P32-1-8 | minor | 25-call fallback when a floor lifts a dispatch above its role's ceiling not documented | `c15c270`, `16e8133` |
| QA-P32-1-N1 | nit | "no shell" → "no shell controlled by the caller" (README, READ_ONLY_TIERS) | `c15c270`, `16e8133` |
| QA-P32-1-N2 | nit | ADR E8 "candidate cut site", E13 source "PLAN-3", D1 exemptions incl. the budget-incomplete rule | `c15c270`, `16e8133` |
| QA-P32-1-N3 | nit | docs-drift: roles-table header row pin; each action in exactly one class row | `16e8133` |
| QA-P32-2-1 | minor | Roles mode: a missing `d=` counts as `none` even with an `[acceptance]` block | `9293045`, `c7f0459` |
| QA-P32-2-2 | minor | Grader-signal docs (0.5 only for independent graders, nothing otherwise; posterior, evidence gate, `routing:stats`, ADR D10, CHANGELOG); code map adds `work-root.ts` and `gate.ts` | `9293045`, `c7f0459` |
| QA-P32-2-3 | minor | R9 in the plan; CONFIG_REFERENCE `routing.run.scripts` wording kept and its pin fixed after the merge | `c7f0459` |
| QA-P32-2-N1 | nit | "when the role has no budget for that tier" wording (ROLES.md, ADR) | `9293045`, `c7f0459` |
| QA-P32-2-N2 | nit | code comment at `src/router/roles.ts:247-250` still said the role default assurance applies — fixed on the code side (`rta/p33-fix-2`, "descriptive only") | `rta/p33-fix-2` |
| QA-P32-2-N3 | nit | `run` matching by `router_run` entry name (a command named `test` counts for `npm test`); Limits name the independent grader's 0.5 | `9293045`, `c7f0459` |
| — | addition | R9(5) limit: host 2.0.24 tool-success events carry no `outputPaths` (a role child cannot read its truncated tool outputs) | `9293045`, `c7f0459` |
| — | addition | P3.1 handoffs: role budgets stop a child only in `enforced` mode; worktrees created after plugin start are covered only by `routing.workRoots` (or a restart) | this report's change set |

| Round | Verdict |
|---|---|
| 1 | FAIL — 4 major, 4 minor, 3 nit; all fixed |
| 2 | FAIL — 3 minor, 3 nit; all fixed |
| 3 | PASS |

### Doc/code divergences reported during the phase (fixed on the code side)

| Divergence | Resolution |
|---|---|
| `routing.run.scripts` `test:*` (plan T1.1.2) never reachable: `SCRIPT_NAME` drops `*`, `isRunScriptAllowed` unused | Plan amendment R9(1); dead helper removed in P3.3 |
| DF2-F1: role acceptance checks ran in the session directory | `rta/p33-fix-1`, R9(2) |
| Role grader verdicts moved the store at full weight | `rta/p33-fix-2`, R9(3) |

## Handoffs

None open. The code-side items were fixed in `rta/p33-fix-1`, `rta/p33-fix-2` and plan amendment R9.

## Takeovers

None.

## Verdict

PASS — 0 open blocking, critical or major findings after round 3.
