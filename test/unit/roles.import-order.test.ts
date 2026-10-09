// QA-P11-2-4: this import must stay FIRST. config.ts and roles.ts import each other at run time;
// every other test file reaches roles.ts through config.ts, so this one loads roles.ts first and
// proves the cycle also resolves in that order (each side uses the other only inside functions).
import { SHIPPED_ROLE_SPECS, resolveRoles } from "../../src/router/roles";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { getConfigNotices, invalidateConfigCache, loadConfig, overridePath } from "../../src/router/config";

describe("roles.ts loaded before config.ts", () => {
  const roots: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    invalidateConfigCache();
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("loads a roles-mode config and resolves the seven shipped roles", () => {
    const root = mkdtempSync(join(tmpdir(), "roles-order-"));
    roots.push(root);
    const home = join(root, "home");
    const project = join(root, "project");
    mkdirSync(home, { recursive: true });
    mkdirSync(join(project, ".git"), { recursive: true });
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    invalidateConfigCache();
    mkdirSync(dirname(overridePath()), { recursive: true });
    writeFileSync(overridePath(), JSON.stringify({ routing: { delegation: "roles" } }));

    const cfg = loadConfig(project);
    expect(cfg.routing?.delegation).toBe("roles");
    const roles = resolveRoles(cfg, "v2");
    expect(roles.size).toBe(7);
    expect([...roles.keys()]).toEqual(SHIPPED_ROLE_SPECS.map((s) => s.agent));
    expect(getConfigNotices(project).map((n) => n.message).filter((m) => m.includes("role table could not be resolved"))).toEqual([]);
  });
});
