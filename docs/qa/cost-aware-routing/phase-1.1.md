# Phase 1.1 — Configuration surface (M1) (cost-aware routing engine, #74)

> Worktree `D:\git\omr-car-p11` (branch `car/p11`, from `car/main` @ `3b3dba4`). Base directory `D:\git\opencode-model-router`.
> Write-set (plan §2): `src\router\config.ts`, `src\router\build-info.ts` (new), `docs\CONFIG_REFERENCE.md`, `test\unit\config.routing.test.ts` (new), `test\unit\config.validate.test.ts` (append only), this report, and the single `/router` line in `src\index.ts`.

## Pre-flight

| Item | Result |
|---|---|
| Worktree / branch | `D:\git\omr-car-p11`, `car/p11`, clean at start (`git status --short` empty), based on `car/main` @ `3b3dba4` |
| Build step (1.1.6) | **none**: `package.json` scripts are `test`, `test:watch`, `test:coverage`, `smoke*`, `typecheck`. The runtime `.git` read in `src\router\build-info.ts` is the only sha source |
| Phase 0.P handoffs to 1.1 | (a) global-override hot reload proven by `config.routing.test.ts` › "hot reload of the global override file with a routing block" (HOME redirected **and `os.homedir()` mocked**, see QA-1.1-1, to a temp dir, no explicit invalidate, mtime bumped like a real edit; also through the `/router` command); (b) runtime `.git` read only; (c) `routing.classifier = { backend: "host", model: "opencode-go/deepseek-v4.1-flash", timeoutMs: 10000 }` accepted (validate test and override-layer test) |
| Full-suite baseline | `car/main` @ `3b3dba4`: `Test Files 109 passed \| 3 skipped`. **Not re-run here** (phase instruction: scoped runs only) |

### Results (all run in `D:\git\omr-car-p11`)

| Command | Result |
|---|---|
| `npm run typecheck` | exit 0 (run before every commit and at the end) |
| `npx vitest run test/unit/config.routing.test.ts test/unit/config.validate.test.ts test/unit/protocol.test.ts` | `Test Files 3 passed (3)`, `Tests 425 passed (425)` |
| `config.routing.test.ts` alone | `Tests 101 passed (101)` |
| `config.validate.test.ts` alone | `Tests 269 passed (269)` (existing cases untouched, append only) |
| the five `test/unit/config*.test.ts` files + `protocol.test.ts` + `test/integration/router-command.test.ts`, named explicitly | `Test Files 7 passed (7)`, `Tests 673 passed (673)` |
| `npx vitest related src/router/config.ts src/router/build-info.ts --run` | `Test Files 1 failed \| 67 passed \| 3 skipped (71)`, `Tests 1 failed \| 7246 passed \| 55 skipped (7302)`, 120 s. The one failure is `test/unit/v2-client.test.ts` › "drives the shared verified-delegate path through native producer and grader children": **`Test timed out in 5000ms`** (it took 5007 ms) under the 8-worker load of that run. Re-run alone, twice: `19 passed (19)`, 1.7 s each. Treated as a load-induced timeout of an unrelated file (nothing in it touches the new code paths); it was **not** re-checked against the `car/main` baseline under the same load, so "pre-existing flake" is not proven |

Note for whoever runs the scoped suite: `npx vitest run test/unit/config*.test.ts` passes the glob to vitest as a *substring filter*, not a glob, so under `pwsh` it matches nothing (only the other two files I had named explicitly ran). The config tests were run by explicit file list.

## Implementation notes

Commits on `car/p11` (all `Refs #74`, pushed after each):

1. `feat(routing): add routing, candidates and variantSteps config types` — 1.1.1.
2. `feat(routing): validate routing, tier candidates and variantSteps` — 1.1.2 (+ the validation tests, appended to `config.validate.test.ts`).
3. `feat(routing): add resolveRouting, resolveCandidates and host-aware defaults` — 1.1.3, 1.1.7.
4. `feat(routing): add build marker and the /router engine/build line` — 1.1.6, plus `test/unit/config.routing.test.ts` (resolver, hot-reload, `/router` and build-info tests; it imports `build-info`, so the file landed with that module rather than one commit earlier).
5. `docs(routing): document routing, candidates and variantSteps` — 1.1.5 (+ the docs-drift tests appended to `config.routing.test.ts`).

Decisions (the first is a deviation from the plan's wording; the rest are choices the plan leaves open):

- **Unknown keys inside `routing`: ignored, not rejected** — *Amended during implementation.* The plan's test paragraph says "rejected (consistent with the file's existing policy — check and match)". Checked: the file's policy is the opposite. `validateModelGenerations` says outright "Unknown keys … are ignored rather than rejected, so an existing tiers.json carrying one still loads"; `validateEnforcement` and its `verify`/`escalate`/`guard` sub-blocks check only known keys; the sole rejected keys are the prototype ones (`rejectPrototypeKeys`: `__proto__`, `constructor`, `prototype`). I matched that: unknown keys are ignored (and dropped from the validated snapshot); prototype keys are rejected at every level of `routing`, `classifier`, `roles`, `detection`, `outcomes`, `sessionReuse`, `advisor`, `classifier.presets.*` and each candidate. Tests pin both halves. Documented.
- **`validateConfig` returns a snapshot of `routing`** (read-once, known keys only), via the existing `withValidatedSnapshots`, exactly like `enforcement`. No `routing` block ⇒ `withValidatedSnapshots` returns the very same object (tested with `toBe`), so D2 holds byte for byte. A getter that changes between check and use cannot slip a value past validation (tested).
- **`EscalateConfig`** is a new named interface extracted from the inline `escalate?: {…}` type, with identical fields plus `variantSteps` (the plan names `EscalateConfig`; none existed).
- **Section order in `validateConfig`**: `validateRouting` runs last, so every pre-existing config reports the same first error it always did. `variantSteps` is checked at the end of the `escalate` block's effort checks.
- **Classifier rule (D3) is checked on the effective values**, not only the top level: for the top level and for each `classifier.presets.<name>` merged over it, a backend other than `rules` needs a non-empty `provider/model[#variant]`, and `openai-compatible`/`typesafe` also need an `http(s)` `baseUrl`. `baseUrl` is validated whenever set (any backend); `apiKeyEnv` must be null or an env-var name; `timeoutMs` and `maxStateChars` are *integers* (the plan gives only ranges); `samples` is `1 | 3`; `#variant` must be non-empty without whitespace or `#`. The preset name in `classifier.presets` need not exist (same reasoning as `subagentTiers`).
- **`roles`**: class names and agent ids both match `^[a-z0-9_-]+$` (plan 1.1.2 gives the pattern for agent ids; applying it to class names is mine). Empty string, uppercase, space or non-string ids are rejected; every class needs a non-empty array. A `roles` key **replaces the default as a whole** (no per-class merge — otherwise `{}` could not disable). Duplicates within a class are accepted by validation and dropped, order kept, by `resolveRouting`.
- **`candidates`**: `model` inherits the tier's; **`variant` is not inherited** (omitted = the model's default variant, A9); `costRatio` inherits the tier's, or the conventional default of `fast`/`medium`/`heavy` (the same `TIER_DEFAULTS` `applyTierDefaults` uses) when the tier has none yet. `candidates: []` is treated as absent. The tier's own rung is **not** added automatically: the list is the whole ladder. Duplicate detection is on the *effective* `(model, variant)` after inheritance, and two variant-less rungs of one model count as the same rung.
- **`resolveRouting(cfg, host, logger?)`**: pure apart from one module flag. The `routing.engine ignored on OpenCode v1` line is emitted at most once per process, only when the file asks for a non-`static` engine on v1. With a `logger` it goes through `logger.warn("routing.engine ignored on OpenCode v1")` (whose console fallback adds `[model-router] `); without one it is `console.warn("[model-router] routing.engine ignored on OpenCode v1")`. `resetRoutingWarnings()` re-arms it for tests (same pattern as `resetVerifyBudgetWarnings`). The result carries an `applied` block (`host`, `requestedEngine`, `engineCoerced`, `rolesSource: configured | default | none`) so `/router` can show what was applied.
- **Extra exports beyond the brief**, because the validator and the later phases need the same logic: `resolveVariantSteps(cfg, host)` (v1 ⇒ `none`, v2 ⇒ configured or `auto`), `resolveClassifierForPreset(classifier, presetName)` (per-preset `backend`/`model` merge, exact preset-name match), `ROUTING_DEFAULTS`, `DEFAULT_V2_ROLES`, `ROUTING_ENGINE_IGNORED_ON_V1`, the enum arrays/types, `RouterHost`.
- **`build-info.ts`**: `sha` is the full commit id (40 or 64 hex, lower-cased), `"unknown"` otherwise; the `/router` line shows the first 7 digits (or `unknown`). Resolution handles `.git` as a directory, as a **file** with an absolute or relative `gitdir:` (linked worktree, submodule), the worktree's `commondir`, a detached `HEAD`, loose refs and `packed-refs` (comments and peeled `^` lines skipped). It never throws; each catch returns `"unknown"` and is commented — there is no plugin logger at module load, so these degrade silently by design (the marker is informational). Verified against reality: in this worktree `.git` is a file, and `buildInfo.sha` equals `git rev-parse HEAD` (test, skipped when git is unavailable).
- **`/router` line**: added to the bare status view only (`sub === ""`), appended right after the help text and before the catalog "Model issues" block: `router: engine=<applied engine> build=<version>+<sha7>`. The engine shown is `resolveRouting(cfg, host).engine`, so on v1 it is always `static`; the host is `ctx.routerHost === "v2" ? "v2" : "v1"`. `src/index.ts` diff: `resolveRouting` added to the existing `./router/config` import, one new `import { formatRouterLine } from "./router/build-info"`, and the one `text += …` line. Nothing else. `/router overrides`, `/router enforce` and `/router models` are unchanged (tested: no marker there).
- **Docs**: the `routing` section opens with a status note (the engine lands later in the release; Phase 3.1 removes it). The defaults block and the five examples are machine-checked by tests (defaults against `resolveRouting(…, "v2")`, every example through `validateConfig`, every defaulted key present in the keys table). Rows were also added to the top-level optional-keys table, the `escalate` table and "Validation rules".
- Files **not** touched: `package.json`, the lockfile, `tiers.json`, every other source file, other worktrees, the base checkout, `C:\Users\Marquinho\.config`.

## Findings

| Id | Sev. | Where | Finding | Resolution |
|---|---|---|---|---|
| QA-1.1-1 | critical | `test/unit/config.routing.test.ts` hot-reload tests | The tests redirected only `process.env.HOME`/`USERPROFILE`. Under `--pool=threads` an env change does not reach `os.homedir()`, which `config.ts` uses for `overridePath()`/`statePath()`, so the tests wrote the user's REAL global override file `~/.config/opencode/opencode-model-router.overrides.jsonc` (`{"routing":{"engine":"enforce"}}`), which drives the live router config. The orchestrator deleted the file | `fix(routing): address QA-1.1-1 isolate tests from the real home directory`: `node:os` `homedir` is mocked at module level (`vi.mock` + `vi.hoisted`), the env redirect is kept, the temp home is created in a **file-level** `beforeEach`, and a guard in that hook throws before any test body unless `os.homedir()`, `overridePath()` and `statePath()` are inside the temp home (`editOverride` re-asserts before each write). `config.ts` unchanged. Verified under `--pool=threads` and `--pool=forks`: the real override file stays absent and the real state file's `LastWriteTime` stays `2026-10-05 08:47:03` |

**Pre-existing tests with the same weakness (not fixed here: outside this phase's write-set).** They redirect `HOME`/`USERPROFILE` only (none mocks `node:os` `homedir`) and then write through `config.ts`; under `--pool=threads` each of these writes the real files (heuristic grep; a test that reaches `writeState` through a command spelled differently would be missed):

- `test/unit/config.overrides.test.ts`: `overridePath()` writes at 189, 213, 255 (and others); `writeState` at 303.
- `test/integration/router-command.test.ts`: `/router enforce enforced|off` (state write) at 45, 54, 58.
- `test/integration/fable-effort-preset.test.ts`: `writeState` at 47, 94.
- `test/integration/prompt-style-mixed.test.ts`: `writeState` at 79, 102, 143, 171, 182.
- `test/integration/ladder-wiring.test.ts`: `overridePath()` writes at 210–211, 285.
- `test/integration/router-reload-failure.test.ts`: `overridePath()` write at 58.

Tests that build the path from their own temp dir (`join(home, ".config/opencode/…")`: `deferred-verification`, `delegate-timeout`, `router-verify-tool`, `e2e/harness`) cannot write the real home, but under threads `loadConfig` would read the real one instead of theirs. Under the default pool (forks) none of this applies. **Do not run those files with `--pool=threads`.**

Adversarial QA by `@heavy` has not run beyond the above. Points I would challenge myself (candidates for the reviewer, not findings):

1. **Agent-id pattern `^[a-z0-9_-]+$`** is the plan's, but `subagentTiers` already documents a user agent named `ContextScout`; such an agent cannot be listed in `routing.roles`. Followed the plan; a case-insensitive pattern may be wanted.
2. **Unknown keys are ignored** (deviation above): a typo such as `routing.margn` loads silently. Consistent with the file; the alternative would make one typo drop a whole override layer.
3. **`margin: 0.9` with `profile: safe`** (the plan's example of a possibly dangerous pair) is accepted: with `margin` ≤ 0.9 the rule `C(best) ≤ (1 − margin)·C(chosen)` stays well defined (factor ≥ 0.1). No downstream consumer exists yet to crash.
4. **`detection` is not required to be monotonic** (`deterministic ≥ grader ≥ none`); only each value's range is checked.
5. **`candidates` need not contain the tier's own `(model, variant)`**, so a ladder may omit the static choice; the engine phase (1.4) must decide what that means for the degenerate case (D2).
6. **The v1 notice is once per process**, not once per config change; a hot reload that changes the engine on v1 does not log again.
7. **`/router` marker only on the bare status view**; a liveness probe that runs `/router overrides` would not see it.
8. The `vitest related` timeout above was not compared with the baseline under load.

## Deferred by plan

- Wiring `resolveRouting` into the engine, protocol and v2 hooks → Phases 1.4, 2.2.
- The v1 text-only `R:` line listing `routing.roles` agents (D1) → Phase 1.4/2.2 (`src\router\protocol.ts` is not in this write-set); this phase only resolves the value.
- Advisor findings, `/router stats`, richer `/router` output → Phase 2.4 (owns `src\index.ts` commands from then on).
- Reading `outcomes.*`, `sessionReuse.*`, `advisor.*`, `classifier.*` → Phases 1.2, 1.3, 1.5, 2.1–2.4.
- Removing the docs status note and polishing the section → Phase 3.1.

## Handoffs

- **to 1.2** — `resolveRouting(cfg, host).classifier` (`ResolvedClassifier`) and `resolveClassifierForPreset(classifier, activePresetName)` give the effective `backend`/`model`/`baseUrl`/`apiKeyEnv`/`timeoutMs`/`samples`/`maxStateChars`; validation already guarantees a model for any non-`rules` backend and an `http(s)` `baseUrl` for the two HTTP backends. `classifier.model` is validated as a plain `provider/model[#variant]` string only (existence in the catalog is not checked here).
- **to 1.3** — `resolveRouting(...).outcomes` (`path: string | null`, `null` = the scorecard directory of D15, which this phase does not resolve).
- **to 1.4** — D2: with no `routing` block `resolveRouting` equals the documented defaults on both hosts (tested against a literal snapshot and against the shipped `tiers.json`); `resolveCandidates(tier, cfg)` is the ladder source; `ResolvedRouting.roles` is already de-duplicated and frozen; `applied.rolesSource` tells `configured | default | none`; the v1 text-only roles line must read `roles` only when `applied.rolesSource === "configured"`.
- **to 1.5** — `resolveVariantSteps(cfg, host)` returns the effective `auto | none` (always `none` on v1).
- **to 2.2 / 2.4** — `src\index.ts` `/router` handler already prints the marker; call `resolveRouting(cfg, host, logger)` with the plugin logger so the v1 notice goes through it. Hot reload needs nothing new: `loadConfig` re-reads the global and project override layers by fingerprint and a bad edit keeps the last valid config.
- **to the checkpoints (§0.11)** — the liveness probe is the line `router: engine=<mode> build=<version>+<sha7>` in the bare `/router` output; `<sha7>` is the first 7 digits of `git rev-parse HEAD` of the plugin checkout, read once at module load (a restart is needed to refresh it, A8).
- **to 3.1** — drop the "Status" note of the `routing` section; keep the machine-checked defaults block.

## Verdict

Implementation complete and green on the scoped suites and typecheck (see Pre-flight); one unrelated timeout under load recorded there. **Adversarial QA has not run: the verdict and the "open findings" count are the reviewer's to set.**
