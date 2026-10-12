// src/verify/pending.ts
// ===============================================================================================
// PENDING VERIFICATION REGISTRY: design (plan Phase 2.4, task 2.4.1; S7, sections 1.5-16..20)
//
// STATUS: implemented (task 2.4.1b, R12); tests in test/unit/pending.test.ts. The header below is
// the contract. Contract types used here come from the 2.1.1 block of
// src/verify/types.ts (ReferenceState, Verdict) and are never redefined.
// ===============================================================================================
//
// R1. PURPOSE AND NON-GOALS
//
//   A per-plugin-instance, in-memory registry of DEFERRED delegations (VERIFY:deferred, the
//   default): what a later `router_verify` call (2.4.3), the pending list (2.4.4) and background
//   mode (2.4.5) need to verify one delegation after its producer has returned.
//   - Pure in-memory state with an injected clock and an injected random source. It never spawns
//     a process, never runs git, never touches the filesystem and owns no timer. (The R14
//     background queue in this file owns one timer; it exists only when `background: true`.)
//   - It does not run verifications. It records who may verify what, hands the in-flight run to
//     concurrent callers, and stores the settled result.
//   - It does not parse directives, compute changed files, assess risk or build the scoped run.
//     2.4.2 does that before `register`, and 2.4.3 runs the 2.1/2.2 pipeline after `markVerifying`.
//   - Required (VERIFY:required) delegations are NOT registered: they are gated synchronously by
//     2.1 and never produce a handle. A deferred delegation is never labelled accepted or verified
//     by anything in this module (R9).
//
// R2. HANDLES
//
//   - Format: `vrf_` + 24 lowercase hex chars = 12 bytes (96 bits) from `random(12)`, default
//     `crypto.randomBytes`. HANDLE_PATTERN = /^vrf_[0-9a-f]{24}$/. Unguessable, but a handle is NOT
//     a bearer token: every lookup is scoped by the calling session (R6). 96 bits keeps the footer
//     short while making a collision or a guess irrelevant in practice.
//   - Collision: a candidate equal to a live handle or a tombstone is redrawn, at most
//     HANDLE_MAX_DRAWS times; then `register` returns { ok: false, code: "handle-collision" }
//     (never throws: a registration failure must never fail the delegation; the dispatch runs the
//     required gate instead, QA-2.4-4).
//   - Input normalization (`normalizeHandle`, for router_verify arguments): trim, strip ONE pair of
//     surrounding backticks or quotes, lowercase, then HANDLE_PATTERN. Anything else is undefined
//     and reported as UNKNOWN_HANDLE_TEXT. router_verify dedupes normalized handles and accepts at
//     most MAX_HANDLES_PER_CALL (= MAX_ENTRIES_PER_SESSION); the excess is reported, not run.
//
// R3. ENTRY
//
//   Registration (PendingRegistration) is built by 2.4.2 when a deferred producer returns:
//     orchestratorSessionID  the session that called `task` / `delegate` (the hook's
//                            input.sessionID / the tool context's sessionID). NEVER the producer.
//     dispatchID             the dispatch key 2.1's store uses (opaque).
//     producerSessionID      the child session; must differ from orchestratorSessionID.
//     producerTier           canonical lowercase tier id (1.6 handoff item 8); used for
//                            buildForcingNote's next tier on a rejection. "" when untiered.
//     description            the orchestrator's `description` arg (or a prompt prefix);
//                            stored through sanitizeDescription (R9).
//     cwd                    absolute check cwd of the delegation.
//     root                   git top-level realpath (TreeSnapshot.root, 2.1.3a; 1.6 item 7), or
//                            undefined when unknown. Used only for lineage (R11).
//     dispatchedAt           clock value when the dispatch started (lineage, R11).
//     dod                    the delegation's DoD (it carries testsPass; else nothing is deferred).
//     reference              Promise<ReferenceState> from 2.1's per-dispatch capture. The registry
//                            stores `reference.then(s => s, () => ({ kind: "none", reason:
//                            REFERENCE_FAILED_REASON }))`, so the stored promise never rejects and
//                            an abandoned capture never raises an unhandled rejection.
//     changedFiles           ChangedPath[] with status/previousPath, or "unavailable" when
//                            attribution failed (never [] for a failure: QA-1.6-14). More than
//                            MAX_STORED_CHANGED_FILES paths are stored as "unavailable" with
//                            changedFilesDropped = the count: a later verification is then
//                            unverifiable (section 1.5-6), never scoped over a truncated set.
//     risk                   RiskAssessment computed by 2.4.2 (R10) BEFORE registration.
//     digests                optional Promise<FileDigests | undefined>: per-path content digests of
//                            the producer's files taken right after return (2.4.2, fs reads only,
//                            not awaited on the result path). Stored normalized to never reject.
//                            router_verify compares them with driftedPaths() for the section
//                            1.5-18 drift notice; undefined -> no drift claim either way.
//   Added by the registry: handle, createdAt = now() at registration (= the producer's return:
//   the TTL and "newest first" run from it), state, verifyingSince, result.
//   Snapshots: `get`/`list*` return frozen snapshot objects (PendingEntry); later transitions do
//   not mutate a snapshot a caller holds.
//   Release on a terminal settle (state "verified"): reference, changedFiles, digests and dod are
//   dropped from the record (reference -> resolved { kind: "none", reason: RELEASED_REASON },
//   changedFiles -> "unavailable"). Only metadata and the settled result stay until the TTL.
//
// R4. STATES AND TRANSITIONS
//
//   from          event                                      to            effect
//   ------------  -----------------------------------------  ------------  ---------------------
//   (none)        register                                   unverified    handle issued
//   unverified    markVerifying                              verifying     "claimed": new run
//   verifying     markVerifying (second caller)              verifying     "joined": same run
//   verifying     claim.settle(result, retryable: false)     verified      run resolves; release
//   verifying     claim.settle(result, retryable: true)      unverified    run resolves; kept for
//                                                                          a later call; result
//                                                                          stored as lastResult
//   verifying     reaped: verifyingSince + maxVerifyingMs    unverified    run resolves with
//                 <= now (lazy, R7)                                        ABANDONED result
//   verified      markVerifying                              verified      "settled": cached result,
//                                                                          no new run (no CPU)
//   any but       TTL (now - createdAt >= ttlMs),            (tombstone)   onEvict(entry, cause)
//   verifying     forgetSession, dispose; a cap evicts
//                 verified entries only (R7, QA-2.4-4)
//
//   - `retryable` is decided by the caller (2.4.3): true for results that say nothing about the
//     producer's work — slot busy, deadline/abort, timed out, executor error, a joiner cut by its
//     own deadline never settles anything. Everything else (pass, fail, S6 unverifiable,
//     approximate/unusable reference, no reference) is terminal.
//   - A verifying entry is never evicted (joiners await it). After its settle, an entry past its
//     TTL or doomed by forgetSession is evicted at once.
//   - claim.settle is single-use: it returns true once; false afterwards, and false when the
//     claim was reaped (a stale claimer can never overwrite a newer run). The run promise never
//     rejects. 2.4.3 MUST call settle in a `finally` (with a retryable result on an exception);
//     the reaper is only the backstop.
//
// R5. OPERATIONS (PendingRegistry)
//
//   register(reg)                 -> RegisterResult. Validates (non-empty session ids that differ,
//                                    else "invalid-input"), applies caps (R7) BEFORE inserting.
//   get(sessionID, handle)        -> Lookup: found | expired | unknown (R6). Reaps and TTL-evicts
//                                    lazily first, so an expired entry is never "found" even when
//                                    the throttled sweep has not run.
//   listUnverified(sid, limit?)   -> state "unverified" only, newest first (createdAt desc, then
//                                    registration order desc). limit undefined = all (<= cap).
//                                    Feeds buildPendingListBlock (2.4.4).
//   listOpen(sid)                 -> "unverified" + "verifying", newest first: the handle set of
//                                    router_verify `pending: true`, so a second concurrent
//                                    `pending: true` joins the in-flight runs instead of seeing
//                                    an empty list.
//   markVerifying(sid, handle)    -> ClaimResult: claimed { run, settle } | joined { run } |
//                                    settled { result } | expired | unknown.
//   sweep(nowMs?)                 -> TTL eviction + reaping. Wired as `() => pending.sweep()` into
//                                    the existing createIdleTtlSweeper list in index.ts (2.4.2);
//                                    no timer of its own. Returns the number evicted.
//   forgetSession(sid)            -> evicts the session's entries, tombstones and rejection records
//                                    (verifying ones are doomed and evicted at settle). For a
//                                    session-deletion event, if the host delivers one (pre-flight).
//   recordRejection(record)       -> lineage ledger (R11).
//   findLineage(query)            -> LineageMatch | undefined (R11).
//   stats()                       -> counts, for tests and the QA memory-bound assertions.
//   dispose()                     -> evicts everything (cause "disposed"); every in-flight run
//                                    resolves with the DISPOSED result; later settles return false.
//
// R6. SCOPING (plan 2.4.1 "Scoping"; QA focus "handle leakage across sessions")
//
//   - Storage is keyed by session first: Map<orchestratorSessionID, Map<handle, record>>. A lookup
//     for (sessionID, handle) consults only that session's map, so another session's live handle,
//     a producer session's attempt, a malformed string and a never-issued handle are the same
//     result: { kind: "unknown" } -> UNKNOWN_HANDLE_TEXT. Nothing distinguishes "exists elsewhere".
//   - Tombstones (evicted handles) remember their session: the same session gets "expired"
//     (EXPIRED_HANDLE_TEXT); any other session gets "unknown". Bounded FIFO, TOMBSTONE_MAX.
//   - A producer (subagent) calling router_verify runs under its own session id, which owns none
//     of the handles its orchestrator received; the footer reaches only the orchestrator. So a
//     subagent can neither verify nor list its own delegation (plan "Subagent cannot self-select").
//
// R7. TTL, ABANDONMENT, EVICTION, MEMORY BOUNDS
//
//   - TTL: ttlMs = pendingTtlMs (section 1.4, default 3600000), from createdAt. Checked lazily on
//     every get/list/markVerifying/register and by sweep(). Future stamps (clock skew) are never
//     expired (same rule as sessions.ts sweep).
//   - Abandonment: maxVerifyingMs = gateBudgetMs + VERIFYING_GRACE_MS (caller passes it). A
//     verifying entry older than that is reverted to unverified and its run resolved with the
//     ABANDONED result (retryable). Checked lazily like the TTL. No timer.
//   - Caps: MAX_ENTRIES_PER_SESSION = 32, MAX_ENTRIES_GLOBAL = 128, and a global weight
//     MAX_GLOBAL_WEIGHT = 100000, weight = stored changed paths + (once the reference resolves
//     "captured") reference.untracked.size + reference.tracked.size. The weight of a reference is
//     added in its settle callback (a promise callback, not a timer). A reference that would exceed
//     the weight cap is shed instead: the entry keeps its place and its reference becomes
//     { kind: "none", reason: REFERENCE_SHED_REASON } (QA-2.4-4; stricter later, never a false pass).
//   - Eviction order when a cap would be exceeded (session cap: within the session; global caps:
//     across sessions): (1) every TTL-expired entry, (2) verified entries, oldest first. Unverified
//     and verifying entries are NEVER evicted by a cap (QA-2.4-4): an evicted unverified delegation
//     would leave the pending list silently and read as verified. If the new entry still does not
//     fit, register returns { ok: false, code: "registry-full" }. Every refusal (registry-full,
//     handle-collision, invalid-input) makes the dispatch run the required gate instead (2.4.2
//     finishDeferred): no delegation is ever left without a verdict path, and there is no footer
//     without a handle.
//   - Worst case: 128 entries, 100000 path strings of the registry's own weight (about 20 MB at
//     200 B per path), 512 tombstones, 16 x sessions rejection records of <= 50 ids each.
//   - Resources: a stored reference is data only (DispatchReference: commit ids and hash maps). The
//     `git stash create` commit is unreferenced and left to git's own pruning, as in 1.5; worktrees
//     exist only inside a VerificationScope and are disposed by its close() (2.1 T2 P9), never by
//     the registry. So eviction disposes nothing: it drops the record, tombstones the handle and
//     calls onEvict(entry, cause) for logging. An in-flight capture keeps running under 2.1's
//     baselineTimeoutMs; the registry only drops its promise.
//
// R8. CONCURRENCY
//
//   Single-threaded JS: every operation is synchronous and atomic with respect to the others.
//   The only asynchronous edges are the stored promises' settle callbacks (weight accounting) and
//   the run promises the registry resolves. markVerifying is the join point of section 1.5-18:
//   two router_verify calls for one handle -> exactly one "claimed", the rest "joined" (one run).
//   A joiner bounds its own wait by its own deadline (2.4.3); if its deadline passes first it
//   reports VERIFYING_ELSEWHERE_TEXT for that handle and settles nothing.
//
// R9. TEXT (stable; 2.4.6 tests assert it verbatim). All builders are pure.
//
//   Directive safety: no builder ever emits a literal `VERIFY:` / `VERIFY_WAIT:` / `CAP:`
//   directive. An orchestrator that quotes a footer or the pending list in a later dispatch must
//   not change that dispatch's mode (directives.ts router-example contract, QA-1.6-4/QA-1.6-5).
//   Label rule: the first token after `[router] ` of the footer's first line is always
//   `unverified`. Risk reasons may contain "verified" as prose (REASONS.unverifiable); tests assert
//   on the label, never on a bare substring.
//
//   buildDeferredFooter({ handle, risk })  (section 1.5-16), handle registered:
//     [router] unverified · <handle> · risk <level> (<r1>; <r2>; <r3>; +<k> more)
//     [router] Call `router_verify` with this handle before building on this work if the risk matters.
//   There is no footer without a handle (QA-2.4-4): a registration the registry refuses is not
//   deferred, and the dispatch runs the required gate.
//   The risk fragment is formatRisk(level, reasons, FOOTER_MAX_REASONS): `risk <level>`, then
//   ` (<reasons>)` with at most maxReasons reasons, each through sanitizeDescription's character
//   rules (no length cut), "; "-joined, `; +<k> more` only when k > 0. The parenthesis is omitted
//   when there are no reasons or maxReasons is 0 (the pending list uses 0). `·` is U+00B7 with
//   one space on each side.
//   appendRouterFooter(output, footer): output.trimEnd() + "\n\n" + footer, or footer alone when
//   the trimmed output is empty. The same call is used for the native `task` output
//   (tool.execute.after) and the `delegate` tool return (2.4.2).
//
//   buildPendingListBlock(entries)  (section 1.5-20; entries = listUnverified(sid) or, in index.ts,
//     listPending(sid), newest first):
//     undefined when entries is empty (the prompt does not grow for sessions that never defer);
//     otherwise, with n = entries.length and m = min(n, PENDING_LIST_LIMIT = 5):
//     [router] Unverified delegations in this session (newest first):
//     - <handle> · risk <level> · <description>          (m lines)
//     - ... and <n - m> more                              (only when n > m)
//     [router] Before your final answer, call `router_verify` with the handles that matter, or with `pending: true` for all of them.
//     QA-2.4-3: a verified entry (a background verdict that did not pass, not yet replayed) reads
//     `- <handle> · <fail|unverifiable> in background verification · risk <level> · <description>`,
//     and the header is then PENDING_LIST_MIXED_HEADER. router_verify (a handle or `pending:
//     true`) replays it with no run, and it leaves the list (markReplayed).
//
//   buildLateNoticeBlock(notices)  (section 1.5-19, background mode only; R14 owns the queue):
//     undefined when empty; otherwise
//     [router] Background verification found introduced failures:          (every notice a fail)
//     [router] Background verification did not pass these delegations:    (otherwise)
//     - <handle> · <description> · failing: <id>, <id> (+<k> more)   (a fail with ids, capped at 10)
//     - <handle> · <description> · failed: <reason>                  (a fail that names no id)
//     - <handle> · <description> · unverifiable: <reason>            (terminal unverifiable)
//     [router] Nothing was retried; decide whether to re-dispatch.
//     [router] Call `router_verify` with a handle for its full verdict; nothing is run again.
//     <reason> goes through sanitizeDescription (80 code points, directive-safe).
//
//   sanitizeDescription(text): every C0/C1 control, U+2028/U+2029 and tab -> space; backtick ->
//   `'`; runs of whitespace -> one space; trim; longer than MAX_DESCRIPTION_CHARS -> the first
//   MAX_DESCRIPTION_CHARS - 1 code points + `…`; empty -> "(no description)". Code-point safe
//   (never splits a surrogate pair). Keeps each list item on one line.
//
//   Phrases for router_verify results (2.4.3): UNKNOWN_HANDLE_TEXT, EXPIRED_HANDLE_TEXT,
//   VERIFYING_ELSEWHERE_TEXT, and the reasons ABANDONED_REASON / DISPOSED_REASON of the synthetic
//   retryable results (Verdict { pass: false, outcome: "unverifiable", method: "deterministic",
//   reasons: [<reason>], caveats: [<reason>] }).
//
// R10. RISK INPUTS (2.4.2 computes the risk; handoffs from docs/qa/.../phase-1.6.md)
//
//   assessRisk({ changedFiles, reference, producerTier, scopingPlan, root }) with:
//   - changedFiles: the tree-snapshot ChangedPath[] with status and previousPath (2.1.3a). When
//     attribution failed, do NOT call assessRisk with []: use unattributedRisk() = { level:
//     "high", reasons: [UNATTRIBUTED_RISK_REASON] } and register changedFiles "unavailable".
//   - reference: true only when the reference promise has ALREADY settled as "captured" at return
//     time (2.4.2 tracks the settled value; it never awaits: 0 ms result latency). A capture still
//     in flight counts as absent: the risk is raised one step, conservatively. The stored promise
//     is still the one router_verify awaits later.
//   - producerTier: canonical lowercase id (only exact "fast" triggers row 11).
//   - scopingPlan: planStaticScoping (1.3, no spawn) for the stored changed files.
//   - root: git top-level realpath (TreeSnapshot.root), never the delegation cwd.
//   The risk is fixed at registration; it is advice (section 1.5-17) and is not recomputed.
//
// R11. T11 LINEAGE (a native `task` re-dispatch after a rejection)
//
//   Problem (2.1 deterministic.ts T11): after a rejection, a native `task` re-dispatch captures a
//   new reference that already contains the failed attempt's changes. A test the first attempt
//   broke then fails at the new reference too, is classified pre-existing, and passes with the
//   "no worse than before" note.
//   Decision: pending.ts keeps a small per-orchestrator-session ledger of proven-introduced ids,
//   and 2.4 downgrades such a pass to UNVERIFIABLE with a caveat naming the earlier delegation.
//   It does NOT link the re-dispatch to the original reference, because the router cannot tell a
//   retry from a new delegation in the native path (no retry marker, and section 1.5-15 closes
//   the directive set): with the old reference a third party's break between the two dispatches
//   would be blamed on the retry (section 1.2, second guarantee), and a failure fixed and broken
//   again in between would be excused (a false pass). The downgrade instead only removes passes
//   for ids that are both pre-existing at the new reference and proven introduced earlier in the
//   same session: it can never create a pass and never creates a fail, which is exactly section
//   1.2's third guarantee ("cannot tell them apart" -> unverifiable).
//   - recordRejection({ orchestratorSessionID, root, label, landedAt, introduced }) — called by
//     claim.settle automatically for a terminal result with introduced ids and a known root
//     (label = handle, landedAt = entry.createdAt), and by 2.4.2 for a rejected REQUIRED gate in
//     the native path (label "dispatch <dispatchID>", landedAt = the producer's return).
//     introduced is capped at MAX_LEDGER_IDS; MAX_LEDGER_PER_SESSION records per session, oldest
//     dropped; records expire with ttlMs. One record per (label, root): a second one replaces the
//     first (router_verify records a call's rejections before it settles them, QA-2.4-1).
//   - findLineage({ orchestratorSessionID, root, dispatchedAt, preexisting }) -> the newest record
//     of the same session and root with landedAt <= dispatchedAt whose introduced ids intersect
//     `preexisting`: { label, ids } (ids in `preexisting` order). A record never matches its own
//     delegation (its landedAt is after its dispatchedAt).
//   - buildLineageCaveat(match): "<ids> failed after <label> in this session and still fail; that
//     change may still be present in the reference of this delegation, so pre-existing cannot be
//     told apart from not fixed". <ids> as in 2.1 T7 (at most 10, then " (+<k> more)"). "May":
//     the ledger matches by id and root only, and the change may have been reverted (QA-2.4-13).
//   - Precondition (2.4 pre-flight): the merged 2.1 must expose TestsPassJudgement.failures on the
//     gate result that 2.4 code sees. If it does not, 2.4 does not edit 2.1-owned internals: it
//     deletes recordRejection/findLineage/buildLineageCaveat from this file (no dead code) and the
//     2.4 QA report keeps T11 as a residual.
//
// R12. IMPLEMENTATION TASKS (each <= ~20 tool calls; commit + push each green; scoped tests only)
//
//   2.4.1b  (now, parallel with 2.1.2+ and 2.2) Implement this file per R2-R11 and add
//           test/unit/pending.test.ts: handle format + collision redraw (fake random), R6 scoping
//           matrix (other session / producer session / malformed / never issued -> unknown; own
//           tombstone -> expired), R4 transition table row by row, join (N markVerifying -> one
//           claimed), single-use settle, reaping, TTL at read without sweep, caps and eviction
//           order (verifying never evicted, registry-full), weight added on reference resolution,
//           release on terminal settle, rejected reference promise normalized, forgetSession,
//           dispose resolves joiners, every R9 text verbatim (empty list -> undefined, cap 5,
//           "+k more", no directive tokens, label rule), lineage matrix (other session, other
//           root, landedAt after dispatchedAt, no intersection -> undefined). typecheck.
//   2.4.2a  (after 2.1 + 2.2.3 merge) wiring.ts: parse directives from the orchestrator prompt
//           only; VERIFY_WAIT replaces captureWaitMs in the bounded capture wait; a deferred-finish
//           helper (snapshot -> changedFiles | "unavailable", planStaticScoping, risk per R10,
//           digests, register, footer). Tests in deferred-verification.test.ts (zero spawns).
//   2.4.2b  index.ts native `task` path: mode routing in tool.execute.before/after; required ->
//           2.1 gate unchanged; deferred -> footer appended; recordRejection on required
//           rejections (R11); sweep wired into createIdleTtlSweeper.
//   2.4.2c  index.ts `delegate` path: same routing, footer on the tool return, no ladder for
//           deferred.
//   2.4.3a  wiring.ts: verifyHandles(sessionID, handles | "pending", deps): normalize, claim/join,
//           one Deadline, one batch through the 2.2 coordinator, drift via driftedPaths, verdict
//           per handle with forcing note + next tier on rejection, lineage caveat, settle in
//           finally; no retry ever dispatched.
//   2.4.3b  index.ts: register `router_verify` next to `delegate` whenever verification is
//           enabled (independent of enableDelegateTool). Tests: router-verify-tool.test.ts.
//   2.4.4   index.ts system transform: buildPendingListBlock(listUnverified(sid)) appended only
//           when defined. Tests: cap 5, newest first, leaves on verify/TTL, per-session.
//   2.4.5   (done, R14) background (only when background: true): the queue factory in this file,
//           coalescing, same coordinator/slot/caps, late notices via buildLateNoticeBlock once per
//           handle; the queue is never constructed when false (assert). Tests: the plan's set.
//   2.4.6   remaining plan tests (latency under fake timers, capture after the wait, subagent
//           cannot self-select, 50 deferred delegations spawn nothing).
//
// R13. RESIDUAL RISKS (accepted; QA may challenge)
//
//   - A producer can end its final text with a fake `[router] …` line. The real footer is always
//     appended last; the 2.3 protocol text says only the last `[router]` footer counts.
//   - Drift digests are taken just after the producer returns (not atomically with it), but before
//     the deferred result is released (QA-2.4-8): only an edit that lands during the deferred
//     finish itself (at most DEFERRED_FINISH_MS) is attributed to the producer.
//   - The registry lives in one plugin instance: a restarted opencode process loses its handles
//     (router_verify then says "unknown handle"); nothing persists across processes by design.
//   - Lineage (R11) is id-based: a renamed test id escapes it (the pass keeps 2.1's n2 note).
//
// R14. BACKGROUND QUEUE (task 2.4.5; section 1.5-19; `background: true` only)
//
//   - Construction: the wiring calls createBackgroundQueue only when `background` is true at plugin
//     start. When it is false (the default) no queue, timer, notice store or run exists, and no
//     code path reaches one (the wiring holds `undefined`).
//   - Input: the wiring's deferred finish enqueues every registered entry whose change set is
//     attributed ({ sessionID, handle, files }). An "unavailable" set is not queued: nothing could
//     be run for it, and settling it would only move it out of the pending list.
//   - Coalescing: a newer request of the same orchestrator session whose files overlap a QUEUED
//     older one drops the older request (its producer's files changed again, so its verdict would
//     be a drift notice at best). The older entry stays unverified and listed; it is never
//     reported as verified. Requests of other sessions are never dropped by it.
//   - Scheduling: one unref'd timer, armed at the earliest due request and never moved later (no
//     debounce: a steady stream cannot starve the queue). A fresh request is due BACKGROUND_SETTLE_MS
//     after it arrives, so delegations returning together share one run. One run per plugin
//     instance at a time. A run takes the oldest due request, then every fresh or due request of
//     the same session (at most MAX_HANDLES_PER_CALL): one verify call, i.e. one router_verify
//     deadline and one S5 window.
//   - The run is `verify` = the wiring's verifyHandles (the required gate's path, slot, caps, batch
//     coordinator, low priority), so it claims and settles entries exactly as router_verify does:
//     a later router_verify replays the stored verdict and runs nothing.
//   - Outcomes: a terminal pass -> nothing; a terminal fail or unverifiable -> one late notice for
//     the orchestrator session (lateNoticeFor); a retryable result -> requeued with backoff
//     retryBaseMs * 2^(attempt-1), at most BACKGROUND_MAX_ATTEMPTS runs, then it just stays
//     unverified (never a hot loop); "reported" (a router_verify call claimed or had settled it)
//     and "gone" (unknown/expired) -> dropped. A handle missing from the outcomes, or a rejected
//     verify, counts as retryable.
//   - Notices: per session, one per handle, returned once by takeNotices (the system transform) and
//     remembered as delivered. A consumed notice never makes its entry disappear (QA-2.4-3): the
//     run settles with `background: true`, and a verdict that did not pass stays in listPending
//     (the pending list) until router_verify replays it (markReplayed) or the TTL expires. markReported(handles) (router_verify's verdict items) drops and
//     suppresses a notice the orchestrator already saw. Bounded: LATE_NOTICES_PER_SESSION,
//     LATE_NOTICES_MAX, REPORTED_MEMO_MAX; sweep drops notices older than ttlMs.
//   - Cancellation: forgetSession (session.deleted) drops the session's requests and notices and
//     aborts its run in flight (the deadline, so the batch's tree is killed); dispose aborts the run,
//     clears the timer and drops everything. A cancelled run's results are ignored.
// ===============================================================================================

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { appendFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { DoD } from "./dod";
import type { RiskAssessment, RiskLevel } from "./risk";
import { deserializeReference, serializeReference, type DispatchReference } from "./reference";
import type { ChangedPath } from "./runner";
import type { ReferenceState, Verdict } from "./types";

// ---------------------------------------------------------------------------------------------
// Constants (R2, R7, R9)
// ---------------------------------------------------------------------------------------------

export const HANDLE_PREFIX = "vrf_";
/** 12 random bytes -> 24 lowercase hex chars (R2). */
export const HANDLE_RANDOM_BYTES = 12;
export const HANDLE_PATTERN = /^vrf_[0-9a-f]{24}$/;
export const HANDLE_MAX_DRAWS = 4;

export const MAX_ENTRIES_PER_SESSION = 32;
export const MAX_ENTRIES_GLOBAL = 128;
/** Global weight in path strings: stored changed paths + captured reference untracked/tracked sizes (R7). */
export const MAX_GLOBAL_WEIGHT = 100_000;
/** Above this, changedFiles is stored as "unavailable" (never truncated, R3). */
export const MAX_STORED_CHANGED_FILES = 500;
export const TOMBSTONE_MAX = 512;
export const MAX_HANDLES_PER_CALL = MAX_ENTRIES_PER_SESSION;
/** Added to gateBudgetMs by the caller to form maxVerifyingMs (R7). */
export const VERIFYING_GRACE_MS = 30_000;

export const MAX_LEDGER_PER_SESSION = 16;
export const MAX_LEDGER_IDS = 50;

export const MAX_DESCRIPTION_CHARS = 80;
export const PENDING_LIST_LIMIT = 5;
export const FOOTER_MAX_REASONS = 3;
export const LATE_NOTICE_MAX_IDS = 10;

export const UNKNOWN_HANDLE_TEXT = "unknown handle";
export const EXPIRED_HANDLE_TEXT = "expired handle: older than pendingTtlMs or evicted; it can no longer be verified";
export const VERIFYING_ELSEWHERE_TEXT =
  "still being verified by another router_verify call; call again for its verdict";
export const REFERENCE_FAILED_REASON = "reference capture failed";
export const RELEASED_REASON = "reference released after verification";
export const ABANDONED_REASON = "verification run abandoned before it settled";
export const DISPOSED_REASON = "verification registry disposed";
export const UNATTRIBUTED_RISK_REASON = "changed files could not be attributed";
/** R7, QA-2.4-4: a captured reference dropped at the weight cap (the entry itself is kept). */
export const REFERENCE_SHED_REASON = "reference dropped at the pending registry's memory bound";
/** R14: the late-notice header when a notice is not a plain failure (an unverifiable result). */
export const LATE_NOTICE_MIXED_HEADER = "[router] Background verification did not pass these delegations:";
/**
 * QA-2.4-3: the pending-list header when it also holds background verdicts that did not pass and
 * were not replayed yet (each such line says `<outcome> in background verification`).
 */
export const PENDING_LIST_MIXED_HEADER = "[router] Unverified delegations, and background verdicts not yet read, in this session (newest first):";
/** R14: a settled handle replays its cached verdict (forcing note, next tier) with no new run. */
export const LATE_NOTICE_REPLAY_LINE = "[router] Call `router_verify` with a handle for its full verdict; nothing is run again.";

/** R14: a fresh background request waits this long, so delegations returning together share a run. */
export const BACKGROUND_SETTLE_MS = 1_000;
/** R14: the first retry of a retryable background result; each later retry doubles it. */
export const BACKGROUND_RETRY_BASE_MS = 30_000;
/** R14: background runs per request, retries included; then the entry just stays unverified. */
export const BACKGROUND_MAX_ATTEMPTS = 3;
/** R14: queued background requests; the oldest is dropped beyond it (it stays unverified). */
export const BACKGROUND_QUEUE_MAX = MAX_ENTRIES_GLOBAL;
/** Phase 2.1: the verdict of a held entry past pendingTtlMs. */
export const HELD_TTL_REASON = "verification did not finish within pendingTtlMs";
/** Phase 2.1: the verdict of a held entry whose runs kept ending retryable. */
export const HELD_EXHAUSTED_REASON = `verification did not finish after ${BACKGROUND_MAX_ATTEMPTS} attempts`;
/** R14: undelivered late notices per orchestrator session, and in total. */
export const LATE_NOTICES_PER_SESSION = MAX_ENTRIES_PER_SESSION;
export const LATE_NOTICES_MAX = MAX_ENTRIES_GLOBAL;
/** R14: handles whose verdict reached the orchestrator (delivered, or through router_verify). */
export const REPORTED_MEMO_MAX = TOMBSTONE_MAX;

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

export type PendingState = "unverified" | "verifying" | "verified" | "held";

/** Absolute path -> sha256 hex of the file bytes, or ABSENT_DIGEST for a missing path (R3). */
export type FileDigests = ReadonlyMap<string, string>;
export const ABSENT_DIGEST = "absent";

/** What 2.4.2 hands to `register` when a deferred producer returns (R3). */
export interface PendingRegistration {
  readonly orchestratorSessionID: string;
  readonly dispatchID: string;
  readonly producerSessionID: string;
  /** Canonical lowercase tier id; "" when the producer is untiered. */
  readonly producerTier: string;
  /** Raw; the registry stores sanitizeDescription(description). */
  readonly description: string;
  readonly cwd: string;
  /** Git top-level realpath (TreeSnapshot.root), or undefined when unknown. */
  readonly root: string | undefined;
  /** Clock value when the dispatch started. */
  readonly dispatchedAt: number;
  readonly dod: DoD;
  readonly reference: Promise<ReferenceState>;
  /** "unavailable" when attribution failed; never [] for a failure (QA-1.6-14). */
  readonly changedFiles: readonly ChangedPath[] | "unavailable";
  readonly risk: RiskAssessment;
  readonly digests?: Promise<FileDigests | undefined>;
  /** QA-3.1-2: other dispatches live in the same git tree during this one's window; absent: none. */
  readonly concurrentDispatches?: number;
  /** QA-3.1-3: the tool whose call discarded the dispatch snapshot (the change set is then unavailable). */
  readonly contaminatedBy?: string;
  /**
   * Phase 2.1 (v2 only): the handle reserved with `reserveHandle` at the background ack. The entry starts in
   * state "held" and is excluded from listPending; `hold` names the child whose result is held.
   */
  readonly handle?: string;
  readonly hold?: HoldRef;
}

/** The held child behind a "held" entry (phase 2.1 section 2.3). */
export interface HoldRef {
  readonly childSessionID: string;
  readonly callID: string;
}

/** A record in pending.jsonl (phase 2.1 section 11.1); structurally the background journal's record. */
export type PendingRecord = { v: 1; kind: string } & Record<string, unknown>;

/** QA-2.1-33: the records one journal object's owner needs after a restart; called by every `recreate` of the shared path. */
export type PendingSnapshotProvider = () => readonly PendingRecord[] | Promise<readonly PendingRecord[]>;

/** The append-only journal seam; passed only when `ctx.routerHost === "v2"`. */
export interface PendingJournal {
  append(record: PendingRecord, opts?: { fsync?: boolean }): Promise<void>;
}

/** What a verification of one handle produced (2.4.3 builds it from the gate result). */
export interface VerificationResult {
  readonly verdict: Verdict;
  /** true -> the entry returns to "unverified" (R4); false -> "verified" (terminal). */
  readonly retryable: boolean;
  /** Proven-introduced test ids (TestsPassJudgement.failures.introduced); feeds R11. */
  readonly introduced?: readonly string[];
  /** Producer paths modified after it returned (driftedPaths); drives the drift notice. */
  readonly driftedPaths?: readonly string[];
  /** buildForcingNote's suggested next tier on a rejection. */
  readonly nextTier?: string;
  /**
   * R14, QA-2.4-3: settled by a background run. A terminal verdict that did not pass then keeps its
   * entry in the pending list (listPending) until router_verify replays it to the session
   * (markReplayed) or the TTL expires: a consumed late notice never makes it disappear.
   */
  readonly background?: boolean;
}

export interface SettledVerification extends VerificationResult {
  readonly handle: string;
  readonly settledAt: number;
}

/** A frozen snapshot of one entry (R3). */
export interface PendingEntry {
  readonly handle: string;
  readonly orchestratorSessionID: string;
  readonly dispatchID: string;
  readonly producerSessionID: string;
  readonly producerTier: string;
  readonly description: string;
  readonly cwd: string;
  readonly root: string | undefined;
  readonly dispatchedAt: number;
  /** undefined once released by a terminal settle. */
  readonly dod: DoD | undefined;
  /** Never rejects. Resolves { kind: "none", reason: RELEASED_REASON } once released. */
  readonly reference: Promise<ReferenceState>;
  readonly changedFiles: readonly ChangedPath[] | "unavailable";
  /** Paths dropped because the set exceeded MAX_STORED_CHANGED_FILES; 0 otherwise. */
  readonly changedFilesDropped: number;
  readonly risk: RiskAssessment;
  /** Never rejects; undefined when not provided or released. */
  readonly digests: Promise<FileDigests | undefined> | undefined;
  /** PendingRegistration.concurrentDispatches, as registered. */
  readonly concurrentDispatches?: number;
  /** PendingRegistration.contaminatedBy, as registered. */
  readonly contaminatedBy?: string;
  /** Set while the child's result is held until the verdict (phase 2.1). */
  readonly hold?: HoldRef;
  readonly createdAt: number;
  readonly state: PendingState;
  /** Set while state is "verifying". */
  readonly verifyingSince: number | undefined;
  /** The last settled result: terminal when "verified", retryable when back to "unverified". */
  readonly result: SettledVerification | undefined;
}

export type RegisterResult =
  | { readonly ok: true; readonly handle: string; readonly evicted: readonly string[] }
  | {
      readonly ok: false;
      readonly code: "invalid-input" | "registry-full" | "handle-collision";
      readonly detail: string;
    };

export type Lookup =
  | { readonly kind: "found"; readonly entry: PendingEntry }
  /** Evicted (TTL, cap, forgetSession) and issued to THIS session. */
  | { readonly kind: "expired"; readonly handle: string }
  /** Malformed, never issued, or issued to another session (R6). */
  | { readonly kind: "unknown"; readonly handle: string };

export type ClaimResult =
  | {
      readonly kind: "claimed";
      readonly entry: PendingEntry;
      /** Resolves when `settle` is called, the claim is reaped, or the registry is disposed. Never rejects. */
      readonly run: Promise<SettledVerification>;
      /** Single use; false when already settled, reaped or disposed (R4). */
      settle(result: VerificationResult): boolean;
    }
  | { readonly kind: "joined"; readonly entry: PendingEntry; readonly run: Promise<SettledVerification> }
  | { readonly kind: "settled"; readonly entry: PendingEntry; readonly result: SettledVerification }
  | { readonly kind: "expired"; readonly handle: string }
  | { readonly kind: "unknown"; readonly handle: string };

export type EvictionCause = "ttl" | "session-cap" | "global-cap" | "weight-cap" | "session-gone" | "disposed";

/** A proven-introduced rejection, for R11 lineage. */
export interface RejectionRecord {
  readonly orchestratorSessionID: string;
  readonly root: string;
  /** The handle, or "dispatch <dispatchID>" for a required gate. */
  readonly label: string;
  /** When the rejected producer's changes were in the tree (its return time). */
  readonly landedAt: number;
  readonly introduced: readonly string[];
}

export interface LineageQuery {
  readonly orchestratorSessionID: string;
  readonly root: string;
  readonly dispatchedAt: number;
  /** TestsPassJudgement.failures.preexisting of the delegation being judged. */
  readonly preexisting: readonly string[];
}

export interface LineageMatch {
  readonly label: string;
  /** The intersection, in `preexisting` order. */
  readonly ids: readonly string[];
}

export interface PendingRegistryStats {
  readonly entries: number;
  readonly sessions: number;
  readonly verifying: number;
  readonly weight: number;
  readonly tombstones: number;
  readonly rejections: number;
}

export interface PendingRegistryOptions {
  /** pendingTtlMs (section 1.4). */
  readonly ttlMs: number;
  /** gateBudgetMs + VERIFYING_GRACE_MS. */
  readonly maxVerifyingMs: number;
  /** Injected clock; default Date.now. */
  readonly now?: () => number;
  /** Injected random source; default crypto.randomBytes. */
  readonly random?: (bytes: number) => Uint8Array;
  readonly maxPerSession?: number;
  readonly maxGlobal?: number;
  readonly maxWeight?: number;
  /** Logging hook; never throws into the registry (a throwing hook is ignored). */
  readonly onEvict?: (entry: PendingEntry, cause: EvictionCause) => void;
  /** Phase 2.1: called once when an entry reaches its terminal "verified" state (a throwing hook is ignored). */
  readonly onVerdict?: (entry: PendingEntry, result: SettledVerification) => void;
  /** Phase 2.1, v2 only: persistence of entries and state changes. Absent on v1. */
  readonly persist?: PendingJournal;
  /** QA-2.1-4: lifetime of a reserved handle that is neither registered nor released; default HELD_RESERVATION_TTL_MS. */
  readonly reservationTtlMs?: number;
}

/**
 * QA-2.1-4: a reserved handle lives at most this long. Longer than the background sweep (ATTEMPT_SWEEP_AGE_MS, 6 h,
 * background.ts), which releases the handle of every attempt it closes, so the TTL only catches a path that never ends.
 */
export const HELD_RESERVATION_TTL_MS = 7 * 3600_000;

export interface RestoreReport {
  readonly restored: number;
  /** Held entries past pendingTtlMs, settled UNVERIFIABLE. */
  readonly expiredHeld: number;
  readonly dropped: number;
}

export interface PendingRegistry {
  /** Idempotent on `dispatchID`: a second register returns the existing entry's handle. */
  register(reg: PendingRegistration): RegisterResult;
  /** Draws a handle for a held dispatch before its entry exists; undefined when no slot is free. */
  reserveHandle(sessionID: string): string | undefined;
  /** Gives a reserved handle back (the ack failed, or the dispatch is not held after all). */
  releaseHandle(handle: string): void;
  /** The entry registered under `dispatchID` (callID), if still stored. */
  findByDispatch(dispatchID: string): PendingEntry | undefined;
  /** The session's "held" entries, newest first (they are never listed by listPending). */
  listHeld(sessionID: string): readonly PendingEntry[];
  /** True when a register for `sessionID` would find a slot (entry caps; held entries are never evicted). */
  hasSlot(sessionID: string): boolean;
  /** v2 only: rebuilds entries from pending.jsonl records (fold by key; stale ones dropped, held ones settled). */
  restore(records: readonly PendingRecord[], options: { readonly now: number }): RestoreReport;
  get(sessionID: string, handle: string): Lookup;
  listUnverified(sessionID: string, limit?: number): readonly PendingEntry[];
  listOpen(sessionID: string): readonly PendingEntry[];
  /**
   * QA-2.4-3: what the orchestrator still has to look at, newest first: unverified entries,
   * verifying ones when `verifying` is set (background mode), and verified entries whose background
   * verdict did not pass and was not yet replayed by router_verify (awaitsReplay).
   */
  listPending(sessionID: string, options?: { readonly verifying?: boolean }): readonly PendingEntry[];
  /** QA-2.4-3: router_verify reported these handles' verdicts to the session: they leave listPending. */
  markReplayed(sessionID: string, handles: readonly string[]): void;
  markVerifying(sessionID: string, handle: string): ClaimResult;
  sweep(nowMs?: number): number;
  forgetSession(sessionID: string): void;
  recordRejection(record: RejectionRecord): void;
  findLineage(query: LineageQuery): LineageMatch | undefined;
  stats(): PendingRegistryStats;
  /** QA-2.1-16 (v2 only): the `entry` and `state` records of every live entry (a vanished journal is rewritten from them). */
  persistedRecords(): PendingRecord[];
  dispose(): void;
}

export interface FooterInput {
  /**
   * The registered handle. A delegation the registry refuses is not deferred at all (QA-2.4-4: the
   * required gate runs instead), so there is no footer without a handle.
   */
  readonly handle: string;
  readonly risk: RiskAssessment;
}

export interface LateNotice {
  readonly handle: string;
  readonly description: string;
  /** Proven-introduced test ids; empty when the run named none. */
  readonly introduced: readonly string[];
  /** R14: "unverifiable" when the run could not judge the work (terminal). Default "fail". */
  readonly outcome?: "fail" | "unverifiable";
  /** R14: the first reason, shown for an unverifiable result and for a fail that names no id. */
  readonly reason?: string;
}

// ---------------------------------------------------------------------------------------------
// Text helpers (R9)
// ---------------------------------------------------------------------------------------------

// Every C0/C1 control (tab included), U+2028 and U+2029.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
// A directive key and EVERY colon that follows it on the same line, as directives.ts scans keys
// (anywhere, any case, horizontal whitespace around the colon). All colons go: dropping only the
// first would turn `VERIFY::required` into `VERIFY :required`, which parses again (QA-2.4-6).
const DIRECTIVE_KEY = /\b(VERIFY_WAIT|VERIFY|CAP)(?:[^\S\r\n\u2028\u2029]*:)+/gi;

/**
 * R9 directive safety (QA-2.4-6): every `VERIFY:` / `VERIFY_WAIT:` / `CAP:` key (any case) loses
 * its colons, so neither parseVerifyDirectives nor parseCapDirective finds a directive in the
 * result. Line breaks and everything else are kept, so it applies to multi-line router text
 * (router_verify reports, forcing notes, accepted suffixes) that quotes producer-derived text such
 * as failing test ids. Pure.
 */
export function neutralizeDirectives(text: string): string {
  return text.replace(DIRECTIVE_KEY, "$1 ");
}

/**
 * The character rules shared by every dynamic fragment: controls -> space, backtick -> `'`,
 * directive keys lose their colons (R9 directive safety), whitespace runs -> one space, trim.
 */
function sanitizeInline(text: string): string {
  return neutralizeDirectives(text.replace(CONTROL_CHARS, " ").replace(/`/g, "'"))
    .replace(/\s+/g, " ")
    .trim();
}

function formatIds(ids: readonly string[], max: number): string {
  const shown = ids.slice(0, max).map(sanitizeInline);
  const rest = ids.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} (+${rest} more)` : shown.join(", ");
}

function syntheticVerdict(reason: string): Verdict {
  return { pass: false, outcome: "unverifiable", method: "deterministic", reasons: [reason], caveats: [reason] };
}

// ---------------------------------------------------------------------------------------------
// Registry (R2-R8, R11)
// ---------------------------------------------------------------------------------------------

interface RunSlot {
  readonly promise: Promise<SettledVerification>;
  readonly resolve: (value: SettledVerification) => void;
}

interface EntryRecord {
  readonly handle: string;
  readonly seq: number;
  readonly orchestratorSessionID: string;
  readonly dispatchID: string;
  readonly producerSessionID: string;
  readonly producerTier: string;
  readonly description: string;
  readonly cwd: string;
  readonly root: string | undefined;
  readonly dispatchedAt: number;
  readonly createdAt: number;
  readonly risk: RiskAssessment;
  readonly changedFilesDropped: number;
  readonly concurrentDispatches: number | undefined;
  readonly contaminatedBy: string | undefined;
  dod: DoD | undefined;
  reference: Promise<ReferenceState>;
  changedFiles: readonly ChangedPath[] | "unavailable";
  digests: Promise<FileDigests | undefined> | undefined;
  state: PendingState;
  verifyingSince: number | undefined;
  result: SettledVerification | undefined;
  run: RunSlot | undefined;
  pathWeight: number;
  refWeight: number;
  released: boolean;
  doomed: boolean;
  live: boolean;
  /** QA-2.4-3: router_verify reported the verdict to the session (markReplayed). */
  replayed: boolean;
  /** Phase 2.1: the held child behind a "held" entry; undefined for every other entry. */
  readonly hold: HoldRef | undefined;
  /** Phase 2.1: retryable settles of a held entry so far (BACKGROUND_MAX_ATTEMPTS bound). */
  holdAttempts: number;
}

type LookupMiss = Extract<Lookup, { readonly kind: "expired" | "unknown" }>;

interface LedgerRecord {
  readonly record: RejectionRecord;
  readonly recordedAt: number;
}

function defaultRandom(bytes: number): Uint8Array {
  return randomBytes(bytes);
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRiskAssessment(value: unknown): value is RiskAssessment {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.level === "low" || v.level === "medium" || v.level === "high") &&
    Array.isArray(v.reasons) &&
    v.reasons.every((r) => typeof r === "string")
  );
}

function isChangedFiles(value: unknown): value is readonly ChangedPath[] {
  return (
    Array.isArray(value) &&
    value.every((p) => typeof p === "object" && p !== null && typeof (p as Record<string, unknown>).path === "string")
  );
}

/** A persisted definition of done; the structure is trusted past this check (written by this module). */
function isDoD(value: unknown): value is DoD {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const REFERENCE_UNRESTORED_REASON = "reference could not be restored after a restart";

export interface PendingFileJournal extends PendingJournal {
  /**
   * Every parseable record of the file, in order; a torn or invalid line and an unknown `v` are skipped. A file that is
   * missing although this process saw it, wrote it or compacted it has vanished: `load` rejects (QA-2.1-8, fail closed) until
   * `recreate` rewrites it (QA-2.1-16). Every journal of the same path in this process shares one read (QA-2.1-15).
   */
  load(): Promise<PendingRecord[]>;
  /** Resolves when every append so far has reached the file. Never rejects. */
  flush(): Promise<void>;
  /**
   * QA-2.1-8: rewrites the file with `records` only (a temp file, fsync'd, renamed over the journal), behind every
   * append so far. Afterwards the file exists, so a later missing file counts as vanished.
   */
  compact(records: readonly PendingRecord[]): Promise<void>;
  /**
   * QA-2.1-16: rewrites the journal from `records` (the caller's in-memory state: every record a later restore needs),
   * the same way as `compact` (a temp file, fsync'd, renamed over the journal; the directory is created when missing),
   * behind every append so far. It is the recovery of a vanished journal: once it resolves, the vanished state is
   * reset, so later `load` and `append` calls succeed again. Rejects (and changes nothing) when the rewrite fails;
   * the caller then stays fail closed and may retry.
   *
   * QA-2.1-33: the rewrite is the union of `records` (the caller's own state: its own provider is not asked again) and
   * the snapshot of every other journal object of the same path in this process that registered a provider
   * (`setSnapshotProvider`), one record per identity (`mergePendingSnapshots`), so one instance's recreate never drops
   * another instance's records. A provider that throws or rejects fails the recreate.
   */
  recreate(records: readonly PendingRecord[]): Promise<void>;
  /**
   * QA-2.1-33: registers (or, with undefined, removes) this journal object's snapshot provider: the records a later
   * restore needs from this object's owner. Every `recreate` of the path in this process by ANOTHER journal object calls
   * it inside the shared queue (this object's own `recreate` takes its state from `records`). Removed on `dispose`.
   */
  setSnapshotProvider(provider: PendingSnapshotProvider | undefined): void;
  /** QA-2.1-8: why the compaction at start failed (the journal then stays as it was); undefined when it did not fail. */
  readonly compactionError: string | undefined;
  /**
   * QA-2.1-22: releases this journal object after its last append. When it is the last journal of the path in this
   * process, the process's writer mark is removed. Never rejects; idempotent.
   */
  dispose(): Promise<void>;
}

export interface PendingFileJournalOptions {
  /** QA-2.1-8: compact the journal after the first successful load (default true). */
  readonly compactAtStart?: boolean;
  /** QA-2.1-8: the compaction also drops unheld entries and `inflight` records older than this (default: no age limit). */
  readonly ttlMs?: number;
  /** QA-2.1-22: told once when the compaction at start fails (`compactionError`); a throwing sink is ignored. */
  readonly warn?: (message: string) => void;
  /**
   * QA-2.1-22: another live process's writer mark older than this is stale (pid reuse) and does not block the compaction
   * at start; default WRITER_MARK_STALE_MS. A writer refreshes its mark at most every quarter of it while it appends.
   */
  readonly writerStaleMs?: number;
  /** Injected clock for the writer marks; default Date.now. */
  readonly now?: () => number;
}

/**
 * QA-2.1-22: a writer mark of another live pid older than this does not block the compaction at start (a reused pid never
 * re-stamps it). A live writer re-stamps its mark every quarter of it while it appends.
 */
export const WRITER_MARK_STALE_MS = 3600_000;

/** QA-2.1-22: the warning of a failed compaction at start (once per journal path and process). */
export const PENDING_COMPACTION_FAILED = "pending journal compaction failed";

/** The message of a `load` that finds the journal gone after this process knew it (QA-2.1-8). */
export const PENDING_JOURNAL_VANISHED = "pending journal vanished";

/** QA-2.1-8: the per-user state directory name of the pending journal. */
export const PENDING_STATE_DIRNAME = "opencode-model-router";

/**
 * QA-2.1-8: the durable per-user directory of `pending.jsonl`, `pending.claims` and `pending.writers`: never the temp directory
 * (a temp sweep would delete held results and in-flight records). `$XDG_STATE_HOME/opencode-model-router` when that variable is
 * an absolute path (not on Windows), else `<home>/.local/state/opencode-model-router` (next to the `~/.config/opencode` override
 * file, on every platform). Pure.
 */
export function resolvePendingJournalDir(env: { readonly homedir: string; readonly platform: string; readonly xdgStateHome?: string | undefined }): string {
  const xdg = env.xdgStateHome;
  if (env.platform !== "win32" && xdg !== undefined && xdg !== "" && isAbsolute(xdg)) return join(xdg, PENDING_STATE_DIRNAME);
  return join(env.homedir, ".local", "state", PENDING_STATE_DIRNAME);
}

/**
 * Phase 2.1 section 11: the append-only `pending.jsonl` (v2 only). One writer per process: every journal
 * created for the same resolved path in this process shares one append queue, one compaction and one writer
 * mark (QA-2.1-15), so two plugin instances can never drop each other's records. Appends are serialized, and
 * `fsync: true` appends reach the disk before they resolve. Appends never recreate a vanished file: once this
 * process knew the file, a missing one fails the append and the next `load` (QA-2.1-8) until `recreate`
 * rewrites it from the caller's state (QA-2.1-16).
 */
export function createPendingFileJournal(path: string, options: PendingFileJournalOptions = {}): PendingFileJournal {
  const key = sharedJournalKey(path);
  let found = SHARED_JOURNALS.get(key);
  if (found === undefined) {
    found = {
      path: resolve(path),
      tail: Promise.resolve(),
      madeDir: false,
      known: false,
      loading: undefined,
      lastRead: undefined,
      compactionScheduled: false,
      compactionError: undefined,
      compactionWarned: false,
      markAt: undefined,
      refs: 0,
      providers: new Map(),
    };
    SHARED_JOURNALS.set(key, found);
  }
  const state: SharedJournal = found;
  state.refs += 1;
  let disposed = false;
  /** QA-2.1-33: this journal object's key in `state.providers`. */
  const self = {};
  const file = state.path;
  const now = options.now ?? Date.now;
  const staleMs = options.writerStaleMs ?? WRITER_MARK_STALE_MS;
  const writersDir = join(dirname(file), PENDING_WRITERS_DIRNAME);
  const markName = `${process.pid}.${PROCESS_CLAIM_TOKEN}`;

  async function ensureFile(): Promise<void> {
    if (!state.madeDir) {
      await mkdir(dirname(file), { recursive: true });
      state.madeDir = true;
    }
    // `wx` creates the file once; afterwards the append below must find it ("a" alone would recreate a vanished file).
    if (!state.known) {
      try {
        await writeFile(file, "", { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      state.known = true;
      return;
    }
    try {
      await stat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(PENDING_JOURNAL_VANISHED);
      throw error;
    }
  }
  /** Queues `work` behind every append, compaction and rewrite of this path in this process; the queue survives a failure. */
  function enqueue(work: () => Promise<void>): Promise<void> {
    const write = state.tail.then(work);
    state.tail = write.catch((error: unknown) => {
      void error; // surfaced to this caller below; the chain keeps going for the next append
    });
    return write;
  }
  function append(record: PendingRecord, opts?: { fsync?: boolean }): Promise<void> {
    const line = `${JSON.stringify(record)}\n`;
    return enqueue(async () => {
      await ensureFile();
      await refreshMark();
      if (opts?.fsync === true) {
        const handle = await open(file, "a");
        try {
          await handle.appendFile(line, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
      } else {
        await appendFile(file, line, "utf8");
      }
    });
  }
  return {
    append,
    async flush() {
      await state.tail;
    },
    compact(records) {
      // `replaceFile` also forgets the last read: a rewrite with the same size and mtime must still be read again.
      return enqueue(() => replaceFile(records));
    },
    recreate(records) {
      // QA-2.1-16: the writers directory may have vanished with the journal, so the mark is written again right away.
      // QA-2.1-33: the snapshots are taken inside the queue, so every append queued before this rewrite is in them too.
      return enqueue(async () => {
        await replaceFile(await unionOfSnapshots(records));
        state.markAt = undefined;
        await refreshMark();
      });
    },
    setSnapshotProvider(provider) {
      if (provider === undefined || disposed) state.providers.delete(self);
      else state.providers.set(self, provider);
    },
    load() {
      // QA-2.1-8: concurrent loads share one read, and a file unchanged since the last read (size and mtime) is not read again.
      const loading = (state.loading ??= readRecords().finally(() => {
        state.loading = undefined;
      }));
      return loading.then((records) => [...records]);
    },
    get compactionError() {
      return state.compactionError;
    },
    dispose() {
      if (disposed) return Promise.resolve();
      disposed = true;
      state.providers.delete(self);
      state.refs -= 1;
      if (state.refs > 0) return Promise.resolve();
      const done = state.tail
        .then(async () => {
          // Another journal of this path may have been created while the queue drained: it keeps the mark.
          if (state.refs > 0) return;
          state.markAt = undefined;
          await rm(join(writersDir, markName), { force: true });
        })
        .catch((error: unknown) => {
          void error; // a mark that cannot be removed dies with this pid (a dead pid's mark is stale) or ages out
        })
        .finally(() => {
          if (state.refs === 0 && SHARED_JOURNALS.get(key) === state) SHARED_JOURNALS.delete(key);
        });
      state.tail = done;
      return done;
    },
  };

  async function readRecords(): Promise<readonly PendingRecord[]> {
    let info: { size: number; mtimeMs: number };
    let text: string;
    try {
      info = await stat(file);
      const last = state.lastRead;
      if (last !== undefined && last.size === info.size && last.mtimeMs === info.mtimeMs) {
        scheduleCompaction();
        return last.records;
      }
      text = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (state.known) throw new Error(PENDING_JOURNAL_VANISHED);
        return [];
      }
      throw error;
    }
    state.known = true;
    const records = parsePendingText(text);
    state.lastRead = { size: info.size, mtimeMs: info.mtimeMs, records };
    scheduleCompaction();
    return records;
  }

  function scheduleCompaction(): void {
    if (state.compactionScheduled || options.compactAtStart === false) return;
    state.compactionScheduled = true;
    void compactAtStart();
  }

  /**
   * QA-2.1-8: the first successful load in this process compacts the journal (`compactPendingRecords`), behind every append of
   * this process (one queue per path, QA-2.1-15), and only while no other live process holds a fresh writer mark on the same
   * journal (`pending.writers`): another process's append could land in the file the rename replaces. A failure keeps the
   * journal as it was (`compactionError`, told once to `warn`, QA-2.1-22).
   */
  function compactAtStart(): Promise<void> {
    const write = state.tail.then(async () => {
      if (await otherLiveWriter()) return;
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      const records = parsePendingText(text);
      const kept = compactPendingRecords(records, { now: now(), ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }) });
      if (kept.length >= records.length) return;
      await replaceFile(kept);
    });
    const settled = write.catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      state.compactionError = message;
      if (state.compactionWarned) return;
      state.compactionWarned = true;
      try {
        options.warn?.(`${PENDING_COMPACTION_FAILED}: ${message}`);
      } catch (warnError) {
        void warnError; // a throwing warn sink is ignored
      }
    });
    state.tail = settled;
    return settled;
  }

  /**
   * QA-2.1-33: `records` (the caller's own state) plus the snapshot of every OTHER journal object of this path that
   * registered a provider, in registration order: the caller's own provider is not asked again. One record per identity
   * (`mergePendingSnapshots`): the same hold or attempt reaches the union from several sources with other field values.
   * A throwing provider fails the recreate, which then changes nothing.
   */
  async function unionOfSnapshots(records: readonly PendingRecord[]): Promise<PendingRecord[]> {
    const sources: (readonly PendingRecord[])[] = [records];
    for (const [owner, provider] of [...state.providers]) {
      if (owner !== self) sources.push(await provider());
    }
    return mergePendingSnapshots(sources);
  }

  async function replaceFile(records: readonly PendingRecord[]): Promise<void> {
    const body = records.map((record) => `${JSON.stringify(record)}\n`).join("");
    await mkdir(dirname(file), { recursive: true });
    state.madeDir = true;
    const temp = `${file}.${process.pid}.compact`;
    try {
      const handle = await open(temp, "w");
      try {
        await handle.writeFile(body, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, file);
    } catch (error) {
      // QA-2.1-22: a failed write or rename leaves no temp file behind.
      await rm(temp, { force: true }).catch((cleanupError: unknown) => {
        void cleanupError; // the next rewrite opens the temp file with "w" and replaces it
      });
      throw error;
    }
    state.known = true;
    state.lastRead = undefined;
  }

  /** QA-2.1-22: writes this process's writer mark `{pid, token, at}` (`<pid>.<token>`, one per process and path). */
  async function writeMark(): Promise<void> {
    await mkdir(writersDir, { recursive: true });
    const at = now();
    await writeFile(join(writersDir, markName), `${JSON.stringify({ pid: process.pid, token: PROCESS_CLAIM_TOKEN, at })}\n`);
    state.markAt = at;
  }

  /**
   * QA-2.1-22: a writer re-stamps its mark while it appends (at most every quarter of `writerStaleMs`), so another process never
   * takes a live writer's mark for a reused pid's. Best effort: a mark that cannot be written is tried again at the next append.
   */
  async function refreshMark(): Promise<void> {
    if (state.markAt !== undefined && now() - state.markAt < staleMs / 4) return;
    try {
      await writeMark();
    } catch (error) {
      void error; // the append itself must not fail for its mark; the next append tries again
    }
  }

  /**
   * Marks this process as a writer of the journal and reports whether another live process holds a fresh mark too
   * (QA-2.1-22): a dead pid's mark, and one of this pid from an earlier process (another token), is removed; a live pid's mark
   * older than `writerStaleMs` (a reused pid: a live writer re-stamps its mark while it appends) does not block.
   */
  async function otherLiveWriter(): Promise<boolean> {
    await writeMark();
    let other = false;
    for (const name of await readdir(writersDir)) {
      if (name === markName) continue;
      const pid = Number.parseInt(name.split(".")[0] ?? "", 10);
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && isAlive(pid)) {
        const age = await markAge(join(writersDir, name));
        if (age !== undefined && age <= staleMs) other = true;
        continue;
      }
      await rm(join(writersDir, name), { force: true });
    }
    return other;
  }

  /** The age of a writer mark (its `at`, else its mtime); undefined when it is gone. */
  async function markAge(markPath: string): Promise<number | undefined> {
    let text: string;
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(markPath)).mtimeMs;
      text = await readFile(markPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    return now() - (parseMarkAt(text) ?? mtimeMs);
  }
}

/** QA-2.1-15: the state every journal of one path in this process shares (one append queue, one compaction, one mark). */
interface SharedJournal {
  readonly path: string;
  tail: Promise<unknown>;
  madeDir: boolean;
  /** This process read, wrote or compacted the file: from now on a missing file has vanished (until `recreate`). */
  known: boolean;
  /** QA-2.1-8: the read in flight (shared) and the last read with the file's size and mtime (not read again while unchanged). */
  loading: Promise<readonly PendingRecord[]> | undefined;
  lastRead: { size: number; mtimeMs: number; records: readonly PendingRecord[] } | undefined;
  compactionScheduled: boolean;
  compactionError: string | undefined;
  compactionWarned: boolean;
  /** When this process last wrote its writer mark; undefined: not written since the start, `recreate` or `dispose`. */
  markAt: number | undefined;
  /** Journal objects of this path in this process that are not disposed. */
  refs: number;
  /** QA-2.1-33: the snapshot provider of each journal object of this path that registered one (`setSnapshotProvider`). */
  readonly providers: Map<object, PendingSnapshotProvider>;
}

/** QA-2.1-15: one shared journal state per resolved path in this process (case-insensitive on Windows). */
const SHARED_JOURNALS = new Map<string, SharedJournal>();

/**
 * QA-2.1-16/-33: what identifies a record a recreation rewrites from memory: its kind and its attempt key, else its handle
 * (`hold`, `hold-text`, `posting`, `posted`, entry and state records). Undefined for a record with neither. Pure.
 */
export function pendingRecordIdentity(record: { readonly kind: string; readonly [field: string]: unknown }): string | undefined {
  const id = typeof record.key === "string" ? record.key : typeof record.handle === "string" ? record.handle : undefined;
  return id === undefined ? undefined : `${record.kind}\u0000${id}`;
}

/**
 * QA-2.1-33: merges record lists (the caller's state, then each other instance's snapshot) into one list with one record
 * per identity (`pendingRecordIdentity`; a record without one is identified by its serialized form), whichever list or
 * position it comes from: the same hold may arrive from the adapter, the plugin and another instance with other field
 * values or field order. Of one identity the newest record (`at`) is kept, on a tie the most complete one (more fields),
 * else the first; it takes the position of the first occurrence, so the order of the first list is kept. Pure.
 */
export function mergePendingSnapshots(lists: ReadonlyArray<readonly PendingRecord[]>): PendingRecord[] {
  const positions = new Map<string, number>();
  const union: PendingRecord[] = [];
  for (const list of lists) {
    for (const record of list) {
      const id = pendingRecordIdentity(record) ?? `json\u0000${JSON.stringify(record)}`;
      const position = positions.get(id);
      if (position === undefined) {
        positions.set(id, union.length);
        union.push(record);
        continue;
      }
      const kept = union[position];
      if (kept === undefined || supersedes(record, kept)) union[position] = record;
    }
  }
  return union;
}

/** QA-2.1-33: whether `candidate` replaces `kept` (same identity): a newer `at`, else (same or no `at`) more fields. */
function supersedes(candidate: PendingRecord, kept: PendingRecord): boolean {
  const next = typeof candidate.at === "number" && Number.isFinite(candidate.at) ? candidate.at : undefined;
  const prev = typeof kept.at === "number" && Number.isFinite(kept.at) ? kept.at : undefined;
  if (next !== undefined && prev !== undefined && next !== prev) return next > prev;
  if (next !== undefined && prev === undefined) return true;
  if (next === undefined && prev !== undefined) return false;
  return Object.keys(candidate).length > Object.keys(kept).length;
}

/** QA-2.1-22: the directory of the writer marks, next to `pending.jsonl`. */
export const PENDING_WRITERS_DIRNAME = "pending.writers";

function sharedJournalKey(path: string): string {
  const full = resolve(path);
  return process.platform === "win32" ? full.toLowerCase() : full;
}

function parseMarkAt(text: string): number | undefined {
  try {
    const rec: unknown = JSON.parse(text);
    if (typeof rec !== "object" || rec === null) return undefined;
    const at = (rec as Record<string, unknown>).at;
    return typeof at === "number" && Number.isFinite(at) ? at : undefined;
  } catch (error) {
    void error; // a torn mark: its mtime decides
    return undefined;
  }
}

/** Parses `pending.jsonl` text: a torn or invalid line and an unknown `v` are skipped. */
function parsePendingText(text: string): PendingRecord[] {
  const records: PendingRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      void error; // a torn line (crash mid-write) is skipped
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const rec = parsed as Record<string, unknown>;
    if (rec.v !== 1 || typeof rec.kind !== "string") continue;
    records.push({ ...rec, v: 1, kind: rec.kind });
  }
  return records;
}

/** `process.kill(pid, 0)`: alive, or alive but not ours (EPERM). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * QA-2.1-8: the records of `pending.jsonl` that still matter, in journal order. The pending registry's `restore` and
 * `foldDormantRecords` read the result exactly as they read the full journal: superseded `entry`/`ref`/`state` records, entries
 * that ended `verified`, everything a `tomb` or a `forget` closed (and those records themselves), `inflight` records closed by
 * `processed` (and every `processed` record: no attempt of an earlier process survives to need its key), the `hold-text` and
 * older `posting` records of a hold, the follow-ups of a posted hold (its `hold` and `posted` stay: an inactive placeholder,
 * QA-2.1-10), and records that change nothing (a `state` or follow-up of an unknown handle) are dropped. With `ttlMs`, unheld
 * entries and `inflight` records older than it go too (the readers drop them anyway). Unknown kinds are kept. Pure.
 */
export function compactPendingRecords(records: readonly PendingRecord[], opts: { now: number; ttlMs?: number }): PendingRecord[] {
  const keep = records.map(() => true);
  const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
  const parentOf = (rec: PendingRecord): string | undefined => str(rec.parent) ?? str(rec.parentSessionID);
  const childOf = (rec: PendingRecord): string | undefined => str(rec.child) ?? str(rec.childSessionID);
  const drop = (...indexes: Array<number | undefined>): void => {
    for (const index of indexes) if (index !== undefined) keep[index] = false;
  };
  const entries = new Map<string, { entry: number; ref?: number; state?: number; stateValue: string; parent?: string; held: boolean; at: number }>();
  const holds = new Map<string, { hold: number; text?: number; posting?: number; posted?: number; parent?: string }>();
  const inflight = new Map<string, { index: number; parent?: string; at: number }>();
  const dropEntry = (handle: string): void => {
    const e = entries.get(handle);
    if (e !== undefined) drop(e.entry, e.ref, e.state);
    entries.delete(handle);
  };
  const dropHold = (handle: string): void => {
    const h = holds.get(handle);
    if (h !== undefined) drop(h.hold, h.text, h.posting, h.posted);
    holds.delete(handle);
  };
  records.forEach((rec, index) => {
    const handle = str(rec.handle);
    const callID = str(rec.callID);
    switch (rec.kind) {
      case "entry": {
        if (handle === undefined) return;
        dropEntry(handle);
        const at = typeof rec.createdAt === "number" ? rec.createdAt : opts.now;
        const parent = str(rec.parent);
        entries.set(handle, {
          entry: index, stateValue: str(rec.state) ?? "unverified", held: rec.state === "held", at, ...(parent === undefined ? {} : { parent }),
        });
        return;
      }
      case "ref": {
        const e = handle === undefined ? undefined : entries.get(handle);
        // A ref with no stored entry of its handle applies by `callID` in `restore`: kept as it is.
        if (e === undefined) return;
        drop(e.ref);
        e.ref = index;
        return;
      }
      case "state": {
        const e = handle === undefined ? undefined : entries.get(handle);
        if (e === undefined || typeof rec.state !== "string" || rec.state === "") {
          drop(index);
          return;
        }
        drop(e.state);
        e.state = index;
        e.stateValue = rec.state;
        return;
      }
      case "tomb": {
        // QA-2.1-28: a tomb ends a pending ENTRY (TTL, eviction, session gone). A hold is the adapter's and ends only with
        // `posted` (then an inactive placeholder) or `forget`: a tomb never takes the placeholder that hides the raw completion.
        if (handle !== undefined) dropEntry(handle);
        if (callID !== undefined) {
          drop(inflight.get(callID)?.index);
          inflight.delete(callID);
        }
        drop(index);
        return;
      }
      case "forget": {
        const session = str(rec.session);
        if (session !== undefined) {
          for (const [h, e] of [...entries]) if (e.parent === session) dropEntry(h);
          for (const [h, v] of [...holds]) if (v.parent === session) dropHold(h);
          for (const [c, v] of [...inflight]) {
            if (v.parent !== session) continue;
            drop(v.index);
            inflight.delete(c);
          }
        }
        drop(index);
        return;
      }
      case "inflight": {
        // `foldDormantRecords` takes an inflight record only with a call, a parent and a child; any other changes nothing.
        if (callID === undefined || parentOf(rec) === undefined || childOf(rec) === undefined) return;
        drop(inflight.get(callID)?.index);
        const parent = parentOf(rec);
        inflight.set(callID, { index, at: typeof rec.at === "number" ? rec.at : 0, ...(parent === undefined ? {} : { parent }) });
        return;
      }
      case "processed": {
        if (callID !== undefined) {
          drop(inflight.get(callID)?.index);
          inflight.delete(callID);
        }
        drop(index);
        return;
      }
      case "hold": {
        if (handle === undefined || parentOf(rec) === undefined || childOf(rec) === undefined) return;
        dropHold(handle);
        const parent = parentOf(rec);
        holds.set(handle, { hold: index, ...(parent === undefined ? {} : { parent }) });
        return;
      }
      case "hold-text":
      case "posting": {
        const h = handle === undefined ? undefined : holds.get(handle);
        if (h === undefined || h.posted !== undefined) {
          drop(index);
          return;
        }
        if (rec.kind === "hold-text") {
          drop(h.text);
          h.text = index;
        } else {
          drop(h.posting);
          h.posting = index;
        }
        return;
      }
      case "posted": {
        const h = handle === undefined ? undefined : holds.get(handle);
        if (h === undefined) {
          drop(index);
          return;
        }
        drop(h.text, h.posting, h.posted);
        h.text = undefined;
        h.posting = undefined;
        h.posted = index;
        return;
      }
      default:
        return;
    }
  });
  for (const [handle, e] of entries) {
    if (e.stateValue === "verified") {
      // QA-2.1-17: the verdict of a hold that never started posting stays (its entry and `state`): the next start posts it.
      const h = holds.get(handle);
      if (h === undefined || h.posting !== undefined || h.posted !== undefined) dropEntry(handle);
    } else if (opts.ttlMs !== undefined && !e.held && opts.now - e.at >= opts.ttlMs) dropEntry(handle);
  }
  if (opts.ttlMs !== undefined) {
    for (const v of inflight.values()) if (opts.now - v.at > opts.ttlMs) drop(v.index);
  }
  // QA-2.1-28: the cap `foldDormantRecords` applies at load applies here too: past MAX_DORMANT_POSTED_HOLDS posted
  // placeholders, the oldest go (their `hold` and `posted` lines); an unposted hold is never dropped (no age, as at load).
  let postedHolds = 0;
  for (const h of holds.values()) if (h.posted !== undefined) postedHolds += 1;
  for (const [handle, h] of [...holds]) {
    if (postedHolds <= MAX_DORMANT_POSTED_HOLDS) break;
    if (h.posted === undefined) continue;
    dropHold(handle);
    postedHolds -= 1;
  }
  return records.filter((_, index) => keep[index]);
}

// ---- Phase 2.1 section 11.3: reload of the in-flight / hold records (v2 only) -----------------------------------------

/** The records of one parent session that survived a restart; dormant until the new process sees that session. */
export interface DormantSession {
  /**
   * `hold` records not tombstoned or forgotten (no TTL, section 11.3), each followed by its `hold-text` and newest `posting`
   * record, or, for a posted hold, by its `posted` record only (an inactive placeholder, QA-2.1-10). In journal order per hold.
   */
  holds: PendingRecord[];
  /** `inflight` records without a `processed` record, younger than the TTL. */
  inflight: PendingRecord[];
}

/** The idempotency key of a `processed` record: its `key`, else `child NUL callID` (section 10). */
export function processedKeyOf(record: Readonly<Record<string, unknown>>): string | undefined {
  if (typeof record.key === "string" && record.key !== "") return record.key;
  if (typeof record.child === "string" && typeof record.callID === "string") return `${record.child}\u0000${record.callID}`;
  return undefined;
}

/**
 * Folds the parsed records of `pending.jsonl` (section 11.3): `forget` removes a session's earlier records, `processed` closes an
 * `inflight`, `posted` turns a `hold` into an inactive placeholder, and a tombstoned `callID` closes its `inflight` (QA-2.1-28: a
 * `tomb` never closes a hold). Inflight records older than `ttlMs` are dropped; hold records never expire. Pure.
 */
export function foldDormantRecords(
  records: readonly PendingRecord[],
  opts: { now: number; ttlMs: number },
): { sessions: Map<string, DormantSession>; processed: Set<string> } {
  const processed = new Set<string>();
  const inflight = new Map<string, PendingRecord>();
  /** handle -> the `hold` record, then its follow-ups (`hold-text`, the newest `posting`, `posted`). */
  const holds = new Map<string, { hold: PendingRecord; text?: PendingRecord; posting?: PendingRecord; posted?: PendingRecord }>();
  /** QA-2.1-17: handle -> the newest `state` record that settled its entry `verified` with a verdict. */
  const verdicts = new Map<string, PendingRecord>();
  const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
  /** The adapter writes `parentSessionID` / `childSessionID` on `inflight`, `parent` / `child` on `hold`: both are read. */
  const parentOf = (rec: PendingRecord): string | undefined => str(rec.parent) ?? str(rec.parentSessionID);
  const childOf = (rec: PendingRecord): string | undefined => str(rec.child) ?? str(rec.childSessionID);
  for (const rec of records) {
    switch (rec.kind) {
      case "inflight": {
        const callID = str(rec.callID);
        if (callID !== undefined && parentOf(rec) !== undefined && childOf(rec) !== undefined) inflight.set(callID, rec);
        break;
      }
      case "processed": {
        const key = processedKeyOf(rec);
        if (key !== undefined) processed.add(key);
        const callID = str(rec.callID);
        if (callID !== undefined) inflight.delete(callID);
        break;
      }
      case "hold": {
        const handle = str(rec.handle);
        if (handle !== undefined && parentOf(rec) !== undefined && childOf(rec) !== undefined) holds.set(handle, { hold: rec });
        break;
      }
      case "hold-text": {
        const held = holds.get(str(rec.handle) ?? "");
        if (held !== undefined && held.posted === undefined && typeof rec.text === "string") held.text = rec;
        break;
      }
      case "posting": {
        const held = holds.get(str(rec.handle) ?? "");
        if (held !== undefined && held.posted === undefined) held.posting = rec;
        break;
      }
      case "state": {
        const handle = str(rec.handle);
        if (handle !== undefined && rec.state === "verified" && rec.verdict !== null && typeof rec.verdict === "object") verdicts.set(handle, rec);
        break;
      }
      case "posted": {
        // QA-2.1-10: a posted hold survives as an inactive placeholder (the host history still holds the raw completion).
        const held = holds.get(str(rec.handle) ?? "");
        if (held !== undefined) holds.set(str(rec.handle) ?? "", { hold: held.hold, posted: rec });
        break;
      }
      case "tomb": {
        // QA-2.1-28: an entry tomb never closes a hold (its placeholder, or a hold still owed a verdict): see compaction.
        const callID = str(rec.callID);
        if (callID !== undefined) inflight.delete(callID);
        break;
      }
      case "forget": {
        const session = str(rec.session);
        if (session === undefined) break;
        for (const [key, value] of inflight) if (parentOf(value) === session) inflight.delete(key);
        for (const [key, value] of holds) if (parentOf(value.hold) === session) holds.delete(key);
        break;
      }
      default:
        break;
    }
  }
  // Posted placeholders are bounded (newest kept); an unposted hold is never dropped here.
  let posted = 0;
  for (const value of holds.values()) if (value.posted !== undefined) posted += 1;
  for (const [key, value] of holds) {
    if (posted <= MAX_DORMANT_POSTED_HOLDS) break;
    if (value.posted === undefined) continue;
    holds.delete(key);
    posted -= 1;
  }
  const sessions = new Map<string, DormantSession>();
  const sessionOf = (parent: string): DormantSession => {
    let session = sessions.get(parent);
    if (session === undefined) {
      session = { holds: [], inflight: [] };
      sessions.set(parent, session);
    }
    return session;
  };
  for (const rec of inflight.values()) {
    const at = typeof rec.at === "number" ? rec.at : 0;
    if (opts.now - at > opts.ttlMs) continue;
    sessionOf(parentOf(rec) ?? "").inflight.push(rec);
  }
  for (const [handle, value] of holds) {
    const list = sessionOf(parentOf(value.hold) ?? "").holds;
    list.push(value.hold);
    if (value.text !== undefined) list.push(value.text);
    if (value.posting !== undefined) list.push(value.posting);
    if (value.posted !== undefined) list.push(value.posted);
    // QA-2.1-17: a verdict the gate reached (its entry's `verified` state) but never started posting is handed over with the
    // hold, so the adopter posts it instead of running the gate again.
    const verdict = verdicts.get(handle);
    if (verdict !== undefined && value.posting === undefined && value.posted === undefined) list.push(verdict);
  }
  return { sessions, processed };
}

/** Posted holds kept as inactive placeholders across a restart (QA-2.1-10); = MAX_HOLDS_GLOBAL (background.ts). */
export const MAX_DORMANT_POSTED_HOLDS = 10_000;

/**
 * Section 11.3: the exclusive claim file `<claimsDir>\<id>` (`wx`, `{pid, at}`) that stops two host processes from verifying or
 * posting for one session twice. A claim of a dead pid (or of this process) is stale and is taken over. True when this process owns it.
 */
export function claimPendingSession(
  claimsDir: string,
  sessionID: string,
  seams: {
    pid: number;
    now: number;
    isAlive(pid: number): boolean;
    /** Identifies this process beyond its pid (QA-2.1-13, PID reuse); default: one random token per module load. */
    token?: string;
    /** A live pid's claim older than this is taken over (a reused pid never refreshes it); default `CLAIM_STALE_MS`. */
    staleMs?: number;
  },
): boolean {
  const file = join(claimsDir, encodeURIComponent(sessionID));
  const token = seams.token ?? PROCESS_CLAIM_TOKEN;
  const body = `${JSON.stringify({ pid: seams.pid, token, at: seams.now })}\n`;
  mkdirSync(claimsDir, { recursive: true });
  try {
    writeFileSync(file, body, { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const owner = readClaim(file);
  // QA-2.1-13: a claim of this pid is this process's own or that of a dead process whose pid this one reuses (its token
  // differs): taken either way. Another pid refuses while it is alive and its claim is fresh; a live pid whose claim is older
  // than `staleMs` is most likely a reused pid (a live owner re-stamps its claims, `refreshPendingClaims`). The token never
  // makes another live pid's claim ours: two processes of one test share the module token.
  const fresh = owner?.at !== undefined && seams.now - owner.at <= (seams.staleMs ?? CLAIM_STALE_MS);
  if (owner?.pid !== undefined && owner.pid !== seams.pid && fresh && seams.isAlive(owner.pid)) return false;
  // QA-2.1-19: a claim of this pid under the token of ANOTHER live plugin instance of this process is that instance's.
  if (owner?.pid === seams.pid && owner.token !== undefined && owner.token !== token && LIVE_INSTANCE_TOKENS.has(owner.token)) return false;
  writeFileSync(file, body);
  return true;
}

/** QA-2.1-19: the claim tokens of the live plugin instances of this process (`createInstanceClaimToken`). */
const LIVE_INSTANCE_TOKENS = new Set<string>();

/**
 * QA-2.1-19: a claim token for one plugin instance. While it is not released, a claim this process wrote under it is
 * refused to every other instance of the process (`claimPendingSession`); once released (dispose), the claim is stale for
 * them and is taken over. Idempotent release.
 */
export function createInstanceClaimToken(): { readonly token: string; release(): void } {
  const token = `${PROCESS_CLAIM_TOKEN}.${toHex(randomBytes(4))}`;
  LIVE_INSTANCE_TOKENS.add(token);
  return { token, release: () => { LIVE_INSTANCE_TOKENS.delete(token); } };
}

/**
 * QA-2.1-13/-34: a claim of another pid older than this no longer protects it, even while that pid is alive: a live owner
 * re-stamps its claims every `CLAIM_REFRESH_MS` (`refreshPendingClaims`), so a claim this old belongs to a crashed process
 * whose pid was reused.
 */
export const CLAIM_STALE_MS = 5 * 60_000;
/** QA-2.1-34: how often a live owner re-stamps its claims; well within `CLAIM_STALE_MS`. */
export const CLAIM_REFRESH_MS = 60_000;

/** One token per module load: two processes that share a pid over time never share a token. */
const PROCESS_CLAIM_TOKEN = toHex(randomBytes(8));

function readClaim(file: string): { pid?: number; token?: string; at?: number } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    // An unreadable or vanished claim is stale; whoever claims next rewrites it.
    void error;
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const rec = parsed as Record<string, unknown>;
  return {
    ...(typeof rec.pid === "number" ? { pid: rec.pid } : {}),
    ...(typeof rec.token === "string" ? { token: rec.token } : {}),
    ...(typeof rec.at === "number" ? { at: rec.at } : {}),
  };
}

/**
 * QA-2.1-13: gives a session's claim back (session deleted, process disposing). Only this process's own claim (its token) is
 * removed; a claim another process took over stays. Never throws.
 */
export function releasePendingClaim(claimsDir: string, sessionID: string, token: string = PROCESS_CLAIM_TOKEN): boolean {
  const file = join(claimsDir, encodeURIComponent(sessionID));
  if (readClaim(file)?.token !== token) return false;
  try {
    rmSync(file, { force: true });
    return true;
  } catch (error) {
    void error; // a claim that cannot be removed goes stale after CLAIM_STALE_MS
    return false;
  }
}

/** QA-2.1-13: re-stamps this process's claims so a live owner never looks stale. Never throws. */
export function refreshPendingClaims(claimsDir: string, sessionIDs: Iterable<string>, seams: { pid: number; now: number; token?: string }): void {
  const token = seams.token ?? PROCESS_CLAIM_TOKEN;
  for (const sessionID of sessionIDs) {
    const file = join(claimsDir, encodeURIComponent(sessionID));
    if (readClaim(file)?.token !== token) continue;
    try {
      writeFileSync(file, `${JSON.stringify({ pid: seams.pid, token, at: seams.now })}\n`);
    } catch (error) {
      void error; // a claim that cannot be refreshed goes stale; the next claim attempt decides again
    }
  }
}

/**
 * Eviction order (R7, QA-2.4-4): verified entries only, oldest first. An unverified or verifying
 * entry is never evicted by a cap: its delegation would leave the pending list silently and read as
 * verified. A cap that only such entries fill refuses the new registration ("registry-full"), and
 * the dispatch then runs the required gate instead.
 */
function evictionCandidates(records: Iterable<EntryRecord>): EntryRecord[] {
  const byAge = (a: EntryRecord, b: EntryRecord): number => a.createdAt - b.createdAt || a.seq - b.seq;
  return [...records].filter((r) => r.state === "verified" && !awaitsReplay(r)).sort(byAge);
}

/**
 * QA-2.4-3: a background verdict that did not pass and that router_verify has not yet replayed to
 * the session. It stays listed (and, like an unverified entry, is never evicted by a cap) until the
 * replay or the TTL: the one-shot late notice may never have reached the orchestrator.
 */
function awaitsReplay(rec: EntryRecord): boolean {
  if (rec.state !== "verified" || rec.replayed || rec.result?.background !== true) return false;
  const verdict = rec.result.verdict;
  return (verdict.outcome ?? (verdict.pass ? "pass" : "fail")) !== "pass";
}

/** R2-R8, R11. */
export function createPendingRegistry(options: PendingRegistryOptions): PendingRegistry {
  const now = options.now ?? Date.now;
  const random = options.random ?? defaultRandom;
  const maxPerSession = options.maxPerSession ?? MAX_ENTRIES_PER_SESSION;
  const maxGlobal = options.maxGlobal ?? MAX_ENTRIES_GLOBAL;
  const maxWeight = options.maxWeight ?? MAX_GLOBAL_WEIGHT;
  const { ttlMs, maxVerifyingMs } = options;

  const sessions = new Map<string, Map<string, EntryRecord>>();
  const byHandle = new Map<string, EntryRecord>();
  /** handle -> the session it was issued to; insertion order = FIFO. */
  const tombstones = new Map<string, string>();
  const ledger = new Map<string, LedgerRecord[]>();
  const counters = { seq: 0, weight: 0, hookFailures: 0 };
  /** Phase 2.1: dispatchID -> the entry registered under it (idempotent register, findByDispatch). */
  const byDispatch = new Map<string, EntryRecord>();
  /** Phase 2.1: handles drawn by reserveHandle and neither registered nor released: handle -> session. */
  const reserved = new Map<string, string>();
  /** QA-2.1-4: when each reservation was drawn; `maintain` drops it after `reservationTtlMs`. */
  const reservedAt = new Map<string, number>();
  const reservationTtlMs = options.reservationTtlMs ?? HELD_RESERVATION_TTL_MS;
  const persist = options.persist;

  function reservedCount(sessionID: string | undefined, except: string | undefined): number {
    let n = 0;
    for (const [handle, sid] of reserved) {
      if (handle !== except && (sessionID === undefined || sid === sessionID)) n += 1;
    }
    return n;
  }

  /** Appends to pending.jsonl (v2 only); a journal failure is counted, never thrown into the registry. */
  function journal(record: PendingRecord, opts?: { fsync?: boolean }): void {
    if (persist === undefined) return;
    try {
      void persist.append(record, opts).catch(() => {
        counters.hookFailures += 1;
      });
    } catch {
      counters.hookFailures += 1;
    }
  }

  function persistEntry(rec: EntryRecord): void {
    if (persist === undefined) return;
    journal(entryRecord(rec), { fsync: rec.hold !== undefined });
  }

  function entryRecord(rec: EntryRecord): PendingRecord {
    return {
        v: 1,
        kind: "entry",
        handle: rec.handle,
        parent: rec.orchestratorSessionID,
        child: rec.hold?.childSessionID ?? rec.producerSessionID,
        callID: rec.dispatchID,
        producer: rec.producerSessionID,
        tier: rec.producerTier,
        dod: rec.dod ?? null,
        changedFiles: rec.changedFiles,
        changedFilesDropped: rec.changedFilesDropped,
        reference: null,
        risk: rec.risk,
        description: rec.description,
        root: rec.root ?? null,
        cwd: rec.cwd,
        state: rec.state,
        createdAt: rec.createdAt,
        dispatchedAt: rec.dispatchedAt,
        ...(rec.concurrentDispatches !== undefined ? { concurrentDispatches: rec.concurrentDispatches } : {}),
        ...(rec.contaminatedBy !== undefined ? { contaminatedBy: rec.contaminatedBy } : {}),
    };
  }

  function persistReference(rec: EntryRecord, reference: DispatchReference): void {
    if (persist === undefined) return;
    journal({ v: 1, kind: "ref", handle: rec.handle, callID: rec.dispatchID, reference: serializeReference(reference) });
  }

  function persistState(rec: EntryRecord, at: number): void {
    if (persist === undefined) return;
    journal(stateRecord(rec, at));
  }

  function stateRecord(rec: EntryRecord, at: number): PendingRecord {
    return {
      v: 1,
      kind: "state",
      handle: rec.handle,
      state: rec.state,
      at,
      ...(rec.state === "verified" && rec.result !== undefined ? { verdict: rec.result.verdict } : {}),
    };
  }

  /** QA-2.1-16: the `entry` and `state` records of every live entry, for rewriting a vanished journal. */
  function persistedRecords(): PendingRecord[] {
    const at = now();
    const out: PendingRecord[] = [];
    for (const rec of byHandle.values()) {
      if (!rec.live) continue;
      out.push(entryRecord(rec), stateRecord(rec, at));
    }
    return out;
  }

  function hasSlot(sessionID: string): boolean {
    maintain(now());
    const session = sessions.get(sessionID);
    const evictableHere = session === undefined ? 0 : evictionCandidates(session.values()).length;
    if ((session?.size ?? 0) + reservedCount(sessionID, undefined) - evictableHere + 1 > maxPerSession) return false;
    const evictable = evictionCandidates(byHandle.values()).length;
    return byHandle.size + reservedCount(undefined, undefined) - evictable + 1 <= maxGlobal;
  }

  function reserveHandle(sessionID: string): string | undefined {
    if (!isNonEmptyString(sessionID) || !hasSlot(sessionID)) return undefined;
    const handle = drawHandle();
    if (handle === undefined) return undefined;
    reserved.set(handle, sessionID);
    reservedAt.set(handle, now());
    return handle;
  }

  function unreserve(handle: string): void {
    reserved.delete(handle);
    reservedAt.delete(handle);
  }

  function snapshot(rec: EntryRecord): PendingEntry {
    return Object.freeze({
      handle: rec.handle,
      orchestratorSessionID: rec.orchestratorSessionID,
      dispatchID: rec.dispatchID,
      producerSessionID: rec.producerSessionID,
      producerTier: rec.producerTier,
      description: rec.description,
      cwd: rec.cwd,
      root: rec.root,
      dispatchedAt: rec.dispatchedAt,
      dod: rec.dod,
      reference: rec.reference,
      changedFiles: rec.changedFiles,
      changedFilesDropped: rec.changedFilesDropped,
      risk: rec.risk,
      digests: rec.digests,
      ...(rec.concurrentDispatches !== undefined ? { concurrentDispatches: rec.concurrentDispatches } : {}),
      ...(rec.contaminatedBy !== undefined ? { contaminatedBy: rec.contaminatedBy } : {}),
      ...(rec.hold !== undefined ? { hold: rec.hold } : {}),
      createdAt: rec.createdAt,
      state: rec.state,
      verifyingSince: rec.verifyingSince,
      result: rec.result,
    });
  }

  function addTombstone(handle: string, sessionID: string): void {
    tombstones.delete(handle);
    tombstones.set(handle, sessionID);
    while (tombstones.size > TOMBSTONE_MAX) {
      const oldest = tombstones.keys().next();
      if (oldest.done === true) break;
      tombstones.delete(oldest.value);
    }
  }

  function evict(rec: EntryRecord, cause: EvictionCause): void {
    if (!rec.live) return;
    rec.live = false;
    const session = sessions.get(rec.orchestratorSessionID);
    session?.delete(rec.handle);
    if (session !== undefined && session.size === 0) sessions.delete(rec.orchestratorSessionID);
    byHandle.delete(rec.handle);
    if (byDispatch.get(rec.dispatchID) === rec) byDispatch.delete(rec.dispatchID);
    counters.weight -= rec.pathWeight + rec.refWeight;
    addTombstone(rec.handle, rec.orchestratorSessionID);
    // A disposed or forgotten entry is not dead on disk: dispose keeps held entries for the next start,
    // and forget has its own record.
    if (cause !== "disposed" && cause !== "session-gone") {
      journal({ v: 1, kind: "tomb", handle: rec.handle, cause, at: now() });
    }
    const hook = options.onEvict;
    if (hook === undefined) return;
    try {
      hook(snapshot(rec), cause);
    } catch {
      // A logging hook must never break the registry (PendingRegistryOptions.onEvict).
      counters.hookFailures += 1;
    }
  }

  function release(rec: EntryRecord): void {
    counters.weight -= rec.pathWeight + rec.refWeight;
    rec.pathWeight = 0;
    rec.refWeight = 0;
    rec.released = true;
    rec.dod = undefined;
    rec.digests = undefined;
    rec.changedFiles = "unavailable";
    rec.reference = Promise.resolve<ReferenceState>({ kind: "none", reason: RELEASED_REASON });
  }

  function isExpired(rec: EntryRecord, at: number): boolean {
    return at - rec.createdAt >= ttlMs;
  }

  function recordRejection(record: RejectionRecord): void {
    if (!isNonEmptyString(record.orchestratorSessionID) || !isNonEmptyString(record.root)) return;
    if (record.introduced.length === 0) return;
    const stored: RejectionRecord = Object.freeze({
      orchestratorSessionID: record.orchestratorSessionID,
      root: record.root,
      label: record.label,
      landedAt: record.landedAt,
      introduced: Object.freeze(record.introduced.slice(0, MAX_LEDGER_IDS)),
    });
    // QA-2.4-1: router_verify records a call's rejections before it settles them, and settle records
    // again: one record per label and root, the newest kept.
    const list = (ledger.get(record.orchestratorSessionID) ?? []).filter(
      (l) => l.record.label !== record.label || l.record.root !== record.root,
    );
    list.push({ record: stored, recordedAt: now() });
    while (list.length > MAX_LEDGER_PER_SESSION) list.shift();
    ledger.set(record.orchestratorSessionID, list);
  }

  /** Resolves a run and moves the entry out of "verifying" (settle, reap). */
  function finishRun(rec: EntryRecord, settledIn: SettledVerification): void {
    const run = rec.run;
    let settled = settledIn;
    if (settled.retryable && rec.hold !== undefined) {
      // Phase 2.1: a held entry retries up to BACKGROUND_MAX_ATTEMPTS, then ends UNVERIFIABLE.
      rec.holdAttempts += 1;
      if (rec.holdAttempts >= BACKGROUND_MAX_ATTEMPTS) {
        settled = Object.freeze({
          verdict: syntheticVerdict(HELD_EXHAUSTED_REASON),
          retryable: false,
          handle: settled.handle,
          settledAt: settled.settledAt,
        });
      }
    }
    rec.run = undefined;
    rec.verifyingSince = undefined;
    rec.result = settled;
    if (settled.retryable) {
      rec.state = rec.hold !== undefined ? "held" : "unverified";
    } else {
      rec.state = "verified";
      release(rec);
    }
    persistState(rec, settled.settledAt);
    run?.resolve(settled);
    if (!settled.retryable && options.onVerdict !== undefined) {
      try {
        options.onVerdict(snapshot(rec), settled);
      } catch {
        // A verdict hook must never break the registry (PendingRegistryOptions.onVerdict).
        counters.hookFailures += 1;
      }
    }
  }

  /** Reaping, TTL eviction and ledger expiry (R7). Returns the number of evicted entries. */
  function maintain(at: number): number {
    let evicted = 0;
    // QA-2.1-4: a reservation nobody registered nor released (a lost ack, a crashed path) frees its slot after the TTL.
    for (const [handle, since] of [...reservedAt]) if (at - since >= reservationTtlMs) unreserve(handle);
    for (const rec of [...byHandle.values()]) {
      if (rec.state === "verifying" && rec.verifyingSince !== undefined && rec.verifyingSince + maxVerifyingMs <= at) {
        finishRun(rec, {
          verdict: syntheticVerdict(ABANDONED_REASON),
          retryable: true,
          handle: rec.handle,
          settledAt: at,
        });
      }
      if (rec.state === "verifying") continue;
      if (rec.state === "held" && !rec.doomed && isExpired(rec, at)) {
        // A held entry is never evicted by a TTL: its verdict ends UNVERIFIABLE and is posted.
        finishRun(rec, {
          verdict: syntheticVerdict(HELD_TTL_REASON),
          retryable: false,
          handle: rec.handle,
          settledAt: at,
        });
        continue;
      }
      if (rec.doomed) {
        evict(rec, "session-gone");
        evicted += 1;
      } else if (isExpired(rec, at)) {
        evict(rec, "ttl");
        evicted += 1;
      }
    }
    for (const [sid, list] of ledger) {
      const kept = list.filter((l) => at - l.recordedAt < ttlMs);
      if (kept.length === 0) ledger.delete(sid);
      else if (kept.length !== list.length) ledger.set(sid, kept);
    }
    return evicted;
  }

  function lookup(sessionID: string, handle: string): EntryRecord | LookupMiss {
    const rec = sessions.get(sessionID)?.get(handle);
    if (rec !== undefined) return rec;
    if (tombstones.get(handle) === sessionID) return { kind: "expired", handle };
    return { kind: "unknown", handle };
  }

  function isRecord(value: EntryRecord | LookupMiss): value is EntryRecord {
    return !("kind" in value);
  }

  /**
   * R7, QA-2.4-4: a captured reference that would push the weight over the cap is shed, never an
   * entry: the entry stays unverified and listed, and its reference becomes { kind: "none", reason:
   * REFERENCE_SHED_REASON }, so a later verification cannot excuse pre-existing failures (stricter,
   * never a false pass). Expired entries go first (verified entries hold no weight once released).
   */
  function admitReferenceWeight(rec: EntryRecord, refWeight: number): void {
    if (counters.weight + refWeight > maxWeight) maintain(now());
    if (!rec.live || rec.released) return;
    if (counters.weight + refWeight <= maxWeight) {
      rec.refWeight = refWeight;
      counters.weight += refWeight;
      return;
    }
    rec.reference = Promise.resolve<ReferenceState>({ kind: "none", reason: REFERENCE_SHED_REASON });
  }

  function drawHandle(): string | undefined {
    for (let i = 0; i < HANDLE_MAX_DRAWS; i += 1) {
      const candidate = HANDLE_PREFIX + toHex(random(HANDLE_RANDOM_BYTES));
      if (!HANDLE_PATTERN.test(candidate)) continue;
      if (byHandle.has(candidate) || tombstones.has(candidate) || reserved.has(candidate)) continue;
      return candidate;
    }
    return undefined;
  }

  function register(reg: PendingRegistration): RegisterResult {
    if (
      !isNonEmptyString(reg.orchestratorSessionID) ||
      !isNonEmptyString(reg.producerSessionID) ||
      reg.orchestratorSessionID === reg.producerSessionID
    ) {
      return {
        ok: false,
        code: "invalid-input",
        detail: "orchestrator and producer session ids must be non-empty and differ",
      };
    }
    const at = now();
    maintain(at);

    // Phase 2.1: idempotent on dispatchID (a replayed finish registers once).
    const existing = byDispatch.get(reg.dispatchID);
    if (existing !== undefined && existing.live && existing.orchestratorSessionID === reg.orchestratorSessionID) {
      return { ok: true, handle: existing.handle, evicted: [] };
    }
    const ownReservation =
      reg.handle !== undefined && reserved.get(reg.handle) === reg.orchestratorSessionID ? reg.handle : undefined;
    if (reg.handle !== undefined && ownReservation === undefined) {
      if (!HANDLE_PATTERN.test(reg.handle)) {
        return { ok: false, code: "invalid-input", detail: "handle is not a router verification handle" };
      }
      if (byHandle.has(reg.handle) || tombstones.has(reg.handle) || reserved.has(reg.handle)) {
        return { ok: false, code: "handle-collision", detail: "the requested handle is already in use" };
      }
    }
    const reservedHere = reservedCount(reg.orchestratorSessionID, ownReservation);
    const reservedAll = reservedCount(undefined, ownReservation);

    const incoming = reg.changedFiles;
    let changedFiles: readonly ChangedPath[] | "unavailable" = "unavailable";
    let changedFilesDropped = 0;
    if (incoming !== "unavailable") {
      if (incoming.length > MAX_STORED_CHANGED_FILES) changedFilesDropped = incoming.length;
      else changedFiles = Object.freeze([...incoming]);
    }
    const pathWeight = changedFiles === "unavailable" ? 0 : changedFiles.length;

    // Plan the evictions first: a registration that cannot fit evicts nothing.
    const session = sessions.get(reg.orchestratorSessionID);
    const victims: Array<{ rec: EntryRecord; cause: EvictionCause }> = [];
    const chosen = new Set<EntryRecord>();
    if (session !== undefined) {
      let count = session.size + reservedHere;
      for (const rec of evictionCandidates(session.values())) {
        if (count + 1 <= maxPerSession) break;
        victims.push({ rec, cause: "session-cap" });
        chosen.add(rec);
        count -= 1;
      }
      if (count + 1 > maxPerSession) {
        return { ok: false, code: "registry-full", detail: `session holds ${count} unverified or verifying entries` };
      }
    } else if (maxPerSession < 1 + reservedHere) {
      return { ok: false, code: "registry-full", detail: "per-session cap is 0" };
    }
    let count = byHandle.size - victims.length + reservedAll;
    let weight = counters.weight - victims.reduce((sum, v) => sum + v.rec.pathWeight + v.rec.refWeight, 0);
    for (const rec of evictionCandidates(byHandle.values())) {
      if (count + 1 <= maxGlobal && weight + pathWeight <= maxWeight) break;
      if (chosen.has(rec)) continue;
      victims.push({ rec, cause: count + 1 > maxGlobal ? "global-cap" : "weight-cap" });
      chosen.add(rec);
      count -= 1;
      weight -= rec.pathWeight + rec.refWeight;
    }
    if (count + 1 > maxGlobal || weight + pathWeight > maxWeight) {
      return { ok: false, code: "registry-full", detail: "the pending registry cannot hold another entry" };
    }

    const handle = reg.handle ?? drawHandle();
    if (handle === undefined) {
      return { ok: false, code: "handle-collision", detail: `no free handle after ${HANDLE_MAX_DRAWS} draws` };
    }
    for (const v of victims) evict(v.rec, v.cause);
    unreserve(handle);

    const reference = reg.reference.then(
      (state) => state,
      (): ReferenceState => ({ kind: "none", reason: REFERENCE_FAILED_REASON }),
    );
    const digests = reg.digests?.then(
      (d) => d,
      () => undefined,
    );
    counters.seq += 1;
    const rec: EntryRecord = {
      handle,
      seq: counters.seq,
      orchestratorSessionID: reg.orchestratorSessionID,
      dispatchID: reg.dispatchID,
      producerSessionID: reg.producerSessionID,
      producerTier: reg.producerTier,
      description: sanitizeDescription(reg.description),
      cwd: reg.cwd,
      root: reg.root,
      dispatchedAt: reg.dispatchedAt,
      createdAt: at,
      risk: reg.risk,
      changedFilesDropped,
      concurrentDispatches: reg.concurrentDispatches,
      contaminatedBy: reg.contaminatedBy,
      dod: reg.dod,
      reference,
      changedFiles,
      digests,
      state: reg.hold !== undefined ? "held" : "unverified",
      verifyingSince: undefined,
      result: undefined,
      run: undefined,
      pathWeight,
      refWeight: 0,
      released: false,
      doomed: false,
      live: true,
      replayed: false,
      hold: reg.hold,
      holdAttempts: 0,
    };
    const target = session ?? new Map<string, EntryRecord>();
    target.set(handle, rec);
    sessions.set(reg.orchestratorSessionID, target);
    byHandle.set(handle, rec);
    byDispatch.set(reg.dispatchID, rec);
    counters.weight += pathWeight;

    // R7: the reference's weight is added when it resolves "captured" (a promise callback).
    void reference.then((state) => {
      if (!rec.live || rec.released || state.kind !== "captured") return;
      admitReferenceWeight(rec, state.reference.untracked.size + state.reference.tracked.size);
      persistReference(rec, state.reference);
    });
    persistEntry(rec);

    return { ok: true, handle, evicted: victims.map((v) => v.rec.handle) };
  }

  function markVerifying(sessionID: string, handle: string): ClaimResult {
    const at = now();
    maintain(at);
    const found = lookup(sessionID, handle);
    if (!isRecord(found)) return found;
    const rec = found;
    if (rec.state === "verified" && rec.result !== undefined) {
      return { kind: "settled", entry: snapshot(rec), result: rec.result };
    }
    if (rec.state === "verifying" && rec.run !== undefined) {
      return { kind: "joined", entry: snapshot(rec), run: rec.run.promise };
    }
    let resolveRun: (value: SettledVerification) => void = () => undefined;
    const promise = new Promise<SettledVerification>((resolve) => {
      resolveRun = resolve;
    });
    const run: RunSlot = { promise, resolve: resolveRun };
    rec.state = "verifying";
    rec.verifyingSince = at;
    rec.run = run;
    persistState(rec, at);
    let used = false;
    const settle = (result: VerificationResult): boolean => {
      if (used || rec.run !== run || !rec.live) return false;
      used = true;
      const settledAt = now();
      const settled: SettledVerification = Object.freeze({ ...result, handle: rec.handle, settledAt });
      finishRun(rec, settled);
      if (!result.retryable && result.introduced !== undefined && result.introduced.length > 0 && rec.root !== undefined) {
        recordRejection({
          orchestratorSessionID: rec.orchestratorSessionID,
          root: rec.root,
          label: rec.handle,
          landedAt: rec.createdAt,
          introduced: result.introduced,
        });
      }
      if (rec.doomed) evict(rec, "session-gone");
      else if (isExpired(rec, settledAt)) evict(rec, "ttl");
      return true;
    };
    return { kind: "claimed", entry: snapshot(rec), run: promise, settle };
  }

  function listByState(sessionID: string, states: readonly PendingState[]): EntryRecord[] {
    maintain(now());
    const session = sessions.get(sessionID);
    if (session === undefined) return [];
    return [...session.values()]
      .filter((r) => states.includes(r.state))
      .sort((a, b) => b.createdAt - a.createdAt || b.seq - a.seq);
  }

  /**
   * Phase 2.1 section 11.3 (v2 only): folds pending.jsonl records by key and rebuilds the live entries.
   * Unverified entries past pendingTtlMs are dropped; held ones are settled UNVERIFIABLE (and reported
   * through onVerdict) instead. Nothing is written back: the records are already on disk.
   */
  function restore(records: readonly PendingRecord[], opts: { readonly now: number }): RestoreReport {
    const folded = new Map<string, { entry: PendingRecord; reference: unknown; state: string }>();
    for (const r of records) {
      const handle = isNonEmptyString(r.handle) ? r.handle : undefined;
      if (r.kind === "entry" && handle !== undefined) {
        folded.set(handle, { entry: r, reference: undefined, state: isNonEmptyString(r.state) ? r.state : "unverified" });
      } else if (r.kind === "ref") {
        const target = handle !== undefined ? folded.get(handle) : undefined;
        if (target !== undefined) target.reference = r.reference;
        else for (const f of folded.values()) if (f.entry.callID === r.callID) f.reference = r.reference;
      } else if (r.kind === "state" && handle !== undefined) {
        const target = folded.get(handle);
        if (target !== undefined && isNonEmptyString(r.state)) target.state = r.state;
      } else if (r.kind === "tomb" && handle !== undefined) {
        folded.delete(handle);
      } else if (r.kind === "forget") {
        for (const [h, f] of [...folded]) if (f.entry.parent === r.session) folded.delete(h);
      }
    }
    let restored = 0;
    let expiredHeld = 0;
    let dropped = 0;
    for (const [handle, f] of folded) {
      const e = f.entry;
      const parent = isNonEmptyString(e.parent) ? e.parent : undefined;
      const callID = isNonEmptyString(e.callID) ? e.callID : undefined;
      const child = isNonEmptyString(e.child) ? e.child : undefined;
      const producer = isNonEmptyString(e.producer) ? e.producer : child;
      if (
        parent === undefined || callID === undefined || producer === undefined || parent === producer ||
        !HANDLE_PATTERN.test(handle) || f.state === "verified" || byHandle.has(handle) || byDispatch.has(callID)
      ) {
        dropped += 1;
        continue;
      }
      const held = e.state === "held" && child !== undefined;
      const createdAt = typeof e.createdAt === "number" && Number.isFinite(e.createdAt) ? e.createdAt : opts.now;
      const expired = opts.now - createdAt >= ttlMs;
      const session = sessions.get(parent);
      if (!held && (expired || byHandle.size >= maxGlobal || (session?.size ?? 0) >= maxPerSession)) {
        dropped += 1;
        continue;
      }
      const changedFiles = isChangedFiles(e.changedFiles) ? e.changedFiles : "unavailable";
      const restoredRef = deserializeReference(f.reference);
      const pathWeight = changedFiles === "unavailable" ? 0 : changedFiles.length;
      const refWeight = restoredRef === undefined ? 0 : restoredRef.untracked.size + restoredRef.tracked.size;
      counters.seq += 1;
      const rec: EntryRecord = {
        handle,
        seq: counters.seq,
        orchestratorSessionID: parent,
        dispatchID: callID,
        producerSessionID: producer,
        producerTier: typeof e.tier === "string" ? e.tier : "",
        description: typeof e.description === "string" ? e.description : "",
        cwd: typeof e.cwd === "string" ? e.cwd : "",
        root: isNonEmptyString(e.root) ? e.root : undefined,
        dispatchedAt: typeof e.dispatchedAt === "number" && Number.isFinite(e.dispatchedAt) ? e.dispatchedAt : createdAt,
        createdAt,
        risk: isRiskAssessment(e.risk) ? e.risk : unattributedRisk(),
        changedFilesDropped: typeof e.changedFilesDropped === "number" ? e.changedFilesDropped : 0,
        concurrentDispatches: typeof e.concurrentDispatches === "number" ? e.concurrentDispatches : undefined,
        contaminatedBy: isNonEmptyString(e.contaminatedBy) ? e.contaminatedBy : undefined,
        dod: isDoD(e.dod) ? e.dod : undefined,
        reference: Promise.resolve<ReferenceState>(
          restoredRef !== undefined
            ? { kind: "captured", reference: restoredRef }
            : { kind: "none", reason: REFERENCE_UNRESTORED_REASON },
        ),
        changedFiles,
        digests: undefined,
        state: held ? "held" : "unverified",
        verifyingSince: undefined,
        result: undefined,
        run: undefined,
        pathWeight,
        refWeight,
        released: false,
        doomed: false,
        live: true,
        replayed: false,
        hold: held && child !== undefined ? { childSessionID: child, callID } : undefined,
        holdAttempts: 0,
      };
      const target = session ?? new Map<string, EntryRecord>();
      target.set(handle, rec);
      sessions.set(parent, target);
      byHandle.set(handle, rec);
      byDispatch.set(callID, rec);
      counters.weight += pathWeight + refWeight;
      if (held && expired) {
        finishRun(rec, {
          verdict: syntheticVerdict(HELD_TTL_REASON),
          retryable: false,
          handle,
          settledAt: opts.now,
        });
        expiredHeld += 1;
      } else {
        restored += 1;
      }
    }
    return { restored, expiredHeld, dropped };
  }

  return {
    register,
    get(sessionID, handle) {
      maintain(now());
      const found = lookup(sessionID, handle);
      return isRecord(found) ? { kind: "found", entry: snapshot(found) } : found;
    },
    listUnverified(sessionID, limit) {
      const list = listByState(sessionID, ["unverified"]);
      const bounded = limit === undefined ? list : list.slice(0, Math.max(0, Math.floor(limit)));
      return bounded.map(snapshot);
    },
    listOpen(sessionID) {
      return listByState(sessionID, ["unverified", "verifying"]).map(snapshot);
    },
    listPending(sessionID, options) {
      const states: PendingState[] = options?.verifying === true ? ["unverified", "verifying", "verified"] : ["unverified", "verified"];
      return listByState(sessionID, states)
        .filter((r) => r.hold === undefined && (r.state !== "verified" || awaitsReplay(r)))
        .map(snapshot);
    },
    reserveHandle,
    releaseHandle(handle) {
      unreserve(handle);
    },
    hasSlot,
    findByDispatch(dispatchID) {
      const rec = byDispatch.get(dispatchID);
      return rec !== undefined && rec.live ? snapshot(rec) : undefined;
    },
    listHeld(sessionID) {
      return listByState(sessionID, ["held", "verifying"])
        .filter((r) => r.hold !== undefined)
        .map(snapshot);
    },
    restore,
    markReplayed(sessionID, handles) {
      const session = sessions.get(sessionID);
      if (session === undefined) return;
      for (const handle of handles) {
        const rec = session.get(handle);
        if (rec !== undefined) rec.replayed = true;
      }
    },
    markVerifying,
    persistedRecords,
    sweep(nowMs) {
      return maintain(nowMs ?? now());
    },
    forgetSession(sessionID) {
      const session = sessions.get(sessionID);
      for (const rec of session === undefined ? [] : [...session.values()]) {
        if (rec.state === "verifying") rec.doomed = true;
        else evict(rec, "session-gone");
      }
      for (const [handle, sid] of [...tombstones]) {
        if (sid === sessionID) tombstones.delete(handle);
      }
      ledger.delete(sessionID);
      for (const [handle, sid] of [...reserved]) {
        if (sid === sessionID) unreserve(handle);
      }
      journal({ v: 1, kind: "forget", session: sessionID, at: now() });
    },
    recordRejection,
    findLineage(query) {
      maintain(now());
      const list = ledger.get(query.orchestratorSessionID) ?? [];
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const { record } = list[i];
        if (record.root !== query.root || record.landedAt > query.dispatchedAt) continue;
        const introduced = new Set(record.introduced);
        const ids = [...new Set(query.preexisting)].filter((id) => introduced.has(id));
        if (ids.length > 0) return { label: record.label, ids };
      }
      return undefined;
    },
    stats() {
      let verifying = 0;
      for (const rec of byHandle.values()) if (rec.state === "verifying") verifying += 1;
      let rejections = 0;
      for (const list of ledger.values()) rejections += list.length;
      return {
        entries: byHandle.size,
        sessions: sessions.size,
        verifying,
        weight: counters.weight,
        tombstones: tombstones.size,
        rejections,
      };
    },
    dispose() {
      const at = now();
      for (const rec of [...byHandle.values()]) {
        if (rec.run !== undefined) {
          finishRun(rec, { verdict: syntheticVerdict(DISPOSED_REASON), retryable: true, handle: rec.handle, settledAt: at });
        }
        evict(rec, "disposed");
      }
      ledger.clear();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Background queue (R14, task 2.4.5; section 1.5-19). Constructed only when `background: true`.
// ---------------------------------------------------------------------------------------------

/** One deferred delegation queued for background verification (the wiring's deferred finish). */
export interface BackgroundRequest {
  readonly sessionID: string;
  readonly handle: string;
  /** The entry's stored changed paths (absolute); coalescing compares them. */
  readonly files: readonly string[];
}

/** What one background run reports per handle. */
export type BackgroundOutcome =
  /** This run claimed and settled the handle (router_verify's "run"). */
  | { readonly kind: "judged"; readonly handle: string; readonly description: string; readonly result: SettledVerification }
  /** A router_verify call judged it or is judging it: that caller has the verdict. */
  | { readonly kind: "reported"; readonly handle: string }
  /** Unknown or expired: the entry is gone. */
  | { readonly kind: "gone"; readonly handle: string };

/** The gate path of one background run: router_verify's verifyHandles for one session. Never rejects in production. */
export type BackgroundVerify = (sessionID: string, handles: readonly string[], signal: AbortSignal) => Promise<readonly BackgroundOutcome[]>;

export interface BackgroundTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface BackgroundQueueOptions {
  readonly verify: BackgroundVerify;
  /** pendingTtlMs: an undelivered notice older than this is dropped by sweep. */
  readonly ttlMs: number;
  /** Injected clock; default Date.now. */
  readonly now?: () => number;
  /** Injected timers; default unref'd setTimeout. */
  readonly timers?: BackgroundTimers;
  readonly settleMs?: number;
  readonly retryBaseMs?: number;
  readonly maxAttempts?: number;
  /** Paths compare case-folded (and slash-normalized) on win32; default process.platform. */
  readonly platform?: NodeJS.Platform;
  /** Logging hook for a rejected run; never throws into the queue. */
  readonly onError?: (error: unknown) => void;
  /**
   * QA-2.4-5: true while foreground verification (a required gate or router_verify) is running. A
   * run is then not started: its due requests back off (not counted as an attempt) and retry later.
   */
  readonly busy?: () => boolean;
}

/** QA-2.4-5: the exponent cap of the backoff of requests that were preempted or postponed. */
export const BACKGROUND_MAX_BACKOFF_STEPS = 5;

export interface BackgroundQueueStats {
  readonly queued: number;
  readonly running: boolean;
  readonly timerArmed: boolean;
  readonly notices: number;
  readonly superseded: number;
  readonly runs: number;
}

export interface BackgroundQueue {
  /** Queues a deferred delegation; a queued older request of the session with overlapping files is dropped. */
  enqueue(request: BackgroundRequest): void;
  /** The session's undelivered notices, oldest first; each is returned once (delivered on read). */
  takeNotices(sessionID: string): readonly LateNotice[];
  /** A router_verify caller received these handles' verdicts: no late notice for them. */
  markReported(handles: readonly string[]): void;
  /** session.deleted: drops the session's requests and notices, and aborts its run in flight. */
  forgetSession(sessionID: string): void;
  /** Drops undelivered notices older than ttlMs; returns how many. The idle trigger (R14). */
  sweep(nowMs?: number): number;
  stats(): BackgroundQueueStats;
  /** Resolves once no run is in flight and no request is fresh or due (tests, diagnostics). */
  whenIdle(): Promise<void>;
  /**
   * QA-2.4-5: foreground verification takes precedence. Aborts the run in flight (its deadline, so
   * its tree dies and the slot is freed); its requests go back to the queue with backoff, not
   * counted as an attempt, and a verdict it already reached is kept. Resolves once that run has
   * finished (at once when none is in flight). Never rejects.
   */
  preempt(): Promise<void>;
  /** Plugin dispose: aborts the run in flight, clears the timer, drops everything. Idempotent. */
  dispose(): void;
}

const DEFAULT_BACKGROUND_TIMERS: BackgroundTimers = {
  setTimeout(callback, ms) {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** R14. */
export function createBackgroundQueue(options: BackgroundQueueOptions): BackgroundQueue {
  const now = options.now ?? Date.now;
  const timers = options.timers ?? DEFAULT_BACKGROUND_TIMERS;
  const settleMs = Math.max(0, options.settleMs ?? BACKGROUND_SETTLE_MS);
  const retryBaseMs = Math.max(0, options.retryBaseMs ?? BACKGROUND_RETRY_BASE_MS);
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? BACKGROUND_MAX_ATTEMPTS));
  const foldCase = (options.platform ?? process.platform) === "win32";
  const pathKey = (p: string): string => (foldCase ? p.replace(/\\/g, "/").toLowerCase() : p);

  interface QueuedItem {
    readonly sessionID: string;
    readonly handle: string;
    readonly files: ReadonlySet<string>;
    /** Runs already made for this request that counted (fresh when this and `deferrals` are 0). */
    readonly attempts: number;
    /** QA-2.4-5: preemptions and postponements; they back off but never count as attempts. */
    readonly deferrals: number;
    readonly notBefore: number;
  }
  interface Run {
    readonly sessionID: string;
    readonly items: readonly QueuedItem[];
    readonly controller: AbortController;
    cancelled: boolean;
    /** QA-2.4-5: aborted for foreground verification. */
    preempted: boolean;
    /** Resolves when the run has finished (finish). */
    readonly done: Promise<void>;
    readonly markDone: () => void;
  }
  interface StoredNotice {
    readonly notice: LateNotice;
    readonly at: number;
  }

  /** handle -> request; insertion order = FIFO. */
  const queue = new Map<string, QueuedItem>();
  /** orchestrator session -> handle -> notice; insertion order = settle order. */
  const notices = new Map<string, Map<string, StoredNotice>>();
  const reported = new Set<string>();
  const idleWaiters: Array<() => void> = [];
  const counters = { superseded: 0, runs: 0, notices: 0, hookFailures: 0 };
  let running: Run | undefined;
  let timer: { readonly handle: unknown; readonly at: number } | undefined;
  let disposed = false;

  function report(error: unknown): void {
    try {
      options.onError?.(error);
    } catch {
      // A logging hook must never break the queue (BackgroundQueueOptions.onError).
      counters.hookFailures += 1;
    }
  }

  function overlaps(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
    for (const f of a) if (b.has(f)) return true;
    return false;
  }

  function remember(handle: string): void {
    reported.delete(handle);
    reported.add(handle);
    while (reported.size > REPORTED_MEMO_MAX) {
      const oldest = reported.values().next();
      if (oldest.done === true) break;
      reported.delete(oldest.value);
    }
  }

  function removeNotice(sessionID: string, handle: string): void {
    const list = notices.get(sessionID);
    if (list === undefined || !list.delete(handle)) return;
    counters.notices -= 1;
    if (list.size === 0) notices.delete(sessionID);
  }

  function addNotice(sessionID: string, notice: LateNotice): void {
    if (reported.has(notice.handle)) return;
    const list = notices.get(sessionID) ?? new Map<string, StoredNotice>();
    if (list.has(notice.handle)) return;
    list.set(notice.handle, { notice, at: now() });
    notices.set(sessionID, list);
    counters.notices += 1;
    if (list.size > LATE_NOTICES_PER_SESSION) removeNotice(sessionID, list.keys().next().value ?? "");
    while (counters.notices > LATE_NOTICES_MAX) {
      let victim: { readonly sessionID: string; readonly handle: string; readonly at: number } | undefined;
      for (const [sid, stored] of notices) {
        const first = stored.entries().next();
        if (first.done === true) continue;
        const [handle, oldest] = first.value;
        if (victim === undefined || oldest.at < victim.at) victim = { sessionID: sid, handle, at: oldest.at };
      }
      if (victim === undefined) break;
      removeNotice(victim.sessionID, victim.handle);
    }
  }

  function wakeIdle(): void {
    for (const resolveIdle of idleWaiters.splice(0)) resolveIdle();
  }

  /** A request that has never run, been preempted or been postponed. */
  function isFresh(item: QueuedItem): boolean {
    return item.attempts === 0 && item.deferrals === 0;
  }

  /** Backoff: retryBaseMs * 2^(attempts + deferrals - 1), the exponent capped (QA-2.4-5). */
  function backoffFrom(at: number, attempts: number, deferrals: number): number {
    const steps = Math.min(Math.max(attempts + deferrals, 1) - 1, BACKGROUND_MAX_BACKOFF_STEPS);
    return at + retryBaseMs * 2 ** steps;
  }

  /** Quiet: no run in flight, and every queued request is backing off into the future. */
  function isQuiet(at: number): boolean {
    if (running !== undefined) return false;
    for (const item of queue.values()) if (isFresh(item) || item.notBefore <= at) return false;
    return true;
  }

  /** One timer at a time, at the earliest due request; never moved later (no debounce). */
  function arm(at: number): void {
    if (disposed) return;
    if (timer !== undefined) {
      if (timer.at <= at) return;
      timers.clearTimeout(timer.handle);
    }
    const handle = timers.setTimeout(() => {
      timer = undefined;
      runNext();
    }, Math.max(0, at - now()));
    timer = { handle, at };
  }

  function reschedule(): void {
    if (disposed || running !== undefined) return;
    let next: number | undefined;
    for (const item of queue.values()) next = next === undefined ? item.notBefore : Math.min(next, item.notBefore);
    if (next !== undefined) arm(next);
    else if (timer !== undefined) {
      timers.clearTimeout(timer.handle);
      timer = undefined;
    }
    if (isQuiet(now())) wakeIdle();
  }

  function enforceCap(): void {
    while (queue.size > BACKGROUND_QUEUE_MAX) {
      const oldest = queue.keys().next();
      if (oldest.done === true) break;
      queue.delete(oldest.value);
    }
  }

  /**
   * A retryable result: back off, never a hot loop; after maxAttempts it stays unverified.
   * QA-2.4-5: a run preempted for foreground verification is not `counted`: it backs off without
   * using an attempt (bounded by the entry's TTL, which ends it as "gone").
   */
  function retry(item: QueuedItem, counted = true): void {
    const attempts = counted ? item.attempts + 1 : item.attempts;
    if (counted && attempts >= maxAttempts) return;
    const deferrals = counted ? item.deferrals : item.deferrals + 1;
    for (const other of queue.values()) {
      if (other.sessionID === item.sessionID && overlaps(other.files, item.files)) {
        counters.superseded += 1;
        return;
      }
    }
    queue.set(item.handle, { ...item, attempts, deferrals, notBefore: backoffFrom(now(), attempts, deferrals) });
    enforceCap();
  }

  function apply(run: Run, outcomes: readonly BackgroundOutcome[]): void {
    const byHandle = new Map(outcomes.map(o => [o.handle, o] as const));
    const counted = !run.preempted;
    for (const item of run.items) {
      const outcome = byHandle.get(item.handle);
      if (outcome === undefined) retry(item, counted);
      else if (outcome.kind !== "judged") continue;
      else if (outcome.result.retryable) retry(item, counted);
      else {
        const notice = lateNoticeFor(item.handle, outcome.description, outcome.result);
        if (notice !== undefined) addNotice(run.sessionID, notice);
      }
    }
  }

  function finish(run: Run, outcomes: readonly BackgroundOutcome[]): void {
    try {
      if (!disposed && !run.cancelled) apply(run, outcomes);
    } finally {
      if (running === run) running = undefined;
      reschedule();
      run.markDone();
    }
  }

  /** QA-2.4-5: foreground verification is running: the due requests back off, uncounted. */
  function postponeDue(at: number): void {
    for (const item of [...queue.values()]) {
      if (item.notBefore > at) continue;
      const deferrals = item.deferrals + 1;
      queue.set(item.handle, { ...item, deferrals, notBefore: backoffFrom(at, item.attempts, deferrals) });
    }
    reschedule();
  }

  function foregroundBusy(): boolean {
    try {
      return options.busy?.() === true;
    } catch (error) {
      report(error);
      return false;
    }
  }

  function runNext(): void {
    if (disposed || running !== undefined) return;
    const at = now();
    let first: QueuedItem | undefined;
    for (const item of queue.values()) {
      if (item.notBefore <= at && (first === undefined || item.notBefore < first.notBefore)) first = item;
    }
    if (first === undefined) {
      reschedule();
      return;
    }
    // QA-2.4-5: never start while foreground verification runs; never queue for the slot.
    if (foregroundBusy()) {
      postponeDue(at);
      return;
    }
    const lead = first;
    // One session per run (verifyHandles is session-scoped): its fresh and due requests ride along.
    const riders = [...queue.values()].filter(i => i !== lead && i.sessionID === lead.sessionID && (isFresh(i) || i.notBefore <= at));
    const items = [lead, ...riders].slice(0, MAX_HANDLES_PER_CALL);
    for (const item of items) queue.delete(item.handle);
    let markDone: () => void = () => undefined;
    const done = new Promise<void>(resolveDone => {
      markDone = resolveDone;
    });
    const run: Run = { sessionID: lead.sessionID, items, controller: new AbortController(), cancelled: false, preempted: false, done, markDone };
    running = run;
    counters.runs += 1;
    let outcome: Promise<readonly BackgroundOutcome[]>;
    try {
      outcome = options.verify(run.sessionID, items.map(i => i.handle), run.controller.signal);
    } catch (error) {
      outcome = Promise.reject(error);
    }
    outcome
      .then(
        outcomes => finish(run, outcomes),
        (error: unknown) => {
          report(error);
          finish(run, []);
        },
      )
      .catch(report);
  }

  return {
    enqueue(request) {
      if (disposed || !isNonEmptyString(request.sessionID) || !isNonEmptyString(request.handle)) return;
      if (queue.has(request.handle) || running?.items.some(i => i.handle === request.handle) === true) return;
      const files = new Set(request.files.map(pathKey));
      // Section 1.5-19: a newer request for an overlapping file set supersedes a queued older one.
      // The older entry stays unverified (and listed); it is never reported as verified.
      for (const other of [...queue.values()]) {
        if (other.sessionID === request.sessionID && overlaps(other.files, files)) {
          queue.delete(other.handle);
          counters.superseded += 1;
        }
      }
      const at = now();
      queue.set(request.handle, { sessionID: request.sessionID, handle: request.handle, files, attempts: 0, deferrals: 0, notBefore: at + settleMs });
      enforceCap();
      if (running === undefined) arm(at + settleMs);
    },
    takeNotices(sessionID) {
      const list = notices.get(sessionID);
      if (list === undefined) return [];
      notices.delete(sessionID);
      counters.notices -= list.size;
      const out = [...list.values()].map(s => s.notice);
      for (const n of out) remember(n.handle);
      return out;
    },
    markReported(handles) {
      for (const handle of handles) {
        remember(handle);
        for (const sid of [...notices.keys()]) removeNotice(sid, handle);
      }
    },
    forgetSession(sessionID) {
      for (const item of [...queue.values()]) if (item.sessionID === sessionID) queue.delete(item.handle);
      const list = notices.get(sessionID);
      if (list !== undefined) {
        counters.notices -= list.size;
        notices.delete(sessionID);
      }
      if (running?.sessionID === sessionID) {
        running.cancelled = true;
        running.controller.abort();
      }
      reschedule();
    },
    sweep(nowMs) {
      const at = nowMs ?? now();
      let dropped = 0;
      for (const [sid, list] of [...notices]) {
        for (const [handle, stored] of [...list]) {
          if (at - stored.at < options.ttlMs) continue;
          removeNotice(sid, handle);
          dropped += 1;
        }
      }
      reschedule();
      return dropped;
    },
    stats() {
      return {
        queued: queue.size,
        running: running !== undefined,
        timerArmed: timer !== undefined,
        notices: counters.notices,
        superseded: counters.superseded,
        runs: counters.runs,
      };
    },
    whenIdle() {
      if (disposed || isQuiet(now())) return Promise.resolve();
      return new Promise<void>(resolveIdle => idleWaiters.push(resolveIdle));
    },
    preempt() {
      const run = running;
      if (run === undefined) return Promise.resolve();
      if (!run.cancelled && !run.preempted) {
        run.preempted = true;
        run.controller.abort();
      }
      return run.done;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer !== undefined) {
        timers.clearTimeout(timer.handle);
        timer = undefined;
      }
      if (running !== undefined) {
        running.cancelled = true;
        running.controller.abort();
      }
      queue.clear();
      notices.clear();
      counters.notices = 0;
      wakeIdle();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Pure builders (R2, R9, R10, R11)
// ---------------------------------------------------------------------------------------------

/** R2: trimmed, one pair of surrounding backticks/quotes stripped, lowercased, HANDLE_PATTERN. */
export function normalizeHandle(text: string): string | undefined {
  let value = text.trim();
  const first = value.charAt(0);
  if (value.length >= 2 && (first === "`" || first === '"' || first === "'") && value.endsWith(first)) {
    value = value.slice(1, -1);
  }
  value = value.toLowerCase();
  return HANDLE_PATTERN.test(value) ? value : undefined;
}

/** R9. */
export function sanitizeDescription(text: string): string {
  const clean = sanitizeInline(text);
  if (clean.length === 0) return "(no description)";
  const points = Array.from(clean);
  if (points.length <= MAX_DESCRIPTION_CHARS) return clean;
  return points.slice(0, MAX_DESCRIPTION_CHARS - 1).join("") + "\u2026";
}

/** R10: the risk of a delegation whose changed files could not be attributed. */
export function unattributedRisk(): RiskAssessment {
  return { level: "high", reasons: [UNATTRIBUTED_RISK_REASON] };
}

/** R9, section 1.5-16. */
export function buildDeferredFooter(input: FooterInput): string {
  const risk = formatRisk(input.risk.level, input.risk.reasons, FOOTER_MAX_REASONS);
  return (
    `[router] unverified \u00b7 ${input.handle} \u00b7 ${risk}\n` +
    "[router] Call `router_verify` with this handle before building on this work if the risk matters."
  );
}

/** R9. */
export function appendRouterFooter(output: string, footer: string): string {
  const trimmed = output.trimEnd();
  return trimmed.length === 0 ? footer : `${trimmed}\n\n${footer}`;
}

/** R9, section 1.5-20. `entries` = listUnverified(sessionID), newest first. undefined when empty. */
export function buildPendingListBlock(entries: readonly PendingEntry[]): string | undefined {
  if (entries.length === 0) return undefined;
  const shown = entries.slice(0, PENDING_LIST_LIMIT);
  // QA-2.4-3: a verified entry here is a background verdict that did not pass (listPending).
  const judgedOutcome = (e: PendingEntry): string | undefined => {
    if (e.state !== "verified" || e.result === undefined) return undefined;
    return e.result.verdict.outcome ?? (e.result.verdict.pass ? "pass" : "fail");
  };
  const lines = [entries.some((e) => judgedOutcome(e) !== undefined) ? PENDING_LIST_MIXED_HEADER : "[router] Unverified delegations in this session (newest first):"];
  for (const e of shown) {
    const outcome = judgedOutcome(e);
    const label = outcome === undefined ? "" : ` \u00b7 ${outcome} in background verification`;
    lines.push(`- ${e.handle}${label} \u00b7 ${formatRisk(e.risk.level, e.risk.reasons, 0)} \u00b7 ${sanitizeDescription(e.description)}`);
  }
  if (entries.length > shown.length) lines.push(`- ... and ${entries.length - shown.length} more`);
  lines.push(
    "[router] Before your final answer, call `router_verify` with the handles that matter, or with `pending: true` for all of them.",
  );
  return lines.join("\n");
}

/** R9, section 1.5-19 (background mode only; R14). undefined when empty. */
export function buildLateNoticeBlock(notices: readonly LateNotice[]): string | undefined {
  if (notices.length === 0) return undefined;
  const allFailures = notices.every(n => (n.outcome ?? "fail") === "fail");
  const lines = [allFailures ? "[router] Background verification found introduced failures:" : LATE_NOTICE_MIXED_HEADER];
  for (const n of notices) {
    const head = `- ${n.handle} \u00b7 ${sanitizeDescription(n.description)} \u00b7 `;
    if ((n.outcome ?? "fail") === "unverifiable") lines.push(`${head}unverifiable: ${sanitizeDescription(n.reason ?? "no verdict")}`);
    else if (n.introduced.length > 0) lines.push(`${head}failing: ${formatIds(n.introduced, LATE_NOTICE_MAX_IDS)}`);
    else lines.push(`${head}failed: ${sanitizeDescription(n.reason ?? "no reason given")}`);
  }
  lines.push("[router] Nothing was retried; decide whether to re-dispatch.");
  lines.push(LATE_NOTICE_REPLAY_LINE);
  return lines.join("\n");
}

/**
 * R14: the late notice of a background run's OWN terminal result; undefined for a pass and for a
 * retryable result (the entry stays unverified and listed). An unverifiable result gets a notice
 * too: it leaves the pending list at its settle, and silence would read like a pass. Pure.
 */
export function lateNoticeFor(handle: string, description: string, result: VerificationResult): LateNotice | undefined {
  if (result.retryable) return undefined;
  const verdict = result.verdict;
  const outcome = verdict.outcome ?? (verdict.pass ? "pass" : "fail");
  if (outcome === "pass") return undefined;
  // A drift or lineage downgrade appends its caveat last; a gate's own cause is its first reason.
  const reason = verdict.reasons.find(r => r.trim() !== "") ?? [...(verdict.caveats ?? [])].reverse().find(r => r.trim() !== "");
  return {
    handle,
    description,
    introduced: outcome === "fail" ? [...(result.introduced ?? [])] : [],
    outcome,
    ...(reason !== undefined ? { reason } : {}),
  };
}

/**
 * R3, section 1.5-18: paths of `before` whose digest differs in `after` (a path missing from
 * `after` counts as drifted), sorted. Pure.
 */
export function driftedPaths(before: FileDigests, after: FileDigests): string[] {
  const out: string[] = [];
  for (const [path, digest] of before) {
    if (after.get(path) !== digest) out.push(path);
  }
  return out.sort();
}

/**
 * R11. The ledger matches by test id and root only, so the earlier change may have been reverted
 * since: the caveat says it "may still be present", never that it is (QA-2.4-13).
 */
export function buildLineageCaveat(match: LineageMatch): string {
  return (
    `${formatIds(match.ids, LATE_NOTICE_MAX_IDS)} failed after ${sanitizeInline(match.label)} in this session and still fail; ` +
    "that change may still be present in the reference of this delegation, so pre-existing cannot be told apart from not fixed"
  );
}

/** R9: the risk fragment shared by the footer and the pending list. */
export function formatRisk(level: RiskLevel, reasons: readonly string[], maxReasons: number): string {
  const max = Math.max(0, Math.floor(maxReasons));
  const shown = reasons.slice(0, max).map(sanitizeInline);
  if (shown.length === 0) return `risk ${level}`;
  const rest = reasons.length - shown.length;
  const parts = rest > 0 ? [...shown, `+${rest} more`] : shown;
  return `risk ${level} (${parts.join("; ")})`;
}
