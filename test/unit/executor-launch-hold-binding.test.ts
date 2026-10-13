import { describe, expect, it, vi } from "vitest";
import { RESUME_PROMPT } from "../../src/executor/runtime";
import { createTaskLauncher, type PlanBindInput, type PlanRoleBindings } from "../../src/executor/launch";
import {
  ExecutorError,
  type ChildEnd,
  type ChildRunRequest,
  type ChildRunner,
  type Clock,
  type DispatchBookkeeping,
  type HostSessionEvent,
  type HostSessions,
  type LaunchHooks,
  type LaunchRequest,
  type RetainedContextInfo,
} from "../../src/executor/types";

// pdf2-1 (a), W4 A13: a completed child's binding is held until the runtime decided on a budget resume of that child.
const NONCE = "0123456789abcdef0123456789abcdef";
const ORCH = "orch-1";
const ROOT = process.platform === "win32" ? "C:\\work\\slot-1" : "/work/slot-1";
const BOOT = "aaaaaaaaaaaaaaaa";

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function rig() {
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  let nextId = 1;
  const clock: Clock = {
    now: () => now,
    iso: (ms) => new Date(ms ?? now).toISOString(),
    setTimer() { return { id: nextId++ }; },
    clearTimer() {},
    randomHex: (bytes) => "ab".repeat(bytes),
  };
  const capture: RetainedContextInfo = {
    sessionID: ORCH, callID: "call-1", messageID: "m", agent: "orchestrator", capturedAt: new Date(now).toISOString(), bootID: BOOT, epoch: 1,
  };
  const listeners = new Set<(e: HostSessionEvent) => void>();
  const hosts: HostSessions = {
    get: vi.fn(async () => null),
    context: vi.fn(async () => ({ messages: [] })),
    activity: vi.fn(async () => "unknown" as const),
    interrupt: vi.fn(async () => undefined),
    synthetic: vi.fn(async () => undefined),
    move: vi.fn(async () => undefined),
    onEvent(l) { listeners.add(l); return () => { listeners.delete(l); }; },
  };
  const emit = (e: HostSessionEvent): void => { for (const l of listeners) l(e); };
  const calls: ChildRunRequest[] = [];
  const runner: ChildRunner = {
    bootID: BOOT,
    retainedContext: (sid) => (sid === ORCH ? capture : null),
    onContextCaptured: () => () => {},
    dispose: async () => {},
    async run(req) {
      calls.push(req);
      const child = req.resumeSessionID ?? "child-1";
      await req.onCreated(child);
      if (req.resumeSessionID !== undefined) emit({ type: "step.started", sessionID: child, providerID: "p", modelID: "m", at: clock.iso() });
      return { sessionID: child, text: "NEED MORE: budget" };
    },
  };
  const binds: PlanBindInput[] = [];
  const evicted: string[] = [];
  const bindings: PlanRoleBindings = { bind(i) { binds.push(i); }, evict(c) { evicted.push(c); } };
  const bookkeeping: DispatchBookkeeping = { decisionRow() {}, recordDispatchStart() {}, registerInFlight() {}, unregisterInFlight() {} };
  const launcher = createTaskLauncher({
    runner, hosts, bindings, bookkeeping, clock, lifetime: new AbortController().signal, knownAgent: () => true, onMetric() {},
  });
  const hooks = (hold: boolean): LaunchHooks => ({
    onChildCreated: async () => {}, onLateChild: async () => "refuse", ...(hold ? { holdCompletedBinding: true } : {}),
  });
  const req = (over: Partial<LaunchRequest> = {}): LaunchRequest => ({
    planId: "plan-one", taskId: "T1", attempt: 1, nonce: NONCE, orchestratorSessionID: ORCH,
    context: { bootID: BOOT, epoch: 1, callID: "call-1" },
    route: { agent: "coder", model: { providerID: "p", modelID: "m", variant: null }, provider: "p", heavy: false },
    role: "implementer", grant: ["read", "edit"], workRoot: ROOT,
    prompt: over.resume === undefined ? `PLAN CONTEXT\nshared\n\n[plan plan-one:T1#1] nonce=${NONCE}\n\nTASK\ndo it` : RESUME_PROMPT,
    ...over,
  });
  return { launcher, binds, evicted, calls, hooks, req };
}

async function completed(end: Promise<ChildEnd>): Promise<ChildEnd> {
  await flush();
  const e = await end;
  expect(e.kind).toBe("completed");
  return e;
}

describe("launcher: held binding of a completed child (pdf2-1 (a))", () => {
  it("without holdCompletedBinding a completed end evicts its binding, as before", async () => {
    const r = rig();
    await completed(r.launcher.launch(r.req(), r.hooks(false)).completion);
    expect(r.evicted).toEqual(["child-1"]);
    r.launcher.releaseBinding?.("child-1");
    expect(r.evicted).toEqual(["child-1"]);
  });

  it("holds the binding of a completed end; the identical resume takes it over without binding again", async () => {
    const r = rig();
    await completed(r.launcher.launch(r.req(), r.hooks(true)).completion);
    expect(r.binds).toEqual([expect.objectContaining({ childSessionID: "child-1", planId: "plan-one", taskId: "T1", attempt: 1 })]);
    expect(r.evicted).toEqual([]);
    const resumed = r.launcher.launch(r.req({ resume: { childSessionID: "child-1" } }), r.hooks(true));
    expect(await resumed.confirmation).toMatchObject({ kind: "confirmed", childSessionID: "child-1" });
    await completed(resumed.completion);
    expect(r.calls[1]?.resumeSessionID).toBe("child-1");
    expect(r.binds).toHaveLength(1); // the live binding was taken over, never bound again
    expect(r.evicted).toEqual([]); // the resumed end is held again for the next decision
    r.launcher.releaseBinding?.("child-1");
    expect(r.evicted).toEqual(["child-1"]);
    r.launcher.releaseBinding?.("child-1");
    expect(r.evicted).toEqual(["child-1"]);
  });

  it("a resume naming a held child under another attempt or task is refused; the held binding is untouched", async () => {
    const r = rig();
    await completed(r.launcher.launch(r.req(), r.hooks(true)).completion);
    for (const over of [{ attempt: 2 }, { taskId: "T2" }, { planId: "plan-two" }] as const) {
      let thrown: unknown = null;
      try {
        r.launcher.launch(r.req({ ...over, resume: { childSessionID: "child-1" } }), r.hooks(true));
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ExecutorError);
      expect((thrown as ExecutorError).code).toBe("E_LAUNCH_TASK");
    }
    expect(r.binds).toHaveLength(1);
    expect(r.evicted).toEqual([]);
    r.launcher.releaseBinding?.("child-1");
    expect(r.evicted).toEqual(["child-1"]);
  });

  it("dispose evicts every held binding", async () => {
    const r = rig();
    await completed(r.launcher.launch(r.req(), r.hooks(true)).completion);
    expect(r.evicted).toEqual([]);
    await r.launcher.dispose();
    expect(r.evicted).toEqual(["child-1"]);
  });
});
