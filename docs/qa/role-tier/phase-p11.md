# Phase P1.1 — Role model and configuration (issue #84)

Worktree `D:\git\omr-rta-p11`, branch `rta/p11`. Plan: `docs/plans/role-tier-assurance-delegation-plan.md` §2.2, §2.3, §2.7, §2.8, §5 P1.1, §9 R6.

## Pre-flight

| Step | Result |
|---|---|
| Worktree | `D:\git\omr-rta-p11` on `rta/p11` from `origin/rta/main` @ `2ab0c40` |
| `npm ci` | ok |
| `npm run typecheck` | exit 0 |
| Baseline `npx vitest related src/router/config.ts src/router/plugin-agents.ts` | 96 files / 8910 tests passed |
| Baseline `test/unit/docs-drift.test.ts` | 38 passed |
| `src/routing/commands/v1-roles.ts` wording | checked; the new v1 notice does not collide |
| Ownership (§4) | no conflict with another active phase |
| Base checkout `D:\git\opencode-model-router` | clean |

## Implementation

| Commit | Purpose |
|---|---|
| `a5dd117` | Contract commit: `RoleKind`, `AuthorityAction`, `RoleSpec`, `RolesRoutingConfig`, `ExplorationConfig`, `RunConfig`, `resolveRoles` stub (`src/router/roles.ts`) |
| `face379` | Config keys `routing.delegation`, `roleAgents`, `routing.exploration`, `routing.run`, `routing.workRoots`: total per-entry sanitisers, layer rules (project layer stripped), `narrowRoleSpec` (narrowing only), `workRootProblem`, `resolveRolesRouting` (`src/router/roles-config.ts`, `src/router/config.ts`) |
| `80af61f` | Merge of `origin/rta/main` (contract commits of the other Wave 1 phases) |
| `d6fbf89` | Shipped role specs, separation validator (I4), `resolveRoleTable`/`resolveRoles`, #81 same-name agent check, default `routing.run.commands` |
| `68f0e78` | Custom prompts keep the contract; `CONFIG_REFERENCE.md` rows for the new keys; docs-drift guards; T1.1.7 edge cases |
| `77df20d` | QA round 1 fixes (11 findings) |
| `aab48c4` | QA round 2 fixes (5 findings) |

Shipped roles (`SHIPPED_ROLE_SPECS`, `src/router/roles.ts`); every deny list is the complement of the allow list, so `execute` is denied to all and no role gets `subagent`/`task`/`delegate`:

| Agent | Kind | Mode | Allow | Tier range | Assurance | Guard | Budget |
|---|---|---|---|---|---|---|---|
| explorer | explore | fixed | read, glob, grep, router_git | fast–medium | none | reader | 30 / 40 / — |
| researcher | research | fixed | webfetch, websearch, context7 | fast–medium | none | reader | 30 / 40 / — |
| runner | run | fixed | local + router_run | fast–medium | deterministic | reader | 25 / 40 / — |
| implementer | implement | dynamic | local + edit + router_run | fast–heavy | none | producer | 40 / 80 / 120 |
| reviewer | review | fixed | local + router_run | heavy–heavy | none | reader | — / — / 120 |
| architect | design | fixed | local | medium–heavy | none | reader | — / 80 / 120 |
| general | general | dynamic | local + edit + router_run | fast–heavy | none | producer | 40 / 80 / 120 |

Key decisions:

| Decision | Reason |
|---|---|
| Role specs live in code, not in `tiers.json` | Authority never comes from a file deep-merged with user layers; a `tiers.json` `roleAgents` block would trigger the v1 notice on every load, produce unknown-field notices, change tiers mode (I1) and break the docs-drift top-level-key guard. `roleAgents` only narrows. |
| Default `routing.run.commands` `test-files` = `npm run test --` with args `test/*`, `--maxWorkers=*` (`DEFAULT_RUN_COMMANDS`, `roles-config.ts`) | Package scripts take no caller args (P1.3 handoff); the npm path is `router_run`'s hardened one; confinement (`..`, absolute/drive paths, `-`/`@`/`+` leads) is enforced by `router_run` (P1.3 `05988f9`). A user `commands` block replaces it. |
| Implementer/general assurance `none` | Effective detection is `deterministic` when the gate runs, else the weaker of route-line claim and `[acceptance]` block (§2.1); the role default applies only when neither exists. |
| `general` replaces the host-native `general` in roles mode only (`HOST_NATIVE_ROLE_NAMES`) | Role agents are router-registered (R6/P-19); tiers mode and v1 untouched. |
| Cost-inverted presets disable the affected roles (`costInversion`) | §2.3 floors are tier names; an order such as heavy < medium would invert them. Fail closed; bundled presets are unaffected. |
| Custom prompts always end with the `Router contract (overrides the text above):` block | Customisation can neither drop nor neutralise the work-root rule, return contract and edit-denied rule. |
| Role-table notices in `/router`, prefixed `roles mode (OpenCode v2 only): ` | Narrowing issues reach the user; the prefix keeps them true on v1. |

## Tests

| Run | Result |
|---|---|
| `npx vitest run test/unit/roles.config.test.ts test/unit/docs-drift.test.ts test/unit/roles.import-order.test.ts --maxWorkers=4` | 3 files / 135 tests passed |
| `npx vitest related src/router/roles.ts src/router/config.ts src/router/roles-config.ts --run --maxWorkers=4` | 98 files passed, 3 skipped; 9007 tests passed, 56 skipped |
| `npm run typecheck` | exit 0 |
| Existing tests modified | none (goldens unchanged, I1) |

| Coverage (the three files above) | Branches | Statements | Functions | Lines |
|---|---|---|---|---|
| `src/router/roles.ts` | 98.78% | 98.38% | 97.82% | 98.93% |
| `src/router/roles-config.ts` | 91.03% | 94.27% | 100% | 93.69% |

## Findings

Round 1: FAIL (3 major, 6 minor, 2 nit), all fixed in `77df20d`.

| Id | Severity | Finding | Fix |
|---|---|---|---|
| QA-P11-1-1 | major | Role-table notices never reached `/router` | `buildConfig` → `applyRoleNotices` in roles mode; v1 notice handed off to P2.1 |
| QA-P11-1-2 | major | Placed ranges could contain tiers without a budget | `placeRange` walks the cost order; `placeBudget` fills gaps; `budgetGaps` re-check |
| QA-P11-1-3 | major | `test/*` could admit `test/../../x` | Kept; confinement documented as `router_run`'s (P1.3); pattern test |
| QA-P11-1-4 | minor | Contract lines could be neutralised | Fixed delimited contract block always appended |
| QA-P11-1-5 | minor | Assurance `none` vs "from the prompt" | Kept `none`; §2.1 rule documented |
| QA-P11-1-6 | minor | 8.3 check only on the static prefix | Checked on every segment |
| QA-P11-1-7 | minor | Exploration rate effective in tiers mode; `workRoots` not a roles key | Rate 0 unless roles; `workRoots` counted |
| QA-P11-1-8 | minor | `deny` could empty a role | `DEFINING_CLASS`; role disabled with a notice |
| QA-P11-1-9 | minor | `general` host-native rule undocumented | `HOST_NATIVE_ROLE_NAMES`, comment, docs |
| QA-P11-1-10 | nit | Frozen Map writable via `Map.prototype`; shared empty table | `RoleMap` with a private map; fresh empty table |
| QA-P11-1-11 | nit | `DEFAULT_RUN_COMMANDS` location | Moved to `roles-config.ts` |

Round 2: PASS with 3 minor + 2 nit, all fixed in `aab48c4`.

| Id | Severity | Finding | Fix |
|---|---|---|---|
| QA-P11-2-1 | minor | Role-table notices false on v1 | `ROLE_NOTICE_PREFIX` on every role-table notice |
| QA-P11-2-2 | minor | `applyRoleNotices` could throw out of `loadConfig` | try/catch, one failure notice; test seam `setRoleTableResolverForTest` |
| QA-P11-2-3 | minor | Cost-inverted presets invert §2.3 floors | `costInversion` disables the role (fail closed) |
| QA-P11-2-4 | nit | No test loading `roles.ts` before `config.ts` | `test/unit/roles.import-order.test.ts` |
| QA-P11-2-5 | nit | `RoleMap` inspection | `Symbol.toStringTag` `RoleMap`; inspect hook returning a copy of the map |

## Handoffs

| To | Item |
|---|---|
| P2.1 | Log the v1 notice: call `resolveRolesRouting(cfg, host, logger)` next to `resolveRouting` at `src/index.ts` ≈474 |
| P2.1 | Consume `RoleTable.droppedAgents` / `replacedRoles` at registration, passing the real context7 flag to `resolveRoleTable` |
| P2.1 | Register `general` (from `HOST_NATIVE_ROLE_NAMES`) replacing the host-native agent in roles mode only (T2.1.1) |
| Wave 1 integration | P1.2's `roleTierOrder` must use `presetTierOrder` (`src/router/roles.ts`) |
| Wave 1 integration | P1.3 must merge before roles mode can run the default `test-files` command |
| P3.2 | `CONFIG_REFERENCE.md` already documents the new keys; role details belong in `docs/ROLES.md` |

## Takeovers

None.

## Verdict

PASS — 0 open blocking, critical or major findings.
