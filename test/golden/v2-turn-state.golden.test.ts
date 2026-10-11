/**
 * test/golden/v2-turn-state.golden.test.ts
 *
 * Phase 1.2 (task 1.2.6): goldens of the v2 cache-stable turn state. On OpenCode v2 the pending list, the late notices and the
 * route hint ride in a trailing `<router-state>` user message built per request; the system array stays put.
 *
 * The real plugin (`routerHost: "v2"`) runs behind the real adapter (`registerV2Hooks`) with a fake host context, and the tests
 * call the `context` session hook the way the host does. The adapter's turn-state registry is captured through the plugin's attach
 * hook, so a test can add providers the plugin does not register today: the plan section (reserved name `plan`, order 0..9, added
 * by a later phase), a filler that overflows the bound, and a stand-in for the route hint (whose real text is pinned by
 * test/unit/routing-wire.hint.test.ts; producing it for real needs a seeded outcome store).
 * Handles are random, so they are replaced by `<handle-N>` in order of first appearance before the comparison.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { Hooks } from "@opencode-ai/plugin";
import { registerV2Hooks } from "../../src/compat/v2-hooks";
import { TURN_STATE_MAX_CHARS, type TurnStateRegistry } from "../../src/compat/turn-state";
import { ROUTER_TURN_STATE_ATTACH } from "../../src/compat/turn-state";
import ModelRouterPlugin from "../../src/index";
import { invalidateConfigCache } from "../../src/router/config";
import type { LateNotice, PendingRegistry } from "../../src/verify/pending";
import type { DoD } from "../../src/verify/dod";

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
}));

const root = resolve("v2-turn-state-project");
const DOD: DoD = { kind: "deterministic", source: "explicit", criteria: [], deliverable: null, checks: [{ kind: "testsPass", command: "npm test" }] };
const LATE_HANDLE = "vrf_0123456789abcdef01234567";
const ROUTE_HINT = "Route hint: for implement work like this turn, prefer @heavy (Opus for architecture and hard debugging).";
const SESSION = "orch";

interface Part { type: string; text?: string; cache?: unknown; [key: string]: unknown }
interface Message { id?: string; role: string; content: Part[] }
interface ContextEvent {
  sessionID: string;
  agent: string;
  model: { providerID: string; id: string };
  options: Record<string, unknown>;
  system: { type: "text"; text: string }[];
  messages: Message[];
}

/** The host's `ctx`, reduced to what the adapter touches while loading and while answering the `context` hook. */
function hostFixture() {
  const sessionHooks: Record<string, (event: ContextEvent) => Promise<void>> = {};
  const noop = async () => ({ dispose: async () => {} });
  const ctx = {
    location: { directory: root, project: { directory: root } },
    agent: { reload: async () => {}, list: async () => ({ data: [] }), transform: async () => ({ dispose: async () => {} }) },
    command: { reload: async () => {}, transform: noop },
    tool: { transform: noop, hook: noop },
    session: {
      get: async () => ({ id: SESSION }),
      update: async () => {},
      context: async () => [],
      prompt: async () => {},
      synthetic: async () => {},
      hook: async (name: string, cb: (event: ContextEvent) => Promise<void>) => {
        sessionHooks[name] = cb;
        return { dispose: async () => {} };
      },
    },
    permission: { hook: noop },
    event: { subscribe: async function* ({ signal }: { signal: AbortSignal }) {
      await new Promise<void>(resolveWait => { signal.addEventListener("abort", () => resolveWait(), { once: true }); });
    } },
  };
  return { ctx, sessionHooks };
}

const user = (text: string): Message => ({ id: "m-user", role: "user", content: [{ type: "text", text }] });
const assistant = (...content: Part[]): Message => ({ id: "m-assistant", role: "assistant", content });

describe("v2 turn state goldens (Phase 1.2)", () => {
  let home = "";
  let registry: TurnStateRegistry | undefined;
  let cleanup: (() => Promise<void>) | undefined;
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "omr-v2-turn-state-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.MODEL_ROUTER_ENFORCE = "1";
    plugin.wiring = undefined;
    registry = undefined;
  });

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
    vi.restoreAllMocks();
    for (const key of ["HOME", "USERPROFILE"] as const) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    delete process.env.MODEL_ROUTER_ENFORCE;
    invalidateConfigCache();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  /** Loads the plugin on a v2 host behind the adapter; `routing` is written as a global override before anything reads the config. */
  async function boot(routing?: { engine: "advise" }) {
    const overrides = join(home, ".config/opencode/opencode-model-router.overrides.jsonc");
    mkdirSync(dirname(overrides), { recursive: true });
    writeFileSync(overrides, JSON.stringify({ enforcement: { verify: { background: true } }, ...(routing ? { routing } : {}) }), "utf-8");
    invalidateConfigCache();
    const hooks = await ModelRouterPlugin({
      directory: root,
      worktree: root,
      project: {},
      serverUrl: new URL("http://localhost"),
      $: () => undefined,
      routerHost: "v2",
      client: { session: { get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id } }) } },
    } as unknown as Parameters<typeof ModelRouterPlugin>[0]);
    const attach = (hooks as unknown as Record<PropertyKey, unknown>)[ROUTER_TURN_STATE_ATTACH];
    if (typeof attach !== "function") throw new Error("the plugin exposes no turn-state attach hook");
    // The attach hook is a non-writable, non-enumerable property: wrap it on a copy to see the registry the adapter creates.
    const observed = Object.assign({}, hooks);
    Object.defineProperty(observed, ROUTER_TURN_STATE_ATTACH, {
      value: (attached: TurnStateRegistry) => {
        registry = attached;
        return (attach as (r: TurnStateRegistry) => unknown)(attached);
      },
    });
    const host = hostFixture();
    cleanup = await registerV2Hooks(host.ctx as unknown as Context, observed as unknown as Hooks);
    const queue = plugin.wiring?.background;
    if (queue === undefined) throw new Error("background: true built no queue");
    const hook = host.sessionHooks.context;
    if (hook === undefined) throw new Error("the adapter registered no context hook");
    return { queue, hook };
  }

  function pendingRegistry(): PendingRegistry {
    if (plugin.wiring === undefined) throw new Error("the plugin built no wiring");
    return plugin.wiring.pending;
  }

  function register(n: number): void {
    const r = pendingRegistry().register({
      orchestratorSessionID: SESSION,
      dispatchID: `task:${SESSION}:${n}`,
      producerSessionID: `producer-${SESSION}-${n}`,
      producerTier: "fast",
      description: `work ${n}`,
      cwd: root,
      root,
      dispatchedAt: 1_000_000 + n,
      dod: DOD,
      reference: Promise.resolve({ kind: "none", reason: "no reference captured" }),
      changedFiles: [],
      risk: { level: n % 2 === 0 ? "low" : "high", reasons: ["some reason"] },
    });
    if (!r.ok) throw new Error(r.detail);
  }

  function needRegistry(): TurnStateRegistry {
    if (registry === undefined) throw new Error("the adapter attached no turn-state registry");
    return registry;
  }

  function event(messages: Message[]): ContextEvent {
    return {
      sessionID: SESSION,
      agent: "build",
      model: { providerID: "anthropic", id: "claude-sonnet-5-5" },
      options: {},
      system: [{ type: "text", text: "Host instructions" }],
      messages,
    };
  }

  /** Handles are random: number them by first appearance. */
  function normalize(text: string): string {
    const seen = new Map<string, string>();
    return text.replace(/vrf_[0-9a-f]{24}/g, handle => {
      let label = seen.get(handle);
      if (label === undefined) {
        label = `<handle-${seen.size + 1}>`;
        seen.set(handle, label);
      }
      return label;
    });
  }

  const tailOf = (e: ContextEvent): string => {
    const last = e.messages[e.messages.length - 1];
    const text = last?.content[0]?.text;
    if (last?.role !== "user" || text === undefined || !text.startsWith("<router-state>\n")) throw new Error("no turn-state tail was appended");
    return text;
  };

  const lateNotice = (): LateNotice => ({ handle: LATE_HANDLE, description: "late work", introduced: ["a.test.ts > t2"], outcome: "fail" });

  it("v2-turn-state-full-tail: late notice, pending list and route hint in one <router-state> message", async () => {
    const { queue, hook } = await boot();
    register(1);
    register(2);
    vi.spyOn(queue, "takeNotices").mockReturnValueOnce([lateNotice()]);
    needRegistry().registerTurnStateProvider({ name: "route-hint-standin", order: 90, render: () => ROUTE_HINT });

    const e = event([user("Implement the parser change")]);
    await hook(e);

    const tail = tailOf(e);
    expect(tail.indexOf("Background verification")).toBeLessThan(tail.indexOf("Unverified delegations"));
    expect(tail.indexOf("Unverified delegations")).toBeLessThan(tail.indexOf("Route hint"));
    expect(e.system.map(part => part.text).join("\n")).not.toContain("Unverified delegations");
    await expect(normalize(tail)).toMatchFileSnapshot("__snapshots__/v2-turn-state.full-tail.txt");
  });

  const fillerLines = (): string => Array.from({ length: 120 }, (_, i) => `filler line ${String(i + 1).padStart(3, "0")} ${"x".repeat(60)}`).join("\n");

  it("v2-turn-state-overflow: past 6000 characters whole lines are dropped and an overflow line closes the tail (no plan)", async () => {
    const { hook } = await boot();
    register(1);
    needRegistry().registerTurnStateProvider({ name: "filler", order: 50, render: fillerLines });

    const e = event([user("Go on")]);
    await hook(e);

    const tail = tailOf(e);
    expect(tail.length).toBeLessThanOrEqual(TURN_STATE_MAX_CHARS);
    expect(tail).toMatch(/\n… \d+ more lines\n<\/router-state>$/);
    expect(tail).not.toContain("router_plan");
    await expect(normalize(tail)).toMatchFileSnapshot("__snapshots__/v2-turn-state.overflow.txt");
  });

  it("v2-turn-state-overflow-plan: the same overflow with an active plan provider points at router_plan", async () => {
    const { hook } = await boot();
    register(1);
    needRegistry().registerTurnStateProvider({ name: "plan", order: 0, render: () => "Plan: 3 steps, 1 done, next: step 2", active: () => true });
    needRegistry().registerTurnStateProvider({ name: "filler", order: 50, render: fillerLines });

    const e = event([user("Go on")]);
    await hook(e);

    const tail = tailOf(e);
    expect(tail.length).toBeLessThanOrEqual(TURN_STATE_MAX_CHARS);
    expect(tail).toMatch(/\n… \d+ more lines \(router_plan action=status\)\n<\/router-state>$/);
    await expect(normalize(tail)).toMatchFileSnapshot("__snapshots__/v2-turn-state.overflow-plan.txt");
  });

  it("v2-turn-state-messages-user-text: the cache hint sits on the last user text and the tail follows it", async () => {
    const { hook } = await boot();
    register(1);
    const first = user("Fix the bug in the parser");
    const reply = assistant({ type: "text", text: "Looking at it now" });
    const last = user("Now add tests");
    const messages = [first, reply, last];

    const e = event(messages);
    await hook(e);

    expect(e.messages).not.toBe(messages);
    expect(messages[2]).toBe(last);
    expect(last.content[0]).not.toHaveProperty("cache");
    expect(e.messages[2]?.content[0]?.cache).toEqual({ type: "ephemeral" });
    expect(e.messages).toHaveLength(4);
    await expect(normalize(JSON.stringify(e.messages, null, 2))).toMatchFileSnapshot("__snapshots__/v2-turn-state.messages-user-text.json");
  });

  it("v2-turn-state-messages-tool-result: the cache hint lands on the last part of a tool-result-only last message (O12)", async () => {
    const { hook } = await boot();
    register(1);
    const messages: Message[] = [
      user("Read the config and tell me what is wrong"),
      assistant({ type: "text", text: "Reading the file" }, { type: "tool-call", id: "t1" }),
      { role: "tool", content: [{ type: "tool-result", id: "t1" }] },
    ];

    const e = event(messages);
    await hook(e);

    expect(e.messages).toHaveLength(4);
    expect(e.messages[2]?.content[0]?.cache).toEqual({ type: "ephemeral" });
    expect(e.messages[1]).toBe(messages[1]);
    expect(messages[2]?.content[0]).not.toHaveProperty("cache");
    await expect(normalize(JSON.stringify(e.messages, null, 2))).toMatchFileSnapshot("__snapshots__/v2-turn-state.messages-tool-result.json");
  });

  it("v2-turn-state-empty: nothing to say leaves event.messages the very same array", async () => {
    const { hook } = await boot();
    const messages = [user("Hello")];

    const e = event(messages);
    await hook(e);

    expect(e.messages).toBe(messages);
    expect(messages).toEqual([user("Hello")]);
    expect(messages[0]?.content[0]).not.toHaveProperty("cache");
  });

  it("v2-turn-state-system-advise: a root session in advise mode gets no hint and no pending part in event.system", async () => {
    const { hook } = await boot({ engine: "advise" });
    register(1);
    register(2);

    const e = event([user("Implement the parser change")]);
    await hook(e);

    const system = e.system.map(part => part.text);
    // The protocol text itself mentions "a `Route hint` line"; the hint is the line that starts "Route hint: for".
    expect(system.join("\n")).not.toContain("Route hint: for");
    expect(system.join("\n")).not.toContain("Unverified delegations");
    expect(tailOf(e)).toContain("Unverified delegations");
    const rendered = system.map((part, i) => `===== event.system[${i}] =====\n${part}\n`).join("");
    await expect(normalize(rendered)).toMatchFileSnapshot("__snapshots__/v2-turn-state.system-advise.txt");
  });
});
