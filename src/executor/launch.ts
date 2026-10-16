/**
 * Launcher A (3.1.5): starts plan children through the child runner with the context retained from the bound
 * orchestrator's latest router tool call. Memo 3.1.1 §4-§5, ADR 0007 D14.
 */

import { ResumeRejectedError } from "../compat/child-session";
import {
  ABSOLUTE_PATH_PATTERN,
  CHILD_END_GRACE_MS,
  ExecutorError,
  LAUNCH_CONFIRM_TIMEOUT_MS,
  LAUNCH_HEADER_PATTERN,
  executionFailureOutcome,
  formatLaunchHeader,
  isContextSupersededError,
  isTaskId,
  type CancelReason,
  type ChildEnd,
  type ChildRunner,
  type Clock,
  type DispatchBookkeeping,
  type HostError,
  type HostSessionEvent,
  type HostSessions,
  type IsoTime,
  type LaunchConfirmation,
  type LaunchGate,
  type LaunchHandle,
  type LaunchHooks,
  type LaunchRequest,
  type MetricPayload,
  type PlanId,
  type RetainedContextInfo,
  type RoleBindings,
  type TaskId,
  type TaskLauncher,
} from "./types";

/**
 * QA-PDF21-2-20: `budget` is the route's `budget=` (the guard's per-dispatch budget of the child, as a routed dispatch's;
 * absent: none named); `prompt` is the launch prompt, whose cap line sets the child's read cap (a resume's names none).
 */
export type PlanBindInput = Parameters<RoleBindings["bind"]>[0] & {
  planId: PlanId; taskId: TaskId; attempt: number; budget?: number | null; prompt?: string; tier?: string;
};

/**
 * Binding of a plan child; the production adapter maps `bind` to `bindPlanChild` and `evict` to binding.ts `evict`
 * (which tombstones the id: nothing binds it again). pdf2-1 (a): a completed child whose launch holds its binding
 * (`LaunchHooks.holdCompletedBinding`) is evicted only once the runtime decided not to resume it; a budget resume of the
 * same child under the same plan, task and attempt takes the live binding over instead of binding it again.
 * QA-PDF21-2-20: `bind` also carries the launch prompt (the adapter registers the child's read cap from the executor's cap
 * line) and the route `budget=` (the binding's call budget); QA-PDF21-2-11: a resume's new guard round is the bookkeeping's.
 */
export interface PlanRoleBindings {
  bind(i: PlanBindInput): void;
  evict(childSessionID: string): void;
}

export interface TaskLauncherDeps {
  runner: ChildRunner;
  hosts: HostSessions;
  bindings: PlanRoleBindings;
  bookkeeping: DispatchBookkeeping;
  clock: Clock;
  /** Plugin lifetime; combined with the per-launch controller. */
  lifetime: AbortSignal;
  knownAgent(agent: string): boolean;
  onMetric(planId: PlanId, m: Extract<MetricPayload, { name: "context-age" }>): void;
  /** Default {@link LAUNCH_CONFIRM_TIMEOUT_MS}. */
  confirmTimeoutMs?: number;
  /** Default {@link CHILD_END_GRACE_MS}. */
  endGraceMs?: number;
}

/** Wake key of a gate that is `context-stale` (A1-6): one per capture epoch. */
export function staleContextKey(bootID: string, epoch: number): string {
  return `stale-context:${bootID}:${epoch}`;
}

/** Wake key of a gate with `no-context`: a capture of the session existed in this process and is gone. */
export function noContextKey(bootID: string, sessionID: string, lastEpoch: number): string {
  return `no-context:${bootID}:${sessionID}:${lastEpoch}`;
}

/** Wake key of guard 6: nothing captured yet in this process (a restart yields a new bootID). */
export function awaitRouterCallKey(bootID: string, sessionID: string): string {
  return `await-router-call:${bootID}:${sessionID}`;
}

type TerminalEvent =
  | { type: "execution.failed"; sessionID: string; error: HostError; at: IsoTime }
  | { type: "execution.interrupted" | "execution.completed"; sessionID: string; at: IsoTime };
type ContextAgeResult = Extract<MetricPayload, { name: "context-age" }>["result"];

function isTerminal(e: HostSessionEvent): e is HostSessionEvent & TerminalEvent {
  return e.type === "execution.failed" || e.type === "execution.interrupted" || e.type === "execution.completed";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** QA-3.1-15: per-session maps (`lastEpoch`, `staleEpoch`) keep at most this many sessions; the least recently touched go first. */
export const MAX_TRACKED_SESSIONS = 256;

const CONTEXT_ERROR_TEXT =
  /session[ _-]?not[ _-]?found|(?:context|capture)[ _-]?(?:superseded|expired|aborted|stale|invalid|gone|missing|not[ _-]?found)|(?:expired|aborted|stale|superseded)[ _-]?(?:context|capture)/i;

/** Must match runtime.ts RESUME_PROMPT; resumes continue the existing child without a fresh plan header. */
const RESUME_PROMPT = "continue and finish";

/**
 * QA-3.1-4: whether a runner error before confirmation says the retained context itself is unusable (so the capture is
 * marked stale), as opposed to a deterministic runner failure that a fresh capture would not change (native subagent tool
 * unavailable, unknown agent, validation errors, ...). Context-related: `ContextSupersededError`, a host error whose
 * `type`/`code` is `context` or whose name/type/code/message names a superseded, expired, aborted, stale or missing
 * context/capture, or a "session not found" host error.
 */
export function isContextRelatedRunnerError(error: unknown): boolean {
  if (isContextSupersededError(error)) return true;
  if (typeof error !== "object" || error === null) return false;
  const e = error as { name?: unknown; type?: unknown; code?: unknown; message?: unknown };
  const tag = (v: unknown): string => (typeof v === "string" ? v : "");
  if (tag(e.type).toLowerCase() === "context" || tag(e.code).toLowerCase() === "context") return true;
  return CONTEXT_ERROR_TEXT.test(`${tag(e.name)} ${tag(e.type)} ${tag(e.code)} ${tag(e.message)}`);
}

/** One launch: the executor's view of a child from `launch()` until both its completion and its runner have settled. */
interface Launch {
  readonly req: LaunchRequest;
  readonly hooks: LaunchHooks;
  readonly key: string;
  readonly controller: AbortController;
  readonly contextInfo: RetainedContextInfo;
  readonly ageMs: number;
  readonly startedAt: IsoTime;
  childId: string | null;
  cancelReason: CancelReason | null;
  /** `onCreated` (fresh child) or the first step (resume) entered before the confirmation deadline. */
  hookEntered: boolean;
  timedOut: boolean;
  confirmSettled: boolean;
  confirmed: boolean;
  /** Why the confirmation was not given (when it was not). */
  unconfirmed: Extract<LaunchConfirmation, { kind: "unconfirmed" }>["reason"] | null;
  completionSettled: boolean;
  runnerDone: boolean;
  /** The runner rejected after the confirmation; the child's terminal event decides. */
  runnerFailed: boolean;
  terminal: TerminalEvent | null;
  inFlightRegistered: boolean;
  bound: boolean;
  confirmTimer: { readonly id: number } | null;
  graceTimer: { readonly id: number } | null;
  resolveConfirmation(c: LaunchConfirmation): void;
  rejectConfirmation(error: unknown): void;
  resolveCompletion(e: ChildEnd): void;
}

/** Launcher A (3.1.5): see {@link TaskLauncher}. */
export function createTaskLauncher(d: TaskLauncherDeps): TaskLauncher {
  const confirmTimeoutMs = d.confirmTimeoutMs ?? LAUNCH_CONFIRM_TIMEOUT_MS;
  const endGraceMs = d.endGraceMs ?? CHILD_END_GRACE_MS;
  let disposed = false;
  const launches = new Map<string, Launch>();
  const byChild = new Map<string, Launch>();
  /** Newest capture epoch seen per session (for the `no-context` key). */
  const lastEpoch = new Map<string, number>();
  /** Captures of a session up to this epoch no longer launch anything (D14 guard 2). */
  const staleEpoch = new Map<string, number>();
  /**
   * pdf2-1 (a): live bindings of completed children kept for a budget resume (`LaunchHooks.holdCompletedBinding`), by
   * child session, with the plan, task and attempt they were bound for. Dropped by `releaseBinding`, taken over by a
   * resume of the same child under the same plan, task and attempt, evicted on dispose.
   */
  const held = new Map<string, { planId: PlanId; taskId: TaskId; attempt: number }>();

  const launchKey = (taskId: TaskId, attempt: number): string => `${taskId}#${attempt}`;

  const offCapture = d.runner.onContextCaptured((c) => {
    setBounded(lastEpoch, c.sessionID, Math.max(lastEpoch.get(c.sessionID) ?? 0, c.epoch));
  });
  const offEvents = d.hosts.onEvent((e) => {
    if (e.type === "step.started") {
      const l = byChild.get(e.sessionID);
      if (l !== undefined && l.req.resume !== undefined && !l.confirmSettled && l.cancelReason === null && !disposed) {
        l.hookEntered = true;
        if (l.confirmTimer !== null) d.clock.clearTimer(l.confirmTimer);
        l.confirmTimer = null;
        settleConfirmation(l, {
          kind: "confirmed", childSessionID: e.sessionID, latencyMs: Math.max(0, d.clock.now() - Date.parse(l.startedAt)),
        }, "confirmed");
      }
    }
    if (isTerminal(e)) onTerminal(e);
  });

  /** Sets `key` as the most recent entry and drops the oldest ones beyond {@link MAX_TRACKED_SESSIONS} (never a session with a live launch). */
  const setBounded = (map: Map<string, number>, key: string, value: number): void => {
    map.delete(key);
    map.set(key, value);
    if (map.size <= MAX_TRACKED_SESSIONS) return;
    const live = new Set<string>();
    for (const l of launches.values()) live.add(l.req.orchestratorSessionID);
    for (const k of map.keys()) {
      if (map.size <= MAX_TRACKED_SESSIONS) break;
      if (k !== key && !live.has(k)) map.delete(k);
    }
  };

  const markStale = (sessionID: string, epoch: number): void => {
    setBounded(staleEpoch, sessionID, Math.max(staleEpoch.get(sessionID) ?? 0, epoch));
  };

  const gate = (orchestratorSessionID: string): LaunchGate => {
    if (disposed) return { ok: false, reason: "disposed", wake: null };
    const cap = d.runner.retainedContext(orchestratorSessionID);
    if (cap === null) {
      const seen = lastEpoch.get(orchestratorSessionID);
      if (seen !== undefined) {
        return {
          ok: false, reason: "no-context",
          wake: { reason: "stale-context", stateKey: noContextKey(d.runner.bootID, orchestratorSessionID, seen) },
        };
      }
      return {
        ok: false, reason: "awaiting-first-router-call",
        wake: { reason: "stale-context", stateKey: awaitRouterCallKey(d.runner.bootID, orchestratorSessionID) },
      };
    }
    setBounded(lastEpoch, orchestratorSessionID, Math.max(lastEpoch.get(orchestratorSessionID) ?? 0, cap.epoch));
    if (cap.epoch <= (staleEpoch.get(orchestratorSessionID) ?? 0)) {
      return {
        ok: false, reason: "context-stale",
        wake: { reason: "stale-context", stateKey: staleContextKey(cap.bootID, cap.epoch) },
      };
    }
    return { ok: true, context: cap, ageMs: Math.max(0, d.clock.now() - Date.parse(cap.capturedAt)) };
  };

  const clearTimers = (l: Launch): void => {
    if (l.confirmTimer !== null) d.clock.clearTimer(l.confirmTimer);
    if (l.graceTimer !== null) d.clock.clearTimer(l.graceTimer);
    l.confirmTimer = null;
    l.graceTimer = null;
  };

  const evictBinding = (childId: string): void => {
    try { d.bindings.evict(childId); } catch { /* the binding is dropped with the session anyway */ }
  };

  const release = (l: Launch, status?: ChildEnd["kind"]): void => {
    if (l.inFlightRegistered) {
      l.inFlightRegistered = false;
      // QA-3.1-24: the settled end kind, when known, so the bookkeeping does not guess it
      try { d.bookkeeping.unregisterInFlight(l.req.taskId, l.req.attempt, status); } catch { /* bookkeeping never fails a launch */ }
    }
    if (l.bound && l.childId !== null) {
      l.bound = false;
      // pdf2-1 (a): a completed child may be resumed for its budget; its binding waits for the caller's decision
      // (`releaseBinding`, or a resume of the same child under the same task and attempt). Every other end evicts here.
      if (status === "completed" && l.hooks.holdCompletedBinding === true && !disposed) {
        held.set(l.childId, { planId: l.req.planId, taskId: l.req.taskId, attempt: l.req.attempt });
        return;
      }
      evictBinding(l.childId);
    }
  };

  const forget = (l: Launch): void => {
    if (!l.completionSettled || !l.runnerDone) return;
    if (launches.get(l.key) === l) launches.delete(l.key);
    if (l.childId !== null && byChild.get(l.childId) === l) byChild.delete(l.childId);
  };

  const settleCompletion = (l: Launch, end: ChildEnd): void => {
    if (l.completionSettled) return;
    l.completionSettled = true;
    clearTimers(l);
    release(l, end.kind);
    l.resolveCompletion(end);
    forget(l);
  };

  const settleConfirmation = (l: Launch, c: LaunchConfirmation, result: ContextAgeResult, rejection?: unknown): void => {
    if (l.confirmSettled) return;
    l.confirmSettled = true;
    if (c.kind === "confirmed") l.confirmed = true;
    else l.unconfirmed = c.reason;
    // Guard 4: the age of the context is recorded with every result, never gated.
    try {
      d.onMetric(l.req.planId, {
        name: "context-age", taskId: l.req.taskId, attempt: l.req.attempt,
        bootID: l.contextInfo.bootID, epoch: l.contextInfo.epoch, callID: l.contextInfo.callID,
        capturedAt: l.contextInfo.capturedAt, ageMs: l.ageMs, result,
      });
    } catch { /* a metric sink never fails a launch */ }
    if (rejection !== undefined) l.rejectConfirmation(rejection);
    else l.resolveConfirmation(c);
  };

  const unconfirm = (
    l: Launch, reason: Extract<LaunchConfirmation, { kind: "unconfirmed" }>["reason"], error: unknown,
  ): void => {
    settleConfirmation(l, { kind: "unconfirmed", reason, error: error === null ? null : messageOf(error) }, reason);
  };

  const lastAssistantText = async (child: string): Promise<string> => {
    try {
      const { messages } = await d.hosts.context(child);
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m !== undefined && m.role === "assistant" && m.text !== null) return m.text;
      }
    } catch { /* an unreadable history gives an empty result text */ }
    return "";
  };

  /** Classifies a launch from the terminal `session.execution.*` event of its child (D2 fallback, guard 5). */
  const classifyTerminal = async (l: Launch, e: TerminalEvent): Promise<void> => {
    const child = l.childId;
    if (child === null || l.completionSettled) return;
    const endedAt = d.clock.iso();
    if (e.type === "execution.failed") {
      settleCompletion(l, { kind: executionFailureOutcome(e.error), childSessionID: child, error: e.error, endedAt });
      l.controller.abort();
    } else if (e.type === "execution.interrupted") {
      settleCompletion(l, l.cancelReason !== null
        ? { kind: "interrupted", childSessionID: child, reason: l.cancelReason, endedAt }
        : { kind: "lost", childSessionID: child, reason: "unrequested-interrupt", endedAt });
      l.controller.abort();
    } else {
      const text = await lastAssistantText(child);
      settleCompletion(l, { kind: "completed", childSessionID: child, text, endedAt: d.clock.iso() });
    }
  };

  function onTerminal(e: TerminalEvent): void {
    const l = byChild.get(e.sessionID);
    if (l === undefined || l.terminal !== null) return;
    l.terminal = e;
    if (l.completionSettled || !l.confirmed) return;
    if (l.runnerFailed || e.type !== "execution.completed") {
      void classifyTerminal(l, e);
      return;
    }
    // `execution.completed` before the runner returned: wait up to the grace for the runner's text, then read the history.
    if (l.graceTimer === null) {
      l.graceTimer = d.clock.setTimer(endGraceMs, () => {
        l.graceTimer = null;
        void classifyTerminal(l, e);
      });
    }
  }

  const onRunnerResult = (l: Launch, result: { sessionID: string; text: string }): void => {
    l.runnerDone = true;
    if (!l.confirmed) {
      if (!l.confirmSettled) {
        // No error to classify: a runner that returns without ever creating the child leaves the context in doubt.
        markStale(l.req.orchestratorSessionID, l.req.context.epoch);
        unconfirm(l, "threw", l.req.resume !== undefined
          ? "the runner returned without a first step from the resumed child"
          : "the runner returned without creating a confirmed child");
      }
      settleCompletion(l, { kind: "lost", childSessionID: l.childId, reason: "runner-error", endedAt: d.clock.iso() });
      release(l);
      forget(l);
      return;
    }
    settleCompletion(l, { kind: "completed", childSessionID: l.childId ?? result.sessionID, text: result.text, endedAt: d.clock.iso() });
    forget(l);
  };

  const onRunnerError = (l: Launch, error: unknown): void => {
    if (l.req.resume !== undefined && error instanceof ResumeRejectedError) {
      error = new ExecutorError("E_NO_CONTEXT", error.message, { childSessionID: error.sessionID });
    }
    l.runnerDone = true;
    if (l.completionSettled) {
      // Already settled (a confirmation timeout or an event): only the leftovers of a late-adopted child remain.
      release(l);
      forget(l);
      return;
    }
    const at = d.clock.iso();
    if (!l.confirmed) {
      if (l.req.resume !== undefined && !l.confirmSettled && l.cancelReason === null
        && typeof error === "object" && error !== null && "code" in error && error.code === "E_NO_CONTEXT") {
        // A missing resume session is not a stale orchestrator capture. Keep the typed error for Rt to park this attempt.
        settleConfirmation(l, { kind: "unconfirmed", reason: "threw", error: messageOf(error) }, "threw", error);
        settleCompletion(l, { kind: "lost", childSessionID: l.childId, reason: "runner-error", endedAt: at });
        forget(l);
        return;
      }
      if (l.cancelReason !== null && (l.childId === null || l.req.resume !== undefined)) {
        unconfirm(l, "threw", error);
        settleCompletion(l, { kind: "interrupted", childSessionID: l.childId, reason: l.cancelReason, endedAt: at });
      } else if (isContextSupersededError(error)) {
        unconfirm(l, "superseded", error);
        settleCompletion(l, { kind: "lost", childSessionID: null, reason: "context-superseded", endedAt: at });
      } else if (l.confirmSettled) {
        // task-error / hook-failed / timeout: the child was never prompted.
        settleCompletion(l, { kind: "lost", childSessionID: l.childId, reason: "unconfirmed", endedAt: at });
      } else {
        // QA-3.1-4: a deterministic runner error leaves the retained context usable.
        if (isContextRelatedRunnerError(error)) markStale(l.req.orchestratorSessionID, l.req.context.epoch);
        unconfirm(l, "threw", error);
        settleCompletion(l, { kind: "lost", childSessionID: l.childId, reason: "runner-error", endedAt: at });
      }
      forget(l);
      return;
    }
    l.runnerFailed = true;
    if (l.terminal !== null) {
      void classifyTerminal(l, l.terminal);
      return;
    }
    if (l.graceTimer !== null) return; // an `execution.completed` fallback is already pending
    l.graceTimer = d.clock.setTimer(endGraceMs, () => {
      l.graceTimer = null;
      const end: ChildEnd = l.cancelReason !== null
        ? { kind: "interrupted", childSessionID: l.childId, reason: l.cancelReason, endedAt: d.clock.iso() }
        : { kind: "lost", childSessionID: l.childId, reason: "runner-error", endedAt: d.clock.iso() };
      settleCompletion(l, end);
    });
  };

  const bindChild = (l: Launch, child: string): void => {
    const { req } = l;
    d.bindings.bind({
      childSessionID: child, role: req.role, agent: req.route.agent, workRoot: req.workRoot, grant: [...req.grant],
      planId: req.planId, taskId: req.taskId, attempt: req.attempt, prompt: req.prompt,
      ...(req.route.tier === undefined ? {} : { tier: req.route.tier }),
      // QA-PDF21-2-20: the route `budget=` guards the plan child as it guards a routed role child (absent: kept on a re-bind).
      ...(req.routeBudget !== undefined ? { budget: req.routeBudget } : {}),
    });
    l.bound = true;
  };

  const adopt = (l: Launch, child: string): void => {
    l.childId = child;
    byChild.set(child, l);
  };

  /** The runner's hook: awaited before the child is moved and prompted. */
  const onCreated = async (l: Launch, child: string): Promise<void> => {
    if (disposed || l.cancelReason !== null) throw new Error("[model-router] launch cancelled before the child was prompted");
    if (l.req.resume !== undefined) {
      // The runner registers a resumed session through this hook too, but it creates no child and journals no AC/AA.
      if (child !== l.req.resume.childSessionID) throw new ExecutorError("E_NO_CONTEXT", "the runner did not resume the requested child");
      if (l.confirmSettled && !l.confirmed) throw new Error("[model-router] resume was not confirmed in time");
      return;
    }
    if (!l.timedOut) {
      // In time (guard 1): from here the confirmation waits for this hook, however long it takes.
      l.hookEntered = true;
      if (l.confirmTimer !== null) d.clock.clearTimer(l.confirmTimer);
      l.confirmTimer = null;
      adopt(l, child);
      try {
        bindChild(l, child);
      } catch (error) {
        unconfirm(l, "task-error", error);
        throw error;
      }
      d.bookkeeping.registerInFlight(l.req.taskId, l.req.attempt, child);
      l.inFlightRegistered = true;
      try {
        await l.hooks.onChildCreated(child);
      } catch (error) {
        unconfirm(l, "hook-failed", error);
        throw error;
      }
      settleConfirmation(l, { kind: "confirmed", childSessionID: child, latencyMs: Math.max(0, d.clock.now() - Date.parse(l.startedAt)) }, "confirmed");
      return;
    }
    // Late: the confirmation already failed; Rt decides whether the child still belongs to the task.
    let decision: "adopt" | "refuse";
    try {
      decision = await l.hooks.onLateChild(child);
    } catch {
      decision = "refuse";
    }
    if (decision === "refuse") throw new Error("[model-router] late child refused");
    adopt(l, child);
    bindChild(l, child);
    d.bookkeeping.registerInFlight(l.req.taskId, l.req.attempt, child);
    l.inFlightRegistered = true;
    await l.hooks.onChildCreated(child);
  };

  const launch = (req: LaunchRequest, hooks: LaunchHooks): LaunchHandle => {
    if (disposed) throw new ExecutorError("E_DISPOSED", "the launcher is disposed");
    const g = gate(req.orchestratorSessionID);
    const current = d.runner.retainedContext(req.orchestratorSessionID);
    if (!g.ok || current === null || current.bootID !== req.context.bootID || current.epoch !== req.context.epoch
      || current.callID !== req.context.callID) {
      throw new ExecutorError("E_NO_CONTEXT", "the launch context is not the current capture of the orchestrator", {
        reason: g.ok ? "superseded" : g.reason,
      });
    }
    const bad = (message: string): never => {
      throw new ExecutorError("E_LAUNCH_TASK", message, { taskId: req.taskId, attempt: req.attempt });
    };
    if (req.resume !== undefined) {
      if (req.prompt !== RESUME_PROMPT) bad("the resume prompt does not match the runtime resume prompt");
      if (typeof req.planId !== "string" || typeof req.nonce !== "string" || !isTaskId(req.taskId)) {
        bad("the resume plan, task or nonce is invalid");
      }
      formatLaunchHeader(req); // Validate the plan, task, attempt and nonce even though no header is sent.
      if (typeof req.resume.childSessionID !== "string" || req.resume.childSessionID.trim() === "") {
        bad("the resume child session id is empty");
      }
      // pdf2-1 (a): a held binding is taken over only by the identical plan child; never re-bound to another identity.
      const kept = held.get(req.resume.childSessionID);
      if (kept !== undefined && (kept.planId !== req.planId || kept.taskId !== req.taskId || kept.attempt !== req.attempt)) {
        bad("the resume child is bound to another plan, task or attempt");
      }
    } else {
      const header = LAUNCH_HEADER_PATTERN.exec(req.prompt);
      // An editing task's read-cap line follows this opening line (DF-2-9), so the opening check holds for every prompt.
      if (!req.prompt.startsWith("PLAN CONTEXT\n")) bad("the prompt does not start with PLAN CONTEXT");
      if (header === null || header[1] !== req.planId || header[2] !== req.taskId || header[3] !== String(req.attempt)
        || header[4] !== req.nonce) bad("the prompt header does not match the launch request");
    }
    if (!d.knownAgent(req.route.agent)) bad(`unknown agent ${req.route.agent}`);
    if (!ABSOLUTE_PATH_PATTERN.test(req.workRoot)) bad("the work root is not an absolute path");
    const key = launchKey(req.taskId, req.attempt);
    for (const other of launches.values()) {
      // QA-PDF21-2-17: a resume may follow its own attempt's run whose completion already settled (the child's terminal event
      // after the grace) while that run's runner has not returned yet: the same plan, task, attempt and child. That record is
      // no launch in flight; the identity checks of `forget` keep its late runner result from touching the resume's records.
      if (req.resume !== undefined && other.key === key && other.completionSettled && other.req.planId === req.planId
        && other.childId === req.resume.childSessionID) continue;
      if (other.key === key || (other.req.taskId === req.taskId && !other.completionSettled)) {
        bad("the task already has a launch in flight");
      }
    }

    let resolveConfirmation: (c: LaunchConfirmation) => void = () => undefined;
    let rejectConfirmation: (error: unknown) => void = () => undefined;
    let resolveCompletion: (e: ChildEnd) => void = () => undefined;
    const confirmation = new Promise<LaunchConfirmation>((resolve, reject) => { resolveConfirmation = resolve; rejectConfirmation = reject; });
    const completion = new Promise<ChildEnd>((resolve) => { resolveCompletion = resolve; });
    const startedAt = d.clock.iso();
    const l: Launch = {
      req, key, hooks, controller: new AbortController(), contextInfo: current, ageMs: g.ageMs, startedAt,
      childId: null, cancelReason: null, hookEntered: false, timedOut: false, confirmSettled: false, confirmed: false,
      unconfirmed: null, completionSettled: false, runnerDone: false, runnerFailed: false, terminal: null,
      inFlightRegistered: false, bound: false, confirmTimer: null, graceTimer: null,
      resolveConfirmation, rejectConfirmation, resolveCompletion,
    };

    // A retained launch fires no `subagent` hook, so the executor writes the dispatch-time rows itself.
    d.bookkeeping.decisionRow(req);
    d.bookkeeping.recordDispatchStart(req, startedAt);
    d.bookkeeping.registerInFlight(req.taskId, req.attempt, req.resume?.childSessionID ?? null);
    l.inFlightRegistered = true;
    launches.set(key, l);

    l.confirmTimer = d.clock.setTimer(confirmTimeoutMs, () => {
      l.confirmTimer = null;
      if (l.hookEntered || l.confirmSettled) return; // 30 s bounds child creation / the resumed child's first step, not our own hook
      l.timedOut = true;
      markStale(req.orchestratorSessionID, req.context.epoch);
      unconfirm(l, "timeout", null);
      settleCompletion(l, { kind: "lost", childSessionID: req.resume?.childSessionID ?? null, reason: "unconfirmed", endedAt: d.clock.iso() });
      if (req.resume !== undefined) l.controller.abort(); // There is no late child to adopt on a resume.
    });

    const signal = AbortSignal.any([l.controller.signal, d.lifetime]);
    let running: Promise<{ sessionID: string; text: string }>;
    try {
      if (req.resume !== undefined) {
        const child = req.resume.childSessionID;
        adopt(l, child);
        const kept = held.get(child);
        if (kept !== undefined && kept.planId === req.planId && kept.taskId === req.taskId && kept.attempt === req.attempt) {
          // pdf2-1 (a): the binding of the budget end is still live for this very attempt: the resume takes it over.
          held.delete(child);
          l.bound = true;
        } else {
          bindChild(l, child);
        }
        // QA-PDF21-2-11: the resume is a NEW guard round and read-cap round for its child, as a routed resume is; without it the
        // child keeps the exhausted per-dispatch budget of the round that ended NEED MORE: budget (the cumulative ceiling stays).
        try { d.bookkeeping.beginResumeRound?.(child, req.route.agent, req.prompt); } catch { /* bookkeeping never fails a launch */ }
      }
      running = d.runner.run({
        parentSessionID: req.orchestratorSessionID,
        ...(req.resume !== undefined ? { resumeSessionID: req.resume.childSessionID } : {}),
        prompt: req.prompt,
        agent: req.route.agent,
        model: req.route.model,
        cwd: req.workRoot,
        signal,
        detached: true,
        context: req.context,
        onCreated: (child) => onCreated(l, child),
      });
    } catch (error) {
      running = Promise.reject(error);
    }
    running.then((result) => onRunnerResult(l, result), (error: unknown) => onRunnerError(l, error));

    return {
      taskId: req.taskId, attempt: req.attempt, nonce: req.nonce, context: req.context,
      contextAgeMs: g.ageMs, startedAt, confirmation, completion,
    };
  };

  const cancel = async (taskId: TaskId, attempt: number, reason: CancelReason): Promise<void> => {
    const l = launches.get(launchKey(taskId, attempt));
    if (l === undefined || l.cancelReason !== null) return;
    l.cancelReason = reason;
    l.controller.abort();
    if (l.childId !== null) {
      try { await d.hosts.interrupt(l.childId); } catch { /* the runner interrupts on abort as well */ }
    }
  };

  return {
    gate,
    launch,
    cancel,
    inFlight() {
      return [...launches.values()].map((l) => ({
        taskId: l.req.taskId, attempt: l.req.attempt, childSessionID: l.childId, startedAt: l.startedAt,
      }));
    },
    releaseBinding(childSessionID) {
      if (!held.delete(childSessionID)) return;
      evictBinding(childSessionID);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      offCapture();
      offEvents();
      for (const child of [...held.keys()]) {
        held.delete(child);
        evictBinding(child);
      }
      for (const l of launches.values()) {
        if (l.cancelReason === null) l.cancelReason = "dispose";
        l.controller.abort();
      }
    },
  };
}
