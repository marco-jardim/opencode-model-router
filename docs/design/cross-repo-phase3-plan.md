# Cross-repo Phase 3: implementation plan

Design: `docs/design/cross-repo.md` §7 "Phase 3" (`:478-482`). Issue #107. Pre-flight at HEAD `67fe82b` (2026-10-12), branch `feat/cross-repo`. Three architect pre-flights (one per item) plus an orchestrator spike for item (a).

Phase 3 has three independent items, shipped as three lots in this order (each lot: test-first, one task per commit, `Refs #107`, two heavy adversarial QA rounds, then its live dogfood):

1. **Lot 1, item (b):** a read-only `root` argument for `router_git_*` (smallest blast radius: new module plus tool wiring, no verification-engine change).
2. **Lot 2, item (a):** a consumer `testsPass` scoped with `vitest related` across a link.
3. **Lot 3, item (c):** dependency edges outside `node_modules`.

A full `npx vitest run` with nothing else running and `test/golden` run at the end of the phase.

## Owner decisions

Decision numbers continue the design's §11 (last: D19). Recommendations first.

| # | Item | Question | Recommendation |
|---|---|---|---|
| OD-P3b-1 → D20 | (b) | What may `root` name? (a) absolute top-level path only; (b) absolute path or a bare name with the route-line `repo=` semantics (D16), no `branch`; (c) `root` + `repo` + `branch` arguments | (b) |
| OD-P3b-2 → D21 | (b) | Who may use `root`? (a) role agents with an exact binding and a local read action; (b) also tiers and the orchestrator | (a) |
| OD-P3a-1 → D22 | (a) | How does a consumer `testsPass` opt in? (a) explicit `scope=affected` only; (b) default for a foreign `testsPass` without `scope=`; (c) ship nothing | (a) |
| OD-P3a-2 → D23 | (a) | Ignored build output in W (`dist/`): (a) dispatch-time digest of W's ignored files, a change → S6; (b) gate-time bounded list of W's ignored JS/TS/JSON files added to the related inputs; (c) documented limit | (b) |
| OD-P3c-1 → D24 | (c) | Which edge kinds ship? (a) Tier A: `package.json` path specs, tsconfig, Python editable installs in an in-repo venv, Go `replace`/`go.work`; (b) A + Tier B; (c) JS/TS only | (a) |
| OD-P3c-2 → D25 | (c) | Q2: approximate reference for edges leaving the repository? (a) close Q2 as a documented, narrower limit; (b) fail closed in the shared engine (both hosts); (c) same, v2 only | (a), (b) recorded as follow-up |
| OD-P3c-3 → D26 | (c) | A dependency added during the dispatch: (a) keep "changed" at `router_verify`; (b) re-read W's dependency targets at return and freeze new admitted ones | (b) |

**Decided by the owner (2026-10-12): every recommendation above.** D20 = OD-P3b-1 (b), D21 = OD-P3b-2 (a), D22 = OD-P3a-1 (a), D23 = OD-P3a-2 (b), D24 = OD-P3c-1 (a, Tier A), D25 = OD-P3c-2 (a, Q2 closed as a documented limit; fail-closed recorded as a follow-up), D26 = OD-P3c-3 (b, P3c.6 ships).

Settled by the orchestrator (not asked): **SD-P3a-12** (was OD-P3a-3): the configured roles protocol is not changed to teach `scope=affected`; the configured golden stays as is. Revisit after the lot 2 dogfood.

---

# Item (b): a read-only `root` for `router_git_*`

## Decided without owner input

- **SD-3b-1 (I9, v1 freeze).** The `root` argument and the longer description are registered only on v2, in roles mode, when `routing.repoParents` is non-empty at plugin start (the tool map is fixed at start, `index.ts:1181-1184`). Everywhere else schema and description stay byte-identical. v1: inert by construction (`rolesAtStart` false, `index.ts:540`, `:1387`); no new notice (`ROLES_V1_NOTICE`, `config.ts:3238-3246`).
- **SD-3b-2 (I10, I12).** A target must be in the read set R and admitted. R first (filesystem only, no git), then admission (git-based). Git never runs in an unadmitted repository.
- **SD-3b-3 (I11).** A path is gated as text before any filesystem call (as `admission.ts:20-22`, `:498-512`): only W, a path below a parent, or a working-set worktree go on. A junction from outside the parents into R is refused (deliberately stricter than `read`).
- **SD-3b-4.** `root` equal to W (text or canonical) behaves exactly like no `root` (byte-identical output, subdirectory scope kept). `root` inside W but not W is refused with a `path=` hint.
- **SD-3b-5.** `root` needs a local read action (`read`, `glob` or `grep`) in the grant (`v2-hooks.ts:670-677`: `router_git` alone keeps W only).
- **SD-3b-6.** Reuse the role hardening unchanged: `roleRepository`/`verifyRoleRepository` with `dispatchRepository` = the admitted repository (`git-tools.ts:978-1015`); executable guards `workRootGuards(target) ∪ workRootGuards(W)` (`:420-433`, `:1033`); no subdirectory scope; `path` relative to the target.
- **SD-3b-7.** On success the **first** line is the read-provenance line, same format as reads (`index.ts:2493-2501`): `[router: read from <name> (<branch|detached>) at <worktree> — read-only in this dispatch]`. First, because the host truncates large `router_git` output. Built by the resolver with `displaySafe` (`read-set.ts:57-63`) to avoid a `git-tools.ts` → `read-set.ts` cycle.
- **SD-3b-8.** One 15 s deadline per call covers resolution and inspection; abort honoured (`GitInspectOptions.deadlineAt`).
- **SD-3b-9.** Admission reasons are reused with `: no work root.` replaced by `; nothing ran.`. Name refusals are the tool's own texts, built from a new `admission.find()`.
- **SD-3b-10.** No change to the dispatch header, protocol or role prompts; existing goldens unchanged; one new schema golden.
- **SD-3b-11.** No second check in `execute.before` (plugin tools get no `evaluate`, `v2-hooks.ts:1137-1139`); the resolver is the single control and fails closed.

## Pre-flight findings

| # | Sev. | Finding | Resolution |
|---|---|---|---|
| F1 | major | Role `router_git_*` resolve only W (`index.ts:584-601`, `git-tools.ts:1164-1178`); strict schema with `path`/`ref`/`limit`/`mode` (`:1150-1163`). | 3b.3, 3b.4 |
| F2 | major | One `gitTools()` definition serves both hosts; the v2 adapter re-registers it (`v2-hooks.ts:1472-1477`, `index.ts:1385-1387`). An unconditional argument would change v1. | SD-3b-1 |
| F3 | minor, unverified | The tool parses strictly (`git-tools.ts:1154`) but the host's object schema may strip unknown keys, so an invented `root` may silently run in W. | Dogfood step 0 settles it. |
| F4 | major | Plugin tools have no host permission backing (`v2-hooks.ts:1137-1139`). | 3b.2, 3b.3 fail closed |
| F5 | major | R is filesystem-only (`read-set.ts:1-15`, `:227-255`); admission is git-based (`admission.ts:6-24`). | SD-3b-2 |
| F6 | major | For a working-set member R returns the main worktree (`read-set.ts:240-242`), not the matched one. | Use admission's `location.worktree` (`admission.ts:392-395`). |
| F7 | minor | Provenance covers only `read`/`glob`/`grep` (`index.ts:624-651`). | SD-3b-7; test no second line. |
| F8 | — | Role hardening reusable (`git-tools.ts:978-1015`, `:1030`, `:1038`, `:1048-1053`). | SD-3b-6 |
| F9 | minor | Admission notes are route-line worded (`admission.ts:401-411`, `:574`, `:580`, `:639-647`); `lookup` not exported (`:671`). | SD-3b-9, 3b.1 |
| F10 | minor | The admission memo lives in a closure (`dispatch.ts:1616-1625`). | Memo in 3b.4, lazy import like `dispatch.ts:1621-1622`. |
| F11 | minor | Orchestrator lookup duplicated (`index.ts:640-646`, `v2-hooks.ts:1021-1028`). | `orchestratorOf(sid)` (3b.4). |
| F12 | minor | `resolveWorkRoot` does not check the binding kind (`index.ts:586`). | `root` requires an exact binding. |
| F13 | major (docs) | Design and docs confine `router_git` to W: I1 (`cross-repo.md:178`), model table (`:33-34`), `ROLES.md:174-175`, `:204-207`, `:301-313`, `:325`. | 3b.6, 3b.7 |
| F14 | — | No golden covers tool schemas; header golden pins the repositories paragraph (`dispatch-header.golden.test.ts:39-60`). | New schema golden (3b.3). |
| F15 | minor | `inspectGit` starts its own 15 s budget (`git-tools.ts:1019-1024`). | SD-3b-8 |
| F16 | — | The tools are non-writing by exact name (`verify/dispatch.ts:197-200`); hardening never writes `.git` (`git-tools.ts:145-159`). | Tests: `.git` digest and index mtime unchanged. |
| F17 | nit | Stale refs: `cross-repo.md:420` cites `git-tools.ts:953-963` (now `:978-990`), `index.ts:1312` (now the `gitTools` registration, `:1460` after 3b.4), `resolveWorkRootFor (:567-572)` (now `:593-601`). | 3b.7 |

## Contract: resolution order and texts

All refusals start with `[router_git] error: refused: `. Echoed values go through `displaySafe`. Steps 1–3 make no filesystem call on the value and spawn nothing. Since QA-1 F1, step 3 may resolve the configured parents (never the value), so a `root` in the canonical spelling of a junctioned parent is accepted.

1. **Session gates.** Not a role session: `root is only for role agents (roles mode); this session inspects its own repository: omit root`. No exact binding / no work root / no `router_git` in the grant: the existing `this role session has no bound work root (I9)`. No local read action: `root reads another repository and needs read, glob or grep in this dispatch's grant (<actions>); router_git alone stays in the work root`. Parents removed by hot reload: `root needs routing.repoParents (cross-repo is not configured); nothing ran`.
2. **Text checks** (`root=<v> <problem>; pass the absolute top level of a repository or its name`): surrounding whitespace; > 4096 chars; `rootTextProblem` (`admission.ts:217-233`); any `.git` segment (`read-set.ts:28-30`); a bare name failing `repoNameProblem` (`:235-242`) or `.git`.
3. **Text gate (path).** Equal to W → W path; inside W → `root=<v> is inside your work root <W>; omit root and pass path=<rel>`; below a parent or equal to a working-set worktree → continue; else `root=<v> is outside this dispatch's read set (the work root, the session's repositories and the repositories below <P>); nothing ran`.
4. **Realpath** (`realpathSync.native` + directory) else `root=<v> is not a directory; nothing ran`; canonical re-checked against W.
5. **R membership** else `root=<v> resolves to <real>, outside this dispatch's read set; nothing ran`.
6. **Top level.** `root=<v> is inside the repository at <top>; pass root=<top> and path=<rel>`.
7. **Admission** with `known` = session directory, grant `location.repository`, working-set worktrees; mapped refusal (SD-3b-9); then `location.worktree` must equal the canonical path, else `root=<v>: the admitted worktree <wt> resolves to <real>; nothing ran`.
8. **Name** (if OD-P3b-1 = b): `admission.find(name)`: 0 → `root=<name> matches no repository below routing.repoParents (searched <list>); nothing ran`; > 1 → `root=<name> matches <n> repositories: <paths>; nothing ran. Pass root as one of these absolute paths`; several worktrees → `root=<name> has <n> worktrees: <path> → <branch>; …; nothing ran. Pass root as one of these absolute paths`; else the worktree goes through steps 3–7.
9. **Deadline/abort.** `root=<v>: resolving the repository timed out; nothing ran` / `… was aborted; nothing ran`.
10. **Inspection errors.** `[router_git] error: root=<v>: <existing redacted message>`.

Security: `root` is only the spawn `cwd`, never a git argument; a name joins as one segment; UNC/device/8.3 refused before any filesystem call; gitdir redirection caught by the common-dir check (`git-tools.ts:983-988`, `:1004-1014`) and re-checked at spawn (the F2 checks, `23f404b`); no git executable from W or the target; existing hardening (hooks, fsmonitor, drivers, `GIT_*` stripped, ceiling) unchanged; nothing written (`--no-optional-locks`, `GIT_OPTIONAL_LOCKS=0`, `diff.autoRefreshIndex=false`).

## Tasks (lot 1)

Each task: tests first, one commit, `npm run typecheck` plus the touched test files. Behaviour does not change until 3b.4 wires the resolver.

- **3b.1** `refactor(admission): expose the repo= lookup as find()`.
  - Tests: `test/unit/admission.test.ts` "admission without git" (`:94`): `find(name)` returns the candidates `resolve()` uses (repository name, worktree directory, refused notes, capped); "Q10 (real git)" (`:335`): `find()` keeps a repository and a same-named worktree directory apart. Existing `resolve` tests unchanged.
  - Code: `src/routing/roles/admission.ts:88-93` (`find`, export `AdmissionLookup`), `:235` (export `repoNameProblem`), `:671` (`{ admit, resolve, find: lookup }`). `dispatch.ts:270` keeps `Pick<…, "admit" | "resolve">`.
- **3b.2** `feat(roles): resolve a router_git root against the read set and admission`.
  - Tests: new `test/unit/git-root.test.ts` (fake deps, no git): every step-2 refusal with zero realpath/admission calls (spies); text gate cases; not a directory; canonical outside R (junction via fake realpath); top-level hint; admission refusal mapping (incl. a `repoDepth` reason without "no work root"); worktree drift; success with provenance; name cases (0, many, several worktrees, worktree directory, single); `displaySafe`; deadline and abort.
  - Code: new `src/routing/roles/git-root.ts`: `resolveGitRoot(value, { workRoot, parents, workingSet }, deps)` → `{ ok:false, reason } | { ok:true, inWorkRoot:true } | { ok:true, inWorkRoot:false, root, repository, name, branch, workRoot, provenance }`; exports its text fragments for docs-drift.
- **3b.3** `feat(git): optional read-only root argument for router_git_*`.
  - Tests: new golden `test/golden/git-tools-schema.golden.test.ts` (without a resolver every tool's keys and description equal today's, `git-tools.ts:1156-1162`; the configured form pinned too); new `test/unit/git-tools.root.test.ts` (real git, temp repos, spawn spy): `root` without a resolver → error, no spawn; refusal → `refused: …`, no spawn; `inWorkRoot` byte-identical; success → provenance first, then the other repository's status/log/ls-files; `path` relative to the target, sensitive path still refused; common-dir mismatch; guard union rejects a git executable inside W; malformed answer fails closed; target `.git` digest unchanged (`git-tools.test.ts:737-741` pattern).
  - Code: `src/router/git-tools.ts:14-23` (`deadlineAt?`), `:1019`, `:1110-1124` (`GitRootAnswer`, `GitRootResolver`, `GitToolsOptions.resolveRoot?`), after `:1145` (`checkGitRootAnswer`), `:1150-1163` (`root` + description suffix only with `resolveRoot`), `:1164-1183` (root branch). Suffix: ` Role agents may set root to inspect another repository they may read (its absolute top-level path, or its name below routing.repoParents).`
- **3b.4** `feat(roles): wire router_git root in roles mode on OpenCode v2`.
  - Tests: `test/unit/roles.runtime.test.ts`, new describe after `:747` (fixture `:630-660`): registration (v2 roles + parents has `root`; v2 roles without parents and `plugin(dir,"v1")` unchanged); orchestrator and tier refused; unbound/intersection bindings → I9 text; grant without a read action refused; exact binding with absolute path or name succeeds; `root` = W identical to omitting it; `repoExclude` refused; working-set worktree outside the parents allowed; no second provenance line; zero spawns on refusals.
  - Code: `src/index.ts:640-646` (`orchestratorOf`), after `:601` (`resolveGitRootFor`, lazy admission memo), `:1184-1187` (`crossRepoAtStart`), `:1387` (`resolveRoot` only when `crossRepoAtStart`).
- **3b.5** `test(roles): router_git root through junctions, worktrees and the perimeter`.
  - New `test/integration/git-root.test.ts`: junction below a parent leading out → step-5 refusal; junction from outside into R refused with no realpath on it; linked worktree in the working set outside the parents works; index mtime and status unchanged. `test/integration/perimeter.test.ts`: a child's `router_git` with `root` into a perimeter repository adds no I4/I5 caveat.
- **3b.6** `docs(roles): document the router_git root argument`.
  - Test: `test/unit/docs-drift.test.ts` near `:1293`, `it("P3b: router_git root …")` pinning the `git-root.ts` fragments in `ROLES.md` and the changelog entry.
  - Docs: `ROLES.md:204-207`, `:301-313` (`.git` files still never read; `router_git` reads history through hardened git), `:325`; `READ_ONLY_TIERS.md:115-127`; `CONFIG_REFERENCE.md:1064`; `CHANGELOG.md` `[Unreleased]` Added: **`router_git_*` in other repositories (OpenCode v2, roles mode; inert on v1) (#107).**
- **3b.7** `docs(design): record Phase 3b and its decisions`.
  - Test: docs-drift `| D20 |`/`| D21 |` design pins (`:1331-1332`).
  - `cross-repo.md:33-34`, `:178` (I1 amended), `:420` (F17), `:478-482` (implemented note), §9 limits below, §11 D20/D21.

§9 limits: names resolve only below the parents; `root` reaches working-set worktrees outside the parents where the host's static catch-all deny (Q7) blocks `read`; a junction from outside into R is refused for `router_git` but allowed for `read`; inspection errors keep their work-root wording behind `root=<v>:`; a bare main repository is refused; the provenance branch can be up to 5 s stale (admission cache); F3 until dogfood step 0.

## Live dogfood (lot 1)

Scratch repositories `D:\git\omr-xr-dogfood-lib` (`main` at `2d133c4`) and `D:\git\mcp-reader`. If `root` is missing from a role's schema after 3b.4, ask the owner for a restart (the tool map is fixed at start).

0. **Before 3b.3.** Explorer: `router_git_log {root:"D:\\git\\omr-xr-dogfood-lib", limit:1}` raw. A strict-parse error or this worktree's log (the host stripped the key): settles F3.
1. Absolute path: `router_git_log`/`status`/`ls_files` with `root:"D:\\git\\omr-xr-dogfood-lib"` → first line `[router: read from omr-xr-dogfood-lib (main) at D:\git\omr-xr-dogfood-lib — read-only in this dispatch]`, log `2d133c4`, empty status. Shell: lib `status --porcelain` and `.git\index` LastWriteTime unchanged.
2. Names: `root:"omr-xr-dogfood-lib"` same output; `root:"mcp-reader"` its provenance.
3. `root` = this worktree: identical to no `root`, no provenance.
4. Worktrees: `git -C D:\git\omr-xr-dogfood-lib worktree add -b dogfood-p3b D:\git\omr-xr-dogfood-lib-p3b`; the name → "has 2 worktrees"; `omr-xr-dogfood-lib-p3b` → `(dogfood-p3b)`. Cleanup: `worktree remove`, `branch -D`.
5. Refusals: `C:\Windows`, `D:\git` (step 3); `..\mcp-reader`, `\\localhost\c$\x`, `D:\git\omr-xr-dogfood-lib\.git` (step 2); a mcp-reader subdirectory (step 6).
6. Junction out: a scratch repo in `$env:LOCALAPPDATA\omr-cross-repo\p3b-outside`, junction `D:\git\omr-xr-p3b-junction` → it; `root` → step-5 refusal. Cleanup with `cmd /c rmdir` first.
7. Orchestrator and an explicit tier dispatch with `root` → `root is only for role agents …`.
8. Implementer, `VERIFY:required`, `fileExists` probe plus `router_git_status {root:"omr-xr-dogfood-lib"}` → `✓ verified`, no I4/I5 caveat.

---

# Item (a): `vitest related` across a link

Design §6 "Dependency effects" (`cross-repo.md:316-322`). vitest 5.0.3, vite 8.3.1, node v24.21.0.

## Spike result (2026-10-12, orchestrator, pwsh): YES, with a path-spelling amendment

Scratch consumer `app` with a junction `node_modules\p3a-lib` → `lib`, under `%TEMP%\Claude\omr-p3a` (on disk the folder is `Temp\claude`: native realpath and the junction's stored target text differ in case). Each run is `vitest related <paths> --run --passWithNoTests` in the consumer.

| Run | Path passed | Selected |
|---|---|---|
| sanity (`vitest run`) | — | 4/4 pass |
| R0 | native real path of an unimported lib file | none (control) |
| R1, R2, R5 | **native** real path (`realpathSync.native`, `Temp\claude`) of `math.js` / `index.js`, also with `/` | **none** |
| R3 | junction spelling (`app\node_modules\p3a-lib\math.js`) | none (ids with `node_modules` are skipped) |
| R4 | native real path of a lib file the test imports with `../../lib/other.js` | `uses-rel.test.js` |
| R6 | upper-cased path | none |
| R7a/b | `resolve.preserveSymlinks: true`, real / junction | none / none |
| R8a | `libdist\src\index.js` (consumer loads `dist/`) | none |
| C1, C3 | real path **as the junction stores it** (`Temp\Claude`), cwd either spelling | `uses-lib.test.js` |
| C4 | `fs.realpathSync` (JS, not native) of the link path | `uses-lib.test.js` |
| C5 / C6 | `libdist\dist\index.js` / `libdist\src\index.js`, junction spelling | `uses-dist.test.js` / none |
| B1 | this worktree's real config, junction `node_modules\omr-xr-dogfood-lib` → `D:\git\omr-xr-dogfood-lib` (case matches disk), native real path of `index.mjs` | `zz-p3a-spike.test.ts` only, 6.2 s |
| B2 | same, junction spelling | none, 5.2 s |

Conclusions:
- vitest follows the link: vite resolves the junction with JS `fs.realpathSync`, which keeps the **junction's stored target text** (its case), and vitest matches the related set by exact string. The pre-flight's SD-P3a-2 (native realpath only) fails whenever the junction target was written with a different case than the disk (R1 vs C1/C4). **Amended SD-P3a-2:** pass every changed W file in the union of spellings: its native real path; W's top as the gate knows it + the relative path; and, for every consumer link into W found by consumer discovery, `fs.realpathSync(<link>)` (JS) + the relative path. Duplicate spellings are harmless (a superset); the zero guard (SD-P3a-3) is the backstop.
- `preserveSymlinks: true` defeats it entirely (documented limit, caught by the zero guard).
- A consumer that loads `dist/` is selected only through the built file (OD-P3a-2).
- A relative `../` import outside the consumer root is followed (R4): supports SD-P3a-6 and item (c).
- Cost here: about 6 s for a related run over this repository's whole test graph, against minutes for `scope=full`.
- The spike left nothing behind (both trees `status --porcelain` empty; junctions removed with `cmd /c rmdir`).

## Decided under existing decisions

- **SD-P3a-1.** Only an explicit `scope=affected` (normalized `CheckPlacement.scope`, `types.ts:16-21`, `check-placement.ts:87-98`) turns a foreign `testsPass` into a cross-link run (if OD-P3a-1 = a). No `scope=` and foreign `lintClean` keep today's refusal byte-identical (`deterministic.ts:1685-1691`).
- **SD-P3a-2 (amended by the spike).** The union of spellings above; never the junction spelling (ids under `node_modules` are skipped by vitest).
- **SD-P3a-3.** A cross-link run that selects 0 tests is incomplete → unverifiable, never "no affected tests ran" (D7/D12).
- **SD-P3a-4.** vitest only, the major the integration test covers (5, `ResolvedEntry.version`, `runner.ts:1427-1428`); jest, pytest, other majors → S6 `cross-link-unsupported` (design `:322`).
- **SD-P3a-5.** The cross-link root is W's git top: `artefact.changeRoot`, else `effectiveBaseDir` (`gate.ts:449`). Only changed paths inside it become inputs.
- **SD-P3a-6.** No link requirement: vitest's own graph does discovery (`../` and alias edges count, R4); the zero guard is the backstop.
- **SD-P3a-7.** W's own test files dropped with a note; a deleted W file (or rename source) → S6 `cross-link-gone`; G.7 trigger names in W (`package.json`, lockfiles, `tsconfig*.json`, vitest/vite configs) → S6 `config-changed`; G.7a config reads (`runner.ts:4316`) never walk into W; non-input files skipped.
- **SD-P3a-8.** Cross-link requests skip batching, as `full` does (`batch.ts:1766`).
- **SD-P3a-9.** Failures stay unverifiable (F6, `deterministic.ts:1719-1728`), reference stays none (`:1680`), I3 across check roots unchanged (`gate.ts:399-434`, F17), foreign `lintClean` full-only.
- **SD-P3a-10.** v2 roles only by construction (placements exist only there; tier `cwd=` refused, OD1). A test pins that tiers and v1 never set the cross-link root.
- **SD-P3a-11.** Static scoping plans the check with the same option (risk input only).
- **SD-P3a-12.** No protocol change (see Owner decisions).

## Pre-flight findings

| # | Sev. | Finding | Resolution |
|---|---|---|---|
| X1 | blocking | The planner realpaths every candidate and drops anything outside C's git root (`runner.ts:4411-4416`, `canonicalize` `:4284-4289`); all dropped → S6 `attribution-unavailable` (`:4306`). | Y1 `crossLinkRoot` |
| X2 | blocking | `runDeterministic` refuses a foreign non-`full` `testsPass` before the hook (`deterministic.ts:1683-1692`); pinned by `deterministic.test.ts:1143-1152`, `docs-drift.test.ts:1260-1261`. | Y5 flips `:1143-1152` on purpose; refusal text unchanged |
| X3 | blocking (false pass) | A related run with total 0 counts green (`baseline.ts:146-147`, `runner.ts:1081-1083`); the zero guard covers only rerun/test-file/lexical inputs (`runner.ts:5065-5076`); vitest related defaults `passWithNoTests` true. Every cross-link failure mode (spelling, preserveSymlinks, built entry) is 0 tests. | Y2, before the enabling commit |
| X4 | major | vitest 5.0.3 `related` builds a reverse graph from SSR transform deps; ids containing `node_modules` are skipped (`index.DpLw24bj.js:18652-18653`); exact string match (`:18661-18671`); pathe normalizes `\` and the drive letter only. | SD-P3a-2 (spike) |
| X5 | major | vite realpaths package directories unless `preserveSymlinks` (vite `node.js:3182`, `:29336-29338`); the spike shows the id keeps the junction's stored text case. Outside root → `/@fs/<abs>`. | Spike; docs |
| X6 | major | W's change set holds no ignored files (`tree.ts`; design §9 `:569`): a consumer loading `dist/` is not selected by a `src/` change (spike R8a/C6). | OD-P3a-2 |
| X7 | minor | The batch coordinator plans with `{command, cwd, changedFiles}` (`batch.ts:1773`, `wiring.ts:1456-1463`). | SD-P3a-8, Y3 |
| X8 | minor | Static scoping marks every foreign placement S6 `attribution-unavailable` (`wiring.ts:2138-2145`) → "unverifiable" risk reason (`risk.ts:273`). | Y6 |
| X9 | minor | The gate passes foreign placements absolute changed paths (`gate.ts:444-465`) but not the change root (`types.ts:95-139`). | Y5 |
| X10 | info | Graph cost: every consumer test file's imports are transformed (`index.DpLw24bj.js:18600-18609`); B1 = 6.2 s here. | — |
| X11 | minor | Design S8 row (`cross-repo.md:305`) cites `runner.ts:4306`; since P2 refused earlier at `deterministic.ts:1685`. | Y8 |

## Tasks (lot 2; Y5 is the enabling commit and comes after Y1–Y4)

- **Y1** `feat(verify): plan vitest related across a link (cross-link inputs)`.
  - Tests (`test/unit/runner.test.ts`, describe "planScopedRun — cross-link inputs (cross-repo P3a)"): without `crossLinkRoot` an outside path is still dropped and all-outside is still S6 `attribution-unavailable`; with it, a W path becomes inputs in every spelling of SD-P3a-2 (native real, W-top-as-given, JS realpath of each given link), deduplicated, and the argv never contains a `node_modules` segment; a path outside both roots dropped; W test file dropped with a note; gone W file → `cross-link-gone`; W `package.json`/lockfile/`tsconfig*.json` → `config-changed`; jest/pytest/other vitest major → `cross-link-unsupported`; docs only → NoAffected; `spec.crossLink === true` in `mode: "related"`; G.7a never reads under W (fs seam); `planStaticScoping` returns the same S6s.
  - Code (`src/verify/runner.ts`): `PlanScopedRunInput` (`:1493-1505`) gets `crossLinkRoot?` and `crossLinkSpellings?` (link paths into W); `S6Code` (`:1165-1191`) gets `cross-link-unsupported`, `cross-link-gone`; `ScopedSpec` (`:1432-1460`) gets `crossLink?: true`; `plan` (`:4291-4333`), `collectChanged` (`:4395-4427`), `classify` (`:4458-4488`), the `jsConfigFacts` input (`:4316`), `buildSpec` (`:4697`); header G (`:443-464`).
- **Y2** `feat(verify): a cross-link related run that selects no test is incomplete`.
  - Tests (`runner.test.ts` `readResult`): crossLink spec, total 0, exit 0 → `complete: false` with `vitest selected no test in <cwd> for the change in <root>; the link may not be followed (resolve.preserveSymlinks, a built entry, or no test imports the changed files): use scope=full`; total > 0 unchanged; `judgeScoped` → "scoped result is incomplete" (`baseline.ts:154`).
  - Code: `zeroTestsGuard` (`runner.ts:5065-5076`), header I step 2a (`:758-773`).
- **Y3** `feat(verify): carry the cross-link root through the testsPass hook, never batched`.
  - Tests: `deterministic.test.ts` (hook passes `crossLinkRoot`/spellings to the plan; without them the plan input is byte-identical); `batch.test.ts` (a request with `crossLinkRoot` goes to `runtime.direct`, coordinator plan not called).
  - Code: `TestsPassRequest` (`types.ts:363-374`), `deterministic.ts:1311-1320`, `batch.ts:1766`.
- **Y4** per OD-P3a-2. **(b)**: tests `tree.test.ts` `listIgnoredModules` (bounded, no `node_modules`, JS/TS/JSON only, over-bounds) and hook tests (ignored modules added as cross-link inputs; over-bounds → S6 `cross-link-ignored-over-bounds`); code `tree.ts` next to `:198-260` (`IGNORED_LIST_ARGS`), a hardened lister injected through `createDirectTestsPassHook` deps (`wiring.ts:1442-1448`). **(a)**: `baseline-wiring`/`deferred-verification` tests for a dispatch-time `ignoredDigest` of W compared at the gate; `wiring.ts` `observeChange`/`captureDepsFor`, `pending.ts` registration, `tree.ts:181`. **(c)**: nothing; Y8 documents it.
- **Y5** `feat(verify): run a consumer testsPass with scope=affected through the link (v2 roles)`.
  - Tests: `deterministic.test.ts:1143-1152` flipped on purpose (hook called with `testScope: "affected"`, cwd the placement, `crossLinkRoot` = `deps.changeRoot`); `:1128-1141`, `:1154-1166` byte-identical; foreign failure stays unverifiable; no `changeRoot` → old refusal. `gate.test.ts`: deterministic deps carry `changeRoot` (and the consumer link spellings) on the synchronous and deferred paths; v2 tier with per-check `cwd=` never gets it; v1 inert. New `test/integration/cross-link-related.test.ts` with this repo's vitest, a win32 junction (target written with a case that differs from disk, as in the spike) and a posix symlink: S8 with `scope=affected` passes; a lib change breaking the consumer → unverifiable (F6); a lib change no consumer imports → unverifiable (zero guard); jest → S6.
  - Code: `DeterministicDeps.changeRoot?` (`types.ts:95-139`), `deterministic.ts:1683-1692` and `runTestsPass` (`:1497-1513`), `gate.ts:444-465`.
- **Y6** `feat(verify): static scoping plans a cross-link check`.
  - Tests: `wiring.test.ts`, `deferred-verification.test.ts` next to `:741`: a scopable plan gives no "unverifiable" risk reason; jest → S6.
  - Code: `wiring.ts` `staticScoping` (`:2133-2145`, root from `change.snapshot?.root`, `:2239`).
- **Y8** `docs(verify): affected consumer checks across a link`.
  - `docs/VERIFICATION.md:441-457` (new bullet: spellings, zero → unverifiable, `preserveSymlinks`, built output per OD-P3a-2, I3 still needs a check in W) and a note at `:183`; `docs/ROLES.md:363-365`; `CHANGELOG.md` `[Unreleased]` Added; docs-drift pins for the new reasons (`docs-drift.test.ts:1240-1293`).
  - Design: §6 `:316-322` (the spike table), S8 row `:305` (X11), §7 `:480` implemented note, §11 D22/D23.

Risks: vitest internals drift (guards: SD-P3a-4, the Y5 integration test, the zero guard; partial selection is not caught); static imports only (`docs/VERIFICATION.md:183`); cost (X10); this worktree's gate cannot scope its own changes ("attribution-unavailable"), so the lot 2 dogfood uses a scratch consumer.

## Live dogfood (lot 2)

Scratch consumer repository `D:\git\omr-xr-dogfood-app` (vitest devDependency through a junction to this worktree's `node_modules\vitest` or a local install, one test importing `omr-xr-dogfood-lib`), junction `node_modules\omr-xr-dogfood-lib` → `D:\git\omr-xr-dogfood-lib`, both in the working set.

1. `implementer` `repo=omr-xr-dogfood-lib`: edit `index.js` keeping behaviour; `check: fileExists` in the lib plus `check: testsPass cwd="D:\git\omr-xr-dogfood-app" scope=affected` → `✓ verified`, the consumer test ran (selected, not full).
2. Same, breaking the export the consumer uses → UNVERIFIED (consumer check failed), never FAIL.
3. Same, editing a lib file nothing imports → UNVERIFIED with the zero-selection reason.
4. Consumer `testsPass` without `scope=` → today's "must use scope=full" refusal, unchanged.

---

# Item (c): dependency edges outside `node_modules`

No per-repository configuration (D2, `cross-repo.md:653`; alternative C rejected, `:678`).

## Settled decisions (under D2, D4, D6, D18, I8, I11–I13)

- **SD-P3c-1.** New module `src/verify/edges.ts`. `linkedTargets` stays as is (pins use it, F2). A union `dependencyTargets(w, ctx)` is the single source at plan, return and `router_verify` (F1).
- **SD-P3c-2.** New seed origin `"edge"`; a working-set root covered by an edge gets `edged: true`. Edge-only seeds are never pinned (F3); S11 freezes and re-observes them (`isLink` → `isDependency`); a link and an edge into one repository collapse into one `"link"` seed.
- **SD-P3c-3.** Text-first admission (I11): the spec resolves against the declaring file's directory; UNC/device → `unadmitted` with no filesystem call; outside every parent and working-set worktree → same; inside W's top (`gitTopOf(w)`, `perimeter.ts:421`) → skipped; else realpath of the nearest existing ancestor below the parent (catches an unbuilt `dist/`), canonical must stay below the parent, then `gitTopOf(real, parent)` and `admitTop` (`perimeter.ts:484-517`). `node_modules` segments skipped. Python `.pth` lines outside every parent dropped silently.
- **SD-P3c-4. Bounds.** Stat before read, ≤ 1 MiB per file. Forward (synchronous, at dispatch): root files + ≤ 64 workspace packages, `EDGE_FILES_MAX = 128`. Reverse (consumers, async, under the gate/claim deadline): ≤ `WORKSPACE_MANIFESTS_MAX = 256` (`perimeter.ts:146`). `EDGES_MAX = 64` per root. `extends` depth ≤ 4, inside the declaring root. site-packages: one listing ≤ 4000 entries, ≤ 64 `.pth`/finder/`egg-link` files. ≤ 8 unadmitted names in the scope line. Past a forward bound: logged, documented; past a reverse bound: `consumersIncomplete` (existing caveat).
- **SD-P3c-5.** The consumer caveat keeps the pinned `node_modules` literal (`gate.ts:538`, `docs-drift.test.ts:1254`); an edge consumer reads `links this work root (<via>)`, `<via>` from a fixed vocabulary plus the declaring file's relative path through `displaySafe`. Raw specs never echoed.
- **SD-P3c-6.** The scope line format is unchanged (`gate.ts:582-592`).
- **SD-P3c-7.** Malformed files skipped; tsconfig parsed as JSONC; repository code never evaluated.
- **SD-P3c-8.** `dependencyTargets` memoized per `router_verify` call, keyed by W (closes `:619`).
- **SD-P3c-9.** The new-target check at `router_verify` uses frozen admission data and a `gitTopOf` ceiling (closes `:614`).
- **SD-P3c-10.** v2-only by construction (`planPerimeter` returns nothing unless a routed role, `perimeter.ts:404-410`, `:418`); no new config key. Only OD-P3c-2 (b) would reach v1.

## Pre-flight findings

| # | Sev. | Finding | Resolution |
|---|---|---|---|
| F1 | blocking | `router_verify` re-reads only `linkedTargets(wRoot)` (`wiring.ts:2668`); a frozen link not in that list is "changed" (`:2645`). Any frozen edge target would be "changed" every time. | Union function; `isDependency` and the union land in one commit (P3c.4) |
| F2 | major | `linkedTargets` drives nested pins (`pin.ts:36-37`, `:97-104`); widening it turns pins `deep-link` (OD3). | New function |
| F3 | major | `link`/`linked` seeds get a hardened pin snapshot (`wiring.ts:1630-1634`); materialize reads only `node_modules` entries (`reference.ts:1887-1888`). | Origin `"edge"`, not pinned |
| F4 | major | Link discovery realpaths before admission (`perimeter.ts:118`, `:484`); edge specs are repository text (I11). | SD-P3c-3 |
| F5 | major | Fixed (unadmitted) seeds bypass the cap (`perimeter.ts:432-435`). | `EDGES_MAX`, ≤ 8 names |
| F6 | major | Exact-shape consumer assertions (`perimeter.test.ts:1049-1221`), caveat literal (`gate.test.ts:800`, `:829`), docs-drift pin (`:1254`). | `node_modules` consumers keep `{root, name?, entry}`; edge consumers `{root, name?, via}` |
| F7 | major | A dependency added during the dispatch is "changed" at `router_verify` (`cross-repo.md:608`, `wiring.ts:2676-2687`). | OD-P3c-3 |
| F8 | minor | The new-link check calls `gitTopOf(target)` with no ceiling (`wiring.ts:2684`). | SD-P3c-9 |
| F9 | minor | `planPerimeter` is synchronous at dispatch start (`perimeter.ts:403`, `wiring.ts:1614`). | Tight bounds; measure in dogfood |
| F10 | minor | "What S11 does not cover" pinned verbatim (`docs-drift.test.ts:1316`). | Keep; add a sentence with its own pin |
| F11 | info | A relative outside edge cannot get a failure excused (import-time failure → bare-file ID, `runner.ts:750-752`; `baseline.ts:101-111`); only absolute paths load live code into the reference. | Input to OD-P3c-2 |
| F12 | info | Submodules: no snapshot (`tree.ts:390-392`); a nested repository, not an edge. | Excluded |
| F13 | info | Consumer discovery not shared across entries (`:601`); `linkedTargets` per entry (`:619`). | SD-P3c-8 |

Existing bounds unchanged: `PERIMETER_MAX = 16` (`perimeter.ts:37`), `WORKING_SET_MAX = 16` (`working-set.ts:10`), `CONSUMER_SCAN_MAX = 2000`, `CONSUMER_READ_MAX = 20000`, `CONSUMER_NAMES_MAX = 64`, `WORKSPACE_MANIFESTS_MAX = 256`, `MANIFEST_BYTES_MAX = 1 MiB` (`perimeter.ts:137-149`), `GRADE_SNAPSHOT_TIMEOUT_MS` (`wiring.ts:1824`, `:2614`).

## Edge kinds

| Rank | Kind | Read | Parse | Ships (rec.) |
|---|---|---|---|---|
| A1 | `package.json` `file:`/`link:`/`portal:` | root + workspace manifests (`perimeter.ts:178-211` rules) | `JSON.parse` after stat; `dependencies`, `devDependencies`, `optionalDependencies`, `peerDependencies`, `overrides` (depth ≤ 4), `resolutions`, `pnpm.overrides`; `file://` via `fileURLToPath`; tarballs, `workspace:`, `npm:`, git, http ignored | Tier A |
| A2 | tsconfig | `tsconfig.json`, `tsconfig.*.json` (≤ 8), `jsconfig.json`, workspace `tsconfig.json` | JSONC; `extends` (relative/absolute only), `references[].path`, `paths` (static prefix vs `baseUrl`), `baseUrl`, `rootDirs`, `typeRoots`, `include`/`files` prefixes; outputs ignored | Tier A |
| A3 | Python editable (installed) | `.venv`/`venv` with `pyvenv.cfg`; `Lib/site-packages` or `lib/python3.*/site-packages` | `*.pth` path lines (skip `import`), `__editable___*_finder.py` `MAPPING` by regex (never executed), `*.egg-link` first line | Tier A |
| A4 | Go | `go.mod`, `go.work` | `replace … => <local>`, `use` | Tier A |
| B1–B6 | Cargo `path`, .NET `ProjectReference`, Gradle/Maven, requirements `-e`/pyproject paths, workspaces outside root, shallow symlink scan (depth ≤ 2) | — | — | Later |
| C1–C5 | bundler/test aliases (code), source `../` imports, submodules, `.git` worktrees, global locations | — | — | Never |

Feeds: P (I4 attribution, I8 scope note) as seed `edge`; S11 frozen links (P3c.4); **not** link pins or the reference (OD-P3c-2); consumer caveat D6 as `(<via>)`; "also observed" same format; unadmitted → `name (not admitted)`, never refused.

## Tasks (lot 3)

Order is a safety property: no intermediate commit weaker than the synchronous gate; edge seeds join P (P3c.3) before S11 freezes them (P3c.4).

- **P3c.1** `feat(verify): parse declared dependency edges outside node_modules`.
  - Tests: new `test/unit/edges.test.ts`: `parseJsonc` (comments inside strings kept, BOM, trailing commas, invalid → `undefined`); A1 fields and ignored specs; A2 keys, `extends` chain (depth 4, cycle, inside the root), `paths` prefixes vs `baseUrl`; A3 win32/posix venv layouts, `.pth`/`import`, finder `MAPPING`, `egg-link`; A4 single/block `replace`, `go.work use`, module-path replacements ignored; bounds (stat before read via IO spy, file cap, `EDGES_MAX`, `incomplete`); UNC flagged without resolving; `via` vocabulary; the synchronous workspace matcher agrees with `workspaceDirs`.
  - Code: new `src/verify/edges.ts` (`EdgeIO` like `LinkIO` `perimeter.ts:97-107`, `EdgeKind`, `DeclaredEdge { kind, spec, via, unc? }`, `declaredEdges(root, io?, limits?)`, `parseJsonc`, `EDGE_VIAS`); move `workspacePatterns` (`perimeter.ts:178-184`) here and import it back. Kinds limited per OD-P3c-1.
- **P3c.2a** `refactor(verify): factor perimeter link admission into admissionContext`.
  - Tests: unit test of `admissionContext` (both parent spellings, depth, exclude, working set); `perimeter.test.ts` unchanged and green.
  - Code: `perimeter.ts:458-479` → exported `admissionContext(config, workingSet)`.
- **P3c.2b** `feat(verify): admit declared edge targets by text first`.
  - Tests: `edges.test.ts` "edge admission" (IO spy, temp dirs, junctions): below a parent → its top; outside / UNC → `unadmitted`, no filesystem call; junction below the parent leading out → `unadmitted`; missing `dist` → nearest ancestor's top; inside W's top skipped with no call; another worktree of W's repository → `sameRepository`; `node_modules` segment skipped.
  - Code: next to `linkedTargets` (`perimeter.ts:110-126`): `resolveEdgeTarget(edge, ctx, wTop, io)`, `dependencyTargets(w, ctx, io?)` (links first, then edges).
- **P3c.3** `feat(verify): declared dependency edges join the role dispatch perimeter`.
  - Tests: `perimeter.test.ts` "declared dependency edges in P (P3c)": `file:../lib-b` without `node_modules` → `edge` seed with `admit`; tsconfig `references` same; link + edge into one repository → one pinned `link` seed; edge into a working-set root → `edged`; edge-only seed not pinned; ≤ 8 unadmitted names `(not admitted)`; I9 (no parents/location/working set → `undefined`, no edge file read); end to end: a bash write into an edge-only lib during the dispatch → I4 unverifiable, pass scope line shows `also observed: lib-b (main @ …)`.
  - Code: `src/verify/dispatch.ts:107-112` (origin `"edge"`, `edged?`); `perimeter.ts:481-518`; check every `origin ===` site (`wiring.ts:1634`, `:1799`, `:1892`, `:1895`).
- **P3c.4** `feat(verify): freeze and re-observe declared edge targets at router_verify (S11)` (one atomic commit, F1).
  - Tests: `pending.test.ts` (near `:234`): `DeferredPerimeter.admission` stored and frozen; `deferred-perimeter.test.ts` "declared dependency edges at router_verify (P3c)": unchanged edge → pass, no S11 caveat (F1 regression); target changed → `LINK_DRIFT_CAVEAT.changed`; edge removed or added after return → "changed"; new edge outside the parents named from text, no filesystem call; W in a subfolder → edges read from `linkBase`; two entries of one W → `dependencyTargets` called once.
  - Code: `wiring.ts:1895` (`isDependency`), `pending.ts:466-483`, `:826` (frozen `admission?`), `wiring.ts:2283-2292`, `:2661-2689` (union, memo, covering list, ceiling, text-first naming).
- **P3c.5** `feat(verify): discover consumers through declared dependency edges`.
  - Tests: `perimeter.test.ts` "consumer discovery (§6)": a working-set root with an uninstalled `file:../app-a` → `{root, name, via: "package.json dependencies (file:)"}` without `entry`; tsconfig `references`, `.pth`, `go.mod replace` into W each a consumer; `node_modules` hits keep their shape; reverse bound → `incomplete`; edge outside W not a consumer; outside-parents text → no filesystem call. `gate.test.ts` (`:792`): the edge caveat text; a consumer check clears it; `:800`, `:829` unchanged. `deferred-perimeter.test.ts`: an edge consumer at `router_verify`.
  - Code: `perimeter.ts:129-134` (`entry?`, `via?`), `:295-357` (step (c)), `gate.ts:66`, `:536-538`.
- **P3c.6** `fix(verify): freeze dependency targets added during the dispatch at return` (only if OD-P3c-3 = b).
  - Tests: `deferred-perimeter.test.ts` "a dependency added during the dispatch": producer-created edge or junction, lib unchanged → pass; lib changed after return → "changed"; not observable within 2 s → verified at once (no handle); writers present → no I4 reason for it (I13).
  - Code: `wiring.ts:1865-1920` (`perimeterAtReturn`: `dependencyTargets(linkBase)`, `hardenedSnapshotFor` (as `:2649`) within the remaining bound, add to `links`; a miss sets `linkUnobserved`).
- **P3c.7** `docs(verify): document dependency edges outside node_modules`.
  - Tests: docs-drift `it("P3c: …")`: every `EDGE_VIAS` label and bound in `edges.ts` and in the new `VERIFICATION.md` subsection; the edge caveat fragment; the new S11 sentence; the CHANGELOG item; `:1254`, `:1316` untouched.
  - Docs: `CHANGELOG.md` Added (and Fixed if P3c.6); `VERIFICATION.md:457` consumers bullet, new `### Dependencies outside node_modules` under `:441-461`, the S11 sentence, `:302` (yarn PnP in P, not in the reference); `ROLES.md:330-334`; `CONFIG_REFERENCE.md:585-586`.
- **P3c.8** `docs(design): record Phase 3 (c)`: `cross-repo.md` §2 P (`:36`), §6 (`:338`), I13 (`:198`), §7 (`:482`), §9 (`:608`, `:614`, `:619`, `:620`), §10 Q2 (`:630`), §11 D24–D26; handover.

Risks: dispatch-start cost (F9, measure in D1); noise (≤ 8 names, `.pth` outside parents dropped, `node_modules` skipped); big monorepos in the working set (reverse bound → caveat; QA checks it); prompt surface (`via` fixed vocabulary + `displaySafe`).

## Live dogfood (lot 3)

Preconditions: new orchestrator session (working set empty after a restart); never `Remove-Item -Recurse` a directory holding a junction.

```pwsh
git -C D:\git\omr-xr-dogfood-lib status --short           # expect: clean
$lib = git -C D:\git\omr-xr-dogfood-lib rev-parse --short HEAD
$app = 'D:\git\omr-xr-dogfood-app'
New-Item -ItemType Directory $app | Out-Null
git -C $app init -q -b main
@'
{ "name": "omr-xr-dogfood-app", "version": "0.0.0",
  "scripts": { "touch-lib": "node -e \"require('fs').writeFileSync('../omr-xr-dogfood-lib/touched.txt','x')\"" },
  "dependencies": { "omr-xr-dogfood-lib": "file:../omr-xr-dogfood-lib" } }
'@ | Set-Content -Encoding utf8NoBOM "$app\package.json"
'{ "files": [], "references": [ { "path": "../omr-xr-dogfood-lib" } ] }' | Set-Content -Encoding utf8NoBOM "$app\tsconfig.json"
git -C $app add -A; git -C $app commit -qm "scratch app: declared edges"
Test-Path "$app\node_modules"                              # expect False
```

| # | Step | Expected |
|---|---|---|
| D1 | Role dispatch `repo=omr-xr-dogfood-app`, create notes.txt, `fileExists` | `✓ verified`, `also observed: omr-xr-dogfood-lib (main @ $lib)` (none at `67fe82b`); record timing vs control (F9) |
| D2 | Same repo, `router_run` `touch-lib`, then notes2.txt | Unverifiable with the I4 reason naming the lib; remove `touched.txt` |
| D3 | `repo=omr-xr-dogfood-lib`, create lib.txt, `fileExists` | UNVERIFIED: `omr-xr-dogfood-app at D:\git\omr-xr-dogfood-app links this work root (package.json dependencies (file:)) and no check ran there; …` |
| D3b | Same with lib2.txt plus a `run` check placed in the app | `✓ verified`; remove lib.txt, lib2.txt |
| D4a | Untracked `tsconfig.dogfood.json` in this worktree referencing `../omr-xr-dogfood-lib`; deferred dispatch with `testsPass scope=full`; `router_verify` | handle, then `✓ verified` with `also observed: omr-xr-dogfood-lib`, no S11 caveat (F1) |
| D4b | Same, `s11.txt` added to the lib before `router_verify` | UNVERIFIED, S11 "changed"; remove s11.txt |
| D4c | Delete the tsconfig; deferred dispatch; recreate after return; `router_verify` | UNVERIFIED "changed" (or ✓ if P3c.6 handles it at return only when created during the dispatch) |
| D5 | App: drop the `file:` dep and `references`; add `.venv\pyvenv.cfg` and `.venv\Lib\site-packages\_omr_xr_lib.pth` → the lib; repeat D1 | `also observed` through the Python edge; remove `.venv`, repeat: none |
| D6 | App tsconfig `references` → `C:/omr-xr-not-admitted` | `also observed: omr-xr-not-admitted (not admitted)` |
| D7 | Only if OD-P3c-3 = b: deferred dispatch that creates `tsconfig.dogfood.json`, `testsPass scope=full`, `router_verify` | `✓ verified` |

Cleanup: remove `tsconfig.dogfood.json` and lib probe files, lib `status --short` clean, `Remove-Item -Recurse -Force D:\git\omr-xr-dogfood-app` (no junctions inside), this worktree `status --short`.
