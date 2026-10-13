// Plan task 3.1.8 (wiring half): the real v2-client (`createV2Runtime`), launcher (src/executor/launch.ts) and runtime
// (src/executor/runtime.ts) behind `registerV2Hooks` (src/compat/v2-hooks.ts, `options.executor`).
//
// Doubles: IntegrationQueue, UnattendedPolicy, QaLoop (collaborators), SlotPool, RouteResolver (synchronous), SlotVerifier, GitRunner,
// the lease registry port. Real: LedgerStore (temp dir), Scheduler, CapacityController, TaskLauncher, ExecutorRuntime, the child runner.
//
// Flow: a running ledger is created with the real store; runtime.start() attaches it; the orchestrator's router tool call
// (`runtime.withToolContext`) captures its context, lifts guard 6 and wakes the runtime; the launcher starts the child through the
// v2 child runner, whose native `subagent` tool is the stub below (the same seam as `ctx.tool.list()`). The stub observes the binding of
// the child BEFORE its first tool call.
//
// "routerDecisionRows": rows the dispatch router writes in its `subagent` tool hooks. A retained launch fires none (the native tool is
// called from `ctx.tool.list()`, not through the host's tool pipeline), so the test counts the `subagent` hook calls it made (0) and
// asserts the child's binding is an executor binding (`decisionID === null`, `kind: "exact"`). "Executor row":
// `DispatchBookkeeping.decisionRow`, called once per launch.
//
// Child session ids are unique per native call: the binding registry is process-wide and the launcher's release evicts (tombstones,
// binding.ts `evict`) a finished child, so an id reused by a later test could never be bound again.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { Hooks } from "@opencode-ai/plugin";
import { registerV2Hooks, type V2ExecutorFactory } from "../../src/compat/v2-hooks";
import { createV2Runtime } from "../../src/compat/v2-client";
import { createCapacityController } from "../../src/executor/capacity";
import { createLedgerStore, createNodeClock } from "../../src/executor/ledger";
import { createTaskLauncher } from "../../src/executor/launch";
import { createExecutorRuntime, type LeaseRegistryPort } from "../../src/executor/runtime";
import { createScheduler } from "../../src/executor/schedule";
import {
  executorDefaults, type DispatchBookkeeping, type GitRunner, type IntegrationQueue, type LaunchRequest, type PlanCompiler,
  type QaLoop, type RouteResolver, type Scheduler, type SlotLease, type SlotPool, type SlotVerifier, type UnattendedPolicy,
} from "../../src/executor/types";
import { currentBinding } from "../../src/routing/roles/binding";
import { invalidateConfigCache } from "../../src/router/config";
import { buildDraft, holderOf, taskNode } from "../fixtures/cpx/ledger/builders";
import { removeDirWhenReleased } from "../helpers/remove-dir";

const PLAN = "plan-one";
const ORCHESTRATOR = "root";

/** Paths compared case- and separator-insensitively (the binding stores a normalised root). */
const norm = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

interface Rig {
  home: string;
  slotPath: string;
  log: string[];
  /** Child session ids the native stub created, in order. */
  children: string[];
  /** The task ids of every ready set the real scheduler returned, in order (what a tick could launch). */
  readySets: string[][];
  nativeCalls: Array<{ prompt: string; agent: string; child: string }>;
  hookCalls: Array<{ tool: string; sessionID: string }>;
  bookkeeping: { decisionRow: LaunchRequest[]; dispatchStart: number; registerInFlight: Array<string | null>; unregisterInFlight: number };
  firstToolBinding: ReturnType<typeof currentBinding>;
  firstToolRefusal: string | null;
  toolHooks: Record<string, (event: never) => Promise<void>>;
  runtime: ReturnType<typeof createV2Runtime>;
  executor: { value: ReturnType<V2ExecutorFactory> };
  capture(callID: string): Promise<void>;
  /** The adapter's cleanup (W7), once; `cleanup` calls it too. */
  disposeHooks(): Promise<void>;
  cleanup(): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  invalidateConfigCache();
});

async function boot(): Promise<Rig> {
  const home = mkdtempSync(join(tmpdir(), "omr-v2-exec-"));
  const slotsDir = join(home, "slots");
  const slotPath = join(slotsDir, "slot-1");
  const toplevel = join(home, "repo");
  mkdirSync(slotPath, { recursive: true });
  mkdirSync(toplevel, { recursive: true });
  const clock = createNodeClock();

  // ---- the ledger: one running plan with one ready-to-promote task, written through the real store
  const store = createLedgerStore({ home });
  const draft = buildDraft(1, PLAN);
  draft.orchestrator = { sessionID: ORCHESTRATOR, boundAt: draft.orchestrator.boundAt };
  draft.repo = { ...draft.repo, toplevel };
  draft.integration = { ...draft.integration, worktree: join(slotsDir, "integration") };
  draft.config = { ...draft.config, slotsDir };
  draft.tasks.T1 = taskNode("T1", { route: { line: "[route needs=edit]", role: "implementer", tier: "fast", pin: false } });
  const writer = await store.create(draft, holderOf(ORCHESTRATOR, process.pid, hostname()));
  await writer.close();

  const rig: Rig = {
    home, slotPath, log: [], children: [], readySets: [], nativeCalls: [], hookCalls: [],
    bookkeeping: { decisionRow: [], dispatchStart: 0, registerInFlight: [], unregisterInFlight: 0 },
    firstToolBinding: undefined, firstToolRefusal: null,
    toolHooks: {}, runtime: undefined as never, executor: { value: null }, capture: async () => undefined,
    disposeHooks: async () => undefined, cleanup: async () => undefined,
  };

  // ---- the fake host context
  const sessionHooks: Record<string, (event: never) => Promise<void>> = {};
  const messages = new Map<string, unknown[]>();
  const reg = async () => ({ dispose: async () => undefined });
  const editors = {
    agent: { update: (_id: string, _apply: unknown) => undefined },
    command: { add: (_command: unknown) => undefined },
    tool: { add: (_definition: unknown) => undefined },
  };
  const eventQueue: unknown[] = [];
  let wake = (): void => undefined;
  let native: { execute(args: { prompt: string; agent: string }, tctx: { signal: AbortSignal; progress(m: Record<string, unknown>): Promise<void> }): Promise<unknown> };
  const ctx = {
    location: { directory: toplevel, project: { directory: toplevel } },
    agent: { reload: async () => undefined, list: async () => ({ data: [] }), transform: async (cb: (e: unknown) => void) => { cb(editors.agent); return reg(); } },
    command: { reload: async () => undefined, transform: async (cb: (e: unknown) => void) => { cb(editors.command); return reg(); } },
    tool: {
      transform: async (cb: (e: unknown) => void) => { cb(editors.tool); return reg(); },
      hook: async (name: string, cb: (event: never) => Promise<void>) => { rig.toolHooks[name] = cb; return reg(); },
      list: async () => [{ id: "subagent", execute: (args: { prompt: string; agent: string }, tctx: Parameters<typeof native.execute>[1]) => native.execute(args, tctx) }],
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => (sessionID === ORCHESTRATOR ? { id: sessionID } : { id: sessionID, parentID: ORCHESTRATOR, agent: "fast" }),
      update: async () => undefined,
      context: async ({ sessionID }: { sessionID: string }) => messages.get(sessionID) ?? [],
      prompt: async () => undefined,
      synthetic: async () => undefined,
      interrupt: async () => undefined,
      move: async () => undefined,
      hook: async (name: string, cb: (event: never) => Promise<void>) => { sessionHooks[name] = cb; return reg(); },
    },
    permission: { hook: async () => reg() },
    event: {
      subscribe: async function* ({ signal }: { signal: AbortSignal }) {
        signal.addEventListener("abort", () => wake(), { once: true });
        while (!signal.aborted) {
          if (eventQueue.length > 0) yield eventQueue.shift();
          else await new Promise<void>((resolve) => { wake = resolve; });
        }
      },
    },
  };

  // ---- the native `subagent` stub: creates the child, observes its binding before its first tool call, then runs until aborted
  native = {
    async execute(args, tctx) {
      const child = `child-${randomUUID().slice(0, 8)}-${rig.nativeCalls.length + 1}`;
      rig.children.push(child);
      rig.nativeCalls.push({ prompt: args.prompt, agent: args.agent, child });
      messages.set(child, [{ role: "user", content: [{ type: "text", text: args.prompt }] }]);
      await tctx.progress({ sessionID: child }); // the runner binds the child (onCreated) before this resolves
      rig.firstToolBinding = currentBinding(child, { maxOf: () => [] });
      rig.log.push("first-tool-call");
      rig.hookCalls.push({ tool: "read", sessionID: child });
      try {
        await rig.toolHooks["execute.before"]?.({ sessionID: child, agent: "fast", messageID: "m-child", id: `call-${child}`, tool: "read", input: { filePath: join(slotPath, "a.ts") } } as never);
      } catch (error) {
        rig.firstToolRefusal = error instanceof Error ? error.message : String(error);
      }
      await new Promise<never>((_resolve, reject) => {
        tctx.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      return undefined;
    },
  };

  const v2 = createV2Runtime(ctx as unknown as Parameters<typeof createV2Runtime>[0], { bootID: "0123456789abcdef" });
  rig.runtime = v2;

  // ---- the doubles
  const route: RouteResolver = {
    route: () => ({ agent: "fast", model: { providerID: "prov", modelID: "model-a", variant: null }, provider: "prov", heavy: false }),
  };
  const slots: SlotPool = {
    acquire: async (planId, owner, commit): Promise<SlotLease> => ({ slot: "slot-1", path: slotPath, planId, owner, commit }),
    acquireSpecial: async (planId, kind): Promise<SlotLease> => ({ slot: `special-${kind}`, path: join(slotsDir, kind), planId, owner: kind, commit: "" }),
    reset: async () => undefined,
    cleanForChecks: async () => undefined,
    release: async () => undefined,
    get: async () => null,
    list: async () => [],
    gc: async () => ({ removed: [], reported: [] }),
  };
  const verifier: SlotVerifier = { verify: async () => ({ verdict: "pass", findings: "", ref: "double" }) };
  const git: GitRunner = {
    run: async (args) => {
      const out = { signal: null, truncated: false, durationMs: 0, stderr: "" };
      if (args[0] === "worktree") return { ...out, code: 0, stdout: `worktree ${toplevel}\n` };
      if (args[0] === "config") return { ...out, code: 1, stdout: "" }; // core.longpaths unset
      return { ...out, code: 0, stdout: "" };
    },
  };
  const registryPort: LeaseRegistryPort = { acquireWrite: () => ({ ok: true }), releaseTask: () => undefined, holderOf: () => null };
  const unexpected = (what: string) => async (): Promise<never> => { throw new Error(`double: ${what} is not expected in this test`); };
  const queue: IntegrationQueue = {
    enqueue: () => undefined, resume: async () => ({ steps: [] } as never), checkPhase: async () => undefined,
    land: async () => ({ landed: false, inbox: null }), abort: async () => undefined, queued: () => [], dispose: async () => undefined,
  };
  const policy: UnattendedPolicy = {
    raise: unexpected("policy.raise"), park: unexpected("policy.park"), answer: unexpected("policy.answer"),
    unblock: async () => [], recordAttempt: async () => ({ tripped: false }),
  };
  const qa: QaLoop = {
    parse: () => ({ ok: false, error: "double" }), onQaResult: unexpected("qa.onQaResult"), onAwaitingQa: async () => undefined,
    onCapAnswer: unexpected("qa.onCapAnswer"),
  };
  const compiler: PlanCompiler = {
    compile: unexpected("compiler.compile"), mergeResidue: () => { throw new Error("double: mergeResidue"); },
    addTasks: () => { throw new Error("double: addTasks"); }, validate: () => [],
  };

  // ---- the factory: the real launcher and runtime over the host adapters v2-hooks built
  const factory: V2ExecutorFactory = (host) => {
    if (host.runner === null) throw new Error("the v2 runtime has no child runner");
    const spied: DispatchBookkeeping = {
      decisionRow: (req) => { rig.bookkeeping.decisionRow.push(req); host.bookkeeping.decisionRow(req); },
      recordDispatchStart: (req, startedAt) => { rig.bookkeeping.dispatchStart += 1; host.bookkeeping.recordDispatchStart(req, startedAt); },
      registerInFlight: (taskId, attempt, child) => { rig.bookkeeping.registerInFlight.push(child); host.bookkeeping.registerInFlight(taskId, attempt, child); },
      unregisterInFlight: (taskId, attempt) => { rig.bookkeeping.unregisterInFlight += 1; host.bookkeeping.unregisterInFlight(taskId, attempt); },
    };
    const launcher = createTaskLauncher({
      runner: host.runner, hosts: host.hosts,
      bindings: {
        bind: (i) => {
          rig.log.push("bind");
          try {
            host.bindings.bind(i);
          } catch (error) {
            rig.log.push(`bind-failed: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
          }
        },
        evict: (child) => host.bindings.evict(child),
      },
      bookkeeping: spied, clock, lifetime: host.lifetime, knownAgent: host.knownAgent,
      onMetric: (planId, m) => host.onLauncherMetric(planId, m),
    });
    // The real scheduler, observed: each ready set it returns is recorded (a tick launches only what is in it).
    const real = createScheduler();
    const scheduler: Scheduler = {
      readySet: (ledger, inFlight, leases, capacity) => {
        const ready = real.readySet(ledger, inFlight, leases, capacity);
        rig.readySets.push(ready.map((item) => item.taskId));
        return ready;
      },
      promotable: (ledger) => real.promotable(ledger),
      manualReady: (ledger) => real.manualReady(ledger),
      addLearnedEdge: (ledger, holder, blocked, evidence) => real.addLearnedEdge(ledger, holder, blocked, evidence),
    };
    const runtime = createExecutorRuntime({
      store, compiler, slots, scheduler, launcher, routes: route, verifier, git, hosts: host.hosts, clock,
      leaseRegistry: registryPort, recovery: null,
      holder: (sessionID) => holderOf(sessionID, process.pid, hostname()),
      capacity: (o) => createCapacityController(o),
      collaborators: () => ({ queue, policy, qa }),
      pinOrchestrator: (sessionID) => host.pinOrchestrator(sessionID),
      log: (level, msg) => { rig.log.push(`${level}: ${msg}`); },
      config: () => executorDefaults(),
      // QA-4.2-23: the same binding port as the launcher's (recovery re-binds adopted children through it).
      bindings: host.bindings,
      // QA-4.2 NEW-1: the process toplevel is required (the plan's own repository here).
      toplevel,
    });
    const built = { runtime, launcher };
    rig.executor.value = built;
    return built;
  };

  const hooks = { config: async (cfg: { agent: Record<string, unknown> }) => { cfg.agent.fast = { mode: "subagent" }; } } as unknown as Hooks;
  const cleanupHooks = await registerV2Hooks(ctx as unknown as Context, hooks, v2, { executor: factory });
  rig.capture = async (callID) => {
    const toolContext = { sessionID: ORCHESTRATOR, id: callID, messageID: `m-${callID}`, agent: "build", signal: new AbortController().signal, progress: async () => undefined };
    await v2.withToolContext(toolContext as unknown as Parameters<typeof v2.withToolContext>[0], async () => undefined);
  };
  let hooksDisposed: Promise<void> | null = null;
  rig.disposeHooks = () => (hooksDisposed ??= cleanupHooks());
  rig.cleanup = async () => {
    await rig.disposeHooks();
    await removeDirWhenReleased(home);
    rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  };
  cleanups.push(rig.cleanup);
  return rig;
}

describe("plan executor launch through the real v2 client (3.1.7 wiring, integration)", () => {
  it("binds the child with its role and root = slot before its first tool call; one executor row, no router decision row", async () => {
    const rig = await boot();
    const built = rig.executor.value;
    if (built === null) throw new Error("the factory was not called");
    await rig.capture("call-orchestrator-1");
    await vi.waitFor(() => expect(rig.nativeCalls).toHaveLength(1), { timeout: 10_000 });
    await vi.waitFor(() => expect(rig.log).toContain("first-tool-call"), { timeout: 10_000 });
    const child = rig.children[0];

    // bound once, before the first tool call, with role and root = slot
    expect(rig.log.filter((entry) => entry === "bind")).toHaveLength(1);
    expect(rig.log.filter((entry) => entry.startsWith("bind-failed"))).toEqual([]);
    expect(rig.log.indexOf("bind")).toBeLessThan(rig.log.indexOf("first-tool-call"));
    const binding = rig.firstToolBinding;
    expect(binding).toBeDefined();
    expect(binding?.childSessionID).toBe(child);
    expect(binding?.role).toBe("implementer");
    expect(norm(binding?.grant.workRoot ?? "")).toBe(norm(rig.slotPath));
    expect(binding?.plan).toMatchObject({ planId: PLAN, taskId: "T1", attempt: 1 });
    expect(binding?.kind).toBe("exact");
    expect(binding?.decisionID).toBeNull(); // not a router dispatch decision
    // the fail-closed check (M41) did not refuse this bound plan child
    expect(rig.firstToolRefusal ?? "").not.toMatch(/no matching plan binding/);

    // routerDecisionRows === 0 from hooks: the retained launch fired no `subagent` hook; exactly one executor row
    const routerDecisionRows = rig.hookCalls.filter((c) => c.tool === "subagent").length;
    expect(routerDecisionRows).toBe(0);
    expect(rig.bookkeeping.decisionRow).toHaveLength(1);
    expect(rig.bookkeeping.decisionRow[0]).toMatchObject({ planId: PLAN, taskId: "T1", attempt: 1, orchestratorSessionID: ORCHESTRATOR, role: "implementer" });
    expect(rig.bookkeeping.dispatchStart).toBe(1);
    expect(rig.bookkeeping.registerInFlight).toEqual([null, child]);

    // the launch prompt is the plan header; the agent is the resolved route's
    expect(rig.nativeCalls[0]?.prompt.startsWith("PLAN CONTEXT\n")).toBe(true);
    expect(rig.nativeCalls[0]?.agent).toBe("fast");

    await built.runtime.abort(PLAN, ORCHESTRATOR);
    await built.runtime.settled();
  }, 30_000);

  it("launches no task twice: further router calls of the orchestrator (new captures) re-run the ready set but start nothing", async () => {
    const rig = await boot();
    const built = rig.executor.value;
    if (built === null) throw new Error("the factory was not called");
    await rig.capture("call-orchestrator-1");
    await vi.waitFor(() => expect(rig.nativeCalls).toHaveLength(1), { timeout: 10_000 });
    await vi.waitFor(() => expect(rig.log).toContain("first-tool-call"), { timeout: 10_000 });

    // T1 was ready before its launch (a ready set before the first router call is gated, guard 6, and launches nothing).
    expect(rig.readySets.some((ids) => ids.includes("T1"))).toBe(true);
    const before = rig.readySets.length;
    for (const id of ["call-orchestrator-2", "call-orchestrator-3"]) {
      await rig.capture(id);
      built.runtime.onRouterToolCall(ORCHESTRATOR);
    }
    // `runtime.settled()` is not usable here: it also waits for the live child's completion, which settles only when the child
    // ends. The new captures re-run the ready set instead; a tick launches only what its ready set holds, and every one is empty.
    await vi.waitFor(() => expect(rig.readySets.length).toBeGreaterThan(before), { timeout: 10_000 });
    expect(rig.readySets.slice(before).filter((ids) => ids.length > 0)).toEqual([]);

    expect(rig.nativeCalls).toHaveLength(1);
    expect(rig.children).toHaveLength(1);
    expect(rig.log.filter((entry) => entry === "bind")).toHaveLength(1);
    expect(rig.log.filter((entry) => entry.startsWith("bind-failed"))).toEqual([]);
    expect(rig.bookkeeping.decisionRow).toHaveLength(1);
    expect(rig.bookkeeping.dispatchStart).toBe(1);
    expect(rig.bookkeeping.registerInFlight.filter((c) => c === null)).toHaveLength(1);

    await built.runtime.abort(PLAN, ORCHESTRATOR);
    await built.runtime.settled();
  }, 30_000);

  it("disposing the adapter while a plan child is live returns without waiting for the child (W7)", async () => {
    const rig = await boot();
    await rig.capture("call-orchestrator-1");
    await vi.waitFor(() => expect(rig.log).toContain("first-tool-call"), { timeout: 10_000 });
    // the child runs until it is aborted: dispose aborts it through the launcher and never waits for its end
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hung = new Promise<"hung">((resolve) => { timer = setTimeout(() => resolve("hung"), 8_000); });
    try {
      const outcome = await Promise.race([rig.disposeHooks().then(() => "disposed" as const), hung]);
      expect(outcome).toBe("disposed");
    } finally {
      clearTimeout(timer);
    }
  }, 30_000);
});
