/**
 * test/integration/v2-turn-state.test.ts
 *
 * Phase 1.2 (task 1.2.7): the v2 cache-stable turn state, driven through the real plugin (`routerHost: "v2"`) behind the real
 * adapter (`registerV2Hooks`) with a fake host context; the tests call the `context` session hook the way the host does
 * (same harness approach as test/golden/v2-turn-state.golden.test.ts).
 *
 * The host's messages are deep-frozen in every test: any mutation of a message, a content array or a part throws (the test
 * files are ES modules, so a write to a frozen object is a TypeError). The adapter's turn-state registry is captured through
 * the plugin's attach hook so a test can add a stand-in for the route hint (whose real text is pinned by
 * test/unit/routing-wire.hint.test.ts; producing it for real needs a seeded outcome store).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { Hooks } from "@opencode-ai/plugin";
import { V2_GRADER_AGENT } from "../../src/compat/v2-client";
import { registerV2Hooks } from "../../src/compat/v2-hooks";
import type { TurnStateRegistry } from "../../src/compat/turn-state";
import { ROUTER_TURN_STATE_ATTACH } from "../../src/compat/turn-state";
import ModelRouterPlugin from "../../src/index";
import { invalidateConfigCache } from "../../src/router/config";
import { acquireOutcomes, DEFAULT_OUTCOME_TUNING, makeKey } from "../../src/routing/outcomes";
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

const root = resolve("v2-turn-state-integration-project");
const DOD: DoD = { kind: "deterministic", source: "explicit", criteria: [], deliverable: null, checks: [{ kind: "testsPass", command: "npm test" }] };
const ROUTE_HINT = "Route hint: for implement work like this turn, prefer @heavy (Opus for architecture and hard debugging).";
const SESSION = "orch";
const LATE_HANDLE = "vrf_0123456789abcdef01234567";
const OTHER_HANDLE = "vrf_fedcba9876543210fedcba98";

/** Calls the plugin's `router_verify` tool the way the host does, as the root session. */
async function routerVerify(hooks: Hooks, args: { handles: string[] }): Promise<string> {
  const definition = hooks.tool?.router_verify;
  if (definition === undefined) throw new Error("the plugin registered no router_verify tool");
  const result: unknown = await definition.execute(args, { sessionID: SESSION } as unknown as Parameters<typeof definition.execute>[1]);
  return typeof result === "string" ? result : JSON.stringify(result);
}

interface Part { type: string; text?: string; cache?: unknown; [key: string]: unknown }
interface Message { id?: string; role: string; content: Part[] }
interface SystemPart { type: "text"; text: string; cache?: unknown }
interface ContextEvent {
  sessionID: string;
  agent: string;
  model: { providerID: string; id: string };
  options: Record<string, unknown>;
  system: SystemPart[];
  messages: Message[];
}

/** The host's `ctx`, reduced to what the adapter touches while loading and while answering the `context` hook. */
function hostFixture(parents: Readonly<Record<string, string>>) {
  const sessionHooks: Record<string, (event: ContextEvent) => Promise<void>> = {};
  const noop = async () => ({ dispose: async () => {} });
  const ctx = {
    location: { directory: root, project: { directory: root } },
    agent: { reload: async () => {}, list: async () => ({ data: [] }), transform: async () => ({ dispose: async () => {} }) },
    command: { reload: async () => {}, transform: noop },
    tool: { transform: noop, hook: noop },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        const parentID = parents[sessionID];
        return parentID === undefined ? { id: sessionID } : { id: sessionID, parentID };
      },
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

/** Recursively freezes a value: a later write to it throws a TypeError. */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** The host's own system part: frozen and shared, so "the router left it alone" is a reference comparison. */
const HOST_PART: SystemPart = deepFreeze({ type: "text", text: "Host instructions" });

const user = (text: string): Message => ({ id: "m-user", role: "user", content: [{ type: "text", text }] });
const assistant = (...content: Part[]): Message => ({ id: "m-assistant", role: "assistant", content });

describe("v2 turn state (Phase 1.2, integration)", () => {
  let home = "";
  let registry: TurnStateRegistry | undefined;
  let cleanup: (() => Promise<void>) | undefined;
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "omr-v2-turn-state-int-"));
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
  async function boot(options: { routing?: { engine: "advise"; outcomes?: { path: string } }; parents?: Record<string, string> } = {}) {
    const overrides = join(home, ".config/opencode/opencode-model-router.overrides.jsonc");
    mkdirSync(dirname(overrides), { recursive: true });
    writeFileSync(overrides, JSON.stringify({ enforcement: { verify: { background: true } }, ...(options.routing ? { routing: options.routing } : {}) }), "utf-8");
    invalidateConfigCache();
    const hooks = await ModelRouterPlugin({
      directory: root,
      worktree: root,
      project: {},
      serverUrl: new URL("http://localhost"),
      $: () => undefined,
      routerHost: "v2",
      client: { session: { get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, ...(options.parents?.[path.id] === undefined ? {} : { parentID: options.parents[path.id] }) } }) } },
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
    const host = hostFixture(options.parents ?? {});
    cleanup = await registerV2Hooks(host.ctx as unknown as Context, observed as unknown as Hooks);
    const queue = plugin.wiring?.background;
    if (queue === undefined) throw new Error("background: true built no queue");
    const hook = host.sessionHooks.context;
    if (hook === undefined) throw new Error("the adapter registered no context hook");
    return { queue, hook, hooks };
  }

  function pendingRegistry(): PendingRegistry {
    if (plugin.wiring === undefined) throw new Error("the plugin built no wiring");
    return plugin.wiring.pending;
  }

  function register(n: number, session = SESSION): string {
    const r = pendingRegistry().register({
      orchestratorSessionID: session,
      dispatchID: `task:${session}:${n}`,
      producerSessionID: `producer-${session}-${n}`,
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
    return r.handle;
  }

  function needRegistry(): TurnStateRegistry {
    if (registry === undefined) throw new Error("the adapter attached no turn-state registry");
    return registry;
  }

  /** A context event for `sessionID` whose host messages and system parts are deep-frozen: the router may not touch them. */
  function event(messages: Message[], overrides: Partial<Pick<ContextEvent, "sessionID" | "agent">> = {}): ContextEvent {
    return {
      sessionID: overrides.sessionID ?? SESSION,
      agent: overrides.agent ?? "build",
      model: { providerID: "anthropic", id: "claude-sonnet-5-5" },
      options: {},
      system: [HOST_PART],
      messages: deepFreeze(messages),
    };
  }

  const tailOf = (e: ContextEvent): string => {
    const last = e.messages[e.messages.length - 1];
    const text = last?.content[0]?.text;
    if (last?.role !== "user" || text === undefined || !text.startsWith("<router-state>\n")) throw new Error("no turn-state tail was appended");
    return text;
  };
  const hasTail = (e: ContextEvent): boolean => e.messages.some(m => m.content.some(p => typeof p.text === "string" && p.text.startsWith("<router-state>\n")));
  const systemText = (e: ContextEvent): string => e.system.map(part => part.text).join("\n");

  /** Every `cache` property found on a message part, as `message/part` coordinates. */
  function cacheMarks(messages: readonly Message[]): { message: number; part: number }[] {
    const found: { message: number; part: number }[] = [];
    messages.forEach((message, m) => message.content.forEach((part, p) => { if (part.cache !== undefined) found.push({ message: m, part: p }); }));
    return found;
  }

  const e2eCacheCount = (e: ContextEvent): number => cacheMarks(e.messages).length;

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

  const lateNotice = (handle = LATE_HANDLE): LateNotice => ({ handle, description: "late work", introduced: ["a.test.ts > t2"], outcome: "fail" });

  it("empty state: event.messages stays the very same (frozen) array and no part is touched", async () => {
    const { hook } = await boot();
    const messages = deepFreeze([user("Hello")]);
    const e = event(messages);
    await hook(e);
    expect(e.messages).toBe(messages);
    expect(hasTail(e)).toBe(false);
    expect(cacheMarks(e.messages)).toEqual([]);
    expect(e.system.every(part => part.cache === undefined)).toBe(true);
  });

  it("pending 0 -> 2 -> 1 over three context builds: event.system is deep-equal, host parts are the same objects, only the tail differs", async () => {
    const { hook } = await boot();
    const messages = deepFreeze([user("Implement the parser change")]);

    const none = event(messages);
    await hook(none);
    expect(none.messages).toBe(messages);

    const first = register(1);
    register(2);
    const two = event(messages);
    await hook(two);
    const twoTail = tailOf(two);
    expect(twoTail).toContain("work 1");
    expect(twoTail).toContain("work 2");

    // Work 1 gets a terminal pass: it leaves the pending list.
    const claim = pendingRegistry().markVerifying(SESSION, first);
    if (claim.kind !== "claimed") throw new Error(`expected a claim, got ${claim.kind}`);
    claim.settle({ verdict: { pass: true, outcome: "pass", method: "deterministic", reasons: [] }, retryable: false });
    const one = event(messages);
    await hook(one);
    const oneTail = tailOf(one);
    expect(oneTail).not.toContain("work 1");
    expect(oneTail).toContain("work 2");
    expect(oneTail).not.toBe(twoTail);

    expect(two.system).toEqual(none.system);
    expect(one.system).toEqual(none.system);
    for (const built of [none, two, one]) {
      expect(built.system[0]).toBe(HOST_PART);
      expect(built.system.some(part => part.text.includes("work 1") || part.text.includes("work 2"))).toBe(false);
    }
    expect(messages).toHaveLength(1);
  });

  it("pending state: the tail is the new last message, the hint stand-in rides in it and not in event.system", async () => {
    const { hook } = await boot();
    register(1);
    register(2);
    needRegistry().registerTurnStateProvider({ name: "route-hint-standin", order: 90, render: () => ROUTE_HINT });
    const messages = deepFreeze([user("Implement the parser change")]);
    const e = event(messages);
    await hook(e);

    expect(e.messages).not.toBe(messages);
    expect(e.messages).toHaveLength(2);
    expect(e.messages[0]).not.toBe(messages[0]);
    const tail = tailOf(e);
    expect(tail).toContain("Unverified delegations");
    expect(tail).toContain(ROUTE_HINT);
    expect(systemText(e)).not.toContain("Unverified delegations");
    expect(systemText(e)).not.toContain("Route hint: for");
    expect(systemText(e)).not.toContain("<router-state>");
  });

  it("cache: exactly one router hint per request, on the last real message, never on the tail or on a system part; no TTL anywhere", async () => {
    const { hook } = await boot();
    register(1);
    const e = event([user("first ask"), assistant({ type: "text", text: "answer" }), user("second ask")]);
    await hook(e);

    expect(e.messages).toHaveLength(4);
    expect(cacheMarks(e.messages)).toEqual([{ message: 2, part: 0 }]);
    expect(e.messages[2]?.content[0]?.cache).toEqual({ type: "ephemeral" });
    expect(e.messages[3]?.content.every(part => part.cache === undefined)).toBe(true);
    expect(e.system.every(part => part.cache === undefined)).toBe(true);
    expect(JSON.stringify(e)).not.toContain("ttlSeconds");
    expect(JSON.stringify(e)).not.toMatch(/"ttl"/);
  });

  it("O12: when the last real message is a tool result, the hint goes to its last part and never to an earlier message", async () => {
    const { hook } = await boot();
    register(1);
    const messages = deepFreeze([
      user("Read the config and tell me what is wrong"),
      assistant({ type: "text", text: "Reading the file" }, { type: "tool-call", id: "t1" }),
      { role: "tool", content: [{ type: "tool-result", id: "t1" }] } satisfies Message,
    ]);
    const e = event(messages);
    await hook(e);

    expect(e.messages).toHaveLength(4);
    expect(cacheMarks(e.messages)).toEqual([{ message: 2, part: 0 }]);
    expect(e.messages[2]?.content[0]).toEqual({ type: "tool-result", id: "t1", cache: { type: "ephemeral" } });
    expect(e.messages[1]).toBe(messages[1]);
    expect(e.messages[3]?.content.every(part => part.cache === undefined)).toBe(true);
  });

  it("a whitespace-only text part is not a hint target: the hint goes to the last visible text part", async () => {
    const { hook } = await boot();
    register(1);
    const e = event([user("ask"), { role: "user", content: [{ type: "text", text: "real" }, { type: "text", text: "  \n " }] }]);
    await hook(e);
    expect(cacheMarks(e.messages)).toEqual([{ message: 1, part: 0 }]);
  });

  it("session.deleted drops the session's retained late notices", async () => {
    const { queue, hook, hooks } = await boot();
    vi.spyOn(queue, "takeNotices").mockReturnValueOnce([lateNotice()]);
    const first = event([user("Go on")]);
    await hook(first);
    expect(tailOf(first)).toContain(LATE_HANDLE);

    await hooks.event?.({ event: { type: "session.deleted", properties: { info: { id: SESSION } } } } as unknown as Parameters<NonNullable<Hooks["event"]>>[0]);

    const after = event([user("Go on")]);
    await hook(after);
    expect(hasTail(after)).toBe(false);
  });

  it("rendering a session refreshes its place in the late buffer's LRU", async () => {
    const { queue, hook } = await boot();
    const handleOf = (n: number): string => `vrf_${n.toString(16).padStart(24, "0")}`;
    const served = new Set<string>();
    vi.spyOn(queue, "takeNotices").mockImplementation((sid: string) => {
      if (served.has(sid)) return [];
      served.add(sid);
      return [lateNotice(handleOf(Number(sid.slice(1))))];
    });
    // Session "s0" is the oldest; the buffer holds 100 sessions.
    await hook(event([user("Go on")], { sessionID: "s0" }));
    for (let n = 1; n < 100; n++) await hook(event([user("Go on")], { sessionID: `s${n}` }));
    // Rendering s0 again makes it the most recently used; s1 is now the oldest.
    await hook(event([user("Go on")], { sessionID: "s0" }));
    await hook(event([user("Go on")], { sessionID: "s100" }));

    const kept = event([user("Go on")], { sessionID: "s0" });
    await hook(kept);
    expect(tailOf(kept)).toContain(handleOf(0));
    const evicted = event([user("Go on")], { sessionID: "s1" });
    await hook(evicted);
    expect(hasTail(evicted)).toBe(false);
  });



  it("late notice: rendered on two consecutive turns, gone once router_verify answers its handle", async () => {
    const { queue, hook, hooks } = await boot();
    vi.spyOn(queue, "takeNotices").mockReturnValueOnce([lateNotice()]);
    expect(normalize(lateNotice().handle)).toBe("<handle-1>");

    const first = event([user("Go on")]);
    await hook(first);
    expect(tailOf(first)).toContain("Background verification");
    expect(tailOf(first)).toContain(LATE_HANDLE);

    // The queue delivered it once (the mock is spent); the buffer retains it for the next request.
    const second = event([user("Go on")]);
    await hook(second);
    expect(tailOf(second)).toContain(LATE_HANDLE);
    expect(systemText(second)).not.toContain(LATE_HANDLE);

    const answer = await routerVerify(hooks, { handles: [LATE_HANDLE] });
    expect(answer).toContain(LATE_HANDLE);

    const third = event([user("Go on")]);
    await hook(third);
    expect(third.messages).toHaveLength(1);
    expect(hasTail(third)).toBe(false);
  });

  it("late notice: kept when router_verify answers a different handle", async () => {
    const { queue, hook, hooks } = await boot();
    vi.spyOn(queue, "takeNotices").mockReturnValueOnce([lateNotice()]);
    await hook(event([user("Go on")]));

    await routerVerify(hooks, { handles: [OTHER_HANDLE] });

    const after = event([user("Go on")]);
    await hook(after);
    expect(tailOf(after)).toContain(LATE_HANDLE);
  });

  it("late notice: kept when router_verify throws", async () => {
    const { queue, hook, hooks } = await boot();
    vi.spyOn(queue, "takeNotices").mockReturnValueOnce([lateNotice()]);
    await hook(event([user("Go on")]));

    vi.spyOn(pendingRegistry(), "markVerifying").mockImplementation(() => { throw new Error("registry exploded"); });
    const answer = await routerVerify(hooks, { handles: [LATE_HANDLE] });
    expect(answer).toContain("router_verify failed");
    vi.restoreAllMocks();

    const after = event([user("Go on")]);
    await hook(after);
    expect(tailOf(after)).toContain(LATE_HANDLE);
  });

  it("children and graders get no tail, no hint and no cache mark, even with state registered for them", async () => {
    const { hook } = await boot({ parents: { child: SESSION, "grader-child": SESSION } });
    register(1, "child");
    register(1);
    needRegistry().registerTurnStateProvider({ name: "route-hint-standin", order: 90, render: () => ROUTE_HINT });

    const childMessages = deepFreeze([user("Do the subtask")]);
    const child = event(childMessages, { sessionID: "child", agent: "fast" });
    await hook(child);
    expect(child.messages).toBe(childMessages);
    expect(systemText(child)).not.toContain("Route hint: for");
    expect(systemText(child)).not.toContain("Unverified delegations");

    const graderMessages = deepFreeze([user("Grade the work")]);
    const grader = event(graderMessages, { sessionID: "grader-child", agent: V2_GRADER_AGENT });
    await hook(grader);
    expect(grader.messages).toBe(graderMessages);
    expect(cacheMarks(grader.messages)).toEqual([]);
    expect(systemText(grader)).not.toContain("Route hint: for");

    // A role session is a child of the orchestrator too (the host runs roles as subagents): same outcome.
    const roleMessages = deepFreeze([user("Research the parser")]);
    const role = event(roleMessages, { sessionID: "child", agent: "researcher" });
    await hook(role);
    expect(role.messages).toBe(roleMessages);
    expect(systemText(role)).not.toContain("Route hint: for");

    // The root session of the same host still gets its tail.
    const root = event(deepFreeze([user("Go on")]));
    await hook(root);
    expect(tailOf(root)).toContain(ROUTE_HINT);
  });

  it("advise mode: moving the clock by two minutes leaves event.system unchanged and puts no hint in it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { hook } = await boot({ routing: { engine: "advise" } });
      register(1);
      const messages = deepFreeze([user("Implement the parser change")]);

      const before = event(messages);
      await hook(before);
      vi.setSystemTime(Date.now() + 2 * 60_000);
      const after = event(messages);
      await hook(after);

      expect(after.system).toEqual(before.system);
      expect(after.system[0]).toBe(HOST_PART);
      expect(before.system.length).toBeGreaterThan(1);
      expect(systemText(before)).not.toContain("Route hint: for");
      expect(tailOf(after)).toContain("Unverified delegations");
      expect(e2eCacheCount(before)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("advise mode: recording routing outcomes between two requests leaves event.system unchanged", async () => {
    const outcomes = join(home, "outcomes");
    mkdirSync(outcomes, { recursive: true });
    const { hook } = await boot({ routing: { engine: "advise", outcomes: { path: outcomes } } });
    const bundle = acquireOutcomes({ dir: outcomes, tuning: DEFAULT_OUTCOME_TUNING, logger: { warn: vi.fn() } });
    await bundle.ready;
    register(1);
    const messages = deepFreeze([user("Implement the parser change")]);

    const before = event(messages);
    await hook(before);

    // Enough evidence that a class could move to another destination (D2: >= 5 outcomes for the winner).
    const key = makeKey("implement", { origin: "router", id: "heavy" }, "anthropic", "claude-opus-5-5", "xhigh");
    for (let i = 0; i < 12; i++) bundle.store.recordVerdict(key, "pass", { attemptID: `p${i}`, step: "dispatch" });
    const after = event(messages);
    await hook(after);

    expect(after.system).toEqual(before.system);
    expect(after.system[0]).toBe(HOST_PART);
    expect(before.system.length).toBeGreaterThan(1);
    expect(tailOf(after)).toContain("Unverified delegations");
  });

  it("a provider that throws does not fail the request: its section is skipped and the others are kept", async () => {
    const { hook } = await boot();
    register(1);
    needRegistry().registerTurnStateProvider({ name: "broken", order: 50, render: () => { throw new Error("provider exploded"); } });

    const e = event([user("Go on")]);
    await expect(hook(e)).resolves.toBeUndefined();
    const tail = tailOf(e);
    expect(tail).toContain("Unverified delegations");
    expect(tail).not.toContain("provider exploded");
    expect(cacheMarks(e.messages)).toEqual([{ message: 0, part: 0 }]);
  });
});
