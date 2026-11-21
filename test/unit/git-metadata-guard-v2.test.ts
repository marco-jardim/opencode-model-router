/**
 * The delegated-agent git metadata guard (src/router/git-metadata-guard.ts) on OpenCode v2: the adapter's `execute.before` runs the
 * shared legacy hook after its role checks, so tier agents (tiers mode) and plugin agents (#81) are refused git metadata writes in
 * the v2 argument shape (`path`, `apply_patch` `patchText`); the orchestrator is unaffected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { Hooks } from "@opencode-ai/plugin";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { registerV2Hooks } from "../../src/compat/v2-hooks";
import ModelRouterPlugin from "../../src/index";
import { invalidateConfigCache, overridePath } from "../../src/router/config";
import { resetAgentOptionsEffortWarnings } from "../../src/router/agent-options";
import type { RouterPluginInput } from "../../src/compat/child-session";
import { GIT_METADATA_PATHS, ORDINARY_PATHS, gitMetadataFixture, type GitMetadataFixture } from "../helpers/git-metadata-fixture";

const REFUSED = /^\[router\] Refused: writing git metadata \(.+\) is not allowed for delegated agents\.$/;

let fx: GitMetadataFixture;
let home: string;
let id = 0;
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  fx = gitMetadataFixture();
  home = mkdtempSync(join(tmpdir(), "omr-gitmeta-v2-home-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("MODEL_ROUTER_ENFORCE", "");
  resetAgentOptionsEffortWarnings();
  invalidateConfigCache();
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  invalidateConfigCache();
  fx.cleanup();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** A v2 host: `root` is the orchestrator session, every other session a child of it. */
async function host(directory: string, override: unknown = {}) {
  mkdirSync(dirname(overridePath()), { recursive: true });
  writeFileSync(overridePath(), JSON.stringify(override));
  invalidateConfigCache();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const info = (sessionID: string) => (sessionID === "root"
    ? { id: sessionID, agent: "build", location: { directory } }
    : { id: sessionID, parentID: "root", agent: "medium", location: { directory } });
  const toolHooks: Record<string, (event: any) => Promise<void>> = {};
  const none = () => ({ dispose: vi.fn(async () => {}) });
  const agents: Record<string, any> = { build: { id: "build", mode: "primary", permissions: [], request: { settings: {}, headers: {}, body: {} } } };
  const ctx = {
    location: { directory, project: { directory } },
    agent: {
      reload: vi.fn(async () => {}),
      list: vi.fn(async () => ({ data: Object.values(agents) })),
      transform: vi.fn(async (cb: any) => {
        cb({ update: (name: string, apply: (agent: any) => void) => { agents[name] ??= { id: name, mode: "primary", permissions: [], request: {} }; apply(agents[name]); } });
        return none();
      }),
    },
    command: { reload: vi.fn(async () => {}), transform: vi.fn(async () => none()) },
    tool: { transform: vi.fn(async () => none()), hook: vi.fn(async (name: string, cb: any) => { toolHooks[name] = cb; return none(); }) },
    session: {
      get: vi.fn(async ({ sessionID }: { sessionID: string }) => info(sessionID)),
      update: vi.fn(async () => {}),
      context: vi.fn(async () => [] as unknown[]),
      prompt: vi.fn(async () => {}), synthetic: vi.fn(async () => {}),
      hook: vi.fn(async () => none()),
    },
    permission: { hook: vi.fn(async () => none()) },
    event: { subscribe: async function* ({ signal }: { signal: AbortSignal }) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      yield* [] as never[];
    } },
  };
  // The legacy plugin's session lookup, as the v2 runtime client answers it (src/compat/v2-client.ts).
  const client = { session: { get: async ({ path }: { path: { id: string } }) => ({ data: info(path.id) }) } };
  const hooks = await ModelRouterPlugin({ directory, worktree: directory, client, routerHost: "v2" } as unknown as RouterPluginInput);
  cleanups.push(await registerV2Hooks(ctx as unknown as Context, hooks as Hooks));
  return (sessionID: string, agent: string, tool: string, input: Record<string, unknown>) =>
    toolHooks["execute.before"]({ sessionID, agent, messageID: "m", id: `t${++id}`, tool, input });
}

/** The v2 argument shape of a write-class call that writes `path`. */
function v2Call(tool: string, path: string): Record<string, unknown> {
  if (tool === "apply_patch" || tool === "patch") return { patchText: `*** Begin Patch\n*** Add File: ${path}\n+x\n*** End Patch` };
  return tool === "write" ? { path, content: "x" } : { path, oldString: "a", newString: "b" };
}

const V2_WRITE_TOOLS = ["edit", "write", "apply_patch", "patch"] as const;

describe("v2: delegated agents never write git metadata", () => {
  it("tiers mode: a tier agent's write of every .git spelling is refused, its ordinary edits pass", async () => {
    const call = await host(fx.repo);
    for (const tool of V2_WRITE_TOOLS) {
      for (const path of GIT_METADATA_PATHS) {
        await expect(call("child", "medium", tool, v2Call(tool, join(fx.repo, path))), `${tool} ${path}`).rejects.toThrow(REFUSED);
      }
      // Relative patch headers resolve against the location's directory.
      if (tool === "apply_patch" || tool === "patch") {
        await expect(call("child", "heavy", tool, v2Call(tool, ".GIT./config")), tool).rejects.toThrow(REFUSED);
      }
      for (const path of ORDINARY_PATHS) {
        await expect(call("child", "medium", tool, v2Call(tool, join(fx.repo, path))), `${tool} ${path}`).resolves.toBeUndefined();
      }
    }
  });

  it("a linked worktree's common directory is refused", async () => {
    const call = await host(fx.wt);
    for (const path of [join(fx.wt, ".git"), join(fx.admin, "HEAD"), join(fx.repo, ".git", "config")]) {
      await expect(call("child", "heavy", "write", v2Call("write", path)), path).rejects.toThrow(REFUSED);
    }
    await expect(call("child", "heavy", "write", v2Call("write", join(fx.wt, "a.ts")))).resolves.toBeUndefined();
  });

  it("a plugin agent with edit granted (#81) is refused git metadata and keeps its ordinary edits", async () => {
    const editor = { tier: "fast", description: "Editor", permission: { read: "allow", edit: "allow" } };
    const call = await host(fx.repo, { agents: { editor } });
    for (const tool of V2_WRITE_TOOLS) {
      await expect(call("child", "editor", tool, v2Call(tool, join(fx.repo, ".git", "hooks", "pre-commit"))), tool).rejects.toThrow(REFUSED);
      await expect(call("child", "editor", tool, v2Call(tool, join(fx.repo, "sub", ".git", "config"))), tool).rejects.toThrow(REFUSED);
      await expect(call("child", "editor", tool, v2Call(tool, join(fx.repo, ".gitattributes"))), tool).resolves.toBeUndefined();
    }
  });

  it("the orchestrator is unaffected", async () => {
    const call = await host(fx.repo);
    for (const tool of V2_WRITE_TOOLS) {
      await expect(call("root", "build", tool, v2Call(tool, join(fx.repo, ".git", "config"))), tool).resolves.toBeUndefined();
    }
  });
});
