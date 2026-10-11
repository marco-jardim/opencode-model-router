# Phase 2.4 — Worktree slot pool and provisioning

Worktree `D:\git\omr-cpx-p24`, branch `cpx/p24`, base tag `cpx/p24-base` = `558e5b8`. Started 2026-10-11 06:17.

## Pre-flight

- [x] Depends on: merged into `cpx/main` (Wave 1 merges `12d42b7`, `6d310eb`, `d4d731b`, `a9e32c1`; 0.1 final `915b96a`).
- [x] Worktree from `cpx/main` at `558e5b8` (tag `cpx/p24-base`, pushed), `npm ci`, clean; typecheck green; `smoke:cpx` 52/52 and `smoke:keyless`/`smoke:v1` = baseline at `915b96a`.
- [x] Anchors and task list (explorer `ses_ed5b8fcf1ffekca1nfk7hM00V2`): no write-set overlap between Wave-2 phases; within 2.1, `src\index.ts` (2.1.4 then 2.1.6) and `docs-drift.test.ts` (2.1.2 then 2.1.7) are sequential.
- [x] Anchors hold: `gitEnvironment` ≈145, `hardeningArgs` ≈152, `spawnBounded` ≈582, `resolveNpmCli` ≈466, `npmHardeningFlags` ≈551, `runEnvironment` ≈357, spawn ≈856, `mergeEnv` ≈396. `reference.ts` is written by 2.1: 2.4 imports only exports.

## Implementation notes

### 2.4.1 design memo (architect, heavy pin, `ses_ed5b654a5ffeMOMKe5K6bZvNI5`)

Orchestrator decisions (binding):
- DV1–DV10 approved.
- §10.1: `package.json` (script `smoke:cpx:provision`) joins the 2.4.6 Writes.
- 2.3 O1: export `defaultSlotsDir(toplevel, planId)` = `<repo drive>:\.omr-slots\<planId>` from `slots\pool.ts`; the integration slot path is `ledger.integration.worktree`.
- Measurements M1–M10 are taken by the 2.4.3/2.4.4 implementers through `router_run` where possible, else by the orchestrator shell, and recorded under `## Measurements`.

# 2.4.1 Design memo: worktree slot pool and provisioning

## 0. Decisions that change the plan text (2.4.2–2.4.6 code against these)

| # | Plan says | Decision | Why |
|---|---|---|---|
| DV1 | marker `<markersDir>\<slot>.json` (plan 2644) | `<markersDir>\<planId>\<slot>.json`, with `markersDir = <executorHome>\slots` | Slot names repeat across plans (`SlotRecord.slot` is `"slot-<n>"`, types.ts:201). `gc` must see every plan's markers (types.ts:1396). |
| DV2 | GC runs `worktreeRemove`, then removes the directory (plan 2652) | Reversed: link sweep, then `fs.rm`, then `git worktree remove --force` **only when the directory is already gone** | Measured in 1.5: `git worktree remove --force` follows junctions and deletes what they point to (reference.ts:397-398, 406-408, 626-630). Same rule as R2/R4 (reference.ts:457-477). |
| DV3 | `worktreeAdd` (detached) | `worktree add --detach --lock --reason <slotLockReason>`; requires git ≥ 2.33, otherwise `E_GIT` | A lock stops a user's or an IDE's `remove`/`prune` from emptying a live slot (reference.ts:255-270, 649-655). |
| DV4 | drift checked at `reset` (plan 2648) | Also checked at `cleanForChecks` | The queue rebases or cherry-picks in the slot before checks (ADR D10/D11, 0007:457-459, 475). Without this, a manifest change would run checks against stale dependencies. |
| DV5 | `-e` exclusions only for `clean -x` (plan 2623-2624) | Every slot git call also gets `-c core.excludesFile=<home>\git\slot-excludes` | Without it, `clean -ffd` (reset) deletes a `.venv` the repo does not ignore, and `addAll` commits it. Writing `info/exclude` is forbidden (plan 2646). |
| DV6 | identity read with the user's env | The same one-time read also snapshots `core.autocrlf` and `core.eol` (data only) and passes them as `-c` | `gitEnvironment` sets `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=NUL` (git-tools.ts:148). That drops Git for Windows' system `core.autocrlf=true`, so slots would check out and commit different line endings from the user's checkout. |
| DV7 | `branchForce` "only under `omr/`" (plan 2629) | Only under `omr/<boundPlanId>/`; optional compare-and-swap old value | Matches the `deleteRefs` rule (plan 2765-2766). |
| DV8 | env removes `PYTHONPATH` (plan 2701-2702) | Also removes `PYTHONHOME`, `NODE_PATH`, `UV_PROJECT_ENVIRONMENT` | Each one can make a slot import another checkout's code, which is a QA focus (plan 2739). |
| DV9 | (not in the plan) | Provisioning env drops credential-like variables (`isCredentialEnv`, run-tools.ts:337) | Same "no passthrough" rule as `router_run`. Registry auth still works through the user's `~/.npmrc` and `pip.conf`. |
| DV10 | `acquire` "serialized" (types.ts:1384) | The claim step is serialized under the pool mutex. The slow work (create, reset, provision) runs under the slot's own mutex. | No double lease, and launches stay parallel. |

## 1. Module map and import rules

- `src/executor/git.ts` imports `router/git-tools` (`spawnBounded`, `gitEnvironment`, `hardeningArgs`, `gitExecutable`, `workRootGuards`, `gitPointers`, `stripUrlUserinfo`) and `./types`.
- `src/executor/slots/provision.ts` imports:
  - `router/run-tools`: `resolveNodeExecutable` (433), `resolveNpmCli` (466), `resolveSystemShell` (485), `npmHardeningFlags` (551), `npmConfigPins` (605), `runEnvironment` (357), `isCredentialEnv` (337);
  - only the export `DEPENDENCY_FILES` (and the constants listed in §7) from `verify/reference`.
- `src/executor/slots/pool.ts` imports `../git`, `./provision`, `./env`, `../types`, and from `verify/reference` only `TRANSIENT_FS_CODES`, `CLEANUP_RETRIES`, `CLEANUP_RETRY_BASE_MS` and `isStrictlyInside` (909-912, 972).
  - `withRetry` (1065) is private and Phase 2.1 owns that file, so pool.ts re-implements the same flat loop: `fs.rm` with `maxRetries: 0`, backoff 100·2ⁿ ms, deadline-aware.
- `src/executor/slots/env.ts` imports only `node:path`, `node:fs` (`realpathSync.native`), and `isInside`/`envLookup` from git-tools (286, 292). No executor runtime, because `router/run-tools` and `verify/exec` import it.
- v1 policy: the env registry is empty unless a v2 executor pool registered slots, so v1, the goldens and `smoke:v1` are unaffected.

## 2. `src/executor/git.ts`

### 2.1 Runner and argv

```ts
export const MIN_GIT_VERSION = [2, 33, 0] as const;
export const GIT_OP_TIMEOUT_MS = 120_000;          // confirm with M6
export const GIT_WORKTREE_ADD_TIMEOUT_MS = 600_000; // confirm with M6
export const GIT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Production GitRunner: spawnBounded(gitExecutable(workRootGuards(toplevel)), args, cwd, {env, timeoutMs, maxBytes, signal}).
 *  mode "hardened": env = gitEnvironment(o.env ?? {}) (o.env is EXTRA, never a replacement).
 *  mode "user": env = process.env minus GIT_DIR, GIT_WORK_TREE, GIT_COMMON_DIR, GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY,
 *  GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_NAMESPACE, GIT_CEILING_DIRECTORIES; + GIT_TERMINAL_PROMPT=0. Used for identity only.
 *  failure "timed out" -> throw {code:"ETIMEDOUT"}; truncated -> throw {code:"EOUTPUT"}; never a shell (git-tools.ts:587). */
export function createGitRunner(o: { mode: "hardened" | "user"; toplevel: string }): GitRunner;

export interface GitContext {
  hooksDir: string;        // <home>\git\no-hooks : empty real dir created by the executor
  excludesFile: string;    // <home>\git\slot-excludes
  conversion: { autocrlf: string | null; eol: string | null }; // DV6 snapshot
}
/** hardeningArgs() (git-tools.ts:152) then, in this order (later -c wins over the NUL hooksPath at :154):
 *  -c core.longpaths=true -c core.hooksPath=<hooksDir> -c core.excludesFile=<excludesFile>
 *  -c core.editor=: -c sequence.editor=:            (":" = git never launches an editor)
 *  -c commit.gpgSign=false -c tag.gpgSign=false -c tag.forceSignAnnotated=false
 *  -c rebase.updateRefs=false -c rebase.autoStash=false -c rebase.autoSquash=false -c merge.autoStash=false
 *  -c rerere.enabled=false -c submodule.recurse=false -c advice.detachedHead=false -c user.useConfigOnly=true
 *  [-c core.autocrlf=<v>] [-c core.eol=<v>] */
export function executorGitArgs(c: GitContext): string[];
```

- Before the first use in each process, `hooksDir` must pass lstat as a real directory (not a link) and `readdir` must return `[]`. Otherwise throw `E_GIT` ("hooks directory is not empty").
- `slot-excludes` is fixed content, written once:
  ```
  node_modules/
  /.venv/
  /.yarn/cache/
  /.yarn/unplugged/
  /.yarn/install-state.gz
  /.pnp.*
  *.egg-info/
  ```
  Ignore rules never affect tracked files, so tracked `.pnp.cjs` and `.yarn/releases` still commit.

### 2.2 Slot git calls never trust the slot's `.git`

`verifySlotPointers(slot)` uses `gitPointers` (git-tools.ts:367). It requires all of:
- `.git` is a regular file;
- `linked === true`;
- `common` equals the repository's common dir (case-folded on win32);
- the gitdir is `<common>\worktrees\<x>`;
- `<gitdir>\gitdir` resolves back to `<slot>\.git`.

Every in-slot call then runs as `git <prefix> --git-dir=<gitdir> --work-tree=<slot> …` with `cwd = slot`. A rewritten `.git` file therefore cannot redirect a clean or commit into another repository. A mismatch is `E_SLOT_BROKEN`.

### 2.3 Identity (2.4.2.b)

```ts
export interface CommitIdentity { name: string; email: string }
/** Once per toplevel per process (cached): userGit `config --includes --get user.name` / `user.email`, cwd = toplevel.
 *  Exit 1 or empty -> E_IDENTITY: "No git commit identity for <toplevel>: run git config user.name "…" and
 *  git config user.email "…" (repository or global). The executor never invents one."
 *  Rejects values containing NUL, CR, LF, '<' or '>' (E_IDENTITY). Never uses `git var` (it can synthesise an identity). */
export function readCommitIdentity(userGit: GitRunner, toplevel: string): Promise<CommitIdentity & { conversion: GitContext["conversion"] }>;
```

`-c user.name=… -c user.email=…` is added only to `commit`, `rebaseOnto`, `cherryPick` and `revert`. `gitEnvironment` already strips `GIT_AUTHOR_*` and `GIT_COMMITTER_*` (git-tools.ts:139-142).

### 2.4 Commit messages

```ts
export type CommitType = "feat" | "fix" | "test" | "docs" | "revert";
export const COMMIT_TITLE_MAX = 72;
/** Plan 2.4.2.b pattern, applied to the whole subject; `.{1,72}` bounds the TITLE (a suffix of up to 41+64 chars cannot fit 72). */
export const COMMIT_SUBJECT_PATTERN =
  /^(feat|fix|test|docs|revert)\(([\w.-]+)\): (.{1,72}) \[([a-z0-9][a-z0-9-]{2,40}):([A-Za-z0-9][A-Za-z0-9._-]{0,63})\]$/;
/** task -> feat, or docs when footprint.writes is non-empty and every path ends in .md or starts with docs/; fix -> fix;
 *  tests -> test; qa -> docs; manual/preflight -> E_INVALID_INPUT (they never commit). */
export function commitTypeFor(t: Pick<TaskNode, "kind" | "footprint">): Exclude<CommitType, "revert">;
/** scope = phaseId ?? "plan". The title has C0/C1 controls replaced by spaces, whitespace collapsed and is trimmed;
 *  if empty it becomes taskId. If it is longer than 72: cut at the last space at or before 72 when that leaves at least
 *  20 chars, else hard cut at 72, then trimEnd. One line, no body, no trailers. Throws E_INVALID_INPUT if the result
 *  fails COMMIT_SUBJECT_PATTERN. */
export function formatCommitMessage(i: { type: CommitType; scope: string; title: string; planId: PlanId; taskId: TaskId }): string;
```

The commit command is `commit --no-verify --no-gpg-sign --cleanup=verbatim -m <subject>`. `verbatim` matters because the default cleanup would strip a title that starts with `#`.

### 2.5 Ref names (2.4.2.c)

```ts
/** Accepts /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/ only; anything else (space ~ ^ : ? * [ \ @ /) -> E_INVALID_INPUT.
 *  Per char: [a-z0-9-] kept; [A-Z] lower-cased; "_" -> "__"; "." kept unless the next char is "." or it is the last char,
 *  then "_0". If any uppercase existed, append "_u" + lowercase hex of the uppercase-position bitmask. If the result ends
 *  in ".lock", that "." becomes "_0". Injective (decodable left to right) and case-fold-safe (output has no uppercase),
 *  so "T1"/"t1" never share a loose-ref file on NTFS. Examples: 1.1.1 -> 1.1.1 ; 2.4.QA -> 2.4.qa_u30 ; a..b -> a_0.b ;
 *  x.lock -> x_0lock ; t_1 -> t__1 */
export function encodeRefId(id: string): string;
export function planRefPrefix(planId: PlanId): string;          // `omr/${planId}/` (PLAN_ID_PATTERN, types.ts:24)
export function taskBranchName(planId: PlanId, taskId: TaskId): string;  // omr/<planId>/t/<enc>  (types.ts:124)
export function integrationBranchName(planId: PlanId): string;  // omr/<planId>/integration (types.ts:81)
export function phaseTagName(planId: PlanId, phaseId: PhaseId): string;  // omr/<planId>/phase/<enc> (3.2 may adopt)
```

`GitOps.checkRefFormat(name)` runs `git check-ref-format refs/heads/<name>`, caches the result per name, and throws `E_INVALID_INPUT` on a non-zero exit.

### 2.6 Operations

```ts
export interface GitOpsDeps {
  git: GitRunner; userGit: GitRunner; fs: FileSystem; planId: PlanId;
  toplevel: string; executorHome: string; timeoutMs?: number;
}
export type Conflict = { ok: false; conflicts: string[] };
export interface GitOps {
  readonly planId: PlanId;
  version(): Promise<string>;                                   // E_GIT if < MIN_GIT_VERSION
  checkRefFormat(name: string): Promise<void>;
  verifySlotPointers(slot: string): Promise<{ gitdir: string; common: string }>;
  // cwd = toplevel
  worktreeAdd(path: string, commit: string, lockReason: string): Promise<void>;
  /** pre: lstat(path) is ENOENT (else E_GIT, never runs). If locked with exactly lockReason: `worktree unlock`, then
   *  `worktree remove --force <path>` (drops the admin entry only). Never `worktree prune`. */
  worktreeRemove(path: string, lockReason: string): Promise<void>;
  worktreeList(): Promise<Array<{ path: string; head: string | null; branch: string | null; locked: string | null }>>;
  // cwd = slot, explicit --git-dir/--work-tree (§2.2)
  /** `rebase --quit`, `cherry-pick --quit`, `revert --quit`, `merge --quit` when their state files exist, then
   *  `checkout --detach --force <commit>` */
  checkoutDetach(slot: string, commit: string): Promise<void>;
  cleanTracked(slot: string): Promise<void>;                    // clean -ffd (excludesFile protects dependency dirs)
  cleanForChecks(slot: string, keep: readonly string[]): Promise<void>; // clean -ffdx -e <keep…>; then `clean -ndx -e …` must print nothing
  statusPorcelain(slot: string): Promise<Array<{ xy: string; path: string; orig: string | null }>>; // --porcelain=v1 -z --untracked-files=all --ignore-submodules=all
  addAll(slot: string): Promise<void>;                          // add --all
  commit(slot: string, message: string): Promise<string>;       // validates message; returns new HEAD
  revParse(cwd: string, rev: string): Promise<string>;          // rev-parse --verify --end-of-options <rev>^{commit}
  diffNames(cwd: string, from: string, to: string): Promise<string[]>; // diff --name-only -z --no-renames from to --
  rebaseOnto(slot: string, onto: string, upstream: string): Promise<{ ok: true; head: string } | Conflict>;
  rebaseAbort(slot: string): Promise<void>;                     // idempotent (crash recovery)
  cherryPick(slot: string, commits: readonly string[]): Promise<{ ok: true; head: string } | Conflict>;
  /** revert --no-commit <c>, then commit -m message */
  revert(slot: string, commit: string, message: string): Promise<{ ok: true; head: string } | Conflict>;
  mergeFfOnly(cwd: string, commit: string): Promise<{ ok: boolean; head: string }>; // merge --ff-only --no-edit
  isAncestor(a: string, b: string): Promise<boolean>;           // merge-base --is-ancestor: 0 true, 1 false, else E_GIT
  tag(name: string, commit: string): Promise<void>;             // lightweight; name under planRefPrefix
  /** prefix === planRefPrefix(planId) or a deeper "/"-terminated sub-prefix of it that passes the ref rules; anything else
   *  (omr/, cpx/, another plan, a prefix without trailing "/", any ".." segment) -> E_INVALID_INPUT. Lists
   *  `for-each-ref --format=%(refname)%00%(objectname) refs/heads/<prefix> refs/tags/<prefix>`, re-filters with
   *  startsWith, deletes each with `update-ref -d <ref> <oid>` (compare-and-swap). Returns the deleted refs. */
  deleteRefs(prefix: string): Promise<string[]>;
  /** name under planRefPrefix; refuses (E_GIT) when `worktree list` shows refs/heads/<name> checked out anywhere;
   *  `update-ref refs/heads/<name> <commit> [<expectedOld | zero-oid when null>]` */
  branchForce(name: string, commit: string, expectedOld?: string | null): Promise<void>;
}
export function createGitOps(d: GitOpsDeps): GitOps;
```

- Every commit argument must match `GIT_ID_PATTERN` (types.ts:48), except where `rev` is resolved by `revParse`.
- A non-zero exit becomes `E_GIT` with detail `{op, code, stderr: last 2 KiB through stripUrlUserinfo}`.
- On a conflict, `rebaseOnto`, `cherryPick` and `revert` read `diff --name-only --diff-filter=U -z`, run their own `--abort`, and return the conflicted paths. If no conflicted paths are found, that is `E_GIT`.

## 3. Slot layout and markers

- `slotsDir` comes from `ledger.config.slotsDir` (trusted; types.ts:273, 945-947). At `open()` it must be:
  - an absolute drive-letter path (not UNC: npm scripts run in cmd.exe, run-tools.ts:682-686);
  - a real directory (lstat, not a link);
  - not a filesystem root;
  - not inside the repository toplevel;
  - not claimed by a marker of another plan (else `E_SLOT_UNAVAILABLE`), because slot directories must be plan-unique. D18 owns the default; recommend `<repo drive>:\.omr-slots\<planId>`.
- Contents: `slot-<n>\`, `integration\`, `ci\`. `SLOT_NAME_PATTERN = /^(?:slot-[1-9][0-9]{0,2}|integration|ci)$/`. `ledger.integration.worktree` is `<slotsDir>\integration`.
- Markers live at `<executorHome>\slots\<planId>\<slot>.json`. The content is exactly `SlotRecord` (types.ts:199-216); `manifests` maps paths to sha256 of on-disk bytes.
  - Writes: write a temp file `<slot>.json.<16hex>.tmp` with fsync, rename it, then `fsyncDir`.
  - Reads: bounded to 64 KiB and checked by a new `isSlotRecord` guard in pool.ts.
  - The pool keeps an in-memory copy and writes through.
- `slotLockReason(planId, slot)` = `` `omr-executor slot ${planId}/${slot}: managed by the model-router executor; remove with router_plan action=gc` ``.
- Executor home also holds `git\no-hooks\` and `git\slot-excludes`. 2.4.5.c hands off to 5.1: role children get edit/exec only in their own slot path and never in executor home.

## 4. `src/executor/slots/pool.ts`

```ts
export const UNKNOWN_PLAN_GC_AGE_MS = 7 * 24 * 3_600_000;
export const SLOT_SWEEP_MAX_ENTRIES = 2_000_000; // confirm with M10
export const SLOT_RM_BUDGET_MS = 120_000;        // per slot, confirm with M7
export const RESET_RETRY_DELAY_MS = 2_000;
export interface SlotPoolDeps {
  planId: PlanId; repoKey: string; toplevel: string; slotsDir: string; markersDir: string; executorHome: string;
  maxParallel: number; git: GitOps; fs: FileSystem; clock: Clock; provisioner: Provisioner;
  platform?: NodeJS.Platform; logger?: { warn(m: string): void };
  onProvision?: (slot: string, managers: readonly string[]) => void; // test and smoke hook
}
export function isSlotRecord(v: unknown): v is SlotRecord;
export function slotLockReason(planId: PlanId, slot: string): string;
export function markerPath(markersDir: string, planId: PlanId, slot: string): string;
/** Pure guard (like assertSafeRefDir, reference.ts:989): absolute, no "."/".." segment, basename matches SLOT_NAME_PATTERN
 *  and equals `slot`, the parent IS slotsDir (comparable, case-insensitive on win32), and slotsDir is not a filesystem root. */
export function assertSafeSlotDir(path: string, slot: string, slotsDir: string, platform?: NodeJS.Platform): void;
export function createSlotPool(d: SlotPoolDeps): SlotPool & { open(): Promise<void> };
/** Standalone, for router_plan action=gc with no plan open; SlotPool.gc delegates to it. */
export function gcSlots(d: Omit<SlotPoolDeps, "planId" | "maxParallel" | "provisioner" | "onProvision">,
  isFinished: (planId: PlanId) => Promise<boolean | null>): Promise<{ removed: string[]; reported: string[] }>;
```

### 4.1 Lifecycle (marker states)

```
absent --claim--> creating --worktreeAdd ok--> provisioning --ok--> leased(owner)
ready  --claim--> resetting --clean, no drift--> leased ; resetting --drift--> provisioning --> leased
leased --reset(slot,c)--> resetting --> leased (same owner)      leased --release--> ready (owner null; tree untouched)
creating|provisioning|resetting --failure--> broken (owner null)
broken|any (gc / repair) --> retired --dir gone + admin entry removed--> marker deleted (absent)
```

- `open()` loads the plan's markers and registers the env (§6).
- A marker found in `creating`, `provisioning` or `resetting` with no in-flight work in this process was interrupted.
  - It stays counted and owned.
  - The next call for that owner (or `reset`) repairs it by re-running the stage from the start:
    - `creating`: if the pointers check out, go on to provisioning. If the directory is absent or empty, add again. Otherwise retire and recreate.
    - `provisioning`: provision fresh.
    - `resetting`: reset again.
  - This is 2.4.3.d.

### 4.2 `acquire(planId, owner, baseCommit)`

- Preconditions: `planId === d.planId`, `GIT_ID(baseCommit)`, and `owner` is 1–128 printable characters. Otherwise `E_INVALID_INPUT`.
- Claim step, under the pool mutex (marker I/O only):
  1. If a non-retired task slot already has `owner === owner`, take it in "same" mode.
  2. Else take the `ready` task slot ordered by `commit === baseCommit` first, then oldest `updatedAt`. Write it as `resetting` with this owner.
  3. Else, if fewer than `maxParallel` task slots are non-retired, pick the smallest `n` with no marker and no directory. Write `creating` with this owner.
  4. Else, if a `broken` slot exists, write it as `retired` and create a new name as in step 3.
  5. Else throw `E_SLOT_UNAVAILABLE` with detail `{maxParallel, leased:[…]}`. It never waits.
- Work step, under the slot mutex:
  - "same" mode: a `leased` slot is returned as-is (no tree change; the caller calls `reset` when it wants a fresh tree). An in-flight stage is awaited. An interrupted stage is repaired.
  - create: `worktreeAdd(path, base, slotLockReason)`, `verifySlotPointers`, then provision.
  - reset: the reset routine (§4.3).
  - On failure: write `broken` with owner null, unregister the env, and throw. Installer failures are `E_PROVISION`; git or fs failures in the slot are `E_SLOT_BROKEN`; a bad commit is `E_GIT`.
- Returns `SlotLease {slot, path, planId, owner, commit}`, where `path` is the lease tree (types.ts:1467; phase-1.4.md:906, 1117-1119). Leases stay with the caller: Rt acquires them after this call and releases the slot if `acquireTask` fails.
- Race contract (8 acquires on 4 slots): exactly 4 fulfil with distinct slots and 4 reject with `E_SLOT_UNAVAILABLE` immediately. A repeated owner gets the same slot.
- `acquireSpecial(planId, kind)`: the same algorithm on the single `integration` or `ci` slot, with `owner = kind`. The commit is the slot's current HEAD; the queue then calls `reset`.

### 4.3 `reset`, `cleanForChecks`, `release`

- `reset(slot, commit)`:
  - Precondition: the slot is `leased`, or `resetting` while being repaired.
  - Steps: write `resetting`; `verifySlotPointers`; untracked-link sweep (§4.5, dependency directories skipped); `checkoutDetach`; `cleanTracked`.
  - Postcondition: `revParse(HEAD) === commit` and `statusPorcelain` is `[]`. On failure, retry once after `RESET_RETRY_DELAY_MS`, then `E_SLOT_BROKEN`: "files in slot-N are held by a running process; stop it and retry".
  - Then the drift check; on drift, provision.
  - Finally write `leased` with `commit`.
- `cleanForChecks(slot)`:
  - Precondition: `leased`.
  - Steps: `verifySlotPointers`; link sweep; `git.cleanForChecks(slot, keepFor(marker.managers))`; drift check, and provision if needed (DV4).
  - `keepFor`: Node managers give `node_modules`; yarn-berry adds `/.yarn` and `/.pnp.*`; Python managers give `/.venv`.
- `release(slot)`: `leased` becomes `ready` with owner null. An in-flight stage is awaited first. Every other state is a no-op. It is idempotent and never touches the tree.

### 4.4 Drift rule

The detection is `(managers sorted, manifests path→sha256)`, computed on disk after every HEAD change made under pool control (reset, cleanForChecks). Re-provision when the manager set differs, or when any manifest path is added, removed or changed. A partial provision failure leaves the marker `broken` with the old digests. Changes to `executor.provision` or `executor.python` apply to new slots and on the next drift; this limitation must be documented.

### 4.5 GC (2.4.3.c) and link safety

- Candidates come only from valid markers under `<markersDir>\*\*.json`:
  - the guard passes, the file name matches `planId`/`slot`, and `assertSafeSlotDir` passes for `record.path`;
  - the plan is finished (`isFinished` returns true), or unknown (returns null) and `now − updatedAt ≥ 7 d`.
- Directories scanned for unmarked entries: `dirname` of every valid marker path, plus the pool's `slotsDir`. Every entry there without a marker is reported and never touched.
- Per-candidate pipeline. Any failure keeps the marker `retired` and reports `"<path>: <reason>"`.
  1. Re-read and re-validate the marker, then write `retired`.
  2. Read `gitPointers` before deleting anything. If they are invalid, skip step 7 later and report it.
  3. Run `assertSafeSlotDir` immediately before deleting. lstat must show a real directory; a missing directory skips to step 6.
  4. Full link sweep (rules below).
  5. `fs.rm(path, {recursive:true})` inside the flat retry loop, within `SLOT_RM_BUDGET_MS` and the GC deadline.
  6. lstat must be ENOENT; if not, stop (EBUSY leftover).
  7. `git.worktreeRemove(path, slotLockReason)` with `cwd` = the main worktree derived from `common`. Never `worktree prune`.
  8. Delete the marker, and the plan's marker directory once it is empty. Never delete `slotsDir`.
- Link sweep (used here, and before reset and clean with dependency directories skipped):
  - lstat walk; a `symlink` or `junction` entry is removed with `fs.rm(p, {recursive:false})`;
  - never descend into a link;
  - before each `readdir`, `realpath(current)` must be inside `realpath(slot)`;
  - in pre-clean mode, links that are tracked (mode 120000 in `ls-files -s`) are left alone;
  - stop with a report when `SLOT_SWEEP_MAX_ENTRIES` is exceeded.
- Triggers: plan completed or aborted, `router_plan action=gc`, and `purge` (types.ts:1730).

## 5. `src/executor/slots/provision.ts`

```ts
export type Manager = "pnpm" | "npm" | "yarn" | "uv" | "poetry" | "pip";
/** Node: DEPENDENCY_FILES basenames (reference.ts:923-935) at any depth; pip: /^requirements.*\.txt$/, pyproject.toml,
 *  setup.py, setup.cfg; uv: uv.lock, pyproject.toml; poetry: poetry.lock, pyproject.toml. Matched against `git ls-files -z`
 *  of the slot (tracked paths, any depth, never under node_modules/ or .venv/). */
export const PROVISION_MANIFESTS: Readonly<Record<Manager, (repoPath: string) => boolean>>;
export const DEPENDENCY_DIRS: Readonly<Record<Manager, readonly string[]>>;
export const PROVISION_STEP_TIMEOUT_MS = 1_200_000; // >= 10x max(M1, M2), confirm
export interface Detection {
  managers: Manager[]; yarnBerry: boolean; editable: boolean;
  manifests: Record<string, string>; python: string | null;
}
export function detectManagers(slot: string, tracked: readonly string[], fs: FileSystem,
  config: Pick<ExecutorConfig, "provision" | "python">): Promise<Detection>;
export function needsProvision(rec: Pick<SlotRecord, "managers" | "manifests">, d: Detection): boolean;
export interface ProvisionStep {
  manager: Manager; command: string; args: string[]; env: Record<string, string>;
  cwd: string; timeoutMs: number; label: string;
}
export interface ProvisionHost { env: NodeJS.ProcessEnv; platform: NodeJS.Platform; nodeExecPath?: string; guards: readonly string[] }
export function planProvision(slot: string, d: Detection, host: ProvisionHost,
  config: Pick<ExecutorConfig, "provision" | "python">): ProvisionStep[]; // E_PROVISION on a missing binary
export function managerLockPath(m: Manager, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string;
export interface Provisioner {
  provision(slot: string, d: Detection, o: { fresh: boolean; signal?: AbortSignal }): Promise<void>;
}
export function createProvisioner(d: {
  spawner: Spawner; fs: FileSystem; clock: Clock; host: ProvisionHost;
  config: Pick<ExecutorConfig, "provision" | "python">;
}): Provisioner;
```

### 5.1 Detection, in order

- Node:
  1. An override key forces the manager.
  2. `package.json` `"packageManager"` names pnpm, npm or yarn.
  3. Exactly one root lockfile: `pnpm-lock.yaml`, `package-lock.json` or `yarn.lock`. With `yarn.lock`, berry is chosen iff `.yarnrc.yml` exists.
  4. Several root lockfiles: `E_PROVISION` "ambiguous lockfiles …; set packageManager or executor.provision".
  5. `package.json` with no lockfile: no manager when it declares no dependencies; otherwise `E_PROVISION` "commit a lockfile".
- Python: `uv.lock` gives uv; else `poetry.lock` gives poetry; else root `requirements.txt` or a pyproject `[build-system]` gives pip.
- Managers are multi-valued, e.g. `["pip", "pnpm"]`, and run in sorted order.

### 5.2 Argv (no shell)

Each command resolves to an absolute executable outside `workRootGuards(slot)` (G4).

- npm: `node <npm-cli.js> <npmHardeningFlags(shell, pins) minus --workspaces=false> ci --prefer-offline --no-audit --no-fund`. It uses `resolveNodeExecutable`, `resolveNpmCli`, `resolveSystemShell` and `npmConfigPins`.
- pnpm, first match wins:
  - `pnpm.exe` on an absolute PATH entry;
  - `node <dir>\node_modules\pnpm\bin\pnpm.cjs`, where `<dir>` is the directory holding `pnpm.cmd` on PATH;
  - `node <nodeDir>\node_modules\corepack\dist\pnpm.js`.
  - Then `install --frozen-lockfile --prefer-offline --config.confirm-modules-purge=false`.
  - `resolveCommandExecutable` is not reused because it refuses package-manager stems (run-tools.ts:497-503).
- yarn classic: `node yarn.js install --frozen-lockfile --non-interactive`. Yarn berry: `node <yarnPath from .yarnrc.yml, inside the slot> install --immutable`.
- uv: `uv.exe sync --frozen [--python <executor.python>]`.
- poetry: `poetry.exe install --no-interaction` with `POETRY_VIRTUALENVS_IN_PROJECT=true`.
- pip:
  - `<python> -m venv .venv`, where `<python>` is `executor.python`, else `py.exe -3` on win32 or `python3` on POSIX. Refuse the `%LOCALAPPDATA%\Microsoft\WindowsApps\python.exe` Store stub.
  - Then `.venv\Scripts\python.exe -m pip install --disable-pip-version-check --no-input -r requirements.txt [-r requirements-dev.txt]`.
  - Then, only when the build backend is `setuptools.build_meta` (or `setup.py` exists with no backend) and `.venv python -c "import setuptools"` exits 0: `-m pip install --no-build-isolation -e .`.
- `fresh: true` (drift or repair) deletes `.venv` for pip and poetry, and `node_modules` for yarn classic, through the lstat/real-directory gate before installing. npm ci, pnpm, yarn berry and uv already prune.
- Overrides (`executor.provision[manager]`, types.ts:282) replace that manager's argv list. `argv[0]` may be `node`, `npm` or `python` (pinned), an absolute `.exe`/`.com`, or a bare name found as an `.exe` on PATH. `.cmd` is refused with a hint to use `node <entry.js>`.

### 5.3 Environment, bounds, locks

- Environment: `runEnvironment(host.env, platform, shell, {guards})` (drops credentials, `npm_*` and `NODE_OPTIONS`), plus `CI=1`, `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`, `PIP_NO_INPUT=1`, `UV_PYTHON_DOWNLOADS=never`.
- `UV_CACHE_DIR=<slotsDir drive>:\.omr-cache\uv` when `uv cache dir` (run once) is on another drive.
- Output is bounded: head 16 KiB and tail 16 KiB through the Spawner. A failure is `E_PROVISION` "`<label>` failed in `<slot>` (exit N): `<last lines>` — `<hint>`", with the tail passed through `stripUrlUserinfo`.
- Locks: `%LOCALAPPDATA%\omr-executor\locks\<manager>.lock` (POSIX: `$HOME/.cache/omr-executor/locks`).
  - Acquire by exclusive create of `{pid, hostname, startedAt, heartbeatAt}`; heartbeat every 10 s.
  - The lock is stale when the pid is dead on this host or the heartbeat is older than 60 s. Take over only after two stale reads 1 s apart, by renaming to `<lock>.<nonce>.stale` and re-reading.
  - Waiting polls from 500 ms up to 5 s, within the step timeout, plus an in-process chain per manager. Only one lock is held at a time, so no deadlock.

## 6. `src/executor/slots/env.ts` and its two users

```ts
export interface SlotEnv {
  root: string;
  set: Readonly<Record<string, string>>;  // VIRTUAL_ENV only when a Python manager is present
  prependPath: readonly string[];         // <root>\.venv\Scripts | .venv/bin (Python), <root>\node_modules\.bin (Node)
  unset: readonly string[];               // PYTHONPATH, PYTHONHOME, NODE_PATH, UV_PROJECT_ENVIRONMENT
}
export function registerSlot(r: { root: string; managers: readonly string[] }): void; // pool: states ready|leased|resetting|provisioning
export function unregisterSlot(root: string): void;                                   // pool: broken|retired
/** Registry on globalThis[Symbol.for("omr.executor.slots")] (as reference.ts:1019-1031); keys are
 *  fold(realpathSync.native(root)). cwd -> resolve -> native realpath (fallback: resolve) -> fold on win32; match when
 *  equal to or inside a root. No other disk I/O. */
export function slotEnvFor(cwd: string, platform?: NodeJS.Platform): SlotEnv | null;
/** null -> returns `env` itself (same object). Otherwise mutates a COPY: deletes unset names case-insensitively on win32,
 *  sets `set`, and prepends to the existing PATH key (found with envLookup; other-case duplicates deleted) with ";" or ":". */
export function applySlotEnv(env: NodeJS.ProcessEnv, s: SlotEnv | null, platform: NodeJS.Platform): NodeJS.ProcessEnv;
```

- run-tools.ts:
  - `RunHost` gains `slotEnv?: (cwd: string, p: NodeJS.Platform) => SlotEnv | null`, defaulting to `slotEnvFor`.
  - Only line ≈789 changes, to `env: applySlotEnv(runEnvironment(host.env, host.platform, shell, { guards: guarded() }), (host.slotEnv ?? slotEnvFor)(root, host.platform), host.platform)`.
  - `runEnvironment` (≈357) and the spawn (≈856, which uses `plan.env`) stay untouched.
  - Deliberate, documented exception: the two slot directories are added after the PATH guard filter (run-tools.ts:364-372). The tool's own executable resolution still uses `host.env` and G4, so only child lookups change, and npm already prepends `node_modules\.bin` itself.
- verify/exec.ts:
  - At :199, `env: mergeEnv(opts.env, opts.cwd)`.
  - `mergeEnv(overrides, cwd?)`: `const s = cwd === undefined ? null : slotEnvFor(cwd); if (!s && !overrides) return process.env;` (same object identity as today). The base is `s ? applySlotEnv({ ...process.env }, s, platform) : { ...process.env }`, then the existing override loop (:399-405) runs unchanged, so explicit overrides win.
- Outside a slot both paths are byte-identical to today. That satisfies the 2.4.5 criterion.

## 7. Windows specifics

- Junctions:
  - `FsStat.kind` is `"junction"` or `"symlink"`. Links are removed only non-recursively; walks never descend into them.
  - Removal order follows §4.5. `fs.rm` not following junctions is proven only on Node v24.21.0 and Bun 1.3.14 (reference.ts:703-725), so the sweep stays mandatory.
  - The 2.2 `FileSystem.rm` must call `fs.rm` with `maxRetries: 0` for recursive removal (types.ts:1862: the retry belongs to the caller).
- Long paths: `core.longpaths=true`; Node fs handles long paths itself; Python needs `LongPathsEnabled` (M8). Warn at `open()` when `slotsDir.length + M8max > 255`.
- EBUSY, EPERM, EACCES, ENOTEMPTY: one flat retry loop using `TRANSIENT_FS_CODES`, `CLEANUP_RETRIES` and `CLEANUP_RETRY_BASE_MS` (reference.ts:910-912), deadline-aware. They are never treated as success; the leftover stays `retired` for the next GC.
- Antivirus: Defender scans fresh `node_modules` and causes EBUSY on rm and reset (M7). Docs recommend a Defender exclusion for `slotsDir`; the executor never sets one.
- Handles held open in `node_modules` (esbuild, vitest workers, tsserver): reset and clean postconditions, one retry, then `E_SLOT_BROKEN`. The pool never kills processes it did not start.
- Paths:
  - case-insensitive compare via a `comparable()` fold;
  - 8.3 names canonicalised with the native realpath (reference.ts:756-758);
  - the PATH key is often `Path`;
  - venv executables live in `Scripts`;
  - cmd.exe cannot run in a UNC work root.

## 8. Measurements

Record these in phase-2.4.md `## Measurements` with `git --version`, `node -v`, `pnpm -v`, `py -3 -V` and `uv -V`.

| ID | What | How (pwsh) | Sets |
|---|---|---|---|
| M1 | pnpm install, warm store, fresh worktree | `git worktree add --detach D:\tmp\m1 HEAD` of the node-pnpm fixture and of a real pnpm project; `Measure-Command { pnpm install --frozen-lockfile --prefer-offline }` ×3; report the median of runs 2-3 | `PROVISION_STEP_TIMEOUT_MS` |
| M2 | venv + pip | `Measure-Command { py -3 -m venv .venv }`, then `Measure-Command { .venv\Scripts\python -m pip install -r requirements.txt }`, cold and warm cache | same |
| M3 | pnpm store drive | `pnpm store path` run from a directory on D: | `UV_CACHE_DIR` rule, docs |
| M4 | does git follow junctions | temp repo on D:; `New-Item -ItemType Junction repo\junk -Target <tmp>\outside` holding `keep.txt`; run `git clean -ffdx` (with and without `-e`) and `git checkout --force` over the path; check `keep.txt` survives | confirms the §4.5 sweep |
| M5 | `worktree add --lock --reason` | run it once | `MIN_GIT_VERSION` |
| M6 | reset cost | provisioned slot: `Measure-Command { git checkout --detach --force <c>; git clean -ffd }`; also time `worktree add` of this repo | `GIT_*_TIMEOUT_MS` |
| M7 | slot removal + EBUSY | `node -e "rmSync(p,{recursive:true,force:true,maxRetries:0})"` timed right after install; count EBUSY; `Get-MpComputerStatus` | `SLOT_RM_BUDGET_MS` |
| M8 | longest relative path | `(gci -Recurse -Force node_modules,.venv \| % FullName \| measure Length -Max).Maximum` minus the slot prefix; `Get-ItemProperty HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem LongPathsEnabled` | long-path warning |
| M9 | uv cache | `uv cache dir` | `UV_CACHE_DIR` |
| M10 | entries in a provisioned slot | `(gci -Recurse -Force \| measure).Count` and the sweep time | `SLOT_SWEEP_MAX_ENTRIES` (≥ 4×) |

## 9. Tests and smoke (2.4.6)

### 9.1 Existing tests that must pass unchanged

- run-tools: `test/unit/run-tools.test.ts`, `test/unit/run-tools.network-cwd.test.ts`, `test/unit/docs-drift.test.ts`:27,35.
- exec: `test/unit/exec.test.ts`, `test/unit/exec-branches.test.ts`, `test/unit/cwd-scoping.test.ts`, `test/smoke/bun-runtime.smoke.ts`.
- exec mocks: `test/integration/deferred-verification.test.ts`:82, `batch-wiring.test.ts`:66, `test/unit/baseline-wiring.test.ts`:49, `test/integration/router-verify-tool.test.ts`:109.

### 9.2 New test files

- `executor-git.test.ts` (fake GitRunner records argv):
  - argv prefix order, and `hooksPath` after NUL;
  - identity `-c` only on the four ops;
  - `E_IDENTITY`;
  - message per kind and for revert, truncation, controls, `#` titles, pattern;
  - `encodeRefId` table plus an injectivity property (10k ids including case variants map to distinct refs), and that `check-ref-format` is invoked;
  - `deleteRefs` allow and refuse matrix and compare-and-swap;
  - `branchForce` refusals;
  - `worktreeRemove` refused while the directory exists.
- `executor-slots.test.ts` (fake fs, git, clock, provisioner):
  - every lifecycle edge;
  - 8 acquires on 4 slots gives 4 and 4; same owner gives the same slot; `release` idempotent;
  - repair of creating, provisioning, resetting and broken;
  - GC: finished plan removed; unknown plan before and after 7 d; unmarked reported; forged markers refused (path outside `slotsDir`, wrong basename, `slotsDir` a drive root, slot directory a junction); a junction inside a slot unlinked and not walked; EBUSY retries, then kept as `retired`;
  - `slotEnvFor`: inside, outside, nested, case differences, `Path` key, every unset name, overrides winning in `mergeEnv`.
- `executor-provision.test.ts`:
  - every lockfile combination, `packageManager`, ambiguity, no lockfile;
  - overrides and their argv;
  - missing binary gives `E_PROVISION` naming the remedy;
  - drift for `requirements.txt`, `pyproject.toml`, `uv.lock`, `poetry.lock`, `pnpm-lock.yaml`;
  - two concurrent same-manager provisions run in sequence (deferred fake Spawner: start₂ ≥ end₁);
  - the `UV_CACHE_DIR` rule, credential stripping, Store-stub refusal.
- `test/integration/executor-slots-git.test.ts` (real git in a temp repo, offline):
  - create, lease, reset (tracked edits gone; `node_modules` and `.venv` kept), drift and re-provision, retire;
  - `cleanForChecks` removes `dist\` and keeps the dependency directories;
  - GC with marked, unmarked and junction-out cases (the target survives);
  - hooks: repo `.git/hooks/{pre-commit,post-checkout}` write a sentinel, and it stays absent;
  - identity from repo config, and `E_IDENTITY` when the user runner has an isolated HOME;
  - uv cases use `skipIf(!uv)` with a recorded reason.
- Fixtures in `test/fixtures/cpx/repos/`:
  - `node-npm` and `node-pnpm` with zero dependencies (minimal lockfiles);
  - `py-pip`: `requirements.txt` containing only a comment, package `mypkg`, `tests/test_where.py` asserting that `mypkg.__file__` is under the cwd;
  - `py-uv`: dependency-less `pyproject.toml` plus `uv.lock`.

### 9.3 Smoke (`npm run smoke:cpx:provision`)

- Provision pnpm and pip slots for real.
- Run `pytest` through `verify/exec` `runArgv` in a slot, with `PYTHONPATH` pointing at the main fixture: it must report the slot's module path.
- Second task: assert `onProvision` was not called, and record both acquire times (informational, not a pass/fail threshold).
- The smoke file skips unless `OMR_CPX_SMOKE=1`, so `npm test` never runs it.

## 10. Handoffs and open items

1. **The `smoke:cpx:provision` script in `package.json` is not in any 2.4 Writes list.** The orchestrator should extend 2.4.6's Writes, following how `smoke:v1` is wired.
2. D18: confirm the computed `slotsDir` is plan-unique, uses a drive letter and sits outside the toplevel (§3).
3. 5.1 (role-agents.ts): grant role children their own slot and deny executor home.
4. 3.1: call `LeaseService` after `acquire`; `rebuild` uses `pool.get(slot).path`; at recovery, release slots whose task no longer holds them, using `list(planId)`.
5. 3.2: keep every slot detached; move branches only through `branchForce` with compare-and-swap; tag names come from `phaseTagName`.
6. Known limitations to record:
   - git-lfs and submodules are not set up in slots, because the global and system config are ignored;
   - provisioning runs repository-controlled code (lifecycle scripts, `yarnPath`, build backends) as a manual install would, with credentials stripped.
7. CHANGELOG: nothing is user-visible until the executor ships. The orchestrator decides whether to add an entry under `[Unreleased]`.

## Findings

## Fixes

## Deferred findings

## Handoffs

## Verdict
