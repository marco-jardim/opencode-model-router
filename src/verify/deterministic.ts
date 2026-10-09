// src/verify/deterministic.ts
// Deterministic verifier: runs DoD checks using injected seams (no real fs/exec imports).
// PURE: no I/O-capable Node built-ins; all I/O goes through DeterministicDeps
// seams. ./paths is pure path math (node:path only) and keeps that contract.

import type { Check, DoD } from "./dod";
import type {
  Verdict,
  DeterministicDeps,
  MutexRegistry,
  ExecResult,
  Deadline,
  ArgvSeam,
  ExecOptions,
  ExecSeam,
  FailureClassification,
  OpenVerificationScope,
  RecheckOutcome,
  ReferenceState,
  RecheckUnusableCause,
  Rechecker,
  ScopedExecutor,
  ScopedOutcome,
  TestsPassHook,
  TestsPassJudgement,
  TestsPassRequest,
  TestsPassRun,
  VerificationScope,
} from "./types";
import type {
  DetectedRunner,
  LintSpec,
  NoAffected,
  Unscoped,
  PlannerFs,
  RunnerFs,
  RunnerHost,
  RunResult,
  TestSearchSeam,
} from "./runner";
import type { DispatchReference, MaterializedReference, ReferenceDeps } from "./reference";
import type { TreeSnapshot } from "./dispatch";
import type { VerifyBudget } from "../router/config";
import type { PluginLogger } from "../router/logger";
import { scrubText } from "../guard/scrub";
import { resolveAgainst } from "./paths";
import { isAbsolute, posix as pathPosix, win32 as pathWin32 } from "node:path";
import { judgeScoped, observeTests, REFERENCE_NONE } from "./baseline";
import {
  detectRunner,
  isNoAffected,
  isUnscoped,
  isUnverifiable,
  planRerun,
  planScopedLint,
  planScopedRun,
  readResult,
  resolveEntry,
} from "./runner";
import { fileKeyOfId } from "./baseline";
import { DEFAULT_MATERIALIZE_TIMEOUT_MS, gcStaleReferences, materialize, nodeReferenceFs } from "./reference";
import { acquireSlot, type SlotHandle } from "./slot";

// ---------------------------------------------------------------------------
// MutexRegistry — per-key serialization via promise-chaining
// ---------------------------------------------------------------------------

export function createMutexRegistry(): MutexRegistry {
  const chains = new Map<string, Promise<unknown>>();
  return {
    runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const prev = chains.get(key) ?? Promise.resolve();
      const run = prev.then(() => fn(), () => fn());
      // Tail swallows errors so the lock never wedges; run still rejects/resolves with fn's result.
      chains.set(key, run.then(() => {}, () => {}));
      return run;
    },
  };
}

// ---------------------------------------------------------------------------
// Command validation
// ---------------------------------------------------------------------------

export const DEFAULT_ALLOWLIST = [
  "npm", "npx", "pnpm", "yarn", "bun", "node",
  "tsc", "tsx", "vitest", "jest", "eslint", "prettier", "pytest",
];

// Any shell-chaining / redirection / substitution metacharacter.
// eslint-disable-next-line no-useless-escape
export const FORBIDDEN_SHELL = /[;&|`$><\n]|\$\(|&&|\|\|/;

// Interpreters that can execute arbitrary inline code via a flag. An allowlisted
// interpreter must not be turned into an arbitrary-code runner (e.g. `node -e ...`).
const INTERPRETERS = new Set([
  "node", "deno", "bun", "tsx", "ts-node", "python", "python3", "ruby", "perl",
]);
// Inline-eval / inline-print flags: -e, -c, -p, --eval, --print (with optional =value).
const EVAL_FLAG_RE = /^-(e|c|p)$|^--(eval|print)(=|$)/i;

export function isCommandAllowed(command: string, allowlist: string[]): boolean {
  const trimmed = command.trim();
  if (!trimmed || FORBIDDEN_SHELL.test(command)) return false;
  const tokens = trimmed.split(/\s+/);
  const firstToken = tokens[0];
  const parts = firstToken.split(/[/\\]/);
  const basename = parts[parts.length - 1];
  // `uv` is never allowlisted as such: only `uv run pytest ...` passes, and only when pytest is
  // allowed. This runs before the generic check so a user allowlist containing "uv" cannot widen it.
  if (basename.replace(/\.(exe|cmd|bat)$/i, "") === "uv") {
    return allowlist.includes("pytest") && tokens[1] === "run" && tokens[2] === "pytest";
  }
  if (!allowlist.includes(basename)) return false;
  // Strip a Windows executable suffix before the interpreter check.
  const interpreterBase = basename.replace(/\.(exe|cmd|bat)$/i, "");
  if (INTERPRETERS.has(interpreterBase)) {
    for (const t of tokens.slice(1)) {
      if (EVAL_FLAG_RE.test(t)) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Shape check (exported for unit testing)
// ---------------------------------------------------------------------------

export function shapeMismatch(
  schemaVal: unknown,
  targetVal: unknown,
  path = "",
): string | null {
  if (schemaVal !== null && typeof schemaVal === "object" && !Array.isArray(schemaVal)) {
    // schema is a plain object
    if (targetVal === null || typeof targetVal !== "object" || Array.isArray(targetVal)) {
      return `${path || "<root>"}: expected object`;
    }
    const schemaObj = schemaVal as Record<string, unknown>;
    const targetObj = targetVal as Record<string, unknown>;
    for (const k of Object.keys(schemaObj)) {
      if (!(k in targetObj)) return `${path}${k}: missing`;
      const nested = shapeMismatch(schemaObj[k], targetObj[k], `${path}${k}.`);
      if (nested !== null) return nested;
    }
    return null;
  } else if (Array.isArray(schemaVal)) {
    if (!Array.isArray(targetVal)) return `${path || "<root>"}: expected array`;
    return null; // presence of array suffices; elements/length not checked
  } else {
    // primitive
    if (typeof schemaVal !== typeof targetVal) {
      return `${path || "<root>"}: expected ${typeof schemaVal}, got ${typeof targetVal}`;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Internal runner result
// ---------------------------------------------------------------------------

interface CheckResult {
  ok: boolean;
  note?: string;
  unverifiable?: boolean;
  reason?: string;
  evidence?: string;
  /** testsPass only: judgeScoped's attribution against an exact recheck. */
  failures?: FailureClassification;
}

// ---------------------------------------------------------------------------
// Per-kind runners
// ---------------------------------------------------------------------------

async function runFileExists(check: Check, deps: DeterministicDeps): Promise<CheckResult> {
  try {
    if (!check.path) return { ok: false, reason: "fileExists check missing 'path'" };
    if (!deps.cwd && !isAbsolute(check.path)) return { ok: false, unverifiable: true, reason: `fileExists path cannot be resolved without a declared working directory: ${check.path}` };
    const resolved = resolveAgainst(deps.cwd, check.path);
    const ok = await deps.fs.fileExists(resolved);
    if (ok) return { ok: true, evidence: `exists: ${check.path}` };
    // An absolute check path ignores deps.cwd entirely, so claiming the file
    // was missing "in <cwd>" would name a directory the check never looked in.
    return isAbsolute(check.path)
      ? { ok: false, reason: `file not found: ${resolved}` }
      : { ok: false, reason: `file not found in ${deps.cwd}: ${check.path}` };
  } catch (err) {
    return { ok: false, reason: `fileExists check errored: ${scrubText(String(err))}` };
  }
}

async function runRun(
  check: Check,
  deps: DeterministicDeps,
  allowlist: string[],
  timeoutMs: number,
): Promise<CheckResult> {
  try {
    if (!check.command) return { ok: false, reason: "run check missing 'command'" };
    if (!isCommandAllowed(check.command, allowlist)) {
      return { ok: false, unverifiable: true, reason: `command not allowlisted: ${check.command}` };
    }
    const command = check.command;
    const got = await obtainExec("run", command, deps, timeoutMs, (scope, deadline) => scope.runShell(command, deps.cwd, deadline));
    if ("result" in got) return got.result;
    const r = got.exec;
    const out = r.stdout + "\n" + r.stderr;
    if (check.expect !== undefined && !out.includes(check.expect)) {
      return {
        ok: false,
        reason: `expected substring not found: "${check.expect}"`,
        evidence: out.slice(0, 2000),
        ...withNotes(got.notes),
      };
    }
    const ok = r.code === 0;
    if (!ok) {
      return {
        ok: false,
        reason: `command exited ${r.code}: ${check.command}`,
        evidence: out.slice(0, 2000),
        ...withNotes(got.notes),
      };
    }
    return { ok: true, evidence: `exit 0: ${check.command}`, ...withNotes(got.notes) };
  } catch (err) {
    return { ok: false, reason: `run check errored: ${scrubText(String(err))}` };
  }
}

export function resolveRepoCommand(
  check: Check,
  kind: "testsPass" | "buildPasses" | "lintClean",
  defaults: DeterministicDeps["defaults"],
): string {
  if (check.command) return check.command;
  if (kind === "testsPass") return defaults?.testCommand ?? "npm test";
  if (kind === "buildPasses") return defaults?.buildCommand ?? "npm run build";
  return defaults?.lintCommand ?? "npm run lint";
}

// ===============================================================================================
// testsPass PIPELINE: design and verdict algebra (plan Phase 2.1, task 2.1.1)
//
// Contract types: src/verify/types.ts, block "testsPass pipeline contract" (Deadline,
// ReferenceState, ScopedOutcome, RecheckOutcome, FailureClassification, TestsPassJudgement,
// ScopedExecutor, Rechecker, VerificationScope, TestsPassRequest/Run/Hook, JudgeScoped). That
// block is cherry-picked onto vrb/p22 (2.2 batch.ts) and vrb/p24 (2.4 pending.ts): later 2.1 tasks
// must NOT edit it (a different copy on both sides conflicts at merge); 2.1-internal types go
// elsewhere. Plan: docs/plans/verification-resource-budget-plan.md sections 1.2, 1.4, 1.5, 1.6.
// Record: docs/qa/verification-resource-budget/phase-2.1.md.
//
// -----------------------------------------------------------------------------------------------
// T1. GUARANTEES (plan section 1.2), as invariants of judgeScoped and the pipeline
//
//   G1 Excuse. A failing scoped run passes ("no worse than before") ONLY when all hold: the scoped
//      result is complete and has no collection error; the recheck is "exact" (reference exact,
//      unreproduced inert, rerun complete, no collection error, total > 0); and EVERY failing id
//      is failing at the reference. Anything less is unverifiable or fail, never pass.
//   G2 Reject. testsPass reports fail ONLY when at least one failing id is PROVEN introduced
//      against an "exact" recheck (T5). One proof suffices, so rejecting does not need a complete
//      scoped inventory. Every other non-pass is unverifiable, never fail.
//   G3 No false green. A scoped run passes without a recheck only when it ran, did not time out,
//      is complete, has no collection error and lists no failing id. readResult's zero-test guard
//      (runner.ts I step 2a) already turned untrustworthy zero-test runs into complete = false.
//   G4 unverifiable is a caveat: gate.ts accepts it with caveats, or rejects it under
//      strictUnverifiable, unchanged. A rejection keeps today's onFailure and escalation ladder.
//   G5 No full suite. Only testScope "full" runs the resolved command unscoped. S6 never falls
//      back to it. With no TestsPassHook in the deps, testsPass is unverifiable, never a run.
//   G6 No test command at dispatch time: dispatch captures a git reference only (captureReference).
//   G7 A deferred (unverified) delegation is never reported as verified. That is 2.4's footer.
//
// -----------------------------------------------------------------------------------------------
// T2. PIPELINE STEPS (one testsPass check of one gate or router_verify call)
//
//   step                           owner (task)                    Wave-1 function used
//   -----------------------------  ------------------------------  ------------------------------
//   S0 deadline + AbortController  index.ts both gate sites        withTimeout (timeout.ts);
//      per gate invocation         (2.1.5a); router_verify 2.4     createDeadline (2.1.2.1)
//   P0 prepare: tree snapshot,     wiring.prepareVerification      snapshotTree (tree.ts),
//      changed files, reference    (2.1.3), bounded by the deadline captureReference result
//   P1 command + allowlist         runCommandCheck (2.1.2.4)       resolveRepoCommand,
//                                                                  isCommandAllowed
//   P2 S1 scoping                  TestsPassHook (2.1.2.4; 2.2     planScopedRun (runner.ts)
//                                  swaps in the batch coordinator)
//   P3 S6 fail-closed decisions    TestsPassHook                   isUnverifiable, isNoAffected
//   P4 S3 slot, once per scope     VerificationScope (2.1.2.2)     acquireSlot (slot.ts)
//   P5 S4 caps, low priority,      ScopedExecutor (2.1.2.2)        runArgv (exec.ts); the worker
//      abort; run                                                  cap is already in spec.args
//   P6 readResult, on EVERY path   ScopedExecutor                  readResult (runner.ts)
//   P7 S2 recheck at the dispatch  Rechecker (2.1.2.3)             gcStaleReferences, materialize,
//      reference                                                   MaterializedReference.toRefPath/
//                                                                  dispose (reference.ts);
//                                                                  detectRunner, resolveEntry,
//                                                                  planRerun, readResult (runner.ts)
//   P8 verdict                     judgeScoped (baseline.ts,       -
//                                  2.1.4), then runDeterministic
//                                  and gate.ts as today
//   P9 cleanup                     VerificationScope.close         SlotHandle.release, dispose
//
//   P0  The deadline exists before prepareVerification, so the snapshot and the wait for a
//       still-pending capture are bounded by it. ReferenceState is settled when the request is
//       built: "captured" | "disabled" (failureRecheck off) | "none" (with a reason, T7 u4).
//   P1  Not allowlisted -> unverifiable "command not allowlisted: <command>" (as today).
//       testsPass does NOT run inside deps.mutex: that per-cwd lock would serialize exactly the
//       concurrent gates that 2.2 must batch. buildPasses and run keep the mutex.
//   P2  planScopedRun({ command, cwd, changedFiles, budget: { maxWorkers }, fs: PlannerFs,
//       search: TestSearchSeam, host }). changedFiles is ChangedPath[] (tree-snapshot status,
//       previousPath for renames) or "unavailable". fs and search are built in wiring.ts
//       (2.1.3, T9). testScope "full": no planning; the resolved command runs as written (P5f).
//   P3  NoAffected -> ScopedOutcome "no-affected" (pass with its note). Unverifiable ->
//       "unverifiable" (code + reason). Neither takes the slot nor spawns anything.
//   P4  scope = openScope({ cwd, command }). The first execute() calls acquireSlot({ max:
//       budget.maxConcurrentVerifications, waitMs: deadline.bound(budget.slotWaitMs), signal:
//       deadline.signal, meta, onLost }). busy -> "slot-busy" { waitedMs, deadlineCut:
//       deadline.remaining() === 0 }. Later calls on a busy scope return the same outcome at once.
//       The hold covers the scoped run AND the recheck (QA-1.4-18), and is never nested: the
//       process holds at most one scope per check, and runDeterministic awaits a check's close()
//       before the next check starts (T8).
//   P5  argv(spec.file, spec.args, { cwd: spec.cwd, env: spec.env, lowPriority:
//       budget.lowPriority, signal: deadline.signal, timeoutMs: deadline.bound(checkTimeoutMs) }),
//       checkTimeoutMs = deps.timeoutMs ?? 120000. Specs are never run through a shell.
//       timedOut -> "timed-out" { boundMs } when deadline.signal did not abort, else "aborted"
//       { reason: "gate budget exhausted during the scoped run" }. A signal already aborted
//       before the spawn -> "aborted", with no spawn.
//   P5f testScope "full": runShell-backed exec(command, { cwd, lowPriority, signal, timeoutMs })
//       under the same scope (user text keeps shell + allowlist, section 1.5-1). Its RunResult is
//       synthesized from observeTests(execResult): source "text", failingIds = obs.failures,
//       failingFiles = the id file parts (T5 fileKeyOfId) resolved against cwd, complete =
//       obs.complete, collectionError = (code !== 0 && failures empty), total = undefined.
//   P6  readResult(spec, execResult, runnerFs) after EVERY spawn attempt: exit, timeout, abort,
//       and a spawn that threw (with { code: -1, stdout: "", stderr: <message> }), because it
//       deletes the report file (QA-1.3-16). An executor exception -> "error".
//   P7  The recheck runs only for "ran" with >= 1 failing id and >= 1 failing file (T4).
//   P8  judgeScoped(scoped, recheck) -> TestsPassJudgement, returned as the check's CheckResult.
//   P9  scope.close() waits for pending disposals, then releases the slot; never rejects. The
//       testsPass hook waits for it only until CLOSE_MARGIN_MS before the gate deadline ends
//       (closeWithinDeadline, QA-2.1-3, QA-2.1-13): within that a close is awaited, so scopes
//       never nest (T8); after it the close carries on in the background (errors logged), still releasing
//       the slot only after the disposal, and no later check of the gate can acquire one. A slow
//       dispose never costs a verdict.
//
// -----------------------------------------------------------------------------------------------
// T3. DEADLINE SEMANTICS (section 1.5-13)
//
//   - One Deadline per gate invocation (delegate tool AND native task) and per router_verify
//     call, created with budget.gateBudgetMs. Its signal aborts at expiry, or when the owner's
//     withTimeout(accept(...), gateBudgetMs, "verification gate") rejects (index.ts aborts the
//     controller, then returns unverifiableGateResult as today).
//   - Every step is bounded by deadline.bound(ownBudget) and receives deadline.signal:
//       test search call      bound(10_000) each (git ls-files / git grep, low priority)
//       slot wait             bound(slotWaitMs): a 60 s slot wait under a 5 s budget waits <= 5 s
//       scoped run            bound(checkTimeoutMs)
//       recheck sub-deadline  rd = deriveDeadline(deadline, recheckTimeoutMs): recheckTimeoutMs
//                             bounds GC + materialize + rerun together, never past the gate
//       GC                    rd.bound(5_000)
//       materialize           rd.bound(DEFAULT_MATERIALIZE_TIMEOUT_MS)
//       rerun                 rd.bound(recheckTimeoutMs)
//       batch wait (2.2)      bound(batchWindowMs)
//     A step whose bound is 0 is not started: the slot reports busy (deadlineCut), a spawn
//     reports aborted, a recheck reports skipped-deadline.
//   - Recheck threshold: RECHECK_MIN_REMAINING_MS = 10_000. The Rechecker checks
//     deadline.remaining() FIRST; below it -> "skipped-deadline" (u7 "gate budget exhausted
//     before recheck"), with nothing materialized or spawned.
//   - Abort kills the tree: runArgv/runShell kill the whole process tree on signal abort
//     (exec.ts, 1.2); acquireSlot returns busy on an aborted signal; materialize and GC stop at
//     their next check. dispose runs only after the rerun tree has exited.
//   - The dispatch-side capture is NOT under a gate deadline. It is bounded by
//     baselineTimeoutMs, and the dispatch awaits it for at most captureWaitMs (clamped to
//     baselineTimeoutMs; 2.4 replaces it with VERIFY_WAIT). A timeout or error there means
//     "no reference" and never blocks or fails the dispatch.
//   - Deadline is fake-timer friendly: createDeadline uses an injected clock and setTimeout, and
//     dispose() clears its timer, so no timer outlives the gate. It owns the gate's
//     AbortController (plan 2.1.5.a): the owner calls abort() when withTimeout rejects.
//
// -----------------------------------------------------------------------------------------------
// T4. RECHECK (S2), steps of the Rechecker returned by scope.rechecker(command, liveCwd)
//
//   Decided by the hook before any Rechecker call (no spawn):
//     ReferenceState "disabled" -> { kind: "disabled" }.
//     ReferenceState "none"     -> { kind: "unusable", cause: "no-reference", reason }.
//   Inside the Rechecker(reference, failingFiles, deadline), in this order:
//     a. deadline.remaining() < RECHECK_MIN_REMAINING_MS -> "skipped-deadline".
//     b. runner = detectRunner(command, liveCwd). S6 -> unusable "rerun-unplannable".
//        runner.kind "pytest" -> unusable "runner-unsupported" (reference.ts OPEN RISKS: an
//        editable install imports the LIVE tree's sources, so a pytest reference run can neither
//        excuse nor prove; running it would only spend CPU).
//     c. gcStaleReferences(reference.root, refDeps with rd.bound(5_000)) INSIDE the hold, before
//        materialize (QA-1.5-10). Its report is logged; it never fails the recheck.
//     d. materialize(reference, currentSnapshot, rd.signal, refDeps with the T3 bound) INSIDE the
//        hold. ok:false "commit-missing" -> unusable "reference-vanished"; any other ok:false ->
//        unusable "materialize-failed" (reason = its detail).
//     e. !exact -> { kind: "approximate", inexactReasons }. Dispose; no rerun (it could neither
//        excuse nor prove, section 1.5-7).
//     f. Any unreproduced entry that is not inert -> unusable "unreproduced-inputs" (QA-1.5-7).
//        Dispose; no rerun. INERT_UNREPRODUCED, matched on the entry's last segment (a dir ends
//        in "/"), case-insensitive on win32:
//          dirs   coverage/ .nyc_output/ logs/ .idea/ .vscode/ .pytest_cache/ __pycache__/
//                 .mypy_cache/ .ruff_cache/
//          files  *.log .DS_Store Thumbs.db desktop.ini .eslintcache *.pyc
//        Never inert: .env*, build output (dist/ build/ out/ .next/), generated sources, and
//        anything not listed. Additions need evidence that tests cannot read them.
//     g. For each failing file f (absolute live path): r = toRefPath(f). undefined (outside the
//        root) -> f stays unclassified. !fileExists(r) -> absentFiles. Else -> the rerun list.
//     h. Rerun list empty -> { kind: "exact", result: undefined, ranFiles: [], absentFiles }.
//     i. entry = resolveEntry(runner, runner.runnerCwd) on the LIVE tree, the canonical start
//        the scoped plan used (E2E-2: the raw liveCwd may be an 8.3 short path; the reference links its
//        node_modules); spec = planRerun(runner, rerunList, toRefPath(runner.runnerCwd), budget,
//        { fs, entry, host }). S6, or NoAffected (contradicts g) -> unusable "rerun-unplannable".
//     j. Run it exactly as P5/P6 with timeoutMs = rd.bound(recheckTimeoutMs). A timeout or an
//        abort -> { kind: "timed-out", boundMs }.
//     k. After readResult: lstat(reference.dir) gone -> unusable "reference-vanished" (QA-1.5-4);
//        complete === false -> "incomplete"; collectionError -> "collection-error" (1.5-8);
//        total === 0 -> "no-tests" (QA-1.3-17). Otherwise { kind: "exact", result, ranFiles,
//        absentFiles, notes }.
//     l. dispose() once the rerun tree has exited; the scope tracks it and close() awaits it.
//   File keys (ranFiles, absentFiles) live in id space: P.relative(spec.cwd, abs) with "/"
//   separators, the construction readResult uses for ids. ranFiles use the rerun spec's cwd;
//   absentFiles use runner.runnerCwd (the live spec's cwd). A spelling mismatch can only leave
//   an id unclassified, which is unverifiable, never pass.
//
// -----------------------------------------------------------------------------------------------
// T5. VERDICT ALGEBRA: judgeScoped(scoped, recheck) (baseline.ts, 2.1.4). Pure and total.
//
//   fileKeyOfId(id) = the part before the earliest " > " or "::", else id.
//   C = scoped.result (kind "ran").
//   1. Planning, slot, timeout, abort and error kinds -> their row (T6); the recheck is ignored.
//   2. C.complete && !C.collectionError && C.failingIds empty -> pass (row R1).
//   3. C.failingIds empty -> unverifiable (row R4: incomplete without identities; R3 when
//      C.collectionError).
//   4. recheck undefined -> unverifiable (u11 when C.collectionError, else u9). Non-exact kinds ->
//      their column (T6).
//   5. Exact: classify each x in C.failingIds, with R = recheck.result and f = fileKeyOfId(x):
//        f in absentFiles                                   -> introduced (new test file)
//        f in ranFiles and x in R.failingIds                -> preexisting
//        f in ranFiles and C.source === "report"            -> introduced (id-level: same format)
//        f in ranFiles and no id of R has file key f        -> introduced (file-level: the file
//                                                              collected and passed at the reference)
//        otherwise                                          -> unknown
//      A bare-file id (collection error now) is never preexisting: a comparable rerun has no
//      collection error, hence no bare ids. It is introduced when its file ran or is absent.
//   6. introduced non-empty -> fail r1 (G2), naming ONLY the introduced ids.
//      else unknown empty && C.complete && !C.collectionError -> pass n2 (G1).
//      else -> unverifiable (u8 when unknown is non-empty, else u10).
//
// -----------------------------------------------------------------------------------------------
// T6. TRUTH TABLE
//
//   Cell = ok / unverifiable, then the T7 code of the reason or note.
//     P = ok:true  unverifiable:false     F = ok:false unverifiable:false (reject, escalate)
//     V = ok:false unverifiable:true (caveat; rejected only under strictUnverifiable)
//   Recheck columns:
//     --  not attempted (recheck undefined)       X+ exact, every failing id preexisting
//     X-  exact, >= 1 id introduced                X? exact, none introduced, >= 1 unknown
//     A   approximate                              U  unusable (any cause, incl. no reference)
//     D   disabled (failureRecheck off)            T  rerun timed out     S  skipped for deadline
//
//   scoped row                      --      X+      X-      X?      A      U      D      T      S
//   ------------------------------  ------  ------  ------  ------  -----  -----  -----  -----  -----
//   R0 no-affected                  P n0    not attempted: a supplied recheck is ignored -> P n0
//   R1 green                        P e1    not attempted: a supplied recheck is ignored -> P e1
//                                           (plus note n1 when total === 0)
//   R2 failures, complete           V u9    P n2    F r1    V u8    V u3   V u4   V u5   V u6   V u7
//   R2i failures, incomplete        V u9    V u10   F r1    V u8    V u3   V u4   V u5   V u6   V u7
//       inventory (complete false)
//   R3 collection error             V u11   V u10*  F r1    V u8    V u3   V u4   V u5   V u6   V u7
//   R4 incomplete, no failing id    V u12   not attempted: nothing to recheck -> V u12
//   R5 timed out / aborted          V u13   not attempted -> V u13
//   R6 slot busy                    V u14   not attempted -> V u14
//   R7 S6 unverifiable              V u15   not attempted -> V u15
//   R8 executor error               V u16   not attempted -> V u16
//
//   --: for R2/R2i/R3 the recheck is not attempted when no failing file is identified (u9; u11
//     for a collection error). A pipeline defect that skips it is caught the same way.
//   X+ in R3 (*): cannot occur for a bare-file id (T5.5). With only non-bare ids, all
//     preexisting, the collection error still leaves the inventory incomplete -> u10.
//   R2 x X+ is the only pass that has failures (G1). Every F cell rests on a proven id (G2).
//
// -----------------------------------------------------------------------------------------------
// T7. WORDING (stable; tests assert it verbatim). <ids> = at most 10 ids, then " (+<k> more)".
//     Every V and F reason of rows R2, R2i and R3 ends with "; observed failures: <ids>".
//
//   n0  the NoAffected note, verbatim (runner.ts M.2), e.g. "no changed files, no affected tests"
//   e1  evidence "testsPass: affected tests passed (<runner>, <total> tests)"
//   n1  note "testsPass: no affected tests ran"
//   n2  note "testsPass: no worse than before; pre-existing failures: <ids>; suite is NOT green
//       (affected tests checked against the exact dispatch reference)"
//   r1  reason "testsPass: introduced failures: <introduced>", plus the note "testsPass: also
//       failing at the dispatch reference: <preexisting>" when that list is non-empty
//   u3  "testsPass: cannot attribute failures: the dispatch reference is approximate
//       (<cause> <path>, ...)"
//   u4  no-reference: "testsPass: no reference: pre-existing failures cannot be told apart
//       (<ReferenceState reason>)"; other causes: "testsPass: cannot attribute failures:
//       reference unusable (<cause>): <reason>"
//       ReferenceState "none" reasons: "the dispatch-time capture failed or timed out", "an edit
//       was observed in an overlapping directory before the capture resolved", "the dispatch
//       was not tracked", "the capture had not resolved within the gate budget"
//   u5  "testsPass: cannot attribute failures: failureRecheck is off, pre-existing failures
//       cannot be told apart"
//   u6  "testsPass: cannot attribute failures: the reference rerun timed out after <n>ms"
//   u7  "testsPass: gate budget exhausted before recheck"
//   u8  "testsPass: cannot prove failures predate dispatch: <unknown>"
//   u9  "testsPass: cannot attribute failures: no failing test file identified, recheck not
//       attempted"
//   u10 "testsPass: the scoped failure inventory is incomplete (<C.note or 'collection error'>);
//       known failures predate dispatch, others may not"
//   u11 "testsPass: collection error without failing test files: <C.note>"
//   u12 "testsPass: the scoped result is incomplete: <C.note> (exit <code>)"
//   u13 "testsPass timed out after <boundMs>ms: <command>" | "testsPass: <aborted reason>"
//   u14 "verification slot busy (waited <n>ms)" | "gate budget exhausted waiting for the
//       verification slot" (deadlineCut)
//   u15 "testsPass: scoping impossible (<code>): <reason>"
//   u16 "testsPass check errored: <scrubbed reason>"
//
// -----------------------------------------------------------------------------------------------
// T8. OTHER COMMAND CHECKS UNDER S3/S4 (2.1.2.5)
//
//   buildPasses, lintClean and run each open their own scope (never nested: runDeterministic is
//   sequential and awaits each check's close() before the next check). Low priority,
//   deadline.signal, timeoutMs = deadline.bound(checkTimeoutMs). Slot busy -> unverifiable u14.
//   Their timeouts and exit codes keep today's meaning (fail). lintClean: planScopedLint ->
//   LintSpec (argv, exit code decides) | NoAffected (pass, note) | Unscoped (the resolved
//   command through the shell, as today). run: section 1.5-12, as written.
//
// -----------------------------------------------------------------------------------------------
// T9. WAVE-1 HANDOFFS (verified against docs/qa/verification-resource-budget/phase-1.*.md)
//
//   1.1  wiring.ts `baselineTimeoutMs ?? 60000` and the two reads of the deprecated dispatch-time baseline key ->
//        resolveVerifyBudget(cfg).baselineTimeoutMs / .failureRecheck (2.1.3). index.ts: drop
//        the DEFAULT_GATE_BUDGET_MS import and read resolveVerifyBudget(cfg).gateBudgetMs
//        (2.1.5c). timeout.ts:37 is outside 2.1's write-set and stays. tiers.json: remove
//        `"gateBudgetMs": 90000` so the code default applies (2.1.5c).
//        warnDeprecatedVerifyKeys(cfg, logger) after every loadConfig() (2.1.5c).
//        resolveVerifyBudget clamps captureWaitMs to baselineTimeoutMs (QA-1.6-8, 2.1.5c).
//        QA-1.4-21 residual stated in the slotWaitMs JSDoc (2.1.5c).
//   1.2  QA-1.2-13: every verification spawn passes lowPriority, and specs pass spec.env
//        (2.1.2.2). Specs use runArgv; full and legacy commands use runShell (2.1.2.2/.4/.5).
//   1.3  QA-1.3-16: readResult on every path (P6). QA-1.3-17: complete false or collectionError
//        are not comparable, and a rerun with 0 tests is unusable (T4.k, T5).
//        PlannerFs: fs.promises.realpath, stat(p, { bigint: true }) mapped to FileStat, readdir,
//        and a fileExists that accepts directories (2.1.3). TestSearchSeam over the ArgvSeam:
//        `git -C <root> ls-files -z --cached --others --exclude-standard -- :(glob)**/<name>...`
//        and `git -C <root> grep -l -z -F --untracked -e <needle> -- <globs>`; grep exit 1 -> [],
//        any other failure or timeout -> undefined (2.1.3). previousPath from the porcelain rename
//        source (tree.ts, 2.1.3). planRerun(deps.entry) with the live entry (T4.i). node comes
//        from host.nodePath/PATH: never pass process.execPath (Bun 1.3.14 hosts the plugin).
//        pytest specs keep the adapter's --rootdir (no rewriting of spec.args anywhere).
//   1.4  QA-1.4-18: one hold per scope, held across the recheck, never nested (P4, T8).
//        onLost: a note "verification slot was reclaimed during the run" and a warning; the
//        verdict stands. QA-1.4-19/31: max and waitMs come from the validated budget.
//   1.5  QA-1.5-7: inert allowlist (T4.f). QA-1.5-10: GC before materialize, both inside the
//        hold (T4.c/d); gcStaleReferences at plugin start (2.1.5b). QA-1.5-4: vanished ->
//        unusable (T4.d/k). QA-1.5-25: 2.1 passes no per-call maxBuffer; a future one must be
//        Math.floor'ed. materialize failure -> unusable (T4.d).
//   1.6  QA-1.6-13: previousPath (2.1.3). QA-1.6-22: TreeSnapshot.root = realpath of
//        `git rev-parse --show-toplevel` (tree.ts, 2.1.3); 2.4 passes it as the risk root.
//        Tool-observed files never carry deletions: prepareVerification takes each path's status
//        and previousPath from the current tree snapshot when it lists the path (2.1.3). 2.4
//        parses only the orchestrator's prompt (not 2.1).
//
// -----------------------------------------------------------------------------------------------
// T10. IMPLEMENTATION TASKS (2.1.2-2.1.6; each <= ~20 tool calls; commit + push each green)
//
//   Order: .1 -> 2.1.4 -> .2 -> .3 -> .4 -> 2.1.3a -> 2.1.3b (cut-over) -> .5 -> 2.1.5a/b/c
//   -> 2.1.6a/b/c. Tests run scoped: npx vitest run <files>.
//
//   2.1.2.1 deterministic.ts: export createDeadline(budgetMs, { now? }): Deadline & { abort(reason?:
//           string): void; dispose(): void }, deriveDeadline(parent, ownMs): Deadline,
//           RECHECK_MIN_REMAINING_MS = 10_000, INERT_UNREPRODUCED + isInertUnreproduced(entry,
//           platform), fileKeyOfId(id). Tests: test/unit/tests-pass-pipeline.test.ts (new),
//           fake timers: bound/remaining/abort/dispose, derive never exceeds the parent.
//   2.1.4   baseline.ts: export judgeScoped: JudgeScoped per T5/T6/T7. Keep observeTests;
//           the legacy comparator stays until the cut-over deletes it. Tests: a table-driven block in
//           test/unit/baseline.test.ts with one case per T6 cell, T5 classification edge cases
//           (bare ids, text source, absent files, id-level vs file-level) and the <ids> cap.
//   2.1.2.2 deterministic.ts: export createScopeOpener(deps: { argv: ArgvSeam; exec: ExecSeam;
//           fs: RunnerFs; acquire?: typeof acquireSlot; budget: VerifyBudget; checkTimeoutMs:
//           number; host?: Partial<RunnerHost>; logger? }) returning an OpenVerificationScope
//           whose scopes also offer the 2.1-internal runShell(command, cwd, deadline) and
//           runLint(spec, deadline) (a CheckScope interface in deterministic.ts). execute per
//           P4-P6. Tests: busy, deadlineCut, abort before spawn (zero spawns), timeout (the argv
//           seam sees an aborted signal), a spawn throw still unlinks the report, onLost note,
//           lowPriority and env reach the seam, one acquire across several execute calls.
//   2.1.2.3 deterministic.ts: the Rechecker behind scope.rechecker(command, cwd), steps T4.a-l,
//           with injectable materialize/gc/detectRunner/resolveEntry/planRerun seams (defaults
//           from reference.ts/runner.ts) and dispose tracking in close(). Tests: every
//           RecheckOutcome kind and cause, GC-before-materialize order, no rerun for approximate,
//           non-inert unreproduced and pytest, the vanished dir, disposal before release.
//   2.1.2.4 deterministic.ts: export createDirectTestsPassHook(deps): TestsPassHook (P2, P3,
//           P5f, then the T4 pre-decisions and the recheck, then close). Tests: planning outcomes
//           spawn nothing, full mode runs once with the synthesized RunResult, green -> no
//           Rechecker call, failures -> exactly one.
//   2.1.3a  tree.ts: keep the rename source as previousPath; add root (realpath of
//           show-toplevel). dispatch.ts: TreeSnapshot gains root; ChangedFile gains
//           previousPath?. Additive. Tests: extend test/unit/baseline-wiring.test.ts snapshot cases.
//   2.1.3b  CUT-OVER, one commit: DeterministicDeps (types.ts, outside the 2.1.1 block) drops
//           the dispatch-time baseline hook and gains testsPass?: TestsPassHook, openScope?, argv?, changedFiles?,
//           reference?, budget?, deadline? (a missing hook -> testsPass unverifiable, G5).
//           runCommandCheck's testsPass branch calls deps.testsPass, then judgeScoped, outside
//           the mutex. dispatch.ts: the store keeps bySession/delta/record/observeEdit/sweep,
//           replaces cache/baselines/baseline() with a per-dispatch Promise<ReferenceState> made
//           by an injected capture, and observeEdit contaminates an in-flight capture. wiring.ts:
//           beginVerification is async (capture only for a testsPass DoD with failureRecheck
//           on); prepareVerification(store, id, childID, cwd, deadline) returns { changedFiles:
//           ChangedPath[], changeBaseline, reference: ReferenceState, snapshot }; buildGateDeps
//           takes the deadline and wires the hook, the scope opener, the PlannerFs and the
//           TestSearchSeam. index.ts: only the two lines that set the dispatch-time baseline
//           change. Delete the legacy comparator and its baseline type. Update
//           baseline(-wiring).test.ts for the removed APIs.
//   2.1.2.5 deterministic.ts: buildPasses, lintClean (planScopedLint) and run through per-check
//           scopes (T8). Tests: the slot is taken once per check, never nested; lint scoping.
//   2.1.5a  index.ts: a Deadline + AbortController per gate in both sites; the native task
//           accept() gets the same withTimeout + abort + unverifiableGateResult as delegate.
//   2.1.5b  index.ts: await beginVerification for at most captureWaitMs in the task before-hook
//           and the delegate dispatch; call gcStaleReferences once at plugin start
//           (fire-and-forget, failures logged).
//   2.1.5c  config.ts: clamp captureWaitMs to baselineTimeoutMs; slotWaitMs JSDoc gets the
//           QA-1.4-21 residual. index.ts: resolveVerifyBudget for gateBudgetMs; drop the
//           DEFAULT_GATE_BUDGET_MS import; warnDeprecatedVerifyKeys after every loadConfig().
//           tiers.json: drop gateBudgetMs. Tests: the clamp, and a warning on reload.
//   2.1.6a  test/unit/baseline.test.ts: rewrite to the new model, keeping the escalation
//           assertions (a rejected verdict still climbs the ladder exactly as before).
//   2.1.6b  test/unit/baseline-wiring.test.ts: read-only dispatch (no reference, no command);
//           implementation dispatch (a reference, zero test commands); bounded capture wait (2 s
//           -> 2 s, 20 s -> 5 s and still usable); contamination; a throwing capture; retry reuses
//           the first reference; failureRecheck false (or the deprecated dispatch-time baseline key false): no capture, no
//           worktree ever.
//   2.1.6c  test/unit/tests-pass-pipeline.test.ts: the plan's deadline cases (5 s budget cuts a
//           60 s slot wait; 8 s left skips the recheck; no step outlives the deadline, by seam
//           timestamps), the native task budget, the gate abort killing the tree, full mode, and
//           the acceptance greps (no dispatch-time run; every spawned argv is scoped).
//
// -----------------------------------------------------------------------------------------------
// T11. RESIDUAL RISKS (accepted; QA may challenge)
//
//   - Flaky tests: failing now and passing at the reference reads as introduced (as with 1.14).
//   - Id identity only: a test failing at the reference and failing now for a new cause is
//     preexisting. The note says the suite is not green.
//   - A native `task` re-dispatch after a rejection captures a new reference that contains the
//     failed attempt's changes. The router cannot link it to the earlier dispatch (the delegate
//     ladder can, and keeps its first reference). The n2 note still names the failures and says
//     the suite is not green. Candidate mitigation: 2.4's registry, which knows the orchestrator.
//   - A vitest `related` run aborted by a syntax error writes no report: no file identity, so
//     the result is unverifiable (u11), not a rejection.
//   - Concurrent agents editing the same files: attribution is per session (ADR 0002 D3); a
//     reference cannot separate two producers' changes to one file.
// ===============================================================================================

export { fileKeyOfId } from "./baseline";

/** T3: below this many milliseconds left, the Rechecker skips (u7) without materializing or spawning. */
export const RECHECK_MIN_REMAINING_MS = 10_000;

/** A Deadline plus its owner's controls (T3, plan 2.1.5.a). */
export interface OwnedDeadline extends Deadline {
  /** Aborts `signal` now (the owner's withTimeout rejected). Idempotent. */
  abort(reason?: string): void;
  /** Clears the expiry timer; no timer outlives the gate. Idempotent. */
  dispose(): void;
}

export interface DeadlineOptions {
  /** Injected clock in ms; default Date.now. */
  now?: () => number;
}

/** setTimeout clamps delays above this to 1 ms, so longer waits are chained. */
const MAX_TIMER_MS = 2_147_483_647;

function clampMs(ms: number): number {
  return Number.isNaN(ms) ? 0 : Math.max(0, ms);
}

function makeDeadline(
  budgetMs: number,
  now: () => number,
  parent: Deadline | undefined,
  defaultReason: string,
): OwnedDeadline {
  const budget = clampMs(budgetMs);
  const endsAt = now() + budget;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ownLeft = (): number => Math.max(0, endsAt - now());
  const clear = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const onParentAbort = (): void => abort("parent deadline aborted");
  const abort = (reason?: string): void => {
    clear();
    parent?.signal.removeEventListener("abort", onParentAbort);
    if (!controller.signal.aborted) controller.abort(new Error(reason ?? defaultReason));
  };
  const schedule = (): void => {
    const left = ownLeft();
    if (left === Infinity) return;
    if (left <= 0) {
      abort(defaultReason);
      return;
    }
    timer = setTimeout(schedule, Math.min(left, MAX_TIMER_MS));
    timer.unref?.();
  };
  const remaining = (): number => {
    if (controller.signal.aborted) return 0;
    return parent ? Math.min(ownLeft(), parent.remaining()) : ownLeft();
  };
  if (parent?.signal.aborted) {
    abort("parent deadline aborted");
  } else {
    parent?.signal.addEventListener("abort", onParentAbort, { once: true });
    schedule();
  }
  return {
    budgetMs: budget,
    remaining,
    bound: (ownBudgetMs: number): number => Math.min(clampMs(ownBudgetMs), remaining()),
    signal: controller.signal,
    abort,
    dispose: (): void => {
      clear();
      parent?.signal.removeEventListener("abort", onParentAbort);
    },
  };
}

/**
 * One deadline per gate invocation or router_verify call (T3). Its signal aborts at expiry (the
 * timer is unref'd) or on abort(); dispose() clears the timer.
 */
export function createDeadline(budgetMs: number, opts: DeadlineOptions = {}): OwnedDeadline {
  return makeDeadline(budgetMs, opts.now ?? Date.now, undefined, "gate budget exhausted");
}

/**
 * A sub-deadline of `ownMs` that never outlives `parent` (T3 recheck sub-deadline): remaining() is
 * min(own, parent), and its signal aborts at its own expiry or when the parent aborts.
 */
export function deriveDeadline(parent: Deadline, ownMs: number, opts: DeadlineOptions = {}): OwnedDeadline {
  return makeDeadline(Math.min(clampMs(ownMs), parent.remaining()), opts.now ?? Date.now, parent, "recheck budget exhausted");
}

/**
 * Where an INERT_UNREPRODUCED pattern may sit (QA-2.1-10), relative to the reference root:
 * - "root": only at the root itself (`logs/`, `debug.log`), never deeper, so an ignored
 *   `test/fixtures/logs/` or a `*.log` fixture a test reads is not inert;
 * - "package": at the root or at a monorepo package root `<dir>/<pkg>/` (`packages/web/coverage/`),
 *   and never under a test or fixture directory;
 * - "anywhere": caches and OS metadata that tools write beside every source and no test reads.
 */
export type InertScope = "root" | "package" | "anywhere";

/**
 * T4.f: `unreproduced` entries tests cannot read, each anchored by its InertScope. An entry matches
 * a pattern exactly (a directory ends in "/"; "*.ext" matches a file name), case-insensitive on
 * win32. Additions need evidence that tests cannot read them.
 */
export const INERT_UNREPRODUCED_SCOPES: Readonly<Record<string, InertScope>> = {
  "logs/": "root", ".idea/": "root", ".vscode/": "root", "*.log": "root", ".eslintcache": "root",
  "coverage/": "package", ".nyc_output/": "package", ".pytest_cache/": "package",
  ".mypy_cache/": "package", ".ruff_cache/": "package",
  "__pycache__/": "anywhere", "*.pyc": "anywhere", ".DS_Store": "anywhere", "Thumbs.db": "anywhere",
  "desktop.ini": "anywhere",
};

export const INERT_UNREPRODUCED: readonly string[] = Object.keys(INERT_UNREPRODUCED_SCOPES);

/** Directory names under which a "package" pattern is never inert: tests may read what is there. */
const TEST_DIR_NAMES = new Set([
  "test", "tests", "__tests__", "spec", "specs", "fixtures", "__fixtures__", "testdata", "test-data", "__snapshots__",
]);

export function isInertUnreproduced(entry: string, platform: string): boolean {
  const normalized = entry.replace(/\\/g, "/");
  const isDir = normalized.endsWith("/");
  const segments = normalized.split("/").filter(s => s !== "");
  const last = segments[segments.length - 1];
  if (last === undefined) return false;
  const fold = (s: string): string => (platform === "win32" ? s.toLowerCase() : s);
  const name = fold(last);
  const parents = segments.slice(0, -1).map(fold);
  const inScope = (scope: InertScope): boolean => {
    if (scope === "anywhere") return true;
    if (parents.length === 0) return true;
    return scope === "package" && parents.length === 2 && !parents.some(s => TEST_DIR_NAMES.has(s));
  };
  for (const [raw, scope] of Object.entries(INERT_UNREPRODUCED_SCOPES)) {
    const pattern = fold(raw);
    let matches = false;
    if (pattern.endsWith("/")) {
      matches = isDir && `${name}/` === pattern;
    } else if (!isDir) {
      if (pattern.startsWith("*.")) {
        const ext = pattern.slice(1);
        matches = name.length > ext.length && name.endsWith(ext);
      } else {
        matches = name === pattern;
      }
    }
    if (matches && inScope(scope)) return true;
  }
  return false;
}

// -----------------------------------------------------------------------------------------------
// Verification scopes (2.1.2.2): S3 slot, S4 caps, run and readResult (T2 P4-P6, P9)
// -----------------------------------------------------------------------------------------------

/** T7 u13 / P5: the stable abort phrases. */
export const ABORTED_BEFORE_RUN = "gate budget exhausted before the scoped run";
export const ABORTED_DURING_RUN = "gate budget exhausted during the scoped run";
/** T9 1.4: the note on an outcome whose slot was reclaimed while it ran. */
export const SLOT_LOST_NOTE = "verification slot was reclaimed during the run";

/** What a non-spec command (buildPasses, run, lint, testScope "full") produced under a scope. */
export type CommandOutcome =
  | Extract<ScopedOutcome, { kind: "slot-busy" | "aborted" | "error" }>
  | { readonly kind: "ran"; readonly exec: ExecResult; readonly notes: readonly string[] }
  | { readonly kind: "timed-out"; readonly boundMs: number; readonly exec: ExecResult };

/** A VerificationScope plus the 2.1-internal non-spec runs (P5f, T8), all under the same hold. */
export interface CheckScope extends VerificationScope {
  /** The resolved command through the shell seam (user text keeps shell + allowlist). Never rejects. */
  runShell(command: string, cwd: string, deadline: Deadline): Promise<CommandOutcome>;
  /** A scoped eslint spec through the argv seam. Never rejects. */
  runLint(spec: LintSpec, deadline: Deadline): Promise<CommandOutcome>;
  /**
   * VerificationScope.rechecker plus the current tree snapshot, forwarded to materialize so it can
   * detect drift since the snapshot (T4.d). Omitted -> materialize gets undefined.
   */
  rechecker(command: string, cwd: string, currentTree?: TreeSnapshot): Rechecker;
  /**
   * P4's hold, taken without running anything: the scope's one hold attempt, waiting at most
   * deadline.bound(slotWaitMs). true when the scope holds the slot. It is the same memoized
   * attempt as the first execute's, so a later execute reuses the hold (or its failure) and never
   * takes a second one. For 2.2's batch coordinator (QA-2.2-25), which decides what to run only
   * once it holds the slot. Never rejects. Optional: createScopeOpener's scopes have it.
   */
  hold?(deadline: Deadline): Promise<boolean>;
}

export type OpenCheckScope = (meta: Parameters<OpenVerificationScope>[0]) => CheckScope;

export interface ScopeOpenerDeps {
  argv: ArgvSeam;
  exec: ExecSeam;
  fs: RunnerFs;
  acquire?: typeof acquireSlot;
  budget: VerifyBudget;
  /** deps.timeoutMs ?? 120000 (P5). */
  checkTimeoutMs: number;
  host?: Partial<RunnerHost>;
  logger?: Pick<PluginLogger, "warn">;
  /** Clock for slot-busy waitedMs and the recheck sub-deadline; default Date.now. */
  now?: () => number;
  /** Reference seams for the recheck (T4); argv defaults to `argv`, fs to node:fs/promises, logger to `logger`. */
  reference?: Partial<ReferenceDeps>;
  /** T4 seams; each defaults to the reference.ts / runner.ts function of the same name. */
  recheck?: Partial<RecheckSeams>;
}

/** The injectable steps of the T4 Rechecker (2.1.2.3). */
export interface RecheckSeams {
  materialize: typeof materialize;
  gcStaleReferences: typeof gcStaleReferences;
  detectRunner: typeof detectRunner;
  resolveEntry: typeof resolveEntry;
  planRerun: typeof planRerun;
  readResult: typeof readResult;
}

/** T4.c: GC's own bound inside the recheck sub-deadline. */
const RECHECK_GC_MS = 5_000;
/** How many non-inert `unreproduced` entries the T4.f reason names. */
const MAX_NAMED_UNREPRODUCED = 5;

function unusable(cause: RecheckUnusableCause, reason: string): RecheckOutcome {
  return { kind: "unusable", cause, reason: scrubText(reason) };
}

type Blocked = Extract<ScopedOutcome, { kind: "slot-busy" | "aborted" | "error" }>;
type Hold = { readonly ok: true; readonly handle: SlotHandle } | { readonly ok: false; readonly outcome: Blocked };
interface Spawned {
  readonly kind: "spawned";
  readonly exec: ExecResult;
  /** Set when the seam threw; exec is then the synthesized { code: -1, stderr: <message> }. */
  readonly threw?: string;
  readonly boundMs: number;
  /** The deadline's signal had aborted by the time the run ended. */
  readonly cut: boolean;
  readonly notes: readonly string[];
}

function errorText(err: unknown): string {
  return scrubText(err instanceof Error ? err.message : String(err));
}

function toCommandOutcome(a: Blocked | Spawned): CommandOutcome {
  if (a.kind !== "spawned") return a;
  if (a.threw !== undefined) return { kind: "error", reason: `command failed to start: ${a.threw}` };
  if (a.exec.timedOut) {
    return a.cut ? { kind: "aborted", reason: "gate budget exhausted during the run" } : { kind: "timed-out", boundMs: a.boundMs, exec: a.exec };
  }
  return { kind: "ran", exec: a.exec, notes: a.notes };
}

/**
 * P4-P6, P9: each opened scope takes at most one slot hold (lazily, on its first run; never nested,
 * QA-1.4-18), runs every process at low priority under the deadline, calls readResult after every
 * spec spawn attempt (QA-1.3-16) and releases the hold on close(). Nothing here rejects.
 */
export function createScopeOpener(deps: ScopeOpenerDeps): OpenCheckScope {
  const { argv, exec, fs, budget, checkTimeoutMs, host, logger } = deps;
  const acquire = deps.acquire ?? acquireSlot;
  const now = deps.now ?? Date.now;
  const seams: RecheckSeams = {
    materialize: deps.recheck?.materialize ?? materialize,
    gcStaleReferences: deps.recheck?.gcStaleReferences ?? gcStaleReferences,
    detectRunner: deps.recheck?.detectRunner ?? detectRunner,
    resolveEntry: deps.recheck?.resolveEntry ?? resolveEntry,
    planRerun: deps.recheck?.planRerun ?? planRerun,
    readResult: deps.recheck?.readResult ?? readResult,
  };
  const refDeps: ReferenceDeps = {
    ...deps.reference,
    argv: deps.reference?.argv ?? argv,
    fs: deps.reference?.fs ?? nodeReferenceFs,
    ...(deps.reference?.logger === undefined && logger !== undefined ? { logger } : {}),
  };
  const P = (host?.platform ?? process.platform) === "win32" ? pathWin32 : pathPosix;
  /** Id-space file key (T4): cwd-relative with "/" separators, as readResult builds ids. */
  const fileKey = (cwd: string, abs: string): string => P.relative(cwd, abs).split(P.sep).join("/");

  return (meta): CheckScope => {
    let holdP: Promise<Hold> | undefined;
    let lost = false;
    let closed = false;
    let closing: Promise<void> | undefined;
    const inflight = new Set<Promise<unknown>>();

    const onLost = (): void => {
      lost = true;
      logger?.warn(`${SLOT_LOST_NOTE}: ${scrubText(meta.command)}`);
    };

    const acquireHold = async (deadline: Deadline): Promise<Hold> => {
      if (deadline.signal.aborted || deadline.remaining() === 0) {
        return { ok: false, outcome: { kind: "slot-busy", waitedMs: 0, deadlineCut: true } };
      }
      const started = now();
      // The deadline bounds the wait when it leaves less than slotWaitMs: a busy answer then ends
      // at the deadline, even when the wait's own timer fires a few ms before remaining() reads 0.
      const waitMs = deadline.bound(budget.slotWaitMs);
      const cutByDeadline = waitMs < budget.slotWaitMs;
      try {
        const r = await acquire({
          max: budget.maxConcurrentVerifications,
          waitMs,
          signal: deadline.signal,
          meta: { cwd: meta.cwd, command: meta.command },
          onLost,
        });
        if ("busy" in r) {
          return {
            ok: false,
            outcome: { kind: "slot-busy", waitedMs: Math.max(0, now() - started), deadlineCut: cutByDeadline || deadline.remaining() === 0 },
          };
        }
        return { ok: true, handle: r };
      } catch (err) {
        return { ok: false, outcome: { kind: "error", reason: `verification slot failed: ${errorText(err)}` } };
      }
    };

    const attempt = async (
      deadline: Deadline,
      launch: (opts: ExecOptions) => Promise<ExecResult>,
      ownMs: number = checkTimeoutMs,
    ): Promise<Blocked | Spawned> => {
      if (closed) return { kind: "error", reason: "verification scope already closed" };
      holdP ??= acquireHold(deadline);
      const hold = await holdP;
      if (!hold.ok) return hold.outcome;
      const boundMs = deadline.bound(ownMs);
      if (deadline.signal.aborted || boundMs <= 0) return { kind: "aborted", reason: ABORTED_BEFORE_RUN };

      // A per-run signal linked to the deadline: aborting it after a timeout or a failed spawn
      // makes the seam kill whatever tree is left (T3).
      const run = new AbortController();
      const onAbort = (): void => run.abort(deadline.signal.reason);
      deadline.signal.addEventListener("abort", onAbort, { once: true });
      let execResult: ExecResult;
      let threw: string | undefined;
      try {
        execResult = await launch({ lowPriority: budget.lowPriority, signal: run.signal, timeoutMs: boundMs });
      } catch (err) {
        threw = errorText(err);
        execResult = { code: -1, stdout: "", stderr: threw };
      }
      deadline.signal.removeEventListener("abort", onAbort);
      if (threw !== undefined || execResult.timedOut === true) {
        run.abort(new Error(threw ?? `run exceeded its ${boundMs}ms bound`));
      }
      return {
        kind: "spawned",
        exec: execResult,
        ...(threw !== undefined ? { threw } : {}),
        boundMs,
        cut: deadline.signal.aborted,
        notes: lost || hold.handle.lost ? [SLOT_LOST_NOTE] : [],
      };
    };

    const track = <T>(p: Promise<T>): Promise<T> => {
      inflight.add(p);
      void p.finally(() => inflight.delete(p));
      return p;
    };

    const runSpec = async (spec: Parameters<ScopedExecutor>[0], deadline: Deadline): Promise<ScopedOutcome> => {
      try {
        const a = await attempt(deadline, opts => argv(spec.file, spec.args, { ...opts, cwd: spec.cwd, env: { ...spec.env } }));
        if (a.kind !== "spawned") return a;
        let result: RunResult;
        try {
          // P6: on EVERY path after a spawn attempt; it deletes the report file (QA-1.3-16).
          result = await readResult(spec, a.exec, fs, host);
        } catch (err) {
          return { kind: "error", reason: `reading the scoped result failed: ${errorText(err)}` };
        }
        if (a.threw !== undefined) return { kind: "error", reason: `scoped run failed to start: ${a.threw}` };
        if (a.exec.timedOut) {
          return a.cut ? { kind: "aborted", reason: ABORTED_DURING_RUN } : { kind: "timed-out", boundMs: a.boundMs, result };
        }
        const notes = [...spec.notes, ...a.notes, ...(result.note !== undefined ? [result.note] : [])];
        return { kind: "ran", result, exitCode: a.exec.code, spec, notes };
      } catch (err) {
        return { kind: "error", reason: `scoped run errored: ${errorText(err)}` };
      }
    };

    const runCommand = async (deadline: Deadline, launch: (opts: ExecOptions) => Promise<ExecResult>): Promise<CommandOutcome> => {
      try {
        return toCommandOutcome(await attempt(deadline, launch));
      } catch (err) {
        return { kind: "error", reason: `command errored: ${errorText(err)}` };
      }
    };

    // T4.e-k at a materialized reference. The caller disposes it.
    const rerunAt = async (
      ref: MaterializedReference,
      runner: DetectedRunner,
      liveCwd: string,
      failingFiles: readonly string[],
      rd: Deadline,
    ): Promise<RecheckOutcome> => {
      if (!ref.exact) return { kind: "approximate", inexactReasons: ref.inexactReasons };
      const platform = host?.platform ?? process.platform;
      const hidden = ref.unreproduced.filter(e => !isInertUnreproduced(e, platform));
      if (hidden.length > 0) {
        const named = hidden.slice(0, MAX_NAMED_UNREPRODUCED).join(", ");
        const more = hidden.length > MAX_NAMED_UNREPRODUCED ? ` and ${hidden.length - MAX_NAMED_UNREPRODUCED} more` : "";
        return unusable("unreproduced-inputs", `the reference lacks ignored inputs tests may read: ${named}${more}`);
      }

      const rerunList: string[] = [];
      const absentFiles: string[] = [];
      for (const f of failingFiles) {
        const r = ref.toRefPath(f);
        if (r === undefined) continue; // outside the root: stays unclassified (T4.g)
        if (await fs.fileExists(r)) rerunList.push(r);
        else absentFiles.push(fileKey(runner.runnerCwd, f));
      }
      if (rerunList.length === 0) return { kind: "exact", result: undefined, ranFiles: [], absentFiles, notes: [] };

      // E2E-2: from runner.runnerCwd, the canonical start the scoped plan resolved its own entry
      // from (runner.ts planScopedRun). liveCwd is the request's spelling (the plugin directory
      // may be an 8.3 short path); resolveEntry canonicalises it too.
      const entry = await seams.resolveEntry(runner, runner.runnerCwd, fs, host);
      if (isUnverifiable(entry)) return unusable("rerun-unplannable", entry.reason);
      const refCwd = ref.toRefPath(runner.runnerCwd);
      if (refCwd === undefined) return unusable("rerun-unplannable", "the runner cwd is outside the reference root");
      const spec = await seams.planRerun(runner, rerunList, refCwd, { maxWorkers: budget.maxWorkers }, {
        fs,
        entry,
        ...(host !== undefined ? { host } : {}),
      });
      if (isUnverifiable(spec)) return unusable("rerun-unplannable", spec.reason);
      if ("noAffected" in spec) return unusable("rerun-unplannable", `the rerun planned nothing: ${spec.note}`);

      const a = await attempt(
        rd,
        opts => argv(spec.file, spec.args, { ...opts, cwd: spec.cwd, env: { ...spec.env } }),
        budget.recheckTimeoutMs,
      );
      if (a.kind === "aborted") return { kind: "skipped-deadline", remainingMs: rd.remaining() };
      if (a.kind === "slot-busy") return unusable("error", "the verification slot was not available for the recheck");
      if (a.kind === "error") return unusable("error", a.reason);
      let result: RunResult;
      try {
        // P6: on every path after a spawn attempt; it deletes the report file (QA-1.3-16).
        result = await seams.readResult(spec, a.exec, fs, host);
      } catch (err) {
        return unusable("error", `reading the recheck result failed: ${errorText(err)}`);
      }
      if (a.threw !== undefined) return unusable("error", `the recheck failed to start: ${a.threw}`);
      if (a.exec.timedOut === true) return { kind: "timed-out", boundMs: a.boundMs };
      try {
        await refDeps.fs.lstat(ref.dir);
      } catch (err) {
        return unusable("reference-vanished", `the reference worktree vanished during the rerun: ${errorText(err)}`);
      }
      if (!result.complete) return unusable("incomplete", result.note ?? "the rerun at the reference reported an incomplete result");
      if (result.collectionError) return unusable("collection-error", "the rerun at the reference failed to collect its tests");
      if (result.total === 0) return unusable("no-tests", "the rerun at the reference ran no tests");
      return {
        kind: "exact",
        result,
        ranFiles: rerunList.map(r => fileKey(spec.cwd, r)),
        absentFiles,
        notes: [...a.notes, ...(result.note !== undefined ? [result.note] : [])],
      };
    };

    // T4.a-l. The hook decides "disabled" and "none" before calling this.
    const recheck = async (
      command: string,
      liveCwd: string,
      reference: DispatchReference,
      failingFiles: readonly string[],
      deadline: Deadline,
      currentTree: TreeSnapshot | undefined,
    ): Promise<RecheckOutcome> => {
      const remainingMs = deadline.remaining();
      if (remainingMs < RECHECK_MIN_REMAINING_MS) return { kind: "skipped-deadline", remainingMs };
      const runner = await seams.detectRunner(command, liveCwd, fs, host);
      if (isUnverifiable(runner)) return unusable("rerun-unplannable", runner.reason);
      if (runner.kind === "pytest") {
        return unusable("runner-unsupported", "pytest cannot be pinned to the reference: an editable install imports the live sources");
      }
      if (closed) return unusable("error", "verification scope already closed");
      holdP ??= acquireHold(deadline);
      const hold = await holdP;
      if (!hold.ok) {
        return unusable("error", hold.outcome.kind === "error" ? hold.outcome.reason : "the verification slot was not available for the recheck");
      }

      const rd = deriveDeadline(deadline, budget.recheckTimeoutMs, { now });
      try {
        // QA-1.5-10: GC, then materialize, both inside the hold.
        const gc = await seams.gcStaleReferences(reference.root, { ...refDeps, timeoutMs: rd.bound(RECHECK_GC_MS) });
        if (gc.removed.length > 0 || gc.failed.length > 0) {
          logger?.warn(`reference GC removed ${gc.removed.length}, failed ${gc.failed.length}`);
        }
        if (rd.signal.aborted || rd.remaining() === 0) return { kind: "skipped-deadline", remainingMs: rd.remaining() };
        const m = await seams.materialize(reference, currentTree, rd.signal, {
          ...refDeps,
          timeoutMs: rd.bound(DEFAULT_MATERIALIZE_TIMEOUT_MS),
        });
        if (!m.ok) {
          return m.reason === "commit-missing"
            ? unusable("reference-vanished", `the reference commit is gone: ${m.detail}`)
            : unusable("materialize-failed", `materialize ${m.reason}: ${m.detail}`);
        }
        const ref = m.reference;
        try {
          return await rerunAt(ref, runner, liveCwd, failingFiles, rd);
        } finally {
          // T4.l: the rerun tree has exited here; close() waits for this before releasing the slot.
          track(ref.dispose().catch((err: unknown) => logger?.warn(`reference dispose failed: ${errorText(err)}`)));
        }
      } finally {
        rd.dispose();
      }
    };

    const rechecker = (command: string, liveCwd: string, currentTree?: TreeSnapshot): Rechecker => (reference, failingFiles, deadline) =>
      track(
        recheck(command, liveCwd, reference, failingFiles, deadline, currentTree).catch(
          (err: unknown): RecheckOutcome => unusable("error", `the reference recheck errored: ${errorText(err)}`),
        ),
      );

    const close = (): Promise<void> => {
      closing ??= (async (): Promise<void> => {
        closed = true;
        // Loop: a recheck settling here tracks its reference disposal (T4.l, P9).
        while (inflight.size > 0) await Promise.allSettled([...inflight]);
        if (holdP === undefined) return;
        const hold = await holdP;
        if (!hold.ok) return;
        try {
          await hold.handle.release();
        } catch (err) {
          logger?.warn(`verification slot release failed: ${errorText(err)}`);
        }
      })();
      return closing;
    };

    const hold = (deadline: Deadline): Promise<boolean> =>
      track(
        (async (): Promise<boolean> => {
          if (closed) return false;
          holdP ??= acquireHold(deadline);
          return (await holdP).ok;
        })(),
      );

    return {
      execute: (spec, deadline) => track(runSpec(spec, deadline)),
      hold,
      rechecker,
      runShell: (command, cwd, deadline) => track(runCommand(deadline, opts => exec(command, { ...opts, cwd }))),
      runLint: (spec, deadline) =>
        track(runCommand(deadline, opts => argv(spec.file, spec.args, { ...opts, cwd: spec.cwd, env: { ...spec.env } }))),
      close,
    };
  };
}

// -----------------------------------------------------------------------------------------------
// The direct testsPass hook (2.1.2.4): P2, P3, P4-P6/P5f, the T4 pre-decisions, P7, P9
// -----------------------------------------------------------------------------------------------

export interface DirectTestsPassHookDeps {
  openScope: OpenCheckScope;
  /** Built in wiring.ts (2.1.3, T9). */
  plannerFs: PlannerFs;
  search: TestSearchSeam;
  budget: Pick<VerifyBudget, "maxWorkers" | "failureRecheck">;
  host?: Partial<RunnerHost>;
  /** The gate's current tree snapshot, forwarded to materialize for drift detection (T4.d). */
  currentTree?: TreeSnapshot;
  /** Planner seam; default planScopedRun. */
  plan?: typeof planScopedRun;
  logger?: Pick<PluginLogger, "warn">;
}

/** P5f: the note on a full-suite result whose text parse was not confident. */
export const FULL_OUTPUT_INCOMPLETE_NOTE = "the full test output could not be parsed into a complete failure inventory";

/**
 * P5f: a RunResult from the full command's text output (observeTests). Failing files are the id
 * file parts resolved against cwd, kept only when they exist in the live tree: a key that is not a
 * real file must never reach the recheck, where a missing file would read as "added since dispatch".
 */
async function synthesizeFullResult(
  exec: ExecResult,
  cwd: string,
  fs: PlannerFs,
  host: Partial<RunnerHost> | undefined,
): Promise<RunResult> {
  const obs = observeTests(exec);
  const P = (host?.platform ?? process.platform) === "win32" ? pathWin32 : pathPosix;
  const failingIds = [...new Set(obs.failures)].sort();
  const files = new Set<string>();
  for (const id of failingIds) {
    const abs = P.resolve(cwd, fileKeyOfId(id));
    if (await fs.fileExists(abs)) files.add(abs);
  }
  return {
    failingIds,
    failingFiles: [...files].sort(),
    collectionError: exec.code !== 0 && failingIds.length === 0,
    total: undefined,
    complete: obs.complete,
    source: "text",
    ...(obs.complete ? {} : { note: FULL_OUTPUT_INCOMPLETE_NOTE }),
  };
}

/**
 * S5 as a direct call (2.1.2.4; 2.2 swaps in the batch coordinator): plan, run under ONE scope,
 * recheck the failing files at the dispatch reference, close the scope. Never rejects.
 */
export function createDirectTestsPassHook(deps: DirectTestsPassHookDeps): TestsPassHook {
  const plan = deps.plan ?? planScopedRun;

  // P5f: the resolved command as written, through the scope's shell seam (low priority, deadline-bound).
  const runFull = async (req: TestsPassRequest, scope: CheckScope): Promise<ScopedOutcome> => {
    const out = await scope.runShell(req.command, req.cwd, req.deadline);
    if (out.kind === "timed-out") return { kind: "timed-out", boundMs: out.boundMs };
    if (out.kind !== "ran") return out;
    const result = await synthesizeFullResult(out.exec, req.cwd, deps.plannerFs, deps.host);
    const notes = [...out.notes, ...(result.note !== undefined ? [result.note] : [])];
    return { kind: "ran", result, exitCode: out.exec.code, notes };
  };

  const recheckFor = async (req: TestsPassRequest, scope: CheckScope, scoped: ScopedOutcome): Promise<RecheckOutcome | undefined> => {
    // P7: only a run with >= 1 failing id and >= 1 failing file (T4).
    if (scoped.kind !== "ran" || scoped.result.failingIds.length === 0 || scoped.result.failingFiles.length === 0) return undefined;
    const ref = req.reference;
    if (ref.kind === "disabled" || !deps.budget.failureRecheck) return { kind: "disabled" };
    if (ref.kind === "none") return { kind: "unusable", cause: "no-reference", reason: ref.reason };
    return scope.rechecker(req.command, req.cwd, deps.currentTree)(ref.reference, scoped.result.failingFiles, req.deadline);
  };

  return async (req): Promise<TestsPassRun> => {
    let scope: CheckScope | undefined;
    let scoped: ScopedOutcome | undefined;
    try {
      if (req.testScope === "full") {
        scope = deps.openScope({ cwd: req.cwd, command: req.command });
        scoped = await runFull(req, scope);
      } else {
        // P2/P3: planning outcomes take no slot and spawn nothing.
        const planned = await plan({
          command: req.command,
          cwd: req.cwd,
          changedFiles: req.changedFiles,
          budget: { maxWorkers: deps.budget.maxWorkers },
          fs: deps.plannerFs,
          search: deps.search,
          ...(deps.host !== undefined ? { host: deps.host } : {}),
        });
        if (isNoAffected(planned)) return { scoped: { kind: "no-affected", note: planned.note }, recheck: undefined };
        if (isUnverifiable(planned)) {
          return { scoped: { kind: "unverifiable", code: planned.code, reason: planned.reason }, recheck: undefined };
        }
        scope = deps.openScope({ cwd: req.cwd, command: req.command });
        scoped = await scope.execute(planned, req.deadline);
      }
      return { scoped, recheck: await recheckFor(req, scope, scoped) };
    } catch (err) {
      const reason = errorText(err);
      if (scoped !== undefined) return { scoped, recheck: { kind: "unusable", cause: "error", reason: `the reference recheck errored: ${reason}` } };
      return { scoped: { kind: "error", reason: `testsPass hook errored: ${reason}` }, recheck: undefined };
    } finally {
      if (scope !== undefined) await closeWithinDeadline(scope, req.deadline, deps.logger);
    }
  };
}

/**
 * QA-2.1-13: how long before the gate deadline's end `closeWithinDeadline` stops waiting for a
 * close. The gate's `withTimeout` is armed with the same deadline's `remaining()`, so a wait that
 * ran to the exact end would race it, and a proven failure could become a gate timeout.
 */
export const CLOSE_MARGIN_MS = 100;

/**
 * P9 (QA-2.1-3): waits for `scope.close()` only until `CLOSE_MARGIN_MS` before `deadline` is spent
 * (or its abort), so a reference dispose (EBUSY retries) never outlasts the gate budget and turns
 * a verdict into a gate timeout (QA-2.1-13: the margin keeps the wait clear of the gate's own
 * `withTimeout`, armed at the same end). The close carries on in the background after that: it
 * still releases the slot only once every tracked disposal and killed tree has settled, and its
 * failure is logged. A spent deadline also bars every later scope of the gate from acquiring a
 * slot (acquireHold), so an unfinished close never nests with another hold. Never rejects.
 */
export function closeWithinDeadline(scope: CheckScope, deadline: Deadline, logger?: Pick<PluginLogger, "warn">): Promise<void> {
  const warn = (err: unknown): void => logger?.warn(`verification scope close failed: ${errorText(err)}`);
  let closing: Promise<void>;
  try {
    closing = scope.close().catch(warn);
  } catch (err) {
    warn(err);
    return Promise.resolve();
  }
  return new Promise<void>(settle => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      deadline.signal.removeEventListener("abort", done);
      settle();
    };
    void closing.then(done);
    const left = deadline.remaining() - CLOSE_MARGIN_MS;
    if (deadline.signal.aborted || left <= 0) {
      done();
      return;
    }
    deadline.signal.addEventListener("abort", done, { once: true });
    if (Number.isFinite(left)) {
      timer = setTimeout(done, Math.min(left, MAX_TIMER_MS));
      timer.unref?.();
    }
  });
}

// -----------------------------------------------------------------------------------------------
// Command checks under per-check scopes (2.1.2.5, T8)
// -----------------------------------------------------------------------------------------------

/** How one command check spawns under its scope. */
type Launch = (scope: CheckScope, deadline: Deadline) => Promise<CommandOutcome>;

/** T7 u14, shared by every command check. */
export const SLOT_DEADLINE_REASON = "gate budget exhausted waiting for the verification slot";

function withNotes(notes: readonly string[]): { note?: string } {
  return notes.length > 0 ? { note: notes.join("; ") } : {};
}

/** Runs `fn` under the gate's deadline, or under one of its own (disposed afterwards) when the deps carry none. */
async function withCheckDeadline<T>(deps: DeterministicDeps, timeoutMs: number, fn: (deadline: Deadline) => Promise<T>): Promise<T> {
  let owned: OwnedDeadline | undefined;
  const deadline: Deadline = deps.deadline ?? (owned = createDeadline(deps.budget?.gateBudgetMs ?? timeoutMs));
  try {
    return await fn(deadline);
  } finally {
    owned?.dispose();
  }
}

/** T8: slot busy, a gate-budget cut and executor errors are unverifiable; the check's own timeout fails, as today. */
function blockedResult(kind: string, command: string, out: Exclude<CommandOutcome, { kind: "ran" }>, deadline: Deadline): CheckResult {
  switch (out.kind) {
    case "slot-busy":
      return { ok: false, unverifiable: true, reason: out.deadlineCut ? SLOT_DEADLINE_REASON : `verification slot busy (waited ${out.waitedMs}ms)` };
    case "aborted":
      return { ok: false, unverifiable: true, reason: `${kind}: ${out.reason}: ${command}` };
    case "error":
      return { ok: false, unverifiable: true, reason: `${kind} check errored: ${scrubText(out.reason)}` };
    case "timed-out":
      // A bound the gate deadline cut short is budget exhaustion, not the command's own timeout.
      return deadline.remaining() === 0
        ? { ok: false, unverifiable: true, reason: `${kind}: gate budget exhausted during the run: ${command}` }
        : { ok: false, reason: `${kind} timed out after ${out.boundMs}ms: ${command}` };
  }
}

/**
 * The exec result of one non-testsPass command check. With `deps.openScope` (T8): its own scope,
 * one slot hold, low priority, deadline-bound, closed before this returns so scopes never nest
 * (runDeterministic is sequential). Without it: deps.exec, as before.
 */
async function obtainExec(
  kind: string,
  command: string,
  deps: DeterministicDeps,
  timeoutMs: number,
  launch: Launch,
): Promise<{ exec: ExecResult; notes: readonly string[] } | { result: CheckResult }> {
  const openScope = deps.openScope;
  if (!openScope) {
    const r: ExecResult = await deps.exec(command, { cwd: deps.cwd, timeoutMs });
    if (r.timedOut) return { result: { ok: false, reason: `${kind} timed out after ${timeoutMs}ms: ${command}` } };
    return { exec: r, notes: [] };
  }
  return withCheckDeadline(deps, timeoutMs, async deadline => {
    const scope = openScope({ cwd: deps.cwd, command });
    let out: CommandOutcome;
    try {
      out = await launch(scope, deadline);
    } finally {
      await scope.close();
    }
    return out.kind === "ran" ? { exec: out.exec, notes: out.notes } : { result: blockedResult(kind, command, out, deadline) };
  });
}

/** T8 lintClean scoping. A planner failure, or a relative cwd, runs the command unscoped (as today). */
async function planLint(command: string, deps: DeterministicDeps): Promise<LintSpec | NoAffected | Unscoped> {
  if (!deps.cwd || !isAbsolute(deps.cwd)) return { unscoped: true, reason: "no absolute working directory" };
  try {
    return await (deps.planLint ?? planScopedLint)({
      command,
      cwd: deps.cwd,
      changedFiles: deps.changedFiles ?? "unavailable",
      budget: { maxWorkers: deps.budget?.maxWorkers ?? 2 },
      fs: deps.fs,
    });
  } catch (err) {
    return { unscoped: true, reason: `lint planning failed: ${errorText(err)}` };
  }
}

/** G5: testsPass with no TestsPassHook in the deps is unverifiable, never a run. */
export const NO_TESTS_PASS_HOOK = "testsPass: not run: no scoped test pipeline is wired for this verification";

/** P8: a TestsPassJudgement as the check's CheckResult, carrying the attribution (2.4 lineage). */
function fromJudgement(j: TestsPassJudgement): CheckResult {
  return {
    ok: j.ok,
    ...(j.unverifiable ? { unverifiable: true } : {}),
    ...(j.reason !== undefined ? { reason: j.reason } : {}),
    ...(j.note !== undefined ? { note: j.note } : {}),
    ...(j.evidence !== undefined ? { evidence: j.evidence } : {}),
    ...(j.failures !== undefined ? { failures: j.failures } : {}),
  };
}

function defaultReference(deps: DeterministicDeps): ReferenceState {
  return deps.budget?.failureRecheck === false ? { kind: "disabled" } : { kind: "none", reason: REFERENCE_NONE.untracked };
}

/** P0-P8 for one testsPass check whose command already passed the allowlist (P1). Never rejects. */
async function runTestsPass(command: string, deps: DeterministicDeps, timeoutMs: number): Promise<CheckResult> {
  if (!deps.testsPass) return { ok: false, unverifiable: true, reason: `${NO_TESTS_PASS_HOOK}: ${command}` };
  if (!deps.cwd || !isAbsolute(deps.cwd)) {
    return { ok: false, unverifiable: true, reason: `testsPass cannot run without an absolute working directory: ${command}` };
  }
  const hook = deps.testsPass;
  const cwd = deps.cwd;
  try {
    return await withCheckDeadline(deps, timeoutMs, async deadline => {
      const run = await hook({
        command,
        cwd,
        testScope: deps.budget?.testScope ?? "affected",
        changedFiles: deps.changedFiles ?? "unavailable",
        reference: deps.reference ?? defaultReference(deps),
        deadline,
      });
      // QA-G-B-2-1: a carried acceptance never passes on a run that never happened.
      if (deps.noAffectedUnverifiable !== undefined && run.scoped.kind === "no-affected") {
        return { ok: false, unverifiable: true, reason: `${deps.noAffectedUnverifiable} (testsPass: ${run.scoped.note})` };
      }
      return fromJudgement(judgeScoped(run.scoped, run.recheck));
    });
  } catch (err) {
    return { ok: false, unverifiable: true, reason: `testsPass check errored: ${scrubText(String(err))}` };
  }
}

async function runCommandCheck(
  check: Check,
  kind: "testsPass" | "buildPasses" | "lintClean",
  deps: DeterministicDeps,
  allowlist: string[],
  timeoutMs: number,
): Promise<CheckResult> {
  let command = resolveRepoCommand(check, kind, deps.defaults);
  if (kind === "buildPasses" && !check.command && !deps.defaults?.buildCommand) {
    try {
      const packagePath = resolveAgainst(deps.cwd, "package.json");
      let hasBuild = false;
      if (await deps.fs.fileExists(packagePath)) {
        const pkg: unknown = JSON.parse(await deps.fs.readFile(packagePath));
        if (pkg && typeof pkg === "object" && "scripts" in pkg) {
          const scripts = pkg.scripts;
          hasBuild = !!(scripts && typeof scripts === "object" && "build" in scripts && typeof scripts.build === "string" && scripts.build.trim());
        }
      }
      if (hasBuild) command = "npm run build";
      else if (await deps.fs.fileExists(resolveAgainst(deps.cwd, "tsconfig.json"))) command = "npx tsc --noEmit";
      else return { ok: false, unverifiable: true, reason: "buildPasses: no build script or root tsconfig.json" };
    } catch (err) {
      return { ok: false, unverifiable: true, reason: `buildPasses probe failed: ${scrubText(String(err))}` };
    }
  }

  if (kind === "testsPass") {
    // P1: not allowlisted -> unverifiable, as today. P2-P8 run outside deps.mutex: that per-cwd
    // lock would serialize exactly the concurrent gates that 2.2 must batch.
    if (!isCommandAllowed(command, allowlist)) {
      return { ok: false, unverifiable: true, reason: `command not allowlisted: ${command}` };
    }
    return runTestsPass(command, deps, timeoutMs);
  }

  const fn = async (): Promise<CheckResult> => {
    try {
      if (!isCommandAllowed(command, allowlist)) {
        return { ok: false, unverifiable: true, reason: `command not allowlisted: ${command}` };
      }
      let launch: Launch = (scope, deadline) => scope.runShell(command, deps.cwd, deadline);
      let scopedTo: number | undefined;
      if (kind === "lintClean" && deps.openScope) {
        // T8: NoAffected passes with its note and takes no slot; Unscoped runs the command as today.
        const plan = await planLint(command, deps);
        if (isNoAffected(plan)) {
          // QA-G-B-2-1: a carried acceptance never passes on a lint that never ran.
          return deps.noAffectedUnverifiable !== undefined
            ? { ok: false, unverifiable: true, reason: `${deps.noAffectedUnverifiable} (lintClean: ${plan.note})` }
            : { ok: true, note: `lintClean: ${plan.note}` };
        }
        if (!isUnscoped(plan)) {
          launch = (scope, deadline) => scope.runLint(plan, deadline);
          scopedTo = plan.inputs.length;
        }
      }
      const got = await obtainExec(kind, command, deps, timeoutMs, launch);
      if ("result" in got) return got.result;
      const r = got.exec;
      const out = r.stdout + "\n" + r.stderr;
      const ok = r.code === 0;
      const scoped = scopedTo !== undefined ? ` (scoped to ${scopedTo} changed files)` : "";
      if (!ok) {
        return {
          ok: false,
          reason: `command exited ${r.code}: ${command}${scoped}`,
          evidence: out.slice(0, 2000),
          ...withNotes(got.notes),
        };
      }
      return { ok: true, evidence: `exit 0: ${command}${scoped}`, ...withNotes(got.notes) };
    } catch (err) {
      return { ok: false, reason: `${kind} check errored: ${scrubText(String(err))}` };
    }
  };

  if (deps.mutex) {
    return deps.mutex.runExclusive(deps.cwd, fn);
  }
  return fn();
}

async function runSchemaMatch(check: Check, deps: DeterministicDeps): Promise<CheckResult> {
  try {
    if (!check.path || !check.schema) {
      return { ok: false, reason: "schemaMatch requires 'path' and 'schema'" };
    }
    if (!deps.cwd && (!isAbsolute(check.path) || (!check.schema.trim().startsWith("{") && !isAbsolute(check.schema)))) {
      return { ok: false, unverifiable: true, reason: "schemaMatch path cannot be resolved without a declared working directory" };
    }

    const targetRaw = await deps.fs.readFile(resolveAgainst(deps.cwd, check.path));
    let targetVal: unknown;
    try {
      targetVal = JSON.parse(targetRaw);
    } catch {
      return { ok: false, reason: `target is not valid JSON: ${check.path}` };
    }

    let schemaVal: unknown;
    if (check.schema.trim().startsWith("{")) {
      try {
        schemaVal = JSON.parse(check.schema);
      } catch {
        return { ok: false, reason: "schema is not valid JSON" };
      }
    } else {
      const schemaRaw = await deps.fs.readFile(resolveAgainst(deps.cwd, check.schema));
      try {
        schemaVal = JSON.parse(schemaRaw);
      } catch {
        return { ok: false, reason: "schema is not valid JSON" };
      }
    }

    const mismatch = shapeMismatch(schemaVal, targetVal);
    if (mismatch !== null) {
      return { ok: false, reason: `schema mismatch at ${mismatch}`, evidence: mismatch };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `schemaMatch check errored: ${scrubText(String(err))}` };
  }
}

// ---------------------------------------------------------------------------
// runDeterministic
// ---------------------------------------------------------------------------

export async function runDeterministic(dod: DoD, deps: DeterministicDeps): Promise<Verdict> {
  const checks = dod.checks ?? [];

  if (checks.length === 0) {
    return {
      pass: false,
      method: "none",
      skipped: true,
      reasons: ["no deterministic checks to run"],
    };
  }

  const timeoutMs = deps.timeoutMs ?? 120000;
  const allowlist = deps.allowlist ?? DEFAULT_ALLOWLIST;
  const results: CheckResult[] = [];

  // Sequential for deterministic mutex semantics and stable evidence order.
  for (const check of checks) {
    let result: CheckResult;

    switch (check.kind) {
      case "fileExists":
        result = await runFileExists(check, deps);
        break;
      case "run":
        result = await runRun(check, deps, allowlist, timeoutMs);
        break;
      case "testsPass":
      case "buildPasses":
      case "lintClean":
        result = await runCommandCheck(check, check.kind, deps, allowlist, timeoutMs);
        break;
      case "schemaMatch":
        result = await runSchemaMatch(check, deps);
        break;
      default: {
        // Defensive: TypeScript proves this is unreachable; guards runtime extensions.
        const exhaustive: never = check.kind;
        result = { ok: false, reason: `unknown check kind: ${exhaustive}` };
        break;
      }
    }

    results.push(result);
    if (!result.ok && !result.unverifiable) {
      deps.onFailure?.(scrubText(result.reason ?? "check failed"));
    }
  }

  const allPass = results.every(r => r.ok);
  const failed = results.some(r => !r.ok && !r.unverifiable);
  const caveats = results.filter(r => r.unverifiable).map(r => scrubText(r.reason ?? "check unavailable"));
  const notes = results.flatMap(r => r.note ? [scrubText(r.note)] : []);

  const reasons: string[] = allPass
    ? [`all ${checks.length} deterministic checks passed`]
    : results
        .filter(r => !r.ok)
        .map(r => scrubText(r.reason ?? "check failed"));

  const evidenceParts = results.map(r => r.evidence ?? "").filter(e => e.length > 0);
  const rawEvidence = evidenceParts.length > 0 ? evidenceParts.join("\n---\n") : undefined;
  const evidence = rawEvidence !== undefined ? scrubText(rawEvidence) : undefined;
  const classified = results.flatMap(r => (r.failures ? [r.failures] : []));
  const failures: FailureClassification | undefined = classified.length
    ? {
        introduced: classified.flatMap(f => f.introduced),
        preexisting: classified.flatMap(f => f.preexisting),
        unknown: classified.flatMap(f => f.unknown),
      }
    : undefined;

  return {
    pass: allPass,
    outcome: failed ? "fail" : allPass ? "pass" : "unverifiable",
    ...(caveats.length ? { caveats } : {}),
    ...(notes.length ? { notes } : {}),
    method: "deterministic",
    reasons,
    ...(evidence !== undefined ? { evidence } : {}),
    ...(failures !== undefined ? { failures } : {}),
  };
}
