// src/verify/reference.ts
//
// ============================================================================
// DISPATCH REFERENCE AND EPHEMERAL REFERENCE WORKTREE (S2 infrastructure)
// Design note: task 1.5.1 of docs/plans/verification-resource-budget-plan.md.
// Implementation: task 1.5.2 (the bodies below are contract stubs until then).
// Evidence: docs/qa/verification-resource-budget/phase-1.5.md (Spikes D, E,
// gather) and the 1.5.1 measurements quoted inline ("measured in 1.5.1":
// git 2.51.0.windows.1, win32, Node v24.21.0).
// ============================================================================
//
// PURPOSE
//   At dispatch, record a cheap, git-only description of the tree the producer
//   started from. No tests run at this point. Later, and only when scoped tests
//   fail, materialize that tree in a throw-away worktree under os.tmpdir() so
//   that the failing test files can be re-run there (S2).
//   The overriding property: nothing here may delete, overwrite or change real
//   data. That covers the user's working tree, the index content, the stash
//   list, refs, other worktrees, and the real node_modules directories we link
//   to.
//   This module never imports node:child_process. Every git run goes through
//   the injected ArgvSeam (task 1.2.2 contract), which provides the timeout,
//   the abort signal and the process-tree kill. Until runArgv (1.2) is merged,
//   the 1.5.3 tests inject a local spawn-based helper defined inside the test
//   file only (env merged over process.env, tree kill on abort or timeout,
//   resolved after the process closed). Contract relied on by cleanup: a
//   seam call resolves only after the process tree has exited.
//
// ----------------------------------------------------------------------------
// 1. WHAT THE REFERENCE CONTAINS  (DispatchReference)
// ----------------------------------------------------------------------------
//   root        path.resolve(`git rev-parse --show-toplevel`) run from the
//               dispatch cwd.
//   head        `git rev-parse --verify HEAD^{commit}` at capture.
//   commit      Output of `git stash create` when it is non-empty. That is a
//               commit whose tree holds the working-tree state of every TRACKED
//               file, staged and unstaged; untracked files are excluded
//               (Spike E). When the output is empty (tracked tree clean, per
//               Spike E), commit = head.
//   untracked   Map<relPath, sha256 hex> over every untracked, NOT ignored file,
//               from `git ls-files --others --exclude-standard --full-name -z`
//               run at root. relPath uses git's form: forward slashes,
//               root-relative. The value is the sha256 of the file bytes. An
//               untracked symbolic link gets the value UNTRACKED_SYMLINK and is
//               never reproduced. This module computes the per-file hashes
//               itself: snapshotTree (tree.ts) keeps only one aggregate hash
//               over all untracked files (spike gather notes).
//   tracked     Map<relPath, sha256 hex> of the LIVE bytes of every tracked
//               path that differs between head and commit and is a regular
//               file at capture (section 2e). Empty when commit = head.
//   captureReasons  InexactReasons found at capture (section 2f).
//   capturedAt  now() when the capture resolved.
//   Ignored content (node_modules, dist, .env, ...) is NOT part of the
//   reference. At materialize, node_modules directories are linked from the
//   live tree (section 5). Any other ignored entry is simply absent from the
//   reference worktree and is listed in `unreproduced`.
//
// ----------------------------------------------------------------------------
// 2. EXACT VS APPROXIMATE  (§1.5-7, extended by D3)
// ----------------------------------------------------------------------------
//   A materialized reference is EXACT only when all of the following hold:
//   (a) Every dispatch-time untracked file still exists in the live tree as a
//       regular file with the recorded sha256, and was written into the
//       worktree. A modified, deleted or unreadable file makes the reference
//       approximate (§1.5-7).
//   (b) No untracked symbolic link was recorded (links are never reproduced).
//   (c) No dependency drift: no DEPENDENCY_FILES entry, in any directory,
//       differs between `commit` and the live tree. node_modules is linked
//       from the LIVE tree, so it matches the reference only if the manifests
//       and lockfiles do.
//   (d) No workspace-link drift. A linked node_modules may hold a package link
//       that resolves into the live repository outside any node_modules
//       segment (npm/pnpm/yarn workspaces, e.g. node_modules/@s/a ->
//       packages/a). If that target directory contains a path that differs
//       between `commit` and the live tree, an import through the link would
//       load CURRENT code at the reference, so exact is false. Detection: for
//       each linked node_modules, readdir its top level plus one level under
//       each `@scope` directory, lstat each entry, and realpath every link.
//   (e) The checkout reproduces the live bytes (QA-1.5-6a). The stash commit
//       stores normalized blobs, and checkout converts them again, so the
//       reference can differ from the live tree byte for byte: with
//       core.autocrlf=true live "x\n" became "x\r\n"; with input, a dirty
//       CRLF file became LF; `text`/`eol`/`filter` attributes do the same.
//       Three checks: core.autocrlf set to anything but false (true, input,
//       yes, on, 1) at materialize adds "checkout-conversion" with path ""
//       (it also affects files git reports as clean); every entry of
//       `tracked` must hash equal to the checked-out file, otherwise
//       "checkout-conversion" with that path; and, for files git reports as
//       CLEAN (QA-1.5-13), the working-tree eol class (`w/` column of
//       `git ls-files --eol -z`: lf, crlf, mixed, none, -text) must be the
//       same in root and dir for every tracked path that is neither in
//       `tracked` nor changed since the commit (section 4 step 7b; the full
//       listing, QA-1.5-18: a clean file's live bytes come from its LAST
//       checkout, e.g. under an older core.autocrlf, a legacy `crlf`
//       attribute or a working-tree-encoding added later, so no attribute
//       pathspec can limit it). A path changed since the commit but not in
//       `tracked` (edited after capture, QA-1.5-16) is flagged when the
//       reference's own `w/` class differs from its `i/` class. QA's
//       repro: `* text=auto`, core.autocrlf=false, core.eol unset (native
//       CRLF on win32), live "a0\n" and `git status` clean; the reference got
//       "a0\r\n" while exact stayed true. LF files under text=auto are common
//       on win32 (e.g. Prettier's default endOfLine: lf). Each differing path
//       adds "checkout-conversion" for it, up to MAX_CONVERSION_REASONS, then
//       one "" reason. A file another writer edits between the drift diff
//       and the live listing is in neither set, so when the listing finds a
//       live-vs-reference `w/` difference the diff is taken again, limited
//       to those paths, and the paths it reports join the changed set
//       before flagging (#88). They get checks (c) and (d) and are then
//       judged like any file edited after dispatch (the QA-1.5-16 rule
//       above: flagged only when the reference's `w/` differs from its
//       `i/`; under `* text=auto` with native CRLF still flagged,
//       QA-1.5-19). A failed or unaffordable re-diff (budget spent, more
//       than MAX_REDIFF_PATHS paths) keeps every flag.
//   (f) No index entry is assume-unchanged or skip-worktree at capture
//       (QA-1.5-6b). Git skips such entries, so neither stash create nor the
//       drift diff sees a local edit to them (live "v2-local" became "v1" at
//       the reference, exact: true). `git ls-files -v` tags them with a
//       lowercase letter or `S`; the first such path (sorted) adds one
//       "index-flags" reason, recorded in captureReasons.
//   Each violation adds one InexactReason; exact === (inexactReasons.length ===
//   0). An approximate reference never excuses a failure: the recheck (2.x)
//   turns a reference-side failure of an approximate reference into
//   `unverifiable` (§1.5-7).
//   "Differs between commit and the live tree" means the union of:
//     - `git diff --name-only -z --no-renames --no-ext-diff <commit> --`
//       (tracked paths; --no-renames lists both sides of a rename);
//     - untracked paths now present (`git ls-files --others --exclude-standard
//       -z`) that are missing from `untracked` or whose hash differs.
//   Exactness makes no claim about ignored content. `unreproduced` lists the
//   ignored entries that exist in the live tree but are absent from the
//   worktree (e.g. `.env`, `dist/`), so that the recheck can classify setup
//   failures (§1.5-8). An untracked file created after dispatch is not part of
//   the reference: it is never copied and does not affect exactness.
//
// ----------------------------------------------------------------------------
// 3. CAPTURE  captureReference(cwd, signal, deps) -> DispatchReference | undefined
// ----------------------------------------------------------------------------
//   Budget: deps.timeoutMs (default DEFAULT_CAPTURE_TIMEOUT_MS, which equals the
//   baselineTimeoutMs default of 15000). Each git call gets
//   timeoutMs = min(remaining budget) and the caller's signal, except
//   `stash create` (step 4), which gets the timeout only. File reads use
//   AbortSignal.any([signal, AbortSignal.timeout(remaining)]).
//   Every git call in this module runs as `git --no-optional-locks ...`
//   (QA-1.5-2), so a read-only call never refreshes, and so never rewrites,
//   the user's index.
//   1. `git rev-parse --show-toplevel` (cwd: the dispatch cwd) -> root. A
//      non-zero exit (outside a repository, or a bare repository) returns
//      undefined.
//   2. `git ls-files --stage` (cwd: root). Any line starting "160000 " (a
//      gitlink, i.e. a submodule) returns undefined. This is the same refusal
//      snapshotTree makes (tree.ts). Then `git ls-files -v -z`: the first
//      assume-unchanged or skip-worktree path adds "index-flags" to
//      captureReasons (section 2f).
//      Scale limit (QA-1.5-24): a listing cut at the seam's output cap is a
//      failed call (QA-1.5-21), so capture returns undefined. `ls-files
//      --stage` costs 51 + path chars per entry (75 under SHA-256), more than
//      `--eol`, so at the default 10 M-char cap it fails first: a repository
//      with more than ~95-150k tracked paths gets NO reference (fail closed:
//      the recheck is unverifiable), not the "" fallback of step 7b.
//   3. `git rev-parse --verify HEAD^{commit}` -> head. Failure (e.g. an unborn
//      branch) returns undefined.
//   4. `git stash create` on a PRIVATE INDEX (QA-1.5-1/2) -> trimmed stdout.
//      Empty means commit = head. A 40- or 64-character hex SHA becomes
//      commit. Anything else, or a non-zero exit (e.g. an unmerged index),
//      returns undefined.
//      - `git rev-parse --git-path index` names the index file (the
//        per-worktree one in a linked worktree). Its bytes are read with
//        fs.readFile and written (mode 0o600, flag "wx") to <scratch>/index,
//        and the copy gets the original's mtime (floored to ms). Git's
//        racy-git check compares entry mtimes with the index FILE's mtime; a
//        fresh copy's later mtime made git trust stale stat data and miss a
//        same-size edit made in the index's second (found while fixing
//        QA-1.5-1: the stash commit and the drift diff lost such edits).
//        scratch is a fresh omr-ref-<pid>-<16 hex> dir, made with
//        mkdir(0o700) directly under realpath(deps.tmpdir ?? os.tmpdir())
//        after assertSafeRefDir (R3), and kept in the in-use set meanwhile.
//      - `git -c core.splitIndex=false stash create` then runs with env
//        GIT_INDEX_FILE=<scratch>/index. Git takes its mandatory index lock,
//        and writes its temporary `<index>.stash.<pid>`, next to the COPY.
//        core.splitIndex=false makes git write the copy as one file, never a
//        new sharedindex.* inside .git.
//      - This one call gets the remaining budget as its timeout but NOT the
//        caller's signal: an abort must not kill git while it holds a lock.
//        If the caller aborted meanwhile, the result is discarded. A timeout
//        kill can still strand a lock, but only on the copy.
//      - The scratch dir is removed in a finally block by the section 6
//        pipeline without its git steps. If that fails, the dir is left for
//        GC, which treats it as an orphan without a .git file (section 11).
//      Measured by QA on this host: the same tree as a plain `stash create`,
//      and 0/120 producer `git add` failures against a capture loop, versus
//      27/120 when stash create shared the user's index.
//      Then, when commit != head: `git diff-tree -r -z --name-only
//      --no-renames <head> <commit>` lists the dirty tracked paths. Each is
//      checked against the RELPATH rules (a violation returns undefined),
//      lstat'ed, and, if it is a regular file, read and hashed into
//      `tracked` (section 2e). A deleted path or a non-file is skipped. The
//      MAX_UNTRACKED_FILES / MAX_UNTRACKED_BYTES caps apply to this set on
//      its own, as to the untracked set; exceeding them returns undefined.
//   5. `git ls-files --others --exclude-standard --full-name -z` (cwd: root).
//      For each path, in sorted order: apply the RELPATH rules (section 10),
//      then lstat. A regular file is read (with the signal) and hashed with
//      sha256; a symlink gets UNTRACKED_SYMLINK; anything else returns
//      undefined (as snapshotTree does). Exceeding MAX_UNTRACKED_FILES files or
//      MAX_UNTRACKED_BYTES bytes returns undefined. This guards against temp-
//      dir exhaustion; the usual cause is a missing node_modules ignore rule.
//   6. If the signal is aborted or the budget is spent at any point, return
//      undefined. Every error returns undefined. The function never throws.
//   Effects on the repository. Acceptance requires working tree, index,
//   stash list and refs to be unchanged; tests assert this with git status,
//   git stash list and git for-each-ref before and after:
//   - No ref is created (no pinning; see section 8 and D1).
//   - `git stash create` writes unreferenced loose objects: the stash commit,
//     its index commit, trees and blobs. `git gc` may later prune them.
//   - The user's index file is never written and its lock is never taken.
//     `git stash create` refreshes the stat cache of the index it works on
//     (measured in 1.5.1 on the shared index: "index bytes changed=True"),
//     and that refresh needs the MANDATORY index lock. On the shared index, a
//     tree kill during that window left .git/index.lock behind in 9 of 10 QA
//     runs, and every later git write in the user's repository failed until
//     the lock was removed by hand (QA-1.5-1). With the private copy, the
//     refresh, the lock and the temporary stash index all live in scratch.
//   - An abort or timeout mid-capture leaves nothing in the repository but
//     such unreferenced objects (at most, a git object write interrupted by a
//     timeout kill leaves a tmp_obj_* file, which git gc removes).
//   Consistency: the capture is not atomic. Tracked state is taken at step 4
//   and untracked state at step 5. Under §1.5-14 the caller (2.x) discards a
//   capture that resolves after an edit was observed in an overlapping
//   directory.
//
// ----------------------------------------------------------------------------
// 4. MATERIALIZE  materialize(ref, currentTree, signal, deps) -> MaterializeResult
// ----------------------------------------------------------------------------
//   Never throws. If anything fails after step 3 creates the worktree, the
//   dispose pipeline (section 6) runs before { ok: false } is returned, so an
//   abort leaves no partial state. Budget: deps.timeoutMs (default
//   DEFAULT_MATERIALIZE_TIMEOUT_MS) and the caller's signal.
//   0. currentTree is optional. If given, currentTree.cwd must lie inside
//      ref.root; otherwise return ok:false "error" (wrong repository). It is
//      never used to decide exactness, because TreeSnapshot has no per-file
//      hashes (gather notes). Every file is re-read instead.
//   1. `git cat-file -e <commit>^{commit}` (cwd: root). If the commit is
//      missing, return ok:false "commit-missing": the unreferenced stash commit
//      was pruned (section 8).
//   2. tmp = realpath(deps.tmpdir ?? os.tmpdir()), long form. Measured in
//      1.5.1: git stores and lists worktree paths in long form with forward
//      slashes ("C:/Users/Marquinho/AppData/..."), even when TEMP is an 8.3
//      short path. dir = tmp/<refDirName(pid, 16 random hex)>. Call
//      assertSafeRefDir(dir) before anything is created. Add dir to the
//      process-wide ACTIVE set, which gcStaleReferences skips (section 11),
//      and start the heartbeat once the dir exists. Then
//      mkdir(dir, { mode: 0o700 }), non-recursive (QA-1.5-10): EEXIST returns
//      ok:false "unsafe-path" and nothing is cleaned up. On POSIX,
//      chmod(dir, 0o700) follows, so the mode is exact whatever the umask.
//      The dir is private BEFORE git writes the first tracked byte into it.
//   3. `git -c core.hooksPath=<tmp>/omr-nohooks-<16 random hex>
//      -c advice.detachedHead=false worktree add --detach --lock --reason
//      <referenceLockReason(pid)> <dir> <commit>` (cwd: root, env LC_ALL=C so
//      git's own messages and the fallback's "initializing" lock reason stay
//      untranslated). The lock lasts the reference's whole life (QA-1.5-12,
//      D10): its junctions lead into the LIVE node_modules, and a user's or an
//      IDE's `git worktree remove [--force]` on an unlocked entry would empty
//      them (Spike D method 5). git refuses a locked entry unless given
//      `-f -f`, and prints our reason. Per git's add_worktree, the `locked`
//      file holds our reason from the start ("initializing" is written only
//      without --lock), is kept after a successful checkout, and is removed if
//      the add fails. `add --reason` needs git >= 2.33 (release notes: "git
//      worktree add --lock learned to record why the worktree is locked").
//      Older git fails in its option parser ("unknown option `reason'")
//      before writing anything: the dir is checked to be still empty, a
//      warning is logged, and the add is repeated without --lock (the pre-fix
//      behaviour: an unlocked entry). Git accepts the existing empty dir. The hooks path is
//      checked to be absent and is never created, and it lies OUTSIDE the
//      worktree, so post-checkout hooks (repository code) never run
//      (QA-1.5-8: the former `<dir>/.omr-no-hooks` was inside the worktree,
//      and a committed `.omr-no-hooks/post-checkout` ran during
//      materialize). Clean/smudge filters such as LFS still run, within the
//      budget. Failure returns ok:false "worktree-add-failed". Once the
//      worktree exists, its HEAD pins the commit against gc (Spike E).
//   3b. Byte-exactness (section 2e/2f): start from ref.captureReasons; run
//      `git config --get core.autocrlf` (cwd: root); then, for each
//      [rel, hash] of ref.tracked in sorted order, lstat and hash dir/rel.
//      A missing file, a non-file, a hash mismatch or an unsafe rel adds
//      "checkout-conversion" for rel.
//   4. Copy untracked files, for each [rel, hash] in ref.untracked, in sorted
//      order:
//      - rel fails the RELPATH rules -> inexact "untracked-unsafe-path".
//        hash === UNTRACKED_SYMLINK -> inexact "untracked-symlink".
//      - lstat(root/rel): ENOENT -> "untracked-deleted"; not a regular file ->
//        "untracked-not-file"; read error -> "untracked-unreadable".
//      - bytes = readFile(root/rel). sha256(bytes) !== hash ->
//        "untracked-modified".
//      - dest = dir/rel. mkdir -p the parent, then check that realpath(parent)
//        is strictly inside dir (isStrictlyInside). Write with
//        writeFile(dest, bytes, { mode: stat.mode & 0o777, flag: "wx" }).
//        The same buffer that was hashed is the one written, so the check and
//        the copy cannot disagree. "wx" never overwrites and never writes
//        through an existing link.
//   5. Discovery: `git ls-files --others --ignored --exclude-standard
//      --directory -z` (cwd: root). Measured in 1.5.1 with node_modules/,
//      .env and legacy/ ignored, the output was [.env] [legacy/]
//      [node_modules/] [packages/a/node_modules/]. The ignored parent legacy/
//      is collapsed, so its nested node_modules is not listed, and that parent
//      is absent from the worktree anyway. Entries whose last segment is
//      `node_modules` are link candidates (section 5). All other entries go to
//      `unreproduced`. Nothing ignored is ever copied.
//   6. Link each candidate (section 5), parents before children. Git's sorted
//      output already puts them in that order.
//   7. Drift checks (c) and (d) of section 2 (two git calls, cwd: root). The
//      drift `git diff` runs on a private index copy, exactly like stash
//      create (section 3 step 4, with the caller's signal here). Porcelain
//      `git diff <commit>` rewrote .git/index after a stat-only change
//      (QA-1.5-2), and re-measured while fixing it, it STILL did so under
//      --no-optional-locks: its closing refresh_index_quietly() takes the
//      index lock whenever it is free, whatever GIT_OPTIONAL_LOCKS says.
//   7b. Clean-file conversion (section 2e, QA-1.5-13), skipped when a ""
//      "checkout-conversion" reason (core.autocrlf) is already recorded:
//      `git ls-files --eol -z` at root and at dir, run concurrently
//      (the cost of QA-1.5-17; QA-1.5-18: no pathspec limit is sound).
//      A path in both lists, not in ref.tracked and
//      not in the drift set of step 7, whose `w/` class differs adds
//      "checkout-conversion" for it. A path in the drift set but not in
//      ref.tracked (edited after capture, QA-1.5-16) has unknown dispatch
//      bytes, so it adds "checkout-conversion" when the reference's own `w/`
//      class differs from its `i/` class (the checkout converted it). When
//      the lists show a path with a live-vs-reference `w/` difference that is
//      in neither set (#88: edited by another writer after the step-7 diff),
//      the step-7 diff (private index, `--literal-pathspecs`, limited to
//      those paths, at most MAX_REDIFF_PATHS) is taken again. The paths it
//      reports join the drift set, get the (c)/(d) checks of step 7, and are
//      then judged by the QA-1.5-16 rule above (a re-diffed path whose
//      checkout converted it, w/ != i/, stays flagged, QA-1.5-19). A failed
//      re-diff (logged), a spent budget or too many paths keeps every flag.
//      This is the last step, so the two listings get the remaining budget
//      with the caller's signal only: a budget that runs out here, or a
//      failing call, adds "" instead of failing materialize; a caller abort
//      returns ok:false "aborted". The re-diff is the exception: like step 7
//      it runs under the budget's signal (its private-index copy), so a
//      spent budget there skips it and keeps the flags, while a caller abort
//      returns "aborted" and an UnsafeReferencePathError "unsafe-path".
//   8. Return { ok: true, reference: { dir, exact, inexactReasons,
//      unreproduced, links, toRefPath, dispose } }. toRefPath(p) maps an
//      absolute live path under root, or under realpath(root), to the same
//      relative path under dir, or returns undefined when p is outside both.
//      The recheck uses it for the runner cwd and the failing test files, which
//      the planner canonicalises with the native realpath (E2E-2: a root
//      reached through an 8.3 name, a junction or a subst drive is spelled
//      differently by git and by realpath).
//   Repository effects of materialize, dispose and GC: they write only the
//   admin entry .git/worktrees/<name> and the dir itself. The main index
//   content, the refs and the stash list are never touched.
//
// ----------------------------------------------------------------------------
// 5. LINK STRATEGY  (every ignored node_modules: the root and each workspace package)
// ----------------------------------------------------------------------------
//   For each candidate relPath R from discovery (step 5):
//   - src = root/R. lstat(src) must be a directory or a link. target =
//     realpath(src), and lstat(target) must be a real directory. Otherwise
//     skip R.
//   - linkPath = dir/R. Its parent must already exist in the worktree as a real
//     directory (lstat, not a link). Links never get a mkdir: a package that
//     does not exist at the reference gets no node_modules. linkPath itself
//     must not exist (lstat returns ENOENT), so a tracked node_modules is left
//     alone.
//   - Push linkPath onto `links` BEFORE creating the link. dispose lstat-checks
//     every entry, so a recorded link that was never created is harmless.
//   - win32: fs.symlink(target, linkPath, "junction"). Junctions need an
//     absolute target and no privilege, and can cross local volumes (e.g. a
//     D:\ repo and a C:\ temp dir). POSIX: fs.symlink(target, linkPath,
//     "dir"). Spike D: lstat().isSymbolicLink() is true for junctions made
//     either way, which is the basis of every removal check.
//   - Links point at LIVE, shared state. Tests at the reference that write into
//     node_modules (vite/jest caches, .cache) write into the real directory.
//     That is cache data, not source; the runner adapter may redirect caches.
//   Only node_modules is linked. Python virtualenvs are NOT linked: an editable
//   install points at the live tree's sources and would make the reference
//   silently run current code (see OPEN RISKS).
//
// ----------------------------------------------------------------------------
// 6. DISPOSE  handle.dispose() -> Promise<void>
// ----------------------------------------------------------------------------
//   Idempotent: the promise is memoised, so every call returns the first
//   call's promise. It never rejects: every failure goes to logger.warn and
//   the leftover is left for GC. Contract: call it only after the recheck's
//   process tree has exited. It does not use the caller's signal, because
//   cleanup must still run after an abort.
//   Order: unlink-first as in Spike D method 8, plus a sweep (D6), but git
//   never deletes a tree (QA-1.5-3):
//   1. Recorded links, in reverse order. Check isStrictlyInside(link, dir),
//      then lstat. ENOENT: skip. isSymbolicLink(): fs.unlink, retrying
//      transient errors. A real file or directory at that path is worktree
//      content: leave it for the later steps.
//   2. Link sweep. Walk dir with lstat, never descending into a link (the
//      worktree's `.git` is a file), and fs.unlink every link found. Before
//      each readdir, realpath(current) must be dir's realpath or inside it,
//      so a real directory swapped for a junction after its lstat is not
//      walked into (the race window shrinks to realpath..readdir). Tests can
//      create links, and `git worktree remove --force` follows junctions and
//      DELETES TARGET CONTENTS (Spike D, BANNED list). If a link survives step
//      1 or 2, or the walk exceeds MAX_SWEEP_ENTRIES, STOP: nothing more is
//      removed. Warn "reference worktree left in place: <reason>"; GC retries
//      later.
//   3. Run assertSafeRefDir(dir) and confirm lstat(dir) is a real directory.
//      Then fs.rm(dir, { recursive: true, force: true, maxRetries: 0 }) inside
//      the module's flat retry loop (see below): Spike D SAFE #5, the only
//      recursive deleter. fs.rm removes a link without following it,
//      so a junction created after the sweep costs nothing (QA-1.5-3 repro:
//      `git worktree remove` in this slot deleted the late junction's target
//      contents; fs.rm left them intact). The sweep stays, because fs.rm's
//      non-following is proven only on Node v24.21.0 and engines is >=22. If
//      dir still exists afterwards (EBUSY from a process whose cwd is inside),
//      warn and leave it for GC; git is not run.
//   4. Only once dir is gone, and while the admin entry is still registered:
//      assertSafeRefDir(dir), lstat(dir) must be ENOENT, then
//      `git worktree remove --force <dir>` (cwd: root, timeout
//      CLEANUP_GIT_TIMEOUT_MS). Measured in 1.5.1: on an already-deleted dir
//      it exited 0 and removed only that entry, with no recursion;
//      `git worktree prune -v` afterwards found nothing. `git worktree prune`
//      is never run (D5). Residual race: a dir recreated between that lstat
//      and git's own check would be deleted by git; only this module creates
//      omr-ref names, under an in-use entry.
//      A locked entry makes `remove --force` fail. Our entry is locked with
//      referenceLockReason(<pid of its name>) for its whole life (step 3,
//      QA-1.5-12). The git < 2.33 fallback adds without --lock, and git then
//      locks the entry with "initializing" until its checkout ends, so a tree
//      kill mid-checkout leaves that lock forever (QA-1.5-5). If the entry's
//      lock reason is exactly one of those two, and the caller allows it
//      (materialize's own handle and cleanup; GC per section 11 step 2),
//      `git worktree unlock <dir>` runs first: here, only after the dir is
//      gone and R3 passed, so the junctions are unprotected by the lock only
//      once they no longer exist. Any other lock reason (including an omr
//      reason naming another pid) is someone else's: warn, keep the entry.
//      Our own `worktree add` runs with LC_ALL=C, so "initializing" is never
//      translated.
//   0. (Before step 1) stop the heartbeat (section 11).
//   5. Remove dir from ACTIVE. If any step failed, add it to RELEASED, so
//      that this process's next GC collects it without waiting for the age
//      rule (section 11).
//   Transient errors (TRANSIENT_FS_CODES: EBUSY, EPERM, EACCES, ENOTEMPTY,
//   caused by Windows AV scans or open handles) are retried up to
//   CLEANUP_RETRIES times with CLEANUP_RETRY_BASE_MS * 2^n backoff, then
//   logged, and the leftover is left for GC. They are never treated as
//   success. If dir was deleted externally, every step tolerates ENOENT.
//   There is ONE flat retry loop (withRetry); fs.rm itself runs with
//   maxRetries: 0 (QA-1.5-11). Node's JS fs.promises.rm retries inside every
//   recursive child call, so its own retries nest once per directory level
//   above a held dir: T(d) ~ 6*T(d-1) + 1.5 s, measured by QA as 11 s at one
//   level and 66 s at two (about 6.5 min at three, extrapolated). The flat
//   loop costs about 3.1 s of backoff at any depth. GC passes its deadline:
//   no retry starts after GC's budget is spent, and step 4 is then skipped
//   (the dir is gone and the entry is collected by the next GC).
//
// ----------------------------------------------------------------------------
// 7. REMOVAL RULES  (normative; QA checks every destructive call against them)
// ----------------------------------------------------------------------------
//   R1 Every removal is preceded by an lstat check. A link is only ever removed
//      with fs.unlink, which is single-entry and never recursive.
//   R2 A recursive removal (fs.rm with recursive; nothing else) is allowed
//      only on a path that (i) passed assertSafeRefDir immediately before,
//      (ii) lstat shows is a real directory, not a link, and (iii) the sweep
//      proved link-free. `git worktree remove --force` is only ever run on a
//      dir that passed assertSafeRefDir and that lstat shows is gone, so it
//      only drops the admin entry (QA-1.5-3).
//   R3 assertSafeRefDir(dir, tmpRoots) accepts dir only if it is absolute,
//      has no "." or ".." segment, its basename matches REF_DIR_PATTERN
//      (omr-ref-<pid>-<16 hex>), and its parent IS one of the tmp roots:
//      resolve(tmpdir) or realpath(tmpdir), compared case-insensitively on
//      win32. It must be a direct child: never the tmp root itself, never
//      deeper, and never under a tmp root that is a filesystem root.
//   R4 Banned in this module: `git worktree remove` on a dir that exists,
//      `git worktree unlock` of anything but an R3-valid omr-ref entry whose
//      dir lstat shows is gone and whose lock reason is exactly
//      referenceLockReason(<pid of its name>) or "initializing" (section 6
//      step 4), `git worktree add` without --lock --reason except the
//      git < 2.33 fallback (section 4 step 3),
//      `git worktree prune`, `git clean`, any `git stash` other than `create`,
//      `git reset/checkout/update-ref/gc`, fs.rm on a path that fails R2, any
//      shell, and importing child_process.
//
// ----------------------------------------------------------------------------
// 8. THE UNREFERENCED STASH COMMIT  (GC risk; D1)
// ----------------------------------------------------------------------------
//   Spike E suggested pinning the commit with a ref, but that would violate the
//   capture acceptance criterion "refs unchanged", so no ref is created.
//   Protection comes from `git gc` itself: it prunes unreachable loose objects
//   only once they are older than gc.pruneExpire (default 2 weeks), far beyond
//   pendingTtlMs (1 h). Residual risk: a manual `git gc --prune=now`, or
//   gc.pruneExpire=now combined with auto-gc, between capture and recheck
//   (Spike E: --prune=now deleted it). Materialize step 1 detects this and
//   returns ok:false "commit-missing", and the recheck reports unverifiable.
//   Once the worktree exists, its HEAD pins the commit (Spike E: "cat-file:
//   commit" after gc --prune=now).
//
// ----------------------------------------------------------------------------
// 9. SECRETS POLICY  (untracked .env and similar)
// ----------------------------------------------------------------------------
//   - Ignored files are never copied or linked; only node_modules directories
//     are linked. An ignored .env is absent from the reference, is listed by
//     path in `unreproduced`, and its contents are never read.
//   - An untracked, NOT ignored file (e.g. a .env that is not ignored) is part
//     of the dispatch state. It is copied only if it existed at dispatch and is
//     byte-identical now; otherwise exact=false. Nothing that appeared after
//     dispatch is copied.
//   - dir, and capture's scratch dir, are created with mode 0o700 (plus an
//     exact chmod on POSIX) before any content is written into them, so a
//     shared /tmp never exposes the checkout (QA-1.5-10). On win32 the mode
//     is not an ACL: the dir inherits the ACL of the tmp root. The default
//     per-user %LOCALAPPDATA%\Temp is private; an injected or relocated TEMP
//     (e.g. C:\Temp) usually grants broader access, and then so does dir.
//   - Deferred to 2.1 (QA-1.5-10): materialize only inside the S3 slot, and
//     run GC before each materialize, to bound concurrent references and
//     temp-dir use; 1.5 caps only the untracked copy.
//   - Lifetime: disposed right after the recheck. Crash leftovers are removed
//     by GC once the owner is dead, or 1 h after the last heartbeat; a
//     failed dispose is collected by this process's next GC (section 11).
//   - Logs carry counts and reasons, never file contents. Paths appear only in
//     the inexactReasons and unreproduced lists returned to the caller.
//
// ----------------------------------------------------------------------------
// 10. RELPATH RULES  (applied to every git-reported path before any join)
// ----------------------------------------------------------------------------
//   Non-empty, not absolute; splitting on "/" gives no "", "." or ".." segment
//   and no ".git" segment (case-insensitive); on win32, no ":" (alternate data
//   streams) and no "\". A violation makes capture return undefined; at
//   materialize it makes the reference inexact (and the path is never used).
//
// ----------------------------------------------------------------------------
// 11. CRASH GC  gcStaleReferences(root, deps) -> GcReport
//     (called at plugin start, wired in 2.1)
// ----------------------------------------------------------------------------
//   Never throws. Budget: deps.timeoutMs (default DEFAULT_MATERIALIZE_TIMEOUT_MS),
//   checked before each candidate and before each cleanup retry (QA-1.5-11:
//   a held dir used to keep GC inside fs.rm's nested retries for 66 s against
//   a 30 s budget). A single fs call or git call already in flight is not
//   interrupted; git calls keep CLEANUP_GIT_TIMEOUT_MS.
//   1. `git worktree list --porcelain` (cwd: root). No -z flag, to support git
//      < 2.36; a path containing a newline can never pass R3. Parse the
//      `worktree <path>`, `locked` and `prunable` lines. Measured in 1.5.1: a
//      deleted worktree dir is listed with "prunable gitdir file points to
//      non-existent location".
//   2. An entry is a candidate only if its basename matches REF_DIR_PATTERN
//      and its parent is a tmp root (R3). Everything else is never touched:
//      the main worktree and every user worktree. A `locked` entry is kept
//      unless its reason is one this module writes for that dir (section 6
//      step 4); then:
//      - "initializing" (git < 2.33 fallback): collected only if its owner is
//        dead or this process released the dir (QA-1.5-5; an alive owner may
//        still be checking out);
//      - referenceLockReason(pid) (QA-1.5-12): every live reference carries
//        it, so the step 3 rules apply as to an unlocked entry; a missing dir
//        is collected whatever the owner's liveness (QA-1.5-15: a reused pid
//        kept it forever). Racing an alive owner between its fs.rm and its own
//        unlock is benign: both sides only lift our reason and remove an entry
//        whose dir is gone, and the loser logs a warning.
//      Such an entry is unlocked by the section 6 pipeline once its dir is
//      gone. A dir in the in-use set (ACTIVE) is kept. ACTIVE lives on
//      globalThis under Symbol.for("omr.reference.active"), so every copy of
//      this module in the process shares it (QA-1.5-4: the plugin loaded
//      from two install paths; before, the second copy's GC removed the
//      first copy's live reference).
//   3. A candidate is stale if any of these holds:
//      - its dir is missing (prunable);
//      - it is in RELEASED (Symbol.for("omr.reference.released")): a dir
//        this process created, stopped using, and failed to remove (e.g.
//        EBUSY from a process whose cwd is inside). Only this process can
//        know that its own dir is abandoned, so it is collected at once;
//      - its owner PID (taken from the name) is dead: deps.isAlive, default
//        process.kill(pid, 0), where EPERM counts as alive;
//      - its HEARTBEAT is older than STALE_REFERENCE_AGE_MS (1 h): age =
//        now() - lstat(dir).mtimeMs. While a materialized handle is in use,
//        a timer (unref'd, every deps.heartbeatMs, default
//        HEARTBEAT_INTERVAL_MS = 5 min) sets the dir's mtime to now, and
//        dispose stops it. So the age rule never fires for an alive owner
//        that still uses the dir; it only covers PID reuse (the heartbeat
//        stopped when the real owner died). Capture's scratch dir lives for
//        at most one capture budget and needs no heartbeat. Before QA-1.5-4,
//        age alone, or merely carrying this process's PID, made a live
//        reference stale.
//   4. Each stale candidate goes through the section 6 pipeline with no
//      recorded links. The sweep finds and unlinks every node_modules link,
//      fs.rm removes the dir, step 4 then removes the missing-dir entry, and
//      `git worktree prune` is never run.
//   5. Orphans are tmp-root entries matching REF_DIR_PATTERN that are not
//      registered in root's list. An orphan is removed (sweep, then R2 fs.rm)
//      only if it is stale AND it either has no `.git` file or its `gitdir:`
//      line resolves inside root's .git directory. Orphans of other
//      repositories are left alone. This limits temp-dir exhaustion (D7).
//      Capture's private-index scratch dirs (section 3 step 4) and a
//      reference dir that crashed before `git worktree add` registered it
//      are such orphans without a `.git` file.
//   6. The report lists removed, kept and failed dirs; failures are also
//      logged.
//
// ----------------------------------------------------------------------------
// DEVIATIONS FROM PLAN  (evidence-driven; each makes behaviour stricter or safer)
// ----------------------------------------------------------------------------
//   D1 No pinning ref for the stash commit (Spike E recommended one). The plan's
//      capture acceptance criterion forbids ref changes. See section 8.
//   D2 "Never modify the index": `git stash create` rewrites the stat cache of
//      the index it runs on (measured in 1.5.1) and needs the mandatory index
//      lock for it. That is NOT the same class as `git status`, whose refresh
//      takes an optional lock and is skipped when the lock is busy: on the
//      shared index, 27/120 producer `git add` calls failed against a capture
//      loop (QA-1.5-2). So stash create and the drift `git diff` (which
//      rewrites the index even under --no-optional-locks, section 4 step 7)
//      run on a private copy of the index (section 3 step 4), and every git
//      call carries --no-optional-locks. The user's index is never written.
//      `git stash create` itself is kept because the plan's S2 row (§1.3)
//      names it.
//   D3 exact=false has more causes than §1.5-7: untracked symlinks, dependency
//      drift, workspace-link drift, checkout conversion and index flags
//      (section 2, b to f). These only make the check stricter, and
//      approximate still never excuses.
//   D4 materialize returns { ok: true, reference } | { ok: false, reason,
//      detail } instead of the plan's { dir, exact, dispose() }, so a verdict
//      can say why the reference is unavailable. The handle adds
//      inexactReasons, unreproduced, links and toRefPath. currentTree is
//      optional and only serves as a same-repository guard.
//   D5 `git worktree prune` is never run (plan 1.5.2.c/d, Spike D step 3). The
//      git docs say that unless a worktree is locked, prune removes its admin
//      files when its directory is missing: "If a worktree is on a portable
//      device or network share which is not always mounted, lock it to
//      prevent its administrative files from being pruned". So prune would
//      touch non-omr worktrees. Replacement: `git worktree remove --force
//      <dir>` on an already-deleted dir. Measured in 1.5.1, it exited 0 and
//      removed only that entry.
//   D6 dispose adds a full link sweep before the recursive removal. Spike D
//      proved the order for the links we create; tests may create others.
//      Unlike Spike D method 8, the recursive removal is fs.rm, and
//      `git worktree remove --force` runs only after the dir is gone
//      (QA-1.5-3: git follows a junction that appears after the sweep).
//   D7 capture refuses (returns undefined) above MAX_UNTRACKED_FILES /
//      MAX_UNTRACKED_BYTES, and GC also removes this repository's stale
//      orphan omr-ref dirs. Both address temp-dir exhaustion; the plan does
//      not specify either.
//   D8 The ExecOptions/ArgvSeam seam types now come from ./types (imported
//      once vrb/p12 merged; the former local copies had the identical
//      shape). This module does not re-export them; tests can type the seam
//      as CaptureDeps["argv"].
//      Truncation contract (QA-1.5-21): p12's runArgv caps each stream at its
//      maxBuffer, keeps the child's exit code and appends the note line
//      `[stdout truncated at <n> chars]` after git's stderr. runGit honours
//      that note only in the trailing note block and only when stdout is n
//      (or n-1) chars long (QA-1.5-23), and turns such a result (or a `-z`
//      output without its closing NUL) into a failed call, so a cut listing
//      can only make a reference approximate or failed, never falsely exact.
//   D9 Hooks are disabled for `git worktree add` (core.hooksPath points at a
//      random path in the tmp root that does not exist and lies outside the
//      worktree, so the checkout cannot create it; QA-1.5-8).
//   D10 The reference worktree is added locked (`--lock --reason`, git >= 2.33;
//      QA-1.5-12). The plan does not lock it. Unlocked, a live or crashed
//      reference was a registered worktree in `git worktree list` and IDE
//      views, and a `git worktree remove --force` there would have emptied the
//      live node_modules behind its junctions. Measured by QA: both `remove`
//      and `remove --force` refuse a locked entry, and `prune --dry-run` lists
//      nothing. Only `remove -f -f` or an explicit unlock overrides it.
//
// ----------------------------------------------------------------------------
// OPEN RISKS  (not solvable in this module; owners named)
// ----------------------------------------------------------------------------
//   - Python (2.x recheck): nothing is linked. `uv run pytest` at the reference
//     may build a fresh venv, costing time and network, bounded by
//     recheckTimeoutMs. An editable install in the active environment imports
//     the LIVE tree's sources. Pytest reference runs must count as approximate
//     unless the runner resolves sources from the worktree.
//   - node_modules content generated from repository files (e.g. a Prisma
//     client) reflects the live tree; check (c) only catches manifest and
//     lockfile drift.
//   - Checkout conversion of files git reports as CLEAN is detected through
//     core.autocrlf and the eol-class comparison (section 2e, QA-1.5-13,
//     QA-1.5-18), which sees any conversion that changes the `w/` class. What
//     remains is a `filter` or `ident` smudge (or a working-tree-encoding
//     change) whose output differs from the live bytes while keeping the eol
//     class: such a clean file still
//     differs at the reference while exact stays true. Hashing every tracked
//     file at capture would close this, at a cost the capture budget cannot
//     bound. Dirty files are always compared byte for byte.
//   - False inexact (QA-1.5-19, safe direction): a file clean at capture and
//     edited before materialize is flagged whenever the reference's checkout
//     converts it (`w/` != `i/`), even if the live file already had those
//     bytes. On win32 with `* text=auto` (native CRLF) any such edit makes the
//     reference inexact. Avoiding it needs each path's `w/` class at capture,
//     i.e. a full `ls-files --eol` inside the capture budget; not done, since
//     the error only yields "unverifiable", never a wrong excuse.
//   - The QA-1.5-16 rule cannot see a legacy-checkout conversion (QA-1.5-18
//     class: old core.autocrlf, `crlf` attribute) in a file edited after
//     dispatch, because the reference's `i/` equals its `w/` there. That was
//     already true for edits before the step-7 diff; the step-7b re-diff
//     (#88) extends it to edits in the window between the diff and the live
//     listing.
//   - Output cap (QA-1.5-24, owner 2.1): the seam caps each stream (p12
//     runArgv default 10 M chars) and a cut listing is a failed call. Capture's
//     `ls-files --stage` hits the cap first, at ~95-150k tracked paths (path
//     length 60-20; SHA-1 ids, ~78-110k under SHA-256), so such a repository
//     gets no reference at all (fail closed, recheck unverifiable). An `--eol`
//     entry is always shorter than a `--stage` one, so the "" fallback of
//     materialize step 7b applies only when the index grew after capture. If
//     2.1 needs large monorepos, pass a per-call maxBuffer through the seam
//     for the listing calls.
//   - An ignored file that tests need (.env, generated code) is absent at the
//     reference. The recheck must classify the resulting failure as a setup
//     failure (§1.5-8). `unreproduced` supports that decision but cannot make
//     it.
//   - POSIX directory-symlink behaviour of `git worktree remove` is unverified
//     (Spike D ran on win32 only). It no longer matters for deletion: git only
//     ever sees a dir that is already gone. The unlink-first order and the
//     sweep apply on every platform. The 1.5.3 key safety test must run on
//     POSIX CI.
//   - On Node versions other than v24.21.0, fs.rm's non-following of junctions
//     is not proven (Spike D). R2 limits this to a link created between the
//     sweep and fs.rm (the QA-1.5-3 window), which only a process running
//     after the dispose contract was broken can create.
//   - Bun (owner: 3.1, which adds a Bun smoke). opencode runs the plugin under
//     Bun 1.3.14, not Node, and the measurements above are Node's. Verified
//     on Bun 1.3.14/win32 (global QA, attempt 3, E1/E2; QA-G-8):
//     lstat(junction).isSymbolicLink() is true (isDirectory() false), a
//     recursive fs.promises.rm of a dir holding a junction removes the
//     junction without following it (the target's content survives), and the
//     dispose path keeps the real node_modules and leaves no omr-ref dir (E2
//     and the Bun smoke, test/smoke/bun-runtime.smoke.ts). Other Bun versions
//     are unverified, and so is which code Bun's native rm reports for a held
//     dir (EBUSY, EPERM, ...). The
//     flat retry loop no longer relies on the engine honouring maxRetries or
//     retryDelay (QA-1.5-11), but a code outside TRANSIENT_FS_CODES would end
//     it at once (the dir is then left for GC). The heartbeat assumes
//     setInterval(...).unref() and AbortSignal.any/timeout behave as in Node.
// ============================================================================

import * as fsp from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir as osTmpdir } from "node:os";
import { posix as pathPosix, win32 as pathWin32 } from "node:path";
import type { ArgvSeam, ExecOptions, ExecResult } from "./types";
import type { TreeSnapshot } from "./dispatch";
import type { PluginLogger } from "../router/logger";

// --- Seams --------------------------------------------------------------------

/** The subset of fs.Stats this module reads. */
export interface ReferenceStats {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  readonly size: number;
  readonly mode: number;
  readonly mtimeMs: number;
}

/**
 * Narrow fs seam. Every method is non-following or single-entry except `rm`,
 * which R2 restricts to link-free, assertSafeRefDir-approved directories.
 * `node:fs/promises` satisfies it structurally (see nodeReferenceFs).
 */
export interface ReferenceFs {
  lstat(path: string): Promise<ReferenceStats>;
  /**
   * The NATIVE realpath (fs.promises.realpath, as nodeReferenceFs): it resolves links, junctions
   * and win32 8.3 short names. The JS fs.realpathSync keeps 8.3 names, and the tmp root, the
   * reference dir and every inside-dir check would then disagree on the spelling (E2E-2).
   */
  realpath(path: string): Promise<string>;
  readFile(path: string, options: { signal?: AbortSignal }): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array, options: { mode: number; flag: "wx" }): Promise<void>;
  /** `{ recursive: true }` for copy parents; `{ mode: 0o700 }` (non-recursive, fails on EEXIST) for our own dirs. */
  mkdir(path: string, options: { recursive?: boolean; mode?: number }): Promise<unknown>;
  chmod(path: string, mode: number): Promise<void>;
  readdir(path: string): Promise<string[]>;
  symlink(target: string, path: string, type: "junction" | "dir"): Promise<void>;
  unlink(path: string): Promise<void>;
  /** Only on files and dirs this module created (private index copy, heartbeat). */
  utimes(path: string, atime: Date, mtime: Date): Promise<void>;
  /** maxRetries is always 0: the module's flat retry loop retries (QA-1.5-11). */
  rm(
    path: string,
    options: { recursive: true; force: true; maxRetries: 0; retryDelay: number },
  ): Promise<void>;
}

/** Production fs seam; also a compile-time proof that node:fs/promises fits ReferenceFs. */
export const nodeReferenceFs: ReferenceFs = fsp;

export interface CaptureDeps {
  argv: ArgvSeam;
  fs: ReferenceFs;
  /** Whole-operation budget in ms. capture: DEFAULT_CAPTURE_TIMEOUT_MS; materialize/GC: DEFAULT_MATERIALIZE_TIMEOUT_MS. */
  timeoutMs?: number;
  /**
   * Default os.tmpdir(). Reference dirs and capture's scratch dir (private
   * index, section 3 step 4) are created directly under realpath(tmpdir).
   */
  tmpdir?: string;
}

export interface ReferenceDeps extends CaptureDeps {
  logger?: Pick<PluginLogger, "warn">;
  /** Default process.pid; encoded in the dir name for crash GC. */
  pid?: number;
  /** Default Date.now. */
  now?: () => number;
  /** Default: process.kill(pid, 0) succeeds or fails with EPERM. */
  isAlive?: (pid: number) => boolean;
  /** Default process.platform. Selects junction vs dir symlink and path comparison rules. */
  platform?: NodeJS.Platform;
  /** Default randomBytes(8).toString("hex"); must match the 16-hex suffix of REF_DIR_PATTERN. */
  randomSuffix?: () => string;
  /** Default HEARTBEAT_INTERVAL_MS: how often a materialized dir's mtime is refreshed while in use. */
  heartbeatMs?: number;
}

// --- Data types ---------------------------------------------------------------

export interface DispatchReference {
  /** path.resolve(`git rev-parse --show-toplevel`) of the dispatch cwd. */
  readonly root: string;
  /** HEAD at capture time. */
  readonly head: string;
  /** `git stash create` commit, or `head` when tracked files were clean. */
  readonly commit: string;
  /** Untracked, not ignored files at dispatch: git relPath (forward slashes) -> sha256 hex, or UNTRACKED_SYMLINK. */
  readonly untracked: ReadonlyMap<string, string>;
  /** Tracked paths that differ between head and commit and were regular files: relPath -> sha256 of the live bytes (section 2e). */
  readonly tracked: ReadonlyMap<string, string>;
  /** Found at capture; every reference built from this capture is approximate for them (section 2f). */
  readonly captureReasons: readonly InexactReason[];
  /** now() when the capture resolved. */
  readonly capturedAt: number;
}

export type InexactCause =
  | "untracked-deleted"
  | "untracked-modified"
  | "untracked-not-file"
  | "untracked-unreadable"
  | "untracked-symlink"
  | "untracked-unsafe-path"
  | "dependency-drift"
  | "workspace-link-drift"
  | "index-flags"
  | "checkout-conversion";

export interface InexactReason {
  readonly cause: InexactCause;
  /** Root-relative git path (forward slashes) the cause refers to; "" for a repository-wide cause. */
  readonly path: string;
}

export interface MaterializedReference {
  /** Absolute worktree dir: <realpath(tmpdir)>/omr-ref-<pid>-<16 hex>. */
  readonly dir: string;
  /** True only if inexactReasons is empty (section 2). Approximate never excuses (§1.5-7). */
  readonly exact: boolean;
  readonly inexactReasons: readonly InexactReason[];
  /** Ignored live-tree entries (git relPath, dirs end in "/") absent from dir; node_modules excluded. */
  readonly unreproduced: readonly string[];
  /** Absolute paths of the node_modules links created inside dir. */
  readonly links: readonly string[];
  /**
   * Maps an absolute live path under ref.root, or under the native realpath of ref.root, to the
   * same relative path under dir; undefined outside both. Lexical below the root: pass the
   * canonical (realpath'd) spelling, as the planner produces it.
   */
  toRefPath(livePath: string): string | undefined;
  /** Section 6. Idempotent, never rejects; call only after the recheck process tree has exited. */
  dispose(): Promise<void>;
}

export type MaterializeFailure =
  | "aborted"
  | "commit-missing"
  | "worktree-add-failed"
  | "unsafe-path"
  | "error";

export type MaterializeResult =
  | { readonly ok: true; readonly reference: MaterializedReference }
  | { readonly ok: false; readonly reason: MaterializeFailure; readonly detail: string };

export interface GcReport {
  readonly removed: readonly string[];
  readonly kept: readonly string[];
  readonly failed: readonly string[];
}

// --- Constants ----------------------------------------------------------------

export const REF_DIR_PREFIX = "omr-ref-";
/** omr-ref-<owner pid>-<16 lowercase hex>. Anything else is never removed. */
export const REF_DIR_PATTERN = /^omr-ref-(\d{1,10})-([0-9a-f]{16})$/;
/**
 * Lock reason `git worktree add` without --lock writes until its checkout ends (untranslated:
 * our add runs with LC_ALL=C). Only the git < 2.33 fallback of section 4 step 3 produces it now.
 */
export const INITIALIZING_LOCK_REASON = "initializing";
/**
 * Lock reason of a reference worktree for its whole life (QA-1.5-12): `git worktree add
 * --lock --reason <this>` (git >= 2.33). The pid is the owner pid of the dir name.
 * Git prints it, so a user's `git worktree remove [--force]` explains its refusal.
 */
export function referenceLockReason(pid: number): string {
  return `omr-verify-reference pid=${pid}: its node_modules links lead into the live repository, do not force-remove`;
}
/** `git worktree add` of git < 2.33 rejects --reason (and very old ones --lock) in its option parser. */
const ADD_LOCK_UNSUPPORTED = /unknown option\W+(?:reason|lock)\b/;
export const STALE_REFERENCE_AGE_MS = 60 * 60 * 1000;
/** A live reference dir's mtime is refreshed this often, far below STALE_REFERENCE_AGE_MS (QA-1.5-4). */
export const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
/** Equals the baselineTimeoutMs default (§1.4); callers pass the configured value. */
export const DEFAULT_CAPTURE_TIMEOUT_MS = 15_000;
export const DEFAULT_MATERIALIZE_TIMEOUT_MS = 30_000;
export const CLEANUP_GIT_TIMEOUT_MS = 15_000;
export const CLEANUP_RETRIES = 5;
export const CLEANUP_RETRY_BASE_MS = 100;
export const TRANSIENT_FS_CODES: ReadonlySet<string> = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"]);
export const MAX_UNTRACKED_FILES = 5_000;
export const MAX_UNTRACKED_BYTES = 64 * 1024 * 1024;
export const MAX_SWEEP_ENTRIES = 500_000;
/** Per-path "checkout-conversion" reasons from the eol comparison (section 2e); beyond it, one "" reason. */
export const MAX_CONVERSION_REASONS = 100;
/** Most paths the step-7b re-diff (#88) is limited to; more than this keeps every conversion flag. */
const MAX_REDIFF_PATHS = 64;
/** Marker value for an untracked symbolic link (not a sha256, so it never matches a file hash). */
export const UNTRACKED_SYMLINK = "symlink";
/** Basenames whose drift between commit and the live tree makes a linked node_modules stale (section 2c). */
export const DEPENDENCY_FILES: ReadonlySet<string> = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".pnpmfile.cjs",
  "yarn.lock",
  ".yarnrc.yml",
  "bun.lock",
  "bun.lockb",
  ".npmrc",
]);

// --- Path guards (normative, R3; implemented now so 1.5.2 cannot weaken them) --

export class UnsafeReferencePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeReferencePathError";
  }
}

function pathFor(platform: NodeJS.Platform) {
  return platform === "win32" ? pathWin32 : pathPosix;
}

function comparable(path: string, platform: NodeJS.Platform): string {
  const resolved = pathFor(platform).resolve(path);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function refDirName(pid: number, suffix: string): string {
  const name = `${REF_DIR_PREFIX}${pid}-${suffix}`;
  if (!Number.isSafeInteger(pid) || pid <= 0 || !REF_DIR_PATTERN.test(name)) {
    throw new UnsafeReferencePathError(`invalid reference dir name: ${name}`);
  }
  return name;
}

export function parseRefDirName(name: string): { pid: number; suffix: string } | undefined {
  const match = REF_DIR_PATTERN.exec(name);
  if (!match) return undefined;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  return { pid, suffix: match[2] };
}

/** True when child is strictly below parent (never equal). Both must be absolute. */
export function isStrictlyInside(
  child: string,
  parent: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const p = pathFor(platform);
  if (!p.isAbsolute(child) || !p.isAbsolute(parent)) return false;
  const rel = p.relative(comparable(parent, platform), comparable(child, platform));
  if (rel === "" || p.isAbsolute(rel)) return false;
  return rel.split(p.sep)[0] !== "..";
}

/**
 * R3 hard guard, called immediately before every destructive operation on a
 * reference dir (`git worktree remove --force`, recursive fs.rm). Pure: callers
 * additionally lstat the dir and require a real directory (R2).
 */
export function assertSafeRefDir(
  dir: string,
  tmpRoots: readonly string[],
  platform: NodeJS.Platform = process.platform,
): void {
  const p = pathFor(platform);
  const fail = (why: string): never => {
    throw new UnsafeReferencePathError(`refusing reference dir ${JSON.stringify(dir)}: ${why}`);
  };
  if (typeof dir !== "string" || dir.length === 0 || !p.isAbsolute(dir)) fail("not absolute");
  if (dir.split(/[\\/]+/).some((segment) => segment === "." || segment === "..")) fail("dot segment");
  const resolved = p.resolve(dir);
  if (!parseRefDirName(p.basename(resolved))) fail("name does not match omr-ref-<pid>-<16 hex>");
  const parent = comparable(p.dirname(resolved), platform);
  const underTmpRoot = tmpRoots.some((root) => {
    if (!p.isAbsolute(root)) return false;
    const candidate = comparable(root, platform);
    if (p.parse(candidate).root === candidate) return false; // a filesystem root is never a tmp root
    return candidate === parent;
  });
  if (!underTmpRoot) fail("parent is not a temp root");
}

// --- Shared helpers -------------------------------------------------------------

/**
 * A Set<string> shared by every copy of this module in the process (QA-1.5-4:
 * the plugin can be loaded from two install paths). Kept on globalThis under a
 * Symbol.for key; a foreign value under the key is replaced, never trusted.
 */
function processWideSet(name: string): Set<string> {
  const key = Symbol.for(name);
  const existing: unknown = Reflect.get(globalThis, key);
  if (existing instanceof Set) return existing as Set<string>;
  const created = new Set<string>();
  Reflect.set(globalThis, key, created);
  return created;
}

/** Reference and scratch dirs in use in this process (comparable form); GC never touches them. */
const ACTIVE = processWideSet("omr.reference.active");
/** Dirs this process created and stopped using but could not remove; GC treats them as stale at once. */
const RELEASED = processWideSet("omr.reference.released");

type Logger = Pick<PluginLogger, "warn">;

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** lstat that maps ENOENT (and ENOTDIR) to undefined; every other error propagates. */
async function lstatOrMissing(fs: ReferenceFs, path: string): Promise<ReferenceStats | undefined> {
  try {
    return await fs.lstat(path);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

/**
 * Section 6: the module's only retry loop. Retries TRANSIENT_FS_CODES with exponential
 * backoff, then rethrows. It is flat: `op` must not retry on its own (fs.rm runs with
 * maxRetries: 0, QA-1.5-11). No attempt starts at or after `deadline` (GC's budget).
 */
async function withRetry<T>(op: () => Promise<T>, deadline = Number.POSITIVE_INFINITY): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await op();
    } catch (error) {
      const code = errorCode(error);
      const delay = CLEANUP_RETRY_BASE_MS * 2 ** attempt;
      if (attempt >= CLEANUP_RETRIES || code === undefined || !TRANSIENT_FS_CODES.has(code)) throw error;
      if (Date.now() + delay >= deadline) throw error;
      await sleep(delay);
    }
  }
}

/** Section 10. */
function isSafeRelPath(rel: string, platform: NodeJS.Platform): boolean {
  if (rel.length === 0 || rel.startsWith("/") || pathFor(platform).isAbsolute(rel)) return false;
  if (platform === "win32" && (rel.includes(":") || rel.includes("\\"))) return false;
  return rel.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".." && segment.toLowerCase() !== ".git");
}

function splitZ(stdout: string): string[] {
  return stdout.split("\0").filter((entry) => entry.length > 0);
}

/**
 * `git ls-files --eol -z` -> path -> working-tree eol class (the `w/` column: lf, crlf,
 * mixed, none, -text, or "" for a missing or non-regular file). Each record is
 * "i/%-5s w/%-5s attr/%-17s\t<path>" (git's ls-files.c); only the path follows the tab.
 */
function parseEolList(stdout: string): Map<string, { i: string; w: string }> {
  const result = new Map<string, { i: string; w: string }>();
  for (const record of splitZ(stdout)) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const prefix = record.slice(0, tab);
    const w = /(?:^|\s)w\/(\S*)/.exec(prefix);
    const i = /^i\/(\S*)/.exec(prefix);
    if (w) result.set(record.slice(tab + 1), { i: i?.[1] ?? "", w: w[1] ?? "" });
  }
  return result;
}

function stripNewline(stdout: string): string {
  return stdout.replace(/\r?\n$/, "");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface Budget {
  readonly signal: AbortSignal;
  remaining(): number;
  spent(): boolean;
}

function makeBudget(signal: AbortSignal, timeoutMs: number): Budget {
  const deadline = Date.now() + timeoutMs;
  const combined = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, timeoutMs))]);
  return {
    signal: combined,
    remaining: () => deadline - Date.now(),
    spent: () => combined.aborted || deadline - Date.now() <= 0,
  };
}

interface GitRun {
  readonly cwd: string;
  readonly timeoutMs: number;
  /** Omitted only for `stash create` (section 3 step 4): a kill must never land while git holds a lock. */
  readonly signal?: AbortSignal;
  /** Merged over process.env by the seam. */
  readonly env?: Record<string, string>;
}

/** Overrides for the pathspec environment switches git would otherwise inherit (QA-1.5-18). */
const PATHSPEC_ENV_RESET: Readonly<Record<string, string>> = {
  GIT_LITERAL_PATHSPECS: "0",
  GIT_GLOB_PATHSPECS: "0",
  GIT_NOGLOB_PATHSPECS: "0",
  GIT_ICASE_PATHSPECS: "0",
};

/** One note line the p12 seam appends to stderr when it cut a stream at its maxBuffer (QA-1.5-21). */
const TRUNCATION_NOTE = /^\[(stdout|stderr) truncated at (\d+) chars\]$/;

/**
 * Whether the seam cut stdout (QA-1.5-21, QA-1.5-23). p12's runArgv appends its
 * notes as whole lines after git's own stderr, so only the trailing block of
 * note lines counts: git messages quoting a path named like the note never
 * match. The stdout note must also agree with the cap, i.e. stdout is n chars,
 * or n-1 when the cut dropped half of a surrogate pair.
 */
function stdoutTruncated(result: ExecResult): boolean {
  const lines = result.stderr.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (let i = lines.length - 1; i >= 0; i--) {
    const note = TRUNCATION_NOTE.exec(lines[i] ?? "");
    if (!note) return false;
    if (note[1] === "stdout") {
      const limit = Number(note[2]);
      return result.stdout.length === limit || result.stdout.length === limit - 1;
    }
  }
  return false;
}

/**
 * One git run through the seam; undefined on timeout or abort. Every call is
 * `git --no-optional-locks ...` (QA-1.5-2): read-only commands never refresh
 * the user's index, and so never compete with the producer for index.lock.
 * A truncated stdout (QA-1.5-21) comes back as a failed call (code -1): the
 * seam's trailing stdout note in stderr (stdoutTruncated), or a non-empty
 * `-z` output that does not end in NUL. Every caller parses stdout only after `code === 0`.
 */
async function runGit(argv: ArgvSeam, args: readonly string[], run: GitRun): Promise<ExecResult | undefined> {
  if (run.timeoutMs <= 0 || run.signal?.aborted) return undefined;
  const opts: ExecOptions = { cwd: run.cwd, timeoutMs: run.timeoutMs };
  if (run.signal) opts.signal = run.signal;
  // QA-1.5-18: pathspec env switches (literal/glob/noglob/icase) change what every pathspec
  // means; git reads them as booleans, so "0" neutralises them whatever the plugin inherited.
  opts.env = { ...PATHSPEC_ENV_RESET, ...run.env };
  try {
    const result = await argv("git", ["--no-optional-locks", ...args], opts);
    if (result.timedOut || run.signal?.aborted) return undefined;
    // QA-1.5-21: the p12 seam keeps exit code 0 when it cuts stdout at maxBuffer.
    const cut =
      stdoutTruncated(result) ||
      (args.includes("-z") && result.stdout !== "" && !result.stdout.endsWith("\0"));
    if (cut && result.code === 0) {
      return { ...result, code: -1, stderr: `${result.stderr}\n[omr: git output truncated]` };
    }
    return result;
  } catch (error) {
    // The seam reports spawn failures and aborts by rejecting; both mean "no result".
    return { code: -1, stdout: "", stderr: describeError(error), timedOut: run.signal?.aborted };
  }
}

function isAliveDefault(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

async function tmpRootsFor(fs: ReferenceFs, tmp: string, platform: NodeJS.Platform): Promise<string[]> {
  const p = pathFor(platform);
  const roots = [p.resolve(tmp)];
  try {
    roots.push(p.resolve(await fs.realpath(tmp)));
  } catch {
    // realpath failed (e.g. tmp missing): only the resolved form can be a tmp root.
    return roots;
  }
  return roots;
}

// --- Dispose pipeline (section 6) ---------------------------------------------

interface CleanupContext {
  readonly argv: ArgvSeam;
  readonly fs: ReferenceFs;
  readonly root: string;
  readonly tmpRoots: readonly string[];
  readonly platform: NodeJS.Platform;
  readonly logger?: Logger;
  /**
   * GC's budget end (Date.now() scale; QA-1.5-11): no cleanup retry starts after it,
   * and step 4 is skipped once it has passed. Unset for dispose, which CLEANUP_RETRIES
   * alone bounds, because cleanup must finish after an abort.
   */
  readonly deadline?: number;
}

function leftInPlace(ctx: CleanupContext, dir: string, reason: string): false {
  ctx.logger?.warn(`reference worktree left in place: ${reason}`, { dir });
  return false;
}

/** Step 2: unlink every link under dir without descending into links. Returns a failure reason or undefined. */
async function sweepLinks(ctx: CleanupContext, dir: string): Promise<string | undefined> {
  const p = pathFor(ctx.platform);
  const root = await lstatOrMissing(ctx.fs, dir);
  if (!root) return undefined;
  if (root.isSymbolicLink() || !root.isDirectory()) return "reference dir is not a real directory";
  const realDir = p.resolve(await ctx.fs.realpath(dir));
  const stack = [dir];
  let entries = 0;
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let names: string[];
    try {
      // The lexical check below cannot see a real dir swapped for a junction after
      // its lstat (QA-1.5-3); realpath narrows that window to this call and readdir.
      const real = p.resolve(await ctx.fs.realpath(current));
      if (!insideOrEqual(real, realDir, ctx.platform)) return `sweep reached ${current} resolving outside the dir`;
      names = await withRetry(() => ctx.fs.readdir(current), ctx.deadline);
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      return `sweep could not read ${current}: ${describeError(error)}`;
    }
    for (const name of names) {
      if (++entries > MAX_SWEEP_ENTRIES) return `sweep exceeded ${MAX_SWEEP_ENTRIES} entries`;
      const entry = p.join(current, name);
      if (!isStrictlyInside(entry, dir, ctx.platform)) return `sweep reached ${entry} outside the dir`;
      const stats = await lstatOrMissing(ctx.fs, entry);
      if (!stats) continue;
      if (stats.isSymbolicLink()) {
        try {
          await withRetry(() => ctx.fs.unlink(entry), ctx.deadline);
        } catch (error) {
          if (errorCode(error) !== "ENOENT") return `link ${entry} could not be unlinked: ${describeError(error)}`;
        }
        if (await lstatOrMissing(ctx.fs, entry)) return `link ${entry} survived unlink`;
      } else if (stats.isDirectory()) {
        stack.push(entry);
      }
    }
  }
  return undefined;
}

/** dir's admin entry; null when not registered, undefined when the list failed. */
async function registeredEntry(ctx: CleanupContext, dir: string): Promise<WorktreeEntry | null | undefined> {
  const list = await runGit(ctx.argv, ["worktree", "list", "--porcelain"], { cwd: ctx.root, timeoutMs: CLEANUP_GIT_TIMEOUT_MS });
  if (!list || list.code !== 0) return undefined;
  const wanted = comparable(dir, ctx.platform);
  return parseWorktreeList(list.stdout).find((entry) => comparable(entry.path, ctx.platform) === wanted) ?? null;
}

interface RemoveOptions {
  /** Run step 4 (drop the admin entry); false for capture scratch dirs and unregistered orphans. */
  readonly git: boolean;
  /**
   * Section 6 step 4 (QA-1.5-5, QA-1.5-12): once the dir is gone, the entry may be
   * unlocked when its lock reason is one of ownLockReasons(dir). Only for our own
   * handle, or a GC candidate whose owner is done with it (section 11).
   */
  readonly unlockOwnLock: boolean;
}

/**
 * The lock reasons this module itself writes for dir: referenceLockReason(<pid of its
 * name>) and, from the git < 2.33 fallback or a tree-killed add, INITIALIZING_LOCK_REASON.
 * Any other reason, including an omr reason naming another pid, is someone else's.
 */
function isOwnLockReason(dir: string, reason: string | undefined, platform: NodeJS.Platform): boolean {
  const parsed = parseRefDirName(pathFor(platform).basename(dir));
  return parsed !== undefined && (reason === INITIALIZING_LOCK_REASON || reason === referenceLockReason(parsed.pid));
}

/**
 * Section 6 steps 1-4. Returns true when dir is gone (and, with `git`, unregistered).
 * Never throws; every failure is logged and the leftover is left for GC.
 */
async function removeReferenceDir(
  ctx: CleanupContext,
  dir: string,
  links: readonly string[],
  opts: RemoveOptions,
): Promise<boolean> {
  try {
    // 1. Recorded links, newest first. R1: lstat, then single-entry unlink only.
    for (const link of [...links].reverse()) {
      if (!isStrictlyInside(link, dir, ctx.platform)) return leftInPlace(ctx, dir, `recorded link ${link} is outside the dir`);
      const stats = await lstatOrMissing(ctx.fs, link);
      if (!stats || !stats.isSymbolicLink()) continue;
      try {
        await withRetry(() => ctx.fs.unlink(link), ctx.deadline);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") return leftInPlace(ctx, dir, `link ${link} could not be unlinked: ${describeError(error)}`);
      }
    }
    // 2. Sweep: prove the tree link-free before any recursive removal (R2 iii).
    const sweepFailure = await sweepLinks(ctx, dir);
    if (sweepFailure) return leftInPlace(ctx, dir, sweepFailure);
    // 3. The only recursive deleter: guarded fs.rm (Spike D SAFE #5) on the link-free
    //    tree. fs.rm never follows a link that appears after the sweep (QA-1.5-3);
    //    `git worktree remove` on an existing dir would. maxRetries: 0 inside our flat
    //    loop: Node's own retries nest once per directory level (QA-1.5-11).
    const stats = await lstatOrMissing(ctx.fs, dir);
    if (stats) {
      assertSafeRefDir(dir, ctx.tmpRoots, ctx.platform);
      if (stats.isSymbolicLink() || !stats.isDirectory()) return leftInPlace(ctx, dir, "not a real directory");
      try {
        await withRetry(() => ctx.fs.rm(dir, { recursive: true, force: true, maxRetries: 0, retryDelay: CLEANUP_RETRY_BASE_MS }), ctx.deadline);
      } catch (error) {
        return leftInPlace(ctx, dir, `fs.rm failed: ${describeError(error)}`);
      }
      if (await lstatOrMissing(ctx.fs, dir)) return leftInPlace(ctx, dir, "dir still exists after fs.rm");
    }
    // 4. Only now that the dir is gone: drop the admin entry with
    //    `git worktree remove --force`, which then deletes no tree. Never prune (D5).
    if (opts.git && ctx.deadline !== undefined && Date.now() >= ctx.deadline) {
      ctx.logger?.warn("reference worktree admin entry left registered: GC budget spent", { dir });
      return false;
    }
    const entry = opts.git ? await registeredEntry(ctx, dir) : null;
    if (entry !== null) {
      assertSafeRefDir(dir, ctx.tmpRoots, ctx.platform);
      if (await lstatOrMissing(ctx.fs, dir)) return leftInPlace(ctx, dir, "dir reappeared before admin-entry removal");
      if (entry?.locked) {
        // Our add locks the entry for the reference's whole life (QA-1.5-12); the git < 2.33
        // fallback, killed mid-checkout, leaves "initializing" (QA-1.5-5). Lifted only here,
        // with the dir gone. Every other lock reason belongs to someone else and is respected.
        if (!opts.unlockOwnLock || !isOwnLockReason(dir, entry.lockReason, ctx.platform)) {
          ctx.logger?.warn("reference worktree admin entry left registered: locked", { dir, reason: entry.lockReason });
          return false;
        }
        const unlocked = await runGit(ctx.argv, ["worktree", "unlock", dir], { cwd: ctx.root, timeoutMs: CLEANUP_GIT_TIMEOUT_MS });
        if (!unlocked || unlocked.code !== 0) {
          ctx.logger?.warn("reference worktree admin entry left locked", { dir, stderr: unlocked?.stderr.trim() });
          return false;
        }
      }
      const removed = await runGit(ctx.argv, ["worktree", "remove", "--force", dir], { cwd: ctx.root, timeoutMs: CLEANUP_GIT_TIMEOUT_MS });
      if (!removed || removed.code !== 0) {
        ctx.logger?.warn("reference worktree admin entry left registered", { dir, stderr: removed?.stderr.trim() });
        return false;
      }
    }
    return true;
  } catch (error) {
    return leftInPlace(ctx, dir, describeError(error));
  }
}

// --- captureReference (section 3) ---------------------------------------------

/** Section 3. Never throws; undefined = no reference (not a repo, submodules, abort, timeout, caps, error). */
export async function captureReference(
  cwd: string,
  signal: AbortSignal,
  deps: CaptureDeps,
): Promise<DispatchReference | undefined> {
  try {
    return await captureInner(cwd, signal, deps);
  } catch {
    // Section 3 step 6: every error (unreadable file, concurrent deletion, abort) means "no reference".
    return undefined;
  }
}

async function captureInner(cwd: string, signal: AbortSignal, deps: CaptureDeps): Promise<DispatchReference | undefined> {
  const platform = process.platform;
  const p = pathFor(platform);
  const budget = makeBudget(signal, deps.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS);
  const git = async (args: readonly string[], at: string) => {
    if (budget.spent()) return undefined;
    const result = await runGit(deps.argv, args, { cwd: at, timeoutMs: budget.remaining(), signal: budget.signal });
    return result && result.code === 0 && !budget.spent() ? result : undefined;
  };

  const top = await git(["rev-parse", "--show-toplevel"], cwd);
  if (!top) return undefined;
  const root = p.resolve(stripNewline(top.stdout));
  const stage = await git(["ls-files", "--stage"], root);
  if (!stage || /^160000 /m.test(stage.stdout)) return undefined;
  // Section 2f (QA-1.5-6): neither stash create nor the drift diff sees an edit to an
  // assume-unchanged (lowercase tag) or skip-worktree (`S`) entry.
  const tagged = await git(["ls-files", "-v", "-z"], root);
  if (!tagged) return undefined;
  const captureReasons: InexactReason[] = [];
  const flagged = splitZ(tagged.stdout)
    .filter((record) => /^(?:[a-z]|S) /.test(record))
    .map((record) => record.slice(record.indexOf(" ") + 1))
    .sort(byCodeUnit);
  if (flagged.length > 0) captureReasons.push({ cause: "index-flags", path: flagged[0] ?? "" });
  const headOut = await git(["rev-parse", "--verify", "HEAD^{commit}"], root);
  if (!headOut) return undefined;
  const head = headOut.stdout.trim();
  const scratchEnv: PrivateIndexEnv = {
    argv: deps.argv, fs: deps.fs, root, tmpdir: deps.tmpdir ?? osTmpdir(), platform, pid: process.pid,
  };
  const stashOut = await withPrivateIndex(scratchEnv, budget, async (copy) => {
    // No signal: an abort must never kill git while it holds a lock. The
    // timeout still bounds it, and can strand a lock only on the copy.
    const stash = await runGit(deps.argv, ["-c", "core.splitIndex=false", "stash", "create"], {
      cwd: root,
      timeoutMs: budget.remaining(),
      env: { GIT_INDEX_FILE: copy },
    });
    return stash && stash.code === 0 && !budget.spent() ? stash.stdout.trim() : undefined;
  });
  if (stashOut === undefined) return undefined;
  let commit: string;
  if (stashOut === "") commit = head;
  else if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(stashOut)) commit = stashOut;
  else return undefined;

  // Section 2e (QA-1.5-6): live bytes of every dirty tracked file, to be compared with the
  // bytes the checkout produces (EOL conversion, text/eol/filter attributes).
  const tracked = new Map<string, string>();
  if (commit !== head) {
    const dirty = await git(["diff-tree", "-r", "-z", "--name-only", "--no-renames", head, commit], root);
    if (!dirty) return undefined;
    const dirtyPaths = splitZ(dirty.stdout).sort();
    if (dirtyPaths.length > MAX_UNTRACKED_FILES) return undefined;
    let dirtyBytes = 0;
    for (const rel of dirtyPaths) {
      if (budget.spent() || !isSafeRelPath(rel, platform)) return undefined;
      const absolute = p.join(root, rel);
      const stats = await lstatOrMissing(deps.fs, absolute);
      if (!stats || stats.isSymbolicLink() || !stats.isFile()) continue; // deleted or not a file: nothing to compare
      dirtyBytes += stats.size;
      if (dirtyBytes > MAX_UNTRACKED_BYTES) return undefined;
      tracked.set(rel, sha256(await deps.fs.readFile(absolute, { signal: budget.signal })));
    }
  }

  const listed = await git(["ls-files", "--others", "--exclude-standard", "--full-name", "-z"], root);
  if (!listed) return undefined;
  const paths = splitZ(listed.stdout).sort();
  if (paths.length > MAX_UNTRACKED_FILES) return undefined;
  const untracked = new Map<string, string>();
  let bytes = 0;
  for (const rel of paths) {
    if (budget.spent() || !isSafeRelPath(rel, platform)) return undefined;
    const absolute = p.join(root, rel);
    const stats = await deps.fs.lstat(absolute);
    if (stats.isSymbolicLink()) {
      untracked.set(rel, UNTRACKED_SYMLINK);
    } else if (stats.isFile()) {
      bytes += stats.size;
      if (bytes > MAX_UNTRACKED_BYTES) return undefined;
      untracked.set(rel, sha256(await deps.fs.readFile(absolute, { signal: budget.signal })));
    } else {
      return undefined;
    }
  }
  if (budget.spent()) return undefined;
  return { root, head, commit, untracked, tracked, captureReasons, capturedAt: Date.now() };
}

interface PrivateIndexEnv {
  readonly argv: ArgvSeam;
  readonly fs: ReferenceFs;
  readonly root: string;
  readonly tmpdir: string;
  readonly platform: NodeJS.Platform;
  readonly pid: number;
  readonly logger?: Logger;
}

/**
 * Section 3 step 4 (QA-1.5-1/2): run `use` with a private copy of the user's
 * index, held in a scratch omr-ref dir that is removed afterwards. Every index
 * write of that git run (stat refresh, lock, temporary stash index) lands next
 * to the copy, never in the user's .git. Undefined when the copy cannot be made.
 */
async function withPrivateIndex<T>(
  env: PrivateIndexEnv,
  budget: Budget,
  use: (copy: string) => Promise<T | undefined>,
): Promise<T | undefined> {
  const p = pathFor(env.platform);
  if (budget.spent()) return undefined;
  const indexOut = await runGit(env.argv, ["rev-parse", "--git-path", "index"], {
    cwd: env.root, timeoutMs: budget.remaining(), signal: budget.signal,
  });
  if (!indexOut || indexOut.code !== 0 || budget.spent()) return undefined;
  const indexFile = p.resolve(env.root, stripNewline(indexOut.stdout));
  const tmpRoots = await tmpRootsFor(env.fs, env.tmpdir, env.platform);
  const realTmp = p.resolve(await env.fs.realpath(env.tmpdir));
  const scratch = p.join(realTmp, refDirName(env.pid, randomBytes(8).toString("hex")));
  assertSafeRefDir(scratch, tmpRoots, env.platform);
  const key = comparable(scratch, env.platform);
  ACTIVE.add(key);
  let created = false;
  try {
    // Non-recursive: EEXIST throws, and a dir we did not create is never cleaned up.
    await env.fs.mkdir(scratch, { mode: 0o700 });
    created = true;
    if (env.platform !== "win32") await env.fs.chmod(scratch, 0o700);
    const copy = p.join(scratch, "index");
    const original = await env.fs.lstat(indexFile);
    const bytes = await env.fs.readFile(indexFile, { signal: budget.signal });
    await env.fs.writeFile(copy, bytes, { mode: 0o600, flag: "wx" });
    // Racy-git detection re-checks the content of entries whose mtime is not older than
    // the index FILE's mtime. A fresh copy's later mtime would make git trust stale stat
    // data and miss a same-size edit made in the index's second. The original mtime,
    // floored to ms (never later than the original), keeps that protection.
    const mtime = new Date(Math.floor(original.mtimeMs));
    await env.fs.utimes(copy, mtime, mtime);
    if (budget.spent()) return undefined;
    return await use(copy);
  } finally {
    try {
      if (created) {
        const ctx: CleanupContext = { argv: env.argv, fs: env.fs, root: env.root, tmpRoots, platform: env.platform, logger: env.logger };
        if (!(await removeReferenceDir(ctx, scratch, [], { git: false, unlockOwnLock: false }))) RELEASED.add(key);
      }
    } finally {
      ACTIVE.delete(key);
    }
  }
}


// --- materialize (sections 4 and 5) -------------------------------------------

function insideOrEqual(child: string, parent: string, platform: NodeJS.Platform): boolean {
  return comparable(child, platform) === comparable(parent, platform) || isStrictlyInside(child, parent, platform);
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Section 2d: top-level entries of a node_modules dir plus one level under each `@scope`. */
async function packageEntries(fs: ReferenceFs, nodeModules: string, platform: NodeJS.Platform): Promise<string[]> {
  const p = pathFor(platform);
  const readdirOrEmpty = async (dir: string) => {
    try {
      return await fs.readdir(dir);
    } catch {
      // Unreadable: nothing to inspect; drift through it cannot be detected (OPEN RISKS).
      return [];
    }
  };
  const result: string[] = [];
  for (const name of await readdirOrEmpty(nodeModules)) {
    const full = p.join(nodeModules, name);
    if (!name.startsWith("@")) {
      result.push(full);
      continue;
    }
    const stats = await lstatOrMissing(fs, full);
    if (stats && stats.isDirectory() && !stats.isSymbolicLink()) {
      for (const inner of await readdirOrEmpty(full)) result.push(p.join(full, inner));
    } else {
      result.push(full);
    }
  }
  return result;
}

/** Section 4. Never throws; on failure nothing is left behind (the dispose pipeline has run). */
export async function materialize(
  ref: DispatchReference,
  currentTree: TreeSnapshot | undefined,
  signal: AbortSignal,
  deps: ReferenceDeps,
): Promise<MaterializeResult> {
  const platform = deps.platform ?? process.platform;
  const p = pathFor(platform);
  const fs = deps.fs;
  const budget = makeBudget(signal, deps.timeoutMs ?? DEFAULT_MATERIALIZE_TIMEOUT_MS);
  const root = p.resolve(ref.root);
  const links: string[] = [];
  let dir: string | undefined;
  let ctx: CleanupContext | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const fail = (reason: MaterializeFailure, detail: string): MaterializeResult => ({ ok: false, reason, detail });
  const cleanup = async () => {
    clearInterval(heartbeat);
    if (!dir) return;
    const key = comparable(dir, platform);
    try {
      // Our own dir: its omr lock (or the fallback's "initializing") is our own add's.
      if (ctx && !(await removeReferenceDir(ctx, dir, links, { git: true, unlockOwnLock: true }))) RELEASED.add(key);
    } finally {
      ACTIVE.delete(key);
    }
  };
  const abandon = async (reason: MaterializeFailure, detail: string) => {
    await cleanup();
    return fail(reason, detail);
  };
  const git = async (args: readonly string[]) =>
    budget.spent() ? undefined : runGit(deps.argv, args, { cwd: root, timeoutMs: budget.remaining(), signal: budget.signal });

  try {
    // 0. Same-repository guard.
    if (currentTree) {
      const cwd = p.resolve(currentTree.cwd);
      const realRoot = p.resolve(await fs.realpath(root));
      if (!insideOrEqual(cwd, root, platform) && !insideOrEqual(cwd, realRoot, platform)) {
        return fail("error", "currentTree is not inside the reference repository");
      }
    }
    // 1. The unreferenced stash commit may have been pruned (section 8).
    const exists = await git(["cat-file", "-e", `${ref.commit}^{commit}`]);
    if (budget.spent()) return fail("aborted", "aborted before the worktree was created");
    if (!exists || exists.code !== 0) return fail("commit-missing", `commit ${ref.commit} is not in the repository`);
    // 2. Name and guard the dir before anything is created.
    const tmp = deps.tmpdir ?? osTmpdir();
    const tmpRoots = await tmpRootsFor(fs, tmp, platform);
    const realTmp = p.resolve(await fs.realpath(tmp));
    const suffix = (deps.randomSuffix ?? (() => randomBytes(8).toString("hex")))();
    const candidate = p.join(realTmp, refDirName(deps.pid ?? process.pid, suffix));
    assertSafeRefDir(candidate, tmpRoots, platform);
    if (await lstatOrMissing(fs, candidate)) return fail("unsafe-path", `${candidate} already exists`);
    const key = comparable(candidate, platform);
    ACTIVE.add(key);
    try {
      // Private before the first checked-out byte (QA-1.5-10); git checks out into this
      // empty dir. Non-recursive: a racing creator makes it throw, and a dir we did not
      // create is never cleaned up.
      await fs.mkdir(candidate, { mode: 0o700 });
    } catch (error) {
      ACTIVE.delete(key);
      const code = errorCode(error);
      return fail(code === "EEXIST" ? "unsafe-path" : "error", `${candidate} could not be created: ${describeError(error)}`);
    }
    dir = candidate;
    ctx = { argv: deps.argv, fs, root, tmpRoots, platform, logger: deps.logger };
    // Heartbeat (QA-1.5-4): while the handle is in use, the dir's mtime stays younger than
    // STALE_REFERENCE_AGE_MS, so another process's GC never takes a live reference for a
    // PID-reuse leftover. Cleared first thing in cleanup().
    const beating = dir;
    heartbeat = setInterval(() => {
      const now = new Date();
      fs.utimes(beating, now, now).catch((error: unknown) =>
        deps.logger?.warn("reference heartbeat failed", { dir: beating, error: describeError(error) }));
    }, deps.heartbeatMs ?? HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();
    if (platform !== "win32") await fs.chmod(dir, 0o700); // exact mode, whatever the umask
    // 3. Hooks disabled (D9): core.hooksPath names a fresh random path in the tmp root,
    //    outside the worktree, so no committed content can create it (QA-1.5-8).
    //    LC_ALL=C keeps the "initializing" lock reason untranslated, so an abort
    //    mid-checkout leaves a lock that cleanup recognises (QA-1.5-5).
    const noHooks = p.join(realTmp, `omr-nohooks-${randomBytes(8).toString("hex")}`);
    if (await lstatOrMissing(fs, noHooks)) return await abandon("unsafe-path", `${noHooks} already exists`);
    //    --lock --reason (QA-1.5-12): git writes our reason instead of "initializing" from
    //    the start and keeps it after the checkout, so a user's `git worktree remove
    //    [--force]` refuses this entry while its links lead into the live node_modules.
    const add = async (lock: readonly string[]) => budget.spent() ? undefined : runGit(deps.argv, [
      "-c", `core.hooksPath=${noHooks}`,
      "-c", "advice.detachedHead=false",
      "worktree", "add", "--detach", ...lock, candidate, ref.commit,
    ], { cwd: root, timeoutMs: budget.remaining(), signal: budget.signal, env: { LC_ALL: "C" } });
    let added = await add(["--lock", "--reason", referenceLockReason(deps.pid ?? process.pid)]);
    if (added && added.code !== 0 && !budget.spent() && ADD_LOCK_UNSUPPORTED.test(added.stderr)) {
      // git < 2.33: the option parser failed before anything was written; the dir must still be empty.
      if ((await fs.readdir(dir)).length > 0) return await abandon("worktree-add-failed", added.stderr.trim());
      deps.logger?.warn("git worktree add has no --lock --reason (git < 2.33): reference worktree left unlocked", { dir });
      added = await add([]);
    }
    if (budget.spent()) return await abandon("aborted", "aborted during git worktree add");
    if (!added || added.code !== 0) return await abandon("worktree-add-failed", added?.stderr.trim() ?? "");

    // 3b. Byte-exactness of the checkout (section 2e/2f, QA-1.5-6).
    const reasons: InexactReason[] = [...ref.captureReasons];
    const autocrlf = await git(["config", "--get", "core.autocrlf"]);
    if (budget.spent()) return await abandon("aborted", "aborted while reading core.autocrlf");
    if (autocrlf && autocrlf.code === 0 && !/^(?:false|no|off|0|)$/i.test(autocrlf.stdout.trim())) {
      reasons.push({ cause: "checkout-conversion", path: "" });
    }
    for (const [rel, hash] of [...ref.tracked].sort(([a], [b]) => byCodeUnit(a, b))) {
      if (budget.spent()) return await abandon("aborted", "aborted while comparing tracked files");
      if (!isSafeRelPath(rel, platform)) {
        reasons.push({ cause: "checkout-conversion", path: rel });
        continue;
      }
      const checkedOut = p.join(dir, rel);
      const stats = await lstatOrMissing(fs, checkedOut);
      const same = stats !== undefined && stats.isFile() && !stats.isSymbolicLink() &&
        sha256(await fs.readFile(checkedOut, { signal: budget.signal })) === hash;
      if (!same) reasons.push({ cause: "checkout-conversion", path: rel });
    }

    // 4. Untracked files: the hashed buffer is the written buffer.
    const changed = new Set<string>();
    const inexact = (cause: InexactCause, path: string) => {
      reasons.push({ cause, path });
      changed.add(path);
    };
    for (const [rel, hash] of [...ref.untracked].sort(([a], [b]) => byCodeUnit(a, b))) {
      if (budget.spent()) return await abandon("aborted", "aborted while copying untracked files");
      if (!isSafeRelPath(rel, platform)) {
        reasons.push({ cause: "untracked-unsafe-path", path: rel });
        continue;
      }
      if (hash === UNTRACKED_SYMLINK) {
        reasons.push({ cause: "untracked-symlink", path: rel });
        continue;
      }
      const source = p.join(root, rel);
      let stats: ReferenceStats | undefined;
      let bytes: Uint8Array;
      try {
        stats = await lstatOrMissing(fs, source);
        if (!stats) {
          inexact("untracked-deleted", rel);
          continue;
        }
        if (!stats.isFile() || stats.isSymbolicLink()) {
          inexact("untracked-not-file", rel);
          continue;
        }
        bytes = await fs.readFile(source, { signal: budget.signal });
      } catch (error) {
        if (budget.spent()) return await abandon("aborted", describeError(error));
        inexact("untracked-unreadable", rel);
        continue;
      }
      if (sha256(bytes) !== hash) {
        inexact("untracked-modified", rel);
        continue;
      }
      const dest = p.join(dir, rel);
      const parent = p.dirname(dest);
      await fs.mkdir(parent, { recursive: true });
      if (!insideOrEqual(p.resolve(await fs.realpath(parent)), dir, platform)) {
        inexact("untracked-unsafe-path", rel);
        continue;
      }
      await fs.writeFile(dest, bytes, { mode: stats.mode & 0o777, flag: "wx" });
    }

    // 5. Discovery of ignored entries; nothing ignored is ever copied.
    const ignored = await git(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]);
    if (budget.spent()) return await abandon("aborted", "aborted during ignored-file discovery");
    if (!ignored || ignored.code !== 0) return await abandon("error", ignored?.stderr.trim() ?? "ignored-file discovery failed");
    const unreproduced: string[] = [];
    const candidates: string[] = [];
    for (const entry of splitZ(ignored.stdout)) {
      const rel = entry.replace(/\/$/, "");
      if (rel.split("/").at(-1) === "node_modules" && isSafeRelPath(rel, platform)) candidates.push(entry);
      else unreproduced.push(entry);
    }

    // 6. Link node_modules (section 5), parents before children (git's order).
    const linkTargets: string[] = [];
    for (const entry of candidates) {
      if (budget.spent()) return await abandon("aborted", "aborted while linking node_modules");
      const rel = entry.replace(/\/$/, "");
      const source = p.join(root, rel);
      const sourceStats = await lstatOrMissing(fs, source);
      let target: string | undefined;
      if (sourceStats && (sourceStats.isDirectory() || sourceStats.isSymbolicLink())) {
        try {
          target = p.resolve(await fs.realpath(source));
        } catch {
          // Dangling link: nothing to link to.
          target = undefined;
        }
      }
      const targetStats = target ? await lstatOrMissing(fs, target) : undefined;
      const linkPath = p.join(dir, rel);
      const parent = p.dirname(linkPath);
      const parentStats = await lstatOrMissing(fs, parent);
      const linkable =
        target !== undefined &&
        targetStats !== undefined && targetStats.isDirectory() && !targetStats.isSymbolicLink() &&
        parentStats !== undefined && parentStats.isDirectory() && !parentStats.isSymbolicLink() &&
        insideOrEqual(p.resolve(await fs.realpath(parent)), dir, platform) &&
        isStrictlyInside(linkPath, dir, platform) &&
        (await lstatOrMissing(fs, linkPath)) === undefined;
      if (!linkable || target === undefined) {
        unreproduced.push(entry);
        continue;
      }
      links.push(linkPath);
      await fs.symlink(target, linkPath, platform === "win32" ? "junction" : "dir");
      linkTargets.push(target);
    }

    // 7. Drift checks (section 2 c and d). Porcelain `git diff` rewrites the index
    //    it compares with even under --no-optional-locks, so it gets a private copy.
    const scratchEnv: PrivateIndexEnv = {
      argv: deps.argv, fs, root, tmpdir: tmp, platform, pid: deps.pid ?? process.pid, logger: deps.logger,
    };
    // `only`: the step-7b re-diff (#88) is limited to the paths it must classify, as literal
    // pathspecs whatever GIT_LITERAL_PATHSPECS says.
    const driftDiff = (only: readonly string[] = []) =>
      withPrivateIndex(scratchEnv, budget, (copy) =>
        runGit(deps.argv, [
          ...(only.length > 0 ? ["--literal-pathspecs"] : []),
          "-c", "core.splitIndex=false", "diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", ref.commit, "--", ...only,
        ], {
          cwd: root, timeoutMs: budget.remaining(), signal: budget.signal, env: { GIT_INDEX_FILE: copy },
        }));
    const diff = await driftDiff();
    const nowUntracked = await git(["ls-files", "--others", "--exclude-standard", "-z"]);
    if (budget.spent()) return await abandon("aborted", "aborted during drift checks");
    if (!diff || diff.code !== 0 || !nowUntracked || nowUntracked.code !== 0) {
      return await abandon("error", (diff?.stderr ?? nowUntracked?.stderr ?? "drift check failed").trim());
    }
    for (const rel of splitZ(diff.stdout)) changed.add(rel);
    for (const rel of splitZ(nowUntracked.stdout)) if (!ref.untracked.has(rel)) changed.add(rel);
    const realRoot = p.resolve(await fs.realpath(root));
    const workspaceDirs = new Set<string>();
    for (const target of linkTargets) {
      for (const entry of await packageEntries(fs, target, platform)) {
        const stats = await lstatOrMissing(fs, entry);
        if (!stats || !stats.isSymbolicLink()) continue;
        let real: string;
        try {
          real = p.resolve(await fs.realpath(entry));
        } catch {
          // Dangling package link: it cannot load code from the live tree.
          continue;
        }
        const base = [realRoot, root].find((candidateRoot) => isStrictlyInside(real, candidateRoot, platform));
        if (!base) continue;
        const rel = p.relative(base, real).split(p.sep).join("/");
        if (!rel.split("/").includes("node_modules")) workspaceDirs.add(rel);
      }
    }
    const fold = (s: string) => (platform === "win32" ? s.toLowerCase() : s);
    // Section 2 (c) and (d) over a set of drifted paths; run on the step-7 set and, in step 7b, on
    // the paths its re-diff adds (#88), so a late edit is judged like any other drift.
    const driftReasons = (paths: readonly string[]) => {
      const sorted = [...paths].sort(byCodeUnit);
      for (const rel of sorted) {
        if (DEPENDENCY_FILES.has(rel.split("/").at(-1) ?? "")) reasons.push({ cause: "dependency-drift", path: rel });
      }
      for (const rel of [...workspaceDirs].sort(byCodeUnit)) {
        const prefix = fold(rel) + "/";
        if (reasons.some((r) => r.cause === "workspace-link-drift" && r.path === rel)) continue;
        if (sorted.some((c) => fold(c) === fold(rel) || fold(c).startsWith(prefix))) {
          reasons.push({ cause: "workspace-link-drift", path: rel });
        }
      }
    };
    driftReasons([...changed]);

    // 7b. Clean-file checkout conversion (section 2e, QA-1.5-13): the working-tree eol class
    //     of every tracked path that is neither hashed above (ref.tracked) nor changed since
    //     the commit must be the same in root and dir. Skipped when a repository-wide
    //     conversion reason (core.autocrlf) already makes the reference approximate.
    const conversion = (path: string) => {
      if (!reasons.some((r) => r.cause === "checkout-conversion" && r.path === path)) reasons.push({ cause: "checkout-conversion", path });
    };
    if (!reasons.some((r) => r.cause === "checkout-conversion" && r.path === "")) {
      // The caller's signal, not the budget's: this is the last step, so a spent budget
      // leaves the reference approximate ("" reason) instead of failing it.
      const eolClasses = async (cwd: string) => {
        // QA-1.5-18: the full listing. No pathspec limit is sound: a clean file's live bytes come
        // from its last checkout (old core.autocrlf, legacy `crlf`, later working-tree-encoding).
        const listed = await runGit(deps.argv, ["ls-files", "--eol", "-z"], {
          cwd,
          timeoutMs: budget.remaining(),
          signal,
        });
        return listed && listed.code === 0 ? parseEolList(listed.stdout) : undefined;
      };
      // QA-1.5-17: both listings run concurrently, which halves the wall time; the bound
      // itself is budget.remaining() plus the "" fallback. A truncated listing is a failed
      // call (QA-1.5-21), so it also takes the "" fallback.
      const [liveEol, refEol] = await Promise.all([eolClasses(root), eolClasses(dir)]);
      if (signal.aborted) return await abandon("aborted", "aborted during the eol comparison");
      if (!liveEol || !refEol) {
        conversion(""); // not compared: budget spent or git failed
      } else {
        // #88: a writer that edits a file between the step-7 diff and the live listing leaves it
        // in neither set; its live `w/` then differs from the reference's with no checkout
        // conversion behind it. Take the diff again, limited to those paths (at most
        // MAX_REDIFF_PATHS; beyond that the flags stay), before flagging them. A failed or
        // unaffordable re-diff changes nothing, so every flag stays (fail safe). Paths it adds go
        // through the (c)/(d) drift checks and then the QA-1.5-16 rule below.
        const unexplained = (rel: string, w: string) => {
          if (ref.tracked.has(rel) || changed.has(rel)) return false;
          const live = liveEol.get(rel);
          return live !== undefined && live.w !== w;
        };
        const suspects = [...refEol].filter(([rel, { w }]) => unexplained(rel, w)).map(([rel]) => rel).sort(byCodeUnit);
        if (suspects.length > 0 && suspects.length <= MAX_REDIFF_PATHS && !budget.spent()) {
          let again: ExecResult | undefined;
          try {
            again = await driftDiff(suspects);
          } catch (error) {
            if (signal.aborted || error instanceof UnsafeReferencePathError) throw error;
            deps.logger?.warn("reference eol re-diff failed: flags kept", { error: describeError(error) });
          }
          if (signal.aborted) return await abandon("aborted", "aborted during the eol comparison");
          if (again && again.code === 0) {
            const added = splitZ(again.stdout).filter((rel) => !changed.has(rel));
            for (const rel of added) changed.add(rel);
            driftReasons(added);
          } else if (again) {
            deps.logger?.warn("reference eol re-diff failed: flags kept", { code: again.code, stderr: again.stderr.trim() });
          }
        }
        // QA-1.5-16: a path edited since capture (in changed, not in ref.tracked) has unknown
        // dispatch bytes; it is flagged when the reference's checkout converted it (w/ != i/).
        const differing = [...refEol]
          .filter(([rel, { i, w }]) => {
            if (changed.has(rel) && !ref.tracked.has(rel)) return i !== "" && w !== "" && i !== w;
            return unexplained(rel, w);
          })
          .map(([rel]) => rel)
          .sort(byCodeUnit);
        for (const rel of differing.slice(0, MAX_CONVERSION_REASONS)) conversion(rel);
        if (differing.length > MAX_CONVERSION_REASONS) conversion("");
      }
    }

    // 8. The handle.
    const refDir = dir;
    let disposing: Promise<void> | undefined;
    const reference: MaterializedReference = {
      dir: refDir,
      exact: reasons.length === 0,
      inexactReasons: reasons,
      unreproduced,
      links: [...links],
      toRefPath(livePath: string) {
        if (!p.isAbsolute(livePath)) return undefined;
        const absolute = p.resolve(livePath);
        // E2E-2: the root as git spelled it, or its native realpath. The recheck passes the
        // planner's canonical paths (runnerCwd, failing files), which are realpath'd: a root
        // reached through a junction, a subst drive or an 8.3 name matched neither otherwise.
        for (const base of [root, realRoot]) {
          if (comparable(absolute, platform) === comparable(base, platform)) return refDir;
          if (isStrictlyInside(absolute, base, platform)) return p.join(refDir, p.relative(base, absolute));
        }
        return undefined;
      },
      dispose() {
        disposing ??= cleanup();
        return disposing;
      },
    };
    return { ok: true, reference };
  } catch (error) {
    const reason: MaterializeFailure =
      error instanceof UnsafeReferencePathError ? "unsafe-path" : budget.spent() ? "aborted" : "error";
    return await abandon(reason, describeError(error));
  }
}

// --- gcStaleReferences (section 11) -------------------------------------------

interface WorktreeEntry {
  path: string;
  locked: boolean;
  /** The text after "locked " ("" for a bare `locked` line); a C-quoted reason stays quoted and so never matches. */
  lockReason?: string;
  prunable: boolean;
}

function parseWorktreeList(stdout: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), locked: false, prunable: false };
      entries.push(current);
    } else if (current && (line === "locked" || line.startsWith("locked "))) {
      current.locked = true;
      current.lockReason = line.slice("locked ".length);
    } else if (current && (line === "prunable" || line.startsWith("prunable "))) {
      current.prunable = true;
    }
  }
  return entries;
}

/** Section 11. Never throws; touches only stale omr-ref-* dirs directly under a tmp root. */
export async function gcStaleReferences(root: string, deps: ReferenceDeps): Promise<GcReport> {
  const report = { removed: [] as string[], kept: [] as string[], failed: [] as string[] };
  try {
    await gcInner(root, deps, report);
  } catch (error) {
    deps.logger?.warn("reference GC failed", { error: describeError(error) });
  }
  if (report.failed.length > 0) deps.logger?.warn("reference GC left dirs in place", { failed: report.failed.length });
  return report;
}

async function gcInner(
  root: string,
  deps: ReferenceDeps,
  report: { removed: string[]; kept: string[]; failed: string[] },
): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const p = pathFor(platform);
  const fs = deps.fs;
  const now = deps.now ?? Date.now;
  const isAlive = deps.isAlive ?? isAliveDefault;
  const budget = makeBudget(new AbortController().signal, deps.timeoutMs ?? DEFAULT_MATERIALIZE_TIMEOUT_MS);
  const absRoot = p.resolve(root);
  const tmpRoots = await tmpRootsFor(fs, deps.tmpdir ?? osTmpdir(), platform);
  const ctx: CleanupContext = {
    argv: deps.argv, fs, root: absRoot, tmpRoots, platform, logger: deps.logger, deadline: Date.now() + budget.remaining(),
  };
  // Section 11 step 3 (QA-1.5-4). The caller skips ACTIVE dirs first. An alive owner's dir
  // is stale only once its heartbeat (mtime) is older than STALE_REFERENCE_AGE_MS, i.e.
  // the PID was reused. Our own PID has no special case: RELEASED names our own leftovers.
  const released = (keys: readonly string[]) => keys.some((k) => RELEASED.has(k));
  const stale = (pid: number, stats: ReferenceStats | undefined, keys: readonly string[]) =>
    !stats || released(keys) || !isAlive(pid) || now() - stats.mtimeMs > STALE_REFERENCE_AGE_MS;
  const collected = (keys: readonly string[]) => {
    for (const k of keys) RELEASED.delete(k);
  };
  const isSafe = (dir: string) => {
    try {
      assertSafeRefDir(dir, tmpRoots, platform);
      return true;
    } catch {
      // Not an omr reference dir under a tmp root: never a candidate (R3).
      return false;
    }
  };

  const gitRun = (): GitRun => ({ cwd: absRoot, timeoutMs: budget.remaining(), signal: budget.signal });
  const list = await runGit(deps.argv, ["worktree", "list", "--porcelain"], gitRun());
  if (!list || list.code !== 0) {
    deps.logger?.warn("reference GC skipped: git worktree list failed", { stderr: list?.stderr.trim() });
    return;
  }
  const entries = parseWorktreeList(list.stdout);
  const registered = new Set(entries.map((entry) => comparable(entry.path, platform)));

  // 1-4. Registered candidates.
  for (const entry of entries) {
    if (budget.spent()) return;
    const dir = p.resolve(entry.path);
    const parsed = parseRefDirName(p.basename(dir));
    if (!parsed || !isSafe(dir)) continue;
    const key = comparable(dir, platform);
    const keys = [key];
    const ownLock = entry.locked && isOwnLockReason(dir, entry.lockReason, platform);
    if ((entry.locked && !ownLock) || ACTIVE.has(key)) {
      report.kept.push(dir);
      continue;
    }
    const stats = await lstatOrMissing(fs, dir);
    let collect: boolean;
    if (!entry.locked) {
      collect = stale(parsed.pid, stats, keys);
    } else if (entry.lockReason === INITIALIZING_LOCK_REASON) {
      // QA-1.5-5: left by a killed `git worktree add`; lifted only once no add can still
      // be running: our own released dir, or a dead owner.
      collect = released(keys) || !isAlive(parsed.pid);
    } else {
      // QA-1.5-12: our reference lock lasts the handle's whole life, so the section 11 rules
      // apply as to an unlocked entry, except a missing dir of an alive owner: that owner
      // may be between its fs.rm and its own unlock (section 6 step 4).
      // QA-1.5-15: a missing dir carrying our exact reason is collected whatever the pid's
      // liveness (a reused pid would otherwise keep it forever). Racing an alive owner between
      // its fs.rm and its unlock is benign: both sides only unlock our reason and remove an
      // entry whose dir is gone.
      collect =
        stats === undefined ||
        released(keys) ||
        !isAlive(parsed.pid) ||
        now() - stats.mtimeMs > STALE_REFERENCE_AGE_MS;
    }
    if (!collect) {
      report.kept.push(dir);
      continue;
    }
    if (await removeReferenceDir(ctx, dir, [], { git: true, unlockOwnLock: ownLock })) {
      collected(keys);
      report.removed.push(dir);
    } else {
      report.failed.push(dir);
    }
  }

  // 5. Orphans of this repository (D7).
  const common = await runGit(deps.argv, ["rev-parse", "--git-common-dir"], gitRun());
  if (!common || common.code !== 0) return;
  const gitDir = p.resolve(absRoot, stripNewline(common.stdout));
  const gitDirs = [gitDir];
  try {
    gitDirs.push(p.resolve(await fs.realpath(gitDir)));
  } catch {
    // Only the resolved form is available.
    gitDirs.push(gitDir);
  }
  const seenRoots = new Set<string>();
  for (const tmpRoot of tmpRoots) {
    const key = comparable(tmpRoot, platform);
    if (seenRoots.has(key)) continue;
    seenRoots.add(key);
    let names: string[];
    try {
      names = await fs.readdir(tmpRoot);
    } catch {
      // Unreadable tmp root: no orphans can be found there.
      continue;
    }
    for (const name of names) {
      if (budget.spent()) return;
      const parsed = parseRefDirName(name);
      if (!parsed) continue;
      const dir = p.join(tmpRoot, name);
      if (!isSafe(dir)) continue;
      const stats = await lstatOrMissing(fs, dir);
      if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) continue;
      let realDir = dir;
      try {
        realDir = p.resolve(await fs.realpath(dir));
      } catch {
        // Vanished meanwhile: nothing to collect.
        continue;
      }
      const keys = [comparable(dir, platform), comparable(realDir, platform)];
      if (keys.some((k) => registered.has(k) || ACTIVE.has(k))) continue;
      if (!stale(parsed.pid, stats, keys)) {
        report.kept.push(dir);
        continue;
      }
      const dotGit = p.join(dir, ".git");
      const dotGitStats = await lstatOrMissing(fs, dotGit);
      if (dotGitStats) {
        if (!dotGitStats.isFile() || dotGitStats.isSymbolicLink()) continue;
        const text = new TextDecoder().decode(await fs.readFile(dotGit, {}));
        const match = /^gitdir:\s*(.+?)\s*$/m.exec(text);
        if (!match) continue;
        const target = p.resolve(dir, match[1]);
        if (!gitDirs.some((g) => isStrictlyInside(target, g, platform))) continue; // another repository's orphan
      }
      if (await removeReferenceDir(ctx, dir, [], { git: false, unlockOwnLock: false })) {
        collected(keys);
        report.removed.push(dir);
      } else {
        report.failed.push(dir);
      }
    }
  }
}