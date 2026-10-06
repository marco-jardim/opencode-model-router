# Phase 1.5 — Session-aware ladder algebra (M5)

> Plan: `D:\git\opencode-model-router\docs\plans\cost-aware-routing-engine-plan.md` §1.3 M5, §1.4, §1.5 D10/D11 and amendments A5, A7, A9, A10, §3 Phase 1.5.
> Worktree `D:\git\omr-car-p15`, branch `car/p15`. Issue #74.

## Pre-flight

| Item | Result |
|---|---|
| Base | `car/p15` at `3b3dba4` (merge of phase 0.P); worktree clean before 1.5.1 |
| Phase 1.1 merged here? | **No.** `TierConfig` has no `candidates`, `EnforcementConfig.escalate` has no `variantSteps`, there is no `routing.sessionReuse` (`src\router\config.ts` 85–109, 174–178). The design below therefore reads none of 1.1's types: `variants.ts` takes structural slices, and `buildEscalatePolicy` receives the resolved values through a new optional argument (see `LadderSessionPolicyInput`). |
| Golden fixtures | `test\unit\__fixtures__\ladder-v2.0.0-golden.json` (replayed by `test\unit\ladder.test.ts` 1413–1583, including the explicit-`effortBump: null` replay at 1570) and `test\unit\__fixtures__\ladder-v2.0.0-golden-cost.json` (replayed at 90–124). Both are only read in this phase. |
| Byte-identity seam | `src\escalate\ladder.ts:221–222`: optional policy keys are assigned only when present, so a feature that is off leaves the object byte-identical. The design reuses that pattern for every new key. |
| 0.P evidence used | S2 (variant switch on resume, in-band effort), S2b (`default` variant, haiku `thinking.budget_tokens`, model+variant switch), S4 (live variant lists in host effort order: sonnet/opus `low, medium, high, xhigh, max`; haiku `high, max`; gpt-6-luna(-fast) `none, low, medium, high, xhigh, max`; `limit.input` 272 000 for gpt-6-luna), S6 (auto compaction does not guarantee fit) |
| Typecheck | `npm run typecheck` green after 1.5.1 |
| Tests | `npx vitest run test/unit/escalate-variants.test.ts test/unit/ladder.test.ts` → `Test Files 2 passed (2)`, `Tests 217 passed (217)`. Under pwsh, `ladder*` is not expanded and reaches vitest as a literal filter that matches no file, so name the files explicitly. |

## Implementation notes

### Design (1.5.1)

#### 0. Scope and files

- **Written in 1.5.1:** `src\escalate\variants.ts`, which is pure and covers the catalog half of M5, and `test\unit\escalate-variants.test.ts`.
- **Specified here for 1.5.2 (@medium):** the changes to `src\escalate\ladder.ts` and a new appended test file `test\unit\ladder.session.test.ts`. That name matches the plan's `ladder*.test.ts` write-set. `ladder.test.ts` and both fixtures stay untouched.
- **Purity:** `nextAction`, `advance`, `recordAttempt`, `newLadderState` and `resumeDecision` stay pure. They do no I/O, read no clock and never mutate their inputs. `buildEscalatePolicy` receives a catalog lookup function and does not call the host.

#### 1. `variants.ts` (delivered)

| Export | Contract |
|---|---|
| `HOST_EFFORT_ORDER` | `none, minimal, low, medium, high, xhigh, max`: the host's `ReasoningEfforts` order (S4 asserted that every live list follows it) |
| `DEFAULT_VARIANT` | `"default"`: what the host stores for a child created without a variant (A9). It never appears in `variants[]` and this module never emits it. |
| `DEFAULT_VARIANT_POSITION` | `rank("high") − 0.5` = 3.5, **the rank of `default` (A9)**. See §2. |
| `variantRank(id)` / `variantPosition(id)` | Index in the host order, or −1. `variantPosition` returns 3.5 for `default`/`""`/`null`/`undefined` and `null` for unranked ids. |
| `catalogVariantIds(entry)` | `variants[].id` in catalog order with junk, duplicates and `default` removed. Returns `null` when there is no `variants` array. |
| `buildVariantLadder({ model, catalog, candidates?, maxEffort? })` | Builds the `VariantLadder { model, variants, source, rejected }`, frozen. See below. |
| `nextVariant(ladder, current)` | Returns the next step or `null`. See below. |
| `modelRef(model, variant)` | Returns `provider/model#variant`, or the bare model for `default`/none (this is the host `subagent` `model` field). |
| `inputBudget(limit)` | A5/A10: `limit.input ?? (limit.context − limit.output)`. Returns `null` when the value is unknown or ≤ 0. |
| `stepContextTokens(tokens)` | D11: `input + cache.read + cache.write + output` of one `TokenUsage.Info`. Reasoning is excluded and a missing cache counts as 0; any other invalid value gives `null`. |
| `estimateTokensFromChars(n)` | A5: `ceil(n / 4)`. Returns `null` for an invalid `n`. |
| `resumeDecision(state, cfg)` | D11 as amended by A5. See §5. `ladder.ts` re-exports it, so the plan's API location holds. |

**Ladder construction (catalog order ∪ explicit candidates, catalog-validated):**

1. If the catalog entry has no `variants` array, there is no ladder (`source: "none"`). Variants named by candidates go to `rejected`.
2. If the tier's configured `candidates` name at least one variant of this model, the ladder is exactly those variants in candidate order. A candidate without a `model` inherits the ladder's model. Variants are deduplicated, and those absent from the catalog are dropped into `rejected`. **This is how explicit candidates override catalog order.** No `maxEffort` cap applies, because the user listed them.
3. Otherwise the ladder is the catalog's ids in catalog order, filtered three ways:
   - only ids that have a rank are kept;
   - ids ranked above `maxEffort` are dropped (the resolved `effortBumpMax`, see Finding F2);
   - an id is kept only if it ranks strictly above the previous kept id, so a catalog ladder never steps down.
4. Every id in `ladder.variants` therefore belongs to the catalog's `variants[]`, and `default` is never one of them.
5. The caller passes the tier's raw `candidates` field. It must not pass `resolveCandidates()` output, because the defaulted single-entry list would pin the ladder to the tier's own variant (Finding F11).

**`nextVariant(ladder, current)`:**

- If `current` is on the ladder, the result is the following entry, or `null` at the top.
- If `current` is `default`/`null`/`undefined`/`""`, the result is the first entry whose rank is above 3.5, which means the lowest variant ranked `high` or above. If there is none, the result is `null`.
- If `current` is any other ranked id that is not on the ladder (for example a configured base the cap or the candidates skip), the result is the first entry ranked strictly above it. This covers the plan's "unknown current → first above base" test.
- If `current` is an unranked id that is not on the ladder, the result is `null`.
- Every non-null result is a ladder member, so stepping terminates within `ladder.variants.length` steps.

#### 2. Rank of the stored `default` variant (A9)

`default` is **not a ladder member**. Its position is **3.5, strictly between `medium` and `high`**. The first variant step from `default` is therefore the lowest ladder variant ranked `high` or above:

| Model (live S4 list, capped at `xhigh`) | Ladder | First step from `default` |
|---|---|---|
| `claude-sonnet-5-5` / `claude-opus-5-5` | low, medium, high, xhigh | `high` |
| `claude-haiku-4-5` | high | `high` (`thinking.budget_tokens` 16 000; A7) |
| `gpt-6-luna(-fast)` | none, low, medium, high, xhigh | `high` |
| `opencode-go/deepseek-v4.1-flash` (uncapped) | low, high, max | `high` |
| any ladder topping out below `high` | e.g. low, medium | none, so the ladder goes straight to escalation |

**Why 3.5:**

- A child without a variant sends no effort (S2b), so its effective effort is whatever the provider uses by default:
  - `claude-haiku-4-5`: no thinking;
  - Anthropic Messages API: `high`;
  - OpenAI reasoning models: `medium` or lower.
- These defaults are documented by the providers, but 0.P only observed that nothing is sent. They are **unverified** here and tracked as Finding F9.
- A position just below `high` makes the first step never lower than any of these defaults. It also never wastes an attempt on a `none`/`low` step that would reduce reasoning.
- It is the smallest step that meets both conditions, so the cheaper rungs above it stay available.

#### 3. Policy, state and action extensions (`ladder.ts`, for 1.5.2)

New types, exactly as below. Every new field is optional, so existing literals still type-check.

```ts
import {
  DEFAULT_VARIANT, buildVariantLadder, catalogVariantIds, estimateTokensFromChars, inputBudget,
  nextVariant, resumeDecision, variantPosition,
  type CatalogModel, type ResumeDecision, type VariantLadder,
} from "./variants";
export { resumeDecision, type ResumeDecision } from "./variants";

/** Per-tier variant data; built only on v2 with variantSteps "auto" and a catalog entry. */
export interface TierVariantInfo {
  model: string;              // "provider/model" of the tier
  base: string;               // tier.variant (a catalog member) or DEFAULT_VARIANT
  ladder: VariantLadder;      // buildVariantLadder(...) for that model
  inputBudget: number | null; // inputBudget(catalogEntry.limit)  (A5/A10)
}
export interface VariantPolicy {
  maxContextFraction: number; // routing.sessionReuse.maxContextFraction (default 0.6)
  perTier: Record<string, TierVariantInfo>;
}
export interface EscalatePolicy { /* existing fields */ variants?: VariantPolicy | null }

export interface LadderState {
  /* existing fields */
  currentVariant?: string | null;   // variant reached by variant steps on the current tier; null = the tier's base
  variantSteps?: number;            // variant steps taken in this delegation (never reset)
  childSessionID?: string | null;   // child of the latest attempt; null = none, or a fresh start is pending
  lastStepTokens?: number | null;   // stepContextTokens() of that child's last step; null = unknown
  nextModelContext?: number | null; // inputBudget of the model the next attempt runs on
}

export interface LadderAction {
  /* existing fields */
  variantStep?: true;           // present only on a D10 variant step (action is "retry")
  agent?: string;               // escalate only: target agent id (= tier name for router tiers)
  model?: string;               // "provider/model" of the target, when it has TierVariantInfo
  variant?: string;             // catalog-validated target variant; absent = default / leave unchanged
  resume?: boolean;             // present on every retry/escalate when policy.variants is set
  resumeBasis?: ResumeDecision; // D11 "decision and both numbers are logged"; present iff resume is
}

/** Fourth, optional argument of nextAction. */
export interface LadderSessionInput { dispatchPromptChars: number }

/** Child observation passed to recordAttempt after an attempt on a session-aware policy. */
export interface LadderChildObservation { sessionID: string; lastStepTokens: number | null }

/** Second, optional argument of buildEscalatePolicy (filled by Phase 2.3 from 1.1's resolved config). */
export interface LadderSessionPolicyInput {
  host: "v1" | "v2";
  variantSteps?: "auto" | "none";   // default "auto" (D10)
  maxContextFraction?: number;      // default 0.6 (§1.4)
  catalog: (model: string) => CatalogModel | null | undefined; // must not throw
}
```

Shared helper. It uses the same own-property guard as the effort bump at `ladder.ts:161`:

```ts
function ownTierInfo(policy: EscalatePolicy, tier: string): TierVariantInfo | undefined {
  const perTier = policy.variants?.perTier;
  return perTier && Object.prototype.hasOwnProperty.call(perTier, tier) ? perTier[tier] : undefined;
}
/** A variant may be emitted only when it is the tier's validated base or a ladder member, never default. */
function emittable(info: TierVariantInfo, v: string): string | undefined {
  return v !== DEFAULT_VARIANT && (v === info.base || info.ladder.variants.includes(v)) ? v : undefined;
}
```

#### 4. `buildEscalatePolicy(cfg, session?)`

The function body stays as it is today. After the existing `effortBump` assignment, append:

```ts
const variants = buildVariantPolicy(cfg, session);
if (variants) policy.variants = variants;   // absent key when off: goldens unchanged
```

```ts
function buildVariantPolicy(cfg: RouterConfig, session?: LadderSessionPolicyInput): VariantPolicy | null {
  if (!session || session.host !== "v2" || (session.variantSteps ?? "auto") === "none") return null; // D1, D10
  const { max } = resolveEffortBump(cfg);                       // cap for catalog ladders (F2)
  const entries: Array<[string, TierVariantInfo]> = [];
  for (const [name, tier] of Object.entries(getActiveTiers(cfg) ?? {})) {
    if (tier === null || typeof tier !== "object" || typeof tier.model !== "string" || tier.model.length === 0) continue;
    const configured = typeof tier.variant === "string" && tier.variant.length > 0 ? tier.variant : null;
    // One effort delivery per tier (F3): effort/thinking/reasoning-configured tiers keep the effortBump path.
    if (configured === null && (tier.effort !== undefined || tier.thinking !== undefined || tier.reasoning !== undefined)) continue;
    const entry = session.catalog(tier.model);
    const ids = catalogVariantIds(entry);
    if (ids === null) continue;                                  // no catalog: today's behaviour for this tier
    if (configured !== null && !ids.includes(configured)) continue; // invalid configured variant: never resume-switch it
    const raw = (tier as { candidates?: unknown }).candidates;    // raw config, never resolveCandidates() (F11)
    entries.push([name, {
      model: tier.model,
      base: configured ?? DEFAULT_VARIANT,
      ladder: buildVariantLadder({ model: tier.model, catalog: entry, candidates: Array.isArray(raw) ? raw : undefined, maxEffort: max }),
      inputBudget: inputBudget(entry?.limit),
    }]);
  }
  if (entries.length === 0) return null;
  return { maxContextFraction: session.maxContextFraction ?? 0.6, perTier: Object.fromEntries(entries) };
}
```

**Properties of `buildVariantPolicy`:**

- `perTier` is built with `Object.fromEntries`, so tiers named `__proto__`/`constructor` become own entries, exactly as `buildEffortBump` does.
- A tier can be in `effortBump.perTier` or in `variants.perTier`, **never both**:
  - `effortBump` requires `tier.effort` and no `variant` (`effortCeilingFor`);
  - `variants` requires either a `variant` or no effort/thinking/reasoning.

#### 5. `resumeDecision(state, cfg)` (delivered in `variants.ts`)

```text
resume  ⇔  childSessionID is a non-empty string
          ∧ lastStepTokens, nextPromptTokens are finite ≥ 0
          ∧ nextModelContext is finite > 0
          ∧ 0 < maxContextFraction ≤ 1
          ∧ lastStepTokens + nextPromptTokens  <  maxContextFraction × nextModelContext
```

**Inputs:**

- `nextModelContext` is the `inputBudget` of the **next** model (A5).
- `nextPromptTokens = estimateTokensFromChars(forcingMessage.length + dispatchPromptChars)` (A5).

**Outcome:**

- Resume requires strict `<`. Exactly at the threshold, the result is **fresh**.
- Any unknown input also gives fresh.
- The result `{ resume, reason, tokens, budget, threshold }` always reports every number it could compute, so the runner can log the decision and both numbers (D11).

**Reasons, checked in this order:**

1. `no-child`
2. `unknown-tokens`
3. `unknown-budget`
4. `unknown-estimate`
5. `invalid-fraction`
6. `under-threshold` / `at-or-over-threshold`

#### 6. `newLadderState`, `recordAttempt`

```ts
// newLadderState — after the existing effortBump line
if (policy.variants) {
  state.currentVariant = null;
  state.variantSteps = 0;
  state.childSessionID = null;
  state.lastStepTokens = null;
  state.nextModelContext = ownTierInfo(policy, state.currentTier)?.inputBudget ?? null; // start tier after floorTier
}

// recordAttempt(state, costUnits = 0, child?: LadderChildObservation) — existing literal, then:
if (child && state.childSessionID !== undefined) {
  next.childSessionID = child.sessionID;
  next.lastStepTokens = child.lastStepTokens;
}
```

`recordAttempt` keeps its existing literal, assigned to `const next` and returned. The child parameter has no effect when it is absent or when the state is not session-aware.

#### 7. `nextAction(state, verdict, policy, session?)`: new order

Checks (1)–(4) are **unchanged, byte for byte**. On the order of (3) and (4), see Finding F1.

| # | Step | Condition | Result |
|---|---|---|---|
| 1 | accept | `verdict.pass === true` | `{ action: "accept" }` |
| 1b | unverifiable | `verdict.outcome === "unverifiable"` | give_up (existing reason) |
| 3 | max total | `totalAttempts >= maxTotalAttempts` | give_up (existing reason) |
| 4 | cost ceiling | `cumulativeCost > firstAttemptCost × costMultiple` | give_up (existing reason) |
| **5V** | **variant step (D10)** | `policy.variants` set ∧ `info = ownTierInfo(policy, currentTier)` ∧ `nextVariant(info.ladder, state.currentVariant ?? info.base) !== null`. **Not** gated by `attemptsThisTier`. | `retry` + `variantStep: true`, `model`, `variant`, `resume`, `resumeBasis` |
| 5 | retry within tier | `attemptsThisTier < maxAttemptsPerTier`: existing block, including the effort bump | the existing action. When `policy.variants` is set, the variant and session fields are attached as described below. |
| 6 | escalate | otherwise; with variants, `skipCoveredTiers` first (F4) | `escalate`. When `policy.variants` is set, `agent`, `model`, `variant` and the session fields are attached as described below. |

```ts
// after check (4):
const variants = policy.variants ?? null;
const info = variants ? ownTierInfo(policy, state.currentTier) : undefined;

if (variants && info) {                                            // (5V)
  const variant = nextVariant(info.ladder, state.currentVariant ?? info.base);
  if (variant !== null) {
    const forcingMessage = buildLadderForcingMessage(verdict?.reasons ?? []);
    return {
      action: "retry", tier: state.currentTier, forcingMessage, variantStep: true,
      model: info.model, variant,
      ...sessionFields(state, variants, info, forcingMessage, session),
    };
  }
}

// (5) existing retry block unchanged; replace its final `return action;` with:
if (variants) {
  if (info) {
    action.model = info.model;
    const v = emittable(info, state.currentVariant ?? info.base);
    if (v !== undefined) action.variant = v;   // keeps the reached variant on a fresh retry
  }
  Object.assign(action, sessionFields(state, variants, info, action.forcingMessage!, session));
}
return action;

// (6) escalate:
let next = nextTierAfter(state.currentTier, policy);
if (variants && info) next = skipCoveredTiers(next, state, policy, info);
if (next == null) return { action: "give_up", reason: "no higher tier (already at top of ladder)" }; // unchanged literal
const action: LadderAction = { action: "escalate", tier: next, forcingMessage: buildLadderForcingMessage(verdict?.reasons ?? []) };
if (variants) {
  const target = ownTierInfo(policy, next);
  action.agent = next;                                       // D11: the role changes on escalation
  if (target) {
    action.model = target.model;
    const v = emittable(target, target.base);
    if (v !== undefined) action.variant = v;
  }
  Object.assign(action, sessionFields(state, variants, target, action.forcingMessage!, session));
}
return action;
```

```ts
function sessionFields(state: LadderState, variants: VariantPolicy, target: TierVariantInfo | undefined,
                       forcingMessage: string, session?: LadderSessionInput): Pick<LadderAction, "resume" | "resumeBasis"> {
  const resumeBasis = resumeDecision(
    { childSessionID: state.childSessionID, lastStepTokens: state.lastStepTokens,
      nextModelContext: target?.inputBudget ?? null },              // the NEXT model's budget (A5)
    { maxContextFraction: variants.maxContextFraction,
      nextPromptTokens: estimateTokensFromChars(forcingMessage.length + (session?.dispatchPromptChars ?? 0)) },
  );
  return { resume: resumeBasis.resume, resumeBasis };
}

/** D10 "escalate the model": skip next tiers on the same model whose base the current tier already covered. */
function skipCoveredTiers(next: string | null, state: LadderState, policy: EscalatePolicy, from: TierVariantInfo): string | null {
  const reached = variantPosition(state.currentVariant ?? from.base);
  if (reached === null) return next;
  let hops = 0;
  while (next != null) {
    const to = ownTierInfo(policy, next);
    if (!to || to.model !== from.model) return next;
    const position = variantPosition(to.base);
    if (position === null || position > reached) return next;
    if (++hops >= policy.ladder.length) return null;   // guard: duplicate ladder entries cannot spin
    next = nextTierAfter(next, policy);
  }
  return null;
}
```

**Rules that follow from the order:**

- **Variant targets.** A variant step's target is always a ladder member, so it comes from the catalog. A plain retry or an escalation emits only a base or a ladder member, through `emittable`. `nextAction` never emits `default` or a variant absent from `variants[]`.
- **Escalating to a tier without info** (an effort-configured tier or a tier with no catalog entry):
  - `agent` is set;
  - `model` and `variant` are absent;
  - `resume` is `false` with reason `unknown-budget`, so the runner starts fresh exactly as today.
- **Scope of the session fields.** Variant and session fields appear only when `policy.variants` is set. Without it, the 4th argument is ignored.
- **Exclusivity is not re-checked.** `effort` and `variant` cannot both appear on a built policy (§4). For hand-built policies, `nextAction` does not enforce it.

#### 8. `advance(state, action)`

```ts
if (action.action === "retry") {
  const next: LadderState = { ...state };
  if (action.variantStep === true) {
    next.currentVariant = action.variant ?? null;
    next.variantSteps = (state.variantSteps ?? 0) + 1;      // does NOT touch attemptsThisTier
  } else {
    next.attemptsThisTier = state.attemptsThisTier + 1;     // same key order as the old literal
  }
  if (action.effort !== undefined) next.currentEffort = action.effort;
  applySession(next, action);
  return next;
}
if (action.action === "escalate") {
  const next = { ...state, currentTier: action.tier!, attemptsThisTier: 0, escalations: state.escalations + 1 };
  if (next.currentEffort !== undefined) next.currentEffort = null;
  if (next.currentVariant !== undefined) next.currentVariant = null;   // new tier starts at its base
  applySession(next, action);
  return next;
}
return state; // accept / give_up unchanged

function applySession(next: LadderState, action: LadderAction): void {
  if (next.childSessionID === undefined) return;            // not session-aware: shape unchanged
  if (action.resume !== true) next.childSessionID = null;   // fresh start: clear the stale child
  next.lastStepTokens = null;                               // must be re-observed after the next attempt
  next.nextModelContext = action.resumeBasis?.budget ?? null;
}
```

`lastStepTokens` is cleared even when the next attempt resumes. If the runner fails to record the resumed attempt's tokens, the next decision falls back to `unknown-tokens`, which means fresh, instead of reusing a stale (smaller) number.

#### 9. Attempt accounting

| Counter | Plain retry | Variant step | Escalate |
|---|---|---|---|
| `totalAttempts`, `cumulativeCost`, `firstAttemptCost` | `recordAttempt` (runner, once per attempt) | same | same |
| `attemptsThisTier` (gate of `maxAttemptsPerTier`) | +1 | **unchanged** | reset to 0 |
| `variantSteps` | unchanged | +1 | unchanged |
| `escalations` | unchanged | unchanged | +1 |

Consequences:

- Variant steps count toward `maxTotalAttempts` and toward the cost ceiling: checks (3) and (4) precede step 5V, and the runner records every attempt. A variant step can therefore never bypass the cost ceiling.
- Variant steps do not consume `maxAttemptsPerTier`.
- **`maxAttemptsPerTier: 1` with `variantSteps: auto`** on a tier with one higher variant gives the sequence `retry(variantStep)` → `retry` (plain, at the reached variant) → `escalate`.
- **`maxAttemptsPerTier: 0`** gives `retry(variantStep)` → `escalate`.

Termination:

- On one tier there are at most `|ladder|` variant steps, because the ladder index strictly increases.
- `maxTotalAttempts` still bounds every non-terminal action, because check (3) runs first.

#### 10. `formatLadderScorecard`

The `final_tier` suffix becomes `currentEffort ? "@"+effort : currentVariant ? "#"+variant : ""`. With `currentVariant` absent or `null`, the string is unchanged. The `#` mirrors the host's `model#variant` notation.

#### 11. Proof obligation: goldens byte-identical with `variantSteps: "none"`, no catalog, or v1

1. **L1 — `buildEscalatePolicy`.** `buildEscalatePolicy(cfg)` with one argument returns `buildVariantPolicy(cfg, undefined) = null`. So do the cases `session.host === "v1"`, `variantSteps === "none"`, and a catalog without a `variants` array for every tier (or no eligible tier). In all of them the `variants` key is never assigned (the pattern of `ladder.ts:221`), so the policy JSON is unchanged.
2. **L2 — `newLadderState`.** The new block runs only when `policy.variants` is truthy, so no new keys are added.
3. **L3 — `recordAttempt`.** With two arguments, the new branch is skipped. It also needs `state.childSessionID !== undefined`.
4. **L4 — `nextAction`.** `variants` is `null`, so all of these are skipped:
   - step 5V;
   - the retry attachment;
   - `skipCoveredTiers`;
   - the escalate attachment.

   Checks (1)–(4) and every returned literal keep today's key order. The 4th argument is read only inside `sessionFields`.
5. **L5 — `advance`.** Golden actions never carry `variantStep`, and golden states carry neither `currentVariant` nor `childSessionID`.
   - Retry takes the else branch. Assigning `next.attemptsThisTier` on a spread copy keeps the key where it was in the old literal, because `attemptsThisTier` is a required key that already exists.
   - `applySession` returns at once.
   - In escalate, the `currentVariant` guard is false.
6. **L6 — `formatLadderScorecard`.** The suffix differs only when `currentVariant` is truthy, which requires a variant step.
7. **L7 — fixture coverage.** Every entry of both fixtures uses:
   - a policy from `buildEscalatePolicy(config)` (one argument) or from `makePolicy` (no `variants`);
   - a state literal without the new keys;
   - an action produced by `nextAction` from those.

   L1–L6 therefore cover every entry, and both fixture replays stay byte-identical with `ladder.test.ts` unmodified.
8. **Mechanical check (1.5.2, new test).** Replay every `matrix` entry and every `sequences` step of both fixtures through `nextAction`/`advance`/`formatLadderScorecard` with each of these policies:
   - (a) the recorded policy plus `variants: null`;
   - (b) `buildEscalatePolicy(cfg, s)` for `s` ∈ { `{host:"v1", catalog: all}`, `{host:"v2", variantSteps:"none", catalog: all}`, `{host:"v2", catalog: () => undefined}` }, first asserting `JSON.stringify` equality with the one-argument policy.

   Compare `JSON.stringify` of every output with the fixture. The diff must be empty. This is the plan's "goldens: run the full existing ladder suite with the new fields defaulted and diff outputs (must be empty)".

#### 12. A7 facts that bear on the algebra

- **Haiku variants.** `claude-haiku-4-5` variants `high`/`max` are `thinking.budget_tokens` values (16 000 / 31 999), not effort levels. The ladder ranks them by id only. That ordinal is correct (`high < max`), so the algebra needs no delivery-specific case.
- **Same-model variant changes.** These travel in-band on Anthropic when resumed, but at the top level on a fresh session or with a model change. The ladder emits the same `variant` either way. Which delivery happens is decided by `resume`, and the effective effort is asserted in 3.2.
- **Stepping from `default`.** A `default` → variant step changes the top-level `thinking` object (cache-relevant). It is still the minimal non-decreasing step (§2).
- **Exclusivity.** Where agent-level `effort` options and a variant would both be sent, it is unverified which one wins. Each tier therefore gets exactly one delivery path (F3).
- **In-band acceptance.** Whether the provider honours in-band effort is unverified. The algebra does not depend on it.

#### 13. Test map (plan §3 Phase 1.5 "Tests" → function → file)

| Plan test | Function(s) | File | Owner |
|---|---|---|---|
| Variant ladder from `[low, medium, high, xhigh]` | `buildVariantLadder` | `escalate-variants.test.ts` "builds the ladder…" | 1.5.1 ✅ |
| Current `xhigh` → no next | `nextVariant` | `escalate-variants.test.ts` "steps to the following…" | 1.5.1 ✅ |
| Unknown current → first above base | `nextVariant` | "places an unknown ranked current…" and the `default` cases (A9) | 1.5.1 ✅ |
| Explicit `candidates` override catalog order | `buildVariantLadder` | "explicit candidates override…", "filters candidates…" | 1.5.1 ✅ |
| Resume decision exactly at threshold → fresh | `resumeDecision` | "starts fresh exactly at the threshold…" | 1.5.1 ✅. 1.5.2 repeats it through `nextAction`, computing the threshold from the actual `forcingMessage.length`. |
| Context limit of the **next** model used | `inputBudget`, `resumeDecision`, `nextAction` (6) | `escalate-variants.test.ts` "uses the budget it is given…"; `ladder.session.test.ts` escalation from a 1 000 000 budget to an 800 000 budget, with tokens between the two thresholds → `resume: false`, `resumeBasis.budget === 800000` | 1.5.1 ✅ / 1.5.2 |
| Variant steps count toward `maxTotalAttempts` and cost ceiling, not `maxAttemptsPerTier` | `nextAction` (3)(4)(5V), `advance` | `ladder.session.test.ts`: `maxTotalAttempts: 2` stops after one variant step; cost above the ceiling → `give_up "cost ceiling exceeded"` with a variant available, at the ceiling → variant step; `attemptsThisTier` unchanged by a variant step; a hand-built `attemptsThisTier === maxAttemptsPerTier` still gets the variant step | 1.5.2 |
| `maxAttemptsPerTier: 1` + `variantSteps: auto` still yields one variant retry before escalation | `nextAction`, `advance` | `ladder.session.test.ts`: ladder `[high, xhigh]`, base `high` → actions `retry(variantStep xhigh)`, `retry`, `escalate`; with `maxAttemptsPerTier: 0` → `retry(variantStep)`, `escalate` | 1.5.2 |
| `escalate` carries `resume: true` only under the threshold | `nextAction` (6), `sessionFields` | `ladder.session.test.ts`: under → `true`; at/over → `false`; no child → `false`; target tier without info → `false` (`unknown-budget`), with `agent` set and no `model` | 1.5.2 |
| Goldens: existing suite with new fields defaulted, diff empty | L1–L7 | `ladder.session.test.ts` mechanical replay (§11 point 8); `ladder.test.ts` unmodified and green | 1.5.2 |
| QA: infinite variant loops | `nextVariant`, `skipCoveredTiers` | `escalate-variants.test.ts` termination property ✅; `ladder.session.test.ts` duplicate-ladder `["fast","fast"]` with a covered tier → `give_up` without hanging; seeded property run (like `ladder.test.ts` 1321) with random ladders/catalogs: every run ends within `maxTotalAttempts`, variant steps per tier ≤ ladder length | 1.5.1 ✅ / 1.5.2 |
| QA: off-by-one in attempt counting | `advance` | §9 table asserted per action kind | 1.5.2 |
| QA: stale `childSessionID` after a fresh start | `advance`/`applySession`, `recordAttempt` | after an advance with `resume: false`, `childSessionID === null` and the next action is `no-child`; after `recordAttempt(…, {sessionID, lastStepTokens})` resume is possible again; `lastStepTokens` is cleared on every advance | 1.5.2 |
| QA: cost-ceiling bypass through variant steps | `nextAction` | covered by the cost row above, plus a seeded property: whenever `cumulativeCost > first × multiple`, no `retry`/`escalate` is returned | 1.5.2 |
| (design) never emit a variant absent from `variants[]` / `default` | `buildVariantLadder`, `emittable` | `escalate-variants.test.ts` property ✅; `ladder.session.test.ts` property over every emitted `action.variant`; a hand-built `currentVariant: "turbo"` → plain retry without `variant` | 1.5.1 ✅ / 1.5.2 |
| (design) `buildEscalatePolicy` session input | `buildVariantPolicy` | `ladder.session.test.ts`, one case each: v1 / `none` / no catalog → no key; effort-configured tier excluded (still in `effortBump`); configured variant absent from catalog → tier omitted; no variant and no effort → base `default`; cap = `effortBumpMax` (`"high"` → sonnet ladder `low, medium, high`); raw `candidates` honoured; prototype-named tiers are own entries; `maxContextFraction` default 0.6 | 1.5.2 |
| (design) `newLadderState`, scorecard, purity | §6, §10 | five fields initialised, `nextModelContext` from the floor tier when `floorTier` raises the start; `final_tier=fast#xhigh`; frozen policy/state/verdict/actions unchanged (pattern of `ladder.test.ts` 1287) | 1.5.2 |
| (design) owner preset trace | full loop | `ladder.session.test.ts`: tiers `fast = sonnet#low (1)`, `medium = sonnet#medium (5)`, `heavy = opus#xhigh (20)`, catalog of S4, defaults (`maxTotal 4`, multiple 4) → attempts `fast@low, fast#medium, fast#high, fast#xhigh` then `give_up "max total attempts (4) reached"`; with `maxTotalAttempts: 10, costCeiling.multiple: 40` → the escalation skips `medium` (covered) and lands on `heavy` | 1.5.2 |

## Findings

| Id | Severity | Topic | Finding | Resolution |
|---|---|---|---|---|
| F1 | minor (plan text) | `nextAction` order | The plan (§3 1.5.1 and the dispatch) lists "cost ceiling → max total". The code checks max total first (`ladder.ts:141` before `:149`), and both fixtures pin that order: the matrix crosses `totalAttempts > max` with costs above the ceiling and records "max total attempts". | Kept the code order. Both checks are `give_up` and precede every new step, so D10/D11 are unaffected. **Round 1 (QA-1.5-11):** kept again; **plan text amendment requested** (orchestrator): §3 1.5.1 should read "max total → cost ceiling", the order the code and both fixtures pin. |
| F2 | design decision | Bound of catalog ladders | D10 does not name an upper bound. Without one, the live sonnet ladder runs to `max` and the bump knob `effortBumpMax` ("Maximum reasoning effort for a bump", default `xhigh`) would be ignored on v2. | Catalog ladders are capped at the resolved `effortBumpMax`. Explicit `candidates` are not capped. Orchestrator: record as an amendment to D10. **Round 1 (QA-1.5-10):** the cap applies even when `effortBump: false` (`resolveEffortBump` returns `max` regardless of `enabled`), so with the default `xhigh` the live `claude-haiku-4-5` ladder `[high, max]` loses `max` and its only rung is `high`. **CONFIG_REFERENCE handoff to 1.1/3.1:** document that `effortBumpMax` caps v2 catalog variant ladders independently of `effortBump`, and that the default drops `max` (set `effortBumpMax: "max"` or list `max` in `candidates`). |
| F3 | design decision | One effort delivery per tier | A tier with `effort`/`thinking`/`reasoning` and no `variant` would otherwise get both agent-level effort options and a variant. Which one wins on the wire is unverified (A7). | Such tiers keep the proven `effortBump` path even on v2. Variant steps apply to tiers with a valid catalog `variant` or with no effort configuration at all. This is consistent with D10's last sentence. **Round 1 (QA-1.5-8, QA-1.5-6):** such a tier now also gets variant info with an **empty ladder** (its model, input budget and `costRatios`, no steps), so resume decisions into it have a budget while its effort delivery stays on `effortBump`. **D10 amendment requested** (orchestrator): "a tier that configures `effort`/`thinking`/`reasoning` without a `variant` is excluded from variant steps (empty ladder) and keeps the effort bump; a tier with a configured `variant` steps through variants even if it also configures an effort". |
| F4 | design decision | Same-model tiers on escalation | In the owner's `anthropic` preset, `fast` and `medium` are both `claude-sonnet-5-5`. After `fast` has stepped to `xhigh`, escalating to `medium` (`#medium`) would rerun variants that already failed. D10 says the ladder "escalates the **model**". | `skipCoveredTiers` passes over next tiers on the same model whose base is at or below the reached variant. A hop guard bounds duplicate ladders. |
| F5 | major (behavioural consequence, not a defect) | Budget consumed on the first tier | The owner's preset has fast costRatio 1, `maxTotalAttempts: 4` and ceiling ×4. With `variantSteps: auto`, the whole budget goes to `fast@low → medium → high → xhigh` (cost 4, not exceeded), then `give_up`. Today the sequence is `fast, fast, medium` (cost 7 > 4). `costRatio` is per tier, so higher-effort variants of unpriced models (A1) look free. | Handoff to 2.3: record a variant's `candidates[].costRatio` when it is configured. Handoff to 2.4: advisor finding when a tier's variant ladder length ≥ `maxTotalAttempts − 1`. The owner trace is pinned as a test. |
| F6 | minor | `resume` type | The plan writes `resume: boolean`. Making it required would break every existing action literal and fixture. | Optional. It is present on every retry/escalate exactly when `policy.variants` is set. |
| F7 | minor | Extra action fields | `variantStep: true` lets `advance` tell a variant step from a plain retry without the policy. `resumeBasis` carries D11's "numbers are logged". | Kept the action kind `retry`. A runner that ignores `variant` degrades to today's same-variant retry rather than misrouting. |
| F8 | minor | Prompt estimate input | A5 adds the dispatch prompt to the estimate, which the ladder never sees. | `nextAction(state, verdict, policy, session?: { dispatchPromptChars })`. Without the 4th argument the estimate uses the forcing message only which under-counts the dispatch prompt by `dispatchPromptChars / 4` tokens, so the runner must pass it (see Handoffs). **Round 1 (QA-1.5-16), text corrected:** when it is passed, the estimate is conservative on a resume: the child's `lastStepTokens` already contains the dispatch prompt, so adding its `chars / 4` again double-counts it. That can only turn a resume into a fresh start, never the reverse. |
| F9 | open (unverified) | `default` position | The provider default efforts behind position 3.5 are documented behaviour, not observed in 0.P. | Handoff to 3.2: assert the effective effort of a `default` → `high` step. If a provider's default turns out to be above `high`, the step is equal, not lower, so the rule stays safe. |
| F10 | minor | `nextModelContext` semantics | The field is needed only by `resumeDecision`. `nextAction` fills it with the target's budget in a probe state. `advance` stores the budget of the model the next attempt runs on. | As specified (§3, §8). |
| F11 | design decision | Candidates source | 1.1's `resolveCandidates` returns a single default entry for tiers without `candidates`. Passing that would pin every ladder to one variant. | `buildVariantPolicy` reads the raw `tier.candidates`. Documented on `VariantLadderInput.candidates`. |
| R1 | open (host behaviour) | Bare-model resume | When escalating to a `default`-base tier with `resume: true`, the runner sends a bare `provider/model`. 0.P never resumed with a bare model after a variant was set, so it is unknown whether the host stores `default` or keeps the old variant. | Handoff to 2.3: assert it in `routing-ladder-resume.test.ts`. If the old variant persists, the runner starts fresh for that case. |

## Deferred by plan

- Runner wiring (resume or recreate, `model`/`agent` on `native.execute`, catalog validation before the call, fallback to fresh + `effortOverrides`): Phase 2.3.
- `lastStepTokens` source (`session.step.ended` → registry): Phase 2.1. The runner converts it with `stepContextTokens`.
- Config types and validation for `variantSteps`, `candidates`, `routing.sessionReuse`: Phase 1.1. 1.5 consumes them only through `LadderSessionPolicyInput` and the raw `candidates` field.
- Advisor findings (rejected candidate variants, tiers omitted for an invalid variant, F5): Phase 2.4.
- Effective-effort assertions on the wire (A7, F9): Phase 3.2.
- D12 native-agent rungs and D8 `next(k)` for the kernel: Phase 1.4 (`routing\engine\ladders.ts`). They can reuse `buildVariantLadder`/`nextVariant`.

## Handoffs

- **To 1.5.2 (@medium).** Implement §3–§10 in `src\escalate\ladder.ts` exactly as written. Add `test\unit\ladder.session.test.ts` with the 1.5.2 rows of §13. Do not touch `ladder.test.ts` or `__fixtures__`. Run `npx vitest run test/unit/escalate-variants.test.ts test/unit/ladder*.test.ts` and `npm run typecheck`.
- **To 1.1.** `CONFIG_REFERENCE.md` should cover three points:
  - `effortBumpMax` also caps v2 catalog variant ladders (F2);
  - explicit `candidates` override the catalog ladder and are not capped;
  - `variantSteps: "none"` disables D10 **and** D11 (fresh sessions as today);
  - (Round 1, QA-1.5-10) `effortBumpMax` caps catalog ladders even with `effortBump: false`, and the default `xhigh` drops `max` from the live haiku ladder `[high, max]`;
  - (Round 1, QA-1.5-3/4) a same-model tier is skipped on escalation only when the current tier already covered its base **and** it has no variant above the reached one; a covered tier with headroom is entered at the reached variant.
- **To 2.3.** Wire the runner as follows:
  - Build the policy with `buildEscalatePolicy(cfg, { host, variantSteps, maxContextFraction: resolveRouting(cfg, host).sessionReuse.maxContextFraction, catalog })`, where `catalog` is a non-throwing lookup over the host model list.
  - Pass `{ dispatchPromptChars: taskText.length }` to `nextAction`.
  - After each attempt, call `recordAttempt(state, cost, { sessionID: child, lastStepTokens: stepContextTokens(lastStep.tokens) })`.
  - Dispatch with `modelRef(action.model, action.variant)` when `action.model` is set, `agent` when set, and `sessionID` only when `action.resume === true`. Log `action.resumeBasis`.
  - Record a variant's `candidates[].costRatio` when it is configured (F5).
  - **Mandatory (A17, QA-1.5-2): charge `action.costRatio ?? tier.costRatio`** for the attempt the action starts, never the tier's base ratio alone. Variant steps, plain retries and escalations carry the `costRatio` of their rung (`TierVariantInfo.costRatios`: the matching candidate's own ratio, else the tier's, keyed by variant id, `default` for the bare model). The action has no `costRatio` when the rung is unknown or the target tier has no variant info; then the tier's ratio applies. Charging only the tier ratio makes every higher variant of an unpriced model look free (F5).
  - **A15 (QA-1.1-4): take `variantSteps` from `resolveVariantSteps(cfg, host)`, not from the raw field.** It is `"none"` when the config has no `routing` block, so without one `buildEscalatePolicy` gets no variant policy and the ladder is byte-identical to 2.2.0. Pass the resolved value in `LadderSessionPolicyInput.variantSteps`.
  - Pass `warn` in `LadderSessionPolicyInput` (a `routerWarn`-style logger): a throwing catalog lookup is treated as no catalog entry for that model and logged once per lookup (QA-1.5-15).
  - Honour `action.carryVariant` (A17a, Round 2): on an escalation it means the target tier is covered by a rung already tried on its model and is entered at `action.variant`, the first rung above that one (always a member of the target's own ladder), not at its base; `advance` seeds `currentVariant`, the runner only dispatches `modelRef(action.model, action.variant)`. Variant steps and escalations also carry `action.rung`, which `advance` records into `state.triedByModel`; the runner needs no extra bookkeeping.
  - **Mandatory (QA-1.5-20): charge `startCostRatio(policy, state) ?? tier.costRatio` for the first attempt.** The first attempt runs the start tier's base rung, which no action carries, so a candidate ratio on that rung is otherwise never charged. Every later attempt charges `action.costRatio ?? tier.costRatio`.
  - Take the policy's `variants` presence as the switch for the reserve: with `variantSteps: "none"`, v1 or no routing block there is no reserve and no variant fields (A17a, QA-1.5-21).
  - `state.nextModelContext` is telemetry only: `nextAction` never reads it (QA-1.5-14).
  - Verify R1.
  - (QA-1.5-22) Also verify, on a **resumed child**, what happens to agent-level effort options (`effort`/`thinking`/`reasoning` of the tier's agent) when the escalation switches `agent` and/or `model#variant`: that the resumed child receives the target tier's effort options exactly once and does not keep the previous tier's. Until it is verified, resume across an effort-configured tier is the least trusted path.
- **To 2.4.** Add advisor findings from `VariantLadder.rejected` (now also candidates that are unranked or not ranked above everything kept before them), from `VariantLadder.foreign` (candidate rungs on other models, which variant steps never walk, QA-1.5-5), from tiers omitted by `buildVariantPolicy` because their configured variant is absent from the catalog, and from F5. Also (A20, QA-1.5-8): report every tier that sets `variant` together with `effort`/`thinking`/`reasoning` (`TierVariantInfo.effortConfigured` with a non-default `base`): its variant ladder is empty so effort is never delivered twice; suggest `candidates` if the user wants variant steps on it. Report `VariantLadder.foreign` and tiers skipped as covered (`give_up` reason "no higher tier left to try ...").
- **To the orchestrator.** Record F2, F3, F4 and the A9 position (§2) as plan amendments under §1.5 "Amended during implementation". The plan file is outside this phase's write-set. Also record, from round 1: the F1 plan text amendment (max total precedes the cost ceiling), the F3 D10 wording (empty ladder for effort-configured tiers), and the A17 reserve and cost-charging rules as implemented (Round 1 fixes below).
- **To the orchestrator, for the merge of `car/p15` with Phase 1.1 (QA-1.5-13).** `ladder.ts` reads the raw `candidates` through `(tier as { candidates?: unknown }).candidates` because `TierConfig` here has no such field. After the merge:
  - read `tier.candidates` typed from 1.1 and replace the cast;
  - use `hasExplicitCandidates(tier)` (now exported by 1.1) to decide whether `candidates` is explicit, and read the raw array for **membership** (`buildVariantLadder` must never receive `resolveCandidates()` output, whose defaulted single entry would pin the ladder, F11);
  - take **costs** from `resolveCandidates(tierName, cfg)` (its `costRatio` is already completed from the tier), which is the source `rungCostRatios` approximates today from the raw entries plus `tier.costRatio`;
  - the merge may also drop the local `validCostRatio` once 1.1's validation (finite, > 0) is the single source.

## Verdict

**PASS — open findings: 0** (QA round 3, `car/p15` at `d241627`). QA-1.5-1, -17, -18 (major) resolved; round-1 partials QA-1.5-2, -4, -8 closed (`c16e785`, `500fd4a`/A20, `61f8853`); QA-1.5-3, -5, -6, -7, -9…-16, -19, -20, -21 resolved. Binding amendments: A15, A17, A17a, A20, A21.

Accepted minors and handoffs: QA-1.5-23 (minor: `triedByModel` keeps one rung per model, so a later same-model `default`-based tier above a ranked tier can repeat `default` once; unrealistic preset; O9 text overstated); QA-1.5-2 runner side — charge `startCostRatio(policy, state) ?? tier.costRatio` for attempt 1 and `action.costRatio ?? tier.costRatio` afterwards (mandatory in 2.3, A17); QA-1.5-13 merge reconciliation with 1.1 (`tier.candidates`, `hasExplicitCandidates`, costs from `resolveCandidates`); QA-1.5-22 and R1 resume verification in 2.3; F9 effective effort of a `default` → `high` step asserted in 3.2; O10, O11 accepted as documented.

Evidence: 477 tests in 3 files (default pool); typecheck green; golden fixtures and `ladder.test.ts` untouched; both replays byte-identical for v1, `variantSteps: "none"` and no catalog (also with tiers that have catalog variants); `auto` control differs. Owner traces (ratios 1/5/20): anthropic `sonnet#low, sonnet#medium, sonnet#high(medium)` → cost ceiling (no ceiling: + `opus#xhigh(heavy)` → max total 4); hybrid-2 `luna#medium, luna#high, sonnet#xhigh(medium)` → cost ceiling (no ceiling: + `opus#xhigh(heavy)` → max total 4).
