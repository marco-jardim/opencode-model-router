/**
 * The delegated-agent git metadata guard (src/router/git-metadata-guard.ts) in the shared `tool.execute.before` of the legacy
 * (OpenCode v1) plugin surface: tier agents, plugin agents (#81), unknown sessions refused; the orchestrator unaffected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ModelRouterPlugin from "../../src/index";
import { invalidateConfigCache, overridePath } from "../../src/router/config";
import { SESSION_DIRECTORY, type RouterPluginInput } from "../../src/compat/child-session";
import { GIT_METADATA_DIRECTORY_UNKNOWN } from "../../src/router/git-metadata-guard";
import {
  GIT_METADATA_PATHS, ORDINARY_PATHS, WRITE_TOOLS, gitMetadataFixture, writeCall, type GitMetadataFixture,
} from "../helpers/git-metadata-fixture";

const REFUSED = /^\[router\] Refused: writing git metadata \(.+\) is not allowed for delegated agents\.$/;

type Hooks = Record<string, (input: unknown, output: unknown) => Promise<void>>;

let fx: GitMetadataFixture;
let home: string;
let call = 0;
const lookups: string[] = [];

/** The host's session lookup: ORCH is the root, LOST cannot be looked up, every other session is a child of ORCH. */
const client = {
  session: {
    get: async ({ path }: { path: { id: string } }) => {
      lookups.push(path.id);
      if (path.id === "LOST") throw new Error("backend unavailable");
      return { data: path.id === "ORCH" ? { id: path.id } : { id: path.id, parentID: "ORCH" } };
    },
  },
};

beforeEach(() => {
  fx = gitMetadataFixture();
  home = mkdtempSync(join(tmpdir(), "omr-gitmeta-home-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("MODEL_ROUTER_ENFORCE", "");
  lookups.length = 0;
  invalidateConfigCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  invalidateConfigCache();
  fx.cleanup();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function plugin(directory: string, override?: unknown): Promise<Hooks> {
  if (override !== undefined) {
    mkdirSync(dirname(overridePath()), { recursive: true });
    writeFileSync(overridePath(), JSON.stringify(override));
    invalidateConfigCache();
  }
  return await ModelRouterPlugin({ directory, worktree: directory, client } as unknown as RouterPluginInput) as unknown as Hooks;
}

const before = (hooks: Hooks, sessionID: string, tool: string, args: Record<string, unknown>): Promise<void> =>
  hooks["tool.execute.before"]({ sessionID, tool, callID: `c-${++call}` }, { args });

/** A v1 child session of `agent`, named by `chat.message` (v1 tool hooks carry no agent). */
async function child(hooks: Hooks, sessionID: string, agent: string): Promise<void> {
  await hooks["chat.message"]({ sessionID, agent }, { parts: [] });
}

describe("v1 legacy hooks: delegated agents never write git metadata", () => {
  it.each(["medium", "heavy"])("a %s tier agent: edit/write/patch/multiedit of every .git spelling is refused", async (tier) => {
    const hooks = await plugin(fx.repo);
    await child(hooks, "SUB", tier);
    for (const tool of WRITE_TOOLS) {
      for (const path of GIT_METADATA_PATHS) {
        await expect(before(hooks, "SUB", tool, writeCall(tool, path, join(fx.repo, "src", "a.ts"))), `${tool} ${path}`).rejects.toThrow(REFUSED);
        await expect(before(hooks, "SUB", tool, writeCall(tool, join(fx.repo, path), join(fx.repo, "src", "a.ts"))), `${tool} abs ${path}`).rejects.toThrow(REFUSED);
      }
    }
  });

  it("a tier agent's ordinary edits and .gitattributes pass", async () => {
    const hooks = await plugin(fx.repo);
    await child(hooks, "SUB", "medium");
    for (const tool of WRITE_TOOLS) {
      for (const path of ORDINARY_PATHS) {
        await expect(before(hooks, "SUB", tool, writeCall(tool, path, join(fx.repo, "src", "a.ts"))), `${tool} ${path}`).resolves.toBeUndefined();
      }
    }
    await expect(before(hooks, "SUB", "read", { filePath: join(fx.repo, ".git", "config") })).resolves.toBeUndefined();
  });

  it("a linked worktree: its pointer, admin directory and common directory are refused (also a bare repository's)", async () => {
    const hooks = await plugin(fx.wt);
    await child(hooks, "SUB", "heavy");
    for (const path of [".git", join(fx.admin, "HEAD"), join(fx.repo, ".git", "config"), join(fx.repo, ".git", "hooks", "pre-commit")]) {
      await expect(before(hooks, "SUB", "write", { filePath: path, content: "x" }), path).rejects.toThrow(REFUSED);
    }
    await expect(before(hooks, "SUB", "edit", { filePath: "a.ts" })).resolves.toBeUndefined();
    const bare = await plugin(fx.bwt);
    await child(bare, "SUB", "heavy");
    await expect(before(bare, "SUB", "write", { filePath: join(fx.bare, "hooks", "pre-commit"), content: "x" })).rejects.toThrow(REFUSED);
    await expect(before(bare, "SUB", "write", { filePath: join(fx.bwt, "a.ts"), content: "x" })).resolves.toBeUndefined();
  });

  it("a bare repository holding its own worktree: its config and hooks are refused, the checkout's files pass", async () => {
    const hooks = await plugin(fx.projMain);
    await child(hooks, "SUB", "medium");
    for (const path of ["../config", "../hooks/pre-commit", join(fx.projAdmin, "HEAD")]) {
      await expect(before(hooks, "SUB", "write", { filePath: path, content: "x" }), path).rejects.toThrow(REFUSED);
      await expect(before(hooks, "SUB", "patch", writeCall("patch", path, "")), path).rejects.toThrow(REFUSED);
    }
    await expect(before(hooks, "SUB", "edit", { filePath: "a.ts" })).resolves.toBeUndefined();
  });

  it("a plugin agent with edit granted (#81) is refused git metadata and keeps its ordinary edits", async () => {
    const editor = { tier: "fast", description: "Editor", permission: { read: "allow", edit: "allow" } };
    const hooks = await plugin(fx.repo, { agents: { editor } });
    await child(hooks, "PA", "editor");
    for (const tool of ["edit", "write", "patch"]) {
      await expect(before(hooks, "PA", tool, writeCall(tool, ".git/hooks/pre-commit", join(fx.repo, "src", "a.ts"))), tool).rejects.toThrow(REFUSED);
      await expect(before(hooks, "PA", tool, writeCall(tool, "src/a.ts", join(fx.repo, "src", "a.ts"))), tool).resolves.toBeUndefined();
    }
  });

  it("an unpatchable patch is refused (fail closed)", async () => {
    const hooks = await plugin(fx.repo);
    await child(hooks, "SUB", "medium");
    await expect(before(hooks, "SUB", "patch", { patchText: "--- a/x\n+++ b/x\n" })).rejects.toThrow(/could not read which files this patch writes/);
  });

  it("the orchestrator (a proven root session) is unaffected; a session that cannot be proven root is refused", async () => {
    const hooks = await plugin(fx.repo);
    for (const tool of WRITE_TOOLS) {
      await expect(before(hooks, "ORCH", tool, writeCall(tool, ".git/config", join(fx.repo, "src", "a.ts"))), tool).resolves.toBeUndefined();
    }
    // An unregistered child is found by the host lookup; an unresolvable session fails closed.
    await expect(before(hooks, "LATE", "edit", { filePath: ".git/config" })).rejects.toThrow(REFUSED);
    await expect(before(hooks, "LOST", "edit", { filePath: ".git/config" })).rejects.toThrow(REFUSED);
  });

  it("a write that names no git metadata costs no session lookup", async () => {
    const hooks = await plugin(fx.repo);
    await before(hooks, "ORCH", "edit", { filePath: "src/a.ts" });
    await before(hooks, "UNSEEN", "write", { filePath: "src/b.ts", content: "x" });
    expect(lookups).toEqual([]);
  });

  it("#161: a null SESSION_DIRECTORY (the v2 bridge knows no directory) refuses a delegated session's write-class calls, not the root's", async () => {
    const hooks = await plugin(fx.repo);
    await child(hooks, "SUB", "medium");
    const beforeIn = (sessionID: string, tool: string, args: Record<string, unknown>, directory: unknown): Promise<void> =>
      hooks["tool.execute.before"]({ sessionID, tool, callID: `c-${++call}`, [SESSION_DIRECTORY]: directory }, { args });
    const ordinary = join(fx.repo, "src", "a.ts");
    for (const tool of WRITE_TOOLS) {
      await expect(beforeIn("SUB", tool, writeCall(tool, ordinary, ordinary), null), tool).rejects.toThrow(GIT_METADATA_DIRECTORY_UNKNOWN);
      // A path the paths alone refuse keeps the metadata refusal.
      await expect(beforeIn("SUB", tool, writeCall(tool, join(fx.repo, ".git", "config"), ordinary), null), tool).rejects.toThrow(REFUSED);
      // The proven root (the orchestrator) is not refused.
      await expect(beforeIn("ORCH", tool, writeCall(tool, ordinary, ordinary), null), tool).resolves.toBeUndefined();
    }
    // An unresolvable session is no proven root: refused.
    await expect(beforeIn("LOST", "write", { filePath: ordinary, content: "x" }, null)).rejects.toThrow(GIT_METADATA_DIRECTORY_UNKNOWN);
    // A read-class call is not guarded.
    await expect(beforeIn("SUB", "read", { filePath: ordinary }, null)).resolves.toBeUndefined();
    // A directory (as the v2 bridge passes it when known) behaves as before: relative paths resolve against it.
    await expect(beforeIn("SUB", "write", { filePath: "../bare.git/config", content: "x" }, fx.bwt)).rejects.toThrow(REFUSED);
    await expect(beforeIn("SUB", "write", { filePath: "a.ts", content: "x" }, fx.bwt)).resolves.toBeUndefined();
  });

  it("#161: without SESSION_DIRECTORY (OpenCode v1 never sets it) an ordinary write passes and costs no session lookup", async () => {
    const hooks = await plugin(fx.repo);
    await child(hooks, "SUB", "medium");
    for (const tool of WRITE_TOOLS) {
      await expect(before(hooks, "SUB", tool, writeCall(tool, join(fx.repo, "src", "a.ts"), join(fx.repo, "src", "a.ts"))), tool).resolves.toBeUndefined();
    }
    await expect(before(hooks, "UNSEEN", "write", { filePath: join(fx.repo, "src", "b.ts"), content: "x" })).resolves.toBeUndefined();
    expect(lookups).toEqual([]);
  });

  it("stays on with the guard's enforcement off and under /bypass", async () => {
    vi.stubEnv("MODEL_ROUTER_ENFORCE", "0");
    const hooks = await plugin(fx.repo);
    await child(hooks, "SUB", "medium");
    await expect(before(hooks, "SUB", "edit", { filePath: ".git/config" })).rejects.toThrow(REFUSED);
    await hooks["command.execute.before"]({ command: "bypass", arguments: "on", sessionID: "ORCH" }, { parts: [] });
    await expect(before(hooks, "SUB", "edit", { filePath: ".git/config" })).rejects.toThrow(REFUSED);
    await expect(before(hooks, "SUB", "edit", { filePath: "src/a.ts" })).resolves.toBeUndefined();
  });
});
