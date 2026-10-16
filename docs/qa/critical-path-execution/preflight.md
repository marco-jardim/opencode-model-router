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
| 0.P.3.a `OPENCODE_V2_BIN` | Was **not set**. Value: `C:\Users\Marquinho\scoop\apps\opencode2\2.0.26\opencode.exe` (a versioned path, not the moving `current` link); reports `opencode v2.0.26` (≥ 2.0.24). **Version under test for ADR 0007: 2.0.26.** *QA-0.P-8:* it was first set at user scope, which would also reach the other implementation's opt-in smokes, and the restarted server did not inherit it anyway; the user-scope value was **removed**. It is set only in the plan's launch command and explicitly (`$env:OPENCODE_V2_BIN = …`) in every orchestrator shell run that needs it. |
| OpenCode 1.x for v1 smokes | `C:\Users\Marquinho\scoop\apps\opencode\1.18.35\opencode.exe` (1.18.35); not first on `PATH` (the `opencode` shim is v2.0.26). *QA-0.P-7:* **every** v1-host smoke (`smoke:v1`, `smoke:keyless`, §0.10-8) runs with `C:\Users\Marquinho\scoop\apps\opencode\1.18.35` prepended to `PATH`; `smoke:keyless` has no preflight of its own. Proven: with that prepend, `node scripts/smoke-v1-preflight.mjs` printed `smoke:v1 preflight: OpenCode 1.18.35 is first on PATH`, exit 0. |
| 0.P.3.b tools | node v24.21.0; git 2.51.0.windows.1; pnpm 11.22.0; uv 0.11.7; gh 2.79.0, `gh auth status` OK (account `marco-jardim`); bun 1.3.14; free space on `D:` 323.8 GB; **16 cores → `--maxWorkers=14`** for scoped runs (split when two worktrees test at once). Python (*QA-0.P-12*, commands as run): `py -3 --version` → `Python 3.14.7`; `py -3 -m venv -h` → `usage: python.exe -m venv [-h] …`; `py -3 -m pip --version` → `pip 26.2.1 from C:\Users\Marquinho\AppData\Local\Programs\Python\Python314\Lib\site-packages\pip (python 3.14)`. |
| 0.P.3.c `routing.delegation` | `"roles"` is already set in the global override, so it is in effect for `D:\git\omr-cpx-main`; no project layer needed. |
| 0.P.3.c `routing.workRoots` | Was **missing**. Added to the global override `C:\Users\Marquinho\.config\opencode\opencode-model-router.overrides.jsonc` (additive; backup `$env:LOCALAPPDATA\omr-cpx\overrides.backup.jsonc`): `D:/git/omr-cpx-main`, `D:/git/omr-cpx-p*`, `D:/git/omr-cpx-pdf*`, `D:/git/omr-cpx-scratch*`, `D:/git/omr-cpx-e2e*`. *QA-0.P-1:* the scratch and e2e entries were first literal; a literal entry is `realpath`-resolved at plugin start and dropped when the directory does not exist (`D:\git\omr-cpx-main\src\router\role-agents.ts` ≈198-205, ≈257-260), and both are created later, so they are globs now (plan 0.P.3.c amended). Validated with the base's own code under bun: `resolveRolesRouting(loadConfig(), "v2")` → delegation `roles`, the five entries, `run.commands` = `test-files`; `externalDirectoryPatterns([], workRoots)` → `D:\git\omr-cpx-main\*`, `D:\git\omr-cpx-p*`, `D:\git\omr-cpx-pdf*`, `D:\git\omr-cpx-scratch*`, `D:\git\omr-cpx-e2e*`, `problems: []`. None matches `D:\git\omr-cpx-dogfood-*`. *QA-0.P-15:* registration re-runs at plugin start and at every refresh after a config-file change (`D:\git\omr-cpx-main\src\compat\v2-hooks.ts` ≈1174-1182, ≈1354), so the edit was live at the next prompt of every running router on the machine — this server, the background service and the other implementation's server; there it only widens their role agents' external-directory policy to `D:\git\omr-cpx-*` (told to the owner). |
| 0.P.3.d shell | The orchestrator has a pwsh shell tool (git, npm, gh all ran). |
| 0.P.3.e `test-files` | Not overridden; the shipped default entry `test-files` resolves (see above). |

### 0.P.3.f — Dogfood prerequisites

- **How the router was loaded before DF-0:** global config `C:\Users\Marquinho\.config\opencode\opencode.json`, key
  `plugin`, entry `D:\\git\\opencode-model-router` — the off-limits main checkout, a **moving working tree** with
  another implementation in progress. OpenCode v2 runs a shared **background service** for every TUI, so a change to
  the global entry would reach the other implementation's sessions. Log directory:
  `C:\Users\Marquinho\.local\share\opencode\log` (one `opencode.log` shared by every OpenCode server on the machine).
- **Backup:** `$env:LOCALAPPDATA\omr-cpx\opencode-config.backup` (copy of the global `opencode.json`).
- **Narrowest scope: process-scoped (§0.12-2, option 1), verified.** `opencode --standalone` runs a private server that
  inherits the launching shell's environment, and `OPENCODE_CONFIG_DIR` **replaces** the global config directory
  (probe: `opencode api --standalone config.get` with a probe directory listed only the probe's `opencode.json`). The
  plan's config directory is `$env:LOCALAPPDATA\omr-cpx\opencode-config`: every file of the global config directory
  hard-linked and every subdirectory junctioned, except `opencode.json`, which is a copy whose router entry is the
  dogfood worktree. Verified: `config.get` through it lists the plugins `D:\\git\\opencode-anthropic-fix`,
  `D:\\git\\omr-cpx-dogfood-df0`, `D:\\git\\opencode-telegram-plugin` — the router exactly once, the main checkout not
  at all. The router's own override is read from `~\.config\opencode\opencode-model-router.overrides.jsonc` regardless
  of `OPENCODE_CONFIG_DIR` (`D:\git\omr-cpx-main\src\router\config.ts` ≈551), so it stays shared (additive keys only).
- **Sync caveat (QA-0.P-14):** hard links follow in-place writes only; a tool that saves by replacing the file breaks
  the link silently, and the `opencode.json` copy never sees later global changes. **At every DF switch** the
  orchestrator regenerates `opencode.json` from the current global file (changing only the router entry), mirrors the
  global directory's current top-level entries (*QA-0.P-23*: new files hard-linked, new directories junctioned, removed
  ones removed, same exclusions), checks that each hard-linked file still has the same hash as its global original
  (re-linking any that differ), and records it.
- **Smoke isolation (QA-0.P-17):** the plan's server exports `OPENCODE_CONFIG_DIR` to the orchestrator's shell, and
  OpenCode 1.18.35 merges that directory **additively** (probe: with it set, v1 `opencode debug config` listed
  `file:///D:/git/opencode-model-router` **and** `file:///D:/git/omr-cpx-dogfood-df0`). Every orchestrator smoke shell
  therefore removes it first; the deferred-catalog smoke host, which passed the whole environment through, now strips
  `OPENCODE_*` like its siblings (`46dac26`; run with the variable still set and v1 first on `PATH`: 1/1 passed).
- **Launch (QA-0.P-9):** the versioned executable, not the moving `current` shim:
  `$env:OPENCODE_CONFIG_DIR = "$env:LOCALAPPDATA\omr-cpx\opencode-config"; $env:OPENCODE_V2_BIN = "C:\Users\Marquinho\scoop\apps\opencode2\2.0.26\opencode.exe"; & $env:OPENCODE_V2_BIN --standalone -s ses_ed82f88a7ffej5iKaRHuwIa6fd D:\git\omr-cpx-main`.
  (The DF-0 restart used the `opencode` shim; its server process resolved to the 2.0.26 executable, checked below.)
- **Switch (DF-n):** regenerate as above with the router entry `D:\\git\\omr-cpx-dogfood-df<n>`; the owner restarts with
  the launch command.
- **Revert (QA-0.P-11/-18):** *back to before DF-0 only:* relaunch without `OPENCODE_CONFIG_DIR` and without
  `--standalone` (back to the global config, which loads the main checkout). *After DF-1 or later:* point the copy's
  router entry back at the **last build that passed its self-check** (recorded in the handover) and relaunch with the
  same launch command (§0.12-6).
- **Owner consent:** requested at the 0.P.3 stop (two dogfood restarts DF-1/DF-2, dogfood spend capped by §0.6-11, the
  process-scoped config). **Granted 2026-10-10.**

## 0.P.6 — DF-0

The router is loaded from a moving working tree, so DF-0 switches. Precondition at the base: `npm run typecheck` green.
Tag `cpx/df0` = `b716ee9` (pushed); worktree `D:\git\omr-cpx-dogfood-df0` added `--detach` at `cpx/df0`; `npm ci` ran
there; `git status` clean. The process-scoped config points at it.

**Self-check after the owner's restart (restart 2026-10-10 19:46 local; the run-scoped checks below ran between 19:47
and 20:07): PASS.** Method (plan 0.P.6 as amended by QA-0.P-6/-18):
- **Run id of the plan server:** the orchestrator ran the marker command `Write-Output omr-selfcheck-7f3a91c2d4`; the
  log's `spawning process` line carrying that literal is tagged `run=461f3bf1`. The server process (pid 29860,
  `serve --stdio --port 0`, parent: the TUI launched with `--standalone -s ses_ed82f88a7ffej5iKaRHuwIa6fd
  D:\git\omr-cpx-main`) runs `C:\Users\Marquinho\scoop\apps\opencode2\2.0.26\opencode.exe` — the version under test.
- **Plugin set (QA-0.P-24):** the config lists anthropic-fix, df0 and telegram; the run loaded anthropic-fix and df0.
  `opencode-telegram-plugin` is loaded by no server on this machine (before or after the switch), so the amended
  0.P.6 rule allows exactly that absence; no plugin outside the list was loaded. PASS under the amended rule.
- **Plugins of run `461f3bf1`:** `loading plugin` exactly once for `D:\\git\\omr-cpx-dogfood-df0` (entrypoint
  `file:///D:/git/omr-cpx-dogfood-df0/server.ts`) and once for `D:\\git\\opencode-anthropic-fix`; zero for
  `D:\git\opencode-model-router`. The only lines of that run naming the main checkout are the host's read-only watcher
  on this worktree's `HEAD` inside the shared git directory (`…\.git\worktrees\omr-cpx-main\HEAD`) — expected, it is
  how a linked worktree resolves its git directory.
- The session's tool list has exactly one `router_verify`.
- Observed, not caused by this plan: the background service (run `c6586e70`) still loads the router from the main
  checkout for the owner's other windows, and the other implementation runs its own standalone server loading
  `D:\git\opencode-model-router-cross-repo` (run `3b25a462`). `opencode-telegram-plugin` is listed in the config but
  loaded by neither the background service nor this server (same behavior as before the switch).

## 0.P.2 — Baseline

- 0.P.2.a `npm run typecheck` at `b716ee9`: exit 0.
- 0.P.2.b Scoped baseline (no full suite): the existing tests of the files Phases 0.1 and 1.1–1.4 own plus the tests
  that import their non-hub modules, `--maxWorkers=14`: **48 files passed, 2411 tests passed, 2 skipped, 1 failed**,
  166 s wall. The 49 files (*QA-0.P-13*), repo-relative:
  - `test/golden/assembled-prompt.golden.test.ts`, `test/golden/banners.golden.test.ts`,
    `test/golden/fable-effort-preset.golden.test.ts`, `test/golden/narration.golden.test.ts`,
    `test/golden/prompt-style.golden.test.ts`, `test/golden/protocol.golden.test.ts`,
    `test/golden/roles-protocol.golden.test.ts`, `test/golden/tier-prompts.golden.test.ts`;
  - `test/integration/batch-wiring.test.ts`, `test/integration/deferred-verification.test.ts`,
    `test/integration/roles-authority.test.ts`, `test/integration/roles-dispatch.test.ts`,
    `test/integration/roles-protocol.test.ts`, `test/integration/router-verify-tool.test.ts`,
    `test/integration/routing-advisor.test.ts`, `test/integration/routing-dispatch.test.ts`;
  - `test/unit/baseline-wiring.test.ts`, `test/unit/baseline.test.ts`, `test/unit/dispatch.test.ts`,
    `test/unit/dispatch-header.test.ts`, `test/unit/dispatch.worktree-list.test.ts`, `test/unit/docs-drift.test.ts`,
    `test/unit/dod.test.ts`, `test/unit/file-lock.test.ts`, `test/unit/gate.test.ts`, `test/unit/pending.test.ts`,
    `test/unit/reference-branches.test.ts`, `test/unit/roles.dispatch-path.test.ts`, `test/unit/roles.kernel.test.ts`,
    `test/unit/roles.runtime.test.ts`, `test/unit/routing-engine.kernel.test.ts`,
    `test/unit/routing-engine.ladders.test.ts`, `test/unit/routing-engine.plan.test.ts`,
    `test/unit/routing-engine.protocol-line.test.ts`, `test/unit/routing-outcomes.beta.test.ts`,
    `test/unit/routing-outcomes.cost.test.ts`, `test/unit/routing-outcomes.persist.test.ts`,
    `test/unit/routing-outcomes.signals.test.ts`, `test/unit/routing-outcomes.stats.test.ts`,
    `test/unit/routing-outcomes.store.test.ts`, `test/unit/routing-wire.hint.test.ts`,
    `test/unit/routing-advisor.bundled.test.ts`, `test/unit/security-scrub.test.ts`,
    `test/unit/store-eviction.test.ts`, `test/unit/tests-pass-pipeline.test.ts`, `test/unit/tmp-guard.test.ts`,
    `test/unit/verify.criteria.test.ts`, `test/unit/wiring.test.ts`, `test/unit/v2-hooks.test.ts`.
  - **Runtime skip gates** (*QA-0.P-22*) that did not fire in this run: `ctx.skip()` in
    `test/integration/roles-authority.test.ts` ≈391 (link creation) and ≈1335, and in
    `test/unit/tests-pass-pipeline.test.ts` ≈1515 and ≈1601 (8.3 short names); `it.runIf(process.platform === "win32")`
    in `test/unit/baseline.test.ts` ≈364 (ran). A later run whose skip count grows must check these first.
  - **The 2 skipped tests** are POSIX-only by design (`it.skipIf(process.platform === "win32")`):
    `test/integration/roles-authority.test.ts` ≈369 "QA-P23-A1 (POSIX): `<root>/link/../x` resolves through the link,
    outside the root", and `test/unit/roles.runtime.test.ts` ≈879 "QA-P33F1-1-2 (POSIX): a cwd `<root>/link/..` is
    where the filesystem says (outside), not `<root>`". The other conditional tests (`skipIf(!hasGit())`,
    `skipIf(!supportsPlainNodeTypeScript())`, `skipIf(!scriptRuns())`) run here (git present, node v24.21.0).
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
into `src\verify\reference.ts` (hunks `@@ -101 +101,16`, `-312 +321`, `-661 +681`, `-889 +915`, `-1802 +1830`,
`-1813 +1848`, `-1837 +1868`, `-1872 +1913`), each checked against the line content at both commits (*QA-0.P-2*,
*QA-0.P-4*):

| Plan location | Anchor at `b7984b3` | At `b716ee9` |
|---|---|---|
| §1.1 D10 | ≈71-78 (workspace-link drift comment) | ≈71-78 (unchanged; before the first hunk) |
| Phase 2.1 (reference GC at plugin start) | ≈2052 | **≈2120** (+68) |
| Phase 2.2 pre-flight (`--git-common-dir` resolution) | ≈2056 | **≈2124** (+68) |
| Phase 2.4 pre-flight (worktree paths long form) | ≈236-238 | **≈245-247** (+9) |
| Phase 2.4 pre-flight (win32 junctions) | ≈346-356 | **≈366-376** (+20) |
| Phase 2.4 pre-flight (`REF_DIR_PREFIX` … list end) | ≈859-907 | **≈885-935** (+26/+28) |
| Phase 2.4 pre-flight (`removeReferenceDir`) | ≈1296 | **≈1324** (+28) |
| Phase 2.4 pre-flight (`worktree add --lock`) | ≈1663-1673 | **≈1691-1701** (+28) |
| Phase 2.4 pre-flight (step 6 link node_modules … drift) | ≈1764-1845 | **≈1792-1886, rewritten** by #88 (`driftDiff`, `driftReasons`), plus a new step-7b re-diff at **≈1913-1953**; Phase 2.4 reads the new drift semantics |

No plan anchor names the three changed test files. Each phase pre-flight still re-verifies its own anchors (§0.9).
The same table is recorded in the handover §7.

## Pre-existing findings (not caused by this plan)

- **PF-1 (`npm audit`, critical ×2):** `seroval` (`fromJSON()` thenable assimilation bypass; TypedArray length memory
  exhaustion) through `solid-js`, a devDependency pinned at exactly `1.9.15` in `D:\git\omr-cpx-main\package.json` to
  match the host typings (`@opencode/plugin@2.0.22` → `solid-js@1.9.15`). No CI workflow runs `npm audit`. The TUI
  plugin only renders; it deserializes no untrusted seroval input. A `solid-js` bump is a TUI compatibility decision
  outside this plan's scope; reported to the owner, not changed here (QA-0.P confirmed the disposition).

## QA

### Round 1 (heavy reviewer, session `ses_ed7ffbdc8ffe4mtPc6Vrr3VI5Y`, at `d39a700`) — 14 findings (3 major, 10 minor, 1 nit)

| Id | Sev. | Finding | Fix |
|---|---|---|---|
| QA-0.P-1 | major | Literal `workRoots` entries for not-yet-existing scratch/e2e dirs are dropped at plugin start | Globs `D:/git/omr-cpx-scratch*`, `D:/git/omr-cpx-e2e*`; validated (`problems: []`); plan 0.P.3.c amended |
| QA-0.P-2 | major | 0.P.4 missed six Phase 2.4 anchors into `reference.ts`; not recorded in the handover | Table completed above (incl. the rewritten drift region and step 7b); copied to handover §7 |
| QA-0.P-3 | major | Three tests reported at 80-98 % of the 5 s default with no explicit timeout | **Not reproduced:** the two `v2-hooks` tests already pass `BOUNDED_LIMIT_TIMEOUT_MS` (30 s, `test\unit\v2-hooks.test.ts` ≈37), and the `roles.registration` test sits in `describe(…, { timeout: 60_000 })`. A per-test `30_000` added by the round-1 fixer (`9c8efd6`) *lowered* that timeout and was reverted (`674f037`). No change needed |
| QA-0.P-4 | minor | Anchor row labelled Phase 3.2; it is Phase 2.2 | Relabelled |
| QA-0.P-5 | minor | Handover stale/missing fields (upstream, consent state, dispatch times and Reads, anchors, amendments) | Handover §1/§7 updated; deviations recorded as amendments |
| QA-0.P-6 | minor | Self-check "newest log file" criterion does not fit a shared log; run id method unrecorded | Plan 0.P.6 amended (marker command → run id; one df load, zero main-checkout loads, versioned exe); re-run above |
| QA-0.P-7 | minor | `smoke:keyless` also needs the v1 `PATH` prepend | Recorded for every v1 smoke; preflight script proven |
| QA-0.P-8 | minor | User-scope `OPENCODE_V2_BIN` is unlisted shared state | User-scope value removed; set in the launch command and per shell run |
| QA-0.P-9 | minor | Host launched through the moving `current` shim | Launch command uses the versioned exe; DF self-checks check the server executable |
| QA-0.P-10 | minor | Dogfood worktrees are valid work roots; the guard only checks the main checkout | Plan §0.4 and handover §2 guard extended to `D:\git\omr-cpx-dogfood-` and the cross-repo worktree |
| QA-0.P-11 | minor | Revert command fits DF-0 only | DF-0 and DF-n reverts recorded separately |
| QA-0.P-12 | minor | `py -3` commands not recorded | Recorded with output |
| QA-0.P-13 | minor | Baseline not reproducible (files, skipped tests) | 49 paths and the 2 skipped tests listed |
| QA-0.P-14 | nit | Hard-link "stay in sync" overstated | Caveat and per-switch regeneration recorded |

### Round 2 (heavy reviewer, session `ses_ed7ed7507ffeGyZbT2YjMmOSjj`, at `add3cd4`) — 9 findings (3 major, 3 minor, 3 nit)

Round-1 fixes judged correct except where these findings say otherwise.

| Id | Sev. | Finding | Fix |
|---|---|---|---|
| QA-0.P-15 | major | Global-override edits are live at the next prompt of every running router, not "at the next host start"; effect on the other implementation unrecorded; DF-2 executor keys would reach it too | Statements corrected (here, handover §7, plan 0.P.3.c); effect recorded and told to the owner; DF-2 pre-flight amended with an owner notice; ROLES.md wording handed off to Phase 2.1 (PF-2) |
| QA-0.P-16 | major | DF1.4.a / DF2.4.0 were not amended and rely on a router log line with no defined, run-tagged sink | DF1.4.a and DF2.4.0 amended in place (run-scoped check; Reads = `opencode.log`); 2.1.5.f must record its sink, checked by Phase 2.1 QA; the line is supporting evidence only |
| QA-0.P-17 | major | `OPENCODE_CONFIG_DIR` leaks into v1 smoke hosts | v1 merge proven by probe; per-shell removal recorded; deferred-catalog smoke host fixed (`46dac26`), smoke 1/1 with the variable set. **Post-close correction (Phase 0.1 pre-flight):** `46dac26` changed a v1-frozen file (scenario `6-v1-untouched` pins it to `bd1ecd1`) and was reverted in `9943abe`; the per-shell removal is the mitigation |
| QA-0.P-18 | minor | Self-check allowed a second router build, ignored `.k` builds, no nonce freshness, guard clash | Plugin-set equality with the exact entrypoint, fresh nonce + newest line, rollback to the last passing build (plan 0.P.6, Wave-6 fallback, handover) |
| QA-0.P-19 | minor | Dispatch-log times contradict commit times | Times restated as commit-time bounds; `Get-Date` at every dispatch boundary from now on; self-check run window recorded |
| QA-0.P-20 | minor | Guard is literal-text and its scope is stated three ways | Plan §0.4 and handover §2: normalized-path prefix match, one scope list, prose and log patterns allowed |
| QA-0.P-21 | nit | Two stale handover statements | Fixed |
| QA-0.P-22 | nit | Runtime skip gates not listed | Listed under 0.P.2 |
| QA-0.P-23 | nit | Switch sync ignores files added later | Switch mirrors the top-level entries |

### Round 3 (heavy reviewer, session `ses_ed7d93d91ffeKN16UPoxY33h3p`, at `093ade6`; the last round, limited to the fixes of QA-0.P-15, -16, -17)

QA-0.P-15, -16 and -17: **fixed** (evidence in the review). One new finding:

| Id | Sev. | Finding | Fix |
|---|---|---|---|
| QA-0.P-24 | major | The plugin-set equality rule fails the recorded DF-0 baseline (telegram is listed but never loaded); the exception lived only in the handover | Plan 0.P.6 amended: `D:\\git\\opencode-telegram-plugin` may be absent, nothing outside the list may appear; DF1.4.a and DF2.4.0 inherit it by reference; DF-0 record updated. Verified against the run `461f3bf1` evidence (no further review, §0.7) |

## Deferred findings

Recorded after round 2 (§0.7: minor and nit are not fixed after round 2). Each is re-checked by the DF-1 pre-flight
(the first step that depends on it), which fixes what it finds.

- QA-0.P-25 (minor): handover §4.1 "New worktrees need authority" still says a new worktree gets authority only through a
  glob or after a restart; a refresh after a config change also re-registers (same correction as PF-2).
- QA-0.P-26 (minor): plan DF-2 pre-flight quotes the notice as "…key: executor"; the actual text is "ignoring unknown
  routing key: routing.executor" (`D:\git\omr-cpx-main\src\router\config.ts` ≈2534, ≈2571). The "no other change" claim
  about the other implementation's build is read from the base code, not from that build.
- QA-0.P-27 (minor): a build that knows `routing.executor` but rejects a value drops override layers at startup
  (`D:\git\omr-cpx-main\src\router\config.ts` ≈2672-2711); before writing the DF-2 executor keys, validate them with the
  DF-2 build's loader.
- QA-0.P-28 (minor): DF1.4.a / DF2.4.0 `git -C <root> rev-parse HEAD` no longer defines `<root>`; it is
  `D:\git\omr-cpx-dogfood-df<n>[.<k>]`.
- QA-0.P-29 (minor): the DF1.4 / DF2.4 Reads lines omit the regenerated
  `$env:LOCALAPPDATA\omr-cpx\opencode-config\opencode.json` that the equality check reads.
- QA-0.P-30 (nit): §0.12-6.1 still says "previous dogfood worktree"; the 0.P.6 amendment ("last build that passed its
  self-check") governs.
- QA-0.P-31 (nit): handover §7 says the other routers' policy now allows `D:\git\omr-cpx-*`; precisely, the five
  patterns, which exclude `omr-cpx-dogfood-*`.

## Verdict

0.P is **done**: QA-0.P has zero open blocking, critical or major findings (rounds 1-3: 24 findings fixed or
dispositioned; QA-0.P-3 not reproduced), 7 minor/nit deferred to the DF-1 pre-flight. Acceptance: `cpx/main` is at the
recorded `origin/master` commit `b716ee9` plus the plan, its README entry, the handover, the QA record and three
test-only pre-flight fixes; every binary, configuration item and authority path is present; anchors are re-based; the
router build is pinned (DF-0, self-check PASS).