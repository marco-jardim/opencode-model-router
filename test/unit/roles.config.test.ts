import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  getConfigNotices,
  invalidateConfigCache,
  loadConfig,
  localOverridePath,
  overridePath,
  resetRolesWarnings,
  resolveRolesRouting,
  validateConfig,
} from "../../src/router/config";
import {
  isRunScriptAllowed,
  narrowRoleSpec,
  sanitizeDelegation,
  sanitizeExploration,
  sanitizeRoleAgents,
  sanitizeRun,
  sanitizeWorkRoots,
  workRootProblem,
} from "../../src/router/roles-config";
import {
  SHIPPED_ROLE_SPECS,
  classifyAction,
  pluginAgentSeparationProblem,
  resolveRoleTable,
  resolveRoles,
  roleSpecProblems,
  separationProblem,
  type RoleSpec,
} from "../../src/router/roles";

function validRaw(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    activePreset: "anthropic",
    presets: { anthropic: { fast: { model: "anthropic/claude-haiku-4-5", description: "fast", whenToUse: ["recon"] } } },
    rules: ["r1"],
    defaultTier: "fast",
    ...extra,
  };
}

const TIERS = ["fast", "medium", "heavy"];
const spec: RoleSpec = {
  agent: "reviewer",
  kind: "review",
  description: "d",
  prompt: "p",
  authority: { mode: "fixed", allow: ["read", "grep", "router_git"], deny: ["edit"] },
  tierRange: { floor: "medium", ceiling: "heavy" },
  assurance: "deterministic" as RoleSpec["assurance"],
  guard: "reader",
  budget: { reads: 10, calls: 4 },
  enabled: true,
};

describe("routing.delegation", () => {
  it("accepts tiers and roles, drops anything else with an issue", () => {
    expect(sanitizeDelegation("roles").value).toBe("roles");
    expect(sanitizeDelegation("tiers").value).toBe("tiers");
    expect(sanitizeDelegation(undefined)).toEqual({ value: undefined, issues: [] });
    const bad = sanitizeDelegation("both");
    expect(bad.value).toBeUndefined();
    expect(bad.issues).toHaveLength(1);
  });
  it("validateConfig keeps an invalid value from throwing or dropping routing", () => {
    const cfg = validateConfig(validRaw({ routing: { margin: 0.1, delegation: "nope" } }));
    expect(cfg.routing?.margin).toBe(0.1);
    expect(cfg.routing?.delegation).toBeUndefined();
  });
});

describe("routing.exploration", () => {
  it("accepts 0..0.2 and fixes requireDetection", () => {
    expect(sanitizeExploration({ rate: 0.2 }).value).toEqual({ rate: 0.2, requireDetection: "deterministic" });
    expect(sanitizeExploration({}).value).toEqual({ requireDetection: "deterministic" });
  });
  it("drops a rate above the max or non-numeric, and a changed requireDetection, with issues", () => {
    const a = sanitizeExploration({ rate: 0.3, requireDetection: "grader" });
    expect(a.value).toEqual({ requireDetection: "deterministic" });
    expect(a.issues).toHaveLength(2);
    expect(sanitizeExploration({ rate: "x" }).value?.rate).toBeUndefined();
    expect(sanitizeExploration(5).value).toBeUndefined();
  });
});

describe("routing.run", () => {
  it("keeps valid parts and drops bad entries individually", () => {
    const r = sanitizeRun({
      scripts: ["test", "bad name", 3, "test:unit"],
      commands: {
        good: { argv: ["node", "x.js"], args: ["--a"] },
        noargv: { argv: [] },
        "__proto__": { argv: ["a"] },
        notobj: 1,
      },
      timeoutMs: 5,
    });
    expect(r.value?.scripts).toEqual(["test", "test:unit"]);
    expect(Object.keys(r.value?.commands ?? {})).toEqual(["good"]);
    expect(r.value?.timeoutMs).toBeUndefined();
    expect(r.issues.length).toBeGreaterThanOrEqual(5);
  });
  it("accepts a valid timeout and allows test:* scripts", () => {
    expect(sanitizeRun({ timeoutMs: 1000 }).value?.timeoutMs).toBe(1000);
    expect(isRunScriptAllowed("test:e2e", ["lint"])).toBe(true);
    expect(isRunScriptAllowed("deploy", ["lint"])).toBe(false);
    expect(isRunScriptAllowed("lint", ["lint"])).toBe(true);
  });
});

describe("routing.workRoots", () => {
  it.each(["*", "**", "/**", "D:/**", "D:\\*", "relative/dir", "~/x", "", "D:/a/../b", "C:/PROGRA~1/x/**", "D:/git/b*/../x"])(
    "rejects %j",
    (entry) => {
      expect(workRootProblem(entry)).toBeDefined();
    },
  );
  it.each(["D:/git/**", "D:\\git\\repo", "/home/u/proj/**", "\\\\srv\\share\\dir\\**", "D:/git/a*"])("accepts %j", (entry) => {
    expect(workRootProblem(entry)).toBeUndefined();
  });
  it("drops only bad entries, dedupes, and defaults to undefined when absent", () => {
    const r = sanitizeWorkRoots(["D:/git/**", "*", 4, "D:/git/**"]);
    expect(r.value).toEqual(["D:/git/**"]);
    expect(r.issues).toHaveLength(2);
    expect(sanitizeWorkRoots(undefined).value).toBeUndefined();
    expect(sanitizeWorkRoots("D:/x").value).toBeUndefined();
  });
});

describe("roleAgents", () => {
  it("keeps good fields and drops bad ones per field and per entry", () => {
    const r = sanitizeRoleAgents({
      reviewer: { enabled: false, description: "", deny: ["edit", "bogus"], budget: { reads: 5, calls: -1 }, codeModeAllow: ["x"] },
      "../evil": {},
      broken: 4,
    });
    expect(Object.keys(r.value ?? {})).toEqual(["reviewer"]);
    expect(r.value?.reviewer).toEqual({ enabled: false, deny: ["edit"], budget: { reads: 5 } });
    expect(r.issues.some((i) => i.message.includes("codeModeAllow"))).toBe(true);
  });
  it("validateConfig tolerates a non-object roleAgents", () => {
    expect(validateConfig(validRaw({ roleAgents: 3 })).roleAgents).toBeUndefined();
  });
});

describe("narrowRoleSpec", () => {
  it("returns the same spec without customisation", () => {
    expect(narrowRoleSpec(spec, undefined, TIERS)).toEqual({ spec, issues: [] });
  });
  it("accepts a narrower tierRange, clamps a wider one with an issue", () => {
    expect(narrowRoleSpec(spec, { tierRange: { floor: "heavy" } }, TIERS).spec.tierRange).toEqual({ floor: "heavy", ceiling: "heavy" });
    const wide = narrowRoleSpec(spec, { tierRange: { floor: "fast" } }, TIERS);
    expect(wide.spec.tierRange).toEqual({ floor: "medium", ceiling: "heavy" });
    expect(wide.issues).toHaveLength(1);
    expect(narrowRoleSpec(spec, { tierRange: { floor: "heavy", ceiling: "medium" } }, TIERS).issues).toHaveLength(1);
    expect(narrowRoleSpec(spec, { tierRange: { ceiling: "nope" } }, TIERS).spec.tierRange).toEqual(spec.tierRange);
  });
  it("deny only removes actions", () => {
    const n = narrowRoleSpec(spec, { deny: ["grep"] }, TIERS).spec;
    expect(n.authority.allow).toEqual(["read", "router_git"]);
    expect(n.authority.deny).toEqual(["edit", "grep"]);
    expect(spec.authority.allow).toEqual(["read", "grep", "router_git"]);
  });
  it("enabled:false disables; enabled:true cannot revive", () => {
    expect(narrowRoleSpec(spec, { enabled: false }, TIERS).spec.enabled).toBe(false);
    const off = narrowRoleSpec({ ...spec, enabled: false }, { enabled: true }, TIERS);
    expect(off.spec.enabled).toBe(false);
    expect(off.issues).toHaveLength(1);
  });
  it("budget within (0, 2x shipped], else clamped; unknown keys dropped", () => {
    const n = narrowRoleSpec(spec, { budget: { reads: 25, calls: 2, zzz: 1 } }, TIERS);
    expect(n.spec.budget).toEqual({ reads: 20, calls: 2 });
    expect(n.issues).toHaveLength(2);
  });
  it("replaces description and prompt", () => {
    const n = narrowRoleSpec(spec, { description: "x", prompt: "y" }, TIERS).spec;
    expect([n.description, n.prompt]).toEqual(["x", "y"]);
  });
});

describe("resolveRolesRouting", () => {
  afterEach(() => resetRolesWarnings());
  it("applies defaults", () => {
    const r = resolveRolesRouting(validateConfig(validRaw()), "v2");
    expect(r.delegation).toBe("tiers");
    expect(r.exploration).toEqual({ rate: 0, requireDetection: "deterministic" });
    expect(r.run.scripts).toEqual(["test", "typecheck", "lint", "build"]);
    expect(r.run.timeoutMs).toBe(600000);
    expect(r.workRoots).toEqual([]);
    expect(r.inert).toBe(false);
  });
  it("honours roles on v2", () => {
    const cfg = validateConfig(validRaw({ routing: { delegation: "roles", exploration: { rate: 0.1 } } }));
    const r = resolveRolesRouting(cfg, "v2");
    expect([r.delegation, r.exploration.rate]).toEqual(["roles", 0.1]);
  });
  it("is inert on v1 with exactly one notice", () => {
    const warn = vi.fn();
    const cfg = validateConfig(validRaw({ routing: { delegation: "roles", exploration: { rate: 0.1 } }, roleAgents: {} }));
    const a = resolveRolesRouting(cfg, "v1", { warn });
    resolveRolesRouting(cfg, "v1", { warn });
    expect([a.delegation, a.exploration.rate, a.inert]).toEqual(["tiers", 0, true]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("roles delegation requires OpenCode v2; using tiers");
  });
  it("is silent on v1 when nothing was set", () => {
    const warn = vi.fn();
    resolveRolesRouting(validateConfig(validRaw()), "v1", { warn });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("layers (loadConfig)", () => {
  const roots: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    invalidateConfigCache();
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  function setup(globalData: unknown, projectData: unknown) {
    const root = mkdtempSync(join(tmpdir(), "roles-cfg-"));
    roots.push(root);
    const home = join(root, "home");
    const project = join(root, "project");
    mkdirSync(home, { recursive: true });
    mkdirSync(join(project, ".git"), { recursive: true });
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    invalidateConfigCache();
    if (globalData !== undefined) {
      mkdirSync(dirname(overridePath()), { recursive: true });
      writeFileSync(overridePath(), JSON.stringify(globalData));
    }
    if (projectData !== undefined) {
      mkdirSync(dirname(localOverridePath(project)), { recursive: true });
      writeFileSync(localOverridePath(project), JSON.stringify(projectData));
    }
    return project;
  }

  it("strips project roleAgents/exploration/run/workRoots with a notice but keeps delegation and the rest", () => {
    const project = setup(undefined, {
      defaultTier: "fast",
      roleAgents: { reviewer: { enabled: false } },
      routing: { delegation: "roles", exploration: { rate: 0.2 }, run: { timeoutMs: 2000 }, workRoots: ["D:/x/**"], margin: 0.2 },
    });
    const cfg = loadConfig(project);
    expect(cfg.roleAgents).toBeUndefined();
    expect(cfg.routing?.delegation).toBe("roles");
    expect(cfg.routing?.margin).toBe(0.2);
    expect(cfg.routing?.exploration).toBeUndefined();
    expect(cfg.routing?.run).toBeUndefined();
    expect(cfg.routing?.workRoots).toBeUndefined();
    const text = getConfigNotices(project).map((n) => n.message).join("\n");
    expect(text).toContain("roleAgents, routing.exploration, routing.run, routing.workRoots");
  });

  it("global layer keeps valid entries when others are invalid, and notices the bad ones", () => {
    const project = setup(
      {
        defaultTier: "fast",
        roleAgents: { reviewer: { enabled: false, budget: { reads: -1 } }, "../x": {} },
        routing: { margin: 0.3, delegation: "bad", exploration: { rate: 9 }, workRoots: ["*", "D:/git/**"] },
      },
      undefined,
    );
    const cfg = loadConfig(project);
    expect(cfg.defaultTier).toBe("fast");
    expect(cfg.routing?.margin).toBe(0.3);
    expect(cfg.roleAgents).toEqual({ reviewer: { enabled: false, budget: {} } });
    expect(cfg.routing?.workRoots).toEqual(["D:/git/**"]);
    const text = getConfigNotices(project).map((n) => n.message).join("\n");
    expect(text).toContain("routing.delegation must be");
    expect(text).toContain("routing.exploration.rate");
    expect(text).toContain("routing.workRoots[0]");
    expect(text).toContain("roleAgents.reviewer.budget.reads");
    expect(text).not.toContain("unknown routing key");
  });
});

describe("shipped role specs (T1.1.3)", () => {
  it("are valid: return contract, work-root rule, separation, execute denied, frozen", () => {
    expect(SHIPPED_ROLE_SPECS.map((s) => s.agent)).toEqual(["explorer", "researcher", "runner", "implementer", "reviewer", "architect", "general"]);
    for (const s of SHIPPED_ROLE_SPECS) {
      expect(roleSpecProblems(s, { shipped: true })).toEqual([]);
      expect(s.authority.allow).not.toContain("execute");
      expect(s.authority.deny).toContain("execute");
      expect(s.prompt).toContain("`cwd` = the work root");
      expect(Object.isFrozen(s) && Object.isFrozen(s.authority.allow) && Object.isFrozen(s.budget)).toBe(true);
    }
  });

  it("match the plan §2.2 table (R6)", () => {
    const row = (s: RoleSpec) => [s.kind, s.authority.mode, [...s.authority.allow].sort().join(","),
      `${s.tierRange.floor}-${s.tierRange.ceiling}`, s.assurance, s.guard, JSON.stringify(s.budget)];
    const local = "glob,grep,read,router_git";
    expect(Object.fromEntries(SHIPPED_ROLE_SPECS.map((s) => [s.agent, row(s)]))).toEqual({
      explorer: ["explore", "fixed", local, "fast-medium", "none", "reader", '{"fast":30,"medium":40}'],
      researcher: ["research", "fixed", "context7,webfetch,websearch", "fast-medium", "none", "reader", '{"fast":30,"medium":40}'],
      runner: ["run", "fixed", `${local},router_run`, "fast-medium", "deterministic", "reader", '{"fast":25,"medium":40}'],
      implementer: ["implement", "dynamic", `edit,${local},router_run`, "fast-heavy", "none", "producer", '{"fast":40,"medium":80,"heavy":120}'],
      reviewer: ["review", "fixed", `${local},router_run`, "heavy-heavy", "none", "reader", '{"heavy":120}'],
      architect: ["design", "fixed", local, "medium-heavy", "none", "reader", '{"medium":80,"heavy":120}'],
      general: ["general", "dynamic", `edit,${local},router_run`, "fast-heavy", "none", "producer", '{"fast":40,"medium":80,"heavy":120}'],
    });
    for (const name of ["implementer", "general"]) {
      expect(SHIPPED_ROLE_SPECS.find((s) => s.agent === name)!.prompt).toContain("if `edit` is denied return `ESCALATE: authority`".replace("if", "If"));
    }
  });
});

describe("separation validator (I4)", () => {
  it("classifies actions; unknown and MCP names are egress", () => {
    expect(["read", "external_directory", "router_git_status", "router_run", "edit", "todowrite"].map(classifyAction))
      .toEqual(["local", "local", "local", "exec", "write", "neutral"]);
    expect(["bash", "shell", "execute", "context7_query-docs", "brave_web_search", "subagent", "github_create_issue"].map(classifyAction))
      .toEqual(Array(7).fill("egress"));
  });

  it("refuses local, exec or write together with egress", () => {
    expect(separationProblem(["read", "webfetch"])).toMatch(/separation rule I4/);
    expect(separationProblem(["router_run", "context7"])).toBeDefined();
    expect(separationProblem(["edit", "execute"])).toBeDefined();
    expect(separationProblem(["external_directory", "websearch"])).toBeDefined();
    expect(separationProblem(["read", "glob", "edit", "router_run", "todowrite"])).toBeUndefined();
    expect(separationProblem(["webfetch", "websearch", "context7"])).toBeUndefined();
  });

  it("rejects specs that mix classes or allow execute", () => {
    const explorer = SHIPPED_ROLE_SPECS[0]!;
    const mixed: RoleSpec = { ...explorer, authority: { ...explorer.authority, allow: [...explorer.authority.allow, "webfetch"], deny: explorer.authority.deny.filter((a) => a !== "webfetch") } };
    expect(roleSpecProblems(mixed).join("; ")).toMatch(/separation rule I4/);
    const code: RoleSpec = { ...explorer, authority: { mode: "fixed", allow: ["execute"], deny: [] } };
    expect(roleSpecProblems(code).join("; ")).toMatch(/allows execute.*does not deny execute/);
  });

  it("evaluates #81 agent policies, wildcards included", () => {
    expect(pluginAgentSeparationProblem({ tier: "fast", description: "x", permission: { read: "allow", webfetch: "allow" } })).toBeDefined();
    expect(pluginAgentSeparationProblem({ tier: "fast", description: "x", permission: { read: "allow", glob: "allow" } })).toBeUndefined();
    expect(pluginAgentSeparationProblem({ tier: "fast", description: "x", permission: { "*": "allow" } })).toBeDefined();
    expect(pluginAgentSeparationProblem({ tier: "fast", description: "x", permission: { "*": "deny", webfetch: "allow", websearch: "ask" } })).toBeUndefined();
    expect(pluginAgentSeparationProblem({ readOnly: true }, true)).toMatch(/context7/);
    expect(pluginAgentSeparationProblem({ readOnly: true }, false)).toBeUndefined();
    expect(pluginAgentSeparationProblem("nope")).toBeDefined();
  });
});

describe("resolveRoles (T1.1.3)", () => {
  const tier = (m: string) => ({ model: `anthropic/${m}`, description: m, whenToUse: ["x"] });
  const raw = (extra: Record<string, unknown> = {}, tiers: string[] = ["fast", "medium", "heavy"]) =>
    validRaw({ presets: { anthropic: Object.fromEntries(tiers.map((t) => [t, tier(t)])) }, ...extra });
  const rolesMode = (extra: Record<string, unknown> = {}, tiers?: string[]) =>
    validateConfig(raw({ routing: { delegation: "roles" }, ...extra }, tiers));

  it("is empty in tiers mode and on v1", () => {
    expect(resolveRoles(validateConfig(raw()), "v2").size).toBe(0);
    expect(resolveRoles(validateConfig(raw({ routing: { delegation: "tiers" } })), "v2").size).toBe(0);
    expect(resolveRoles(rolesMode(), "v1").size).toBe(0);
  });

  it("returns every shipped role in roles mode on v2, read-only", () => {
    const t = resolveRoleTable(rolesMode(), "v2");
    expect([...t.roles.keys()]).toEqual(SHIPPED_ROLE_SPECS.map((s) => s.agent));
    expect(t.issues).toEqual([]);
    expect(() => (t.roles as Map<string, RoleSpec>).set("x", t.roles.get("explorer")!)).toThrow(TypeError);
    expect(Object.isFrozen(t.roles.get("reviewer"))).toBe(true);
  });

  it("narrows with roleAgents, never widens, and leaves disabled roles out", () => {
    const t = resolveRoleTable(rolesMode({
      roleAgents: {
        implementer: { deny: ["router_run"], tierRange: { floor: "medium" }, budget: { heavy: 500 } },
        reviewer: { tierRange: { floor: "fast" } },
        architect: { enabled: false },
        ghost: { enabled: false },
      },
    }), "v2");
    const impl = t.roles.get("implementer")!;
    expect(impl.authority.allow).not.toContain("router_run");
    expect(impl.authority.deny).toContain("router_run");
    expect(impl.tierRange).toEqual({ floor: "medium", ceiling: "heavy" });
    expect(impl.budget.heavy).toBe(240);
    expect(t.roles.get("reviewer")!.tierRange).toEqual({ floor: "heavy", ceiling: "heavy" });
    expect(t.roles.has("architect")).toBe(false);
    const paths = t.issues.map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(["roleAgents.ghost", "roleAgents.reviewer.tierRange.floor", "roleAgents.implementer.budget.heavy"]));
  });

  it("places tier ranges on the active preset's tiers, with a notice", () => {
    const t = resolveRoleTable(rolesMode({}, ["fast", "heavy"]), "v2");
    expect(t.roles.get("explorer")!.tierRange).toEqual({ floor: "fast", ceiling: "fast" });
    expect(t.roles.get("architect")!.tierRange).toEqual({ floor: "heavy", ceiling: "heavy" });
    expect(t.issues.map((i) => i.path)).toContain("roleAgents.architect.tierRange");
    const small = resolveRoleTable(rolesMode({}, ["fast", "medium"]), "v2");
    expect(small.roles.has("reviewer")).toBe(false);
    expect(small.issues.find((i) => i.path === "roleAgents.reviewer.tierRange")?.message).toMatch(/role disabled/);
  });

  it("drops a #81 agent with a role name that breaks separation in roles mode only", () => {
    const agents = {
      researcher: { tier: "fast", description: "r", permission: { read: "allow", webfetch: "allow" } },
      explorer: { tier: "fast", description: "e", permission: { read: "allow", glob: "allow" } },
    };
    const t = resolveRoleTable(rolesMode({ agents }), "v2");
    expect(t.droppedAgents).toEqual(["researcher"]);
    expect(t.roles.get("researcher")!.authority.allow).toEqual(["webfetch", "websearch", "context7"]);
    expect(t.replacedRoles).toEqual(["explorer"]);
    expect(t.roles.has("explorer")).toBe(false);
    expect(t.issues.find((i) => i.path === "agents.researcher")?.message).toMatch(/dropped in roles mode/);
    const tiers = resolveRoleTable(validateConfig(raw({ agents })), "v2");
    expect([tiers.droppedAgents, tiers.replacedRoles, tiers.roles.size]).toEqual([[], [], 0]);
  });

  it("skips an invalid shipped spec (fail closed)", () => {
    const bad: RoleSpec = { ...SHIPPED_ROLE_SPECS[0]!, authority: { mode: "fixed", allow: ["read", "webfetch"], deny: [] } };
    const t = resolveRoleTable(rolesMode(), "v2", { shipped: [bad] });
    expect(t.roles.size).toBe(0);
    expect(t.issues[0]?.message).toMatch(/shipped role explorer is invalid/);
  });
});

describe("routing.run default commands (P1.3 handoff)", () => {
  it("ships a scoped test entry; a user commands block replaces it", () => {
    const r = resolveRolesRouting(validateConfig(validRaw()), "v2");
    expect(r.run.commands["test-files"]).toEqual({ argv: ["npm", "run", "test", "--"], args: ["test/*", "--maxWorkers=*"] });
    const own = resolveRolesRouting(validateConfig(validRaw({ routing: { run: { commands: { x: { argv: ["node", "x.js"] } } } } })), "v2");
    expect(Object.keys(own.run.commands)).toEqual(["x"]);
  });
});
