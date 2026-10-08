import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dirname, join, resolve } from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { awaitBounded, COMMIT_DIFF_TIMEOUT_MS, createVerificationWiring, DISPOSED_MEMO_MAX, REFERENCE_GC_START_DELAY_MS, TEST_SEARCH_TIMEOUT_MS } from "../../src/verify/wiring";
import { resolveVerifyBudget } from "../../src/router/config";
import type { Deadline } from "../../src/verify/types";
import { createHash } from "node:crypto";
import { ABSENT_DIGEST, createChangedFileStore, type TreeSnapshot } from "../../src/verify/dispatch";
import { accept } from "../../src/verify/gate";
import { REFERENCE_NONE } from "../../src/verify/baseline";
import type { RouterConfig } from "../../src/router/config";
import type { DoD } from "../../src/verify/dod";
import type { DispatchReference } from "../../src/verify/reference";
import type { TestsPassRequest } from "../../src/verify/types";

const state = vi.hoisted(() => ({
  snapshot: undefined as TreeSnapshot | undefined,
  commands: [] as string[],
  captures: [] as { cwd: string; timeoutMs: number | undefined }[],
  captureResult: undefined as unknown,
  held: false, finish: undefined as (() => void) | undefined,
  /** When set, the capture settles after this many (fake) ms; captureThrows rejects instead. */
  captureDelayMs: undefined as number | undefined, captureThrows: false,
  gcCalls: [] as string[], gcRejects: false,
  /** What gcStaleReferences resolves with; gcArgv makes it spawn one git through its argv seam first. */
  gcRemoved: [] as string[], gcArgv: false,
  /** Replaces the snapshotTree mock when set. */
  snapshotImpl: undefined as ((cwd: string, signal: AbortSignal, options?: import("../../src/verify/tree").SnapshotOptions) => Promise<TreeSnapshot | undefined>) | undefined,
  /** Replaces the runArgv result when set (the call is still recorded). */
  argvImpl: undefined as ((file: string, args: readonly string[], opts: ExecOpts) => Promise<ExecOut>) | undefined,
  execOpts: [] as ExecOpts[],
  /** The argv seam handed to the last captureReference call. */
  captureArgv: undefined as ArgvFn | undefined,
  /** The deps handed to the last createDirectTestsPassHook call. */
  hookDeps: undefined as import("../../src/verify/deterministic").DirectTestsPassHookDeps | undefined,
  /** The deps handed to the last createScopeOpener call (the RunnerFs, argv and exec seams). */
  scopeDeps: undefined as import("../../src/verify/deterministic").ScopeOpenerDeps | undefined,
}));
type ExecOpts = { cwd?: string; timeoutMs?: number; signal?: AbortSignal; lowPriority?: boolean; env?: Record<string, string | undefined> };
type ExecOut = { code: number; stdout: string; stderr: string; timedOut: boolean };
type ArgvFn = (file: string, args: readonly string[], opts?: ExecOpts) => Promise<ExecOut>;
vi.mock("../../src/verify/tree", () => ({
  snapshotTree: async (cwd: string, signal: AbortSignal, options?: import("../../src/verify/tree").SnapshotOptions) =>
    (state.snapshotImpl ? state.snapshotImpl(cwd, signal, options) : state.snapshot),
}));
// G6: no process may run at dispatch time; any shell or argv spawn is recorded and fails the assertion.
vi.mock("../../src/verify/exec", () => ({
  runShell: async (command: string, opts: ExecOpts) => { state.commands.push(command); state.execOpts.push(opts); return { code: 0, stdout: "", stderr: "", timedOut: false }; },
  runArgv: async (file: string, args: readonly string[], opts: ExecOpts) => {
    state.commands.push([file, ...args].join(" ")); state.execOpts.push(opts);
    return state.argvImpl ? state.argvImpl(file, args, opts) : { code: 0, stdout: "", stderr: "", timedOut: false };
  },
}));
vi.mock("../../src/verify/deterministic", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/verify/deterministic")>();
  return {
    ...actual,
    createDirectTestsPassHook: (deps: import("../../src/verify/deterministic").DirectTestsPassHookDeps) => {
      state.hookDeps = deps;
      return actual.createDirectTestsPassHook(deps);
    },
    createScopeOpener: (deps: import("../../src/verify/deterministic").ScopeOpenerDeps) => {
      state.scopeDeps = deps;
      return actual.createScopeOpener(deps);
    },
  };
});
vi.mock("../../src/verify/reference", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/verify/reference")>()),
  captureReference: (at: string, _signal: AbortSignal, deps: { timeoutMs?: number; argv: ArgvFn }) => new Promise((resolve, reject) => {
    state.captures.push({ cwd: at, timeoutMs: deps.timeoutMs });
    state.captureArgv = deps.argv;
    const finish = () => (state.captureThrows ? reject(new Error("capture exploded")) : resolve(state.captureResult));
    if (state.captureDelayMs !== undefined) setTimeout(finish, state.captureDelayMs);
    else if (state.held) state.finish = finish; else finish();
  }),
  gcStaleReferences: async (root: string, deps: { argv: ArgvFn }) => {
    state.gcCalls.push(root);
    if (state.gcArgv) await deps.argv("git", ["worktree", "prune"], { cwd: root });
    if (state.gcRejects) throw new Error("gc exploded");
    return { removed: state.gcRemoved, kept: [], failed: [] };
  },
}));
const cwd = resolve("baseline-wiring-project");
const dod: DoD = { kind: "deterministic", source: "explicit", criteria: [], deliverable: null, checks: [{ kind: "testsPass", command: "pnpm test" }] };
const REF: DispatchReference = { root: cwd, head: "HEAD", commit: "HEAD", untracked: new Map(), tracked: new Map(), captureReasons: [], capturedAt: 0 };
beforeEach(() => Object.assign(state, {
  // Like snapshotTree, it digests its listed paths (QA-2.1-2).
  snapshot: { cwd, head: "HEAD", fingerprint: "before", dirty: true, files: [{ path: resolve(cwd, "old.ts"), status: " M" }], digests: new Map([[resolve(cwd, "old.ts"), "file:old"]]) },
  commands: [], captures: [], captureResult: REF, held: false, finish: undefined,
  captureDelayMs: undefined, captureThrows: false, gcCalls: [], gcRejects: false,
  gcRemoved: [], gcArgv: false, snapshotImpl: undefined, argvImpl: undefined, execOpts: [], captureArgv: undefined, hookDeps: undefined, scopeDeps: undefined,
}));
function harness() {
  const cfg: RouterConfig = { activePreset: "a", presets: { a: { medium: { model: "p/m" } } }, defaultTier: "medium", rules: [], enforcement: { verify: { baselineTimeoutMs: 1234 } } };
  const wiring = createVerificationWiring({ client: {}, directory: cwd, getConfig: () => cfg });
  const store = createChangedFileStore();
  return { cfg, wiring, store };
}
// Real git on a loaded Windows runner outlasts the 5 s default.
const REAL_GIT_TIMEOUT_MS = 60_000;

describe("tree snapshot against a real git repository", { timeout: REAL_GIT_TIMEOUT_MS }, () => {
  const withRepo = async (body: (repo: string) => Promise<void>) => {
    const repo = mkdtempSync(join(tmpdir(), "omr-tree-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, windowsHide: true });
    try {
      git("init", "-q");
      git("config", "user.email", "t@example.invalid"); git("config", "user.name", "t");
      git("config", "commit.gpgsign", "false");
      mkdirSync(join(repo, "sub"));
      writeFileSync(join(repo, "a.test.ts"), "export const a = 1;\n");
      writeFileSync(join(repo, "sub", "keep.ts"), "export {};\n");
      git("add", "-A"); git("commit", "-q", "-m", "init");
      git("mv", "a.test.ts", "b.test.ts");
      await body(repo);
    } finally {
      rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  };
  const real = () => vi.importActual<typeof import("../../src/verify/tree")>("../../src/verify/tree");

  it("records the rename source as previousPath", async () => {
    const { snapshotTree } = await real();
    await withRepo(async repo => {
      const snapshot = await snapshotTree(repo, new AbortController().signal);
      const top = realpathSync.native(repo);
      const renamed = snapshot?.files.find(f => f.status.includes("R"));
      expect(renamed).toBeDefined();
      expect(realpathSync.native(renamed!.path)).toBe(join(top, "b.test.ts"));
      expect(renamed!.previousPath && resolve(renamed!.previousPath).toLowerCase())
        .toBe(resolve(snapshot!.root!, "a.test.ts").toLowerCase());
    });
  });

  it("records the real top-level path when captured from a subdirectory", async () => {
    const { snapshotTree } = await real();
    await withRepo(async repo => {
      const snapshot = await snapshotTree(join(repo, "sub"), new AbortController().signal);
      expect(snapshot?.root).toBe(realpathSync.native(repo));
      expect(snapshot?.cwd).toBe(realpathSync.native(join(repo, "sub")));
    });
  });
});

describe("shell edits to files already dirty at dispatch, against a real git repository (QA-2.1-2)", { timeout: REAL_GIT_TIMEOUT_MS }, () => {
  const real = () => vi.importActual<typeof import("../../src/verify/tree")>("../../src/verify/tree");
  const sha = (text: string) => `file:${createHash("sha256").update(text).digest("hex")}`;
  const key = (p: string) => resolve(p).toLowerCase();
  const WIP = "// WIP\nexport const add = (x, y) => x + y;\n";
  /** The QA repro's repository: src/a.js and src/b.js committed, then src/a.js dirty (work in progress). */
  const withRepo = async (body: (repo: string, git: (...args: string[]) => void) => Promise<void>) => {
    const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "omr-qa212-")));
    const git = (...args: string[]) => { execFileSync("git", args, { cwd: repo, windowsHide: true }); };
    try {
      git("init", "-q");
      git("config", "user.email", "t@example.invalid"); git("config", "user.name", "t");
      git("config", "commit.gpgsign", "false"); git("config", "core.autocrlf", "false");
      mkdirSync(join(repo, "src")); mkdirSync(join(repo, "test"));
      writeFileSync(join(repo, "src", "a.js"), "export const add = (x, y) => x + y;\n");
      writeFileSync(join(repo, "src", "b.js"), "export const mul = (x, y) => x * y;\n");
      writeFileSync(join(repo, "test", "a.test.js"), "import { add } from '../src/a.js';\n");
      git("add", "-A"); git("commit", "-q", "-m", "init");
      writeFileSync(join(repo, "src", "a.js"), WIP);
      await body(repo, git);
    } finally {
      rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  };
  /** The real wiring and store over the real snapshotTree (the capture stays mocked: git-only, no test run). */
  const wiringAt = async (repo: string) => {
    const { snapshotTree } = await real();
    state.snapshotImpl = snapshotTree;
    // The direct testsPass path (2.2.3 batches only with a window; this file tests attribution).
    const cfg: RouterConfig = { ...harness().cfg, enforcement: { verify: { baselineTimeoutMs: 30_000, batchWindowMs: 0 } } };
    return { wiring: createVerificationWiring({ client: {}, directory: repo, getConfig: () => cfg, logger: { warn: () => {} } }), store: createChangedFileStore() };
  };
  const paths = (files: readonly { path: string }[]) => files.map(f => key(f.path)).sort();

  it("the dispatch snapshot digests every dirty or untracked path within the bounds; a gate digests the given paths", async () => {
    const { snapshotTree, MAX_DIGEST_FILES, MAX_DIGEST_BYTES } = await real();
    expect([MAX_DIGEST_FILES, MAX_DIGEST_BYTES]).toEqual([500, 64 * 1024 * 1024]);
    await withRepo(async repo => {
      writeFileSync(join(repo, "notes.txt"), "untracked");
      const signal = new AbortController().signal;
      const snapshot = await snapshotTree(repo, signal);
      const digests = snapshot?.digests;
      expect(digests === "unavailable" || digests === undefined ? digests : [...digests].map(([p, d]) => [key(p), d]).sort())
        .toEqual([[key(join(repo, "notes.txt")), sha("untracked")], [key(join(repo, "src", "a.js")), sha(WIP)]]);
      expect((await snapshotTree(repo, signal, { maxDigestFiles: 1 }))?.digests).toBe("unavailable");
      expect((await snapshotTree(repo, signal, { maxDigestBytes: WIP.length }))?.digests).toBe("unavailable");
      const gone = join(repo, "src", "gone.js");
      const gate = await snapshotTree(repo, signal, { digestPaths: [join(repo, "src", "b.js"), gone] });
      expect(gate?.digests).toEqual(new Map([[join(repo, "src", "b.js"), sha("export const mul = (x, y) => x * y;\n")], [gone, ABSENT_DIGEST]]));
    });
  });

  it("a sed-style edit to the dirty file is in the gate's change set (the QA repro, scenario B)", async () => {
    await withRepo(async repo => {
      const { wiring, store } = await wiringAt(repo);
      await wiring.beginVerification(store, "q1", undefined, dod);
      // No producer edit yet: nothing changed, and the already-dirty file is not the producer's.
      expect(await wiring.prepareVerification(store, "q1", "q1")).toMatchObject({ changedFiles: [], changeBaseline: "available" });
      writeFileSync(join(repo, "src", "a.js"), "// WIP\nexport const add = (x, y) => x - y;\n"); // `sed -i`: no tool record
      const prepared = await wiring.prepareVerification(store, "q1", "q1");
      expect(prepared.changeBaseline).toBe("available");
      expect(prepared.changedFiles).toEqual([expect.objectContaining({ status: " M" })]);
      expect(paths(prepared.changedFiles)).toEqual([key(join(repo, "src", "a.js"))]);
    });
  });

  it("git checkout, git rm and deleting an untracked file are in the change set; untouched dirty files are not", async () => {
    await withRepo(async (repo, git) => {
      writeFileSync(join(repo, "src", "b.js"), "// WIP too\nexport const mul = (x, y) => x * y;\n");
      writeFileSync(join(repo, "src", "scratch.js"), "export {};\n");
      writeFileSync(join(repo, "src", "keep.js"), "export {};\n");
      const { wiring, store } = await wiringAt(repo);
      await wiring.beginVerification(store, "d", undefined, dod);
      git("checkout", "--", "src/a.js");
      git("rm", "-q", "-f", "src/b.js");
      rmSync(join(repo, "src", "scratch.js"));
      const prepared = await wiring.prepareVerification(store, "d", "d");
      expect(prepared.changeBaseline).toBe("available");
      expect(paths(prepared.changedFiles)).toEqual(["a.js", "b.js", "scratch.js"].map(n => key(join(repo, "src", n))).sort());
      const status = new Map(prepared.changedFiles.map(f => [key(f.path), f.status]));
      expect(status.get(key(join(repo, "src", "a.js")))).toBe(" M");
      expect(status.get(key(join(repo, "src", "b.js")))).toBe("D ");
      expect(status.get(key(join(repo, "src", "scratch.js")))).toBe(" D");
    });
  });

  it("over MAX_DIGEST_FILES dirty paths: an unchanged tree stays available, an edit widens to the dispatch paths and runs scoped tests (QA-2.1-14)", async () => {
    await withRepo(async (repo, git) => {
      // A vitest project, so the planner can scope a run (the argv seam records it; nothing spawns).
      writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
      writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "qa2114", scripts: { test: "vitest run" }, devDependencies: { vitest: "3.0.0" } }));
      mkdirSync(join(repo, "node_modules", "vitest"), { recursive: true });
      writeFileSync(join(repo, "node_modules", "vitest", "package.json"), JSON.stringify({ name: "vitest", version: "3.0.0", bin: { vitest: "vitest.mjs" } }));
      writeFileSync(join(repo, "node_modules", "vitest", "vitest.mjs"), "");
      git("add", ".gitignore", "package.json"); git("commit", "-q", "-m", "vitest");
      mkdirSync(join(repo, "gen"));
      for (let i = 0; i <= 500; i++) writeFileSync(join(repo, "gen", `f${i}.txt`), `${i}`);
      const { wiring, store } = await wiringAt(repo);
      await wiring.beginVerification(store, "d", undefined, dod);
      expect(store.baselineSnapshot("d")?.digests).toBe("unavailable");
      expect(await wiring.prepareVerification(store, "d", "d")).toMatchObject({ changedFiles: [], changeBaseline: "available" });
      // The producer's edit through the recorded edit tool breaks the already-dirty src/a.js.
      writeFileSync(join(repo, "src", "a.js"), "// WIP\nexport const add = (x, y) => x - y;\n");
      store.record("d", "edit", { filePath: join(repo, "src", "a.js") });
      const prepared = await wiring.prepareVerification(store, "d", "d");
      expect(prepared.changeBaseline).toBe("available");
      expect(paths(prepared.changedFiles)).toContain(key(join(repo, "src", "a.js")));
      expect(prepared.changedFiles).toHaveLength(502); // src/a.js and every gen/f*.txt listed at dispatch.
      const deps = wiring.buildGateDeps(undefined, undefined, prepared);
      expect(deps.deterministic.changedFiles).not.toBe("unavailable");
      state.commands = [];
      const r = await accept({ dod: { ...dod, checks: [{ kind: "testsPass", command: "npm test" }] } }, { ...prepared, finalReturnText: "done", declaredOutputs: [], producerSessionID: "d", producerTier: "medium" }, deps);
      expect(r.verdict.reasons.join(" ")).not.toContain("attribution-unavailable");
      const scoped = state.commands.filter(c => c.includes("related"));
      expect(scoped).toHaveLength(1);
      expect(scoped[0]).toContain(join(repo, "src", "a.js"));
    });
  }); // Real git over 501 untracked files: the describe's REAL_GIT_TIMEOUT_MS.
});

describe("commits made since dispatch, against a real git repository (QA-2.1-12)", { timeout: REAL_GIT_TIMEOUT_MS }, () => {
  const real = () => vi.importActual<typeof import("../../src/verify/tree")>("../../src/verify/tree");
  const key = (p: string) => resolve(p).toLowerCase();
  /** A clean repository: src/a.js and src/b.js committed. */
  const withRepo = async (body: (repo: string, git: (...args: string[]) => void) => Promise<void>) => {
    const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "omr-qa2112-")));
    const git = (...args: string[]) => { execFileSync("git", args, { cwd: repo, windowsHide: true }); };
    try {
      git("init", "-q");
      git("config", "user.email", "t@example.invalid"); git("config", "user.name", "t");
      git("config", "commit.gpgsign", "false"); git("config", "core.autocrlf", "false");
      mkdirSync(join(repo, "src"));
      writeFileSync(join(repo, "src", "a.js"), "export const add = (x, y) => x + y;\n");
      writeFileSync(join(repo, "src", "b.js"), "export const mul = (x, y) => x * y;\n");
      git("add", "-A"); git("commit", "-q", "-m", "init");
      await body(repo, git);
    } finally {
      rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  };
  /** The real snapshotTree, and the argv seam running real git (every call is still recorded). */
  const wiringAt = async (repo: string) => {
    const { snapshotTree } = await real();
    state.snapshotImpl = snapshotTree;
    state.argvImpl = (file, args, opts) => new Promise(done => {
      execFile(file, [...args], { cwd: opts.cwd, windowsHide: true }, (error, stdout, stderr) => done({
        code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr), timedOut: false,
      }));
    });
    const cfg: RouterConfig = { ...harness().cfg, enforcement: { verify: { baselineTimeoutMs: 30_000 } } };
    return { wiring: createVerificationWiring({ client: {}, directory: repo, getConfig: () => cfg, logger: { warn: () => {} } }), store: createChangedFileStore() };
  };

  it("a file clean at dispatch, edited through the shell and committed, is in the change set", async () => {
    await withRepo(async (repo, git) => {
      const { wiring, store } = await wiringAt(repo);
      await wiring.beginVerification(store, "d", undefined, dod);
      const head = store.baselineSnapshot("d")?.head;
      expect(head).toMatch(/^[0-9a-f]{40}$/);
      writeFileSync(join(repo, "src", "b.js"), "export const mul = (x, y) => x + y;\n"); // `sed -i`: no tool record
      git("commit", "-q", "-am", "producer commit");
      const prepared = await wiring.prepareVerification(store, "d", "d");
      expect(prepared.changeBaseline).toBe("available");
      expect(prepared.changedFiles.map(f => ({ ...f, path: key(f.path) }))).toEqual([{ path: key(join(repo, "src", "b.js")), status: "M" }]);
      // One git diff, through the argv seam, at low priority, bounded, rooted at the repository.
      // Only the spawns rooted at this test's repository: a timed-out earlier test's gate can still
      // record into the shared state after beforeEach reset it.
      const ours = state.commands.map((command, i) => ({ command, opts: state.execOpts[i] })).filter(c => c.opts?.cwd === repo);
      expect(ours.map(c => c.command)).toEqual([`git --no-optional-locks -C ${repo} diff --name-status -z -M ${head} HEAD`]);
      expect(ours[0].opts).toMatchObject({ cwd: repo, timeoutMs: COMMIT_DIFF_TIMEOUT_MS, lowPriority: resolveVerifyBudget(harness().cfg).lowPriority });
    });
  });

  it("a rename commit carries the rename source as previousPath", async () => {
    await withRepo(async (repo, git) => {
      const { wiring, store } = await wiringAt(repo);
      await wiring.beginVerification(store, "d", undefined, dod);
      git("mv", "src/b.js", "src/c.js");
      git("commit", "-q", "-m", "rename");
      const prepared = await wiring.prepareVerification(store, "d", "d");
      expect(prepared.changeBaseline).toBe("available");
      expect(prepared.changedFiles).toHaveLength(1);
      const [file] = prepared.changedFiles;
      expect(file.status).toBe("R");
      expect(key(file.path)).toBe(key(join(repo, "src", "c.js")));
      expect(file.previousPath && key(file.previousPath)).toBe(key(join(repo, "src", "b.js")));
    });
  });

  it("an unchanged HEAD spawns no git process", async () => {
    await withRepo(async repo => {
      const { wiring, store } = await wiringAt(repo);
      await wiring.beginVerification(store, "d", undefined, dod);
      writeFileSync(join(repo, "src", "b.js"), "export const mul = (x, y) => x + y;\n");
      const prepared = await wiring.prepareVerification(store, "d", "d");
      expect(prepared.changeBaseline).toBe("available");
      expect(prepared.changedFiles.map(f => key(f.path))).toEqual([key(join(repo, "src", "b.js"))]);
      expect(state.commands).toEqual([]);
    });
  });
});

describe("commits made since dispatch, failure paths (QA-2.1-12)", () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  /** The dispatch snapshot at `before`; the gate snapshot at `after` (same tree otherwise). */
  const moved = async (before: string, after: string, deadline?: Deadline) => {
    const { wiring, store } = harness();
    state.snapshot = { ...state.snapshot!, root: cwd, head: before };
    await wiring.beginVerification(store, "d", undefined, dod);
    state.snapshot = { ...state.snapshot!, head: after };
    return wiring.prepareVerification(store, "d", "d", undefined, deadline);
  };

  it("a failing, timed-out or unspawnable diff makes the change set unavailable", async () => {
    state.argvImpl = async () => ({ code: 128, stdout: "", stderr: "fatal: bad object", timedOut: false });
    expect((await moved(A, B)).changeBaseline).toBe("unavailable");
    expect(state.commands).toEqual([`git --no-optional-locks -C ${cwd} diff --name-status -z -M ${A} HEAD`]);
    state.argvImpl = async () => ({ code: 0, stdout: `M\0src/x.js\0`, stderr: "", timedOut: true });
    expect((await moved(A, B)).changeBaseline).toBe("unavailable");
    state.argvImpl = async () => { throw new Error("spawn ENOENT"); };
    expect((await moved(A, B)).changeBaseline).toBe("unavailable");
    state.argvImpl = async () => ({ code: 0, stdout: `R100\0src/x.js\0`, stderr: "", timedOut: false }); // malformed
    expect((await moved(A, B)).changeBaseline).toBe("unavailable");
  });

  it("a successful diff adds the committed files", async () => {
    state.argvImpl = async () => ({ code: 0, stdout: `M\0src/x.js\0D\0src/y.js\0`, stderr: "", timedOut: false });
    const prepared = await moved(A, B);
    expect(prepared.changeBaseline).toBe("available");
    expect(prepared.changedFiles).toEqual([
      { path: resolve(cwd, "src/x.js"), status: "M" },
      { path: resolve(cwd, "src/y.js"), status: "D" },
    ]);
  });

  it("an unknown dispatch head (an unborn repository) with a known one now is unavailable, with no spawn", async () => {
    expect((await moved("HEAD", B)).changeBaseline).toBe("unavailable");
    expect(state.commands).toEqual([]);
  });

  it("the diff is bounded by the deadline, and a spent one runs no git and is unavailable", async () => {
    const ctl = new AbortController();
    await moved(A, B, fakeDeadline(2_500, ctl));
    expect(state.execOpts[0]).toMatchObject({ timeoutMs: 2_500, signal: ctl.signal });
    state.commands = [];
    expect((await moved(A, B, fakeDeadline(0))).changeBaseline).toBe("unavailable");
    expect(state.commands).toEqual([]);
  });
});

describe("dispatch reference wiring", () => {
  it("captures a git-only reference (no test command) and the gate judges against it after the producer changed the tree", async () => {
    const { wiring, store } = harness(); state.held = true;
    const begun = wiring.beginVerification(store, "dispatch", undefined, dod);
    expect(begun).toBeInstanceOf(Promise);
    await vi.waitFor(() => expect(state.finish).toBeDefined());
    expect(state.captures).toEqual([{ cwd, timeoutMs: 1234 }]);
    state.finish?.();
    await begun;
    state.snapshot = { ...state.snapshot!, fingerprint: "after", files: [...state.snapshot!.files, { path: resolve(cwd, "new.ts"), status: "??" }] };
    const prepared = await wiring.prepareVerification(store, "dispatch", "child");
    expect(prepared.changedFiles.map(f => f.path)).toEqual([resolve(cwd, "new.ts")]);
    expect(prepared.reference).toEqual({ kind: "captured", reference: REF });
    expect(prepared.snapshot?.fingerprint).toBe("after");
    const deps = wiring.buildGateDeps(undefined, undefined, prepared);
    const seen: TestsPassRequest[] = [];
    deps.deterministic.testsPass = async req => {
      seen.push(req);
      return {
        scoped: { kind: "ran", exitCode: 1, notes: [], result: { failingIds: ["new.test.ts > new-test"], failingFiles: [resolve(cwd, "new.test.ts")], collectionError: false, total: 1, complete: true, source: "report" } },
        recheck: { kind: "exact", result: undefined, ranFiles: [], absentFiles: ["new.test.ts"], notes: [] },
      };
    };
    const result = await accept({ dod }, { ...prepared, finalReturnText: "done", declaredOutputs: [], producerSessionID: "child", producerTier: "medium" }, deps);
    expect(result.accepted).toBe(false); expect(result.verdict.reasons[0]).toContain("new-test");
    expect(result.verdict.failures?.introduced).toEqual(["new.test.ts > new-test"]);
    expect(seen[0]).toMatchObject({ command: "pnpm test", cwd, reference: { kind: "captured" }, changedFiles: [{ path: resolve(cwd, "new.ts"), status: "??" }] });
    // G6: the dispatch and the gate (whose hook is faked) spawned nothing.
    expect(state.commands).toEqual([]);
  });
  it("a delegate retry hands testsPass the first attempt's files too (QA-2.1-1)", async () => {
    const { wiring, store } = harness();
    // old.ts is dirty at dispatch (the harness snapshot lists it) and attempt 1 edits it.
    const old = resolve(cwd, "old.ts"); const other = resolve(cwd, "other.ts");
    await wiring.beginVerification(store, "p1", undefined, dod);
    store.record("p1", "edit", { filePath: old });
    expect((await wiring.prepareVerification(store, "p1", "p1")).changedFiles.map(f => f.path)).toEqual([old]);
    // Attempt 2: a new producer session, the same dispatch reference, and only other.ts edited.
    store.record("p2", "edit", { filePath: other });
    const retry = await wiring.prepareVerification(store, "p1", "p2");
    expect(retry.changeBaseline).toBe("available");
    const deps = wiring.buildGateDeps(undefined, undefined, retry);
    const seen: TestsPassRequest[] = [];
    deps.deterministic.testsPass = async req => {
      seen.push(req);
      return { scoped: { kind: "ran", exitCode: 0, notes: [], result: { failingIds: [], failingFiles: [], collectionError: false, total: 2, complete: true, source: "report" } }, recheck: undefined };
    };
    await accept({ dod }, { ...retry, finalReturnText: "done", declaredOutputs: [], producerSessionID: "p2", producerTier: "medium" }, deps);
    const sent = seen[0]?.changedFiles;
    expect(sent === "unavailable" ? sent : sent?.map(f => f.path).sort()).toEqual([old, other].sort());
  });
  it("failureRecheck off (deprecated testBaseline false) captures nothing but still snapshots changed files", async () => {
    const { cfg, wiring, store } = harness();
    cfg.enforcement!.verify!.testBaseline = false;
    await wiring.beginVerification(store, "disabled", undefined, dod);
    cfg.enforcement!.verify = { failureRecheck: false };
    await wiring.beginVerification(store, "off", undefined, dod);
    expect(state.captures).toEqual([]);
    const prepared = await wiring.prepareVerification(store, "disabled", "child");
    expect(prepared.changeBaseline).toBe("available");
    expect(prepared.reference).toEqual({ kind: "disabled" });
    expect((await wiring.prepareVerification(store, "off", "child")).reference).toEqual({ kind: "disabled" });
  });
  it("read-only dispatches and forbidden commands capture nothing and run nothing", async () => {
    const { wiring, store } = harness();
    await wiring.beginVerification(store, "readonly", undefined, { ...dod, kind: "checker", checks: [], criteria: ["investigate"] });
    await wiring.beginVerification(store, "blocked", undefined, { ...dod, checks: [{ kind: "testsPass", command: "npm test && evil" }] });
    for (const id of ["readonly", "blocked"]) {
      expect((await wiring.prepareVerification(store, id, "child")).reference).toEqual({ kind: "none", reason: REFERENCE_NONE.notRequested });
    }
    expect(state.captures).toEqual([]);
    expect(state.commands).toEqual([]);
  });
  it("a retry keeps the first reference, and an untracked dispatch has none", async () => {
    const { wiring, store } = harness();
    await wiring.beginVerification(store, "dispatch", undefined, dod);
    state.captureResult = { ...REF, commit: "after-the-failed-attempt" };
    await wiring.beginVerification(store, "dispatch", undefined, dod);
    expect(state.captures).toHaveLength(1);
    expect((await wiring.prepareVerification(store, "dispatch", "retry")).reference).toEqual({ kind: "captured", reference: REF });
    expect((await wiring.prepareVerification(store, "never-begun", "child")).reference).toEqual({ kind: "none", reason: REFERENCE_NONE.untracked });
  });
  describe("bounded wait (2.1.5b, fake timers)", () => {
    const bounded = (verify: Record<string, unknown>) => {
      const warnings: string[] = [];
      const cfg: RouterConfig = { activePreset: "a", presets: { a: { medium: { model: "p/m" } } }, defaultTier: "medium", rules: [], enforcement: { verify: { baselineTimeoutMs: 30_000, ...verify } } };
      const wiring = createVerificationWiring({ client: {}, directory: cwd, getConfig: () => cfg, logger: { warn: m => void warnings.push(m) } });
      return { wiring, store: createChangedFileStore(), warnings };
    };
    const track = (p: Promise<void>) => { const s = { done: false }; void p.then(() => { s.done = true; }); return s; };
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it("a capture resolving at 2 s lets the dispatch proceed at 2 s", async () => {
      const { wiring, store } = bounded({ captureWaitMs: 5_000 }); state.captureDelayMs = 2_000;
      const s = track(wiring.beginVerificationBounded(store, "d", undefined, dod));
      await vi.advanceTimersByTimeAsync(1_999); expect(s.done).toBe(false);
      await vi.advanceTimersByTimeAsync(1); expect(s.done).toBe(true);
      expect((await wiring.prepareVerification(store, "d", "child")).reference).toEqual({ kind: "captured", reference: REF });
    });
    it("a capture at 20 s with captureWaitMs 5 s proceeds at 5 s and the capture is still usable later", async () => {
      const { wiring, store } = bounded({ captureWaitMs: 5_000 }); state.captureDelayMs = 20_000;
      const s = track(wiring.beginVerificationBounded(store, "d", undefined, dod));
      await vi.advanceTimersByTimeAsync(4_999); expect(s.done).toBe(false);
      await vi.advanceTimersByTimeAsync(1); expect(s.done).toBe(true);
      await vi.advanceTimersByTimeAsync(15_000);
      expect((await wiring.prepareVerification(store, "d", "child")).reference).toEqual({ kind: "captured", reference: REF });
    });
    it("a capture that throws never fails the dispatch", async () => {
      const { wiring, store } = bounded({ captureWaitMs: 5_000 }); state.captureDelayMs = 1_000; state.captureThrows = true;
      const p = wiring.beginVerificationBounded(store, "d", undefined, dod);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(p).resolves.toBeUndefined();
      expect((await wiring.prepareVerification(store, "d", "child")).reference.kind).not.toBe("captured");
    });
    it("gcStaleReferences runs once, REFERENCE_GC_START_DELAY_MS after start (QA-2.1-11), and its rejection is logged, not thrown", async () => {
      const { wiring, warnings } = bounded({}); state.gcRejects = true;
      expect(() => wiring.startReferenceGc()).not.toThrow();
      // Plugin start spawns nothing in the project directory.
      await vi.advanceTimersByTimeAsync(REFERENCE_GC_START_DELAY_MS - 1);
      expect(state.gcCalls).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(state.gcCalls).toEqual([cwd]);
      expect(warnings.some(w => w.includes("reference GC failed"))).toBe(true);
      await vi.advanceTimersByTimeAsync(10 * REFERENCE_GC_START_DELAY_MS);
      expect(state.gcCalls).toEqual([cwd]);
    });
    it("cancelling before the delay runs no GC; the timer never keeps the process alive", async () => {
      const { wiring } = bounded({});
      const unref = vi.spyOn(globalThis, "setTimeout");
      const cancel = wiring.startReferenceGc();
      expect(unref).toHaveBeenCalledWith(expect.any(Function), REFERENCE_GC_START_DELAY_MS);
      const timer = unref.mock.results[0]?.value as { hasRef?: () => boolean } | undefined;
      expect(timer?.hasRef?.() ?? false).toBe(false);
      unref.mockRestore();
      cancel();
      await vi.advanceTimersByTimeAsync(2 * REFERENCE_GC_START_DELAY_MS);
      expect(state.gcCalls).toEqual([]);
    });
  });

  it("an overlapping edit before the capture resolves discards the reference", async () => {
    const { wiring, store } = harness(); state.held = true;
    const begun = wiring.beginVerification(store, "dispatch", undefined, dod);
    await vi.waitFor(() => expect(state.finish).toBeDefined());
    store.observeEdit("bash", cwd);
    state.finish?.();
    await begun;
    expect((await wiring.prepareVerification(store, "dispatch", "child")).reference)
      .toEqual({ kind: "none", reason: `${REFERENCE_NONE.contaminated} (tool "bash")` });
  });
  it("the capture's argv seam runs at the configured priority", async () => {
    const { cfg, wiring, store } = harness();
    await wiring.beginVerification(store, "dispatch", undefined, dod);
    await state.captureArgv!("git", ["rev-parse", "HEAD"], { cwd });
    expect(state.commands).toEqual(["git rev-parse HEAD"]);
    expect(state.execOpts[0]).toMatchObject({ cwd, lowPriority: resolveVerifyBudget(cfg).lowPriority });
  });
  it("QA-3.1-8: the dispatch and gate tree snapshots run their git at the configured priority", async () => {
    const seen: (boolean | undefined)[] = [];
    state.snapshotImpl = async (_cwd, _signal, options) => {
      seen.push(options?.lowPriority);
      return state.snapshot;
    };
    const { cfg, wiring, store } = harness();
    expect(resolveVerifyBudget(cfg).lowPriority).toBe(true);
    await wiring.beginVerification(store, "dispatch", undefined, dod);
    await wiring.prepareVerification(store, "dispatch", "child");
    // A DoD without testsPass still snapshots at dispatch (read-only fan-outs capture nothing).
    await wiring.beginVerification(store, "readonly", undefined, { ...dod, checks: [] });
    expect(seen).toEqual([true, true, true]);

    seen.length = 0;
    const normal: RouterConfig = { ...cfg, enforcement: { verify: { ...cfg.enforcement?.verify, lowPriority: false } } };
    const off = createVerificationWiring({ client: {}, directory: cwd, getConfig: () => normal, logger: { warn: () => {} } });
    await off.beginVerification(store, "normal", undefined, dod);
    await off.prepareVerification(store, "normal", "child");
    expect(seen).toEqual([false, false]);

    // An unreadable config keeps the section 1.4 default (low).
    seen.length = 0;
    const broken = createVerificationWiring({ client: {}, directory: cwd, getConfig: () => { throw new Error("config broke"); }, logger: { warn: () => {} } });
    await broken.beginVerification(store, "broken", undefined, dod);
    await broken.prepareVerification(store, "broken", "child");
    expect(seen).toEqual([true, true]);
  });
  it("QA-2.1-5: the recheck's reference argv seam (GC, materialize, dispose) runs at the configured priority", async () => {
    const { cfg, wiring } = harness();
    wiring.buildGateDeps();
    const refArgv = state.scopeDeps?.reference?.argv;
    expect(refArgv).toBeDefined();
    expect(refArgv).not.toBe(state.scopeDeps?.argv);
    await refArgv!("git", ["worktree", "prune"], { cwd, timeoutMs: 9 });
    expect(state.commands).toEqual(["git worktree prune"]);
    expect(resolveVerifyBudget(cfg).lowPriority).toBe(true);
    expect(state.execOpts[0]).toMatchObject({ cwd, timeoutMs: 9, lowPriority: true });
  });
  it("a config that throws still snapshots and records why there is no reference", async () => {
    const store = createChangedFileStore();
    const wiring = createVerificationWiring({ client: {}, directory: cwd, getConfig: () => { throw new Error("config broke"); }, logger: { warn: () => {} } });
    await wiring.beginVerification(store, "dispatch", undefined, dod);
    const prepared = await wiring.prepareVerification(store, "dispatch", "child");
    expect(prepared.reference.kind).toBe("none");
    expect(prepared.reference.kind === "none" && prepared.reference.reason).toBe(`${REFERENCE_NONE.failed} (config broke)`);
    expect(prepared.changeBaseline).toBe("available");
    expect(state.captures).toEqual([]);
  });
});

describe("bounded wait edges", () => {
  it("awaitBounded reports settled and error outcomes", async () => {
    expect(await awaitBounded(Promise.resolve(), 1_000)).toEqual({ kind: "settled" });
    const error = new Error("boom");
    expect(await awaitBounded(Promise.reject(error), 1_000)).toEqual({ kind: "error", error });
  });
  it("beginVerificationBounded logs a start failure and a rejected dispatch instead of throwing", async () => {
    const warnings: string[] = [];
    const logger = { warn: (m: string) => void warnings.push(m) };
    const broken = createVerificationWiring({ client: {}, directory: cwd, getConfig: () => { throw new Error("config broke"); }, logger });
    const store = createChangedFileStore();
    await expect(broken.beginVerificationBounded(store, "d", undefined, dod)).resolves.toBeUndefined();
    expect(warnings).toEqual(["[verify] dispatch reference capture could not start"]);
    expect((await store.reference("d")).kind).toBe("none");
    const { cfg } = harness();
    const wiring = createVerificationWiring({ client: {}, directory: cwd, getConfig: () => cfg, logger });
    const rejecting = { ...store, beginDispatch: () => Promise.reject(new Error("store broke")) };
    await expect(wiring.beginVerificationBounded(rejecting, "d", undefined, dod)).resolves.toBeUndefined();
    expect(warnings[1]).toBe("[verify] dispatch reference capture failed; proceeding without a reference");
  });
  it("the default logger is console.warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const wiring = createVerificationWiring({ client: {}, directory: cwd, getConfig: () => { throw new Error("config broke"); } });
      await wiring.beginVerificationBounded(createChangedFileStore(), "d", undefined, dod);
      expect(warn).toHaveBeenCalledWith("[verify] dispatch reference capture could not start", expect.objectContaining({ id: "d" }));
    } finally {
      warn.mockRestore();
    }
  });
});

describe("reference GC at start", () => {
  const logs = () => {
    const debug: string[] = []; const warn: string[] = [];
    return { debug, warn, logger: { warn: (m: string) => void warn.push(m), debug: (m: string) => void debug.push(m) } };
  };
  it("is skipped without a plugin root", () => {
    const l = logs();
    const cancel = createVerificationWiring({ client: {}, directory: "", getConfig: () => harness().cfg, logger: l.logger }).startReferenceGc(0);
    expect(state.gcCalls).toEqual([]);
    expect(l.debug).toEqual(["[verify] reference GC skipped: plugin root unknown"]);
    expect(() => cancel()).not.toThrow();
  });
  it("logs removed stale dirs and runs its git at the configured priority", async () => {
    const l = logs(); const { cfg } = harness(); state.gcRemoved = [join(cwd, "stale")]; state.gcArgv = true;
    createVerificationWiring({ client: {}, directory: cwd, getConfig: () => cfg, logger: l.logger }).startReferenceGc(0);
    await vi.waitFor(() => expect(l.debug).toEqual(["[verify] reference GC removed stale dirs"]));
    expect(state.commands).toEqual(["git worktree prune"]);
    expect(state.execOpts[0]).toMatchObject({ cwd, lowPriority: resolveVerifyBudget(cfg).lowPriority });
    expect(state.execOpts[0].signal?.aborted).toBe(false);
    expect(l.warn).toEqual([]);
  });
  it("cancelling aborts the git calls of a GC in flight", async () => {
    const l = logs(); const { cfg } = harness(); state.gcArgv = true;
    let seen: AbortSignal | undefined;
    let release!: () => void;
    state.argvImpl = (_file, _args, opts) => new Promise(resolve => {
      seen = opts.signal;
      release = () => resolve({ code: 0, stdout: "", stderr: "", timedOut: false });
    });
    const cancel = createVerificationWiring({ client: {}, directory: cwd, getConfig: () => cfg, logger: l.logger }).startReferenceGc(0);
    await vi.waitFor(() => expect(seen).toBeDefined());
    expect(seen?.aborted).toBe(false);
    cancel();
    expect(seen?.aborted).toBe(true);
    release();
  });
  it("nothing removed logs nothing", async () => {
    const l = logs();
    createVerificationWiring({ client: {}, directory: cwd, getConfig: () => harness().cfg, logger: l.logger }).startReferenceGc(0);
    await vi.waitFor(() => expect(state.gcCalls).toEqual([cwd]));
    await new Promise(r => setTimeout(r, 0));
    expect(l.debug).toEqual([]);
  });
  it("a config that throws is logged, not thrown", async () => {
    const l = logs();
    const wiring = createVerificationWiring({ client: {}, directory: cwd, getConfig: () => { throw new Error("config broke"); }, logger: l.logger });
    expect(() => wiring.startReferenceGc(0)).not.toThrow();
    await vi.waitFor(() => expect(l.warn).toEqual(["[verify] reference GC failed"]));
    expect(state.gcCalls).toEqual([]);
  });
});

const fakeDeadline = (remaining: number, ctl = new AbortController()): Deadline => ({
  budgetMs: 60_000, remaining: () => remaining, bound: ms => Math.min(ms, remaining), signal: ctl.signal,
});

describe("prepareVerification edges", () => {
  it("a snapshot that throws leaves the change baseline unavailable", async () => {
    const { wiring, store } = harness();
    await wiring.beginVerification(store, "dispatch", undefined, dod);
    state.snapshotImpl = async () => { throw new Error("git broke"); };
    const prepared = await wiring.prepareVerification(store, "dispatch", "child");
    expect(prepared.snapshot).toBeUndefined();
    expect(prepared.changeBaseline).toBe("unavailable");
    expect(prepared.reference).toEqual({ kind: "captured", reference: REF });
  });
  it("a spent deadline takes no snapshot", async () => {
    const { wiring, store } = harness();
    await wiring.beginVerification(store, "dispatch", undefined, dod);
    const snap = vi.fn(async () => state.snapshot);
    state.snapshotImpl = snap;
    const prepared = await wiring.prepareVerification(store, "dispatch", "child", undefined, fakeDeadline(0));
    expect(snap).not.toHaveBeenCalled();
    expect(prepared.snapshot).toBeUndefined();
    expect(prepared.changeBaseline).toBe("unavailable");
  });
  it("a deadline abort mid-snapshot aborts the snapshot", async () => {
    const { wiring, store } = harness();
    let seen: AbortSignal | undefined;
    state.snapshotImpl = (_c, signal) => new Promise((_resolve, reject) => {
      seen = signal;
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    const ctl = new AbortController();
    const pending = wiring.prepareVerification(store, "never-begun", "child", "sub", fakeDeadline(5_000, ctl));
    await vi.waitFor(() => expect(seen).toBeDefined());
    ctl.abort();
    const prepared = await pending;
    expect(seen?.aborted).toBe(true);
    expect(prepared.snapshot).toBeUndefined();
    expect(prepared.reference).toEqual({ kind: "none", reason: REFERENCE_NONE.untracked });
  });
});

describe("gate seams", () => {
  it("the exec and argv seams default to the project root and the check timeout, and forward the rest", async () => {
    const { wiring } = harness();
    wiring.buildGateDeps();
    const { exec, argv } = state.scopeDeps!;
    const signal = new AbortController().signal;
    await exec("npm test");
    await exec("npm test", { cwd: "elsewhere", timeoutMs: 5, signal, lowPriority: true, env: { A: "1" } });
    await argv("git", ["status"]);
    await argv("git", ["status"], { cwd: "elsewhere", timeoutMs: 7, signal, lowPriority: false, env: { B: "2" } });
    expect(state.commands).toEqual(["npm test", "npm test", "git status", "git status"]);
    expect(state.execOpts).toEqual([
      { cwd, timeoutMs: 120_000, signal: undefined, lowPriority: undefined, env: undefined },
      { cwd: "elsewhere", timeoutMs: 5, signal, lowPriority: true, env: { A: "1" } },
      { cwd, timeoutMs: 120_000, signal: undefined, lowPriority: undefined, env: undefined },
      { cwd: "elsewhere", timeoutMs: 7, signal, lowPriority: false, env: { B: "2" } },
    ]);
  });

  it("the filesystem seam resolves relative paths against the root and tolerates ENOENT on unlink only", async () => {
    const root = mkdtempSync(join(tmpdir(), "omr-wiring-fs-"));
    try {
      mkdirSync(join(root, "dir"));
      writeFileSync(join(root, "a.txt"), "hello");
      writeFileSync(join(root, "b.txt"), "bye");
      const cfg = harness().cfg;
      createVerificationWiring({ client: {}, directory: root, getConfig: () => cfg }).buildGateDeps();
      const fs = state.scopeDeps!.fs;
      expect(await fs.fileExists("a.txt")).toBe(true);
      expect(await fs.fileExists(join(root, "dir"))).toBe(true);
      expect(await fs.fileExists("missing.txt")).toBe(false);
      expect(await fs.readFile("a.txt")).toBe("hello");
      expect(await fs.realpath!("a.txt")).toBe(realpathSync.native(join(root, "a.txt")));
      expect(await fs.stat!("a.txt")).toMatchObject({ isFile: true, size: 5n });
      expect(await fs.stat!("dir")).toMatchObject({ isFile: false });
      expect([...(await fs.readdir!("."))].sort()).toEqual(["a.txt", "b.txt", "dir"]);
      await fs.unlink("b.txt");
      expect(await fs.fileExists("b.txt")).toBe(false);
      await expect(fs.unlink("b.txt")).resolves.toBeUndefined();
      await expect(fs.unlink("dir")).rejects.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  describe("git test search", () => {
    const root = resolve("search-root");
    const search = (deadline?: Deadline) => {
      const { wiring } = harness();
      wiring.buildGateDeps(undefined, undefined, undefined, deadline);
      return state.hookDeps!.search;
    };
    const reply = (code: number, stdout = "", timedOut = false) => { state.argvImpl = async () => ({ code, stdout, stderr: "", timedOut }); };

    it("findByName lists tracked and untracked files through git ls-files", async () => {
      const s = search(); reply(0, "a.test.ts\0sub/b.test.ts\0");
      expect(await s.findByName(root, ["a.test.ts", "b.test.ts"])).toEqual([resolve(root, "a.test.ts"), resolve(root, "sub/b.test.ts")]);
      expect(state.commands).toEqual([`git --no-optional-locks -C ${root} ls-files -z --cached --others --exclude-standard -- :(glob)**/a.test.ts :(glob)**/b.test.ts`]);
      expect(state.execOpts[0]).toMatchObject({ cwd: root, timeoutMs: TEST_SEARCH_TIMEOUT_MS });
      expect(state.execOpts[0].signal).toBeUndefined();
      reply(0, "");
      expect(await s.findByName(root, ["x.test.ts"])).toEqual([]);
    });
    it("findByName is undefined when git fails, times out or cannot spawn", async () => {
      const s = search();
      reply(128); expect(await s.findByName(root, ["a.test.ts"])).toBeUndefined();
      reply(0, "a.test.ts\0", true); expect(await s.findByName(root, ["a.test.ts"])).toBeUndefined();
      state.argvImpl = async () => { throw new Error("spawn ENOENT"); };
      expect(await s.findByName(root, ["a.test.ts"])).toBeUndefined();
    });
    it("findByContent maps git grep exit 0 to paths, 1 to no match, and anything else to undefined", async () => {
      const s = search();
      reply(0, "a.test.ts\0");
      expect(await s.findByContent(root, "needle", ["*.test.ts"])).toEqual([resolve(root, "a.test.ts")]);
      expect(state.commands[0]).toBe(`git --no-optional-locks -C ${root} grep -l -z -F --untracked -e needle -- *.test.ts`);
      reply(1); expect(await s.findByContent(root, "needle", ["*.test.ts"])).toEqual([]);
      reply(2); expect(await s.findByContent(root, "needle", ["*.test.ts"])).toBeUndefined();
      reply(1, "", true); expect(await s.findByContent(root, "needle", ["*.test.ts"])).toBeUndefined();
      state.argvImpl = async () => { throw new Error("spawn ENOENT"); };
      expect(await s.findByContent(root, "needle", ["*.test.ts"])).toBeUndefined();
    });
    it("E2E-1: findByContent with word adds git grep -w (a pytest module name as a whole word)", async () => {
      const s = search();
      reply(0, "tests/test_mod02_1.py\0");
      expect(await s.findByContent(root, "mod02", [":(glob)**/test_*.py", ":(glob)**/conftest.py"], { word: true })).toEqual([resolve(root, "tests/test_mod02_1.py")]);
      expect(state.commands[0]).toBe(`git --no-optional-locks -C ${root} grep -l -z -F -w --untracked -e mod02 -- :(glob)**/test_*.py :(glob)**/conftest.py`);
      reply(1); expect(await s.findByContent(root, "mod02", ["*.py"], { word: false })).toEqual([]);
      expect(state.commands[1]).toBe(`git --no-optional-locks -C ${root} grep -l -z -F --untracked -e mod02 -- *.py`);
    });
    it("QA-G-10: real git grep -F -w finds every wrapped, continued and CRLF import of mod02, not mod020", async () => {
      const dir = mkdtempSync(join(tmpdir(), "omr-qag10-"));
      try {
        execFileSync("git", ["init", "-q"], { cwd: dir });
        mkdirSync(join(dir, "tests"));
        const corpus: Record<string, string> = {
          paren_two_on_line: "from app import (\n    mod01, mod02,\n)\n",
          isort_grid: "from app import (mod01, mod03, mod04,\n                 mod05, mod02)\n",
          backslash_cont: "from app import mod01, \\\n    mod03, mod02\n",
          paren_last_no_comma_crlf: "from app import (\r\n    mod01,\r\n    mod02\r\n)\r\n",
          as_alias: "import app.mod02 as m\n",
          from_as: "from app import mod02 as m\n",
          paren_one_per_line: "from app import (\n    mod01,\n    mod02,\n)\n",
          paren_last_no_comma_lf: "from app import (\n    mod01,\n    mod02\n)\n",
          importlib: 'import importlib\nm = importlib.import_module("app.mod02")\n',
          dunder_import: 'm = __import__("app.mod02")\n',
          rel_from_pkg: "from ..app import mod02\n",
          rel_dotted: "from ..app.mod02 import value02\n",
          attr_chain: "import app\nx = app.mod02.value02(1)\n",
        };
        for (const [k, c] of Object.entries(corpus)) writeFileSync(join(dir, "tests", `test_${k}.py`), c);
        writeFileSync(join(dir, "tests", "test_decoy.py"), "from app import mod020\nimport app.mod020x\n");
        const s = search();
        state.argvImpl = (file, args) => new Promise(done => {
          execFile(file, [...args], { encoding: "utf8" }, (err, stdout, stderr) => done({ code: err ? Number(err.code ?? 1) : 0, stdout, stderr, timedOut: false }));
        });
        const hits = await s.findByContent(dir, "mod02", [":(glob)**/test_*.py", ":(glob)**/*_test.py", ":(glob)**/conftest.py"], { word: true });
        expect([...(hits ?? [])].sort()).toEqual(Object.keys(corpus).map(k => resolve(dir, `tests/test_${k}.py`)).sort());
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      }
    });
    it("QA-G-3: findByName brackets glob metacharacters, so a name is matched literally", async () => {
      const s = search();
      reply(0, "");
      await s.findByName(root, ["test_mod0[1-2]_[1-3].py", "test_*?.py", "a\\b.py"]);
      expect(state.commands[0]).toBe(
        `git --no-optional-locks -C ${root} ls-files -z --cached --others --exclude-standard -- :(glob)**/test_mod0[[]1-2[]]_[[]1-3[]].py :(glob)**/test_[*][?].py :(glob)**/a[\\\\]b.py`,
      );
    });
    it("QA-G-3: real git ls-files finds only the literal bracketed name", async () => {
      const dir = mkdtempSync(join(tmpdir(), "omr-qag3-"));
      try {
        execFileSync("git", ["init", "-q"], { cwd: dir });
        mkdirSync(join(dir, "tests"));
        for (const n of ["test_mod0[1-2]_[1-3].py", "test_mod01_1.py", "test_mod02_3.py"]) writeFileSync(join(dir, "tests", n), "");
        const s = search();
        state.argvImpl = (file, args) => new Promise(done => {
          execFile(file, [...args], { encoding: "utf8" }, (err, stdout, stderr) => done({ code: err ? Number(err.code ?? 1) : 0, stdout, stderr, timedOut: false }));
        });
        expect(await s.findByName(dir, ["test_mod0[1-2]_[1-3].py"])).toEqual([resolve(dir, "tests/test_mod0[1-2]_[1-3].py")]);
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      }
    });
    it("QA-G-19: real git finds a nested conftest.py by content", async () => {
      const dir = mkdtempSync(join(tmpdir(), "omr-qag19-"));
      try {
        execFileSync("git", ["init", "-q"], { cwd: dir });
        const files: Record<string, string> = {
          "tests/api/conftest.py": "from app.helpers import make\n",
          "tests/unit/test_unit.py": "# string helpers\n",
          "tests/test_other.py": "import os\n",
        };
        for (const [rel, text] of Object.entries(files)) {
          mkdirSync(dirname(join(dir, rel)), { recursive: true });
          writeFileSync(join(dir, rel), text);
        }
        const s = search();
        state.argvImpl = (file, args) => new Promise(done => {
          execFile(file, [...args], { encoding: "utf8" }, (err, stdout, stderr) => done({ code: err ? Number(err.code ?? 1) : 0, stdout, stderr, timedOut: false }));
        });
        // The deleted-module search: the needle as a substring, over the test globs and conftest.py.
        const hits = await s.findByContent(dir, "helpers", [":(glob)**/test_*.py", ":(glob)**/*_test.py", ":(glob)**/conftest.py"]);
        expect([...(hits ?? [])].sort()).toEqual([resolve(dir, "tests/api/conftest.py"), resolve(dir, "tests/unit/test_unit.py")]);
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      }
    });
    it("a deadline bounds each search and a spent or aborted one runs no git", async () => {
      const ctl = new AbortController(); reply(0, "a.test.ts\0");
      expect(await search(fakeDeadline(2_500, ctl)).findByName(root, ["a.test.ts"])).toEqual([resolve(root, "a.test.ts")]);
      expect(state.execOpts[0]).toMatchObject({ timeoutMs: 2_500, signal: ctl.signal });
      expect(await search(fakeDeadline(0)).findByName(root, ["a.test.ts"])).toBeUndefined();
      ctl.abort();
      expect(await search(fakeDeadline(2_500, ctl)).findByContent(root, "needle", ["*.ts"])).toBeUndefined();
      expect(state.commands).toHaveLength(1);
    });
  });

  it("the gate's grader closure dispatches through the wiring", async () => {
    const create = vi.fn(async () => ({ data: {} }));
    const cfg = harness().cfg;
    const deps = createVerificationWiring({ client: { session: { create } }, directory: cwd, getConfig: () => cfg }).buildGateDeps("parent");
    expect(await deps.checker.dispatchGrader({ tier: "medium", system: "s", prompt: "p" })).toEqual({ sessionID: "", text: "", model: null });
    expect(create).toHaveBeenCalledWith({ body: { parentID: "parent" } });
  });
});

describe("child session disposal memo", () => {
  it("evicts the oldest ids once it holds DISPOSED_MEMO_MAX", async () => {
    const abort = vi.fn(async () => {});
    const del = vi.fn(async () => { throw new Error("already gone"); });
    const cfg = harness().cfg;
    const wiring = createVerificationWiring({ client: { session: { abort, delete: del } }, directory: cwd, getConfig: () => cfg });
    for (let i = 0; i <= DISPOSED_MEMO_MAX; i++) await wiring.disposeChildSession(`s${i}`);
    expect(abort).toHaveBeenCalledTimes(DISPOSED_MEMO_MAX + 1);
    await wiring.disposeChildSession(`s${DISPOSED_MEMO_MAX}`);
    await wiring.disposeChildSession("s1");
    expect(abort).toHaveBeenCalledTimes(DISPOSED_MEMO_MAX + 1);
    // s0 was evicted when s512 arrived, so it is disposed again (evicting s1 in turn).
    await wiring.disposeChildSession("s0");
    expect(abort).toHaveBeenCalledTimes(DISPOSED_MEMO_MAX + 2);
    await wiring.disposeChildSession("s1");
    expect(abort).toHaveBeenCalledTimes(DISPOSED_MEMO_MAX + 3);
    expect(del).toHaveBeenCalledTimes(DISPOSED_MEMO_MAX + 3);
  });
});
