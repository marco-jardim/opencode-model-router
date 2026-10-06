# Phase 3.1 — Docs, ADR, changelog (#74)

> Worktree `D:\git\omr-car-p31` on `car/p31`, created from `car/main` at `71815eb`. Tier `[tier:medium]`. Documentation only: no source change; the one test change is the docs-drift extension the plan allows.

## Pre-flight

| Item | Result |
|---|---|
| Base | `71815eb` (`docs(routing): DF3 shadow-period stats`); `git log --oneline 71815eb..HEAD` lists only this phase's commits. |
| Worktree clean at start, branch `car/p31`, tracking `origin/car/p31` after the first push | Yes. |
| Linear | **Not used.** |
| Doc-link / doc-drift test | `test/unit/docs-drift.test.ts` exists (top-level `tiers.json` keys and nested `enforcement` keys in `CONFIG_REFERENCE.md`; the README prompt-size figures). It checks a key list the new docs must satisfy only for `tiers.json` top-level keys (`routing` is already a row of that table); extended anyway, see Implementation notes. |
| Live engine | **`advise`** since DF3 (the override file is outside this worktree and was not touched). |
| DF3 gate (plan 3.1.1 starts only when `## DF3` holds the classifier result) | `dogfood.md` `## DF3` at `71815eb` holds the shadow-period stats and reading, **not** the classifier probe. The probe result used here was supplied by the orchestrator's dispatch (and corrected by it): the `host` classifier backend **was consulted** (probe row: status `ok`, 1688 ms, label `other`, no `backendSkipped`); the plan's criterion (`source: "host"` for both steps of a batched `/annotate-plan` sample) was **not observed**; the credential gate has no false positive (regression tests in `car/pcred` `e99330c`: the gate skips the backend for credential words, `token` included, by design, D14). Not re-verified here. `host` is therefore documented as EXPERIMENTAL. |
| `npm run typecheck` | Clean (no output beyond the npm banner) after the test extension. |
| Code read for the docs | `src/router/config.ts` (types, `validateRouting`, `validateClassifier`, `validateRoles`, `validateTierCandidates`, `resolveRouting`, `resolveVariantSteps`, `resolveCandidates`, `ROUTING_DEFAULTS`, the project-layer strip), `src/routing/classify/{types,route-line,scrub,state,index}.ts`, `src/routing/classify/backends/{openai-compatible,typesafe,shared}.ts`, `src/routing/engine/{kernel,protocol-line}.ts`, `src/routing/outcomes/{types,cost,beta,stats}.ts`, `src/routing/wire/hint.ts`, `src/routing/advisor/{findings,index}.ts`, `src/routing/commands/annotate-plan.ts`, `src/escalate/resume.ts`, `src/v2.ts`, `scripts/routing-stats.ts`. |

## Implementation notes

**Deliverables.**

| Deliverable | File | Commit(s) |
|---|---|---|
| Guide: concepts, four modes, formula with worked example, cost-unit and zero-cost rules, classifier backends with Ollama / OpenCode Go / TypeSafe examples, roles with native agents, session-aware ladder, cost doctor, privacy, v1 note, known limits | `docs\ROUTING_ENGINE.md` | `bf99cde`, `dc1c40f`, `68db20f`, `93de093` |
| ADR 0005: context, D1–D18, amendment index, alternatives (tiers as agents only, an external router in the critical path, nested delegation, and four more), consequences, **Evidence placeholder for DF5 (3.4 owns it)** | `docs\adr\0005-cost-aware-routing-engine.md` | `8c14f07`, `dc1c40f` |
| README section, command rows, plan-annotation paragraph, deep-dive links | `README.md` | `434f80c`, `68db20f` |
| Config reference polish (the "Status" note removed, links, `variantSteps` ladder rules, `effortBumpMax` cap, `host` experimental) | `docs\CONFIG_REFERENCE.md` | `342725c`, `dc1c40f` |
| Plans index: ADR, guide and QA links; ADR listed under related records | `docs\plans\README.md` | `593e410` |
| Changelog: Unreleased entry crediting #73 (@javizuurc; the handle was checked against the GitHub API) | `CHANGELOG.md` | `95e83b4` |
| Docs-drift extension | `test\unit\docs-drift.test.ts` | `024a93c` |
| This report | `docs\qa\cost-aware-routing\phase-3.1.md` | the commit that adds it |

**Method.** Every key, default, range and rule in the docs was read from `src\router\config.ts` (`resolveRouting`, the validators) and the modules above, not from the plan. The plan was used for intent (D/A ids). Where code and plan disagree, the code is documented; see the divergence table.

**The docs-drift extension** adds six tests to `test\unit\docs-drift.test.ts` (12 tests in the file now): every `routing.*` leaf of `ROUTING_DEFAULTS` plus `roles` and `classifier.presets` has its row in `CONFIG_REFERENCE.md`; every engine mode, task class and cost-doctor finding id is named in backticks in `ROUTING_ENGINE.md`; every `<!-- engine-example: … -->` block of the guide parses as JSONC and passes `validateConfig` against the bundled `tiers.json`; the README and plans index link the guide and ADR and the changelog's Unreleased block names #73 and #74; every relative markdown link of five docs (README, guide, ADR, plans index, config reference) resolves, **anchors included** (GitHub heading slugs); and a negative test shows the link checker reports a missing file, a missing heading and a missing document and ignores fenced code.

**Link check, separate from the test.** A standalone node script (not committed) checked the same six files plus `CHANGELOG.md`: `checked 114 relative links in 6 files; broken: 0`; a negative fixture showed it reports a missing file and a missing anchor. External `http(s)` links were not fetched.

**Corrections made during the phase.**

- *Amended during implementation (orchestrator correction):* the first drafts of `ROUTING_ENGINE.md`, ADR 0005 and `CONFIG_REFERENCE.md` said the DF3 credential gate had blocked the `host` backend and that a fix to the gate was in progress. That was wrong. Fixed in `dc1c40f`: `host` is experimental because the plan's DF3 criterion was not observed, the live probe shows the backend consulted (status `ok`, label `other`), and the gate is described as a by-design policy with its full rule (credential words including `token`, env-style `*_TOKEN/_SECRET/_PASSWORD/_API_KEY/…` and upper-case `*_KEY` names, a `.env` reference, PEM headers, anything the scrubber redacts by shape; an entropy-only redaction does not skip the backend), checked against `hasCredentialSignal` in `src\routing\classify\scrub.ts`.
- The TypeSafe row said `apiKeyEnv` is required; validation does not require it, the backend checks it at call time and disables itself with a logged reason. Fixed in `93de093`.

**Numbers in the worked example** (ROUTING_ENGINE.md): `C(heavy) = 22.25`, `C(medium) = 9.015`, `C(fast) = 5.865` on priors, `3.703` after 10 passes and 2 failures; margin threshold `7.212`. Computed by hand with node, using the plain cascade; the guide says the kernel prices the router block by simulating the runner (A25), which reduces to this when each tier has one rung and one attempt. Not produced by running the kernel.

### Code vs plan: divergences (the code is documented)

| # | Plan | Code | Where documented |
|---|---|---|---|
| 1 | §1.4 has no `routing.advisor.notify` | `advisor.notify`, boolean, default `true`; `false` = the doctor never notifies, the `/router` section stays | CONFIG_REFERENCE keys table; ROUTING_ENGINE cost doctor |
| 2 | §1.4: `enforcement.escalate.variantSteps` "default auto" | `auto` only with a `routing` block on v2; `none` without one (A15) and always on v1; an explicit value always wins | CONFIG_REFERENCE; ROUTING_ENGINE |
| 3 | §1.4 gives no ranges | `margin` [0, 0.9]; `minClassConfidence` [0, 1]; `detection.*` [0, 1] with `deterministic ≥ grader ≥ none` on the effective values; `classifier.timeoutMs` [100, 30 000]; `samples` 1 or 3; `maxStateChars` [200, 20 000]; `outcomes.halfLifeDays` [1, 365]; `maxEffectiveSamples` [5, 1000]; `sessionReuse.maxContextFraction` (0, 0.95]; `advisor.noticeIntervalHours` [1, 720] | CONFIG_REFERENCE keys table |
| 4 | D9 "C(best) ≤ (1 − margin) · C(chosen)" | strict `<` (A16, in the plan's own amendments) | ROUTING_ENGINE, CONFIG_REFERENCE |
| 5 | §1.4: `outcomes.path` null or a path | must be absolute (a drive letter or UNC on Windows) or `~`-prefixed; only the global override may set it, as for `classifier.{backend, model, baseUrl, apiKeyEnv, presets}` (A18) | CONFIG_REFERENCE trust section; ROUTING_ENGINE privacy |
| 6 | §1.4 `roles` lists classes | an unknown class is rejected; an empty array per class is allowed; ids match `^[A-Za-z0-9][A-Za-z0-9_./-]*$` without `.`/`..` segments; the whole map is replaced by the highest layer that sets it | CONFIG_REFERENCE roles |
| 7 | F4 / acceptance 8: the cost doctor reports unset `agents.title.model` **and** `agents.summary.model` | one `title-model-unset` finding, only when the host finds no small model of the session's provider; **no `summary` finding** (no consumer of a summary model exists in the host) | ROUTING_ENGINE cost doctor |
| 8 | F4: a one-line notice "appended to the orchestrator's context", logged in shadow/static | a synthetic transcript entry (`ctx.session.synthetic`, `resume: false`) from `chat.message`, one user turn late; only for warning/saving findings; per-project state files (`advisor-notice.<hash>.json` and `.lock`) in advise/enforce, memory-only throttle in static/shadow; weekly reminder; a set that only shrank is not news | ROUTING_ENGINE cost doctor |
| 9 | §1.4 `classifier.apiKeyEnv` "typesafe only / openai-compatible" | optional for `openai-compatible` (none = no `Authorization` header); for `typesafe` it is checked at call time, not at load | ROUTING_ENGINE backends table |
| 10 | §0.11 / D15: a decision row of `ts, mode, sessionID, childSessionID, facts, chosen, best, switched, pinned, unit, costs, confidence, reason` | rows also carry `v`, `kind`, `decisionID`, `step`, `resume`, optional `trace` (route-line count, backend outcome, `backendSkipped`, `argmin`); verdict and refusal rows (with `overrides`) share the file | ROUTING_ENGINE outcomes section |
| 11 | D15 "≤ 5 MB, rotated" | 5 MiB, 3 rotated generations, `outcomes.json` quarantine copies (3) | ROUTING_ENGINE outcomes section |
| 12 | `npm run routing:stats` presented as the stats tool | it is a repository script (not in the npm `files` list) and needs Node ≥ 22.18 / 23.6; `/router stats` is the packaged equivalent | ROUTING_ENGINE stats section; CHANGELOG |

## Findings

No adversarial QA has reviewed this phase yet (the plan assigns it to a separate heavy dispatch, which reads the docs against the code and flags any divergence as `major`). Findings the implementer raised and fixed during the phase:

| Id | Sev | File | Description | Resolution |
|---|---|---|---|---|
| QA-3.1-1 | major | `docs\ROUTING_ENGINE.md`, `docs\adr\0005-cost-aware-routing-engine.md`, `docs\CONFIG_REFERENCE.md` | A wrong claim from the dispatch brief (the credential gate "blocked" the `host` backend and a gate fix was in progress) was written into the docs | `dc1c40f` (see Implementation notes) |
| QA-3.1-2 | minor | `docs\ROUTING_ENGINE.md` | TypeSafe `apiKeyEnv` described as required at load | `93de093` |

**Open findings known to the implementer: 0.**

## Deferred by plan

| Item | Owner |
|---|---|
| ADR "Evidence" section: the DF1–DF5 summary table, the D17 rule with its counts and the final mode, the workload caveat | Phase 3.4 (checkpoint DF5), as the plan's file map says; left as a marked placeholder |
| Version bump, the dated changelog release entry, the PR | Phase 3.4 |
| Smoke proof of: the synthetic notice's position, `kept:resume:running` on a real host, session events for children, effort on the wire (A7, scenario 7), the real `ctx.agent.list()`/`ctx.model.list()` fields | Phase 3.2 (the guide states each as unverified) |
| Heavy adversarial QA of this phase's docs against the code | the orchestrator's next dispatch |

## Handoffs

### Handoffs received (to 3.1) and where each is documented

| # | From | Handoff | Documented in |
|---|---|---|---|
| 1 | `phase-0P.md` | Document `host` as experimental unless DF3 shows the live check passed (A4, A13) | ROUTING_ENGINE "Known limits" and "The classifier and its backends" table; ADR consequences; CONFIG_REFERENCE `classifier.backend` row; README; CHANGELOG |
| 2 | `phase-1.1.md` | Drop the "Status" note; keep the machine-checked defaults block; document the Trust rule and the notices | CONFIG_REFERENCE (note removed, defaults block and examples untouched, parsed by `config.routing.test.ts`); ROUTING_ENGINE privacy; `/router` notices in "Turning it on" |
| 3 | `phase-1.2.md` | D14 privacy and the backends; QA-1.2-34/36 (lowercase/camelCase key names, letters-only 32+ char secrets) | ROUTING_ENGINE "Privacy" (state, scrubber, credential gate rule, known limits, transport, who may configure it, what `host` adds) and "The classifier and its backends" |
| 4 | `phase-1.3.md` | The Node minimum for `routing:stats` (the plugin's runtime `engines` stays `>=20`) | ROUTING_ENGINE stats section; CHANGELOG |
| 5 | `phase-1.5.md` | `effortBumpMax` caps v2 catalog ladders independently of `effortBump`, and the default drops `max`; explicit `candidates` are not capped; `variantSteps: "none"` disables D10 **and** D11; a same-model tier is skipped only when covered and without headroom | CONFIG_REFERENCE (`escalate` table row and the `variantSteps` bullets); ROUTING_ENGINE "The session-aware ladder" |
| 6 | `phase-2.1.md` (QA-2.1-10) | Verdict and refusal rates, and the store, cover **trusted classes only**; a below-threshold dispatch keeps its decision row; `routing:stats` shows more dispatches than verdicts by design; a refusal after a `pass` of the same attempt turns it into a failure; the `RefusalRow.overrides` field | ROUTING_ENGINE "Outcomes, the decision log and statistics" (the trusted-classes paragraph and the refusal rows) |
| 7 | `phase-2.2.md` | The route-line paragraph and the `Route hint`; `trace`; `switched` in a shadow/advise row is a would-switch; the trusted-class footnote; the per-dispatch cost (one `ctx.session.get`, cached agent list and catalog, ≈0.5 ms) | ROUTING_ENGINE "The four modes" (facts), "How one dispatch is routed" (route line, generated `R:` line and hint), decision rows |
| 8 | `phase-2.2.md` (QA-2.2-7, QA-2.2-8) | A `lift:floor` row is policy, not an engine decision on evidence; floor lifts in **enforce** on native `subagent` dispatches below `floorTier` (skipped when the floor tier cannot cover the task's needs or the parent may not start it); D17 and `routing:stats` `enforced`/`failed`/`verified` count only non-lift `enforce` rows | ROUTING_ENGINE "When `enforce` switches a dispatch" (Floor lifts); ADR D9, D17 |
| 9 | `phase-2.2.md`, `plan A27` | An unevidenced option is not eligible as `best` unless it ranks above the pick; the gated cheapest option is logged as `trace.argmin` | ROUTING_ENGINE worked example, "When `enforce` switches", decision rows, stats; ADR D9 |
| 10 | `phase-2.3.md` | Fresh-fallback reasons (`unknown-tokens`, `invalid-variant`, `bare-model-after-variant`, `effort-path`, a refused resume); a resume needs a routing block (A15), a catalog and the child's execution end (waited for at most 1 s); the catalog cache and the log lines (debug flag `MODEL_ROUTER_TRAJECTORY_DEBUG=1`); F-23-1 (tiers with `effort` have no variant steps) | ROUTING_ENGINE "The session-aware ladder" |
| 11 | `phase-2.4.md` | Finding ids and severities; the notice (inert without a `routing` block, delivered when notice-worthy findings change or as a weekly reminder, never for unmodified bundled-preset tiers for the six configuration-shape findings, off with `routing.advisor.notify: false`, a synthetic transcript entry with `resume: false`, advise/enforce persisted with a lock, static/shadow memory-only); the title-model rule and the missing `summary` finding; `fix (opencode.json)` vs `fix (opencode-model-router.overrides.jsonc)`; `/router` queries the host (3 s each) on every bare call on v2; `/router stats` flags, flush first, stderr notes; the new stats rows, the `trace.argmin` table and the footnote; `/annotate-plan` adds a message part only with a live engine on v2 and never writes the file; `routing.roles` on v1 (prose only); the two plugin-input additions (`routerAgents`, `routerGenerate`, plus `routerSynthetic`) | ROUTING_ENGINE "The cost doctor", "Outcomes, the decision log and statistics", "`/annotate-plan`", "OpenCode v1", "Where things live" |
| 12 | `phase-2.4.md` (round 2) | Per-project `advisor-notice.<hash>.json`/`.lock` names; the round 1 `advisor-notice.json` is obsolete and may be deleted by hand; A30; the "starts with a code block" skip of `/annotate-plan` | ROUTING_ENGINE "The cost doctor", "How one dispatch is routed" (A30) and "`/annotate-plan`"; README plan annotation |
| 13 | `phase-2.4.md` (round 3), plan A30 amended | A resume never moves the child from where it runs because of the router (`kept:resume:running`, a pinned resume is never rewritten, an unknown or foreign child is left alone) | ROUTING_ENGINE "How one dispatch is routed"; ADR D9 |
| 14 | `phase-2.4.md` (3.x handoff) | Deferred verification and `router_verify` verdicts are not recorded; either 3.2 wires them or 3.1 documents the gap | Documented as a gap in ROUTING_ENGINE (outcomes section and known limits) and the ADR consequences; **3.2 did not wire it at this base, so the statement must be revisited if 3.2 does** |
| 15 | plan A7 | The effort-delivery caveat: in-band for Anthropic Messages, top-level `thinking` for `default` → variant, `thinking.budget_tokens` for haiku, the OpenAI Responses route not exercised, provider acceptance unverified | ROUTING_ENGINE "The session-aware ladder" (last paragraph) and "Known limits"; ADR consequences |
| 16 | plan A28 | The v1 roles line (`A28`'s "roles line"): only with an explicit `routing.roles` naming an available subagent; agent list from `client.app.agents()`, cached 60 s; absent on the first turn; `roles: {}` changes nothing | ROUTING_ENGINE "OpenCode v1"; ADR D1 |
| 17 | `phase-1.4.md`, `phase-2.3.md` | Surface that a ladder row's `confidence` is the class confidence | ROUTING_ENGINE decision rows, and "Turning it on" (the `/router` `Decision log:` note) |

### Handoffs produced

- **To 3.2.** The guide states as unverified: the notice's position in the transcript, `kept:resume:running` on a real host, session-end events for children (the 1 s wait), effort on the wire for non-Anthropic routes (A7 / scenario 7), the live `host` classifier result (`source: "host"`). Update the guide if 3.2 proves or disproves any of them.
- **To 3.2 or the orchestrator.** Deferred-verification verdicts are documented as not recorded; if 3.2 wires `ingest.onVerdict` from `verifyHandles`, update the "Deferred verification is invisible to the rates" paragraph, the Known limits bullet and the ADR consequence.
- **To 3.4.** Fill the ADR "Evidence" section from `dogfood.md` (DF5 summary, D17 rule and counts, final mode, workload caveat); the changelog's Unreleased entry becomes the `2.3.0` entry; the "Requires OpenCode v2" and `static` notes in the guide stay.
- **To the heavy QA of this phase.** Read the guide against `src\router\config.ts`, `src\routing\classify\scrub.ts` (the gate rule), `src\routing\outcomes\stats.ts` (the lines) and `src\routing\advisor\findings.ts` (the findings table, notify rule); check the worked example arithmetic; check that README, CHANGELOG and ADR do not repeat a claim the guide corrects.

## Verdict

Implementation complete and green; **open findings known to the implementer: 0**; heavy adversarial QA of this phase is pending (orchestrator). Branch `car/p31` pushed.

Verification on the final tree (default pool, no `--pool=threads`, no full suite):

- `npx vitest run test/unit/docs-drift.test.ts`: 12 tests passed (6 existing + 6 new).
- `npx vitest run test/unit/docs-drift.test.ts test/unit/config.routing.test.ts`: passed, including the tests that parse the defaults block and the examples of `CONFIG_REFERENCE.md`.
- `npm run typecheck`: clean.
- Link check: 114 relative links in 6 files, 0 broken, anchors included.
