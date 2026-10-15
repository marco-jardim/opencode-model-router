# ADR 0007 — Critical-Path Execution

> **Status:** Accepted (measurements pending Phase 6.1) **Date:** 2026-10-10, revised 2026-10-11 **Wave/Phase:** Critical-Path Execution, Phase 0.1 (tasks 0.1.4, 0.1.FIX)
> **Supersedes:** none **Depends on:** ADR 0002 (acceptance gate), ADR 0005 (cost-aware routing engine), ADR 0006 (role × tier × assurance delegation)
> **Deciders:** owner (Marco Jardim); host observations, adversarial QA round 1 (QA-0.1-1 … QA-0.1-16) and its fixes are recorded in the Phase 0.1 report (`docs/qa/critical-path-execution/phase-0.1.md`)
> **Plan:** [`../plans/critical-path-execution-plan.md`](../plans/critical-path-execution-plan.md) (amendments A-0.1-2 and A-0.1-3 apply this revision) **Handover:** [`../plans/critical-path-execution-handover.md`](../plans/critical-path-execution-handover.md)
> **Host version under test:** OpenCode v2.0.26 (`C:\Users\Marquinho\scoop\apps\opencode2\2.0.26\opencode.exe`)
> **Evidence:** `npm run smoke:cpx` at test commit `7b11504` (branch head `3873d7f` adds only the phase report), three green runs on 2026-10-11, 51/51 tests each: `5eb6a5a6` (03:20–03:28 UTC), `ff9762e2` (03:29–03:37 UTC), `a0de2aa6` (03:37–03:46 UTC), that is 00:20–00:47 local time (UTC−3)
> **Issue:** none

## Context

A large plan (about 100 tasks, several waves and phases) should finish in a wall-clock time close to its critical path,
and the human should stop acting as the scheduler. Today the owner backgrounds slow delegations by hand, and the
orchestrator sits blocked on work it does not depend on.

### Problem today

| # | Symptom |
|---|---|
| P1 | Every role dispatch is forced to the foreground (`nativeArgs`, `roleForeground = true` in the v2 adapter). |
| P2 | Every verified dispatch is forced to the foreground. |
| P3 | A dispatch the user backgrounds loses every router guarantee (early return before the legacy after-hook). |
| P4 | Per-turn router state lives in the system prompt, so each change invalidates the cached history (cache order: tools → system → messages). |
| P5 | Pending verifications are in memory, expire after 1 h and vanish on restart. |
| P6 | No dispatch duration is recorded. |
| P7 | A plan is a flat ordered list without dependencies; step ids are line numbers. |
| P8 | No isolation and no integration; concurrency is only counted. |
| P9 | Nothing prevents two agents from writing the same file, or one reading while another writes. |
| P10 | `router_run` blocks its caller for up to 10 min. |

Code anchors for each symptom are in the plan, section "Problem today".

### How the host contracts were observed

The design depends on fifteen host behaviours (C1–C15, plan §2) and on the observations O1–O15 below. Phase 0.1 pins
them in `test/smoke/cpx-host-contract.smoke.test.ts` (`npm run smoke:cpx`). The suite runs OpenCode v2.0.26 against a
scripted provider front (`CpxFront`, `test/smoke/helpers/cpx-scripted-provider.ts`). The front wraps the host's scripted
provider: it injects faults, parks or delays requests, and captures every request body. Every host loads the router
(engine `shadow`, enforcement off; smoke ≈57) unless stated otherwise. The C14 hosts run it **enforced**; the C14
control host runs **without** it. A probe plugin (`test/smoke/probe/cpx-probe-plugin.js`) runs in a mode chosen per
scenario:

- `rewrite-completion` (C4);
- `append-tail-system`, `append-tail-user`, `append-tail-newest` and `append-tail-user+hint-last-real` (C5);
- `cache-hint-1h` and `cache-hint-1h-message` (C6);
- `filter-grep` (C9);
- `retry-observe` and `retry-stop` (C10);
- `mutate-subagent-prompt` (C11);
- `retained-launch` (C14, C14b);
- `rewrite-compaction` and `rewrite-completion+compaction` (C15);
- `plugin-session-api` (O6b).

Eighteen scenarios ran in each run: C1–C15, C14b (O4b), O6 and O6b. Each one writes a `C<n>.json` file with an
`observed` object and a `checks` array. Every check is one decided-branch assertion, with id `C<n>/D<k>` or
`C<n>/O<k>`. Every check passed in all three runs. **These checks are the facts this ADR relies on.** They live in the
`DECISIONS` table (smoke ≈1620-1887; `smoke ≈n` below means a line of that file). A contract without an entry refuses
to run (smoke ≈183-185).

Observation keys are cited as `C<n> key=value` (paths into `observed`). Values are the same in all three runs unless
the variance column says otherwise. Session ids, message ids, timestamps and temporary paths always vary and are not
listed. The observation files are not committed: they live in `%TEMP%\omr-cpx-probe\<runId>\` and were copied, with a
digest, to `tmp\cpx-obs-r1\` (gitignored). The committed record is the checks.

The C10 fault answers are the test's own bodies and headers (`faultAnswer`, `cpx-scripted-provider.ts` ≈87-121). They
show how the host classifies those answers, not what a real provider sends (O15).

### Evidence

| Id | Observed | Run-to-run variance | Pinned by |
|---|---|---|---|
| C1 | `subagent` with `background: true` returned `{status: "running", sessionID}` at once (`ack.status="running"`, `ack.matchesChildID=true`). `execute.after` fired exactly once for the call (`executeAfter.probeCountAtAck=1`, `probeCountFinal=1`, `harnessCount=1`). Its record has `status="completed"` while the result has `resultStatus="running"`; result keys are `output, content, metadata`. | `ack.returnedMs` 55 \| 42 \| 36 | `C1/D1`, `C1/D2` (smoke ≈1623-1626) |
| C2 | After the child ended, the host woke the idle parent with no user prompt (`completion.parentWoke=true`, `userPromptsAfterAck=0`). On the wire the completion is the last message, role `user`: one text block with the host's automatic `cache_control {type: "ephemeral"}` (`completion.wireEnvelope[0]`). It is stored as `type="synthetic"`, `metadata.source="subagent"`, `metadata.state="completed"`. Text: `<subagent sessionID="ses_…" state="completed" description="…">\n…\n</subagent>` (the C15-real hook shows the full text). | `completion.wakeMsAfterChildEnd` 41 \| 39 \| 38 | `C2/D2` (smoke ≈1630-1634) |
| C3 | The child ended while a parent request was in flight (`midTurn.childEndedDuringSlowRequest=true`). The completion reached provider request 3 and was stored (`delivery.lostFromWire=false`, `delivery.storedHasEnvelope=true`). | none | `C3/D2` (smoke ≈1638-1639) |
| C4 | The parent's context hook first saw the completion in request 4 (`hook.firstSeen.requestNo=4`) and replaced it in requests 4 and 5 (`hook.rewriteLines[3,4].did=true`). No provider body carried the raw completion (`rawEnvelopeInAnyProviderBody=false`); the placeholder reached bodies 3 and 4 (`placeholderInProviderBodies=[3,4]`). Stored history kept the original and never the placeholder (`stored.originalKept=true`, `stored.placeholderPersisted=false`). | none | `C4/D3` (smoke ≈1643-1645) |
| C5 | Four placements, two consecutive requests each. A `system`-role tail is folded by the host into the last user message as a `<system-update>…</system-update>` part (`$.messages[0].content[1]`), the same position as the `newest` placement. A separate `user` tail is the last message (`$.messages[1].content[0]`, then `$.messages[3].content[0]`). Every placement was sent, not stored, and absent from the next request (`wire.firstMarkerStillInSecond=false`, `storedHasMarker=false`). For the `user` tail, the system, the other fields and the earlier messages were byte-identical (`variants.user.prefix.*`). **Breakpoints:** the host emits four `cache_control {type: "ephemeral"}` markers per request: `$.system[0]`, `$.system[4]`, `$.tools[17]` and exactly one message block (`breakpoints[*].paths`). Without a manual hint, the message marker sits on the tail (`variants.user.breakpoints[*].onTail=true`, `onLastReal=false`). With a manual `cache: {type: "ephemeral"}` on the last text part of the last real message, the marker sits on that message and not on the tail (`variants.userHint.breakpoints[*].onLastReal=true`, `onTail=false`). The earlier request's last real message then differs from its next-request copy only by the moved marker (`variants.userHint.prefix.messages.firstDiff`: `{"type":"text","text":"C5 first turn","cache_control":{"type":"ephemeral"}}` vs `{"type":"text","text":"C5 first turn"}`); the system and every other field are identical. | none | `C5/D4`, `C5/D4/O8` (smoke ≈1651-1669) |
| C6 | The plugin API's part field `cache` is absent until the plugin creates it (`probeTried[*].hadCacheKey=false`, part keys `type, text`). Set to `{type: "ephemeral", ttlSeconds: 3600}`: on the last system part it reached the wire as `$.system[4].cache_control={type: "ephemeral", ttl: "1h"}` in both requests (`variants.system.oneHourOnSystem=true`); on the last text part of the last real message it reached the wire as `$.messages[0]` / `$.messages[2]` `.content[0].cache_control={type: "ephemeral", ttl: "1h"}` (`variants.message.oneHourOnMessage=true`). Every other marker stayed `{type: "ephemeral"}` (`$.system[0]`, `$.tools[17]`, and the message marker in the system variant). The context event's `options` has only `maxTokens`. **Consequence (QA-0.1-17):** the context event's `tools` has no cache field, so `$.tools[17]` keeps the host's default 5-minute marker while system and message markers can be raised to 1 hour; the provider requires longer TTLs to precede shorter ones in prefix order tools → system → messages, so that layout is invalid and D5 is withdrawn on v2.0.26. | none | `C6/D5` (smoke ≈1675-1677) |
| C7 | Each child produced its own terminal event carrying its session id: `session.execution.succeeded`, `.failed` (a scripted non-retryable 400 `provider.invalid-request`, one host attempt: `failure.retriedByHost=false`) or `.interrupted` (after `client.session.interrupt({sessionID})` returned `{interrupted: true}`). `context({sessionID: child})` returned `user, assistant, idle`; the last message is `{type: "idle", outcome}`. The OK child's final text is in the last `assistant` message (`perChild.C7_OK.context.finalTexts=["CHILD_OK"]`, `finalTextPaths=["$.content[0].text"]`). The failed child's `assistant` carries `error {type: "provider.invalid-request", status: 400}`; the interrupted child's carries `error {type: "aborted", message: "Step interrupted"}`. The parent stored three completions with states `error, cancelled, completed`. | none | `C7/D2`, `C7/O1` (smoke ≈1685-1694) |
| C8 | `client.session.background({sessionID: parent})` moved a running foreground `subagent` call to the background (`background.attempts[0].ok=true`). Its `execute.after` then reported `resultStatus="running"` before the child ended (`background.afterBeforeChildEnd=true`), with the same shape as C1 apart from ids (`comparisonWithC1Ack.sameShapeModuloIds=true`). | `background.executeAfter.afterMs` 22 \| 12 \| 12 | `C8/D2` (smoke ≈1698-1700) |
| C9 | Tools advertised in the fixture include: `read {path, offset, limit}`, `write {path, content}`, `edit {path, oldString, newString, replaceAll}`, `glob {pattern, path, hidden, limit}`, `grep {pattern, path, include, literal, caseSensitive, limit}`, `subagent {agent, description, prompt, model, sessionID, background}`, `shell {command, workdir, timeout, background}`, `execute {code}`. `execute.before` received exactly `read {path}`, `write {path, content}`, `edit {path, oldString, newString}`, `glob {path, pattern}` and `grep {path, pattern}`. `list` and `router_run` are not advertised in the fixture, so their argument keys are **unobserved** (`perTool.list.advertised=false`, `perTool.list.executeBefore.inputKeysUnobserved=true`; the same for `router_run`). `multiedit`, `patch` and `apply_patch` are not advertised. `execute.after` could rewrite `glob` and `grep` results (`filter.mutable=true`, `removedLines=1`; the full pre-filter text held the leased line: `filter.sawLeasedFull=true`). The request that carried each result, selected by `tool_use_id`, shows the model got the rewritten text (`modelSaw.containsLeased=false`, `containsHiddenNote=true`). | none | `C9/D7`, `C9/O9` (smoke ≈1709-1725) |
| C10 | **429 or 529, once:** one `session.retry.scheduled` (`attempt=2`; `error` keys `type, message, status, response`; 429 → `type="provider.rate-limit"`, 529 → `type="provider.internal"`), then `session.execution.succeeded`, with no `session.step.failed`. The `session.step.started` before the retry has data keys `sessionID, assistantMessageID, agent, model, started` and `model.providerID="anthropic"` (`stepStartedBeforeRetry`). The next step started ≈2.0 s after the fault for the 429 (`retry-after: 2`) and for the 529 (no `retry-after`), and ≈10.0 s after it for the control 429 (`retry-after: 10`) (run 1 `hostEvents` timestamps). **429 or 529, persistent:** retries kept coming (`attempt` 2, 3, …) with no `session.step.failed` and no terminal event within the 75 s window; then the harness cleared the faults and interrupted the root. **Usage limit:** every answer whose message says "usage limit" got no retry, then `session.step.failed` and `session.execution.failed` with `error={type: "provider.quota", status: 429, message, response: {body}}`. The answers were: `Usage limit reached. Your limit will reset at <ISO>.`; `Usage limit reached.` with only `anthropic-ratelimit-unified-reset`; `Usage limit reached.` with only `retry-after`; and `You have reached your usage limit` with every header. The control (every usage-limit header, per-minute rate-limit wording) was classified `provider.rate-limit`, retried, and succeeded. `response` holds only `body`: no header reaches the error, and the reset instant can be recovered only when the message text carries it (`resetRecoverable.inMessage=true` for the reset sentence only). **Retry hook:** `session.hook("retry")` is called with `{sessionID, agent, model, error, attempt, decision}`. For a 429 it receives `decision={retry: true, delay}`; for a usage limit, `decision={retry: false}`. A hook that set `decision.retry=false` on attempt 2 of a persistent 429 made the host emit `session.step.failed {type: "provider.rate-limit", status: 429}` and `session.execution.failed` after one request (`retryStopBranch.branch="stops"`). | persistent 429 retries in the window 9 \| 9 \| 10; persistent 529 10 \| 9 \| 9; retry-hook `delay` for the single 429 2399 \| 2167 \| 2365 ms | `C10/D13` (smoke ≈1732-1777) |
| C11 | The model wrote `prompt: "C11 original prompt"`, and `execute.before` appended ` CPX_MUTATED`. The child received the changed prompt (`child.receivedMutated=true`). The parent's later provider requests and its stored history kept the original arguments (`parentWire[1,2].toolUses[0].mutated=false`). The `model` argument has the shape `anthropic/claude-sonnet-5-5#low`. | none | `C11/D4` (smoke ≈1782-1784) |
| C12 | Child A ended and its completion was stored before `restart()` (`timing.aTerminalBeforeRestart=true`, `aEnvelopeStoredBeforeRestart=true`). In every run the parent was woken for A **before** the restart (`parent.wokeBeforeRestart=true`, `wokeAfterRestart=false`; in run 1 the wake request arrived 29 ms before the kill). A's completion was stored once and delivered to the model once across the restart (`parent.aEnvelopesStored=1`, `aWireDeliveries=1`). Child B was in flight at the kill. Afterwards it had no terminal event, was inactive, and its context held only the `user` message (`perChild.C12_B.terminal=null`, `active=false`, `context.roles=["user"]`); the parent got no completion for it. `restart()` kills and relaunches in one call, so the downtime itself is not exercised. | `timing.restartMs` 5247 \| 3273 \| 5878; `before.heldAt[0].index` 1 \| 2 \| 2; root lines after the restart 1 \| 0 \| 1 (`session.execution.succeeded`) | `C12/D16`, `C12/D2` (smoke ≈1791-1797) |
| C13 | 6, then 8, background children were all acknowledged `running` and all waited at the provider at once (`concurrency.n6.peakWaiting=6`, `concurrency.n8.peakWaiting=8`); all succeeded. **Idle-root interrupt:** `{interrupted: false}`; the 3 background children kept running and succeeded. **Active root with 3 foreground children:** `{interrupted: true}`; all 3 ended `session.execution.interrupted`, and the root logged `session.step.failed {type: "aborted"}` and `session.execution.interrupted`. **Active root with 3 background children (O4a):** `{interrupted: true}`; the children stayed active and ended `session.execution.succeeded`. | after the idle-root interrupt the root started a new execution in runs 1 and 3 (consistent with the C2 completion wake) and none was recorded in run 2 (`parentInterrupt.background.rootLinesAfterInterrupt.length` 3 \| 0 \| 2) | `C13/D13`, `C13/D14`, `C13/O4a` (smoke ≈1803-1816) |
| C14 | **Router enforced.** A plugin tool's execute context (`sessionID, agent, messageID, id, progress, signal`) was captured in a root turn that then ended. With that context, the probe launched 8 children through the native `subagent` (`ctx.tool.list()`, `background: false`, `agent: "cpx-child"`, `model: "anthropic/claude-sonnet-5-5#low"`), passing its own `signal` and a `progress` that only records (`launchContext.signalReplaced=true`, `progressReplaced=true`). Batch 1 launched right after the turn, batch 2 60 s later. All 16 returned `status: "completed"` with `output: "CHILD_OK"`, and no batch had errors. In batch 1, all 8 first requests waited at the provider at once (`concurrency.peakWaiting=8`, `parkedSessions=8`, parked by gates, not by a timer). `progress` carried each child's session id (`launches[*].childrenSeen.length=8`). **Every child:** ran as `cpx-child`, with wire model `claude-sonnet-5-5` and catalog model `anthropic/claude-sonnet-5-5#low` (`childContract[*]`); its first context hook ran before its first tool call (`hooksForChildren.perChild[*].firstContextBeforeFirstTool=true`, first context `messageCount=1`); its `read` passed `execute.before`; and the router refused 5 of its 6 identical reads (`routerRefusals=5`, `DENIED: you already ran this exact read …`). A control host without the router (3 children) showed 0 refusals, and all 6 reads succeeded (`control.children[*]`). The parent's history did not change (`parentHistory.unchangedAcrossLaunches=true`), and all 16 children are listed under the root. No `subagent` hook fired on the root (`subagentHooksOnRootAfterCapture=0`), and no child has a router decision row (`perChild[*].routerDecisionRows=0`). **Recorded, not pinned:** a third host launched 3 children with the retained `signal` itself (`retainedSignal.batchLine.signalReplaced=false`, `retainedSignalAbortedAtLaunch=false`); all completed and met the refusal (`retainedSignal.children[*].routerRefusals=5`). No host used the retained `progress`. | the order in which children arrived and finished | `C14/D14`, `C14/O3` (smoke ≈1823-1841) |
| C14b | **Router loaded, enforcement off.** 3 retained-context children were held at the provider, and a new root turn was held too. Interrupting the root returned `{interrupted: true}`. The 3 children stayed active (`afterInterrupt.activeChildren=3`); every launch returned `ok` with `status: "completed"`, and every child ended `session.execution.succeeded`. The root logged `session.step.failed {type: "aborted"}` and `session.execution.interrupted`. The launches used the probe's own `signal`. | none | `C14b/O4b` (smoke ≈1845-1849) |
| C15 | `client.session.compact({sessionID})` returned `{type: "compaction", delivery: "steer"}`. The compaction hook received the older turns only. Of 6 stored messages (2 turns) it got the first turn's `user` and `assistant`. The latest turn was not in the hook (`compactionWindow.storedIdsNotInHook`); it reappears as the record's `recent` text (`stored.summaryLike[0].recent="[User]: C15 second note …"`). The hook replaced the held text (`hook.rewriteLines[0].did=true`, `replacements=1`). The compaction request carried the placeholder at `$.messages[0].content[0].text` and not the original, and the record ended `status="completed"`. Before compaction, stored history held the original and no placeholder. Afterwards `session.context` returns only the compacted view, while `session.export` still holds the original and no placeholder (`fullLog.anyApiReturnsPreCompaction=true`). **Real completion:** a real background child's `<subagent …>` completion sat in an older turn. The hook saw it among 8 messages (roles `user, assistant, user, assistant, tool, assistant, user, assistant`) and replaced it. The compaction request carried the placeholder at `$.messages[6].content[0].text` and no envelope (`realCompletion.requestHasEnvelope=false`), and the compaction completed. No context-hook call was observed after that compaction (`realCompletion.contextHookCallsAfterCompact=0`). | none | `C15/D3`, `C15/O5` (smoke ≈1853-1869) |
| C16 | The probe plugin's `process.pid` equalled `client.server.info().pid` (`probePid=serverPid=50840`). With a child held mid-response at the provider, the restart killed only that pid (`taskkill /PID … /F`, no `/T`; `treeKill=false`, `killedPid=serverPid`). The held child's provider connection closed before the relaunch (`childClosed=true`). After the relaunch the probe loaded in a new process; the child had no terminal event, was not in `session.active()`, and its stored context was unchanged with only its `user` message. 8 of 8 decided-branch checks passed on host 2.0.26 (one run, 2026-10-15). **Extension (R2-1, same day):** two background children each ran a probe tool that spawned a heartbeat process with the product's `spawnBounded` options (direct and through an npm script tree), and a second root ran a host `shell` heartbeat. Each tool saw its own open stored call before spawning. After the server-pid-only kill and relaunch, both tool children had no terminal event and were not active, and their exact tool calls stayed `running`/`pending` in the stored history on two reads; the product's `historyToolInFlight` returned true for them and false for the provider-held control child; the host `shell` call also stayed open. 15 of 15 checks passed. Process fate is recorded as O16. | none | `C16/D16`, `C16/O16` (smoke ≈2190-2440) |
| O6 | `client.session.synthetic({sessionID, text, description, metadata, resume})` was called on an idle parent. With `resume: false` it was accepted (stored as `synthetic`; result `delivery: "steer"`) and produced no new provider request. With `resume: true` it woke the parent: a new request whose last message is a `user` text block, carrying the text, with the host's automatic `cache_control`. | none | `O6/D15` (smoke ≈1883-1885) |
| O6b | **From the plugin.** `ctx.session` lists `hook, create, get, remove, switchAgent, switchModel, prompt, generate, command, compact, synthetic, interrupt, update, move, wait, context`. `ctx.session.context({sessionID})` returned the session's 8 messages. `ctx.session.interrupt({sessionID})` on a held running child returned `{interrupted: true}`, and the child ended `session.execution.interrupted`. `ctx.session.synthetic({…, resume: true})` on the idle parent woke it (a new provider request carrying the text), and the text was stored. `resume: false` was not exercised from the plugin. | none | `O6b/D15` (smoke ≈1875-1879) |

## Decision

### Host contracts: branch taken

| Id | Outcome | Branch implemented | Pinned by |
|---|---|---|---|
| C1 | holds | Register the dispatch as in flight in `execute.after`, keyed by the result's `sessionID`. A dispatch is background when its result's `metadata.status` is `"running"`. | `C1/D1`, `C1/D2` |
| C2 | holds | The host's completion triggers the processor (D2); the router posts no completion of its own. | `C2/D2` |
| C3 | holds | No undelivered set and no re-post. | `C3/D2` |
| C4 | holds | D3 held placeholder in the context hook. | `C4/D3` |
| C5 | holds (`user` tail) | D4: the tail is a new last `user` message, and the last real message gets a manual `cache` hint, so the host's only message breakpoint sits on real history. | `C5/D4`, `C5/D4/O8` |
| C6 | holds on the wire, but not usable | D5 is withdrawn on v2.0.26 (QA-0.1-17): the `tools` breakpoint keeps its 5-minute TTL, so no 1-hour hint is emitted. No `routing.promptCache.ttl` key. | `C6/D5` |
| C7 | holds | The processor triggers on the child's terminal event. Recovery reads `context({sessionID: child})`: the last message is `{type: "idle", outcome}`, and the result text is in the last `assistant` message. | `C7/D2`, `C7/O1` |
| C8 | holds | Covered through C1. | `C8/D2` |
| C9 | holds for the advertised file tools | Leases are enforced in the tool hooks, and search filtering is available. Argument keys per D7. | `C9/D7`, `C9/O9` |
| C10 | holds, on different events | D13 signals come from event fields. 429/529 → `session.retry.scheduled`; usage limit → `session.step.failed` `provider.quota`. The reset instant comes only from message text. For plan children, the retry hook stops host retries; that stop and the quota retry-hook calls are capacity signals (QA-0.1-27). | `C10/D13` |
| C11 | holds | Launcher A is the only launcher. Stays pinned because today's `execute.before` changes to `subagent` arguments must stay out of the parent's history (cache stability). | `C11/D4` |
| C12 | does not hold for a child in flight | D16 fallback: recovery reads state and result through C7 and re-queues a lost child without counting an attempt. Processing dedupes against the persisted store. | `C12/D16`, `C12/D2` |
| C16 | holds: children run in the server process, a server-pid-only kill ends them, and an executing tool stays open in the stored history across the relaunch; processes below the server's direct children outlive the kill (O16) | D16: a `running` child whose recorded launcher process is provably dead on this host and whose history shows no tool in flight is inactive and requeued at once; otherwise the 60 s probation applies. | `C16/D16`, `C16/O16` |
| C13 | holds for 6 and 8 background children; an interrupt kills only foreground children | `maxParallel` valid range 1–8. | `C13/D13`, `C13/D14`, `C13/O4a` |
| C14 | holds (validity proven for 60 s) | **Launcher A.** | `C14/D14`, `C14/O3`, `C14b/O4b` |
| C15 | holds | The D3 placeholder is also applied in the compaction hook. The matcher also replaces completions embedded in text (O13). | `C15/D3`, `C15/O5` |
| O6 | resolved | D3 verdict delivery and D15 wakes use `synthetic` with `resume: true`, called from the plugin. | `O6/D15`, `O6b/D15` |

### D1 — Background-first dispatch

**Decision.** `routing.background.mode` defaults to `auto`.

- An explicit `background` value from the model is honored.
- When the model leaves it unset, the dispatch runs in the background if any of these holds:
  - the estimate has `n ≥ minSamples` and p50 ≥ `routing.background.minPredictedMs` (default 45000);
  - the acceptance block has `testsPass` or `buildPasses`;
  - it is a plan task.
- An estimate whose `source` is `"prior"` never selects background by itself.
- `off` reproduces today's `nativeArgs` exactly: `background: false` only for verifying or routed role calls; otherwise
  the caller's value passes through and no key is added.

**What the contracts change.**

- C4 and C15 hold, so required verification may run in the background, with its result held (D3).
- A dispatch counts as background when its **result** reports `metadata.status: "running"`, not when its arguments say
  `background`. In C1 the hook's own `status` is `"completed"` while the result says `"running"`. A call moved with
  `client.session.background` reports the same running result (C8).
- An interrupt of an active orchestrator turn interrupts its foreground children (`C13/D14`) but not its background
  children (`C13/O4a`). Background-first therefore also keeps long delegations alive across an orchestrator interrupt.
  Stopping them is explicit: D2 tracks every in-flight child, and `client.session.interrupt` /
  `ctx.session.interrupt` stop one (C7, O6b).

**Rationale.** P1 and P2 force every routed dispatch to the foreground, and the owner backgrounds by hand. A background
acknowledgement returns in 36–55 ms (`C1 ack.returnedMs`). D2 applies every guarantee at completion, so a background
dispatch loses nothing. Short dispatches stay in the foreground, so they cost no extra wake-up turn.

**Alternatives rejected.**

- Background for everything: every short call would add a wake-up turn and a cache write for the completion message.
- Leave the choice to the model: the model rarely chooses it, and today the user's choice drops the guarantees (P3).
- Run required verification in the background with no holding: the model would act on output that is not yet
  verified.

### D2 — Guarantees at completion

**Decision.** A completion processor keyed by child session id runs everything that today's `execute.after` does for a
finished dispatch: budget and authority signals, deferred-verification registration, change-set capture at child end,
verification enqueue, and timing. It runs exactly once per child attempt. It is triggered by whichever of these comes
first:

- the child's `session.execution.succeeded|failed|interrupted` event, which carries the child's session id (C7);
- the host's completion message seen in the parent's context (C2);
- for a plan child launched by launcher A, the runner's awaited result (D14).

Annotations:

- **Foreground** dispatches keep today's in-result annotation in `execute.after`. The end-event trigger is suppressed
  while that call's `execute.after` is pending, so `off` and foreground output stay byte-identical.
- **Background** dispatches get their annotations (budget, authority, depth banner, verification handle) in the
  "completed" section of the turn-state tail, on every request of the parent's next turn. When the context hook builds
  the first request after a completion, it waits up to 2000 ms for `settled(child)`. If the child is not settled by
  then, the section says "router guarantees pending" and the annotation appears in the next request.
- Past messages are never rewritten for annotations, and nothing is appended to history for them.

**What the contracts change.**

- **C2 holds.** The host completion is stored as a synthetic message (`metadata.source: "subagent"`). In the context
  hook it is a `user` message whose text starts with `<subagent sessionID="<child>" state="completed|error|cancelled"
  description="…">`. Outcomes map to states as succeeded → `completed`, failed → `error`, interrupted → `cancelled`
  (`C7/D2`).
- **C3 holds.** A completion that arrives mid-turn is delivered and stored, so the processor keeps no undelivered set
  and never re-posts.
- **C8 holds.** A call the user moves to the background gives the same running acknowledgement, so it is processed in
  the same way (fixes P3).
- **Launcher A children produce no completion in the parent** (`C14/D14`: parent history unchanged). Their triggers are
  the runner's awaited result and the child's end event.
- **Dedupe.** The host delivered C12 child A's completion exactly once, and did not deliver it again after the restart
  (`C12/D2`). Exactly-once processing still needs persistence: the processor's state lives in plugin memory, and after a
  restart, recovery (D16) re-reads children from the host, including children the router processed before the kill.
  The processor therefore dedupes against the persisted pending store (P5) and the ledger, not only against memory.

**Rationale.** `execute.after` of a background call runs at the acknowledgement, before the child has done anything
(P3). The only points where the results exist are the child's end and the host's completion.

**Alternatives rejected.**

- Annotate in `execute.after`: there is nothing to annotate at that point.
- Rewrite the host completion to add annotations: annotation text changes, so the message bytes would change and the
  cached prefix would break.
- Append history entries: history grows, the annotations become permanent, and each completion adds a cache write.

### D3 — Held results (enabled: C4 and C15 hold)

**Decision.** For a background dispatch under required verification, the host completion is rewritten to a fixed
placeholder, `held — verdict pending (vrf_…)`, for the life of the session.

- The rewrite happens on every request, because history keeps the original (`C4/D3`). It runs in the parent's context
  hook and in the session's compaction hook (`C15/D3`).
- **Matcher.** The held child's element `<subagent sessionID="<id>" …>…</subagent>` is replaced wherever it occurs
  inside a text part. That covers a whole completion message (C4, C15) and text that embeds it, such as the compaction
  record's retained latest turn (O13). The opening tag must carry the held child's session id.
- The placeholder never changes, so the prefix stays byte-stable.
- On the verdict, a new synthetic entry delivers the output with the verdict (PASS) or the findings (FAIL). It is posted
  from the plugin with `ctx.session.synthetic({sessionID, text, description, metadata, resume: true})`, which wakes an
  idle parent once (`O6b/D15`).
- A `subagent` call that resumes a held child is refused in `execute.before` until the verdict. Resume uses the
  `sessionID` argument, which the host's `subagent` tool advertises (C9).
- Plan tasks never need holding: the executor consumes their output, and integration requires a PASS.

**What the contracts change.**

- Held results are possible, so D1 may background required verification.
- The compaction request covers the older turns only. The latest turn is excluded and carried into the compaction
  record as `recent` text (C15 `compactionWindow`). A held completion in older turns is replaced in the compaction hook
  (`C15/D3`). The fate of one in the latest turn is open (O13); the substring matcher above is the conservative
  branch.
- Delivery of the verdict entry to a **busy** parent is unobserved: the result says `delivery: "steer"`, and C3 shows
  that a host completion reaching a busy parent is delivered. The Phase 2.1 smoke asserts it.

**Rationale.** Required verification can run in parallel without the model reading output that is not yet verified.

**Alternatives rejected.**

- Keep required verification in the foreground (the C4 fallback): this loses the parallelism.
- Deliver the output marked "unverified": models act on it anyway.
- Delay the host's completion: the host offers no API for it.

### D4 — Cache-stable turn state

**Decision.**

- On v2, one builder renders all per-turn router state into a tail: in-flight dispatches, held results, pending
  verdicts, unread late notices (kept until `router_verify` reads them), the advise hint, plan state (including the
  stale-launch-context line of D14) and the inbox. Root sessions only.
- The tail is regenerated on every request and never persisted.
- **Placement (C5).** The v2 context hook appends the tail as a **new last message with role `user`**.
- **Breakpoint hint.** In the same hook, the router sets `cache: {type: "ephemeral"}` on a copy of the last text part
  of the **last real message**, which is the message that was last before the tail was appended. This is how the C5
  probe did it (`test/smoke/probe/cpx-probe-plugin.js` ≈206-212). Host message objects are not mutated, so no earlier
  message keeps a hint. The hint carries no TTL (D5 is withdrawn). The tail never carries a hint, and no other
  message part gets one.
- **Hint target (O12; QA-1.2-12, QA-1.2-16).** The hint goes on the last non-blank `text` part of the last real
  message; if that message has none, on its last `tool-result` or `media` part; if it has neither, no hint. It never
  goes on an earlier message. Observed on v2.0.26 (`cpx-cache-prefix` smoke): the `tool_result` block carries the
  marker. "Never on the tail" holds only while the host's four-marker budget is used: with a single system part or no
  tools, or when the router sets no hint, the host may mark the tail itself.
- With empty state, neither a tail nor a hint is added; the host's own breakpoint then sits on the last real message.
- The system prompt stays byte-stable. v1 keeps today's system-prompt path.

**What the contracts change.**

- All placements carry the tail without persisting it (`C5/D4`). A system-role message is folded by the host into the
  last user message as a `<system-update>` part, the same position as the newest-message placement. Only a separate
  `user` message keeps the last real message intact. That variant is pinned as the last message, with everything before
  it byte-identical (`C5/D4`, smoke ≈1656-1657).
- The host places exactly one message breakpoint per request, next to `$.system[0]`, `$.system[4]` and `$.tools[17]`.
  Without a hint it sits on the tail (`C5/D4/O8`, requests 1 and 2). A tail-only breakpoint would write the volatile
  tail into every cache entry, so no later request could read history beyond the previous breakpoint. With the hint on
  the last real message, the breakpoint sits there and not on the tail (`C5/D4/O8`). O8 is resolved.
- **Moving the hint between requests.** In request N the hint is on message *k*, the last real message then. In request
  N+1 it is on message *m* > *k*. Message *k*'s bytes differ between the two requests only by the `cache_control` object
  on its marked block (`C5 variants.userHint.prefix.messages.firstDiff`). Its text, the system and every other request
  field are identical (`systemIdentical=true`, `otherFieldsIdentical=true`). The content through message *k* is
  therefore unchanged; only the breakpoint marker moves. Whether the provider serves request N+1's prefix through
  message *k* from the entry request N wrote is a provider property. The provider documents this marker-on-latest-message
  pattern for multi-turn caching. A scripted front cannot measure it, so Phase 6.1 measures it as the orchestrator
  cache-read share (not as a gate; O11 is not applicable). The smoke asserts the C5 marker count (≤ 4, with exactly
  one message marker). The byte-identity check is asserted on the plain `user` variant; for the hinted variant the
  marker difference is recorded, not asserted (smoke ≈1658-1660).

**Rationale.** P4: each change in the system prompt invalidates the whole cached history. The hint keeps the tail
outside every cache entry.

**Alternatives rejected.**

- Keep the state in the system prompt (P4).
- A part on the newest message, or a system-role tail: the tail shares a message with real content, and that message's
  bytes change on the next request.
- A `user` tail without the hint: the only message breakpoint lands on the volatile tail (`C5/D4/O8`).
- Persisted synthetic messages: history grows, and stale state becomes permanent.

### D5 — Prompt-cache TTL (WITHDRAWN on OpenCode v2.0.26, QA-0.1-17)

**Decision.**

- D5 is withdrawn. There is no `routing.promptCache.ttl` key, no TTL hint, and the system array is never changed.
  Plan 1.2.3 and 1.2.5.b/c do not apply.
- O11 (the real-provider gate) is not applicable. The "or the first DF session" way of closing it is moot (QA-0.1-18).
- Reinstating D5 needs a host that lets plugins set the TTL of the tools breakpoint.

**Evidence (C6, `all` variant, v2.0.26).** The plugin's `CacheHint` `{type: "ephemeral", ttlSeconds: 3600}` reached the
wire as `ttl: "1h"` on `$.system[0]`, `$.system[4]` and the message block. `$.tools[17]` kept the host's default
5-minute marker, because the context event's `tools` has no cache field. The provider requires longer TTLs to precede
shorter ones in prefix order (tools → system → messages), so 1-hour system and message markers after a 5-minute tools
marker are invalid.

**What had been decided before the withdrawal (history, not in force).**

- `routing.promptCache.ttl` was `"auto" | "5m" | "1h"`, default `"auto"`.
  - `auto` resolved to `1h` while the session has background activity or a running plan, and to `5m` otherwise.
  - `1h` set `CacheHint` `cache: {type: "ephemeral", ttlSeconds: 3600}` on a copy of the **last system part** and on the **D4 hint part**.
- It was gated by O11: no TTL until the real provider accepted the layout.

**Deciding facts (C6).**

- The hint on the last system part reached the wire as `$.system[4].cache_control={type: "ephemeral", ttl: "1h"}`.
- The hint on the last text part of the last real message reached it as `$.messages[k].content[0].cache_control={type:
  "ephemeral", ttl: "1h"}`.
- Both held in both requests and in all three runs (`C6/D5`, smoke ≈1675-1677).
- The field is absent until the plugin creates it, and it is the plugin API's documented part field (smoke ≈1673-1674).

**Why it is withdrawn.** The host keeps its own 5-minute marker on `$.tools[17]`, and the plugin cannot change it. In
the provider's prefix order (tools → system → messages), that marker precedes any 1-hour marker the plugin can set. The
provider documents that longer-TTL entries must come before shorter ones, and the scripted front does not check this.

**Rationale (original, for reinstatement).** The orchestrator idles while background children run, often for longer than
the 5-minute lifetime. On wake-up, a 1-hour entry would spare the rewrite of the whole history.

**Alternatives rejected.**

- Request options instead of the part field: the part-level `CacheHint` is the plugin API's lever and reaches the wire.
- A 1-hour TTL on every session: idle sessions would pay the higher write price for nothing.
- Intercepting provider requests outside the plugin API: excluded by D20.

### D6 — Telemetry

**Decision.**

- Every dispatch's start, end, role, class, scope, tier, model, background flag and outcome
  (`succeeded | failed | interrupted | unknown`) goes to `timings.jsonl`.
- Every orchestrator turn's input, cache-read and cache-write tokens go to `turns.jsonl`.
- Both files live in the outcome store.
- A timing row also carries `capacity`: `rate-limit`, `overload`, `usage-limit` or `null`. It is the last capacity class
  the child met before its end, taken from D13's event fields.
- An estimator gives p50/p90 per (role, class, scope), falling back to (role, class), then role, then a prior of
  480000 ms. Rows whose `capacity` is not `null` are excluded, because their duration measures the host's backoff, not
  the work.
- The age of the retained context at each launcher A launch is an executor `metric` event (plan Appendix D), not a
  timing field (D14 guard 4).

**What the contracts change.** The classes come from event fields:

- `provider.rate-limit` → rate-limit;
- `provider.internal` with status 529 → overload;
- `provider.quota` → usage-limit;
- an unknown type is classified by status: 429 → rate-limit, 529 → overload.

The host's retry delays follow the provider's answer (≈2 s for `retry-after: 2`, ≈10 s for `retry-after: 10`; C10), so
such a dispatch is not a sample of its own work.

**Rationale.** P6. D1 and D12 need measured durations, and §5 measures the cache-read share.

**Alternatives rejected.**

- Durations estimated by the model: not reliable.
- In-memory statistics: lost on restart.
- Capacity classes as `outcome` values: they would mix up "how it ended" and "what slowed it down".

### D7 — File leases (C9 holds: enforced in the tool hooks)

**Decision.**

- Only child (delegated) sessions take leases. On first write a child takes an exclusive lease on the file, keyed by
  checkout (work tree) and normalized repo-relative path.
- **Amendment (DF-1.1-4, 2026-10-13).** Repository-wide keys apply to plan-task holders only. A plan child (its
  binding has `plan`; lease scope `until-integrated`) also conflicts with another plan task's lease on the same
  repo-relative path in any linked worktree of the repository, because the tasks of a plan are integrated into one
  branch. The rule is cross-plan on purpose: it refuses a task of ANY plan on that repository, not only of the same
  plan, since plans on one repository may share a base branch and the runtime runs one active plan per process
  anyway (A-3.1-1). Any other holder is keyed per checkout: two child sessions that edit the same repo-relative path
  in two linked worktrees of one repository do not refuse each other. Within one checkout every writer still
  conflicts, whatever its kind. A write whose target is unknown is refused while another owner holds a lease in the
  same checkout and, for a plan child, also while another plan task holds a lease in any worktree of the repository.
  The original key (repository and repo-relative path for every holder) refused an implementer in one worktree
  because an implementer in another worktree of the same repository held its own copy of that file.
- Consequence (QA-PDF13-5): a root session or a plain child in the plan's home checkout may edit a path that a plan
  task holds in its slot; the old repository-wide key refused that edit. Integration stays safe because landing
  refuses a dirty home checkout (`src/executor/integrate/land.ts` ≈100-104).
- Implementation: the v2 adapter's `repoKeyOf` seam names the checkout as `repo` and the common git directory as
  `shared` (`src/compat/v2-hooks.ts`, `leaseRepoKeyOf`). The registry keeps `shared` in its snapshot and re-keys a
  line from an older snapshot (no `shared`) to its checkout on restore; a clash on a re-keyed key is merged (same
  owner) or skipped (a holder that is dropped anyway), never fatal. 5.1 wires the executor's lease view
  (`LeaseRegistryPort.holderOf`) to the repository-wide query `LeaseRegistry.planHolderOf(<plan toplevel>, path)`,
  because the logical key alone matches one checkout. A refusal names the file under edit (the holder's copy) and
  asks for the requester's own path in `NEED MORE: lease`, repo-relative for a plan task.
- A root session takes no leases. Its writes are refused only while a child holds that file.
- Lease ownership is the task (`taskRef`), not the session.
- While a child holds a write lease in a working tree, another **child** session in the same tree is affected as
  follows (root sessions are never refused reads, searches or runs; Phase 1.3):
  - a **read** of that file is refused in `execute.before`, naming the holder;
  - a **directory search** omits leased files and adds a count, by rewriting the result in `execute.after`;
  - a **`router_run`** runs, and its result carries `[router] ran while <holder> edits <n> file(s); result may be
    contaminated` (it is refused instead when `routing.leases.run` is `"refuse"`);
  - a **plugin verification run** is deferred until the lease ends or its deadline passes, then runs with today's
    contamination caveat.
- A child's leases end at its execution end, its interrupt, or the 6 h sweep. Plan-task leases end at integration.
- Predicted footprints are scheduling hints; leases are the enforcement.

**What the contracts change: target arguments on v2.0.26.**

| Tool | Target arguments | Basis |
|---|---|---|
| `read`, `write`, `edit` | `path` | `C9/D7`: exact `execute.before` keys `{path}`, `{path, content}`, `{path, oldString, newString}` |
| `glob`, `grep` | `path` (search root) and `pattern` | `C9/D7`: exact keys `{path, pattern}` |
| `router_run` | `cwd` (with `script`, `args`) | The router's own tool schema (`src/router/run-tools.ts` ≈160, ≈882-885). It is registered in roles mode only (`src/index.ts` ≈1313-1317), so it was not advertised in the C9 fixture and its keys were not observed through the host. |
| `list`, `multiedit`, `patch`, `apply_patch` | unobserved | Not advertised by v2.0.26 in the fixture (`C9/D7`, `C9/O9`) |
| `router_git_blame`, `router_git_diff`, `router_git_log`, `router_git_ls_files`, `router_git_show`, `router_git_status` | `path` (a repository-relative path argument); `gitRoot` is required | Advertised by the host (QA-0.1-26). Working-tree reads are classified read (`router_git_blame` without a `ref`) or search (`router_git_diff` without a ref or with a single ref, `router_git_status`, `router_git_ls_files`); committed objects (`router_git_log`, `router_git_show`, blame at a ref, a cached or commit-to-commit diff) are class none. Paths are relative to the repository top level, so `gitRoot` (absolute) is required; without it the target is unknown and handled as an unextractable target. |
| `shell`, `execute` | not covered by leases | `shell {command, workdir, timeout, background}` and `execute {code}` are advertised (O9); leases do not apply to them |

- Search filtering is available: `glob` and `grep` results can be rewritten in `execute.after`, and the model receives
  the rewrite (`C9/D7`).
- `router_run` is a router tool, so it writes its own annotation; no host hook is needed.
- A call of a write-class tool whose target cannot be extracted is refused for a child session while another session
  holds a write lease in the same tree. Today's write class is `write`, `edit`, `multiedit`, `patch` and `apply_patch`
  (`src/compat/v2-hooks.ts` ≈387). This only matters if the host starts advertising an unobserved tool, which fails
  `C9/O9` first.

**Rationale.** P9: today the router only attributes changes after the fact.

**Alternatives rejected.**

- Leases for root sessions too: the orchestrator would block on the children it waits for.
- Advisory footprints only (P9).
- OS file locks: they do not separate sessions that run in one host process.
- Enforcement through `permission.hook("evaluate")` (the C9 fallback): it cannot filter searches.

### D8 — Ledger

**Decision.**

- The ledger lives under `<git common dir>\omr-executor\<planId>\`.
- It is a rotated journal plus an atomic snapshot, with a single-writer lock and a schema version.
- It fsyncs before any externally visible step.
- The ledger, not the conversation, is the source of truth.

**Rationale.** The targets require that a restart loses no completed work and integrates nothing twice. Conversations
are compacted and lost on restart.

**Alternatives rejected.**

- The conversation or the handover as state: lossy, and editable by the model.
- SQLite: a native dependency.
- One rewritten JSON file: torn writes on a crash.
- State inside a worktree: shows up in `git status` and is visible to children.

### D9 — Compiler

**Decision.** Compilation runs in four steps:

1. Deterministic extraction: waves, phases, task ids, subtasks, annotations, acceptance blocks, ownership tables,
   dependency blocks and phrases, file paths.
2. One architect dispatch for the residue, merged **monotonically**: it can only add edges and footprints.
3. Validation: the graph is acyclic, ids are known, paths are inside the repository, concurrency closure holds.
4. An estimate.

Unannotated tasks are classified by the routing engine.

**Rationale.** P7. Plans are written in prose, so pure parsing misses implicit dependencies.

**Alternatives rejected.**

- An LLM-only compiler: not deterministic, and a dropped edge creates a hazard.
- Deterministic-only extraction: misses dependencies stated in prose.
- An architect that may remove edges: unsafe.

### D10 — Isolation

**Decision.**

- Plan tasks run in a pool of git worktree slots on the repository's drive.
- Each slot has its own dependencies, installed once. Workspace links and editable installs would otherwise load
  another checkout's code (`src/verify/reference.ts` ≈71-78).
- Between tasks a slot is reset to the integration head; ignored dependency directories survive.
- A change to the dependency manifest re-provisions the slot.
- Integration checks and phase suites first remove every other ignored file.
- Slot markers live in the executor home.

**Rationale.** P8 and P9: parallel builds and tests in one tree contaminate each other.

**Alternatives rejected.**

- One shared tree protected by leases only.
- A shared `node_modules`.
- A fresh clone per task: time and disk cost.

### D11 — Integration queue

**Decision.**

- There is one serial queue per repository.
- A verified task is rebased onto the integration head in its slot, checked there, and the integration branch moves
  **fast-forward only**.
- A conflict re-queues the task with the conflict as context.
- Waiting tasks are checked in batches and bisected on failure.
- When a phase is fully integrated, its full suite runs on the integration commit. On failure the culprit is found by
  bisection; its revert is built and checked in a slot, fast-forwarded, and the task is reopened.

**Rationale.** The integration branch never points at a failed commit.

**Alternatives rejected.**

- Merge commits made by the children: non-linear history and red heads.
- Optimistic parallel merges: semantic conflicts are not caught.
- Integration without re-checking: the base may be stale.

### D12 — Scheduler

**Decision.** A task is ready when:

- its dependencies (including phase gates) are integrated or `done`;
- capacity is free;
- its predicted writes are not leased.

Priority is the bottom level (the longest remaining path by estimated duration). Ties go by plan order.

**Rationale.** Critical-path list scheduling targets makespan ≤ 1.3 × max(CP, W/p, ΣI).

**Alternatives rejected.**

- Plan-order FIFO: ignores the critical path.
- Shortest task first: starves long critical-path tasks.

### D13 — Adaptive capacity

**Decision.**

- Capacity is per provider, with additive increase and multiplicative decrease.
- It is capped by `routing.executor.maxParallel`, default 4 (subscription limits are unknown), with a **valid range of
  1–8**. Eight is the largest concurrency proven, both for background children (`C13/D13`: `n8.peakWaiting=8`) and for
  retained launches (`C14/O3`: `concurrency.peakWaiting=8`).
- An out-of-range value is handled by `resolveRouting` like any other range-validated key (plan §0.10-7).
- Raising the bound needs an ADR amendment backed by `smoke:cpx`.

**What the contracts change: signals come from event fields (C10).**

| Signal | Source | Identifying fields |
|---|---|---|
| Rate limit | `session.hook("retry")` call or `session.retry.scheduled`, whichever comes first per (session, attempt) | `error.type = "provider.rate-limit"`, `error.status = 429`, `attempt` |
| Overload | the same | `error.type = "provider.internal"`, `error.status = 529` |
| Usage limit | `session.step.failed`, then `session.execution.failed` | `error.type = "provider.quota"`, `error.status = 429` |

- **Provider.** The provider is `data.model.providerID` of the same session's preceding `session.step.started` (pinned
  `C10/D13`, smoke ≈1737).
- **Decrease.** The decrease is applied on the **first retry signal of a step**. The host retries 429 and 529 itself,
  and a persistent fault produced no `session.step.failed` and no terminal event within the 75 s window. Nothing is
  claimed beyond that window, and nothing relies on the host giving up on its own.
- **Unknown types.** An unknown `error.type` with status 429 or 529 is classified by its status.
- **Classification.** `error.type` decides; the body never does. In C10 the host said `provider.quota` for every answer
  whose message mentions a usage limit, with or without a reset sentence or headers. It said `provider.rate-limit` for
  the control, which has the same headers and per-minute wording. The provider body type is `rate_limit_error` in every
  case.
- **Usage-limit pause.** A usage limit pauses the provider and raises one inbox item. The pause lasts until the first
  ISO-8601 instant in `error.message`
  (`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})`), if that instant lies in the future; otherwise
  it lasts `capacityPauseMs`. Response headers never reach the error (`response` holds only `body`). The pattern is
  deliberately not tied to the test's own sentence.
- **Stopping host retries (plan children only).** The router's `session.hook("retry")` handler sets
  `decision.retry = false` for a plan-task child when its provider is paused, or when that step's first retry signal is
  older than `capacityCooldownMs`. The host then fails the step: `session.step.failed` with the provider error, then
  `session.execution.failed` (`C10/D13` `retry-stop`, smoke ≈1777). The executor knows the stop is its own, so the
  attempt ends with outcome `capacity` and the task returns to `ready`. For every other session (the orchestrator and
  user dispatches) the handler only observes and leaves `decision` unchanged.
- **Capacity signals (QA-0.1-27).** The router's own retry-hook stop and its quota retry-hook calls are capacity
  signals, like the event fields in the table above.
- **Attempt counting (QA-0.1-20).** An execution failure with error type `provider.quota` (usage limit), or a
  `provider.rate-limit` failure or a `provider.internal` failure with status 529 (overload) ended by the host (for
  example after the router's retry hook stopped retries), closes the attempt with outcome `capacity`. A
  `provider.internal` failure with any other status is not capacity: the attempt is `failed` and counted
  (QA-0.1-30). A capacity attempt is not counted toward `maxAttempts` and is
  excluded from the circuit breaker. A lost child closes its in-flight attempt as `lost`, also uncounted. Rate-limit,
  overload and usage-limit outcomes never count as failed attempts.
- **Asserted facts (QA-0.1-23, -24).** The smoke asserts, for C10: persistent 429 and 529 produce no
  `session.step.failed` and no terminal event within 75 s; the usage-limit retry hook receives `{retry: false}`;
  response headers never reach the error, while `response.body` holds the provider's error JSON, so the reset time
  is readable from the message and from the body text. Retry delays for persistent faults are recorded, not asserted
  (observed 2.4–12 s despite `retry-after: 2`).

**Rationale.** Limits are unknown and shared with the owner's other sessions (§0.6-11). A plan child stuck in host
retries holds a slot forever unless the router can end it.

**Alternatives rejected.**

- Fixed concurrency: 429 storms or idle capacity.
- Waiting for `session.step.failed` on 429/529: it did not arrive within 75 s.
- Text patterns for classification: the host already classifies, and `error.type` is the field.
- Stopping host retries for every session: it would change today's behaviour for the orchestrator and user dispatches.
- Reading the reset time from headers: the host does not surface them.

### D14 — Launcher (C14 holds: launcher A)

**Decision.** The executor launches plan tasks itself through the router's child runner (`src/compat/v2-client.ts`
≈96-236). No orchestrator turn is spent per task. Launcher A is the only launcher.

- **Mechanism.** The runner calls the native `subagent` tool, found through `ctx.tool.list()`, with the context
  retained from the bound orchestrator's latest router tool call.
- **Launch mode.** Launches are **awaited**, with `background: false`, and the completion is the runner's result. A
  background launch would make the host inject a `<subagent>` completion into the orchestrator session and wake it
  (C2), which is the per-task turn launcher A exists to avoid.

**Deciding facts (C14, router enforced).**

- All 16 launches completed: 8 right after the capturing turn and 8 60 s later, all with `status: "completed"` and the
  child's output (`C14/D14`, smoke ≈1823).
- All 8 of batch 1 waited at the provider at once (`C14/O3`).
- Every child ran with the requested agent and model (`C14/D14`, smoke ≈1836-1837).
- Every child's first context hook ran before its first tool call (smoke ≈1830).
- The router's guards applied to every child; the no-router control shows the refusals are the router's (smoke
  ≈1839-1840).
- The parent's history got nothing (smoke ≈1841).
- No `subagent` hook fired on the root, and no decision row was written (smoke ≈1827-1829).
- An interrupt of the orchestrator's active turn did not abort retained launches (`C14b/O4b`).

**Launch context.**

- The retained `{sessionID, agent, messageID, id}` is used.
- The launch passes an **executor-owned `signal`**: the runner's own `AbortController`, combined with the plugin
  lifetime. The retained call's `signal` is no longer used once that call has ended (`v2-client.ts` ≈112-119).
- The launch passes a **`progress` that records the child id** and is not forwarded to the ended call (`v2-client.ts`
  ≈173-208).
- Every pinned C14 and C14b check used exactly this configuration (`launchContext.signalReplaced=true`,
  `progressReplaced=true`; `cpx-probe-plugin.js` ≈493-511).
- A launch with the retained signal itself completed in the C14 signal host. That is recorded, not pinned, and it ran
  only right after the capture turn; the retained `progress` was never exercised. Launches never use the retained
  context's `signal` and never forward `progress` (QA-0.1-25): an orchestrator interrupt must not abort plan children.

**The executor does the dispatch-time work itself.** A retained launch fires no `subagent` hook. The executor therefore
calls, directly, the functions the `subagent` hook path uses:

- the routing decision;
- the decision row;
- the timing start (`recordDispatchStart`, D6);
- the in-flight registration for D2.

**Binding each child.**

- **Role:** `agent` = the task's role agent. It is honoured: every child ran as the non-default `cpx-child` (session
  record).
- **Tier:** `model` = `<providerID>/<modelID>#<variant>` resolved by the routing engine for the task's tier. It is
  honoured: wire model `claude-sonnet-5-5` and catalog model `anthropic/claude-sonnet-5-5#low` for every child.
- **Work root and grant:** written to the role binding table (`src/routing/roles/binding.ts`) in the runner's
  `onCreated(childID)`. The runner calls it from the native `subagent`'s `progress` callback, before the child is
  prompted (`v2-client.ts` ≈195-198, which also moves the child to the slot directory). In C14, every retained launch's
  `progress` carried the child's id (`launches[*].childrenSeen.length=8`).
- **Fail closed.** The child's first context hook runs before its first tool call (`C14/D14`). There, a child whose
  prompt carries a plan task header `[plan <planId>:<taskId>#<attempt>]` but has no binding is refused every tool call.
  The header goes after the shared plan-context block, so children of one role still share the provider cache.
- **Prompt order (QA-0.1-21).** The launched prompt is PLAN CONTEXT → launch header
  `[plan <planId>:<taskId>#<attempt>]` → TASK. The route line, `VERIFY` and the acceptance block are consumed by the
  executor and are not sent verbatim.
- From then on, guards, grants and leases apply to the child as to any child.

**Refreshing the retained context.**

- *Capture point:* the execute context of every **router tool** call made by the orchestrator session the plan is bound
  to. The runner already retains it (`withToolContext`, `v2-client.ts` ≈249-262). The newest capture replaces the
  retained one and is stamped with its time. Host tool calls are not a capture source.
- *Proven:* a context captured in a turn that then ended stays usable right after the turn and 60 s later, with the
  parent idle in between: 16 of 16 launches per run, in 3 runs.
- *Assumed, not proven (O7):* validity for hours, after later orchestrator turns, for a launch started while the
  orchestrator has an active turn, and after compaction. Launches already in flight survive an active-turn interrupt
  (O4b).
- *Never valid:* across a host restart, because the context lives in plugin memory.

**Guards Phase 3.1 must add.**

1. **Launch confirmation.** A launch is confirmed when `onCreated` receives the child id within 30 s.
2. **Stale context.** A launch that throws before confirmation, or is not confirmed in time, marks the context stale.
   The task returns to `ready` without counting an attempt (`Attempt.outcome = "lost"`), and nothing else launches with
   that context.
3. **Refresh wake.** When ready work and free capacity exist but no fresh context does, the executor wakes the
   orchestrator once through D15's channel. The plan line of the tail asks for `router_plan action=status`, and that
   router tool call refreshes the context.
4. **Recorded age.** Every launch records the context's age (D6). Phase 6.2.0 writes into this ADR the largest age at
   which a launch succeeded under DF-2. The ADR claims no validity beyond the recorded age.
5. **Unexpected interrupts.** A plan child that ends `session.execution.interrupted` without an executor cancel is lost
   and re-queued without counting an attempt. The executor cancels plan children itself, through its launch signal or
   `ctx.session.interrupt` (C7, O6b). An orchestrator interrupt does not cancel them (O4a, O4b).
6. **After a host restart (D16),** nothing launches until the orchestrator's first router tool call in the adopted
   session.

**Concurrency.** Eight retained launches waited at the provider at once (`C14/O3`), so launcher A uses the same 1–8
range as `maxParallel` (D13).

**Alternatives rejected.**

- Launcher B: one orchestrator turn per task means token cost, latency and idle-with-ready time.
- Background launches from the retained context: they inject completions into the orchestrator and wake it.
- Launching with the retained `signal` or `progress`: not pinned, and a `progress` sent to an ended call is rejected.
- `session.create`: listed by the host, but its semantics are unobserved (O14; D20).

### D15 — Unattended operation

**Decision.**

- Questions and exhausted tasks are parked in an inbox while independent branches continue.
- QA steps are plan tasks that return structured findings. The executor turns findings into fix tasks and re-review tasks
  (always [tier:heavy]) under the owner's bounded rounds:
  - findings of rounds 1 and 2 all produce fix tasks;
  - from round 3 on, only `blocking`, `critical` and `major` findings do;
  - after `executor.qaMaxRounds` rounds (default 3), the executor raises an inbox item.
- A circuit breaker pauses a phase on systemic failure.

**What the contracts change.** With launcher A, the orchestrator is woken only for:

- inbox items;
- a paused phase;
- plan completion;
- a `manual` or `preflight` task entering `ready` (once);
- a stale launch context (D14, guard 3).

There is no wake for ready work: launcher A launches it directly.

- **Channel.** Wakes are posted from the plugin with `ctx.session.synthetic({sessionID, text, description, metadata,
  resume: true})`. This wakes an idle parent (`O6b/D15`; also from the client, `O6/D15`).
- **Debounce.** Wakes are debounced by `wakeDebounceMs` and never sent twice for the same state.
- **`resume: false`** does not wake an idle parent (`O6/D15`) and is not used for wakes.

**Alternatives rejected.**

- Stopping for every question: the human becomes the scheduler again.
- An unbounded QA loop.
- Waking the orchestrator for every completion.

### D16 — Recovery (C12 does not hold for children in flight)

**Decision.** On plugin start, every running ledger of the repository whose `repo.toplevel` is the plugin session's
toplevel is reconciled with host evidence. Each child is classified from `ctx.session.context({sessionID: child})`
(C7; also pinned from the plugin, `O6b/D15`) and from its active state:

| Child state | Classification | Action |
|---|---|---|
| Last message `{type: "idle", outcome}` | finished | Processed once (D2 dedupe). The result text comes from the last `assistant` message of the child's context (roles `user, assistant, idle`; `C7/O1`), or else from the body of the parent's completion for that child. |
| Active | alive | Adopted, never re-dispatched. |
| Neither finished nor active | lost | Re-queued with a new attempt record of outcome `lost`, which does not count toward `maxAttempts`. |

- A half-done integration is completed or rolled back idempotently.
- `/plan adopt <planId>` rebinds a plan to a new orchestrator session.

**Deciding facts.**

- A child in flight during a host restart is neither finished nor active afterwards, and gets no completion (`C12/D16`).
  After a host restart, therefore, every child that was in flight is re-queued. That includes launcher A children,
  whose awaited launch dies with the plugin.
- A child that finished, with its completion stored, before the restart had that completion delivered once, before the
  restart, and not again afterwards (`C12/D2`).
- A completion stored but not yet delivered at the kill is unobserved (O10). D2's persisted dedupe covers both cases.
- *Amended 2026-10-15 (Phase 6.1, C16).* The plugin, and every child it launches through the native `subagent`, runs in
  the server process: the probe's `process.pid` equals `client.server.info().pid`. Killing only that pid (no process
  tree) closes the held child's provider connection before the relaunch; afterwards the child has no terminal event, is
  not in `session.active()`, and its stored context is unchanged (`C16/D16`, host 2.0.26). The host still exposes no
  plugin-readable "not running anywhere" signal, so the adapter's `activity` stays `unknown`. Instead, the executor
  records each child's launcher (`child-process` counter: pid, hostname, per-process token) when the child is created
  or adopted late, and recovery classifies a child as **inactive** (then lost, requeued at once, no probation) only
  when exactly one launcher record exists, it is on this host, and that process is provably gone (a dead foreign pid,
  or this pid with a different token). Every other case stays `unknown` and keeps the 60 s liveness probation.
- *Amended again 2026-10-15 (Phase 6.1, R2-1).* Processes a child's tool started can outlive the server: POSIX detached
  groups survive, and on Windows the job ends only the server's direct children (`C16/O16`), not a whole tool process
  tree. The dead-launcher fast path therefore applies only to a `running` child whose stored history shows **no tool
  call in flight**, on every platform. An executing tool stays open in the stored history across the relaunch
  (`C16/D16`); missing or unknown tool state is not proof it closed. A child stopped inside a tool and the `ready`
  adoptable row keep the 60 s liveness probation, even with a provably dead launcher. This narrows the preceding
  amendment; launcher identity, the probation timing and the lost-attempt requeue are unchanged.

**Alternatives rejected.**

- Re-dispatch everything not integrated: duplicate work and a risk of double integration.
- Trust the host to deliver completions after a restart: it does not for children in flight.
- Probe liveness with `session.interrupt` or `session.wait`: both reach only this process, and an interrupt stops a live
  child.
- Shorten the probation: a child in a live process with a stale heartbeat could then run twice.
- Windows-only gate: the job ends only direct children, so deeper tool processes can survive there too.
- Kill the launcher's process group: POSIX-only, and recycled process/group ids risk killing unrelated work.
- Relaunch in a fresh slot while quarantining the old one: quarantine would sit outside `maxParallel`.

### D17 — Gates

**Decision.** A phase's QA loop gates the next wave (`routing.executor.crossPhase`, default `gate`). With `inferred`, a
later task starts as soon as its own inferred dependencies are integrated.

**Alternatives rejected.**

- No gate: later waves build on code that has not been reviewed.
- Always inferred: QA fixes often touch files shared across phases.

### D18 — Trust

**Decision.**

- These keys are honored only from `tiers.json` and the global override, never from a project-local override:
  `executor.slotsDir`, `executor.provision`, `executor.python`, `executor.integrationChecks` and
  `executor.phaseSuite`. They execute commands or widen permissions.
- `slotsDir` must be absolute, on the repository's drive, not a drive root, neither inside nor an ancestor of the
  repository, and free of `*`.

**Alternative rejected.** Honoring these keys from a project-local override would let a cloned repository run commands
when it is opened.

### D19 — v1 inert

**Decision.** Nothing in this ADR changes v1 behaviour or output. Every registration is gated on `ctx.routerHost ===
"v2"`. On v1, a configured `routing.background.*`, `routing.leases.*` or `routing.executor.*`
key logs one notice per process (plan §0.10-8).

**Alternative rejected.** Porting to v1 violates the feature freeze (AGENTS.md, "Host support policy").

### D20 — Out of scope

**Decision.** These are out of scope:

- cross-repository plans (the ledger is keyed by repository so it can be extended later);
- a background mode for `router_run`;
- launching through `session.create`. The v2.0.26 client and plugin session API list it (O6b `sessionMethods`; C8
  `api.sessionMethods`), but its parent link, agent and model binding, hooks and completion delivery are unobserved
  (O14), and launcher A is proven;
- intercepting provider requests outside the plugin API.

**Alternative rejected.** Pulling them in widens the host surface without evidence from the contracts.

## Consequences for later phases

Each phase implements only the branch named here (plan §0.2).

| Topic | Phase | Branch implemented |
|---|---|---|
| C5/D4: tail and breakpoint hint | 1.2 | The tail is a new last `user` message, regenerated per request and never persisted. `cache: {type: "ephemeral"}` (no TTL; D5 is withdrawn) goes on a copy of the last non-blank text part of the last real message, else on its last `tool-result` or `media` part, else no hint (O12); children get no tail and no hint. `test/smoke/cpx-cache-prefix.smoke.test.ts` asserts: the message breakpoint is on the last real message and never on the tail; consecutive requests are identical through the previous request's last real message except for the moved `cache_control` object; the previous tail is absent. |
| C6/D5: TTL | 1.2 | Not applicable: D5 is withdrawn on v2.0.26 (QA-0.1-17). No `routing.promptCache.ttl` key, no TTL hint, and the system array is never changed. |
| C9/D7: leases | 1.3, 2.1 | Leases in the tool hooks: refusal in `execute.before`, rewriting of `glob`/`grep` results in `execute.after`. Argument keys per the D7 table (`router_run` from the router's own schema; `list`, `multiedit`, `patch`, `apply_patch` unobserved). Unextractable write-class targets are refused for children under a foreign lease. The host's `router_git_*` tools take a `path` argument and need `gitRoot`. Read, search and run restrictions apply to another child session only, never to a root session; ownership is the task (`taskRef`). `shell` and `execute` are documented as not covered by leases. |
| C10/D13: capacity | 1.1, 2.1, 3.1 | 1.1: timing row `capacity` and recorder `onCapacitySignal`. 2.1: `session.retry.scheduled` and `session.step.failed` feed it. 3.1: the controller (provider from the preceding `session.step.started`, quota pause with message instant or `capacityPauseMs`, by-status fallback) and the `session.hook("retry")` stop for plan children. |
| C11 | none | Pinned because the router's `execute.before` changes to `subagent` arguments must not enter the parent's history (cache stability). |
| C14/D14: launcher | 1.4, 3.1 | 1.4: `TaskLauncher` is launcher A only; `Attempt.outcome` gains `capacity`; `lost` and `capacity` attempts do not count toward `maxAttempts`. 3.1: awaited native `subagent` launches from the retained router-tool context with an executor-owned signal and a record-only progress; explicit agent, model, grant and work-root binding at `onCreated`; fail-closed check in the child's first context hook; decision row and timing start written by the executor; the six guards. Launcher A is the only launcher; there is no other launcher code or types. |
| C13/C14: concurrency | 1.4, 3.1, 4.1 | `maxParallel` default 4, valid range 1–8; per-provider capacity within it. |
| C4/C15/D3: held results | 2.1 | Held results are possible and built. The substring matcher runs in the context and compaction hooks. The verdict is posted with plugin `ctx.session.synthetic(…, resume: true)`. The Phase 2.1 smoke asserts a held completion in the latest turn at compaction (O13) and the verdict entry reaching a busy parent. |
| C12/C7/D16: recovery | 2.1, 4.2 | `ctx.session.context({sessionID: child})`: a last message `{type: "idle", outcome}` means finished, and the result comes from the last `assistant` message, else from the parent's completion body. A child neither finished nor active is re-queued as `lost`, not counted. Pending verifications are persisted (P5); processing dedupes against the persisted store. Cancellation uses `ctx.session.interrupt({sessionID})`. |
| C2/C3: trigger and re-post | 2.1 | Triggered by the host's completion in the parent's context hook or by the child's `session.execution.*` event, whichever comes first. No re-post, no undelivered set. |
| C8: user-backgrounded calls | 2.1 | Covered through C1: classified by result `metadata.status === "running"`, processed by D2. |
| C1: registration | 2.1 | Register the dispatch as in flight in `execute.after`, keyed by the child session id from the acknowledgement. |
| O6/O6b/D15: wake channel | 3.1, 4.2 | Plugin `ctx.session.synthetic({…, resume: true})`, debounced and once per state. |
| D6: telemetry | 1.1, 3.1 | The `capacity` field and its exclusion from estimates (1.1). The retained-context age as a runtime `metric` event (3.1). |

Phases 2.2, 2.3, 2.4 and 3.2 have no host-contract branch. All hooks are registered on v2 only, in
`src/compat/v2-hooks.ts`: 2.1 adds the context, compaction, tool and event wiring, and 3.1 adds the retry hook and the
launch wiring. Phase 5.1 assembles and registers the executor. Phase 6.1 produces the measurements that change this
ADR's status, and 6.2.0 records the retained-context age proven under DF-2.

## Open observations

Each open item keeps the conservative branch chosen above until its assertion is pinned in `smoke:cpx` (or, for O15 and
O11(b), recorded against the real provider).

**Recorded, not asserted (Phase 6.1):**

- **O16 — Processes outliving a server-pid-only kill (Windows, host 2.0.26, 2026-10-15).** A probe tool spawned with the
  product's `spawnBounded` options (non-detached on Windows) and a host `shell` command each started a heartbeat leaf.
  After killing only the server pid: the server's direct children died (the job), and so did the npm node, its
  `cmd.exe` and the host's `pwsh`; but the leaf below the npm tree and the leaf below the host shell stayed alive with
  their heartbeats advancing, and had to be killed in cleanup. Tool process trees therefore outlive the server; D16's
  fast path applies only when no tool call is in flight (`C16/O16`, `C16/D16`).

**Resolved and pinned (round 1):**

- **O1 — Child final text.** The final text is in the last `assistant` message of `context({sessionID: child})`
  (`C7/O1`).
- **O2 — 529 type.** It is `provider.internal` (`C10/D13`). The host's own retry limit is not relied on: there was no
  `session.step.failed` within 75 s, and D13 stops plan children's retries through the retry hook.
- **O3 — Retained concurrency.** 8 retained launches waited at the provider at once; they were parked by gates, not by a
  timer (`C14/O3`).
- **O4 — Interrupting an active root.** Background children survive it (O4a, `C13/O4a`), and retained-context launches
  return `completed` (O4b, `C14b/O4b`). O4b was observed with an executor-owned launch signal, the configuration D14
  prescribes.
- **O5 — Successful compaction with the placeholder.** Observed, including with a real completion (`C15/O5`,
  `C15/D3`); `session.export` keeps the original.
- **O6 — Synthetic wake.** From the client, `resume: false` does not wake and `resume: true` does (`O6/D15`). From the
  plugin, `resume: true` wakes, and `context` and `interrupt` work (`O6b/D15`). Plugin-side `resume: false` was not
  exercised; nothing here uses it.
- **O8 — Message breakpoint.** There is one message breakpoint per request, and a manual hint on the last real message
  relocates it there (`C5/D4/O8`).

**Open:**

- **O7 — Retained-context lifetime and conditions.**
  - *Proven:* 60 s with the parent idle.
  - *Not proven:* hours; later orchestrator turns; starting a launch while the orchestrator has an active turn;
    compaction; the retained `signal` beyond the capture turn; the retained `progress` at all.
  - *Bounded by:* D14's guards and the recorded age.
- **O9 — Unobserved and uncovered tools.** `list`, `multiedit`, `patch` and `apply_patch` are not advertised by v2.0.26
  in the fixture (`C9/O9` fails if that changes). `router_run`'s keys come from its own schema. `shell` and `execute`
  are not covered by leases.
- **O10 — Restart timing.** The restart is one call, so the downtime is not hit. A child that finishes during the
  downtime, and a completion stored but not delivered at the kill, are unobserved. D2's persisted dedupe and D16's
  re-queue cover them.
- **O11 — Provider-side cache behaviour.**
  - (a) **Not applicable (QA-0.1-17, -18).** D5 is withdrawn, so no real-provider gate is needed; the "or the first DF
    session" way of closing it is moot.
  - (b) Whether moving the D4 hint between requests yields cache reads. Phase 6.1 measures it (orchestrator cache-read
    share).
- **O12 — Hint on a last real message without a text part** (a tool result). Observed on v2.0.26 (`cpx-cache-prefix`
  smoke): the `tool_result` block carries the marker, so D4's hint target applies (last non-blank text part, else last
  `tool-result` or `media` part, else no hint; never an earlier message).
- **O13 — A held completion in the latest turn at compaction.** The host keeps the latest turn out of the compaction
  request and carries it as `recent` text. Whether that text reaches later requests through the context hook is
  unobserved (`realCompletion.contextHookCallsAfterCompact=0`). D3's substring matcher is the conservative branch;
  Phase 2.1's smoke asserts it.
- **O14 — `session.create`.** It is listed by the client and the plugin session API. Its parent link, binding, hooks
  and completion delivery are unobserved; it is out of scope (D20).
- **O15 — Real-provider error shapes.** The C10 answers are the test's own. How the host classifies a real usage-limit
  answer (its wording), and whether a real answer carries the reset instant in its message, are unobserved. The DF
  sessions record the first real occurrence; D13's by-status fallback and `capacityPauseMs` cover the gap.

## Alternatives rejected

- **Keep foreground-forced dispatch and get parallelism from several dispatches per message:** the orchestrator still
  blocks on each batch, and the human keeps scheduling.
- **The orchestrator as scheduler, with better prompts and no executor:** every task costs an orchestrator turn, there
  is no durable state, and restart and compaction lose the plan.
- **An external scheduler process or CLI outside the host:** no access to host sessions, hooks or guards; the router's
  guarantees would not apply.
- **Launcher B as the primary launcher:** C14 shows a retained-context launch works, so B's per-task turns are pure
  cost.
- **Router state in the system prompt (today):** breaks the cache on every change (P4).
- **A tail without a breakpoint hint:** the host's only message breakpoint lands on the volatile tail (`C5/D4/O8`).
- **Holding results by delaying the host's completion:** no host API exists. Rewriting per request (C4, C15) is proven.
- **Merge-based or parallel integration:** cannot guarantee an integration branch that is always green.

## Consequences

### Positive

- Long delegations no longer block the orchestrator. The acknowledgement takes 36–55 ms, and every guarantee applies at
  completion, including for user-backgrounded calls (P1–P3).
- Required verification runs in parallel, and the model never reads output that is not yet verified (D3).
- The orchestrator's history up to the last real message has the same text on every request (D4). The tail stays out
  of every cache entry.
- Launcher A runs plan tasks with no orchestrator turn per task. Its children run on the requested agent and model and
  are guarded, granted and leased like any child (C14, router enforced).
- Leases refuse concurrent reads and writes of a leased file through file tools, and hide leased files from search.
- A durable ledger, isolated slots and fast-forward-only integration keep the integration branch green and survive
  restarts without double integration.
- Capacity reacts to the first retry signal, not to a terminal failure that does not come, and the executor can end a
  plan child's endless host retries.

### Negative

- **No 1-hour cache (D5 withdrawn).** The orchestrator pays a full cache write on wake-up after an idle gap longer than
  the 5-minute lifetime, until a host lets plugins set the tools breakpoint TTL.
- **The cache benefit of the moving hint is unmeasured.** It rests on the provider's documented lookup of earlier
  breakpoints and is measured only in Phase 6.1. When the last real message is a tool result, the hint goes on its
  `tool-result` part (O12, observed).
- **Restarts lose children in flight** (C12). Their work is re-run and their spend is lost.
- **Launcher A's context validity is proven only for 60 s.** Longer validity rests on guards and telemetry. A stale
  context costs one orchestrator wake, for that launch only.
- **Two dispatch paths.** Retained launches bypass the `subagent` hook path (no decision row), so the executor must
  call the same dispatch-time functions itself, and the two paths must be kept consistent.
- **An orchestrator interrupt no longer stops background or retained work** (O4a, O4b). Stopping is explicit:
  `/plan abort`, or an interrupt of the child.
- **Persistent 429/529 keep non-plan sessions retrying inside the host** with no terminal event within 75 s. Only plan
  children are stopped by the router.
- **The usage-limit reset instant comes from message text only,** and the host's quota classification follows the
  message wording (C10, the test's own bodies; O15).
- **`shell` and `execute` bypass leases.**
- **Per-request rewrites.** D3 rewrites in the context and compaction hooks on every request, for the life of the
  session.
- **Pinned to OpenCode v2.0.26.** Every decision here depends on that host version, so a host upgrade must keep
  `smoke:cpx` green before the router relies on it (§0.9).

## Revision history

- **2026-10-10** — First text (tasks 0.1.4 and 0.1.5, `54531a8`).
- **2026-10-11** — Regenerated from the round-1 runs at `7b11504` (QA-0.1-3). Changes:
  - C6 holds and D5 is reinstated with the part `cache` hint, gated by O11 (QA-0.1-1).
  - D4 adds the breakpoint hint, and O8 is resolved (QA-0.1-1).
  - C14 was re-observed with the router enforced, a no-router control, agent and model honoured, and 8 + 8 launches
    (QA-0.1-2, QA-0.1-5); O4b was observed with the configuration D14 prescribes (QA-0.1-12).
  - C10 was re-decided on usage-limit variants and the retry hook, with claims scoped to 75 s (QA-0.1-7).
  - The C12 wake is classified: before the restart, delivered once (QA-0.1-6).
  - C9 `list` and `router_run` keys are unobserved (QA-0.1-9).
  - C15 covers the compaction window and a real completion (QA-0.1-11).
  - The plugin-side session API is pinned (QA-0.1-13).
  - "Resolved" items are now pinned (QA-0.1-4).
  - Departures from the plan (D5, D4 hint, C10 branch, D6 `capacity` and age, D13 range 1–8, launcher A only, D15 wakes,
    attempt counting) are applied by plan amendment A-0.1-2 (QA-0.1-8).
- **2026-10-11** — QA round 2 of Phase 0.1 and the Phase 1.2–1.4 memos. Changes, applied to the plan by amendments
  A-0.1-3, A-1.2-1, A-1.3-1, A-1.4-1 and A-1.1-1:
  - D5 is withdrawn on OpenCode v2.0.26; O11(a) is not applicable (QA-0.1-17, -18).
  - `provider.quota`, and host-ended `provider.rate-limit` / `provider.internal` with status 529, close an attempt as `capacity`; a lost
    child's in-flight attempt closes as `lost`; neither counts toward `maxAttempts` (QA-0.1-20).
  - Launcher-A prompt order is PLAN CONTEXT → launch header → TASK (QA-0.1-21); launcher B leftovers are removed
    (QA-0.1-22); launches never use the retained `signal` or `progress` (QA-0.1-25).
  - D7 lists the `router_git_*` tools and states that `shell`/`execute` are not covered by leases (QA-0.1-26); read,
    search and run restrictions apply to child sessions only, and lease ownership is the task (Phase 1.3).
  - The retry-hook stop and quota retry-hook calls are capacity signals (QA-0.1-27).
  - Facts the smoke only recorded are now asserted (QA-0.1-23, -24): C5 marker count ≤ 4 with exactly one message
    marker; C6 per request; C10 persistent faults (no `session.step.failed` or terminal event within 75 s for 429 and
    529), the usage-limit retry hook receiving `{retry: false}`, response headers never reaching the error while
    `response.body` carries the provider's error JSON; C12 delivered exactly once in the last parent request and by a
    new process after the restart; C13 non-empty children; C14 duplicate-read refusals (5 of 6 per child) and a
    decision-row positive control. Retry delays for persistent faults are recorded, not asserted.
  - D4's hint target is the last non-blank text part of the last real message, else its last `tool-result` or `media`
    part, else no hint (QA-1.2-12, -16; O12 observed).
