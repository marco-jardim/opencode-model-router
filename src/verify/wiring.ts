/**
 * The impure corner of Layer 2.
 *
 * Together with tree.ts this owns verification I/O. The gate, the DoD schema, the
 * deterministic checks and the grader protocol all take their side effects as
 * injected deps. This module is where those deps are actually built out of a
 * child_process, a filesystem and an opencode client, so the impurity lives in
 * one named place instead of spread through the plugin factory.
 *
 * Config is read through a getter rather than captured. `cfg` in index.ts is a
 * `let` that is reassigned whenever a command reloads it, so a snapshot taken
 * at construction would leave the grader pinned to the models and enforcement
 * settings that were active when the plugin loaded, and `/preset` would
 * silently stop applying to graded work.
 */
import { createHash } from "node:crypto";
import { access, readdir, readFile as fsReadFile, realpath, stat, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createBatchCoordinator, type BatchCoordinatorOptions, type BatchPlanner } from "./batch";
import {
  createDeadline,
  createDirectTestsPassHook,
  createMutexRegistry,
  createScopeOpener,
  DEFAULT_ALLOWLIST,
  isCommandAllowed,
  RECHECK_MIN_REMAINING_MS,
  resolveRepoCommand,
  type OwnedDeadline,
} from "./deterministic";
import { parseVerifyDirectives, type VerifyDirectives } from "./directives";
import {
  ABANDONED_REASON,
  ABSENT_DIGEST as PENDING_ABSENT_DIGEST,
  buildDeferredFooter,
  DISPOSED_REASON,
  buildLineageCaveat,
  createBackgroundQueue,
  createPendingRegistry,
  driftedPaths,
  EXPIRED_HANDLE_TEXT,
  MAX_HANDLES_PER_CALL,
  MAX_STORED_CHANGED_FILES,
  neutralizeDirectives,
  normalizeHandle,
  sanitizeDescription,
  unattributedRisk,
  UNKNOWN_HANDLE_TEXT,
  VERIFYING_ELSEWHERE_TEXT,
  VERIFYING_GRACE_MS,
  type BackgroundOutcome,
  type BackgroundQueue,
  type BackgroundQueueOptions,
  type FileDigests,
  type PendingEntry,
  type PendingRegistry,
  type PendingRegistryOptions,
  type SettledVerification,
  type VerificationResult,
} from "./pending";
import { assessRisk, type RiskAssessment } from "./risk";
import { resolveBaseDir } from "./paths";
import { DEFAULT_IDLE_TTL_MS } from "../router/idle-sweep";
import {
  buildAcceptedSuffix,
  buildForcingNote,
  tierModel,
  toolLabel,
  type ChangedFile,
  type createChangedFileStore,
  type DispatchCaptureDeps,
  type TreeSnapshot,
} from "./dispatch";
import { runArgv, runShell } from "./exec";
import { snapshotTree } from "./tree";
import { captureReference, DEFAULT_CAPTURE_TIMEOUT_MS, gcStaleReferences, nodeReferenceFs, type DispatchReference } from "./reference";
import type { PluginLogger } from "../router/logger";
import { REFERENCE_NONE } from "./baseline";
import { scrubText } from "../guard/scrub";
import type { DoD } from "./dod";
import type { ArgvSeam, Deadline, ExecOptions, ExecResult as SeamResult, ExecSeam, ReferenceState, TestsPassHook, Verdict } from "./types";
import { planScopedRun, planStaticScoping, type ChangedPath, type RunnerFs, type StaticScoping, type TestSearchSeam } from "./runner";
import {
  DEFAULT_GATE_BUDGET_MS,
  graderTimeoutMs,
  RouterTimeoutError,
  withTimeout,
} from "./timeout";
import { resolveVerifyBudget, type RouterConfig, type VerifyBudget } from "../router/config";
import { accept, gateResult, unverifiableGateResult, type GateDeps, type GateResult } from "./gate";
// The grader request shape is owned by checker.ts, which builds it. Re-exported
// here because this module is where it is consumed, and because keeping a
// second local copy is exactly how `cwd` got dropped: the checker set it, the
// wiring's narrower structural type silently discarded it, and the grader ran
// against the router's directory while claiming to check the producer's.
import type { GraderRequest } from "./checker";
export type { GraderRequest };

/**
 * Upper bound on the disposal memo. Far above the number of child sessions any
 * one delegation can have in flight, and small enough that the memo can never
 * become a meaningful retention for a long-lived plugin instance.
 */
export const DISPOSED_MEMO_MAX = 512;

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Join the text parts of an opencode prompt response. Tolerant of a missing or
 * malformed body by design: every call site is fail-closed, and an empty string
 * reads downstream as "the grader said nothing", which is not a pass.
 */
export function extractAssistantText(res: any): string {
  const parts: any[] = res?.data?.parts ?? [];
  return parts
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}

function isValidHttpStatus(status: unknown): status is number {
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599;
}

function graderPromptResponseError(res: unknown): Error | undefined {
  if (typeof res !== "object" || res === null) return undefined;
  const envelope = res as {
    error?: unknown;
    data?: { info?: { error?: unknown } };
    response?: { status?: unknown };
  };
  const error = envelope.data?.info?.error ?? envelope.error;
  const responseStatus = envelope.response?.status;
  const validStatus = isValidHttpStatus(responseStatus);
  const malformedStatus = responseStatus !== undefined && !validStatus;
  const httpStatus = validStatus && responseStatus >= 400
    ? responseStatus : undefined;
  if (error == null && httpStatus === undefined && !malformedStatus) return undefined;
  const detail = typeof error === "object" && error !== null ? error as {
    data?: { statusCode?: unknown };
  } : undefined;
  const nestedStatus = detail?.data?.statusCode;
  const status = httpStatus ?? (isValidHttpStatus(nestedStatus) ? nestedStatus : undefined);
  return new Error(`grader prompt failed${status === undefined ? "" : ` (${status})`}: SDK error`);
}

/** P0 (deterministic.ts header, T2): what a gate needs from its dispatch. */
export interface PreparedVerification {
  /**
   * The producer's changed files: the tool-observed paths of every attempt judged against this
   * dispatch (QA-2.1-1), the paths the current snapshot added since dispatch, and the paths dirty
   * or untracked at dispatch whose content digest changed or which left the listing (QA-2.1-2);
   * each with the snapshot's status letters and rename source when the snapshot lists it.
   */
  changedFiles: ChangedFile[];
  changeBaseline: "available" | "unavailable";
  /** Settled: the dispatch reference, or why there is none. */
  reference: ReferenceState;
  /** The current tree snapshot (materialize's drift check); undefined when unavailable. */
  snapshot: TreeSnapshot | undefined;
  /**
   * QA-3.1-2: other dispatches in the same git tree that were live during this dispatch's window
   * (the change set holds their edits too). Absent or 0: none.
   */
  concurrentDispatches?: number;
  /** QA-3.1-3: the tool whose call discarded the dispatch snapshot, which left the change set unavailable. */
  contaminatedBy?: string;
}

/**
 * QA-3.1-2: appended to a rejection that lists introduced failures when other delegations were live in
 * the same working tree during the dispatch: the tree delta is not partitioned between them.
 */
export function concurrentDispatchesCaveat(count: number): string {
  return `other delegations ran in this working tree concurrently (${count}); introduced failures may come from their edits`;
}

/** QA-3.1-3: an unverifiable verdict whose change baseline a tool call discarded names that tool. */
export function contaminatedBaselineCaveat(tool: string): string {
  return `the dispatch-time change baseline was discarded: tool "${toolLabel(tool)}" ran in an overlapping directory before it resolved`;
}

/**
 * QA-3.1-2 / QA-3.1-3: router caveats from the dispatch's own context, on a gate result. A fail that
 * lists introduced failures gains concurrentDispatchesCaveat when other dispatches overlapped it; an
 * unverifiable verdict gains contaminatedBaselineCaveat (reasons and caveats) when a tool call
 * discarded its change baseline. The outcome and `accepted` never change. Pure; the text goes through
 * neutralizeDirectives like all router text.
 */
export function applyDispatchCaveats(
  res: GateResult,
  ctx: { readonly concurrentDispatches?: number; readonly contaminatedBy?: string },
): GateResult {
  const verdict = res.verdict;
  if (verdict.skipped === true) return res;
  const outcome = verdict.outcome ?? (verdict.pass ? "pass" : "fail");
  const concurrent = ctx.concurrentDispatches ?? 0;
  if (outcome === "fail" && concurrent > 0 && (verdict.failures?.introduced.length ?? 0) > 0) {
    return { ...res, verdict: { ...verdict, reasons: [...verdict.reasons, neutralizeDirectives(concurrentDispatchesCaveat(concurrent))] } };
  }
  if (outcome === "unverifiable" && ctx.contaminatedBy !== undefined) {
    const caveat = neutralizeDirectives(contaminatedBaselineCaveat(ctx.contaminatedBy));
    return { ...res, verdict: { ...verdict, reasons: [...verdict.reasons, caveat], caveats: [...(verdict.caveats ?? []), caveat] } };
  }
  return res;
}

/**
 * QA-3.1-3: single flight for the dispatch-time snapshot and capture. Each dispatch spawns 7 git
 * processes for its snapshot and 8 for its capture; 20 parallel dispatches spawned 300, and on
 * Windows each then took 130-560 ms instead of ~60 ms (p50 2.9 s per dispatch).
 *
 * Requests with one key share one run, but a run is only ever shared by requests made BEFORE it
 * started: a request that arrives while a run is in flight waits for the next run, which starts when
 * the current one settled and serves every request that arrived meanwhile. A shared result is so
 * always taken after each sharer's request began, as its own run would have been. A request's signal
 * ends only its own wait (undefined); a started run is aborted once every sharer has left, and a
 * queued run nobody waits for any more never starts. The returned function never rejects.
 *
 * QA-3.1-24: a started run whose last sharer left is also detached from its lane, so a run that
 * ignores its abort (snapshotTree's lstat/readlink/realpath take no signal) cannot hold every later
 * request with its key. Known limit: a request that arrives just after a run started waits for that
 * run and then its own, while its timeout counts from its own request; when one snapshot or capture
 * takes longer than half of the caller's timeout (baselineTimeoutMs, default 15 s), such an early
 * arrival can time out before its own run ends. That fails closed: no change baseline, reference
 * none, verdict unverifiable.
 */
export function createSharedFlight<T>(): (
  key: string,
  run: (signal: AbortSignal) => Promise<T | undefined>,
  signal: AbortSignal,
) => Promise<T | undefined> {
  interface Flight {
    readonly controller: AbortController;
    readonly result: Promise<T | undefined>;
    readonly start: () => void;
    sharers: number;
    started: boolean;
  }
  interface Lane {
    running?: Flight;
    next?: Flight;
  }
  const lanes = new Map<string, Lane>();
  const makeFlight = (run: (signal: AbortSignal) => Promise<T | undefined>): Flight => {
    const controller = new AbortController();
    let settle = (_value: T | undefined): void => undefined;
    const result = new Promise<T | undefined>(ok => {
      settle = ok;
    });
    const flight: Flight = {
      controller,
      result,
      // Synchronous: the run's own start-up (the first git spawn) happens inside the call that
      // starts it, so a VERIFY_WAIT counted from the dispatch's start covers it (ab81633).
      start: () => {
        flight.started = true;
        let running: Promise<T | undefined>;
        try {
          running = run(controller.signal);
        } catch {
          running = Promise.resolve(undefined);
        }
        running.then(settle, () => settle(undefined));
      },
      sharers: 0,
      started: false,
    };
    return flight;
  };
  // The lane's running flight is done with (settled, or detached by its last sharer): start the
  // queued one, or retire an idle lane.
  const advance = (key: string, lane: Lane): void => {
    lane.running = undefined;
    const next = lane.next;
    lane.next = undefined;
    if (next !== undefined) launch(key, lane, next);
    else if (lanes.get(key) === lane) lanes.delete(key);
  };
  const launch = (key: string, lane: Lane, flight: Flight): void => {
    lane.running = flight;
    flight.start();
    void flight.result.then(() => {
      // QA-3.1-24: a flight its last sharer detached no longer owns the lane.
      if (lane.running === flight) advance(key, lane);
    });
  };
  return (key, run, signal) => {
    if (signal.aborted) return Promise.resolve(undefined);
    let lane = lanes.get(key);
    if (lane === undefined) {
      lane = {};
      lanes.set(key, lane);
    }
    let flight: Flight;
    if (lane.next !== undefined) flight = lane.next;
    else if (lane.running !== undefined) flight = lane.next = makeFlight(run);
    else {
      flight = makeFlight(run);
      launch(key, lane, flight);
    }
    flight.sharers += 1;
    const owner = lane;
    return new Promise<T | undefined>(settle => {
      const onAbort = (): void => {
        flight.sharers -= 1;
        if (flight.sharers === 0) {
          // Nobody waits for it any more: stop a started run; never start a queued one.
          if (flight.started) {
            flight.controller.abort();
            // QA-3.1-24: a run that ignores its abort must not hold the lane until it settles.
            // Detach it, so the queued run (whose sharers all asked after it started) goes now.
            if (owner.running === flight) advance(key, owner);
          } else if (owner.next === flight) owner.next = undefined;
        }
        settle(undefined);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void flight.result.then(value => {
        signal.removeEventListener("abort", onAbort);
        settle(value);
      });
    });
  };
}

/**
 * QA-2.1-11: the start-up reference GC runs this long after plugin start, so the start itself never
 * holds the project directory with a git child process.
 */
export const REFERENCE_GC_START_DELAY_MS = 45_000;
/** How long the gate-time tree snapshot may take (bounded further by a gate deadline). */
export const GRADE_SNAPSHOT_TIMEOUT_MS = 10_000;
/** T3: each git test search, bounded further by a gate deadline. */
export const TEST_SEARCH_TIMEOUT_MS = 10_000;
/** QA-2.1-12: the `git diff <dispatch head> HEAD` of a gate whose HEAD moved, bounded further by a gate deadline. */
export const COMMIT_DIFF_TIMEOUT_MS = 10_000;
/**
 * QA-2.2-21: the effective batch window is at most gateBudgetMs / this. config.ts accepts any
 * batchWindowMs up to the timer limit, and a window close to the gate budget would spend most of
 * it waiting (batch.ts W3 still keeps each member's recheck reserve).
 */
export const BATCH_WINDOW_BUDGET_DIVISOR = 10;

/** QA-2.2-21: batchWindowMs, capped at a tenth of the gate budget; <= 0 disables batching. */
export function effectiveBatchWindowMs(budget: Pick<VerifyBudget, "batchWindowMs" | "gateBudgetMs">): number {
  return Math.min(budget.batchWindowMs, Math.floor(budget.gateBudgetMs / BATCH_WINDOW_BUDGET_DIVISOR));
}

// -----------------------------------------------------------------------------------------------
// 2.4.2 deferred verification (plan Phase 2.4, sections 1.5-14..17; pending.ts R3, R10, R11)
// -----------------------------------------------------------------------------------------------

/**
 * phase-2.4.md gather item 11: the bound on a deferred finish (tree snapshot, commit diff, static
 * scoping). On expiry the change set is "unavailable" and the risk is unattributedRisk(), never [].
 */
export const DEFERRED_FINISH_MS = 2_000;
/** Upper bound on remembered native `task` dispatch starts (before hook -> after hook). */
export const DISPATCH_STARTS_MAX = 1_024;
/** Drift digests read at most this many bytes in total (tree.ts MAX_DIGEST_BYTES); beyond it: no digests. */
export const DRIFT_DIGEST_MAX_BYTES = 64 * 1024 * 1024;
/** Static scoping could not finish inside DEFERRED_FINISH_MS: counted as impossible (conservative). */
export const STATIC_SCOPING_UNFINISHED_REASON = "static scoping did not finish within the deferred-finish bound";
/** Section 1.4 pendingTtlMs default, used when the config cannot be read at plugin start. */
export const DEFAULT_PENDING_TTL_MS = 3_600_000;
/**
 * QA-2.4-9: the capture wait when the config cannot be read: section 1.4's captureWaitMs default
 * (5000 ms), clamped to the default baselineTimeoutMs (DEFAULT_CAPTURE_TIMEOUT_MS), as config.ts does.
 */
export const FALLBACK_CAPTURE_WAIT_MS = Math.min(5_000, DEFAULT_CAPTURE_TIMEOUT_MS);

/** What the orchestrator asked for at dispatch (directives.ts, parsed from its own prompt only). */
export interface DispatchStart {
  readonly directives: VerifyDirectives;
  /** Clock value when the dispatch started (pending.ts R3 dispatchedAt, R11 lineage). */
  readonly dispatchedAt: number;
}

/** What a deferred producer's return hands to finishDeferred (pending.ts R3). */
export interface DeferredFinishInput {
  readonly dispatchID: string;
  /** The session that called `task` / `delegate`; never the producer. */
  readonly orchestratorSessionID: string;
  readonly producerSessionID: string;
  /** As received; canonicalised here (canonicalTier, 1.6 handoff item 8). */
  readonly producerTier: string;
  readonly description: string;
  readonly cwd: string | undefined;
  readonly dod: DoD;
  readonly dispatchedAt: number;
}

/**
 * What finishDeferred decided. `deferred: false` means the delegation is NOT deferred and the
 * caller runs today's required gate on it (QA-2.4-4, QA-2.4-10): the dispatch record is left in the
 * store for that gate. Deferred or background verification is never weaker than that gate.
 */
export type DeferredFinish =
  | {
      readonly deferred: true;
      /** The section 1.5-16 footer, naming the handle. */
      readonly footer: string;
      readonly handle: string;
      readonly risk: RiskAssessment;
    }
  | {
      readonly deferred: false;
      /**
       * "unregistered": the registry refused the entry (registry-full, handle-collision,
       * invalid-input); "no-change": an attributed empty change set of a testsPass-only DoD, which
       * the required gate passes with no process (section 1.5-6; QA-G-1: any other DoD is deferred
       * with the empty set instead, noChangeGateSpawnsNothing); "error": the finish itself failed.
       */
      readonly reason: "unregistered" | "no-change" | "error";
      readonly detail: string;
    };

/** What R11 lineage needs from a required gate's dispatch. */
export interface LineageContext {
  readonly orchestratorSessionID: string;
  /** Git top-level of the gate-time snapshot (TreeSnapshot.root); undefined -> no lineage either way. */
  readonly root: string | undefined;
  readonly dispatchID: string;
  readonly dispatchedAt: number;
  /** When the producer returned: the landedAt of a rejection recorded now. */
  readonly returnedAt: number;
  readonly strictUnverifiable: boolean | undefined;
}

/** 1.6 handoff item 8: the canonical tier id is lowercase and trimmed. */
export function canonicalTier(tier: string): string {
  return tier.trim().toLowerCase();
}

/**
 * The text directives are parsed from: the orchestrator-authored `prompt` argument, or its
 * `description` when the prompt is blank (the prompt-repair hook copies it in that case). Never a
 * tool result or a subagent's text (directives.ts SECURITY).
 */
export function dispatchDirectiveText(prompt: string | undefined, description: string | undefined): string {
  return prompt !== undefined && prompt.trim() !== "" ? prompt : (description ?? "");
}

/** A DoD whose deferral section 1.5-14/16 governs: it carries a testsPass check. */
export function hasTestsPass(dod: DoD): boolean {
  return dod.checks.some(c => c.kind === "testsPass");
}

/**
 * QA-G-1: whether the required gate passes an attributed empty change set of this DoD with no
 * process and no grader: every check is testsPass (its "no changed files" pass, section 1.5-6) and
 * there is no criterion. Only such a delegation takes finishDeferred's "no-change" answer
 * (QA-2.4-10); any other deferred DoD is registered with the empty change set instead, so its
 * build, lint, run, file and criteria checks run on router_verify, never synchronously.
 */
export function noChangeGateSpawnsNothing(dod: DoD): boolean {
  return dod.checks.length > 0 && dod.checks.every(c => c.kind === "testsPass") && dod.criteria.length === 0;
}

/**
 * pending.ts R3 `digests`: sha256 hex of each path's bytes, ABSENT_DIGEST for a missing path.
 * fs reads only. Undefined (no drift claim either way) when a path is not a regular file or cannot
 * be read, or when the set exceeds MAX_STORED_CHANGED_FILES paths or DRIFT_DIGEST_MAX_BYTES bytes.
 * Never rejects. 2.4.3 computes the "after" side with the same function.
 */
export async function digestFiles(paths: readonly string[]): Promise<FileDigests | undefined> {
  if (paths.length > MAX_STORED_CHANGED_FILES) return undefined;
  const out = new Map<string, string>();
  let total = 0;
  for (const path of paths) {
    try {
      const info = await stat(path);
      if (!info.isFile()) return undefined;
      total += info.size;
      if (total > DRIFT_DIGEST_MAX_BYTES) return undefined;
      out.set(path, createHash("sha256").update(await fsReadFile(path)).digest("hex"));
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") {
        out.set(path, PENDING_ABSENT_DIGEST);
        continue;
      }
      return undefined;
    }
  }
  return out;
}

// -----------------------------------------------------------------------------------------------
// 2.4.3a router_verify (plan section 1.5-18; pending.ts R2, R4, R6, R8, R9, R11)
// -----------------------------------------------------------------------------------------------

/** What one router_verify call asks for (index.ts builds it with parseRouterVerifyArgs). */
export type VerifyTarget =
  | { readonly kind: "handles"; readonly handles: readonly unknown[] }
  | { readonly kind: "pending" };

/** One line of a router_verify report, in the order the handles were named. */
export type HandleReport =
  | {
      readonly kind: "verdict";
      readonly handle: string;
      readonly description: string;
      readonly producerTier: string;
      /** "run": judged by this call; "joined": another call's run; "cached": settled earlier, nothing ran. */
      readonly via: "run" | "joined" | "cached";
      readonly result: SettledVerification;
    }
  /** Malformed, never issued, or issued to another session (R6): nothing distinguishes them. */
  | { readonly kind: "unknown"; readonly input: string }
  | { readonly kind: "expired"; readonly handle: string }
  /** Joined another call's run, which outlived this call's deadline (R8). */
  | { readonly kind: "elsewhere"; readonly handle: string; readonly description: string };

export interface VerifyReport {
  readonly items: readonly HandleReport[];
  /** Distinct handles beyond MAX_HANDLES_PER_CALL: reported, never run (R2). */
  readonly excess: number;
  readonly text: string;
}

export const ROUTER_VERIFY_ARGS_TEXT =
  "[router] router_verify: pass exactly one of `handles` (a non-empty list of vrf_ handles) or `pending: true`; nothing was run.";
export const ROUTER_VERIFY_NO_PENDING_TEXT = "[router] router_verify: no unverified delegations in this session; nothing was run.";
export const ROUTER_VERIFY_NO_RETRY_TEXT = "[router] Nothing was retried or escalated; whether to re-dispatch is your call.";
/** Section 1.5-18. The run always uses the current tree. */
export const DRIFT_NOTICE = "tree drifted since delegation; verdict reflects current state";
/** No per-file proof either way (no stored or current digests): a pass is never kept then. */
export const DRIFT_UNCHECKED_NOTICE = "drift since delegation could not be checked; verdict reflects current state";
export const ROUTER_VERIFY_CANCELLED_REASON = "router_verify was cancelled before a verdict";
export const ROUTER_VERIFY_RELEASED_REASON = "the delegation's verification data was released";
/** Drifted paths named per handle; the rest are counted. */
export const DRIFT_MAX_PATHS = 10;

/**
 * index.ts `router_verify` args. The SDK's arg root is an object shape (phase-2.4.md gather item
 * 1), so "exactly one of handles / pending" is checked here: both, neither, `pending` other than
 * true, and `handles` that is not a non-empty array are errors. Pure; never throws.
 */
export function parseRouterVerifyArgs(args: unknown): VerifyTarget | { readonly error: string } {
  const a = args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const hasHandles = a.handles !== undefined && a.handles !== null;
  const hasPending = a.pending !== undefined && a.pending !== null;
  if (hasHandles === hasPending) return { error: ROUTER_VERIFY_ARGS_TEXT };
  if (hasPending) return a.pending === true ? { kind: "pending" } : { error: ROUTER_VERIFY_ARGS_TEXT };
  if (!Array.isArray(a.handles) || a.handles.length === 0) return { error: ROUTER_VERIFY_ARGS_TEXT };
  return { kind: "handles", handles: a.handles };
}

/** A literal phrase inside a RegExp source. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * pending.ts R4: reasons that say nothing about the producer's work (slot busy, the deadline or an
 * abort, a timeout, an executor or coordinator error). Matched on 2.1/2.2's stable phrases
 * (deterministic.ts u6, u7, u13, u14, u16; batch.ts BATCH_REASONS; baseline.ts
 * REFERENCE_NONE.gateBudget) and this module's own. REFERENCE_NONE.failed ("failed or timed out" at
 * dispatch) is deliberately not matched: that reference cannot be recaptured, so it is terminal.
 *
 * QA-2.4-14: only where the ROUTER writes it: at the start of a reason, after at most one check-kind
 * word ("testsPass: ", "testsPass "). Producer-controlled text (failing test ids, "file > title")
 * only ever follows a router phrase ("introduced failures: ", "; observed failures: "), so a test
 * titled "verification slot busy" can never make a terminal verdict retryable.
 */
const TRANSIENT_REASON = new RegExp(
  "^(?:[A-Za-z]+:? )?(?:" +
    [
      "gate budget exhausted", // u7, u14 (deadline cut)
      "verification slot busy", // u14
      "timed out after \\d+ ?ms", // u13: "testsPass timed out after <n>ms: <command>"
      "check errored", // u16: "testsPass check errored: <reason>"
      "cannot attribute failures: the reference rerun timed out after \\d+ ?ms", // u6
      `(?:no reference: pre-existing failures cannot be told apart \\()?${escapeRegExp(REFERENCE_NONE.gateBudget)}`,
      "verification gate timed out after \\d+ ?ms",
      "verification coordinator (?:disposed|failed)",
      "verification batch (?:failed|ended without an outcome|produced no outcome)",
      "verification unavailable:",
      escapeRegExp(ABANDONED_REASON),
      escapeRegExp(DISPOSED_REASON),
      "router_verify was cancelled",
    ].join("|") +
    ")",
  "i",
);

/**
 * pending.ts R4 `retryable`: only an unverifiable (or skipped) verdict can be retryable, and only
 * when the call was cut (deadline, abort) or a reason is transient. A pass or a fail is a verdict on
 * the work and always terminal. Misclassification is never a false pass either way: a retryable
 * entry is re-run later, a terminal unverifiable is replayed.
 */
export function isRetryableVerdict(verdict: Verdict, cut: boolean): boolean {
  if (verdict.skipped === true) return true;
  const outcome = verdict.outcome ?? (verdict.pass ? "pass" : "fail");
  if (outcome !== "unverifiable") return false;
  if (cut) return true;
  return [...verdict.reasons, ...(verdict.caveats ?? [])].some(r => TRANSIENT_REASON.test(r));
}

function formatPaths(paths: readonly string[], base: string): string {
  const shown = paths.slice(0, DRIFT_MAX_PATHS).map(p => {
    const rel = relative(base, p);
    return sanitizeDescription(rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) ? rel : p);
  });
  const rest = paths.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} (+${rest} more)` : shown.join(", ");
}

function indent(text: string): string {
  return text.split("\n").map(line => `  ${line}`).join("\n");
}

/**
 * Section 1.5-18 / R9: one block per handle, in call order. A judged handle carries the required
 * gate's own wording: buildAcceptedSuffix when accepted, buildForcingNote (with the next tier on a
 * fail) plus ROUTER_VERIFY_NO_RETRY_TEXT when not. A retryable result is "not judged" and the
 * delegation stays unverified. Pure.
 */
export function formatVerifyReport(
  items: readonly HandleReport[],
  excess: number,
  strictUnverifiable: boolean,
  cwdOf: (handle: string) => string | undefined = () => undefined,
): string {
  const blocks: string[] = [];
  for (const item of items) {
    if (item.kind === "unknown") {
      blocks.push(`- ${sanitizeDescription(item.input)} \u00b7 ${UNKNOWN_HANDLE_TEXT}`);
      continue;
    }
    if (item.kind === "expired") {
      blocks.push(`- ${item.handle} \u00b7 ${EXPIRED_HANDLE_TEXT}`);
      continue;
    }
    if (item.kind === "elsewhere") {
      blocks.push(`- ${item.handle} \u00b7 ${item.description} \u00b7 ${VERIFYING_ELSEWHERE_TEXT}`);
      continue;
    }
    const { result } = item;
    const verdict = result.verdict;
    const via = item.via === "joined" ? " (joined a run already in progress)" : item.via === "cached" ? " (cached verdict; nothing was run)" : "";
    if (result.retryable) {
      const why = scrubText([...new Set([...(verdict.caveats ?? []), ...verdict.reasons])].join("; ") || "no verdict");
      blocks.push(
        `- ${item.handle} \u00b7 ${item.description} \u00b7 not judged${via}: ${why}\n` +
        "  [router] The delegation is still unverified; call `router_verify` again for a verdict.",
      );
      continue;
    }
    const judged = gateResult(verdict, "explicit", strictUnverifiable);
    const outcome = judged.verdict.outcome ?? "fail";
    const lines = [`- ${item.handle} \u00b7 ${item.description} \u00b7 ${outcome}${via}`];
    const base = cwdOf(item.handle) ?? "";
    if (result.driftedPaths !== undefined && result.driftedPaths.length > 0) {
      lines.push(indent(`[router] ${DRIFT_NOTICE} (changed after the producer returned: ${formatPaths(result.driftedPaths, base)})`));
    } else if ((verdict.caveats ?? []).includes(DRIFT_UNCHECKED_NOTICE)) {
      lines.push(indent(`[router] ${DRIFT_UNCHECKED_NOTICE}`));
    }
    if (judged.accepted) {
      lines.push(indent(buildAcceptedSuffix(verdict.method, judged.verdict.outcome, judged.verdict.caveats, verdict.notes).trim()));
    } else {
      lines.push(indent(scrubText(buildForcingNote(verdict.reasons, { producerTier: item.producerTier, nextTier: result.nextTier ?? null }))));
      lines.push(indent(ROUTER_VERIFY_NO_RETRY_TEXT));
    }
    blocks.push(lines.join("\n"));
  }
  if (excess > 0) {
    blocks.push(`- ${excess} more handle(s) not run: at most ${MAX_HANDLES_PER_CALL} per call; call \`router_verify\` again with the rest.`);
  }
  // QA-2.4-6 (R9): reasons, caveats and notes quote producer-controlled text (failing test ids).
  // An orchestrator that quotes this report before its own `VERIFY:` must not change its mode.
  return neutralizeDirectives(
    [`[router] router_verify: one verdict per handle (${items.length}${excess > 0 ? ` of ${items.length + excess}` : ""}).`, ...blocks].join("\n"),
  );
}

/**
 * 2.4.5 (pending.ts R14): a background run's report as queue outcomes. Only this run's own verdict
 * ("run") is "judged"; a verdict another router_verify call produced or had cached, and a run that
 * call still owns ("elsewhere"), are "reported" (that caller has or gets it); unknown and expired
 * handles are "gone". Pure.
 */
export function backgroundOutcomes(items: readonly HandleReport[]): BackgroundOutcome[] {
  return items.map((item): BackgroundOutcome => {
    if (item.kind === "verdict") {
      return item.via === "run"
        ? { kind: "judged", handle: item.handle, description: item.description, result: item.result }
        : { kind: "reported", handle: item.handle };
    }
    if (item.kind === "elsewhere") return { kind: "reported", handle: item.handle };
    return { kind: "gone", handle: item.kind === "unknown" ? item.input : item.handle };
  });
}

/** A never-rejecting wait for `promise` that ends with `fallback()` once `signal` aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal, fallback: () => T): Promise<T> {
  if (signal.aborted) return Promise.resolve(fallback());
  return new Promise<T>(settle => {
    const onAbort = (): void => settle(fallback());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        settle(value);
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        settle(fallback());
      },
    );
  });
}

function unverifiableVerdict(reason: string): Verdict {
  return { pass: false, outcome: "unverifiable", method: "none", reasons: [reason], caveats: [reason] };
}

/** Drift of one delegation's files since its producer returned (pending.ts R3 digests). */
type DriftCheck = { readonly kind: "none" } | { readonly kind: "drifted"; readonly paths: readonly string[] } | { readonly kind: "unchecked" };

/** A full object name (SHA-1 or SHA-256); anything else (e.g. an unborn HEAD) is an unknown head. */
const OBJECT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/**
 * QA-2.1-12: parses `git diff --name-status -z -M` into absolute paths under `root`: one status
 * token, then one path, or two (source, destination) for a rename or copy. Undefined when malformed.
 */
export function parseNameStatusZ(out: string, root: string): ChangedFile[] | undefined {
  const tokens = out.split("\0");
  if (tokens[tokens.length - 1] === "") tokens.pop();
  const files: ChangedFile[] = [];
  for (let i = 0; i < tokens.length;) {
    const status = tokens[i++];
    if (!/^[A-Z][0-9]*$/.test(status)) return undefined;
    const letter = status[0];
    if (letter === "R" || letter === "C") {
      const source = tokens[i++];
      const dest = tokens[i++];
      if (!source || !dest) return undefined;
      files.push({ path: resolve(root, dest), status: letter, previousPath: resolve(root, source) });
    } else {
      const path = tokens[i++];
      if (!path) return undefined;
      files.push({ path: resolve(root, path), status: letter });
    }
  }
  return files;
}
/** P5: the per-check timeout (DeterministicDeps.timeoutMs default). */
const CHECK_TIMEOUT_MS = 120_000;

export interface VerificationWiring {
  /**
   * Starts the dispatch's background work: the tree snapshot and, only for a DoD with an
   * allowlisted testsPass check and failureRecheck on, a git-only reference capture bounded by
   * baselineTimeoutMs. Resolves when both settled; never rejects. No test command runs (G6).
   */
  beginVerification(store: ReturnType<typeof createChangedFileStore>, id: string, cwd: string | undefined, dod: DoD): Promise<void>;
  /**
   * 2.1.5b: beginVerification, awaited for at most `waitMs` (2.4.2a: the dispatch's VERIFY_WAIT;
   * default captureWaitMs). The capture keeps running (up to baselineTimeoutMs) in the store after
   * a timeout; a timeout or error only means "no reference yet" and is logged. Never rejects.
   */
  beginVerificationBounded(
    store: ReturnType<typeof createChangedFileStore>,
    id: string,
    cwd: string | undefined,
    dod: DoD,
    waitMs?: number,
  ): Promise<void>;
  /**
   * 2.4.2a: parseVerifyDirectives over `text` with the config defaults (defaultVerify,
   * captureWaitMs, baselineTimeoutMs). `text` MUST be the orchestrator's own prompt
   * (dispatchDirectiveText). Unknown values are logged. Never throws: when the config cannot be
   * read, the mode is "required" (today's gate) and the wait FALLBACK_CAPTURE_WAIT_MS (QA-2.4-9).
   */
  resolveDirectives(text: string): VerifyDirectives;
  /**
   * 2.4.2a: resolveDirectives, then beginVerificationBounded for at most the directives' waitMs
   * (section 1.5-14: VERIFY_WAIT, 0 allowed), counted from this call, so the directive read and
   * the capture's synchronous start-up are inside it. `remember` keeps the start for takeDispatch
   * (the native `task` after hook). Never rejects.
   */
  startDispatch(
    store: ReturnType<typeof createChangedFileStore>,
    id: string,
    cwd: string | undefined,
    dod: DoD,
    text: string,
    remember: boolean,
  ): Promise<DispatchStart>;
  /**
   * 2.4.2b: the start remembered by startDispatch, forgotten on read. When none is remembered (the
   * before hook did not run, or the entry was swept), `text` is parsed again (same orchestrator
   * prompt) and dispatchedAt is now: a later dispatchedAt can only widen R11 lineage (fewer
   * passes), never narrow it.
   */
  takeDispatch(id: string, text: string): DispatchStart;
  /**
   * 2.4.2a: whether this delegation defers (section 1.5-16): mode "deferred", a testsPass check
   * in the DoD, and verification not disabled (`require: "never"`). Everything else is gated
   * exactly as before 2.4.
   * QA-2.4-10: only what the required gate would actually judge defers. `trivial` is the gate's own
   * input (the native path's dispatch-time classification; delegate passes none): the gate skips a
   * trivial dispatch whose DoD was inferred (gate.ts), so that one is not deferred and takes the
   * required path, with the same outcome. (An attributed empty change set of a testsPass-only DoD
   * is the other case; finishDeferred answers "no-change" for it. QA-G-1: a DoD with any other
   * check or a criterion stays deferred with that empty set.)
   */
  isDeferred(dod: DoD, directives: VerifyDirectives, trivial?: boolean): boolean;
  /**
   * 2.4.2a: the deferred finish. No gate, no test command, no slot: a tree snapshot and the commit
   * diff (git only, as prepareVerification) under DEFERRED_FINISH_MS, the static scoping plan
   * (runner.ts: no spawn), the risk (pending.ts R10), the drift digests (fs reads, awaited inside
   * the same bound so the baseline predates the result, QA-2.4-8),
   * `pending.register`, and the section 1.5-16 footer. The dispatch's reference promise is
   * registered un-awaited, and the dispatch record is cleared only after it settles (clearing it
   * earlier would abort the capture). Never rejects. QA-2.4-4: when the registry refuses the entry
   * or the finish fails, the result is `deferred: false` and the caller runs the required gate on
   * the dispatch (whose record is then left in the store); there is no footer without a handle.
   */
  finishDeferred(store: ReturnType<typeof createChangedFileStore>, input: DeferredFinishInput): Promise<DeferredFinish>;
  /**
   * 2.4.2b/c, pending.ts R11 on a required gate's result:
   * - outcome "fail" with proven-introduced ids -> pending.recordRejection (label
   *   "dispatch <id>", landedAt = returnedAt); the result is returned unchanged;
   * - otherwise, proven pre-existing ids that an earlier rejection of the same session and root
   *   introduced (findLineage) -> the verdict becomes unverifiable with buildLineageCaveat; it
   *   stays accepted unless strictUnverifiable. It never creates a pass or a fail.
   * A verdict without `failures` (checker verdicts, a timed-out gate) and an unknown root are
   * returned unchanged and record nothing.
   */
  applyLineage(res: GateResult, ctx: LineageContext): GateResult;
  /**
   * 2.4.3a, section 1.5-18: router_verify for `sessionID` (the calling orchestrator; "" = none, so
   * every handle is unknown). Never rejects; never retries or escalates.
   * - Handles are normalized, deduped and capped at MAX_HANDLES_PER_CALL; `pending` is listOpen, so
   *   runs already in flight are joined (R8). Lookups are scoped by session (R6).
   * - ONE Deadline of gateBudgetMs per call, created before any preparation (section 1.5-13) and
   *   shared by every claimed handle, so their testsPass requests meet in one S5 window.
   * - Each claimed handle runs the required gate's path: its stored changed files, its stored
   *   reference (awaited under the deadline), a fresh tree snapshot, buildGateDeps + accept under
   *   withTimeout(deadline.remaining()). All preparations finish before any gate starts.
   * - R11 lineage can only turn a pass into unverifiable; drift (stored vs current digests) or
   *   unprovable drift never lets a pass stand (DRIFT_NOTICE / DRIFT_UNCHECKED_NOTICE).
   * - QA-2.4-1: judged in two phases. Every gate of the call returns, every terminal fail with
   *   proven-introduced ids is recorded in the R11 ledger, and only then are lineage, drift and the
   *   next tier applied to every result, so the handle order and the gates' finishing order never
   *   decide a verdict. A background run is one such call.
   * - claim.settle runs in a `finally`; a transient unverifiable (isRetryableVerdict) returns the
   *   entry to unverified. A fail carries buildForcingNote with the next tier, and nothing else.
   * `signal` (the tool call's abort) aborts the deadline. `background` (2.4.5, the background
   * queue's own runs only) runs the gates at low priority whatever `lowPriority` says; any other
   * call marks the handles it reported, so no late notice repeats a verdict the caller received.
   */
  verifyHandles(
    sessionID: string,
    target: VerifyTarget,
    options?: { readonly signal?: AbortSignal; readonly background?: boolean },
  ): Promise<VerifyReport>;
  /** 2.4.1: the plugin instance's pending registry (sweep, forgetSession, dispose are wired in index.ts). */
  pending: PendingRegistry;
  /**
   * 2.4.5 (pending.ts R14): the background queue, constructed only when `background` is true at
   * plugin start; undefined otherwise, and nothing then refers to one. The deferred finish feeds
   * it; index.ts reads its late notices in the system transform and forgets a deleted session.
   */
  background: BackgroundQueue | undefined;
  /**
   * 2.1.5b: the crash GC of stale reference dirs, fire-and-forget. QA-2.1-11: it runs `delayMs`
   * (default REFERENCE_GC_START_DELAY_MS) after the call, on an unref'd timer, so plugin start
   * never spawns a git process in the project directory (a process's cwd holds the directory on
   * Windows: EBUSY for whoever removes it). Returns a cancel function for plugin dispose: it
   * clears a pending timer and aborts the git calls of a GC in flight. Never throws.
   */
  startReferenceGc(delayMs?: number): () => void;
  /** P0: the snapshot, the changed files and the settled reference, each bounded by `deadline` when given. */
  prepareVerification(
    store: ReturnType<typeof createChangedFileStore>,
    id: string,
    childID: string,
    cwd?: string,
    deadline?: Deadline,
  ): Promise<PreparedVerification>;
  /** Session ids currently running a grader prompt, so hooks can skip them. */
  graderSessions: Set<string>;
  /** Abort then delete a plugin-created child session. Never throws. */
  disposeChildSession(sid: string): Promise<void>;
  /** Run one grader turn, parented to the caller's session when given. */
  dispatchGrader(
    req: GraderRequest,
    parentSessionID?: string,
    inFlight?: Set<string>,
  ): Promise<{ sessionID: string; text: string }>;
  /**
   * Deps for the acceptance gate; graders are parented to parentSessionID.
   *
   * `inFlight`, when supplied, receives the id of every grader session this
   * gate invocation currently has open, and loses it again the moment that
   * grader finishes. A caller enforcing a gate budget aborts THAT set — never
   * the wiring-global one, which belongs to every concurrent delegation at
   * once.
   *
   * `prepared` supplies the testsPass inputs (changed files, reference, current tree); without it
   * the changed files are "unavailable" and the reference is the untracked default. `deadline`
   * bounds every testsPass step (T3); without it each testsPass check owns one of gateBudgetMs.
   */
  buildGateDeps(parentSessionID?: string, inFlight?: Set<string>, prepared?: PreparedVerification, deadline?: Deadline): GateDeps;
  /**
   * 2.2.3: the idle-TTL sweep's hook into the plugin's one S5 batch coordinator (batch.ts B11):
   * evicts windows with no live member and batches whose seam hung past BATCH_STALE_GRACE_MS.
   * Returns the number evicted. Never throws.
   */
  sweepVerification(): number;
  /**
   * 2.2.3: plugin dispose. Settles pending batched requests, kills running batches and awaits
   * their scope closes (batch.ts B11). Idempotent; never rejects.
   */
  disposeVerification(): Promise<void>;
}

/** How a bounded wait ended (awaitBounded). */
export type BoundedOutcome = { kind: "settled" } | { kind: "timeout" } | { kind: "error"; error: unknown };

/**
 * Wait for `promise` for at most `ms`. Never rejects; clears its timer; the timer is unref'd so a
 * pending wait never keeps the process alive. The promise itself keeps running after a timeout.
 */
export function awaitBounded(promise: Promise<unknown>, ms: number): Promise<BoundedOutcome> {
  return new Promise<BoundedOutcome>(resolveOutcome => {
    let done = false;
    const finish = (outcome: BoundedOutcome): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolveOutcome(outcome);
    };
    const timer = setTimeout(() => finish({ kind: "timeout" }), Math.max(0, ms));
    timer.unref?.();
    promise.then(() => finish({ kind: "settled" }), (error: unknown) => finish({ kind: "error", error }));
  });
}

/** Logging for the dispatch-time wait and the start-up GC. `debug` is optional (PluginLogger has none). */
export type WiringLogger = Pick<PluginLogger, "warn"> & { debug?: (message: string, extra?: Record<string, unknown>) => void };

function splitZ(out: string): string[] {
  return out.split("\0").filter(s => s.length > 0);
}

function errorText(err: unknown): string {
  return scrubText(err instanceof Error ? err.message : String(err));
}

export function createVerificationWiring(deps: {
  client: any;
  /** Project root; relative paths in checks resolve against it. */
  directory: string;
  getConfig: () => RouterConfig;
  /** Default: console.warn, no debug output. */
  logger?: WiringLogger;
  /** Test seams of the S5 batch coordinator (clock, timers, platform, maximum window size). */
  batch?: Omit<BatchCoordinatorOptions, "logger">;
  /** Test seams of the pending registry (clock, random source). */
  pending?: Pick<PendingRegistryOptions, "now" | "random">;
  /** Test seams of the 2.4.5 background queue; used only when `background` is true. */
  background?: Pick<BackgroundQueueOptions, "now" | "timers" | "settleMs" | "retryBaseMs" | "maxAttempts" | "platform">;
}): VerificationWiring {
  const { client, directory, getConfig } = deps;
  const logger: WiringLogger = deps.logger ?? { warn: (message, extra) => console.warn(message, extra ?? "") };
  const graderSessions = new Set<string>();
  /** Child sessions already torn down; see disposeChildSession. */
  const disposed = new Set<string>();
  const mutex = createMutexRegistry();
  /**
   * 2.2.3: one S5 batch coordinator per plugin instance (batch.ts D6). Each gate hands it its own
   * runtime, so a config reload reaches the next window without a new coordinator.
   */
  const coordinator = createBatchCoordinator({ ...deps.batch, logger });
  /**
   * 2.4.1/2.4.2a: one pending registry per plugin instance. Its TTL and abandonment bound are read
   * from the config at plugin start (a reload applies after a restart; the registry holds no timer).
   */
  let pendingBudget: Pick<VerifyBudget, "pendingTtlMs" | "gateBudgetMs" | "background">;
  try {
    pendingBudget = resolveVerifyBudget(getConfig());
  } catch (err) {
    // Plugin start never fails on config: the section 1.4 defaults (background off).
    logger.debug?.("[verify] pending registry uses default bounds: config unreadable", { error: errorText(err) });
    pendingBudget = { pendingTtlMs: DEFAULT_PENDING_TTL_MS, gateBudgetMs: DEFAULT_GATE_BUDGET_MS, background: false };
  }
  const pending = createPendingRegistry({
    ttlMs: pendingBudget.pendingTtlMs,
    maxVerifyingMs: pendingBudget.gateBudgetMs + VERIFYING_GRACE_MS,
    ...deps.pending,
    onEvict: (entry, cause) => logger.debug?.("[verify] pending delegation evicted", { handle: entry.handle, cause }),
  });
  const pendingNow = deps.pending?.now ?? Date.now;
  /**
   * 2.4.5: assigned once verifyHandles exists, and only when `background` is true at plugin start
   * (pending.ts R14). With background off this stays undefined: no queue, no timer, no run.
   */
  let background: BackgroundQueue | undefined;
  /** QA-2.4-5: foreground testsPass requests in flight (the background queue's `busy`). */
  const foreground = { tests: 0 };
  /** 2.4.2b: native `task` dispatch starts, before hook -> after hook (bounded FIFO, swept). */
  const dispatchStarts = new Map<string, DispatchStart>();
  /**
   * pending.ts R10: the settled value of each dispatch reference promise, recorded when it settles,
   * so a deferred finish can tell "already captured at return" without awaiting (0 ms). Keyed by
   * the promise object (the store returns the same one), so it holds nothing once the store drops it.
   */
  const settledReferences = new WeakMap<Promise<ReferenceState>, ReferenceState>();
  /**
   * QA-3.1-8: VerifyBudget.lowPriority for the tree snapshots; the section 1.4 default (true) when
   * the config cannot be read, so a snapshot never fails over it.
   */
  const configuredLowPriority = (): boolean => {
    try {
      return resolveVerifyBudget(getConfig()).lowPriority;
    } catch {
      return true;
    }
  };
  /** QA-3.1-3: dispatches starting together share their snapshot and capture (createSharedFlight). */
  const sharedSnapshots = createSharedFlight<TreeSnapshot>();
  const sharedCaptures = createSharedFlight<DispatchReference>();

  const abs = (p: string): string => (isAbsolute(p) ? p : join(directory, p));

  // QA-1.2-13: lowPriority and env reach the process; no per-call maxBuffer (QA-1.5-25).
  const execSeam: ExecSeam = (command: string, opts?: ExecOptions): Promise<ExecResult> =>
    runShell(command, {
      cwd: opts?.cwd ?? directory,
      timeoutMs: opts?.timeoutMs ?? CHECK_TIMEOUT_MS,
      signal: opts?.signal,
      lowPriority: opts?.lowPriority,
      env: opts?.env,
    });

  const argvSeam: ArgvSeam = (file, args, opts) =>
    runArgv(file, args, {
      cwd: opts?.cwd ?? directory,
      timeoutMs: opts?.timeoutMs ?? CHECK_TIMEOUT_MS,
      signal: opts?.signal,
      lowPriority: opts?.lowPriority,
      env: opts?.env,
    });

  // T9 1.3: PlannerFs + unlink over fs.promises. realpath is the native one; fileExists accepts
  // directories (access does).
  const fsSeam: RunnerFs = {
    async fileExists(p: string): Promise<boolean> {
      try {
        await access(abs(p));
        return true;
      } catch {
        return false;
      }
    },
    async readFile(p: string): Promise<string> {
      return await fsReadFile(abs(p), "utf-8");
    },
    realpath: p => realpath(abs(p)),
    async stat(p) {
      const s = await stat(abs(p), { bigint: true });
      return { isFile: s.isFile(), size: s.size, dev: s.dev, ino: s.ino };
    },
    readdir: p => readdir(abs(p)),
    async unlink(p) {
      try {
        await unlink(abs(p));
      } catch (err) {
        // Already gone resolves (RunnerFs contract); anything else is the caller's to report.
        if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) throw err;
      }
    },
  };

  /**
   * QA-2.1-12: the files of the commits made since the dispatch snapshot. A shell edit to a file
   * clean at dispatch, then committed, is invisible to `git status`. Undefined when HEAD did not
   * move (nothing is spawned) or either snapshot is missing (delta is unavailable then anyway).
   * "unavailable" when HEAD moved and the diff failed, timed out, or could not run, or when either
   * head is unknown (e.g. an unborn repository at dispatch).
   */
  const committedSinceDispatch = async (
    before: TreeSnapshot | undefined,
    now: TreeSnapshot | undefined,
    deadline: Deadline | undefined,
  ): Promise<ChangedFile[] | "unavailable" | undefined> => {
    if (!before || !now || before.head === now.head) return undefined;
    const root = now.root;
    if (!root || !OBJECT_NAME.test(before.head) || !OBJECT_NAME.test(now.head)) return "unavailable";
    const timeoutMs = deadline ? deadline.bound(COMMIT_DIFF_TIMEOUT_MS) : COMMIT_DIFF_TIMEOUT_MS;
    if (timeoutMs <= 0 || deadline?.signal.aborted) return "unavailable";
    try {
      const r = await argvSeam("git", ["--no-optional-locks", "-C", root, "diff", "--name-status", "-z", "-M", before.head, "HEAD"], {
        cwd: root,
        timeoutMs,
        lowPriority: resolveVerifyBudget(getConfig()).lowPriority,
        ...(deadline ? { signal: deadline.signal } : {}),
      });
      if (r.timedOut === true || r.code !== 0) return "unavailable";
      return parseNameStatusZ(r.stdout, root) ?? "unavailable";
    } catch {
      return "unavailable"; // The diff could not run: never the same as "no commit touched a file".
    }
  };

  /** T9 1.3: the planners' git searches through the argv seam; no shell, no optional locks. */
  const testSearch = (budget: VerifyBudget, deadline: Deadline | undefined): TestSearchSeam => {
    const git = async (root: string, args: readonly string[]): Promise<SeamResult | undefined> => {
      const timeoutMs = deadline ? deadline.bound(TEST_SEARCH_TIMEOUT_MS) : TEST_SEARCH_TIMEOUT_MS;
      if (timeoutMs <= 0 || deadline?.signal.aborted) return undefined;
      try {
        const r = await argvSeam("git", ["--no-optional-locks", "-C", root, ...args], {
          cwd: root,
          timeoutMs,
          lowPriority: budget.lowPriority,
          ...(deadline ? { signal: deadline.signal } : {}),
        });
        return r.timedOut === true ? undefined : r;
      } catch {
        return undefined; // The search could not run: never the same as "no match".
      }
    };
    return {
      async findByName(gitRoot, names) {
        // QA-G-3: a name is literal, so its glob metacharacters are bracketed ([*], [[], [\\]):
        // git on Windows reads a backslash in a pathspec as a separator, not an escape.
        const lit = (n: string) => n.replace(/[*?[\]\\]/g, c => (c === "\\" ? "[\\\\]" : `[${c}]`));
        const r = await git(gitRoot, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...names.map(n => `:(glob)**/${lit(n)}`)]);
        return r && r.code === 0 ? splitZ(r.stdout).map(rel => resolve(gitRoot, rel)) : undefined;
      },
      async findByContent(gitRoot, needle, globs, options) {
        const word = options?.word === true ? ["-w"] : [];
        const r = await git(gitRoot, ["grep", "-l", "-z", "-F", ...word, "--untracked", "-e", needle, "--", ...globs]);
        if (!r) return undefined;
        if (r.code === 1) return [];
        return r.code === 0 ? splitZ(r.stdout).map(rel => resolve(gitRoot, rel)) : undefined;
      },
    };
  };

  // Best-effort disposal of a plugin-created child session: abort any in-flight
  // work, then delete it so it does not linger forever as a top-level session in
  // the TUI. Fail-soft by contract — never throws, so it is safe to call from a
  // finally without masking the original error.
  const disposeChildSession = async (sid: string): Promise<void> => {
    // Idempotent, not merely fail-soft. Several paths legitimately dispose the
    // same session — the per-attempt teardown in the delegate ladder and the
    // end-of-execute safety net both do, and a timeout racing a late completion
    // can too. Re-issuing abort+delete was harmless but not free, and it made
    // "disposed exactly once" unassertable, which is precisely the property the
    // time-box work has to be able to prove.
    if (disposed.has(sid)) return;
    // Bounded: the memo only has to outlive the handful of callers that can
    // race over one session (per-attempt teardown, the end-of-execute safety
    // net, a timeout beaten by a late completion), all of which happen within a
    // single delegate call. A plugin instance lives for the whole editor
    // session, so an unbounded Set would be a slow leak. Insertion order is
    // specified for Set, so dropping from the front evicts the oldest ids.
    if (disposed.size >= DISPOSED_MEMO_MAX) {
      let toDrop = disposed.size - DISPOSED_MEMO_MAX + 1;
      for (const old of disposed) {
        disposed.delete(old);
        if (--toDrop <= 0) break;
      }
    }
    disposed.add(sid);
    try {
      await client.session.abort({ path: { id: sid } });
    } catch {
      // best-effort: the session may already have completed or been removed
    }
    try {
      await client.session.delete({ path: { id: sid } });
    } catch {
      // best-effort: cleanup must never break the run
    }
  };

  const dispatchGrader = async (
    req: GraderRequest,
    parentSessionID?: string,
    inFlight?: Set<string>,
  ): Promise<{ sessionID: string; text: string }> => {
    // Scope the grader session to the producer's working directory when one was
    // declared. Naming the directory in the prompt is not enough: the grader
    // has real tools, and an unscoped session resolves every read and command
    // against the router's own cwd, so it would happily report "file not found"
    // for work that exists exactly where it was asked for.
    const created: any = await client.session.create({
      body: { ...(parentSessionID ? { parentID: parentSessionID } : {}) },
      ...(req.cwd ? { query: { directory: req.cwd } } : {}),
    });
    const sid: string | undefined = created?.data?.id;
    if (!sid) return { sessionID: "", text: "" };
    graderSessions.add(sid);
    inFlight?.add(sid);
    try {
      const cfg = getConfig();
      const model = tierModel(cfg, req.tier) ?? undefined;
      // Time-boxed for the same reason as the producer prompt, but with a
      // sharper edge: a grader that never answers must not be able to hold the
      // gate open. The RouterTimeoutError is deliberately allowed to propagate
      // to runChecker, which returns unverifiable with the timeout reason.
      // The gate decides acceptance using strictUnverifiable; no producer
      // escalation is warranted when the grader itself could not finish.
      //
      // No abort is issued here: the finally below already calls
      // disposeChildSession, which aborts before it deletes, so a second abort
      // on this path would be a redundant round trip that cancels nothing extra.
      // (The gate-budget path in index.ts does issue a raw abort, deliberately:
      // it fires while this call is still suspended, before the finally has had
      // a chance to run at all.)
      const res: any = await withTimeout(
        client.session.prompt({
          path: { id: sid },
          body: {
            ...(model ? { model } : {}),
            system: req.system,
            parts: [{ type: "text", text: req.prompt }],
          },
        }),
        graderTimeoutMs(req.tier, cfg.enforcement?.verify?.graderTimeoutMs),
        "grader prompt",
      );
      const responseError = graderPromptResponseError(res);
      if (responseError) throw responseError;
      return { sessionID: sid, text: extractAssistantText(res) };
    } finally {
      graderSessions.delete(sid);
      inFlight?.delete(sid);
      await disposeChildSession(sid);
    }
  };

  /** What beginDispatch captures for `dod` under the current config (T9 1.1: resolveVerifyBudget). */
  const captureDepsFor = (dod: DoD): DispatchCaptureDeps => {
    const cfg = getConfig();
    const budget = resolveVerifyBudget(cfg);
    // Only a dispatch that will be judged by testsPass captures a reference (G6: a git-only
    // capture, never a test run). Read-only fan-outs capture nothing.
    const judgedByTests = cfg.enforcement?.verify?.require !== "never" && dod.checks.some(
      c => c.kind === "testsPass" && isCommandAllowed(resolveRepoCommand(c, "testsPass", undefined), DEFAULT_ALLOWLIST),
    );
    // QA-3.1-3: one run per key serves every dispatch that asked before it started (same cwd and
    // the same priority and bound, so the same git processes).
    const flightKey = (at: string): string => `${budget.lowPriority ? "low" : "normal"}\0${budget.baselineTimeoutMs}\0${at}`;
    const base = {
      // QA-3.1-8: the snapshot's git processes run at the configured priority, as the capture's do.
      snapshot: (at: string, signal: AbortSignal) =>
        sharedSnapshots(flightKey(at), shared => snapshotTree(at, shared, { lowPriority: budget.lowPriority }), signal),
      timeoutMs: budget.baselineTimeoutMs,
    };
    if (!judgedByTests) return { ...base, uncaptured: { kind: "none", reason: REFERENCE_NONE.notRequested } };
    if (!budget.failureRecheck) return { ...base, uncaptured: { kind: "disabled" } };
    // QA-1.2-13: the capture's git processes run at the configured priority too.
    const argv: ArgvSeam = (file, args, opts) => argvSeam(file, args, { ...opts, lowPriority: budget.lowPriority });
    return {
      ...base,
      capture: (at, signal) =>
        sharedCaptures(flightKey(at), shared => captureReference(at, shared, { argv, fs: nodeReferenceFs, timeoutMs: budget.baselineTimeoutMs }), signal),
    };
  };

  const buildGateDeps = (
    parentSessionID?: string,
    inFlight?: Set<string>,
    prepared?: PreparedVerification,
    deadline?: Deadline,
    forceLowPriority = false,
  ): GateDeps => {
    const cfg = getConfig();
    const resolved = resolveVerifyBudget(cfg);
    // 2.4.5 (section 1.5-19): background runs are low priority whatever `lowPriority` says.
    // QA-2.4-5: and they never wait for the slot (waitMs 0): busy means back off and retry later.
    const budget: VerifyBudget = forceLowPriority ? { ...resolved, lowPriority: true, slotWaitMs: 0 } : resolved;
    // QA-2.1-5: the recheck's git processes (GC, materialize, dispose) run at the configured
    // priority too, like the capture and the start-up GC (QA-1.2-13).
    const referenceArgv: ArgvSeam = (file, args, opts) => argvSeam(file, args, { ...opts, lowPriority: budget.lowPriority });
    const openScope = createScopeOpener({
      argv: argvSeam, exec: execSeam, fs: fsSeam, budget, checkTimeoutMs: CHECK_TIMEOUT_MS,
      reference: { argv: referenceArgv },
    });
    const currentTree = prepared?.snapshot !== undefined ? { currentTree: prepared.snapshot } : {};
    const direct = createDirectTestsPassHook({
      openScope,
      plannerFs: fsSeam,
      search: testSearch(budget, deadline),
      budget,
      ...currentTree,
    });
    // 2.2.3 (S5): with a batch window, concurrent testsPass checks of this plugin instance meet in
    // the coordinator; the direct hook stays behind it for "full" scope and single requests (B2).
    // The planner is the direct hook's (planScopedRun over the same PlannerFs and budget), with
    // its git searches bound to whichever deadline the coordinator plans under (B6).
    let testsPass: TestsPassHook = direct;
    const batchWindowMs = effectiveBatchWindowMs(budget);
    if (batchWindowMs > 0) {
      const plan: BatchPlanner = (input, planDeadline) => planScopedRun({
        command: input.command,
        cwd: input.cwd,
        changedFiles: input.changedFiles,
        budget: { maxWorkers: budget.maxWorkers },
        fs: fsSeam,
        search: testSearch(budget, planDeadline),
      });
      testsPass = coordinator.hook({
        direct,
        plan,
        openScope,
        batchWindowMs,
        recheckMinRemainingMs: RECHECK_MIN_REMAINING_MS,
        failureRecheck: budget.failureRecheck,
        ...currentTree,
      });
    }
    // QA-2.4-5: foreground testsPass (a required gate, router_verify) takes precedence over a
    // background run: the run in flight is preempted before this request plans or asks for the
    // slot, and no background run starts while one is active.
    if (!forceLowPriority) {
      const inner = testsPass;
      testsPass = async request => {
        foreground.tests += 1;
        try {
          void background?.preempt();
          return await inner(request);
        } finally {
          foreground.tests -= 1;
        }
      };
    }
    return {
      deterministic: {
        exec: execSeam,
        fs: fsSeam,
        cwd: directory,
        mutex,
        argv: argvSeam,
        budget,
        openScope,
        testsPass,
        // Section 1.5-6: without a change baseline, shell edits are unattributed.
        changedFiles: prepared?.changeBaseline === "available" ? prepared.changedFiles : "unavailable",
        ...(prepared !== undefined ? { reference: prepared.reference } : {}),
        ...(deadline !== undefined ? { deadline } : {}),
      },
      checker: {
        dispatchGrader: (req: GraderRequest) =>
          dispatchGrader(req, parentSessionID, inFlight),
        ladder: ["fast", "medium", "heavy"],
        minGraderTier: cfg.enforcement?.verify?.minGraderTier ?? null,
      },
      require: cfg.enforcement?.verify?.require,
      strictUnverifiable: cfg.enforcement?.verify?.strictUnverifiable,
    };
  };

  const beginVerification: VerificationWiring["beginVerification"] = async (store, id, cwd, dod) => {
    let deps: DispatchCaptureDeps;
    try {
      deps = captureDepsFor(dod);
    } catch (err) {
      // Never blocks or fails the dispatch: snapshot only (at the section 1.4 default low priority,
      // QA-3.1-8), and no reference.
      deps = {
        snapshot: (at, signal) => snapshotTree(at, signal, { lowPriority: true }),
        timeoutMs: DEFAULT_CAPTURE_TIMEOUT_MS,
        uncaptured: { kind: "none", reason: `${REFERENCE_NONE.failed} (${errorText(err)})` },
      };
    }
    const begun = store.beginDispatch(id, resolve(directory, cwd || "."), deps);
    // pending.ts R10: remember the reference's settled value (the store hands out one promise).
    const reference = store.reference(id);
    if (!settledReferences.has(reference)) void reference.then(state => settledReferences.set(reference, state));
    await begun;
  };

  /**
   * The producer's change since the dispatch: the gate-time snapshot (bounded by `deadline`), the
   * commits since the dispatch head, and the store's delta. Shared by prepareVerification and the
   * deferred finish, so both attribute exactly the same files.
   */
  const observeChange = async (
    store: ReturnType<typeof createChangedFileStore>,
    id: string,
    childID: string,
    cwd: string | undefined,
    deadline: Deadline | undefined,
  ): Promise<Omit<PreparedVerification, "reference">> => {
    const base = resolve(directory, cwd || ".");
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    deadline?.signal.addEventListener("abort", onAbort, { once: true });
    let snapshot: TreeSnapshot | undefined;
    try {
      const bound = deadline ? deadline.bound(GRADE_SNAPSHOT_TIMEOUT_MS) : GRADE_SNAPSHOT_TIMEOUT_MS;
      // QA-2.1-2: digest exactly the paths the dispatch snapshot digested (<= MAX_DIGEST_FILES),
      // so delta can tell which already-dirty file a shell edit changed.
      const digests = store.baselineSnapshot(id)?.digests;
      // QA-3.1-8: at the configured priority, like every other verification process.
      const lowPriority = configuredLowPriority();
      const options = digests === undefined
        ? { lowPriority }
        : { lowPriority, digestPaths: digests === "unavailable" ? [] : [...digests.keys()] };
      snapshot = bound > 0 && !controller.signal.aborted
        ? await withTimeout(snapshotTree(base, controller.signal, options), bound, "grade fingerprint")
        : undefined;
    } catch {
      snapshot = undefined; // Explicit unavailable disclaimer, never a raw tree.
    } finally {
      deadline?.signal.removeEventListener("abort", onAbort);
      controller.abort();
    }
    const committed = await committedSinceDispatch(store.baselineSnapshot(id), snapshot, deadline);
    const contaminatedBy = store.snapshotContaminatedBy(id);
    return {
      ...store.delta(id, childID, snapshot, base, committed),
      snapshot,
      concurrentDispatches: store.concurrentDispatches(id, snapshot?.root),
      ...(contaminatedBy !== undefined ? { contaminatedBy } : {}),
    };
  };

  /**
   * beginVerificationBounded, with the wait counted from `startedAt` (a Date.now() value): the
   * dispatch waits at most `waitMs` from its start, not `waitMs` after the capture's synchronous
   * start-up returned. That start-up (config, the snapshot's first git spawn) is the dispatch's
   * time too, and under load it is not negligible (CI round 1, 3.1.2.f: 20 parallel dispatches on
   * a 4-core runner held their before hooks up to 104 ms past VERIFY_WAIT). Date.now rather than
   * performance.now, so fake clocks drive it together with the timer.
   */
  const boundedCaptureWait = async (
    store: ReturnType<typeof createChangedFileStore>,
    id: string,
    cwd: string | undefined,
    dod: DoD,
    waitOverrideMs: number | undefined,
    startedAt: number,
  ): Promise<void> => {
    let waitMs: number;
    let begun: Promise<void>;
    try {
      waitMs = waitOverrideMs ?? resolveVerifyBudget(getConfig()).captureWaitMs;
      begun = beginVerification(store, id, cwd, dod);
    } catch (err) {
      logger.warn("[verify] dispatch reference capture could not start", { id, error: errorText(err) });
      return;
    }
    // A clock stepped backwards never lengthens the wait past waitMs.
    const remaining = Math.min(waitMs, Math.max(0, waitMs - (Date.now() - startedAt)));
    const outcome = await awaitBounded(begun, remaining);
    if (outcome.kind === "timeout") {
      logger.debug?.("[verify] dispatch reference not ready; proceeding without waiting further", { id, waitMs });
    } else if (outcome.kind === "error") {
      logger.warn("[verify] dispatch reference capture failed; proceeding without a reference", { id, error: errorText(outcome.error) });
    }
  };

  const beginVerificationBounded: VerificationWiring["beginVerificationBounded"] = (store, id, cwd, dod, waitOverrideMs) =>
    boundedCaptureWait(store, id, cwd, dod, waitOverrideMs, Date.now());

  const resolveDirectives = (text: string): VerifyDirectives => {
    try {
      const budget = resolveVerifyBudget(getConfig());
      return parseVerifyDirectives(
        text,
        { defaultVerify: budget.defaultVerify, captureWaitMs: budget.captureWaitMs, baselineTimeoutMs: budget.baselineTimeoutMs },
        message => logger.warn(message),
      );
    } catch (err) {
      // No config, no deferral: today's synchronous gate. QA-2.4-9: with the section 1.4 default
      // capture wait (clamped to the default baselineTimeoutMs), as 2.1 waited: a producer started
      // before its capture resolves contaminates it, and pre-existing failures could no longer be
      // told apart.
      logger.warn("[verify] dispatch directives could not be resolved; verifying synchronously", { error: errorText(err) });
      return { mode: "required", waitMs: FALLBACK_CAPTURE_WAIT_MS, modeSource: "default", waitSource: "default" };
    }
  };

  /**
   * Section 1.5-17 "scoping impossible", decided with no process (runner.ts:11): planStaticScoping
   * for each testsPass check, with the command and cwd the gate would use. The first S6 result wins;
   * a command outside the allowlist is S6 too (the gate reports it unverifiable). Bounded by the
   * deferred-finish deadline; an unfinished plan counts as impossible (raises the risk, never lowers it).
   */
  const staticScoping = async (
    dod: DoD,
    cwd: string | undefined,
    changedFiles: readonly ChangedPath[],
    deadline: Deadline,
  ): Promise<StaticScoping> => {
    const unfinished: StaticScoping = { unverifiable: true, code: "search-failed", reason: STATIC_SCOPING_UNFINISHED_REASON };
    const budget = resolveVerifyBudget(getConfig());
    const at = resolveBaseDir(cwd, directory);
    const plans: StaticScoping[] = [];
    for (const check of dod.checks) {
      if (check.kind !== "testsPass") continue;
      const command = resolveRepoCommand(check, "testsPass", undefined);
      if (!isCommandAllowed(command, DEFAULT_ALLOWLIST)) {
        plans.push({ unverifiable: true, code: "unsupported-command", reason: `command not allowlisted: ${scrubText(command)}` });
        continue;
      }
      const ms = deadline.remaining();
      if (ms <= 0) {
        plans.push(unfinished);
        continue;
      }
      try {
        plans.push(await withTimeout(
          planStaticScoping({ command, cwd: at, changedFiles, budget: { maxWorkers: budget.maxWorkers }, fs: fsSeam }),
          ms,
          "static scoping",
        ));
      } catch {
        plans.push(unfinished);
      }
    }
    return plans.find(p => "unverifiable" in p) ?? plans[0] ?? unfinished;
  };

  const finishDeferred: VerificationWiring["finishDeferred"] = async (store, input) => {
    const producerTier = canonicalTier(input.producerTier);
    // The live reference promise (no signal: never awaited here). Its settled value at this moment
    // is the R10 `reference` input; a capture still in flight counts as absent.
    const reference = store.reference(input.dispatchID);
    const referenceCaptured = settledReferences.get(reference)?.kind === "captured";
    const deadline = createDeadline(DEFERRED_FINISH_MS);
    let risk: RiskAssessment = unattributedRisk();
    let deferred = false;
    try {
      const change = await observeChange(store, input.dispatchID, input.producerSessionID, input.cwd, deadline);
      // QA-2.4-10: an attributed empty change set is passed by the required gate with no process
      // (section 1.5-6): nothing to defer. The caller runs that gate, with the same outcome.
      // QA-G-1: only for a testsPass-only DoD. Any other check (build, lint, run, fileExists,
      // schemaMatch) or a criterion would be run or graded by that gate synchronously, so such a
      // DoD stays deferred as a whole, with the attributed empty change set (risk low).
      if (
        change.changeBaseline === "available" && change.changedFiles.length === 0 && !deadline.signal.aborted &&
        noChangeGateSpawnsNothing(input.dod)
      ) {
        return { deferred: false, reason: "no-change", detail: "the producer changed no file" };
      }
      let changedFiles: ChangedPath[] | "unavailable" = "unavailable";
      let digests: Promise<FileDigests | undefined> | undefined;
      // Section 1.5-6 / QA-1.6-14: without a change baseline the set is unknown, never [].
      if (change.changeBaseline === "available" && !deadline.signal.aborted) {
        const paths: ChangedPath[] = change.changedFiles.map(f => ({
          path: f.path,
          status: f.status,
          ...(f.previousPath !== undefined ? { previousPath: f.previousPath } : {}),
        }));
        changedFiles = paths;
        const scopingPlan = await staticScoping(input.dod, input.cwd, paths, deadline);
        risk = assessRisk({ changedFiles: paths, reference: referenceCaptured, producerTier, scopingPlan, root: change.snapshot?.root });
        // QA-2.4-8: the drift baseline is taken BEFORE the result is released (fs reads only, under
        // the same DEFERRED_FINISH_MS bound). An edit that lands right after the return is then
        // drift, never part of the baseline. Not taken in time: no digests, so drift is
        // "unchecked" and a later pass is downgraded.
        const taken = await untilAborted(digestFiles(paths.map(p => p.path)), deadline.signal, () => undefined);
        if (taken !== undefined) digests = Promise.resolve(taken);
      }
      const reg = pending.register({
        orchestratorSessionID: input.orchestratorSessionID,
        dispatchID: input.dispatchID,
        producerSessionID: input.producerSessionID,
        producerTier,
        description: input.description,
        cwd: resolveBaseDir(input.cwd, directory),
        root: change.snapshot?.root,
        dispatchedAt: input.dispatchedAt,
        dod: input.dod,
        reference,
        changedFiles,
        risk,
        ...(digests !== undefined ? { digests } : {}),
        // QA-3.1-2 / QA-3.1-3: the window ends here (the change set is fixed now); router_verify
        // adds the caveats to its verdict.
        ...(change.concurrentDispatches !== undefined && change.concurrentDispatches > 0 ? { concurrentDispatches: change.concurrentDispatches } : {}),
        ...(change.contaminatedBy !== undefined ? { contaminatedBy: change.contaminatedBy } : {}),
      });
      if (!reg.ok) {
        // QA-2.4-4: never a delegation without a verdict path: the caller runs the required gate.
        logger.warn("[verify] deferred delegation not registered; verifying synchronously", { code: reg.code, detail: reg.detail });
        return { deferred: false, reason: "unregistered", detail: `${reg.code}: ${reg.detail}` };
      }
      deferred = true;
      // 2.4.5 (pending.ts R14): queued, never awaited: the queue's own timer starts the run later.
      // An unattributed change set is not queued (nothing could run; it stays listed instead).
      if (background !== undefined && changedFiles !== "unavailable") {
        try {
          background.enqueue({ sessionID: input.orchestratorSessionID, handle: reg.handle, files: changedFiles.map(p => p.path) });
        } catch (err) {
          // The handle is registered: the delegation stays unverified and listed, as without background.
          logger.warn("[verify] deferred delegation not queued for background verification", { handle: reg.handle, error: errorText(err) });
        }
      }
      return { deferred: true, footer: buildDeferredFooter({ handle: reg.handle, risk }), handle: reg.handle, risk };
    } catch (err) {
      // QA-2.4-4: as for a refused registration, the required gate runs instead.
      logger.warn("[verify] deferred finish failed; verifying synchronously", { error: errorText(err) });
      return { deferred: false, reason: "error", detail: errorText(err) };
    } finally {
      deadline.dispose();
      // A deferred dispatch's record goes once the finish has read it (delta) AND its reference
      // settled: clearing it earlier aborts an in-flight capture (dispatch.ts evict) and ends its
      // contamination tracking (section 1.5-14). A dispatch that is not deferred keeps it for the
      // required gate, which clears it as before.
      if (deferred) void reference.then(() => store.clear(input.dispatchID));
    }
  };

  /**
   * R11, the downgrade half: proven pre-existing ids that an earlier rejection of the same session
   * and root introduced turn a non-fail verdict into unverifiable with buildLineageCaveat. It never
   * creates a pass or a fail. Shared by applyLineage and verifyHandles.
   */
  const lineageDowngrade = (
    res: GateResult,
    ctx: Pick<LineageContext, "orchestratorSessionID" | "root" | "dispatchedAt" | "strictUnverifiable">,
  ): GateResult => {
    const failures = res.verdict.failures;
    if (failures === undefined || ctx.root === undefined || ctx.orchestratorSessionID === "") return res;
    const outcome = res.verdict.outcome ?? (res.verdict.pass ? "pass" : "fail");
    if (outcome === "fail" || failures.preexisting.length === 0) return res;
    const match = pending.findLineage({
      orchestratorSessionID: ctx.orchestratorSessionID,
      root: ctx.root,
      dispatchedAt: ctx.dispatchedAt,
      preexisting: failures.preexisting,
    });
    if (match === undefined) return res;
    const caveat = buildLineageCaveat(match);
    return gateResult(
      { ...res.verdict, pass: false, outcome: "unverifiable", caveats: [...(res.verdict.caveats ?? []), caveat] },
      res.dodSource,
      ctx.strictUnverifiable ?? false,
    );
  };

  const applyLineage: VerificationWiring["applyLineage"] = (res, ctx) => {
    const failures = res.verdict.failures;
    if (failures === undefined || ctx.root === undefined || ctx.orchestratorSessionID === "") return res;
    const outcome = res.verdict.outcome ?? (res.verdict.pass ? "pass" : "fail");
    if (outcome === "fail") {
      if (failures.introduced.length > 0) {
        pending.recordRejection({
          orchestratorSessionID: ctx.orchestratorSessionID,
          root: ctx.root,
          label: `dispatch ${ctx.dispatchID}`,
          landedAt: ctx.returnedAt,
          introduced: failures.introduced,
        });
      }
      return res;
    }
    return lineageDowngrade(res, ctx);
  };

  /** 2.4.3a: the current tree for one call, once per cwd (the materialize same-repository guard, P0). */
  const snapshotFor = async (cwd: string, deadline: Deadline, lowPriority: boolean): Promise<TreeSnapshot | undefined> => {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    deadline.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const bound = deadline.bound(GRADE_SNAPSHOT_TIMEOUT_MS);
      if (bound <= 0 || controller.signal.aborted) return undefined;
      // No digests: the drift check digests the producer's files itself (checkDrift).
      return await withTimeout(snapshotTree(cwd, controller.signal, { digestPaths: [], lowPriority }), bound, "router_verify fingerprint");
    } catch {
      return undefined; // No current tree: materialize skips its same-repository guard, as without a snapshot.
    } finally {
      deadline.signal.removeEventListener("abort", onAbort);
      controller.abort();
    }
  };

  /**
   * 2.4.3a, section 1.5-18: the producer's files now against their digests right after it returned.
   * "unchecked" whenever either side is missing (no change set, no stored digests, a digest that
   * could not be taken, or the deadline): never a claim of "no drift" without proof.
   */
  const checkDrift = async (entry: PendingEntry, deadline: Deadline): Promise<DriftCheck> => {
    if (entry.changedFiles === "unavailable" || entry.digests === undefined) return { kind: "unchecked" };
    const before = await untilAborted(entry.digests, deadline.signal, () => undefined);
    if (before === undefined) return { kind: "unchecked" };
    const after = await untilAborted(digestFiles([...before.keys()]), deadline.signal, () => undefined);
    if (after === undefined) return { kind: "unchecked" };
    const paths = driftedPaths(before, after);
    return paths.length > 0 ? { kind: "drifted", paths } : { kind: "none" };
  };

  interface ClaimPreparation {
    readonly prepared: PreparedVerification;
    readonly drift: DriftCheck;
    /** R11 root: the registered one, else the current tree's. */
    readonly root: string | undefined;
  }

  /** One claimed entry after its gate: a final result, or the raw gate result still to be judged. */
  type ClaimGate =
    | { readonly kind: "final"; readonly result: VerificationResult }
    | { readonly kind: "gate"; readonly res: GateResult; readonly retryable: boolean; readonly strict: boolean };

  /** 2.4.3a P0 from the pending entry: stored change set and reference, current tree, drift. */
  const prepareClaim = async (
    entry: PendingEntry,
    deadline: Deadline,
    snapshots: Map<string, Promise<TreeSnapshot | undefined>>,
    lowPriority: boolean,
  ): Promise<ClaimPreparation> => {
    let snapshot = snapshots.get(entry.cwd);
    if (snapshot === undefined) {
      snapshot = snapshotFor(entry.cwd, deadline, lowPriority);
      snapshots.set(entry.cwd, snapshot);
    }
    const [reference, drift, tree] = await Promise.all([
      // The same bound as the store's reference(id, signal): a capture still pending at the deadline
      // is "no reference (gate budget)".
      untilAborted<ReferenceState>(entry.reference, deadline.signal, () => ({ kind: "none", reason: REFERENCE_NONE.gateBudget })),
      checkDrift(entry, deadline),
      snapshot,
    ]);
    const changed = entry.changedFiles;
    return {
      prepared: {
        changedFiles: changed === "unavailable"
          ? []
          : changed.map(c => ({ path: c.path, status: c.status ?? "", ...(c.previousPath !== undefined ? { previousPath: c.previousPath } : {}) })),
        // Section 1.5-6: an unattributed change set stays unattributed (never []).
        changeBaseline: changed === "unavailable" ? "unavailable" : "available",
        reference,
        snapshot: tree,
      },
      drift,
      root: entry.root ?? tree?.root,
    };
  };

  /**
   * 2.4.3a: the required gate on one claimed entry (index.ts's sequence: buildGateDeps, accept
   * under withTimeout(deadline.remaining()), unverifiableGateResult on a reject). A timeout aborts
   * the shared deadline (every member is out of budget at that instant anyway) and this gate's
   * graders; any other error leaves the other handles running. Returns either a final result
   * (nothing was judged) or the raw gate result that judgeVerdict finishes once EVERY gate of the
   * call has returned (QA-2.4-1).
   */
  const runClaimGate = async (
    entry: PendingEntry,
    prep: ClaimPreparation,
    deadline: OwnedDeadline,
    cfg: RouterConfig,
    callSignal: AbortSignal | undefined,
    lowPriority: boolean,
  ): Promise<ClaimGate> => {
    const dod = entry.dod;
    // A claimed entry is never released (release happens on a terminal settle only).
    if (dod === undefined) return { kind: "final", result: { verdict: unverifiableVerdict(ROUTER_VERIFY_RELEASED_REASON), retryable: false } };
    const strict = cfg.enforcement?.verify?.strictUnverifiable ?? false;
    const inFlight = new Set<string>();
    const completedFailures: string[] = [];
    const gateDeps = buildGateDeps(entry.orchestratorSessionID, inFlight, prep.prepared, deadline, lowPriority);
    gateDeps.deterministic.onFailure = reason => completedFailures.push(reason);
    const artefact = {
      changedFiles: prep.prepared.changedFiles,
      changeBaseline: prep.prepared.changeBaseline,
      // Not stored (R3): a testsPass DoD is deterministic, and no deterministic check reads it.
      finalReturnText: "",
      declaredOutputs: dod.deliverable ? [dod.deliverable] : [],
      producerSessionID: entry.producerSessionID,
      producerTier: entry.producerTier,
    };
    let res: GateResult;
    let timedOut = false;
    try {
      res = await withTimeout(
        accept({ dod, trivial: false, mode: "modeA", cwd: entry.cwd }, artefact, gateDeps),
        deadline.remaining(),
        "verification gate",
      );
    } catch (error) {
      timedOut = error instanceof RouterTimeoutError;
      if (timedOut) {
        deadline.abort("verification gate timed out");
        for (const gsid of inFlight) {
          try {
            await client.session.abort({ path: { id: gsid } });
          } catch (abortError) {
            logger.debug?.("[verify] router_verify could not abort a grader", { error: errorText(abortError) });
          }
        }
      }
      res = unverifiableGateResult(
        timedOut ? `verification gate timed out after ${deadline.budgetMs}ms` : `verification unavailable: ${errorText(error)}`,
        dod.source,
        strict,
        completedFailures,
      );
    }
    // verify.require "never" answers skipped: nothing was judged, so the entry stays unverified.
    if (res.verdict.skipped === true) return { kind: "final", result: { verdict: res.verdict, retryable: true } };
    // Decided on the gate's own verdict, before any router caveat (lineage, drift) is added.
    const retryable = isRetryableVerdict(res.verdict, timedOut || deadline.signal.aborted || callSignal?.aborted === true);
    return { kind: "gate", res, retryable, strict };
  };

  /** QA-2.4-1: the proven-introduced ids of a terminal gate fail (what a required gate records). */
  const introducedOf = (gate: ClaimGate): readonly string[] => {
    if (gate.kind !== "gate" || gate.retryable) return [];
    const outcome = gate.res.verdict.outcome ?? (gate.res.verdict.pass ? "pass" : "fail");
    return outcome === "fail" ? (gate.res.verdict.failures?.introduced ?? []) : [];
  };

  /**
   * 2.4.3a: one claimed entry's verdict from its raw gate result: R11 lineage, then the drift rule,
   * then the next tier. Runs only after every rejection of the call is in the ledger (QA-2.4-1).
   */
  const judgeVerdict = (entry: PendingEntry, prep: ClaimPreparation, gate: ClaimGate, cfg: RouterConfig): VerificationResult => {
    if (gate.kind === "final") return gate.result;
    const { strict, retryable } = gate;
    // QA-3.1-2 / QA-3.1-3: the dispatch's own context, recorded when the producer returned.
    const res = applyDispatchCaveats(
      lineageDowngrade(gate.res, { orchestratorSessionID: entry.orchestratorSessionID, root: prep.root, dispatchedAt: entry.dispatchedAt, strictUnverifiable: strict }),
      entry,
    );
    let verdict = res.verdict;
    if (prep.drift.kind !== "none") {
      // Section 1.5-18 and the owner's rule: a verdict on a tree that is not (provably) the
      // producer's never passes; it is unverifiable with the notice. A fail stays a fail.
      const notice = prep.drift.kind === "drifted" ? DRIFT_NOTICE : DRIFT_UNCHECKED_NOTICE;
      const outcome = verdict.outcome ?? (verdict.pass ? "pass" : "fail");
      verdict = gateResult(
        {
          ...verdict,
          ...(outcome === "pass" ? { pass: false, outcome: "unverifiable" as const } : {}),
          caveats: [...(verdict.caveats ?? []), notice],
        },
        res.dodSource,
        strict,
      ).verdict;
    }
    const judged = gateResult(verdict, res.dodSource, strict);
    const outcome = judged.verdict.outcome;
    let nextTier: string | undefined;
    if (!judged.accepted && outcome === "fail") {
      // index.ts's rule for the native path: the ladder's next tier after the producer's.
      const ladder = cfg.enforcement?.escalate?.ladder ?? ["fast", "medium", "heavy"];
      const li = ladder.findIndex(t => canonicalTier(t) === entry.producerTier);
      if (li >= 0 && li < ladder.length - 1) nextTier = ladder[li + 1];
    }
    const introduced = outcome === "fail" ? judged.verdict.failures?.introduced : undefined;
    return {
      verdict: judged.verdict,
      retryable,
      ...(introduced !== undefined && introduced.length > 0 ? { introduced } : {}),
      ...(prep.drift.kind === "drifted" ? { driftedPaths: prep.drift.paths } : {}),
      ...(nextTier !== undefined ? { nextTier } : {}),
    };
  };

  const verifyHandles: VerificationWiring["verifyHandles"] = async (sessionID, target, options = {}) => {
    let deadline: OwnedDeadline | undefined;
    const callSignal = options.signal;
    const onCallAbort = (): void => deadline?.abort(ROUTER_VERIFY_CANCELLED_REASON);
    try {
      // 1. Targets: normalized, deduped, capped (R2). `pending` = listOpen, so in-flight runs join.
      let targets: Array<{ readonly input: string; readonly handle: string | undefined }> = [];
      if (target.kind === "pending") {
        // QA-2.4-3: listPending adds the background verdicts not yet replayed (a cached replay, no run).
        if (sessionID !== "") targets = pending.listPending(sessionID, { verifying: true }).map(e => ({ input: e.handle, handle: e.handle }));
        if (targets.length === 0) return { items: [], excess: 0, text: ROUTER_VERIFY_NO_PENDING_TEXT };
      } else {
        const seen = new Set<string>();
        for (const raw of target.handles) {
          const input = typeof raw === "string" ? raw : "(not a string)";
          const handle = typeof raw === "string" ? normalizeHandle(raw) : undefined;
          const key = handle ?? `raw:${input}`;
          if (seen.has(key)) continue;
          seen.add(key);
          targets.push({ input, handle });
        }
      }
      const excess = Math.max(0, targets.length - MAX_HANDLES_PER_CALL);
      targets = targets.slice(0, MAX_HANDLES_PER_CALL);

      // 2. The call's one deadline (section 1.5-13), before any preparation.
      const cfg = getConfig();
      const budget = resolveVerifyBudget(cfg);
      const strict = cfg.enforcement?.verify?.strictUnverifiable ?? false;
      deadline = createDeadline(budget.gateBudgetMs);
      const owned = deadline;
      if (callSignal?.aborted === true) owned.abort(ROUTER_VERIFY_CANCELLED_REASON);
      else callSignal?.addEventListener("abort", onCallAbort, { once: true });

      // QA-2.4-5: router_verify is foreground work. A background run in flight is preempted, and
      // its claims settle (retryable) before this call claims, so no handle joins a run that is
      // being aborted. The wait is bounded by this call's deadline.
      if (options.background !== true && background !== undefined && targets.length > 0 && sessionID !== "") {
        await untilAborted(background.preempt(), owned.signal, () => undefined);
      }

      // 3. Claims (R8: synchronous, so two calls for one handle make one "claimed").
      type Claimed = Extract<ReturnType<PendingRegistry["markVerifying"]>, { kind: "claimed" }>;
      const claims: Claimed[] = [];
      const slots: Array<HandleReport | Promise<HandleReport> | { readonly claim: number }> = [];
      const cwds = new Map<string, string>();
      try {
        for (const t of targets) {
          if (t.handle === undefined || sessionID === "") {
            slots.push({ kind: "unknown", input: t.handle ?? t.input });
            continue;
          }
          const c = pending.markVerifying(sessionID, t.handle);
          if (c.kind === "unknown") slots.push({ kind: "unknown", input: t.handle });
          else if (c.kind === "expired") slots.push({ kind: "expired", handle: c.handle });
          else if (c.kind === "settled") {
            slots.push({ kind: "verdict", handle: c.entry.handle, description: c.entry.description, producerTier: c.entry.producerTier, via: "cached", result: c.result });
          } else if (c.kind === "joined") {
            const entry = c.entry;
            cwds.set(entry.handle, entry.cwd);
            slots.push(
              untilAborted<SettledVerification | undefined>(c.run, owned.signal, () => undefined).then((settled): HandleReport =>
                settled === undefined
                  ? { kind: "elsewhere", handle: entry.handle, description: entry.description }
                  : { kind: "verdict", handle: entry.handle, description: entry.description, producerTier: entry.producerTier, via: "joined", result: settled },
              ),
            );
          } else {
            cwds.set(c.entry.handle, c.entry.cwd);
            slots.push({ claim: claims.length });
            claims.push(c);
          }
        }
      } catch (error) {
        // Never leave a claim verifying until the reaper: settle what was claimed, retryable.
        for (const c of claims) c.settle({ verdict: unverifiableVerdict(`verification unavailable: ${errorText(error)}`), retryable: true });
        throw error;
      }

      // 4. Every preparation first, then every gate at once: the testsPass requests share the
      //    deadline and reach the S5 coordinator together (one window, one batch).
      const snapshots = new Map<string, Promise<TreeSnapshot | undefined>>();
      // QA-3.1-8: the current-tree snapshot at the configured priority; a background run's always low.
      const preparations = claims.map(c => prepareClaim(c.entry, owned, snapshots, budget.lowPriority || options.background === true));
      const allPrepared = Promise.allSettled(preparations);
      const gates = claims.map(async (c, i): Promise<{ readonly prep: ClaimPreparation | undefined; readonly gate: ClaimGate }> => {
        let prep: ClaimPreparation | undefined;
        try {
          prep = await preparations[i];
          await allPrepared;
          return { prep, gate: await runClaimGate(c.entry, prep, owned, cfg, callSignal, options.background === true) };
        } catch (error) {
          return { prep, gate: { kind: "final", result: { verdict: unverifiableVerdict(`verification unavailable: ${errorText(error)}`), retryable: true } } };
        }
      });
      // 5. QA-2.4-1: judged in two phases. A verdict of this call must see every rejection of this
      //    call, as it would across two calls or two required gates: (a) every gate returns;
      //    (b) every terminal fail with proven-introduced ids goes into the R11 ledger; (c) lineage,
      //    drift and the next tier are applied to every result; (d) every claim settles.
      const judged = (async (): Promise<void> => {
        const results: VerificationResult[] = claims.map(() => ({ verdict: unverifiableVerdict("verification unavailable: no verdict"), retryable: true }));
        try {
          const outcomes = await Promise.all(gates);
          outcomes.forEach(({ prep, gate }, i) => {
            const introduced = introducedOf(gate);
            const root = prep?.root;
            if (introduced.length === 0 || root === undefined) return;
            const entry = claims[i].entry;
            pending.recordRejection({ orchestratorSessionID: entry.orchestratorSessionID, root, label: entry.handle, landedAt: entry.createdAt, introduced });
          });
          outcomes.forEach(({ prep, gate }, i) => {
            if (prep !== undefined) results[i] = judgeVerdict(claims[i].entry, prep, gate, cfg);
            else if (gate.kind === "final") results[i] = gate.result;
            // QA-2.4-3: a background verdict that did not pass stays listed until it is replayed.
            if (options.background === true) results[i] = { ...results[i], background: true };
          });
        } catch (error) {
          for (let i = 0; i < results.length; i += 1) {
            results[i] = { verdict: unverifiableVerdict(`verification unavailable: ${errorText(error)}`), retryable: true };
          }
        } finally {
          // R4: single use, in a finally; false only when the claim was reaped or disposed.
          claims.forEach((c, i) => {
            if (!c.settle(results[i])) logger.debug?.("[verify] router_verify settled a claim that was already reaped", { handle: c.entry.handle });
          });
        }
      })();
      const runs = claims.map(async (c): Promise<HandleReport> => {
        await judged;
        const settled = await c.run;
        return { kind: "verdict", handle: c.entry.handle, description: c.entry.description, producerTier: c.entry.producerTier, via: "run", result: settled };
      });

      const items = await Promise.all(slots.map(s => ("claim" in s ? runs[s.claim] : s)));
      // 2.4.5: this caller receives these verdicts, so no late notice repeats them (R14), and a
      // background verdict among them leaves the pending list (QA-2.4-3). QA-2.4-17: only a
      // terminal verdict counts; a retryable "not judged" leaves a later background verdict to notice.
      if (options.background !== true) {
        const reported = items.flatMap(i => (i.kind === "verdict" && !i.result.retryable ? [i.handle] : []));
        background?.markReported(reported);
        pending.markReplayed(sessionID, reported);
      }
      return { items, excess, text: formatVerifyReport(items, excess, strict, h => cwds.get(h)) };
    } catch (error) {
      logger.warn("[verify] router_verify failed", { error: errorText(error) });
      return { items: [], excess: 0, text: `[router] router_verify failed; nothing was verified: ${errorText(error)}` };
    } finally {
      callSignal?.removeEventListener("abort", onCallAbort);
      deadline?.dispose();
    }
  };

  // 2.4.5 (section 1.5-19, pending.ts R14): only when `background` is true at plugin start. A run is
  // this instance's own verifyHandles, so it claims, gates, batches and settles exactly as
  // router_verify does, at low priority.
  if (pendingBudget.background) {
    background = createBackgroundQueue({
      ...deps.background,
      ttlMs: pendingBudget.pendingTtlMs,
      verify: async (sessionID, handles, signal) =>
        backgroundOutcomes((await verifyHandles(sessionID, { kind: "handles", handles }, { signal, background: true })).items),
      onError: error => logger.warn("[verify] background verification run failed", { error: errorText(error) }),
      // QA-2.4-5: no background run starts while foreground testsPass verification is active.
      busy: () => foreground.tests > 0,
    });
  }

  return {
    beginVerification,
    resolveDirectives,
    async startDispatch(store, id, cwd, dod, text, remember) {
      // VERIFY_WAIT counts from here, the dispatch's start (see boundedCaptureWait).
      const startedAt = Date.now();
      const start: DispatchStart = { directives: resolveDirectives(text), dispatchedAt: pendingNow() };
      if (remember) {
        dispatchStarts.delete(id);
        dispatchStarts.set(id, start);
        while (dispatchStarts.size > DISPATCH_STARTS_MAX) {
          const oldest = dispatchStarts.keys().next();
          if (oldest.done === true) break;
          dispatchStarts.delete(oldest.value);
        }
      }
      await boundedCaptureWait(store, id, cwd, dod, start.directives.waitMs, startedAt);
      return start;
    },
    takeDispatch(id, text) {
      const start = dispatchStarts.get(id);
      if (start !== undefined) {
        dispatchStarts.delete(id);
        return start;
      }
      return { directives: resolveDirectives(text), dispatchedAt: pendingNow() };
    },
    isDeferred(dod, directives, trivial = false) {
      if (directives.mode !== "deferred" || !hasTestsPass(dod)) return false;
      // QA-2.4-10: gate.ts skips exactly this case ("trivial dispatch; verification skipped").
      if (trivial && dod.source === "inferred") return false;
      try {
        return getConfig().enforcement?.verify?.require !== "never";
      } catch {
        return false;
      }
    },
    finishDeferred,
    applyLineage,
    verifyHandles,
    pending,
    background,
    beginVerificationBounded,
    startReferenceGc(delayMs = REFERENCE_GC_START_DELAY_MS) {
      if (!directory) {
        logger.debug?.("[verify] reference GC skipped: plugin root unknown");
        return () => undefined;
      }
      const stop = new AbortController();
      const run = (): void => {
        if (stop.signal.aborted) return;
        try {
          const budget = resolveVerifyBudget(getConfig());
          // Low priority (QA-1.2-13), and every git call dies with the plugin (dispose).
          const argv: ArgvSeam = (file, args, opts) => argvSeam(file, args, {
            ...opts,
            lowPriority: budget.lowPriority,
            signal: opts?.signal ? AbortSignal.any([opts.signal, stop.signal]) : stop.signal,
          });
          gcStaleReferences(directory, { argv, fs: nodeReferenceFs, logger }).then(
            report => {
              if (report.removed.length > 0) logger.debug?.("[verify] reference GC removed stale dirs", { removed: report.removed.length });
            },
            (err: unknown) => logger.warn("[verify] reference GC failed", { error: errorText(err) }),
          );
        } catch (err) {
          logger.warn("[verify] reference GC failed", { error: errorText(err) });
        }
      };
      const timer = setTimeout(run, Math.max(0, delayMs));
      timer.unref?.();
      return () => {
        clearTimeout(timer);
        stop.abort();
      };
    },
    async prepareVerification(store, id, childID, cwd, deadline) {
      const change = await observeChange(store, id, childID, cwd, deadline);
      const reference = await store.reference(id, deadline?.signal);
      return { ...change, reference };
    },
    graderSessions,
    disposeChildSession,
    dispatchGrader,
    buildGateDeps,
    sweepVerification: () => {
      // Native task starts whose after hook never came (the call was cancelled), past the idle TTL.
      const at = pendingNow();
      let evicted = 0;
      for (const [id, start] of [...dispatchStarts]) {
        if (at - start.dispatchedAt >= DEFAULT_IDLE_TTL_MS) {
          dispatchStarts.delete(id);
          evicted += 1;
        }
      }
      // 2.4.5: undelivered late notices past pendingTtlMs; also the queue's idle trigger.
      return evicted + coordinator.sweep() + (background?.sweep() ?? 0);
    },
    disposeVerification: () => {
      dispatchStarts.clear();
      // 2.4.5: abort the background run first, so nothing re-queues while the coordinator stops.
      background?.dispose();
      return coordinator.dispose();
    },
  };
}
