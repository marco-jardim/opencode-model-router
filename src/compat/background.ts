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
  finish(input: FinishInput): Promise<FinishResult>;
}

export type FinishAttach = (deps: { host: "v2"; held: HeldSink }) => FinishApi | undefined;

// ---- in-flight registry ----------------------------------------------------------------------

export type AttemptState =
  | "decided" | "acknowledged" | "child-ended" | "processing" | "annotated" | "held" | "verdict"
  | "released" | "foreground" | "cancelled" | "closed-unknown";

export interface CallRecord {
  callID: string;
  parentSessionID: string;
  agent: string;
  role?: string;
  description: string;
  verifying: boolean;
  verificationMode: VerificationMode;
  decision: BackgroundDecision;
  resumeOf?: string;
  at: number;
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
  liveCount(): number;
  forgetSession(sessionID: string): void;
  /** Open for longer than `ATTEMPT_SWEEP_AGE_MS` becomes `closed-unknown`; the closed attempts are returned. */
  sweep(now: number): readonly Attempt[];
}

/** Why the registry closed an open attempt without an end (the owner posts the verdict of a held one). */
export type CloseCause = "superseded" | "sweep";

const OPEN_STATES: ReadonlySet<AttemptState> = new Set<AttemptState>(["acknowledged", "child-ended", "processing", "held"]);
const TERMINAL_STATES: ReadonlySet<AttemptState> = new Set<AttemptState>(["released", "foreground", "cancelled", "closed-unknown"]);

/** Process-wide call claims (`bg:<callID>`), shared by every plugin instance of the process; bounded. */
const PROCESS_CLAIMS = new Set<string>();
const MAX_CLAIMS = 1000;

/** The attempt key (memo §10). */
export function attemptKey(childSessionID: string, callID: string): string {
  return `${childSessionID}\u0000${callID}`;
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
  const claims = deps.claims ?? PROCESS_CLAIMS;
  const calls = new Map<string, CallRecord | Attempt>();
  const attempts = new Map<string, Attempt>();
  const newestByChild = new Map<string, string>();
  const earlyEnds = new Map<string, EndFact>();

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
      if (claims.size > MAX_CLAIMS) {
        for (const old of claims) {
          if (claims.size <= MAX_CLAIMS) break;
          claims.delete(old);
        }
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
      earlyEnds.set(child, end);
      trimMap(earlyEnds, MAX_EARLY_ENDS, () => false);
    },

    takeEarlyEnd(child) {
      const end = earlyEnds.get(child);
      if (end === undefined) return undefined;
      earlyEnds.delete(child);
      return deps.now() - end.at > EARLY_END_TTL_MS ? undefined : end;
    },

    listForParent(parent) {
      const out: Attempt[] = [];
      for (const a of attempts.values()) if (a.parentSessionID === parent) out.push(a);
      return out;
    },

    liveCount() {
      let n = 0;
      for (const rec of calls.values()) {
        if (!isAttempt(rec) || OPEN_STATES.has(rec.state)) n += 1;
      }
      return n;
    },

    forgetSession(sessionID) {
      for (const [callID, rec] of calls) {
        if (rec.parentSessionID === sessionID || (isAttempt(rec) && rec.childSessionID === sessionID)) {
          calls.delete(callID);
          if (isAttempt(rec)) dropAttempt(rec.key);
        }
      }
      earlyEnds.delete(sessionID);
    },

    sweep(now) {
      const closed: Attempt[] = [];
      for (const a of attempts.values()) {
        if (!OPEN_STATES.has(a.state)) continue;
        if (now - (a.ackAt ?? a.at) <= ATTEMPT_SWEEP_AGE_MS) continue;
        closeOpen(a, "sweep");
        closed.push(a);
      }
      for (const [child, end] of earlyEnds) if (now - end.at > EARLY_END_TTL_MS) earlyEnds.delete(child);
      for (const [callID, rec] of calls) {
        if (!isAttempt(rec) && now - rec.at > ATTEMPT_SWEEP_AGE_MS) calls.delete(callID);
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
  /** Appends the hold record (fsync), then makes it active. */
  hold(rec: HeldRecord): Promise<void>;
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
  restore(records: readonly PersistedRecord[]): void;
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
}

/**
 * Creates the held-result store (memo §5, §7). Holds are bounded per parent and globally; the placeholder of a
 * released hold stays in force for the session's life (the host history keeps the original, C4).
 */
export function createHeldResults(deps: {
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
  const now = deps.now ?? (() => Date.now());
  const retryBase = deps.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  function remove(entry: HoldEntry): void {
    byHandle.delete(entry.handle);
    const children = byParent.get(entry.parentSessionID);
    if (children === undefined) return;
    if (children.get(entry.childSessionID) === entry) children.delete(entry.childSessionID);
    if (children.size === 0) byParent.delete(entry.parentSessionID);
  }

  function insert(entry: HoldEntry): void {
    let children = byParent.get(entry.parentSessionID);
    if (children === undefined) {
      children = new Map();
      byParent.set(entry.parentSessionID, children);
    }
    children.set(entry.childSessionID, entry);
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

  function applyText(sessionID: string, text: string): string {
    if (text.startsWith(VERDICT_PREFIX)) return text;
    let out = text;
    for (const entry of heldChildren(sessionID)) {
      const marker = `<subagent sessionID="${entry.childSessionID}"`;
      const placeholder = heldPlaceholder(entry.handle, entry.childSessionID);
      let from = 0;
      for (;;) {
        const at = out.indexOf(marker, from);
        if (at < 0) break;
        if (out.startsWith(placeholder, at)) {
          from = at + placeholder.length;
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
    const text = verdictText(entry.handle, entry.childSessionID, v);
    await deps.journal.append({ v: 1, kind: "posting", handle: entry.handle, at: now() });
    let lastError: unknown;
    for (let attempt = 0; attempt < SYNTHETIC_ATTEMPTS; attempt += 1) {
      try {
        await deps.synthetic({
          sessionID: entry.parentSessionID,
          text,
          description: "Model router verdict",
          metadata: { router: { kind: "held-verdict", handle: entry.handle, child: entry.childSessionID } },
          resume: true,
        });
        await deps.journal.append({ v: 1, kind: "posted", handle: entry.handle, at: now() });
        entry.active = false;
        entry.status = "released";
        return;
      } catch (error) {
        lastError = error;
        if (attempt < SYNTHETIC_ATTEMPTS - 1) await sleep(retryBase * 2 ** attempt);
      }
    }
    // Keep `posting`: the next start finds the journal entry and decides again (R21).
    warnSafe(deps.logger, "[router] held verdict not posted; kept for the next start", {
      handle: entry.handle,
      error: errorText(lastError),
    });
  }

  return {
    available: deps.available,

    async hold(rec) {
      if (!deps.available) throw new Error("holding is not available");
      if (!makeRoom(rec.parentSessionID)) throw new Error("hold capacity reached");
      await deps.journal.append(
        { v: 1, kind: "hold", handle: rec.handle, parent: rec.parentSessionID, child: rec.childSessionID, callID: rec.callID, at: now() },
        { fsync: true },
      );
      insert({ ...rec, active: true, posting: false, status: "verifying" });
    },

    isHeld(child) {
      for (const children of byParent.values()) if (children.get(child)?.active === true) return true;
      return false;
    },

    placeholder: heldPlaceholder,
    applyText,

    apply<M>(sessionID: string, messages: readonly M[]): M[] | undefined {
      if (!byParent.has(sessionID)) return undefined;
      let changed = false;
      const out = messages.map((message) => {
        const next = redactMessage(message, (text) => applyText(sessionID, text));
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
      if (entry === undefined || !entry.active || entry.posting) return;
      entry.posting = true;
      try {
        await post(entry, v);
      } catch (error) {
        warnSafe(deps.logger, "[router] held verdict journal failed", { handle, error: errorText(error) });
      } finally {
        entry.posting = false;
      }
    },

    forgetSession(sessionID) {
      for (const entry of heldChildren(sessionID)) remove(entry);
      deps.journal.append({ v: 1, kind: "forget", session: sessionID, at: now() }).catch((error: unknown) => {
        warnSafe(deps.logger, "[router] held forget not journaled", { sessionID, error: errorText(error) });
      });
    },

    restore(records) {
      for (const r of records) {
        if (r.kind === "hold" && typeof r.handle === "string" && typeof r.parent === "string" && typeof r.child === "string") {
          insert({
            handle: r.handle,
            parentSessionID: r.parent,
            childSessionID: r.child,
            callID: typeof r.callID === "string" ? r.callID : "",
            active: true,
            posting: false,
            status: "verifying",
          });
        } else if (r.kind === "posted" && typeof r.handle === "string") {
          const e = byHandle.get(r.handle);
          if (e !== undefined) e.active = false;
        } else if (r.kind === "forget" && typeof r.session === "string") {
          for (const e of heldChildren(r.session)) remove(e);
        }
      }
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
  finish: FinishApi["finish"];
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
  /** The change set at child end (verify/dispatch.ts `captureDelta`, 2.1.4.b); absent = none. */
  captureDelta?(callID: string, child: string): Promise<unknown>;
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
      }
      a.state = handle !== undefined ? "released" : "annotated";
      return;
    }

    ctx.text = text;
    const status = end.status ?? "unknown";
    let delta: unknown;
    if (deps.captureDelta !== undefined) {
      try {
        delta = await deps.captureDelta(a.callID, a.childSessionID);
      } catch (error) {
        warnSafe(deps.logger, "[router] change-set capture failed", { callID: a.callID, error: errorText(error) });
      }
    }
    const notices = await deps.roleCompletion(a, text);
    const holdForGate = status === "succeeded" ? handle : undefined;
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
    }
    a.state = deps.held.isHeld(a.childSessionID) ? "held" : handle !== undefined ? "released" : "annotated";
  }

  async function run(child: string, trigger: Trigger): Promise<void> {
    // Everything up to the first await is synchronous: the state flip below is what makes a second trigger a no-op.
    const a = reg.byChild(child);
    if (a === undefined) return;
    if (a.state !== "acknowledged" && a.state !== "child-ended") return;
    if (wasProcessed(a.key)) return;
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
      const lines: Array<{ at: number; line: CompletedLine }> = [];
      for (const a of reg.listForParent(parent)) {
        refresh(a);
        const at = a.endedAt ?? a.at;
        const line = (text: string): CompletedLine => ({ child: a.childSessionID, label: attemptLabel(a), text });
        if (a.state === "child-ended" || a.state === "processing") {
          a.pendingShown = true;
          lines.push({ at, line: line(PENDING_GUARANTEES_TEXT) });
        } else if (a.state === "annotated" || (a.state === "closed-unknown" && a.annotations.length > 0)) {
          if (a.shownInTurn !== undefined && a.shownInTurn !== turn) continue;
          a.shownInTurn = turn;
          const text = a.annotations.join(" ").replace(/\s+/g, " ").trim();
          lines.push({ at, line: line(text.length > 0 ? text : "completed") });
        }
      }
      lines.sort((x, y) => x.at - y.at);
      return lines.slice(-MAX_COMPLETED_PER_PARENT).map((l) => l.line);
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
        a.annotations = [`[router] the dispatch ended without a result (${reason})`];
        releaseLeasesSafe(a.childSessionID);
        const handle = a.hold?.handle;
        if (handle !== undefined && deps.held.isHeld(a.childSessionID)) {
          await verdictSafe(handle, { verdict: "UNVERIFIABLE", text: `[router] not verified: ${reason}`, reason });
        }
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
  const live = attempts.filter((a) => a.state === "acknowledged");
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
}

/** Shared registries by snapshot path: every plugin instance of the process sees one set of leases. */
const SHARED_LEASES = new Map<string, SharedLeases>();

/**
 * Acquires the process-wide lease registry (ref-counted). The first acquirer's seams and run mode win. The
 * `until-integrated` snapshot at `snapshotPath` is inert in 2.1 (no such holder exists before 3.1), so nothing
 * touches the filesystem here.
 */
export function acquireLeaseRegistry(opts: {
  runMode: "annotate" | "refuse";
  seams: LeaseSeams;
  snapshotPath: string;
  logger: Logger;
}): LeaseRegistryHandle {
  let shared = SHARED_LEASES.get(opts.snapshotPath);
  if (shared === undefined) {
    shared = {
      registry: createLeaseRegistry(opts.seams, { runMode: opts.runMode }),
      listeners: new Set(),
      refs: 0,
      logger: opts.logger,
    };
    SHARED_LEASES.set(opts.snapshotPath, shared);
  }
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
      if (state.refs <= 0 && SHARED_LEASES.get(opts.snapshotPath) === state) SHARED_LEASES.delete(opts.snapshotPath);
    },
  };
}

export interface LeaseGuard {
  /** Before a file / git / run tool call: a refusal text, and/or a note to append to a run's result. */
  before(e: { sessionID: string; tool: string; args: unknown; callID: string }): Promise<{ refuse?: string; runNote?: string }>;
  /** After a host `glob`/`grep` of a child session: the filtered result plus one note line; `undefined` = unchanged. */
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
  sessionKind(sid: string): Promise<"root" | "child">;
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
const MAX_ACTOR_CACHE = 1000;

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
  const actors = new Map<string, { kind: "root" | "child"; tree: string; dir: string }>();
  const warned = new Set<string>();
  const now = deps.now ?? (() => Date.now());

  function warnOnce(key: string, message: string, meta?: object): void {
    if (warned.has(key) || deps.logger === undefined) return;
    warned.add(key);
    warnSafe(deps.logger, message, meta);
  }

  async function resolveActor(sessionID: string): Promise<{ kind: "root" | "child"; tree: string; dir: string } | undefined> {
    let kind: "root" | "child" = "root";
    try {
      kind = await deps.sessionKind(sessionID);
    } catch (error) {
      warnOnce(`kind:${sessionID}`, "[router] lease session kind lookup failed; treating as root", { error: errorText(error) });
    }
    let dir: string;
    try {
      dir = await deps.sessionDir(sessionID);
    } catch (error) {
      warnOnce(`dir:${sessionID}`, "[router] lease session directory lookup failed; no lease check", { error: errorText(error) });
      return undefined;
    }
    const gitRoot = deps.gitRootOf(dir);
    const entry = { kind, dir, tree: foldKeyPath(gitRoot ?? dir) };
    actors.delete(sessionID);
    actors.set(sessionID, entry);
    trimMap(actors, MAX_ACTOR_CACHE, () => false);
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

        if (targets.access === "write") {
          const known = targets.paths.length > 0 && targets.gitRootRequired !== true;
          const r = registry.acquireWrite(holder, known ? targets.paths : null);
          if (r.ok) return {};
          if (r.reason === "held") {
            const who = holderLabels(deps, r.holders);
            if (!holder.isChild) return { refuse: `[router] Refused: ${r.path} is being edited by ${who}. Wait for that session to end.` };
            return {
              refuse: `[router] Refused: ${r.path} is being edited by ${who}. Finish without that file, or return \`NEED MORE: lease ${r.path}\`. Do not retry: the lease ends when that session ends.`,
            };
          }
          if (r.reason === "unknown-target") {
            return {
              refuse: `[router] Refused: this ${e.tool} call names no file the router can check, and ${holderLabels(deps, r.holders)} is editing files in this repository. Pass the file path explicitly, or return \`NEED MORE: lease ${holder.tree}\`.`,
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
        const isText = typeof e.result === "string";
        const entries: string[] | undefined = isText
          ? (e.result as string).split("\n")
          : Array.isArray(e.result) && e.result.every((x: unknown) => typeof x === "string")
            ? (e.result as string[])
            : undefined;
        if (entries === undefined) return undefined;
        const paths = entries.map((line) => searchEntryPath(e.tool, line));
        const r = deps.registry.filterSearchResults(actor, actor.tree, paths);
        if (r.omitted === 0) return undefined;
        const left = new Map<string, number>();
        for (const p of r.kept) left.set(p, (left.get(p) ?? 0) + 1);
        const kept = entries.filter((_, i) => {
          const p = paths[i] ?? "";
          const n = left.get(p) ?? 0;
          if (n === 0) return false;
          left.set(p, n - 1);
          return true;
        });
        return {
          result: isText ? kept.join("\n") : kept,
          note: `[router] ${r.omitted} result(s) omitted: under edit by ${holderLabels(deps, r.holders)}.`,
        };
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
