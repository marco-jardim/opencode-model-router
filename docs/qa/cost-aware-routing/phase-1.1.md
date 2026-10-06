# Phase 1.1 — Configuration surface (M1) (cost-aware routing engine, #74)

> Worktree `D:\git\omr-car-p11` (branch `car/p11`, from `car/main` @ `3b3dba4`). Base directory `D:\git\opencode-model-router`.
> Write-set (plan §2), extended for the QA rounds: `src\router\config.ts`, `src\router\build-info.ts` (new), `docs\CONFIG_REFERENCE.md`, `test\unit\config.routing.test.ts` (new), `test\unit\config.validate.test.ts` (append only), `test\setup\home-guard.ts` (new) + the `setupFiles` entry of `vitest.config.ts`, one line of `test\unit\tree.test.ts` (round 2), this report, and in `src\index.ts` only: the `/router` status statement, the config names in the existing import, one init-time `resolveRouting` call, and (round 2) the `warnConfigIssues` call at each former `warnDeprecatedVerifyKeys` site.

## Pre-flight

| Item | Result |
|---|---|
| Worktree / branch | `D:\git\omr-car-p11`, `car/p11`, clean at start (`git status --short` empty), based on `car/main` @ `3b3dba4` |
| Build step (1.1.6) | **none**: `package.json` scripts are `test`, `test:watch`, `test:coverage`, `smoke*`, `typecheck`. The runtime `.git` read in `src\router\build-info.ts` is the only sha source |
| Phase 0.P handoffs to 1.1 | (a) global-override hot reload proven by `config.routing.test.ts` › "hot reload of the global override file with a routing block" (HOME redirected to a temp dir, no explicit invalidate, mtime bumped like a real edit; also through the `/router` command; `os.homedir()` is mocked for every test file by the global home guard); (b) runtime `.git` read only; (c) `routing.classifier = { backend: "host", model: "opencode-go/deepseek-v4.1-flash", timeoutMs: 10000 }` accepted (validate test and override-layer test) |
| Full-suite baseline | `car/main` @ `3b3dba4`: `Test Files 109 passed \| 3 skipped` |
| Plan amendments in force | A14 (never `--pool=threads`; global home guard), A15 (`variantSteps` default), A16 (strict margin), A18 (project layer may not set classifier/outcome sinks) — from `car/main:docs/plans/cost-aware-routing-engine-plan.md` |

### Results (final, all in `D:\git\omr-car-p11`, default pool; `--pool=threads` never used)

| Command | Result |
|---|---|
| `npm run typecheck` | exit 0 (run before every commit and at the end) |
| `npx vitest run test/unit/config.routing.test.ts test/unit/config.validate.test.ts test/unit/protocol.test.ts` | `Test Files 3 passed (3)`, `Tests 582 passed \| 1 skipped (583)` (the skipped test is the POSIX-only `outcomes.path` case; its Windows twin runs here) |
| five `test/unit/config*.test.ts` + `protocol` + `router-command` + `tree.test.ts` + the 22 files that redirect `HOME`/`USERPROFILE` = 27 files, named explicitly | `Test Files 27 passed (27)`, `Tests 1110 passed \| 1 skipped (1111)` |
| `npx vitest related src/router/config.ts src/router/build-info.ts src/index.ts test/setup/home-guard.ts --run` (the setup file is imported by every test, so this is effectively the whole suite) | `Test Files 110 passed \| 3 skipped (113)`, `Tests 9577 passed \| 66 skipped (9643)`, 120 s (run at `d85a012`, before the round-3 fix; the round-3 change was re-checked with the 27-file set above) |
| Real-home check, before and after each run above | `C:\Users\Marquinho\.config\opencode\opencode-model-router.overrides.jsonc` does not exist; `opencode-model-router.state.json` `LastWriteTime` unchanged at `2026-10-05 08:47:03` (metadata only; contents never read) |

**Coverage (QA-1.1-21)**, `vitest --coverage` scoped to the two source files (the repo threshold is 90 % branches for `src/router/**` over the whole suite):

| Test files run | `config.ts` stmts / branches / funcs / lines | `build-info.ts` stmts / branches / funcs / lines |
|---|---|---|
| the two named files (`config.routing` + `config.validate`) | 90.56 / **87.37** / 94.91 / 91.27 | 100 / 98.03 / 100 / 100 |
| the five `config*.test.ts` files | 96.61 / **95.41** / 98.3 / 96.67 | 100 / 98.03 / 100 / 100 |

With only the two named files, `config.ts` is under 90 % branches because the pre-existing `loadConfig`/state/reload machinery is exercised by `config.overrides.test.ts`, not by them. Of the 1302 lines this phase added to `config.ts` (measured against `3b3dba4`) the two named files cover every statement and leave **one** branch open: the defensive `isPlainObject(rawUsed)` fallback in `buildConfig` (a validated config is always an object).

Note for whoever runs the scoped suite: `npx vitest run test/unit/config*.test.ts` passes the glob to vitest as a *substring filter*, so under `pwsh` it matches nothing; name the files.

## Implementation notes

Commits on `car/p11` (all `Refs #74`, pushed after each). Round 0: `5844458` types, `afc5405` validation, `50e151b` resolvers, `ac4fa71` build marker and `/router` line (+ tests), `697f57d` docs, `43c57ff` first report, `18ee3dc` QA-1.1-1. Rounds 1 and 2: one commit per finding group, listed in the fix tables below.

Decisions as they stand after round 2 (the first is a deviation from the plan's wording; the rest are choices the plan leaves open or that QA rounds changed):

- **Unknown keys inside `routing`: ignored, not rejected, but not silent** — *Amended during implementation.* The plan says "rejected"; the file's actual policy is the opposite (`validateModelGenerations`: "ignored rather than rejected"; `validateEnforcement` checks only known keys). Only the prototype keys are rejected (`rejectPrototypeKeys`), at every level. Unknown key paths (`findUnknownRoutingKeys`) become config notices.
- **Config notices** (`ConfigNotice`): built in `buildConfig`, kept on the cache entry (per directory, for `/router`) and on the config object (for logging). **`config.ts` never writes them to the console** (QA-1.1-23): `warnConfigNotices(cfg, logger)` logs each notice whose *text* has not been logged yet in this process (bounded set of 256), through the plugin logger, and `warnConfigIssues(cfg, logger)` = the deprecation warning + the notices, called by `index.ts` after every `loadConfig`. Keying on the text, not the config fingerprint, means a state write (`/preset`, `/budget`, `/router enforce`) does not repeat a typo. Notices are not `SourceFailure`s: they never make a reload fail. Sources: unknown routing keys, keys dropped from the project layer (QA-1.1-2), `roles` naming a built-in agent (QA-1.1-18), `classifier.presets` keys matching no preset (QA-1.1-14), tier `candidates` that are ignored (QA-1.1-25).
- **Project layer trust (A18)**: `routing.classifier.{backend,model,baseUrl,apiKeyEnv,presets}` and `routing.outcomes.path` are removed from the project-local override *before* the layers merge; a `classifier`/`outcomes` block (and a `routing` block) that stripping leaves empty is removed too (QA-1.1-24), because any `routing` block, however empty, turns variant steps on (A15). The rest of that file applies.
- **`validateConfig` returns a read-once snapshot of `routing`** (known keys only); no `routing` block ⇒ the very same object (D2).
- **`roles`**: classes are `ROUTING_TASK_CLASSES`; agent ids match `^[A-Za-z0-9][A-Za-z0-9_./-]*$`, case-sensitive, **and are not path-like**: no empty/`.`/`..` segment, no trailing `/` or `.` (QA-1.1-27); an empty array for a class is accepted (deviation from "non-empty"); a `roles` key replaces wholesale, also across layers; duplicates are dropped at resolve time.
- **`candidates`**: `model` and `costRatio` inherit from the tier, `variant` does not (A9); `[]` = absent. **Malformed entries, duplicates and a decreasing effective `costRatio` throw** (QA-1.1-12). **The own-rung rules are not errors** (QA-1.1-25, reversing QA-1.1-3's first fix): if a non-empty list lacks the tier's own `(model, variant)`, or states another `costRatio` for it, `resolveCandidates` ignores the list (ladder = the tier's own rung), `candidatesProblem(tierName, tier)` / a config notice say why, and `buildConfig` then **removes the ignored list from the built config** (QA-1.1-30) so `tier.candidates`, `hasExplicitCandidates` and `resolveCandidates` agree — so a plugin update that moves a bundled tier's variant cannot invalidate a user's override layer. **Within one preset a `(model, variant)` has one `costRatio`** across own rungs and candidates, checked only for pairs involving an explicit candidates entry and not counting lists that are ignored (QA-1.1-26; shipped tiers share a model at different ratios). A tier's own `variant` must match the variant id pattern (QA-1.1-28).
- **`resolveVariantSteps` (A15)**: **v1 ⇒ always `none`** (D1; also for an explicit value — differs from the literal `explicit ?? …` formula of the round-1 brief); v2 ⇒ explicit value, else `auto` with a `routing` block and `none` without. Only the absence of a `routing` block preserves the 2.2.0 ladder (docs corrected, QA-1.1-24).
- **`detection`**: `deterministic ≥ grader ≥ none` on effective values. **`outcomes.path`**: absolute (on Windows a drive letter or UNC, QA-1.1-27) or `~`-relative, expanded by `resolveRouting`. **`classifier.presets`**: matched to the active preset like `/preset` does; the D3 rule is checked on every effective classifier.
- **`resolveRouting(cfg, host, logger?)`**: the v1 "engine ignored" line is at most once per process; the plugin calls it once at init (QA-1.1-8).
- **`/router`**: `routerStatusLines(cfg, host, logger, dir)` = the marker `router: engine=<applied engine> build=<version>+<sha7>` + one `router: config notice: …` line per notice; other `/router` views unchanged.
- **`build-info.ts`**: full sha or `unknown`; `.git` as directory or file (`gitdir:`), `commondir`, detached `HEAD`, loose refs, `packed-refs`; `reftable` ⇒ `unknown`; `loadBuildInfo(root)` survives an unlocatable plugin root.
- **Home guard (A14, QA-1.1-1/17/22)**: `test/setup/home-guard.ts` (`setupFiles`) replaces `node:os` `homedir` for every test file with the exported `guardedHomedir`: the `HOME`/`USERPROFILE` a test *changed* (in any pool, and on Windows where `os.homedir()` ignores `HOME`), else a private empty temp home, **throws instead of returning the real home** — compared with `realpath.native` on both sides (`sameDir`), so a trailing slash, a `..` or `.` segment, a different case or an 8.3 short name cannot hide it. A `beforeEach` runs `assertHomeIsGuarded` against `await import("node:os")` — the module *as the test file sees it* — so a file with its own `vi.mock("node:os", …)` that does not keep the guard fails every test loudly; the only such file, `test/unit/tree.test.ts`, now has `homedir: guardedHomedir` (verified: removing the line fails all 9 of its tests). The guard itself is tested in `config.routing.test.ts` (same module instance as the mock, trailing slash / doubled separator / `..` / `.` / case, a stand-in for a mock without `homedir`, `sameDir`). A symlink/junction-to-the-real-home test was written and **removed**: recursive cleanup of a directory holding a junction to the real home is not a risk worth a test (the real home was verified intact).
- Files **not** touched: `package.json`, the lockfile, `tiers.json`, every other source file, other worktrees, the base checkout, `C:\Users\Marquinho\.config`.

## Findings

| Id | Sev. | Where | Finding | Resolution |
|---|---|---|---|---|
| QA-1.1-1 | critical | `test/unit/config.routing.test.ts` hot-reload tests | Redirecting only `HOME`/`USERPROFILE` does not reach `os.homedir()` under `--pool=threads`, so the tests wrote the user's REAL global override file. The orchestrator deleted it | `18ee3dc`, superseded at the root by `e8cefdb` (QA-1.1-17), completed by `f960d7c` (QA-1.1-22) |

**Pre-existing tests with the same weakness** (they redirect `HOME`/`USERPROFILE` only and write through `config.ts`): `config.overrides.test.ts`, `router-command.test.ts`, `fable-effort-preset.test.ts`, `prompt-style-mixed.test.ts`, `ladder-wiring.test.ts`, `router-reload-failure.test.ts`. **Covered by the global home guard**: their `HOME` redirect is honoured by the mocked `homedir()` in any pool, and the real files stayed untouched in every run. Do not run vitest with `--pool=threads` regardless (A14). `vitest.smoke.config.ts` does not load the guard (smoke tests use real hosts).

### Round 1 fixes (QA round 1: 1 critical, 7 major, 9 minor, 3 nit)

| Id | Sev. | Resolution | Commit |
|---|---|---|---|
| QA-1.1-2 | critical | Global-only keys stripped from the project layer before the merge; notice; "Trust" docs; tests | `879a0a3` |
| QA-1.1-3 | major | A non-empty `candidates` should contain the tier's own `(model, variant)` (own rung costRatio = tier's or omitted) — **made non-fatal in round 2 (QA-1.1-25)** | `0017364`, `c4c66f4` |
| QA-1.1-4 | major | `resolveVariantSteps` per A15 | `7eb802c` |
| QA-1.1-5 | major | Agent ids `^[A-Za-z0-9][A-Za-z0-9_./-]*$`, case-sensitive (+ path-like ids refused in round 2, QA-1.1-27) | `ec36384`, `c71b870` |
| QA-1.1-6 | major | `ROUTING_TASK_CLASSES` exported; unknown classes rejected | `ec36384` |
| QA-1.1-7 | major | `roles` replaces wholesale across layers; `[]` accepted for a class | `ec36384` |
| QA-1.1-8 | major | One init-time `resolveRouting(cfg, host, logger)` | `5f92fa8` |
| QA-1.1-9 | major | No code here; handoff **to 2.4** below | `d75702b` |
| QA-1.1-10 | minor | Unknown `routing.*` key paths noticed and listed under the `/router` marker | `07bae4c` |
| QA-1.1-11 | minor | `hasExplicitCandidates(tier)` exported | `0017364` |
| QA-1.1-12 | minor | `candidates` effective `costRatio` must not decrease | `0017364` |
| QA-1.1-13 | minor | `detection` order; `minClassConfidence` extremes documented | `0b7e380` |
| QA-1.1-14 | minor | `classifier.presets` keys resolved like `resolvePresetName`; unmatched keys noticed | `07bae4c` |
| QA-1.1-15 | minor | `outcomes.path` absolute / `~` | `0b7e380` |
| QA-1.1-16 | minor | Docs: strict margin | `0b7e380` |
| QA-1.1-17 | minor | Global home guard — **partial; completed in round 2 (QA-1.1-22)** | `e8cefdb`, `f960d7c` |
| QA-1.1-18 | minor | Reserved agents noticed | `07bae4c` |
| QA-1.1-19 | nit | Tier-name defaults by own key | `0017364` |
| QA-1.1-20 | nit | `loadBuildInfo`; reftable ⇒ `unknown` | `97d0dcf` |
| QA-1.1-21 | nit | Coverage measured; gaps closed (again after round 2) | `e01e888`, `d85a012` |

### Round 2 fixes (QA round 2: 2 major, 6 minor/nit; QA-1.1-9 stays a 2.4 handoff; QA-1.1-17 partial)

| Id | Sev. | Resolution | Commit |
|---|---|---|---|
| QA-1.1-22 | major (+17) | `guardedHomedir`, `sameDir`, `assertHomeIsGuarded` exported from `home-guard.ts`; a `beforeEach` checks the `os` module each test file really sees (dynamic import through the file's own mock) and fails loudly if it resolves the real home; both sides compared with `realpathSync.native`; `tree.test.ts` (the only file with its own `node:os` mock) keeps the guard with `homedir: guardedHomedir`; negative control verified (line removed ⇒ 9 failures); the guard is tested directly, including a stand-in for a mock without `homedir` | `f960d7c` |
| QA-1.1-23 | major | `config.ts` no longer calls `console.warn` for notices; `warnConfigNotices`/`warnConfigIssues` log new notice *texts* once per process through the plugin logger; `index.ts` calls `warnConfigIssues` at every former `warnDeprecatedVerifyKeys` site; tests: unknown key, then `writeState` + two reloads ⇒ exactly one warning (config level and through the `/router` command) | `1255682` |
| QA-1.1-24 | minor | Both CONFIG_REFERENCE sentences fixed (only the absence of a `routing` block preserves 2.2.0; any block turns `auto` on for v2 unless `variantSteps: "none"`); project-layer stripping removes emptied `classifier`/`outcomes` objects and an emptied `routing` | `f60e4e5` |
| QA-1.1-25 | minor | Own-rung / costRatio mismatch is non-fatal: `resolveCandidates` ignores that tier's list (ladder = own rung), `candidatesProblem` + a config notice say why; malformed entries still throw; test: override with candidates + a changed tier variant ⇒ layer not dropped | `c4c66f4` |
| QA-1.1-26 | minor | Per preset, every effective `(model, variant)` across own rungs and candidates has a single `costRatio` (pairs involving a candidates entry; ignored lists do not count) | `c4c66f4` |
| QA-1.1-27 | nit | Agent ids: no empty/`.`/`..` segment, no trailing `/` or `.`; Windows `outcomes.path` needs a drive letter or UNC | `c71b870` |
| QA-1.1-28 | nit | The tier's own `variant` is validated with the variant id pattern | `c4c66f4` |
| QA-1.1-29 | nit | Handoff wording corrected and the orchestrator merge item recorded (Handoffs below) | this report's commit |

### Round 3 fixes (QA round 3: 1 major; QA-1.1-31 and -32 minors accepted, not fixed)

| Id | Sev. | Resolution | Commit |
|---|---|---|---|
| QA-1.1-30 | major | A `candidates` list that loading reports as ignored (no own rung, or another `costRatio` for it) is removed from the built config after its notice is recorded (`dropIgnoredCandidates` in `buildConfig`), so `tier.candidates`, `hasExplicitCandidates` and `resolveCandidates` agree and Phase 1.5 cannot build variant steps from a raw list that the resolver ignores; `validateConfig` still leaves the caller's object untouched. Tests: no own rung and a costRatio mismatch ⇒ notice, `tier.candidates` absent, `hasExplicitCandidates` false, one-rung ladder; a used list is kept | `e681663` |

**Not fully fixed / open for the reviewer:** none of the findings is left open. Interpretations to confirm: QA-1.1-4 (v1 returns `none` even for an explicit value); QA-1.1-9 (handoff only); QA-1.1-25/26/28 share one commit (`c4c66f4`) because they touch the same function; the symlink case of QA-1.1-22 is not tested (see the home-guard note).

Points I would challenge myself (candidates for the reviewer, not findings):

1. **`resolveVariantSteps` on v1 ignores an explicit value** (D1) instead of returning it as the brief's formula reads.
2. **`roles.<class>: []` is accepted**, relaxing the plan's "non-empty arrays".
3. **The global home guard changes what un-redirected tests see**: a test that never set `HOME` now gets an empty private home instead of the machine's real one.
4. **The own-rung rules became notices, but the decreasing-`costRatio` and duplicate rules are still errors**: a plugin update that reorders bundled costRatios could still invalidate an override that lists candidates.
5. **`assertConsistentRungCosts` skips pairs of two implicit own rungs**, so two tiers may still quote different ratios for one `(model, variant)` when neither lists candidates (the shipped case); the engine must not assume one price per `model#variant` across such tiers.
6. **Notices are logged by text once per process**: after a fix and a later reintroduction of the same typo the text is not logged again until restart; `/router` still lists it.
7. **`~` is expanded at every `resolveRouting` call** with the then-current `homedir()`.
8. **The v1 notice is once per process**, not once per config change.
9. **`ROUTING_TASK_CLASSES` is defined here**, ahead of the classifier (1.2).

## Deferred by plan

- Wiring `resolveRouting` into the engine, protocol and v2 hooks → Phases 1.4, 2.2.
- The v1 text-only `R:` line listing `routing.roles` agents (D1) → Phase 1.4/2.2 (`src\router\protocol.ts` is not in this write-set).
- Advisor findings, `/router stats`, richer `/router` output → Phase 2.4 (owns `src\index.ts` commands from then on).
- Reading `outcomes.*`, `sessionReuse.*`, `advisor.*`, `classifier.*` → Phases 1.2, 1.3, 1.5, 2.1–2.4.
- Removing the docs status note and polishing the section → Phase 3.1.

## Handoffs

- **to 1.2** — `resolveRouting(cfg, host).classifier` and `resolveClassifierForPreset(classifier, activePresetName)` (case-insensitive, like `/preset`) give the effective settings; validation guarantees a model for any non-`rules` backend and an `http(s)` `baseUrl` for the two HTTP backends. **A18:** these keys only come from the bundled file or the global override; the HTTP backends must also refuse to send an API key over plain `http:` to a non-loopback host. `ROUTING_TASK_CLASSES` is the class list of `TaskFacts.class`. `classifier.model` is only shape-checked (no catalog check).
- **to 1.3** — `resolveRouting(...).outcomes.path` is `string | null`, already absolute and `~`-expanded; `null` = the scorecard directory of D15 (not resolved here). Only the global override can set it.
- **to 1.4** — D2: with no `routing` block `resolveRouting` equals the documented defaults on both hosts; `resolveCandidates(tier, cfg)` is the ladder source (escalation order, the tier's own rung present — or the ladder is just that rung when the list is ignored — non-decreasing `costRatio`); **A16: implement the margin switch as strict `C(best) < (1 − margin)·C(chosen)`**; `ResolvedRouting.roles` is de-duplicated and frozen and **a class may map to `[]`: the v1 text-only `R:` line must skip classes with no agents** (and read `roles` only when `applied.rolesSource === "configured"`); **`roles` may still contain `build`, `plan`, `title`, `summary`, `compaction` (`ROUTING_RESERVED_AGENTS`) or any name the host lacks — both the v1 line and the v2 candidate list must filter against the host's agent info (mode ≠ primary, not hidden, permitted) and skip the rest**.
- **to 1.5** — `resolveVariantSteps(cfg, host)` is the rule of A15 (`none` without a `routing` block); **read the typed `tier.candidates` of the merged config (or, better, `resolveCandidates`) and use `hasExplicitCandidates(tier)` / `candidatesProblem(tierName, tier)`**: a list that lacks the tier's own rung is ignored by `resolveCandidates`, so do not read `tier.candidates` raw when the ladder matters; `resolveCandidates` returns the rungs in escalation order with the `costRatio` each rung runs at (A17).
- **to 2.2 / 2.4** — `/router` prints the marker and the config notices (`routerStatusLines`); `getConfigNotices(dir)` is available to the advisor; call `resolveRouting(cfg, host, logger)` with the plugin logger. Notices reach the user through `warnConfigIssues(cfg, logger)` (already wired after every `loadConfig` in `index.ts`).
- **to 2.4 (QA-1.1-9)** — **advisor finding to add: catalog validation of the ladder.** Config validation cannot see the catalog. For every rung of every tier (`resolveCandidates`) and for `classifier.model`, check against the live catalog that the model exists, that the `variant` is in `model.variants` (an omitted variant is the model's default), and that the model supports tool calls where a subagent needs them; report each miss as an advisor finding (F4) and let the engine drop such a rung rather than emit a variant the model lacks (A9).
- **orchestrator merge item (QA-1.1-29)** — after merging `car/p11` and the Phase 1.2 branch into `car/main`, add one test that pins `ROUTING_TASK_CLASSES` (here, `src/router/config.ts`) equal to the classifier's `TASK_CLASSES` (1.2): the two lists are defined independently and must not drift (this phase cannot import from `src/routing/classify/*`, which does not exist on this branch).
- **to the checkpoints (§0.11)** — the liveness probe is the line `router: engine=<mode> build=<version>+<sha7>` in the bare `/router` output; `<sha7>` is the first 7 digits of `git rev-parse HEAD` of the plugin checkout, read once at module load (a restart refreshes it, A8); `unknown` for a checkout without a readable `.git` or with `reftable` refs.
- **to every test author** — `test/setup/home-guard.ts` makes `os.homedir()` follow the `HOME`/`USERPROFILE` a test sets and isolates tests that set none; a test that points them at the real home fails loudly; **a test file that mocks `node:os` must include `homedir: guardedHomedir`** (see `tree.test.ts`) or every test in it fails. Never run vitest with `--pool=threads` (A14).
- **to 3.1** — drop the "Status" note of the `routing` section; keep the machine-checked defaults block; document the Trust rule and the notices.

## Verdict

**PASS — open findings: 0.** Adversarial QA by `@heavy` ran three rounds plus a round-3 fix check. Every blocking, critical and major finding is resolved: QA-1.1-1 to -8, -22, -23, -30. Accepted minors and nits (§0.7): QA-1.1-9 (handoff to 2.4: catalog validation of ladder rungs and `classifier.model`), -10 to -21, -24 to -29, -31 (home guard runs per test, not before a file's `beforeAll`, and does not cover the `default` export), -32 (the per-preset `costRatio` consistency check still throws when a bundled config changes), -33 (calling `validateConfig` directly without `loadConfig` leaves an ignored candidates list in place; production always goes through `loadConfig`).