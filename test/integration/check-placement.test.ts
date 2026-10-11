/**
 * test/integration/check-placement.test.ts
 *
 * Cross-repo Phase 2 (docs/design/cross-repo-phase2-plan.md P2a.3, P2.7 interim): a routed role dispatch whose DoD has any per-check
 * `cwd=` or `scope=` is never deferred; it is verified at once. The gate does not receive placements yet. A tier dispatch, and a
 * role dispatch without per-check keys, defer as before.
 *
 * The harness is test/integration/perimeter.test.ts's: a real temporary git repository, the real plugin and gate, `routedRoleOf`
 * spied to make the dispatch a routed role dispatch, tree snapshots pinned through the `src/verify/tree` mock seam.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ModelRouterPlugin from "../../src/index";
import { invalidateConfigCache } from "../../src/router/config";
import * as dispatchModule from "../../src/routing/wire/dispatch";

type Tree = Awaited<ReturnType<typeof import("../../src/verify/tree").snapshotTree>>;

/** Snapshots pinned per directory key. */
const seam = vi.hoisted(() => {
  const key = (at: string): string => {
    const normalized = at.replace(/\\/g, "/").replace(/\/+$/, "");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return { key, pins: new Map<string, unknown>() };
});

vi.mock("../../src/verify/tree", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/verify/tree")>();
  return {
    ...actual,
    snapshotTree: (...args: Parameters<typeof actual.snapshotTree>) => {
      const pin = seam.pins.get(seam.key(args[0]));
      return pin !== undefined ? Promise.resolve(pin as Tree) : actual.snapshotTree(...args);
    },
  };
});

const dod = (checks: string[]): string => `VERIFY:deferred\n[acceptance]\n${checks.map(check => `check: ${check}`).join("\n")}\n[/acceptance]`;
const PLAIN = ['testsPass command="npm test"', "fileExists path=index.ts"];
const HANDLE = /vrf_[0-9a-f]{24}/;

let home = "";
let parent = "";
let repo = "";
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

function initRepo(dir: string, files: Record<string, string>): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
  for (const args of [["init", "-q"], ["add", "-A"], ["commit", "-q", "-m", "init"]]) execFileSync("git", args, { cwd: dir, stdio: "ignore", env });
}

/** Pins a real snapshot of `dir` as it is now for the router's snapshot calls there. */
async function pin(dir: string): Promise<void> {
  const keys = [seam.key(dir), seam.key(fs.realpathSync.native(dir))];
  for (const key of keys) seam.pins.delete(key);
  const { snapshotTree } = await vi.importActual<typeof import("../../src/verify/tree")>("../../src/verify/tree");
  const tree = await snapshotTree(dir, new AbortController().signal, { digestPaths: [] });
  if (tree === undefined) throw new Error(`the real snapshot of ${dir} failed`);
  for (const key of keys) seam.pins.set(key, tree);
}

/** Makes `call1` of "orch" a routed role dispatch verified in the repository. */
function routeAsRole(): void {
  const routed = {
    callID: "call1", parentSessionID: "orch", agent: "implementer", tier: "fast", carried: false, resumeID: null,
    verifyRoot: repo, workRoot: repo, grant: { workRoot: repo },
  };
  const actual = dispatchModule.routedRoleOf;
  vi.spyOn(dispatchModule, "routedRoleOf").mockImplementation(callID =>
    (callID === "call1" ? routed as unknown as ReturnType<typeof actual> : actual(callID)));
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "omr-place-home-"));
  parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "omr-place-")));
  repo = path.join(parent, "app-a");
  initRepo(repo, {
    "index.ts": "export const v = 0;\n",
    "sub/inner.ts": "export const w = 0;\n",
    ".gitignore": "node_modules/\n",
    "package.json": `{ "name": "app-a", "private": true, "scripts": { "test": "node --version" } }\n`,
  });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.MODEL_ROUTER_ENFORCE = "1";
  process.env.MODEL_ROUTER_VERIFIED_DELEGATE = "1";
  invalidateConfigCache();
}, 60_000);

afterEach(() => {
  vi.restoreAllMocks();
  seam.pins.clear();
  for (const key of ["HOME", "USERPROFILE"] as const) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  delete process.env.MODEL_ROUTER_ENFORCE;
  delete process.env.MODEL_ROUTER_VERIFIED_DELEGATE;
  invalidateConfigCache();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.rmSync(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** A plugin whose directory is the repository. */
async function makePlugin(): Promise<any> {
  const created: string[] = [];
  const ctx = {
    directory: repo,
    worktree: repo,
    project: {},
    serverUrl: new URL("http://localhost"),
    $: () => undefined,
    client: {
      session: {
        get: async () => ({ data: {} }),
        create: async () => {
          const id = `sess_${created.length + 1}`;
          created.push(id);
          return { data: { id } };
        },
        prompt: async () => ({ data: { parts: [{ type: "text", text: "DONE: implemented." }] } }),
        abort: async () => ({}),
        delete: async () => ({}),
      },
    },
  };
  return ModelRouterPlugin(ctx as unknown as Parameters<typeof ModelRouterPlugin>[0]);
}

/** Runs one native `task` dispatch whose child does nothing, and returns the output the orchestrator sees. */
async function runTask(hooks: any, prompt: string): Promise<string> {
  const input: any = { tool: "task", sessionID: "orch", callID: "call1", args: { subagent_type: "fast", prompt, description: "the work" } };
  const before = { args: { ...input.args } };
  await hooks["tool.execute.before"](input, before);
  input.args = before.args;
  const output = { output: "<task_result>\nDONE: implemented.\n</task_result>", metadata: { sessionId: "child1" } };
  await hooks["tool.execute.after"](input, output);
  return output.output;
}

describe("interim deferral (P2.7 interim)", () => {
  it("(a) a deferred role dispatch with a per-check cwd= inside W is verified at once, without a handle", async () => {
    routeAsRole();
    const hooks = await makePlugin();
    await pin(repo);
    const out = await runTask(hooks, `Implement it.\n${dod(['testsPass command="npm test"', "fileExists path=inner.ts cwd=sub"])}`);
    expect(HANDLE.exec(out)?.[0], out).toBeUndefined();
  }, 90_000);

  it("(b) the same with only scope=full on a check", async () => {
    routeAsRole();
    const hooks = await makePlugin();
    await pin(repo);
    const out = await runTask(hooks, `Implement it.\n${dod(['testsPass command="npm test" scope=full', "fileExists path=index.ts"])}`);
    expect(HANDLE.exec(out)?.[0], out).toBeUndefined();
  }, 90_000);

  it("(c) control: a role dispatch without per-check keys is deferred, with a handle", async () => {
    routeAsRole();
    const hooks = await makePlugin();
    await pin(repo);
    const out = await runTask(hooks, `Implement it.\n${dod(PLAIN)}`);
    expect(HANDLE.exec(out)?.[0], out).toBeDefined();
  }, 90_000);

  it("(d) a tier dispatch with per-check keys is deferred as before", async () => {
    // No routeAsRole(): routedRoleOf("call1") is undefined.
    const hooks = await makePlugin();
    await pin(repo);
    const out = await runTask(hooks, `Implement it.\n${dod(['testsPass command="npm test" scope=full', "fileExists path=inner.ts cwd=sub"])}`);
    expect(HANDLE.exec(out)?.[0], out).toBeDefined();
  }, 90_000);
});
