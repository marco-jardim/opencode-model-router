# Phase 1.3 — Outcome store and cost accounting (M3)

> Worktree `D:\git\omr-car-p13` (branch `car/p13`, from `car/main` @ `3b3dba4`). Base directory `D:\git\opencode-model-router`.
> Plan: `D:\git\opencode-model-router\docs\plans\cost-aware-routing-engine-plan.md` §0.11 "What is measured", §1.3 M3, §1.4 `routing.outcomes`, §1.5 D4–D8, D15, D18, amendments A1, A3, A9, A10, §3 Phase 1.3.
> Task 1.3.1 `[tier:heavy]` deliverables: `D:\git\opencode-model-router\src\routing\outcomes\types.ts` (final) and the design below. Tasks 1.3.2–1.3.3 `[tier:medium]` implement it without further decisions.

## Pre-flight

| Item | Result |
|---|---|
| Worktree / branch | `D:\git\omr-car-p13` on `car/p13`, tracking `origin/car/p13`, clean at `3b3dba4` before 1.3.1 |
| Standard §0.9 items (full suite, orphan processes, `router_verify`) | Orchestrator pre-flight; not repeated by 1.3.1 (the dispatch forbids a full-suite run) |
| `node --version` | `v24.21.0`: type stripping is on by default, and `module.registerHooks` exists |
| `tsx`, `vite-node`, `esbuild`, `bun`, `ts-node` in `node_modules\.bin` | none. Only `tsc` (TypeScript `^7.0.2`) and `vitest` (`^5.0.3`) are present, which matches 0.P ("`tsx` not installed") |
| Build step | none (`package.json` scripts: test, smoke*, `typecheck = tsc --noEmit`) |
| `tsconfig.json` | `moduleResolution: "Bundler"`, `noEmit: true`, no `allowImportingTsExtensions`, no `verbatimModuleSyntax`; `include` = `src/**/*.ts`, `test/**/*.ts`, `vitest.config.ts`, so **`scripts/` is not typechecked**. `tsconfig.json` is outside 1.3's write-set (§2) |
| Import style in `src/` | extensionless relative imports (e.g. `src\telemetry\trajectory.ts:5` `from "../router/idle-sweep"`) |
| Scorecard directory (0.P.2) | `C:\Users\Marquinho\AppData\Local\Temp\opencode-model-router-trajectory` = `join(tmpdir(), "opencode-model-router-trajectory")`. Writer: `D:\git\opencode-model-router\src\index.ts:1710–1721` (sync `mkdirSync` + `writeFileSync(..., { flag: "a" })` of `${sid}.scorecard.log` on `session.idle`; the debug dump at ≈1727 also writes there) |
| S3 event shape | `data: { sessionID, assistantMessageID, finish, rawFinish, cost: <number>, tokens: { input, output, reasoning, cache: { read, write } } }`. The event carries **no model id**, so ingestion attributes a step to the key registered for the child |
| Catalog cost shape | `Model.Cost = { tier?: { type: "context", size: Int }, input, output, cache: { read, write } }` (USD per million tokens), from `node_modules\@opencode\schema\dist\model.js:72`. The user-config form allows one object or an array, with optional `cache` fields (`@opencode\client` generated types ≈3099) |
| Verifier outcome | `src\verify\types.ts:14` `outcome?: "pass" \| "fail" \| "unverifiable"`. Every call site derives it with `verdict.outcome ?? (verdict.pass ? "pass" : "fail")` (`src\verify\gate.ts:82`, `wiring.ts:203`, …) |
| Probe 1: no-`tsx` runner | A throwaway project (`"type": "module"`) with `scripts/cli.ts` that calls `registerHooks({ resolve })` and then `await import("../src/lib/index")` (extensionless, with an `import type` inside) printed `42`, exit 0, with and without `--experimental-strip-types`. No warning on stderr |
| Probe 2: strip-types failure mode | The same probe with `import { Row, K } from "./types"` (`Row` is an interface) fails at link time (`SyntaxError … does not provide an export named 'Row'`). So `import type` is **mandatory** for type-only symbols in every module the script reaches |
| Probe 3: `types.ts` under Node | `node` imported `D:\git\omr-car-p13\src\routing\outcomes\types.ts` directly. `makeKey`/`parseKey` round-tripped router and host keys, escaped delimiters and empty parts. `splitModelRef`, `classifyAgentOrigin` and `verdictOf` behaved as specified |
| `npm run typecheck` after `types.ts` | exit 0 |

## Implementation notes

### Design (1.3.1)

#### 0. Module map and purity rules

| File (under `D:\git\opencode-model-router\src\routing\outcomes\`) | Task | Runtime imports allowed | I/O |
|---|---|---|---|
| `types.ts` (done) | 1.3.1 | none (`import type` from `..\..\verify\types` only) | none |
| `beta.ts` | 1.3.2 | `./types` | none |
| `cost.ts` | 1.3.2 | `./types` | none |
| `store.ts` | 1.3.2 | `./types`, `./beta`, `./cost` | none (the clock is injected; `Date.now` is only the default) |
| `persist.ts` | 1.3.2 | `./types`, `./store` (`parseSnapshot`), `node:fs/promises`, `node:path` | **the only module that touches disk**, always through the injected `PersistFs` |
| `index.ts` | 1.3.2 | all of the above, `node:path` | none directly (re-exports plus the A3 registry) |
| `stats.ts` | 1.3.3 | `./types`, `./store` | none (`runStatsCli` gets all I/O through `StatsCliIO`) |
| `D:\git\opencode-model-router\scripts\routing-stats.ts` | 1.3.3 | `node:module`, `node:os`, dynamic `../src/routing/outcomes/index` | process stdout/stderr |

Rules that let Node type stripping run the script (§8). They bind every file in the table:
1. Type-only symbols use `import type { … }` and `export type { … } from` (this includes the `index.ts` re-exports).
2. No `enum`, no `namespace` with values, no constructor parameter properties, no `import x = require()`, no angle-bracket casts (use `as`), no JSON imports.
3. Runtime imports stay inside `src\routing\outcomes\` plus `node:` builtins. In particular, nothing here imports `src\router\config.ts` or `src\routing\classify\*` at runtime (`import type` is allowed). That keeps the script's runtime graph small and free of 1.1/1.2 (both in flight).
4. Relative imports stay extensionless, matching the repo convention. The script's resolve hook adds `.ts`.
The stats spawn test (§9) enforces rules 1–3: a violation fails the script at link time.

#### 1. Outcome keys (`types.ts`, final)

`makeKey(cls, agent: AgentRef, provider, model, variant?)` returns `${class}|${origin}:${agentId}|${provider}/${model}#${variant ?? "default"}`.

- **Native and router agents with the same id do not collide.** The agent segment is **origin-qualified**: `router:<id>` for a router tier agent of the active preset, and `host:<id>` for every other agent (native `explore`/`general`, or user-defined). `classifyAgentOrigin(agentId, routerAgentIds)` returns `router` iff the id names a router tier of the active preset (the tier set from `getActiveTiers(cfg)`; 2.1/2.2 pass it), else `host`. Examples:
  - `search|host:explore|anthropic/claude-haiku-4-5#default` is the native `explore` running its own configured model.
  - `search|router:explore|anthropic/claude-haiku-4-5#default` is a router tier that a user named `explore`.
  - These are two keys with independent evidence, because the system prompt and permissions differ even when the model is the same.
  - The same tier name in two presets with the same model shares evidence on purpose (same prompt, same model). A different model is a different key anyway.
- **Unambiguous parsing.** Delimiters inside a part are percent-escaped (`%`→`%25`, `|`→`%7C`, `#`→`%23`, `:`→`%3A`, `/`→`%2F`):
  - Class, agent id, provider and variant escape all five characters.
  - The model escapes only `%|#`, so ids like `anthropic/claude:beta` stay readable.
  - `parseKey` splits on `|` (exactly 3 parts), the agent segment at its first `:`, the model segment at its **last** `#` and then at its **first** `/`. Any unknown `%xx`, an unknown origin or an empty part makes it return `null`.
  - Property: `parseKey(makeKey(p))` equals `p` for every normalized `p`.
- **Normalisation (never throws on the hot path).** An absent, `null` or `""` variant becomes `default` (A9). An empty class becomes `other`. An empty agent id, provider or model becomes `unknown`. Values are otherwise verbatim: no case folding, no trimming, because catalog ids are case-sensitive.
- `splitModelRef("provider/model[#variant]")` splits at the first `/` and the last `#`. 2.1/2.2 use it to build keys from `event.input.model` and catalog refs.
- `Verdict` is the literal union. The type `VerdictMatchesVerifier` breaks typecheck if `src\verify\types.ts:14` drifts. `verdictOf(v)` reproduces the repo's existing derivation.

#### 2. `beta.ts`: posteriors (D4, D7, decay, cap)

Stored state per key: `BetaState { alpha, beta, updatedAt }`. These are **evidence pseudo-counts with the prior excluded**, expressed at instant `updatedAt` (epoch ms). The D7 prior is added on read, so a rank change in config never rewrites evidence, and old evidence decays toward the prior, not toward `Beta(0, 0)`.

Exports and exact algorithms:
- `PRIOR_STRENGTH = 5`, `MIN_TINY = 1e-12`, `DAY_MS = 86_400_000`.
- `priorForRankOffset(offset): BetaPrior` (D7):
  - `o = Number.isFinite(offset) ? Math.round(offset) : 0`.
  - `centi = o >= 0 ? Math.min(95, 80 + 5 * o) : Math.max(30, 80 + 25 * o)`.
  - Result: `{ alpha: centi / 20, beta: 5 - centi / 20 }`. Integer hundredths keep every value exact in binary.

  | offset | ≤ −2 | −1 | 0 | +1 | +2 | ≥ +3 |
  |---|---|---|---|---|---|---|
  | mean | 0.30 (floor) | 0.55 | 0.80 | 0.85 | 0.90 | 0.95 (cap) |
  | (α, β) | (1.5, 3.5) | (2.75, 2.25) | (4, 1) | (4.25, 0.75) | (4.5, 0.5) | (4.75, 0.25) |

  Sign convention: `offset = rank(candidate) − rank(static tier of the class)`, and rank grows with capability. 1.4 computes ranks, including the D7 rule that native and user agents inherit the rank of the role they are listed under.
- `SAME_RANK_PRIOR = priorForRankOffset(0)`, i.e. `Beta(4, 1)`.
- `sanitizeTuning(t)`: `halfLifeDays` is clamped to [1, 365] (non-finite → 14); `maxEffectiveSamples` is `Math.round`ed and clamped to [5, 1000] (non-finite → 50). This is defensive; 1.1 validates the same ranges.
- `decayFactor(dtMs, halfLifeDays)`: `dt = Number.isFinite(dtMs) && dtMs > 0 ? dtMs : 0`, then `2 ** (−dt / (halfLifeDays · DAY_MS))` ∈ [0, 1].
  - **A clock going backwards (or a NaN clock) gives dt = 0, so the factor is 1 and counts never inflate.**
- `decayTo(state, now, tuning)`: pure.
  - `t = Number.isFinite(now) ? now : state.updatedAt`.
  - `f = decayFactor(t − state.updatedAt)`, `a = alpha·f`, `b = beta·f`.
  - If `a + b < MIN_TINY` then `a = b = 0`. This flushes tiny counts, so subnormals never reach storage.
  - `updatedAt = Math.max(state.updatedAt, t)`. It never moves backwards, so a later forward read never double-decays.
  - Decay is multiplicative, so materialising at t1 and then t2 equals materialising at t2 directly: no drift.
- `capEvidence(state, M)`: `n = alpha + beta`. If `n > M`, scale both by `M / n`. The evidence mean `alpha / (alpha + beta)` is preserved to rounding (≤ 1e-15).
- `observe(state | undefined, success, now, tuning)`:
  1. `base = state ?? { alpha: 0, beta: 0, updatedAt: now }`.
  2. `decayTo(base, now)`.
  3. Add +1 to `alpha` (success) or `beta` (failure).
  4. `capEvidence(…, M)`.
- `posteriorOf(state | undefined, prior, now, tuning): Posterior`:
  1. A prior with a non-finite or ≤ 0 side becomes `SAME_RANK_PRIOR`.
  2. `e = state ? capEvidence(decayTo(state, now), M) : zero`. This is a read only; it never writes back.
  3. Return `alpha = prior.alpha + e.alpha`, `beta = prior.beta + e.beta`, `mean = alpha / (alpha + beta)`, `n = e.alpha + e.beta`.
- `mergeBeta(a, b, now, tuning)`: decay both to `now`, sum them, set `updatedAt = max(a.updatedAt, b.updatedAt, now)`, then cap.
- Numeric stability:
  - Evidence stays ≤ M + 1 ≤ 1001 between cap applications, so nothing overflows.
  - Each prior side is ≥ 0.25 and the strength is 5, so the posterior is always proper and the denominator is ≥ 5.
  - A huge dt underflows the factor to 0, which leaves evidence 0 and posterior = prior.
  - There are no exp/log of large arguments.
  - Loaded values are validated finite and ≥ 0 (`store.parseSnapshot`).

#### 3. `cost.ts`: cost statistics, D5, D6 + A1, A10

- `normalizePricing(p: ModelPricing): ModelPriceEntry[]` turns `null`/`undefined` into `[]`, one object into `[obj]`, and copies arrays. It keeps an entry only if `input` and `output` are finite and ≥ 0, `cache.read`/`cache.write` (default 0) are finite and ≥ 0, and `tier` is absent or `{ type: "context", size }` with finite `size > 0`.
- `isUnpriced(p)` (**A1**): `normalizePricing(p)` is empty, **or** every entry (all tiers) has `input`, `output`, `cache.read` and `cache.write` all equal to 0. A model absent from the catalog (`undefined`) is unpriced.
- `pricingState(p)` returns `"unpriced"` or `"priced"`.
- `stepUSD(rawCost, pricing)` (**D6 + A1**):
  - A non-number, non-finite or negative raw cost returns `null` (invalid measurement).
  - `rawCost === 0 && pricing === "unpriced"` returns `null`.
  - Anything else returns `rawCost`. A priced model's 0 (zero-token step) stays 0. An unpriced model with `cost > 0` is a host measurement, not a default, and is kept.
  - **Tokens are always kept** (A1).
- `tokenSampleFromEvent(t: StepEndedTokens): TokenSample` flattens `cache.read`/`cache.write`. A non-finite or negative field becomes 0.
- `addTokens(a, b)` sums field by field.
- `selectPriceEntry(p, inputTokens)` (**A10**):
  1. `entries = normalizePricing(p)`; if it is empty, return `null`.
  2. If `inputTokens` is non-finite, treat it as 0.
  3. `tiered` = entries with `tier`, sorted by `size` ascending (stable). `base` = entries without `tier`.
  4. Return the tiered entry with the **largest** `size` such that `inputTokens > size` (strictly over the tier, models.dev "context over N" semantics).
  5. Otherwise return `base[0]`.
  6. Otherwise (input below every tier and no base entry) return `tiered[0]`, the closest published price.
- `priceTokens(entry, t)` = `(t.input·input + (t.output + t.reasoning)·output + t.cacheRead·cache.read + t.cacheWrite·cache.write) / 1e6`. Reasoning is billed at the output price.
- `updateMean(stat, x, M)`: `n1 = stat.n + 1`, `w = 1 / Math.min(n1, M)`, `mean = stat.mean + (x − stat.mean)·w`, giving `{ mean, n: n1 }`. This is an exact arithmetic mean while `n1 ≤ M`, then an EWMA (bounded memory, follows price/behaviour drift). Cost stats are **not** time-decayed; only Beta evidence is. `updateTokenMeans` applies the same rule per field with a shared `n`.
- `emptyCostStats()` returns every `MeanStat`/`TokenMeans` with `{ mean: 0, n: 0 }` and `unpricedAttempts: 0`.
- `foldAttempt(stats, attempt: OpenAttempt, M)`:
  - `steps ← updateMean(attempt.steps)` and `tokens ← updateTokenMeans(attempt.tokens)`. Every attempt counts here, unpriced ones included.
  - If `attempt.usdKnown && attempt.steps > 0`, update `measuredUSD` with `attempt.usd`; otherwise `unpricedAttempts + 1`. Null samples never enter the mean.
  - If `attempt.finalOutput !== null`, update `finalMessageTokens`. This keeps it separate from the step-token sums.
- `mergeCostStats(a, b)`: n-weighted means (`n = a.n + b.n`, `mean = n ? (a.mean·a.n + b.mean·b.n) / n : 0`), per field for tokens; `unpricedAttempts` add.
- `MIN_MEASURED_USD_SAMPLES = 3`. `compareUnit(candidates: readonly UnitCandidate[]): CostUnit` (**D5**) returns `"usd"` iff `candidates.length > 0` and **every** candidate satisfies `measuredUSD.n ≥ 3 || (priced && tokenSamples ≥ 1)`. Otherwise it returns `"ratio"` for all candidates. Units are never mixed. (`tokenSamples` = `cost(key).tokens.n`, or `classTokenProfile(cls).n` when the key has none; see clarification C1.)
- `expectedAttemptUSD(stats, pricing, classProfile: TokenMeans | null)`:
  - `measuredUSD.n ≥ 3` returns `measuredUSD.mean`.
  - Else, if priced:
    1. `profile = stats.tokens.n ≥ 1 ? stats.tokens : classProfile`.
    2. `steps = stats.steps.n ≥ 1 ? stats.steps.mean : 1`.
    3. `ctx = (profile.input + profile.cacheRead + profile.cacheWrite) / Math.max(1, steps)` (mean context per request).
    4. Return `priceTokens(selectPriceEntry(pricing, ctx), profile)`, or `null` if there is no profile.
  - Else return `null`.
  - **Invariant (property test):** whenever `compareUnit` returns `"usd"` for candidates built from the same stats and profile, `expectedAttemptUSD` is non-null for each of them.
- `taxUSD(finalMessageTokens, remainingTurns, orchestratorPricing, orchestratorContextTokens)`:
  - Returns `null` when `finalMessageTokens.n === 0` (D8: "0 until measured") or the orchestrator model is unpriced.
  - Otherwise returns `finalMessageTokens.mean · remainingTurns · (selectPriceEntry(orchestratorPricing, orchestratorContextTokens).cache.read ?? 0) / 1e6`.
  - The kernel maps `null` to 0.

#### 4. `store.ts`: `createOutcomeStore(options): OutcomeStore` (interface in `types.ts`)

Internal state:
- `entries: Map<OutcomeKey, { cls, beta, counts, cost }>`, with `cls` cached from `parseKey` at insertion.
- `open: Map<attemptID, OpenAttempt>`, in insertion order.
- `scored` and `closed`: LRU `Map<attemptID, true>`, each capped at `maxScoredAttempts` (default 4096).
- `revision`, `tuning = sanitizeTuning(...)`, and `now = options.now ?? Date.now`.

Methods:
- `configure(t)`: re-sanitize the tuning. Decay and cap use it from the next read or write; stored state is not rewritten.
- `recordVerdict(key, verdict, signal)` (**D4**):
  1. `unverifiable` (or any value other than `pass`/`fail`) returns `false`. This is a **strict no-op**: no counter, no revision bump.
  2. If `scored` has `signal.attemptID`, refresh it in the LRU and return `false` (one observation per attempt).
  3. Otherwise `beta = observe(beta, verdict === "pass", now())`, `counts.pass|fail += 1`, and if `signal.step === "variant"` also `counts.variantPass|variantFail += 1`. Mark the attempt scored, `revision += 1`, return `true`.
- `recordFalseRefusal(key, signal)` (**D4: a false refusal is a failure**):
  - `counts.falseRefusals += 1` and `revision += 1` always (lifetime visibility).
  - If the attempt is not scored yet: `beta = observe(beta, false, now())`; `variantFail += 1` when `step === "variant"`; mark scored; return `true`.
  - Otherwise return `false`.
- `recordStep(key, step)`:
  1. If `closed` has `step.attemptID`, return. Steps after an attempt's final step are host housekeeping (e.g. title/summary on other models) that cannot be priced to this key.
  2. If `open` holds the attempt under a different key, `closeAttempt` it first.
  3. `s = stepUSD(step.cost, step.pricing)`. Then `steps += 1`, `usd += s ?? 0`, `usdKnown &&= s !== null`, `tokens = addTokens(...)`, `lastStepAt = now()`.
  4. If `step.final`:
     - set `finalOutput = step.tokens.output`;
     - fold (`cost = foldAttempt(cost, acc, M)`);
     - delete it from `open` and add it to `closed`;
     - `revision += 1`.
  5. Otherwise re-insert it at the end of `open`. If `open.size > maxOpenAttempts` (default 256), close the first, oldest attempt.
- `closeAttempt(attemptID)`: fold without a final message (if one is open), add to `closed`, `revision += 1`. Unknown ids are a no-op.
- `sweepAttempts(maxIdleMs = 30 * 60_000)`: close every open attempt with `now() − lastStepAt ≥ maxIdleMs` and return the count. A clock going backwards gives a negative age, so nothing is swept.
- `posterior(key, prior = SAME_RANK_PRIOR)` = `posteriorOf(entry?.beta, prior, now(), tuning)`. An **unknown key returns exactly the prior.** It is pure: it never mutates and never bumps `revision`.
- `cost(key)` returns the entry's `CostStats` or a frozen `emptyCostStats()`.
- `classTokenProfile(cls)`: n-weighted mean of `cost.tokens` over entries whose cached `cls` matches; `null` when the total n is 0.
- `keys()` returns the entry keys sorted by code unit (`a < b`; no `localeCompare` anywhere in this phase).
- `snapshot()` returns `{ version: 1, entries }`, with entries in sorted key order and plain-number copies. It excludes open attempts and the dedupe sets.
- `fromSnapshot(snapshot, { mode = "replace" })`:
  - Each entry goes through the same validator as `parseSnapshot` and is dropped if invalid.
  - `replace` clears `entries` and sets the valid ones. Open attempts are kept.
  - `merge` adds each disk key to memory: `mergeBeta`, counts added, `mergeCostStats`.
  - `revision += 1` when anything was accepted.
  - Returns `{ accepted, dropped }`.
  - **Round trip:** `createOutcomeStore().fromSnapshot(s).snapshot()` deep-equals `s` for any valid `s` (no cap or decay applied on load).
- `parseSnapshot(json: unknown)` is exported for `persist.ts`. It returns `{ ok: true, snapshot, dropped } | { ok: false, reason: "unsupported-version" | "corrupt", message }`.
  - The envelope must be an object with `schema === OUTCOMES_SCHEMA_ID`, an integer `version`, and an object `entries`.
  - `version > 1` gives `unsupported-version`; `version < 1`, a wrong schema or a non-object gives `corrupt`.
  - An entry is valid when:
    - its key passes `parseKey`;
    - `beta.alpha`/`beta.beta` are finite and ≥ 0, and `updatedAt` is finite;
    - every count is a non-negative integer;
    - every `mean` is finite and ≥ 0, and every `n` is a non-negative integer.
- Performance: Map operations plus one `2 **` per write. 10 000 mixed records stay well under 50 ms.

#### 5. `persist.ts` (**D15, A3**): injected fs and clock

- `resolveOutcomesDir(configured, { tmpdir, homedir })`:
  - `null`, `undefined` or blank gives `join(tmpdir, DEFAULT_OUTCOMES_DIRNAME)`, i.e. **the scorecard directory** `C:\Users\Marquinho\AppData\Local\Temp\opencode-model-router-trajectory` on this machine.
  - A leading `~` (`~`, `~/…`, `~\…`) is resolved against `homedir`.
  - An absolute path is `normalize`d.
  - A relative path resolves against the default directory, never the process cwd.
  - `routing.outcomes.path` names a **directory** that holds both files.
- Files in the directory:

  | File | Purpose |
  |---|---|
  | `outcomes.json` | store envelope `OutcomesFile` |
  | `outcomes.json.tmp-<pid>-<seq>` | atomic-write temp files |
  | `outcomes.corrupt.json` | last quarantined corrupt store |
  | `decisions.jsonl` | live log |
  | `decisions.<YYYYMMDDTHHMMSSmmmZ>-<pid>.jsonl` | rotated generations (`DECISIONS_ROTATED_RE`) |

  **Coexistence with the scorecard writer:**
  - None of these names matches `*.scorecard.log`.
  - Both writers create the directory with recursive mkdir, which is idempotent and race-free.
  - This module never opens, lists for processing, renames or deletes a scorecard file. It only filters `readdir` by its own prefixes.
  - The scorecard writer is synchronous and in the same process, on different files, so no handle is ever shared.
- `nodePersistFs()` uses `node:fs/promises`:
  - `mkdirp` = `mkdir(dir, { recursive: true })`.
  - `readText` maps `ENOENT` to `null`.
  - `writeDurable` = `open(path, "w")`, `fh.writeFile(data, "utf8")`, `fh.sync()`, `close` in `finally`.
  - `appendText` = `appendFile(path, data, "utf8")`.
  - `rename` as is.
  - `unlink` ignores `ENOENT`.
  - `stat` maps `ENOENT` to `null`.
  - `readdir` maps `ENOENT` to `[]`.
- `nodeScheduler()` = `setTimeout` with `.unref()` and `clearTimeout`. `nodePersistDeps(logger)` = `{ fs: nodePersistFs(), now: Date.now, sleep: ms => new Promise(r => setTimeout(r, ms)), logger, pid: process.pid }`.
- `renameWithRetry(fs, from, to, sleep, delays = RENAME_RETRY_DELAYS_MS)`:
  - Try `rename`.
  - On `EPERM`, `EBUSY` or `EACCES` (Windows: target or source held open by AV, the indexer, a reader or another instance), `await sleep(delays[i])` and retry, using `[15, 30, 60, 120, 240]` ms (≈ 465 ms worst case, always off the hot path).
  - Any other code, or exhausted retries, is thrown to the caller.
  - `readText` in `load`/`readRows` uses the same retry set.
- `createPersister(dir, deps, options): Persister`:
  - **`load({ quarantine = true })`** never throws and never creates the directory.
    1. `text = readText(outcomesPath)`. `null` gives `missing` (empty snapshot, not an error).
    2. Parse it with `JSON.parse`, then `parseSnapshot`.
    3. A parse failure or `corrupt` gives status `corrupt` with an empty snapshot. With `quarantine`, the persister `renameWithRetry`s the file to `outcomes.corrupt.json`; if that fails, it logs and later saves overwrite. It then logs `logger.warn("[router] outcome store corrupted; starting fresh", { path, reason })`. The result is a **fresh store and a warning**.
    4. `unsupported-version` gives status `unsupported-version`, a warning, and `readOnlySnapshot = true`: `saveSnapshot` refuses with `{ ok: false }` so a newer plugin's file is never overwritten.
    5. `dropped > 0` gives status `ok`, with a message and a warning.
    6. Record `lastKnownMtime = stat(outcomesPath)?.mtimeMs`.
    7. With `quarantine` (plugin mode only), delete stale temp files: `readdir`, filter on `OUTCOMES_TMP_PREFIX`, unlink those whose `mtimeMs` is older than `STALE_TMP_MS` (best-effort).
    - `message` always contains the absolute path.
  - **`saveSnapshot(snapshot)`** never throws:
    1. If `readOnlySnapshot`, return `{ ok: false, error: "unsupported outcome store version on disk" }`.
    2. `mkdirp(dir)`.
    3. Foreign-writer check: when the on-disk `mtimeMs` differs from `lastKnownMtime`, log **once** that another process wrote `outcomes.json` and the last writer wins (clarification C7).
    4. `body = JSON.stringify({ schema, version: 1, savedAt: new Date(now()).toISOString(), entries: snapshot.entries }, null, 2) + "\n"`. Entries are already sorted, so the output is deterministic.
    5. `tmp = join(dir, OUTCOMES_TMP_PREFIX + pid + "-" + ++seq)`.
    6. `writeDurable(tmp, body)`, then `renameWithRetry(tmp, outcomesPath)`.
    7. On any error: `unlink(tmp)` (errors ignored) and return `{ ok: false, error, code }`. The old file is untouched, so a crash or failure **never leaves a partial `outcomes.json`**.
    8. On success: `lastKnownMtime = stat(...)?.mtimeMs ?? null` and return `{ ok: true }`.
  - **`appendRows(rows)`** never throws:
    1. An empty list returns ok.
    2. `mkdirp`.
    3. `data = rows.map(r => JSON.stringify(r)).join("\n") + "\n"`, `bytes = Buffer.byteLength(data, "utf8")`.
    4. If `size = stat(decisionsPath)?.size ?? 0` is > 0 and `size + bytes > maxBytes` (default `DECISIONS_MAX_BYTES` = 5 MiB), `rotate()` first.
    5. Then one `appendText(decisionsPath, data)`. An append error returns `{ ok: false }`.
    6. A batch is at most `FLUSH_BATCH_ROWS`, so an oversize single batch overshoots by at most one batch.
  - `rotate()`:
    1. `renameWithRetry(decisionsPath, join(dir, "decisions." + compactStamp(now()) + "-" + pid + ".jsonl"))`.
       - `compactStamp(ms) = new Date(ms).toISOString().replace(/[-:.]/g, "")`, e.g. `20261006T120000123Z`.
       - `ENOENT` is ignored (another process rotated first).
    2. Prune: `readdir` filtered by `DECISIONS_ROTATED_RE`, sorted ascending; unlink all but the newest `maxGenerations` (default 3).
    3. Rotation failures are logged; the append proceeds to the over-limit file and the next flush retries.
    4. Unique timestamped names (no shifting) mean two concurrent rotators can never overwrite each other's generation. The total on disk stays ≤ 4 × 5 MiB plus one batch.
  - **`readRows()`** never throws:
    1. `files` = the rotated generations sorted ascending (the timestamp gives chronological order), then `decisions.jsonl` if it exists.
    2. Split each file on `/\r?\n/` and skip empty lines.
    3. `parseLogLine(line)` (exported) gives a valid row or `null`, which counts toward `skipped`. A torn last line after a crash is expected.
    4. Row validation:
       - `v === 1`;
       - `kind ∈ { decision, verdict, refusal }`;
       - `ts` string with a finite `Date.parse`;
       - `sessionID` string;
       - every `key`, `chosen.key` and `best.key` passes `parseKey`;
       - enum fields belong to their unions (`LoggedRoutingMode`, `CostUnit`, `Verdict`, `LadderStepKind`);
       - booleans are booleans;
       - `facts.class`, `risk`, `scope` and `source` are strings, `needs` is a string array, `confidence` is finite;
       - `costs` is an object, and non-number or non-finite values are **dropped from `costs`** while the row is kept;
       - unknown extra fields are ignored (forward-compatible within v1).
- `createFlusher(store, persister, deps: FlusherDeps, options): OutcomeFlusher`. It provides coalescing, the throttle, and keeps I/O off the hot path.
  - State:
    - `queue: LogRow[]`;
    - `writtenRevision = store.revision` at creation;
    - `inFlight: Promise | null`;
    - `timer`;
    - `again = false`;
    - `lastFlushEnd = −Infinity`;
    - `disposed`;
    - `droppedRows`;
    - `idleWaiters`: resolvers released when the flusher becomes quiescent (no timer, nothing in flight).
  - `hasWork() = store.revision !== writtenRevision || queue.length > 0`.
  - `enqueue(row)`:
    - If disposed, drop the row.
    - Otherwise push it. Beyond `maxQueuedRows` (5000), drop the oldest and add to `droppedRows`.
    - Then `void requestFlush()`.
    - **No I/O and no await**, so it is safe inside `execute.before`.
  - `requestFlush()`:
    - If disposed or `!hasWork()`, return a resolved promise.
    - If something is in flight, set `again = true` and return the quiescence promise.
    - If a timer is pending, return the quiescence promise.
    - Otherwise `schedule(Math.max(0, lastFlushEnd + minIntervalMs − now()))` (`minIntervalMs` = 30 000) and return the quiescence promise.
    - Even a delay of 0 goes through `scheduler.setTimer`, so **no write ever runs inside the calling hook's stack.**
  - `schedule(ms)`: `timer = setTimer(() => { timer = null; run(); }, ms)`.
  - `run()`: `inFlight = doFlush().catch(log).finally(…)`. In the `finally`:
    1. Clear `inFlight` and set `lastFlushEnd = now()`.
    2. If `(again || hasWork()) && !disposed`, set `again = false` and `schedule(minIntervalMs)`.
    3. Otherwise release `idleWaiters`.
  - `doFlush()`:
    1. If `store.revision !== writtenRevision`, `saveSnapshot(store.snapshot())`. On success, `writtenRevision` = the revision read **before** the snapshot.
    2. While the queue is non-empty, `appendRows(queue.splice(0, batchRows))`. On failure, put the batch back at the front, trim to `maxQueuedRows`, warn, and stop.
    3. Warn once per flush if rows were dropped.
    4. Repeat warnings are limited to the first failure of a streak plus one `info` on recovery.
  - `flushNow()`: await any in-flight flush, clear the timer, run `doFlush()` directly (no throttle), then release waiters if quiescent.
  - `dispose()`: `flushNow()`, clear the timer, set `disposed = true`, release waiters.
  - Trigger policy (D15):
    - every mutation path calls `requestFlush` (ingest after store calls, `enqueue`), and so do `session.idle`/`session.deleted` (2.1);
    - the throttle guarantees at most one write per 30 s, and dirty state is written within 30 s.
    - Unref'd timers never keep a process alive. At most ≈ 30 s of rows can be lost on a hard exit, which is accepted and documented.
- **Static mode writes nothing.** 2.1/2.2 never call `acquireOutcomes` while `routing.engine` resolves to `static`, which preserves the §1.2 "no new files" guarantee.

#### 6. `index.ts`: one store and one writer per process (**A3**)

- `acquireOutcomes({ dir, tuning, logger, deps? }): OutcomesBundle` uses a module-scope `Map<id, { bundle, refs }>`.
  - `id = process.platform === "win32" ? resolve(dir).toLowerCase() : resolve(dir)`.
  - **Existing entry:** `refs += 1` and `store.configure(tuning)` (on hot reload or a second location, the last caller wins; log `info` when the values change). Return a holder whose `release()` is idempotent per holder.
  - **New entry:**
    1. `store = createOutcomeStore({ ...tuning, now })`.
    2. `persister = createPersister(dir, deps ?? nodePersistDeps(logger))`.
    3. `flusher = createFlusher(store, persister, { now, scheduler: nodeScheduler(), logger })`.
    4. `ready = persister.load({ quarantine: true }).then(r => { if (r.status === "ok") store.fromSnapshot(r.snapshot, { mode: "merge" }); return r; })`. On any rejection it returns a `corrupt`-shaped result, so it never rejects.
    - `merge` makes records that arrive before the load completes additive, not lost.
  - `release()`: `refs −= 1`; at 0, delete the entry from the registry and `await flusher.dispose()`.
  - Two plugin instances of the same process (S3b) therefore share one store and one flusher. Event-id dedupe stays 2.1's module-scope set.
- Re-exports:
  - every type with `export type { … } from "./types"`;
  - values (`makeKey`, `parseKey`, `splitModelRef`, `classifyAgentOrigin`, `verdictOf`, `normalizeVariant`, constants);
  - `beta.ts`/`cost.ts` functions;
  - `createOutcomeStore`, `parseSnapshot`;
  - `createPersister`, `createFlusher`, `resolveOutcomesDir`, `nodePersistFs`, `nodePersistDeps`, `nodeScheduler`, `parseLogLine`;
  - `summarize`, `renderMarkdown`, `parseStatsArgs`, `runStatsCli`. `index.ts` only gains these `stats.ts` re-exports in 1.3.3.

#### 7. `stats.ts` (1.3.3, D18): pure

`summarize(store: OutcomeStoreView | null, rows: readonly LogRow[], window: StatsWindow): StatsTable`
- **Window.** `inWindow(r)`: `t = Date.parse(r.ts)` is finite, `(since === null || t >= since)` (**`since` is inclusive**) and `(until === null || t < until)` (`until` is exclusive, so consecutive DF periods never double-count). `W = rows.filter(inWindow)`.
- **Joins** for `switched.failed` look up the **unwindowed** `rows`, because a switched dispatch's verdict may land after `until`.
- `D` = decision rows of `W`. `P` = those with `step === "dispatch"`. `NP` = `P` without pinned rows. `dispatchedKey(r) = r.switched && r.best ? r.best.key : r.chosen.key`.
- `ratio(num, den) = { num, den, rate: den === 0 ? null : num / den }`. No division by zero is possible anywhere.
- Columns, in the 1.3.3 order:
  1. `dispatches = P.length`.
  2. `byClass`: `P` grouped by `facts.class`, sorted ascending.
  3. `byKey`: union of `dispatchedKey(D)` and the verdict/refusal keys of `W`, sorted ascending. Per key:
     - `dispatches` = rows of `P` with that key;
     - `attempts` = rows of `D` (any step) with that key;
     - `pass`/`fail`/`unverifiable` = verdict rows of `W`;
     - `passRate = ratio(pass, pass + fail)`;
     - `falseRefusals` = refusal rows of `W`;
     - `refusalRate = ratio(falseRefusals, attempts)`;
     - `measuredUSD` = `store.cost(key).measuredUSD` when `n > 0`, else `null` (also `null` when `store` is null). This is the store's **lifetime per-attempt** mean (clarification C9).
  4. `agreement = ratio(count(r ∈ NP, r.best && r.best.key === r.chosen.key), count(r ∈ NP, r.best !== null))`. **0 non-pinned rows gives `rate: null`, rendered `n/a`.**
  5. `switched`:
     - `count` = rows of `NP` with `switched`;
     - `share = ratio(count, NP.length)`;
     - `failed` = switched rows of `NP` whose `decisionID` has, anywhere in `rows`, a verdict row with `verdict === "fail"` or a refusal row (D4; input to D17).
  6. `pinned` = rows of `P` with `pinned`.
  7. `savings`: for `r ∈ NP` with `best !== null`, take `c = r.costs[r.chosen.key]` and `b = r.costs[r.best.key]`. When both are finite, add `c − b` to the `total` of `r.unit` and count the row. Output one entry per unit with rows > 0, sorted by unit (`ratio`, `usd`). **Units are never summed together.**
  8. Measured USD per dispatch is part of `byKey` (point 3).
  9. False-refusal rate per key and verdict rates per key are part of `byKey` (point 3).
  10. `variantSteps`: `taken` = rows of `D` with `step === "variant"`; `passRate = ratio(pass, pass + fail)` over verdict rows of `W` with `step === "variant"`.
  11. `resumeVsFresh`: for each kind of `LADDER_STEP_KINDS` in order, `{ step, resume: count(D, step, resume), fresh: count(D, step, !resume) }`.
  - `window`: `since`/`until` become `new Date(ms).toISOString()`, or `null`.
- An empty window gives every count 0, every rate `null`, `savings: []`, `byClass`/`byKey` `[]`, and four zero rows in `resumeVsFresh`. There is no `NaN` anywhere.

`renderMarkdown(table): string` uses `\n` only, separates blocks with exactly one blank line, and ends with exactly one `\n`.
- Formatting helpers:
  - `fix(x, d) = (Math.abs(x) < 0.5 * 10 ** -d ? 0 : x).toFixed(d)` (no `-0.00`);
  - `R(cell) = cell.den === 0 ? "n/a" : `${num}/${den} (${(100 * num / den).toFixed(1)}%)``;
  - `P(cell) = cell.den === 0 ? "n/a" : `${(100 * cell.rate).toFixed(1)}%``;
  - `usd(x) = "$" + fix(x, 4)`, `ratioAmt(x) = fix(x, 2)`.
- Cell escaping: `|` becomes `\|`, and `\r?\n` becomes a space. Keys contain `|`.

Exact template (`<since>` = ISO or `start`, `<until>` = ISO or `open`):

```
## Routing stats

Window: <since> → <until>

| Metric | Value |
|---|---|
| Dispatches | <dispatches> |
| Pinned | <pinned> |
| Agreement (best == chosen, non-pinned) | <R(agreement)> |
| Switched | <count> of <share.den> non-pinned (<P(share)>); failed <failed> |
| Estimated savings (<unit>) | <usd(total) or ratioAmt(total)> over <rows> rows |
| Variant steps | <taken> taken; pass <R(variantSteps.passRate)> |

### By class

| Class | Dispatches |
|---|---|
| <class> | <dispatches> |

### By key

| Key | Dispatches | Attempts | Pass | Fail | Unverifiable | Pass rate | False refusals | Refusal rate | USD/dispatch |
|---|---|---|---|---|---|---|---|---|---|
| <key> | <dispatches> | <attempts> | <pass> | <fail> | <unverifiable> | <R(passRate)> | <falseRefusals> | <R(refusalRate)> | <usd(mean) + " (n=" + n + ")" or n/a> |

### Resume vs fresh

| Step | Resume | Fresh |
|---|---|---|
| dispatch | <resume> | <fresh> |
| variant | <resume> | <fresh> |
| retry | <resume> | <fresh> |
| escalate | <resume> | <fresh> |
```
- The savings line repeats once per `SavingsRow`. With none, it is the single line `| Estimated savings | n/a |`.
- An empty `byClass` or `byKey` renders `_none_` in place of its table (header and separator omitted).

`parseStatsArgs(argv)` returns `{ ok: true, args: { since: number | null, until: number | null, json: boolean, dir: string | null, help: boolean } } | { ok: false, error }`.
- Accepted forms: `--since <v>`, `--since=<v>`, the same for `--until` and `--dir`, `--json`, `--help`/`-h`.
- A repeated flag, a missing value, an unknown argument, or `since >= until` with both set is an error.
- An ISO value must match `^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$` and have a finite `Date.parse`. A **date-time requires `Z` or an offset**, because a zone-less date-time parses as local time and would make windows machine-dependent. A date alone is UTC midnight.

`USAGE` (exact, stdout for `--help`, stderr after a usage error):
```
Usage: npm run routing:stats -- [--since <ISO>] [--until <ISO>] [--json] [--dir <path>]
  --since <ISO>  include rows with ts >= since (YYYY-MM-DD, or date-time with Z or an offset)
  --until <ISO>  include rows with ts < until
  --json         print the StatsTable as JSON
  --dir <path>   outcome directory (default: <os tmpdir>/opencode-model-router-trajectory)
```

`runStatsCli(argv, io: StatsCliIO): Promise<number>` never throws. It wraps everything; an unexpected error writes `routing-stats: <message>\n` to stderr and returns 1.
1. A parse error writes `routing-stats: <error>\n` + `USAGE` to stderr and returns `STATS_EXIT.usage` (2). `--help` writes `USAGE` to stdout and returns 0.
2. `source = io.open(args.dir ?? io.defaultDir)`. A relative `--dir` is resolved by the script against cwd before `open`.
3. `r = await source.load({ quarantine: false })`. The CLI is strictly read-only: no quarantine, no temp cleanup, no mkdir.
4. `corrupt` or `unsupported-version` writes `routing-stats: corrupted outcome store: <r.message>\n` and returns `STATS_EXIT.corrupt` (1). `r.dropped > 0` writes a warning to stderr and continues. `missing` is an empty store with exit 0 (DF1 expects this).
5. `store = createOutcomeStore()`; if `ok`, `store.fromSnapshot(r.snapshot)`.
6. `rr = await source.readRows()`. If `rr.skipped > 0`, write `routing-stats: skipped <n> unreadable decision-log line(s)\n` to stderr.
7. `table = summarize(store, rr.rows, { since, until })`. stdout gets `--json ? JSON.stringify(table, null, 2) + "\n" : renderMarkdown(table)`. Return 0.

#### 8. `scripts\routing-stats.ts` and running without `tsx`

| Option | Evaluation against `D:\git\omr-car-p13\package.json` and this machine | Verdict |
|---|---|---|
| `npx tsx …` (plan text) | `tsx` not installed (0.P, re-checked); `npx` would fetch it from the network at run time, which is a hidden dependency | rejected |
| `vite-node` | no `vite-node` binary in `node_modules\.bin` (vitest 5 does not ship that CLI); it would need a new dependency | rejected |
| vitest as the runner (a "test" that prints) | reporter output pollutes stdout, CLI args do not pass cleanly, and a byte-for-byte match is impossible | rejected |
| `tsc` to a temp dir, then `node` | needs a separate tsconfig (outside the write-set) and `.js` extension rewriting, because Bundler-style extensionless imports do not run in Node ESM; it adds a build step the repo does not have | rejected |
| `bun` | not installed, not a repo convention | rejected |
| `node --experimental-strip-types scripts/routing-stats.ts` | works (probe 1), but the flag is redundant on Node ≥ 22.18 / 23.6 (stripping is on by default) and its future is less certain than the default | not chosen |
| **`node scripts/routing-stats.ts`** + an in-script `module.registerHooks` resolver | zero dependencies, no build; probes 1–3 pass on Node 24.21; requires Node ≥ 22.18 (22.x) or ≥ 23.6 | **chosen** |

`package.json` line (1.3.3, the only `package.json` edit of Wave 1 for 1.3): `"routing:stats": "node scripts/routing-stats.ts"`. Usage: `npm run routing:stats -- --since 2026-10-06T12:00:00Z`.

Script content (1.3.3 writes exactly this; ≈35 lines):
```ts
// D:\git\opencode-model-router\scripts\routing-stats.ts — `npm run routing:stats -- [--since <ISO>] [--until <ISO>] [--json] [--dir <path>]`
// Plain Node (type stripping on by default: Node >= 22.18 / 23.6). No tsx, no build step.
import { registerHooks } from "node:module";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";

// src/ uses extensionless relative imports (moduleResolution "Bundler"); Node's ESM resolver adds no
// extension, so a relative specifier that fails is retried as "<spec>.ts", then "<spec>/index.ts".
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const code = (error as { code?: string }).code;
      const relative = specifier.startsWith("./") || specifier.startsWith("../");
      if (!relative || /\.[cm]?[jt]s$/.test(specifier) || (code !== "ERR_MODULE_NOT_FOUND" && code !== "ERR_UNSUPPORTED_DIR_IMPORT")) throw error;
      for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
        try {
          return nextResolve(candidate, context);
        } catch {
          // next candidate
        }
      }
      throw error;
    }
  },
});

const outcomes = await import("../src/routing/outcomes/index");
const deps = outcomes.nodePersistDeps({ warn() {} }); // the CLI reports through runStatsCli, not the logger
process.exitCode = await outcomes.runStatsCli(process.argv.slice(2), {
  defaultDir: outcomes.resolveOutcomesDir(null, { tmpdir: tmpdir(), homedir: homedir() }),
  open: (dir) => outcomes.createPersister(resolve(dir), deps),
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
});

export {};
```
- `process.exitCode`, never `process.exit()`: on Windows, `exit()` can truncate piped stdout.
- **Typecheck coverage:** `scripts/` is outside `tsconfig.json` `include`, and `tsconfig.json` is outside the write-set. So `D:\git\opencode-model-router\test\unit\routing-outcomes.stats.test.ts` carries `import type * as RoutingStatsScript from "../../scripts/routing-stats";`. A type-only import pulls the file into `tsc --noEmit` without executing it, and `export {}` makes it a module.
- 3.1 documents the Node minimum for `routing:stats` (the plugin's runtime `engines` stays `>=20`).

#### 9. Test map (plan §3 Phase 1.3 "Tests" → function → file)

Files under `D:\git\opencode-model-router\test\unit\`:

| Plan test | Function(s) | File |
|---|---|---|
| Stats: empty window → all zeros, no NaN | `summarize` (+ `renderMarkdown` shows `n/a`, `_none_`) | `routing-outcomes.stats.test.ts` |
| Stats: agreement with 0 non-pinned rows → `n/a` | `summarize` (`agreement.rate === null`), `renderMarkdown` | stats |
| Stats: mixed units → savings per unit, never summed | `summarize` (`savings` has two rows, totals independent) | stats |
| Stats: `--since` boundary inclusive | `summarize` (row at `ts === since` counted, row at `ts === until` not), `parseStatsArgs` | stats |
| Stats: markdown deterministic (snapshot) | `renderMarkdown` (inline snapshot of a fixed table; rows shuffled → identical output) | stats |
| Stats: script matches module output byte for byte | `scripts\routing-stats.ts` via `spawnSync(process.execPath, ["scripts/routing-stats.ts", "--dir", tmp, "--since", …], { cwd: repo root })`; fixture written into `os.tmpdir()` by the real `createPersister` (fixtures are not in the write-set); expected = `renderMarkdown(summarize(store, rows, window))` | stats |
| (1.3.3) corrupted store → non-zero exit | `runStatsCli` (fake `StatsCliIO`) and the spawned script; exit 1 | stats |
| Beta: prior means per D7 for ranks −2..+2 | `priorForRankOffset` (means 0.30/0.55/0.80/0.85/0.90 within 1e-12, α+β = 5; +3/+9 → 0.95, −3 → 0.30) | `routing-outcomes.beta.test.ts` |
| Beta: `pass`/`fail`/`refusal` updates | `observe`; `store.recordVerdict`, `store.recordFalseRefusal` | beta, store |
| Beta: `unverifiable` no-op | `store.recordVerdict(..., "unverifiable", ...)` → `false`, `revision` unchanged, snapshot deep-equal | beta |
| Beta: decay halves after `halfLifeDays` | `decayFactor`, `decayTo`, `posteriorOf` ({10, 6} → {5, 3} exactly) | beta |
| Beta: cap keeps mean within 1e-9 | `capEvidence`, `observe` over 400 records at M = 50 | beta |
| Beta: clock going backwards does not inflate | `decayTo`/`posteriorOf` at `t − 1 day` equals `t`; a later read at `t + h` is exactly half | beta |
| Cost: unit rule with 0/1/all priced | `compareUnit` ([] → ratio; 0 priced → ratio; 1 of 2 → ratio; all priced with token profile → usd; unpriced with n = 3 measured → usd; priced without token profile and n < 3 → ratio) | `routing-outcomes.cost.test.ts` |
| Cost: `cost == 0` with empty pricing → null, excluded from means | `isUnpriced` (`[]`, `undefined`, all-zero multi-tier → true), `stepUSD`, `foldAttempt` (`measuredUSD.n` unchanged, `unpricedAttempts + 1`, tokens counted) | cost |
| Cost: token means per field | `foldAttempt`, `updateTokenMeans` | cost |
| Cost: `finalMessageTokens` separated from step tokens | `foldAttempt` (final step only; `closeAttempt` without final leaves it unchanged) | cost |
| (A10) tiered price lookup | `selectPriceEntry` (272 000 tier: 100k → base, 300k → tier, tier-only + small input → smallest tier), `priceTokens`, `expectedAttemptUSD` | cost |
| Store: key normalisation (`default` variant) | `makeKey`, `parseKey`, `normalizeVariant`; store `recordStep`/`posterior` with `undefined`/`null`/`""` variants hit one key | `routing-outcomes.store.test.ts` |
| Store: unknown key → prior | `posterior` (default `Beta(4,1)`; explicit prior returned exactly) | store |
| Store: snapshot round-trip equality | `snapshot`, `fromSnapshot`, `parseSnapshot` (also through `JSON.stringify`/`parse`) | store |
| Store: 10 000 records under 50 ms | `recordVerdict` + `recordStep` over 50 keys, `performance.now()` after one warm-up | store |
| Persist: atomic write leaves no partial file on simulated crash | `saveSnapshot` with an in-memory `PersistFs` whose `writeDurable` throws mid-write, or `rename` throws `EPERM` 6× → old content intact, temp removed, `ok: false`; `EPERM` 2× then success → `ok`, sleeps `[15, 30]` | `routing-outcomes.persist.test.ts` |
| Persist: corrupted JSON → fresh store + warning | `load` (`corrupt`, empty snapshot, one `warn`, quarantined to `outcomes.corrupt.json`; next `saveSnapshot` writes fresh), `acquireOutcomes` store stays usable | persist |
| Persist: JSONL rotates at the limit | `appendRows` with `maxBytes` = 200, `maxGenerations` = 2 → rotated names match `DECISIONS_ROTATED_RE`, oldest pruned, `readRows` returns rows in order, torn last line → `skipped` | persist |
| Persist: concurrent flush calls coalesce | `createFlusher` with a manual `FlushScheduler`: 10 synchronous `requestFlush()` → 1 timer, 1 `saveSnapshot`, 1 `appendRows`; 5 requests during an in-flight flush → exactly 1 follow-up after `minIntervalMs` | persist |

QA-probe tests the plan's QA line asks for (same files):
- **Key collisions:** `router:explore` and `host:explore` on the same model give two keys with independent posteriors; `classifyAgentOrigin`; escaped delimiters round-trip (store).
- **Numeric stability:** dt = 1e15 ms gives posterior = prior; 1e6 observations keep evidence ≤ M + 1 and the mean finite; a NaN clock means no decay; tiny counts flush to 0 (beta).
- **Decay drift:** reads never change `revision` or the snapshot; write at t1 then t2 equals a single write at t2 within 1e-12 (beta).
- **Persistence races with the scorecard writer:** a directory pre-filled with `*.scorecard.log` files has them byte-identical after `load`/`saveSnapshot`/rotate/prune, and they never appear in `readRows().files` (persist).
- **Unsupported version:** a newer file is never overwritten (`saveSnapshot` returns `ok: false`) (persist).
- **Single writer per process (A3):** two `acquireOutcomes` calls for the same directory (case-different on win32) return the same store; the last `release` disposes once (persist).

#### 10. Design clarifications (*Amended during implementation*, pending phase QA)

- **C1 → D5.** A priced candidate is USD-comparable only when there is a token profile to price (its own, or the class-pooled one). On a cold store every decision is in `ratio`. This follows from D8's "never invented" and changes no outcome where D5 is computable.
- **C2 → §0.11 / 1.3.3.** `StatsTable.switched` carries `failed` (switched dispatches whose attempt ended in `fail` or a false refusal), because D17's DF5 rule needs it and `routing:stats` is the checkpoint source (D18). It is a sub-field of the "switched" column, not a new column.
- **C3 → M3 key.** The `${agent}` segment is origin-qualified (`router:<id>` / `host:<id>`) and every part is percent-escaped (§1).
- **C4 → M3 cost.** One cost sample is one **attempt** (the steps of one dispatch or ladder step), because D8's `c_k` is per attempt. Steps after an attempt's final step are ignored (§4).
- **C5 → D4.** One Beta observation per attempt (dedupe by `attemptID`). The first terminal signal wins, and 2.1 must emit the refusal before the verdict of the same attempt.
- **C6 → D6/A1.** An unpriced model's non-zero `cost` is kept as a measurement. A negative or non-finite `cost` is `null`.
- **C7 → D15.**
  - Rotation keeps 3 timestamped generations (≤ 20 MiB total).
  - Across *processes*, `outcomes.json` is last-writer-wins with a one-time warning. A3 scopes single-writer to the process; one host process per directory is the supported setup.
  - An `unsupported-version` file is never overwritten.
- **C8 → 1.3.3.** `routing:stats` runs as `node scripts/routing-stats.ts` (§8), not `npx tsx`. `routing.outcomes.path` is a directory.
- **C9 → §0.11 rows.** The JSONL holds `verdict` and `refusal` rows besides `decision` rows, so windowed outcome columns are exact. `USD/dispatch` in the stats table is the store's lifetime per-attempt mean (all live models are unpriced per A1, so the dogfood shows `n/a`).

## Findings

None yet. The phase QA (`[tier:heavy]`, adversarial) runs after 1.3.3 and records `QA-1.3-<n>` here.

## Deferred by plan

- Implementation of `beta.ts`, `cost.ts`, `store.ts`, `persist.ts`, `index.ts` (1.3.2) and of `stats.ts`, the script, the `package.json` line and the stats re-exports (1.3.3), all `[tier:medium]`.
- Ingestion and flush triggers (2.1); decision rows (2.2); ladder-attempt rows (2.3); `/router stats` (2.4); docs, including the Node minimum for `routing:stats` (3.1).

## Handoffs

- **to 1.1:**
  - `routing.outcomes = { path: string | null, halfLifeDays, maxEffectiveSamples }`. `path` is a **directory**: `~` is expanded, and a relative path resolves against the default directory (`resolveOutcomesDir`).
  - `resolveRouting` passes these values through unchanged. 1.3 depends on nothing else from config.ts, and the import is type-only.
- **to 1.2:** `TaskFacts` must stay assignable to `DecisionFacts` (string-valued `class`/`risk`/`scope`/`source`, string `needs[]`, numeric `confidence`).
- **to 1.4:**
  - `p_k = store.posterior(key, priorForRankOffset(rank(k) − rank(static tier)))`.
  - Pick the unit with `compareUnit`, then `c_k = expectedAttemptUSD(...)` in `usd`, or `costRatio` in `ratio`.
  - `tax_k = taxUSD(...) ?? 0` in `usd`. Recommended: `tax_k = 0` in `ratio`, since there is no USD→ratio exchange rate.
  - Build candidate keys with `makeKey(cls, { origin: classifyAgentOrigin(id, routerTierNames), id }, provider, model, variant)`.
  - `Decision.costs` must hold finite numbers only.
- **to 1.5:** ladder-attempt kinds in rows are `variant | retry | escalate` (`LadderStepKind`).
- **to 2.1:**
  - Call `acquireOutcomes` only when the engine is not `static`.
  - `attemptID = ${childSessionID}:${attemptIndex}`, with a new index per resume or ladder attempt (the registry holds it with the key and `decisionID`).
  - `recordStep(key, { attemptID, cost: data.cost, pricing: pricingState(catalog cost of the model), tokens: tokenSampleFromEvent(data.tokens), final: data.finish !== "tool-calls" })`.
  - `closeAttempt` on `session.deleted` or a gone child; `sweepAttempts` from the existing sweeper.
  - Call `recordFalseRefusal` **before** `recordVerdict` for the same attempt (C5). Use `verdictOf(verdict)` from the verifier result.
  - Enqueue `VerdictRow`/`RefusalRow` (including `unverifiable` verdict rows).
  - `flusher.requestFlush()` on `session.idle`/`session.deleted`.
  - The event-id dedupe set and the registry live in module scope (A3).
- **to 2.2:**
  - `DecisionRow` per `types.ts`, with a unique `decisionID` (e.g. `${sessionID}:${now}:${counter}`).
  - `childSessionID` is `null` for fresh dispatches; the registry carries the `decisionID` to the child.
  - `mode` is never `static`.
  - `chosen` = the orchestrator's pick; `best` = the argmin.
  - Enqueue through `flusher.enqueue` only (no await).
- **to 2.3:** every ladder attempt enqueues a `DecisionRow` with `step ∈ { variant, retry, escalate }`, `resume` per D11/A5, `chosen` = the ladder pick, `best` = `null` (or the same), and `switched: false`.
- **to 2.4:** `/router stats [--since]` = `await flusher.flushNow()`, then `renderMarkdown(summarize(store, (await persister.readRows()).rows, window))`, parsed with `parseStatsArgs`. It must equal the script's output for the same directory and window.
- **to the orchestrator (DF1–DF5):**
  - Run `npm run routing:stats -- --since <ISO with Z>`. A zone-less date-time is rejected.
  - Add `--dir <path>` when `routing.outcomes.path` is set.
  - DF5 reads `switched … failed <n>` for D17.

## Verdict

Design 1.3.1 is delivered: `D:\git\opencode-model-router\src\routing\outcomes\types.ts` is final and typecheck is green. Phase QA is pending after 1.3.3, with open findings to be recorded by QA.
