import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
import { wipRefName } from "../../src/executor/git";
import * as ledgerModule from "../../src/executor/ledger";
import * as provisionModule from "../../src/executor/slots/provision";
import * as execModule from "../../src/verify/exec";
import { BUDGET_RESUMES, executorDefaults, isLedgerV1, ledgerViolations, type ChildRunner, type ExecutorChildGuardPort, type ChildRunRequest, type Clock, type HostSessions, type LedgerV1, type RetainedContextInfo, type TaskNode } from "../../src/executor/types";
import * as runtimeModule from "../../src/executor/runtime";
import { planDir } from "../../src/executor/paths";
import { invalidateConfigCache, validateConfig } from "../../src/router/config";
import * as configModule from "../../src/router/config";
import { resolveRoleTable } from "../../src/router/roles";
import { parseCapDirective } from "../../src/router/sessions";
import { buildDraft, holderOf, taskNode } from "../fixtures/cpx/ledger/builders";
import { removeDirWhenReleased } from "../helpers/remove-dir";
import type { RouterPlanArgs } from "../../src/executor/tool";

// Keep the assembly's real runtime, launcher and pool; only the host child and verification commands are scripted.
const executors: V2Executor[] = [];
const plugins: Array<() => Promise<void>> = [];
const roots: string[] = [];
const assembledDeps: runtimeModule.RuntimeDeps[] = [];
const realRuntime = runtimeModule.createExecutorRuntime;
afterEach(async () => {
  for (const dispose of plugins.splice(0).reverse()) await dispose();
  for (const executor of executors.splice(0).reverse()) {
    await executor.runtime.dispose();
    await executor.launcher.dispose();
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  assembledDeps.length = 0;
  invalidateConfigCache();
  for (const root of roots.splice(0)) await removeDirWhenReleased(root);
}, 30_000);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=", "-c", "commit.gpgSign=false", ...args],
    { cwd, windowsHide: true, encoding: "utf8", timeout: 5_000, stdio: "pipe" }).trim();
}

async function repository() {
  // Native realpath removes Windows 8.3 aliases before the assembly checks slot containment.
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), "omr-v2-resume-")));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Executor Test");
  git(repo, "config", "user.email", "executor@example.invalid");
  await writeFile(join(repo, "README.md"), "resume fixture\n");
  await writeFile(join(repo, "package.json"), JSON.stringify({ scripts: { typecheck: "node -e process.exit(0)" } }));
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "fixture");
  return { root, repo: realpathSync.native(repo), slotsRoot: join(root, "slots"), base: git(repo, "rev-parse", "HEAD") };
}

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
};

async function configure(root: string, slotsRoot: string) {
  for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME"]) vi.stubEnv(key, root);
  vi.stubEnv("MODEL_ROUTER_ENFORCE", "1");
  const bundled = JSON.parse(await readFile(new URL("../../tiers.json", import.meta.url), "utf8")) as Record<string, unknown>;
  const config = validateConfig({ ...bundled, activePreset: "fixture", defaultTier: "medium", presets: { fixture: {
    fast: { model: "fixture/fast", description: "fixture fast", costRatio: 1 },
    medium: { model: "fixture/medium", description: "fixture medium", costRatio: 2 },
    heavy: { model: "fixture/heavy", description: "fixture heavy", costRatio: 3 },
  } }, routing: { delegation: "roles", leases: { mode: "enforce" },
    executor: { slotsDir: slotsRoot, land: "manual", phaseSuite: "off", batchMax: 1, wakeDebounceMs: 1000 } },
    enforcement: { verify: { require: "always" } } });
  vi.spyOn(configModule, "loadConfig").mockReturnValue(config);
  const table = resolveRoleTable(config, "v2");
  expect(table.roles.has("implementer"), JSON.stringify(table.issues)).toBe(true);
  const tracked = trackedClock();
  vi.spyOn(ledgerModule, "createNodeClock").mockReturnValue(tracked.clock);
  vi.spyOn(provisionModule, "createProvisioner").mockReturnValue({
    detect: async () => ({ managers: [], manifests: {}, yarnBerry: false, editable: false, python: null }),
    provision: async () => {},
  });
  vi.spyOn(runtimeModule, "createExecutorRuntime").mockImplementation(deps => {
    assembledDeps.push(deps);
    return realRuntime(deps);
  });
  vi.spyOn(execModule, "runArgv").mockResolvedValue({ code: 0, timedOut: false, stdout: "", stderr: "" });
  return tracked;
}

type EmittedEvent = { type: string; data: Record<string, unknown> };

async function boot(repo: string, runner?: ChildRunner) {
  const access = createExecutorAccess();
  const prepared = await prepareExecutor(repo);
  const sessionHooks: Record<string, (event: never) => Promise<void>> = {};
  const reg = async () => ({ dispose: async () => {} });
  const editors = { agent: { update() {} }, command: { add() {} }, tool: { add() {} } };
  const queued: EmittedEvent[] = [];
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
  const emit = (event: EmittedEvent): void => { queued.push(event); wake(); };
  const v2 = createV2Runtime(ctx as unknown as Parameters<typeof createV2Runtime>[0], { bootID: "0123456789abcdef" });
  // As src/v2.ts wires it (QA-PDF21-2-11/-20): the plugin's guard state of executor children reaches the adapter.
  let executorChildGuard: ExecutorChildGuardPort | undefined;
  const hooks = await ModelRouterPlugin({ directory: repo, worktree: repo, routerHost: "v2", client: v2.client,
    routerExecutor: access, routerOnExecutorChildGuard: (port: ExecutorChildGuardPort) => { executorChildGuard = port; },
  } as unknown as Parameters<typeof ModelRouterPlugin>[0]);
  const surface = hooks as unknown as Surface;
  const state: { executor: V2Executor | null; host: V2ExecutorHost | null } = { executor: null, host: null };
  const dispose = await registerV2Hooks(ctx as unknown as Context, hooks, v2, {
    ...(executorChildGuard ? { executorChildGuard } : {}),
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
  return { access, prepared, surface, state, emit, dispose: cleanup, hooks: hooks as unknown as Record<string, ((input: unknown, output: unknown) => Promise<void>) | undefined>,
    deps: state.executor === null ? null : assembledDeps[assembledDeps.length - 1] ?? null,
    call: (args: RouterPlanArgs, sessionID = "root") => surface.tool.router_plan!.execute(args, { sessionID, directory: repo }),
  };
}

type Repository = Awaited<ReturnType<typeof repository>>;
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

function scriptedRunner(clock: Clock, work?: (request: ChildRunRequest, sessionID: string) => Promise<string>) {
  const contexts = new Map<string, RetainedContextInfo>();
  const listeners = new Set<(context: RetainedContextInfo) => void>();
  const calls: ChildRunRequest[] = [];
  const sessions: string[] = [];
  let emit: ((event: EmittedEvent) => void) | null = null;
  let hosts: HostSessions | null = null;
  const runner: ChildRunner = {
    bootID: "0123456789abcdef", retainedContext: id => contexts.get(id) ?? null,
    onContextCaptured: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose: async () => {},
    async run(request) {
      calls.push(request); // Includes resumeSessionID exactly as supplied by the real launcher.
      const sessionID = request.resumeSessionID ?? `resume-child-${calls.length}-${clock.randomHex(8)}`;
      sessions.push(sessionID);
      await request.onCreated(sessionID);
      if (request.resumeSessionID !== undefined) {
        if (emit === null || hosts === null) throw new Error("resumed runner needs boot().emit and the assembled host events");
        // onCreated does NOT confirm a resume. Only this real v2 host event does.
        let stepStarted = () => {};
        const started = new Promise<void>(resolve => { stepStarted = resolve; });
        const off = hosts.onEvent(event => {
          if (event.type === "step.started" && event.sessionID === sessionID) stepStarted();
        });
        request.signal.addEventListener("abort", stepStarted, { once: true });
        try {
          if (request.signal.aborted) stepStarted();
          else emit({ type: "session.step.started", data: { sessionID, model: { providerID: "fixture", id: "fast" } } });
          // Do not race the adapter with a timer/microtask guess: wait until the real host port receives our event.
          await started;
        } finally {
          off();
          request.signal.removeEventListener("abort", stepStarted);
        }
      }
      await request.onConfirmed?.(sessionID);
      if (work === undefined) {
        await new Promise<void>(resolve => {
          if (request.signal.aborted) resolve();
          else request.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { sessionID, text: "" };
      }
      return { sessionID, text: await work(request, sessionID) };
    },
  };
  return { runner, calls, sessions, setEmitter(value: (event: EmittedEvent) => void, events: HostSessions) { emit = value; hosts = events; }, capture(sessionID = "root") {
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

const TEST_MS = 60_000;
const WAIT_MS = 15_000;

/** A scripted child can be held at an assertion boundary, but disposal always releases it. */
function childGate() {
  let release = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { release, async wait(signal: AbortSignal) {
    if (signal.aborted) return;
    let onAbort = () => {};
    const aborted = new Promise<void>(resolve => { onAbort = resolve; signal.addEventListener("abort", onAbort, { once: true }); });
    try { await Promise.race([promise, aborted]); }
    finally { signal.removeEventListener("abort", onAbort); }
  } };
}

async function waitForCalls(child: ReturnType<typeof scriptedRunner>, executor: ReturnType<typeof built>, count: number) {
  await vi.waitFor(async () => {
    const ledger = await executor.deps.store.read("plan-a");
    expect(child.calls, JSON.stringify({ status: ledger.status, task: ledger.tasks.T1, inbox: ledger.inbox })).toHaveLength(count);
  }, { timeout: WAIT_MS });
}

async function waitForState(executor: ReturnType<typeof built>, state: TaskNode["state"]) {
  await vi.waitFor(async () => {
    const ledger = await executor.deps.store.read("plan-a");
    expect(ledger.tasks.T1?.state, JSON.stringify({ task: ledger.tasks.T1, inbox: ledger.inbox })).toBe(state);
  }, { timeout: WAIT_MS });
}

describe("v2 assembled executor resume and restored work (real launcher, pool and runtime)", () => {
  it("A13: budget resumes the same session, slot, attempt and nonce, then commits/verifies/integrates once", async () => {
    const fixture = await repository();
    const tracked = await configure(fixture.root, fixture.slotsRoot);
    const value = plan(fixture);
    value.tasks.T1 = assemblyTask("T1", {
      footprint: { writes: ["budget.txt", "done.txt"], reads: [], confidence: "explicit", sources: ["path"] },
    });
    await seed(fixture, value);
    const budget = childGate(), done = childGate();
    const child = scriptedRunner(tracked.clock, async request => {
      if (request.resumeSessionID === undefined) {
        await writeFile(join(request.cwd, "budget.txt"), "before budget\n");
        await budget.wait(request.signal);
        return "NEED MORE: budget";
      }
      await done.wait(request.signal);
      if (!request.signal.aborted) await writeFile(join(request.cwd, "done.txt"), "after resume\n");
      return "DONE: finished both parts";
    });
    const plugin = await boot(fixture.repo, child.runner), executor = built(plugin);
    child.setEmitter(plugin.emit, executor.deps.hosts);
    // Observe, do not replace, the actual launch implementation: runner requests contain no attempt/nonce themselves.
    const launches = vi.spyOn(executor.deps.launcher, "launch");
    // boot supplies a verify-only host port; begin is optional and is not present on this fixture.
    // Count actual verification instead, including that a budget end must not verify unfinished work.
    const verify = vi.spyOn(executor.deps.verifier, "verify");
    child.capture();
    await executor.runtime.approve("plan-a", "root");
    executor.runtime.onRouterToolCall("root");
    await waitForCalls(child, executor, 1);
    await waitForState(executor, "running");
    const first = (await executor.deps.store.read("plan-a")).tasks.T1!.attempts[0]!;
    expect(first.n).toBe(1);
    budget.release();
    await waitForCalls(child, executor, 2);
    await vi.waitFor(async () => {
      expect((await executor.deps.store.read("plan-a")).tasks.T1?.attempts[0]?.resumes).toBe(1);
    }, { timeout: WAIT_MS });
    const initial = child.calls[0]!, resumed = child.calls[1]!;
    expect(initial.resumeSessionID).toBeUndefined();
    expect(resumed.resumeSessionID).toBe(child.sessions[0]);
    expect(child.sessions[1]).toBe(child.sessions[0]);
    expect(resumed.prompt).toBe(runtimeModule.RESUME_PROMPT);
    expect(resumed.cwd).toBe(initial.cwd);
    expect(launches).toHaveBeenCalledTimes(2);
    expect(launches.mock.calls[0]?.[0]).toMatchObject({ attempt: first.n, nonce: first.nonce, workRoot: initial.cwd });
    expect(launches.mock.calls[1]?.[0]).toMatchObject({
      attempt: first.n, nonce: first.nonce, workRoot: initial.cwd, resume: { childSessionID: child.sessions[0] },
    });
    const continuing = await executor.deps.store.read("plan-a");
    expect(continuing.tasks.T1?.attempts).toHaveLength(1);
    expect(continuing.tasks.T1?.attempts[0]).toMatchObject({ n: first.n, nonce: first.nonce, childSessionID: child.sessions[0] });
    expect(continuing.inbox).toEqual([]);
    expect(await readFile(join(resumed.cwd, "budget.txt"), "utf8")).toBe("before budget\n");
    expect(git(resumed.cwd, "rev-parse", "HEAD")).toBe(fixture.base);
    expect((await executor.deps.slotsFor!("plan-a").get("slot-1"))?.state).toBe("leased");
    expect(verify).not.toHaveBeenCalled();
    done.release();
    await waitForState(executor, "integrated");
    const finished = await executor.deps.store.read("plan-a");
    expect(finished.tasks.T1?.attempts).toHaveLength(1);
    expect(finished.tasks.T1?.attempts[0]).toMatchObject({ n: 1, nonce: first.nonce, resumes: 1, outcome: "succeeded", verdict: "pass" });
    expect(finished.inbox).toEqual([]);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(git(fixture.repo, "show", `${value.integration.branch}:budget.txt`)).toBe("before budget");
    expect(git(fixture.repo, "show", `${value.integration.branch}:done.txt`)).toBe("after resume");
    expect(git(fixture.repo, "rev-list", "--count", `${fixture.base}..${value.integration.branch}`)).toBe("1");
    expect(git(fixture.repo, "log", "-1", "--format=%B", value.integration.branch)).toContain(`Omr-Attempt: plan-a/T1/1/${first.nonce}`);
  }, TEST_MS);

  it("A13: consecutive budget ends past BUDGET_RESUMES park the single attempt with budget-cap", async () => {
    const rounds = BUDGET_RESUMES + 1;
    const fixture = await repository();
    const tracked = await configure(fixture.root, fixture.slotsRoot);
    const value = plan(fixture);
    value.tasks.T1 = assemblyTask("T1", {
      footprint: { writes: ["budget.txt"], reads: [], confidence: "explicit", sources: ["path"] },
    });
    await seed(fixture, value);
    const child = scriptedRunner(tracked.clock, async request => {
      if (request.resumeSessionID === undefined) await writeFile(join(request.cwd, "budget.txt"), "unfinished\n");
      return "NEED MORE: budget";
    });
    const plugin = await boot(fixture.repo, child.runner), executor = built(plugin);
    child.setEmitter(plugin.emit, executor.deps.hosts);
    const launches = vi.spyOn(executor.deps.launcher, "launch");
    child.capture();
    await executor.runtime.approve("plan-a", "root");
    executor.runtime.onRouterToolCall("root");
    await waitForState(executor, "parked");
    const parked = await executor.deps.store.read("plan-a");
    expect(BUDGET_RESUMES).toBeGreaterThanOrEqual(1);
    expect(child.calls, JSON.stringify({ task: parked.tasks.T1, inbox: parked.inbox })).toHaveLength(rounds);
    expect(child.calls.slice(1).map(request => request.resumeSessionID)).toEqual(Array(BUDGET_RESUMES).fill(child.sessions[0]));
    expect(new Set(child.sessions).size).toBe(1);
    expect(new Set(child.calls.map(request => request.cwd)).size).toBe(1);
    expect(child.calls.slice(1).map(request => request.prompt)).toEqual(Array(BUDGET_RESUMES).fill(runtimeModule.RESUME_PROMPT));
    expect(launches.mock.calls.map(([request]) => request.attempt)).toEqual(Array(rounds).fill(1));
    expect(new Set(launches.mock.calls.map(([request]) => request.nonce)).size).toBe(1);
    expect(parked.tasks.T1?.attempts).toHaveLength(1);
    expect(parked.tasks.T1?.attempts[0]).toMatchObject({ n: 1, resumes: BUDGET_RESUMES, outcome: "interrupted" });
    expect(parked.inbox.filter(item => item.taskId === "T1" && item.answer === null)).toHaveLength(1);
    expect(parked.inbox.find(item => item.taskId === "T1")?.text).toMatch(/budget cap reached/);
    const exported = await executor.deps.store.exportPlan("plan-a");
    expect(exported.events.filter(event => event.type === "task-transition" && event.taskId === "T1" && event.to === "parked"))
      .toEqual([expect.objectContaining({ from: "running", to: "parked", trigger: "budget-cap" })]);
    await vi.waitFor(() => {
      // The task id is a ref component through the case-fold-safe encoding (git.ts encodeRefId: T1 -> t1_u1).
      expect(git(fixture.repo, "show", `refs/heads/${wipRefName("plan-a", "T1")}:budget.txt`)).toBe("unfinished");
    }, { timeout: WAIT_MS });
  }, TEST_MS);

  it("A14: escalation saves dirty work, a real pool reset restores it for attempt 2, and purge removes WIP", async () => {
    const fixture = await repository();
    const tracked = await configure(fixture.root, fixture.slotsRoot);
    const value = plan(fixture);
    value.tasks.T1 = assemblyTask("T1", {
      footprint: { writes: ["first.txt", "second.txt"], reads: [], confidence: "explicit", sources: ["path"] },
    });
    await seed(fixture, value);
    const done = childGate();
    let runs = 0;
    const child = scriptedRunner(tracked.clock, async request => {
      if (++runs === 1) {
        await writeFile(join(request.cwd, "first.txt"), "attempt 1\n");
        return "ESCALATE: which API should the second part use?";
      }
      await done.wait(request.signal);
      if (!request.signal.aborted) await writeFile(join(request.cwd, "second.txt"), "attempt 2\n");
      return "DONE: finished both attempts' files";
    });
    const plugin = await boot(fixture.repo, child.runner), executor = built(plugin);
    child.setEmitter(plugin.emit, executor.deps.hosts);
    child.capture();
    await executor.runtime.approve("plan-a", "root");
    executor.runtime.onRouterToolCall("root");
    await waitForState(executor, "parked");
    const firstSlot = child.calls[0]!.cwd;
    // The task id is a ref component through the case-fold-safe encoding (git.ts encodeRefId: T1 -> t1_u1).
    const wipRef = `refs/heads/${wipRefName("plan-a", "T1")}`;
    expect(wipRef).toBe("refs/heads/omr/plan-a/wip/t1_u1");
    // Parking is journaled before its asynchronous snapshot/reset/release completes.
    await vi.waitFor(async () => {
      expect((await executor.deps.slotsFor!("plan-a").get("slot-1"))?.state).toBe("ready");
      expect(git(firstSlot, "status", "--porcelain", "--untracked-files=all")).toBe("");
      expect(git(firstSlot, "rev-parse", "HEAD")).toBe(fixture.base);
    }, { timeout: WAIT_MS });
    const parked = await executor.deps.store.read("plan-a");
    const first = parked.tasks.T1!.attempts[0]!;
    expect(git(fixture.repo, "for-each-ref", "--format=%(refname)", wipRef),
      JSON.stringify({ task: parked.tasks.T1, inbox: parked.inbox })).toBe(wipRef);
    const wip = git(fixture.repo, "rev-parse", "--verify", wipRef);
    expect(git(fixture.repo, "log", "-1", "--format=%B", wip)).toContain(`Omr-Wip: plan-a/T1/1/${first.nonce}`);
    expect(git(fixture.repo, "log", "-1", "--format=%B", wip)).not.toContain("Omr-Attempt");
    expect(git(fixture.repo, "rev-parse", `${wip}^`)).toBe(fixture.base);
    expect(git(fixture.repo, "show", `${wip}:first.txt`)).toBe("attempt 1");
    const item = parked.inbox.find(entry => entry.taskId === "T1" && entry.answer === null);
    if (item === undefined) throw new Error("escalation did not raise an answerable item");
    const integrationHead = git(fixture.repo, "rev-parse", value.integration.branch);
    await executor.runtime.answer("plan-a", item.id, "use the new API and continue", "root");
    await waitForCalls(child, executor, 2);
    await waitForState(executor, "running");
    const second = child.calls[1]!;
    expect(second.resumeSessionID).toBeUndefined();
    expect(child.sessions[1]).not.toBe(child.sessions[0]);
    expect(second.cwd).toBe(firstSlot);
    expect(git(second.cwd, "rev-parse", "HEAD")).toBe(integrationHead);
    expect(await readFile(join(second.cwd, "first.txt"), "utf8")).toBe("attempt 1\n");
    expect(git(second.cwd, "status", "--porcelain", "--untracked-files=all")).toMatch(/first\.txt/);
    expect((await executor.deps.store.read("plan-a")).tasks.T1?.attempts.map(attempt => attempt.n)).toEqual([1, 2]);
    expect(second.prompt).toContain("Your previous attempt's work (attempt 1, 1 files) is already in your work root as uncommitted changes. Continue it; do not start over.");
    done.release();
    await waitForState(executor, "integrated");
    expect(git(fixture.repo, "show", `${value.integration.branch}:first.txt`)).toBe("attempt 1");
    expect(git(fixture.repo, "show", `${value.integration.branch}:second.txt`)).toBe("attempt 2");
    expect(git(fixture.repo, "rev-list", "--count", `${fixture.base}..${value.integration.branch}`)).toBe("1");
    expect(git(fixture.repo, "log", "-1", "--format=%B", value.integration.branch)).toMatch(/Omr-Attempt: plan-a\/T1\/2\//);
    await executor.runtime.settled();
    // A successful commit normally drops WIP itself. Re-pin the saved snapshot as a recovery residue so purge's
    // deletion assertion is not vacuous (it must remove a ref that actually exists at the purge boundary).
    git(fixture.repo, "update-ref", wipRef, wip);
    expect(git(fixture.repo, "rev-parse", "--verify", wipRef)).toBe(wip);
    await executor.runtime.purge("plan-a", "root");
    expect(git(fixture.repo, "for-each-ref", "--format=%(refname)", wipRef)).toBe("");
    expect(await executor.deps.store.list()).toEqual([]);
  }, TEST_MS);

  it("A15: compile then move the real base branch; approval fails before plan-approved or an integration ref", async () => {
    const fixture = await repository();
    await configure(fixture.root, fixture.slotsRoot);
    const path = join(fixture.repo, "PLAN.md");
    await writeFile(path, [
      "# Stale base plan", "", "Implement the result on the compiled main tip.", "",
      "### Phase 1.1 Work", "", "**Tasks**",
      "- **1.1.1** `[tier:fast]` Implement `result.txt`.", "  Writes: `result.txt`", "",
    ].join("\n"));
    git(fixture.repo, "add", "PLAN.md");
    git(fixture.repo, "commit", "-qm", "plan input");
    const compiledBase = git(fixture.repo, "rev-parse", "HEAD");
    const plugin = await boot(fixture.repo), executor = built(plugin);
    await executor.runtime.compile({ path, sessionID: "root" });
    const ids = await executor.deps.store.list();
    expect(ids).toHaveLength(1);
    const planId = ids[0]!.planId;
    const draft = await executor.deps.store.read(planId);
    expect(draft.repo.baseBranch).toBe("main");
    expect(draft.repo.baseCommit).toBe(compiledBase);
    expect(draft.status).toBe("awaiting-approval");
    expect(Object.keys(draft.tasks)).toHaveLength(1);
    await writeFile(join(fixture.repo, "moved.txt"), "main moved after compile\n");
    git(fixture.repo, "add", "moved.txt");
    git(fixture.repo, "commit", "-qm", "move base");
    const moved = git(fixture.repo, "rev-parse", "refs/heads/main");
    expect(moved).not.toBe(compiledBase);
    await expect(executor.runtime.approve(planId, "root")).rejects.toMatchObject({
      code: "E_STALE_BASE", message: expect.stringContaining(`${compiledBase}→${moved}`),
    });
    expect((await executor.deps.store.read(planId)).status).toBe("awaiting-approval");
    expect((await executor.deps.store.exportPlan(planId)).events.filter(event => event.type === "plan-approved")).toEqual([]);
    expect(git(fixture.repo, "for-each-ref", "--format=%(refname)", `refs/heads/${draft.integration.branch}`)).toBe("");
    expect(executor.deps.launcher.inFlight()).toEqual([]);
  }, TEST_MS);

  it("A16: the runner's whole prompt starts with the header then read-cap line, parsed by the real router as 12", async () => {
    const fixture = await repository();
    const tracked = await configure(fixture.root, fixture.slotsRoot);
    const value = plan(fixture);
    value.sharedContext = "Historical dispatch example: CAP:none. This quoted context is not the executor's read cap.";
    value.tasks.T1 = assemblyTask("T1", {
      footprint: { writes: ["result.txt"], reads: [], confidence: "explicit", sources: ["path"] },
    });
    await seed(fixture, value);
    const child = scriptedRunner(tracked.clock);
    const plugin = await boot(fixture.repo, child.runner), executor = built(plugin);
    child.setEmitter(plugin.emit, executor.deps.hosts);
    child.capture();
    await executor.runtime.approve("plan-a", "root");
    executor.runtime.onRouterToolCall("root");
    await waitForCalls(child, executor, 1);
    const prompt = child.calls[0]!.prompt;
    const lines = prompt.split(/\r?\n/);
    expect(lines[0]).toBe("PLAN CONTEXT");
    expect(lines[1]).toBe("CAP:12");
    expect(prompt).toContain(value.sharedContext);
    expect(prompt.indexOf("CAP:12")).toBeLessThan(prompt.indexOf("CAP:none"));
    expect(parseCapDirective(prompt)).toBe(12);
  }, TEST_MS);

  /**
   * One guarded call of a plan child through the plugin's real tool hooks (the ones the v2 adapter forwards each call to): the
   * before-hook decides; an allowed call then runs, and its after-hook records it, as the host's every executed call is.
   */
  async function guardedCall(plugin: Awaited<ReturnType<typeof boot>>, sessionID: string, tool: string, n: number) {
    const args = tool === "read" ? { filePath: `notes-${n}.txt` } : { filePath: "budget.txt", oldString: `old-${n}`, newString: `new-${n}` };
    const input = { tool, sessionID, callID: `guarded-${n}`, agent: "implementer" };
    try {
      await plugin.hooks["tool.execute.before"]!(input, { args });
    } catch (error) {
      return { allowed: false, message: String(error), output: "" };
    }
    const result = { title: tool, output: `${tool} ${n} done`, metadata: {} };
    await plugin.hooks["tool.execute.after"]!({ ...input, args }, result);
    return { allowed: true, message: "", output: result.output };
  }

  it("QA-PDF21-2-11: a budget resume opens a new guard round, so the resumed child's guarded calls are allowed again", async () => {
    const fixture = await repository();
    const tracked = await configure(fixture.root, fixture.slotsRoot);
    const value = plan(fixture);
    value.tasks.T1 = assemblyTask("T1", {
      footprint: { writes: ["budget.txt"], reads: [], confidence: "explicit", sources: ["path"] },
    });
    await seed(fixture, value);
    let plugin: Awaited<ReturnType<typeof boot>> | null = null;
    let n = 0;
    const rounds: Array<{ allowed: number; refusal: string }> = [];
    const child = scriptedRunner(tracked.clock, async (request, sessionID) => {
      if (request.resumeSessionID === undefined) {
        // Producing calls only (no read cap, no read/draft stop): the first refusal is the per-dispatch budget's. Each allowed
        // call is charged by the after-hook (`guardAfterCall`), as each call the host runs is.
        let allowed = 0, refusal = "";
        while (allowed < 400) {
          const result = await guardedCall(plugin!, sessionID, "edit", ++n);
          if (!result.allowed) { refusal = result.message; break; }
          allowed += 1;
        }
        rounds.push({ allowed, refusal });
        return "NEED MORE: budget";
      }
      const result = await guardedCall(plugin!, sessionID, "edit", ++n);
      rounds.push({ allowed: result.allowed ? 1 : 0, refusal: result.message });
      return "DONE: finished";
    });
    plugin = await boot(fixture.repo, child.runner);
    const executor = built(plugin);
    child.setEmitter(plugin.emit, executor.deps.hosts);
    child.capture();
    await executor.runtime.approve("plan-a", "root");
    executor.runtime.onRouterToolCall("root");
    await vi.waitFor(() => expect(rounds).toHaveLength(2), { timeout: WAIT_MS });
    // The first round spent its budget and was refused; the resume is the same child, attempt and nonce.
    expect(rounds[0]!.allowed).toBeGreaterThan(0);
    expect(rounds[0]!.allowed).toBeLessThan(400);
    expect(rounds[0]!.refusal).not.toBe("");
    // The per-dispatch budget refused it (CLAUSE 3), not the cumulative ceiling, which a new round does not reset.
    expect(rounds[0]!.refusal).toMatch(/DENIED: tool-call budget \d+ exhausted/);
    expect(child.calls[1]?.resumeSessionID).toBe(child.sessions[0]);
    // Without a new guard round the resumed child's first call meets the exhausted budget again.
    expect(rounds[1], JSON.stringify(rounds)).toEqual({ allowed: 1, refusal: "" });
  }, TEST_MS);

  it("QA-PDF21-2-20: an editing plan child's read-only calls are capped at the executor's CAP:12 line", async () => {
    const fixture = await repository();
    const tracked = await configure(fixture.root, fixture.slotsRoot);
    const value = plan(fixture);
    value.tasks.T1 = assemblyTask("T1", {
      footprint: { writes: ["budget.txt"], reads: [], confidence: "explicit", sources: ["path"] },
    });
    await seed(fixture, value);
    let plugin: Awaited<ReturnType<typeof boot>> | null = null;
    let n = 0;
    const outcome: { reads: number; refusedTool: string; refusal: string; banners: string[] } = { reads: -1, refusedTool: "", refusal: "", banners: [] };
    const gate = childGate();
    const child = scriptedRunner(tracked.clock, async (request, sessionID) => {
      let reads = 0;
      // Three reads, then one producing call (the producer's read/draft stop never fires), up to one read past the cap. The read
      // cap is the session store's read-only counter, as a routed role child's (QA-P21-2-3): each read's result carries its
      // banner (`[cap: n/12]`, `CAP REACHED`); the guard refuses no read for it.
      while (reads < 13) {
        const tool = n % 4 === 3 ? "edit" : "read";
        const result = await guardedCall(plugin!, sessionID, tool, n++);
        if (!result.allowed) { outcome.refusedTool = tool; outcome.refusal = result.message; break; }
        if (tool === "read") { reads += 1; outcome.banners.push(result.output); }
      }
      outcome.reads = reads;
      await gate.wait(request.signal);
      return "DONE: read";
    });
    plugin = await boot(fixture.repo, child.runner);
    const executor = built(plugin);
    child.setEmitter(plugin.emit, executor.deps.hosts);
    child.capture();
    await executor.runtime.approve("plan-a", "root");
    executor.runtime.onRouterToolCall("root");
    await vi.waitFor(() => expect(outcome.reads).toBeGreaterThanOrEqual(0), { timeout: WAIT_MS });
    expect(parseCapDirective(child.calls[0]!.prompt)).toBe(12);
    const shown = JSON.stringify(outcome);
    expect(outcome, shown).toMatchObject({ reads: 13, refusedTool: "", refusal: "" });
    // Without the executor's cap the child has no read-only counter: its reads carry no banner at all.
    expect(outcome.banners[0], shown).toContain("[cap: 1/12]");
    expect(outcome.banners[10], shown).toContain("[cap: 11/12]");
    expect(outcome.banners[10], shown).toContain("CAP WARNING: 1 read-only call(s) remaining");
    expect(outcome.banners[11], shown).toContain("CAP REACHED (12/12)");
    expect(outcome.banners[12], shown).toContain("CAP REACHED (13/12)");
    gate.release();
  }, TEST_MS);
});
