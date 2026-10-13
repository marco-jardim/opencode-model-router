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
import type { LeaseRegistry } from "../../src/router/leases";
import { ExecutorError, type ExecutorRuntime, type TaskLauncher } from "../../src/executor/types";
import { removeDirWhenReleased } from "../helpers/remove-dir";

const bundled = JSON.parse(readFileSync(fileURLToPath(new URL("../../tiers.json", import.meta.url)), "utf8")) as Record<string, unknown>;
function executorConfig(overrides: { roles?: boolean; enforce?: boolean; never?: boolean } = {}): configModule.RouterConfig {
  return configModule.validateConfig({ ...bundled,
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
  afterEach(async () => { for (const root of roots.splice(0)) await removeDirWhenReleased(root); });
  it("returns an absence, never a rejection, outside a git repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "omr-prepare-")); roots.push(root);
    expect(await prepareExecutor(root)).toEqual({ ok: false, reason: "not a git repository" });
  });
  it("canonicalizes the toplevel, resolves the common home, and creates nothing", async () => {
    const root = await mkdtemp(join(tmpdir(), "omr-prepare-")); roots.push(root);
    execFileSync("git", ["init", "-q"], { cwd: root, windowsHide: true, stdio: "pipe" });
    const subdir = join(root, "sub"); await mkdir(subdir);
    const result = await prepareExecutor(subdir);
    expect(result).toEqual({ ok: true, toplevel: realpathSync.native(root), home: join(realpathSync.native(join(root, ".git")), "omr-executor") });
    if (!result.ok) throw new Error(result.reason);
    await expect(stat(result.home)).rejects.toMatchObject({ code: "ENOENT" });
  });
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

describe("createExecutor assembly seams", () => {
  const context = { routerHost: "v2" as const, directory: "D:\\git\\repo" };
  const prepared = { ok: true as const, toplevel: "D:\\git\\repo", home: "D:\\git\\repo\\.git\\omr-executor" };
  const built: V2Executor[] = [];
  afterEach(async () => {
    for (const executor of built.splice(0)) { await executor.runtime.dispose(); await executor.launcher.dispose(); }
    vi.restoreAllMocks();
  });

  function assemble(host = fakeHost(), access = createExecutorAccess()): V2Executor | null | undefined {
    const result = createExecutor(context, { host, prepared, access });
    if (result != null) built.push(result);
    return result;
  }

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
    await first.runtime.dispose();
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
    vi.spyOn(runtimeModule, "createExecutorRuntime").mockImplementation((deps) => ({
      ...lateRuntime(createExecutorAccess()), start, settled: async () => {}, manualReady: () => [], isPlanChild: () => false,
      recordMetric() {}, onLeaseReleased() {}, async dispose() {
        order.push("runtime"); expect(access.runtime()).toBeNull();
        expect(createExecutor(context, { host: fakeHost(), prepared, access: createExecutorAccess() })).toBeNull();
        await deps.launcher.dispose();
      },
    }));
    vi.spyOn(PlanSlotPools.prototype, "closeAll").mockImplementation(async () => {
      order.push("pools");
      expect(createExecutor(context, { host: fakeHost(), prepared, access: createExecutorAccess() })).toBeNull();
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
