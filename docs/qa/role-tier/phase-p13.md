# Phase P1.3 — Structured run tool (`router_run`) — phase report

Issue #84, plan §5 P1.3 (T1.3.1, T1.3.2, T1.3.3), amendment R6 (P-10, P-12, P-18).
Branch `rta/p13`, worktree `D:\git\omr-rta-p13`. Files: `src/router/run-tools.ts` (new),
`src/router/git-tools.ts` (shared runner, work-root resolver, guards), `test/unit/run-tools.test.ts` (new),
`test/unit/git-tools.resolver.test.ts` (new).

## Pre-flight

| Check | Result |
|---|---|
| Worktree | `D:\git\omr-rta-p13` on `rta/p13`, from `origin/rta/main` @ `2ab0c40`; fast-forwarded to `a024bba` (P1.1/P1.4/P1.5 contract commits, `RunConfig`) before the first commit |
| `npm ci` | ok |
| Typecheck | exit 0 |
| Baseline `npx vitest related src/router/git-tools.ts --run --maxWorkers=4` | 98 files passed / 3 skipped; 9093 tests passed / 56 skipped |
| Ownership conflicts | none (P1.3 files only) |
| Base checkout `D:\git\opencode-model-router` | clean |

## Implementation

Commits on `rta/p13` (`git log a024bba..rta/p13`), all with body `Refs #84`:

| Commit | Tier | Purpose |
|---|---|---|
| `e7f9a7e` | heavy | `gitTools({ resolveWorkRoot })` (P-18); `spawnBounded` exported with tail window, merged stderr, settle-on-failure and labels; router_git behaviour unchanged |
| `d5fb29a` | heavy | `routerRunTool(deps)`: allowlisted scripts/commands in the bound work root, `shell: false`, npm via `node npm-cli.js` with pinned flags, G4 executable guards, arg allowlist, hardened env, timeout, 64 KiB bound with redaction, tree kill, exit code to `recordRun`; T1.3.2 header |
| `38f7f82` | medium | T1.3.3 edge-case tests and coverage (timeout/abort trees, spaces, junction/8.3 cwd, Bun node lookup, ComSpec, POSIX seams, tail mode) |
| `2e94d17` | heavy | QA round 1 (git side): explicit `WorkRootAnswer`, `isFullPath`, `mainWorktree`, `workRootGuards`, `killGroupOnSettle` |
| `05988f9` | heavy | QA round 1 (run side): argument confinement, found-path spawning, npm root/.npmrc/argv rules, PATH stripping, UNC refusal, bounded file reads, credential env, rendered cap, residuals |
| `194d11d` | heavy | QA round 2 (git side): bounded pointer reads, guard set (work root always, cwd checkout only, bare repos, win32-only case folding), shared answer type |
| `f0903b1` | heavy | QA round 2 (run side): lexical confinement of glued/separated values and URLs, npm's own ini parser, `--userconfig`/`--globalconfig` pins, real-path PATH check, `..` in operator paths, shared `WorkRootAnswer` for router_run |
| `0c1cd26` | heavy | QA round 3: single-dash path rule, `globalconfig`/`userconfig`/`prefix` `.npmrc` refusal, version-probed `${VAR?}` control |

Exported API (final): `routerRunTool`, `RunToolDeps` (`config`, `resolveWorkRoot: (sessionID) => WorkRootAnswer`,
`recordRun?`, `envPassthrough?` (removed in P3.3, QA-G-A2-6 / R10(3)), seams `nodeExecPath?`/`platform?`/`env?`), `RunRecord`, `planRun`, `executeRunPlan`,
`authorizeCwd` and the resolution/validation helpers; in git-tools: `WorkRootAnswer`, `GitWorkRootResolver`,
`checkWorkRootAnswer`, `workRootGuards`, `mainWorktree`, `isFullPath`, `readBoundedRegularFile`, `spawnBounded`.

## Tests

| Run (Windows, pwsh 7, Node 24.21, npm 11.19) | Result |
|---|---|
| `npx vitest run test/unit/run-tools.test.ts test/unit/git-tools.resolver.test.ts test/unit/git-tools.test.ts --maxWorkers=4` | 3 files passed; 217 tests passed / 11 skipped |
| `npx vitest related src/router/run-tools.ts src/router/git-tools.ts --run --maxWorkers=4` | 100 files passed / 3 skipped; 9179 tests passed / 67 skipped |
| Coverage `run-tools.ts` (last measured after round 2) | 97.1 % statements, 93.71 % branches, 100 % functions, 98.08 % lines (gate ≥ 90 % branches) |
| Typecheck | exit 0 before every commit |

Pending Linux CI (POSIX-only, skipped on Windows): process-group kill of a background child and its I1 control,
FIFO and `/dev/zero` `package.json`, FIFO `.git` pointer, Homebrew npm-cli layout and found-path node, `/bin/sh` as
found, case-sensitive guard dedupe, PATH node linked to bun, `../lib/node_modules/npm`, signal-killed exit code.
Windows-only tests (8.3 cwd, UNC admin share, ComSpec, cmd.exe current-directory lookup) skip on Linux; the UNC and
8.3 tests also skip themselves when the share or short names are unavailable.

Positive controls in the suite prove each defended attack is real on the npm under test: repo `.npmrc`
`script-shell`/`node-options` (`npm config get`), planted userconfig/globalconfig, workspace spellings (npm's own
ENOWORKSPACES), userconfig redirect, planted global file beating `--globalconfig`, cmd.exe current-directory lookup.

## Findings

| Id | Severity | Finding | Fix |
|---|---|---|---|
| QA-P13-1-1 | major | Arg patterns did not confine paths (`..`, absolute, `@file`, `+opt`) | `05988f9` |
| QA-P13-1-2 | major | Background child of a normally exiting run escaped the timeout | `2e94d17`, `05988f9` |
| QA-P13-1-3 | major | Executables/shell spawned by realpath (busybox, bash sh-mode, Volta); Homebrew npm-cli; any ComSpec | `05988f9` |
| QA-P13-1-4 | minor | npm could leave the root (`workspace=`, walk-up, logs) | `05988f9` |
| QA-P13-1-5 | minor | node/npm by path, `#!/usr/bin/env node` via PATH, `npm exec`, npm option overrides | `05988f9` |
| QA-P13-1-6 | minor | Main checkout of a sibling worktree and plugin checkout not guarded | `2e94d17`, `05988f9` |
| QA-P13-1-7 | minor | UNC root made cmd.exe run in %SystemRoot% | `05988f9` |
| QA-P13-1-8 | minor | `package.json` read could block/OOM (FIFO, `/dev/zero`) | `05988f9` |
| QA-P13-1-9 | minor | Credential env reached scripts; description claimed redaction | `05988f9` |
| QA-P13-1-10 | minor | Resolver `undefined` failed open; root-relative paths accepted | `2e94d17` |
| QA-P13-1-11 | minor | Tests lacked positive controls, real worktree, I1 equality, 8.3 skip | `2e94d17`, `05988f9` |
| QA-P13-1-12 | nit | Header residuals missing | `05988f9` |
| QA-P13-1-13 | nit | 64 KiB bound before decoding (U+FFFD expansion) | `05988f9` |
| QA-P13-2-1 | major | Paths via glued short options, later `=`, `:`/`@`/`+`, URLs | `f0903b1` |
| QA-P13-2-2 | minor | `.npmrc` check bypassable vs npm's ini; userconfig/globalconfig movable | `f0903b1` |
| QA-P13-2-3 | minor | Guard set (cwd itself, bare repos, work root, case, PATH real paths) | `194d11d`, `f0903b1` |
| QA-P13-2-4 | minor | `.git`/`commondir` read unbounded | `194d11d` |
| QA-P13-2-5 | minor | Missing tests (2-1, 2-2, real worktree run, cmd.exe control) | `f0903b1` |
| QA-P13-2-6 | nit | Reachable agents/credential stores undocumented | `f0903b1` |
| QA-P13-2-7 | nit | `..` in operator executable paths normalised | `f0903b1` |
| QA-P13-2-8 | nit | router_run resolver not the shared `WorkRootAnswer` | `194d11d`, `f0903b1` |
| QA-P13-3-1 | major | Short-option clusters carry paths at any offset (`-br../evil.js`) | `0c1cd26` |
| QA-P13-3-2 | major | `${VAR?}` control assumed a modifier npm 10.9.9/11.5.1 lack | `0c1cd26` |
| QA-P13-3-3 | minor → major (executor) | Project `.npmrc` `globalconfig` beats `--globalconfig`; planted global file unchecked | `0c1cd26` |

Rounds: 1 FAIL (3 major, 8 minor, 2 nit; all fixed) · 2 FAIL (1 major, 4 minor, 3 nit; all fixed) ·
3 FAIL (2 major + QA-P13-3-3 upgraded to major; fixed in `0c1cd26`) · 4 PASS.

Accepted (QA round limit):

| Id | Severity | Finding | Reason |
|---|---|---|---|
| QA-P13-3-4 | nit | `loadNpmIni` cache returned before the guard check | Harmless: the key is the npm install directory, and `resolveNpmCli` guards the install before every use |
| QA-P13-4-1 | minor | Single-dash drive-relative value without a slash (`-xoC:x`) | getopt-style parsers only; drive-relative, no directory separator |
| QA-P13-4-2 | nit | Single-dash rule over-refuses relative glued values (`-r./x.js`) | Intended and documented: paths go through checked `--long=value` |

## Handoffs

| To | Item |
|---|---|
| P2.1 | Register `routerRunTool(deps)` and `gitTools({ resolveWorkRoot })`; both take `(sessionID) => WorkRootAnswer` (`{ role: false }` / `{ role: true, root: string \| null }`); router_run refuses `{ role: false }` |
| P2.1 | List `router_run` and `router_git_*` explicitly in role agent allows (P-12); the tools still check authority themselves |
| P2.1 / P1.4 | Wire `recordRun` to the P1.4 `run` signal (`at` = run start; `exitCode: null` on timeout/abort/signal) |
| P2.1 | Residual: a user-owned `~/.npmrc` `globalconfig` still outranks `--globalconfig` (outside every work root) |
| P3.2 | Document `routing.run`: `commands.args` patterns (exact or trailing `*`, same option lead), the single-dash rule, npm commands limited to run/run-script/test/start/stop/restart with safe flags, package.json scripts take no caller args, pre/post hooks run, refused `.npmrc` keys, credential env stripping with `envPassthrough` (removed in P3.3, QA-G-A2-6 / R10(3)), and what stays reachable (ssh-agent, credential helpers, cloud CLI caches) |
| P3.1 | Run the POSIX-only tests on Linux CI (list under Tests) |

## Takeovers

None. Two transport failures ("socket connection was closed", OpenCode anthropic-fix bridge) interrupted dispatches
before any work; both were resumed in the same session.

## Verdict

**PASS** — 0 open blocking, critical or major findings after QA round 4; three accepted items recorded above.
