# Phase 3.1 — Docs, ADR, changelog (#74)

> Worktree `D:\git\omr-car-p31` on `car/p31`, created from `car/main` at `71815eb`. Tier `[tier:medium]`. Round 0 was documentation plus the docs-drift test extension the plan allows; **round 1 (QA fixes) also changed two code lines** (`src\routing\advisor\findings.ts`, `src\routing\wire\dispatch.ts`), their tests and the plan's §1.5 (A31–A33), as the round-1 dispatch allowed.

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
| Docs-drift extension (12 tests), then strengthened to 29 tests in round 1 | `test\unit\docs-drift.test.ts` | `024a93c`, `b1fe560` |
| This report | `docs\qa\cost-aware-routing\phase-3.1.md` | the commit that adds it |

**Method.** Every key, default, range and rule in the docs was read from `src\router\config.ts` (`resolveRouting`, the validators) and the modules above, not from the plan. The plan was used for intent (D/A ids). Where code and plan disagree, the code is documented; see the divergence table.

**The docs-drift guard** has 29 tests: the 6 that existed, 6 added in round 0 and 17 added in round 1. Round 0: every `routing.*` leaf of `ROUTING_DEFAULTS` plus `roles` and `classifier.presets` has its row in `CONFIG_REFERENCE.md`; every engine mode, task class and cost-doctor finding id is named in backticks in `ROUTING_ENGINE.md`; every `<!-- engine-example: … -->` block parses as JSONC and passes `validateConfig` against the bundled `tiers.json`; the README and plans index link the guide and ADR and the changelog's Unreleased block names #73 and #74; every relative markdown link of five docs resolves, anchors included (GitHub heading slugs), with a negative test for the checker. **Round 1 adds:** the worked example is the **real kernel's output** (`buildLadder` and `decide` on a fixture that states the policy, `roles: {}` and the ratios; the simulated paths, the priors figures `23.011 / 7.162 / 4.772`, the margin threshold `5.730`, the kept-for-evidence decision and the after-evidence figure `2.742` are asserted to three decimals and must be printed in the guide); each engine example resolves to the engine it writes; the **Default** column of the keys table equals `resolveRouting`; the documented **ranges** are the ones `validateConfig` accepts and rejects (boundary values, exclusive lower bound, integer rules, `samples` 1 or 3, the detection ordering); ADR 0005 has `### D1 —` … `### D18 —` headings in order and names A31–A33; the finding table of the guide has every finding id with the severity the source gives it.

**Link check, separate from the test.** A standalone node script (not committed; same algorithm as the test, plus the report) checked README, the guide, the ADR, the plans index, the config reference, `CHANGELOG.md` and this report: `checked 117 relative links in 7 files; broken: 0`; a negative fixture showed it reports a missing file and a missing anchor. External `http(s)` links were not fetched.

**Corrections made during the phase.**

- *Amended during implementation (orchestrator correction):* the first drafts of `ROUTING_ENGINE.md`, ADR 0005 and `CONFIG_REFERENCE.md` said the DF3 credential gate had blocked the `host` backend and that a fix to the gate was in progress. That was wrong. Fixed in `dc1c40f`: `host` is experimental because the plan's DF3 criterion was not observed, the live probe shows the backend consulted (status `ok`, label `other`), and the gate is described as a by-design policy with its full rule (credential words including `token`, env-style `*_TOKEN/_SECRET/_PASSWORD/_API_KEY/…` and upper-case `*_KEY` names, a `.env` reference, PEM headers, anything the scrubber redacts by shape; an entropy-only redaction does not skip the backend), checked against `hasCredentialSignal` in `src\routing\classify\scrub.ts`.
- The TypeSafe row said `apiKeyEnv` is required; validation does not require it, the backend checks it at call time and disables itself with a logged reason. Fixed in `93de093`.

**Numbers in the worked example** (ROUTING_ENGINE.md): the first draft priced a plain chain by hand (`22.25 / 9.015 / 5.865`, threshold `7.212`) and claimed that was what the kernel reduces to; QA-3.1-3 showed it does not. They are now the real kernel's figures for the stated policy (`C(heavy) = 23.011`, `C(medium) = 7.162`, `C(fast) = 4.772` on priors, threshold `0.8 · 7.162 = 5.730`, `C(fast) = 2.742` after 10 passes and 2 failures), pinned by the drift test.

### Plan amendments the docs follow (not divergences)

Where the plan's §1.4/D-text and the code differ **because an amendment says so**, the docs follow the amendment and name it.

| Plan text | Code (amendment) | Documented in |
|---|---|---|
| §1.4: `enforcement.escalate.variantSteps` "default auto" | `auto` only with a `routing` block on v2, `none` without one and always on v1 (**A15**); an explicit value always wins | CONFIG_REFERENCE; ROUTING_ENGINE |
| D9: `C(best) ≤ (1 − margin) · C(chosen)` | strict `<` (**A16**) | ROUTING_ENGINE, CONFIG_REFERENCE |
| D9 / A24: a down switch needs 5 outcomes | the evidence gate filters candidates before the argmin and counts **effective** outcomes on the candidate's own key (**A24, A27**) | ROUTING_ENGINE, ADR D9 |
| §1.4: the project layer may set any `routing` key | the project-local override cannot set `classifier.{backend, model, baseUrl, apiKeyEnv, presets}` or `outcomes.path` (**A18**) | CONFIG_REFERENCE trust section; ROUTING_ENGINE privacy |
| D9: a resume is a dispatch like any other | never switched by the engine; a resume keeps the child where it runs (**A30**, amended); a floor-lifted resume is the policy exception | ROUTING_ENGINE; ADR D9 |
| F4 / acceptance 8: the doctor reports unset `agents.title.model` **and** `agents.summary.model` | one `title-model-unset` finding that follows the host's own title pick; no `summary` finding (**A31**, recorded in round 1) | ROUTING_ENGINE cost doctor |
| F4: a one-line notice "appended to the orchestrator's context" | a synthetic transcript entry, one user turn late, per-project throttle, weekly reminder (**A32**, recorded in round 1) | ROUTING_ENGINE cost doctor |
| F4 / §1.1: `maxAttemptsPerTier: 1` means "every failure escalates straight to a bigger model" | `nextAction` re-runs the same rung once first; the `attempts-without-variants` finding is reworded (**A33**, recorded in round 1; code change in `findings.ts`) | ROUTING_ENGINE cost doctor; plan §1.5 |

### Code vs plan: divergences (the code is documented; no amendment covers them)

| # | Plan | Code | Where documented |
|---|---|---|---|
| 1 | §1.4 has no `routing.advisor.notify` | `advisor.notify`, boolean, default `true`; `false` = the doctor never notifies, the `/router` section stays | CONFIG_REFERENCE keys table; ROUTING_ENGINE cost doctor |
| 2 | §1.4 gives no ranges | `margin` [0, 0.9]; `minClassConfidence` [0, 1]; `detection.*` [0, 1] with `deterministic ≥ grader ≥ none` on the effective values; `classifier.timeoutMs` [100, 30 000]; `samples` 1 or 3; `maxStateChars` [200, 20 000]; `outcomes.halfLifeDays` [1, 365]; `maxEffectiveSamples` [5, 1000]; `sessionReuse.maxContextFraction` (0, 0.95]; `advisor.noticeIntervalHours` [1, 720] (now pinned against `validateConfig` by the drift test) | CONFIG_REFERENCE keys table |
| 3 | §1.4: `outcomes.path` null or a path | must be absolute (a drive letter or UNC on Windows) or `~`-prefixed | CONFIG_REFERENCE keys table |
| 4 | §1.4 `roles` lists classes | an unknown class is rejected; an empty array per class is allowed; ids match `^[A-Za-z0-9][A-Za-z0-9_./-]*$` without `.`/`..` segments; the whole map is replaced by the highest layer that sets it | CONFIG_REFERENCE roles |
| 5 | §1.4 `classifier.apiKeyEnv` "typesafe only / openai-compatible" | optional for `openai-compatible` (none = no `Authorization` header); for `typesafe` checked at call time, not at load | ROUTING_ENGINE backends table |
| 6 | A2: the cheapest suggestion is among "priced models whose catalog entry supports tool calls" | the title suggestion uses the host's own `Model.small` predicate (text in and out, enabled, active), **not** tool support; the ladder findings (`no-tool-support`) still check tool calls | ROUTING_ENGINE cost doctor (`title-model-unset`, `no-tool-support`) |
| 7 | D5: USD "if every candidate has catalog pricing (non-empty `Model.Info.cost`) or ≥3 measured samples" | priced is not enough: a priced candidate needs a **token profile** (its own or its class's) to be priced in USD; otherwise the whole decision falls back to `costRatio` units (clarification C1) | ROUTING_ENGINE "Cost units" |
| 8 | §0.11 / D15: a decision row of `ts, mode, sessionID, childSessionID, facts, chosen, best, switched, pinned, unit, costs, confidence, reason` | rows also carry `v`, `kind`, `decisionID`, `step`, `resume`, optional `trace` (route-line count, backend outcome, `backendSkipped`, `argmin`); verdict and refusal rows (with `overrides`) share the file | ROUTING_ENGINE outcomes section |
| 9 | D15 "≤ 5 MB, rotated" | 5 MiB, 3 rotated generations, `outcomes.json` quarantine copies (3) | ROUTING_ENGINE outcomes section |
| 10 | `npm run routing:stats` presented as the stats tool | a repository script (not in the npm `files` list) that needs Node ≥ 22.18 / 23.6; `/router stats` is the packaged equivalent | ROUTING_ENGINE stats section; CHANGELOG |
| 11 | D8 `next(k)` as a chain of tiers; the first draft of the worked example priced that chain | the kernel evaluates the formula over the **simulated runner path** (retry, escalation, ceiling), so the real figures differ from the chain's (QA-3.1-3) | ROUTING_ENGINE worked example, pinned by the drift test |

## Findings

No adversarial QA has reviewed this phase yet (the plan assigns it to a separate heavy dispatch, which reads the docs against the code and flags any divergence as `major`). Findings the implementer raised and fixed during the phase:

| Id | Sev | File | Description | Resolution |
|---|---|---|---|---|
| QA-3.1-1 | major | `docs\ROUTING_ENGINE.md`, `docs\adr\0005-cost-aware-routing-engine.md`, `docs\CONFIG_REFERENCE.md` | A wrong claim from the dispatch brief (the credential gate "blocked" the `host` backend and a gate fix was in progress) was written into the docs | `dc1c40f` (see Implementation notes) |
| QA-3.1-2 | minor | `docs\ROUTING_ENGINE.md` | TypeSafe `apiKeyEnv` described as required at load | `93de093` |

Round 1 (heavy adversarial QA, 17 findings: QA-3.1-3 to QA-3.1-19, plus one code side note) is answered in [Round 1 fixes](#round-1-fixes). **Open: QA-3.1-13, -14, -15 and -16** (their text was not in the round-1 dispatches, which said "as the report states"; see the table).

## Round 1 fixes

Commits are on `car/p31`; "guide" is `docs\ROUTING_ENGINE.md`, "ADR" is `docs\adr\0005-cost-aware-routing-engine.md`. The first column is the finding id; severities are in the QA report, which this tree does not hold.

| Id | Finding (as the round-1 dispatch states it) | Fix | Commit(s) |
|---|---|---|---|
| QA-3.1-3 | The worked example's figures were the plain chain, not the kernel's | Rewritten with the policy and `roles: {}` stated, the three simulated paths tabulated and the real figures (23.011 / 7.162 / 4.772 on priors, threshold 5.730, `kept:evidence`; 2.742 after 10 of 12) with the arithmetic; the line-148 caveat replaced (the kernel evaluates the formula over the runner's simulated attempts). Drift test runs `buildLadder` + `decide` and asserts every printed figure to 3 decimals and the paths | `8fd01ac`, `b1fe560` |
| QA-3.1-4 | The candidate set was misdescribed | Step 3 of "How one dispatch is routed": every router tier on the escalate ladder (each rung on the tier's own model) plus `routing.roles[class]` agents; unavailable role agents are excluded at build time; below-floor, `needs`-uncovered and never-down candidates stay priced but cannot be `best` | `8fd01ac` |
| QA-3.1-5 | `attempts-without-variants` premise false (code) | `findings.ts` message reworded ("a failed verification re-runs the same rung once in a fresh child, then escalates; variant steps would retry a higher variant on the same session"); `=== 1` kept; test pins the wording; guide row updated; plan **A33** recorded | `efa77e2`, `8fd01ac`, this report's commit (guide row) |
| QA-3.1-6 | "long hex run" listed as a gate trigger | Dropped from the gate list; hex runs are redacted as an entropy guess and the redacted state is still sent; ADR D14 says "redacted by shape" | `8fd01ac`, `50e3836` |
| QA-3.1-7 | Evidence was described as "recorded" outcomes | Everywhere: at least 5 **effective** outcomes on the candidate's own key for the class (decayed by `halfLifeDays`, capped by `maxEffectiveSamples`): guide (generated `R:` line, evidence gate, worked example), ADR D9, CHANGELOG, README, CONFIG_REFERENCE; the guide notes that `/router stats` "By key" shows raw lifetime counts | `8fd01ac`, `50e3836`, `a1543f2`, `f8efe14` |
| QA-3.1-8 | A20 sentence wrong about the bundled presets | `anthropic` has `effort` on all three tiers (fast `low`), so no variant steps or cross-tier resume; `hybrid-2`'s fast tier has none | `8fd01ac` |
| QA-3.1-9 | ADR said `enforce` "behaves like `static`" | "Nothing moves down or sideways on priors; upward switches and floor lifts still occur" | `50e3836` |
| QA-3.1-10 | A30 stated without its exception | A floor-lifted resume in `enforce` is `switched: true`, reason `lift:floor` (guide, ADR D9 and the amendment index) | `8fd01ac`, `50e3836` |
| QA-3.1-11 | `/router stats` on v1 | It reads only what an earlier v2 run left, with no flush (listed only with a `routing` block) | `8fd01ac` |
| QA-3.1-12 | Plugin-input additions incomplete | `routerCatalog` and `routerOnIngest` (and `routerHost`) listed with `routerAgents`, `routerGenerate`, `routerSynthetic` | `8fd01ac` |
| QA-3.1-13 | not in the dispatch | **Not addressed**: the dispatches said "as the report states" and did not include the text | — |
| QA-3.1-14 | not in the dispatch | **Not addressed** (same) | — |
| QA-3.1-15 | not in the dispatch | **Not addressed** (same) | — |
| QA-3.1-16 | not in the dispatch | **Not addressed** (same) | — |
| QA-3.1-17 | Divergence table incomplete | #2/#4 relabelled as plan amendments (A15, A16) in a separate table; added A2 (text-in/out `Model.small` check vs tool calls), D5 "priced needs a token profile" and the F4 attempts premise (A33); the doctor's `summary`/notice rows are now **A31** and **A32**, recorded in plan §1.5 with **A33**; the ADR amendment index lists A31–A33 and says A1–A33 | `efa77e2`, `50e3836`, this report's commit |
| QA-3.1-18 | Drift tests too weak | Example engine equals the written engine; Default column checked against `resolveRouting`; documented ranges checked against `validateConfig` boundaries; ADR `### D1`–`### D18` headings; finding id and severity table against `findings.ts`; real-kernel worked example | `b1fe560` |
| QA-3.1-19 | Nits | CHANGELOG "22.18 / 23.6"; README `/router` row and `enforce` row wording; the marker (`router: engine=… build=…`) described with its `unknown` case; `subagent` added to `explore`'s tool list. "README engine-line wording" was read as the `/router` marker line and the `enforce` row; if it meant something else it is open | `8fd01ac`, `a1543f2` |
| Side note | `kept:resume:running` said "sent to @X" for a pinned resume (code) | The reason names a pinned resume as not rewritten ("pinned, so it is sent as named and NOT rewritten (the host moves the child to @fast)"); the test fails without the change. The line is **byte-identical to car/p32's** (`git diff car/p32 -- src/routing/wire/dispatch.ts` is empty), so the merge has nothing to resolve | `39848fd`, `ed5814d` |
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
| 9 | `phase-2.2.md`, `plan A27` | An unevidenced option (fewer than 5 **effective** outcomes on its own key) is not eligible as `best` unless it ranks above the pick; the gated cheapest option is logged as `trace.argmin` | ROUTING_ENGINE worked example, "When `enforce` switches", decision rows, stats; ADR D9 |
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

Round 1 fixes are in and green **except QA-3.1-13 to QA-3.1-16, which are open because their text never reached this worker**: the orchestrator must send the four findings (or the QA report) for a further round. Everything else of QA-3.1-3 to QA-3.1-19, the code side note and A31–A33 is done. Branch `car/p31` pushed.

Verification on the final tree (default pool, no `--pool=threads`, no full suite):

- `npm run typecheck`: clean.
- `npx vitest run test/unit/docs-drift.test.ts`: 29 tests passed.
- `npx vitest run test/unit/docs-drift.test.ts test/integration/routing-advisor.test.ts test/integration/routing-dispatch.test.ts`: 3 files, 194 tests passed (docs-drift 29, advisor 78, dispatch 87).
- `npx vitest run test/unit/docs-drift.test.ts test/unit/config.routing.test.ts`: passed (the tests that parse the defaults block and examples of `CONFIG_REFERENCE.md`).
- `npx vitest related src/routing/advisor/findings.ts src/routing/wire/dispatch.ts --run --maxWorkers=2` (final tree, default pool): **42 files passed, 3 skipped; 1 092 tests passed, 55 skipped**. An earlier run of the same command (before the last dispatch.ts wording change) had 3 tests fail with `Test timed out in 5000ms` (`ladder-effort-wiring`, `modeB-e2e`, `layer2-wiring`: v1 plugin-wiring tests of about 5 s each on this machine, slow under load); rerun without the worker cap one of them timed out again (a different test), and with `--testTimeout=60000` all 34 passed; no assertion failed, and the final run above is clean.
- Link check: 117 relative links in 7 files, 0 broken, anchors included.
