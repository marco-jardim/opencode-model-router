import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { RouterPlanArgs } from "../../src/executor/tool";
import { ROUTER_PLAN_ACTIONS } from "../../src/executor/tool";
import type { ExecutorAccess } from "../../src/executor/create";

vi.mock("../../src/verify/reference", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/verify/reference")>()),
  gcStaleReferences: async () => ({ removed: [], kept: [], failed: [] }),
}));

type Hooks = {
  tool: Record<string, { execute(args: RouterPlanArgs, context: { sessionID: string; directory: string }): Promise<string> }>;
  config(output: { command: Record<string, unknown>; agent: Record<string, unknown> }): Promise<void>;
  "command.execute.before"(input: { command: string; arguments: string; sessionID: string }, output: { parts: { type: string; text: string }[] }): Promise<void>;
  dispose(): Promise<void>;
};

describe("plan registration (Phase 5.1.2)", () => {
  const envKeys = ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "TMP", "TEMP", "TMPDIR", "MODEL_ROUTER_ENFORCE"] as const;
  let saved: Record<string, string | undefined>;
  let home = "";
  let project = "";
  const plugins: Hooks[] = [];

  beforeEach(() => {
    vi.resetModules(); // Re-arm the process notice only between tests; plugin instances within a test still share it.
    saved = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
    home = mkdtempSync(join(tmpdir(), "omr-plan-registration-"));
    project = join(home, "project");
    mkdirSync(project, { recursive: true });
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.APPDATA = join(home, "AppData/Roaming");
    process.env.LOCALAPPDATA = join(home, "AppData/Local");
    process.env.XDG_CONFIG_HOME = join(home, ".config");
    process.env.XDG_STATE_HOME = join(home, ".local/state");
    process.env.XDG_DATA_HOME = join(home, ".local/share");
    const temp = join(home, "temp");
    mkdirSync(temp, { recursive: true });
    for (const key of ["TMP", "TEMP", "TMPDIR"] as const) process.env[key] = temp;
    process.env.MODEL_ROUTER_ENFORCE = "1";
  });

  afterEach(async () => {
    for (const hooks of plugins.splice(0)) await hooks.dispose();
    vi.restoreAllMocks();
    for (const key of envKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  async function configure(config: Record<string, unknown>) {
    const { overridePath, invalidateConfigCache } = await import("../../src/router/config");
    const file = overridePath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(config), "utf8");
    invalidateConfigCache();
  }

  async function plugin(host: "v1" | "v2", access?: ExecutorAccess, failLookup = false, onAccess?: () => void) {
    const { default: ModelRouterPlugin } = await import("../../src/index");
    const get = vi.fn(async ({ path }: { path: { id: string } }) => {
      if (failLookup) throw new Error("session lookup unavailable");
      return { data: { ...(path.id === "root" ? {} : { parentID: "root" }) } };
    });
    const ctx = {
      directory: project, worktree: project, project: {}, serverUrl: new URL("http://localhost"), $: () => undefined,
      ...(host === "v2" ? { routerHost: "v2" as const } : {}),
      get routerExecutor() { onAccess?.(); return access; },
      client: { session: {
        get, create: async () => ({ data: { id: "never" } }), prompt: async () => ({ data: { parts: [] } }),
        abort: async () => ({}), delete: async () => ({}),
      } },
    };
    const hooks = await ModelRouterPlugin(ctx as unknown as Parameters<typeof ModelRouterPlugin>[0]) as unknown as Hooks;
    plugins.push(hooks);
    return hooks;
  }

  async function command(hooks: Hooks, name: string, args = "", sessionID = "root") {
    const output = { parts: [] as { type: string; text: string }[] };
    await hooks["command.execute.before"]({ command: name, arguments: args, sessionID }, output);
    return output.parts;
  }

  const call = (hooks: Hooks, args: RouterPlanArgs, sessionID = "root") => hooks.tool.router_plan!.execute(args, { sessionID, directory: project });

  it.each(["tiers", "roles"])("v2 registers router_plan, command.plan and /router help in %s mode", async (delegation) => {
    await configure({ routing: { delegation } });
    const hooks = await plugin("v2");
    expect(hooks.tool).toHaveProperty("router_plan");
    const output = { command: {}, agent: {} };
    await hooks.config(output);
    expect(output.command).toHaveProperty("plan", expect.objectContaining({ template: "$ARGUMENTS" }));
    expect((await command(hooks, "router")).map(part => part.text).join("\n")).toContain("/plan");
  });

  it("without an executor, router_plan status and /plan status answer the unavailable reason", async () => {
    const { createExecutorAccess } = await import("../../src/executor/create");
    const access = createExecutorAccess();
    access.clear("routing.delegation must be roles at start");
    const hooks = await plugin("v2", access);
    expect(await call(hooks, { action: "status" })).toContain(access.unavailable());
    expect((await command(hooks, "plan", "status"))[0]?.text).toContain(access.unavailable());
  });

  it("reads routerExecutor lazily, never during plugin initialization", async () => {
    const { createExecutorAccess } = await import("../../src/executor/create");
    const read = vi.fn();
    const hooks = await plugin("v2", createExecutorAccess(), false, read);
    expect(read).not.toHaveBeenCalled();
    expect(await call(hooks, { action: "status" })).toContain("not initialized");
    expect(read).toHaveBeenCalled();
  });

  it("resolves the runtime after plugin initialization and reports its later absence", async () => {
    const { createExecutorAccess, lateRuntime } = await import("../../src/executor/create");
    const access = createExecutorAccess();
    const hooks = await plugin("v2", access);
    expect(await call(hooks, { action: "status" })).toContain("not initialized");
    const status = vi.fn(async () => "late-bound status");
    access.set({ ...lateRuntime(createExecutorAccess()), status });
    expect(await call(hooks, { action: "status" })).toContain("late-bound status");
    expect(status).toHaveBeenCalledTimes(1);
    expect((await command(hooks, "plan", "status"))[0]?.text).toContain('"action":"status"');
    access.clear("disposed");
    expect(await call(hooks, { action: "status" })).toContain("disposed");
  });

  it("reads the resolved executor approve setting at call time", async () => {
    const { createExecutorAccess, lateRuntime } = await import("../../src/executor/create");
    const access = createExecutorAccess();
    access.set({ ...lateRuntime(createExecutorAccess()), status: async () => "Plan p1 [awaiting-approval] plan.md" });
    await configure({ routing: { executor: { approve: "ask" } } });
    const hooks = await plugin("v2", access);
    expect(await call(hooks, { action: "status", planId: "p1" })).toContain("Stop here. This plan is not approved.");
    await configure({ routing: { executor: { approve: "auto" } } });
    expect(await call(hooks, { action: "status", planId: "p1" })).not.toContain("Stop here.");
  });

  it("refuses plan actions without a calling session", async () => {
    const hooks = await plugin("v2");
    expect(await call(hooks, { action: "status" }, "")).toContain("require a root orchestrator session");
    expect((await command(hooks, "plan", "approve p1", ""))[0]?.text).toContain("require a root orchestrator session");
    expect((await command(hooks, "plan", "adopt p1", ""))[0]?.text).toContain("require a root orchestrator session");
  });

  it.each(ROUTER_PLAN_ACTIONS)("refuses router_plan action=%s in an ordinary child session", async (action) => {
    const hooks = await plugin("v2");
    expect(await call(hooks, { action, planId: "p1" }, "child")).toContain("require a root orchestrator session");
  });

  it.each(["approve", "adopt"])("refuses /plan %s in an ordinary child session", async (action) => {
    const hooks = await plugin("v2");
    expect((await command(hooks, "plan", `${action} p1`, "child"))[0]?.text).toContain("require a root orchestrator session");
  });

  it("fails closed when the calling session's parent cannot be resolved", async () => {
    const hooks = await plugin("v2", undefined, true);
    expect(await call(hooks, { action: "status" })).toContain("require a root orchestrator session");
    expect((await command(hooks, "plan", "approve p1"))[0]?.text).toContain("require a root orchestrator session");
    expect((await command(hooks, "plan", "adopt p1"))[0]?.text).toContain("require a root orchestrator session");
  });

  it("permits an exactly bound plan child, but not an unbound child", async () => {
    const { createExecutorAccess, lateRuntime } = await import("../../src/executor/create");
    const { bindPlanChild, evict } = await import("../../src/routing/roles/binding");
    const access = createExecutorAccess();
    const status = vi.fn(async () => "plan-child status");
    access.set({ ...lateRuntime(createExecutorAccess()), status });
    const hooks = await plugin("v2", access);
    bindPlanChild({ childSessionID: "plan-child", role: "implement", agent: "implementer", workRoot: project,
      grant: [], planId: "p1", taskId: "t1", attempt: 1 });
    try {
      expect(await call(hooks, { action: "status" }, "plan-child")).toContain("plan-child status");
      expect((await command(hooks, "plan", "approve p1", "plan-child"))[0]?.text).toContain('"action":"approve"');
      expect((await command(hooks, "plan", "adopt p1", "plan-child"))[0]?.text).toContain('"action":"adopt"');
      expect(await call(hooks, { action: "status" }, "other-child")).toContain("require a root orchestrator session");
      expect(status).toHaveBeenCalledTimes(1);
    } finally { evict("plan-child"); }
  });

  it("v1 registers no plan tool or command, and configured keys plus /plan uses share one notice per process", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await configure({ routing: { executor: { approve: "auto", maxParallel: 2 } } });
    for (let n = 0; n < 2; n++) {
      const hooks = await plugin("v1", undefined, false, () => { throw new Error("v1 must never read routerExecutor"); });
      expect(hooks.tool).not.toHaveProperty("router_plan");
      const output = { command: {}, agent: {} };
      await hooks.config(output);
      expect(output.command).not.toHaveProperty("plan");
      expect(await command(hooks, "plan", "approve p1")).toEqual([]);
      expect(await command(hooks, "plan", "adopt p1")).toEqual([]);
      expect((await command(hooks, "router")).map(part => part.text).join("\n")).not.toContain("/plan");
    }
    const notices = warn.mock.calls.map(([message]) => String(message)).filter(message => message.includes("the plan executor requires OpenCode v2"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("routing.executor.approve");
    expect(notices[0]).toContain("routing.executor.maxParallel");
  });

  it("v1 best-effort /plan use without configured keys logs once and never adds an output part", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const hooks = await plugin("v1");
    expect(await command(hooks, "plan", "status")).toEqual([]);
    expect(await command(hooks, "plan", "status")).toEqual([]);
    const notices = warn.mock.calls.map(([message]) => String(message)).filter(message => message.includes("the plan executor requires OpenCode v2"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("ignored: /plan");
  });
});
