/**
 * test/integration/router-verify-tool.test.ts
 *
 * Phase 2.4.3 (plan Phase 2.4, section 1.5-18; pending.ts R2, R4, R6, R8, R11): router_verify.
 *
 * - "verifyHandles (2.4.3a)" drives the wiring directly.
 * - "the router_verify tool (2.4.3b)" drives the plugin's registered tool.
 *
 * The project is a real vitest-shaped directory on disk, so the real planner, scope opener, batch
 * coordinator, readResult and judge run (as in batch-wiring.test.ts). Only the process seams are
 * fake: runArgv writes the vitest JSON report the spec asks for, acquireSlot counts holds, the tree
 * snapshot is fixed, and materialize returns an exact reference over a copy of the project.
 * Pending entries are registered directly with the shape 2.4.2's finishDeferred registers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import ModelRouterPlugin from "../../src/index";
import { invalidateConfigCache } from "../../src/router/config";
import { parseCapDirective } from "../../src/router/sessions";
import { parseVerifyDirectives } from "../../src/verify/directives";
import {
  backgroundOutcomes,
  concurrentDispatchesCaveat,
  contaminatedBaselineCaveat,
  createVerificationWiring,
  digestFiles,
  DRIFT_NOTICE,
  DRIFT_UNCHECKED_NOTICE,
  isRetryableVerdict,
  parseRouterVerifyArgs,
  ROUTER_VERIFY_ARGS_TEXT,
  ROUTER_VERIFY_NO_PENDING_TEXT,
  ROUTER_VERIFY_NO_RETRY_TEXT,
  type HandleReport,
  type VerificationWiring,
} from "../../src/verify/wiring";
import {
  buildLateNoticeBlock,
  EXPIRED_HANDLE_TEXT,
  LATE_NOTICE_MIXED_HEADER,
  PENDING_LIST_MIXED_HEADER,
  MAX_HANDLES_PER_CALL,
  UNKNOWN_HANDLE_TEXT,
  type BackgroundQueue,
  type PendingRegistration,
  type PendingRegistry,
} from "../../src/verify/pending";
import type { RouterConfig } from "../../src/router/config";
import type { DoD } from "../../src/verify/dod";
import { createChangedFileStore, type TreeSnapshot } from "../../src/verify/dispatch";
import { createDeadline } from "../../src/verify/deterministic";
import { accept } from "../../src/verify/gate";
import { REFERENCE_NONE } from "../../src/verify/baseline";
import type { DispatchReference } from "../../src/verify/reference";
import type { ReferenceState, Verdict } from "../../src/verify/types";

type ExecOut = { code: number; stdout: string; stderr: string; timedOut: boolean };

const state = vi.hoisted(() => ({
  root: "",
  /** Test file letter -> failing test names now. */
  failing: {} as Record<string, string[]>,
  /** The same at the exact reference (a failure listed here is pre-existing). */
  failingAtRef: {} as Record<string, string[]>,
  /** Every scoped test run (non-git argv spawn): its inputs, the live slot holds and its priority. */
  runs: [] as { inputs: string[]; holds: number; lowPriority: boolean | undefined }[],
  /** While set, a scoped test run hangs until its signal aborts (the tree kill), which is counted. */
  hang: false,
  killed: 0,
  /** createBackgroundQueue calls (2.4.5: never when background is off). */
  queues: 0,
  /** What the tree snapshot lists (a deferred finish attributes the files it adds). */
  treeFiles: [] as TreeSnapshot["files"],
  snapshotThrows: false,
  /** The dispatch-time reference capture; default: an exact capture at once. */
  capture: undefined as undefined | ((signal: AbortSignal) => Promise<DispatchReference>),
  git: 0,
  shells: 0,
  acquires: 0,
  releases: 0,
  holds: 0,
  maxHolds: 0,
  snapshots: 0,
  /** QA-3.1-8: SnapshotOptions.lowPriority of every snapshotTree call. */
  snapshotPriorities: [] as (boolean | undefined)[],
  deadlines: 0,
  /** acquireSlot answers busy while set. */
  slotBusy: false,
  /** When > 0: at most this many holds; a caller waits up to its waitMs for a release, then busy. */
  slotMax: 0,
  /** The waitMs of every acquireSlot call, in call order. */
  slotWaits: [] as number[],
  /** While set, only low-priority (background) scoped runs hang until killed. */
  hangLow: false,
  /** When set, materialize returns an exact reference over this copy of the project. */
  refRoot: "",
  /** Further exact references, by DispatchReference.commit: their copy and what fails there. */
  otherRefs: {} as Record<string, { dir: string; failing: Record<string, string[]> }>,
  /** A run at state.refRoot (the first reference) is held this long: it then finishes last. */
  refDelayMs: 0,
  /** Called after each planScopedRun with the planned changed paths: a barrier or a hold. */
  planGate: undefined as undefined | ((changed: readonly string[]) => Promise<void> | undefined),
  /** Every gate (accept) not yet settled, including one a cancelled or timed-out call stopped waiting for. */
  gates: new Set<Promise<unknown>>(),
}));

vi.mock("../../src/verify/exec", () => ({
  runShell: async (): Promise<ExecOut> => {
    state.shells++;
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  },
  runArgv: async (file: string, args: readonly string[], opts?: { signal?: AbortSignal; lowPriority?: boolean }): Promise<ExecOut> => {
    if (file === "git") {
      state.git++;
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    }
    return await fakeVitest(args, opts);
  },
}));

vi.mock("../../src/verify/pending", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/verify/pending")>();
  return {
    ...actual,
    createBackgroundQueue: (...args: Parameters<typeof actual.createBackgroundQueue>) => {
      state.queues++;
      return actual.createBackgroundQueue(...args);
    },
  };
});

vi.mock("../../src/verify/tree", () => ({
  snapshotTree: async (cwd: string, _signal: AbortSignal, options?: { lowPriority?: boolean }): Promise<TreeSnapshot> => {
    state.snapshots++;
    state.snapshotPriorities.push(options?.lowPriority);
    if (state.snapshotThrows) throw new Error("git status failed");
    // Outside the project (another repository): its own, clean tree.
    if (relative(state.root, cwd).startsWith("..")) return { cwd, root: cwd, head: "a".repeat(40), fingerprint: "other", dirty: false, files: [] };
    return { cwd: state.root, root: state.root, head: "a".repeat(40), fingerprint: state.treeFiles.length === 0 ? "now" : `now${state.treeFiles.length}`, dirty: true, files: [...state.treeFiles] };
  },
}));

vi.mock("../../src/verify/deterministic", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/verify/deterministic")>();
  return {
    ...actual,
    createDeadline: (...args: Parameters<typeof actual.createDeadline>) => {
      state.deadlines++;
      return actual.createDeadline(...args);
    },
  };
});

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

// withTimeout does not stop the gate it gives up on: a router_verify call cancelled or timed out
// answers at once while its gate still plans, reading the project's files (QA-2.2-9: planning runs
// even under an exhausted deadline). The cleanup waits for every gate, so it never deletes the
// project under a read in flight.
vi.mock("../../src/verify/gate", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/verify/gate")>();
  return {
    ...actual,
    accept: (...args: Parameters<typeof actual.accept>) => {
      const gate = actual.accept(...args);
      state.gates.add(gate);
      const done = (): void => {
        state.gates.delete(gate);
      };
      gate.then(done, done);
      return gate;
    },
  };
});

/** Callers waiting for a slot release (state.slotMax). */
const slotWaiters: Array<() => void> = [];

vi.mock("../../src/verify/slot", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/verify/slot")>()),
  acquireSlot: async (opts: { signal?: AbortSignal; waitMs?: number }) => {
    state.slotWaits.push(opts.waitMs ?? -1);
    if (opts.signal?.aborted === true || state.slotBusy) return { busy: true as const };
    if (state.slotMax > 0 && state.holds >= state.slotMax) {
      // Like the real slot: wait up to waitMs for a release, else busy.
      const freed = await new Promise<boolean>(resolveWait => {
        const timer = setTimeout(() => resolveWait(false), Math.max(0, opts.waitMs ?? 0));
        slotWaiters.push(() => {
          clearTimeout(timer);
          resolveWait(true);
        });
      });
      if (!freed || state.holds >= state.slotMax) return { busy: true as const };
    }
    state.acquires++;
    state.holds++;
    state.maxHolds = Math.max(state.maxHolds, state.holds);
    let released = false;
    return {
      lost: false,
      release: async () => {
        if (released) return;
        released = true;
        state.releases++;
        state.holds--;
        slotWaiters.shift()?.();
      },
    };
  },
}));

// The plugin's own wiring instance, so the tool tests can register pending entries in it.
const plugin = vi.hoisted(() => ({ wiring: undefined as import("../../src/verify/wiring").VerificationWiring | undefined }));
vi.mock("../../src/verify/wiring", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/verify/wiring")>();
  return {
    ...actual,
    createVerificationWiring: (...args: Parameters<typeof actual.createVerificationWiring>) => {
      const wiring = actual.createVerificationWiring(...args);
      plugin.wiring = wiring;
      return wiring;
    },
  };
});

vi.mock("../../src/verify/reference", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/verify/reference")>()),
  gcStaleReferences: async () => ({ removed: [], kept: [], failed: [] }),
  captureReference: async (_at: string, signal: AbortSignal): Promise<DispatchReference> => {
    if (state.capture !== undefined) return await state.capture(signal);
    const ref = captured();
    if (ref.kind !== "captured") throw new Error("unreachable");
    return ref.reference;
  },
  materialize: async (ref: DispatchReference) => {
    const dir = state.otherRefs[ref.commit]?.dir ?? state.refRoot;
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

/** A vitest run over the fake project (or its reference copy): each source relates to its own test file. */
async function fakeVitest(args: readonly string[], opts?: { signal?: AbortSignal; lowPriority?: boolean }): Promise<ExecOut> {
  const other = Object.values(state.otherRefs).find(r => args.some(a => a.startsWith(r.dir)));
  const atRef = other === undefined && state.refRoot !== "" && args.some(a => a.startsWith(state.refRoot));
  const root = other?.dir ?? (atRef ? state.refRoot : state.root);
  const failingNow = other?.failing ?? (atRef ? state.failingAtRef : state.failing);
  const report = args.find(a => a.startsWith("--outputFile="))?.slice("--outputFile=".length);
  const inputs = args.filter(a => isAbsolute(a) && a.startsWith(root) && !a.includes("node_modules"));
  state.runs.push({ inputs: [...inputs].sort(), holds: state.holds, lowPriority: opts?.lowPriority });
  if (atRef && state.refDelayMs > 0) await new Promise(resolve => setTimeout(resolve, state.refDelayMs));
  if (state.hang || (state.hangLow && opts?.lowPriority === true)) {
    // Like a real tree: it runs until the run's signal kills it, and writes no report.
    await new Promise<void>(resolve => {
      const signal = opts?.signal;
      if (signal === undefined) return;
      const kill = (): void => {
        state.killed++;
        resolve();
      };
      if (signal.aborted) kill();
      else signal.addEventListener("abort", kill, { once: true });
    });
    return { code: 1, stdout: "", stderr: "killed", timedOut: false };
  }
  const letters = [...new Set(inputs.map(a => /[\\/]([a-z])(?:\.test)?\.ts$/.exec(a)?.[1]).filter((x): x is string => x !== undefined))].sort();
  const testResults = letters.map(x => {
    const failing = failingNow[x] ?? [];
    // t1 and t2 always exist; any other failing title is one more test (a producer-chosen name).
    const titles = [...new Set(["t1", "t2", ...(state.failing[x] ?? []), ...(state.failingAtRef[x] ?? [])])];
    return {
      name: join(root, "test", `${x}.test.ts`),
      status: failing.length > 0 ? "failed" : "passed",
      assertionResults: titles.map(title => ({ title, ancestorTitles: [], status: failing.includes(title) ? "failed" : "passed" })),
    };
  });
  const total = testResults.reduce((n, s) => n + s.assertionResults.length, 0);
  if (report !== undefined) writeFileSync(report, JSON.stringify({ numTotalTests: total, numRuntimeErrorTestSuites: 0, testResults }));
  return { code: testResults.some(s => s.status === "failed") ? 1 : 0, stdout: "", stderr: "", timedOut: false };
}

const FILES = ["a", "b", "c", "d", "e"];
const DOD: DoD = { kind: "deterministic", source: "explicit", criteria: [], deliverable: null, checks: [{ kind: "testsPass", command: "npm test" }] };
const NONE: ReferenceState = { kind: "none", reason: "no reference captured" };

function config(verify: NonNullable<NonNullable<RouterConfig["enforcement"]>["verify"]> = {}): RouterConfig {
  return { activePreset: "a", presets: { a: { medium: { model: "p/m" } } }, defaultTier: "medium", rules: [], enforcement: { verify } };
}

function captured(commit = "b".repeat(40)): ReferenceState {
  return {
    kind: "captured",
    reference: { root: state.root, head: "a".repeat(40), commit, untracked: new Map(), tracked: new Map(), captureReasons: [], capturedAt: 0 } satisfies DispatchReference,
  };
}

/** Makes state.refRoot a copy of the project: materialize then returns an exact reference. */
function exactReference(): void {
  const refRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "omr-rv-ref-")));
  cpSync(state.root, refRoot, { recursive: true });
  state.refRoot = refRoot;
}

/** A second exact reference (another dispatch's), where `failing` fails: captured(commit) selects it. */
function otherReference(commit: string, failing: Record<string, string[]>): ReferenceState {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "omr-rv-ref2-")));
  cpSync(state.root, dir, { recursive: true });
  state.otherRefs[commit] = { dir, failing };
  return captured(commit);
}

const src = (x: string): string => join(state.root, "src", `${x}.ts`);

/** What 2.4.2's finishDeferred registers for a deferred producer that changed src/<x>.ts. */
async function register(pending: PendingRegistry, x: string, over: Partial<PendingRegistration> = {}): Promise<string> {
  const digests = await digestFiles([src(x)]);
  const r = pending.register({
    orchestratorSessionID: "orch",
    dispatchID: `task:orch:${x}`,
    producerSessionID: `child-${x}`,
    producerTier: "fast",
    description: `work ${x}`,
    cwd: state.root,
    root: state.root,
    dispatchedAt: Date.now(),
    dod: DOD,
    reference: Promise.resolve(captured()),
    changedFiles: [{ path: src(x), status: " M" }],
    risk: { level: "low", reasons: [] },
    digests: Promise.resolve(digests),
    ...over,
  });
  if (!r.ok) throw new Error(r.detail);
  return r.handle;
}

function makeWiring(
  verify: NonNullable<NonNullable<RouterConfig["enforcement"]>["verify"]> = {},
  pendingSeams: Parameters<typeof createVerificationWiring>[0]["pending"] = undefined,
  backgroundSeams: Parameters<typeof createVerificationWiring>[0]["background"] = undefined,
) {
  const cfg = config(verify);
  const client = { session: { create: vi.fn(async () => ({ data: { id: "never" } })), abort: vi.fn(async () => ({})), delete: vi.fn(async () => ({})) } };
  const wiring = createVerificationWiring({
    client,
    directory: state.root,
    getConfig: () => cfg,
    logger: { warn: () => {} },
    batch: { maxBatchSize: 5 },
    ...(pendingSeams !== undefined ? { pending: pendingSeams } : {}),
    ...(backgroundSeams !== undefined ? { background: backgroundSeams } : {}),
  });
  return { wiring, client, cfg };
}

function resetCounters(): void {
  Object.assign(state, {
    runs: [], git: 0, shells: 0, acquires: 0, releases: 0, holds: 0, maxHolds: 0, snapshots: 0, snapshotPriorities: [], deadlines: 0, planGate: undefined, killed: 0, queues: 0,
  });
}

/** Holds each planScopedRun until `n` are waiting, then releases them together (W7: all in flight). */
function barrier(n: number): void {
  const waiting: (() => void)[] = [];
  state.planGate = () =>
    new Promise<void>(resolve => {
      waiting.push(resolve);
      if (waiting.length < n) return;
      state.planGate = undefined;
      for (const go of waiting) go();
    });
}

/** Holds the planning of src/<x>.ts until the returned function is called. */
function holdPlanning(x: string): () => void {
  let release: () => void = () => {};
  const held = new Promise<void>(resolve => {
    release = resolve;
  });
  state.planGate = changed => (changed.includes(src(x)) ? held : undefined);
  return release;
}

function verdictOf(item: HandleReport | undefined) {
  if (item?.kind !== "verdict") throw new Error(`expected a verdict, got ${item?.kind}`);
  return item;
}

const inputsOf = (x: string): number => state.runs.filter(r => r.inputs.includes(src(x))).length;

beforeEach(() => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "omr-rv-")));
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "test"));
  mkdirSync(join(root, "node_modules", "vitest"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "router-verify", scripts: { test: "vitest run" }, devDependencies: { vitest: "3.0.0" } }));
  writeFileSync(join(root, "node_modules", "vitest", "package.json"), JSON.stringify({ name: "vitest", version: "3.0.0", bin: { vitest: "vitest.mjs" } }));
  writeFileSync(join(root, "node_modules", "vitest", "vitest.mjs"), "");
  for (const x of FILES) {
    writeFileSync(join(root, "src", `${x}.ts`), `export const ${x} = 1;\n`);
    writeFileSync(join(root, "test", `${x}.test.ts`), `import { ${x} } from "../src/${x}";\n`);
  }
  state.root = root;
  state.failing = {};
  state.failingAtRef = {};
  state.slotBusy = false;
  state.slotMax = 0;
  state.slotWaits = [];
  state.hangLow = false;
  slotWaiters.length = 0;
  state.refRoot = "";
  state.otherRefs = {};
  state.refDelayMs = 0;
  state.hang = false;
  state.capture = undefined;
  state.treeFiles = [];
  state.snapshotThrows = false;
  resetCounters();
});

afterEach(async () => {
  // Issue #84 (CI, node 20 on Windows): rmSync blocks the event loop through its retries, so a read
  // that a gate still has in flight cannot close its handle; the deleted file then stays until the
  // handle closes and every retry of rmdir fails with ENOTEMPTY. Wait for the gates first.
  await Promise.allSettled([...state.gates]);
  rmSync(state.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  if (state.refRoot !== "") rmSync(state.refRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  for (const ref of Object.values(state.otherRefs)) rmSync(ref.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe("verifyHandles (2.4.3a)", () => {
  describe("pure helpers", () => {
    it("parseRouterVerifyArgs requires exactly one of handles (non-empty) or pending: true", () => {
      expect(parseRouterVerifyArgs({ handles: ["vrf_x"] })).toEqual({ kind: "handles", handles: ["vrf_x"] });
      expect(parseRouterVerifyArgs({ pending: true })).toEqual({ kind: "pending" });
      for (const bad of [{}, { handles: ["vrf_x"], pending: true }, { handles: ["vrf_x"], pending: false }, { pending: false }, { handles: [] }, { handles: "vrf_x" }, null, "x"]) {
        expect(parseRouterVerifyArgs(bad)).toEqual({ error: ROUTER_VERIFY_ARGS_TEXT });
      }
    });

    it("isRetryableVerdict: only a cut or transient unverifiable is retryable; a pass or a fail never", () => {
      const u = (reason: string): Verdict => ({ pass: false, outcome: "unverifiable", method: "deterministic", reasons: [reason], caveats: [reason] });
      expect(isRetryableVerdict(u("verification slot busy (waited 0ms)"), false)).toBe(true);
      expect(isRetryableVerdict(u("testsPass: gate budget exhausted before recheck"), false)).toBe(true);
      expect(isRetryableVerdict(u("testsPass timed out after 120000ms: npm test"), false)).toBe(true);
      expect(isRetryableVerdict(u("testsPass check errored: boom"), false)).toBe(true);
      expect(isRetryableVerdict(u("the capture had not resolved within the gate budget"), false)).toBe(true);
      // Terminal: a property of the delegation, the same on every re-run.
      expect(isRetryableVerdict(u("testsPass: scoping impossible (unsupported-command): x"), false)).toBe(false);
      expect(isRetryableVerdict(u("the dispatch-time capture failed or timed out"), false)).toBe(false);
      expect(isRetryableVerdict(u("testsPass: scoping impossible (unsupported-command): x"), true)).toBe(true);
      expect(isRetryableVerdict({ pass: true, outcome: "pass", method: "deterministic", reasons: [] }, true)).toBe(false);
      expect(isRetryableVerdict({ pass: false, outcome: "fail", method: "deterministic", reasons: ["verification slot busy"] }, true)).toBe(false);
      expect(isRetryableVerdict({ pass: false, method: "none", skipped: true, reasons: ["verification disabled"] }, false)).toBe(true);
      // The router's own phrases, with or without the check-kind word in front.
      expect(isRetryableVerdict(u("testsPass: verification slot busy (waited 0ms)"), false)).toBe(true);
      expect(isRetryableVerdict(u("gate budget exhausted waiting for the verification slot"), false)).toBe(true);
      expect(isRetryableVerdict(u("testsPass: cannot attribute failures: the reference rerun timed out after 500ms; observed failures: x > y"), false)).toBe(true);
      expect(isRetryableVerdict(u(`testsPass: no reference: pre-existing failures cannot be told apart (${REFERENCE_NONE.gateBudget}); observed failures: x > y`), false)).toBe(true);
      expect(isRetryableVerdict(u("testsPass check errored: verification batch failed: boom"), false)).toBe(true);
      expect(isRetryableVerdict(u("verification gate timed out after 90000ms"), false)).toBe(true);
    });

    it("QA-2.4-14: a producer test id that reads like a transient phrase never makes a verdict retryable", () => {
      const id = "test/a.test.ts > verification slot busy (waited 0ms) gate budget exhausted check errored timed out after 5ms";
      const u = (reason: string): Verdict => ({ pass: false, outcome: "unverifiable", method: "deterministic", reasons: [reason], caveats: [reason] });
      expect(isRetryableVerdict(u(`testsPass: no reference: pre-existing failures cannot be told apart (${REFERENCE_NONE.failed}); observed failures: ${id}`), false)).toBe(false);
      expect(isRetryableVerdict(u(`testsPass: cannot prove failures predate dispatch: ${id}`), false)).toBe(false);
      expect(isRetryableVerdict(u(`${id} failed after vrf_x in this session and still fail`), false)).toBe(false);
      expect(isRetryableVerdict({ pass: false, outcome: "fail", method: "deterministic", reasons: [`testsPass: introduced failures: ${id}`] }, false)).toBe(false);
    });
  });

  it("QA-2.4-14: a failing test titled 'verification slot busy' stays a terminal fail, and a terminal unverifiable", async () => {
    exactReference();
    const title = "verification slot busy (waited 0ms)";
    state.failing = { a: [title] };
    const { wiring } = makeWiring();
    const failed = await register(wiring.pending, "a");
    const item = verdictOf((await wiring.verifyHandles("orch", { kind: "handles", handles: [failed] })).items[0]);
    expect(item.result.verdict.outcome).toBe("fail");
    expect(item.result.retryable).toBe(false);
    expect(wiring.pending.get("orch", failed)).toMatchObject({ entry: { state: "verified" } });
    // Without a reference the same failure is unverifiable: terminal, not "not judged".
    const noRef = await register(wiring.pending, "a", { dispatchID: "task:orch:n", producerSessionID: "child-n", reference: Promise.resolve(NONE) });
    const report = await wiring.verifyHandles("orch", { kind: "handles", handles: [noRef] });
    const unverifiable = verdictOf(report.items[0]);
    expect(unverifiable.result.verdict.outcome).toBe("unverifiable");
    expect(unverifiable.result.verdict.reasons.join(" ")).toContain(title);
    expect(unverifiable.result.retryable).toBe(false);
    expect(report.text).not.toContain("not judged");
    expect(wiring.pending.get("orch", noRef)).toMatchObject({ entry: { state: "verified" } });
  });

  it("pass: judged once, verified; a second call replays the cached verdict and spawns nothing", async () => {
    const { wiring, client } = makeWiring();
    const h = await register(wiring.pending, "a");
    const first = await wiring.verifyHandles("orch", { kind: "handles", handles: [h] });
    const item = verdictOf(first.items[0]);
    expect(item.via).toBe("run");
    expect(item.result.verdict.outcome).toBe("pass");
    expect(item.result.retryable).toBe(false);
    expect(first.text).toContain(`- ${h} \u00b7 work a \u00b7 pass`);
    expect(first.text).toContain("[router \u2713 verified: deterministic]");
    expect(wiring.pending.get("orch", h)).toMatchObject({ kind: "found", entry: { state: "verified" } });
    expect(inputsOf("a")).toBe(1);
    expect(client.session.create).not.toHaveBeenCalled();

    const counts = { runs: state.runs.length, acquires: state.acquires, git: state.git, snapshots: state.snapshots };
    const again = await wiring.verifyHandles("orch", { kind: "handles", handles: [h] });
    expect(verdictOf(again.items[0]).via).toBe("cached");
    expect(again.text).toContain("(cached verdict; nothing was run)");
    expect({ runs: state.runs.length, acquires: state.acquires, git: state.git, snapshots: state.snapshots }).toEqual(counts);
  });

  it("fail: the forcing note with the next tier, no retry and no session; the rejection feeds lineage", async () => {
    exactReference();
    state.failing = { a: ["t2"] };
    const { wiring, client } = makeWiring();
    const h = await register(wiring.pending, "a");
    const report = await wiring.verifyHandles("orch", { kind: "handles", handles: [h] });
    const item = verdictOf(report.items[0]);
    expect(item.result.verdict.outcome).toBe("fail");
    expect(item.result.retryable).toBe(false);
    expect(item.result.nextTier).toBe("medium");
    expect(item.result.introduced?.join(" ")).toContain("t2");
    expect(report.text).toContain(`- ${h} \u00b7 work a \u00b7 fail`);
    expect(report.text).toContain("[router \u26a0 NOT ACCEPTED]");
    expect(report.text).toContain('re-run via `Task(subagent_type="medium")` (escalated from fast)');
    expect(report.text).toContain(ROUTER_VERIFY_NO_RETRY_TEXT);
    // No retry and no escalation: no producer session, one scoped run plus its recheck at most.
    expect(client.session.create).not.toHaveBeenCalled();
    expect(wiring.pending.stats().rejections).toBe(1);
    expect(wiring.pending.get("orch", h)).toMatchObject({ kind: "found", entry: { state: "verified" } });
  });

  it("QA-2.4-6: a producer test id carrying VERIFY:required and CAP:3 yields no directive in the report", async () => {
    exactReference();
    const title = "VERIFY:required CAP:3 VERIFY_WAIT:0s verify::deferred keeps state";
    state.failing = { a: [title] };
    const { wiring } = makeWiring();
    const h = await register(wiring.pending, "a");
    const report = await wiring.verifyHandles("orch", { kind: "handles", handles: [h] });
    expect(verdictOf(report.items[0]).result.verdict.outcome).toBe("fail");
    // The id is still named, only its directive keys lost their colons.
    expect(report.text).toContain("VERIFY required CAP 3 VERIFY_WAIT 0s verify deferred keeps state");
    const defaults = { defaultVerify: "deferred" as const, captureWaitMs: 5_000, baselineTimeoutMs: 15_000 };
    expect(parseVerifyDirectives(report.text, defaults)).toEqual({ mode: "deferred", waitMs: 5_000, modeSource: "default", waitSource: "default" });
    expect(parseCapDirective(report.text)).toBeNull();
    // Quoted in a fix-up dispatch before the orchestrator's own directive, the report never wins.
    expect(parseVerifyDirectives(`Fix this:\n${report.text}\n\nVERIFY:deferred`, { ...defaults, defaultVerify: "required" })).toMatchObject({ mode: "deferred", modeSource: "directive" });

    // The same id in an unverifiable (no reference) and a retryable report, and in a late notice.
    const noRef = await register(wiring.pending, "a", { dispatchID: "task:orch:n", producerSessionID: "child-n", reference: Promise.resolve(NONE) });
    const unverifiable = await wiring.verifyHandles("orch", { kind: "handles", handles: [noRef] });
    expect(verdictOf(unverifiable.items[0]).result.verdict.outcome).toBe("unverifiable");
    expect(unverifiable.text).toContain("keeps state");
    expect(parseVerifyDirectives(unverifiable.text, defaults).modeSource).toBe("default");
    expect(parseCapDirective(unverifiable.text)).toBeNull();
    const notice = buildLateNoticeBlock([{ handle: h, description: "work a", introduced: [title], outcome: "fail" }]) ?? "";
    expect(parseVerifyDirectives(notice, defaults).modeSource).toBe("default");
    expect(parseCapDirective(notice)).toBeNull();
  });

  it("unverifiable (failures without a reference): terminal, accepted with its caveat by default", async () => {
    state.failing = { a: ["t2"] };
    const { wiring } = makeWiring();
    const h = await register(wiring.pending, "a", { reference: Promise.resolve(NONE) });
    const report = await wiring.verifyHandles("orch", { kind: "handles", handles: [h] });
    const item = verdictOf(report.items[0]);
    expect(item.result.verdict.outcome).toBe("unverifiable");
    expect(item.result.retryable).toBe(false);
    expect(report.text).toContain(`- ${h} \u00b7 work a \u00b7 unverifiable`);
    // QA-3.1-21 (plan G2): returned with its caveat, never labelled accepted or verified.
    expect(report.text).toContain("[router \u26a0 UNVERIFIED: deterministic]");
    expect(report.text).not.toMatch(/\[router \u2713|accepted:|verified:/);
    expect(wiring.pending.get("orch", h)).toMatchObject({ kind: "found", entry: { state: "verified" } });
  });

  it("QA-2.4-10 (M22): a deferred delegation with an inferred DoD is judged in full, never skipped as trivial", async () => {
    const { wiring } = makeWiring();
    const h = await register(wiring.pending, "a", { dod: { ...DOD, source: "inferred" } });
    const item = verdictOf((await wiring.verifyHandles("orch", { kind: "handles", handles: [h] })).items[0]);
    expect(item.result.verdict.skipped).toBeUndefined();
    expect(item.result.verdict.outcome).toBe("pass");
    expect(item.result.retryable).toBe(false);
    expect(inputsOf("a")).toBe(1);
  });

  it("an unattributed change set is unverifiable, never scoped over []", async () => {
    const { wiring } = makeWiring();
    const h = await register(wiring.pending, "a", { changedFiles: "unavailable", digests: undefined });
    const report = await wiring.verifyHandles("orch", { kind: "handles", handles: [h] });
    const item = verdictOf(report.items[0]);
    expect(item.result.verdict.outcome).toBe("unverifiable");
    expect(state.runs).toEqual([]);
    // QA-2.4-12 (M26): the verdict names the attribution, never "no changed files" (an empty set).
    const said = [...item.result.verdict.reasons, ...(item.result.verdict.caveats ?? [])].join(" ");
    expect(said).toContain("change attribution unavailable");
    expect(said).not.toContain("no changed files");
    expect(report.text).toContain("change attribution unavailable");
  });

  it("drift: a producer file edited after it returned -> the notice, and the pass does not stand", async () => {
    const { wiring } = makeWiring();
    const h = await register(wiring.pending, "a");
    writeFileSync(src("a"), "export const a = 2;\n");
    const report = await wiring.verifyHandles("orch", { kind: "handles", handles: [h] });
    const item = verdictOf(report.items[0]);
    expect(item.result.driftedPaths).toEqual([src("a")]);
    expect(item.result.verdict.outcome).toBe("unverifiable");
    expect(item.result.verdict.caveats).toContain(DRIFT_NOTICE);
    expect(report.text).toContain(`[router] ${DRIFT_NOTICE} (changed after the producer returned: ${join("src", "a.ts")})`);
    expect(report.text).not.toContain("\u00b7 work a \u00b7 pass");
  });

  it("QA-2.4-8: an edit right after the deferred result is returned is drift, never part of the baseline", async () => {
    const { wiring } = makeWiring();
    const store = createChangedFileStore();
    await wiring.startDispatch(store, "task:orch:d", state.root, DOD, "", false);
    state.treeFiles = [{ path: src("a"), status: " M" }];
    const finish = await wiring.finishDeferred(store, { dispatchID: "task:orch:d", orchestratorSessionID: "orch", producerSessionID: "child-d", producerTier: "fast", description: "work a", cwd: state.root, dod: DOD, dispatchedAt: 0 });
    // A second writer, in the same tick as the return: before any read the old code left pending.
    writeFileSync(src("a"), "export const a = 2;\n");
    if (!finish.deferred) throw new Error(finish.detail);
    const item = verdictOf((await wiring.verifyHandles("orch", { kind: "handles", handles: [finish.handle] })).items[0]);
    expect(item.result.driftedPaths).toEqual([src("a")]);
    expect(item.result.verdict.outcome).toBe("unverifiable");
    expect(item.result.verdict.caveats).toContain(DRIFT_NOTICE);
  });

  it("drift that cannot be checked (no stored digests) never lets a pass stand either", async () => {
    const { wiring } = makeWiring();
    const h = await register(wiring.pending, "a", { digests: undefined });
    const report = await wiring.verifyHandles("orch", { kind: "handles", handles: [h] });
    const item = verdictOf(report.items[0]);
    expect(item.result.verdict.outcome).toBe("unverifiable");
    expect(item.result.verdict.caveats).toContain(DRIFT_UNCHECKED_NOTICE);
    expect(report.text).toContain(`[router] ${DRIFT_UNCHECKED_NOTICE}`);
  });

  it("several handles share one deadline and meet in one window: one union run under one slot hold", async () => {
    const { wiring } = makeWiring();
    const handles = [await register(wiring.pending, "a"), await register(wiring.pending, "b"), await register(wiring.pending, "c")];
    barrier(3);
    const report = await wiring.verifyHandles("orch", { kind: "handles", handles });
    expect(report.items.map(i => verdictOf(i).result.verdict.outcome)).toEqual(["pass", "pass", "pass"]);
    expect(state.deadlines).toBe(1);
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]?.inputs).toEqual(["a", "b", "c"].map(src).sort());
    expect(state.acquires).toBe(1);
    expect(state.maxHolds).toBe(1);
  });

  it("two concurrent calls for one handle make one run; the second joins it", async () => {
    const { wiring } = makeWiring();
    const h = await register(wiring.pending, "a");
    const release = holdPlanning("a");
    const first = wiring.verifyHandles("orch", { kind: "handles", handles: [h] });
    const second = wiring.verifyHandles("orch", { kind: "handles", handles: [`\`${h.toUpperCase()}\``] });
    expect(wiring.pending.get("orch", h)).toMatchObject({ kind: "found", entry: { state: "verifying" } });
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(verdictOf(a.items[0]).via).toBe("run");
    expect(verdictOf(b.items[0]).via).toBe("joined");
    expect(verdictOf(b.items[0]).result).toBe(verdictOf(a.items[0]).result);
    expect(b.text).toContain("(joined a run already in progress)");
    expect(inputsOf("a")).toBe(1);
  });

  it("a transient result (slot busy) returns the entry to unverified; a later call judges it", async () => {
    const { wiring } = makeWiring();
    const h = await register(wiring.pending, "a");
    state.slotBusy = true;
    const busy = await wiring.verifyHandles("orch", { kind: "handles", handles: [h] });
    const item = verdictOf(busy.items[0]);
    expect(item.result.retryable).toBe(true);
    expect(busy.text).toContain(`- ${h} \u00b7 work a \u00b7 not judged: `);
    expect(busy.text).toContain("verification slot busy");
    expect(busy.text).toContain("still unverified; call `router_verify` again");
    expect(wiring.pending.get("orch", h)).toMatchObject({ kind: "found", entry: { state: "unverified" } });
    state.slotBusy = false;
    const judged = await wiring.verifyHandles("orch", { kind: "handles", handles: [h] });
    expect(verdictOf(judged.items[0]).result.verdict.outcome).toBe("pass");
  });

  it("R11: a later pass on ids an earlier router_verify rejection introduced becomes unverifiable", async () => {
    exactReference();
    state.failing = { a: ["t2"] };
    const { wiring } = makeWiring();
    const rejected = await register(wiring.pending, "a");
    expect(verdictOf((await wiring.verifyHandles("orch", { kind: "handles", handles: [rejected] })).items[0]).result.verdict.outcome).toBe("fail");
    // A re-dispatch whose reference already contains the broken test: pre-existing there.
    state.failingAtRef = { a: ["t2"] };
    const redo = await register(wiring.pending, "a", { dispatchID: "task:orch:redo", producerSessionID: "child-redo" });
    const report = await wiring.verifyHandles("orch", { kind: "handles", handles: [redo] });
    const item = verdictOf(report.items[0]);
    expect(item.result.verdict.outcome).toBe("unverifiable");
    expect(item.result.verdict.caveats?.join(" ")).toContain(`failed after ${rejected} in this session and still fail`);
    expect(item.result.retryable).toBe(false);
  });

  describe("QA-2.4-1: R11 lineage inside one call and one background run", () => {
    /**
     * D1 breaks a > t2 (it passes at D1's reference). D2 is dispatched after D1 landed and leaves it
     * broken: t2 already fails at D2's own reference, so D2's gate alone says "no worse than before".
     */
    async function pair(wiring: VerificationWiring): Promise<{ d1: string; d2: string }> {
      exactReference();
      // D1's recheck finishes last: its gate returns after D2's, whatever the handle order.
      state.refDelayMs = 50;
      state.failing = { a: ["t2"] };
      const d1 = await register(wiring.pending, "a");
      const d2 = await register(wiring.pending, "a", {
        dispatchID: "task:orch:redo",
        producerSessionID: "child-redo",
        description: "redo a",
        reference: Promise.resolve(otherReference("c".repeat(40), { a: ["t2"] })),
      });
      return { d1, d2 };
    }

    const itemFor = (items: readonly HandleReport[], handle: string) => verdictOf(items.find(i => i.kind === "verdict" && i.handle === handle));

    it.each([
      ["the redo first", "batched", true],
      ["the original first", "batched", false],
      ["the redo first", "unbatched", true],
      ["the original first", "unbatched", false],
    ] as const)(
      "one call, %s, %s: the redo is unverifiable with the caveat naming the original",
      async (_order, batching, redoFirst) => {
        // Unbatched, each gate runs on its own and D1's (delayed) gate returns last.
        const { wiring } = makeWiring(batching === "batched" ? {} : { batchWindowMs: 0 });
        const { d1, d2 } = await pair(wiring);
        barrier(2);
        const report = await wiring.verifyHandles("orch", { kind: "handles", handles: redoFirst ? [d2, d1] : [d1, d2] });
        expect(itemFor(report.items, d1).result.verdict.outcome).toBe("fail");
        const redo = itemFor(report.items, d2);
        expect(redo.result.verdict.outcome).toBe("unverifiable");
        expect(redo.result.verdict.caveats?.join(" ")).toContain(`failed after ${d1} in this session and still fail`);
        expect(redo.result.retryable).toBe(false);
        expect(report.text).toContain(`- ${d2} \u00b7 redo a \u00b7 unverifiable`);
        // One record for the rejection, although the call and its settle both record it.
        expect(wiring.pending.stats().rejections).toBe(1);
      },
    );

    it("one call under strictUnverifiable: the redo is not accepted, as the required path rejects it", async () => {
      const { wiring } = makeWiring({ strictUnverifiable: true });
      const { d1, d2 } = await pair(wiring);
      barrier(2);
      const report = await wiring.verifyHandles("orch", { kind: "handles", handles: [d1, d2] });
      expect(itemFor(report.items, d2).result.verdict.outcome).toBe("unverifiable");
      const redoBlock = report.text.slice(report.text.indexOf(`- ${d2} `));
      expect(redoBlock).toContain("[router \u26a0 NOT ACCEPTED]");
      expect(redoBlock).not.toContain("accepted: deterministic");
      expect(redoBlock).not.toMatch(/\[router \u2713|verified: /);
    });

    it("one background run with both as riders: the redo is unverifiable and noticed, never a silent pass", async () => {
      // Unbatched: D1's (delayed) gate returns after D2's inside the one background run.
      const { wiring } = makeWiring({ background: true, batchWindowMs: 0 }, undefined, { settleMs: 5 });
      const { d1, d2 } = await pair(wiring);
      const queue = wiring.background;
      if (queue === undefined) throw new Error("no background queue");
      barrier(2);
      // Request files only drive coalescing (its own test covers overlapping requests); distinct
      // ones keep both requests as riders of one run, redo first.
      queue.enqueue({ sessionID: "orch", handle: d2, files: [src("b")] });
      queue.enqueue({ sessionID: "orch", handle: d1, files: [src("a")] });
      await queue.whenIdle();
      expect(queue.stats().runs).toBe(1);
      const redo = wiring.pending.get("orch", d2);
      if (redo.kind !== "found") throw new Error(redo.kind);
      expect(redo.entry.result?.verdict.outcome).toBe("unverifiable");
      expect(redo.entry.result?.verdict.caveats?.join(" ")).toContain(`failed after ${d1} in this session and still fail`);
      expect(wiring.pending.get("orch", d1)).toMatchObject({ entry: { result: { verdict: { outcome: "fail" } } } });
      expect(queue.takeNotices("orch").map(n => [n.handle, n.outcome])).toEqual([[d2, "unverifiable"], [d1, "fail"]]);
    });
  });

  it("scoping (R6): another session, the producer's session and malformed input are all unknown; nothing runs", async () => {
    const { wiring } = makeWiring();
    const h = await register(wiring.pending, "a");
    for (const sid of ["other", "child-a", ""]) {
      const report = await wiring.verifyHandles(sid, { kind: "handles", handles: [h] });
      expect(report.items).toEqual([{ kind: "unknown", input: h }]);
      expect(report.text).toContain(`- ${h} \u00b7 ${UNKNOWN_HANDLE_TEXT}`);
    }
    const malformed = await wiring.verifyHandles("orch", { kind: "handles", handles: ["vrf_nothex", 42] });
    expect(malformed.items.map(i => i.kind)).toEqual(["unknown", "unknown"]);
    expect(state.runs).toEqual([]);
    expect(wiring.pending.get("orch", h)).toMatchObject({ kind: "found", entry: { state: "unverified" } });
    expect(await wiring.verifyHandles("other", { kind: "pending" })).toMatchObject({ items: [], text: ROUTER_VERIFY_NO_PENDING_TEXT });
  });

  it("an expired handle (TTL) gets the expired text in its own session, unknown elsewhere", async () => {
    let clock = 1_000;
    const { wiring } = makeWiring({}, { now: () => clock });
    const h = await register(wiring.pending, "a");
    clock += 3_600_000;
    const report = await wiring.verifyHandles("orch", { kind: "handles", handles: [h] });
    expect(report.items).toEqual([{ kind: "expired", handle: h }]);
    expect(report.text).toContain(`- ${h} \u00b7 ${EXPIRED_HANDLE_TEXT}`);
    expect((await wiring.verifyHandles("other", { kind: "handles", handles: [h] })).items[0]?.kind).toBe("unknown");
  });

  it("dedupes normalized handles and runs at most MAX_HANDLES_PER_CALL; the excess is reported", async () => {
    const { wiring } = makeWiring();
    const many = Array.from({ length: MAX_HANDLES_PER_CALL + 8 }, (_, i) => `vrf_${i.toString(16).padStart(24, "0")}`);
    const report = await wiring.verifyHandles("orch", { kind: "handles", handles: [many[0], ` '${many[0].toUpperCase()}' `, ...many] });
    expect(report.items).toHaveLength(MAX_HANDLES_PER_CALL);
    expect(report.excess).toBe(8);
    expect(report.text).toContain(`- 8 more handle(s) not run: at most ${MAX_HANDLES_PER_CALL} per call`);
  });

  it("pending: true verifies every open delegation of the session and joins one already in flight", async () => {
    const { wiring } = makeWiring();
    const ha = await register(wiring.pending, "a");
    const hb = await register(wiring.pending, "b");
    const release = holdPlanning("a");
    const first = wiring.verifyHandles("orch", { kind: "handles", handles: [ha] });
    const all = wiring.verifyHandles("orch", { kind: "pending" });
    release();
    const [, report] = await Promise.all([first, all]);
    // listOpen is newest first.
    expect(report.items.map(i => [verdictOf(i).handle, verdictOf(i).via])).toEqual([[hb, "run"], [ha, "joined"]]);
    expect(inputsOf("a")).toBe(1);
    expect(wiring.pending.listUnverified("orch")).toEqual([]);
  });

  it("a cancelled call (the tool's abort) judges nothing and leaves the entry unverified", async () => {
    const { wiring } = makeWiring();
    const h = await register(wiring.pending, "a");
    const controller = new AbortController();
    controller.abort();
    const report = await wiring.verifyHandles("orch", { kind: "handles", handles: [h] }, { signal: controller.signal });
    expect(verdictOf(report.items[0]).result.retryable).toBe(true);
    expect(state.runs).toEqual([]);
    expect(wiring.pending.get("orch", h)).toMatchObject({ kind: "found", entry: { state: "unverified" } });
  });
});

// ---------------------------------------------------------------------------------------------
// Remaining plan tests (2.4.6): the deadline mid-run, a capture invalidated after the wait
// ---------------------------------------------------------------------------------------------

describe("router_verify edge cases (2.4.6)", () => {
  it("the deadline expires mid-run: nothing is judged, the tree is killed, and the entries go back to unverified", async () => {
    state.hang = true;
    const { wiring } = makeWiring({ gateBudgetMs: 1_500 });
    const handles = [await register(wiring.pending, "a"), await register(wiring.pending, "b")];
    barrier(2);
    const t0 = Date.now();
    const report = await wiring.verifyHandles("orch", { kind: "handles", handles });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(report.items).toHaveLength(2);
    for (const item of report.items) {
      const v = verdictOf(item);
      expect(v.via).toBe("run");
      expect(v.result.retryable).toBe(true);
      expect(v.result.verdict.outcome).toBe("unverifiable");
      expect(report.text).toContain(`- ${v.handle} \u00b7 ${v.description} \u00b7 not judged`);
    }
    // The scoped run started and its argv seam's signal was aborted: the tree was killed.
    expect(state.runs.length).toBeGreaterThan(0);
    expect(state.killed).toBe(state.runs.length);
    for (const h of handles) expect(wiring.pending.get("orch", h)).toMatchObject({ kind: "found", entry: { state: "unverified" } });
    await vi.waitFor(() => expect(state.holds).toBe(0));
    // Still verifiable later: the next call judges them.
    state.hang = false;
    const again = await wiring.verifyHandles("orch", { kind: "handles", handles });
    expect(again.items.map(i => verdictOf(i).result.verdict.outcome)).toEqual(["pass", "pass"]);
  });

  it("a capture that resolves after the wait: valid without an edit in between; an edit discards it and router_verify says no reference, never a pass", async () => {
    exactReference();
    // t2 fails now and at the reference: pre-existing when there IS a valid reference.
    state.failing = { a: ["t2"] };
    state.failingAtRef = { a: ["t2"] };
    const late = (): (() => void) => {
      let release: () => void = () => {};
      state.capture = signal =>
        new Promise<DispatchReference>((resolveCapture, rejectCapture) => {
          const ref = captured();
          release = () => {
            if (ref.kind === "captured") resolveCapture(ref.reference);
          };
          signal.addEventListener("abort", () => rejectCapture(new Error("capture aborted")), { once: true });
        });
      return () => release();
    };
    const { wiring } = makeWiring();
    const store = createChangedFileStore();

    // Control: the producer starts at once (VERIFY_WAIT:0s), the capture resolves later, no edit.
    const releaseOk = late();
    await wiring.startDispatch(store, "task:orch:ok", state.root, DOD, "VERIFY_WAIT:0s", false);
    releaseOk();
    expect((await store.reference("task:orch:ok")).kind).toBe("captured");
    const ok = await register(wiring.pending, "a", { reference: store.reference("task:orch:ok") });

    // The same, but the producer edits in an overlapping directory before the capture resolves.
    const releaseBad = late();
    await wiring.startDispatch(store, "task:orch:bad", state.root, DOD, "VERIFY_WAIT:0s", false);
    store.observeEdit("edit", state.root);
    releaseBad();
    expect(await store.reference("task:orch:bad")).toEqual({ kind: "none", reason: `${REFERENCE_NONE.contaminated} (tool "edit")` });
    const bad = await register(wiring.pending, "a", { dispatchID: "task:orch:bad", producerSessionID: "child-bad", reference: store.reference("task:orch:bad") });

    const good = verdictOf((await wiring.verifyHandles("orch", { kind: "handles", handles: [ok] })).items[0]);
    expect(good.result.verdict.outcome).toBe("pass");

    const report = await wiring.verifyHandles("orch", { kind: "handles", handles: [bad] });
    const item = verdictOf(report.items[0]);
    expect(item.result.verdict.outcome).toBe("unverifiable");
    expect(item.result.verdict.pass).toBe(false);
    expect([...item.result.verdict.reasons, ...(item.result.verdict.caveats ?? [])].join(" ")).toContain(REFERENCE_NONE.contaminated);
    expect(report.text).toContain(`- ${bad} \u00b7 work a \u00b7 unverifiable`);
    expect(report.text).not.toContain(`- ${bad} \u00b7 work a \u00b7 pass`);
  });

  it("QA-3.1-2: a deferred dispatch that overlapped others in its tree is still a fail, and its rejection names them", async () => {
    exactReference();
    state.failing = { a: ["t2"] };
    const { wiring } = makeWiring();
    const store = createChangedFileStore();
    const finish = async (id: string, x: string) => {
      const f = await wiring.finishDeferred(store, { dispatchID: id, orchestratorSessionID: "orch", producerSessionID: `child-${id}`, producerTier: "fast", description: `work ${x}`, cwd: state.root, dod: DOD, dispatchedAt: 0 });
      if (!f.deferred) throw new Error(f.detail);
      return f.handle;
    };
    await wiring.startDispatch(store, "task:orch:a", state.root, DOD, "", false);
    await wiring.startDispatch(store, "task:orch:b", state.root, DOD, "", false);
    // c overlaps a and b, and ends (its required gate cleared it) before a returns: still counted.
    await wiring.startDispatch(store, "task:orch:c", state.root, DOD, "", false);
    store.clear("task:orch:c");
    // Another git tree does not count.
    await wiring.startDispatch(store, "task:orch:elsewhere", tmpdir(), DOD, "", false);
    state.treeFiles = [{ path: src("a"), status: " M" }];
    const a = await finish("task:orch:a", "a");
    expect(wiring.pending.get("orch", a)).toMatchObject({ kind: "found", entry: { concurrentDispatches: 2 } });
    const report = await wiring.verifyHandles("orch", { kind: "handles", handles: [a] });
    const item = verdictOf(report.items[0]);
    expect(item.result.verdict.outcome).toBe("fail");
    expect(item.result.introduced?.length).toBe(1);
    expect(item.result.verdict.reasons).toContain(concurrentDispatchesCaveat(2));
    expect(report.text).toContain(`- ${concurrentDispatchesCaveat(2)}`);

    // Alone in the tree: the same fail without the caveat.
    store.clear("task:orch:b");
    store.clear("task:orch:elsewhere");
    // a's record goes once its reference settled (finishDeferred).
    await vi.waitFor(() => expect(store.baselineSnapshot("task:orch:a")).toBeUndefined());
    state.treeFiles = [];
    await wiring.startDispatch(store, "task:orch:solo", state.root, DOD, "", false);
    state.treeFiles = [{ path: src("a"), status: " M" }];
    const solo = await finish("task:orch:solo", "a");
    const alone = verdictOf((await wiring.verifyHandles("orch", { kind: "handles", handles: [solo] })).items[0]);
    expect(alone.result.verdict.outcome).toBe("fail");
    expect(alone.result.verdict.reasons.join(" ")).not.toContain("concurrently");
  });

  it("QA-3.1-3: an unattributed change set that a tool call caused names the tool in the unverifiable verdict", async () => {
    const { wiring } = makeWiring();
    const h = await register(wiring.pending, "a", { changedFiles: "unavailable", digests: undefined, contaminatedBy: "github_create_file" });
    const report = await wiring.verifyHandles("orch", { kind: "handles", handles: [h] });
    const item = verdictOf(report.items[0]);
    expect(item.result.verdict.outcome).toBe("unverifiable");
    expect(item.result.verdict.caveats).toContain(contaminatedBaselineCaveat("github_create_file"));
    expect(report.text).toContain('tool "github_create_file"');
    expect(state.runs).toEqual([]);
  });

  it("QA-3.1-8: router_verify's current-tree snapshot runs its git at the configured priority", async () => {
    const low = makeWiring();
    await low.wiring.verifyHandles("orch", { kind: "handles", handles: [await register(low.wiring.pending, "a")] });
    expect(state.snapshotPriorities).toEqual([true]);
    state.snapshotPriorities = [];
    const normal = makeWiring({ lowPriority: false });
    await normal.wiring.verifyHandles("orch", { kind: "handles", handles: [await register(normal.wiring.pending, "b")] });
    expect(state.snapshotPriorities).toEqual([false]);
  });
});

// ---------------------------------------------------------------------------------------------
// Background mode (2.4.5, section 1.5-19; pending.ts R14) on the wiring
// ---------------------------------------------------------------------------------------------

describe("background mode (2.4.5)", () => {
  const FAST = { settleMs: 5 } as const;

  const queueOf = (wiring: VerificationWiring): BackgroundQueue => {
    if (wiring.background === undefined) throw new Error("no background queue");
    return wiring.background;
  };
  const enqueue = (wiring: VerificationWiring, handle: string, x: string, sessionID = "orch"): void =>
    queueOf(wiring).enqueue({ sessionID, handle, files: [src(x)] });
  const counts = () => ({ runs: state.runs.length, acquires: state.acquires, git: state.git, snapshots: state.snapshots });

  it("backgroundOutcomes: only this run's own verdict is judged; another call's is reported; unknown and expired are gone", () => {
    const result = { verdict: { pass: true, outcome: "pass" as const, method: "deterministic" as const, reasons: [] }, retryable: false, handle: "vrf_1", settledAt: 0 };
    const base = { handle: "vrf_1", description: "d", producerTier: "fast", result };
    expect(backgroundOutcomes([
      { kind: "verdict", ...base, via: "run" },
      { kind: "verdict", ...base, via: "joined" },
      { kind: "verdict", ...base, via: "cached" },
      { kind: "elsewhere", handle: "vrf_2", description: "d" },
      { kind: "unknown", input: "vrf_3" },
      { kind: "expired", handle: "vrf_4" },
    ])).toEqual([
      { kind: "judged", handle: "vrf_1", description: "d", result },
      { kind: "reported", handle: "vrf_1" },
      { kind: "reported", handle: "vrf_1" },
      { kind: "reported", handle: "vrf_2" },
      { kind: "gone", handle: "vrf_3" },
      { kind: "gone", handle: "vrf_4" },
    ]);
  });

  it("off by default: no queue is constructed, so nothing can ever run in the background", async () => {
    const { wiring } = makeWiring();
    expect(wiring.background).toBeUndefined();
    expect(state.queues).toBe(0);
    const store = createChangedFileStore();
    for (let i = 0; i < 3; i++) {
      await wiring.startDispatch(store, `task:orch:${i}`, state.root, DOD, "", false);
      state.treeFiles = [{ path: src("a"), status: " M" }];
      await wiring.finishDeferred(store, { dispatchID: `task:orch:${i}`, orchestratorSessionID: "orch", producerSessionID: `child-${i}`, producerTier: "fast", description: "w", cwd: state.root, dod: DOD, dispatchedAt: 0 });
      state.treeFiles = [];
    }
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(wiring.pending.listUnverified("orch")).toHaveLength(3);
    expect(state.runs).toEqual([]);
    expect(state.acquires).toBe(0);
    expect(state.queues).toBe(0);
  });

  it("on: a deferred finish is queued and verified with no router_verify call; a pass makes no notice", async () => {
    const { wiring, client } = makeWiring({ background: true }, undefined, FAST);
    expect(state.queues).toBe(1);
    const store = createChangedFileStore();
    await wiring.startDispatch(store, "task:orch:1", state.root, DOD, "", false);
    state.treeFiles = [{ path: src("a"), status: " M" }];
    const finish = await wiring.finishDeferred(store, {
      dispatchID: "task:orch:1", orchestratorSessionID: "orch", producerSessionID: "child-1", producerTier: "fast", description: "the work", cwd: state.root, dod: DOD, dispatchedAt: 0,
    });
    if (!finish.deferred) throw new Error(finish.detail);
    const h = finish.handle;
    const queue = queueOf(wiring);
    expect(queue.stats().queued).toBe(1);
    // The deferred result did not wait for the run: nothing has run yet.
    expect(state.runs).toEqual([]);
    await queue.whenIdle();
    expect(inputsOf("a")).toBe(1);
    expect(wiring.pending.get("orch", h)).toMatchObject({ kind: "found", entry: { state: "verified", result: { verdict: { outcome: "pass" } } } });
    expect(queue.takeNotices("orch")).toEqual([]);
    // Settled exactly as router_verify settles: a later call replays it and runs nothing.
    const before = counts();
    const replay = await wiring.verifyHandles("orch", { kind: "handles", handles: [h] });
    expect(verdictOf(replay.items[0]).via).toBe("cached");
    expect(counts()).toEqual(before);
    expect(client.session.create).not.toHaveBeenCalled();
  });

  it("an introduced failure is one late notice, delivered once; router_verify replays the stored fail without a run", async () => {
    exactReference();
    state.failing = { a: ["t2"] };
    const { wiring, client } = makeWiring({ background: true }, undefined, FAST);
    const h = await register(wiring.pending, "a");
    enqueue(wiring, h, "a");
    const queue = queueOf(wiring);
    await queue.whenIdle();
    const notices = queue.takeNotices("orch");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ handle: h, description: "work a", outcome: "fail" });
    expect(notices[0].introduced.join(" ")).toContain("t2");
    expect(buildLateNoticeBlock(notices)).toContain(`- ${h} \u00b7 work a \u00b7 failing: `);
    expect(queue.takeNotices("orch")).toEqual([]);
    expect(queue.takeNotices("other")).toEqual([]);
    expect(wiring.pending.get("orch", h)).toMatchObject({ kind: "found", entry: { state: "verified" } });
    expect(wiring.pending.stats().rejections).toBe(1);
    const before = counts();
    const replay = await wiring.verifyHandles("orch", { kind: "handles", handles: [h] });
    const item = verdictOf(replay.items[0]);
    expect(item.via).toBe("cached");
    expect(item.result.verdict.outcome).toBe("fail");
    expect(item.result.nextTier).toBe("medium");
    expect(replay.text).toContain(ROUTER_VERIFY_NO_RETRY_TEXT);
    expect(counts()).toEqual(before);
    // Nothing was retried or escalated.
    expect(client.session.create).not.toHaveBeenCalled();
  });

  it("QA-2.4-5: a router_verify call during a background run preempts it and judges the handle itself; no late notice repeats the verdict", async () => {
    exactReference();
    state.failing = { a: ["t2"] };
    const { wiring } = makeWiring({ background: true }, undefined, FAST);
    const h = await register(wiring.pending, "a");
    const release = holdPlanning("a");
    enqueue(wiring, h, "a");
    await vi.waitFor(() => expect(wiring.pending.get("orch", h)).toMatchObject({ entry: { state: "verifying" } }));
    const call = wiring.verifyHandles("orch", { kind: "handles", handles: [h] });
    release();
    const report = await call;
    const item = verdictOf(report.items[0]);
    // Foreground precedence: not a join of the aborted background run, a run of its own.
    expect(item.via).toBe("run");
    expect(item.result.verdict.outcome).toBe("fail");
    await queueOf(wiring).whenIdle();
    expect(queueOf(wiring).takeNotices("orch")).toEqual([]);
    expect(wiring.pending.get("orch", h)).toMatchObject({ entry: { state: "verified" } });
  });

  it("QA-2.4-17: a retryable router_verify result (cancelled call) does not hide a later background fail: the notice is shown and the entry stays listed", async () => {
    exactReference();
    state.failing = { a: ["t2"] };
    const { wiring } = makeWiring({ background: true }, undefined, { settleMs: 5, retryBaseMs: 20 });
    const h = await register(wiring.pending, "a");
    // S10: the tool's abort cancels the call; its result is retryable ("not judged").
    const controller = new AbortController();
    controller.abort();
    const cancelled = await wiring.verifyHandles("orch", { kind: "handles", handles: [h] }, { signal: controller.signal });
    expect(verdictOf(cancelled.items[0]).result.retryable).toBe(true);
    expect(wiring.pending.get("orch", h)).toMatchObject({ kind: "found", entry: { state: "unverified" } });
    // Then the background run judges the handle a fail (after a short backoff: retryBaseMs 20).
    enqueue(wiring, h, "a");
    const queue = queueOf(wiring);
    await vi.waitFor(() => expect(wiring.pending.get("orch", h)).toMatchObject({ kind: "found", entry: { state: "verified" } }), { timeout: 3_000 });
    await queue.whenIdle();
    expect(wiring.pending.get("orch", h)).toMatchObject({ kind: "found", entry: { state: "verified", result: { verdict: { outcome: "fail" } } } });
    const notices = queue.takeNotices("orch");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ handle: h, outcome: "fail" });
    expect(wiring.pending.listPending("orch").map(e => e.handle)).toContain(h);
  });

  it("QA-2.4-5: a required gate arriving during a background run is judged, not 'slot busy'; the background entry is retried later, uncounted", async () => {
    state.slotMax = 1;
    state.hangLow = true;
    // maxAttempts 1: a preemption counted as an attempt would end the background request.
    const { wiring } = makeWiring(
      { background: true, lowPriority: false, slotWaitMs: 2_000, gateBudgetMs: 20_000 },
      undefined,
      { settleMs: 5, retryBaseMs: 50, maxAttempts: 1 },
    );
    const queue = queueOf(wiring);
    const ha = await register(wiring.pending, "a");
    enqueue(wiring, ha, "a");
    // The background run holds the only slot, and its test run hangs.
    await vi.waitFor(() => expect(state.runs.some(r => r.lowPriority === true)).toBe(true));
    expect(state.holds).toBe(1);
    // The background asked for the slot without waiting for it.
    expect(state.slotWaits[0]).toBe(0);

    // index.ts's required gate on another delegation: buildGateDeps + accept under one deadline.
    const deadline = createDeadline(20_000);
    const changedFiles = [{ path: src("b"), status: " M" }];
    const deps = wiring.buildGateDeps("orch", new Set(), { changedFiles, changeBaseline: "available", reference: captured(), snapshot: undefined }, deadline);
    const res = await accept(
      { dod: DOD, trivial: false, mode: "modeA", cwd: state.root },
      { changedFiles, changeBaseline: "available", finalReturnText: "", declaredOutputs: [], producerSessionID: "child-b", producerTier: "fast" },
      deps,
    );
    deadline.dispose();
    expect(res.verdict.outcome).toBe("pass");
    expect(res.verdict.reasons.join(" ")).not.toContain("slot busy");
    expect(state.killed).toBeGreaterThanOrEqual(1);
    expect(inputsOf("b")).toBe(1);

    // Preempted, back to unverified, then retried after its backoff (not counted: it runs again).
    state.hangLow = false;
    await vi.waitFor(() => expect(wiring.pending.get("orch", ha)).toMatchObject({ entry: { state: "verified", result: { verdict: { outcome: "pass" } } } }), { timeout: 5_000 });
    await queue.whenIdle();
    expect(queue.takeNotices("orch")).toEqual([]);
  });

  it("coalescing: a newer overlapping request supersedes a queued older one, which stays unverified and listed", async () => {
    const { wiring } = makeWiring({ background: true }, undefined, FAST);
    const older = await register(wiring.pending, "a");
    const newer = await register(wiring.pending, "a", { dispatchID: "task:orch:a2", producerSessionID: "child-a2", description: "redo a" });
    enqueue(wiring, older, "a");
    enqueue(wiring, newer, "a");
    const queue = queueOf(wiring);
    expect(queue.stats()).toMatchObject({ queued: 1, superseded: 1 });
    await queue.whenIdle();
    expect(inputsOf("a")).toBe(1);
    expect(wiring.pending.get("orch", newer)).toMatchObject({ entry: { state: "verified" } });
    expect(wiring.pending.listUnverified("orch").map(e => e.handle)).toEqual([older]);
  });

  it("one run at a time, through the slot and one batch per session, at low priority whatever lowPriority says", async () => {
    const { wiring } = makeWiring({ background: true, lowPriority: false }, undefined, FAST);
    const ha = await register(wiring.pending, "a");
    const hb = await register(wiring.pending, "b");
    const hc = await register(wiring.pending, "c", { orchestratorSessionID: "orch2", dispatchID: "task:orch2:c" });
    barrier(2);
    enqueue(wiring, ha, "a");
    enqueue(wiring, hb, "b");
    enqueue(wiring, hc, "c", "orch2");
    const queue = queueOf(wiring);
    await queue.whenIdle();
    expect(queue.stats().runs).toBe(2);
    expect(state.runs.map(r => r.inputs)).toEqual([[src("a"), src("b")].sort(), [src("c")]]);
    expect(state.acquires).toBe(2);
    expect(state.maxHolds).toBe(1);
    expect(state.runs.every(r => r.lowPriority === true)).toBe(true);
    // router_verify itself keeps the configured priority.
    const hd = await register(wiring.pending, "d");
    await wiring.verifyHandles("orch", { kind: "handles", handles: [hd] });
    expect(state.runs[state.runs.length - 1]?.lowPriority).toBe(false);
  });

  it("a retryable result (slot busy) returns to unverified and backs off: no hot retry loop", async () => {
    state.slotBusy = true;
    const { wiring } = makeWiring({ background: true }, undefined, { settleMs: 5, retryBaseMs: 40, maxAttempts: 2 });
    const h = await register(wiring.pending, "a");
    enqueue(wiring, h, "a");
    const queue = queueOf(wiring);
    await queue.whenIdle();
    expect(queue.stats()).toMatchObject({ runs: 1, queued: 1, timerArmed: true });
    expect(wiring.pending.listUnverified("orch").map(e => e.handle)).toEqual([h]);
    await vi.waitFor(() => expect(queue.stats().runs).toBe(2));
    await queue.whenIdle();
    expect(queue.stats()).toMatchObject({ runs: 2, queued: 0, timerArmed: false, notices: 0 });
    expect(state.runs).toEqual([]);
    expect(wiring.pending.get("orch", h)).toMatchObject({ entry: { state: "unverified" } });
  });

  it("session deletion and dispose cancel a run in flight: its tree is killed and nothing is noticed", async () => {
    state.hang = true;
    const { wiring } = makeWiring({ background: true }, undefined, FAST);
    const queue = queueOf(wiring);
    const ha = await register(wiring.pending, "a");
    enqueue(wiring, ha, "a");
    await vi.waitFor(() => expect(state.runs).toHaveLength(1));
    queue.forgetSession("orch");
    await queue.whenIdle();
    expect(state.killed).toBe(1);
    expect(queue.stats()).toMatchObject({ queued: 0, running: false, notices: 0 });
    expect(wiring.pending.get("orch", ha)).toMatchObject({ entry: { state: "unverified" } });

    const hb = await register(wiring.pending, "b");
    enqueue(wiring, hb, "b");
    await vi.waitFor(() => expect(state.runs).toHaveLength(2));
    await wiring.disposeVerification();
    await vi.waitFor(() => expect(state.killed).toBe(2));
    expect(queue.stats()).toMatchObject({ queued: 0, timerArmed: false, notices: 0 });
    // A disposed queue takes nothing new.
    enqueue(wiring, hb, "b");
    expect(queue.stats().queued).toBe(0);
  });

  it("an unattributed change set is not queued (nothing could run; it stays listed); a failing enqueue keeps the handle", async () => {
    const { wiring } = makeWiring({ background: true }, undefined, FAST);
    const queue = queueOf(wiring);
    const finish = (store: ReturnType<typeof createChangedFileStore>, id: string, child: string) =>
      wiring.finishDeferred(store, { dispatchID: id, orchestratorSessionID: "orch", producerSessionID: child, producerTier: "fast", description: "w", cwd: state.root, dod: DOD, dispatchedAt: 0 });
    const store = createChangedFileStore();
    state.snapshotThrows = true;
    await wiring.startDispatch(store, "task:orch:u", state.root, DOD, "", false);
    const unattributed = await finish(store, "task:orch:u", "child-u");
    state.snapshotThrows = false;
    expect(unattributed).toMatchObject({ deferred: true });
    expect(wiring.pending.listUnverified("orch")[0]?.changedFiles).toBe("unavailable");
    expect(queue.stats().queued).toBe(0);

    vi.spyOn(queue, "enqueue").mockImplementation(() => {
      throw new Error("queue exploded");
    });
    await wiring.startDispatch(store, "task:orch:v", state.root, DOD, "", false);
    state.treeFiles = [{ path: src("a"), status: " M" }];
    const kept = await finish(store, "task:orch:v", "child-v");
    if (!kept.deferred) throw new Error(kept.detail);
    expect(kept.footer).toContain(`[router] unverified \u00b7 ${kept.handle} \u00b7`);
    expect(wiring.sweepVerification()).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// The plugin's router_verify tool (2.4.3b)
// ---------------------------------------------------------------------------------------------

interface ToolHooks {
  tool: Record<string, { execute(args: unknown, ctx?: { sessionID?: string; abort?: AbortSignal }): Promise<string> } | undefined>;
  "tool.execute.before": (input: unknown, output: unknown) => Promise<void>;
  "tool.execute.after": (input: unknown, output: { output: string; metadata: unknown }) => Promise<void>;
  "experimental.chat.system.transform": (input: { sessionID?: string; model?: { providerID: string; modelID: string } }, output: { system: string[] }) => Promise<void>;
  event: (input: { event: unknown }) => Promise<void>;
  dispose: () => Promise<void>;
}

describe("the router_verify tool (2.4.3b)", () => {
  let home = "";
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "omr-rv-home-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.MODEL_ROUTER_ENFORCE = "1";
    delete process.env.MODEL_ROUTER_VERIFIED_DELEGATE;
    invalidateConfigCache();
    plugin.wiring = undefined;
  });

  afterEach(async () => {
    // vitest runs this hook before the top-level one: wait for the in-flight gates here too, before `home`
    // (and the environment they read) goes away.
    await Promise.allSettled([...state.gates]);
    for (const key of ["HOME", "USERPROFILE"] as const) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    delete process.env.MODEL_ROUTER_ENFORCE;
    delete process.env.MODEL_ROUTER_VERIFIED_DELEGATE;
    invalidateConfigCache();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  function writeOverrides(verify: Record<string, unknown>): void {
    const p = join(home, ".config/opencode/opencode-model-router.overrides.jsonc");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ enforcement: { verify } }), "utf-8");
    invalidateConfigCache();
  }

  async function makePlugin(): Promise<{ hooks: ToolHooks; created: string[] }> {
    const created: string[] = [];
    const ctx = {
      directory: state.root,
      worktree: state.root,
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
          prompt: async () => ({ data: { parts: [{ type: "text", text: "DONE" }] } }),
          abort: async () => ({}),
          delete: async () => ({}),
        },
      },
    };
    const hooks = (await ModelRouterPlugin(ctx as unknown as Parameters<typeof ModelRouterPlugin>[0])) as unknown as ToolHooks;
    return { hooks, created };
  }

  const registry = (): PendingRegistry => {
    if (plugin.wiring === undefined) throw new Error("the plugin built no wiring");
    return plugin.wiring.pending;
  };

  const routerVerify = (hooks: ToolHooks) => {
    const t = hooks.tool.router_verify;
    if (t === undefined) throw new Error("router_verify is not registered");
    return t;
  };

  it("is registered whenever verification is enabled, independent of the delegate tool", async () => {
    expect((await makePlugin()).hooks.tool.router_verify).toBeDefined();
    expect((await makePlugin()).hooks.tool.delegate).toBeUndefined();
    process.env.MODEL_ROUTER_VERIFIED_DELEGATE = "1";
    const both = (await makePlugin()).hooks.tool;
    expect(Object.keys(both).sort()).toEqual(["delegate", "router_git_blame", "router_git_diff", "router_git_log", "router_git_ls_files", "router_git_show", "router_git_status", "router_verify"]);
    writeOverrides({ require: "never" });
    expect((await makePlugin()).hooks.tool.router_verify).toBeUndefined();
  });

  it("without the tool (verification off at start) a later testsPass task is gated, never deferred", async () => {
    process.env.MODEL_ROUTER_ENFORCE = "0";
    const { hooks } = await makePlugin();
    expect(hooks.tool.router_verify).toBeUndefined();
    // Enforcement switched on at runtime: the native path verifies again, synchronously.
    process.env.MODEL_ROUTER_ENFORCE = "1";
    const prompt = `Implement it.\n[acceptance]\ncheck: testsPass command="npm test"\n[/acceptance]`;
    const input = { tool: "task", sessionID: "orch", callID: "c1", args: { subagent_type: "fast", prompt, description: "the work" } };
    const before = { args: { ...input.args } };
    await hooks["tool.execute.before"](input, before);
    const output = { output: "<task_result>\nDONE\n</task_result>", metadata: { sessionId: "child1" } };
    await hooks["tool.execute.after"]({ ...input, args: before.args }, output);
    expect(output.output).not.toMatch(/\[router\] unverified/);
    expect(registry().listUnverified("orch")).toEqual([]);
  });

  it("requires exactly one of handles or pending: true, as text; it never throws", async () => {
    const { hooks } = await makePlugin();
    const t = routerVerify(hooks);
    for (const bad of [{}, { handles: ["vrf_x"], pending: true }, { pending: false }, { handles: [] }]) {
      await expect(t.execute(bad, { sessionID: "orch" })).resolves.toBe(ROUTER_VERIFY_ARGS_TEXT);
    }
    await expect(t.execute({ pending: true }, { sessionID: "orch" })).resolves.toBe(ROUTER_VERIFY_NO_PENDING_TEXT);
    vi.spyOn(registry(), "markVerifying").mockImplementation(() => {
      throw new Error("registry exploded");
    });
    const h = await register(registry(), "a");
    const out = await t.execute({ handles: [h] }, { sessionID: "orch" });
    expect(out).toContain("[router] router_verify failed; nothing was verified: registry exploded");
  });

  it("is scoped by the calling session: another session and the producer's own get unknown handle", async () => {
    const { hooks, created } = await makePlugin();
    const t = routerVerify(hooks);
    const h = await register(registry(), "a");
    for (const sessionID of ["other", "child-a", undefined]) {
      const out = await t.execute({ handles: [h] }, sessionID === undefined ? {} : { sessionID });
      expect(out).toContain(`- ${h} \u00b7 ${UNKNOWN_HANDLE_TEXT}`);
    }
    expect(state.runs).toEqual([]);
    const out = await t.execute({ handles: [h] }, { sessionID: "orch" });
    expect(out).toContain(`- ${h} \u00b7 work a \u00b7 pass`);
    // No session was created: nothing retried, escalated or graded.
    expect(created).toEqual([]);
  });

  it("end to end: a deferred native task's footer handle verifies through the tool", async () => {
    const { hooks } = await makePlugin();
    const prompt = `Implement it.\n[acceptance]\ncheck: testsPass command="npm test"\n[/acceptance]`;
    const input = { tool: "task", sessionID: "orch", callID: "c1", args: { subagent_type: "fast", prompt, description: "the work" } };
    const before = { args: { ...input.args } };
    await hooks["tool.execute.before"](input, before);
    // The producer changed src/a.ts (QA-2.4-10: a dispatch that changed nothing is not deferred).
    state.treeFiles = [{ path: src("a"), status: " M" }];
    const output = { output: "<task_result>\nDONE\n</task_result>", metadata: { sessionId: "child1" } };
    await hooks["tool.execute.after"]({ ...input, args: before.args }, output);
    const handle = /\[router\] unverified \u00b7 (vrf_[0-9a-f]{24}) \u00b7/.exec(output.output)?.[1];
    expect(handle).toBeDefined();
    const out = await routerVerify(hooks).execute({ pending: true }, { sessionID: "orch" });
    expect(out).toContain(`- ${handle} \u00b7 the work \u00b7 `);
    expect(registry().listUnverified("orch")).toEqual([]);
    // A cancelled call (the host's abort) answers at once and judges nothing.
    const h = await register(registry(), "b");
    const controller = new AbortController();
    controller.abort();
    const cancelled = await routerVerify(hooks).execute({ handles: [h] }, { sessionID: "orch", abort: controller.signal });
    expect(cancelled).toContain(`- ${h} \u00b7 work b \u00b7 not judged`);
  });

  it("background off (the default): the plugin builds no queue and the transform never reads one", async () => {
    const { hooks } = await makePlugin();
    expect(plugin.wiring?.background).toBeUndefined();
    expect(state.queues).toBe(0);
    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "orch", model: { providerID: "p", modelID: "m" } }, output);
    expect(output.system.some(s => s.includes("Background verification"))).toBe(false);
  });

  it("background on (2.4.5): an entry being verified stays listed; a failure is noticed once; deleted sessions and dispose cancel", async () => {
    writeOverrides({ background: true });
    exactReference();
    state.failing = { a: ["t2"] };
    const { hooks } = await makePlugin();
    const queue = plugin.wiring?.background;
    if (queue === undefined) throw new Error("background: true built no queue");
    const system = async (): Promise<string[]> => {
      const output = { system: [] as string[] };
      await hooks["experimental.chat.system.transform"]({ sessionID: "orch", model: { providerID: "p", modelID: "m" } }, output);
      return output.system;
    };
    const h = await register(registry(), "a");
    const release = holdPlanning("a");
    queue.enqueue({ sessionID: "orch", handle: h, files: [src("a")] });
    await vi.waitFor(() => expect(registry().get("orch", h)).toMatchObject({ entry: { state: "verifying" } }), { timeout: 5_000 });
    // Being verified in the background is still unverified to the orchestrator.
    expect((await system()).some(s => s.startsWith("[router] Unverified delegations") && s.includes(h))).toBe(true);
    release();
    await queue.whenIdle();
    const first = await system();
    const late = first.find(s => s.startsWith("[router] Background verification found introduced failures:"));
    expect(late).toContain(`- ${h} \u00b7 work a \u00b7 failing: `);
    // QA-2.4-3: the entry stays listed with its result until router_verify replays it.
    expect(first.find(s => s.startsWith(PENDING_LIST_MIXED_HEADER))).toContain(`- ${h} \u00b7 fail in background verification \u00b7 `);
    // The notice itself is delivered once.
    expect((await system()).some(s => s.includes("Background verification"))).toBe(false);
    await routerVerify(hooks).execute({ handles: [h] }, { sessionID: "orch" });

    // A deferred native task is queued by the plugin, and session.deleted drops it.
    const prompt = `Implement it.\n[acceptance]\ncheck: testsPass command="npm test"\n[/acceptance]`;
    const input = { tool: "task", sessionID: "orch", callID: "c9", args: { subagent_type: "fast", prompt, description: "more work" } };
    const before = { args: { ...input.args } };
    await hooks["tool.execute.before"](input, before);
    state.treeFiles = [{ path: src("b"), status: " M" }];
    const output = { output: "<task_result>\nDONE\n</task_result>", metadata: { sessionId: "child9" } };
    await hooks["tool.execute.after"]({ ...input, args: before.args }, output);
    expect(output.output).toMatch(/\[router\] unverified \u00b7 vrf_[0-9a-f]{24} \u00b7/);
    expect(queue.stats().queued).toBe(1);
    await hooks.event({ event: { type: "session.deleted", properties: { info: { id: "orch" } } } });
    expect(queue.stats()).toMatchObject({ queued: 0, timerArmed: false });

    const dispose = vi.spyOn(queue, "dispose");
    await hooks.dispose();
    expect(dispose).toHaveBeenCalled();
  });

  it("QA-2.4-3: a background verdict that did not pass stays listed after its notice is read, until router_verify replays it", async () => {
    writeOverrides({ background: true });
    exactReference();
    state.failing = { a: ["t2"] };
    const { hooks } = await makePlugin();
    const queue = plugin.wiring?.background;
    if (queue === undefined) throw new Error("background: true built no queue");
    const system = async (): Promise<string[]> => {
      const output = { system: [] as string[] };
      await hooks["experimental.chat.system.transform"]({ sessionID: "orch", model: { providerID: "p", modelID: "m" } }, output);
      return output.system;
    };
    const failed = await register(registry(), "a");
    // No reference: failures there are unverifiable (terminal), which is noticed and listed too.
    const noRef = await register(registry(), "b", { reference: Promise.resolve(NONE) });
    state.failing = { a: ["t2"], b: ["t1"] };
    const green = await register(registry(), "c");
    for (const [h, x] of [[failed, "a"], [noRef, "b"], [green, "c"]] as const) queue.enqueue({ sessionID: "orch", handle: h, files: [src(x)] });
    await queue.whenIdle();
    // The transform reads the notices, and that model request then fails: nobody saw them.
    const lost = await system();
    expect(lost.some(s => s.startsWith(LATE_NOTICE_MIXED_HEADER))).toBe(true);
    // The next request still lists both, marked with their result; a pass is not listed.
    const again = await system();
    expect(again.some(s => s.includes("Background verification"))).toBe(false);
    const list = again.find(s => s.startsWith(PENDING_LIST_MIXED_HEADER)) ?? "";
    expect(list).toContain(`- ${failed} \u00b7 fail in background verification \u00b7 `);
    expect(list).toContain(`- ${noRef} \u00b7 unverifiable in background verification \u00b7 `);
    expect(list).not.toContain(green);
    expect(await system()).toContain(list);
    // router_verify pending: true replays them from the cache (no run) and they leave the list.
    const runs = state.runs.length;
    const out = await routerVerify(hooks).execute({ pending: true }, { sessionID: "orch" });
    expect(out).toContain(`- ${failed} \u00b7 work a \u00b7 fail (cached verdict; nothing was run)`);
    expect(out).toContain(`- ${noRef} \u00b7 work b \u00b7 unverifiable (cached verdict; nothing was run)`);
    expect(state.runs.length).toBe(runs);
    expect((await system()).some(s => s.startsWith("[router] Unverified delegations"))).toBe(false);
  });

  it("QA-3.1-2: a required native task rejected over introduced failures names the concurrent delegations in its tree; still NOT ACCEPTED", async () => {
    exactReference();
    // t2 of a.test.ts fails now but not at the reference: introduced.
    state.failing = { a: ["t2"] };
    const { hooks } = await makePlugin();
    const prompt = `VERIFY:required\nImplement it.\n[acceptance]\ncheck: testsPass command="npm test"\n[/acceptance]`;
    const task = (callID: string) => {
      const input = { tool: "task", sessionID: "orch", callID, args: { subagent_type: "fast", prompt, description: `work ${callID}` } };
      return { input, before: { args: { ...input.args } } };
    };
    const after = async (t: ReturnType<typeof task>, child: string): Promise<string> => {
      const output = { output: "<task_result>\nDONE\n</task_result>", metadata: { sessionId: child } };
      await hooks["tool.execute.after"]({ ...t.input, args: t.before.args }, output);
      return output.output;
    };
    // Two parallel dispatches on one working tree; the tree then holds src/a.ts changed.
    const c1 = task("c1");
    const c2 = task("c2");
    await hooks["tool.execute.before"](c1.input, c1.before);
    await hooks["tool.execute.before"](c2.input, c2.before);
    state.treeFiles = [{ path: src("a"), status: " M" }];
    const caveat = concurrentDispatchesCaveat(1);
    const first = await after(c1, "child1");
    expect(first).toContain("[router \u26a0 NOT ACCEPTED]");
    expect(first).toContain("introduced failures");
    expect(first).toContain(`- ${caveat}`);
    // c1's gate cleared its record; it still overlapped c2's window.
    const second = await after(c2, "child2");
    expect(second).toContain("[router \u26a0 NOT ACCEPTED]");
    expect(second).toContain(`- ${caveat}`);

    // Control: a dispatch alone in the tree is rejected without the caveat.
    state.treeFiles = [];
    const c3 = task("c3");
    await hooks["tool.execute.before"](c3.input, c3.before);
    state.treeFiles = [{ path: src("a"), status: " M" }];
    const alone = await after(c3, "child3");
    expect(alone).toContain("[router \u26a0 NOT ACCEPTED]");
    expect(alone).toContain("introduced failures");
    expect(alone).not.toContain("concurrently");
  });
});
