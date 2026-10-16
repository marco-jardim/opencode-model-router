/**
 * QA-DF1-19, reverted by G-12: in roles mode the role agent registration lists the repository's worktrees
 * (`git worktree list --porcelain`) whatever `routing.workRoots` contains, so a location outside every entry keeps its
 * worktree roots as `external_directory` rules next to the `workRoots` patterns. Outside every configured work root the
 * executor home is still denied when worktrees were listed (QA-62F-1); only the executor slots-root grant is skipped there
 * (QA-5.1-5). The listing's git executable is chosen with the listed directory's work-root guards (QA-62F-4).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { invalidateConfigCache, loadConfig, localOverridePath, overridePath, resolveRouting, type RouterConfig } from "../../src/router/config";
import { evaluatePermission, permissionMatches, permissionRules, type PermissionMap } from "../../src/router/read-only";
import { listWorktrees, registerRoleAgents, roleHasLocalActions, roleMaxPermission, type RoleRegistrationOptions } from "../../src/router/role-agents";
import { SHIPPED_ROLE_SPECS } from "../../src/router/roles";
import * as gitTools from "../../src/router/git-tools";

const temps: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  invalidateConfigCache();
});

function temp(prefix = "omr-roles-wr-"): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

/** Roles mode from a temp HOME's global override, with `workRoots` (undefined: the key unset). */
function rolesConfig(workRoots: string[] | undefined): RouterConfig {
  const dir = temp("omr-roles-wr-home-");
  vi.stubEnv("HOME", dir);
  vi.stubEnv("USERPROFILE", dir);
  mkdirSync(dirname(overridePath()), { recursive: true });
  writeFileSync(overridePath(), JSON.stringify({}));
  invalidateConfigCache();
  const cfg = loadConfig();
  const routing: Record<string, unknown> = { ...(cfg.routing ?? {}), delegation: "roles" };
  if (workRoots === undefined) delete routing.workRoots;
  else routing.workRoots = workRoots;
  return { ...cfg, routing } as RouterConfig;
}

function options(directory: string, listWorktrees: (directory: string) => Promise<string[]>): RoleRegistrationOptions & { warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  return { context7: false, directory, seed: {}, warn, listWorktrees };
}

const sep = process.platform === "win32" ? "\\" : "/";
const slash = (path: string): string => path.replaceAll("\\", "/");

describe("QA-DF1-19/G-12 role agent registration and routing.workRoots", () => {
  it.each([
    ["tiers", "tiers", "enforce", "always"],
    ["leases off", "roles", "off", "always"],
    ["verification never", "roles", "enforce", "never"],
  ] as const)("does no executor discovery git or slots grant with %s", async (_label, delegation, mode, require) => {
    const base = temp(), main = join(base, "main"), slots = join(base, "slots");
    const cfg = rolesConfig(undefined);
    cfg.routing = { ...cfg.routing, delegation, leases: { mode }, executor: { slotsDir: slots } };
    cfg.enforcement = { ...cfg.enforcement, verify: { require } };
    const opts = { ...options(main, vi.fn(async () => [main])), realpath: (path: string) => path };
    const spawn = vi.spyOn(gitTools, "spawnBounded").mockRejectedValue(new Error("unexpected executor git"));
    const result = await registerRoleAgents({}, cfg, opts);
    expect(result.failed).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
    expect(result.externalDirectory).not.toContain(join(slots, "*"));
    expect(result.externalDirectoryDenied).toEqual([]);
    expect(opts.warn).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("silently skips the default slots root on POSIX", async () => {
    const cfg = rolesConfig(undefined);
    cfg.routing = { ...cfg.routing, leases: { mode: "enforce" } };
    cfg.enforcement = { ...cfg.enforcement, verify: { require: "always" } };
    const main = "/repo", home = "/repo/.git/omr-executor";
    const opts = { ...options(main, vi.fn(async () => [main])), realpath: (path: string) => path,
      executorHome: vi.fn(async () => home) };
    const result = await registerRoleAgents({}, cfg, opts);
    expect(result.externalDirectory).toEqual([join(main, "*")]);
    expect(result.externalDirectoryDenied).toEqual([join(home, "*")]);
    expect(opts.warn).not.toHaveBeenCalled();
  });

  it("QA-DF1-19/G-12 a location outside routing.workRoots still lists the worktrees and keeps the workRoots patterns", async () => {
    const base = temp();
    const outside = temp("omr-roles-wr-elsewhere-");
    const wt = join(base, "omr-wt");
    mkdirSync(join(wt, ".git"), { recursive: true });
    const home = join(wt, ".git", "omr-executor");
    const list = vi.fn(async () => [slash(wt)]);
    const executorHome = vi.fn(async () => home);
    const opts = { ...options(outside, list), executorHome };
    const cfg = rolesConfig([`${slash(base)}/omr-*`]);
    cfg.routing = { ...cfg.routing, leases: { mode: "enforce" } };
    cfg.enforcement = { ...cfg.enforcement, verify: { require: "always" } };
    // The listing and the executor-home lookup go through their seams (QA-62F-1); no other start-up git runs.
    const spawn = vi.spyOn(gitTools, "spawnBounded").mockRejectedValue(new Error("unexpected start-up git"));
    const agents: Record<string, Record<string, unknown>> = {};
    const result = await registerRoleAgents(agents, cfg, opts);
    expect(result.failed).toBe(false);
    expect(list).toHaveBeenCalledWith(outside);
    expect(spawn).not.toHaveBeenCalled();
    expect(result.externalDirectory).toEqual([join(wt, "*"), `${base}${sep}omr-*`]);
    // QA-62F-1: the worktree allow covers the executor home in the git common directory; the home is still denied.
    expect(executorHome).toHaveBeenCalledExactlyOnceWith(slash(wt));
    expect(result.externalDirectoryDenied).toEqual([join(home, "*")]);
    const policy = permissionRules(agents.implementer!.permission as PermissionMap);
    expect(evaluatePermission(policy, "external_directory", join(wt, "src", "x.ts"))).toBe("allow");
    expect(evaluatePermission(policy, "external_directory", join(wt, ".git", "omr-executor", "ledger.json"))).toBe("deny");
    expect(opts.warn).not.toHaveBeenCalled();
  });

  it("QA-62F-1 outside routing.workRoots the executor slots root is not granted, while the home is still denied", async () => {
    const base = temp();
    const outside = temp("omr-roles-wr-elsewhere-");
    const slots = temp("omr-roles-wr-slots-");
    const wt = join(base, "omr-wt");
    mkdirSync(join(wt, ".git"), { recursive: true });
    const home = join(wt, ".git", "omr-executor");
    const cfg = rolesConfig([`${slash(base)}/omr-*`]);
    for (const slotsDir of [slots, null]) {
      cfg.routing = { ...cfg.routing, leases: { mode: "enforce" }, executor: { slotsDir } };
      cfg.enforcement = { ...cfg.enforcement, verify: { require: "always" } };
      const opts = { ...options(outside, vi.fn(async () => [slash(wt)])), executorHome: vi.fn(async () => home) };
      const agents: Record<string, Record<string, unknown>> = {};
      const result = await registerRoleAgents(agents, cfg, opts);
      expect(result.failed).toBe(false);
      expect(result.externalDirectory).toEqual([join(wt, "*"), `${base}${sep}omr-*`]);
      expect(result.externalDirectory).not.toContain(join(slots, "*"));
      expect(result.externalDirectory.some((pattern) => pattern.toLowerCase().includes(".omr-slots"))).toBe(false);
      expect(result.externalDirectoryDenied).toEqual([join(home, "*")]);
      expect(evaluatePermission(permissionRules(agents.implementer!.permission as PermissionMap), "external_directory", join(slots, "plan", "slot-1", "x")))
        .toBe("deny");
      expect(opts.warn).not.toHaveBeenCalled();
    }
  });

  it("QA-62F-1 outside routing.workRoots with no listed worktree runs no executor-home lookup", async () => {
    const base = temp();
    const outside = temp("omr-roles-wr-elsewhere-");
    const cfg = rolesConfig([`${slash(base)}/omr-*`]);
    cfg.routing = { ...cfg.routing, leases: { mode: "enforce" } };
    cfg.enforcement = { ...cfg.enforcement, verify: { require: "always" } };
    const executorHome = vi.fn(async () => join(base, ".git", "omr-executor"));
    const opts = { ...options(outside, vi.fn(async () => [])), executorHome };
    const result = await registerRoleAgents({}, cfg, opts);
    expect(result.failed).toBe(false);
    expect(executorHome).not.toHaveBeenCalled();
    expect(result.externalDirectory).toEqual([`${base}${sep}omr-*`]);
    expect(result.externalDirectoryDenied).toEqual([]);
    expect(opts.warn).not.toHaveBeenCalled();
  });

  it("QA-62F-1 outside routing.workRoots an unresolved executor home fails closed like inside: one warning, no slots allow", async () => {
    const base = temp();
    const outside = temp("omr-roles-wr-elsewhere-");
    const slots = temp("omr-roles-wr-slots-");
    const wt = join(base, "omr-wt");
    mkdirSync(wt);
    const cfg = rolesConfig([`${slash(base)}/omr-*`]);
    cfg.routing = { ...cfg.routing, leases: { mode: "enforce" }, executor: { slotsDir: slots } };
    cfg.enforcement = { ...cfg.enforcement, verify: { require: "always" } };
    const executorHome = vi.fn(async (): Promise<string> => { throw new Error("common directory unavailable"); });
    const opts = { ...options(outside, vi.fn(async () => [slash(wt)])), executorHome };
    const result = await registerRoleAgents({}, cfg, opts);
    expect(result.failed).toBe(false);
    expect(result.externalDirectory).toEqual([join(wt, "*"), `${base}${sep}omr-*`]);
    expect(result.externalDirectoryDenied).toEqual([]);
    expect(opts.warn).toHaveBeenCalledTimes(1);
    expect(opts.warn).toHaveBeenCalledWith("roles:executor-home", expect.stringContaining("common directory unavailable"));
  });

  it("G-12 a workRoots glob for later-created worktrees does not drop the project's existing worktrees", async () => {
    const base = temp();
    const project = join(base, "project");
    const wt1 = join(base, "wt-1");
    mkdirSync(join(project, ".git"), { recursive: true });
    mkdirSync(wt1);
    const home = join(project, ".git", "omr-executor");
    const list = vi.fn(async () => [slash(project), slash(wt1)]);
    const executorHome = vi.fn(async () => home);
    const agents: Record<string, Record<string, unknown>> = {};
    const cfg = rolesConfig([`${slash(base)}/wt-late-*`]);
    cfg.routing = { ...cfg.routing, leases: { mode: "enforce" } };
    cfg.enforcement = { ...cfg.enforcement, verify: { require: "always" } };
    const opts = { ...options(project, list), executorHome };
    const result = await registerRoleAgents(agents, cfg, opts);
    expect(result.failed).toBe(false);
    expect(list).toHaveBeenCalledWith(project);
    const late = `${base}${sep}wt-late-*`;
    // No executor slots-root allowance outside every work root (QA-62F-1), only the worktrees and the glob.
    expect(result.externalDirectory).toEqual([join(project, "*"), join(wt1, "*"), late]);
    const implementer = permissionRules(agents.implementer!.permission as PermissionMap)
      .filter((rule) => rule.action === "external_directory" && rule.effect === "allow")
      .map((rule) => rule.resource);
    expect(implementer).toEqual(expect.arrayContaining([join(wt1, "*"), late]));
    const policy = permissionRules(agents.implementer!.permission as PermissionMap);
    expect(evaluatePermission(policy, "external_directory", join(wt1, "src", "x.ts"))).toBe("allow");
    // QA-62F-1: the main worktree's allow covers <git common dir>\omr-executor; the home deny still wins.
    expect(executorHome).toHaveBeenCalledExactlyOnceWith(slash(project));
    expect(result.externalDirectoryDenied).toEqual([join(home, "*")]);
    expect(evaluatePermission(policy, "external_directory", join(project, ".git", "omr-executor", "ledger.json"))).toBe("deny");
    expect(opts.warn).not.toHaveBeenCalled();
  });

  it("QA-DF1-19 a location inside routing.workRoots (or below an entry) still lists the worktrees", async () => {
    const base = temp();
    const main = join(base, "omr-main");
    const wt = join(base, "omr-wt");
    mkdirSync(main);
    mkdirSync(wt);
    for (const directory of [main, join(main, "src")]) {
      const list = vi.fn(async () => [slash(wt)]);
      const result = await registerRoleAgents({}, rolesConfig([`${slash(base)}/omr-*`]), options(directory, list));
      expect(list).toHaveBeenCalledWith(directory);
      expect(result.externalDirectory).toEqual([join(wt, "*"), `${base}${sep}omr-*`]);
    }
    const plain = vi.fn(async () => [slash(wt)]);
    await registerRoleAgents({}, rolesConfig([slash(main)]), options(main, plain));
    expect(plain).toHaveBeenCalledWith(main);
  });

  it("QA-DF1-19 without routing.workRoots the worktrees are listed wherever the location is", async () => {
    const base = temp();
    const wt = join(base, "wt-1");
    mkdirSync(wt);
    for (const workRoots of [undefined, []]) {
      const list = vi.fn(async () => [slash(wt)]);
      const result = await registerRoleAgents({}, rolesConfig(workRoots), options("/nowhere", list));
      expect(list).toHaveBeenCalledWith("/nowhere");
      expect(result.externalDirectory).toEqual([join(wt, "*")]);
    }
  });

  it("QA-DF1-19 the location is compared in its canonical form (a link into a work root is inside)", async () => {
    const base = temp();
    const wt = join(base, "omr-wt");
    mkdirSync(wt);
    const link = join(temp("omr-roles-wr-link-"), "to-wt");
    const realpath = (path: string): string => (path === link ? wt : realpathSync.native(path));
    const list = vi.fn(async () => [slash(wt)]);
    const opts: RoleRegistrationOptions = { ...options(link, list), realpath };
    const result = await registerRoleAgents({}, rolesConfig([`${slash(base)}/omr-*`]), opts);
    expect(list).toHaveBeenCalledWith(link);
    expect(result.externalDirectory).toEqual([join(wt, "*"), `${base}${sep}omr-*`]);
  });

  it("QA-62F-4 the start-up git worktree list picks its git executable with the listed directory's work-root guards", async () => {
    const directory = temp("omr-roles-wr-list-");
    const wt = join(directory, "wt-1");
    // Seams: the git-tools module exports the executable choice, the safe.directory lookup and the bounded spawn.
    const executable = vi.spyOn(gitTools, "gitExecutable").mockReturnValue("guarded-git");
    const trusted = vi.spyOn(gitTools, "inheritedSafeDirectoryArgs").mockResolvedValue([]);
    const spawn = vi.spyOn(gitTools, "spawnBounded").mockResolvedValue({
      code: 0, output: Buffer.from(`worktree ${wt}\nHEAD 0000000000000000000000000000000000000000\n\n`), stderr: Buffer.alloc(0), truncated: false,
    });
    expect(await listWorktrees(directory)).toEqual([wt]);
    const guards = gitTools.workRootGuards(directory);
    expect(guards[0]).toBe(directory);
    expect(executable).toHaveBeenCalledExactlyOnceWith(guards);
    expect(trusted).toHaveBeenCalledWith("guarded-git", expect.any(Number));
    expect(spawn).toHaveBeenCalledWith("guarded-git", expect.arrayContaining(["worktree", "list", "--porcelain"]), directory, expect.any(Object));
  });
});

describe.skipIf(process.platform !== "win32")("Phase 5.1.3 D6 executor external_directory permissions", () => {
  function fixture() {
    const base = temp("omr-roles-executor-");
    const main = join(base, "main");
    const slots = join(base, "slots");
    const home = join(main, ".git", "omr-executor");
    const baseConfig = rolesConfig(undefined);
    const cfg: RouterConfig = {
      ...baseConfig,
      routing: { ...baseConfig.routing, leases: { mode: "enforce" }, executor: { slotsDir: slots } },
      enforcement: { ...baseConfig.enforcement, verify: { require: "always" } },
    };
    const executorHome = vi.fn(async () => home);
    const opts = {
      ...options(main, vi.fn(async () => [main])),
      executorHome,
      realpath: (path: string) => win32.normalize(path),
    };
    const agents: Record<string, Record<string, unknown>> = {};
    return { base, main, slots, home, cfg, opts, agents };
  }

  const rules = (agent: Record<string, unknown>) => permissionRules(agent.permission as PermissionMap);

  it("R1 grants the canonical slots root only to local-action roles, then denies the executor home after every allow", async () => {
    const f = fixture();
    f.opts.directory = join(f.base, "linked");
    const result = await registerRoleAgents(f.agents, f.cfg, f.opts);
    expect(result.failed).toBe(false);
    expect(f.opts.executorHome).toHaveBeenCalledExactlyOnceWith(f.main);
    expect(result.externalDirectory).toEqual([join(f.main, "*"), join(f.slots, "*")]);
    expect(result.externalDirectoryDenied).toEqual([join(f.home, "*")]);
    expect(f.opts.warn).not.toHaveBeenCalled();
    for (const spec of SHIPPED_ROLE_SPECS) {
      const policy = rules(f.agents[spec.agent]!);
      const external = policy.filter((rule) => rule.action === "external_directory");
      const allows = roleHasLocalActions(spec) ? result.externalDirectory : [];
      expect(external).toEqual([
        ...allows.map((resource) => ({ action: "external_directory", resource, effect: "allow" })),
        { action: "external_directory", resource: join(f.home, "*"), effect: "deny" },
      ]);
      expect(evaluatePermission(policy, "external_directory", join(f.slots, "slot-1", "src", "x.ts")))
        .toBe(roleHasLocalActions(spec) ? "allow" : "deny");
      // The worktree allow also matches this home; the later deny must win.
      expect(evaluatePermission(policy, "external_directory", join(f.home, "ledger.json"))).toBe("deny");
    }
  });

  it("R2 the host matcher refuses a sibling <root>-evil, without refusing a child of the slots root", async () => {
    const f = fixture();
    await registerRoleAgents(f.agents, f.cfg, f.opts);
    const policy = rules(f.agents.implementer!);
    const child = join(f.slots, "slot-1", "x");
    const sibling = join(`${f.slots}-evil`, "x");
    expect(permissionMatches(child, join(f.slots, "*"))).toBe(true);
    expect(permissionMatches(sibling, join(f.slots, "*"))).toBe(false);
    expect(evaluatePermission(policy, "external_directory", child)).toBe("allow");
    expect(evaluatePermission(policy, "external_directory", sibling)).toBe("deny");
  });

  it("R1 a table with only a non-local role gets the home deny but no slots allow or worktree listing", async () => {
    const f = fixture();
    f.cfg.roleAgents = Object.fromEntries(SHIPPED_ROLE_SPECS.filter(roleHasLocalActions)
      .map((spec) => [spec.agent, { enabled: false }]));
    const result = await registerRoleAgents(f.agents, f.cfg, f.opts);
    expect(result.registered).toEqual(["researcher"]);
    expect(result.externalDirectory).toEqual([]);
    expect(result.externalDirectoryDenied).toEqual([join(f.home, "*")]);
    expect(f.opts.listWorktrees).not.toHaveBeenCalled();
    expect(rules(f.agents.researcher!).filter((rule) => rule.action === "external_directory")).toEqual([
      { action: "external_directory", resource: join(f.home, "*"), effect: "deny" },
    ]);
    expect(f.opts.warn).not.toHaveBeenCalled();
  });

  it("R3 ignores a project-local slotsDir before registration and grants the drive's default root without a planId", async () => {
    const f = fixture();
    const untrusted = join(f.main, "project-slots");
    const override = localOverridePath(f.main);
    mkdirSync(dirname(override), { recursive: true });
    writeFileSync(override, JSON.stringify({ routing: { delegation: "roles", executor: { slotsDir: untrusted } } }));
    invalidateConfigCache();
    const merged = loadConfig(f.main);
    expect(resolveRouting(merged, "v2").executor.slotsDir).toBeNull();
    const result = await registerRoleAgents(f.agents, merged, f.opts);
    const defaultRoot = win32.join(win32.parse(f.main).root, ".omr-slots");
    expect(result.externalDirectory).toEqual([join(f.main, "*"), join(defaultRoot, "*")]);
    expect(result.externalDirectory).not.toContain(join(untrusted, "*"));
    expect(result.externalDirectoryDenied).toEqual([join(f.home, "*")]);
    expect(f.opts.warn).not.toHaveBeenCalled();
  });

  it("QA-5.1-24 takes the default slots drive from the worktree containing the canonical location", async () => {
    const f = fixture();
    const otherDrive = win32.parse(f.main).root[0]!.toUpperCase() === "E" ? "F" : "E";
    const current = `${otherDrive}:\\current-worktree`;
    f.opts.directory = join(f.base, "linked-repository");
    f.opts.listWorktrees = vi.fn(async () => [f.main, current]);
    f.opts.realpath = (path) => path === f.opts.directory ? join(current, "src") : win32.normalize(path);
    f.cfg.routing = { ...f.cfg.routing, executor: { slotsDir: null } };
    const result = await registerRoleAgents(f.agents, f.cfg, f.opts);
    expect(result.externalDirectory).toEqual([join(f.main, "*"), join(current, "*"), join(`${otherDrive}:\\.omr-slots`, "*")]);
    expect(result.externalDirectory).not.toContain(join(win32.parse(f.main).root, ".omr-slots", "*"));
    expect(f.opts.warn).not.toHaveBeenCalled();
  });

  it("QA-5.1-24 names a failed worktree listing instead of diagnosing the toplevel drive", async () => {
    const f = fixture();
    f.cfg.routing = { ...f.cfg.routing, executor: { slotsDir: null } };
    f.opts.listWorktrees = vi.fn(async () => { throw new Error("git worktree list failed (exit 128): unavailable"); });
    const result = await registerRoleAgents(f.agents, f.cfg, f.opts);
    expect(result.externalDirectory).toEqual([]);
    expect(result.externalDirectoryDenied).toEqual([join(f.home, "*")]);
    expect(f.opts.warn).toHaveBeenCalledWith("roles:executor-slots", expect.stringContaining("worktree listing failed"));
    expect(f.opts.warn).not.toHaveBeenCalledWith("roles:executor-slots", expect.stringContaining("not on a drive-letter path"));
  });

  it.each([
    ["leases off", "off", "always"],
    ["verification never", "enforce", "never"],
  ] as const)("does not grant a configured slots root without D7: %s", async (_label, mode, require) => {
    const f = fixture();
    f.cfg.routing = { ...f.cfg.routing, leases: { mode } };
    f.cfg.enforcement = { ...f.cfg.enforcement, verify: { require } };
    const result = await registerRoleAgents(f.agents, f.cfg, f.opts);
    expect(result.externalDirectory).toEqual([join(f.main, "*")]);
    expect(f.opts.executorHome).not.toHaveBeenCalled();
    expect(result.externalDirectoryDenied).toEqual([]);
    expect(f.opts.warn).not.toHaveBeenCalled();
  });

  it("R4 an unresolved executor home gives no slots allow and exactly one warning", async () => {
    const f = fixture();
    f.opts.executorHome.mockRejectedValue(new Error("common directory unavailable"));
    const result = await registerRoleAgents(f.agents, f.cfg, f.opts);
    expect(result.failed).toBe(false);
    expect(result.externalDirectory).toEqual([join(f.main, "*")]);
    expect(result.externalDirectoryDenied).toEqual([]);
    expect(evaluatePermission(rules(f.agents.implementer!), "external_directory", join(f.slots, "slot-1", "x"))).toBe("deny");
    expect(f.opts.warn).toHaveBeenCalledTimes(1);
    expect(f.opts.warn).toHaveBeenCalledWith("roles:executor-home", expect.stringContaining("common directory unavailable"));
  });

  it("D7 a non-repository directory gets no executor allow, deny or warning", async () => {
    const f = fixture();
    f.opts.listWorktrees = vi.fn(async () => []);
    f.opts.executorHome.mockRejectedValue(new Error(
      `Cannot resolve the git common directory of ${f.main} (128): fatal: not a git repository (or any of the parent directories): .git`,
    ));
    const result = await registerRoleAgents(f.agents, f.cfg, f.opts);
    expect(result.failed).toBe(false);
    expect(result.externalDirectory).toEqual([]);
    expect(result.externalDirectoryDenied).toEqual([]);
    for (const agent of Object.values(f.agents)) {
      expect(rules(agent).filter((rule) => rule.action === "external_directory")).toEqual([]);
    }
    expect(f.opts.warn).not.toHaveBeenCalled();
  });

  it.each(["existing", "missing"])("D7 a native home lookup for an %s non-repository directory is silent", async (location) => {
    const f = fixture();
    if (location === "existing") mkdirSync(f.main);
    const opts = { ...f.opts, listWorktrees: vi.fn(async () => []), executorHome: undefined };
    const result = await registerRoleAgents(f.agents, f.cfg, opts);
    expect(result.failed).toBe(false);
    expect(result.externalDirectory).toEqual([]);
    expect(result.externalDirectoryDenied).toEqual([]);
    expect(opts.warn).not.toHaveBeenCalled();
  });

  it("R4 an exit-128 failure inside a repository still gives exactly one warning", async () => {
    const f = fixture();
    f.opts.executorHome.mockRejectedValue(new Error(
      `Cannot resolve the git common directory of ${f.main} (128): fatal: detected dubious ownership in repository`,
    ));
    const result = await registerRoleAgents(f.agents, f.cfg, f.opts);
    expect(result.externalDirectory).toEqual([join(f.main, "*")]);
    expect(result.externalDirectoryDenied).toEqual([]);
    expect(f.opts.warn).toHaveBeenCalledTimes(1);
    expect(f.opts.warn).toHaveBeenCalledWith("roles:executor-home", expect.stringContaining("dubious ownership"));
  });

  it("uses the project directory for the executor home when no worktrees were listed", async () => {
    const f = fixture();
    f.opts.listWorktrees = vi.fn(async () => []);
    const result = await registerRoleAgents(f.agents, f.cfg, f.opts);
    expect(f.opts.executorHome).toHaveBeenCalledExactlyOnceWith(f.main);
    expect(result.externalDirectory).toEqual([join(f.slots, "*")]);
    expect(result.externalDirectoryDenied).toEqual([join(f.home, "*")]);
    expect(f.opts.warn).not.toHaveBeenCalled();
  });

  it("denies the resolved canonical home even when the home directory is a junction", async () => {
    const f = fixture();
    const canonicalHome = join(f.base, "executor-state");
    f.opts.realpath = (path) => path === f.home ? canonicalHome : win32.normalize(path);
    const result = await registerRoleAgents(f.agents, f.cfg, f.opts);
    expect(result.externalDirectory).toContain(join(f.slots, "*"));
    expect(result.externalDirectoryDenied).toEqual([join(canonicalHome, "*")]);
    expect(f.opts.warn).not.toHaveBeenCalled();
  });

  it.each(["inside", "above"])("R5 a slots root %s a listed worktree is not granted", async (location) => {
    const f = fixture();
    const root = location === "inside" ? join(f.main, "slots") : f.base;
    f.cfg.routing = { ...f.cfg.routing, executor: { slotsDir: root } };
    const result = await registerRoleAgents(f.agents, f.cfg, f.opts);
    expect(result.externalDirectory).toEqual([join(f.main, "*")]);
    expect(result.externalDirectoryDenied).toEqual([join(f.home, "*")]);
    expect(f.opts.warn).toHaveBeenCalledTimes(1);
    expect(f.opts.warn).toHaveBeenCalledWith("roles:executor-slots", expect.stringContaining("inside or an ancestor"));
  });

  it("R5 a main checkout's canonical root is never exempted as an executor slot", async () => {
    const f = fixture();
    const canonicalMain = join(f.slots, "plan", "slot-1");
    f.opts.realpath = (path) => path === f.main ? canonicalMain : win32.normalize(path);
    const result = await registerRoleAgents(f.agents, f.cfg, f.opts);
    expect(result.externalDirectory).toEqual([join(canonicalMain, "*")]);
    expect(f.opts.warn).toHaveBeenCalledWith("roles:executor-slots", expect.stringContaining("inside or an ancestor"));
  });

  it("canonicalizes a not-yet-created root and home through their existing parents", async () => {
    const f = fixture();
    const parent = f.base.toUpperCase();
    f.opts.realpath = (path) => {
      if (path === f.slots || path === f.home) throw Object.assign(new Error("not created yet"), { code: "ENOENT" });
      return path === f.base ? parent : win32.normalize(path);
    };
    const result = await registerRoleAgents(f.agents, f.cfg, f.opts);
    expect(result.externalDirectory).toEqual([join(f.main, "*"), join(parent, "slots", "*")]);
    expect(result.externalDirectoryDenied).toEqual([join(f.home, "*")]);
    expect(f.opts.warn).not.toHaveBeenCalled();
  });

  it.each(["moved", "access denied", "glob"])("refuses a slots root with %s rather than widening its allow", async (problem) => {
    const f = fixture();
    if (problem === "moved") {
      f.opts.realpath = (path) => path === f.slots ? `${f.slots}-replaced` : win32.normalize(path);
    } else if (problem === "access denied") {
      f.opts.realpath = (path) => {
        if (path === f.slots) throw Object.assign(new Error("access denied"), { code: "EACCES" });
        return win32.normalize(path);
      };
    } else {
      f.cfg.routing = { ...f.cfg.routing, executor: { slotsDir: `${f.slots}?` } };
    }
    const result = await registerRoleAgents(f.agents, f.cfg, f.opts);
    expect(result.externalDirectory).toEqual([join(f.main, "*")]);
    expect(result.externalDirectoryDenied).toEqual([join(f.home, "*")]);
    expect(f.opts.warn).toHaveBeenCalledTimes(1);
    expect(f.opts.warn).toHaveBeenCalledWith("roles:executor-slots", expect.any(String));
  });

  it("an invalid dot-segment slotsDir is sanitized to the trusted default root before registration", async () => {
    const f = fixture();
    f.cfg.routing = { ...f.cfg.routing, executor: { slotsDir: `${f.slots}\\..\\other` } };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(resolveRouting(f.cfg, "v2").executor.slotsDir).toBeNull();
      const result = await registerRoleAgents(f.agents, f.cfg, f.opts);
      const defaultRoot = win32.join(win32.parse(f.main).root, ".omr-slots");
      expect(result.externalDirectory).toEqual([join(f.main, "*"), join(defaultRoot, "*")]);
      expect(result.externalDirectoryDenied).toEqual([join(f.home, "*")]);
      expect(f.opts.warn).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("routing.executor.slotsDir"));
    } finally {
      warn.mockRestore();
    }
  });

  it("R5 existing slot and integration worktrees do not prevent granting future slots after a reload", async () => {
    const f = fixture();
    const alias = join(f.base, "linked");
    const canonical = join(f.slots, "plan", "slot-1");
    const integration = join(f.slots, "plan", "integration");
    const ci = join(f.slots, "plan", "ci");
    f.opts.listWorktrees = vi.fn(async () => [f.main, canonical, integration, ci, alias]);
    f.opts.realpath = (path) => path === alias ? canonical : win32.normalize(path);
    const result = await registerRoleAgents(f.agents, f.cfg, f.opts);
    expect(result.externalDirectory).toEqual([join(f.main, "*"), join(canonical, "*"), join(integration, "*"), join(ci, "*"), join(f.slots, "*")]);
    expect(result.externalDirectoryDenied).toEqual([join(f.home, "*")]);
    expect(evaluatePermission(rules(f.agents.implementer!), "external_directory", join(f.slots, "plan", "slot-2", "x"))).toBe("allow");
    expect(f.opts.warn).not.toHaveBeenCalled();
  });

  it("QA-5.1-27 a missing linked worktree outside the slots root does not block its allow", async () => {
    const f = fixture();
    const missing = join(f.base, "deleted-linked");
    f.opts.listWorktrees = vi.fn(async () => [f.main, missing]);
    f.opts.realpath = (path) => {
      if (path === missing) throw Object.assign(new Error("deleted worktree"), { code: "ENOENT" });
      return win32.normalize(path);
    };
    const result = await registerRoleAgents(f.agents, f.cfg, f.opts);
    expect(result.externalDirectory).toEqual([join(f.main, "*"), join(f.slots, "*")]);
    expect(result.externalDirectoryDenied).toEqual([join(f.home, "*")]);
    expect(evaluatePermission(rules(f.agents.implementer!), "external_directory", join(f.slots, "plan", "slot-2", "x"))).toBe("allow");
    expect(f.opts.warn).not.toHaveBeenCalledWith("roles:executor-slots", expect.any(String));
  });

  it("QA-5.1-27 a missing registered slot-3 does not block future slots", async () => {
    const f = fixture();
    const missing = join(f.slots, "plan", "slot-3");
    f.opts.listWorktrees = vi.fn(async () => [f.main, missing]);
    f.opts.realpath = (path) => {
      if (path === missing) throw Object.assign(new Error("retired slot"), { code: "ENOENT" });
      return win32.normalize(path);
    };
    const result = await registerRoleAgents(f.agents, f.cfg, f.opts);
    expect(result.externalDirectory).toEqual([join(f.main, "*"), join(f.slots, "*")]);
    expect(result.externalDirectoryDenied).toEqual([join(f.home, "*")]);
    expect(evaluatePermission(rules(f.agents.implementer!), "external_directory", join(f.slots, "plan", "slot-4", "x"))).toBe("allow");
    expect(f.opts.warn).not.toHaveBeenCalledWith("roles:executor-slots", expect.any(String));
  });

  it("QA-5.1-27 a missing registration does not hide an existing worktree's EACCES refusal", async () => {
    const f = fixture();
    const missing = join(f.base, "deleted-linked");
    const denied = join(f.base, "inaccessible-linked");
    mkdirSync(denied);
    f.opts.listWorktrees = vi.fn(async () => [f.main, missing, denied]);
    f.opts.realpath = (path) => {
      if (path === missing) throw Object.assign(new Error("deleted worktree"), { code: "ENOENT" });
      if (path === denied) throw Object.assign(new Error("access denied"), { code: "EACCES" });
      return win32.normalize(path);
    };
    const result = await registerRoleAgents(f.agents, f.cfg, f.opts);
    expect(result.externalDirectory).toEqual([join(f.main, "*")]);
    expect(result.externalDirectoryDenied).toEqual([join(f.home, "*")]);
    expect(evaluatePermission(rules(f.agents.implementer!), "external_directory", join(f.slots, "plan", "slot-2", "x"))).toBe("deny");
    // The old code refuses the missing registration first, never checking the existing worktree.
    expect(f.opts.warn).toHaveBeenCalledWith("roles:executor-slots", expect.stringContaining(`worktree ${denied} has no canonical long form`));
  });

  it("QA-5.1-27 a missing unrelated worktree does not lose the canonical location's default drive", async () => {
    const f = fixture();
    const missing = join(f.base, "deleted-linked");
    const otherDrive = win32.parse(f.main).root[0]!.toUpperCase() === "E" ? "F" : "E";
    const current = `${otherDrive}:\\current-worktree`;
    f.opts.directory = join(f.base, "linked-repository");
    f.opts.listWorktrees = vi.fn(async () => [f.main, missing, current]);
    f.opts.realpath = (path) => {
      if (path === missing) throw Object.assign(new Error("deleted worktree"), { code: "ENOENT" });
      return path === f.opts.directory ? join(current, "src") : win32.normalize(path);
    };
    f.cfg.routing = { ...f.cfg.routing, executor: { slotsDir: null } };
    const result = await registerRoleAgents(f.agents, f.cfg, f.opts);
    expect(result.externalDirectory).toEqual([join(f.main, "*"), join(current, "*"), join(`${otherDrive}:\\.omr-slots`, "*")]);
    expect(result.externalDirectoryDenied).toEqual([join(f.home, "*")]);
    expect(f.opts.warn).not.toHaveBeenCalledWith("roles:executor-slots", expect.any(String));
  });

  it("keeps the home deny last even when its exact key was also supplied as an allow", () => {
    const f = fixture();
    const spec = SHIPPED_ROLE_SPECS.find((role) => role.agent === "implementer")!;
    const policy = permissionRules(roleMaxPermission(spec, {
      context7: false,
      externalDirectory: [join(f.home, "*"), join(f.main, "*")],
      externalDirectoryDeny: [join(f.home, "*")],
    }));
    expect(policy.filter((rule) => rule.action === "external_directory")).toEqual([
      { action: "external_directory", resource: join(f.main, "*"), effect: "allow" },
      { action: "external_directory", resource: join(f.home, "*"), effect: "deny" },
    ]);
    expect(evaluatePermission(policy, "external_directory", join(f.home, "ledger.json"))).toBe("deny");
  });

  it("R6 the max-policy exports retain the existing no-executor permission shape", () => {
    const patterns = ["D:\\git\\repo\\*", "D:\\git\\omr-rta-*", "*", "**"];
    for (const spec of SHIPPED_ROLE_SPECS) {
      const external = permissionRules(roleMaxPermission(spec, { context7: false, externalDirectory: patterns }))
        .filter((rule) => rule.action === "external_directory");
      expect(external).toEqual(roleHasLocalActions(spec)
        ? patterns.slice(0, 2).map((resource) => ({ action: "external_directory", resource, effect: "allow" }))
        : []);
    }
  });
});
