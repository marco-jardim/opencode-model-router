/**
 * #90 P1.2: the server→TUI effort channel (OpenCode v2 only). The store and the `effortOf` handler (src/tui/effort-channel.ts), the
 * rpc definition (src/tui/effort-rpc.ts), the registration's feature detection, and the v2 adapter's wiring
 * (src/compat/v2-hooks.ts): registered once per setup, recorded after the legacy `chat.params` bridge for every session, read-only
 * on `event.options`, and inert on the v1 plugin path (src/index.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { Hooks } from "@opencode-ai/plugin";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Pass-through spies: every store the code creates, every write to it, every channel registration.
const channel = vi.hoisted(() => ({
  stores: 0, registers: 0, records: [] as Array<{ sessionID: string; turn: unknown }>,
}));
vi.mock("../../src/tui/effort-channel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tui/effort-channel")>();
  return {
    ...actual,
    createEffortStore: (...args: Parameters<typeof actual.createEffortStore>) => {
      const store = actual.createEffortStore(...args);
      const record = store.record;
      store.record = (sessionID, turn) => {
        channel.records.push({ sessionID, turn });
        record(sessionID, turn);
      };
      channel.stores += 1;
      return store;
    },
    registerEffortChannel: (...args: Parameters<typeof actual.registerEffortChannel>) => {
      channel.registers += 1;
      return actual.registerEffortChannel(...args);
    },
  };
});
// The plugin's escalation override store (src/index.ts), captured so a test can escalate a child's effort directly.
const overrides = vi.hoisted(() => ({ stores: [] as Array<import("../../src/escalate/effort-override").EffortOverrideStore> }));
vi.mock("../../src/escalate/effort-override", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/escalate/effort-override")>();
  return {
    ...actual,
    createEffortOverrideStore: (...args: Parameters<typeof actual.createEffortOverrideStore>) => {
      const store = actual.createEffortOverrideStore(...args);
      overrides.stores.push(store);
      return store;
    },
  };
});

import { effortRpc, type EffortOfOutput } from "../../src/tui/effort-rpc";
import {
  appliedEffort, createEffortStore, EFFORT_STORE_MAX_SESSIONS, effortOfHandler, registerEffortChannel, type EffortStore,
} from "../../src/tui/effort-channel";
import { normalizeAgentOptions, registerV2Hooks } from "../../src/compat/v2-hooks";
import ModelRouterPlugin from "../../src/index";
import type { RouterPluginInput } from "../../src/compat/child-session";
import { invalidateConfigCache, loadConfig, overridePath } from "../../src/router/config";
import { getActiveTiers } from "../../src/router/protocol";
import { resetBindingRegistryForTests } from "../../src/routing/roles/binding";

// Adapter tests build the real plugin and adapter (config load, agent registration): above vitest's 5 s default on a loaded runner.
vi.setConfig({ testTimeout: 60_000 });

const temps: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
  channel.records.length = 0;
  overrides.stores.length = 0;
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  invalidateConfigCache();
  resetBindingRegistryForTests();
});

function temp(prefix = "omr-p12-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** HOME redirected to a temp dir whose global override holds `override`. */
function home(override: Record<string, unknown> = {}): string {
  const dir = temp("omr-p12-home-");
  vi.stubEnv("HOME", dir); vi.stubEnv("USERPROFILE", dir);
  vi.stubEnv("MODEL_ROUTER_ENFORCE", "");
  mkdirSync(dirname(overridePath()), { recursive: true });
  writeFileSync(overridePath(), JSON.stringify(override));
  invalidateConfigCache();
  return dir;
}

type Handlers = { effortOf: (input: unknown) => Promise<EffortOfOutput> };

/** A host rpc domain as the promise adapter builds it: callable, with `register` attached; records each registration. */
function fakeRpc(register?: (definition: unknown, handlers: Handlers) => Promise<unknown>) {
  const calls: Array<{ definition: unknown; handlers: Handlers }> = [];
  const dispose = vi.fn(async () => {});
  const spy = vi.fn(register ?? (async (definition: unknown, handlers: Handlers) => {
    calls.push({ definition, handlers });
    return { dispose, events: { emit: async () => {} } };
  }));
  const rpc = Object.assign(() => ({}), { register: spy });
  return {
    rpc, register: spy, dispose, calls,
    /** The handler that answers now (the host: the last registration of the id). */
    effortOf: (input: unknown): Promise<EffortOfOutput> => calls.at(-1)!.handlers.effortOf(input),
  };
}

type Hook = (event: Record<string, unknown>) => Promise<void>;

/** A minimal v2 host around the adapter (after test/unit/v2-hooks.test.ts and roles.registration.test.ts). */
function v2Host(directory: string, rpc?: unknown) {
  const sessionHooks: Record<string, Hook> = {};
  const hostDefaults = [{ action: "*", resource: "*", effect: "allow" }, { action: "external_directory", resource: "*", effect: "ask" }];
  const agents: Record<string, Record<string, unknown>> = {
    explore: { id: "explore", mode: "subagent", model: { providerID: "host", id: "explore" }, permissions: [...hostDefaults], request: { settings: {}, headers: {}, body: {} } },
    general: { id: "general", mode: "subagent", model: { providerID: "host", id: "general" }, permissions: [...hostDefaults], request: { settings: {}, headers: {}, body: {} } },
    build: { id: "build", mode: "primary", permissions: [...hostDefaults], request: { settings: {}, headers: {}, body: {} } },
  };
  const register = () => ({ dispose: vi.fn(async () => {}) });
  const sessions: Record<string, Record<string, unknown>> = {};
  const ctx = {
    location: { directory, project: { directory } },
    agent: {
      reload: vi.fn(async () => {}), list: vi.fn(async () => ({ data: Object.values(agents) })),
      transform: vi.fn(async (cb: (editor: unknown) => void) => {
        cb({ update: (id: string, apply: (agent: Record<string, unknown>) => void) => {
          agents[id] ??= { id, mode: "subagent", permissions: [...hostDefaults], request: { settings: {}, headers: {}, body: {} } };
          apply(agents[id]);
        } });
        return register();
      }),
    },
    command: { reload: vi.fn(async () => {}), transform: vi.fn(async (cb: (editor: unknown) => void) => { cb({ add: () => {} }); return register(); }) },
    tool: {
      transform: vi.fn(async (cb: (editor: unknown) => void) => { cb({ add: () => {}, update: () => {} }); return register(); }),
      hook: vi.fn(async () => register()),
    },
    session: {
      get: vi.fn(async ({ sessionID }: { sessionID: string }) => sessions[sessionID]
        ?? (sessionID === "root" ? { id: "root", agent: "build", location: { directory } } : { id: sessionID, parentID: "root", agent: "fast", location: { directory } })),
      update: vi.fn(async () => {}), context: vi.fn(async () => []),
      prompt: vi.fn(async () => {}), synthetic: vi.fn(async () => {}),
      hook: vi.fn(async (name: string, cb: Hook) => { sessionHooks[name] = cb; return register(); }),
    },
    permission: { hook: vi.fn(async () => register()) },
    event: { subscribe: async function* ({ signal }: { signal: AbortSignal }) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    } },
    ...(rpc === undefined ? {} : { rpc }),
  };
  return {
    ctx, agents, sessions, sessionHooks,
    async start(hooks: Record<string, unknown> = {}): Promise<() => Promise<void>> {
      const cleanup = await registerV2Hooks(ctx as unknown as Context, hooks as unknown as Hooks, undefined, {
        hostSettleMs: 0, listRegistrationWorktrees: async () => [],
      });
      cleanups.push(cleanup);
      return cleanup;
    },
    /** One request build of `sessionID` as `agent` (the host's `context` hook event); returns the event after the hooks ran. */
    async turn(sessionID: string, agent: string, model: Record<string, unknown>, options: Record<string, unknown> = { maxTokens: 32_000 }, tools: Record<string, unknown> = {}) {
      const event = { sessionID, agent, model, options, system: [], messages: [], tools };
      await sessionHooks.context!(event);
      return event;
    },
  };
}

/** The real plugin on v2 (src/index.ts with `routerHost: "v2"`), as the adapter's legacy hooks. */
async function v2Plugin(directory: string): Promise<Record<string, unknown>> {
  return await ModelRouterPlugin({
    directory, worktree: directory, routerHost: "v2",
    client: { session: { get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id } }) } },
  } as unknown as RouterPluginInput) as unknown as Record<string, unknown>;
}

const FABLE = { providerID: "anthropic", id: "claude-fable-5-1" };

// ---------------------------------------------------------------------------
// The rpc definition
// ---------------------------------------------------------------------------

describe("effortRpc (the shared definition)", () => {
  it("is a plain JSON-Schema definition: id, effortOf input/output, no events", () => {
    expect(effortRpc.id).toBe("opencode-model-router.effort");
    expect(Object.keys(effortRpc.methods)).toEqual(["effortOf"]);
    expect(effortRpc.events).toEqual({});
    expect(effortRpc.methods.effortOf.input).toEqual({
      type: "object", properties: { sessionID: { type: "string" } }, required: ["sessionID"], additionalProperties: false,
    });
    const output = effortRpc.methods.effortOf.output;
    expect(output.additionalProperties).toBe(false);
    expect(Object.keys(output.properties).sort()).toEqual(["agent", "at", "effort", "modelID", "providerID", "variant"]);
    expect(output.properties.at).toEqual({ type: "number" });
    expect("required" in output).toBe(false);
    expect(JSON.parse(JSON.stringify(effortRpc))).toEqual(effortRpc); // JSON-safe: nothing but data
  });
});

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

describe("effort store", () => {
  it("answers {} for an unknown session and a copy of the latest turn for a known one", () => {
    const store = createEffortStore();
    expect(store.lookup("nobody")).toEqual({});
    store.record("s1", { effort: "high", variant: "xhigh", providerID: "openai", modelID: "gpt-6", agent: "fast", at: 5 });
    const found = store.lookup("s1");
    expect(found).toEqual({ effort: "high", variant: "xhigh", providerID: "openai", modelID: "gpt-6", agent: "fast", at: 5 });
    (found as Record<string, unknown>).effort = "tampered";
    expect(store.lookup("s1").effort).toBe("high");
  });

  it("keeps only usable fields: non-strings, empty strings and a non-finite `at` are dropped; no undefined keys", () => {
    const store = createEffortStore();
    store.record("s1", { effort: 3, variant: "", providerID: null, modelID: "m", agent: undefined, at: Number.NaN });
    expect(store.lookup("s1")).toEqual({ modelID: "m" });
    expect(Object.keys(store.lookup("s1"))).toEqual(["modelID"]);
    store.record("s2", { at: Number.POSITIVE_INFINITY });
    expect(store.lookup("s2")).toEqual({});
  });

  it("a later turn replaces the earlier one entirely (an absent effort clears a stale one)", () => {
    const store = createEffortStore();
    store.record("s1", { effort: "high", variant: "high", agent: "fast", at: 1 });
    store.record("s1", { agent: "medium", at: 2 });
    expect(store.lookup("s1")).toEqual({ agent: "medium", at: 2 });
  });

  it("ignores an empty or non-string session id", () => {
    const store = createEffortStore();
    store.record("", { effort: "high" });
    store.record(42 as unknown as string, { effort: "high" });
    expect(store.size()).toBe(0);
    expect(store.lookup("")).toEqual({});
  });

  it("is bounded: above the limit the least recently WRITTEN session is evicted", () => {
    const store = createEffortStore(3);
    for (const id of ["a", "b", "c"]) store.record(id, { effort: id });
    store.lookup("a"); // a read does not refresh
    store.record("b", { effort: "b2" }); // a write does: order a, c, b
    store.record("d", { effort: "d" });
    expect(store.size()).toBe(3);
    expect(store.lookup("a")).toEqual({});
    expect(store.lookup("c")).toEqual({ effort: "c" });
    store.record("e", { effort: "e" });
    expect(store.lookup("c")).toEqual({});
    expect(["b", "d", "e"].map((id) => store.lookup(id).effort)).toEqual(["b2", "d", "e"]);
  });

  it("defaults to 1000 sessions (also for an invalid bound)", () => {
    expect(EFFORT_STORE_MAX_SESSIONS).toBe(1000);
    for (const bound of [undefined, 0, -1, 1.5, Number.NaN]) {
      const store = bound === undefined ? createEffortStore() : createEffortStore(bound);
      for (let i = 0; i <= 1000; i++) store.record(`s${i}`, { effort: "low" });
      expect([bound, store.size()]).toEqual([bound, 1000]);
      expect(store.lookup("s0")).toEqual({});
      expect(store.lookup("s1000")).toEqual({ effort: "low" });
    }
  });
});

describe("appliedEffort", () => {
  it("reads reasoningEffort first, then the Anthropic effort key; anything else is no effort", () => {
    expect(appliedEffort({ reasoningEffort: "high", effort: "low" })).toBe("high");
    expect(appliedEffort({ effort: "max" })).toBe("max");
    expect(appliedEffort({ reasoningEffort: "", effort: "low" })).toBe("low");
    expect(appliedEffort({ reasoningEffort: 3 })).toBeUndefined();
    expect(appliedEffort({ maxTokens: 100 })).toBeUndefined();
    expect(appliedEffort({ reasoning_effort: "high" })).toBeUndefined(); // the alias only counts once normalised
    expect(appliedEffort(normalizeAgentOptions({ reasoning_effort: "high" }))).toBe("high");
    expect(appliedEffort(normalizeAgentOptions({ reasoning_effort: "low", reasoningEffort: "medium" }))).toBe("medium");
  });

  it("normalizeAgentOptions never modifies its input", () => {
    const options = { maxTokens: 1, reasoning_effort: "high", reasoning_summary: "auto", budget_tokens: 9 };
    const snapshot = structuredClone(options);
    expect(normalizeAgentOptions(options)).toEqual({
      maxTokens: 1, reasoningEffort: "high", reasoningSummary: "auto", thinking: { type: "enabled", budgetTokens: 9 },
    });
    expect(options).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// The handler and the registration
// ---------------------------------------------------------------------------

describe("effortOf handler", () => {
  it.each([undefined, null, "s1", 42, [], ["s1"], {}, { sessionID: 1 }, { sessionID: "" }, { sessionID: null }, { sessionID: ["s1"] }]
    .map((input) => ({ input })))("answers {} for invalid input $input", async ({ input }) => {
    const store = createEffortStore();
    store.record("s1", { effort: "high" });
    expect(await effortOfHandler(store)(input)).toEqual({});
  });

  it("answers {} for an unknown session and the latest turn for a known one", async () => {
    const store = createEffortStore();
    store.record("s1", { effort: "high", agent: "fast", at: 7 });
    const effortOf = effortOfHandler(store);
    expect(await effortOf({ sessionID: "unknown" })).toEqual({});
    expect(await effortOf({ sessionID: "s1" })).toEqual({ effort: "high", agent: "fast", at: 7 });
  });

  it("never rejects: a failing store or a throwing input getter answers {}", async () => {
    const broken: EffortStore = { record: () => {}, lookup: () => { throw new Error("boom"); }, size: () => 0 };
    await expect(effortOfHandler(broken)({ sessionID: "s1" })).resolves.toEqual({});
    const hostile = Object.defineProperty({}, "sessionID", { get: () => { throw new Error("getter"); } });
    await expect(effortOfHandler(createEffortStore())(hostile)).resolves.toEqual({});
  });
});

describe("registerEffortChannel (feature detection, never throws)", () => {
  it.each([
    ["no rpc", undefined], ["null", null], ["a string", "rpc"], ["no register", {}], ["register not a function", { register: "x" }],
  ])("%s: nothing registered, nothing logged, a no-op dispose", async (_label, rpc) => {
    const log = { warn: vi.fn() };
    const dispose = await registerEffortChannel(rpc, createEffortStore(), log);
    await expect(dispose()).resolves.toBeUndefined();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("registers the shared definition on a callable rpc domain; the handler answers from the store", async () => {
    const host = fakeRpc();
    const store = createEffortStore();
    store.record("s1", { effort: "medium" });
    const log = { warn: vi.fn() };
    await registerEffortChannel(host.rpc, store, log);
    expect(host.register).toHaveBeenCalledTimes(1);
    expect(host.calls[0]!.definition).toBe(effortRpc);
    expect(Object.keys(host.calls[0]!.handlers)).toEqual(["effortOf"]);
    expect(await host.effortOf({ sessionID: "s1" })).toEqual({ effort: "medium" });
    expect(await host.effortOf({ sessionID: "s2" })).toEqual({});
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("a plain object with register qualifies too", async () => {
    const register = vi.fn(async () => ({ dispose: async () => {} }));
    await registerEffortChannel({ register }, createEffortStore(), { warn: vi.fn() });
    expect(register).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["throws", () => { throw new Error("sync boom"); }, "sync boom"],
    ["rejects", async () => { throw new Error("async boom"); }, "async boom"],
    ["rejects with a non-Error", () => Promise.reject("plain"), "plain"],
  ] as const)("register %s: resolves, logs once, a no-op dispose", async (_label, register, message) => {
    const log = { warn: vi.fn() };
    const dispose = await registerEffortChannel({ register }, createEffortStore(), log);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]![0]).toContain(message);
    await expect(dispose()).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("a throwing log sink does not turn a failed registration into a rejection", async () => {
    const log = { warn: vi.fn(() => { throw new Error("sink down"); }) };
    await expect(registerEffortChannel({ register: () => { throw new Error("x"); } }, createEffortStore(), log)).resolves.toBeTypeOf("function");
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("dispose calls the registration's dispose once; a throwing dispose or none at all is fine", async () => {
    const host = fakeRpc();
    const dispose = await registerEffortChannel(host.rpc, createEffortStore(), { warn: vi.fn() });
    await dispose();
    await dispose();
    expect(host.dispose).toHaveBeenCalledTimes(1);
    const throwing = await registerEffortChannel({ register: async () => ({ dispose: () => { throw new Error("no"); } }) }, createEffortStore());
    await expect(throwing()).resolves.toBeUndefined();
    const bare = await registerEffortChannel({ register: async () => undefined }, createEffortStore());
    await expect(bare()).resolves.toBeUndefined();
  });

  it("without a log, a failure goes to console.warn once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await registerEffortChannel({ register: () => { throw new Error("default sink"); } }, createEffortStore());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("[model-router] TUI effort channel not registered");
  });
});

// ---------------------------------------------------------------------------
// The v2 adapter
// ---------------------------------------------------------------------------

describe("v2 adapter: registration", () => {
  it("registers effortOf once per setup and disposes it with the plugin", async () => {
    home();
    const rpc = fakeRpc();
    const host = v2Host(temp(), rpc.rpc);
    const cleanup = await host.start();
    expect(rpc.register).toHaveBeenCalledTimes(1);
    expect(rpc.calls[0]!.definition).toBe(effortRpc);
    expect(rpc.dispose).not.toHaveBeenCalled();
    await cleanup();
    expect(rpc.dispose).toHaveBeenCalledTimes(1);
  });

  it("a second setup (another plugin instance) registers again; the last one answers, from its own turns", async () => {
    home();
    const rpc = fakeRpc();
    const directory = temp();
    const first = v2Host(directory, rpc.rpc);
    await first.start();
    const second = v2Host(directory, rpc.rpc);
    await second.start();
    expect(rpc.register).toHaveBeenCalledTimes(2);
    await first.turn("s1", "fast", { providerID: "p", id: "m" });
    await second.turn("s1", "fast", { providerID: "p", id: "m" });
    expect(await rpc.effortOf({ sessionID: "s1" })).toMatchObject({ providerID: "p", modelID: "m", agent: "fast" });
  });

  it.each([
    ["no ctx.rpc", undefined],
    ["register throws", { register: () => { throw new Error("rpc down"); } }],
    ["register rejects", { register: async () => { throw new Error("rpc down"); } }],
  ])("%s: setup succeeds and turns still run (and are still recorded)", async (_label, rpc) => {
    home();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = v2Host(temp(), rpc);
    const recorded = channel.records.length;
    await expect(host.start()).resolves.toBeTypeOf("function");
    const event = await host.turn("s1", "fast", { providerID: "p", id: "m" });
    expect(event.options).toEqual({ maxTokens: 32_000 });
    expect(channel.records.length).toBe(recorded + 1);
    const logged = warn.mock.calls.filter(([line]) => String(line).includes("TUI effort channel not registered"));
    expect(logged).toHaveLength(rpc === undefined ? 0 : 1);
  });
});

describe("v2 adapter: the recorded effort per path", () => {
  it("tier dispatch: the static tier effort from agentOptions (the real plugin's fable-effort preset), with the turn's model", async () => {
    const dir = home({ activePreset: "fable-effort" });
    const rpc = fakeRpc();
    const host = v2Host(dir, rpc.rpc);
    await host.start(await v2Plugin(dir));
    const before = Date.now();
    const event = await host.turn("child-fast", "fast", FABLE);
    expect(event.options).toEqual({ maxTokens: 32_000, effort: "low" }); // Anthropic: `effort` (buildAgentOptions)
    const found = await rpc.effortOf({ sessionID: "child-fast" });
    expect(found).toEqual({ effort: "low", providerID: "anthropic", modelID: "claude-fable-5-1", agent: "fast", at: found.at });
    expect(found.at).toBeGreaterThanOrEqual(before);
    expect(found.at).toBeLessThanOrEqual(Date.now());
    const heavy = await host.turn("child-heavy", "heavy", FABLE);
    expect(heavy.options.effort).toBe("xhigh");
    expect((await rpc.effortOf({ sessionID: "child-heavy" })).effort).toBe("xhigh");
  });

  it("tier dispatch: an OpenAI-style alias in the tier options is normalised like agentOptions (reasoning_effort → reasoningEffort)", async () => {
    home();
    const rpc = fakeRpc();
    const host = v2Host(temp(), rpc.rpc);
    await host.start({ config: async (cfg: { agent: Record<string, unknown> }) => {
      cfg.agent.fast = { mode: "subagent", options: { reasoning_effort: "high", topP: 0.5 } };
    } });
    const event = await host.turn("child", "fast", { providerID: "openai", id: "gpt-6", variant: "high" });
    expect(event.options).toEqual({ maxTokens: 32_000, reasoningEffort: "high", topP: 0.5 });
    expect(await rpc.effortOf({ sessionID: "child" })).toMatchObject({ effort: "high", variant: "high", providerID: "openai", modelID: "gpt-6", agent: "fast" });
  });

  it("the value is read AFTER chat.params: whatever the legacy hook set (an alias too) is what is recorded", async () => {
    home();
    const rpc = fakeRpc();
    const host = v2Host(temp(), rpc.rpc);
    await host.start({
      config: async (cfg: { agent: Record<string, unknown> }) => { cfg.agent.fast = { mode: "subagent", options: { reasoningEffort: "low" } }; },
      "chat.params": async (input: { agent?: string }, options: Record<string, unknown>) => {
        if (input.agent === "fast") options.reasoningEffort = "medium";
        if (input.agent === "medium") options.reasoning_effort = "high";
      },
    });
    expect((await host.turn("a", "fast", { providerID: "openai", id: "gpt-6" })).options.reasoningEffort).toBe("medium");
    expect((await rpc.effortOf({ sessionID: "a" })).effort).toBe("medium");
    const aliased = await host.turn("b", "medium", { providerID: "openai", id: "gpt-6" });
    expect(aliased.options).toEqual({ maxTokens: 32_000, reasoning_effort: "high" }); // left as the hook wrote it
    expect((await rpc.effortOf({ sessionID: "b" })).effort).toBe("high");
  });

  it("escalation: the effort override applied through the legacy hook is what is recorded", async () => {
    const dir = home({ activePreset: "fable-effort" });
    const rpc = fakeRpc();
    const host = v2Host(dir, rpc.rpc);
    await host.start(await v2Plugin(dir));
    expect(overrides.stores).toHaveLength(1);
    const tiers = getActiveTiers(loadConfig(dir));
    await host.turn("child-esc", "fast", FABLE);
    expect((await rpc.effortOf({ sessionID: "child-esc" })).effort).toBe("low");
    overrides.stores[0]!.set("child-esc", "fast", tiers.fast!, "medium"); // what the ladder does on an effort bump (index.ts)
    const bumped = await host.turn("child-esc", "fast", FABLE);
    expect(bumped.options).toEqual({ maxTokens: 32_000, effort: "medium" });
    expect(await rpc.effortOf({ sessionID: "child-esc" })).toMatchObject({ effort: bumped.options.effort, agent: "fast", modelID: "claude-fable-5-1" });
    // Another child of the same tier is not affected by this child's override.
    await host.turn("child-other", "fast", FABLE);
    expect((await rpc.effortOf({ sessionID: "child-other" })).effort).toBe("low");
  });

  it("resume: a second turn of the same session overwrites the first (agent, model, variant, effort, time)", async () => {
    const dir = home({ activePreset: "fable-effort" });
    const rpc = fakeRpc();
    const host = v2Host(dir, rpc.rpc);
    await host.start(await v2Plugin(dir));
    await host.turn("child", "fast", FABLE);
    const first = await rpc.effortOf({ sessionID: "child" });
    await host.turn("child", "medium", { ...FABLE, variant: "high" });
    const second = await rpc.effortOf({ sessionID: "child" });
    expect(second).toMatchObject({ effort: "high", variant: "high", agent: "medium" });
    expect(second.at!).toBeGreaterThanOrEqual(first.at!);
  });

  it("a turn without an effort clears a stale one", async () => {
    home();
    const rpc = fakeRpc();
    const host = v2Host(temp(), rpc.rpc);
    await host.start({ config: async (cfg: { agent: Record<string, unknown> }) => {
      cfg.agent.fast = { mode: "subagent", options: { reasoningEffort: "high" } };
    } });
    await host.turn("child", "fast", { providerID: "openai", id: "gpt-6" });
    expect((await rpc.effortOf({ sessionID: "child" })).effort).toBe("high");
    await host.turn("child", "medium", { providerID: "openai", id: "gpt-6" }); // `medium` carries no effort option
    const after = await rpc.effortOf({ sessionID: "child" });
    expect(after).toMatchObject({ agent: "medium", modelID: "gpt-6" });
    expect("effort" in after).toBe(false);
  });

  it("a root session is recorded too: its model and variant; no effort from agentOptions (A3)", async () => {
    const dir = home({ activePreset: "fable-effort" });
    const rpc = fakeRpc();
    const host = v2Host(dir, rpc.rpc);
    await host.start(await v2Plugin(dir));
    const event = await host.turn("root", "build", { providerID: "anthropic", id: "claude-opus-5-5", variant: "max" });
    expect(event.options).toEqual({ maxTokens: 32_000 });
    const found = await rpc.effortOf({ sessionID: "root" });
    expect(found).toMatchObject({ variant: "max", providerID: "anthropic", modelID: "claude-opus-5-5", agent: "build" });
    expect("effort" in found).toBe(false);
  });

  it("a root session whose request carries an effort after the router's hook records it", async () => {
    home();
    const rpc = fakeRpc();
    const host = v2Host(temp(), rpc.rpc);
    await host.start({ "chat.params": async (input: { agent?: string }, options: Record<string, unknown>) => {
      if (input.agent === "build") options.reasoningEffort = "low";
    } });
    await host.turn("root", "build", { providerID: "openai", id: "gpt-6" }, { maxTokens: 1, reasoningEffort: "high" });
    expect((await rpc.effortOf({ sessionID: "root" })).effort).toBe("low");
  });

  it("role dispatch (roles mode): the role child's variant and model; the role catalog filter still applies", async () => {
    const dir = home({ routing: { delegation: "roles" } });
    const rpc = fakeRpc();
    const host = v2Host(dir, rpc.rpc);
    host.sessions["child-role"] = { id: "child-role", parentID: "root", agent: "explorer", location: { directory: dir } };
    await host.start();
    expect(host.agents.explorer).toBeDefined(); // a registered role agent
    expect(rpc.register).toHaveBeenCalledTimes(1); // roles mode registers the channel like tiers mode
    const event = await host.turn("child-role", "explorer", { providerID: "anthropic", id: "claude-opus-5-5", variant: "high" }, { maxTokens: 64 },
      { read: {}, grep: {}, edit: {}, execute: {}, shell: {} });
    expect(Object.keys(event.tools)).not.toContain("execute"); // the role path ran (T2.3.2)
    expect(event.options).toEqual({ maxTokens: 64 });
    const found = await rpc.effortOf({ sessionID: "child-role" });
    expect(found).toMatchObject({ variant: "high", providerID: "anthropic", modelID: "claude-opus-5-5", agent: "explorer" });
    expect("effort" in found).toBe(false);
  });

  it("unknown session: {}", async () => {
    home();
    const rpc = fakeRpc();
    await v2Host(temp(), rpc.rpc).start();
    expect(await rpc.effortOf({ sessionID: "never-seen" })).toEqual({});
  });
});

describe("v2 adapter: the hook's output is unchanged", () => {
  /** `event.options` as a proxy that records every write made after the legacy chat.params returned. */
  function watched(target: Record<string, unknown>, after: { done: boolean; writes: string[] }) {
    const note = (kind: string, key: PropertyKey) => { if (after.done) after.writes.push(`${kind}:${String(key)}`); };
    return new Proxy(target, {
      set: (object, key, value) => { note("set", key); return Reflect.set(object, key, value); },
      deleteProperty: (object, key) => { note("delete", key); return Reflect.deleteProperty(object, key); },
      defineProperty: (object, key, descriptor) => { note("define", key); return Reflect.defineProperty(object, key, descriptor); },
    });
  }

  it("nothing writes event.options after chat.params, and the options equal those of a host without the rpc channel", async () => {
    const dir = home({ activePreset: "fable-effort" });
    const run = async (rpc: unknown) => {
      const plugin = await v2Plugin(dir);
      const after = { done: false, writes: [] as string[] };
      const params = plugin["chat.params"] as (input: unknown, output: unknown) => Promise<void>;
      plugin["chat.params"] = async (input: unknown, output: unknown) => { await params(input, output); after.done = true; };
      const host = v2Host(dir, rpc);
      await host.start(plugin);
      const tiers = getActiveTiers(loadConfig(dir));
      overrides.stores.at(-1)!.set("esc", "fast", tiers.fast!, "high");
      const results: Array<Record<string, unknown>> = [];
      for (const [sessionID, agent, model] of [
        ["c1", "fast", FABLE], ["esc", "fast", FABLE], ["root", "build", { ...FABLE, variant: "max" }], ["c2", "medium", FABLE],
      ] as const) {
        after.done = false;
        const options = watched({ maxTokens: 100, topP: 0.9 }, after);
        const event = await host.turn(sessionID, agent, model, options);
        results.push({ ...event.options });
      }
      expect(after.writes).toEqual([]);
      return results;
    };
    const withChannel = await run(fakeRpc().rpc);
    const without = await run(undefined);
    expect(withChannel).toEqual(without);
    expect(withChannel).toEqual([
      { maxTokens: 100, topP: 0.9, effort: "low" },
      { maxTokens: 100, topP: 0.9, effort: "high" },
      { maxTokens: 100, topP: 0.9 },
      { maxTokens: 100, topP: 0.9, effort: "high" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// OpenCode v1: inert
// ---------------------------------------------------------------------------

describe("OpenCode v1: the channel is inert", () => {
  it("the v1 plugin never creates the store, never registers, never records (its chat.params behaviour is unchanged)", async () => {
    const dir = home({ activePreset: "fable-effort" });
    const stores = channel.stores;
    const registers = channel.registers;
    const register = vi.fn(async () => ({ dispose: async () => {} }));
    // As the v1 tests load it (test/integration/ladder-effort-wiring.test.ts): no `routerHost`; an rpc-looking member is ignored.
    const hooks = await ModelRouterPlugin({
      directory: dir, worktree: dir, rpc: { register },
      client: { session: { get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id } }) } },
    } as unknown as RouterPluginInput) as unknown as Record<string, (input: unknown, output?: unknown) => Promise<void>> & { dispose(): Promise<void> };
    cleanups.push(async () => { await hooks.dispose(); });
    const config = { agent: {} as Record<string, { options?: Record<string, unknown> }>, command: {} };
    await hooks.config!(config);
    expect(config.agent.fast?.options).toEqual({ effort: "low" });
    const tiers = getActiveTiers(loadConfig(dir));
    overrides.stores.at(-1)!.set("v1-child", "fast", tiers.fast!, "medium");
    const output = { options: { effort: "low" } as Record<string, unknown> };
    await hooks["chat.params"]!({ sessionID: "v1-child", agent: "fast", model: { providerID: "anthropic", id: "claude-fable-5-1" } }, output);
    expect(output.options).toEqual({ effort: "medium" }); // v1's own override path still works
    await hooks["chat.params"]!({ sessionID: "v1-root", agent: "build", model: { providerID: "anthropic", id: "claude-opus-5-5" } }, { options: {} });
    expect(register).not.toHaveBeenCalled();
    expect(channel.stores).toBe(stores);
    expect(channel.registers).toBe(registers);
    expect(channel.records).toEqual([]);
  });
});
