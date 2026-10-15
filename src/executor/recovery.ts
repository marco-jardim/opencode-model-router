// RecoveryService (plan task 4.2.4): evidence-based reconciliation of executor ledgers after a restart.
// Design: docs/qa/critical-path-execution/phase-4.2.md sections 5-8 (R1-R5, L1-L6, D1-D12).
//
// `reconcile` is classification only: it never writes a ledger, resets a slot or interrupts a session. The runtime
// applies the feeds (interrupts orphans, requeues, adopts, runs the probation watch) while it holds the plan's lock.

import { realpathSync } from "node:fs";
import { withoutHostPreamble } from "./host-preamble.js";
import { ADOPT_TAKEOVER_REASON } from "./ledger.js";
import type { ProcessIdentity } from "./process-identity.js";
import { ExecutorError, LAUNCH_HEADER_PATTERN, parseLaunchHeader } from "./types.js";
import type {
  Attempt, Clock, HostSessionContext, HostSessions, LedgerStore, LedgerV1, LockHolder, PlanId, ReconcileAction,
  RecoveryService, TaskId, TaskNode,
} from "./types.js";

export const RECOVERY_LIVENESS_MS = 60_000;
export const RECOVERY_POLL_MS = 10_000;
export const RECOVER_TAKEOVER_REASON = "recover";

export type RecoveryHost = Pick<HostSessions, "get" | "context" | "activity" | "interrupt">;
export type RecoveryLog = (level: "info" | "warn" | "error", msg: string, detail?: Record<string, string | number | boolean | null>) => void;
export type ChildEvidence = "finished" | "alive" | "unknown" | "lost" | "mismatch";

export interface ReconcileFeed extends ReconcileAction {
  /** Latest attempt number, null without attempts. */
  n: number | null;
  /** Child recorded on that attempt. */
  childSessionID: string | null;
  /** The child's context when it was read. */
  context: HostSessionContext | null;
  /** R1a: set when the child's liveness is unknown; the runtime runs the watch, recovery only reports the deadline. */
  probation: { deadlineAt: number; pollMs: number } | null;
  /** The child exists but does not carry this attempt's launch header (reported as evidence `lost`). */
  mismatch: boolean;
  /** Sessions to interrupt: closed attempts' children that still run, plus a mismatching child naming this plan. */
  orphans: string[];
  /** R2: the slot marker names this plan and task; null when the task has no slot (or the state does not use one). */
  slotValid: boolean | null;
}

export interface RecoveryEngine extends RecoveryService {
  /** Classification only; no writes, interrupts or resets. Called with the plan's lock held. */
  reconcile(l: Readonly<LedgerV1>, tracked: ReadonlySet<string /* nonce */>): Promise<ReconcileFeed[]>;
}

export interface RecoveryDeps {
  store: LedgerStore;
  host: RecoveryHost;
  /** This session's repository toplevel. */
  toplevel: string;
  holder(sessionID: string): LockHolder;
  slotMarker(slotPath: string): Promise<{ planId: PlanId; taskId: TaskId } | null>;
  clock: Clock;
  log: RecoveryLog;
  livenessMs?: number;
  pollMs?: number;
  /** v2 only: a dead launcher proves inactivity; every other case keeps the host's unknown answer. */
  launcherLiveness?: { self: ProcessIdentity; isAlive: (pid: number) => boolean };
}

/**
 * R1 rules 3-6 for one recorded child. `info` is `HostSessions.get`, `ctx` is `context`, `activity` is `activity`.
 * The first user message, after the v2 host's one preamble line when it carries it (QA-4.2-1), is parsed strictly as a
 * launch header; `sharedContext` is the ledger's (when omitted it is read off the message itself: everything between
 * "PLAN CONTEXT\n" and the blank line before the header line). Rule 5 (amended, QA-4.2-2): the child is finished only when
 * its context ends with the host's explicit terminal entry (`idle` with an outcome); an `idle` without one is not an end.
 */
export function classifyChild(
  info: { id: string; parentID: string | null } | null,
  ctx: HostSessionContext | null,
  activity: "active" | "inactive" | "unknown",
  expect: { planId: PlanId; taskId: TaskId; n: number; nonce: string },
  sharedContext?: string,
): ChildEvidence {
  if (info === null) return "lost";
  const h = headerOf(ctx, sharedContext);
  if (h === null || h.planId !== expect.planId || h.taskId !== expect.taskId || h.attempt !== expect.n || h.nonce !== expect.nonce) {
    return "mismatch";
  }
  if (endedOf(ctx)) return "finished";
  if (activity === "active") return "alive";
  if (activity === "inactive") return "lost";
  return "unknown";
}

/**
 * QA-4.2-2: an explicit terminal entry (the host reported the child ended, with its outcome). A last `idle` without an
 * outcome is not evidence of an end (defensive), so it is never read as finished.
 */
function endedOf(ctx: HostSessionContext | null): boolean {
  const last = ctx === null ? undefined : ctx.messages[ctx.messages.length - 1];
  return last !== undefined && last.role === "idle" && last.outcome !== null;
}

function headerOf(ctx: HostSessionContext | null, sharedContext: string | undefined): ReturnType<typeof parseLaunchHeader> {
  const first = ctx === null ? undefined : ctx.messages.find((m) => m.role === "user");
  const raw = first?.text ?? null;
  if (raw === null) return null;
  // QA-4.2-1: on v2 the host prefixes every native subagent's first user message with its one preamble line.
  const prompt = withoutHostPreamble(raw);
  const shared = sharedContext ?? inferSharedContext(prompt);
  return shared === null ? null : parseLaunchHeader(prompt, shared);
}

function inferSharedContext(prompt: string): string | null {
  const open = "PLAN CONTEXT\n";
  if (!prompt.startsWith(open)) return null;
  const m = LAUNCH_HEADER_PATTERN.exec(prompt);
  if (m === null) return null;
  const end = m.index - 2;
  if (end < open.length - 1 || prompt.slice(end, m.index) !== "\n\n") return null;
  return prompt.slice(open.length, end);
}

function normalizeToplevel(p: string): string {
  let real = p;
  try {
    real = realpathSync(p);
  } catch {
    // a path that cannot be resolved is compared as written
  }
  let s = real.replace(/\\/g, "/");
  while (s.length > 1 && s.endsWith("/") && !/^[A-Za-z]:\/$/.test(s)) s = s.slice(0, -1);
  return process.platform === "win32" ? s.toLowerCase() : s;
}

/** L5: real path, `/` separators, case-folded on win32. */
export function sameToplevel(a: string, b: string): boolean {
  return normalizeToplevel(a) === normalizeToplevel(b);
}

function isLockHeld(e: unknown): boolean {
  return e instanceof ExecutorError && e.code === "E_LOCK_HELD";
}

const TERMINAL = new Set(["completed", "aborted"]);
/** States whose slot marker is checked (R2). */
const SLOT_STATES = new Set(["ready", "dispatched", "running", "completed", "verifying", "verified"]);
/** States that always get a feed. */
const REPORTED_STATES = new Set([
  "ready", "dispatched", "running", "completed", "verifying", "verified", "integrating", "failed", "conflict", "reverted",
]);
const ORPHAN_OUTCOMES = new Set(["lost", "capacity", "interrupted"]);

interface ChildRead {
  evidence: ChildEvidence;
  context: HostSessionContext | null;
}

type LauncherActivity = (t: TaskNode, a: Attempt, child: string) => Promise<"inactive" | "unknown">;

export function createRecoveryService(d: RecoveryDeps): RecoveryEngine {
  const livenessMs = d.livenessMs ?? RECOVERY_LIVENESS_MS;
  const pollMs = d.pollMs ?? RECOVERY_POLL_MS;
  let recovered = false;

  async function inspect(l: Readonly<LedgerV1>, t: TaskNode, a: Attempt, childId: string, launcherActivity: LauncherActivity): Promise<ChildRead> {
    const expect = { planId: l.planId, taskId: t.id, n: a.n, nonce: a.nonce };
    try {
      const info = await d.host.get(childId);
      if (info === null) return { evidence: "lost", context: null };
      const ctx = await d.host.context(childId);
      let ev = classifyChild(info, ctx, "unknown", expect, l.sharedContext);
      if (ev === "unknown") {
        let activity = await d.host.activity(childId);
        if (activity === "unknown" && d.launcherLiveness !== undefined) activity = await launcherActivity(t, a, childId);
        ev = classifyChild(info, ctx, activity, expect, l.sharedContext);
      }
      return { evidence: ev, context: ctx };
    } catch (e) {
      d.log("warn", "recovery: host evidence unavailable; treating the child as unknown", {
        planId: l.planId, taskId: t.id, sessionID: childId, error: e instanceof Error ? e.message : String(e),
      });
      return { evidence: "unknown", context: null };
    }
  }

  /** True when the session is alive-ish (not idle) and its launch header names this plan. */
  async function namesPlanAndRuns(l: Readonly<LedgerV1>, sessionID: string): Promise<boolean> {
    try {
      const info = await d.host.get(sessionID);
      if (info === null) return false;
      const ctx = await d.host.context(sessionID);
      if (endedOf(ctx)) return false;
      const h = headerOf(ctx, l.sharedContext);
      return h !== null && h.planId === l.planId;
    } catch (e) {
      d.log("warn", "recovery: orphan check failed", {
        planId: l.planId, sessionID, error: e instanceof Error ? e.message : String(e),
      });
      return false;
    }
  }

  async function reconcileTask(
    l: Readonly<LedgerV1>, t: TaskNode, tracked: ReadonlySet<string>, launcherActivity: LauncherActivity,
  ): Promise<ReconcileFeed | null> {
    const latest: Attempt | undefined = t.attempts[t.attempts.length - 1];
    const child = latest?.childSessionID ?? null;
    const feed: ReconcileFeed = {
      taskId: t.id, from: t.state, evidence: "none", action: "none",
      n: latest?.n ?? null, childSessionID: child, context: null, probation: null, mismatch: false, orphans: [], slotValid: null,
    };
    // D12 / R1 rule 1: a launch this process tracks is never reconciled.
    if (latest !== undefined && tracked.has(latest.nonce)) {
      feed.evidence = "alive";
      return feed;
    }
    const orphans = new Set<string>();
    // Orphans: closed attempts' children that still run (the latest attempt's own child is handled by the matrix).
    const matrixOwnsLatest = t.state === "ready" || t.state === "dispatched" || t.state === "running";
    for (const a of t.attempts) {
      if ((a === latest && matrixOwnsLatest) || a.childSessionID === null || a.endedAt === null || a.outcome === null) continue;
      if (!ORPHAN_OUTCOMES.has(a.outcome) || (matrixOwnsLatest && a.childSessionID === child)) continue;
      if (await namesPlanAndRuns(l, a.childSessionID)) orphans.add(a.childSessionID);
    }
    if (t.slot !== null && SLOT_STATES.has(t.state)) {
      const marker = await d.slotMarker(t.slot);
      feed.slotValid = marker !== null && marker.planId === l.planId && marker.taskId === t.id;
    }
    const slotBad = feed.slotValid === false;
    const probation = (): { deadlineAt: number; pollMs: number } => ({ deadlineAt: d.clock.now() + livenessMs, pollMs });

    const fromRead = async (a: Attempt, c: string): Promise<ChildRead> => {
      const r = await inspect(l, t, a, c, launcherActivity);
      feed.context = r.context;
      if (r.evidence === "mismatch") {
        feed.mismatch = true;
        feed.evidence = "lost";
        if (await namesPlanAndRuns(l, c)) orphans.add(c);
      } else if (r.evidence === "unknown") {
        feed.evidence = "alive";
      } else {
        feed.evidence = r.evidence;
      }
      return r;
    };

    switch (t.state) {
      case "ready": {
        if (latest === undefined || child === null) break;
        const adoptable = latest.outcome === "lost" && latest.endedAt !== null && t.slot !== null;
        const r = await fromRead(latest, child);
        if (adoptable && !slotBad) {
          if (r.evidence === "finished" || r.evidence === "alive") feed.action = "adopt";
          else if (r.evidence === "unknown") {
            feed.action = "adopt";
            feed.probation = probation();
          }
        } else {
          // `ready`, other: a child that still runs is an orphan; a finished or gone one is ignored.
          if (r.evidence === "alive" || r.evidence === "unknown") {
            orphans.add(child);
            feed.action = "interrupt-orphan";
          }
          // R2: the slot is gone or foreign, so the lost attempt cannot be adopted; the runtime clears the slot.
          if (adoptable && slotBad && feed.action === "none") feed.action = "requeue-lost";
        }
        break;
      }
      case "dispatched": {
        // A dispatched attempt never has a child id (row 10): requeue at once (C12).
        feed.action = "requeue-lost";
        if (child !== null && latest !== undefined) await fromRead(latest, child);
        break;
      }
      case "running": {
        if (latest === undefined || child === null) {
          feed.action = "requeue-lost";
          break;
        }
        const r = await fromRead(latest, child);
        if (slotBad) {
          feed.action = "requeue-lost";
          if (r.evidence === "alive" || r.evidence === "unknown") orphans.add(child);
        } else if (r.evidence === "finished") feed.action = "process-result";
        else if (r.evidence === "alive") feed.action = "adopt";
        else if (r.evidence === "unknown") {
          feed.action = "adopt";
          feed.probation = probation();
        } else feed.action = "requeue-lost";
        break;
      }
      case "completed":
      case "verifying":
        feed.action = "reverify";
        break;
      case "verified":
        feed.action = "re-enqueue";
        break;
      case "integrating":
        feed.action = "resume-integration";
        break;
      default:
        break;
    }
    feed.orphans = [...orphans].sort();
    if (!REPORTED_STATES.has(t.state) && feed.orphans.length === 0) return null;
    return feed;
  }

  async function reconcile(l: Readonly<LedgerV1>, tracked: ReadonlySet<string>): Promise<ReconcileFeed[]> {
    // History-class metrics survive journal rotation. Read once, lazily, and never touch the store without the v2 dep.
    let launchers: Promise<Array<Record<string, string>> | null> | undefined;
    const launcherActivity: LauncherActivity = async (t, a, child) => {
      const dep = d.launcherLiveness;
      if (dep === undefined) return "unknown";
      launchers ??= (async () => {
        try {
          const records: Array<Record<string, string>> = [];
          for (const e of (await d.store.exportPlan(l.planId)).events) {
            if (e.type === "metric" && e.metric.name === "counter" && e.metric.key === "child-process") records.push(e.metric.labels);
          }
          return records;
        } catch (e) {
          d.log("warn", "recovery: launcher history unavailable; treating the child as unknown", {
            planId: l.planId, error: e instanceof Error ? e.message : String(e),
          });
          return null;
        }
      })();
      const records = await launchers;
      if (records === null) return "unknown";
      const matches = records.filter((r) => r.taskId === t.id && r.n === String(a.n) && r.nonce === a.nonce && r.child === child);
      if (matches.length !== 1) return "unknown";
      const r = matches[0]!;
      // Malformed or ambiguous history is not proof of death.
      if (r.hostname !== dep.self.hostname || typeof r.pid !== "string" || !/^[1-9]\d*$/.test(r.pid)
        || typeof r.token !== "string" || r.token === "") return "unknown";
      const pid = Number(r.pid);
      if (!Number.isSafeInteger(pid)) return "unknown";
      const dead = pid === dep.self.pid ? r.token !== dep.self.token : !dep.isAlive(pid);
      if (!dead) return "unknown";
      d.log("info", "recovery: child launcher is dead; treating the child as inactive", { taskId: t.id, n: a.n, pid });
      return "inactive";
    };
    const out: ReconcileFeed[] = [];
    for (const id of Object.keys(l.tasks).sort()) {
      const t = l.tasks[id];
      if (t === undefined) continue;
      const f = await reconcileTask(l, t, tracked, launcherActivity);
      if (f !== null) out.push(f);
    }
    return out;
  }

  async function recover(): Promise<Array<{ planId: PlanId; actions: ReconcileAction[] }>> {
    if (recovered) return [];
    recovered = true;
    const out: Array<{ planId: PlanId; actions: ReconcileAction[] }> = [];
    for (const e of await d.store.list()) {
      if (e.status !== "running" && e.status !== "paused") continue;
      if (!sameToplevel(e.toplevel, d.toplevel)) continue;
      try {
        const l = await d.store.read(e.planId);
        if (l.status !== "running" && l.status !== "paused") continue;
        if (!sameToplevel(l.repo.toplevel, d.toplevel)) continue;
        out.push({ planId: e.planId, actions: await reconcile(l, new Set<string>()) });
      } catch (err) {
        d.log("warn", "recovery: plan skipped", {
          planId: e.planId, error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return out;
  }

  async function adopt(planId: PlanId, sessionID: string): Promise<void> {
    const l = await d.store.read(planId);
    if (!sameToplevel(l.repo.toplevel, d.toplevel)) {
      throw new ExecutorError("E_PLAN_STATE", "plan belongs to another repository", { planId, toplevel: l.repo.toplevel });
    }
    if (TERMINAL.has(l.status)) {
      throw new ExecutorError("E_PLAN_STATE", `plan is ${l.status}`, { planId, status: l.status });
    }
    const holder = d.holder(sessionID);
    let writer;
    try {
      writer = await d.store.open(planId, holder);
    } catch (e) {
      if (!isLockHeld(e)) throw e;
      writer = await d.store.takeover(planId, holder, ADOPT_TAKEOVER_REASON);
    }
    try {
      await writer.append([{ type: "orchestrator-bound", sessionID, reason: "adopt" }]);
    } finally {
      await writer.close();
    }
  }

  return { recover, adopt, reconcile };
}
