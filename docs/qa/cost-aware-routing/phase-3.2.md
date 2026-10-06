# Phase 3.2 — End-to-end proof on real OpenCode 2.0.22

> Plan: `D:\git\opencode-model-router\docs\plans\cost-aware-routing-engine-plan.md` §0.6.9, A7, A30 (and its amendment), §3 "Phase 3.2". Worktree `D:\git\omr-car-p32`, branch `car/p32`, base directory `D:\git\opencode-model-router`. Issue #74.
> Implemented by `@medium` in one dispatch chain. **Heavy QA round 1 passed with 10 minor and 2 info findings; all are fixed below ("Round 1 fixes"). QA round 2 has not run.**
> Files: `test\smoke\routing-engine.smoke.test.ts` (new), `test\smoke\helpers\routing-host.ts` (new, test-only helper), `package.json` (`smoke:routing`, `smoke:v1`), `docs\qa\cost-aware-routing\evidence-3.2\*` (new, 21 files), and the small product changes listed under Findings (`src\routing\wire\dispatch.ts`, `src\routing\outcomes\types.ts`, `src\routing\advisor\findings.ts`, comments in `src\compat\v2-client.ts` and `src\escalate\resume.ts`) with their tests.

## Pre-flight

| Item | Result |
|---|---|
| Worktree and branch | `D:\git\omr-car-p32`, branch `car/p32` from `car/main` @ **`71815eb`** (`docs(routing): DF3 shadow-period stats`); `git status --short` empty before the first edit; `node_modules` present; `npm run typecheck` clean before the first edit and before every commit |
| **Linear** | **Linear: not used** |
| **Live engine** | **`advise`** (DF3). Seen from the live decision log: every row appended to the live `decisions.jsonl` while this phase ran has `mode: advise` (48 rows between the two phase-window snapshots, see "Live-store check") |
| Hosts | OpenCode **v2.0.22** at `C:\Users\Marquinho\scoop\apps\opencode2\current\opencode.exe` (`OPENCODE_V2_BIN`; the `opencode` shim on PATH is the same binary). OpenCode **v1.18.34** at `C:\Users\Marquinho\scoop\apps\opencode\current\opencode.exe`, used only for scenario 6 (`smoke:v1`) by putting its directory first on PATH for that one command |
| Existing harness found and reused | `test\smoke\routing-spikes.smoke.test.ts` (Phase 0.P: `ScriptedHost`, `SpikeProvider`, probe plugin, `taskkill /T /F` teardown, allow-listed environment) and `test\smoke\depth-effort.smoke.test.ts` + `helpers\scripted-provider.ts` (router loaded through `plugins: [ROOT]`, grader / `delegate` fixture). The spike file is frozen evidence and is not edited; its host, provider and probe were adapted into the new helper |
| Isolation | Every scenario starts **its own** `opencode serve`: environment allow-list (`PATH`, `SYSTEMROOT`, `COMSPEC`, `PATHEXT`, `WINDIR` only; no credential-shaped variable, asserted), private `HOME`/`USERPROFILE`/`XDG_*`/`APPDATA`/`LOCALAPPDATA`/`TEMP`/`TMP`, random Fetch-safe port, router overrides written under the private `HOME`, `routing.outcomes.path` forced to a per-host temp directory, scripted keyless provider on `127.0.0.1`. Teardown kills the process tree and asserts the port closed and the temp root removed. The `/router` build marker in the isolated host reads `build=2.2.0+<this branch's HEAD>`: the plugin under test is this checkout |
| Never touched | `C:\Users\Marquinho\.config\opencode\*` (read-only snapshot in scenario 8), the live store `C:\Users\Marquinho\AppData\Local\Temp\opencode-model-router-trajectory` (read-only snapshots), the user's running service, the base checkout, other worktrees |
| Read-only budget | `CAP:none` with a `reason:` line |
| Pools / suites | Default vitest pool only; no `--pool=threads`; no full unit suite. Scoped unit runs are listed in the Verdict |

## Implementation notes

### Commits (`git log --oneline 71815eb..HEAD`, all `Refs #74`, no AI attribution)

```
4cab4fd test(routing): address QA-3.2-1 QA-3.2-3 QA-3.2-9 QA-3.2-10 with the phase-window snapshot, the private-TEMP v1 run and regenerated evidence
0953b18 test(routing): address QA-3.2-2 4 5 6 7 8 9 10 11 in the smoke harness and scenarios
96620bb fix(routing): correct the comments on hooks for the runner, hook delivery per instance and the fresh-start guards
386302d fix(routing): address QA-3.2 O-32-5 add the effort-variant-mismatch finding to the cost doctor
af5cf7c fix(routing): address QA-3.2-12 stop doubling the reason prefix and give a pinned resume its own
b694240 docs(routing): phase 3.2 QA report
e446bc7 test(routing): regenerate the 3.2 smoke evidence from the final run
45e5199 test(routing): check resume registration after a rejected resume and enforce under the native permission rules
62c442e fix(routing): pin the pinned-resume row text with a test
17a2553 test(routing): regenerate the 3.2 smoke evidence from the final run
bdf9aae test(routing): give the contract scenarios their own timeouts and drop leftovers
6c9b9c3 test(routing): keep file names of the user's config out of the live-store evidence
8aef243 test(routing): check the live store and live config stay untouched in the 3.2 smoke
87c5299 test(routing): add the advisor notice and annotate-plan handoffs of the 3.2 smoke
2c4b375 test(routing): add the effort handoffs (R1, QA-1.5-22, F9) of the 3.2 smoke
6004e16 test(routing): add the resume rules scenario of the 3.2 smoke
862ffcc fix(routing): say in the row that a pinned resume is not rewritten
3be0ddd test(routing): add the OpenAI Responses effort scenario of the 3.2 smoke
7324ca3 test(routing): record the v1-untouched scenario of the 3.2 smoke
474d6c1 test(routing): add the advisor scenario of the 3.2 smoke
b8aec76 test(routing): add the ladder scenario and the resume handoffs of the 3.2 smoke
af41c84 test(routing): add the advise scenario of the 3.2 smoke
2892951 test(routing): add the enforce scenario and the event/hook handoffs of the 3.2 smoke
4381332 test(routing): add the real-host harness and the shadow scenario of the 3.2 smoke
```

(The round 1 report update, `docs(routing): phase 3.2 QA round 1 fixes`, follows `4cab4fd`.)

### What was built

- `test\smoke\helpers\routing-host.ts` — `RoutingHost` (isolated host + router + probe), `RoutingProvider` (scripted Anthropic Messages **and OpenAI Responses**; `SPIKE_CALL={…}` makes the root emit one `subagent` call, `SPIKE_DELEGATE={…}` one `delegate` call; the router's grader prompt gets a verdict from a queue; reported input tokens = request body length / 4), the probe plugin (every tool hook with its plugin-instance id, every `session.*` event with id and delivery time, `ctx.agent.list()` / `ctx.model.list()` dumped once, `http.request` headers tagging each provider request with session/agent/kind/model), `seedOutcomes` (seeds the store through the repo's own `acquireOutcomes`, store and persister, on the temp directory), `watchSessions` (polls the host's sessions while a delegation runs, because the runner deletes its children when the delegation ends), `seenSessionIDs` (every `session.created` id of every host, taken from its own event log) and the evidence writer (evidence is written **before** the assertion, redacted on the serialized text).
- `test\smoke\routing-engine.smoke.test.ts` — 12 `it` blocks, gated by `RUN_OC_SMOKE_ROUTING=1` (`npm run smoke:routing`; `OPENCODE_V2_BIN` must be set). Without the variable every test is skipped, and the normal `vitest run` excludes `test/smoke/**`. Scenarios run serially, each against a fresh host. Final tree: **12 passed in 306 s**.
- Every scenario asserts **host state**: the session records the host holds (agent, model/variant, parent, tokens, children, `session.context`), the requests the provider received (wire model and effort, the orchestrator's system prompt), the host's event stream and tool-hook deliveries, and the files the plugin inside the host wrote (`decisions.jsonl`, `outcomes.json`, `advisor-notice.*.json`). The plugin's own variables or logs are never the evidence. Every scenario also asserts no `level=ERROR` line in the host log and no `[router]` warning.
- The persister flushes the first write at once and then at most every 30 s (D15), so reads of the store poll for up to 60-90 s.

### Amended during implementation (deviations from the plan text)

1. **Scenario 5 (advisor) — divergence from plan §3 Phase 3.2: "title/summary" is "title only" (A31).** The plan says "`/router` output contains the title/summary finding on a config without them". After QA-2.4-1 the summary finding was dropped (no consumer of a `summary` model exists in the host) and `title-model-unset` fires only when **all** of these hold: `agents.title.model` is unset; the host's own pick (`Model.small` for the session's provider: `gpt-luna`, `gemini-flash-lite`, `gemini-flash`, `claude-haiku` of that provider) finds nothing; the session's model is known (a root prompt ran before `/router`); and, when that model is priced, a cheaper title-eligible model (enabled, `status active`, text in and out) exists in the catalog. The scenario asserts that current behaviour (finding for a session on a provider with no small model; none for the anthropic provider, which has `claude-haiku-4-5`, while the doctor itself runs; none when the title agent has a model). The plan text in this checkout stops at A30 (amended), so the A31 annotation is **not in the plan file here**; this report is the record for the orchestrator to fold into A31 and for `docs\ROUTING_ENGINE.md` (3.1) to describe.
2. **Scenario 6 (v1 untouched).** The plan says `smoke:v1`; the script did not exist, the existing v1 suite is `npm run smoke:keyless`. Round 1 added `"smoke:v1": "npm run smoke:keyless"` (QA-3.2-11). The suite was run unchanged against v1.18.34. A second check in the new test asserts that no existing file under `test/smoke` changed since `71815eb` and that `package.json` gained exactly two lines, `smoke:routing` and the `smoke:v1` alias.
3. **Helper file.** The plan's write set names the test file and `package.json`; the harness is a second new, test-only file so the shared `helpers\scripted-provider.ts` (used by the v1 suite) stays byte-identical. The Responses script (plan: "extend the scripted provider") lives in the new provider for the same reason.
4. **Evidence directory.** Per-scenario JSON evidence (`docs\qa\cost-aware-routing\evidence-3.2\*.json`, home path and user name redacted on the serialized text) is committed next to this report. Each file carries the run id, the harness blob shas and `uncommittedChanges` (now computed over `src`, `test/smoke` and `package.json`; `false` for the final run, harness HEAD `0953b18`).
5. **Seeds.** Scenarios 1-3 seed the store through the repo's own store/persister before the host starts (1 and 3: both `search` keys of `fast` and `heavy` at 20 pass / 0 fail; 2: `fast` 0/20 and host `explore` 20/0), not through a hand-written snapshot.
6. **Product changes** (listed under Findings): F-32-1, QA-3.2-12, the `effort-variant-mismatch` doctor finding, and comment corrections. Each is small and local and has a test.

## Scenario results

Final run: `npm run smoke:routing`, **12 passed, 306 s**, harness HEAD `0953b18` (evidence committed in `4cab4fd`). Session ids belong to the isolated hosts (gone now). Files are in `docs\qa\cost-aware-routing\evidence-3.2\`.

### 1 — shadow: PASS (`1-shadow.json`)
Root `ses_eec7607d2ffeB45VFndM2TtenF`, child `ses_eec76069affetLm35qzhBdN2z2`. The orchestrator asks for `heavy` on a `[route class=search risk=low scope=single]` task.
- **Host child**: `agent heavy`, `model anthropic/claude-opus-5-5#xhigh`, `parentID` = root, `tokens.input 7342`; its user message carries the task and no `[route class` line (stripped); provider wire `claude-opus-5-5`, effort `xhigh`.
- **`decisions.jsonl`** (one row): `kind decision, mode shadow, step dispatch, resume false, childSessionID null, switched true, pinned false, chosen search|router:heavy|anthropic/claude-opus-5-5#xhigh, best search|router:fast|anthropic/claude-sonnet-5-5#low, reason "switched: C(best)=1.1645 < (1 − 0.2)·C(chosen)=16.1525 ratio"` (QA-3.2-12: the code leads once), `costs {fast 1.16, medium 5.79, heavy 20.19, explore 1.82 (two models)}, facts {class search, risk low, scope single, confidence 0.9, source route-line}, trace.routeLines {count 1, edgeOnly true}`, decisionID `ses_eec7607d2ffeB45VFndM2TtenF:1791329171746:1`.
- **`outcomes.json`** entry of the heavy key: `beta {alpha 20, beta 0}, counts pass 20, cost.tokens {n 1, input 7342, output 5}, steps {mean 1, n 1}, finalMessageTokens {mean 5, n 1}, measuredUSD {mean 0.029468, n 1}`: the seed (20 passes) plus the step record the host's `session.step.ended` produced.
- Result: shadow logs "would switch" and changes nothing.

### 2 — advise: PASS (`2-advise.json`)
Seeded host root `ses_eec73fe29ffe2OpXHm4b7FY6ws`; control host (no seed) root `ses_eec740ad3ffeH8y4LAGC22X7Yc`; advise dispatch child `ses_eec73fc97ffeTVX3pO7GczYxDk`.
- The orchestrator's request as the host built it (agent `build`, `anthropic/claude-opus-4-7#default`): the `R:` line ends `| by class: search→@explore` and the system prompt contains `Route hint: for search work like this turn, prefer @explore (Fast agent specialized for exploring codebases. Use this wh…) over @fast.` / `Why: switched: C(best)=1.1645 < (1 − 0.2)·C(chosen)=3.5643 ratio`. The control host's `R:` line is the shipped one (no suffix, no `@explore`) and has no `Route hint: for …` line (the explanatory paragraph about hints is in both).
- Advise does not act: the orchestrator asks `fast`, the host's child is `fast` / `sonnet-5-5#low`; its row: `mode advise, switched true, chosen search|router:fast|…#low, best search|host:explore|anthropic/claude-opus-4-7#default`, decisionID `ses_eec73fe29ffe2OpXHm4b7FY6ws:1791329305393:1`.

### 3 — enforce: PASS (`3-enforce.json`)
Root `ses_eec758508ffef69ymrTyYlKV95`, child `ses_eec7583e4ffesp5DDVT0T21WUb`. The orchestrator asks `heavy` (search task, no acceptance block).
- **Host child**: `agent fast`, `model anthropic/claude-sonnet-5-5#low` (the only child of the root); the probe's `execute.before` input after the plugin: `agent fast, model "anthropic/claude-sonnet-5-5#low"`; provider wire `catalogModel anthropic/claude-sonnet-5-5#low`, `claude-sonnet-5-5`, `output_config.effort low`, `x-proof-agent fast`.
- Row: `mode enforce, switched true, chosen heavy, best fast`, decisionID `ses_eec758508ffef69ymrTyYlKV95:1791329205217:1`. Store: the step record lands under the **fast** key (`cost.tokens.n 1`, `input 7423`); the heavy key has no step sample (`n 0`): ingestion follows what really ran.

### 4 — ladder: PASS (`4-ladder.json`, with `H3`, `H4`)
Root `ses_eec73f0c1ffegcChGHhH8FyzBe`; `delegate(tier fast, VERIFY:required, acceptance block)`, scripted grader: fail once, then pass; engine `advise`; tiers carry `variant` only.
- **Single producer child** `ses_eec73efd1ffeijkBPCWdH2XMxf` (agent `fast`); two grader children `ses_eec73ef24ffeRdMiHe0EUN8afl`, `ses_eec73e879ffeDREX4bGV6wrF9F` (agent `model-router-grader`, `anthropic/claude-opus-5-5#default`). `session.created` events under the root: exactly one with agent `fast`, title `Router fast delegation`.
- **Host-stored model of the child, sampled while the delegation ran**: `sonnet-5-5#low` (session input tokens 7 359) → `sonnet-5-5#medium` (14 819 total). The child's provider requests: request 1 `#low`, effort low, 1 message, est. input 7 359; request 2 `#medium`, effort medium, **4 messages** (history kept), est. input 7 460, last user text `[router escalation] previous attempt did not pass verification: - scripted verification failure NEXT: retry with these failures addressed. …`.
- **Rows** (`decisions.jsonl`): `ladder-5f13f591-1 step dispatch resume false "ladder dispatch on fast; fresh child"`; `ladder-5f13f591-2 step variant resume true`, same `childSessionID`, `chosen …#medium`, `"ladder variant on fast; resumed child; D11 under-threshold (tokens=7416 budget=872000 threshold=523200); rung costRatio 1"`; verdict rows `fail` (key …`#low`, step dispatch) then `pass` (key …`#medium`, step variant). The orchestrator received `CHILD_DONE\n\n[router ✓ verified: checker]`.
- Note: the first attempt used a task the rules classifier cannot class (`VERIFY:required\nCHILD_DONE`, class `other`, confidence below `minClassConfidence`): it wrote decision rows but **no step or verdict records** (by design, D2 / QA-1.2-27). The scenario therefore opens the task with a `[route class=search …]` line.

### 5 — advisor: PASS (`5-advisor.json`, `5b-advisor-title-model-set.json`)
Roots `ses_eec72f874ffePwl236cfcAtAJA` (anthropic) and `ses_eec72f6aaffedVzm3fuhWjVETC` (custom provider `smallless`, no small model); each ran one root prompt before `/router`.
- `/router` from the anthropic session: `Cost doctor: 2 findings (0 warning, 0 saving, 2 info)` (`variant-ladder-budget`, `covered-tier`): the doctor ran (asserted, QA-3.2-7) and there is **no** title finding. From the `smallless/big-1` session: `Cost doctor: 3 findings (0 warning, 1 saving, 2 info)` with `[saving] title-model-unset (title): agents.title.model is unset and the host finds no small model of smallless in your catalog (it looks for gpt-luna, gemini-flash-lite, gemini-flash, claude-haiku of the session's provider) … The cheapest priced model the host accepts for it in your catalog is anthropic/claude-haiku-4-5 ($1/$5 per Mtok in/out)` and the fix `{"agents":{"title":{"model":"anthropic/claude-haiku-4-5"}}}`.
- 5b: with `agents.title.model` set in the host config the real `title` agent record carries `{providerID anthropic, id claude-haiku-4-5}` and `/router` from a `smallless` session has **no** title finding.
- Fixture note (not a product bug): the first attempt used package `@opencode/ai/providers/anthropic-compatible` for the custom provider; the standalone host cannot load it (`Cannot find package '@opencode/ai'`: only packages a built-in provider uses are bundled), the session failed to drain and the finding never fired. The fixture uses the bundled `@opencode/ai/providers/anthropic` under a custom provider id, and the scenario asserts no `level=ERROR` in the host log. Divergence from the plan text: see "Amended during implementation", item 1.

### 6 — v1 untouched: PASS (`6-v1-untouched.json`, `6-smoke-keyless.log.txt`)
`npm run smoke:v1` (= `smoke:keyless`: registration, subagent-tiers, deferred-catalog, depth-effort, scripted-provider helper test) with OpenCode **1.18.34** first on PATH, test files unchanged, **on the final tree (HEAD `0953b18`) with `TEMP`/`TMP`/`TMPDIR` pointed at a private directory by a wrapper** (QA-3.2-3; the v1 smoke files were not edited): **5 files passed, 27 tests passed, 11 skipped (the v2 describes), 400 s**. The first run of this phase (18:30, unwrapped, HEAD `474d6c1`) gave the same counts (591 s). After the wrapped run the private temp directory holds **no `opencode-model-router-trajectory` directory**: the suite wrote no router scorecard or store file. In-suite check: only 2 paths changed under `test/smoke` since `71815eb`, both added (`routing-engine.smoke.test.ts`, `helpers/routing-host.ts`); the `package.json` diff is two added lines (`smoke:routing`, `smoke:v1`).

### 7 — OpenAI Responses effort delivery (A7, QA-0P-26): PASS (host emission only), not `unverifiable` (`7-openai-responses.json`)
This proves what the **host sends** to a scripted Responses provider. Whether api.openai.com honours the in-band item is not verified (A7's provider-acceptance caveat stays).

The new provider speaks the Responses protocol (SSE `response.created … output_item.added … output_text.delta … output_item.done … response.completed`; function-call items for tool calls) and the host accepted it for every request (no provider or host error). Catalog: `openai/gpt-6-luna`, `gpt-6-sol` with variants `none/low/medium/high/xhigh/max`. Effective effort = last in-band `configuration_update.reasoning.effort`, else top-level `reasoning.effort`:

| case | asked | stored by the host | top-level `reasoning.effort` | in-band | effective |
|---|---|---|---|---|---|
| A start | `gpt-6-luna#low` | `#low` | low | – | low |
| A resume | `gpt-6-luna#high` | `#high` | low (unchanged) | `high` | **high** |
| A resume | `gpt-6-luna#max` | `#max` | low | `high, max` | **max** |
| F start (default) | `gpt-6-luna` (bare) | `#default` | none: the request has **no `reasoning` field at all** (asserted) | – | – |
| F resume | `gpt-6-luna#high` | `#high` | none (`reasoning {summary: auto}` only, asserted) | `high` | **high** |
| M start | `gpt-6-luna#low` | `#low` | low | – | low |
| M resume (model **and** variant) | `gpt-6-sol#high` | `#high` | **high** | – | **high** |
| R1 start | `gpt-6-luna#high` | `#high` | high | – | high |
| R1 resume (bare model) | `gpt-6-luna` | **`#default`** | high | `medium` | **medium** (the model's default, not the old variant) |

The in-band item is `{"type":"configuration_update","reasoning":{"effort":"high"}}`.

### 8 — live store and live config untouched: PASS (`8-live-store-untouched.json`, `8b-live-store-phase-window.json`)
See "Live-store check".

### Handoff scenarios (all PASS in the final run)
`H1` events and hooks · `H2` tool hooks per plugin instance (and the store counted once) · `H3` resume growth vs task length · `H4` runner hooks and execution events · `H6` resume rules · `H7` / `H7b` effort probes (H7b is a **measurement**) · `H8a` advisor notice · `H8b` `/annotate-plan` · `H9` native permission rules. Details in the table under "Handoffs".

## Findings

No `blocking`, `critical` or `major` finding. Product items found by this phase are fixed or recorded; observations are routed to the owners named.

| Id | Severity | Where | Description | Resolution |
|---|---|---|---|---|
| F-32-1 | minor | `src\routing\wire\dispatch.ts` (row `reason` of a resume that repeats the original pick of a router-moved child) | A **pinned** resume (`[route … pin]` on its first line) of a child the router had lifted to `medium` was sent as named and the real host moved the child to `fast`/`sonnet-5-5#low` (H6 step 5c), but its decision row said `kept:resume:running: … sent to @medium so the host does not switch it back`: it claimed a rewrite that did not happen | `862ffcc` (text now says `pinned, so it is sent as named and NOT rewritten`) and `62c442e` (test; fails against `71815eb`). Superseded in form by QA-3.2-12: the row now has its own prefix `kept:resume:pinned` (`af5cf7c`) |
| F-32-12 / QA-3.2-12 | minor (product) | `src\routing\wire\dispatch.ts` (row `reason`) | A row led with the reason **code** and then the kernel's own leading word: `switched: switched: C(best)=…`, `kept:best-is-chosen: kept: …`, `kept:pinned: kept: …` | `af5cf7c`: `reasonText()` drops the kernel's leading `kept: ` / `switched: ` once; `routing:stats` reads `kept:evidence` and `lift:floor` by **prefix** and resumes by the `resume` flag (checked), so nothing there changes. A pinned resume of a moved child is `kept:resume:pinned` (new constant `RESUME_PINNED_REASON`, still a `kept:resume` row, outside every routing metric; no consumer depends on the exact `kept:resume:running` string). Tests: `routing-dispatch` (shadow, kept, pinned, pinned resume) and `routing-outcomes.stats` (a `kept:resume:pinned` row counts as a resume) |
| O-32-2 | info → comments fixed | `src\routing\wire\dispatch.ts` header item 6; `src\compat\v2-client.ts:145` | On 2.0.22 the plugin's `execute.before`/`execute.after` hooks **do not fire** for the `subagent` calls the delegate runner makes through `ctx.tool.list()` (H4: during a whole delegation only `before:delegate` / `after:delegate` are hooked, 0 `subagent` hooks). The comments said "the same hooks fire for them" | `96620bb`: the comments now say the hooks do not fire on 2.0.22 and that the runner mark and the "runner description" rule are defensive (the mark is withdrawn unconsumed, `v2-client.ts:214`) |
| O-32-3 | info → comments fixed | `src\routing\wire\dispatch.ts` (A3 comments, `ownsSession`) | The host hands a **session event** to every plugin instance (H2: one `session.step.ended` id logged by 2 instances) but the **tool hooks** of a call only to the instance of the session's location (1 of 2 for `execute.before` and for `execute.after`; a session in the other location reached the other instance). The router acted once per dispatch in both cases (rows 1 → 3 for two dispatches), and the store counted each attempt once (H2: 3 attempts, input 22 276 = the hosts' 22 276; heavy key 0). Answers the 2.2 R2-2 question | `96620bb`: the owner rules and the handled-call set are described as defensive for hooks; the protection against a duplicated event is the event-id LRU (`firstDelivery` in the ingest, the registry's end-id set) |
| O-32-4 | info → decision taken | `src\escalate\resume.ts` (`bare-model-after-variant`, `effort-path`) | The host does **not** keep the old variant on a bare-model resume: it stores `#default` and sends the model's default effort (Anthropic sonnet-5-5 after `#low`: in-band `high`; opus-5-5: no effort; OpenAI luna after `#high`: in-band `medium`). After an agent switch the request carries the target agent's effort once | **Both fresh-start guards stay.** `96620bb` updates the comments: the host side was measured in 3.2; provider acceptance of in-band effort is unverified; re-decide after a real-provider check |
| O-32-5 | warning-worthy config shape → finding added | `src\routing\advisor\findings.ts` | H7b (a **measurement**): with `medium = {variant: medium, effort: xhigh}` a child resumed from `fast` onto `medium` is **stored** `#medium` but the request carries top-level `xhigh` (the agent's effort option wins), identical to a fresh `medium` child; the outcome keys, rows and `routing:stats` name `#medium`. "Effective effort equals the stored variant" holds only when `effort` and `variant` agree (the shipped anthropic preset; no shipped preset has a mismatch) | `386302d`: new doctor finding `effort-variant-mismatch` (warning, config-shape: listed for an unmodified bundled tier, never announced; only while `routing.engine` is not `static`; snippet `variant: <effort>` when the catalog offers it). `variant-effort` is a different finding (no variant steps) and is unchanged. Tests: 4 in `routing-advisor` |
| O-32-6 | info → plan A7 text | plan A7 / `docs\ROUTING_ENGINE.md` | A7's caveat "the OpenAI Responses route was not exercised" is stale: it is exercised with a scripted provider (scenario 7, host emission only). Same-model change: in-band `configuration_update`, top-level unchanged; model + variant together: top-level; bare model after a variant: `default`. Provider acceptance stays unverified | 3.1 updates the caveat and keeps "not verified against api.openai.com" |
| O-32-7 | info → handoff to **3.3** | `test\smoke\registration.smoke.test.ts`, `subagent-tiers.smoke.test.ts`, `deferred-catalog.smoke.test.ts` (pre-existing v1 harness) | These three v1 smoke files redirect `HOME`, `USERPROFILE`, `XDG_*`, `APPDATA`, `LOCALAPPDATA` but **not `TEMP`/`TMP`/`TMPDIR`** (`depth-effort.smoke.test.ts` does), so a router plugin inside their v1 host would use the real `os.tmpdir()` default store `<tmpdir>/opencode-model-router-trajectory`. With a private `TEMP` (QA-3.2-3) the suite created no such directory, so no write was observed; the gap is structural, not shown to have leaked | not edited here (the v1 suite stays unchanged by this phase); global QA 3.3 should decide whether the v1 harness gets the same TEMP redirect |

Harness-only notes (no product impact): a custom provider with package `anthropic-compatible` does not load in the standalone host; the 30 s flush throttle means disk assertions poll; the runner deletes its children when a delegation ends, so the ladder's child state is sampled while it runs.

### Round 1 fixes (heavy QA round 1: 10 minor + 2 info; the QA report text itself was not given to me, so each item is as numbered in the dispatch)

| Id | Fix | Commit |
|---|---|---|
| QA-3.2-1 | `evidence-3.2/8b-live-store-phase-window.json` (redacted: names, sizes, digests of the 17:59 and 19:26 snapshots, the 37 added and 4 changed files, the 2 notice files' projects, and each of the **48** rows the live decisions log gained between them: sessionID, mode, kind, step, keys). The 17:59 snapshot **is still on disk** (the hand-taken `live-store-before.json`, 13 947 files, digest `3d4ba65e860c90db`). "Live-store check" now says the attribution rests on **construction** (private TEMP, forced outcomes path) **plus row content** (live preset `gpt-6-luna-fast`, `minClassConfidence 0.7`); the snapshots hold names and sizes only and cannot by themselves name a writer. The earlier "49 rows" counted to the end of the file at that time; 48 lie inside the snapshot window | `4cab4fd` + this report |
| QA-3.2-2 | `seenSessionIDs` now takes every `session.created` id (session and parent) from each host's own event log, plus the sessions it holds at stop; scenario 8 asserts that no `ses_<id>.scorecard.log` the live store gained or grew names one (final run: 2 added, 0 naming a session of the run, 50 sessions of the run seen) | `0953b18` |
| QA-3.2-3 | `smoke:keyless` is listed as a **possible writer** in the attribution (3 of its 5 files do not redirect TEMP; 5 new live scorecards fall inside its unwrapped 18:30-18:40 window, a rate equal to the live host's outside it, so the window cannot be told apart from the live host). It was re-run on the final tree with TEMP/TMP/TMPDIR pointed at a private directory by a wrapper, **without editing the v1 files**: 5 files, 27 passed, 11 skipped, 400 s, no router store created in the private temp. The pre-existing TEMP gap is O-32-7, a handoff to 3.3 | `4cab4fd` (log `6-smoke-keyless.log.txt`) + this report |
| QA-3.2-4 | The 1 s bounded wait stays. The claim is reworded to "event ids verified; delivery observed ~48 ms before the probe's after-hook, one sample" (this run: −40 ms for `succeeded`); the `+1000 ms` slack is gone: the assertion is now `delivered <= the probe's after-hook` with a comment saying it is one observation per run, not a bound the plugin relies on | `0953b18` |
| QA-3.2-5 | Reworded to "on a same-model switch the top level keeps the previous agent's effort; the target's effort travels in-band". H7 now asserts the in-band lists (`""`, `medium`, `""`, `""`) and the top-level efforts (`low, low, xhigh, low`) of the four requests | `0953b18` |
| QA-3.2-6 | Scenario 7 is "PASS (host emission only)" (title, expectation, verdict text); the A7 provider-acceptance caveat is kept. The F start request has **no `reasoning` field** (asserted); `{summary: auto}` belongs to the F resume (asserted) | `0953b18` + this report |
| QA-3.2-7 | Scenario 5 asserts `/Cost doctor/` for the haiku session, so "no title finding" cannot hold because the doctor did not run | `0953b18` |
| QA-3.2-8 | H7b is labelled a **measurement**; H7's in-band property is asserted (QA-3.2-5); H2 asserts per child that the fast key counted each of its three attempts once (`tokens.n 3`, `input × n` = the hosts' own child totals, 22 276 = 22 276, after waiting for a late duplicate) and the heavy key none | `0953b18` |
| QA-3.2-9 | Redaction runs on the **serialized** text and handles the plain, forward-slash, `\\`-escaped and `\\\\`-escaped forms of the home and 8.3 short home paths, the 8.3 short user name and the user name. `grep -i 'Marquinho\|MARQUI'` over every file of `evidence-3.2` finds nothing (including `1-shadow.json` and `6-smoke-keyless.log.txt`) | `0953b18` + `4cab4fd` |
| QA-3.2-10 | `uncommittedChanges` covers `src`, `test/smoke` and `package.json`; every evidence file of the final run says `uncommittedChanges: false` on `0953b18`. `smoke:v1` was re-run on the final tree (QA-3.2-3) | `0953b18` + `4cab4fd` |
| QA-3.2-11 | `"smoke:v1": "npm run smoke:keyless"` in `package.json`; scenario 6 asserts it | `0953b18` |
| QA-3.2-12 (product) | Reason prefix no longer doubled; pinned resume is `kept:resume:pinned`; tests (see Findings) | `af5cf7c` |
| (a) (b) comments | `dispatch.ts` header items 6 and 7 and `v2-client.ts` say what 2.0.22 does (no hooks for the runner's native calls; tool hooks only for the session location's instance); the runner mark and owner rules are defensive; the event-id LRU protects the store | `96620bb` |
| (c) guards | Both fresh-start guards kept; `resume.ts` comments say the host side was measured in 3.2 and provider acceptance of in-band effort is unverified, re-decide after a real-provider check | `96620bb` |
| (d) O-32-5 | `effort-variant-mismatch` doctor finding (the existing `variant-effort` did not cover it: it is about missing variant steps) + 4 tests | `386302d` |

## Deferred by plan

| Item | Where |
|---|---|
| The real-credential `host` classifier check (A4, `opencode-go/deepseek-v4.1-flash`, A13) | checkpoint DF3 |
| Docs: advisor findings and their ids (now including `effort-variant-mismatch`), `advisor-notice.<hash>.json` / `.lock`, `/router stats`, `/annotate-plan` message part, the `by class:` suffix and the hint, A30 (including `kept:resume:pinned`), effort delivery, the Responses finding (O-32-6), the title-finding rule as it is after QA-2.4-1 (A31) | 3.1 |
| Verdicts of **deferred** verification (`finishDeferred`) and `router_verify` replays are not recorded (2.1/2.3/2.4 deferral). Decision for 3.2: **not wired here** (a verdict-recording change is outside a test phase and was not exercised on the host); **3.1 documents that deferred work is invisible to the verdict rates** | 3.1 |
| Whether the v1 smoke harness should redirect TEMP/TMP (O-32-7) | 3.3 |
| Measuring the orchestrator's cache-read share with the hint on (2.2 handoff, QA-2.2-10) | DF3 |

## Handoffs

### Every "to 3.2" item and its disposition

Disposition: **verified** (observed on the real host as expected), **refuted** (observed to be otherwise), **measured** (a question, now answered), **unverifiable / not exercised** (with the reason).

| # | Handoff (source) | Disposition and result on the real host | Evidence |
|---|---|---|---|
| 1 | `session.execution.*` events carry an `id` and are delivered for children before the tool returns (2.3 QA-2.3-10 (1)) | **Verified (event ids) / observed (timing).** `session.execution.started` and `session.execution.succeeded` for the child, both with `evt_…` ids (this run `evt_1138a7c2f001em22I4ydyYut3s`, `evt_1138a7c6f001axhuBtPCCHdRK6`). Delivery was **observed ~48 ms before the probe's `execute.after` hook** of the same call (H1: one sample per run, −40 ms in the final run, asserted without slack) and, in a ladder, before the resume started (H4, one sample). It is not a bound the plugin relies on: the bounded 1 s wait of QA-2.3-2 stays (it costs nothing when the end is already there, and a missing end still ends in a fresh start) | H1, H4 |
| 2 | `execute.before` hooks fire for the runner's `native.execute` (2.2/2.3) | **Refuted** on 2.0.22: 0 `subagent` hooks during a delegation; only the model-emitted `delegate` call is hooked (O-32-2) | H4 |
| 3 | Tool hooks reach every plugin instance (2.2 R2-2) | **Refuted**: only the instance of the session's location; events reach all instances (O-32-3) | H2 |
| 4 | `session.created` payload carries parentID / agent / title (2.2) | **Verified.** `data` keys: `sessionID, projectID, location, subpath, parentID, slug, title, agent, model, permissions, version`; child: `parentID` = root, `agent fast`, `title Find usages`, `model sonnet-5-5#low`. The runner's children are titled `Router fast delegation` / `Router result verification` | H1, 4 |
| 5 | `switchAgent` on a resume with a different agent; A30 amended (2.4 R3-1) | **Verified.** Floor lift to `medium`; a resume naming the original pick `fast` is rewritten to `medium` (row `kept:resume:running`) and the child **stays** medium; a resume naming `heavy` on purpose is honoured and the host moves the child **and its model** to `heavy`/`opus-5-5#xhigh`; a resume naming `fast` after that is lifted to the floor (`lift:floor: resume lifted from @fast to @medium … (the child runs @heavy)`); a pinned resume naming `fast` is sent as named (row `kept:resume:pinned`) and the host moves the child to `fast`/`sonnet#low` (F-32-1) | H6 |
| 6 | A resume the host rejects after the hooks keeps the child's registration (2.2 R2-1) | **Verified.** Another root's resume of the child is rejected (`Tool.Error: Session … is not a child of the current session`) after the plugin's hooks ran; the next resume by the owner naming the pick is still rewritten to `medium` | H6 (5a, 5b) |
| 7 | A resume of a session that is not a child of the caller is rejected by the host, and the plugin's pre-check (`ctx.session.get` + `parentID`) agrees (2.3 (6)) | **Verified on the host side** (message above); the pre-check at `v2-client.ts:134` tests the same condition (`info.parentID !== parent`). The runner's own rejection path was not driven through the runner (unit-tested) | H6 |
| 8 | Permission re-check on an agent switch on resume ends as a failed attempt (A11, 2.3 (7)) | **Verified on the host side**: a resume naming an agent the session denies fails with `Tool.Error: Subagent denied: heavy` (`Permission.BlockedError`) and the child stays on `medium`. That the runner counts it as a failed attempt was **not exercised through the runner** (unit-tested; would need a deny rule plus a delegation) | H6 (6) |
| 9 | `ctx.agent.list()` includes the hidden `title` agent; `enabled`/`status`/`capabilities` fields (2.4) | **Verified.** Agents: `build, general, explore, plan, fast, medium, heavy, model-router-grader` and hidden `compaction`, `title`, `summary`. The `title` record has keys `id, name, request, mode, hidden, permissions` (**no `model` key** when unset: the advisor maps that to `null`) and `model {anthropic, claude-haiku-4-5}` when `agents.title.model` is set. Model records carry `enabled`, `status "active"`, `capabilities {tools, input[], output[]}`, `cost`, `variants`, `limit` and `family` (`claude-haiku` for haiku; **absent** for a custom-provider model) | 5, 5b |
| 10 | The title finding on a real host; not when set; none where a `claude-haiku` exists (2.4) | **Verified** (scenario 5 and 5b; the doctor runs in every case) | 5, 5b |
| 11 | A notice reaches a real orchestrator context as a synthetic entry, once (2.4 round 2 handoff) | **Verified.** Session context `user, assistant, idle, synthetic, user, assistant, idle, …`: one `synthetic` entry (index 3 of 13, description `Model router cost doctor`, text `Cost doctor notice for the user (say it once, in one short sentence, then carry on with the task): [model-router] Cost doctor: 1 finding worth a look (0 warning, 1 saving). First: agents.title.model is unset …`); it starts no turn (no assistant message follows it before the next user message) and is not repeated in turns 2-4; `advisor-notice.<hash>.json` (261 bytes) is in the outcomes directory. **Delivery after a restart: unverifiable here** — the file is keyed by the project-path hash and each isolated host has a fresh path | H8a |
| 12 | `/annotate-plan` with a live engine; a fenced `1.` line is not a step (2.4) | **Verified.** The command's prompt carries `## Router route lines (model-router, engine=advise)`, `3 steps found, 3 need an addition, 1 pinned`, with `[route class=recon risk=low scope=multi d=none]`, `[route class=implement risk=medium scope=multi needs=edit d=none]`, `[route class=design risk=high scope=multi d=none pin]`; the fenced `1. this is shell output, not a step` line got none; the plan file is not written by the hook. The real-credential `host` classifier through `/annotate-plan`: DF3 | H8b |
| 13 | `enforce` with a real permission set; `permitted` against the native rules (2.2) | **Verified.** A root with only `subagent * allow` (the native `build` rules decide the rest; the tier agents carry the host's default allow-with-asks rules): heavy → fast swap happens. With `subagent fast` denied for the session the engine does **not** swap (row `kept:best-is-chosen`, child stays `heavy`), no `Subagent denied` | H9 |
| 14 | `shadow` writing `decisions.jsonl` through a real session; a fresh child registered by `session.created` (2.2) | **Verified** (scenarios 1, 3, 4: step records land under the key of what ran) | 1, 3, 4 |
| 15 | Crossed parallel dispatches claimed by `session.created` payloads (2.2 R2-7) | **Not exercised**: it needs two tool calls in one model turn and the scripted provider emits one per turn. Unit-tested in 2.2 | – |
| 16 | R1: bare-model resume after a variant (2.3 (2), 1.5 R1) | **Measured**: stored `#default`, the model's default effort sent (Anthropic and OpenAI); both guards kept (O-32-4) | H7, 7 |
| 17 | QA-1.5-22: effort options of a resumed child after an agent switch (2.3 (3)) | **Measured / verified**: after `fast → medium → heavy → fast` on one child the request carries the target tier's effort exactly once and never the previous agent's. On a **same-model** switch (`fast → medium`) the top level keeps the previous agent's effort (`low`) and the target's travels in-band (`medium`, the only in-band entry); on the two model changes the top level carries it (`xhigh`, `low`) and nothing is in-band (asserted). With a differing `effort` the **option** wins over the stored variant (O-32-5, now a doctor finding; H7b is a measurement) | H7, H7b |
| 18 | F9: effective effort of `default → high` (1.5); A7 effective effort | **Measured.** Anthropic: a bare start sends no effort, resume `#high` → in-band `high`; same-model agent switch fast → medium: in-band, top-level unchanged. OpenAI: scenario 7 table (host emission only). If a provider's default were above `high` the step would be equal, not lower (the rule stays safe) | H7, 7 |
| 19 | A single child across a variant step with `tokens` growing (2.3 (5)) | **Verified** (scenario 4: one producer, `#low` → `#medium`, session input 7 359 → 14 819) | 4 |
| 20 | Token growth of a resumed attempt against the task length; does the producer start over? (2.3 (8), QA-2.3-R2-7) | **Measured** (scripted provider estimate, body length / 4, **not** a tokenizer): the second request grows by 101 with an empty task and by 1 101 with a 4 000-character task: **+1 000 = the task re-sent once** inside the forcing message. The router's D11 estimate of the next context was 9 416 against 9 460 on the wire (−0.5 %). **Whether a real producer repeats its earlier work and tool calls: unverifiable with a scripted model** (its replies are fixed) | H3 |
| 21 | Deferred verdicts: wire `ingest.onVerdict` or document the gap (2.4) | **Decision: document the gap in 3.1** (see "Deferred by plan") | – |
| 22 | Effective-effort assertions (A7) and scenario 7 (0.P, QA-0P-26) | **Verified, host emission only** (scenario 7 green, not `unverifiable`) | 7 |

### New handoffs from this phase

- **3.1 (docs):** O-32-2/3 (hooks do not fire for the runner; hook delivery per instance), O-32-5/6 (`effort` vs `variant` and the new `effort-variant-mismatch` finding, A7 caveat), the title-finding rule as it is after QA-2.4-1 (A31), the row text and the `kept:resume:pinned` prefix, the deferred-verdict gap.
- **3.3 (global QA):** O-32-7, the TEMP gap in three v1 smoke files; whether to re-decide the two fresh-start guards after a real-provider check.
- **DF4:** the smoke proves the `enforce` path (swap, resume rules, permission set) on a scripted provider; the live check stays the next non-pinned dispatch's row, as DF4 already says.

## Live-store check

Two read-only checks of `C:\Users\Marquinho\AppData\Local\Temp\opencode-model-router-trajectory` (files only; the directory has no subdirectories).

### Phase window (hand-taken; `evidence-3.2/8b-live-store-phase-window.json`)
Names and sizes **before** at 2026-10-06 17:59:03 -03:00 (before the first host started; the snapshot file is still on disk) and **after** at 19:26:42 -03:00 (after the 19:21 smoke run).

| | before | after | change |
|---|---|---|---|
| files | 13 947 | 13 984 | **+37**, 0 removed |
| bytes | 4 541 243 | 4 608 948 | +67 705 |
| new files | – | – | **35** `ses_*.scorecard.log` + **2** `advisor-notice.<hash>.json` (`ea3a792c6ed0` for `D:\git\opencode-model-router`, `ea0693112b7e` for `D:\git\agent-city-frontend`: their `project` fields name live projects, not a smoke path) |
| changed files | – | – | `decisions.jsonl` 137 193 → 197 986 bytes (**+48 rows**), `outcomes.json` 6 541 → 7 568 bytes, 2 existing `ses_*` scorecards |

The 17:59 snapshot holds names and sizes only: it cannot name a writer. **The attribution therefore rests on construction plus row content**:

- **Construction.** Every isolated smoke host ran with private `HOME`/`USERPROFILE`/`XDG_*`/`APPDATA`/`LOCALAPPDATA`/`TEMP`/`TMP` and an explicit `routing.outcomes.path` in its own temp directory; the vitest process loads no plugin and only reads the live store. So a smoke host cannot write there.
- **Row content.** The 48 new `decisions.jsonl` rows belong to **4 sessions of the user's live host** (`ses_eecd25670ffenVMhGqkOpaOOvT`, `ses_eed11db93ffeA4vnt4UjKyZKIY`, `ses_ef099b1e0ffe7BcoD9Trb0TpTm`, `ses_ef09ca71effe2FoiBgxxJuCg6W`), all `mode advise` (the live engine), on the live preset (`openai/gpt-6-luna-fast#medium`, `sonnet-5-5#xhigh`; classes `recon`, `review`, `design`, `implement`, `debug`; `minClassConfidence 0.7` in the reasons), which no smoke preset contains. None of those ids and none of the 35 new scorecard ids appears in any version of the committed evidence (64 smoke session ids over the git history). The two notice files name live projects.
- **Possible writers, stated honestly.** (1) The user's own running host: all rows and the scorecards (about one per one to two minutes all day). (2) `smoke:keyless` / `smoke:v1` (v1.18.34): run **unwrapped** at 18:30-18:40, and three of its five files do not redirect `TEMP` (O-32-7). Five of the new scorecards were created inside that window, which equals the live host's rate outside it, so the snapshot cannot tell them apart. The same suite re-run on the final tree with a private `TEMP` wrote **no** router store in it, so a write by the unwrapped run is not shown and not excluded.

### The suite's own check (scenario 8; `evidence-3.2/8-live-store-untouched.json`)
Taken inside the final run, between its first and last scenario: live store 14 003 → 14 005 files (+2 `ses_` scorecards, 0 non-`ses_` new), 3 rows appended to `decisions.jsonl`; **0 appended rows and 0 added-or-grown scorecards name a session of the run** (`seenSessionIDs`: 50 sessions of the run, taken from every host's own `session.created` events); the user's config files (`opencode.json`, `opencode-model-router.overrides.jsonc`, `opencode-model-router.state.json` and every other file of `~/.config/opencode`) are unchanged by size and mtime.

Conclusion: the growth of the live store comes from the live host — its `ses_` scorecards, its own `advise` rows and store snapshot, and two notice files for its own projects — and, for the 18:30-18:40 window only, possibly the unwrapped v1 suite. Strictly, the growth is not only `ses_` rows (it also includes the live engine's rows/snapshot and the two notice files), but nothing in it is attributable to the isolated smoke hosts.

## Verdict

**PASS (implementer's view) after QA round 1: scenarios 1-7 green on the real host (scenario 6 through the unchanged v1 suite, scenario 7 host emission only), every plan handoff verified, refuted, measured, or recorded unverifiable / not exercised with a reason; the 12 round 1 findings are fixed. Open findings: 0 known to the implementer.** QA round 2 has not run: it should re-read the Round 1 fixes table against the commits, challenge the assumptions below, and take O-32-7 to 3.3.

Verification on the final tree (default pool, no `--pool=threads`, no full unit suite):

- `npm run typecheck`: clean.
- `npm run smoke:routing` (OpenCode 2.0.22, scripted provider): **12 passed**, 306 s, serial, harness HEAD `0953b18`. Without `RUN_OC_SMOKE_ROUTING=1` every test is skipped.
- `npm run smoke:v1` (v1 suite, OpenCode 1.18.34, private TEMP): 5 files, 27 passed, 11 skipped, 400 s, HEAD `0953b18`.
- Scoped unit runs (6 files, **302 passed**): `test/integration/routing-dispatch.test.ts`, `test/integration/routing-advisor.test.ts`, `test/unit/routing-outcomes.stats.test.ts`, `test/unit/routing-advisor.bundled.test.ts`, `test/unit/escalate-resume.test.ts`, `test/integration/routing-ladder-resume.test.ts`.

Assumptions a reviewer should challenge: (1) the scripted provider's token numbers are body-length/4 estimates, so the growth **mechanics** are real and the magnitudes are not tokenizer counts; (2) a scripted model cannot show whether a real producer repeats work after a resume; (3) in-band effort delivery was observed at the host-to-provider boundary only: acceptance by api.anthropic.com / api.openai.com is not verified; (4) the live-store attribution rests on construction and row content, not on the snapshots alone.
