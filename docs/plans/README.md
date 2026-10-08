# Plans index

This directory holds design/implementation plans for `opencode-model-router`.

## Active plans

- [`model-router-enforcement-and-verification-plan.md`](./model-router-enforcement-and-verification-plan.md)
  — Enforced Delegation Architecture (three-layer enforcement-and-verification:
  hard-block guard → independent acceptance gate → quality escalation ladder)
  on top of the existing prompt-based router. Covers both usage modes:
  on-the-fly orchestrator delegation and `[tier:X]`-annotated plan execution.
- [`verification-resource-budget-plan.md`](./verification-resource-budget-plan.md)
  — Verification Resource Budget (target `1.15.0`): the acceptance gate stops
  running a test suite per delegation. Affected-test scoping, a failure-only
  recheck at a git dispatch reference, a machine-wide verification slot,
  low-priority capped runs, batching, and deferred verification on the
  orchestrator's terms (`VERIFY:`, `router_verify`). Decision record:
  [`../adr/0003-affected-test-verification.md`](../adr/0003-affected-test-verification.md).
  - Handover: [`verification-resource-budget-handover.md`](./verification-resource-budget-handover.md)
    — execution state, operating rules and troubleshooting notes for the
    orchestrator running the plan.

- [`delegation-depth-and-effort-bump-plan.md`](./delegation-depth-and-effort-bump-plan.md)
  — Delegation Depth and Effort Bump (#66, #67): mode-aware depth limits for
  in-process dispatches and a same-tier effort step in the `delegate` retry
  ladder, with per-producer options on OpenCode v1 and v2. Decision record:
  [`../adr/0004-delegation-depth-and-effort-bump.md`](../adr/0004-delegation-depth-and-effort-bump.md).
  - Handover: [`delegation-depth-and-effort-bump-handover.md`](./delegation-depth-and-effort-bump-handover.md)
    — execution state, operating rules and binding implementation handoffs.
  - QA reports: [`../qa/depth-and-effort/`](../qa/depth-and-effort/)
    — spike evidence, adversarial findings and phase verification records.

- [`cost-aware-routing-engine-plan.md`](./cost-aware-routing-engine-plan.md)
  — Cost-Aware Routing Engine (#74, inspired by #73; target `2.3.0`, OpenCode
  v2 only): typed task facts decided in code, an outcome-calibrated scoreboard
  per (class × agent × model#variant), an expected-cost decision kernel behind
  `routing.engine: static | shadow | advise | enforce`, same-session variant
  bumps before model escalation, and a cost doctor for host-side waste.
  Decision record: [`../adr/0005-cost-aware-routing-engine.md`](../adr/0005-cost-aware-routing-engine.md).
  User guide: [`../ROUTING_ENGINE.md`](../ROUTING_ENGINE.md) (config keys:
  [`../CONFIG_REFERENCE.md`](../CONFIG_REFERENCE.md#routing--cost-aware-routing-engine-74)).
  QA reports: [`../qa/cost-aware-routing/`](../qa/cost-aware-routing/).
  - Handover: [`cost-aware-routing-engine-handover.md`](./cost-aware-routing-engine-handover.md)
    — kickoff prompt, execution state, planning-session considerations,
    troubleshooting, and the resume point after every host restart.

- [`role-tier-assurance-delegation-plan.md`](./role-tier-assurance-delegation-plan.md)
  — Role × Tier × Assurance delegation (#84; target `2.4.0`, OpenCode v2 only,
  v1 keeps the tier model): the orchestrator picks a role, the router picks the
  tier per dispatch under an authority × detection floor, least-privilege role
  contracts with capability separation, dynamic authority with a resume-based
  ladder for `general`, a structured `router_run` tool, role-aware guards and
  budgets, and outcome evidence only from external verification. Revised
  hypotheses grounded in the literature and the 2026-10-06/07 run evidence.
  Decision record: [`../adr/0006-role-tier-assurance-delegation.md`](../adr/0006-role-tier-assurance-delegation.md).
  User guide: [`../ROLES.md`](../ROLES.md) (config keys:
  [`../CONFIG_REFERENCE.md`](../CONFIG_REFERENCE.md#roles-delegation-84)).
  QA reports, spikes and the dogfood record: [`../qa/role-tier/`](../qa/role-tier/).
  - Handover: [`role-tier-assurance-delegation-handover.md`](./role-tier-assurance-delegation-handover.md)
    — kickoff prompt, execution state, worktrees, planning considerations,
    troubleshooting, restart-stop messages and the phase log.

## Related records

- Architecture decision records: [`../adr/`](../adr/)
  - `0000-spike-results.md` — Phase 0.0 enforcement-primitives capability spike.
  - [`0005-cost-aware-routing-engine.md`](../adr/0005-cost-aware-routing-engine.md) —
    cost-aware routing engine (#74): decisions D1–D18, alternatives, consequences.
  - [`0006-role-tier-assurance-delegation.md`](../adr/0006-role-tier-assurance-delegation.md) —
    role × tier × assurance delegation (#84): evidence E1–E13, decisions D1–D13,
    alternatives, consequences, literature.
- QA reports: `../qa/` (added during Wave 5).
