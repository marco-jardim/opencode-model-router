# ADR 0004 — Delegation Depth and the Effort Bump

> **Status:** Accepted **Date:** 2026-10-05 **Wave/Phase:** Delegation Depth and Effort Bump, Phase 3.1
> **Supersedes:** none **Depends on:** ADR 0001 (hard-block guard), ADR 0002 (acceptance gate), ADR 0003 (deferred verification)
> **Deciders:** owner (Marco Jardim); implementation amendments and adversarial QA recorded in the plan and phase reports
> **Plan:** [`../plans/delegation-depth-and-effort-bump-plan.md`](../plans/delegation-depth-and-effort-bump-plan.md)

## Context

Issue #66 calls for a delegation-depth limit: identifying children to suppress the orchestrator
protocol does not itself stop a child from dispatching another child. Issue #67 calls for trying a
higher effort on the same model before paying for the next tier. The existing acceptance gate and
retry ladder provide the place for that step; neither a new agent family nor a new retry budget is
needed.

Observations by @MetalbolicX in opencode-smart-router (#17); implementation written from scratch.
No code from that project was used.

This record describes the shipped implementation, not the plan's superseded unconditional-block
or unconditional-four-attempt wording. Decisions D1–D11 below incorporate the binding amendments
in plan §1.7, including the owner's 2026-10-05 decisions to follow D6 literally and fix the v1
registration bug. Defaults from D12 are recorded with their actual mode and cost constraints.

## Decision

### D1 — Limit the depth of the child a dispatch would create

Root depth is 0; each `parentID` hop adds one. The guard judges `callerDepth + 1 > max`, not just
the caller's depth (`src/router/depth.ts`, `src/router/depth-guard.ts`).
`resolveDepthLimit` in `src/router/config.ts` defaults `enforcement.maxDelegationDepth` to **1**.
The accepted configuration is `null` (disable only this guard), or a safe integer **1–32**.
`MAX_DELEGATION_DEPTH_LIMIT = 32` equals the tracker's `MAX_DEPTH_HOPS` (A13), so corrupt ancestry
saturated at 32 exceeds every enabled limit when another dispatch is attempted.

At limit 1, roots may dispatch; children are refused only in **enforced** mode. The bundled default
is **advisory**, which warns and allows the dispatch. This does not change the delegation protocol.

### D2 — Unknown depth fails open; known contrary evidence is retained

`src/router/depth.ts` learns ancestry from creation events, authoritative backend answers and
plugin-created children. `src/index.ts` seeds successful root lookups, never the root-classifier's
fail-open default. Lazy backend walks are bounded, cycle-safe and memoized; concurrent callers
share work. A backend error, missing session or lookup deadline must not brick an orchestrator.
The default deadline is 2 seconds, with a 30-second failed-lookup retry throttle. When no depth
can be established, dispatch proceeds with one lookup warning per caller while its bounded
warning record is retained; tracker and guard share the plugin logger without double-warning.
Known lower bounds survive incomplete lookups rather than becoming root evidence.

A detected cycle or over-long chain is not an unknown depth: it saturates at `MAX_DEPTH_HOPS`.
Conflicting root/parent evidence retains the larger depth, rather than accepting whichever answer
arrived last. These are fail-closed depth decisions **under enforced mode**; advisory still warns.
The tracker's bounded caches, warning suppression and expiry make this a tracked-lifetime
guarantee, not an eternal record of ancestry.

### D3 — Plugin-created producers and graders are children

`recordPluginChild` records a producer (including each retry) or grader at creator depth + 1,
with a minimum depth of 1 when the creator is unavailable. A backend session with no `parentID`
does not override that plugin pin while it is retained (`src/router/depth.ts`).
`src/index.ts` registers producers before prompting and supplies the grader-creation callback to
the verification wiring. Native-path graders use the caller for the **depth record**, without
changing their backend parentage (the v1 native-path grader remains unparented).

The guard runs at the model's `delegate` dispatch, not again for each internal retry or grader.
Those sessions' own model-initiated dispatches are guarded at their recorded depth.

### D4 — Refuse before dispatch bookkeeping, but count the attempted tool call

For native `task`, `src/index.ts` runs the depth guard before `observeEdit`, reference capture,
`startDispatch`, prompt repair and header rewriting. An enforced refusal records a blocked tool
event and throws the D5 message, leaving no dispatch/verification state. Through
`src/compat/v2-hooks.ts`, the rejection also reaches the v2 host rather than being swallowed.

`delegate` checks before creating any session and **returns** the D5 text as a normal tool result;
native `task` exposes it as an error result. A known subagent's returned `delegate` refusal is
counted by the normal after-hook. A caller known only through backend depth evidence is explicitly
recorded on refusal. This avoids both a zero-tool-call false-refusal diagnosis and double-counting
known subagents (`src/index.ts`; QA-2.3-2 and QA-2.3-R2-4).

### D5 — Exact model-visible refusal

The template below is byte-exact from `depthLimitMessage` in `src/router/depth-guard.ts`
(`${depth}` and `${max}` are interpolated at runtime):

```text
[router] DELEGATION DEPTH LIMIT — this session is at delegation depth ${depth}; enforcement.maxDelegationDepth is ${max}, so it cannot dispatch another subagent. Do this part of the work yourself and report the result; do not retry the dispatch.
```

### D6 — Follow the existing enforcement switch, without a trivial downgrade

`src/index.ts` calls `resolveEnforcementMode` using `sessionStore.getTier(callerSessionID)` as
the caller's tier. The configured mode, environment gate and caller-tier override determine the
mode; this is not the target child's tier. The environment gate's `"1"` (enforced) and `"0"`
(off) take precedence; otherwise the caller's `enforcement.perTier` entry overrides
`enforcement.mode` (`src/router/enforcement.ts`). Thus `enforcement.mode: "enforced"` enforces
unless a caller-tier override changes it, while `MODEL_ROUTER_ENFORCE=1` forces enforcement.
With no `"1"`/`"0"` environment override, `enforcement.perTier` set to `"off"` for the caller's
tier disables its depth guard.

- **off:** no depth check or lookup.
- **advisory (default):** allow an over-limit dispatch and deliver the banner below.
- **enforced:** refuse with D5.

There is **no trivial-session downgrade** from enforced to advisory: a parent's classification of
a dispatch as trivial must not permit that child to evade the depth limit (A1).
The exact `depthAdvisoryBanner` template in `src/router/depth-guard.ts` is:

```text
[⚠ GUARD:delegation_depth] this session is at delegation depth ${depth}; enforcement.maxDelegationDepth is ${max}. In enforced mode this dispatch would have been refused. Do not dispatch further subagents from this session; do that work yourself.
```

Banner delivery is per call, independent of Layer-1 guard state and `isSubagent`.
On `delegate`, it follows the producer text and precedes the verification suffix or
deferred footer. V1 `task` uses the session/call-ID map in `src/index.ts`;
the v2 bridge owns delivery for v2, including a background `running` acknowledgement. Maps are
bounded at 1,000 entries. The banner is never graded or delivered twice. On v1 it precedes
verification text; on v2 it follows it (`src/compat/v2-hooks.ts`). A v1 task without a call ID
cannot receive a correlated banner and logs a warning. On v2, non-completed results get no
banner (`src/compat/v2-hooks.ts`). On v1, a failed call is expected not to reach the after-hook
(unverified); if it does not, its banner entry can remain until eviction or deletion.
The v1 after-hook itself has no result-status check.

### D7 — Bump only a tier whose effective effort is knowable

`effortCeilingFor` in `src/router/agent-options.ts` requires explicit valid `effort` and no
configured variant. It returns `null` for an unknown family, an effective Claude manual thinking
budget, or explicit OpenAI `reasoning.effort`. Adaptive-only Claude models ignore manual budgets,
so that ignored budget does not exclude an otherwise eligible tier. Claude's ceiling is `max`;
OpenAI's is `high`. The configured bump bound further clamps this ceiling.

`resolveEffortBump` in `src/router/config.ts` defaults `effortBump` to `true` and
`effortBumpMax` to `"xhigh"`. `src/escalate/ladder.ts` excludes tiers already at or above the
bound. An excluded tier keeps its ordinary retry: the router does not guess a provider default or
override variant/explicit-option precedence. These are builder-based ceilings, not a claim that
every live Claude endpoint accepts `xhigh`; users can lower the bound to `high`.

**D7 reach with bundled presets (A5):** the active/default `anthropic` preset has
no bumpable tier because every tier sets a variant. Only `fable-effort` fast and
medium are eligible at the default bump bound (`low → medium`, `high → xhigh`);
its heavy tier is already at that bound. Other bundled presets set a variant or
omit `effort`. See the [preset table](../CONFIG_REFERENCE.md#where-the-bump-applies-with-the-bundled-presets)
for the complete breakdown and D8 below for the separate cost-ceiling constraint.

### D8 — Replace retry settings, never add an attempt

`src/escalate/ladder.ts` moves one step through `low → medium → high → xhigh → max` on each
eligible same-tier retry, stopping at `min(ceiling, effortBumpMax)`. Further retries retain the
bound. Escalation clears `currentEffort` and uses the next tier's configured base effort.
Acceptance, unverifiable verdict handling, total-attempt limits, cost-ceiling ordering and tier
escalation remain in the existing ladder. With `effortBump: false`, no effort action/state is
introduced and the previous ladder/scorecard behaviour is retained.

The defaults are one same-tier retry (`maxAttemptsPerTier: 1`), four total attempts and a cost
multiple of 4. **Four attempts are not guaranteed** (A14). With the bundled `fable-effort` ratios
(fast 1, medium 3), repeated failures produce:

```text
v2.0.0: fast@low → fast@low    → medium@high → stop: cost ceiling exceeded
new:    fast@low → fast@medium → medium@high → stop: cost ceiling exceeded
```

After three attempts the cumulative ratio is 5, exceeding 1 × 4. Medium's bump therefore does
not run at defaults. Raising `enforcement.escalate.costCeiling.multiple` can permit the fourth
attempt, `medium@xhigh`, within the total-attempt limit. Each bumped attempt still costs the tier's
`costRatio` (`src/index.ts`): this is ratio-based accounting, not metered token cost, and no effort
multiplier was added.

### D9 — Apply per-producer effort through `chat.params`, using native keys

`src/escalate/effort-override.ts` stores only the effort keys produced by
`buildAgentOptions({ ...tier, effort })`: Claude `effort`, OpenAI `reasoningEffort`.
`src/index.ts` registers the override before the producer prompt, using the same configuration
snapshot as the attempt's model and ladder policy. Each LLM call applies it only when:

1. the producer session ID matches;
2. `input.agent` exactly matches the registered tier name; and
3. `providerID` and `modelID ?? id` match the registered model (case-insensitively).

This producer-only gate excludes title, grader, orchestrator and other-agent calls even when an
auxiliary v1 call shares the producer session ID. The host's default variant marker is ignored;
configured variant tiers are already excluded by D7. No agent is added for the bump.

The host seam is explicit: `routerHost === "v2"` writes flat into the bridge's `event.options`;
v1 writes `output.options`. The implementation does not infer the host from object shape or write
both layouts. Missing/invalid targets warn and skip, rather than creating an options bag.
Native effort keys overwrite the corresponding host value; an OpenAI snake-case alias is removed.
The independent grader-temperature pin is retained (`src/index.ts`, `src/compat/v2-hooks.ts`).

Overrides are cleared before disposal on the deferred path, per-attempt cleanup and the outer
`finally`, and on session deletion. The store is bounded to 1,000 entries; invalid replacement
registration clears an old entry instead of retaining stale effort (`src/escalate/effort-override.ts`).

**A4 — Fix v1 registration as well as retries.** `buildAgentOptions` now emits native
`reasoningEffort`, `reasoningSummary`, `thinking: { type: "enabled", budgetTokens }` and `effort`
instead of the old snake-case registration keys. Spike B showed that v1 silently dropped the old
keys. The v2 bridge already translated them; it still normalizes aliases in options merged into
agent definitions the router's `config` hook changed, but an explicit native key wins.
This intentional v1 behaviour change applies even with the bump off.
Existing explicit-config precedence and warnings are preserved (`src/router/agent-options.ts`,
`src/compat/v2-hooks.ts`).

### D10 — The bump belongs only to the router-driven ladder

Only `delegate` drives `nextAction`/`advance` in `src/index.ts`. Native-task retries remain the
orchestrator's decision and do not gain this effort step. A deferred return is not automatically
retried or labelled verified; the bump needs an actual ladder retry.

### D11 — This is an in-process dispatch guard, not a sandbox

The guard covers native `task` on v1 and the bridged v2 `subagent` path (foreground, background
and resume), plus `delegate`. It does **not** cover shell-launched `opencode` processes or
session-creating tools supplied by other plugins. `/bypass` disables the depth guard on **both**
dispatch paths, but **does not disable the effort bump**; caller-tier `enforcement.perTier: "off"`
also disables the guard subject to D6's environment precedence (`src/index.ts`,
`src/compat/v2-hooks.ts`; A11).

OpenCode 2 has its own independent nesting cap, `experimental.subagent_depth`, default **1**,
as captured on 2.0.22 in `docs/qa/depth-and-effort/phase-2.3.md`. When router enforcement is
enabled, the lower cap constrains dispatch; an advisory router limit is a warning, not a second
host block. Raising only the router key does not enable nesting on v2. The v2 proof also required
explicit `subagent` permission for `general`; v2 resumes only a direct child. The proof's v1
fixture used top-level `subagent_depth: 4`, but its default is unverified: this ADR does not turn
that fixture setting into a cross-version recommendation.

## Findings (evidence)

- **Spike B / Spike A2:** `docs/qa/depth-and-effort/phase-0P.md` records real OpenCode
  **1.18.19** and **2.0.22** runs against a keyless capturing stub. Native `chat.params` writes
  reach the marked session's HTTP request and win over registered agent options:
  Claude `effort` becomes `output_config.effort`; OpenAI `reasoningEffort` becomes
  `reasoning.effort`. Snake-case `reasoning_effort` is dropped by v1 and by a v2 hook write.
  Native-key hook and agent-registration requests agree. Spike A2 establishes that the caller's
  before-hook throws reach the model as error tool results for foreground/resume on both hosts
  and background on v2, without aborting the turn. It also captures the router producer's
  agent/model identity used by the A3 gate. V1 auxiliary title calls can share an unparented
  producer's session ID; a session-ID-only override is therefore insufficient.
- **Loaded-router host proof:** `docs/qa/depth-and-effort/phase-2.3.md` records **14/14**
  scenario/host combinations passing on those same versions, tested source
  `bc5205e48b990aded2030b9b2f9372b0c9cbdd23`. The evidence uses a scripted keyless provider
  against real OpenCode 1.18.19 and 2.0.22, recorded in
  `docs/qa/depth-and-effort/phase-0P.md` and `phase-2.3.md`. The owner retains the rig
  locally; the latter report records hashes, with `hashes.json` and `provenance.json`
  documenting the rig and copied plugin/dependency provenance. Captures show
  producer `low → medium`, a failing then passing grader, no title/grader/orchestrator effort
  leakage, and `low → low` with the bump disabled. They also cover exact enforced refusals and
  single advisory banners for foreground, resume and v2 background results. Every accepted run
  exits 0 with final `ok`.
- **Scope of that proof:** these are real hosts but stubbed providers, not evidence of upstream
  acceptance, cost or quality gains. Phase 2.3's subsequent QA found the v2 envelope loss in the
  retained captures and fixed it along with refusal counting and edge cases. The report records
  later unit/integration verification and host-shaped capture replays, **not a fresh host run**
  after those fixes. The 14/14 result must not be read as an end-to-end rerun of every final fix.
- **Trace and residual review:** `docs/qa/depth-and-effort/phase-1.1.md` establishes the 32 cap;
  `phase-1.2.md` records tracker residuals F2/F6; `phase-1.3.md` records the ratio ceiling and
  separate v2.0.0/new default traces; `phase-2.1.md` records mode/warning decisions; and
  `phase-2.2.md` records override replacement, identity gating and cleanup obligations. These
  filenames are all under `docs/qa/depth-and-effort/`. Plan A15 requires their handoffs to be
  consumed together, not just the latest phase report.

## Consequences

- **Availability over absolute containment.** Unknown depth fails open deliberately. An unavailable
  backend can permit a dispatch that would have been refused with complete evidence. Known
  ancestry is retained conservatively, but this is not a security boundary.
- **F2 — bounded retention can lose non-backend evidence.** Plugin-child pins, conflicts and
  excess depth floors are not ordinary LRU victims, but idle TTL expiry or logged pinned/held-ghost
  overflow can discard evidence the backend cannot reproduce (`src/router/depth.ts`,
  `docs/qa/depth-and-effort/phase-1.2.md`). The defaults are 10,000 tracked nodes
  (`DEFAULT_DEPTH_MAX_ENTRIES` in `src/router/depth.ts`) and a 60-minute idle TTL
  (`src/router/idle-sweep.ts`). Sweep retains ancestors within 32 hops of live descendants,
  including links remembered as ghosts, but a path already forgotten, expired or dropped from
  the ghost cap cannot protect an ancestor until re-fetched. A surviving unparented producer or
  native-path grader resumed after its pin expires can re-resolve as depth 0. Normal per-attempt
  producer disposal and bounded grader lifetimes mitigate this, not eliminate it; failed disposal
  followed by a late resume remains exposed (Phase 2.3 F5).
- **F6 — conflict protection needs both pieces of evidence at once.** If the first root/link
  evidence was evicted before contradictory evidence arrives, the contradiction is not pinned
  as such; a later eviction may leave a smaller backend answer. Phase 1.2 accepts this residual
  on the host assumption that events and `session.get` share the same immutable-parent session
  record. This is not a guarantee against arbitrary inconsistent event/backend histories.
- **Defaults warn rather than block.** Users must choose enforced mode to prohibit nested router
  dispatches. Host permissions and host nesting limits remain independent.
- **Provider cost is not predicted by the ratio ceiling.** Higher effort can cost more or take longer
  at the same recorded ratio. The v1 native-key fix can newly activate reasoning/thinking that was
  silently ignored, including configurations on OpenAI-compatible GPT providers or non-reasoning
  GPT models. Whether every such endpoint strips unsupported reasoning options is unverified.
  The builder also retains pre-existing permissive explicit fields: non-Claude `reasoning.*`
  and manual thinking budgets on otherwise unknown families can now reach v1. Bedrock Claude
  detection remains outside this change, with a null bump ceiling (Phase 1.3 F2/F3).
  Remove `effort`, `reasoning.*` or `thinking` from an affected tier if necessary. A keyless capture
  proves serialization, not live-provider acceptance.
- **No new bump agents or protocol tokens.** Per-session overrides avoid changing the task tool's
  agent list. Phase 2.3 reports unchanged protocol/golden snapshots and prompt measurements.
- **V2 result envelopes are preserved where possible.** The bridge retains host text content and
  its resume handle, appending router notes separately when the routed output is the child text
  plus a suffix (after trimming trailing whitespace). Missing host text or a non-suffix rewrite
  falls back to the full routed text while retaining non-text attachments. This also improves
  verified results without a depth banner compared with v2.0.0 (`src/compat/v2-hooks.ts`).

## Alternatives rejected

- **Derived hidden agents per effort level.** They would add agents the task tool can list and
  expand the registration surface. Session-keyed overrides need no new agents.
- **Per-prompt variant as the effort mechanism.** The primary hook mechanism works on both hosts.
  Claude catalog variants are thinking budgets, not interchangeable effort levels. The v1 HTTP
  API does honour per-message variants, but OpenCode 2 has no per-message variant; the fallback
  is neither necessary nor an equivalent cross-host mechanism (Spike B/A3).
- **Shape sniffing in `chat.params`.** A property named `options` is not a host-version contract.
  The explicit `routerHost` seam selects one destination and prevents accidental nested v2 bags.
- **Hard-block at the bundled advisory default.** This would contradict D6's enforcement switch.
  A1 instead makes the warning visible and leaves enforcement an explicit mode choice.
