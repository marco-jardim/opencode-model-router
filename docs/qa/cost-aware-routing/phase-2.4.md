# Phase 2.4 — Cost doctor, commands and plan annotation (M8)

> Plan: `D:\git\opencode-model-router\docs\plans\cost-aware-routing-engine-plan.md` §0.10.10, §1.2, §1.3 M8, §1.6 F3 and F4, D1, D5, D6, D9, D18, amendments A1, A2, A20, A22, A26, A27, A28, §3 "Phase 2.4".
> Worktree `D:\git\omr-car-p24`, branch `car/p24`, base directory `D:\git\opencode-model-router`. Issue #74.
> Implemented by `@medium` in one dispatch chain (tasks 2.4.1–2.4.5, the A28 v1 hunk, the DF2 record). **Heavy QA has not run on this phase**; "Findings" lists only what the implementer found and fixed itself.

## Pre-flight

| Item | Result |
|---|---|
| Worktree and branch | `D:\git\omr-car-p24`, branch `car/p24`, created from `car/main` @ `1fc94a3`; `npm ci` done; `git status --short` empty before the first subtask |
| Dependencies | **2.2 and 2.3 merged (`2878319`)**; Phases 1.1–1.5 and 2.1 are in the base |
| **Linear** | **Linear: not used** |
| **Live engine** | **`shadow` since DF2** (override `{"routing":{"engine":"shadow"}}` created 2026-10-06T15:28:34Z); the live host writes `decisions.jsonl` and `outcomes.json` in the D15 directory while this phase is built |
| Live-store guard | Before the first test run: `decisions.jsonl` 3 998 bytes, no `outcomes*`, no `advisor*` (snapshot `C:\Users\Marquinho\AppData\Local\Temp\Claude\p24-live-before.txt`). After the last run: `decisions.jsonl` 23 200 bytes, `outcomes.json` 1 727 bytes. **Every one of the 35 rows carries a real host session id (`ses_…`) and a model of the live `hybrid-2` preset; none carries a test fixture id (`s1`, `root-1`, `D0`–`D2`, `Q1`, `E1`–`E5`, `W1`, `W2`, `ladder-1`, `ladder-2`, `L1`, `V1`); no `advisor-notice.json` exists there.** The growth is the host session's own dispatches (this orchestrator's); the tests added nothing. Every test of this phase uses a temp directory (`routing.outcomes.path` or the redirected `TEMP`), per A14 never `--pool=threads` |
| Read-only budget | `CAP:none` with a `reason:` line (a whole phase). One exploratory content search ran, read-only, over `C:\Users\Marquinho\.local\share\opencode` (looking for the host's model-catalog field names); it returned unrelated session logs, nothing from it was used and nothing there was written. The field names were then taken from the host source (`packages/schema/src/model.ts` at `v2.0.22`) |
| Never touched | `opencode-model-router.overrides.jsonc`, `opencode-model-router.state.json`, `~/.config/opencode`, the base checkout, other worktrees |

## Implementation notes

### Commits (`git log --oneline 1fc94a3..HEAD`, all `Refs #74`, no AI attribution)

| Commit | Subject | Task |
|---|---|---|
| `6b87d2e` | `feat(routing): add the cost doctor advisor (findings, runAdvisor, throttled notice)` | 2.4.1, 2.4.2 |
| `b36d28e` | `feat(routing): report kept:evidence, trace.argmin keys, orchestrator resumes and the trusted-class footnote in the stats` | handoffs to 2.4 (stats) |
| `a0fccba` | `feat(router): add /router stats (same driver as routing:stats) and the last checkpoint line` | 2.4.5 |
| `c22cc92` | `feat(router): show the cost doctor in /router and inject the throttled notice` | 2.4.3 |
| `3fbeb62` | `feat(router): add route lines to /annotate-plan (batched classification, pin on heavy and QA steps)` | 2.4.4 |
| `003d4d6` | `feat(router): list explicit routing.roles in the v1 R: line (A28)` | A28 |
| `2c2d5a3` | `docs(routing): record DF2 (liveness, shadow start, first row, DF3 observation)` | DF2 record |
| this commit | `docs(routing): add the phase 2.4 QA report` | report |

### Files

| File | Role |
|---|---|
| `src\routing\advisor\findings.ts` (new) | 17 finding ids (`warning` / `saving` / `info`), the checks, `cheapestToolModel`, `runChecks` (a throwing check is reported and skipped) |
| `src\routing\advisor\index.ts` (new) | `runAdvisor(cfg, hostConfig, catalog)`, `hostConfigFromAgents`, `catalogFromModels`, `formatFindings`, `formatNotice`, `advisorSettings`, `createAdvisorNotifier` (throttle persisted in `<outcomes dir>\advisor-notice.json`) |
| `src\routing\commands\stats.ts` (new) | `runStatsCommand` (the script's own `runStatsCli`), `readLastCheckpoint` / `checkpointLine` |
| `src\routing\commands\annotate-plan.ts` (new) | `splitPlan`, `annotatePlanText`, `renderDirectives`, `locatePlan`, `buildAnnotateDirectives` |
| `src\routing\commands\v1-roles.ts` (new) | `v1AgentInfos`, `hasExplicitV1Roles`, `applyV1Roles` |
| `src\routing\outcomes\stats.ts`, `types.ts` | `orchestratorResumes`, `gate` (`keptEvidence`, `argmin`), the new metric rows, the `### Gated by evidence` table, the trusted-classes footnote |
| `src\index.ts` | `/router stats`, the checkpoint line, the Cost doctor section, the notice in the system transform, the `/annotate-plan` handler (a message part), the v1 roles hunk; **1 line removed** against `1fc94a3`: `output.system.push(assembleSystemPrompt(cfg, orchestratorModel, enfOn));` became assemble, the A28 condition, push (the `/annotate-plan` template block is untouched) |
| `src\commands\output.ts` | one help bullet for `/router stats` |
| `src\compat\child-session.ts`, `src\v2.ts` | `routerAgents` and `routerGenerate` on the v2 plugin input (see the API addition below) |
| `test\integration\routing-advisor.test.ts` (52 tests), `annotate-plan-route.test.ts` (23), `v1-roles-line.test.ts` (8); `test\unit\routing-outcomes.stats.test.ts` (82, 6 new, 5 snapshots updated) | |

### How each plan task was done

- **2.4.1 findings.** Fires and clears per finding in the test (`it` per finding, plus the owner fixture: the bundled `anthropic` preset with a routing block yields `variant-effort`, matching the runner's own `effortConfigured` set). The suggestion for `agents.title.model` / `agents.summary.model` is `cheapestToolModel`: enabled, not `deprecated`, `capabilities.tools === true`, priced (A1: not empty and not all-zero), lowest `input + output` at the base price entry, ties on `provider/id`. **It can only return a model that is in the catalog it was given**; a 200-round randomised test checks that and that nothing cheaper qualifies. A missing field (`enabled`, `capabilities`) is "not usable", never "usable".
- **2.4.2 `runAdvisor`, throttled notice.** One state file next to the outcome store, written atomically (temp + `renameWithRetry`), read once per process. A check runs at most once per `routing.advisor.noticeIntervalHours`; **across restarts** a new notifier reads the file and neither calls the host nor notices inside the interval (test). Context delivery persists when the text is handed over (a process that dies in between repeats it); log delivery persists right after logging. Errors: a failing host call, check, read or write is logged (`logger.warn`) and swallowed; after an error the notifier backs off 10 minutes. **Inactive** (no host call, no read, no write, no log) on v1, with `routing.advisor.enabled: false`, and when the config has **no `routing` block** (§1.2).
- **2.4.3 `/router` section and notice.** Bare `/router` on v2 prints `Cost doctor: N findings (w warning, s saving, i info)` with one line per finding and its `fix:` JSON snippet, or what was skipped when the host's agents or catalog were unavailable (each call bounded to 3 s). In the system transform (orchestrator path only) `advisorNotifier.poll()` is O(1) when nothing is due: **advise/enforce** append `Cost doctor notice for the user …` (one turn after the background check starts, like the deferred catalog check); **static/shadow** log the same line. Also printed: that a ladder row's `confidence` is the class confidence (decision 16, 2.3 handoff).
- **2.4.4 `/annotate-plan`.** The command template is **byte-for-byte unchanged** (inline snapshot of the registered template, taken from the plugin as built; the only line `git diff 1fc94a3` removes from `src\index.ts` is the system-prompt push above, not the template). With a live engine on v2 the hook adds **one message part**: the tier and `[route …]` line to add per step, from **one** `classifyMany` call and `annotateSteps` (1.4). `pin` on `[tier:heavy]` (tagged or engine-chosen, A26) and QA steps; an existing route line only ever gains ` pin` and is reported as such; `N pinned by this annotation`; `Classification: backend=…; sources …; backend outcomes …; backend latency … ms; first error: …` (what DF3 step 3 records). `annotatePlanText` produces the whole annotated plan: tests snapshot it before/after on **three plans** (the README example, an excerpt of this plan's §3, a plan without `[acceptance]` blocks with fenced and nested code), assert the output is additive (every original line present, in order, unchanged except an appended tag and ` pin`), idempotent, and that the fenced lines are byte-identical. Plan splitting is mine (1.4: "2.4 owns plan parsing"): top-level list items with their continuation, nested items, fenced blocks (nested fences included) and a following `[acceptance]` block; headings, paragraphs, thematic breaks, tables and indented code are never steps; a plan with no list falls back to `Step`/`Task`/`Phase`/`Stage`/`Milestone` headings. **Static and v1 add nothing** (and make no host call, open no store).
- **2.4.5 `/router stats [--since <ISO>]`.** It runs the very `runStatsCli` the script runs, over the same persister; for the same directory and window the in-session text is the script's stdout (`${text}\n === script stdout`, also for `--json`). With a live engine the rows still queued in memory are flushed first (`flushNow` through the process bundle). The marker `router: engine=<mode> build=<version>+<sha7>` was 1.1's; this adds `router: last checkpoint=DF<n>` from the last `## DF<n>` heading of `docs\qa\cost-aware-routing\dogfood.md` (omitted when the file is absent, as in a published package).
- **A28.** v1 only, only with an explicit `routing.roles` that names an agent: `R: … | by class: search→@explore implement→@general/@reviewer review→@reviewer` through `generateTaxonomy({ host: "v1" })` and `swapTaxonomyLine`. Prose only. **Without it the system prompt is the very string `assembleSystemPrompt` returns** (SHA-256 compared against the baseline for no routing block, `{}`, `engine: enforce`, `advise` with `profile`/`margin`, `roles: {}`, `advisor` and `classifier` blocks; the agent list is not even fetched).

### Amended during implementation (deviations from the plan text)

1. **New directory `src\routing\commands\`** (`stats.ts`, `annotate-plan.ts`, `v1-roles.ts`): the §2 write-set lists only `src\routing\advisor\*` and `src\index.ts` for 2.4. No other phase is in flight and nothing else touches these files; keeping the command logic out of the 2 300-line `index.ts` was the reason.
2. **`src\routing\outcomes\stats.ts` and `types.ts` (Phase 1.3's files) were edited**, because the 2.1, 2.2 and 2.3 handoffs ask for changes to the table both consumers share (`StatsTable` gained two fields; `renderMarkdown` gained rows, a table and the footnote). The literal expectations behind five existing tests in `routing-outcomes.stats.test.ts` (empty table, fixed table, its rendered snapshot, determinism, the empty-window object) were updated to the new fields and text; no assertion was removed.
3. **A minimal API addition outside the 2.2/2.3 code** (listed as asked): `RouterPluginInput.routerAgents` (`ctx.agent.list().data`) and `RouterPluginInput.routerGenerate` (`ctx.generate`), both set only by `src\v2.ts`. The dispatch router, the runner and the kernel are untouched.
4. **`/annotate-plan` does not write the plan file**; it hands the model the exact lines (a message part), because the command is a prompt template whose model edits the file (see the challenge list).
5. **`test\integration\v1-roles-line.test.ts`** is a third test file (A28 asks for "a v1 snapshot test"; the plan names two files for 2.4.1–2.4.5).

### Self-review fixes made before this report (not QA findings)

- CRLF plans: a step carried no terminator, so `annotateSteps` joined the inserted route line with `\n` in a CRLF file. A step now includes its last line's terminator; a final step without one is given the file's, then restored. Pinned by the CRLF test.
- The directive quoted the step's first line **after** annotation (with the tag the model is about to add); it quotes the line as it is in the file.
- `hasExplicitV1Roles` fetched the v1 agent list for `roles: {}`; it now requires at least one named agent.
- The F5 check counted the base and lower rungs as steps; it counts the steps `nextVariant` walks from the base.
- The unknown-catalog title finding no longer says "your catalog has no model" (it says the catalog was unavailable).
- Test fixtures: a classifier model without `provider/` (the validator requires one), a non-absolute `outcomes.path` on Windows, a `locatePlan` order that depended on file-name case.

## Findings

None recorded by a reviewer yet: **the heavy adversarial QA of this phase has not run.** The self-review fixes above are the only defects found; each is covered by a test.

## Deferred by plan

| Item | Where |
|---|---|
| Verdicts of **deferred** verification (`finishDeferred`) and `router_verify` replays are still not recorded (2.1 deferral, repeated by 2.3). Plan §3 does not place them in 2.4 (2.4.1–2.4.5 do not mention them), so they are **not done here**; recorded as a 3.x handoff below | 3.x (3.2 must decide: wire `ingest.onVerdict` from `verifyHandles`, or document the gap in 3.1) |
| Real-host checks: that `ctx.agent.list()` and `ctx.model.list()` records carry the fields the advisor reads (`model` on `title`/`summary`, `enabled`, `status`, `capabilities.tools`), that a notice reaches a real orchestrator context, and the real `host` classifier through `/annotate-plan` | 3.2 (`test\smoke\routing-engine.smoke.test.ts` scenario 5, the advisor) and DF3 (A13, `opencode-go/deepseek-v4.1-flash`) |
| Docs: the advisor and its finding ids, `advisor-notice.json`, `/router stats` and the new table rows, the `/annotate-plan` message part, the v1 roles line, `routerAgents`/`routerGenerate` | 3.1 |
| Measuring the orchestrator's cache-read share with the hint on (2.2 handoff to DF3, QA-2.2-10) | DF3 (not 2.4's) |

## Handoffs

### Handoffs to 2.4 and how each was addressed

| From | Item | Addressed |
|---|---|---|
| `phase-1.1.md` | **A28:** the v1 system-transform hunk, text-only `R:` line for an explicit `routing.roles`, v1 snapshot test | `v1-roles.ts` + the hunk in `index.ts`; `v1-roles-line.test.ts` (inline snapshot of the line; byte-identity by SHA-256 for 7 routing shapes without roles). The agent list comes from `client.app.agents()`, cached 60 s, fetched only with roles; failure → warn, baseline text |
| `phase-1.1.md` | `/router` prints the marker and config notices (`routerStatusLines`); `getConfigNotices` for the advisor | The marker and notices were already printed (1.1); 2.4 adds the checkpoint line and tests the marker in the bare `/router`. The advisor does not call `getConfigNotices` (notices stay in `routerStatusLines`, as before) |
| `phase-1.1.md` (QA-1.1-9) | Advisor finding: catalog validation of every rung of every tier and of `classifier.model` (exists, variant offered, tool calls) | `model-not-in-catalog`, `no-tool-support`, `variant-not-offered`, `classifier-model-missing` (host backend only; HTTP backends name their own model). Dropping such a rung in the engine was 1.5's (`catalogVariantIds`), not 2.4's |
| `phase-1.3.md` | `/router stats [--since]` = flush, then `renderMarkdown(summarize(...))`, equal to the script; the directory listing must stay off the hot path; surface the script's warnings | Same `runStatsCli`; `flushNow` first when the engine is live; equality asserted on stdout and `--json`; the listing happens only inside the user-invoked command (no hook calls it); the script's stderr notes (no outcome data, skipped lines, rotated log) are appended after a blank line |
| `phase-1.4.md` | `annotateSteps` returns `routeEdited` / `changed`: show an edited route line (` pin` added); show `pinnedCount`; an engine-assigned `[tier:heavy]` is pinned (A26); `[route …]` never inside fenced blocks; plan splitting with fences and nested code blocks is 2.4's | `renderDirectives` ("replace its existing route line with … (the only change is `pin`)", "N pinned by this annotation"); `splitPlan` is fence-aware; `expectFencesUntouched` on every plan; nested ```` ```` ```` ```` blocks and tilde fences tested |
| `phase-1.4.md` | Advisor: a role agent whose own model has no `(model, variant)` rung is priced at the owning tier's first rung (E4) | `native-role-unmatched-rung` (only with a live engine, names the tier and its ratio) |
| `phase-1.5.md` | Advisor findings from `VariantLadder.rejected`, `VariantLadder.foreign`, tiers omitted for an invalid variant, F5; **A20** (QA-1.5-8) tiers with `variant` + `effort`/`thinking`/`reasoning`; tiers skipped as covered | `rejected-candidates`, `foreign-candidates`, `variant-not-offered`, `variant-ladder-budget`, `variant-effort`, `covered-tier` |
| `phase-2.1.md` | `/router stats` over `acquireOutcomes` (same process bundle); `ingestSettings` answers "is the engine live" | Both used (`runStatsCommand`, `annotate` runtime) |
| `phase-2.1.md` (QA-2.1-10) | `/router stats` footnote: verdict and refusal rates cover trusted classes only; the script must carry it too | In `renderMarkdown`, so the script and the command print it (pinned in the snapshot and in the `/router stats` test) |
| `phase-2.1.md`, `phase-2.3.md` | Verdicts of deferred verification and `router_verify` replays | **Not done**: the plan does not place them in 2.4 → **3.x handoff** below |
| `phase-2.2.md` (A28) | The v1 hunk | See the first row |
| `phase-2.2.md` | `DecisionRow.trace`: stats and the advisor can show backend failures; the `kept:evidence` count and the `trace.argmin` keys (A27, needed for DF3) | `Kept for lack of evidence (A27)` row and the `### Gated by evidence (trace.argmin)` table in `/router stats` and the script (+ `gate` in `--json`). `trace.backend` status is **not** tabulated in the stats; backend failures are shown per `/annotate-plan` run (the `Classification:` line) |
| `phase-2.2.md` | Advisor should report router-tier `agent-unavailable` (a permission config or a custom primary agent can make the engine inert) | `tier-agent-unavailable` (absent, hidden or primary tier agent; parent-agent permission rules are per session and cannot be judged by the advisor) |
| `phase-2.2.md` | The 2.2 `task_id`/`sessionID` resumes (the `dispatch` row) | A **separate labelled line** `Orchestrator resumes (task_id / sessionID; not a ladder step) \| N of M routed dispatches`, outside the D11 table (which keeps `variant`/`retry`/`escalate` only) |
| `phase-2.3.md` (QA-2.3-13, F-23-1) | Advisor: tiers carrying both `variant` and `effort`; suggest `candidates` or dropping `effort` | `variant-effort` (warning), fires on the bundled `anthropic` preset with a routing block (test); the message says to drop `effort` **and** list `candidates` (candidates alone do not help: an effort-configured tier gets an empty ladder), with a snippet of the catalog's higher variants |
| `phase-2.3.md` | Surface in `/router` that a ladder row's `confidence` is the class confidence (decision 16) | The `Decision log:` note in the bare `/router` (engine ≠ static) |
| `phase-2.3.md` | `/router stats` must call the same `renderMarkdown` | It does (through `runStatsCli`) |

### New handoffs from this phase

- **To 3.x (deferred / `router_verify` verdicts).** `ingest.onVerdict` is not called for `finishDeferred` or `router_verify` replays, so a deferred dispatch has a decision row and no verdict row. 3.2 should either wire it from `verifyHandles` or 3.1 must document that deferred work is invisible to the verdict rates.
- **To 3.1.** Document: the finding ids and severities; that the notice is inert without a `routing` block and persisted in `<outcomes dir>\advisor-notice.json` (`routing.advisor.noticeIntervalHours`); that `/router` queries the host (agent list and catalog, 3 s each) on every bare call on v2; `/router stats` (all script flags, flush first, stderr notes); the new stats rows, the `trace.argmin` table and the footnote; that `/annotate-plan` adds a message part only with a live engine on v2 and never writes the file; `routing.roles` on v1 (prose only; needs `routing.roles` naming at least one agent); the two plugin-input additions.
- **To 3.2.** Smoke on the real host: `/router` output contains the `title-model-unset` finding when `agents.title.model` is unset, and not when set; the notice reaches the orchestrator's context in `advise` and is not repeated after a restart; `/annotate-plan` with a live engine; `ctx.agent.list()` / `ctx.model.list()` really carry `enabled`, `status`, `capabilities.tools` and the agents' `model` (the advisor reads them from the schema, not from a live record).
- **To DF3.** The shadow-period table now has `Kept for lack of evidence`, the `trace.argmin` table and the orchestrator-resume line; read `Dispatches` against `Pass + Fail + Unverifiable` (the footnote) before judging agreement, given the DF2 observation (a listing task labelled `review` at confidence 0.5). The classifier credential check (A13) is `/annotate-plan` on a two-step plan: the message part prints `Classification: backend=host; … backend outcomes: …; backend latency … ms; first error: …`.

## Decisions a QA reviewer should challenge

1. **`/annotate-plan` hands the model lines instead of writing the file.** The template (rule 1) tells the model to put `[tier:X]` at the START of a step; `annotatePlanText` (and 1.4's `annotateSteps`) append it at the END. The message part names the tier and the route line and leaves the tag placement to the template. Alternative: write the annotated plan from the hook (deterministic, but it changes the command's contract and edits a user file before the model runs).
2. **Static and v1 add nothing to `/annotate-plan`**, so `[route …]` is emitted only when the engine will strip and honour it. A user who wants route lines under `static` gets none. Alternative: always emit.
3. **The advisor is inert without a `routing` block**, but a block as small as `routing: {}` or `routing: {engine: "static"}` activates it, in log mode, and writes `advisor-notice.json` into the (default temp) outcomes directory. §1.2 says no new files without a `routing` block; this reads "a block exists" as consent.
4. **The notice is one turn late and persisted at hand-over.** The check runs in the background after the first orchestrator turn; the text is appended on the next turn. A notice that is never delivered (the session ends first) is repeated in the next process.
5. **Which findings notify:** only `warning` and `saving`; `info` stays in `/router`. `variant-effort` is a `warning` and so notifies the owner's current config (bundled presets) once a day under `advise`.
6. **Model eligibility reads host fields from the schema, not a live record:** `enabled === true`, `status !== "deprecated"`, `capabilities.tools === true`, priced. If the live host omits one of them, no model is ever suggested (fails closed). `S4` never checked tool support.
7. **The snippet key `agents.<id>.model`** follows plan §1.1; the owner's `opencode.json` uses `agent.explore.model` (singular). Whether a v2 host reads `agents` or `agent` for `title`/`summary` was not verified.
8. **`effort-not-offered` compares a tier's `effort` with catalog variant ids**; a provider that maps effort differently would be flagged (it is `info`, never notifies).
9. **`/router stats` appends the script's stderr notes** to the text; equality with the script is on stdout only. With a live engine it `acquireOutcomes` + `await ready` (which loads with quarantine, like the runtime does) before reading, so the first call can wait for the store.
10. **`StatsTable` gained `orchestratorResumes` and `gate`** (`version` stays 1: additive, but `--json` consumers see new keys), and the footnote is part of `renderMarkdown`'s text, so every consumer of the markdown gets it.
11. **Plan splitting rules** (top-level items only; a heading is never a step; a following `[acceptance]` block belongs to the step even after a blank line; a step's range includes its last terminator; the heading fallback only when there is no list). A plan whose steps are nested under one top-level bullet is one step.
12. **`agentInfosForPlan` marks every listed agent permitted** (the command has no parent agent) and reads grants from the agent's own rules, so a recommended start tier on evidence may name an agent the real parent cannot dispatch; the effect is limited to an engine-chosen tier for an untagged step.
13. **A second engine runtime lives in `index.ts` for `/annotate-plan`** (own agent-list and catalog caches, same process-wide outcome bundle). Alternative: expose the adapter's runtime to the plugin.
14. **v1:** `mode: "all"` counts as dispatchable, every agent is "permitted" with no grants (text-only line), and the `client.app.agents()` shape comes from the SDK types, not from a run against a real v1 host. `roles: {}` is treated as "no roles" (no fetch, no change).
15. **DF2's liveness is inferred** from the restart timing, not from the `/router` marker (the line was not captured).
16. **`/router` on v2 now waits for two host calls** (up to 3 s each, in parallel) before printing the Cost doctor; the rest of the output is printed even when both fail.

## Verdict

Implementation complete and green. **Open findings: 0 recorded; heavy QA has not been run on this phase.** Branch `car/p24` pushed.

Verification run on the final tree (default pool, no `--pool=threads`, no full suite):

- `npm run typecheck`: clean.
- Own files, `npx vitest run test/integration/routing-advisor.test.ts test/integration/annotate-plan-route.test.ts test/integration/v1-roles-line.test.ts test/unit/routing-outcomes.stats.test.ts`: **4 files, 165 tests passed** (52 + 23 + 8 + 82).
- `npx vitest related <the 11 changed src files> --run --maxWorkers=2`: **53 files passed, 3 skipped; 1 767 tests passed, 55 skipped**.
- Live store before/after: see Pre-flight (tests added nothing).
