# Role-tier spikes S1–S12 (issue #84, P0.1)

| | |
|---|---|
| Host | OpenCode **v2.0.24** (live binary; `v2.0.22` source used only as reference), isolated `opencode serve` per spike |
| Date | 2026-10-08 |
| Branch | `rta/p01` |
| Commits | `cc750a8` (harness), `e57a5d7` (S1 S2 S4 S7), `f6ccbf0` (S3 S6 S8 S9), `d39855a` (S10 S11 S12), `98a7922` (S11 plugin-tool permission and evaluate on allowed external paths), `c3dad26` (QA round 1: harness and S1 S2 S4 S7) |
| Gate command | `$env:RUN_OC_SMOKE_ROLE_SPIKES='1'; npx vitest run --config vitest.smoke.config.ts test/smoke/role-spikes.smoke.test.ts` (13 tests, all green at `c3dad26`; without the variable the file is skipped) |
| Test file | `D:\git\omr-rta-p01\test\smoke\role-spikes.smoke.test.ts`; harness `D:\git\omr-rta-p01\test\smoke\helpers\routing-host.ts` |
| Raw observations | One redacted JSON per spike in `<OMR_SMOKE_REAL_TMPDIR>\omr-role-spikes\` (the real temp directory recorded by the smoke temp guard; `S1.json`, `S2.json`, `S2-overlap.json`, `S3.json`, `S3-throw.json`, `S4.json`, `S6.json`, `S7.json`, `S8.json`, `S9.json`, `S10.json`, `S11.json`, `S12.json`, plus exploratory `S8x/S10x/S11x/S12x.json`). **Not committed**: they live outside the repository and are overwritten by the next gated run. |

How to read this: the spikes use a scripted keyless provider (Anthropic Messages and OpenAI Responses) and a probe plugin loaded next to the router. Every assertion is on host state (provider wire requests, `session.get`, the host session context, the probe's `events.jsonl`/`hooks.jsonl`), never on the scripted provider's own echo. Where an observation contradicts what the plan expected, the observation is pinned and called out under **Design consequence**. Line ranges are those of `role-spikes.smoke.test.ts` at `c3dad26`.

| Existing callers of the harness | `$env:RUN_OC_SMOKE_ROUTING='1'; npx vitest run --config vitest.smoke.config.ts test/smoke/routing-engine.smoke.test.ts test/smoke/plugin-agents.smoke.test.ts` at `c3dad26`: 13 passed, 1 failed (`Test Files 1 failed | 1 passed (2)`, `Tests 1 failed | 13 passed (14)`). The failure is scenario `6 v1 untouched`, which diffs `test/smoke` and `package.json` against the historic base `71815eb` and reports 16 changed paths including modified v1 smoke files and the `2.2.0 → 2.3.0` version bump of this branch's base; none of those files is touched by the spike commits (they add only `helpers/routing-host.ts` changes and `role-spikes.smoke.test.ts`, which the scenario lists as added). It is independent of the harness change; the other 13 scenarios, which use the changed harness, pass. |

---

## S1 — Agent registered without a model, per-call `model: provider/model#variant`

**Question.** If a role agent is registered with no `model`, which model and which effort/variant reach the provider when the parent dispatches it with a per-call `model`, for an Anthropic and for an OpenAI-Responses provider? And with no per-call model — does it take the parent session's model or the host default?

**Method.** Test `S1 agent registered without a model …` (lines 109–159). The agent comes from `hostConfig.agents` (`agentWithoutModel()`); the test reads the generated `opencode.json` and `client.agent.list()`, then dispatches four times from one root. The root runs on `anthropic/claude-sonnet-5-5#medium`, which is neither the host default (`anthropic/claude-opus-4-7`) nor any of the per-call models, so an inherited model can be attributed.

**Observation.**
- The generated config entry is `{"mode":"subagent","description":"…"}`; `"model" in entry` is false; the host's agent record exists (`toBeDefined`) and has `model === undefined`. The host accepts the agent.
- Anthropic: `anthropic/claude-sonnet-5-5#medium` → wire model `claude-sonnet-5-5`, catalog ref `anthropic/claude-sonnet-5-5#medium`, `output_config.effort: "medium"`; `…opus-5-5#xhigh` → `claude-opus-5-5`, effort `xhigh`. `session.get(child).model` equals the per-call `model#variant`.
- OpenAI Responses: `openai/gpt-6-luna#high` → wire model `gpt-6-luna`, top-level `reasoning.effort: "high"`, stored model `openai/gpt-6-luna#high`.
- No per-call model: the child gets the **parent session's model and variant** — stored `anthropic/claude-sonnet-5-5#medium`, wire model `claude-sonnet-5-5`, `output_config.effort: "medium"` — and not the host default `opus-4-7` (asserted with the root on a distinct model; the earlier run, with the root and the host default both on `opus-4-7`, could not tell the two apart).

**Design consequence.** A model-less role agent works on both protocols when the dispatch carries `model#variant`, so the router can set the model per call. Without it the child silently runs on the PARENT session's model and variant (at the parent's cost and effort), so P2.1 must still register the floor tier's model on the agent as fallback — this confirms §2.2 / T2.1.1.

---

## S2 — What `session.get(child)` answers at the first hooks; ordering; overlapping same-title siblings; nonce binding

**Question.** At the child's first `session.hook("context")` and first `permission.hook("evaluate")`, does `session.get(child)` return `parentID`, `agent`, `title`, `model`? How does that relate to the `session.created` event? For siblings of one parent turn that really run at the same time with the same agent, title and prompt, is there anything at the first context hook that tells them apart — in particular a per-dispatch nonce inserted in `execute.before`?

**Method.** Two tests.
- `S2 serialised samples …` (lines 160–230): five children of one model-less agent, all titled `S2 same title`, started one after another (two from different roots, two background dispatches in successive turns of one root, one reader). The probe logs `session.get` at each first hook with a sequence counter and its instance id.
- `S2 siblings spawned by ONE parent turn with their first requests held in flight …` (lines 231–299): the provider answers one parent turn with TWO `subagent` calls in one reply (`SPIKE_CALLS=[…]`), and holds each child's first model request until both have arrived (`holdUntilOverlap`). Two hosts: without and with the probe's nonce (`execute.before` appends ` [nonce <callID>]` to the description and `OMR_NONCE=<callID>` to the prompt).

**Observation.**
- Serialised samples (5 of 5; not a host guarantee): at the first context hook `session.get` returns `{parentID: <its own root>, agent: "role-nomodel", title: "S2 same title", model: {claude-sonnet-5-5, low}}`; at the first evaluate (only the reader has one — a child that calls no tool triggers none) the same fields. The probe saw `session.created` before the first context hook in all five, and both records come from the same probe instance (`__iid` equal), so their sequence numbers are comparable. The event arrives to the probe through a detached loop, so this order is an observation, not a contract. The `session.created` payload carries `parentID`, `agent`, `title`, `model`.
- Overlap: both children's first model requests were in flight at the same time (`arrivals: 2, releasedByArrival: true, timedOut: false`, in both hosts), so the host runs the children of one parent turn concurrently. The interleaving observed in both hosts was `created:0, context:0, created:1, context:1` — the second child is created only after the first child's first context hook (so "child B created before child A's context hook" did NOT happen). The order of the first context hooks equals the order of the parent's `execute.before` call ids (`toolu_smoke_1`, `toolu_smoke_1_1`). One probe instance served all records.
- Without a nonce the two siblings are identical at the first context hook: the same `parentID`, `agent`, `title`, `model` and the same first-message text (`You are a subagent spawned by another session.\nS2_HOLD twin`); only the child session id differs.
- With the nonce: each child's `session.get` title at the first context hook is `S2 twin [nonce <its callID>]`, its first context message contains `OMR_NONCE=<its callID>`, the `session.created` payload has the same title, and the map nonce → child equals the map callID → child taken from each call's own `execute.after` result. The nonce was inserted by the probe's `execute.before` hook; the router's own `execute.before` (which already rewrites `args.prompt`) was not used to insert it.

**Design consequence.** The binding of a child to its dispatch is done at the **first context hook**, where `session.get` is proven to answer parentID/agent/title/model; `session.created` is only an early hint (its order relative to the context hook is not a host guarantee). Without a nonce, siblings of one parent with the same agent, title, model and prompt are genuinely ambiguous → keep the intersection fallback of §2.5. The evidence supports a router-inserted per-dispatch nonce (the call id, in the description and prompt of the `subagent` call from `execute.before`) as an exact binding key visible at the first context hook; that the router's own hook can insert it was not run (only the probe did).

---

## S3 — Per-session narrowing in `evaluate` and `context`; hooks that throw

**Question.** Does the permission `evaluate` hook keyed by `event.sessionID` narrow ONE child only? Can the context hook (`event.tools`) remove tools from ONE session's catalog? What does the host do when a hook throws?

**Method.** Tests `S3 per-session narrowing …` (lines 475–522) and `S3 edge: a plugin hook that throws …` (lines 523–564). The probe resolves the session title with `session.get(event.sessionID)` and decides per session. Four concurrent children of the same agent (overlap recorded in `S3.json`), then two extra hosts where one hook throws.

**Observation.**
- evaluate: `read` denied for the child titled `S3 A` only → A's tool state `error`, `permission.rejected`, message `PROBE_SESSION_DENIED: read`; B (same agent, concurrent) `completed`. Both parents see a plain `completed` child.
- context: `shell` and `write` removed for `S3 C` only → C's provider request `toolNames` has neither, D's has both; `read`/`edit` untouched in both. A and B (not stripped) still advertise them.
- Throwing evaluate: that single tool call fails in the child (`errorType: "unknown"`, message `PROBE_HOOK_THROWN evaluate`) — fail **closed** for the call. The child continues and ends `succeeded`; the parent sees `completed`; no host ERROR line; the next child of the agent is evaluated normally.
- Throwing context: the child makes **0 provider requests**; events end `session.execution.failed`, child outcome `failed`; the parent's `subagent` call returns `status: error`, `Subagent failed (sessionID: ses_…): PROBE_HOOK_THROWN context`; one host log line `level=ERROR … message="Failed to drain Session"`. The next child of the same agent runs fine.

**Design consequence.** Per-session narrowing is available in both hooks. An evaluate error costs one call (closed); a context-hook error kills the whole child. P2.3 must therefore wrap the context hook in try/catch and, on error, degrade to the minimal (local-only) catalog for role agents instead of throwing (I9 without killing the child). The evaluate hook should also catch and return an explicit deny with a clear message rather than rely on the generic `unknown` error.

---

## S4 — How the parent sees a step-limit stop and a plugin-guard denial

**Question.** What does the PARENT model receive when the child hits its agent `steps` limit, or when a plugin guard denies its tool call? What does the host do on the child side?

**Method.** Test `S4 how the parent sees a child that hits its step limit …` (lines 300–393). Agents with `steps: 2` and `steps: 3`, a second agent denied `read` by the probe's `evaluate` hook, a control agent. The scripted provider either answers with text on the last step, or keeps calling a tool (`loopProbe`, which ignores `tool_choice: none`). What the parent saw is taken from the `tool_result` of the parent's NEXT provider request (`host.requestsOf(root)` first `primary` request with `toolResult`), not from the probe's `execute.after` record.

**Observation.**
- Parent side (asserted on the parent's next request): `state="completed"` and the child's text — `CHILD_OK` (scripted child that answers on its last step), `Subagent completed without a text response.` (scripted child that only calls tools), `ROOT_DONE` (scripted fixed reply after a denied call). In all three, with the session-id attribute removed, the text matches none of `MAXIMUM|maximum|steps?|PLUGIN_GUARD_DENIED|denied|Permission`.
- Child side, `steps: 2`: request 1 is a normal tool step; request 2 (the last allowed step) carries the host's `MAXIMUM STEPS REACHED` note and `tool_choice: {type: "none"}`. If the scripted model answers with text the child ends `succeeded` (finishes `tool-calls`, `stop`). If it calls a tool anyway (possible only with a provider that ignores `tool_choice`), the host answers that call with an error to the child model — `Tools are disabled after the maximum agent steps`, `session.tool.failed` — and the session ends `succeeded` with finish `tool-calls` and no text.
- `steps: 3` with the looping scripted model: requests `[tool, tool, tool+maxSteps/tool_choice none]`, tool states `[completed, completed, error "Tools are disabled after the maximum agent steps"]`. So for N = 2 and N = 3 a limit of N gives N−1 tool-capable steps and one final tool-less step (only these two values were run).
- Guard denial: the child's tool state is `error`, type `permission.rejected`, message `PLUGIN_GUARD_DENIED: read`; the tool hook records `Permission.BlockedError`; the session goes on and ends `succeeded` (the continuation text is the scripted fixed reply, not evidence of host recovery behaviour).

**Design consequence.** Neither the step limit nor a guard denial reaches the parent in its tool result; the signals exist only on the child side (`session.tool.failed`, `Permission.BlockedError`, the max-steps note in the child's request), where only plugin hooks can see them. Budget exhaustion and authority denials must therefore be annotated by the plugin (`execute.after`, S6) from plugin-side state (P1.5 `budgetExhausted`). The host `steps` limit must sit ABOVE the role budget so the plugin's "NEED MORE: budget" message fires first — amend T2.1.1 "steps from the top budget" to `steps = top budget + margin` (N means N−1 tool steps, observed for N = 2 and 3).

---

## S5 — Where the inferred acceptance criterion is cut (code reading, no host run)

**Question.** Why can a `NOT ACCEPTED` criterion be a truncated first line of the dispatch, and does the same `args` object mutated by the dispatch header reach the DoD builder?

**Method.** Code reading, no test: `src\verify\dod.ts`, `src\verify\dispatch.ts`, `src\router\dispatch-header.ts`, `src\index.ts`, `src\compat\v2-hooks.ts`.

**Observation.**
- Cut site: `summarizeDispatch` (`src\verify\dod.ts:57-65`) returns `trimmed.slice(0, 120)` of the **first non-empty line** (`:62`). `inferDoD` pushes that summary as the sole criterion when no deterministic check applies (`dod.ts:254-260`).
- `buildDelegationDoD` (`src\verify\dispatch.ts:552-561`): no `[acceptance]` block → `inferDoD(args.prompt ?? args.description, "", hints)`.
- Header: `src\index.ts:1732-1734` prepends `buildDispatchHeader(...)` (`src\router\dispatch-header.ts:20`: `[router] You are @<tier>. Execute this dispatch yourself; do not route it to another tier, and do not ask to be re-dispatched.`) to `args.prompt`. The after hook reads the dispatch at `src\index.ts:1883-1886` (`buildDelegationDoD({prompt: input.args.prompt, …})`), so for a header-prefixed prompt the inferred criterion is the header's first 120 characters.
- **Correction to the "same object" claim.** On the v2 path they are NOT the same object. `taskArgs` copies the input (`src\compat\v2-hooks.ts:47-50`, `{...args, subagent_type, task_id}`); the before-hook mutation at `index.ts:1734` lands on that copy; the compat layer then writes it back with `event.input = nativeArgs(...)` (`v2-hooks.ts:528`), and the after hook re-reads it through a new copy (`scopedArgs(event)`, `v2-hooks.ts:584`). The data flows through `event.input`; the result (header-prefixed prompt at `index.ts:1883`) is the same.
- The header is only added when the agent is an active tier (`index.ts:1718-1724`: `Object.prototype.hasOwnProperty.call(getActiveTiers(cfg), tier)`) and the prompt does not already start with `[router] You are @`. A dispatch to a non-tier role agent gets **no** header.
- Rendering of `NOT ACCEPTED`: `buildForcingNote` (`src\verify\dispatch.ts:598-613`, text at `:613`) contains no truncation; the 120-character cut happens earlier, in the criterion.

**Design consequence.** The cut site is confirmed. P1.5's ownership gains `D:\git\opencode-model-router\src\verify\dispatch.ts`: strip the router header before parsing/inferring inside `buildDelegationDoD`, so `src\index.ts` (Wave-2 hot file) need not change in Wave 1. The defect only affects tier dispatches; role-agent dispatches have no header (but still get a 120-character first-line criterion when no check applies).

---

## S6 — `execute.after` on the parent's `subagent` call

**Question.** Can `tool.hook("execute.after")` on the parent's `subagent` call append text that the PARENT model sees?

**Method.** Test `S6 tool.hook execute.after … appends text the PARENT model sees …` (lines 565–591). The probe appends `S6_APPENDED_NOTE_FOR_THE_PARENT` to the completed result; assertion on the parent's next provider request.

**Observation.** The parent's next request carries exactly one `tool_result` block with two text parts: the child's envelope `<subagent sessionID="…" state="completed">\nCHILD_OK\n</subagent>` followed by `S6_APPENDED_NOTE_FOR_THE_PARENT`. The child's own requests never contain the note. (The probe's own earlier `execute.after` record shows the result before the append — hook order is registration order — so it is not evidence; the provider request is.)

**Design consequence.** Confirmed: plugin-side annotations (budget, authority, verification) appended in `execute.after` reach the parent model; this is the delivery channel for S4's missing signals.

---

## S7 — Resuming a child with another model/variant

**Question.** When the parent resumes a child (`subagent` with the child's `sessionID`) with a different per-call model and variant, which model/effort reach the provider? Is it the same child, with its history, if resumed twice or across providers?

**Method.** Test `S7 resuming a child with a different per-call model and variant (twice) …` (lines 394–474). The child id of every call is taken from that call's own result (a resume must name the same child; the input is not echoed back).

**Observation.**
- Anthropic: `sonnet#low` → resume `opus#xhigh` → resume `sonnet#medium`: wire models `claude-sonnet-5-5`/`claude-opus-5-5`/`claude-sonnet-5-5`, efforts `low`/`xhigh`/`medium`; `session.get` model follows each time.
- OpenAI Responses: `luna#low` → `sol#high` → `luna#max`: wire models `gpt-6-luna`/`gpt-6-sol`/`gpt-6-luna`, efforts `low`/`high`/`max`.
- Cross-provider: an Anthropic child resumed on `openai/gpt-6-luna#high` moves to the Responses protocol at effort `high`.
- Identity: every resume's result names the resumed child (`call.childID === sessionID`); the root has exactly one child per start.
- History (asserted on the resumed request's messages as the provider received them): the resumed request contains the earlier prompts (`S7 anthropic start sonnet#low`, then also `… resume 1 opus#xhigh` on the second resume; the `responses` and `cross` equivalents) and at least one earlier `CHILD_OK` reply (two after two earlier turns); a fresh start contains none of them.
- When the model changes with the resume the new effort is the top-level one (no in-band configuration change), on both protocols.

**Design consequence.** Confirmed: a role can be resumed on a higher tier (and even another provider) with the same child session, keeping its earlier turns. In-band effort changes were not exercised here (the model changed on each resume); the older same-model scenario (`routing-engine.smoke.test.ts`, scenario 7) covers them.

---

## S8 — Code Mode `execute`: permission evaluation and catalog filtering

**Question.** Are inner `tools.*` calls made inside `execute` evaluated by `permission.hook("evaluate")`? Can the per-session `context` hook restrict the Code Mode catalog to an allowlist? What about an inner call outside the allowlist?

**Method.** Test `S8 Code Mode execute …` (lines 592–647); an exploratory run first (`S8x.json`). The child calls `execute` with scripted code.

**Observation.**
- Code Mode is on by default in the isolated host (`execute` advertised and runs). The inner catalog is NOT the agent's tool list: namespaces `["opencode","browser"]`; `opencode` = `session_rename, session_move, models, list_mcp_resources, read_mcp_resource`; `browser` = 30 operations, listed but not callable (`Tool 'browser.tabs' is not callable.`). Native tools such as `read`/`shell` are not in it. Inner `search()` (a global) searches that catalog.
- **No** `evaluate` event fires for the `execute` call itself, for inner `models`, for inner `session_rename`, for the browser call or for `search`. A native `read` of a control child does fire one.
- Inner `tools.opencode.session_rename({title})` really renamed the child's session on the host (`session.get(...).title === "S8 renamed by execute"`).
- The context hook can cut the agent-level catalog to exactly `["subagent","execute"]` (provider request `toolNames`), but `event.tools` has no inner entries: the inner namespaces, the five `opencode` operations and `search` are unchanged, and an inner call outside the allowlist (`session_rename` in the filtered session) still ran and changed the title.

**Design consequence.** Code Mode inner calls are never evaluated and the inner catalog cannot be filtered by the context hook. `execute` must therefore be **denied to every role agent in roles mode**; the researcher has no `execute` and no `brave_*`; the `codeModeAllow` idea is dropped from `RoleSpec`/`roleAgents` (amend §2.2, §2.4, T1.1.2, T1.1.3).

---

## S9 — Rewriting `args.agent` in `execute.before`

**Question.** If `tool.hook("execute.before")` of the `subagent` call rewrites `agent: "explore"` to `"explorer"` (a registered custom agent), which agent does the child actually run as?

**Method.** Test `S9 rewriting args.agent explore -> explorer …` (lines 648–690). The probe assigns `e.input = {...e.input, agent: "explorer"}`; the custom agent has a marker system prompt and an `edit` deny.

**Observation.** `session.get(child).agent === "explorer"` and the `session.created` payload/first context hook carry `explorer`; the provider request's system prompt starts with the custom marker (a control child on another agent has none); the host's own agent record for `explorer` has the `edit: deny` rule and `explore` does not; the parent's call completes. A probe `execute.before` hook registered earlier still saw `agent: "explore"`.

**Design consequence.** Confirmed: the router can map a generic dispatch to a role agent in `execute.before`. Hook order is registration order, so earlier hooks see the original agent — the router's rewrite must happen in the router's own hook and anything keyed on the agent name must run after it.

---

## S10 — Is the verification gate specific to tier agents?

**Question.** Does the router's verification gate run the acceptance checks for a child dispatched to a non-tier custom agent, compared with `fast`/`medium`? What decides whether a dispatch is gated?

**Method.** Test `S10 the router's verification gate treats a non-tier custom agent exactly like fast/medium …` (lines 691–746). Four hosts (enforcement `enforced`, default, `off`, `verify.require: "never"`); each dispatch carries `[acceptance]\ncheck: fileExists path=<abs>\n[/acceptance]` with one existing and one absent file.

**Observation.**
- `enforced`: for `fast`, `medium`, `explorer`, `implementer` alike, file present → result text `CHILD_OK\n\n[router ✓ verified: deterministic]`; file absent → `[router ⚠ NOT ACCEPTED] The delegated result was not accepted by independent verification:\n- file not found: …\ns10-absent.txt`. The deterministic checker ran; the grader count stayed 0.
- The only difference is the next-step hint: `fast`/`medium` get ``re-run via `subagent(agent="medium")` (escalated from fast)`` (and `heavy` for medium); `explorer`/`implementer` get `NEXT: address the above and re-run the delegation; do not treat the prior result as complete.`
- The default (advisory) mode gates as well; `enforcement.mode: "off"` and `verify.require: "never"` leave the plain `CHILD_OK`.
- What decides gating: `shouldVerifyTask` (`src\verify\dispatch.ts:580-589`) checks only `tool === "task"` (`:585`), `mode !== "off"` (`:586`) and `require !== "never"` (`:587`); it is called at `src\index.ts:1874` after `resolveEnforcementMode` (`:1869`; v2's `subagent` is mapped to `task` by `legacyToolName`, `src\compat\v2-hooks.ts:70`). There is no agent-name list or tier lookup. The producer name only feeds the hint: `ladder.indexOf(producerTier)` (`src\index.ts:2023-2026`); a name outside `escalate.ladder` gives `nextTier = null`.

**Design consequence.** The gate is agent-agnostic. Effective detection is deterministic whenever the dispatch carries deterministic checks, enforcement is not `off` and `verify.require` is not `never`; role agents work with no extra wiring. They get only the generic escalation hint, so P2.1 must add a role-aware hint (resume the same child on a higher tier, see S7).

---

## S11 — Work root in a sibling worktree

**Question.** From a session in the main checkout, can a deny-by-default role agent read, edit and call a plugin tool on a sibling `git worktree`? Is `external_directory` asked or denied by default; can the agent's max policy allow only the listed worktree root; where does a plugin tool run; is a worktree created after the host started covered (no pattern / glob)? Plus: (a) is a plugin tool bounded by the agent's max policy; (b) does `evaluate` fire for an allowed external path?

**Method.** Test `S11 work root in a sibling worktree …` (lines 747–867). A git repo in the temp root (main checkout = host project, `wt-1` sibling worktree, an unrelated `other` directory, `wt-2` created after the host started). Agents registered at start: `role-base` (host defaults), `role-deny` (`"*": deny` + read/edit/`wt_probe` allows), `role-wt1` (`+ external_directory <root>\wt-1\*`), `role-glob` (`+ external_directory <root>\wt-*`), `role-notool` (`"*": deny` + `read` only). A probe tool `wt_probe` reports `process.cwd()` and its context; the probe turns an `ask` into a deny to avoid hangs and logs `effectIn`.

**Observation.**
- Default agent: `external_directory` is **asked** (`effectIn: "ask"`, resource `<root>/wt-1/*`) for read and edit.
- `role-deny` (no `external_directory` rule): refused by the host itself — `Permission denied: external_directory`, no `evaluate` event reaches plugins.
- `role-wt1` (rule for the worktree root only): read and edit run (evaluate sequence `external_directory allow`, then `read`/`edit allow`); the edit is on disk in `wt-1` and not in the main checkout. A path in `other` stays denied (`Permission denied: external_directory`) and unchanged.
- `role-glob` (`<root>\wt-*`) covers `wt-1`. A worktree `wt-2` created AFTER the host started is: **denied** with no pattern (`role-deny`) and with an exact `wt-1` pattern; **covered** (read and edit) by the glob registered at start; `other` is still denied.
- Plugin tool: runs with `process.cwd()` = the main checkout (= session location = plugin location); its context keys are only `sessionID, agent, messageID, id, progress, signal` (no `directory`/`worktree`). No `evaluate` event fires for it, even with a sibling path argument.
- (a) Under deny-by-default WITHOUT an explicit allow for the plugin tool (`role-notool`), the host does not advertise `wt_probe` (absent from the provider request's tools) and a call to it fails with `No tool named "wt_probe" is currently available. Please use a tool from the available tool list.` (`tool.execution`); it never runs and no `evaluate` fires. With the explicit allow (`role-wt1`/`role-deny`) it is advertised and runs. So a plugin tool IS bounded by the agent's max policy, at the catalog level.
- (b) When the max policy allows `external_directory`, the plugin `evaluate` hook **does fire** (`effectIn: "allow"`) and can narrow it for one session: the session titled `S11 role-wt1 narrowed` is refused with `PROBE_SESSION_DENIED: external_directory` while the same agent's other children read the path.

**Design consequence.** Max-policy `external_directory` rules for the listed worktree roots work; worktrees created later need a glob, which confirms `routing.workRoots` as glob patterns written statically into the role agent's policy. Without such a rule the host refuses before plugins see anything, so the router cannot "allow later" from a hook. Plugin tools run in the main checkout and get no directory, so `router_run` must spawn with an explicit `cwd` resolved from the binding (sessionID → work root) and validate it itself (confirms P1.3 `cwd`); because no `evaluate` fires for plugin-tool execution, that internal check is mandatory (the agent policy only decides whether the tool is available at all). P2.3 can narrow per session on external paths through `evaluate` (b).

---

## S12 — Changing the override's `agents` block without a restart

**Question.** If the router override's `agents` block changes while the host runs (new agent, changed description), when do `GET /api/agent`/`client.agent.list()` and the orchestrator's `subagent` catalog follow?

**Method.** Test `S12 the router override's agents block changed WITHOUT restarting the host …` (lines 868–943). Two hosts; the override file is rewritten via `host.writeOverrides`; views: `client.agent.list()`, `/api/agent`, and the `subagent` tool description in the root's provider request. A 30 s bounded poll, then (A) an ordinary prompt, (B) the `/router-reload` command.

**Observation.**
- Before: all three views show `reviewer … description ONE`. Immediately after the write, and during the 30 s poll, nothing changes (`changedByItselfAfterMs` undefined).
- (A) The **first ordinary prompt** after the change already carries the new catalog in its own provider request (`description TWO`, agent `newbie`), and `agent.list` and `/api/agent` show both; the state stays on the next prompt.
- (B) `/router-reload` alone (no ordinary prompt) also brings `agent.list` and `/api/agent` to the new block.
- Scope: this covers the router override's `agents` block (plugin agents); agents defined in the host's `opencode.json` were not changed during the run.

**Design consequence.** An `agents` change in the override is live on the next prompt (or `/router-reload`) with no restart, so DF-2b is not needed (amend §0.7, DF-2 step 3, handover §7).

---

## Proposed amendments

| id | plan section | change | reason |
|---|---|---|---|
| P-1 | §2.2, T2.1.1 | Keep registering the floor tier's model (and variant) on every role agent as fallback, even though a model-less agent works. | S1: a model-less agent without a per-call `model` gets the PARENT session's model and variant (root on `sonnet-5-5#medium` → child `sonnet-5-5#medium`, not the host default `opus-4-7`). |
| P-2 | §2.5 | Bind a child to its dispatch at the first `session.hook("context")` (`session.get` returns parentID/agent/title/model there, S2); treat `session.created` only as an early hint. Preferred key: a router-inserted per-dispatch nonce (the call id appended to description and prompt in `execute.before`), read back from the child's title / first context message and mapped to the call whose own result names the child. Without a nonce the key `parentID + agent + title + model + first-message text` is identical for siblings of one parent turn → intersection fallback. | S2: siblings spawned by one parent turn run concurrently (both first requests in flight), are indistinguishable on those fields, and are told apart exactly by a nonce (probe-inserted; the router's own insertion was not run). The order of `session.created` versus the context hook is observed (5/5 serialised, 2/2 overlapping), not a host contract. |
| P-3 | P2.3 | Wrap the context hook in try/catch and degrade to the minimal local-only catalog for role agents; make the evaluate hook return an explicit deny with a message instead of throwing. | S3: a throwing context hook fails the whole child (`session.execution.failed`, parent `error`); a throwing evaluate hook fails only that call (closed). |
| P-4 | T2.1.1 | `steps = top budget + margin` (not the top budget); note that a limit of N allows N−1 tool-capable steps. | S4: the host appends its max-steps note and sends `tool_choice: none` on step N, and fails any tool call made on it; observed for N = 2 and N = 3. The plugin's "NEED MORE: budget" must fire first. |
| P-5 | P1.5, P2.1 | Annotate budget exhaustion and guard/authority denials for the parent in the plugin (`execute.after`, from plugin-side state such as `budgetExhausted`); the parent's tool result carries no such signal on its own. Child-side host signals (`session.tool.failed`, `Permission.BlockedError`, the max-steps note) may feed the plugin's state. | S4: the parent's next request shows `state="completed"` plus the child's text and nothing about steps or denials, for a step-limit stop and for a plugin-guard denial; S6: `execute.after` text reaches the parent model. |
| P-6 | §2.2, §2.4, T1.1.2, T1.1.3 | Deny `execute` to every role agent in roles mode; the researcher has no `execute` and no `brave_*`; remove `codeModeAllow` from `RoleSpec`/`roleAgents`. | S8: inner Code Mode calls are never evaluated, `event.tools` cannot filter the inner catalog, inner `session_rename` ran. |
| P-7 | P2.1 (agent mapping) | Perform the `explore → explorer` rewrite in the router's own `execute.before` hook by assigning `event.input = {...event.input, agent}`; hooks registered earlier see the original agent. | S9: the rewrite is honoured (agent, system prompt, permissions); hook order is registration order. |
| P-8 | P2.1 | Role-aware escalation hint for role agents (resume the same child on a higher tier via `sessionID` + per-call `model#variant`). | S10: non-ladder agents get only the generic "re-run the delegation" hint; S7: resume on another model/variant/provider keeps the child and its context. |
| P-9 | §2 (verification) | State that no agent-specific wiring is needed: detection is deterministic whenever the dispatch carries deterministic checks, `enforcement.mode ≠ off` and `verify.require ≠ never`. | S10: `shouldVerifyTask` (`dispatch.ts:585-588`) is agent-agnostic. |
| P-10 | P1.3 | `router_run` spawns with an explicit `cwd` resolved from the binding (sessionID → work root) and validates it itself; it must not depend on its context for a directory. | S11: plugin tools run in the main checkout cwd; the context has no `directory`/`worktree`. |
| P-11 | P1.3, §2.4 | `routing.workRoots` entries are written as `external_directory` allow rules (glob patterns) into the role agent policy at registration; worktrees created later rely on the glob. | S11: exact rule → later worktree denied; glob `<root>\wt-*` → covered; no rule → the host refuses before plugins. |
| P-12 | P1.3, P2.3 | Every role agent that may call `router_run` (or any plugin tool) lists it explicitly in its allows; the router tool still performs its own authority check because no `evaluate` fires for plugin-tool execution. | S11(a): under deny-by-default a plugin tool without an explicit allow is not advertised and cannot run; an allowed one runs without any `evaluate`. |
| P-13 | P2.3 | Per-session narrowing of external paths can use `permission.hook("evaluate")` (it fires for allowed `external_directory`). | S11(b): `effectIn: "allow"` is seen and a plugin deny wins for that session only. |
| P-14 | §0.7, DF-2 step 3, handover §7 | Remove DF-2b (restart after agent changes). Document that the next prompt or `/router-reload` applies a changed `agents` block. | S12: both `agent.list`/`/api/agent` and the orchestrator's `subagent` catalog follow on the next prompt; `/router-reload` also works. Host-`opencode.json` agents were not tested. |
| P-15 | P1.5 ownership | Add `D:\git\opencode-model-router\src\verify\dispatch.ts` (strip the router dispatch header before parsing/inferring inside `buildDelegationDoD`); `src\index.ts` stays untouched in Wave 1. | S5: the criterion is `trimmed.slice(0,120)` of the first non-empty line (`dod.ts:62`), which is the header for tier dispatches. |
| P-16 | P1.5 (wording) | Do not state that the header mutation and the DoD read share one `args` object; on v2 the data flows `output.args → event.input` (`v2-hooks.ts:528`) → a fresh copy in the after hook (`:584`). Note the header is added only for active tiers (`index.ts:1718-1724`), so role-agent dispatches are not affected by the header. | S5 verification of the claim. |
