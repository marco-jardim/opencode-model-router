// src/verify/batch.ts
// S5 batching coordinator (plan Phase 2.2). The header below is the design of task 2.2.1; the
// pure helpers (2.2.2.b) and createBatchCoordinator (2.2.2.c, 2.2.2.d) implement it.
//
// ===============================================================================================
// BATCHING COORDINATOR: design (plan Phase 2.2, task 2.2.1)
//
// Consumes only the 2.1.1 contract in src/verify/types.ts, block "testsPass pipeline contract"
// (cherry-picked from vrb/p21 as 5be8c85 and never edited here): Deadline, ScopedOutcome,
// RecheckOutcome, VerificationScope, OpenVerificationScope, TestsPassRequest, TestsPassRun,
// TestsPassHook. Runner facts come from src/verify/runner.ts sections G, H, I (step 2a), J and
// Q 2.2. The pipeline and the verdict algebra are specified in the "testsPass PIPELINE" header of
// src/verify/deterministic.ts (vrb/p21, 7cd793d), cited below as 2.1-T<n>. Plan: section 1.3 (S5),
// 1.4 (batchWindowMs), 1.5-13 (deadline), 1.5-18/19 (router_verify and background mode reuse this
// coordinator), Phase 2.2. Record: docs/qa/verification-resource-budget/phase-2.2.md.
//
// -----------------------------------------------------------------------------------------------
// B1. GOAL AND GUARANTEES
//
//   Concurrent testsPass checks that would run the same program with the same options become one
//   scoped run over the union of their changed files. Each requester still gets the TestsPassRun
//   it would have got running alone. hook(runtime) returns exactly a TestsPassHook, so 2.2.3 swaps
//   the coordinator in behind 2.1's direct hook with no signature change. router_verify (2.4.3)
//   and background mode (2.4.5) reach it through the same hook.
//
//   B-G1 Equivalence. Under a deterministic runner, with no deadline expiry and no slot
//        contention, each request's TestsPassRun judges (2.1-T5) to the same ok, the same
//        unverifiable and the same introduced/preexisting/unknown sets as the direct hook gives
//        that request alone (B12).
//   B-G2 Only toward caution. When the runner is not deterministic (flaky tests), the batch may
//        turn a would-be pass into unverifiable. It never turns anything into a pass (B7.5).
//   B-G3 One slot hold per batch (QA-1.4-18). Each batch opens one VerificationScope, once, and
//        holds it across the union run, the attribution runs and every recheck. Scopes are never
//        nested. A split batch opens none: it hands each member to a batch of its own (B5.6).
//   B-G4 A requester's own deadline bounds every step it waits for. One requester's expiry or
//        abort never cancels the batch for the others. When every requester is gone, the running
//        tree is killed.
//   B-G5 The hook never rejects (TestsPassHook contract). Any internal failure becomes a
//        ScopedOutcome "error" for the requests it affects (fail-closed, 2.1-T6 R8).
//   B-G6 State is bounded. No timer outlives its window, and nothing outlives dispose().
//   B-G7 Deadline pressure (QA-2.2-17). A batched request does not end weaker than it would with
//        batchWindowMs: 0 under the same budget, as far as a cheap estimate can ensure. By default
//        an unverifiable verdict is accepted with a caveat (strictUnverifiable off), so a batch
//        that turned a rejection into a deadline-induced unverifiable would weaken the gate. A
//        lone request never waits (W7). The window never eats into a member's reserve (W3). When
//        any member's budget cannot cover the batched schedule, every member runs alone, exactly
//        as its direct hook would (B5.2a, B5.6). Residuals: B15.
//
// -----------------------------------------------------------------------------------------------
// B2. BYPASSES (no window, no union), checked in this order on arrival
//
//   1. The coordinator is disposed -> { scoped: aborted BATCH_REASONS.disposed }.
//   2. request.testScope === "full" -> runtime.direct(request). The resolved command runs as
//      written (2.1-T2 P5f). It cannot be merged, and S6 forbids widening a scoped run into it.
//   2a. request.crossLinkRoot set -> runtime.direct(request) (cross-repo P3a, SD-P3a-8). The
//      coordinator plans with { command, cwd, changedFiles } only, so a union would drop W.
//   3. runtime.batchWindowMs <= 0 -> runtime.direct(request). "batchWindowMs: 0 disables
//      batching": every request runs alone, still scoped.
//   4. plan = runtime.plan(request, request.deadline), that is, planScopedRun (B6). Then:
//        NoAffected    -> { scoped: { kind: "no-affected", note }, recheck: undefined }
//        Unverifiable  -> { scoped: { kind: "unverifiable", code, reason }, recheck: undefined }
//                         (S6; changedFiles "unavailable" lands here as attribution-unavailable)
//        rejection     -> { scoped: { kind: "error", reason }, recheck: undefined }
//      These are exactly 2.1-T2 P3: none of them takes the slot or waits for a window. Planning
//      comes first even when the deadline is already aborted, as in 2.1's direct hook, so those
//      requests get the same planning outcome as alone (QA-2.2-9).
//   5. ScopedSpec, but the coordinator was disposed meanwhile -> B2.1; the deadline is aborted ->
//      aborted BATCH_REASONS.beforeRun (2.1's ABORTED_BEFORE_RUN: its execute answers so with an
//      aborted deadline). Nothing is spawned.
//   6. ScopedSpec -> the request joins the window of batchKey(spec) (B3, B4).
//
// -----------------------------------------------------------------------------------------------
// B3. BATCH KEY
//
//   batchKey(spec) = JSON of [gitRoot, runner, entry, file, cwd, envSignature(spec.env),
//   argvTemplate(spec)], with every path folded to lower case on win32.
//     - gitRoot, runner, entry and envSignature (key-sorted JSON of spec.env) are the plan's key
//       (runner.ts Q 2.2).
//     - Three fields are added (deviation D1): file (node, or the native pytest/uv), cwd (the
//       runnerCwd, which is also the id key space, runner.ts I) and argvTemplate. Two commands
//       that resolve to the same entry can still differ in their kept arguments (-t, --project,
//       -k, -m), in the worker cap, or in pytest's pinned -c/--rootdir (runner.ts D.4). A union
//       run with one request's options would not be the run the other request gets alone (B-G1).
//     - argvTemplate(spec) = spec.args with every element equal to one of spec.inputs removed,
//       and every occurrence of spec.reportPath replaced by "<report>". Inputs are absolute and
//       canonical (runner.ts N.2), so they never collide with an option token.
//   Requests with equal keys run the same program, in the same directory, with the same options
//   and environment. Only their inputs differ.
//
// -----------------------------------------------------------------------------------------------
// B4. WINDOWS
//
//   W1 A window opens when the first request for a key finishes planning with a ScopedSpec. Its
//      close time is set at that moment: openedAt + batchWindowMs, using the opener's runtime
//      value. A config reload does not stretch a window that is already open. Each window has
//      exactly one timer. The wiring caps batchWindowMs at gateBudgetMs / 10 (QA-2.2-21), so the
//      window itself is never most of a gate's budget.
//   W2 The window closes at that time, or at once when it holds maxBatchSize requests
//      (BATCH_MAX_REQUESTS = 8 by default), whichever comes first. The close time never moves
//      later: arrivals do not push it back (no debounce). So a steady stream cannot keep a window
//      open, and no request waits in a window for longer than batchWindowMs (2.1-T3's bound for
//      the batch wait). This is the starvation bound. W3 and W7 only close it earlier.
//   W3 The reserve (QA-2.2-17 b, QA-2.2-24). A member's floor is its
//      runtime.recheckMinRemainingMs when it can recheck at all (failureRecheck on and a captured
//      reference), else 0, plus BATCH_RESERVE_MARGIN_MS (1 s: union planning and scheduling).
//      With e = the key's last measured run duration (0 before the first run of the key), the
//      window closes no later than the moment the member at arrival index k (0 for the first)
//      would be left with less than
//        floor + e x (2k + 1).
//      That is what the schedule after the close needs when the batch splits (B5.6) and the slot
//      is one: the k members that joined before it run and recheck first, then its own run, then
//      its recheck. Their direct hooks would have queued in that order too. QA-2.2-24: the former
//      reserve, floor + e for each member alone, let a window held open by W7's signal spend the
//      recheck of the second tight member. When a member joins, and when a run of the key is measured,
//      the close time moves earlier if needed (the timer is re-armed, still one per window), or
//      the window closes at once when that moment has passed. A joiner whose remaining() is
//      within its floor therefore closes the window at once, as the former W3 did for a joiner
//      that could not outlive the wait.
//   W4 At close, the window is removed from the key map before anything asynchronous happens. A
//      request for the same key that finishes planning later opens the NEXT window. "Later"
//      covers the whole life of the batch: planning its union, waiting for the slot, running,
//      rechecking. A running union is never extended; its inputs are fixed at close.
//   W5 A request whose deadline aborts while it waits in a window is settled at once with
//      aborted BATCH_REASONS.window, and removed. A window left empty clears its timer and is
//      deleted.
//   W6 Batches for different keys (roots, runners, templates) are independent. Each opens its
//      own scope and competes for the machine-wide slot like any other verification, so they run
//      in parallel only as far as maxConcurrentVerifications allows. Two batches for the SAME
//      key (window N running, window N+1 closed) are just as independent, and serialize on the
//      slot when there is only one.
//   W7 Idle close (QA-2.2-17 a, QA-2.2-18). When no request is planning (between its arrival and
//      its window or planning outcome) and no batch is running, nothing can join an open window
//      and the slot is free, so every open window closes at once. It is checked when a request
//      joins, when a planning ends without a spec, and when a batch ends or is evicted. A lone
//      request therefore pays no window latency: its window closes as it joins, and it runs as
//      the direct path (B5.1). Requests that arrive while a batch runs gather in the next window,
//      which closes when that batch ends, at its timer, or by W2/W3 (group commit: under one slot
//      they would have waited for it anyway). The signal is the coordinator's own. The wiring
//      cannot see a gate that has not reached testsPass yet without index.ts and 2.4 bracketing
//      every gate, so concurrent gates batch when they reach testsPass together or while another
//      batch runs. BatchCoordinatorOptions.idleClose: false keeps only the timed close, for the
//      tests of W1-W6.
//
// -----------------------------------------------------------------------------------------------
// B5. BATCH RUN SEQUENCE
//
//   At close, with members M (in arrival order) and the batch deadline D (B9):
//   1. |M| = 1: skip steps 2a and 2. Step 4 runs the member's own spec with the member's own
//      deadline. Steps 5 and 7 have nothing to do, and step 8 is a single-member recheck. This is
//      exactly the direct path.
//   2a. Deadline check (QA-2.2-17 c, QA-2.2-23, QA-2.2-25), before union planning. Take the
//      members in deadline order, and e and each member's floor as in W3. The batch pools only
//      when every member's remaining() is at least
//        floor + e x (2n + i),
//      where n is the number of members and i the member's index. That sum is the worst case of
//      the batched schedule ahead of its recheck: the union (n x e), every member's own run (mode
//      B; a member can be held until the last of them, B5.7) and one recheck for each member
//      ahead of it. Otherwise the batch splits (step 6), and every member runs alone.
//      QA-2.2-25: the union is priced at n runs, never at one. It runs each of the members'
//      related test files once, where their own runs run each at least once; e itself is usually
//      one member's own run, and the union's run grows with its inputs. The check repeats after
//      union planning (step 2) and once the hold is taken (step 3), the schedule's two unmeasured
//      parts, and both are bounded by the time the check has left: past it, the members split.
//      QA-2.2-23: 9ed2abb instead ran the short members first inside the batch's scope. The
//      scope's first execute takes its one hold, and 2.1's scope reports a failed hold attempt to
//      every later call at once (P4). So a short member's cut slot wait became slot-busy for every
//      other member, including members with a minute left. No member now runs in a scope whose
//      hold another member's deadline decides: a pooled scope's first execute is the union under
//      D, and a split member's scope is its own.
//      Before the first measured run of a key, e is 0 and only the floor counts (a residual,
//      B15).
//   2. Union planning (B6): runtime.plan({ command and cwd of the first member, changedFiles:
//      unionChangedFiles(M) }, D'), where D' is D cut off when step 2a's check would fail
//      (QA-2.2-25). The batch splits (step 6) in four cases: the result is not a ScopedSpec;
//      batchKey(unionSpec) differs from the batch key; its inputs are not exactly the union of
//      the members' inputs (set equality on platform keys); or step 2a's check fails afterwards.
//   3. scope = runtime.openScope({ cwd, command }) of the first member. It is opened once, and
//      every execute and rechecker below goes through it (B10). QA-2.2-25: when the scope has
//      hold() (2.1's scopes do), the batch takes the hold first, under D' again, and repeats step
//      2a's check once it holds the slot. A hold not taken in time, or a failed check, closes the
//      scope and splits. The union's execute then reuses the hold (2.1's scope memoizes its one
//      hold attempt), so a batch never takes two.
//   4. U = scope.execute(unionSpec, D). By kind:
//        slot-busy        -> every member gets U. (The scope would report it again without
//                            waiting anyway.)
//        aborted          -> D aborted, so every member was already settled (B9).
//        ran              -> attribution per member (B7).
//        timed-out, error -> every member is "own-run".
//   5. One queue under the hold (QA-2.2-3). Own runs and rechecks run one command at a time,
//      EARLIEST DEADLINE FIRST across both kinds: at each step the member with the least
//      remaining() among those with a runnable step goes next (arrival order breaks ties). Its
//      step is either
//        - its own run (the members marked "own-run"): scope.execute(memberSpec,
//          member.deadline), whose outcome is the member's scoped outcome, verbatim; or
//        - its recheck (B8), as soon as its outcome is final (step 7).
//      So a member never waits for a step it does not need: the member with the least time left
//      runs, rechecks and settles first, and the queue never nests a scope. A member settled in
//      the meantime (an abort) is skipped, and nothing is spawned for it.
//   6. Split (QA-2.2-23): there is no union run, and this batch opens no scope. Every member runs
//      alone, as a batch of one (step 1) with its own gate's runtime: its own scope, whose hold it
//      takes under its own deadline, its own run and its own recheck. That is each member's
//      direct path, so the cost is the same as without batching, and so is every verdict, apart
//      from the time the member spent in the window (W3). The batches of one start in arrival
//      order, the order in which the members' direct hooks would have queued for the slot, and
//      each competes for the slot as its direct hook would: in parallel as far as
//      maxConcurrentVerifications allows. The split is logged once per batch. Causes: step 2a's
//      deadline check, or an inconsistent union plan (step 2).
//   7. Finality and the flaky taint (B7.5). A member's outcome is known after step 4 (derived) or
//      after its own run. It is FINAL once no taint can change it: the union was green or did not
//      run, or every union failing id is reproduced (by a finished own run or a static
//      derivation, B7.5), or no own run is left, in which case the taint is applied once. Until
//      then the member holds its outcome.
//   8. A final outcome settles AT ONCE when it needs no recheck (2.1-T2 P7: "ran" with >= 1
//      failing id and >= 1 failing file), when its reference decides it (B8.1), or when a recheck
//      already run in this batch at the same reference answers it (B8.6). Otherwise the member
//      queues for its recheck (step 5). A green member of a green union therefore settles right
//      after step 4, and a member whose own run reproduces every union failure rechecks right
//      after that run, before the own runs of members with more time left.
//   9. When the queue is empty every member is settled. Then `void scope.close()`: a requester
//      never waits for the close (2.1-T2 P9). The batch leaves the registry.
//
// -----------------------------------------------------------------------------------------------
// B6. UNION SPEC AND DEDUPLICATION
//
//   unionChangedFiles(M) takes each member's ChangedPath entries and resolves path and
//   previousPath against THAT member's request.cwd. ChangedPath paths may be relative to the
//   planner's cwd, and members with the same runnerCwd can have different check cwds. Entries
//   are deduplicated by the platform key of (path, previousPath), in first-seen order, keeping
//   the first entry's status (it is informational: runner.ts G.6 decides existence through the
//   fs). A file edited by two producers appears once.
//   The union is planned by planScopedRun itself (runner.ts Q 2.2), never assembled by hand. That
//   keeps argv construction, the argv-length cap, config triggers and pytest pinning in one
//   place. The step-2 consistency checks catch every way the union plan can differ from the
//   members' plans:
//     - a union-only S6: argv-too-long, too-many-searches, config-too-large;
//     - a pytest pin computed from a different common ancestor;
//     - a search that answered differently;
//     - a file that changed between the plans.
//   Each of these falls back to the split, never to a different run.
//   Cost: union planning repeats the members' test searches (git only, low priority, bounded by
//   D). Merging the members' plans instead would need a new runner.ts entry point (rejected, see
//   phase-2.2.md).
//
// -----------------------------------------------------------------------------------------------
// B7. ATTRIBUTION
//
//   Mode B (runner.ts J, Spike C). vitest has no non-executing related listing, and a jest-only
//   listing (mode A) was rejected. pytest needs no process at all: its spec inputs ARE the test
//   files (inputsAreTests), so a failing file belongs to the members whose inputs contain it.
//   attributeUnion(U.result, counts, memberSpec) decides for each member between "derived" (a
//   RunResult computed from the union's) and "own-run" (the member's own planScopedRun spec runs,
//   B5.5).
//   Keys: fileKeyOf(spec.cwd, abs) is the id-space file key (cwd-relative, "/" separators), the
//   construction readResult uses. fileKeyOfId(id) is 2.1-T5's rule, imported from baseline.ts
//   (2.2.3): the part before the EARLIEST " > " or "::", else the whole id, with "/" separators
//   (QA-2.2-11: a pytest name may contain " > ", as in tests/test_x.py::test_cmp[1 > 0], and its
//   file is still the part before "::"). It is the only id-to-file rule in this module (7.3a, 7.5,
//   B8.5), so the batch and 2.1's judge can never key an id differently.
//
//   7.1 Not comparable: !U.complete, U.collectionError, or U.source !== "report" -> own-run
//       (cause "not-comparable"). A vitest syntax error in any test file aborts `related` without
//       a report, which gives a text source and a collection error. Each member's own run then
//       shows whether that member hits the error alone.
//   7.2 Green union (complete, no collection error, no failing id):
//       a. A member that is not guard-sensitive -> derived green: no ids, complete, total =
//          U.total, exit 0. isGuardSensitive is false when the spec has no lexicalPaths, is not
//          inputsAreTests, and has no JS test file among its inputs (runner.ts G.8 rule). The
//          member's own related set is a subset of the union's (related is monotone in its
//          inputs, and vitest and jest run each test file in its own module scope), so its own
//          run is green too. Its own total may be 0: that is a pass with note n1 instead of
//          evidence e1, which is the same verdict.
//       b. A guard-sensitive member. Its own run would be made incomplete by readResult's
//          zero-test guard (runner.ts I 2a) if IT ran 0 tests, and the union's total cannot show
//          that. With per-file counts (counts = U.testsByFile, prerequisite P1 below):
//            inputsAreTests (pytest): n = the sum of counts over its inputs. n > 0 -> derived
//              green with total n. n = 0 -> derived incomplete with the guard's own note "<runner>
//              ran no tests although a test file was passed", which is exactly its own result.
//            JS test-file inputs (a test file given to related runs itself, runner.ts R): n = the
//              sum of counts over its test-file inputs. n > 0 -> derived green. n = 0 -> own-run
//              (cause "zero-test-ambiguous"): its source inputs may or may not have related tests.
//            lexicalPaths: as the JS rule. Keys that do not match give n = 0, hence own-run.
//          Without counts (P1 not landed, or a text source) -> own-run. This is the
//          "confirmation run".
//   7.3 Failing union (complete, no collection error, >= 1 failing id):
//       a. inputsAreTests (pytest, static attribution): ids = the U.failingIds whose file key is
//          one of the member's input keys; files = the U.failingFiles among its inputs. ids
//          non-empty -> derived, with complete, no collection error, exit 1, and total = the
//          count sum when counts exist (else U.total). ids empty -> the pytest rule of 7.2b (its
//          files all passed, or ran nothing).
//          This is only sound because the union's ids name the file that really ran each case:
//          runner.ts I step 3 maps a classname by its exact rootdir-relative path, and a classname
//          two inputs could own makes the union incomplete (7.1), never a guess (QA-2.2-1: with
//          "the first input wins", tests/test_x.py's failure landed on sub/tests/test_x.py).
//       b. vitest/jest -> own-run (cause "mode-b"). vitest cannot intersect `related` with a file
//          filter, so the member's own spec runs, covering its whole affected set. That run
//          contains exactly the failures the member would see alone.
//   7.4 So every member's final scoped outcome is one of two things. Either it is its own run's
//       outcome, verbatim. Or it is a derived "ran" outcome that judges the same: its spec is
//       the member's own spec, and its notes are the member's plan notes plus
//       "batched: 1 run for <n> requests".
//   7.5 Flaky taint (B-G2). When U had failing ids, unreproduced = U.failingIds minus the ids of
//       every finished own run and every static derivation (7.3a). A derivation counts even for
//       a member that left during the union run, because pytest attribution is exact (QA-2.2-3);
//       an own run counts even when its member left before it returned. The set only shrinks, so
//       it is decided once it is empty or no own run is left (B5.7). If it is then non-empty,
//       some union failure was reproduced by no member's own run, and taintUnreproduced makes
//       EVERY live member's "ran" result complete = false, with the note "batched run failure not
//   reproduced by any request's own run: <ids>". A complete union keeps every id (QA-2.2-11: an
//   id no derivation reproduces taints, whatever its key). Only an incomplete pytest union leaves
//   out an id that names none of its inputs (a classname readResult could not map, runner.ts I
//   step 3): its raw form cannot equal any own run's id, and every member of an incomplete union
//   runs its own spec verbatim (7.1). Per 2.1-T6, complete = false never passes (R4 u12; R2i u10 or u8), and a
//       proven introduced id still rejects (R2i x X- = F r1). The unreproduced id could belong to
//       any member's related set, and for vitest/jest a green own run cannot rule that out.
//
//   P1. Proposed write-set addition in runner.ts (task 2.2.2.a); it enables the cheap path of
//       7.2b. RunResult gains `testsByFile?: Readonly<Record<string, number>>`: the number of
//       tests the report lists for each file key, so that the values sum to total. vitest/jest:
//       assertionResults.length of each suite. pytest: the testcases mapped to each input,
//       without the collection pseudo-cases. Only report sources fill it; the text fallback
//       leaves it undefined. The change is additive, and 2.1's judgeScoped ignores it.
//       Without P1 the coordinator is still correct, but it pays one confirmation run for each
//       guard-sensitive member of a green batch. Implementation delegations usually touch test
//       files, so that would remove most of the saving.
//
// -----------------------------------------------------------------------------------------------
// B8. SHARED RECHECK (S2)
//
//   Only members whose scoped outcome is "ran" with >= 1 failing id and >= 1 failing file take
//   part.
//   1. Pre-decisions for each member, with no spawn (2.1-T4), in 2.1's direct-hook order:
//      ReferenceState "disabled", OR the member's own gate-time runtime.failureRecheck is off ->
//      { kind: "disabled" }; "none" -> { kind: "unusable", cause: "no-reference", reason }.
//      failureRecheck is read from the runtime of the hook that submitted the member, never from
//      the window opener's (QA-2.2-2): a reference captured at dispatch while the setting was on
//      is disabled when the setting is off at the gate (a config reload, or a later
//      router_verify), as the direct hook does.
//   2. "captured" members are grouped by referenceKey(reference): root, commit, and the sorted
//      untracked, tracked and captureReasons entries (capturedAt is excluded). A recheck at one
//      reference proves nothing about another, so ONE recheck is shared per distinct reference,
//      not per batch (deviation D3). These share one reference:
//        - the members of one dispatch (an escalation retry keeps the first reference, and
//          router_verify may name several handles of one dispatch);
//        - captures of the same clean HEAD with the same untracked files.
//      Distinct stash commits never share.
//   3. Rechecks are steps of the B5.5 queue. When a member's recheck turn comes, every member
//      ready at that moment at the same reference joins it (its group, earliest deadline first).
//      A member whose deadline.remaining() is below runtime.recheckMinRemainingMs (2.1's
//      RECHECK_MIN_REMAINING_MS, injected) gets { kind: "skipped-deadline", remainingMs } and
//      leaves its group, as it would alone (2.1-T3): a member whose budget cannot fit its
//      recheck is never passed on a guess.
//   4. A group of one member -> scope.rechecker(command, cwd, its currentTree)(reference, its
//      failingFiles, its own deadline). This is the direct path. (QA-2.2-8, 2.2.3: every recheck
//      forwards the requesting gate's tree snapshot, runtime.currentTree, as 2.1's direct hook
//      does; a shared recheck forwards its first member's.)
//   5. A group of several members:
//        files  = the deduplicated union of their failingFiles;
//        Rg     = a batch deadline over the group (B9);
//        shared = scope.rechecker(first member's command, cwd)(reference, files, Rg).
//      Each member's outcome is deriveSharedRecheck(shared, counts, its failingFiles,
//      its spec.cwd):
//        - approximate, disabled, timed-out, skipped-deadline, and unusable with a
//          reference-level cause (no-reference, materialize-failed, reference-vanished,
//          unreproduced-inputs, runner-unsupported, error) -> the same outcome for every member.
//        - unusable with a run-level cause (incomplete, collection-error, no-tests,
//          rerun-unplannable) -> "split". Another member's files may be the cause: a collection
//          error at the reference, or argv-too-long for the union list. Each member then gets
//          its own recheck (step 4), in deadline order.
//        - exact -> ranFiles and absentFiles are intersected with the member's file keys; the
//          result is filtered to the ids and files with those keys (still complete and without a
//          collection error, as "exact" requires); it is undefined when all of the member's files
//          are absent. Zero-test check, as in 7.2b:
//            with counts, a member whose ran files hold 0 tests at the reference gets unusable
//            "incomplete", because its own rerun would have tripped the rerun zero-test guard
//            (QA-1.3-17);
//            without counts, a member that has ran files but no failing id among them at the
//            reference -> "split".
//   6. Reuse (QA-2.2-3). A member that becomes ready AFTER a recheck ran at its reference (it
//      finished its own run later) first derives its outcome from each recorded outcome at that
//      reference with the rule of step 5; the first answer that is not "split" settles it with
//      no spawn. Only outcomes that hold for any member are recorded: exact, approximate, and
//      unusable "reference-vanished", "unreproduced-inputs" or "runner-unsupported". Never
//      timed-out or skipped-deadline (the deadline of the member that ran it), nor
//      "materialize-failed" (an aborted materialize reports it) or "error" (transient).
//   7. pytest: 2.1's Rechecker returns unusable "runner-unsupported" without spawning (2.1
//      decision 5), so sharing it costs nothing.
//   Recheck calls per window: at most one per distinct reference among the failing members when
//   each later member's failing files are covered by an earlier recheck at its reference, plus
//   split rechecks and rechecks of files no earlier recheck covered (at most one per member, as
//   alone). The plan's "single shared recheck" holds when the members share a reference and a
//   pre-existing failure, the plan's case.
//
// -----------------------------------------------------------------------------------------------
// B9. DEADLINES AND CANCELLATION
//
//   - Each member keeps its own Deadline (request.deadline: one per gate or router_verify call,
//     1.5-13). Nothing extends it.
//   - The batch deadline D = createBatchDeadline(members):
//       remaining()  the largest remaining() among the members not yet settled (0 when none);
//       bound(x)     min(x, remaining());
//       budgetMs     the largest member budget;
//       signal       aborts once every member still attached has aborted, or at dispose.
//     A settled member is released from D, so a requester that is done never keeps the batch
//     alive with its long budget. D has no timer of its own: when the last attached member's
//     signal aborts at its expiry, D aborts too. dispose() removes every listener.
//   - Which deadline bounds what:
//       union planning and the union's hold    D', D cut off where the pooled schedule stops
//                                              fitting (B5.2a, QA-2.2-25)
//       the union run                          D
//       a member's own run                     that member's deadline, exactly as alone
//       a single-member recheck                that member's deadline, exactly as alone
//       a shared recheck                       Rg, D restricted to the group
//   - A member whose signal aborts is settled at once. The result depends on its phase:
//       waiting in the window                  aborted BATCH_REASONS.window
//       union planning or union run            aborted BATCH_REASONS.run (2.1-T2 P5's phrase)
//       queued for its own run                 aborted BATCH_REASONS.attribution
//       its own run is running                 that run's outcome (the executor kills it and
//                                              reports aborted); a "ran" outcome is settled as
//                                              in the next row
//       holding a known outcome (B5.7)         QA-2.2-3: that outcome, never a bare abort. While
//                                              a union failure is still unexplained it is made
//                                              incomplete by taintUnreproduced with those ids
//                                              (never a pass); a needed recheck becomes its
//                                              reference decision, else skipped-deadline
//       final, waiting for its recheck turn    { scoped: its outcome, recheck: its reference
//                                              decision, else skipped-deadline }, as alone
//                                              below the recheck threshold
//       its recheck is running                 { scoped: its outcome, recheck: { kind:
//                                              "timed-out", boundMs: its remaining() when the
//                                              recheck started } }, as 2.1-T4.j reports an
//                                              aborted rerun
//     The member is then released from D, and the batch continues for the others.
//   - Wording (QA-2.2-9). BATCH_REASONS.beforeRun and .run are 2.1's ABORTED_BEFORE_RUN and
//     ABORTED_DURING_RUN, verbatim. A member cut during the union step gets ABORTED_DURING_RUN
//     even while the union still waits for the slot, where alone it would get slot-busy with
//     deadlineCut (u14, SLOT_DEADLINE_REASON): the scope does not expose when its first execute
//     took the hold, and the union IS the member's scoped run. Both are unverifiable (u13, u14).
//     .window and .attribution have no direct-path equivalent: those waits exist only in a batch.
//     QA-2.2-27 (nit, recorded, not changed): the solo phase it was raised against is gone with
//     QA-2.2-23. The same wording applies to the steps that remain: a member cut while a pooled
//     batch plans its union or waits for its hold (step 3) is still in phase run and gets .run,
//     as during the union run, where alone it would get slot-busy (u14); a member cut while it
//     waits behind the union for its own run (mode B) gets .attribution. A member of a split
//     starts its own run at once, in its batch of one, and so never waits in own-wait. Every
//     one of these outcomes is unverifiable (u13), as the direct path's would be.
//   - When all members have aborted, D aborts. The running execute or rechecker kills its tree
//     (exec.ts), and nothing more is spawned: an aborted signal never spawns. The batch then
//     finishes and closes its scope.
//   - A batch that runs longer than one requester's budget costs that requester an unverifiable
//     verdict at its deadline (2.1-T6 R5 u13, or u6 during the recheck). It never makes the
//     requester wait past its deadline.
//   - QA-2.2-17: under the default policy (strictUnverifiable off) such a verdict is accepted, so
//     the batch must not be what runs a member out of budget. W3 keeps each member's floor and
//     the split schedule ahead of it out of the window wait. B5.2a pools the members only when every member's budget
//     covers the worst-case batched schedule ahead of its recheck; otherwise each runs alone
//     (B5.6). W7 removes the window from a lone request altogether. What remains is an
//     estimate's error (B15).
//
// -----------------------------------------------------------------------------------------------
// B10. SLOT DISCIPLINE (S3, QA-1.4-18)
//
//   Each batch has one VerificationScope: runtime.openScope of the first member, with that
//   member's cwd and command as meta. The first execute takes the hold. The union run, the own
//   runs and every recheck then run inside it, one command at a time, and close() follows the
//   last of them. The coordinator never opens a scope while it waits on another (no nesting),
//   and no requester's gate waits for a batch's close. Batches for different keys hold separate
//   slots, but only as far as maxConcurrentVerifications allows (W6). A batch never waits for
//   another batch, so batches cannot deadlock each other. A split (B5.6) opens no scope and hands
//   each member to a batch of one, which holds at most one slot, as the member's direct hook
//   would; it never waits for those batches either.
//   Early-settled members (QA-2.2-5, accepted cost). A member settles as soon as its outcome is
//   final (B5.8) while its batch may still hold the slot for the other members' runs and
//   rechecks. Its gate then goes on to its next S3 check (lintClean, run, ...), which opens its
//   own scope and waits for the slot like any other verification: under
//   maxConcurrentVerifications 1 that wait lasts until the batch closes, bounded by the check's
//   slot wait and the gate deadline, so the check can end slot-busy (u14). It cannot deadlock:
//   the batch never waits on a gate or on another scope, a settled member is released from D
//   and never extends it, and every step of the batch is bounded by a remaining member's
//   deadline. Holding the member until the hold ends would spend the same wait inside testsPass
//   instead, and would give back QA-2.2-3's early settlement. 2.2.3's wiring test asserts the
//   behaviour (deferred by plan), with the order forced (QA-2.2-22). QA-2.2-17 revisits the
//   premise: that next check may end slot-busy behind its own batch where alone it could have run
//   and failed. That stays an accepted residual (B15). The wait is bounded by the batch's
//   remaining steps, which B5.2a and W3 already keep within the members' budgets, and a
//   slot-busy check is unverifiable, never a pass.
//
// -----------------------------------------------------------------------------------------------
// B11. MEMORY AND DISPOSAL
//
//   State:
//     - windows: a Map from key to window, each with <= maxBatchSize members and one timer;
//     - running batches: a Set;
//     - per member: the request, its plan and its resolver;
//     - the last measured run duration per batch key (W3, B5.2a), at most 64 keys (the oldest
//       is dropped), and the number of requests in planning (W7).
//   Everything else is dropped when the member settles or the batch ends. Memory is O(live
//   requests) plus that bounded map, and no window outlives its timer.
//   sweep() is called by the wiring's TTL sweep (2.2.3). It evicts defensively:
//     - windows with no live member;
//     - batches whose members are all settled but whose seam never returned (a hung executor
//       that ignored its signal) for longer than BATCH_STALE_GRACE_MS. D aborted when the last
//       member settled, so the tree was killed that long ago. The coordinator stops tracking the
//       batch and asks its scope to close, which is logged. QA-2.2-19: 2.1's scope closes only
//       once its in-flight seams have returned (deterministic.ts close()), so the slot stays
//       held until the hung seam exits. Nothing else runs beside a tree that may still be alive,
//       which is the safer behaviour, and it is kept.
//   It logs each eviction and returns the number of evictions.
//   The slot is never released before the running tree has exited (QA-2.2-4): runBatch's
//   finally closes the scope after its last seam returned, and an eviction's close waits for
//   the seam too.
//   dispose():
//     1. marks the coordinator disposed (later requests get B2.1);
//     2. clears every window timer;
//     3. settles every pending member with aborted BATCH_REASONS.disposed;
//     4. aborts every batch deadline, which kills the running trees;
//     5. awaits every running batch, that is its in-flight seam (the killed tree's exit) and
//        then its scope close, within one grace of BATCH_STALE_GRACE_MS (one timer, cleared
//        after); a batch still running after that is evicted as by sweep();
//     6. awaits the scope closes within the rest of the same grace (QA-2.2-19). A close still
//        pending after it waits for a hung seam: dispose stops waiting and logs it, and that
//        slot is released when the seam exits.
//   It is idempotent, never rejects, and returns within one grace. The default timers are
//   unref'd, so an open window never keeps the process alive.
//
// -----------------------------------------------------------------------------------------------
// B12. THE EQUIVALENCE PROPERTY AND ITS TEST
//
//   Statement (B-G1): for any set of requests submitted inside one window, and every member R,
//   judge(coordinator(R)) equals judge(direct(R)) on ok, on unverifiable and on the three
//   FailureClassification sets. direct(R) is the one-request path.
//   It holds under three conditions: the runner is deterministic (each file's outcome does not
//   depend on which other files run), no deadline expires, and there is no slot contention.
//   Timing outcomes (slot-busy, timed-out, aborted, skipped-deadline) are outside it, and so are
//   texts (the count in e1, notes).
//   Test (2.2.2.e, test/unit/batch.test.ts): >= 300 cases from a seeded PRNG (mulberry32, as in
//   test/unit/guards.test.ts).
//     - Fake repo: sources S and test files T; related(s) is a subset of T, and every test file
//       relates to itself. Each test file has a test count >= 0 and a failing set, both now and
//       at each reference; some files are absent at a reference. The runner is vitest-like
//       (related) or pytest-like (inputs are tests). Change sets are random and may overlap.
//       References are random too: shared or distinct, captured, none or disabled.
//     - Fake seams, each counting its calls:
//         plan: inputs = the existing changed files; S6 for a trigger file; NoAffected for none.
//         openScope: execute returns the model's RunResult, applies readResult's zero-test guard
//           and fills testsByFile; rechecker returns exact/absent/ran from the model.
//     - direct(R) is the test's own one-request path over the same seams.
//     - judge: until 2.2.3, an oracle of 2.1-T5/T6 written in the test; from 2.2.3 on, 2.1's
//       judgeScoped as well, and both must agree.
//     - Each case asserts: equal judgements; exactly one scope per batch; spawns within the
//       cost model (B13); no leaked timers after dispose (vi.getTimerCount() === 0).
//   A flaky variant adds a failure that appears only in the union run, and asserts B-G2: no
//   member judges ok.
//
// -----------------------------------------------------------------------------------------------
// B13. COST MODEL (spawns through the argv seam, per window of n members)
//
//   green union, P1 present           1 scoped run, +1 for each zero-test-ambiguous member (7.2b)
//   green union, P1 absent            1 + the number of guard-sensitive members
//   pytest, failing, report complete  1 scoped run; rechecks spawn nothing (runner-unsupported)
//   vitest/jest, failing              1 + n scoped runs (mode B), + 1 recheck per distinct
//                                     reference among the failing members when later members'
//                                     files are covered (B8.6), else up to 1 per member
//   split (union inconsistent, or     n scoped runs and n scopes, as without batching (B5.6)
//     the B5.2a deadline check)
//   n = 1                             exactly the direct path (W7: no window wait when alone)
//   The plan's acceptance criterion, "<= 1 scoped run + <= 1 recheck per window", is asserted on
//   the green and pytest paths and with a shared reference. On the vitest/jest failing path the
//   test asserts 1 + n runs and one recheck per distinct reference (deviation D2).
//
// -----------------------------------------------------------------------------------------------
// B14. DEVIATIONS FROM THE PLAN
//
//   D1 The batch key adds file, cwd and the argv template (B3).
//   D2 On a failing vitest/jest union, mode B spends n attribution runs, so the plan's "<= 1
//      scoped run per window" holds on the green and static paths only. Mode B's per-request run
//      is the request's own planScopedRun spec, not "only the failing files": `related` cannot
//      be intersected with a file filter (runner.ts J).
//   D3 One shared recheck per distinct reference, not one per batch (B8.2).
//   D4 The maximum window size is a coordinator option (BATCH_MAX_REQUESTS = 8), not a config
//      key. config.ts and the section 1.4 surface are outside 2.2's write set, and the value
//      only bounds the worst-case slot hold (1 + 8 runs).
//   D5 A guard-sensitive member of a green batch needs per-file counts (P1, runner.ts) or a
//      confirmation run.
//   D6 One coordinator exists per plugin instance, but it receives its runtime per gate
//      (hook(runtime)). A config reload therefore reaches new windows without a new coordinator.
//
// -----------------------------------------------------------------------------------------------
// B15. RESIDUAL RISKS (accepted; QA may challenge)
//
//   - Cross-file state. pytest runs all of the union's files in one process, so a test that
//     pollutes another file's state can change outcomes compared with a run alone. vitest and
//     jest isolate each file by default; a config that turns isolation off carries the same
//     risk. A failure caused by pollution makes the member unverifiable, because pytest failures
//     are never proven introduced (2.1 decision 5). Pollution that hides a failure is a risk the
//     user's own suite run has too.
//   - Flaky tests on the own-run path. A failure that appears only in a member's own run is
//     judged exactly as it would be alone (2.1-T11's flaky row).
//   - Distinct stash commits never share a recheck, even when their trees are identical. A
//     tree-hash key would need git at capture time, which is out of scope.
//   - A config reload in the middle of a window keeps the opener's window length and scope
//     options.
//   - Deadline estimates (QA-2.2-17, B-G7). W3 and B5.2a rely on the key's last measured run
//     duration, with a recheck estimated as one more run and a union as one run per member.
//       - Before the first measured run of a key in a plugin instance, e is 0: the first
//         concurrent window of a key pools any member that has its floor, and a failing
//         vitest/jest union can still cost a tight member its recheck there (the QA's R5 with
//         every gate in one window). A lone gate (W7), or any earlier batch of the key, measures
//         e. The first window of a key was not made to split by default: that would give up the
//         saving of every first fan-out.
//       - A member's own run slower than the last measured run, or a recheck slower than a run
//         (materialize), can exceed the estimate by more than BATCH_RESERVE_MARGIN_MS.
//       - The first run of a scope includes its slot wait. That only overstates e, and costs
//         batching, not verdicts, until the next measurement. A union's run also measures e, and
//         a union is at least as long as one own run, so it too only overstates it.
//       - Union planning and the union's slot wait are bounded by D' (B5.2a); a planner step that
//         does not honour its deadline's bound can still overrun it, and the check after planning
//         then splits a batch that is already late.
//   - The window itself (W3). Under a first-come slot, a request that queues while a member waits
//     in its window is served before that member, where the member's direct hook would have
//     queued first. W3 keeps the member's split schedule out of the wait, but not the runs of such
//     later requests. The wait is bounded by batchWindowMs (at most a tenth of the gate budget,
//     QA-2.2-21), and W7 removes it when nothing else is in flight in the coordinator.
//   - Serial runs under one hold. With maxConcurrentVerifications > 1, the direct path could run
//     members in parallel where a batch runs their own runs and rechecks one at a time. B5.2a
//     pools only when each member's worst case fits its own budget, whatever the slot count, and
//     a split runs every member in its own scope, in parallel as far as the slots allow.
//   - QA-2.2-5 (B10): an early-settled member's next S3 check may end slot-busy behind its own
//     batch where alone it could have run.
//
// -----------------------------------------------------------------------------------------------
// B16. IMPLEMENTATION TASKS (each <= ~20 tool calls; commit and push each one green)
//
//   2.2.2 runs on vrb/p22, in parallel with 2.1.2-2.1.6. It does not touch wiring.ts, index.ts or
//   deterministic.ts. Tests run scoped: npx vitest run test/unit/batch.test.ts.
//   2.2.2.a runner.ts P1, only with the orchestrator's approval of the write-set addition;
//           otherwise skip it and keep the confirmation-run path. readResult fills
//           RunResult.testsByFile for JSON and junit reports. Tests in test/unit/runner.test.ts
//           on the Spike C reports in test/fixtures/runner/reports: the sum equals total, the
//           text fallback leaves it undefined, and pytest pseudo-cases are excluded.
//   2.2.2.b batch.ts pure helpers: envSignature, argvTemplate, batchKey, referenceKey,
//           unionChangedFiles, isGuardSensitive, fileKeyOf, attributeUnion, deriveSharedRecheck,
//           taintUnreproduced and createBatchDeadline. Table tests for each:
//             - win32 and posix keys;
//             - relative ChangedPath resolution;
//             - every attributeUnion row;
//             - every deriveSharedRecheck kind and cause;
//             - D's release, abort and dispose, with no listener left behind.
//   2.2.2.c createBatchCoordinator core: B2 bypasses, W1-W6, B5 steps 1-4 and 6, B9 and B11, with
//           injected timers and clock. Tests (fake timers):
//             - 5 requests -> 1 union run and 5 results;
//             - different keys -> separate scopes;
//             - window 0 -> direct;
//             - an arrival during a running batch -> the next window;
//             - max size closes the window early; so does W3;
//             - an abort in the window;
//             - one member aborts mid-run -> the others still get results;
//             - all abort -> the execute seam sees an aborted signal, and nothing is spawned
//               afterwards;
//             - dispose -> 0 timers, pending requests settled;
//             - the hook never rejects when a seam throws.
//   2.2.2.d attribution and recheck: B5 steps 5 and 7-9, B7 and B8. Tests:
//             - the union fails in a file of one member -> only that member's own run fails;
//             - a failing file shared by two members -> both are rechecked;
//             - a pre-existing failure shared by all members with one reference -> one recheck,
//               and every member derives "exact";
//             - distinct references -> one recheck each;
//             - a run-level unusable recheck -> split;
//             - skipped-deadline below the threshold;
//             - the flaky taint;
//             - pytest static attribution, with and without counts;
//             - deduplication of an overlapping change set.
//   2.2.2.e the property test (B12), coverage >= 90% of batch.ts lines and branches, and the QA
//           report section in phase-2.2.md.
//   2.2.3 starts after 2.1 is merged into vrb/wave-2. It writes wiring.ts, whose only writer it is
//   at that point.
//   2.2.3.a wiring.ts:
//             - one coordinator per plugin instance (createBatchCoordinator);
//             - per gate, runtime = {
//                 direct: 2.1's createDirectTestsPassHook(...),
//                 plan: planScopedRun with the gate's PlannerFs, a TestSearchSeam bound to the
//                   given deadline, the budget and the host,
//                 openScope: 2.1's scope opener,
//                 batchWindowMs: budget.batchWindowMs,
//                 recheckMinRemainingMs: RECHECK_MIN_REMAINING_MS };
//             - buildGateDeps' testsPass hook becomes coordinator.hook(runtime);
//             - the existing TTL sweep also calls coordinator.sweep();
//             - plugin disposal, if the host offers one, calls dispose().
//           batch.ts: replace the private idFileKey with 2.1's fileKeyOfId.
//           Done (2.2.3): wiring.ts creates the coordinator in createVerificationWiring. With
//           batchWindowMs > 0, buildGateDeps' testsPass is coordinator.hook(runtime), and 2.1's
//           direct hook stays as runtime.direct; with batchWindowMs <= 0 the direct hook is used
//           as is. The runtime shares the direct hook's opener, PlannerFs and budget, and adds
//           the gate-time failureRecheck and the gate's tree (QA-2.2-8: BatchRuntime.currentTree,
//           OpenBatchScope). index.ts's idle-TTL sweeper calls sweepVerification() (the
//           coordinator's sweep), and plugin dispose awaits disposeVerification().
//           QA-2.2-21: the runtime's batchWindowMs is effectiveBatchWindowMs(budget), that is
//           min(batchWindowMs, gateBudgetMs / 10): 2000 ms at the defaults.
//   2.2.3.b test/unit/batch-wiring.test.ts, with 5 concurrent testsPass gates through
//           buildGateDeps:
//             - the argv seam sees 1 scoped run per window (+ <= 1 recheck with a shared
//               reference) on the green and pytest paths, and 1 + n on the vitest failing path;
//             - verdicts equal those with batchWindowMs: 0;
//             - the B12 property with 2.1's judgeScoped next to the oracle;
//             - one slot acquisition per batch, never nested.
// ===============================================================================================

import { posix, win32 } from "node:path";
import type { PluginLogger } from "../router/logger";
import { fileKeyOfId } from "./baseline";
import type { TreeSnapshot } from "./dispatch";
import type { DispatchReference } from "./reference";
import type { ChangedPath, RunResult, ScopedSpec, ScopingPlan } from "./runner";
import type {
  Deadline,
  OpenVerificationScope,
  Rechecker,
  RecheckOutcome,
  ScopedOutcome,
  TestsPassHook,
  TestsPassRequest,
  TestsPassRun,
  VerificationScope,
} from "./types";

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

/** W2: the default maximum number of members in one window (deviation D4). */
export const BATCH_MAX_REQUESTS = 8;

/** B11: how long sweep() tolerates a batch whose members are all settled but whose seam never returned. */
export const BATCH_STALE_GRACE_MS = 60_000;

/**
 * W3 and B5.2a (QA-2.2-17): the margin a member keeps on top of its recheck threshold and the
 * key's run estimate. It covers union planning and scheduling, the overhead the batch adds.
 */
export const BATCH_RESERVE_MARGIN_MS = 1_000;

/** B11: at most this many batch keys keep a measured run duration (the oldest is dropped). */
const DURATION_KEYS_MAX = 64;

/**
 * Stable ScopedOutcome "aborted" reasons (B2, B9). They reach the orchestrator through 2.1-T7 u13.
 * beforeRun and run are 2.1's ABORTED_BEFORE_RUN and ABORTED_DURING_RUN, verbatim (QA-2.2-9).
 */
export const BATCH_REASONS = {
  disposed: "verification coordinator disposed",
  beforeRun: "gate budget exhausted before the scoped run",
  window: "gate budget exhausted waiting for the batch window",
  run: "gate budget exhausted during the scoped run",
  attribution: "gate budget exhausted during batch attribution",
} as const;

// ---------------------------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------------------------

/** What the planner needs from a request (B2.5, B6). */
export type BatchPlanInput = Pick<TestsPassRequest, "command" | "cwd" | "changedFiles">;

/**
 * planScopedRun bound to one deadline. The wiring (2.2.3) supplies the PlannerFs with the native
 * realpath, a TestSearchSeam whose calls use deadline.bound(10_000) and deadline.signal, the
 * RunnerBudget and the host. It may reject; the coordinator turns a rejection into a ScopedOutcome
 * "error" (B2.5).
 */
export type BatchPlanner = (input: BatchPlanInput, deadline: Deadline) => Promise<ScopingPlan>;

/**
 * A VerificationScope whose rechecker also takes the gate's current tree snapshot, as 2.1's
 * CheckScope does (QA-2.2-8). A two-argument rechecker (any OpenVerificationScope) still fits.
 */
export interface BatchScope extends VerificationScope {
  rechecker(command: string, cwd: string, currentTree?: TreeSnapshot): Rechecker;
  /**
   * 2.1's CheckScope.hold: the scope's one hold, taken without running anything; true when held
   * (B5.3, QA-2.2-25). A scope without it takes its hold on the union's execute, under D.
   */
  hold?(deadline: Deadline): Promise<boolean>;
}

/** runtime.openScope: 2.1's scope opener, or any OpenVerificationScope. */
export type OpenBatchScope = (meta: Parameters<OpenVerificationScope>[0]) => BatchScope;

/** The seams and settings of one gate (deviation D6). The window opener's values apply to its batch. */
export interface BatchRuntime {
  /** 2.1's one-request hook, used for testScope "full", a crossLinkRoot request and batchWindowMs <= 0 (B2). */
  readonly direct: TestsPassHook;
  readonly plan: BatchPlanner;
  readonly openScope: OpenBatchScope;
  /** enforcement.verify.batchWindowMs (VerifyBudget). <= 0 disables batching. */
  readonly batchWindowMs: number;
  /** 2.1's RECHECK_MIN_REMAINING_MS (B8.3), injected so this module has no runtime import of deterministic.ts. */
  readonly recheckMinRemainingMs: number;
  /**
   * The gate-time enforcement.verify.failureRecheck (VerifyBudget), read per request (B8.1,
   * QA-2.2-2): off turns every reference, even a captured one, into "disabled", exactly as 2.1's
   * direct hook decides at the gate.
   */
  readonly failureRecheck: boolean;
  /**
   * QA-2.2-8 (2.2.3): the submitting gate's current tree snapshot, kept per request and forwarded
   * to its recheck as 2.1's direct hook does (materialize's same-repository guard). A shared
   * recheck forwards its first member's, with that member's command and cwd: every member of a
   * group shares the reference, and so its root (B8.2). Absent: materialize gets undefined.
   */
  readonly currentTree?: TreeSnapshot;
}

/** Timer seam for the window timers (W1). */
export interface BatchTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface BatchCoordinatorOptions {
  /** W2. Default BATCH_MAX_REQUESTS; a value that is not a safe integer >= 1 means 1 (no batching). */
  readonly maxBatchSize?: number;
  /** Path-key folding (case-insensitive on win32). Default: process.platform. */
  readonly platform?: NodeJS.Platform;
  /** Clock for W3 and B11. Default: Date.now. */
  readonly now?: () => number;
  /** Default: the global setTimeout/clearTimeout, with each handle unref'd (B11). */
  readonly timers?: BatchTimers;
  /** A logger whose warn throws is dropped for the coordinator's life (B-G5, QA-2.2-10). */
  readonly logger?: Pick<PluginLogger, "warn">;
  /**
   * W7 (QA-2.2-17 a). Default true: a window closes as soon as nothing else is in flight in the
   * coordinator. false keeps only the timed close, for tests of the W1-W6 mechanics.
   */
  readonly idleClose?: boolean;
}

/** Live state and cumulative counters, for tests and QA (B11, B13). */
export interface BatchStats {
  readonly openWindows: number;
  readonly runningBatches: number;
  /** Requests submitted to a window and not yet settled. */
  readonly pendingRequests: number;
  /** Cumulative since creation. */
  readonly unionRuns: number;
  readonly ownRuns: number;
  readonly rechecks: number;
  readonly splits: number;
  readonly taints: number;
}

export interface BatchCoordinator {
  /** The S5 hook for one gate's runtime. It is exactly a TestsPassHook and never rejects (B-G5). */
  hook(runtime: BatchRuntime): TestsPassHook;
  /** B11 defensive eviction. Returns the number of windows and batches evicted. */
  sweep(): number;
  stats(): BatchStats;
  /** B11. Idempotent; never rejects. */
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Coordinator (tasks 2.2.2.c and 2.2.2.d)
// ---------------------------------------------------------------------------------------------

/**
 * Where a member stands; B9's table maps each phase to what an abort settles it with.
 *   window        waiting in a window (W5);
 *   run           union planning or the union run (B5 steps 2-4);
 *   own-wait      queued for its own run (B5.5);
 *   own-run       its own run is running: the executor kills it and reports (B9);
 *   held          its outcome is known but a union failure is still unexplained (B5.7);
 *   recheck-wait  its outcome is final and it waits for its recheck turn (B5.8);
 *   recheck       its recheck is running (B8).
 */
type MemberPhase = "window" | "run" | "own-wait" | "own-run" | "held" | "recheck-wait" | "recheck";

type RanOutcome = Extract<ScopedOutcome, { readonly kind: "ran" }>;

/** A member whose final outcome waits for a recheck at a captured reference (B5.8). */
interface Ready {
  readonly scoped: RanOutcome;
  readonly reference: DispatchReference;
  /** referenceKey(reference): the group and the reuse key (B8.2, B8.6). */
  readonly key: string;
}

interface Member {
  readonly request: TestsPassRequest;
  /** The submitting gate's runtime: a member that runs alone (B5.6) runs with it, as its direct hook would. */
  readonly runtime: BatchRuntime;
  /** The member's own planScopedRun spec. */
  readonly spec: ScopedSpec;
  /** B8.1 (QA-2.2-2): the submitting gate's runtime.failureRecheck, not the window opener's. */
  readonly failureRecheck: boolean;
  /** QA-2.2-8: the submitting gate's runtime.currentTree, forwarded to the member's recheck. */
  readonly currentTree: TreeSnapshot | undefined;
  /** W3 (QA-2.2-17): the submitting gate's runtime.recheckMinRemainingMs, for its reserve. */
  readonly recheckMinRemainingMs: number;
  /** Arrival order: the tie-break of every deadline ordering, and the order of a split (B5.6). */
  readonly seq: number;
  phase: MemberPhase;
  settled: boolean;
  window: BatchWindow | undefined;
  batch: Batch | undefined;
  /** The member's scoped outcome once known (B5 steps 4-7). */
  scoped: ScopedOutcome | undefined;
  /** Set in phase recheck-wait (B5.8). */
  ready: Ready | undefined;
  /** B9: its remaining() when its recheck started, reported if it aborts while it runs. */
  recheckBoundMs: number;
  readonly resolve: (run: TestsPassRun) => void;
  readonly onAbort: () => void;
}

interface BatchWindow {
  readonly key: string;
  /** The opener's runtime (W1, D6). */
  readonly runtime: BatchRuntime;
  /** Set at opening (W1). It never moves later (W2); a member's reserve can move it earlier (W3). */
  closeAt: number;
  readonly members: Member[];
  timer: unknown;
  closed: boolean;
}

interface Batch {
  readonly key: string;
  readonly runtime: BatchRuntime;
  /** Fixed at close, in arrival order (W4). */
  readonly members: readonly Member[];
  /** D (B9). */
  readonly deadline: BatchDeadline;
  /** Rg of the shared recheck in flight (B8.5). */
  group: BatchDeadline | undefined;
  scope: BatchScope | undefined;
  closing: Promise<void> | undefined;
  /** When the last member settled (B11 sweep). */
  settledAt: number | undefined;
  /** B7.5: the failing ids of a "ran" union; empty when the union was green or did not run. */
  unionIds: readonly string[];
  /** B7.5: union ids some finished own run or static derivation reproduces (it only grows). */
  readonly reproduced: Set<string>;
  /** B5.7: no taint can change a member's outcome anymore. */
  final: boolean;
  /** B8.6: recheck outcomes that hold for any member at the same reference, by referenceKey. */
  readonly rechecked: Map<string, RecheckOutcome[]>;
  /** runBatch's promise: it ends after the last seam returned, and closes the scope (B11, QA-2.2-4). */
  run: Promise<void> | undefined;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function abortedRun(reason: string): TestsPassRun {
  return { scoped: { kind: "aborted", reason }, recheck: undefined };
}

function errorRun(reason: string): TestsPassRun {
  return { scoped: { kind: "error", reason }, recheck: undefined };
}

/** 2.1-T2 P7: a recheck is attempted for a "ran" outcome with >= 1 failing id and >= 1 failing file. */
function needsRecheck(scoped: ScopedOutcome): scoped is RanOutcome {
  return scoped.kind === "ran" && scoped.result.failingIds.length > 0 && scoped.result.failingFiles.length > 0;
}

/** Deadline order (B5.5, B8.3): the least remaining first, then arrival order. */
function byDeadline(a: Member, b: Member): number {
  return a.request.deadline.remaining() - b.request.deadline.remaining() || a.seq - b.seq;
}

/**
 * A member's own deadline that also aborts with `kill` (the batch deadline D, which aborts at
 * dispose or when every member is gone), so that dispose() kills own runs and single rechecks too
 * (B11.4). While the member is attached to D, D aborts only at dispose or after the member's own
 * signal, so the result bounds exactly as the member's deadline alone.
 */
function linkDeadline(base: Deadline, kill: AbortSignal): { readonly deadline: Deadline; unlink(): void } {
  const controller = new AbortController();
  const onAbort = () => {
    unlink();
    controller.abort();
  };
  const unlink = () => {
    base.signal.removeEventListener("abort", onAbort);
    kill.removeEventListener("abort", onAbort);
  };
  if (base.signal.aborted || kill.aborted) controller.abort();
  else {
    base.signal.addEventListener("abort", onAbort, { once: true });
    kill.addEventListener("abort", onAbort, { once: true });
  }
  const remaining = () => (controller.signal.aborted ? 0 : base.remaining());
  return {
    deadline: { budgetMs: base.budgetMs, remaining, bound: (ownBudgetMs) => Math.min(ownBudgetMs, remaining()), signal: controller.signal },
    unlink,
  };
}

/** B11: the global timers, each handle unref'd so that an open window never keeps the process alive. */
const defaultTimers: BatchTimers = {
  setTimeout(callback, ms) {
    const handle = setTimeout(callback, ms);
    handle.unref();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as Parameters<typeof clearTimeout>[0]);
  },
};

/** One coordinator per plugin instance (2.2.3). */
export function createBatchCoordinator(options: BatchCoordinatorOptions = {}): BatchCoordinator {
  const requestedSize = options.maxBatchSize ?? BATCH_MAX_REQUESTS;
  const maxBatchSize = Number.isSafeInteger(requestedSize) && requestedSize >= 1 ? requestedSize : 1;
  const platform = options.platform ?? process.platform;
  const now = options.now ?? (() => Date.now());
  const timers = options.timers ?? defaultTimers;
  const idleClose = options.idleClose ?? true;
  let logger = options.logger;

  const windows = new Map<string, BatchWindow>();
  const running = new Set<Batch>();
  const closing = new Set<Promise<void>>();
  /** QA-2.2-17: the last measured scoped-run duration of each batch key (bounded, B11). */
  const durations = new Map<string, number>();
  const counters = { unionRuns: 0, ownRuns: 0, rechecks: 0, splits: 0, taints: 0 };
  let disposed = false;
  let pending = 0;
  let arrivals = 0;
  /** W7: requests between arrival and their window (or their planning outcome). */
  let planning = 0;

  /**
   * B-G5 (QA-2.2-10): logging never throws into the coordinator. A logger that throws is dropped
   * for the coordinator's life, so it cannot reject runBatch, a scope close or dispose().
   */
  const warn = (text: string, extra?: Record<string, unknown>): void => {
    const current = logger;
    if (current === undefined) return;
    try {
      current.warn(text, extra);
    } catch {
      logger = undefined;
    }
  };
  /** The members a batch still answers for: a split (B5.6) hands each member to a batch of its own. */
  const live = (b: Batch) => b.members.filter((m) => !m.settled && m.batch === b);

  // -- settlement ------------------------------------------------------------------------------

  function settle(m: Member, run: TestsPassRun): void {
    if (m.settled) return;
    m.settled = true;
    pending--;
    m.request.deadline.signal.removeEventListener("abort", m.onAbort);
    const b = m.batch;
    if (b !== undefined) {
      // B9: a settled member no longer keeps the batch alive. Two members may share one Deadline
      // (one router_verify call naming several handles): it is released with the last of them.
      const deadline = m.request.deadline;
      if (!b.members.some((x) => !x.settled && x.request.deadline === deadline)) {
        b.group?.release(deadline);
        b.deadline.release(deadline);
      }
      if (b.members.every((x) => x.settled)) b.settledAt = now();
    }
    m.resolve(run);
  }

  /** B9's table. */
  function onAbort(m: Member): void {
    if (m.settled) return;
    switch (m.phase) {
      case "window":
        leaveWindow(m);
        settle(m, abortedRun(BATCH_REASONS.window));
        return;
      case "run":
        settle(m, abortedRun(BATCH_REASONS.run));
        return;
      case "own-wait":
        settle(m, abortedRun(BATCH_REASONS.attribution));
        return;
      case "own-run":
        // The executor kills the run on the member's signal and reports it (runOwn settles).
        return;
      case "held":
      case "recheck-wait":
        // QA-2.2-3: its outcome is known, so it is never reported as a bare abort.
        if (m.batch !== undefined) settleLate(m.batch, m);
        return;
      case "recheck":
        if (m.ready !== undefined) settle(m, { scoped: m.ready.scoped, recheck: { kind: "timed-out", boundMs: m.recheckBoundMs } });
        return;
    }
  }

  // -- windows (B4) ----------------------------------------------------------------------------

  function leaveWindow(m: Member): void {
    const w = m.window;
    if (w === undefined) return;
    m.window = undefined;
    const i = w.members.indexOf(m);
    if (i >= 0) w.members.splice(i, 1);
    // W5: a window left empty clears its timer and is deleted.
    if (w.members.length === 0 && !w.closed) {
      w.closed = true;
      timers.clearTimeout(w.timer);
      if (windows.get(w.key) === w) windows.delete(w.key);
    }
  }

  /** QA-2.2-17: the key's last measured scoped-run duration, 0 before the first. */
  function estimate(key: string): number {
    return durations.get(key) ?? 0;
  }

  /** Records a run's duration and applies the new estimate to the key's open window (W3). */
  function noteDuration(key: string, ms: number): void {
    durations.delete(key);
    durations.set(key, Math.max(0, ms));
    if (durations.size > DURATION_KEYS_MAX) {
      const oldest = durations.keys().next();
      if (oldest.done !== true) durations.delete(oldest.value);
    }
    const w = windows.get(key);
    if (w !== undefined) fitWindow(w);
  }

  /**
   * W3 (QA-2.2-17 b): what a member keeps besides its runs: its recheck threshold when it can
   * recheck at all (failureRecheck on and a captured reference), plus BATCH_RESERVE_MARGIN_MS.
   */
  function floorOf(m: Member): number {
    const rechecks = m.failureRecheck && m.request.reference.kind === "captured";
    return (rechecks ? m.recheckMinRemainingMs : 0) + BATCH_RESERVE_MARGIN_MS;
  }

  /**
   * W3 (QA-2.2-17 b, QA-2.2-24): the window closes no later than the moment some member would be
   * left with less than the schedule it may then run: a split (B5.6) where, on one slot, every
   * member that joined before it runs and rechecks first. For the member at arrival index k that
   * is its floor plus e x (2k + 1). The close time only ever moves earlier (W2).
   */
  function fitWindow(w: BatchWindow): void {
    if (w.closed) return;
    const t = now();
    const e = estimate(w.key);
    let closeAt = w.closeAt;
    let k = 0;
    for (const m of w.members) {
      if (m.settled) continue;
      closeAt = Math.min(closeAt, t + m.request.deadline.remaining() - floorOf(m) - e * (2 * k + 1));
      k++;
    }
    if (closeAt <= t) {
      closeWindow(w);
      return;
    }
    if (closeAt >= w.closeAt) return;
    w.closeAt = closeAt;
    timers.clearTimeout(w.timer);
    w.timer = timers.setTimeout(() => closeWindow(w), closeAt - t);
  }

  /**
   * W7 (QA-2.2-17 a, QA-2.2-18): when no request is planning and no batch is running, nothing
   * can join an open window and the slot is free, so every open window closes now. A lone request
   * therefore never waits; requests that arrive while a batch runs gather in the next window.
   */
  function closeIdle(): void {
    if (!idleClose || planning > 0 || running.size > 0) return;
    for (const w of [...windows.values()]) closeWindow(w);
  }

  function join(runtime: BatchRuntime, request: TestsPassRequest, spec: ScopedSpec): Promise<TestsPassRun> {
    const key = batchKey(spec, platform);
    return new Promise<TestsPassRun>((resolve) => {
      const member: Member = {
        request,
        runtime,
        spec,
        failureRecheck: runtime.failureRecheck,
        currentTree: runtime.currentTree,
        recheckMinRemainingMs: runtime.recheckMinRemainingMs,
        seq: arrivals++,
        phase: "window",
        settled: false,
        window: undefined,
        batch: undefined,
        scoped: undefined,
        ready: undefined,
        recheckBoundMs: 0,
        resolve,
        onAbort: () => onAbort(member),
      };
      let w = windows.get(key);
      if (w === undefined) {
        // W1: the close time is fixed now, with the opener's window length.
        const opened: BatchWindow = { key, runtime, closeAt: now() + runtime.batchWindowMs, members: [], timer: undefined, closed: false };
        opened.timer = timers.setTimeout(() => closeWindow(opened), runtime.batchWindowMs);
        windows.set(key, opened);
        w = opened;
      }
      member.window = w;
      w.members.push(member);
      pending++;
      request.deadline.signal.addEventListener("abort", member.onAbort, { once: true });
      // W2 (size), W3 (the members' reserves) and W7 (nothing else in flight).
      if (w.members.length >= maxBatchSize) closeWindow(w);
      else fitWindow(w);
      closeIdle();
    });
  }

  /** W2, W4: close, leave the key map before anything asynchronous, and start the batch. */
  function closeWindow(w: BatchWindow): void {
    if (w.closed) return;
    w.closed = true;
    timers.clearTimeout(w.timer);
    if (windows.get(w.key) === w) windows.delete(w.key);
    const members = w.members.filter((m) => !m.settled);
    if (members.length === 0) return;
    startBatch(w.key, w.runtime, members);
  }

  /** A batch over `members` (W4), or a member's batch of one (B5.1, B5.6). */
  function startBatch(key: string, runtime: BatchRuntime, members: readonly Member[]): void {
    const b: Batch = {
      key,
      runtime,
      members,
      deadline: createBatchDeadline(members.map((m) => m.request.deadline)),
      group: undefined,
      scope: undefined,
      closing: undefined,
      settledAt: undefined,
      unionIds: [],
      reproduced: new Set(),
      final: false,
      rechecked: new Map(),
      run: undefined,
    };
    for (const m of members) {
      m.window = undefined;
      m.batch = b;
      // B5.1: a batch of one runs the member's own spec at once.
      m.phase = members.length === 1 ? "own-wait" : "run";
    }
    running.add(b);
    b.run = runBatch(b);
  }

  // -- the batch (B5) --------------------------------------------------------------------------

  async function runBatch(b: Batch): Promise<void> {
    try {
      await runSteps(b);
    } catch (e) {
      // B-G5: fail closed for every member the failure affects.
      warn("verify batch: internal failure", { error: message(e) });
      for (const m of b.members) if (m.batch === b) settle(m, errorRun(`verification batch failed: ${message(e)}`));
    } finally {
      // A member handed to a batch of its own (B5.6) is that batch's to settle.
      for (const m of b.members) if (m.batch === b) settle(m, errorRun("verification batch ended without an outcome"));
      running.delete(b);
      b.group?.dispose();
      b.deadline.dispose();
      void closeScope(b);
      // W7: this batch no longer keeps the next windows waiting.
      closeIdle();
    }
  }

  async function runSteps(b: Batch): Promise<void> {
    const first = b.members[0];
    let unionSpec: ScopedSpec | undefined;
    if (b.members.length === 1) {
      queueOwn([first]);
    } else {
      // Step 2a (QA-2.2-17 c, QA-2.2-23): the batch pools only when every member's budget covers
      // the batched schedule. Otherwise every member runs alone (step 6), with its own scope.
      if (!poolFits(b)) {
        dissolve(b, "the members' budgets cannot cover a batched run");
        return;
      }
      // Step 2, bounded by the pooled schedule (QA-2.2-25): planning is not measured, so the check
      // repeats once it is done.
      const planned = await planUnion(b, live(b), untilPoolShort(b));
      if (b.deadline.signal.aborted) return;
      if (typeof planned === "string") {
        dissolve(b, planned);
        return;
      }
      if (!poolFits(b)) {
        dissolve(b, "union planning left a member short of the batched schedule");
        return;
      }
      unionSpec = planned;
    }
    // Everyone is gone, or the coordinator was disposed: open nothing.
    if (b.deadline.signal.aborted) return;

    // Step 3. Its first execute is the union under D, or a batch of one's own run under its own
    // deadline: the hold is never taken under another member's deadline (QA-2.2-23).
    const scope = b.runtime.openScope({ cwd: first.request.cwd, command: first.request.command });
    b.scope = scope;
    if (unionSpec !== undefined && scope.hold !== undefined) {
      // QA-2.2-25: the slot wait is the other unmeasured part of the batched schedule. The hold is
      // taken first, and waits only while the pooled schedule still fits; after that the members
      // run alone, and each still has what its split schedule needs (W3).
      const held = await scope.hold(untilPoolShort(b));
      if (b.deadline.signal.aborted) return;
      if (!held || !poolFits(b)) {
        void closeScope(b);
        dissolve(b, held ? "the slot wait left a member short of the batched schedule" : "the slot was not free in time for a batched run");
        return;
      }
    }

    // Step 4.
    if (unionSpec !== undefined) {
      counters.unionRuns++;
      const union = await execute(b.key, scope, unionSpec, b.deadline);
      switch (union.kind) {
        case "ran":
          attribute(b, union);
          break;
        case "slot-busy":
        case "aborted":
          for (const m of live(b)) settle(m, { scoped: union, recheck: undefined });
          return;
        default:
          queueOwn(live(b));
      }
    }

    // Steps 5, 7 and 8 (QA-2.2-3).
    await drain(b, scope);
  }

  /**
   * B5.5 (QA-2.2-3): one queue under the hold, one command at a time, earliest deadline first. A
   * member's recheck runs as soon as its outcome is final, before the own runs of members with
   * more time left; nothing waits for a step it does not need.
   */
  async function drain(b: Batch, scope: BatchScope): Promise<void> {
    for (;;) {
      advance(b);
      const next = live(b)
        .filter((m) => m.phase === "own-wait" || m.phase === "recheck-wait")
        .sort(byDeadline)[0];
      if (next === undefined) return;
      if (next.phase === "own-wait") await runOwn(b, scope, next);
      else await recheckGroup(b, scope, next);
    }
  }

  function queueOwn(members: readonly Member[]): void {
    for (const m of members) m.phase = "own-wait";
  }

  /**
   * Step 6 (QA-2.2-23): the batch splits. Every live member runs alone as a batch of one (B5.1),
   * with its own gate's runtime: its own scope, whose hold it takes under its own deadline, its own
   * run and its own recheck. That is its direct path, so no member's slot wait, run or recheck
   * depends on another member's budget. The batches start in arrival order, the order in which the
   * members' direct hooks would have queued for the slot. This batch opened no scope, so no hold
   * is shared or nested; each batch of one holds at most one, as its direct hook would.
   */
  function dissolve(b: Batch, cause: string): void {
    counters.splits++;
    warn("verify batch: split into own runs", { members: b.members.length, cause });
    for (const m of live(b).sort((x, y) => x.seq - y.seq)) startBatch(b.key, m.runtime, [m]);
  }

  /**
   * B5.2a (QA-2.2-17 c, QA-2.2-25). How long the batch can still go on before some member's budget
   * no longer covers the worst case of the batched schedule ahead of its recheck: the union run,
   * every member's own run (mode B; a member can be held until the last of them, B5.7) and one
   * recheck for each member ahead of it in deadline order. Each own run and recheck is estimated
   * at e, the key's last measured duration. The union of n members is priced at n x e: it runs
   * each of the members' related test files once, where their own runs run each at least once,
   * so it is never priced as one member's run (QA-2.2-25). Before the first measurement e is 0
   * and only the floor counts (W3). Negative: the members no longer fit.
   */
  function poolSlack(b: Batch): number {
    const e = estimate(b.key);
    const order = live(b).sort(byDeadline);
    const n = order.length;
    let slack = Number.POSITIVE_INFINITY;
    order.forEach((m, i) => {
      slack = Math.min(slack, m.request.deadline.remaining() - floorOf(m) - e * (2 * n + i));
    });
    return slack;
  }

  function poolFits(b: Batch): boolean {
    return poolSlack(b) >= 0;
  }

  /**
   * QA-2.2-25: D, cut off where the pooled schedule stops fitting (poolSlack runs out). It has no
   * timer: remaining() and bound() end there, and its signal is D's. Union planning and the
   * union's slot wait run under it, so each ends while a split still fits every member (W3's
   * split schedule is shorter than the pooled one by at least e).
   */
  function untilPoolShort(b: Batch): Deadline {
    const end = now() + Math.max(0, poolSlack(b));
    const remaining = () => Math.max(0, Math.min(b.deadline.remaining(), end - now()));
    return { budgetMs: b.deadline.budgetMs, remaining, bound: (ownBudgetMs) => Math.min(ownBudgetMs, remaining()), signal: b.deadline.signal };
  }

  /** B6 and the step-2 consistency checks over the members. Returns the union spec, or the cause of a split. */
  async function planUnion(b: Batch, pooled: readonly Member[], deadline: Deadline): Promise<ScopedSpec | string> {
    const changes: BatchMemberChanges[] = [];
    for (const m of pooled) {
      const changedFiles = m.request.changedFiles;
      if (changedFiles === "unavailable") return "a member's change set is unavailable";
      changes.push({ cwd: m.request.cwd, changedFiles });
    }
    const first = pooled[0];
    let plan: ScopingPlan;
    try {
      plan = await b.runtime.plan(
        { command: first.request.command, cwd: first.request.cwd, changedFiles: unionChangedFiles(changes, platform) },
        deadline,
      );
    } catch (e) {
      return `union planning failed: ${message(e)}`;
    }
    if ("noAffected" in plan) return "the union plan found nothing to run";
    if ("unverifiable" in plan) return `the union cannot be scoped (${plan.code})`;
    if (batchKey(plan, platform) !== b.key) return "the union plan runs a different command";
    const want = new Set(pooled.flatMap((m) => m.spec.inputs.map((f) => fold(f, platform))));
    const got = new Set(plan.inputs.map((f) => fold(f, platform)));
    if (want.size !== got.size || [...want].some((k) => !got.has(k))) return "the union plan's inputs differ from the members' inputs";
    return plan;
  }

  /**
   * B7 for every member after a "ran" union, with the union's per-file counts (P1). A member
   * marked own-run queues for its own spec (B5.5: mode B, or a confirmation run); a derived member
   * holds its outcome until it is final (B5.7). QA-2.2-3 (c): static attribution is exact, so the
   * ids derived for a member that already left still count as reproduced.
   */
  function attribute(b: Batch, union: RanOutcome): void {
    const n = b.members.length;
    b.unionIds = taintable(union);
    for (const m of b.members) {
      const a = attributeUnion(union.result, union.result.testsByFile, m.spec, platform);
      if (a.kind === "own-run") {
        if (!m.settled) m.phase = "own-wait";
        continue;
      }
      for (const id of a.result.failingIds) b.reproduced.add(id);
      if (m.settled) continue;
      // B7.4: the member's own spec, its plan notes and the batch note.
      m.scoped = { kind: "ran", result: a.result, exitCode: a.exitCode, spec: m.spec, notes: [...m.spec.notes, `batched: 1 run for ${n} requests`] };
      m.phase = "held";
    }
  }

  /**
   * B7.5: the union failing ids the taint compares with the members' outcomes. A complete union
   * keeps every id (QA-2.2-11): an id no member's derivation reproduces must taint, whatever its
   * key. Only an INCOMPLETE pytest union leaves out an id that names none of its inputs: that is a
   * classname readResult could not map (runner.ts I step 3: unmapped or ambiguous), whose raw form
   * no own run can reproduce, and every member of an incomplete union runs its own spec verbatim
   * (7.1), so none of them is judged on the union's result.
   */
  function taintable(union: RanOutcome): readonly string[] {
    const spec = union.spec;
    if (union.result.complete || spec === undefined || !spec.inputsAreTests) return union.result.failingIds;
    const keys = new Set(spec.inputs.map((f) => fold(fileKeyOf(spec.cwd, f, platform), platform)));
    return union.result.failingIds.filter((id) => keys.has(fold(fileKeyOfId(id), platform)));
  }

  /** B7.5: the union failing ids that no finished own run or static derivation reproduces yet. */
  function outstanding(b: Batch): string[] {
    return b.unionIds.filter((id) => !b.reproduced.has(id));
  }

  /**
   * B5.7 and B5.8 (QA-2.2-3). The batch is final once every union failing id is reproduced, or once
   * no own run is left (then the flaky taint is applied, once). Every held member of a final batch
   * is then released: settled, or queued for its recheck.
   */
  function advance(b: Batch): void {
    if (!b.final) {
      const open = outstanding(b);
      if (open.length > 0) {
        if (b.members.some((m) => !m.settled && (m.phase === "own-wait" || m.phase === "own-run"))) return;
        taint(b, open);
      }
      b.final = true;
    }
    for (const m of live(b)) if (m.phase === "held") release(b, m);
  }

  /**
   * B7.5 (B-G2): union failures that no member's final outcome reproduces make every member's
   * "ran" result incomplete, so none of them can pass on the strength of the batch.
   */
  function taint(b: Batch, unreproduced: readonly string[]): void {
    counters.taints++;
    warn("verify batch: a batched run failure was not reproduced by any request's own run", { ids: unreproduced });
    for (const m of live(b)) {
      const s = m.scoped;
      if (s?.kind === "ran") m.scoped = { ...s, result: taintUnreproduced(s.result, unreproduced) };
    }
  }

  /** B5.8: a final outcome settles unless it needs a recheck that nothing in the batch answers yet. */
  function release(b: Batch, m: Member): void {
    const scoped = m.scoped;
    if (scoped === undefined || !needsRecheck(scoped)) {
      settle(m, scoped === undefined ? errorRun("verification batch produced no outcome") : { scoped, recheck: undefined });
      return;
    }
    const decision = referenceDecision(m);
    if ("decided" in decision) {
      settle(m, { scoped, recheck: decision.decided });
      return;
    }
    const key = referenceKey(decision.reference);
    const reused = reuse(b, key, scoped, m);
    if (reused !== undefined) {
      settle(m, { scoped, recheck: reused });
      return;
    }
    m.ready = { scoped, reference: decision.reference, key };
    m.phase = "recheck-wait";
  }

  /**
   * B9 (QA-2.2-3): a member whose deadline ends once its outcome is known gets that outcome, never
   * a bare abort. While a union failure is still unexplained the outcome is made incomplete with
   * those ids (never a pass), and a recheck it needs becomes its reference decision, else
   * skipped-deadline, as alone below the threshold.
   */
  function settleLate(b: Batch, m: Member): void {
    const s = m.scoped;
    if (s === undefined) {
      settle(m, abortedRun(BATCH_REASONS.attribution));
      return;
    }
    const open = b.final ? [] : outstanding(b);
    const scoped = s.kind === "ran" && open.length > 0 ? { ...s, result: taintUnreproduced(s.result, open) } : s;
    settle(m, { scoped, recheck: needsRecheck(scoped) ? lateRecheck(m) : undefined });
  }

  /** B5.5: the member's own spec under its own deadline; the outcome is its scoped outcome, verbatim. */
  async function runOwn(b: Batch, scope: BatchScope, m: Member): Promise<void> {
    m.phase = "own-run";
    counters.ownRuns++;
    const link = linkDeadline(m.request.deadline, b.deadline.signal);
    const out = await execute(b.key, scope, m.spec, link.deadline);
    link.unlink();
    // B7.5: a finished run is evidence even when its member has already left.
    if (out.kind === "ran") for (const id of out.result.failingIds) b.reproduced.add(id);
    if (m.settled) return;
    m.scoped = out;
    if (out.kind !== "ran") settle(m, { scoped: out, recheck: undefined });
    // Its deadline ended during its own run: it waits for nothing more, as alone (B-G4).
    else if (m.request.deadline.signal.aborted) settleLate(b, m);
    else m.phase = "held";
  }

  // -- rechecks (B8) ---------------------------------------------------------------------------

  /** B8.1: the no-spawn decisions of 2.1-T4, or the captured reference to recheck at. */
  function referenceDecision(m: Member): { readonly decided: RecheckOutcome } | { readonly reference: DispatchReference } {
    const state = m.request.reference;
    // QA-2.2-2: 2.1's direct hook, `ref.kind === "disabled" || !failureRecheck` -> disabled.
    if (!m.failureRecheck) return { decided: { kind: "disabled" } };
    switch (state.kind) {
      case "disabled":
        return { decided: { kind: "disabled" } };
      case "none":
        return { decided: { kind: "unusable", cause: "no-reference", reason: state.reason } };
      case "captured":
        return { reference: state.reference };
    }
  }

  /** The recheck of a member whose deadline already ended: its reference decision, else skipped-deadline. */
  function lateRecheck(m: Member): RecheckOutcome {
    const decision = referenceDecision(m);
    return "decided" in decision ? decision.decided : { kind: "skipped-deadline", remainingMs: m.request.deadline.remaining() };
  }

  /** B8.3: below the threshold a member gets skipped-deadline and nothing is spawned for it. */
  function skippedForDeadline(b: Batch, m: Member, scoped: RanOutcome): boolean {
    const remainingMs = m.request.deadline.remaining();
    if (remainingMs >= b.runtime.recheckMinRemainingMs) return false;
    settle(m, { scoped, recheck: { kind: "skipped-deadline", remainingMs } });
    return true;
  }

  /**
   * B8.6: an outcome recorded for later members at the same reference. Only outcomes that do not
   * depend on the deadline or on a transient failure of the run that produced them are kept.
   */
  function remember(b: Batch, key: string, outcome: RecheckOutcome): void {
    const kept =
      outcome.kind === "exact" ||
      outcome.kind === "approximate" ||
      (outcome.kind === "unusable" && REUSABLE_CAUSES.has(outcome.cause));
    if (!kept) return;
    const list = b.rechecked.get(key) ?? [];
    list.push(outcome);
    b.rechecked.set(key, list);
  }

  /** B8.6: the member's outcome derived from a recheck already run at its reference, if one covers its files. */
  function reuse(b: Batch, key: string, scoped: RanOutcome, m: Member): RecheckOutcome | undefined {
    for (const done of b.rechecked.get(key) ?? []) {
      const counts = done.kind === "exact" ? done.result?.testsByFile : undefined;
      const derived = deriveSharedRecheck(done, counts, scoped.result.failingFiles, m.spec.cwd, platform);
      if (derived !== "split") return derived;
    }
    return undefined;
  }

  /**
   * B8.3-8.5 for the member the queue picked: it rechecks together with every member ready at
   * this moment at the same reference (its group, earliest deadline first).
   */
  async function recheckGroup(b: Batch, scope: BatchScope, lead: Member): Promise<void> {
    const key = lead.ready?.key;
    const group: { readonly m: Member; readonly ready: Ready }[] = [];
    for (const m of live(b).sort(byDeadline)) {
      const ready = m.ready;
      if (m.phase !== "recheck-wait" || ready === undefined || ready.key !== key) continue;
      // B8.3: a member below the threshold leaves its group, as it would alone.
      if (!skippedForDeadline(b, m, ready.scoped)) group.push({ m, ready });
    }
    if (group.length === 0) return;
    // B8.4.
    if (group.length === 1) {
      await recheckOne(b, scope, group[0].m, group[0].ready);
      return;
    }
    // B8.5: one recheck over the union of the group's failing files, bounded by Rg.
    const seen = new Set<string>();
    const files: string[] = [];
    for (const { ready } of group) {
      for (const f of ready.scoped.result.failingFiles) {
        const k = fold(f, platform);
        if (seen.has(k)) continue;
        seen.add(k);
        files.push(f);
      }
    }
    const first = group[0];
    const rg = createBatchDeadline(group.map((c) => c.m.request.deadline));
    b.group = rg;
    for (const { m } of group) {
      m.phase = "recheck";
      m.recheckBoundMs = m.request.deadline.remaining();
    }
    counters.rechecks++;
    const shared = await recheck(scope, first.m, first.ready.reference, files, rg);
    b.group = undefined;
    rg.dispose();
    remember(b, first.ready.key, shared);
    const counts = shared.kind === "exact" ? shared.result?.testsByFile : undefined;
    const split: { readonly m: Member; readonly ready: Ready }[] = [];
    for (const c of group) {
      if (c.m.settled) continue;
      const derived = deriveSharedRecheck(shared, counts, c.ready.scoped.result.failingFiles, c.m.spec.cwd, platform);
      if (derived === "split") split.push(c);
      else settle(c.m, { scoped: c.ready.scoped, recheck: derived });
    }
    if (split.length === 0) return;
    warn("verify batch: a shared recheck split into own rechecks", { members: split.length, shared: shared.kind });
    for (const c of split.sort((x, y) => byDeadline(x.m, y.m))) await recheckOne(b, scope, c.m, c.ready);
  }

  /** B8.4: the direct path, under the member's own deadline. */
  async function recheckOne(b: Batch, scope: BatchScope, m: Member, ready: Ready): Promise<void> {
    if (m.settled || skippedForDeadline(b, m, ready.scoped)) return;
    m.phase = "recheck";
    m.recheckBoundMs = m.request.deadline.remaining();
    counters.rechecks++;
    const link = linkDeadline(m.request.deadline, b.deadline.signal);
    const out = await recheck(scope, m, ready.reference, ready.scoped.result.failingFiles, link.deadline);
    link.unlink();
    remember(b, ready.key, out);
    settle(m, { scoped: ready.scoped, recheck: out });
  }

  // -- seams (B-G5: a throwing seam becomes a fail-closed outcome) ------------------------------

  /**
   * A run under the batch's hold. A run that ran, or ran out of time, measures the key's estimate
   * (QA-2.2-17). The first run of a scope includes its slot wait, which only overstates it.
   */
  async function execute(key: string, scope: BatchScope, spec: ScopedSpec, deadline: Deadline): Promise<ScopedOutcome> {
    const started = now();
    let out: ScopedOutcome;
    try {
      out = await scope.execute(spec, deadline);
    } catch (e) {
      return { kind: "error", reason: `scoped run failed: ${message(e)}` };
    }
    if (out.kind === "ran" || out.kind === "timed-out") noteDuration(key, now() - started);
    return out;
  }

  async function recheck(
    scope: BatchScope,
    m: Member,
    reference: DispatchReference,
    files: readonly string[],
    deadline: Deadline,
  ): Promise<RecheckOutcome> {
    try {
      return await scope.rechecker(m.request.command, m.request.cwd, m.currentTree)(reference, files, deadline);
    } catch (e) {
      return { kind: "unusable", cause: "error", reason: `recheck failed: ${message(e)}` };
    }
  }

  /** B5.9: close once; requesters never wait for it, dispose() does. */
  function closeScope(b: Batch): Promise<void> {
    if (b.closing === undefined) {
      const scope = b.scope;
      const p =
        scope === undefined
          ? Promise.resolve()
          : Promise.resolve()
              .then(() => scope.close())
              .catch((e: unknown) => warn("verify batch: scope close failed", { error: message(e) }));
      b.closing = p;
      closing.add(p);
      void p.then(() => closing.delete(p));
    }
    return b.closing;
  }

  /**
   * B11 (QA-2.2-4, QA-2.2-19): stops tracking a batch whose seam did not return after its tree was
   * killed, and asks its scope to close. 2.1's scope closes only once its in-flight seams have
   * returned, so the slot stays held until the hung seam exits: nothing else runs beside it. This
   * is only reached after BATCH_STALE_GRACE_MS, and it is logged.
   */
  function evict(b: Batch): void {
    running.delete(b);
    b.group?.dispose();
    b.deadline.dispose();
    warn("verify batch: evicted a batch whose seam never returned; its scope closes, and its slot is released, once the seam exits", {
      key: b.key,
      members: b.members.length,
    });
    void closeScope(b);
    // W7: a hung batch no longer keeps the next windows waiting.
    closeIdle();
  }

  // -- arrival (B2) ----------------------------------------------------------------------------

  async function submit(runtime: BatchRuntime, request: TestsPassRequest): Promise<TestsPassRun> {
    if (disposed) return abortedRun(BATCH_REASONS.disposed);
    // B2 2a (cross-repo P3a, SD-P3a-8): a cross-link request is never batched; the union plan has no W.
    if (request.testScope === "full" || request.crossLinkRoot !== undefined || !(runtime.batchWindowMs > 0)) {
      return await runtime.direct(request);
    }
    // QA-2.2-9: planning comes first, as in 2.1's direct hook, so an exhausted deadline still gets
    // the planning outcome (NoAffected, S6) the direct path gives, and aborted only for a spec.
    // W7: a request in planning may join an open window, so it keeps the windows open.
    planning++;
    let plan: ScopingPlan;
    try {
      plan = await runtime.plan({ command: request.command, cwd: request.cwd, changedFiles: request.changedFiles }, request.deadline);
    } catch (e) {
      planning--;
      closeIdle();
      return errorRun(`scoped run planning failed: ${message(e)}`);
    }
    planning--;
    if ("noAffected" in plan) {
      closeIdle();
      return { scoped: { kind: "no-affected", note: plan.note }, recheck: undefined };
    }
    if ("unverifiable" in plan) {
      closeIdle();
      return { scoped: { kind: "unverifiable", code: plan.code, reason: plan.reason }, recheck: undefined };
    }
    if (disposed) return abortedRun(BATCH_REASONS.disposed);
    if (request.deadline.signal.aborted) {
      closeIdle();
      return abortedRun(BATCH_REASONS.beforeRun);
    }
    return join(runtime, request, plan);
  }

  return {
    hook(runtime: BatchRuntime): TestsPassHook {
      return async (request) => {
        try {
          return await submit(runtime, request);
        } catch (e) {
          return errorRun(`verification coordinator failed: ${message(e)}`);
        }
      };
    },

    sweep(): number {
      let evicted = 0;
      for (const [key, w] of windows) {
        if (w.members.some((m) => !m.settled)) continue;
        w.closed = true;
        timers.clearTimeout(w.timer);
        windows.delete(key);
        evicted++;
        warn("verify batch: evicted a window with no live member", { key });
      }
      const t = now();
      for (const b of running) {
        // D aborted when its last member settled, which killed the running tree. A seam that has
        // still not returned a grace period later is hung (QA-2.2-4).
        if (b.settledAt === undefined || t - b.settledAt <= BATCH_STALE_GRACE_MS) continue;
        evict(b);
        evicted++;
      }
      return evicted;
    },

    stats(): BatchStats {
      return { openWindows: windows.size, runningBatches: running.size, pendingRequests: pending, ...counters };
    },

    async dispose(): Promise<void> {
      if (!disposed) {
        disposed = true;
        for (const w of windows.values()) {
          w.closed = true;
          timers.clearTimeout(w.timer);
          for (const m of [...w.members]) settle(m, abortedRun(BATCH_REASONS.disposed));
        }
        windows.clear();
        for (const b of running) {
          for (const m of b.members) settle(m, abortedRun(BATCH_REASONS.disposed));
          // B11.4: kill the running trees. The scope is NOT closed here: runBatch closes it once
          // its seam has returned, that is once the killed tree has exited (QA-2.2-4).
          b.group?.dispose();
          b.deadline.dispose();
        }
      }
      // B11.5 and B11.6 (QA-2.2-19): one grace of BATCH_STALE_GRACE_MS bounds both waits, for
      // the in-flight seams and then for the scope closes. A seam still running after it is hung:
      // its batch is evicted and logged. A close still pending after it waits for such a seam
      // (2.1's close awaits its in-flight executes), so dispose stops waiting and logs it; that
      // slot is released when the seam exits.
      if (running.size === 0 && closing.size === 0) return;
      let handle: unknown;
      const grace = new Promise<"grace">((resolve) => {
        handle = timers.setTimeout(() => resolve("grace"), BATCH_STALE_GRACE_MS);
      });
      try {
        const inflight = [...running].map((b) => b.run);
        if (inflight.length > 0) {
          await Promise.race([Promise.all(inflight), grace]);
          for (const b of running) evict(b);
        }
        const closes = [...closing];
        if (closes.length > 0 && (await Promise.race([Promise.all(closes).then(() => "closed" as const), grace])) === "grace") {
          warn("verify batch: dispose stopped waiting for scope closes; each slot is released once its seam exits", { closes: closing.size });
        }
      } finally {
        timers.clearTimeout(handle);
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Pure helpers (exported for table tests)
// ---------------------------------------------------------------------------------------------

function pathApi(platform: NodeJS.Platform): typeof posix {
  return platform === "win32" ? win32 : posix;
}

/** Path-key folding: case-insensitive on win32 (B3, B6). */
function fold(p: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? p.toLowerCase() : p;
}

/** Code-unit order, independent of the locale. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** B3: key-sorted JSON of a spec's env. */
export function envSignature(env: Readonly<Record<string, string>>): string {
  return JSON.stringify(
    Object.keys(env)
      .sort(byCodeUnit)
      .map((k) => [k, env[k]]),
  );
}

/** B3: spec.args without the elements equal to an input, with spec.reportPath replaced by "<report>". */
export function argvTemplate(spec: ScopedSpec): readonly string[] {
  const inputs = new Set(spec.inputs);
  const report = spec.reportPath;
  return spec.args.filter((a) => !inputs.has(a)).map((a) => (report === "" ? a : a.split(report).join("<report>")));
}

/** B3: [gitRoot, runner, entry, file, cwd, envSignature, argvTemplate] as JSON, with paths case-folded on win32. */
export function batchKey(spec: ScopedSpec, platform: NodeJS.Platform): string {
  return JSON.stringify([
    fold(spec.gitRoot, platform),
    spec.runner,
    fold(spec.entry, platform),
    fold(spec.file, platform),
    fold(spec.cwd, platform),
    envSignature(spec.env),
    argvTemplate(spec),
  ]);
}

/** B8.2: root, commit, and the sorted untracked, tracked and captureReasons entries; capturedAt is excluded. */
export function referenceKey(reference: DispatchReference): string {
  const entries = (m: ReadonlyMap<string, string>) => [...m.entries()].sort((a, b) => byCodeUnit(a[0], b[0]) || byCodeUnit(a[1], b[1]));
  const reasons = reference.captureReasons.map((r) => JSON.stringify([r.cause, r.path])).sort(byCodeUnit);
  return JSON.stringify([reference.root, reference.commit, entries(reference.untracked), entries(reference.tracked), reasons]);
}

/** One member's change set, as unionChangedFiles reads it. */
export interface BatchMemberChanges {
  /** The request's check cwd: relative ChangedPath paths resolve against it. */
  readonly cwd: string;
  readonly changedFiles: readonly ChangedPath[];
}

/**
 * B6: every member's entries, with path and previousPath made absolute against the member's cwd,
 * deduplicated by the platform key of (path, previousPath) in first-seen order.
 */
export function unionChangedFiles(members: readonly BatchMemberChanges[], platform: NodeJS.Platform): ChangedPath[] {
  const P = pathApi(platform);
  const seen = new Set<string>();
  const out: ChangedPath[] = [];
  for (const m of members) {
    for (const c of m.changedFiles) {
      const path = P.resolve(m.cwd, c.path);
      const previousPath = c.previousPath === undefined ? undefined : P.resolve(m.cwd, c.previousPath);
      const key = JSON.stringify([fold(path, platform), previousPath === undefined ? null : fold(previousPath, platform)]);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        path,
        ...(c.status !== undefined ? { status: c.status } : {}),
        ...(previousPath !== undefined ? { previousPath } : {}),
      });
    }
  }
  return out;
}

/** runner.ts JS_TEST_RE: the G.8 test-file suffix rule. */
const JS_TEST_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** runner.ts isJsTestPath (G.8): a .test/.spec file or a file under __tests__. Either separator. */
function isJsTestPath(p: string): boolean {
  const segs = p.split(/[\\/]/);
  return JS_TEST_RE.test(segs[segs.length - 1] ?? "") || segs.includes("__tests__");
}

/**
 * B7.2: true when readResult's zero-test guard (runner.ts I step 2a) could fire for this spec alone:
 * lexicalPaths, inputsAreTests, or a JS test file among its inputs (runner.ts G.8 rule).
 */
export function isGuardSensitive(spec: ScopedSpec, platform: NodeJS.Platform): boolean {
  // The G.8 rule reads both separators and is case-sensitive on every platform, as in runner.ts.
  void platform;
  return spec.lexicalPaths === true || spec.inputsAreTests || spec.inputs.some(isJsTestPath);
}

/** The id-space file key: the path of `absolutePath` relative to `cwd`, with "/" separators (runner.ts I). */
export function fileKeyOf(cwd: string, absolutePath: string, platform: NodeJS.Platform): string {
  return pathApi(platform).relative(cwd, absolutePath).replace(/\\/g, "/");
}

/** The sum of `counts` over `keys`, matched with the platform's folding. */
function countOver(counts: TestCounts, keys: Iterable<string>, platform: NodeJS.Platform): number {
  const folded = new Map<string, number>();
  for (const [k, n] of Object.entries(counts)) folded.set(fold(k, platform), (folded.get(fold(k, platform)) ?? 0) + n);
  let n = 0;
  for (const k of new Set([...keys].map((x) => fold(x, platform)))) n += folded.get(k) ?? 0;
  return n;
}

function greenResult(total: number | undefined): RunResult {
  return { failingIds: [], failingFiles: [], collectionError: false, total, complete: true, source: "report" };
}

/** Per-file test counts of one run (P1): id-space file key -> the number of tests listed. */
export type TestCounts = Readonly<Record<string, number>>;

/** Why a member runs its own spec (B7). */
export type OwnRunCause =
  /** 7.1: the union's result is incomplete, has a collection error, or comes from text. */
  | "not-comparable"
  /** 7.2b/7.3a: the member's own run could have tripped the zero-test guard, and counts cannot tell. */
  | "zero-test-ambiguous"
  /** 7.3b: a failing vitest/jest union. */
  | "mode-b";

/** attributeUnion's decision for one member. */
export type UnionAttribution =
  | { readonly kind: "derived"; readonly result: RunResult; readonly exitCode: number }
  | { readonly kind: "own-run"; readonly cause: OwnRunCause };

/**
 * B7.1-7.3 for one member, given the union run's result, its per-file counts (P1; undefined
 * without them) and the member's own spec. Pure.
 */
export function attributeUnion(
  union: RunResult,
  counts: TestCounts | undefined,
  member: ScopedSpec,
  platform: NodeJS.Platform,
): UnionAttribution {
  // 7.1
  if (!union.complete || union.collectionError || union.source !== "report") return { kind: "own-run", cause: "not-comparable" };
  const inputKeys = member.inputs.map((f) => fileKeyOf(member.cwd, f, platform));

  // 7.2b for pytest (and 7.3a when none of the union's failures is the member's): its own run is
  // green with n tests, or trips the zero-test guard with n = 0.
  const staticGreen = (): UnionAttribution => {
    if (counts === undefined) return { kind: "own-run", cause: "zero-test-ambiguous" };
    const n = countOver(counts, inputKeys, platform);
    if (n > 0) return { kind: "derived", result: greenResult(n), exitCode: 0 };
    return {
      kind: "derived",
      result: { ...greenResult(0), complete: false, note: `${member.runner} ran no tests although a test file was passed` },
      exitCode: member.runner === "pytest" ? 5 : 0,
    };
  };

  if (union.failingIds.length === 0) {
    // 7.2a
    if (!isGuardSensitive(member, platform)) return { kind: "derived", result: greenResult(union.total), exitCode: 0 };
    // 7.2b
    if (member.inputsAreTests) return staticGreen();
    if (counts === undefined) return { kind: "own-run", cause: "zero-test-ambiguous" };
    const n = countOver(
      counts,
      member.inputs.flatMap((f, i) => (isJsTestPath(f) ? [inputKeys[i]] : [])),
      platform,
    );
    return n > 0 ? { kind: "derived", result: greenResult(n), exitCode: 0 } : { kind: "own-run", cause: "zero-test-ambiguous" };
  }

  // 7.3b
  if (!member.inputsAreTests) return { kind: "own-run", cause: "mode-b" };
  // 7.3a: static attribution by input file key.
  const own = new Set(inputKeys.map((k) => fold(k, platform)));
  const ids = union.failingIds.filter((id) => own.has(fold(fileKeyOfId(id), platform)));
  if (ids.length === 0) return staticGreen();
  const files = union.failingFiles.filter((f) => own.has(fold(fileKeyOf(member.cwd, f, platform), platform)));
  const total = counts === undefined ? union.total : countOver(counts, inputKeys, platform);
  return {
    kind: "derived",
    result: { failingIds: ids, failingFiles: files, collectionError: false, total, complete: true, source: "report" },
    exitCode: 1,
  };
}

/**
 * B7.5: the member's result with complete = false and the note "batched run failure not
 * reproduced by any request's own run: <ids>". Its failing ids and files are kept.
 */
export function taintUnreproduced(result: RunResult, unreproduced: readonly string[]): RunResult {
  if (unreproduced.length === 0) return result;
  return {
    ...result,
    complete: false,
    note: `batched run failure not reproduced by any request's own run: ${[...new Set(unreproduced)].sort(byCodeUnit).join(", ")}`,
  };
}

/** B8.5: unusable causes that describe the reference, the same for every member of its group. */
const REFERENCE_LEVEL_CAUSES: ReadonlySet<string> = new Set([
  "no-reference",
  "materialize-failed",
  "reference-vanished",
  "unreproduced-inputs",
  "runner-unsupported",
  "error",
]);

/**
 * B8.6: unusable causes a later member at the same reference may reuse. "materialize-failed" is
 * left out (an aborted materialize reports it, so it can be the deadline of the member that ran
 * it), and so is "error" (a transient executor failure).
 */
const REUSABLE_CAUSES: ReadonlySet<string> = new Set(["reference-vanished", "unreproduced-inputs", "runner-unsupported"]);

/**
 * B8.5: one member's RecheckOutcome, derived from a recheck shared by its reference group, or
 * "split" when only the member's own recheck can answer. `failingFiles` are the member's absolute
 * live paths and `cwd` its spec.cwd (the id key space).
 */
export function deriveSharedRecheck(
  shared: RecheckOutcome,
  counts: TestCounts | undefined,
  failingFiles: readonly string[],
  cwd: string,
  platform: NodeJS.Platform,
): RecheckOutcome | "split" {
  switch (shared.kind) {
    case "approximate":
    case "disabled":
    case "timed-out":
    case "skipped-deadline":
      return shared;
    case "unusable":
      return REFERENCE_LEVEL_CAUSES.has(shared.cause) ? shared : "split";
    case "exact":
      break;
  }
  const mine = new Set(failingFiles.map((f) => fold(fileKeyOf(cwd, f, platform), platform)));
  const ranFiles = shared.ranFiles.filter((k) => mine.has(fold(k, platform)));
  const absentFiles = shared.absentFiles.filter((k) => mine.has(fold(k, platform)));
  // Every file of the member must be accounted for, and ran files need a result: otherwise only
  // the member's own recheck can answer.
  const covered = new Set([...ranFiles, ...absentFiles].map((k) => fold(k, platform)));
  if ([...mine].some((k) => !covered.has(k))) return "split";
  if (ranFiles.length === 0) return { kind: "exact", result: undefined, ranFiles, absentFiles, notes: shared.notes };
  const full = shared.result;
  if (full === undefined) return "split";

  const ranSet = new Set(ranFiles.map((k) => fold(k, platform)));
  const failingIds = full.failingIds.filter((id) => ranSet.has(fold(fileKeyOfId(id), platform)));
  // The rerun's failingFiles are absolute paths in the reference worktree, whose cwd this module
  // does not know: each is keyed by the longest shared ran-file key it ends with.
  const allKeys = [...new Set(shared.ranFiles.map((k) => fold(k, platform)))].sort((a, b) => b.length - a.length);
  const keyOfRerunFile = (f: string): string | undefined => {
    const slashed = fold(f.replace(/\\/g, "/"), platform);
    return allKeys.find((k) => slashed === k || slashed.endsWith(`/${k}`));
  };
  const failingFilesAtRef = full.failingFiles.filter((f) => {
    const k = keyOfRerunFile(f);
    return k !== undefined && ranSet.has(k);
  });

  let total: number | undefined;
  if (counts !== undefined) {
    total = countOver(counts, ranFiles, platform);
    if (total === 0) {
      return { kind: "unusable", cause: "incomplete", reason: "rerun ran no tests although every input is a test file" };
    }
  } else {
    if (failingIds.length === 0) return "split";
    total = full.total;
  }
  return {
    kind: "exact",
    result: { failingIds, failingFiles: failingFilesAtRef, collectionError: false, total, complete: true, source: "report" },
    ranFiles,
    absentFiles,
    notes: shared.notes,
  };
}

/** B9: the deadline of a batch or of a recheck group, over the members still attached. */
export interface BatchDeadline extends Deadline {
  /** Detaches a settled member: it no longer counts toward remaining() or the all-aborted rule. */
  release(member: Deadline): void;
  /** Aborts the signal if it has not aborted yet, and removes every listener. Idempotent. */
  dispose(): void;
}

/** B9. It has no timer of its own: it aborts when every attached member has aborted, or at dispose. */
export function createBatchDeadline(members: readonly Deadline[]): BatchDeadline {
  const controller = new AbortController();
  const attached = new Map<Deadline, () => void>();
  const budgetMs = members.reduce((m, d) => Math.max(m, d.budgetMs), 0);

  const detachAll = () => {
    for (const [d, listener] of attached) d.signal.removeEventListener("abort", listener);
    attached.clear();
  };
  const abort = () => {
    detachAll();
    if (!controller.signal.aborted) controller.abort();
  };
  const check = () => {
    for (const d of attached.keys()) if (!d.signal.aborted) return;
    abort();
  };

  for (const d of members) {
    if (attached.has(d)) continue;
    const listener = () => check();
    attached.set(d, listener);
    d.signal.addEventListener("abort", listener, { once: true });
  }
  check();

  const remaining = () => {
    if (controller.signal.aborted) return 0;
    let r = 0;
    for (const d of attached.keys()) r = Math.max(r, d.remaining());
    return r;
  };

  return {
    budgetMs,
    remaining,
    bound: (ownBudgetMs: number) => Math.min(ownBudgetMs, remaining()),
    signal: controller.signal,
    release(member: Deadline) {
      const listener = attached.get(member);
      if (listener === undefined) return;
      member.signal.removeEventListener("abort", listener);
      attached.delete(member);
      check();
    },
    dispose: abort,
  };
}

