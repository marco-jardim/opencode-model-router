import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "@opencode/plugin/promise/plugin";
import { registerV2Hooks, type V2Executor, type V2ExecutorHost } from "../../src/compat/v2-hooks";
import { createV2Runtime } from "../../src/compat/v2-client";
import ModelRouterPlugin from "../../src/index";
import { createExecutor, createExecutorAccess, prepareExecutor } from "../../src/executor/create";
import { renderRouteLine } from "../../src/executor/expand";
import * as ledgerModule from "../../src/executor/ledger";
import * as provisionModule from "../../src/executor/slots/provision";
import * as poolModule from "../../src/executor/slots/pool";
import * as execModule from "../../src/verify/exec";
import { executorDefaults, isLedgerV1, ledgerViolations, type ChildRunner, type ChildRunRequest, type Clock, type HostSessionEvent, type LedgerV1, type MetricPayload, type RetainedContextInfo, type TaskNode } from "../../src/executor/types";
import * as runtimeModule from "../../src/executor/runtime";
import * as recoveryModule from "../../src/executor/recovery";
import * as turnStateModule from "../../src/compat/turn-state";
import * as backgroundModule from "../../src/compat/background";
import { planDir } from "../../src/executor/paths";
import { invalidateConfigCache, validateConfig } from "../../src/router/config";
import * as configModule from "../../src/router/config";
import { resolveRoleTable } from "../../src/router/roles";
import { buildDraft, holderOf, openAttempt, taskNode } from "../fixtures/cpx/ledger/builders";
import { removeDirWhenReleased } from "../helpers/remove-dir";
import type { RouterPlanArgs } from "../../src/executor/tool";

// Every assembled instance must release the process-wide executor claim.
const executors: V2Executor[] = [];
const plugins: Array<() => Promise<void>> = [];
const roots: string[] = [];
const assembledDeps: runtimeModule.RuntimeDeps[] = [];
const realRuntime = runtimeModule.createExecutorRuntime;
const realRegistry = turnStateModule.createTurnStateRegistry;
const registries: Array<{ registry: turnStateModule.TurnStateRegistry; providers: turnStateModule.TurnStateProvider[] }> = [];
const planInputs = new Map<string, runtimeModule.CollaboratorInput>();
const collaborators = new Map<string, runtimeModule.PlanCollaborators>();
const collections = new Map<string, Array<{ live: number; open: number; untagged: number }>>();
const realPool = poolModule.createSlotPool;
afterEach(async () => {
  for (const dispose of plugins.splice(0).reverse()) await dispose();
  for (const executor of executors.splice(0).reverse()) {
    await executor.runtime.dispose();
    await executor.launcher.dispose();
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  assembledDeps.length = 0;
  registries.length = 0;
  planInputs.clear(); collections.clear(); collaborators.clear();
  invalidateConfigCache();
  for (const root of roots.splice(0)) await removeDirWhenReleased(root);
}, 30_000);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=", "-c", "commit.gpgSign=false", ...args],
    { cwd, windowsHide: true, encoding: "utf8", timeout: 5_000, stdio: "pipe" }).trim();
}

async function repository(init = true) {
  // os.tmpdir() may contain an 8.3 user-profile alias on Windows. Derive every fixture path from the native long path.
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), "omr-v2-assembly-")));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(repo);
  if (init) {
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.name", "Executor Test");
    git(repo, "config", "user.email", "executor@example.invalid");
    await writeFile(join(repo, "README.md"), "assembly fixture\n");
    await writeFile(join(repo, "package.json"), JSON.stringify({ scripts: { typecheck: "node -e process.exit(0)" } }));
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "fixture");
  }
  return { root, repo: realpathSync.native(repo), slotsRoot: join(root, "slots"), base: init ? git(repo, "rev-parse", "HEAD") : "" };
}

/** Real unref'd clock, with every owned timer observable at the dispose boundary. */
function trackedClock() {
  const real = ledgerModule.createNodeClock();
  const pending = new Set<number>();
  const clock: Clock = { ...real,
    setTimer(ms, callback) {
      const handle = real.setTimer(ms, () => { pending.delete(handle.id); callback(); });
      pending.add(handle.id);
      return handle;
    },
    clearTimer(handle) { pending.delete(handle.id); real.clearTimer(handle); },
  };
  return { clock, pending };
}

type Surface = {
  tool: Record<string, { execute(args: RouterPlanArgs, context: { sessionID: string; directory: string }): Promise<string> }>;
  config(output: { command: Record<string, unknown>; agent: Record<string, unknown> }): Promise<void>;
  "command.execute.before"(input: { command: string; arguments: string; sessionID: string }, output: { parts: { type: string; text: string }[] }): Promise<void>;
};

async function configure(root: string, slotsRoot: string, delegation = "roles", leases = "enforce") {
  for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME"]) vi.stubEnv(key, root);
  vi.stubEnv("MODEL_ROUTER_ENFORCE", "1");
  const bundled = JSON.parse(await readFile(new URL("../../tiers.json", import.meta.url), "utf8")) as Record<string, unknown>;
  const config = validateConfig({ ...bundled, activePreset: "fixture", defaultTier: "medium", presets: { fixture: {
    fast: { model: "fixture/fast", description: "fixture fast", costRatio: 1 },
    medium: { model: "fixture/medium", description: "fixture medium", costRatio: 2 },
    heavy: { model: "fixture/heavy", description: "fixture heavy", costRatio: 3 },
  } }, routing: { delegation, leases: { mode: leases },
    executor: { slotsDir: slotsRoot, land: "manual", phaseSuite: "off", batchMax: 1, wakeDebounceMs: 1000 } },
    enforcement: { verify: { require: "always" } } });
  vi.spyOn(configModule, "loadConfig").mockReturnValue(config);
  if (delegation === "roles") {
    const table = resolveRoleTable(config, "v2");
    expect(table.roles.has("implementer"), JSON.stringify(table.issues)).toBe(true);
  }
  const tracked = trackedClock();
  vi.spyOn(ledgerModule, "createNodeClock").mockReturnValue(tracked.clock);
  vi.spyOn(provisionModule, "createProvisioner").mockReturnValue({
    detect: async () => ({ managers: [], manifests: {}, yarnBerry: false, editable: false, python: null }),
    provision: async () => {},
  });
  vi.spyOn(runtimeModule, "createExecutorRuntime").mockImplementation(deps => {
    assembledDeps.push(deps);
    return realRuntime({ ...deps, collaborators: input => {
      planInputs.set(input.writer.planId, input);
      const collab = deps.collaborators(input);
      collaborators.set(input.writer.planId, collab);
      return collab;
    } });
  });
  vi.spyOn(poolModule, "createSlotPool").mockImplementation(deps => {
    const pool = realPool(deps), gc = pool.gc;
    pool.gc = async predicate => {
      const input = planInputs.get(deps.planId), runtime = assembledDeps[assembledDeps.length - 1];
      const calls = collections.get(deps.planId) ?? [];
      calls.push({ live: runtime?.launcher.inFlight().length ?? 0, open: input?.writer.openIntegration().length ?? 0,
        untagged: input?.writer.ledger.phases.filter(phase => phase.gate === "passed" && phase.tag === null).length ?? 0 });
      collections.set(deps.planId, calls);
      return gc(predicate);
    };
    return pool;
  });
  vi.spyOn(execModule, "runArgv").mockResolvedValue({ code: 0, timedOut: false, stdout: "", stderr: "" });
  vi.spyOn(turnStateModule, "createTurnStateRegistry").mockImplementation(deps => {
    const registry = realRegistry(deps), providers: turnStateModule.TurnStateProvider[] = [];
    const register = registry.registerTurnStateProvider;
    registry.registerTurnStateProvider = provider => { providers.push(provider); return register(provider); };
    registries.push({ registry, providers });
    return registry;
  });
  return tracked;
}

async function boot(repo: string, runner?: ChildRunner) {
  const access = createExecutorAccess();
  const prepared = await prepareExecutor(repo);
  const sessionHooks: Record<string, (event: never) => Promise<void>> = {};
  const reg = async () => ({ dispose: async () => {} });
  const editors = { agent: { update() {} }, command: { add() {} }, tool: { add() {} } };
  // Host events a test emits (`emit`), yielded in order by the adapter's subscription until it aborts.
  const queued: Array<{ type: string; data: Record<string, unknown> }> = [];
  let wake = () => {};
  const ctx = {
    location: { directory: repo, project: { directory: repo } },
    agent: { reload: async () => {}, list: async () => ({ data: [] }), transform: async (cb: (editor: unknown) => void) => { cb(editors.agent); return reg(); } },
    command: { reload: async () => {}, transform: async (cb: (editor: unknown) => void) => { cb(editors.command); return reg(); } },
    tool: { transform: async (cb: (editor: unknown) => void) => { cb(editors.tool); return reg(); }, hook: reg,
      list: async () => [{ id: "subagent", execute: async () => ({ output: { sessionID: "unused", text: "DONE:" } }) }] },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, ...(sessionID === "root" || sessionID.startsWith("owner-") ? {} : { parentID: "root" }) }),
      update: async () => {}, context: async () => [], prompt: async () => {}, synthetic: async () => {}, interrupt: async () => {}, move: async () => {},
      hook: async (name: string, cb: (event: never) => Promise<void>) => { sessionHooks[name] = cb; return reg(); },
    },
    permission: { hook: reg },
    event: { subscribe: async function* ({ signal }: { signal: AbortSignal }) {
      while (!signal.aborted) {
        const next = queued.shift();
        if (next !== undefined) { yield next; continue; }
        await new Promise<void>(resolve => {
          wake = resolve;
          if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    } },
  };
  const emit = (event: { type: string; data: Record<string, unknown> }): void => { queued.push(event); wake(); };
  const v2 = createV2Runtime(ctx as unknown as Parameters<typeof createV2Runtime>[0], { bootID: "0123456789abcdef" });
  const hooks = await ModelRouterPlugin({ directory: repo, worktree: repo, routerHost: "v2", client: v2.client,
    routerExecutor: access } as unknown as Parameters<typeof ModelRouterPlugin>[0]);
  const surface = hooks as unknown as Surface;
  const state: { executor: V2Executor | null; host: V2ExecutorHost | null } = { executor: null, host: null };
  const dispose = await registerV2Hooks(ctx as unknown as Context, hooks, v2, {
    slotVerifier: { verify: async () => ({ verdict: "pass", findings: "", ref: "fixture-proof" }) },
    executor: host => {
      const ports = runner === undefined ? host : { ...host, runner, knownAgent: () => true };
      state.host = ports;
      const executor = createExecutor({ routerHost: "v2", directory: repo }, { host: ports, prepared, access });
      state.executor = executor ?? null;
      if (executor != null) executors.push(executor);
      return executor ?? null;
    },
  });
  let disposal: Promise<void> | null = null;
  const cleanup = () => disposal ??= dispose();
  plugins.push(cleanup);
  return { access, prepared, surface, state, sessionHooks, emit, dispose: cleanup,
    deps: state.executor === null ? null : assembledDeps[assembledDeps.length - 1] ?? null,
    turnState: registries[registries.length - 1],
    call: (args: RouterPlanArgs, sessionID = "root") => surface.tool.router_plan!.execute(args, { sessionID, directory: repo }),
    async command(command: string, args = "", sessionID = "root") {
      const output = { parts: [] as { type: string; text: string }[] };
      await surface["command.execute.before"]({ command, arguments: args, sessionID }, output);
      return output.parts.map(part => part.text).join("\n");
    },
  };
}

type Repository = Awaited<ReturnType<typeof repository>>;
// The persistence builder's prose route is intentionally not launchable; runtime fixtures use a real route line.
function assemblyTask(id: string, patch: Partial<TaskNode> = {}): TaskNode {
  return taskNode(id, { route: { line: "[route class=implement needs=edit tier=fast]", role: "implementer", tier: "fast", pin: false }, ...patch });
}
function plan(fixture: Repository, id = "plan-a", status: LedgerV1["status"] = "awaiting-approval") {
  const value = buildDraft(0, id);
  value.status = status;
  value.repo = { ...value.repo, key: `key-${id}`, toplevel: fixture.repo, baseCommit: fixture.base };
  value.planPath = join(fixture.repo, "PLAN.md");
  value.orchestrator.sessionID = "root";
  value.config = { ...executorDefaults(), slotsDir: join(fixture.slotsRoot, id), phaseSuite: "off", land: "manual", batchMax: 1 };
  value.integration = { branch: `omr/${id}/integration`, worktree: join(fixture.slotsRoot, id, "integration"), head: fixture.base };
  return value;
}

async function seed(fixture: Repository, value: LedgerV1) {
  expect(ledgerViolations(value)).toEqual([]);
  expect(isLedgerV1(value)).toBe(true);
  for (const task of Object.values(value.tasks)) {
    expect(() => renderRouteLine(task, join(value.config.slotsDir!, "slot-1"))).not.toThrow();
  }
  const prepared = await prepareExecutor(fixture.repo);
  if (!prepared.ok) throw new Error(prepared.reason);
  const store = ledgerModule.createLedgerStore({ home: prepared.home });
  const writer = await store.create(value, holderOf(value.orchestrator.sessionID, process.pid, hostname()));
  const lock = JSON.parse(await readFile(join(planDir(prepared.home, value.planId), "writer.lock"), "utf8")) as Record<string, unknown>;
  await writer.close();
  return { store, home: prepared.home, lock };
}

function scriptedRunner(clock: Clock, work?: (request: ChildRunRequest) => Promise<string>) {
  const contexts = new Map<string, RetainedContextInfo>();
  const listeners = new Set<(context: RetainedContextInfo) => void>();
  const calls: ChildRunRequest[] = [];
  const runner: ChildRunner = {
    bootID: "0123456789abcdef", retainedContext: id => contexts.get(id) ?? null,
    onContextCaptured: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose: async () => {},
    async run(request) {
      calls.push(request);
      const sessionID = `assembly-child-${calls.length}-${clock.randomHex(8)}`;
      await request.onCreated(sessionID);
      await request.onConfirmed?.(sessionID);
      if (work === undefined) {
        // A hanging host child runs until interrupted; there is no autonomous completion timer.
        await new Promise<void>(resolve => {
          if (request.signal.aborted) resolve();
          else request.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { sessionID, text: "" };
      }
      return { sessionID, text: await work(request) };
    },
  };
  return { runner, calls, capture(sessionID = "root") {
    const context: RetainedContextInfo = { sessionID, callID: "assembly-call", messageID: "assembly-message", agent: "build",
      capturedAt: clock.iso(), bootID: runner.bootID, epoch: (contexts.get(sessionID)?.epoch ?? 0) + 1 };
    contexts.set(sessionID, context);
    for (const listener of listeners) listener(context);
  } };
}

function built(plugin: Awaited<ReturnType<typeof boot>>) {
  if (plugin.state.executor === null || plugin.deps === null) throw new Error(plugin.access.unavailable());
  return { ...plugin.state.executor, deps: plugin.deps };
}

async function waitForChild(child: ReturnType<typeof scriptedRunner>, executor: ReturnType<typeof built>): Promise<void> {
  await vi.waitFor(async () => {
    const ledger = await executor.deps.store.read("plan-a");
    const board = await executor.runtime.status("plan-a", "root");
    expect(child.calls, `${board}\n${JSON.stringify({ status: ledger.status, tasks: ledger.tasks, inbox: ledger.inbox })}`).toHaveLength(1);
  }, { timeout: 10_000 });
}

describe("assembled executor through v2 registration", () => {
  it("launch fixtures have renderable routes, unlike the persistence builder's prose placeholder", () => {
    expect(() => renderRouteLine(taskNode("T1"), "C:/fixture/slot-1")).toThrow("not one well-formed [route");
    expect(renderRouteLine(assemblyTask("T1"), "C:/fixture/slot-1"))
      .toBe("[route class=implement needs=edit root=C:/fixture/slot-1 tier=fast]");
  }, 5_000);

  it("A1: registers both surfaces and renders executor instructions immediately after plan (order 61)", async () => {
    const fixture = await repository();
    await configure(fixture.root, fixture.slotsRoot);
    const value = plan(fixture, "plan-a", "paused");
    value.tasks.T1 = assemblyTask("T1", { kind: "manual", state: "ready" });
    await seed(fixture, value);
    const plugin = await boot(fixture.repo);
    expect(plugin.surface.tool).toHaveProperty("router_plan");
    const output = { command: {}, agent: {} };
    await plugin.surface.config(output);
    expect(output.command).toHaveProperty("plan", expect.objectContaining({ template: "$ARGUMENTS" }));
    expect(await plugin.command("router")).toContain("/plan");
    await vi.waitFor(() => expect(plugin.state.executor?.runtime.planLine("root")).toContain("plan plan-a:"), { timeout: 10_000 });
    expect(await plugin.call({ action: "status", planId: "plan-a" })).toContain("Plan plan-a [paused]");
    const turnState = plugin.turnState;
    if (turnState === undefined) throw new Error("no v2 turn-state registry");
    const ordered = turnState.providers.slice().sort((a, b) => a.order - b.order);
    const index = ordered.findIndex(provider => provider.name === "plan");
    expect(index).toBeGreaterThanOrEqual(0);
    expect(ordered[index]?.order).toBe(60);
    const instructions = ordered[index + 1];
    expect(instructions?.order).toBe(61);
    const rendered = instructions?.render("root");
    expect(rendered).toBeTruthy();
    const tail = turnState.registry.buildTurnState("root") ?? "";
    expect(tail).toContain("plan plan-a:");
    expect(tail.indexOf(rendered ?? "missing")).toBeGreaterThan(tail.indexOf("plan plan-a:"));
  }, 30_000);

  it("A2: recovers a dead-pid ledger once, takes over with recover, and leaves foreign ledgers untouched", async () => {
    const fixture = await repository();
    await configure(fixture.root, fixture.slotsRoot);
    const value = plan(fixture, "plan-a", "running");
    value.tasks.T1 = assemblyTask("T1", { kind: "manual", state: "ready" });
    const { store, home, lock } = await seed(fixture, value);
    await writeFile(join(planDir(home, "plan-a"), "writer.lock"), JSON.stringify({ ...lock, pid: 2_147_483_647 }));
    const foreign = plan(fixture, "foreign", "paused");
    foreign.repo.toplevel = join(fixture.root, "another-toplevel");
    await mkdir(foreign.repo.toplevel);
    const writer = await store.create(foreign, holderOf("root", process.pid, hostname())); await writer.close();
    const before = await store.exportPlan("foreign");
    const recover = vi.fn<ReturnType<typeof recoveryModule.createRecoveryService>["recover"]>();
    const realRecovery = recoveryModule.createRecoveryService;
    vi.spyOn(recoveryModule, "createRecoveryService").mockImplementation(deps => {
      const service = realRecovery(deps);
      recover.mockImplementation(() => service.recover());
      return { ...service, recover };
    });
    const takeover = vi.fn();
    const makeStore = ledgerModule.createLedgerStore;
    vi.spyOn(ledgerModule, "createLedgerStore").mockImplementation(options => {
      const made = makeStore(options), take = made.takeover;
      made.takeover = (...args) => { takeover(...args); return take(...args); };
      return made;
    });
    const first = await boot(fixture.repo);
    await vi.waitFor(() => expect(first.state.executor?.runtime.planLine("root")).toContain("plan plan-a:"), { timeout: 10_000 });
    await vi.waitFor(() => expect(takeover).toHaveBeenCalledOnce(), { timeout: 10_000 });
    expect(takeover).toHaveBeenCalledWith("plan-a", expect.any(Object), "recover");
    expect(recover).toHaveBeenCalledOnce();
    const second = await boot(fixture.repo);
    expect(second.state.executor).toBeNull();
    expect(second.access.unavailable()).toContain("another plan executor already owns this process");
    expect(recover).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(planInputs.has("foreign")).toBe(true), { timeout: 10_000 });
    expect(await first.state.executor?.runtime.status("foreign", "root")).toContain("Foreign:");
    // Strict regression: foreign startup must not acquire a writer or rotate a journal, even at the same seq.
    expect(await store.exportPlan("foreign")).toEqual(before);
  }, 30_000);

  it("QA-5.1-20/26: a copy refused by the claim assembles once the holder disposes, is wired and disposed as one built at start, recovers once; a third copy is still refused", async () => {
    const fixture = await repository();
    const tracked = await configure(fixture.root, fixture.slotsRoot);
    const value = plan(fixture);
    value.tasks.T1 = assemblyTask("T1");
    await seed(fixture, value);
    const recover = vi.fn<ReturnType<typeof recoveryModule.createRecoveryService>["recover"]>();
    const realRecovery = recoveryModule.createRecoveryService;
    vi.spyOn(recoveryModule, "createRecoveryService").mockImplementation(deps => {
      const service = realRecovery(deps);
      return { ...service, recover: (...args) => { recover(...args); return service.recover(...args); } };
    });
    // QA-5.1-26: what reaches each assembled runtime through its adapter (host events, launcher metrics, retry decisions), and
    // when its dispose ends relative to the adapter's lease-registry release (W7).
    const order: string[] = [];
    const reached: Array<{ events: HostSessionEvent[]; metrics: Array<{ planId: string; metric: MetricPayload }>;
      retries: Array<{ sessionID: string; stop: boolean }> }> = [];
    const configured = vi.mocked(runtimeModule.createExecutorRuntime).getMockImplementation();
    if (configured === undefined) throw new Error("configure() mocks createExecutorRuntime");
    vi.mocked(runtimeModule.createExecutorRuntime).mockImplementation(deps => {
      const seen: (typeof reached)[number] = { events: [], metrics: [], retries: [] };
      const index = reached.push(seen) - 1;
      const inner = configured({ ...deps,
        hosts: { ...deps.hosts, onEvent: listener => deps.hosts.onEvent(e => { seen.events.push(e); listener(e); }) },
        // A provider at capacity: the runtime stops the host's retry of any child it owns (and only of those).
        capacity: (...args) => ({ ...deps.capacity(...args), shouldStopRetry: i => i.planChild }) });
      return { ...inner,
        recordMetric: (planId, m) => { seen.metrics.push({ planId, metric: m }); inner.recordMetric(planId, m); },
        onRetryHook: i => { const decision = inner.onRetryHook(i); seen.retries.push({ sessionID: i.sessionID, stop: decision.stop }); return decision; },
        dispose: async () => { try { await inner.dispose(); } finally { order.push(`runtime ${index} disposed`); } },
      };
    });
    const claimHeld = () => Reflect.get(globalThis, Symbol.for("omr.executor.claim.v1")) !== undefined;
    const a = await boot(fixture.repo);
    expect(a.state.executor).not.toBeNull();
    await vi.waitFor(() => expect(recover).toHaveBeenCalledOnce(), { timeout: 10_000 });
    // Each later plugin's lease-registry handle reports its release (the adapter's background disposers, after W7).
    let booting = "";
    const realAcquire = backgroundModule.acquireLeaseRegistry;
    vi.spyOn(backgroundModule, "acquireLeaseRegistry").mockImplementation(input => {
      // A delegate per acquire: the label stays this plugin's even if the registry hands every plugin one shared handle.
      const handle = realAcquire(input), label = booting;
      return Object.assign(Object.create(handle) as typeof handle, { release: () => {
        order.push(`leases ${label} released (claim ${claimHeld() ? "held" : "free"})`);
        return handle.release();
      } });
    });
    booting = "b";
    // The hot reload: B starts while A still holds the claim.
    const child = scriptedRunner(tracked.clock);
    const children: string[] = [];
    const run = child.runner.run;
    child.runner.run = request => run({ ...request, onCreated: async id => { children.push(id); await request.onCreated(id); } });
    const b = await boot(fixture.repo, child.runner);
    expect(b.state.executor).toBeNull();
    expect(b.access.unavailable()).toContain("another plan executor already owns this process");
    expect(b.access.runtime()).toBeNull(); // the claim is still held: B keeps waiting
    expect(b.sessionHooks.retry).toBeUndefined(); // no executor yet: no retry hook (M3)
    const assembled = assembledDeps.length;
    // A disposes: the release hands the claim to B, which assembles and starts without a user action.
    await a.dispose();
    expect(assembledDeps).toHaveLength(assembled + 1);
    await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(2), { timeout: 10_000 });
    const runtime = b.access.runtime();
    if (runtime === null) throw new Error(b.access.unavailable());
    const deps = assembledDeps[assembled]!, seenByB = reached[reached.length - 1]!;
    expect(await b.call({ action: "status", planId: "plan-a" })).toContain("Plan plan-a [awaiting-approval]");
    await runtime.start(); // a late port's start never recovers again
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(recover).toHaveBeenCalledTimes(2);
    expect(assembledDeps).toHaveLength(assembled + 1);
    // QA-5.1-26: B's adapter adopted the handed-over executor. An active plan: its instructions render at order 61, after the plan line.
    child.capture();
    await runtime.approve("plan-a", "root");
    runtime.onRouterToolCall("root");
    await vi.waitFor(() => expect(children).toHaveLength(1), { timeout: 10_000 });
    const planChild = children[0]!;
    await vi.waitFor(() => expect(deps.launcher.inFlight().map(flight => flight.childSessionID)).toContain(planChild), { timeout: 10_000 });
    const turnState = b.turnState;
    if (turnState === undefined) throw new Error("no v2 turn-state registry");
    const instructions = turnState.providers.find(provider => provider.order === 61);
    expect(instructions?.name, "B's executor instructions provider").toBe("plan-instructions");
    expect(instructions?.render("root")).toBeTruthy();
    const tail = turnState.registry.buildTurnState("root") ?? "";
    expect(tail).toContain("plan plan-a:");
    expect(tail.indexOf(instructions?.render("root") ?? "missing")).toBeGreaterThan(tail.indexOf("plan plan-a:"));
    // A host event of the plan child reaches B's runtime.
    b.emit({ type: "session.step.started", data: { sessionID: planChild, model: { providerID: "fixture", id: "fast" } } });
    await vi.waitFor(() => expect(seenByB.events).toContainEqual(expect.objectContaining({ type: "step.started", sessionID: planChild })), { timeout: 5_000 });
    // The retry hook stops the host's retry of the plan child (D13).
    await vi.waitFor(() => expect(b.sessionHooks.retry).toBeDefined(), { timeout: 5_000 });
    const retryEvent = { sessionID: planChild, error: { type: "APIError", status: 429, message: "rate limited" }, decision: { retry: true } };
    await b.sessionHooks.retry!(retryEvent as never);
    expect(seenByB.retries).toContainEqual({ sessionID: planChild, stop: true });
    expect(retryEvent.decision).toEqual({ retry: false });
    const otherRetry = { ...retryEvent, sessionID: "owner-other", decision: { retry: true } };
    await b.sessionHooks.retry!(otherRetry as never);
    expect(otherRetry.decision).toEqual({ retry: true });
    // A launcher metric reaches B's runtime.
    const metric: MetricPayload = { name: "counter", key: "qa-5.1-26", value: 1, labels: {} };
    b.state.host!.onLauncherMetric("plan-a", metric);
    expect(seenByB.metrics).toContainEqual({ planId: "plan-a", metric });
    // C comes while B holds the claim: refused, as B was.
    booting = "c";
    const c = await boot(fixture.repo);
    expect(c.state.executor).toBeNull();
    expect(c.access.unavailable()).toContain("another plan executor already owns this process");
    expect(c.access.runtime()).toBeNull();
    expect(assembledDeps).toHaveLength(assembled + 1);
    // C ends while waiting (its lifetime aborts): B's release assembles nothing for it.
    await c.dispose();
    // B's plugin disposes: W7 disposes B's runtime (releasing the claim) before the adapter's lease registry goes.
    const before = order.length;
    await b.dispose();
    expect(order.slice(before)).toEqual([`runtime ${reached.indexOf(seenByB)} disposed`, "leases b released (claim free)"]);
    expect(claimHeld()).toBe(false);
    expect(deps.launcher.inFlight()).toEqual([]);
    expect(assembledDeps).toHaveLength(assembled + 1);
    expect(c.access.runtime()).toBeNull();
    expect(recover).toHaveBeenCalledTimes(2);
  }, 45_000);

  it("A3: tools and /plan explain a non-repository, without creating an executor home", async () => {
    const fixture = await repository(false);
    await configure(fixture.root, fixture.slotsRoot);
    const plugin = await boot(fixture.repo);
    expect(plugin.state.executor).toBeNull();
    expect(await plugin.call({ action: "status" })).toContain("not a git repository");
    expect(await plugin.command("plan", "status")).toContain("not a git repository");
    expect(await readdir(fixture.repo)).toEqual([]);
    expect(await readdir(fixture.root)).not.toContain("omr-executor");
  }, 30_000);

  it.each([
    ["tiers", "enforce", "routing.delegation must be roles at start"],
    ["roles", "off", "routing.leases.mode must be enforce"],
  ])("A4: %s delegation / leases %s leaves the executor absent", async (delegation, leases, reason) => {
    const fixture = await repository();
    await configure(fixture.root, fixture.slotsRoot, delegation, leases);
    const plugin = await boot(fixture.repo);
    expect(plugin.state.executor).toBeNull();
    expect(plugin.access.unavailable()).toContain(reason);
    expect(await plugin.call({ action: "status" })).toContain(reason);
    expect(await plugin.command("plan", "status")).toContain(reason);
    expect(await readdir(join(fixture.repo, ".git"))).not.toContain("omr-executor");
  }, 30_000);

  it("A10: refuses a child session but lets the root read the real runtime", async () => {
    const fixture = await repository();
    await configure(fixture.root, fixture.slotsRoot);
    await seed(fixture, plan(fixture));
    const plugin = await boot(fixture.repo);
    expect(plugin.state.executor).not.toBeNull();
    expect(await plugin.call({ action: "status", planId: "plan-a" }, "child")).toContain("require a root orchestrator session");
    expect(await plugin.command("plan", "approve plan-a", "child")).toContain("require a root orchestrator session");
    expect(await plugin.call({ action: "status", planId: "plan-a" })).toContain("Plan plan-a [awaiting-approval]");
  }, 30_000);

  it("A9: approve refuses a slots-root junction into the repository before plan-approved", async () => {
    const fixture = await repository();
    await configure(fixture.root, fixture.slotsRoot);
    const junction = join(fixture.root, "invalid-slots");
    await symlink(fixture.repo, junction, process.platform === "win32" ? "junction" : "dir");
    const value = plan(fixture);
    value.config.slotsDir = join(junction, "plan-a");
    value.integration.worktree = join(value.config.slotsDir, "integration");
    const { store } = await seed(fixture, value);
    const plugin = await boot(fixture.repo);
    const response = await plugin.call({ action: "approve", planId: "plan-a" });
    expect(response).toContain("E_INVALID_INPUT");
    expect((await store.exportPlan("plan-a")).events.filter(event => event.type === "plan-approved")).toEqual([]);
    expect((await store.read("plan-a")).status).toBe("awaiting-approval");
  }, 30_000);

  it("A5: dispose ignores a hanging child, clears timers/locks/flights and releases the process claim", async () => {
    const fixture = await repository();
    const tracked = await configure(fixture.root, fixture.slotsRoot);
    const value = plan(fixture);
    value.tasks.T1 = assemblyTask("T1");
    const { home } = await seed(fixture, value);
    const child = scriptedRunner(tracked.clock);
    const plugin = await boot(fixture.repo, child.runner), executor = built(plugin);
    child.capture();
    await executor.runtime.approve("plan-a", "root");
    executor.runtime.onRouterToolCall("root");
    await waitForChild(child, executor);
    expect(executor.deps.launcher.inFlight()).toHaveLength(1);
    const disposal = plugin.dispose();
    await vi.waitFor(() => expect(plugin.access.runtime()).toBeNull(), { timeout: 5_000 });
    expect(await plugin.call({ action: "status", planId: "plan-a" })).toMatch(/shutting down|not available.*disposed/);
    await disposal;
    expect(executor.deps.launcher.inFlight()).toEqual([]);
    expect(tracked.pending.size).toBe(0);
    const files = await readdir(home, { recursive: true });
    expect(files.filter(file => /(?:writer\.lock|\.lock)$/.test(file))).toEqual([]);
    const next = await boot(fixture.repo, scriptedRunner(tracked.clock).runner);
    expect(next.state.executor).not.toBeNull();
  }, 30_000);

  it.each([false, true])("A8: integration branch/slot precede the first dequeue; existing branch=%s is never moved by setup", async existing => {
    const fixture = await repository();
    const tracked = await configure(fixture.root, fixture.slotsRoot);
    const value = plan(fixture);
    value.tasks.T1 = assemblyTask("T1", { footprint: { writes: ["result.txt"], reads: [], confidence: "explicit", sources: ["path"] } });
    let expected = fixture.base;
    if (existing) {
      await writeFile(join(fixture.repo, "extra.txt"), "later commit\n");
      git(fixture.repo, "add", "extra.txt"); git(fixture.repo, "commit", "-qm", "later");
      expected = git(fixture.repo, "rev-parse", "HEAD");
      git(fixture.repo, "update-ref", `refs/heads/${value.integration.branch}`, expected);
      value.integration.head = expected; // A previously known integration tip, not a request to move it.
    }
    await seed(fixture, value);
    let releaseWork = () => {};
    const hold = new Promise<void>(resolve => { releaseWork = resolve; });
    const child = scriptedRunner(tracked.clock, async request => {
      await hold;
      await writeFile(join(request.cwd, "result.txt"), "first dequeue\n");
      return "DONE: wrote result.txt";
    });
    const plugin = await boot(fixture.repo, child.runner), executor = built(plugin);
    child.capture();
    await executor.runtime.approve("plan-a", "root");
    await vi.waitFor(() => expect(planInputs.has("plan-a")).toBe(true), { timeout: 10_000 });
    const writer = planInputs.get("plan-a")!.writer, append = writer.append.bind(writer);
    const seen: { value: { branch: string; path: string | null; head: string } | null } = { value: null };
    vi.spyOn(writer, "append").mockImplementation(async batch => {
      const result = await append(batch);
      if (seen.value === null && writer.ledger.tasks.T1?.state === "integrating") {
        const slot = await executor.deps.slotsFor!("plan-a").get("integration");
        seen.value = { branch: git(fixture.repo, "rev-parse", value.integration.branch), path: slot?.path ?? null,
          head: git(value.integration.worktree, "rev-parse", "HEAD") };
      }
      return result;
    });
    // approve awaits ensureIntegration; no child can run before these resources exist.
    expect(git(fixture.repo, "rev-parse", value.integration.branch)).toBe(expected);
    const integration = await executor.deps.slotsFor?.("plan-a").get("integration");
    expect(integration?.path).toBe(value.integration.worktree);
    expect(git(value.integration.worktree, "rev-parse", "HEAD")).toBe(expected);
    releaseWork();
    executor.runtime.onRouterToolCall("root");
    await waitForChild(child, executor);
    expect(child.calls[0]?.cwd).toBe(join(fixture.slotsRoot, "plan-a", "slot-1"));
    await vi.waitFor(() => expect(seen.value).toEqual({ branch: expected, path: value.integration.worktree, head: expected }), { timeout: 15_000 });
  }, 30_000);

  it("A11: the assembly lease port finds a slot lease from the repository toplevel", async () => {
    const fixture = await repository();
    await configure(fixture.root, fixture.slotsRoot);
    await seed(fixture, plan(fixture));
    const plugin = await boot(fixture.repo), executor = built(plugin);
    const slot = await executor.deps.slotsFor?.("plan-a").acquire("plan-a", "plan:plan-a:T1", fixture.base);
    if (slot === undefined) throw new Error("no plan slot pool");
    expect(executor.deps.leaseRegistry.acquireWrite({ holderID: "plan:plan-a:T1", tree: slot.path, isChild: true,
      taskRef: "plan-a/T1", scope: "until-integrated" }, ["README.md"])).toEqual({ ok: true });
    const query = vi.spyOn(plugin.state.host!.leases!.registry, "planHolderOf");
    expect(executor.deps.leaseRegistry.holderOf("README.md")).toEqual({ holderID: "plan:plan-a:T1", taskRef: "plan-a/T1" });
    expect(query).toHaveBeenCalledWith(fixture.repo, "README.md");
    executor.deps.leaseRegistry.releaseTask("plan-a/T1");
    expect(executor.deps.leaseRegistry.holderOf("README.md")).toBeNull();
  }, 30_000);

  it("purge retries a partial gc through a closed pool before deleting the ledger", async () => {
    const fixture = await repository();
    await configure(fixture.root, fixture.slotsRoot);
    await seed(fixture, plan(fixture, "plan-a", "paused"));
    const plugin = await boot(fixture.repo), executor = built(plugin);
    await vi.waitFor(() => expect(planInputs.has("plan-a")).toBe(true), { timeout: 10_000 });
    const pool = executor.deps.slotsFor!("plan-a");
    const first = await pool.acquire("plan-a", "plan:plan-a:T1", fixture.base);
    const second = await pool.acquire("plan-a", "plan:plan-a:T2", fixture.base);
    const poolDeps = vi.mocked(poolModule.createSlotPool).mock.calls[0]?.[0];
    if (poolDeps === undefined) throw new Error("no slot pool was assembled");
    const rm = poolDeps.fs.rm.bind(poolDeps.fs);
    let blocked = true;
    vi.spyOn(poolDeps.fs, "rm").mockImplementation(async (path, options) => {
      if (blocked && path === first.path) throw new Error("blocked slot removal");
      await rm(path, options);
    });
    const partial = await pool.gc(async id => id === "plan-a");
    expect(partial.removed).toContain(second.path);
    expect(partial.reported).toContain(`${first.path}: blocked slot removal`);
    expect((await stat(first.path)).isDirectory()).toBe(true);
    await expect(stat(second.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(poolDeps.markersDir, "plan-a"))).toContain(`${first.slot}.json`);
    await expect(pool.acquire("plan-a", "plan:plan-a:T3", fixture.base)).rejects.toMatchObject({ code: "E_PLAN_STATE" });

    // The partial gc closed the facade; the abort's automatic collection retries through it while the slot is still blocked.
    await executor.runtime.abort("plan-a", "root");
    await executor.runtime.settled();
    expect((await stat(first.path)).isDirectory()).toBe(true);
    blocked = false;
    await executor.runtime.purge("plan-a", "root");
    await expect(stat(first.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await executor.deps.store.list()).toEqual([]);
    const markers = join(poolDeps.markersDir, "plan-a");
    await expect(stat(join(markers, `${first.slot}.json`))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(markers).catch((error: NodeJS.ErrnoException) => error.code), "plan-a marker directory after purge").toBe("ENOENT");
    await expect(stat(markers)).rejects.toMatchObject({ code: "ENOENT" });
    // QA-5.1-22: the complete gc of the purged plan leaves no empty `<root>\<planId>` behind.
    await expect(stat(join(fixture.slotsRoot, "plan-a"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("QA-5.1-22: purging an aborted plan that never had a slot creates no slots directory", async () => {
    const fixture = await repository();
    await configure(fixture.root, fixture.slotsRoot);
    await seed(fixture, plan(fixture, "plan-a", "awaiting-approval"));
    const plugin = await boot(fixture.repo), executor = built(plugin);
    await executor.runtime.abort("plan-a", "root");
    await executor.runtime.settled();
    await executor.runtime.purge("plan-a", "root");
    expect(await executor.deps.store.list()).toEqual([]);
    await expect(stat(join(fixture.slotsRoot, "plan-a"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("A7: per-plan roots isolate slot-1; aborting passive B releases B, not active A", async () => {
    const fixture = await repository();
    const tracked = await configure(fixture.root, fixture.slotsRoot);
    const a = plan(fixture, "plan-a", "running"); a.tasks.T1 = assemblyTask("T1");
    const b = plan(fixture, "plan-b", "paused");
    b.tasks.T1 = assemblyTask("T1", { state: "verified", slot: "slot-1", branch: "omr/plan-b/t/T1",
      footprint: { writes: ["b.txt"], reads: [], confidence: "explicit", sources: ["path"] },
      attempts: [{ ...openAttempt(1), outcome: "succeeded", verdict: "pass", endedAt: "2026-10-11T00:00:01.000Z" }] });
    await seed(fixture, a); await seed(fixture, b);
    const child = scriptedRunner(tracked.clock); child.capture();
    const plugin = await boot(fixture.repo, child.runner), executor = built(plugin);
    await waitForChild(child, executor);
    await vi.waitFor(() => expect(planInputs.has("plan-b")).toBe(true), { timeout: 10_000 });
    expect(await executor.runtime.status("plan-b", "root")).toContain("Refused:");
    const poolA = executor.deps.slotsFor!("plan-a"), poolB = executor.deps.slotsFor!("plan-b");
    const leaseB = await poolB.acquire("plan-b", "plan:plan-b:T1", fixture.base);
    expect(leaseB.path).toBe(join(fixture.slotsRoot, "plan-b", "slot-1"));
    expect(child.calls[0]?.cwd).toBe(join(fixture.slotsRoot, "plan-a", "slot-1"));
    const releaseA = vi.spyOn(poolA, "release"), releaseB = vi.spyOn(poolB, "release");
    await executor.runtime.abort("plan-b", "root");
    expect(releaseB).toHaveBeenCalledExactlyOnceWith("slot-1");
    expect(releaseA).not.toHaveBeenCalled();
    expect((await poolA.get("slot-1"))?.state).toBe("leased");
    expect(executor.deps.launcher.inFlight()).toHaveLength(1);
    expect(await poolB.get("slot-1")).toBeNull();
  }, 30_000);

  it.each(["completed", "aborted"] as const)("A6: %s collects exactly once after quiescence, keeping paused B's slots", async status => {
    const fixture = await repository();
    await configure(fixture.root, fixture.slotsRoot);
    const a = plan(fixture, "plan-a", "paused");
    a.tasks.T1 = assemblyTask("T1", { kind: "manual", state: "done" });
    a.phases[0]!.gate = "passed"; // A passed but not yet tagged phase is explicitly not quiescent.
    const b = plan(fixture, "plan-b", "paused"); b.tasks.T1 = assemblyTask("T1", { kind: "manual", state: "ready" });
    await seed(fixture, a); await seed(fixture, b);
    const plugin = await boot(fixture.repo), executor = built(plugin);
    await vi.waitFor(() => expect(planInputs.has("plan-b")).toBe(true), { timeout: 10_000 });
    const poolB = executor.deps.slotsFor!("plan-b");
    const kept = await poolB.acquire("plan-b", "plan:plan-b:T1", fixture.base);
    const input = planInputs.get("plan-a");
    if (input === undefined) throw new Error("A was not attached");
    if (status === "aborted") await executor.runtime.abort("plan-a", "root");
    else {
      await input.writer.append([{ type: "status-changed", from: "paused", to: "running", reason: "test-resume" }]);
      executor.runtime.onRouterToolCall("root");
      await vi.waitFor(() => expect(input.writer.ledger.status).toBe("completed"), { timeout: 10_000 });
    }
    await executor.runtime.settled();
    if (status === "aborted") {
      // QA-5.1-7 (planTagsSettled): an aborted plan tags nothing, so quiescence alone collects it, passed-untagged phase and all.
      expect(collections.get("plan-a"), `plan-a status ${input.writer.ledger.status}`).toEqual([{ live: 0, open: 0, untagged: 1 }]);
      // A late tag on the collected plan must not collect it again.
      await input.writer.append([{ type: "phase-tagged", phaseId: "p1", tag: "omr/plan-a/phase/p1" }]);
    } else {
      // A completed plan's passed phase is not settled until tagged: no collection yet.
      expect(collections.get("plan-a") ?? [], `plan-a status ${input.writer.ledger.status}`).toEqual([]);
      await input.writer.append([{ type: "phase-tagged", phaseId: "p1", tag: "omr/plan-a/phase/p1" }]);
      await vi.waitFor(() => expect(collections.get("plan-a")).toEqual([{ live: 0, open: 0, untagged: 0 }]), { timeout: 10_000 });
    }
    for (let tick = 0; tick < 3; tick++) {
      executor.runtime.onRouterToolCall("root");
      await executor.runtime.settled();
    }
    expect(collections.get("plan-a")).toHaveLength(1);
    expect(collections.get("plan-b")).toBeUndefined();
    expect((await poolB.get(kept.slot))?.path).toBe(kept.path);
    expect((await poolB.get(kept.slot))?.state).toBe("leased");
  }, 30_000);

  it("A12: answering B- unpauses the phase and integrates its already queued verified task", async () => {
    const fixture = await repository();
    const tracked = await configure(fixture.root, fixture.slotsRoot);
    const value = plan(fixture); value.tasks.T1 = assemblyTask("T1", {
      footprint: { writes: ["result.txt"], reads: [], confidence: "explicit", sources: ["path"] },
    });
    await seed(fixture, value);
    let release = () => {};
    const hold = new Promise<void>(resolve => { release = resolve; });
    const child = scriptedRunner(tracked.clock, async request => {
      await hold;
      await writeFile(join(request.cwd, "result.txt"), "verified work\n");
      return "DONE: wrote result.txt";
    });
    const plugin = await boot(fixture.repo, child.runner), executor = built(plugin);
    child.capture(); await executor.runtime.approve("plan-a", "root"); executor.runtime.onRouterToolCall("root");
    await waitForChild(child, executor);
    const input = planInputs.get("plan-a"), collab = collaborators.get("plan-a");
    if (input === undefined || collab === undefined) throw new Error("A collaborators missing");
    await input.writer.append([
      { type: "phase-paused", phaseId: "p1", paused: true, reason: "breaker" },
      { type: "inbox-added", item: { id: "B-1", kind: "breaker", severity: "blocking", taskId: "T1", text: "phase p1 circuit breaker",
        options: ["continue"], answer: null, createdAt: tracked.clock.iso() } },
    ]);
    release();
    await vi.waitFor(() => expect(input.writer.ledger.tasks.T1?.state).toBe("verified"), { timeout: 15_000 });
    await vi.waitFor(() => expect(collab.queue.queued()).toContain("T1"), { timeout: 5_000 });
    expect(input.writer.ledger.phases[0]?.paused).toBe(true);
    await executor.runtime.answer("plan-a", "B-1", "continue", "root");
    expect(input.writer.ledger.phases[0]?.paused).toBe(false);
    // Deliberately no resume/enqueue/lease-release nudge: answering the breaker must kick the real queue.
    await vi.waitFor(() => expect(input.writer.ledger.tasks.T1?.state).toBe("integrated"), { timeout: 10_000 });
    // Completion may already have collected the worktree; the integration ref is the durable result.
    expect(git(fixture.repo, "show", `${value.integration.branch}:result.txt`)).toBe("verified work");
  }, 45_000);
});
