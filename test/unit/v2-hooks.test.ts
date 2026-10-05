import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { Hooks } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { registerV2Hooks, v2Instructions } from "../../src/compat/v2-hooks";
import ModelRouterPlugin from "../../src/index";
import { invalidateConfigCache, loadConfig } from "../../src/router/config";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { GRADER_SYSTEM } from "../../src/verify/checker";
import { V2_GRADER_AGENT } from "../../src/compat/v2-client";
import { DEPTH_BANNER, TASK_VERIFICATION, type ChildSessionRequest, type RouterPluginInput } from "../../src/compat/child-session";
import { depthAdvisoryBanner, depthLimitMessage } from "../../src/router/depth-guard";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllEnvs();
  invalidateConfigCache();
});

function fixture() {
  const registrations: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];
  const sessionHooks: Record<string, (event: any) => Promise<void>> = {};
  const toolHooks: Record<string, (event: any) => Promise<void>> = {};
  const agents: Record<string, any> = {
    explore: { id: "explore", mode: "subagent", model: { providerID: "old", id: "old" }, permissions: [{ action: "write", effect: "deny" }], request: { settings: {}, headers: {}, body: {} } },
    build: { id: "build", mode: "primary", request: { settings: {}, headers: {}, body: {} } },
  };
  const commands: Record<string, any> = {};
  const tools: Record<string, any> = {};
  const transforms: Record<string, (editor: any) => void> = {};
  const register = () => { const value = { dispose: vi.fn(async () => {}) }; registrations.push(value); return value; };
  const editors = {
    agent: { update: (id: string, apply: (agent: any) => void) => { agents[id] ??= { id, mode: "primary", request: { settings: {}, headers: {}, body: {} } }; apply(agents[id]); } },
    command: { add: (command: any) => { commands[command.name] = command; } },
    tool: { add: (definition: any) => { tools[definition.name] = definition; } },
  };
  const eventQueue: any[] = [];
  let wake = () => {};
  const ctx = {
    location: { directory: "/project", project: { directory: "/project" } },
    agent: { list: vi.fn(async () => ({ data: Object.values(agents) })), transform: vi.fn(async (cb: any) => { transforms.agent = cb; cb(editors.agent); return register(); }) },
    command: { transform: vi.fn(async (cb: any) => { transforms.command = cb; cb(editors.command); return register(); }) },
    tool: {
      transform: vi.fn(async (cb: any) => { transforms.tool = cb; cb(editors.tool); return register(); }),
      hook: vi.fn(async (name: string, cb: any) => { toolHooks[name] = cb; return register(); }),
    },
    session: {
      get: vi.fn(async () => ({ id: "child", parentID: "root", agent: "fast" })),
      context: vi.fn(async () => [] as any[]),
      prompt: vi.fn(async () => {}), synthetic: vi.fn(async () => {}),
      hook: vi.fn(async (name: string, cb: any) => { sessionHooks[name] = cb; return register(); }),
    },
    event: { subscribe: async function* ({ signal }: { signal: AbortSignal }) {
      signal.addEventListener("abort", () => wake(), { once: true });
      while (!signal.aborted) {
        if (eventQueue.length) yield eventQueue.shift();
        else await new Promise<void>((resolve) => { wake = resolve; });
      }
    } },
  };
  return {
    ctx, agents, commands, tools, transforms, editors, sessionHooks, toolHooks, registrations,
    emit(event: any) { eventQueue.push(event); wake(); },
    async start(hooks: Record<string, any> = {}, runtime?: any) {
      const cleanup = await registerV2Hooks(ctx as unknown as Context, hooks as Hooks, runtime);
      cleanups.push(cleanup);
      return cleanup;
    },
  };
}

const call = { sessionID: "child", agent: "fast", messageID: "message", id: "call" };

describe("OpenCode 2 hook adapter", () => {
  async function depthFixture(mode: "enforced" | "advisory", run?: (request: ChildSessionRequest) => Promise<{ sessionID: string; text: string }>) {
    const home = mkdtempSync(join(tmpdir(), "router-v2-depth-"));
    vi.stubEnv("HOME", home); vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("MODEL_ROUTER_ENFORCE", mode === "enforced" ? "1" : "");
    vi.stubEnv("MODEL_ROUTER_VERIFIED_DELEGATE", "1");
    invalidateConfigCache();
    const f = fixture();
    const get = vi.fn(async ({ path }: { path: { id: string } }) => ({ data: { id: path.id } }));
    const hooks = await ModelRouterPlugin({
      directory: home, worktree: home, routerHost: "v2",
      client: { session: { get } },
      ...(run ? { routerChildRunner: { run, dispose: async () => undefined } } : {}),
    } as unknown as RouterPluginInput);
    const lifecycle = vi.fn(async (input: Parameters<NonNullable<Hooks["event"]>>[0]) => { await hooks.event?.(input); });
    await f.start({ ...hooks, event: lifecycle });
    cleanups.push(async () => { rmSync(home, { recursive: true, force: true }); });
    f.emit({ type: "session.created", data: { sessionID: "root" } });
    f.emit({ type: "session.created", data: { sessionID: "child", parentID: "root" } });
    await vi.waitFor(() => expect(lifecycle).toHaveBeenCalledTimes(2));
    return { ...f, get };
  }

  const depthCall = (id = "call") => ({ ...call, id, tool: "subagent", input: { agent: "fast", prompt: "Inspect the project" } });
  const depthResult = (id = "call", status = "completed", text = "Done") => ({
    ...depthCall(id), status: "completed",
    result: { output: { status, output: text }, content: text },
  });

  it.each([{}, { background: true }, { sessionID: "previous" }])("propagates the real D5 refusal for dispatch options %j without mutating native input", async (options) => {
    const f = await depthFixture("enforced");
    const event = { ...depthCall(), input: { ...depthCall().input, ...options } };
    const original = { ...event.input };
    await expect(f.toolHooks["execute.before"](event)).rejects.toThrow(depthLimitMessage(1, 1));
    expect(event.input).toEqual(original);
    // These lifecycle facts, including parentID, seeded recordCreated: no backend lookup.
    expect(f.get).not.toHaveBeenCalled();
    const after = depthResult();
    await f.toolHooks["execute.after"](after);
    expect(after.result.output.output).toBe("Done");
  });

  it.each(["completed", "running"])("delivers the real advisory banner exactly once on a %s result", async (status) => {
    const f = await depthFixture("advisory");
    await f.toolHooks["execute.before"](depthCall());
    const after = depthResult("call", status);
    await f.toolHooks["execute.after"](after);
    expect(after.result.output.output.match(/GUARD:delegation_depth/g)).toHaveLength(1);
    expect(after.result.output.output).toContain(depthAdvisoryBanner(1, 1));
    expect(JSON.stringify(after.result.content).match(/GUARD:delegation_depth/g)).toHaveLength(1);
    await f.toolHooks["execute.after"](after);
    expect(after.result.output.output.match(/GUARD:delegation_depth/g)).toHaveLength(1);
    const replay = depthResult("call", status);
    await f.toolHooks["execute.after"](replay);
    expect(replay.result.output.output).toBe("Done");
    expect(f.get).not.toHaveBeenCalled();
  });

  it.each(["failed", "error", "interrupted"])("drops the advisory banner after a %s event, including replay", async (status) => {
    const f = await depthFixture("advisory");
    await f.toolHooks["execute.before"](depthCall());
    const failed = { ...depthResult(), status };
    await f.toolHooks["execute.after"](failed);
    expect(failed.result.output.output).toBe("Done");
    const replay = depthResult();
    await f.toolHooks["execute.after"](replay);
    expect(replay.result.output.output).toBe("Done");
    await f.toolHooks["execute.before"](depthCall("next"));
    const next = depthResult("next");
    await f.toolHooks["execute.after"](next);
    expect(next.result.output.output.match(/GUARD:delegation_depth/g)).toHaveLength(1);
  });

  it.each(["enforced", "advisory"] as const)("judges a v2 childRunner grader's own task by its recorded depth in %s mode", async (mode) => {
    let f: Awaited<ReturnType<typeof depthFixture>>;
    let count = 0;
    let graders = 0;
    const run = vi.fn(async (request: ChildSessionRequest) => {
      const sid = `grader-child-${count++}`;
      await request.onCreated(sid);
      if (request.system !== undefined) {
        graders++;
        const event = { ...depthCall("grader-task"), sessionID: sid };
        if (mode === "enforced") await expect(f.toolHooks["execute.before"](event)).rejects.toThrow(depthLimitMessage(1, 1));
        else {
          await f.toolHooks["execute.before"](event);
          const after = { ...depthResult("grader-task"), sessionID: sid };
          await f.toolHooks["execute.after"](after);
          expect(after.result.output.output.match(/GUARD:delegation_depth/g)).toHaveLength(1);
        }
        expect(f.get.mock.calls.some(([req]) => req.path.id === sid)).toBe(false);
      }
      return { sessionID: sid, text: '{"pass":true,"reasons":[]}' };
    });
    f = await depthFixture(mode, run);
    const result = await f.tools.delegate.execute({ tier: "fast", task: "VERIFY:required\nDo the work", acceptance: "[acceptance]\ncriteria: correct\n[/acceptance]" }, {
      ...call, sessionID: "root", signal: new AbortController().signal, progress: vi.fn(async () => undefined),
    });
    expect(graders).toBe(1);
    expect(result.content).toContain("[router ✓ verified:");
  });

  it("evicts the oldest banner above 1000 pending calls and refreshes repeated IDs", async () => {
    const f = fixture();
    await f.start({ "tool.execute.before": async (_: unknown, output: Record<PropertyKey, unknown>) => { output[DEPTH_BANNER] = "banner"; } });
    for (let i = 0; i < 1000; i++) await f.toolHooks["execute.before"](depthCall(`call-${i}`));
    await f.toolHooks["execute.before"](depthCall("call-0"));
    await f.toolHooks["execute.before"](depthCall("call-1000"));
    for (const [id, expected] of [["call-1", "Done"], ["call-0", "Done\n\nbanner"], ["call-1000", "Done\n\nbanner"]]) {
      const after = depthResult(id);
      await f.toolHooks["execute.after"](after);
      expect(after.result.output.output).toBe(expected);
    }
  });

  it("combines the verification notice and banner on a background acknowledgement without grading", async () => {
    const f = fixture(); const afterHook = vi.fn();
    await f.start({
      "tool.execute.before": async (_: unknown, output: Record<PropertyKey, unknown>) => {
        output[DEPTH_BANNER] = "banner"; output[TASK_VERIFICATION] = true;
      },
      "tool.execute.after": afterHook,
    });
    await f.toolHooks["execute.before"](depthCall());
    const after = depthResult("call", "running");
    await f.toolHooks["execute.after"](after);
    expect(after.result.output.output).toContain("has not been verified");
    expect(after.result.output.output.endsWith("\n\nbanner")).toBe(true);
    expect(afterHook).not.toHaveBeenCalled();
  });

  it.each(["", "retained Task(subagent_type=fast)  "])("appends a banner after legacy changes and preserves source text: %j", async (text) => {
    const f = fixture();
    await f.start({
      "tool.execute.before": async (_: unknown, output: Record<PropertyKey, unknown>) => { output[DEPTH_BANNER] = "banner"; },
      "tool.execute.after": async (_: unknown, output: { output: string }) => {
        expect(output.output).not.toContain("banner");
        if (text) output.output += "\n[router] Use task_id next";
      },
    });
    await f.toolHooks["execute.before"](depthCall());
    const after = { ...depthCall(), status: "completed", result: { output: text, content: text } };
    await f.toolHooks["execute.after"](after);
    expect(after.result.output).toBe(text ? `${text}\n[router] Use sessionID next\n\nbanner` : "banner");
  });

  it.each([true, false])("preserves native registration option precedence (native keys present: %s)", async (native) => {
    const f = fixture();
    const thinking = { type: "disabled" };
    const options = {
      reasoning_effort: "high", reasoning_summary: "auto", budget_tokens: 2000,
      ...(native ? { reasoningEffort: "low", reasoningSummary: "concise", thinking } : {}),
    };
    await f.start({ config: async (config: { agent: Record<string, unknown> }) => { config.agent.fast = { options }; } });
    const event = { ...call, model: { providerID: "p", id: "m" }, options: {}, system: [] };
    await f.sessionHooks.context(event);
    expect(event.options).toEqual(native
      ? { reasoningEffort: "low", reasoningSummary: "concise", thinking }
      : { reasoningEffort: "high", reasoningSummary: "auto", thinking: { type: "enabled", budgetTokens: 2000 } });
    expect(event.options).not.toHaveProperty("options");
  });

  it("maps tier models, variants, prompts, limits and provider options while preserving existing permissions", async () => {
    const f = fixture();
    await f.start({ config: async (config: any) => {
      config.agent.fast = { mode: "subagent", model: "openai/org/model", variant: "high", prompt: 'Task(subagent_type="fast")', steps: 12, options: { reasoning_effort: "high", reasoning_summary: "auto" } };
      config.agent.explore.model = "anthropic/claude";
      config.agent.explore.options = { budget_tokens: 2000 };
    } });
    expect(f.agents.fast).toMatchObject({ mode: "subagent", steps: 12, system: 'subagent(agent="fast")', model: { providerID: "openai", id: "org/model", variant: "high" } });
    expect(f.agents.explore).toMatchObject({ permissions: [{ action: "write", effect: "deny" }] });
    expect(f.agents.fast.request.settings).toEqual({});
    expect(f.agents.explore.request.settings).toEqual({});
    for (const [agent, expected] of Object.entries({
      fast: { reasoningEffort: "high", reasoningSummary: "auto" },
      explore: { thinking: { type: "enabled", budgetTokens: 2000 } },
      build: {},
    })) {
      const event = { ...call, agent, model: { providerID: "openai", id: "org/model" }, options: {}, system: [] };
      await f.sessionHooks.context(event);
      expect(event.options).toEqual(expected);
    }
    f.transforms.agent(f.editors.agent);
    expect(f.agents.explore.permissions).toHaveLength(1);
    expect(f.agents.build).not.toHaveProperty("model");
  });

  it("executes registered commands through prompt admission with attachments and delivery intact", async () => {
    const f = fixture();
    await f.start({
      config: async (config: any) => { config.command.preset = { template: "$ARGUMENTS", description: "Switch preset" }; },
      "command.execute.before": async (input: any, output: any) => { expect(input.arguments).toBe("openai"); output.parts.push({ type: "text", text: "Selected openai" }); },
    });
    await f.commands.preset.execute({ sessionID: "root", prompt: { text: "openai", files: [{ uri: "file:///note" }] }, delivery: "steer" });
    expect(f.ctx.session.prompt).toHaveBeenCalledWith({ sessionID: "root", text: "openai\n\nSelected openai", files: [{ uri: "file:///note" }], delivery: "steer" });
  });

  it("classifies prompt sessions by their actual agent and preserves prompt edits", async () => {
    const f = fixture();
    const hook = vi.fn(async (_: any, output: any) => { output.parts[0].text += " [cap:2]"; });
    await f.start({ "chat.message": hook });
    const event = { ...call, prompt: { text: "Read a file", files: [{ uri: "file:///file" }] } };
    await f.sessionHooks.prompt(event);
    expect(hook.mock.calls[0][0]).toEqual({ sessionID: "child", agent: "fast" });
    expect(event.prompt.text).toBe("Read a file [cap:2]");
    expect(event.prompt.files).toHaveLength(1);
  });

  it("adapts system text and generation options without losing untouched cache metadata", async () => {
    const f = fixture();
    const runtime = { withToolContext: (_: any, run: any) => run(), applyChildSystem: vi.fn((_: any, system: any[]) => system.push({ type: "text", text: "grader only" })) };
    await f.start({
      "chat.params": async (_: any, output: any) => { output.temperature = 0; },
      "experimental.chat.system.transform": async (input: any, output: any) => { expect(input.model.modelID).toBe("model"); output.system.push('Use Task(subagent_type="fast", task_id="id")'); },
    }, runtime);
    const event = { ...call, model: { providerID: "provider", id: "model" }, options: {}, system: [{ type: "text", text: "original", cache: { type: "ephemeral" }, metadata: { owner: "host" } }] };
    await f.sessionHooks.context(event);
    expect(event.options).toEqual({ temperature: 0 });
    expect(event.system[0]).toEqual({ type: "text", text: "original", cache: { type: "ephemeral" }, metadata: { owner: "host" } });
    expect(event.system[1].text).toBe('Use subagent(agent="fast", sessionID="id")');
    expect(event.system[2].text).toBe("grader only");
  });

  it("repairs native subagent arguments without overriding unverified background requests", async () => {
    const f = fixture();
    await f.start({ "tool.execute.before": async (input: any, output: any) => {
      expect(input.tool).toBe("task"); expect(input.callID).toBe("call");
      expect(output.args.subagent_type).toBe("fast"); expect(output.args.task_id).toBe("previous");
      output.args.prompt = "[router] " + output.args.description;
    } });
    const event = { ...call, tool: "subagent", input: { agent: "fast", description: "Read files", sessionID: "previous", background: true } };
    await f.toolHooks["execute.before"](event);
    expect(event.input).toEqual({ agent: "fast", description: "Read files", sessionID: "previous", prompt: "[router] Read files", background: true });
  });

  it("does not add a background argument to unverified calls", async () => {
    const f = fixture(); await f.start();
    const event = { ...call, tool: "subagent", input: { agent: "fast", prompt: "work" } };
    await f.toolHooks["execute.before"](event);
    expect(event.input).not.toHaveProperty("background");
  });

  it("forces foreground execution only when the legacy hook marks verification", async () => {
    const f = fixture();
    await f.start({ "tool.execute.before": async (_: unknown, output: Record<PropertyKey, unknown>) => { output[TASK_VERIFICATION] = true; } });
    const event = { ...call, tool: "subagent", input: { agent: "fast", prompt: "work", background: true } };
    await f.toolHooks["execute.before"](event);
    expect(event.input.background).toBe(false);
  });

  it("propagates enforcement blocks instead of executing a denied native tool", async () => {
    const f = fixture();
    await f.start({ "tool.execute.before": async () => { throw new Error("read budget exceeded"); } });
    await expect(f.toolHooks["execute.before"]({ ...call, tool: "read", input: { filePath: "x" } })).rejects.toThrow("read budget exceeded");
  });

  it("keeps attachments and structured subagent output when appending verification results", async () => {
    const f = fixture();
    await f.start({ "tool.execute.after": async (input: any, output: any) => {
      expect(input).toMatchObject({ tool: "task", args: { subagent_type: "fast" }, callID: "call" });
      expect(output.metadata.sessionID).toBe("child"); output.output += "\nVerified";
    } });
    const file = { type: "file", uri: "file:///result", mime: "text/plain" };
    const event = { ...call, tool: "subagent", input: { agent: "fast" }, status: "completed", result: { output: { sessionID: "child", status: "completed", output: "Result" }, content: [{ type: "text", text: "Result" }, file], metadata: { sessionID: "child" } } };
    await f.toolHooks["execute.after"](event);
    expect(event.result.output.output).toBe("Result\nVerified");
    expect(event.result.content).toEqual([{ type: "text", text: "Result\nVerified" }, file]);
  });

  it("does not grade failed tool execution as a completed return", async () => {
    const f = fixture(); const after = vi.fn();
    await f.start({ "tool.execute.after": after });
    await f.toolHooks["execute.after"]({ ...call, tool: "subagent", status: "error", error: new Error("failed") });
    expect(after).not.toHaveBeenCalled();
  });

  it("never grades a subagent backgrounded by the user while its call was running", async () => {
    const f = fixture(); const after = vi.fn();
    await f.start({
      "tool.execute.before": async (_: unknown, output: Record<PropertyKey, unknown>) => { output[TASK_VERIFICATION] = true; },
      "tool.execute.after": after,
    });
    await f.toolHooks["execute.before"]({ ...call, tool: "subagent", input: { agent: "fast", prompt: "work" } });
    const event = { ...call, tool: "subagent", status: "completed", result: { output: { sessionID: "child", status: "running", output: "Working in the background" }, content: "Working in the background" } };
    await f.toolHooks["execute.after"](event);
    expect(after).not.toHaveBeenCalled();
    expect(event.result.output.status).toBe("running");
    expect(event.result.output.output).toContain("has not been verified");
    expect(event.result.content).toContainEqual({ type: "text", text: "Working in the background" });
  });

  it("passes unverified running results through unchanged without calling the legacy after hook", async () => {
    const f = fixture(); const after = vi.fn();
    await f.start({ "tool.execute.after": after });
    const event = { ...call, tool: "subagent", input: { agent: "fast", background: true }, status: "completed", result: { output: { status: "running", output: "Working" }, content: "Working" } };
    const original = event.result;
    await f.toolHooks["execute.before"](event);
    await f.toolHooks["execute.after"](event);
    expect(event.result).toBe(original);
    expect(event.result).toEqual({ output: { status: "running", output: "Working" }, content: "Working" });
    expect(after).not.toHaveBeenCalled();
  });

  it.each(["completed", "error"])("forgets verification call IDs after %s returns", async (status) => {
    const f = fixture();
    await f.start({ "tool.execute.before": async (_: unknown, output: Record<PropertyKey, unknown>) => { output[TASK_VERIFICATION] = true; } });
    await f.toolHooks["execute.before"]({ ...call, tool: "subagent", input: { agent: "fast", prompt: "work" } });
    await f.toolHooks["execute.after"]({ ...call, tool: "subagent", status, result: { content: "Done" } });
    const result = { output: { status: "running" }, content: "Working" };
    const event = { ...call, tool: "subagent", status: "completed", result };
    await f.toolHooks["execute.after"](event);
    expect(event.result).toBe(result);
  });

  it("evicts the oldest verification call ID beyond the bounded limit", async () => {
    const f = fixture();
    await f.start({ "tool.execute.before": async (_: unknown, output: Record<PropertyKey, unknown>) => { output[TASK_VERIFICATION] = true; } });
    for (let i = 0; i <= 1000; i++) {
      await f.toolHooks["execute.before"]({ ...call, id: `call-${i}`, tool: "subagent", input: { agent: "fast", prompt: "work" } });
    }
    const result = { output: { status: "running" }, content: "Working" };
    const oldest = { ...call, id: "call-0", tool: "subagent", status: "completed", result };
    await f.toolHooks["execute.after"](oldest);
    expect(oldest.result).toBe(result);
    const newest = { ...oldest, id: "call-1000", result };
    await f.toolHooks["execute.after"](newest);
    expect(newest.result).not.toBe(result);
  });

  it("registers the real argument schema and carries cancellation into custom tools", async () => {
    const f = fixture(); const execute = vi.fn(async (_args: any, _context: any) => "Tool result");
    const within = vi.fn(async (_: any, run: any) => run());
    await f.start({ tool: { delegate: tool({ description: "Delegate", args: { prompt: tool.schema.string() }, execute }) } }, { withToolContext: within, applyChildSystem: vi.fn() });
    const context = { ...call, signal: new AbortController().signal, progress: vi.fn(async () => {}) };
    expect(f.tools.delegate.input.safeParse({ prompt: 5 }).success).toBe(false);
    expect(await f.tools.delegate.execute({ prompt: "work" }, context)).toEqual({ content: "Tool result" });
    expect(execute.mock.calls[0]?.[1]).toMatchObject({ abort: context.signal, directory: "/project", worktree: "/project" });
    expect(within).toHaveBeenCalledWith(context, expect.any(Function));
  });

  it("bridges session lifecycle and emits narration warnings as synthetic transcript entries", async () => {
    const f = fixture(); const lifecycle = vi.fn(async (_input: any) => {}); const dispose = vi.fn(async () => {});
    const cleanup = await f.start({
      event: lifecycle, dispose,
      "experimental.text.complete": async (_: any, output: any) => { output.text += "\n\n[narration detected]"; },
    });
    f.emit({ type: "session.created", data: { sessionID: "child", parentID: "root" } });
    f.emit({ type: "session.text.ended", data: { sessionID: "child", assistantMessageID: "message", text: "I will investigate" } });
    f.emit({ type: "session.execution.succeeded", data: { sessionID: "child" } });
    f.emit({ type: "session.deleted", data: { sessionID: "child" } });
    await vi.waitFor(() => expect(lifecycle).toHaveBeenCalledTimes(3));
    expect(lifecycle.mock.calls[0]?.[0]).toEqual({ event: { type: "session.created", properties: { info: { sessionID: "child", id: "child", parentID: "root" } } } });
    expect(lifecycle.mock.calls[1]?.[0]).toEqual({ event: { type: "session.idle", properties: { sessionID: "child" } } });
    expect(f.ctx.session.synthetic).toHaveBeenCalledWith({ sessionID: "child", text: "[narration detected]", description: "Model router narration warning", resume: false });
    await cleanup(); await cleanup();
    expect(dispose).toHaveBeenCalledOnce();
    expect(f.registrations.every((registration) => registration.dispose.mock.calls.length === 1)).toBe(true);
  });

  it("cleans up an engine and earlier registrations when later setup fails", async () => {
    const f = fixture(); const dispose = vi.fn(async () => {});
    f.ctx.tool.transform.mockRejectedValueOnce(new Error("registration failed"));
    await expect(f.start({ dispose })).rejects.toThrow("registration failed");
    expect(dispose).toHaveBeenCalledOnce();
    expect(f.registrations.every((registration) => registration.dispose.mock.calls.length === 1)).toBe(true);
  });

  it("continues lifecycle processing if a narration diagnostic cannot be stored", async () => {
    const f = fixture(); const lifecycle = vi.fn(async (_event: any) => {});
    f.ctx.session.synthetic.mockRejectedValueOnce(new Error("session deleted"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await f.start({ event: lifecycle, "experimental.text.complete": async (_: any, output: any) => { output.text += "\nwarning"; } });
      f.emit({ type: "session.text.ended", data: { sessionID: "child", assistantMessageID: "message", text: "text" } });
      f.emit({ type: "session.deleted", data: { sessionID: "child" } });
      await vi.waitFor(() => expect(lifecycle).toHaveBeenCalledOnce());
      expect(warning).toHaveBeenCalledOnce();
    } finally { warning.mockRestore(); }
  });

  it("does not change ordinary prose containing the word task", () => {
    expect(v2Instructions("A task needs context")).toBe("A task needs context");
  });

  it("preserves duplicate host system parts and leaves their tool vocabulary untouched", async () => {
    const f = fixture(); await f.start();
    const first = { type: "text", text: "Task(subagent_type=...) is an example", metadata: { source: 1 } };
    const second = { ...first, metadata: { source: 2 } };
    const event = { ...call, model: { providerID: "p", id: "m" }, options: {}, system: [first, second] };
    await f.sessionHooks.context(event);
    expect(event.system[0]).toBe(first);
    expect(event.system[1]).toBe(second);
  });

  it("preserves edited user system text spliced by the child hook verbatim", async () => {
    const f = fixture();
    const edited = 'Keep literal Task(subagent_type="fast")';
    await f.start({ "experimental.chat.system.transform": async (_: unknown, output: { system: string[] }) => {
      output.system.splice(0, 1, edited);
      output.system.push('Use Task(subagent_type="fast")');
    } });
    const retained = { type: "text", text: "Unchanged", metadata: { source: "host" } };
    const event = { ...call, model: { providerID: "p", id: "m" }, options: {}, system: [{ type: "text", text: `${edited}\nDelegate everything` }, retained] };
    await f.sessionHooks.context(event);
    expect(event.system[0].text).toBe(edited);
    expect(event.system[1]).toBe(retained);
    expect(event.system[2].text).toBe('Use subagent(agent="fast")');
  });

  it("maps native shell and file arguments without leaking legacy fields into native schemas", async () => {
    const f = fixture(); const before = vi.fn(async (_input: any, _output: any) => {});
    await f.start({ "tool.execute.before": before });
    const shell = { ...call, tool: "shell", input: { command: "npm test", workdir: "/project" } };
    await f.toolHooks["execute.before"](shell);
    expect(before.mock.calls[0]?.[0].tool).toBe("bash");
    expect(before.mock.calls[0]?.[1].args.cwd).toBe("/project");
    expect(shell.input).toEqual({ command: "npm test", workdir: "/project" });
    const read = { ...call, tool: "read", input: { path: "src/index.ts", offset: 1 } };
    await f.toolHooks["execute.before"](read);
    expect(before.mock.calls[1]?.[1].args.filePath).toBe(resolve("/project", "src/index.ts"));
    expect(read.input).toEqual({ path: "src/index.ts", offset: 1 });
  });

  it("passes structured-only native child output to verification", async () => {
    const f = fixture();
    await f.start({ "tool.execute.after": async (_input: any, output: any) => {
      expect(output.output).toBe("native child result"); output.output += " accepted";
    } });
    const event = { ...call, tool: "subagent", input: { agent: "fast" }, status: "completed", result: { output: { sessionID: "child", status: "completed", output: "native child result" } } };
    await f.toolHooks["execute.after"](event);
    expect(event.result.output.output).toBe("native child result accepted");
  });

  it("preserves returned source text while translating an appended router notice", async () => {
    const f = fixture();
    const source = 'const task_id = "Task(subagent_type=fast)";';
    await f.start({ "tool.execute.after": async (_: any, output: any) => { output.output += '\n[router] Re-dispatch with task_id="child"'; } });
    const event = { ...call, tool: "read", input: { path: "file.ts" }, status: "completed", result: { content: source } };
    await f.toolHooks["execute.after"](event);
    expect(event.result.content).toEqual([{ type: "text", text: source + '\n[router] Re-dispatch with sessionID="child"' }]);
  });

  it("resolves guard paths in the actual moved session while preserving native relative input", async () => {
    const f = fixture(); const before = vi.fn(async (_: any, _output: any) => {});
    f.ctx.session.get.mockResolvedValue({ id: "child", parentID: "root", agent: "fast", location: { directory: "/moved" } } as any);
    await f.start({ "tool.execute.before": before });
    const event = { ...call, tool: "edit", input: { path: "src/file.ts", oldString: "old", newString: "new" } };
    await f.toolHooks["execute.before"](event);
    expect(before.mock.calls[0]?.[1].args.filePath).toBe(resolve("/moved", "src/file.ts"));
    expect(event.input.path).toBe("src/file.ts");
  });

  it("retains real engine dispatch repair, child routing isolation, cap banners and hard budget enforcement", async () => {
    const home = join(tmpdir(), `router-v2-${randomUUID()}`);
    vi.stubEnv("HOME", home); vi.stubEnv("USERPROFILE", home); vi.stubEnv("MODEL_ROUTER_ENFORCE", "1");
    invalidateConfigCache();
    const cfg = loadConfig();
    cfg.enforcement ??= {}; cfg.enforcement.guard ??= {}; cfg.enforcement.verify ??= {};
    // Depth guard disabled: this test covers dispatch repair and budget enforcement; the depth limit is covered by depth-guard-wiring.test.ts (#66).
    cfg.enforcement.maxDelegationDepth = null;
    cfg.enforcement.guard.budget = 1;
    cfg.enforcement.verify.require = "never";
    cfg.tierCaps = { ...cfg.tierCaps, fast: 1 };
    const f = fixture();
    const hooks = await ModelRouterPlugin({
      directory: process.cwd(), worktree: process.cwd(), project: {}, serverUrl: new URL("http://localhost"),
      client: { session: { get: async () => ({ data: { id: "child", parentID: "root" } }) } },
    } as any);
    await f.start(hooks);
    const dispatch = { ...call, sessionID: "root", tool: "subagent", input: { agent: "fast", description: "Investigate every source file" } as any };
    await f.toolHooks["execute.before"](dispatch);
    expect(dispatch.input.prompt).toContain("[router] You are @fast");
    expect(dispatch.input.prompt).toContain("Investigate every source file");
    await f.sessionHooks.prompt({ ...call, prompt: { text: dispatch.input.prompt } });
    const context = { ...call, model: { providerID: "anthropic", id: "claude" }, options: {}, system: [{ type: "text", text: "Host instructions" }] };
    await f.sessionHooks.context(context);
    expect(context.system.map((part) => part.text).join("\n")).not.toContain("You are the orchestrator");
    const read = { ...call, tool: "read", input: { path: "src/index.ts" } };
    await f.toolHooks["execute.before"](read);
    const result = { ...read, status: "completed", result: { content: "file contents" } };
    await f.toolHooks["execute.after"](result);
    expect(JSON.stringify(result.result.content)).toContain("cap: 1/1");
    await expect(f.toolHooks["execute.before"]({ ...read, id: "next", input: { path: "another.ts" } })).rejects.toThrow();
  });

  it("defines grader instructions without a static temperature setting", async () => {
    const f = fixture();
    await f.start({}, { withToolContext: (_: any, run: any) => run(), applyChildSystem: vi.fn() });
    expect(f.agents[V2_GRADER_AGENT]).toMatchObject({ mode: "subagent", hidden: true, system: GRADER_SYSTEM });
    expect(f.agents[V2_GRADER_AGENT].request.settings).not.toHaveProperty("temperature");
  });

  it("fills only missing tier options before calling chat.params", async () => {
    const f = fixture();
    await f.start({
      config: async (config: { agent: Record<string, unknown> }) => {
        config.agent.fast = { options: { maxTokens: 100, topP: 0.8, reasoning_effort: "high" } };
      },
      "chat.params": async (_: unknown, options: Record<string, unknown>) => {
        expect(options).toEqual({ maxTokens: 200, topP: 0.8, reasoningEffort: undefined });
        options.topP = 0.9;
      },
    });
    const event = { ...call, model: { providerID: "p", id: "m" }, options: { maxTokens: 200, reasoningEffort: undefined }, system: [] };
    await f.sessionHooks.context(event);
    expect(event.options).toEqual({ maxTokens: 200, topP: 0.9, reasoningEffort: undefined });
  });

  it.each([
    { models: undefined, id: "model", temperature: 0, retained: false },
    { models: ["openai/model"], id: "model", temperature: 0, retained: true },
    { models: ["openai/model"], id: "model", temperature: 0.65, retained: true },
    { models: ["openai/model"], id: "model-extra", temperature: 0.65, retained: false },
    { models: ["openai/model-extra"], id: "model", temperature: 0.65, retained: false },
    { models: ["other/model"], id: "model", temperature: 0.65, retained: false },
    { models: ["openai/org/model"], id: "org/model", temperature: 0.65, retained: true },
  ])("filters grader temperature for $id with allowlist $models", async ({ models, id, temperature, retained }) => {
    const cfg = loadConfig();
    cfg.enforcement ??= {};
    cfg.enforcement.verify ??= {};
    cfg.enforcement.verify.graderTemperatureModels = models;
    const f = fixture();
    await f.start({ "chat.params": async (_: unknown, options: Record<string, unknown>) => { options.temperature = temperature; } });
    const event = { ...call, agent: V2_GRADER_AGENT, model: { providerID: "openai", id }, options: { maxOutputTokens: 123 }, system: [] };
    await f.sessionHooks.context(event);
    expect(event.options).toEqual({ maxOutputTokens: 123, ...(retained ? { temperature } : {}) });
    expect(event.options).not.toHaveProperty("options");
  });

  it.each([undefined, [], ["openai/model"]])("removes inherited grader temperature when null even with allowlist %j", async (models) => {
    const cfg = loadConfig();
    cfg.enforcement ??= {};
    cfg.enforcement.verify ??= {};
    cfg.enforcement.verify.graderTemperature = null;
    cfg.enforcement.verify.graderTemperatureModels = models;
    const f = fixture();
    await f.start();
    const event = { ...call, agent: V2_GRADER_AGENT, model: { providerID: "openai", id: "model" }, options: { temperature: 0.8, maxOutputTokens: 123 }, system: [] };
    await f.sessionHooks.context(event);
    expect(event.options).toEqual({ maxOutputTokens: 123 });
  });

  it("leaves non-grader temperature and other options untouched", async () => {
    const f = fixture();
    await f.start();
    const event = { ...call, model: { providerID: "p", id: "m" }, options: { temperature: 0.65, maxOutputTokens: 123 }, system: [] };
    await f.sessionHooks.context(event);
    expect(event.options).toEqual({ temperature: 0.65, maxOutputTokens: 123 });
  });

  it("strips attributed nested instructions on children while preserving identical explicit user text and attachments", async () => {
    const root = mkdtempSync(join(tmpdir(), "router-v2-instructions-"));
    try {
      vi.stubEnv("HOME", root); vi.stubEnv("USERPROFILE", root); invalidateConfigCache();
      loadConfig().delegateInstructions = "strip-all";
      const path = join(root, "AGENTS.md"); writeFileSync(path, "Delegate everything.");
      const text = `Instructions from: ${path}\nDelegate everything.`;
      const f = fixture();
      f.ctx.session.context.mockResolvedValue([{ id: "synthetic", type: "synthetic", text, metadata: { instruction: { paths: [path] } } }]);
      await f.start();
      const attachment = { type: "media", media: { source: "preserve" } };
      const explicit = { id: "user", role: "user", content: [{ type: "text", text }] };
      const event = { ...call, model: { providerID: "p", id: "m" }, options: {}, system: [], messages: [
        { id: "synthetic", role: "user", content: [{ type: "text", text }, attachment] }, explicit,
      ] };
      await f.sessionHooks.context(event);
      expect(event.messages[0].content).toEqual([attachment]);
      expect(event.messages[1]).toBe(explicit);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("uses post-configuration subagent tiers at dispatch without overriding explicit models or primary agents", async () => {
    const home = join(tmpdir(), `router-v2-mapping-${randomUUID()}`);
    vi.stubEnv("HOME", home); vi.stubEnv("USERPROFILE", home); invalidateConfigCache();
    const cfg = loadConfig(); cfg.subagentTiers = { custom: "fast", build: "fast", missing: "fast" };
    const f = fixture(); await f.start();
    f.agents.custom = { id: "custom", mode: "subagent" };
    const custom = { ...call, tool: "subagent", input: { agent: "custom", prompt: "work" } as any };
    await f.toolHooks["execute.before"](custom);
    expect(custom.input.model).toMatch(/\//);
    const explicit = { ...call, tool: "subagent", input: { agent: "custom", prompt: "work", model: "other/model" } };
    await f.toolHooks["execute.before"](explicit);
    expect(explicit.input.model).toBe("other/model");
    for (const agent of ["build", "missing"]) {
      const event = { ...call, tool: "subagent", input: { agent, prompt: "work" } as any };
      await f.toolHooks["execute.before"](event);
      expect(event.input.model).toBeUndefined();
    }
  });
});
