# Phase P2.2 report: orchestrator surface (issue #84)

Goal: the orchestrator sees roles on v2 roles mode; stats and advisor speak roles.

## Pre-flight

| Item | Result |
|---|---|
| Worktree | `D:\git\omr-rta-p22` on `rta/p22`, from `origin/rta/main` @ e76f417 |
| Install | `npm ci` ok |
| Typecheck | 0 errors |
| Baseline related run over the nine P2.2 files | 98 files / 8283 tests passed |
| Contract commit | 425dd19, merged into `rta/main` (d1830ad) |

## Implementation

| Commit | Content |
|---|---|
| 425dd19 | T2.2.0: `buildRolesProtocol` contract |
| 546bcc4 | T2.2.1: roles protocol, `R:` line class → role, no per-turn hint in roles mode (heavy producer) |
| 8603fa8 | Roles protocol golden and I1 checks (heavy producer) |
| 345dee6 | T2.2.2: seven advisor findings (`findings.ts`, `index.ts`) |
| 2b38fff | T2.2.3/T2.2.4: `/router` role lines, role × tier stats, integration test |
| 10f1d5e | QA round 1 fixes, advisor and stats |
| f1b39db | QA round 1 fixes, protocol |
| b55736d | QA round 2 fixes |

Final roles protocol size: at most the tiers protocol on every preset, asserted by the size guard in `test/golden/roles-protocol.golden.test.ts` (green at b55736d; after round 1 it measured 3256 B against 3282–3346 B for the tiers protocol, 4139–4203 B with the advise/enforce route-line paragraph). The round-2 wording change pushed it 19 bytes over on the smallest preset, so the work-root aside was shortened to "(quote a path with spaces)".

Surface added:
- Roles protocol, `R:` line and the absent hint part appear only on v2 roles mode with at least one enabled role. Tiers mode and v1 are byte-identical to before.
- Advisor findings take a new optional `AdvisorExtras` argument (`host`, `roleStats`, `tierDispatches`). A missing `host` is unknown and keeps every role check silent.
- `/router` lists enabled roles (`buildRoleLines`, `buildRouterHelp({ roles })`).
- `runStatsCli` appends the "By role × tier" section only when the log has a role dispatch bucket or an unknown-binding row. Tier-only logs, including ones with tier verdict signal rows, render byte-identical, and `--json` gains `roles` only in the role case.

Advisor findings:

| id | Severity | Fires when |
|---|---|---|
| `role-separation` | warning | roles mode on v2, a `agents` entry named like a shipped role breaks the separation rule |
| `roles-on-legacy-host` | info | host is v1 and delegation is `roles` |
| `roles-none-enabled` | info | roles mode on v2 with no enabled role (tier protocol is used) |
| `role-budget-low` | warning | a role has at least 5 dispatches and budget exhaustions are at least 20% of them |
| `role-range-clamped` | info | role table issue on `tierRange` or `budget` |
| `role-binding-unknown` | warning | unknown-binding rows in the role stats |
| `native-explore-aliased` | info | roles mode on v2 with `explorer` enabled |
| `role-usage-share` | info | at least 5 dispatches in total and at least one tier dispatch |

## Tests

| Suite | Result |
|---|---|
| `test/golden/roles-protocol.golden.test.ts` (existing from 8603fa8, extended in b55736d) | passes together with the integration file: 50 tests in the last run |
| `test/integration/roles-protocol.test.ts` (new, extended in 10f1d5e) | passes |
| `test/unit/docs-drift.test.ts` (round 1 check) | passes, 67 tests with the integration file |
| `vitest related` after round 1 (advisor, stats, output) | 57 files passed, 3 skipped; 1827 tests passed, 55 skipped |
| `vitest related` after round 2 (protocol, prompts, hint) | 101 files passed, 3 skipped; 8335 tests passed, 55 skipped |
| Typecheck | 0 |

No existing test was modified, except that the golden file was edited in round 2 for the new wording. Integration coverage: tiers-mode protocol byte-identical; roles protocol on v2 roles mode; disabled role absent; v1 never shows roles; each finding fires and clears; unknown host silent; stats with mixed tier and role rows; tier-only log with a verdict signal unchanged; `/router stats` equals the driver output and the real script (the script test is `skipIf` when Node cannot run it).

## Findings

Round 1: FAIL (4 major, 8 minor, 3 nit, all fixed). Round 2: PASS (1 minor, 3 nit, fixed in b55736d).

| Id | Severity | Subject | Fix |
|---|---|---|---|
| QA-P22-1-2 | major | missing `extras.host` treated as v2 | 10f1d5e |
| QA-P22-1-3 | major | tier verdict signals triggered the role stats section | 10f1d5e |
| QA-P22-1-1, 1-4 | major | protocol (route line, runtime parts) | f1b39db; runtime parts of 1-4 handed to P2.1 |
| QA-P22-1-5 | minor | roles config with no enabled role must keep the tiers hint | f1b39db |
| QA-P22-1-6 | minor | protocol runtime part | f1b39db; runtime part handed to P2.1 |
| QA-P22-1-8 | minor | tier agent is the exception for a command `router_run` refuses | f1b39db |
| QA-P22-1-10 | minor | budget message "NEED MORE: budget" | 10f1d5e |
| QA-P22-1-12 | minor | record out-of-list edits | recorded below |
| QA-P22-1-13 | nit | `rolesOnV1` renamed `rolesOnLegacyHost` | 10f1d5e |
| QA-P22-1-14 | nit | `buildRoleLines` skips disabled roles | 10f1d5e |
| QA-P22-1-15 | nit | docs wording "an `agents` entry" | 10f1d5e |
| `roles-none-enabled` | added in round 1 | new info finding | 10f1d5e |
| QA-P22-2-1 | minor | one `router_run` sentence whenever any enabled role allows it | b55736d |
| QA-P22-2-2 | nit | restore "(where the role allows them)" | b55736d |
| QA-P22-2-3 | nit | runner intent "scripts and commands" | b55736d |
| QA-P22-2-4 | nit | roles heading matched only at a line start | b55736d |

The remaining round-1 minors not itemised above were all fixed in f1b39db (confirmed by the round-2 review): 1-7 (`d=` counts only when an `[acceptance]` block backs it), 1-9 (quote a `root=` path with spaces), 1-11 (taxonomy moved to the leaf module `src/routing/engine/roles-taxonomy.ts`, no import cycle).

Deviations recorded (executor amends §4):

| Deviation | Reason |
|---|---|
| Edits outside the ownership list: `src/routing/outcomes/stats.ts`, `src/routing/outcomes/index.ts`, `docs/ROUTING_ENGINE.md` | `runStatsCli` is shared by `/router stats` and the script, so rendering there guarantees identical role rows; the docs table must list every finding id for docs-drift |
| Finding id `roles-on-legacy-host` instead of `roles-on-v1` | the docs-drift id regex `[a-z-]+` has no digits and that test could not be modified |

## Handoffs

| To | Item |
|---|---|
| P2.1 | call `assembleRolesSystemPrompt` at the injection site |
| P2.1 | pass advisor extras with `host` (and `roleStats`, `tierDispatches`) to `runAdvisor` and the notifier `gather()`; until then all role checks are silent |
| P2.1 | emit the budget note with `ROUTER_BUDGET_NOTE_PREFIX` |
| P2.1 | role hint after a verification FAIL ("the router raises the tier") |
| P2.1 | refuse malformed route lines for roles |
| P2.1 | pass `roles` to `buildRouterHelp` for the `/router` role lines |
| P3.2 | `ROLES.md` describes the protocol |

## Takeovers

None.

## Verdict

PASS. 0 open blocking, critical or major findings.
