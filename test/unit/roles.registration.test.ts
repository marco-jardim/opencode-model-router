/**
 * #84 P2.1 T2.1.1: role agents registered on OpenCode v2 in roles mode, with their max policies,
 * fail-closed, and the `explore → explorer` alias. Nothing on v1 or in tiers mode (I1/I8).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { PermissionEvaluation } from "@opencode/plugin/promise/permission";
import type { Hooks } from "@opencode-ai/plugin";
import { registerV2Hooks } from "../../src/compat/v2-hooks";
import { invalidateConfigCache, loadConfig, overridePath, resolveActiveTiers, type RouterConfig } from "../../src/router/config";
import { GIT_TOOL_NAMES } from "../../src/router/git-tools";
import { REFUSAL_CAP, ROUTE_BUDGET_RAISE_MAX } from "../../src/router/guard-profile";
import { buildPluginAgentDefinition, pluginAgentMarker, type PluginAgentConfig } from "../../src/router/plugin-agents";
import { CONTEXT7_DOC_TOOLS, evaluatePermission, permissionRules, type PermissionRule } from "../../src/router/read-only";
import {
  approvedRootPattern, approvedRootsInForce, type ApprovedRoot, buildRoleAgentDefinition, externalDirectoryPatterns, listWorktrees, parseWorktreeList, registerRoleAgents, ROLE_DENIED_ACTIONS,
  ROLE_STEPS_MARGIN, roleAgentAlias, roleAgentOf, roleAgentSteps, roleHostActions, roleMaxPermission, workRootPattern, worktreeRootPattern,
  type RoleRegistrationOptions,
} from "../../src/router/role-agents";
import { HOST_NATIVE_ROLE_NAMES, resolveRoleTable, SHIPPED_ROLE_SPECS, type RoleSpec } from "../../src/router/roles";
import { APPROVALS_FILE_NAME } from "../../src/routing/roles/approvals";
import { newDispatchNonce, nonceTitleSuffix, registerPending, resetBindingRegistryForTests } from "../../src/routing/roles/binding";
import { roleMaxActions } from "../../src/routing/wire/dispatch";

const temps: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  invalidateConfigCache();
});

function temp(prefix = "omr-roles-reg-"): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

/** HOME redirected to a temp dir whose global override holds `override`; returns the loaded config. */
function home(override: Record<string, unknown> = {}): RouterConfig {
  const dir = temp("omr-roles-home-");
  vi.stubEnv("HOME", dir); vi.stubEnv("USERPROFILE", dir);
  mkdirSync(dirname(overridePath()), { recursive: true });
  writeFileSync(overridePath(), JSON.stringify(override));
  invalidateConfigCache();
  return loadConfig();
}

function rolesMode(cfg: RouterConfig, extra: Partial<RouterConfig> = {}): RouterConfig {
  return { ...cfg, ...extra, routing: { ...(cfg.routing ?? {}), delegation: "roles" } } as RouterConfig;
}

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", "-c", "init.defaultBranch=main", ...args], { cwd, env: GIT_ENV, stdio: "ignore" });
}
let gitOk: boolean | undefined;
function hasGit(): boolean {
  if (gitOk === undefined) {
    try { execFileSync("git", ["--version"], { stdio: "ignore" }); gitOk = true; } catch { gitOk = false; }
  }
  return gitOk;
}

/** A repository with one commit and a linked worktree `wt-1` next to it: [main, wt-1], canonical. */
function repoWithWorktree(): { main: string; wt: string } {
  const root = temp("omr-roles-repo-");
  const main = join(root, "main");
  mkdirSync(main);
  git(main, "init", "-q");
  git(main, "commit", "-q", "--allow-empty", "-m", "init");
  git(main, "worktree", "add", "-q", join(root, "wt-1"));
  return { main: realpathSync.native(main), wt: realpathSync.native(join(root, "wt-1")) };
}

const rules = (definition: Record<string, unknown>): PermissionRule[] => permissionRules(definition.permission as never);
const PROBES = [
  "read", "glob", "grep", "list", "lsp", "skill", "edit", "write", "patch", "webfetch", "websearch", "router_run", ...GIT_TOOL_NAMES, ...CONTEXT7_DOC_TOOLS,
  "execute", "subagent", "task", "delegate", "shell", "bash", "todowrite", "question", "browser", "brave_web_search", "context7_other", "router_request_authority", "mcp_x",
];

function options(over: Partial<RoleRegistrationOptions> = {}): RoleRegistrationOptions & { warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  return { context7: false, directory: "/nowhere", seed: {}, warn, listWorktrees: async () => [], ...over } as never;
}

describe("role agent max policies", () => {
  it.each(SHIPPED_ROLE_SPECS.map((spec) => [spec.agent, spec] as const))("%s: deny-by-default, only its own actions, execute never", (_name, spec) => {
    for (const context7 of [false, true]) {
      const allowed = roleHostActions(spec, { context7 });
      const permission = roleMaxPermission(spec, { context7, externalDirectory: [] });
      const list = permissionRules(permission);
      expect(list[0]).toEqual({ action: "*", resource: "*", effect: "deny" });
      expect(allowed).not.toContain("execute");
      for (const action of ROLE_DENIED_ACTIONS) expect(permission[action]).toBe("deny");
      for (const action of PROBES) {
        const resource = action === "read" ? "src/file.ts" : "*";
        expect([action, evaluatePermission(list, action, resource)]).toEqual([action, allowed.includes(action) ? "allow" : "deny"]);
      }
      // P-12: plugin tools are listed by name, never through a wildcard.
      if (spec.authority.allow.includes("router_git")) for (const name of GIT_TOOL_NAMES) expect(permission[name]).toBe("allow");
      if (spec.authority.allow.includes("router_run")) expect(permission.router_run).toBe("allow");
      expect(list.some((rule) => rule.effect !== "deny" && /[*?]/.test(rule.action))).toBe(false);
      // context7 doc tools only when the server is configured, and only for the researcher.
      for (const name of CONTEXT7_DOC_TOOLS) expect(allowed.includes(name)).toBe(context7 && spec.authority.allow.includes("context7"));
    }
  });

  it("keeps the read-only tiers' sensitive-read asks for roles that read", () => {
    const explorer = SHIPPED_ROLE_SPECS.find((s) => s.agent === "explorer")!;
    const list = permissionRules(roleMaxPermission(explorer, { context7: false, externalDirectory: [] }));
    expect(evaluatePermission(list, "read", ".env")).toBe("ask");
    expect(evaluatePermission(list, "read", "config/.env.production")).toBe("ask");
    expect(evaluatePermission(list, "read", ".env.example")).toBe("allow");
    expect(evaluatePermission(list, "read", "src/index.ts")).toBe("allow");
  });

  it("writes external_directory only for local roles, never `*`", () => {
    const patterns = ["D:\\git\\repo\\*", "D:\\git\\omr-rta-*", "*", "**"];
    for (const spec of SHIPPED_ROLE_SPECS) {
      const permission = roleMaxPermission(spec, { context7: true, externalDirectory: patterns });
      const list = permissionRules(permission);
      const own = list.filter((rule) => rule.action === "external_directory");
      if (spec.agent === "researcher") {
        expect(own).toEqual([]);
        expect(evaluatePermission(list, "external_directory", "D:/git/repo/*")).toBe("deny");
        expect(evaluatePermission(list, "read", "src/file.ts")).toBe("deny");
        continue;
      }
      expect(own.map((rule) => rule.resource)).toEqual(["D:\\git\\repo\\*", "D:\\git\\omr-rta-*"]);
      expect(own.every((rule) => rule.effect === "allow")).toBe(true);
      expect(evaluatePermission(list, "external_directory", "D:/git/repo/*")).toBe("allow");
      expect(evaluatePermission(list, "external_directory", "D:/git/repo/sub/deep/*")).toBe("allow");
      expect(evaluatePermission(list, "external_directory", "D:/git/omr-rta-p21/*")).toBe("allow");
      expect(evaluatePermission(list, "external_directory", "D:/git/other/*")).toBe("deny");
      expect(evaluatePermission(list, "external_directory", "C:/Windows/*")).toBe("deny");
    }
  });

  it("steps = top budget raised by budget= (2x) + REFUSAL_CAP + margin", () => {
    expect(ROLE_STEPS_MARGIN).toBe(5);
    const want: Record<string, number> = { explorer: 95, researcher: 95, runner: 95, implementer: 255, reviewer: 255, architect: 255, general: 255 };
    for (const spec of SHIPPED_ROLE_SPECS) {
      const top = Math.max(...Object.values(spec.budget));
      expect(roleAgentSteps(spec)).toBe(ROUTE_BUDGET_RAISE_MAX * top + REFUSAL_CAP + ROLE_STEPS_MARGIN);
      expect(roleAgentSteps(spec)).toBe(want[spec.agent]);
    }
  });

  it("QA-G-A3-6: the top budget of the steps is never below the tier agents' budget (the fallback of a lifted tier)", () => {
    // A role whose own budgets are all below TIER_GUARD_BUDGET (25) can still be guarded at 25 (raised up to 2×) on a tier it has
    // no budget for: its steps must cover that, or the host's step limit fires before the guard's `NEED MORE: budget`.
    expect(roleAgentSteps({ budget: { fast: 10, medium: 12 } })).toBe(ROUTE_BUDGET_RAISE_MAX * 25 + REFUSAL_CAP + ROLE_STEPS_MARGIN);
    expect(roleAgentSteps({ budget: {} })).toBe(ROUTE_BUDGET_RAISE_MAX * 25 + REFUSAL_CAP + ROLE_STEPS_MARGIN);
    expect(roleAgentSteps({ budget: { fast: 40 } })).toBe(ROUTE_BUDGET_RAISE_MAX * 40 + REFUSAL_CAP + ROLE_STEPS_MARGIN);
  });

  it("a definition carries the floor model/variant, the prompt verbatim, steps and the role marker", () => {
    const spec = SHIPPED_ROLE_SPECS.find((s) => s.agent === "implementer")!;
    const definition = buildRoleAgentDefinition(spec, { model: "prov/floor-model", variant: "low" }, { context7: false, externalDirectory: [] });
    expect(definition).toMatchObject({ model: "prov/floor-model", variant: "low", mode: "subagent", description: spec.description, prompt: spec.prompt, steps: 255, maxSteps: 255 });
    expect(pluginAgentMarker(definition)).toEqual({ tier: spec.tierRange.floor, readOnly: false, role: "implementer" });
    expect(roleAgentOf(definition)).toBe("implementer");
    expect(Object.keys(definition)).not.toContain("tools");
    expect(() => buildRoleAgentDefinition(spec, { model: "no-provider" }, { context7: false, externalDirectory: [] })).toThrow(/provider\/model/);
    const noVariant = buildRoleAgentDefinition(spec, { model: "prov/m" }, { context7: false, externalDirectory: [] });
    expect(Object.hasOwn(noVariant, "variant")).toBe(false);
  });
});

describe("external_directory patterns (P-11, S11)", () => {
  it("parses porcelain output: bare entries skipped, CRLF tolerated", () => {
    const out = "worktree D:/git/repo\r\nHEAD abc\r\nbranch refs/heads/main\r\n\r\nworktree D:/git/wt-1\r\nHEAD def\r\ndetached\r\n\r\nworktree D:/git/bare.git\r\nbare\r\n\r\nworktree D:/git/gone\r\nHEAD 123\r\nprunable gitdir file points to non-existent location\r\n";
    expect(parseWorktreeList(out)).toEqual(["D:/git/repo", "D:/git/wt-1", "D:/git/gone"]);
  });

  it("a worktree root becomes its canonical long form + `<sep>*`; a missing one is dropped", () => {
    const base = temp();
    const sub = join(base, "wt-a");
    mkdirSync(sub);
    expect(worktreeRootPattern(sub.replaceAll("\\", "/"))).toBe(join(sub, "*"));
    expect(worktreeRootPattern(join(base, "missing"))).toBeUndefined();
    const found = externalDirectoryPatterns([sub, join(base, "missing"), sub], []);
    expect(found.patterns).toEqual([join(sub, "*")]);
    expect(found.problems).toHaveLength(1);
  });

  it("a workRoots glob keeps its tail after the canonical static prefix", () => {
    const base = temp();
    const sep = process.platform === "win32" ? "\\" : "/";
    expect(workRootPattern(`${base.replaceAll("\\", "/")}/omr-rta-*`)).toEqual({ pattern: `${base}${sep}omr-rta-*` });
    expect(workRootPattern(`${base}${sep}omr-*${sep}**`)).toEqual({ pattern: `${base}${sep}omr-*${sep}**` });
    expect(workRootPattern(base)).toEqual({ pattern: join(base, "*") });
  });

  it("P1.6: a repoParents entry becomes `<canonical parent><sep>*`; a missing one gives no pattern and a problem", () => {
    const base = temp();
    const sep = process.platform === "win32" ? "\\" : "/";
    const found = externalDirectoryPatterns([], [], undefined, [base.replaceAll("\\", "/"), `${base}${sep}`, join(base, "missing")]);
    expect(found.patterns).toEqual([`${base}${sep}*`]);
    expect(found.problems).toHaveLength(1);
    expect(found.problems[0]).toContain("routing.repoParents");
    expect(found.problems[0]).toContain("missing");
  });

  it("P1.6: parents and workRoots give both patterns, de-duplicated; no parents is unchanged", () => {
    const base = temp();
    const sep = process.platform === "win32" ? "\\" : "/";
    const root = base.replaceAll("\\", "/");
    const both = externalDirectoryPatterns([], [`${root}/omr-*`], undefined, [root]);
    expect(both.patterns).toEqual([`${base}${sep}omr-*`, `${base}${sep}*`]);
    expect(both.problems).toEqual([]);
    const dup = externalDirectoryPatterns([], [`${root}/*`], undefined, [root]);
    expect(dup.patterns).toEqual([`${base}${sep}*`]);
    expect(externalDirectoryPatterns([], [`${root}/omr-*`], undefined, [])).toEqual(externalDirectoryPatterns([], [`${root}/omr-*`]));
  });

  it("fails closed: wildcard-only, relative, 8.3, dot segments and missing prefixes give no pattern", () => {
    const base = temp();
    for (const entry of ["*", "/**", "D:/**", "relative/x-*", `${base}/PROGRA~1/x`, `${base}/a/../b-*`, join(base, "nope", "x-*"), join(base, "nope")]) {
      const result = workRootPattern(entry);
      expect([entry, result.pattern]).toEqual([entry, undefined]);
      expect(result.problem).toBeTruthy();
    }
    // A canonical form that still carries an 8.3-looking component is refused too.
    expect(worktreeRootPattern("X:/anything", () => "C:\\PROGRA~1\\repo")).toBeUndefined();
    expect(workRootPattern("C:/Users/me/omr-*", () => "C:\\Users\\ME~1").pattern).toBeUndefined();
    const found = externalDirectoryPatterns([], ["*", `${base}/ok-*`]);
    expect(found.patterns).toEqual([`${base}${process.platform === "win32" ? "\\" : "/"}ok-*`]);
    expect(found.problems).toHaveLength(1);
  });

  it.skipIf(!hasGit())("lists the repository's worktrees with git", async () => {
    const { main, wt } = repoWithWorktree();
    const listed = (await listWorktrees(main)).map((path) => realpathSync.native(path));
    expect(listed).toEqual([main, wt]);
    const fromSibling = (await listWorktrees(wt)).map((path) => realpathSync.native(path));
    expect(fromSibling).toEqual([main, wt]);
    await expect(listWorktrees(join(main, "..", "no-such-dir"))).rejects.toThrow();
  }, 60_000);
});

describe("cross-repo Phase 4: approved repositories (SD-P4-15)", () => {
  const DAY = 86_400_000;
  const NOW = Date.UTC(2026, 9, 12, 12);
  const sep = process.platform === "win32" ? "\\" : "/";
  /** A store entry approved and last used `ageDays` before NOW. */
  const approval = (path: string, ageDays = 0): ApprovedRoot => ({ path, approvedAt: NOW - ageDays * DAY, lastUsedAt: NOW - ageDays * DAY });
  const routing = (over: { repoParents?: string[]; repoExclude?: string[]; repoApprovalDays?: number } = {}) => ({
    repoParents: ["/parents"], repoExclude: [], repoApprovalDays: 14, ...over,
  });

  it("approvedRootPattern: an existing canonical path becomes `<path><sep>*`", () => {
    const ext = temp("omr-roles-ext-");
    expect(approvedRootPattern(ext)).toEqual({ pattern: `${ext}${sep}*` });
  });

  it("approvedRootPattern fails closed: missing, moved (realpath differs), junction, relative and 8.3 paths give no pattern", () => {
    const base = temp("omr-roles-ext-");
    const target = join(base, "target");
    mkdirSync(target);
    const link = join(base, "link");
    symlinkSync(target, link, "junction");
    for (const [path, realpath] of [
      [join(base, "missing"), undefined],
      [target, () => join(base, "elsewhere")],
      [link, undefined],
      ["relative/repo", () => "relative/repo"],
      [join(base, "PROGRA~1"), (p: string) => p],
    ] as const) {
      const result = approvedRootPattern(path, realpath);
      expect([path, result.pattern]).toEqual([path, undefined]);
      expect(result.problem).toBeTruthy();
    }
    expect(approvedRootPattern(target, () => "C:\\PROGRA~1\\repo").pattern).toBeUndefined();
  });

  it.skipIf(process.platform !== "win32")("approvedRootPattern compares the realpath case-insensitively on win32", () => {
    expect(approvedRootPattern("C:\\Repos\\Ext", () => "c:\\repos\\ext")).toEqual({ pattern: "c:\\repos\\ext\\*" });
    expect(approvedRootPattern("C:\\Repos\\Ext", () => "C:\\Repos\\Other").pattern).toBeUndefined();
  });

  it("approvedRootsInForce: no parents gives none; expired dropped silently; excluded reported; valid kept once", () => {
    const valid = approval("/ext/repo", 1);
    expect(approvedRootsInForce([valid], routing({ repoParents: [] }), NOW)).toEqual({ paths: [], problems: [] });
    expect(approvedRootsInForce([valid, valid], routing(), NOW)).toEqual({ paths: ["/ext/repo"], problems: [] });
    // Expiry: `lastUsedAt + repoApprovalDays`, exactly at the instant is expired; the 90-day cap wins over recent use.
    expect(approvedRootsInForce([approval("/ext/old", 14)], routing(), NOW).paths).toEqual([]);
    expect(approvedRootsInForce([{ path: "/ext/old", approvedAt: NOW - 14 * DAY, lastUsedAt: NOW - 14 * DAY + 1 }], routing(), NOW).paths).toEqual(["/ext/old"]);
    expect(approvedRootsInForce([approval("/ext/old", 3)], routing({ repoApprovalDays: 2 }), NOW).paths).toEqual([]);
    expect(approvedRootsInForce([{ path: "/ext/capped", approvedAt: NOW - 90 * DAY, lastUsedAt: NOW }], routing(), NOW).paths).toEqual([]);
    // Exclusion wins over an approval, on the path text.
    const excluded = approvedRootsInForce([valid, approval("/ext/other")], routing({ repoExclude: ["/ext/repo"] }), NOW);
    expect(excluded.paths).toEqual(["/ext/other"]);
    expect(excluded.problems).toHaveLength(1);
    expect(excluded.problems[0]).toContain("routing.repoExclude");
    expect(approvedRootsInForce([valid], routing({ repoExclude: ["/ext/*"] }), NOW).paths).toEqual([]);
  });

  it("externalDirectoryPatterns: approved paths give a pattern only with parents (I9)", () => {
    const parent = temp("omr-roles-parent-");
    const ext = temp("omr-roles-ext-");
    expect(externalDirectoryPatterns([], [], undefined, [parent], [ext]).patterns).toEqual([`${parent}${sep}*`, `${ext}${sep}*`]);
    expect(externalDirectoryPatterns([], [], undefined, [], [ext])).toEqual({ patterns: [], problems: [] });
    const moved = externalDirectoryPatterns([], [], (p) => (p === ext ? join(parent, "x") : realpathSync.native(p)), [parent], [ext]);
    expect(moved.patterns).toEqual([`${parent}${sep}*`]);
    expect(moved.problems).toHaveLength(1);
    expect(moved.problems[0]).toContain("approved repository");
  });

  /** Roles mode with `parents`, `exclude` and `days` set on the global layer's routing. */
  function rolesWith(parents: string[], exclude: string[] = [], days?: number): RouterConfig {
    const cfg = rolesMode(home(), {});
    const r = cfg.routing as { repoParents?: string[]; repoExclude?: string[]; repoApprovalDays?: number };
    r.repoParents = parents;
    r.repoExclude = exclude;
    if (days !== undefined) r.repoApprovalDays = days;
    return cfg;
  }
  const externalOf = (agents: Record<string, Record<string, unknown>>, name: string): string[] =>
    rules(agents[name]!).filter((rule) => rule.action === "external_directory").map((rule) => rule.resource);

  it("registerRoleAgents: a valid approval adds `<path><sep>*` to the local roles only", async () => {
    const parent = temp("omr-roles-parent-");
    const ext = temp("omr-roles-ext-");
    const agents: Record<string, Record<string, unknown>> = {};
    const opts = options({ approvedRoots: [approval(ext, 1)], now: () => NOW });
    const result = await registerRoleAgents(agents, rolesWith([parent]), opts);
    expect(result.failed).toBe(false);
    expect(result.externalDirectory).toEqual([`${parent}${sep}*`, `${ext}${sep}*`]);
    expect(opts.warn).not.toHaveBeenCalled();
    for (const spec of SHIPPED_ROLE_SPECS) {
      expect([spec.agent, externalOf(agents, spec.agent)]).toEqual([spec.agent, spec.agent === "researcher" ? [] : [`${parent}${sep}*`, `${ext}${sep}*`]]);
    }
  });

  it("registerRoleAgents: expired, excluded, moved and invalid approvals give no pattern", async () => {
    const parent = temp("omr-roles-parent-");
    const base = temp("omr-roles-ext-");
    const expired = join(base, "expired");
    const excluded = join(base, "excluded");
    const target = join(base, "target");
    const moved = join(base, "moved");
    for (const dir of [expired, excluded, target]) mkdirSync(dir);
    symlinkSync(target, moved, "junction");
    const approvedRoots = [approval(expired, 15), approval(excluded), approval(moved), approval(join(base, "gone")), approval("relative/repo"), approval(join(base, "PROGRA~1"))];
    const agents: Record<string, Record<string, unknown>> = {};
    const opts = options({ approvedRoots, now: () => NOW });
    const result = await registerRoleAgents(agents, rolesWith([parent], [excluded.replaceAll("\\", "/")]), opts);
    expect(result.failed).toBe(false);
    expect(result.externalDirectory).toEqual([`${parent}${sep}*`]);
    expect(externalOf(agents, "implementer")).toEqual([`${parent}${sep}*`]);
    const warned = opts.warn.mock.calls.map((call) => String(call[1]));
    expect(warned.some((line) => line.includes(excluded) && line.includes("routing.repoExclude"))).toBe(true);
    expect(warned.some((line) => line.includes(moved) && line.includes("not the approved path"))).toBe(true);
    expect(warned.some((line) => line.includes(expired))).toBe(false); // expiry is silent
  });

  it("registerRoleAgents: repoApprovalDays lowered after approval drops the pattern", async () => {
    const parent = temp("omr-roles-parent-");
    const ext = temp("omr-roles-ext-");
    const opts = options({ approvedRoots: [approval(ext, 3)], now: () => NOW });
    expect((await registerRoleAgents({}, rolesWith([parent]), opts)).externalDirectory).toEqual([`${parent}${sep}*`, `${ext}${sep}*`]);
    expect((await registerRoleAgents({}, rolesWith([parent], [], 2), opts)).externalDirectory).toEqual([`${parent}${sep}*`]);
  });

  it("registerRoleAgents: no parents gives no approved pattern (I9)", async () => {
    const ext = temp("omr-roles-ext-");
    const realpath = vi.fn((p: string) => realpathSync.native(p));
    const opts = options({ approvedRoots: [approval(ext)], now: () => NOW, realpath });
    const result = await registerRoleAgents({}, rolesWith([]), opts);
    expect(result.failed).toBe(false);
    expect(result.externalDirectory).toEqual([]);
    expect(realpath).not.toHaveBeenCalled();
    expect(opts.warn).not.toHaveBeenCalled();
  });

  it("registerRoleAgents: tiers mode ignores approvals and touches nothing (I1)", async () => {
    const ext = temp("omr-roles-ext-");
    const cfg = home({ routing: { repoParents: [temp("omr-roles-parent-")] } });
    expect(cfg.routing?.delegation ?? "tiers").toBe("tiers");
    const agents = { general: { mode: "subagent", model: "host/g" } };
    const before = JSON.stringify(agents);
    const realpath = vi.fn((p: string) => realpathSync.native(p));
    const opts = options({ approvedRoots: [approval(ext)], now: () => NOW, realpath });
    expect(await registerRoleAgents(agents, cfg, opts)).toMatchObject({ registered: [], externalDirectory: [], failed: false });
    expect(JSON.stringify(agents)).toBe(before);
    expect(realpath).not.toHaveBeenCalled();
    expect(opts.warn).not.toHaveBeenCalled();
  });
});

describe("registerRoleAgents", () => {
  it("tiers mode: returns at once, touches nothing (I1)", async () => {
    const cfg = home();
    expect(cfg.routing?.delegation ?? "tiers").toBe("tiers");
    const agents = { general: { mode: "subagent", model: "host/g" }, fast: { mode: "subagent", model: "p/m" } };
    const before = JSON.stringify(agents);
    const listWorktreesSpy = vi.fn(async () => ["/x"]);
    const resolveTable = vi.fn(resolveRoleTable);
    const opts = options({ listWorktrees: listWorktreesSpy, resolveTable, seed: { general: { mode: "subagent" } } });
    const result = await registerRoleAgents(agents, cfg, opts);
    expect(result).toMatchObject({ registered: [], removed: [], replaced: [], failed: false });
    expect(JSON.stringify(agents)).toBe(before);
    expect(listWorktreesSpy).not.toHaveBeenCalled();
    expect(resolveTable).not.toHaveBeenCalled();
    expect(opts.warn).not.toHaveBeenCalled();
  });

  it("P1.6: routing.repoParents become `<parent><sep>*` allow rules in local roles only; a missing parent warns", async () => {
    const base = temp();
    const sep = process.platform === "win32" ? "\\" : "/";
    const cfg = rolesMode(home(), {});
    (cfg.routing as { repoParents?: string[] }).repoParents = [base.replaceAll("\\", "/"), join(base, "missing-parent")];
    const agents: Record<string, Record<string, unknown>> = {};
    const opts = options();
    const result = await registerRoleAgents(agents, cfg, opts);
    expect(result.failed).toBe(false);
    expect(result.externalDirectory).toEqual([`${base}${sep}*`]);
    expect(opts.warn).toHaveBeenCalledTimes(1);
    expect(String(opts.warn.mock.calls[0]![1])).toContain("routing.repoParents");
    for (const spec of SHIPPED_ROLE_SPECS) {
      const own = rules(agents[spec.agent]!).filter((rule) => rule.action === "external_directory");
      expect([spec.agent, own.map((rule) => rule.resource)]).toEqual([spec.agent, spec.agent === "researcher" ? [] : [`${base}${sep}*`]]);
    }
  });

  it("roles mode: every role registered, general replaced, floor model, worktree + workRoots rules", async () => {
    const base = temp();
    const cfg = rolesMode(home(), {});
    (cfg.routing as { workRoots?: string[] }).workRoots = [`${base.replaceAll("\\", "/")}/omr-*`];
    const tiers = resolveActiveTiers(cfg);
    const agents: Record<string, Record<string, unknown>> = { general: { mode: "subagent", model: "host/general" }, fast: { mode: "subagent", model: "p/m" } };
    const fast = JSON.stringify(agents.fast);
    const wt = join(base, "wt-1");
    mkdirSync(wt);
    const opts = options({ listWorktrees: async () => [wt.replaceAll("\\", "/")], seed: { general: { mode: "subagent", model: "host/general" } } });
    const result = await registerRoleAgents(agents, cfg, opts);
    const table = resolveRoleTable(cfg, "v2", { context7: false });
    expect(result.failed).toBe(false);
    expect([...result.registered].sort()).toEqual([...table.roles.keys()].sort());
    expect(result.registered).toEqual(expect.arrayContaining(["explorer", "researcher", "runner", "implementer", "reviewer", "architect", "general"]));
    const sep = process.platform === "win32" ? "\\" : "/";
    expect(result.externalDirectory).toEqual([join(wt, "*"), `${base}${sep}omr-*`]);
    for (const [name, spec] of table.roles as ReadonlyMap<string, RoleSpec>) {
      const definition = agents[name]!;
      const floor = tiers[spec.tierRange.floor]!;
      expect(definition.model).toBe(floor.model);
      expect(definition.variant).toBe(floor.variant || undefined);
      expect(definition.prompt).toBe(spec.prompt);
      expect(definition.steps).toBe(roleAgentSteps(spec));
      expect(roleAgentOf(definition)).toBe(name);
      expect((definition.permission as Record<string, unknown>)["*"]).toBe("deny");
      expect((definition.permission as Record<string, unknown>).execute).toBe("deny");
    }
    expect(HOST_NATIVE_ROLE_NAMES).toContain("general");
    expect(agents.general!.model).not.toBe("host/general");
    expect(JSON.stringify(agents.fast)).toBe(fast);
    expect(opts.warn).not.toHaveBeenCalled();
  });

  it("passes the real context7 flag; dropped #81 agents are overwritten, replacing ones kept", async () => {
    const cfg0 = home();
    const tiers = resolveActiveTiers(cfg0);
    const architect: PluginAgentConfig = { tier: Object.keys(tiers).at(-1)!, description: "custom architect", readOnly: true };
    const reviewer: PluginAgentConfig = { tier: Object.keys(tiers).at(-1)!, description: "custom reviewer", readOnly: true, allowTools: ["webfetch"] };
    const cfg = rolesMode(cfg0, { agents: { architect, reviewer } } as Partial<RouterConfig>);
    for (const context7 of [false, true]) {
      const agents: Record<string, Record<string, unknown>> = {
        architect: buildPluginAgentDefinition(architect, tiers[architect.tier]!, { context7, host: "v1" }),
        reviewer: buildPluginAgentDefinition(reviewer, tiers[reviewer.tier]!, { context7, host: "v1" }),
      };
      const result = await registerRoleAgents(agents, cfg, options({ context7 }));
      // reviewer: local + webfetch fails the separation rule either way → dropped, the shipped role registered over it.
      expect(roleAgentOf(agents.reviewer)).toBe("reviewer");
      expect(result.removed).toContain("reviewer");
      if (context7) {
        // The read-only base grants the context7 doc tools only when context7 is configured: then architect is dropped too.
        expect(roleAgentOf(agents.architect)).toBe("architect");
        expect(result.replaced).toEqual([]);
      } else {
        expect(roleAgentOf(agents.architect)).toBeUndefined();
        expect(agents.architect!.description).toBe("custom architect");
        expect(result.replaced).toEqual(["architect"]);
        expect(result.registered).not.toContain("architect");
      }
    }
  });

  it("a dropped #81 agent whose role is disabled is removed, not left registered", async () => {
    const cfg0 = home();
    const tiers = resolveActiveTiers(cfg0);
    const entry: PluginAgentConfig = { tier: Object.keys(tiers)[0]!, description: "x", readOnly: true, allowTools: ["webfetch"] };
    const cfg = rolesMode(cfg0, { agents: { explorer: entry }, roleAgents: { explorer: { enabled: false } } } as Partial<RouterConfig>);
    const agents: Record<string, Record<string, unknown>> = { explorer: buildPluginAgentDefinition(entry, tiers[entry.tier]!, { context7: false, host: "v1" }) };
    const result = await registerRoleAgents(agents, cfg, options());
    expect(Object.hasOwn(agents, "explorer")).toBe(false);
    expect(result.removed).toEqual(["explorer"]);
    expect(result.registered).not.toContain("explorer");
  });

  it("fails closed: a throwing resolution registers no role agent, removes role-named #81 agents, logs once", async () => {
    const cfg0 = home();
    const tiers = resolveActiveTiers(cfg0);
    const cfg = rolesMode(cfg0);
    const warned = new Set<string>();
    const warn = vi.fn((key: string, _message: string) => { warned.add(key); });
    const once: RoleRegistrationOptions["warn"] = (key, message) => { if (!warned.has(key)) warn(key, message); };
    for (let i = 0; i < 2; i++) {
      const entry: PluginAgentConfig = { tier: Object.keys(tiers)[0]!, description: "x", readOnly: true };
      const agents: Record<string, Record<string, unknown>> = {
        fast: { mode: "subagent", model: "p/fast" },
        explorer: buildPluginAgentDefinition(entry, tiers[entry.tier]!, { context7: false, host: "v1" }),
        general: buildPluginAgentDefinition(entry, tiers[entry.tier]!, { context7: false, host: "v1" }),
        custom: buildPluginAgentDefinition(entry, tiers[entry.tier]!, { context7: false, host: "v1" }),
      };
      const result = await registerRoleAgents(agents, cfg, options({
        warn: once, seed: { general: { mode: "subagent", model: "host/general" } },
        resolveTable: () => { throw new Error("boom"); },
      }));
      expect(result).toMatchObject({ registered: [], failed: true });
      expect([...result.removed].sort()).toEqual(["explorer", "general"]);
      expect(Object.keys(agents).sort()).toEqual(["custom", "fast", "general"]);
      expect(agents.general).toEqual({ mode: "subagent", model: "host/general" });
      expect(agents.fast).toEqual({ mode: "subagent", model: "p/fast" });
      expect(Object.values(agents).some((definition) => roleAgentOf(definition) !== undefined)).toBe(false);
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![1])).toMatch(/^roles mode \(OpenCode v2 only\): role agent registration failed \(boom\); no role agent is registered$/);
  });

  it("fails closed all-or-nothing: one role without a usable floor model registers none", async () => {
    const cfg0 = home();
    const cfg = rolesMode(cfg0);
    const preset = resolveActiveTiers(cfg);
    const firstTier = Object.keys(preset)[0]!;
    const broken = { ...cfg, presets: Object.fromEntries(Object.entries(cfg.presets).map(([name, tiers]) => [name, { ...tiers, [firstTier]: { ...tiers[firstTier]!, model: "no-slash" } }])) } as RouterConfig;
    const agents: Record<string, Record<string, unknown>> = {};
    const opts = options();
    const result = await registerRoleAgents(agents, broken, opts);
    expect(result.failed).toBe(true);
    expect(agents).toEqual({});
    expect(opts.warn).toHaveBeenCalledTimes(1);
  });

  it("an unlistable repository registers the roles without worktree rules, with a notice", async () => {
    const cfg = rolesMode(home());
    const agents: Record<string, Record<string, unknown>> = {};
    const opts = options({ listWorktrees: async () => { throw new Error("not a git repository"); } });
    const result = await registerRoleAgents(agents, cfg, opts);
    expect(result.failed).toBe(false);
    expect(result.externalDirectory).toEqual([]);
    expect(result.registered.length).toBeGreaterThan(0);
    for (const name of result.registered) expect((agents[name]!.permission as Record<string, unknown>).external_directory).toBeUndefined();
    expect(opts.warn).toHaveBeenCalledWith("roles:worktrees", expect.stringContaining("not a git repository"));
  });

  it("warns when a non-native host agent carries a role name; never for general", async () => {
    const cfg = rolesMode(home());
    const agents: Record<string, Record<string, unknown>> = { reviewer: { mode: "subagent" }, general: { mode: "subagent" } };
    const opts = options({ seed: { reviewer: { mode: "subagent" }, general: { mode: "subagent" } } });
    await registerRoleAgents(agents, cfg, opts);
    expect(opts.warn).toHaveBeenCalledTimes(1);
    expect(opts.warn).toHaveBeenCalledWith("roles:host-agent:reviewer", expect.stringContaining("host agent reviewer"));
  });
});

describe("roleAgentAlias (P-7)", () => {
  it("aliases explore → explorer only in roles mode and only to a registered role agent", () => {
    const cfg = home();
    const roles = rolesMode(cfg);
    expect(roleAgentAlias("explore", roles, () => true)).toBe("explorer");
    expect(roleAgentAlias("explore", roles, () => false)).toBeUndefined();
    expect(roleAgentAlias("explore", cfg, () => true)).toBeUndefined();
    expect(roleAgentAlias("explorer", roles, () => true)).toBeUndefined();
    expect(roleAgentAlias("fast", roles, () => true)).toBeUndefined();
    expect(roleAgentAlias(undefined, roles, () => true)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Through the v2 adapter (agent transform, permission/context hooks, execute.before)
// ---------------------------------------------------------------------------

// `registrationWorktrees` stubs the registration-time `git worktree list`: a spawn of real git against a non-repository temp
// directory costs seconds on Windows CI (it blew the 5 s test timeout) and none of the stubbed tests assert on worktrees.
function fixture(directory: string, registrationWorktrees: (directory: string) => Promise<string[]> = async () => []) {
  const sessionHooks: Record<string, (event: any) => Promise<void>> = {};
  const toolHooks: Record<string, (event: any) => Promise<void>> = {};
  const permissionHooks: Record<string, (event: PermissionEvaluation) => Promise<void>> = {};
  const hostDefaults = [{ action: "*", resource: "*", effect: "allow" }, { action: "external_directory", resource: "*", effect: "ask" }];
  const agents: Record<string, any> = {
    explore: { id: "explore", mode: "subagent", model: { providerID: "host", id: "explore" }, permissions: [...hostDefaults], request: { settings: {}, headers: {}, body: {} } },
    general: { id: "general", mode: "subagent", model: { providerID: "host", id: "general" }, permissions: [...hostDefaults, { action: "todowrite", resource: "*", effect: "deny" }], request: { settings: {}, headers: {}, body: {} } },
    build: { id: "build", mode: "primary", request: { settings: {}, headers: {}, body: {} } },
  };
  const register = () => ({ dispose: vi.fn(async () => {}) });
  const editors = {
    agent: { update: (id: string, apply: (agent: any) => void) => { agents[id] ??= { id, mode: "primary", permissions: [...hostDefaults], request: { settings: {}, headers: {}, body: {} } }; apply(agents[id]); } },
    command: { add: () => {} },
    tool: { add: () => {} },
  };
  const ctx = {
    location: { directory, project: { directory } },
    agent: { reload: vi.fn(async () => {}), list: vi.fn(async () => ({ data: Object.values(agents) })), transform: vi.fn(async (cb: any) => { cb(editors.agent); return register(); }) },
    command: { reload: vi.fn(async () => {}), transform: vi.fn(async (cb: any) => { cb(editors.command); return register(); }) },
    tool: {
      transform: vi.fn(async (cb: any) => { cb(editors.tool); return register(); }),
      hook: vi.fn(async (name: string, cb: any) => { toolHooks[name] = cb; return register(); }),
    },
    session: {
      get: vi.fn(async () => ({ id: "child", parentID: "root", agent: "explorer" })),
      update: vi.fn(async () => {}), context: vi.fn(async () => [] as any[]),
      prompt: vi.fn(async () => {}), synthetic: vi.fn(async () => {}),
      hook: vi.fn(async (name: string, cb: any) => { sessionHooks[name] = cb; return register(); }),
    },
    permission: { hook: vi.fn(async (name: string, cb: (event: PermissionEvaluation) => Promise<void>) => { permissionHooks[name] = cb; return register(); }) },
    event: { subscribe: async function* ({ signal }: { signal: AbortSignal }) { await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })); } },
  };
  return {
    ctx, agents, sessionHooks, toolHooks, permissionHooks,
    async start(hooks: Record<string, any> = {}, extra: Partial<NonNullable<Parameters<typeof registerV2Hooks>[3]>> = {}) {
      const cleanup = await registerV2Hooks(ctx as unknown as Context, hooks as Hooks, undefined, { listRegistrationWorktrees: registrationWorktrees, ...extra });
      cleanups.push(cleanup);
    },
  };
}

const evaluation = (agent: string, action: string, resources: string[]): PermissionEvaluation => ({
  sessionID: "child", agent, action, resources, effect: "allow",
} as unknown as PermissionEvaluation);

// Each test here builds the whole v2 adapter (config load, role-agent registration, hook wiring) on a temp directory; on a loaded
// Windows runner that alone exceeded the default 5 s (the "aliases explore" test timed out there with git already stubbed).
describe("v2 adapter in roles mode", { timeout: 60_000 }, () => {
  it.skipIf(!hasGit())("publishes the max policies, protects every role agent (P-19) and strips its catalog", async () => {
    const { main, wt } = repoWithWorktree();
    home({ routing: { delegation: "roles" } });
    const f = fixture(main, listWorktrees); // a real repository: the real git listing
    const generalBefore = JSON.parse(JSON.stringify(f.agents.general));
    // #84 P2.3 (approved amendment of this P2.1 test): each role's child below is bound EXACTLY to a dispatch whose grant is the
    // role max with the sibling worktree as work root, so the max policy is what decides. An unbound child is narrowed to
    // max ∩ local with external_directory denied (I9) — asserted in test/integration/roles-authority.test.ts.
    resetBindingRegistryForTests();
    const boundSessions = new Map<string, Record<string, unknown>>();
    f.ctx.session.get.mockImplementation((async ({ sessionID }: { sessionID: string }) =>
      boundSessions.get(sessionID) ?? { id: "child", parentID: "root", agent: "explorer" }) as never);
    const root = realpathSync.native(wt);
    await f.start();
    const names = SHIPPED_ROLE_SPECS.map((spec) => spec.agent);
    for (const name of names) {
      expect(f.agents[name], name).toBeDefined();
      const published = f.agents[name].permissions as PermissionRule[];
      expect(published[0]).toEqual({ action: "*", resource: "*", effect: "deny" });
      expect(evaluatePermission(published, "execute", "*")).toBe("deny");
      expect(evaluatePermission(published, "subagent", "*")).toBe("deny");
      expect(evaluatePermission(published, "shell", "*")).toBe("deny");
      const spec = SHIPPED_ROLE_SPECS.find((s) => s.agent === name)!;
      const child = `child-${name}`;
      const nonce = newDispatchNonce();
      registerPending({
        parentSessionID: "root", callID: `call-${name}`, agent: name, description: "look", nonce,
        grant: { actions: new Set(roleMaxActions(spec)), notes: [], workRoot: root }, budget: 40, decisionID: null, registeredAt: Date.now(),
      });
      boundSessions.set(child, { id: child, parentID: "root", agent: name, title: `look${nonceTitleSuffix(nonce)}` });
      const as = (event: PermissionEvaluation): PermissionEvaluation => ({ ...event, sessionID: child } as PermissionEvaluation);
      // protectedAgent(): the router's evaluate hook enforces the policy under an allow-all parent.
      const edit = as(evaluation(name, "edit", [join(root, "src", "a.ts")]));
      await f.permissionHooks.evaluate(edit);
      const canEdit = spec.authority.allow.includes("edit");
      expect([name, edit.effect]).toEqual([name, canEdit ? "allow" : "deny"]);
      // QA-P23-A6: these refusals are the MAX policy's (its message), not the per-dispatch narrowing's.
      const label = canEdit ? "plugin agent" : "read-only agent";
      if (!canEdit) expect([name, edit.message]).toEqual([name, `Permission denied by ${label} ${name}: edit`]);
      const outside = as(evaluation(name, "external_directory", ["C:/Windows/*"]));
      await f.permissionHooks.evaluate(outside);
      expect([name, outside.effect]).toEqual([name, "deny"]);
      expect([name, outside.message]).toEqual([name, `Permission denied by ${label} ${name}: external_directory`]);
      const sibling = as(evaluation(name, "external_directory", [join(wt, "*").replaceAll("\\", "/")]));
      await f.permissionHooks.evaluate(sibling);
      expect([name, sibling.effect]).toEqual([name, name === "researcher" ? "deny" : "allow"]);
      const execute = as(evaluation(name, "execute", ["*"]));
      await f.permissionHooks.evaluate(execute);
      expect(execute.effect).toBe("deny");
    }
    // general: the host-native agent replaced by the router's role spec (model, prompt, policy).
    expect(f.agents.general.system).toBe(SHIPPED_ROLE_SPECS.find((s) => s.agent === "general")!.prompt);
    expect(f.agents.general.permissions).not.toEqual(generalBefore.permissions);
    expect(evaluatePermission(f.agents.general.permissions, "todowrite", "*")).toBe("deny"); // inherited denies kept
    // The context hook strips every tool the policy does not grant, even when the parent's catalog has it.
    const event = {
      sessionID: "child", agent: "explorer", model: { providerID: "p", id: "m" }, options: {}, system: [], messages: [],
      tools: Object.fromEntries(["read", "glob", "grep", "edit", "write", "execute", "subagent", "shell", "webfetch", "router_run", "router_git_status", "mcp_tool"].map((name) => [name, {}])),
    };
    await f.sessionHooks.context(event);
    expect(Object.keys(event.tools).sort()).toEqual(["glob", "grep", "read", "router_git_status"]);
  }, 60_000);

  it("aliases explore → explorer in execute.before through subagent_type (legacy shape)", async () => {
    home({ routing: { delegation: "roles" } });
    const f = fixture(temp());
    let legacy: Record<string, unknown> | undefined;
    await f.start({ "tool.execute.before": async (_input: unknown, output: { args: Record<string, unknown> }) => { legacy = { ...output.args }; } });
    const event = { sessionID: "root", agent: "build", messageID: "m", id: "c1", tool: "subagent", input: { agent: "explore", description: "find", prompt: "find x" } as Record<string, unknown> };
    await f.toolHooks["execute.before"](event);
    expect(legacy?.subagent_type).toBe("explorer");
    expect(event.input.agent).toBe("explorer");
    expect(Object.hasOwn(event.input, "subagent_type")).toBe(false);
  });

  it("tiers mode: no role agent, general untouched, explore not aliased (I1)", async () => {
    home();
    const f = fixture(temp());
    const generalBefore = JSON.parse(JSON.stringify(f.agents.general));
    await f.start();
    for (const name of SHIPPED_ROLE_SPECS.map((spec) => spec.agent).filter((n) => n !== "general")) expect(f.agents[name]).toBeUndefined();
    expect(f.agents.general).toEqual(generalBefore);
    const event = { sessionID: "root", agent: "build", messageID: "m", id: "c1", tool: "subagent", input: { agent: "explore", description: "find", prompt: "find x" } as Record<string, unknown> };
    await f.toolHooks["execute.before"](event);
    expect(event.input.agent).toBe("explore");
    // Host-native explore keeps its (unprotected) host policy: the router's evaluate hook does not touch it.
    const edit = evaluation("explore", "edit", ["src/a.ts"]);
    await f.permissionHooks.evaluate(edit);
    expect(edit.effect).toBe("allow");
  });

  /** A store directory holding `body` as the approvals file. */
  function store(body: string): string {
    const dir = temp("omr-roles-store-");
    writeFileSync(join(dir, APPROVALS_FILE_NAME), body);
    return dir;
  }
  const validStore = (path: string): string => {
    const at = Date.now() - 60_000;
    return store(JSON.stringify({ version: 1, approvals: [{ path, commonDir: join(path, ".git"), roots: ["a".repeat(40)], origin: "none", approvedAt: at, lastUsedAt: at }] }));
  };
  const posix = (path: string, ...rest: string[]): string => [path.replaceAll("\\", "/"), ...rest].join("/");

  it("cross-repo P4.6: buildConfig reads the approvals store and grants an approved repository to the local roles", async () => {
    const parent = temp("omr-roles-parent-");
    const ext = temp("omr-roles-ext-");
    const other = temp("omr-roles-ext-");
    home({ routing: { delegation: "roles", repoParents: [parent] } });
    const f = fixture(temp());
    await f.start({}, { approvalsDir: validStore(ext) });
    const implementer = f.agents.implementer.permissions as PermissionRule[];
    expect(evaluatePermission(implementer, "external_directory", posix(ext, "src", "*"))).toBe("allow");
    expect(evaluatePermission(implementer, "external_directory", posix(parent, "repo", "*"))).toBe("allow");
    expect(evaluatePermission(implementer, "external_directory", posix(other, "*"))).toBe("deny");
    expect(evaluatePermission(f.agents.researcher.permissions as PermissionRule[], "external_directory", posix(ext, "*"))).toBe("deny");
  });

  it("cross-repo P4.6: an invalid store grants nothing (fail closed); without parents the store is never read (I9)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const parent = temp("omr-roles-parent-");
      const ext = temp("omr-roles-ext-");
      home({ routing: { delegation: "roles", repoParents: [parent] } });
      const invalid = fixture(temp());
      await invalid.start({}, { approvalsDir: store("{not json") });
      const implementer = invalid.agents.implementer.permissions as PermissionRule[];
      expect(evaluatePermission(implementer, "external_directory", posix(parent, "repo", "*"))).toBe("allow");
      expect(evaluatePermission(implementer, "external_directory", posix(ext, "*"))).toBe("deny");
      expect(warn.mock.calls.some((call) => String(call[0]).includes("repository approvals file"))).toBe(true);

      warn.mockClear();
      home({ routing: { delegation: "roles" } });
      const noParents = fixture(temp());
      await noParents.start({}, { approvalsDir: store("{not json either") });
      expect(noParents.agents.implementer).toBeDefined();
      expect(warn.mock.calls.some((call) => String(call[0]).includes("repository approvals file"))).toBe(false);
      const valid = fixture(temp());
      await valid.start({}, { approvalsDir: validStore(ext) });
      expect(evaluatePermission(valid.agents.implementer.permissions as PermissionRule[], "external_directory", posix(ext, "*"))).toBe("deny");
    } finally {
      warn.mockRestore();
    }
  });
});
