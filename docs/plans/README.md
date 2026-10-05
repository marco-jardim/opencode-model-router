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

## Related records

- Architecture decision records: [`../adr/`](../adr/)
  - `0000-spike-results.md` — Phase 0.0 enforcement-primitives capability spike.
- QA reports: `../qa/` (added during Wave 5).
