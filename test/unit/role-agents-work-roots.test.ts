/**
 * QA-DF1-19: in roles mode a location outside a configured `routing.workRoots` runs no start-up git: the role agent
 * registration skips the worktree listing (`git worktree list --porcelain`) and keeps only the `workRoots` patterns as
 * `external_directory` rules. Without `routing.workRoots` the worktrees are listed wherever the location is (unchanged).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { invalidateConfigCache, loadConfig, overridePath, type RouterConfig } from "../../src/router/config";
import { registerRoleAgents, type RoleRegistrationOptions } from "../../src/router/role-agents";

const temps: string[] = [];
afterEach(() => {
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

describe("QA-DF1-19 role agent registration outside routing.workRoots", () => {
  it("QA-DF1-19 a location outside routing.workRoots lists no worktrees and keeps only the workRoots patterns", async () => {
    const base = temp();
    const outside = temp("omr-roles-wr-elsewhere-");
    const wt = join(base, "omr-wt");
    mkdirSync(wt);
    const list = vi.fn(async () => [slash(wt)]);
    const opts = options(outside, list);
    const result = await registerRoleAgents({}, rolesConfig([`${slash(base)}/omr-*`]), opts);
    expect(result.failed).toBe(false);
    expect(list).not.toHaveBeenCalled();
    expect(result.externalDirectory).toEqual([`${base}${sep}omr-*`]);
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
});
