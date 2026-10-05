# Phase 2.2: per-session effort override store (M5, D9). QA review

Branch `de/p22` (worktree `D:\git\omr-de-p22`), reviewed range `b18eab5..9e7ce93`:
`d415aa6` feat (`src/escalate/effort-override.ts`, 126 lines), `9e7ce93` test (`test/unit/effort-override.test.ts`,
284 lines). Issue #67.
Reviewer: adversarial senior QA (`[tier:heavy]`, CAP:none). The reviewer did not write this code.
Reviewed against: plan Phase 2.2 (`:1180-1245`), §1.7 A3 (`:540-589`), A4 (`:590-618`), A8 (`:639-644`), A15
(`:688-695`); `src/router/agent-options.ts` (`buildAgentOptions`, `effortCeilingFor`, warn-once); `src/router/protocol.ts:149-181`;
`src/router/logger.ts`; the `chat.params` hook and the producer lifecycle in `src/index.ts`; the v2 bridge in
`src/compat/v2-hooks.ts:31-35, 118-135, 211-217`; and the Spike B evidence
(`C:\Users\Marquinho\AppData\Local\Temp\Claude\spike-b\REPORT.md`: Verdict and Q1–Q5 `:3-27`, v1 hook logs `:876-965`,
v1 hook signature `:1594-1612`, "Extension — native option keys" `:2266-2318`, "Title generation versus the producer call"
`:2362-2463`, Spike A2 R5 `:2833-2959`).

## Pre-flight

| Check | Result |
|---|---|
| Worktree base | `de/wave-2-base` = `b18eab5` (verified: `git rev-parse de/wave-2-base`, ancestor of `HEAD`) |
| `npm ci` + `npm run typecheck` (base) | OK |
| Capped full suite, run once on the identical tree on `de/main` | **105 files passed / 3 skipped; 7789 tests passed / 65 skipped** |
| Diff `b18eab5..9e7ce93` | 2 files, +410 lines; nothing else touched |
| `npm run typecheck` at `HEAD` `9e7ce93` (this review) | Clean (`tsc --noEmit`, no diagnostics) |
| Scoped run at `HEAD`: `npx vitest run test/unit/effort-override.test.ts test/unit/effort-ceiling.test.ts --maxWorkers=50%` | **2 files, 4884 tests passed** (1142 in `effort-override`, 3742 in `effort-ceiling`) |
| Coverage, `effort-override.ts` only (`--coverage.enabled=true --coverage.include=src/escalate/effort-override.ts`) | **100 %** statements (69/69), branches (61/61), functions (8/8), lines (63/63) |

Handoffs addressed to 2.2 (A15), all reports from `phase-0P.md` to `phase-2.1.md` searched:

| From | Handoff | Status in the code |
|---|---|---|
| `phase-0P.md:300` (A3) | Target options object chosen by the caller, no creation, producer-only gate, native keys | **Applied.** `applyEffortOverride(store, input, target, logger)` writes only into `target` (`:93-126`); a non-object target warns once per entry and is never created (`:108-115`); gate on `sessionID`, `agent === tierName` and `providerID` + `modelID ?? id` (`:100-107`), variant ignored; keys come from the builder (`:63-67`). |
| `phase-1.3.md:368-372` | Call `buildAgentOptions({ ...tier, effort })`, never re-derive keys; ceiling and builder agree by construction; Bedrock Claude is unknown (F2) | **Applied.** `:63` calls the builder; `:58-62` refuses above `effortCeilingFor(tier)` first; a Bedrock id gets a `null` ceiling and is refused. The ceiling refusal that 1.3 deferred "to a later phase" is here (`:58-62`). |
| `phase-1.1.md:169`, `phase-1.2.md`, `phase-2.1.md` | No handoff addressed to 2.2 | n/a |

Method and limits:
- Adversarial inputs were run as two scratch files in `test/scratch/` (15 cases) against the real store, the real
  `buildAgentOptions` and the real warn-once set. Both files were deleted before committing; `git status` was clean afterwards.
- No host was run. Statements about OpenCode come from the Spike B / A2 captures cited above; anything beyond them is marked
  **unverified**. The full suite was not re-run at `HEAD`.

## Implementation notes

**Built (`d415aa6`):** `src/escalate/effort-override.ts`.
- API = plan 2.2.1 as amended by A3: `set / clear / has / size`, `createEffortOverrideStore({ maxEntries?, logger? })`
  (the `logger` option is an addition; it defaults to `console`), `applyEffortOverride(store, input, target, logger)`, and
  `EFFORT_OVERRIDE_KEYS = ["effort", "reasoningEffort"]`. Entries live in a module `WeakMap` keyed by the store, so callers
  cannot reach the saved keys.
- `set` (`:46-83`): validates the arguments, requires a `provider/model` identity, refuses an effort above
  `effortCeilingFor(tier)` (a `null` ceiling refuses everything), then calls the builder **once** and snapshots only the
  `effort` / `reasoningEffort` keys plus `tier.model`. A successful re-set replaces the entry and refreshes its age; the
  oldest entry beyond `maxEntries` (default 1 000) is evicted with a warning. Every failure is a warning, never a throw.
- `applyEffortOverride` (`:93-126`): no-op unless the session has an entry **and** `input.agent === tierName` **and**
  `providerID` / `modelID ?? id` equal the two halves of the stored model, split at the first `/`. A missing or non-object
  target warns once per entry. Otherwise it overwrites the stored keys; when writing `reasoningEffort` it also deletes the
  snake-case `reasoning_effort`.

**Tests (`9e7ce93`):** 1142 cases. They cover non-producer inputs (title agent, other session, foreign model, malformed
model), the host shapes (v1 `id`, v2 bridge `modelID` and `variant: "default"`), nested ids, the missing-target latch,
unwritable targets and throwing getters, a throwing logger, `clear`, invalid arguments, the ceiling and unbumpable tiers,
the builder spy (called once, tier snapshotted), eviction, the default capacity, invalid capacities, and builder agreement
over 16 models × 4 `thinking` × 4 `reasoning` × 5 efforts.

**Merge semantics against Spike B (no finding):**
- *The hook write wins and reaches the wire.* Spike B case d (`REPORT.md:2303, 2318`): agent `reasoningEffort: "low"` plus a
  hook `reasoningEffort: "high"` sends `reasoning.effort: "high"` on v1 and v2. Claude `effort` lowers to `output_config.effort`
  on both (`:5, 23`). The v2 bridge merges agent options into `event.options` only when the key is absent, then calls the
  legacy hook (`v2-hooks.ts:213-217`), so the override overwrites the registered key there too.
- *No renamed effort key survives the bump.* Base and bump are built from the same `tier.model`, so they are in the same
  family and use the same native key (`agent-options.ts:159-185`). The only alias is the legacy `reasoning_effort`, which v1
  and a v2 hook write both drop silently (`REPORT.md:5, 27`); the module deletes it anyway (`:120`).
- *Keys deliberately left on the target* (scratch S6). OpenAI target: `reasoning: { effort }` and a stray `effort` are kept.
  Claude target: `thinking`, `reasoningEffort` and `output_config` are kept. None of them comes from the builder for a bumpable
  tier. A Claude tier with a winning budget has a `null` ceiling. An adaptive-only budget is dropped by the builder
  (`agent-options.ts:117-123`). Variant tiers have a `null` ceiling, so a variant's option cannot contradict a bump. The hosts
  add none of them for the captured models: v1 R5 Claude options are `{}` (`REPORT.md:2858`), v2 R5 options are
  `{ maxTokens }` (`:2915-2917`), and the Fable effort-only captures have no `thinking` (`:2360`). A user's model-level
  `thinking` would be sent together with the base effort and the bumped effort alike (Spike B case h, `:2306, 2318`). The
  bump does not introduce that conflict.

**Verified adversarially (no finding):**
- *Leak to another session or agent* (scratch S5, producer set to `high`, every target starting at `low`):
  - left at `low`: a v1 title call on the producer session with the producer's model or with `gpt-5.4-nano`; a v2 title
    shape (no `agent`) on the producer session; `agent: "compaction"`; the grader session with the grader agent or with
    `agent: "fast"`; the orchestrator;
  - changed to `high`: only the producer.
- *Producer identity* (scratch S4) matches for `github-copilot/gpt-5`, `openrouter/openai/gpt-5` (id `openai/gpt-5`), the v2
  bridge shape `{ id, modelID, variant: "default" }` and `variant: "none"`. A3's real producer
  (`fast`, `anthropic`, `claude-sonnet-4-5`, `REPORT.md:2959`) is the test's own shape. These do not match: a dated tier against
  an undated host id; `github-copilot` against a `github-copilot-enterprise` host; `modelID: ""`; a tier model with a trailing
  space. None of those is a realistic producer: the producer's prompt names the tier's own `provider/model`
  (`index.ts:637, 654-668`, `tierModel` splits at the first `/`, `verify/dispatch.ts:564-577`), and the host's `model.id` is
  the catalog key that was asked for. This last point is **unverified** beyond the captured models. Mixed case: QA-2.2-3.
- *Ceiling:* a tier mutated after `set` has no effect (tested). If the model changes between `set` and apply, the gate
  mismatches and the call is a no-op, not a bypass. The one exception is an accessor tier (QA-2.2-5). A refused re-set is
  QA-2.2-1.
- *Growth:* entries are capped (scratch S12: a never-cleared producer keeps its override until 1 000 newer `set`s, then is
  evicted with one warning). The missing-target latch lives on the entry. The builder's module-global warn-once set: see
  QA-2.2-2.
- *Prototype keys* (scratch S3b): session id and tier name `__proto__` set, apply and clear correctly, with no pollution of
  `Object.prototype`. `constructor`, `hasOwnProperty` and `toString` work too; an unset `valueOf` stays a no-op.
- *Warn-once agreement, steady state* (scratch S2b): when registration has already run with the same tier name and the same
  tier, `set` emits **0** extra warnings, because every warning the builder can reach for a tier that passes the ceiling
  (`reasoning-claude:`, `thinking-zero:`, `thinking-adaptive-only:`) has a key that registration already consumed. The
  `openai-downgrade` and conflict keys cannot be reached, because the ceiling refuses those tiers first. The channel defect is
  QA-2.2-2.
- *Downgrade:* `set` accepts an effort below the tier's base (scratch S10, `high` → `low`). Plan 2.2.1 asks only for the
  ceiling, and the ladder guarantees bump > base (1.1/1.3). Accepted.

## Findings

| id | severity | file:line | description | resolution |
|---|---|---|---|---|
| QA-2.2-1 | major | `src/escalate/effort-override.ts:48-71, 72, 80-82` | **A refused `set` leaves the session's previous override live, so the old value survives a refusal.** Every refusal returns before `entries.delete(sessionID)` (`:72`), and so does the `catch` (`:80-82`). A re-set that the store rejects therefore keeps the old entry, and apply keeps writing it. **Failing inputs** (scratch S1, session `p`, OpenAI producer): <br>(a) `set(p, "fast", openai@low, "high")`, then `set(p, "fast", { ...openai, reasoning: { effort: "low" } }, "medium")`: refused with "exceeds the tier ceiling", because the ceiling is `null` (explicit `reasoning.effort` must never be bumped). `has(p)` is still `true`, and apply turns a target `{ reasoningEffort: "low" }` into **`"high"`**: the explicit config is overridden by a stale bump. <br>(b) Re-set with `"xhigh"` (above the ceiling) → refused, and apply still writes `"high"`. <br>(c) Re-set with model `"gpt-5"` (no provider) → refused, and apply still writes `"high"`. <br>(d) By reading, the same happens when the builder throws on a re-set (`:80-82`). <br>This is the critical class (an override surviving with a wrong value, against a `null` ceiling), but it is **latent**. The planned wiring calls `set` once per fresh producer session: v1 creates a new session per attempt (`index.ts:627-634`), and v2's `onCreated` fires once per child (`v2-client.ts:101-106`; a changed child id throws). Hence major, not critical. Any later re-set of a live session (a per-turn effort change, a resumed producer) makes it critical. **Fix:** a `set` replaces the entry or clears it. Delete the session's entry before validating (when `sessionID` is a string) and in the `catch`, then pin (a)–(c) in tests. | open |
| QA-2.2-2 | minor | `src/escalate/effort-override.ts:63`; `src/router/agent-options.ts:29-43`; `src/router/logger.ts:4-5`; `test/unit/effort-override.test.ts:270` | **Builder warnings raised at `set` time bypass the injected logger and go to `console.warn`, which paints over the TUI.** `set` calls `buildAgentOptions({ ...tier, effort }, tierName)` with no logger, so the builder's warn-once falls back to `console.warn` (`agent-options.ts:38-42`). The store's own `logger` is not threaded through. `logger.ts:4-5`: "`console.warn` from a plugin lands on the server process's stderr, which the TUI does not own, so anything written there paints over whatever the terminal…". **Failing inputs** (scratch S2, fresh warn-once set): `set("a","fast",{ sonnet@low, reasoning: { summary: "auto" } },"medium")`, `set("b","medium",{ "anthropic/claude-fable-5-1"@low, thinking: { budgetTokens: 8000 } },"high")` and `set("c","heavy",{ sonnet@low, thinking: { budgetTokens: 0 } },"high")` are all accepted. The result is **3 lines on `console.warn`** and **0** on the injected logger. **When it happens:** never in steady state (S2b: 0 lines when registration ran first with the same name and tier). It does happen when the delegate's config snapshot differs from the registration-time config, which is exactly what the 1.3 handoff "one `activeCfg` snapshot" causes after a `tiers.json` edit. S2b: registration with `reasoning.summary`, then a hot edit adds `thinking.budgetTokens: 0`, and the first `set` prints `[model-router] tier fast: thinking.budgetTokens: 0 is ignored` to the console. **Secondary:** `set` feeds the module-global, uncapped warn-once set with caller-supplied tier names. S9: 5 000 distinct tier names gave 5 000 console lines and 5 000 new keys. 2.3 passes configured tier names only, so this is bounded in practice. The agreement test silences `console.warn` (`test:270`), which is why the suite cannot see the problem. **Fix:** pass an adapter of the store's logger into the builder (`{ warn: (m) => warn(logger, m), flush: async () => {} }`), or suppress builder warnings at `set` time on purpose (they are registration diagnostics). Assert in a test that `console.warn` is not called. | open |
| QA-2.2-3 | minor | `src/escalate/effort-override.ts:53-57, 105-107`; `test/unit/effort-override.test.ts:252-253, 278` | **The identity gate is case-sensitive, while the rest of the effort path ignores case.** `isClaudeModel`/`isOpenAIModel` lower-case the model (`protocol.ts:151`, `agent-options.ts:54`), so `effortCeilingFor` gives a mixed-case tier a ceiling, the ladder bumps it, and `set` accepts it with no warning. Apply then compares `providerID` and the id case-sensitively. **Failing input** (scratch S4): `set(s,"fast",{ model: "OpenAI/GPT-5", effort: "low" },"medium")` is accepted, and a host model `{ providerID: "openai", id: "gpt-5" }` leaves the target `{}`, a silent no-op. The agreement test feeds the host shape from the tier's own spelling (`providerID: "OpenAI", id: "GPT-5"`, `test:278`), so it pins a host shape that the captures never show (every captured id is lower-case, `REPORT.md:2322-2348, 2382-2399`). **Unverified:** whether OpenCode resolves `OpenAI/GPT-5` at all. If it does not, the attempt fails with or without the bump and this is cosmetic. If it normalises, this is a realistic silent no-op (major). **Fix:** compare `providerID` and model id case-insensitively. That cannot widen the gate to another session or agent, because `sessionID` and `agent` stay exact. Otherwise refuse mixed case in `set` with a warning. Either way, change `test:278` to the lower-case host shape. | open |
| QA-2.2-4 | minor | `test/unit/effort-override.test.ts:50-65` | **Missing pins for two gate inputs from the plan's leak focus.** Scratch S3b and S5 pass, but no test asserts them: <br>(1) prototype-key ids: session id and tier name `__proto__` / `constructor` set, apply and clear correctly, and `Object.prototype` is untouched; <br>(2) the v2 title shape on the producer session with the producer's own model and **no `agent` key**, which A3 / Spike B show as `agent: "<absent>"` with `id: "gpt-5"` (`REPORT.md:2444-2459`). The `{}` row (`test:51`) has no `sessionID`, and `agent: {}` (`test:52`) is a different input. <br>Add both to the non-producer table (2) and as a small `it` (1). | open |
| QA-2.2-5 | nit | `src/escalate/effort-override.ts:48-73` | **`tier` is read up to six times in `set` (validation, ceiling, spread, stored model), so the keys and the stored model can come from different reads.** Plain JSON tiers cannot do this. An accessor or Proxy tier can. **Input** (scratch S7b): a `model` getter returns `anthropic/claude-sonnet-4-5` on reads 1–5 and `openai/gpt-5` on read 6. The result is an entry for `openai/gpt-5` holding the Claude key `effort: "max"`, and an OpenAI producer's target gains `effort: "max"`. The plan's ceiling is not crossed on the wire, because OpenAI ignores `effort`, but the entry is incoherent. **Fix:** snapshot once at entry (`const t = { ...tier }`) and use `t` throughout. | open |
| QA-2.2-6 | nit | `src/escalate/effort-override.ts:117-125` | **Apply failures warn on every LLM call, and a partial write is reported as a failure.** The missing-target warning is latched per entry (`:110-113`), but the `catch` warning is not. **Inputs** (scratch S8): a frozen target, applied 10 times, gives **10 warnings**. A target whose `reasoning_effort` is non-configurable ends up `{ reasoningEffort: "high", reasoning_effort: "low" }`: the native key was applied, yet the store logs "Failed to apply effort override". Neither target is a realistic host object. **Fix:** latch the failure warning on the entry like `warnedMissingTarget`, and word the alias-delete failure separately (or ignore it, since both hosts drop the alias). | open |
| QA-2.2-7 | nit | `src/escalate/effort-override.ts:26`; `src/router/logger.ts:57-58, 106, 119` | **The store adds a `[model-router] ` prefix itself, so messages through the plugin logger carry it twice on the console fallback and redundantly in the service log.** `createPluginLogger` already posts with `service: "model-router"` and prefixes only its console fallback. The builder passes unprefixed text to the plugin logger (`agent-options.ts:38-40`). **Input** (scratch S11, a logger that behaves like the plugin logger's fallback): eviction prints `[model-router] [model-router] Evicted oldest effort override for a`. **Fix:** prefix only when the default `console` logger is used, or never, as `agent-options.ts` does. | open |

Severity summary at review: **0 critical, 1 major, 3 minor, 3 nits; 7 open.**

## Deferred by plan

- All wiring is Phase 2.3 (2.3.4, 2.3.5): the per-plugin store, `set` / `clear` around each producer attempt (A8), the
  `chat.params` call and the A3 host seam (`routerHost`, `src/v2.ts`, `RouterPluginInput`), the v2 bridge registration
  translation where an explicit native key wins over its alias (A4), the bridge test that `event.options` never gains an
  `options` key, an unchanged grader temperature, and the integration tests (2.3.6).
- The host-level proof is a gate for 2.3 (A3): a copy of the Spike A2 rig with a scripted failing first attempt. The retry
  producer's request must carry the bumped effort; the first attempt's, the title's and the grader's must not. The scripted
  smoke legs 3.2.1(c)/(d) are mandatory (3.2).
- Provider-side acceptance of bumped values is not provable keylessly (A5) and belongs to the 1.3 builder policy, which the
  store must follow by construction. Examples: `xhigh`/`max` on a given Claude model; Copilot Claude, which the regex
  classifies as Claude and so receives `effort` through an OpenAI-compatible SDK; OpenRouter GPT tiers, which receive
  `reasoningEffort` rather than OpenRouter's `reasoning: { effort }`. All **unverified**.
- The per-prompt `variant` fallback is not built (A3: the primary mechanism works on both hosts).
- Documentation of the key names and of the v1 behaviour change: Phase 3.1 (A4).

## Handoffs

**To 2.2 (implementer, fix round):** QA-2.2-1 to QA-2.2-7 above. For QA-2.2-2 and QA-2.2-3, record the decision taken in
the resolution column. That includes the rationale if the case-sensitive gate is kept.

**To 2.3 (apply in its pre-flight, A15):**

1. **Construct one store per plugin instance** and pass it the plugin logger. Without one it defaults to `console`, which
   paints over the TUI (`logger.ts:4-5`):
   `const effortOverrides = createEffortOverrideStore({ logger: { warn: (m) => logger.warn(m) } });`
   Pass the same adapter as the `logger` argument of every `applyEffortOverride` call. Until QA-2.2-2 is fixed, warnings the
   builder raises inside `set` still go to `console.warn`.
2. **Where to call `set`:** inside `registerProducer(sid)` (`index.ts:609-625`). That covers both hosts: v1 awaits it after
   `session.create` and before `session.prompt` (`:627-634`); v2 awaits it in the native subagent's `onCreated` before the
   child is prompted (`:661`, A8). Call it only when `effort` is defined:
   `effortOverrides.set(sid, tier, getActiveTiers(activeCfg)[tier], effort)`.
   - `tierName` must be the exact agent name sent with the prompt (`agent: tier`, `:657, 666`), or the gate never matches.
   - The `TierConfig` must come from the **same `activeCfg` snapshot** that `tierModel(activeCfg, tier)` (`:637`) uses for
     the prompt's `model`. Otherwise the identity gate compares against a different model and silently no-ops (phase-1.3
     "one config snapshot").
   - Call `set` once per producer session. Until QA-2.2-1 is fixed, a refused re-set keeps the old value, so never re-set a
     live session without `clear` first.
3. **Where to call `clear(producerSid)`:** at all three exits.
   - The deferred-verification early return (`:706-721`, next to its `guardStore.clear`).
   - The per-attempt cleanup (`:833-848`).
   - The outer `finally` loop over `producerSessions` (`:921`). A8 requires this explicitly, because a throw between
     `registerProducer` and the per-attempt cleanup reaches only this loop.

   In each case, call `clear` before `disposeChildSession`. The store has no TTL. A missed `clear` keeps the override on that
   session until 1 000 newer `set`s evict it, for example when the session is resumed through native `task` with `task_id`.
4. **Where to call `applyEffortOverride`:** in `"chat.params"` (`index.ts:980`), in its own `try`, independent of the
   `graderSessions` branch (`:982`); a session is never both. Choose the target with the A3 host seam:
   `applyEffortOverride(effortOverrides, input, ctx.routerHost === "v2" ? output : output?.options, overrideLogger)`.
   - v1 writes `output.options`. v2 writes `event.options`, which the bridge passes as `output` (`v2-hooks.ts:217`). Never
     write both, and never create `output.options`: a missing target already gives one warning per entry.
   - The bridge's `input.model = { ...event.model, modelID: event.model.id }` (`v2-hooks.ts:212`) already satisfies the
     `modelID ?? id` gate.
   - Decide explicitly whether `/bypass` (A11) skips the apply. Today `chat.params` does not check `bypassed`, and the
     `delegate` tool does not either (A11).
5. **Tests for 2.3.6, through the plugin factory:**
   - a v1 title call (`agent: "title"`) on the producer session, the grader session and the orchestrator are unchanged;
   - the retry producer's options carry exactly `buildAgentOptions({ ...tier, effort })`'s effort key;
   - `clear` runs on success, failure, timeout, abort and the deferred path;
   - v2 `event.options` never gains `options`.

## Verdict

**Not ready to merge.** The override's core behaves as A3 requires:
- the gate keeps the override off every non-producer call that was tried;
- the keys are the builder's native keys;
- the hook write wins over registered options, per Spike B;
- the store is bounded;
- nothing throws;
- coverage is 100 %.

Open: **QA-2.2-1 (major**: a refused re-set keeps a stale override, latent under the planned wiring), QA-2.2-2/-3/-4
(minor: builder warnings to the console, a case-sensitive identity gate, two missing gate pins) and QA-2.2-5/-6/-7 (nits).
The phase DoD requires zero open findings.
