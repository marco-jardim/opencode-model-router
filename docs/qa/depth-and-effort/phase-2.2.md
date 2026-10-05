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
| QA-2.2-1 | major | `src/escalate/effort-override.ts:48-71, 72, 80-82` | **A refused `set` leaves the session's previous override live, so the old value survives a refusal.** Every refusal returns before `entries.delete(sessionID)` (`:72`), and so does the `catch` (`:80-82`). A re-set that the store rejects therefore keeps the old entry, and apply keeps writing it. **Failing inputs** (scratch S1, session `p`, OpenAI producer): <br>(a) `set(p, "fast", openai@low, "high")`, then `set(p, "fast", { ...openai, reasoning: { effort: "low" } }, "medium")`: refused with "exceeds the tier ceiling", because the ceiling is `null` (explicit `reasoning.effort` must never be bumped). `has(p)` is still `true`, and apply turns a target `{ reasoningEffort: "low" }` into **`"high"`**: the explicit config is overridden by a stale bump. <br>(b) Re-set with `"xhigh"` (above the ceiling) → refused, and apply still writes `"high"`. <br>(c) Re-set with model `"gpt-5"` (no provider) → refused, and apply still writes `"high"`. <br>(d) By reading, the same happens when the builder throws on a re-set (`:80-82`). <br>This is the critical class (an override surviving with a wrong value, against a `null` ceiling), but it is **latent**. The planned wiring calls `set` once per fresh producer session: v1 creates a new session per attempt (`index.ts:627-634`), and v2's `onCreated` fires once per child (`v2-client.ts:101-106`; a changed child id throws). Hence major, not critical. Any later re-set of a live session (a per-turn effort change, a resumed producer) makes it critical. **Fix:** a `set` replaces the entry or clears it. Delete the session's entry before validating (when `sessionID` is a string) and in the `catch`, then pin (a)–(c) in tests. | Resolved in `6257ca7`: delete before validation and again in catch. Regressions cover explicit reasoning, above-ceiling effort, missing provider, invalid effort, throwing builder and empty builder keys; refused re-sets leave no live override. |
| QA-2.2-2 | minor | `src/escalate/effort-override.ts:63`; `src/router/agent-options.ts:29-43`; `src/router/logger.ts:4-5`; `test/unit/effort-override.test.ts:270` | **Builder warnings raised at `set` time bypass the injected logger and go to `console.warn`, which paints over the TUI.** `set` calls `buildAgentOptions({ ...tier, effort }, tierName)` with no logger, so the builder's warn-once falls back to `console.warn` (`agent-options.ts:38-42`). The store's own `logger` is not threaded through. `logger.ts:4-5`: "`console.warn` from a plugin lands on the server process's stderr, which the TUI does not own, so anything written there paints over whatever the terminal…". **Failing inputs** (scratch S2, fresh warn-once set): `set("a","fast",{ sonnet@low, reasoning: { summary: "auto" } },"medium")`, `set("b","medium",{ "anthropic/claude-fable-5-1"@low, thinking: { budgetTokens: 8000 } },"high")` and `set("c","heavy",{ sonnet@low, thinking: { budgetTokens: 0 } },"high")` are all accepted. The result is **3 lines on `console.warn`** and **0** on the injected logger. **When it happens:** never in steady state (S2b: 0 lines when registration ran first with the same name and tier). It does happen when the delegate's config snapshot differs from the registration-time config, which is exactly what the 1.3 handoff "one `activeCfg` snapshot" causes after a `tiers.json` edit. S2b: registration with `reasoning.summary`, then a hot edit adds `thinking.budgetTokens: 0`, and the first `set` prints `[model-router] tier fast: thinking.budgetTokens: 0 is ignored` to the console. **Secondary:** `set` feeds the module-global, uncapped warn-once set with caller-supplied tier names. S9: 5 000 distinct tier names gave 5 000 console lines and 5 000 new keys. 2.3 passes configured tier names only, so this is bounded in practice. The agreement test silences `console.warn` (`test:270`), which is why the suite cannot see the problem. **Fix:** pass an adapter of the store's logger into the builder (`{ warn: (m) => warn(logger, m), flush: async () => {} }`), or suppress builder warnings at `set` time on purpose (they are registration diagnostics). Assert in a test that `console.warn` is not called. | Resolved in `aac9447`: pass a fail-soft PluginLogger-shaped adapter to the builder, rather than suppress diagnostics. All three warning cases assert zero console calls and one injected warning across repeated sets. Global warn-once is unchanged; agreement tests now assert console silence. |
| QA-2.2-3 | minor | `src/escalate/effort-override.ts:53-57, 105-107`; `test/unit/effort-override.test.ts:252-253, 278` | **The identity gate is case-sensitive, while the rest of the effort path ignores case.** `isClaudeModel`/`isOpenAIModel` lower-case the model (`protocol.ts:151`, `agent-options.ts:54`), so `effortCeilingFor` gives a mixed-case tier a ceiling, the ladder bumps it, and `set` accepts it with no warning. Apply then compares `providerID` and the id case-sensitively. **Failing input** (scratch S4): `set(s,"fast",{ model: "OpenAI/GPT-5", effort: "low" },"medium")` is accepted, and a host model `{ providerID: "openai", id: "gpt-5" }` leaves the target `{}`, a silent no-op. The agreement test feeds the host shape from the tier's own spelling (`providerID: "OpenAI", id: "GPT-5"`, `test:278`), so it pins a host shape that the captures never show (every captured id is lower-case, `REPORT.md:2322-2348, 2382-2399`). **Unverified:** whether OpenCode resolves `OpenAI/GPT-5` at all. If it does not, the attempt fails with or without the bump and this is cosmetic. If it normalises, this is a realistic silent no-op (major). **Fix:** compare `providerID` and model id case-insensitively. That cannot widen the gate to another session or agent, because `sessionID` and `agent` stay exact. Otherwise refuse mixed case in `set` with a warning. Either way, change `test:278` to the lower-case host shape. | Resolved in `1413188`: case-insensitive provider/model comparison agrees with ceiling/builder classification; session and agent remain exact. Tests cover mixed-case tiers with lowercase host id/modelID, uppercase hosts, exact session/agent gates, and lowercase agreement fixtures. |
| QA-2.2-4 | minor | `test/unit/effort-override.test.ts:50-65` | **Missing pins for two gate inputs from the plan's leak focus.** Scratch S3b and S5 pass, but no test asserts them: <br>(1) prototype-key ids: session id and tier name `__proto__` / `constructor` set, apply and clear correctly, and `Object.prototype` is untouched; <br>(2) the v2 title shape on the producer session with the producer's own model and **no `agent` key**, which A3 / Spike B show as `agent: "<absent>"` with `id: "gpt-5"` (`REPORT.md:2444-2459`). The `{}` row (`test:51`) has no `sessionID`, and `agent: {}` (`test:52`) is a different input. <br>Add both to the non-producer table (2) and as a small `it` (1). | Resolved in `e1cdfd9`: set/apply/clear tests for `__proto__`, `constructor`, `toString` as session and agent, with unchanged Object.prototype descriptors; v2 title input has the producer session/model but no agent and remains a no-op. |
| QA-2.2-5 | nit | `src/escalate/effort-override.ts:48-73` | **`tier` is read up to six times in `set` (validation, ceiling, spread, stored model), so the keys and the stored model can come from different reads.** Plain JSON tiers cannot do this. An accessor or Proxy tier can. **Input** (scratch S7b): a `model` getter returns `anthropic/claude-sonnet-4-5` on reads 1–5 and `openai/gpt-5` on read 6. The result is an entry for `openai/gpt-5` holding the Claude key `effort: "max"`, and an OpenAI producer's target gains `effort: "max"`. The plan's ceiling is not crossed on the wire, because OpenAI ignores `effort`, but the entry is incoherent. **Fix:** snapshot once at entry (`const t = { ...tier }`) and use `t` throughout. | Resolved in `f9208c8`: snapshot each field once before tier validation, ceiling calculation and builder use. Proxy regression counts one read per field and proves Claude keys cannot be stored against a later OpenAI model read. |
| QA-2.2-6 | nit | `src/escalate/effort-override.ts:117-125` | **Apply failures warn on every LLM call, and a partial write is reported as a failure.** The missing-target warning is latched per entry (`:110-113`), but the `catch` warning is not. **Inputs** (scratch S8): a frozen target, applied 10 times, gives **10 warnings**. A target whose `reasoning_effort` is non-configurable ends up `{ reasoningEffort: "high", reasoning_effort: "low" }`: the native key was applied, yet the store logs "Failed to apply effort override". Neither target is a realistic host object. **Fix:** latch the failure warning on the entry like `warnedMissingTarget`, and word the alias-delete failure separately (or ignore it, since both hosts drop the alias). | Resolved in `7e129fd`: bounded per-entry failure and alias-deletion latches. Ten repeated failures emit once; partial native-key success has one distinct warning. Tests cover throwing inputs, frozen targets, distinct failure kinds and latch cleanup on clear/eviction. |
| QA-2.2-7 | nit | `src/escalate/effort-override.ts:26`; `src/router/logger.ts:57-58, 106, 119` | **The store adds a `[model-router] ` prefix itself, so messages through the plugin logger carry it twice on the console fallback and redundantly in the service log.** `createPluginLogger` already posts with `service: "model-router"` and prefixes only its console fallback. The builder passes unprefixed text to the plugin logger (`agent-options.ts:38-40`). **Input** (scratch S11, a logger that behaves like the plugin logger's fallback): eviction prints `[model-router] [model-router] Evicted oldest effort override for a`. **Fix:** prefix only when the default `console` logger is used, or never, as `agent-options.ts` does. | Resolved in `b614909`: store emits self-explanatory unprefixed text. Tests pin a single plugin-style fallback prefix and unprefixed default console output. |

Severity summary at review: **0 critical, 1 major, 3 minor, 3 nits; 7 open.**

### Round 1 resolution verification

Verified on code commit `b614909` after applying all seven fixes above. **7 resolved, 0 open** from round 1.
Historical review descriptions and line references above refer to the original reviewed range.

| Check | Result |
|---|---|
| `npx vitest run test/unit/effort-override.test.ts test/unit/effort-ceiling.test.ts --maxWorkers=50%` | **2 files, 4906 tests passed** (22 added cases; original total 4884) |
| Same scoped run with `--coverage.enabled=true --coverage.include=src/escalate/effort-override.ts` | **4906 passed; 100%** statements (88/88), branches (73/73), functions (10/10), lines (82/82) |
| `npm run typecheck` | Clean (`tsc --noEmit`, no diagnostics) |
| `git diff --check afa9ccf..HEAD` | Clean |

No full suite or live-host run was performed in this fix round. Phase 2.3 wiring and host-level proof remain deferred.

### Round 2

Independent re-review of `afa9ccf..ad62e22`: `6257ca7`, `aac9447`, `1413188`, `e1cdfd9`, `f9208c8`, `7e129fd`, `b614909` (code
and tests) and `ad62e22` (this report). Reviewer: adversarial senior QA (`[tier:heavy]`, CAP:none). The reviewer did not
write the fixes. Line references in this section are to `HEAD` `ad62e22`.

| Check | Result |
|---|---|
| Diff `afa9ccf..HEAD` | 3 files (`effort-override.ts`, its test, this report); nothing else touched |
| `npx vitest run test/unit/effort-override.test.ts test/unit/effort-ceiling.test.ts --maxWorkers=50%` | **2 files, 4906 tests passed** |
| Same run with `--coverage.enabled=true --coverage.include=src/escalate/effort-override.ts` | **100 %** statements (88/88), branches (73/73), functions (10/10), lines (82/82) |
| `npm run typecheck` | Clean |
| `git diff --check afa9ccf..HEAD` | Clean |

Method: two scratch files in `test/scratch/` (`r2`, 10 cases; `r2b`, 5 tier shapes) ran against the real store, the real
builder and the real warn-once set. A third scratch file, a copy of the store as of `afa9ccf` with only its import paths
changed, ran the same inputs through the pre-fix code. All three were deleted, and `git status` was clean before this
commit. No host and no full suite were run.

**Round 1 findings, re-verified:**

| id | round 2 | evidence |
|---|---|---|
| QA-2.2-1 | **Resolved** | `:54` deletes the entry before any validation and `:96` deletes it again in the `catch`. Scratch S1 replays (a)–(c): each refused re-set leaves `has("p") === false` and the target at `"low"`. A tier whose `ownKeys` trap throws also clears it. Pinned at `test:263, 274`. Regression checks, no finding: a refused `set` for another session leaves `p` live, and so do non-string ids (`undefined`, `null`, `1`, `new String("p")`, `{}`, `""`). A refused new session at capacity evicts nothing, and neither does a valid same-session re-set at capacity. `set` and `applyEffortOverride` are synchronous, so no apply can run between the delete and the validation. The only way to observe that window is a logger that re-enters `set` from inside the builder call (S2: the outer call wins). The plugin logger posts asynchronously and never re-enters. |
| QA-2.2-2 | **Resolved** | `:43-46, 76`. W1 uses the three round-1 S2 tiers with a fresh warn-once set. At `afa9ccf`: 3 console lines and 0 on the store logger. At `HEAD`: 0 console lines and 3 on the store logger. **The global warn-once state is unchanged.** In both versions, `set` consumes the key, so a later registration through a plugin logger emits 0 lines (W1). In steady state, with registration first, registration still emits 1 line and `set` emits 0 (W2). With a throwing store logger (W3), `set` still succeeds, the override applies and the key is consumed: only that line is lost, which `warn` swallows by design. Not findings: the adapter drops the builder's `extra: { key }` (`agent-options.ts:39`), so a builder line routed through the store lacks the `key` field that registration lines carry in the service log. The uncapped global set (round-1 S9) is unchanged, as accepted in round 1. The default-console channel is QA-2.2-R2-2. |
| QA-2.2-3 | **Resolved** | `:123-128`. Session and agent stay exact (`:120`). Leak matrix C1 has producer `p` / `fast` / `openai/gpt-5` and a second entry `g` / `grader` / `openai/gpt-5-mini`, every target starting at `low`. Only `p` with agent `fast` and a case-variant model changes (`OpenAI` / `GPT-5` → `high`). `g` matches only its own session and agent (`OPENAI` / `GPT-5-MINI` → `medium`). These stay at `low`: agent `title`, no `agent`, agent `FAST`, session `P`, `compaction`, session `g` with `fast`, the orchestrator `o`, `gpt-5-mini` on `p`, `openai-compatible`, and `"gpt-5 "`. **The widening is by design.** Providers that differ only in case now match (`MyProxy/gpt-5` against host `myproxy`, C2), and so do Unicode case folds (`U+212A` KELVIN SIGN in a tier id matches an ASCII `k`, C1). Neither can reach another session or agent. Calls under the producer's own agent use the prompted `tierModel` (round 1, `index.ts:637`). Family classification lower-cases (`protocol.ts:151`, `agent-options.ts:54`), so a case-variant match gets the same family's native key. Case-significant catalog ids (`huggingface/deepseek-ai/DeepSeek-R1`, Bedrock `anthropic.claude-…`) have a `null` ceiling and are refused before storage (C2). **Unverified:** whether OpenCode treats provider ids that differ only in case as distinct providers. The argument above holds either way. |
| QA-2.2-4 | **Resolved** | `test:50-60` adds the v2 title shape: producer session and model, `variant: "default"`, no `agent`. It also adds `Producer`, `Fast` and a numeric `id`. `test:191` covers `__proto__`, `constructor` and `toString` as session and agent, and checks that the `Object.prototype` descriptors are unchanged. |
| QA-2.2-5 | **Resolved for the reported input**; regression QA-2.2-R2-1 | `:60-61`. `test:342` counts one read per top-level field and pins the S7b model flip. The ceiling and the builder still re-read nested fields (S3). An OpenAI `reasoning.effort` getter that flips from `undefined` to `"low"` stores the user's own `"low"`. A Claude `budgetTokens` getter that flips from `0` to `8000` is refused with "no effort keys". Neither crosses a ceiling, so no finding. The spread itself drops inherited and non-enumerable fields: QA-2.2-R2-1. |
| QA-2.2-6 | **Resolved** | `:12-13, 141-158`; `test:131-170`. L1: 10 failing applies on one entry give 1 warning. The missing-target latch and the failure latch are independent: 1 warning each over 5 + 5 calls. 10 sessions through `maxEntries: 3` give 10 warnings and 3 entries, so each latch lives and dies with its bounded entry. Not findings (they predate the fix, and no host sends these inputs): a `null` input or a throwing `sessionID` getter has no entry to latch on and still warns on every call (10 of 10), as at `afa9ccf`. A throwing `model` getter on the producer's own session and agent consumes the failure latch before a later real failure (1 warning in total). |
| QA-2.2-7 | **Resolved on the plugin-logger path**; default-console regression QA-2.2-R2-2 | `:28`. `test:378` pins a single prefix through a plugin-style fallback. |

**New defects introduced by the fixes:**

| id | severity | file:line | description | resolution |
|---|---|---|---|---|
| QA-2.2-R2-1 | minor | `src/escalate/effort-override.ts:60, 71, 76` | **The `{ ...tier }` snapshot from `f9208c8` copies only own enumerable properties, so a `null` ceiling that the pre-fix store refused is now accepted.** `effortCeilingFor` and `buildAgentOptions` read through the prototype chain and see non-enumerable properties, and so do registration and the ladder (`ladder.ts:232`). The snapshot does not. If a tier's `reasoning`, `variant` or `thinking` is inherited or non-enumerable, the store computes a non-null ceiling, accepts the `set`, and apply writes the bump over the explicit configuration. **Failing inputs** (scratch r2b; "old" is `afa9ccf`, "new" is `HEAD`): <br>(a) `openai/gpt-5`, `effort: "low"`, with an inherited `reasoning: { effort: "low" }`, `set(…, "high")`. `effortCeilingFor(tier)` is `null` but `effortCeilingFor({ ...tier })` is `"high"`. Registration sends `{ reasoningEffort: "low" }`. Old: refused, override `{}`. New: accepted, override **`{ reasoningEffort: "high" }`**. <br>(b) The same with a non-enumerable own `reasoning`: same result. <br>(c) An inherited `variant: "high"`: same result. <br>(d) `anthropic/claude-sonnet-4-5` with an inherited `thinking: { budgetTokens: 8000 }`. Registration sends `{ thinking: { type: "enabled", budgetTokens: 8000 } }`. Old: refused. New: override **`{ effort: "high" }`**, sent alongside the explicit budget. <br>This is the class that round 1 called critical: an override against a `null` ceiling, regressed here from refused to accepted. It is **latent**. Tiers are built by `JSON.parse` and the spreading `deepMerge` (`config.ts:1154-1173, 1269-1281`), which produce own enumerable properties only. The ladder computes the bump from the real tier (`ladder.ts:232`), so the planned wiring would never request this bump. Hence minor. An inherited `model` now fails safe: the `set` is refused. **Fix:** replace the spread with one ordinary read per field that the ceiling and the builder use: `{ model: tier.model, effort: tier.effort, variant: tier.variant, thinking: tier.thinking, reasoning: tier.reasoning }`. In scratch, that snapshot gives a `null` ceiling for (a)–(d). It keeps one read per field, so `test:342` still holds. Pin (a) and (b). | Resolved in `08e7c35`: read model, effort, variant, thinking and reasoning once into locals, then build the shared snapshot. Five regressions cover inherited reasoning/thinking/variant and non-enumerable reasoning/variant; all refuse and clear the prior override. The existing one-read-per-field regression still passes. |
| QA-2.2-R2-2 | nit | `src/escalate/effort-override.ts:42-46`; `test/unit/effort-override.test.ts:393` | **A store built without `logger` now writes unattributed lines to stderr.** `aac9447` routes every builder warning through the store's logger, so the default store bypasses the builder's own console prefix (`agent-options.ts:42`: ``console.warn(`[model-router] ${message}`)``). `b614909` removed the store's own prefix. **Input** (scratch W4, default store, `maxEntries: 1`: a Claude tier with `reasoning.summary`, then an eviction, then an above-ceiling `set`). Old: `"[model-router] tier fast: reasoning.effort and reasoning.summary are OpenAI parameters…"`, `"[model-router] Evicted oldest effort override for a"`, `"[model-router] Effort override for c exceeds the tier ceiling; override refused"`. New: the same three lines with no prefix. Every other console fallback in the plugin prefixes (`agent-options.ts:42`, `logger.ts:106, 119`). QA-2.2-7 allowed "never" for the store's own lines, but that option predates `aac9447` moving the builder's lines onto the same channel. Production is unaffected, because 2.3 injects the plugin logger (handoff 1) and that logger prefixes its own fallback. **Fix:** when `opts.logger` is absent, default to ``{ warn: (m) => console.warn(`[model-router] ${m}`) }``, and change the pin at `test:393` to the prefixed line. `test:378` is unaffected. | Resolved in `7f7b916`: the default console adapter adds `[model-router] `; injected loggers still receive unprefixed messages. Regressions pin attributed builder, refusal and eviction warnings, while the plugin-style logger test still pins exactly one prefix. |

Test observation, not a finding: the agreement sweep (`test:437`) now asserts console silence instead of `logger.warn`
silence. Store-level warnings in the sweep are therefore no longer asserted absent. A refusal would still fail the target
assertions on the two lines above it.

Severity summary, round 2: **7 of 7 round-1 findings resolved; new: 0 critical, 0 major, 1 minor, 1 nit; 2 open.**

### Round 2 resolution verification

Verified on code commit `7f7b916`. **Both round-2 findings resolved; 0 open across both rounds.**
The round-2 descriptions and severity summary above are retained as review history.

- `08e7c35` also restores the agreement sweep's `logger.warn` silence assertion alongside console silence.
  Each fixture first runs registration through a separate logger, consuming expected builder notices before
  steady-state bumps; all bumpable fixtures must then produce no store-logger warnings.
- Red/green evidence: all five inherited/non-enumerable regressions failed before R2-1 with
  `expected true to be false` for `store.has("producer")`. Both console-prefix tests failed before R2-2
  because the emitted messages lacked `[model-router] `. All pass after the fixes.

| Check | Result |
|---|---|
| `npx vitest run test/unit/effort-override.test.ts test/unit/effort-ceiling.test.ts --maxWorkers=50%` | **2 files, 4912 tests passed** (1170 override, 3742 ceiling; 6 added cases) |
| Same scoped run with `--coverage.enabled=true --coverage.include=src/escalate/effort-override.ts` | **4912 passed; 100%** statements (93/93), branches (73/73), functions (11/11), lines (86/86) |
| `npm run typecheck` | Clean (`tsc --noEmit`, no diagnostics) |
| `git diff --check` before each fix commit | Clean |

No full suite or live-host run was performed. Phase 2.3 wiring and host proof remain deferred.

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

**To 2.2 (implementer, fix round 2):** QA-2.2-R2-1 and QA-2.2-R2-2 (Round 2 above). Both fixes are in
`createEffortOverrideStore`; neither changes the 2.3 handoffs below.

**To 2.3 (apply in its pre-flight, A15):**

1. **Construct one store per plugin instance** and pass it the plugin logger. Without one it defaults to `console`, which
   paints over the TUI (`logger.ts:4-5`):
   `const effortOverrides = createEffortOverrideStore({ logger: { warn: (m) => logger.warn(m) } });`
    Pass the same adapter as the `logger` argument of every `applyEffortOverride` call. QA-2.2-2 is now resolved:
    builder warnings inside `set` use the store's logger too; global warn-once behavior is unchanged.
2. **Where to call `set`:** inside `registerProducer(sid)` (`index.ts:609-625`). That covers both hosts: v1 awaits it after
   `session.create` and before `session.prompt` (`:627-634`); v2 awaits it in the native subagent's `onCreated` before the
   child is prompted (`:661`, A8). Call it only when `effort` is defined:
   `effortOverrides.set(sid, tier, getActiveTiers(activeCfg)[tier], effort)`.
   - `tierName` must be the exact agent name sent with the prompt (`agent: tier`, `:657, 666`), or the gate never matches.
   - The `TierConfig` must come from the **same `activeCfg` snapshot** that `tierModel(activeCfg, tier)` (`:637`) uses for
     the prompt's `model`. Otherwise the identity gate compares against a different model and silently no-ops (phase-1.3
     "one config snapshot").
    - Call `set` once per producer session. QA-2.2-1 is now resolved: a refused re-set clears the previous override.
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

## Verdict at initial review

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

**Round 1 implementation update:** all seven findings are resolved with regression tests and the scoped verification
recorded above. The initial verdict is retained as review history; independent QA re-review and Phase 2.3 host proof
have not been performed by this fix pass.

## Verdict

Open findings: 0 (every round-1 and round-2 finding fixed)

The independent re-review confirms all seven round-1 findings resolved:
- a refused re-set now clears the entry;
- builder warnings reach the injected logger, and the global warn-once state is unchanged;
- the case-insensitive gate cannot reach another session or agent;
- the gate pins are in place;
- top-level tier reads are single;
- failure latches are bounded by entry lifetime;
- the plugin-logger path carries a single prefix.

Both regressions introduced by the round-1 fixes are now resolved:
- explicit one-time field reads preserve inherited and non-enumerable ceiling constraints (`08e7c35`);
- the default-console store restores `[model-router]` attribution without duplicating injected-logger prefixes (`7f7b916`).

The phase DoD requires zero open findings. Phase 2.3 wiring and the host-level proof remain deferred by plan.
