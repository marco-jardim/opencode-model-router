import { describe, expect, it, vi } from "vitest";
import type { Plugin } from "@opencode/plugin";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import type { SessionContext } from "@opencode/plugin/promise/session";
import { createV2Runtime, STRAY_CLEANUP_TIMEOUT_MS, V2_GRADER_AGENT } from "../../src/compat/v2-client";
import { createVerificationWiring } from "../../src/verify/wiring";
import type { RouterConfig } from "../../src/router/config";
import * as routerConfig from "../../src/router/config";
import ModelRouterPlugin from "../../src/index";
import { ResumeRejectedError, type ChildSessionRequest, type RouterPluginInput } from "../../src/compat/child-session";
import { createV2Observations } from "../../src/compat/v2-observations";
import { servicePairs } from "../helpers/service-observations";

function fixture() {
  const execute = vi.fn(async (_input: unknown, context: ToolContext): Promise<{ output: { sessionID: string; status: string; output?: unknown } }> => {
    await context.progress({ sessionID: "child", status: "running" });
    return { output: { sessionID: "child", status: "completed", output: "verified result" } };
  });
  const context = {
    location: { directory: "/project" },
    session: {
      get: vi.fn(async () => ({ id: "child", parentID: "parent", agent: "fast" })),
      interrupt: vi.fn(async () => ({ interrupted: true })),
      remove: vi.fn(async () => {}),
      move: vi.fn(async () => {}),
      wait: vi.fn(async (_input: unknown, _options?: { signal?: AbortSignal }) => {}),
      context: vi.fn(async (_input: unknown, _options?: { signal?: AbortSignal }): Promise<unknown[]> => []),
    },
    tool: { list: vi.fn(async () => [{ id: "subagent", execute }]) },
    provider: { list: vi.fn(async () => ({ data: [{ id: "p", name: "Provider" }] })) },
    model: {
      list: vi.fn(async () => ({ data: [
        { id: "aliased-model", modelID: "upstream-id", providerID: "p", status: "active", enabled: true },
        { id: "disabled-model", modelID: "disabled", providerID: "p", status: "active", enabled: false },
      ] })),
      default: vi.fn(async () => ({ data: { providerID: "p", id: "aliased-model" } })),
    },
  };
  const runtime = createV2Runtime(context as unknown as Plugin.Context);
  const toolContext = {
    sessionID: "parent", agent: "build", messageID: "message", id: "call",
    signal: new AbortController().signal, progress: vi.fn(async () => {}),
  } as unknown as ToolContext;
  return { context, runtime, toolContext, execute };
}

describe("v2 runner: retained context identity and detached runs (3.1.5)", () => {
  const withCall = (runtime: ReturnType<typeof createV2Runtime>, base: ToolContext, over: Record<string, unknown> = {}) =>
    runtime.withToolContext({ ...base, ...over } as unknown as ToolContext, async () => undefined);
  const detachedRequest = (context: { bootID: string; epoch: number; callID: string }, over: Record<string, unknown> = {}) => ({
    parentSessionID: "parent", prompt: "do it", agent: "coder",
    model: { providerID: "p", modelID: "m", variant: null },
    cwd: "/work/slot", signal: new AbortController().signal, detached: true as const, context,
    onCreated: vi.fn(async () => {}),
    ...over,
  });

  it("raw recovery grader dispatch rejects before lookup/execution/onCreated without its parent's real capture", async () => {
    const { runtime, context, toolContext, execute } = fixture();
    const onCreated = vi.fn(async () => {});
    const request = { parentSessionID: "parent", prompt: "grade recovered attempt 2", onCreated };
    await expect(runtime.childRunner.run(request)).rejects.toThrow(/active tool context or a retained context matching its parent/);
    await runtime.withToolContext({ ...toolContext, sessionID: "different-root" } as ToolContext, async () => {
      await expect(runtime.childRunner.run(request)).rejects.toThrow(/retained context matching its parent/);
    });
    expect(context.tool.list).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
    await runtime.withToolContext(toolContext, async () => undefined);
    await expect(runtime.childRunner.run(request)).resolves.toMatchObject({ sessionID: "child" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]).toMatchObject({ sessionID: "parent", id: "call", messageID: "message" });
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it("records epoch, capturedAt and bootID per capture and notifies listeners synchronously", async () => {
    const { context, toolContext } = fixture();
    const runtime = createV2Runtime(context as unknown as Plugin.Context, { bootID: "0123456789abcdef", now: () => Date.parse("2026-02-03T04:05:06.000Z") });
    const seen: unknown[] = [];
    const off = runtime.childRunner.onContextCaptured((info) => { seen.push(info); });
    runtime.childRunner.onContextCaptured(() => { throw new Error("a listener never breaks the call"); });
    await withCall(runtime, toolContext);
    await withCall(runtime, toolContext, { id: "call-2" });
    expect(runtime.childRunner.bootID).toBe("0123456789abcdef");
    expect(seen).toEqual([
      { sessionID: "parent", callID: "call", messageID: "message", agent: "build", capturedAt: "2026-02-03T04:05:06.000Z", bootID: "0123456789abcdef", epoch: 1 },
      { sessionID: "parent", callID: "call-2", messageID: "message", agent: "build", capturedAt: "2026-02-03T04:05:06.000Z", bootID: "0123456789abcdef", epoch: 2 },
    ]);
    expect(runtime.childRunner.retainedContext("parent")).toEqual(seen[1]);
    expect(runtime.childRunner.retainedContext("nobody")).toBeNull();
    off();
    await withCall(runtime, toolContext);
    expect(seen).toHaveLength(2);
  });

  it("uses a random 16-hex bootID per instance, and one epoch counter for all sessions", async () => {
    const a = fixture();
    const b = fixture();
    expect(a.runtime.childRunner.bootID).toMatch(/^[0-9a-f]{16}$/);
    expect(a.runtime.childRunner.bootID).not.toBe(b.runtime.childRunner.bootID);
    await withCall(a.runtime, a.toolContext, { sessionID: "one" });
    await withCall(a.runtime, a.toolContext, { sessionID: "two" });
    expect(a.runtime.childRunner.retainedContext("one")?.epoch).toBe(1);
    expect(a.runtime.childRunner.retainedContext("two")?.epoch).toBe(2);
  });

  it("throws ContextSupersededError before any host call when the pinned capture is gone or not current", async () => {
    const { runtime, context, toolContext, execute } = fixture();
    const boot = runtime.childRunner.bootID;
    const pinned = { bootID: boot, epoch: 1, callID: "call" };
    await expect(runtime.childRunner.run(detachedRequest(pinned))).rejects.toMatchObject({ name: "ContextSupersededError", current: null, requested: pinned });
    await withCall(runtime, toolContext);
    await withCall(runtime, toolContext, { id: "newer" });
    const error = await runtime.childRunner.run(detachedRequest(pinned)).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "ContextSupersededError", requested: pinned, current: { bootID: boot, epoch: 2, callID: "newer" } });
    await expect(runtime.childRunner.run(detachedRequest({ ...pinned, epoch: 2, bootID: "ffffffffffffffff", callID: "newer" })))
      .rejects.toMatchObject({ name: "ContextSupersededError" });
    expect(context.tool.list).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("a detached run needs a pinned context and a signal", async () => {
    const { runtime, context, toolContext } = fixture();
    await withCall(runtime, toolContext);
    const { context: _ignored, ...noContext } = detachedRequest({ bootID: runtime.childRunner.bootID, epoch: 1, callID: "call" });
    await expect(runtime.childRunner.run(noContext as never)).rejects.toThrow(/pinned context/);
    expect(context.tool.list).not.toHaveBeenCalled();
  });

  it("a detached run ignores an aborted retained toolContext.signal and never forwards progress to the parent call", async () => {
    const { runtime, execute, toolContext } = fixture();
    const callAbort = new AbortController();
    const call = { ...toolContext, signal: callAbort.signal, progress: vi.fn(async () => {}) } as unknown as ToolContext;
    let nativeSignal: AbortSignal | undefined;
    execute.mockImplementation(async (_input: unknown, native: ToolContext) => {
      nativeSignal = native.signal;
      callAbort.abort(); // the parent call is cancelled while the detached child runs
      await native.progress({ sessionID: "child", status: "running" });
      return { output: { sessionID: "child", status: "completed", output: "detached result" } };
    });
    const onCreated = vi.fn(async () => {});
    const result = await runtime.withToolContext(call, async () => {
      const info = runtime.childRunner.retainedContext("parent")!;
      return runtime.childRunner.run(detachedRequest({ bootID: info.bootID, epoch: info.epoch, callID: info.callID }, { onCreated }));
    });
    expect(result).toEqual({ sessionID: "child", text: "detached result" });
    expect(onCreated).toHaveBeenCalledWith("child");
    expect(nativeSignal?.aborted).toBe(false);
    expect(call.progress).not.toHaveBeenCalled();
  });

  it("a non-detached run is unchanged: it still forwards progress and follows the call's signal", async () => {
    const { runtime, execute, toolContext } = fixture();
    const call = { ...toolContext, progress: vi.fn(async () => {}) } as unknown as ToolContext;
    const result = await runtime.withToolContext(call, () => runtime.childRunner.run({
      parentSessionID: "parent", prompt: "grade", onCreated: async () => {},
    }));
    expect(result.text).toBe("verified result");
    expect(call.progress).toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("pinned sessions survive the LRU until released", async () => {
    const { runtime, toolContext } = fixture();
    await withCall(runtime, toolContext, { sessionID: "s0" });
    const unpin = runtime.childRunner.pin("s0");
    const unpinAgain = runtime.childRunner.pin("s0"); // pins nest
    for (let i = 1; i <= 500; i++) await withCall(runtime, toolContext, { sessionID: `s${i}` });
    expect(runtime.childRunner.retainedContext("s0")).not.toBeNull();
    expect(runtime.childRunner.retainedContext("s1")).toBeNull(); // the oldest unpinned went instead
    expect(runtime.childRunner.retainedContext("s500")).not.toBeNull();
    unpin();
    unpin(); // idempotent
    await withCall(runtime, toolContext, { sessionID: "s501" });
    expect(runtime.childRunner.retainedContext("s0")).not.toBeNull();
    unpinAgain();
    await withCall(runtime, toolContext, { sessionID: "s502" });
    expect(runtime.childRunner.retainedContext("s0")).toBeNull();
    expect(runtime.childRunner.retainedContext("s502")).not.toBeNull();
  });
});

describe("v2 client compatibility", () => {
  it("wraps session data and forwards identifiers, signals, and bound method receivers", async () => {
    const { runtime, context } = fixture();
    const signal = new AbortController().signal;
    context.session.get.mockImplementation(async function (this: unknown) {
      expect(this).toBe(context.session);
      return { id: "child", parentID: "parent", agent: "fast" };
    });
    await expect(runtime.client.session.get({ path: { id: "child" }, signal })).resolves.toEqual({
      data: { id: "child", parentID: "parent", agent: "fast" },
    });
    expect(context.session.get).toHaveBeenCalledWith({ sessionID: "child" }, { signal });
    await runtime.client.session.abort({ path: { id: "child" }, signal });
    expect(context.session.interrupt).toHaveBeenCalledWith({ sessionID: "child" }, { signal });
  });

  it("preserves catalog aliases and defaults, excludes disabled models, and scopes lookup to the project", async () => {
    const { runtime, context } = fixture();
    await expect(runtime.client.config.providers()).resolves.toEqual({ data: {
      providers: [{ id: "p", name: "Provider", models: { "aliased-model": { id: "aliased-model", status: "active", enabled: true } } }],
      default: { p: "aliased-model" },
    } });
    for (const method of [context.provider.list, context.model.list, context.model.default]) {
      expect(method).toHaveBeenCalledWith({ location: { directory: "/project" } });
    }
  });

  it("QA-2.4-3: passes the model's cost, capabilities, family, variants and limit through, so the cost doctor can reuse this one call", async () => {
    const { runtime, context } = fixture();
    const info = {
      id: "m", modelID: "m", providerID: "p", status: "active", enabled: true, family: "claude-haiku",
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      cost: [{ input: 1, output: 5, cache: { read: 0.1, write: 1.25 } }],
      variants: [{ id: "high" }],
      limit: { context: 200_000, output: 64_000 },
    };
    context.model.list.mockResolvedValueOnce({ data: [info, { ...info, id: "off", enabled: false }] });
    const result = await runtime.client.config.providers();
    expect((result.data.providers[0]?.models as Record<string, unknown>)).toEqual({
      m: { id: "m", status: "active", enabled: true, family: "claude-haiku", capabilities: info.capabilities, cost: info.cost, variants: info.variants, limit: info.limit },
    });
  });

  it("propagates server errors instead of reporting an empty successful catalog or session", async () => {
    const { runtime, context } = fixture();
    const error = new Error("server unavailable");
    context.session.get.mockRejectedValueOnce(error);
    context.model.list.mockRejectedValueOnce(error);
    await expect(runtime.client.session.get({ path: { id: "child" } })).rejects.toBe(error);
    await expect(runtime.client.config.providers()).rejects.toBe(error);
    expect(runtime.client).not.toHaveProperty("app.log");
    expect(runtime.client.session).not.toHaveProperty("delete");
    expect(runtime.client.session).not.toHaveProperty("create");
  });
});

describe("native v2 child runner", () => {
  it("interrupts before removing a child on newer hosts", async () => {
    const { runtime, context } = fixture();
    await runtime.childRunner.dispose("child");
    expect(context.session.interrupt).toHaveBeenCalledWith({ sessionID: "child" }, undefined);
    expect(context.session.remove).toHaveBeenCalledWith({ sessionID: "child" });
    expect(context.session.interrupt.mock.invocationCallOrder[0]).toBeLessThan(context.session.remove.mock.invocationCallOrder[0]!);
  });

  it("still interrupts without throwing on hosts without session removal", async () => {
    const { context } = fixture();
    const { remove, ...session } = context.session;
    const runtime = createV2Runtime({ ...context, session } as unknown as Plugin.Context);
    await expect(runtime.childRunner.dispose("child")).resolves.toBeUndefined();
    expect(session.interrupt).toHaveBeenCalledWith({ sessionID: "child" }, undefined);
    expect(remove).not.toHaveBeenCalled();
  });

  it("catches removal failures at the shared disposal boundary", async () => {
    const { runtime, context } = fixture();
    context.session.remove.mockRejectedValueOnce(new Error("session already removed"));
    const wiring = createVerificationWiring({ client: runtime.client, childRunner: runtime.childRunner, directory: "/project", getConfig: routerConfig.loadConfig });
    try {
      await expect(wiring.disposeChildSession("child")).resolves.toBeUndefined();
      expect(context.session.remove).toHaveBeenCalledWith({ sessionID: "child" });
    } finally { await wiring.disposeVerification(); }
  });

  it("runs a real child with its parent, model variant, and guards registered before execution", async () => {
    const { runtime, toolContext, execute, context } = fixture();
    const onCreated = vi.fn(async (sessionID: string) => {
      expect(sessionID).toBe("child");
      const system: SessionContext["system"] = [];
      runtime.applyChildSystem(sessionID, system);
      expect(system).toEqual([{ type: "text", text: "Grade the artifact" }]);
      // A moved child gets the static hidden-agent system from its new
      // location's plugin instance. Preserve that part instead of duplicating it.
      const agentSystem = { type: "text" as const, text: "Grade the artifact" };
      const inherited = [agentSystem];
      runtime.applyChildSystem(sessionID, inherited);
      expect(inherited).toEqual([agentSystem]);
      expect(inherited[0]).toBe(agentSystem);
    });
    execute.mockImplementationOnce(async (input, childContext) => {
      expect(input).toEqual({
        agent: V2_GRADER_AGENT, description: "Router result verification", prompt: "Check changed files",
        model: "p/model/path#high", background: false,
      });
      expect(childContext.sessionID).toBe("parent");
      expect(childContext.messageID).toBe("message");
      expect(childContext.id).toBe("call");
      await childContext.progress({ sessionID: "child", status: "running" });
      expect(onCreated).toHaveBeenCalledOnce();
      expect(context.session.move).toHaveBeenCalledWith({ sessionID: "child", directory: "/artifact" }, { signal: childContext.signal });
      return { output: { sessionID: "child", status: "completed", output: "verified result" } };
    });
    await expect(runtime.withToolContext(toolContext, () => runtime.childRunner.run({
      parentSessionID: "parent", cwd: "/artifact", prompt: "Check changed files", system: "Grade the artifact",
      model: { providerID: "p", modelID: "model/path", variant: "high" }, onCreated,
    }))).resolves.toEqual({ sessionID: "child", text: "verified result" });
    const system: SessionContext["system"] = [];
    expect(toolContext.progress).toHaveBeenCalledWith({ sessionID: "child", status: "running" });
    runtime.applyChildSystem("child", system);
    expect(system).toEqual([]);
    await runtime.childRunner.dispose("child");
    expect(context.session.interrupt).toHaveBeenCalledWith({ sessionID: "child" }, undefined);
  });

  it("keeps simultaneous dispatch contexts and system prompts separate", async () => {
    const { runtime, toolContext, execute } = fixture();
    execute.mockImplementation(async (input, context) => {
      const sessionID = `child-${context.sessionID}`;
      await context.progress({ sessionID, status: "running" });
      await Promise.resolve();
      const system: SessionContext["system"] = [];
      runtime.applyChildSystem(sessionID, system);
      expect(system).toEqual([{ type: "text", text: context.sessionID }]);
      return { output: { sessionID, status: "completed", output: (input as { prompt: string }).prompt } };
    });
    const results = await Promise.all(["one", "two"].map(parent => runtime.withToolContext({
      ...toolContext, sessionID: parent as ToolContext["sessionID"],
    }, () => runtime.childRunner.run({ prompt: parent, system: parent, onCreated: async () => {} }))));
    expect(results).toEqual([{ sessionID: "child-one", text: "one" }, { sessionID: "child-two", text: "two" }]);
  });

  it("fails before dispatch when the parent context is missing or mismatched", async () => {
    const { runtime, toolContext, execute } = fixture();
    const request = { prompt: "work", onCreated: async () => {} };
    await expect(runtime.childRunner.run(request)).rejects.toThrow("active tool context");
    await expect(runtime.withToolContext(toolContext, () => runtime.childRunner.run({ ...request, parentSessionID: "other" })))
      .rejects.toThrow("matching its parent");
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not start an aborted dispatch and forwards cancellation while running", async () => {
    const { runtime, toolContext, execute } = fixture();
    const cancelled = new AbortController();
    cancelled.abort(new Error("cancelled"));
    await expect(runtime.withToolContext(toolContext, () => runtime.childRunner.run({
      prompt: "work", signal: cancelled.signal, onCreated: async () => {},
    }))).rejects.toThrow("cancelled");
    expect(execute).not.toHaveBeenCalled();
    const active = new AbortController();
    execute.mockImplementationOnce(async (_input, context) => {
      await context.progress({ sessionID: "child", status: "running" });
      active.abort(new Error("deadline"));
      context.signal.throwIfAborted();
      throw new Error("unreachable");
    });
    await expect(runtime.withToolContext(toolContext, () => runtime.childRunner.run({
      prompt: "work", signal: active.signal, onCreated: async () => {},
    }))).rejects.toThrow("deadline");
  });

  it("uses the recorded parent for deferred grading even inside another parent's worker scope", async () => {
    const { runtime, toolContext, execute } = fixture();
    const original = new AbortController();
    await runtime.withToolContext({ ...toolContext, signal: original.signal }, async () => {});
    original.abort(new Error("originating tool finished"));
    execute.mockImplementationOnce(async (_input, context) => {
      expect(context.sessionID).toBe("parent");
      expect(context.messageID).toBe("message");
      expect(context.signal.aborted).toBe(false);
      await context.progress({ sessionID: "child", status: "running" });
      return { output: { sessionID: "child", status: "completed", output: "verified result" } };
    });
    await expect(runtime.withToolContext({ ...toolContext, sessionID: "other" as ToolContext["sessionID"] }, () => runtime.childRunner.run({
      parentSessionID: "parent", prompt: "deferred grading", onCreated: async () => {},
    }))).resolves.toEqual({ sessionID: "child", text: "verified result" });
    runtime.forgetSession("parent");
    expect(toolContext.progress).not.toHaveBeenCalled();
    await expect(runtime.childRunner.run({ parentSessionID: "parent", prompt: "again", onCreated: async () => {} }))
      .rejects.toThrow("matching its parent");
  });

  it("QA-PDF12-7 a context run with `retain: false` serves its own operation but never becomes the parent's retained context", async () => {
    const { runtime, toolContext, execute } = fixture();
    const agents: unknown[] = [];
    execute.mockImplementation(async (_input, context) => {
      agents.push(context.agent);
      await context.progress({ sessionID: "child", status: "running" });
      return { output: { sessionID: "child", status: "completed", output: "verified result" } };
    });
    // The parent's real call, retained once it settles.
    await runtime.withToolContext({ ...toolContext, agent: "build" as ToolContext["agent"] }, async () => {});
    // A context the plugin rebuilt from journaled data: the grader of its own operation runs in it ...
    await expect(runtime.withToolContext({ ...toolContext, agent: "rebuilt" as ToolContext["agent"] }, () => runtime.childRunner.run({
      parentSessionID: "parent", prompt: "rebuilt grading", onCreated: async () => {},
    }), { retain: false })).resolves.toEqual({ sessionID: "child", text: "verified result" });
    // ... but a later grader of that parent, outside any scope, still gets the real retained context.
    await expect(runtime.childRunner.run({ parentSessionID: "parent", prompt: "later grading", onCreated: async () => {} }))
      .resolves.toEqual({ sessionID: "child", text: "verified result" });
    expect(agents).toEqual(["rebuilt", "build"]);
  });

  it("bounds retained contexts and refuses evicted or unknown parent identities", async () => {
    const { runtime, toolContext, execute } = fixture();
    for (let i = 0; i < 501; i++) {
      await runtime.withToolContext({ ...toolContext, sessionID: `parent-${i}` as ToolContext["sessionID"] }, async () => {});
    }
    await expect(runtime.childRunner.run({ parentSessionID: "parent-0", prompt: "old", onCreated: async () => {} }))
      .rejects.toThrow("matching its parent");
    expect(execute).not.toHaveBeenCalled();
    await expect(runtime.childRunner.run({ parentSessionID: "parent-500", prompt: "latest", onCreated: async () => {} }))
      .resolves.toEqual({ sessionID: "child", text: "verified result" });
  });

  it("ignores progress rejection if the originating call settled concurrently", async () => {
    const { runtime, toolContext } = fixture();
    let progressStarted!: () => void;
    const started = new Promise<void>(resolve => { progressStarted = resolve; });
    let rejectProgress!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, reject) => { rejectProgress = reject; });
    const progress = vi.fn(() => { progressStarted(); return pending; });
    let child!: ReturnType<typeof runtime.childRunner.run>;
    await runtime.withToolContext({ ...toolContext, progress }, async () => {
      child = runtime.childRunner.run({ prompt: "work", onCreated: async () => {} });
      await started;
    });
    rejectProgress(new Error("Tool progress outside running call"));
    await expect(child).resolves.toEqual({ sessionID: "child", text: "verified result" });
    expect(progress).toHaveBeenCalledOnce();
  });

  it("propagates progress rejection while the originating call remains active", async () => {
    const { runtime, toolContext, context } = fixture();
    const error = new Error("progress failed");
    const progress = vi.fn(async () => { throw error; });
    await expect(runtime.withToolContext({ ...toolContext, progress }, () => runtime.childRunner.run({
      prompt: "work", onCreated: async () => {},
    }))).rejects.toBe(error);
    expect(progress).toHaveBeenCalledOnce();
    expect(context.session.interrupt).toHaveBeenCalledWith({ sessionID: "child" });
  });

  it("plugin disposal cancels active children and prevents further dispatch", async () => {
    const { runtime, toolContext, execute, context } = fixture();
    let ready!: () => void;
    const created = new Promise<void>(resolve => { ready = resolve; });
    execute.mockImplementationOnce(async (_input, context) => {
      await context.progress({ sessionID: "child", status: "running" });
      ready();
      await new Promise<void>((_resolve, reject) => context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true }));
      throw new Error("unreachable");
    });
    const result = runtime.withToolContext(toolContext, () => runtime.childRunner.run({ prompt: "work", onCreated: async () => {} }));
    const rejected = expect(result).rejects.toThrow();
    await created;
    await runtime.dispose();
    await rejected;
    expect(context.session.interrupt).toHaveBeenCalledWith({ sessionID: "child" }, undefined);
    await expect(runtime.childRunner.run({ parentSessionID: "parent", prompt: "later", onCreated: async () => {} })).rejects.toThrow();
  });

  it("interrupts the actual child when guard registration fails", async () => {
    const { runtime, toolContext, context } = fixture();
    const failure = new Error("could not capture baseline");
    await expect(runtime.withToolContext(toolContext, () => runtime.childRunner.run({
      prompt: "work", onCreated: async () => { throw failure; },
    }))).rejects.toBe(failure);
    expect(context.session.interrupt).toHaveBeenCalledWith({ sessionID: "child" });
  });

  describe("#167: a native background response (since OpenCode 2.3.0 every subagent result is running)", () => {
    const backgrounded = (status = "running", sessionID = "child") => async (_input: unknown, native: ToolContext) => {
      await native.progress({ sessionID: "child", status: "running" });
      return { output: { sessionID, status, output: `The subagent is working in the background (sessionID: ${sessionID})` } };
    };
    const serviceSpy = (order: string[] = []) => {
      const end = vi.fn((result: string) => { order.push(`end:${result}`); });
      const service = { start: vi.fn(() => ({ end })) } as unknown as NonNullable<ChildSessionRequest["service"]>;
      return { end, service };
    };
    // Shaped like the installed typings (SessionMessageUser / SessionMessageAssistant): tool calls are parts of the assistant
    // entry's `content`, and a step's end is its `finish` or `time.completed`.
    const user = (text: string) => ({ type: "user", text });
    const answer = (text: string, more: Record<string, unknown> = {}) =>
      ({ type: "assistant", content: [{ type: "text", text }], finish: "stop", time: { created: 1, completed: 2 }, ...more });
    const toolStep = (text: string, status = "completed") => ({
      type: "assistant", finish: "tool-calls", time: { created: 1, completed: 2 },
      content: [{ type: "text", text }, { type: "tool", id: "call-1", name: "read", state: { status }, time: { created: 1 } }],
    });

    it.each([
      { label: "a succeeded end marker", end: { type: "idle", outcome: "succeeded" } },
      { label: "an end marker without outcome", end: { type: "idle" } },
    ])("waits for its own running child, then returns the child's last assistant text ($label)", async ({ end: marker }) => {
      const { runtime, toolContext, execute, context } = fixture();
      const order: string[] = [];
      const { end, service } = serviceSpy(order);
      const onConfirmed = vi.fn(async () => {});
      execute.mockImplementationOnce(backgrounded());
      context.session.wait.mockImplementationOnce(async () => { order.push("wait"); });
      context.session.context.mockImplementationOnce(async () => {
        order.push("context");
        return [
          // An earlier round's failed end belongs to that round only.
          user("an earlier round"), answer("an earlier verdict"), { type: "idle", outcome: "failed" },
          user("inspect"), toolStep("Reading the diff"), answer("verified result"), marker,
        ];
      });
      await expect(runtime.withToolContext(toolContext, () => runtime.childRunner.run({
        prompt: "inspect", onCreated: async () => {}, onConfirmed, service,
      }))).resolves.toEqual({ sessionID: "child", text: "verified result" });
      expect(context.session.wait).toHaveBeenCalledExactlyOnceWith({ sessionID: "child" }, { signal: expect.any(AbortSignal) });
      expect(context.session.context).toHaveBeenCalledExactlyOnceWith({ sessionID: "child" }, { signal: expect.any(AbortSignal) });
      // The span reports "completed" once, after the child really completed.
      expect(order).toEqual(["wait", "context", "end:completed"]);
      expect(end).toHaveBeenCalledOnce();
      expect(onConfirmed).toHaveBeenCalledExactlyOnceWith("child");
      expect(context.session.interrupt).not.toHaveBeenCalled();
    });

    it.each([
      { label: "finish: stop", final: answer("the final verdict") },
      { label: "only time.completed", final: { type: "assistant", content: [{ type: "text", text: "the final verdict" }], time: { created: 3, completed: 4 } } },
    ])("an earlier tool-call step with text, then a completed final entry ($label): returns the final text only", async ({ final }) => {
      const { runtime, toolContext, execute, context } = fixture();
      execute.mockImplementationOnce(backgrounded());
      context.session.context.mockResolvedValueOnce([user("inspect"), toolStep("Draft: looks fine, checking one more file"), final]);
      await expect(runtime.withToolContext(toolContext, () => runtime.childRunner.run({
        prompt: "inspect", onCreated: async () => {},
      }))).resolves.toEqual({ sessionID: "child", text: "the final verdict" });
      expect(context.session.interrupt).not.toHaveBeenCalled();
    });

    it("a rejected wait fails the run and interrupts the child, without reading its history", async () => {
      const { runtime, toolContext, execute, context } = fixture();
      const { end, service } = serviceSpy();
      execute.mockImplementationOnce(backgrounded());
      context.session.wait.mockRejectedValueOnce(new Error("wait failed"));
      await expect(runtime.withToolContext(toolContext, () => runtime.childRunner.run({
        prompt: "inspect", onCreated: async () => {}, service,
      }))).rejects.toThrow("wait failed");
      expect(context.session.context).not.toHaveBeenCalled();
      expect(context.session.interrupt).toHaveBeenCalledWith({ sessionID: "child" });
      expect(end).toHaveBeenCalledExactlyOnceWith("error");
    });

    it("an abort during the wait fails the run with the abort reason and interrupts the child", async () => {
      const { runtime, toolContext, execute, context } = fixture();
      const { end, service } = serviceSpy();
      const deadline = new AbortController();
      let waitSignal: AbortSignal | undefined;
      execute.mockImplementationOnce(backgrounded());
      // A host whose wait settles normally once the call is aborted: the runner still checks its signal afterwards.
      context.session.wait.mockImplementationOnce(async (_input, options) => {
        waitSignal = options?.signal;
        deadline.abort(new Error("grader deadline"));
      });
      await expect(runtime.withToolContext(toolContext, () => runtime.childRunner.run({
        prompt: "inspect", signal: deadline.signal, onCreated: async () => {}, service,
      }))).rejects.toThrow("grader deadline");
      expect(waitSignal?.aborted).toBe(true);
      expect(context.session.context).not.toHaveBeenCalled();
      expect(context.session.interrupt).toHaveBeenCalledWith({ sessionID: "child" });
      expect(end).toHaveBeenCalledExactlyOnceWith("interrupted");
    });

    it("a wait that never settles and ignores its signal is still ended by an abort, and the child is interrupted", async () => {
      const { runtime, toolContext, execute, context } = fixture();
      const { end, service } = serviceSpy();
      const deadline = new AbortController();
      let waiting!: () => void;
      const waited = new Promise<void>((resolve) => { waiting = resolve; });
      execute.mockImplementationOnce(backgrounded());
      // `@opencode/plugin` up to 2.4.1: the promise adapter drops request options, so the host never sees the signal.
      context.session.wait.mockImplementationOnce(() => { waiting(); return new Promise<void>(() => {}); });
      const run = runtime.withToolContext(toolContext, () => runtime.childRunner.run({
        prompt: "inspect", signal: deadline.signal, onCreated: async () => {}, service,
      }));
      const rejected = expect(run).rejects.toThrow("grader deadline");
      await waited;
      expect(context.session.interrupt).not.toHaveBeenCalled();
      deadline.abort(new Error("grader deadline"));
      await rejected;
      expect(context.session.context).not.toHaveBeenCalled();
      expect(context.session.interrupt).toHaveBeenCalledWith({ sessionID: "child" });
      expect(end).toHaveBeenCalledExactlyOnceWith("interrupted");
    });

    it("a history read that never settles is ended by an abort too", async () => {
      const { runtime, toolContext, execute, context } = fixture();
      const { end, service } = serviceSpy();
      const deadline = new AbortController();
      let reading!: () => void;
      const read = new Promise<void>((resolve) => { reading = resolve; });
      execute.mockImplementationOnce(backgrounded());
      context.session.context.mockImplementationOnce(() => { reading(); return new Promise<unknown[]>(() => {}); });
      const run = runtime.withToolContext(toolContext, () => runtime.childRunner.run({
        prompt: "inspect", signal: deadline.signal, onCreated: async () => {}, service,
      }));
      const rejected = expect(run).rejects.toThrow("grader deadline");
      await read;
      deadline.abort(new Error("grader deadline"));
      await rejected;
      expect(context.session.interrupt).toHaveBeenCalledWith({ sessionID: "child" });
      expect(end).toHaveBeenCalledExactlyOnceWith("interrupted");
    });

    it.each([
      { label: "no history", history: [] },
      { label: "no assistant message", history: [user("inspect")] },
      { label: "only an earlier round's answer", history: [user("first"), answer("an earlier verdict"), user("inspect")] },
      { label: "an empty answer", history: [user("inspect"), answer("  ")] },
      { label: "a turn that ended in an error", history: [user("inspect"), answer('{"pass":tr', { finish: "error", error: { name: "APIError" } })] },
      // `session.wait` resolves for a run that failed or was interrupted too: its end marker says how it ended.
      { label: "an answer and a failed run", history: [user("inspect"), answer('{"pass":true,"reasons":[]}'),
        { type: "idle", outcome: "failed", error: { type: "provider", message: "overloaded" } }] },
      { label: "an answer and an interrupted run", history: [user("inspect"), answer('{"pass":true,"reasons":[]}'),
        { type: "idle", outcome: "interrupted" }] },
      // QA-2.1-18 (text alone is not an end): only the turn's newest assistant entry, completed and with text, is the answer.
      { label: "a draft before a tool call, then a final step without text", history: [user("inspect"),
        toolStep('Draft: {"pass":true,"reasons":[]} — let me confirm by reading X'),
        { type: "assistant", content: [{ type: "reasoning", text: "done reading" }], finish: "stop", time: { created: 3, completed: 4 } },
        { type: "idle", outcome: "succeeded" }] },
      { label: "a newest answer whose step did not end", history: [user("inspect"),
        { type: "assistant", content: [{ type: "text", text: '{"pass":true,"reasons":[]}' }], time: { created: 1 } }] },
      { label: "a newest answer whose step is still in a tool call", history: [user("inspect"),
        toolStep('{"pass":true,"reasons":[]}', "running")] },
      { label: "a newest answer that finished on an error (no error field)", history: [user("inspect"),
        answer('{"pass":true,"reasons":[]}', { finish: "error" })] },
    ])("a waited child with $label is not a verdict: throws and interrupts the child", async ({ history }) => {
      const { runtime, toolContext, execute, context } = fixture();
      const { end, service } = serviceSpy();
      execute.mockImplementationOnce(backgrounded());
      context.session.context.mockResolvedValueOnce(history);
      // A fresh child's failure keeps the plain message: the resume reasons are for resumes only.
      await expect(runtime.withToolContext(toolContext, () => runtime.childRunner.run({
        prompt: "inspect", onCreated: async () => {}, service,
      }))).rejects.toThrow(/verification cannot use a pending result$/);
      expect(context.session.wait).toHaveBeenCalledOnce();
      expect(context.session.interrupt).toHaveBeenCalledWith({ sessionID: "child" });
      expect(end).toHaveBeenCalledExactlyOnceWith("error");
    });

    it.each([
      { label: "failed", status: "failed", output: "", sessionID: "child" },
      { label: "aborted", status: "aborted", output: "", sessionID: "child" },
      { label: "timeout", status: "timeout", output: "", sessionID: "child" },
      { label: "error", status: "error", output: "", sessionID: "child" },
      { label: "completed without text", status: "completed", output: undefined, sessionID: "child" },
      { label: "running for another session", status: "running", output: "working", sessionID: "another" },
    ])("a $label result is final: throws without waiting and interrupts the child", async ({ status, output, sessionID }) => {
      const { runtime, toolContext, execute, context } = fixture();
      const { end, service } = serviceSpy();
      execute.mockImplementationOnce(async (_input, native) => {
        await native.progress({ sessionID: "child", status: "running" });
        return { output: { sessionID, status, output } };
      });
      await expect(runtime.withToolContext(toolContext, () => runtime.childRunner.run({
        prompt: "inspect", onCreated: async () => {}, service,
      }))).rejects.toThrow("cannot use a pending result");
      expect(context.session.wait).not.toHaveBeenCalled();
      expect(context.session.context).not.toHaveBeenCalled();
      expect(context.session.interrupt).toHaveBeenCalledWith({ sessionID: "child" });
      // A span ends once (the first end wins); the catch repeats "error" into the spy.
      expect(end).toHaveBeenNthCalledWith(1, "error");
      expect(end).not.toHaveBeenCalledWith("completed");
    });

    describe("a resume's result comes only from what its own run added (the previous turn's answer stays in the history)", () => {
      const stalePass = '{"pass":true,"reasons":[]}';
      // The resume reasons appended to the unchanged pending-result message.
      const NO_MARKER = "(resume: no history marker could be read before the run)";
      const MARKER_GONE = "(resume: the history marker is gone)";
      const NO_OWN_ANSWER = "(resume: no answer to this run's prompt after the marker)";
      const before = [
        { id: "m1", ...user("first round") }, { id: "m2", ...answer(stalePass) }, { id: "m3", type: "idle", outcome: "succeeded" },
      ];
      const resume = (runtime: ReturnType<typeof createV2Runtime>, toolContext: ToolContext, service?: NonNullable<ChildSessionRequest["service"]>) =>
        runtime.withToolContext(toolContext, () => runtime.childRunner.run({
          prompt: "continue", resumeSessionID: "child", onCreated: async () => {}, ...(service ? { service } : {}),
        }));

      it.each([
        { label: "unchanged (the old answer is still newest)", after: before },
        { label: "ended without taking the new prompt", after: [...before, { id: "m4", type: "idle", outcome: "succeeded" }] },
      ])("a history $label after the wait gives no verdict: throws and interrupts the child", async ({ after }) => {
        const { runtime, toolContext, execute, context } = fixture();
        const { end, service } = serviceSpy();
        execute.mockImplementationOnce(backgrounded());
        context.session.context.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
        await expect(resume(runtime, toolContext, service)).rejects.toThrow("cannot use a pending result");
        expect(context.session.wait).toHaveBeenCalledOnce();
        expect(context.session.context).toHaveBeenCalledTimes(2);
        expect(context.session.interrupt).toHaveBeenCalledWith({ sessionID: "child" });
        expect(end).toHaveBeenCalledExactlyOnceWith("error");
      });

      it("a new prompt and a new answer after the marker: returns the new answer, not the old one", async () => {
        const { runtime, toolContext, execute, context } = fixture();
        const order: string[] = [];
        const fresh = '{"pass":false,"reasons":["still broken"]}';
        context.session.get.mockImplementationOnce(async () => { order.push("get"); return { id: "child", parentID: "parent", agent: "fast" }; });
        context.session.context
          .mockImplementationOnce(async () => { order.push("context"); return before; })
          .mockImplementationOnce(async () => {
            order.push("context");
            // The host may put its subagent preamble line before the prompt: the entry contains the prompt.
            return [...before, { id: "m4", ...user("You are a subagent spawned by another session.\ncontinue") }, { id: "m5", ...answer(fresh) },
              { id: "m6", type: "idle", outcome: "succeeded" }];
          });
        execute.mockImplementationOnce(async (input, native) => { order.push("execute"); return backgrounded()(input, native); });
        context.session.wait.mockImplementationOnce(async () => { order.push("wait"); });
        await expect(resume(runtime, toolContext)).resolves.toEqual({ sessionID: "child", text: fresh });
        expect(order).toEqual(["get", "context", "execute", "wait", "context"]);
        expect(context.session.context).toHaveBeenNthCalledWith(1, { sessionID: "child" }, { signal: expect.any(AbortSignal) });
        expect(context.session.interrupt).not.toHaveBeenCalled();
      });

      it("an unreadable history before the run and a pending result: throws at once and interrupts the child", async () => {
        const { runtime, toolContext, execute, context } = fixture();
        const { end, service } = serviceSpy();
        execute.mockImplementationOnce(backgrounded());
        context.session.context.mockRejectedValueOnce(new Error("context unavailable"));
        await expect(resume(runtime, toolContext, service)).rejects.toThrow(`cannot use a pending result ${NO_MARKER}`);
        // Without a marker no answer can be told new, so the run is not waited for.
        expect(context.session.wait).not.toHaveBeenCalled();
        expect(context.session.context).toHaveBeenCalledOnce();
        expect(context.session.interrupt).toHaveBeenCalledWith({ sessionID: "child" });
        expect(end).toHaveBeenCalledExactlyOnceWith("error");
      });

      it("an unreadable history before the run and a foreground completed result: returns its output as before", async () => {
        const { runtime, toolContext, execute, context } = fixture();
        const onCreated = vi.fn(async () => {});
        context.session.context.mockRejectedValueOnce(new Error("context unavailable"));
        execute.mockImplementationOnce(async (_input, native) => {
          await native.progress({ sessionID: "child", status: "running" });
          return { output: { sessionID: "child", status: "completed", output: "resumed verdict" } };
        });
        await expect(runtime.withToolContext(toolContext, () => runtime.childRunner.run({
          prompt: "continue", resumeSessionID: "child", onCreated,
        }))).resolves.toEqual({ sessionID: "child", text: "resumed verdict" });
        expect(onCreated).toHaveBeenCalledExactlyOnceWith("child");
        expect(context.session.wait).not.toHaveBeenCalled();
        expect(context.session.context).toHaveBeenCalledOnce();
        expect(context.session.interrupt).not.toHaveBeenCalled();
      });

      it("a marker that is gone after the wait (compacted history) gives no verdict: throws and interrupts the child", async () => {
        const { runtime, toolContext, execute, context } = fixture();
        execute.mockImplementationOnce(backgrounded());
        context.session.context.mockResolvedValueOnce(before).mockResolvedValueOnce([
          { id: "c1", type: "compaction", status: "completed", summary: "earlier rounds" },
          { id: "m4", ...user("continue") }, { id: "m5", ...answer('{"pass":true,"reasons":[]}') },
        ]);
        await expect(resume(runtime, toolContext)).rejects.toThrow(`cannot use a pending result ${MARKER_GONE}`);
        expect(context.session.wait).toHaveBeenCalledOnce();
        expect(context.session.interrupt).toHaveBeenCalledWith({ sessionID: "child" });
      });

      it("an aborted read before the run fails the resume with the abort reason, before anything is sent", async () => {
        const { runtime, toolContext, execute, context } = fixture();
        const deadline = new AbortController();
        context.session.context.mockImplementationOnce(() => { deadline.abort(new Error("grader deadline")); return new Promise<unknown[]>(() => {}); });
        await expect(runtime.withToolContext(toolContext, () => runtime.childRunner.run({
          prompt: "continue", resumeSessionID: "child", signal: deadline.signal, onCreated: async () => {},
        }))).rejects.toThrow("grader deadline");
        expect(execute).not.toHaveBeenCalled();
      });

      it("an answer to another user entry after the marker (not this run's prompt) gives no result", async () => {
        const { runtime, toolContext, execute, context } = fixture();
        execute.mockImplementationOnce(backgrounded());
        context.session.context.mockResolvedValueOnce(before).mockResolvedValueOnce([
          ...before, { id: "m4", ...user("a prompt an earlier run left queued") }, { id: "m5", ...answer(stalePass) },
        ]);
        await expect(resume(runtime, toolContext)).rejects.toThrow(`cannot use a pending result ${NO_OWN_ANSWER}`);
        expect(context.session.interrupt).toHaveBeenCalledWith({ sessionID: "child" });
      });

      it("our run ended (interrupted) after taking our prompt; a later run's answer to another prompt is not ours", async () => {
        const { runtime, toolContext, execute, context } = fixture();
        execute.mockImplementationOnce(backgrounded());
        context.session.context.mockResolvedValueOnce(before).mockResolvedValueOnce([
          ...before, { id: "m4", ...user("continue") }, { id: "m5", type: "idle", outcome: "interrupted" },
          { id: "m6", ...user("something else") }, { id: "m7", ...answer(stalePass) }, { id: "m8", type: "idle", outcome: "succeeded" },
        ]);
        await expect(resume(runtime, toolContext)).rejects.toThrow(`cannot use a pending result ${NO_OWN_ANSWER}`);
        expect(context.session.interrupt).toHaveBeenCalledWith({ sessionID: "child" });
      });

      describe("a resume that repeats the previous turn's prompt", () => {
        const repeated = [
          { id: "m1", ...user("continue") }, { id: "m2", ...answer(stalePass) }, { id: "m3", type: "idle", outcome: "succeeded" },
        ];

        it("new entries after the marker: returns the new answer", async () => {
          const { runtime, toolContext, execute, context } = fixture();
          execute.mockImplementationOnce(backgrounded());
          context.session.context.mockResolvedValueOnce(repeated).mockResolvedValueOnce([
            ...repeated, { id: "m4", ...user("continue") }, { id: "m5", ...answer('{"pass":false,"reasons":["new"]}') },
          ]);
          await expect(resume(runtime, toolContext)).resolves.toEqual({ sessionID: "child", text: '{"pass":false,"reasons":["new"]}' });
        });

        it("a run that ended without taking the prompt: the identical earlier prompt and its answer give no result", async () => {
          const { runtime, toolContext, execute, context } = fixture();
          execute.mockImplementationOnce(backgrounded());
          context.session.context.mockResolvedValueOnce(repeated).mockResolvedValueOnce([
            ...repeated, { id: "m4", type: "idle", outcome: "succeeded" },
          ]);
          await expect(resume(runtime, toolContext)).rejects.toThrow(`cannot use a pending result ${NO_OWN_ANSWER}`);
          expect(context.session.interrupt).toHaveBeenCalledWith({ sessionID: "child" });
        });
      });

      describe("a history read before the run that outlasts RESUME_MARKER_TIMEOUT_MS (the executor's 30 s confirmation window)", () => {
        const slowMarker = () => {
          const f = fixture();
          f.context.session.context.mockImplementationOnce(() => new Promise<unknown[]>(() => {}));
          return { ...f, runtime: createV2Runtime(f.context as unknown as Plugin.Context, { resumeMarkerTimeoutMs: 20 }) };
        };

        it("goes on without a marker: a foreground completed result is returned as before", async () => {
          const { runtime, toolContext, execute, context } = slowMarker();
          execute.mockImplementationOnce(async (_input, native) => {
            await native.progress({ sessionID: "child", status: "running" });
            return { output: { sessionID: "child", status: "completed", output: "resumed verdict" } };
          });
          await expect(resume(runtime, toolContext)).resolves.toEqual({ sessionID: "child", text: "resumed verdict" });
          expect(execute).toHaveBeenCalledOnce();
          expect(context.session.interrupt).not.toHaveBeenCalled();
        });

        it("goes on without a marker: a pending result throws without waiting", async () => {
          const { runtime, toolContext, execute, context } = slowMarker();
          execute.mockImplementationOnce(backgrounded());
          await expect(resume(runtime, toolContext)).rejects.toThrow(`cannot use a pending result ${NO_MARKER}`);
          expect(context.session.wait).not.toHaveBeenCalled();
          expect(context.session.interrupt).toHaveBeenCalledWith({ sessionID: "child" });
        });
      });
    });
  });

  it("registers grader identity before model requests and always disposes the real session", async () => {
    const { runtime, context, toolContext, execute } = fixture();
    const cfg = { activePreset: "p", presets: { p: { medium: { model: "p/model", description: "", whenToUse: [] } } }, rules: [], defaultTier: "medium" } as RouterConfig;
    const wiring = createVerificationWiring({ client: runtime.client, childRunner: runtime.childRunner, directory: "/project", getConfig: () => cfg });
    const inFlight = new Set<string>();
    execute.mockImplementationOnce(async (_input, context) => {
      await context.progress({ sessionID: "child", status: "running" });
      expect(wiring.graderSessions.has("child")).toBe(true);
      expect(inFlight.has("child")).toBe(true);
      return { output: { sessionID: "child", status: "completed", output: "verified result" } };
    });
    await expect(runtime.withToolContext(toolContext, () => wiring.dispatchGrader({
      tier: "medium", system: "Judge the changes", prompt: "inspect", cwd: "/artifact",
    }, "parent", inFlight))).resolves.toEqual({ sessionID: "child", text: "verified result", model: "p/model" });
    expect(wiring.graderSessions.size).toBe(0);
    expect(inFlight.size).toBe(0);
    expect(context.session.interrupt).toHaveBeenCalledWith({ sessionID: "child" }, undefined);
    await wiring.disposeVerification();
  });

  it.each([
    { failure: false, retryWaitMs: 0 }, { failure: true, retryWaitMs: 0 },
    { failure: false, retryWaitMs: 7_000 }, { failure: true, retryWaitMs: 7_000 },
  ])("G8 grading without host retry events is unattributed, not intrinsic service (failure=$failure, retryWaitMs=$retryWaitMs)", async ({ failure, retryWaitMs }) => {
    const run = async (mode: "off" | "on" | "throw") => {
      const { runtime, context, toolContext, execute } = fixture();
      let now = 0;
      const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
      const lines: string[] = [];
      const sink = createV2Observations({ write: line => { lines.push(line); } });
      if (mode === "throw") sink.record = () => { throw new Error("observer"); };
      const cfg: RouterConfig = { activePreset: "p", presets: { p: { medium: { model: "p/model" } } }, rules: [], defaultTier: "medium" };
      const wiring = createVerificationWiring({ client: runtime.client, childRunner: runtime.childRunner, directory: "/project",
        getConfig: () => cfg, observations: mode === "off" ? undefined : sink });
      context.tool.list.mockImplementation(async () => { now += 200; return [{ id: "subagent", execute }]; });
      context.session.move.mockImplementation(async () => { now += 1_000; });
      context.session.interrupt.mockImplementation(async () => { now += 500; return { interrupted: true }; });
      execute.mockImplementation(async (_input, native) => {
        now += 800; // native child creation, before progress
        await native.progress({ sessionID: "child", status: "running" });
        now += 5; // first provider execution attempt
        now += retryWaitMs; // host-internal backoff: this host exposes no retry/attempt events
        now += 12; // remaining provider execution
        if (failure) throw new Error("grading failed");
        return { output: { sessionID: "child", status: "completed", output: "verified result" } };
      });
      try {
        const gate = wiring.buildGateDeps("parent", undefined, undefined, undefined, false, "parent", () => ({
          planId: "p1", taskId: "T1", attempt: 3, taskIds: ["T1"], phaseId: "p1", entryId: null, component: "verify", candidate: "b".repeat(40),
        }));
        const result = await runtime.withToolContext(toolContext, () => gate.checker.dispatchGrader({
          tier: "medium", system: "Judge the changes", prompt: "inspect", cwd: "/artifact",
        })).catch((error: unknown) => error instanceof Error ? error.message : String(error));
        sink.close();
        return { result, elapsed: now, moved: context.session.move.mock.calls.length, interrupted: context.session.interrupt.mock.calls.length,
          executes: execute.mock.calls.length, rows: mode === "on" ? servicePairs(lines) : [] };
      } finally { await wiring.disposeVerification(); sink.close(); clock.mockRestore(); }
    };
    const off = await run("off");
    for (const mode of ["on", "throw"] as const) {
      const { rows, ...effects } = await run(mode);
      const { rows: _offRows, ...original } = off;
      expect(effects).toEqual(original);
      if (mode === "on") {
        // Even a run with no actual retry is insufficient: progress alone cannot prove it.
        expect(rows.filter(r => r.spanKind === "service" && r.stage === "grading")).toEqual([]);
        expect(rows.filter(r => r.action === "end")).toMatchObject([
          { spanKind: "service-prep", stage: "grader-startup", durationMs: 2_000, result: "completed" },
          { spanKind: "service-unattributed", stage: "grading", durationMs: 17 + retryWaitMs, result: failure ? "error" : "completed",
            planId: "p1", taskId: "T1", attempt: 3, candidate: "b".repeat(40) },
        ]);
      }
    }
  });

  it("drives the shared verified-delegate path through native producer and grader children", async () => {
    const { runtime, context, toolContext, execute } = fixture();
    const cfg: RouterConfig = {
      activePreset: "p", presets: { p: {
        fast: { model: "p/fast", description: "", whenToUse: [], variant: "high" },
        medium: { model: "p/medium", description: "", whenToUse: [] },
        heavy: { model: "p/heavy", description: "", whenToUse: [] },
      } }, rules: [], defaultTier: "fast", experimental: { verifiedDelegateTool: true },
    };
    const load = vi.spyOn(routerConfig, "loadConfig").mockReturnValue(cfg);
    vi.stubEnv("MODEL_ROUTER_ENFORCE", "off");
    let sequence = 0;
    execute.mockImplementation(async (input, nativeContext) => {
      const args = input as { agent: string; model: string; prompt: string };
      const sessionID = `child-${++sequence}`;
      await nativeContext.progress({ sessionID, status: "running" });
      if (args.agent === "fast") {
        expect(args.model).toBe("p/fast#high");
        expect(args.prompt).toBe("Explain the implementation");
      } else {
        expect(args.agent).toBe(V2_GRADER_AGENT);
        const system: SessionContext["system"] = [];
        runtime.applyChildSystem(sessionID, system);
        expect(system.length).toBe(1);
      }
      return { output: { sessionID, status: "completed", output: args.agent === "fast"
        ? "The implementation satisfies the request."
        : '{"pass":true,"reasons":[]}' } };
    });
    const input = {
      client: runtime.client, directory: process.cwd(), worktree: process.cwd(),
      project: {}, serverUrl: new URL("http://unused.invalid"), $: () => {}, routerChildRunner: runtime.childRunner,
    } as unknown as RouterPluginInput;
    const hooks = await ModelRouterPlugin(input);
    try {
      const output = await runtime.withToolContext(toolContext, () => hooks.tool!.delegate.execute({
        task: "Explain the implementation", tier: "fast",
        acceptance: "[acceptance]\ncriteria: the explanation is correct\n[/acceptance]",
      }, { sessionID: "parent" } as never));
      expect(output).toContain("[router ✓ verified:");
      expect(sequence).toBe(2);
      expect(context.session.interrupt).toHaveBeenCalledWith({ sessionID: "child-1" }, undefined);
      expect(context.session.interrupt).toHaveBeenCalledWith({ sessionID: "child-2" }, undefined);
      expect(context.session.remove).toHaveBeenCalledWith({ sessionID: "child-1" });
      expect(context.session.remove).toHaveBeenCalledWith({ sessionID: "child-2" });
    } finally {
      await hooks.dispose?.();
      await runtime.dispose();
      load.mockRestore();
      vi.unstubAllEnvs();
    }
  }, 20_000); // runs the real delegate against the repository checkout (git snapshot): 0.8 s alone, over 5 s in a 70-file parallel run
});

describe("native v2 child runner: resuming a child (Phase 2.3, D11)", () => {
  it("R3-4. a superseded run's late rejection neither interrupts nor unregisters its resumed round", async () => {
    const { runtime, toolContext, execute, context } = fixture();
    let rejectOld!: (error: Error) => void;
    const late = new Promise<never>((_resolve, reject) => { rejectOld = reject; });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    let resumedSignal: AbortSignal | undefined;
    execute.mockImplementationOnce(async (_input, native) => {
      await native.progress({ sessionID: "child", status: "running" });
      ready();
      return late;
    });
    execute.mockImplementationOnce(async (_input, native) => {
      resumedSignal = native.signal;
      await gate;
      native.signal.throwIfAborted();
      return { output: { sessionID: "child", status: "completed", output: "done" } };
    });
    const old = runtime.withToolContext(toolContext, () => runtime.childRunner.run({
      prompt: "first", system: "old round", onCreated: async () => {},
    })).catch((error: unknown) => error);
    await started;
    const resumed = runtime.withToolContext(toolContext, () => runtime.childRunner.run({
      prompt: "continue", resumeSessionID: "child", system: "new round", onCreated: async () => {},
    })).catch((error: unknown) => error);
    try {
      await vi.waitFor(() => { expect(resumedSignal).toBeDefined(); });
      rejectOld(new Error("late rejection"));
      await old;
      expect(context.session.interrupt).not.toHaveBeenCalled();
      expect(resumedSignal?.aborted).toBe(false);
      const system: SessionContext["system"] = [];
      runtime.applyChildSystem("child", system);
      expect(system).toEqual([{ type: "text", text: "new round" }]);
      // A real client abort still finds the resumed controller: old.finally did not remove its registration.
      await runtime.client.session.abort({ path: { id: "child" } });
      expect(resumedSignal?.aborted).toBe(true);
    } finally {
      rejectOld(new Error("cleanup"));
      finish();
      await Promise.all([old, resumed]);
      await runtime.dispose();
    }
  });

  it.each(["failed", "aborted", "timeout"])("R2-2: a named %s result confirms the resumed attempt without progress", async (status) => {
    const { runtime, toolContext, execute } = fixture();
    const onConfirmed = vi.fn(async () => {});
    execute.mockResolvedValueOnce({ output: { sessionID: "child", status, output: "" } });
    await expect(runtime.withToolContext(toolContext, () => runtime.childRunner.run({
      prompt: "go", resumeSessionID: "child", onCreated: async () => {}, onConfirmed,
    }))).rejects.toThrow("completed child result");
    expect(onConfirmed).toHaveBeenCalledExactlyOnceWith("child");
  });
  it("sends sessionID with the new agent and model#variant, registers the child before the host runs it, and keeps its cwd", async () => {
    const { runtime, toolContext, execute, context } = fixture();
    const order: string[] = [];
    const onCreated = vi.fn(async (sessionID: string) => { order.push(`created:${sessionID}`); });
    const onConfirmed = vi.fn(async (sessionID: string) => { order.push(`confirmed:${sessionID}`); });
    execute.mockImplementationOnce(async (input, childContext) => {
      order.push("execute");
      expect(input).toEqual({
        agent: "medium", description: "Router medium delegation", prompt: "[router escalation] retry", sessionID: "child",
        model: "p/model#xhigh", background: false,
      });
      expect(childContext.sessionID).toBe("parent");
      await childContext.progress({ sessionID: "child", status: "running" });
      return { output: { sessionID: "child", status: "completed", output: "resumed result" } };
    });
    await expect(runtime.withToolContext(toolContext, () => runtime.childRunner.run({
      parentSessionID: "parent", agent: "medium", prompt: "[router escalation] retry", cwd: "/artifact",
      model: { providerID: "p", modelID: "model", variant: "xhigh" }, resumeSessionID: "child", onCreated, onConfirmed,
    }))).resolves.toEqual({ sessionID: "child", text: "resumed result" });
    expect(order).toEqual(["created:child", "execute", "confirmed:child"]);
    expect(onConfirmed).toHaveBeenCalledOnce();
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(context.session.get).toHaveBeenCalledWith({ sessionID: "child" }, { signal: expect.any(AbortSignal) });
    expect(context.session.move).not.toHaveBeenCalled();
  });

  it("a bare model and no variant resumes with a bare model ref", async () => {
    const { runtime, toolContext, execute } = fixture();
    const onConfirmed = vi.fn(async () => {});
    execute.mockImplementationOnce(async (input) => {
      expect(onConfirmed).not.toHaveBeenCalled();
      expect(input).toEqual({
        agent: "heavy", description: "Router heavy delegation", prompt: "go", sessionID: "child", model: "p/model", background: false,
      });
      return { output: { sessionID: "child", status: "completed", output: "ok" } };
    });
    await expect(runtime.withToolContext(toolContext, () => runtime.childRunner.run({
      parentSessionID: "parent", agent: "heavy", prompt: "go", model: { providerID: "p", modelID: "model" }, resumeSessionID: "child", onCreated: async () => {}, onConfirmed,
    }))).resolves.toEqual({ sessionID: "child", text: "ok" });
    expect(onConfirmed).toHaveBeenCalledExactlyOnceWith("child");
  });

  it("refuses a session that is not a child of the calling session before sending anything", async () => {
    const { runtime, toolContext, execute, context } = fixture();
    context.session.get.mockResolvedValueOnce({ id: "child", parentID: "someone-else", agent: "fast" });
    const onCreated = vi.fn(async () => {});
    const run = runtime.withToolContext(toolContext, () => runtime.childRunner.run({ prompt: "go", resumeSessionID: "child", onCreated }));
    await expect(run).rejects.toBeInstanceOf(ResumeRejectedError);
    await expect(run).rejects.toThrow("not a child of session parent");
    expect(execute).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
    expect(context.session.interrupt).not.toHaveBeenCalled();
  });

  it("refuses a missing session (lookup error) the same way, without interrupting it", async () => {
    const { runtime, toolContext, execute, context } = fixture();
    context.session.get.mockRejectedValueOnce(new Error("Session not found"));
    const onCreated = vi.fn(async () => {});
    await expect(runtime.withToolContext(toolContext, () => runtime.childRunner.run({ prompt: "go", resumeSessionID: "gone", onCreated })))
      .rejects.toMatchObject({ name: "ResumeRejectedError", sessionID: "gone" });
    expect(execute).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
    expect(context.session.interrupt).not.toHaveBeenCalled();
  });

  it("does not turn an aborted lookup into a resume rejection", async () => {
    const { runtime, toolContext, execute, context } = fixture();
    const cancelled = new AbortController();
    context.session.get.mockImplementationOnce(async () => { cancelled.abort(new Error("cancelled")); throw new Error("aborted lookup"); });
    await expect(runtime.withToolContext(toolContext, () => runtime.childRunner.run({
      prompt: "go", resumeSessionID: "child", signal: cancelled.signal, onCreated: async () => {},
    }))).rejects.toThrow("cancelled");
    expect(execute).not.toHaveBeenCalled();
  });

  it("a host that answers with another child id is an error and the resumed child is interrupted", async () => {
    const { runtime, toolContext, execute, context } = fixture();
    const onConfirmed = vi.fn(async () => {});
    execute.mockImplementationOnce(async (_input, childContext) => {
      await childContext.progress({ sessionID: "another", status: "running" });
      return { output: { sessionID: "another", status: "completed", output: "x" } };
    });
    await expect(runtime.withToolContext(toolContext, () => runtime.childRunner.run({
      prompt: "go", resumeSessionID: "child", onCreated: async () => {}, onConfirmed,
    }))).rejects.toMatchObject({ name: "ResumeRejectedError", sessionID: "child", message: expect.stringContaining("the host started another child (another) instead") });
    expect(context.session.interrupt).toHaveBeenCalledWith({ sessionID: "child" });
    // QA-2.3-5: the child the host started instead is stopped and removed too, not left running
    expect(context.session.interrupt).toHaveBeenCalledWith({ sessionID: "another" }, undefined);
    expect(context.session.remove).toHaveBeenCalledWith({ sessionID: "another" });
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it("rejects a stray resume result without progress, without confirming the original child", async () => {
    const { runtime, toolContext, execute, context } = fixture();
    const onConfirmed = vi.fn(async () => {});
    execute.mockImplementationOnce(async () => ({ output: { sessionID: "another", status: "completed", output: "x" } }));
    await expect(runtime.withToolContext(toolContext, () => runtime.childRunner.run({
      prompt: "go", resumeSessionID: "child", onCreated: async () => {}, onConfirmed,
    }))).rejects.toBeInstanceOf(ResumeRejectedError);
    expect(onConfirmed).not.toHaveBeenCalled();
    expect(context.session.remove).toHaveBeenCalledWith({ sessionID: "another" });
  });

  it("a foreign child that cannot be removed is named in the error instead of being swallowed", async () => {
    const { runtime, toolContext, execute, context } = fixture();
    execute.mockImplementationOnce(async (_input, childContext) => {
      await childContext.progress({ sessionID: "another", status: "running" });
      return { output: { sessionID: "another", status: "completed", output: "x" } };
    });
    context.session.remove.mockRejectedValueOnce(new Error("session is busy"));
    await expect(runtime.withToolContext(toolContext, () => runtime.childRunner.run({
      prompt: "go", resumeSessionID: "child", onCreated: async () => {},
    }))).rejects.toThrow("removing it failed (session is busy)");
    expect(context.session.interrupt).toHaveBeenCalledWith({ sessionID: "child" });
  });

  it("QA-2.3-R2-3: a removal the host never finishes does not hang the delegation; a resume still ends as a rejection the caller retries fresh", async () => {
    vi.useFakeTimers();
    try {
      const { runtime, toolContext, execute, context } = fixture();
      execute.mockImplementationOnce(async (_input, childContext) => {
        await childContext.progress({ sessionID: "another", status: "running" });
        return { output: { sessionID: "another", status: "completed", output: "x" } };
      });
      context.session.remove.mockImplementationOnce(() => new Promise<void>(() => undefined)); // never settles
      const outcome = runtime.withToolContext(toolContext, () => runtime.childRunner.run({
        prompt: "go", resumeSessionID: "child", onCreated: async () => {},
      })).then(() => ({ error: undefined as unknown }), (error: unknown) => ({ error }));
      let settled = false;
      void outcome.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(STRAY_CLEANUP_TIMEOUT_MS - 1);
      expect(settled).toBe(false); // still bounded, not yet over
      await vi.advanceTimersByTimeAsync(2);
      const { error } = await outcome;
      expect(error).toBeInstanceOf(ResumeRejectedError);
      expect((error as Error).message).toContain(`removing it did not finish within ${STRAY_CLEANUP_TIMEOUT_MS} ms`);
      expect(context.session.interrupt).toHaveBeenCalledWith({ sessionID: "child" });
      expect(vi.getTimerCount()).toBe(0); // the bound's timer is cleared
    } finally {
      vi.useRealTimers();
    }
  });

  it("the host's own wrapping of the progress error cannot hide the rejection (the caller tests its type)", async () => {
    const { runtime, toolContext, execute } = fixture();
    execute.mockImplementationOnce(async (_input, childContext) => {
      try {
        await childContext.progress({ sessionID: "another", status: "running" });
      } catch (error) {
        throw new Error(`ToolFailure: ${error instanceof Error ? error.message : String(error)}`);
      }
      return { output: { sessionID: "another", status: "completed", output: "x" } };
    });
    await expect(runtime.withToolContext(toolContext, () => runtime.childRunner.run({
      prompt: "go", resumeSessionID: "child", onCreated: async () => {},
    }))).rejects.toBeInstanceOf(ResumeRejectedError);
  });

  it("a hanging removal also leaves a created child's error bounded, as a plain error", async () => {
    vi.useFakeTimers();
    try {
      const { runtime, toolContext, execute, context } = fixture();
      execute.mockImplementationOnce(async (_input, childContext) => {
        await childContext.progress({ sessionID: "first", status: "running" });
        await childContext.progress({ sessionID: "second", status: "running" });
        return { output: { sessionID: "second", status: "completed", output: "x" } };
      });
      context.session.remove.mockImplementationOnce(() => new Promise<void>(() => undefined));
      const outcome = runtime.withToolContext(toolContext, () => runtime.childRunner.run({ prompt: "go", onCreated: async () => {} }))
        .then(() => ({ error: undefined as unknown }), (error: unknown) => ({ error }));
      await vi.advanceTimersByTimeAsync(STRAY_CLEANUP_TIMEOUT_MS + 1);
      const { error } = await outcome;
      expect(error).not.toBeInstanceOf(ResumeRejectedError);
      expect((error as Error).message).toContain("changed its child session ID (first -> second; removing it did not finish");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a created child that changes its id is handled the same way (not only a resume)", async () => {
    const { runtime, toolContext, execute, context } = fixture();
    execute.mockImplementationOnce(async (_input, childContext) => {
      await childContext.progress({ sessionID: "first", status: "running" });
      await childContext.progress({ sessionID: "second", status: "running" });
      return { output: { sessionID: "second", status: "completed", output: "x" } };
    });
    await expect(runtime.withToolContext(toolContext, () => runtime.childRunner.run({ prompt: "go", onCreated: async () => {} })))
      .rejects.toThrow("changed its child session ID (first -> second)");
    expect(context.session.remove).toHaveBeenCalledWith({ sessionID: "second" });
    expect(context.session.interrupt).toHaveBeenCalledWith({ sessionID: "first" });
  });

  it("a deadline or cancellation interrupts the resumed child", async () => {
    const { runtime, toolContext, execute, context } = fixture();
    const deadline = new AbortController();
    execute.mockImplementationOnce(async (_input, childContext) => {
      await childContext.progress({ sessionID: "child", status: "running" });
      deadline.abort(new Error("deadline"));
      childContext.signal.throwIfAborted();
      throw new Error("unreachable");
    });
    await expect(runtime.withToolContext(toolContext, () => runtime.childRunner.run({
      prompt: "go", resumeSessionID: "child", signal: deadline.signal, onCreated: async () => {},
    }))).rejects.toThrow("deadline");
    expect(context.session.interrupt).toHaveBeenCalledWith({ sessionID: "child" });
  });

  it("plugin disposal cancels a resumed child that has not yet reported progress", async () => {
    const { runtime, toolContext, execute, context } = fixture();
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    execute.mockImplementationOnce(async (_input, childContext) => {
      ready();
      await new Promise<void>((_resolve, reject) => childContext.signal.addEventListener("abort", () => reject(childContext.signal.reason), { once: true }));
      throw new Error("unreachable");
    });
    const result = runtime.withToolContext(toolContext, () => runtime.childRunner.run({ prompt: "go", resumeSessionID: "child", onCreated: async () => {} }));
    const rejected = expect(result).rejects.toThrow();
    await started;
    await runtime.dispose();
    await rejected;
    expect(context.session.interrupt).toHaveBeenCalledWith({ sessionID: "child" }, undefined);
  });

  it("a resume with a failing registration callback interrupts the child and surfaces the error", async () => {
    const { runtime, toolContext, execute, context } = fixture();
    const failure = new Error("could not register the guard");
    await expect(runtime.withToolContext(toolContext, () => runtime.childRunner.run({
      prompt: "go", resumeSessionID: "child", onCreated: async () => { throw failure; },
    }))).rejects.toBe(failure);
    expect(execute).not.toHaveBeenCalled();
    expect(context.session.interrupt).toHaveBeenCalledWith({ sessionID: "child" });
  });

  it("applies the grader system prompt to a resumed child and drops it afterwards", async () => {
    const { runtime, toolContext, execute } = fixture();
    execute.mockImplementationOnce(async () => {
      const system: SessionContext["system"] = [];
      runtime.applyChildSystem("child", system);
      expect(system).toEqual([{ type: "text", text: "Grade" }]);
      return { output: { sessionID: "child", status: "completed", output: "ok" } };
    });
    await runtime.withToolContext(toolContext, () => runtime.childRunner.run({
      prompt: "go", system: "Grade", resumeSessionID: "child", onCreated: async () => {},
    }));
    const after: SessionContext["system"] = [];
    runtime.applyChildSystem("child", after);
    expect(after).toEqual([]);
  });
});
