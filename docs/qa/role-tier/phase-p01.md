# Phase P0.1 — QA report (issue #84, role-tier spikes)

Branch `rta/p01` (from `origin/rta/main`). Deliverables: the spike harness and the gated spike file (`test\smoke\helpers\routing-host.ts`, `test\smoke\role-spikes.smoke.test.ts`) and the results document `docs\qa\role-tier\spikes.md` (S1–S12, amendments P-1…P-19).

## Pre-flight

- `rta/main` created from `origin/docs/role-tier-plan` @ `a8b1905` and pushed; worktree `D:\git\omr-rta-main` + `npm ci`; draft PR #85 `rta/main` → `master`.
- `D:\git\omr-rta-p01` on `rta/p01` from `origin/rta/main`; `npm ci` OK; typecheck exit 0.
- Baseline of the files P0.1 touches: `test\smoke\plugin-agents.smoke.test.ts` + `test\smoke\routing-engine.smoke.test.ts` ungated with `--config vitest.smoke.config.ts` → 2 files skipped / 14 tests skipped.
- Capped full suite on `rta/main` (`npx vitest run --maxWorkers=2`, 353.6 s): `Test Files 1 failed | 152 passed | 3 skipped (156)`, `Tests 1 failed | 12016 passed | 66 skipped (12083)`. The failure is the known flake `test\unit\exec.test.ts` lowPriority (`spawnSync powershell.exe` ETIMEDOUT); re-run alone: 42 passed | 2 skipped.
- Owner enforcement mode: advisory. Base checkout `master` @ `eeab36b`, clean. Override SHA-256 `700E2587…88F8` recorded in `dogfood.md` (executor). Amendment R5 (log-probe filter, `fast` CAP:12, smoke config).
- No file-ownership conflicts (only P0.1 active).

## Implementation

Commits on `rta/p01` (`git log --oneline a8b1905..rta/p01`, oldest first):

| sha | purpose |
|---|---|
| `cc750a8` | spike harness for agents without a model (probe options, `agentWithoutModel`, second provider, `hostConfigOnDisk`, `loopProbe`) |
| `e57a5d7` | role spikes S1 S2 S4 S7 |
| `f6ccbf0` | role spikes S3 S6 S8 S9 (per-session `bySession` probe decisions, `afterAppend`, `rewriteAgent`) |
| `d39855a` | role spikes S10 S11 S12 (`wt_probe` tool, `denyAsk`, `hostConfig` as a function, `toolDefs`) |
| `98a7922` | S11: plugin-tool permission and `evaluate` on allowed external paths |
| `4772672` | `spikes.md` first version (S1–S12, amendments) |
| `c3dad26` | QA round 1 (area 1): `SPIKE_CALLS` + request barrier, nonce, distinct S1 root, parent-request evidence for S4, S7 history |
| `fc8e2d3` | `spikes.md` round-1 corrections S1 S2 S4 S7 |
| `f03db6f` | QA round 1 (area 2): S3 overlap and throwing evaluate (edit/write), S6 order/background, S9 rewritten-agent edit, S10 parent request |
| `c498bbe` | S11: nested paths, `wt-evil`, spelling variants, session grant, `execute` catalog, researcher egress, `router_git_status` |
| `7878fd3` | S11 repeated with agents defined in the router override |
| `3181aa2` | S12: new agent, tightened permission, removed agent, resumed child |
| `4814bb8` | `spikes.md` round-1 corrections for area 2, amendments P-1…P-19 |
| `c2dde77` | QA round 2 (area 1): S1 root model, S2 ordering, exact envelopes, barrier timers |
| `b4481a0` | QA round 2: S6 background with verification on and off, S2 background children |
| `9eea441` | QA round 2: S11 router-agent catalog under an allow-all parent, win32 guards |
| `6cc7238` | restore indentation of two spike blocks |
| `ba501a6` | `spikes.md` round-2 corrections |
| (this commit) | `spikes.md` round-3 fix (P-2, P-3, P-17) and this report |

Spike S5 (T0.1.2, code reading, no host run) facts: the criterion is cut at `src\verify\dod.ts:62` (`summarizeDispatch` → `trimmed.slice(0, 120)` of the first non-empty line); `inferDoD` (`dod.ts:254-260`) pushes it as the sole criterion when no check applies; the path is `src\index.ts:1732-1734` (prepends `buildDispatchHeader`, `src\router\dispatch-header.ts`, to `args.prompt`) → `index.ts:1883-1886` `buildDelegationDoD({prompt, description})` → `src\verify\dispatch.ts:552-561` (no block → `inferDoD`). On v2 the mutated object is NOT the one read later: the data flows through `event.input` (`v2-hooks.ts:528` → `:584`) and `translateAdded` (`:524-527`). The header is added only for active tiers (`index.ts:1718-1724`). `NOT ACCEPTED` rendering (`dispatch.ts:598-613`) does not truncate.

## Tests

- Gated spikes: `$env:RUN_OC_SMOKE_ROLE_SPIKES='1'; npx vitest run --config vitest.smoke.config.ts test/smoke/role-spikes.smoke.test.ts` → `Test Files 1 passed (1)`, `Tests 16 passed (16)` (264.9 s, run at `6cc7238`; later commits change `spikes.md` only).
- Ungated: `plugin-agents` + `routing-engine` → `2 skipped (2)` files / `14 skipped (14)` tests (unchanged from the baseline); with `role-spikes` → `3 skipped (3)` / `30 skipped (30)`.
- Existing callers of the changed harness, gated (`RUN_OC_SMOKE_ROUTING=1`, `routing-engine` + `plugin-agents`): `Test Files 1 failed | 1 passed (2)`, `Tests 1 failed | 13 passed (14)`. The one failure is scenario `6 v1 untouched`: its pinned base `71815eb` predates 14 smoke/package changes already on master (`git diff --name-status 71815eb a8b1905 -- test/smoke package.json`). Pre-existing, independent of the harness change; handed off to P3.1.
- Typecheck (`npm run typecheck`): exit 0 before every commit.
- Tracked evidence files rewritten by the gated routing run (`docs\qa\cost-aware-routing\evidence-3.2\*`) were restored with `git checkout`; no evidence was written into `docs\qa\cost-aware-routing`.

## Findings

Round counts: round 1 — 36 findings (15 major, 15 minor, 6 nit), all fixed; round 2 — 17 (4 major, 8 minor, 5 nit), all fixed; round 3 — area 1 PASS (3 minors), area 2 FAIL with 1 major (fixed in this commit) plus 7 minors.

### Round 1 (`p01-qa-r1.md`)

| id | severity | status |
|---|---|---|
| QA-P01-1-1 | major | fixed |
| QA-P01-1-2 | major | fixed |
| QA-P01-1-3 | major | fixed |
| QA-P01-1-4 | major | fixed |
| QA-P01-1-5 | major | fixed |
| QA-P01-1-6 | major | fixed |
| QA-P01-1-7 … 1-14 | minor (8) | fixed |
| QA-P01-1-15 … 1-17 | nit (3) | fixed |
| QA-P01-2-1 … 2-9 | major (9) | fixed |
| QA-P01-2-10 … 2-16 | minor (7) | fixed |
| QA-P01-2-17 … 2-19 | nit (3) | fixed |

### Round 2 (`p01-qa-r2.md`)

| id | severity | status |
|---|---|---|
| QA-P01-R2-1-1 | major | fixed |
| QA-P01-R2-1-2 … R2-1-5 | minor (4) | fixed |
| QA-P01-R2-1-6 … R2-1-8 | nit (3) | fixed |
| QA-P01-R2-2-1 | major | fixed |
| QA-P01-R2-2-2 | major | fixed |
| QA-P01-R2-2-3 | major | fixed |
| QA-P01-R2-2-4 … R2-2-7 | minor (4) | fixed |
| QA-P01-R2-2-8, R2-2-9 | nit (2) | fixed |

### Round 3

| id | severity | status | text (short) |
|---|---|---|---|
| area 1 | — | PASS | no blocking finding |
| QA-P01-R3-1-m1 | minor | accepted — QA round limit | `spikes.md` S2 "exactly ONE dispatch was pending" slightly overstated (the probe's before record is written after the router's hook) |
| QA-P01-R3-1-m2 | minor | accepted — QA round limit | P-5 should key on "the call is not verifying" (`TASK_VERIFICATION` flag absent) rather than mode/require, since `index.ts:1641-1665` also requires not bypassed, string `callID`/`sessionID` and the depth guard to pass |
| QA-P01-R3-1-m3 | minor | accepted — QA round limit | `routing-host.ts:773` `callMany` fails on earlier provider errors; compare against an error count taken at start |
| QA-P01-R3-2-1 | major | fixed (this commit) | P-3 stated two incompatible on-error catalogs → now: any context-hook error ⇒ EMPTY catalog (as `v2-hooks.ts:406-410`), annotated in `execute.after`; unknown/absent binding without an error ⇒ max policy ∩ local actions; P-2, P-3, P-17 consistent; P3.1 "I9 (hook error)" expects an empty catalog |
| QA-P01-R3-2-(1) | minor | accepted — QA round limit | a user can background a running foreground call (`v2-hooks.ts:560-561`); the final result bypasses `execute.after` → role dispatches should get a notice on the running ack |
| QA-P01-R3-2-(2) | minor | accepted — QA round limit | P-5 forced foreground should use a separate force-foreground flag, not `verifying` (the running ack would say "not verified", `:564`, and the call would enter `verifyingCalls`) |
| QA-P01-R3-2-(3) | minor | accepted — QA round limit | router hooks act only when `protectedAgent()` is true (`v2-hooks.ts:183-184`) — a precondition for role agents; unit-test it |
| QA-P01-R3-2-(4) | minor | accepted — QA round limit | `execute` must be absent from the role's whole max policy, not only the floor grant (the strip reads `agent.permissions`) |
| QA-P01-R3-2-(5) | minor | accepted — QA round limit | P-17: narrowing to the dispatch grant is always router-side (P2.3) whatever the parent grants |
| QA-P01-R3-2-(6) | minor | accepted — QA round limit | P-2 nonce changes description/prompt → roles mode only (I1) |
| QA-P01-R3-2-(7) | minor | accepted — QA round limit | P-11: `realpathSync.native` cannot canonicalise a glob root → canonicalise the static prefix and keep the glob tail |

Open blocking/critical/major after round 3: 0.

## Handoffs

| item | owner |
|---|---|
| R3 area 1 m2; R3 area 2 (1), (2) — running-ack notice, separate force-foreground flag, key P-5 on "not verifying" | P2.1 |
| R3 area 2 (3), (4) — `protectedAgent()` precondition with a unit test; `execute` absent from the whole max policy | P1.1 / P2.1 |
| R3 area 2 (5) — dispatch-grant narrowing always router-side | P2.3 |
| R3 area 2 (6) — nonce in roles mode only (I1) | P2.1 |
| R3 area 2 (7) — canonicalise the static prefix of a glob work root | P1.1 |
| R3 area 1 m1, m3 | none — accepted |
| scenario `6 v1 untouched` (`routing-engine.smoke.test.ts`), stale pin `71815eb` | P3.1 |
| amendments P-1 … P-19 (`docs\qa\role-tier\spikes.md`, "Proposed amendments") → plan amendments | executor (plan R6) |

## Takeovers

None.

## Verdict

PASS — 0 open blocking/critical/major after round 3.
