import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Config } from "@opencode-ai/sdk";
import ModelRouterPlugin from "../../src/index";
import type { RouterPluginInput } from "../../src/compat/child-session";
import { invalidateConfigCache, overridePath, validateConfig } from "../../src/router/config";
import { CONTEXT7_DOC_TOOLS, isReadOnlyTier, legacyReadOnlyTools, mergePermissions, permissionRules, readOnlyPermissions, type PermissionRule } from "../../src/router/read-only";

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); invalidateConfigCache(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
function effect(rules: PermissionRule[], action: string, resource = "*") {
  const matches = (pattern: string, value: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`).test(value);
  return [...rules].reverse().find(rule => matches(rule.action, action) && matches(rule.resource, resource))?.effect;
}

describe("read-only tier policy", () => {
  it("defaults only fast to read-only and supports explicit opt-in and opt-out", () => {
    expect(isReadOnlyTier("fast", {})).toBe(true);
    expect(isReadOnlyTier("fast", { readOnly: false })).toBe(false);
    expect(isReadOnlyTier("medium", {})).toBe(false);
    expect(isReadOnlyTier("custom", { readOnly: true })).toBe(true);
  });
  it("validates the optional boolean on all bundled presets", () => {
    const cfg = JSON.parse(readFileSync(new URL("../../tiers.json", import.meta.url), "utf8"));
    for (const preset of Object.values(validateConfig(cfg).presets)) expect(preset.fast.readOnly).toBe(true);
    cfg.presets.anthropic.fast.readOnly = "false";
    expect(() => validateConfig(cfg)).toThrow("readOnly' must be a boolean");
  });
  it("denies unknown tools, asks for secrets, and admits only explicit lookups", () => {
    const rules = permissionRules(readOnlyPermissions());
    expect(rules[0]).toEqual({ action: "*", resource: "*", effect: "deny" });
    for (const name of ["shell", "bash", "edit", "write", "patch", "execute", "subagent", "task", "webfetch", "websearch", "browser", "future_tool", "context7_query-docs"]) expect(effect(rules, name)).toBe("deny");
    for (const name of ["read", "glob", "grep", "router_git_status", "router_git_diff", "external_directory"]) expect(effect(rules, name)).toBe("allow");
    for (const path of ["a/.env", "a/.env.local", "a/cert.pem", "a/private.key", "id_rsa", "a/id_ed25519", ".npmrc", "a/.npmrc", ".netrc", "a/.netrc", "C:\\repo\\id_rsa", "C:\\repo\\.npmrc", "C:\\repo\\.netrc"]) expect(effect(rules, "read", path), path).toBe("ask");
    expect(effect(rules, "read", "a/.env.example")).toBe("allow");
    const docs = permissionRules(readOnlyPermissions(true));
    for (const name of CONTEXT7_DOC_TOOLS) expect(effect(docs, name)).toBe("allow");
    expect(effect(docs, "context7_future-write")).toBe("deny");
  });
  it("user rules go last, including wildcard and nested resource overrides", () => {
    const policy = mergePermissions(readOnlyPermissions(), { read: { "*.env.example": "deny" }, external_directory: "deny", shell: "allow" });
    const rules = permissionRules(policy);
    expect(effect(rules, "read", ".env.example")).toBe("deny");
    expect(effect(rules, "read", ".env.local")).toBe("ask");
    expect(effect(rules, "external_directory")).toBe("deny");
    expect(effect(rules, "shell")).toBe("allow");
    expect(effect(permissionRules(mergePermissions(policy, { "*": "deny" })), "read")).toBe("deny");
    expect(legacyReadOnlyTools(policy)).toMatchObject({ "*": false, read: true, shell: true, external_directory: false });
  });
  it("v1 registration publishes permissions/tools, merges user rules, and layer-merges opt-out", async () => {
    const home = mkdtempSync(join(tmpdir(), "router-readonly-")); roots.push(home);
    vi.stubEnv("HOME", home); vi.stubEnv("USERPROFILE", home);
    invalidateConfigCache();
    const hooks = await ModelRouterPlugin({ directory: home, worktree: home, client: {} } as unknown as RouterPluginInput);
    const cfg: Config = { agent: { fast: { permission: { external_directory: "deny" } } }, mcp: { context7: { type: "remote", url: "https://example.invalid" } } };
    await hooks.config?.(cfg);
    expect(cfg.agent?.fast?.permission).toMatchObject({ "*": "deny", external_directory: "deny", "context7_query-docs": "allow" });
    expect(cfg.agent?.fast?.tools).toMatchObject({ "*": false, read: true, router_git_status: true });
    expect(cfg.agent?.medium?.permission).toBeUndefined(); expect(cfg.agent?.heavy?.tools).toBeUndefined();
    mkdirSync(dirname(overridePath()), { recursive: true });
    writeFileSync(overridePath(), JSON.stringify({ presets: { anthropic: { fast: { readOnly: false } } } }));
    invalidateConfigCache();
    const opted: Config = {};
    await hooks.config?.(opted);
    expect(opted.agent?.fast?.permission).toBeUndefined(); expect(opted.agent?.fast?.tools).toBeUndefined();
    expect(opted.agent?.medium).toEqual(cfg.agent?.medium); expect(opted.agent?.heavy).toEqual(cfg.agent?.heavy);
    const userOpted: Config = { agent: { fast: { permission: { bash: "deny" }, tools: { bash: false } } } };
    await hooks.config?.(userOpted);
    expect(userOpted.agent?.fast?.permission).toEqual({ bash: "deny" });
    expect(userOpted.agent?.fast?.tools).toEqual({ bash: false });
    await hooks.dispose?.();
  });
});
