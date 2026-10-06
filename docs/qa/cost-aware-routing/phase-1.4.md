# Phase 1.4 — Decision kernel, protocol line and plan fan-out (M4)

> Plan: `D:\git\opencode-model-router\docs\plans\cost-aware-routing-engine-plan.md` §1.3 M4, §1.4, §1.5 D2, D5, D7, D8, D9, D12, D13, amendments A1, A5, A11, A13–A22, §3 "Phase 1.4".
> Worktree `D:\git\omr-car-p14`, branch `car/p14`, from `car/main` @ `5210cfb` (Phases 1.1, 1.2, 1.3, 1.5 merged). Base directory `D:\git\opencode-model-router`.
> Tasks: 1.4.1 `[tier:heavy]` (this design + `types.ts` + `kernel.ts` + kernel tests) → 1.4.2 `[tier:medium]` (`ladders.ts`, `protocol-line.ts`, `plan.ts`, `index.ts` + their tests, per the spec below).

## Pre-flight

| Item | Result |
|---|---|
| Worktree / branch / base | `D:\git\omr-car-p14` on `car/p14`, tip `5210cfb` (= `car/main`), tree clean before 1.4.1. |
| Dependencies merged | 1.1 (`9b3f2f6`), 1.2 (`0ad5ad9`), 1.3 (`8b0291d`), 1.5 (`fce8866`, reconciled with typed candidates in `9338f64`), QA-1.1-29 pin (`5210cfb`). |
| `npm run typecheck` | green with `types.ts` + `kernel.ts` + the kernel test file. |
| Kernel tests | `npx vitest run test/unit/routing-engine.kernel.test.ts` (default pool, A14): 39 passed. Coverage of `kernel.ts` from that file alone: 100 % lines, 94.6 % branches. |
| D2 baseline on this branch | Re-measured with `loadConfig(<worktree>)` under an empty `HOME`/`USERPROFILE`, `activeMode = normal`: the raw `buildDelegationProtocol` output still hashes to the 0.P.3 values (table below), and `buildTaskTaxonomy` to `5aca1a71…2452`. The v2-adapted hashes are new in this phase (computed with `v2Instructions`, `src\compat\v2-hooks.ts:17`, unchanged since 2.2.0). |

| Preset | Raw protocol SHA-256 (chars) | v2-adapted SHA-256 (chars) | `R:` SHA-256 |
|---|---|---|---|
| `anthropic` | `ee7e33eed9ee3068bc8eb9f2a7492abaed6c428bbf10372bba51f2e92d152af2` (3249) | `aa24cbbf7e558c4f9bd8130fe378a1cdee12e9e9bafef684f57fa4ba9bc59817` (3249) | `5aca1a71c1450dd61deb2a65c411c9ee03e26b835e3704fe4d81df45bee42452` |
| `hybrid-2` | `392ff439845c7c96d3f6728111f50c69e4f46315e79db0c4a252507a402a6d33` (3288) | `10c2437a28b312f6745512fa6ca69867808b1d2efe897e0e6bb3b0235381370b` (3288) | same |

## Implementation notes

### Design (1.4.1)

#### 0. Scope and files

| File | Owner | Status |
|---|---|---|
| `src\routing\engine\types.ts` | 1.4.1 | **final** (types only; every import is `import type`) |
| `src\routing\engine\kernel.ts` | 1.4.1 | **final** (`decide`, `candidateKey`, `coversNeeds`, `giveUpCost`, `GIVE_UP_COST`, `DEFAULT_REMAINING_TURNS`) |
| `test\unit\routing-engine.kernel.test.ts` | 1.4.1 | final |
| `src\routing\engine\ladders.ts` | 1.4.2 | spec §3 |
| `src\routing\engine\protocol-line.ts` | 1.4.2 | spec §4 |
| `src\routing\engine\plan.ts` | 1.4.2 | spec §5 |
| `src\routing\engine\index.ts` | 1.4.2 | spec §6 |
| `test\unit\routing-engine.ladders.test.ts`, `.protocol-line.test.ts`, `.plan.test.ts` | 1.4.2 | spec §7 |

Purity rules for every engine module: no I/O, no clock, no randomness, no module-level mutable state. The kernel imports at runtime only the pure 1.3 modules (`outcomes/beta.ts`, `outcomes/cost.ts`, `outcomes/types.ts`) — never `outcomes/index.ts` (it imports `node:path` and the persister). `ladders.ts`, `protocol-line.ts` and `plan.ts` may import pure functions from `src\router\config.ts` (`resolveCandidates`, `ROUTING_RESERVED_AGENTS`), `src\router\protocol.ts` (`buildTaskTaxonomy`), `src\escalate\ladder.ts` (`buildEscalatePolicy`), `src\escalate\variants.ts` (`variantCovered`), `src\verify\dod.ts` (`parseAcceptanceBlock`) and `src\routing\classify\*`. None of them edits those files (`protocol.ts` belongs to 2.2's seam).

#### 1. Types (`types.ts`, final)

- `Candidate { agent: AgentRef, model, variant, costRatio, rank, tier, source, grants, pricing? }` — `agent.origin` is the 1.3 key origin (`router` for tier agents of the active preset, `host` for everything else); `model` is `provider/model` without `#`; `variant: null` = model default (`default` in keys, A9); `rank` = tier rank, or the inherited rank of the owning tier for role rungs (D7); `tier` = the tier owning the rung; `source ∈ tier | role-own-model | role-tier-rung`; `grants` = needs covered by the agent's **evaluated** permissions (A11), `null` = unknown (covers nothing); `pricing` = catalog `cost` (absent/empty/all-zero = unpriced, A1).
- `Ladder { candidates, next, classRank, excluded }` — `next[k]` is the index of the D8 successor or `null` (give up). `classRank` = rank of `CLASS_STATIC_TIER[class]`, `null` for `other`/off-ladder.
- `HostAgentInfo { id, model?, mode, hidden, permitted, grants }` — supplied by the caller (2.2 from `ctx.agent.list()` + its evaluated permissions; v1 from the config agent map + natives). Never inferred from ids.
- `DecisionInput { facts, chosen, ladder, detection, pin, routing, store, floorRank?, orchestrator?, remainingTurns? }` — `routing: KernelRouting = Pick<ResolvedRouting, "profile" | "margin" | "minClassConfidence" | "detection">`; `store: EngineStoreView = Pick<OutcomeStore, "posterior" | "cost" | "classTokenProfile"> | null`.
- `Decision { chosen, best, switched, pinned, confidence, reasonCode, reason, costs, unit, ineligible, target }` — `chosen`/`best` are 1.3 `RouteChoice`s (so 2.2 writes `DecisionRow` fields directly); `costs: Record<OutcomeKey, number>` finite only; `target` is `best`'s `Candidate` (what an `enforce` swap writes: `agent`, `model#variant`).

#### 2. Kernel (`kernel.ts`, final) — what it computes and why

`decide(input) → Decision`, pure, O(n) store reads, O(n) recursion (n ≤ ~30). Measured median well under 2 ms for 12 candidates with a real `createOutcomeStore` (test "decides 12 candidates in under 2 ms").

1. **Keys.** `candidateKey(cls, c) = makeKey(cls, c.agent, provider, model, variant)` via `splitModelRef` (a `#variant` in the ref is used only when `variant` is null; a ref without `provider/` is stored under `unknown`, never thrown on). The chosen dispatch is a candidate iff its key equals a candidate key.
2. **Class trust (1.2 → 1.4 handoff).** `trusted = facts.confidence ≥ minClassConfidence`. Untrusted ⇒ the store is **not read at all** (no posterior, no cost, no class profile under an untrusted class), the unit is `ratio`, and priors are centred on the chosen rung's rank. Trusted ⇒ priors are centred on `ladder.classRank ?? chosenRank ?? 0`.
3. **`p_k`** = `store.posterior(key, priorForRankOffset(rank_k − referenceRank)).mean` (D7 prior per 1.3 table: −2 → 0.30, −1 → 0.55, 0 → 0.80, +1 → 0.85, +2 → 0.90, ≥ +3 → 0.95); no store ⇒ the prior mean; a non-finite mean ⇒ the prior mean.
4. **Unit (D5, A1).** `compareUnit` over `UnitCandidate { key, priced: !isUnpriced(pricing), measuredUSD, tokenSamples = cost.tokens.n || classTokenProfile.n }`. `usd` additionally requires every `expectedAttemptUSD` finite and ≥ 0 **and** a USD scale (below); otherwise `ratio` for every candidate. Never mixed.
5. **`c_k`**: `costRatio` (ratio) or `expectedAttemptUSD(cost(key), pricing, classProfile)` (usd). A non-finite or non-positive ratio (or a negative USD) makes the rung *unusable*: no cost entry, `ineligible: "invalid-cost"`, and a give-up when it is someone's successor.
6. **`tax_k`**: usd only, and only with `input.orchestrator`: `taxUSD(cost(key).finalMessageTokens, remainingTurns ?? 4, orchestrator.pricing, orchestrator.contextTokens) ?? 0`. Always 0 in ratio units (1.3 recommendation: no USD→ratio exchange rate is invented).
7. **`d`** = `routing.detection[input.detection]` clamped to [0, 1]; non-finite ⇒ 0 (no detection: the conservative side, it pays `U`).
8. **`U`** = `GIVE_UP_COST[profile][risk]` (`frugal {3, 8, 20}`, `balanced {5, 15, 40}`, `safe {10, 30, 100}`) in ratio units. In usd it is multiplied by the **USD value of one ratio unit** = `USD(r*) / costRatio(r*)`, `r*` = the cheapest-ratio candidate (D8 "cost units where fast = 1"). If that scale is not finite and > 0, the decision falls back to ratio.
9. **Recursion (D8).** `C(k) = c_k + tax_k + (1 − p_k)·[d·C(next(k)) + (1 − d)·U]`, `C(terminal) = U`. Memo arrays are allocated inside each call (no leakage across calls; test "memoisation does not leak"). A successor that is out of range, non-integer, unusable, or **on the current recursion path** (cycle) is treated as terminal: no input can produce an infinite escalation (tests: self loop, 2-cycle, random graphs).
10. **Eligibility for `best`** (the chosen rung is always eligible — it is the status quo): `coversNeeds(grants, facts.needs)` (A11); not below `floorRank`; not a lower rank than the chosen rung when `risk == high && detection == none` (D9 never-down). Each ineligible key is reported in `Decision.ineligible`.
11. **`best`** = argmin over the chosen rung (considered first) and the eligible candidates; ties keep the chosen rung, then the earlier rung (strict `<`). Duplicate keys are priced once (first rung).
12. **Switch (D9 + A16)**, first failing check gives `reasonCode`: no priced candidate → `kept:no-candidates`; `pin` → `kept:pinned` (D13; `best` still computed); chosen not a priced candidate → `kept:chosen-not-candidate`; `best` is the chosen rung → `kept:best-is-chosen` (never a switch); `margin ∉ [0, 1)` or non-finite `minClassConfidence` → `kept:invalid-config`; `facts.confidence < minClassConfidence` → `kept:class-confidence`; `!(C(best) < (1 − margin)·C(chosen))` → `kept:margin` (boundary kept); else `switched`.
13. **`Decision.confidence`** = `round2(facts.confidence × n/(n + 5))`, `n` = effective evidence of `best`'s posterior (0 with priors only or an untrusted class). Reported only; D9 gates on `facts.confidence`.

Residuals (accepted design limits, for QA): `next(k)` is a static pointer, so the cascade from `k` is the same whatever led to `k` (memo soundness); A17a coverage across a model that re-appears after another model (A → B → A) is only approximated (see §3 `next`). Candidates the orchestrator cannot dispatch (role agents lacking `needs`) never reach the kernel; router rungs lacking `needs` stay on the cascade but are never `best`.

#### 3. `ladders.ts` (1.4.2 spec)

```ts
export function escalateLadder(cfg: RouterConfig): readonly string[];
export function tierRankOf(cfg: RouterConfig, tier: string | null | undefined): number | null;
export function floorRankOf(cfg: RouterConfig): number | null;
export function grantsFromTools(tools: readonly string[], externalDirectory: boolean): Need[];
export interface LadderBuildInput {
  readonly cfg: RouterConfig;
  readonly routing: Pick<ResolvedRouting, "roles">;
  readonly facts: Pick<TaskFacts, "class" | "needs">;
  /** Router tier agents included. null = unavailable: router grants null, no role candidates. */
  readonly agents: readonly HostAgentInfo[] | null;
  /** Catalog pricing of "provider/model"; must not throw (wrap it); undefined = unpriced (A1). */
  readonly pricing?: (model: string) => ModelPricing;
}
export function buildLadder(input: LadderBuildInput): Ladder;
export interface ChosenInput {
  readonly cfg: RouterConfig;
  readonly agents: readonly HostAgentInfo[] | null;
  readonly agent: string;             // event.input.agent
  readonly model?: string | null;     // event.input.model, when the call set one
  readonly parentModel?: string | null;
}
export function resolveChosen(input: ChosenInput): ChosenDispatch | null;
```

- **`escalateLadder(cfg)`** = `buildEscalatePolicy(cfg).ladder` (`src\escalate\ladder.ts:579`, default `["fast", "medium", "heavy"]`), de-duplicated, filtered to tiers for which `resolveCandidates(tier, cfg)` is non-empty. One source for the kernel's ranks and the runtime ladder. `tierRankOf` = index in it, `null` when absent. `floorRankOf` = `tierRankOf(cfg.enforcement?.escalate?.floorTier)`.
- **`grantsFromTools`** (A11, from the S2-agent-native tool sets): `shell` ← `shell`|`bash`; `network` ← same as shell (network means through a shell command, 1.2 `NEEDS`); `web` ← `webfetch`|`websearch`; `edit` ← `edit`|`write`|`patch`|`apply_patch`; `external_dir` ← the `externalDirectory` flag (host `external_directory` permission evaluated to allow). Output unique, in `NEEDS` order. With the S2 tool lists: `explore` → `["web"]`, `general` → `["shell", "web", "edit", "network"]`.
- **Router rungs** (laid out first, tier order, then rung order): for each tier `t` of `escalateLadder(cfg)` and each `r` of `resolveCandidates(t, cfg)` → `Candidate { agent: {origin: "router", id: t}, model: r.model, variant: r.variant ?? null, costRatio: r.costRatio, rank: tierRankOf(t), tier: t, source: "tier", grants: agents?.find(id === t)?.grants ?? null, pricing: pricing?.(r.model) }`. Never read `tier.candidates` raw (1.1 handoff: a list lacking the tier's own rung is ignored by `resolveCandidates`).
- **`next(k)`** (D8, A17a semantics of 1.5 reduced to a static pointer): walk forward from `k`'s position; skip a rung `r` iff `r.model === k.model`, neither `k.tier` nor `r.tier` is effort-configured (`effort`/`thinking`/`reasoning` set — A20/QA-1.5-18: never covered, never a coverage source), and `variantCovered(r.variant ?? "default", k.variant ?? "default")` (`src\escalate\variants.ts:131`). The first unskipped rung is `next(k)`; none → `null`. Inside a tier this is "next variant of the same model"; at a tier's end it is "the first rung of the next tier" (or the first one not already covered by `k` — e.g. `fast = sonnet#high`, `medium = sonnet#medium` skips medium, as the runtime ladder does). Coverage is relative to `k` only (memo soundness; residual in §2).
- **Role rungs (D12, D7)**, laid out after the router block, one chain per agent, in `routing.roles[class]` order (own-property lookup; `ResolvedRouting.roles` is already de-duplicated; `[]` = none):
  - Owning tier `T = CLASS_STATIC_TIER[class]` (1.2); `rankT = tierRankOf(T)`. `T === null` or `rankT === null` → every role agent of the class is `excluded: "no-owning-tier"`.
  - Skip with `excluded` (one entry per agent, `model` = its configured model or `""`): id names a router tier of the active preset → `duplicate`; id in `ROUTING_RESERVED_AGENTS`, absent from `agents`, `mode === "primary"`, `hidden`, or `!permitted` → `agent-unavailable` (QA-1.1-18/29); `!coversNeeds(info.grants, facts.needs)` → `needs` (A11: e.g. `explore` with `needs: [shell]`).
  - Rung 1 (`role-own-model`), only when `info.model` parses with `splitModelRef`: `{ agent: {origin: "host", id}, model: provider/model, variant, rank: rankT, tier: T, grants: info.grants, pricing }`. Its `costRatio` = the ratio of the first router rung (escalate order) with the same `(model, normalized variant)` — one ratio per pair within a preset (QA-1.1-26) — else the ratio of `T`'s first rung (inherited, never invented; the advisor reports it, §Handoffs). An agent without a model runs on the parent's model (host precedence) and gets no own rung.
  - Then every rung of `resolveCandidates(T)` as `role-tier-rung` (same `costRatio`, `rank: rankT`, the agent's grants); a rung identical to the own rung is dropped (`duplicate`).
  - `next` inside the chain uses the same coverage rule; the chain's last rung points to the first router rung of the tier **after** `T` (coverage-skipped relative to that last rung), `null` when `T` is last. This is what the runtime does after a native agent exhausts its rungs (2.3: escalate with an `agent` switch).
- **Acyclic by construction**: router pointers are strictly forward inside the router block; role pointers are forward inside their own chain or into the router block, which never points back. `classRank = tierRankOf(CLASS_STATIC_TIER[class])`. An unknown preset or a ladder with no resolvable tier yields `{ candidates: [], next: [], … }` → the kernel's `kept:no-candidates`.
- **`resolveChosen`**: `agent` is a router tier → `model ?? ` that tier's own `(model, variant)` (`TierConfig`, the base rung); a host agent → `model ?? info.model ?? parentModel`; `null` when nothing resolves (2.2 then logs a kept row without calling `decide`). A `#variant` suffix is split off. `origin` per `classifyAgentOrigin(agent, router tier ids)` (1.3).

#### 4. `protocol-line.ts` (1.4.2 spec)

```ts
export const MIN_EVIDENCE_TO_MOVE = 5; // = PRIOR_STRENGTH: evidence at least as strong as the prior
export interface TaxonomyInput {
  readonly cfg: RouterConfig;
  readonly routing: ResolvedRouting;
  readonly host: RouterHost;
  readonly store: EngineStoreView | null;
  readonly agents: readonly HostAgentInfo[] | null;
  readonly pricing?: (model: string) => ModelPricing;
}
export function generateTaxonomy(input: TaxonomyInput): string;
```

1. `base = buildTaskTaxonomy(cfg)` (imported from `src\router\protocol.ts`, not re-implemented): the degenerate case is byte-identical **by construction**.
2. Class segments, classes in `TASK_CLASSES` order (1.2), every other key ignored:
   - **v1** (`host === "v1"`, D1 text-only opt-in): only when `routing.applied.rolesSource === "configured"`; destinations = `routing.roles[c]` filtered exactly like §3's role filter minus the needs check (absent from `agents`, reserved, primary, hidden, not permitted → skipped; `agents === null` → none). A class with no destination left is skipped (1.1 handoff: classes may map to `[]`). Segment `c→@a1/@a2`. The store is never read on v1.
   - **v2**: only with a non-null `store`. Skip `other` and classes whose `CLASS_STATIC_TIER` tier is off the ladder. Facts `F_c = { class: c, risk: CLASS_BASE_RISK[c], scope: "single", needs: CLASS_IMPLIED_NEEDS[c], confidence: 1, source: "rules" }`; `chosen` = the static tier's base rung (`resolveChosen` with `agent = tier`); `detection: "none"` (unknown verification ⇒ conservative; D9 never-down then keeps high-risk classes from moving down); `decide({ facts: F_c, chosen, ladder: buildLadder(...), detection: "none", pin: false, routing, store, floorRank: floorRankOf(cfg) })`. Segment `c→@<best.agent>` iff `decision.switched`, `best.agent !== chosen tier` (a variant change inside the same tier never changes the line), and `store.posterior(best.key).n ≥ MIN_EVIDENCE_TO_MOVE`. With priors only the kernel alone can move a class (shipped `anthropic` ratios, `balanced`, `d = none`: `implement` gives `C(fast) ≈ 6.86` vs `C(medium) ≈ 8.44` — kept at `margin: 0.2`, switched at `margin: 0`; with `d = deterministic` (0.95) `design` would go from `heavy` (28) to `fast` (≈ 14.3)), so the evidence gate is what makes "argmin per class" degenerate to the static line for every config.
3. No segment → return `base` unchanged. Otherwise `base === ""` ? `R: by class: <segments joined by " ">` : `${base} | by class: <segments joined by " ">`. Never a trailing space, never a double space.

**D2 tests** (`test\unit\routing-engine.protocol-line.test.ts`):

- *Loading the shipped config*: `loadConfig(<worktree root>)` with `HOME`/`USERPROFILE` set to a fresh empty temp dir in `beforeEach` (the 1.1 home guard follows them; no project override exists in the worktree — assert `findProjectOverride(root) === undefined`), then `{ ...cfg, activePreset }`; assert `cfg.activeMode === "normal"`.
- **D2-raw**: for `anthropic` and `hybrid-2`, `sha256(buildDelegationProtocol(cfg))` and its length equal the Pre-flight table; `sha256(buildTaskTaxonomy(cfg)) === 5aca1a71c1450dd61deb2a65c411c9ee03e26b835e3704fe4d81df45bee42452`.
- **D2-v2**: `const v2 = v2Instructions(buildDelegationProtocol(cfg))` (`src\compat\v2-hooks.ts:17` — the function the v2 system hook applies to every text the router pushes, `v2-hooks.ts:280`): hashes per the table; contains ``subagent(agent="fast"|"medium"|"heavy", prompt="...")`` and `(several subagent calls in one message)`; contains neither `Task(` nor `subagent_type`.
- **D2-degenerate**: for both presets × {store `null`, `createOutcomeStore()` empty} × {v2 with `routing: { roles: {} }`, v2 with the D12 default roles, v1 without `routing`}: `generateTaxonomy(...) === buildTaskTaxonomy(cfg)` (string equality catches any whitespace drift) and its SHA-256 is `5aca1a71…2452`; substituting it into the protocol (`protocol.replace(base, generated)`) leaves both the raw and the v2-adapted hashes unchanged (the 2.2 seam's invariant); the `R:` line of the protocol text (`lines.find(l => l.startsWith("R:"))`) equals `generated`.
- **Evidence moves search to explore**: v2, roles `{ search: ["explore"] }`, agents `explore {model: "anthropic/claude-haiku-4-5", mode: "subagent", hidden: false, permitted: true, grants: ["web"]}` + the three router tiers (full grants); store with 20 `pass` on `search|host:explore|anthropic/claude-haiku-4-5#default` and 20 `fail` on `search|router:fast|…` → `… | by class: search→@explore`; the same store with `roles: {}` → `base`; the same store on v1 → `base` (+ nothing: roles not configured).
- **v1 roles prose**: `roles = { review: ["general"], search: ["explore", "build", "ghost"], implement: [] }`, agents `explore`, `general` (subagent), `build` (primary) → `${base} | by class: search→@explore review→@general` (TASK_CLASSES order, not key order); `hidden: true` on explore drops it; `agents: null` → `base`; v1 default (`rolesSource: "none"`) → `base`.
- **Determinism**: two calls with equal inputs return equal strings; shuffling the `roles` key order does not change the output; the empty-`taskPatterns` config returns `""` without segments and `R: by class: …` with.

#### 5. `plan.ts` (1.4.2 spec)

```ts
export interface PlanStep { readonly id: string; readonly text: string } // first line = the step's task line
export interface AnnotateDeps {
  readonly cfg: RouterConfig;
  readonly routing: ResolvedRouting;
  readonly agents: readonly HostAgentInfo[] | null;
  readonly store: EngineStoreView | null;
  readonly pricing?: (model: string) => ModelPricing;
  /** 1.2 `classifyMany` bound to its deps with `routeLinePositions: "any"` (tooling); called exactly once. */
  readonly classifyMany: (inputs: readonly ClassifyInput[]) => Promise<ClassifyResult[]>;
}
export interface AnnotatedStep {
  readonly id: string;
  readonly tier: string;
  readonly tierSource: "existing" | "engine";
  readonly routeLine: string;
  readonly routeSource: "existing" | "engine";
  readonly facts: TaskFacts;
  readonly detection: Detection;
  readonly pin: boolean;
  readonly decision: Decision | null;
  readonly text: string;            // annotated step text
  readonly dispatchPrompt: string;  // route line FIRST (A22), then the step text without route lines
}
export function detectionOf(stepText: string): Detection;
export function formatRouteLine(facts: TaskFacts, detection: Detection, pin: boolean): string;
export async function annotateSteps(steps: readonly PlanStep[], deps: AnnotateDeps): Promise<AnnotatedStep[]>;
```

- **One batched classification**: `deps.classifyMany(steps.map(s => ({ description: firstNonEmptyLine(s.text).slice(0, 200), prompt: s.text })))` once per call (1.2 chunks to `MAX_BATCH_ITEMS` itself). A rejection (contract says never) → `UNKNOWN_FACTS` for every step; a result missing for index `i` → `UNKNOWN_FACTS`. With `routeLinePositions: "any"`, a `[route …]` already in a step is authoritative (source `plan` when it carries `d=`).
- **`detectionOf`** reuses the verifier's parser: `parseAcceptanceBlock(text)` (`src\verify\dod.ts:107`): `null` → `none`; `checks.length > 0` (testsPass, buildPasses, lintClean, fileExists, schemaMatch, run) → `deterministic`; else `criteria.length > 0` (an LLM grader is scheduled) → `grader`; else `none`. A step whose route line carries `d=` keeps that value (`ClassifyResult.detection`).
- **Existing tags preserved**: the first `[tier:<id>]` (`/\[tier:([A-Za-z0-9_-]+)\]/`) of the step is kept verbatim (`tierSource: "existing"`) and never re-emitted; an existing route line (`parseRouteLine(text, { positions: "any" }).count > 0`) is kept verbatim (`routeSource: "existing"`) and never duplicated — annotating an annotated plan returns byte-identical text (idempotence test).
- **Engine tier** (no tag): `chosen = resolveChosen({ agent: CLASS_STATIC_TIER[facts.class] ?? cfg.defaultTier })`; `decision = decide({ facts, chosen, ladder: buildLadder(...), detection, pin, routing, store, floorRank })`; `tier = decision.switched && posterior(best.key).n ≥ MIN_EVIDENCE_TO_MOVE ? decision.target.tier : chosen tier` (`target.tier` is the owning router tier, also for role rungs, so the tag is always a router tier). Same evidence gate as §4: with an empty store the annotation equals the static mapping.
- **`pin`**: existing tier is `heavy`, or the first line matches `/\bQA\b/` (case-sensitive), or an existing route line has `pin` (§0.10.12, 2.4.4).
- **`formatRouteLine`**: `[route class=<c> risk=<r> scope=<s>[ needs=<a,b>] d=<d>[ pin]]` — fixed field order, `needs` omitted when empty, values from the 1.2 vocabularies only (any other value would be ignored by the parser).
- **Placement**: the route line is inserted as a new line right after the step's first non-empty line, indented with the leading spaces of that line **capped at 3** (route-line.ts ignores lines indented 4+ columns; a tab counts as 4, so tabs are replaced by nothing); a missing `[tier:X]` is appended to the first line as ` [tier:X]`. `dispatchPrompt` = `routeLine + "\n" + text-without-route-lines`, so whenever a step becomes a dispatch prompt the route line is its **first** non-empty line (A22). Fences: `plan.ts` gets steps already split by the caller (2.4 owns plan parsing and must not hand it fenced content as a step).

#### 6. `index.ts` (1.4.2 spec)

Re-exports only: `export type * from "./types"`; `decide`, `candidateKey`, `coversNeeds`, `giveUpCost`, `GIVE_UP_COST`, `DEFAULT_REMAINING_TURNS` from `kernel`; `buildLadder`, `escalateLadder`, `tierRankOf`, `floorRankOf`, `grantsFromTools`, `resolveChosen` from `ladders`; `generateTaxonomy`, `MIN_EVIDENCE_TO_MOVE` from `protocol-line`; `annotateSteps`, `detectionOf`, `formatRouteLine` from `plan`. No logic, no state.

#### 7. Test map (plan §3 Phase 1.4 "Tests" → function → file)

| Plan test | Function | File |
|---|---|---|
| Ladders: single-candidate tiers | `buildLadder` — one rung per tier, `next` = next tier's first rung, last `null` | `routing-engine.ladders.test.ts` |
| Ladders: variants before models | `buildLadder` — `medium.candidates = [medium, high]`: order fast#low → sonnet#medium → sonnet#high → opus#xhigh; covered rung skipped (`fast = sonnet#high`, `medium = sonnet#medium`); effort-configured tiers never skipped | ladders |
| Ladders: roles with native agents, v2 default roles (D12) | `buildLadder` with `DEFAULT_V2_ROLES` — `explore`: own `anthropic/claude-haiku-4-5` first (`role-own-model`, rank of fast, ratio inherited from fast's first rung), then the fast ladder, last rung → medium's first rung; `general`: own model then the medium ladder → heavy | ladders |
| Ladders: `needs: [shell]` excludes explore | `buildLadder` — `excluded: [{ id: explore, why: "needs" }]`; `grantsFromTools` for the S2 tool lists | ladders |
| Ladders: empty ladder after filtering → kept with reason | `buildLadder` (unknown preset / no tier on the escalate ladder) + `decide` → `kept:no-candidates` | ladders (kernel side: kernel test "an empty ladder is kept with a reason") |
| Ladders: cycle impossible (property, random ladders) | `buildLadder` over 500 seeded random presets/roles/agents: every pointer `null` or in range; router pointers strictly increase; following `next` from any `k` ends within `n` steps without repeating | ladders |
| Kernel: pin → kept, `pinned: true`, best computed | `decide` | `routing-engine.kernel.test.ts` "pin → kept…" ✔ |
| Kernel: worked examples `p = (0.6, 0.9, 0.95)`, `U = 100`: `d = 1` → fast (4 / 7.5 / 25); `d = 0.5` → medium (23.25 / 11.25 / 25) | `decide` | kernel "d = 1 → fast", "d = 0.5 → medium" ✔ |
| Kernel: margin exactly at the boundary → kept | `decide` | kernel "exactly at the boundary…" ✔ (+ strict inside, best == chosen, ties) |
| Kernel: risk high + d none never moves down | `decide` | kernel "keeps the chosen rank…", "moving up stays allowed…" ✔ |
| Kernel: unit switches to ratio when one candidate is unpriced | `decide` | kernel "switches to ratio units…", "compares in USD…" ✔ |
| Kernel: tax 0 when unmeasured | `decide` | kernel "tax is 0 until measured…", "tax is always 0 in ratio units" ✔ |
| Kernel: terminal give-up cost | `decide` | kernel "terminal give-up…", cycle/out-of-range successors ✔ |
| Kernel: memoisation does not leak across calls | `decide` | kernel "memoisation does not leak…" ✔ |
| Kernel: < 2 ms for 12 candidates | `decide` | kernel "decides 12 candidates in under 2 ms" ✔ |
| Protocol line: snapshot equality with 0.P.3 (shipped `tiers.json`, empty store) | `generateTaxonomy` + the D2 hashes (raw and v2-adapted) | `routing-engine.protocol-line.test.ts` (§4) |
| Protocol line: strong evidence moves `search` to `explore` when listed in roles | `generateTaxonomy` | protocol-line (§4) |
| Protocol line: deterministic ordering | `generateTaxonomy` | protocol-line (§4) |
| Plan: 20-step plan annotated in one pass | `annotateSteps` — spy `classifyMany` called once with 20 inputs; 20 results in order | `routing-engine.plan.test.ts` |
| Plan: existing `[tier:X]` preserved | `annotateSteps` — tag kept verbatim, not re-emitted; existing route line kept; idempotent on an annotated plan | plan |
| Plan: `[acceptance]` with `testsPass` → `d=deterministic` | `detectionOf` / `annotateSteps` — also `criteria:` only → `grader`, none → `none`; `formatRouteLine` field order; route line first in `dispatchPrompt`; indentation ≤ 3 | plan |

All runs: `npx vitest run test/unit/routing-engine.<name>.test.ts` (default pool; never `--pool=threads`, A14).

#### 8. Design decisions taken here (*Amended during implementation*, for the plan's §1.5 list)

- **E1 → D9.** `best` is the argmin over the chosen rung and the *eligible* candidates (needs, floor, never-down); the chosen rung is always eligible. So `best == chosen` measures agreement under the policy, and `switched ⇔ best ≠ chosen ∧ gates`.
- **E2 → D8.** `tax = 0` in ratio units even when measured (no exchange rate); in USD, `U` is scaled by the USD value of one ratio unit (cheapest-ratio candidate); no scale ⇒ ratio.
- **E3 → D4/D9 (1.2 handoff).** An untrusted class (`confidence < minClassConfidence`) never reads the store; priors centre on the chosen rank.
- **E4 → D12.** A role agent's chain is own model → owning tier's rungs → the router rung after the owning tier; the own-model rung's `costRatio` is the preset's ratio for that `(model, variant)` or, failing that, the owning tier's first rung (inherited, reported by the 2.4 advisor).
- **E5 → D2 / M4.** The generated `R:` line is `buildTaskTaxonomy(cfg)` plus an optional ` | by class: c→@agent …` suffix; a class moves only on `switched` with ≥ 5 effective evidence on `best` (`MIN_EVIDENCE_TO_MOVE`); the same gate applies to `plan.ts` engine tiers.
- **E6 → D8/A17a.** `next(k)` is a static pointer; coverage is relative to `k` only.
- **E7 → Decision.** `Decision.confidence = facts.confidence × n/(n + 5)` of `best`, reported only.

### Implementation (1.4.2)

Implemented exactly per §3–§7 on top of the committed `types.ts` / `kernel.ts` (neither was edited; no spec'd bug fix was needed). Commits on `car/p14`, each `Refs #74`, pushed one by one:

| Commit | Content |
|---|---|
| `feat(routing): add engine candidate ladders` | `ladders.ts` + `routing-engine.ladders.test.ts` (37 tests) |
| `feat(routing): generate the by-class taxonomy line` | `protocol-line.ts` + `routing-engine.protocol-line.test.ts` (30 tests) |
| `feat(routing): annotate plan steps with tier and route lines` | `plan.ts` + `routing-engine.plan.test.ts` (30 tests) |
| `feat(routing): export the engine public surface` | `index.ts` + `routing-engine.index.test.ts` (1 test) |

- **Modules.** `ladders.ts` (`escalateLadder`, `tierRankOf`, `floorRankOf`, `grantsFromTools`, `buildLadder`, `resolveChosen`), `protocol-line.ts` (`generateTaxonomy`, `MIN_EVIDENCE_TO_MOVE`), `plan.ts` (`detectionOf`, `formatRouteLine`, `annotateSteps`), `index.ts` (re-exports only). All pure: no I/O, no clock, no randomness, no module-level state; runtime imports are `router/config`, `router/protocol` (`buildTaskTaxonomy`), `escalate/ladder`, `escalate/variants`, `verify/dod`, `routing/classify/{route-line,types}` and `routing/outcomes/{types,beta}` only. Nothing outside `src/routing/engine/` and the tests was edited (`src/router/protocol.ts`, `src/compat/*`, `src/index.ts` untouched).
- **D2 pinned in tests.** `routing-engine.protocol-line.test.ts` loads the shipped `tiers.json` through `loadConfig(<worktree>)` under an empty `HOME`/`USERPROFILE` (`findProjectOverride(root) === undefined`, `activeMode === "normal"`) and asserts, for `anthropic` and `hybrid-2`: the raw `buildDelegationProtocol` SHA-256 + length (3249 / 3288), the `R:` SHA-256 `5aca1a71…2452`, and the v2-adapted (`v2Instructions`) SHA-256 + length (`aa24cbbf…9817`, `10c2437a…370b`) with `subagent(agent=` present and `Task(` / `subagent_type` absent. The degenerate matrix (2 presets × {no store, empty store} × {v2 `roles: {}`, v2 default roles, v1 without routing}) asserts `generateTaxonomy === buildTaskTaxonomy`, the unchanged hashes after `protocol.replace(base, generated)` and the `R:` line equality. A "priors alone never move a class (margin 0)" test first proves the kernel *does* switch `implement` on priors at `margin: 0` (so the evidence gate, not a kernel coincidence, keeps the line static).
- **Verification.** `npm run typecheck` green before every commit. Scoped run `npx vitest run test/unit/routing-engine.kernel.test.ts test/unit/routing-engine.ladders.test.ts test/unit/routing-engine.protocol-line.test.ts test/unit/routing-engine.plan.test.ts test/unit/routing-engine.index.test.ts test/unit/protocol.test.ts` (default pool, A14): 6 files, 192 tests passed. The property test builds 500 seeded random presets / roles / agent lists and checks range, forward-only router pointers, chain exits only into strictly higher router tiers, and termination of `next` from every rung (and that > 40 of the 500 scenarios actually contain role chains).

#### Design deviations and readings taken (1.4.2)

1. **Extra exports of `ladders.ts`.** `routerTierIds(cfg)` and `roleAgentExclusion(id, info, routerIds)` are exported so `protocol-line.ts` shares the agent-level role filter with `buildLadder`. They are *not* re-exported from `index.ts` (§6 lists the public surface exactly).
2. **v1 role filter (§4).** Read literally as "§3's agent-level filter minus the needs check": a role naming a router tier of the preset (`duplicate`), a reserved id, an id absent from `agents`, a `primary`, `hidden` or not-permitted agent is skipped. The class-level `no-owning-tier` rule is *not* applied on v1 (the parenthetical in §4 does not list it), so a configured role for `other` is rendered as text.
3. **`agents === null` (§3).** No role candidates, as specified; each configured role agent of the class is additionally recorded in `Ladder.excluded` as `agent-unavailable` ("absent from `agents`").
4. **Excluded entries.** `model`/`variant` of an entry are the agent's configured model split with `splitModelRef` (`""` / `null` when absent or unparsable). A tier rung dropped as identical to the own-model rung adds one `duplicate` entry for that agent.
5. **Task line (§5).** The "first line" of a step is the first non-empty line that is *not itself a route line*. It is used for the classifier `description`, for appending ` [tier:X]`, for the route-line insertion point and for the `\bQA\b` pin test. With a literal first non-empty line a step whose first line is an existing `[route …]` would have had ` [tier:X]` appended to it, which breaks the route-line syntax.
6. **Tier fallback (§5).** When the class's static tier (or `cfg.defaultTier` for `other`) is not a tier of the active preset, the engine tier falls back to `cfg.defaultTier` if that one exists in the preset — never tag a tier that does not exist. With the shipped presets this branch is dead.
7. **`decision` also for existing tags.** The kernel is run for steps that already carry `[tier:X]` too (chosen = that tier), so a `[tier:heavy]` step reports `kept:pinned`; `decision` is `null` only when `resolveChosen` cannot resolve the pick (e.g. a tag naming an unknown tier). The tag itself is never changed.
8. **Evidence gate uses `best`'s evidence (§4/§5).** If the kernel's argmin is a cheaper rung with no data (e.g. `fast` on priors) while the evidence favours another rung, the tier stays static (test "the argmin must itself carry evidence").
9. **Placement edge cases (§5).** Indent = leading *spaces* of the task line capped at 3 (a tab contributes nothing). The inserted line uses the terminator that follows the task line, else the first terminator of the text, else `\n`; `dispatchPrompt` always joins with `\n`. A step with no non-empty line is returned unchanged (its `dispatchPrompt` still starts with the route line). With several (conflicting) existing route lines the first is the step's `routeLine`; the text is never touched.
10. **`MIN_EVIDENCE_TO_MOVE`** is defined as `PRIOR_STRENGTH` (= 5) from `outcomes/beta` instead of a literal; a test pins `=== 5`.
11. **`grantsFromTools`** compares tool ids case-insensitively (harmless widening).
12. **`pricing`** is called once per rung per `buildLadder` call without a `try`/`catch`, as specified ("must not throw (wrap it)"): the 2.2 caller owns the wrapper.
13. **Extra test file** `routing-engine.index.test.ts` (not in §7) pins the exact exported name set of `index.ts` and its identity with the module exports.

For QA-1.4: the plan file's §1.5 list should still receive E1–E7 (orchestrator, see Handoffs); items 1–13 above are the only places 1.4.2 interpreted the design.

### Round 1 fixes (QA-1.4)

Binding amendments in `car/main`: **A24** (evidence gate), **A25** (runner-simulated pricing, own-model rank, parent-model rung). One commit per finding group, all `Refs #74`, pushed.

| # | Sev | Finding | Fix | Commit | Pinned by |
|---|---|---|---|---|---|
| QA-1.4-1 | critical | A role agent on the fast tier's model inherited the owning tier's rank, so a cheap fast-ranked rung looked like a same-rank candidate and switched on priors (also defeated `floorTier` and never-down) | Own-model rung takes price **and** rank from the matching preset rung: `min(owningRank, matched.rank)` (its `tier` follows the rank); the inherited rank applies only without a match (A25) | `2b1996a` | ladders: "QA-1.4-1" (rank rule, probe risk high / d none / empty store → not switched and `never-down`, floor tier → `floor`, priors alone → `kept:evidence`) |
| QA-1.4-2 | major | Router rungs were priced through a fixed `next(k)` chain that ignored retries, `maxTotalAttempts`, the cost ceiling, variant steps and covered-tier skips | `buildLadder` builds `buildEscalatePolicy(cfg, session)` and replays `newLadderState`/`recordAttempt`/`nextAction`/`advance` from every router rung (`simulate.ts`); `Ladder.paths` holds the attempts, `Ladder.reachable` the rungs only the runner reaches (variant steps), the kernel prices the path; other-model `candidates` rungs are dropped (`excluded: not-modelled`); `LadderBuildInput.session` carries the runner's session input | `3e549c8` | ladders: shipped config (1/5/20, ceiling 4 → fast, fast retry, medium, give up), A→B→A probe (heavy not modelled), covered-tier skip, effort-configured tiers, floor lift, `maxTotalAttempts` / ceiling, no-session behaviour, 500-seed property over random policies and catalogs; kernel: path valuation, reachable rungs, truncation |
| QA-1.4-3 | major | Router tier rungs ignored `permitted`, `hidden`, `mode` | A tier agent that is `primary`, hidden or not permitted is excluded (`agent-unavailable`), never best; its rung still prices own-model matches and may sit on a simulated path | `2b1996a` | ladders: "QA-1.4-3" (3 variants, absent tier stays) |
| QA-1.4-4 | major | A role agent without a configured model got no rung, so `chosen` on the parent's model was `kept:chosen-not-candidate` | `LadderBuildInput.parentModel`: such an agent gets an own-model rung on it (price/rank per QA-1.4-1); `resolveChosen` already used the same precedence | `2b1996a` | ladders: "QA-1.4-4" (chosen `general` on opus#xhigh resolves to a candidate) |
| QA-1.4-5 | major | The `R:` line moved under `static`/`shadow` | `generateTaxonomy` returns `buildTaskTaxonomy` unless the resolved engine is `advise`/`enforce`; v1 keeps its explicit-roles opt-in (D1) | `af930a9` | protocol-line: engine matrix, D2 matrix now also runs `enforce` |
| QA-1.4-6 | major | Priors alone could move a dispatch down | Kernel evidence gate (A24): a switch to a rung that is cheaper to attempt or lower ranked needs ≥ 5 effective outcomes on its own key, else `kept:evidence`; switches up are ungated; `hasMinEvidence` forgives only float jitter (1e-6) | `6c55313` | kernel: "A24 evidence gate" (empty store → `kept:evidence`, 5 outcomes → `switched`, 4 → kept, up ungated, lower rank counts as down, margin first) |
| QA-1.4-7 | major | A `[tier:heavy]` / QA step with an existing route line lacking `pin` stayed unpinned | ` pin` appended to that line (`pin=false` → `pin`), nothing else touched, reported as `routeEdited` / `changed` | `dfcaf81` | plan: "QA-1.4-7 / QA-1.4-8" |
| QA-1.4-8 | major | An untagged QA step kept its class tier | QA step ⇒ `heavy` (else the default tier) + pin; an explicit tag still wins; never moves on evidence | `dfcaf81` | plan: same describe |
| QA-1.4-9 | major | Tags, route lines and the task line ignored fences; annotation was not idempotent | `fenceMask` from the route-line module: nothing inside a fence is a tag, route line, fence-marker task line or description; a step that ends on `heavy` is pinned so re-annotation changes nothing | `dfcaf81` | plan: "QA-1.4-9" (fence cases, 12-step corpus annotated 3× byte-identical) |
| QA-1.4-10 | minor | A throwing `pricing` callback broke the decision | Wrapped: failure ⇒ unpriced (A1), logged through the injected `logger` when present, otherwise silent; a throwing logger is swallowed (no empty catch) | `2b1996a` | ladders: "QA-1.4-10" |
| QA-1.4-11 | minor | `protocol.replace(base, line)` expands `$` in agent ids; a bare `R:` base produced `R: \| by class:` | `base === "R:"` ⇒ `R: by class: …`; handoff + tests use a function replacer; insert the line when the base is empty | `af930a9` | protocol-line: "QA-1.4-11" |
| QA-1.4-12 | nit | Recursive cascade | Iterative cascade (explicit stack) | `3e549c8` | kernel: 20 000-rung chain and a 20 000-attempt path |
| QA-1.4-13 | nit | `\bQA\b` pinned any mention of QA | A QA step starts with the `QA` word (after list/heading/emphasis markers) or names a QA activity (`QA review/round/pass/sign-off/gate/cycle/phase`); case-sensitive; false positives force heavy, false negatives only leave the normal choice | `dfcaf81` | plan: "QA-1.4-13" |
| QA-1.4-14 | nit | USD scaling, grants and line endings undocumented | Kernel header documents the USD anchor caveat (`3e549c8`); `grantsFromTools` handoff: pass only unconditionally allowed tools; `dispatchPrompt` keeps the step's own line ending (`dfcaf81`) | `3e549c8`, `dfcaf81` | plan: CRLF test |

**Re-checked worked examples** (`p = (0.6, 0.9, 0.95)` for fast / medium / heavy, `U = 100` = safe/high, tiers 1 / 5 / 20; `ladders.test.ts` "A25 worked examples", `kernel.test.ts` "A25 simulated runner paths"):

| Policy | d | C(fast) | C(medium) | C(heavy) | best |
|---|---|---|---|---|---|
| plain cascade (`maxAttemptsPerTier: 0`, `costCeiling.multiple: 1000`) — the plan's setup | 1 | 4 | 7.5 | 25 | fast (switches, 10 outcomes on its key) |
| same | 0.5 | 23.25 | 11.25 | 25 | medium |
| shipped (`maxAttemptsPerTier: 1`, ceiling 4×): paths f,f,m · m,m,h · h,h | 1 | 3.8 | 5.75 | 21.25 | fast |
| same | 0.5 | 25.8 | 10.5625 | 23.125 | medium |

The plan's numbers still hold exactly under a policy that allows the plain fast → medium → heavy cascade; the shipped policy prices the retries and stops fast's cascade after medium (cost ceiling), so heavy is not on fast's path.

**Speed** (`performance.now()`, median of 500 runs, 12 router rungs = 3 tiers × 4 variants, v2 catalog session, real `createOutcomeStore`): `decide` p50 0.056 ms (p95 0.075 ms); `buildLadder` with session p50 0.103 ms (p95 0.221 ms), without session p50 0.046 ms. The tests assert < 2 ms.

**Design changes that supersede §2/§3 text above:** (a) router rungs are priced through `Ladder.paths`/`reachable` (their `next` is `null`); role chains still use `next`, and a chain that exits into the router block continues with that rung's path as a fresh dispatch (the chain's runner state is not carried over); (b) router tier rungs of unavailable agents and other-model `candidates` rungs are `excluded`; (c) deviation 5 now also skips fenced lines, deviation 8's "cheaper rung with no data" is refused by the kernel for down switches (`kept:evidence`) and by the plan/`R:` gate for up switches; (d) a plan step that ends on `heavy` is pinned.

**Handoffs added by round 1 (to 2.2 / 2.3 / 2.4):**
- 2.2 passes the runner's own session input as `session` (and `parentModel`, `pricing`, `logger`) to `buildLadder` / `generateTaxonomy` / `annotateSteps`; without `session` the simulated runner has no variant steps (v1, no catalog) exactly like the real one.
- 2.2 substitutes the generated `R:` line with a function replacer (`protocol.replace(base, () => line)`) and inserts it when `buildTaskTaxonomy(cfg)` is empty and the line is not.
- 2.2 calls `grantsFromTools` only with tools whose evaluated permission is an unconditional `allow` (`ask`, `deny` and pattern-limited permissions grant nothing).
- 2.3: the simulation assumes a plain retry re-runs the rung it just ran, a non-base dispatch behaves like a delegation that already stepped to that variant, and a floor tier lifts the first attempt; keep the runner that way or update `simulate.ts`.
- 2.4: `annotateSteps` returns `routeEdited` / `changed`; show an edited route line (` pin` added) to the user.

## Findings

QA-1.4 round 1 (heavy): 1 critical, 8 major, 2 minor, 3 nit — all fixed above (see "Round 1 fixes"); none open. Round 2 pending.
## Deferred by plan

- The `protocol.ts` seam that swaps in the generated `R:` line, the hint text and the decision-log rows → Phase 2.2 (`src\router\protocol.ts` is 2.2's).
- Building `HostAgentInfo` (agent list, evaluated permissions → `grantsFromTools`) and the catalog pricing lookup at dispatch time → Phase 2.2.
- `/annotate-plan` rendering and plan splitting (fences, nested code blocks) → Phase 2.4.

## Handoffs

- **to 1.4.2 (@medium)** — implement §3–§6 exactly; tests per §7; do not change `types.ts`/`kernel.ts` without a heavy design dispatch (a needed change goes back as a finding). Import only pure modules (§0).
- **to 2.2** — per `subagent` call: `classify` → `resolveChosen` → `buildLadder` → `decide({ …, store: bundle.store, floorRank: floorRankOf(cfg), detection: result.detection ?? detectionOf(prompt), pin: result.pin })`; `enforce` writes `decision.target.agent.id` and `modelRef(target.model, target.variant)` only when `decision.switched`; the row's `chosen`/`best`/`costs`/`unit`/`confidence`/`reason`/`pinned`/`switched` come straight from the `Decision` (`reasonCode` is useful in `reason`). Supply `HostAgentInfo` for router tier agents too (otherwise their `grants` are `null` and they can never be `best` for a task with needs). The `R:` swap must keep the D2 invariant tested in §4 (`generateTaxonomy === buildTaskTaxonomy` with no evidence; raw and v2-adapted hashes unchanged).
- **to 2.4** — advisor finding: a role agent whose own model has no `(model, variant)` rung in the preset is priced at the owning tier's first-rung ratio (E4); report it with a `candidates` suggestion. `/annotate-plan` uses `annotateSteps` and must keep `[route …]` out of fenced blocks.
- **to the orchestrator** — record E1–E7 under §1.5 "Amended during implementation" (the plan file is outside this write-set).
- **to QA-1.4 round 2** — focus: the simulated paths against `nextAction` (every router rung, with and without a catalog), the A24 gate on up/down classification, evidence of reachable rungs, plan idempotence on fenced/CRLF input; round 1 asked for: infinite escalation (kernel cycle guard, ladder acyclicity), unit mixing (any path that returns `usd` with a null estimate), `generateTaxonomy` whitespace vs `buildTaskTaxonomy`, never-down on high risk, store reads under an untrusted class.

## Verdict

1.4.1 and 1.4.2 implemented; QA-1.4 round 1 fixed (14 findings, none open); pending round 2.
