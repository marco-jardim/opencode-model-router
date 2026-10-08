# Phase P1.2 — Policy core, route-line keys and engine support (#84)

Plan: `D:\git\omr-rta-main\docs\plans\role-tier-assurance-delegation-plan.md` §2.1, §2.3, §2.4, §2.6, §5 P1.2, §9 R6/R7.
Worktree `D:\git\omr-rta-p12`, branch `rta/p12`.

## Pre-flight

| Check | Result |
|---|---|
| Worktree | `D:\git\omr-rta-p12` on `rta/p12`, from `origin/rta/main` @ `2ab0c40` |
| `npm ci` | ok |
| Typecheck (`tsc --noEmit`) | exit 0 |
| Baseline `vitest related` over the seven P1.2 files | 59 files / 2243 tests passed |
| Contracts merged before the first commit | P1.1 (role model) and P1.4 (outcome signals) |
| File ownership | no conflicts (P1.2 files only) |

## Implementation

| Commit | Task | Purpose |
|---|---|---|
| `46ad5ac` | T1.2.0 | Contract commit: route-line keys `tier=`, `budget=`, `root=` (`RouteLine` fields), policy signatures |
| `c0ba8b2` | T1.2.1 | `grantFor` (fixed/dynamic, needs mapping, separation rule I4, work root) and `authorityFloor` (§2.3 table) |
| `eef9939` | T1.2.2 | `tierBounds`: role range ∩ authority floor ∩ `floorTier` ∩ running rung, raise-only risk/scope, pin lift/clamp |
| `f5ae743` | — | Merge of `origin/rta/main` (P1.6 binding contracts, smoke alignment) |
| `98cc973` | T1.2.3 | `buildRoleLadder`, `roleEscalatePolicy`, `decideRole`: role rungs of `[floor, ceiling]` keyed `class\|role:<agent>\|provider/model#variant`, static default = class tier clamped, pin, resume never below the running rung; tier-mode `decide` untouched |
| `ede6438` | T1.2.4 | Exploration: `enforce` only, rate ≤ 0.2 (default 0), never pinned/resume/high-risk/non-deterministic, only to a rung ≥ floor and < the static default (reason `explore`), seeded by `decisionID`; `explore` and `propensity` on the decision |
| `41baf68` | T1.2.5 | `test/unit/roles.kernel.test.ts` (role ladders, pin, resume, exploration, simulate == runner, I2 property) |
| `bc8a596` | QA r1 | QA-P12-1-1, -2, -3, -4, -5, -7, -8 |
| `795f345` | QA r1 | QA-P12-1-6, -9 |
| `d204ccf` | QA r2 | QA-P12-2-1, -2, -3 |

Contract deviations (recorded by the executor as plan amendment R7):

| §2.4 contract | As shipped |
|---|---|
| `tierBounds(role, grant, facts: TaskFacts, detection: Detection, opts)` | `tierBounds(role, grant, classified: ClassifiedDispatch, detection: EffectiveDetection, opts)`; raise-only risk/scope computed inside from `facts`, `trace.rules`, `trace.routeLine` |
| `Detection` passed through | `EffectiveDetection` is computed by `effectiveDetection({ routerGate, claim, acceptance })` (A34: `deterministic` only from the router's gate, otherwise the weaker of claim and acceptance, capped at `grader`); only `roles/policy.ts` may cast to it (test-enforced) |
| `workRoot: null → no router_run` | `workRoot: null` = no validated root for a known binding → no write and no run (`edit`, `router_run` withheld); not the unknown-binding grant (max ∩ LOCAL) |
| Tier order supplied by the caller | `roleTierOrder(cfg, session)` is the one order for `tierBounds({ tiers })` and the role ladder |
| — | `RoleDecision.dispatch === null` (`window:no-candidates`) → the caller refuses the role dispatch; no fallback to `buildEscalatePolicy` |

### Incident — base checkout modified by a .NET file API

| Item | Record |
|---|---|
| Session | `ses_ee61306b7ffeyST3MJoDdHFEeb` (contract-commit producer) |
| Command | `cd D:\git\omr-rta-p12; [IO.File]::WriteAllText('src\…')` |
| Effect | .NET resolved the relative path against the process directory, not the shell location: `src\routing\classify\route-line.ts` and `types.ts` were modified in the BASE checkout `D:\git\opencode-model-router` |
| Content | identical to `46ad5ac` |
| Recovery | the executor restored both files with `git checkout --`; nothing was loaded by the host |
| Mitigation | every later dispatch forbids .NET file APIs (`[IO.File]`, `Set-Content`, `Out-File`) and writes in the base checkout; edits only through edit/write tools with absolute paths |

## Tests

| Run | Result |
|---|---|
| `npx tsc --noEmit` | exit 0 before every commit |
| `npx vitest run test/unit/roles.kernel.test.ts test/unit/roles.policy.test.ts test/unit/route-line.roles.test.ts --maxWorkers=4` | 3 files, 157 tests passed |
| `npx vitest related src/routing/engine/kernel.ts src/routing/classify/route-line.ts src/routing/classify/types.ts src/routing/roles/policy.ts --run --maxWorkers=4` | 61 files passed (3 skipped), 2149 tests passed (55 skipped) |
| Existing tests | unmodified (engine index export list kept: no new export in `engine/index.ts`) |
| Tier-mode decisions | byte-identical (`decide` and `buildLadder` unchanged; their suites green) |

Coverage (v8, the three P1.2 suites only):

| Code | Branches | Statements |
|---|---|---|
| `kernel.ts` role section (`decideRole`, exploration, helpers) | 79/81 = 97.5% | 76/77 = 98.7% |
| `ladders.ts` role section (`roleTierOrder`, `roleEscalatePolicy`, `buildRoleLadder`) | 58/64 = 90.6% | 108/113 = 95.6% |
| `roles/policy.ts` (whole file) | 134/135 = 99.3% | 156/156 = 100% |
| `classify/route-line.ts` (whole file; its tier-mode paths are covered by the other route-line suites in the related run) | 107/186 = 57.5% | 117/180 = 65.0% |

Properties: I2 (no role dispatch outside `[floor, ceiling]` or below the authority floor, 600 seeded cases); I4 and "grant within the role max" (4000 + all shipped roles × needs); raise-only bounds (6000 cases); simulate == runner on role ladders (four windows, independent runner loop).

## Findings

| Id | Round | Severity | Finding | Fix |
|---|---|---|---|---|
| QA-P12-1-1 | 1 | major | Raise-only risk/scope depended on optional fields; a claimed detection could pass as effective | `bc8a596`: classify-shaped `tierBounds`/`decideRole`, branded `EffectiveDetection` |
| QA-P12-1-2 | 1 | major | `workRoot` null dropped only `router_run`; edits could land in the session directory | `bc8a596`: null root → `edit` and `router_run` withheld + note |
| QA-P12-1-3 | 1 | minor | Resume off the ladder kept the static default (could be below the running rung) | `bc8a596`: raise to the capability rank; unknown → ceiling (`resume:off-ladder:lift`) |
| QA-P12-1-4 | 1 | minor | Unknown floor names were skipped (floor dropped) | `bc8a596`: unknown floor name → top of the order |
| QA-P12-1-5 | 1 | minor | Empty window → silent null dispatch; tier order could differ between bounds and ladder | `bc8a596`: `window:no-candidates`, `roleTierOrder`, refuse-on-null handoff |
| QA-P12-1-6 | 1 | minor | `root=` accepted UNC, `\\?\`, `\\.\`, `..`; malformed first `[route` line silently ignored | `795f345`: local roots only; `RouteLineParse.malformed` |
| QA-P12-1-7 | 1 | nit | `buildRoleLadder` restated the window policy | `bc8a596`: uses `roleEscalatePolicy` |
| QA-P12-1-8 | 1 | nit | Pin reason did not show a dispatched tier other than the requested one | `bc8a596`: `pinned:<requested>-><dispatched>` |
| QA-P12-1-9 | 1 | nit | `RouteLine.root` source undocumented | `795f345`: read only from `trace.routeLine`; `]` limitation; compare handoff |
| QA-P12-2-1 | 2 | minor | `effectiveDetection` was an identity brand | `d204ccf`: computes A34 from `{ routerGate, claim, acceptance }`; cast scan test |
| QA-P12-2-2 | 2 | nit | `"malformed"` also added to a parsed line's `ignored` | `d204ccf`: flag on the parse only; optional `ClassifyTrace.routeLines.malformed` (type) |
| QA-P12-2-3 | 2 | nit | `grantFor(…, null)` could be mistaken for the unknown-binding grant | `d204ccf`: docs + test (researcher: null root keeps egress, unknown binding = max ∩ LOCAL) |

Round 1: FAIL (2 major, 4 minor, 3 nit) — all fixed. Round 2: PASS with 1 minor + 2 nit — all fixed.

## Handoffs

| To | Item |
|---|---|
| P2.1 | Carry `RouteLineParse.malformed` into `ClassifyTrace.routeLines.malformed` (`classify/index.ts`) and refuse a role dispatch whose first line is a malformed route line |
| P2.1 | Build the detection only with `effectiveDetection({ routerGate, claim, acceptance })`; never pass `ClassifyResult.detection` as effective |
| P2.1 | `RoleDecision.dispatch === null` → refuse the role dispatch; never fall back to `buildEscalatePolicy`/`buildLadder` or a tier agent |
| P2.1 | The role runner uses `roleEscalatePolicy(cfg, window, session)` (the policy the simulated paths use: simulate parity) |
| P2.1 | Normalise the `root=` text and compare it with `git worktree list --porcelain` before any filesystem call; no match → `workRoot` null |
| P2.1 | Pass `roleTierOrder(cfg, session)` as `tierBounds(…, { tiers })` |
| P2.1 | Import the role API from `src/routing/engine/kernel.ts` (`decideRole`, `explorationRate`, `MAX_EXPLORATION_RATE`) and `src/routing/engine/ladders.ts` (`buildRoleLadder`, `roleEscalatePolicy`, `roleTierOrder`): `engine/index.ts` exports are pinned by an existing test |
| P1.6 / P2.3 | An unknown binding is the role max ∩ LOCAL; never `grantFor(…, null)` |
| Wave 1 integration | `roleTierOrder` must use P1.1's `presetTierOrder` once merged |

## Takeovers

None. A lost session was re-dispatched fresh; transport failures were resumed in the same session.

## Verdict

**PASS** — 0 open blocking, critical or major findings; every round-1 and round-2 finding is fixed with a test.
