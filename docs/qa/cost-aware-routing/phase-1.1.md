# Phase 1.1 — Configuration surface (M1) (cost-aware routing engine, #74)

> Worktree `D:\git\omr-car-p11` (branch `car/p11`, from `car/main` @ `3b3dba4`). Base directory `D:\git\opencode-model-router`.
> Write-set (plan §2), extended for QA round 1: `src\router\config.ts`, `src\router\build-info.ts` (new), `docs\CONFIG_REFERENCE.md`, `test\unit\config.routing.test.ts` (new), `test\unit\config.validate.test.ts` (append only), `test\setup\home-guard.ts` (new) + the `setupFiles` entry of `vitest.config.ts`, this report, and in `src\index.ts` only the `/router` status statement, the `resolveRouting`/`routerStatusLines` names in the existing config import, and one init-time `resolveRouting` call.

## Pre-flight

| Item | Result |
|---|---|
| Worktree / branch | `D:\git\omr-car-p11`, `car/p11`, clean at start (`git status --short` empty), based on `car/main` @ `3b3dba4` |
| Build step (1.1.6) | **none**: `package.json` scripts are `test`, `test:watch`, `test:coverage`, `smoke*`, `typecheck`. The runtime `.git` read in `src\router\build-info.ts` is the only sha source |
| Phase 0.P handoffs to 1.1 | (a) global-override hot reload proven by `config.routing.test.ts` › "hot reload of the global override file with a routing block" (HOME redirected to a temp dir, no explicit invalidate, mtime bumped like a real edit; also through the `/router` command; `os.homedir()` is mocked for every test file by the global home guard, QA-1.1-17); (b) runtime `.git` read only; (c) `routing.classifier = { backend: "host", model: "opencode-go/deepseek-v4.1-flash", timeoutMs: 10000 }` accepted (validate test and override-layer test) |
| Full-suite baseline | `car/main` @ `3b3dba4`: `Test Files 109 passed \| 3 skipped`. **Not re-run here** (phase instruction: scoped runs only) |
| Plan amendments in force (round 1) | A14 (never `--pool=threads`; global home guard), A15 (`variantSteps` default), A16 (strict margin), A18 (project layer may not set classifier/outcome sinks). Read from `car/main:docs/plans/cost-aware-routing-engine-plan.md` |

### Results (final, all in `D:\git\omr-car-p11`, default pool unless stated; `--pool=threads` never used)

| Command | Result |
|---|---|
| `npm run typecheck` | exit 0 (run before every commit and at the end) |
| `npx vitest run test/unit/config.routing.test.ts test/unit/config.validate.test.ts test/unit/protocol.test.ts` | `Test Files 3 passed (3)`, `Tests 515 passed (515)` (`config.routing` 147, `config.validate` 313 — existing cases untouched, appended only) |
| the five `test/unit/config*.test.ts` + `protocol.test.ts` + the five other audited files (`router-command`, `fable-effort-preset`, `prompt-style-mixed`, `ladder-wiring`, `router-reload-failure`) = 11 files, named explicitly | default pool: `Test Files 11 passed (11)`, `Tests 785 passed (785)`; `--pool=forks`: identical |
| the 22 test files that redirect `HOME`/`USERPROFILE` | `Test Files 22 passed (22)`, `Tests 504 passed (504)` |
| `npx vitest related src/router/config.ts src/router/build-info.ts src/index.ts --run` | `Test Files 68 passed \| 3 skipped (71)`, `Tests 7337 passed \| 55 skipped (7392)`, 119 s. (The round-0 run had one timeout in `test/unit/v2-client.test.ts` under load; it passed alone twice and did not recur in the two later `related` runs) |
| Real-home check, before and after each run above | `C:\Users\Marquinho\.config\opencode\opencode-model-router.overrides.jsonc` does not exist; `opencode-model-router.state.json` `LastWriteTime` unchanged at `2026-10-05 08:47:03` (metadata only; contents never read) |

**Coverage (QA-1.1-21)**, `vitest --coverage` scoped to the two source files (the repo threshold is 90 % branches for `src/router/**` over the whole suite):

| Test files run | `config.ts` stmts / branches / funcs / lines | `build-info.ts` stmts / branches / funcs / lines |
|---|---|---|
| the two named files (`config.routing` + `config.validate`) | 88.15 / **85.68** / 92.59 / 88.72 | 100 / 98.03 / 100 / 100 |
| the five `config*.test.ts` files | 96.41 / **95.11** / 98.14 / 96.48 | 100 / 98.03 / 100 / 100 |

With only the two named files `config.ts` is under 90 % branches because the pre-existing `loadConfig`/state/reload machinery is exercised by `config.overrides.test.ts`, not by them. Of the 1126 lines this phase added to `config.ts` (measured against `3b3dba4`), the two named files cover every statement and leave one branch open: the defensive `isPlainObject(rawUsed)` fallback in `buildConfig` (a validated config is always an object). The other branches that were open (`getConfigNotices` of a never-loaded directory, `stripGlobalOnlyRoutingKeys` on a layer without `routing`, `resolveCandidates`' unreachable `?? []`) were covered or removed in `e01e888`; nothing else in the added code is uncovered. The last uncovered `build-info.ts` branch is the unreachable-in-practice `catch` of `readGitSha`, now reached by a non-string root.

Note for whoever runs the scoped suite: `npx vitest run test/unit/config*.test.ts` passes the glob to vitest as a *substring filter*, so under `pwsh` it matches nothing; name the files.

## Implementation notes

Commits on `car/p11` (all `Refs #74`, pushed after each). Round 0:

1. `feat(routing): add routing, candidates and variantSteps config types` — 1.1.1.
2. `feat(routing): validate routing, tier candidates and variantSteps` — 1.1.2 (+ validation tests appended to `config.validate.test.ts`).
3. `feat(routing): add resolveRouting, resolveCandidates and host-aware defaults` — 1.1.3, 1.1.7.
4. `feat(routing): add build marker and the /router engine/build line` — 1.1.6 (+ `config.routing.test.ts`; it imports `build-info`, so the file landed with that module).
5. `docs(routing): document routing, candidates and variantSteps` — 1.1.5 (+ docs-drift tests).
6. `docs(routing): add the phase 1.1 QA report …`, then `fix(routing): address QA-1.1-1 …`.

Round 1: one commit per finding group, listed in the "Round 1 fixes" table below.

Decisions as they stand after round 1 (the first is a deviation from the plan's wording; the rest are choices the plan leaves open or that round 1 changed):

- **Unknown keys inside `routing`: ignored, not rejected, but no longer silent** — *Amended during implementation.* The plan's test paragraph says "rejected". The file's actual policy is the opposite (`validateModelGenerations`: "ignored rather than rejected"; `validateEnforcement` checks only known keys); only the prototype keys are rejected (`rejectPrototypeKeys`), which I do at every level. Round 1 (QA-1.1-10) keeps ignoring them but collects their paths (`findUnknownRoutingKeys`) into config notices: one `console.warn` per config fingerprint, and one `router: config notice: …` line each under the `/router` marker.
- **Config notices** (`ConfigNotice`, `getConfigNotices(dir)`, built in `buildConfig`, kept on the cache entry, kept across a failed reload): unknown routing keys, keys dropped from the project layer (QA-1.1-2), `roles` naming a built-in agent (QA-1.1-18), `classifier.presets` keys matching no preset (QA-1.1-14). They are **not** `SourceFailure`s: a failure on reload keeps the last valid config, and a stripped key must not block the rest of a project file. Dedupe key: a notice about a file is reported once per (file, text); one about the merged config once per fingerprint (set bounded at 256).
- **Project layer trust (A18, QA-1.1-2)**: `routing.classifier.{backend,model,baseUrl,apiKeyEnv,presets}` and `routing.outcomes.path` are removed from the project-local override *before* the layers merge (`stripGlobalOnlyRoutingKeys`); the rest of that file applies.
- **`validateConfig` returns a read-once snapshot of `routing`** (known keys only) through `withValidatedSnapshots`, like `enforcement`; no `routing` block ⇒ the very same object (D2).
- **`roles`** (QA-1.1-5/6/7): classes must be one of the exported `ROUTING_TASK_CLASSES` (`search, recon, mechanical, implement, debug, design, review, other`); agent ids match `^[A-Za-z0-9][A-Za-z0-9_./-]*$`, case-sensitive; **an empty array is accepted** for a class (= no native candidates for it; a deliberate deviation from the plan's "non-empty arrays"); a `roles` key **replaces wholesale**, also across override layers (`replaceRolesWholesale`: the highest-priority layer that sets it supplies the whole map); duplicates are dropped at resolve time.
- **`candidates`** (QA-1.1-3/12): `model` and `costRatio` inherit from the tier, `variant` does not (omitted = the default variant, A9); `[]` = absent; a non-empty list **must contain the tier's own `(model, variant)`**, whose `costRatio` equals the tier's or is omitted; effective `costRatio` **must not decrease** along the list (the list is the escalation order); duplicates are detected on the effective `(model, variant)`. `hasExplicitCandidates(tier)` is exported (QA-1.1-11).
- **`resolveVariantSteps` (A15, QA-1.1-4)**: **v1 ⇒ always `none`** (D1: variant steps are ignored there, even when explicit); v2 ⇒ the explicit value if set, else `auto` when the config has a `routing` block, else `none`. **This differs from the literal formula in the round-1 brief** (`explicit ?? …`, which would return an explicit `auto` on v1): I kept D1 and §1.2 ("variantSteps is ignored" on v1) over the shorthand. Challenge point below.
- **`detection`** (QA-1.1-13): `deterministic ≥ grader ≥ none` on the *effective* values (defaults included), so `{ grader: 0.98 }` alone is rejected against the default `deterministic 0.95`.
- **`outcomes.path`** (QA-1.1-15): absolute, or a leading `~`/`~/…`/`~\…`, expanded by `resolveRouting` with `homedir()` at resolve time.
- **`classifier.presets`** (QA-1.1-14): `resolveClassifierForPreset` matches the preset like `/preset` does (exact key first, then case-insensitive and trimmed; own keys only); a key matching no preset is noticed. The D3 rule is still checked on every effective (top-level and per-preset) classifier at validation.
- **Reserved agents** (QA-1.1-18): `roles` naming `build`, `plan`, `title`, `summary` or `compaction` (`ROUTING_RESERVED_AGENTS`) is accepted — the host's agents are not known at load — but noticed; the engine must skip them.
- **`resolveRouting(cfg, host, logger?)`**: unchanged contract; the v1 "engine ignored" line is at most once per process, with a `logger` as `logger.warn("routing.engine ignored on OpenCode v1")` (the logger's console fallback adds `[model-router] `), without one as `console.warn("[model-router] routing.engine ignored on OpenCode v1")`. **The plugin now calls it once at init** (QA-1.1-8), after the logger exists, so the notice appears at startup, not at the first `/router`. `resetRoutingWarnings()` re-arms it and clears the notice set (tests).
- **`/router` (bare status view)**: `routerStatusLines(cfg, host, logger, dir)` returns the marker `router: engine=<applied engine> build=<version>+<sha7>` followed by the notice lines; the one statement in `src/index.ts` joins them. Other `/router` views are unchanged.
- **`build-info.ts`**: `sha` is the full commit id (or `unknown`); handles `.git` as a directory or a file (`gitdir:` absolute or relative; linked worktree, submodule), `commondir`, detached `HEAD`, loose refs, `packed-refs`; **`reftable` repositories (stub `HEAD`, binary tables) report `unknown`** (documented, tested, QA-1.1-20); `loadBuildInfo(root)` wraps locating the plugin root, so a non-`file:` `import.meta.url` yields `unknown`/`unknown` instead of a load-time throw. Catches return `"unknown"` and are commented (there is no logger at module load).
- **Home guard (A14, QA-1.1-1/17)**: `test/setup/home-guard.ts`, registered in `vitest.config.ts` `setupFiles`, replaces `node:os` `homedir` (named export and `default`) in every test file. It resolves the home from `process.env` in JavaScript — correct in any pool and on Windows, where `os.homedir()` ignores `HOME` — returning the value of `HOME`/`USERPROFILE` a test *changed*, or a private empty temp home when a test redirected nothing (never the real home), and **throws** if the home it would return is the real one. `config.routing.test.ts` keeps its own redirect and a guard that fails every test before it can write unless `homedir()`, `overridePath()` and `statePath()` are inside the temp home; its local `vi.mock` was dropped in favour of the global one, which is itself tested.
- Files **not** touched: `package.json`, the lockfile, `tiers.json`, every other source file, other worktrees, the base checkout, `C:\Users\Marquinho\.config`.

## Findings

| Id | Sev. | Where | Finding | Resolution |
|---|---|---|---|---|
| QA-1.1-1 | critical | `test/unit/config.routing.test.ts` hot-reload tests | Redirecting only `process.env.HOME`/`USERPROFILE` does not reach `os.homedir()` under `--pool=threads`, so the tests wrote the user's REAL global override file (`{"routing":{"engine":"enforce"}}`). The orchestrator deleted it | `18ee3dc` (module mock + guard in the test file), superseded at the root by `e8cefdb` (QA-1.1-17, global guard). Real files verified untouched under the default pool and `--pool=forks` |

**Pre-existing tests with the same weakness** (they redirect `HOME`/`USERPROFILE` only and write through `config.ts`): `config.overrides.test.ts` (`overridePath()` writes at 189, 213, 255 and others; `writeState` at 303), `router-command.test.ts` (`/router enforce …` at 45, 54, 58), `fable-effort-preset.test.ts` (`writeState` at 47, 94), `prompt-style-mixed.test.ts` (`writeState` at 79, 102, 143, 171, 182), `ladder-wiring.test.ts` (`overridePath()` at 210–211, 285), `router-reload-failure.test.ts` (`overridePath()` at 58). **Now covered by the global home guard (QA-1.1-17)**: their `HOME` redirect is honoured by the mocked `homedir()` in any pool. They were run with the default pool and with `--pool=forks` and the real files stayed untouched. Do not run vitest with `--pool=threads` regardless (A14). `vitest.smoke.config.ts` does not load the guard (smoke tests use real hosts).

### Round 1 fixes (QA round 1: 1 critical, 7 major, 9 minor, 3 nit)

| Id | Sev. | Resolution | Commit |
|---|---|---|---|
| QA-1.1-2 | critical | Global-only keys stripped from the project layer before the merge; one warning per file+text; notice; "Trust" docs; tests (resolved null + warning, global values win, other keys apply) | `879a0a3` |
| QA-1.1-3 | major | A non-empty `candidates` must contain the tier's own `(model, variant)`; that rung's `costRatio` equals the tier's or is omitted; errors name the key; pass/fail tests; docs | `0017364` |
| QA-1.1-4 | major | `resolveVariantSteps` per A15 (v1 ⇒ none; v2 explicit ?? routing block ? auto : none); docs and tests | `7eb802c` |
| QA-1.1-5 | major | Agent ids `^[A-Za-z0-9][A-Za-z0-9_./-]*$` (`ContextScout`, `team/helper` pass; empty, whitespace, `#` fail) | `ec36384` |
| QA-1.1-6 | major | `ROUTING_TASK_CLASSES` exported; unknown classes in `roles` rejected | `ec36384` |
| QA-1.1-7 | major | `roles` replaces wholesale across layers; `roles.<class>: []` accepted (documented deviation); two-layer tests | `ec36384` |
| QA-1.1-8 | major | One init-time `resolveRouting(cfg, host, logger)`; test: v1 init with engine `enforce` ⇒ exactly one notice before any `/router`, none on v2 / `static` / no routing | `5f92fa8` |
| QA-1.1-9 | major | No code here (catalog access is outside this write-set); recorded as the handoff **to 2.4** below | this report's commit |
| QA-1.1-10 | minor | Unknown `routing.*` key paths collected, warned once per config fingerprint, listed under the `/router` marker | `07bae4c` |
| QA-1.1-11 | minor | `hasExplicitCandidates(tier)` exported; handoff **to 1.5** below | `0017364` |
| QA-1.1-12 | minor | `candidates` effective `costRatio` must not decrease; docs "order = escalation order" | `0017364` |
| QA-1.1-13 | minor | `detection` must satisfy `deterministic ≥ grader ≥ none` (effective values); docs state the `minClassConfidence` extremes (0 never calls the backend; 1 calls it on every dispatch, bounded by `timeoutMs`) | `0b7e380` |
| QA-1.1-14 | minor | `classifier.presets` keys resolved like `resolvePresetName`; a key matching no preset is noticed | `07bae4c` |
| QA-1.1-15 | minor | `outcomes.path` must be absolute; `~` expanded by `resolveRouting`; docs | `0b7e380` |
| QA-1.1-16 | minor | Docs: `margin` rule is strict `<`, boundary kept (A16) | `0b7e380` |
| QA-1.1-17 | minor | `test/setup/home-guard.ts` + `setupFiles`; six audited files and the config tests run under the default pool and `--pool=forks`, real files unchanged | `e8cefdb` |
| QA-1.1-18 | minor | `roles` naming `build/plan/title/summary/compaction` noticed, not rejected (`ROUTING_RESERVED_AGENTS`); handoff **to 1.4** below | `07bae4c` |
| QA-1.1-19 | nit | Tier-name defaults looked up by own key (`tierDefaultsFor`), also in `applyTierDefaults` | `0017364` |
| QA-1.1-20 | nit | `loadBuildInfo(root)` wraps locating the plugin root; reftable ⇒ `unknown` documented and tested | `97d0dcf` |
| QA-1.1-21 | nit | Coverage measured (table above); tests for the remaining new branches; an unreachable fallback removed | `e01e888` |

**Not fully fixed / open for the reviewer:** none of the 21 is left open. Two are fixed with a stated interpretation or limit: QA-1.1-4 (v1 returns `none` even for an explicit value) and QA-1.1-9 (handoff only, by design of the brief).

Points I would challenge myself (candidates for the reviewer, not findings):

1. **`resolveVariantSteps` on v1 ignores an explicit value** (D1) instead of returning it as the brief's formula reads.
2. **`roles.<class>: []` is accepted**, relaxing the plan's "non-empty arrays"; a `roles` map that omits a class and one that lists it empty behave the same.
3. **The global home guard changes what un-redirected tests see**: a test that never set `HOME` now gets an empty private home instead of the machine's real one (all suites pass; in CI the real one is effectively empty anyway).
4. **`detection` is validated on effective values**, so a partial block can be rejected against a default the author did not write; the message names all three values.
5. **Notices are not failures**: a project layer whose forbidden keys were stripped loads without marking the reload failed.
6. **`~` is expanded at every `resolveRouting` call** with the then-current `homedir()`.
7. **The v1 notice is once per process** (and now at init), not once per config change.
8. **`/router` marker and notice lines only on the bare status view.**
9. **`ROUTING_TASK_CLASSES` is defined here**, ahead of the classifier (1.2); if 1.2 needs another class the list and the docs change together.

## Deferred by plan

- Wiring `resolveRouting` into the engine, protocol and v2 hooks → Phases 1.4, 2.2.
- The v1 text-only `R:` line listing `routing.roles` agents (D1) → Phase 1.4/2.2 (`src\router\protocol.ts` is not in this write-set); this phase only resolves the value.
- Advisor findings, `/router stats`, richer `/router` output → Phase 2.4 (owns `src\index.ts` commands from then on).
- Reading `outcomes.*`, `sessionReuse.*`, `advisor.*`, `classifier.*` → Phases 1.2, 1.3, 1.5, 2.1–2.4.
- Removing the docs status note and polishing the section → Phase 3.1.

## Handoffs

- **to 1.2** — `resolveRouting(cfg, host).classifier` (`ResolvedClassifier`) and `resolveClassifierForPreset(classifier, activePresetName)` (case-insensitive, like `/preset`) give the effective settings; validation already guarantees a model for any non-`rules` backend and an `http(s)` `baseUrl` for the two HTTP backends. **A18:** these keys can only come from the bundled file or the global override; the HTTP backends must additionally refuse to send an API key over plain `http:` to a non-loopback host. `ROUTING_TASK_CLASSES` is the class list of `TaskFacts.class`. `classifier.model` is only shape-checked (no catalog check).
- **to 1.3** — `resolveRouting(...).outcomes.path` is `string | null`, already absolute and `~`-expanded; `null` = the scorecard directory of D15 (not resolved here). Only the global override can set it.
- **to 1.4** — D2: with no `routing` block `resolveRouting` equals the documented defaults on both hosts; `resolveCandidates(tier, cfg)` is the ladder source (escalation order, tier's own rung always present, non-decreasing `costRatio`); `ResolvedRouting.roles` is de-duplicated and frozen, and a class may map to `[]`; **A16: implement the margin switch as strict `C(best) < (1 − margin)·C(chosen)`**; **QA-1.1-18: `roles` may still contain `build`, `plan`, `title`, `summary`, `compaction` (`ROUTING_RESERVED_AGENTS`) or any name the host lacks — the v1 text-only `R:` roles line and the v2 candidate list must filter against the host's agent info (mode ≠ primary, not hidden, permitted) and skip the rest**; the v1 line reads `roles` only when `applied.rolesSource === "configured"`.
- **to 1.5** — `resolveVariantSteps(cfg, host)` is the rule of A15 (`none` without a `routing` block); **use `hasExplicitCandidates(tier)` instead of the local cast** you had to write to read `tier.candidates`; `resolveCandidates` already returns the rungs in escalation order with the `costRatio` each rung runs at (A17).
- **to 2.2 / 2.4** — `/router` already prints the marker and the config notices (`routerStatusLines`); `getConfigNotices(dir)` is available to the advisor. Call `resolveRouting(cfg, host, logger)` with the plugin logger. Hot reload needs nothing new.
- **to 2.4 (QA-1.1-9)** — **advisor finding to add: catalog validation of the ladder.** Config validation cannot see the catalog. For every rung of every tier (`resolveCandidates`) and for `classifier.model`, check against the live catalog that the model exists, that the `variant` is in `model.variants` (an omitted variant is the model's default), and that the model supports tool calls where a subagent needs them; report each miss as an advisor finding (F4, "tiers with effort/variant that the catalog does not offer") and let the engine drop such a rung from its ladder rather than emit a variant the model lacks (A9).
- **to the checkpoints (§0.11)** — the liveness probe is the line `router: engine=<mode> build=<version>+<sha7>` in the bare `/router` output; `<sha7>` is the first 7 digits of `git rev-parse HEAD` of the plugin checkout, read once at module load (a restart refreshes it, A8); `unknown` for a checkout without a readable `.git` or with `reftable` refs.
- **to every test author** — `test/setup/home-guard.ts` makes `os.homedir()` follow the `HOME`/`USERPROFILE` a test sets and isolates tests that set none; a test that points them at the real home fails loudly. Never run vitest with `--pool=threads` (A14).
- **to 3.1** — drop the "Status" note of the `routing` section; keep the machine-checked defaults block; document the Trust rule and the notices.

## Verdict

Implementation complete, round-1 findings (21) all addressed, green on the scoped suites, the 22 HOME-redirecting files, `vitest related` and typecheck, with the real home files verified untouched. **A re-review has not run: the verdict and the "open findings" count are the reviewer's to set.**
