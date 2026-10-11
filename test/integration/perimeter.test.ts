/**
 * test/integration/perimeter.test.ts
 *
 * Cross-repo P1.8 (docs/design/cross-repo.md I4, I8, I9, I13): the verification perimeter P of a role dispatch. W is app-a (the
 * dispatch's verification root, the grant's location); lib-b is a second repository in P (the orchestrator's working set, or a
 * package link of W).
 * - I4: lib-b changed during the dispatch and the producer ran an unattributable writer: unverifiable, naming lib-b.
 * - I4 needs both: lib-b changed without writers, or writers with lib-b unchanged (then I5 alone), is not refused by it.
 * - I9: a role dispatch with no location and no working set takes no extra snapshot, and its output is a plain dispatch's.
 * - I8: a pass with P > 1 names P. A pass renders no reasons, so the line is read from the gate result (`gate.accept` spied).
 * - A deferred DoD with a perimeter is verified at once (no handle).
 * - Link discovery: a junction to an admitted repository is in P; a store-like link is not.
 * - A write while an extra root's dispatch snapshot is in flight discards that snapshot ("could not be observed").
 *
 * The harness is test/integration/unattributed-writers.test.ts's: real temporary git repositories, the real plugin and gate, real
 * tree snapshots pinned (per directory here) through the `src/verify/tree` mock seam. The dispatch is made a routed role dispatch
 * by spying `routedRoleOf`, as branch-switch.test.ts F4 does. Every case is deterministic: no retries.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ModelRouterPlugin from "../../src/index";
import { invalidateConfigCache } from "../../src/router/config";
import * as gateModule from "../../src/verify/gate";
import * as dispatchModule from "../../src/routing/wire/dispatch";
import { addToWorkingSet, forgetWorkingSet } from "../../src/routing/wire/working-set";
import type { RepoLocation } from "../../src/routing/roles/admission";
import { createChangedFileStore } from "../../src/verify/dispatch";
import { planPerimeter } from "../../src/verify/perimeter";

type Tree = Awaited<ReturnType<typeof import("../../src/verify/tree").snapshotTree>>;

/** Snapshots pinned per directory key, and the key of every directory the router snapshotted. */
const seam = vi.hoisted(() => {
  const key = (at: string): string => {
    const normalized = at.replace(/\\/g, "/").replace(/\/+$/, "");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return { key, pins: new Map<string, unknown>(), calls: [] as string[] };
});

vi.mock("../../src/verify/tree", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/verify/tree")>();
  return {
    ...actual,
    snapshotTree: (...args: Parameters<typeof actual.snapshotTree>) => {
      const key = seam.key(args[0]);
      seam.calls.push(key);
      const pin = seam.pins.get(key);
      return pin !== undefined ? Promise.resolve(pin as Tree) : actual.snapshotTree(...args);
    },
  };
});

const SYNC_DOD = "[acceptance]\ncheck: fileExists path=index.ts\n[/acceptance]";
const DEFERRED_DOD = `VERIFY:deferred\n[acceptance]\ncheck: testsPass command="npm test"\ncheck: fileExists path=index.ts\n[/acceptance]`;
const I4_REASON = (tools: string): RegExp => new RegExp(
  `the repository lib-b at \\S+ also changed during the dispatch, and the producer ran ${tools}; a write there cannot be attributed, `
  + "so the checks in \\S+ do not cover it\\. Dispatch that work with repo=lib-b, or verify it there\\.",
);
const ANY_I4 = /during the dispatch, and the producer ran /;
const I5_CAVEAT = /no change was observed in \S+ but the producer ran bash; a write those tools made cannot be seen/;
const SCOPE_LINE = /verified scope: app-a \([^ ()]+ @ [0-9a-f]{7}\); also observed: lib-b \([^ ()]+ @ [0-9a-f]{7}\)/;
const HANDLE = /vrf_[0-9a-f]{24}/;

let home = "";
let parent = "";
let repo = "";
let lib = "";
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
let acceptSpy: MockInstance<typeof gateModule.accept>;

function initRepo(dir: string, files: Record<string, string>): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
  for (const args of [["init", "-q"], ["add", "-A"], ["commit", "-q", "-m", "init"]]) execFileSync("git", args, { cwd: dir, stdio: "ignore", env });
}

/** Takes a real snapshot of `dir` as it is now (no time bound) and pins it for the router's snapshot calls there. */
async function pin(dir: string): Promise<void> {
  const keys = [seam.key(dir), seam.key(fs.realpathSync.native(dir))];
  for (const key of keys) seam.pins.delete(key);
  const { snapshotTree } = await vi.importActual<typeof import("../../src/verify/tree")>("../../src/verify/tree");
  const tree = await snapshotTree(dir, new AbortController().signal, { digestPaths: [] });
  if (tree === undefined) throw new Error(`the real snapshot of ${dir} failed`);
  for (const key of keys) seam.pins.set(key, tree);
}

const location = (dir: string, name: string): RepoLocation => ({ repository: dir, name, worktree: dir, branch: null, head: null, worktrees: [] });

/** Makes `call1` of "orch" a routed role dispatch verified in app-a; `grantLocation`: the location cross-repo admission bound. */
function routeAsRole(grantLocation?: RepoLocation): void {
  const routed = {
    callID: "call1", parentSessionID: "orch", agent: "implementer", tier: "fast", carried: false, resumeID: null,
    verifyRoot: repo, workRoot: repo, grant: { workRoot: repo, ...(grantLocation !== undefined ? { location: grantLocation } : {}) },
  };
  const actual = dispatchModule.routedRoleOf;
  vi.spyOn(dispatchModule, "routedRoleOf").mockImplementation(callID =>
    (callID === "call1" ? routed as unknown as ReturnType<typeof actual> : actual(callID)));
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "omr-perim-home-"));
  parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "omr-perim-")));
  repo = path.join(parent, "app-a");
  lib = path.join(parent, "lib-b");
  initRepo(repo, {
    "index.ts": "export const v = 0;\n",
    ".gitignore": "node_modules/\n",
    "package.json": `{ "name": "app-a", "private": true, "scripts": { "test": "node --version" } }\n`,
  });
  initRepo(lib, { "index.ts": "export const b = 0;\n" });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.MODEL_ROUTER_ENFORCE = "1";
  process.env.MODEL_ROUTER_VERIFIED_DELEGATE = "1";
  invalidateConfigCache();
  acceptSpy = vi.spyOn(gateModule, "accept");
}, 60_000); // setup only: git init/add/commit are slow when the whole suite runs in parallel

afterEach(() => {
  vi.restoreAllMocks();
  seam.pins.clear();
  seam.calls.length = 0;
  forgetWorkingSet("orch");
  for (const key of ["HOME", "USERPROFILE"] as const) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  delete process.env.MODEL_ROUTER_ENFORCE;
  delete process.env.MODEL_ROUTER_VERIFIED_DELEGATE;
  invalidateConfigCache();
  for (const dir of [home, parent]) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

let callCounter = 0;

/** The harness reports one tool call of the producer session: before and after hooks, with `tool` and no file written. */
async function runTool(hooks: any, sessionID: string, tool: string, args: Record<string, unknown>): Promise<void> {
  const callID = `c${++callCounter}`;
  await hooks["tool.execute.before"]({ tool, sessionID, callID }, { args: { ...args } });
  await hooks["tool.execute.after"]({ tool, sessionID, callID, args }, { title: "", output: "", metadata: {} });
}

/** A plugin whose directory is app-a. */
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

/** Runs one native `task` dispatch whose child session does `work` between the before and after hooks. */
async function runTask(hooks: any, prompt: string, work: (hooks: any, sessionID: string) => Promise<void>): Promise<string> {
  const input: any = { tool: "task", sessionID: "orch", callID: "call1", args: { subagent_type: "fast", prompt, description: "the work" } };
  const before = { args: { ...input.args } };
  await hooks["tool.execute.before"](input, before);
  input.args = before.args;
  await work(hooks, "child1");
  const output = { output: "<task_result>\nDONE: implemented.\n</task_result>", metadata: { sessionId: "child1" } };
  await hooks["tool.execute.after"](input, output);
  return output.output;
}

const artefacts = (): Parameters<typeof gateModule.accept>[1][] => acceptSpy.mock.calls.map(call => call[1]);
const gateResults = async (): Promise<string> => JSON.stringify(await Promise.all(acceptSpy.mock.results.map(result => result.value)));

describe("the verification perimeter of a cross-repo role dispatch (P1.8)", () => {
  /** W is app-a (the grant's location); lib-b is in the orchestrator's working set; both trees are pinned clean. */
  async function crossRepo(): Promise<any> {
    addToWorkingSet("orch", location(lib, "lib-b"));
    routeAsRole(location(repo, "app-a"));
    const hooks = await makePlugin();
    await pin(repo);
    await pin(lib);
    return hooks;
  }
  /** lib-b changes outside every tool the router observes (a tracked file), and the changed tree is pinned. */
  const changeLib = async (): Promise<void> => {
    fs.writeFileSync(path.join(lib, "index.ts"), "export const b = 1;\n");
    await pin(lib);
  };

  it("I4-refuses: the producer ran bash and lib-b (in P) changed: unverifiable, naming lib-b", async () => {
    const hooks = await crossRepo();
    const out = await runTask(hooks, `Implement it.\n${SYNC_DOD}`, async (h, sid) => {
      await runTool(h, sid, "bash", { command: "echo hi" });
      await changeLib();
    });
    expect(out).toMatch(I4_REASON("bash"));
    expect(out).toContain("UNVERIFIED");
    expect(out).not.toContain("✓ verified");
    expect(artefacts()[0]?.perimeter?.roots.map(root => [root.name, root.status])).toEqual([["lib-b", "changed"]]);
  }, 60_000);

  it("I4-writers: lib-b changed but the producer ran no unattributable writer: not refused by I4", async () => {
    const hooks = await crossRepo();
    const out = await runTask(hooks, `Implement it.\n${SYNC_DOD}`, async (h, sid) => {
      await runTool(h, sid, "read", {});
      await changeLib();
    });
    expect(out).not.toMatch(ANY_I4);
    expect(out).toContain("✓ verified");
    expect(artefacts()[0]?.perimeter?.roots[0]?.status).toBe("changed");
  }, 60_000);

  it("I4-unchanged: lib-b unchanged and the producer ran bash: only the empty-change caveat (I5), no I4", async () => {
    const hooks = await crossRepo();
    const out = await runTask(hooks, `Implement it.\n${SYNC_DOD}`, async (h, sid) => {
      await runTool(h, sid, "bash", { command: "echo hi" });
    });
    expect(out).toMatch(I5_CAVEAT);
    expect(out).not.toMatch(ANY_I4);
    expect(artefacts()[0]?.perimeter?.roots[0]?.status).toBe("unchanged");
  }, 60_000);

  it("I9-inert: a role dispatch with no location and no working set takes no extra snapshot; its output is a plain dispatch's", async () => {
    const plainHooks = await makePlugin();
    await pin(repo);
    seam.calls.length = 0;
    const plain = await runTask(plainHooks, `Implement it.\n${SYNC_DOD}`, async () => undefined);
    const plainCalls = [...seam.calls];
    routeAsRole();
    const roleHooks = await makePlugin();
    seam.calls.length = 0;
    const role = await runTask(roleHooks, `Implement it.\n${SYNC_DOD}`, async () => undefined);
    expect(seam.calls).not.toContain(seam.key(lib));
    expect(seam.calls).toHaveLength(plainCalls.length);
    expect([...new Set(seam.calls)]).toEqual([...new Set(plainCalls)]);
    expect(role).toBe(plain);
    expect(artefacts()).toHaveLength(2);
    expect(artefacts().every(artefact => artefact.perimeter === undefined)).toBe(true);
  }, 60_000);

  it("I8-scope: a pass with P > 1 names the perimeter (repository, branch, short HEAD); the outcome stays a pass", async () => {
    const hooks = await crossRepo();
    const out = await runTask(hooks, `Implement it.\n${SYNC_DOD}`, async () => undefined);
    expect(out).toContain("✓ verified");
    expect(await gateResults()).toMatch(SCOPE_LINE);
  }, 60_000);

  it("defer-cross-repo: a deferred DoD with a perimeter is verified at once, without a handle", async () => {
    const hooks = await crossRepo();
    const out = await runTask(hooks, `Implement it.\n${DEFERRED_DOD}`, async () => undefined);
    expect(HANDLE.exec(out)?.[0], out).toBeUndefined();
    expect(artefacts()).toHaveLength(1);
    expect(artefacts()[0]?.perimeter?.roots[0]?.name).toBe("lib-b");
  }, 90_000);

  it("defer-control: the same role dispatch without a perimeter is deferred", async () => {
    routeAsRole();
    const hooks = await makePlugin();
    await pin(repo);
    const out = await runTask(hooks, `Implement it.\n${DEFERRED_DOD}`, async () => undefined);
    expect(HANDLE.exec(out)?.[0], out).toBeDefined();
  }, 90_000);

  it("link-store: a node_modules junction to an admitted repository is in P; a store-like link is not", () => {
    routeAsRole(location(repo, "app-a"));
    const modules = path.join(repo, "node_modules");
    fs.mkdirSync(path.join(modules, "@scope"), { recursive: true });
    fs.symlinkSync(lib, path.join(modules, "lib-b"), "junction");
    const store = path.join(parent, "store", "node_modules", "pkg");
    fs.mkdirSync(store, { recursive: true });
    fs.symlinkSync(store, path.join(modules, "@scope", "pkg"), "junction");
    const plan = planPerimeter("task:orch:call1", repo, () => ({ parents: [parent], depth: 1 }));
    const roots = (plan?.roots ?? []).map(seed => seam.key(seed.at));
    expect(roots).toContain(seam.key(lib));
    expect(roots).not.toContain(seam.key(store));
    expect(plan?.name).toBe("app-a");
    const seed = plan?.roots.find(candidate => seam.key(candidate.at) === seam.key(lib));
    expect(seed?.admit?.(lib)).toBe(true);
    expect(seed?.admit?.(parent)).toBe(false);
    // Not below a parent and not in the working set: not admitted, so P is W alone.
    expect(planPerimeter("task:orch:call1", repo, () => ({ parents: [], depth: 1 }))).toBeUndefined();
  });

  it("contamination: a write while an extra root's dispatch snapshot is in flight discards it", async () => {
    const tree = { cwd: lib, root: lib, head: "a".repeat(40), fingerprint: "f", dirty: false, files: [] } as unknown as NonNullable<Tree>;
    const run = async (write: boolean): Promise<Tree> => {
      const store = createChangedFileStore();
      let release: (value: Tree) => void = () => undefined;
      const held = new Promise<Tree>(settle => {
        release = settle;
      });
      const begun = store.beginDispatch("d", repo, {
        snapshot: at => (seam.key(at) === seam.key(lib) ? held : Promise.resolve(undefined)),
        timeoutMs: 10_000,
        perimeter: { roots: [{ at: lib }] },
      });
      if (write) store.observeEdit("bash", path.join(lib, "src"));
      release(tree);
      await begun;
      return store.perimeterOf("d")?.entries.get(lib)?.snapshot;
    };
    expect(await run(false)).toBe(tree);
    expect(await run(true)).toBeUndefined();
  });
});
