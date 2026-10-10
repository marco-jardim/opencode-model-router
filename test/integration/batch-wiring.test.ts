/**
 * 2.2.3.b: the S5 batch coordinator behind the real verification wiring.
 *
 * Five testsPass gates run concurrently through createVerificationWiring -> buildGateDeps ->
 * accept, over a real vitest-shaped project on disk (the real planner, scope opener, readResult
 * and judge). Only the process seams are fake: runArgv writes the vitest JSON report the spec asks
 * for, and acquireSlot counts holds. Each scenario runs twice, batched (batchWindowMs > 0) and
 * alone (batchWindowMs: 0), and the verdicts must be equal (B-G1), with the spawn counts of B13.
 *
 * W7 (QA-2.2-17 a) closes a window as soon as no other request is planning and no batch runs, so
 * "concurrent" is made explicit: a planning barrier holds every gate's planScopedRun until all of
 * them are planning. The deadline cases (QA-2.2-17, R5/R6) add a FIFO slot with one holder, runs
 * that take real time, and an exact reference (a copy of the project at which nothing fails).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { createVerificationWiring, type PreparedVerification, type VerificationWiring } from "../../src/verify/wiring";
import { createDeadline } from "../../src/verify/deterministic";
import { accept, type GateResult } from "../../src/verify/gate";
import { BATCH_REASONS, BATCH_STALE_GRACE_MS } from "../../src/verify/batch";
import type { RouterConfig } from "../../src/router/config";
import type { DoD } from "../../src/verify/dod";
import type { TreeSnapshot } from "../../src/verify/dispatch";
import type { DispatchReference } from "../../src/verify/reference";
import type { ReferenceState } from "../../src/verify/types";

type ExecOpts = { cwd?: string; timeoutMs?: number; signal?: AbortSignal; lowPriority?: boolean; env?: Record<string, string | undefined> };
type ExecOut = { code: number; stdout: string; stderr: string; timedOut: boolean };

const state = vi.hoisted(() => ({
  root: "",
  /** Test file letter -> failing test names ("c" -> ["t2"] makes test/c.test.ts > t2 fail). */
  failing: {} as Record<string, string[]>,
  /** The same at the exact reference (a failure listed here is pre-existing). */
  failingAtRef: {} as Record<string, string[]>,
  /** Every scoped test run (non-git argv spawn): its inputs, and how many slot holds were live. */
  runs: [] as { inputs: string[]; holds: number }[],
  git: 0,
  shells: [] as string[],
  acquires: 0,
  releases: 0,
  holds: 0,
  maxHolds: 0,
  /** The currentTree each materialize call received (QA-2.2-8). */
  materialized: [] as unknown[],
  /** Called after each planScopedRun with the planned changed paths: a barrier or a hold. */
  planGate: undefined as undefined | ((changed: readonly string[]) => Promise<void> | undefined),
  /** How long each scoped test run takes, in real time. */
  runMs: 0,
  /** When set, a run's time from its number of inputs (QA-2.2-25: maxWorkers 2 runs 2 files at a time). */
  runMsFor: undefined as undefined | ((inputs: number) => number),
  /** Slot holders first come first served, at most `capacity` at once (maxConcurrentVerifications). */
  fifo: false,
  capacity: 1,
  queue: [] as (() => void)[],
  /** When set, materialize returns an exact reference over this copy of the project. */
  refRoot: "",
  /** When set, each scoped run waits for it and ignores its abort signal (QA-2.2-19, R3). */
  hang: undefined as Promise<void> | undefined,
  /** Called with each scoped run's index (0 = the first); a returned promise holds that run (QA-2.2-22). */
  runGate: undefined as undefined | ((index: number) => Promise<void> | undefined),
}));

vi.mock("../../src/verify/exec", () => ({
  runShell: async (command: string): Promise<ExecOut> => {
    state.shells.push(command);
    return { code: 0, stdout: " Tests  2 passed (2)\n", stderr: "", timedOut: false };
  },
  runArgv: async (file: string, args: readonly string[], _opts?: ExecOpts): Promise<ExecOut> => {
    if (file === "git") {
      state.git++;
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    }
    return await fakeVitest(args);
  },
}));

vi.mock("../../src/verify/runner", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/verify/runner")>();
  return {
    ...actual,
    planScopedRun: async (...args: Parameters<typeof actual.planScopedRun>) => {
      const plan = await actual.planScopedRun(...args);
      const changed = args[0].changedFiles;
      await state.planGate?.(changed === "unavailable" ? [] : changed.map(c => c.path));
      return plan;
    },
  };
});

vi.mock("../../src/verify/slot", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/verify/slot")>()),
  acquireSlot: async (opts: { signal?: AbortSignal; waitMs?: number }) => {
    if (opts.signal?.aborted) return { busy: true as const };
    if (state.fifo && state.holds >= state.capacity) {
      // Wait for a hand-off: the holder's release passes its hold on, so holds never drops between.
      // The wait ends at waitMs or at the signal, as the real slot's does.
      const granted = await new Promise<boolean>(resolve => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const go = (): void => {
          clearTimeout(timer);
          opts.signal?.removeEventListener("abort", stop);
          resolve(true);
        };
        const stop = (): void => {
          clearTimeout(timer);
          opts.signal?.removeEventListener("abort", stop);
          const i = state.queue.indexOf(go);
          if (i >= 0) state.queue.splice(i, 1);
          resolve(false);
        };
        state.queue.push(go);
        opts.signal?.addEventListener("abort", stop, { once: true });
        if (opts.waitMs !== undefined) timer = setTimeout(stop, opts.waitMs);
      });
      if (!granted) return { busy: true as const };
    } else {
      state.holds++;
    }
    state.acquires++;
    state.maxHolds = Math.max(state.maxHolds, state.holds);
    let released = false;
    return {
      lost: false,
      release: async () => {
        if (released) return;
        released = true;
        state.releases++;
        const next = state.queue.shift();
        if (next !== undefined) next();
        else state.holds--;
      },
    };
  },
}));

vi.mock("../../src/verify/reference", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/verify/reference")>()),
  gcStaleReferences: async () => ({ removed: [], kept: [], failed: [] }),
  materialize: async (_ref: unknown, currentTree: unknown) => {
    state.materialized.push(currentTree);
    const dir = state.refRoot;
    if (dir === "") return { ok: false as const, reason: "worktree-add-failed" as const, detail: "test seam: no worktree" };
    return {
      ok: true as const,
      reference: {
        dir,
        exact: true,
        inexactReasons: [],
        unreproduced: [],
        links: [],
        toRefPath: (livePath: string) => {
          const rel = relative(state.root, livePath);
          return rel.startsWith("..") || isAbsolute(rel) ? undefined : join(dir, rel);
        },
        dispose: async () => {},
      },
    };
  },
}));

/** A vitest run over the fake project (or its reference copy): each source relates to its own test file only. */
async function fakeVitest(args: readonly string[]): Promise<ExecOut> {
  const atRef = state.refRoot !== "" && args.some(a => a.startsWith(state.refRoot));
  const root = atRef ? state.refRoot : state.root;
  const failingNow = atRef ? state.failingAtRef : state.failing;
  const report = args.find(a => a.startsWith("--outputFile="))?.slice("--outputFile=".length);
  const inputs = args.filter(a => isAbsolute(a) && a.startsWith(root) && !a.includes("node_modules"));
  state.runs.push({ inputs: [...inputs].sort(), holds: state.holds });
  if (state.hang !== undefined) await state.hang;
  await state.runGate?.(state.runs.length - 1);
  const runMs = state.runMsFor?.(inputs.length) ?? state.runMs;
  if (runMs > 0) await new Promise(resolve => setTimeout(resolve, runMs));
  const letters = [...new Set(inputs.map(a => /[\\/]([a-z])(?:\.test)?\.ts$/.exec(a)?.[1]).filter((x): x is string => x !== undefined))].sort();
  const testResults = letters.map(x => {
    const failing = failingNow[x] ?? [];
    return {
      name: join(root, "test", `${x}.test.ts`),
      status: failing.length > 0 ? "failed" : "passed",
      assertionResults: ["t1", "t2"].map(title => ({ title, ancestorTitles: [], status: failing.includes(title) ? "failed" : "passed" })),
    };
  });
  const total = testResults.reduce((n, s) => n + s.assertionResults.length, 0);
  if (report !== undefined) writeFileSync(report, JSON.stringify({ numTotalTests: total, numRuntimeErrorTestSuites: 0, testResults }));
  return { code: testResults.some(s => s.status === "failed") ? 1 : 0, stdout: "", stderr: "", timedOut: false };
}

const LETTERS = ["a", "b", "c", "d", "e"];
/** The project's files; "f" is a sixth producer for the scenarios that need one. */
const FILES = [...LETTERS, "f"];
const DOD: DoD = { kind: "deterministic", source: "explicit", criteria: [], deliverable: null, checks: [{ kind: "testsPass", command: "npm test" }] };
const NONE: ReferenceState = { kind: "none", reason: "no reference captured" };
/** Long enough that only the size cap (5) closes the window: all five gates meet in one batch. */
const WINDOW_MS = 60_000;

function config(verify: NonNullable<NonNullable<RouterConfig["enforcement"]>["verify"]>): RouterConfig {
  return { activePreset: "a", presets: { a: { medium: { model: "p/m" } } }, defaultTier: "medium", rules: [], enforcement: { verify } };
}

function wiringWith(verify: NonNullable<NonNullable<RouterConfig["enforcement"]>["verify"]>, batch: Parameters<typeof createVerificationWiring>[0]["batch"] = {}): VerificationWiring {
  const cfg = config(verify);
  return createVerificationWiring({ client: {}, directory: state.root, getConfig: () => cfg, logger: { warn: () => {} }, batch: { maxBatchSize: 5, ...batch } });
}

function tree(x: string): TreeSnapshot {
  return { cwd: state.root, root: state.root, head: "a".repeat(40), fingerprint: `tree-${x}`, dirty: true, files: [] };
}

/** A captured reference at the project root (with state.refRoot set, materialize makes it exact). */
function captured(commit = "b".repeat(40)): ReferenceState {
  return {
    kind: "captured",
    reference: { root: state.root, head: "a".repeat(40), commit, untracked: new Map(), tracked: new Map(), captureReasons: [], capturedAt: 0 } satisfies DispatchReference,
  };
}

/** Makes state.refRoot a copy of the project: the exact reference of the deadline cases. */
function exactReference(): void {
  const refRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "omr-batch-ref-")));
  cpSync(state.root, refRoot, { recursive: true });
  state.refRoot = refRoot;
}

interface GateOptions {
  readonly reference?: ReferenceState;
  readonly snapshot?: TreeSnapshot;
  /** The gate deadline's budget (default 120 s). */
  readonly budgetMs?: number;
  /** Called when this gate's verdict is in (QA-2.2-5: whether the batch still holds the slot). */
  readonly onSettled?: () => void;
}

/** One gate, as index.ts runs it: a gate deadline, buildGateDeps with the prepared inputs, accept. */
async function gate(wiring: VerificationWiring, x: string, o: GateOptions = {}): Promise<GateResult> {
  const prepared: PreparedVerification = {
    changedFiles: [{ path: join(state.root, "src", `${x}.ts`), status: " M" }],
    changeBaseline: "available",
    reference: o.reference ?? NONE,
    snapshot: o.snapshot,
  };
  const deadline = createDeadline(o.budgetMs ?? 120_000);
  try {
    const deps = wiring.buildGateDeps(undefined, undefined, prepared, deadline);
    const r = await accept({ dod: DOD }, { ...prepared, finalReturnText: "done", declaredOutputs: [], producerSessionID: `p-${x}`, producerTier: "medium" }, deps);
    o.onSettled?.();
    return r;
  } finally {
    deadline.dispose();
  }
}

/** What B12 compares: acceptance, outcome, the failure classification and the reasons. */
function verdictOf(r: GateResult) {
  return { accepted: r.accepted, outcome: r.verdict.outcome, failures: r.verdict.failures, reasons: r.verdict.reasons };
}

function resetCounters(): void {
  Object.assign(state, { runs: [], git: 0, shells: [], acquires: 0, releases: 0, holds: 0, maxHolds: 0, materialized: [], planGate: undefined, queue: [] });
}

/**
 * Holds each planScopedRun until `n` of them are waiting, then releases them together: the `n`
 * gates are all in flight when the first one joins its window (W7). Later calls pass through.
 */
function barrier(n: number): Promise<void> {
  const waiting: (() => void)[] = [];
  return new Promise<void>(released => {
    state.planGate = () =>
      new Promise<void>(resolve => {
        waiting.push(resolve);
        if (waiting.length < n) return;
        state.planGate = undefined;
        for (const go of waiting) go();
        released();
      });
  });
}

/**
 * barrier() for the gates `order` (by producer letter), released in that order: they join their
 * window, and queue for the slot alone, in that order (W3 counts arrival order).
 */
function barrierInOrder(order: readonly string[]): void {
  const waiting = new Map<string, () => void>();
  state.planGate = changed =>
    new Promise<void>(resolve => {
      const x = /[\\/]([a-z])\.ts$/.exec(changed[0] ?? "")?.[1] ?? "";
      waiting.set(x, resolve);
      if (waiting.size < order.length) return;
      state.planGate = undefined;
      for (const y of order) waiting.get(y)?.();
    });
}

/** Holds the planning of gate `x` until the returned function is called; others pass (W7: it stays in flight). */
function holdPlanning(x: string): () => void {
  let release: () => void = () => {};
  const held = new Promise<void>(resolve => {
    release = resolve;
  });
  const target = join(state.root, "src", `${x}.ts`);
  state.planGate = changed => (changed.includes(target) ? held : undefined);
  return release;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Another gate's check: it takes one FIFO slot now and releases it after `ms` (QA-2.2-23, N1).
 * Await the result before the next run, so a release never lands in another run's counters.
 */
function occupySlot(ms: number): Promise<void> {
  state.holds++;
  state.maxHolds = Math.max(state.maxHolds, state.holds);
  return new Promise<void>(released =>
    setTimeout(() => {
      const next = state.queue.shift();
      if (next !== undefined) next();
      else state.holds--;
      released();
    }, ms),
  );
}

/** A verdict and whether the gate accepted it: what the deadline cases compare. */
const outcomeOf = (r: GateResult | undefined) => [r?.verdict.outcome, r?.accepted];

/** Five gates at once (batched), then the same five with batchWindowMs: 0 (alone). */
async function batchedAndAlone(options: (x: string) => GateOptions = () => ({}), verify: Parameters<typeof wiringWith>[0] = {}) {
  resetCounters();
  const batchedWiring = wiringWith({ ...verify, batchWindowMs: WINDOW_MS });
  void barrier(LETTERS.length);
  const batched = await Promise.all(LETTERS.map(x => gate(batchedWiring, x, options(x))));
  await batchedWiring.disposeVerification();
  const b = { runs: state.runs, acquires: state.acquires, releases: state.releases, maxHolds: state.maxHolds, materialized: state.materialized, shells: state.shells };

  resetCounters();
  const aloneWiring = wiringWith({ ...verify, batchWindowMs: 0 });
  const alone = await Promise.all(LETTERS.map(x => gate(aloneWiring, x, options(x))));
  await aloneWiring.disposeVerification();
  const a = { runs: state.runs, acquires: state.acquires, releases: state.releases, maxHolds: state.maxHolds, materialized: state.materialized, shells: state.shells };
  return { batched, alone, b, a };
}

beforeEach(() => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "omr-batch-wiring-")));
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "test"));
  mkdirSync(join(root, "node_modules", "vitest"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "batch-wiring", scripts: { test: "vitest run" }, devDependencies: { vitest: "3.0.0" } }));
  writeFileSync(join(root, "node_modules", "vitest", "package.json"), JSON.stringify({ name: "vitest", version: "3.0.0", bin: { vitest: "vitest.mjs" } }));
  writeFileSync(join(root, "node_modules", "vitest", "vitest.mjs"), "");
  for (const x of FILES) {
    writeFileSync(join(root, "src", `${x}.ts`), `export const ${x} = 1;\n`);
    writeFileSync(join(root, "test", `${x}.test.ts`), `import { ${x} } from "../src/${x}";\n`);
  }
  state.root = root;
  state.failing = {};
  state.failingAtRef = {};
  state.runMs = 0;
  state.runMsFor = undefined;
  state.fifo = false;
  state.capacity = 1;
  state.refRoot = "";
  state.hang = undefined;
  state.runGate = undefined;
  resetCounters();
});

afterEach(() => {
  rmSync(state.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  if (state.refRoot !== "") rmSync(state.refRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe("batch coordinator behind the verification wiring (2.2.3)", () => {
  it("green: 5 concurrent gates spawn 1 union run under 1 slot hold; the verdicts equal batchWindowMs: 0", async () => {
    const { batched, alone, b, a } = await batchedAndAlone();
    // B13 green path, P1 present, no test file among the inputs: exactly one scoped run.
    expect(b.runs).toHaveLength(1);
    expect(b.runs[0]?.inputs).toEqual(LETTERS.map(x => join(state.root, "src", `${x}.ts`)).sort());
    expect(b.acquires).toBe(1);
    expect(b.releases).toBe(1);
    expect(b.maxHolds).toBe(1);
    // Alone: the direct hook, one run and one hold per gate.
    expect(a.runs.map(r => r.inputs)).toEqual(expect.arrayContaining(LETTERS.map(x => [join(state.root, "src", `${x}.ts`)])));
    expect(a.runs).toHaveLength(5);
    expect(a.acquires).toBe(5);
    expect(batched.map(r => r.verdict.outcome)).toEqual(LETTERS.map(() => "pass"));
    expect(batched.map(verdictOf)).toEqual(alone.map(verdictOf));
  });

  it("failing vitest path (mode B): 1 + 5 runs under 1 hold; only the failing test's producer is not a pass, as alone", async () => {
    state.failing = { c: ["t2"] };
    const { batched, alone, b, a } = await batchedAndAlone();
    // Deviation D2: the union, then each member's own spec, all under the batch's single hold.
    expect(b.runs).toHaveLength(1 + 5);
    expect(b.runs.every(r => r.holds === 1)).toBe(true);
    expect(b.acquires).toBe(1);
    expect(b.maxHolds).toBe(1);
    expect(a.runs).toHaveLength(5);
    expect(batched.map(r => r.verdict.outcome)).toEqual(["pass", "pass", "unverifiable", "pass", "pass"]);
    expect(batched[2]?.verdict.reasons.join(" ")).toContain("test/c.test.ts > t2");
    expect(batched.map(verdictOf)).toEqual(alone.map(verdictOf));
  });

  it("QA-2.2-5: a member settles while its batch still holds the slot for the others' own runs", async () => {
    // QA-2.2-22: the order is forced. a has the least time left, so after the union (run 0) its
    // own run (run 1) is first (B5.5) and reproduces the failure: a is final and settles. Every
    // later own run waits until a gate has settled.
    state.failing = { a: ["t2"] };
    let firstSettled: () => void = () => {};
    const settled = new Promise<void>(resolve => {
      firstSettled = resolve;
    });
    state.runGate = index => (index >= 2 ? settled : undefined);
    const order: { x: string; holds: number }[] = [];
    const wiring = wiringWith({ batchWindowMs: WINDOW_MS });
    void barrier(LETTERS.length);
    await Promise.all(
      LETTERS.map(x =>
        gate(wiring, x, {
          budgetMs: x === "a" ? 100_000 : 120_000,
          onSettled: () => {
            order.push({ x, holds: state.holds });
            firstSettled();
          },
        }),
      ),
    );
    await wiring.disposeVerification();
    // Settled early: a's verdict came in while the batch's hold was live for the others' runs ...
    expect(order[0]).toEqual({ x: "a", holds: 1 });
    expect(state.runs).toHaveLength(1 + 5);
    // ... and the hold is released exactly once, after the last run (B10: an accepted cost, never a deadlock).
    expect(state.releases).toBe(1);
    expect(state.holds).toBe(0);
  });

  it("QA-2.2-8: each batched recheck receives its own gate's tree snapshot, as the direct hook does", async () => {
    state.failing = { c: ["t2"], d: ["t1"] };
    // Two distinct references: one recheck per member (B8.4), each with its own gate's tree.
    const refs: Record<string, ReferenceState> = { c: captured("c".repeat(40)), d: captured("d".repeat(40)) };
    const trees = Object.fromEntries(LETTERS.map(x => [x, tree(x)]));
    const { batched, alone, b, a } = await batchedAndAlone(x => ({ reference: refs[x] ?? NONE, snapshot: trees[x] }));
    expect(b.materialized).toHaveLength(2);
    expect(new Set(b.materialized)).toEqual(new Set([trees.c, trees.d]));
    expect(new Set(a.materialized)).toEqual(new Set([trees.c, trees.d]));
    expect(b.acquires).toBe(1);
    expect(batched.map(r => r.verdict.outcome)).toEqual(["pass", "pass", "unverifiable", "unverifiable", "pass"]);
    expect(batched.map(verdictOf)).toEqual(alone.map(verdictOf));
  });

  it("a shared reference: the failing members' recheck is one shared recheck, with the first member's tree", async () => {
    state.failing = { c: ["t2"], d: ["t1"] };
    const shared = captured();
    const trees = Object.fromEntries(LETTERS.map(x => [x, tree(x)]));
    const { batched, alone, b, a } = await batchedAndAlone(x => ({ reference: shared, snapshot: trees[x] }));
    // B13: 1 + n runs, and <= 1 recheck for the distinct reference; alone, one recheck per failing gate.
    expect(b.runs).toHaveLength(1 + 5);
    expect(b.materialized).toHaveLength(1);
    expect([trees.c, trees.d]).toContain(b.materialized[0]);
    expect(a.materialized).toHaveLength(2);
    expect(batched.map(verdictOf)).toEqual(alone.map(verdictOf));
  });

  it("QA-2.2-20: with an exact reference, an introduced failure is rejected and a pre-existing one passes, batched as alone", async () => {
    exactReference();
    state.failing = { c: ["t2"], d: ["t1"] };
    state.failingAtRef = { d: ["t1"] };
    const { batched, alone, b, a } = await batchedAndAlone(() => ({ reference: captured() }));
    expect(batched.map(r => [r.verdict.outcome, r.accepted])).toEqual([
      ["pass", true],
      ["pass", true],
      ["fail", false],
      ["pass", true],
      ["pass", true],
    ]);
    expect(batched[2]?.verdict.reasons.join(" ")).toContain("test/c.test.ts > t2");
    expect(batched[3]?.verdict.failures).toEqual(alone[3]?.verdict.failures);
    expect(batched.map(verdictOf)).toEqual(alone.map(verdictOf));
    // One shared recheck at the one reference, where alone each failing gate rechecks.
    expect(b.materialized).toHaveLength(1);
    expect(a.materialized).toHaveLength(2);
  });

  it("QA-2.2-20 (R2): failureRecheck off at the gate disables a captured reference, batched as alone", async () => {
    // An exact reference: a batch that ignored the setting would recheck and reject c.
    exactReference();
    state.failing = { c: ["t2"] };
    const { batched, alone, b } = await batchedAndAlone(() => ({ reference: captured() }), { failureRecheck: false });
    expect(b.materialized).toHaveLength(0);
    expect(batched[2]?.verdict.outcome).toBe("unverifiable");
    expect(batched[2]?.verdict.reasons.join(" ")).toContain("failureRecheck is off");
    expect(batched.map(verdictOf)).toEqual(alone.map(verdictOf));
  });

  it("QA-2.2-20: a config flip between two gates of one window: each keeps its own gate's failureRecheck", async () => {
    exactReference();
    state.failing = { c: ["t2"], d: ["t1"] };
    let verify: Parameters<typeof config>[0] = { batchWindowMs: WINDOW_MS, failureRecheck: true };
    const wiring = createVerificationWiring({ client: {}, directory: state.root, getConfig: () => config(verify), logger: { warn: () => {} }, batch: { maxBatchSize: 5 } });
    void barrier(2);
    // buildGateDeps reads the config when the gate starts, before its first await.
    const on = gate(wiring, "c", { reference: captured() });
    verify = { ...verify, failureRecheck: false };
    const off = gate(wiring, "d", { reference: captured() });
    const [rc, rd] = await Promise.all([on, off]);
    await wiring.disposeVerification();
    // One window: the union, then both own runs (mode B), then c's reference run only.
    expect(state.runs).toHaveLength(1 + 2 + 1);
    expect(state.acquires).toBe(1);
    expect(rc.verdict.outcome).toBe("fail");
    expect(rd.verdict.outcome).toBe("unverifiable");
    expect(rd.verdict.reasons.join(" ")).toContain("failureRecheck is off");
  });

  it("testScope full bypasses the window: the direct hook runs the command as written, once per gate", async () => {
    const { batched, alone, b, a } = await batchedAndAlone(() => ({}), { testScope: "full" });
    expect(b.runs).toHaveLength(0);
    expect(b.shells).toEqual(LETTERS.map(() => "npm test"));
    expect(b.acquires).toBe(5);
    expect(a.shells).toHaveLength(5);
    expect(batched.map(verdictOf)).toEqual(alone.map(verdictOf));
  });

  it("dispose settles a gate waiting in its window, and later gates, with nothing spawned; sweep evicts nothing live", async () => {
    // A recording timer seam: the window's one timer is armed when the first member joins (W1).
    const windows: unknown[] = [];
    const wiring = wiringWith({ batchWindowMs: WINDOW_MS }, {
      timers: {
        setTimeout: (callback: () => void, ms: number) => {
          const handle = setTimeout(callback, ms);
          windows.push(handle);
          return handle;
        },
        clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
    });
    // W7: b is still planning, so a's window stays open.
    const releaseB = holdPlanning("b");
    const planning = gate(wiring, "b");
    const waiting = gate(wiring, "a");
    await vi.waitFor(() => expect(windows).toHaveLength(1));
    // The window is open (it needs 5 members or 60 s) and has a live member: nothing to evict.
    expect(wiring.sweepVerification()).toBe(0);
    await wiring.disposeVerification();
    releaseB();
    const first = await waiting;
    const held = await planning;
    const later = await gate(wiring, "c");
    for (const r of [first, held, later]) {
      expect(r.verdict.outcome).toBe("unverifiable");
      expect(r.verdict.reasons.join(" ")).toContain(BATCH_REASONS.disposed);
    }
    expect(state.runs).toHaveLength(0);
    expect(state.acquires).toBe(0);
    // Idempotent.
    await expect(wiring.disposeVerification()).resolves.toBeUndefined();
  });

  it("QA-2.2-21: the effective window is at most a tenth of the gate budget", async () => {
    const armed: number[] = [];
    const cfg = config({ batchWindowMs: 60_000, gateBudgetMs: 20_000 });
    const wiring = createVerificationWiring({
      client: {},
      directory: state.root,
      getConfig: () => cfg,
      logger: { warn: () => {} },
      batch: {
        maxBatchSize: 5,
        timers: {
          setTimeout: (callback: () => void, ms: number) => {
            armed.push(ms);
            return setTimeout(callback, ms);
          },
          clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        },
      },
    });
    // W7: b stays in planning, so a's window runs its timer.
    const releaseB = holdPlanning("b");
    const held = gate(wiring, "b");
    const started = Date.now();
    const a = gate(wiring, "a");
    await vi.waitFor(() => expect(armed).toHaveLength(1));
    expect(armed[0]).toBe(2_000);
    expect((await a).verdict.outcome).toBe("pass");
    expect(Date.now() - started).toBeLessThan(10_000);
    releaseB();
    expect((await held).verdict.outcome).toBe("pass");
    await wiring.disposeVerification();
  });

  it("QA-2.2-19 (R3, R4): a seam that ignores its abort keeps its slot until it exits; sweep evicts it and dispose returns after the grace", async () => {
    let exit: () => void = () => {};
    state.hang = new Promise<void>(resolve => {
      exit = resolve;
    });
    let clock = Date.now();
    const warns: string[] = [];
    const cfg = config({ batchWindowMs: 2000 });
    const wiring = createVerificationWiring({
      client: {},
      directory: state.root,
      getConfig: () => cfg,
      logger: { warn: message => void warns.push(message) },
      batch: {
        maxBatchSize: 5,
        now: () => clock,
        // The grace of B11 shortened to 20 ms; every other timer as is.
        timers: {
          setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms === BATCH_STALE_GRACE_MS ? 20 : ms),
          clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        },
      },
    });
    void barrier(2);
    // Both gates run out of budget during the union run, whose tree never exits.
    const gates = await Promise.all(["a", "b"].map(x => gate(wiring, x, { budgetMs: 1_500 })));
    expect(gates.map(r => r.verdict.outcome)).toEqual(["unverifiable", "unverifiable"]);
    expect(state.acquires).toBe(1);
    expect(wiring.sweepVerification()).toBe(0);
    clock += BATCH_STALE_GRACE_MS + 1;
    // R4: evicted, and logged as it happens: the slot stays held while the seam runs.
    expect(wiring.sweepVerification()).toBe(1);
    expect(warns).toContain("verify batch: evicted a batch whose seam never returned; its scope closes, and its slot is released, once the seam exits");
    expect(state.releases).toBe(0);
    // R3: dispose returns once the grace is over, although the evicted scope's close still waits.
    const outcome = await Promise.race([wiring.disposeVerification().then(() => "disposed"), sleep(3_000).then(() => "pending")]);
    expect(outcome).toBe("disposed");
    expect(warns).toContain("verify batch: dispose stopped waiting for scope closes; each slot is released once its seam exits");
    expect(state.releases).toBe(0);
    exit();
    await vi.waitFor(() => expect(state.releases).toBe(1));
  });
});

describe("batched gates under deadline pressure are never weaker than batchWindowMs: 0 (QA-2.2-17)", () => {
  it("R6, QA-2.2-18: a lone gate does not wait for its window, so its recheck still fits and the introduced failure is rejected", async () => {
    exactReference();
    state.failing = { c: ["t2"] };
    // 11 s at testsPass: the run and the recheck fit above the 10 s threshold, a 2 s wait would not.
    const run = async (verify: Parameters<typeof wiringWith>[0]) => {
      resetCounters();
      const wiring = wiringWith(verify);
      const started = Date.now();
      const r = await gate(wiring, "c", { reference: captured(), budgetMs: 11_000 });
      const elapsed = Date.now() - started;
      await wiring.disposeVerification();
      return { r, elapsed, runs: state.runs.length };
    };
    const batched = await run({ batchWindowMs: 2000 });
    const alone = await run({ batchWindowMs: 0 });
    expect(alone.r.verdict.outcome).toBe("fail");
    expect(alone.r.accepted).toBe(false);
    expect(verdictOf(batched.r)).toEqual(verdictOf(alone.r));
    // The scoped run and the reference run, with no window wait.
    expect(batched.runs).toBe(2);
    expect(batched.elapsed).toBeLessThan(1_500);
  });

  it("W3: with another gate in flight, the window closes before it eats into a member's recheck reserve", async () => {
    exactReference();
    state.failing = { c: ["t2"] };
    // 11.5 s: floor 11 s (10 s recheck threshold + 1 s margin), so c may wait 0.5 s, not the 2 s window.
    resetCounters();
    const wiring = wiringWith({ batchWindowMs: 2000 });
    const releaseA = holdPlanning("a");
    const other = gate(wiring, "a");
    const batched = await gate(wiring, "c", { reference: captured(), budgetMs: 11_500 });
    releaseA();
    expect((await other).verdict.outcome).toBe("pass");
    await wiring.disposeVerification();

    resetCounters();
    const aloneWiring = wiringWith({ batchWindowMs: 0 });
    const alone = await gate(aloneWiring, "c", { reference: captured(), budgetMs: 11_500 });
    await aloneWiring.disposeVerification();
    expect(alone.verdict.outcome).toBe("fail");
    expect(verdictOf(batched)).toEqual(verdictOf(alone));
  });

  it("R5: a gate that arrives while a batch runs gathers behind it instead of joining a failing union", async () => {
    exactReference();
    state.failing = { c: ["t2"] };
    state.fifo = true;
    state.runMs = 1_000;
    // 15.5 s each; c arrives 30 ms after the others. Alone (one FIFO slot): c runs 5th, 4-5 s, and
    // rechecks with 10.5 s left.
    const run = async (verify: Parameters<typeof wiringWith>[0]) => {
      resetCounters();
      const wiring = wiringWith(verify);
      const others = ["a", "b", "d", "e"];
      const released = barrier(others.length);
      const first = others.map(x => gate(wiring, x, { reference: captured(), budgetMs: 15_500 }));
      await released;
      await sleep(30);
      const c = await gate(wiring, "c", { reference: captured(), budgetMs: 15_500 });
      const rest = await Promise.all(first);
      await wiring.disposeVerification();
      return { verdicts: [...rest.slice(0, 2), c, ...rest.slice(2)], runs: state.runs.length };
    };
    const batched = await run({ batchWindowMs: WINDOW_MS });
    const alone = await run({ batchWindowMs: 0 });
    expect(alone.verdicts[2]?.verdict.outcome).toBe("fail");
    expect(batched.verdicts.map(verdictOf)).toEqual(alone.verdicts.map(verdictOf));
    // The four gates' green union, then c's own run and its reference run.
    expect(batched.runs).toBe(3);
  }, 40_000);

  it("R5, B5.2a: in one window, members whose budget cannot cover the union and mode B run alone, as batchWindowMs: 0", async () => {
    exactReference();
    state.failing = { c: ["t2"] };
    state.fifo = true;
    state.runMs = 1_000;
    // After a first gate measured a 1 s run, five gates meet in one window. Pooled, c (the most
    // time left, so last in deadline order) would run 6th, after the union and four own runs:
    // 15.7 - 6 < 10, no recheck. Alone it runs at worst 5th and rechecks.
    const run = async (verify: Parameters<typeof wiringWith>[0]) => {
      resetCounters();
      const wiring = wiringWith(verify);
      await gate(wiring, "f");
      void barrier(LETTERS.length);
      const verdicts = await Promise.all(LETTERS.map(x => gate(wiring, x, { reference: captured(), budgetMs: x === "c" ? 15_700 : 15_500 })));
      await wiring.disposeVerification();
      return { verdicts, runs: state.runs.length };
    };
    const batched = await run({ batchWindowMs: 2000 });
    const alone = await run({ batchWindowMs: 0 });
    expect(alone.verdicts[2]?.verdict.outcome).toBe("fail");
    expect(batched.verdicts.map(verdictOf)).toEqual(alone.verdicts.map(verdictOf));
    // f's run, then the five own runs (a split: no union) and c's reference run.
    expect(batched.runs).toBe(1 + 5 + 1);
  }, 40_000);
});

/**
 * QA-2.2-23 to QA-2.2-25 (the phase 2.2.3 QA round 2 repro shapes N1, N1b, N2, N2b and N3). A
 * first lone gate f measures the key's run estimate, 1 s. The recheck threshold is 10 s and the
 * margin 1 s, so a member with a captured reference has an 11 s floor, and one without has 1 s.
 * Each case runs batched, then with batchWindowMs: 0, and the verdicts must be equal: by default an
 * unverifiable verdict is accepted, so a batched unverifiable where alone is fail would weaken
 * the gate.
 */
describe("QA-2.2-23 to QA-2.2-25: batched gates keep the verdict of batchWindowMs: 0", () => {
  /** f's lone run (the 1 s estimate), then `body` on the same wiring. */
  const twice = async <T>(body: (wiring: VerificationWiring) => Promise<T>) => {
    const once = async (verify: Parameters<typeof wiringWith>[0]) => {
      resetCounters();
      const wiring = wiringWith(verify);
      await gate(wiring, "f");
      const out = await body(wiring);
      await wiring.disposeVerification();
      return { out, runs: state.runs.length, acquires: state.acquires, maxHolds: state.maxHolds };
    };
    const batched = await once({ batchWindowMs: 2000 });
    const alone = await once({ batchWindowMs: 0 });
    return { batched, alone };
  };

  it("N1 (QA-2.2-23): a short member whose slot wait is cut leaves the others their own slot wait", async () => {
    exactReference();
    state.failing = { a: ["t2"] };
    state.fifo = true;
    state.runMs = 1_000;
    // Another gate's check holds the one slot for 3.5 s. c (2.5 s, no reference) cannot outlive
    // it; a and b (60 s, exact reference) can, and a has an introduced failure.
    const { batched, alone } = await twice(async wiring => {
      const held = occupySlot(3_500);
      void barrier(3);
      const verdicts = await Promise.all([
        gate(wiring, "a", { reference: captured(), budgetMs: 60_000 }),
        gate(wiring, "b", { reference: captured(), budgetMs: 60_000 }),
        gate(wiring, "c", { budgetMs: 2_500 }),
      ]);
      await held;
      return verdicts;
    });
    expect(alone.out.map(outcomeOf)).toEqual([
      ["fail", false],
      ["pass", true],
      ["unverifiable", true],
    ]);
    expect(batched.out.map(verdictOf)).toEqual(alone.out.map(verdictOf));
    // No slot hold is ever nested or shared by two batches: one live hold per scope, at most one.
    expect(batched.maxHolds).toBe(1);
  }, 40_000);

  it("N1b (QA-2.2-23): the same with one long member, where the batch splits", async () => {
    exactReference();
    state.failing = { a: ["t2"] };
    state.fifo = true;
    state.runMs = 1_000;
    const { batched, alone } = await twice(async wiring => {
      const held = occupySlot(3_500);
      void barrier(2);
      const verdicts = await Promise.all([
        gate(wiring, "a", { reference: captured(), budgetMs: 60_000 }),
        gate(wiring, "c", { budgetMs: 2_500 }),
      ]);
      await held;
      return verdicts;
    });
    expect(alone.out.map(outcomeOf)).toEqual([
      ["fail", false],
      ["unverifiable", true],
    ]);
    expect(batched.out.map(verdictOf)).toEqual(alone.out.map(verdictOf));
  }, 40_000);

  it("N2 (QA-2.2-24): a window held open by another gate's planning keeps the reserve of the schedule its members then run", async () => {
    exactReference();
    state.failing = { c: ["t2"], d: ["t1"] };
    state.fifo = true;
    state.runMs = 1_000;
    // One slot. a is still planning, so W7 keeps the window of c (14.0 s) and d (14.1 s) open.
    // Alone, the second of them runs after the first's run and recheck, and still rechecks.
    const { batched, alone } = await twice(async wiring => {
      const releaseA = holdPlanning("a");
      const other = gate(wiring, "a");
      const verdicts = await Promise.all([
        gate(wiring, "c", { reference: captured(), budgetMs: 14_000 }),
        gate(wiring, "d", { reference: captured(), budgetMs: 14_100 }),
      ]);
      releaseA();
      expect((await other).verdict.outcome).toBe("pass");
      return verdicts;
    });
    expect(alone.out.map(outcomeOf)).toEqual([
      ["fail", false],
      ["fail", false],
    ]);
    expect(batched.out.map(verdictOf)).toEqual(alone.out.map(verdictOf));
  }, 40_000);

  it("N2b (QA-2.2-24): two gates that arrive just after a lone gate went direct, with two slots", async () => {
    exactReference();
    state.failing = { c: ["t2"], d: ["t1"], e: ["t1"] };
    state.fifo = true;
    state.capacity = 2;
    state.runMs = 1_000;
    // g (test file e) is alone, so it runs at once (W7) on one slot, with a run and a recheck.
    // c and d arrive 100 ms later. Alone, c runs beside g, and d takes g's slot when g is done.
    const { batched, alone } = await twice(async wiring => {
      const g = gate(wiring, "e", { reference: captured(), budgetMs: 60_000 });
      await sleep(100);
      const verdicts = await Promise.all([
        gate(wiring, "c", { reference: captured(), budgetMs: 14_000 }),
        gate(wiring, "d", { reference: captured(), budgetMs: 14_100 }),
      ]);
      return [await g, ...verdicts];
    });
    expect(alone.out.map(outcomeOf)).toEqual([
      ["fail", false],
      ["fail", false],
      ["fail", false],
    ]);
    expect(batched.out.map(verdictOf)).toEqual(alone.out.map(verdictOf));
    expect(batched.maxHolds).toBeLessThanOrEqual(2);
  }, 40_000);

  it("N3 (QA-2.2-25): a union run is not priced as one member's run", async () => {
    exactReference();
    state.failing = { c: ["t2"], e: ["t1"] };
    state.fifo = true;
    // maxWorkers 2: a run takes 1 s per 2 inputs, so the 5-input union takes 3 s where f took 1 s.
    state.runMsFor = inputs => Math.ceil(inputs / 2) * 1_000;
    const budgets: Record<string, number> = { a: 18_300, b: 19_300, c: 17_300, d: 20_300, e: 21_300 };
    const { batched, alone } = await twice(async wiring => {
      // c arrives first (W3 then keeps every member in the window), and is first in the FIFO alone.
      barrierInOrder(["c", "a", "b", "d", "e"]);
      return await Promise.all(LETTERS.map(x => gate(wiring, x, { reference: captured(), budgetMs: budgets[x] })));
    });
    expect(alone.out.map(outcomeOf)).toEqual([
      ["pass", true],
      ["pass", true],
      ["fail", false],
      ["pass", true],
      ["fail", false],
    ]);
    expect(batched.out.map(verdictOf)).toEqual(alone.out.map(verdictOf));
  }, 60_000);

  it("QA-2.2-25: a pooled batch that waits for the slot longer than its schedule allows runs its members alone", async () => {
    exactReference();
    state.failing = { c: ["t2"], d: ["t1"] };
    state.fifo = true;
    // The estimate e is f's lone run, 1 s (one input). A run of two inputs, the union of c and d,
    // takes 4 s; the members' own runs and the rechecks (one input each) take 1 s.
    state.runMsFor = inputs => (inputs >= 2 ? 4_000 : 1_000);
    // Both members fit the pooled schedule when the window closes (21.5 s - 11 s floor - 5 e = 5.5
    // s of slack), but another check holds the one slot for 6.5 s, so the pooled wait is cut at
    // 5.5 s and the members run alone. Alone, d's recheck (two distinct references: two rechecks)
    // starts at 9.5 s with 12 s left, 2 s above the 10 s threshold: the wall-clock overhead of
    // planning, scopes and report files can use that 2 s without changing the scenario. Had the
    // batch waited and pooled, d's recheck would start at 6.5 + 4 (union) + 3 = 13.5 s with 8 s
    // left, 2 s below it: the unverifiable verdict this test refuses. The budget is derived from
    // this schedule (hold + runs + threshold + margin), so machine speed does not decide the case.
    const { batched, alone } = await twice(async wiring => {
      const held = occupySlot(6_500);
      void barrier(2);
      const verdicts = await Promise.all([
        gate(wiring, "c", { reference: captured("c".repeat(40)), budgetMs: 21_500 }),
        gate(wiring, "d", { reference: captured("d".repeat(40)), budgetMs: 21_500 }),
      ]);
      await held;
      return verdicts;
    });
    expect(alone.out.map(outcomeOf)).toEqual([
      ["fail", false],
      ["fail", false],
    ]);
    expect(batched.out.map(verdictOf)).toEqual(alone.out.map(verdictOf));
  }, 60_000);
});
