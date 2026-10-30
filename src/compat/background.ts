/**
 * Background-first dispatch (Phase 2.1, memo §2.1): the policy, the in-flight registry, the completion
 * processor, the held-result machinery and the lease guard of the Claude Code v2 adapter.
 *
 * Nothing here runs at load: every function is pure or driven through injected seams (journal, synthetic
 * posting, clock, logger). Claude Code v1 never imports a behaviour from this module.
 */
import type { DurationEstimate } from "../routing/outcomes/durations";
import { createLeaseRegistry, foldKeyPath, formatRunNote } from "../router/leases";
import type { LeaseActor, LeaseRegistry, LeaseSeams, Holder, HolderInput } from "../router/leases";
import { toolTargets } from "../router/tool-paths";
import { observeV2, type V2Observations } from "./v2-observations";

// ---- constants -------------------------------------------------------------------------------

/** Quiet period after a child's end event before the processor reads the child's result. */
export const COMPLETION_SETTLE_MS = 2000;
/** Live attempts (decided, acknowledged or processing) the registry tracks. */
export const MAX_LIVE_ATTEMPTS = 1000;
/** Call records kept between `decide` and the acknowledgement. */
export const MAX_CALL_RECORDS = 1000;
/** Child ends seen before their acknowledgement (= timings MAX_UNBOUND_OUTCOMES). */
export const MAX_EARLY_ENDS = 200;
/** Lifetime of an early end (= timings UNBOUND_OUTCOME_TTL_MS). */
export const EARLY_END_TTL_MS = 10 * 60_000;
/** Idempotency keys remembered (= timings MAX_SEEN_EVENT_IDS). */
export const MAX_PROCESSED_KEYS = 5000;
/** An attempt open longer than this is closed as unknown (= timings OPEN_START_TTL_MS). */
export const ATTEMPT_SWEEP_AGE_MS = 6 * 3600_000;
export const MAX_COMPLETED_PER_PARENT = 32;
export const MAX_COMPLETED_PARENTS = 1000;
export const MAX_HOLDS_PER_PARENT = 256;
export const MAX_HOLDS_GLOBAL = 10_000;

/**
 * Attach channel: the legacy plugin (index.ts) defines it non-enumerable on its hooks object; v2-hooks calls it
 * once at setup. It lives here, never in `main` (QA-1.2-1).
 */
export const ROUTER_FINISH_ATTACH: unique symbol = Symbol.for("router.finishDispatch.attach");

// ---- D1 policy -------------------------------------------------------------------------------

export type BackgroundMode = "auto" | "model" | "off";
export type VerificationMode = "required" | "deferred" | "none";

export interface BackgroundInput {
  mode: BackgroundMode;
  /** Only a boolean `background` argument counts. */
  explicit: boolean | undefined;
  /** TASK_VERIFICATION is set for the call (v2-hooks.ts:1652). */
  verifying: boolean;
  /** `FinishApi.verificationFor(callID)`. */
  verificationMode: VerificationMode;
  /** Today's `roleForeground`: the call was routed to a role. */
  roleRouted: boolean;
  estimate: DurationEstimate | undefined;
  /** `routing.background.minPredictedMs`. */
  minPredictedMs: number;
  /** DURATION_MIN_SAMPLES (durations.ts:34). */
  minSamples: number;
  acceptance: { testsPass: boolean; buildPasses: boolean };
  /** Seam; false in 2.1 (launcher A bypasses execute.before, D14). */
  planTask: boolean;
  /** `HeldResults.available && FinishApi.canHold(parent) && holds under cap`. */
  holdingAvailable: boolean;
  parentIsRoot: boolean;
  /** `InFlightRegistry.liveCount()`. */
  liveCount: number;
}

export type BackgroundReason =
  | "off" | "model-unset" | "child-parent" | "cap" | "explicit" | "explicit-no-holding"
  | "estimate" | "acceptance" | "plan-task" | "no-holding" | "short" | "prior";

export interface BackgroundDecision {
  /** The value for the native `background` argument; `undefined` = send no key. */
  background: boolean | undefined;
  /** The result is held until its verdict arrives. */
  hold: boolean;
  reason: BackgroundReason;
}

/**
 * The D1 policy (memo §6): decides whether a `subagent` call runs in the background and whether its result is
 * held for verification. Pure; the first matching row of the table wins.
 */
export function decideBackground(input: BackgroundInput): BackgroundDecision {
  // Row 1: the value every "not selected" row falls back to; byte-identical to today's `nativeArgs`.
  const legacy: boolean | undefined = input.verifying || input.roleRouted ? false : undefined;
  const needsHold = input.verificationMode === "required";
  if (input.mode === "off") return { background: legacy, hold: false, reason: "off" };
  if (!input.parentIsRoot) return { background: legacy, hold: false, reason: "child-parent" };
  if (input.liveCount >= MAX_LIVE_ATTEMPTS) return { background: legacy, hold: false, reason: "cap" };
  if (input.explicit === true) {
    if (needsHold && !input.holdingAvailable) return { background: false, hold: false, reason: "explicit-no-holding" };
    return { background: true, hold: needsHold, reason: "explicit" };
  }
  if (input.explicit === false) return { background: false, hold: false, reason: "explicit" };
  if (input.mode === "model") return { background: legacy, hold: false, reason: "model-unset" };

  // auto
  let selected: BackgroundReason | undefined;
  const est = input.estimate;
  if (est !== undefined && est.source !== "prior" && est.n >= input.minSamples && est.p50 >= input.minPredictedMs) {
    selected = "estimate";
  } else if (input.acceptance.testsPass || input.acceptance.buildPasses) {
    selected = "acceptance";
  } else if (input.planTask) {
    selected = "plan-task";
  }
  if (selected !== undefined) {
    if (needsHold && !input.holdingAvailable) return { background: false, hold: false, reason: "no-holding" };
    return { background: true, hold: needsHold, reason: selected };
  }
  // Not selected: a role dispatch with a thin store gets no key (role-spikes update).
  const unselected: boolean | undefined = input.verifying ? false : undefined;
  return { background: unselected, hold: false, reason: est !== undefined && est.source === "prior" ? "prior" : "short" };
}

// ---- shared seams ----------------------------------------------------------------------------

/** The logging seam. Structurally compatible with the adapter's ingest logger. */
export interface Logger {
  warn(message: string, meta?: object): void;
  debug?(message: string, meta?: object): void;
}

/** Logs through `logger`, never throwing (a logger fault must not fail a request). */
function warnSafe(logger: Logger, message: string, meta?: object): void {
  try {
    logger.warn(message, meta);
  } catch (error) {
    // A broken logger is the one failure with nowhere to report to; keep the caller alive.
    void error;
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Posts a synthetic message into a session (`ctx.session.synthetic`); injected, never imported. */
export type SyntheticFn = (input: {
  sessionID: string;
  text: string;
  description: string;
  metadata: Record<string, unknown>;
  resume: boolean;
}) => Promise<unknown>;

/** A record in the persistence journal (memo §11.1); the shape is owned by `src\verify\pending.ts`. */
export type PersistedRecord = { v: 1; kind: string } & Record<string, unknown>;

/** The append-only journal seam (memo §11.2). Absent persistence is a journal that accepts and forgets. */
export interface InflightJournal {
  append(record: PersistedRecord, opts?: { fsync?: boolean }): Promise<void>;
  /** True when the journal holds a `processed` record for the idempotency key (§10). */
  hasProcessed(key: string): boolean;
}

// ---- finish API (memo §2.2; implemented by index.ts, attached through ROUTER_FINISH_ATTACH) ---------

export interface FinishInput {
  callID: string;
  parentSessionID: string;
  childSessionID: string;
  /** The child's final text (defanged for role children). */
  outputText: string;
  status: "succeeded" | "failed" | "interrupted" | "unknown";
  mode: "foreground" | "background";
  heldHandle?: string;
  endedAt: number;
  /** The change set computed at child end (verify/dispatch.ts, 2.1.4.b); opaque here. */
  delta?: unknown;
  /**
   * QA-2.1-17: set on a finish after a restart (an adopted `inflight` record, a restored hold): the dispatch as journaled
   * with its record. A restart lost the in-memory call arguments and change set, so the plugin rebuilds the gate inputs from
   * this and from the restored pending entry (its DoD and changed files), re-posts a verdict reached before the restart, and
   * ends UNVERIFIABLE ("verification data lost in restart") when the data is missing. Absent on a live finish.
   */
  restored?: RestoredDispatch;
}

/**
 * QA-PDF12-9: the caller of the dispatch a completion finishes, from the attempt the completion processor holds (never a
 * capped lookup by call id), so the finish seam runs the graders as that caller.
 */
export interface FinishCaller {
  callerAgent?: string;
  callerMessageID?: string;
}

/**
 * QA-2.1-17: the dispatch data journaled with an `inflight` and a `hold` record (field `dispatch`), from `FinishApi.dispatchOf`.
 * Any field may be missing (an older record, or a dispatch the plugin did not see).
 */
export interface RestoredDispatch {
  prompt?: string;
  description?: string;
  subagentType?: string;
  /** The directory the dispatch ran in (`args.cwd`, else the plugin's project directory). */
  cwd?: string;
  /** The work root the dispatch named (`root=`), when there was one. */
  workRoot?: string;
  /**
   * QA-SYNC1-13: the routed-role record of a role dispatch, as far as its gate needs it (the live record is in memory only).
   * Absent on a tier dispatch, on an older record, and when the journaled snapshot is malformed.
   */
  routed?: RoutedRoleSnapshot;
}

/**
 * QA-SYNC1-13: what a role dispatch's gate reads of its routed-role record (`RoleRouted`): the verification root, the parent
 * (the role's read set), and whether the dispatch is a resume that carries an earlier attempt's acceptance, with the child.
 */
export interface RoutedRoleSnapshot {
  readonly verifyRoot: string;
  readonly parentSessionID: string;
  readonly carried?: true;
  /** Gating lowered this dispatch's final floor; UNVERIFIABLE at return also records its raise. Absent for strict children. */
  readonly gated?: true;
  readonly resumeID: string | null;
}

const ROUTED_SNAPSHOT_KEYS: ReadonlySet<string> = new Set(["verifyRoot", "parentSessionID", "carried", "gated", "resumeID"]);

/**
 * QA-SYNC1-13: the journaled routed-role snapshot, validated strictly: a plain object with only the known keys, a non-empty
 * `verifyRoot`, a string `parentSessionID`, `resumeID` a non-empty string or null, `carried` absent or `true` (and only with a
 * `resumeID`), `gated` absent or `true`. Anything else is malformed: undefined, and the record is dropped (never a partial or
 * a guessed snapshot).
 * Pure; never throws.
 */
export function routedRoleSnapshotOf(value: unknown): RoutedRoleSnapshot | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (Object.keys(value).some((key) => !ROUTED_SNAPSHOT_KEYS.has(key))) return undefined;
  const verifyRoot: unknown = Reflect.get(value, "verifyRoot");
  const parentSessionID: unknown = Reflect.get(value, "parentSessionID");
  const resumeID: unknown = Reflect.get(value, "resumeID");
  const carried: unknown = Reflect.get(value, "carried");
  const gated: unknown = Reflect.get(value, "gated");
  if (typeof verifyRoot !== "string" || verifyRoot === "") return undefined;
  // An empty parent is the dispatch module's own "no orchestrator" value (roleReadSetFor reads it as no read set).
  if (typeof parentSessionID !== "string") return undefined;
  if (resumeID !== null && (typeof resumeID !== "string" || resumeID === "")) return undefined;
  if (carried !== undefined && (carried !== true || resumeID === null)) return undefined;
  if (gated !== undefined && gated !== true) return undefined;
  return { verifyRoot, parentSessionID, resumeID, ...(carried === true ? { carried: true as const } : {}), ...(gated === true ? { gated: true as const } : {}) };
}

/** QA-2.1-17: the `dispatch` field of a journaled record, keeping only string fields. Pure; never throws. */
export function restoredDispatchOf(value: unknown): RestoredDispatch {
  if (value === null || typeof value !== "object") return {};
  const out: RestoredDispatch = {};
  const read = (key: "prompt" | "description" | "subagentType" | "cwd" | "workRoot"): void => {
    const field: unknown = Reflect.get(value, key);
    if (typeof field === "string") out[key] = field;
  };
  read("prompt");
  read("description");
  read("subagentType");
  read("cwd");
  read("workRoot");
  // QA-SYNC1-13: a malformed routed-role snapshot is dropped (the gate then runs without it, as on an older record).
  const routed = routedRoleSnapshotOf(Reflect.get(value, "routed"));
  if (routed !== undefined) out.routed = routed;
  return out;
}

export type FinishResult = {
  /** What the foreground path writes into `output.output`. */
  outputText: string;
  /** `outputText` minus the child's text: router lines only. */
  suffix: string;
  verification:
    | { kind: "none" }
    | { kind: "deferred"; handle: string }
    | { kind: "held"; handle: string }
    | { kind: "required"; verdict: "PASS" | "FAIL" | "UNVERIFIABLE" };
  metadata: Record<string, unknown>;
};

export interface FinishApi {
  verificationFor(callID: string): { mode: VerificationMode; acceptance: { testsPass: boolean; buildPasses: boolean } } | undefined;
  /** A pending slot exists (MAX_ENTRIES_PER_SESSION / MAX_ENTRIES_GLOBAL). */
  canHold(parentSessionID: string): boolean;
  /** `pending.reserveHandle`. */
  reserveHeld(parentSessionID: string, callID: string): string | undefined;
  /**
   * `pending.releaseHandle` (QA-2.1-3, QA-2.1-4): gives a reserved handle back when its attempt ends without a held register
   * (the hold write failed, the child failed or was interrupted, the attempt was closed unknown). Idempotent. A reservation
   * that is never given back expires after `HELD_RESERVATION_TTL_MS` (verify/pending.ts).
   */
  releaseHeld(handle: string): void;
  /**
   * QA-2.1-31: a restored hold's verdict was posted (or found posted) by the adapter directly, not through the plugin's
   * gate: the restored pending entry of `handle` is settled with it, without a second post, so `router_verify` stops
   * saying the verdict follows. Unknown or already settled handles are ignored.
   */
  settleHeldDirect(parentSessionID: string, handle: string, verdict: { verdict: "PASS" | "FAIL" | "UNVERIFIABLE"; reason?: string }): void;
  /**
   * QA-2.1-17: the journal-able dispatch data of a live `task` call (prompt, description, subagent type, cwd, work root),
   * written with its `inflight` and `hold` records; undefined when the plugin does not know the call.
   */
  dispatchOf(callID: string): RestoredDispatch | undefined;
  finish(input: FinishInput): Promise<FinishResult>;
  /**
   * The ONE journal (memo §11): `pending.jsonl`, shared by the pending store, the in-flight registry and the held results.
   * `inflight` and `hold` appends are fsync'd by the caller (`{fsync: true}`).
   */
  journal: InflightJournal;
  /**
   * The change set of a dispatch at child end (verify/dispatch.ts `captureDelta`, 2.1.4.b); absent = none. QA-2.1-7:
   * `dispatchID` is the change-set key `task:<parent>:<callID>`; absent, the implementation derives it from the call id.
   */
  captureDelta?(callID: string, childSessionID: string, dispatchID?: string): Promise<unknown>;
  /**
   * Memo §4.1 step 3 / §11.3: reloads `pending.jsonl` (parsed per line, folded by key, TTL applied) and keeps the surviving
   * records dormant. Rejects when the file cannot be read (the caller then fails closed, §12).
   */
  reload(): Promise<void>;
  /**
   * QA-2.1-16: rewrites a vanished `pending.jsonl` from in-memory state: the plugin's live pending entries (and their
   * verdicts), its dormant records, and `records` (the caller's live `inflight` attempts, holds with their `hold-text` and
   * `posting` lines, and its own dormant records). QA-2.1-33: plus the same snapshot of every other plugin instance of this
   * process on the same journal, each record once, so one instance's rewrite never drops another's records. Afterwards
   * appends and reloads succeed again. Rejects when the rewrite fails (the caller stays fail closed and may retry).
   */
  recreateJournal(records: readonly PersistedRecord[]): Promise<void>;
  /**
   * QA-2.1-33: registers the adapter's snapshot of its live records (the `records` it passes to `recreateJournal`), so a
   * `recreate` of the shared journal by ANOTHER plugin instance of this process writes them too. Absent: only this
   * adapter's own `recreateJournal` calls carry them.
   */
  setAdapterSnapshot?(provider: () => readonly PersistedRecord[]): void;
  /**
   * QA-2.1-21: resolves once the held gates the plugin started (`finish` with a held handle runs its gate without awaiting
   * it) and their verdict posts have ended, including gates started meanwhile. The adapter's settled seam and `dispose`
   * wait for it. Never rejects.
   */
  idle(): Promise<void>;
  /**
   * Memo §11.3: this process saw `sessionID`. Takes the exclusive claim file `pending.claims\<id>` and hands over the dormant
   * records of that session; `undefined` when there are none. QA-2.1-34: `ADOPTION_REFUSED` when another live instance holds
   * the claim: its records stay dormant and the caller tries again at a later sighting (rate-limited,
   * `ADOPTION_RETRY_MS`). Synchronous.
   */
  adopt(sessionID: string): AdoptedRecords | AdoptionRefused | undefined;
}

/** QA-2.1-34: `FinishApi.adopt` found dormant records but another live instance holds the session's claim. */
export interface AdoptionRefused {
  readonly refused: true;
}

/** QA-2.1-34: the one refusal value of `FinishApi.adopt`. */
export const ADOPTION_REFUSED: AdoptionRefused = Object.freeze({ refused: true });

/** QA-2.1-34: a refused adoption is tried again at a sighting at least this long after the last attempt (per session). */
export const ADOPTION_RETRY_MS = 30_000;

/** QA-2.1-34: whether an `adopt` result is a refusal (not adopted records, not "nothing to adopt"). Pure. */
export function isAdoptionRefused(result: AdoptedRecords | AdoptionRefused | undefined): result is AdoptionRefused {
  return result !== undefined && "refused" in result && result.refused;
}

/** The reloaded records of one adopted parent session (memo §11.3). */
export interface AdoptedRecords {
  /** `hold` records not yet posted or forgotten (for `HeldResults.restore`). */
  holds: readonly PersistedRecord[];
  /** `inflight` records without a `processed` record (for recovery). */
  inflight: readonly PersistedRecord[];
}

export type FinishAttach = (deps: {
  host: "v2";
  held: HeldSink;
  /** The lease gate before plugin verification runs (memo §2.5); absent when `routing.leases.mode` is not `enforce`. */
  leaseGate?: Pick<LeaseGuard, "waitTreeFree">;
}) => FinishApi | undefined;

// ---- in-flight registry ----------------------------------------------------------------------

export type AttemptState =
  | "decided" | "acknowledged" | "child-ended" | "processing" | "annotated" | "held" | "verdict"
  | "released" | "foreground" | "cancelled" | "closed-unknown";

export interface CallRecord {
  callID: string;
  parentSessionID: string;
  /** The DISPATCHED agent (`output.args.agent`). */
  agent: string;
  /**
   * DF-1.1-1: the CALLER (orchestrator) agent that made the `subagent` call. The completion finish (grader launch) runs
   * as this agent: the host checks the caller's `subagent:<grader>` permission, never the dispatched child's.
   * Absent for a record journaled before this field existed.
   */
  callerAgent?: string;
  /**
   * QA-PDF12-5: the id of the caller's message that made the `subagent` call, so the completion finish runs in a context with
   * the call's real ids (never an empty message id). Absent for a record journaled before this field existed.
   */
  callerMessageID?: string;
  role?: string;
  description: string;
  verifying: boolean;
  verificationMode: VerificationMode;
  decision: BackgroundDecision;
  resumeOf?: string;
  at: number;
  /**
   * 3.1.7 W5: an attempt the plan executor registered (`DispatchBookkeeping.registerInFlight`). It is excluded from the ordinary
   * completion and verification path: its launch completion is its only settle point, submitted as a `runner` trigger.
   */
  owner?: "executor";
}

export interface Attempt extends CallRecord {
  /** `${childSessionID}\u0000${callID}` (memo §10). */
  key: string;
  childSessionID: string;
  state: AttemptState;
  userBackgrounded: boolean;
  hold?: { handle: string };
  ackAt?: number;
  endedAt?: number;
  outcome?: "succeeded" | "failed" | "interrupted" | "unknown";
  annotations: string[];
  pendingShown: boolean;
  waitedOnce: boolean;
  shownInTurn?: number;
}

export interface EndFact {
  outcome: "succeeded" | "failed" | "interrupted";
  eventID: string;
  at: number;
}

export interface InFlightRegistry {
  /** execute.before (subagent). `false`: another instance claimed this callID (process-wide set, like `claimCall`). */
  decide(rec: CallRecord): boolean;
  acknowledge(callID: string, child: string, ack: { userBackgrounded: boolean; hold?: { handle: string } }): Attempt | undefined;
  /** A completed (non-running) result: terminal for the processor. */
  foreground(callID: string, child: string | null): void;
  /** Error, null child or `onCallFinished`. */
  cancel(callID: string): void;
  /** The newest attempt of the child. */
  byChild(child: string): Attempt | undefined;
  byCall(callID: string): CallRecord | Attempt | undefined;
  /** An end seen before the acknowledgement; bounded, with a TTL. */
  noteEarlyEnd(child: string, end: EndFact): void;
  takeEarlyEnd(child: string): EndFact | undefined;
  listForParent(parent: string): readonly Attempt[];
  /** QA-2.1-16: every attempt this registry knows (any parent, any state). */
  list(): readonly Attempt[];
  liveCount(): number;
  forgetSession(sessionID: string): void;
  /** Open for longer than `ATTEMPT_SWEEP_AGE_MS` becomes `closed-unknown`; the closed attempts are returned. */
  sweep(now: number): readonly Attempt[];
  /** Gives this instance's process-wide call claims back (plugin dispose / reload, QA-2.1-13). */
  dispose(): void;
}

/** QA-2.1-13: a background decision counts as live this long while it waits for its acknowledgement. */
export const DECIDED_LIVE_MS = EARLY_END_TTL_MS;

/** Why the registry closed an open attempt without an end (the owner posts the verdict of a held one). */
export type CloseCause = "superseded" | "sweep";

const OPEN_STATES: ReadonlySet<AttemptState> = new Set<AttemptState>(["acknowledged", "child-ended", "processing", "held"]);
const TERMINAL_STATES: ReadonlySet<AttemptState> = new Set<AttemptState>(["released", "foreground", "cancelled", "closed-unknown"]);

/** Process-wide call claims (`bg:<callID>`), shared by every plugin instance of the process; bounded. */
export const MAX_CLAIMS = 1000;
/** QA-PDF12-13: the bound of the whole shared set, whichever instances own its claims. */
export const MAX_PROCESS_CLAIMS = 8 * MAX_CLAIMS;

/**
 * DF-1.1-1: the plugin can be loaded as several module copies in one process (one per booted host location), and a
 * module-level set would then be one set per copy, so two copies would both claim a callID and complete it twice. The
 * set lives on `globalThis` under a versioned registry key instead, so every copy shares it.
 */
const PROCESS_CLAIMS_KEY = Symbol.for("opencode-model-router.background-claims.v1");
function processClaims(): Set<string> {
  const registry = globalThis as unknown as Record<symbol, Set<string> | undefined>;
  const existing = registry[PROCESS_CLAIMS_KEY];
  if (existing instanceof Set) return existing;
  const created = new Set<string>();
  Object.defineProperty(globalThis, PROCESS_CLAIMS_KEY, { value: created, configurable: true, enumerable: false, writable: true });
  return created;
}

/** The attempt key (memo §10). */
export function attemptKey(childSessionID: string, callID: string): string {
  return `${childSessionID}\u0000${callID}`;
}

/** Index a history once; keep the first occurrence, as the boundary lookup's former `findIndex` did. */
export function indexMessageIDs(messages: readonly unknown[]): ReadonlyMap<string, number> {
  const indices = new Map<string, number>();
  messages.forEach((message, index) => {
    const id: unknown = message !== null && typeof message === "object" ? Reflect.get(message, "id") : undefined;
    if (typeof id === "string" && !indices.has(id)) indices.set(id, index);
  });
  return indices;
}

/** A completion at or before the message dispatching an attempt belongs to an earlier turn, even if never scanned before. */
export function precedesDispatch(messageIndices: ReadonlyMap<string, number>, index: number, callerMessageID: string | undefined): boolean {
  if (callerMessageID === undefined) return false;
  // An absent caller may have been compacted out before OR after these messages; its position cannot be inferred safely.
  const caller = messageIndices.get(callerMessageID);
  return caller !== undefined && caller >= index;
}

/** 3.1.7 W5: the record belongs to the plan executor (excluded from the ordinary completion and verification path). */
export function isExecutorOwned(rec: CallRecord | undefined): boolean {
  return rec?.owner === "executor";
}

function isAttempt(rec: CallRecord | Attempt): rec is Attempt {
  return "key" in rec;
}

/** Evicts the oldest entries of an insertion-ordered map until it holds at most `max`, preferring entries `prefer` accepts. */
function trimMap<K, V>(map: Map<K, V>, max: number, prefer: (value: V) => boolean, onEvict?: (key: K, value: V) => void): void {
  if (map.size <= max) return;
  for (const pass of [true, false]) {
    for (const [key, value] of map) {
      if (map.size <= max) return;
      if (pass && !prefer(value)) continue;
      map.delete(key);
      onEvict?.(key, value);
    }
  }
}

/**
 * Creates the in-flight registry (memo §3, §10). Every collection is bounded. `claims` defaults to the
 * process-wide set; tests pass their own.
 */
export function createInFlightRegistry(deps: {
  now(): number;
  logger: Logger;
  claims?: Set<string>;
  onClosed?(attempt: Attempt, cause: CloseCause): void;
}): InFlightRegistry {
  const claims = deps.claims ?? processClaims();
  /** QA-2.1-13: the claims this instance added, so `forgetSession` and `dispose` give exactly those back. */
  const own = new Set<string>();
  function releaseClaim(callID: string): void {
    const claim = `bg:${callID}`;
    if (own.delete(claim)) claims.delete(claim);
  }
  const calls = new Map<string, CallRecord | Attempt>();
  const attempts = new Map<string, Attempt>();
  const newestByChild = new Map<string, string>();
  const earlyEnds = new Map<string, { end: EndFact; seen: number }>();

  function dropAttempt(key: string): void {
    const a = attempts.get(key);
    if (a === undefined) return;
    attempts.delete(key);
    if (newestByChild.get(a.childSessionID) === key) newestByChild.delete(a.childSessionID);
  }

  function enforceBounds(): void {
    trimMap(calls, MAX_CALL_RECORDS, (rec) => isAttempt(rec) && TERMINAL_STATES.has(rec.state), (_id, rec) => {
      if (isAttempt(rec)) dropAttempt(rec.key);
    });
  }

  function closeOpen(a: Attempt, cause: CloseCause): void {
    a.state = "closed-unknown";
    a.outcome = "unknown";
    try {
      deps.onClosed?.(a, cause);
    } catch (error) {
      warnSafe(deps.logger, "[router] background close handler failed", { error: errorText(error) });
    }
  }

  function makeAttempt(rec: CallRecord, child: string, state: AttemptState): Attempt {
    const attempt: Attempt = {
      ...rec,
      key: attemptKey(child, rec.callID),
      childSessionID: child,
      state,
      userBackgrounded: false,
      annotations: [],
      pendingShown: false,
      waitedOnce: false,
    };
    attempts.set(attempt.key, attempt);
    newestByChild.set(child, attempt.key);
    calls.set(rec.callID, attempt);
    return attempt;
  }

  return {
    decide(rec) {
      const claim = `bg:${rec.callID}`;
      if (claims.has(claim)) return false;
      claims.add(claim);
      own.add(claim);
      // QA-PDF12-6: the cap is per owner. An instance evicts only its own oldest claims, never a live claim of another copy
      // sharing the process-wide set (which is then bounded by MAX_CLAIMS per live instance).
      for (const old of own) {
        if (own.size <= MAX_CLAIMS) break;
        own.delete(old);
        claims.delete(old);
      }
      // QA-PDF12-13: a process-wide backstop past the per-owner cap: the oldest claims of ANY owner go once the shared set
      // outgrows MAX_PROCESS_CLAIMS (leaked claims of instances that never disposed cannot grow it without bound).
      for (const old of claims) {
        if (claims.size <= MAX_PROCESS_CLAIMS) break;
        claims.delete(old);
        own.delete(old);
      }
      calls.set(rec.callID, rec);
      enforceBounds();
      return true;
    },

    acknowledge(callID, child, ack) {
      const rec = calls.get(callID);
      if (rec === undefined) return undefined;
      if (isAttempt(rec)) return rec.childSessionID === child ? rec : undefined;
      // A resume: the previous open attempt of the child is closed unknown; the new one owns the next end (R12).
      const previousKey = newestByChild.get(child);
      const previous = previousKey === undefined ? undefined : attempts.get(previousKey);
      if (previous !== undefined && OPEN_STATES.has(previous.state)) closeOpen(previous, "superseded");
      const attempt = makeAttempt(rec, child, "acknowledged");
      attempt.userBackgrounded = ack.userBackgrounded;
      if (ack.hold !== undefined) attempt.hold = { handle: ack.hold.handle };
      attempt.ackAt = deps.now();
      enforceBounds();
      return attempt;
    },

    foreground(callID, child) {
      const rec = calls.get(callID);
      if (child !== null) earlyEnds.delete(child);
      if (rec === undefined) return;
      if (isAttempt(rec)) {
        if (OPEN_STATES.has(rec.state) || rec.state === "decided") rec.state = "foreground";
        return;
      }
      if (child === null) {
        calls.delete(callID);
        return;
      }
      makeAttempt(rec, child, "foreground");
      enforceBounds();
    },

    cancel(callID) {
      const rec = calls.get(callID);
      if (rec === undefined) return;
      if (isAttempt(rec)) {
        if (!TERMINAL_STATES.has(rec.state)) rec.state = "cancelled";
        return;
      }
      calls.delete(callID);
    },

    byChild(child) {
      const key = newestByChild.get(child);
      return key === undefined ? undefined : attempts.get(key);
    },

    byCall(callID) {
      return calls.get(callID);
    },

    noteEarlyEnd(child, end) {
      earlyEnds.delete(child);
      // The TTL runs on this process's clock from the moment the end was parked, not on the host event's own timestamp.
      earlyEnds.set(child, { end, seen: deps.now() });
      trimMap(earlyEnds, MAX_EARLY_ENDS, () => false);
    },

    takeEarlyEnd(child) {
      const parked = earlyEnds.get(child);
      if (parked === undefined) return undefined;
      earlyEnds.delete(child);
      // DF-1-4: an end parked before a resume of the child was decided ended an earlier turn, never the resumed one: it is
      // dropped, and the attempt waits for its own end.
      const newestKey = newestByChild.get(child);
      const newest = newestKey === undefined ? undefined : attempts.get(newestKey);
      if (newest?.resumeOf === child && parked.seen < newest.at) return undefined;
      return deps.now() - parked.seen > EARLY_END_TTL_MS ? undefined : parked.end;
    },

    listForParent(parent) {
      const out: Attempt[] = [];
      for (const a of attempts.values()) if (a.parentSessionID === parent) out.push(a);
      return out;
    },

    list() {
      return [...attempts.values()];
    },

    liveCount() {
      let n = 0;
      const at = deps.now();
      for (const rec of calls.values()) {
        if (isAttempt(rec)) {
          if (OPEN_STATES.has(rec.state)) n += 1;
        } else if (rec.decision.background === true && at - rec.at <= DECIDED_LIVE_MS) {
          // QA-2.1-13: only a fresh background decision awaits its acknowledgement; a foreground one or a stale one is not live.
          n += 1;
        }
      }
      return n;
    },

    forgetSession(sessionID) {
      for (const [callID, rec] of calls) {
        if (rec.parentSessionID === sessionID || (isAttempt(rec) && rec.childSessionID === sessionID)) {
          calls.delete(callID);
          releaseClaim(callID);
          if (isAttempt(rec)) dropAttempt(rec.key);
        }
      }
      earlyEnds.delete(sessionID);
    },

    dispose() {
      // QA-2.1-13: a disposed instance (a reload) gives its process-wide call claims back.
      for (const claim of own) claims.delete(claim);
      own.clear();
    },

    sweep(now) {
      const closed: Attempt[] = [];
      for (const a of attempts.values()) {
        if (!OPEN_STATES.has(a.state)) continue;
        if (now - (a.ackAt ?? a.at) <= ATTEMPT_SWEEP_AGE_MS) continue;
        closeOpen(a, "sweep");
        closed.push(a);
      }
      for (const [child, parked] of earlyEnds) if (now - parked.seen > EARLY_END_TTL_MS) earlyEnds.delete(child);
      for (const [callID, rec] of calls) {
        if (!isAttempt(rec) && now - rec.at > ATTEMPT_SWEEP_AGE_MS) {
          calls.delete(callID);
          releaseClaim(callID);
        }
      }
      return closed;
    },
  };
}

// ---- held results (memo §5, §7) ----------------------------------------------------------------

export type HeldVerdict = { verdict: "PASS" | "FAIL" | "UNVERIFIABLE"; text: string; reason?: string };

export interface HeldSink {
  verdict(handle: string, v: HeldVerdict): Promise<void>;
}

export interface HeldRecord {
  handle: string;
  parentSessionID: string;
  childSessionID: string;
  callID: string;
  /** `<role> "<description>"`, for the "held" provider. */
  label?: string;
  /** The completion body known to the owner (persisted digest or child text); lets the matcher cut precisely. */
  body?: string;
  /** The child's final text, persisted with the hold so a restart can re-run the gate (QA-2.1-6). */
  childText?: string;
  /** QA-2.1-17: the dispatch data (`FinishApi.dispatchOf`), persisted with the hold so a restart can rebuild the gate inputs. */
  dispatch?: RestoredDispatch;
  /** DF-1.1-1: the CALLER agent of the dispatch, persisted so a restored hold launches its grader as the caller. Absent in an old entry. */
  callerAgent?: string;
  /** QA-PDF12-5: the caller's message that made the dispatch, persisted with the hold. Absent in an old entry. */
  callerMessageID?: string;
}

/** A restored hold whose verdict was being posted (`posting` without `posted`): re-post after a parent check (R21). */
export interface RestoredPosting {
  handle: string;
  parentSessionID: string;
  childSessionID: string;
  text: string;
}

/** A restored hold with no verdict yet: the gate runs again at adoption (R20, QA-2.1-6). */
export interface RestoredHold {
  handle: string;
  parentSessionID: string;
  childSessionID: string;
  callID: string;
  /** Present only when the child succeeded: `hold-text` is journaled for succeeded children only (QA-2.1-17). */
  childText?: string;
  /** QA-2.1-17: the dispatch data journaled with the hold (empty fields when an older record had none). */
  dispatch: RestoredDispatch;
  /** DF-1.1-1: the caller agent journaled with the hold; absent for an older record. */
  callerAgent?: string;
  /** QA-PDF12-5: the caller's message id journaled with the hold; absent for an older record. */
  callerMessageID?: string;
  /** QA-2.1-17: a verdict the gate reached before the restart but never started posting: posted, never recomputed. */
  verdict?: StoredVerdict;
}

/** QA-2.1-17: a gate verdict read back from a journaled `state` record. */
export interface StoredVerdict {
  verdict: "PASS" | "FAIL" | "UNVERIFIABLE";
  reason?: string;
}

/** QA-2.1-17: the verdict of a `state` record's `verdict` field (a pending.ts `Verdict`); undefined when it holds none. Pure. */
export function storedVerdictOf(value: unknown): StoredVerdict | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const pass: unknown = Reflect.get(value, "pass");
  const outcome: unknown = Reflect.get(value, "outcome");
  const reasons: unknown = Reflect.get(value, "reasons");
  if (typeof pass !== "boolean") return undefined;
  const verdict = outcome === "unverifiable" ? "UNVERIFIABLE" : pass ? "PASS" : "FAIL";
  const reason = Array.isArray(reasons) && typeof reasons[0] === "string" ? reasons[0] : undefined;
  return { verdict, ...(reason === undefined ? {} : { reason }) };
}

/** What `HeldResults.restore` hands back to the adopter. */
export interface RestoredHolds {
  reposts: readonly RestoredPosting[];
  unverified: readonly RestoredHold[];
}

export interface HeldEntryView {
  handle: string;
  child: string;
  label: string;
  status: string;
}

export interface HeldResults extends HeldSink {
  /** Context AND compaction hooks registered AND `ctx.session.synthetic` is a function. */
  readonly available: boolean;
  /**
   * Makes the hold active, then appends the hold record (fsync); a failed append removes it again and rejects. A verdict
   * that arrives before the append settles waits for it; one that arrives before `hold` is queued (QA-2.1-2).
   */
  hold(rec: HeldRecord): Promise<void>;
  /** Persists the child's final text with an active hold (`hold-text`), so a restart can re-run the gate (QA-2.1-6). */
  noteText(handle: string, text: string): Promise<void>;
  /** True until the verdict entry is posted. */
  isHeld(child: string): boolean;
  /** Pure (§7.1). */
  placeholder(handle: string, child: string): string;
  /** The matcher (§7.2). */
  applyText(sessionID: string, text: string): string;
  /** Copies the messages and parts it changes; `undefined` = unchanged. */
  apply<M>(sessionID: string, messages: readonly M[]): M[] | undefined;
  /** The resume / Code Mode refusal (§7.4); `undefined` = allowed. */
  refusal(sessionID: string, tool: string, args: unknown): string | undefined;
  heldFor(parent: string): readonly HeldEntryView[];
  forgetSession(sessionID: string): void;
  /**
   * Restores adopted records: an unposted hold becomes active again, a posted one an inactive placeholder (QA-2.1-10).
   * Returns the holds whose verdict was being posted and the holds that still need a verdict (R20, R21).
   */
  restore(records: readonly PersistedRecord[]): RestoredHolds;
  /**
   * Settles a restored `posting` hold (R21): `alreadyPosted` (the parent context carries the verdict's
   * `metadata.router.handle`) records `posted`; otherwise the journaled verdict text is posted again.
   */
  settleRestored(handle: string, alreadyPosted: boolean): Promise<void>;
  /**
   * QA-2.1-16: the journal records of every live hold (its `hold` record with the dispatch data, its `hold-text` and an
   * unposted `posting`), and of every posted placeholder (`hold` and `posted`), for rewriting a vanished journal.
   */
  persisted(): PersistedRecord[];
}

const SUBAGENT_CLOSE = "</subagent>";
const VERDICT_PREFIX = "<router-verdict ";
const SYNTHETIC_ATTEMPTS = 3;
/** = BACKGROUND_RETRY_BASE_MS (verify/pending.ts:442); kept local so this module imports nothing heavy. */
const DEFAULT_RETRY_BASE_MS = 30_000;

/** The placeholder that replaces a held completion (memo §7.1); a pure function of the handle and the child. */
export function heldPlaceholder(handle: string, child: string): string {
  return `<subagent sessionID="${child}" state="held">held — verdict pending (${handle})</subagent>`;
}

/** The verdict entry text (memo §5). */
export function verdictText(handle: string, child: string, v: HeldVerdict): string {
  return `<router-verdict handle="${handle}" sessionID="${child}" verdict="${v.verdict}">\n${v.text}\n</router-verdict>`;
}

/**
 * QA-2.1-24: the plain notice that carries the verdict of a result that could not be held (its hold record failed): the result
 * reached the parent unverified, so this is not a `<router-verdict>` release, only the verdict after it.
 */
export function unheldVerdictText(handle: string, child: string, v: HeldVerdict): string {
  return `[router] Verdict for session ${child} (${handle}): ${v.verdict}. Its result could not be held, so it reached you unverified; this is the verification that followed.\n${v.text}`;
}

/** The refusal for a resume of, or a Code Mode reference to, a held child (memo §7.4). */
export function heldRefusalText(child: string, handle: string): string {
  return `[router] Refused: session ${child} is held for verification (${handle}). Its result arrives with the verdict; resume it after that.`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) out[key] = Reflect.get(value, key);
  return out;
}

/** Rewrites the text parts of one message; returns `undefined` when no part changed. The input is never mutated. */
function redactMessage<M>(message: M, redact: (text: string) => string): M | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const parts: unknown = Reflect.get(message, "parts");
  if (!Array.isArray(parts)) return undefined;
  let changed = false;
  const next: unknown[] = parts.map((part: unknown) => {
    const rec = asRecord(part);
    if (rec === undefined || typeof rec.text !== "string") return part;
    if (rec.type !== undefined && rec.type !== "text") return part;
    const text = redact(rec.text);
    if (text === rec.text) return part;
    changed = true;
    return { ...rec, text };
  });
  return changed ? { ...message, parts: next } : undefined;
}

interface HoldEntry extends HeldRecord {
  /** Verdict not yet posted. */
  active: boolean;
  /** A post is in flight or was journaled as `posting`. */
  posting: boolean;
  status: string;
  /** The verdict text being (or last) posted; journaled with `posting` (QA-2.1-2). */
  verdictText?: string;
  /** The `hold` append is in flight; a verdict arriving meanwhile waits for it (QA-2.1-2). */
  ready?: Promise<boolean>;
}

/** Verdicts that arrive for a handle before its hold is inserted; consumed by `hold` (QA-2.1-2). */
const MAX_EARLY_VERDICTS = 200;

/**
 * Creates the held-result store (memo §5, §7). Holds are bounded per parent and globally; the placeholder of a
 * released hold stays in force for the session's life (the host history keeps the original, C4).
 */
export function createHeldResults(deps: {
  observations?: V2Observations;
  synthetic: SyntheticFn;
  journal: InflightJournal;
  available: boolean;
  logger: Logger;
  now?(): number;
  retryBaseMs?: number;
  sleep?(ms: number): Promise<void>;
}): HeldResults {
  const byHandle = new Map<string, HoldEntry>();
  const byParent = new Map<string, Map<string, HoldEntry>>();
  const early = new Map<string, { v: HeldVerdict; at: number }>();
  /** QA-2.1-24: holds whose append failed, until their verdict is posted as a plain notice (bounded, oldest first out). */
  const unheld = new Map<string, HeldRecord>();
  const now = deps.now ?? (() => Date.now());
  const retryBase = deps.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  function remove(entry: HoldEntry): void {
    byHandle.delete(entry.handle);
    const children = byParent.get(entry.parentSessionID);
    if (children === undefined) return;
    children.delete(entry.handle);
    if (children.size === 0) byParent.delete(entry.parentSessionID);
  }

  function insert(entry: HoldEntry): void {
    let children = byParent.get(entry.parentSessionID);
    if (children === undefined) {
      children = new Map();
      byParent.set(entry.parentSessionID, children);
    }
    // Keep released attempts too: their historical completions must retain their own placeholders after a resume.
    children.set(entry.handle, entry);
    byHandle.set(entry.handle, entry);
  }

  /** Makes room for one more hold by evicting released holds, oldest first; false when only active holds remain. */
  function makeRoom(parent: string): boolean {
    const evict = (limit: number, count: () => number, pool: Iterable<HoldEntry>): boolean => {
      if (count() < limit) return true;
      for (const e of [...pool]) {
        if (count() < limit) return true;
        if (!e.active && !e.posting) remove(e);
      }
      return count() < limit;
    };
    const perParent = (): number => byParent.get(parent)?.size ?? 0;
    return (
      evict(MAX_HOLDS_PER_PARENT, perParent, byParent.get(parent)?.values() ?? []) &&
      evict(MAX_HOLDS_GLOBAL, () => byHandle.size, byHandle.values())
    );
  }

  function heldChildren(sessionID: string): HoldEntry[] {
    return [...(byParent.get(sessionID)?.values() ?? [])];
  }

  function applyText(sessionID: string, text: string,
    entries: ReadonlyMap<string, HoldEntry> = new Map(heldChildren(sessionID).map((entry) => [entry.childSessionID, entry]))): string {
    if (text.startsWith(VERDICT_PREFIX)) return text;
    let out = text;
    // One attempt per child, selected by the containing message's dispatch boundary in `apply`.
    const placeholders = heldChildren(sessionID).map((entry) => heldPlaceholder(entry.handle, entry.childSessionID));
    for (const entry of entries.values()) {
      const marker = `<subagent sessionID="${entry.childSessionID}"`;
      const placeholder = heldPlaceholder(entry.handle, entry.childSessionID);
      let from = 0;
      for (;;) {
        const at = out.indexOf(marker, from);
        if (at < 0) break;
        const prior = placeholders.find((known) => out.startsWith(known, at));
        if (prior !== undefined) {
          from = at + prior.length;
          continue;
        }
        if (at === 0) {
          // C2: the part is the whole completion message.
          out = placeholder;
          break;
        }
        // O13: an embedded record. Cut precisely only when the known body follows verbatim, else through the end.
        let end = out.length;
        const tagEnd = out.indexOf(">", at);
        if (entry.body !== undefined && tagEnd >= 0) {
          const bodyEnd = tagEnd + 1 + entry.body.length;
          if (out.startsWith(entry.body, tagEnd + 1) && out.startsWith(SUBAGENT_CLOSE, bodyEnd)) {
            end = bodyEnd + SUBAGENT_CLOSE.length;
          }
        }
        out = out.slice(0, at) + placeholder + out.slice(end);
        from = at + placeholder.length;
      }
    }
    return out;
  }

  async function post(entry: HoldEntry, v: HeldVerdict): Promise<void> {
    await postText(entry, verdictText(entry.handle, entry.childSessionID, v));
  }

  /**
   * QA-2.1-2: deliver one verdict text. The text is journaled with `posting` (so the next start can re-post it, R21),
   * a journal failure never blocks or repeats the post, and only a failed `synthetic` call is retried.
   */
  async function postText(entry: HoldEntry, text: string): Promise<void> {
    entry.verdictText = text;
    try {
      await deps.journal.append({ v: 1, kind: "posting", handle: entry.handle, text, at: now() });
    } catch (error) {
      warnSafe(deps.logger, "[router] held verdict posting not journaled; posting anyway", {
        handle: entry.handle,
        error: errorText(error),
      });
    }
    let lastError: unknown;
    let delivered = false;
    for (let attempt = 0; attempt < SYNTHETIC_ATTEMPTS && !delivered; attempt += 1) {
      try {
        observeV2(deps.observations, () => ({ family: "completion-effect", effect: "annotation-delivery", source: "held-synthetic",
          parentSessionID: entry.parentSessionID, callID: entry.callID, childSessionID: entry.childSessionID, handle: entry.handle }));
        await deps.synthetic({
          sessionID: entry.parentSessionID,
          text,
          description: "Model router verdict",
          metadata: { router: { kind: "held-verdict", handle: entry.handle, child: entry.childSessionID } },
          resume: true,
        });
        delivered = true;
      } catch (error) {
        lastError = error;
        if (attempt < SYNTHETIC_ATTEMPTS - 1) await sleep(retryBase * 2 ** attempt);
      }
    }
    if (!delivered) {
      // Keep `posting`: the next start finds the journal entry and decides again (R21).
      warnSafe(deps.logger, "[router] held verdict not posted; kept for the next start", {
        handle: entry.handle,
        error: errorText(lastError),
      });
      return;
    }
    entry.active = false;
    entry.status = "released";
    entry.childText = undefined;
    try {
      await deps.journal.append({ v: 1, kind: "posted", handle: entry.handle, at: now() });
    } catch (error) {
      // Never post again for a journal failure: the parent context check at the next start finds the delivered post.
      warnSafe(deps.logger, "[router] held verdict posted but not journaled", { handle: entry.handle, error: errorText(error) });
    }
  }

  /**
   * QA-2.1-24: the verdict of a hold whose append failed (it settled before or during the append): nothing is held or journaled,
   * so it is posted once as a plain notice to the parent (the result itself was never withheld). The ack said a verdict
   * follows; it is never dropped. Only a failed `synthetic` call is retried. Never throws.
   */
  async function postUnheld(rec: HeldRecord, v: HeldVerdict): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < SYNTHETIC_ATTEMPTS; attempt += 1) {
      try {
        observeV2(deps.observations, () => ({ family: "completion-effect", effect: "annotation-delivery", source: "unheld-synthetic",
          parentSessionID: rec.parentSessionID, callID: rec.callID, childSessionID: rec.childSessionID, handle: rec.handle }));
        await deps.synthetic({
          sessionID: rec.parentSessionID,
          text: unheldVerdictText(rec.handle, rec.childSessionID, v),
          description: "Model router verdict",
          metadata: { router: { kind: "unheld-verdict", handle: rec.handle, child: rec.childSessionID } },
          resume: true,
        });
        return;
      } catch (error) {
        lastError = error;
        if (attempt < SYNTHETIC_ATTEMPTS - 1) await sleep(retryBase * 2 ** attempt);
      }
    }
    warnSafe(deps.logger, "[router] verdict of a result that could not be held was not posted", {
      handle: rec.handle,
      error: errorText(lastError),
    });
  }

  /** Delivers one verdict for an entry; waits for an in-flight `hold` append first. Never throws. */
  async function deliver(entry: HoldEntry, v: HeldVerdict): Promise<void> {
    if (entry.ready !== undefined && !(await entry.ready)) {
      // QA-2.1-24: the hold was never journaled, so nothing is held; the verdict that settled meanwhile still reaches the parent.
      unheld.delete(entry.handle);
      await postUnheld(entry, v);
      return;
    }
    if (!entry.active || entry.posting) return;
    entry.posting = true;
    try {
      await post(entry, v);
    } catch (error) {
      warnSafe(deps.logger, "[router] held verdict post failed", { handle: entry.handle, error: errorText(error) });
    } finally {
      entry.posting = false;
    }
  }

  return {
    available: deps.available,

    async hold(rec) {
      if (!deps.available) throw new Error("holding is not available");
      if (!makeRoom(rec.parentSessionID)) throw new Error("hold capacity reached");
      // QA-2.1-2: the entry exists before the fsync; a verdict that settles meanwhile waits for the write instead of being dropped.
      let settle: (ok: boolean) => void = () => undefined;
      const entry: HoldEntry = {
        ...rec,
        active: true,
        posting: false,
        status: "verifying",
        ready: new Promise<boolean>((resolve) => {
          settle = resolve;
        }),
      };
      unheld.delete(rec.handle);
      insert(entry);
      try {
        await deps.journal.append(
          {
            v: 1,
            kind: "hold",
            handle: rec.handle,
            parent: rec.parentSessionID,
            child: rec.childSessionID,
            callID: rec.callID,
            ...(rec.label === undefined ? {} : { label: rec.label }),
            ...(rec.childText === undefined ? {} : { text: rec.childText }),
            ...(rec.dispatch === undefined ? {} : { dispatch: rec.dispatch }),
            ...(rec.callerAgent === undefined ? {} : { callerAgent: rec.callerAgent }),
            ...(rec.callerMessageID === undefined ? {} : { callerMessageID: rec.callerMessageID }),
            at: now(),
          },
          { fsync: true },
        );
      } catch (error) {
        entry.active = false;
        if (byHandle.get(rec.handle) === entry) remove(entry);
        // QA-2.1-24: a verdict that settled during the append is posted by its `deliver` (it sees `false`); one queued before
        // `hold` is posted here; one that settles later is posted by `verdict` (the handle is remembered as unheld).
        unheld.delete(rec.handle);
        unheld.set(rec.handle, { handle: rec.handle, parentSessionID: rec.parentSessionID, childSessionID: rec.childSessionID, callID: rec.callID });
        trimMap(unheld, MAX_EARLY_VERDICTS, () => false);
        settle(false);
        entry.ready = undefined;
        const queued = early.get(rec.handle);
        if (queued !== undefined) {
          early.delete(rec.handle);
          unheld.delete(rec.handle);
          if (now() - queued.at <= EARLY_END_TTL_MS) void postUnheld(rec, queued.v);
        }
        throw error;
      }
      settle(true);
      entry.ready = undefined;
      const queued = early.get(rec.handle);
      if (queued !== undefined) {
        early.delete(rec.handle);
        if (now() - queued.at <= EARLY_END_TTL_MS) void deliver(entry, queued.v);
      }
    },

    isHeld(child) {
      for (const children of byParent.values()) {
        for (const entry of children.values()) if (entry.childSessionID === child && entry.active) return true;
      }
      return false;
    },

    placeholder: heldPlaceholder,
    applyText,

    apply<M>(sessionID: string, messages: readonly M[]): M[] | undefined {
      if (!byParent.has(sessionID)) return undefined;
      const messageIndices = indexMessageIDs(messages);
      const entries = heldChildren(sessionID);
      const fallback = new Map(entries.map((entry) => [entry.childSessionID, entry]));
      let changed = false;
      const out = messages.map((message, index) => {
        const selected = new Map(fallback);
        // With a boundary, select the latest eligible attempt. Missing/compacted boundaries still redact fail-closed.
        for (const entry of entries) {
          if (!precedesDispatch(messageIndices, index, entry.callerMessageID)) selected.set(entry.childSessionID, entry);
        }
        const next = redactMessage(message, (text) => applyText(sessionID, text, selected));
        if (next === undefined) return message;
        changed = true;
        return next;
      });
      return changed ? out : undefined;
    },

    refusal(sessionID, tool, args) {
      const active = heldChildren(sessionID).filter((e) => e.active);
      if (active.length === 0) return undefined;
      const rec = asRecord(args);
      if (rec === undefined) return undefined;
      if (tool === "subagent") {
        for (const key of ["sessionID", "task_id"]) {
          const id = rec[key];
          const hit = typeof id === "string" ? active.find((e) => e.childSessionID === id) : undefined;
          if (hit !== undefined) return heldRefusalText(hit.childSessionID, hit.handle);
        }
        return undefined;
      }
      if (tool === "execute" && typeof rec.code === "string") {
        const code = rec.code;
        const hit = active.find((e) => code.includes(e.childSessionID));
        if (hit !== undefined) return heldRefusalText(hit.childSessionID, hit.handle);
      }
      return undefined;
    },

    heldFor(parent) {
      return heldChildren(parent)
        .filter((e) => e.active)
        .map((e) => ({ handle: e.handle, child: e.childSessionID, label: e.label ?? `session ${e.childSessionID}`, status: e.status }));
    },

    async verdict(handle, v) {
      const entry = byHandle.get(handle);
      if (entry === undefined) {
        // QA-2.1-24: its hold failed: the verdict that settles after the failure is posted as a plain notice too.
        const failed = unheld.get(handle);
        if (failed !== undefined) {
          unheld.delete(handle);
          await postUnheld(failed, v);
          return;
        }
        // QA-2.1-2: the verdict settled before `hold` inserted the entry; `hold` delivers it.
        early.delete(handle);
        early.set(handle, { v, at: now() });
        trimMap(early, MAX_EARLY_VERDICTS, () => false);
        return;
      }
      await deliver(entry, v);
    },

    async noteText(handle, text) {
      const entry = byHandle.get(handle);
      if (entry === undefined || !entry.active) return;
      entry.childText = text;
      entry.body ??= text;
      try {
        // QA-2.1-17: written for a succeeded child only (the processor checks the status first); the status is journaled with it.
        await deps.journal.append({ v: 1, kind: "hold-text", handle, text, status: "succeeded", at: now() }, { fsync: true });
      } catch (error) {
        warnSafe(deps.logger, "[router] held child text not journaled", { handle, error: errorText(error) });
      }
    },

    forgetSession(sessionID) {
      for (const entry of heldChildren(sessionID)) {
        remove(entry);
        early.delete(entry.handle);
      }
      for (const [handle, rec] of unheld) if (rec.parentSessionID === sessionID) unheld.delete(handle);
      deps.journal.append({ v: 1, kind: "forget", session: sessionID, at: now() }).catch((error: unknown) => {
        warnSafe(deps.logger, "[router] held forget not journaled", { sessionID, error: errorText(error) });
      });
    },

    restore(records) {
      const restored: HoldEntry[] = [];
      const postingText = new Map<string, string>();
      const delivered = new Set<string>();
      const stored = new Map<string, StoredVerdict>();
      for (const r of records) {
        // QA-2.1-17: the verdict a gate reached before the restart (the entry's `verified` state), never posted.
        if (r.kind === "state" && typeof r.handle === "string" && r.state === "verified") {
          const verdict = storedVerdictOf(r.verdict);
          if (verdict !== undefined) stored.set(r.handle, verdict);
          continue;
        }
        if (r.kind === "hold" && typeof r.handle === "string" && typeof r.parent === "string" && typeof r.child === "string") {
          // A hold this process already knows stays as it is (a second adoption never resets it).
          if (byHandle.has(r.handle)) continue;
          const entry: HoldEntry = {
            handle: r.handle,
            parentSessionID: r.parent,
            childSessionID: r.child,
            callID: typeof r.callID === "string" ? r.callID : "",
            ...(typeof r.label === "string" ? { label: r.label } : {}),
            ...(typeof r.text === "string" ? { childText: r.text, body: r.text } : {}),
            ...(r.dispatch === undefined ? {} : { dispatch: restoredDispatchOf(r.dispatch) }),
            ...(typeof r.callerAgent === "string" && r.callerAgent !== "" ? { callerAgent: r.callerAgent } : {}),
            ...(typeof r.callerMessageID === "string" && r.callerMessageID !== "" ? { callerMessageID: r.callerMessageID } : {}),
            active: true,
            posting: false,
            status: "verifying",
          };
          insert(entry);
          restored.push(entry);
        } else if (r.kind === "hold-text" && typeof r.handle === "string" && typeof r.text === "string"
          // QA-2.1-17: only a succeeded child's text is gated after a restart (a line without `status` predates the field).
          && (r.status === undefined || r.status === "succeeded")) {
          const e = byHandle.get(r.handle);
          if (e !== undefined && restored.includes(e)) {
            e.childText = r.text;
            e.body ??= r.text;
          }
        } else if (r.kind === "posting" && typeof r.handle === "string") {
          if (typeof r.text === "string") postingText.set(r.handle, r.text);
        } else if (r.kind === "posted" && typeof r.handle === "string") {
          delivered.add(r.handle);
        } else if (r.kind === "forget" && typeof r.session === "string") {
          for (const e of heldChildren(r.session)) remove(e);
        }
      }
      const reposts: RestoredPosting[] = [];
      const unverified: RestoredHold[] = [];
      for (const e of restored) {
        if (byHandle.get(e.handle) !== e) continue;
        if (delivered.has(e.handle)) {
          // QA-2.1-10: a posted hold stays as an inactive placeholder (the host history still holds the raw completion).
          e.active = false;
          e.status = "released";
          e.childText = undefined;
          continue;
        }
        const text = postingText.get(e.handle);
        if (text !== undefined) {
          e.verdictText = text;
          e.posting = true;
          e.status = "posting";
          reposts.push({ handle: e.handle, parentSessionID: e.parentSessionID, childSessionID: e.childSessionID, text });
        } else {
          unverified.push({
            handle: e.handle,
            parentSessionID: e.parentSessionID,
            childSessionID: e.childSessionID,
            callID: e.callID,
            ...(e.childText === undefined ? {} : { childText: e.childText }),
            dispatch: e.dispatch ?? {},
            ...(e.callerAgent === undefined ? {} : { callerAgent: e.callerAgent }),
            ...(e.callerMessageID === undefined ? {} : { callerMessageID: e.callerMessageID }),
            ...(stored.has(e.handle) ? { verdict: stored.get(e.handle) } : {}),
          });
        }
      }
      return { reposts, unverified };
    },

    async settleRestored(handle, alreadyPosted) {
      const entry = byHandle.get(handle);
      if (entry === undefined || !entry.active) return;
      if (alreadyPosted) {
        entry.active = false;
        entry.posting = false;
        entry.status = "released";
        entry.childText = undefined;
        try {
          await deps.journal.append({ v: 1, kind: "posted", handle, at: now() });
        } catch (error) {
          warnSafe(deps.logger, "[router] held verdict posted but not journaled", { handle, error: errorText(error) });
        }
        return;
      }
      const text = entry.verdictText;
      if (text === undefined) return;
      entry.posting = true;
      try {
        await postText(entry, text);
      } catch (error) {
        warnSafe(deps.logger, "[router] held verdict re-post failed", { handle, error: errorText(error) });
      } finally {
        entry.posting = false;
      }
    },

    persisted() {
      const at = now();
      const out: PersistedRecord[] = [];
      for (const e of byHandle.values()) {
        // A hold whose first append is still in flight (or failed) is not journaled yet: its own append writes it.
        if (e.ready !== undefined) continue;
        out.push({
          v: 1, kind: "hold", handle: e.handle, parent: e.parentSessionID, child: e.childSessionID, callID: e.callID,
          ...(e.label === undefined ? {} : { label: e.label }),
          ...(e.dispatch === undefined ? {} : { dispatch: e.dispatch }),
          ...(e.callerAgent === undefined ? {} : { callerAgent: e.callerAgent }),
          ...(e.callerMessageID === undefined ? {} : { callerMessageID: e.callerMessageID }),
          at,
        });
        if (!e.active) {
          out.push({ v: 1, kind: "posted", handle: e.handle, at });
          continue;
        }
        if (e.childText !== undefined) out.push({ v: 1, kind: "hold-text", handle: e.handle, text: e.childText, status: "succeeded", at });
        if (e.verdictText !== undefined) out.push({ v: 1, kind: "posting", handle: e.handle, text: e.verdictText, at });
      }
      return out;
    },
  };
}

// ---- completion processor (memo §4.7, §9, §10) --------------------------------------------------

export type Trigger =
  | { kind: "end-event"; outcome: EndFact["outcome"]; eventID: string; at: number }
  | { kind: "completion"; state: "completed" | "error" | "cancelled"; body: string | undefined; at: number }
  | { kind: "early-end"; end: EndFact }
  | { kind: "recovery"; outcome: EndFact["outcome"] | "lost"; text: string | undefined; at: number }
  /** 3.1 (launcher A). */
  | { kind: "runner"; status: EndFact["outcome"]; text: string; at: number };

export interface CompletionDeps {
  observations?: V2Observations;
  /** `caller` (QA-PDF12-9): the caller journaled on the attempt being finished, for the context the finish runs in. */
  finish(input: FinishInput, caller: FinishCaller): Promise<FinishResult>;
  /** The child's last assistant message (`ctx.session.context`, C7/O1). */
  readChildResult(child: string): Promise<{ outcome?: EndFact["outcome"]; text?: string } | undefined>;
  /** The `!running` half of `roleAfterCall` (§4.2): budget and authority notices, plus its evictions. */
  roleCompletion(a: Attempt, text: string): Promise<string[]>;
  /** Idempotent by holder id. */
  releaseLeases(holderID: string): void;
  held: HeldResults;
  persist: InflightJournal;
  now(): number;
  logger: Logger;
  /** The change set at child end (verify/dispatch.ts `captureDelta`, 2.1.4.b); absent = none. `dispatchID`: `task:<parent>:<callID>`. */
  captureDelta?(callID: string, child: string, dispatchID?: string): Promise<unknown>;
  /**
   * `pending.releaseHandle` (QA-2.1-4): frees the reserved handle of a held attempt that ends without a held register
   * (failed, interrupted, lost, closed unknown, or a gate that answered at once). Idempotent; a registered entry is kept.
   */
  releaseHeld?(handle: string): void;
  /**
   * QA-2.1-17: the dispatch data journaled with a recovered attempt's `inflight` record (`FinishApi.dispatchOf` at
   * acknowledgement); passed to `finish` as `restored` on a recovery. Absent: an empty record (the plugin then ends
   * UNVERIFIABLE when it has nothing to verify with).
   */
  restoredDispatch?(a: Attempt): RestoredDispatch | undefined;
}

export interface CompletedLine {
  child: string;
  label: string;
  /** The annotations, or `router guarantees pending`. */
  text: string;
}

export interface CompletionProcessor {
  /** Once per attempt; never throws. */
  process(childSessionID: string, trigger: Trigger): Promise<void>;
  /** True when the child's processing finished (or none is due) within `timeoutMs`. */
  settled(childSessionID: string, timeoutMs: number): Promise<boolean>;
  /** Synchronous, for the "completed" provider. */
  completedFor(parent: string): readonly CompletedLine[];
  /** A root execution end: drops the lines already shown. */
  endTurn(parent: string): void;
  forgetSession(sessionID: string): void;
  /**
   * Closes an attempt the registry gave up on (`onClosed`: superseded by a resume, or swept after
   * `ATTEMPT_SWEEP_AGE_MS`): a held result is released as UNVERIFIABLE, the leases end.
   */
  closeUnknown(a: Attempt, reason: string): Promise<void>;
}

export const PENDING_GUARANTEES_TEXT = "router guarantees pending";

/** `<role or agent> "<description>"`, on one line. */
export function attemptLabel(a: CallRecord): string {
  return `${a.role ?? a.agent} "${a.description.replace(/\s+/g, " ").trim()}"`;
}

function addBounded(set: Set<string>, key: string, max: number): void {
  set.delete(key);
  set.add(key);
  for (const old of set) {
    if (set.size <= max) break;
    set.delete(old);
  }
}

function endOf(trigger: Trigger): { status: Attempt["outcome"]; at: number } {
  switch (trigger.kind) {
    case "end-event":
      return { status: trigger.outcome, at: trigger.at };
    case "early-end":
      return { status: trigger.end.outcome, at: trigger.end.at };
    case "completion":
      return { status: trigger.state === "completed" ? "succeeded" : trigger.state === "error" ? "failed" : "interrupted", at: trigger.at };
    case "recovery":
      return { status: trigger.outcome === "lost" ? "unknown" : trigger.outcome, at: trigger.at };
    case "runner":
      return { status: trigger.status, at: trigger.at };
  }
}

function triggerText(trigger: Trigger): string | undefined {
  if (trigger.kind === "completion") return trigger.body;
  if (trigger.kind === "runner") return trigger.text;
  if (trigger.kind === "recovery") return trigger.text;
  return undefined;
}

/**
 * Creates the completion processor (memo §4.7). It runs once per attempt (the key is `child\0callID`, §10),
 * holds nothing back from the registry's state machine, and never throws: a fault is logged and turns into the
 * annotation `router guarantees failed: <reason>` (§4.7 step 8).
 */
export function createCompletionProcessor(reg: InFlightRegistry, deps: CompletionDeps): CompletionProcessor {
  const processed = new Set<string>();
  const settling = new Map<string, Promise<void>>();
  const turns = new Map<string, number>();

  function turnOf(parent: string): number {
    return turns.get(parent) ?? 0;
  }

  function wasProcessed(key: string): boolean {
    if (processed.has(key)) return true;
    try {
      return deps.persist.hasProcessed(key);
    } catch (error) {
      warnSafe(deps.logger, "[router] processed-key lookup failed", { error: errorText(error) });
      return false;
    }
  }

  async function journal(record: PersistedRecord, opts?: { fsync?: boolean }): Promise<void> {
    try {
      await deps.persist.append(record, opts);
    } catch (error) {
      warnSafe(deps.logger, "[router] background journal append failed", { kind: record.kind, error: errorText(error) });
    }
  }

  async function markProcessed(a: Attempt): Promise<void> {
    addBounded(processed, a.key, MAX_PROCESSED_KEYS);
    await journal({ v: 1, kind: "processed", callID: a.callID, child: a.childSessionID, at: deps.now() });
  }

  function releaseLeasesSafe(child: string): void {
    try {
      deps.releaseLeases(child);
    } catch (error) {
      warnSafe(deps.logger, "[router] lease release failed", { child, error: errorText(error) });
    }
  }

  async function verdictSafe(handle: string, v: HeldVerdict): Promise<void> {
    try {
      await deps.held.verdict(handle, v);
    } catch (error) {
      warnSafe(deps.logger, "[router] held verdict failed", { handle, error: errorText(error) });
    }
  }

  /** QA-2.1-4: a held attempt that ends without a held register gives its reserved handle back. */
  function releaseHandleSafe(handle: string): void {
    try {
      deps.releaseHeld?.(handle);
    } catch (error) {
      warnSafe(deps.logger, "[router] held handle release failed", { handle, error: errorText(error) });
    }
  }

  /** QA-2.1-17: the dispatch data journaled with a recovered attempt's `inflight` record; empty when none. Never throws. */
  function restoredDispatchSafe(a: Attempt): RestoredDispatch {
    try {
      return deps.restoredDispatch?.(a) ?? {};
    } catch (error) {
      warnSafe(deps.logger, "[router] restored dispatch data unreadable", { callID: a.callID, error: errorText(error) });
      return {};
    }
  }

  async function noteTextSafe(handle: string, text: string): Promise<void> {
    try {
      await deps.held.noteText(handle, text);
    } catch (error) {
      warnSafe(deps.logger, "[router] held child text not kept", { handle, error: errorText(error) });
    }
  }

  /** A held attempt whose verdict was posted has left the hold. */
  function refresh(a: Attempt): void {
    if (a.state === "held" && !deps.held.isHeld(a.childSessionID)) a.state = "released";
  }

  async function readSafe(child: string): Promise<{ outcome?: EndFact["outcome"]; text?: string } | undefined> {
    try {
      return await deps.readChildResult(child);
    } catch (error) {
      warnSafe(deps.logger, "[router] child result read failed; waiting for the completion", { child, error: errorText(error) });
      return undefined;
    }
  }

  async function body(a: Attempt, trigger: Trigger, ctx: { text?: string }): Promise<void> {
    const end = endOf(trigger);
    let text = triggerText(trigger);
    if (text === undefined && !(trigger.kind === "recovery" && trigger.outcome === "lost")) {
      const read = await readSafe(a.childSessionID);
      if (read?.text === undefined) {
        // Nothing to process yet: wait for the completion trigger (the context-hook wait covers it).
        warnSafe(deps.logger, "[router] child result not readable yet; waiting for the completion trigger", {
          child: a.childSessionID,
          trigger: trigger.kind,
          readShape: read === undefined ? "undefined" : Object.keys(read).join(","),
        });
        a.state = "child-ended";
        a.endedAt = end.at;
        a.outcome = end.status;
        return;
      }
      text = read.text;
    }
    a.endedAt = end.at;
    a.outcome = end.status;
    const handle = a.hold?.handle;

    if (text === undefined) {
      // Lost across a restart (R18): no result exists, so nothing can be verified.
      a.annotations = ["[router] the dispatch was lost in a restart"];
      releaseLeasesSafe(a.childSessionID);
      await markProcessed(a);
      if (handle !== undefined) {
        await verdictSafe(handle, { verdict: "UNVERIFIABLE", text: "[router] not verified: lost in restart", reason: "lost in restart" });
        releaseHandleSafe(handle);
      }
      a.state = handle !== undefined ? "released" : "annotated";
      return;
    }

    ctx.text = text;
    const status = end.status ?? "unknown";
    // QA-2.1-6: the child text lives in the journal with the hold, so a restart can re-run the gate. QA-2.1-17: only a
    // succeeded child's text, so a restart never gates a failed or interrupted child.
    if (handle !== undefined && status === "succeeded") await noteTextSafe(handle, text);
    let delta: unknown;
    if (deps.captureDelta !== undefined) {
      try {
        // QA-2.1-7: the change-set store keys a dispatch by `task:<parent>:<callID>`; the parent is known here.
        observeV2(deps.observations, () => ({ family: "completion-effect", effect: "change-set-capture", source: "background-delta",
          parentSessionID: a.parentSessionID, callID: a.callID, childSessionID: a.childSessionID }));
        delta = await deps.captureDelta(a.callID, a.childSessionID, `task:${a.parentSessionID}:${a.callID}`);
      } catch (error) {
        warnSafe(deps.logger, "[router] change-set capture failed", { callID: a.callID, error: errorText(error) });
      }
    }
    const notices = await deps.roleCompletion(a, text);
    const holdForGate = status === "succeeded" ? handle : undefined;
    observeV2(deps.observations, () => ({ family: "completion-effect", effect: "finish-dispatch", source: "background",
      parentSessionID: a.parentSessionID, callID: a.callID, childSessionID: a.childSessionID }));
    const result = await deps.finish({
      callID: a.callID,
      parentSessionID: a.parentSessionID,
      childSessionID: a.childSessionID,
      outputText: text,
      status,
      mode: "background",
      ...(holdForGate === undefined ? {} : { heldHandle: holdForGate }),
      endedAt: end.at,
      ...(delta === undefined ? {} : { delta }),
      // QA-2.1-17: a recovery runs after a restart: the plugin rebuilds the gate inputs from the journaled dispatch.
      ...(trigger.kind === "recovery" ? { restored: restoredDispatchSafe(a) } : {}),
    }, {
      // QA-PDF12-9: the caller comes from the attempt itself, never from a capped call-id lookup a `forgetSession` may clear.
      ...(a.callerAgent === undefined ? {} : { callerAgent: a.callerAgent }),
      ...(a.callerMessageID === undefined ? {} : { callerMessageID: a.callerMessageID }),
    });
    releaseLeasesSafe(a.childSessionID);
    await markProcessed(a);
    a.annotations = [...notices, result.suffix].map((s) => s.trim()).filter((s) => s.length > 0);

    if (handle === undefined) {
      a.state = "annotated";
      return;
    }
    if (holdForGate !== undefined && result.verification.kind === "held") {
      // The gate runs behind `finish`; it posts the verdict through the HeldSink when it settles.
      a.state = "held";
      refresh(a);
      return;
    }
    // No gate will post for this hold: release it with the verdict the result implies (§4.7 step 7).
    releaseHandleSafe(handle);
    const v = result.verification;
    if (status !== "succeeded") {
      await verdictSafe(handle, {
        verdict: "UNVERIFIABLE",
        text: `${result.outputText}\n[router] not verified: the dispatch ended ${status}`,
        reason: `the dispatch ended ${status}`,
      });
    } else if (v.kind === "required") {
      await verdictSafe(handle, { verdict: v.verdict, text: result.outputText });
    } else {
      await verdictSafe(handle, {
        verdict: "UNVERIFIABLE",
        text: `${result.outputText}\n[router] not verified: no verification ran`,
        reason: "no verification ran",
      });
    }
    a.state = deps.held.isHeld(a.childSessionID) ? "held" : "released";
  }

  async function fail(a: Attempt, error: unknown, ctx: { text?: string }): Promise<void> {
    const reason = errorText(error);
    warnSafe(deps.logger, "[router] completion processing failed", { callID: a.callID, child: a.childSessionID, error: reason });
    addBounded(processed, a.key, MAX_PROCESSED_KEYS);
    a.annotations = [`router guarantees failed: ${reason}`];
    releaseLeasesSafe(a.childSessionID);
    const handle = a.hold?.handle;
    if (handle !== undefined) {
      const shown = ctx.text === undefined ? "" : `${ctx.text}\n`;
      await verdictSafe(handle, { verdict: "UNVERIFIABLE", text: `${shown}[router] not verified: ${reason}`, reason });
      releaseHandleSafe(handle);
    }
    a.state = deps.held.isHeld(a.childSessionID) ? "held" : handle !== undefined ? "released" : "annotated";
  }

  async function run(child: string, trigger: Trigger): Promise<void> {
    // Everything up to the first await is synchronous: the state flip below is what makes a second trigger a no-op.
    const a = reg.byChild(child);
    if (a === undefined) {
      warnSafe(deps.logger, "[router] completion trigger ignored: no attempt for the child", { child, trigger: trigger.kind });
      return;
    }
    if (a.state !== "acknowledged" && a.state !== "child-ended") {
      warnSafe(deps.logger, "[router] completion trigger ignored: attempt not open", { child, trigger: trigger.kind, state: a.state });
      return;
    }
    if (wasProcessed(a.key)) {
      warnSafe(deps.logger, "[router] completion trigger ignored: already processed", { child, trigger: trigger.kind });
      return;
    }
    if (isExecutorOwned(a)) {
      // 3.1.7 W5: an executor-owned attempt settles only through its launch completion, submitted as a `runner` trigger. It is
      // marked processed (D2), so a later `execution.*` trigger for it is a duplicate. No result post, verification or lease
      // release here: the executor owns all three (plan-child leases end with `releaseTask` only).
      if (trigger.kind !== "runner") return;
      const end = endOf(trigger);
      a.endedAt = end.at;
      a.outcome = end.status;
      await markProcessed(a);
      a.state = "released";
      return;
    }
    a.state = "processing";
    let done: () => void = () => undefined;
    settling.set(
      a.key,
      new Promise<void>((resolve) => {
        done = resolve;
      }),
    );
    const ctx: { text?: string } = {};
    try {
      await body(a, trigger, ctx);
    } catch (error) {
      await fail(a, error, ctx);
    } finally {
      settling.delete(a.key);
      done();
    }
  }

  return {
    async process(childSessionID, trigger) {
      try {
        await run(childSessionID, trigger);
      } catch (error) {
        warnSafe(deps.logger, "[router] completion processor failed", { child: childSessionID, error: errorText(error) });
      }
    },

    async settled(childSessionID, timeoutMs) {
      const a = reg.byChild(childSessionID);
      if (a === undefined) return true;
      const gate = settling.get(a.key);
      if (gate === undefined) return a.state !== "acknowledged" && a.state !== "child-ended";
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
      });
      try {
        return await Promise.race([gate.then(() => a.state !== "child-ended"), timeout]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },

    completedFor(parent) {
      const turn = turnOf(parent);
      const lines: Array<{ at: number; line: CompletedLine; attempt: Attempt; annotated: boolean }> = [];
      for (const a of reg.listForParent(parent)) {
        refresh(a);
        const at = a.endedAt ?? a.at;
        const line = (text: string): CompletedLine => ({ child: a.childSessionID, label: attemptLabel(a), text });
        if (a.state === "child-ended" || a.state === "processing") {
          a.pendingShown = true;
          lines.push({ at, line: line(PENDING_GUARANTEES_TEXT), attempt: a, annotated: false });
        } else if (a.state === "annotated" || (a.state === "closed-unknown" && a.annotations.length > 0)) {
          if (a.shownInTurn !== undefined && a.shownInTurn !== turn) continue;
          a.shownInTurn = turn;
          const text = a.annotations.join(" ").replace(/\s+/g, " ").trim();
          lines.push({ at, line: line(text.length > 0 ? text : "completed"), attempt: a, annotated: true });
        }
      }
      lines.sort((x, y) => x.at - y.at);
      return lines.slice(-MAX_COMPLETED_PER_PARENT).map((l) => {
        // Only returned annotations, never the lines dropped by the provider's cap or a pending placeholder.
        if (l.annotated) observeV2(deps.observations, () => ({ family: "completion-effect", effect: "annotation-delivery", source: "completed-provider",
          parentSessionID: l.attempt.parentSessionID, callID: l.attempt.callID, childSessionID: l.attempt.childSessionID }));
        return l.line;
      });
    },

    endTurn(parent) {
      for (const a of reg.listForParent(parent)) {
        if (a.state === "annotated" && a.shownInTurn !== undefined) a.state = "released";
        refresh(a);
      }
      turns.delete(parent);
      turns.set(parent, turnOf(parent) + 1);
      trimMap(turns, MAX_COMPLETED_PARENTS, () => false);
    },

    forgetSession(sessionID) {
      turns.delete(sessionID);
    },

    async closeUnknown(a, reason) {
      try {
        addBounded(processed, a.key, MAX_PROCESSED_KEYS);
        // 3.1.7 W3/W5: a plan child's leases are `until-integrated`: the executor releases them (`releaseTask`), never its end.
        if (isExecutorOwned(a)) return;
        a.annotations = [`[router] the dispatch ended without a result (${reason})`];
        releaseLeasesSafe(a.childSessionID);
        const handle = a.hold?.handle;
        if (handle !== undefined && deps.held.isHeld(a.childSessionID)) {
          await verdictSafe(handle, { verdict: "UNVERIFIABLE", text: `[router] not verified: ${reason}`, reason });
        }
        if (handle !== undefined) releaseHandleSafe(handle);
      } catch (error) {
        warnSafe(deps.logger, "[router] closing an attempt failed", { callID: a.callID, error: errorText(error) });
      }
    },
  };
}

// ---- turn-state providers: pure renderers (memo §13; registration is 2.1.5) -----------------------

/** Provider order of the three background providers (`late` 10, `pending` 20, `route-hint` 90 stay). */
export const PROVIDER_ORDER = { completed: 30, held: 40, inFlight: 50 } as const;

/** `completed` (order 30): the lines of attempts that ended since the orchestrator's last turn. */
export function renderCompleted(lines: readonly CompletedLine[]): string | undefined {
  if (lines.length === 0) return undefined;
  return [
    "[router] Completed since your last turn:",
    ...lines.map((l) => `- ${l.label} (${l.child}): ${l.text}`),
  ].join("\n");
}

/** `held` (order 40): results the orchestrator may not use before their verdict. */
export function renderHeld(items: readonly HeldEntryView[]): string | undefined {
  if (items.length === 0) return undefined;
  return [
    "[router] Held for verification — not usable until the verdict:",
    ...items.map((h) => `- ${h.label} (${h.child}) ${h.handle}: ${h.status}`),
  ].join("\n");
}

/** `in-flight` (order 50): background dispatches that have not ended. `now` is epoch ms. */
export function renderInFlight(attempts: readonly Attempt[], now: number): string | undefined {
  // 3.1.7 W5: plan children are the executor's (the `plan` provider shows them), not background dispatches of the orchestrator.
  const live = attempts.filter((a) => a.state === "acknowledged" && !isExecutorOwned(a));
  if (live.length === 0) return undefined;
  return [
    `[router] In flight (background): ${live.length}`,
    ...live.map((a) => {
      const minutes = Math.max(0, Math.floor((now - (a.ackAt ?? a.at)) / 60_000));
      return `- ${attemptLabel(a)} (${a.childSessionID}) — ${minutes} min`;
    }),
    "Do not report the task done while dispatches are listed here.",
  ].join("\n");
}

// ---- leases (memo §14; a process-wide registry over Phase 1.3) ---------------------------------------

export interface LeaseRegistryHandle {
  registry: LeaseRegistry;
  /** Subscribes to lease releases (verification deferral wakes on them); returns the unsubscribe. */
  onRelease(cb: () => void): () => void;
  /** Tells the subscribers a release happened (event loop, after `releaseChild`). */
  notifyReleased(): void;
  /** Drops this holder's reference; the last release discards the shared registry. */
  release(): Promise<void>;
}

interface SharedLeases {
  registry: LeaseRegistry;
  listeners: Set<() => void>;
  refs: number;
  logger: Logger;
  initializing: boolean;
}

interface SharedLeaseRegistries {
  readonly version: 1;
  readonly registries: Map<string, unknown>;
}

/** Versioned process state, shared even when plugin instances load separate copies of this module. */
const SHARED_LEASES_KEY = Symbol.for("opencode-model-router.leases@1");

function isSharedLeaseRegistries(value: unknown): value is SharedLeaseRegistries {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Partial<SharedLeaseRegistries>;
  return state.version === 1 && state.registries instanceof Map;
}

/** Validate each entry independently: a malformed neighbour must not replace a live registry or replay its snapshot. */
function isSharedLeases(value: unknown): value is SharedLeases {
  if (typeof value !== "object" || value === null) return false;
  try {
    const state = value as Partial<SharedLeases>;
    const registry = state.registry;
    return state.listeners instanceof Set
      && typeof state.refs === "number" && Number.isSafeInteger(state.refs)
      && typeof state.initializing === "boolean" && (state.initializing ? state.refs === 0 : state.refs > 0)
      && typeof state.logger?.warn === "function"
      && typeof registry === "object" && registry !== null
      && ["acquireWrite", "checkRead", "checkRun", "filterSearchResults", "planHolderOf", "release", "releaseTask", "sweep", "snapshot", "restore"]
        .every(method => typeof Reflect.get(registry, method) === "function");
  } catch {
    return false;
  }
}

function sharedLeaseRegistries(): Map<string, unknown> {
  const existing: unknown = Reflect.get(globalThis, SHARED_LEASES_KEY);
  if (isSharedLeaseRegistries(existing)) return existing.registries;
  const state: SharedLeaseRegistries = { version: 1, registries: new Map() };
  Reflect.set(globalThis, SHARED_LEASES_KEY, state);
  return state.registries;
}

/**
 * Acquires the process-wide lease registry (ref-counted). The first acquirer's seams, run mode and snapshot win.
 * Initialization is synchronous: no guard can acquire a live lease before restoration completes, and subsequent
 * adapters never restore over live state (including when the first snapshot was absent or invalid).
 */
export function acquireLeaseRegistry(opts: {
  runMode: "annotate" | "refuse";
  seams: LeaseSeams;
  snapshotPath: string;
  logger: Logger;
  /** Optional synchronous loader, called only when creating the shared registry. */
  loadSnapshot?(): unknown;
}): LeaseRegistryHandle {
  const registries = sharedLeaseRegistries();
  let shared: SharedLeases;
  if (registries.has(opts.snapshotPath)) {
    const existing = registries.get(opts.snapshotPath);
    // Do not guess whether malformed state still owns live leases. Refuse acquisition without replacing it.
    if (!isSharedLeases(existing)) throw new Error("lease registry state is invalid");
    shared = existing;
  } else {
    shared = {
      registry: createLeaseRegistry(opts.seams, { runMode: opts.runMode }),
      listeners: new Set(),
      refs: 0,
      logger: opts.logger,
      initializing: true,
    };
    registries.set(opts.snapshotPath, shared);
    try {
      if (opts.loadSnapshot !== undefined) {
        const restored = shared.registry.restore(opts.loadSnapshot(), { dropCompleteHolders: true });
        if (!restored.ok) warnSafe(shared.logger, "[router] leases: the snapshot was rejected", { error: restored.message });
        else if (restored.skipped !== undefined) warnSafe(shared.logger, "[router] leases: snapshot lines skipped on restore", { skipped: restored.skipped });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") warnSafe(shared.logger, "[router] leases: the snapshot could not be restored", { error: String(error) });
    } finally {
      shared.initializing = false;
    }
  }
  // A synchronous loader must not re-enter acquisition and expose the registry before its restore.
  if (shared.initializing) throw new Error("lease registry initialization is already in progress");
  shared.refs += 1;
  const state = shared;
  let released = false;
  return {
    registry: state.registry,
    onRelease(cb) {
      state.listeners.add(cb);
      return () => {
        state.listeners.delete(cb);
      };
    },
    notifyReleased() {
      for (const cb of [...state.listeners]) {
        try {
          cb();
        } catch (error) {
          warnSafe(state.logger, "[router] lease release listener failed", { error: errorText(error) });
        }
      }
    },
    async release() {
      if (released) return;
      released = true;
      state.refs -= 1;
      if (state.refs <= 0 && registries.get(opts.snapshotPath) === state) registries.delete(opts.snapshotPath);
    },
  };
}

/** Observes an existing, initialized registry without creating one or extending its lifetime. */
export function peekLeaseRegistry(snapshotPath: string): LeaseRegistry | undefined {
  const state: unknown = Reflect.get(globalThis, SHARED_LEASES_KEY);
  if (!isSharedLeaseRegistries(state)) return undefined;
  const shared = state.registries.get(snapshotPath);
  return isSharedLeases(shared) && !shared.initializing ? shared.registry : undefined;
}

export interface LeaseGuard {
  /** Before a file / git / run tool call: a refusal text, and/or a note to append to a run's result. */
  before(e: { sessionID: string; tool: string; args: unknown; callID: string }): Promise<{ refuse?: string; runNote?: string }>;
  /** After a host `glob`/`grep` of a child session: the filtered result plus one note line; `undefined` = unchanged. */
  /**
   * `e.result` is the host's `execute.after` result of a `glob`/`grep` call, exactly as received: `content` is a string or an array
   * of `{type:"text", text}` parts (the model-facing text, one hit per line), and `output` is the structured form (a string, an
   * object with a string `output`, or an array of hits: a path string, `{path}` or `{entry:{path}}`). Returns the rewritten host
   * result (both forms filtered together) plus one note line, or `undefined` when nothing is omitted.
   */
  afterSearch(e: { sessionID: string; tool: "glob" | "grep"; result: unknown }): { result: unknown; note?: string } | undefined;
  /** Until-complete leases only; until-integrated ones are retained (leases.ts §5). */
  releaseChild(child: string): void;
  /** Waits until no other holder edits `tree` (or the deadline); never throws. */
  waitTreeFree(
    tree: string,
    owner: { producer: string; taskRef?: string },
    deadlineMs: number,
    signal: AbortSignal,
  ): Promise<{ waitedMs: number; holders: string[]; fileCount: number }>;
}

export interface LeaseGuardDeps {
  registry: LeaseRegistry;
  /** `unknown` (or a rejection): the kind could not be read; root semantics, child wording (QA-2.1-11). */
  sessionKind(sid: string): Promise<"root" | "child" | "unknown">;
  sessionDir(sid: string): Promise<string>;
  gitRootOf(dir: string): string | undefined;
  holderLabel(holderID: string): string;
  /** Seam; `undefined` in 2.1 (filled in by 3.1). */
  planTaskOf(sid: string): { planId: string; taskId: string; slot: string } | undefined;
  events: { onRelease(cb: () => void): () => void };
  logger?: Logger;
  now?(): number;
}

const TREE_POLL_MS = 5000;
/** Bound of one host lookup (session kind / directory) made from inside a tool hook. */
const LOOKUP_TIMEOUT_MS = 5000;
const MAX_ACTOR_CACHE = 1000;
/**
 * QA-2.1-11: a failed session-directory lookup is not repeated for this long. QA-2.1-25: short, because the failure means no
 * lease check and no lease for the call (a child's write goes unguarded); the window only spares a burst of tool calls.
 */
export const LEASE_LOOKUP_NEGATIVE_TTL_MS = 2_000;
/** QA-2.1-13: warn-once keys remembered. */
const MAX_WARNED_KEYS = 1000;

/** A resolved lease actor (QA-2.1-11: `childWording` = the kind is child, or unknown). */
interface Actor {
  kind: "root" | "child";
  tree: string;
  dir: string;
  childWording: boolean;
}

/** The task reference of a plan task (the owner of the leases of its slot); = `leaseTaskRef` (executor/types.ts:1446). */
function planTaskRef(planId: string, taskId: string): string {
  return `${planId}:${taskId}`;
}

function holderLabels(deps: LeaseGuardDeps, holders: readonly Holder[]): string {
  return holders.map((h) => deps.holderLabel(h.holderID)).join(", ");
}

/** The entry of a search result line that names a file. */
function searchEntryPath(tool: "glob" | "grep", line: string): string {
  if (tool === "glob") return line.trim();
  const match = /^((?:[A-Za-z]:)?[^:]+?):\d+[:-]/.exec(line);
  return match === null ? line.trim() : (match[1] ?? line.trim());
}

/**
 * Creates the lease guard (memo §14): maps tool calls to registry calls and registry answers to the router's
 * refusal texts. Roots take no lease; a failed session-kind lookup means root semantics.
 */
export function createLeaseGuard(deps: LeaseGuardDeps): LeaseGuard {
  /** QA-2.1-11: resolved actors, cached per session (bounded); an actor whose kind lookup failed is not cached (retried). */
  const actors = new Map<string, Actor>();
  /** QA-2.1-11: negative cache: a failed directory lookup is not repeated for LEASE_LOOKUP_NEGATIVE_TTL_MS. */
  const failedLookups = new Map<string, number>();
  /** QA-2.1-13: bounded (oldest first out), so per-session keys cannot grow it without end. */
  const warned = new Set<string>();
  const now = deps.now ?? (() => Date.now());

  function warnOnce(key: string, message: string, meta?: object): void {
    if (warned.has(key) || deps.logger === undefined) return;
    addBounded(warned, key, MAX_WARNED_KEYS);
    warnSafe(deps.logger, message, meta);
  }

  /** A host lookup that never answers must not hang the tool call it guards (memo §14.1: fall back to root semantics). */
  async function bounded<T>(lookup: Promise<T>, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${LOOKUP_TIMEOUT_MS} ms`)), LOOKUP_TIMEOUT_MS);
    });
    try {
      return await Promise.race([lookup, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async function resolveActor(sessionID: string): Promise<Actor | undefined> {
    // QA-2.1-11: one host lookup per session, not one per tool call.
    const cached = actors.get(sessionID);
    if (cached !== undefined) return cached;
    const failedAt = failedLookups.get(sessionID);
    if (failedAt !== undefined && now() - failedAt < LEASE_LOOKUP_NEGATIVE_TTL_MS) return undefined;
    let kind: "root" | "child" = "root";
    let kindKnown = true;
    try {
      const looked = await bounded(deps.sessionKind(sessionID), "session kind lookup");
      // QA-2.1-11: a lookup that answers `unknown` (the adapter's own failed or negatively cached lookup) is a failed one.
      if (looked === "unknown") kindKnown = false;
      else kind = looked;
    } catch (error) {
      kindKnown = false;
      warnOnce(`kind:${sessionID}`, "[router] lease session kind lookup failed; treating as root", { error: errorText(error) });
    }
    let dir: string;
    try {
      dir = await bounded(deps.sessionDir(sessionID), "session directory lookup");
    } catch (error) {
      failedLookups.delete(sessionID);
      failedLookups.set(sessionID, now());
      trimMap(failedLookups, MAX_ACTOR_CACHE, () => false);
      warnOnce(`dir:${sessionID}`, "[router] lease session directory lookup failed; no lease check", { error: errorText(error) });
      return undefined;
    }
    failedLookups.delete(sessionID);
    const gitRoot = deps.gitRootOf(dir);
    // QA-2.1-11: an unknown kind keeps root semantics (no lease taken) but gets the child's wording: it may well be a child.
    const entry: Actor = { kind, dir, tree: foldKeyPath(gitRoot ?? dir), childWording: kind === "child" || !kindKnown };
    if (kindKnown) {
      actors.delete(sessionID);
      actors.set(sessionID, entry);
      trimMap(actors, MAX_ACTOR_CACHE, () => false);
    }
    return entry;
  }

  function holderOf(sessionID: string, a: { kind: "root" | "child"; tree: string }): HolderInput {
    if (a.kind === "root") return { holderID: sessionID, tree: a.tree, isChild: false, scope: "until-complete" };
    const task = deps.planTaskOf(sessionID);
    if (task === undefined) return { holderID: sessionID, tree: a.tree, isChild: true, scope: "until-complete" };
    return {
      holderID: sessionID,
      tree: foldKeyPath(task.slot),
      isChild: true,
      taskRef: planTaskRef(task.planId, task.taskId),
      scope: "until-integrated",
    };
  }

  function actorOf(h: HolderInput): LeaseActor {
    return h.taskRef === undefined
      ? { holderID: h.holderID, tree: h.tree, isChild: h.isChild }
      : { holderID: h.holderID, tree: h.tree, isChild: h.isChild, taskRef: h.taskRef };
  }

  return {
    async before(e) {
      try {
        const a = await resolveActor(e.sessionID);
        if (a === undefined) return {};
        const gitRoot = deps.gitRootOf(a.dir);
        const targets = toolTargets(e.tool, e.args, a.dir, gitRoot === undefined ? undefined : { gitRoot });
        const holder = holderOf(e.sessionID, a);
        const registry = deps.registry;

        if (targets.access !== "write" && targets.gitRootRequired === true) {
          // A git call with no known git root names no concrete target: an unknown target (leases.ts handoffs). Outside any
          // repository the registry cannot scope the check to one, so a child is refused while any other holder has leases.
          if (!holder.isChild) return {};
          const snapshot = registry.snapshot();
          const others = snapshot.holders.filter((h) => h.holderID !== holder.holderID && snapshot.leases.some((l) => l.holderID === h.holderID));
          if (others.length === 0) return {};
          return {
            refuse: `[router] Refused: this ${e.tool} call names no file the router can check, and ${holderLabels(deps, others)} is editing files in this repository. Pass the file path explicitly, or return \`NEED MORE: lease ${holder.tree}\`.`,
          };
        }

        if (targets.access === "write") {
          const known = targets.paths.length > 0 && targets.gitRootRequired !== true;
          const r = registry.acquireWrite(holder, known ? targets.paths : null);
          if (r.ok) return {};
          if (r.reason === "held") {
            const who = holderLabels(deps, r.holders);
            // QA-PDF13-7: the text names the file under edit (`heldPath`, the holder's copy); the `NEED MORE: lease` names the
            // requester's own path (`path`, repo-relative for a plan task, as the plan runtime resolves it).
            if (!holder.isChild && !a.childWording) return { refuse: `[router] Refused: ${r.heldPath} is being edited by ${who}. Wait for that session to end.` };
            return {
              refuse: `[router] Refused: ${r.heldPath} is being edited by ${who}. Finish without that file, or return \`NEED MORE: lease ${r.path}\`. Do not retry: the lease ends when that session ends.`,
            };
          }
          if (r.reason === "unknown-target") {
            // DF-1.1-4: an unknown target is checked in the writer's checkout, a plan task's across the repository; a spelling
            // that may name any file fails closed against every holder (QA-PDF13-10).
            const place = r.where === "anywhere" ? "anywhere (this path may name any file)" : `in this ${r.where}`;
            return {
              refuse: `[router] Refused: this ${e.tool} call names no file the router can check, and ${holderLabels(deps, r.holders)} is editing files ${place}. Pass the file path explicitly, or return \`NEED MORE: lease ${holder.tree}\`.`,
            };
          }
          if (r.reason === "cap") {
            return { refuse: `[router] Refused: too many files are leased (${r.limit}). Return \`NEED MORE: lease ${targets.paths[0] ?? holder.tree}\`.` };
          }
          // invalid-holder: writes fail closed.
          warnOnce(`invalid:${e.sessionID}`, "[router] lease holder invalid; writes are refused", { message: r.message });
          return { refuse: `[router] Refused: the lease registry rejected this session (${r.message}).` };
        }

        if (targets.access === "read") {
          const actor = actorOf(holder);
          for (const path of targets.paths) {
            const r = registry.checkRead(actor, path);
            if (r.ok) continue;
            if (r.reason === "underEdit") {
              return {
                refuse: `[router] Refused: ${r.path} is under edit by ${holderLabels(deps, r.holders)}. Finish without it, or return \`NEED MORE: lease ${r.path}\`.`,
              };
            }
            warnOnce(`invalid:${e.sessionID}`, "[router] lease holder invalid; reads are allowed", { message: r.message });
          }
          return {};
        }

        if (targets.access === "run") {
          const tree = targets.roots[0] === undefined ? a.tree : foldKeyPath(targets.roots[0]);
          const r = registry.checkRun(actorOf(holder), tree);
          if (r.ok) {
            if ("contaminatedBy" in r) {
              return { runNote: formatRunNote(r.contaminatedBy.map((h) => deps.holderLabel(h.holderID)), r.fileCount) };
            }
            return {};
          }
          if (r.reason === "run-refused") {
            return {
              refuse: `[router] Refused: router_run in ${tree} while ${holderLabels(deps, r.holders)} edits ${r.fileCount} file(s) there. Wait for that session to end, or return \`NEED MORE: lease ${tree}\`.`,
            };
          }
          warnOnce(`invalid:${e.sessionID}`, "[router] lease holder invalid; runs are allowed", { message: r.message });
          return {};
        }
        return {};
      } catch (error) {
        // The guard must never block the orchestrator because of its own fault.
        warnOnce("before-fault", "[router] lease guard failed; call allowed", { error: errorText(error) });
        return {};
      }
    },

    afterSearch(e) {
      try {
        const a = actors.get(e.sessionID);
        if (a === undefined || a.kind !== "child") return undefined;
        const actor = actorOf(holderOf(e.sessionID, a));
        /** Filters `items` by the path each names; an item naming no path is always kept. */
        const filterBy = <T,>(items: readonly T[], pathOf: (item: T) => string | undefined): { kept: T[]; omitted: number; label: string } | undefined => {
          const paths = items.map(pathOf);
          const named = paths.filter((p): p is string => p !== undefined);
          const r = deps.registry.filterSearchResults(actor, actor.tree, named);
          if (r.omitted === 0) return undefined;
          const left = new Map<string, number>();
          for (const p of r.kept) left.set(p, (left.get(p) ?? 0) + 1);
          const kept = items.filter((_, i) => {
            const p = paths[i];
            if (p === undefined) return true;
            const n = left.get(p) ?? 0;
            if (n === 0) return false;
            left.set(p, n - 1);
            return true;
          });
          return { kept, omitted: r.omitted, label: holderLabels(deps, r.holders) };
        };
        const noteOf = (omitted: number, label: string): string => `[router] ${omitted} result(s) omitted: under edit by ${label}.`;
        // Plain text or a list of lines (callers that already extracted the text).
        if (typeof e.result === "string") {
          const f = filterBy(e.result.split("\n"), (line) => searchEntryPath(e.tool, line));
          return f === undefined ? undefined : { result: f.kept.join("\n"), note: noteOf(f.omitted, f.label) };
        }
        if (Array.isArray(e.result) && e.result.every((x: unknown) => typeof x === "string")) {
          const f = filterBy(e.result as string[], (line) => searchEntryPath(e.tool, line));
          return f === undefined ? undefined : { result: f.kept, note: noteOf(f.omitted, f.label) };
        }
        // The host's `execute.after` result: `content` (text or text parts) and `output` (text, `{output}` or an array of hits).
        const host = asRecord(e.result);
        if (host === undefined || (!("content" in host) && !("output" in host))) return undefined;
        let omitted = 0;
        let label = "";
        const lines = (text: string): string => {
          const f = filterBy(text.split("\n"), (line) => searchEntryPath(e.tool, line));
          if (f === undefined) return text;
          if (f.omitted > omitted) { omitted = f.omitted; label = f.label; }
          return f.kept.join("\n");
        };
        const next: Record<string, unknown> = { ...host };
        const content = host.content;
        if (typeof content === "string") next.content = lines(content);
        else if (Array.isArray(content)) {
          next.content = content.map((part: unknown) => {
            const p = asRecord(part);
            if (p === undefined || typeof p.text !== "string" || (p.type !== undefined && p.type !== "text")) return part;
            const text = lines(p.text);
            return text === p.text ? part : { ...p, text };
          });
        }
        const output = host.output;
        if (typeof output === "string") next.output = lines(output);
        else if (Array.isArray(output)) {
          const f = filterBy(output as unknown[], (item) => {
            if (typeof item === "string") return item;
            const rec = asRecord(item);
            const entry = asRecord(rec?.entry);
            const path = entry?.path ?? rec?.path;
            return typeof path === "string" ? path : undefined;
          });
          if (f !== undefined) {
            next.output = f.kept;
            if (f.omitted > omitted) { omitted = f.omitted; label = f.label; }
          }
        } else {
          const wrapped = asRecord(output);
          if (wrapped !== undefined && typeof wrapped.output === "string") next.output = { ...wrapped, output: lines(wrapped.output) };
        }
        return omitted === 0 ? undefined : { result: next, note: noteOf(omitted, label) };
      } catch (error) {
        warnOnce("search-fault", "[router] lease search filter failed; result unchanged", { error: errorText(error) });
        return undefined;
      }
    },

    releaseChild(child) {
      try {
        deps.registry.release(child);
      } catch (error) {
        warnOnce("release-fault", "[router] lease release failed", { error: errorText(error) });
      }
      actors.delete(child);
    },

    async waitTreeFree(tree, owner, deadlineMs, signal) {
      const started = now();
      const actor: LeaseActor =
        owner.taskRef === undefined
          ? { holderID: `verify:${owner.producer}`, tree, isChild: true }
          : { holderID: `verify:${owner.producer}`, tree, isChild: true, taskRef: owner.taskRef };
      let holders: string[] = [];
      let fileCount = 0;
      const probe = (): boolean => {
        try {
          const r = deps.registry.checkRun(actor, tree);
          if (r.ok && !("contaminatedBy" in r)) return true;
          if (r.ok) {
            holders = r.contaminatedBy.map((h) => h.holderID);
            fileCount = r.fileCount;
            return false;
          }
          if (r.reason === "run-refused") {
            holders = r.holders.map((h) => h.holderID);
            fileCount = r.fileCount;
            return false;
          }
          return true;
        } catch (error) {
          warnOnce("wait-fault", "[router] lease wait probe failed; not waiting", { error: errorText(error) });
          return true;
        }
      };
      while (!probe()) {
        const left = deadlineMs - (now() - started);
        if (left <= 0 || signal.aborted) break;
        await new Promise<void>((resolve) => {
          let unsubscribe: () => void = () => undefined;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const done = (): void => {
            if (timer !== undefined) clearTimeout(timer);
            unsubscribe();
            signal.removeEventListener("abort", done);
            resolve();
          };
          unsubscribe = deps.events.onRelease(done);
          signal.addEventListener("abort", done);
          timer = setTimeout(done, Math.min(left, TREE_POLL_MS));
        });
      }
      if (!probe()) return { waitedMs: now() - started, holders, fileCount };
      return { waitedMs: now() - started, holders: [], fileCount: 0 };
    },
  };
}
