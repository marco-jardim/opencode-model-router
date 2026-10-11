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
 * - P2e: a deferred DoD with a perimeter and no I4 at return is deferred (a handle); router_verify gates it with the perimeter
 *   frozen at return (I4/I8 as at return, S11 link drift, the frozen pins). I4 at return, or a link not observed then, is not
 *   deferred: the required gate decides.
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
import { invalidateConfigCache, loadConfig } from "../../src/router/config";
import * as gateModule from "../../src/verify/gate";
import * as dispatchModule from "../../src/routing/wire/dispatch";
import { addToWorkingSet, forgetWorkingSet } from "../../src/routing/wire/working-set";
import type { RepoLocation } from "../../src/routing/roles/admission";
import { createChangedFileStore } from "../../src/verify/dispatch";
import * as storeModule from "../../src/verify/dispatch";
import * as pendingModule from "../../src/verify/pending";
import * as perimeterModule from "../../src/verify/perimeter";
import * as deterministicModule from "../../src/verify/deterministic";
import { samePin, type LinkPin } from "../../src/verify/pin";
import type { DoD } from "../../src/verify/dod";
import { PERIMETER_MAX, planPerimeter } from "../../src/verify/perimeter";

type Tree = Awaited<ReturnType<typeof import("../../src/verify/tree").snapshotTree>>;

/** Snapshots pinned per directory key, and the key of every directory the router snapshotted. */
const seam = vi.hoisted(() => {
  const key = (at: string): string => {
    const normalized = at.replace(/\\/g, "/").replace(/\/+$/, "");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return {
    key, pins: new Map<string, unknown>(), calls: [] as string[], hardened: [] as string[],
    /** QA-2 #4: every snapshot call in order, with whether it asked for the ignored-files digest (a link pin). */
    log: [] as { key: string; digest: boolean }[],
    /** Pinned answers for the digested calls only (else `pins`). */
    digestPins: new Map<string, unknown>(),
  };
});

vi.mock("../../src/verify/tree", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/verify/tree")>();
  return {
    ...actual,
    snapshotTree: (...args: Parameters<typeof actual.snapshotTree>) => {
      const key = seam.key(args[0]);
      seam.calls.push(key);
      if (args[2]?.hardened === true) seam.hardened.push(key);
      seam.log.push({ key, digest: args[2]?.ignoredDigest === true });
      if (args[2]?.ignoredDigest === true) {
        const digestPin = seam.digestPins.get(key);
        if (digestPin !== undefined) return Promise.resolve(digestPin as Tree);
      }
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
  seam.hardened.length = 0;
  seam.log.length = 0;
  seam.digestPins.clear();
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
    // QA-1 F4 (I11): git runs hardened in an extra root, at dispatch and at the gate; W's own snapshot is unchanged.
    expect(seam.hardened.filter(key => key === seam.key(lib))).toHaveLength(2);
    expect(seam.hardened).not.toContain(seam.key(repo));
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
    // QA-1 F6 (I4 "otherwise → a note"): the rendered scope line says lib-b changed.
    expect(out).toMatch(/also observed: lib-b \([^ ()]+ @ [0-9a-f]{7}, changed during the dispatch\)/);
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
    // QA-1 F6: the line is rendered on the pass (a verification note), not only kept in the gate result.
    expect(out).toMatch(SCOPE_LINE);
  }, 60_000);

  // P2e.5 (flipped on purpose): before P2e a dispatch with a perimeter was never deferred ("cross-repo"). Now, with no I4 at
  // return, it is deferred with the perimeter frozen; no gate runs at return.
  it("defer-cross-repo: a deferred DoD with a perimeter and no I4 at return gets a handle", async () => {
    const hooks = await crossRepo();
    const out = await runTask(hooks, `Implement it.\n${DEFERRED_DOD}`, async () => undefined);
    expect(HANDLE.exec(out)?.[0], out).toBeDefined();
    expect(artefacts()).toHaveLength(0);
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
    // Cross-repo QA round 2 (I8, I12): not below a parent and not in the working set, the target is not dropped: it is kept as an
    // unadmitted root, named by its basename only, and git never runs there. The store-like link stays out.
    const outside = planPerimeter("task:orch:call1", repo, () => ({ parents: [], depth: 1 }));
    expect(outside?.roots.map(seed => [seam.key(seed.at), seed.name, seed.fixed])).toEqual([[seam.key(lib), "lib-b", "unadmitted"]]);
    expect(outside?.roots[0]?.admit).toBeUndefined();
  });

  it("QA round 2 (I8): a link target outside every parent is reported, not silently dropped: '(not admitted)', git never runs there", async () => {
    routeAsRole(location(repo, "app-a"));
    const modules = path.join(repo, "node_modules");
    fs.mkdirSync(modules, { recursive: true });
    fs.symlinkSync(lib, path.join(modules, "lib-b"), "junction");
    const realPlan = perimeterModule.planPerimeter;
    // routing.repoParents names a directory that holds neither W nor lib-b.
    vi.spyOn(perimeterModule, "planPerimeter").mockImplementation((id, cwd) => realPlan(id, cwd, () => ({ parents: [path.join(parent, "elsewhere")], depth: 1, exclude: [] })));
    const hooks = await makePlugin();
    await pin(repo);
    await pin(lib);
    const out = await runTask(hooks, `Implement it.\n${SYNC_DOD}`, async () => undefined);
    expect(seam.calls).not.toContain(seam.key(lib));
    expect(out).toContain("✓ verified");
    expect(out).toMatch(/also observed: lib-b \(not admitted\)/);
    expect(out).not.toMatch(/lib-b \(not observed\)/);
    expect(artefacts()[0]?.perimeter?.roots.map(root => [root.name, root.status])).toEqual([["lib-b", "unadmitted"]]);
  }, 60_000);

  it("QA round 2 (I13, S1/S2): a role dispatch with no repo= still gets a perimeter when repoParents is set and W links a sibling; without repoParents it is inert (I9)", async () => {
    routeAsRole(); // No grant location, and no working set.
    const modules = path.join(repo, "node_modules");
    fs.mkdirSync(modules, { recursive: true });
    fs.symlinkSync(lib, path.join(modules, "lib-b"), "junction");
    const plan = planPerimeter("task:orch:call1", repo, () => ({ parents: [parent], depth: 1 }));
    expect(plan?.name).toBeUndefined();
    expect(plan?.roots.map(seed => [seam.key(seed.at), seed.fixed])).toEqual([[seam.key(lib), undefined]]);
    // I9: no repoParents, no location, no working set: no perimeter, and admission is read only to find that out.
    expect(planPerimeter("task:orch:call1", repo, () => ({ parents: [], depth: 1 }))).toBeUndefined();
    // Inert when nothing extra is found: parents set, no links.
    fs.rmSync(path.join(modules, "lib-b"), { recursive: true, force: true });
    expect(planPerimeter("task:orch:call1", repo, () => ({ parents: [parent], depth: 1 }))).toBeUndefined();

    // End to end: a bash write in lib-b during the dispatch is unverifiable.
    fs.symlinkSync(lib, path.join(modules, "lib-b"), "junction");
    const realPlan = perimeterModule.planPerimeter;
    vi.spyOn(perimeterModule, "planPerimeter").mockImplementation((id, cwd) => realPlan(id, cwd, () => ({ parents: [parent], depth: 1, exclude: [] })));
    const hooks = await makePlugin();
    await pin(repo);
    await pin(lib);
    const out = await runTask(hooks, `Implement it.\n${SYNC_DOD}`, async (h, sid) => {
      await runTool(h, sid, "bash", { command: "echo hi" });
      await changeLib();
    });
    expect(out).toMatch(I4_REASON("bash"));
    expect(out).toContain("UNVERIFIED");
    expect(artefacts()[0]?.perimeter?.roots.map(root => [root.name, root.status])).toEqual([["lib-b", "changed"]]);
  }, 60_000);

  it("QA round 2 (I11): a hardened snapshot keeps the user's core.autocrlf, so a CRLF checkout is not 'modified'; a repo-local value still wins", async () => {
    const { snapshotTree } = await vi.importActual<typeof import("../../src/verify/tree")>("../../src/verify/tree");
    const globalConfig = path.join(home, "global.gitconfig");
    fs.writeFileSync(globalConfig, "[core]\n\tautocrlf = true\n");
    const savedEnv = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    try {
      // A CRLF checkout committed under core.autocrlf=true: the blob is LF, the working file is CRLF.
      const file = path.join(lib, "index.ts");
      fs.writeFileSync(file, "export const b = 0;\r\nexport const c = 1;\r\n");
      const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
      for (const args of [["add", "-A"], ["commit", "-q", "--amend", "-m", "crlf"]]) {
        execFileSync("git", ["-c", "core.autocrlf=true", ...args], { cwd: lib, stdio: "ignore", env });
      }
      const signal = new AbortController().signal;
      const touch = (seconds: number): void => {
        const when = new Date(Date.now() + seconds * 1000);
        fs.utimesSync(file, when, when); // mtime changes, content does not
      };
      touch(60);
      const first = await snapshotTree(lib, signal, { hardened: true, digestPaths: [] });
      touch(120);
      const second = await snapshotTree(lib, signal, { hardened: true, digestPaths: [] });
      expect(first?.dirty).toBe(false);
      expect(second?.dirty).toBe(false);
      expect(second?.fingerprint).toBe(first?.fingerprint);
      // A value the repository sets itself is not overridden by the inherited one.
      execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: lib, stdio: "ignore" });
      const local = await snapshotTree(lib, signal, { hardened: true, digestPaths: [] });
      expect(local?.dirty).toBe(true);
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 60_000);

  it("contamination: a write while an extra root's dispatch snapshot is in flight discards it", async () => {
    const tree = { cwd: lib, root: lib, head: "a".repeat(40), fingerprint: "f", dirty: false, files: [] } as unknown as NonNullable<Tree>;
    const run = async (write?: (store: ReturnType<typeof createChangedFileStore>) => void): Promise<Tree> => {
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
      write?.(store);
      release(tree);
      await begun;
      return store.perimeterOf("d")?.entries.get(lib)?.snapshot;
    };
    expect(await run()).toBe(tree);
    expect(await run(store => store.observeEdit("bash", path.join(lib, "src")))).toBeUndefined();
    // QA-1 F1: router_run's cwd is always W, so the call's directory never names lib-b; an unattributable writer discards it.
    expect(await run(store => store.observeEdit("router_run", repo))).toBeUndefined();
    expect(await run(store => store.observeEdit("bash", repo))).toBeUndefined();
    // A tool that never writes leaves it alone.
    expect(await run(store => store.observeEdit("read", repo))).toBe(tree);
  });

  it("QA-1 F1: router_run (cwd W) while lib-b's dispatch snapshot is in flight: lib-b was not observed, so unverifiable", async () => {
    const hooks = await crossRepo();
    let release: (value: Tree) => void = () => undefined;
    seam.pins.set(seam.key(lib), new Promise<Tree>(settle => {
      release = settle;
    }));
    const out = await runTask(hooks, `VERIFY_WAIT:0s\nImplement it.\n${SYNC_DOD}`, async (h, sid) => {
      const args = { script: "build", cwd: repo };
      await h["tool.execute.before"]({ tool: "router_run", sessionID: sid, callID: "c-run" }, { args: { ...args } });
      // While the run runs it writes lib-b, and lib-b's in-flight dispatch snapshot settles holding that write; the run's
      // after hook comes later, too late to discard it.
      await changeLib();
      release(seam.pins.get(seam.key(lib)) as Tree);
      await new Promise(settle => setTimeout(settle, 20));
      fs.writeFileSync(path.join(repo, "index.ts"), "export const v = 1;\n");
      await pin(repo);
      await h["tool.execute.after"]({ tool: "router_run", sessionID: sid, callID: "c-run", args }, { title: "", output: "", metadata: {} });
    });
    expect(out).toMatch(/the repository lib-b at \S+ could not be observed during the dispatch, and the producer ran router_run/);
    expect(out).toContain("UNVERIFIED");
    expect(out).not.toContain("✓ verified");
    expect(artefacts()[0]?.perimeter?.roots.map(root => [root.name, root.status])).toEqual([["lib-b", "unobserved"]]);
  }, 60_000);

  /** A pinned stand-in tree for a working-set root that is not a real repository. */
  const fakeTree = (dir: string): Tree => ({
    cwd: dir, root: dir, head: "b".repeat(40), branch: "main", fingerprint: `fake:${dir}`, dirty: false, files: [],
  } as unknown as NonNullable<Tree>);

  it("QA-1 F2: a root past the cap is kept, never snapshotted, and reported unobserved; with bash, I4 names it", async () => {
    addToWorkingSet("orch", location(lib, "lib-b"));
    const extras = Array.from({ length: PERIMETER_MAX - 1 }, (_, i) => path.join(parent, `extra-${i + 1}`));
    for (const dir of extras) {
      addToWorkingSet("orch", location(dir, path.basename(dir)));
      seam.pins.set(seam.key(dir), fakeTree(dir));
    }
    routeAsRole(location(repo, "app-a"));
    const hooks = await makePlugin();
    await pin(repo);
    await pin(lib);
    const last = extras[extras.length - 1] ?? "";
    const out = await runTask(hooks, `Implement it.\n${SYNC_DOD}`, async (h, sid) => {
      await runTool(h, sid, "bash", { command: "echo hi" });
    });
    expect(seam.calls).not.toContain(seam.key(last));
    expect(out).toMatch(new RegExp(`the repository ${path.basename(last)} at \\S+ could not be observed during the dispatch`));
    const roots = artefacts()[0]?.perimeter?.roots ?? [];
    expect(roots).toHaveLength(PERIMETER_MAX);
    expect(roots.filter(root => root.status === "unobserved").map(root => root.name)).toEqual([path.basename(last)]);
  }, 60_000);

  it("QA-1 F3: two links into one repository are one root, at its top level", () => {
    routeAsRole(location(repo, "app-a"));
    const modules = path.join(repo, "node_modules");
    fs.mkdirSync(modules, { recursive: true });
    for (const name of ["x", "y"]) {
      fs.mkdirSync(path.join(lib, "packages", name), { recursive: true });
      fs.symlinkSync(path.join(lib, "packages", name), path.join(modules, `pkg-${name}`), "junction");
    }
    const plan = planPerimeter("task:orch:call1", repo, () => ({ parents: [parent], depth: 1, exclude: [] }));
    expect((plan?.roots ?? []).map(seed => [seam.key(seed.at), seed.fixed])).toEqual([[seam.key(lib), undefined]]);
  });

  it("QA-1 F4: a linked repository past repoDepth, excluded, or not a git repository is unadmitted and never snapshotted", async () => {
    routeAsRole(location(repo, "app-a"));
    const deep = path.join(parent, "group", "deep");
    initRepo(deep, { "a.txt": "a\n" });
    const plain = path.join(parent, "plain");
    fs.mkdirSync(plain, { recursive: true });
    const modules = path.join(repo, "node_modules");
    fs.mkdirSync(modules, { recursive: true });
    for (const target of [deep, plain, lib]) fs.symlinkSync(target, path.join(modules, path.basename(target)), "junction");
    const statuses = (exclude: string[]): Record<string, string> => Object.fromEntries(
      (planPerimeter("task:orch:call1", repo, () => ({ parents: [parent], depth: 1, exclude }))?.roots ?? [])
        .map(seed => [path.basename(seed.at), seed.fixed ?? "observed"]),
    );
    expect(statuses([])).toEqual({ "lib-b": "observed", deep: "unadmitted", plain: "unadmitted" });
    expect(statuses([`${parent.replace(/\\/g, "/")}/lib-*`])).toEqual({ "lib-b": "unadmitted", deep: "unadmitted", plain: "unadmitted" });
    // Through a dispatch (repoParents = the temporary parent): the unadmitted roots are named in I8 as not observed, and git
    // never runs there.
    const realPlan = perimeterModule.planPerimeter;
    vi.spyOn(perimeterModule, "planPerimeter").mockImplementation((id, cwd) => realPlan(id, cwd, () => ({ parents: [parent], depth: 1, exclude: [] })));
    const hooks = await makePlugin();
    await pin(repo);
    await pin(lib);
    const out = await runTask(hooks, `Implement it.\n${SYNC_DOD}`, async () => undefined);
    expect(seam.calls).not.toContain(seam.key(deep));
    expect(seam.calls).not.toContain(seam.key(plain));
    expect(out).toContain("✓ verified");
    expect(out).toMatch(/also observed: .*deep \(not admitted\)/);
    expect(out).toMatch(/also observed: .*plain \(not admitted\)/);
  }, 60_000);

  it("QA-1 F10: a perimeter that cannot be planned fails closed: with bash, unverifiable", async () => {
    routeAsRole(location(repo, "app-a"));
    vi.spyOn(perimeterModule, "planPerimeter").mockImplementation(() => {
      throw new Error("boom");
    });
    const hooks = await makePlugin();
    await pin(repo);
    const out = await runTask(hooks, `Implement it.\n${SYNC_DOD}`, async (h, sid) => {
      await runTool(h, sid, "bash", { command: "echo hi" });
      fs.writeFileSync(path.join(repo, "index.ts"), "export const v = 1;\n");
      await pin(repo);
    });
    expect(out).toMatch(/the verification perimeter could not be planned/);
    expect(out).toContain("UNVERIFIED");
  }, 60_000);

  it("QA-1 F11: another worktree of W's own repository changed with bash: I4 suggests branch=<b>", async () => {
    const wt = path.join(parent, "app-a-wt");
    execFileSync("git", ["worktree", "add", "-q", "-b", "feat-x", wt], { cwd: repo, stdio: "ignore" });
    addToWorkingSet("orch", location(wt, "app-a"));
    routeAsRole(location(repo, "app-a"));
    const hooks = await makePlugin();
    await pin(repo);
    await pin(wt);
    const out = await runTask(hooks, `Implement it.\n${SYNC_DOD}`, async (h, sid) => {
      await runTool(h, sid, "bash", { command: "echo hi" });
      fs.writeFileSync(path.join(wt, "index.ts"), "export const v = 2;\n");
      await pin(wt);
    });
    expect(out).toMatch(/Dispatch that work with branch=feat-x, or verify it there\./);
  }, 60_000);
});

describe("link pins at dispatch (P2.6)", () => {
  const TESTS_DOD = `[acceptance]\ncheck: testsPass command="npm test"\n[/acceptance]`;

  /** Pins `dir` as the router will see it: a real snapshot that also digests the ignored files. */
  async function pinWithIgnored(dir: string): Promise<void> {
    const keys = [seam.key(dir), seam.key(fs.realpathSync.native(dir))];
    for (const key of keys) seam.pins.delete(key);
    const { snapshotTree } = await vi.importActual<typeof import("../../src/verify/tree")>("../../src/verify/tree");
    const tree = await snapshotTree(dir, new AbortController().signal, { digestPaths: [], ignoredDigest: true });
    if (tree === undefined) throw new Error(`the real snapshot of ${dir} failed`);
    for (const key of keys) seam.pins.set(key, tree);
  }

  /** W (app-a) links lib-b through node_modules; `parents` is routing.repoParents as the perimeter reads it. */
  async function linked(parents: string[]): Promise<any> {
    for (const dir of [repo, lib]) execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: dir, stdio: "ignore" });
    routeAsRole(location(repo, "app-a"));
    const modules = path.join(repo, "node_modules");
    fs.mkdirSync(modules, { recursive: true });
    fs.symlinkSync(lib, path.join(modules, "lib-b"), "junction");
    const realPlan = perimeterModule.planPerimeter;
    vi.spyOn(perimeterModule, "planPerimeter").mockImplementation((id, cwd) => realPlan(id, cwd, () => ({ parents, depth: 1, exclude: [] })));
    const hooks = await makePlugin();
    await pin(repo);
    await pinWithIgnored(lib);
    return hooks;
  }

  /** The reference each required gate was given (GateDeps.deterministic.reference). */
  const gateReferences = (): unknown[] => acceptSpy.mock.calls.map(call => call[2]?.deterministic?.reference);
  const pinsOf = (reference: unknown): readonly { kind: string; root: string }[] | undefined => {
    const captured = reference as { kind?: string; reference?: { pins?: readonly { kind: string; root: string }[] } } | undefined;
    return captured?.kind === "captured" ? captured.reference?.pins : undefined;
  };

  it("an admitted linked repository is pinned at dispatch and the pin travels with the reference at the gate", async () => {
    const hooks = await linked([parent]);
    await runTask(hooks, `Implement it.\n${TESTS_DOD}`, async () => undefined);
    const pins = pinsOf(gateReferences()[0]);
    expect(pins?.map(pin => [pin.kind, seam.key(pin.root)])).toEqual([["pinned", seam.key(lib)]]);
  }, 90_000);

  it("an unadmitted link target gets no pin", async () => {
    const hooks = await linked([path.join(parent, "elsewhere")]);
    await runTask(hooks, `Implement it.\n${TESTS_DOD}`, async () => undefined);
    expect(pinsOf(gateReferences()[0])).toBeUndefined();
    expect(seam.calls).not.toContain(seam.key(lib));
  }, 90_000);

  it("a pin whose dispatch snapshot was discarded (contaminated) is dropped", async () => {
    const hooks = await linked([parent]);
    const tree = seam.pins.get(seam.key(lib)) as NonNullable<Tree>;
    let release: (value: Tree) => void = () => undefined;
    seam.pins.set(seam.key(lib), new Promise<Tree>(settle => {
      release = settle;
    }));
    seam.pins.set(seam.key(fs.realpathSync.native(lib)), seam.pins.get(seam.key(lib)));
    await runTask(hooks, `Implement it.\n${TESTS_DOD}`, async (h, sid) => {
      await runTool(h, sid, "bash", { command: "echo hi" }); // An unattributable writer while lib-b's snapshot is in flight.
      release(tree);
    });
    const reference = gateReferences()[0] as { kind?: string } | undefined;
    expect(reference?.kind).toBe("captured");
    expect(pinsOf(reference)).toBeUndefined();
  }, 90_000);

  /** Every key lib-b is snapshotted under (as given, and its native realpath). */
  const libKeys = (): Set<string> => new Set([seam.key(lib), seam.key(fs.realpathSync.native(lib))]);

  it("QA-2 #4: the perimeter snapshot of a link seed is the plain one (no ignoredDigest); the pin takes its own digested snapshot after it", async () => {
    const hooks = await linked([parent]);
    await runTask(hooks, `Implement it.\n${TESTS_DOD}`, async () => undefined);
    const keys = libKeys();
    const libCalls = seam.log.filter(call => keys.has(call.key));
    // The dispatch-time perimeter snapshot comes first and never digests the ignored files.
    expect(libCalls[0]?.digest).toBe(false);
    // The pin's own snapshot is the only digested one (the gate's perimeter snapshot is plain too).
    expect(libCalls.filter(call => call.digest)).toHaveLength(1);
    expect(libCalls.filter(call => !call.digest).length).toBeGreaterThanOrEqual(2);
    expect(pinsOf(gateReferences()[0])?.map(pin => [pin.kind, seam.key(pin.root)])).toEqual([["pinned", seam.key(lib)]]);
  }, 90_000);

  it("QA-2 #9c: an unattributable writer while the pin is still computed drops the pin; the settled perimeter snapshot is kept", async () => {
    const hooks = await linked([parent]);
    const tree = seam.pins.get(seam.key(lib)) as NonNullable<Tree>;
    let release: (value: Tree) => void = () => undefined;
    const held = new Promise<Tree>(settle => {
      release = settle;
    });
    // Only the pin's (digested) snapshot is held; the perimeter snapshot settles at once.
    for (const key of libKeys()) seam.digestPins.set(key, held);
    const out = await runTask(hooks, `Implement it.\n${TESTS_DOD}`, async (h, sid) => {
      await runTool(h, sid, "bash", { command: "echo hi" }); // An unattributable writer while lib-b's pin is in flight.
      release(tree);
    });
    const reference = gateReferences()[0] as { kind?: string } | undefined;
    expect(reference?.kind).toBe("captured");
    expect(pinsOf(reference)).toBeUndefined();
    // lib-b itself was observed (its dispatch snapshot was not discarded): only the pin was dropped.
    expect(out).not.toMatch(/could not be observed/);
    expect(await gateResults()).not.toMatch(/could not be observed/);
  }, 90_000);

  it("M3: a delegating tool (task) while the pin is still computed keeps the pin", async () => {
    const hooks = await linked([parent]);
    const tree = seam.pins.get(seam.key(lib)) as NonNullable<Tree>;
    let release: (value: Tree) => void = () => undefined;
    const held = new Promise<Tree>(settle => {
      release = settle;
    });
    for (const key of libKeys()) seam.digestPins.set(key, held);
    await runTask(hooks, `Implement it.\n${TESTS_DOD}`, async (h, sid) => {
      await runTool(h, sid, "task", { subagent_type: "fast", prompt: "look around", description: "nested" }); // Delegates; writes nothing itself.
      release(tree);
    });
    expect(pinsOf(gateReferences()[0])?.map(pin => [pin.kind, seam.key(pin.root)])).toEqual([["pinned", seam.key(lib)]]);
  }, 90_000);

  it("QA-2 #9c: a writer that ran after the pin settled leaves the pin in place", async () => {
    const hooks = await linked([parent]);
    await runTask(hooks, `Implement it.\n${TESTS_DOD}`, async (h, sid) => {
      // Let the pin (resolved by the seam at once) settle before the writer runs.
      for (let i = 0; i < 20; i++) await new Promise<void>(settle => setImmediate(settle));
      await runTool(h, sid, "bash", { command: "echo hi" });
    });
    expect(pinsOf(gateReferences()[0])?.map(pin => [pin.kind, seam.key(pin.root)])).toEqual([["pinned", seam.key(lib)]]);
  }, 90_000);

  it("QA-2 nit: a dispatch's pins are freed once its gate took them; materialize pins as that gate's dispatch admitted", async () => {
    await linked([parent]);
    const opener = vi.spyOn(deterministicModule, "createScopeOpener");
    const { createVerificationWiring } = await import("../../src/verify/wiring");
    const cfg = loadConfig(repo);
    const wiring = createVerificationWiring({ client: {}, directory: repo, getConfig: () => cfg, logger: { warn: () => {} } });
    const store = createChangedFileStore();
    const dod: DoD = { kind: "deterministic", source: "explicit", criteria: [], deliverable: null, checks: [{ kind: "testsPass", command: "npm test" }] };
    // The routed role dispatch's id (`task:<orchestrator>:<callID>`, routeAsRole), so its perimeter is planned (I9).
    const id = "task:orch:call1";
    await wiring.beginVerification(store, id, repo, dod);
    const first = await wiring.prepareVerification(store, id, id);
    expect(first.reference.kind).toBe("captured");
    const taken = pinsOf(first.reference) ?? [];
    expect(taken.map(pin => [pin.kind, seam.key(pin.root)])).toEqual([["pinned", seam.key(lib)]]);
    // Freed: the same dispatch's next gate finds none left (its reference is still captured).
    const second = await wiring.prepareVerification(store, id, id);
    expect(second.reference.kind).toBe("captured");
    expect(pinsOf(second.reference)).toBeUndefined();
    // Materialize pins as the gate's own dispatch admitted (keyed by its pins), not by a set shared across dispatches.
    wiring.buildGateDeps(undefined, undefined, first);
    const withPins = opener.mock.calls.at(-1)?.[0].reference?.pinNow;
    wiring.buildGateDeps(undefined, undefined, second);
    const withoutPins = opener.mock.calls.at(-1)?.[0].reference?.pinNow;
    const dispatchPin = taken[0] as LinkPin | undefined;
    expect(withPins).toBeTypeOf("function");
    expect(withoutPins).toBeTypeOf("function");
    if (dispatchPin === undefined || withPins === undefined || withoutPins === undefined) return;
    expect(samePin(dispatchPin, await withPins(dispatchPin.root))).toBe(true);
    expect((await withoutPins(dispatchPin.root)).kind).not.toBe("pinned");
  }, 90_000);

  // S7 (the full recheck needs a recognised test runner in the temp repo, which this harness does not install): the dispatch pin
  // and the materialize-time pin are compared as reference.ts step 7 does. `pinNow` is what createScopeOpener hands materialize.
  it("S7: materialize is given a pinNow; it matches the dispatch pin while the linked repository is unchanged, not once it changed", async () => {
    const opener = vi.spyOn(deterministicModule, "createScopeOpener");
    const hooks = await linked([parent]);
    await runTask(hooks, `Implement it.\n${TESTS_DOD}`, async () => undefined);
    const dispatchPin = (pinsOf(gateReferences()[0]) ?? [])[0] as LinkPin | undefined;
    expect(dispatchPin?.kind).toBe("pinned");
    const pinNow = opener.mock.calls.at(-1)?.[0].reference?.pinNow;
    expect(pinNow).toBeTypeOf("function");
    if (dispatchPin === undefined || pinNow === undefined) return;

    // Unchanged: the same pin, so the reference stays exact (no external-link cause).
    expect(samePin(dispatchPin, await pinNow(dispatchPin.root))).toBe(true);

    // Changed during the dispatch (a tracked file, then an ignored one): not the same pin, so external-link / approximate.
    fs.writeFileSync(path.join(lib, "index.ts"), "export const b = 1;\n");
    await pinWithIgnored(lib);
    expect(samePin(dispatchPin, await pinNow(dispatchPin.root))).toBe(false);
  }, 90_000);

  it("QA-1 #9a: a working-set root that is also W's link target is pinned, and stays a working-set root", async () => {
    addToWorkingSet("orch", location(lib, "lib-b"));
    const hooks = await linked([parent]);
    const planned = perimeterModule.planPerimeter("task:orch:call1", repo, () => ({ parents: [parent], depth: 1, exclude: [] }));
    expect(planned?.roots.map(seed => [seam.key(seed.at), seed.origin, seed.linked])).toEqual([[seam.key(lib), "working-set", true]]);
    await runTask(hooks, `Implement it.\n${TESTS_DOD}`, async () => undefined);
    expect(pinsOf(gateReferences()[0])?.map(pin => [pin.kind, seam.key(pin.root)])).toEqual([["pinned", seam.key(lib)]]);
  }, 90_000);

  it("a tier dispatch (no role, no perimeter) carries no pins", async () => {
    for (const dir of [repo, lib]) execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: dir, stdio: "ignore" });
    const modules = path.join(repo, "node_modules");
    fs.mkdirSync(modules, { recursive: true });
    fs.symlinkSync(lib, path.join(modules, "lib-b"), "junction");
    const hooks = await makePlugin();
    await pin(repo);
    await runTask(hooks, `Implement it.\n${TESTS_DOD}`, async () => undefined);
    expect(pinsOf(gateReferences()[0])).toBeUndefined();
    expect(seam.calls).not.toContain(seam.key(lib));
  }, 90_000);
});

describe("deferred P (P2e)", () => {
  /** The plugin's pending registry (createPendingRegistry spied before the plugin is built). */
  let registry: ReturnType<typeof pendingModule.createPendingRegistry> | undefined;
  /** The plugin's change store's `clear` (createChangedFileStore spied before the plugin is built). */
  let clearSpy: MockInstance | undefined;
  const watchPlugin = (): void => {
    registry = undefined;
    clearSpy = undefined;
    const realRegistry = pendingModule.createPendingRegistry;
    vi.spyOn(pendingModule, "createPendingRegistry").mockImplementation((...args) => {
      registry = realRegistry(...args);
      return registry;
    });
    const realStore = storeModule.createChangedFileStore;
    vi.spyOn(storeModule, "createChangedFileStore").mockImplementation((...args) => {
      const store = realStore(...args);
      clearSpy = vi.spyOn(store, "clear");
      return store;
    });
  };
  const entryOf = (handle: string) => {
    const found = registry?.get("orch", handle);
    if (found?.kind !== "found") throw new Error(`no pending entry ${handle}`);
    return found.entry;
  };
  const verify = async (hooks: any, handle: string): Promise<string> =>
    hooks.tool.router_verify.execute({ handles: [handle] }, { sessionID: "orch" });
  const outcomeOf = (out: string, handle: string): string | undefined =>
    new RegExp(`^- ${handle} \u00b7 .* \u00b7 (pass|fail|unverifiable)`, "m").exec(out)?.[1];
  const S11_CHANGED = /the linked repository lib-b at \S+ changed since the producer returned; the checks ran against its new state/;
  const ROUTER_SCOPE_LINE = /verified scope: app-a \([^ ()]+ @ [0-9a-f]{7}\); also observed: lib-b \([^ ()]+ @ [0-9a-f]{7}\)/;

  /** Pins `dir` as the router will see it: a real snapshot that also digests the ignored files. */
  async function pinWithIgnored(dir: string): Promise<void> {
    const keys = [seam.key(dir), seam.key(fs.realpathSync.native(dir))];
    for (const key of keys) seam.pins.delete(key);
    const { snapshotTree } = await vi.importActual<typeof import("../../src/verify/tree")>("../../src/verify/tree");
    const tree = await snapshotTree(dir, new AbortController().signal, { digestPaths: [], ignoredDigest: true });
    if (tree === undefined) throw new Error(`the real snapshot of ${dir} failed`);
    for (const key of keys) seam.pins.set(key, tree);
  }
  /** W is app-a; lib-b is in the orchestrator's working set (not a link). */
  async function crossRepo(): Promise<any> {
    watchPlugin();
    addToWorkingSet("orch", location(lib, "lib-b"));
    routeAsRole(location(repo, "app-a"));
    const hooks = await makePlugin();
    await pin(repo);
    await pin(lib);
    return hooks;
  }
  /** W (app-a) links lib-b through node_modules (an admitted link target); lib-b is not in the working set. */
  async function linked(): Promise<any> {
    watchPlugin();
    for (const dir of [repo, lib]) execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: dir, stdio: "ignore" });
    routeAsRole(location(repo, "app-a"));
    const modules = path.join(repo, "node_modules");
    fs.mkdirSync(modules, { recursive: true });
    fs.symlinkSync(lib, path.join(modules, "lib-b"), "junction");
    const realPlan = perimeterModule.planPerimeter;
    vi.spyOn(perimeterModule, "planPerimeter").mockImplementation((id, cwd) => realPlan(id, cwd, () => ({ parents: [parent], depth: 1, exclude: [] })));
    const hooks = await makePlugin();
    await pin(repo);
    await pinWithIgnored(lib);
    return hooks;
  }
  /** lib-b's tracked file changes; the changed tree is pinned (with its ignored digest, as a link target is seen). */
  const changeLib = async (): Promise<void> => {
    fs.writeFileSync(path.join(lib, "index.ts"), "export const b = 1;\n");
    await pinWithIgnored(lib);
  };
  /** The deferred handle in a dispatch's output, or the test fails showing the output. */
  const handleIn = (out: string): string => {
    const handle = HANDLE.exec(out)?.[0];
    if (handle === undefined) throw new Error(`not deferred:\n${out}`);
    return handle;
  };

  afterEach(() => {
    // The junction is removed itself (never recursed through) before the temporary trees.
    const junction = path.join(repo, "node_modules", "lib-b");
    if (fs.existsSync(junction)) fs.rmSync(junction, { recursive: false, force: true });
  });

  it("I4 at return → not deferred (cross-repo), required gate gives the I4 reason", async () => {
    const hooks = await crossRepo();
    const out = await runTask(hooks, `Implement it.\n${DEFERRED_DOD}`, async (h, sid) => {
      await runTool(h, sid, "bash", { command: "echo hi" });
      fs.writeFileSync(path.join(lib, "index.ts"), "export const b = 1;\n");
      await pin(lib);
    });
    expect(HANDLE.exec(out)?.[0], out).toBeUndefined();
    expect(out).toMatch(I4_REASON("bash"));
    expect(artefacts()).toHaveLength(1);
  }, 90_000);

  it("a link unobserved at return → required gate", async () => {
    const hooks = await linked();
    const out = await runTask(hooks, `Implement it.\n${DEFERRED_DOD}`, async () => {
      // From now on lib-b cannot be snapshotted (the return-time observation, and the required gate's).
      for (const key of [seam.key(lib), seam.key(fs.realpathSync.native(lib))]) seam.pins.set(key, Promise.resolve(undefined));
    });
    expect(HANDLE.exec(out)?.[0], out).toBeUndefined();
    expect(artefacts()).toHaveLength(1);
    expect(artefacts()[0]?.perimeter?.roots.map(root => [root.name, root.status])).toEqual([["lib-b", "unobserved"]]);
  }, 90_000);

  it("S11 end to end: deferred, lib changes after return, router_verify → UNVERIFIED with the S11 caveat", async () => {
    const hooks = await linked();
    const handle = handleIn(await runTask(hooks, `Implement it.\n${DEFERRED_DOD}`, async () => undefined));
    expect(artefacts()).toHaveLength(0);
    await changeLib();
    const out = await verify(hooks, handle);
    expect(outcomeOf(out, handle), out).toBe("unverifiable");
    expect(out).toMatch(S11_CHANGED);
  }, 90_000);

  it("S11 control: lib unchanged → ✓ verified with the scope line", async () => {
    const hooks = await linked();
    const handle = handleIn(await runTask(hooks, `Implement it.\n${DEFERRED_DOD}`, async () => undefined));
    const out = await verify(hooks, handle);
    expect(outcomeOf(out, handle), out).toBe("pass");
    expect(out).toContain("✓ verified");
    expect(out).toMatch(ROUTER_SCOPE_LINE);
    expect(out).not.toMatch(/the linked repository /);
  }, 90_000);

  it("pins reach router_verify (same array)", async () => {
    const hooks = await linked();
    const handle = handleIn(await runTask(hooks, `Implement it.\n${DEFERRED_DOD}`, async () => undefined));
    const frozenPins = await entryOf(handle).perimeter?.pins;
    expect(frozenPins?.map(pin => [pin.kind, seam.key(pin.root)])).toEqual([["pinned", seam.key(lib)]]);
    await verify(hooks, handle);
    const reference = acceptSpy.mock.calls.at(-1)?.[2]?.deterministic?.reference;
    expect(reference?.kind).toBe("captured");
    if (reference?.kind === "captured") expect(reference.reference.pins).toBe(frozenPins);
  }, 90_000);

  it("I9: no perimeter → no extra snapshot and no perimeter key", async () => {
    watchPlugin();
    routeAsRole();
    const hooks = await makePlugin();
    await pin(repo);
    seam.calls.length = 0;
    seam.hardened.length = 0;
    const handle = handleIn(await runTask(hooks, `Implement it.\n${DEFERRED_DOD}`, async () => undefined));
    expect(seam.calls).not.toContain(seam.key(lib));
    expect(seam.hardened).toEqual([]);
    const entry = entryOf(handle);
    expect("perimeter" in entry).toBe(false);
    expect("placements" in entry).toBe(false);
  }, 90_000);

  it("the frozen perimeter survives store.clear", async () => {
    const hooks = await crossRepo();
    const handle = handleIn(await runTask(hooks, `Implement it.\n${DEFERRED_DOD}`, async () => undefined));
    // The dispatch record goes once its reference settled (finishDeferred's finally).
    await vi.waitFor(() => expect(clearSpy?.mock.calls.length ?? 0).toBeGreaterThan(0), { timeout: 30_000 });
    expect(entryOf(handle).perimeter?.observation.roots.map(root => [root.name, root.status])).toEqual([["lib-b", "unchanged"]]);
    const out = await verify(hooks, handle);
    expect(outcomeOf(out, handle), out).toBe("pass");
    expect(out).toMatch(ROUTER_SCOPE_LINE);
    expect(artefacts().at(-1)?.perimeter?.roots.map(root => [root.name, root.status])).toEqual([["lib-b", "unchanged"]]);
  }, 90_000);
});

describe("consumer discovery (§6)", () => {
  /** Every link made here; removed one by one (never a recursive delete through a junction). */
  const links: string[] = [];
  const link = (target: string, at: string): void => {
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.symlinkSync(target, at, "junction");
    links.push(at);
  };
  afterEach(() => {
    for (const at of links.splice(0).reverse()) {
      try {
        fs.unlinkSync(at);
      } catch {
        try {
          fs.rmdirSync(at);
        } catch {
          // Already gone.
        }
      }
    }
  });

  const NONE = { consumers: [], incomplete: [] };

  it("a working-set worktree whose node_modules junction resolves into W is a consumer (plain and @scope entries)", async () => {
    fs.mkdirSync(path.join(repo, "packages", "core"), { recursive: true });
    link(repo, path.join(lib, "node_modules", "app-a"));
    expect(await perimeterModule.discoverConsumers(repo, [{ root: lib, name: "lib-b" }]))
      .toEqual({ consumers: [{ root: lib, name: "lib-b", entry: "app-a" }], incomplete: [] });
    // A link into a directory below W counts too, and a scoped entry is named with its scope.
    const other = path.join(parent, "lib-c");
    fs.mkdirSync(other, { recursive: true });
    link(path.join(repo, "packages", "core"), path.join(other, "node_modules", "@scope", "core"));
    expect(await perimeterModule.discoverConsumers(repo, [{ root: other }]))
      .toEqual({ consumers: [{ root: other, entry: "@scope/core" }], incomplete: [] });
  });

  it("a link into another worktree of W's repository is not a consumer; W itself is never scanned", async () => {
    const wt = path.join(parent, "app-a-wt");
    execFileSync("git", ["worktree", "add", "-q", "-b", "feat-c", wt], { cwd: repo, stdio: "ignore" });
    link(wt, path.join(lib, "node_modules", "app-a"));
    expect(await perimeterModule.discoverConsumers(repo, [{ root: lib, name: "lib-b" }])).toEqual(NONE);
    link(lib, path.join(repo, "node_modules", "lib-b"));
    link(repo, path.join(repo, "node_modules", "self"));
    // W itself is never scanned, nor reported incomplete (even with no budget).
    expect(await perimeterModule.discoverConsumers(repo, [{ root: repo, name: "app-a" }])).toEqual(NONE);
    expect(await perimeterModule.discoverConsumers(repo, [{ root: repo, name: "app-a" }], { maxEntries: 0 })).toEqual(NONE);
  }, 60_000);

  it("only working-set roots are scanned: a link target of W and a repository outside the working set are not consumers", async () => {
    // lib-b is a link target of W (origin "link") that links back into W; lib-c is outside the working set and links into W.
    link(lib, path.join(repo, "node_modules", "lib-b"));
    link(repo, path.join(lib, "node_modules", "app-a"));
    const outside = path.join(parent, "lib-c");
    fs.mkdirSync(outside, { recursive: true });
    link(repo, path.join(outside, "node_modules", "app-a"));
    routeAsRole(location(repo, "app-a"));
    const linked = planPerimeter("task:orch:call1", repo, () => ({ parents: [parent], depth: 1, exclude: [] }));
    expect(linked?.roots.map(seed => [seam.key(seed.at), seed.origin])).toEqual([[seam.key(lib), "link"]]);
    const workingSetRoots = (plan: typeof linked): { root: string; name?: string }[] => (plan?.roots ?? [])
      .filter(seed => seed.origin === "working-set")
      .map(seed => ({ root: seed.at, ...(seed.name !== undefined ? { name: seed.name } : {}) }));
    expect(await perimeterModule.discoverConsumers(repo, workingSetRoots(linked))).toEqual(NONE);
    // In the working set, lib-b is scanned and is a consumer; lib-c, outside it, is still not.
    addToWorkingSet("orch", location(lib, "lib-b"));
    const planned = planPerimeter("task:orch:call1", repo, () => ({ parents: [parent], depth: 1, exclude: [] }));
    expect(planned?.roots.map(seed => [seam.key(seed.at), seed.origin])).toEqual([[seam.key(lib), "working-set"]]);
    expect(await perimeterModule.discoverConsumers(repo, workingSetRoots(planned)))
      .toEqual({ consumers: [{ root: lib, name: "lib-b", entry: "app-a" }], incomplete: [] });
  });

  it("store-like links and dot-entries are skipped", async () => {
    const store = path.join(repo, "node_modules", ".pnpm", "pkg@1.0.0", "node_modules", "pkg");
    fs.mkdirSync(store, { recursive: true });
    link(store, path.join(lib, "node_modules", "pkg"));
    link(repo, path.join(lib, "node_modules", ".cache"));
    link(repo, path.join(lib, "node_modules", "@scope", ".hidden"));
    expect(await perimeterModule.discoverConsumers(repo, [{ root: lib, name: "lib-b" }])).toEqual(NONE);
  });

  it("an unreadable or missing node_modules yields no consumer, and never throws", async () => {
    fs.writeFileSync(path.join(lib, "node_modules"), "not a directory\n");
    const missing = path.join(parent, "missing");
    expect(await perimeterModule.discoverConsumers(repo, [{ root: lib, name: "lib-b" }, { root: missing }])).toEqual(NONE);
  });

  it("end to end (D6): a working-set consumer of W with no check there makes a pass UNVERIFIED; with no change it stays a pass", async () => {
    link(repo, path.join(lib, "node_modules", "app-a"));
    addToWorkingSet("orch", location(lib, "lib-b"));
    routeAsRole(location(repo, "app-a"));
    const hooks = await makePlugin();
    await pin(repo);
    await pin(lib);
    const caveat = /lib-b at (\S+) links this work root \(node_modules\/app-a\) and no check ran there; add a check such as: check: testsPass cwd="([^"]+)" scope=full/;
    const unchanged = await runTask(hooks, `Implement it.\n${SYNC_DOD}`, async () => undefined);
    expect(unchanged).toContain("✓ verified");
    expect(unchanged).not.toMatch(caveat);
    const out = await runTask(hooks, `Implement it.\n${SYNC_DOD}`, async () => {
      fs.writeFileSync(path.join(repo, "index.ts"), "export const v = 1;\n");
      await pin(repo);
    });
    expect(out).toContain("UNVERIFIED");
    expect(out).not.toContain("✓ verified");
    const named = caveat.exec(out);
    expect(seam.key(named?.[1] ?? "")).toBe(seam.key(lib));
    expect(seam.key(named?.[2] ?? "")).toBe(seam.key(lib));
    expect(artefacts()[1]?.perimeter?.consumers?.map(consumer => [seam.key(consumer.root), consumer.name, consumer.entry]))
      .toEqual([[seam.key(lib), "lib-b", "app-a"]]);
  }, 90_000);

  // QA-1 #2: the scan budget is per root, a root stopped on it is incomplete (the old test, "past the bound, scanning stops", read
  // the budget as shared by all roots: lib-c was never read; it no longer is).
  it("QA-1 #2: the scan budget is per root; a root that stops on it without a consumer is reported incomplete", async () => {
    // M2: only link entries spend the budget, so lib-b's three entries are links to a directory outside W.
    const elsewhere = path.join(parent, "elsewhere");
    fs.mkdirSync(elsewhere, { recursive: true });
    for (const name of ["a", "b", "c"]) link(elsewhere, path.join(lib, "node_modules", name));
    const second = path.join(parent, "lib-c");
    link(repo, path.join(second, "node_modules", "app-a"));
    const roots = [{ root: lib, name: "lib-b" }, { root: second, name: "lib-c" }];
    const found = { root: second, name: "lib-c", entry: "app-a" };
    // lib-b's three entries fit the bound exactly: complete, and lib-c is read with a budget of its own.
    expect(await perimeterModule.discoverConsumers(repo, roots, { maxEntries: 3 })).toEqual({ consumers: [found], incomplete: [] });
    expect(await perimeterModule.discoverConsumers(repo, roots)).toEqual({ consumers: [found], incomplete: [] });
    // One entry too few for lib-b: incomplete, but lib-c (one entry) is still scanned.
    expect(await perimeterModule.discoverConsumers(repo, roots, { maxEntries: 2 }))
      .toEqual({ consumers: [found], incomplete: [{ root: lib, name: "lib-b" }] });
    // No budget at all: a root with entries is incomplete, a root with no node_modules is not. W's own name ("app-a", W's
    // package.json) is looked up outside the budget, so lib-c is still found.
    expect(await perimeterModule.discoverConsumers(repo, [...roots, { root: path.join(parent, "missing") }], { maxEntries: 0 }))
      .toEqual({ consumers: [found], incomplete: [{ root: lib, name: "lib-b" }] });
  });

  it("M2: plain package directories do not spend the scan budget; a consumer link past them is found", async () => {
    const modules = path.join(lib, "node_modules");
    for (let i = 0; i < 3000; i++) fs.mkdirSync(path.join(modules, `plain-${String(i).padStart(4, "0")}`), { recursive: true });
    link(repo, path.join(modules, "zz-consumer"));
    expect(await perimeterModule.discoverConsumers(repo, [{ root: lib, name: "lib-b" }], { maxEntries: 2000 }))
      .toEqual({ consumers: [{ root: lib, name: "lib-b", entry: "zz-consumer" }], incomplete: [] });
    // No consumer at all: plain directories alone never make the root incomplete.
    fs.unlinkSync(path.join(modules, "zz-consumer"));
    expect(await perimeterModule.discoverConsumers(repo, [{ root: lib, name: "lib-b" }], { maxEntries: 2000 })).toEqual(NONE);
  }, 60_000);

  it("M2: more link entries than the budget with the consumer link past it is incomplete", async () => {
    const elsewhere = path.join(parent, "elsewhere");
    fs.mkdirSync(elsewhere, { recursive: true });
    const modules = path.join(lib, "node_modules");
    for (const name of ["l1", "l2", "l3"]) link(elsewhere, path.join(modules, name));
    link(repo, path.join(modules, "zz-consumer"));
    expect(await perimeterModule.discoverConsumers(repo, [{ root: lib, name: "lib-b" }], { maxEntries: 3 }))
      .toEqual({ consumers: [], incomplete: [{ root: lib, name: "lib-b" }] });
    expect(await perimeterModule.discoverConsumers(repo, [{ root: lib, name: "lib-b" }], { maxEntries: 4 }))
      .toEqual({ consumers: [{ root: lib, name: "lib-b", entry: "zz-consumer" }], incomplete: [] });
  });

  it("M2: the hard cap on all entries read per root reports the root incomplete", async () => {
    const modules = path.join(lib, "node_modules");
    for (let i = 0; i < 6; i++) fs.mkdirSync(path.join(modules, `plain-${i}`), { recursive: true });
    expect(await perimeterModule.discoverConsumers(repo, [{ root: lib, name: "lib-b" }], { maxRead: 6 })).toEqual(NONE);
    expect(await perimeterModule.discoverConsumers(repo, [{ root: lib, name: "lib-b" }], { maxRead: 5 }))
      .toEqual({ consumers: [], incomplete: [{ root: lib, name: "lib-b" }] });
    expect(perimeterModule.CONSUMER_READ_MAX).toBe(20000);
  });

  it("QA-1 #2: W's package name is looked up directly, past the scan budget", async () => {
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "app-direct" }));
    for (const name of ["a", "b", "c"]) fs.mkdirSync(path.join(lib, "node_modules", name), { recursive: true });
    link(repo, path.join(lib, "node_modules", "app-direct"));
    expect(await perimeterModule.discoverConsumers(repo, [{ root: lib, name: "lib-b" }], { maxEntries: 0 }))
      .toEqual({ consumers: [{ root: lib, name: "lib-b", entry: "app-direct" }], incomplete: [] });
  });

  it("QA-1 #2: a scoped package name is looked up directly", async () => {
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "@acme/app-a" }));
    for (const name of ["a", "b", "c"]) fs.mkdirSync(path.join(lib, "node_modules", name), { recursive: true });
    link(repo, path.join(lib, "node_modules", "@acme", "app-a"));
    expect(await perimeterModule.discoverConsumers(repo, [{ root: lib, name: "lib-b" }], { maxEntries: 0 }))
      .toEqual({ consumers: [{ root: lib, name: "lib-b", entry: "@acme/app-a" }], incomplete: [] });
  });

  it("QA-1 #2: the names of W's workspace packages are looked up directly", async () => {
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "root", workspaces: ["packages/*"] }));
    const core = path.join(repo, "packages", "core");
    fs.mkdirSync(core, { recursive: true });
    fs.writeFileSync(path.join(core, "package.json"), JSON.stringify({ name: "@ws/core" }));
    for (const name of ["a", "b", "c"]) fs.mkdirSync(path.join(lib, "node_modules", name), { recursive: true });
    link(core, path.join(lib, "node_modules", "@ws", "core"));
    expect(await perimeterModule.discoverConsumers(repo, [{ root: lib, name: "lib-b" }], { maxEntries: 0 }))
      .toEqual({ consumers: [{ root: lib, name: "lib-b", entry: "@ws/core" }], incomplete: [] });
  });

  it("QA-1 #13: at the gate deadline the roots not finished are incomplete", async () => {
    const second = path.join(parent, "lib-c");
    link(repo, path.join(second, "node_modules", "app-a"));
    const roots = [{ root: lib, name: "lib-b" }, { root: second, name: "lib-c" }, { root: repo, name: "app-a" }];
    const controller = new AbortController();
    controller.abort();
    // W itself is never scanned, so never incomplete; the two others were not finished.
    expect(await perimeterModule.discoverConsumers(repo, roots, { signal: controller.signal }))
      .toEqual({ consumers: [], incomplete: [{ root: lib, name: "lib-b" }, { root: second, name: "lib-c" }] });
  });

  it("QA-1 #3: a link whose text is a UNC or device path is never realpath'ed", async () => {
    const real = fs.realpathSync.native(lib);
    const unc = "\\\\attacker\\share\\pkg";
    const lstatOf = { isSymbolicLink: (): boolean => true };
    fs.mkdirSync(path.join(repo, "node_modules", "lib-b"), { recursive: true });
    fs.mkdirSync(path.join(repo, "node_modules", "lib-c"), { recursive: true });
    const realpaths: string[] = [];
    const io: perimeterModule.LinkIO = {
      lstat: () => lstatOf,
      readlink: (p) => (p.endsWith("lib-b") ? unc : p.endsWith("lib-c") ? "//server/share" : real),
      realpath: (p) => {
        realpaths.push(p);
        return real;
      },
    };
    expect(perimeterModule.linkedTargets(repo, io)).toEqual([]);
    expect(realpaths).toEqual([]);
    expect(perimeterModule.isUncLinkText("\\\\?\\C:\\x")).toBe(true);
    expect(perimeterModule.isUncLinkText("C:\\x")).toBe(false);
  });
});
