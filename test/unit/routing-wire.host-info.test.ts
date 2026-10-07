// Phase 2.2: the host-facing helpers of the dispatch wiring: permission evaluation (A11), the agent view the kernel
// consumes, and the synchronous catalog view.
import { describe, expect, it, vi } from "vitest";
import {
  agentModelRef,
  allowedUnconditionally,
  buildAgentView,
  createWireCatalog,
  evaluateRules,
  grantsOfRules,
  parseRules,
  subagentPermitted,
  wildcardMatch,
  type PermissionRule,
  type RawCatalogModel,
} from "../../src/routing/wire/host-info";

const allow = (action: string, resource = "*"): PermissionRule => ({ action, resource, effect: "allow" });
const deny = (action: string, resource = "*"): PermissionRule => ({ action, resource, effect: "deny" });
const ask = (action: string, resource = "*"): PermissionRule => ({ action, resource, effect: "ask" });

describe("wildcardMatch", () => {
  it("handles *, literals, prefixes, suffixes and middles", () => {
    expect(wildcardMatch("*", "anything")).toBe(true);
    expect(wildcardMatch("**", "a/b")).toBe(true);
    expect(wildcardMatch("bash", "bash")).toBe(true);
    expect(wildcardMatch("bash", "bashful")).toBe(false);
    expect(wildcardMatch("git *", "git status")).toBe(true);
    expect(wildcardMatch("git *", "svn status")).toBe(false);
    expect(wildcardMatch("*.ts", "a/b/c.ts")).toBe(true);
    expect(wildcardMatch("src/*/x.ts", "src/a/b/x.ts")).toBe(true);
    expect(wildcardMatch("src/*/x.ts", "src/x.ts")).toBe(false);
    expect(wildcardMatch("a*b*c", "abc")).toBe(true);
    expect(wildcardMatch("a*b*c", "acb")).toBe(false);
  });
});

describe("parseRules / evaluateRules", () => {
  it("keeps valid rules only; a missing resource means *", () => {
    expect(parseRules([{ action: "write", effect: "deny" }, { action: 1, effect: "allow" }, { action: "x", effect: "maybe" }, null, "x"]))
      .toEqual([{ action: "write", resource: "*", effect: "deny" }]);
    expect(parseRules(undefined)).toEqual([]);
    expect(parseRules({})).toEqual([]);
  });

  it("the LAST matching rule wins; no match is null", () => {
    const rules = [allow("*"), deny("shell"), allow("shell", "git *")];
    expect(evaluateRules(rules, "read", "x")).toBe("allow");
    expect(evaluateRules(rules, "shell", "rm -rf")).toBe("deny");
    expect(evaluateRules(rules, "shell", "git log")).toBe("allow");
    expect(evaluateRules([deny("a")], "b", "x")).toBeNull();
  });
});

describe("allowedUnconditionally (QA-1.4-14: only an unconditional allow grants)", () => {
  it("allow-all, then a pattern-limited deny leaves the tool conditional", () => {
    expect(allowedUnconditionally([allow("*")], "shell")).toBe(true);
    expect(allowedUnconditionally([allow("*"), deny("shell", "rm *")], "shell")).toBe(false);
    expect(allowedUnconditionally([allow("shell", "git *")], "shell")).toBe(false);
    expect(allowedUnconditionally([allow("*"), ask("shell")], "shell")).toBe(false);
    expect(allowedUnconditionally([deny("*"), allow("shell")], "shell")).toBe(true);
    expect(allowedUnconditionally([allow("shell"), deny("*")], "shell")).toBe(false);
    expect(allowedUnconditionally([], "shell")).toBe(false);
  });
});

describe("grantsOfRules (A11: needs from evaluated permissions, never from ids)", () => {
  it("a read-only agent covers none of the needs; an allow-all agent covers them all", () => {
    const readOnly = [deny("*"), ...["glob", "grep", "read"].map((tool) => allow(tool))];
    expect(grantsOfRules(readOnly)).toEqual([]);
    expect(grantsOfRules([...readOnly, allow("webfetch")])).toEqual(["web"]);
    expect(grantsOfRules([allow("*")])).toEqual(["shell", "web", "edit", "network", "external_dir"]);
    expect(grantsOfRules([allow("*"), deny("external_directory")])).toEqual(["shell", "web", "edit", "network"]);
    expect(grantsOfRules([allow("*"), ask("external_directory")])).toEqual(["shell", "web", "edit", "network"]);
    expect(grantsOfRules([allow("*"), deny("bash"), deny("shell")])).toEqual(["web", "edit", "external_dir"]);
  });
});

describe("subagentPermitted", () => {
  it("needs an explicit allow after the agent's and the session's rules", () => {
    expect(subagentPermitted([allow("subagent")], "explore")).toBe(true);
    expect(subagentPermitted([allow("subagent"), deny("subagent", "explore")], "explore")).toBe(false);
    expect(subagentPermitted([allow("subagent"), deny("subagent", "explore")], "general")).toBe(true);
    expect(subagentPermitted([ask("subagent")], "explore")).toBe(false);
    expect(subagentPermitted([], "explore")).toBe(false);
  });
});

describe("agentModelRef", () => {
  it("renders provider/model[#variant] and rejects anything incomplete", () => {
    expect(agentModelRef({ providerID: "anthropic", id: "claude-haiku-4-5" })).toBe("anthropic/claude-haiku-4-5");
    expect(agentModelRef({ providerID: "anthropic", id: "claude-opus-5-5", variant: "xhigh" })).toBe("anthropic/claude-opus-5-5#xhigh");
    expect(agentModelRef({ providerID: "anthropic" })).toBeNull();
    expect(agentModelRef(undefined)).toBeNull();
    expect(agentModelRef({ providerID: "", id: "x" })).toBeNull();
  });
});

describe("buildAgentView", () => {
  const agents = [
    { id: "build", mode: "primary", hidden: false, permissions: [allow("*")] },
    { id: "explore", mode: "subagent", hidden: false, description: "Read only exploration", model: { providerID: "anthropic", id: "claude-haiku-4-5" }, permissions: [deny("*"), allow("read")] },
    { id: "general", mode: "subagent", hidden: false, permissions: [allow("*")] },
    { id: "title", mode: "primary", hidden: true, permissions: [] },
    { id: "", mode: "subagent" },
    "not an agent",
  ];

  it("evaluates permitted against the parent's rules then the session's, and grants from each agent's own rules", () => {
    const view = buildAgentView(agents, "build", [allow("subagent"), deny("subagent", "general")]);
    const byId = Object.fromEntries(view.infos.map((info) => [info.id, info]));
    expect(Object.keys(byId)).toEqual(["build", "explore", "general", "title"]);
    expect(byId.explore).toMatchObject({ model: "anthropic/claude-haiku-4-5", mode: "subagent", hidden: false, permitted: true, grants: [] });
    expect(byId.general).toMatchObject({ model: null, permitted: false, grants: ["shell", "web", "edit", "network", "external_dir"] });
    expect(byId.title).toMatchObject({ hidden: true, mode: "primary" });
    expect(view.descriptions.get("explore")).toBe("Read only exploration");
    expect(view.descriptions.has("general")).toBe(false);
  });

  it("an unknown parent agent permits nothing", () => {
    const view = buildAgentView(agents, "ghost", [allow("subagent")]);
    expect(view.infos.every((info) => !info.permitted)).toBe(true);
    expect(buildAgentView(agents, undefined, []).infos.every((info) => !info.permitted)).toBe(true);
  });
});

describe("createWireCatalog", () => {
  const model = (id: string, extra: Partial<RawCatalogModel> = {}): RawCatalogModel => ({ providerID: "p", id, ...extra });

  it("serves entries and pricing synchronously after ensure(); an unknown model is unpriced", async () => {
    const list = vi.fn(async () => [model("a", { cost: [{ input: 1, output: 2 }], variants: [{ id: "low" }] }), model("b")]);
    const catalog = createWireCatalog(list);
    expect(catalog.entry("p/a")).toBeUndefined();
    await catalog.ensure();
    expect(catalog.entry("p/a")?.variants).toEqual([{ id: "low" }]);
    expect(catalog.pricing("p/a")).toEqual([{ input: 1, output: 2 }]);
    expect(catalog.pricing("p/b")).toBeUndefined();
    expect(catalog.pricing("p/none")).toBeUndefined();
    await catalog.ensure();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("serves the stale table while it reloads after the ttl, and refreshes it", async () => {
    let clock = 0;
    let generation = 0;
    const list = vi.fn(async () => [model("a", { cost: { input: ++generation, output: 0 } as never })]);
    const catalog = createWireCatalog(list, { now: () => clock, ttlMs: 100 });
    await catalog.ensure();
    clock = 150;
    await catalog.ensure();
    expect(list).toHaveBeenCalledTimes(2);
    await catalog.ensure();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("a failing list is logged, backs off, and leaves every lookup unknown; a later success recovers", async () => {
    let clock = 0;
    const warn = vi.fn();
    const list = vi.fn<() => Promise<readonly RawCatalogModel[]>>().mockRejectedValueOnce(new Error("offline")).mockResolvedValue([model("a")]);
    const catalog = createWireCatalog(list, { now: () => clock, retryMs: 1000, logger: { warn } });
    await catalog.ensure();
    expect(catalog.entry("p/a")).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    await catalog.ensure();
    expect(list).toHaveBeenCalledTimes(1); // inside the back-off
    clock = 2000;
    await catalog.ensure();
    expect(catalog.entry("p/a")).toBeDefined();
  });

  it("the first load is waited for at most loadTimeoutMs, and nobody waits again for a catalog that hung", async () => {
    const warn = vi.fn();
    const list = vi.fn(() => new Promise<readonly RawCatalogModel[]>(() => undefined));
    const catalog = createWireCatalog(list, { loadTimeoutMs: 20, logger: { warn } });
    const started = Date.now();
    await catalog.ensure();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(warn).toHaveBeenCalledTimes(1);
    const again = Date.now();
    const timers = vi.spyOn(globalThis, "setTimeout");
    try {
      await catalog.ensure();
      // A second 20 ms wait must fail even though CI gets a generous wall-clock margin.
      expect(timers.mock.calls.filter(([, ms]) => ms === 20)).toEqual([]);
    } finally {
      timers.mockRestore();
    }
    expect(Date.now() - again).toBeLessThan(150); // <15 ms target, 10x CI/coverage margin
    expect(list).toHaveBeenCalledTimes(1);
  });
});
