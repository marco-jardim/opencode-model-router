# Phase 2.2 — Dispatch-time routing on v2 (M7)

> Plan: `D:\git\opencode-model-router\docs\plans\cost-aware-routing-engine-plan.md` §0, §1.2, §1.3 M7, D1–D4, D8, D9, D12, D13, D15, amendments A1, A3, A11, A14, A16, A17/A17a, A19, A22, A24, A25, §3 "Phase 2.2".
> Worktree `D:\git\omr-car-p22`, branch `car/p22`, base directory `D:\git\opencode-model-router`. Issue #74.
> Tasks 2.2.1 (design) and 2.2.2–2.2.4 (implementation) were executed in one dispatch by `@medium`; the design is the "Implementation notes" below. The adversarial `[tier:heavy]` QA of §0.7 has not run yet (see Verdict).

## Pre-flight

| Item | Result |
|---|---|
| Worktree and branch | `D:\git\omr-car-p22`, branch `car/p22`, created from `car/main` @ `a2a132d`; `git status --short` empty before the first task |
| Dependencies | **2.1 merged** (`a08229c`, QA PASS round 3). 1.1–1.5 merged (the kernel `src\routing\engine\*`, the classifier, the outcome store and the ladder algebra were read and used as they are; none of them was changed except the three small additions listed under "Merged modules touched") |
| `npm ci` | Done in the worktree by the orchestrator before the dispatch |
| Linear | **Linear: not used** (consistent with `phase-0P.md` and `phase-2.1.md`) |
| Parallel work | Phase 2.3 (ladder resume wiring in the delegate runner) runs in `D:\git\omr-car-p23`. This phase did not touch `src\index.ts`, `src\escalate\*`, `src\compat\v2-client.ts` or `src\v2.ts` (`git diff a2a132d..HEAD --stat` over those paths is empty) |
| Spike verdicts used | **S1 confirmed** (reassigning `event.input` with a different agent and `model#variant` in `tool.hook("execute.before")` is honoured); **S1-deny** (the host re-checks permissions after the rewrite: `Subagent denied: explore`) → A11; **S2-agent-native** (an agent switch changes the tool set) → needs come from evaluated permissions; **S3/S3b** (A3, module-scope registry and dedupe) |
| Handoffs read | `phase-0P.md`, `phase-1.1.md`, `phase-1.2.md`, `phase-1.3.md`, `phase-1.4.md`, `phase-1.5.md`, `phase-2.1.md` — every item addressed to 2.2 is in the table under "Handoffs" |
| Typecheck | `npm run typecheck` green before every commit and at `HEAD` |
| Scoped tests | See the Verdict (final run at `HEAD`). Default pool throughout (A14); no `--pool=threads`, no full suite |
| Real-directory checks (after the runs) | `Test-Path C:\Users\Marquinho\.config\opencode\opencode-model-router.overrides.jsonc` → `False`; `C:\Users\Marquinho\AppData\Local\Temp\opencode-model-router-trajectory`: 0 `outcomes*`, 0 `decisions*` (13 844 older `*.scorecard.log`/`*.delegate.log` files are not ours); 0 `router-dispatch-*` directories left in the real temp directory |

## Implementation notes

### What was built

| Task | Files | Commit |
|---|---|---|
| 2.2.1 design (this section) | — | — |
| trace on decision rows (Phase 1.2 handoff) | `src\routing\outcomes\types.ts` (`DecisionTrace`, optional `DecisionRow.trace`), `src\routing\outcomes\persist.ts` (`readTrace`) | `ced0114` |
| agent view, permissions, catalog | `src\routing\wire\host-info.ts` (new) | `b7add0f` |
| 2.2.2 / 2.2.4 dispatch router, runtime, hint, protocol seam | `src\routing\wire\runtime.ts`, `src\routing\wire\dispatch.ts`, `src\routing\wire\hint.ts` (new), `src\router\protocol.ts` (`DELEGATION_PROTOCOL_HEADING`, `swapTaxonomyLine`, `buildRouteLineProtocol`) | `9406ee2` |
| 2.2.2 / 2.2.3 adapter wiring | `src\compat\v2-hooks.ts` | `2b55bde` |
| statistics fix found while logging would-switch rows | `src\routing\outcomes\stats.ts` | `8930e03` |
| tests | `test\integration\routing-dispatch.test.ts` (36), `test\unit\routing-wire.host-info.test.ts` (13), `test\unit\protocol.test.ts` (+10), `test\unit\routing-outcomes.persist.test.ts` (+1), `test\unit\routing-outcomes.stats.test.ts` (+1) | `4c0ea15`, this commit |

### Design (2.2.1)

**Shape.** One runtime per plugin instance (`createEngineRuntime`) is shared by the dispatch path and the context hook; it is created in `registerV2Hooks` and disposed in `cleanup` (after the ingest, before the event task). It owns, lazily and only while `routing.engine != static`: the process-wide outcomes bundle (A3: store for reads, flusher for rows), a 5 s agent-list cache, a model-catalog cache (`createWireCatalog`: stale-while-revalidate, first load bounded to 2 s, back-off after a failure or a hang) and the classifier backend (built once per distinct resolved classifier settings, Phase 1.2 handoff).

**Static is a no-op (§1.2).** `prepare()` calls `loadConfig` (or takes the caller's config), asks `ingestSettings(cfg, "v2")` (cached per config object) and returns `null` for `static` before any host call, any bundle, any disk access; a held bundle from an earlier non-static config is released. A config without a `routing` block resolves to `static`, so the adapter's behaviour is the 2.2.0 behaviour. Tests: no `ctx.session.get`, no `ctx.model.list`, an empty outcomes directory, no `decisions*` file, no default trajectory directory, and the system prompt equal to `v2Instructions(assembleSystemPrompt(...))` byte for byte.

**`execute.before` order** (`src\compat\v2-hooks.ts`): `scopedArgs` → the model `subagentTiers` would fill in (`tierModel`, computed exactly as before: only when the call names no model and the agent is mapped; nothing is written yet) → **`dispatchRouter.route(...)`** → apply the outcome (`prompt`, then `agent`/`subagent_type`, then `model`) → `subagentTiers` fills `model` only if it is still missing → the `original` snapshot is taken (so a stripped route line is not "added" text for `translateAdded`) → the legacy `tool.execute.before` (it sees the final agent, so headers and the depth banner follow the switch) → `nativeArgs`. The engine's `chosen` is resolved with `callModel = args.model ?? tierModel`, so an agent mapped by `subagentTiers` is priced on the model it will run on; after an `enforce` switch the engine always writes a model of its own, so the override never fires on top of it ("engine first; `subagentTiers` only fills a missing `model`").

**`route()` per call** (`src\routing\wire\dispatch.ts`):

1. Skip when `agent` is not a string or is the adapter's grader agent; `prepare()` → `null` ⇒ untouched.
2. Read the dispatching session once (`ctx.session.get`): its `parentID` (a **child session's dispatch is left exactly as it is**: nothing parsed, nothing stripped, no row), directory (the classifier's `cwd`, never the prompt's own `Working directory:` line), model (the orchestrator's: `parentModel`) and `permissions`.
3. `classify({ description, prompt, cwd }, deps)` once; `result.stripped` is the prompt without its `[route …]` line(s), `result.pin`, `result.detection ?? detectionOf(prompt)`, `result.trace` goes to the row. A22: the route line only counts as the first non-empty line (the classifier default; production never uses `edges`/`any`).
4. Agent view from `ctx.agent.list()` (router tier agents included, Phase 1.4 handoff): `permitted` = the last matching rule of `[parent agent rules, session rules]` for `subagent:<agent>` is an explicit `allow`; `grants` = needs covered by the agent's own EVALUATED rules, **unconditional allows only** (`ask`, `deny` and resource-limited rules grant nothing; `grantsFromTools`, QA-1.4-14). An unknown parent agent permits nothing.
5. `resolveChosen` → `buildLadder({ …, session })` → `decide({ …, store, floorRank })`. `session` is the runner's own policy input (`host: "v2"`, `variantSteps` from `resolveVariantSteps` (A15), `maxContextFraction`, a non-throwing catalog lookup, `warn`), so the simulated router block uses the same variant steps, A17 reserve and A17a `triedByModel` as the 2.3 runner will (A25).
6. Mode: **shadow**/**advise** write the row and change nothing but the stripped route line; **enforce**, when the decision is `switched` with a `target` and is not pinned, writes `agent`/`subagent_type` and `model#variant`; a dispatch below `floorTier` is lifted to the floor tier's base rung (see the decisions list).
7. Row (`DecisionRow`, `step: "dispatch"`): `mode`, `facts`, `chosen` (the orchestrator's pick), `best`, `switched` (the kernel's flag in every mode: in shadow/advise a would-switch; `stats.ts` now reads `mode` for the dispatched key), `pinned`, `unit`, `costs`, `confidence`, `reason` (`<reasonCode>: <reason>`), `resume`, `childSessionID` (known only for a resume), `trace`. Written with `flusher.enqueue` only (D15: no I/O on the dispatch).
8. Registration for ingestion (2.1 handoff, QA-2.1-R2-10): **once per execution of a child**. A resume (`sessionID` given) is registered at once (a new attempt, new `decisionID`); a fresh child does not exist yet, so the dispatch waits in a per-parent queue and is claimed by the child's `session.created` event (same parent; same agent when the event names one; title equal to the description when there are several; else the oldest), dropped when the tool call ends (`execute.after`), after 120 s, or beyond 200 waiting dispatches. The record carries the final dispatched agent, `provider/model`, variant, tier (router agents only), `acceptance` (`deterministic|grader|none`), `parentSessionID`, `decisionID`, the classifier facts (class = the rules' class unless the backend agreed, A19).
9. Errors: every failure (session, agent list, catalog, store, classifier, kernel) is logged through the plugin logger and the call goes through as the orchestrator wrote it; there is no empty `catch`.

**Context hook** (`src\routing\wire\hint.ts`, called right after the legacy `experimental.chat.system.transform`): finds the pushed text that starts with the delegation-protocol heading (so a child, which receives none, is never touched); `static` and `shadow` return before changing anything; `advise`/`enforce` (a) swap the taxonomy line for `generateTaxonomy(...)` with `swapTaxonomyLine` (a splice, never `String.replace` with a string, QA-1.4-11; inserted before the decomposition hint or `Rules:` when the protocol has no `R:` line), recomputed at most every 60 s per config object and agent; (b) append `buildRouteLineProtocol(mode)` (2.2.3); (c) push a per-turn hint as a separate system part: classify the latest user message with the rules classifier only (no model call), take the class's static tier as the orchestrator's pick, `decide`, and only if the kernel says `switched` print ≤ 2 lines (`Route hint: for <class> work like this turn, prefer @agent (description) over @pick.` / `Why: <reason>`), cached per session for the text of the turn. The hint is therefore never in conflict with the generated `R:` line (the same kernel, the same gates).

**Protocol seam (amended during implementation).** The plan's seam was "`buildTaskTaxonomy` accepts an optional precomputed line". The protocol is assembled by the legacy hook in `src\index.ts` (not in this phase's write-set), so a parameter would have been unreachable from the adapter. The seam is the text-level `swapTaxonomyLine(protocol, cfg, line)` in `protocol.ts` plus `DELEGATION_PROTOCOL_HEADING`; `buildTaskTaxonomy`, `buildDelegationProtocol` and `assembleSystemPrompt` are unchanged (their golden snapshots are untouched and green).

**Protocol text (2.2.3).** One paragraph for `advise`/`enforce`: the optional first-line `[route class=… risk=… scope=… needs=… pin]` (vocabularies listed, every field optional, "a route line anywhere but the first line is plain text"), the bare `pin` flag for plan tags and policy (`[tier:X]`, QA), what the router does in each mode, and how to read a `Route hint`. It never mentions a model (§0.10.11; the test asserts `\bmodel\b` is absent). `static` and `shadow` receive nothing.

### Merged modules touched (minimal, additive)

- `src\routing\outcomes\types.ts` / `persist.ts`: optional `DecisionRow.trace` (Phase 1.2 handoff: `routeLines {count, conflict, edgeOnly}`, `backend {id, status, latencyMs, label?, rejected?, disagrees?}`, `backendSkipped`); the parser keeps a well-formed trace and drops a malformed one without dropping the row.
- `src\routing\outcomes\stats.ts`: `dispatchedKey` counts a `switched` row under `best.key` only when `mode === "enforce"`. Before this phase nothing wrote a shadow row, so the 1.3 comment ("`best` when `enforce` switched") was true by construction; with 2.2 a shadow/advise row is a would-switch. The "Switched" count (the DF3 would-switch count) is unchanged.
- `src\router\protocol.ts`: only the three additions above.

### `src\compat\v2-hooks.ts` hunks (every one)

| # | Region | Change |
|---|---|---|
| 1 | imports | `createEngineRuntime`, `createDispatchRouter`, `createSystemAugmenter` |
| 2 | before `let eventTask` | creation of `engine`, `dispatchRouter`, `systemAugmenter` (14 lines; `sessionOf` casts the id to the client's parameter type, no `any`) |
| 3 | `cleanup` | `await engine.dispose()` after `ingest.dispose()` and before `await eventTask` |
| 4 | context hook | `routerConfig` hoisted from the `verify` read (one `loadConfig` per hook call); `await systemAugmenter.augment({...}, output.system, added)` right after the legacy transform |
| 5 | `execute.before` | the `subagentTiers` block restructured as above (same conditions, same result in `static`), the `route` call and the outcome application, the `original` snapshot moved after routing |
| 6 | `execute.after` | one line at the top: `dispatchRouter.onCallFinished(event.id)` |
| 7 | event loop | one line before the `session.deleted` branch: `session.created` → `dispatchRouter.onSessionCreated(...)` (this is the registry call; the 2.1 step/flush/deleted branches are untouched) |

No hunk in `src\index.ts`, `src\escalate\*`, `src\compat\v2-client.ts`, `src\v2.ts` or any v1 path.

### Tests (plan §3 "Phase 2.2" Tests paragraph → where)

| Required case | Test (`test\integration\routing-dispatch.test.ts` unless noted) |
|---|---|
| `static` → input untouched, no log | "a config with no routing block …" (also `session.get`/`model.list` never called, empty outcomes dir, no default trajectory dir), "engine: static with a routing block …", "the system prompt of a static session is the legacy one" |
| `shadow` → input untouched, decision logged, `switched` computed | "logs a decision row (switched = would switch) …", "with no evidence … kept row", "shadow leaves the system prompt exactly as …" |
| `advise` → input untouched, hint in context output, `R:` replaced only with data | "the dispatch is untouched …", "with evidence the R: line gains a by-class segment …", "without evidence the R: line is the shipped one and there is no hint", "the hint is stable within a turn …", "enforce appends the paragraph … shadow never does" |
| `enforce` + margin → agent/model replaced, header still injected, `[route …]` stripped | "margin satisfied: agent and model are replaced, the legacy hook still sees the final agent …" |
| `enforce` + margin not satisfied → `kept` | "margin not satisfied …" |
| `enforce` + `[route pin]` → untouched, `pinned: true`, computed `best`; the pin line stripped | "[route pin] …" and "a pin is only honoured on the first line (A22) …" |
| `needs: [shell]` with explore best → `kept` with reason | "needs [shell] with explore as best: kept …" (A11) |
| `subagentTiers` both ways | "subagentTiers still fills a missing model when the engine does not switch, and never overrides the engine's own" |
| classifier backend timeout → rules facts, dispatch proceeds | "a classifier backend that hangs falls back to the rules facts …" |
| plan `[route … d=…]` authoritative | "a plan route line is authoritative …" (source `plan`, `acceptance: deterministic` in the registry) |
| `event.input` reassignment preserves unrelated fields | "an unrelated field survives the reassignment (sessionID, background) …" |
| local path < 5 ms over 100 dispatches | "latency" (best of three batches of 100; measured once at 1.7 ms static, 2.3 ms shadow, 2.0 ms enforce per dispatch, almost all of it `loadConfig`, ≈1.5 ms) |
| a throwing engine never blocks the dispatch | "an engine failure is logged …", "an agent list that fails keeps the orchestrator's choice …" (both assert the log line) |
| never moves a high-risk dispatch down | "never switches a high-risk dispatch without verification down a rank" |
| `floorTier` applied to the dispatch (1.4 handoff) | "floorTier lifts a dispatch that starts below it, and the row says so" |
| A22 / injection | "a pin is only honoured on the first line", "a subagent's own dispatch (a child session) is left exactly as it is", "the verification grader agent is never routed" |
| registration (2.1 handoff) | "a fresh child is registered when its session.created arrives …", "a second execution of the same child is a new registration (QA-2.1-R2-10)", "a dispatch whose call ended without a child is dropped …", "an agent mismatch is not claimed", "a session.created without an agent claims the oldest …", "the waiting list is bounded …", "a dispatch is forgotten after the waiting limit", "static registers nothing …" |
| hot reload to static | "a hot reload to static stops everything at the next dispatch …" |
| unit | `routing-wire.host-info.test.ts` (wildcards, last-match-wins, unconditional allows, grants, `permitted`, agent view, catalog ttl/back-off/timeout); `protocol.test.ts` (heading, splice incl. `$&`/`$1`/`$$`, insertion points, route paragraph); `routing-outcomes.persist.test.ts` (trace round trip, malformed trace dropped); `routing-outcomes.stats.test.ts` (would-switch attribution) |

### Self-checks run during the phase (not QA findings)

- An empty `python -` call hung a shell command until its timeout during the tracing edit (no file was touched); the edit was redone with the editor tool.
- First run of the integration file: 12 of 31 failed; causes were test expectations (the legacy hook's `v2Instructions` translation of pushed text, `source: "plan"` for a `d=` line, the classifier `timeoutMs` minimum of 100) and two real findings of mine: (a) `loadConfig` ran four times per dispatch (≈1.5 ms each; now one per hook call, passed down), (b) with the D12 default roles `general` is the kernel's argmin and blocks every other move (see the decisions list, item 7). Both are recorded below.
- Two full `vitest related` runs over the changed sources (81 files in parallel, default worker count, with Phase 2.3 working on the same machine) failed differently each time: first the latency test (wall time), then three unrelated timing-sensitive tests (`config.routing` "hundreds of distinct notices", `v2-client` "drives the shared verified-delegate path", `v2-hooks` "evicts the oldest banner above 1000 pending calls"). All pass in isolation (1.0–2.0 s against a 5 s timeout); `v2-hooks` "evicts the oldest banner" takes 1.90–2.01 s with the 2.2 adapter and 1.90–1.99 s with the 2.2.0 adapter, three runs each, so the wiring adds no measurable cost there. The latency test now measures the process' CPU time (best of three batches of 100) instead of wall time, and the final `related` run uses `--maxWorkers=4` to keep the machine from timing the others out.
- No `as any`, `@ts-ignore` or `@ts-expect-error` in the new code or tests. Narrow casts: `ctx.session.get({ sessionID } as Parameters<typeof ctx.session.get>[0])` (branded id), `cost as ModelPricing` on a non-null object (the same cast as `ingest.ts`, validated entry by entry downstream).

## Findings

No adversarial QA round has been run on this phase yet. Items found by the author during the work and fixed in it: the per-dispatch `loadConfig` repetition (`2b55bde`), the stats attribution of would-switch rows (`8930e03`), the wall-clock capture in the wire modules (fake-Date tests, `4c0ea15`). Observations to challenge are in "Decisions a QA reviewer should challenge" below; none is recorded as a finding.

## Deferred by plan

- **Live host verification** (smoke against OpenCode 2.0.22): the `session.created` payload carrying `agent`/`title` for subagent children, the `permitted` evaluation against the native `build` agent's real rules, and the `enforce` rewrite with a real permission set → Phase 3.2 (`test\smoke\routing-engine.smoke.test.ts`) and checkpoint DF2/DF3. Nothing in this phase ran against a real host.
- **`/annotate-plan` emission, A26 (pin every final `[tier:heavy]`), advisor findings, `/router stats`** → Phase 2.4 (owns `src\index.ts` commands).
- **Ladder-attempt decision rows (`step: variant|retry|escalate`), `closeAttempt`, runner charges (A17 `costRatio` per rung, `startCostRatio`), resume (D11)** → Phase 2.3.
- **Live `host` classifier check** (A4, A13) → DF3. **Docs (D14 privacy, the trusted-class footnote, the decision-log fields incl. `trace`)** → Phase 3.1.
- **The v1 text-only `routing.roles` line (D1; handoffs 1.1 and 1.4)** is **not wired**: the only v1 place is `src\index.ts`'s system transform (`assembleSystemPrompt`), and this dispatch forbids v1 code path changes. `generateTaxonomy` already implements it (`host: "v1"`, tested in 1.4). It needs a decision from the orchestrator (see Handoffs).

## Handoffs

### Handoffs to 2.2 and how each was addressed

| From | Item | Addressed |
|---|---|---|
| `phase-0P.md` | permission filter before any `enforce` swap; `needs` from evaluated permissions, never agent ids (A11) | `host-info.ts`: `grants` from each agent's own evaluated rules (unconditional allows), `permitted` from `[parent rules, session rules]` (explicit `allow`); the kernel's `needs` filter does the rest. Tests: explore's read-only rules exclude it for `needs=shell`; `permitted: false` makes a router tier or role agent ineligible |
| `phase-0P.md` | S1: reassigning `event.input` works | `enforce` writes `agent`/`subagent_type`/`model` into the returned input; unrelated fields survive (test) |
| `phase-1.1.md` | call `resolveRouting(cfg, host, logger)` with the plugin logger | `runtime.ts` `routingOf` passes the plugin logger (memoized per config object) |
| `phase-1.1.md` | `roles` may hold reserved/unknown/primary/hidden agents; filter against the host's agent info | `buildLadder` with `HostAgentInfo` for every host agent (mode, hidden, permitted, grants) |
| `phase-1.1.md` | v1 text-only `R:` line for an explicit `routing.roles` (D1) | **Not addressed** (conflicts with "no v1 code path changes"); logged under Deferred and in the decisions list |
| `phase-1.1.md` | `/router` marker and notices (to 2.2 / 2.4) | Notices still reach the user through the existing `warnConfigIssues`; `/router` output is 2.4 |
| `phase-1.2.md` | build the classifier backend once per config load | `classifyDeps`: one backend per distinct resolved classifier settings (preset overrides applied with `resolveClassifierForPreset`), `ctx.generate` passed for `host` |
| `phase-1.2.md` | `classify` once per `subagent` call with `cwd` = the dispatch location's directory | the dispatching session's `location.directory` (fallback: the plugin's directory) |
| `phase-1.2.md` | route-line protocol A22: first non-empty line, protocol text says "first line", default `routeLinePositions`, use `result.stripped` | paragraph says "FIRST line"; default positions; `result.stripped` becomes the prompt; the pin is the first line's (tests) |
| `phase-1.2.md` | record `result.trace` in the decision row; a conflict is a prompt-quality signal | optional `DecisionRow.trace` (route lines, backend status/label/rejected/disagrees, skipped) |
| `phase-1.2.md` / `phase-1.3.md` | never record under a class below `minClassConfidence`, never under the backend label (QA-1.2-27, A19) | the registry carries `facts.class` (the rules' class unless the backend agreed) and `facts.confidence`; 2.1's ingest enforces the threshold; the decision row is still written |
| `phase-1.2.md` | wiring, A22 protocol text and decision-log fields in 2.2 | done (this phase) |
| `phase-1.3.md` | `DecisionRow` with a unique `decisionID`; `childSessionID` null for fresh dispatches; `mode` never `static`; `chosen` = the pick, `best` = the argmin; enqueue through the flusher only | `decisionID = ${sessionID}:${ms}:${seq}`; null/known child id; rows only for `shadow|advise|enforce`; `flusher.enqueue` (no await, no I/O) |
| `phase-1.3.md` | static never calls `acquireOutcomes` | `prepare()` returns before acquiring; test: empty outcomes dir, no default dir |
| `phase-1.3.md` | do not list the decisions directory from a hook | no `readRows`/`persister` use anywhere in the wire modules |
| `phase-1.4.md` | per call: `classify` → `resolveChosen` → `buildLadder` → `decide`; row fields straight from the `Decision` | as designed; `reasonCode` is the prefix of `reason` |
| `phase-1.4.md` | `enforce` writes `target` only when `switched` | yes, and never when pinned |
| `phase-1.4.md` | `HostAgentInfo` for router tier agents too; `grantsFromTools` only for unconditional allows | agent view over the whole `ctx.agent.list()`; `allowedUnconditionally` |
| `phase-1.4.md` | pass `session` (runner's policy input), `parentModel`, `pricing`, `logger` | `prepared.session` (`variantSteps` per A15, `maxContextFraction`, catalog, `warn`); `parentModel` = the dispatching session's model; `pricing` from the catalog cache; plugin logger |
| `phase-1.4.md` | apply `floorTier` to the dispatch itself | `enforce` lifts a below-floor router pick to the floor tier's base rung (row: `switched: true`, reason names it); shadow/advise only price it (kernel note) |
| `phase-1.4.md` | swap the `R:` line with a function replacer; insert it when the base is empty; only `advise`/`enforce` | `swapTaxonomyLine` (splice); `generateTaxonomy` returns the shipped line for static/shadow |
| `phase-1.4.md` | keep the D2 invariant | `static`/`shadow`: no change; `advise` without data: the shipped line (test) |
| `phase-1.4.md` | A24 evidence gate, A16 strict margin, A25 router-block simulation | all in the kernel; `session` makes the simulation the runner's own (A17/A17a effects come from `nextAction`, not re-implemented) |
| `phase-1.5.md` | budget reserve and `triedByModel` (A17/A17a); the policy the runner uses | the kernel prices with `buildEscalatePolicy(cfg, session)` where `session` is built as 1.5's handoff to 2.3 specifies; nothing was copied |
| `phase-2.1.md` | register once per execution of a child, resumes included; a fresh child's id is unknown in `execute.before` | resume at once; fresh via `session.created` claim; each registration is a new attempt (test: second execution, new `attemptId` and `decisionID`) |
| `phase-2.1.md` | resolved `provider/model` for host agents; a `null` model records nothing | `HostAgentInfo.model` from `ctx.agent.list()`, else the dispatching session's model; an unresolvable pick is a kept row and is not registered |
| `phase-2.1.md` | pass `decisionID`, `facts` from `classify()`, `parentSessionID`, `acceptance` as `deterministic|grader|none` | yes (`DispatchInput`), `tier` and `step: "dispatch"` too |
| `phase-2.1.md` | decision rows are 2.2's, through the same `acquireOutcomes` bundle | `prepared.enqueue` = the bundle's flusher (same process bundle as the ingest, A3) |
| `phase-2.1.md` | to the orchestrator (DF2): nothing is recorded until 2.2 registers children | now it is: with `shadow` live, `outcomes.json` and `decisions.jsonl` appear in the D15 directory |

### New handoffs from this phase

- **To the orchestrator (DF2).** Before raising to `shadow`, run `routing:stats` and look at the `reason` of the first rows: expect `kept:evidence` for classes that have a role agent (item 7 below) and check `ineligible`/`agent-unavailable` behaviour on the live host (item 5). The statistics fix (`8930e03`) is needed for the shadow period's per-key dispatch counts.
- **To the orchestrator, v1 text-only roles line (D1).** Decide whether 2.4 (owner of `src\index.ts`) wires `generateTaxonomy({ host: "v1", … })` into the v1 system transform, or whether D1's opt-in stays documentation-only. 2.2 could not do it without a v1 path change.
- **To 2.3.** The kernel prices the router block with the same `LadderSessionPolicyInput` the runner will use; keep `buildEscalatePolicy(cfg, { host: "v2", variantSteps: resolveVariantSteps(cfg, "v2"), maxContextFraction, catalog, warn })` identical in `index.ts`. The runner's producer sessions are created without going through `execute.before`, so they are not registered by 2.2: register them as 2.1's handoff says.
- **To 2.4.** `DecisionRow.trace` exists; `/router stats` and the advisor can show backend failures (`status`, `rejected`, `disagrees`). The advisor should report `ineligible` reasons that are always `agent-unavailable` for router tiers (the parent has no explicit `subagent` allow for them), because the engine is then inert.
- **To 3.1.** Document: the route-line paragraph and the `Route hint`; `trace`; that `switched` in a shadow/advise row means would-switch; the trusted-class footnote (2.1); the one-line cost of a non-static dispatch (one `ctx.session.get`, a cached agent list and catalog, ≈0.5 ms of routing on top of `loadConfig`).
- **To 3.2.** Smoke scenarios: a `subagent` call in `enforce` with a real permission set (the rewrite and the re-check); a fresh child registered by `session.created` (payload fields); `shadow` writing `decisions.jsonl` through a real session.

## Decisions a QA reviewer should challenge

1. **`switched` in a shadow/advise row is the kernel's would-switch.** The row doc says "`enforce` replaced chosen with best". I kept the DF3 "would-switch count" working by logging the kernel's flag in every mode and made `stats.ts` mode-aware. Alternative: `switched = applied` and derive would-switch from `best.key !== chosen.key`.
2. **`[route …]` is stripped in every non-static mode**, including `shadow` ("input untouched" holds for prompts without a route line). In `static` it passes through, as today.
3. **Only root sessions are routed.** A dispatch from a session with a `parentID` is neither parsed, stripped nor logged. This closes route-line smuggling by a delegate, and also means a legitimate nested dispatch gets no row.
4. **Fresh-child registration relies on `session.created`** carrying `parentID` and, ideally, `agent` and `title` (the schema marks the last two optional; not verified on a live host). Matching is parent, then agent, then title, then FIFO. Parallel dispatches of the same agent with the same or no title can swap their facts. A dispatch whose call ends unclaimed is dropped; one that is never claimed lives 120 s; at most 200 wait.
5. **`permitted` needs an explicit `allow`** for `subagent:<agent>` in the parent agent's rules followed by the session's (last match wins, `ask` = no). If the native `build` agent's rules only `ask`, the engine never switches on a real host and every row says `kept`. The rule semantics (last match wins, `*` globs, a missing `resource` = `*`) come from the 0.P spike notes, not from host source.
6. **`grants` count unconditional allows only** (a resource-limited `shell` rule grants nothing), so an agent with `bash: ask` never covers `shell`/`network`. Conservative by design; it can leave router tiers ineligible for tasks with needs.
7. **The kernel picks one argmin and applies the evidence gate to it.** With the D12 default roles and an empty store, `general` on `sonnet#medium` (priced 11.9 vs medium 37.1 in my probe) is the argmin for `implement` and is refused by the gate (`kept:evidence`), so the engine does not fall back to the next-best legal move (heavy at 21.0). A role agent gets its ≥ 5 outcomes only if the orchestrator picks it. This is Phase 1.4's behaviour, surfaced here; it may make `enforce` inert for classes with role agents. Tests use `roles: {}` for router-tier switches.
8. **`floorTier` is applied in the adapter (`enforce` only)**, not in the kernel: a below-floor router pick is lifted to the floor tier's base rung when that agent is permitted, with `switched: true` on the row. Native `subagent` dispatches below the floor are lifted in `enforce` although today only `delegate` honours `floorTier`.
9. **The per-turn hint classifies the latest user message** with the rules classifier and treats the class's static tier as the pick. It is a separate system part, so the protocol text stays cacheable, but the hint changes with each user turn. A user message that is not a task ("thanks") classifies as `other`/low confidence and produces nothing.
10. **The generated `R:` line is memoized for 60 s per (config object, agent)** to keep the system prompt stable; evidence that arrives inside the window shows up at most a minute later.
11. **The protocol seam is a text splice**, not an optional parameter (see "Protocol seam"). `swapTaxonomyLine` leaves a text without the base line alone, so a user-edited protocol silently keeps its own line.
12. **One `loadConfig` per `subagent` call, always**, where the old code called it only when the call named no model (≈ +1.5 ms in a static session when it did). Static behaviour is otherwise identical; the cost is the config fingerprint check.
13. **First-dispatch waits:** up to 2 s for the model catalog (once; then never again for a catalog that hung), up to 500 ms for the on-disk store (once). After that the engine runs on whatever it has (unpriced → ratio units; empty store → priors).
14. **`DecisionRow.trace` is new schema** (optional, parser-tolerant) in 1.3's files; `stats.ts` is changed in a 1.3 file too. Both are small and tested.
15. **`ctx.agent.list()` is cached for 5 s** and the parent's own rules are read from it by id; an agent list that fails makes the call kept (rows are still written with `agents: null` semantics: router grants unknown).
16. **No dispatch is registered when the pick cannot be resolved to a model**; its row is a `kept` row with an `unknown/unknown` choice key.
17. **Hot reload to `static` releases the bundle at the next dispatch or context call**, not at the reload; nothing is flushed by the engine itself (the last release flushes).
18. **Nothing was run against a real OpenCode host**; every host-shaped input in the tests is a fake that follows the 0.P evidence and the schema types.

## Verdict

**Implementation complete and verified; adversarial QA pending — open findings: 0 recorded (none has been raised, because no QA round has run).**

Verification at `HEAD` (default pool, A14; no `--pool=threads`, no full suite):

- `npm run typecheck`: green.
- New/changed test files plus the neighbours that exercise the same hooks (`routing-dispatch` 36, `routing-wire.host-info` 13, `protocol` 65, `routing-outcomes.persist`/`.stats`, `v2-hooks`, `routing-ingest`, `routing-ingest.wiring`, `routing-engine.protocol-line`, `test/golden`): `Test Files 16 passed (16)`, `Tests 605 passed (605)`.
- `npx vitest related src/compat/v2-hooks.ts src/router/protocol.ts src/routing/outcomes/{persist,stats,types}.ts src/routing/wire/{dispatch,hint,host-info,runtime}.ts --run --maxWorkers=4`: `Test Files 78 passed | 3 skipped (81)`, `Tests 7829 passed | 55 skipped (7884)`, 119 s. (Without `--maxWorkers` the same selection timed out three unrelated timing-sensitive tests under load; see the self-checks.)
- `Test-Path C:\Users\Marquinho\.config\opencode\opencode-model-router.overrides.jsonc` → `False`; 0 `outcomes*`/`decisions*` in `C:\Users\Marquinho\AppData\Local\Temp\opencode-model-router-trajectory`.
- Branch `car/p22` pushed; `HEAD` equals `origin/car/p22`.