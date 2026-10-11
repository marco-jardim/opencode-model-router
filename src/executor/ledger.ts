// Durable ledger store (plan task 2.2.2): snapshot + journal + history under one writer lock, all I/O through the `FileSystem` seam.
// Nothing here touches the filesystem, the clock or the process at module load.
import { randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";
import * as nodeFsp from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { isPlanId, planDir, SLOT_MARKERS_DIRNAME } from "./paths.js";
import {
  GATE_TRANSITION_TRIGGERS,
  INBOX_ID_PATTERN,
  INBOX_ID_PREFIX,
  LEDGER_SCHEMA,
  RESERVED_TASK_IDS,
  TRANSITION_TRIGGERS,
  ExecutorError,
  canGateTransition,
  canStatusTransition,
  canTransition,
  isDurableEvent,
  isHistoryEvent,
  isLedgerV1,
  ledgerSchemaOf,
  ledgerViolations,
  type Attempt,
  type BatchBuilder,
  type Clock,
  type ExecutorEvent,
  type ExecutorEventInput,
  type FileSystem,
  type FsStat,
  type GateRef,
  type GateTransitionKey,
  type IntegrationEntry,
  type IntegrationStep,
  type IntegrationStepResult,
  type JsonValue,
  type LedgerStatus,
  type LedgerStore,
  type LedgerV1,
  type LedgerWriter,
  type LockHolder,
  type OpenIntegrationEntry,
  type PlanId,
  type TaskNode,
  type TransitionKey,
} from "./types.js";

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function hasOwn(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}
function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** One parsed journal line: the event and its exact original text (history copies are byte-identical). */
interface JournalLine {
  event: ExecutorEvent;
  text: string;
}

interface ParsedJournal {
  lines: JournalLine[];
  /** A torn (unparsable / unterminated) last line was dropped. */
  torn: boolean;
}

/** Shape check of the envelope only; payload checks happen in replay (per-event preconditions). */
function isEnvelope(v: unknown): v is ExecutorEvent {
  return isRec(v) && Number.isInteger(v.seq) && typeof v.at === "string" && Number.isInteger(v.batch) &&
    typeof v.last === "boolean" && typeof v.type === "string";
}

/**
 * Splits a journal file into events. A last line without a terminating newline, or one that fails to parse, is torn
 * and dropped (A1-2 rule 1). An unparsable line anywhere else is corruption (E_SEQ_GAP).
 */
function parseJournal(text: string, file: string): ParsedJournal {
  const lines: JournalLine[] = [];
  if (text === "") return { lines, torn: false };
  const parts = text.split("\n");
  // `split` leaves "" after a trailing newline; anything else after the last "\n" is an unterminated (torn) line.
  const tail = parts.pop() ?? "";
  let torn = tail !== "";
  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i] ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      if (i === parts.length - 1 && tail === "") {
        // A last terminated line that does not parse: the write was cut after the newline of a garbled block.
        torn = true;
        break;
      }
      throw new ExecutorError("E_SEQ_GAP", `unparsable journal line ${i + 1} in ${file}: ${errMessage(e)}`, { file, line: i + 1 });
    }
    if (!isEnvelope(parsed)) {
      if (i === parts.length - 1 && tail === "") {
        torn = true;
        break;
      }
      throw new ExecutorError("E_SEQ_GAP", `malformed journal line ${i + 1} in ${file}`, { file, line: i + 1 });
    }
    lines.push({ event: parsed, text: raw });
  }
  return { lines, torn };
}

/** Result of framing validation over one journal file. */
interface FramedJournal {
  /** Complete batches only, in order. */
  lines: JournalLine[];
  /** Number of events of a trailing incomplete batch that were dropped. */
  droppedIncomplete: number;
}

/**
 * A1-2 rules (2) and (3), main journal only: `seq` +1; the first event of a file and any event after `last: true` has `batch === seq`;
 * the others share the previous `batch`. A trailing batch without `last: true` is dropped. `firstSeq` is the file's expected first seq
 * (null: any, used for the first-seq of the file name check by the caller).
 */
function frameJournal(lines: readonly JournalLine[], file: string, expectedFirst: number | null): FramedJournal {
  let prev: ExecutorEvent | null = null;
  let completeEnd = 0;
  for (let i = 0; i < lines.length; i++) {
    const e = (lines[i] as JournalLine).event;
    const where = { file, seq: e.seq, type: e.type };
    if (prev === null) {
      if (expectedFirst !== null && e.seq !== expectedFirst) {
        throw new ExecutorError("E_SEQ_GAP", `journal ${file} starts at seq ${e.seq}, expected ${expectedFirst}`, where);
      }
      if (e.batch !== e.seq) {
        throw new ExecutorError("E_SEQ_GAP", `journal ${file}: first event seq ${e.seq} has batch ${e.batch}`, where);
      }
    } else {
      if (e.seq !== prev.seq + 1) {
        throw new ExecutorError("E_SEQ_GAP", `journal ${file}: seq ${e.seq} follows ${prev.seq}`, where);
      }
      const expectedBatch = prev.last ? e.seq : prev.batch;
      if (e.batch !== expectedBatch) {
        throw new ExecutorError("E_SEQ_GAP", `journal ${file}: seq ${e.seq} has batch ${e.batch}, expected ${expectedBatch}`, where);
      }
    }
    if (e.last) completeEnd = i + 1;
    prev = e;
  }
  return { lines: lines.slice(0, completeEnd), droppedIncomplete: lines.length - completeEnd };
}

/** History journal: strictly increasing `seq` and a torn last line only (A2-4). */
function checkHistory(lines: readonly JournalLine[], file: string): void {
  let prev = 0;
  for (const l of lines) {
    if (l.event.seq <= prev) {
      throw new ExecutorError("E_SEQ_GAP", `history ${file}: seq ${l.event.seq} follows ${prev}`, { file, seq: l.event.seq });
    }
    prev = l.event.seq;
  }
}

function jsonDetail(v: unknown): JsonValue {
  return JSON.parse(JSON.stringify(v ?? null)) as JsonValue;
}

// ---------------------------------------------------------------------------------------------------------------
// History tracker (A1-3): open integration entries and wake keys, derived from history-class events.
// ---------------------------------------------------------------------------------------------------------------

/** Mutable view of one open integration entry. */
interface OpenEntryState {
  entry: IntegrationEntry;
  startSeq: number;
  step: IntegrationStep;
  edge: "start" | "end";
  result: IntegrationStepResult | null;
}

class HistoryTracker {
  private open = new Map<string, OpenEntryState>();
  private keys = new Set<string>();
  lastSeq = 0;

  clone(): HistoryTracker {
    const t = new HistoryTracker();
    for (const [id, s] of this.open) t.open.set(id, { ...s, entry: { ...s.entry, taskIds: [...s.entry.taskIds] } });
    t.keys = new Set(this.keys);
    t.lastSeq = this.lastSeq;
    return t;
  }

  openEntries(): readonly OpenIntegrationEntry[] {
    return [...this.open.values()].map((s) => ({
      entry: { ...s.entry, taskIds: [...s.entry.taskIds] },
      startSeq: s.startSeq,
      step: s.step,
      edge: s.edge,
      result: s.result,
    }));
  }

  wakeKeys(): ReadonlySet<string> {
    return this.keys;
  }

  /** Applies a history-class event; returns a violation code (state unchanged) or null. Non-history events are ignored. */
  apply(e: ExecutorEvent): string | null {
    if (e.type === "wake") {
      this.keys.add(e.stateKey);
      this.lastSeq = e.seq;
      return null;
    }
    if (e.type !== "integration-step") {
      if (isHistoryEvent(e)) this.lastSeq = e.seq;
      return null;
    }
    const cur = this.open.get(e.entry.id);
    if (cur === undefined) {
      if (e.edge !== "start") return "entry-not-open";
      if (e.entry.id !== `i-${e.seq}`) return "entry-id-mismatch";
      if (e.closes) return "closes-on-start";
      this.open.set(e.entry.id, {
        entry: { ...e.entry, taskIds: [...e.entry.taskIds] },
        startSeq: e.seq,
        step: e.step,
        edge: "start",
        result: null,
      });
      this.lastSeq = e.seq;
      return null;
    }
    if (e.entry.kind !== cur.entry.kind || e.entry.phaseId !== cur.entry.phaseId || e.entry.baseHead !== cur.entry.baseHead) {
      return "entry-fixed-field-changed";
    }
    if (e.edge === "start") {
      if (cur.edge !== "end") return "step-start-before-end";
      if (e.closes) return "closes-on-start";
    } else {
      if (cur.edge !== "start" || cur.step !== e.step) return "end-without-matching-start";
    }
    cur.entry = { ...e.entry, taskIds: [...e.entry.taskIds] };
    cur.step = e.step;
    cur.edge = e.edge;
    cur.result = e.edge === "end" ? e.result : null;
    if (e.edge === "end" && e.closes) this.open.delete(e.entry.id);
    this.lastSeq = e.seq;
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Replay: per-event preconditions (A1-2) and the ledger reducer.
// ---------------------------------------------------------------------------------------------------------------

/** Per-batch bookkeeping for rules that span events of one batch. */
interface BatchCtx {
  /** `plan-approved` was applied and no `status-changed -> running` has followed yet. */
  approvalPending: boolean;
}

function newBatchCtx(): BatchCtx {
  return { approvalPending: false };
}

const PRE_APPROVAL_STATUSES: readonly LedgerStatus[] = ["compiling", "awaiting-residue", "awaiting-approval"];

function taskOf(l: LedgerV1, id: string): TaskNode | null {
  return hasOwn(l.tasks, id) ? (l.tasks[id] as TaskNode) : null;
}

function latestAttempt(t: TaskNode): Attempt | null {
  return t.attempts.length === 0 ? null : (t.attempts[t.attempts.length - 1] as Attempt);
}

function isOpenAttemptShape(a: Attempt): boolean {
  return a.endedAt === null && a.outcome === null && a.verdict === null && a.childSessionID === null && a.context === "";
}

function edgeEndpointExists(l: LedgerV1, id: string): boolean {
  if (id.startsWith("gate:")) {
    const phaseId = (id as GateRef).slice("gate:".length);
    return l.phases.some((p) => p.id === phaseId);
  }
  return taskOf(l, id) !== null;
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function isSuperset(next: readonly string[], prev: readonly string[]): boolean {
  return prev.every((p) => next.includes(p));
}

/**
 * Checks the per-event precondition of `e` against `l` (the state just before `e`) and, when it holds, applies `e` to `l` in place.
 * Returns a violation code or null. On a non-null return `l` may be partly changed: callers work on a copy.
 */
function applyEvent(l: LedgerV1, e: ExecutorEvent, ctx: BatchCtx): string | null {
  switch (e.type) {
    case "ledger-init":
      return "ledger-init-not-first"; // handled by the caller at the start of a journal; never mid-journal
    case "draft-replaced": {
      if (!PRE_APPROVAL_STATUSES.includes(l.status)) return "draft-replaced-status";
      const d = e.draft;
      l.planDigest = d.planDigest;
      l.sharedContext = d.sharedContext;
      l.waves = d.waves;
      l.phases = d.phases;
      l.tasks = d.tasks;
      l.edges = d.edges;
      break;
    }
    case "status-changed":
      if (e.from !== l.status) return "status-from-mismatch";
      if (!canStatusTransition(e.from, e.to)) return "status-illegal";
      l.status = e.to;
      if (e.to === "running") ctx.approvalPending = false;
      break;
    case "plan-approved":
      if (l.status !== "awaiting-approval") return "approve-status";
      if (e.config.slotsDir === null) return "approve-slots-dir";
      l.config = e.config;
      ctx.approvalPending = true;
      break;
    case "orchestrator-bound":
      l.orchestrator = { sessionID: e.sessionID, boundAt: e.at };
      break;
    case "lock-takeover":
      break;
    case "task-created": {
      const t = e.task;
      if (typeof t.id !== "string" || RESERVED_TASK_IDS.has(t.id) || hasOwn(l.tasks, t.id)) return "task-exists";
      if (t.state !== "pending" && t.state !== "done") return "task-created-state";
      if (!Array.isArray(t.attempts) || t.attempts.length !== 0) return "task-created-attempts";
      if (t.slot !== null) return "task-created-slot";
      l.tasks[t.id] = t;
      break;
    }
    case "edge-added":
      if (!edgeEndpointExists(l, e.edge.from) || !edgeEndpointExists(l, e.edge.to)) return "edge-endpoint";
      l.edges.push(e.edge);
      break;
    case "task-transition": {
      const t = taskOf(l, e.taskId);
      if (t === null) return "task-missing";
      if (e.from !== t.state) return "transition-from-mismatch";
      if (!canTransition(e.from, e.to)) return "transition-illegal";
      const triggers = TRANSITION_TRIGGERS[`${e.from}>${e.to}` as TransitionKey];
      if (triggers === undefined || !triggers.includes(e.trigger)) return "transition-trigger";
      t.state = e.to;
      break;
    }
    case "attempt-started": {
      const t = taskOf(l, e.taskId);
      if (t === null) return "task-missing";
      const a = e.attempt;
      if (t.state !== "ready") return "attempt-started-state";
      if (t.attempts.some((x) => x.outcome === null)) return "attempt-open-exists";
      if (a.n !== t.attempts.length + 1) return "attempt-n";
      if (!isOpenAttemptShape(a)) return "attempt-open-shape";
      if (t.attempts.some((x) => x.nonce === a.nonce)) return "attempt-nonce-reused";
      t.attempts.push(a);
      break;
    }
    case "attempt-child": {
      const t = taskOf(l, e.taskId);
      if (t === null) return "task-missing";
      const a = latestAttempt(t);
      if (t.state !== "dispatched") return "attempt-child-state";
      if (a === null || a.n !== e.n || a.outcome !== null || a.childSessionID !== null) return "attempt-child-target";
      a.childSessionID = e.childSessionID;
      break;
    }
    case "attempt-adopted": {
      const t = taskOf(l, e.taskId);
      if (t === null) return "task-missing";
      const a = latestAttempt(t);
      if (t.state !== "ready") return "attempt-adopted-state";
      if (a === null || a.n !== e.n || a.outcome !== "lost") return "attempt-adopted-target";
      // The late child continues this attempt: it is open again (the row-7 transition to running follows in the batch).
      a.childSessionID = e.childSessionID;
      a.outcome = null;
      a.endedAt = null;
      break;
    }
    case "attempt-ended": {
      const t = taskOf(l, e.taskId);
      if (t === null) return "task-missing";
      const a = latestAttempt(t);
      if (t.state !== "dispatched" && t.state !== "running") return "attempt-ended-state";
      if (a === null || a.n !== e.n || a.outcome !== null) return "attempt-ended-target";
      a.outcome = e.outcome;
      a.endedAt = e.endedAt;
      break;
    }
    case "attempt-verdict": {
      const t = taskOf(l, e.taskId);
      if (t === null) return "task-missing";
      const a = latestAttempt(t);
      if (t.state !== "verifying") return "attempt-verdict-state";
      if (a === null || a.n !== e.n || a.outcome !== "succeeded" || a.verdict !== null) return "attempt-verdict-target";
      a.verdict = e.verdict;
      break;
    }
    case "attempt-context": {
      const t = taskOf(l, e.taskId);
      if (t === null) return "task-missing";
      if (e.n !== t.attempts.length || e.n < 1) return "attempt-context-target";
      (t.attempts[e.n - 1] as Attempt).context = e.context;
      break;
    }
    case "task-slot": {
      const t = taskOf(l, e.taskId);
      if (t === null) return "task-missing";
      t.slot = e.slot;
      t.branch = e.branch;
      break;
    }
    case "task-footprint": {
      const t = taskOf(l, e.taskId);
      if (t === null) return "task-missing";
      const o = t.footprint;
      const n = e.footprint;
      if (!isSuperset(n.writes, o.writes) || !isSuperset(n.reads, o.reads) || !isSuperset(n.sources, o.sources)) {
        return "footprint-not-monotone";
      }
      t.footprint = n;
      break;
    }
    case "task-integrated": {
      const t = taskOf(l, e.taskId);
      if (t === null) return "task-missing";
      if (t.state !== "integrating") return "task-integrated-state";
      t.integrated = { from: e.from, to: e.to };
      break;
    }
    case "integration-head":
      l.integration.head = e.head;
      break;
    case "gate-changed": {
      const p = l.phases.find((x) => x.id === e.phaseId);
      if (p === undefined) return "phase-missing";
      if (e.from !== p.gate) return "gate-from-mismatch";
      if (!canGateTransition(e.from, e.to)) return "gate-illegal";
      const triggers = GATE_TRANSITION_TRIGGERS[`${e.from}>${e.to}` as GateTransitionKey];
      if (triggers === undefined || !triggers.includes(e.trigger)) return "gate-trigger";
      const bump = e.trigger === "qa-next-round" || e.trigger === "cap-fix" ? 1 : 0;
      if (e.qaRound !== p.qaRound + bump) return "gate-qa-round";
      p.gate = e.to;
      p.qaRound = e.qaRound;
      break;
    }
    case "phase-paused": {
      const p = l.phases.find((x) => x.id === e.phaseId);
      if (p === undefined) return "phase-missing";
      if (p.paused === e.paused) return "phase-paused-unchanged";
      p.paused = e.paused;
      break;
    }
    case "phase-tagged": {
      const p = l.phases.find((x) => x.id === e.phaseId);
      if (p === undefined) return "phase-missing";
      p.tag = e.tag;
      break;
    }
    case "inbox-added": {
      const m = INBOX_ID_PATTERN.exec(e.item.id);
      if (m === null || m[1] !== INBOX_ID_PREFIX[e.item.kind]) return "inbox-id";
      const n = Number(m[2]);
      if (l.inbox.some((x) => {
        const mx = INBOX_ID_PATTERN.exec(x.id);
        return mx !== null && Number(mx[2]) >= n;
      })) return "inbox-id-not-increasing";
      l.inbox.push(e.item);
      break;
    }
    case "inbox-answered": {
      const item = l.inbox.find((x) => x.id === e.id);
      if (item === undefined) return "inbox-missing";
      if (item.answer !== null) return "inbox-already-answered";
      if (item.kind === "qa-cap" && item.severity === "critical" && !item.options.includes(e.answer)) return "inbox-answer-option";
      item.answer = e.answer;
      break;
    }
    case "integration-step":
    case "wake":
    case "metric":
      break;
    default:
      return "unknown-event-type";
  }
  l.seq = e.seq;
  return null;
}

/** Whole-ledger invariants, checked at batch end only (A1-2 rule 4), plus the batch-spanning rule of `plan-approved`. */
function batchEndViolation(l: LedgerV1, ctx: BatchCtx): { code: string; codes: string[] } | null {
  const codes: string[] = [];
  if (ctx.approvalPending) codes.push("plan-approved-without-running");
  for (const v of ledgerViolations(l)) codes.push(`${v.code}@${v.at}`);
  return codes.length === 0 ? null : { code: codes[0] as string, codes };
}

/** Event reference carried in error details (names the offending event). */
function eventRef(e: ExecutorEvent): JsonValue {
  return { seq: e.seq, batch: e.batch, type: e.type };
}

/** Starting ledger of a journal: the `ledger-init` event's ledger, checked for shape. */
function initLedger(e: ExecutorEvent): LedgerV1 {
  if (e.type !== "ledger-init") throw new ExecutorError("E_SCHEMA_INVALID", "journal does not start with ledger-init", eventRef(e));
  return checkLedger(e.ledger, `ledger-init seq ${e.seq}`);
}

/** Schema gate shared by snapshot and ledger-init: newer is refused, older migrates through the table, anything else must be a LedgerV1. */
const MIGRATIONS: Readonly<Record<number, (old: unknown) => unknown>> = {};

function checkLedger(v: unknown, what: string): LedgerV1 {
  let cur: unknown = v;
  const schema = ledgerSchemaOf(cur);
  if (schema !== null && schema > LEDGER_SCHEMA) {
    throw new ExecutorError("E_SCHEMA_NEWER", `${what}: ledger schema ${schema} is newer than supported ${LEDGER_SCHEMA}`, { schema });
  }
  let s = schema;
  while (s !== null && s < LEDGER_SCHEMA) {
    const step = hasOwn(MIGRATIONS, String(s)) ? MIGRATIONS[s] : undefined;
    if (step === undefined) throw new ExecutorError("E_SCHEMA_INVALID", `${what}: no migration from schema ${s}`, { schema: s });
    cur = step(cur);
    const migrated = ledgerSchemaOf(cur);
    if (migrated === null || migrated <= s) {
      throw new ExecutorError("E_SCHEMA_INVALID", `${what}: migration from schema ${s} did not advance the schema`, { schema: s });
    }
    s = migrated;
  }
  if (!isLedgerV1(cur)) {
    const viol = ledgerViolations(cur);
    throw new ExecutorError("E_SCHEMA_INVALID", `${what}: not a valid ledger`, jsonDetail(viol.slice(0, 20)));
  }
  return cur;
}

function illegal(e: ExecutorEvent, code: string, codes: string[] = [code]): ExecutorError {
  return new ExecutorError("E_ILLEGAL_TRANSITION", `event seq ${e.seq} (${e.type}) is illegal: ${codes.join(", ")}`, {
    event: eventRef(e),
    codes,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Files, retry, locks.
// ---------------------------------------------------------------------------------------------------------------

const SNAPSHOT_FILE = "ledger.json";
const LOCK_FILE = "writer.lock";
const LOCK_GUARD_FILE = "writer.lock.guard";
const HISTORY_FILE = "history.jsonl";
const JOURNAL_PATTERN = /^events\.(\d+)\.jsonl$/;
const TMP_PATTERN = /^(?:ledger\.json|writer\.lock|history\.jsonl)\.tmp-/;

/** Defaults (2.2.2.b, .e). */
const SNAPSHOT_EVERY_EVENTS = 200;
const HEARTBEAT_MS = 10_000;
const LOCK_STALE_MS = 60_000;
const RETRY_BUDGET_MS = 2_000;
const READ_RETRIES = 8;
const GUARD_STALE_MS = 15_000;

/** Pid/host facts the lock needs; a `Spawner` satisfies it. */
export interface LedgerProcessInfo {
  readonly pid: number;
  readonly hostname: string;
  isAlive(pid: number): boolean;
}

export interface LedgerStoreDeps {
  /** The executor home (`resolveExecutorHome`); plans live in `planDir(home, planId)`. */
  home: string;
  /** Default: {@link createNodeFileSystem}. */
  fs?: FileSystem;
  /** Default: {@link createNodeClock}. */
  clock?: Clock;
  /** Default: this process. */
  proc?: LedgerProcessInfo;
  /** Receives warnings (torn last line, dropped incomplete batch, failed cleanup). Default: dropped. */
  warn?: (message: string) => void;
  /** Lock heartbeat period; default 10 s. */
  heartbeatMs?: number;
  /** A heartbeat older than this is stale; default 60 s. */
  staleMs?: number;
  /** Events between snapshots; default 200. */
  snapshotEvery?: number;
}

/** Production `Clock`. Timers are unref'd so a pending heartbeat never keeps the process alive. */
export function createNodeClock(): Clock {
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  let nextId = 1;
  return {
    now: () => Date.now(),
    iso: (ms) => new Date(ms ?? Date.now()).toISOString(),
    setTimer(ms, fn) {
      const id = nextId++;
      const h = setTimeout(() => {
        timers.delete(id);
        fn();
      }, ms);
      h.unref();
      timers.set(id, h);
      return { id };
    },
    clearTimer(h) {
      const t = timers.get(h.id);
      if (t !== undefined) {
        clearTimeout(t);
        timers.delete(h.id);
      }
    },
    randomHex: (bytes) => randomBytes(bytes).toString("hex"),
  };
}

function createNodeProcessInfo(): LedgerProcessInfo {
  return {
    pid: process.pid,
    hostname: hostname(),
    isAlive(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return fsErrorCode(e) === "EPERM"; // exists, owned by someone else
      }
    },
  };
}

function sleep(clock: Clock, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    clock.setTimer(ms, resolve);
  });
}

/** Retries `op` while it fails with EPERM/EBUSY (antivirus, indexers, a reader holding the file), within the 2 s budget (2.2.2.b). */
async function retryBusy<T>(clock: Clock, op: () => Promise<T>): Promise<T> {
  const start = clock.now();
  let delay = 10;
  for (let attempt = 0; ; attempt++) {
    try {
      return await op();
    } catch (e) {
      const code = fsErrorCode(e);
      if ((code !== "EPERM" && code !== "EBUSY") || clock.now() - start >= RETRY_BUDGET_MS || attempt >= 100) throw e;
      await sleep(clock, delay);
      delay = Math.min(delay * 2, 200);
    }
  }
}

async function readOptional(fs: FileSystem, path: string): Promise<string | null> {
  try {
    return await fs.readText(path);
  } catch (e) {
    if (fsErrorCode(e) === "ENOENT") return null;
    throw e;
  }
}

/** Removes a file that may already be gone. */
async function rmQuiet(fs: FileSystem, path: string, recursive = false): Promise<void> {
  try {
    await fs.rm(path, { recursive });
  } catch (e) {
    if (fsErrorCode(e) !== "ENOENT") throw e;
  }
}

function parseLockText(text: string): LockHolder | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null; // torn lock file: no holder can be named
  }
  if (!isRec(v)) return null;
  const { pid, hostname: host, sessionID, startedAt, heartbeatAt } = v;
  if (typeof pid !== "number" || typeof host !== "string" || typeof sessionID !== "string") return null;
  if (typeof startedAt !== "string" || typeof heartbeatAt !== "string") return null;
  return { pid, hostname: host, sessionID, startedAt, heartbeatAt };
}

function sameLockIdentity(a: LockHolder, b: LockHolder): boolean {
  return a.pid === b.pid && a.hostname === b.hostname && a.sessionID === b.sessionID && a.startedAt === b.startedAt;
}

// ---------------------------------------------------------------------------------------------------------------
// Load (snapshot + journal replay).
// ---------------------------------------------------------------------------------------------------------------

/** The snapshot and the journal listing disagree; a reader retries (2.2.2.b). */
class SnapshotMismatch extends Error {}

interface JournalFile {
  name: string;
  first: number;
}

interface MainState {
  ledger: LedgerV1;
  /** 0 when there is no snapshot file (a plan whose first snapshot was never renamed into place). */
  snapshotSeq: number;
  files: JournalFile[];
  /** Every complete, framed line of the relevant journal files, ascending (may include seq <= snapshotSeq). */
  events: JournalLine[];
  /** The last journal file ends in a torn line or an incomplete batch: appending to it is unsafe. */
  dirty: boolean;
  warnings: string[];
}

function parseSnapshot(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ExecutorError("E_SCHEMA_INVALID", `${SNAPSHOT_FILE} is not valid JSON: ${errMessage(e)}`);
  }
}

async function listJournals(fs: FileSystem, dir: string): Promise<JournalFile[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (e) {
    if (fsErrorCode(e) === "ENOENT") throw new ExecutorError("E_LEDGER_NOT_FOUND", `no plan directory ${dir}`);
    throw e;
  }
  const files: JournalFile[] = [];
  for (const name of names) {
    const m = JOURNAL_PATTERN.exec(name);
    if (m !== null) files.push({ name, first: Number(m[1]) });
  }
  return files.sort((a, b) => a.first - b.first);
}

/**
 * Snapshot plus replay of the events with a greater `seq` (2.2.2.c). A journal file is authoritative only for `seq` below the next
 * file's first `seq`: that is what makes rotation (and a takeover's rotation) fence a slow old writer.
 */
async function loadMain(fs: FileSystem, dir: string, mode: "reader" | "writer"): Promise<MainState> {
  const files = await listJournals(fs, dir);
  const snapText = await readOptional(fs, join(dir, SNAPSHOT_FILE));
  if (snapText === null && files.length === 0) throw new ExecutorError("E_LEDGER_NOT_FOUND", `no ledger in ${dir}`);
  const snapshot = snapText === null ? null : checkLedger(parseSnapshot(snapText), SNAPSHOT_FILE);
  const S = snapshot === null ? 0 : snapshot.seq;
  const mismatch = (msg: string): Error =>
    mode === "reader" ? new SnapshotMismatch(msg) : new ExecutorError("E_SEQ_GAP", msg, { snapshotSeq: S });
  if (snapshot === null && (files[0] === undefined || files[0].first !== 1)) {
    throw new ExecutorError("E_SEQ_GAP", `${SNAPSHOT_FILE} is missing and the journal does not start at seq 1`, { dir });
  }

  const events: JournalLine[] = [];
  const warnings: string[] = [];
  let dirty = false;
  for (let i = 0; i < files.length; i++) {
    const f = files[i] as JournalFile;
    const next = files[i + 1];
    if (next !== undefined && next.first <= S + 1) continue; // only seq <= S: covered by the snapshot
    const text = await readOptional(fs, join(dir, f.name));
    if (text === null) throw mismatch(`journal ${f.name} vanished while loading`);
    const parsed = parseJournal(text, f.name);
    const kept = next === undefined ? parsed.lines : parsed.lines.filter((l) => l.event.seq < next.first);
    const framed = frameJournal(kept, f.name, f.first);
    if (next !== undefined) {
      if (framed.droppedIncomplete > 0) {
        throw new ExecutorError("E_SEQ_GAP", `journal ${f.name} ends inside a batch before the next journal starts`, { file: f.name });
      }
    } else {
      if (parsed.torn) {
        dirty = true;
        warnings.push(`${f.name}: torn last line dropped`);
      }
      if (framed.droppedIncomplete > 0) {
        dirty = true;
        warnings.push(`${f.name}: incomplete trailing batch dropped (${framed.droppedIncomplete} events, incomplete-batch)`);
      }
    }
    for (const l of framed.lines) {
      const prev = events[events.length - 1];
      if (prev !== undefined && (l.event.seq !== prev.event.seq + 1 || !prev.event.last)) {
        throw new ExecutorError("E_SEQ_GAP", `seq ${l.event.seq} follows ${prev.event.seq} across journal files`, { file: f.name });
      }
      events.push(l);
    }
  }

  const after = events.filter((l) => l.event.seq > S);
  const first = after[0];
  let ledger: LedgerV1;
  let rest: JournalLine[];
  if (snapshot === null) {
    if (first === undefined) throw new ExecutorError("E_LEDGER_NOT_FOUND", `no complete ledger-init in ${dir}`);
    const e = first.event;
    if (e.type !== "ledger-init" || e.seq !== 1 || e.batch !== 1 || !e.last) {
      throw new ExecutorError("E_SEQ_GAP", "journal does not start with a lone ledger-init at seq 1", eventRef(e));
    }
    ledger = initLedger(e);
    if (ledger.seq !== 1) throw illegal(e, "ledger-init-seq");
    rest = after.slice(1);
  } else {
    if (first !== undefined && first.event.seq !== S + 1) {
      throw mismatch(`snapshot is at seq ${S} but the journal continues at seq ${first.event.seq}`);
    }
    ledger = snapshot;
    rest = after;
  }
  let ctx = newBatchCtx();
  for (const l of rest) {
    const e = l.event;
    if (e.batch === e.seq) ctx = newBatchCtx();
    const code = applyEvent(ledger, e, ctx);
    if (code !== null) throw illegal(e, code);
    if (e.last) {
      const v = batchEndViolation(ledger, ctx);
      if (v !== null) throw illegal(e, v.code, v.codes);
    }
  }
  return { ledger, snapshotSeq: S, files, events, dirty, warnings };
}

/** Retries `loadMain` while the snapshot and the journal listing disagree (a reader racing a rotation). */
async function loadMainConsistent(fs: FileSystem, clock: Clock, dir: string): Promise<MainState> {
  let last = "";
  for (let attempt = 0; attempt < READ_RETRIES; attempt++) {
    try {
      return await loadMain(fs, dir, "reader");
    } catch (e) {
      if (!(e instanceof SnapshotMismatch)) throw e;
      last = e.message;
      await sleep(clock, 5 * (attempt + 1));
    }
  }
  throw new ExecutorError("E_SEQ_GAP", `snapshot and journal never agreed: ${last}`);
}

// ---------------------------------------------------------------------------------------------------------------
// History journal (A1-3).
// ---------------------------------------------------------------------------------------------------------------

interface HistoryLoad {
  /** Valid lines to keep (seq <= the ledger's seq), then the lines repaired from the main journal. */
  kept: JournalLine[];
  added: JournalLine[];
  /** The file has torn bytes or events beyond the main journal: it must be rewritten, not appended to. */
  rewrite: boolean;
}

async function loadHistory(fs: FileSystem, dir: string, ledgerSeq: number, main: readonly JournalLine[]): Promise<HistoryLoad> {
  const text = (await readOptional(fs, join(dir, HISTORY_FILE))) ?? "";
  const parsed = parseJournal(text, HISTORY_FILE);
  checkHistory(parsed.lines, HISTORY_FILE);
  const kept = parsed.lines.filter((l) => l.event.seq <= ledgerSeq);
  const lastSeq = kept.length === 0 ? 0 : (kept[kept.length - 1] as JournalLine).event.seq;
  const added = main.filter((l) => isHistoryEvent(l.event) && l.event.seq > lastSeq && l.event.seq <= ledgerSeq);
  return { kept, added, rewrite: parsed.torn || kept.length !== parsed.lines.length };
}

function trackerOf(lines: readonly JournalLine[]): HistoryTracker {
  const t = new HistoryTracker();
  for (const l of lines) {
    const code = t.apply(l.event);
    if (code !== null) throw illegal(l.event, code);
  }
  return t;
}

// ---------------------------------------------------------------------------------------------------------------
// The writer.
// ---------------------------------------------------------------------------------------------------------------

interface WriterEnv {
  fs: FileSystem;
  clock: Clock;
  proc: LedgerProcessInfo;
  warn: (message: string) => void;
  dir: string;
  heartbeatMs: number;
  staleMs: number;
  snapshotEvery: number;
}

interface WriterInit {
  planId: PlanId;
  ledger: LedgerV1;
  tracker: HistoryTracker;
  lock: LockHolder;
  /** The snapshot file holds this seq. */
  snapshotSeq: number;
  /** Journal file to append to, and its first seq. */
  journal: JournalFile | null;
  /** The journal file cannot be appended to (torn tail) and must be replaced by a rotation. */
  needsRotate: boolean;
}

class StoreWriter implements LedgerWriter {
  readonly planId: PlanId;
  private current: LedgerV1;
  private tracker: HistoryTracker;
  private lock: LockHolder;
  private lastSnapshotSeq: number;
  private journal: JournalFile | null;
  private needsRotate: boolean;
  private eventsSince = 0;
  private pendingHistory: string[] = [];
  private historyDirty = false;
  private historyUnsynced = true;
  private lost = false;
  private closed = false;
  private chain: Promise<void> = Promise.resolve();
  private timer: { readonly id: number } | null = null;

  constructor(private readonly env: WriterEnv, init: WriterInit) {
    this.planId = init.planId;
    this.current = init.ledger;
    this.tracker = init.tracker;
    this.lock = init.lock;
    this.lastSnapshotSeq = init.snapshotSeq;
    this.journal = init.journal;
    this.needsRotate = init.needsRotate;
  }

  get ledger(): Readonly<LedgerV1> {
    return this.current;
  }

  /** Stops the heartbeat and refuses further use without touching the files or the lock (a failed open/takeover). */
  abandon(): void {
    this.closed = true;
    this.disarmHeartbeat();
  }

  openIntegration(): readonly OpenIntegrationEntry[] {
    return this.tracker.openEntries();
  }

  wakeKeys(): ReadonlySet<string> {
    return this.tracker.wakeKeys();
  }

  /** Serialises `fn` after every earlier call; a failure does not poison the chain. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Brings a freshly built writer to a clean state (snapshot + rotation when the journal tail is unusable) and starts the heartbeat. */
  start(): Promise<void> {
    return this.serial(async () => {
      if (this.needsRotate || this.lastSnapshotSeq !== this.current.seq || this.journal === null) {
        await this.snapshotNow();
      }
      this.armHeartbeat();
    });
  }

  append(batch: readonly ExecutorEventInput[] | BatchBuilder): Promise<Readonly<LedgerV1>> {
    return this.serial(() => this.appendNow(batch));
  }

  snapshot(): Promise<void> {
    return this.serial(async () => {
      this.assertUsable();
      await this.verifyLock();
      await this.snapshotNow();
    });
  }

  close(): Promise<void> {
    return this.serial(async () => {
      if (this.closed) return;
      let failure: unknown = null;
      if (!this.lost) {
        try {
          await this.verifyLock();
          await this.snapshotNow();
        } catch (e) {
          failure = e;
        }
      }
      this.closed = true;
      this.disarmHeartbeat();
      if (!this.lost) await this.releaseLock();
      if (failure !== null && !(failure instanceof ExecutorError && failure.code === "E_LOCK_LOST")) throw failure;
    });
  }

  // -- append ------------------------------------------------------------------------------------------------

  private assertUsable(): void {
    if (this.closed) throw new ExecutorError("E_DISPOSED", `ledger writer for ${this.planId} is closed`);
    if (this.lost) throw new ExecutorError("E_LOCK_LOST", `writer lock for ${this.planId} was lost`);
  }

  private async appendNow(input: readonly ExecutorEventInput[] | BatchBuilder): Promise<Readonly<LedgerV1>> {
    this.assertUsable();
    await this.verifyLock();
    if (this.needsRotate) await this.snapshotNow();
    const inputs = typeof input === "function" ? input(this.current) : input;
    if (inputs.length === 0) return this.current;

    const first = this.current.seq + 1;
    const at = this.env.clock.iso();
    // What is validated and applied is exactly what is written: serialise first, then parse the text back.
    const lines: string[] = [];
    const events: ExecutorEvent[] = [];
    inputs.forEach((inp, i) => {
      const draft = { ...inp, seq: first + i, at, batch: first, last: i === inputs.length - 1 };
      let text: string;
      try {
        text = JSON.stringify(draft);
      } catch (e) {
        throw new ExecutorError("E_INVALID_INPUT", `event ${i} of the batch is not serialisable: ${errMessage(e)}`, { eventIndex: i });
      }
      lines.push(text);
      events.push(JSON.parse(text) as ExecutorEvent);
    });

    const work = structuredClone(this.current);
    const tracker = this.tracker.clone();
    const ctx = newBatchCtx();
    for (let i = 0; i < events.length; i++) {
      const ev = events[i] as ExecutorEvent;
      const code = applyEvent(work, ev, ctx) ?? (isHistoryEvent(ev) ? tracker.apply(ev) : null);
      if (code !== null) {
        throw new ExecutorError("E_ILLEGAL_TRANSITION", `batch ${first}: event ${i} (${ev.type}) is illegal: ${code}`, {
          batchIndex: first,
          eventIndex: i,
          codes: [code],
        });
      }
    }
    const end = batchEndViolation(work, ctx);
    if (end !== null) {
      throw new ExecutorError("E_ILLEGAL_TRANSITION", `batch ${first} leaves the ledger invalid: ${end.codes.join(", ")}`, {
        batchIndex: first,
        eventIndex: null,
        codes: end.codes,
      });
    }

    const durable = inputs.some(isDurableEvent);
    const journal = await this.ensureJournal();
    try {
      await this.env.fs.appendText(join(this.env.dir, journal.name), `${lines.join("\n")}\n`, { fsync: durable });
    } catch (e) {
      // The file may now end in a partial batch: never append to it again.
      this.needsRotate = true;
      throw e;
    }
    this.current = work;
    this.tracker = tracker;
    this.eventsSince += events.length;

    events.forEach((ev, i) => {
      if (isHistoryEvent(ev)) this.pendingHistory.push(lines[i] as string);
    });
    await this.flushHistory(durable, false);

    if (this.eventsSince >= this.env.snapshotEvery) {
      try {
        await this.snapshotNow();
      } catch (e) {
        this.env.warn(`snapshot of ${this.planId} at seq ${this.current.seq} failed, will retry: ${errMessage(e)}`);
      }
    }
    return this.current;
  }

  private async ensureJournal(): Promise<JournalFile> {
    if (this.journal === null) await this.snapshotNow();
    if (this.journal === null) throw new ExecutorError("E_LEDGER_NOT_FOUND", `no journal file for ${this.planId}`);
    return this.journal;
  }

  // -- history ------------------------------------------------------------------------------------------------

  /** Writes pending history copies after the main journal. A failure is remembered (main is the authority) and retried by a rewrite. */
  private async flushHistory(fsync: boolean, strict: boolean): Promise<void> {
    const path = join(this.env.dir, HISTORY_FILE);
    try {
      if (this.historyDirty) {
        await this.rewriteHistory();
        this.historyDirty = false;
        this.historyUnsynced = false;
        return;
      }
      if (this.pendingHistory.length > 0) {
        await this.env.fs.appendText(path, `${this.pendingHistory.join("\n")}\n`, { fsync });
        this.pendingHistory = [];
        this.historyUnsynced = !fsync;
      } else if (fsync && this.historyUnsynced) {
        await this.env.fs.appendText(path, "", { fsync: true });
        this.historyUnsynced = false;
      }
    } catch (e) {
      this.historyDirty = true;
      if (strict) throw e;
      this.env.warn(`history copy for ${this.planId} failed, will be repaired: ${errMessage(e)}`);
    }
  }

  /** Rebuilds history.jsonl from what it holds (minus a torn tail) plus the pending copies, through a temp file. */
  private async rewriteHistory(): Promise<void> {
    const { fs, dir } = this.env;
    const text = (await readOptional(fs, join(dir, HISTORY_FILE))) ?? "";
    const parsed = parseJournal(text, HISTORY_FILE);
    const have = parsed.lines.filter((l) => l.event.seq <= this.current.seq);
    const lastSeq = have.length === 0 ? 0 : (have[have.length - 1] as JournalLine).event.seq;
    const pending = this.pendingHistory.filter((t) => (JSON.parse(t) as { seq: number }).seq > lastSeq);
    await writeHistoryFile(this.env, [...have.map((l) => l.text), ...pending]);
    this.pendingHistory = [];
  }

  // -- snapshot and rotation --------------------------------------------------------------------------------

  private makeJournal(first: number): JournalFile {
    return { name: `events.${first}.jsonl`, first };
  }

  /**
   * Snapshot at the current seq (a batch boundary), then rotate: the new journal file exists before the old ones are deleted, and a
   * journal file is only authoritative below the next file's first seq, so a late write to an old file is never read.
   */
  private async snapshotNow(): Promise<void> {
    const { fs, dir, clock } = this.env;
    const N = this.current.seq;
    if (!this.needsRotate && this.journal !== null && N === this.lastSnapshotSeq) return;
    await this.flushHistory(true, true);
    if (N !== this.lastSnapshotSeq) {
      const tmp = join(dir, `${SNAPSHOT_FILE}.tmp-${this.env.proc.pid}-${clock.randomHex(4)}`);
      try {
        await fs.writeText(tmp, JSON.stringify(this.current), { fsync: true });
        await retryBusy(clock, () => fs.rename(tmp, join(dir, SNAPSHOT_FILE)));
      } catch (e) {
        await this.discardTemp(tmp);
        throw e;
      }
      await fs.fsyncDir(dir);
      this.lastSnapshotSeq = N;
    }
    const next = this.makeJournal(N + 1);
    await rmQuiet(fs, join(dir, next.name));
    await fs.writeText(join(dir, next.name), "", { exclusive: true, fsync: true });
    await fs.fsyncDir(dir);
    this.journal = next;
    this.needsRotate = false;
    this.eventsSince = 0;
    await this.deleteOldJournals(next.first);
  }

  private async discardTemp(path: string): Promise<void> {
    try {
      await rmQuiet(this.env.fs, path);
    } catch (e) {
      this.env.warn(`could not remove temp file ${path}: ${errMessage(e)}`);
    }
  }

  /** Deletes journal files that precede `keepFrom`; only after a successful snapshot. A failure only leaves superseded files behind. */
  private async deleteOldJournals(keepFrom: number): Promise<void> {
    const { fs, dir } = this.env;
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (e) {
      this.env.warn(`could not list ${dir}: ${errMessage(e)}`);
      return;
    }
    for (const name of names) {
      const m = JOURNAL_PATTERN.exec(name);
      if (m === null || Number(m[1]) >= keepFrom) continue;
      try {
        await rmQuiet(fs, join(dir, name));
      } catch (e) {
        this.env.warn(`could not delete old journal ${name}: ${errMessage(e)}`);
      }
    }
  }

  // -- lock ---------------------------------------------------------------------------------------------------

  /** Fails with E_LOCK_LOST (and stays failed) when the lock file no longer names this writer. */
  private async verifyLock(): Promise<void> {
    const text = await readOptional(this.env.fs, join(this.env.dir, LOCK_FILE));
    const holder = text === null ? null : parseLockText(text);
    if (holder === null || !sameLockIdentity(holder, this.lock)) {
      this.lost = true;
      this.disarmHeartbeat();
      throw new ExecutorError("E_LOCK_LOST", `writer lock for ${this.planId} is held by another writer`, jsonDetail(holder));
    }
  }

  private async releaseLock(): Promise<void> {
    try {
      await rmQuiet(this.env.fs, join(this.env.dir, LOCK_FILE));
    } catch (e) {
      this.env.warn(`could not release the lock of ${this.planId}: ${errMessage(e)}`);
    }
  }

  private armHeartbeat(): void {
    if (this.closed || this.lost || this.timer !== null) return;
    this.timer = this.env.clock.setTimer(this.env.heartbeatMs, () => {
      this.timer = null;
      this.serial(() => this.beat()).then(
        () => this.armHeartbeat(),
        (e: unknown) => {
          this.env.warn(`heartbeat of ${this.planId} failed: ${errMessage(e)}`);
          this.armHeartbeat();
        },
      );
    });
  }

  private disarmHeartbeat(): void {
    if (this.timer !== null) {
      this.env.clock.clearTimer(this.timer);
      this.timer = null;
    }
  }

  private async beat(): Promise<void> {
    if (this.closed || this.lost) return;
    await this.verifyLock();
    const next: LockHolder = { ...this.lock, heartbeatAt: this.env.clock.iso() };
    await replaceLockFile(this.env, next);
    this.lock = next;
  }
}

/** Atomically replaces the lock file's content (temp + rename, EPERM/EBUSY retried). */
async function replaceLockFile(env: WriterEnv, holder: LockHolder): Promise<void> {
  const { fs, clock, dir } = env;
  const tmp = join(dir, `${LOCK_FILE}.tmp-${env.proc.pid}-${clock.randomHex(4)}`);
  try {
    await fs.writeText(tmp, JSON.stringify(holder), { fsync: true });
    await retryBusy(clock, () => fs.rename(tmp, join(dir, LOCK_FILE)));
  } catch (e) {
    try {
      await rmQuiet(fs, tmp);
    } catch (cleanup) {
      env.warn(`could not remove temp lock ${tmp}: ${errMessage(cleanup)}`);
    }
    throw e;
  }
}

/** Replaces history.jsonl with exactly `texts` (one event per entry), through a temp file. */
async function writeHistoryFile(env: WriterEnv, texts: readonly string[]): Promise<void> {
  const { fs, clock, dir } = env;
  const tmp = join(dir, `${HISTORY_FILE}.tmp-${env.proc.pid}-${clock.randomHex(4)}`);
  try {
    await fs.writeText(tmp, texts.length === 0 ? "" : `${texts.join("\n")}\n`, { fsync: true });
    await retryBusy(clock, () => fs.rename(tmp, join(dir, HISTORY_FILE)));
  } catch (e) {
    try {
      await rmQuiet(fs, tmp);
    } catch (cleanup) {
      env.warn(`could not remove temp history ${tmp}: ${errMessage(cleanup)}`);
    }
    throw e;
  }
  await fs.fsyncDir(dir);
}

// ---------------------------------------------------------------------------------------------------------------
// The store.
// ---------------------------------------------------------------------------------------------------------------

function noWarn(): void {
  // Warnings are dropped unless the caller supplies a sink.
}

/**
 * `LedgerStore` over the injected seams (2.2.2). One writer per plan holds `writer.lock` (pid, host, session, heartbeat); readers
 * (`read`, `list`, `exportPlan`) never take it. All files of a plan live in `planDir(home, planId)`:
 * `ledger.json` (snapshot), `events.<firstSeq>.jsonl` (journal, rotated at snapshots), `history.jsonl` (never rotated), `writer.lock`.
 */
export function createLedgerStore(deps: LedgerStoreDeps): LedgerStore {
  const fs = deps.fs ?? createNodeFileSystem();
  const clock = deps.clock ?? createNodeClock();
  const proc = deps.proc ?? createNodeProcessInfo();
  const warn = deps.warn ?? noWarn;
  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS;
  const staleMs = deps.staleMs ?? LOCK_STALE_MS;
  const snapshotEvery = deps.snapshotEvery ?? SNAPSHOT_EVERY_EVENTS;

  const dirOf = (planId: PlanId): string => {
    if (!isPlanId(planId)) throw new ExecutorError("E_INVALID_INPUT", `invalid plan id ${JSON.stringify(planId)}`, { planId });
    return planDir(deps.home, planId);
  };
  const envOf = (dir: string): WriterEnv => ({ fs, clock, proc, warn, dir, heartbeatMs, staleMs, snapshotEvery });
  const emit = (warnings: readonly string[]): void => {
    for (const w of warnings) warn(w);
  };

  /** Dead pid on this host, or a heartbeat older than `staleMs`; a torn lock file is stale once its mtime is that old. */
  const isStale = (h: LockHolder | null, mtimeMs: number | null): boolean => {
    if (h === null) return mtimeMs !== null && clock.now() - mtimeMs > staleMs;
    if (h.hostname === proc.hostname && !proc.isAlive(h.pid)) return true;
    const beat = Date.parse(h.heartbeatAt);
    return !Number.isFinite(beat) || clock.now() - beat > staleMs;
  };

  const readLock = async (dir: string): Promise<{ exists: boolean; holder: LockHolder | null; mtimeMs: number | null }> => {
    const path = join(dir, LOCK_FILE);
    const text = await readOptional(fs, path);
    if (text === null) return { exists: false, holder: null, mtimeMs: null };
    const st = await fs.lstat(path);
    return { exists: true, holder: parseLockText(text), mtimeMs: st === null ? null : st.mtimeMs };
  };

  const lockHeld = async (dir: string): Promise<ExecutorError> => {
    const cur = await readLock(dir);
    const stale = cur.exists && isStale(cur.holder, cur.mtimeMs);
    const who = cur.holder === null ? "unknown holder" : `pid ${cur.holder.pid} on ${cur.holder.hostname} (session ${cur.holder.sessionID})`;
    return new ExecutorError(
      "E_LOCK_HELD",
      `ledger writer lock is held by ${who}${stale ? "; it is stale, use takeover" : ""}`,
      jsonDetail(cur.holder),
    );
  };

  /** Creates the lock file exclusively; EEXIST means another writer (stale or not) holds it. */
  const acquireExclusive = async (dir: string, holder: LockHolder): Promise<LockHolder> => {
    const mine: LockHolder = { ...holder, heartbeatAt: clock.iso() };
    try {
      await fs.writeText(join(dir, LOCK_FILE), JSON.stringify(mine), { exclusive: true, fsync: true });
    } catch (e) {
      if (fsErrorCode(e) === "EEXIST") throw await lockHeld(dir);
      throw e;
    }
    return mine;
  };

  const releaseLockQuietly = async (dir: string, mine: LockHolder): Promise<void> => {
    try {
      const cur = await readLock(dir);
      if (cur.holder !== null && sameLockIdentity(cur.holder, mine)) await rmQuiet(fs, join(dir, LOCK_FILE));
    } catch (e) {
      warn(`could not release the lock in ${dir}: ${errMessage(e)}`);
    }
  };

  /** Replaces a stale (or, when adopting, a live) lock under a short-lived guard file so two takers cannot both win. */
  const takeLock = async (
    dir: string,
    holder: LockHolder,
    reason: string,
  ): Promise<{ mine: LockHolder; previous: LockHolder | null }> => {
    const guard = join(dir, LOCK_GUARD_FILE);
    const claim = async (): Promise<boolean> => {
      try {
        await fs.writeText(guard, JSON.stringify({ pid: proc.pid, at: clock.iso() }), { exclusive: true });
        return true;
      } catch (e) {
        if (fsErrorCode(e) === "EEXIST") return false;
        throw e;
      }
    };
    if (!(await claim())) {
      const st = await fs.lstat(guard);
      if (st !== null && clock.now() - st.mtimeMs > GUARD_STALE_MS) {
        await rmQuiet(fs, guard);
        if (await claim()) return takeLockGuarded(dir, holder, reason, guard);
      }
      throw new ExecutorError("E_LOCK_HELD", "another takeover of this ledger is in progress", null);
    }
    return takeLockGuarded(dir, holder, reason, guard);
  };

  const takeLockGuarded = async (
    dir: string,
    holder: LockHolder,
    reason: string,
    guard: string,
  ): Promise<{ mine: LockHolder; previous: LockHolder | null }> => {
    try {
      const cur = await readLock(dir);
      const adopting = reason.startsWith("adopt");
      if (cur.exists && !adopting && !isStale(cur.holder, cur.mtimeMs)) throw await lockHeld(dir);
      const mine: LockHolder = { ...holder, heartbeatAt: clock.iso() };
      await replaceLockFile(envOf(dir), mine);
      await fs.fsyncDir(dir);
      return { mine, previous: cur.holder };
    } finally {
      try {
        await rmQuiet(fs, guard);
      } catch (e) {
        warn(`could not remove ${guard}: ${errMessage(e)}`);
      }
    }
  };

  const cleanupTemps = async (dir: string): Promise<void> => {
    for (const name of await fs.readdir(dir)) {
      if (!TMP_PATTERN.test(name)) continue;
      try {
        await rmQuiet(fs, join(dir, name));
      } catch (e) {
        warn(`could not remove leftover ${name}: ${errMessage(e)}`);
      }
    }
  };

  /** Loads the plan under the lock `mine`, repairs history, takes a snapshot when the journal tail is unusable, and starts the heartbeat. */
  const buildWriter = async (
    planId: PlanId,
    dir: string,
    mine: LockHolder,
    takeover: { reason: string; previous: LockHolder | null } | null,
  ): Promise<LedgerWriter> => {
    const env = envOf(dir);
    let writer: StoreWriter | null = null;
    try {
      await cleanupTemps(dir);
      const st = await loadMain(fs, dir, "writer");
      emit(st.warnings);
      const hl = await loadHistory(fs, dir, st.ledger.seq, st.events);
      const all = [...hl.kept, ...hl.added];
      const tracker = trackerOf(all);
      const open = tracker.openEntries();
      for (const t of Object.values(st.ledger.tasks)) {
        if (t.state === "integrating" && !open.some((o) => o.entry.taskIds.includes(t.id))) {
          throw new ExecutorError("E_ILLEGAL_TRANSITION", `task ${t.id} is integrating but no integration entry is open`, {
            taskId: t.id,
            codes: ["integrating-without-entry"],
          });
        }
      }
      if (hl.rewrite) {
        await writeHistoryFile(env, all.map((l) => l.text));
      } else if (hl.added.length > 0) {
        await fs.appendText(join(dir, HISTORY_FILE), `${hl.added.map((l) => l.text).join("\n")}\n`, { fsync: true });
      }
      writer = new StoreWriter(env, {
        planId,
        ledger: st.ledger,
        tracker,
        lock: mine,
        snapshotSeq: st.snapshotSeq,
        journal: st.files[st.files.length - 1] ?? null,
        needsRotate: st.dirty,
      });
      await writer.start();
      if (takeover !== null) {
        await writer.append([{ type: "lock-takeover", reason: takeover.reason, previous: takeover.previous, holder: mine }]);
      }
      return writer;
    } catch (e) {
      if (writer !== null) writer.abandon();
      await releaseLockQuietly(dir, mine);
      throw e;
    }
  };

  const requireDir = async (planId: PlanId): Promise<string> => {
    const dir = dirOf(planId);
    if ((await fs.lstat(dir)) === null) throw new ExecutorError("E_LEDGER_NOT_FOUND", `no ledger for plan ${planId}`, { planId });
    return dir;
  };

  const read = async (planId: PlanId): Promise<LedgerV1> => {
    const dir = await requireDir(planId);
    const st = await loadMainConsistent(fs, clock, dir);
    emit(st.warnings);
    return st.ledger;
  };

  return {
    async create(draft, holder) {
      if (!isLedgerV1(draft) || draft.seq !== 1) {
        throw new ExecutorError("E_SCHEMA_INVALID", "create needs a valid LedgerV1 draft with seq 1", jsonDetail(ledgerViolations(draft).slice(0, 20)));
      }
      const planId = draft.planId;
      const dir = dirOf(planId);
      if ((await fs.lstat(dir)) !== null) throw new ExecutorError("E_EXISTS", `plan ${planId} already exists`, { planId });
      await fs.mkdir(dir);
      let mine: LockHolder;
      try {
        mine = await acquireExclusive(dir, holder);
      } catch (e) {
        if (e instanceof ExecutorError && e.code === "E_LOCK_HELD") {
          throw new ExecutorError("E_EXISTS", `plan ${planId} is being created elsewhere`, { planId });
        }
        throw e;
      }
      try {
        const ledger = JSON.parse(JSON.stringify(draft)) as LedgerV1;
        const init: ExecutorEvent = { seq: 1, at: clock.iso(), batch: 1, last: true, type: "ledger-init", ledger };
        const journal: JournalFile = { name: "events.1.jsonl", first: 1 };
        await fs.writeText(join(dir, journal.name), `${JSON.stringify(init)}\n`, { exclusive: true, fsync: true });
        const tmp = join(dir, `${SNAPSHOT_FILE}.tmp-${proc.pid}-${clock.randomHex(4)}`);
        await fs.writeText(tmp, JSON.stringify(ledger), { fsync: true });
        await retryBusy(clock, () => fs.rename(tmp, join(dir, SNAPSHOT_FILE)));
        await fs.fsyncDir(dir);
        const writer = new StoreWriter(envOf(dir), {
          planId,
          ledger,
          tracker: new HistoryTracker(),
          lock: mine,
          snapshotSeq: 1,
          journal,
          needsRotate: false,
        });
        await writer.start();
        return writer;
      } catch (e) {
        try {
          await rmQuiet(fs, dir, true);
        } catch (cleanup) {
          warn(`could not remove the half-created plan directory ${dir}: ${errMessage(cleanup)}`);
        }
        throw e;
      }
    },

    async open(planId, holder) {
      const dir = await requireDir(planId);
      const mine = await acquireExclusive(dir, holder);
      return buildWriter(planId, dir, mine, null);
    },

    async takeover(planId, holder, reason) {
      const dir = await requireDir(planId);
      const { mine, previous } = await takeLock(dir, holder, reason);
      return buildWriter(planId, dir, mine, { reason, previous });
    },

    read,

    async list() {
      let names: string[];
      try {
        names = await fs.readdir(deps.home);
      } catch (e) {
        if (fsErrorCode(e) === "ENOENT") return [];
        throw e;
      }
      const out: Array<{ planId: PlanId; status: LedgerStatus; toplevel: string; orchestratorSessionID: string; seq: number }> = [];
      for (const name of names.sort()) {
        if (name === SLOT_MARKERS_DIRNAME || !isPlanId(name)) continue;
        try {
          const l = await read(name);
          out.push({ planId: l.planId, status: l.status, toplevel: l.repo.toplevel, orchestratorSessionID: l.orchestrator.sessionID, seq: l.seq });
        } catch (e) {
          if (e instanceof ExecutorError && e.code === "E_LEDGER_NOT_FOUND") continue;
          warn(`plan ${name} is unreadable and skipped: ${errMessage(e)}`);
        }
      }
      return out;
    },

    async exportPlan(planId) {
      const dir = await requireDir(planId);
      const st = await loadMainConsistent(fs, clock, dir);
      emit(st.warnings);
      const hist = parseJournal((await readOptional(fs, join(dir, HISTORY_FILE))) ?? "", HISTORY_FILE);
      checkHistory(hist.lines, HISTORY_FILE);
      const bySeq = new Map<number, ExecutorEvent>();
      for (const l of hist.lines) if (l.event.seq <= st.ledger.seq) bySeq.set(l.event.seq, l.event);
      for (const l of st.events) if (l.event.seq <= st.ledger.seq) bySeq.set(l.event.seq, l.event);
      const events = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
      return { snapshot: st.ledger, events };
    },

    async remove(planId) {
      const dir = dirOf(planId);
      if ((await fs.lstat(dir)) === null) return false;
      const me: LockHolder = { pid: proc.pid, hostname: proc.hostname, sessionID: "remove", startedAt: clock.iso(), heartbeatAt: clock.iso() };
      let mine: LockHolder;
      try {
        mine = await acquireExclusive(dir, me);
      } catch (e) {
        if (!(e instanceof ExecutorError) || e.code !== "E_LOCK_HELD") throw e;
        const cur = await readLock(dir);
        if (!cur.exists || !isStale(cur.holder, cur.mtimeMs)) throw e;
        await rmQuiet(fs, join(dir, LOCK_FILE));
        mine = await acquireExclusive(dir, me);
      }
      try {
        let status: LedgerStatus | null = null;
        try {
          status = (await loadMain(fs, dir, "writer")).ledger.status;
        } catch (e) {
          // A directory that never got a ledger (a create that died early) holds nothing worth keeping.
          if (!(e instanceof ExecutorError) || e.code !== "E_LEDGER_NOT_FOUND") throw e;
        }
        if (status !== null && status !== "completed" && status !== "aborted") {
          throw new ExecutorError("E_PLAN_STATE", `plan ${planId} is ${status}; only completed or aborted plans can be removed`, { planId, status });
        }
      } catch (e) {
        await releaseLockQuietly(dir, mine);
        throw e;
      }
      await retryBusy(clock, () => fs.rm(dir, { recursive: true }));
      return true;
    },
  };
}

function fsErrorCode(e: unknown): string | undefined {
  if (typeof e === "object" && e !== null && "code" in e) {
    const c = (e as { code?: unknown }).code;
    return typeof c === "string" ? c : undefined;
  }
  return undefined;
}

/** Production `FileSystem` over node:fs. Nothing runs at module load; every call is made on demand. */
export function createNodeFileSystem(): FileSystem {
  return {
    readText: (p) => nodeFsp.readFile(p, "utf8"),
    async writeText(p, data, o) {
      const fh = await nodeFsp.open(p, o?.exclusive === true ? "wx" : "w");
      try {
        await fh.writeFile(data, "utf8");
        if (o?.fsync === true) await fh.sync();
      } finally {
        await fh.close();
      }
    },
    async appendText(p, data, o) {
      const fh = await nodeFsp.open(p, "a");
      try {
        await fh.appendFile(data, "utf8");
        if (o.fsync) await fh.sync();
      } finally {
        await fh.close();
      }
    },
    rename: (a, b) => nodeFsp.rename(a, b),
    rm: (p, o) => nodeFsp.rm(p, { recursive: o.recursive, force: true }),
    async mkdir(p) {
      await nodeFsp.mkdir(p, { recursive: true });
    },
    readdir: (p) => nodeFsp.readdir(p),
    async lstat(p): Promise<FsStat | null> {
      try {
        const s = await nodeFsp.lstat(p);
        const kind: FsStat["kind"] = s.isSymbolicLink() ? "symlink" : s.isDirectory() ? "dir" : s.isFile() ? "file" : "other";
        return { kind, size: s.size, mtimeMs: s.mtimeMs };
      } catch (e) {
        if (fsErrorCode(e) === "ENOENT") return null;
        throw e;
      }
    },
    realpath: (p) => nodeFsp.realpath(p),
    async fsyncDir(p) {
      let fd: number;
      try {
        fd = nodeFs.openSync(p, "r");
      } catch (e) {
        // Windows cannot open a directory for fsync; NTFS journals the directory entry itself.
        const c = fsErrorCode(e);
        if (c === "EISDIR" || c === "EPERM" || c === "EACCES" || c === "EINVAL") return;
        throw e;
      }
      try {
        nodeFs.fsyncSync(fd);
      } catch (e) {
        const c = fsErrorCode(e);
        if (c !== "EISDIR" && c !== "EPERM" && c !== "EACCES" && c !== "EINVAL" && c !== "ENOTSUP") throw e;
      } finally {
        nodeFs.closeSync(fd);
      }
    },
  };
}
