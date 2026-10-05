# Phase 1.1: configuration surface. QA review

Branch `de/p11` (worktree `D:\git\omr-de-p11`), reviewed range `de/wave-1-base..HEAD`:
`a1c74b8` feat, `709b6cf` docs, `b937915` fix, `e0742fe` test. Issues #66 and #67.
Reviewer: adversarial senior QA (`[tier:heavy]`, CAP:none). The reviewer did not write this code.

## Pre-flight

| Check | Result |
|---|---|
| Worktree base | `de/wave-1-base` at `c11e7a8` |
| `npm ci` + `npm run typecheck` (base) | OK |
| Capped full suite, run once on the identical base tree | **101 files passed / 3 skipped; 3645 tests passed / 65 skipped** |
| `router_verify` | Handle `vrf_532d…` (the superseded 1.1.2 attempt) was **unverifiable** because the tree had drifted. It is re-checked by the scoped run below. |
| `npm run typecheck` at `HEAD` `e0742fe` (this review) | Clean (`tsc --noEmit`, no diagnostics) |
| Scoped run at `HEAD` (this review): `npx vitest run test/unit/config-depth-effort.test.ts test/unit/config.validate.test.ts test/unit/docs-drift.test.ts test/unit/config --maxWorkers=50%` | **5 files, 243 tests passed** (`config-depth-effort`, `config.validate`, `config.overrides`, `config-verify-budget`, `docs-drift`) |

Limits of this pre-flight:
- The full suite was **not** re-run at `HEAD`, because QA scope allows only the scoped files. `b937915` changes
  what `validateConfig` returns: when `enforcement` is present it now returns a copy, not `raw`.
  That reaches six test callers outside the scoped run: `test/golden/*` ×5, `test/unit/effort.test.ts`,
  `test/unit/baseline.test.ts` and `test/integration/{failover-compose,fable-effort-preset}.test.ts`.
  They are covered by the DoD's capped suite after the merge.
- Coverage (≥ 95 % of the new code) was not re-measured. `--coverage` is not among the allowed
  commands. An ignored `coverage/` directory in the worktree was not used as evidence.
- Runtime probes were read-only. Node 24 type stripping plus a resolve hook imported
  `src/router/config.ts` directly, with no files written. The probe results are cited in the findings.

## Implementation notes

**Built (a1c74b8, 709b6cf):**
- `EnforcementConfig.maxDelegationDepth?: number | null`, `escalate.effortBump?: boolean` and
  `escalate.effortBumpMax?: EffortLevel`. Each has a JSDoc line giving its default
  (`src/router/config.ts:125-126, 174-177`).
- Validation in `validateEnforcement`:
  - depth: `null` or `Number.isInteger` ≥ 1 (`:742-753`);
  - `effortBump`: boolean (`:913-916`);
  - `effortBumpMax`: case-sensitive member of `EFFORT_LEVELS` (`:917-925`).
- Pure resolvers `resolveDepthLimit` (`undefined → 1`, `null` stays `null`) and `resolveEffortBump`
  (`true`, `"xhigh"`) at `:1323-1336`. A grep of `src` finds no other copy of these defaults. The
  `?? 1` hits (`guard/enforce.ts:50`, `escalate/ladder.ts:187`, `verify/exec.ts:262`,
  `router/protocol.ts:74`) and the `"xhigh"` hit (`agent-options.ts:154`) are unrelated. The bundled
  `tiers.json` does not ship the three keys.
- QA-0.P-17 handoff (A4): the `EFFORT_LEVELS` comment (`:37-43`) now names `reasoningEffort`.
- `CONFIG_REFERENCE.md`:
  - table rows (`:159`, `:502-503`);
  - "Delegation depth" section (`:167-191`), covering A1 (advisory warns, enforced refuses, off ignores; `null` disables);
  - "Effort bump before escalation" section (`:509-531`), covering D7/D8;
  - validation rules (`:609`, `:616-617`).
- `docs-drift.test.ts` asserts that the three dotted key paths appear in the reference. A fixture-based
  negative test runs once per key.

**Two defects found by the test task (1.1.2) and fixed in `b937915`:**
1. *Validated value ≠ returned value.* Validation read each key once but returned `raw`, so an
   accessor could yield a different, unvalidated value later (plan: "a getter is not invoked twice
   with different results"). Fix: `withValidatedSnapshots` rebuilds `escalate`, `enforcement` and
   the root from their own property descriptors, with the validated values written as data
   properties. Other keys keep their descriptors and references.
2. *Rejections did not name the value* (§1.2: "layer dropped with a warning naming the value").
   Fix: each of the three messages now ends `(got '<String(value)>')`.

Review of the fix: it is correct for every input JSON can produce. Callers are not mutated, and
other keys keep their behaviour: unrelated descriptors and references are preserved (pinned by
`test:174-191`), and `deepMerge` order is untouched. Edge cases outside JSON are in QA-1.1-4 and
QA-1.1-5.

**Amended during implementation:** `maxDelegationDepth` is a safe integer from 1 to 32,
or `null`, rather than an unbounded integer ≥ 1. The cap matches `MAX_DEPTH_HOPS` so a cycle
or overlong chain refuses the next dispatch for every configured limit. Acceptance tests
accept `32` and reject `33` and `100`. Recorded in plan §1.7 A13 on de/main (orchestrator),
resolving QA-1.1-R2-1. The plan is not edited on this branch. The previously missing
`__proto__` rejection (QA-1.1-2) was fixed in `6bfd03f`.

**Adversarial checks with no finding:**
- `-0` is rejected (`Number.isInteger(-0)` and `-0 < 1`), as are `1e400` (→ `Infinity`), `NaN`, a
  boxed `Number`, a `BigInt`, a numeric string (JSONC parsing is `JSON.parse`, so `"2"` stays a
  string) and `Symbol`. `String(Symbol())` does not throw.
- **An override layer cannot delete a default.** The defaults live only in the resolvers. An override
  of `escalate: null`, `[]` or `"x"` leaves `effortBump`/`effortBumpMax` undefined, so the resolvers
  return the defaults. `enforcement: null` is rejected and the layer dropped. An override of
  `maxDelegationDepth: null` disables the guard, which is documented and intended, and at the same
  trust level as `mode: "off"`.
- **The degrade path does not brick.**
  - Bundled `tiers.json`: it ships none of the keys, so there is no new throw at startup.
  - Override layer: a bad value drops the layer with a warning and the bundled defaults stand
    (`test:193-217`, which also covers the per-layer fallback).
  - State file: it cannot carry these keys (`RouterState`, `:257-261`). The `enforcementMode`
    spread at `:1279` keeps the snapshotted keys.
- **The docs-drift test fails on drift.** Deleting any dotted path from the reference fails the
  positive test, because the closing backtick prevents `effortBump` from matching inside
  `effortBumpMax`. The fixture test proves that the shared helper is not vacuous.
- **Types are consistent.** `maxDelegationDepth?: number | null` has no other consumer yet, and
  typecheck is clean.
- **Pre-existing configs report the same first error as before.** The new checks only fire on the
  new keys.

## Findings

| id | severity | file:line | description | resolution |
|---|---|---|---|---|
| QA-1.1-1 | major | `src/router/config.ts:742-753`; `docs/CONFIG_REFERENCE.md:180-181`; plan D2 (`:379-380`) | **No upper bound, so a valid limit silently disables D2.** Validation accepts any integer ≥ 1. The probe confirmed that `1e300` and `2**53+2` pass, and `100` is accepted and tested (`test:78`). D2 and 1.2 cap a cycle or an overlong chain at `MAX_DEPTH_HOPS = 32`, so for any limit ≥ 33 the check `32 + 1 > max` is false: cycles and chains of any length pass the guard. So D2's "so any configured limit refuses it" is false for limits ≥ 33. CONFIG_REFERENCE's "counts as the maximum depth" promises a refusal that does not happen. Non-safe integers also render as `1e+21` in the D5/A1 texts; the verify block uses `Number.isSafeInteger` for this reason (`:865-866`). The fix needs an orchestrator decision. Either (a) bound the limit at `MAX_DEPTH_HOPS` (32) and amend §1.4 and the 1.1 test list (`100` accepted → `32` accepted, `33` rejected), or (b) amend D2 so a cycle or overlong chain always refuses (for example depth `Infinity`) and reword the doc sentence. Either way, require a safe integer. | `b106dd3` |
| QA-1.1-2 | major | `src/router/config.ts:906-926, 1059` | **1.1.1.b not implemented:** `__proto__`/`constructor` keys in `enforcement`/`enforcement.escalate` are not rejected "the way the existing validation does" (verify, `:775-781`). Probe: `validateConfig` accepts `JSON.parse('{"enforcement":{"__proto__":{"maxDelegationDepth":null},"escalate":{"__proto__":{"effortBump":false}}}}')`. The snapshot copy keeps the own `__proto__` data property, and a later `Object.assign({}, cfg.enforcement)` reparents through it: `resolveDepthLimit` → `null` (guard off) and `resolveEffortBump` → `enabled: false`. The same input under `verify` throws `must not contain the key "__proto__"`. Today this is latent: `loadConfig`'s `deepMerge` strips these keys from override layers, the bundled file has none, and no `src` code `Object.assign`s these objects. The `__proto__` test (`test:234-247`) passes through `deepMerge` alone, so it does not prove 1.1.1.b. Add the rejection (including `prototype`, as verify does) and a direct `validateConfig` test. | `6bfd03f` |
| QA-1.1-3 | minor | `src/router/config.ts:751, 915, 923` | **`(got '${String(v)}')` is not total, typed or bounded.** (a) `String` throws `TypeError: Cannot convert object to primitive value` for JSON-reachable `{"maxDelegationDepth":{"toString":1}}`, as probed, and for null-prototype objects. The layer is still dropped without bricking, but the warning names neither the key nor the value, which contradicts §1.2. (b) The output is ambiguous: `"2"`, `new Number(2)` and `2n` all print `'2'`, `-0` prints `'0'`, `[]` and `""` both print `''`, and `"true"` looks like `true`. The tests pin this output (`test:84-88, 99-101, 109-111`). (c) The output is unbounded: a 5 000-character `effortBumpMax` gave a 5 096-character message, which `loadConfig` logs twice (`:1242-1244`, `:1255-1257`). Nothing secret is echoed; the value is the user's own config. Suggest a `describeValue()` helper that wraps conversion in try/catch, renders strings with `JSON.stringify` and labels other types, and truncates to about 80 characters. Add tests. | `14c0ddd` |
| QA-1.1-4 | minor | `src/router/config.ts:721-732, 737-741, 907-912` | **The snapshot guarantee only covers the leaf key** (not reachable from tiers.json or overrides, which only create data properties). (a) `key in obj` consults a Proxy's `has` trap. A Proxy that hides `maxDelegationDepth` keeps its getter in the copy. Probe: the getter returned `2` during validation, then `resolveDepthLimit` returned `-7`. (b) Container accessors are read several times. A root `enforcement` getter, or an `escalate` getter, that returns `undefined` on its first read skips validation, and the copy keeps the getter. Probe: `resolveDepthLimit` → `-5` and `resolveEffortBump` → `{enabled:"yes", max:"ultra"}`. Fix: read each container once into a local, snapshot it whenever it is present in the descriptors (`Object.hasOwn(descriptors, key) \|\| key in obj`), and test both cases. | `486cf2e` |
| QA-1.1-5 | minor | `src/router/config.ts:1099-1100, 926, 721-732` | **The copy has undocumented side effects on unrelated keys** (none reachable from JSON). `validateConfig` now returns a fresh object whenever `enforcement` exists, which is always true for the bundled file. (a) Inherited root properties are dropped only when `enforcement` is present. Probe: a prototype carrying `rules`/`defaultTier` gives `undefined` with `enforcement` and the values without it. (b) `escalate: []`, which the existing validation accepts, becomes `{length: 0}`. (c) A frozen input gives an extensible copy: the copied properties are read-only but `enforcement` is writable. State the contract in the JSDoc ("returns a copy when `enforcement` is present"). Preserve the prototype (`Object.create(Object.getPrototypeOf(obj))`), or reject a non-plain `escalate`. Add a test. | `87af99f` |
| QA-1.1-6 | minor | `test/unit/config-depth-effort.test.ts:33-54, 197-232` | **Missing cases:** <br>• Two-layer merge order for the new keys: global `effortBump:false` with project `effortBumpMax:"high"` keeps both, and a project depth overrides the global one. Only the global layer is exercised now. <br>• A bad *project* layer over a good global layer: the fallback keeps the global layer. <br>• A state file with `enforcementMode` keeps the depth and bump snapshots through the spread at `config.ts:1279`. <br>• The QA-1.1-3 and QA-1.1-4 inputs. <br>• `withOverrideFile` creates its temp root under the repo cwd (`test:35`), which is not git-ignored, so a killed run leaves an untracked `.depth-effort-*`. | `d190f5b` (adversarial cases: `14c0ddd`, `486cf2e`) |
| QA-1.1-7 | minor | `docs/CONFIG_REFERENCE.md:518-520` | **"Claude tiers may reach `xhigh`" is true only for the default.** `buildAgentOptions` passes every level, including `max`, through unchanged for Claude (`src/router/agent-options.ts:137-146`). So M3's Claude ceiling is `max`, and with `effortBumpMax: "max"` a Claude tier reaches `max`. The text repeats D7, which is written for the default. Reword, for example "Claude tiers may reach `effortBumpMax` (default `xhigh`)". | `86311a9` |
| QA-1.1-8 | minor | `docs/CONFIG_REFERENCE.md:176-177, 978-1028` | **The reference is incomplete where it enumerates defaults and effects.** (a) The "Shipped value \| Applied by" table and the "not shipped" paragraph omit the three keys. They are neither shipped nor unread; they are code defaults applied by `resolveDepthLimit`/`resolveEffortBump`. (b) The "Changing `mode` to `enforced`" list omits "the depth guard refuses dispatches past `maxDelegationDepth`". (c) "To enforce the limit, set `enforcement.mode: "enforced"`" ignores `perTier[<caller tier>]`, which takes precedence over `mode` (`:161`, `:597`, A1): a `perTier` `"advisory"` entry keeps that tier's delegates warn-only. This may be closed by moving it into the 3.1 handoff if the orchestrator agrees. | `6aa8c74` |
| QA-1.1-9 | nit | `docs/CONFIG_REFERENCE.md:169-170, 179-180` | "fails open with one warning" should read "one warning per caller session" (D2). "only orchestrators may dispatch" states the enforced meaning without the advisory qualifier in the same sentence; the next paragraph qualifies it. | `bd89c95` |

### Round 2

This round re-reviews the round-1 fixes in `18bea52..5fdc887`:
- the fix commits `b106dd3`, `6bfd03f`, `14c0ddd`, `486cf2e`, `87af99f`, `d190f5b`, `86311a9`, `6aa8c74` and `bd89c95`;
- the resolution record `5fdc887`.

The changes cover `src/router/config.ts`, `test/unit/config-depth-effort.test.ts` and
`docs/CONFIG_REFERENCE.md`. Reviewer: adversarial senior QA (`[tier:heavy]`, CAP:none).

Checks at `5fdc887`:
- `npm run typecheck`: clean.
- Scoped run, same command as the pre-flight: **5 files, 276 tests passed** on win32.
- After the run, `git status` was clean and `%TEMP%` held no `depth-effort-*` directory.
- Runtime probes were read-only and wrote no files. They used Node 24.21 type stripping and a resolve
  hook. For the round-1 comparison, a load hook served `git show e0742fe:src/router/config.ts` from memory.

**Round-1 findings**

| id | status | evidence |
|---|---|---|
| QA-1.1-1 | **Resolved** in code and reference. The plan amendment is not recorded (QA-1.1-R2-1). | `config.ts:724`: `MAX_DELEGATION_DEPTH_LIMIT = 32`. `:789-791`: `Number.isSafeInteger` and the range 1–32. The tests accept `32` and reject `33`, `100`, `1e300` and `2**53+2`. For every limit ≤ 32, a chain counted as 32 gives `32 + 1 > max`, so D2's "any configured limit refuses it" now holds. `CONFIG_REFERENCE.md:159, 184-186, 615` match the code. |
| QA-1.1-2 | **Resolved** | `rejectPrototypeKeys` (`:768-774`) is now also the helper `verify` uses (`:818`), and the message is unchanged. It runs on `enforcement` (`:783`) and `escalate` (`:951`) and covers `__proto__`, `constructor` and `prototype`. The direct `validateConfig` tests use own keys parsed by `JSON.parse`. Through `loadConfig`, `deepMerge` still strips `__proto__` and `constructor`. Probe: an override's `prototype` in `enforcement` or `escalate` is now rejected and the layer dropped, just as `enforcement.verify.prototype` already was. |
| QA-1.1-3 | **Resolved**, with a nit (QA-1.1-R2-3) | `describeValue` (`:727-743`) never threw on the probed inputs (results below), and every result was ≤ 80 characters. JSON-reachable `{"toString":1}` → `object {"toString":1}`. Null-prototype objects are covered. Circular objects and throwing `toJSON` → `<object>`, without leaking the error text. A revoked Proxy → `<object>`. A `toJSON` that returns `undefined` → `object <unserializable>`. `"a\nb"` is escaped. These pairs are now distinguishable: `-0`/`0`, `2n`/`2`, `new Number(2)`/`2`, `[]`/`""`, `"true"`/`true`. |
| QA-1.1-4 | **Resolved** for the stated cases. A further Proxy variant regressed (QA-1.1-R2-2). | Each parent is read once into a local (`:943`, `:1135`) and snapshotted even when that read returned `undefined`. `Object.hasOwn(descriptors, key)` (`:753`) defeats a Proxy whose `has` trap hides a key. The tests pin `reads === 1` and check that the copy holds no getter. |
| QA-1.1-5 | **Resolved** | `:759-763` keep the prototype, array identity and frozenness. The JSDoc states the contract (`:1106-1108`). Probes for configs without the new keys: with no `enforcement`, the input is returned by identity; `enforcement` with no new key and no `escalate` → identity; `escalate` with no new key → identity; key order is unchanged. An inherited root `enforcement` resolves (depth 3) and the prototype is kept. Sealed or non-extensible inputs that are not frozen still give an extensible copy. That is no finding: the JSDoc promises only frozenness, and no `src` caller seals a config (the only `validateConfig` callers are in `config.ts`). |
| QA-1.1-6 | **Resolved** | New tests: (1) two layers merge: a global `effortBump:false` plus a project `effortBumpMax:"high"` keep both, and the project depth `3` wins; (2) a bad project layer over a good global layer keeps the global layer, and the warning names the project path; (3) the state-file `enforcementMode` spread keeps the snapshots as own data properties; (4) the QA-1.1-3 and QA-1.1-4 inputs. Windows temp-dir handling: (a) the temp root is `mkdtempSync(join(tmpdir(), "depth-effort-"))`; (b) it is removed in `afterEach`, after the `finally` has restored the cwd, so Windows can delete it; (c) `project/.git` stops the `findProjectOverride` walk at the temp project; (d) `USERPROFILE` is stubbed alongside `HOME`, so `homedir()` follows on win32. |
| QA-1.1-7 | **Resolved** | `CONFIG_REFERENCE.md:523-526`. |
| QA-1.1-8 | **Resolved**, with a nit (QA-1.1-R2-4) | (a) `:987-989` and `:1017-1019`. `tiers.json` ships none of the three keys (grep), and the defaults live in `config.ts:1366-1378`. (b) `:1031-1032`. The bump bullet (`:1037-1039`) agrees with D7/D8: the same attempt and cost limits, and the ladder acts only in `enforced`. (c) `:178-180` matches `resolveEnforcementMode` (`enforcement.ts:21-46`) for an unset, empty or `1` gate; see R2-4. |
| QA-1.1-9 | **Resolved** | `:169-171`, `:184`. |

**New findings**

| id | severity | file:line | description | resolution |
|---|---|---|---|---|
| QA-1.1-R2-1 | minor | plan `:359`, `:860`, `:880`, `:894`; this report `:67` | **The 32 cap is an unrecorded deviation from the plan.** `b106dd3` implements the orchestrator's decision (`maxDelegationDepth` ≤ 32 = `MAX_DEPTH_HOPS`, safe integer), but the plan text still says otherwise: <br>• §1.4 (`:359`) still says "integer ≥ 1, or `null`"; <br>• 1.1.1.b (`:860`) still says "integer ≥ 1 (`Number.isInteger`)"; <br>• the 1.1 test list (`:880`) still says "`1`, `2` and `100` accepted", while the test now rejects `100` (`["old unbounded limit", 100, "100"]`); <br>• the 1.1 acceptance (`:894`) requires validation "exactly as in §1.4". <br>This report says "**Amended during implementation:** none recorded" (`:67`). The plan has not changed on `de/p11` or `de/main` since `c11e7a8`. §0.7 (`:182`) requires an approved deviation to be recorded under `## Implementation notes` and marked *Amended during implementation*, and the plan is orchestrator-owned (`:729`). Until it is recorded, the 1.1 acceptance cannot be ticked against the plan. Fix: record the amendment in this report's Implementation notes and in the `de/main` plan's §1.4 row, 1.1.1.b and 1.1 test list. | plan §1.7 A13 on de/main (orchestrator) |
| QA-1.1-R2-2 | minor | `src/router/config.ts:752-758` (and `:1142`) | **A key served only by a Proxy `get` trap now leaks the unvalidated input. This regresses from round 1** (not reachable from JSON; same class as QA-1.1-4). `withValidatedSnapshots` snapshots a key only if it is an own descriptor or passes `key in obj`. Since `87af99f` it also returns the input itself when nothing was snapshotted (`if (!changed) return obj`). So a Proxy that answers `get` but hides the key from both `ownKeys` and `has` is validated through `get`, then returned unchanged. Probe 1: an `enforcement` Proxy whose getter yields `2`, then `-7`. `resolveDepthLimit` returns `-7` at `HEAD` but `1` at `e0742fe`, where the copy dropped the virtual key. Probe 2: a root Proxy serving `enforcement` only through `get`, first `{maxDelegationDepth: 2}` and then `{maxDelegationDepth: -5, escalate: {effortBump: "yes", effortBumpMax: "ultra"}}`. `validateConfig` returns the input Proxy; `resolveDepthLimit` → `-5` and `resolveEffortBump` → `{enabled: "yes", max: "ultra"}`. The round-1 recommendation (own-or-`in`) missed this case. Fix: also snapshot when the validated value is defined (`value !== undefined \|\| Object.hasOwn(descriptors, key) \|\| key in obj`), and add both probes to the Proxy test. | `2e35d8d` |
| QA-1.1-R2-3 | nit | `src/router/config.ts:742` | **Truncation can split a surrogate pair.** `description.slice(0, 79)` cuts at a UTF-16 code unit, so a JSON-reachable string can leave a lone high surrogate before `…`. Probe: `effortBumpMax: "a" + "😀".repeat(100)` gives a description that ends in `\ud83d` followed by `…`, and `isWellFormed()` is `false`, so the warning prints U+FFFD. Fix: drop a trailing high surrogate before appending `…` (or slice by code points), and add the case to the `describeValue` test. | `e21aa24` |
| QA-1.1-R2-4 | nit | `docs/CONFIG_REFERENCE.md:178-180` (pre-existing `:161`, `:604`); `src/router/enforcement.ts:29-46` | **The `perTier` precedence condition is incomplete.** The new sentence says a `perTier` entry overrides `mode` "when the env gate is unset/empty". `resolveEnforcementMode` also applies `perTier[tier]` when the gate holds any value other than `1` or `0`: it warns, then runs the same config path (`enforcement.ts:29-46`). The sentence copies the pre-existing `:161` wording, and the truth-table row `:604` ("config `mode` (fallback)") also omits `perTier`. Fix: at `:178-179`, say "overrides `mode` unless the env gate is `1` or `0`". Align `:161` and `:604` in the same commit, or hand them to 3.1. | `f8e40bc` |

Round-2 fix verification at `f8e40bc`:
- `npx vitest run test/unit/config-depth-effort.test.ts test/unit/config.validate.test.ts test/unit/docs-drift.test.ts test/unit/config --maxWorkers=50%`: **5 files, 281 tests passed**.
- `npm run typecheck`: clean (`tsc --noEmit`, no diagnostics).
- Regression tests cover get-only Proxy leaf and root values (one read, validated depth/effort
  retained) and `"a" + "😀".repeat(100)` for all three invalid-value messages.
- No full-suite run or further QA review was performed.

Handoff added in round 2:
- **To 1.2:** `MAX_DEPTH_HOPS` (plan `:930`, `src/router/depth.ts`) must equal
  `MAX_DELEGATION_DEPTH_LIMIT` (`config.ts:724`, exported).
  - Derive one from the other, or pin them equal in a test.
  - The validation message hard-codes `1 to 32`, and the tests pin that text, so a change to the
    constant alone fails CI.

## Deferred by plan

- The depth tracker and `MAX_DEPTH_HOPS` are Phase 1.2. The guard, the banner and the D5/A1 texts are Phase 2.1.
  QA-1.1-1 is raised here because 1.1's validation, or D2, is where it must be decided.
- `effortCeilingFor`, ladder algebra and the `buildAgentOptions` native keys (A4) are Phase 1.3. The
  `chat.params` override is 2.2 and the v2 key translation is 2.3.
- README, CHANGELOG (A1 wording, A4 `Fixed` entry) and the ADR (D11 limits: shell-spawned `opencode`,
  other plugins' session tools; ratio-based cost of bumped attempts, §6) are Phase 3.1.
- Coverage ≥ 95 % of the new code and the post-merge capped suite belong to the implementer/orchestrator DoD.

## Handoffs

- **To 1.3: `resolveEffortBump` API.** The signature is `resolveEffortBump(cfg: RouterConfig): { enabled: boolean; max: EffortLevel }`
  (`src/router/config.ts:1330`).
  - It is pure and returns a fresh object on each call. The defaults `true`/`"xhigh"` live only here: do not
    re-apply `?? "xhigh"` in the ladder.
  - `bound = min(effortCeilingFor(tier), max)`. Values are validated only on the `loadConfig`/`validateConfig`
    path. Programmatic `RouterConfig` objects are trusted by type only (QA-1.1-4).
  - Per `agent-options.ts`, the Claude ceiling is `max` (QA-1.1-7).
  - The `config.ts:37-43` comment already says `reasoningEffort`. 1.3.2b (A4) must make
    `buildAgentOptions` match, and `CONFIG_REFERENCE.md:680` (`options.reasoning_effort`) must follow.
- **To 1.2 / 2.1: `resolveDepthLimit(cfg): number | null`** (`:1324`). `null` means disabled.
  - Read it per call (live config). Resolve QA-1.1-1 before the 2.1 truth table, which tests limits
    {null, 1, 2, 32} and none above 32.
  - The state-file `enforcementMode` is not validated (`config.ts:1278-1280` → `enforcement.ts:36`, pre-existing).
    The depth guard must treat an unrecognised mode safely.
- **To 3.1: CONFIG_REFERENCE final pass.** Cover QA-1.1-8 if it is deferred, the D11 limits, the
  `perTier` interaction, the `reasoning_effort` → `reasoningEffort` row (A4), and the A1 wording in the
  README and CHANGELOG.

## Verdict

Open findings: 0 (every round-1 and round-2 finding fixed)
