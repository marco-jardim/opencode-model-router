// Phase 2.2 (M7): dispatch-time routing on OpenCode v2. The kernel (1.4) is wired into the adapter's execute.before and
// context hook; these tests drive the real `registerV2Hooks` over a fake v2 context, a real outcome store (A3 bundle) and
// real config files. Temp directories only: HOME and the outcomes path are redirected, nothing touches the user's files.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { Hooks } from "@opencode-ai/plugin";
import { registerV2Hooks, v2Instructions } from "../../src/compat/v2-hooks";
import { V2_GRADER_AGENT, createV2Runtime, type V2Runtime } from "../../src/compat/v2-client";
import { createAttemptRecorder } from "../../src/escalate/attempt-recorder";
import type { AttemptPlan } from "../../src/escalate/resume";
import { invalidateConfigCache, loadConfig, overridePath } from "../../src/router/config";
import { assembleSystemPrompt, buildTaskTaxonomy } from "../../src/router/protocol";
import {
  dispatchCount, lastStepContext, lookupDispatch, markRunnerDispatch, noteExecutionEnded, noteStepContext, rememberDispatch, resetDispatchRegistry,
  resetRunnerTokens, runnerTokenCount,
} from "../../src/router/sessions";
import { resetDispatchRouting } from "../../src/routing/wire/dispatch";
import { acquireOutcomes, DEFAULT_OUTCOME_TUNING, DEFAULT_OUTCOMES_DIRNAME, makeKey } from "../../src/routing/outcomes";
import { RESUME_NAMED_NEEDS_REASON, RESUME_NAMED_NEVER_DOWN_REASON, RESUME_REASON } from "../../src/routing/outcomes/types";
import type { DecisionRow, OutcomesBundle } from "../../src/routing/outcomes/types";
import { resetIngestState } from "../../src/routing/outcomes/ingest";
import { summarize } from "../../src/routing/outcomes/stats";

const logger = { warn: vi.fn() };

const SONNET = "anthropic/claude-sonnet-5-5";
const OPUS = "anthropic/claude-opus-5-5";
const HAIKU = "anthropic/claude-haiku-4-5";
const ALLOW_ALL = [{ action: "*", resource: "*", effect: "allow" }];
const READ_ONLY = [
  { action: "*", resource: "*", effect: "deny" },
  ...["glob", "grep", "read", "webfetch", "websearch"].map((action) => ({ action, resource: "*", effect: "allow" })),
];

const KEYS = {
  medium: makeKey("implement", { origin: "router", id: "medium" }, "anthropic", "claude-sonnet-5-5", "medium"),
  heavy: makeKey("implement", { origin: "router", id: "heavy" }, "anthropic", "claude-opus-5-5", "xhigh"),
  fast: makeKey("search", { origin: "router", id: "fast" }, "anthropic", "claude-sonnet-5-5", "low"),
  explore: makeKey("search", { origin: "host", id: "explore" }, "anthropic", "claude-haiku-4-5", "default"),
  reconFast: makeKey("recon", { origin: "router", id: "fast" }, "anthropic", "claude-sonnet-5-5", "low"),
  reconExplore: makeKey("recon", { origin: "host", id: "explore" }, "anthropic", "claude-haiku-4-5", "default"),
};

interface World {
  home: string;
  outcomes: string;
  ctx: any;
  agents: Record<string, any>;
  session: { current: Record<string, unknown> | Error };
  toolHooks: Record<string, (event: any) => Promise<void>>;
  /** Every registration of a tool hook, one per started instance (A3: the host hands one event to each). */
  allToolHooks: Record<string, Array<(event: any) => Promise<void>>>;
  sessionHooks: Record<string, (event: any) => Promise<void>>;
  emit(event: unknown): void;
  start(legacy?: Record<string, unknown>, runtime?: V2Runtime): Promise<() => Promise<void>>;
  /** What the fake host's native `subagent` tool received, after every registered execute.before hook ran. */
  native: Array<Record<string, any>>;
  bundle: OutcomesBundle;
  seed(key: string, pass: number, fail: number): void;
  rows(): Promise<DecisionRow[]>;
  generate: ReturnType<typeof vi.fn>;
}

const worlds: World[] = [];
const cleanups: Array<() => Promise<void>> = [];

function registry(): Record<string, any> {
  const base = { request: { settings: {}, headers: {}, body: {} }, hidden: false };
  const [sonnetProvider, sonnetId] = SONNET.split("/") as [string, string];
  const [opusProvider, opusId] = OPUS.split("/") as [string, string];
  const [haikuProvider, haikuId] = HAIKU.split("/") as [string, string];
  return {
    build: { ...base, id: "build", mode: "primary", permissions: ALLOW_ALL },
    fast: { ...base, id: "fast", mode: "subagent", model: { providerID: sonnetProvider, id: sonnetId, variant: "low" }, permissions: ALLOW_ALL, description: "fast tier" },
    medium: { ...base, id: "medium", mode: "subagent", model: { providerID: sonnetProvider, id: sonnetId, variant: "medium" }, permissions: ALLOW_ALL, description: "medium tier" },
    heavy: { ...base, id: "heavy", mode: "subagent", model: { providerID: opusProvider, id: opusId, variant: "xhigh" }, permissions: ALLOW_ALL, description: "heavy tier" },
    explore: { ...base, id: "explore", mode: "subagent", model: { providerID: haikuProvider, id: haikuId }, permissions: READ_ONLY, description: "Fast read-only codebase exploration" },
    general: { ...base, id: "general", mode: "subagent", permissions: ALLOW_ALL, description: "General purpose agent" },
  };
}

function catalog() {
  const variants = (...ids: string[]) => ids.map((id) => ({ id }));
  return [
    { providerID: "anthropic", id: "claude-sonnet-5-5", variants: variants("low", "medium", "high"), limit: { context: 200_000, output: 32_000 }, cost: [] },
    { providerID: "anthropic", id: "claude-opus-5-5", variants: variants("low", "medium", "high", "xhigh"), limit: { context: 200_000, output: 32_000 }, cost: [] },
    { providerID: "anthropic", id: "claude-haiku-4-5", variants: variants("high", "max"), limit: { context: 200_000, output: 32_000 }, cost: [] },
  ];
}

/** `routing: null` writes no routing block at all; `extra` is merged into the override file. */
async function makeWorld(routing: Record<string, unknown> | null, extra: Record<string, unknown> = {}): Promise<World> {
  const home = mkdtempSync(join(tmpdir(), "router-dispatch-"));
  const outcomes = join(home, "outcomes");
  mkdirSync(outcomes, { recursive: true });
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  mkdirSync(dirname(overridePath()), { recursive: true });
  writeFileSync(overridePath(), JSON.stringify({
    enforcement: { verify: { testBaseline: false } },
    ...extra,
    ...(routing === null ? {} : { routing: { outcomes: { path: outcomes }, ...routing } }),
  }));
  invalidateConfigCache();
  resetDispatchRegistry();
  resetDispatchRouting();
  resetRunnerTokens();
  resetIngestState();

  const agents = registry();
  const session: World["session"] = {
    current: {
      id: "root", agent: "build", model: { providerID: "anthropic", id: "claude-opus-5-5", variant: "xhigh" },
      permissions: [{ action: "subagent", resource: "*", effect: "allow" }], location: { directory: home },
    },
  };
  const toolHooks: World["toolHooks"] = {};
  const allToolHooks: World["allToolHooks"] = {};
  const sessionHooks: World["sessionHooks"] = {};
  const queue: unknown[] = [];
  const wakers = new Set<() => void>(); // one per subscriber: two plugin instances may subscribe to the same fake bus
  const wake = () => { for (const resolve of [...wakers]) resolve(); };
  const register = () => ({ dispose: vi.fn(async () => {}) });
  const generate = vi.fn(async () => ({ text: "implement" }));
  const native: World["native"] = [];
  let childSeq = 0;
  /** The host's native subagent tool as the runner reaches it (`ctx.tool.list()`): the host runs the plugin hooks for it too. */
  const hostSubagent = vi.fn(async (input: Record<string, any>, nativeContext: any) => {
    const event: any = { tool: "subagent", input: { ...input }, sessionID: nativeContext.sessionID, agent: nativeContext.agent, messageID: nativeContext.messageID, id: nativeContext.id };
    for (const hook of allToolHooks["execute.before"] ?? []) await hook(event);
    native.push(event.input);
    const resumed = typeof event.input.sessionID === "string" ? event.input.sessionID : null;
    const sessionID = resumed ?? `child-${++childSeq}`;
    await nativeContext.progress({ sessionID, status: "running" }); // the runner registers the child here (onCreated)
    if (resumed === null) wakeEvent({ type: "session.created", data: { sessionID, parentID: nativeContext.sessionID, agent: event.input.agent, title: event.input.description } });
    return { output: { sessionID, status: "completed", output: "done" } };
  });
  const wakeEvent = (event: unknown) => { queue.push(event); wake(); };
  const ctx = {
    location: { directory: home, project: { directory: home } },
    agent: { reload: vi.fn(async () => {}), list: vi.fn(async () => ({ data: Object.values(agents) })), transform: vi.fn(async () => register()) },
    command: { reload: vi.fn(async () => {}), transform: vi.fn(async () => register()) },
    model: { list: vi.fn(async () => ({ data: catalog() })) },
    generate: { text: generate },
    permission: { hook: vi.fn(async () => register()) },
    tool: {
      list: vi.fn(async () => [{ id: "subagent", execute: hostSubagent }]),
      transform: vi.fn(async () => register()),
      hook: vi.fn(async (name: string, cb: any) => { toolHooks[name] = cb; (allToolHooks[name] ??= []).push(cb); return register(); }),
    },
    session: {
      get: vi.fn(async () => { if (session.current instanceof Error) throw session.current; return session.current; }),
      context: vi.fn(async () => [] as unknown[]),
      update: vi.fn(async () => {}),
      prompt: vi.fn(async () => {}), synthetic: vi.fn(async () => {}),
      interrupt: vi.fn(async () => ({ interrupted: true })), remove: vi.fn(async () => {}), move: vi.fn(async () => {}),
      hook: vi.fn(async (name: string, cb: any) => { sessionHooks[name] = cb; return register(); }),
    },
    event: { subscribe: async function* ({ signal }: { signal: AbortSignal }) {
      signal.addEventListener("abort", () => wake(), { once: true });
      while (!signal.aborted) {
        if (queue.length) yield queue.shift();
        else await new Promise<void>((resolve) => { const done = () => { wakers.delete(done); resolve(); }; wakers.add(done); });
      }
    } },
  };
  const bundle = acquireOutcomes({ dir: outcomes, tuning: DEFAULT_OUTCOME_TUNING, logger });
  await bundle.ready;
  const world: World = {
    home, outcomes, ctx, agents, session, toolHooks, allToolHooks, sessionHooks, bundle, generate, native,
    emit(event) { queue.push(event); wake(); },
    async start(legacy = {}, runtime) {
      const cleanup = await registerV2Hooks(ctx as unknown as Context, legacy as unknown as Hooks, runtime);
      cleanups.push(cleanup);
      return cleanup;
    },
    seed(key, pass, fail) {
      for (let i = 0; i < pass; i++) bundle.store.recordVerdict(key as never, "pass", { attemptID: `${key}:p${i}`, step: "dispatch" });
      for (let i = 0; i < fail; i++) bundle.store.recordVerdict(key as never, "fail", { attemptID: `${key}:f${i}`, step: "dispatch" });
    },
    async rows() {
      await bundle.flusher.flushNow();
      return (await bundle.persister.readRows()).rows.filter((row): row is DecisionRow => row.kind === "decision");
    },
  };
  worlds.push(world);
  return world;
}

let seq = 0;
function dispatch(world: World, input: Record<string, unknown>, over: Record<string, unknown> = {}) {
  const event: any = { tool: "subagent", input: { description: "work item", ...input }, sessionID: "root", agent: "build", messageID: "m", id: `call-${++seq}`, ...over };
  return { event, run: () => world.toolHooks["execute.before"](event) };
}

async function routed(world: World, input: Record<string, unknown>, over: Record<string, unknown> = {}) {
  const call = dispatch(world, input, over);
  await call.run();
  return call.event.input as Record<string, any>;
}

/**
 * The fake host's children (QA-2.4-R3-1): what each one runs. A fresh dispatch starts a child on the agent (and model) its final arguments
 * name; a resume that names a DIFFERENT agent switches the child to it and its model becomes that agent's, as the v2.0.22 host does
 * (`switchAgent`, core/src/tool/plugin/subagent.ts:169-176).
 */
const hostChildren = new Map<string, { agent: string; model: string }>();
const modelOfAgent = (world: World, agent: string): string => {
  const model = world.agents[agent]?.model as { providerID: string; id: string; variant?: string } | undefined;
  return model === undefined ? "?" : `${model.providerID}/${model.id}${model.variant === undefined ? "" : `#${model.variant}`}`;
};

async function hostStart(world: World, childID: string, input: Record<string, unknown>) {
  const args = await routed(world, input);
  hostChildren.set(childID, { agent: args.agent as string, model: typeof args.model === "string" ? args.model : modelOfAgent(world, args.agent as string) });
  world.emit({ type: "session.created", data: { sessionID: childID, parentID: "root", agent: args.agent, title: "work item" } });
  await vi.waitFor(() => { expect(lookupDispatch(childID)).toBeDefined(); });
  return { args };
}

async function hostResume(world: World, childID: string, input: Record<string, unknown>) {
  const args = await routed(world, { ...input, sessionID: childID });
  const child = hostChildren.get(childID) ?? { agent: "?", model: "?" };
  const switched = typeof args.agent === "string" && args.agent !== child.agent;
  if (switched) hostChildren.set(childID, { agent: args.agent as string, model: modelOfAgent(world, args.agent as string) });
  return { args, switched, child: { ...(hostChildren.get(childID) ?? child) } };
}
const IMPLEMENT = (extra = "") => `[route class=implement risk=high scope=single${extra}]\nImplement the change in src/a.ts.`;

beforeEach(() => { vi.stubEnv("MODEL_ROUTER_ENFORCE", ""); });

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const world of worlds.splice(0)) {
    await world.bundle.release();
    rmSync(world.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  hostChildren.clear();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  invalidateConfigCache();
  resetDispatchRegistry();
  resetDispatchRouting();
  resetRunnerTokens();
  resetIngestState();
  logger.warn.mockReset();
});

describe("static: byte-identical and silent (§1.2)", () => {
  it("a config with no routing block leaves the call alone, records nothing and writes nothing", async () => {
    const world = await makeWorld(null);
    await world.start();
    const input = { agent: "medium", prompt: `${IMPLEMENT()}\nBody`, background: true, sessionID: "child-9" };
    const after = await routed(world, input);
    expect(after).toEqual({ description: "work item", agent: "medium", prompt: `${IMPLEMENT()}\nBody`, background: true, sessionID: "child-9" });
    expect(lookupDispatch("child-9")).toBeUndefined();
    expect(world.ctx.session.get).not.toHaveBeenCalled();
    expect(world.ctx.model.list).not.toHaveBeenCalled();
    expect(readdirSync(world.outcomes)).toEqual([]);
    expect(existsSync(join(tmpdir(), DEFAULT_OUTCOMES_DIRNAME))).toBe(false);
  });

  it("engine: static with a routing block is the same, and a [route …] line stays in the prompt", async () => {
    const world = await makeWorld({ engine: "static" });
    await world.start();
    const prompt = IMPLEMENT(" pin");
    const after = await routed(world, { agent: "medium", prompt });
    expect(after.prompt).toBe(prompt);
    expect(after.agent).toBe("medium");
    expect(after.model).toBeUndefined();
    expect(world.ctx.session.get).not.toHaveBeenCalled();
    expect(await world.rows()).toEqual([]);
    expect(readdirSync(world.outcomes).filter((name) => name.startsWith("decisions"))).toEqual([]);
  });

  it("the system prompt of a static session is the legacy one, byte for byte", async () => {
    const world = await makeWorld({ engine: "static" });
    const cfg = loadConfig(world.home);
    const protocol = assembleSystemPrompt(cfg, undefined, false);
    await world.start({ "experimental.chat.system.transform": async (_input: unknown, output: { system: string[] }) => { output.system.push(protocol); } });
    const event: any = { sessionID: "root", agent: "build", model: { providerID: "anthropic", id: "claude-opus-5-5" }, options: {}, system: [], messages: [] };
    await world.sessionHooks.context(event);
    expect(event.system.map((part: { text: string }) => part.text)).toEqual([v2Instructions(protocol)]);
  });
});

describe("shadow: log, never change", () => {
  it("logs a decision row (switched = would switch) and leaves agent and model alone; the route line is stripped", async () => {
    const world = await makeWorld({ engine: "shadow", roles: {} });
    world.seed(KEYS.medium, 0, 20);
    world.seed(KEYS.heavy, 20, 0);
    await world.start();
    const after = await routed(world, { agent: "medium", prompt: IMPLEMENT() });
    expect(after.agent).toBe("medium");
    expect(after.model).toBeUndefined();
    expect(after.prompt).toBe("Implement the change in src/a.ts.");
    const rows = await world.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "decision", mode: "shadow", pinned: false, switched: true, step: "dispatch", resume: false, childSessionID: null,
      chosen: { agent: "medium", origin: "router" }, best: { agent: "heavy", origin: "router" },
      facts: { class: "implement", risk: "high", source: "route-line" },
    });
    expect(rows[0]!.trace).toMatchObject({ routeLines: { count: 1, conflict: false }, backend: null });
    expect(Object.keys(rows[0]!.costs).length).toBeGreaterThan(1);
    expect(rows[0]!.unit).toBe("ratio");
    // QA-3.2-12: the reason code leads once; the kernel's own leading word is not repeated
    expect(rows[0]!.reason).toMatch(/^switched: C\(best\)=/);
    expect(rows[0]!.reason).not.toContain("switched: switched");
  });

  it("with no evidence the decision is a kept row whose best is the orchestrator's pick", async () => {
    const world = await makeWorld({ engine: "shadow" });
    await world.start();
    await routed(world, { agent: "medium", prompt: "Implement the change in src/a.ts." });
    const [row] = await world.rows();
    expect(row).toMatchObject({ switched: false, pinned: false, chosen: { agent: "medium" } });
    expect(row!.reason).toMatch(/^kept:/);
    expect(row!.reason).toMatch(/^kept:[a-z-]+: (?!kept: )/); // QA-3.2-12: `kept:best-is-chosen: the chosen dispatch …`, not `kept:best-is-chosen: kept: …`
  });

  it("shadow leaves the system prompt exactly as the legacy hook built it", async () => {
    const world = await makeWorld({ engine: "shadow" });
    world.seed(KEYS.fast, 0, 20);
    world.seed(KEYS.explore, 20, 0);
    const cfg = loadConfig(world.home);
    const protocol = assembleSystemPrompt(cfg, undefined, false);
    await world.start({ "experimental.chat.system.transform": async (_input: unknown, output: { system: string[] }) => { output.system.push(protocol); } });
    const event: any = { sessionID: "root", agent: "build", model: { providerID: "anthropic", id: "claude-opus-5-5" }, options: {}, system: [], messages: [] };
    await world.sessionHooks.context(event);
    expect(event.system.map((part: { text: string }) => part.text)).toEqual([v2Instructions(protocol)]);
  });
});

describe("enforce", () => {
  it("margin satisfied: agent and model are replaced, the legacy hook still sees the final agent, the route line is gone", async () => {
    const world = await makeWorld({ engine: "enforce", roles: {} });
    world.seed(KEYS.medium, 0, 20);
    world.seed(KEYS.heavy, 20, 0);
    const seen: Array<{ subagent_type: unknown; prompt: unknown }> = [];
    await world.start({
      "tool.execute.before": async (_input: unknown, output: { args: Record<string, unknown> }) => {
        seen.push({ subagent_type: output.args.subagent_type, prompt: output.args.prompt });
        output.args.prompt = `[header]\n${String(output.args.prompt)}`;
      },
    });
    const after = await routed(world, { agent: "medium", prompt: IMPLEMENT(), background: true });
    expect(seen).toEqual([{ subagent_type: "heavy", prompt: "Implement the change in src/a.ts." }]);
    expect(after).toMatchObject({ agent: "heavy", model: `${OPUS}#xhigh`, background: true, description: "work item" });
    expect(after.prompt).toBe("[header]\nImplement the change in src/a.ts.");
    expect(after.subagent_type).toBeUndefined();
    const [row] = await world.rows();
    expect(row).toMatchObject({ mode: "enforce", switched: true, pinned: false, chosen: { agent: "medium" }, best: { agent: "heavy" } });
  });

  it("margin not satisfied: the orchestrator's choice stands (kept row)", async () => {
    const world = await makeWorld({ engine: "enforce" });
    await world.start();
    const after = await routed(world, { agent: "medium", prompt: IMPLEMENT() });
    expect(after).toMatchObject({ agent: "medium", prompt: "Implement the change in src/a.ts." });
    expect(after.model).toBeUndefined();
    const [row] = await world.rows();
    expect(row).toMatchObject({ switched: false, mode: "enforce" });
    expect(row!.reason).toMatch(/^kept:/);
  });

  it("QA-3.2-R2-5: an agent that resolves to no model is kept with its own reason code, kept:unresolved, and the dispatch is left alone", async () => {
    for (const engine of ["shadow", "enforce"] as const) {
      const world = await makeWorld({ engine });
      // the orchestrator's own model is unknown and `general` has none of its own: the pick resolves to no model at all
      world.session.current = { id: "root", agent: "build", permissions: [{ action: "subagent", resource: "*", effect: "allow" }], location: { directory: world.home } };
      await world.start();
      const after = await routed(world, { agent: "general", prompt: "Look at the thing." });
      expect(after).toMatchObject({ agent: "general", prompt: "Look at the thing." }); // nothing rewritten, nothing priced
      expect(after.model).toBeUndefined();
      const [row] = await world.rows();
      expect(row, engine).toMatchObject({ mode: engine, switched: false, best: null, chosen: { agent: "general" } });
      expect(row!.reason, engine).toMatch(/^kept:unresolved: the dispatched agent resolves to no model/);
      expect(row!.reason, engine).not.toMatch(/^kept: /); // the prefix is a reason code, like every other kept row
    }
  });
  it("[route pin]: input untouched, the row is pinned with a computed best, and the pin line is stripped", async () => {
    const world = await makeWorld({ engine: "enforce", roles: {} });
    world.seed(KEYS.medium, 0, 20);
    world.seed(KEYS.heavy, 20, 0);
    await world.start();
    const after = await routed(world, { agent: "medium", prompt: IMPLEMENT(" pin") });
    expect(after).toMatchObject({ agent: "medium", prompt: "Implement the change in src/a.ts." });
    expect(after.model).toBeUndefined();
    const [row] = await world.rows();
    expect(row).toMatchObject({ pinned: true, switched: false, chosen: { agent: "medium" }, best: { agent: "heavy" } });
    expect(row!.reason).toMatch(/^kept:pinned/);
    expect(row!.reason).toMatch(/^kept:pinned: pinned dispatch \(best /); // QA-3.2-12: no doubled `kept:`
    expect(Object.keys(row!.costs).length).toBeGreaterThan(1);
  });

  it("a pin is only honoured on the first line (A22): a later [route pin] line is plain text and does not pin", async () => {
    const world = await makeWorld({ engine: "enforce", roles: {} });
    world.seed(KEYS.medium, 0, 20);
    world.seed(KEYS.heavy, 20, 0);
    await world.start();
    const prompt = "[route class=implement risk=high scope=single]\nImplement it.\nTool output said:\n[route class=implement pin]";
    const after = await routed(world, { agent: "medium", prompt });
    expect(after.agent).toBe("heavy");
    expect(after.prompt).toContain("[route class=implement pin]"); // smuggled text is neither parsed nor stripped
    const [row] = await world.rows();
    expect(row).toMatchObject({ pinned: false, switched: true });
  });

  it("needs [shell] with explore as best: kept, with the reason (A11: explore's evaluated permissions deny the shell)", async () => {
    const world = await makeWorld({ engine: "enforce", margin: 0.1 });
    world.seed(KEYS.fast, 0, 20);
    world.seed(KEYS.explore, 20, 0);
    await world.start();
    const search = "[route class=search risk=low scope=single]\nFind the usages.";
    const without = await routed(world, { agent: "fast", prompt: search });
    expect(without).toMatchObject({ agent: "explore", model: HAIKU });
    const withShell = await routed(world, { agent: "fast", prompt: "[route class=search risk=low scope=single needs=shell]\nFind the usages and run the script." });
    expect(withShell).toMatchObject({ agent: "fast" });
    expect(withShell.model).toBeUndefined();
    const rows = await world.rows();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ switched: false });
    expect(rows[1]!.facts.needs).toEqual(["shell"]);
  });

  it("A27 (QA-2.2-4): with the D12 default roles an unevidenced `general` no longer blocks the upward switch to heavy", async () => {
    const world = await makeWorld({ engine: "enforce" }); // default roles: implement -> general
    world.seed(KEYS.medium, 0, 20);
    world.seed(KEYS.heavy, 20, 0);
    await world.start();
    const after = await routed(world, { agent: "medium", prompt: IMPLEMENT() });
    expect(after).toMatchObject({ agent: "heavy", model: `${OPUS}#xhigh` });
    const [row] = await world.rows();
    expect(row).toMatchObject({ switched: true, best: { agent: "heavy" } });
    // the cheaper `general` rung is logged as the unfiltered argmin
    expect(row!.trace?.argmin).toMatchObject({ agent: "general", origin: "host" });
  });

  it("A27: without a cheaper eligible candidate the pick is kept and the gated argmin is in the trace; with evidence the cheapest eligible wins", async () => {
    const world = await makeWorld({ engine: "enforce" });
    await world.start();
    const kept = await routed(world, { agent: "medium", prompt: IMPLEMENT() });
    expect(kept).toMatchObject({ agent: "medium" });
    expect(kept.model).toBeUndefined();
    const general = makeKey("implement", { origin: "host", id: "general" }, "anthropic", "claude-sonnet-5-5", "medium");
    world.seed(general, 20, 0);
    const switched = await routed(world, { agent: "medium", prompt: IMPLEMENT() });
    expect(switched).toMatchObject({ agent: "general", model: `${SONNET}#medium` });
    const rows = await world.rows();
    expect(rows[0]).toMatchObject({ switched: false });
    expect(rows[1]).toMatchObject({ switched: true, best: { agent: "general" } });
    expect(rows[1]!.trace?.argmin).toBeUndefined(); // nothing was filtered: argmin == best
  });
  it("never switches a high-risk dispatch without verification down a rank", async () => {
    const world = await makeWorld({ engine: "enforce", margin: 0, roles: {} });
    world.seed(KEYS.heavy, 0, 20);
    world.seed(KEYS.medium, 20, 0);
    await world.start();
    const after = await routed(world, { agent: "heavy", prompt: "[route class=implement risk=high scope=single]\nImplement it." });
    expect(after.agent).toBe("heavy");
    const [row] = await world.rows();
    expect(row).toMatchObject({ switched: false });
  });

  it("an unrelated field survives the reassignment (background) on a fresh dispatch", async () => {
    const world = await makeWorld({ engine: "enforce", roles: {} });
    world.seed(KEYS.medium, 0, 20);
    world.seed(KEYS.heavy, 20, 0);
    await world.start();
    const after = await routed(world, { agent: "medium", prompt: IMPLEMENT(), background: true });
    expect(after).toMatchObject({ agent: "heavy", background: true });
    const [row] = await world.rows();
    expect(row).toMatchObject({ switched: true, resume: false, childSessionID: null });
  });

  it("A30 (QA-2.4-R2-3): a dispatch that resumes an existing child is never switched, in any mode: args unchanged, kept:resume, registered as dispatched", async () => {
    const world = await makeWorld({ engine: "enforce", roles: {} });
    world.seed(KEYS.medium, 0, 20);
    world.seed(KEYS.heavy, 20, 0); // the same evidence that switches the fresh dispatch above
    await world.start();
    const input = { agent: "medium", prompt: IMPLEMENT(), sessionID: "child-7", background: true };
    const after = await routed(world, input);
    expect(after).toMatchObject({ agent: "medium", sessionID: "child-7", background: true }); // untouched
    expect(after.model).toBeUndefined(); // no model reassigned either
    expect(lookupDispatch("child-7")).toMatchObject({
      agent: "medium", model: SONNET, variant: "medium", tier: "medium", parentSessionID: "root", step: "dispatch", acceptance: "none",
      facts: { class: "implement" },
    });
    const [row] = await world.rows();
    expect(row).toMatchObject({ resume: true, childSessionID: "child-7", switched: false, mode: "enforce" });
    expect(row!.reason.startsWith("kept:resume: ")).toBe(true);
    expect(row!.reason).toContain("A30");
    expect(row!.best).toMatchObject({ agent: "heavy" }); // the kernel's own decision is still logged
    expect(row!.reason).toMatch(/engine decision: switched: /); // and what it was
    expect(lookupDispatch("child-7")!.decisionID).toBe(row!.decisionID);
  });

  it("a resume is not moved by floorTier either, in enforce", async () => {
    const world = await makeWorld({ engine: "enforce" }, { enforcement: { verify: { testBaseline: false }, escalate: { floorTier: "medium" } } });
    await world.start();
    const after = await routed(world, { agent: "fast", prompt: "[route class=search risk=low scope=single]\nFind it.", sessionID: "child-3" });
    expect(after).toMatchObject({ agent: "fast", sessionID: "child-3" });
    const [row] = await world.rows();
    expect(row).toMatchObject({ switched: false, resume: true });
    expect(row!.reason.startsWith("kept:resume")).toBe(true);
  });

  it("shadow and advise log a resume the same way (kept:resume, not a would-switch)", async () => {
    for (const engine of ["shadow", "advise"] as const) {
      const world = await makeWorld({ engine, roles: {} });
      world.seed(KEYS.medium, 0, 20);
      world.seed(KEYS.heavy, 20, 0);
      await world.start();
      await routed(world, { agent: "medium", prompt: IMPLEMENT(), sessionID: "child-2" });
      const [row] = await world.rows();
      expect(row, engine).toMatchObject({ switched: false, resume: true, mode: engine });
      expect(row!.reason.startsWith("kept:resume"), engine).toBe(true);
    }
  });
  it("floorTier lifts a dispatch that starts below it, and the row says so (1.4 handoff)", async () => {
    const world = await makeWorld({ engine: "enforce" }, { enforcement: { verify: { testBaseline: false }, escalate: { floorTier: "medium" } } });
    await world.start();
    const after = await routed(world, { agent: "fast", prompt: "[route class=search risk=low scope=single]\nFind it." });
    expect(after).toMatchObject({ agent: "medium", model: `${SONNET}#medium` });
    const [row] = await world.rows();
    expect(row).toMatchObject({ switched: true, best: { agent: "medium" }, chosen: { agent: "fast" } });
    expect(row!.reason).toContain("floorTier");
  });
});

describe("A30 amended: a resume keeps the child where it runs (QA-2.4-R3-1)", () => {
  const SEARCH = "[route class=search risk=low scope=single]\nFind it.";
  const FLOOR = (tier: string) => ({ enforcement: { verify: { testBaseline: false }, escalate: { floorTier: tier } } });
  const resumeRows = async (world: World) => (await world.rows()).filter((row) => row.resume);

  it("a floor-lifted child resumed with the orchestrator's original pick is sent to the agent it runs: the host does not switch it", async () => {
    const world = await makeWorld({ engine: "enforce" }, FLOOR("medium"));
    await world.start();
    const first = await hostStart(world, "child-lift", { agent: "fast", prompt: SEARCH });
    expect(first.args).toMatchObject({ agent: "medium" }); // lifted to the floor
    expect(hostChildren.get("child-lift")).toMatchObject({ agent: "medium" });
    expect(lookupDispatch("child-lift")).toMatchObject({ agent: "medium", picked: "fast", tier: "medium" });
    const resumed = await hostResume(world, "child-lift", { agent: "fast", prompt: SEARCH });
    expect(resumed.args).toMatchObject({ agent: "medium", model: `${SONNET}#medium`, sessionID: "child-lift" });
    expect(resumed.switched).toBe(false); // the host finds the agent it already runs
    expect(resumed.child).toMatchObject({ agent: "medium", model: `${SONNET}#medium` }); // not back on the cheaper fast
    const [row] = await resumeRows(world);
    expect(row).toMatchObject({ resume: true, switched: false, mode: "enforce", childSessionID: "child-lift", chosen: { agent: "fast" } });
    expect(row!.reason.startsWith("kept:resume:running: ")).toBe(true);
    expect(row!.reason).toContain("@medium");
    expect(row!.reason).toContain("sent to @medium so the host does not switch it back (A30)");
    expect(row!.reason).not.toContain("NOT rewritten");
    expect(lookupDispatch("child-lift")).toMatchObject({ agent: "medium", model: SONNET, variant: "medium", picked: "fast", decisionID: row!.decisionID });
    // and again: the pick is remembered across resumes
    const again = await hostResume(world, "child-lift", { agent: "fast", prompt: SEARCH });
    expect(again.args).toMatchObject({ agent: "medium" });
    expect(again.switched).toBe(false);
  });

  it("an engine-switched child resumed with the original pick is sent to the agent it runs", async () => {
    const world = await makeWorld({ engine: "enforce", roles: {} });
    world.seed(KEYS.medium, 0, 20);
    world.seed(KEYS.heavy, 20, 0);
    await world.start();
    const first = await hostStart(world, "child-sw", { agent: "medium", prompt: IMPLEMENT() });
    expect(first.args).toMatchObject({ agent: "heavy", model: `${OPUS}#xhigh` }); // the evidence switch
    expect(lookupDispatch("child-sw")).toMatchObject({ agent: "heavy", picked: "medium" });
    const resumed = await hostResume(world, "child-sw", { agent: "medium", prompt: IMPLEMENT() });
    expect(resumed.args).toMatchObject({ agent: "heavy", model: `${OPUS}#xhigh`, sessionID: "child-sw" });
    expect(resumed.switched).toBe(false);
    expect(resumed.child).toMatchObject({ agent: "heavy" });
    const [row] = await resumeRows(world);
    expect(row).toMatchObject({ switched: false, resume: true, chosen: { agent: "medium" }, best: { agent: "heavy" } });
    expect(row!.reason.startsWith("kept:resume:running: ")).toBe(true);
  });

  it("a different agent named on purpose is honoured; below the floor it is lifted to it (never below the floor)", async () => {
    const world = await makeWorld({ engine: "enforce" }, FLOOR("medium"));
    await world.start();
    await hostStart(world, "child-own", { agent: "fast", prompt: SEARCH }); // lifted to medium
    // above the floor: honoured as named, the host switches the child (the orchestrator asked for it)
    const up = await hostResume(world, "child-own", { agent: "heavy", prompt: SEARCH });
    expect(up.args).toMatchObject({ agent: "heavy", sessionID: "child-own" });
    expect(up.args.model).toBeUndefined();
    expect(up.switched).toBe(true);
    expect(up.child.agent).toBe("heavy");
    expect(lookupDispatch("child-own")).toMatchObject({ agent: "heavy", picked: "heavy" });
    // naming the agent it runs now changes nothing
    const same = await hostResume(world, "child-own", { agent: "heavy", prompt: SEARCH });
    expect(same.args).toMatchObject({ agent: "heavy" });
    expect(same.switched).toBe(false);
    // a different agent below the floor (its pick is now heavy; fast is neither that nor what it runs): lifted to the floor
    const down = await hostResume(world, "child-own", { agent: "fast", prompt: SEARCH });
    expect(down.args).toMatchObject({ agent: "medium", model: `${SONNET}#medium`, sessionID: "child-own" });
    expect(down.child.agent).toBe("medium"); // what the orchestrator asked for, but not below the floor
    const rows = await resumeRows(world);
    const lastRow = rows.at(-1)!;
    expect(lastRow.reason.startsWith("lift:floor")).toBe(true);
    expect(lastRow).toMatchObject({ resume: true, chosen: { agent: "fast" }, best: { agent: "medium" } });
    expect(rows[0]!.reason.startsWith("kept:resume: ")).toBe(true); // the honoured switch to heavy: plain A30 row, no evidence switch
    expect(rows[0]).toMatchObject({ switched: false });
    expect(rows.some((row) => row.reason.startsWith("kept:resume:running"))).toBe(false);
  });

  it("shadow and advise never change the arguments: the row says what enforce would do", async () => {
    for (const engine of ["shadow", "advise"] as const) {
      const world = await makeWorld({ engine, roles: {} });
      await world.start();
      // a child the router moved (a registration as enforce would have made it): the orchestrator picked fast, it runs medium
      rememberDispatch("child-moved", {
        facts: { class: "search", risk: "low", scope: "single", needs: [] as string[], confidence: 0.9, source: "rules" },
        agent: "medium", model: SONNET, variant: "medium", tier: "medium", parentSessionID: "root", decisionID: "earlier", step: "dispatch", picked: "fast",
      });
      hostChildren.set("child-moved", { agent: "medium", model: modelOfAgent(world, "medium") });
      const resumed = await hostResume(world, "child-moved", { agent: "fast", prompt: SEARCH });
      expect(resumed.args, engine).toMatchObject({ agent: "fast", sessionID: "child-moved" }); // untouched
      expect(resumed.args.model, engine).toBeUndefined();
      expect(resumed.switched, engine).toBe(true); // (so the host switches it: that is what enforce prevents)
      const [row] = await resumeRows(world);
      expect(row, engine).toMatchObject({ resume: true, switched: false, mode: engine, chosen: { agent: "fast" } });
      expect(row!.reason.startsWith("kept:resume:running: "), engine).toBe(true);
      expect(row!.reason, engine).toContain(`would be sent to @medium (not applied in ${engine})`);
      await world.bundle.release();
      worlds.splice(worlds.indexOf(world), 1);
      rmSync(world.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      hostChildren.clear();
    }
  });

  it("nothing is corrected for a child the router did not move, one of another orchestrator, or one it knows nothing about", async () => {
    const world = await makeWorld({ engine: "enforce" }, FLOOR("medium"));
    await world.start();
    // not moved: the orchestrator picked medium and it runs medium
    await hostStart(world, "child-plain", { agent: "medium", prompt: IMPLEMENT() });
    expect(lookupDispatch("child-plain")).toMatchObject({ agent: "medium", picked: "medium" });
    const plain = await hostResume(world, "child-plain", { agent: "medium", prompt: IMPLEMENT() });
    expect(plain.args).toMatchObject({ agent: "medium" });
    expect(plain.switched).toBe(false);
    // another orchestrator's child (the registry is process-wide): left alone
    rememberDispatch("child-foreign", {
      facts: { class: "search", risk: "low", scope: "single", needs: [] as string[], confidence: 0.9, source: "rules" },
      agent: "medium", model: SONNET, variant: "medium", tier: "medium", parentSessionID: "someone-else", decisionID: "theirs", step: "dispatch", picked: "fast",
    });
    expect((await routed(world, { agent: "fast", prompt: SEARCH, sessionID: "child-foreign" })).agent).toBe("fast");
    // unknown to the registry (swept, or started before a restart): nothing is known to correct
    expect((await routed(world, { agent: "fast", prompt: SEARCH, sessionID: "child-unknown" })).agent).toBe("fast");
    // a pinned resume is the orchestrator's own order
    await hostStart(world, "child-pin", { agent: "fast", prompt: SEARCH });
    const pinned = await hostResume(world, "child-pin", { agent: "fast", prompt: "[route class=search risk=low scope=single pin]\nFind it." });
    expect(pinned.args).toMatchObject({ agent: "fast" });
    expect(pinned.switched).toBe(true);
    // 3.2 smoke (real host): the row of a pinned resume must not claim it was sent to the running agent, because it was sent as named
    const pinnedRow = (await resumeRows(world)).at(-1);
    expect(pinnedRow).toMatchObject({ resume: true, pinned: true, switched: false, childSessionID: "child-pin", chosen: { agent: "fast" } });
    expect(pinnedRow!.reason.startsWith("kept:resume:pinned: ")).toBe(true); // QA-3.2-12: its own prefix, still a kept:resume row
    expect(pinnedRow!.reason.startsWith("kept:resume")).toBe(true);
    expect(pinnedRow!.reason).toContain("pinned, so it is sent as named and NOT rewritten (the host moves the child to @fast)");
    expect(pinnedRow!.reason).not.toContain("sent to @medium");
    expect(pinnedRow!.reason).not.toContain("kept:resume:running");
  });

  it("a pinned resume is not rewritten, and its row does not claim it was sent to the running agent (QA-3.1 side note)", async () => {
    const world = await makeWorld({ engine: "enforce" }, FLOOR("medium"));
    await world.start();
    await hostStart(world, "child-pin-row", { agent: "fast", prompt: SEARCH }); // lifted to medium, picked fast
    const pinned = await hostResume(world, "child-pin-row", { agent: "fast", prompt: "[route class=search risk=low scope=single pin]\nFind it." });
    expect(pinned.args).toMatchObject({ agent: "fast" }); // the arguments really are untouched
    const [row] = await resumeRows(world);
    expect(row).toMatchObject({ resume: true, switched: false, pinned: true, chosen: { agent: "fast" } });
    expect(row!.reason.startsWith("kept:resume:pinned: ")).toBe(true); // QA-3.2-12: its own prefix, still a kept:resume row
    expect(row!.reason).toContain("pinned, so it is sent as named and NOT rewritten (the host moves the child to @fast)");
    expect(row!.reason).not.toMatch(/; sent to @medium/);
    expect(row!.reason).not.toContain("kept:resume:running");
    expect(row!.reason).not.toMatch(/\b(?:kept|switched): (?:kept|switched): /); // the engine decision's own prefix is not doubled
    // the unpinned resume of the same shape still says it was sent
    await hostStart(world, "child-unpinned-row", { agent: "fast", prompt: SEARCH });
    const unpinned = await hostResume(world, "child-unpinned-row", { agent: "fast", prompt: SEARCH });
    expect(unpinned.args).toMatchObject({ agent: "medium" });
    const last = (await resumeRows(world)).at(-1)!;
    expect(last.reason).toMatch(/; sent to @medium so the host does not switch it back/);
    expect(last.reason.startsWith("kept:resume:running: ")).toBe(true);
    expect(last.reason).not.toMatch(/\b(?:kept|switched): (?:kept|switched): /);
  });
});
describe("A34 (QA-G-B3): the A30 running rewrite requires needs coverage and never-down", () => {
  const CHECKED_MEDIUM = "[route class=implement risk=medium scope=single]\nImplement the parser change in src/a.ts.\n[acceptance]\ncheck: testsPass\n[/acceptance]";
  const HIGH = "[route class=implement risk=high scope=single]\nNow rotate the production API credentials and deploy the release.";
  const FIND = "[route class=search risk=low scope=single]\nFind where the cache is built.";
  const FIX = "[route class=implement risk=medium scope=single needs=shell,edit]\nNow fix it: edit src/cache.ts and run `npm test`.";
  const resumeRows = async (world: World) => (await world.rows()).filter((row) => row.resume);

  it("probe P3: a child moved down to @medium, resumed naming @heavy with high-risk work and no acceptance, is sent to @heavy (never-down)", async () => {
    const world = await makeWorld({ engine: "enforce", roles: {} });
    world.seed(KEYS.medium, 20, 0);
    world.seed(KEYS.heavy, 3, 2);
    await world.start();
    const first = await hostStart(world, "child-dn", { agent: "heavy", prompt: CHECKED_MEDIUM });
    expect(first.args).toMatchObject({ agent: "medium" }); // moved down legitimately: medium risk, deterministic checks
    expect(lookupDispatch("child-dn")).toMatchObject({ agent: "medium", picked: "heavy" });
    const resumed = await hostResume(world, "child-dn", { agent: "heavy", prompt: HIGH });
    expect(resumed.args).toMatchObject({ agent: "heavy", sessionID: "child-dn" });
    expect(resumed.args.model).toBeUndefined();
    expect(resumed.child.agent).toBe("heavy"); // the host moves it back up to the pick
    const [row] = await resumeRows(world);
    expect(row).toMatchObject({ resume: true, switched: false, chosen: { agent: "heavy" }, facts: { risk: "high" } });
    expect(row!.reason.startsWith(`${RESUME_NAMED_NEVER_DOWN_REASON}: `)).toBe(true);
    expect(row!.reason.startsWith(RESUME_REASON)).toBe(true); // still a resume row for routing:stats
    expect(row!.reason).toContain("NOT rewritten");
    expect(lookupDispatch("child-dn")).toMatchObject({ agent: "heavy", decisionID: row!.decisionID });
  });

  it("control: the same resume with a deterministic [acceptance] block, or at medium risk, keeps the child where it runs", async () => {
    const world = await makeWorld({ engine: "enforce", roles: {} });
    world.seed(KEYS.medium, 20, 0);
    world.seed(KEYS.heavy, 3, 2);
    await world.start();
    await hostStart(world, "child-ok", { agent: "heavy", prompt: CHECKED_MEDIUM });
    const checked = await hostResume(world, "child-ok", { agent: "heavy", prompt: `${HIGH}\n[acceptance]\ncheck: testsPass\n[/acceptance]` });
    expect(checked.args).toMatchObject({ agent: "medium", model: `${SONNET}#medium` });
    expect(checked.switched).toBe(false);
    const medium = await hostResume(world, "child-ok", { agent: "heavy", prompt: CHECKED_MEDIUM.replace("[acceptance]\ncheck: testsPass\n[/acceptance]", "") });
    expect(medium.args).toMatchObject({ agent: "medium" });
    const rows = await resumeRows(world);
    expect(rows.map((row) => row.reason.split(":").slice(0, 3).join(":"))).toEqual(["kept:resume:running", "kept:resume:running"]);
  });

  it("probe P3b: a search child moved to read-only @explore, resumed with needs=shell,edit, is sent as named (needs)", async () => {
    const world = await makeWorld({ engine: "enforce" }); // D12 default roles: search → explore
    world.seed(KEYS.explore, 20, 0);
    world.seed(KEYS.fast, 0, 10);
    await world.start();
    const first = await hostStart(world, "child-x", { agent: "fast", prompt: FIND });
    expect(first.args).toMatchObject({ agent: "explore" });
    const resumed = await hostResume(world, "child-x", { agent: "fast", prompt: FIX });
    expect(resumed.args).toMatchObject({ agent: "fast", sessionID: "child-x" });
    expect(resumed.args.agent).not.toBe("explore");
    const [row] = await resumeRows(world);
    expect(row).toMatchObject({ resume: true, switched: false, chosen: { agent: "fast" }, facts: { needs: ["shell", "edit"] } });
    expect(row!.reason.startsWith(`${RESUME_NAMED_NEEDS_REASON}: `)).toBe(true);
    expect(row!.reason).toContain("needs [shell,edit]");
  });

  it("a refused rewrite is still lifted to floorTier when the named pick is below it, and the lift row keeps the refusal", async () => {
    const world = await makeWorld({ engine: "enforce" }, { enforcement: { verify: { testBaseline: false }, escalate: { floorTier: "medium" } } });
    await world.start();
    rememberDispatch("child-ro", {
      facts: { class: "search", risk: "low", scope: "single", needs: [] as string[], confidence: 0.9, source: "rules" },
      agent: "explore", model: HAIKU, variant: null, tier: null, parentSessionID: "root", decisionID: "earlier", step: "dispatch", picked: "fast",
    });
    hostChildren.set("child-ro", { agent: "explore", model: HAIKU });
    const resumed = await hostResume(world, "child-ro", { agent: "fast", prompt: FIX });
    expect(resumed.args).toMatchObject({ agent: "medium", model: `${SONNET}#medium`, sessionID: "child-ro" });
    const [row] = await resumeRows(world);
    expect(row).toMatchObject({ resume: true, switched: true, best: { agent: "medium" } });
    expect(row!.reason.startsWith("lift:floor: resume lifted from @fast to @medium")).toBe(true);
    expect(row!.reason).toContain(`engine decision: ${RESUME_NAMED_NEEDS_REASON}: `);
  });

  it("shadow says what enforce would do with a refused rewrite: sent as named, never 'would be sent' to the running agent", async () => {
    const world = await makeWorld({ engine: "shadow" });
    await world.start();
    rememberDispatch("child-sh", {
      facts: { class: "search", risk: "low", scope: "single", needs: [] as string[], confidence: 0.9, source: "rules" },
      agent: "explore", model: HAIKU, variant: null, tier: null, parentSessionID: "root", decisionID: "earlier", step: "dispatch", picked: "fast",
    });
    const after = await routed(world, { agent: "fast", prompt: FIX, sessionID: "child-sh" });
    expect(after.agent).toBe("fast");
    const [row] = await resumeRows(world);
    expect(row!.reason.startsWith(`${RESUME_NAMED_NEEDS_REASON}: `)).toBe(true);
    expect(row!.reason).not.toContain("would be sent to @explore");
  });
});

describe("A34 (QA-G-B8): the decision row records detection and capability ranks", () => {
  /** The rows exactly as written to decisions.jsonl (the reader keeps only the fields it knows). */
  const rawRows = async (world: World): Promise<Array<Record<string, any>>> => {
    await world.bundle.flusher.flushNow();
    const file = join(world.outcomes, "decisions.jsonl");
    return readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as Record<string, any>)
      .filter((row) => row.kind === "decision");
  };
  const CLAIMED = "[route class=implement risk=high scope=single d=deterministic]\nRotate the production signing key and deploy.";
  const CHECKED_MEDIUM = "[route class=implement risk=medium scope=single]\nImplement the parser change in src/a.ts.\n[acceptance]\ncheck: testsPass\n[/acceptance]";

  it("an unbacked d= claim is logged as claimed next to the effective none; a kept high-risk dispatch runs at the pick's rank", async () => {
    const world = await makeWorld({ engine: "enforce", roles: {} });
    world.seed(KEYS.medium, 20, 0);
    world.seed(KEYS.heavy, 3, 2);
    await world.start();
    await routed(world, { agent: "heavy", prompt: CLAIMED });
    await routed(world, { agent: "heavy", prompt: CHECKED_MEDIUM });
    const [kept, switched] = await rawRows(world);
    expect(kept).toMatchObject({ detection: { effective: "none", claimed: "deterministic" }, capability: { pick: 2, dispatched: 2 }, switched: false });
    expect(switched).toMatchObject({ detection: { effective: "deterministic" }, capability: { pick: 2, dispatched: 1 }, switched: true });
    expect(switched!.detection.claimed).toBeUndefined(); // no claim that differs
  });

  it("the ranks are those of what the host was handed (after the legacy hook), and summarize audits them: 0 below on high-risk d=none", async () => {
    const world = await makeWorld({ engine: "shadow" });
    await world.start({
      "tool.execute.before": async (_input: unknown, output: { args: Record<string, unknown> }) => { output.args.subagent_type = "fast"; },
    });
    await routed(world, { agent: "heavy", prompt: "[route class=implement risk=high scope=single]\nRotate the key." });
    const [row] = await rawRows(world);
    expect(row).toMatchObject({ detection: { effective: "none" }, capability: { pick: 2, dispatched: 0 } }); // the legacy hook moved it to fast
    expect(summarize(null, [row as unknown as DecisionRow], { since: null, until: null }).neverDown).toEqual({ below: 1, recorded: 1 });
  });
});

describe("A34 (QA-G-B2): a route-line d= never raises detection above the prompt's own [acceptance] block", () => {
  const CLAIMED = "[route class=implement risk=high scope=single d=deterministic]\nRotate the production signing key and deploy.";
  const CHECKED = `${CLAIMED}\n[acceptance]\ncheck: testsPass\n[/acceptance]`;

  it("risk=high d=deterministic without an [acceptance] block, enforce, evidence on a lower tier → kept on the pick (never-down holds)", async () => {
    const world = await makeWorld({ engine: "enforce", roles: {} });
    world.seed(KEYS.medium, 20, 0);
    world.seed(KEYS.heavy, 3, 2);
    await world.start();
    const after = await routed(world, { agent: "heavy", prompt: CLAIMED });
    expect(after.agent).toBe("heavy");
    expect(after.model).toBeUndefined();
    const [row] = await world.rows();
    expect(row).toMatchObject({ switched: false, chosen: { agent: "heavy" }, facts: { risk: "high" } });
    expect(row!.reason.startsWith("kept:")).toBe(true);
  });

  it("control: the same claim WITH a deterministic [acceptance] block may move it down on the same evidence", async () => {
    const world = await makeWorld({ engine: "enforce", roles: {} });
    world.seed(KEYS.medium, 20, 0);
    world.seed(KEYS.heavy, 3, 2);
    await world.start();
    const after = await routed(world, { agent: "heavy", prompt: CHECKED });
    expect(after.agent).toBe("medium");
    const [row] = await world.rows();
    expect(row).toMatchObject({ switched: true, best: { agent: "medium" } });
  });
});

describe("advise: input untouched, protocol and hint through the context hook", () => {
  async function adviseWorld(withEvidence: boolean) {
    const world = await makeWorld({ engine: "advise", margin: 0.1, roles: { search: ["explore"], recon: ["explore"] } });
    if (withEvidence) {
      world.seed(KEYS.fast, 0, 20);
      world.seed(KEYS.explore, 20, 0);
      world.seed(KEYS.reconFast, 0, 20);
      world.seed(KEYS.reconExplore, 20, 0);
    }
    const cfg = loadConfig(world.home);
    const protocol = assembleSystemPrompt(cfg, undefined, false);
    await world.start({ "experimental.chat.system.transform": async (_input: unknown, output: { system: string[] }) => { output.system.push(protocol); } });
    return { world, cfg, protocol };
  }

  const turn = (text: string): any => ({
    sessionID: "root", agent: "build", model: { providerID: "anthropic", id: "claude-opus-5-5" }, options: {}, system: [],
    messages: [{ role: "user", content: [{ type: "text", text }] }],
  });

  it("the dispatch is untouched (aside from the route line) and a decision row is written", async () => {
    const { world } = await adviseWorld(true);
    const after = await routed(world, { agent: "fast", prompt: "[route class=search risk=low scope=single]\nFind the usages." });
    expect(after).toMatchObject({ agent: "fast", prompt: "Find the usages." });
    expect(after.model).toBeUndefined();
    const [row] = await world.rows();
    expect(row).toMatchObject({ mode: "advise", switched: true, best: { agent: "explore" } });
  });

  it("with evidence the R: line gains a by-class segment, the route paragraph is appended and a hint is added", async () => {
    const { world, cfg, protocol } = await adviseWorld(true);
    const shipped = v2Instructions(protocol);
    const event = turn("Find all the usages of parseConfig in the repository");
    await world.sessionHooks.context(event);
    const texts = event.system.map((part: { text: string }) => part.text) as string[];
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain(`${buildTaskTaxonomy(cfg)} | by class: search→@explore recon→@explore`);
    expect(texts[0]).toContain("Routing line (optional)");
    expect(texts[0]).not.toMatch(/\bmodel\b/);
    expect(texts[0]!.replace(/\n\nRouting line \(optional\)[\s\S]*$/, "")).toBe(shipped.replace(buildTaskTaxonomy(cfg), () => `${buildTaskTaxonomy(cfg)} | by class: search→@explore recon→@explore`));
    expect(texts[1]).toBe("Route hint: for recon work like this turn, prefer @explore (Fast read-only codebase exploration).");
    expect(texts[1]!.split("\n")).toHaveLength(1);
  });

  it("without evidence the R: line is the shipped one and there is no hint, only the route paragraph", async () => {
    const { world, cfg, protocol } = await adviseWorld(false);
    const event = turn("Find all the usages of parseConfig in the repository");
    await world.sessionHooks.context(event);
    const texts = event.system.map((part: { text: string }) => part.text) as string[];
    expect(texts).toHaveLength(1);
    expect(texts[0]!.startsWith(v2Instructions(protocol))).toBe(true);
    expect(texts[0]).toContain(buildTaskTaxonomy(cfg));
    expect(texts[0]).toContain("Routing line (optional)");
  });

  it("the hint is stable within a turn and refreshed by a new user message; a child session gets nothing", async () => {
    const { world } = await adviseWorld(true);
    const first = turn("Find all the usages of parseConfig in the repository");
    await world.sessionHooks.context(first);
    const again = turn("Find all the usages of parseConfig in the repository");
    await world.sessionHooks.context(again);
    expect(again.system.map((part: { text: string }) => part.text)).toEqual(first.system.map((part: { text: string }) => part.text));
    world.seed(KEYS.reconExplore, 40, 0);
    const next = turn("Find all the usages of anotherFunction in the repository");
    await world.sessionHooks.context(next);
    expect(next.system[1].text).toBe(first.system[1].text); // new outcomes and a new turn, same destination
    const child: any = { ...turn("Find usages"), system: [] };
    // the legacy hook pushes nothing for a child: no protocol text, so nothing to adapt
    const pushedNothing = await makeWorld({ engine: "advise" });
    await pushedNothing.start({ "experimental.chat.system.transform": async () => undefined });
    await pushedNothing.sessionHooks.context(child);
    expect(child.system).toEqual([]);
  });

  it("enforce appends the paragraph that lets the engine switch; shadow never does", async () => {
    const world = await makeWorld({ engine: "enforce", margin: 0.1, roles: { recon: ["explore"] } });
    world.seed(KEYS.reconFast, 0, 20);
    world.seed(KEYS.reconExplore, 20, 0);
    const cfg = loadConfig(world.home);
    const protocol = assembleSystemPrompt(cfg, undefined, false);
    await world.start({ "experimental.chat.system.transform": async (_input: unknown, output: { system: string[] }) => { output.system.push(protocol); } });
    const event = turn("Find all the usages of parseConfig in the repository");
    await world.sessionHooks.context(event);
    const text = event.system[0].text as string;
    expect(text).toContain("may start a dispatch on another agent");
    expect(text).not.toContain("does not change your dispatches");
    expect(event.system).toHaveLength(1); // enforce routes already: no advisory hint, even with evidence
  });
});

describe("classifier and failures never block a dispatch", () => {
  it("a classifier backend that hangs falls back to the rules facts within the timeout and the dispatch proceeds", async () => {
    const world = await makeWorld({ engine: "shadow", classifier: { backend: "host", model: "anthropic/claude-haiku-4-5", timeoutMs: 100 } });
    world.generate.mockImplementation(() => new Promise<{ text: string }>(() => undefined));
    await world.start();
    const started = Date.now();
    const after = await routed(world, { agent: "medium", prompt: "Please look into the thing we discussed yesterday." });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(after).toMatchObject({ agent: "medium", prompt: "Please look into the thing we discussed yesterday." });
    const [row] = await world.rows();
    expect(row).toBeDefined();
    expect(row!.facts.source).not.toBe("host");
  });

  it("an engine failure is logged and the call goes through as written", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const world = await makeWorld({ engine: "enforce" });
    world.session.current = new Error("session store offline");
    await world.start();
    const after = await routed(world, { agent: "medium", prompt: IMPLEMENT() });
    expect(after).toMatchObject({ agent: "medium", prompt: IMPLEMENT() });
    expect(await world.rows()).toEqual([]);
    expect(warn.mock.calls.flat().join("\n")).toContain("the dispatching session is unavailable");
  });

  it("an agent list that fails keeps the orchestrator's choice and does not throw into the session", async () => {
    const world = await makeWorld({ engine: "enforce", roles: {} });
    world.seed(KEYS.medium, 0, 20);
    world.seed(KEYS.heavy, 20, 0);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await world.start();
    world.ctx.agent.list.mockRejectedValue(new Error("agents unavailable"));
    const after = await routed(world, { agent: "medium", prompt: IMPLEMENT() });
    expect(after).toMatchObject({ agent: "medium", prompt: "Implement the change in src/a.ts." });
    expect(after.model).toBeUndefined();
    const logged = warn.mock.calls.flat().join("\n");
    expect(logged).toContain("the agent list is unavailable");
    expect(logged).not.toContain("the engine failed");
  });

  it("a subagent's own dispatch (a child session) is left exactly as it is: nothing parsed, nothing stripped", async () => {
    const world = await makeWorld({ engine: "enforce", roles: {} });
    world.seed(KEYS.medium, 0, 20);
    world.seed(KEYS.heavy, 20, 0);
    world.session.current = { id: "child", parentID: "root", agent: "general", permissions: [], location: { directory: world.home } };
    await world.start();
    const prompt = IMPLEMENT(" pin");
    const after = await routed(world, { agent: "medium", prompt }, { sessionID: "child" });
    expect(after).toMatchObject({ agent: "medium", prompt });
    expect(await world.rows()).toEqual([]);
  });

  it("the verification grader agent is never routed", async () => {
    const world = await makeWorld({ engine: "enforce" });
    await world.start();
    const after = await routed(world, { agent: V2_GRADER_AGENT, prompt: IMPLEMENT() });
    expect(after.prompt).toBe(IMPLEMENT());
    expect(await world.rows()).toEqual([]);
  });
});

describe("plan route lines and subagentTiers", () => {
  it("a plan route line is authoritative for the facts; its d= is capped by the prompt's own [acceptance] block (A34, QA-G-B2)", async () => {
    const world = await makeWorld({ engine: "shadow" });
    await world.start();
    const line = "[route class=debug risk=medium scope=multi needs=shell,edit d=deterministic]\nFix the failing test.";
    await routed(world, { agent: "medium", prompt: `${line}\n[acceptance]\ncheck: testsPass\n[/acceptance]`, sessionID: "child-plan" });
    expect(lookupDispatch("child-plan")).toMatchObject({ acceptance: "deterministic", facts: { class: "debug", risk: "medium", scope: "multi", needs: ["shell", "edit"], source: "plan" } });
    // The same claim without a block the verifier could run: the dispatch is decided (and carried) as `none`.
    await routed(world, { agent: "medium", prompt: line, sessionID: "child-plan-bare" });
    expect(lookupDispatch("child-plan-bare")).toMatchObject({ acceptance: "none", facts: { class: "debug", source: "plan" } });
  });

  it("subagentTiers still fills a missing model when the engine does not switch, and never overrides the engine's own", async () => {
    const world = await makeWorld({ engine: "enforce", roles: {} }, { subagentTiers: { general: "fast" } });
    await world.start();
    const kept = await routed(world, { agent: "general", prompt: "[route class=other]\nAnything." });
    expect(kept).toMatchObject({ agent: "general", model: `${SONNET}#low` });
    world.seed(KEYS.medium, 0, 20);
    world.seed(KEYS.heavy, 20, 0);
    const switched = await routed(world, { agent: "medium", prompt: IMPLEMENT() });
    expect(switched).toMatchObject({ agent: "heavy", model: `${OPUS}#xhigh` });
    const explicit = await routed(world, { agent: "general", model: `${OPUS}#high`, prompt: "[route class=other]\nAnything." });
    expect(explicit.model).toBe(`${OPUS}#high`);
  });
});

// Includes hundreds of dispatches and flushing the real outcome store to disk.
describe("registration for ingestion (2.1 handoff)", { timeout: 60_000 }, () => {
  it("a fresh child is registered when its session.created arrives (parent, agent and title match), once", async () => {
    const world = await makeWorld({ engine: "shadow" });
    await world.start();
    await routed(world, { agent: "medium", description: "implement a", prompt: IMPLEMENT() });
    await routed(world, { agent: "medium", description: "implement b", prompt: IMPLEMENT() });
    world.emit({ type: "session.created", data: { sessionID: "child-b", parentID: "root", agent: "medium", title: "implement b" } });
    world.emit({ type: "session.created", data: { sessionID: "child-a", parentID: "root", agent: "medium", title: "implement a" } });
    world.emit({ type: "session.created", data: { sessionID: "stranger", parentID: "other-root", agent: "medium", title: "implement a" } });
    await vi.waitFor(() => { expect(lookupDispatch("child-a")).toBeDefined(); expect(lookupDispatch("child-b")).toBeDefined(); });
    expect(lookupDispatch("stranger")).toBeUndefined();
    expect(lookupDispatch("child-a")).toMatchObject({ agent: "medium", model: SONNET, variant: "medium", parentSessionID: "root", tier: "medium" });
    expect(lookupDispatch("child-a")!.attemptIndex).toBe(0);
  });

  it("a second execution of the same child is a new registration (QA-2.1-R2-10)", async () => {
    const world = await makeWorld({ engine: "shadow" });
    await world.start();
    await routed(world, { agent: "medium", prompt: IMPLEMENT(), sessionID: "child-r" });
    const first = lookupDispatch("child-r")!;
    await routed(world, { agent: "medium", prompt: IMPLEMENT(), sessionID: "child-r" });
    const second = lookupDispatch("child-r")!;
    expect(second.attemptIndex).toBe(first.attemptIndex + 1);
    expect(second.attemptId).not.toBe(first.attemptId);
    expect(second.decisionID).not.toBe(first.decisionID);
  });

  it("a dispatch whose call ended without a child is dropped and cannot be claimed by a later child", async () => {
    const world = await makeWorld({ engine: "shadow" });
    await world.start();
    const call = dispatch(world, { agent: "medium", description: "denied", prompt: IMPLEMENT() });
    await call.run();
    await world.toolHooks["execute.after"]({ id: call.event.id, tool: "subagent", status: "failed", sessionID: "root" });
    world.emit({ type: "session.created", data: { sessionID: "late-child", parentID: "root", agent: "medium", title: "denied" } });
    world.emit({ type: "session.deleted", data: { sessionID: "barrier" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lookupDispatch("late-child")).toBeUndefined();
  });

  it("a session.created without an agent claims the oldest pending dispatch of its parent", async () => {
    const world = await makeWorld({ engine: "shadow" });
    await world.start();
    await routed(world, { agent: "medium", description: "first", prompt: IMPLEMENT() });
    await routed(world, { agent: "fast", description: "second", prompt: "[route class=search]\nFind it." });
    world.emit({ type: "session.created", data: { sessionID: "anon-1", parentID: "root" } });
    world.emit({ type: "session.created", data: { sessionID: "anon-2", parentID: "root" } });
    await vi.waitFor(() => { expect(lookupDispatch("anon-1")).toBeDefined(); expect(lookupDispatch("anon-2")).toBeDefined(); });
    expect(lookupDispatch("anon-1")).toMatchObject({ agent: "medium", facts: { class: "implement" } });
    expect(lookupDispatch("anon-2")).toMatchObject({ agent: "fast", facts: { class: "search" } });
  });

  it("an agent mismatch is not claimed: a child of another agent never takes the dispatch", async () => {
    const world = await makeWorld({ engine: "shadow" });
    await world.start();
    await routed(world, { agent: "medium", description: "only", prompt: IMPLEMENT() });
    world.emit({ type: "session.created", data: { sessionID: "producer", parentID: "root", agent: "fast", title: "only" } });
    world.emit({ type: "session.deleted", data: { sessionID: "barrier" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lookupDispatch("producer")).toBeUndefined();
    world.emit({ type: "session.created", data: { sessionID: "real", parentID: "root", agent: "medium", title: "only" } });
    await vi.waitFor(() => { expect(lookupDispatch("real")).toBeDefined(); });
  });

  it("the waiting list is bounded: the oldest dispatches are dropped first (memory does not grow)", async () => {
    const world = await makeWorld({ engine: "shadow" });
    await world.start();
    for (let i = 0; i < 205; i++) await routed(world, { agent: "medium", description: `d${i}`, prompt: IMPLEMENT() });
    world.emit({ type: "session.created", data: { sessionID: "survivor", parentID: "root", agent: "medium" } });
    await vi.waitFor(() => { expect(lookupDispatch("survivor")).toBeDefined(); });
    expect(lookupDispatch("survivor")!.decisionID).toMatch(/:6$/); // 1..5 were dropped
  });

  it("a dispatch is forgotten after the waiting limit", async () => {
    const world = await makeWorld({ engine: "shadow" });
    await world.start();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await routed(world, { agent: "medium", description: "slow", prompt: IMPLEMENT() });
      vi.setSystemTime(Date.now() + 121_000);
      world.emit({ type: "session.created", data: { sessionID: "too-late", parentID: "root", agent: "medium", title: "slow" } });
      world.emit({ type: "session.deleted", data: { sessionID: "barrier" } });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(lookupDispatch("too-late")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a hot reload to static stops everything at the next dispatch: untouched input, no new row, the store is released", async () => {
    const world = await makeWorld({ engine: "shadow" });
    await world.start();
    await routed(world, { agent: "medium", prompt: IMPLEMENT() });
    expect(await world.rows()).toHaveLength(1);
    writeFileSync(overridePath(), JSON.stringify({ enforcement: { verify: { testBaseline: false } }, routing: { engine: "static", outcomes: { path: world.outcomes } } }));
    invalidateConfigCache();
    const input = { agent: "medium", prompt: IMPLEMENT(), sessionID: "child-static" };
    const after = await routed(world, input);
    expect(after).toMatchObject({ agent: "medium", prompt: IMPLEMENT(), sessionID: "child-static" });
    expect(lookupDispatch("child-static")).toBeUndefined();
    expect(await world.rows()).toHaveLength(1);
  });

  it("static registers nothing, even for a session.created event of a child", async () => {
    const world = await makeWorld(null);
    await world.start();
    await routed(world, { agent: "medium", prompt: IMPLEMENT() });
    world.emit({ type: "session.created", data: { sessionID: "child-s", parentID: "root", agent: "medium", title: "work item" } });
    world.emit({ type: "session.deleted", data: { sessionID: "barrier" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lookupDispatch("child-s")).toBeUndefined();
  });
});

describe("registration from the FINAL input (QA-2.2-2)", () => {
  const throwing = { "tool.execute.before": async () => { throw new Error("depth limit reached"); } };

  it("a legacy hook that throws registers nothing and leaves no stale waiting entry", async () => {
    const world = await makeWorld({ engine: "shadow" });
    await world.start(throwing);
    const resume = dispatch(world, { agent: "medium", prompt: IMPLEMENT(), sessionID: "child-throw" });
    await expect(resume.run()).rejects.toThrow("depth limit reached");
    const fresh = dispatch(world, { agent: "medium", description: "doomed", prompt: IMPLEMENT() });
    await expect(fresh.run()).rejects.toThrow("depth limit reached");
    expect(lookupDispatch("child-throw")).toBeUndefined();
    world.emit({ type: "session.created", data: { sessionID: "stray", parentID: "root", agent: "medium", title: "doomed" } });
    world.emit({ type: "session.deleted", data: { sessionID: "barrier" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lookupDispatch("stray")).toBeUndefined();
  });

  it("QA-G-A2: a call the legacy hook rejects writes no decision row; the normal path writes exactly one", async () => {
    for (const engine of ["shadow", "enforce"] as const) {
      const rejected = await makeWorld({ engine });
      await rejected.start(throwing);
      await expect(dispatch(rejected, { agent: "medium", prompt: IMPLEMENT() }).run(), engine).rejects.toThrow("depth limit reached");
      await expect(dispatch(rejected, { agent: "medium", prompt: IMPLEMENT(), sessionID: "child-rejected" }).run(), engine).rejects.toThrow("depth limit reached");
      expect(await rejected.rows(), engine).toEqual([]);
      for (const cleanup of cleanups.splice(0)) await cleanup();

      const normal = await makeWorld({ engine });
      await normal.start();
      await routed(normal, { agent: "medium", prompt: IMPLEMENT() });
      const rows = await normal.rows();
      expect(rows, engine).toHaveLength(1);
      expect(rows[0], engine).toMatchObject({ kind: "decision", mode: engine, chosen: { agent: "medium" } });
      for (const cleanup of cleanups.splice(0)) await cleanup();
    }
  });

  it("QA-G-A2: an unresolvable pick (nothing to register) still writes its kept:unresolved row at commit", async () => {
    const world = await makeWorld({ engine: "shadow" });
    world.session.current = { ...(world.session.current as Record<string, unknown>), model: null }; // no parent model to fall back on
    await world.start();
    await routed(world, { agent: "nobody-knows", prompt: IMPLEMENT() });
    const rows = await world.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason.startsWith("kept:unresolved")).toBe(true);
  });

  it("a legacy hook that rewrites the agent: the waiting entry uses the final agent, and its model", async () => {
    const world = await makeWorld({ engine: "shadow" });
    await world.start({
      "tool.execute.before": async (_input: unknown, output: { args: Record<string, unknown> }) => { output.args.subagent_type = "fast"; },
    });
    const after = await routed(world, { agent: "medium", description: "rewritten", prompt: IMPLEMENT() });
    expect(after.agent).toBe("fast");
    world.emit({ type: "session.created", data: { sessionID: "by-medium", parentID: "root", agent: "medium", title: "rewritten" } });
    world.emit({ type: "session.created", data: { sessionID: "by-fast", parentID: "root", agent: "fast", title: "rewritten" } });
    await vi.waitFor(() => { expect(lookupDispatch("by-fast")).toBeDefined(); });
    expect(lookupDispatch("by-medium")).toBeUndefined();
    expect(lookupDispatch("by-fast")).toMatchObject({ agent: "fast", model: SONNET, variant: "low", tier: "fast", parentSessionID: "root" });
  });

  it("a legacy hook that sets a model: the registration carries it; a resume is registered from the final input", async () => {
    const world = await makeWorld({ engine: "shadow" });
    await world.start({
      "tool.execute.before": async (_input: unknown, output: { args: Record<string, unknown> }) => { output.args.model = `${OPUS}#high`; },
    });
    await routed(world, { agent: "medium", prompt: IMPLEMENT(), sessionID: "child-model" });
    expect(lookupDispatch("child-model")).toMatchObject({ agent: "medium", model: OPUS, variant: "high" });
  });

  it("route() alone registers nothing: the dispatch is registered only after the adapter commits the final input", async () => {
    const world = await makeWorld({ engine: "shadow" });
    let seenDuringLegacy: unknown = "unset";
    await world.start({
      "tool.execute.before": async () => { seenDuringLegacy = lookupDispatch("child-order"); },
    });
    await routed(world, { agent: "medium", prompt: IMPLEMENT(), sessionID: "child-order" });
    expect(seenDuringLegacy).toBeUndefined();
    expect(lookupDispatch("child-order")).toBeDefined();
  });
});

describe("the result names the child (QA-2.2-3)", () => {
  const result = (child: string, status: string) => ({
    output: { sessionID: child, status, output: "" },
    content: [{ type: "text", text: `<subagent sessionID="${child}" state="${status}">` }],
    metadata: { sessionID: child, status },
  });
  const after = (world: World, id: string, child: string | null, status = "completed") =>
    world.toolHooks["execute.after"]({ id, tool: "subagent", status, sessionID: "root", result: child === null ? undefined : result(child, "running") });

  it("execute.after before session.created with background: true registers the child from the result", async () => {
    const world = await makeWorld({ engine: "shadow" });
    await world.start();
    const call = dispatch(world, { agent: "medium", description: "background work", prompt: IMPLEMENT(), background: true });
    await call.run();
    await after(world, call.event.id, "child-bg");
    expect(lookupDispatch("child-bg")).toMatchObject({ agent: "medium", model: SONNET, variant: "medium", parentSessionID: "root" });
    const [row] = await world.rows();
    expect(lookupDispatch("child-bg")!.decisionID).toBe(row!.decisionID);
    // the late event finds nothing left to claim
    world.emit({ type: "session.created", data: { sessionID: "child-bg-2", parentID: "root", agent: "medium", title: "background work" } });
    world.emit({ type: "session.deleted", data: { sessionID: "barrier" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lookupDispatch("child-bg-2")).toBeUndefined();
  });

  it("a heuristic claim that picked the wrong child is corrected when the results arrive (either order)", async () => {
    for (const order of ["a-first", "b-first"] as const) {
      const world = await makeWorld({ engine: "shadow" });
      await world.start();
      const a = dispatch(world, { agent: "medium", description: "same", prompt: IMPLEMENT() });
      const b = dispatch(world, { agent: "medium", description: "same", prompt: "[route class=debug risk=low scope=single]\nFix it." });
      await a.run();
      await b.run();
      // the host created B's child first: the claims are crossed (X -> A's dispatch, C -> B's dispatch)
      world.emit({ type: "session.created", data: { sessionID: `X-${order}`, parentID: "root", agent: "medium", title: "same" } });
      world.emit({ type: "session.created", data: { sessionID: `C-${order}`, parentID: "root", agent: "medium", title: "same" } });
      await vi.waitFor(() => { expect(lookupDispatch(`C-${order}`)).toBeDefined(); });
      const [rowA, rowB] = await world.rows();
      expect(lookupDispatch(`X-${order}`)!.decisionID).toBe(rowA!.decisionID);
      // truth: A ran in C, B ran in X
      const first = order === "a-first" ? [[a, `C-${order}`], [b, `X-${order}`]] as const : [[b, `X-${order}`], [a, `C-${order}`]] as const;
      for (const [call, child] of first) await after(world, call.event.id, child);
      expect(lookupDispatch(`C-${order}`)!.decisionID).toBe(rowA!.decisionID);
      expect(lookupDispatch(`C-${order}`)!.facts.class).toBe("implement");
      expect(lookupDispatch(`X-${order}`)!.decisionID).toBe(rowB!.decisionID);
      expect(lookupDispatch(`X-${order}`)!.facts.class).toBe("debug");
    }
  });

  it("a correct claim is left alone (no second registration); a failed call and an unknown call do nothing", async () => {
    const world = await makeWorld({ engine: "shadow" });
    await world.start();
    const call = dispatch(world, { agent: "medium", description: "right", prompt: IMPLEMENT() });
    await call.run();
    world.emit({ type: "session.created", data: { sessionID: "child-right", parentID: "root", agent: "medium", title: "right" } });
    await vi.waitFor(() => { expect(lookupDispatch("child-right")).toBeDefined(); });
    const claimed = lookupDispatch("child-right")!;
    await after(world, call.event.id, "child-right");
    expect(lookupDispatch("child-right")).toBe(claimed);
    await after(world, "never-routed", "child-nobody");
    expect(lookupDispatch("child-nobody")).toBeUndefined();
    const failed = dispatch(world, { agent: "medium", description: "fails", prompt: IMPLEMENT() });
    await failed.run();
    await after(world, failed.event.id, null, "failed");
    world.emit({ type: "session.created", data: { sessionID: "after-failure", parentID: "root", agent: "medium", title: "fails" } });
    world.emit({ type: "session.deleted", data: { sessionID: "barrier" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lookupDispatch("after-failure")).toBeUndefined();
  });
});

describe("the prompt passes through byte for byte except its first-line route line (QA-2.2-5)", () => {
  const body = [
    "Quote from the plan:",
    "[tier:heavy] Design the cache",
    "[route class=design risk=high pin]",
    "> [route class=debug pin]",
    "```",
    "[route class=debug]",
    "```",
    "CAP:none",
    "reason: reading everything",
    "[acceptance]",
    "criteria: it works",
    "[/acceptance]",
    "",
  ].join("\n");

  it("shadow, advise and enforce strip only the first line", async () => {
    for (const engine of ["shadow", "advise", "enforce"] as const) {
      const world = await makeWorld({ engine, roles: {} });
      await world.start();
      const after = await routed(world, { agent: "medium", prompt: `[route class=implement risk=medium scope=single]\n${body}` });
      expect(after.prompt).toBe(body);
      const withBlank = await routed(world, { agent: "medium", prompt: `\n\n[route class=implement]\n${body}` });
      expect(withBlank.prompt).toBe(`\n\n${body}`);
      const crlf = await routed(world, { agent: "medium", prompt: "[route class=implement]\r\nLine one\r\n[route pin]\r\nLine three\r\n" });
      expect(crlf.prompt).toBe("Line one\r\n[route pin]\r\nLine three\r\n");
    }
  });

  it("a prompt whose first non-empty line is not a route line is untouched, whatever it quotes", async () => {
    const world = await makeWorld({ engine: "enforce", roles: {} });
    await world.start();
    const prompt = `[tier:heavy]\n[route class=implement pin]\n${body}`;
    const after = await routed(world, { agent: "medium", prompt });
    expect(after.prompt).toBe(prompt);
    const [row] = await world.rows();
    expect(row).toMatchObject({ pinned: false, facts: { source: "rules" } });
  });
});

describe("a second plugin instance does not act on the same call (A3, QA-2.2-12)", () => {
  it("one row, one registration, one stripped prompt: the first live instance claims the call", async () => {
    const world = await makeWorld({ engine: "enforce", roles: {} });
    world.seed(KEYS.medium, 0, 20);
    world.seed(KEYS.heavy, 20, 0);
    await world.start();
    await world.start();
    expect(world.allToolHooks["execute.before"]).toHaveLength(2);
    const event: any = { tool: "subagent", input: { description: "d", agent: "medium", prompt: IMPLEMENT(), sessionID: "child-two" }, sessionID: "root", agent: "build", messageID: "m", id: "call-two-instances" };
    for (const hook of world.allToolHooks["execute.before"]!) await hook(event); // the host hands the SAME event to each instance
    // a resume is never switched (A30), but it is still stripped, logged once and registered once
    expect(event.input).toMatchObject({ agent: "medium", prompt: "Implement the change in src/a.ts.", sessionID: "child-two" });
    expect(event.input.model).toBeUndefined();
    const rows = await world.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ switched: false, resume: true });
    expect(lookupDispatch("child-two")).toMatchObject({ agent: "medium", decisionID: rows[0]!.decisionID });
    // a static instance never claims a call another instance can act on
    expect(world.ctx.session.get).toHaveBeenCalledTimes(1);
  });
});

describe("floorTier lift needs (QA-2.2-7)", () => {
  it("is not lifted to a floor tier whose evaluated permissions miss the task's needs", async () => {
    const world = await makeWorld({ engine: "enforce" }, { enforcement: { verify: { testBaseline: false }, escalate: { floorTier: "medium" } } });
    world.agents.medium.permissions = READ_ONLY;
    await world.start();
    const after = await routed(world, { agent: "fast", prompt: "[route class=search risk=low scope=single needs=shell]\nRun the script." });
    expect(after).toMatchObject({ agent: "fast" });
    expect(after.model).toBeUndefined();
    const [row] = await world.rows();
    expect(row).toMatchObject({ switched: false });
    expect(row!.reason).not.toContain("lift:floor");
  });

  it("a lift has its own reason code, and the floor tier must be permitted for the parent", async () => {
    const world = await makeWorld({ engine: "enforce" }, { enforcement: { verify: { testBaseline: false }, escalate: { floorTier: "medium" } } });
    await world.start();
    await routed(world, { agent: "fast", prompt: "[route class=search risk=low scope=single]\nFind it." });
    const [lifted] = await world.rows();
    expect(lifted!.reason.startsWith("lift:floor: ")).toBe(true);
    expect(lifted).toMatchObject({ switched: true, best: { agent: "medium" } });
    world.session.current = { ...(world.session.current as Record<string, unknown>), permissions: [{ action: "subagent", resource: "*", effect: "allow" }, { action: "subagent", resource: "medium", effect: "deny" }] };
    const denied = await routed(world, { agent: "fast", prompt: "[route class=search risk=low scope=single]\nFind it again." });
    expect(denied.agent).toBe("fast");
  });
});

describe("the generated R: line is keyed on the dispatching agent's permissions (QA-2.2-9)", () => {
  it("a change of the parent's rules is not served from the memo of the earlier rules", async () => {
    const world = await makeWorld({ engine: "advise", margin: 0.1, roles: { search: ["explore"], recon: ["explore"] } });
    world.seed(KEYS.fast, 0, 20);
    world.seed(KEYS.explore, 20, 0);
    world.seed(KEYS.reconFast, 0, 20);
    world.seed(KEYS.reconExplore, 20, 0);
    const cfg = loadConfig(world.home);
    const protocol = assembleSystemPrompt(cfg, undefined, false);
    await world.start({ "experimental.chat.system.transform": async (_input: unknown, output: { system: string[] }) => { output.system.push(protocol); } });
    const turn = (): any => ({ sessionID: "root", agent: "build", model: { providerID: "anthropic", id: "claude-opus-5-5" }, options: {}, system: [], messages: [] });
    const first = turn();
    await world.sessionHooks.context(first);
    expect(first.system[0].text).toContain("by class:");
    world.session.current = { ...(world.session.current as Record<string, unknown>), permissions: [{ action: "subagent", resource: "*", effect: "allow" }, { action: "subagent", resource: "explore", effect: "deny" }] };
    const second = turn();
    await world.sessionHooks.context(second);
    expect(second.system[0].text).not.toContain("by class:");
    const third = turn();
    world.session.current = { ...(world.session.current as Record<string, unknown>), permissions: [{ action: "subagent", resource: "*", effect: "allow" }] };
    await world.sessionHooks.context(third);
    expect(third.system[0].text).toContain("by class:");
  });
});

describe("disposal during preparation (QA-2.2-13)", () => {
  it("a dispatch whose runtime was disposed while it waited for the catalog is left alone and logs no row", async () => {
    const world = await makeWorld({ engine: "shadow" });
    let release: (models: unknown[]) => void = () => undefined;
    world.ctx.model.list.mockImplementation(() => new Promise((resolve) => { release = (models) => resolve({ data: models }); }));
    const cleanup = await world.start();
    const call = dispatch(world, { agent: "medium", prompt: IMPLEMENT(), sessionID: "child-late" });
    const pending = call.run();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await cleanup();
    release(catalog());
    await pending;
    expect(call.event.input).toMatchObject({ agent: "medium", prompt: IMPLEMENT() }); // not even the route line was stripped
    expect(lookupDispatch("child-late")).toBeUndefined();
    expect(await world.rows()).toEqual([]);
  });
});
describe("single writer with the delegate runner (QA-2.2-1, QA-2.3-1)", () => {
  const FACTS = { class: "implement", risk: "high", scope: "single", needs: [] as string[], confidence: 1, source: "rules" };
  const MODEL = { providerID: "anthropic", modelID: "claude-sonnet-5-5", variant: "medium" };
  const PLAN: AttemptPlan = { step: "dispatch", tier: "medium", agent: "medium", model: MODEL };

  /** A world whose engine WOULD switch an orchestrator's `medium` implement dispatch to heavy, plus a real v2 runtime and recorder. */
  async function runnerWorld(routing: Record<string, unknown> = { engine: "enforce", roles: {} }) {
    const world = await makeWorld(routing);
    world.seed(KEYS.medium, 0, 20);
    world.seed(KEYS.heavy, 20, 0);
    const runtime = createV2Runtime(world.ctx as never);
    const recorder = createAttemptRecorder({ host: "v2", config: () => loadConfig(world.home), logger });
    const toolContext = { sessionID: "root", agent: "build", messageID: "message", id: "call-delegate", signal: new AbortController().signal, progress: vi.fn(async () => {}) } as never;
    cleanups.push(async () => { await recorder.dispose(); await runtime.dispose(); });
    const runChild = (request: { agent?: string; prompt: string; model?: { providerID: string; modelID: string; variant?: string }; resumeSessionID?: string; system?: string }, plan: AttemptPlan | null = PLAN) =>
      runtime.withToolContext(toolContext, () => runtime.childRunner.run({
        ...request,
        onCreated: async (sessionID) => {
          if (plan !== null) recorder.record({ childSessionID: sessionID, parentSessionID: "root", plan, facts: FACTS, acceptance: "none", resumed: request.resumeSessionID !== undefined });
        },
      }));
    return { world, runtime, recorder, runChild };
  }

  it("enforce: a runner dispatch through the 2.2 execute.before reaches the host exactly as the runner wrote it, with one decision row (the recorder's) and one registration", async () => {
    const { world, runtime, runChild } = await runnerWorld();
    await world.start({}, runtime);
    await runChild({ agent: "medium", prompt: IMPLEMENT(), model: MODEL });
    expect(world.native).toEqual([{
      agent: "medium", description: "Router medium delegation", prompt: IMPLEMENT(), model: `${SONNET}#medium`, background: false,
    }]); // no agent/model rewrite (the engine would have gone to heavy), no route-line strip
    const rows = await world.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ decisionID: expect.stringMatching(/^ladder-/), step: "dispatch", switched: false, childSessionID: "child-1", mode: "enforce" });
    expect(dispatchCount()).toBe(1);
    expect(lookupDispatch("child-1")).toMatchObject({ agent: "medium", model: SONNET, variant: "medium", decisionID: rows[0]!.decisionID, step: "dispatch", attemptIndex: 0 });
    expect(world.ctx.session.get).not.toHaveBeenCalled(); // the 2.2 router did not even read the session
    expect(runnerTokenCount()).toBe(0); // the mark was spent by the hook and withdrawn by the runner
    // the host's session.created for the runner child changes nothing
    await vi.waitFor(() => { expect(world.ctx.model.list).toBeDefined(); });
    world.emit({ type: "session.deleted", data: { sessionID: "barrier" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lookupDispatch("child-1")).toMatchObject({ attemptIndex: 0, decisionID: rows[0]!.decisionID });
    expect(await world.rows()).toHaveLength(1);
  });

  it("a normal orchestrator dispatch with the same agent and prompt and no mark is still routed", async () => {
    const { world, runtime, runChild } = await runnerWorld();
    await world.start({}, runtime);
    await runChild({ agent: "medium", prompt: IMPLEMENT(), model: MODEL });
    const orchestrator = await routed(world, { agent: "medium", prompt: IMPLEMENT() }, { id: "call-orchestrator" });
    expect(orchestrator).toMatchObject({ agent: "heavy", model: `${OPUS}#xhigh`, prompt: "Implement the change in src/a.ts." });
    const rows = await world.rows();
    expect(rows.map((row) => [row.decisionID.startsWith("ladder-"), row.switched])).toEqual([[true, false], [false, true]]);
  });

  const RUNNER_TITLE = "Router medium delegation";

  it("a mark is spent by exactly one hook call: a second runner-titled call without a mark is routed", async () => {
    const { world } = await runnerWorld();
    await world.start();
    markRunnerDispatch({ parentSessionID: "root", agent: "medium", prompt: IMPLEMENT() });
    const first = await routed(world, { agent: "medium", description: RUNNER_TITLE, prompt: IMPLEMENT() });
    expect(first).toMatchObject({ agent: "medium", prompt: IMPLEMENT() }); // the announced call: untouched
    const second = await routed(world, { agent: "medium", description: RUNNER_TITLE, prompt: IMPLEMENT() });
    expect(second).toMatchObject({ agent: "heavy", prompt: "Implement the change in src/a.ts." });
    expect(await world.rows()).toHaveLength(1);
  });

  it("QA-INT-1: an orchestrator dispatch with the identical agent and prompt does not consume the runner's mark", async () => {
    const { world } = await runnerWorld();
    await world.start();
    markRunnerDispatch({ parentSessionID: "root", agent: "medium", prompt: IMPLEMENT() });
    const orchestrator = await routed(world, { agent: "medium", prompt: IMPLEMENT() }); // description "work item": not the runner's
    expect(orchestrator).toMatchObject({ agent: "heavy", prompt: "Implement the change in src/a.ts." });
    expect(runnerTokenCount()).toBe(1); // the mark is still there ...
    const runner = await routed(world, { agent: "medium", description: RUNNER_TITLE, prompt: IMPLEMENT() });
    expect(runner).toMatchObject({ agent: "medium", prompt: IMPLEMENT() }); // ... for the runner's own call
    expect(runnerTokenCount()).toBe(0);
    expect(await world.rows()).toHaveLength(1);
  });

  it("QA-INT-1: a runner call whose prompt another plugin rewrote still finds its mark (by session, agent and title), with a warning", async () => {
    const { world, runtime, runChild } = await runnerWorld();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // a foreign plugin's hook runs before ours and rewrites the prompt
    world.allToolHooks["execute.before"] = [async (event: any) => { event.input.prompt = `[another plugin]\n${event.input.prompt}`; }];
    await world.start({}, runtime);
    await runChild({ agent: "medium", prompt: IMPLEMENT(), model: MODEL });
    expect(world.native[0]).toMatchObject({ agent: "medium", model: `${SONNET}#medium`, prompt: `[another plugin]\n${IMPLEMENT()}` }); // not routed, not stripped
    expect(await world.rows()).toHaveLength(1); // the recorder's
    expect(runnerTokenCount()).toBe(0);
    expect(warn.mock.calls.flat().join("\n")).toContain("another prompt than the one it announced");
  });

  it("a mark is keyed on session and agent (and the prompt, unless the call is runner-titled): other sessions and agents are routed", async () => {
    const { world } = await runnerWorld();
    await world.start();
    markRunnerDispatch({ parentSessionID: "root", agent: "fast", prompt: IMPLEMENT() });
    markRunnerDispatch({ parentSessionID: "other", agent: "medium", prompt: IMPLEMENT() });
    const routedAway = await routed(world, { agent: "medium", description: RUNNER_TITLE, prompt: IMPLEMENT() });
    expect(routedAway).toMatchObject({ agent: "heavy" });
    expect(runnerTokenCount()).toBe(2);
  });

  it("a mark expires: past its time limit the same dispatch is routed", async () => {
    const { world } = await runnerWorld();
    await world.start();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      markRunnerDispatch({ parentSessionID: "root", agent: "medium", prompt: IMPLEMENT() });
      vi.setSystemTime(Date.now() + 121_000);
      const after = await routed(world, { agent: "medium", description: RUNNER_TITLE, prompt: IMPLEMENT() });
      expect(after).toMatchObject({ agent: "heavy" });
      expect(runnerTokenCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("a grader call (the runner's verification child) is not routed and writes nothing", async () => {
    const { world, runtime, runChild } = await runnerWorld();
    await world.start({}, runtime);
    await runChild({ prompt: "Grade this result", system: "You are a grader" }, null);
    expect(world.native).toEqual([{ agent: V2_GRADER_AGENT, description: "Router result verification", prompt: "Grade this result", background: false }]);
    expect(await world.rows()).toEqual([]);
    expect(dispatchCount()).toBe(0);
    expect(runnerTokenCount()).toBe(0);
  });

  it("a resumed runner attempt is left alone too, and the recorder's second registration is its own attempt", async () => {
    const { world, runtime, runChild } = await runnerWorld();
    world.session.current = { ...(world.session.current as Record<string, unknown>) };
    await world.start({}, runtime);
    await runChild({ agent: "medium", prompt: IMPLEMENT(), model: MODEL });
    world.ctx.session.get.mockImplementation(async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, parentID: "root", agent: "medium" }));
    await runChild({ agent: "medium", prompt: "[router escalation] retry", model: { ...MODEL, variant: "high" }, resumeSessionID: "child-1" }, { ...PLAN, step: "variant", model: { ...MODEL, variant: "high" } });
    expect(world.native[1]).toEqual({
      agent: "medium", description: "Router medium delegation", prompt: "[router escalation] retry", model: `${SONNET}#high`, sessionID: "child-1", background: false,
    });
    const rows = await world.rows();
    expect(rows.map((row) => [row.step, row.resume, row.decisionID.startsWith("ladder-")])).toEqual([["dispatch", false, true], ["variant", true, true]]);
    expect(lookupDispatch("child-1")).toMatchObject({ step: "variant", attemptIndex: 1 });
  });

  it("two plugin instances: the instance that consumes the mark and the one that does not both leave the runner's call alone", async () => {
    const { world, runtime, runChild } = await runnerWorld();
    await world.start({}, runtime);
    await world.start({}, runtime);
    expect(world.allToolHooks["execute.before"]).toHaveLength(2);
    await runChild({ agent: "medium", prompt: IMPLEMENT(), model: MODEL });
    expect(world.native[0]).toMatchObject({ agent: "medium", prompt: IMPLEMENT(), model: `${SONNET}#medium` });
    expect(await world.rows()).toHaveLength(1);
    expect(dispatchCount()).toBe(1);
  });

  it("the runner's child is never claimed for a waiting orchestrator dispatch, by its title or because it is already registered", async () => {
    const { world } = await runnerWorld({ engine: "shadow", roles: {} });
    await world.start();
    const call = dispatch(world, { agent: "medium", description: "orchestrator work", prompt: IMPLEMENT() });
    await call.run();
    world.emit({ type: "session.created", data: { sessionID: "runner-child", parentID: "root", agent: "medium", title: "Router medium delegation" } });
    world.emit({ type: "session.created", data: { sessionID: "runner-grader", parentID: "root", agent: "medium", title: "Router result verification" } });
    const { rememberDispatch } = await import("../../src/router/sessions");
    const registered = rememberDispatch("runner-owned", { facts: FACTS, agent: "medium", model: SONNET, variant: "medium", parentSessionID: "root", decisionID: "ladder-x", step: "variant" });
    world.emit({ type: "session.created", data: { sessionID: "runner-owned", parentID: "root", agent: "medium", title: "something else" } });
    world.emit({ type: "session.created", data: { sessionID: "orchestrator-child", parentID: "root", agent: "medium", title: "orchestrator work" } });
    await vi.waitFor(() => { expect(lookupDispatch("orchestrator-child")).toBeDefined(); });
    expect(lookupDispatch("runner-child")).toBeUndefined();
    expect(lookupDispatch("runner-grader")).toBeUndefined();
    expect(lookupDispatch("runner-owned")).toBe(registered);
    expect(lookupDispatch("orchestrator-child")).toMatchObject({ parentSessionID: "root", agent: "medium", facts: { class: "implement" } });
  });

  it("the title the guard recognises is the one the runner sends", async () => {
    const { world, runtime, runChild } = await runnerWorld();
    await world.start({}, runtime);
    await runChild({ agent: "medium", prompt: "x", model: MODEL });
    await runChild({ prompt: "y", system: "s" }, null);
    expect(world.native.map((input) => input.description)).toEqual(["Router medium delegation", "Router result verification"]);
  });
});

describe("a correction keeps what the registry has seen of the execution (QA-2.3-1a)", () => {
  it("2.2 fixing a wrong claim at execute.after keeps the child's step context and end state", async () => {
    const world = await makeWorld({ engine: "shadow" });
    await world.start();
    const a = dispatch(world, { agent: "medium", description: "same", prompt: IMPLEMENT() });
    const b = dispatch(world, { agent: "medium", description: "same", prompt: "[route class=debug risk=low scope=single]\nFix it." });
    await a.run();
    await b.run();
    world.emit({ type: "session.created", data: { sessionID: "X", parentID: "root", agent: "medium", title: "same" } });
    world.emit({ type: "session.created", data: { sessionID: "C", parentID: "root", agent: "medium", title: "same" } });
    await vi.waitFor(() => { expect(lookupDispatch("C")).toBeDefined(); });
    // the runner-visible observations of C's execution, made while it was registered under the wrong dispatch
    noteStepContext("C", 4321);
    noteExecutionEnded("C");
    expect(lastStepContext("C")).toBe(4321);
    const result = (child: string) => ({ output: { sessionID: child, status: "completed", output: "" }, content: [], metadata: { sessionID: child, status: "completed" } });
    await world.toolHooks["execute.after"]({ id: a.event.id, tool: "subagent", status: "completed", sessionID: "root", result: result("C") });
    const [rowA] = await world.rows();
    expect(lookupDispatch("C")!.decisionID).toBe(rowA!.decisionID); // corrected ...
    expect(lastStepContext("C")).toBe(4321); // ... and the execution's state survived the re-registration
  });
});
describe("round 2 (QA-2.2-R2-1, R2-2, R2-7)", () => {
  const completed = (child: string) => ({ output: { sessionID: child, status: "completed", output: "" }, content: [], metadata: { sessionID: child, status: "completed" } });
  const FACTS = { class: "implement", risk: "low", scope: "single", needs: [] as string[], confidence: 0.9, source: "rules" };

  describe("R2-1: a resume the host rejects after the hooks keeps the live registration", () => {
    it("restores the child's previous registration (facts, decision and attempt id) when the call ends without a result", async () => {
      const world = await makeWorld({ engine: "shadow" });
      await world.start();
      const live = rememberDispatch("child-live", { facts: FACTS, agent: "fast", model: SONNET, variant: "low", tier: "fast", parentSessionID: "root", decisionID: "live-decision", step: "dispatch" });
      const call = dispatch(world, { agent: "medium", prompt: IMPLEMENT(), sessionID: "child-live" });
      await call.run();
      expect(lookupDispatch("child-live")).toMatchObject({ agent: "medium", step: "dispatch" });
      expect(lookupDispatch("child-live")!.decisionID).not.toBe("live-decision"); // the resume's own registration, made by commit
      await world.toolHooks["execute.after"]({ id: call.event.id, tool: "subagent", status: "failed", sessionID: "root" }); // the host rejected it
      const after = lookupDispatch("child-live")!;
      expect(after).toMatchObject({ agent: "fast", model: SONNET, variant: "low", tier: "fast", decisionID: "live-decision", attemptId: live.attemptId });
    });

    it("forgets the registration of a resumed child that had none; keeps it when the resume completed", async () => {
      const world = await makeWorld({ engine: "shadow" });
      await world.start();
      const unknown = dispatch(world, { agent: "medium", prompt: IMPLEMENT(), sessionID: "child-unknown" });
      await unknown.run();
      expect(lookupDispatch("child-unknown")).toBeDefined();
      await world.toolHooks["execute.after"]({ id: unknown.event.id, tool: "subagent", status: "failed", sessionID: "root" });
      expect(lookupDispatch("child-unknown")).toBeUndefined();
      const ok = dispatch(world, { agent: "medium", prompt: IMPLEMENT(), sessionID: "child-ok" });
      await ok.run();
      await world.toolHooks["execute.after"]({ id: ok.event.id, tool: "subagent", status: "completed", sessionID: "root", result: completed("child-ok") });
      expect(lookupDispatch("child-ok")).toMatchObject({ agent: "medium" });
    });

    it("leaves a registration someone else made in the meantime alone", async () => {
      const world = await makeWorld({ engine: "shadow" });
      await world.start();
      const call = dispatch(world, { agent: "medium", prompt: IMPLEMENT(), sessionID: "child-taken" });
      await call.run();
      const theirs = rememberDispatch("child-taken", { facts: FACTS, agent: "heavy", model: OPUS, variant: "xhigh", parentSessionID: "root", decisionID: "ladder-theirs", step: "variant" });
      await world.toolHooks["execute.after"]({ id: call.event.id, tool: "subagent", status: "failed", sessionID: "root" });
      expect(lookupDispatch("child-taken")).toBe(theirs);
    });

    it("a hook chain that throws after a resume registration (onCallFinished) never reaches commit: nothing to undo", async () => {
      const world = await makeWorld({ engine: "shadow" });
      await world.start({ "tool.execute.before": async () => { throw new Error("depth limit"); } });
      const live = rememberDispatch("child-live", { facts: FACTS, agent: "fast", model: SONNET, variant: "low", parentSessionID: "root", decisionID: "live-decision" });
      await expect(dispatch(world, { agent: "medium", prompt: IMPLEMENT(), sessionID: "child-live" }).run()).rejects.toThrow("depth limit");
      expect(lookupDispatch("child-live")).toBe(live);
    });
  });

  describe("R2-2: the session decides which instance acts", () => {
    async function twoLocations() {
      const world = await makeWorld({ engine: "shadow", roles: {} });
      const dirB = join(world.home, "projB");
      mkdirSync(join(dirB, ".opencode"), { recursive: true });
      writeFileSync(join(dirB, ".opencode", "opencode-model-router.overrides.jsonc"), JSON.stringify({ routing: { engine: "static" } }));
      invalidateConfigCache();
      expect(loadConfig(dirB).routing?.engine).toBe("static"); // B's location is static, A's (the global config) is shadow
      expect(loadConfig(world.home).routing?.engine).toBe("shadow");
      await world.start(); // instance A: world.home
      const cleanupB = await registerV2Hooks({ ...world.ctx, location: { directory: dirB, project: { directory: dirB } } } as unknown as Context, {} as unknown as Hooks);
      cleanups.push(cleanupB);
      expect(world.allToolHooks["execute.before"]).toHaveLength(2);
      return { world, dirB };
    }

    const inDirectory = (world: World, directory: string | undefined) => {
      world.session.current = { id: "root", agent: "build", model: { providerID: "anthropic", id: "claude-opus-5-5" }, permissions: [{ action: "subagent", resource: "*", effect: "allow" }], ...(directory === undefined ? {} : { location: { directory } }) };
    };
    const deliver = async (world: World, order: "A-first" | "B-first") => {
      const hooks = order === "A-first" ? world.allToolHooks["execute.before"]! : [...world.allToolHooks["execute.before"]!].reverse();
      const event: any = { tool: "subagent", input: { description: "d", agent: "medium", prompt: IMPLEMENT() }, sessionID: "root", agent: "build", messageID: "m", id: `call-two-${++seq}` };
      for (const hook of hooks) await hook(event);
      return event.input as Record<string, any>;
    };

    it("a static location receiving its own hook stays untouched (measured host delivery)", async () => {
      for (const order of ["A-first", "B-first"] as const) {
        const { world, dirB } = await twoLocations();
        inDirectory(world, dirB);
        const event = dispatch(world, { agent: "medium", prompt: IMPLEMENT() }).event;
        await world.allToolHooks["execute.before"]![1]!(event); // only the static location receives this hook
        expect(event.input).toMatchObject({ agent: "medium", prompt: IMPLEMENT() }); // not stripped, not rewritten
        expect(await world.rows()).toEqual([]);
        expect(lookupDispatch("anything")).toBeUndefined();
        await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
        for (const w of worlds.splice(0)) { await w.bundle.release(); rmSync(w.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
      }
    });

    it("a session of the live location is routed once, whichever instance sees the event first", async () => {
      for (const order of ["A-first", "B-first"] as const) {
        const { world } = await twoLocations();
        inDirectory(world, world.home);
        const input = await deliver(world, order);
        expect(input).toMatchObject({ agent: "medium", prompt: "Implement the change in src/a.ts." });
        expect(await world.rows()).toHaveLength(1);
        await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
        for (const w of worlds.splice(0)) { await w.bundle.release(); rmSync(w.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
      }
    });

    it("a session that names no directory falls back to the first live instance; the directory compares by value, not spelling", async () => {
      const { world } = await twoLocations();
      inDirectory(world, undefined);
      expect(await deliver(world, "B-first")).toMatchObject({ prompt: "Implement the change in src/a.ts." });
      const respelled = process.platform === "win32" ? `${world.home.toUpperCase()}\\` : `${world.home}/`;
      inDirectory(world, respelled);
      expect(await deliver(world, "A-first")).toMatchObject({ prompt: "Implement the change in src/a.ts." });
      expect(await world.rows()).toHaveLength(2);
    });
  });

  describe("R2-7: a mis-claimed child is marked, not forgotten, and its own dispatch's result takes it over", () => {
    it("crossed claims where B's result comes first: the child B mis-claimed stays registered until A's result", async () => {
      const world = await makeWorld({ engine: "shadow" });
      await world.start();
      const a = dispatch(world, { agent: "medium", description: "same", prompt: IMPLEMENT() });
      const b = dispatch(world, { agent: "medium", description: "same", prompt: "[route class=debug risk=low scope=single]\nFix it." });
      await a.run();
      await b.run();
      world.emit({ type: "session.created", data: { sessionID: "X", parentID: "root", agent: "medium", title: "same" } }); // claims A (wrong: X is B's)
      world.emit({ type: "session.created", data: { sessionID: "C", parentID: "root", agent: "medium", title: "same" } }); // claims B (wrong: C is A's)
      await vi.waitFor(() => { expect(lookupDispatch("C")).toBeDefined(); });
      const [rowA, rowB] = await world.rows();
      await world.toolHooks["execute.after"]({ id: b.event.id, tool: "subagent", status: "completed", sessionID: "root", result: completed("X") }); // B's result first
      expect(lookupDispatch("X")!.decisionID).toBe(rowB!.decisionID); // B took X over
      expect(lookupDispatch("C")).toBeDefined(); // ... and C, B's wrong claim, is NOT forgotten: its steps keep being counted
      expect(lookupDispatch("C")!.decisionID).toBe(rowB!.decisionID);
      await world.toolHooks["execute.after"]({ id: a.event.id, tool: "subagent", status: "completed", sessionID: "root", result: completed("C") }); // A's result
      expect(lookupDispatch("C")!.decisionID).toBe(rowA!.decisionID); // A's own result took it over
      expect(lookupDispatch("C")!.facts.class).toBe("implement");
      expect(lookupDispatch("X")!.facts.class).toBe("debug");
    });
  });
});
describe("instance selection: the receiving live instance acts; call claims de-duplicate (QA-G-A6)", () => {
  const sessionIn = (world: World, directory: string): void => {
    world.session.current = { id: "root", agent: "build", model: { providerID: "anthropic", id: "claude-opus-5-5" }, permissions: [{ action: "subagent", resource: "*", effect: "allow" }], location: { directory } };
  };
  const deliver = async (world: World, order: "in-order" | "reversed" = "in-order") => {
    const hooks = order === "in-order" ? world.allToolHooks["execute.before"]! : [...world.allToolHooks["execute.before"]!].reverse();
    const event: any = { tool: "subagent", input: { description: "d", agent: "medium", prompt: IMPLEMENT() }, sessionID: "root", agent: "build", messageID: "m", id: `call-sel-${++seq}` };
    for (const hook of hooks) await hook(event);
    return event.input as Record<string, any>;
  };
  /** A second plugin instance at `directory`, with its own `agent.list` spy: only the instance that acts asks the host for the agents. */
  const instanceAt = async (world: World, directory: string, engine?: "static" | "shadow") => {
    mkdirSync(directory, { recursive: true });
    if (engine !== undefined) {
      mkdirSync(join(directory, ".opencode"), { recursive: true });
      writeFileSync(join(directory, ".opencode", "opencode-model-router.overrides.jsonc"), JSON.stringify({ routing: { engine } }));
      invalidateConfigCache();
    }
    const list = vi.fn(async () => ({ data: Object.values(world.agents) }));
    const ctx = { ...world.ctx, location: { directory, project: { directory } }, agent: { ...world.ctx.agent, list } };
    cleanups.push(await registerV2Hooks(ctx as unknown as Context, {} as unknown as Hooks));
    list.mockClear();
    return list;
  };
  const stripped = "Implement the change in src/a.ts.";

  it("R2-12: separate instances at the same clock tick and sequence emit distinct decision IDs", async () => {
    const world = await makeWorld({ engine: "shadow", roles: {} });
    await world.start();
    await instanceAt(world, join(world.home, "other"));
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    try {
      await deliver(world, "in-order");
      await deliver(world, "reversed");
      const rows = await world.rows();
      expect(rows).toHaveLength(2);
      expect(rows[0]!.decisionID).not.toBe(rows[1]!.decisionID);
      expect(rows.every((row) => /:[a-f0-9]{16}:1$/.test(row.decisionID))).toBe(true);
    } finally { clock.mockRestore(); }
  });

  it("one instance, the session in a subdirectory of its project: routed", async () => {
    const world = await makeWorld({ engine: "shadow", roles: {} });
    await world.start();
    sessionIn(world, join(world.home, "packages", "app", "src"));
    expect(await deliver(world)).toMatchObject({ prompt: stripped });
    expect(await world.rows()).toHaveLength(1);
  });

  it("R2-1: one instance routes an unrelated session directory without inventing another owner", async () => {
    const world = await makeWorld({ engine: "shadow", roles: {} });
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    await world.start();
    sessionIn(world, process.platform === "win32" ? "Z:\\no\\such\\place" : "/no/such/place");
    expect(await deliver(world)).toMatchObject({ prompt: stripped });
    expect(await deliver(world)).toMatchObject({ prompt: stripped });
    expect(await world.rows()).toHaveLength(2);
    const lines = debug.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("the receiving instance acts"));
    expect(lines).toHaveLength(0);
  });

  it("two live instances: the first receiving instance acts, even if another owns the directory", async () => {
    for (const order of ["in-order", "reversed"] as const) {
      const world = await makeWorld({ engine: "shadow", roles: {} });
      await world.start();
      const listA = world.ctx.agent.list as ReturnType<typeof vi.fn>;
      const dirB = join(world.home, "projLive");
      const listB = await instanceAt(world, dirB);
      listA.mockClear();
      sessionIn(world, dirB);
      expect(await deliver(world, order)).toMatchObject({ prompt: stripped });
      expect(order === "in-order" ? listA : listB).toHaveBeenCalledTimes(1);
      expect(order === "in-order" ? listB : listA).not.toHaveBeenCalled();
      expect(await world.rows()).toHaveLength(1);
      listA.mockClear();
      listB.mockClear();
      sessionIn(world, world.home);
      expect(await deliver(world, order)).toMatchObject({ prompt: stripped });
      expect(listA).not.toHaveBeenCalled(); // the first receiver's agent list is cached
      expect(listB).not.toHaveBeenCalled();
      expect(await world.rows()).toHaveLength(2);
      await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
      for (const w of worlds.splice(0)) { await w.bundle.release(); rmSync(w.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    }
  });

  it("static at the root and shadow at a sub-project: a session in the sub-project (or below it) belongs to the shadow instance; elsewhere in the root to the static one", async () => {
    const world = await makeWorld({ engine: "static", roles: {} });
    await world.start(); // the root instance: the global config says static
    const listRoot = world.ctx.agent.list as ReturnType<typeof vi.fn>;
    const sub = join(world.home, "sub");
    const listSub = await instanceAt(world, sub, "shadow");
    expect(loadConfig(sub).routing?.engine).toBe("shadow");
    expect(loadConfig(world.home).routing?.engine).toBe("static");
    listRoot.mockClear();
    let expectedRows = 0;
    for (const directory of [sub, join(sub, "deep", "er")]) {
      sessionIn(world, directory);
      expect(await deliver(world), `session in ${directory}`).toMatchObject({ prompt: stripped });
      expect(await world.rows()).toHaveLength(++expectedRows); // the shadow instance acted (the root one is static and could not)
    }
    expect(listSub).toHaveBeenCalledTimes(1); // its agent list is cached for the second dispatch
    expect(listRoot).not.toHaveBeenCalled();
    // A measured host sends a root location's hook only to that (static) instance.
    sessionIn(world, join(world.home, "other"));
    const event = dispatch(world, { agent: "medium", prompt: IMPLEMENT() }).event;
    await world.allToolHooks["execute.before"]![0]!(event);
    expect(event.input).toMatchObject({ prompt: IMPLEMENT() });
    expect(await world.rows()).toHaveLength(2);
  });

  it("does not drop the only delivered hook when another live instance owns the session directory", async () => {
    const world = await makeWorld({ engine: "shadow", roles: {} });
    await world.start();
    const dirB = join(world.home, "owner");
    const listB = await instanceAt(world, dirB);
    sessionIn(world, dirB);
    const event = dispatch(world, { agent: "medium", prompt: IMPLEMENT() }).event;
    await world.allToolHooks["execute.before"]![0]!(event);
    expect(event.input).toMatchObject({ prompt: stripped });
    expect(await world.rows()).toHaveLength(1);
    expect(listB).not.toHaveBeenCalled();
  });

  it("a disposed instance no longer owns anything: the remaining one takes its sessions through the fallback", async () => {
    const world = await makeWorld({ engine: "shadow", roles: {} });
    await world.start();
    const listA = world.ctx.agent.list as ReturnType<typeof vi.fn>;
    const dirB = join(world.home, "gone");
    mkdirSync(dirB, { recursive: true });
    const ctxB = { ...world.ctx, location: { directory: dirB, project: { directory: dirB } } };
    const disposeB = await registerV2Hooks(ctxB as unknown as Context, {} as unknown as Hooks);
    sessionIn(world, dirB);
    await disposeB(); // its hooks stay registered in the fake bus, but its directory is no longer owned
    listA.mockClear();
    const event: any = { tool: "subagent", input: { description: "d", agent: "medium", prompt: IMPLEMENT() }, sessionID: "root", agent: "build", messageID: "m", id: `call-gone-${++seq}` };
    await world.allToolHooks["execute.before"]![0]!(event); // instance A's hook
    expect(event.input).toMatchObject({ prompt: stripped });
    expect(listA).toHaveBeenCalledTimes(1);
  });
});
describe("latency", { timeout: 60_000 }, () => {
  it("the local routing path targets <5 ms per dispatch over 100 dispatches (warm; 10x CI/coverage margin)", async () => {
    const world = await makeWorld({ engine: "shadow" });
    await world.start();
    await routed(world, { agent: "medium", prompt: IMPLEMENT() }); // warms the catalog, the agent list and the store
    // CPU time of this test process (each test file runs in its own process), not wall time: the plan's budget is for the
    // local path, and a loaded machine (the whole suite runs files in parallel) stretches wall time without making the path
    // any more expensive. Best of three batches of 100.
    const perDispatch: number[] = [];
    for (let batch = 0; batch < 3; batch++) {
      const started = process.cpuUsage();
      for (let i = 0; i < 100; i++) await routed(world, { agent: "medium", prompt: IMPLEMENT(), sessionID: `child-${batch}-${i}` });
      const used = process.cpuUsage(started);
      perDispatch.push((used.user + used.system) / 1000 / 100);
    }
    expect(Math.min(...perDispatch)).toBeLessThan(50);
  });
});
