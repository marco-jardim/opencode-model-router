# ADR 0007 — Critical-Path Execution

> **Status:** Accepted (measurements pending Phase 6.1) **Date:** 2026-10-10 **Wave/Phase:** Critical-Path Execution, Phase 0.1 (task 0.1.4)
> **Supersedes:** none **Depends on:** ADR 0002 (acceptance gate), ADR 0005 (cost-aware routing engine), ADR 0006 (role × tier × assurance delegation)
> **Deciders:** owner (Marco Jardim); host observations and adversarial QA recorded in the Phase 0.1 report (`docs/qa/critical-path-execution/phase-0.1.md`)
> **Plan:** [`../plans/critical-path-execution-plan.md`](../plans/critical-path-execution-plan.md) **Handover:** [`../plans/critical-path-execution-handover.md`](../plans/critical-path-execution-handover.md)
> **Host version under test:** OpenCode v2.0.26 (`C:\Users\Marquinho\scoop\apps\opencode2\2.0.26\opencode.exe`)
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

The design depends on fifteen host behaviours (C1–C15, plan §2). Phase 0.1 pinned them in
`test/smoke/cpx-host-contract.smoke.test.ts`. That suite runs OpenCode v2.0.26 against a scripted provider front, with
a probe plugin (`test/smoke/probe/cpx-probe-plugin.js`) whose mode is chosen per scenario:

- `rewrite-completion` (C4);
- `append-tail-system`, `append-tail-user` and `append-tail-newest` (C5);
- `cache-hint-1h` (C6);
- `filter-grep` (C9);
- `mutate-subagent-prompt` (C11);
- `retained-launch` (C14);
- `rewrite-compaction` (C15).

Each scenario records an `observed` object. `npm run smoke:cpx` ran green three times on 2026-10-10. Values are the same
in all three runs unless the variance column says otherwise; session ids, message ids, timestamps and temporary paths
always vary and are not listed. Observation keys are cited as `C<n> key=value`.

### Evidence

| Id | Observed | Run-to-run variance | Evidence |
|---|---|---|---|
| C1 | `subagent` with `background: true` returned `{status: "running"}` carrying the child's session id (`ack.status="running"`, `ack.matchesChildID=true`). `execute.after` fired exactly once (`executeAfter.probeCountFinal=1`, `executeAfter.harnessCount=1`). The hook record has `status="completed"` with `resultStatus="running"`; result keys `output, content, metadata`. | `ack.returnedMs` 44 \| 50 \| 40 | `test/smoke/cpx-host-contract.smoke.test.ts` scenario C1 |
| C2 | After the child ended, the host injected a completion into the idle parent and woke it with no user prompt (`completion.parentWoke=true`, `completion.userPromptsAfterAck=0`). On the wire it is a `user` message (`wireEnvelope[0].role="user"`). It is stored as `type="synthetic"` with `metadata.source="subagent"` and `metadata.state="completed"`. Text: `<subagent sessionID="…" state="…" description="…">…</subagent>`. | `completion.wakeMsAfterChildEnd` 45 \| 45 \| 47 | scenario C2 (text shape: scenario C7) |
| C3 | The child ended while a parent request was in flight (`midTurn.childEndedDuringSlowRequest=true`). The completion was delivered in provider request 3 and stored (`delivery.lostFromWire=false`, `delivery.storedHasEnvelope=true`). | none | scenario C3 |
| C4 | The parent's context hook first saw the completion in request 4 (`hook.firstSeen.requestNo=4`) and replaced it in requests 4 and 5. The raw completion reached no provider body (`rawEnvelopeInAnyProviderBody=false`); the placeholder did (`placeholderInProviderBodies=[3,4]`). Stored history kept the original (`stored.originalKept=true`, `stored.placeholderPersisted=false`). | none | scenario C4 |
| C5 | All three placements were sent, not stored, absent from the next request, and left the system and all other fields identical. The user-role message landed at `$.messages[1].content[0]`, then `$.messages[3].content[0]`. The host folded the system-role message into the last user message as `<system-update>…</system-update>` at `$.messages[0].content[1]`, the same path as a part on the newest message. The host put `cache_control: {type: "ephemeral"}` on the last block of the last message. | none | scenario C5 |
| C6 | The probe's only lever, the undocumented request option `anthropic.cacheControl = {type: "ephemeral", ttl: "1h"}`, did not reach the wire (`providerCarriesOneHourAnywhere=false`). The context event's `options` has only `maxTokens`; system parts are `{type, text}`. | none | scenario C6 |
| C7 | Each child produced its own terminal event: `session.execution.succeeded`, `session.execution.failed` or `session.execution.interrupted`. `context({sessionID: child})` returned 3 messages (`user, assistant, idle`); the last is `{type: "idle", outcome}`. The OK child's text is in that context (`containsChildOk=true`), but the probe's final-text extraction found nothing (`finalTexts.length=0`). `client.session.interrupt({sessionID})` returned `{interrupted: true}`. The parent stored three completions with states `error, cancelled, completed`. The host did not retry the invalid request (`failure.retriedByHost=false`). | index of the failing child's host attempt: 4 \| 3 \| 4 | scenario C7 |
| C8 | `client.session.background({sessionID: parent})` moved a running foreground `subagent` call to the background. Its `execute.after` reported `resultStatus="running"` before the child ended. The acknowledgement has the same shape as C1 apart from ids (`comparisonWithC1Ack.sameShapeModuloIds=true`). | `background.executeAfter.afterMs` 13 \| 13 \| 26 | scenario C8 |
| C9 | `execute.before` received these arguments: `read {path}`, `write {path, content}`, `edit {path, oldString, newString}`, `glob {path, pattern}`, `grep {path, pattern}`, `list {filePath}` and `router_run {script, cwd}`. `list` is not a v2.0.26 tool and `router_run` was not registered in the fixture, so neither got an `execute.after`. The `glob` and `grep` results could be rewritten in `execute.after` (`filter.mutable=true`, `filter.removedLines=1`), and the model saw the rewritten text. For `grep` the line with the leased text was removed (`perTool.grep.modelSaw.containsLeased=false`). v2.0.26 does not advertise `multiedit`, `patch` or `apply_patch`. It does advertise `shell {command, workdir, timeout, background}` and `execute {code}`. | none | scenario C9 |
| C10 | A single 429 or 529 produced one `session.retry.scheduled`, then success, with no `session.step.failed`. A persistent 429 or 529 kept producing `session.retry.scheduled` (`attempt` 2…10 in run 1; first retry `at` = event time + 2000 ms) and no terminal event until the harness interrupted the root. The retry event's data is `{sessionID, assistantMessageID, attempt, at, error: {type: "provider.rate-limit", message, status: 429, response: {body}}}`; for overload, `type: "provider.internal"` and `status: 529`. A usage limit got no retry: `session.step.failed`, then `session.execution.failed`, with `error = {type: "provider.quota", message: "Usage limit reached. Your limit will reset at <ISO-8601>.", status: 429}`. | persistent 429: `requestCount` 9 \| 9 \| 10 (bounded by the harness's observation window) | scenario C10 |
| C11 | The model wrote `prompt: "C11 original prompt"`. `execute.before` changed it to `"C11 original prompt CPX_MUTATED"`, and the child received the changed prompt (`child.receivedMutated=true`). The parent's provider bodies kept the original arguments (`parentWire[1].toolUses[0].mutated=false`, `parentWire[2].toolUses[0].mutated=false`). | none | scenario C11 |
| C12 | The restart kills and relaunches in one call, so the downtime itself was never hit. Child A finished before the restart; after the restart the parent woke with A's `completed` completion (`parent.wokeAfterRestart=true`, `parent.envelopeStates=[completed]`). Child B was in flight at the restart. Afterwards it had no terminal event and was inactive (`perChild.C12_B.terminal=null`, `perChild.C12_B.active=false`); its context held only the `user` message, and the parent got no completion for it. | `timing.restartMs` 3119 \| 3887 \| 3171; held index of A 2 \| 1 \| 1 | scenario C12 |
| C13 | 6, then 8, background children were all acknowledged `running` and were all waiting at the provider at once (`concurrency.n6.peakWaiting=6`, `concurrency.n8.peakWaiting=8`); all succeeded. Parent interrupt while the root was idle: `interrupted=false`, and the 3 background children kept running and succeeded. Parent interrupt while the root was active, with 3 foreground children: `interrupted=true`; all 3 children ended `session.execution.interrupted`; the root logged `session.step.failed {type: "aborted"}`. Parent interrupt while the root was active with 3 background children (O4a): `interrupted=true`, the children stayed active and ended `session.execution.succeeded`. | in run 2 the root started a new execution after the idle-root interrupt (`rootLinesAfterInterrupt.length` 0 \| 2 \| 0) | scenario C13 |
| C14 | A plugin tool's execute context (`sessionID, agent, messageID, id, progress, signal`) was kept after the turn. Three children were launched through the native `subagent` tool right after the turn, and three more 60 s later (`CPX_PROBE_RELAUNCH_MS=60000`). All six completed (`results[*].ok=true`, `status="completed"`, `errors.length=0`). Each child's `read` call fired the router's hooks (`harnessHookRecordsForChildren=12`, `routerGuardsOrGrantsRan=true`; permission evaluations ran). Peak concurrency was 3 (`peakOverlapBatch1=3`). The parent's history was unchanged (`parentHistory.unchangedAcrossLaunches=true`) and the children were listed under the root. No `subagent` hook fired on the root (`subagentHooksOnRootAfterCapture=0`) and the router wrote no decision row (`routerDecisionRows=0`). | order in which the children started | scenario C14 |
| C15 | `client.session.compact({sessionID})` returned `{type: "compaction", delivery: "steer"}`. The compaction hook fired (`hook.fired=true`: 2 messages, system present) and the rewrite applied (`hook.rewriteLines[0].did=true`, `replacements=1`). A provider request followed (`provider.requestSentAfterCompact=true`). Stored history kept the original (`stored.hasOriginal=true`, `stored.hasPlaceholder=false`). In every run the compaction record ended `status="failed"`, `compaction.failed` "Compaction summary did not match the required template". | none | scenario C15 |

## Decision

### Host contracts: branch taken

| Id | Outcome | Branch implemented | Deciding observation |
|---|---|---|---|
| C1 | holds | Register the dispatch as in flight in `execute.after`. | `C1 ack.status="running"`, `executeAfter.probeCountFinal=1` |
| C2 | holds | The completion processor is triggered by the host's completion (D2); the router posts no completion of its own. | `C2 completion.parentWoke=true`, `completion.userPromptsAfterAck=0` |
| C3 | holds | No extra handling: no undelivered set, no re-post. | `C3 delivery.lostFromWire=false`, `delivery.storedHasEnvelope=true` |
| C4 | holds | D3 held placeholder. | `C4 rawEnvelopeInAnyProviderBody=false`, `placeholderInProviderBodies=[3,4]`, `stored.originalKept=true`, `stored.placeholderPersisted=false` |
| C5 | holds | The tail is the last message, role `user`. | `C5 variants.user.wire.firstMarkerPaths=["$.messages[1].content[0].text"]`, `secondMarkerPaths=["$.messages[3].content[0].text"]`, `firstMarkerStillInSecond=false`, `storedHasMarker=false`, `prefix.systemIdentical=true`, `prefix.otherFieldsIdentical=true` |
| C6 | does not hold | Fallback: `routing.promptCache.ttl` is not added; D5 is withdrawn. | `C6 providerCarriesOneHourAnywhere=false`, `contextShape.optionKeys=["maxTokens"]` |
| C7 | holds | The processor and recovery read results from the child's context. Per child, recovery re-queues when the result cannot be read (the text path is the last `assistant` message; QA item O1). | `C7 perChild.C7_OK.terminal.kind="session.execution.succeeded"`, `context.finalMessage.outcome="succeeded"`, `containsChildOk=true`, `finalTexts` contains `CHILD_OK` |
| C8 | holds | Covered through C1. | `C8 background.executeAfter.resultStatus="running"`, `comparisonWithC1Ack.sameShapeModuloIds=true` |
| C9 | holds | Leases are enforced in the tool hooks; search filtering is available. | `C9 perTool.*.executeBefore.args`, `perTool.grep.filter.mutable=true`, `perTool.grep.probeSawLeasedBeforeFilter=true`, `perTool.grep.modelSaw.containsLeased=false` |
| C10 | holds, on a different event for 429 and 529 | D13 capacity signals come from event fields. A text pattern is used only to read the usage-limit reset time. | `C10 cases.rate-limit-persistent.stepFailed.length=0`; `session.retry.scheduled` `data.error.status=429`; `cases.usage-limit-until-reset.stepFailed[0].error` has `"type":"provider.quota"` |
| C11 | holds | Launcher B would expand in `execute.before`. B is not built (C14 chose A); C11 stays pinned because of today's `execute.before` changes to `subagent` arguments. | `C11 child.receivedMutated=true`, `parentWire[2].toolUses[0].mutated=false` |
| C12 | does not hold for a child that is in flight | Fallback: recovery reads child state and result through C7, and re-queues the task when neither is available. | `C12 perChild.C12_B.terminal=null`, `perChild.C12_B.active=false`, `perChild.C12_B.context.roles=["user"]` |
| C13 | holds (for an interrupt while the root is idle; an interrupt of an active root also leaves background and retained-context children running, O4) | `maxParallel` is clamped to 8. | `C13 concurrency.n8.peakWaiting=8`, `parentInterrupt.background.interrupt.result.interrupted=false`, `parentInterrupt.background.afterInterrupt.activeChildren=3` |
| C14 | holds (validity proven for 60 s) | **Launcher A**. | `C14 launches[1].results[*].ok=true` (60 s after the turn), `hooksForChildren.routerGuardsOrGrantsRan=true`, `concurrency.peakOverlapBatch1=3`, `parentHistory.unchangedAcrossLaunches=true` |
| C15 | holds (the rewrite; a successful compaction was not observed) | The held placeholder is also applied in compaction (D3). | `C15 hook.fired=true`, `hook.rewriteLines[0].did=true`, `stored.hasOriginal=true`, `stored.hasPlaceholder=false` |

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
  `client.session.background` (C8) reports the same running result.

**Rationale.** P1 and P2 force every routed dispatch to the foreground, and the owner backgrounds by hand. A background
acknowledgement returns in 40–50 ms (`C1 ack.returnedMs`). D2 applies every guarantee at completion, so a background
dispatch loses nothing. Short dispatches stay in the foreground, so they cost no extra wake-up turn.

**Alternatives rejected.**

- Background for everything: every short call would add a wake-up turn and a cache write for the completion message.
- Leave the choice to the model: the model rarely chooses it, and today the user's choice drops the guarantees (P3).
- Run required verification in the background with no holding: the model would act on output that is not yet
  verified.

### D2 — Guarantees at completion

**Decision.** A completion processor keyed by child session id runs everything that today's `execute.after` does for a
finished dispatch: budget and authority signals, deferred-verification registration, change-set capture at child end,
verification enqueue, and timing. It runs exactly once per child attempt. It is triggered by whichever comes first: the
child's `session.execution.succeeded|failed|interrupted` event (C7), or the host's completion message seen in the
parent's context (C2).

- **Foreground** dispatches keep today's in-result annotation in `execute.after`. The end-event trigger is suppressed
  while that call's `execute.after` is pending, so `off` and foreground output stay byte-identical.
- **Background** dispatches get their annotations (budget, authority, depth banner, verification handle) in the "completed"
  section of the turn-state tail, on every request of the parent's next turn. When the context hook builds the first
  request after a completion, it waits up to 2000 ms for `settled(child)`; if the child is not settled by then, the
  section says "router guarantees pending" and the annotation appears in the next request.
- Past messages are never rewritten for annotations, and nothing is appended to history for them.

**What the contracts change.**

- **C2 holds.** The host completion is stored as a synthetic message (`metadata.source: "subagent"`). In the context hook
  it is a `user` message whose text starts with `<subagent sessionID="<child>" state="completed|error|cancelled"
  description="…">`. Outcomes map to states as succeeded → `completed`, failed → `error`, interrupted → `cancelled`
  (C7).
- **C3 holds.** A completion that arrives mid-turn is not lost, so the processor keeps no undelivered set and never
  re-posts.
- **C8 holds.** A call the user moves to the background gives the same running acknowledgement, so it is processed in
  the same way (fixes P3).
- **Launcher A children (D14) produce no completion in the parent** (`C14 parentHistory.unchangedAcrossLaunches=true`),
  so their only trigger is the child's end event.
- **Dedupe.** After a restart, the host delivers the completion of a child that finished just before the restart (C12,
  child A). The exactly-once rule therefore dedupes against the persisted pending store (P5), not only against memory.

**Rationale.** `execute.after` of a background call runs at the acknowledgement, before the child has done anything (P3).
The only points where the results exist are the child's end and the host's completion.

**Alternatives rejected.**

- Annotate in `execute.after`: there is nothing to annotate at that point.
- Rewrite the host completion to add annotations: annotation text changes, so the message bytes would change and the
  cached prefix would break.
- Append history entries: history grows, the annotations become permanent, and each completion adds a cache write.

### D3 — Held results (enabled: C4 and C15 hold)

**Decision.** For a background dispatch under required verification, the host completion is rewritten to a fixed
placeholder, `held — verdict pending (vrf_…)`, for the life of the session.

- The rewrite happens in the parent's context hook on every request, because history keeps the original
  (`C4 stored.originalKept=true`, `stored.placeholderPersisted=false`). It also happens in the session's compaction
  hook (C15).
- The placeholder never changes, so the prefix stays byte-stable.
- The matcher is the completion message's opening tag carrying the held child's session id.
- On the verdict, a new synthetic entry delivers the output with the verdict (PASS) or the findings (FAIL), and wakes
  the parent once (`resume: true`).
- A `subagent` call that resumes a held child (the `sessionID` argument, advertised by the host's `subagent` tool in C9)
  is refused in `execute.before` until the verdict.
- Plan tasks never need holding: the executor consumes their output, and integration requires a PASS.

**What the contracts change.**

- Held results are possible, so D1 may background required verification.
- The parent wake from `client.session.synthetic` with `resume: true` is proven (QA item O6): the call
  `{sessionID, text, description, metadata, resume: true}` on an idle parent produces a new provider request that carries
  the text, while `resume: false` does not wake it.
- A successful compaction with a held placeholder is observed (QA item O5): the compaction record ends
  `status="completed"`, the compaction request carries the placeholder (and not the original), and the summary has no
  original.

**Rationale.** Required verification can run in parallel without the model reading output that is not yet verified.

**Alternatives rejected.**

- Keep required verification in the foreground (the C4 fallback): this loses the parallelism.
- Deliver the output marked "unverified": models act on it anyway.
- Delay the host's completion: the host offers no API for it.

### D4 — Cache-stable turn state

**Decision.**

- On v2, one builder renders all per-turn router state into a tail: in-flight dispatches, held results, pending
  verdicts, unread late notices (kept until `router_verify` reads them), the advise hint, plan state and the inbox.
- The tail is regenerated on every request and never persisted.
- **C5 placement:** the v2 context hook appends the tail as a **new last message with role `user`** (probe mode
  `append-tail-user`).
- The system prompt stays byte-stable.
- v1 keeps today's system-prompt path.

**What the contracts change: why `user`.** All three placements passed C5. However:

- The host turns a system-role message into a `<system-update>` part of the last user message. On the wire that is the
  same as the newest-message fallback.
- The host puts its `cache_control` breakpoint on the last block of the last message, which is the tail itself
  (C5 wire bodies).

Only a separate tail message keeps the last real message as its own message, so a host breakpoint on the second-to-last
message lands on real history. Whether v2.0.26 places that second breakpoint is unobserved (QA item O8). Byte identity
of the prefix itself is proven.

**Rationale.** P4: each change in the system prompt invalidates the whole cached history.

**Alternatives rejected.**

- Keep the state in the system prompt (P4).
- A part on the newest message: the host accepts it, but the part shares the breakpoint block with the last real
  content.
- Persisted synthetic messages: history grows, and stale state becomes permanent.

### D5 — Prompt-cache TTL (withdrawn: C6 does not hold)

**Decision.** `routing.promptCache.ttl` is **not added**, and no `routing.promptCache.*` key exists.

- The plan's v1 notice for `routing.promptCache.*` (§0.10-8) and its Appendix C row are removed by plan amendment.
- Deciding fact: the probe could set only the undocumented request option `anthropic.cacheControl = {type: "ephemeral",
  ttl: "1h"}`, and no `ttl` reached the wire (`C6 providerCarriesOneHourAnywhere=false`). The context event exposes no
  cache field (`C6 contextShape.optionKeys=["maxTokens"]`, `contextShape.systemPartKeys=["type","text"]`).
- On the wire there are only the host's own `{type: "ephemeral"}` breakpoints.
- D5 is reopened by ADR amendment only when the plugin API documents a cache-hint field and a smoke run shows it on the
  wire.

**Alternatives rejected.**

- Ship the undocumented option anyway: it has no effect today and would change behaviour silently on a host upgrade.
- Intercept provider requests outside the plugin API: excluded by D20.

### D6 — Telemetry

**Decision.**

- Every dispatch's start, end, role, class, scope, tier, model and outcome goes to `timings.jsonl`.
- Every orchestrator turn's input, cache-read and cache-write tokens go to `turns.jsonl`.
- Both files live in the outcome store.
- An estimator gives p50/p90 per (role, class, scope), falling back to (role, class), then role, then a prior of
  480000 ms.

**What the contracts change.**

- Outcomes include the C10 classes `rate-limit`, `overload` and `usage-limit`, taken from event fields.
- Each launcher A launch also records the age of the retained context it used (D14 guard).

**Rationale.** P6. D1 and D12 need measured durations, and §5 measures cache-read share.

**Alternatives rejected.**

- Durations estimated by the model: not reliable.
- In-memory statistics: lost on restart.

### D7 — File leases (C9 holds: enforced in the tool hooks)

**Decision.**

- Only child (delegated) sessions take leases. On first write a child takes an exclusive lease on the file, keyed by
  repository and normalized repo-relative path.
- A root session takes no leases. Its writes are refused only while a child holds that file.
- While a child holds a write lease in a working tree, another session in the same tree is affected as follows:
  - a **read** of that file is refused in `execute.before`, naming the holder;
  - a **directory search** omits leased files and adds a count, by rewriting the result in `execute.after`;
  - a **`router_run`** runs, and its result carries `[router] ran while <holder> edits <n> file(s); result may be
    contaminated` (it is refused instead when `routing.leases.run` is `"refuse"`);
  - a **plugin verification run** is deferred until the lease ends or its deadline passes, then runs with today's
    contamination caveat.
- A child's leases end at its execution end, its interrupt, or the 6 h sweep. Plan-task leases end at integration.
- Predicted footprints are scheduling hints; leases are the enforcement.

**What the contracts change.** Path keys observed on v2.0.26:

| Tool | Path arguments |
|---|---|
| `read`, `write`, `edit` | `path` |
| `glob`, `grep` | `path` and `pattern` |
| `list` | `filePath` (not a v2.0.26 tool) |
| `router_run` | `cwd` |

- Search filtering is available: `glob` and `grep` results can be rewritten in `execute.after`.
- `multiedit`, `patch` and `apply_patch` are not v2.0.26 tools, so their argument shapes are unobserved.
- `router_run` is a router tool, so it writes its own annotation; no host hook is needed.
- `shell` (`command`, `workdir`) and `execute` (`code`) are not covered by leases; this limitation is documented (QA
  item O9).

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
- It is capped by `routing.executor.maxParallel`, default 4 (subscription limits are unknown).
- `maxParallel` is **clamped to 8**, the largest concurrency C13 proved (`C13 concurrency.n8.peakWaiting=8`). Values
  are validated to 1–8.

**What the contracts change: signals come from event fields (C10).**

| Signal | Event | Identifying fields |
|---|---|---|
| Rate limit | `session.retry.scheduled` | `data.error.type = "provider.rate-limit"`, `data.error.status = 429`, plus `data.attempt` and `data.at` |
| Overload | `session.retry.scheduled` | `data.error.type = "provider.internal"`, `data.error.status = 529` (QA item O2) |
| Usage limit | `session.step.failed`, then `session.execution.failed` | `error.type = "provider.quota"`, `error.status = 429` |

- The decrease is applied on the **first retry event**, because the host retries 429 and 529 by itself and a persistent
  fault never produced a terminal event within the observation window (`C10 cases.rate-limit-persistent.stepFailed.length=0`,
  `terminal=null`).
- A 429 is not enough on its own to tell a usage limit from a rate limit, because the provider body says
  `rate_limit_error` in both cases. `error.type` decides.
- The reset time appears only in text. It is parsed from `error.message` with
  `/reset at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/`. If parsing fails, the provider pauses for the default
  window.
- The provider is identified by `model.providerID` in the same session's preceding `session.step.started`.
- An unknown `error.type` with status 429 or 529 is classified by its status.
- Rate-limit and usage-limit errors never count as failed attempts.

**Rationale.** Limits are unknown and shared with the owner's other sessions (§0.6-11).

**Alternatives rejected.**

- Fixed concurrency: 429 storms or idle capacity.
- Waiting for `session.step.failed` (the contract's original event): it never arrives for 429 or 529.
- Text patterns for everything: brittle when structured fields exist.

### D14 — Launcher (C14 holds: launcher A)

**Decision.** The executor launches plan tasks itself through the router's child runner (`src/compat/v2-client.ts`
≈96-222). The runner calls the native `subagent` tool with a retained orchestrator tool context, so no orchestrator turn
is spent per task. Launcher B (dispatch by reference) is not built.

**Deciding facts (C14).**

- All six launches completed, three right after the capturing turn and three 60 s later
  (`launches[0].results[*].ok=true`, `launches[1].results[*].ok=true`, `errors.length=0`).
- The children's tool calls fired the router's hooks (`hooksForChildren.harnessHookRecordsForChildren=12`,
  `routerGuardsOrGrantsRan=true`).
- Three ran concurrently (`peakOverlapBatch1=3`).
- The parent's history got nothing (`parentHistory.unchangedAcrossLaunches=true`).

**Launch mode.** Launches are **awaited** by the executor and are not `background: true`; C14's launches returned
`status: "completed"` with the child's output. A background launch would make the host inject a `<subagent>`
completion into the orchestrator session and wake it (C2), and that is the per-task turn launcher A exists to avoid.

**The executor does the dispatch-time work itself.** For a retained launch, no `subagent` hook fires on the parent
(`subagentHooksOnRootAfterCapture=0`) and no decision row is written (`routerDecisionRows=0`). The executor therefore
calls, directly, the same functions the `subagent` hook path uses: routing decision, decision row, timing start, and
in-flight registration for D2.

**Binding each child.**

- **Role:** `agent` = the task's role agent. The `agent` argument selects the child's agent (C14: `batchLine.agent="general"` → children ran as `general`).
- **Tier:** `model` = the model the routing engine resolves for the task's tier (shape seen in C11:
  `anthropic/claude-sonnet-5-5#low`).
- **Work root and grant:** written to the role binding table (`src/routing/roles/binding.ts`) before the launch, under a
  launch nonce in the task header `[plan <planId>:<taskId>#<attempt>]`. The nonce goes after the shared plan-context
  block, so children of one role still share the provider cache.
- The binding is resolved to the child session id in the child's **first context hook**, which runs before the child's
  first tool call (`firstContext[0].messageCount=1`, `childProviderRequests[0].lastIsToolResult=false`).
- A child session whose prompt carries a plan task header but has no resolved binding is refused every tool call (fail
  closed).
- From then on the guards, grants and leases apply to the child as to any child (C14 `routerGuardsOrGrantsRan=true`).

**Refreshing the retained context.**

- *Capture point:* the execute context of every **router tool** call made by the orchestrator session the plan is bound
  to. That is the capture source C14 proved: a plugin tool's context `{sessionID, agent, messageID, id, progress,
  signal}`. The newest capture replaces the retained one and is stamped with its time. D14's "every orchestrator tool
  call" is narrowed accordingly. Host tool hooks become a capture source only if Phase 3.1 shows that they carry the
  same fields.
- *Proven:* a context captured in a turn that then ended stays usable immediately after the turn and 60 s later, with
  the parent idle in between: 6 of 6 launches per run, in 3 runs.
- *Assumed, not proven:* validity for hours, after later orchestrator turns, after compaction, or after a parent
  interrupt.
- *Never valid:* across a host restart, because the context lives in plugin memory.

**Guards Phase 3.1 must add.**

1. **Launch confirmation.** A launch is confirmed when the child's first context hook resolves its binding within 30 s.
2. **Stale context.** A launch that throws, or is not confirmed, marks the context stale. The task returns to `ready`
   without counting an attempt, and nothing else launches with that context.
3. **Refresh wake.** When ready work exists and no fresh context does, the executor wakes the orchestrator once through
   the D15 wake channel. The turn-state line tells it to call `router_plan action=status`, and that call refreshes the
   context.
4. **Recorded age.** Every launch records the context's age (D6). Phase 6.2.0 writes into this ADR the largest age at
   which a launch succeeded under DF-2. The ADR claims no validity beyond the recorded age.
5. **Unexpected interrupts.** A plan child that ends `session.execution.interrupted` without an executor cancel is
   treated as lost and re-queued, not as a failed attempt. Retained launches are awaited; C13 shows that an interrupt of
   an active root kills foreground children but not background children (they stay active and end
   `session.execution.succeeded`; QA item O4a), and it does not kill retained-context children either: they stay active
   and all their launches return `completed` (QA item O4b).
6. **After a host restart (D16),** nothing launches until the orchestrator's first router tool call in the adopted
   session.

**Concurrency.** C14 proved 8 concurrent retained launches in one batch (`C14 concurrency.peakOverlapBatch1=8`; QA item
O3), so the launcher A clamp equals the `maxParallel` clamp of 8.

**Alternatives rejected.**

- Launcher B: one orchestrator turn per task means token cost, latency and idle-with-ready time.
- Background launches from the retained context: they inject completions into the orchestrator and wake it.
- A session-create API: v2.0.26 has none (D20).

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
- a `manual` task entering `ready` (once);
- a stale launch context (D14, guard 3).

The plan's "(launcher B) ready work" wake does not exist. The wake channel `client.session.synthetic` with
`resume: true` is proven (QA item O6); `resume: false` does not wake an idle parent.

**Alternatives rejected.**

- Stopping for every question: the human becomes the scheduler again.
- An unbounded QA loop.
- Waking the orchestrator for every completion.

### D16 — Recovery (C12 does not hold for children in flight)

**Decision.** On plugin start, every running ledger of the repository whose `repo.toplevel` is the plugin session's
toplevel is reconciled with host evidence read through C7. Each child is classified from `context({sessionID: child})`
and its active state:

| Child state | Classification | Action |
|---|---|---|
| Last message `{type: "idle", outcome}` | finished | Processed once. Result text from the last `assistant` message of the child's context (roles `user, assistant, idle`; QA item O1), or else the body of the parent's completion for that child. |
| Active | alive | Adopted, never re-dispatched. |
| Neither finished nor active | lost | Re-queued without counting an attempt. |

- A half-done integration is completed or rolled back idempotently.
- `/plan adopt <planId>` rebinds a plan to a new orchestrator session.

**Deciding fact.** A child in flight during a host restart is neither finished nor active afterwards, and gets no
completion (`C12 perChild.C12_B.terminal=null`, `active=false`, `context.roles=["user"]`). After a host restart,
therefore, every child that was in flight is re-queued. A child that finished just before the restart has its completion
delivered by the host after the restart (`C12 parent.wokeAfterRestart=true`, `envelopeStates=[completed]`). D2's dedupe
processes it once.

**Alternatives rejected.**

- Re-dispatch everything not integrated: duplicate work and a risk of double integration.
- Trust the host to deliver completions after a restart: it does not for children in flight.

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
"v2"`. A configured `routing.background.*`, `routing.leases.*` or `routing.executor.*` key logs one notice per process
on v1. No `routing.promptCache.*` key exists (D5).

**Alternative rejected.** Porting to v1 violates the feature freeze (AGENTS.md, "Host support policy").

### D20 — Out of scope

**Decision.** These are out of scope:

- cross-repository plans (the ledger is keyed by repository so it can be extended later);
- a background mode for `router_run`;
- dispatch through an API the host does not offer (session create, provider cache fields).

**Alternative rejected.** Pulling them in widens the host surface without evidence from the contracts.

## Consequences for later phases

Each phase implements only the branch named here (plan §0.2).

| Topic | Phase | Branch implemented |
|---|---|---|
| C5: tail placement | 1.2 | The v2 context hook appends the turn-state tail as a new last message with role `user`, regenerated on every request and never persisted. `test/smoke/cpx-cache-prefix.smoke.test.ts` asserts that consecutive requests are byte-identical through the previous request's messages, and records the `cache_control` positions (QA item O8). |
| C6: `routing.promptCache.ttl` | 1.2, 4.1 | Not added. No `routing.promptCache.*` row in `docs/CONFIG_REFERENCE.md` and no docs-drift pin. D5 is not built. |
| C9: leases | 1.3 | Leases in the tool hooks: refusal in `execute.before`, rewriting of `glob`/`grep` results in `execute.after`. Path extraction uses `path` (`read`, `write`, `edit`, `glob`, `grep`), `filePath` (`list`) and `cwd` (`router_run`). Search filtering is available. `router_run` annotates its own result. `shell` and `execute` are documented as not covered. |
| C11: launcher B expansion point | none | `execute.before` would be the expansion point, but B is not built. C11 stays pinned because the router's `execute.before` changes to `subagent` arguments must not enter the parent's history (cache stability). |
| C14: launcher | 3.1 (with 1.4 types) | Launcher A only: awaited native `subagent` launches from the retained router-tool context, explicit role, model, grant and work-root binding resolved in the child's first context hook, and the six guards of D14. `src/executor/types.ts` defines no launcher B types. |
| C15: holding in compaction | 2.1 | The held placeholder is applied in the compaction hook as well as the context hook. |
| C13: `maxParallel` clamp | 1.4, 3.1, 4.1 | Clamped to 8, validated to 1–8, default 4. Launcher A uses the same clamp: C14 proved 8 concurrent retained launches (QA item O3). |
| C4/C15 and D3: held results | 2.1 | Held results are possible and built. D1 may background required verification. Phase 2.1's smoke asserts the verdict delivery wake; `client.session.synthetic` with `resume: true` is proven to wake an idle parent and a successful compaction with the placeholder is observed (QA items O5, O6). |
| C10: capacity signals | 1.1, 3.1 | Event fields: `session.retry.scheduled` `data.error.status` 429/529 and `data.error.type` (`provider.rate-limit` for 429); usage limit = `session.step.failed`/`session.execution.failed` with `error.type = "provider.quota"`. The only text pattern is `/reset at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/` on `error.message`. The provider comes from the preceding `session.step.started` `model.providerID`. For 529 `data.error.type = "provider.internal"` (QA item O2). |
| C12/C7: recovery reads | 2.1, 4.2 | `client.session.context({sessionID: child})`: last message `{type: "idle", outcome}` means finished; the result comes from the last `assistant` message of that context (QA item O1), else from the parent's completion body. A child that is neither finished nor active is re-queued. Pending verifications are persisted (P5). Cancellation uses `client.session.interrupt({sessionID})`. |
| C2/C3: completion trigger and re-post | 2.1 | Triggered by the host's completion in the parent's context hook or by the child's `session.execution.*` event, whichever comes first. No re-post, no undelivered set. |
| C8: user-backgrounded calls | 2.1 | Covered through C1: classified by result `metadata.status === "running"`, processed by D2. |
| C1: registration | 2.1 | Register the dispatch as in flight in `execute.after`, keyed by the child session id from the acknowledgement. |

Phases 2.2, 2.3, 2.4 and 3.2 have no host-contract branch. Phase 5.1 registers the context, compaction, permission and
event hooks on v2 only. Phase 6.1 produces the measurements that change this ADR's status, and 6.2.0 records the
retained-context age proven under DF-2.

## Open observations (flagged for Phase 0.1 QA)

Each item keeps the conservative branch chosen above until its assertion is pinned in `smoke:cpx`. O1–O6 are resolved
(commit 7e5eda4: `smoke:cpx` 41/41 in three consecutive runs); O7–O10 stay open.

- **O1 — C7 child final text. Resolved.** The child's final text is in the last `assistant` message of
  `context({sessionID: child})` (roles `user, assistant, idle`; `finalTexts` contains `CHILD_OK`). Recovery reads it
  there; the parent's completion body remains the fallback and re-queue the last resort.
- **O2 — C10 overload type. Resolved.** The 529 `session.retry.scheduled` has `data.error.type = "provider.internal"`
  (all three runs), pinned in `smoke:cpx` C10. The host's retry limit is still unobserved (persistent faults were still
  retrying when the harness stopped).
- **O3 — C14 concurrency. Resolved.** One batch of 8 retained-context launches ran concurrently
  (`peakOverlapBatch1=8`) and all completed.
- **O4 — Interrupting an active root. Resolved.** Interrupting an active root returns `{interrupted: true}` and does not
  kill background children (O4a: they stay active and end `session.execution.succeeded`) or retained-context children
  (O4b: they stay active and all three launches return `completed`).
- **O5 — C15 successful compaction. Resolved.** A compaction succeeds (record `status="completed"`). The compaction
  request carries the placeholder at `$.messages[0].content[0].text` and not the original, and the summary has no
  original. After compaction `session.context` shows only the compacted view; the full message log still holds the
  original and no placeholder (`fullLog.anyApiReturnsPreCompaction=true`).
- **O6 — Synthetic wake. Resolved.** `client.session.synthetic({sessionID, text, description, metadata, resume})` does
  not wake an idle parent with `resume: false`; with `resume: true` it does (a new provider request carries the text).
- **O7 — Retained-context lifetime.** Proven 60 s; hours are an assumption bounded by D14's guards and recorded age.
- **O8 — Second cache breakpoint.** Whether the host also places a breakpoint on the second-to-last message is
  unobserved.
- **O9 — Unobserved and uncovered tools.** `multiedit`, `patch` and `apply_patch` are not v2.0.26 tools, so they are
  unobserved. `shell` and `execute` are not covered by leases.
- **O10 — Restart timing.** C12's restart downtime could not be hit (restart is one call). Child B represents a child
  whose request is in flight at the kill.

## Alternatives rejected

- **Keep foreground-forced dispatch and get parallelism from several dispatches per message:** the orchestrator still
  blocks on each batch, and the human keeps scheduling.
- **The orchestrator as scheduler, with better prompts and no executor:** every task costs an orchestrator turn, there
  is no durable state, and restart and compaction lose the plan.
- **An external scheduler process or CLI outside the host:** no access to host sessions, hooks or guards; the router's
  guarantees would not apply.
- **Launcher B as the primary launcher:** C14 shows a retained-context launch works, so B's per-task turns are pure cost.
- **Router state in the system prompt (today):** breaks the cache on every change (P4).
- **A 1-hour cache hint through undocumented provider options:** C6 shows it never reaches the wire.
- **Holding results by delaying the host's completion:** no host API exists. Rewriting per request (C4, C15) is proven.
- **Merge-based or parallel integration:** cannot guarantee an integration branch that is always green.

## Consequences

### Positive

- Long delegations no longer block the orchestrator. The acknowledgement takes 40–50 ms, and every guarantee applies at
  completion, including for user-backgrounded calls (P1–P3).
- Required verification runs in parallel, and the model never reads output that is not yet verified (D3).
- The orchestrator's prompt prefix stays byte-stable across wake-ups (D4), so the provider cache survives them within
  its ephemeral lifetime.
- Launcher A runs plan tasks with no orchestrator turn per task. Its children are guarded, granted and leased like any
  child.
- Leases refuse concurrent reads and writes of a leased file through file tools, and hide leased files from search.
- A durable ledger, isolated slots and fast-forward-only integration keep the integration branch green and survive
  restarts without double integration.
- Capacity reacts to the host's first retry event, not to a terminal failure that never comes.

### Negative

- **No 1-hour cache (D5 withdrawn).** After an idle gap longer than the provider's default ephemeral lifetime, the
  orchestrator pays a full cache write on wake-up.
- **Breakpoint on the tail.** The host puts its last-message breakpoint on the tail block. A cache hit on the last real
  message depends on a second breakpoint that has not been observed (O8).
- **Restarts lose children in flight** (C12). Their work is re-run and their spend is lost.
- **Launcher A's context validity is proven only for 60 s.** Longer validity rests on guards and telemetry. A stale
  context costs one orchestrator wake: B's cost, for that launch only.
- **Two dispatch paths.** Retained launches bypass the `subagent` hook path, so the executor must call the same
  dispatch-time functions itself; the two paths must be kept consistent.
- **Persistent 429/529 keep a child retrying inside the host** with no terminal event. Its slot stays occupied while the
  capacity controller stops new launches.
- **The usage-limit reset time comes from message text**, which is brittle to wording changes. It is pinned by
  `smoke:cpx` C10.
- **`shell` and `execute` bypass leases.**
- **Per-request rewrites.** D3 rewrites in the context and compaction hooks on every request, for the life of the
  session.
- **Pinned to OpenCode v2.0.26.** Every decision here depends on that host version, so a host upgrade must keep
  `smoke:cpx` green before the router relies on it (§0.9).
