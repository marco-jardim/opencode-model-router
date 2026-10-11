# Phase 1.3 — File lease registry

Worktree `D:\git\omr-cpx-p13`, branch `cpx/p13`, base tag `cpx/p13-base` = `4161324`. Started 2026-10-11 01:36.

## Pre-flight

- [x] Depends on 0.1: merged into `cpx/main` (`4161324`) on the owner's instruction to proceed while the 0.1 round-2 follow-ups finish; the binding round-2 correction for this phase (QA-0.1-26, `router_git_*` tools) is applied in the 1.3.1 memo.
- [x] No in-flight phase writes `src\router\leases.ts`, `src\router\tool-paths.ts`, `src\verify\dispatch.ts` or their tests.
- [x] Worktree from `cpx/main`, tag pushed, `npm ci`, clean; `npm run typecheck` green.
- [x] Anchors (explorer `ses_ed6bffcdaffenUaigZQ7rRvObZ`) hold: `src\verify\dispatch.ts:101` `WRITE_TOOLS` (write, edit, patch, multiedit, apply_patch); ≈468-488 `record`, apply_patch header parse ≈471-477 (regex ≈475), `extractChangedFile` ≈478 (anchors at the phase base; after the phase: `WRITE_TOOLS` :82, `extractChangedFile` :110); `src\router\git-tools.ts` `verifyRoleRepository` ≈972-981 (`rev-parse --absolute-git-dir --git-common-dir` ≈973); `src\router\run-tools.ts:160` `RunInput {script; args?; cwd}`, ≈882-886 tool args.
- [x] Existing tests of `src\verify\dispatch.ts`: `test\unit\dispatch.test.ts`, `test\unit\dispatch.worktree-list.test.ts` (0.P baseline green).
- [x] `smoke:cpx` green (3× at `7b11504`).

## Implementation notes

### 1.3.1 design memo (architect, heavy pin, `ses_ed6afe96cffe1d40rz5Na3NVV6`)

Orchestrator decisions on the memo (binding for 1.3.2/1.3.3):
- **Ownership:** `src\router\git-tools.ts` is not owned by 1.3. `repoKeyOf` stays an injected seam; the pointer-based adapter (`repositoryIdentity`) is a **handoff to Phase 2.1**, which wires the registry. 1.3.3 tests use a fake `repoKeyOf`.
- **`canonicalPath`** (owned here) gets an optional `realpath` parameter in task **1.3.2** (default `realpathSync.native`, existing callers unchanged); 1.3.3 imports it after 1.3.2 is committed. Hence the order 1.3.2 → 1.3.3 (sequential, the plan allows ∥). At `1c15dd9` it lives in the leaf module `src\verify\canonical-path.ts` (`:16-35`, moved by QA-1.3-16 / QA-2.1-8); `src\verify\dispatch.ts` imports it from there and re-exports it (`:18`, `:68`) for every existing caller.
- **ADR wording:** ADR 0007 D7 "another session" for reads means "another *child* session" (root sessions are never refused reads/searches/runs). Recorded as a handoff to the ADR owner (orchestrator, cpx/main amendment).
- §9 item 6 (`router_git_diff` with a `ref` compares commit ↔ working tree when it runs `git diff <ref> -- <path>`): 1.3.2 must read `inspectGit` and classify a diff with a single ref as `search` (working-tree read), and only a commit-to-commit form as `none`; pinned by a test.

#### 1. How ADR D7 and the current code fit together

| D7 statement | Code today | Decision |
|---|---|---|
| Lease key = repository + normalized repo-relative path | `pathKey` (`src/verify/dispatch.ts:71-74`, the v1 change-set key): `canonicalPath` then `\`→`/`, lowercase on win32. `canonicalPath` (`src/verify/canonical-path.ts:16-35`): realpath of the nearest existing ancestor + the non-existent tail. | Two keys: **logical** (repository + relative path) decides write conflicts; **physical** (canonical absolute path) decides read conflicts. |
| Repository identity | `verifyRoleRepository` (`src/router/git-tools.ts:973-981`) checks `rev-parse --git-common-dir` equals `gitPointers(checkout).common` on disk. | Repo key = realpath of the common git dir, case-folded; in the hot path from the `.git` pointer files (no git spawn). |
| Write class | `WRITE_TOOLS` (`dispatch.ts:82`) | `tool-paths.ts` exports `WRITE_CLASS` with the same five names, pinned by a test; `dispatch.ts` keeps its own copy (v1 unchanged). |
| apply_patch targets (not advertised on v2.0.26) | Round 0: header regex in `dispatch.ts`, args `patchText` then `patch`. At `1c15dd9`: the regex is `PATCH_HEADER` in `applyPatchHeaderPaths` (`tool-paths.ts:39`, `:61-65`), called from `dispatch.ts:452-454`. | The v1 parser moves to `tool-paths.ts` unchanged; `toolTargets` uses a separate host-matching parser (§3). |
| `shell`/`execute` not covered | — | `access: "none"` + `uncovered` flag. |
| Read by "another session in the same tree" refused | — | Only child readers are refused/filtered; root sessions never (the orchestrator must not block on its children). |
| Plan-task leases end at integration | — | Scope `until-integrated`; never swept at 6 h. |

Existing helpers: `canonicalPath` (`src/verify/canonical-path.ts:16`, exported, re-exported by `dispatch.ts:68`), `pathKey` (private, `dispatch.ts:71`), `canonicalAuthorityPath` (`src/routing/roles/work-root.ts:25`, realpath seam `:31`); private in `src/router`: `realpath` (`git-tools.ts:82`), `foldCase` (`:403`), `sameOnDisk` (`:941`), `nearestRepository` (`:924`), `realpathOrSelf` (`config.ts:483`). Reuse the `canonicalPath` algorithm with an optional `realpath` parameter; add a lexical pre-pass in `leases.ts` (case folding, trailing dots/spaces, `:stream`), or reuse a segment-cleanup helper from `canonicalAuthorityPath` if it handles non-existent paths (1.3.3 checks first).

#### 2. Modules

- `src/router/tool-paths.ts`: **pure**, imports only `node:path`.
- `src/router/leases.ts`: filesystem only through seams; imports `canonicalPath` from `../verify/canonical-path` (`leases.ts:52`); nothing from tool-paths.
- `src/verify/dispatch.ts` imports `applyPatchHeaderPaths` from `../router/tool-paths` (`dispatch.ts:24`) and `canonicalPath` from `./canonical-path` (`:18`, re-exported at `:68`); no cycle.
- Both new modules stay unwired until 2.1 (v2 only); the `dispatch.ts` change is a no-behaviour-change refactor (goldens, `smoke:v1` green). No CHANGELOG entry until 2.1.

#### 3. `tool-paths.ts` (1.3.2)

As implemented at `1c15dd9` (`src\router\tool-paths.ts`; pure, imports only `isAbsolute`/`resolve` from `node:path`):

```ts
export type Access = "read" | "write" | "search" | "run" | "none";
export interface ToolTargets {
  access: Access;
  paths: string[];          // read/write targets: absolute (or kept unresolved, see below), deduped, first-seen order
  roots: string[];          // search roots (search), the run cwd (run), the shell workdir (informational)
  uncovered?: "shell" | "execute";
  gitRootRequired?: true;   // router_git_* without an absolute opts.gitRoot: access kept, paths/roots empty
}
export interface ToolTargetsOptions { gitRoot?: string }  // absolute repository top level, base of router_git_* paths
export const WRITE_CLASS: ReadonlySet<string>;            // write, edit, multiedit, patch, apply_patch (mirrors WRITE_TOOLS in dispatch.ts, pinned by a test)
export function toolTargets(tool: string, args: unknown, cwd: string, opts?: ToolTargetsOptions): ToolTargets;
export function applyPatchHeaderPaths(args: unknown): string[];  // the v1 parser, used by dispatch.ts only
```

Rules (`toolTargets` → `classify`): never throws — a throw inside classification returns `{access: "write", paths: []}` for a `WRITE_CLASS` tool (so a lease is not skipped), else `none`; `tool` lowercased (non-string → `""`); `args` that is not a plain object (null, array, primitive) → `{}` (`record`); non-string `cwd` → `""`. A value counts only if it is a non-empty string (`nonEmpty`: `length > 0`, not trimmed) — except `ref`, which is trimmed, so a whitespace-only `ref` counts as absent. Resolution (`absolute(p, base)`): on win32 (`process.platform`) a device-prefixed path (`\\?\`, `\\.\`, `\??\`; `WIN_DEVICE`) or a path rooted without a drive (`\x`; `WIN_ROOTED_NO_DRIVE`) is returned **unresolved** — `path.resolve` would turn them into `C:\??\C:\x` / `<baseDrive>:\x`; `keyOf` unwraps the drive/UNC/`Volume{guid}` device forms, and fails closed on the other device forms and on the drive-less rooted form; otherwise `path.resolve(base, p)` when `base` is absolute; with a non-absolute base an absolute `p` is kept and a relative one dropped. Host tools resolve against `cwd`; `router_git_*` against `opts.gitRoot`. A search with no `path` has root `cwd` (`router_git_*`: `gitRoot`).

Path keys (`PATH_KEYS`): `filePath`, `path`, `file`, `file_path` (the keys `extractChangedFile` reads plus the host's `file_path`). **Every** non-empty string among them is a target (`pathArgs`): the host may honour any of them, so first-wins is unsafe.

| Tool | Access | `paths` | `roots` | Basis |
|---|---|---|---|---|
| `read` | read | every path key | — | observed |
| `write`, `edit` | write | every path key | — | observed |
| `multiedit` | write | every top-level path key + every path key of each `edits[i]` (when `edits` is an array) | — | router code |
| `patch`, `apply_patch` | write | host-parsed header paths (`hostPatchPaths`, below) + `filePath`, `path`, `file_path` (`HOST_PATCH_PATH_KEYS`, as `toolCallPaths` in `src\compat\v2-hooks.ts`) | — | v2 host |
| `list`, `grep` | search | — | `path` ?? cwd (`grep`'s `pattern` is a regex) | router code / observed |
| `glob` | search | — | `path` ?? cwd, + the anchors of `pattern` (`globPrefixes`, below) | observed |
| `router_run` | run | — | `cwd` arg ?? cwd | ADR D7 |
| `router_git_blame` | non-empty trimmed `ref` → none; else read | `path` against `gitRoot` (`[]` without `path`) | — | QA-0.1-26 |
| `router_git_diff` | `mode: "cached"` → none; trimmed `ref` containing `..` (`a..b`, `a...b`) → none; no ref or a single ref (working tree vs index/commit) → search (`gitDiffReadsWorkingTree`) | — | `path` ?? `gitRoot`, against `gitRoot` | QA-0.1-26 |
| `router_git_status`, `router_git_ls_files` | search | — | `path` ?? `gitRoot`, against `gitRoot` | QA-0.1-26 |
| `router_git_log`, `router_git_show` | none | — | — | history / committed objects only |
| `shell` | none, `uncovered: "shell"` | — | `workdir` ?? cwd (informational) | ADR D7 |
| `execute` | none, `uncovered: "execute"` | — | — | ADR D7 |
| write-class tool, no extractable target | write | `[]` | — | ADR D7 |
| anything else | none | — | — | — |

`router_git_*` (`gitTargets`): their paths are relative to the repository top level (git-tools.ts), so they resolve against `opts.gitRoot`; without a non-empty absolute `gitRoot` the result keeps its classified `access` with `paths: []`, `roots: []` and `gitRootRequired: true`, and the caller treats it as an **unknown target**. The `none` forms (blame at a ref, cached/range diff, log, show) never need `gitRoot`.
A read with `paths: []` does nothing; a write with `paths: []` is a write of an unknown target (`acquireWrite(holder, null)` or `[]`).

**apply_patch parsing — two parsers.**
- `hostPatchPaths` (private; same semantics as `patchPaths` in `src\compat\v2-hooks.ts`, which tool-paths.ts may not import): text = the first value that is a **string** among `patchText`, `patch_text`, `patch`, `input` (`PATCH_KEYS`; it wins even when empty); split on `\r?\n`; each line `trimStart`ed, so **indented headers** count; prefixes `*** Add File:`, `*** Update File:`, `*** Delete File:`, `*** Move to:` (`HOST_PATCH_HEADERS`, both paths of a move); path = rest of the line trimmed. A header with an **empty path**, no header at all, or no string text → `undefined`: the patch is unreadable and contributes no paths; with no `filePath`/`path`/`file_path` either, the call is a write with `paths: []` → **unknown target**.
- `applyPatchHeaderPaths` stays the **v1 parser**, behaviour identical to the old `dispatch.ts` code: `patchText` then `patch`, `PATCH_HEADER` = `/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm` (headers at column 0 only), `.trim()` (removes a CRLF `\r`). `dispatch.ts` imports it for its v1 change-set record (`for (const p of applyPatchHeaderPaths(args)) files.set(p, "modified")`); `toolTargets` does not use it.

**glob anchors (`globPrefixes`)**, wildcard = a segment matching `GLOB_CHARS` = `/[*?[\]{}()!]/`, segments split on `/` and `\`:
- absolute pattern: its leading wildcard-free segments; with no wildcard the last segment is dropped (the pattern names one entry → search its directory); a bare root gives `/`, a drive `C:` gives `C:/`.
- relative pattern (`relativePrefix`): `""`/`.` segments dropped and `..` normalised lexically; anchored only if the result starts with `..`. A wildcard segment ahead of a `..` has two readings and **both** prefixes are returned (deduped): wildcards before the last `..` dropped (`**` matched nothing — the widest reading) and each wildcard counted as one ordinary segment (`*` matched one directory). The first wildcard left ends the prefix; with none, the last segment is dropped.
- the prefixes are resolved against the search root (`path` ?? cwd) and appended to `roots`; a pattern that stays inside the search root adds nothing.

Git-tool searches are filtered **inside the router tool** (exclude pathspecs for the files `filterSearchResults` would omit, built from `PathKey.relOnDisk`, see §4) — a 2.1 wiring task.

`canonicalPath` moved to the leaf module `src\verify\canonical-path.ts` (QA-1.3-16 / QA-2.1-8); `src\verify\dispatch.ts` imports it from there and re-exports it (`export { canonicalPath }`) for every existing caller; `leases.ts` imports it from `../verify/canonical-path`.

#### 4. Key normalization (1.3.3)

As implemented at `1c15dd9` (`src\router\leases.ts`). `keyOf(raw, base, seams, platform = process.platform)` (exported) → `PathKey | Unkeyable` (`{ unkeyable: reason }`); internally `keyOfIn(…, asDirectory)`, where `asDirectory` (run directories, §5) asks `repoKeyOf` about the path itself instead of its parent.

```ts
export interface PathKey {
  physical: string;          // canonical absolute path, "/"-separated, folded on win32: decides read conflicts
  logical: string;           // `r:${repo}\0${rel}` inside a repository, else `x:${physical}`: decides write conflicts
  tree: string | null;       // work tree containing the file (canonical, folded), null outside any repository
  repo: string | null;       // repository (folded), null outside any
  rel: string | null;        // path relative to tree ("" for the tree itself), FOLDED (upper-cased on win32)
  relOnDisk: string | null;  // rel in the case the filesystem reports, "/"-separated: the ONLY spelling to hand git
  display: string;           // the absolute path as given (lexically resolved), for messages
}
export function foldKeyPath(text: string, platform: NodeJS.Platform = process.platform): string;
```

**Fold (`foldKeyPath`, exported):** `\` → `/`; on win32 `upcaseUnits` — each **UTF-16 unit** is upper-cased when its upper case is still one unit (`ß` stays, `ſ` → `S`); a unit whose upper case is longer (`ᾳ` → `ΑΙ`) falls back to its **lower** case if that is one unit (so `ᾳ` and its title case `ᾼ` fold together), else it is kept — an approximation of NTFS's `$UpCase` table, **not** `toLowerCase`; then trailing `/` removed except at a root (`/`, `X:/`, `//host/share/`). It spells physical keys, the `tree`/`repo` a `repoKeyOf` answers with, and snapshot paths; the 2.1 adapter spells its answers with it.

1. Unkeyable inputs: non-string (`not a string`), empty after trim (`empty path`), NUL (`NUL in path`); `raw` or `base` longer than **32 767** UTF-16 units (`MAX_PATH_CHARS`, `path too long`).
2. (win32) `normalizeDevice` on `raw` and on `base`: `\\?\X:\…`, `\\.\X:\…`, `\??\X:\…` → `X:\…`; the `UNC\h\s\…` forms → `\\h\s\…`; `\\?\Volume{guid}\…` (`VOLUME_DEVICE`) → the DOS path `seams.realpath` answers with, if it unwraps to a drive/UNC form; every other device form (`\\.\pipe\…`, `\\?\GLOBALROOT\…`, `\\.\PhysicalDrive0`, …) → `device path` **without any filesystem call** (QA-1.3-31: device/UNC normalisation must not call `realpath`; only the `Volume{guid}` form is resolved). Between the two calls, on the unwrapped `raw`: drive-relative `C:foo` → `drive-relative path`; rooted without a drive `\x` (the process's drive, not the base's) → `rooted path without a drive`. Neither `raw` nor `base` absolute → `relative path without an absolute base`.
3. `display = resolve(base, raw)` with the platform's `win32`/`posix` API (lexical `..`, `.`, separators); the resolved path is checked again: over 32 767 units or over **4 096** segments (`MAX_PATH_SEGMENTS`, counted after `..` collapse) → `path too long` / `too many path segments`.
4. (win32) Per segment after the volume root: cut at the first `:` (NTFS stream `name:stream[:$DATA]` → `name`), then strip trailing `[. ]+`; an empty result → `empty path segment`; leading spaces kept.
5. `canonicalize`: the nearest-existing-ancestor walk of `canonicalPath(abs, probe)` (`src\verify\canonical-path.ts`) with `seams.realpath` as the probe (when the platform rules are not the host's, the same walk with the other `path` API); expands junctions, symlinks and 8.3 names of existing segments; the result is unwrapped again (step 2; a non-drive device result → `device path`). The segments after the first ancestor that resolved are the missing tail.
6. (win32) An 8.3-looking segment in the missing tail (`SHORT_NAME` = `/^[^.~\\/]{1,6}~\d+(\.[^.]{0,3})?$/i`) → `8.3 short name in a missing path`.
7. `physical = foldKeyPath(canonical, platform)`.
8. `seams.repoKeyOf(dirname(canonical))` (`canonical` itself for a directory key); a throw or a malformed answer → outside any repository; the answer's `repo` and `tree` are folded with `foldKeyPath`, so either spelling is accepted. In-repo when `physical` is the tree or starts with `tree + "/"`: `rel` = `physical` minus the prefix (`""` for the tree itself), `relOnDisk` = the same-length tail of `foldKeyPath(canonical, "linux")` (folding keeps every unit's length, so the unfolded tail is the on-disk spelling), `logical = "r:" + repo + "\0" + rel`. Else `logical = "x:" + physical`; `tree`, `repo`, `rel`, `relOnDisk` null.
9. `display` = the lexically resolved absolute path (before step 4's cleanup).

Unkeyable reasons that may still name any file (`ALIASING_REASONS`, `leases.ts:250-255`: `device path`, `drive-relative path`, `rooted path without a drive`, `8.3 short name in a missing path`) **fail closed**; every other reason (not a string, empty, NUL, oversize, empty segment, no absolute base) is an **unknown target** — policy in §5.
**Current behaviour — size caps:** `path too long` (over 32 767 units) and `too many path segments` (over 4 096) are **not** in `ALIASING_REASONS`, so they do not fail closed: a child **write** of such a path is an unknown target (`unknown-target` while another owner leases a file of the writer's repository, allowed outside any repository), and a child **read** of it is **allowed** (`readConflict` returns no conflict for a non-aliasing unkeyable path).

Known limitations (module doc): hard links; case-insensitive POSIX volumes (darwin); a POSIX `link/..` (resolved lexically); junctions created after a lease; NTFS's `$UpCase` only approximated by the per-unit fold; a loopback UNC spelling of a local drive (`\\localhost\C$\…`, `\\127.0.0.1\C$\…`) keys apart from `C:\…`.
Equivalent spellings → one key: `D:\R\Src\A.ts`, `d:/r/src/a.ts`, `d:\r\src\x\..\a.ts`, `d:\r\src\a.ts.`, `d:\r\src\a.ts `, `d:\r\src\a.ts:zone`, `\\?\D:\r\src\a.ts`, `\\.\D:\r\src\a.ts`, `\??\D:\r\src\a.ts`, a junction to `d:\r\src`, the 8.3 form of an existing long directory name.

`repoKeyOf(dir) → { repo, tree } | undefined` — recommended adapter (2.1): `checkout = nearestRepository(dir)`, `p = gitPointers(checkout)`, `repo = realpath(p.common)`, `tree = realpath(checkout)`, spelled with `foldKeyPath` (the registry folds again, harmlessly), memoized (LRU ≈4096); `gitPointers` throws for network/device pointers → `undefined` (outside key space). **Every seam is synchronous** and the registry has no `await`, so a check and its insert are atomic.

#### 5. `leases.ts` API (1.3.3)

As implemented at `1c15dd9` (`src\router\leases.ts`; imports only `posix`/`win32` from `node:path` and `canonicalPath` from `../verify/canonical-path`):

```ts
export type LeaseScope = "until-complete" | "until-integrated";
export interface Holder {
  holderID: string; tree: string; isChild: boolean; taskRef?: string; scope: LeaseScope;
  acquiredAt: number;   // seams.now() when the holderID is first recorded
  lastSeenAt: number;   // seams.now() of its latest acquire, read, search or run; the sweep ages from it
}
export type HolderInput = Omit<Holder, "acquiredAt" | "lastSeenAt">;                     // both stamped by the registry
export type LeaseActor = Pick<HolderInput, "holderID" | "tree" | "isChild" | "taskRef">;  // a reader / runner
export interface LeaseSeams { realpath(p: string): string; repoKeyOf(dir: string): { repo: string; tree: string } | undefined; now(): number }
export interface LeaseOptions { runMode: "annotate" | "refuse"; cap?: number /* 10_000 */; sweepAgeMs?: number /* 6 h */; platform?: NodeJS.Platform }
export interface RestoreOptions { dropCompleteHolders?: boolean }
export function createLeaseRegistry(seams: LeaseSeams, opts: LeaseOptions): LeaseRegistry; // TypeError only for invalid runMode/cap
export function keyOf(raw: unknown, base: string, seams: LeaseSeams, platform?: NodeJS.Platform): PathKey | Unkeyable;
export function foldKeyPath(text: string, platform?: NodeJS.Platform): string;
export function formatRunNote(holders: readonly (Holder | string)[], n: number): string;

interface LeaseRegistry {
  acquireWrite(holder: HolderInput, path: string | readonly string[] | null): AcquireResult;
  checkRead(reader: LeaseActor, path: string): ReadCheck;
  checkRun(runner: LeaseActor, tree: string): RunCheck;
  filterSearchResults(reader: LeaseActor, tree: string, paths: readonly string[]): FilterResult;
  release(holderID: string): ReleaseResult;               // { released, retained }
  releaseTask(taskRef: string): HoldersReleased;          // { released, holders: string[] }
  sweep(): HoldersReleased;
  snapshot(): LeaseSnapshot;                              // { version: 1, takenAt, holders: Holder[], leases: SnapshotLease[] }
  restore(snapshot: unknown, opts?: RestoreOptions): RestoreResult;  // { ok: true, leases } | { ok: false, reason: "invalid-snapshot", message }
}
type AcquireResult =
  | { ok: true; leased: string[]; reentrant: string[]; unkeyed: string[] }
  | { ok: false; reason: "held"; holders: [Holder]; path: string; key: string }
  | { ok: false; reason: "unknown-target"; holders: Holder[] }
  | { ok: false; reason: "cap"; limit: number; held: number }
  | { ok: false; reason: "invalid-holder"; message: string };
type ReadCheck = { ok: true } | { ok: false; reason: "underEdit"; holders: Holder[]; path: string } | { ok: false; reason: "invalid-holder"; message: string };
type RunCheck = { ok: true } | { ok: true; contaminatedBy: Holder[]; fileCount: number }
  | { ok: false; reason: "run-refused"; holders: Holder[]; fileCount: number } | { ok: false; reason: "invalid-holder"; message: string };
interface FilterResult { kept: string[]; omitted: number; holders: Holder[]; invalid?: string }
```

`createLeaseRegistry` throws a `TypeError` only for an invalid `runMode` or a `cap` that is not a positive safe integer; an invalid `sweepAgeMs` (non-finite, ≤ 0) falls back to 6 h. Every method that takes caller input is wrapped (`safe`): a hostile input (throwing getter, revoked Proxy) gets `invalid-holder` / `invalid-snapshot` / an empty result (`filterSearchResults`: `kept: []`, `invalid`) instead of a throw.

**Ownership.** The owner of a holder's leases is `taskRef ?? holderID` (`ownerOf`: `t:<taskRef>` / `h:<holderID>`). Child sessions of one owner (a plan task's producer, retry, verifier, QA child) **never conflict**: a write is re-entrant, a read, search or run is exempt (a root write has no owner exemption, see `acquireWrite`). Each lease (`LeaseEntry`) has a **holder set** of one owner (first writer first); a later writer of the same owner joins it, and the lease ends only with its **last** holder (`dropHolder`), so it lives as long as its **strongest scope** (`until-integrated` over `until-complete`). One logical key records every `(physical, tree)` pair its owner wrote it in (`pairs`); reads and runs are checked against each.

**Actors (`bindActor`).** A `LeaseActor` (reader, searcher, runner) is validated by `parseActor` (non-empty `holderID`, absolute `tree`, boolean `isChild`, non-empty `taskRef` if present; else `invalid-holder`). An actor whose `holderID` is recorded **is** that holder: a different `tree` or `isChild` → `invalid-holder` ("recorded with a different tree or isChild"); a `taskRef` that differs from the record → `invalid-holder`; an omitted `taskRef` is inherited, and the owner comes from the record. Any other actor is its own owner (or the one its `taskRef` names).

**`acquireWrite(holder, path)`** (array = all-or-nothing, for apply_patch; `null`, `[]` and any non-string non-array are a write of an **unknown target**; the array is copied once, `readPaths`):
- Holder validation (`parseHolderInput`): the actor rules + `scope` is one of the two, `until-integrated` requires `taskRef`; a holderID already recorded with a different `tree`/`scope`/`taskRef`/`isChild` → `invalid-holder` (first record wins, `sameHolder`).
- Keys are derived against `holder.tree`; an unkeyable path is listed in `unkeyed` and, if its reason is aliasing (§4), marks the call aliasing; the same logical key in two worktrees within one call adds a pair.
- Root (`isChild: false`): refused `held` (the lease's first live holder) if a child holds any of the logical keys (any tree of the repo); else `ok`, nothing recorded; unknown/unkeyable allowed.
- Child: every key is checked before any mutation; a lease of another owner → `held`; of the same owner → re-entrant (holder joins the set, new pairs added, not counted against the cap); a stale holder met on the way is swept and the check restarts. Then: **aliasing** unkeyable → `unknown-target` while **any** other owner holds **any** lease (`holdersOtherThan`, fail closed); unknown target or other unkeyable — **including the size caps** (current behaviour, §4) — → `unknown-target` while another owner leases a file in the **same repository** as the holder's tree (`repoOfDirectory` + `repoHolders`; any worktree), allowed when that tree is outside any repository. Exceeding `cap` → one `sweep()`, then `cap`. The holder is recorded only when something is leased or joined (`acquiredAt = lastSeenAt = now()`); the holder and its sibling holders on the written keys get `lastSeenAt = now()`.

**`checkRead(reader, path)`** → `ReadCheck` (`holders: Holder[]`): root readers never refused. A child: path keyed against the reader's tree; **aliasing** unkeyable → `underEdit` naming every live holder of every other owner while any holds a lease (fail closed); other unkeyable — **including the size caps** (current behaviour, §4) — → allowed. Keyed: refused only if the logical key is leased by **another owner**, the reader is not among its holders, and one of its pairs has `physical === key.physical` (a read of the same relative path in another worktree is not a conflict); `holders` = the lease's first live holder.

**`checkRun(runner, tree)`** → `RunCheck`: the run directory is keyed as a directory (`keyOfIn(…, true)`) against the runner's tree. Candidates come from the indexes: the leases with a pair in the run directory's tree (`byTree`) ∪ the leases with a physical path under the run directory (`byDir`, so nested trees, submodules and files outside any repository count); a candidate counts if it is another owner's, the runner is not among its holders, a pair is in that tree or under that directory (`isUnder`), and it has a live holder. `fileCount` = leases counted; holders deduped. None → `{ok:true}`; a root runner, or `runMode: "annotate"` → `{ok:true, contaminatedBy, fileCount}`; a child under `refuse` → `run-refused`. An **unkeyable run directory**: child → **every** lease is a candidate (fail closed); root → **current behaviour: a plain `{ok:true}`**, with no `contaminatedBy` and no lease scan (`leases.ts:1046`), although the `LeaseRegistry.checkRun` doc comment (`:217-221`) says roots are "only annotated". Complexity: O(leases in the run tree + leases under the run directory) after the O(depth) key derivation; O(all leases, ≤ `cap`) for an unkeyable child run directory — **not O(1)**. `formatRunNote(holders, n)` = exactly `[router] ran while <ids> edits <n> file(s); result may be contaminated` (ids joined with `, `; accepts `Holder` or id strings).

**`filterSearchResults(reader, tree, paths)`** → `{kept, omitted, holders, invalid?}`: an invalid actor → every entry left out with `invalid` set; root readers never filtered; fast path when every recorded holder is the reader's owner (`owners` index); relative entries resolve against `tree` (if absolute) else the reader's tree; an entry is omitted iff the read check would refuse it (`readConflict`); `kept` keeps the original strings and order; `holders` distinct, first-seen; per-call memo of `realpath`/`repoKeyOf` (`memoize`).

**`release(holderID)`** → `{released, retained}`: an `until-complete` holder is dropped (`released` = leases that ended, i.e. it was their last holder); an `until-integrated` holder is kept (`retained` = its keys); unknown id → `{0, 0}` (idempotent). **`releaseTask(taskRef)`** → `{released, holders}`: drops every holder with that `taskRef`, whatever its scope. **`sweep()`** → `{released, holders}`: drops `until-complete` holders with `now() - lastSeenAt >= sweepAgeMs` (`isStale`; a future stamp, negative age, is never swept; `until-integrated` exempt). **On-conflict stale sweep:** a stale holder named by a conflict is dropped on the spot (`liveRecord`, `liveHolderOf`, `holdersOtherThan`, `checkRun`) and does not refuse. `lastSeenAt` is refreshed by `acquireWrite`, `checkRead`, `checkRun` and `filterSearchResults` (`touch`).

**`snapshot()`** → `{version: 1, takenAt, holders, leases}` (plain JSON; one `SnapshotLease {logical, physical, tree, holderID, display}` per holder × pair). **`restore(s, opts?)`** validates everything into a fresh state and swaps it in only on success (no filesystem calls; a rejected snapshot leaves the state unchanged): object, `version: 1`, finite `takenAt`, `holders`/`leases` arrays; each holder a valid `HolderInput`, a **child**, finite `acquiredAt`, `lastSeenAt` finite or absent (→ `acquiredAt`), no duplicate id; stamps in the future clamped to `now()`; each lease line an object with a non-empty `logical`, string `physical`/`display`, `tree` null or string, a listed `holderID`, `physical` already folded (`foldKeyPath`); `x:` lines: `tree` null, `logical === "x:" + physical`, absolute; `r:` lines: folded absolute `tree`, `physical` under it, the `rel` after `\0` matching, folded `repo`; any other prefix rejected; duplicate lines (`logical`, `holderID`, `tree`, `physical`) rejected; the holders of one logical key must share an owner; the result must not exceed `cap`. **`RestoreOptions.dropCompleteHolders`**: the `until-complete` holders and their lease lines are validated but left out (their sessions did not survive the restart).

Indexes (`State`): `leases: Map<logical, LeaseEntry {holders: Set<holderID>, owner, display, repo, pairs: Map<pairKey, {physical, tree}>}>`; `holders: Map<holderID, {holder, owner, keys: Set<logical>}>`; `repoHolders: Map<repo, Map<holderID, count>>` (unknown-target per repository); `tasks: Map<taskRef, Set<holderID>>`; `owners: Map<owner, holder count>` (search fast path); `byTree: Map<tree, Set<logical>>` and `byDir: Map<dir, Set<logical>>` (every ancestor-or-self directory of a leased physical path, `dirPrefixes`) for the run check. The lease count is `leases.size`. A write or read check is O(1) in the registry per path (plus the O(depth) realpath calls of the key derivation, and O(holders) for an aliasing unkeyable path); adding or ending a pair costs O(depth) `byDir` updates; the run check as above.

Conflict matrix (child A of owner O holds X in tree T1 of repo R; the actor is of another owner — a child actor of owner O never conflicts, while a root write is refused whenever a live child holds the key, whatever the owner):

| Actor | X in T1 | same rel path in T2 | other file in T1 |
|---|---|---|---|
| child write | `held` (A) | `held` | ok |
| root write | `held` (A) | `held` | ok |
| child write, unknown target / non-aliasing unkeyable, writer's tree in R (any worktree) | `unknown-target` | `unknown-target` | `unknown-target` |
| child read or write of an aliasing unkeyable spelling | `underEdit` / `unknown-target` (any lease anywhere) | same | same |
| child read | `underEdit` | ok | ok |
| root read/search | ok | ok | ok |
| child search | X omitted, counted | kept | kept |
| child `router_run` cwd in T1 (or a directory above X) | annotate / refuse | ok (cwd T2) | — |
| root `router_run` cwd in T1 | ok + annotated (even under refuse) | ok | — |
| child `router_run`, unkeyable cwd | annotate / refuse (any lease anywhere) | same | — |
| root `router_run`, unkeyable cwd | plain ok, not annotated (current behaviour) | same | — |

Deny-not-wait: no blocking/queueing → no wait-for graph → no deadlock; roots never denied reads → the orchestrator cannot be in a cycle. Livelock possible (two children needing each other's file); mitigations: the refusal names the holder and says not to retry until that session ends; leases end at execution end; an idle `until-complete` holder is swept by `lastSeenAt`; executor footprints avoid co-scheduling overlaps; 2.1 may escalate wording after N identical refusals. Over-leasing accepted (a write that fails after acquiring keeps its lease until release).

Plan deviations (against `docs\plans\critical-path-execution-plan.md`, task 1.3.3):
- **1.3.3.b** ("a read or run conflicts only in the same physical tree, with a different holder") — read and run conflicts are decided per **owner** (`taskRef ?? holderID`), not per holder; a run check also counts the leases **under the run directory** (`byDir`: nested trees, submodules, files outside any repository), not only those of the run tree; **unkeyable spellings fail closed** (an aliasing unkeyable read or write is refused, and an unkeyable child run directory is annotated/refused, while any other owner holds any lease, in any tree).
- **1.3.3.c** ("O(1) checks") — `checkRun` is not O(1): O(leases in the run tree + leases under the run directory) through `byTree`/`byDir`, and O(all leases, ≤ `cap`) for an unkeyable child run directory; write and read checks stay O(1) in the registry.

#### 6. Tests (1.3.4) — setup

Spellings → one key: real fs in a temp dir, real `realpathSync.native`, fake `repoKeyOf` mapping prefixes; junction via `fs.symlinkSync(target, link, "junction")`; 8.3 via `cmd /c for %A in ("<p>") do @echo %~sA` (skip if equal to the long name). Outside repo → `x:` key, no collision. Every conflict row (annotate and refuse). Re-entrant re-acquire (cap count unchanged). Root edits then child reads/runs → allowed. Root write vs child-held → `held` naming the child. Scopes (`release` keeps `until-integrated`; `releaseTask` ends them; `invalid-holder` without `taskRef`). `filterSearchResults` (omitted, order, fast path, root not filtered). Sweep with fake `now` (6 h − 1 ms kept; 6 h released; future kept). Cap (default 10 000, and `cap: 3`; array form all-or-nothing; refusal text). Snapshot/restore (round trip; corrupted rejected with state unchanged; restore replaces). Every tool-shape row incl. apply_patch add/update/delete/update+move with CRLF, empty/null/string args, non-string paths, `ref: ""`, `WRITE_CLASS` pinned to `WRITE_TOOLS` (`dispatch.ts:82`). Existing `dispatch.ts` record tests pass unchanged.

#### 7. Risks

- ADR D7 wording vs the root exemption (docs fix, handoff below).
- A leaked `until-integrated` lease is never swept: it blocks until the executor calls `releaseTask(taskRef)`; on a restart `restore(…, { dropCompleteHolders: true })` drops only the `until-complete` holders.
- Per-owner exemption: two writers of one `taskRef` never conflict (re-entrant), so concurrent sessions of one plan task could overwrite each other — 3.1 must serialise them (handoff).
- Sweep by `lastSeenAt`: an `until-complete` holder idle for `sweepAgeMs` (6 h) loses its leases at the next `sweep()`, at a cap overflow, or as soon as a conflict names it.
- Fail-closed over-refusal: a child that reads or writes an aliasing unkeyable spelling (device form, drive-less rooted `\x`, drive-relative, 8.3 name in the missing tail) is refused while **any** other owner holds **any** lease; a child `router_run` with an unkeyable directory is annotated/refused the same way and scans every lease (O(`cap`)).
- Unknown targets are refused per **repository**: an unreadable patch, a write with no path, a non-aliasing unkeyable path (including the 32 767-unit / 4 096-segment caps) or a `router_git_*` call with `gitRootRequired` blocks a child while another owner leases any file of that repository (any worktree); outside any repository it is allowed, and a read of a non-aliasing unkeyable path is allowed.
- Key spellings are folded (per-unit upper case on win32): `physical`, `tree`, `repo`, `rel`, `logical` must never reach git; only `relOnDisk`. The fold approximates NTFS's `$UpCase` table; a loopback UNC spelling of a local drive keys apart from the drive.
- A root `router_run` in an unkeyable directory gets a plain `{ok:true}` (current behaviour, §5): its result carries no contamination note even while children edit files.
- `checkRun` is not O(1) (§5 plan deviation 1.3.3.c), and `byDir` holds O(depth) entries per leased pair (bounded by `cap` × depth).
- POSIX `link/..` handled lexically; hard links, case-insensitive POSIX volumes and junctions created after a lease are not detected.

#### 8. Check before coding (memo author hit its read cap)

1. `canonicalPath` (`src\verify\canonical-path.ts:16-35`; resolve first, then walk ancestors). 2. `extractChangedFile` (`dispatch.ts:110`) path keys. 3. `canonicalAuthorityPath` (`work-root.ts:25-31`) reuse for non-existent paths. 4. `router_run` schema (`run-tools.ts ≈160, ≈882-885`) and behaviour without `cwd`. 5. `nearestRepository`/`gitPointers` bodies (`git-tools.ts:924`, `:367`). 6. `inspectGit` diff-with-ref form (decision above).

## Findings

### Round 1 (heavy reviewer `ses_ed6899344ffewI1lKtsxOMRt3m`, at `0995ffb`) — 17 findings (5 major, 8 minor, 4 nit)

QA-1.3-1 (major) `router_git_*` paths resolved against the work root instead of the repository top level; -2 (major) ownership per session, so a task's retry or verifier was refused by its own earlier attempt; -3 (major) apply_patch extraction did not match the v2 host's parser; -4 (major) only the first path key was read; -5 (major) device spellings unkeyable and then allowed; -6 inputs outside the declared types threw; -7 the 6 h sweep not self-enforcing; -8 `restore` checked shape not consistency; -9 repo keys not folded like paths; -10 case folding approximations; -11 one (physical, tree) per logical key; -12 runs ignored nested leases; -13 unbounded input size; -14 (nit) glob `..` mid-pattern; -15 (nit) `\??\` prefix; -16 (nit) `canonicalPath` not a leaf module; -17 (nit) unknown-target refusal per tree only.

### Round 2 (heavy reviewer `ses_ed65fe5bbffewpNvwR5JQ1jrAo`, at `f6c5c6a`) — 17 findings (2 major, 8 minor, 7 nit)

Round-1 status: 11 fixed, 6 partial. New: QA-1.3-18 (major) a child refused its own files unless reads repeated its `taskRef`; -19 (major) `\??\C:\x` and drive-less `\x` rewritten by `path.resolve`, bypassing leases; -20 same-task writers tied to the first holder; -21 one worktree pair per array; -22 relative search tree; -23 `router_git_*` without `gitRoot`; -24 glob `**/../..` anchored too shallow; -25 folded `rel` unusable as a git path; -26 `checkRun` scanned every lease; -27 memo and plan described the old contract; -28 (nit) `sweepAgeMs: 0`; -29 (nit) throwing getters / revoked proxies; -30 (nit) unkeyable run directory; -31 (nit) device normalisation called `realpath`; -32 (nit) patch path keys; -33 (nit) restore validation gaps; -34 (nit) two-unit upper case.

### Round 3 (heavy reviewer `ses_ed62902cdffe4ak1Ica2Ur7g2d`, at `1c15dd9`; majors only) — clean

QA-1.3-18 and QA-1.3-19 fixed; no new blocking/critical/major findings.

## Fixes

- Round 1 (implementers `ses_ed67661aeffexG839qpT49qm1a` tool-paths, `ses_ed67609aaffeUcSwMCQY5Ju113` leases; `f6c5c6a`): `gitRoot` option (-1); owner = `taskRef ?? holderID` (-2); host-matching apply_patch parser, `applyPatchHeaderPaths` unchanged for v1 (-3); every path key (-4); device unwrapping, fail closed (-5); total input handling (-6); `lastSeenAt` sweep with on-conflict stale sweep (-7); restore consistency, `dropCompleteHolders` (-8); `foldKeyPath` (-9); per-unit upper-case fold (-10); (physical, tree) pairs (-11); leases under the run directory (-12); size caps (-13); glob normalisation (-14); `\??\` (-15); `src\verify\canonical-path.ts` leaf, re-exported by dispatch.ts (-16); per-repository unknown-target refusal (-17).
- Round 2 (implementer `ses_ed6531a02ffeMg7mRtdP6GOthN`, `1c15dd9`): `bindActor` from the recorded holder (-18); device and drive-less spellings preserved end to end, aliasing reason (-19); holder sets, strongest scope (-20); every worktree pair (-21); relative search trees (-22); `gitRootRequired` (-23); wildcard segments dropped before `..` (-24); `relOnDisk` (-25); `byTree`/`byDir` run index (-26); memo brought to the code (-27, implementer `ses_ed5e1b554ffeLEWj7rnQfb0Eji`; §3–§5, §7, handoffs, plan deviations 1.3.3.b/c); hardening and restore checks (-28…-34).
- Verification (orchestrator shell, `1c15dd9`): leases/tool-paths/dispatch/roles-authority/goldens 495 passed, 1 skipped; typecheck 0; coverage leases.ts 97.56/94.81/94.66/99.32, tool-paths.ts 100/97.18/100/100. v1: `dispatch.ts` only re-exports `canonicalPath` and calls the moved `applyPatchHeaderPaths` (identical behaviour; round 2 and 3 confirmed).

## Deferred findings

- None. Plan deviations 1.3.3.b and 1.3.3.c are recorded in §5 and as amendment A-1.3-1 in `cpx/main` at merge.
## Handoffs

- To 2.1 (wires the registry, v2 only):
  - The `repoKeyOf` adapter: `repositoryIdentity(dir)` from `src\router\git-tools.ts` (pointer-based, memoized; needs `nearestRepository` exported), spelling its `{ repo, tree }` with the exported `foldKeyPath` (the registry folds the answer again, so either spelling is accepted); its `git init` + `git worktree add` test.
  - The plan-task lease binding, from Phase 1.4 QA-1.4-32/33 (cpx/p14): a plan-task child's holder carries ``taskRef = `${planId}:${taskId}` `` and scope `until-integrated`; the task's leases end with `releaseTask(taskRef)` at integration.
  - `router_git_*` targets: call `toolTargets(tool, args, cwd, { gitRoot })` with the absolute repository top level; a result with `gitRootRequired` (no `gitRoot`) has no concrete target and is treated as an **unknown target**.
  - Git-tool search filtering inside `inspectGit` via exclude pathspecs built from `PathKey.relOnDisk` — never `rel`, `physical` or `logical` (folded key spellings).
  - Run the authority checks **before** the lease checks (QA-1.3-31, round-2 nit: device/UNC normalisation must not call `realpath`; 2.1 runs authority checks before lease checks).
  - On restart, `restore(snapshot, { dropCompleteHolders: true })`.
- To 3.1: never run two writers of one `taskRef` concurrently (the producer and its retry are serialised): writers of one owner never conflict in the registry.
- To the orchestrator (ADR 0007 amendment): D7 "another session" → "another child session" for read/search/run restrictions.

## Verdict

PASS after QA round 3 (clean). v1 path unchanged.
