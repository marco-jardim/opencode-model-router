# Phase 1.3 — Effort ceiling and ladder effort step (M3, M4)

## Pre-flight

- Worktree `D:\git\omr-de-p13`, branch `de/p13` tracking `origin/de/p13`, clean at fixture commit `2927540` (the rebased commit on this branch).
- Golden fixture committed in `2927540`: `test/unit/__fixtures__/ladder-v2.0.0-golden.json`. It holds 1,620 matrix entries and 27 sequences. SHA-256 `f4feceec…`. Branch counts: accept 549, give_up unverifiable 549, give_up maxTotalAttempts 186, give_up cost ceiling 120, retry 121, escalate 102, give_up no next tier 51.
- Arithmetic cross-check (not re-run). Matrix = 3 verdicts × (A+2) × (T+2) × 3 costs × 3 tiers = 486 + 648 + 486 = 1,620. Sequences = 3 policies × 3 tiers × 3 streams = 27. The branch counts add up to 1,678, so they cover the matrix plus 58 sequence steps. For example, accept 549 = 540 pass entries + 9 fail-then-pass sequences.
- The replay test compares twice, at `test/unit/ladder.test.ts:1022–1023`: `expect(actual).toEqual(JSON.parse(expected))` and `expect(serialized).toBe(expected)`. The second is a byte-exact match on the JSON for every policy, input state, action, advanced state, sequence `initialState` and scorecard. Adding any key with a non-`undefined` value fails it, `null` included. §4 follows from this.
- The golden policies come from `buildEscalatePolicy` on a config with `presets: {}` (`:874–895`). The existing `buildEscalatePolicy` tests also use `presets: {}` (`makeCfg`, `:571–579`). Matrix states are typed literals with 6 fields (`const state: LadderState = {…}`, `:943–950`).
- The v2 bridge was verified at `src/compat/v2-hooks.ts:128–134`. It destructures `reasoning_effort`, `reasoning_summary` and `budget_tokens`, then sets `{ ...options, reasoningEffort?, reasoningSummary?, thinking: { type: "enabled", budgetTokens }? }`. It adds the native key only when the snake key is defined.

### QA review run (@heavy, `de/p13` at `4136fe4`, 10 commits over `origin/de/main`)

- **router_verify:** `vrf_8ecc…` pass. `vrf_ccd6…` came back unverifiable (attribution); the scoped run below re-checks it and passes.
- **Scoped tests:** `npx vitest run test/unit/ladder.test.ts test/unit/effort-ceiling.test.ts test/unit/effort.test.ts test/integration/fable-effort-preset.test.ts test/unit/v2-hooks.test.ts --maxWorkers=50%` gave 5 files and 2,866 tests, all passing. Smoke tests were not run.
- **Coverage** on `src/escalate/ladder.ts` and `src/router/agent-options.ts`: 100% statements (135/135), 100% branches (154/154), 100% functions (22/22) and 100% lines (121/121).
- **`npm run typecheck`:** clean.
- **Golden fixture:** unchanged since its commit `2927540` (`git diff --stat 2927540 HEAD` is empty). SHA-256 `F4FECEEC…E029A2`, the same as the memo.
- **Throwaway differential tests** (`test/scratch/`, deleted before commit). They compared HEAD against `origin/de/main`'s `ladder.ts` and `agent-options.ts`:
  - **Bump-off byte identity:** 7 shipped presets × 6 escalate variants (`{}`, `effortBump:false`, A=2, `effortBumpMax:"low"`, floor medium, A=0/T=7). Every policy without the `effortBump` key equals the old `buildEscalatePolicy` output in both `JSON.stringify` and `Object.keys` order. Each comparison builds fresh state objects and covers `nextAction`, `advance`, scorecard, `newLadderState` and 20-step sequences at shipped tier ratios. That is 41 configurations, all identical. Only `fable-effort` with defaults turns the bump on: `{"fast":{"base":"low","bound":"xhigh"},"medium":{"base":"high","bound":"xhigh"}}`.
  - **Bump-on control flow:** 85,344 matrix states × `currentEffort` ∈ {absent, null, 5 levels} × 6 verdicts. With `effort`/`currentEffort`/`@level` stripped, every action, advanced state (key order included) and scorecard equals v2.0.0. An escalation always resets `currentEffort` to `null`.
  - **Full loops:** 4,200 all-fail loops on `fable-effort` (A 0–3, T 1–8, multiple 1/2/4/8/100, every `effortBumpMax`, floor none/medium, every start tier). Attempts, tier sequences, cumulative cost and terminal reasons match v2.0.0. No reachable retry lowered effort, went past its bound or fell below its base.
  - **Ceiling vs builder:** 35 extra ids × 7 efforts × 7 thinking × 5 reasoning × 4 variant shapes, with zero disagreements and no throw. The ids cover OpenRouter `openrouter/anthropic/claude-sonnet-4.5` (max), Copilot `github-copilot/gpt-5` (high) and `github-copilot/claude-sonnet-4.5` (max), Azure `azure/gpt-5` (high) and `azure/my-reasoning-deployment` (null), upper-case `Anthropic/Claude-Opus-5-5` (max) and `OpenAI/GPT-5` (high), dotted, Vertex `@date`, Bedrock `anthropic.`/`global.anthropic.` (null, F2), `ollama/gpt-oss:20b` (high), `""` (null), plus the thinking shapes `-1`, `NaN`, `"4096"` and `{}`, `reasoning: { effort: "" }`, and variants `""` and `0`.
  - **v2 end-to-end:** both builders were run through `registerV2Hooks` → `sessionHooks.context`. That was 9 tiers (OpenAI reasoning/effort/downgrade/budget, Claude budget/adaptive/effort, unknown with budget and reasoning, Bedrock) × host option bags `{}`, `{reasoningEffort:"minimal",temperature:0.2}`, `{thinking:{type:"disabled"}}` and `{reasoningEffort:undefined}`. Every `event.options` was deep-equal, with no double translation and no lost key. Only the key order differs (QA-1.3-6).
- **Live config reload:** `src/index.ts:549–566` reloads `activeCfg` and builds the policy once per `delegate` call. `tiersForCost` (`:568`), `tierModel` and `registerProducerSession` use the same snapshot. The policy is constant within a loop, and the next call picks up a new config.
- **Other consumers of the old keys in `src`:** none. The only remaining ones are the bridge (`v2-hooks.ts:128–133`) and the `openai-downgrade` text (`agent-options.ts:184`). `src/commands/output.ts:28–31` renders tier config (`thinking.budgetTokens`, `reasoning.effort`), not builder output.

## Implementation notes

### 1. Effort algebra (1.3.2): new exports in `src/router/agent-options.ts`

```ts
export function effortRank(level: EffortLevel): number;            // EFFORT_LEVELS.indexOf: low 0 … max 4
export function nextEffort(current: EffortLevel, bound: EffortLevel): EffortLevel | null;
export function minEffort(a: EffortLevel, b: EffortLevel): EffortLevel; // lower rank; tie → a (used by 1.3.4)
export function effortCeilingFor(tier: TierConfig): EffortLevel | null;
```

`nextEffort` = `effortRank(current) < effortRank(bound) ? EFFORT_LEVELS[effortRank(current) + 1]! : null`. It moves exactly one step, never skips a level and never goes past the bound. No runtime validation: callers pass levels that are already validated.

| current \ bound | low | medium | high | xhigh | max |
|---|---|---|---|---|---|
| low | null | medium | medium | medium | medium |
| medium | null | null | high | high | high |
| high | null | null | null | xhigh | xhigh |
| xhigh | null | null | null | null | max |
| max | null | null | null | null | null |

**What `buildAgentOptions({ ...tier, effort: L })` does with each valid L:**

| # | Branch | Emits for L | Warning caused by L | Levels passed unchanged |
|---|---|---|---|---|
| B1 | Claude, truthy `budgetTokens`, model not adaptive-only | nothing | `anthropic-conflict` | none |
| B2 | Claude, no winning budget (none, `0`, or adaptive-only model) | `effort: L` | none | all five → `max` |
| B3 | not Claude, OpenAI, truthy `reasoning.effort` | `reasoningEffort` = `reasoning.effort` | `openai-conflict` | none |
| B4 | OpenAI, no `reasoning.effort`, L ∈ low..high | `reasoningEffort: L` | none | low..high → `high` |
| B5 | OpenAI, no `reasoning.effort`, L ∈ xhigh, max | `reasoningEffort: "high"` | `openai-downgrade` | n/a (above ceiling) |
| B6 | neither family | nothing | `unknown-provider` | none |

Three warnings fire the same way with or without `effort`: `thinking-adaptive-only`, `thinking-zero` and `reasoning-claude`. They report tier misconfiguration, not a bump effect. "Without a warning" (M3) means **no warning beyond the ones the same tier produces with `effort` removed**.

**`effortCeilingFor` decision table.** Evaluate from the top; the first match returns.

| Step | Condition | Return | Source |
|---|---|---|---|
| 1 | `tier.variant` truthy | null | D7 / R2 |
| 2 | `tier.effort === undefined` | null | D7 |
| 3 | `!isEffortLevel(tier.effort)`: invalid, wrong case (`"High"`), or `null` | null | warned and ignored = unset (D7) |
| 4 | `isClaudeModel(m) && Boolean(tier.thinking?.budgetTokens) && !isAdaptiveOnlyClaudeModel(m)` | null | B1 |
| 5 | `isClaudeModel(m)` | `"max"` | B2 |
| 6 | `isOpenAIModel(m) && tier.reasoning?.effort` (truthy) | null | B3 |
| 7 | `isOpenAIModel(m)` | `"high"` | B4/B5 |
| 8 | otherwise | null | B6 |

Rules:

- **Use the builder's own predicates in the builder's order.** That means `isClaudeModel`, `isAdaptiveOnlyClaudeModel`, and the module-private `isOpenAIModel` and `isEffortLevel`, with Claude checked before OpenAI. Do not reimplement or normalise anything. Agreement then follows by construction, and the property test (I4) confirms it.
- **Test truthiness the way the builder does.** `budgetTokens: 0` falls through to step 5. `reasoning: { summary }` without `effort` falls through to step 7. `variant: ""` counts as not configured.
- **Keep the function pure.** No logger, no warning state.
- **Claude's ceiling is `"max"`** because the builder forwards every valid level for Claude. "Claude high → bound xhigh" comes from `min(max, effortBumpMax "xhigh")` in 1.3.4. Whether a given model accepts xhigh or max is not modelled; the documented remedy is `effortBumpMax: "high"`.

**Family detection on id forms.** Tier has `effort` set and no budget, reasoning or variant.

| Model id | Claude | OpenAI | Adaptive-only | Ceiling |
|---|---|---|---|---|
| `openai/gpt-5`, `azure/o3` | no | yes | n/a | high |
| `anthropic/claude-sonnet-4-5` | yes | n/a | no | max (null with budget > 0) |
| `anthropic/claude-opus-5-5` | yes | n/a | yes | max, even with a budget |
| `google-vertex-anthropic/claude-sonnet-4-5@20250929` | yes (`/claude-`) | n/a | no | max |
| `google-vertex-anthropic/claude-opus-5-5@20260101` | yes | n/a | yes (`@\d{8}`) | max |
| `amazon-bedrock/anthropic.claude-sonnet-4-5-20250929-v1:0` | **no** | no | no | null (unknown) |
| `amazon-bedrock/us.anthropic.claude-opus-5-5-20260101-v1:0` | **no** | no | no | null (unknown) |
| `openrouter/qwen/qwen3-coder` | no | no | n/a | null |

Bedrock ids are not detected as Claude: `.claude-` matches neither `/\/claude-/` nor `/(^|[\/\-])claude-/`. The builder and the ceiling still agree (both treat it as unknown → null). The gap is pre-existing; see F2.

### 2. Native keys in `buildAgentOptions` (1.3.2b, A4)

Only the assignment targets change. Branch order, conditions, warning keys and warning texts stay exactly as they are.

| Branch | Before | After |
|---|---|---|
| thinking budget wins | `opts.budget_tokens = N` | `opts.thinking = { type: "enabled", budgetTokens: N }` (new object per call) |
| non-Claude `reasoning.effort` | `opts.reasoning_effort = …` | `opts.reasoningEffort = …` |
| non-Claude `reasoning.summary` | `opts.reasoning_summary = …` | `opts.reasoningSummary = …` |
| OpenAI effort xhigh/max | `opts.reasoning_effort = "high"` | `opts.reasoningEffort = "high"` |
| OpenAI effort low..high | `opts.reasoning_effort = effort` | `opts.reasoningEffort = effort` |
| Claude effort | `opts.effort = effort` | unchanged |

- **The `thinking` shape is byte-for-byte the bridge's output** (`v2-hooks.ts:133`), so v1 and v2 now carry the same options.
- **v2 keeps working with no bridge change.** With native keys the snake bindings in `:128` are `undefined`, so `:131–133` add nothing, and the native keys pass through `...options`. The bridge's translation becomes dead code for router output; Phase 2.3 may remove it.
- **Warning texts stay verbatim.** Only one mentions `reasoning_effort`: `openai-downgrade` ("…because OpenAI reasoning_effort only supports low, medium, or high"). It names OpenAI's wire parameter, which is still `reasoning_effort`, so it stays accurate. The other texts name router config keys (`reasoning.effort`, `thinking.budgetTokens`), which do not change.
- **Tests to update:**
  - `test/unit/effort.test.ts`: the 18 snake-key lines. Change output-key assertions only; leave any assertion on the downgrade text as it is.
  - `test/integration/fable-effort-preset.test.ts:101–105`.
  - `test/smoke/registration.smoke.test.ts:165`.
- **Gate:** `rg -n "reasoning_effort|reasoning_summary|budget_tokens" src test` may only hit three things: the bridge (`v2-hooks.ts:128–133`), the downgrade text, and tests that assert that text or feed snake keys to the bridge.
- **A12** is a separate task on the same branch. In `test/smoke/registration.smoke.test.ts` and `test/smoke/subagent-tiers.smoke.test.ts`, give each test its own temp dir and point `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME`, `APPDATA` and `LOCALAPPDATA` at it. Delete every inherited `OPENCODE_*` variable, then set `OPENCODE_DISABLE_MODELS_FETCH=true`.

### 3. Ladder effort step (1.3.3, `src/escalate/ladder.ts`)

```ts
export interface EffortBumpPolicy { perTier: Record<string, { base: EffortLevel; bound: EffortLevel }> }
export interface EscalatePolicy { /* v2.0.0 fields, unchanged */ effortBump?: EffortBumpPolicy | null }
export interface LadderState    { /* 6 v2.0.0 fields, same order */ currentEffort?: EffortLevel | null } // absent ≡ null
export interface LadderAction   { /* unchanged */ effort?: EffortLevel }
```

- **`newLadderState(initialTier, policy)`:** build the existing literal, then append `if (policy.effortBump) state.currentEffort = null;`.
- **`nextAction`:** checks 1–4 and 6 are untouched. In the retry branch (5), bind the existing return literal to a const and append the effort:

```ts
const action: LadderAction = { /* existing retry literal: action, tier, forcingMessage */ };
const perTier = policy.effortBump?.perTier;
const bump = perTier && Object.prototype.hasOwnProperty.call(perTier, state.currentTier)
  ? perTier[state.currentTier] : undefined;            // tier names are user strings ("constructor")
if (bump) {
  const current = state.currentEffort ?? bump.base;
  const startingEffort = minEffort(
    effortRank(current) < effortRank(bump.base) ? bump.base : current,
    bump.bound,
  );
  const effort = nextEffort(startingEffort, bump.bound)
    ?? (state.currentEffort == null ? undefined : startingEffort);
  if (effort !== undefined) action.effort = effort;
}
return action;
```

  accept, give_up and escalate never carry `effort`. The escalated tier's first attempt runs at its configured effort.
- **`advance`:** a retry spreads the state, increments `attemptsThisTier`, then `if (action.effort !== undefined) next.currentEffort = action.effort`. An escalation keeps the existing literal (same key order), then `if (next.currentEffort !== undefined) next.currentEffort = null`. Any other action returns `state`. A retry without `effort` (tier not in `perTier`) leaves `currentEffort` as it was.
- **`recordAttempt`:** unchanged. Its spread (`:76–77`) carries `currentEffort` through.
- **`formatLadderScorecard`:** emit `final_tier=${state.currentTier}${state.currentEffort ? `@${state.currentEffort}` : ""}`; everything else stays verbatim. It shows the final attempt's effort when that attempt was bumped, for example `final_tier=medium@high`. It shows the plain tier for a first attempt on a tier, after an escalation, on a tier that is not bumped, and when the bump is off.
  - In production (`src/index.ts` loop) the scorecard is formatted on accept or give_up, where `advance` returns the state unchanged, so it is the effort of the last attempt that actually ran. The golden harness formats the advanced state; that only matters when the bump is on.
- **Amendment to plan 1.3.3.a.** The plan specifies "`currentEffort: EffortLevel | null`, initialised to `null`". With the bump off that breaks the golden replay twice:
  1. The typed literals at `:943–950` would not compile with a required field.
  2. `"currentEffort": null` in every sequence `initialState` and advanced state would break the byte compare at `:1023`.

  The design therefore makes the field optional, treats absent as `null`, and sets it only when the policy carries `effortBump`. Production gets `null` from the start whenever the bump is on.

### 4. Why bump-off output is byte-identical to the golden table

This holds for `effortBump` absent or `null`. Taking each artefact in the fixture:

1. **`policy`.** Untouched until 1.3.4. After 1.3.4, the golden configs have `presets: {}`, so there are no tiers, the result is `null`, and the key is **not added** (§5).
2. **`input.state`.** These are test literals with 6 fields. They compile because `currentEffort` is optional.
3. **`nextAction`.** Branches 1–4 and 6 return the same literals. In branch 5, `perTier` is `undefined`, so no `effort` key is added. The key order (`action`, `tier`, `forcingMessage`) is unchanged.
4. **`advance`.**
   - Retry: `action.effort` is `undefined`, so no key is added.
   - Escalate: `currentEffort` is `undefined`, so no key is added.
   - Any other action: returns the state unchanged.
5. **Sequence `initialState`.** `policy.effortBump` is falsy, so `currentEffort` is not added.
6. **Sequence states.** `recordAttempt`'s spread keeps the key absent; then items 3–4 apply.
7. **Scorecards.** `currentEffort` is falsy, so the suffix is `""` and the string is the same.

Never run `GOLDEN_WRITE=1` in this phase. `git diff 2927540 -- test/unit/__fixtures__/ladder-v2.0.0-golden.json` must stay empty.

### 5. `buildEscalatePolicy` perTier (1.3.4: rebase `de/p13` on merged 1.1 first)

```ts
const policy: EscalatePolicy = { /* existing literal, unchanged */ };
const effortBump = buildEffortBump(cfg);
if (effortBump) policy.effortBump = effortBump;           // absent, never null: golden byte compare
return policy;

function buildEffortBump(cfg: RouterConfig): EffortBumpPolicy | null {
  const { enabled, max } = resolveEffortBump(cfg);
  if (!enabled) return null;
  const tiers = getActiveTiers(cfg) ?? {};                // presets {} → undefined at runtime despite `!`
  const entries: Array<[string, { base: EffortLevel; bound: EffortLevel }]> = [];
  for (const [name, tier] of Object.entries(tiers)) {
    const ceiling = effortCeilingFor(tier);
    if (ceiling === null) continue;                       // D7 or no effect
    const base = tier.effort as EffortLevel;              // valid: non-null ceiling ⇒ steps 2–3 passed
    const bound = minEffort(ceiling, max);
    if (effortRank(bound) <= effortRank(base)) continue;
    entries.push([name, { base, bound }]);
  }
  return entries.length > 0 ? { perTier: Object.fromEntries(entries) } : null; // own keys, "__proto__"-safe
}
```

- Iterate every tier in the active preset, not only the ladder: an **empty ladder** makes `resolveStartTier` retain the producer tier, whose retries can still be bumped. With a nonempty ladder, an off-ladder producer is mapped to `ladder[0]` or the configured floor; it is not a reason to retain off-ladder entries by itself.
- This assumes `Preset` is `Record<string, TierConfig>`. That is unverified; if `Preset` carries non-tier keys, skip any value that has no string `model`.

| Tier (default max xhigh) | Ceiling | Bound | Included |
|---|---|---|---|
| OpenAI medium | high | high | yes |
| OpenAI high | high | high | no |
| Claude low / high | max | xhigh | yes |
| Claude xhigh / max | max | xhigh | no |

- `max: "high"`: Claude high is excluded; OpenAI medium gets bound high.
- `max: "low"`: every tier is excluded, so the key is absent.
- `enabled: false`: the key is absent.
- Excluded regardless of max: no `effort`, `variant` set, unknown family, a winning Claude budget, an OpenAI `reasoning.effort`.

Tests assert `expect(p.effortBump ?? null).toBeNull()`, plus `"effortBump" in p === false` for the golden configs.

### 6. Invariants and tests

The plan's test file is `test/unit/effort-ceiling.test.ts` (new). The ladder cases extend `test/unit/ladder.test.ts`.

| # | Invariant | Test |
|---|---|---|
| I1 | `nextEffort` matches the 25-cell grid in §1 | effort-ceiling: full 5×5 grid |
| I2 | `effortRank` is 0..4 in `EFFORT_LEVELS` order; `minEffort` returns the lower | effort-ceiling |
| I3 | `effortCeilingFor` follows each step of §1 | effort-ceiling: one case per step, plus `budgetTokens: 0`, summary-only, adaptive-only with a budget, `variant: ""`, `"High"`, `null` |
| I4 | **Agreement property** (below) | effort-ceiling: model ids from the §1 table × base effort {absent, `"ultra"`, `"High"`, 5 levels} × thinking {none, 0, 4096} × reasoning {none, `{effort:"low"}`, `{summary:"auto"}`} × variant {none, `"high"`} × L ∈ all 5 levels |
| I5 | No snake keys are emitted; each branch emits the keys in §2 | effort.test.ts, fable-effort-preset, registration smoke |
| I6 | Warning keys and texts are unchanged | existing effort.test.ts warning assertions, left as they are |
| I7 | Golden equivalence: replay passes unmodified and the fixture is byte-unchanged | ladder.test.ts "golden v2.0.0" plus fixture-scoped `git diff 2927540` empty |
| I8 | Bump-off shape: with no `effortBump` (absent or `null`) there is no `currentEffort` and no `effort` key, and the scorecard is unchanged | ladder.test.ts: `"currentEffort" in s === false` |
| I9 | D8 trace (S1, below) | ladder.test.ts |
| I10 | Saturation: with A=2 and fast {high→xhigh}, both retries carry `xhigh` | ladder.test.ts |
| I11 | On a tier not in `perTier`, a retry has no `effort`, `currentEffort` stays null and the scorecard is plain | ladder.test.ts |
| I12 | Fail-then-pass: an accept after a bumped retry gives `final_tier=fast@medium … verdict=PASS` | ladder.test.ts |
| I13 | Check order is unchanged when the bump is on, and non-retry actions never carry `effort` | ladder.test.ts |
| I14 | `newLadderState`, `nextAction` and `advance` do not mutate their inputs (JSON before = after, as at `:182–184`) | ladder.test.ts |
| I15 | Tier names `constructor` and `toString` produce no `effort` | ladder.test.ts |
| I16 | The 1.3.4 cases above hold; `presets: {}` neither throws nor adds the key | ladder.test.ts buildEscalatePolicy |
| I17 | Every `perTier` bound is ≤ the ceiling and ≤ max, and every `action.effort` is ≤ the bound | effort-ceiling, ladder.test.ts |

**I4, the agreement property.**

- **Setup:**
  - Before each call, run `resetAgentOptionsEffortWarnings()` and attach a capturing logger.
  - Call the builder twice: `W0` = the warnings from `{ ...T, effort: undefined }`, and `WL` = the options and warnings from `{ ...T, effort: L }`.
  - `passes(T, L)` holds when `(opts.effort === L || opts.reasoningEffort === L)` and `WL ⊆ W0`.
  - `D7(T)` holds when `variant` is truthy, `effort` is undefined, or `!isEffortLevel(effort)`.
- **Assertions:**
  - If the ceiling `c` is non-null: `passes(T, L)` holds exactly when `rank(L) ≤ rank(c)`.
  - If `c` is non-null and `rank(L) > rank(c)` (OpenAI only): `reasoningEffort === "high"` and `openai-downgrade` is in `WL`.
  - If `c` is null: `D7(T)` holds, or no L passes.

**I9 trace (S1).** Setup: default ladder, A=1, T=4, cost 1 per attempt, `perTier` fast {low→medium} and medium {medium→high}. Run all-fail starting from fast. The expected steps:

1. retry fast with effort medium;
2. escalate to medium (`currentEffort` null, no `effort` on the action);
3. retry medium with effort high;
4. give_up "max total attempts (4) reached".

Scorecard: `[router delegate scorecard | final_tier=medium@high | attempts=4 | escalations=1 | cost=4 | verdict=UNMET | method=<m>]`.

## Findings

- **F1 (plan amendment, 1.3.3.a).** `currentEffort` is optional and absent means `null`, so that bump-off output stays byte-identical (§3, §4). The same goes for `effortBump`: absent instead of `null` (§5). This is consistent with D8 and the "bump off ≡ v2.0.0" gate.
- **F2 (pre-existing).** Bedrock Claude ids (`amazon-bedrock/anthropic.claude-…`, `us.anthropic.claude-…`) are classified as an unknown family. Effort is warned and dropped, and the ceiling is null. Fixing `isClaudeModel` is out of scope. If it is fixed later, recheck the native keys: unverified, but the AI SDK Bedrock provider takes `reasoningConfig`, not `thinking`.
- **F3 (pre-existing, now visible on the wire for v1).** The thinking budget is emitted for any family (OpenAI tiers with `budgetTokens` included). v2 already sent `thinking` this way through the bridge. A4 keeps the precedence as it is; gating by family is for a later phase.
- **F4.** The cost ceiling does not account for effort: `recordAttempt` charges the tier's `costRatio` for a bumped retry. The ratio-based cost is a plan decision; see Deferred.
- **F5.** `getActiveTiers` returns `undefined` when `presets` is `{}`, despite its non-null assertion. `buildEffortBump` guards with `?? {}`, which the golden test and the existing tests depend on.
- **F6.** Claude's ceiling of `"max"` reflects what the router emits, not what each model accepts. The remedy is `effortBumpMax: "high"`.

### QA review (@heavy)

No critical or major finding. No reachable bump lowers effort, goes past its bound or survives an escalation. Bump-off output is byte-identical to v2.0.0, key order included. The ceiling and the builder agree on every id tried. v2 `event.options` is deep-equal before and after A4. Attempt counts do not drift. Evidence is in Pre-flight, "QA review run".

| ID | Severity | File:line | Description | Resolution |
|---|---|---|---|---|
| QA-1.3-1 | minor | `src/escalate/ladder.ts:246`, `src/index.ts:861` | **The scorecard reports an effort that was never applied.** `advance` records `action.effort`, and the scorecard prints `@effort`, but `runProducerAttempt(tier, forcing)` ignores the effort until 2.3. `effortBump` defaults to `true`. Failing input: active preset `fable-effort`, defaults, the first attempt fails and the second passes. `<sid>.delegate.log` then gets `final_tier=fast@medium … verdict=PASS`, but attempt 2 ran agent `fast` with its registered `effort: "low"`. Fix: ship 1.3 and 2.3 in the same release, or drop the `@` suffix until the effort is wired. Then add a test that the scorecard effort equals the effort that was applied. | deferred by plan — 2.3.5.b (`2b2e8e5`) |
| QA-1.3-2 | minor | `src/escalate/ladder.ts:164` | **`nextAction` steps from `state.currentEffort` without clamping it to `[base, bound]`.** Input: `perTier.fast = {base:"high", bound:"xhigh"}`, state `{currentTier:"fast", attemptsThisTier:0, totalAttempts:1, …, currentEffort:"low"}`, verdict fail. The result is `effort:"medium"`, below base, so the bump lowers effort. With `currentEffort:"max"` the result is `effort:"max"`, above the bound. Neither state can be reached through `newLadderState`/`advance` (4,200 loops and 85,344 states, none found), so this is not critical. It becomes reachable if 2.3 rebuilds the policy within a loop or seeds `currentEffort` from elsewhere. Fix: step from `max(currentEffort ?? base, base)` and clamp the result to the bound, or document the precondition and test it. | fixed — clamp starting effort into [base, bound]; both hand-built states tested (`200df90`) |
| QA-1.3-3 | minor | `test/unit/ladder.test.ts:746–752`; plan D8 (`delegation-depth-and-effort-bump-plan.md:426–428`) | **D8's "same four attempts" does not hold for the only bundled preset where the bump is active.** With shipped `fable-effort` and the default `costMultiple: 4`, v2.0.0 and HEAD both stop after 3 attempts: `fast@low → fast@medium → medium@high`, then `give_up "cost ceiling exceeded"` (cost 5 > 1×4). This behaviour predates the phase, and the bump does not change the attempt count. However, medium's bump (→ xhigh) can never run at defaults. The bumped fast retry is still charged ratio 1 (F4), so real spend rises under the same ceiling. The only fable trace test raises the multiple to 8, so the shipped-default path is not pinned. Fix: add a test for the default trace, and amend D8 and the ADR wording (3.1). | test added; plan §1.7 A14 (orchestrator) (`e34a3c6`) |
| QA-1.3-4 | minor | `test/unit/ladder.test.ts:1327–1331, 1361` | **The golden fixture covers the cost ceiling only as single matrix steps.** That is 120 entries, all in the `above` bucket, and `firstAttemptCost` is always 2. No golden sequence ends on the cost ceiling: `costPerAttempt` 1 cannot exceed 1×4 within `maxTotalAttempts` 4. `firstAttemptCost: null` and `costMultiple: null` are also absent. Bump-off identity on cost-ceiling sequences is proven only by this review's throwaway differential. Fix: add a committed, non-golden sequence test with heterogeneous ratios (for example 1/3/6) for bump off and bump on. Do not regenerate the golden. | fixed — separate frozen v2.0.0 cost fixture: 576 matrix entries + 6 cost-ending sequences; original golden untouched (`d348d25`) |
| QA-1.3-5 | minor | `test/unit/effort-ceiling.test.ts:68–84` | **The I4 agreement fixture is missing OpenRouter-Anthropic, Copilot (`gpt-*` and `claude-*`), Azure `gpt-*`, upper-case and dotted ids**, which the plan's QA list names. Agreement holds by construction, and the scratch run found 0 disagreements, so this is a coverage gap only. Fix: add the ids listed in Pre-flight. | fixed — all seven requested ids added to agreement and bounds tables (`a68316b`) |
| QA-1.3-6 | nit | `src/router/agent-options.ts:125, 146–149, 187` vs `src/compat/v2-hooks.ts:129–134` | **v2 `event.options` key order changed for multi-key bags; the values are deep-equal.** `github-copilot/gpt-5` with effort `max` and `reasoning.summary` went from `reasoningEffort,reasoningSummary` to `reasoningSummary,reasoningEffort`. `azure/o3` with a budget and effort went from `reasoningEffort,thinking` to `thinking,reasoningEffort`. Key order does not matter for provider options. 2.3 tests should assert with `toEqual`, not key-order snapshots. | fixed — summary/thinking assignments delayed; precedence unchanged; OpenAI + manual/adaptive Claude Object.keys tests (`3e79738`) |
| QA-1.3-7 | nit | `docs/qa/depth-and-effort/phase-1.3.md:5–6, 154` | **The memo cites the pre-rebase sha `29e6a13`.** On `de/p13` the fixture commit is `2927540`, and the fixture is unchanged since then (the hash matches). The `git diff 29e6a13 -- …` gate therefore names a commit that is not on the branch. | fixed — memo gates cite `2927540` (`1d56ed2`) |
| QA-1.3-8 | nit | `docs/qa/depth-and-effort/phase-1.3.md:181`; `src/escalate/ladder.ts:60–64` | **The memo §5 rationale "the initial tier may be off the ladder" is wrong.** `resolveStartTier` maps an off-ladder producer to `ladder[0]`, or to the floor, unless the ladder is empty. Including off-ladder tiers is harmless, but the stated reason is incorrect. | fixed — rationale identifies empty-ladder fallback (`e72dce7`) |
| QA-1.3-9 | nit | `README.md:282, 483, 491`; `docs/CONFIG_REFERENCE.md:668, 688, 694, 714, 749, 759–760` | **These docs still say the router registers `reasoning_effort`/`budget_tokens`.** That stopped being true at `788034d`. Plan §2 (`:727`) flags only `PER_TURN_EFFORT.md` and `OPENCODE_V2.md` for A4 key names. README and CONFIG_REFERENCE are in 3.1's write-set but are not tagged A4. Handed to 3.1. | deferred by plan — Phase 3.1, Wave 3 (`d72aff4`) |

### Round 2 (@heavy, `de/p13` at `77fb039`; plan at `origin/de/main` `777a2d7`)

Scope: `git diff 38efeb6..HEAD` (nine fix commits and the memo), plus plan §1.7 A14.

**Run evidence**

- **Scoped tests:** `npx vitest run test/unit/ladder.test.ts test/unit/effort-ceiling.test.ts test/unit/effort.test.ts test/integration/fable-effort-preset.test.ts test/unit/v2-hooks.test.ts --maxWorkers=50%` gave 5 files and 4,042 tests, all passing.
- **Coverage:** the same run, restricted to `src/escalate/ladder.ts` and `src/router/agent-options.ts` with 95% thresholds. Statements, branches, functions and lines are all 100% (137/137, 161/161, 22/22 and 123/123).
- **`npm run typecheck`:** clean. The full suite and smoke tests were not run.
- **Original fixture:** `git diff --stat 2927540 HEAD -- test/unit/__fixtures__/ladder-v2.0.0-golden.json` is empty. SHA-256 `F4FECEEC…E029A2`.
- **Throwaway differentials.** They ran in `test/scratch/`, with reference modules from `git show`; the temp modules went under `%TEMP%\Claude`. All were deleted.
  - **Clamp (`200df90`).** I compared the `38efeb6` `nextAction`/`advance` against HEAD over 2,032,128 cases:
    - `effortBump` absent, `null` or `{perTier:{}}`, or `fast` set to each of the 25 base × bound pairs (with `medium` low→high);
    - × multiple null/4 × A 0–2 × tier fast/medium/heavy/`constructor` × attemptsThisTier 0–2 × totalAttempts 0/1/4/5 × first cost null/1 × cumulative 0/4/5;
    - × `currentEffort` absent/null/5 levels × 6 verdicts.

    Results:
    - 47,520 cases differ. Every one has a non-null `currentEffort` outside `[base, bound]`.
    - None differ with the bump off.
    - With a valid bump, every HEAD `effort` is in `[base, bound]`.
    - 21,504 full fail loops from `newLadderState` used the same policies × T 1/4/8 × multiple null/2/4/8 × floor none/medium × producer fast/medium/heavy/off-ladder × ratios 1/3/6 and 1/1/1. HEAD matches `38efeb6` for every valid bump (action, state and scorecard JSON), and with the bump off HEAD matches `v2.0.0`.
    - The D8 S1 trace (I9) is unchanged: `retry fast@medium → escalate medium → retry medium@high → give_up "max total attempts (4) reached"`, scorecard `final_tier=medium@high`.
  - **Cost golden (`d348d25`).**
    - **Generator.** The write path takes only the five ladder functions from `git show v2.0.0:src/escalate/ladder.ts`; its single import is type-only and stripped. Policies and states are test-local literals with no `src` dependency. The replay passes HEAD's functions with `effortBump` absent and compares byte for byte.
    - **Independent regeneration from the `v2.0.0` tag.** I used two transpile paths: a Vite/esbuild import of the extracted source, and `node:module` `stripTypeScriptTypes` into a temp dir. Both outputs are byte-identical to the committed file (SHA-256 `A5E4F074…C4013F`), and so is HEAD's output.
    - **Matrix.** 576 entries: first cost null/1/2/5 × multiple null/4 × cumulative cost 0 / ceiling−1 / ceiling / ceiling+1. With multiple 4 and a non-null first cost, the "at ceiling" entries retry or escalate, and the "above" entries give up (6 per first cost). Null first cost and null multiple never give up on cost.
    - **Sequences.** Six, and all end with "cost ceiling exceeded". Producer fast runs `fast(1) → fast(2) → medium(5)`. Producer medium runs `medium(3) → medium(6) → heavy(12, exactly at the ceiling, retries) → heavy(18)`. Both repeat at scales 1, 2 and 5.
    - **No bump keys.** No `effortBump`, `currentEffort` or `effort` key appears anywhere.
    - **Mutations of the v2.0.0 source:**
      - `>` → `>=` changes 18 matrix entries and 3 sequences.
      - Dropping the null-first-cost guard changes 18 matrix entries.
      - Dropping the null-multiple guard changes 54 matrix entries.
      - Overwriting the first cost on every attempt changes all 6 sequences.
      - Swapping checks 3 and 4 is invisible to this fixture, because `totalAttempts` < `maxTotalAttempts` everywhere. The original golden has 60 matrix entries where both checks fire, so the check order stays pinned.
  - **Key order (`3e79738`).**
    - **Comparison.** I ran three builders over 29,106 tier shapes: `a68316b`, HEAD, and the `v2.0.0` builder followed by the v2.0.0 bridge translation (`v2-hooks.ts:128–134`, unchanged since `v2.0.0`).
    - **Shapes.** 22 ids (the I4 ids, the QA-1.3-5 ids, Vertex, Bedrock, Gemini, `gpt-oss`, `magistral-o1` and `""`) × effort absent/`ultra`/`High`/null/5 levels × thinking none/0/4096/−1/NaN/`"4096"`/`{}` × reasoning none/`{effort:"low"}`/`{summary:"auto"}`/`{effort:"high",summary:"detailed"}`/`{effort:""}`/`{summary:""}`/`{}` × variant none/`"high"`/`""`.
    - **Values and warnings.** `isDeepStrictEqual` values and the warning sequence (key and text, in order) are identical between `a68316b` and HEAD for every shape. Precedence is therefore unchanged.
    - **Key order.** It changed in 5,319 shapes, all of them among the five multi-key shapes (for example `thinking,reasoningEffort,reasoningSummary` → `reasoningEffort,reasoningSummary,thinking`).
    - **Against v2.0.0.** HEAD equals the v2.0.0 builder plus bridge in both values and key order for all 29,106 shapes, and the bridge leaves HEAD's bags unchanged.

**Round-1 findings**

| ID | Round-2 status | Evidence |
|---|---|---|
| QA-1.3-1 | resolved (deferred by plan) | Plan 2.3.5.b (`:1301`) passes `action.effort` into `runProducerAttempt` and sets the override before the prompt. 2.3.6 (`:1310, 1331–1341`) asserts the bumped attempt's `chat.params` options and the `tier@effort` scorecard. Phase 1.3 code is unchanged, as §0.7 requires. |
| QA-1.3-2 | resolved | `ladder.ts:164–171`. The clamp differential above shows no change for reachable states or with the bump off. The hand-built `low`/`max` states step to `xhigh` (`ladder.test.ts:1157–1167`). |
| QA-1.3-3 | resolved (test); A14 wording, see QA-1.3-R2-2 | `ladder.test.ts:847–878` pins the shipped default trace with the bump on and off: 3 attempts, cost 5, then "cost ceiling exceeded". A14 records the dependency on the cost ceiling. |
| QA-1.3-4 | resolved | I regenerated the cost golden independently and it is byte-identical. Coverage and mutation sensitivity are above. The original golden is byte-unchanged. |
| QA-1.3-5 | resolved | `effort-ceiling.test.ts:69–75`. Two ids are equivalents, not the literal round-1 ids: `github-copilot/claude-sonnet-5` for `…-4.5`, and `Anthropic/Claude-Sonnet-4-5` for `Anthropic/Claude-Opus-5-5`. Every requested id form (OpenRouter-Anthropic, Copilot GPT and Claude, Azure GPT, upper case, dotted) is covered. |
| QA-1.3-6 | resolved | Key-order differential above. `effort.test.ts:78–102` pins `Object.keys`. |
| QA-1.3-7 | resolved | The memo cites `2927540` (`:5–6`, `:176`). |
| QA-1.3-8 | resolved | Memo §5 (`:203`) now matches `resolveStartTier` (`ladder.ts:56–65`). |
| QA-1.3-9 | owner correct; handoff not picked up, see QA-1.3-R2-1 | README and CONFIG_REFERENCE are in 3.1's Wave 3 write-set (§2), so under §0.6.7 this is a handoff. But no 3.1 task names the drift, and 3.1's pre-flight does not read this file. |

**Round-2 findings.** No new defect in the fix commits. Both findings are plan edits owned by the orchestrator.

| ID | Severity | File:line | Description | Resolution |
|---|---|---|---|---|
| QA-1.3-R2-1 | minor | `docs/plans/delegation-depth-and-effort-bump-plan.md:1249, 1380–1381` (`de/main` `777a2d7`) | **No plan step picks up the handoffs recorded in this file.** Plan 1.3.2 (`:1046`) requires this phase to record handoffs to 2.3 and 3.1, and §0.6.7 says "the owner applies it". But neither consuming phase reads this report. QA-1.3-9 is resolved as "deferred by plan — Phase 3.1", yet 3.1's pre-flight collects only `phase-2.3.md` and the 0.P.2.g table, and 3.1.2/3.1.3 do not name the native-key lines (`README.md:282,483,491`, `CONFIG_REFERENCE.md:668–760`). 2.3's pre-flight applies only the "handoff to 2.3" items in `phase-2.1.md` and `phase-2.2.md`. That leaves this file's "To 2.3" notes (one config snapshot, host option precedence) unread. The only remaining route for the docs drift is 3.1's generic DoD claim check. Fix (orchestrator, plan amendment): have 2.3's pre-flight apply every "To 2.3" handoff in `phase-1.*.md`. Have 3.1's apply every "To 3.1" handoff in `phase-1.*.md` and `phase-2.*.md`, or name the QA-1.3-9 lines in 3.1.2/3.1.3. | open |
| QA-1.3-R2-2 | nit | `docs/plans/delegation-depth-and-effort-bump-plan.md:681–687` (A14) | **A14 says v2.0.0 also bumps.** The text reads "both `v2.0.0` and this change stop after three attempts (`fast@low → fast@medium → medium@high` …)". v2.0.0 actually runs `fast@low → fast@low → medium@high` (pinned at `ladder.test.ts:873`). 3.1 copies A14 into the ADR and CONFIG_REFERENCE, so A14 should give both traces. | open |

## Deferred by plan

- **QA-1.3-1 — deferred by plan — 2.3.5.b.** Phase 2.3 passes `action.effort` into `runProducerAttempt`, making the scorecard reflect the effort actually applied. No early Phase 1.3 code change.
- **QA-1.3-9 — deferred by plan — Phase 3.1 (Wave 3).** Correct the A4 native-key documentation in `README.md:282,483,491` and `docs/CONFIG_REFERENCE.md:668–760`; both files belong to Phase 3.1's write-set. They must describe `reasoningEffort` / `reasoningSummary` and `thinking`, not registration with the old snake-case keys.
- 1.3.4 waits for Phase 1.1 (`resolveEffortBump`) to be merged into `de/p13`.
- Phase 2.3 passes `action.effort` into `runProducerAttempt` and builds the options with `buildAgentOptions({ ...tier, effort })`; I4 is what makes the bump take effect. 2.3 also adjusts the v2 bridge.
- The `set` refusal above `effortCeilingFor` (plan, defence in depth) comes in a later phase.
- D7 reach: the active `anthropic` preset has zero tiers that can be bumped (0.P A5); the ADR and CONFIG_REFERENCE will publish the table.

## Handoffs

- **1.3.2 (@medium):** §1. Add the exports, then write I1–I4 in `test/unit/effort-ceiling.test.ts`.
- **1.3.2b (@medium):** §2 and A12. Done when I5 and I6 pass and the `rg` gate is clean.
- **1.3.3 (@medium):** §3 and §4. Covered by I7–I15 and I17. The fixture must not change.
- **1.3.4 (@medium, after 1.1):** §5. Covered by I16 and I17, and I7 must be re-run.
- **Owner:** whether to fix Bedrock Claude detection (F2), and whether to gate the thinking budget by family (F3).
- **To 2.2:**
  - `effortCeilingFor(tier)` is pure. It returns `null` for variant, unset, invalid or unknown-family tiers, for Claude with a winning budget, and for OpenAI with `reasoning.effort`.
  - `buildAgentOptions` now emits native keys only: `effort` (Claude), `reasoningEffort` / `reasoningSummary` (OpenAI and non-Claude `reasoning.*`), and `thinking: { type: "enabled", budgetTokens }`, a new object per call.
  - The ceiling and the builder agree by construction: same predicates, Claude checked before OpenAI. Any per-turn or per-session override must call `buildAgentOptions({ ...tier, effort })` and must never re-derive keys, or that agreement breaks.
  - Bedrock Claude ids classify as unknown (F2).
- **To 2.3:**
  - **Wire the effort.** Pass `action.effort` into `runProducerAttempt` (`src/index.ts:861` is `runProducerAttempt(tier, forcing)` today). This closes QA-1.3-1. Add a test that the effort in the scorecard equals the effort applied.
  - **Use one config snapshot.** Build every attempt's options from the same `activeCfg` snapshot as the policy (`:551`/`:566`). Never mix in the registration-time agent options from the config hook. A tiers.json edit or a `/preset` switch between registration and delegation would otherwise make the bump's base disagree with attempt 1, which lowers effort (QA-1.3-2) or crosses families. Never rebuild the policy inside a loop.
  - **Bridge translation (A4).** With native builder output, the bridge's snake-key translation (`v2-hooks.ts:125–135`) is dead code for router bags. When 2.3 keeps the aliases for other bags, invert today's precedence. At present `{ ...options, …alias }` lets an alias override a native key: `{ reasoningEffort: "low", reasoning_effort: "high" }` → `"high"`. A4 requires the explicit native key to win.
  - **Host option precedence.** The per-turn merge (`:214–215`) skips any key already present in `event.options`, including keys whose value is `undefined`. The per-turn effort override must decide its precedence against host options explicitly.
  - **Key order** restored to v2.0.0 by QA-1.3-6 without changing values or precedence. Provider integration tests can still assert with `toEqual`; builder tests now also pin `Object.keys` order.
- **To 3.1:**
  - **CHANGELOG.** Add a `Fixed` entry for the v1 native-key change at `788034d`, flagged as a v1 behaviour change. Cases:
    - OpenAI-regex families now receive `reasoningEffort`/`reasoningSummary`: Copilot, OpenRouter and Azure `gpt-*`; `gpt-oss` through Ollama or Groq; and false positives on `-o1`/`-o3` ids (for example `mistral/magistral-o1`, which counts as OpenAI).
    - Claude tiers with a budget now send `thinking`.
    - Unknown-family tiers (Bedrock Claude, Gemini) with `thinking.budgetTokens` or `reasoning.*` now send `thinking`/`reasoningEffort`/`reasoningSummary`. The provider effect is unverified.
    - Remedy: remove `effort`, `reasoning.*` or `thinking` from the affected tier.
  - **Preset table (A5, confirmed here):**
    - `anthropic`: 0 bumpable tiers (all set a variant).
    - `openai`, `github-copilot`, `google`, `zai`: 0 (no `effort`).
    - `hybrid`: 0 (the OpenAI tiers have no `effort`; heavy sets a variant).
    - `fable-effort`: fast low→xhigh and medium high→xhigh; heavy is excluded because its base equals its bound.
    - At the default `costMultiple: 4`, `fable-effort` runs `fast@low → fast@medium → medium@high` and stops on the cost ceiling, so medium's bump never runs. Fix D8's "four attempts" wording (QA-1.3-3), and state in the ADR that a bumped retry is charged at the tier's ratio (F4).
  - **Docs.** Update the drift listed in QA-1.3-9.

## Verdict

**Round 2: the phase code is accepted, but two findings are open: QA-1.3-R2-1 (minor) and QA-1.3-R2-2 (nit).** Both are plan edits for the orchestrator on `de/main`. Neither needs a change on `de/p13`.

All nine round-1 findings are resolved; QA-1.3-1 and QA-1.3-9 are deferred, and R2-1 covers how QA-1.3-9's handoff reaches 3.1. The fix commits introduce no defect. The phase's acceptance criteria hold on the round-2 evidence:

- Bump off is byte-identical to v2.0.0, now including the cost-ceiling paths.
- Bump on follows D8 on every reachable state. The clamp changes only hand-built states that are out of range.
- The builder's values, warnings and key order match v2.0.0's builder plus bridge.
- The ceiling never yields a value that `buildAgentOptions` alters or warns about.

Under §0.7, every round-2 finding must be fixed before DoD, which requires zero open findings in this file. A round 3 would re-review only blocking, critical and major fixes, and none is open.

### Round-1 resolution verification

- Required scoped command: `npx vitest run test/unit/ladder.test.ts test/unit/effort-ceiling.test.ts test/unit/effort.test.ts test/integration/fable-effort-preset.test.ts test/unit/v2-hooks.test.ts --maxWorkers=50%` — **5 files, 4,042 tests passed**. No full suite or smoke suite run.
- The same five files passed with V8 coverage restricted to `src/escalate/ladder.ts` and `src/router/agent-options.ts`, with all global thresholds set to 95%. **Both files: 100% statements, branches, functions and lines.** Combined counts: 137/137 statements, 161/161 branches, 22/22 functions, 123/123 lines. Ladder: 75 statements, 92 branches, 12 functions, 66 lines. Builder: 62 statements, 69 branches, 10 functions, 57 lines.
- `npm run typecheck` and `git diff --check` passed.
- Original fixture: `git diff 2927540 -- test/unit/__fixtures__/ladder-v2.0.0-golden.json` empty; SHA-256 `F4FECEECF459375273AE850419FF4CED877DB83311BCA4CABBE5211F60E029A2`. `GOLDEN_WRITE` was never set.
- New cost fixture: generated with `GOLDEN_WRITE_COST=1` from `git show v2.0.0:src/escalate/ladder.ts`, extracted to an external temporary module and type-stripped without changing its implementation. Only the new JSON and gated generator/replay code are committed; the temporary reference is removed. Read-only replay passed with the flag unset. Covers null first cost, null multiplier, first costs 1/2/5, below/at/above ceilings, and six heterogeneous-cost sequences ending on the cost ceiling.
- Focused checks before commits: QA-1.3-2 ladder 177 tests; QA-1.3-3 ladder 178; QA-1.3-4 ladder 179 (generation and read-only replay); QA-1.3-5 effort-ceiling 3,742; QA-1.3-6 effort/ceiling/v2-hooks 3,858. The seven new model ids add 1,169 cases; the clamp, shipped trace, cost replay and key-order tests add seven more (4,042 total versus 2,866 before).

Resolution of round 2 (orchestrator, on `de/main`): QA-1.3-R2-1 → plan §1.7 A15 (every phase applies the handoffs addressed to it; names the QA-1.3-9 lines for 3.1); QA-1.3-R2-2 → A14 now gives both traces. Commit `d894a6c`.

**Open findings: 0** (every round-1 and round-2 finding fixed or deferred by plan: QA-1.3-1 → 2.3.5.b, QA-1.3-9 → 3.1). Merged into `de/main` in `03949d2`.
