import { describe, expect, it, vi } from "vitest";
import {
  awaitRouterCallKey,
  createTaskLauncher,
  noContextKey,
  staleContextKey,
  type PlanBindInput,
  type PlanRoleBindings,
  type TaskLauncherDeps,
} from "../../src/executor/launch";
import {
  ContextSupersededError,
  ExecutorError,
  type ChildEnd,
  type ChildRunRequest,
  type ChildRunner,
  type Clock,
  type DispatchBookkeeping,
  type HostSessionContext,
  type HostSessionEvent,
  type HostSessions,
  type LaunchConfirmation,
  type LaunchHooks,
  type LaunchRequest,
  type MetricPayload,
  type RetainedContextInfo,
  type TaskLauncher,
} from "../../src/executor/types";

const NONCE = "0123456789abcdef0123456789abcdef";
const ORCH = "orch-1";
const ROOT = process.platform === "win32" ? "C:\\work\\slot-1" : "/work/slot-1";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Lets pending promise callbacks (and chained async functions) run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function fakeClock(start = Date.parse("2026-01-01T00:00:00.000Z")) {
  let now = start;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: Clock = {
    now: () => now,
    iso: (ms) => new Date(ms ?? now).toISOString(),
    setTimer(ms, fn) { const id = nextId++; timers.set(id, { at: now + ms, fn }); return { id }; },
    clearTimer(h) { timers.delete(h.id); },
    randomHex: (bytes) => "ab".repeat(bytes),
  };
  return {
    clock,
    pending: () => timers.size,
    async advance(ms: number): Promise<void> {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}

type Script = (req: ChildRunRequest) => Promise<{ sessionID: string; text: string }>;

function fakeRunner(clockNow: () => number, bootID = "aaaaaaaaaaaaaaaa") {
  const captures = new Map<string, RetainedContextInfo>();
  const listeners = new Set<(c: RetainedContextInfo) => void>();
  let epoch = 0;
  const state = { script: undefined as Script | undefined };
  const runner: ChildRunner = {
    bootID,
    run: vi.fn((req: ChildRunRequest) => {
      if (!state.script) return Promise.reject(new Error("no script"));
      return state.script(req);
    }),
    dispose: vi.fn(async () => undefined),
    retainedContext: (sid) => captures.get(sid) ?? null,
    onContextCaptured(l) { listeners.add(l); return () => { listeners.delete(l); }; },
  };
  return {
    runner,
    state,
    capture(sessionID = ORCH, callID = `call-${epoch + 1}`): RetainedContextInfo {
      const info: RetainedContextInfo = {
        sessionID, callID, messageID: "m", agent: "orchestrator",
        capturedAt: new Date(clockNow()).toISOString(), bootID, epoch: ++epoch,
      };
      captures.set(sessionID, info);
      for (const l of listeners) l(info);
      return info;
    },
    forget(sessionID = ORCH) { captures.delete(sessionID); },
  };
}

function fakeHosts() {
  const listeners = new Set<(e: HostSessionEvent) => void>();
  const messages: HostSessionContext["messages"] = [];
  const hosts: HostSessions = {
    get: vi.fn(async () => null),
    context: vi.fn(async () => ({ messages })),
    activity: vi.fn(async () => "unknown" as const),
    interrupt: vi.fn(async () => undefined),
    synthetic: vi.fn(async () => undefined),
    move: vi.fn(async () => undefined),
    onEvent(l) { listeners.add(l); return () => { listeners.delete(l); }; },
  };
  return { hosts, messages, emit: (e: HostSessionEvent) => { for (const l of listeners) l(e); } };
}

interface Rig {
  launcher: TaskLauncher;
  clock: ReturnType<typeof fakeClock>;
  fr: ReturnType<typeof fakeRunner>;
  fh: ReturnType<typeof fakeHosts>;
  log: string[];
  binds: PlanBindInput[];
  evicted: string[];
  metrics: Array<Extract<MetricPayload, { name: "context-age" }>>;
  bindings: PlanRoleBindings;
  hooks: LaunchHooks;
  onChildCreated: ReturnType<typeof vi.fn>;
  onLateChild: ReturnType<typeof vi.fn>;
  req(over?: Partial<LaunchRequest>): LaunchRequest;
}

function rig(over: Partial<TaskLauncherDeps> = {}, opts: { capture?: boolean } = {}): Rig {
  const clock = fakeClock();
  const fr = fakeRunner(() => clock.clock.now());
  const fh = fakeHosts();
  const log: string[] = [];
  const binds: PlanBindInput[] = [];
  const evicted: string[] = [];
  const metrics: Rig["metrics"] = [];
  const bindings: PlanRoleBindings = {
    bind(i) { log.push(`bind:${i.childSessionID}`); binds.push(i); },
    evict(c) { evicted.push(c); },
  };
  const bookkeeping: DispatchBookkeeping = {
    decisionRow: () => { log.push("decisionRow"); },
    recordDispatchStart: () => { log.push("recordDispatchStart"); },
    registerInFlight: (_t, _n, child) => { log.push(`registerInFlight:${child}`); },
    unregisterInFlight: () => { log.push("unregisterInFlight"); },
  };
  const onChildCreated = vi.fn(async (child: string) => { log.push(`onChildCreated:${child}`); });
  const onLateChild = vi.fn(async (_child: string): Promise<"adopt" | "refuse"> => "refuse");
  const launcher = createTaskLauncher({
    runner: fr.runner, hosts: fh.hosts, bindings, bookkeeping, clock: clock.clock,
    lifetime: new AbortController().signal, knownAgent: (a) => a === "coder",
    onMetric: (_p, m) => { metrics.push(m); },
    ...over,
  });
  if (opts.capture !== false) fr.capture();
  return {
    launcher, clock, fr, fh, log, binds, evicted, metrics, bindings, onChildCreated, onLateChild,
    hooks: { onChildCreated, onLateChild },
    req(o = {}) {
      const ctx = fr.runner.retainedContext(ORCH);
      return {
        planId: "plan-one", taskId: "T1", attempt: 1, nonce: NONCE, orchestratorSessionID: ORCH,
        context: ctx ? { bootID: ctx.bootID, epoch: ctx.epoch, callID: ctx.callID } : { bootID: "x", epoch: 0, callID: "none" },
        route: { agent: "coder", model: { providerID: "p", modelID: "m", variant: null }, provider: "p", heavy: false },
        role: "implementer", grant: ["read", "edit"], workRoot: ROOT,
        prompt: `PLAN CONTEXT\nshared\n\n[plan plan-one:T1#1] nonce=${NONCE}\n\nTASK\ndo it`,
        ...o,
      };
    },
  };
}

/** A runner script that creates `child`, awaits `onCreated`, then waits for `done`. */
function creating(r: Rig, child: string, done: Promise<{ sessionID: string; text: string }>): Script {
  return async (req) => {
    r.log.push("run");
    await req.onCreated(child);
    r.log.push("prompted");
    return done;
  };
}

describe("launcher keys", () => {
  it("renders the A1-6 wake keys", () => {
    expect(staleContextKey("b", 3)).toBe("stale-context:b:3");
    expect(noContextKey("b", "s", 2)).toBe("no-context:b:s:2");
    expect(awaitRouterCallKey("b", "s")).toBe("await-router-call:b:s");
  });
});

describe("launch: preconditions (synchronous, before any host call)", () => {
  const rows: Array<[string, (r: Rig) => Partial<LaunchRequest>, string]> = [
    ["prompt without PLAN CONTEXT", () => ({ prompt: `[plan plan-one:T1#1] nonce=${NONCE}\n\nTASK` }), "E_LAUNCH_TASK"],
    ["header of another plan", () => ({ prompt: `PLAN CONTEXT\n\n\n[plan plan-two:T1#1] nonce=${NONCE}\n\nTASK` }), "E_LAUNCH_TASK"],
    ["header of another task", () => ({ prompt: `PLAN CONTEXT\n\n\n[plan plan-one:T2#1] nonce=${NONCE}\n\nTASK` }), "E_LAUNCH_TASK"],
    ["header of another attempt", () => ({ prompt: `PLAN CONTEXT\n\n\n[plan plan-one:T1#2] nonce=${NONCE}\n\nTASK` }), "E_LAUNCH_TASK"],
    ["header of another nonce", () => ({ prompt: `PLAN CONTEXT\n\n\n[plan plan-one:T1#1] nonce=${"f".repeat(32)}\n\nTASK` }), "E_LAUNCH_TASK"],
    ["no header", () => ({ prompt: "PLAN CONTEXT\nshared\n\nTASK" }), "E_LAUNCH_TASK"],
    ["unknown agent", (r) => ({ route: { ...r.req().route, agent: "ghost" } }), "E_LAUNCH_TASK"],
    ["relative work root", () => ({ workRoot: "slots/one" }), "E_LAUNCH_TASK"],
    ["another call's context", (r) => ({ context: { ...r.req().context, callID: "other" } }), "E_NO_CONTEXT"],
    ["an older epoch", (r) => ({ context: { ...r.req().context, epoch: r.req().context.epoch - 1 } }), "E_NO_CONTEXT"],
    ["another process", (r) => ({ context: { ...r.req().context, bootID: "bbbbbbbbbbbbbbbb" } }), "E_NO_CONTEXT"],
  ];
  it.each(rows)("%s -> throws before bookkeeping and run", (_name, patch, code) => {
    const r = rig();
    expect(() => r.launcher.launch(r.req(patch(r)), r.hooks)).toThrow(ExecutorError);
    try {
      r.launcher.launch(r.req(patch(r)), r.hooks);
    } catch (e) {
      expect((e as ExecutorError).code).toBe(code);
    }
    expect(r.log).toEqual([]);
    expect(r.fr.runner.run).not.toHaveBeenCalled();
    expect(r.launcher.inFlight()).toEqual([]);
  });

  it("E_NO_CONTEXT without any capture (guard 6) and E_DISPOSED after dispose", async () => {
    const r = rig({}, { capture: false });
    expect(() => r.launcher.launch(r.req(), r.hooks)).toThrow(expect.objectContaining({ code: "E_NO_CONTEXT" }));
    r.fr.capture();
    await r.launcher.dispose();
    expect(() => r.launcher.launch(r.req(), r.hooks)).toThrow(expect.objectContaining({ code: "E_DISPOSED" }));
    expect(r.launcher.gate(ORCH)).toEqual({ ok: false, reason: "disposed", wake: null });
  });

  it("never launches a task twice", async () => {
    const r = rig();
    const done = deferred<{ sessionID: string; text: string }>();
    r.fr.state.script = creating(r, "child-1", done.promise);
    r.launcher.launch(r.req(), r.hooks);
    await flush();
    expect(() => r.launcher.launch(r.req(), r.hooks)).toThrow(expect.objectContaining({ code: "E_LAUNCH_TASK" }));
    expect(() => r.launcher.launch(r.req({
      attempt: 2, prompt: `PLAN CONTEXT\nshared\n\n[plan plan-one:T1#2] nonce=${NONCE}\n\nTASK`,
    }), r.hooks)).toThrow(expect.objectContaining({ code: "E_LAUNCH_TASK" }));
    expect(r.fr.runner.run).toHaveBeenCalledTimes(1);
    done.resolve({ sessionID: "child-1", text: "ok" });
  });
});

describe("launch: what the runner receives", () => {
  it("passes agent, model, cwd, detached, the pinned context and an executor-owned signal", async () => {
    const r = rig();
    const done = deferred<{ sessionID: string; text: string }>();
    r.fr.state.script = creating(r, "child-1", done.promise);
    const req = r.req();
    const handle = r.launcher.launch(req, r.hooks);
    const seen = vi.mocked(r.fr.runner.run).mock.calls[0]?.[0];
    expect(seen).toMatchObject({
      parentSessionID: ORCH, agent: "coder", model: { providerID: "p", modelID: "m", variant: null },
      cwd: ROOT, detached: true, context: req.context, prompt: req.prompt,
    });
    expect(handle.context).toEqual(req.context);
    expect(seen?.signal.aborted).toBe(false);
    await r.launcher.cancel("T1", 1, "abort");
    expect(seen?.signal.aborted).toBe(true); // the launcher's own controller drives it
    done.reject(new Error("aborted"));
    await flush();
  });

  it("aborts the signal when the plugin lifetime ends", async () => {
    const life = new AbortController();
    const r = rig({ lifetime: life.signal });
    r.fr.state.script = creating(r, "child-1", new Promise(() => undefined));
    r.launcher.launch(r.req(), r.hooks);
    const seen = vi.mocked(r.fr.runner.run).mock.calls[0]?.[0];
    expect(seen?.signal.aborted).toBe(false);
    life.abort();
    expect(seen?.signal.aborted).toBe(true);
  });

  it("writes decision row, dispatch start and in-flight registration before run; binds before the child is prompted", async () => {
    const r = rig();
    const done = deferred<{ sessionID: string; text: string }>();
    r.fr.state.script = creating(r, "child-1", done.promise);
    const handle = r.launcher.launch(r.req(), r.hooks);
    const confirmation = await handle.confirmation;
    expect(confirmation).toMatchObject({ kind: "confirmed", childSessionID: "child-1" });
    await vi.waitFor(() => expect(r.log).toContain("prompted"));
    expect(r.log).toEqual([
      "decisionRow", "recordDispatchStart", "registerInFlight:null", "run",
      "bind:child-1", "registerInFlight:child-1", "onChildCreated:child-1", "prompted",
    ]);
    expect(r.binds[0]).toEqual({
      childSessionID: "child-1", role: "implementer", agent: "coder", workRoot: ROOT, grant: ["read", "edit"],
      planId: "plan-one", taskId: "T1", attempt: 1,
    });
    expect(r.launcher.inFlight()).toEqual([expect.objectContaining({ taskId: "T1", attempt: 1, childSessionID: "child-1" })]);
    done.resolve({ sessionID: "child-1", text: "ok" });
  });

  it("sends no synthetic message and no parent prompt during a launch", async () => {
    const r = rig();
    r.fr.state.script = creating(r, "child-1", Promise.resolve({ sessionID: "child-1", text: "done" }));
    const handle = r.launcher.launch(r.req(), r.hooks);
    await handle.completion;
    expect(r.fh.hosts.synthetic).not.toHaveBeenCalled();
    expect(r.fh.hosts.move).not.toHaveBeenCalled();
    expect(r.fh.hosts.interrupt).not.toHaveBeenCalled();
  });
});

describe("completion", () => {
  it("runner result -> completed; settles in-flight and evicts the binding; age metric 'confirmed'", async () => {
    const r = rig();
    await r.clock.advance(1_500); // the capture is 1.5 s old
    r.fr.state.script = creating(r, "child-1", Promise.resolve({ sessionID: "child-1", text: "all good" }));
    const handle = r.launcher.launch(r.req(), r.hooks);
    expect(handle.contextAgeMs).toBe(1_500);
    expect(await handle.confirmation).toMatchObject({ kind: "confirmed", childSessionID: "child-1", latencyMs: 0 });
    const end = await handle.completion;
    expect(end).toMatchObject({ kind: "completed", childSessionID: "child-1", text: "all good" });
    expect(r.log.at(-1)).toBe("unregisterInFlight");
    expect(r.evicted).toEqual(["child-1"]);
    expect(r.launcher.inFlight()).toEqual([]);
    expect(r.metrics).toEqual([expect.objectContaining({
      name: "context-age", taskId: "T1", attempt: 1, bootID: "aaaaaaaaaaaaaaaa", epoch: 1, callID: "call-1",
      ageMs: 1_500, result: "confirmed",
    })]);
    expect(r.launcher.gate(ORCH).ok).toBe(true);
  });

  it("the confirmation waits for a slow hook past the deadline (confirmed, not lost)", async () => {
    const r = rig();
    const hook = deferred<void>();
    r.onChildCreated.mockImplementation(() => hook.promise);
    const done = deferred<{ sessionID: string; text: string }>();
    r.fr.state.script = creating(r, "child-1", done.promise);
    const handle = r.launcher.launch(r.req(), r.hooks);
    let settled: LaunchConfirmation | null = null;
    void handle.confirmation.then((c) => { settled = c; });
    await r.clock.advance(31_000);
    expect(settled).toBeNull();
    expect(r.launcher.gate(ORCH).ok).toBe(true);
    hook.resolve();
    await flush();
    expect(settled).toMatchObject({ kind: "confirmed" });
    done.resolve({ sessionID: "child-1", text: "x" });
    expect(await handle.completion).toMatchObject({ kind: "completed" });
  });

  it("an unrequested session.execution.interrupted -> lost/unrequested-interrupt (guard 5)", async () => {
    const r = rig();
    r.fr.state.script = creating(r, "child-1", new Promise(() => undefined));
    const handle = r.launcher.launch(r.req(), r.hooks);
    await handle.confirmation;
    r.fh.emit({ type: "execution.interrupted", sessionID: "child-1", at: r.clock.clock.iso() });
    expect(await handle.completion).toMatchObject({ kind: "lost", reason: "unrequested-interrupt", childSessionID: "child-1" });
    expect(r.evicted).toEqual(["child-1"]);
  });

  it("a requested interrupt -> interrupted/<reason>; cancel is idempotent and interrupts the child once", async () => {
    const r = rig();
    const done = deferred<{ sessionID: string; text: string }>();
    r.fr.state.script = creating(r, "child-1", done.promise);
    const handle = r.launcher.launch(r.req(), r.hooks);
    await handle.confirmation;
    await r.launcher.cancel("T1", 1, "blocked");
    await r.launcher.cancel("T1", 1, "abort");
    expect(r.fh.hosts.interrupt).toHaveBeenCalledTimes(1);
    expect(r.fh.hosts.interrupt).toHaveBeenCalledWith("child-1");
    done.reject(new Error("aborted"));
    await flush();
    r.fh.emit({ type: "execution.interrupted", sessionID: "child-1", at: r.clock.clock.iso() });
    expect(await handle.completion).toMatchObject({ kind: "interrupted", reason: "blocked", childSessionID: "child-1" });
  });

  it("cancel before a child exists -> interrupted with no child, and no stale mark", async () => {
    const r = rig();
    const gone = deferred<{ sessionID: string; text: string }>();
    r.fr.state.script = () => gone.promise;
    const handle = r.launcher.launch(r.req(), r.hooks);
    await r.launcher.cancel("T1", 1, "abort");
    expect(r.fh.hosts.interrupt).not.toHaveBeenCalled();
    gone.reject(new Error("aborted"));
    expect(await handle.completion).toMatchObject({ kind: "interrupted", childSessionID: null, reason: "abort" });
    expect(r.launcher.gate(ORCH).ok).toBe(true);
  });

  it("runner throws after confirmation: no terminal event within the grace -> lost/runner-error (L13)", async () => {
    const r = rig({ endGraceMs: 5_000 });
    const done = deferred<{ sessionID: string; text: string }>();
    r.fr.state.script = creating(r, "child-1", done.promise);
    const handle = r.launcher.launch(r.req(), r.hooks);
    await handle.confirmation;
    done.reject(new Error("socket closed"));
    await flush();
    let end: ChildEnd | null = null;
    void handle.completion.then((e) => { end = e; });
    await r.clock.advance(4_999);
    expect(end).toBeNull();
    await r.clock.advance(1);
    expect(end).toMatchObject({ kind: "lost", reason: "runner-error", childSessionID: "child-1" });
  });

  it("runner throws after confirmation, then execution.completed -> completed with the last assistant text (D2)", async () => {
    const r = rig();
    r.fh.messages.push(
      { role: "assistant", text: "first", outcome: null },
      { role: "assistant", text: "final answer", outcome: null },
      { role: "idle", text: null, outcome: null },
    );
    const done = deferred<{ sessionID: string; text: string }>();
    r.fr.state.script = creating(r, "child-1", done.promise);
    const handle = r.launcher.launch(r.req(), r.hooks);
    await handle.confirmation;
    done.reject(new Error("stream dropped"));
    await flush();
    r.fh.emit({ type: "execution.completed", sessionID: "child-1", at: r.clock.clock.iso() });
    expect(await handle.completion).toMatchObject({ kind: "completed", text: "final answer" });
  });

  it("execution.completed before the runner returns: the runner's text wins inside the grace, the history after it", async () => {
    const first = rig();
    first.fh.messages.push({ role: "assistant", text: "from history", outcome: null });
    const done = deferred<{ sessionID: string; text: string }>();
    first.fr.state.script = creating(first, "child-1", done.promise);
    const h1 = first.launcher.launch(first.req(), first.hooks);
    await h1.confirmation;
    first.fh.emit({ type: "execution.completed", sessionID: "child-1", at: first.clock.clock.iso() });
    await first.clock.advance(1_000);
    done.resolve({ sessionID: "child-1", text: "from runner" });
    expect(await h1.completion).toMatchObject({ kind: "completed", text: "from runner" });

    const second = rig();
    second.fh.messages.push({ role: "assistant", text: "from history", outcome: null });
    second.fr.state.script = creating(second, "child-1", new Promise(() => undefined));
    const h2 = second.launcher.launch(second.req(), second.hooks);
    await h2.confirmation;
    second.fh.emit({ type: "execution.completed", sessionID: "child-1", at: second.clock.clock.iso() });
    await second.clock.advance(5_000);
    expect(await h2.completion).toMatchObject({ kind: "completed", text: "from history" });
  });

  it("ignores terminal events of other sessions", async () => {
    const r = rig();
    const done = deferred<{ sessionID: string; text: string }>();
    r.fr.state.script = creating(r, "child-1", done.promise);
    const handle = r.launcher.launch(r.req(), r.hooks);
    await handle.confirmation;
    r.fh.emit({ type: "execution.interrupted", sessionID: "someone-else", at: r.clock.clock.iso() });
    done.resolve({ sessionID: "child-1", text: "fine" });
    expect(await handle.completion).toMatchObject({ kind: "completed", text: "fine" });
  });
});

describe("confirmation and staleness (guards 1-3)", () => {
  it("no child within 30 s on the fake clock -> unconfirmed/timeout, lost/unconfirmed, context-stale, metric", async () => {
    const r = rig();
    r.fr.state.script = () => new Promise(() => undefined);
    const ctxRef = r.req().context;
    const handle = r.launcher.launch(r.req(), r.hooks);
    let c: LaunchConfirmation | null = null;
    void handle.confirmation.then((x) => { c = x; });
    await r.clock.advance(29_999);
    expect(c).toBeNull();
    await r.clock.advance(1);
    expect(c).toEqual({ kind: "unconfirmed", reason: "timeout", error: null });
    expect(await handle.completion).toMatchObject({ kind: "lost", reason: "unconfirmed", childSessionID: null });
    expect(r.metrics.map((m) => m.result)).toEqual(["timeout"]);
    expect(r.metrics[0]?.ageMs).toBe(0);
    expect(r.launcher.gate(ORCH)).toEqual({
      ok: false, reason: "context-stale",
      wake: { reason: "stale-context", stateKey: staleContextKey(ctxRef.bootID, ctxRef.epoch) },
    });
    // the same context never launches again
    expect(() => r.launcher.launch(r.req({ taskId: "T2", prompt: `PLAN CONTEXT\n\n\n[plan plan-one:T2#1] nonce=${NONCE}\n\nTASK` }), r.hooks))
      .toThrow(expect.objectContaining({ code: "E_NO_CONTEXT" }));
    // a refreshed context lifts the stale state
    r.fr.capture();
    expect(r.launcher.gate(ORCH).ok).toBe(true);
  });

  it("a child that arrives after the timeout is refused (L11) or adopted (L12)", async () => {
    for (const decision of ["refuse", "adopt"] as const) {
      const r = rig();
      r.onLateChild.mockResolvedValue(decision);
      const start = deferred<void>();
      const done = deferred<{ sessionID: string; text: string }>();
      let outcome: unknown = "pending";
      r.fr.state.script = async (req) => {
        await start.promise;
        try { await req.onCreated("late-child"); outcome = "accepted"; } catch (e) { outcome = e; }
        return done.promise;
      };
      const handle = r.launcher.launch(r.req(), r.hooks);
      await r.clock.advance(30_000);
      expect(await handle.confirmation).toMatchObject({ kind: "unconfirmed", reason: "timeout" });
      start.resolve();
      await flush();
      expect(r.onLateChild).toHaveBeenCalledWith("late-child");
      if (decision === "refuse") {
        expect(outcome).toBeInstanceOf(Error);
        expect(r.binds).toEqual([]);
        expect(r.onChildCreated).not.toHaveBeenCalled();
      } else {
        expect(outcome).toBe("accepted");
        expect(r.binds[0]).toMatchObject({ childSessionID: "late-child", role: "implementer", workRoot: ROOT });
        expect(r.onChildCreated).toHaveBeenCalledWith("late-child");
        expect(r.log).toContain("registerInFlight:late-child");
        done.resolve({ sessionID: "late-child", text: "x" });
        await flush();
        expect(r.evicted).toContain("late-child");
        expect(r.launcher.inFlight()).toEqual([]);
      }
    }
  });

  it("a runner that throws before the child exists -> unconfirmed/threw, lost/runner-error, stale (L6)", async () => {
    const r = rig();
    r.fr.state.script = () => Promise.reject(new Error("host unavailable"));
    const handle = r.launcher.launch(r.req(), r.hooks);
    expect(await handle.confirmation).toEqual({ kind: "unconfirmed", reason: "threw", error: "host unavailable" });
    expect(await handle.completion).toMatchObject({ kind: "lost", reason: "runner-error", childSessionID: null });
    expect(r.metrics.map((m) => m.result)).toEqual(["threw"]);
    expect(r.launcher.gate(ORCH)).toMatchObject({ ok: false, reason: "context-stale" });
  });

  it("a synchronous throw of the runner is handled like a rejection", async () => {
    const r = rig();
    r.fr.state.script = () => { throw new Error("sync boom"); };
    const handle = r.launcher.launch(r.req(), r.hooks);
    expect(await handle.confirmation).toMatchObject({ kind: "unconfirmed", reason: "threw" });
    expect(await handle.completion).toMatchObject({ kind: "lost", reason: "runner-error" });
  });

  it("ContextSupersededError -> unconfirmed/superseded, lost/context-superseded, NOT stale (L5)", async () => {
    const r = rig();
    const ref = r.req().context;
    r.fr.state.script = () => Promise.reject(new ContextSupersededError(ref, null));
    const handle = r.launcher.launch(r.req(), r.hooks);
    expect(await handle.confirmation).toMatchObject({ kind: "unconfirmed", reason: "superseded" });
    expect(await handle.completion).toMatchObject({ kind: "lost", reason: "context-superseded" });
    expect(r.metrics.map((m) => m.result)).toEqual(["superseded"]);
    expect(r.launcher.gate(ORCH).ok).toBe(true);
  });

  it("a binding failure -> unconfirmed/task-error (L8), the hook error reaches the runner, the child is never prompted", async () => {
    const r = rig();
    r.bindings.bind = () => { throw new Error("already bound to another root"); };
    const prompted = vi.fn();
    r.fr.state.script = async (req) => { await req.onCreated("child-1"); prompted(); return { sessionID: "child-1", text: "" }; };
    const handle = r.launcher.launch(r.req(), r.hooks);
    expect(await handle.confirmation).toEqual({ kind: "unconfirmed", reason: "task-error", error: "already bound to another root" });
    expect(await handle.completion).toMatchObject({ kind: "lost", reason: "unconfirmed", childSessionID: "child-1" });
    expect(prompted).not.toHaveBeenCalled();
    expect(r.onChildCreated).not.toHaveBeenCalled();
    expect(r.launcher.gate(ORCH).ok).toBe(true);
  });

  it("a failing onChildCreated -> unconfirmed/hook-failed (L9), not stale", async () => {
    const r = rig();
    r.onChildCreated.mockRejectedValue(new Error("fsync failed"));
    const prompted = vi.fn();
    r.fr.state.script = async (req) => { await req.onCreated("child-1"); prompted(); return { sessionID: "child-1", text: "" }; };
    const handle = r.launcher.launch(r.req(), r.hooks);
    expect(await handle.confirmation).toEqual({ kind: "unconfirmed", reason: "hook-failed", error: "fsync failed" });
    expect(await handle.completion).toMatchObject({ kind: "lost", reason: "unconfirmed" });
    expect(prompted).not.toHaveBeenCalled();
    expect(r.metrics.map((m) => m.result)).toEqual(["hook-failed"]);
    expect(r.launcher.gate(ORCH).ok).toBe(true);
  });

  it("the age of the context is recorded for every result", async () => {
    const r = rig();
    await r.clock.advance(12_345);
    r.fr.state.script = () => Promise.reject(new Error("x"));
    const handle = r.launcher.launch(r.req(), r.hooks);
    await handle.completion;
    expect(r.metrics).toEqual([expect.objectContaining({ ageMs: 12_345, result: "threw", epoch: 1, callID: "call-1" })]);
  });

  it("never wakes, prompts or journals on its own: the gate only reports the wake", async () => {
    const r = rig();
    r.fr.state.script = () => Promise.reject(new Error("x"));
    await r.launcher.launch(r.req(), r.hooks).completion;
    expect(r.launcher.gate(ORCH)).toMatchObject({ ok: false, wake: { reason: "stale-context" } });
    expect(r.fh.hosts.synthetic).not.toHaveBeenCalled();
  });
});

describe("gate (pure read)", () => {
  it("restart: a new process has no capture -> awaiting-first-router-call until the first router call (guard 6)", () => {
    const r = rig({}, { capture: false });
    expect(r.launcher.gate(ORCH)).toEqual({
      ok: false, reason: "awaiting-first-router-call",
      wake: { reason: "stale-context", stateKey: awaitRouterCallKey("aaaaaaaaaaaaaaaa", ORCH) },
    });
    r.fr.capture("another-session");
    expect(r.launcher.gate(ORCH)).toMatchObject({ ok: false, reason: "awaiting-first-router-call" });
    r.fr.capture(ORCH);
    expect(r.launcher.gate(ORCH)).toMatchObject({ ok: true, ageMs: 0 });
  });

  it("a different bootID changes the key (a restart never reuses a burned key)", () => {
    const a = rig({}, { capture: false });
    const clock = fakeClock();
    const other = fakeRunner(() => clock.clock.now(), "bbbbbbbbbbbbbbbb");
    const b = createTaskLauncher({
      runner: other.runner, hosts: fakeHosts().hosts, bindings: a.bindings,
      bookkeeping: { decisionRow() {}, recordDispatchStart() {}, registerInFlight() {}, unregisterInFlight() {} },
      clock: clock.clock, lifetime: new AbortController().signal, knownAgent: () => true, onMetric() {},
    });
    const ka = a.launcher.gate(ORCH);
    const kb = b.gate(ORCH);
    expect(ka.ok || kb.ok).toBe(false);
    if (!ka.ok && !kb.ok && ka.wake && kb.wake) expect(ka.wake.stateKey).not.toBe(kb.wake.stateKey);
  });

  it("a capture that was evicted -> no-context with the last epoch in the key", () => {
    const r = rig();
    r.fr.capture();
    r.fr.forget();
    expect(r.launcher.gate(ORCH)).toEqual({
      ok: false, reason: "no-context",
      wake: { reason: "stale-context", stateKey: noContextKey("aaaaaaaaaaaaaaaa", ORCH, 2) },
    });
  });

  it("reads the age from the clock, not from the launch", async () => {
    const r = rig();
    await r.clock.advance(2_000);
    expect(r.launcher.gate(ORCH)).toMatchObject({ ok: true, ageMs: 2_000 });
  });
});

describe("dispose", () => {
  it("aborts every owned signal, journals nothing and stops listening", async () => {
    const r = rig();
    r.fr.state.script = creating(r, "child-1", new Promise(() => undefined));
    const handle = r.launcher.launch(r.req(), r.hooks);
    await handle.confirmation;
    const seen = vi.mocked(r.fr.runner.run).mock.calls[0]?.[0];
    await r.launcher.dispose();
    expect(seen?.signal.aborted).toBe(true);
    expect(r.onChildCreated).toHaveBeenCalledTimes(1);
    await r.launcher.dispose(); // idempotent
  });
});
