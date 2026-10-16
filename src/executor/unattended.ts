// UnattendedPolicy (task 4.2.2): the inbox, parking, answers and the circuit breaker (memo phase-4.2.md §1-§3).
import type {
  Attempt, ExecutorConfig, ExecutorEventInput, InboxItem, InboxKind, IsoTime, JsonValue, LeaseService, LedgerV1,
  LedgerWriter, PhaseId, QaLoop, TaskId, TaskState, TransitionTrigger, UnattendedPolicy, Waker, Clock,
} from "./types.js";
import {
  ExecutorError, QA_CAP_OPTIONS, TRANSITION_TRIGGERS, countsTowardMaxAttempts, formatInboxId, isBreakerFailure,
  nextInboxNumber,
} from "./types.js";
import { edgeSatisfied } from "./schedule.js";

/** Diagnostics sink with the shape of `RuntimeDeps.log`. */
export type UnattendedLog = (level: "info" | "warn" | "error", msg: string, detail?: JsonValue) => void;

export interface UnattendedDeps {
  writer: LedgerWriter;
  /** Only `releaseTask` is used (P3). */
  leases: Pick<LeaseService, "releaseTask">;
  waker: Waker;
  /** Only `onCapAnswer` is used (U4, QA9). */
  qa: Pick<QaLoop, "onCapAnswer">;
  clock: Clock;
  log: UnattendedLog;
  /**
   * pdf2-1 (b): called by `park` before the batch that clears the task's slot (`task-slot slot:null`), while the task still
   * holds `slot`; the runtime saves the slot's work there. QA-PDF21-3: `false` or a throw means the work could not be
   * saved: the park goes on but keeps the slot (no `task-slot slot:null`, no lease release), so nothing resets or
   * releases it; the runtime raises the blocking item that names the slot.
   */
  beforeSlotRelease?(taskId: TaskId, slot: string, cause: ParkCause): Promise<boolean | void>;
  /** QA-PDF21-7: the options of the park item `park` writes for `taskId` (none by default). */
  parkOptions?(taskId: TaskId, cause: ParkCause): readonly string[];
}

export const INBOX_TEXT_MAX = 4000; // U3

/** Counter key of the "attempt fed to the breaker" marker; the runtime's `BREAKER_FED` (runtime.ts) uses the same key. */
export const BREAKER_FED = "breaker-fed";

export function boundInboxText(s: string): string {
  return s.length <= INBOX_TEXT_MAX ? s : `${s.slice(0, INBOX_TEXT_MAX)}…`;
}

/** The cause of a park, as `UnattendedPolicy.park` takes it (rows 17, 36). */
export type ParkCause = Parameters<UnattendedPolicy["park"]>[1];

/** U1: escalate and ambiguity are questions; qa-unparsable and exhausted are failures. All blocking. */
export function parkItemKind(cause: ParkCause): { kind: InboxKind; severity: "blocking" } {
  return { kind: cause === "escalate" || cause === "ambiguity" ? "question" : "failure", severity: "blocking" };
}

/**
 * P2: the pending transitive dependents of `taskId` over dependency edges. A direct dependent gets `dep-parked`, a deeper one
 * `dep-blocked`. Only pending tasks are included and traversed; breadth-first, sorted by id per level.
 */
export function pendingDependentsClosure(
  l: Readonly<LedgerV1>, taskId: TaskId,
): Array<{ id: TaskId; trigger: "dep-parked" | "dep-blocked" }> {
  const out: Array<{ id: TaskId; trigger: "dep-parked" | "dep-blocked" }> = [];
  const seen = new Set<TaskId>([taskId]);
  let level: TaskId[] = [taskId];
  let direct = true;
  while (level.length > 0) {
    const next = new Set<TaskId>();
    for (const from of level) {
      for (const e of l.edges) {
        if (e.from !== from || seen.has(e.to)) continue;
        const t = Object.hasOwn(l.tasks, e.to) ? l.tasks[e.to] : undefined;
        if (t !== undefined && t.state === "pending") next.add(e.to);
      }
    }
    const sorted = [...next].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const id of sorted) {
      seen.add(id);
      out.push({ id, trigger: direct ? "dep-parked" : "dep-blocked" });
    }
    level = sorted;
    direct = false;
  }
  return out;
}

const SUCCESS_STATES: readonly TaskState[] = ["done", "verified", "integrating", "integrated"];

function ms(t: IsoTime): number {
  return Date.parse(t);
}

/** B1: the breaker window start of a phase: the createdAt of its newest breaker item (null = all attempts). */
function breakerWindowStart(l: Readonly<LedgerV1>, phaseId: PhaseId): number | null {
  let start: number | null = null;
  for (const item of l.inbox) {
    if (item.kind !== "breaker" || item.taskId === null) continue;
    const t = Object.hasOwn(l.tasks, item.taskId) ? l.tasks[item.taskId] : undefined;
    if (t === undefined || t.phase !== phaseId) continue;
    const at = ms(item.createdAt);
    if (start === null || at >= start) start = at;
  }
  return start;
}

/**
 * QA-4.2-19: states a task with a succeeded, verdict-less latest attempt can hold without a commit failure: still
 * committing, verifying, landing or finished, and `conflict`/`reverted`, which only follow a landed commit.
 */
const NOT_COMMIT_FAILED_STATES: readonly TaskState[] =
  ["completed", "verifying", "verified", "integrating", "integrated", "done", "cancelled", "conflict", "reverted"];

/**
 * A2 (amendment A-4.2-2 to B1): a systemic post-child failure is a breaker FAILURE. The child succeeded without a
 * verdict, yet its task went `completed -> failed` (trigger `commit-failed`: E_IDENTITY / E_GIT, or "no changes" while
 * writes were declared). The ledger keeps no transition list, so the fact is derived. A non-latest succeeded attempt
 * with no verdict was followed by a retry, which only `commit-failed` allows (`completed` leaves for `failed` only
 * that way). The latest one counts whenever the task is outside `NOT_COMMIT_FAILED_STATES` (QA-4.2-19): `failed`, or
 * the `ready`/`parked`/`blocked` the retry decision moves it to right after the feed, so the sample outlives the move.
 */
export function isCommitFailure(t: Readonly<LedgerV1["tasks"][string]>, a: Attempt): boolean {
  if (a.outcome !== "succeeded" || a.verdict !== null) return false;
  return a !== t.attempts[t.attempts.length - 1] || !NOT_COMMIT_FAILED_STATES.includes(t.state);
}

/**
 * B1: the counted samples of a phase since its newest breaker item, ordered by endedAt, then (taskId, n).
 * Pure function of the ledger, so a restart rebuilds it exactly.
 */
export function breakerSamples(
  l: Readonly<LedgerV1>, phaseId: PhaseId,
): Array<{ taskId: TaskId; n: number; endedAt: IsoTime; failure: boolean }> {
  const start = breakerWindowStart(l, phaseId);
  const out: Array<{ taskId: TaskId; n: number; endedAt: IsoTime; failure: boolean }> = [];
  for (const t of Object.values(l.tasks)) {
    if (t.phase !== phaseId) continue;
    t.attempts.forEach((a, i) => {
      if (a.endedAt === null || !countsTowardMaxAttempts(a)) return;
      if (start !== null && !(ms(a.endedAt) > start)) return;
      const nextStart = t.attempts[i + 1]?.startedAt ?? null;
      const lo = ms(a.startedAt);
      const hi = nextStart === null ? Number.POSITIVE_INFINITY : ms(nextStart);
      const flaky = l.inbox.some((it) => {
        if (it.kind !== "flaky" || it.taskId !== t.id) return false;
        const at = ms(it.createdAt);
        return at >= lo && at < hi;
      });
      if (flaky) return;
      const failure = isBreakerFailure(a) || isCommitFailure(t, a);
      const latest = i === t.attempts.length - 1;
      const success = !failure && a.outcome === "succeeded" &&
        (a.verdict === "pass" || (a.verdict === null && latest && SUCCESS_STATES.includes(t.state)));
      if (!failure && !success) return;
      out.push({ taskId: t.id, n: a.n, endedAt: a.endedAt, failure });
    });
  }
  out.sort((x, y) => {
    const d = ms(x.endedAt) - ms(y.endedAt);
    if (d !== 0) return d;
    if (x.taskId !== y.taskId) return x.taskId < y.taskId ? -1 : 1;
    return x.n - y.n;
  });
  return out;
}

/**
 * B2 (amendment X11): N samples, F failures, C trailing run of failures. The ratio rule is STRICT: F > failureRatio * N
 * (the epsilon keeps 6/15 at ratio 0.4 from tripping on float noise); the consecutive rule is C >= consecutiveFailures.
 */
export function breakerTrips(
  s: ReturnType<typeof breakerSamples>, c: ExecutorConfig["circuitBreaker"],
): { tripped: boolean; reason: "ratio" | "consecutive" | null; failures: number; attempts: number; consecutive: number } {
  const attempts = s.length;
  let failures = 0;
  let consecutive = 0;
  for (const x of s) {
    if (x.failure) { failures += 1; consecutive += 1; } else consecutive = 0;
  }
  const ratio = attempts >= c.minAttempts && failures > c.failureRatio * attempts + 1e-9;
  const run = consecutive >= c.consecutiveFailures;
  const reason = ratio ? "ratio" : run ? "consecutive" : null;
  return { tripped: reason !== null, reason, failures, attempts, consecutive };
}

function taskOf(l: Readonly<LedgerV1>, id: TaskId | null): Readonly<LedgerV1["tasks"][string]> | undefined {
  if (id === null) return undefined;
  return Object.hasOwn(l.tasks, id) ? l.tasks[id] : undefined;
}

/** The phase an inbox item belongs to: the phase of its task. */
function itemPhase(l: Readonly<LedgerV1>, item: InboxItem): PhaseId | null {
  return taskOf(l, item.taskId)?.phase ?? null;
}

function openItemOf(l: Readonly<LedgerV1>, taskId: TaskId): InboxItem | undefined {
  for (let i = l.inbox.length - 1; i >= 0; i -= 1) {
    const it = l.inbox[i];
    if (it !== undefined && it.taskId === taskId && it.answer === null) return it;
  }
  return undefined;
}

/**
 * QA-4.2-5: the item the park batch of a parked task created. `park` writes the item text and the latest attempt's
 * context from the same bounded string, so the park item is the newest open question/failure item of the task whose
 * text equals that context. If no item matches (a later writer changed the context), the oldest open question/failure
 * item of the task is used: the park item is older than anything raised after the park.
 */
export function parkItemOf(l: Readonly<LedgerV1>, t: Readonly<LedgerV1["tasks"][string]>): InboxItem | undefined {
  const last = t.attempts[t.attempts.length - 1];
  const cands = l.inbox.filter((x) => x.taskId === t.id && x.answer === null && (x.kind === "question" || x.kind === "failure"));
  if (last !== undefined) {
    // Both sides bounded: a legacy context longer than INBOX_TEXT_MAX still matches its (bounded) park item.
    const marker = boundInboxText(last.context);
    for (const c of [...cands].reverse()) {
      if (boundInboxText(c.text) === marker) return c;
    }
  }
  return cands[0];
}

const RUNNING_CAUSES: readonly ParkCause[] = ["escalate", "ambiguity", "qa-unparsable", "budget-cap"];

/**
 * pdf2-1 (a): the `running -> parked` trigger of a running cause: the cause itself (`budget-cap` included, which
 * `TRANSITION_TRIGGERS["running>parked"]` admits). A cause the table does not admit for that pair is refused here, before
 * any batch, rather than by the ledger's replay.
 */
export function runningParkTrigger(cause: ParkCause): { trigger: TransitionTrigger; detail: string | null } {
  if (TRANSITION_TRIGGERS["running>parked"]?.includes(cause) !== true) {
    throw new ExecutorError("E_INVALID_INPUT", `${cause} does not park a running task`, { cause });
  }
  return { trigger: cause, detail: null };
}
const EXHAUSTED_FROM: readonly TaskState[] = ["conflict", "failed", "reverted"];

export function createUnattendedPolicy(d: UnattendedDeps): UnattendedPolicy {
  const wakeInbox = async (id: string): Promise<void> => {
    try {
      await d.waker.wake("inbox", `inbox:${id}`);
    } catch (e) {
      d.log("warn", "inbox wake failed", e instanceof Error ? e.message : String(e));
    }
  };
  const releaseLeases = (taskId: TaskId): void => {
    try {
      d.leases.releaseTask(taskId);
    } catch (e) {
      d.log("warn", "lease release failed", e instanceof Error ? e.message : String(e));
    }
  };

  /**
   * QA-4.2-22: journals that attempt `n` of `taskId` was fed to `recordAttempt`, with the exact shape of the runtime's
   * `markFed` (a `counter` metric, a history event), so the runtime's breaker re-feed does not feed it again.
   * A failed append is logged: the worst case is one duplicate evaluation, which trips at most once per window.
   */
  const markFed = async (phaseId: PhaseId, taskId: TaskId, n: number): Promise<void> => {
    try {
      await d.writer.append([{
        type: "metric", metric: { name: "counter", key: BREAKER_FED, value: 1, labels: { phaseId, taskId, n: String(n) } },
      }]);
    } catch (e) {
      d.log("warn", "breaker-fed marker append failed", e instanceof Error ? e.message : String(e));
    }
  };

  const raise: UnattendedPolicy["raise"] = async (i) => {
    const text = boundInboxText(i.text);
    const out: { item: InboxItem | null; written: boolean } = { item: null, written: false };
    await d.writer.append((l) => {
      const dup = l.inbox.find((x) => x.answer === null && x.kind === i.kind && x.taskId === i.taskId && x.text === text);
      if (dup !== undefined) {
        out.item = dup;
        out.written = false;
        return [];
      }
      const item: InboxItem = {
        id: formatInboxId(i.kind, nextInboxNumber(l)), kind: i.kind, severity: i.severity, taskId: i.taskId, text,
        options: [...i.options], answer: i.answer ?? null, createdAt: d.clock.iso(),
      };
      out.item = item;
      out.written = true;
      return [{ type: "inbox-added", item }];
    });
    const item = out.item;
    if (item === null) throw new ExecutorError("E_PLAN_STATE", "inbox item was not produced");
    if (out.written && item.answer === null) await wakeInbox(item.id);
    return item;
  };

  const park: UnattendedPolicy["park"] = async (taskId, cause, text) => {
    const bounded = boundInboxText(text);
    const out: {
      item: InboxItem | null; written: boolean; releaseSlot: boolean; feed: { phaseId: PhaseId; nonce: string } | null;
    } = { item: null, written: false, releaseSlot: false, feed: null };
    const t0 = taskOf(d.writer.ledger, taskId);
    if (t0 === undefined) {
      throw new ExecutorError("E_INVALID_INPUT", `unknown task ${taskId}`, { taskId });
    }
    // pdf2-1 (b): the slot's work is saved before the batch below clears the slot. QA-PDF21-3: a failed save keeps it on
    // the parked task (A1-7 lets a parked task hold a slot for this; before that amendment the batch was refused).
    let keptSlot: string | null = null;
    if (t0.slot !== null && d.beforeSlotRelease !== undefined) {
      try {
        if ((await d.beforeSlotRelease(taskId, t0.slot, cause)) === false) keptSlot = t0.slot;
      } catch (e) {
        keptSlot = t0.slot;
        d.log("warn", "saving the slot's work before the park failed; the slot is kept", e instanceof Error ? e.message : String(e));
      }
    }
    let options: string[] = [];
    try {
      options = [...(d.parkOptions?.(taskId, cause) ?? [])];
    } catch (e) {
      d.log("warn", "park options failed", e instanceof Error ? e.message : String(e));
    }
    await d.writer.append((l) => {
      out.written = false;
      out.releaseSlot = false;
      out.feed = null;
      const t = taskOf(l, taskId);
      if (t === undefined) throw new ExecutorError("E_INVALID_INPUT", `unknown task ${taskId}`, { taskId });
      const legal = RUNNING_CAUSES.includes(cause)
        ? t.state === "running"
        : cause === "exhausted" && EXHAUSTED_FROM.includes(t.state);
      if (!legal) {
        const open = openItemOf(l, taskId);
        if (open === undefined) {
          throw new ExecutorError("E_PLAN_STATE", `task ${taskId} is ${t.state}: cannot park (${cause})`, { taskId });
        }
        out.item = open;
        return [];
      }
      const events: ExecutorEventInput[] = [];
      const now = d.clock.iso();
      if (RUNNING_CAUSES.includes(cause)) {
        const last = t.attempts[t.attempts.length - 1];
        if (last !== undefined) {
          if (last.endedAt === null) {
            events.push({
              type: "attempt-ended", taskId, n: last.n, outcome: cause === "qa-unparsable" ? "failed" : "interrupted",
              endedAt: now, detail: cause,
            });
          }
          events.push({ type: "attempt-context", taskId, n: last.n, context: bounded });
          if (cause === "qa-unparsable") out.feed = { phaseId: t.phase ?? "", nonce: last.nonce };
        }
        events.push({ type: "task-transition", taskId, from: "running", to: "parked", ...runningParkTrigger(cause) });
      } else {
        // QA-4.2-5: the same marker as the running causes, so `answer` can tell the park item from any other item.
        const last = t.attempts[t.attempts.length - 1];
        if (last !== undefined) events.push({ type: "attempt-context", taskId, n: last.n, context: bounded });
        events.push({ type: "task-transition", taskId, from: t.state, to: "parked", trigger: "exhausted", detail: null });
      }
      if (t.slot !== null && t.slot !== keptSlot) {
        events.push({ type: "task-slot", taskId, slot: null, branch: t.branch });
        out.releaseSlot = true;
      }
      if (cause !== "exhausted" && t.kind === "qa" && t.phase !== null) {
        const ph = l.phases.find((p) => p.id === t.phase);
        if (ph !== undefined && ph.gate === "qa-running") {
          events.push({
            type: "gate-changed", phaseId: ph.id, from: "qa-running", to: "awaiting-qa", trigger: "qa-requeued",
            qaRound: ph.qaRound,
          });
        }
      }
      const kind = parkItemKind(cause);
      const item: InboxItem = {
        id: formatInboxId(kind.kind, nextInboxNumber(l)), kind: kind.kind, severity: kind.severity, taskId, text: bounded,
        options: [...options], answer: null, createdAt: now,
      };
      events.push({ type: "inbox-added", item });
      for (const dep of pendingDependentsClosure(l, taskId)) {
        events.push({
          type: "task-transition", taskId: dep.id, from: "pending", to: "blocked", trigger: dep.trigger, detail: taskId,
        });
      }
      out.item = item;
      out.written = true;
      return events;
    });
    const item = out.item;
    if (item === null) throw new ExecutorError("E_PLAN_STATE", "park produced no inbox item");
    if (!out.written) return item;
    if (out.releaseSlot) releaseLeases(taskId);
    await wakeInbox(item.id);
    if (out.feed !== null && out.feed.phaseId !== "") {
      const t = taskOf(d.writer.ledger, taskId);
      const a = t?.attempts.find((x) => x.nonce === out.feed?.nonce);
      if (a !== undefined) {
        await recordAttempt(out.feed.phaseId, a);
        await markFed(out.feed.phaseId, taskId, a.n);
      }
    }
    return item;
  };

  const answer: UnattendedPolicy["answer"] = async (inboxId, text) => {
    const item0 = d.writer.ledger.inbox.find((x) => x.id === inboxId);
    if (item0 === undefined || item0.answer !== null) {
      throw new ExecutorError("E_INVALID_INPUT", `inbox item ${inboxId} is not open`, { inboxId });
    }
    if (item0.kind === "qa-cap" && item0.severity === "critical") {
      const choice = text.trim().toLowerCase();
      const opt = QA_CAP_OPTIONS.find((o) => o === choice && item0.options.includes(o));
      if (opt === undefined) {
        throw new ExecutorError("E_INVALID_INPUT", `answer must be one of ${item0.options.join(", ")}`, { inboxId });
      }
      await d.qa.onCapAnswer(inboxId, opt);
      return { resumed: null };
    }
    const out: { resumed: TaskId | null } = { resumed: null };
    await d.writer.append((l) => {
      out.resumed = null;
      const item = l.inbox.find((x) => x.id === inboxId);
      if (item === undefined || item.answer !== null) {
        throw new ExecutorError("E_INVALID_INPUT", `inbox item ${inboxId} is not open`, { inboxId });
      }
      const events: ExecutorEventInput[] = [{ type: "inbox-answered", id: inboxId, answer: text }];
      const t = taskOf(l, item.taskId);
      if (item.kind === "breaker") {
        const phaseId = itemPhase(l, item);
        const ph = phaseId === null ? undefined : l.phases.find((p) => p.id === phaseId);
        if (ph !== undefined && ph.paused) {
          const other = l.inbox.some((x) =>
            x.id !== inboxId && x.answer === null && x.severity === "critical" && itemPhase(l, x) === ph.id);
          if (!other) events.push({ type: "phase-paused", phaseId: ph.id, paused: false, reason: "breaker answered" });
        }
      } else if (t !== undefined && t.state === "parked" && parkItemOf(l, t)?.id === item.id) {
        const last = t.attempts[t.attempts.length - 1];
        if (last !== undefined) events.push({ type: "attempt-context", taskId: t.id, n: last.n, context: text });
        events.push({ type: "task-transition", taskId: t.id, from: "parked", to: "ready", trigger: "answered", detail: inboxId });
        out.resumed = t.id;
      }
      return events;
    });
    return { resumed: out.resumed };
  };

  const unblock: UnattendedPolicy["unblock"] = async () => {
    const ids: TaskId[] = [];
    await d.writer.append((l) => {
      ids.length = 0;
      const events: ExecutorEventInput[] = [];
      for (const t of Object.values(l.tasks)) {
        if (t.state !== "blocked") continue;
        const ok = l.edges.every((e) => e.to !== t.id || edgeSatisfied(l, e));
        if (!ok) continue;
        ids.push(t.id);
        events.push({ type: "task-transition", taskId: t.id, from: "blocked", to: "ready", trigger: "dep-recovered", detail: null });
      }
      return events;
    });
    return [...ids];
  };

  const recordAttempt: UnattendedPolicy["recordAttempt"] = async (phaseId, a) => {
    const l0 = d.writer.ledger;
    const owner = Object.values(l0.tasks).find((t) => t.attempts.some((x) => x.nonce === a.nonce));
    if (owner === undefined) return { tripped: false };
    const att: Attempt = owner.attempts.find((x) => x.nonce === a.nonce) ?? a;
    if (!isBreakerFailure(att) && !isCommitFailure(owner, att)) return { tripped: false };
    const out: { item: InboxItem | null } = { item: null };
    await d.writer.append((l) => {
      out.item = null;
      const ph = l.phases.find((p) => p.id === phaseId);
      if (ph === undefined || ph.paused) return [];
      const open = l.inbox.some((x) => x.kind === "breaker" && x.answer === null && itemPhase(l, x) === phaseId);
      if (open) return [];
      const r = breakerTrips(breakerSamples(l, phaseId), l.config.circuitBreaker);
      if (!r.tripped) return [];
      const kind: InboxKind = "breaker";
      const item: InboxItem = {
        id: formatInboxId(kind, nextInboxNumber(l)), kind, severity: "critical", taskId: owner.id,
        text: `phase ${phaseId} circuit breaker: ${r.failures}/${r.attempts} failed (${r.reason ?? "none"}), ${r.consecutive} consecutive`,
        options: [], answer: null, createdAt: d.clock.iso(),
      };
      out.item = item;
      return [
        { type: "phase-paused", phaseId, paused: true, reason: "breaker" },
        { type: "inbox-added", item },
      ];
    });
    if (out.item === null) return { tripped: false };
    await wakeInbox(out.item.id);
    return { tripped: true };
  };

  return { raise, park, answer, unblock, recordAttempt };
}
