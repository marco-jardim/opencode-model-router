import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "@opencode/plugin/promise/plugin";
import { Agent } from "@opencode/plugin";
import type { Hooks } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import {
  APPROVAL_RELOAD_APPLIES, executorRunnerStatus, registerV2Hooks, resumeTargetsOf, v2Instructions, V2_BACKGROUND_SETTLED,
  type V2Executor, type V2ExecutorFactory, type V2ExecutorHost,
} from "../../src/compat/v2-hooks";
import { approvalReloadLine, markApprovalsChanged, type ApprovalsChange } from "../../src/commands/approvals";
import { PLAN_PROVIDER_NAME, ROUTER_TURN_STATE_ATTACH } from "../../src/compat/turn-state";
import { bindPlanChild, currentBinding, evict as evictBinding } from "../../src/routing/roles/binding";
import type { HostSessionEvent } from "../../src/executor/types";
import ModelRouterPlugin from "../../src/index";
import { invalidateConfigCache, loadConfig, overridePath } from "../../src/router/config";
import { getActiveTiers } from "../../src/router/protocol";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import v2Plugin from "../../src/v2";
import type { Plugin } from "@opencode/plugin";
import { lastStepContext, rememberDispatch, resetDispatchRegistry } from "../../src/router/sessions";
import { acquireOutcomes, DEFAULT_OUTCOME_TUNING, DEFAULT_OUTCOMES_DIRNAME, makeKey } from "../../src/routing/outcomes";
import { resetIngestState, type Ingest } from "../../src/routing/outcomes/ingest";
import { GRADER_SYSTEM } from "../../src/verify/checker";
import { FABLE_EFFORT_2_5_0 } from "../helpers/legacy-presets";
import { V2_GRADER_AGENT } from "../../src/compat/v2-client";
import { DEPTH_BANNER, TASK_VERIFICATION, type ChildSessionRequest, type RouterPluginInput } from "../../src/compat/child-session";
import { depthAdvisoryBanner, depthLimitMessage } from "../../src/router/depth-guard";
import { appendRouterFooter } from "../../src/verify/pending";
import { createLeaseGuard, ROUTER_FINISH_ATTACH } from "../../src/compat/background";
import { createLeaseRegistry } from "../../src/router/leases";
import { evaluatePermission, READ_ONLY_CANARIES, readOnlyPermissions } from "../../src/router/read-only";
import type { PermissionEvaluation } from "@opencode/plugin/promise/permission";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllEnvs();
  invalidateConfigCache();
});

// The two eviction tests drive the real execute.before 1000+ times (each call reloads the config from disk, ~4 ms): ~4-5 s on an
// idle machine, so the default 5 s is flaky under load. The 1000 bound is the behaviour under test, so the loop cannot shrink.
const BOUNDED_LIMIT_TIMEOUT_MS = 30_000;

describe("QA-2.1-20: the sessions a call may resume (reload-failed refusal)", () => {
  it("a subagent call names them by sessionID and task_id", () => {
    expect(resumeTargetsOf("subagent", { sessionID: "ses_a", task_id: "ses_b", prompt: "go" }, "parent")).toEqual(["ses_a", "ses_b"]);
    expect(resumeTargetsOf("subagent", { prompt: "go", sessionID: "" }, "parent")).toEqual([]);
  });

  it("Code Mode execute code names them by string literals given to sessionID / task_id", () => {
    const code = [
      `await tools.subagent({ agent: "general", prompt: "continue", sessionID: "ses_held" });`,
      `await tools.subagent({ "task_id": 'ses_other', prompt: "more" });`,
      "const task_id = `ses_third`;",
      `await tools.subagent({ sessionID: "ses_held", prompt: "again" });`,
    ].join("\n");
    expect(resumeTargetsOf("execute", { code }, "parent")).toEqual(["ses_held", "ses_other", "ses_third"]);
    // A computed template literal is no known session either: it is named as written, so the refusal fails closed on it.
    expect(resumeTargetsOf("execute", { code: "await tools.subagent({ sessionID: `${previous}`, prompt: \"go\" });" }, "parent")).toEqual(["${previous}"]);
  });

  it("execute code without a resume, or naming only the caller, resumes nothing; other tools resume nothing", () => {
    expect(resumeTargetsOf("execute", { code: `await tools.subagent({ agent: "general", prompt: "fresh" });` }, "parent")).toEqual([]);
    expect(resumeTargetsOf("execute", { code: `await tools.read({ sessionID: "parent", filePath: "a.ts" });` }, "parent")).toEqual([]);
    expect(resumeTargetsOf("execute", { code: 42 }, "parent")).toEqual([]);
    expect(resumeTargetsOf("read", { sessionID: "ses_a" }, "parent")).toEqual([]);
  });
});

describe("lease guard: glob/grep results as the v2 host delivers them (Phase 2.1 gap 4)", () => {
  async function fixtureGuard() {
    const dir = join(tmpdir(), "omr-lease-search");
    const leased = join(dir, "a.ts");
    const free = join(dir, "b.ts");
    const registry = createLeaseRegistry({ realpath: (path) => path, repoKeyOf: () => undefined, now: () => 1 }, { runMode: "annotate" });
    registry.acquireWrite({ holderID: "holder", tree: dir, isChild: true, scope: "until-complete" }, leased);
    const guard = createLeaseGuard({
      registry, sessionKind: async () => "child", sessionDir: async () => dir, gitRootOf: () => undefined,
      holderLabel: (id) => `session ${id}`, planTaskOf: () => undefined, events: { onRelease: () => () => {} },
    });
    await guard.before({ sessionID: "reader", tool: "read", args: { path: free }, callID: "c1" }); // resolves the reader's actor
    return { guard, leased, free };
  }

  it("filters a grep result's text parts and its structured matches together, and adds one note", async () => {
    const { guard, leased, free } = await fixtureGuard();
    const result = {
      content: [{ type: "text", text: `${leased}:3:needle\n${free}:5:needle` }],
      output: [{ entry: { path: leased }, line: 3 }, { entry: { path: free }, line: 5 }],
    };
    const searched = guard.afterSearch({ sessionID: "reader", tool: "grep", result });
    expect(searched?.result).toEqual({
      content: [{ type: "text", text: `${free}:5:needle` }],
      output: [{ entry: { path: free }, line: 5 }],
    });
    expect(searched?.note).toBe("[router] 1 result(s) omitted: under edit by session holder.");
    expect(result.output).toHaveLength(2); // the host's object is never mutated
  });

  it("filters a glob result given as a text string with a list of paths", async () => {
    const { guard, leased, free } = await fixtureGuard();
    const searched = guard.afterSearch({ sessionID: "reader", tool: "glob", result: { content: `${leased}\n${free}`, output: [leased, free] } });
    expect(searched?.result).toEqual({ content: free, output: [free] });
  });

  it("leaves a result without a leased entry alone", async () => {
    const { guard, free } = await fixtureGuard();
    expect(guard.afterSearch({ sessionID: "reader", tool: "glob", result: { content: [{ type: "text", text: free }], output: [free] } })).toBeUndefined();
  });
});

function fixture() {
  const registrations: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];
  const sessionHooks: Record<string, (event: any) => Promise<void>> = {};
  const toolHooks: Record<string, (event: any) => Promise<void>> = {};
  const permissionHooks: Record<string, (event: PermissionEvaluation) => Promise<void>> = {};
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
    agent: { reload: vi.fn(async () => {}), list: vi.fn(async () => ({ data: Object.values(agents) })), transform: vi.fn(async (cb: any) => { transforms.agent = cb; cb(editors.agent); return register(); }) },
    command: { list: vi.fn(async () => ({ data: Object.values(commands) })), reload: vi.fn(async () => {}), transform: vi.fn(async (cb: any) => { transforms.command = cb; cb(editors.command); return register(); }) },
    tool: {
      transform: vi.fn(async (cb: any) => { transforms.tool = cb; cb(editors.tool); return register(); }),
      hook: vi.fn(async (name: string, cb: any) => { toolHooks[name] = cb; return register(); }),
    },
    session: {
      get: vi.fn(async () => ({ id: "child", parentID: "root", agent: "fast" })),
      update: vi.fn(async (_input: unknown) => {}),
      context: vi.fn(async () => [] as any[]),
      prompt: vi.fn(async () => {}), synthetic: vi.fn(async () => {}),
      hook: vi.fn(async (name: string, cb: any) => { sessionHooks[name] = cb; return register(); }),
    },
    permission: { hook: vi.fn(async (name: string, cb: (event: PermissionEvaluation) => Promise<void>) => { permissionHooks[name] = cb; return register(); }) },
    event: { subscribe: async function* ({ signal }: { signal: AbortSignal }) {
      signal.addEventListener("abort", () => wake(), { once: true });
      while (!signal.aborted) {
        if (eventQueue.length) yield eventQueue.shift();
        else await new Promise<void>((resolve) => { wake = resolve; });
      }
    } },
  };
  return {
    ctx, agents, commands, tools, transforms, editors, sessionHooks, toolHooks, permissionHooks, registrations,
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
  it("QA-5.1-18 preserves a host /plan through registerV2Hooks and warns only once across registry rebuilds", async () => {
    const f = fixture();
    const userPlan = { name: "plan", description: "User planning command", execute: vi.fn(async () => {}) };
    f.commands.plan = userPlan;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await f.start({ config: async (cfg: { command: Record<string, unknown> }) => {
        cfg.command.plan = { description: "Executor plan", template: "executor" };
        cfg.command.router = { template: "router" };
      } });
      f.transforms.command(f.editors.command);
      expect(f.ctx.command.list).toHaveBeenCalledOnce();
      expect(f.commands.plan).toBe(userPlan);
      expect(f.commands.router).toBeDefined();
      expect(warn.mock.calls.filter(([message]) => String(message).includes("/plan command conflict"))).toHaveLength(1);
    } finally { warn.mockRestore(); }
  });

  it("QA-5.1-18 still registers the executor /plan when the host has none", async () => {
    const f = fixture();
    await f.start({ config: async (cfg: { command: Record<string, unknown> }) => {
      cfg.command.plan = { description: "Executor plan", template: "executor" };
    } });
    expect(f.commands.plan.description).toBe("Executor plan");
  });

  it.each([false, true])("filters v2 grep model content and raw structured matches (parts=%s)", async parts => {
    const f = fixture();
    await f.start({ config: async (cfg: { agent: Record<string, unknown> }) => { cfg.agent.fast = { permission: readOnlyPermissions() }; } });
    const secret = "Found 2 matches\n/repo/.env:\n  Line 1: SECRET\n";
    const ordinary = "/repo/id_utils.ts:\n  Line 1: PUBLIC";
    const event = { ...call, tool: "grep", input: { pattern: "." }, status: "completed", result: {
      content: parts ? [{ type: "text", text: secret }, { type: "text", text: ordinary }] : secret + ordinary,
      output: [{ entry: { path: ".env" }, line: 1, text: "SECRET" }, { entry: { path: "id_utils.ts" }, line: 1, text: "PUBLIC" }],
    } };
    await f.toolHooks["execute.after"](event);
    expect(JSON.stringify(event.result)).not.toContain("SECRET");
    expect(JSON.stringify(event.result)).toContain("PUBLIC");
    expect(event.result.output).toHaveLength(1);
    expect(JSON.stringify(event.result.content)).toContain("1 matches in sensitive files withheld; use read (asks for approval)");
  });
  it.each([true, false])("Context7 lookup permissions and direct exposure require configured MCP: %s", async configured => {
    const f = fixture();
    Object.assign(f.ctx, { mcp: { list: async () => ({ data: configured ? [{ name: "context7", status: { status: "connected" } }] : [] }) } });
    f.tools["context7_query-docs"] = { options: { namespace: "context7", codemode: true } };
    Object.assign(f.editors.tool, { update: (id: string, update: (definition: { options?: { namespace?: string; codemode?: boolean } }) => void) => {
      if (f.tools[id]) update(f.tools[id]);
    } });
    await f.start({ config: async (cfg: { mcp?: unknown; agent: Record<string, unknown> }) => {
      cfg.agent.fast = { permission: readOnlyPermissions(Boolean(cfg.mcp)) };
    } });
    expect(f.agents.fast.permissions.some((rule: { action: string }) => rule.action === "context7_query-docs")).toBe(configured);
    expect(f.tools["context7_query-docs"].options.codemode).toBe(!configured);
  });

  it("prepends read-only policy before explicit host rules, without changing other tiers", async () => {
    const f = fixture();
    f.agents.fast = { id: "fast", mode: "subagent", permissions: [...Agent.Info.default(Agent.ID.make("fast")).permissions,
      { action: "external_directory", resource: "*", effect: "deny" }], request: {} };
    const before = structuredClone(f.agents.explore);
    await f.start({ config: async (cfg: { agent: Record<string, unknown> }) => {
      cfg.agent.fast = { mode: "subagent", permission: { "*": "deny", read: "allow", router_git_status: "allow" } };
      cfg.agent.medium = { mode: "subagent" };
    } });
    expect(f.agents.fast.permissions).toEqual([
      { action: "*", resource: "*", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
      { action: "router_git_status", resource: "*", effect: "allow" },
      { action: "external_directory", resource: "*", effect: "deny" },
    ]);
    expect(f.agents.medium.permissions).toBeUndefined();
    expect(f.agents.explore).toEqual(before);
  });

  it("leaves user permissions intact when the tier policy is opted out", async () => {
    const f = fixture();
    const permissions = [{ action: "shell", resource: "*", effect: "deny" }];
    f.agents.fast = { id: "fast", permissions: structuredClone(permissions) };
    await f.start({ config: async (cfg: { agent: Record<string, unknown> }) => { cfg.agent.fast = { mode: "subagent" }; } });
    expect(f.agents.fast.permissions).toEqual(permissions);
  });
  it("fails closed on an allow-all appended after the host's default prefix", async () => {
    const f = fixture();
    f.agents.fast = { id: "fast", permissions: [...Agent.Info.default(Agent.ID.make("fast")).permissions,
      { action: "*", resource: "*", effect: "allow" }] };
    await f.start({ config: async (cfg: { agent: Record<string, unknown> }) => { cfg.agent.fast = { permission: { "*": "deny", read: "allow" } }; } });
    for (const action of READ_ONLY_CANARIES) expect(evaluatePermission(f.agents.fast.permissions, action, "*")).toBe("deny");
    expect(f.agents.fast.permissions).not.toContainEqual({ action: "*", resource: "*", effect: "allow" });
  });
  it("warns once per agent/diagnostic across registry rebuilds", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = fixture();
    const drifted = [{ action: "*", resource: "*", effect: "allow" }];
    f.agents.fast = { id: "fast", permissions: structuredClone(drifted) };
    try {
      await f.start({ config: async (cfg: { agent: Record<string, unknown> }) => { cfg.agent.fast = { permission: readOnlyPermissions() }; } });
      f.agents.fast.permissions = structuredClone(drifted);
      f.transforms.agent(f.editors.agent);
      expect(warn.mock.calls.filter(args => String(args[0]).includes("host default permissions not recognised for fast"))).toHaveLength(1);
      expect(warn.mock.calls.filter(args => String(args[0]).includes("inherited grant dropped for fast"))).toHaveLength(1);
    } finally { warn.mockRestore(); }
  });
  it("enforces own resource denies against session allows, retaining safe agent overrides", async () => {
    const f = fixture();
    await f.start({ config: async (cfg: { agent: Record<string, unknown> }) => {
      cfg.agent.fast = { permission: { "*": "deny", read: { "*": "allow", "*/blocked.txt": "deny" } } };
    } });
    const event = (action: string, resources: string[], effect: "allow" | "deny" = "allow"): PermissionEvaluation => ({
      sessionID: "child" as PermissionEvaluation["sessionID"], agent: "fast" as PermissionEvaluation["agent"], action, resources, effect,
    });
    for (const action of READ_ONLY_CANARIES) {
      const e = event(action, ["anything"]); await f.permissionHooks.evaluate(e); expect(e.effect).toBe("deny");
    }
    const blocked = event("read", ["src/allowed.txt", "src/blocked.txt"]);
    await f.permissionHooks.evaluate(blocked); expect(blocked.effect).toBe("deny");
    const allowed = event("read", ["src/allowed.txt"]);
    await f.permissionHooks.evaluate(allowed); expect(allowed.effect).toBe("allow");
    const narrowed = event("read", ["src/allowed.txt"], "deny");
    await f.permissionHooks.evaluate(narrowed); expect(narrowed.effect).toBe("deny");
    const medium = { ...event("shell", ["echo hi"]), agent: "medium" as PermissionEvaluation["agent"] };
    await f.permissionHooks.evaluate(medium); expect(medium.effect).toBe("allow");
  });
  it("retains parent grants when fast resumes as medium, hiding denied tools only for fast", async () => {
    const f = fixture();
    const permissions = [{ action: "shell", resource: "*", effect: "allow" }, { action: "read", resource: "private/*", effect: "deny" }, { action: "glob", resource: "*", effect: "ask" }];
    f.ctx.session.get.mockResolvedValue({ id: "child", parentID: "root", agent: "fast", ...{ permissions } });
    await f.start({ config: async (cfg: { agent: Record<string, unknown> }) => { cfg.agent.fast = { permission: readOnlyPermissions() }; } });
    await f.sessionHooks.prompt({ sessionID: "child", prompt: { text: "inspect" } });
    expect(f.ctx.session.update).not.toHaveBeenCalled();
    const e = { ...call, model: {}, options: {}, system: [], messages: [], tools: { shell: {}, execute: {}, write: {}, read: {} } };
    await f.sessionHooks.context(e);
    expect(Object.keys(e.tools)).toEqual(["read"]);
    expect(await f.ctx.session.get()).toMatchObject({ permissions });
    f.ctx.session.get.mockResolvedValue({ id: "child", parentID: "root", agent: "medium", ...{ permissions } });
    const resumed = { ...e, agent: "medium", tools: { shell: {}, read: {} } };
    await f.sessionHooks.context(resumed);
    expect(Object.keys(resumed.tools)).toEqual(["shell", "read"]);
    expect(await f.ctx.session.get()).toMatchObject({ permissions });
    expect(f.ctx.session.update).not.toHaveBeenCalled();
    const grant: PermissionEvaluation = { sessionID: "child" as PermissionEvaluation["sessionID"],
      agent: "medium" as PermissionEvaluation["agent"], action: "shell", resources: ["echo hi"], effect: "allow" };
    await f.permissionHooks.evaluate(grant);
    expect(grant.effect).toBe("allow");
  });
  it("does not upgrade an agent ask under a parent allow or weaken a deny", async () => {
    const f = fixture();
    await f.start({ config: async (cfg: { agent: Record<string, unknown> }) => { cfg.agent.fast = { permission: readOnlyPermissions() }; } });
    for (const effect of ["allow", "ask", "deny"] as const) {
      const event: PermissionEvaluation = { sessionID: "child" as PermissionEvaluation["sessionID"],
        agent: "fast" as PermissionEvaluation["agent"], action: "read", resources: ["normal.ts", "prod.env"], effect };
      await f.permissionHooks.evaluate(event);
      expect(event.effect).toBe(effect === "deny" ? "deny" : "ask");
    }
  });
  it("handles permission lookup failures without rejecting or blocking unprotected agents", async () => {
    const f = fixture();
    await f.start({ config: async (cfg: { agent: Record<string, unknown> }) => { cfg.agent.fast = { permission: readOnlyPermissions() }; } });
    f.ctx.session.get.mockRejectedValue(new Error("session unavailable"));
    const make = (agent?: string): PermissionEvaluation => ({ sessionID: "child" as PermissionEvaluation["sessionID"],
      agent: agent as PermissionEvaluation["agent"], action: "read", resources: ["normal.ts"], effect: "allow" });
    const explicit = make("fast");
    await expect(f.permissionHooks.evaluate(explicit)).resolves.toBeUndefined();
    expect(explicit.effect).toBe("allow");
    expect(f.ctx.session.get).not.toHaveBeenCalled();
    const unknown = make();
    await expect(f.permissionHooks.evaluate(unknown)).resolves.toBeUndefined();
    expect(unknown.effect).toBe("allow");
    f.ctx.agent.list.mockRejectedValue(new Error("registry unavailable"));
    const protectedEvent = make("fast");
    await expect(f.permissionHooks.evaluate(protectedEvent)).resolves.toBeUndefined();
    expect(protectedEvent.effect).toBe("deny");
    const medium = make("medium");
    await expect(f.permissionHooks.evaluate(medium)).resolves.toBeUndefined();
    expect(medium.effect).toBe("allow");
    const context = { ...call, model: {}, options: {}, system: [], messages: [], tools: { shell: {}, read: {} } };
    await expect(f.sessionHooks.context(context)).resolves.toBeUndefined();
    expect(Object.keys(context.tools)).toEqual([]);
  });
  it("applies the real ladder retry's effort through context without nesting options or changing grader temperature", async () => {
    const home = mkdtempSync(join(tmpdir(), "router-v2-effort-"));
    vi.stubEnv("HOME", home); vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("MODEL_ROUTER_VERIFIED_DELEGATE", "1");
    vi.stubEnv("MODEL_ROUTER_ENFORCE", "");
    mkdirSync(dirname(overridePath()), { recursive: true });
    const presets = { "fable-effort": FABLE_EFFORT_2_5_0 };
    writeFileSync(overridePath(), JSON.stringify({ activePreset: "fable-effort", presets }));
    invalidateConfigCache();
    const tiers = getActiveTiers(loadConfig());
    writeFileSync(overridePath(), JSON.stringify({ activePreset: "fable-effort", presets, enforcement: { verify: {
      graderTemperature: 0.25, graderTemperatureModels: Object.values(tiers).map(t => t.model),
    } } }));
    invalidateConfigCache();
    const f = fixture();
    const producers: Array<{ sid: string; options: Record<string, unknown> }> = [];
    const graders: Record<string, unknown>[] = [];
    let counter = 0;
    const run = async (request: ChildSessionRequest) => {
      const sessionID = `bridge-effort-${counter++}`;
      await request.onCreated(sessionID);
      const event = { sessionID, agent: request.agent ?? V2_GRADER_AGENT,
        model: { providerID: request.model!.providerID, id: request.model!.modelID },
        options: {} as Record<string, unknown>, system: [], messages: [],
      };
      await f.sessionHooks.context(event);
      if (request.system !== undefined) {
        graders.push(event.options);
        return { sessionID, text: JSON.stringify({ pass: graders.length > 1, reasons: ["scripted verdict"] }) };
      }
      producers.push({ sid: sessionID, options: event.options });
      return { sessionID, text: "producer output" };
    };
    const hooks = await ModelRouterPlugin({
      directory: home, worktree: home, routerHost: "v2",
      client: { session: { get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id } }) } },
      routerChildRunner: { run, dispose: async () => undefined },
    } as unknown as RouterPluginInput);
    await f.start(hooks);
    cleanups.push(async () => { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
    const result = await f.tools.delegate.execute({ tier: "fast", task: "VERIFY:required\nDo the work", acceptance: "[acceptance]\ncriteria: correct\n[/acceptance]" }, {
      ...call, sessionID: "root", signal: new AbortController().signal, progress: vi.fn(async () => undefined),
    });
    expect(result.content).toContain("[router ✓ verified:");
    expect(producers.map(p => p.options.effort)).toEqual(["low", "medium"]);
    for (const { options } of producers) expect("options" in options).toBe(false);
    expect(graders).toHaveLength(2);
    for (const options of graders) {
      expect(options.temperature).toBe(0.25);
      expect(options.effort).toBeUndefined();
      expect("options" in options).toBe(false);
    }
    const [providerID, ...modelParts] = tiers.fast.model.split("/");
    const after = { sessionID: producers[1].sid, agent: "fast", model: { providerID, id: modelParts.join("/") }, options: {} as Record<string, unknown>, system: [], messages: [] };
    await f.sessionHooks.context(after);
    expect(after.options.effort).toBe("low");
  }, 30_000);

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
    cleanups.push(async () => { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
    f.emit({ type: "session.created", data: { sessionID: "root" } });
    f.emit({ type: "session.created", data: { sessionID: "child", parentID: "root" } });
    await vi.waitFor(() => expect(lifecycle).toHaveBeenCalledTimes(2));
    return { ...f, get };
  }

  const depthCall = (id = "call") => ({ ...call, id, tool: "subagent", input: { agent: "fast", prompt: "Inspect the project" } });
  const depthResult = (id = "call", status = "completed", text = "Done") => ({
    ...depthCall(id), status: "completed",
    result: { output: { status, output: text }, content: `<subagent sessionID="leaf" state="${status}">\n${text}\n</subagent>` },
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
    const hostText = after.result.content;
    await f.toolHooks["execute.after"](after);
    expect(after.result.content).toContainEqual({ type: "text", text: hostText });
    expect(JSON.stringify(after.result.content)).toContain('sessionID=\\"leaf\\"');
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
  }, 30_000);

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
  }, BOUNDED_LIMIT_TIMEOUT_MS);

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

  it("router-reload answers synthetically, refreshes agents and never prompts", async () => {
    const f = fixture();
    await f.start({
      config: async (config: any) => { config.command["router-reload"] = { template: "", description: "Reload" }; },
      "command.execute.before": async (_: any, output: any) => { output.parts.push({ type: "text", text: "reloaded" }); },
    });
    await f.commands["router-reload"].execute({ sessionID: "root", prompt: { text: "" }, delivery: "steer" });
    expect(f.ctx.agent.reload).toHaveBeenCalledTimes(1);
    expect(f.ctx.command.reload).toHaveBeenCalledTimes(1);
    expect(f.ctx.session.synthetic).toHaveBeenCalledWith({ sessionID: "root", text: "reloaded", description: "Model router config reload", resume: false });
    expect(f.ctx.session.prompt).not.toHaveBeenCalled();
  });

  it("router-reload on the v2 adapter reloads the registries and omits the v1 restart note", async () => {
    const home = mkdtempSync(join(tmpdir(), "router-v2-reload-note-"));
    vi.stubEnv("HOME", home); vi.stubEnv("USERPROFILE", home);
    invalidateConfigCache();
    const f = fixture();
    const hooks = await ModelRouterPlugin({
      directory: home, worktree: home, routerHost: "v2",
      client: { session: { get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id } }) } },
    } as unknown as RouterPluginInput);
    await f.start(hooks);
    cleanups.push(async () => { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
    await f.commands["router-reload"].execute({ sessionID: "root", prompt: { text: "" }, delivery: "steer" });
    expect(f.ctx.agent.reload).toHaveBeenCalledTimes(1);
    expect(f.ctx.session.synthetic).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("Model router config reloaded."),
    }));
    expect(f.ctx.session.synthetic).not.toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("restart opencode"),
    }));
  });

  it("refreshes the agent registry after preset and still prompts", async () => {
    const f = fixture();
    await f.start({
      config: async (config: any) => { config.command.preset = { template: "$ARGUMENTS", description: "Switch preset" }; },
      "command.execute.before": async (_: any, output: any) => { output.parts.push({ type: "text", text: "Selected" }); },
    });
    await f.commands.preset.execute({ sessionID: "root", prompt: { text: "openai" }, delivery: "steer" });
    expect(f.ctx.agent.reload).toHaveBeenCalledTimes(1);
    expect(f.ctx.session.prompt).toHaveBeenCalledTimes(1);
  });

  describe("cross-repo P4.7: /router approve|revoke reload the role agents (SD-P4-11)", () => {
    const routerCommand = async (config: any) => { config.command.router = { template: "$ARGUMENTS", description: "Router" }; };
    /** A legacy `/router` handler: it "writes the store" (recorded), pushes its text and marks the change. */
    const legacyRouter = (order: string[], change?: ApprovalsChange) => async (_: any, output: any) => {
      order.push("store");
      output.parts.push({ type: "text", text: change === undefined ? "help" : `${change.kind}d ${change.path}` });
      if (change !== undefined) markApprovalsChanged(output.parts, change);
    };
    /** The `text` of the first `session.prompt` call. */
    const promptedText = (prompt: { mock: { calls: readonly unknown[][] } }): string => {
      const arg: unknown = prompt.mock.calls[0]?.[0];
      const text: unknown = typeof arg === "object" && arg !== null ? Reflect.get(arg, "text") : undefined;
      return typeof text === "string" ? text : "";
    };

    it("approve: store → reload → prompt, the reload line appended to the prompted text", async () => {
      const order: string[] = [];
      const f = fixture();
      const change: ApprovalsChange = { kind: "approve", path: "D:\\ext\\app" };
      await f.start({ config: routerCommand, "command.execute.before": legacyRouter(order, change) });
      f.ctx.agent.reload.mockImplementation(async () => { order.push("reload"); });
      f.ctx.session.prompt.mockImplementation(async () => { order.push("prompt"); });
      await f.commands.router.execute({ sessionID: "root", prompt: { text: "approve D:\\ext\\app" }, delivery: "steer" });
      expect(order).toEqual(["store", "reload", "prompt"]);
      expect(APPROVAL_RELOAD_APPLIES).toBe(true);
      expect(f.ctx.session.prompt).toHaveBeenCalledWith({
        sessionID: "root",
        delivery: "steer",
        text: "approve D:\\ext\\app\n\napproved D:\\ext\\app\n\nRole agents reloaded; dispatch again with root=D:\\ext\\app.",
      });
    });

    it("a failed reload gives the restart line, and the text is still prompted", async () => {
      const f = fixture();
      const change: ApprovalsChange = { kind: "approve", path: "/ext/app" };
      await f.start({ config: routerCommand, "command.execute.before": legacyRouter([], change) });
      f.ctx.agent.reload.mockRejectedValueOnce(new Error("reload down"));
      await f.commands.router.execute({ sessionID: "root", prompt: { text: "approve /ext/app" }, delivery: "steer" });
      expect(f.ctx.session.prompt).toHaveBeenCalledTimes(1);
      const text = promptedText(f.ctx.session.prompt);
      expect(text).toContain("The role agents could not be reloaded (reload down). Restart OpenCode to use it.");
      expect(text).not.toContain("dispatch again");
    });

    it("with APPROVAL_RELOAD_APPLIES off, the line is the restart line", () => {
      expect(approvalReloadLine({ kind: "approve", path: "/ext/app" }, false)).toBe("Restart OpenCode to use it.");
    });

    it("revoke reloads too; an unmarked /router output reloads nothing", async () => {
      const f = fixture();
      await f.start({ config: routerCommand, "command.execute.before": legacyRouter([], { kind: "revoke", path: "/ext/app" }) });
      await f.commands.router.execute({ sessionID: "root", prompt: { text: "revoke /ext/app" }, delivery: "steer" });
      expect(f.ctx.agent.reload).toHaveBeenCalledTimes(1);
      expect(promptedText(f.ctx.session.prompt)).toContain("Role agents reloaded; root=/ext/app is no longer allowed.");

      const g = fixture();
      await g.start({ config: routerCommand, "command.execute.before": legacyRouter([]) });
      await g.commands.router.execute({ sessionID: "root", prompt: { text: "approve /ext/app" }, delivery: "steer" });
      expect(g.ctx.agent.reload).not.toHaveBeenCalled();
      expect(g.ctx.session.prompt).toHaveBeenCalledWith({ sessionID: "root", delivery: "steer", text: "approve /ext/app\n\nhelp" });
    });
  });

  it("rebuilds from the setup-time base seed instead of re-listing router-modified agents", async () => {
    const f = fixture();
    let model = "openai/first";
    await f.start({
      config: async (config: any) => {
        config.agent.explore.model = model;
        config.command["router-reload"] = { template: "", description: "Reload" };
      },
    });
    expect(f.agents.explore.model).toMatchObject({ providerID: "openai", id: "first" });
    model = "openai/second";
    await f.commands["router-reload"].execute({ sessionID: "root", prompt: { text: "" }, delivery: "steer" });
    f.transforms.agent(f.editors.agent);
    expect(f.agents.explore.model).toMatchObject({ providerID: "openai", id: "second" });
    expect(f.ctx.agent.list).toHaveBeenCalledTimes(1);
  });

  it("refreshes from the prompt hook when loadConfig returns a new object", async () => {
    const f = fixture();
    const configHook = vi.fn(async () => {});
    await f.start({ config: configHook });
    const event = () => ({ ...call, prompt: { text: "hi" } });
    await f.sessionHooks.prompt(event());
    expect(f.ctx.agent.reload).not.toHaveBeenCalled();
    invalidateConfigCache();
    await f.sessionHooks.prompt(event());
    expect(configHook).toHaveBeenCalledTimes(2);
    expect(f.ctx.agent.reload).toHaveBeenCalledTimes(1);
    expect(f.ctx.command.reload).toHaveBeenCalledTimes(1);
  });

  it("retries the refresh on the next prompt when a registry reload rejected", async () => {
    const f = fixture();
    const configHook = vi.fn(async () => {});
    await f.start({ config: configHook });
    const event = () => ({ ...call, prompt: { text: "hi" } });
    f.ctx.agent.reload.mockRejectedValueOnce(new Error("reload boom"));
    invalidateConfigCache();
    await expect(f.sessionHooks.prompt(event())).rejects.toThrow("reload boom");
    expect(f.ctx.agent.reload).toHaveBeenCalledTimes(1);
    expect(f.ctx.command.reload).not.toHaveBeenCalled();

    // Same loadConfig() object as the failed refresh built from: it must still
    // be considered stale because the host registries never reloaded.
    await f.sessionHooks.prompt(event());
    expect(configHook).toHaveBeenCalledTimes(3);
    expect(f.ctx.agent.reload).toHaveBeenCalledTimes(2);
    expect(f.ctx.command.reload).toHaveBeenCalledTimes(1);

    // Now it succeeded, so the config counts as applied and nothing refreshes.
    await f.sessionHooks.prompt(event());
    expect(f.ctx.agent.reload).toHaveBeenCalledTimes(2);
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

  it.each([undefined, [], [{ type: "file", uri: "file:///result", mime: "text/plain" }]])(
    "keeps the full child output when content has no text: %j", async (content) => {
      const f = fixture();
      await f.start({
        "tool.execute.before": async (_: unknown, output: Record<PropertyKey, unknown>) => { output[DEPTH_BANNER] = "banner"; },
        "tool.execute.after": async (_: unknown, output: { output: string }) => { output.output += "\n\n[router ✓ verified: checker]"; },
      });
      await f.toolHooks["execute.before"](depthCall());
      const event = { ...depthResult(), result: { output: { output: "CHILD_TEXT" }, content } };
      await f.toolHooks["execute.after"](event);
      expect(event.result.content).toEqual([
        { type: "text", text: "CHILD_TEXT\n\n[router ✓ verified: checker]\n\nbanner" },
        ...(content ?? []),
      ]);
      expect(event.result.output.output).toBe("CHILD_TEXT\n\n[router ✓ verified: checker]\n\nbanner");
    },
  );

  it.each([false, true])("keeps the host envelope and attachments with verification changes (banner: %s)", async (banner) => {
    const f = fixture();
    await f.start({
      "tool.execute.before": async (_: unknown, output: Record<PropertyKey, unknown>) => {
        if (banner) output[DEPTH_BANNER] = depthAdvisoryBanner(1, 1);
        output[TASK_VERIFICATION] = true;
      },
      "tool.execute.after": async (input: any, output: any) => {
      expect(input).toMatchObject({ tool: "task", args: { subagent_type: "fast" }, callID: "call" });
      expect(output.metadata.sessionID).toBe("leaf");
       output.output += "\n[router] Use task_id next\nVerified";
    } });
    const file = { type: "file", uri: "file:///result", mime: "text/plain" };
    const host = { type: "text", text: '<subagent sessionID="leaf" state="completed">\nok\n</subagent>', metadata: { host: true } };
    const extra = { type: "text", text: "Additional host context" };
    await f.toolHooks["execute.before"](depthCall());
    const event = { ...call, tool: "subagent", input: { agent: "fast" }, status: "completed", result: { output: { sessionID: "leaf", status: "completed", output: "ok" }, content: [host, file, extra], metadata: { sessionID: "leaf" } } };
    await f.toolHooks["execute.after"](event);
    expect(event.result.output.output).toBe(`ok\n[router] Use sessionID next\nVerified${banner ? "\n\n" + depthAdvisoryBanner(1, 1) : ""}`);
    expect(event.result.content).toEqual([
      host, file, extra,
      { type: "text", text: `\n[router] Use sessionID next\nVerified${banner ? "\n\n" + depthAdvisoryBanner(1, 1) : ""}` },
    ]);
    expect((JSON.stringify(event.result.content).match(/GUARD:delegation_depth/g) ?? [])).toHaveLength(banner ? 1 : 0);
  });

  it.each(["  ", "\r\n", "\n\n\n", "  \r\n\n\n"])("does not duplicate child text trimmed by a deferred footer: %j", async (tail) => {
    const f = fixture();
    const footer = "[router] unverified · vrf_example · risk";
    await f.start({
      "tool.execute.after": async (_: unknown, output: { output: string }) => {
        output.output = appendRouterFooter(output.output, footer);
      },
    });
    const event = depthResult("call", "completed", `CHILD_TEXT${tail}`);
    const hostText = event.result.content;
    await f.toolHooks["execute.after"](event);
    expect(event.result.content).toEqual([
      { type: "text", text: hostText }, { type: "text", text: `\n\n${footer}` },
    ]);
    expect(JSON.stringify(event.result.content).match(/CHILD_TEXT/g)).toHaveLength(1);
    expect(event.result.output.output).toBe(`CHILD_TEXT\n\n${footer}`);
  });

  it.each(["[router] prefix\nCHILD_TEXT original\nVerified", "CHILD_TEXT rewritten"])("replaces host text when the router output does not start with the child text: %j", async (routed) => {
    const f = fixture();
    await f.start({
      "tool.execute.after": async (_: unknown, output: { output: string }) => { output.output = routed; },
    });
    const file = { type: "file", uri: "file:///result", mime: "text/plain" };
    const event = { ...depthResult(), result: {
      output: { output: "CHILD_TEXT original" },
      content: [{ type: "text", text: '<subagent sessionID="leaf">CHILD_TEXT original</subagent>' }, file],
    } };
    await f.toolHooks["execute.after"](event);
    expect(event.result.content).toEqual([{ type: "text", text: routed }, file]);
    expect(JSON.stringify(event.result.content).match(/CHILD_TEXT/g)).toHaveLength(1);
    expect(event.result.output.output).toBe(routed);
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
  }, BOUNDED_LIMIT_TIMEOUT_MS);

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

  it("names the structured child in the legacy metadata of a tier subagent call", async () => {
    const f = fixture(); const seen: any[] = [];
    await f.start({ "tool.execute.after": async (_input: any, output: any) => { seen.push(output.metadata); } });
    const event = { ...call, tool: "subagent", input: { agent: "fast" }, status: "completed", result: { output: { sessionID: "child", status: "completed", output: "native child result" } } };
    await f.toolHooks["execute.after"](event);
    expect(seen).toHaveLength(1);
    expect(seen[0].sessionID).toBe("child");
  });

  it("keeps the child the host already reported in the legacy metadata of a tier call", async () => {
    const f = fixture(); const seen: any[] = [];
    await f.start({ "tool.execute.after": async (_input: any, output: any) => { seen.push(output.metadata); } });
    const withId = { ...call, id: "call-a", tool: "subagent", input: { agent: "fast" }, status: "completed", result: { metadata: { sessionID: "meta-child" }, output: { sessionID: "child", status: "completed", output: "done" } } };
    const withLower = { ...call, id: "call-b", tool: "subagent", input: { agent: "fast" }, status: "completed", result: { metadata: { sessionId: "meta-lower" }, output: { sessionID: "child", status: "completed", output: "done" } } };
    await f.toolHooks["execute.after"](withId);
    await f.toolHooks["execute.after"](withLower);
    expect(seen[0]).toEqual({ sessionID: "meta-child" });
    expect(seen[1]).toEqual({ sessionId: "meta-lower" });
  });

  it("adds no child to the legacy metadata when the structured output has none or is not a subagent call", async () => {
    const f = fixture(); const seen: any[] = [];
    await f.start({ "tool.execute.after": async (_input: any, output: any) => { seen.push(output.metadata); } });
    await f.toolHooks["execute.after"]({ ...call, id: "call-c", tool: "subagent", input: { agent: "fast" }, status: "completed", result: { output: { sessionID: "", status: "completed", output: "x" } } });
    await f.toolHooks["execute.after"]({ ...call, id: "call-d", tool: "read", input: { path: "a.ts" }, status: "completed", result: { content: "x", output: { sessionID: "child" } } });
    expect(seen[0]).toEqual({});
    expect(seen[1]).toEqual({});
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
    const f = fixture();
    const cfg = loadConfig(f.ctx.location.directory);
    cfg.enforcement ??= {};
    cfg.enforcement.verify ??= {};
    cfg.enforcement.verify.graderTemperatureModels = models;
    await f.start({ "chat.params": async (_: unknown, options: Record<string, unknown>) => { options.temperature = temperature; } });
    const event = { ...call, agent: V2_GRADER_AGENT, model: { providerID: "openai", id }, options: { maxOutputTokens: 123 }, system: [] };
    await f.sessionHooks.context(event);
    expect(event.options).toEqual({ maxOutputTokens: 123, ...(retained ? { temperature } : {}) });
    expect(event.options).not.toHaveProperty("options");
  });

  it.each([undefined, [], ["openai/model"]])("removes inherited grader temperature when null even with allowlist %j", async (models) => {
    const f = fixture();
    const cfg = loadConfig(f.ctx.location.directory);
    cfg.enforcement ??= {};
    cfg.enforcement.verify ??= {};
    cfg.enforcement.verify.graderTemperature = null;
    cfg.enforcement.verify.graderTemperatureModels = models;
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
      const f = fixture();
      loadConfig(f.ctx.location.directory).delegateInstructions = "strip-all";
      const path = join(root, "AGENTS.md"); writeFileSync(path, "Delegate everything.");
      const text = `Instructions from: ${path}\nDelegate everything.`;
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
    } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
  });

  it("uses post-configuration subagent tiers at dispatch without overriding explicit models or primary agents", async () => {
    const home = join(tmpdir(), `router-v2-mapping-${randomUUID()}`);
    vi.stubEnv("HOME", home); vi.stubEnv("USERPROFILE", home); invalidateConfigCache();
    const f = fixture();
    const cfg = loadConfig(f.ctx.location.directory); cfg.subagentTiers = { custom: "fast", build: "fast", missing: "fast" };
    await f.start();
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

  it("loads router config for ctx.location.directory even when the host chdirs to $HOME (#70)", async () => {
    const home = mkdtempSync(join(tmpdir(), "router-v2-dir-"));
    const project = join(home, "work", "repo");
    const savedCwd = process.cwd();
    try {
      vi.stubEnv("HOME", home); vi.stubEnv("USERPROFILE", home); invalidateConfigCache();
      mkdirSync(join(project, ".git"), { recursive: true });
      mkdirSync(join(project, ".opencode"), { recursive: true });
      writeFileSync(
        join(project, ".opencode", "opencode-model-router.overrides.jsonc"),
        JSON.stringify({ subagentTiers: { custom: "fast" } }),
      );
      // OpenCode 2 server mode: the process cwd is $HOME, never the project.
      process.chdir(home);
      expect(loadConfig().subagentTiers?.custom).toBeUndefined();
      expect(loadConfig(project).subagentTiers).toMatchObject({ custom: "fast" });

      const f = fixture();
      f.ctx.location.directory = project;
      await f.start();
      f.agents.custom = { id: "custom", mode: "subagent" };
      const mapped = { ...call, tool: "subagent", input: { agent: "custom", prompt: "work" } as any };
      await f.toolHooks["execute.before"](mapped);
      expect(mapped.input.model).toMatch(/\//);

      // Another instance in the same process, for a directory without the
      // project file, must not see the first instance's override.
      const other = fixture();
      other.ctx.location.directory = join(home, "other");
      await other.start();
      other.agents.custom = { id: "custom", mode: "subagent" };
      const unmapped = { ...call, tool: "subagent", input: { agent: "custom", prompt: "work" } as any };
      await other.toolHooks["execute.before"](unmapped);
      expect(unmapped.input.model).toBeUndefined();
    } finally {
      process.chdir(savedCwd);
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
});

describe("plan executor wiring in the v2 adapter (3.1.7: W2, W4, W5, W6, M41)", () => {
  const NONCE = "a".repeat(32);
  const planPrompt = (planId: string, taskId: string, attempt = 1): string =>
    `PLAN CONTEXT\nshared\n\n[plan ${planId}:${taskId}#${attempt}] nonce=${NONCE}\n\nTASK do it`;
  const userMessage = (text: string) => [{ role: "user", content: [{ type: "text", text }] }];
  const PLAN_CHILD = "plan-child";
  const ABS_ROOT = process.platform === "win32" ? "C:/slots/slot-1" : "/slots/slot-1";

  /** A fake runtime handle: the adapter is asked, the answers are scripted. */
  function fakeExecutor() {
    const runtime = {
      onRouterToolCall: vi.fn(),
      onRetryHook: vi.fn((i: { sessionID: string }) => ({ stop: i.sessionID === PLAN_CHILD })),
      onHostEvent: vi.fn(),
      planLine: vi.fn((): string | null => null),
      manualReady: vi.fn((): Array<{ taskId: string; kind: string }> => []),
      start: vi.fn(async () => undefined),
      recordMetric: vi.fn(),
      dispose: vi.fn(async () => undefined),
      isPlanChild: vi.fn((sessionID: string) => sessionID === PLAN_CHILD),
    };
    const launcher = { dispose: vi.fn(async () => undefined) };
    const emitted: HostSessionEvent[] = [];
    const state: { host?: V2ExecutorHost } = {};
    const factory: V2ExecutorFactory = (host) => {
      state.host = host;
      host.hosts.onEvent((e) => { emitted.push(e); });
      return { runtime: runtime as unknown as V2Executor["runtime"], launcher };
    };
    return { runtime, launcher, emitted, state, factory };
  }

  async function startWired(options: { executor?: V2ExecutorFactory; hooks?: Record<PropertyKey, unknown> } = {}) {
    const f = fixture();
    const messagesBySession = new Map<string, unknown[]>();
    Object.assign(f.ctx.session, {
      get: vi.fn(async ({ sessionID }: { sessionID: string }) => (sessionID.startsWith("root") ? { id: sessionID } : { id: sessionID, parentID: "root", agent: "fast" })),
      context: vi.fn(async ({ sessionID }: { sessionID: string }) => messagesBySession.get(sessionID) ?? []),
    });
    const listeners = new Set<(info: { sessionID: string }) => void>();
    const childRunner = {
      bootID: "0123456789abcdef", retainedContext: () => null,
      onContextCaptured: (listener: (info: { sessionID: string }) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      run: async () => ({ sessionID: "unused", text: "" }), pin: vi.fn(() => vi.fn()),
    };
    const v2 = { withToolContext: async <T>(_context: unknown, operation: () => Promise<T>) => operation(), applyChildSystem: () => undefined, childRunner };
    const providers: string[] = [];
    const attach = (registry: { registerTurnStateProvider: (p: { name: string }) => () => void }): boolean => {
      const original = registry.registerTurnStateProvider.bind(registry);
      registry.registerTurnStateProvider = (p) => { providers.push(p.name); return original(p); };
      return true;
    };
    const hooks = { [ROUTER_TURN_STATE_ATTACH]: attach, ...(options.hooks ?? {}) } as unknown as Hooks;
    const cleanup = await registerV2Hooks(
      f.ctx as unknown as Context, hooks, v2 as unknown as Parameters<typeof registerV2Hooks>[2],
      options.executor === undefined ? {} : { executor: options.executor },
    );
    cleanups.push(cleanup);
    const toolEvent = (sessionID: string, tool = "read") => ({ sessionID, agent: "fast", messageID: "m", id: `call-${sessionID}`, tool, input: {} });
    const contextEvent = (sessionID: string, text: string) => ({
      sessionID, agent: "fast", model: { providerID: "p", id: "m" }, options: {}, system: [], messages: userMessage(text), tools: {},
    });
    const tick = async (): Promise<void> => { for (let i = 0; i < 20; i += 1) await new Promise<void>((resolve) => setImmediate(resolve)); };
    return { f, listeners, providers, cleanup, messagesBySession, toolEvent, contextEvent, tick };
  }

  it("a captured router tool call of the orchestrator feeds the executor (W2); disposing unsubscribes", async () => {
    const x = fakeExecutor();
    const w = await startWired({ executor: x.factory });
    expect(w.listeners.size).toBe(1);
    expect(x.runtime.start).toHaveBeenCalledTimes(1);
    for (const listener of w.listeners) listener({ sessionID: "root" });
    expect(x.runtime.onRouterToolCall).toHaveBeenCalledWith("root");
    x.runtime.onRouterToolCall.mockImplementationOnce(() => { throw new Error("feed failed"); });
    for (const listener of w.listeners) expect(() => listener({ sessionID: "root" })).not.toThrow();
    await w.cleanup();
    expect(w.listeners.size).toBe(0);
    expect(x.runtime.dispose).toHaveBeenCalled();
    expect(x.launcher.dispose).toHaveBeenCalled();
  });

  it("session.step.started carries the provider to the emitter; the adapter's stepKey follows the C10 recorded sequence (W4, QA-3.1-8)", async () => {
    const x = fakeExecutor();
    const w = await startWired({ executor: x.factory });
    const rate = { type: "APIError", message: "rate limited", status: 429 };
    const key = (k: number): string => `${PLAN_CHILD}:${k}`;
    // C10 (ADR 0007): step.started, retry.scheduled, the retried step's step.started, another retry, then step.ended.
    w.f.emit({ id: "e1", type: "session.step.started", data: { sessionID: PLAN_CHILD, model: { providerID: "anthropic", id: "claude-x" } } });
    w.f.emit({ id: "e2", type: "session.retry.scheduled", data: { sessionID: PLAN_CHILD, error: rate } });
    w.f.emit({ id: "e3", type: "session.step.started", data: { sessionID: PLAN_CHILD, model: { providerID: "anthropic", id: "claude-x" } } });
    w.f.emit({ id: "e4", type: "session.retry.scheduled", data: { sessionID: PLAN_CHILD, error: rate } });
    w.f.emit({ id: "e5", type: "session.step.ended", data: { sessionID: PLAN_CHILD } });
    // the next step: a step.failed while a retry is pending keeps the step open (memo :163); one without closes it
    w.f.emit({ id: "e6", type: "session.step.started", data: { sessionID: PLAN_CHILD, model: { providerID: "openai", id: "gpt-x" } } });
    w.f.emit({ id: "e7", type: "session.retry.scheduled", data: { sessionID: PLAN_CHILD, error: rate } });
    w.f.emit({ id: "e8", type: "session.step.failed", data: { sessionID: PLAN_CHILD, error: rate } });
    w.f.emit({ id: "e9", type: "session.step.started", data: { sessionID: PLAN_CHILD, model: { providerID: "openai", id: "gpt-x" } } });
    w.f.emit({ id: "e10", type: "session.step.failed", data: { sessionID: PLAN_CHILD, error: rate } });
    w.f.emit({ id: "e11", type: "session.step.started", data: { sessionID: PLAN_CHILD, model: { providerID: "openai", id: "gpt-x" } } });
    await vi.waitFor(() => expect(x.emitted.filter((e) => e.type === "step.started")).toHaveLength(5));
    expect(x.emitted.filter((e) => e.type === "step.started")).toMatchObject([
      { sessionID: PLAN_CHILD, providerID: "anthropic", modelID: "claude-x", stepKey: key(1) },
      { stepKey: key(1) },
      { sessionID: PLAN_CHILD, providerID: "openai", modelID: "gpt-x", stepKey: key(2) },
      { stepKey: key(2) },
      { stepKey: key(3) },
    ]);
    expect(x.emitted.filter((e) => e.type === "retry")).toMatchObject([
      { sessionID: PLAN_CHILD, stepKey: key(1), source: "scheduled", error: { type: "APIError", status: 429, message: "rate limited" } },
      { sessionID: PLAN_CHILD, stepKey: key(1), source: "scheduled" },
      { sessionID: PLAN_CHILD, stepKey: key(2), source: "scheduled" },
    ]);
    expect(x.emitted.filter((e) => e.type === "step.ended")).toEqual([expect.objectContaining({ sessionID: PLAN_CHILD, stepKey: key(1) })]);
    expect(x.emitted.filter((e) => e.type === "step.failed")).toMatchObject([
      { sessionID: PLAN_CHILD, stepKey: key(2), error: { type: "APIError", status: 429 } },
      { sessionID: PLAN_CHILD, stepKey: key(2) },
    ]);
    // M46: the adapter only emits; it never calls the runtime's host-event entry itself
    expect(x.runtime.onHostEvent).not.toHaveBeenCalled();
  });

  it("the step counter map is bounded at 1000 and evicts ended sessions before live ones (QA-3.1-8)", async () => {
    const x = fakeExecutor();
    const w = await startWired({ executor: x.factory });
    const rate = { type: "APIError", message: "rate limited", status: 429 };
    w.f.emit({ id: "k1", type: "session.step.started", data: { sessionID: "keep-live", model: { providerID: "p", id: "m" } } });
    for (let i = 0; i < 1000; i += 1) {
      w.f.emit({ id: `s${i}`, type: "session.step.started", data: { sessionID: `ended-${i}`, model: { providerID: "p", id: "m" } } });
      w.f.emit({ id: `x${i}`, type: "session.execution.succeeded", data: { sessionID: `ended-${i}` } });
    }
    w.f.emit({ id: "k2", type: "session.retry.scheduled", data: { sessionID: "keep-live", error: rate } });
    w.f.emit({ id: "k3", type: "session.retry.scheduled", data: { sessionID: "ended-0", error: rate } });
    await vi.waitFor(() => expect(x.emitted.filter((e) => e.type === "retry")).toHaveLength(2), { timeout: 10_000 });
    // the least recently used session is the live one: it keeps its count; the oldest ENDED session was evicted instead
    expect(x.emitted.filter((e) => e.type === "retry")).toMatchObject([
      { sessionID: "keep-live", stepKey: "keep-live:1" },
      { sessionID: "ended-0", stepKey: "ended-0:0" },
    ]);
  });

  it("the retry hook asks the runtime with the step's key; a plan child's retry decision becomes {retry:false}; others and errors leave it alone (W4, QA-3.1-3)", async () => {
    const x = fakeExecutor();
    const w = await startWired({ executor: x.factory });
    w.f.emit({ id: "e1", type: "session.step.started", data: { sessionID: PLAN_CHILD, model: { providerID: "anthropic", id: "claude-x" } } });
    await vi.waitFor(() => expect(x.emitted.some((e) => e.type === "step.started")).toBe(true));
    const error = { type: "APIError", message: "overloaded", status: 529 };
    // C10: the host's `SessionRetry` carries a writable `decision` (`{retry: true, delay}` for a 429/529)
    const planDecision = { sessionID: PLAN_CHILD, error, attempt: 2, decision: { retry: true, delay: 2000 } as { retry: boolean; delay?: number } };
    const otherDecision = { sessionID: "ordinary-session", error, attempt: 2, decision: { retry: true, delay: 2000 } };
    await expect(w.f.sessionHooks.retry(planDecision)).resolves.toBeUndefined();
    await expect(w.f.sessionHooks.retry(otherDecision)).resolves.toBeUndefined();
    expect(x.runtime.onRetryHook).toHaveBeenNthCalledWith(1, { sessionID: PLAN_CHILD, stepKey: `${PLAN_CHILD}:1`, error: { type: "APIError", status: 529, message: "overloaded" } });
    expect(x.runtime.onRetryHook).toHaveBeenNthCalledWith(2, expect.objectContaining({ sessionID: "ordinary-session" }));
    expect(x.runtime.onRetryHook.mock.results.map((r) => r.value)).toEqual([{ stop: true }, { stop: false }]);
    // the stop is written into the host's decision for the plan child only
    expect(planDecision.decision).toEqual({ retry: false });
    expect(otherDecision).toEqual({ sessionID: "ordinary-session", error, attempt: 2, decision: { retry: true, delay: 2000 } });
    const failing = { sessionID: PLAN_CHILD, error, attempt: 3, decision: { retry: true, delay: 2000 } };
    x.runtime.onRetryHook.mockImplementationOnce(() => { throw new Error("runtime failed"); });
    await expect(w.f.sessionHooks.retry(failing)).resolves.toBeUndefined();
    expect(failing.decision).toEqual({ retry: true, delay: 2000 });
  });

  it("a retry the hook stopped no longer keeps the step open: the following step.failed closes it (QA-3.1-8)", async () => {
    const x = fakeExecutor();
    const w = await startWired({ executor: x.factory });
    const rate = { type: "APIError", message: "rate limited", status: 429 };
    w.f.emit({ id: "e1", type: "session.step.started", data: { sessionID: PLAN_CHILD, model: { providerID: "anthropic", id: "claude-x" } } });
    w.f.emit({ id: "e2", type: "session.retry.scheduled", data: { sessionID: PLAN_CHILD, error: rate } });
    await vi.waitFor(() => expect(x.emitted.filter((e) => e.type === "retry")).toHaveLength(1));
    await w.f.sessionHooks.retry({ sessionID: PLAN_CHILD, error: rate, attempt: 3, decision: { retry: true, delay: 2000 } });
    w.f.emit({ id: "e3", type: "session.step.failed", data: { sessionID: PLAN_CHILD, error: rate } });
    w.f.emit({ id: "e4", type: "session.step.started", data: { sessionID: PLAN_CHILD, model: { providerID: "anthropic", id: "claude-x" } } });
    await vi.waitFor(() => expect(x.emitted.filter((e) => e.type === "step.started")).toHaveLength(2));
    expect(x.runtime.onRetryHook).toHaveBeenCalledWith(expect.objectContaining({ sessionID: PLAN_CHILD, stepKey: `${PLAN_CHILD}:1` }));
    expect(x.emitted.filter((e) => e.type === "step.failed")).toMatchObject([{ stepKey: `${PLAN_CHILD}:1` }]);
    expect(x.emitted.filter((e) => e.type === "step.started").map((e) => (e as { stepKey?: string }).stepKey)).toEqual([`${PLAN_CHILD}:1`, `${PLAN_CHILD}:2`]);
  });

  it("a retry hook that runs before its step's step.started was processed opens that step; the late step.started does not advance it again (QA-3.1-21)", async () => {
    const x = fakeExecutor();
    const w = await startWired({ executor: x.factory });
    const S = "lagging-child";
    const rate = { type: "APIError", message: "rate limited", status: 429 };
    const started = (id: string): void => {
      w.f.emit({ id, type: "session.step.started", data: { sessionID: S, model: { providerID: "anthropic", id: "claude-x" } } });
    };
    const keys = (type: string): Array<string | undefined> =>
      x.emitted.filter((e) => e.type === type).map((e) => (e as { stepKey?: string }).stepKey);
    // step 1 starts and ends, both processed
    started("l1");
    w.f.emit({ id: "l2", type: "session.step.ended", data: { sessionID: S } });
    await vi.waitFor(() => expect(keys("step.ended")).toHaveLength(1));
    // step 2 started on the host, but the event loop has not processed its step.started yet: the retry hook runs first
    await w.f.sessionHooks.retry({ sessionID: S, error: rate, attempt: 2, decision: { retry: true, delay: 2000 } });
    expect(x.runtime.onRetryHook).toHaveBeenLastCalledWith(expect.objectContaining({ sessionID: S, stepKey: `${S}:2` }));
    // the late step.started (a no-op: the pending retry stays), the failure the host retries, the retried step: one key
    started("l3");
    w.f.emit({ id: "l4", type: "session.step.failed", data: { sessionID: S, error: rate } });
    started("l5");
    w.f.emit({ id: "l6", type: "session.step.ended", data: { sessionID: S } });
    await vi.waitFor(() => expect(keys("step.ended")).toHaveLength(2));
    expect(keys("step.started")).toEqual([`${S}:1`, `${S}:2`, `${S}:2`]);
    expect(keys("step.failed")).toEqual([`${S}:2`]);
    expect(keys("step.ended")).toEqual([`${S}:1`, `${S}:2`]);
    // a hook on a step whose step.started was processed reads its key and opens nothing
    started("l7");
    await vi.waitFor(() => expect(keys("step.started")).toHaveLength(4));
    await w.f.sessionHooks.retry({ sessionID: S, error: rate, attempt: 2, decision: { retry: true, delay: 2000 } });
    expect(x.runtime.onRetryHook).toHaveBeenLastCalledWith(expect.objectContaining({ sessionID: S, stepKey: `${S}:3` }));
    started("l8");
    await vi.waitFor(() => expect(keys("step.started")).toHaveLength(5));
    expect(keys("step.started")).toEqual([`${S}:1`, `${S}:2`, `${S}:2`, `${S}:3`, `${S}:3`]);
  });

  it("the orchestrator's own idle events reach the emitter (W6, M34)", async () => {
    const x = fakeExecutor();
    const w = await startWired({ executor: x.factory });
    w.f.emit({ id: "r1", type: "session.execution.succeeded", data: { sessionID: "root" } });
    w.f.emit({ id: "r2", type: "session.execution.interrupted", data: { sessionID: "root" } });
    await vi.waitFor(() => expect(x.emitted).toHaveLength(2));
    expect(x.emitted).toMatchObject([{ type: "execution.completed", sessionID: "root" }, { type: "execution.interrupted", sessionID: "root" }]);
  });

  it("registers the plan turn-state provider with an executor (W6)", async () => {
    const x = fakeExecutor();
    const w = await startWired({ executor: x.factory });
    expect(w.providers).toContain(PLAN_PROVIDER_NAME);
  });

  it("with no factory, or a factory answering null, nothing changes: no retry hook, no plan provider, no emission (M3)", async () => {
    const none = await startWired();
    expect(none.f.sessionHooks.retry).toBeUndefined();
    expect(none.providers).not.toContain(PLAN_PROVIDER_NAME);
    expect(none.listeners.size).toBe(0);

    const factory = vi.fn((): null => null);
    const nulled = await startWired({ executor: factory });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(nulled.providers).not.toContain(PLAN_PROVIDER_NAME);
    expect(nulled.listeners.size).toBe(0);
    expect(nulled.f.sessionHooks.retry).toBeUndefined();
  });

  describe("M41: an unbound plan child is refused every tool call (always on)", () => {
    const bound: string[] = [];
    afterEach(() => { for (const id of bound.splice(0)) evictBinding(id); });
    const bind = (child: string, planId: string, taskId: string): void => {
      bindPlanChild({ childSessionID: child, role: "implementer", agent: "fast", workRoot: ABS_ROOT, grant: ["read"], planId, taskId, attempt: 1 });
      bound.push(child);
    };
    /** The refusal text of one tool call of the session; "" when the call was allowed. */
    const refusal = async (w: Awaited<ReturnType<typeof startWired>>, sessionID: string): Promise<string> => {
      try {
        await w.f.toolHooks["execute.before"](w.toolEvent(sessionID));
        return "";
      } catch (error) {
        return String(error instanceof Error ? error.message : error);
      }
    };

    it("context-hook path: an unbound child whose first message carries a plan header is refused, and stays refused", async () => {
      const w = await startWired(); // no executor: the check is on either way
      await w.f.sessionHooks.context(w.contextEvent("m41-unbound", planPrompt("plan-one", "T1")));
      expect(await refusal(w, "m41-unbound")).toMatch(/no matching plan binding/);
      expect(await refusal(w, "m41-unbound")).toMatch(/no matching plan binding/);
    });

    it("a header naming another plan or task than the binding is refused; a matching header is not", async () => {
      const w = await startWired();
      bind("m41-wrong-task", "plan-one", "T1");
      bind("m41-wrong-plan", "plan-one", "T1");
      bind("m41-match", "plan-one", "T1");
      await w.f.sessionHooks.context(w.contextEvent("m41-wrong-task", planPrompt("plan-one", "T2")));
      await w.f.sessionHooks.context(w.contextEvent("m41-wrong-plan", planPrompt("plan-two", "T1")));
      await w.f.sessionHooks.context(w.contextEvent("m41-match", planPrompt("plan-one", "T1")));
      expect(await refusal(w, "m41-wrong-task")).toMatch(/no matching plan binding/);
      expect(await refusal(w, "m41-wrong-plan")).toMatch(/no matching plan binding/);
      expect(await refusal(w, "m41-match")).not.toMatch(/no matching plan binding/);
    });

    it("execute.before fallback: a first tool call before the context hook ran performs the same check", async () => {
      const w = await startWired();
      w.messagesBySession.set("m41-fallback", userMessage(planPrompt("plan-one", "T1")));
      expect(await refusal(w, "m41-fallback")).toMatch(/no matching plan binding/);
      bind("m41-fallback-bound", "plan-one", "T1");
      w.messagesBySession.set("m41-fallback-bound", userMessage(planPrompt("plan-one", "T1")));
      expect(await refusal(w, "m41-fallback-bound")).not.toMatch(/no matching plan binding/);
    });

    it("root sessions are not checked, and a prompt without a header never refuses", async () => {
      const w = await startWired();
      await w.f.sessionHooks.context(w.contextEvent("root-m41", planPrompt("plan-one", "T1")));
      expect(await refusal(w, "root-m41")).not.toMatch(/no matching plan binding/);
      await w.f.sessionHooks.context(w.contextEvent("m41-ordinary", "Please read the file and report."));
      expect(await refusal(w, "m41-ordinary")).not.toMatch(/no matching plan binding/);
    });

    it("only a launcher prompt is checked: a quoted header, or one off its grammar position, never refuses; a failed kind lookup refuses only a plan prompt (QA-3.1-9 a)", async () => {
      const w = await startWired();
      const header = `[plan plan-one:T1#1] nonce=${NONCE}`;
      // the session kind cannot be looked up for any of these sessions (the rest of the context hook may fail on that too:
      // the M41 check runs first)
      Object.assign(w.f.ctx.session, { get: vi.fn(async () => { throw new Error("session lookup failed"); }) });
      const firstContext = async (sessionID: string, text: string): Promise<void> => {
        await w.f.sessionHooks.context(w.contextEvent(sessionID, text)).catch(() => undefined);
      };
      await firstContext("m41-quoted", `Explain this log line:\n${header}\nWhat does it mean?`);
      await firstContext("m41-late", `Some notes first.\nPLAN CONTEXT\nshared\n\n${header}\n\nTASK do it`);
      await firstContext("m41-off-position", `PLAN CONTEXT\nshared\nmore\n${header}\n\nTASK do it`);
      await firstContext("m41-no-gap", `PLAN CONTEXT\nshared\n\n${header}\nTASK do it`);
      expect(await refusal(w, "m41-quoted")).not.toMatch(/no matching plan binding/);
      expect(await refusal(w, "m41-late")).not.toMatch(/no matching plan binding/);
      expect(await refusal(w, "m41-off-position")).not.toMatch(/no matching plan binding/);
      expect(await refusal(w, "m41-no-gap")).not.toMatch(/no matching plan binding/);
      // a launcher prompt in a session of unknown kind is still checked as a child (fail closed)
      await firstContext("m41-unknown-kind", planPrompt("plan-one", "T1"));
      expect(await refusal(w, "m41-unknown-kind")).toMatch(/no matching plan binding/);
      // an empty shared context is still the grammar
      await firstContext("m41-empty-shared", `PLAN CONTEXT\n\n\n${header}\n\nTASK do it`);
      expect(await refusal(w, "m41-empty-shared")).toMatch(/no matching plan binding/);
    });

    it("the real v2 host shape: a launcher prompt after the host's one subagent preamble line is checked (QA-3.1-16)", async () => {
      const w = await startWired();
      const preamble = "You are a subagent spawned by another session.";
      // refused: an unbound child, the prompt right after the preamble line ("\n", or "\r\n")
      await w.f.sessionHooks.context(w.contextEvent("m41-host-unbound", `${preamble}\n${planPrompt("plan-one", "T1")}`));
      expect(await refusal(w, "m41-host-unbound")).toMatch(/no matching plan binding/);
      await w.f.sessionHooks.context(w.contextEvent("m41-host-crlf", `${preamble}\r\n${planPrompt("plan-one", "T1")}`));
      expect(await refusal(w, "m41-host-crlf")).toMatch(/no matching plan binding/);
      // the execute.before fallback reads the same shape
      w.messagesBySession.set("m41-host-fallback", userMessage(`${preamble}\n${planPrompt("plan-one", "T1")}`));
      expect(await refusal(w, "m41-host-fallback")).toMatch(/no matching plan binding/);
      w.messagesBySession.set("m41-host-fallback-crlf", userMessage(`${preamble}\r\n${planPrompt("plan-one", "T1")}`));
      expect(await refusal(w, "m41-host-fallback-crlf")).toMatch(/no matching plan binding/);
      bind("m41-host-fallback-bound", "plan-one", "T1");
      w.messagesBySession.set("m41-host-fallback-bound", userMessage(`${preamble}\n${planPrompt("plan-one", "T1")}`));
      expect(await refusal(w, "m41-host-fallback-bound")).not.toMatch(/no matching plan binding/);
      // allowed: the bound child, same shape
      bind("m41-host-bound", "plan-one", "T1");
      await w.f.sessionHooks.context(w.contextEvent("m41-host-bound", `${preamble}\n${planPrompt("plan-one", "T1")}`));
      expect(await refusal(w, "m41-host-bound")).not.toMatch(/no matching plan binding/);
      // refused: a bound child whose header (after the preamble) names another task
      bind("m41-host-mismatch", "plan-one", "T1");
      await w.f.sessionHooks.context(w.contextEvent("m41-host-mismatch", `${preamble}\n${planPrompt("plan-one", "T2")}`));
      expect(await refusal(w, "m41-host-mismatch")).toMatch(/no matching plan binding/);
      // never re-opened: other leading text, a changed preamble line, two preambles or a blank line after it is no launcher prompt
      for (const [id, text] of [
        ["m41-host-notes", `${preamble}\nSome notes first.\n${planPrompt("plan-one", "T1")}`],
        ["m41-host-altered", `${preamble} Really.\n${planPrompt("plan-one", "T1")}`],
        ["m41-host-twice", `${preamble}\n${preamble}\n${planPrompt("plan-one", "T1")}`],
        ["m41-host-blank", `${preamble}\n\n${planPrompt("plan-one", "T1")}`],
        ["m41-host-indented", ` ${preamble}\n${planPrompt("plan-one", "T1")}`],
      ] as const) {
        await w.f.sessionHooks.context(w.contextEvent(id, text));
        expect(await refusal(w, id), id).not.toMatch(/no matching plan binding/);
      }
    });

    it("parallel first tool calls on the fallback path all wait for the same check: none slips through (QA-3.1-9 b)", async () => {
      const w = await startWired();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const contextOf = vi.fn(async ({ sessionID }: { sessionID: string }) => {
        if (sessionID !== "m41-race") return [];
        await gate;
        return userMessage(planPrompt("plan-one", "T1"));
      });
      Object.assign(w.f.ctx.session, { context: contextOf });
      const call = async (n: number): Promise<string> => {
        try {
          await w.f.toolHooks["execute.before"]({ ...w.toolEvent("m41-race"), id: `call-m41-race-${n}` });
          return "";
        } catch (error) {
          return String(error instanceof Error ? error.message : error);
        }
      };
      const calls = [call(1), call(2), call(3)];
      await w.tick();
      release();
      const results = await Promise.all(calls);
      for (const result of results) expect(result).toMatch(/no matching plan binding/);
      expect(await refusal(w, "m41-race")).toMatch(/no matching plan binding/);
    });

    it("a fallback check that could not read the first message is retried by the next call", async () => {
      const w = await startWired();
      let fail = true;
      Object.assign(w.f.ctx.session, {
        context: vi.fn(async () => {
          if (fail) throw new Error("context unavailable");
          return userMessage(planPrompt("plan-one", "T1"));
        }),
      });
      expect(await refusal(w, "m41-retry")).not.toMatch(/no matching plan binding/);
      fail = false;
      expect(await refusal(w, "m41-retry")).toMatch(/no matching plan binding/);
    });
  });

  it("tiers mode: a plan child's binding carries the plan identity; its agent is no role agent, so it gets no role action (QA-3.1-2)", async () => {
    const x = fakeExecutor();
    await startWired({ executor: x.factory });
    const host = x.state.host;
    if (host === undefined) throw new Error("the factory was not called");
    const child = "qa312-plan-child";
    host.bindings.bind({ childSessionID: child, role: "implementer", agent: "implementer", workRoot: ABS_ROOT, grant: ["edit"], planId: "plan-one", taskId: "T1", attempt: 1 });
    try {
      const binding = currentBinding(child, { maxOf: () => [] });
      expect(binding?.plan).toMatchObject({ planId: "plan-one", taskId: "T1" });
    } finally {
      evictBinding(child);
    }
  });

  it("roles mode: a plan child with needs=edit can read, glob, grep and edit; without shell it is refused router_run (QA-3.1-2)", async () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "omr-qa312-")));
    vi.stubEnv("HOME", dir); vi.stubEnv("USERPROFILE", dir); vi.stubEnv("MODEL_ROUTER_ENFORCE", "");
    mkdirSync(dirname(overridePath()), { recursive: true });
    writeFileSync(overridePath(), JSON.stringify({ routing: { delegation: "roles" } }));
    invalidateConfigCache();
    const slot = join(dir, "slot-1");
    mkdirSync(slot, { recursive: true });
    const file = join(slot, "a.ts");
    writeFileSync(file, "export const a = 1;\n");
    const pluginHooks: unknown = await ModelRouterPlugin({
      directory: dir, worktree: dir, routerHost: "v2",
      client: {
        session: { get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, ...(path.id === "root" ? {} : { parentID: "root" }) } }) },
        app: { log: async () => ({}) },
      },
    } as unknown as Parameters<typeof ModelRouterPlugin>[0]);
    const toolHooks: Record<string, (event: unknown) => Promise<void>> = {};
    const register = () => ({ dispose: async () => undefined });
    let wake = (): void => undefined;
    const ctx = {
      location: { directory: dir, project: { directory: dir } },
      agent: { reload: async () => undefined, list: async () => ({ data: [] }), transform: async (cb: (e: unknown) => void) => { cb({ update: () => undefined }); return register(); } },
      command: { reload: async () => undefined, transform: async (cb: (e: unknown) => void) => { cb({ add: () => undefined }); return register(); } },
      model: { list: async () => ({ data: [] }) },
      tool: {
        transform: async (cb: (e: unknown) => void) => { cb({ add: () => undefined, update: () => undefined }); return register(); },
        hook: async (name: string, cb: (event: unknown) => Promise<void>) => { toolHooks[name] = cb; return register(); },
      },
      session: {
        get: async ({ sessionID }: { sessionID: string }) => (sessionID === "root"
          ? { id: sessionID, agent: "build", location: { directory: dir } }
          : { id: sessionID, parentID: "root", agent: "implementer", location: { directory: dir } }),
        context: async () => [] as unknown[],
        update: async () => undefined, prompt: async () => undefined, synthetic: async () => undefined, interrupt: async () => undefined,
        hook: async () => register(),
      },
      permission: { hook: async () => register() },
      event: {
        subscribe: async function* ({ signal }: { signal: AbortSignal }): AsyncGenerator<never> {
          signal.addEventListener("abort", () => wake(), { once: true });
          while (!signal.aborted) await new Promise<void>((resolve) => { wake = resolve; });
        },
      },
    };
    const childRunner = {
      bootID: "0123456789abcdef", retainedContext: () => null, onContextCaptured: () => () => undefined,
      run: async () => ({ sessionID: "unused", text: "" }), pin: () => () => undefined,
    };
    const v2 = { withToolContext: async <T>(_context: unknown, operation: () => Promise<T>) => operation(), applyChildSystem: () => undefined, childRunner };
    const x = fakeExecutor();
    cleanups.push(await registerV2Hooks(ctx as unknown as Context, pluginHooks as Hooks, v2 as unknown as Parameters<typeof registerV2Hooks>[2], {
      executor: x.factory, hostSettleMs: 0, listRegistrationWorktrees: async () => [],
    }));
    const children = ["qa312-edit", "qa312-shell"];
    cleanups.push(async () => {
      for (const child of children) evictBinding(child);
      const dispose: unknown = typeof pluginHooks === "object" && pluginHooks !== null ? Reflect.get(pluginHooks, "dispose") : undefined;
      if (typeof dispose === "function") await Reflect.apply(dispose, pluginHooks, []);
      vi.unstubAllEnvs();
      invalidateConfigCache();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    });
    const host = x.state.host;
    if (host === undefined) throw new Error("the factory was not called");
    // the launcher hands the route `needs` in `grant`; the binding holds the role grant they map to (`grantFor`)
    host.bindings.bind({ childSessionID: "qa312-edit", role: "implementer", agent: "implementer", workRoot: slot, grant: ["edit"], planId: "plan-one", taskId: "T1", attempt: 1 });
    host.bindings.bind({ childSessionID: "qa312-shell", role: "implementer", agent: "implementer", workRoot: slot, grant: ["edit", "shell"], planId: "plan-one", taskId: "T2", attempt: 1 });
    let n = 0;
    const outcome = async (sessionID: string, tool: string, input: Record<string, unknown>): Promise<string> => {
      n += 1;
      try {
        await toolHooks["execute.before"]!({ sessionID, agent: "implementer", messageID: "m", id: `qa312-call-${n}`, tool, input });
        return "";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };
    const refusedForRole = /Refused for role agent implementer/;
    // each outcome is its own assertion message: a refusal names the tool and its reason
    // the v2 host's read/write/edit input names the file `path` (taskArgs maps it to `filePath`; a `filePath` key is dropped)
    const read = await outcome("qa312-edit", "read", { path: file });
    expect(read, `read: ${read}`).not.toMatch(refusedForRole);
    const glob = await outcome("qa312-edit", "glob", { pattern: "*.ts", path: slot });
    expect(glob, `glob: ${glob}`).not.toMatch(refusedForRole);
    const grep = await outcome("qa312-edit", "grep", { pattern: "const", path: slot });
    expect(grep, `grep: ${grep}`).not.toMatch(refusedForRole);
    const edit = await outcome("qa312-edit", "edit", { path: file, oldString: "1", newString: "2" });
    expect(edit, `edit: ${edit}`).not.toMatch(refusedForRole);
    // no `shell` need: no router_run
    const noShell = await outcome("qa312-edit", "router_run", { script: "test", cwd: slot });
    expect(noShell, `router_run without shell: ${noShell}`).toMatch(refusedForRole);
    // `shell` maps to router_run
    const shell = await outcome("qa312-shell", "router_run", { script: "test", cwd: slot });
    expect(shell, `router_run with shell: ${shell}`).not.toMatch(refusedForRole);
  });

  it("an executor-owned in-flight attempt is left out of the adapter's journal snapshot: a restart never recovers it as a dispatch (QA-3.1-10)", async () => {
    const x = fakeExecutor();
    let snapshot: (() => readonly unknown[]) | undefined;
    const attach = () => ({
      reload: async () => undefined, dispatchOf: () => undefined,
      setAdapterSnapshot: (provider: () => readonly unknown[]) => { snapshot = provider; },
    });
    await startWired({ executor: x.factory, hooks: { [ROUTER_FINISH_ATTACH]: attach } });
    const host = x.state.host;
    if (host === undefined) throw new Error("the factory was not called");
    if (snapshot === undefined) throw new Error("the adapter registered no snapshot provider");
    const req = {
      planId: "plan-one", taskId: "T9", attempt: 1, nonce: NONCE, orchestratorSessionID: "root", role: "implementer", grant: ["read"],
      workRoot: ABS_ROOT, prompt: planPrompt("plan-one", "T9"), context: { bootID: "0123456789abcdef", epoch: 1, callID: "c9" },
      route: { agent: "fast", model: { providerID: "p", modelID: "m", variant: null }, provider: "p", heavy: false },
    } as unknown as Parameters<typeof host.bookkeeping.decisionRow>[0];
    host.bookkeeping.decisionRow(req);
    host.bookkeeping.registerInFlight("T9", 1, null);
    host.bookkeeping.registerInFlight("T9", 1, "qa3110-child");
    const inflightOf = (records: readonly unknown[]) => records.filter((r) => {
      const record = r as { kind?: unknown; childSessionID?: unknown; callID?: unknown };
      return record.kind === "inflight" && (record.childSessionID === "qa3110-child" || String(record.callID).startsWith("executor:"));
    });
    expect(inflightOf(snapshot())).toEqual([]);
  });

  it("an executor-owned completion is not processed a second time: the runner trigger settles it, execution.* is a duplicate (W5)", async () => {
    const x = fakeExecutor();
    const w = await startWired({ executor: x.factory });
    const host = x.state.host;
    if (host === undefined) throw new Error("the factory was not called");
    const req = {
      planId: "plan-one", taskId: "T1", attempt: 1, nonce: NONCE, orchestratorSessionID: "root", role: "implementer", grant: ["read"],
      workRoot: ABS_ROOT, prompt: planPrompt("plan-one", "T1"), context: { bootID: "0123456789abcdef", epoch: 1, callID: "c1" },
      route: { agent: "fast", model: { providerID: "p", modelID: "m", variant: null }, provider: "p", heavy: false },
    } as unknown as Parameters<typeof host.bookkeeping.decisionRow>[0];
    host.bookkeeping.decisionRow(req);
    host.bookkeeping.recordDispatchStart(req, new Date().toISOString());
    host.bookkeeping.registerInFlight("T1", 1, null);
    host.bookkeeping.registerInFlight("T1", 1, PLAN_CHILD);
    w.f.emit({ id: "s1", type: "session.created", data: { sessionID: PLAN_CHILD, parentID: "root" } });
    // the launcher's settle point: the runner trigger, with the launch's settled end (QA-3.1-24: the runner result settled
    // before the child's `execution.succeeded` was seen)
    host.bookkeeping.unregisterInFlight("T1", 1, "completed");
    w.f.emit({ id: "s2", type: "session.execution.succeeded", data: { sessionID: PLAN_CHILD } }); // a later execution.* trigger
    host.bookkeeping.unregisterInFlight("T1", 1); // idempotent
    await w.tick();
    const settle: unknown = Reflect.get(w.cleanup, V2_BACKGROUND_SETTLED);
    if (typeof settle === "function") await (settle as () => Promise<void>)();
    await w.tick();
    // the ordinary path would hold or deliver a completion entry to the parent; an executor-owned attempt does neither
    expect(w.f.ctx.session.synthetic).not.toHaveBeenCalled();
    // the executor still sees the child's end through its one event path
    expect(x.emitted.some((e) => e.type === "execution.completed" && e.sessionID === PLAN_CHILD)).toBe(true);
    expect(x.runtime.onHostEvent).not.toHaveBeenCalled();
    // QA-3.1-24: the runner trigger of that settle point carried "succeeded": no observed end yet, the launch settled "completed"
    expect(executorRunnerStatus(undefined, "completed", undefined)).toBe("succeeded");
  });

  it("the runner trigger status: the child's observed end, else the launch's settled end kind, else the registry, else interrupted (QA-3.1-24)", () => {
    // the runner result settled before the child's execution.succeeded was seen: the settled kind decides, never "interrupted"
    expect(executorRunnerStatus(undefined, "completed", undefined)).toBe("succeeded");
    expect(executorRunnerStatus(undefined, "completed", "unknown")).toBe("succeeded");
    expect(executorRunnerStatus(undefined, "failed", undefined)).toBe("failed");
    expect(executorRunnerStatus(undefined, "capacity", undefined)).toBe("failed");
    expect(executorRunnerStatus(undefined, "interrupted", undefined)).toBe("interrupted");
    // the child's own end wins over the launch's view
    expect(executorRunnerStatus("failed", "completed", undefined)).toBe("failed");
    expect(executorRunnerStatus("succeeded", "lost", undefined)).toBe("succeeded");
    // a lost launch, or none passed (a release after the settle): the registry's outcome, else interrupted
    expect(executorRunnerStatus(undefined, "lost", "succeeded")).toBe("succeeded");
    expect(executorRunnerStatus(undefined, undefined, "failed")).toBe("failed");
    expect(executorRunnerStatus(undefined, "lost", "unknown")).toBe("interrupted");
    expect(executorRunnerStatus(undefined, undefined, undefined)).toBe("interrupted");
  });
});

describe("OpenCode 2 telemetry ingestion (M6, event loop)", () => {
  const KEY = makeKey("implement", { origin: "router", id: "medium" }, "anthropic", "claude-sonnet-5-5", "medium");
  const FACTS = { class: "implement", risk: "medium", scope: "file", needs: [] as string[], confidence: 0.9, source: "rules" };
  const logger = { warn: vi.fn() };

  /** HOME redirected to a temp dir; `routing` (when given) is written to the global override layer. */
  /** `routing: null` writes no routing block at all (QA-2.1-R2-5). */
  function routingHome(routing?: Record<string, unknown> | null) {
    const home = mkdtempSync(join(tmpdir(), "router-v2-ingest-"));
    const outcomes = join(home, "outcomes");
    vi.stubEnv("HOME", home); vi.stubEnv("USERPROFILE", home);
    // QA-2.1-8: the per-user pending journal dir resolves inside this home on every platform, never in the runner's own state dir.
    vi.stubEnv("XDG_STATE_HOME", join(home, ".local", "state"));
    // QA-2.1-4: every config, the static ones included, names an explicit empty outcomes directory, and the tests
    // assert it stays empty. A routing block without `engine` is static.
    mkdirSync(outcomes, { recursive: true });
    mkdirSync(dirname(overridePath()), { recursive: true });
    writeFileSync(overridePath(), JSON.stringify(routing === null ? {} : { routing: { outcomes: { path: outcomes }, ...(routing ?? {}) } }));
    invalidateConfigCache();
    return { home, outcomes };
  }

  function catalog() {
    return { list: vi.fn(async () => ({ data: [{ providerID: "anthropic", id: "claude-sonnet-5-5", cost: [{ input: 3, output: 15 }] }] })) };
  }

  /** Start the adapter over a fixture whose ctx also has the model catalog. */
  async function start(f: ReturnType<typeof fixture>, model: ReturnType<typeof catalog>, hooks: Record<string, any> = {}, options?: { ingest?: Ingest }) {
    const forgetSession = vi.fn();
    const runtime = { withToolContext: async (_context: unknown, operation: () => Promise<any>) => operation(), applyChildSystem: vi.fn(), forgetSession };
    const ctx = { ...f.ctx, model };
    const cleanup = await registerV2Hooks(ctx as unknown as Context, hooks as Hooks, runtime, options);
    cleanups.push(cleanup);
    return { cleanup, forgetSession };
  }

  /**
   * The wiring of `src/v2.ts`: the plugin instance creates its own telemetry ingest (settings from its live config,
   * pricing from the catalog) and hands it to the adapter (QA-2.1-7).
   */
  async function startPlugin(f: ReturnType<typeof fixture>, model: ReturnType<typeof catalog>, home: string, wrap: (hooks: Hooks) => Hooks = (hooks) => hooks) {
    let ingest: Ingest | undefined;
    const hooks = await ModelRouterPlugin({
      directory: home, worktree: home, routerHost: "v2",
      client: { session: { get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id } }) } },
      routerCatalog: async () => (await model.list()).data,
      routerOnIngest: (created: Ingest) => { ingest = created; },
    } as unknown as RouterPluginInput);
    expect(ingest).toBeDefined();
    return start(f, model, wrap(hooks), { ingest });
  }

  /** Events are handled in order: once the barrier session's deletion is seen, everything before it was handled. */
  async function barrier(f: ReturnType<typeof fixture>, forgetSession: ReturnType<typeof vi.fn>, name: string) {
    f.emit({ id: `barrier-${name}`, type: "session.deleted", data: { sessionID: name } });
    await vi.waitFor(() => expect(forgetSession).toHaveBeenCalledWith(name));
  }

  const stepEvent = (id: string, sessionID: string, over: { finish?: string; cost?: number } = {}) => ({
    id, type: "session.step.ended",
    data: {
      sessionID, assistantMessageID: `m-${id}`, finish: over.finish ?? "tool-calls", rawFinish: "stop", cost: over.cost ?? 0.01,
      tokens: { input: 1000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  });

  const register = (child: string, over: Partial<Parameters<typeof rememberDispatch>[1]> = {}) => rememberDispatch(child, {
    facts: FACTS, agent: "medium", model: "anthropic/claude-sonnet-5-5", variant: "medium", tier: "medium", parentSessionID: "root", ...over,
  });

  afterEach(() => { resetDispatchRegistry(); resetIngestState(); logger.warn.mockReset(); });

  it("records a registered child's steps, with catalog pricing, when engine != static", async () => {
    const { home, outcomes } = routingHome({ engine: "shadow" });
    const f = fixture();
    const model = catalog();
    const { cleanup, forgetSession } = await startPlugin(f, model, home);
    register("child-1");
    f.emit(stepEvent("e1", "child-1", { finish: "tool-calls", cost: 0.01 }));
    f.emit(stepEvent("e2", "child-1", { finish: "stop", cost: 0.02 }));
    f.emit({ id: "x1", type: "session.execution.succeeded", data: { sessionID: "child-1" } }); // the attempt folds here
    await barrier(f, forgetSession, "barrier");
    const peek = acquireOutcomes({ dir: outcomes, tuning: DEFAULT_OUTCOME_TUNING, logger });
    try {
      const cost = peek.store.cost(KEY);
      expect(cost.measuredUSD.n).toBe(1);
      expect(cost.measuredUSD.mean).toBeCloseTo(0.03, 9);
      expect(cost.tokens).toMatchObject({ n: 1, input: 2000, output: 200 });
      expect(model.list).toHaveBeenCalledTimes(1);
    } finally {
      await peek.release();
    }
    await cleanup(); // flushes through the D15 flusher on dispose
    expect(existsSync(join(outcomes, "outcomes.json"))).toBe(true);
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("QA-2.3-2: a child's context is readable only after its execution end event, in every engine mode (static here)", async () => {
    const { home, outcomes } = routingHome(); // a routing block without an engine: static
    const f = fixture();
    const { cleanup, forgetSession } = await startPlugin(f, catalog(), home);
    register("child-1");
    f.emit(stepEvent("e1", "child-1", { finish: "stop" }));
    await barrier(f, forgetSession, "barrier-1");
    expect(lastStepContext("child-1")).toBeNull(); // the final step may still be queued behind the stream's events
    f.emit({ id: "x1", type: "session.execution.succeeded", data: { sessionID: "child-1" } });
    await barrier(f, forgetSession, "barrier-2");
    expect(lastStepContext("child-1")).toBe(1100);
    await cleanup();
    expect(readdirSync(outcomes).filter((name) => name !== "pending.jsonl")).toEqual([]); // v2 pending journal (2.1.4) is the one visible file // memory only: nothing was written
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("QA-2.3-R2-1: the adapter passes the event id, so a copy of an end event delivered after a re-registration is ignored", async () => {
    const { home, outcomes } = routingHome();
    const f = fixture();
    const { cleanup, forgetSession } = await startPlugin(f, catalog(), home);
    register("child-1");
    f.emit(stepEvent("e1", "child-1", { finish: "stop" }));
    f.emit({ id: "end-1", type: "session.execution.succeeded", data: { sessionID: "child-1" } });
    await barrier(f, forgetSession, "barrier-1");
    expect(lastStepContext("child-1")).toBe(1100);
    register("child-1"); // the runner resumes the child: attempt N+1
    f.emit(stepEvent("e2", "child-1", { finish: "tool-calls" }));
    f.emit({ id: "end-1", type: "session.execution.succeeded", data: { sessionID: "child-1" } }); // the same event, delivered again
    await barrier(f, forgetSession, "barrier-2");
    expect(lastStepContext("child-1")).toBeNull();
    f.emit({ id: "end-2", type: "session.execution.succeeded", data: { sessionID: "child-1" } });
    await barrier(f, forgetSession, "barrier-3");
    expect(lastStepContext("child-1")).toBe(1100);
    await cleanup();
    expect(readdirSync(outcomes).filter((name) => name !== "pending.jsonl")).toEqual([]); // v2 pending journal (2.1.4) is the one visible file
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });  it("ignores step events of sessions that are not registered children", async () => {
    const { home, outcomes } = routingHome({ engine: "shadow" });
    const f = fixture();
    const model = catalog();
    const { cleanup, forgetSession } = await startPlugin(f, model, home);
    f.emit(stepEvent("e1", "orchestrator"));
    f.emit({ id: "e2", type: "session.step.ended", data: { assistantMessageID: "no-session" } });
    await barrier(f, forgetSession, "barrier");
    await cleanup();
    expect(readdirSync(outcomes).filter((name) => name !== "pending.jsonl")).toEqual([]); // v2 pending journal (2.1.4) is the one visible file
    expect(model.list).not.toHaveBeenCalled();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("DF-1-5: a root run's end writes its turns row, with a subagent start still open and no prompt hook", async () => {
    const { home, outcomes } = routingHome();
    const f = fixture();
    const { cleanup, forgetSession } = await start(f, catalog());
    f.emit({ id: "c-root", type: "session.created", data: { sessionID: "root-r" } }); // no parentID: a root session
    await barrier(f, forgetSession, "barrier-1");
    const call = { sessionID: "root-r", agent: "build", messageID: "m", id: "call-df15", tool: "subagent", input: { agent: "medium", prompt: "Patch it", background: true } as Record<string, unknown> };
    await f.toolHooks["execute.before"](call); // its start stays open: the child keeps running in the background
    f.emit(stepEvent("s1", "root-r"));
    f.emit(stepEvent("s2", "root-r"));
    f.emit({ id: "x-root", type: "session.execution.succeeded", data: { sessionID: "root-r" } }); // the kickoff run ends
    await barrier(f, forgetSession, "barrier-2");
    const turns = join(outcomes, "turns.jsonl");
    expect(existsSync(turns)).toBe(true);
    const rows = readFileSync(turns, "utf8").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows).toEqual([expect.objectContaining({ kind: "orchestrator-turn", sessionID: "root-r", turn: 1, steps: 2, input: 2000, cacheRead: 0, cacheWrite: 0 })]);
    await cleanup();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it.each([
    { name: "no routing block at all", routing: null },
    { name: "a routing block without an engine", routing: {} },
    { name: "engine static", routing: { engine: "static" } },
  ])("$name (static): nothing is written to the explicit outcomes directory and the catalog is never read", async ({ routing }) => {
    const { home, outcomes } = routingHome(routing);
    const f = fixture();
    const model = catalog();
    const { cleanup, forgetSession } = await startPlugin(f, model, home);
    register("child-1");
    f.emit(stepEvent("e1", "child-1", { finish: "stop" }));
    f.emit({ id: "i1", type: "session.execution.succeeded", data: { sessionID: "child-1" } });
    await barrier(f, forgetSession, "barrier");
    await cleanup();
    expect(readdirSync(outcomes).filter((name) => name !== "pending.jsonl")).toEqual([]); // v2 pending journal (2.1.4) is the one visible file
    // tmpdir() is private to this file (QA-2.1-4), but earlier tests of the file leave scorecards in its default directory:
    // what must not appear there is an outcome store or a decision log.
    const defaultDir = join(tmpdir(), DEFAULT_OUTCOMES_DIRNAME);
    expect(existsSync(defaultDir) ? readdirSync(defaultDir).filter((name) => /^(outcomes|decisions)/.test(name)) : []).toEqual([]);
    expect(model.list).not.toHaveBeenCalled();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("records nothing under a class below routing.minClassConfidence", async () => {
    const { home, outcomes } = routingHome({ engine: "shadow", minClassConfidence: 0.7 });
    const f = fixture();
    const { cleanup, forgetSession } = await startPlugin(f, catalog(), home);
    register("child-low", { facts: { ...FACTS, confidence: 0.69 } });
    f.emit(stepEvent("e1", "child-low", { finish: "stop" }));
    await barrier(f, forgetSession, "barrier");
    await cleanup();
    expect(readdirSync(outcomes).filter((name) => name !== "pending.jsonl")).toEqual([]); // v2 pending journal (2.1.4) is the one visible file
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("counts a step once when the same event id reaches two plugin instances (A3)", async () => {
    const { home, outcomes } = routingHome({ engine: "shadow" });
    const a = fixture();
    const b = fixture();
    const first = await startPlugin(a, catalog(), home);
    const second = await startPlugin(b, catalog(), home);
    register("child-1");
    const event = stepEvent("same-id", "child-1", { finish: "stop", cost: 0.02 });
    a.emit(event);
    b.emit(event);
    a.emit({ id: "x-a", type: "session.execution.succeeded", data: { sessionID: "child-1" } });
    await barrier(a, first.forgetSession, "barrier-a");
    await barrier(b, second.forgetSession, "barrier-b");
    const peek = acquireOutcomes({ dir: outcomes, tuning: DEFAULT_OUTCOME_TUNING, logger });
    try {
      expect(peek.store.cost(KEY).steps.n).toBe(1);
      expect(peek.store.cost(KEY).measuredUSD.mean).toBeCloseTo(0.02, 9);
    } finally {
      await peek.release();
    }
    await first.cleanup();
    await second.cleanup();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("session.deleted drops the child's registration and still reaches the legacy event hook", async () => {
    const { home } = routingHome({ engine: "shadow" });
    const f = fixture();
    const legacyEvent = vi.fn(async () => {});
    const { forgetSession } = await startPlugin(f, catalog(), home, (hooks) => ({ ...hooks, event: legacyEvent }));
    register("child-1");
    f.emit({ id: "d1", type: "session.deleted", data: { sessionID: "child-1" } });
    await vi.waitFor(() => expect(forgetSession).toHaveBeenCalledWith("child-1"));
    await vi.waitFor(() => expect(legacyEvent).toHaveBeenCalledWith({ event: { type: "session.deleted", properties: { info: { id: "child-1" } } } }, undefined));
    const { lookupDispatch } = await import("../../src/router/sessions");
    expect(lookupDispatch("child-1")).toBeUndefined();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  describe("src/v2.ts setup (the real wiring)", () => {
    it("feeds the plugin's own ingest from the adapter: steps, execution end and pricing", async () => {
      const { home, outcomes } = routingHome({ engine: "shadow" });
      const f = fixture();
      const model = catalog();
      const cleanup = await v2Plugin.setup({ ...f.ctx, model } as unknown as Plugin.Context);
      cleanups.push(cleanup);
      register("child-1");
      f.emit(stepEvent("e1", "child-1", { finish: "stop", cost: 0 }));
      f.emit({ id: "x1", type: "session.execution.succeeded", data: { sessionID: "child-1" } });
      const peek = acquireOutcomes({ dir: outcomes, tuning: DEFAULT_OUTCOME_TUNING, logger });
      try {
        await vi.waitFor(() => expect(peek.store.cost(KEY).steps.n).toBe(1));
        // priced by the catalog the adapter read: a priced model's zero is a measurement
        expect(peek.store.cost(KEY).measuredUSD).toMatchObject({ n: 1, mean: 0 });
        expect(model.list).toHaveBeenCalledTimes(1);
      } finally {
        await peek.release();
      }
      await cleanup();
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    });

    it("QA-2.1-5: disposing does not wait for a model catalog that never answers", async () => {
      const { home } = routingHome({ engine: "shadow" });
      const f = fixture();
      const model = { list: vi.fn(() => new Promise<never>(() => {})) };
      const cleanup = await v2Plugin.setup({ ...f.ctx, model } as unknown as Plugin.Context);
      cleanups.push(cleanup);
      register("child-1");
      f.emit(stepEvent("e1", "child-1", { finish: "tool-calls" }));
      await vi.waitFor(() => expect(model.list).toHaveBeenCalledTimes(1)); // the step handler is now waiting for the catalog
      const started = performance.now();
      await cleanup();
      expect(performance.now() - started).toBeLessThan(1000); // the catalog wait itself is bounded by 2 s
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    });
  });

  describe("with an injected ingest", () => {
    const fake = () => ({
      onStepEnded: vi.fn(async () => {}), onExecutionEnded: vi.fn(), onVerdict: vi.fn(), onFalseRefusal: vi.fn(), onSessionGone: vi.fn(),
      requestFlush: vi.fn(), sweep: vi.fn(), dispose: vi.fn(async () => {}),
    } satisfies Ingest);

    it("survives a throwing handler: it is logged and the next event is still handled", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const ingest = fake();
        ingest.onStepEnded.mockRejectedValueOnce(new Error("handler exploded"));
        const f = fixture();
        const legacyEvent = vi.fn(async () => {});
        const { forgetSession } = await start(f, catalog(), { event: legacyEvent }, { ingest });
        f.emit(stepEvent("e1", "child-1"));
        f.emit(stepEvent("e2", "child-1"));
        f.emit({ id: "d1", type: "session.deleted", data: { sessionID: "child-2" } });
        await vi.waitFor(() => expect(forgetSession).toHaveBeenCalledWith("child-2"));
        expect(ingest.onStepEnded).toHaveBeenCalledTimes(2);
        expect(warn.mock.calls.some((args) => String(args[0]).includes("telemetry ingestion") && String(args[0]).includes("session.step.ended"))).toBe(true);
        // the deletion after the failure still ran both the ingest cleanup and the legacy translation
        expect(ingest.onSessionGone).toHaveBeenCalledWith("child-2");
        expect(legacyEvent).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
    });

    it("a throwing session cleanup does not stop the legacy event translation", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const ingest = fake();
        ingest.onSessionGone.mockImplementationOnce(() => { throw new Error("cleanup exploded"); });
        const f = fixture();
        const legacyEvent = vi.fn(async () => {});
        await start(f, catalog(), { event: legacyEvent }, { ingest });
        f.emit({ id: "d1", type: "session.deleted", data: { sessionID: "child-1" } });
        await vi.waitFor(() => expect(legacyEvent).toHaveBeenCalledTimes(1));
        expect(warn.mock.calls.some((args) => String(args[0]).includes("cleanup") || String(args[0]).includes("session.deleted"))).toBe(true);
      } finally {
        warn.mockRestore();
      }
    });

    it("QA-2.1-6: routes failed steps to ingest like finished ones", async () => {
      const ingest = fake();
      const f = fixture();
      const { forgetSession } = await start(f, catalog(), {}, { ingest });
      f.emit({ id: "f1", type: "session.step.failed", data: { sessionID: "child-1", cost: 0.01 } });
      await barrier(f, forgetSession, "barrier");
      expect(ingest.onStepEnded).toHaveBeenCalledTimes(1);
      expect(ingest.onStepEnded).toHaveBeenCalledWith(expect.objectContaining({ type: "session.step.failed" }));
    });

    it("flushes and sweeps on the idle equivalents, not on unrelated events, and disposes on cleanup", async () => {
      const ingest = fake();
      const f = fixture();
      const { cleanup, forgetSession } = await start(f, catalog(), {}, { ingest });
      for (const type of ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted", "session.idle"]) {
        f.emit({ id: type, type, data: { sessionID: "s" } });
      }
      f.emit({ id: "t1", type: "session.text.ended", data: { sessionID: "s", text: "hello" } });
      f.emit({ id: "c1", type: "session.created", data: { sessionID: "s" } });
      await barrier(f, forgetSession, "barrier");
      expect(ingest.requestFlush).toHaveBeenCalledTimes(4);
      expect(ingest.sweep).toHaveBeenCalledTimes(4);
      // QA-2.1-6: the three execution-end events (not the literal idle) end the child's attempt
      expect(ingest.onExecutionEnded).toHaveBeenCalledTimes(3);
      // QA-2.3-R2-1: each call carries its event's id, so a second delivery of the same event can be recognised
      for (const type of ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]) {
        expect(ingest.onExecutionEnded).toHaveBeenCalledWith("s", type);
      }
      expect(ingest.onStepEnded).not.toHaveBeenCalled();
      expect(ingest.dispose).not.toHaveBeenCalled();
      await cleanup();
      await cleanup();
      expect(ingest.dispose).toHaveBeenCalledTimes(1);
    });
  });
});
