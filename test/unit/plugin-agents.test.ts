import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigNotices, invalidateConfigCache, loadConfig, pluginAgentLines, OVERRIDE_FILENAME } from "../../src/router/config";
import type { Preset } from "../../src/router/config";
import {
  GRADER_AGENT_NAME, pluginAgentPolicy, sanitizePluginAgents, validatePluginAgent,
} from "../../src/router/plugin-agents";
import {
  evaluatePermission, isMonotone, permissionRules, publishReadOnlyPermissions, READ_ONLY_CANARIES, type PermissionRule,
} from "../../src/router/read-only";

const tier = (model: string) => ({ model, costRatio: 1, description: "t", whenToUse: [] });
const tiers = { fast: tier("p/f"), medium: tier("p/m"), heavy: tier("p/h"), scout: tier("p/s") } as unknown as Preset;
const ctx = { activePreset: "test", tiers };

describe("plugin agents: validation", () => {
  const ok = { tier: "scout", description: "d", readOnly: true };

  it("accepts a minimal read-only entry", () => {
    expect(validatePluginAgent("reviewer", ok, ctx).ok).toBe(true);
  });

  it("drops an entry with unknown keys", () => {
    const r = validatePluginAgent("reviewer", { ...ok, bogus: 1 }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issue.path).toBe("agents.reviewer.bogus");
  });

  it("rejects model/variant/mode with a specific message", () => {
    const r = validatePluginAgent("reviewer", { ...ok, model: "x/y" }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issue.message).toContain("not configurable");
  });

  it.each(["fast", "medium", "heavy", "scout", "build", "plan", GRADER_AGENT_NAME, "__proto__", "bad name"])(
    "rejects reserved/colliding/invalid name %s", (name) => {
      expect(validatePluginAgent(name, ok, ctx).ok).toBe(false);
    },
  );

  it("rejects an unknown tier", () => {
    const r = validatePluginAgent("reviewer", { ...ok, tier: "ultra" }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issue.path).toBe("agents.reviewer.tier");
  });

  it("requires readOnly or a permission", () => {
    const r = validatePluginAgent("reviewer", { tier: "scout", description: "d" }, ctx);
    expect(r.ok).toBe(false);
    expect(validatePluginAgent("reviewer", { tier: "scout", description: "d", permission: { grep: "allow" } }, ctx).ok).toBe(true);
  });

  it("aliases bash to shell and task to subagent", () => {
    const r = validatePluginAgent("r", { tier: "scout", description: "d", permission: { bash: { "git status": "allow" }, task: "deny" } }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.keys(r.value.permission ?? {})).toEqual(["shell", "subagent"]);
    }
  });

  it.each(["shell", "bash", "edit", "subagent", "read", "*", "sh*"])("allowTools rejects %s", (tool) => {
    expect(validatePluginAgent("r", { ...ok, allowTools: [tool] }, ctx).ok).toBe(false);
  });

  it("allowTools accepts MCP and webfetch names", () => {
    expect(validatePluginAgent("r", { ...ok, allowTools: ["webfetch", "context7_*"] }, ctx).ok).toBe(true);
  });

  it("a readOnly agent's own permission cannot allow or ask for shell", () => {
    expect(validatePluginAgent("r", { ...ok, permission: { grep: "allow" } }, ctx).ok).toBe(false);
    expect(validatePluginAgent("r", { ...ok, permission: { shell: "ask" } }, ctx).ok).toBe(false);
    expect(validatePluginAgent("r", { ...ok, permission: { shell: "deny" } }, ctx).ok).toBe(true);
  });

  it("sanitize keeps good entries and reports bad ones; undefined stays undefined", () => {
    expect(sanitizePluginAgents(undefined, ctx)).toEqual({ agents: undefined, issues: [] });
    const { agents, issues } = sanitizePluginAgents({ good: ok, bad: { tier: "nope", description: "d", readOnly: true } }, ctx);
    expect(Object.keys(agents ?? {})).toEqual(["good"]);
    expect(issues).toHaveLength(1);
    expect(issues[0].name).toBe("bad");
    expect(sanitizePluginAgents([], ctx).agents).toBeUndefined();
  });
});

describe("plugin agents: v2 publication is fail-closed (QA-81-1)", () => {
  const DEFAULTS: PermissionRule[] = [
    { action: "*", resource: "*", effect: "allow" },
    { action: "external_directory", resource: "*", effect: "ask" },
    { action: "read", resource: "*.env", effect: "ask" },
    { action: "read", resource: "*.env.*", effect: "ask" },
    { action: "read", resource: "*.env.example", effect: "allow" },
  ];
  const hosts: Array<[string, PermissionRule[]]> = [
    ["identical defaults", DEFAULTS],
    ["appended allow", [...DEFAULTS, { action: "webfetch", resource: "*", effect: "allow" }]],
    ["inserted", [DEFAULTS[0]!, { action: "question", resource: "*", effect: "allow" }, ...DEFAULTS.slice(1)]],
    ["respelled", [{ action: "*", resource: "**", effect: "allow" }, ...DEFAULTS.slice(1)]],
    ["dropped", DEFAULTS.filter((rule) => rule.action !== "external_directory")],
    ["default changed to * * ask", [{ action: "*", resource: "*", effect: "ask" }, ...DEFAULTS.slice(1)]],
    ["+shell * allow", [...DEFAULTS, { action: "shell", resource: "*", effect: "allow" }]],
    ["+shell * ask", [...DEFAULTS, { action: "shell", resource: "*", effect: "ask" }]],
  ];
  const runner = permissionRules(pluginAgentPolicy(
    { permission: { shell: { "*": "deny", "npm test*": "allow", "*>*": "deny" } } }, { context7: false, host: "v2" },
  ).permission);
  const reviewer = permissionRules(pluginAgentPolicy({ readOnly: true, allowTools: ["webfetch"] }, { context7: false, host: "v2" }).permission);

  it.each(hosts)("runner on %s: shell stays fail-closed, npm test stays allowed", (_label, host) => {
    const warn = vi.fn();
    const rules = publishReadOnlyPermissions("runner", runner, host, warn, { plugin: true });
    expect(evaluatePermission(rules, "shell", "rm -rf /")).toBe("deny");
    expect(evaluatePermission(rules, "shell", "npm test > x")).toBe("deny");
    expect(evaluatePermission(rules, "shell", "npm test")).toBe("allow");
    for (const action of ["edit", "subagent", "webfetch", "question", "external_directory"]) {
      expect(evaluatePermission(rules, action, "*")).toBe("deny");
    }
    expect(isMonotone(runner, rules, [...READ_ONLY_CANARIES, "shell", "read"], ["*", "rm -rf /", "a>b", "npm test; rm x", ".env"])).toBe(true);
  });

  it.each(hosts)("readOnly plugin agent on %s: never wider than its policy", (_label, host) => {
    const rules = publishReadOnlyPermissions("reviewer", reviewer, host, vi.fn(), { plugin: true });
    expect(isMonotone(reviewer, rules, [...READ_ONLY_CANARIES, "read", "grep", "webfetch"], ["*", ".env", "src/file.ts", "rm -rf /"])).toBe(true);
    expect(evaluatePermission(rules, "shell", "*")).toBe("deny");
    expect(evaluatePermission(rules, "webfetch", "https://x")).toBe("allow");
    expect(evaluatePermission(rules, "read", ".env")).toBe("ask");
  });

  it("inherited denies are kept after the policy: a later deny stays a deny", () => {
    const rules = publishReadOnlyPermissions("runner", runner, [...DEFAULTS, { action: "shell", resource: "npm test*", effect: "deny" }], vi.fn(), { plugin: true });
    expect(evaluatePermission(rules, "shell", "npm test")).toBe("deny");
  });

  it("isMonotone flags an inherited allow that widens the policy", () => {
    expect(isMonotone(runner, [...runner, { action: "shell", resource: "*", effect: "allow" }], ["shell"], ["rm -rf /"])).toBe(false);
  });
});

describe("plugin agents: permission builders", () => {
  const opts = { context7: false, host: "v2" as const };

  it("readOnly + allowTools: policy first, grants after, user deny stays deny", () => {
    const { permission } = pluginAgentPolicy(
      { readOnly: true, allowTools: ["webfetch"], permission: { grep: "deny" } }, opts,
    );
    const keys = Object.keys(permission);
    expect(keys[0]).toBe("*");
    expect(permission["*"]).toBe("deny");
    expect(permission.shell).not.toBe("allow");
    expect(permission.edit).not.toBe("allow");
    expect(permission.webfetch).toBe("allow");
    expect(permission.grep).toBe("deny");
    expect(keys.indexOf("webfetch")).toBeGreaterThan(0);
    expect(keys.indexOf("grep")).toBeGreaterThan(keys.indexOf("webfetch"));
  });

  it("explicit permission: deny-by-default first, sensitive asks after each read grant", () => {
    const { permission } = pluginAgentPolicy({ permission: { read: "allow", grep: "allow" } }, opts);
    const keys = Object.keys(permission);
    expect(keys[0]).toBe("*");
    expect(permission["*"]).toBe("deny");
    expect(keys[keys.length - 1]).toBe("read");
    const read = permission.read as Record<string, string>;
    const order = Object.keys(read);
    expect(read["*"]).toBe("allow");
    expect(order[0]).toBe("*");
    const asks = order.filter((k) => read[k] === "ask");
    expect(asks.length).toBeGreaterThan(0);
    for (const k of asks) expect(order.indexOf(k)).toBeGreaterThan(0);
  });

  it("a user deny after a read grant stays a deny (no ask re-placed after it)", () => {
    const { permission } = pluginAgentPolicy({ permission: { read: { "*": "allow", "secret/**": "deny" } } }, opts);
    const read = permission.read as Record<string, string>;
    const order = Object.keys(read);
    expect(read["secret/**"]).toBe("deny");
    expect(order[order.length - 1]).toBe("secret/**");
  });

  it("an exact sensitive read grant gets an ask right after it", () => {
    const { permission } = pluginAgentPolicy({ permission: { read: { ".env": "allow" } } }, opts);
    const read = permission.read as Record<string, string>;
    expect(read[".env"]).toBe("ask");
  });

  it("v1 host renames shell/subagent to bash/task", () => {
    const { permission } = pluginAgentPolicy({ permission: { shell: { "git status": "allow" }, subagent: "deny" } }, { context7: false, host: "v1" });
    expect(Object.keys(permission)).toContain("bash");
    expect(Object.keys(permission)).toContain("task");
    expect(Object.keys(permission)).not.toContain("shell");
    expect(permissionRules(permission).length).toBeGreaterThan(0);
  });
});

describe("plugin agents: layer rules", () => {
  let home: string;
  let project: string;
  let savedHome: string | undefined;
  let savedProfile: string | undefined;

  const write = (path: string, body: unknown) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(body));
  };
  const globalFile = () => join(home, ".config", "opencode", OVERRIDE_FILENAME);
  const projectFile = () => join(project, ".opencode", OVERRIDE_FILENAME);

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "oc-mr-plugin-agents-"));
    home = join(root, "home");
    project = join(root, "proj");
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
    savedHome = process.env.HOME;
    savedProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    invalidateConfigCache();
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile;
    invalidateConfigCache();
    rmSync(join(home, ".."), { recursive: true, force: true });
  });

  it("without an agents block nothing is added", () => {
    const cfg = loadConfig(project);
    expect(Object.hasOwn(cfg, "agents")).toBe(false);
    expect(pluginAgentLines(cfg)).toEqual([]);
  });

  it("the project layer's agents are removed with a notice; the rest of the layer is kept", () => {
    write(projectFile(), {
      agents: { evil: { tier: "fast", description: "d", readOnly: true } },
      routing: { roles: { review: ["medium"] } },
    });
    const cfg = loadConfig(project);
    expect(cfg.agents).toBeUndefined();
    expect(cfg.routing?.roles?.review).toEqual(["medium"]);
    expect(getConfigNotices(project).some((n) => n.message.includes("ignoring agents from") && n.message.includes("A18"))).toBe(true);
  });

  it("a bad global entry is dropped with a notice while routing stays in force", () => {
    write(globalFile(), {
      agents: {
        good: { tier: "fast", description: "d", readOnly: true },
        bad: { tier: "nope", description: "d", readOnly: true },
      },
      routing: { roles: { review: ["medium"] } },
    });
    const cfg = loadConfig(project);
    expect(Object.keys(cfg.agents ?? {})).toEqual(["good"]);
    expect(cfg.routing?.roles?.review).toEqual(["medium"]);
    expect(getConfigNotices(project).some((n) => n.message.includes("agents.bad.tier"))).toBe(true);
    expect(pluginAgentLines(cfg).join("\n")).toContain("good");
  });
});

