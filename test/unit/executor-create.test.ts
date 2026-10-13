import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { V2Executor, V2ExecutorHost } from "../../src/compat/v2-hooks";
import { createExecutor, createExecutorAccess, lateRuntime, PlanSlotPools, prepareExecutor, slotsDirOf } from "../../src/executor/create";
import * as configModule from "../../src/router/config";
import * as gitModule from "../../src/executor/git";
import * as runtimeModule from "../../src/executor/runtime";
import * as launchModule from "../../src/executor/launch";
import * as ledgerModule from "../../src/executor/ledger";
import * as compilerModule from "../../src/executor/compile";
import * as rolesModule from "../../src/router/roles";
import * as poolModule from "../../src/executor/slots/pool";
import * as provisionModule from "../../src/executor/slots/provision";
import * as gitToolsModule from "../../src/router/git-tools";
import * as checksModule from "../../src/executor/integrate/checks";
import * as queueModule from "../../src/executor/integrate/queue";
import * as runToolsModule from "../../src/router/run-tools";
import * as execModule from "../../src/verify/exec";
import type { LedgerWriter, IntegrationQueue, Clock } from "../../src/executor/types";
import type { LeaseRegistry } from "../../src/router/leases";
import { ExecutorError, isLedgerV1, ledgerViolations, type ExecutorRuntime, type TaskLauncher, type SlotPool, type SlotRecord, type LedgerV1 } from "../../src/executor/types";
import { buildDraft, holderOf, taskNode } from "../fixtures/cpx/ledger/builders";
import { removeDirWhenReleased } from "../helpers/remove-dir";

const bundled = JSON.parse(readFileSync(fileURLToPath(new URL("../../tiers.json", import.meta.url)), "utf8")) as Record<string, unknown>;
function executorConfig(overrides: { roles?: boolean; enforce?: boolean; never?: boolean } = {}): configModule.RouterConfig {
  return configModule.validateConfig({ ...bundled,
    activePreset: "fixture", defaultTier: "medium",
    presets: { fixture: {
      fast: { model: "fixture/fast", description: "fixture fast", costRatio: 1 },
      medium: { model: "fixture/medium", description: "fixture medium", costRatio: 2 },
      heavy: { model: "fixture/heavy", description: "fixture heavy", costRatio: 3 },
    } },
    routing: { delegation: overrides.roles === false ? "tiers" : "roles", leases: { mode: overrides.enforce === false ? "off" : "enforce" } },
    enforcement: { verify: { require: overrides.never ? "never" : "always" } },
  });
}

function fakeHost(): V2ExecutorHost {
  const registry: LeaseRegistry = {
    acquireWrite: vi.fn<LeaseRegistry["acquireWrite"]>(() => ({ ok: true, leased: [], reentrant: [], unkeyed: [] })),
    checkRead: vi.fn<LeaseRegistry["checkRead"]>(), checkRun: vi.fn<LeaseRegistry["checkRun"]>(),
    filterSearchResults: vi.fn<LeaseRegistry["filterSearchResults"]>(), planHolderOf: vi.fn(() => null),
    release: vi.fn<LeaseRegistry["release"]>(), releaseTask: vi.fn<LeaseRegistry["releaseTask"]>(),
    sweep: vi.fn<LeaseRegistry["sweep"]>(), snapshot: vi.fn<LeaseRegistry["snapshot"]>(), restore: vi.fn<LeaseRegistry["restore"]>(),
  };
  return {
    hosts: { get: async () => null, context: async () => ({ messages: [] }), activity: async () => "unknown",
      interrupt: async () => {}, synthetic: async () => {}, move: async () => {}, onEvent: () => () => {} },
    routes: null, bindings: { bind() {}, evict() {} },
    bookkeeping: { decisionRow() {}, recordDispatchStart() {}, registerInFlight() {}, unregisterInFlight() {} },
    verifier: { verify: async () => ({ verdict: "pass", findings: "", ref: "proof" }) },
    leases: { registry, notifyReleased: vi.fn() }, durations: null, leaseRegistry: null,
    runner: { bootID: "0".repeat(16), run: async () => ({ sessionID: "child", text: "DONE:" }), dispose: async () => {},
      retainedContext: () => null, onContextCaptured: () => () => {} },
    pinOrchestrator: () => () => {}, onLauncherMetric: vi.fn(), knownAgent: () => true, lifetime: new AbortController().signal,
    // QA-5.1-26: adopts a handed-over executor as the adapter does (starts it; the adapter's W7 dispose owns it).
    onExecutor: vi.fn((built: V2Executor) => { void built.runtime.start().catch(() => {}); return true; }),
  };
}

describe("executor access and late runtime", () => {
  it("reports the unavailable reason, delegates after set, and fails closed after clear", async () => {
    const access = createExecutorAccess(), late = lateRuntime(access);
    expect(access.runtime()).toBeNull();
    expect(access.unavailable()).toBe("the plan executor is not available: not initialized");
    expect(() => late.status(null, "orch")).toThrow(access.unavailable());
    expect(late.planLine("orch")).toBeNull();
    await late.start(); await late.dispose();
    const runtime: ExecutorRuntime = { ...lateRuntime(createExecutorAccess()),
      status: vi.fn(async () => "board"), planLine: () => "plan line", start: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
    access.set(runtime);
    expect(access.runtime()).toBe(runtime);
    expect(await late.status(null, "orch")).toBe("board");
    expect(runtime.status).toHaveBeenCalledWith(null, "orch");
    expect(late.planLine("orch")).toBe("plan line");
    await late.start(); await late.dispose();
    expect(runtime.start).toHaveBeenCalledOnce(); expect(runtime.dispose).toHaveBeenCalledOnce();
    access.clear("not a git repository");
    expect(access.runtime()).toBeNull();
    expect(() => late.status(null, "orch")).toThrow(new ExecutorError("E_PLAN_STATE", access.unavailable()));
    expect(late.planLine("orch")).toBeNull();
  });

  it("every action and feed fails with E_PLAN_STATE while unavailable", () => {
    const access = createExecutorAccess(), runtime = lateRuntime(access);
    access.clear("no plan-task verifier");
    const actions: Array<() => unknown> = [
      () => runtime.compile({ path: "PLAN.md", sessionID: "orch" }), () => runtime.residue("plan", "text", "orch"),
      () => runtime.approve("plan", "orch"), () => runtime.status("plan", "orch"), () => runtime.ready("plan"),
      () => runtime.addTasks("plan", "text", "orch"), () => runtime.answer("plan", "item", "text", "orch"),
      () => runtime.done("plan", "T1", "orch"), () => runtime.pause("plan", "orch"), () => runtime.resume("plan", "orch"),
      () => runtime.abort("plan", "orch"), () => runtime.land("plan", "orch"), () => runtime.adopt("plan", "orch"),
      () => runtime.gc(), () => runtime.exportPlan("plan"), () => runtime.purge("plan", "orch"),
      () => runtime.onRouterToolCall("orch"), () => runtime.onHostEvent({ type: "execution.completed", sessionID: "child", at: "2026-10-13T00:00:00Z" }),
      () => runtime.onRetryHook({ sessionID: "child", stepKey: "s", error: { type: "unknown", status: null, message: "failed" } }),
      () => runtime.onChildEnd("T1", 1, { kind: "completed", childSessionID: "child", text: "DONE:", endedAt: "2026-10-13T00:00:00Z" }),
    ];
    for (const action of actions) {
      expect(action).toThrow(access.unavailable());
      try { action(); } catch (error) { expect(error).toMatchObject({ code: "E_PLAN_STATE" }); }
    }
  });
});

describe("prepareExecutor", () => {
  const roots: string[] = [];
  afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await removeDirWhenReleased(root); });
  it("returns an absence, never a rejection, outside a git repository", async () => {
    const root = realpathSync.native(await mkdtemp(join(tmpdir(), "omr-prepare-"))); roots.push(root);
    expect(await prepareExecutor(root)).toEqual({ ok: false, reason: "not a git repository" });
  });
  it("canonicalizes the toplevel, resolves the common home, and creates nothing", async () => {
    const root = realpathSync.native(await mkdtemp(join(tmpdir(), "omr-prepare-"))); roots.push(root);
    execFileSync("git", ["init", "-q"], { cwd: root, windowsHide: true, stdio: "pipe" });
    const subdir = join(root, "sub"); await mkdir(subdir);
    const result = await prepareExecutor(subdir);
    expect(result).toEqual({ ok: true, toplevel: realpathSync.native(root), home: join(realpathSync.native(join(root, ".git")), "omr-executor") });
    if (!result.ok) throw new Error(result.reason);
    await expect(stat(result.home)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each([new Error("discovery failed"), "discovery failed"])("discovery exceptions are absence results: %s", async failure => {
    vi.spyOn(gitModule, "createGitRunner").mockImplementation(() => { throw failure; });
    expect(await prepareExecutor("D:/missing")).toEqual({ ok: false, reason: "repository discovery failed: discovery failed" });
  }, 15_000);
  it("an empty successful rev-parse answer is still not a repository", async () => {
    vi.spyOn(gitModule, "createGitRunner").mockReturnValue({ run: async () => ({ code: 0, signal: null, stdout: " \n", stderr: "", truncated: false, durationMs: 0 }) });
    expect(await prepareExecutor("D:/missing")).toEqual({ ok: false, reason: "not a git repository" });
  }, 15_000);
});

describe("slotsDirOf", () => {
  it("uses a configured root with a separate directory per plan", () => {
    expect(slotsDirOf("plan-one", "D:\\git\\repo", "D:\\git\\.omr-cpx-slots")).toBe(join("D:\\git\\.omr-cpx-slots", "plan-one"));
    expect(slotsDirOf("plan-two", "D:\\git\\repo", "D:\\git\\.omr-cpx-slots")).not.toBe(slotsDirOf("plan-one", "D:\\git\\repo", "D:\\git\\.omr-cpx-slots"));
  });
  it("uses the existing drive-root default", () => {
    expect(slotsDirOf("plan-one", "D:\\git\\repo")).toBe("D:\\.omr-slots\\plan-one");
  });
});

describe("PlanSlotPools lazy facades", () => {
  const roots: string[] = [], pools: PlanSlotPools[] = [];
  afterEach(async () => {
    for (const pool of pools.splice(0)) await pool.closeAll();
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) await removeDirWhenReleased(root);
  }, 30_000);

  async function rig(open = async () => {}) {
    const home = realpathSync.native(await mkdtemp(join(tmpdir(), "omr-plan-pools-"))); roots.push(home);
    const store = ledgerModule.createLedgerStore({ home });
    for (const id of ["plan-a", "plan-b", "finished", "foreign"]) {
      const draft = buildDraft(0, id);
      if (id === "plan-b") draft.status = "paused";
      if (id === "finished") draft.status = "completed";
      if (id === "foreign") draft.repo.toplevel = "C:/foreign";
      expect(ledgerViolations(draft)).toEqual([]); expect(isLedgerV1(draft)).toBe(true);
      const writer = await store.create(draft, holderOf("root", process.pid, "pool-test")); await writer.close();
    }
    const made = new Map<string, ReturnType<typeof makePool>>();
    function makePool(ledger: Readonly<LedgerV1>) {
      const records: SlotRecord[] = [{ schema: 1, slot: "slot-1", path: `C:/slots/${ledger.planId}/slot-1`, kind: "task", planId: ledger.planId,
        repoKey: ledger.repo.key, state: "leased", owner: `plan:${ledger.planId}:T1`, commit: ledger.repo.baseCommit,
        managers: [], manifests: {}, createdAt: "2026-10-11T00:00:00Z", updatedAt: "2026-10-11T00:00:00Z" }];
      const pool = {
        records, open: vi.fn(open), close: vi.fn(),
        acquire: vi.fn<SlotPool["acquire"]>(async (planId, owner, commit) => ({ slot: "slot-1", path: records[0]!.path, planId, owner, commit })),
        acquireSpecial: vi.fn<SlotPool["acquireSpecial"]>(async (planId, kind) => ({ slot: kind, path: `C:/slots/${planId}/${kind}`, planId, owner: kind, commit: ledger.repo.baseCommit })),
        reset: vi.fn<SlotPool["reset"]>(async () => {}), cleanForChecks: vi.fn<SlotPool["cleanForChecks"]>(async () => {}),
        release: vi.fn<SlotPool["release"]>(async () => {}), get: vi.fn<SlotPool["get"]>(async () => records[0] ?? null),
        list: vi.fn<SlotPool["list"]>(async () => records), gc: vi.fn<SlotPool["gc"]>(async predicate => ({ removed: await predicate(ledger.planId) ? [ledger.planId] : [], reported: [] })),
      };
      made.set(ledger.planId, pool); return pool;
    }
    const factory = vi.fn(makePool), log = vi.fn<runtimeModule.RuntimeDeps["log"]>();
    const pool = new PlanSlotPools({ store, toplevel: "C:/repo", makePool: factory, log }); pools.push(pool);
    return { pool, made, store, factory, log };
  }

  it("memoizes one open across operations; facade routes plan-bearing calls and rejects ambiguous ones", async () => {
    const { pool, made } = await rig();
    expect(pool.of("plan-a")).toBe(pool.of("plan-a"));
    expect(made.size).toBe(0);
    const a = pool.of("plan-a");
    await Promise.all([pool.facade.acquire("plan-a", "plan:plan-a:T1", "c".repeat(40)), a.list(), a.get("slot-1")]);
    expect(made.get("plan-a")?.open).toHaveBeenCalledOnce();
    await pool.facade.acquireSpecial("plan-b", "integration");
    await a.reset("slot-1", "d".repeat(40)); await a.cleanForChecks("slot-1"); await a.release("slot-1");
    expect(made.get("plan-a")?.reset).toHaveBeenCalledWith("slot-1", "d".repeat(40));
    expect(made.get("plan-a")?.cleanForChecks).toHaveBeenCalledWith("slot-1");
    expect(made.get("plan-a")?.release).toHaveBeenCalledWith("slot-1");
    expect(await pool.facade.list("plan-a")).toHaveLength(1);
    expect(await pool.facade.list()).toHaveLength(2);
    expect(await pool.facade.get("slot-1")).toBeNull();
    await expect(pool.facade.reset("slot-1", "c".repeat(40))).rejects.toMatchObject({ code: "E_PLAN_STATE" });
    await expect(pool.facade.cleanForChecks("slot-1")).rejects.toMatchObject({ code: "E_PLAN_STATE" });
    await expect(pool.facade.release("slot-1")).rejects.toMatchObject({ code: "E_PLAN_STATE" });
  }, 15_000);

  it("collects same-repository plans only; closed facades fence slot operations but permit gc-only handles", async () => {
    const { pool, made } = await rig();
    const b = pool.of("plan-b");
    await b.list();
    expect(await pool.facade.gc(async id => id === "plan-b")).toEqual({ removed: ["plan-b"], reported: [] });
    expect(made.has("foreign")).toBe(false);
    expect(made.has("plan-a")).toBe(false);
    expect(made.get("plan-b")?.close).toHaveBeenCalledOnce();
    expect(await b.list()).toEqual([]); expect(await b.get("slot-1")).toBeNull();
    await b.release("slot-1"); expect(made.get("plan-b")?.release).not.toHaveBeenCalled();
    const previous = made.get("plan-b")!;
    expect(await b.gc(async () => true)).toEqual({ removed: ["plan-b"], reported: [] });
    expect(made.get("plan-b")).not.toBe(previous);
    expect(made.get("plan-b")?.close).toHaveBeenCalledOnce();
    await expect(b.acquire("plan-b", "plan:plan-b:T1", "c".repeat(40))).rejects.toMatchObject({ code: "E_PLAN_STATE" });
    expect(made.get("plan-b")?.open).toHaveBeenCalledOnce();
    // QA-5.1-22: the gc-only handle creates no directory.
    expect(made.get("plan-b")?.open).toHaveBeenCalledWith({ create: false });
  }, 15_000);

  it("QA-5.1-22: purge closes the live pool, collects through a gc-only handle and removes the empty plan directory", async () => {
    const { store, factory, made, log } = await rig();
    const removeEmptyDir = vi.fn(async () => true);
    const make = factory.getMockImplementation()!;
    factory.mockImplementation(ledger => Object.assign(make(ledger), { removeEmptyDir }));
    const markers = vi.fn(async () => 0);
    const pool = new PlanSlotPools({ store, toplevel: "C:/repo", makePool: factory, log, markers }); pools.push(pool);
    await pool.of("finished").list();
    const live = made.get("finished")!;
    const order: string[] = [];
    removeEmptyDir.mockImplementation(async () => { order.push("rmdir"); return true; });
    const result = await pool.purge("finished", async id => { order.push(`gc:${id}`); return id === "finished" ? true : null; });
    expect(result).toEqual({ removed: ["finished"], reported: [] });
    expect(live.close).toHaveBeenCalled();
    const handle = made.get("finished")!;
    expect(handle).not.toBe(live);
    expect(handle.open).toHaveBeenCalledExactlyOnceWith({ create: false });
    expect(handle.close).toHaveBeenCalledOnce();
    expect(order).toEqual(["gc:finished", "rmdir"]);
    expect(markers).not.toHaveBeenCalled();
    await expect(pool.of("finished").acquire("finished", "plan:finished:T1", "c".repeat(40))).rejects.toMatchObject({ code: "E_PLAN_STATE" });
  }, 15_000);

  it("QA-5.1-22: purge with an invalid slotsDir skips the gc when the plan has no slot marker and refuses when it has some", async () => {
    const { store, factory, log } = await rig();
    factory.mockImplementation(() => { throw new ExecutorError("E_INVALID_INPUT", "invalid slotsDir C:/repo/slots: overlaps the repository"); });
    let count = 0;
    const markers = vi.fn(async () => count);
    const pool = new PlanSlotPools({ store, toplevel: "C:/repo", makePool: factory, log, markers }); pools.push(pool);
    expect(await pool.purge("finished", async () => true)).toEqual({ removed: [], reported: [] });
    expect(markers).toHaveBeenCalledWith("finished");
    count = 2;
    const refused = pool.purge("finished", async () => true);
    await expect(refused).rejects.toMatchObject({ code: "E_PLAN_STATE" });
    await expect(pool.purge("finished", async () => true)).rejects.toThrow(/still has 2 slot marker\(s\) but its slotsDir is invalid/);
    // Any other failure is not an invalid slotsDir: it propagates.
    factory.mockImplementation(() => { throw new Error("disk gone"); });
    await expect(pool.purge("finished", async () => true)).rejects.toThrow("disk gone");
  }, 15_000);

  it("gc opens only terminal plans or already-open pools and continues after an invalid slotsDir", async () => {
    const { pool, made, store, factory, log } = await rig();
    const invalid = buildDraft(0, "invalid"); invalid.status = "completed"; invalid.config.slotsDir = "C:/repo/slots";
    invalid.integration.worktree = join(invalid.config.slotsDir, "integration");
    const aborted = buildDraft(0, "aborted"); aborted.status = "aborted";
    const awaiting = buildDraft(0, "awaiting"); awaiting.status = "awaiting-approval";
    for (const draft of [invalid, aborted, awaiting]) {
      const writer = await store.create(draft, holderOf("root", process.pid, "pool-test")); await writer.close();
    }
    const list = await store.list();
    vi.spyOn(store, "list").mockResolvedValue([...list.filter(plan => plan.planId === "invalid"), ...list.filter(plan => plan.planId !== "invalid")]);
    const make = factory.getMockImplementation()!;
    factory.mockImplementation(ledger => {
      if (ledger.planId === "invalid") throw new ExecutorError("E_INVALID_INPUT", "invalid slotsDir");
      return make(ledger);
    });
    pool.of("plan-a"); // A facade alone is not an open pool.
    pool.of("awaiting");
    await pool.of("plan-b").list();
    const result = await pool.gc(async () => true);
    expect(result.removed.sort()).toEqual(["aborted", "finished", "plan-b"]);
    expect(result.reported).toEqual([]);
    expect(made.has("plan-a")).toBe(false);
    expect(made.has("awaiting")).toBe(false);
    expect(made.has("foreign")).toBe(false);
    expect(log).toHaveBeenCalledExactlyOnceWith("warn", "slot gc failed", { planId: "invalid", error: "invalid slotsDir" });
  }, 15_000);

  it("recovery marker lookup requires exactly one leased matching owner in an active local plan", async () => {
    const { pool, made } = await rig();
    expect(await pool.markerOf("missing")).toBeNull();
    expect(await pool.markerOf("slot-1")).toBeNull(); // A and B both own this short name.
    expect(await pool.markerOf("C:/slots/plan-a/slot-1")).toEqual({ planId: "plan-a", taskId: "T1" });
    const a = made.get("plan-a")!.records[0]!, b = made.get("plan-b")!.records[0]!;
    b.state = "ready"; b.owner = null;
    expect(await pool.markerOf("slot-1")).toEqual({ planId: "plan-a", taskId: "T1" });
    a.owner = "plan:wrong:T1"; expect(await pool.markerOf("slot-1")).toBeNull();
    a.owner = "not-a-plan-owner"; expect(await pool.markerOf("slot-1")).toBeNull();
    a.owner = null; expect(await pool.markerOf("slot-1")).toBeNull();
    expect(made.has("finished")).toBe(false); expect(made.has("foreign")).toBe(false);
  }, 15_000);

  it("closes a failed open, and closeAll also handles untouched and rejected entries", async () => {
    const { pool, made } = await rig(async () => { throw new Error("open failed"); });
    pool.of("plan-b"); // A lazy facade with no promise yet.
    await expect(pool.of("plan-a").list()).rejects.toThrow("open failed");
    expect(made.get("plan-a")?.close).toHaveBeenCalledOnce();
    await pool.closeAll();
    expect(await pool.of("plan-a").list()).toEqual([]);
    expect(await pool.of("plan-b").list()).toEqual([]);
  }, 15_000);

  it("a close racing an open fences the newly opened pool instead of returning it", async () => {
    let release = () => {};
    const hold = new Promise<void>(resolve => { release = resolve; });
    const { pool, made } = await rig(() => hold);
    const listing = pool.of("plan-a").list();
    const rejected = expect(listing).rejects.toMatchObject({ code: "E_PLAN_STATE" });
    await vi.waitFor(() => expect(made.get("plan-a")?.open).toHaveBeenCalledOnce(), { timeout: 2_000 });
    const closing = pool.closeAll(); release();
    await rejected; await closing;
    expect(made.get("plan-a")?.close).toHaveBeenCalled();
    expect(await pool.of("plan-a").list()).toEqual([]);
  }, 15_000);
});

describe("createExecutor assembly seams", () => {
  const context = { routerHost: "v2" as const, directory: "D:\\git\\repo" };
  const prepared = { ok: true as const, toplevel: "D:\\git\\repo", home: "D:\\git\\repo\\.git\\omr-executor" };
  const built: V2Executor[] = [];
  const writers: LedgerWriter[] = [], roots: string[] = [];
  afterEach(async () => {
    for (const executor of built.splice(0)) { await executor.runtime.dispose(); await executor.launcher.dispose(); }
    for (const writer of writers.splice(0)) await writer.close();
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) await removeDirWhenReleased(root);
  }, 30_000);

  // QA-5.1-20: a copy refused by the claim waits on a process-wide set. Registered after this describe's other hooks, so it
  // runs first: no waiter of one test assembles an executor when the next hook (or test) releases the claim.
  afterEach(() => {
    const waiters: unknown = Reflect.get(globalThis, Symbol.for("omr.executor.claim.waiters.v1"));
    if (waiters instanceof Set) waiters.clear();
  });

  function slotsDouble() {
    return {
      open: vi.fn(async () => {}), close: vi.fn(),
      acquire: vi.fn<SlotPool["acquire"]>(async (planId, owner, commit) => ({ planId, owner, commit, slot: "slot-1", path: "D:/slots/plan-a/slot-1" })),
      acquireSpecial: vi.fn<SlotPool["acquireSpecial"]>(async (planId, kind) => ({ planId, owner: kind, commit: "c".repeat(40), slot: kind, path: `D:/slots/${planId}/${kind}` })),
      reset: vi.fn<SlotPool["reset"]>(async () => {}), cleanForChecks: vi.fn<SlotPool["cleanForChecks"]>(async () => {}),
      release: vi.fn<SlotPool["release"]>(async () => {}), get: vi.fn<SlotPool["get"]>(async () => null),
      list: vi.fn<SlotPool["list"]>(async () => []), gc: vi.fn<SlotPool["gc"]>(async () => ({ removed: [], reported: [] })),
      removeEmptyDir: vi.fn(async () => true),
    };
  }

  function queueDouble() {
    return {
      enqueue: vi.fn<IntegrationQueue["enqueue"]>(),
      resume: vi.fn<IntegrationQueue["resume"]>(async () => ({ completed: [], rolledBack: [], halted: false, entries: [] })),
      checkPhase: vi.fn<IntegrationQueue["checkPhase"]>(async () => {}), land: vi.fn<IntegrationQueue["land"]>(async () => ({ landed: false, inbox: null })),
      abort: vi.fn<IntegrationQueue["abort"]>(async () => {}), queued: vi.fn<IntegrationQueue["queued"]>(() => ["T1"]),
      dispose: vi.fn<IntegrationQueue["dispose"]>(async () => {}),
    };
  }

  function assemble(host = fakeHost(), access = createExecutorAccess()): V2Executor | null | undefined {
    const result = createExecutor(context, { host, prepared, access });
    if (result != null) built.push(result);
    return result;
  }

  function capture(host = fakeHost(), annotate?: compilerModule.CompilerDeps["annotate"]) {
    vi.spyOn(configModule, "loadConfig").mockReturnValue(executorConfig());
    const captured: { runtime?: runtimeModule.RuntimeDeps; compiler?: compilerModule.CompilerDeps;
      inner?: ReturnType<typeof compilerModule.createPlanCompiler> } = {};
    const compile = compilerModule.createPlanCompiler;
    vi.spyOn(compilerModule, "createPlanCompiler").mockImplementation(input => {
      captured.compiler = input; captured.inner = compile(input); return captured.inner;
    });
    vi.spyOn(runtimeModule, "createExecutorRuntime").mockImplementation(deps => {
      captured.runtime = deps;
      return { ...lateRuntime(createExecutorAccess()), settled: async () => {}, manualReady: () => [], isPlanChild: () => false,
        recordMetric() {}, onLeaseReleased() {}, dispose: () => deps.launcher.dispose() };
    });
    const access = createExecutorAccess();
    const executor = createExecutor(context, { host, prepared, access, ...(annotate ? { annotate } : {}) });
    if (executor == null || captured.runtime === undefined || captured.compiler === undefined || captured.inner === undefined) throw new Error(access.unavailable());
    built.push(executor);
    return { executor, host, deps: captured.runtime, compiler: captured.compiler, inner: captured.inner };
  }

  async function queueRig() {
    const timers = new Map<number, () => void>(); let serial = 0;
    const clock: Clock = { now: () => 1000, iso: () => "2026-10-11T00:00:00.000Z", randomHex: bytes => "a".repeat(bytes * 2),
      setTimer: (_ms, callback) => { const id = ++serial; timers.set(id, callback); return { id }; },
      clearTimer: handle => { timers.delete(handle.id); } };
    vi.spyOn(ledgerModule, "createNodeClock").mockReturnValue(clock);
    const raw = vi.fn<ReturnType<typeof gitModule.createGitRunner>["run"]>(async () => ({ code: 0, signal: null, stdout: "c".repeat(40), stderr: "", truncated: false, durationMs: 0 }));
    vi.spyOn(gitModule, "createGitRunner").mockReturnValue({ run: raw });
    vi.spyOn(configModule, "validateSlotsDir").mockReturnValue({ ok: true });
    const pool = slotsDouble(), poolFactory = vi.spyOn(poolModule, "createSlotPool").mockReturnValue(pool);
    const provisioner = vi.spyOn(provisionModule, "createProvisioner").mockReturnValue({
      detect: async () => ({ managers: [], manifests: {}, yarnBerry: false, editable: false, python: null }), provision: async () => {},
    });
    const queue = queueDouble(), captured: { queue?: queueModule.IntegrationQueueDeps; checks?: checksModule.IntegrationChecksDeps } = {};
    vi.spyOn(queueModule, "createIntegrationQueue").mockImplementation(input => { captured.queue = input; return queue; });
    const checks = checksModule.createIntegrationChecks;
    vi.spyOn(checksModule, "createIntegrationChecks").mockImplementation(input => { captured.checks = input; return checks(input); });
    const h = capture();
    const home = realpathSync.native(await mkdtemp(join(tmpdir(), "omr-assembly-queue-"))); roots.push(home);
    const store = ledgerModule.createLedgerStore({ home }), value = buildDraft(0, "plan-a");
    value.repo.toplevel = prepared.toplevel;
    value.config.slotsDir = "D:/slots/plan-a";
    value.integration.worktree = join(value.config.slotsDir, "integration");
    expect(ledgerViolations(value)).toEqual([]);
    const writer = await store.create(value, holderOf("root", process.pid, "queue-test")); writers.push(writer);
    vi.spyOn(h.deps.store, "read").mockResolvedValue(value);
    vi.spyOn(h.deps.store, "exportPlan").mockImplementation(id => store.exportPlan(id));
    const collab = h.deps.collaborators({ writer, leases: runtimeModule.createLeaseService(value.planId, h.deps.leaseRegistry),
      waker: { wake: async () => "sent" }, listener: { onIntegrated() {}, onConflict() {}, onFailed() {}, onReverted() {}, onGate() {}, onInbox() {} } });
    if (captured.queue === undefined || captured.checks === undefined) throw new Error("queue was not assembled");
    return { ...h, value, writer, pool, poolFactory, provisioner, raw, queue, collab, queueDeps: captured.queue, checksDeps: captured.checks, timers,
      fireTimer() { const entry = timers.entries().next().value; if (entry === undefined) throw new Error("no timer"); timers.delete(entry[0]); entry[1](); } };
  }

  it("routes through current roles, clamps requested tiers, and refuses missing ranges/models", () => {
    const h = capture();
    // Resolve roles before injecting missing model tiers: resolveRoles otherwise disables the role itself first.
    const roles = rolesModule.resolveRoles(executorConfig(), "v2"), implementer = roles.get("implementer")!;
    const table = vi.spyOn(rolesModule, "resolveRoles").mockReturnValue(roles);
    // Keep both role resolution and the route's model ladder on the same hermetic preset.
    const tierView = vi.spyOn(configModule, "resolveActiveTiers").mockReturnValue({
      fast: { model: "fixture/fast", description: "fixture fast", costRatio: 1 },
      medium: { model: "fixture/medium", description: "fixture medium", costRatio: 2 },
      heavy: { model: "fixture/heavy", description: "fixture heavy", costRatio: 3 },
    });
    const route = (role: string, tier: LedgerV1["tasks"][string]["route"]["tier"]) => h.deps.routes.route(taskNode("T1", { route: { line: "", role, tier, pin: true } }));
    expect(route("reviewer", "fast")).toMatchObject({ agent: "reviewer", heavy: true });
    expect(route("explorer", "heavy")).toMatchObject({ agent: "explorer", heavy: false });
    expect(route("implementer", null).model.modelID).toBeTruthy();
    expect(() => route("missing", "fast")).toThrow("unknown role");
    const fixtureTiers = configModule.resolveActiveTiers(executorConfig());
    tierView.mockReturnValue({});
    expect(() => route("implementer", "fast")).toThrow("role tier range is unavailable"); tierView.mockReturnValue(fixtureTiers);
    const models = vi.spyOn(configModule, "parseModelRef").mockReturnValue(undefined);
    expect(() => route("implementer", "fast")).toThrow("the task model is unavailable"); models.mockRestore();
    table.mockReturnValue(new Map([["implementer", { ...implementer, enabled: false }]]));
    expect(() => route("implementer", "fast")).toThrow("unknown role");
    table.mockReturnValue(new Map([["implementer", { ...implementer, tierRange: { floor: "missing", ceiling: "heavy" } }]]));
    expect(() => route("implementer", "fast")).toThrow("role tier range is unavailable");
    table.mockReturnValue(new Map([["implementer", { ...implementer, tierRange: { floor: "heavy", ceiling: "fast" } }]]));
    expect(() => route("implementer", "fast")).toThrow("role tier range is unavailable");
  });

  it("routes configured model variants and refuses a requested tier absent from an otherwise available range", () => {
    const h = capture(), tiers = configModule.resolveActiveTiers(executorConfig());
    const view = vi.spyOn(configModule, "resolveActiveTiers").mockReturnValue({ ...tiers, fast: { ...tiers.fast!, variant: "test-variant" } });
    expect(h.deps.routes.route(taskNode("T1")).model.variant).toBe("test-variant");
    view.mockReturnValue({ heavy: tiers.heavy! });
    expect(() => h.deps.routes.route(taskNode("T1", { route: { line: "", role: "reviewer", tier: "fast", pin: true } })))
      .toThrow("role tier range is unavailable");
  }, 15_000);

  it("maps every lease refusal without losing holders and notifies after releaseTask", () => {
    const h = capture(), registry = h.host.leases!.registry;
    const acquire = vi.spyOn(registry, "acquireWrite");
    const owner = { holderID: "plan:A:T1", tree: prepared.toplevel, isChild: true as const, taskRef: "A/T1", scope: "until-integrated" as const };
    const holder = { ...owner, holderID: "other", acquiredAt: 0, lastSeenAt: 0 };
    acquire.mockReturnValue({ ok: false, reason: "held", holders: [holder], path: "a.ts", heldPath: "a.ts", key: "a" });
    expect(h.deps.leaseRegistry.acquireWrite(owner, ["a.ts"])).toEqual({ ok: false, reason: "held", holders: [{ holderID: "other", taskRef: "A/T1" }] });
    acquire.mockReturnValue({ ok: false, reason: "unknown-target", holders: [{ ...holder, taskRef: undefined }], where: "anywhere" });
    expect(h.deps.leaseRegistry.acquireWrite(owner, ["a.ts"])).toEqual({ ok: false, reason: "unknown-target", holders: [{ holderID: "other", taskRef: null }] });
    acquire.mockReturnValue({ ok: false, reason: "cap", held: 3, limit: 3 });
    expect(h.deps.leaseRegistry.acquireWrite(owner, ["a.ts"])).toEqual({ ok: false, reason: "cap", message: "lease registry capacity reached (3/3)" });
    acquire.mockReturnValue({ ok: false, reason: "invalid-holder", message: "bad holder" });
    expect(h.deps.leaseRegistry.acquireWrite(owner, ["a.ts"])).toEqual({ ok: false, reason: "invalid", message: "bad holder" });
    expect(h.deps.leaseRegistry.holderOf("a.ts")).toBeNull();
    vi.spyOn(registry, "planHolderOf").mockReturnValue({ ...holder, taskRef: undefined });
    expect(h.deps.leaseRegistry.holderOf("a.ts")).toEqual({ holderID: "other", taskRef: null });
    h.deps.leaseRegistry.releaseTask("A/T1");
    expect(registry.releaseTask).toHaveBeenCalledWith("A/T1");
    expect(h.host.leases!.notifyReleased).toHaveBeenCalledOnce();
    expect(h.deps.holder("orch")).toMatchObject({ sessionID: "orch", pid: process.pid });
    expect(h.deps.config().slotsDir).toBeNull();
  });

  it("compiler wrapper fixes per-plan slots and rejects foreign repositories, mismatched worktrees and invalid roots", async () => {
    const h = capture(), value = buildDraft(0, "plan-a");
    value.repo.toplevel = prepared.toplevel;
    const expected = slotsDirOf(value.planId, prepared.toplevel);
    value.integration.worktree = join(expected, "integration");
    const result = { draft: value, summary: { tasks: 0, phases: 1, edges: 0, workMs: 0, criticalPathMs: 0, width: 0,
      expectedMakespanMs: 0, manual: [], warnings: [] } };
    expect(isLedgerV1(value)).toBe(true);
    vi.spyOn(h.inner, "compile").mockResolvedValue(result);
    const validate = vi.spyOn(configModule, "validateSlotsDir").mockReturnValue({ ok: true });
    const options = { orchestratorSessionID: "root", config: value.config, now: h.deps.clock.iso() };
    expect((await h.deps.compiler.compile("PLAN.md", options)).draft.config.slotsDir).toBe(expected);
    expect(validate).toHaveBeenCalledWith(expected, prepared.toplevel);
    expect(h.compiler.integrationWorktree(value.planId, value.repo)).toBe(value.integration.worktree);
    value.repo.toplevel = "C:/foreign";
    await expect(h.deps.compiler.compile("PLAN.md", options)).rejects.toThrow("another repository");
    value.repo.toplevel = prepared.toplevel; value.integration.worktree = "C:/wrong/integration";
    await expect(h.deps.compiler.compile("PLAN.md", options)).rejects.toThrow("does not match");
    value.integration.worktree = join(expected, "integration");
    validate.mockReturnValue({ ok: false, reason: "slots point into repo" });
    await expect(h.deps.compiler.compile("PLAN.md", options)).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
    expect(() => h.deps.checkSlotsDir?.(expected, prepared.toplevel)).toThrow("slots point into repo");
  }, 15_000);

  it("compiler git is hardened and bounded; missing exit codes fail closed", async () => {
    const run = vi.fn<ReturnType<typeof gitModule.createGitRunner>["run"]>(async () => ({ code: 0, signal: null, stdout: "output", stderr: "", truncated: false, durationMs: 0 }));
    vi.spyOn(gitModule, "createGitRunner").mockReturnValue({ run });
    const h = capture();
    expect(await h.compiler.git.run(["rev-parse", "HEAD"], prepared.toplevel)).toEqual({ code: 0, stdout: "output" });
    expect(run).toHaveBeenCalledWith([...gitToolsModule.hardeningArgs(), "rev-parse", "HEAD"], { cwd: prepared.toplevel, timeoutMs: 5_000 });
    run.mockResolvedValue({ code: null, signal: "SIGTERM", stdout: "", stderr: "", truncated: false, durationMs: 0 });
    expect(await h.compiler.git.run(["status"], prepared.toplevel)).toEqual({ code: -1, stdout: "" });
  }, 15_000);

  it("default annotation uses rules, while role selection clamps QA and falls back to general", async () => {
    const h = capture();
    const annotated = await h.compiler.annotate([{ id: "step", text: "Implement src/a.ts" }]);
    expect(JSON.stringify(annotated)).toContain("[route");
    expect(JSON.stringify(annotated)).toContain("step");
    expect(h.compiler.roleOf(null, "heavy")).toBe("reviewer");
    expect(h.compiler.roleOf(null, "fast")).toBe("general");
    expect(h.compiler.roleOf({ class: "implement", pin: false, ignored: [] }, "heavy")).toBe("implementer");
    expect(h.compiler.roleOf({ pin: false, ignored: [] }, "heavy")).toBe("reviewer");
    const roles = rolesModule.resolveRoles(executorConfig(), "v2"), general = roles.get("general")!;
    const table = vi.spyOn(rolesModule, "resolveRoles").mockReturnValue(new Map([["general", general]]));
    expect(h.compiler.roleOf(null, "heavy")).toBe("general");
    table.mockReturnValue(new Map([["general", { ...general, enabled: false }]]));
    expect(() => h.compiler.roleOf(null, "fast")).toThrow("no enabled role");
  }, 15_000);

  it("retains a supplied annotation port instead of the rules fallback", async () => {
    const annotate = vi.fn<compilerModule.CompilerDeps["annotate"]>(async () => { throw new Error("provided annotator"); });
    const h = capture(fakeHost(), annotate);
    expect(h.compiler.annotate).toBe(annotate);
    await expect(h.compiler.annotate([])).rejects.toThrow("provided annotator");
    expect(annotate).toHaveBeenCalledExactlyOnceWith([]);
  }, 15_000);

  it("static durations use class priors for role names within that role's tier range", async () => {
    const h = capture(), model = h.compiler.durations;
    expect(model.estimate({ role: "reviewer", class: "search", scope: "single" }).p50).toBe(960_000);
    expect(model.estimate({ role: "explorer", class: "design", scope: "single" }).p50).toBe(480_000);
    expect(model.estimate({ role: "missing", class: "other", scope: "single" }).p50).toBe(480_000);
    expect(model.estimate({ role: "missing", class: "unknown", scope: "single" }).p50).toBe(480_000);
    model.observe({ kind: "dispatch-timing", v: 1, ts: "2026-10-11T00:00:00.000Z", parentSessionID: "root", childSessionID: "child", callID: "call",
      role: "missing", class: "other", scope: "single", tier: "medium", model: "test/model", background: true,
      startedAt: 0, endedAt: 1, durationMs: 1, outcome: "succeeded", capacity: null });
    await model.load();
    expect(model.estimate({ role: "missing", class: "other", scope: "single" }).source).toBe("prior");
  }, 15_000);

  it("static priors handle absent canonical role bounds and assembly tolerates unset enforcement", async () => {
    const roles = rolesModule.resolveRoles(executorConfig(), "v2"), general = roles.get("general")!;
    vi.spyOn(rolesModule, "resolveRoles").mockReturnValue(new Map([["general", { ...general, tierRange: { floor: "mini", ceiling: "ultra" } }]]));
    const h = capture();
    expect(h.compiler.durations.estimate({ role: "general", class: "search", scope: "single" }).p50).toBe(240_000);
    expect(h.compiler.durations.estimate({ role: "general", class: "design", scope: "single" }).p50).toBe(960_000);
    await h.executor.runtime.dispose();
    vi.spyOn(configModule, "loadConfig").mockReturnValue({ ...executorConfig(), enforcement: undefined });
    expect(assemble()).not.toBeNull();
  }, 15_000);

  it.each(["existing", "created", "concurrent", "failed"] as const)("queue resume ensures integration before dequeue: %s branch", async scenario => {
    const h = await queueRig(); let reads = 0;
    h.raw.mockImplementation(async args => {
      const read = args.includes("rev-parse");
      const present = scenario === "existing" || (scenario === "concurrent" && reads > 0);
      if (read) reads++;
      return { code: read ? present ? 0 : 1 : scenario === "created" ? 0 : 1, signal: null,
        stdout: present ? "c".repeat(40) : "", stderr: "", truncated: false, durationMs: 0 };
    });
    if (scenario === "failed") {
      await expect(h.collab.queue.resume()).rejects.toMatchObject({ code: "E_GIT" });
      expect(h.pool.acquireSpecial).not.toHaveBeenCalled(); expect(h.queue.resume).not.toHaveBeenCalled();
    } else {
      await h.collab.queue.resume();
      expect(h.pool.acquireSpecial).toHaveBeenCalledExactlyOnceWith("plan-a", "integration");
      expect(h.pool.acquireSpecial.mock.invocationCallOrder[0]).toBeLessThan(h.queue.resume.mock.invocationCallOrder[0]!);
      if (scenario === "existing") expect(h.raw.mock.calls.some(([args]) => args.includes("update-ref"))).toBe(false);
      else expect(h.raw.mock.calls.some(([args]) => args.includes("update-ref") && args.includes("0".repeat(40)))).toBe(true);
    }
  }, 15_000);

  it("queue facade delegates its actions and history reads only integration-step events", async () => {
    const h = await queueRig();
    h.collab.queue.enqueue(["T1"]); expect(h.queue.enqueue).toHaveBeenCalledWith(["T1"]);
    expect(h.collab.queue.queued()).toEqual(["T1"]);
    await h.collab.queue.checkPhase("p1"); expect(h.queue.checkPhase).toHaveBeenCalledWith("p1");
    await h.collab.queue.land(); await h.collab.queue.abort(); await h.collab.queue.dispose();
    expect(h.queue.land).toHaveBeenCalledOnce(); expect(h.queue.abort).toHaveBeenCalledOnce(); expect(h.queue.dispose).toHaveBeenCalledOnce();
    const snapshot = (await h.deps.store.exportPlan("plan-a")).snapshot;
    const step: queueModule.IntegrationStepEvent = { type: "integration-step", seq: 2, batch: 2, last: true, at: "2026-10-11T00:00:00.000Z",
      edge: "start", entry: { id: "i-2", kind: "tag", phaseId: "p1", taskIds: [], slot: null, baseHead: "c".repeat(40), candidate: "c".repeat(40) },
      step: "tag", result: null, detail: null, failingIds: [], closes: false };
    vi.spyOn(h.deps.store, "exportPlan").mockResolvedValue({ snapshot, events: [step, { type: "metric", seq: 3, batch: 3, last: true,
      at: step.at, metric: { name: "counter", key: "ignored", value: 1, labels: {} } }] });
    expect(await h.queueDeps.history.steps()).toEqual([step]);
    expect(h.checksDeps.ledger()).toBe(h.writer.ledger);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.queueDeps.logger.warn("queue warning");
    expect(warn).toHaveBeenCalledWith("[model-router] executor: queue: queue warning");
  }, 15_000);

  it("run resolver preserves argv/cwd, distinguishes scripts and commands, filters undefined env and reports refusals", async () => {
    const h = await queueRig(), resolver = h.checksDeps.resolver;
    const planRun = vi.spyOn(runToolsModule, "planRun");
    for (const kind of ["script", "command"] as const) {
      planRun.mockReturnValue({ kind, name: "typecheck", executable: process.execPath, argv: ["check.js"], cwd: "D:/slot",
        env: { KEEP: "yes", OMIT: undefined }, timeoutMs: 1000 });
      expect(await resolver.resolve({ script: "typecheck", args: [] }, "D:/slot")).toEqual({ ok: true,
        command: { label: "typecheck", file: process.execPath, args: ["check.js"], cwd: "D:/slot", env: { KEEP: "yes" },
          source: kind === "script" ? "package-script" : "run-command", ref: { script: "typecheck", args: [] } } });
    }
    for (const error of [new Error("not allowlisted"), "not allowlisted"]) {
      planRun.mockImplementation(() => { throw error; });
      expect(await resolver.resolve({ script: "unknown", args: [] }, "D:/slot")).toEqual({ ok: false, reason: "not allowlisted" });
    }
  }, 15_000);

  it("command runner uses overrides or the check cwd and forwards abort/priority/env/timeout", async () => {
    const h = await queueRig(), signal = new AbortController().signal;
    const run = vi.spyOn(execModule, "runArgv").mockResolvedValue({ code: 7, timedOut: true, stdout: "out", stderr: "err" });
    const command: checksModule.ResolvedCommand = { label: "check", file: process.execPath, args: ["check.js"], source: "run-command", ref: null, env: { KEEP: "yes" } };
    for (const cwd of [undefined, "D:/override"]) {
      expect(await h.checksDeps.spawn({ ...command, ...(cwd ? { cwd } : {}) }, { cwd: "D:/check", signal, lowPriority: true }))
        .toEqual({ exitCode: 7, timedOut: true, stdout: "out", stderr: "err", durationMs: 0 });
      expect(run).toHaveBeenLastCalledWith(process.execPath, ["check.js"], { cwd: cwd ?? "D:/check", env: { KEEP: "yes" },
        signal, lowPriority: true, timeoutMs: configModule.resolveRolesRouting(executorConfig(), "v2").run.timeoutMs });
    }
  }, 15_000);

  it("settle waits for the child runner, releases once, logs a failed release, and dispose clears polling timers", async () => {
    const h = await queueRig(), release = vi.fn(async () => {});
    const flights = vi.spyOn(h.deps.launcher, "inFlight").mockReturnValue([{ taskId: "T1", attempt: 1, childSessionID: "child", startedAt: h.deps.clock.iso() }]);
    h.queueDeps.settle("T1", release);
    expect(release).not.toHaveBeenCalled(); expect(h.timers.size).toBe(1);
    h.fireTimer(); expect(release).not.toHaveBeenCalled(); expect(h.timers.size).toBe(1);
    flights.mockReturnValue([]); h.fireTimer();
    await Promise.resolve(); expect(release).toHaveBeenCalledOnce(); expect(h.timers.size).toBe(0);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.queueDeps.settle("T1", async () => { throw new Error("release failed"); });
    await Promise.resolve();
    expect(warn).toHaveBeenCalledWith("[model-router] executor: settled release failed", "Error: release failed");
    flights.mockReturnValue([{ taskId: "T1", attempt: 1, childSessionID: "child", startedAt: h.deps.clock.iso() }]);
    const unrelated = vi.fn(async () => {});
    h.queueDeps.settle("T2", unrelated);
    expect(unrelated).toHaveBeenCalledOnce();
    h.queueDeps.settle("T1", release);
    await h.executor.runtime.dispose();
    expect(h.timers.size).toBe(0); expect(release).toHaveBeenCalledOnce();
  }, 15_000);

  it("lazy pool assembly computes a missing slots directory and supplies a bounded spawner with conservative liveness", async () => {
    const h = await queueRig();
    h.value.status = "awaiting-approval"; h.value.config.slotsDir = null;
    expect(isLedgerV1(h.value)).toBe(true);
    await h.deps.slotsFor!("plan-a").list();
    expect(h.poolFactory.mock.calls[0]?.[0].slotsDir).toBe(slotsDirOf("plan-a", prepared.toplevel));
    const provision = h.provisioner.mock.calls[0]?.[0];
    if (provision === undefined) throw new Error("no provisioner");
    const spawner = provision.spawner, signal = new AbortController().signal;
    const spawn = vi.spyOn(gitToolsModule, "spawnBounded").mockResolvedValue({ code: 7, output: Buffer.from("out"), stderr: Buffer.from("err"), truncated: true });
    expect(await spawner.run(process.execPath, ["check.js"], { cwd: "D:/slot", timeoutMs: 123, signal, maxOutputBytes: 456, env: { KEEP: "yes" } }))
      .toMatchObject({ code: 7, signal: null, stdout: "out", stderr: "err", truncated: true });
    expect(spawn).toHaveBeenCalledWith(process.execPath, ["check.js"], "D:/slot", { env: { KEEP: "yes" }, timeoutMs: 123,
      signal, maxBytes: 456, settleOnFailure: true, killGroupOnSettle: true });
    spawn.mockResolvedValue({ code: null, output: Buffer.alloc(0), stderr: Buffer.alloc(0), truncated: false, failure: "spawn timed out" });
    await expect(spawner.run(process.execPath, [], { cwd: "D:/slot", timeoutMs: 123 })).rejects.toThrow("spawn timed out");
    const kill = vi.spyOn(process, "kill");
    kill.mockImplementationOnce(() => true); expect(spawner.isAlive(123)).toBe(true);
    kill.mockImplementationOnce(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); }); expect(spawner.isAlive(123)).toBe(true);
    kill.mockImplementationOnce(() => { throw Object.assign(new Error("dead"), { code: "ESRCH" }); }); expect(spawner.isAlive(123)).toBe(false);
    const info = vi.spyOn(console, "info").mockImplementation(() => {}), warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    h.deps.log("info", "info"); h.deps.log("warn", "warn", { code: "warning" }); h.deps.log("error", "error");
    h.poolFactory.mock.calls[0]?.[0].logger?.warn("pool warning");
    expect(info).toHaveBeenCalledWith("[model-router] executor: info");
    expect(warn).toHaveBeenCalledWith("[model-router] executor: warn", { code: "warning" });
    expect(warn).toHaveBeenCalledWith("[model-router] executor: pool warning");
    expect(error).toHaveBeenCalledWith("[model-router] executor: error");
  }, 15_000);

  it("late assembly failure disposes the already-built launcher and pools and releases the claim", async () => {
    vi.spyOn(configModule, "loadConfig").mockReturnValue(executorConfig());
    const launch = launchModule.createTaskLauncher, dispose = vi.fn(async () => {});
    vi.spyOn(launchModule, "createTaskLauncher").mockImplementation(input => {
      const inner = launch(input);
      return { ...inner, dispose: async () => { await dispose(); await inner.dispose(); } };
    });
    const close = vi.spyOn(PlanSlotPools.prototype, "closeAll");
    vi.spyOn(runtimeModule, "createExecutorRuntime").mockImplementationOnce(() => { throw new Error("runtime assembly failed"); });
    const access = createExecutorAccess();
    expect(assemble(fakeHost(), access)).toBeNull();
    expect(access.unavailable()).toContain("assembly failed: runtime assembly failed");
    expect(dispose).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
    expect(assemble()).not.toBeNull();
  }, 15_000);

  it.each(["runtime", "pools"] as const)("dispose releases timers and the claim even when %s disposal rejects", async failure => {
    const h = await queueRig();
    vi.spyOn(h.deps.launcher, "inFlight").mockReturnValue([{ taskId: "T1", attempt: 1, childSessionID: "child", startedAt: h.deps.clock.iso() }]);
    h.queueDeps.settle("T1", async () => {});
    if (failure === "runtime") vi.spyOn(h.deps.launcher, "dispose").mockRejectedValueOnce(new Error("runtime dispose failed"));
    else vi.spyOn(PlanSlotPools.prototype, "closeAll").mockRejectedValueOnce(new Error("pools dispose failed"));
    await expect(h.executor.runtime.dispose()).rejects.toThrow(`${failure} dispose failed`);
    // This idempotent wrapper retains its rejection; teardown must not await it a second time.
    built.splice(built.indexOf(h.executor), 1);
    await h.executor.launcher.dispose();
    expect(h.timers.size).toBe(0);
    expect(assemble()).not.toBeNull();
  }, 15_000);

  it("v1 returns undefined before config, filesystem, git or assembly calls", () => {
    const load = vi.spyOn(configModule, "loadConfig").mockImplementation(() => { throw new Error("config called"); });
    const git = vi.spyOn(gitModule, "createGitRunner").mockImplementation(() => { throw new Error("git called"); });
    const fs = vi.spyOn(ledgerModule, "createNodeFileSystem").mockImplementation(() => { throw new Error("fs called"); });
    const native = vi.spyOn(realpathSync, "native").mockImplementation(() => { throw new Error("realpath called"); });
    const access = createExecutorAccess();
    expect(createExecutor({ ...context, routerHost: "v1" }, { host: fakeHost(), prepared, access })).toBeUndefined();
    expect(load).not.toHaveBeenCalled(); expect(git).not.toHaveBeenCalled(); expect(fs).not.toHaveBeenCalled(); expect(native).not.toHaveBeenCalled();
  });

  it.each([
    ["roles delegation", { roles: false }, false, "routing.delegation must be roles at start"],
    ["leases enforce", { enforce: false }, false, "routing.leases.mode must be enforce"],
    ["plan-task verifier", {}, true, "no plan-task verifier"],
    ["required verification", { never: true }, false, "enforcement.verify.require is never"],
  ] as const)("is absent without %s", (_label, overrides, noVerifier, reason) => {
    vi.spyOn(configModule, "loadConfig").mockReturnValue(executorConfig(overrides));
    const runtime = vi.spyOn(runtimeModule, "createExecutorRuntime"), host = fakeHost(), access = createExecutorAccess();
    if (noVerifier) host.verifier = null;
    expect(assemble(host, access)).toBeNull();
    expect(access.unavailable()).toBe(`the plan executor is not available: ${reason}`);
    expect(runtime).not.toHaveBeenCalled();
  });

  it("checks the D7 reasons in order, before taking a process claim", () => {
    const load = vi.spyOn(configModule, "loadConfig").mockReturnValue(executorConfig({ roles: false, enforce: false, never: true }));
    const host = fakeHost(), access = createExecutorAccess(); host.verifier = null;
    expect(assemble(host, access)).toBeNull(); expect(access.unavailable()).toContain("routing.delegation");
    load.mockReturnValue(executorConfig({ enforce: false, never: true }));
    expect(assemble(host, access)).toBeNull(); expect(access.unavailable()).toContain("routing.leases.mode");
    load.mockReturnValue(executorConfig({ never: true }));
    expect(assemble(host, access)).toBeNull(); expect(access.unavailable()).toContain("no plan-task verifier");
    host.verifier = fakeHost().verifier;
    expect(assemble(host, access)).toBeNull(); expect(access.unavailable()).toContain("enforcement.verify.require");
    load.mockReturnValue(executorConfig());
    expect(assemble(host, access)).not.toBeNull();
  });

  it("reports failed preparation without assembling or claiming", () => {
    vi.spyOn(configModule, "loadConfig").mockReturnValue(executorConfig());
    const access = createExecutorAccess();
    expect(createExecutor(context, { host: fakeHost(), prepared: { ok: false, reason: "not a git repository" }, access })).toBeNull();
    expect(access.unavailable()).toContain("not a git repository");
    expect(assemble()).not.toBeNull();
  });

  it("shares the process claim across module copies and releases it for a later copy", async () => {
    const first = capture().executor;
    vi.resetModules();
    const secondModule = await import("../../src/executor/create");
    const secondConfig = await import("../../src/router/config");
    vi.spyOn(secondConfig, "loadConfig").mockReturnValue(executorConfig());
    const secondAccess = secondModule.createExecutorAccess();
    const second = secondModule.createExecutor(context, { host: fakeHost(), prepared, access: secondAccess });
    if (second != null) built.push(second);
    expect(second).toBeNull();
    expect(secondAccess.unavailable()).toBe("the plan executor is not available: another plan executor already owns this process");

    await first.runtime.dispose();
    // QA-5.1-20: the waiting copy (another module copy) took the released claim; its release frees it for a later copy.
    const retried = secondAccess.runtime();
    expect(retried, secondAccess.unavailable()).not.toBeNull();
    await retried?.dispose();
    vi.resetModules();
    const thirdModule = await import("../../src/executor/create");
    const thirdConfig = await import("../../src/router/config");
    vi.spyOn(thirdConfig, "loadConfig").mockReturnValue(executorConfig());
    const thirdAccess = thirdModule.createExecutorAccess();
    const third = thirdModule.createExecutor(context, { host: fakeHost(), prepared, access: thirdAccess });
    if (third != null) built.push(third);
    expect(third, thirdAccess.unavailable()).not.toBeNull();
  }, 15_000);

  it.each([
    ["leases", "the lease registry is not available"],
    ["runner", "the child runner is not available"],
  ] as const)("refuses a missing %s port without claiming the process", (port, reason) => {
    vi.spyOn(configModule, "loadConfig").mockReturnValue(executorConfig());
    const host = fakeHost(), access = createExecutorAccess();
    host[port] = null;
    expect(assemble(host, access)).toBeNull();
    expect(access.unavailable()).toBe(`the plan executor is not available: ${reason}`);
    expect(assemble()).not.toBeNull();
  });

  it.each([new Error("assembly exploded"), "assembly exploded"])("releases the claim after assembly throws %s", (failure) => {
    vi.spyOn(configModule, "loadConfig").mockReturnValue(executorConfig());
    const runner = vi.spyOn(gitModule, "createGitRunner").mockImplementationOnce(() => { throw failure; });
    const access = createExecutorAccess();
    expect(assemble(fakeHost(), access)).toBeNull();
    expect(access.unavailable()).toBe("the plan executor is not available: assembly failed: assembly exploded");
    runner.mockRestore();
    expect(assemble()).not.toBeNull();
  });

  it("uses static per-tier duration priors only when the host has no duration model", async () => {
    vi.spyOn(configModule, "loadConfig").mockReturnValue(executorConfig());
    const original = compilerModule.createPlanCompiler;
    let deps: compilerModule.CompilerDeps | undefined;
    vi.spyOn(compilerModule, "createPlanCompiler").mockImplementation((input) => { deps = input; return original(input); });
    const host = fakeHost();
    expect(assemble(host)).not.toBeNull();
    if (deps === undefined) throw new Error("compiler not assembled");
    const model = deps.durations;
    const estimates = ["fast", "medium", "heavy"].map((role) => model.estimate({ role, class: "other", scope: "single" }));
    expect(estimates.map((estimate) => estimate.p50)).toEqual([240_000, 480_000, 960_000]);
    expect(estimates.every((estimate) => estimate.source === "prior" && estimate.n === 0)).toBe(true);
    await model.load();
    expect(model.estimate({ role: "medium", class: "other", scope: "single" })).toEqual(estimates[1]);
    for (const executor of built.splice(0)) await executor.runtime.dispose();
    host.durations = model;
    expect(assemble(host)).not.toBeNull();
    expect(deps.durations).toBe(model);
  });

  it("refuses a second process claim with its unavailable reason", async () => {
    vi.spyOn(configModule, "loadConfig").mockReturnValue(executorConfig());
    const firstAccess = createExecutorAccess(), first = assemble(fakeHost(), firstAccess);
    if (first == null) throw new Error(firstAccess.unavailable());
    const secondAccess = createExecutorAccess();
    expect(assemble(fakeHost(), secondAccess)).toBeNull();
    expect(secondAccess.unavailable()).toBe("the plan executor is not available: another plan executor already owns this process");
    expect(secondAccess.runtime()).toBeNull(); // still held: the refused copy keeps waiting
    await first.runtime.dispose();
    // QA-5.1-20: the release handed the claim to the waiting copy; a third copy is refused while it holds it.
    const retried = secondAccess.runtime();
    expect(retried, secondAccess.unavailable()).not.toBeNull();
    const thirdAccess = createExecutorAccess();
    expect(assemble(fakeHost(), thirdAccess)).toBeNull();
    expect(thirdAccess.unavailable()).toBe("the plan executor is not available: another plan executor already owns this process");
    // Once the third copy stops waiting, the retried runtime's release leaves the claim free for a fresh assembly.
    const waiters: unknown = Reflect.get(globalThis, Symbol.for("omr.executor.claim.waiters.v1"));
    if (waiters instanceof Set) waiters.clear();
    await retried?.dispose();
    expect(assemble()).not.toBeNull();
  });

  it("hands a claim winner to its adapter; one the adapter refuses is disposed and frees the claim (QA-5.1-26)", async () => {
    vi.spyOn(configModule, "loadConfig").mockReturnValue(executorConfig());
    const firstAccess = createExecutorAccess(), first = assemble(fakeHost(), firstAccess);
    if (first == null) throw new Error(firstAccess.unavailable());
    // The waiter's adapter began to dispose before the claim came free: it refuses the handover.
    const host = fakeHost(), secondAccess = createExecutorAccess();
    const onExecutor = vi.fn((_built: V2Executor) => false);
    host.onExecutor = onExecutor;
    expect(assemble(host, secondAccess)).toBeNull();
    await first.runtime.dispose();
    expect(onExecutor).toHaveBeenCalledOnce();
    const handed = onExecutor.mock.calls[0]?.[0];
    if (handed === undefined) throw new Error("no executor was handed over");
    await handed.runtime.dispose(); // memoised: the safety dispose already under way
    expect(secondAccess.runtime()).toBeNull();
    expect(secondAccess.unavailable()).toBe("the plan executor is not available: disposed");
    // The safety dispose released the claim: a fresh copy assembles.
    expect(assemble()).not.toBeNull();
  });

  it("clears access, disposes runtime and pools, then releases the claim; launcher disposal is idempotent", async () => {
    vi.spyOn(configModule, "loadConfig").mockReturnValue(executorConfig());
    const access = createExecutorAccess(), order: string[] = [];
    const clear = access.clear;
    access.clear = (reason) => { order.push("clear"); clear(reason); };
    const start = vi.fn(async () => {}), disposeLauncher = vi.fn(async () => { order.push("launcher"); });
    vi.spyOn(launchModule, "createTaskLauncher").mockImplementation(() => ({
      gate: () => ({ ok: false, reason: "disposed", wake: null }), launch: () => { throw new Error("unused"); },
      cancel: async () => {}, inFlight: () => [], dispose: disposeLauncher,
    } satisfies TaskLauncher));
    // QA-5.1-20: a probe copy refused by the claim would wait for it and take it at the release. The probes stand for copies
    // that have already ended (their lifetime is aborted), so they never wait; the claim stays free for the last assembly.
    const probe = (): V2Executor | null | undefined =>
      createExecutor(context, { host: { ...fakeHost(), lifetime: AbortSignal.abort() }, prepared, access: createExecutorAccess() });
    vi.spyOn(runtimeModule, "createExecutorRuntime").mockImplementation((deps) => ({
      ...lateRuntime(createExecutorAccess()), start, settled: async () => {}, manualReady: () => [], isPlanChild: () => false,
      recordMetric() {}, onLeaseReleased() {}, async dispose() {
        order.push("runtime"); expect(access.runtime()).toBeNull();
        expect(probe()).toBeNull();
        await deps.launcher.dispose();
      },
    }));
    vi.spyOn(PlanSlotPools.prototype, "closeAll").mockImplementation(async () => {
      order.push("pools");
      expect(probe()).toBeNull();
    });
    const first = assemble(fakeHost(), access);
    if (first == null) throw new Error(access.unavailable());
    expect(access.runtime()).toBe(first.runtime); expect(start).not.toHaveBeenCalled();
    const disposing = first.runtime.dispose();
    expect(first.runtime.dispose()).toBe(disposing);
    await disposing;
    await first.launcher.dispose(); await first.launcher.dispose();
    expect(order).toEqual(["clear", "runtime", "launcher", "pools"]);
    expect(disposeLauncher).toHaveBeenCalledOnce();
    expect(assemble()).not.toBeNull();
  });
});
