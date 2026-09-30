import { describe, expect, it, vi } from "vitest";
import type { Plugin } from "@opencode/plugin";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import type { SessionContext } from "@opencode/plugin/promise/session";
import { createV2Runtime, V2_GRADER_AGENT } from "../../src/compat/v2-client";
import { createVerificationWiring } from "../../src/verify/wiring";
import type { RouterConfig } from "../../src/router/config";
import * as routerConfig from "../../src/router/config";
import ModelRouterPlugin from "../../src/index";
import type { RouterPluginInput } from "../../src/compat/child-session";

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
      providers: [{ id: "p", name: "Provider", models: { "aliased-model": { id: "aliased-model", status: "active" } } }],
      default: { p: "aliased-model" },
    } });
    for (const method of [context.provider.list, context.model.list, context.model.default]) {
      expect(method).toHaveBeenCalledWith({ location: { directory: "/project" } });
    }
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
    }, "parent", inFlight))).resolves.toEqual({ sessionID: "child", text: "verified result" });
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
    } finally {
      await hooks.dispose?.();
      await runtime.dispose();
      load.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
