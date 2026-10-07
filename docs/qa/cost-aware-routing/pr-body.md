# Cost-aware routing — DF5 evidence and 2.3.0 release preparation

Closes #74
Closes #73

## What changes

**Head branch: `car/main`; base: `master`.** PR #76 was opened on 2026-10-07; the orchestrator keeps `car/main` fast-forwarded to the reviewed `car/p34` tip. This PR adds the **DF5 evidence, CI portability fixes, runtime safety fixes and 2.3.0 release metadata**, not the entire engine implementation: the dogfood syncs already pushed the engine to remote master, a deviation from the plan's local-only sync procedure.

Includes two runtime fixes found during release QA: plugin dispose now drains in-flight cost-doctor checks and claims (bounded by the 3 s host timeout), and config validation never echoes secret-capable values (CodeQL #10–#12).

The timeout bounds advisor host calls; filesystem completion and the rest of plugin teardown are not a hard 3 s deadline. Test workflow [37613324910](https://github.com/marco-jardim/opencode-model-router/actions/runs/37613324910) passed **12/12 jobs, attempt 1**, on `71ae7d8`. Post-Round-3 run [37617504281](https://github.com/marco-jardim/opencode-model-router/actions/runs/37617504281) is **in progress** on `b4c6621`, excluding the diagnostic-contract repair `9cc4946`. The final-tip matrix still requires the owner's `car/main` update; the earlier green run does not cover credential redaction.

Round-3 local verification: typecheck passed; the four config/docs test files passed **685 tests** (one existing skip); config-related tests passed **8,785 tests in 92 files** (56 existing skipped tests / 3 skipped files), using the default pool with `--maxWorkers=2` for the related run. Legacy diagnostic expectations now enforce redaction rather than value echoes; all validation cases remain covered.

CI-safety margins loosened absolute performance budgets in tests (A36); the original budgets remain design targets, while relative run-length scaling, same-length pathological/prose ratios and deterministic timer-scheduling checks remain regression guards.

For full feature review, use [the v2.2.0 → car/main comparison](https://github.com/marco-jardim/opencode-model-router/compare/v2.2.0...car/main). The release as a whole includes the opt-in OpenCode v2 cost-aware routing engine, learned outcome statistics, same-session variant escalation, native-agent candidates, a cost doctor, `/router stats` and route annotations. Decisions stay in code and use verified outcomes rather than classifier confidence as a success probability. Version: **2.3.0**.

Thanks to **@javizuurc in #73** for suggesting a routing step that sees the agents and the work before choosing a destination. **TypeSafe's documentation** inspired the bounded typed-classification integration; TypeSafe is an optional backend, not a required service. The implementation is written from scratch.

| Engine mode | Behaviour |
|---|---|
| `static` | Default; no routing block preserves 2.2.0 behaviour. |
| `shadow` | Computes and records decisions without changing the dispatch. |
| `advise` | Exposes the generated routing line and stable route hint; the orchestrator keeps the choice. |
| `enforce` | Can reroute under a strict margin, evidence, permissions, floor and never-down gates. Pinned dispatches are not rerouted; no per-turn route hint is emitted. |

An explicit `routing` block also enables automatic variant steps on v2 unless overridden; `static` inside a block is not identical to no block. The engine does not raise delegation depth. Classifier backends are explicit opt-ins, receive bounded scrubbed task excerpts and never receive credential-bearing tasks; `host` remains experimental.

**OpenCode v1:** the block is validated but the engine is forced to `static`, with one notice when a non-static engine is requested. Explicit `routing.roles` adds only a prose destination suffix; no engine, variant ladder or telemetry is enabled. No routing block preserves the existing v1 behaviour.

- [ADR 0005: decisions, safeguards, trade-offs and evidence](https://github.com/marco-jardim/opencode-model-router/blob/car/main/docs/adr/0005-cost-aware-routing-engine.md)
- [Routing engine guide](https://github.com/marco-jardim/opencode-model-router/blob/car/main/docs/ROUTING_ENGINE.md)
- [Dogfood evidence and bounded reproduction commands](https://github.com/marco-jardim/opencode-model-router/blob/car/main/docs/qa/cost-aware-routing/dogfood.md#summary)
- [Release preparation and approval-gated checklist](https://github.com/marco-jardim/opencode-model-router/blob/car/main/docs/qa/cost-aware-routing/phase-3.4.md)

## Dogfood summary

| Checkpoint / measured mode | Dispatches | Agreement | Switched | Estimated savings per unit | Measured USD | False refusals | Variant steps / pass rate | Restarts / time lost (wall-clock proxy) |
|---|---:|---|---:|---|---|---|---|---|
| DF1 / static | 0 recorded | n/a | 0 | n/a (no rows) | n/a, unpriced | 0 recorded; unmeasured | 0 / n/a | 1 / ≈2h06m54s |
| DF2 / static, before shadow | 0 recorded | n/a | 0 | n/a (no rows) | n/a, unpriced | 0 recorded; unmeasured | 0 / n/a | 1 / 4m55s |
| DF3 / shadow | 79 | 65/65 (100%) | 0 | 0.00 ratio / 65 rows | n/a, unpriced | 0 | 0 / n/a | 1 / 1h50m56s |
| DF4 / advise | 112 | 67/67 (100%) | 0 | 0.00 ratio / 67 rows | n/a, unpriced | 0 | 0 / n/a | 2 starts (1 failed) / 35m38s total |
| DF5 / enforce | 56 | 24/24 (100%) | 0 | 0.00 ratio / 24 rows | n/a, unpriced | 0 | 0 / n/a | 2 / 30m49s sync→owner restart + unmeasured unplanned restart |

Cutoff: **2026-10-07T04:13:39.877Z**. D17 counts zero failed switched dispatches, so its literal rule retains **enforce**; the stats display correctly says `n/a (0 enforced switches)`. Post-3.3 never-down audit: **0 of 2 recorded**. **`switched` is false on all 247 decision rows**; therefore `pinned && switched` is also zero, a vacuous invariant in this sample. This demonstrates neither dollar savings nor successful switching.

One owner, one machine, and an implementation-/QA-heavy plan workload, with unpriced models: **not a benchmark**. The host-wide store includes concurrent projects, not just this plan. DF1/DF2 zeros reflect absent instrumentation. Agreement excludes pinned/resumed/ineligible rows. Restart durations include human idle time, not just downtime. The plan-session cache measurements are documented separately: advise used the old hint, and missing token records prevent a trustworthy full-window advise/enforce comparison.

## Validation and rollout

Scoped validation covers docs drift (D16/D17), packaging/import closure and routing-outcomes statistics; release preparation also checks a real clean tarball install and **server-factory initialization/disposal** without new plugin log lines. This is not real-host startup evidence. Exact commands and results are in the phase report. Existing Phase 3.2 scripted-host evidence remains distinct from this preparation run; it is not presented as a newly repeated full suite. The full CI matrix is a required PR/pre-tag gate, not a claim of this local verification.

Release actions remain approval-gated: merge, release tag push (which triggers npm publication), npm publish and optional manual GitHub release. No live override is changed by release preparation.
