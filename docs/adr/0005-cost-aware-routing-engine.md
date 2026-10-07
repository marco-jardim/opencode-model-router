# ADR 0005 — Cost-Aware Routing Engine

> **Status:** Accepted (evidence section pending, see [Evidence](#evidence)) **Date:** 2026-10-06 **Wave/Phase:** Cost-Aware Routing Engine, Phase 3.1
> **Supersedes:** none **Depends on:** ADR 0002 (acceptance gate: the verdicts are the engine's only source of probabilities), ADR 0003 (deferred verification), ADR 0004 (delegation depth guard and effort bump: the ladder this engine extends, and the depth the engine never raises)
> **Deciders:** owner (Marco Jardim); implementation amendments and adversarial QA recorded in the plan and phase reports
> **Plan:** [`../plans/cost-aware-routing-engine-plan.md`](../plans/cost-aware-routing-engine-plan.md) **User guide:** [`../ROUTING_ENGINE.md`](../ROUTING_ENGINE.md)
> **Issues:** [#74](https://github.com/marco-jardim/opencode-model-router/issues/74) (this feature), [#73](https://github.com/marco-jardim/opencode-model-router/issues/73) (the suggestion that inspired it)

## Context

Until `2.2.0` the router chose a destination by **prose**: the delegation protocol lists tiers and a task taxonomy (`taskPatterns`), the orchestrator model reads it and names a tier, and that tier is a fixed `(model, variant)` with a `costRatio`. Three things were missing.

1. **No learning.** Whether `@fast` can do a class of work was decided once, in a configuration file. Verification verdicts, false refusals and measured costs were produced and thrown away: `TrajectoryState` lived in memory per session, the scorecard log carried no verdicts and there was no aggregate across sessions. During planning, 5 of 12 `@fast` dispatches handed back with zero tool calls; each cost a full round, and nothing learned from it.
2. **The retry path paid for the wrong thing first.** A failed verification escalated to a bigger model, although the same model at a higher variant is often enough and keeps the child session's context. The `delegate` tool created a new producer session per attempt.
3. **Costs outside the router were invisible.** Title generation on a large model, unpriced models whose reported cost is `0`, tiers whose configured variant the catalog does not offer.

Issue #73 suggested giving the project's custom agents to a routing service ("jev") together with the context of the work, so that it decides which agent does the work, delegating to a subagent and creating a hierarchy. Issue #74 turned that into a design that keeps the decision in code and in measured outcomes.

The host (OpenCode `v2.0.22`) made this possible: a plugin may reassign the `subagent` tool input in `execute.before`; a child can be **resumed** with a different `model#variant` (history kept); every step publishes a durable `session.step.ended` with cost and tokens, children included; native agents carry their own models and permissions.

The record below describes the shipped implementation. Decisions D1–D18 are the plan's; the amendments (A1–A33) that the phase spikes and the adversarial QA rounds made binding are folded into each decision and listed in the [amendment index](#amendment-index).

## Decision

### D1 — The engine is OpenCode v2 only; the v1 opt-in is text

The engine, the ladder's variant and session steps, telemetry ingestion and the cost doctor run under `src/v2.ts` and `src/compat/v2-hooks.ts`. On v1 the `routing` block is parsed and validated, `routing.engine` is coerced to `static` with one log line per process (`routing.engine ignored on OpenCode v1`), and `variantSteps` is ignored. The one v1 effect, opt-in only: an explicit `routing.roles` adds a prose suffix to the static `R:` line naming those agents as destinations for their classes (`src/routing/commands/v1-roles.ts`, A28). With no `routing` block no v1 path changes behaviour; the v1 goldens stay byte-identical.

### D2 — The default is `static` and equals `2.2.0`

A snapshot test pins the protocol text and the `R:` line for the shipped `tiers.json` (raw and v2-adapted). The engine with no outcome data and no `routing` block must reproduce the static taxonomy exactly: the degenerate case is a tested property (`generateTaxonomy` equals `buildTaskTaxonomy` when there is no evidence). A15 refines the ladder side: `enforcement.escalate.variantSteps` defaults to `none` when the config has no `routing` block and to `auto` (v2) when it has one; an explicit value always wins. `engine: "static"` inside a `routing` block is therefore **not** the same as no block.

### D3 — The classifier is never an agent

It runs through the host's `generate` call with an explicit model, or through a direct OpenAI-compatible or TypeSafe HTTP call. It is never registered with `agent.transform`, never appears in the protocol, never creates a session. A backend other than `rules` without `classifier.model` is a **validation error**: the model is never picked automatically, because task text leaves the machine to that provider's account.

### D4 — Probabilities come from outcomes only

The classifier's confidence (a calibrated TypeSafe answer, sample agreement) gates only whether the engine trusts the **class**; it never enters `p_t`. `p_t` is the Beta posterior of verified outcomes. `unverifiable` verdicts update nothing. A false refusal (a child that returned with zero tool calls) is a **failure** for its `(class × agent × model#variant)`. A19: a backend label replaces the rules' class only if it is one of the classes the rules matched, and a backend's confidence is capped below `minClassConfidence` unless it agrees with the rules. QA-2.1-10: the store, and the verdict and refusal rates, cover **trusted classes only** (confidence at least `minClassConfidence`, class not `unknown`); other dispatches keep their decision row.

### D5 — One cost unit per decision

All candidates of one decision are compared in the same unit. USD if every candidate is USD-comparable (at least 3 measured attempts, or priced in the catalog with a token profile to price); otherwise `costRatio` units for all. Never mixed. `U` in USD is scaled by the USD price of one `costRatio` unit; when that is not available the decision falls back to ratio units (A23). `src/routing/outcomes/cost.ts`.

### D6 — Zero cost for an unpriced model is unknown

A `session.step.ended` with `cost == 0` for a model with no price is stored as `null` (the tokens are kept). A1 defines *unpriced*: the catalog `cost` is empty, or every field of every price entry, in every tier, is 0 (observed unpriced: `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-haiku-4-5`, `gpt-6-luna`, `gpt-6-luna-fast`). A positive cost for an unpriced model is kept; a priced model's `0` stays `0`. Subscription providers (`opencode`, `opencode-go`, `github-copilot`) report catalog prices that are not what is billed: the engine uses them as relative weights, and the cost doctor says so. A10: context-tiered price entries are selected by input size.

### D7 — Priors from the static taxonomy, strength 5

For a class whose static tier is `t0`: a candidate of the same rank starts at `Beta(4, 1)`; each rank above adds 0.05 to the mean (cap 0.95); each rank below subtracts 0.25 (floor 0.30); `α + β = 5` always. A native or user agent without a static rank inherits the rank of the role it is listed under; when its own model equals a preset rung the lower of the two ranks applies (A25).

### D8 — Expected cost of the cascade

`C(k) = c_k + tax_k + (1 − p_k) · [ d · C(next(k)) + (1 − d) · U ]`, with `c_k` per D5, `tax_k` the mean final-message tokens of the class on `k` times 4 remaining turns times the orchestrator's cache-read price (0 until measured, never invented), `d` from `routing.detection` by the verification depth of the dispatch's `[acceptance]` block (`deterministic` 0.95, `grader` 0.7, `none` 0.3) and `U` from the profile and risk (`frugal` {3, 8, 20}, `balanced` {5, 15, 40}, `safe` {10, 30, 100}, `fast = 1`). A25: the router tiers' cascade is priced by **simulating the 1.5 runner** (`buildEscalatePolicy`, `newLadderState`, `nextAction`, `advance`: retries, `maxTotalAttempts`, the cost ceiling, covered-tier skips), not a fixed `next(k)` chain, so the engine and the runner cannot drift. `src/routing/engine/kernel.ts`, `ladders.ts`.

### D9 — The margin rule for `enforce`

The engine replaces the orchestrator's choice only if `C(best) < (1 − margin) · C(chosen)` (**strict**, A16), the class confidence is at least `minClassConfidence`, the candidate's **evaluated** permissions cover the task's `needs` (A11), the candidate is not below `floorTier`, and the dispatch is not pinned. Never down on high risk without detection. A23: `best` is drawn only from candidates that pass the permission, floor and never-down filters; below `minClassConfidence` the kernel does not read the store. **A24/A27, the evidence gate:** a candidate is eligible as `best` only with at least 5 **effective** outcomes on its own key for the class (recorded outcomes decayed by `routing.outcomes.halfLifeDays` and capped at `maxEffectiveSamples`), or if it ranks strictly above the orchestrator's pick; the gate filters the candidates **before** the argmin (the earlier single-argmin-then-gate rule left `enforce` inert for 4 of 8 classes under the default roles), and the unfiltered argmin is logged in `trace.argmin`. **A30:** a dispatch that resumes an existing child is never switched by the engine in any mode (`switched: false`, reason `kept:resume`); a resume never moves the child from where it runs because of the router (reason `kept:resume:running` when the arguments are rewritten to the running agent), and `routing:stats` keeps resumes out of every routing metric. The one exception is policy, not the engine: in `enforce`, a resume that names a different agent on purpose is honoured, and is lifted to `floorTier` when it would fall below it, which is a floor lift (`switched: true`, reason `lift:floor`). **Floor lifts:** in `enforce` a native `subagent` dispatch below `floorTier` is lifted to the floor tier (reason prefix `lift:floor`); that is policy, counted on its own line and not in D17.

### D10 — Variant steps before model steps, on the same session

On v2 with `variantSteps: "auto"`, a failed verification first retries on the same model's next variant (catalog order, validated against the model's `variants`, capped at `effortBumpMax`), resuming the child with the ladder's forcing message. Variant steps do not consume `maxAttemptsPerTier` but count toward `maxTotalAttempts` and the cost ceiling. Only when no higher variant exists does the ladder escalate. The `effortOverrides` path stays for v1 and for models without variants. Binding refinements: A9 (a child without a variant is `default` and the ladder never emits a variant absent from `variants[]`), A17/A17a (a budget reserve so an escalation stays reachable; every action carries the `costRatio` of its rung; `triedByModel` so a `(model, variant)` is never re-run; covered tiers are entered at the first rung above the one reached), A20 (a tier with both `variant` and `effort` stays on the effort path only), A21 (`nextAction` order: accept, unverifiable, max total, cost ceiling, variant step, retry within tier, escalate: the `2.2.0` order the goldens pin).

### D11 — Resume or start fresh by context fraction

A retry or escalation resumes the child (`sessionID`, with `model`, and `agent` when the role changes) when `lastStepTokens + estimatedTokens(next prompt) < routing.sessionReuse.maxContextFraction × inputBudget(next model)`, `inputBudget(m) = limit.input ?? (limit.context − limit.output)` of the **next** model (A5, A10); otherwise a fresh session starts as before. A29: `lastStepTokens` is the **largest** step seen in the current execution. Four cases start fresh by design: `invalid-variant` and `unknown-tokens`, and two safety guards, `bare-model-after-variant` and `effort-path`. Phase 3.2 measured the host side of both guards on 2.0.22 (a bare model after a variant stores `#default` and sends the default effort; after an agent switch the target's effort goes at the top level on a model change and in-band on a same-model switch, where the top level keeps the previous agent's), but provider acceptance of in-band effort is unverified, so the guards stay.

### D12 — Roles are agents; native agents are candidates by default on v2; no nested delegation

`routing.roles` maps a class to an ordered list of agent ids appended to the router tiers' ladders (the tiers are always in every ladder). The v2 default is `{ search: ["explore"], implement: ["general"], debug: ["general"], review: ["general"] }`; `roles: {}` disables native candidates; on v1 the default is `{}` (D1). A native or user agent gets its own configured model first, then the rungs of the router tier that owns the class. Candidates must be `mode != primary`, not hidden and permitted for the parent, and the permission filter reads the agent's **evaluated** permissions (A11). The plugin never raises `subagent_depth`; the depth guard of ADR 0004 stays.

### D13 — A typed fields channel: the route line

The orchestrator (or `/annotate-plan`) may put one line `[route class=<c> risk=<r> scope=<s> needs=<a,b> d=<…> pin]` first in a dispatch prompt. `pin` means "the tier is mandated by a plan or by policy". The line is parsed and **stripped** in `execute.before`, like `CAP:` and `VERIFY:`; unknown values are ignored field by field. A22: it is recognised only as the **first non-empty line**; on a conflict the first line's `pin` is kept; negated prohibitions in constraint sections do not raise risk. A26: `/annotate-plan` pins every step whose final tag is `[tier:heavy]`.

### D14 — Classifier state is bounded, scrubbed and English

A model backend receives one state made of the description, the first `[acceptance]` block (whole or left out, and only when it fits in half of what the description leaves) and the prompt head, and the **whole state is cut to `maxStateChars` characters** (the prompt head gets what is left), with route, `CAP:` and `VERIFY:` lines removed and code blocks replaced by a placeholder. Never file contents, never the system prompt, never session history. Secrets are scrubbed first; a task that names a credential (a credential word such as `password`, `secret` or `token`, an env-style name, a `.env` file, a PEM header), or that the scrubber redacts by shape, never reaches a backend (`trace.backendSkipped = "credentials"`); a redaction that is only an entropy guess (a hash, a long identifier) does not skip the backend, and the redacted state is sent. Instructions are English, the options include `other`/`unknown`, the order is shuffled per call, and a disagreement between two orders lowers the confidence to 0. A18: the classifier keys and `outcomes.path` are honoured only from the bundled file and the global override, never from a project-local override, and a key is never sent over plain `http:` to a non-loopback host.

### D15 — Persistence is bounded, atomic and off the hot path

One JSON outcome store plus an append-only JSONL decision log under the directory that already holds `*.scorecard.log` (`routing.outcomes.path`, global override only). `decisions.jsonl` rotates before 5 MiB and keeps 3 generations; `outcomes.json` is written atomically (temp file and rename), an unparseable file is quarantined, and writes happen on `session.idle`/`session.deleted` and at most every 30 s, never during a dispatch. A3: the same event is delivered once to each live location's plugin instance, so ingestion dedupes by event id with a process-wide set and the store has one writer per process.

### D16 — Release `2.3.0`, one PR

One pull request closes #74 and #73. Target version `2.3.0`.

### D17 — The plan dogfoods itself, and the final mode is decided by its own numbers

The modes were raised at checkpoints (`static` → `shadow` → `advise` → `enforce`), each recording a `routing:stats` period in the dogfood report. At the last checkpoint the active configuration is left at `enforce` if no **switched** dispatch ended in a `fail` verdict during the enforce period, otherwise at `advise`. The rule uses a safety condition, not a savings claim. Floor lifts are policy and are not counted as switched dispatches.

### D18 — Observability is a deliverable

The decision log, the outcome store, `npm run routing:stats` and `/router stats` are part of the release, documented, tested and used by the checkpoints. A checkpoint without a `routing:stats` summary is not complete. The statistics cover trusted classes only (a footnote says so), report resumes, floor lifts and delegate first attempts on their own lines, and count the evidence gate (`Kept for lack of evidence`, `trace.argmin`).

### Amendment index

The plan (§1.5, "Amended during implementation") holds the full text of each amendment; this index says where each lands.

| Amendment | Decision | Gist |
|---|---|---|
| A1, A2 | D5, D6; advisor | What *unpriced* means; suggestions come from the live catalog only. |
| A3 | D15 | One delivery per location; dedupe by event id in process scope. |
| A4, A13 | D3, D14 | The `host` backend uses `ctx.generate.text`, resolved at the dispatching location; the classifier model of any live check is named by the owner. |
| A5, A10, A29 | D11 | Input budget of the next model; tiered prices; the largest step is the resume context. |
| A6, A8, A12, A14 | execution | Checkpoints edit the global override; every code sync needs a restart; no `--pool=threads` in tests (a global home guard). |
| A7 | D10 | Effort delivery depends on the provider route. Phase 3.2 measured what the host sends on 2.0.22 for Anthropic Messages (in-band `output_config.effort`, top level unchanged) and OpenAI Responses (in-band `configuration_update`, top level unchanged for a same-model step; a model change sets the top level; a bare model after a variant sends the default effort): host emission only. Provider acceptance of in-band effort is unverified. |
| A9, A17, A17a, A20, A21 | D10 | The variant ladder's invariants and the order of `nextAction`. |
| A11 | D9, D12 | Permissions are read from the agent's evaluated rules. |
| A15 | D2, D10 | `variantSteps` default depends on the presence of a `routing` block. |
| A16, A23, A24, A25, A27, A30 | D8, D9 | Strict margin, the kernel's filters and evidence gate, the runner simulation, resumes never switched by the engine (a floor-lifted resume is the policy exception). |
| A18, A19 | D14, D4 | Project-local files cannot set the classifier; a backend label cannot invent a class. |
| A22, A26 | D13 | The route line is the first line only; heavy steps are pinned. |
| A28 | D1 | The v1 text-only roles line. |
| A31 | F4 (cost doctor) | The cost doctor has no `summary` finding; `title-model-unset` follows the host's own title pick; acceptance criterion 8 is reworded. |
| A32 | F4 (cost doctor) | In `advise`/`enforce`, advisor notices are a synthetic transcript entry one user turn late, throttled per project (a state file and a lock) with a weekly reminder; in `static`/`shadow` the notice is a log line with a memory-only throttle and no file. |
| A33 | D10, F4 | `maxAttemptsPerTier: 1` does not escalate straight away (one retry of the same rung comes first); the `attempts-without-variants` finding is reworded. |

## Findings (evidence)

The decisions above rest on spikes run against OpenCode `2.0.22` before any code was written (`docs/qa/cost-aware-routing/phase-0P.md`): reassigning `event.input` in `execute.before` is honoured for `subagent` (S1); resuming a child with a higher variant switches the model and keeps history (S2); `session.step.ended` reaches the plugin with cost and tokens, once per live location (S3); the catalog exposes variants and prices, with several models unpriced (S4); `ctx.generate.text` resolves its model in the dispatching location (S5); after `switchModel` to a smaller context window the host's auto-compaction runs but does not guarantee the next prompt fits (S6, hence D11's threshold on the next model's input budget). Each phase then went through adversarial QA by a separate reviewer, in up to three rounds; the findings and their fixes are in `docs/qa/cost-aware-routing/phase-*.md`.

## Consequences

**Positive**

- The choice of destination is measured: per `(class × agent × model#variant)`, from verified outcomes and measured cost, with priors from the static taxonomy so the engine is correct before it has data (D2, D7).
- A failed verification now first tries the cheaper repair: a higher variant of the same model on the same child (D10, D11).
- A zero-tool-call hand-back is a recorded failure of the tier that produced it, no longer a lost round.
- Every decision is auditable: a row says what the orchestrator picked, what the engine would pick, the cost of every candidate, and why a switch did or did not happen.
- Waste outside the router (title model, unpriced models, impossible variants) is reported with the file that fixes it.

**Costs and risks**

- **More state on disk.** An outcome store and a decision log (up to 5 MiB, 3 rotated generations) under the temp-directory trajectory folder, plus a small notice state per project when the engine is `advise` or `enforce`.
- **More configuration** (`routing.*`, `tiers.<t>.candidates`, `variantSteps`), all optional and defaulted. Any `routing` block, however small, enables variant steps on v2 and activates the cost doctor.
- **`enforce` is inert until there is evidence.** The evidence gate (A24/A27) means nothing moves down or sideways on priors; upward switches and floor lifts still occur, so a fresh install under `enforce` is not a copy of `static`, but its cost-saving moves wait until the scoreboard fills. That is deliberate.
- **The scoreboard only sees what is dispatched.** There is no exploration: an unevidenced cheaper rung gets its first outcomes only when something puts work there. Exploration is future work.
- **Blind spots.** Deferred verification and `router_verify` verdicts are not recorded. Below-threshold dispatches record no outcomes, so with the rules classifier a share of dispatches never teaches the scoreboard.
- **The rules classifier is crude on long briefs.** Backends (`host`, `openai-compatible`, `typesafe`) can help but send bounded task text off the machine.
- **The `host` backend is experimental.** The live criterion of the DF3 checkpoint (`source: "host"` for both steps of a batched `/annotate-plan` sample) was not observed. The backend was consulted live (status `ok`, label `other`, no `backendSkipped`), but an answer that only confirms `other` does not change the rules' facts, so the run proves the transport, not the benefit. The credential policy gate (D14) skips the backend for credential words, including `token`, by design. Effort delivery is proven at the host's edge only (A7, [Phase 3.2](../qa/cost-aware-routing/phase-3.2.md)): what the host sends was measured for the Anthropic Messages and OpenAI Responses routes against scripted providers, and a provider's acceptance of the in-band effort is unverified. A tier whose `effort` differs from its `variant` runs the effort while its keys name the variant (the cost doctor reports it as `variant-effort` while variant steps are on and as `effort-variant-mismatch` when they are off, one warning per tier).
- **v2 only.** v1 users get one prose line and nothing else.
- **A code change needs a host restart** (the plugin is loaded once per process); a configuration change does not.
- **The docs are not in the npm tarball.** This ADR and the guide live in the repository.

## Alternatives rejected

**Tiers as agents only (the `2.2.0` shape, extended).** Keep one agent per tier with a fixed model, and let the orchestrator pick an agent by name from prose; add more agents for more models and variants. Rejected: the host rewrites the "Available subagents" list into the tool description on every request, so every new `(model, variant, class)` agent grows the orchestrator's context on every turn; the choice of rung would stay a guess in prose with nothing that records whether it worked; and a same-session variant step is not expressible as an agent choice at all. The shipped design keeps the router tiers as the agents the orchestrator sees and adds the per-call `model#variant` the host already accepts, programmatically, in the hook (the protocol never asks the LLM to set `model`).

**An external router ("jev") in the critical path.** Hand every dispatch, with the agent descriptions and the context of the work, to an external service that decides who does it (the suggestion of #73). Rejected as the default path: a network round-trip and a model call in front of every dispatch (latency and cost on the hot path), task text leaving the machine on every dispatch, an availability dependency for every session, and a decision nobody can audit or calibrate: it would not learn from verification verdicts or false refusals. The shipped design keeps the decision in code from measured outcomes and offers such a service as an **optional, bounded** classifier backend (`typesafe`, or any OpenAI-compatible server): rules first, a backend only when the rules are unsure, bounded by `timeoutMs`, never blocking, with its confidence kept out of `p_t` (D4).

**Nested delegation.** Let a router or classifier agent dispatch subagents itself, building a hierarchy ("create hierarchy + hierarchy", #73). Rejected: the host's `subagent_depth` defaults to 1 and the delegation depth guard of ADR 0004 enforces the same bound; each level repeats the context in tokens and adds a failure path; and the router's own agents would pay for reasoning that a deterministic kernel does in microseconds. The plugin never raises the depth; roles (D12) give native agents a place in the ladder without nesting.

**A classifier agent.** Run the classifier as a registered agent so it can use tools. Rejected (D3): it would appear in the protocol, create sessions and cost a turn; the classifier only needs a bounded text-in, label-out call.

**Probabilities from the classifier's confidence or logprobs.** Rejected (D4): the host's generate API returns text only, and a confidence about the *class* says nothing about whether an attempt on a tier *passes*. Outcomes do.

**Exploration (bandit) sampling of cheaper rungs.** Rejected for this release: it would deliberately send work to rungs without evidence. Recorded as future work; the evidence gate and `shadow` are the safe way to collect data first.

**Mode changes that need a restart.** Rejected: every mode is a configuration-only change, applied by the existing hot reload, with `static` as an instant kill switch.

## Evidence

> **Placeholder — completed in Phase 3.4 (checkpoint DF5).** This section receives the dogfood summary table across DF1–DF5 (dispatches, agreement, switched, estimated savings per unit, measured USD where available, false refusals, variant steps and pass rate, restarts and time lost), the D17 rule with its counts and the resulting final mode, and the workload caveat (the workload is this plan's own execution, implementation- and QA-heavy with pinned heavy dispatches: the numbers are evidence of behaviour, not a benchmark). The interim periods are in [`../qa/cost-aware-routing/dogfood.md`](../qa/cost-aware-routing/dogfood.md).
