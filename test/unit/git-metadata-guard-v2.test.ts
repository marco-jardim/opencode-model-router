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
import { GIT_METADATA_DIRECTORY_UNKNOWN } from "../../src/router/git-metadata-guard";

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

/**
 * A v2 host: `root` is the orchestrator session, every other session a child of it, located in `sessions`. `get`, when given,
 * answers the adapter's `ctx.session.get` from the session it would have answered (the legacy client keeps answering).
 */
async function host(
  directory: string, override: unknown = {}, sessions: string = directory,
  get?: (session: Record<string, unknown>) => Promise<unknown>,
) {
  mkdirSync(dirname(overridePath()), { recursive: true });
  writeFileSync(overridePath(), JSON.stringify(override));
  invalidateConfigCache();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const info = (sessionID: string) => (sessionID === "root"
    ? { id: sessionID, agent: "build", location: { directory: sessions } }
    : { id: sessionID, parentID: "root", agent: "medium", location: { directory: sessions } });
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
      get: vi.fn(async ({ sessionID }: { sessionID: string }) => (get === undefined ? info(sessionID) : get(info(sessionID)))),
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

  it("resolves against the session's own location, not the plugin's: relative headers and its repository's git directories", async () => {
    // The plugin's location is `repo`; the child session runs in `bwt`, a linked worktree of the bare `bare.git`.
    const call = await host(fx.repo, {}, fx.bwt);
    for (const tool of V2_WRITE_TOOLS) {
      await expect(call("child", "heavy", tool, v2Call(tool, join(fx.bare, "hooks", "pre-commit"))), tool).rejects.toThrow(REFUSED);
    }
    // `../bare.git/config` from `bwt` (the host's reading) is the common directory; the plugin's `repo` would not protect it.
    await expect(call("child", "heavy", "apply_patch", v2Call("apply_patch", "../bare.git/config"))).rejects.toThrow(REFUSED);
    await expect(call("child", "heavy", "apply_patch", v2Call("apply_patch", "a.ts"))).resolves.toBeUndefined();
  });

  it("the orchestrator is unaffected", async () => {
    const call = await host(fx.repo);
    for (const tool of V2_WRITE_TOOLS) {
      await expect(call("root", "build", tool, v2Call(tool, join(fx.repo, ".git", "config"))), tool).resolves.toBeUndefined();
    }
  });
});

describe("v2: the guard's session directory lookup (#161)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Fake timers only (the hook's file I/O runs on the real event loop between the steps). */
  const fakeTimers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  /**
   * Advances fake time in 100 ms steps until `pending` settles, then awaits it; fails at once when it has not settled within
   * `limit` fake milliseconds instead of waiting for the test timeout.
   */
  const settles = async (pending: Promise<unknown>, limit = 60_000): Promise<void> => {
    let done = false;
    const settled = pending.finally(() => { done = true; });
    settled.catch(() => undefined); // a failed assertion is reported by `await settled` below, not as an unhandled rejection
    for (let waited = 0; !done && waited < limit; waited += 100) {
      await vi.advanceTimersByTimeAsync(100);
      await new Promise((resolveStep) => setImmediate(resolveStep));
    }
    expect(done, `settled within ${limit} ms of fake time`).toBe(true);
    await settled;
  };
  const UNREADABLE_LOCATION = /^\[router\] Refused: the session's location could not be read \(Error: session lookup timed out after 2000 ms\), so a relative path cannot be resolved \(fail closed\)\.$/;
  const never = () => new Promise<never>(() => undefined);
  /** No file leases: no session record is looked up for the lease wiring. */
  const LEASES_OFF = { routing: { leases: { mode: "off" } } };

  it("a host session lookup that never answers stalls no write call; with no directory known every write-class call is refused", async () => {
    // The plugin's location is `repo`; the child session runs in `bwt`, but the host never answers. The test relies only on each
    // call settling within the 60 s limit: a relative `path` waits at most 12 s (the call's lookup, 2 s, then the session record's,
    // 10 s); any other write-class call at most 15 s (the lease wiring's kind and directory lookups, 5 s each in background.ts,
    // then the call's 2 s, then what is left of the record's 10 s, which the lease wiring's lookup started: 3 s).
    const call = await host(fx.repo, {}, fx.bwt, never);
    fakeTimers();
    // A relative `path` cannot be resolved without the session's location: refused, never resolved against the plugin's `repo`.
    await settles(expect(call("child", "heavy", "write", { path: "src/a.ts", content: "x" })).rejects.toThrow(UNREADABLE_LOCATION));
    // Any other write-class call cannot be checked against the session's own repository: refused (fail closed).
    await settles(expect(call("child", "heavy", "write", v2Call("write", join(fx.bwt, "a.ts")))).rejects.toThrow(GIT_METADATA_DIRECTORY_UNKNOWN));
    // `../bare.git/config` from `bwt` is the common directory of the session's repository; from the plugin's `repo` it would not be.
    await settles(expect(call("child", "heavy", "apply_patch", v2Call("apply_patch", "../bare.git/config"))).rejects.toThrow(GIT_METADATA_DIRECTORY_UNKNOWN));
    // An absolute `.git` path keeps the metadata refusal.
    await settles(expect(call("child", "heavy", "edit", v2Call("edit", join(fx.repo, ".git", "hooks", "x")))).rejects.toThrow(REFUSED));
    // A read-class call is not guarded.
    await settles(expect(call("child", "heavy", "read", { path: join(fx.bwt, "a.ts") })).resolves.toBeUndefined());
    // The orchestrator, proven root by the plugin's own lookup, is not refused.
    await settles(expect(call("root", "build", "write", v2Call("write", join(fx.bwt, "a.ts")))).resolves.toBeUndefined());
    await settles(expect(call("root", "build", "apply_patch", v2Call("apply_patch", "../bare.git/config"))).resolves.toBeUndefined());
  });

  it("a fresh lookup that fails falls back to the directory of the session's last successful call (leases off: no session record)", async () => {
    let answering = true;
    const call = await host(fx.repo, LEASES_OFF, fx.bwt, (session) => (answering ? Promise.resolve(session) : never()));
    const patch = v2Call("apply_patch", "../bare.git/config");
    // The first call's answer is `bwt`: the common directory is refused.
    await expect(call("child", "heavy", "apply_patch", patch)).rejects.toThrow(REFUSED);
    answering = false;
    fakeTimers();
    await settles(expect(call("child", "heavy", "apply_patch", patch)).rejects.toThrow(REFUSED));
    // Calls that the last known directory can check proceed: a relative `path` and an absolute ordinary write.
    await settles(expect(call("child", "heavy", "write", { path: "src/a.ts", content: "x" })).resolves.toBeUndefined());
    await settles(expect(call("child", "heavy", "write", v2Call("write", join(fx.bwt, "a.ts")))).resolves.toBeUndefined());
  });

  it("a moved session whose lookup then fails is guarded in the directory of its last successful call, not its first", async () => {
    let location: string | undefined = fx.repo;
    const call = await host(fx.repo, {}, fx.repo, (session) => (location === undefined ? never() : Promise.resolve({ ...session, location: { directory: location } })));
    const patch = v2Call("apply_patch", "../bare.git/config");
    // The first answer, `repo`, is also the session record the file leases keep: from it the file is no git metadata.
    await expect(call("child", "heavy", "apply_patch", patch)).resolves.toBeUndefined();
    location = fx.bwt; // the host's session move
    await expect(call("child", "heavy", "apply_patch", patch)).rejects.toThrow(REFUSED);
    location = undefined; // the host stops answering
    fakeTimers();
    await settles(expect(call("child", "heavy", "apply_patch", patch)).rejects.toThrow(REFUSED));
  });

  it("an answer that is no session record is a failed lookup, never the plugin's directory", async () => {
    const call = await host(fx.repo, LEASES_OFF, fx.bwt, async () => null);
    await expect(call("child", "heavy", "write", { path: "src/a.ts", content: "x" }))
      .rejects.toThrow(/^\[router\] Refused: the session's location could not be read \(Error: the host returned no session\)/);
    await expect(call("child", "heavy", "write", v2Call("write", join(fx.bwt, "a.ts")))).rejects.toThrow(GIT_METADATA_DIRECTORY_UNKNOWN);
    await expect(call("child", "heavy", "apply_patch", v2Call("apply_patch", "a.ts"))).rejects.toThrow(GIT_METADATA_DIRECTORY_UNKNOWN);
    await expect(call("root", "build", "write", v2Call("write", join(fx.bwt, "a.ts")))).resolves.toBeUndefined();
  });

  it("one relative write makes one fresh session lookup, shared by scopedArgs and the guard", async () => {
    let lookups = 0;
    const call = await host(fx.repo, {}, fx.bwt, async (session) => { lookups += 1; return session; });
    // The first call also fills the lease wiring's kind and directory records.
    await expect(call("child", "heavy", "write", { path: "src/a.ts", content: "x" })).resolves.toBeUndefined();
    lookups = 0;
    await expect(call("child", "heavy", "write", { path: "src/b.ts", content: "x" })).resolves.toBeUndefined();
    expect(lookups).toBe(1);
    // That one answer (`bwt`) is the guard's base: `../bare.git/config` is its repository's common directory.
    lookups = 0;
    await expect(call("child", "heavy", "write", { path: "../bare.git/config", content: "x" })).rejects.toThrow(REFUSED);
    expect(lookups).toBe(1);
  });

  it("a session that answers without a location is in the plugin's directory: one lookup, no fallback", async () => {
    // The plugin's location is `bwt`; the host answers for the session but names no location. Leases off: the call's own lookup is
    // the only one, so an answer taken as a failed lookup would show as a second (the session record's).
    let lookups = 0;
    const call = await host(fx.bwt, LEASES_OFF, fx.bwt, async (session) => { lookups += 1; return { ...session, location: undefined }; });
    await expect(call("child", "heavy", "write", { path: "src/a.ts", content: "x" })).resolves.toBeUndefined();
    expect(lookups).toBe(1);
    // From the plugin's `bwt`, `../bare.git/config` is the common directory of its repository.
    lookups = 0;
    await expect(call("child", "heavy", "apply_patch", v2Call("apply_patch", "../bare.git/config"))).rejects.toThrow(REFUSED);
    expect(lookups).toBe(1);
  });

  it("a session the host moves is guarded in its new location: the directory is looked up afresh, not cached", async () => {
    let location = fx.repo;
    const call = await host(fx.repo, {}, fx.repo, async (session) => ({ ...session, location: { directory: location } }));
    const patch = v2Call("apply_patch", "../bare.git/config");
    // From `repo`, `../bare.git/config` is no git metadata; from `bwt` it is its repository's common directory.
    await expect(call("child", "heavy", "apply_patch", patch)).resolves.toBeUndefined();
    location = fx.bwt; // the host's session move
    await expect(call("child", "heavy", "apply_patch", patch)).rejects.toThrow(REFUSED);
    location = fx.repo;
    await expect(call("child", "heavy", "apply_patch", patch)).resolves.toBeUndefined();
  });
});
