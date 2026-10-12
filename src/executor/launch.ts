/**
 * Launcher A (3.1.5): starts plan children through the child runner with the context retained from the bound
 * orchestrator's latest router tool call. Memo 3.1.1 §4-§5, ADR 0007 D14.
 */

import {
  ABSOLUTE_PATH_PATTERN,
  CHILD_END_GRACE_MS,
  ExecutorError,
  LAUNCH_CONFIRM_TIMEOUT_MS,
  LAUNCH_HEADER_PATTERN,
  executionFailureOutcome,
  isContextSupersededError,
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

export type PlanBindInput = Parameters<RoleBindings["bind"]>[0] & { planId: PlanId; taskId: TaskId; attempt: number };

/** Binding of a plan child; the production adapter maps `bind` to `bindPlanChild` and `evict` to binding.ts `evict`. */
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
  /** `onCreated` was entered before the confirmation deadline. */
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

  const launchKey = (taskId: TaskId, attempt: number): string => `${taskId}#${attempt}`;

  const offCapture = d.runner.onContextCaptured((c) => {
    lastEpoch.set(c.sessionID, Math.max(lastEpoch.get(c.sessionID) ?? 0, c.epoch));
  });
  const offEvents = d.hosts.onEvent((e) => {
    if (isTerminal(e)) onTerminal(e);
  });

  const markStale = (sessionID: string, epoch: number): void => {
    staleEpoch.set(sessionID, Math.max(staleEpoch.get(sessionID) ?? 0, epoch));
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
    lastEpoch.set(orchestratorSessionID, Math.max(lastEpoch.get(orchestratorSessionID) ?? 0, cap.epoch));
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

  const release = (l: Launch): void => {
    if (l.inFlightRegistered) {
      l.inFlightRegistered = false;
      try { d.bookkeeping.unregisterInFlight(l.req.taskId, l.req.attempt); } catch { /* bookkeeping never fails a launch */ }
    }
    if (l.bound && l.childId !== null) {
      l.bound = false;
      try { d.bindings.evict(l.childId); } catch { /* the binding is dropped with the session anyway */ }
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
    release(l);
    l.resolveCompletion(end);
    forget(l);
  };

  const settleConfirmation = (l: Launch, c: LaunchConfirmation, result: ContextAgeResult): void => {
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
    l.resolveConfirmation(c);
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
        markStale(l.req.orchestratorSessionID, l.req.context.epoch);
        unconfirm(l, "threw", "the runner returned without creating a confirmed child");
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
    l.runnerDone = true;
    if (l.completionSettled) {
      // Already settled (a confirmation timeout or an event): only the leftovers of a late-adopted child remain.
      release(l);
      forget(l);
      return;
    }
    const at = d.clock.iso();
    if (!l.confirmed) {
      if (l.cancelReason !== null && l.childId === null) {
        unconfirm(l, "threw", error);
        settleCompletion(l, { kind: "interrupted", childSessionID: null, reason: l.cancelReason, endedAt: at });
      } else if (isContextSupersededError(error)) {
        unconfirm(l, "superseded", error);
        settleCompletion(l, { kind: "lost", childSessionID: null, reason: "context-superseded", endedAt: at });
      } else if (l.confirmSettled) {
        // task-error / hook-failed / timeout: the child was never prompted.
        settleCompletion(l, { kind: "lost", childSessionID: l.childId, reason: "unconfirmed", endedAt: at });
      } else {
        markStale(l.req.orchestratorSessionID, l.req.context.epoch);
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
      planId: req.planId, taskId: req.taskId, attempt: req.attempt,
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
    const header = LAUNCH_HEADER_PATTERN.exec(req.prompt);
    const bad = (message: string): never => {
      throw new ExecutorError("E_LAUNCH_TASK", message, { taskId: req.taskId, attempt: req.attempt });
    };
    if (!req.prompt.startsWith("PLAN CONTEXT\n")) bad("the prompt does not start with PLAN CONTEXT");
    if (header === null || header[1] !== req.planId || header[2] !== req.taskId || header[3] !== String(req.attempt)
      || header[4] !== req.nonce) bad("the prompt header does not match the launch request");
    if (!d.knownAgent(req.route.agent)) bad(`unknown agent ${req.route.agent}`);
    if (!ABSOLUTE_PATH_PATTERN.test(req.workRoot)) bad("the work root is not an absolute path");
    const key = launchKey(req.taskId, req.attempt);
    for (const other of launches.values()) {
      if (other.key === key || (other.req.taskId === req.taskId && !other.completionSettled)) {
        bad("the task already has a launch in flight");
      }
    }

    let resolveConfirmation: (c: LaunchConfirmation) => void = () => undefined;
    let resolveCompletion: (e: ChildEnd) => void = () => undefined;
    const confirmation = new Promise<LaunchConfirmation>((resolve) => { resolveConfirmation = resolve; });
    const completion = new Promise<ChildEnd>((resolve) => { resolveCompletion = resolve; });
    const startedAt = d.clock.iso();
    const l: Launch = {
      req, key, hooks, controller: new AbortController(), contextInfo: current, ageMs: g.ageMs, startedAt,
      childId: null, cancelReason: null, hookEntered: false, timedOut: false, confirmSettled: false, confirmed: false,
      unconfirmed: null, completionSettled: false, runnerDone: false, runnerFailed: false, terminal: null,
      inFlightRegistered: false, bound: false, confirmTimer: null, graceTimer: null,
      resolveConfirmation, resolveCompletion,
    };

    // A retained launch fires no `subagent` hook, so the executor writes the dispatch-time rows itself.
    d.bookkeeping.decisionRow(req);
    d.bookkeeping.recordDispatchStart(req, startedAt);
    d.bookkeeping.registerInFlight(req.taskId, req.attempt, null);
    l.inFlightRegistered = true;
    launches.set(key, l);

    l.confirmTimer = d.clock.setTimer(confirmTimeoutMs, () => {
      l.confirmTimer = null;
      if (l.hookEntered || l.confirmSettled) return; // 30 s bounds the host's creation of the child, not our own hook
      l.timedOut = true;
      markStale(req.orchestratorSessionID, req.context.epoch);
      unconfirm(l, "timeout", null);
      settleCompletion(l, { kind: "lost", childSessionID: null, reason: "unconfirmed", endedAt: d.clock.iso() });
    });

    const signal = AbortSignal.any([l.controller.signal, d.lifetime]);
    let running: Promise<{ sessionID: string; text: string }>;
    try {
      running = d.runner.run({
        parentSessionID: req.orchestratorSessionID,
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
    async dispose() {
      if (disposed) return;
      disposed = true;
      offCapture();
      offEvents();
      for (const l of launches.values()) {
        if (l.cancelReason === null) l.cancelReason = "dispose";
        l.controller.abort();
      }
    },
  };
}
