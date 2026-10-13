# Phase 4.1 — Operator surface: `router_plan`, `/plan`, executor config and user docs

Plan: `D:\git\omr-cpx-main\docs\plans\critical-path-execution-plan.md` (Phase 4.1). Worktree `D:\git\omr-cpx-p41`, branch
`cpx/p41`, base `cpx/p41-base` = `5653701`.

## Pre-flight

- §0.9: worktree clean at `5653701` (Wave 3 merged), `npm ci` done, typecheck green.
- Recon (explorer `ses_eccca8fb6ffe3ol9SaigMk6Ci2`): tool registration (`src\index.ts` `hooks.tool`, `tool()` from
  `@opencode-ai/plugin`; the v2 adapter reuses the v1-shaped map at `src\compat\v2-hooks.ts` ≈2674-2699; the plan's
  ≈1309-1332 anchor is stale), command handling (`buildRouterOutput`, v1 `command.execute.before`, v2
  `ctx.command.transform`), help builder `buildRouterHelp` (`src\commands\output.ts` ≈231-248), trust layer
  (`GLOBAL_ONLY_ROUTING_KEYS`, `stripGlobalOnlyRoutingKeys`, `collectOverrideLayers` notice), `ROUTING_DEFAULTS` /
  `resolveRouting` with the tolerant `background`/`leases` precedent, `ExecutorConfig` and `EXECUTOR_LIMITS`, docs-drift
  pins of the routing table, `defaultSlotsDir`, the `ExecutorRuntime` methods. The explorer could not read the plan's
  Appendix C from the worktree root; the orchestrator pasted the rows into the 4.1.1 dispatch.

## Implementation notes

- 4.1.1 `24ccd00`: `routing.executor.*` (19 leaves) in `ROUTING_DEFAULTS`, tolerant `sanitizeExecutor`, limits from
  `EXECUTOR_LIMITS` (match Appendix C), trusted keys in `GLOBAL_ONLY_ROUTING_KEYS`, `slotsDirProblem` (resolve-time) and
  exported `validateSlotsDir(path, toplevel)` (approve-time), v1 notice, CONFIG_REFERENCE rows + Trust paragraph. The
  orchestrator extended the "Default column" drift pin to the executor leaves.
- 4.1.2 `b0a9abc`: `createRouterPlanTool(runtime, { approve })` with a strict schema, ownership-error hints, an inbox
  view (`status inbox=true`), and `answer` without `planId` resolved to the calling session's plan. Decision: the
  `approve` option is a getter; 5.1 passes `config.executor.approve`.
- 4.1.3 `f2182e5`: `createPlanCommand`, `/plan` subcommands, `buildRouterHelp({ plan })` v2-only lines (v1 help
  byte-identical), the v1 notice names "the plan executor".
- 4.1.6 `9562235`: `createExecutorInstructionsProvider` (turn-state section, order after the plan provider).
- 4.1.4 `2803498`: `docs\EXECUTOR.md`, the OPENCODE_V2.md section, drift pins, CHANGELOG groundwork entry (applied by the
  orchestrator once the pdf1-3 session released its CHANGELOG lease — the DF-1.1-4 collision, not bypassed).

## Findings

| Round | Reviewer | Commit | Findings | Status |
|---|---|---|---|---|
| 1 | `ses_eccaca574ffe4NWKVmlyQzdJC4` | `2803498` | 2 high (QA-4.1-1 `ask` not a human gate; -2 a project override could reset trusted keys), 5 medium (-3..-7), 8 low/nit (-8..-15) | fixed in `c073f2d`, `0091ee9` |
| 2 | `ses_ecc8eaf31ffeXpSqEM31yCIyNj` | `0091ee9` | 13 fixed, -1 and -9 partial; 1 medium (QA-4.1-16 `ask` wording), 5 low (-17..-21), nits | fixed in `a587a80` |
| 3 (bounded, §0.7) | `ses_ecc7adec9ffeSeg30HGyFVX4oY` | `a587a80` | QA-4.1-16 fixed; no new blocking/critical/major; minors | the two remaining paths (status/ready of an awaiting-approval plan; adopt hints) fixed in `adf1fdb` |

## Fixes

- Round 1 `c073f2d` (config): non-object trusted blocks dropped from the project layer (-2); **A-4.1-2** tighten-only
  project layer for executor keys (-3); `realpathSync.native`, trailing dot/space and 8.3 short-name segments refused
  (-4, config part); v1 notice from the written config (-9); slotsDir sharing documented (-12).
- Round 1 `0091ee9` (surface): **A-4.1-1** `/plan approve`, ask mode never tells the model to approve (-1); session plan
  from `planLine` and `--plan` (-5); relative compile paths resolved (-6); residue/approval follow-up (-7);
  integrationChecks wording (-8); approve getter read only in compile/residue (-10); unterminated-quote help (-11);
  exported `PLAN_PROVIDER_ORDER` (-14); nits (-15).
- Round 2 `a587a80`: explicit not-approved stop (-16); tighten-only rule in EXECUTOR.md (-17); non-object strip limited
  to `executor`, v1 frozen (-18); background/leases/executor notices v2-only on v1 (-19); drive-relative paths refused
  (-20); the merge fallback keeps the global layer and dedupes A18 notices (-21, pre-existing).
- Round 3 `adf1fdb`: `status`/`ready` of an awaiting-approval plan repeat the stop text; `E_NOT_OWNER`/`E_LOCK_HELD`
  hints and EXECUTOR.md never point at adopting an awaiting-approval plan; tool description tightened.

## Coverage

Orchestrator runs on 2026-10-13: config set (21 files, incl. goldens) 1226 passed / 1 skipped; tool/command/
instructions/docs-drift 307 passed; `tsc --noEmit` clean. `src\executor\tool.ts` 91.66 and `src\executor\command.ts`
92.4 branches (measured before the round-2/3 additions, which added tests with the code); `src\router\**` is an
aggregate gate.

## Deferred findings

- QA-4.1 r3 minors: the tool description is shorter than the result text (mitigated: the result text always precedes
  approval); the auto-approve failure hint names `action=approve` (configured consent, `auto` is global-only).
- `src\router\config.ts` `realpathOfExistingPrefix` mangles a bare `C:` tail consistently on both sides (no effect).

## Handoffs

- 5.1: register `router_plan` (passing `{ approve: () => config.executor.approve }`), `/plan`, the help (`plan: true`)
  and the instructions provider (order `PLAN_PROVIDER_ORDER + 1`); call `validateSlotsDir(slotsDir, repo.toplevel)` at
  approve; the runtime refuses adopting an awaiting-approval plan (QA-4.1 r3) and checks ownership before side effects
  (QA-4.1-13); register `router_plan` for orchestrator sessions only.
- 4.2/5.1: EXECUTOR.md sections "Unattended operation", "QA loop" and "Recovery" (text in phase-4.2.md handoffs).

## Plan amendments

- **A-4.1-1** (QA-4.1-1): `/plan approve <planId>` joins the 4.1.3.a subcommands; in `ask` mode approval comes only from
  the user.
- **A-4.1-2** (QA-4.1-3): a project-local override may only tighten executor keys (`approve`→`ask`, `land`→`manual`,
  `crossPhase`→`gate`, numeric budgets and circuit-breaker values only lower); Appendix C "trusted only" is unchanged.

## Verdict

Done at `adf1fdb`: three heavy QA rounds, every finding fixed or dispositioned. Merged into `cpx/main`.
