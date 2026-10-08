// src/verify/types.ts
// Pure types for the deterministic verifier. No runtime code.

// Type-only: runner.ts and reference.ts import their seam types from this module, and a type cycle
// has no runtime effect.
import type { ChangedPath, RunResult, S6Code, ScopedSpec } from "./runner";
import type { DispatchReference, InexactReason } from "./reference";

export type VerifyMethod = "deterministic" | "checker" | "none";

export interface Verdict {
  pass: boolean;
  /** Absent on legacy verdicts: derive from pass. Unverifiable is not failure. */
  outcome?: "pass" | "fail" | "unverifiable";
  /** Checks that could not be performed; never evidence of producer failure. */
  caveats?: string[];
  /** Successful comparisons that must not be mistaken for a green suite. */
  notes?: string[];
  method: VerifyMethod;
  reasons: string[];
  evidence?: string;
  /** true when nothing was actually verified (SKIPPED != PASS) */
  skipped?: boolean;
  /**
   * testsPass attribution (deterministic.ts header, T5): the ids every exact-recheck judgement of
   * this verdict classified, concatenated across testsPass checks. Absent when no check classified.
   */
  failures?: FailureClassification;
  /**
   * #84 P3.3 fix 2 (plan §2.6, I6): the LLM grader that judged this verdict (checker.ts runChecker, only once a grader
   * session answered): the tier the checker asked for and the model the grader was dispatched on (`provider/model`, null when
   * the router does not know it). Outcome signals weigh such a verdict as a grader's, never as a deterministic check's.
   */
  grader?: { readonly tier: string; readonly model: string | null };
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

/** Options shared by every verification process seam (shell string or argv). */
export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Aborting kills the whole process tree; an already-aborted signal never spawns. */
  signal?: AbortSignal;
  /** Run the process (and its descendants) at below-normal OS priority. */
  lowPriority?: boolean;
  /** Merged over process.env; never replaces it. */
  env?: Record<string, string>;
}

export interface ExecSeam {
  (command: string, opts?: ExecOptions): Promise<ExecResult>;
}

/** Spawn `file` with `args` and no shell: arguments reach the child byte-for-byte. */
export interface ArgvSeam {
  (file: string, args: readonly string[], opts?: ExecOptions): Promise<ExecResult>;
}

export interface FsSeam {
  fileExists(path: string): Promise<boolean>;
  readFile(path: string): Promise<string>;
}

export interface MutexRegistry {
  runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

export interface DeterministicDeps {
  /**
   * S5 (deterministic.ts header, T2 P2-P7): plans, runs and rechecks one testsPass request. Called
   * outside `mutex`. Absent -> testsPass is unverifiable, never a run (G5).
   */
  testsPass?: TestsPassHook;
  /** S3/S4 per-check scopes (T8): one slot hold per check, low priority, deadline-bound. */
  openScope?: import("./deterministic").OpenCheckScope;
  /** Shell-free process seam (git searches, scoped specs). */
  argv?: ArgvSeam;
  /**
   * The producer's changed files with tree-snapshot statuses and rename sources, or "unavailable"
   * without a change baseline (section 1.5-6). Default "unavailable".
   */
  changedFiles?: readonly ChangedPath[] | "unavailable";
  /**
   * The settled dispatch reference (T2 P0). Default: "disabled" when `budget.failureRecheck` is
   * off, else none ("the dispatch was not tracked").
   */
  reference?: ReferenceState;
  /** The validated budget (resolveVerifyBudget). Absent: testScope "affected", failureRecheck on. */
  budget?: import("../router/config").VerifyBudget;
  /** lintClean scoping (T8); default planScopedLint. Used only with `openScope`. */
  planLint?: typeof import("./runner").planScopedLint;
  /**
   * The gate's deadline (T3). Absent: each testsPass check runs under its own deadline of
   * `budget.gateBudgetMs` (else `timeoutMs`), disposed when the check ends.
   */
  deadline?: Deadline;
  /** Preserve completed failures if an outer gate budget expires later. */
  onFailure?: (reason: string) => void;
  exec: ExecSeam;
  /** Any FsSeam; lintClean scoping also uses the optional PlannerFs members when present. */
  fs: import("./runner").PlannerFs;
  cwd: string;
  mutex?: MutexRegistry;
  /** per-check timeout in ms; default 120000 */
  timeoutMs?: number;
  /** permitted command first-token basenames; default DEFAULT_ALLOWLIST */
  allowlist?: string[];
  defaults?: {
    testCommand?: string;
    buildCommand?: string;
    lintCommand?: string;
  };
}

// ---------------------------------------------------------------------------------------------
// testsPass pipeline contract (plan Phase 2.1, task 2.1.1)
//
// The pipeline, the verdict algebra and its truth table are specified in the header of the
// "testsPass pipeline" section of src/verify/deterministic.ts. Phase 2.2 (batch.ts) and Phase 2.4
// (pending.ts) code against these types only, never against 2.1's internals.
// ---------------------------------------------------------------------------------------------

/**
 * One deadline per synchronous verification (plan section 1.5-13): a `VERIFY:required` gate in
 * either call path (`delegate` tool, native `task`), or one `router_verify` call. The owner creates
 * it with `gateBudgetMs` next to the AbortController it aborts when its `withTimeout` rejects. Every
 * wait and command inside the verification (slot wait, test search, scoped run, GC, materialize,
 * recheck run, batch wait) is bounded by `bound(itsOwnBudget)` and receives `signal`.
 */
export interface Deadline {
  /** The budget the deadline was created with (gateBudgetMs). For messages only. */
  readonly budgetMs: number;
  /** Milliseconds left, clamped to >= 0. 0 once the deadline passed or `signal` aborted. */
  remaining(): number;
  /** min(ownBudgetMs, remaining()): the bound of one step. `ownBudgetMs` may be Infinity. */
  bound(ownBudgetMs: number): number;
  /**
   * Aborts when the deadline passes or the owner aborts the verification. Every slot wait, spawn,
   * materialize and GC receives it, so an abort kills the running process tree and nothing is
   * spawned afterwards (an already-aborted signal never spawns: ExecOptions.signal).
   */
  readonly signal: AbortSignal;
}

/**
 * The dispatch reference as the gate sees it (S2, plan sections 1.5-7 and 1.5-14). Produced by
 * `prepareVerification` (2.1.3) and stored by the pending registry (2.4.1) as a promise.
 */
export type ReferenceState =
  /** A git-only capture that resolved with no overlapping edit observed while it was in flight. */
  | { readonly kind: "captured"; readonly reference: DispatchReference }
  /** `failureRecheck: false` (or the deprecated `testBaseline: false`): nothing was captured. */
  | { readonly kind: "disabled" }
  /**
   * No usable capture: not a git repository, capture failed or exceeded `baselineTimeoutMs`, an
   * edit was observed in an overlapping directory before it resolved, or the dispatch was not
   * tracked. `reason` is a short stable phrase for the verdict text.
   */
  | { readonly kind: "none"; readonly reason: string };

/**
 * What the scoped test run of ONE request produced (S1, S3, S4, S6), as judgeScoped consumes it.
 * `no-affected` and `unverifiable` come from planning (planScopedRun, detectRunner); every other
 * kind comes from a ScopedExecutor. A batch (2.2) returns one per request.
 */
export type ScopedOutcome =
  /** planScopedRun returned NoAffected (section 1.5-6, runner.ts M.2): nothing spawned, pass with the note. */
  | { readonly kind: "no-affected"; readonly note: string }
  /** S6: scoping is impossible. Nothing spawned; the router never falls back to a full suite. */
  | { readonly kind: "unverifiable"; readonly code: S6Code; readonly reason: string }
  /**
   * The slot (S3) was not obtained within min(slotWaitMs, remaining). Nothing spawned.
   * `deadlineCut`: the wait ended because the deadline passed or aborted, not at slotWaitMs.
   */
  | { readonly kind: "slot-busy"; readonly waitedMs: number; readonly deadlineCut: boolean }
  /**
   * The command exited on its own before its bound; `result` is readResult's parse (or, for
   * testScope "full", the observeTests-derived result; source "text").
   */
  | {
      readonly kind: "ran";
      readonly result: RunResult;
      readonly exitCode: number;
      /** The spec that ran; undefined for testScope "full" (a resolved shell command, not a spec). */
      readonly spec?: ScopedSpec;
      /** Planner notes, slot notes (e.g. "slot reclaimed during the run") and readResult's note. */
      readonly notes: readonly string[];
    }
  /**
   * The command hit its own bound min(timeoutMs, remaining) and its process tree was killed.
   * `result` is readResult's parse of what was written (always called: it deletes the report).
   */
  | { readonly kind: "timed-out"; readonly boundMs: number; readonly result?: RunResult }
  /**
   * The deadline passed or the owner aborted: the tree was killed, or nothing was spawned.
   * `reason` is a stable phrase such as "gate budget exhausted during the scoped run".
   */
  | { readonly kind: "aborted"; readonly reason: string }
  /** The executor itself failed (spawn threw, slot I/O error). Fail-closed: never a pass. */
  | { readonly kind: "error"; readonly reason: string };

/** Why a recheck at the dispatch reference cannot be compared (never "pre-existing"). */
export type RecheckUnusableCause =
  /** ReferenceState "none": "no reference: pre-existing failures cannot be told apart" (1.5-14). */
  | "no-reference"
  /** materialize returned ok:false (aborted, worktree-add-failed, unsafe-path, error). */
  | "materialize-failed"
  /** The stash commit is gone (commit-missing) or the worktree vanished during the rerun (QA-1.5-4). */
  | "reference-vanished"
  /** unreproduced holds an ignored input outside the inert allowlist, e.g. .env (QA-1.5-7). */
  | "unreproduced-inputs"
  /** planRerun or detectRunner returned S6 (node-not-found, tmpdir-in-repo, argv-too-long, ...). */
  | "rerun-unplannable"
  /** The rerun reported complete === false (QA-1.3-17). */
  | "incomplete"
  /** The rerun reported collectionError === true: setup/collection failure at the reference (1.5-8). */
  | "collection-error"
  /** The rerun ran no tests: total === 0 (QA-1.3-17). */
  | "no-tests"
  /** The runner cannot pin sources to the reference (pytest: editable installs import the live tree). */
  | "runner-unsupported"
  /** The rerun's executor failed (spawn threw, I/O error). */
  | "error";

/**
 * The S2 failure-only recheck at the dispatch reference, as judgeScoped consumes it. It carries
 * reference-side FACTS only; judgeScoped classifies each failing id (FailureClassification), so one
 * recheck can be shared by several requests of a batch (2.2) with the same reference.
 *
 * File keys below are id-space keys: the file part of a RunResult id (cwd-relative, "/"
 * separators; the part before " > " or "::", or the whole bare-file id). The rerun spec's cwd is
 * the live spec's cwd mapped into the reference worktree, so both runs share one key space.
 */
export type RecheckOutcome =
  /** An exact reference with inert `unreproduced`, rerun comparably where anything was rerun. */
  | {
      readonly kind: "exact";
      /**
       * The rerun at the reference: complete, no collection error, total > 0 (otherwise the
       * outcome is "unusable"). undefined when every failing file is in `absentFiles`.
       */
      readonly result: RunResult | undefined;
      /** File keys of the failing files that ran at the reference. */
      readonly ranFiles: readonly string[];
      /** File keys of failing files that do not exist at the exact reference: added since dispatch. */
      readonly absentFiles: readonly string[];
      readonly notes: readonly string[];
    }
  /** The reference cannot be rebuilt exactly (1.5-7, reference.ts section 2). Never excuses, never proves. */
  | { readonly kind: "approximate"; readonly inexactReasons: readonly InexactReason[] }
  /** The reference exists or was expected, but its run cannot be compared. Never excuses, never proves. */
  | { readonly kind: "unusable"; readonly cause: RecheckUnusableCause; readonly reason: string }
  /** `failureRecheck: false`: no reference, no recheck; any scoped failure is unverifiable (section 1.4). */
  | { readonly kind: "disabled" }
  /** The rerun hit min(recheckTimeoutMs, remaining) and its tree was killed. */
  | { readonly kind: "timed-out"; readonly boundMs: number }
  /** Less than the recheck threshold remained: nothing materialized or spawned (section 1.5-13). */
  | { readonly kind: "skipped-deadline"; readonly remainingMs: number };

/** judgeScoped's per-id attribution of the scoped failures (ids as in RunResult.failingIds). */
export interface FailureClassification {
  /** Proven introduced: failing now, and passing, collecting or absent at the exact reference. */
  readonly introduced: readonly string[];
  /** Proven pre-existing: the same id fails at the exact reference. */
  readonly preexisting: readonly string[];
  /** Neither could be proven (file not rerun, text ids that cannot be compared). */
  readonly unknown: readonly string[];
}

/**
 * The result of one testsPass check. Structurally a deterministic.ts CheckResult:
 * ok -> pass; !ok && unverifiable -> caveat (rejected only under strictUnverifiable, by gate.ts);
 * !ok && !unverifiable -> fail (onFailure, escalation).
 */
export interface TestsPassJudgement {
  readonly ok: boolean;
  readonly unverifiable: boolean;
  /** Set when !ok: the rejection reason, or the caveat text of an unverifiable result. */
  readonly reason?: string;
  /** Set on a pass that must not read as a green suite, or with informative context. */
  readonly note?: string;
  readonly evidence?: string;
  /** Set whenever an exact recheck was used to classify failures. */
  readonly failures?: FailureClassification;
}

/**
 * S3 + S4 + run + readResult for one spec: waits for the slot (bounded by
 * deadline.bound(slotWaitMs)), spawns spec.file/spec.args through the ArgvSeam (never a shell) at
 * low priority with deadline.signal and timeoutMs = deadline.bound(check timeout), and ALWAYS calls
 * readResult (even after a timeout, an abort or a failed spawn). Never rejects.
 */
export type ScopedExecutor = (spec: ScopedSpec, deadline: Deadline) => Promise<ScopedOutcome>;

/**
 * S2 for the failing files of one scoped run (absolute live paths, RunResult.failingFiles):
 * skip below the deadline threshold, GC stale references, materialize INSIDE the slot hold, check
 * exactness and `unreproduced`, rerun only the failing files that exist at the reference
 * (planRerun, same entry as the live tree), readResult, dispose. Never rejects.
 */
export type Rechecker = (
  reference: DispatchReference,
  failingFiles: readonly string[],
  deadline: Deadline,
) => Promise<RecheckOutcome>;

/**
 * One S3 slot hold for one gate check or one batch (QA-1.4-18: acquire once, hold it across the
 * recheck, never acquire a nested slot in the same process). The hold is taken by the first
 * `execute` that needs to spawn; if that attempt is busy, every later call reports the same
 * outcome without waiting again. References are materialized and disposed inside the hold.
 */
export interface VerificationScope {
  readonly execute: ScopedExecutor;
  /** A Rechecker for one check command and live cwd (it needs detectRunner(command, cwd)), sharing this hold. */
  rechecker(command: string, cwd: string): Rechecker;
  /** Waits for pending reference disposals, then releases the hold. Idempotent; never rejects. */
  close(): Promise<void>;
}

/** Opens a VerificationScope. `meta` is written into the slot's lock file (slot.ts SlotMeta). */
export type OpenVerificationScope = (meta: { readonly cwd: string; readonly command: string }) => VerificationScope;

/** One testsPass verification request: everything the S5 hook needs to plan, run and recheck it. */
export interface TestsPassRequest {
  /** resolveRepoCommand's result; it already passed isCommandAllowed. */
  readonly command: string;
  /** Absolute check cwd. */
  readonly cwd: string;
  /** "full" runs the resolved command as written (runShell), still under S2-S5 (section 1.4). */
  readonly testScope: "affected" | "full";
  /** The producer's changed files with tree-snapshot statuses and rename sources; "unavailable" without attribution. */
  readonly changedFiles: readonly ChangedPath[] | "unavailable";
  readonly reference: ReferenceState;
  readonly deadline: Deadline;
}

/** What the S5 hook returns for one request; judgeScoped turns it into the check result. */
export interface TestsPassRun {
  readonly scoped: ScopedOutcome;
  /** undefined when no recheck was attempted (green, planning outcomes, slot busy, timeout, abort, error). */
  readonly recheck: RecheckOutcome | undefined;
}

/**
 * The S5 seam. 2.1.2 implements it as a direct call (plan, scope, execute, recheck); 2.2.3 swaps in
 * the batch coordinator behind this exact type. Never rejects.
 */
export type TestsPassHook = (request: TestsPassRequest) => Promise<TestsPassRun>;

/**
 * The verdict algebra (deterministic.ts, "testsPass pipeline" header, truth table). Pure and total:
 * every (scoped, recheck) pair maps to exactly one judgement, and no path yields ok for a failure
 * that is not proven pre-existing at an exact reference with a complete scoped inventory.
 */
export type JudgeScoped = (scoped: ScopedOutcome, recheck: RecheckOutcome | undefined) => TestsPassJudgement;
