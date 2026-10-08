import { describe, expect, it, vi } from "vitest";
import type { Plugin } from "@opencode/plugin";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import type { SessionContext } from "@opencode/plugin/promise/session";
import { createV2Runtime, STRAY_CLEANUP_TIMEOUT_MS, V2_GRADER_AGENT } from "../../src/compat/v2-client";
import { createVerificationWiring } from "../../src/verify/wiring";
import type { RouterConfig } from "../../src/router/config";
import * as routerConfig from "../../src/router/config";
import ModelRouterPlugin from "../../src/index";
import { ResumeRejectedError, type RouterPluginInput } from "../../src/compat/child-session";

function fixture() {
  const execute = vi.fn(async (_input: unknown, context: ToolContext) => {
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

  it("rejects a native background response rather than verifying unfinished work", async () => {
    const { runtime, toolContext, execute, context } = fixture();
    execute.mockImplementationOnce(async (_input, context) => {
      await context.progress({ sessionID: "child", status: "running" });
      return { output: { sessionID: "child", status: "running", output: "still working" } };
    });
    await expect(runtime.withToolContext(toolContext, () => runtime.childRunner.run({
      prompt: "work", onCreated: async () => {},
    }))).rejects.toThrow("cannot use a pending result");
    expect(context.session.interrupt).toHaveBeenCalledWith({ sessionID: "child" });
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
