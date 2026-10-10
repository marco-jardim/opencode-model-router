# Critical-Path Execution — Pre-flight 0.P

Plan: `D:\git\omr-cpx-main\docs\plans\critical-path-execution-plan.md`. Handover:
`D:\git\omr-cpx-main\docs\plans\critical-path-execution-handover.md`. Date: 2026-10-10.

## 0.P.1 — Dedicated worktree and plan commit

- `git worktree list`: `D:\git\omr-cpx-main` on `cpx/main` at `b716ee9`. The list also shows the off-limits main
  checkout `D:\git\opencode-model-router` (`master`, `71dcfab`) and a second worktree of the other implementation,
  `D:\git\opencode-model-router-cross-repo` (`feat/cross-repo`, `fa51019`), which this plan treats as off-limits too
  (§0.13).
- `git status --porcelain=v1 --untracked-files=all`: exactly the two expected untracked files (plan, handover).
- `cpx/main@{upstream}`: none (`fatal: no upstream configured`), as required.
- `git fetch origin`: `origin/master` = `b716ee9`, unchanged since plan time. No merge. **Plan base: `b716ee9`.**
- `npm ci` in `D:\git\omr-cpx-main`: OK (357 packages). Notes: install scripts of `msgpackr-extract` blocked by npm's
  `allowScripts` (optional native accelerator; no effect on the plugin). `npm audit` reports 2 critical advisories in
  `seroval` through `solid-js@1.9.15` — see "Pre-existing findings".
- `D:\git\omr-cpx-main\docs\plans\README.md` entry added (links only the plan and the handover); docs-drift green
  (83/83).
- Commit `d6a6610` `docs(plan): add critical-path execution plan`; pushed with `push -u origin cpx/main`; upstream is
  `origin/cpx/main`.

## 0.P.3 — Environment, configuration and authority

| Item | Result |
|---|---|
| 0.P.3.a `OPENCODE_V2_BIN` | Was **not set**. Set at user scope to `C:\Users\Marquinho\scoop\apps\opencode2\2.0.26\opencode.exe` (a versioned path, not the moving `current` link); reports `opencode v2.0.26` (≥ 2.0.24). Version under test for ADR 0007: **2.0.26**. Shell runs set it explicitly until the host restarts. |
| OpenCode 1.x for `smoke:v1` | `C:\Users\Marquinho\scoop\apps\opencode\1.18.35\opencode.exe` (1.18.35); not first on `PATH` (the `opencode` shim is v2.0.26), so `smoke:v1` runs with that directory prepended to `PATH`. |
| 0.P.3.b tools | node v24.21.0; git 2.51.0.windows.1; pnpm 11.22.0; Python 3.14.7 with `venv` and `pip`; uv 0.11.7; gh 2.79.0, `gh auth status` OK (account `marco-jardim`); bun 1.3.14; free space on `D:` 323.8 GB; **16 cores → `--maxWorkers=14`** for scoped runs (split when two worktrees test at once). |
| 0.P.3.c `routing.delegation` | `"roles"` is already set in the global override, so it is in effect for `D:\git\omr-cpx-main`; no project layer needed. |
| 0.P.3.c `routing.workRoots` | Was **missing**. Added to the global override `C:\Users\Marquinho\.config\opencode\opencode-model-router.overrides.jsonc` (additive; backup `$env:LOCALAPPDATA\omr-cpx\overrides.backup.jsonc`): `D:/git/omr-cpx-main`, `D:/git/omr-cpx-p*`, `D:/git/omr-cpx-pdf*`, `D:/git/omr-cpx-scratch`, `D:/git/omr-cpx-e2e`. Validated by the plan base's own resolver (`resolveRolesRouting(loadConfig(), "v2")` under bun): delegation `roles`, the five globs, `run.commands` = `test-files`. Takes effect at the next host start. |
| 0.P.3.d shell | The orchestrator has a pwsh shell tool (git, npm, gh all ran). |
| 0.P.3.e `test-files` | Not overridden; the shipped default entry `test-files` resolves (see above). |

### 0.P.3.f — Dogfood prerequisites

- **How the router is loaded today:** global config `C:\Users\Marquinho\.config\opencode\opencode.json`, key `plugin`,
  entry `D:\\git\\opencode-model-router` — the off-limits main checkout, a **moving working tree** with another
  implementation in progress. OpenCode v2 runs a shared **background service** for every TUI, so a change to the global
  entry would reach the other implementation's sessions. Log directory: `C:\Users\Marquinho\.local\share\opencode\log`.
- **Backup:** `$env:LOCALAPPDATA\omr-cpx\opencode-config.backup` (copy of the global `opencode.json`).
- **Narrowest scope: process-scoped (§0.12-2, option 1), verified.** `opencode --standalone` runs a private server that
  inherits the launching shell's environment, and `OPENCODE_CONFIG_DIR` **replaces** the global config directory
  (probe: `opencode api --standalone config.get` with a probe directory listed only the probe's `opencode.json`). The
  plan's config directory is `$env:LOCALAPPDATA\omr-cpx\opencode-config`: every file of the global config directory
  hard-linked and every subdirectory junctioned (so they stay in sync), except `opencode.json`, which is a copy whose
  router entry is the dogfood worktree. Verified: `config.get` through it lists the plugins
  `D:\\git\\opencode-anthropic-fix`, `D:\\git\\omr-cpx-dogfood-df0`, `D:\\git\\opencode-telegram-plugin` — the router
  exactly once, the main checkout not at all. The router's own override is read from
  `~\.config\opencode\opencode-model-router.overrides.jsonc` regardless of `OPENCODE_CONFIG_DIR`
  (`D:\git\omr-cpx-main\src\router\config.ts` ≈551), so it stays shared (additive keys only).
- **Switch (DF-n):** edit the router entry of `$env:LOCALAPPDATA\omr-cpx\opencode-config\opencode.json` to
  `D:\\git\\omr-cpx-dogfood-df<n>`; the owner restarts with the launch command recorded in the handover.
- **Revert:** close the plan's TUI and relaunch without `OPENCODE_CONFIG_DIR` and without `--standalone`; the global
  config was never changed.
- **Owner consent:** requested at the 0.P.3 stop (two dogfood restarts DF-1/DF-2, dogfood spend capped by §0.6-11, the
  process-scoped config). Recorded in the handover when given.

## 0.P.6 — DF-0

The router is loaded from a moving working tree, so DF-0 switches. Precondition at the base: `npm run typecheck` green.
Tag `cpx/df0` = `b716ee9` (pushed); worktree `D:\git\omr-cpx-dogfood-df0` added `--detach` at `cpx/df0`; `npm ci` ran
there; `git status` clean. The process-scoped config points at it. The self-check runs after the owner's restart
(result in the handover).

## 0.P.2 — Baseline

- 0.P.2.a `npm run typecheck` at `b716ee9`: exit 0.
- 0.P.2.b Scoped baseline (no full suite): the existing tests of the files Phases 0.1 and 1.1–1.4 own plus the tests
  that import their non-hub modules — 49 files (`test/golden`, the `routing-outcomes.*`, `routing-wire.hint`,
  `routing-advisor*`, `dispatch*`, `v2-hooks`, `docs-drift`, verification wiring/gate/pending/reference tests and the
  roles integration tests), `--maxWorkers=14`: **48 files passed, 2411 tests passed, 2 skipped, 1 failed**, 166 s wall.
  - The failure was a **load flake**: `test/unit/v2-hooks.test.ts` > "applies the real ladder retry's effort through
    context without nesting options or changing grader temperature" timed out at 5253 ms (5000 ms default); it passes
    in isolation (`--maxWorkers=1`) in under 3 s. Fixed (not skipped) in `7e6903f`: explicit `30_000` ms timeout, the
    repository's precedent for heavy tests. Re-run under load (8 heavy files, `--maxWorkers=14`): 461 passed, 1
    skipped, 0 failed.
  - `test/smoke/helpers/scripted-provider.test.ts` (Phase 0.1) is a smoke-config file; it is run by Phase 0.1's
    pre-flight with the smoke configuration.
  - **Baseline failing-test list: empty.**

## 0.P.4 — Anchor re-base

`b7984b3` (anchor commit) is an ancestor of `b716ee9`; 6 commits apart. `git diff --stat b7984b3 b716ee9 -- src docs
test scripts` touches only `src/verify/reference.ts`, `test/integration/batch-wiring.test.ts`,
`test/unit/reference.test.ts` and `test/unit/runner.test.ts`. Every anchor into any other file is unchanged. Anchors
into the changed files, checked line by line:

| Plan location | Anchor at `b7984b3` | At `b716ee9` |
|---|---|---|
| §1.1 D10 | `src\verify\reference.ts` ≈71-78 (workspace-link drift comment) | ≈71-78 (unchanged; before the first hunk at 101) |
| Phase 2.1 (plan line ≈1763) | `src\verify\reference.ts` ≈2052 (reference GC) | **≈2120** (+68) |
| Phase 3.2 pre-flight (plan line ≈2102) | `src\verify\reference.ts` ≈2056 (`--git-common-dir` resolution) | **≈2124** (+68) |

No plan anchor names the three changed test files. Each phase pre-flight still re-verifies its own anchors (§0.9).

## Pre-existing findings (not caused by this plan)

- **PF-1 (`npm audit`, critical ×2):** `seroval` (`fromJSON()` thenable assimilation bypass; TypedArray length memory
  exhaustion) through `solid-js`, pinned at exactly `1.9.15` in `D:\git\omr-cpx-main\package.json` to match the host
  typings (`@opencode/plugin@2.0.22` → `solid-js@1.9.15`). The TUI plugin only renders; it deserializes no untrusted
  seroval input. A `solid-js` bump is a TUI compatibility decision outside this plan's scope; reported to the owner,
  not changed here.

## QA

Pending (runs after the DF-0 restart and self-check).
