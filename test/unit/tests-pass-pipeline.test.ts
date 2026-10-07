import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import * as fsp from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { judgeScoped } from "../../src/verify/baseline";
import { captureReference, materialize as realMaterialize, nodeReferenceFs } from "../../src/verify/reference";
import { detectRunner as realDetectRunner, resolveEntry as realResolveEntry } from "../../src/verify/runner";
import { createChangedFileStore } from "../../src/verify/dispatch";
import type { VerifyBudget } from "../../src/router/config";
import type {
  DetectedRunner,
  PlannerFs,
  PlanScopedRunInput,
  ResolvedEntry,
  RunResult,
  RunnerFs,
  ScopedSpec,
  ScopingPlan,
  TestSearchSeam,
} from "../../src/verify/runner";
import type { DispatchReference, MaterializeResult, ReferenceFs, ReferenceStats } from "../../src/verify/reference";
import type { acquireSlot } from "../../src/verify/slot";
import type {
  ArgvSeam,
  Deadline,
  ExecSeam,
  RecheckOutcome,
  RecheckUnusableCause,
  Rechecker,
  ScopedOutcome,
  TestsPassRequest,
} from "../../src/verify/types";
import type { TreeSnapshot } from "../../src/verify/dispatch";
import type { DoD } from "../../src/verify/dod";
import { accept, unverifiableGateResult, type Artefact, type GateResult } from "../../src/verify/gate";
import { withTimeout } from "../../src/verify/timeout";
import {
  type CheckScope,
  type CommandOutcome,
  type RecheckSeams,
  ABORTED_BEFORE_RUN,
  ABORTED_DURING_RUN,
  CLOSE_MARGIN_MS,
  createDirectTestsPassHook,
  createScopeOpener,
  SLOT_LOST_NOTE,
  createDeadline,
  deriveDeadline,
  fileKeyOfId,
  INERT_UNREPRODUCED,
  isInertUnreproduced,
  RECHECK_MIN_REMAINING_MS,
} from "../../src/verify/deterministic";

describe("createDeadline", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("counts down, bounds steps by the remaining time and aborts at expiry", () => {
    const d = createDeadline(5_000);
    expect(d.budgetMs).toBe(5_000);
    expect(d.remaining()).toBe(5_000);
    expect(d.bound(60_000)).toBe(5_000);
    expect(d.bound(1_000)).toBe(1_000);
    expect(d.bound(Infinity)).toBe(5_000);
    vi.advanceTimersByTime(3_000);
    expect(d.remaining()).toBe(2_000);
    expect(d.bound(60_000)).toBe(2_000);
    expect(d.signal.aborted).toBe(false);
    vi.advanceTimersByTime(2_000);
    expect(d.signal.aborted).toBe(true);
    expect(d.remaining()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(d.remaining()).toBe(0);
    expect(d.bound(1_000)).toBe(0);
  });

  it("never returns a negative bound or remaining", () => {
    const d = createDeadline(-5);
    expect(d.budgetMs).toBe(0);
    expect(d.remaining()).toBe(0);
    expect(d.bound(-10)).toBe(0);
    expect(d.bound(Number.NaN)).toBe(0);
    d.dispose();
  });

  it("uses the injected clock", () => {
    let t = 1_000;
    const d = createDeadline(500, { now: () => t });
    t += 200;
    expect(d.remaining()).toBe(300);
    t += 1_000;
    expect(d.remaining()).toBe(0);
    d.dispose();
  });

  it("abort() aborts the signal at once, zeroes remaining and clears the timer", () => {
    const d = createDeadline(60_000);
    d.abort("owner timed out");
    expect(d.signal.aborted).toBe(true);
    expect((d.signal.reason as Error).message).toBe("owner timed out");
    expect(d.remaining()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    d.abort("again");
    expect((d.signal.reason as Error).message).toBe("owner timed out");
  });

  it("dispose() leaves no timer behind and the signal never aborts afterwards", () => {
    const d = createDeadline(5_000);
    expect(vi.getTimerCount()).toBe(1);
    d.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(d.signal.aborted).toBe(false);
    d.dispose();
  });
});

describe("deriveDeadline", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("never exceeds the parent", () => {
    const parent = createDeadline(5_000);
    const rd = deriveDeadline(parent, 60_000);
    expect(rd.remaining()).toBe(5_000);
    expect(rd.bound(60_000)).toBe(5_000);
    vi.advanceTimersByTime(4_000);
    expect(rd.remaining()).toBe(1_000);
    vi.advanceTimersByTime(1_000);
    expect(parent.signal.aborted).toBe(true);
    expect(rd.signal.aborted).toBe(true);
    expect(rd.remaining()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("expires on its own budget before the parent", () => {
    const parent = createDeadline(60_000);
    const rd = deriveDeadline(parent, 2_000);
    expect(rd.bound(5_000)).toBe(2_000);
    vi.advanceTimersByTime(2_000);
    expect(rd.signal.aborted).toBe(true);
    expect(parent.signal.aborted).toBe(false);
    expect(parent.remaining()).toBe(58_000);
    parent.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts when the parent is aborted, and is born aborted under an aborted parent", () => {
    const parent = createDeadline(60_000);
    const rd = deriveDeadline(parent, 30_000);
    parent.abort("gate budget exhausted");
    expect(rd.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    const late = deriveDeadline(parent, 30_000);
    expect(late.signal.aborted).toBe(true);
    expect(late.remaining()).toBe(0);
  });

  it("dispose() clears its timer", () => {
    const parent = createDeadline(60_000);
    const rd = deriveDeadline(parent, 30_000);
    expect(vi.getTimerCount()).toBe(2);
    rd.dispose();
    parent.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("recheck helpers", () => {
  it("RECHECK_MIN_REMAINING_MS is 10 s", () => {
    expect(RECHECK_MIN_REMAINING_MS).toBe(10_000);
  });

  it.each([
    ["src/a.test.ts > suite > case", "src/a.test.ts"],
    ["tests/test_x.py::TestCls::test_y", "tests/test_x.py"],
    ["src/b.test.ts", "src/b.test.ts"],
    ["src\\c.test.ts > x", "src/c.test.ts"],
    ["pkg/a.test.ts > has :: in name", "pkg/a.test.ts"],
    ["a.test.ts > suite > t", "a.test.ts"],
    ["tests/test_x.py::test_cmp[1 > 0]", "tests/test_x.py"],
    ["tests\\test_x.py::TestA::test_cmp[a > b > c]", "tests/test_x.py"],
    ["tests/test_x.py::test_cmp[1 > 0 :: x]", "tests/test_x.py"],
  ])("fileKeyOfId(%j) = %j", (id, key) => {
    expect(fileKeyOfId(id)).toBe(key);
  });

  it("lists the inert entries of T4.f", () => {
    expect(INERT_UNREPRODUCED).toContain("coverage/");
    expect(INERT_UNREPRODUCED).toContain("*.pyc");
  });

  it.each([
    ["coverage/", "linux", true],
    ["packages/web/coverage/", "linux", true],
    ["__pycache__/", "linux", true],
    ["logs/", "linux", true],
    ["debug.log", "linux", true],
    ["a/b/mod.cpython-312.pyc", "linux", true],
    [".DS_Store", "linux", true],
    ["Thumbs.db", "linux", true],
    ["COVERAGE/", "win32", true],
    ["THUMBS.DB", "win32", true],
    ["Debug.LOG", "win32", true],
    ["COVERAGE/", "linux", false],
    ["coverage", "linux", false],
    ["logs.txt", "linux", false],
    [".log", "linux", false],
    ["debug.log/", "linux", false],
    [".env", "linux", false],
    [".env.local", "linux", false],
    ["dist/", "linux", false],
    ["build/", "linux", false],
    [".next/", "linux", false],
    ["coverage/lcov.info", "linux", false],
    ["", "linux", false],
    // QA-2.1-10: anchored at the reference root, a package root, or anywhere, per pattern.
    ["test/fixtures/logs/", "linux", false],
    ["src/logs/", "linux", false],
    ["logs/debug.log", "linux", false],
    ["test/fixtures/app.log", "linux", false],
    ["TEST/Fixtures/App.LOG", "win32", false],
    ["sub/.vscode/", "linux", false],
    ["packages/web/.eslintcache", "linux", false],
    ["packages/web/.nyc_output/", "linux", true],
    ["Packages/Web/COVERAGE/", "win32", true],
    ["test/fixtures/coverage/", "linux", false],
    ["packages/web/test/coverage/", "linux", false],
    ["src/coverage/", "linux", false],
    ["a/b/c/coverage/", "linux", false],
    ["tests/__pycache__/", "linux", true],
    ["test/fixtures/.DS_Store", "linux", true],
  ] as const)("isInertUnreproduced(%j, %s) = %s", (entry, platform, inert) => {
    expect(isInertUnreproduced(entry, platform)).toBe(inert);
  });
});

describe("createScopeOpener", () => {
  const TMP = process.platform === "win32" ? "C:\\omr-tmp" : "/omr-tmp";
  const REPORT = join(TMP, "omr-verify-00000000-0000-4000-8000-000000000000.json");
  const HOST = { platform: process.platform, tmpdir: TMP };
  const BUDGET: VerifyBudget = {
    testScope: "affected",
    maxWorkers: 2,
    lowPriority: true,
    maxConcurrentVerifications: 1,
    defaultVerify: "required",
    captureWaitMs: 5_000,
    background: false,
    pendingTtlMs: 600_000,
    slotWaitMs: 60_000,
    batchWindowMs: 250,
    failureRecheck: true,
    recheckTimeoutMs: 120_000,
    baselineTimeoutMs: 60_000,
    gateBudgetMs: 300_000,
  };
  const SPEC: ScopedSpec = {
    runner: "vitest",
    mode: "related",
    file: "node",
    args: ["vitest.mjs", "related", "src/a.ts"],
    cwd: join(TMP, "repo"),
    env: { OMR_SCOPED: "1" },
    reportPath: REPORT,
    gitRoot: join(TMP, "repo"),
    entry: "vitest.mjs",
    inputs: ["src/a.ts"],
    inputsAreTests: false,
    workers: 2,
    notes: ["planner note"],
  };

  interface FakeDeadline extends Deadline {
    left: number;
    abort(): void;
  }
  function fakeDeadline(left: number): FakeDeadline {
    const controller = new AbortController();
    const d: FakeDeadline = {
      budgetMs: left,
      left,
      remaining: () => (controller.signal.aborted ? 0 : d.left),
      bound: ms => Math.min(ms, d.remaining()),
      signal: controller.signal,
      abort: () => controller.abort(new Error("gate budget exhausted")),
    };
    return d;
  }

  function setup(opts: { acquire?: typeof acquireSlot; argv?: ArgvSeam; now?: () => number } = {}) {
    const release = vi.fn(async (): Promise<void> => {});
    const handle = { release, lost: false };
    const acquire = vi.fn<typeof acquireSlot>(opts.acquire ?? (async () => handle));
    const argv = vi.fn<ArgvSeam>(opts.argv ?? (async () => ({ code: 0, stdout: " Test Files  1 passed (1)\n Tests  3 passed (3)\n", stderr: "" })));
    const exec = vi.fn<ExecSeam>(async () => ({ code: 0, stdout: "", stderr: "" }));
    const unlink = vi.fn(async (_path: string): Promise<void> => {});
    const fs: RunnerFs = {
      fileExists: async () => false,
      readFile: async (p: string) => { throw new Error(`ENOENT: ${p}`); },
      unlink,
    };
    const warn = vi.fn();
    const open = createScopeOpener({
      argv, exec, fs, acquire, budget: BUDGET, checkTimeoutMs: 120_000, host: HOST, logger: { warn },
      ...(opts.now ? { now: opts.now } : {}),
    });
    const scope = open({ cwd: SPEC.cwd, command: "npx vitest run" });
    return { scope, acquire, argv, exec, unlink, release, handle, warn };
  }

  it("reports a busy slot with the time waited, spawns nothing and does not wait again", async () => {
    let t = 1_000;
    const s = setup({ now: () => t, acquire: async () => { t += 1_500; return { busy: true }; } });
    const d = fakeDeadline(100_000);
    const first = await s.scope.execute(SPEC, d);
    expect(first).toEqual({ kind: "slot-busy", waitedMs: 1_500, deadlineCut: false });
    expect(await s.scope.execute(SPEC, d)).toEqual(first);
    expect(s.acquire).toHaveBeenCalledTimes(1);
    expect(s.argv).not.toHaveBeenCalled();
    expect(s.unlink).not.toHaveBeenCalled();
  });

  it("bounds the slot wait by the deadline and marks a deadline-cut wait", async () => {
    const d = fakeDeadline(5_000);
    const s = setup({ acquire: async opts => { d.left = 0; d.abort(); expect(opts.signal).toBe(d.signal); return { busy: true }; } });
    expect(await s.scope.execute(SPEC, d)).toMatchObject({ kind: "slot-busy", deadlineCut: true });
    expect(s.acquire.mock.calls[0]?.[0]).toMatchObject({
      max: BUDGET.maxConcurrentVerifications,
      waitMs: 5_000,
      meta: { cwd: SPEC.cwd, command: "npx vitest run" },
    });
    expect(s.argv).not.toHaveBeenCalled();
  });

  it("labels a busy wait the deadline bounded as a deadline cut even when the wait's timer fired before remaining() read 0 (QA-3.1-12, 9053dd8)", async () => {
    // The deadline leaves 2 500 ms, less than slotWaitMs, so it bounds the wait. The slot's own
    // timer fires a few ms early: the busy answer arrives while remaining() still reads 3 ms.
    let t = 10_000;
    const d = fakeDeadline(2_500);
    const s = setup({ now: () => t, acquire: async () => { t += 2_497; d.left = 3; return { busy: true }; } });
    expect(await s.scope.execute(SPEC, d)).toEqual({ kind: "slot-busy", waitedMs: 2_497, deadlineCut: true });
    expect(s.acquire.mock.calls[0]?.[0]).toMatchObject({ waitMs: 2_500 });
    expect(d.signal.aborted).toBe(false);
    expect(s.argv).not.toHaveBeenCalled();
    // The same early answer to a wait that slotWaitMs bounded (the deadline leaves more) is busy.
    let u = 10_000;
    const roomy = fakeDeadline(BUDGET.slotWaitMs + 10_000);
    const busy = setup({ now: () => u, acquire: async () => { u += BUDGET.slotWaitMs - 3; roomy.left = 10_003; return { busy: true }; } });
    expect(await busy.scope.execute(SPEC, roomy)).toEqual({ kind: "slot-busy", waitedMs: BUDGET.slotWaitMs - 3, deadlineCut: false });
  });

  it("hold() takes the scope's one hold without spawning; the next execute reuses it, and a failed hold answers it (QA-2.2-25)", async () => {
    const held = setup();
    const d = fakeDeadline(100_000);
    const hold = held.scope.hold;
    if (hold === undefined) throw new Error("createScopeOpener's scope has hold()");
    expect(await hold(fakeDeadline(4_000))).toBe(true);
    expect(held.acquire.mock.calls[0]?.[0]).toMatchObject({ waitMs: 4_000 });
    expect(held.argv).not.toHaveBeenCalled();
    expect(await held.scope.execute(SPEC, d)).toMatchObject({ kind: "ran" });
    expect(await hold(d)).toBe(true);
    expect(held.acquire).toHaveBeenCalledTimes(1);
    await held.scope.close();
    expect(held.release).toHaveBeenCalledTimes(1);
    expect(await hold(d)).toBe(false);
    expect(held.acquire).toHaveBeenCalledTimes(1);

    const busy = setup({ acquire: async () => ({ busy: true }) });
    const busyHold = busy.scope.hold;
    if (busyHold === undefined) throw new Error("createScopeOpener's scope has hold()");
    expect(await busyHold(d)).toBe(false);
    expect(await busy.scope.execute(SPEC, d)).toMatchObject({ kind: "slot-busy", deadlineCut: false });
    expect(busy.acquire).toHaveBeenCalledTimes(1);
    expect(busy.argv).not.toHaveBeenCalled();
  });

  it("never acquires or spawns once the deadline has aborted", async () => {
    const s = setup();
    const d = fakeDeadline(100_000);
    d.abort();
    expect(await s.scope.execute(SPEC, d)).toEqual({ kind: "slot-busy", waitedMs: 0, deadlineCut: true });
    expect(s.acquire).not.toHaveBeenCalled();
    expect(s.argv).not.toHaveBeenCalled();
  });

  it("spawns nothing after an abort while the slot is held", async () => {
    const s = setup();
    const d = fakeDeadline(100_000);
    expect((await s.scope.execute(SPEC, d)).kind).toBe("ran");
    d.abort();
    expect(await s.scope.execute(SPEC, d)).toEqual({ kind: "aborted", reason: ABORTED_BEFORE_RUN });
    expect(await s.scope.runShell("npm run build", SPEC.cwd, d)).toEqual({ kind: "aborted", reason: ABORTED_BEFORE_RUN });
    expect(s.argv).toHaveBeenCalledTimes(1);
    expect(s.exec).not.toHaveBeenCalled();
  });

  it("reports a timeout with its bound and aborts the signal the argv seam received", async () => {
    let seen: AbortSignal | undefined;
    const s = setup({ argv: async (_f, _a, o) => { seen = o?.signal; return { code: 1, stdout: "", stderr: "", timedOut: true }; } });
    const d = fakeDeadline(30_000);
    const out = await s.scope.execute(SPEC, d);
    expect(out).toMatchObject({ kind: "timed-out", boundMs: 30_000 });
    expect(seen?.aborted).toBe(true);
    expect(d.signal.aborted).toBe(false);
    expect(s.unlink).toHaveBeenCalledWith(REPORT);
  });

  it("reports aborted when the deadline fires during the run, and the seam signal follows it", async () => {
    let seen: AbortSignal | undefined;
    const d = fakeDeadline(30_000);
    const s = setup({ argv: async (_f, _a, o) => { seen = o?.signal; d.abort(); return { code: 1, stdout: "", stderr: "", timedOut: true }; } });
    expect(await s.scope.execute(SPEC, d)).toEqual({ kind: "aborted", reason: ABORTED_DURING_RUN });
    expect(seen?.aborted).toBe(true);
    expect(s.unlink).toHaveBeenCalledWith(REPORT);
  });

  it("still runs readResult (deleting the report) when the argv seam throws", async () => {
    let seen: AbortSignal | undefined;
    const s = setup({ argv: async (_f, _a, o) => { seen = o?.signal; throw new Error("spawn EACCES"); } });
    const out = await s.scope.execute(SPEC, fakeDeadline(30_000));
    expect(out.kind).toBe("error");
    expect(out.kind === "error" ? out.reason : "").toContain("spawn EACCES");
    expect(s.unlink).toHaveBeenCalledWith(REPORT);
    expect(seen?.aborted).toBe(true);
  });

  it("notes a slot reclaimed during the run and warns", async () => {
    const release = vi.fn(async (): Promise<void> => {});
    const s = setup({ acquire: async opts => { opts.onLost?.(); return { release, lost: true }; } });
    const out = await s.scope.execute(SPEC, fakeDeadline(30_000));
    expect(out.kind).toBe("ran");
    expect(out.kind === "ran" ? out.notes : []).toEqual(expect.arrayContaining(["planner note", SLOT_LOST_NOTE]));
    expect(s.warn).toHaveBeenCalledWith(expect.stringContaining(SLOT_LOST_NOTE));
  });

  it("passes cwd, env, lowPriority and the bounded timeout to the argv seam", async () => {
    const s = setup();
    const out = await s.scope.execute(SPEC, fakeDeadline(50_000));
    expect(out).toMatchObject({ kind: "ran", exitCode: 0, spec: SPEC });
    expect(s.argv).toHaveBeenCalledTimes(1);
    const [file, args, o] = s.argv.mock.calls[0] ?? [];
    expect(file).toBe(SPEC.file);
    expect(args).toEqual(SPEC.args);
    expect(o).toMatchObject({ cwd: SPEC.cwd, env: { OMR_SCOPED: "1" }, lowPriority: true, timeoutMs: 50_000 });
    expect(o?.signal).toBeInstanceOf(AbortSignal);
    expect(s.unlink).toHaveBeenCalledWith(REPORT);
  });

  it("acquires exactly one slot per scope across several runs", async () => {
    const s = setup();
    const d = fakeDeadline(100_000);
    await Promise.all([s.scope.execute(SPEC, d), s.scope.execute(SPEC, d)]);
    await s.scope.execute(SPEC, d);
    const shell = await s.scope.runShell("npm run build", SPEC.cwd, d);
    expect(shell.kind).toBe("ran");
    expect(s.exec.mock.calls[0]?.[1]).toMatchObject({ cwd: SPEC.cwd, lowPriority: true, timeoutMs: 100_000 });
    expect(s.acquire).toHaveBeenCalledTimes(1);
    expect(s.argv).toHaveBeenCalledTimes(3);
  });

  it("releases the hold once on close and refuses runs afterwards", async () => {
    const s = setup();
    const d = fakeDeadline(100_000);
    await s.scope.execute(SPEC, d);
    await Promise.all([s.scope.close(), s.scope.close()]);
    await s.scope.close();
    expect(s.release).toHaveBeenCalledTimes(1);
    expect((await s.scope.execute(SPEC, d)).kind).toBe("error");
    expect(s.argv).toHaveBeenCalledTimes(1);
  });

  it("close without a run acquires nothing", async () => {
    const s = setup();
    await s.scope.close();
    expect(s.acquire).not.toHaveBeenCalled();
    expect(s.release).not.toHaveBeenCalled();
  });

  it("never rejects: slot errors become error outcomes", async () => {
    const s = setup({ acquire: async () => { throw new Error("EPERM lock"); } });
    const d = fakeDeadline(100_000);
    await expect(s.scope.execute(SPEC, d)).resolves.toMatchObject({ kind: "error" });
    await expect(s.scope.runLint({ ...SPEC, runner: "eslint" }, d)).resolves.toMatchObject({ kind: "error" });
    await expect(s.scope.close()).resolves.toBeUndefined();
    expect(s.argv).not.toHaveBeenCalled();
  });
});

describe("scope.rechecker (T4)", () => {
  const TMP = process.platform === "win32" ? "C:\\omr-tmp" : "/omr-tmp";
  const ROOT = join(TMP, "repo");
  const REF_DIR = join(TMP, "omr-ref-1-0123456789abcdef");
  const HOST = { platform: process.platform, tmpdir: TMP };
  const BUDGET: VerifyBudget = {
    testScope: "affected",
    maxWorkers: 2,
    lowPriority: true,
    maxConcurrentVerifications: 1,
    defaultVerify: "required",
    captureWaitMs: 5_000,
    background: false,
    pendingTtlMs: 600_000,
    slotWaitMs: 60_000,
    batchWindowMs: 250,
    failureRecheck: true,
    recheckTimeoutMs: 120_000,
    baselineTimeoutMs: 60_000,
    gateBudgetMs: 300_000,
  };
  const REFERENCE: DispatchReference = {
    root: ROOT,
    head: "a".repeat(40),
    commit: "b".repeat(40),
    untracked: new Map(),
    tracked: new Map(),
    captureReasons: [],
    capturedAt: 0,
  };
  const RUNNER: DetectedRunner = {
    kind: "vitest",
    launcher: "npx",
    source: { type: "command" },
    gitRoot: ROOT,
    runnerCwd: ROOT,
    env: {},
    keptArgs: ["run"],
    pathScopes: [],
    xdist: false,
    covInConfig: false,
    notes: [],
  };
  const ENTRY: ResolvedEntry = { file: "node", prefix: ["vitest.mjs"], entry: join(ROOT, "node_modules", "vitest", "vitest.mjs") };
  const FAIL_A = join(ROOT, "test", "a.test.ts");
  const FAIL_B = join(ROOT, "test", "b.test.ts");
  const OUTSIDE = join(TMP, "elsewhere", "c.test.ts");
  const toRefPath = (p: string): string | undefined =>
    p.startsWith(ROOT + (process.platform === "win32" ? "\\" : "/")) || p === ROOT ? REF_DIR + p.slice(ROOT.length) : undefined;
  const GOOD: RunResult = {
    failingIds: ["test/a.test.ts > fails"],
    failingFiles: [join(REF_DIR, "test", "a.test.ts")],
    collectionError: false,
    total: 3,
    complete: true,
    source: "report",
  };

  function deadline(left: number): Deadline & { abort(): void } {
    const controller = new AbortController();
    return {
      budgetMs: left,
      remaining: () => (controller.signal.aborted ? 0 : left),
      bound: ms => Math.min(ms, controller.signal.aborted ? 0 : left),
      signal: controller.signal,
      abort: () => controller.abort(new Error("gate budget exhausted")),
    };
  }

  const notUsed = (name: string) => async (): Promise<never> => { throw new Error(`unexpected ${name}`); };

  interface Opts {
    materialized?: { exact?: boolean; unreproduced?: string[] };
    materializeResult?: MaterializeResult;
    existing?: string[];
    result?: RunResult;
    argv?: ArgvSeam;
    acquire?: typeof acquireSlot;
    vanished?: boolean;
    recheck?: Partial<RecheckSeams>;
  }

  function setup(opts: Opts = {}) {
    const events: string[] = [];
    let held = false;
    const release = vi.fn(async (): Promise<void> => { events.push("release"); held = false; });
    const acquire = vi.fn<typeof acquireSlot>(opts.acquire ?? (async () => { events.push("acquire"); held = true; return { release, lost: false }; }));
    const argv = vi.fn<ArgvSeam>(opts.argv ?? (async () => { events.push("argv"); return { code: 1, stdout: "", stderr: "" }; }));
    const exec = vi.fn<ExecSeam>(async () => ({ code: 0, stdout: "", stderr: "" }));
    const existing = new Set(opts.existing ?? [join(REF_DIR, "test", "a.test.ts"), join(REF_DIR, "test", "b.test.ts")]);
    const fs: RunnerFs = {
      fileExists: async p => existing.has(p),
      readFile: async (p: string) => { throw new Error(`ENOENT: ${p}`); },
      unlink: async () => {},
    };
    const stats: ReferenceStats = { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, size: 0, mode: 0o700, mtimeMs: 0 };
    const refFs: ReferenceFs = {
      lstat: async p => {
        if (opts.vanished === true) throw new Error(`ENOENT: ${p}`);
        return stats;
      },
      realpath: notUsed("realpath"),
      readFile: notUsed("readFile"),
      writeFile: notUsed("writeFile"),
      mkdir: notUsed("mkdir"),
      chmod: notUsed("chmod"),
      readdir: notUsed("readdir"),
      symlink: notUsed("symlink"),
      unlink: notUsed("unlink"),
      utimes: notUsed("utimes"),
      rm: notUsed("rm"),
    };
    const dispose = vi.fn(async (): Promise<void> => { events.push("dispose"); });
    const materializedWhileHeld: boolean[] = [];
    const materialize = vi.fn<RecheckSeams["materialize"]>(async () => {
      events.push("materialize");
      materializedWhileHeld.push(held);
      if (opts.materializeResult) return opts.materializeResult;
      const exact = opts.materialized?.exact ?? true;
      return {
        ok: true,
        reference: {
          dir: REF_DIR,
          exact,
          inexactReasons: exact ? [] : [{ cause: "dependency-drift", path: "package-lock.json" }],
          unreproduced: opts.materialized?.unreproduced ?? [],
          links: [],
          toRefPath,
          dispose,
        },
      };
    });
    const gcStaleReferences = vi.fn<RecheckSeams["gcStaleReferences"]>(async () => {
      events.push("gc");
      return { removed: [], kept: [], failed: [] };
    });
    const detectRunner = vi.fn<RecheckSeams["detectRunner"]>(async () => RUNNER);
    const resolveEntry = vi.fn<RecheckSeams["resolveEntry"]>(async () => ENTRY);
    const planRerun = vi.fn<RecheckSeams["planRerun"]>(async (_runner, files, cwd) => ({
      runner: "vitest",
      mode: "rerun",
      file: "node",
      args: ["vitest.mjs", "run", ...files],
      cwd,
      env: { OMR: "1" },
      reportPath: join(TMP, "report.json"),
      gitRoot: REF_DIR,
      entry: ENTRY.entry,
      inputs: [...files],
      inputsAreTests: true,
      workers: 2,
      notes: [],
    }));
    const readResult = vi.fn<RecheckSeams["readResult"]>(async () => { events.push("readResult"); return opts.result ?? GOOD; });
    const warn = vi.fn();
    const open = createScopeOpener({
      argv, exec, fs, acquire, budget: BUDGET, checkTimeoutMs: 120_000, host: HOST, logger: { warn },
      reference: { fs: refFs },
      recheck: { materialize, gcStaleReferences, detectRunner, resolveEntry, planRerun, readResult, ...opts.recheck },
    });
    const scope = open({ cwd: ROOT, command: "npx vitest run" });
    const recheck = scope.rechecker("npx vitest run", ROOT);
    return {
      scope, recheck, events, acquire, argv, release, dispose, materialize, materializedWhileHeld, gcStaleReferences,
      detectRunner, resolveEntry, planRerun, readResult, warn,
    };
  }

  it("skips below the recheck threshold without detecting, acquiring, materializing or spawning", async () => {
    const s = setup();
    const out = await s.recheck(REFERENCE, [FAIL_A], deadline(RECHECK_MIN_REMAINING_MS - 1));
    expect(out).toEqual({ kind: "skipped-deadline", remainingMs: RECHECK_MIN_REMAINING_MS - 1 });
    expect(s.detectRunner).not.toHaveBeenCalled();
    expect(s.acquire).not.toHaveBeenCalled();
    expect(s.materialize).not.toHaveBeenCalled();
    expect(s.argv).not.toHaveBeenCalled();
  });

  it("forwards the current tree snapshot to materialize, and undefined when none is given", async () => {
    const tree: TreeSnapshot = { cwd: ROOT, head: "a".repeat(40), fingerprint: "fp", dirty: true, files: [] };
    const s = setup();
    await s.scope.rechecker("npx vitest run", ROOT, tree)(REFERENCE, [FAIL_A], deadline(300_000));
    await s.recheck(REFERENCE, [FAIL_A], deadline(300_000));
    expect(s.materialize).toHaveBeenCalledTimes(2);
    expect(s.materialize.mock.calls[0][1]).toBe(tree);
    expect(s.materialize.mock.calls[1][1]).toBeUndefined();
    await s.scope.close();
  });

  it("reports pytest as runner-unsupported without materializing or rerunning", async () => {
    const s = setup({ recheck: { detectRunner: async () => ({ ...RUNNER, kind: "pytest" }) } });
    const out = await s.recheck(REFERENCE, [FAIL_A], deadline(200_000));
    expect(out).toMatchObject({ kind: "unusable", cause: "runner-unsupported" });
    expect(s.gcStaleReferences).not.toHaveBeenCalled();
    expect(s.materialize).not.toHaveBeenCalled();
    expect(s.argv).not.toHaveBeenCalled();
  });

  it("reports an S6 from detectRunner as rerun-unplannable", async () => {
    const s = setup({ recheck: { detectRunner: async () => ({ unverifiable: true, code: "no-git-root", reason: "no git repository" }) } });
    expect(await s.recheck(REFERENCE, [FAIL_A], deadline(200_000))).toMatchObject({ kind: "unusable", cause: "rerun-unplannable" });
    expect(s.materialize).not.toHaveBeenCalled();
  });

  it("GCs, then materializes inside the hold, reruns only files present at the reference and disposes before release", async () => {
    const s = setup({ existing: [join(REF_DIR, "test", "a.test.ts")] });
    const d = deadline(200_000);
    const out = await s.recheck(REFERENCE, [FAIL_A, FAIL_B, OUTSIDE], d);
    expect(out).toEqual({ kind: "exact", result: GOOD, ranFiles: ["test/a.test.ts"], absentFiles: ["test/b.test.ts"], notes: [] });
    expect(s.materializedWhileHeld).toEqual([true]);
    expect(s.gcStaleReferences.mock.calls[0]?.[0]).toBe(ROOT);
    expect(s.gcStaleReferences.mock.calls[0]?.[1].timeoutMs).toBeLessThanOrEqual(5_000);
    expect(s.planRerun).toHaveBeenCalledWith(RUNNER, [join(REF_DIR, "test", "a.test.ts")], REF_DIR, { maxWorkers: 2 }, expect.objectContaining({ entry: ENTRY }));
    expect(s.resolveEntry.mock.calls[0]?.[1]).toBe(ROOT);
    const argvOpts = s.argv.mock.calls[0]?.[2];
    expect(argvOpts).toMatchObject({ cwd: REF_DIR, lowPriority: true, env: { OMR: "1" } });
    expect(argvOpts?.timeoutMs).toBeGreaterThan(0);
    expect(argvOpts?.timeoutMs).toBeLessThanOrEqual(BUDGET.recheckTimeoutMs);
    await s.scope.close();
    expect(s.events).toEqual(["acquire", "gc", "materialize", "argv", "readResult", "dispose", "release"]);
    expect(s.acquire).toHaveBeenCalledTimes(1);
  });

  it("shares the scope's hold with an earlier scoped run", async () => {
    const s = setup();
    const d = deadline(200_000);
    await s.scope.runShell("npm run build", ROOT, d);
    await s.recheck(REFERENCE, [FAIL_A], d);
    expect(s.acquire).toHaveBeenCalledTimes(1);
    await s.scope.close();
  });

  it("returns exact with no result when every failing file is absent at the reference", async () => {
    const s = setup({ existing: [] });
    const out = await s.recheck(REFERENCE, [FAIL_A, FAIL_B], deadline(200_000));
    expect(out).toEqual({ kind: "exact", result: undefined, ranFiles: [], absentFiles: ["test/a.test.ts", "test/b.test.ts"], notes: [] });
    expect(s.argv).not.toHaveBeenCalled();
    expect(s.dispose).toHaveBeenCalledTimes(1);
  });

  it("returns approximate with the inexact reasons, reruns nothing and disposes", async () => {
    const s = setup({ materialized: { exact: false } });
    const out = await s.recheck(REFERENCE, [FAIL_A], deadline(200_000));
    expect(out).toEqual({ kind: "approximate", inexactReasons: [{ cause: "dependency-drift", path: "package-lock.json" }] });
    expect(s.argv).not.toHaveBeenCalled();
    expect(s.dispose).toHaveBeenCalledTimes(1);
  });

  it("refuses a reference missing a non-inert ignored input, and reruns when only inert ones are missing", async () => {
    const bad = setup({ materialized: { unreproduced: ["coverage/", ".env"] } });
    const out = await bad.recheck(REFERENCE, [FAIL_A], deadline(200_000));
    expect(out).toMatchObject({ kind: "unusable", cause: "unreproduced-inputs" });
    expect(out.kind === "unusable" ? out.reason : "").toContain(".env");
    expect(bad.argv).not.toHaveBeenCalled();
    expect(bad.dispose).toHaveBeenCalledTimes(1);

    const inert = setup({ materialized: { unreproduced: ["coverage/", "logs/", "debug.log"] } });
    expect((await inert.recheck(REFERENCE, [FAIL_A], deadline(200_000))).kind).toBe("exact");
    expect(inert.argv).toHaveBeenCalledTimes(1);
  });

  it.each<[string, MaterializeResult, RecheckUnusableCause]>([
    ["commit-missing", { ok: false, reason: "commit-missing", detail: "no such commit" }, "reference-vanished"],
    ["worktree-add-failed", { ok: false, reason: "worktree-add-failed", detail: "git failed" }, "materialize-failed"],
    ["aborted", { ok: false, reason: "aborted", detail: "signal aborted" }, "materialize-failed"],
  ])("maps a %s materialize failure to %s", async (_name, materializeResult, cause) => {
    const s = setup({ materializeResult });
    expect(await s.recheck(REFERENCE, [FAIL_A], deadline(200_000))).toMatchObject({ kind: "unusable", cause });
    expect(s.argv).not.toHaveBeenCalled();
    expect(s.dispose).not.toHaveBeenCalled();
  });

  it.each<[string, RunResult, RecheckUnusableCause]>([
    ["incomplete", { ...GOOD, complete: false }, "incomplete"],
    ["a collection error", { ...GOOD, collectionError: true }, "collection-error"],
    ["zero tests", { ...GOOD, total: 0 }, "no-tests"],
  ])("refuses a rerun with %s", async (_name, result, cause) => {
    const s = setup({ result });
    expect(await s.recheck(REFERENCE, [FAIL_A], deadline(200_000))).toMatchObject({ kind: "unusable", cause });
    expect(s.dispose).toHaveBeenCalledTimes(1);
  });

  it("reports a reference dir that vanished during the rerun", async () => {
    const s = setup({ vanished: true });
    expect(await s.recheck(REFERENCE, [FAIL_A], deadline(200_000))).toMatchObject({ kind: "unusable", cause: "reference-vanished" });
    expect(s.readResult).toHaveBeenCalledTimes(1);
    expect(s.dispose).toHaveBeenCalledTimes(1);
  });

  it("reports a rerun timeout with its bound and still reads the result and disposes", async () => {
    const s = setup({ argv: async () => ({ code: -1, stdout: "", stderr: "", timedOut: true }) });
    const out = await s.recheck(REFERENCE, [FAIL_A], deadline(200_000));
    expect(out.kind).toBe("timed-out");
    expect(out.kind === "timed-out" ? out.boundMs : 0).toBeGreaterThan(0);
    expect(s.readResult).toHaveBeenCalledTimes(1);
    expect(s.dispose).toHaveBeenCalledTimes(1);
  });

  it("maps unplannable reruns: entry S6, planRerun S6 and NoAffected", async () => {
    const s6 = { unverifiable: true as const, code: "node-not-found" as const, reason: "node not found" };
    const a = setup({ recheck: { resolveEntry: async () => s6 } });
    expect(await a.recheck(REFERENCE, [FAIL_A], deadline(200_000))).toMatchObject({ kind: "unusable", cause: "rerun-unplannable" });
    const b = setup({ recheck: { planRerun: async () => s6 } });
    expect(await b.recheck(REFERENCE, [FAIL_A], deadline(200_000))).toMatchObject({ kind: "unusable", cause: "rerun-unplannable" });
    const c = setup({ recheck: { planRerun: async () => ({ noAffected: true, note: "nothing" }) } });
    expect(await c.recheck(REFERENCE, [FAIL_A], deadline(200_000))).toMatchObject({ kind: "unusable", cause: "rerun-unplannable" });
    for (const s of [a, b, c]) {
      expect(s.argv).not.toHaveBeenCalled();
      expect(s.dispose).toHaveBeenCalledTimes(1);
    }
  });

  it("never rejects: spawn, readResult, slot and seam errors become unusable error", async () => {
    const outcomes: RecheckOutcome[] = [];
    const spawn = setup({ argv: async () => { throw new Error("spawn EACCES"); } });
    outcomes.push(await spawn.recheck(REFERENCE, [FAIL_A], deadline(200_000)));
    const read = setup({ recheck: { readResult: async () => { throw new Error("EIO"); } } });
    outcomes.push(await read.recheck(REFERENCE, [FAIL_A], deadline(200_000)));
    const busy = setup({ acquire: async () => ({ busy: true }) });
    outcomes.push(await busy.recheck(REFERENCE, [FAIL_A], deadline(200_000)));
    const thrown = setup({ recheck: { materialize: async () => { throw new Error("boom"); } } });
    outcomes.push(await thrown.recheck(REFERENCE, [FAIL_A], deadline(200_000)));
    for (const out of outcomes) expect(out).toMatchObject({ kind: "unusable", cause: "error" });
    expect(busy.materialize).not.toHaveBeenCalled();
    expect(spawn.dispose).toHaveBeenCalledTimes(1);
    expect(read.dispose).toHaveBeenCalledTimes(1);
  });

  it("reports skipped-deadline when the deadline aborts before the rerun spawns", async () => {
    const d = deadline(200_000);
    const s = setup({ recheck: { planRerun: async (_r, files, cwd) => { d.abort(); return {
      runner: "vitest", mode: "rerun", file: "node", args: [...files], cwd, env: {}, reportPath: join(TMP, "r.json"),
      gitRoot: REF_DIR, entry: ENTRY.entry, inputs: [...files], inputsAreTests: true, workers: 2, notes: [],
    }; } } });
    expect((await s.recheck(REFERENCE, [FAIL_A], d)).kind).toBe("skipped-deadline");
    expect(s.argv).not.toHaveBeenCalled();
    expect(s.dispose).toHaveBeenCalledTimes(1);
  });
});

describe("createDirectTestsPassHook (2.1.2.4)", () => {
  const TMP = process.platform === "win32" ? "C:\\omr-tmp" : "/omr-tmp";
  const ROOT = join(TMP, "repo");
  const FILE_A = join(ROOT, "test", "a.test.ts");
  const FILE_B = join(ROOT, "test", "b.test.ts");
  const REFERENCE: DispatchReference = {
    root: ROOT,
    head: "a".repeat(40),
    commit: "b".repeat(40),
    untracked: new Map(),
    tracked: new Map(),
    captureReasons: [],
    capturedAt: 0,
  };
  const TREE: TreeSnapshot = { cwd: ROOT, head: "a".repeat(40), fingerprint: "fp", dirty: true, files: [] };
  const SPEC: ScopedSpec = {
    runner: "vitest",
    mode: "related",
    file: "node",
    args: ["vitest.mjs", "related", "--run", FILE_A],
    cwd: ROOT,
    env: {},
    reportPath: join(TMP, "report.json"),
    gitRoot: ROOT,
    entry: join(ROOT, "node_modules", "vitest", "vitest.mjs"),
    inputs: [FILE_A],
    inputsAreTests: false,
    workers: 2,
    notes: [],
  };
  const GREEN: RunResult = { failingIds: [], failingFiles: [], collectionError: false, total: 4, complete: true, source: "report" };
  const FAILING: RunResult = {
    failingIds: ["test/a.test.ts > fails"],
    failingFiles: [FILE_A],
    collectionError: false,
    total: 4,
    complete: true,
    source: "report",
  };
  const EXACT: RecheckOutcome = { kind: "exact", result: undefined, ranFiles: [], absentFiles: ["test/a.test.ts"], notes: [] };

  function deadline(left: number): Deadline {
    const controller = new AbortController();
    return { budgetMs: left, remaining: () => left, bound: ms => Math.min(ms, left), signal: controller.signal };
  }

  interface Opts {
    plan?: ScopingPlan | Error;
    scoped?: ScopedOutcome | Error;
    shell?: CommandOutcome;
    live?: string[];
    failureRecheck?: boolean;
  }

  function setup(opts: Opts = {}) {
    const rechecker = vi.fn<Rechecker>(async () => EXACT);
    const execute = vi.fn<CheckScope["execute"]>(async () => {
      if (opts.scoped instanceof Error) throw opts.scoped;
      return opts.scoped ?? { kind: "ran", result: GREEN, exitCode: 0, spec: SPEC, notes: [] };
    });
    const runShell = vi.fn<CheckScope["runShell"]>(async () => opts.shell ?? { kind: "ran", exec: { code: 0, stdout: "", stderr: "" }, notes: [] });
    const runLint = vi.fn<CheckScope["runLint"]>(async () => ({ kind: "error", reason: "unused" }));
    const makeRechecker = vi.fn((_command: string, _cwd: string, _tree?: TreeSnapshot): Rechecker => rechecker);
    const close = vi.fn(async (): Promise<void> => {});
    const scope: CheckScope = { execute, rechecker: makeRechecker, runShell, runLint, close };
    const openScope = vi.fn((_meta: { readonly cwd: string; readonly command: string }): CheckScope => scope);
    const plan = vi.fn(async (_input: PlanScopedRunInput): Promise<ScopingPlan> => {
      if (opts.plan instanceof Error) throw opts.plan;
      return opts.plan ?? SPEC;
    });
    const live = new Set(opts.live ?? [FILE_A, FILE_B]);
    const plannerFs: PlannerFs = {
      fileExists: async p => live.has(p),
      readFile: async (p: string) => { throw new Error(`ENOENT: ${p}`); },
    };
    const search: TestSearchSeam = { findByName: async () => [], findByContent: async () => [] };
    const hook = createDirectTestsPassHook({
      openScope, plannerFs, search, plan, currentTree: TREE,
      budget: { maxWorkers: 2, failureRecheck: opts.failureRecheck ?? true },
      host: { platform: process.platform },
    });
    return { hook, openScope, plan, execute, runShell, makeRechecker, rechecker, close };
  }

  function request(over: Partial<TestsPassRequest> = {}): TestsPassRequest {
    return {
      command: "npx vitest run",
      cwd: ROOT,
      testScope: "affected",
      changedFiles: [{ path: join(ROOT, "src", "a.ts"), status: "modified" }],
      reference: { kind: "captured", reference: REFERENCE },
      deadline: deadline(300_000),
      ...over,
    };
  }

  it("returns no-affected without opening a scope or spawning", async () => {
    const s = setup({ plan: { noAffected: true, note: "no changed files, no affected tests" } });
    expect(await s.hook(request())).toEqual({ scoped: { kind: "no-affected", note: "no changed files, no affected tests" }, recheck: undefined });
    expect(s.openScope).not.toHaveBeenCalled();
    expect(s.execute).not.toHaveBeenCalled();
    expect(s.runShell).not.toHaveBeenCalled();
  });

  it("returns an S6 outcome as unverifiable without opening a scope or spawning", async () => {
    const s = setup({ plan: { unverifiable: true, code: "composite", reason: "composite script" } });
    expect(await s.hook(request())).toEqual({ scoped: { kind: "unverifiable", code: "composite", reason: "composite script" }, recheck: undefined });
    expect(s.openScope).not.toHaveBeenCalled();
    expect(s.execute).not.toHaveBeenCalled();
  });

  it("plans with the injected fs, search, changed files and worker cap", async () => {
    const s = setup();
    const req = request();
    await s.hook(req);
    expect(s.plan).toHaveBeenCalledTimes(1);
    expect(s.plan.mock.calls[0][0]).toMatchObject({ command: req.command, cwd: ROOT, changedFiles: req.changedFiles, budget: { maxWorkers: 2 } });
  });

  it("runs a green scoped spec under one scope without a recheck, then closes", async () => {
    const s = setup();
    const req = request();
    const out = await s.hook(req);
    expect(out.scoped.kind).toBe("ran");
    expect(out.recheck).toBeUndefined();
    expect(s.openScope).toHaveBeenCalledTimes(1);
    expect(s.openScope).toHaveBeenCalledWith({ cwd: ROOT, command: "npx vitest run" });
    expect(s.execute).toHaveBeenCalledWith(SPEC, req.deadline);
    expect(s.makeRechecker).not.toHaveBeenCalled();
    expect(s.rechecker).not.toHaveBeenCalled();
    expect(s.close).toHaveBeenCalledTimes(1);
  });

  it("rechecks only the failing files at a captured reference, forwarding the current tree", async () => {
    const s = setup({ scoped: { kind: "ran", result: FAILING, exitCode: 1, spec: SPEC, notes: [] } });
    const req = request();
    const out = await s.hook(req);
    expect(out.recheck).toBe(EXACT);
    expect(s.makeRechecker).toHaveBeenCalledWith("npx vitest run", ROOT, TREE);
    expect(s.rechecker).toHaveBeenCalledTimes(1);
    expect(s.rechecker).toHaveBeenCalledWith(REFERENCE, [FILE_A], req.deadline);
    expect(s.close).toHaveBeenCalledTimes(1);
  });

  it("reports reference none as unusable no-reference without a Rechecker call", async () => {
    const s = setup({ scoped: { kind: "ran", result: FAILING, exitCode: 1, spec: SPEC, notes: [] } });
    const out = await s.hook(request({ reference: { kind: "none", reason: "the dispatch was not tracked" } }));
    expect(out.recheck).toEqual({ kind: "unusable", cause: "no-reference", reason: "the dispatch was not tracked" });
    expect(s.makeRechecker).not.toHaveBeenCalled();
    expect(s.rechecker).not.toHaveBeenCalled();
  });

  it("reports a disabled reference, or failureRecheck off, as disabled without a Rechecker call", async () => {
    const ran: ScopedOutcome = { kind: "ran", result: FAILING, exitCode: 1, spec: SPEC, notes: [] };
    const a = setup({ scoped: ran });
    expect((await a.hook(request({ reference: { kind: "disabled" } }))).recheck).toEqual({ kind: "disabled" });
    const b = setup({ scoped: ran, failureRecheck: false });
    expect((await b.hook(request())).recheck).toEqual({ kind: "disabled" });
    expect(a.rechecker).not.toHaveBeenCalled();
    expect(b.rechecker).not.toHaveBeenCalled();
  });

  it("does not recheck failing ids without an identified failing file, nor non-ran outcomes", async () => {
    const a = setup({ scoped: { kind: "ran", result: { ...FAILING, failingFiles: [] }, exitCode: 1, spec: SPEC, notes: [] } });
    expect((await a.hook(request())).recheck).toBeUndefined();
    const b = setup({ scoped: { kind: "slot-busy", waitedMs: 5, deadlineCut: false } });
    expect(await b.hook(request())).toEqual({ scoped: { kind: "slot-busy", waitedMs: 5, deadlineCut: false }, recheck: undefined });
    expect(a.rechecker).not.toHaveBeenCalled();
    expect(b.rechecker).not.toHaveBeenCalled();
    expect(b.close).toHaveBeenCalledTimes(1);
  });

  it("full mode runs the resolved command once through runShell, never plans or spawns a spec", async () => {
    const stdout = "FAIL test/a.test.ts > suite > fails\nFAIL test/gone.test.ts > x\n Tests  2 failed | 2 passed (4)\n";
    const s = setup({ shell: { kind: "ran", exec: { code: 1, stdout, stderr: "" }, notes: [] } });
    const req = request({ testScope: "full" });
    const out = await s.hook(req);
    expect(s.runShell).toHaveBeenCalledTimes(1);
    expect(s.runShell).toHaveBeenCalledWith("npx vitest run", ROOT, req.deadline);
    expect(s.plan).not.toHaveBeenCalled();
    expect(s.execute).not.toHaveBeenCalled();
    expect(out.scoped).toEqual({
      kind: "ran",
      exitCode: 1,
      notes: [],
      result: {
        failingIds: ["test/a.test.ts > suite > fails", "test/gone.test.ts > x"],
        failingFiles: [FILE_A],
        collectionError: false,
        total: undefined,
        complete: true,
        source: "text",
      },
    });
    // S2 applies to full too: only the failing files that exist in the live tree are rechecked.
    expect(s.rechecker).toHaveBeenCalledWith(REFERENCE, [FILE_A], req.deadline);
    expect(s.close).toHaveBeenCalledTimes(1);
  });

  it("full mode marks an unconfident parse incomplete and maps shell outcomes", async () => {
    const a = setup({ shell: { kind: "ran", exec: { code: 1, stdout: "boom", stderr: "" }, notes: [] } });
    const out = await a.hook(request({ testScope: "full" }));
    expect(out.scoped.kind === "ran" && out.scoped.result).toMatchObject({ complete: false, collectionError: true, failingIds: [] });
    expect(out.recheck).toBeUndefined();
    const b = setup({ shell: { kind: "timed-out", boundMs: 100, exec: { code: -1, stdout: "", stderr: "", timedOut: true } } });
    expect((await b.hook(request({ testScope: "full" }))).scoped).toEqual({ kind: "timed-out", boundMs: 100 });
  });

  it("never rejects: a throwing planner or executor becomes an error, and an opened scope is closed", async () => {
    const a = setup({ plan: new Error("planner exploded") });
    expect(await a.hook(request())).toEqual({ scoped: { kind: "error", reason: "testsPass hook errored: planner exploded" }, recheck: undefined });
    expect(a.openScope).not.toHaveBeenCalled();
    const b = setup({ scoped: new Error("executor exploded") });
    expect(await b.hook(request())).toEqual({ scoped: { kind: "error", reason: "testsPass hook errored: executor exploded" }, recheck: undefined });
    expect(b.close).toHaveBeenCalledTimes(1);
  });

  describe("a close that outlasts the gate deadline (QA-2.1-3)", () => {
    const failing = (): Opts => ({ scoped: { kind: "ran", result: FAILING, exitCode: 1, spec: SPEC, notes: [] } });
    afterEach(() => { vi.useRealTimers(); });

    it("is awaited until CLOSE_MARGIN_MS before the deadline, and the hook returns its run then", async () => {
      vi.useFakeTimers();
      const s = setup(failing());
      let finish!: () => void;
      s.close.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
      const d = createDeadline(1_000);
      let out: Awaited<ReturnType<typeof s.hook>> | undefined;
      void s.hook(request({ deadline: d })).then(o => { out = o; });
      // Within the budget the close is awaited, so no later check's scope can nest with this hold.
      await vi.advanceTimersByTimeAsync(1_000 - CLOSE_MARGIN_MS - 1);
      expect(out).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(out).toEqual({ scoped: { kind: "ran", result: FAILING, exitCode: 1, spec: SPEC, notes: [] }, recheck: EXACT });
      expect(s.close).toHaveBeenCalledTimes(1);
      finish(); // The close still settles later, in the background.
      d.dispose();
    });

    it("an already spent deadline does not wait at all, and a rejecting close is logged", async () => {
      const warnings: string[] = [];
      const s = setup(failing());
      s.close.mockImplementation(() => Promise.reject(new Error("dispose exploded")));
      const hook = createDirectTestsPassHook({
        openScope: s.openScope, plannerFs: { fileExists: async () => true, readFile: async () => "" },
        search: { findByName: async () => [], findByContent: async () => [] }, plan: s.plan,
        budget: { maxWorkers: 2, failureRecheck: true }, logger: { warn: m => void warnings.push(m) },
      });
      const d = createDeadline(0);
      expect((await hook(request({ deadline: d }))).recheck).toBe(EXACT);
      await vi.waitFor(() => expect(warnings).toEqual(["verification scope close failed: dispose exploded"]));
      s.close.mockImplementation(() => new Promise<void>(() => {}));
      expect((await hook(request({ deadline: d }))).scoped.kind).toBe("ran");
    });

    it("the gate still returns a proven introduced failure within its budget when close never settles", async () => {
      const s = setup(failing());
      s.close.mockImplementation(() => new Promise<void>(() => {}));
      const BUDGET_MS = 300;
      const dod: DoD = { kind: "deterministic", source: "explicit", criteria: [], deliverable: null, checks: [{ kind: "testsPass" }] };
      const artefact: Artefact = { changedFiles: [], declaredOutputs: [], finalReturnText: "done", producerTier: "medium", producerSessionID: "child" };
      // As index.ts: the deadline first, then the gate's withTimeout over the same budget.
      const gateDeadline = createDeadline(BUDGET_MS);
      const completedFailures: string[] = [];
      const started = Date.now();
      let res: GateResult;
      try {
        res = await withTimeout(accept({ dod }, artefact, {
          deterministic: {
            cwd: ROOT,
            exec: async () => { throw new Error("testsPass must never run its command through deps.exec"); },
            fs: { fileExists: async () => false, readFile: async () => "" },
            testsPass: s.hook,
            deadline: gateDeadline,
            reference: { kind: "captured", reference: REFERENCE },
            changedFiles: [{ path: join(ROOT, "src", "a.ts"), status: "modified" }],
            onFailure: reason => completedFailures.push(reason),
          },
          checker: { dispatchGrader: async () => ({ sessionID: "grader", text: "" }) },
        }), BUDGET_MS, "verification gate");
      } catch (error) {
        gateDeadline.abort("verification gate timed out");
        res = unverifiableGateResult(`verification gate timed out: ${String(error)}`, dod.source, false, completedFailures);
      } finally {
        gateDeadline.dispose();
      }
      expect(Date.now() - started).toBeLessThan(BUDGET_MS + 1_000);
      expect(res.accepted).toBe(false);
      expect(res.verdict.outcome).toBe("fail");
      expect(res.verdict.reasons.join(" ")).toContain("test/a.test.ts > fails");
    });

    it("QA-2.1-13: with real timers and index.ts's arming (withTimeout at remaining()), the failure wins every time", async () => {
      const s = setup(failing());
      s.close.mockImplementation(() => new Promise<void>(() => {}));
      const BUDGET_MS = 200;
      const dod: DoD = { kind: "deterministic", source: "explicit", criteria: [], deliverable: null, checks: [{ kind: "testsPass" }] };
      const artefact: Artefact = { changedFiles: [], declaredOutputs: [], finalReturnText: "done", producerTier: "medium", producerSessionID: "child" };
      const busy = (ms: number): void => {
        const end = performance.now() + ms;
        while (performance.now() < end) { /* synchronous work, as store.delta and buildGateDeps */ }
      };
      const outcomes: string[] = [];
      for (let i = 0; i < 40; i++) {
        // As index.ts: the deadline first, then async preparation and synchronous work, then the
        // gate's withTimeout armed with the deadline's remaining time (the same end instant).
        const gateDeadline = createDeadline(BUDGET_MS);
        const completedFailures: string[] = [];
        await new Promise(resolve => setTimeout(resolve, 20 + (i % 7)));
        busy(i % 3);
        let res: GateResult;
        try {
          res = await withTimeout(accept({ dod }, artefact, {
            deterministic: {
              cwd: ROOT,
              exec: async () => { throw new Error("testsPass must never run its command through deps.exec"); },
              fs: { fileExists: async () => false, readFile: async () => "" },
              testsPass: s.hook,
              deadline: gateDeadline,
              reference: { kind: "captured", reference: REFERENCE },
              changedFiles: [{ path: join(ROOT, "src", "a.ts"), status: "modified" }],
              onFailure: reason => completedFailures.push(reason),
            },
            checker: { dispatchGrader: async () => ({ sessionID: "grader", text: "" }) },
          }), gateDeadline.remaining(), "verification gate");
        } catch (error) {
          gateDeadline.abort("verification gate timed out");
          res = unverifiableGateResult(`verification gate timed out: ${String(error)}`, dod.source, false, completedFailures);
        } finally {
          gateDeadline.dispose();
        }
        outcomes.push(res.verdict.outcome ?? "none");
      }
      expect(outcomes).toEqual(Array.from({ length: 40 }, () => "fail"));
    }, 30_000);
  });

  it("keeps the scoped outcome when the Rechecker throws, and still closes", async () => {
    const s = setup({ scoped: { kind: "ran", result: FAILING, exitCode: 1, spec: SPEC, notes: [] } });
    s.rechecker.mockImplementation(async () => { throw new Error("recheck exploded"); });
    const out = await s.hook(request());
    expect(out.scoped.kind).toBe("ran");
    expect(out.recheck).toEqual({ kind: "unusable", cause: "error", reason: "the reference recheck errored: recheck exploded" });
    expect(s.close).toHaveBeenCalledTimes(1);
  });
});

describe("gate pipeline end to end (2.1.6c): real opener, rechecker, hook, planner and judgeScoped", () => {
  const TMP = tmpdir();
  const ROOT = process.platform === "win32" ? "C:\\omr-e2e\\repo" : "/omr-e2e/repo";
  const P = (...s: string[]): string => join(ROOT, ...s);
  const FULL = "npm test";
  const BUDGET: VerifyBudget = {
    testScope: "affected",
    maxWorkers: 2,
    lowPriority: true,
    maxConcurrentVerifications: 1,
    defaultVerify: "required",
    captureWaitMs: 5_000,
    background: false,
    pendingTtlMs: 600_000,
    slotWaitMs: 60_000,
    batchWindowMs: 250,
    failureRecheck: true,
    recheckTimeoutMs: 120_000,
    baselineTimeoutMs: 60_000,
    gateBudgetMs: 5_000,
  };
  const REFERENCE: DispatchReference = {
    root: ROOT, head: "a".repeat(40), commit: "b".repeat(40), untracked: new Map(), tracked: new Map(), captureReasons: [], capturedAt: 0,
  };
  const FILES: Record<string, string> = {
    [P(".git")]: "",
    [P("package.json")]: JSON.stringify({ name: "e2e", scripts: { test: "vitest run" }, devDependencies: { vitest: "3.0.0" } }),
    [P("node_modules", "vitest", "package.json")]: JSON.stringify({ name: "vitest", version: "3.0.0", bin: { vitest: "vitest.mjs" } }),
    [P("node_modules", "vitest", "vitest.mjs")]: "",
    [P("src", "a.ts")]: "export const a = 1;\n",
    [P("test", "a.test.ts")]: "",
  };
  const plannerFs: PlannerFs = {
    fileExists: async p => p in FILES,
    readFile: async p => {
      if (p in FILES) return FILES[p];
      throw new Error(`ENOENT: ${p}`);
    },
  };
  const FAIL_OUT = "FAIL test/a.test.ts > suite > fails\n Tests  1 failed | 2 passed (3)\n";
  const FAIL_ID = "test/a.test.ts > suite > fails";

  interface Spawn { file: string; args: readonly string[]; signal: AbortSignal | undefined; at: number }
  function pipeline(o: { argv?: ArgvSeam; exec?: ExecSeam; acquire?: typeof acquireSlot; search?: Partial<TestSearchSeam> } = {}) {
    const spawned: Spawn[] = [];
    const argv = vi.fn<ArgvSeam>(async (file, args, opts) => {
      spawned.push({ file, args, signal: opts?.signal, at: Date.now() });
      return o.argv ? o.argv(file, args, opts) : { code: 0, stdout: "", stderr: "" };
    });
    const exec = vi.fn<ExecSeam>(o.exec ?? (async () => ({ code: 0, stdout: "", stderr: "" })));
    const release = vi.fn(async (): Promise<void> => {});
    const acquire = vi.fn<typeof acquireSlot>(o.acquire ?? (async () => ({ release, lost: false })));
    const refuse = (name: string) => async (): Promise<never> => { throw new Error(`recheck reached ${name}`); };
    const detectRunner = vi.fn<RecheckSeams["detectRunner"]>(refuse("detectRunner"));
    const materialize = vi.fn<RecheckSeams["materialize"]>(refuse("materialize"));
    const openScope = createScopeOpener({
      argv, exec, acquire, budget: BUDGET, checkTimeoutMs: 120_000,
      fs: { fileExists: plannerFs.fileExists, readFile: async (p: string) => { throw new Error(`ENOENT: ${p}`); }, unlink: async () => {} },
      host: { platform: process.platform, tmpdir: TMP },
      logger: { warn: vi.fn() },
      recheck: {
        detectRunner, materialize,
        gcStaleReferences: vi.fn<RecheckSeams["gcStaleReferences"]>(refuse("gcStaleReferences")),
        resolveEntry: vi.fn<RecheckSeams["resolveEntry"]>(refuse("resolveEntry")),
        planRerun: vi.fn<RecheckSeams["planRerun"]>(refuse("planRerun")),
        readResult: vi.fn<RecheckSeams["readResult"]>(refuse("readResult")),
      },
    });
    const search: TestSearchSeam = {
      findByName: vi.fn(o.search?.findByName ?? (async () => [])),
      findByContent: vi.fn(o.search?.findByContent ?? (async () => [])),
    };
    const hook = createDirectTestsPassHook({
      openScope, plannerFs, search, budget: { maxWorkers: 2, failureRecheck: true }, host: { platform: process.platform, tmpdir: TMP },
    });
    const run = async (req: TestsPassRequest) => {
      const out = await hook(req);
      return { out, verdict: judgeScoped(out.scoped, out.recheck) };
    };
    return { run, spawned, argv, exec, acquire, release, detectRunner, materialize, search };
  }

  const request = (deadline: Deadline, over: Partial<TestsPassRequest> = {}): TestsPassRequest => ({
    command: FULL,
    cwd: ROOT,
    testScope: "affected",
    changedFiles: [{ path: P("src", "a.ts"), status: " M" }],
    reference: { kind: "captured", reference: REFERENCE },
    deadline,
    ...over,
  });

  afterEach(() => { vi.useRealTimers(); });

  it("a gate budget exhausted before the run is unverifiable, and nothing is acquired or spawned", async () => {
    const s = pipeline();
    const d = createDeadline(60_000);
    d.abort("gate budget exhausted");
    const { out, verdict } = await s.run(request(d));
    expect(out.scoped).toEqual({ kind: "slot-busy", waitedMs: 0, deadlineCut: true });
    expect(verdict).toEqual({ ok: false, unverifiable: true, reason: "gate budget exhausted waiting for the verification slot" });
    expect(s.acquire).not.toHaveBeenCalled();
    expect(s.argv).not.toHaveBeenCalled();
    expect(s.exec).not.toHaveBeenCalled();
  });

  it("a 5 s gate budget cuts a 60 s slot wait at 5 s, and no process is spawned afterwards", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    let waitMs: number | undefined;
    let gaveUpAt = 0;
    const s = pipeline({
      acquire: opts => new Promise(res => {
        waitMs = opts.waitMs;
        opts.signal?.addEventListener("abort", () => { gaveUpAt = Date.now(); res({ busy: true }); }, { once: true });
      }),
    });
    const d = createDeadline(BUDGET.gateBudgetMs);
    const pending = s.run(request(d));
    await vi.advanceTimersByTimeAsync(5_000);
    const { verdict } = await pending;
    expect(waitMs).toBe(5_000);
    expect(gaveUpAt - start).toBeLessThanOrEqual(5_000);
    expect(verdict).toEqual({ ok: false, unverifiable: true, reason: "gate budget exhausted waiting for the verification slot" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.argv).not.toHaveBeenCalled();
    expect(s.exec).not.toHaveBeenCalled();
    d.dispose();
  });

  it("a scoped run ending with 8 s left skips the recheck (full mode through the real opener)", async () => {
    let t = 0;
    const d = createDeadline(20_000, { now: () => t });
    const s = pipeline({ exec: async () => { t += 12_000; return { code: 1, stdout: FAIL_OUT, stderr: "" }; } });
    const { out, verdict } = await s.run(request(d, { testScope: "full" }));
    expect(out.recheck).toEqual({ kind: "skipped-deadline", remainingMs: 8_000 });
    expect(verdict).toEqual({ ok: false, unverifiable: true, reason: `testsPass: gate budget exhausted before recheck; observed failures: ${FAIL_ID}` });
    // Full mode: the resolved command runs once through the shell seam; no scoped spec is spawned.
    expect(s.exec).toHaveBeenCalledTimes(1);
    expect(s.exec.mock.calls[0]?.[0]).toBe(FULL);
    expect(s.argv).not.toHaveBeenCalled();
    expect(s.detectRunner).not.toHaveBeenCalled();
    expect(s.materialize).not.toHaveBeenCalled();
    expect(s.release).toHaveBeenCalledTimes(1);
    d.dispose();
  });

  it("full mode with time left applies S2: the failing file is rechecked at the reference", async () => {
    const d = createDeadline(300_000);
    const s = pipeline({ exec: async () => ({ code: 1, stdout: FAIL_OUT, stderr: "" }) });
    const { verdict } = await s.run(request(d, { testScope: "full" }));
    expect(s.exec).toHaveBeenCalledTimes(1);
    expect(s.detectRunner).toHaveBeenCalledTimes(1);
    expect(verdict.unverifiable).toBe(true);
    expect(verdict.reason).toContain("reference unusable (error)");
    expect(verdict.reason).toContain(FAIL_ID);
    d.dispose();
  });

  it("an owner abort (native task gate timeout) during the scoped run kills the tree: the argv seam's signal aborts", async () => {
    const d = createDeadline(300_000);
    const s = pipeline({
      argv: (_file, _args, opts) => new Promise(res => {
        opts?.signal?.addEventListener("abort", () => res({ code: -1, stdout: "", stderr: "", timedOut: true }), { once: true });
      }),
    });
    const pending = s.run(request(d));
    await vi.waitFor(() => expect(s.argv).toHaveBeenCalledTimes(1));
    expect(s.spawned[0]?.signal?.aborted).toBe(false);
    d.abort("verification gate timed out");
    const { out, verdict } = await pending;
    expect(s.spawned[0]?.signal?.aborted).toBe(true);
    expect(out.scoped).toEqual({ kind: "aborted", reason: ABORTED_DURING_RUN });
    expect(verdict).toEqual({ ok: false, unverifiable: true, reason: `testsPass: ${ABORTED_DURING_RUN}` });
    expect(s.release).toHaveBeenCalledTimes(1);
    expect(s.argv).toHaveBeenCalledTimes(1);
  });

  describe("acceptance: no dispatch-time run, and every spawned argv is scoped", () => {
    const expectScoped = (spawn: Spawn | undefined, inputs: string[]): void => {
      expect(spawn?.args[0]).toBe(P("node_modules", "vitest", "vitest.mjs"));
      expect(spawn?.args[1]).toBe("related");
      expect(spawn?.args).toContain("--run");
      for (const input of inputs) expect(spawn?.args).toContain(input);
    };

    it("dispatch captures without spawning; the gate spawns exactly one related run over the changed file", async () => {
      const s = pipeline();
      const store = createChangedFileStore();
      const capture = vi.fn(async (_cwd: string, _signal: AbortSignal): Promise<DispatchReference | undefined> => REFERENCE);
      await store.beginDispatch("dispatch", ROOT, { snapshot: async () => undefined, capture, timeoutMs: 1_000 });
      const reference = await store.reference("dispatch");
      expect(capture).toHaveBeenCalledTimes(1);
      expect(s.argv).not.toHaveBeenCalled();
      expect(s.exec).not.toHaveBeenCalled();
      expect(s.acquire).not.toHaveBeenCalled();

      const d = createDeadline(300_000);
      await s.run(request(d, { reference }));
      expect(s.argv).toHaveBeenCalledTimes(1);
      expectScoped(s.spawned[0], [P("src", "a.ts")]);
      // Never the full command: nothing goes through the shell seam in affected mode.
      expect(s.exec).not.toHaveBeenCalled();
      d.dispose();
    });

    it("a deleted source is scoped through the test search, never widened to the full suite", async () => {
      const s = pipeline({ search: { findByContent: async () => [P("test", "a.test.ts")] } });
      const d = createDeadline(300_000);
      await s.run(request(d, { changedFiles: [{ path: P("src", "gone.ts"), status: " D" }] }));
      expect(s.search.findByContent).toHaveBeenCalledTimes(1);
      expect(s.argv).toHaveBeenCalledTimes(1);
      expectScoped(s.spawned[0], [P("test", "a.test.ts")]);
      expect(s.exec).not.toHaveBeenCalled();
      d.dispose();
    });

    it("no changed files spawns nothing at all", async () => {
      const s = pipeline();
      const d = createDeadline(300_000);
      const { verdict } = await s.run(request(d, { changedFiles: [] }));
      expect(verdict.ok).toBe(true);
      expect(s.argv).not.toHaveBeenCalled();
      expect(s.exec).not.toHaveBeenCalled();
      expect(s.acquire).not.toHaveBeenCalled();
      d.dispose();
    });
  });
});

/**
 * E2E-2: the win32 8.3 spelling of an existing path (cmd's `%~sI`, spawned with an argv), or
 * undefined when the volume has 8.3 name generation disabled (the spelling comes back unchanged).
 */
function shortPathOf(path: string): string | undefined {
  const r = spawnSync("cmd.exe", ["/d", "/s", "/c", `"for %I in ("${path}") do @echo %~sI"`], {
    encoding: "utf8",
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
  if (r.status !== 0) throw new Error(`cmd.exe %~sI failed for ${path}: ${r.stderr}`);
  const short = r.stdout.trim();
  return short.toLowerCase() === path.toLowerCase() ? undefined : short;
}

// E2E-2 (phase 3.1): the plugin directory (the recheck's liveCwd) and os.tmpdir() are 8.3 short
// paths on many Windows hosts. Before the fix every recheck there was "reference unusable
// (rerun-unplannable): runner not installed: vitest", so introduced failures were accepted with a
// caveat. Real opener, real detectRunner/resolveEntry/planRerun/materialize/GC, real git and a
// real node_modules junction; only the rerun spawn and its report are stubbed.
describe("scope.rechecker under 8.3 short paths (E2E-2)", { timeout: 60_000 }, () => {
  const BUDGET: VerifyBudget = {
    testScope: "affected",
    maxWorkers: 2,
    lowPriority: true,
    maxConcurrentVerifications: 1,
    defaultVerify: "required",
    captureWaitMs: 5_000,
    background: false,
    pendingTtlMs: 600_000,
    slotWaitMs: 60_000,
    batchWindowMs: 250,
    failureRecheck: true,
    recheckTimeoutMs: 120_000,
    baselineTimeoutMs: 60_000,
    gateBudgetMs: 300_000,
  };
  /** The production RunnerFs shape (wiring.ts): fs.promises with the native realpath. */
  const realFs: RunnerFs = {
    fileExists: p => fsp.access(p).then(() => true, () => false),
    readFile: p => fsp.readFile(p, "utf8"),
    realpath: p => fsp.realpath(p),
    async stat(p) {
      const s = await fsp.stat(p, { bigint: true });
      return { isFile: s.isFile(), size: s.size, dev: s.dev, ino: s.ino };
    },
    readdir: p => fsp.readdir(p),
    async unlink(p) {
      try {
        await fsp.unlink(p);
      } catch (err) {
        if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) throw err;
      }
    },
  };
  /** git runs for real (capture, materialize, GC, dispose); any other file is recorded, not spawned. */
  const reruns: { file: string; args: readonly string[]; cwd: string | undefined }[] = [];
  const argv: ArgvSeam = (file, args, opts) => {
    if (file !== "git") {
      reruns.push({ file, args, cwd: opts?.cwd });
      return Promise.resolve({ code: 1, stdout: "", stderr: "" });
    }
    return new Promise(resolve => {
      const child = spawn(file, [...args], {
        cwd: opts?.cwd,
        env: opts?.env ? { ...process.env, ...opts.env } : process.env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (c: string) => void (stdout += c));
      child.stderr.setEncoding("utf8").on("data", (c: string) => void (stderr += c));
      child.on("error", e => resolve({ code: -1, stdout, stderr: `${stderr}${String(e)}` }));
      child.on("close", code => resolve({ code: code ?? 1, stdout, stderr }));
    });
  };
  const git = async (cwd: string, ...args: string[]): Promise<void> => {
    const r = await argv("git", args, { cwd });
    if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  };

  let longRoot = "";
  let junction = "";
  afterEach(async () => {
    reruns.length = 0;
    if (junction !== "" && (await fsp.lstat(junction).catch(() => undefined))?.isSymbolicLink()) await fsp.unlink(junction);
    if (longRoot !== "") await fsp.rm(longRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    longRoot = "";
    junction = "";
  });

  it("reruns the failing file at the reference with the live runner entry, from an 8.3 plugin directory and tmpdir", async ctx => {
    if (process.platform !== "win32") return ctx.skip("8.3 short names exist on win32 only");
    // ASCII-only long names, so cmd's output code page cannot garble the short spelling.
    longRoot = await fsp.mkdtemp(join(await fsp.realpath(tmpdir()), "omr-e2e2-pipeline-long-"));
    const longRepo = join(longRoot, "repository-long-name");
    const longTmp = join(longRoot, "temporary-long-name");
    const store = join(longRoot, "dependency-store", "node_modules");
    junction = join(longRepo, "node_modules");
    await fsp.mkdir(longRepo);
    await fsp.mkdir(longTmp);
    const shortRepo = shortPathOf(longRepo);
    const shortTmp = shortPathOf(longTmp);
    if (shortRepo === undefined || shortTmp === undefined) {
      console.warn(`[E2E-2] SKIPPED: 8.3 short names are disabled on the volume of ${longRoot}`);
      return ctx.skip("8.3 short names are disabled on this volume");
    }
    expect(shortRepo).toMatch(/~\d/);
    await git(longRepo, "init", "-q");
    for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "t"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) {
      await git(longRepo, "config", k, v);
    }
    await fsp.mkdir(join(longRepo, "test"));
    await fsp.writeFile(join(longRepo, "package.json"), '{"name":"e2e2","scripts":{"test":"vitest run"}}\n');
    await fsp.writeFile(join(longRepo, "test", "a.test.js"), "// a failing test file\n");
    await fsp.writeFile(join(longRepo, ".gitignore"), "node_modules/\n");
    await git(longRepo, "add", "-A");
    await git(longRepo, "commit", "-q", "-m", "init");
    await fsp.mkdir(join(store, "vitest"), { recursive: true });
    await fsp.writeFile(join(store, "vitest", "package.json"), '{"name":"vitest","version":"3.0.0","bin":{"vitest":"vitest.mjs"}}\n');
    await fsp.writeFile(join(store, "vitest", "vitest.mjs"), "\n");
    await fsp.symlink(store, junction, "junction");

    const reference = await captureReference(shortRepo, new AbortController().signal, { argv, fs: nodeReferenceFs, tmpdir: shortTmp });
    if (!reference) throw new Error("capture from the 8.3 cwd returned undefined");
    const warn = vi.fn();
    const release = vi.fn(async (): Promise<void> => {});
    const materialized: string[] = [];
    const readResult = vi.fn<RecheckSeams["readResult"]>(async spec => ({
      failingIds: ["test/a.test.js > fails"],
      failingFiles: [join(spec.cwd, "test", "a.test.js")],
      collectionError: false,
      total: 1,
      complete: true,
      source: "report",
    }));
    const host = { platform: process.platform, tmpdir: shortTmp };
    const open = createScopeOpener({
      argv,
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      fs: realFs,
      acquire: async () => ({ release, lost: false }),
      budget: BUDGET,
      checkTimeoutMs: 120_000,
      host,
      logger: { warn },
      reference: { tmpdir: shortTmp },
      recheck: {
        readResult,
        materialize: async (...a) => {
          const m = await realMaterialize(...a);
          if (m.ok) materialized.push(m.reference.dir);
          return m;
        },
      },
    });
    const scope = open({ cwd: shortRepo, command: "npx vitest run" });
    // The live failing file as the scoped run reports it: the planner's canonical spelling.
    const failing = join(await fsp.realpath(longRepo), "test", "a.test.js");
    const out = await scope.rechecker("npx vitest run", shortRepo)(reference, [failing], createDeadline(300_000));
    await scope.close();

    expect(out).toMatchObject({ kind: "exact", ranFiles: ["test/a.test.js"], absentFiles: [] });
    expect(materialized).toHaveLength(1);
    const refDir = materialized[0] ?? "";
    expect(dirname(refDir)).toBe(await fsp.realpath(shortTmp));
    // One rerun: node + the LIVE vitest entry, in the reference worktree, on the mapped file.
    expect(reruns).toHaveLength(1);
    const rerun = reruns[0];
    expect(rerun?.cwd).toBe(refDir);
    expect(rerun?.args[0]).toBe(join(await fsp.realpath(longRepo), "node_modules", "vitest", "vitest.mjs"));
    expect(rerun?.args).toContain(join(refDir, "test", "a.test.js"));
    expect(release).toHaveBeenCalledTimes(1);
    // The reference was disposed without going through the junction (R1).
    expect(await fsp.readFile(join(store, "vitest", "package.json"), "utf8")).toContain('"vitest"');
    expect((await fsp.readdir(longTmp)).filter(n => n.startsWith("omr-ref-"))).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("resolveEntry walks from an 8.3 cwd up to the realpath'd gitRoot detectRunner returns", async ctx => {
    if (process.platform !== "win32") return ctx.skip("8.3 short names exist on win32 only");
    longRoot = await fsp.mkdtemp(join(await fsp.realpath(tmpdir()), "omr-e2e2-entry-long-"));
    const longRepo = join(longRoot, "repository-long-name");
    await fsp.mkdir(join(longRepo, "node_modules", "vitest"), { recursive: true });
    await fsp.mkdir(join(longRepo, ".git"));
    await fsp.writeFile(join(longRepo, "package.json"), '{"name":"e2e2"}\n');
    await fsp.writeFile(join(longRepo, "node_modules", "vitest", "package.json"), '{"name":"vitest","version":"3.0.0","bin":{"vitest":"vitest.mjs"}}\n');
    await fsp.writeFile(join(longRepo, "node_modules", "vitest", "vitest.mjs"), "\n");
    const shortRepo = shortPathOf(longRepo);
    if (shortRepo === undefined) {
      console.warn(`[E2E-2] SKIPPED: 8.3 short names are disabled on the volume of ${longRoot}`);
      return ctx.skip("8.3 short names are disabled on this volume");
    }
    const runner = await realDetectRunner("npx vitest run", shortRepo, realFs);
    if ("unverifiable" in runner) throw new Error(`detectRunner: ${runner.reason}`);
    expect(runner.gitRoot).toBe(await fsp.realpath(longRepo));
    const entry = await realResolveEntry(runner, shortRepo, realFs);
    expect(entry).toMatchObject({ entry: join(await fsp.realpath(longRepo), "node_modules", "vitest", "vitest.mjs"), version: "3.0.0" });
  });
});
