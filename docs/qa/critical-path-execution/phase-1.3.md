# Phase 1.3 — File lease registry

Worktree `D:\git\omr-cpx-p13`, branch `cpx/p13`, base tag `cpx/p13-base` = `4161324`. Started 2026-10-11 01:36.

## Pre-flight

- [x] Depends on 0.1: merged into `cpx/main` (`4161324`) on the owner's instruction to proceed while the 0.1 round-2 follow-ups finish; the binding round-2 correction for this phase (QA-0.1-26, `router_git_*` tools) is applied in the 1.3.1 memo.
- [x] No in-flight phase writes `src\router\leases.ts`, `src\router\tool-paths.ts`, `src\verify\dispatch.ts` or their tests.
- [x] Worktree from `cpx/main`, tag pushed, `npm ci`, clean; `npm run typecheck` green.
- [x] Anchors (explorer `ses_ed6bffcdaffenUaigZQ7rRvObZ`) hold: `src\verify\dispatch.ts:101` `WRITE_TOOLS` (write, edit, patch, multiedit, apply_patch); ≈468-488 `record`, apply_patch header parse ≈471-477 (regex ≈475), `extractChangedFile` ≈478; `src\router\git-tools.ts` `verifyRoleRepository` ≈972-981 (`rev-parse --absolute-git-dir --git-common-dir` ≈973); `src\router\run-tools.ts:160` `RunInput {script; args?; cwd}`, ≈882-886 tool args.
- [x] Existing tests of `src\verify\dispatch.ts`: `test\unit\dispatch.test.ts`, `test\unit\dispatch.worktree-list.test.ts` (0.P baseline green).
- [x] `smoke:cpx` green (3× at `7b11504`).

## Implementation notes

### 1.3.1 design memo (architect, heavy pin, `ses_ed6afe96cffe1d40rz5Na3NVV6`)

Orchestrator decisions on the memo (binding for 1.3.2/1.3.3):
- **Ownership:** `src\router\git-tools.ts` is not owned by 1.3. `repoKeyOf` stays an injected seam; the pointer-based adapter (`repositoryIdentity`) is a **handoff to Phase 2.1**, which wires the registry. 1.3.3 tests use a fake `repoKeyOf`.
- **`canonicalPath`** (in `src\verify\dispatch.ts`, owned here) gets an optional `realpath` parameter in task **1.3.2** (default `realpathSync.native`, existing callers unchanged); 1.3.3 imports it after 1.3.2 is committed. Hence the order 1.3.2 → 1.3.3 (sequential, the plan allows ∥).
- **ADR wording:** ADR 0007 D7 "another session" for reads means "another *child* session" (root sessions are never refused reads/searches/runs). Recorded as a handoff to the ADR owner (orchestrator, cpx/main amendment).
- §9 item 6 (`router_git_diff` with a `ref` compares commit ↔ working tree when it runs `git diff <ref> -- <path>`): 1.3.2 must read `inspectGit` and classify a diff with a single ref as `search` (working-tree read), and only a commit-to-commit form as `none`; pinned by a test.

#### 1. How ADR D7 and the current code fit together

| D7 statement | Code today | Decision |
|---|---|---|
| Lease key = repository + normalized repo-relative path | `pathKey` (`src/verify/dispatch.ts:89-93`): `\`→`/`, lowercase on win32. `canonicalPath` (`:72-87`): realpath of the nearest existing ancestor + the non-existent tail. | Two keys: **logical** (repository + relative path) decides write conflicts; **physical** (canonical absolute path) decides read conflicts. |
| Repository identity | `verifyRoleRepository` (`src/router/git-tools.ts:973-981`) checks `rev-parse --git-common-dir` equals `gitPointers(checkout).common` on disk. | Repo key = realpath of the common git dir, case-folded; in the hot path from the `.git` pointer files (no git spawn). |
| Write class | `WRITE_TOOLS` (`dispatch.ts:101`) | `tool-paths.ts` exports `WRITE_CLASS` with the same five names, pinned by a test; `dispatch.ts` keeps its own copy (v1 unchanged). |
| apply_patch targets (not advertised on v2.0.26) | header regex `dispatch.ts:475`; args `patchText` then `patch` (`:472-473`) | The parser moves to `tool-paths.ts` unchanged. |
| `shell`/`execute` not covered | — | `access: "none"` + `uncovered` flag. |
| Read by "another session in the same tree" refused | — | Only child readers are refused/filtered; root sessions never (the orchestrator must not block on its children). |
| Plan-task leases end at integration | — | Scope `until-integrated`; never swept at 6 h. |

Existing helpers: `canonicalPath` (`src/verify/dispatch.ts:72`, exported), `pathKey` (private, `:90`), `canonicalAuthorityPath` (`src/routing/roles/work-root.ts:25`, realpath seam `:31`); private in `src/router`: `realpath` (`git-tools.ts:82`), `foldCase` (`:403`), `sameOnDisk` (`:941`), `nearestRepository` (`:924`), `realpathOrSelf` (`config.ts:483`). Reuse the `canonicalPath` algorithm with an optional `realpath` parameter; add a lexical pre-pass in `leases.ts` (case folding, trailing dots/spaces, `:stream`), or reuse a segment-cleanup helper from `canonicalAuthorityPath` if it handles non-existent paths (1.3.3 checks first).

#### 2. Modules

- `src/router/tool-paths.ts`: **pure**, imports only `node:path`.
- `src/router/leases.ts`: filesystem only through seams; imports `canonicalPath` from `../verify/dispatch.js`; nothing from tool-paths.
- `src/verify/dispatch.ts` imports `applyPatchHeaderPaths` from `../router/tool-paths.js` (no cycle).
- Both new modules stay unwired until 2.1 (v2 only); the `dispatch.ts` change is a no-behaviour-change refactor (goldens, `smoke:v1` green). No CHANGELOG entry until 2.1.

#### 3. `tool-paths.ts` (1.3.2)

```ts
export type Access = "read" | "write" | "search" | "run" | "none";
export interface ToolTargets {
  access: Access;
  paths: string[];   // read/write targets: absolute, resolved lexically against cwd, deduped, first-seen order
  roots: string[];   // search roots (search), the run cwd (run), shell workdir (informational)
  uncovered?: "shell" | "execute";
}
export const WRITE_CLASS: ReadonlySet<string>; // write, edit, multiedit, patch, apply_patch (= dispatch.ts:101)
export function toolTargets(tool: string, args: unknown, cwd: string): ToolTargets;
export function applyPatchHeaderPaths(args: unknown): string[];
```

Rules: never throws; `tool` lowercased; non-plain-object `args` → `{}`; non-string/empty values ignored; `path.resolve(cwd, p)` (lexical only); `cwd` must be absolute (host tools: the session directory; `router_git_*`: the bound work root) — if not, relative paths are dropped, absolute kept; a search with no `path` has root `cwd`.

| Tool | Access | `paths` | `roots` | Basis |
|---|---|---|---|---|
| `read` | read | `path`, fallback `filePath`* | — | observed |
| `write`, `edit` | write | `path`, fallback `filePath`* | — | observed |
| `multiedit` | write | top-level `path`/`filePath`* + each `edits[i].path`/`filePath`* | — | router code |
| `patch`, `apply_patch` | write | `applyPatchHeaderPaths(args)` (Add, Update, Delete, Move to; both paths of a move) | — | `dispatch.ts:471-477` |
| `list` | search | — | `path` ?? cwd | router code |
| `glob` | search | — | `path` ?? cwd, + static prefix of `pattern` if absolute or starting with `..` | observed |
| `grep` | search | — | `path` ?? cwd (`pattern` is a regex) | observed |
| `router_run` | run | — | `cwd` arg ?? cwd | ADR D7 |
| `router_git_blame` | non-empty `ref` → none; else read | `path` | — | QA-0.1-26 |
| `router_git_diff` | see decision above (single-ref diff reads the working tree → search) | — | `path` ?? cwd | QA-0.1-26 |
| `router_git_status`, `router_git_ls_files` | search | — | `path` ?? cwd | QA-0.1-26 |
| `router_git_log`, `router_git_show` | none | — | — | history / committed objects only |
| `shell` | none, `uncovered: "shell"` | — | `workdir` ?? cwd (informational) | ADR D7 |
| `execute` | none, `uncovered: "execute"` | — | — | ADR D7 |
| write-class tool, no extractable target | write | `[]` | — | ADR D7 |
| anything else | none | — | — | — |

\* Copy the fallback keys exactly from `extractChangedFile` (`dispatch.ts:129`).
A read with `paths: []` does nothing; a write with `paths: []` becomes `acquireWrite(holder, null)`.
Git-tool searches are filtered **inside the router tool** (`inspectGit` adds `:(exclude,literal)<rel>` pathspecs for files `filterSearchResults` would omit and reports the count) — a 2.1 wiring task. Empty/whitespace/non-string `ref` counts as absent.

Parser move (behaviour identical: same arg precedence, `.trim()` removes CRLF `\r`, Map dedupe, empty map still created):

```ts
const HEADER = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;   // verbatim from dispatch.ts:475
export function applyPatchHeaderPaths(args: unknown): string[] {
  const a = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const patch = typeof a.patchText === "string" ? a.patchText : typeof a.patch === "string" ? a.patch : "";
  return [...patch.matchAll(HEADER)].map(m => m[1].trim());
}
// dispatch.ts:471-477 becomes:
// if (tool.toLowerCase() === "apply_patch") { const files = bySession.get(sessionID) ?? new Map<string,string>();
//   for (const p of applyPatchHeaderPaths(args)) files.set(p, "modified"); bySession.set(sessionID, files); }
```

#### 4. Key normalization (1.3.3)

`keyOf(raw, base, seams, platform)` (exported for tests) → `PathKey | { unkeyable: string }`, where
`PathKey = { physical, logical, tree: string|null, repo: string|null, rel: string|null, display }`.

1. Unkeyable: non-string, empty after trim, contains NUL.
2. (win32) Unwrap `\\?\X:\…` → `X:\…`, `\\?\UNC\h\s\…` → `\\h\s\…`; unkeyable: other device forms (`\\.\…`, `\\?\Volume{…}`, `\\?\GLOBALROOT…`) and drive-relative `C:foo`.
3. `absolute = path.resolve(base, raw)` (lexical `..`, `.`, separators, trailing separator; POSIX `link/..` limitation documented).
4. (win32) Per segment except the root: strip an NTFS stream suffix (`name:stream[:$DATA]` → `name`), then trailing `[. ]+`; an empty result makes the path unkeyable; leading spaces kept.
5. Nearest-existing-ancestor walk with `seams.realpath` (any error → go up); expands junctions, symlinks and 8.3 names of existing segments; re-apply step 2 to the result.
6. (win32) An 8.3-looking segment in the non-existent tail (`/^[^.~\\/]{1,6}~\d+(\.[^.]{0,3})?$/i`) → unkeyable.
7. `physical = fold(canonical.replace(/\\/g, "/"))` (lowercase on win32); trailing `/` removed except at a root.
8. `id = seams.repoKeyOf(dirOf(realHead))` (seam errors → undefined). In-repo (physical under `id.tree`, prefix checked with a trailing `/`): `rel` = physical minus the tree prefix (`""` for the tree itself), `logical = "r:" + id.repo + "\0" + rel`. Else `logical = "x:" + physical`, tree/repo/rel null.
9. `display` = the absolute path as given.

Known limitations: hard links; Unicode case folding (`toLowerCase` ≠ NTFS upcase table); darwin case-insensitive volumes; junctions created after a lease.
Equivalent spellings → one key: `D:\R\Src\A.ts`, `d:/r/src/a.ts`, `d:\r\src\x\..\a.ts`, `d:\r\src\a.ts.`, `d:\r\src\a.ts `, `d:\r\src\a.ts:zone`, `\\?\D:\r\src\a.ts`, a junction to `d:\r\src`, the 8.3 form of a long directory name.

`repoKeyOf(dir) → { repo, tree } | undefined` (both canonical: realpath'd, `/`, folded) — recommended adapter (2.1): `checkout = nearestRepository(dir)`, `p = gitPointers(checkout)`, `repo = fold(realpath(p.common))`, `tree = fold(realpath(checkout))`, memoized (LRU ≈4096); `gitPointers` throws for network/device pointers → `undefined` (outside key space). **Every seam is synchronous** so `acquireWrite` has no `await` between check and insert.

#### 5. `leases.ts` API (1.3.3)

```ts
export type LeaseScope = "until-complete" | "until-integrated";
export interface Holder { holderID: string; tree: string; isChild: boolean; taskRef?: string; scope: LeaseScope; acquiredAt: number }
export type HolderInput = Omit<Holder, "acquiredAt">;   // acquiredAt = seams.now() when the holderID is first recorded
export interface LeaseSeams { realpath(p: string): string; repoKeyOf(dir: string): { repo: string; tree: string } | undefined; now(): number }
export interface LeaseOptions { runMode: "annotate" | "refuse"; cap?: number /* 10_000 */; sweepAgeMs?: number /* 6 h */; platform?: NodeJS.Platform }
export function createLeaseRegistry(seams: LeaseSeams, opts: LeaseOptions): LeaseRegistry; // TypeError only for invalid runMode/cap
```

**`acquireWrite(holder, path: string | readonly string[] | null)`** (array form = all-or-nothing, for apply_patch):

```ts
| { ok: true; leased: string[]; reentrant: string[]; unkeyed: string[] }
| { ok: false; reason: "held"; holders: [Holder]; path: string; key: string }
| { ok: false; reason: "unknown-target"; holders: Holder[] }
| { ok: false; reason: "cap"; limit: number; held: number }
| { ok: false; reason: "invalid-holder"; message: string }
```

- Holder validation: non-empty `holderID`; `until-integrated` requires `taskRef`; a later call with the same `holderID` but different `tree`/`scope`/`taskRef`/`isChild` → `invalid-holder` (first record wins).
- Root (`isChild: false`): refused `held` if a child holds any of the logical keys (any tree of the repo); else ok, nothing recorded; unknown/unkeyable allowed.
- Child: all keys checked before any mutation; key held by another → `held`; held by the same holder → re-entrant (stored `physical`/`acquiredAt` unchanged, not counted against the cap); `null`/unkeyable → `unknown-target` while another holder has a lease in the same physical tree, else allowed and listed in `unkeyed`; exceeding `cap` → one `sweep()`, then `cap`.

**`checkRead(reader, path)`** → `{ok:true}` | `{ok:false, reason:"underEdit", holders:[Holder], path}`: only for a child reader, a leased logical key with `lease.physical === key.physical`, held by a different holderID. Unkeyable allowed. Outside the repo, refused only for the identical physical file.

**`checkRun(runner, tree)`** → `{ok:true}` | `{ok:true, contaminatedBy, fileCount}` | `{ok:false, reason:"run-refused", holders, fileCount}`: tree via `keyOf(...).tree`; outside any repo → ok; other holders with leases in that tree → root runner always `{ok:true, contaminatedBy}`; child: annotate → contaminatedBy, refuse → `ok:false`. Export `formatRunNote(holders, n)` = exactly `[router] ran while <holder> edits <n> file(s); result may be contaminated` (holder IDs joined with `, `).

**`filterSearchResults(reader, tree, paths)`** → `{kept, omitted, holders}`: entry omitted iff `checkRead` would refuse it; `kept` keeps original strings and order; root readers never filtered; fast path when no lease exists outside the reader's own; per-call memo of directory canonicalization.

**`release(holderID)`** → `{released, retained}`: ends only `until-complete` leases (keeps `until-integrated`), idempotent, drops the holder record when empty. **`releaseTask(taskRef)`** → `{released, holders}`: ends every lease of holders with that `taskRef`. **`sweep()`** → `{released, holders}`: drops `until-complete` holders with `now() - acquiredAt >= sweepAgeMs`; future stamps never swept; `until-integrated` exempt. **`snapshot()`** → `{version: 1, takenAt, holders, leases: {logical, physical, tree, holderID, display}[]}` (plain JSON). **`restore(s)`** → `{ok:true, leases}` | `{ok:false, reason:"invalid-snapshot", message}`: validates everything first (version, fields, holders exist, unique logical keys, cap), then replaces state and rebuilds indexes (no filesystem calls).

Indexes: `leases: Map<logical, {holderID, physical, tree, display}>`; `holders: Map<holderID, {holder, keys}>`; `treeHolders: Map<tree, Map<holderID, count>>`; `tasks: Map<taskRef, Set<holderID>>`; a total counter. Checks O(1) in leases (+ O(depth) realpath calls).

Conflict matrix (child A holds X in tree T1 of repo R):

| Actor | X in T1 | same rel path in T2 | other file in T1 |
|---|---|---|---|
| child write | `held` (A) | `held` | ok |
| root write | `held` (A) | `held` | ok |
| child write, unknown target | `unknown-target` | ok (in T2) | `unknown-target` |
| child read | `underEdit` | ok | ok |
| root read/search | ok | ok | ok |
| child search | X omitted, counted | kept | kept |
| child `router_run` cwd in T1 | annotate / refuse | ok (cwd T2) | — |
| root `router_run` cwd in T1 | ok + annotated (even under refuse) | ok | — |

Deny-not-wait: no blocking/queueing → no wait-for graph → no deadlock; roots never denied reads → the orchestrator cannot be in a cycle. Livelock possible (two children needing each other's file); mitigations: the refusal names the holder and says not to retry until that session ends; leases end at execution end; executor footprints avoid co-scheduling overlaps; 2.1 may escalate wording after N identical refusals. Over-leasing accepted (a write that fails after acquiring keeps its lease until release).

#### 6. Tests (1.3.4) — setup

Spellings → one key: real fs in a temp dir, real `realpathSync.native`, fake `repoKeyOf` mapping prefixes; junction via `fs.symlinkSync(target, link, "junction")`; 8.3 via `cmd /c for %A in ("<p>") do @echo %~sA` (skip if equal to the long name). Outside repo → `x:` key, no collision. Every conflict row (annotate and refuse). Re-entrant re-acquire (cap count unchanged). Root edits then child reads/runs → allowed. Root write vs child-held → `held` naming the child. Scopes (`release` keeps `until-integrated`; `releaseTask` ends them; `invalid-holder` without `taskRef`). `filterSearchResults` (omitted, order, fast path, root not filtered). Sweep with fake `now` (6 h − 1 ms kept; 6 h released; future kept). Cap (default 10 000, and `cap: 3`; array form all-or-nothing; refusal text). Snapshot/restore (round trip; corrupted rejected with state unchanged; restore replaces). Every tool-shape row incl. apply_patch add/update/delete/update+move with CRLF, empty/null/string args, non-string paths, `ref: ""`, `WRITE_CLASS` pinned to `dispatch.ts:101`. Existing `dispatch.ts` record tests pass unchanged.

#### 7. Risks

ADR D7 wording vs root exemption (docs fix); a leaked `until-integrated` lease blocks until the executor reconciles it; POSIX `..` after a symlink handled lexically.

#### 8. Check before coding (memo author hit its read cap)

1. `canonicalPath` lines 72-79 (resolve first, then walk ancestors). 2. `extractChangedFile` (`dispatch.ts:129`) path keys. 3. `canonicalAuthorityPath` (`work-root.ts:25-31`) reuse for non-existent paths. 4. `router_run` schema (`run-tools.ts ≈160, ≈882-885`) and behaviour without `cwd`. 5. `nearestRepository`/`gitPointers` bodies (`git-tools.ts:924`, `:367`). 6. `inspectGit` diff-with-ref form (decision above).

## Findings

## Fixes

## Deferred findings

## Handoffs

- To 2.1: the `repoKeyOf` adapter (`repositoryIdentity(dir)` from `src\router\git-tools.ts`, pointer-based, memoized; needs `nearestRepository` exported) and its `git init` + `git worktree add` test; git-tool search filtering inside `inspectGit` via exclude pathspecs.
- To the orchestrator (ADR 0007 amendment): D7 "another session" → "another child session" for read/search/run restrictions.

## Verdict
