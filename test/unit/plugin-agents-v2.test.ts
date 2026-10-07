import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "@opencode/plugin/promise/plugin";
import { Agent } from "@opencode/plugin";
import type { Hooks } from "@opencode-ai/plugin";
import type { PermissionEvaluation } from "@opencode/plugin/promise/permission";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { registerV2Hooks } from "../../src/compat/v2-hooks";
import { V2_GRADER_AGENT } from "../../src/compat/v2-client";
import ModelRouterPlugin from "../../src/index";
import { invalidateConfigCache, overridePath } from "../../src/router/config";
import { resetAgentOptionsEffortWarnings } from "../../src/router/agent-options";
import { GRADER_AGENT_NAME } from "../../src/router/plugin-agents";
import { evaluatePermission } from "../../src/router/read-only";
import type { RouterPluginInput } from "../../src/compat/child-session";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllEnvs();
  invalidateConfigCache();
});

type Seed = (id: string) => unknown[];

function fixture(seed: Seed = () => []) {
  const sessionHooks: Record<string, (event: any) => Promise<void>> = {};
  const toolHooks: Record<string, (event: any) => Promise<void>> = {};
  const permissionHooks: Record<string, (event: PermissionEvaluation) => Promise<void>> = {};
  const agents: Record<string, any> = {
    explore: { id: "explore", mode: "subagent", model: { providerID: "old", id: "old" }, permissions: [], request: { settings: {}, headers: {}, body: {} } },
    build: { id: "build", mode: "primary", permissions: [], request: { settings: {}, headers: {}, body: {} } },
  };
  const transforms: Record<string, (editor: any) => void> = {};
  const editor = {
    update: (id: string, apply: (agent: any) => void) => {
      agents[id] ??= { id, mode: "primary", permissions: seed(id), request: { settings: {}, headers: {}, body: {} } };
      apply(agents[id]);
    },
  };
  const none = () => ({ dispose: vi.fn(async () => {}) });
  const ctx = {
    location: { directory: "/project", project: { directory: "/project" } },
    agent: {
      reload: vi.fn(async () => {}),
      list: vi.fn(async () => ({ data: Object.values(agents) })),
      transform: vi.fn(async (cb: any) => { transforms.agent = cb; cb(editor); return none(); }),
    },
    command: { reload: vi.fn(async () => {}), transform: vi.fn(async () => none()) },
    tool: { transform: vi.fn(async () => none()), hook: vi.fn(async (name: string, cb: any) => { toolHooks[name] = cb; return none(); }) },
    session: {
      get: vi.fn(async () => ({ id: "child", parentID: "root", agent: "scout" })),
      update: vi.fn(async () => {}),
      context: vi.fn(async () => [] as unknown[]),
      prompt: vi.fn(async () => {}), synthetic: vi.fn(async () => {}),
      hook: vi.fn(async (name: string, cb: any) => { sessionHooks[name] = cb; return none(); }),
    },
    permission: { hook: vi.fn(async (name: string, cb: (event: PermissionEvaluation) => Promise<void>) => { permissionHooks[name] = cb; return none(); }) },
    event: { subscribe: async function* ({ signal }: { signal: AbortSignal }) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      yield* [] as never[];
    } },
  };
  return {
    ctx, agents, transforms, editor, sessionHooks, permissionHooks, toolHooks,
    async start(hooks: Record<string, any>) {
      cleanups.push(await registerV2Hooks(ctx as unknown as Context, hooks as Hooks));
    },
  };
}

function setup(override: unknown) {
  const home = mkdtempSync(join(tmpdir(), "router-v2-plugin-agents-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  mkdirSync(dirname(overridePath()), { recursive: true });
  writeFileSync(overridePath(), JSON.stringify(override));
  invalidateConfigCache();
  resetAgentOptionsEffortWarnings();
  cleanups.push(() => { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  return home;
}

async function plugin(home: string) {
  return ModelRouterPlugin({ directory: home, worktree: home, routerHost: "v2" } as unknown as RouterPluginInput);
}

const defaults: Seed = (id) => structuredClone(Agent.Info.default(Agent.ID.make(id)).permissions) as unknown[];
const drifted: Seed = (id) => [...defaults(id), { action: "*", resource: "*", effect: "allow" }];

const scout = { tier: "medium", description: "Scout", prompt: "Use the task tool and bash freely.", steps: 7, readOnly: true, allowTools: ["webfetch"] };
const worker = { tier: "fast", description: "Worker", permission: { grep: "allow", read: { "*": "allow", "secret/*": "deny" } } };

const event = (agent: string, action: string, resources: string[], effect: "allow" | "deny" = "allow"): PermissionEvaluation => ({
  sessionID: "child" as PermissionEvaluation["sessionID"], agent: agent as PermissionEvaluation["agent"], action, resources, effect,
});

describe("grader constant", () => {
  it("GRADER_AGENT_NAME equals V2_GRADER_AGENT", () => {
    expect(GRADER_AGENT_NAME).toBe(V2_GRADER_AGENT);
  });
});

describe("plugin agents on v2", () => {
  it("registers a subagent with the user's prompt verbatim, steps, description and a published policy", async () => {
    const f = fixture(defaults);
    await f.start(await plugin(setup({ agents: { scout } })));
    const agent = f.agents.scout;
    expect(agent.mode).toBe("subagent");
    expect(agent.description).toBe("Scout");
    expect(agent.steps).toBe(7);
    expect(JSON.stringify(agent.system)).toContain("Use the task tool and bash freely.");
    expect(agent.model).toBeDefined();
    expect(Array.isArray(agent.permissions)).toBe(true);
  });

  it.each([["identical", defaults], ["drifted", drifted]] as const)(
    "readOnly + allowTools keeps the allow, shell/edit stay denied (%s host defaults)", async (_label, seed) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const f = fixture(seed);
        await f.start(await plugin(setup({ agents: { scout } })));
        const rules = f.agents.scout.permissions;
        expect(evaluatePermission(rules, "webfetch", "*")).toBe("allow");
        for (const action of ["shell", "bash", "edit", "write", "subagent", "task", "websearch"]) {
          expect(evaluatePermission(rules, action, "*")).toBe("deny");
        }
      } finally {
        warn.mockRestore();
      }
    });

  it.each([["identical", defaults], ["drifted", drifted]] as const)(
    "an explicit-permission agent fails closed (%s host defaults)", async (_label, seed) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const f = fixture(seed);
        await f.start(await plugin(setup({ agents: { worker } })));
        const rules = f.agents.worker.permissions;
        expect(evaluatePermission(rules, "grep", "*")).toBe("allow");
        expect(evaluatePermission(rules, "read", "src/a.ts")).toBe("allow");
        expect(evaluatePermission(rules, "read", "secret/a")).toBe("deny");
        for (const action of ["shell", "edit", "subagent", "webfetch", "external_directory"]) {
          expect(evaluatePermission(rules, action, "*")).toBe("deny");
        }
      } finally {
        warn.mockRestore();
      }
    });

  it("redacts grep output for readOnly and explicit-permission plugin agents, not for other agents (QA-81-3)", async () => {
    const f = fixture(defaults);
    await f.start(await plugin(setup({ agents: { scout, worker } })));
    const grepAs = async (agent: string) => {
      const event = { id: `call-${agent}`, sessionID: "child", agent, tool: "grep", input: { pattern: "." }, status: "completed", result: {
        content: "Found 2 matches\n/repo/.env:\n  Line 1: SECRET\n/repo/src/a.ts:\n  Line 1: PUBLIC",
        output: [{ entry: { path: ".env" }, line: 1, text: "SECRET" }, { entry: { path: "src/a.ts" }, line: 1, text: "PUBLIC" }],
      } };
      await f.toolHooks["execute.after"](event);
      return JSON.stringify(event.result);
    };
    for (const agent of ["scout", "worker"]) {
      const result = await grepAs(agent);
      expect(result).not.toContain("SECRET");
      expect(result).toContain("PUBLIC");
    }
    expect(await grepAs("medium")).toContain("SECRET");
  });

  it("a session grant cannot re-open a plugin agent's deny or capability", async () => {
    const f = fixture(drifted);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    cleanups.push(() => { vi.restoreAllMocks(); });
    await f.start(await plugin(setup({ agents: { scout, worker } })));
    const shell = event("scout", "shell", ["echo hi"]);
    await f.permissionHooks.evaluate(shell);
    expect(shell.effect).toBe("deny");
    const fetched = event("scout", "webfetch", ["https://example.com"]);
    await f.permissionHooks.evaluate(fetched);
    expect(fetched.effect).toBe("allow");
    const secret = event("worker", "read", ["secret/a"]);
    await f.permissionHooks.evaluate(secret);
    expect(secret.effect).toBe("deny");
    const open = event("worker", "read", ["src/a.ts"]);
    await f.permissionHooks.evaluate(open);
    expect(open.effect).toBe("allow");
    const edit = event("worker", "edit", ["src/a.ts"]);
    await f.permissionHooks.evaluate(edit);
    expect(edit.effect).toBe("deny");
  });

  it("does not create phantom subagentTiers agents; late real agents get the mapping after the prompt refresh", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    cleanups.push(() => { vi.restoreAllMocks(); });
    const notices = () => warn.mock.calls.map((args) => String(args[0])).filter((text) => text.includes("subagentTiers:"));
    const f = fixture(defaults);
    await f.start(await plugin(setup({ subagentTiers: { explore: "heavy", custom: "medium", ghost: "fast" } })));
    expect(f.agents.explore.model).not.toEqual({ providerID: "old", id: "old" });
    expect(f.agents.custom).toBeUndefined();
    expect(f.agents.ghost).toBeUndefined();
    expect(notices()).toEqual([]); // not before the first prompt-time check

    // The host's config-agent plugin registers opencode.json agents after the router's setup.
    f.agents.custom = { id: "custom", mode: "subagent", model: { providerID: "x", id: "y" }, permissions: [], request: {} };
    await f.sessionHooks.prompt({ sessionID: "child", prompt: { text: "hi" } });
    expect(f.ctx.agent.reload).toHaveBeenCalled();
    f.transforms.agent(f.editor);
    expect(f.agents.custom.model).not.toEqual({ providerID: "x", id: "y" });
    expect(f.agents.ghost).toBeUndefined();
    const text = notices();
    expect(text).toHaveLength(1);
    expect(text[0]).toContain("'ghost' is not defined");

    await f.sessionHooks.prompt({ sessionID: "child", prompt: { text: "again" } });
    expect(notices()).toHaveLength(1);
  });

  it("publishes the v2 vocabulary: a shell pattern allow applies to `shell`, not the v1 `bash`", async () => {
    const f = fixture(drifted);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    cleanups.push(() => { vi.restoreAllMocks(); });
    const runner = { tier: "fast", description: "R", permission: { shell: { "*": "deny", "npm test*": "allow" }, edit: "deny", task: "deny" } };
    await f.start(await plugin(setup({ agents: { runner } })));
    const rules = f.agents.runner.permissions;
    expect(evaluatePermission(rules, "shell", "npm test -- x")).toBe("allow");
    expect(evaluatePermission(rules, "shell", "echo hi")).toBe("deny");
    expect(evaluatePermission(rules, "edit", "a.ts")).toBe("deny");
    expect(evaluatePermission(rules, "subagent", "*")).toBe("deny");
    expect(rules.some((rule: { action: string }) => rule.action === "bash" || rule.action === "task")).toBe(false);
  });
  it("the tier of a plugin agent wins over subagentTiers on v2", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    cleanups.push(() => { vi.restoreAllMocks(); });
    const f = fixture(defaults);
    await f.start(await plugin(setup({ agents: { scout }, subagentTiers: { scout: "heavy" } })));
    const plain = fixture(defaults);
    await plain.start(await plugin(setup({ agents: { scout } })));
    expect(f.agents.scout.model).toEqual(plain.agents.scout.model);
  });

  it("notes a host agent of the same name (opencode.json wins for the fields it sets)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    cleanups.push(() => { vi.restoreAllMocks(); });
    const f = fixture(defaults);
    f.agents.scout = { id: "scout", mode: "subagent", description: "Mine", permissions: defaults("scout"), request: {} };
    await f.start(await plugin(setup({ agents: { scout } })));
    const notices = warn.mock.calls.map((args) => String(args[0])).filter((text) => text.includes("agent scout is defined both"));
    expect(notices).toHaveLength(1);
    expect(f.agents.scout.description).toBe("Mine");
  });
});
