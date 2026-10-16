import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
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
  const childSessionCreators = new WeakMap<Hooks, () => Promise<string>>();

  beforeEach(async () => {
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
    // G-5: caller/access/conflict tests exercise the registered surface, now roles-at-start only.
    await configure({ routing: { delegation: "roles" } });
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
    const childSessions = new Map<string, { id: string; parentID: string }>();
    const create = async ({ body }: { body: { parentID: string } }) => {
      const session = { id: `plan-registration-child-${randomUUID()}`, parentID: body.parentID };
      childSessions.set(session.id, session);
      return { data: session };
    };
    const get = vi.fn(async ({ path }: { path: { id: string } }) => {
      if (failLookup) throw new Error("session lookup unavailable");
      return { data: childSessions.get(path.id) ?? { ...(path.id === "root" ? {} : { parentID: "root" }) } };
    });
    const ctx = {
      directory: project, worktree: project, project: {}, serverUrl: new URL("http://localhost"), $: () => undefined,
      ...(host === "v2" ? { routerHost: "v2" as const } : {}),
      get routerExecutor() { onAccess?.(); return access; },
      client: { session: {
        get, create, prompt: async () => ({ data: { parts: [] } }),
        abort: async () => ({}), delete: async () => ({}),
      } },
    };
    const hooks = await ModelRouterPlugin(ctx as unknown as Parameters<typeof ModelRouterPlugin>[0]) as unknown as Hooks;
    plugins.push(hooks);
    childSessionCreators.set(hooks, async () => (await ctx.client.session.create({ body: { parentID: "root" } })).data.id);
    return hooks;
  }

  async function createChildSession(hooks: Hooks): Promise<string> {
    const create = childSessionCreators.get(hooks);
    if (create === undefined) throw new Error("plugin fixture has no child session creator");
    // Production creates a fresh host session before binding it; evicted IDs must never be reused.
    return create();
  }

  async function command(hooks: Hooks, name: string, args = "", sessionID = "root") {
    const output = { parts: [] as { type: string; text: string }[] };
    await hooks["command.execute.before"]({ command: name, arguments: args, sessionID }, output);
    return output.parts;
  }

  const call = (hooks: Hooks, args: RouterPlanArgs, sessionID = "root") => hooks.tool.router_plan!.execute(args, { sessionID, directory: project });

  it("v2 roles mode registers router_plan, command.plan and /router help like router_run", async () => {
    const hooks = await plugin("v2");
    expect(hooks.tool).toHaveProperty("router_plan");
    expect(hooks.tool).toHaveProperty("router_run");
    const output = { command: {}, agent: {} };
    await hooks.config(output);
    expect(output.command).toHaveProperty("plan", expect.objectContaining({ template: "$ARGUMENTS" }));
    expect((await command(hooks, "router")).map(part => part.text).join("\n")).toContain("/plan");
  });

  it("v2 tiers mode registers neither plan surface nor help, even after switching to roles without a restart", async () => {
    await configure({ routing: { delegation: "tiers" } });
    const hooks = await plugin("v2");
    for (const delegation of ["tiers", "roles"]) {
      await configure({ routing: { delegation } });
      expect(hooks.tool).not.toHaveProperty("router_plan");
      expect(hooks.tool).not.toHaveProperty("router_run");
      const output = { command: {}, agent: {} };
      await hooks.config(output);
      expect(output.command).not.toHaveProperty("plan");
      expect((await command(hooks, "router")).map(part => part.text).join("\n")).not.toContain("/plan");
      expect(await command(hooks, "plan", "status")).toEqual([]);
    }
  });

  it("without an executor, router_plan status and /plan status answer the unavailable reason", async () => {
    const { createExecutorAccess } = await import("../../src/executor/create");
    const access = createExecutorAccess();
    // Roles still register the surfaces when another assembly prerequisite is missing.
    await configure({ routing: { delegation: "roles", leases: { mode: "off" } } });
    access.clear("routing.leases.mode must be enforce");
    const hooks = await plugin("v2", access);
    expect(await call(hooks, { action: "status" })).toContain(access.unavailable());
    expect((await command(hooks, "plan", "status"))[0]?.text).toContain(access.unavailable());
    expect((await command(hooks, "router")).map(part => part.text).join("\n")).not.toContain("/plan");
  });

  it("v2 preserves a user-defined /plan, warns once, and keeps router_plan available", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { createExecutorAccess, lateRuntime } = await import("../../src/executor/create");
    const access = createExecutorAccess();
    access.set({ ...lateRuntime(createExecutorAccess()), status: async () => "tool still available" });
    const hooks = await plugin("v2", access);
    const userPlan = { template: "My own plan: $ARGUMENTS", description: "User plan" };
    const output = { command: { plan: userPlan }, agent: {} };
    await hooks.config(output);
    await hooks.config(output);
    expect(output.command.plan).toBe(userPlan);
    expect(await command(hooks, "plan", "status")).toEqual([]);
    expect((await command(hooks, "router")).map(part => part.text).join("\n")).not.toContain("/plan");
    expect(await call(hooks, { action: "status" })).toContain("tool still available");
    const conflicts = warn.mock.calls.map(([message]) => String(message)).filter(message => message.includes("/plan command conflict"));
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toContain("user-defined /plan");
    expect(conflicts[0]).toContain("router_plan remains available");
  });

  it("v2 config reloads do not mistake the executor's /plan registration for a user command", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { createExecutorAccess, lateRuntime } = await import("../../src/executor/create");
    const access = createExecutorAccess();
    access.set(lateRuntime(createExecutorAccess()));
    const hooks = await plugin("v2", access);
    const output = { command: {}, agent: {} };
    await hooks.config(output);
    await hooks.config(output);
    const sibling = await plugin("v2", access);
    await sibling.config(output);
    expect((await command(sibling, "plan", "status"))[0]?.text).toContain('"action":"status"');
    expect((await command(hooks, "plan", "status"))[0]?.text).toContain('"action":"status"');
    expect(warn.mock.calls.map(([message]) => String(message)).filter(message => message.includes("/plan command conflict"))).toEqual([]);
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
    await configure({ routing: { delegation: "roles", executor: { approve: "ask" } } });
    const hooks = await plugin("v2", access);
    expect(await call(hooks, { action: "status", planId: "p1" })).toContain("Stop here. This plan is not approved.");
    await configure({ routing: { delegation: "roles", executor: { approve: "auto" } } });
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

  it("a plan binding cannot authorize mutation when the parent lookup fails", async () => {
    const { bindPlanChild, evict } = await import("../../src/routing/roles/binding");
    const hooks = await plugin("v2", undefined, true);
    const childSessionID = await createChildSession(hooks);
    bindPlanChild({ childSessionID, role: "implement", agent: "implementer", workRoot: project,
      grant: [], planId: "p1", taskId: "t1", attempt: 1 });
    try {
      expect(await call(hooks, { action: "approve", planId: "p1" }, childSessionID)).toContain("require a root orchestrator session");
      expect((await command(hooks, "plan", "adopt p1", childSessionID))[0]?.text).toContain("require a root orchestrator session");
    } finally { evict(childSessionID); }
  });

  it("permits only own-plan reads for an exactly bound plan child, never authority actions", async () => {
    const { createExecutorAccess, lateRuntime } = await import("../../src/executor/create");
    const { bindPlanChild, evict } = await import("../../src/routing/roles/binding");
    const access = createExecutorAccess();
    const status = vi.fn(async (_planId: string | null) => "plan-child status");
    const ready = vi.fn(async () => ({ launchable: [], manual: [] }));
    const exportPlan = vi.fn(async () => "plan-child export");
    const approve = vi.fn(async () => undefined);
    const adopt = vi.fn(async () => undefined);
    const answer = vi.fn(async () => undefined);
    const abort = vi.fn(async () => undefined);
    access.set({ ...lateRuntime(createExecutorAccess()), status, ready, exportPlan, approve, adopt, answer, abort });
    const hooks = await plugin("v2", access);
    const childSessionID = await createChildSession(hooks);
    bindPlanChild({ childSessionID, role: "implement", agent: "implementer", workRoot: project,
      grant: [], planId: "p1", taskId: "t1", attempt: 1 });
    try {
      expect(await call(hooks, { action: "status", planId: "p1" }, childSessionID)).toContain("plan-child status");
      for (const action of ROUTER_PLAN_ACTIONS.filter(action => !["status", "ready", "export"].includes(action))) {
        const args: RouterPlanArgs = action === "compile" ? { action, path: "plan.md" }
          : action === "gc" ? { action }
            : action === "answer" ? { action, planId: "p1", inboxId: "Q-1", text: "answer" }
              : action === "done" ? { action, planId: "p1", task: "t1" }
                : action === "residue" || action === "add-tasks" ? { action, planId: "p1", text: "{}" }
                  : { action, planId: "p1" };
        expect(await call(hooks, args, childSessionID)).toContain("require a root orchestrator session");
      }
      for (const action of ["approve", "adopt", "answer", "abort", "pause", "resume", "land"] as const) {
        const args = action === "answer" ? "answer --plan p1 item answer" : `${action} p1`;
        expect((await command(hooks, "plan", args, childSessionID))[0]?.text).toContain("require a root orchestrator session");
      }
      expect((await command(hooks, "plan", "run plan.md", childSessionID))[0]?.text).toContain("require a root orchestrator session");
      expect((await command(hooks, "plan", "status p1", childSessionID))[0]?.text).toContain('"action":"status","planId":"p1"');
      expect((await command(hooks, "plan", "inbox --plan p1", childSessionID))[0]?.text).toContain('"inbox":true,"planId":"p1"');
      expect(await call(hooks, { action: "status", planId: "p2" }, childSessionID)).toContain("require a root orchestrator session");
      expect((await command(hooks, "plan", "status p2", childSessionID))[0]?.text).toContain("require a root orchestrator session");
      expect((await command(hooks, "plan", "inbox --plan p2", childSessionID))[0]?.text).toContain("require a root orchestrator session");
      for (const action of ["ready", "export"] as const) {
        expect(await call(hooks, { action, planId: "p1" }, childSessionID)).toContain(action === "ready" ? "plan p1 ready:" : "plan-child export");
        expect(await call(hooks, { action, planId: "p2" }, childSessionID)).toContain("require a root orchestrator session");
      }
      expect(await call(hooks, { action: "status", planId: "p1", inbox: true }, childSessionID)).not.toContain("require a root orchestrator session");
      expect(await call(hooks, { action: "status", planId: "p2", inbox: true }, childSessionID)).toContain("require a root orchestrator session");
      expect(await call(hooks, { action: "status" }, childSessionID)).toContain("require a root orchestrator session");
      expect((await command(hooks, "plan", "inbox", childSessionID))[0]?.text).toContain("require a root orchestrator session");
      expect(await call(hooks, { action: "status" }, "other-child")).toContain("require a root orchestrator session");
      expect(status).toHaveBeenCalledTimes(3);
      expect(status.mock.calls.every(([planId]) => planId === "p1")).toBe(true);
      expect(ready).toHaveBeenCalledTimes(1);
      expect(exportPlan).toHaveBeenCalledTimes(1);
      for (const mutation of [approve, adopt, answer, abort]) expect(mutation).not.toHaveBeenCalled();
    } finally { evict(childSessionID); }
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

  it("v1 preserves a user-defined /plan without claiming that it was ignored", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const hooks = await plugin("v1");
    const userPlan = { template: "My own plan: $ARGUMENTS", description: "User plan" };
    const output = { command: { plan: userPlan }, agent: {} };
    await hooks.config(output);
    expect(output.command.plan).toBe(userPlan);
    expect(await command(hooks, "plan", "status")).toEqual([]);
    expect(await command(hooks, "plan", "status")).toEqual([]);
    expect(warn.mock.calls.map(([message]) => String(message)).filter(message => message.includes("ignored: /plan"))).toEqual([]);
  });
});
