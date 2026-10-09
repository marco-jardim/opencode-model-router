/**
 * #90 P1.3: the v2 TUI entry (`src/tui/plugin.ts`) against a fake host context. `@opentui/solid` is mocked with a node
 * tree that records tags, props and inserted accessors (evaluated to text by `rowsOf`); `solid-js` is its reactive
 * (browser) build, so signals drive the views as they do on the host. Timers are fake: the effort channel's pulls run
 * only when a test advances the clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("solid-js", async () => {
  // Under Node `solid-js` resolves to its server build, where signals never update: load the reactive build.
  const browserBuild: string = "../../node_modules/solid-js/dist/solid.js";
  return import(/* @vite-ignore */ browserBuild);
});

vi.mock("@opentui/solid", () => {
  type Node = { tag: string; props: Record<string, unknown>; inserts: unknown[] };
  return {
    createElement: (tag: string): Node => ({ tag, props: {}, inserts: [] }),
    insert: (parent: Node, accessor: unknown): unknown => {
      parent.inserts.push(accessor);
      return accessor;
    },
    setProp: <T>(node: Node, name: string, value: T): T => {
      node.props[name] = value;
      return value;
    },
  };
});

import { createEffect, createRoot, createSignal } from "solid-js";
import plugin, {
  appliedOf,
  BACKOFF_MAX_MS,
  COMPOSER_SLOT,
  effortWithVariant,
  FAILURE_COOLDOWN_MS,
  FOOTER_SLOT,
  isUnavailable,
  POLL_INTERVAL_MS,
  STATUS_PLUGIN_ID,
} from "../../src/tui/plugin";
import type {
  ComposerTopInput,
  HostContext,
  HostCurrentModel,
  HostMessage,
  HostModelInfo,
  HostRenderer,
  HostResizeListener,
  HostRpcDefinition,
  HostSession,
  HostSessionStatus,
  HostSlotClaim,
  PromptFooterInput,
} from "../../src/tui/host-types";
import { displayWidth } from "../../src/tui/status-model";

// ── fake @opentui/solid tree ──────────────────────────────────────────────────────────────────────────────────────

interface FakeNode {
  readonly tag: string;
  readonly props: Record<string, unknown>;
  readonly inserts: unknown[];
}

function isFakeNode(value: unknown): value is FakeNode {
  return typeof value === "object" && value !== null && "tag" in value && "props" in value && "inserts" in value;
}

function evaluate(value: unknown): unknown {
  return typeof value === "function" ? value() : value;
}

function boxOf(view: unknown): FakeNode {
  if (!isFakeNode(view) || view.tag !== "box") throw new Error("a slot render must return a box");
  return view;
}

/** The `text` children the box currently holds. */
function textNodes(view: unknown): FakeNode[] {
  return boxOf(view)
    .inserts.flatMap((accessor) => {
      const value = evaluate(accessor);
      return Array.isArray(value) ? value : [value];
    })
    .filter(isFakeNode);
}

function rowsOf(view: unknown): string[] {
  return textNodes(view).map((node) =>
    node.inserts
      .map(evaluate)
      .filter((value) => typeof value === "string")
      .join(""),
  );
}

// ── fake host ─────────────────────────────────────────────────────────────────────────────────────────────────────

const ROOT = "ses_root";
const CHILD = "ses_child";
const OPUS = { id: "claude-opus-4", providerID: "anthropic" } as const;
const SONNET = { id: "claude-sonnet-4", providerID: "anthropic" } as const;
const GPT = { id: "gpt-5", providerID: "openai" } as const;
const MODELS: readonly HostModelInfo[] = [
  { ...OPUS, name: "Claude Opus 4" },
  { ...SONNET, name: "Claude Sonnet 4" },
  { ...GPT, name: "GPT-5" },
];

function childSession(id: string, extra: Partial<HostSession> = {}): HostSession {
  return { id, parentID: ROOT, agent: "explore", model: { ...SONNET, variant: "low" }, time: { created: 2 }, ...extra };
}

interface FakeInit {
  options?: unknown;
  rpc?: boolean;
  renderer?: HostRenderer;
}

function fakeHost(init: FakeInit = {}) {
  const [sessions, setSessions] = createSignal<Record<string, HostSession>>({
    [ROOT]: { id: ROOT, agent: "build", model: { ...OPUS }, time: { created: 1 } },
  });
  const [messages, setMessages] = createSignal<Record<string, readonly HostMessage[]>>({});
  const [statuses, setStatuses] = createSignal<Record<string, HostSessionStatus>>({});
  const [current, setCurrent] = createSignal<HostCurrentModel | undefined>({ providerID: OPUS.providerID, modelID: OPUS.id });
  const answers = new Map<string, unknown>();
  const effortOf = vi.fn(async (input: { sessionID: string }): Promise<unknown> => answers.get(input.sessionID) ?? {});
  const rpc = vi.fn((_definition: HostRpcDefinition): unknown => ({ effortOf }));
  const sync = vi.fn(async (_sessionID: string): Promise<void> => undefined);
  const toast = vi.fn();
  const claims: HostSlotClaim[] = [];
  const disposers: Array<ReturnType<typeof vi.fn>> = [];
  const rootOf = (id: string): string => {
    let at = id;
    for (let depth = 0; depth < 10; depth++) {
      const parent = sessions()[at]?.parentID;
      if (parent === undefined) return at;
      at = parent;
    }
    return at;
  };
  const context: HostContext = {
    options: init.options,
    renderer: init.renderer ?? { width: 84 },
    theme: { textMuted: "muted" },
    client: init.rpc === false ? {} : { rpc },
    data: {
      session: {
        get: (id) => sessions()[id],
        family: (id) => Object.keys(sessions()).filter((other) => rootOf(other) === rootOf(id)),
        status: (id) => statuses()[id] ?? "idle",
        message: { list: (id) => messages()[id] ?? [], sync },
      },
      location: { model: { list: () => MODELS } },
    },
    ui: {
      toast: { show: toast },
      model: { current: () => current() },
      slot: (claim) => {
        claims.push(claim);
        const dispose = vi.fn();
        disposers.push(dispose);
        return dispose;
      },
    },
  };
  return {
    context,
    claims,
    disposers,
    toast,
    effortOf,
    rpc,
    sync,
    answers,
    setCurrent,
    addSession: (session: HostSession) => setSessions((all) => ({ ...all, [session.id]: session })),
    setStatus: (id: string, status: HostSessionStatus) => setStatuses((all) => ({ ...all, [id]: status })),
    addMessage: (id: string, message: HostMessage) =>
      setMessages((all) => ({ ...all, [id]: [...(all[id] ?? []), message] })),
  };
}

type Fake = ReturnType<typeof fakeHost>;

const teardown: Array<() => void> = [];

function start(fake: { context: HostContext }): () => void {
  const cleanup = plugin.setup(fake.context);
  teardown.push(cleanup);
  return cleanup;
}

function claimFor<P extends HostSlotClaim["append"]>(
  claims: readonly HostSlotClaim[],
  path: P,
): Extract<HostSlotClaim, { append: P }> {
  const claim = claims.find((item): item is Extract<HostSlotClaim, { append: P }> => item.append === path);
  if (claim === undefined) throw new Error(`no claim for ${path}`);
  return claim;
}

interface Mounted {
  readonly view: unknown;
  rows(): string[];
  dispose(): void;
}

function mount(render: () => unknown): Mounted {
  let dispose = (): void => undefined;
  const view = createRoot((disposeRoot) => {
    dispose = disposeRoot;
    return render();
  });
  teardown.push(() => dispose());
  return { view, rows: () => rowsOf(view), dispose: () => dispose() };
}

function mountFooter(claims: readonly HostSlotClaim[], sessionID: () => string | undefined): Mounted {
  const claim = claimFor(claims, FOOTER_SLOT);
  const input: PromptFooterInput = {
    get sessionID() {
      return sessionID();
    },
    mode: "normal",
    showDetails: false,
  };
  return mount(() => claim.render(input));
}

function mountComposer(claims: readonly HostSlotClaim[], sessionID: () => string): Mounted {
  const claim = claimFor(claims, COMPOSER_SLOT);
  const input: ComposerTopInput = {
    get sessionID() {
      return sessionID();
    },
  };
  return mount(() => claim.render(input));
}

const tick = (ms = 0): Promise<unknown> => vi.advanceTimersByTimeAsync(ms);

async function microtasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function warnings(): string[] {
  return vi.mocked(console.warn).mock.calls.map((call) => String(call[0]));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  for (const step of teardown.splice(0).reverse()) step();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── tests ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("test harness", () => {
  it("loads the reactive solid-js build: a signal change re-runs an effect", () => {
    const seen: number[] = [];
    const [value, setValue] = createSignal(0);
    const dispose = createRoot((disposeRoot) => {
      createEffect(() => seen.push(value()));
      return disposeRoot;
    });
    setValue(1);
    dispose();
    setValue(2);
    expect(seen).toEqual([0, 1]);
  });
});

describe("registration (D7, A4)", () => {
  it("is a plain { id, setup } object with the status plugin id", () => {
    expect(Object.keys(plugin).sort()).toEqual(["id", "setup"]);
    expect(plugin.id).toBe(STATUS_PLUGIN_ID);
    expect(STATUS_PLUGIN_ID).toBe("opencode-model-router.status");
  });

  it("appends to prompt.footer.status and session.composer.top by default", () => {
    const fake = fakeHost();
    start(fake);
    expect(fake.claims.map((claim) => claim.append)).toEqual(["prompt.footer.status", "session.composer.top"]);
    for (const claim of fake.claims) {
      expect(Object.keys(claim).sort()).toEqual(["append", "render"]);
      expect(typeof claim.render).toBe("function");
    }
    expect(fake.toast).not.toHaveBeenCalled();
  });

  it.each([
    [{ enabled: false }, []],
    [{ footer: false, childView: false, runningRow: false }, []],
    [{ footer: false }, [COMPOSER_SLOT]],
    [{ childView: false }, [FOOTER_SLOT, COMPOSER_SLOT]],
    [{ runningRow: false }, [FOOTER_SLOT, COMPOSER_SLOT]],
    [{ childView: false, runningRow: false }, [FOOTER_SLOT]],
  ])("options %j claim %j", (options, expected) => {
    const fake = fakeHost({ options });
    start(fake);
    expect(fake.claims.map((claim) => claim.append)).toEqual(expected);
  });

  it("shows one warning toast for invalid options and keeps the defaults", () => {
    const fake = fakeHost({ options: { footer: "yes", maxRows: 99, colour: 1 } });
    start(fake);
    expect(fake.toast).toHaveBeenCalledTimes(1);
    expect(fake.toast).toHaveBeenCalledWith({
      message: expect.stringMatching(/^model-router status: invalid TUI options \(/),
      variant: "warning",
    });
    expect(fake.claims.map((claim) => claim.append)).toEqual([FOOTER_SLOT, COMPOSER_SLOT]);
  });

  it("shows the notice and claims nothing when disabled with an invalid key", () => {
    const fake = fakeHost({ options: { enabled: false, bogus: 1 } });
    start(fake);
    expect(fake.toast).toHaveBeenCalledTimes(1);
    expect(fake.claims).toEqual([]);
  });

  it("makes no rpc call and starts no timer in setup", () => {
    const fake = fakeHost();
    start(fake);
    expect(fake.rpc).not.toHaveBeenCalled();
    expect(fake.effortOf).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("G1 main footer (A3)", () => {
  it("shows effort default in a root session without a selected variant", () => {
    const fake = fakeHost();
    start(fake);
    const footer = mountFooter(fake.claims, () => ROOT);
    expect(footer.rows()).toEqual(["effort default"]);
    const box = boxOf(footer.view);
    expect(box.props.flexDirection).toBe("column");
    expect(textNodes(footer.view).map((node) => node.tag)).toEqual(["text"]);
  });

  it("shows effort default on the home prompt and pulls nothing", async () => {
    const fake = fakeHost();
    start(fake);
    const footer = mountFooter(fake.claims, () => undefined);
    expect(footer.rows()).toEqual(["effort default"]);
    await tick(20_000);
    expect(fake.effortOf).not.toHaveBeenCalled();
  });

  it("shows nothing in a child session and follows the session reactively", () => {
    const fake = fakeHost();
    fake.addSession(childSession(CHILD));
    start(fake);
    const [sessionID, setSessionID] = createSignal<string | undefined>(CHILD);
    const footer = mountFooter(fake.claims, sessionID);
    expect(footer.rows()).toEqual([]);
    expect(textNodes(footer.view)).toEqual([]);
    setSessionID(ROOT);
    expect(footer.rows()).toEqual(["effort default"]);
    setSessionID(CHILD);
    expect(footer.rows()).toEqual([]);
  });

  it("shows nothing while a variant is selected, without pulling, and reacts when it is cleared", async () => {
    const fake = fakeHost();
    fake.setCurrent({ providerID: OPUS.providerID, modelID: OPUS.id, variant: "high" });
    start(fake);
    const footer = mountFooter(fake.claims, () => ROOT);
    expect(footer.rows()).toEqual([]);
    await tick(10_000);
    expect(fake.effortOf).not.toHaveBeenCalled();
    fake.setCurrent({ providerID: OPUS.providerID, modelID: OPUS.id });
    expect(footer.rows()).toEqual(["effort default"]);
  });

  it("shows the effort the channel reports for the prompt's current model", async () => {
    const fake = fakeHost();
    fake.answers.set(ROOT, { effort: "high", providerID: OPUS.providerID, modelID: OPUS.id, agent: "build", at: 1 });
    start(fake);
    const footer = mountFooter(fake.claims, () => ROOT);
    expect(footer.rows()).toEqual(["effort default"]);
    await tick(0);
    expect(fake.effortOf).toHaveBeenCalledWith({ sessionID: ROOT });
    expect(footer.rows()).toEqual(["effort high"]);
  });

  it("ignores an applied effort recorded with a variant (stale once the variant is cleared)", async () => {
    const fake = fakeHost();
    fake.answers.set(ROOT, { effort: "high", variant: "high", providerID: OPUS.providerID, modelID: OPUS.id });
    start(fake);
    const footer = mountFooter(fake.claims, () => ROOT);
    await tick(0);
    expect(fake.effortOf).toHaveBeenCalledTimes(1);
    expect(footer.rows()).toEqual(["effort default"]);
  });

  it("ignores an applied effort recorded for another model", async () => {
    const fake = fakeHost();
    fake.answers.set(ROOT, { effort: "high", providerID: SONNET.providerID, modelID: SONNET.id });
    start(fake);
    const footer = mountFooter(fake.claims, () => ROOT);
    await tick(0);
    expect(footer.rows()).toEqual(["effort default"]);
    fake.setCurrent({ providerID: SONNET.providerID, modelID: SONNET.id });
    expect(footer.rows()).toEqual(["effort high"]);
  });
});

describe("G2 child view (A5)", () => {
  it("shows the session's model before any message and syncs the messages once", async () => {
    const fake = fakeHost();
    fake.addSession(childSession(CHILD));
    start(fake);
    const view = mountComposer(fake.claims, () => CHILD);
    expect(view.rows()).toEqual(["explore · Claude Sonnet 4 · low"]);
    expect(fake.sync).not.toHaveBeenCalled();
    await microtasks();
    expect(fake.sync).toHaveBeenCalledTimes(1);
    expect(fake.sync).toHaveBeenCalledWith(CHILD);
    fake.addSession(childSession(CHILD, { title: "renamed" }));
    mountComposer(fake.claims, () => CHILD);
    await microtasks();
    expect(fake.sync).toHaveBeenCalledTimes(1);
  });

  it("swallows a rejected message sync", async () => {
    const fake = fakeHost();
    fake.sync.mockRejectedValue(new Error("offline"));
    fake.addSession(childSession(CHILD));
    start(fake);
    const view = mountComposer(fake.claims, () => CHILD);
    await microtasks();
    expect(fake.sync).toHaveBeenCalledTimes(1);
    expect(view.rows()).toEqual(["explore · Claude Sonnet 4 · low"]);
  });

  it("follows the latest assistant message after a model switch", () => {
    const fake = fakeHost();
    fake.addSession(childSession(CHILD));
    start(fake);
    const view = mountComposer(fake.claims, () => CHILD);
    fake.addMessage(CHILD, { id: "m1", type: "assistant", agent: "explore", model: { ...GPT, variant: "high" }, time: { created: 10 } });
    expect(view.rows()).toEqual(["explore · GPT-5 · high"]);
    fake.addMessage(CHILD, { id: "m2", type: "user", time: { created: 20 } });
    expect(view.rows()).toEqual(["explore · GPT-5 · high"]);
    fake.addMessage(CHILD, { id: "m3", type: "assistant", model: { ...OPUS }, time: { created: { epochMilliseconds: 30 } } });
    expect(view.rows()).toEqual(["explore · Claude Opus 4 · default"]);
  });

  it("prefers the channel's effort for the shown model", async () => {
    const fake = fakeHost();
    fake.addSession(childSession(CHILD));
    fake.answers.set(CHILD, { effort: "max", providerID: SONNET.providerID, modelID: SONNET.id });
    start(fake);
    const view = mountComposer(fake.claims, () => CHILD);
    await tick(0);
    expect(fake.effortOf).toHaveBeenCalledWith({ sessionID: CHILD });
    expect(view.rows()).toEqual(["explore · Claude Sonnet 4 · max"]);
  });

  it("shows effort and variant when the channel reports both and they differ (QA-6)", async () => {
    const fake = fakeHost();
    fake.addSession(childSession(CHILD));
    fake.answers.set(CHILD, { effort: "high", variant: "max", providerID: SONNET.providerID, modelID: SONNET.id });
    start(fake);
    const view = mountComposer(fake.claims, () => CHILD);
    await tick(0);
    expect(view.rows()).toEqual(["explore · Claude Sonnet 4 · high (max)"]);
  });

  it("ignores the channel's effort recorded for another model", async () => {
    const fake = fakeHost();
    fake.addSession(childSession(CHILD));
    fake.answers.set(CHILD, { effort: "max", providerID: GPT.providerID, modelID: GPT.id });
    start(fake);
    const view = mountComposer(fake.claims, () => CHILD);
    await tick(0);
    expect(view.rows()).toEqual(["explore · Claude Sonnet 4 · low"]);
  });

  it("fits the row to the renderer width minus 4", () => {
    const fake = fakeHost({ renderer: { width: 30 } });
    fake.addSession(childSession(CHILD));
    start(fake);
    const view = mountComposer(fake.claims, () => CHILD);
    expect(view.rows()).toEqual(["e… · Claude Sonnet 4 · low"]);
    expect(displayWidth(view.rows()[0] ?? "")).toBe(26);
  });

  it("re-fits the rows on the renderer's resize event and removes the listener on cleanup", () => {
    const listeners = new Set<HostResizeListener>();
    const renderer = {
      width: 84,
      on: vi.fn((_event: "resize", listener: HostResizeListener) => listeners.add(listener)),
      off: vi.fn((_event: "resize", listener: HostResizeListener) => listeners.delete(listener)),
    };
    const fake = fakeHost({ renderer });
    fake.addSession(childSession(CHILD));
    const cleanup = start(fake);
    const view = mountComposer(fake.claims, () => CHILD);
    expect(view.rows()).toEqual(["explore · Claude Sonnet 4 · low"]);
    renderer.width = 30;
    for (const listener of listeners) listener(30, 20);
    expect(view.rows()).toEqual(["e… · Claude Sonnet 4 · low"]);
    cleanup();
    expect(renderer.off).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
  });

  it("shows nothing in a child session when childView is off, while G3 keeps working", () => {
    const fake = fakeHost({ options: { childView: false } });
    fake.addSession(childSession(CHILD));
    fake.setStatus(CHILD, "running");
    start(fake);
    expect(mountComposer(fake.claims, () => CHILD).rows()).toEqual([]);
    expect(mountComposer(fake.claims, () => ROOT).rows()).toEqual(["explore · Claude Sonnet 4 · low"]);
  });

  it("shows nothing while the session is unknown or has no model", () => {
    const fake = fakeHost();
    fake.addSession({ id: CHILD, parentID: ROOT, agent: "explore" });
    start(fake);
    expect(mountComposer(fake.claims, () => CHILD).rows()).toEqual([]);
    expect(mountComposer(fake.claims, () => "ses_missing").rows()).toEqual([]);
    expect(mountComposer(fake.claims, () => "").rows()).toEqual([]);
  });
});

describe("G3 running row", () => {
  const childA = childSession("ses_a", { agent: "explore", time: { created: 10 } });
  const childB = childSession("ses_b", { agent: "review", model: { ...GPT, variant: "high" }, time: { created: 20 } });

  it("adds a row while a child runs and removes it when the child is idle", () => {
    const fake = fakeHost();
    fake.addSession(childB);
    fake.addSession(childA);
    start(fake);
    const view = mountComposer(fake.claims, () => ROOT);
    expect(view.rows()).toEqual([]);
    expect(textNodes(view.view)).toEqual([]);
    fake.setStatus("ses_b", "running");
    expect(view.rows()).toEqual(["review · GPT-5 · high"]);
    fake.setStatus("ses_a", "running");
    expect(view.rows()).toEqual(["explore · Claude Sonnet 4 · low", "review · GPT-5 · high"]);
    fake.setStatus("ses_a", "idle");
    expect(view.rows()).toEqual(["review · GPT-5 · high"]);
    fake.setStatus("ses_b", "idle");
    expect(view.rows()).toEqual([]);
    expect(textNodes(view.view)).toEqual([]);
  });

  it("shows at most maxRows rows, then +k more, and pulls only the shown children", async () => {
    const fake = fakeHost({ options: { maxRows: 2 } });
    for (let i = 1; i <= 5; i++) {
      fake.addSession(childSession(`ses_${i}`, { agent: `agent${i}`, time: { created: i } }));
      fake.setStatus(`ses_${i}`, "running");
    }
    start(fake);
    const view = mountComposer(fake.claims, () => ROOT);
    expect(view.rows()).toEqual(["agent1 · Claude Sonnet 4 · low", "agent2 · Claude Sonnet 4 · low", "+3 more"]);
    await tick(0);
    expect(fake.effortOf.mock.calls.map(([input]) => input.sessionID).sort()).toEqual(["ses_1", "ses_2"]);
  });

  it("defaults to 4 rows", () => {
    const fake = fakeHost();
    for (let i = 1; i <= 6; i++) {
      fake.addSession(childSession(`ses_${i}`, { agent: `agent${i}`, time: { created: i } }));
      fake.setStatus(`ses_${i}`, "running");
    }
    start(fake);
    const rows = mountComposer(fake.claims, () => ROOT).rows();
    expect(rows).toHaveLength(5);
    expect(rows.at(-1)).toBe("+2 more");
  });

  it("shows the channel's effort per child and syncs empty message lists once", async () => {
    const fake = fakeHost();
    fake.addSession(childA);
    fake.setStatus("ses_a", "running");
    fake.answers.set("ses_a", { effort: "max", providerID: SONNET.providerID, modelID: SONNET.id });
    start(fake);
    const view = mountComposer(fake.claims, () => ROOT);
    expect(view.rows()).toEqual(["explore · Claude Sonnet 4 · low"]);
    await tick(0);
    expect(view.rows()).toEqual(["explore · Claude Sonnet 4 · max"]);
    expect(fake.sync).toHaveBeenCalledTimes(1);
    expect(fake.sync).toHaveBeenCalledWith("ses_a");
  });

  it("shows nothing in a root session when runningRow is off", () => {
    const fake = fakeHost({ options: { runningRow: false } });
    fake.addSession(childA);
    fake.setStatus("ses_a", "running");
    start(fake);
    expect(mountComposer(fake.claims, () => ROOT).rows()).toEqual([]);
  });
});

describe("effort channel (A1)", () => {
  it("pulls on a timer, never synchronously in setup or render", async () => {
    const fake = fakeHost();
    fake.addSession(childSession(CHILD));
    start(fake);
    mountComposer(fake.claims, () => CHILD);
    expect(fake.rpc).not.toHaveBeenCalled();
    expect(fake.effortOf).not.toHaveBeenCalled();
    await tick(0);
    expect(fake.rpc).toHaveBeenCalledTimes(1);
    expect(fake.rpc.mock.calls[0]?.[0].id).toBe("opencode-model-router.effort");
    expect(fake.effortOf).toHaveBeenCalledTimes(1);
  });

  it("shares one poller between the views of a session", async () => {
    const fake = fakeHost();
    fake.addSession(childSession(CHILD));
    start(fake);
    mountComposer(fake.claims, () => CHILD);
    mountComposer(fake.claims, () => CHILD);
    await tick(0);
    expect(fake.effortOf).toHaveBeenCalledTimes(1);
  });

  it("re-pulls when the status changes and polls every 5 s while running", async () => {
    const fake = fakeHost();
    fake.addSession(childSession(CHILD));
    start(fake);
    mountComposer(fake.claims, () => CHILD);
    await tick(0);
    expect(fake.effortOf).toHaveBeenCalledTimes(1);
    await tick(10_000);
    expect(fake.effortOf).toHaveBeenCalledTimes(1);
    fake.setStatus(CHILD, "running");
    await tick(0);
    expect(fake.effortOf).toHaveBeenCalledTimes(2);
    await tick(POLL_INTERVAL_MS - 1);
    expect(fake.effortOf).toHaveBeenCalledTimes(2);
    await tick(1);
    expect(fake.effortOf).toHaveBeenCalledTimes(3);
    await tick(POLL_INTERVAL_MS);
    expect(fake.effortOf).toHaveBeenCalledTimes(4);
    fake.setStatus(CHILD, "idle");
    await tick(POLL_INTERVAL_MS);
    expect(fake.effortOf).toHaveBeenCalledTimes(5);
    await tick(60_000);
    expect(fake.effortOf).toHaveBeenCalledTimes(5);
  });

  it("debounces trigger pulls (new messages) to the 5 s interval", async () => {
    const fake = fakeHost();
    fake.addSession(childSession(CHILD));
    start(fake);
    mountComposer(fake.claims, () => CHILD);
    await tick(0);
    await tick(1_000);
    fake.addMessage(CHILD, { id: "m1", type: "user", time: { created: 5 } });
    await tick(1_000);
    fake.addMessage(CHILD, { id: "m2", type: "assistant", model: { ...SONNET }, time: { created: 6 } });
    await tick(2_999);
    expect(fake.effortOf).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(fake.effortOf).toHaveBeenCalledTimes(2);
    await tick(60_000);
    expect(fake.effortOf).toHaveBeenCalledTimes(2);
  });

  it("retries unavailable errors with backoff 1 s, 2 s, 4 s … 30 s, without warning", async () => {
    const fake = fakeHost();
    fake.addSession(childSession(CHILD));
    fake.effortOf.mockRejectedValue(new Error("rpc.unavailable: opencode-model-router.effort"));
    start(fake);
    const view = mountComposer(fake.claims, () => CHILD);
    await tick(0);
    expect(fake.effortOf).toHaveBeenCalledTimes(1);
    const delays = [1_000, 2_000, 4_000, 8_000, 16_000, BACKOFF_MAX_MS, BACKOFF_MAX_MS];
    for (const [index, delay] of delays.entries()) {
      await tick(delay - 1);
      expect(fake.effortOf).toHaveBeenCalledTimes(index + 1);
      await tick(1);
      expect(fake.effortOf).toHaveBeenCalledTimes(index + 2);
    }
    expect(view.rows()).toEqual(["explore · Claude Sonnet 4 · low"]);
    fake.effortOf.mockResolvedValue({ effort: "max", providerID: SONNET.providerID, modelID: SONNET.id });
    await tick(BACKOFF_MAX_MS);
    expect(view.rows()).toEqual(["explore · Claude Sonnet 4 · max"]);
    expect(warnings()).toEqual([]);
  });

  it("falls back to the message variant for 30 s after another error, warning once", async () => {
    const fake = fakeHost();
    fake.addSession(childSession(CHILD));
    fake.setStatus(CHILD, "running");
    fake.answers.set(CHILD, { effort: "max", providerID: SONNET.providerID, modelID: SONNET.id });
    start(fake);
    const view = mountComposer(fake.claims, () => CHILD);
    await tick(0);
    expect(view.rows()).toEqual(["explore · Claude Sonnet 4 · max"]);
    fake.effortOf.mockRejectedValue(new Error("boom"));
    await tick(POLL_INTERVAL_MS);
    expect(fake.effortOf).toHaveBeenCalledTimes(2);
    expect(view.rows()).toEqual(["explore · Claude Sonnet 4 · low"]);
    await tick(FAILURE_COOLDOWN_MS - 1);
    expect(fake.effortOf).toHaveBeenCalledTimes(2);
    await tick(1);
    expect(fake.effortOf).toHaveBeenCalledTimes(3);
    expect(warnings()).toEqual(["model-router status: effort channel failed: boom"]);
    fake.effortOf.mockResolvedValue({ effort: "max", providerID: SONNET.providerID, modelID: SONNET.id });
    await tick(FAILURE_COOLDOWN_MS);
    expect(fake.effortOf).toHaveBeenCalledTimes(4);
    expect(view.rows()).toEqual(["explore · Claude Sonnet 4 · max"]);
  });

  it("treats an rpc client without effortOf as an error", async () => {
    const fake = fakeHost();
    fake.addSession(childSession(CHILD));
    fake.rpc.mockReturnValue({});
    start(fake);
    const view = mountComposer(fake.claims, () => CHILD);
    await tick(0);
    expect(view.rows()).toEqual(["explore · Claude Sonnet 4 · low"]);
    expect(warnings()).toEqual(["model-router status: effort channel failed: the rpc client has no effortOf method"]);
  });

  it("falls back to the message variant without an rpc client and starts no timer", async () => {
    const fake = fakeHost({ rpc: false });
    fake.addSession(childSession(CHILD));
    fake.setStatus(CHILD, "running");
    start(fake);
    const view = mountComposer(fake.claims, () => CHILD);
    expect(view.rows()).toEqual(["explore · Claude Sonnet 4 · low"]);
    expect(vi.getTimerCount()).toBe(0);
    await tick(60_000);
    expect(fake.effortOf).not.toHaveBeenCalled();
  });

  it("stops polling when no view needs the session", async () => {
    const fake = fakeHost();
    fake.addSession(childSession(CHILD));
    fake.setStatus(CHILD, "running");
    start(fake);
    const view = mountComposer(fake.claims, () => CHILD);
    await tick(0);
    expect(vi.getTimerCount()).toBe(1);
    view.dispose();
    await microtasks();
    expect(vi.getTimerCount()).toBe(0);
    await tick(60_000);
    expect(fake.effortOf).toHaveBeenCalledTimes(1);
  });
});

describe("feature detection and error isolation", () => {
  it("never throws from setup on a missing or broken context", () => {
    expect(typeof plugin.setup(undefined)).toBe("function");
    expect(typeof plugin.setup({})).toBe("function");
    const broken: HostContext = {
      get options(): unknown {
        throw new Error("options gone");
      },
    };
    expect(() => plugin.setup(broken)()).not.toThrow();
    expect(warnings()).toEqual(["model-router status: setup failed: options gone"]);
  });

  it("survives a throwing ui.slot and toast", () => {
    const context: HostContext = {
      options: { bogus: true },
      ui: {
        toast: {
          show: () => {
            throw new Error("no toast");
          },
        },
        slot: () => {
          throw new Error("no slots");
        },
      },
    };
    const cleanup = plugin.setup(context);
    expect(() => cleanup()).not.toThrow();
    expect(warnings()).toEqual([
      "model-router status: notice failed: no toast",
      "model-router status: slot prompt.footer.status failed: no slots",
      "model-router status: slot session.composer.top failed: no slots",
    ]);
  });

  it("renders with only ui.slot: no data, client, renderer or theme", async () => {
    const claims: HostSlotClaim[] = [];
    const cleanup = plugin.setup({
      ui: {
        slot: (claim) => {
          claims.push(claim);
          return undefined;
        },
      },
    });
    teardown.push(cleanup);
    const footer = mountFooter(claims, () => ROOT);
    expect(footer.rows()).toEqual(["effort default"]);
    expect(textNodes(footer.view)[0]?.props.fg).toBeUndefined();
    expect(mountComposer(claims, () => ROOT).rows()).toEqual([]);
    await tick(60_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(warnings()).toEqual([]);
  });

  it("colours every row with the theme's muted text colour", () => {
    const fake = fakeHost();
    fake.addSession(childSession("ses_a"));
    fake.addSession(childSession("ses_b"));
    fake.setStatus("ses_a", "running");
    fake.setStatus("ses_b", "running");
    start(fake);
    const view = mountComposer(fake.claims, () => ROOT);
    expect(textNodes(view.view).map((node) => node.props.fg)).toEqual(["muted", "muted"]);
  });

  it("renders no rows and warns once per view when data.session.get throws", () => {
    const fake = fakeHost();
    const session = fake.context.data?.session;
    if (session === undefined) throw new Error("fake without data.session");
    const context: HostContext = {
      ...fake.context,
      data: {
        ...fake.context.data,
        session: {
          ...session,
          get: () => {
            throw new Error("store gone");
          },
        },
      },
    };
    teardown.push(plugin.setup(context));
    expect(mountComposer(fake.claims, () => ROOT).rows()).toEqual([]);
    expect(mountComposer(fake.claims, () => CHILD).rows()).toEqual([]);
    expect(mountFooter(fake.claims, () => ROOT).rows()).toEqual([]);
    expect(warnings()).toEqual([
      "model-router status: composer view failed: store gone",
      "model-router status: footer view failed: store gone",
    ]);
  });

  it("renders no rows and warns once when message.list throws, and recovers", () => {
    const fake = fakeHost();
    fake.addSession(childSession(CHILD));
    const session = fake.context.data?.session;
    if (session === undefined) throw new Error("fake without data.session");
    const [broken, setBroken] = createSignal(true);
    const context: HostContext = {
      ...fake.context,
      data: {
        ...fake.context.data,
        session: {
          ...session,
          message: {
            list: (id) => {
              if (broken()) throw new Error("list gone");
              return session.message?.list?.(id) ?? [];
            },
          },
        },
      },
    };
    teardown.push(plugin.setup(context));
    const view = mountComposer(fake.claims, () => CHILD);
    expect(view.rows()).toEqual([]);
    mountComposer(fake.claims, () => CHILD);
    expect(warnings()).toEqual(["model-router status: composer view failed: list gone"]);
    setBroken(false);
    expect(view.rows()).toEqual(["explore · Claude Sonnet 4 · low"]);
  });

  it("keeps the fallback when client.rpc throws, warning once", async () => {
    const fake = fakeHost();
    fake.addSession(childSession(CHILD));
    fake.rpc.mockImplementation(() => {
      throw new Error("rpc broken");
    });
    start(fake);
    const view = mountComposer(fake.claims, () => CHILD);
    mountComposer(fake.claims, () => CHILD);
    await tick(0);
    expect(view.rows()).toEqual(["explore · Claude Sonnet 4 · low"]);
    expect(warnings()).toEqual(["model-router status: effort channel failed: rpc broken"]);
  });

  it("uses 80 columns when the renderer's width is unusable", () => {
    const renderer: HostRenderer = {
      get width(): number {
        throw new Error("no width");
      },
    };
    const fake = fakeHost({ renderer });
    fake.addSession(childSession(CHILD, { agent: "a".repeat(120) }));
    start(fake);
    const [row] = mountComposer(fake.claims, () => CHILD).rows();
    expect(displayWidth(row ?? "")).toBe(76);
    expect(row?.endsWith(" · Claude Sonnet 4 · low")).toBe(true);
  });
});

describe("cleanup", () => {
  function running(): Fake {
    const fake = fakeHost();
    fake.addSession(childSession(CHILD));
    fake.setStatus(CHILD, "running");
    return fake;
  }

  it("disposes every claim, clears every timer and is idempotent", async () => {
    const fake = running();
    const cleanup = start(fake);
    mountComposer(fake.claims, () => ROOT);
    mountComposer(fake.claims, () => CHILD);
    mountFooter(fake.claims, () => ROOT);
    await tick(0);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    cleanup();
    cleanup();
    expect(fake.disposers).toHaveLength(2);
    for (const dispose of fake.disposers) expect(dispose).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("schedules nothing after cleanup, even when views re-render", async () => {
    const fake = running();
    const cleanup = start(fake);
    const view = mountComposer(fake.claims, () => CHILD);
    await tick(0);
    cleanup();
    fake.setStatus(CHILD, "idle");
    fake.addMessage(CHILD, { id: "m1", type: "assistant", model: { ...GPT }, time: { created: 3 } });
    expect(view.rows()).toEqual(["explore · GPT-5 · default"]);
    mountComposer(fake.claims, () => CHILD);
    await microtasks();
    expect(vi.getTimerCount()).toBe(0);
    await tick(60_000);
    expect(fake.effortOf).toHaveBeenCalledTimes(1);
  });

  it("drops an answer that arrives after cleanup", async () => {
    const fake = running();
    let answer: (value: unknown) => void = () => undefined;
    fake.effortOf.mockImplementation(
      () =>
        new Promise<unknown>((resolve) => {
          answer = resolve;
        }),
    );
    const cleanup = start(fake);
    const view = mountComposer(fake.claims, () => CHILD);
    await tick(0);
    cleanup();
    answer({ effort: "max", providerID: SONNET.providerID, modelID: SONNET.id });
    await microtasks();
    expect(view.rows()).toEqual(["explore · Claude Sonnet 4 · low"]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("helpers", () => {
  it.each([
    ["high", undefined, "high"],
    ["high", "", "high"],
    ["high", "default", "high"],
    ["high", "high", "high"],
    ["high", "HIGH", "high"],
    ["high", "max", "high (max)"],
    [" high ", " max ", "high (max)"],
    ["default", "max", "default"],
    ["", "max", ""],
  ])("effortWithVariant(%j, %j) → %j (QA-6)", (effort, variant, expected) => {
    expect(effortWithVariant(effort, variant)).toBe(expected);
  });

  it.each([
    [undefined, undefined],
    [null, undefined],
    ["high", undefined],
    [{}, undefined],
    [{ effort: "high", providerID: "anthropic" }, undefined],
    [{ effort: " ", providerID: "anthropic", modelID: "m" }, undefined],
    [{ effort: "high", providerID: "anthropic", modelID: 3 }, undefined],
    [{ effort: "high", providerID: "anthropic", modelID: "m" }, { effort: "high", providerID: "anthropic", modelID: "m" }],
    [
      { effort: "high", variant: "max", providerID: "anthropic", modelID: "m", agent: "build", at: 1 },
      { effort: "high", variant: "max", providerID: "anthropic", modelID: "m" },
    ],
    [{ effort: "high", variant: "", providerID: "anthropic", modelID: "m" }, { effort: "high", providerID: "anthropic", modelID: "m" }],
  ])("appliedOf(%j) → %j", (output, expected) => {
    expect(appliedOf(output)).toEqual(expected);
  });

  it.each([
    [new Error("rpc.unavailable"), true],
    [Object.assign(new Error("not registered"), { name: "RpcUnavailableError" }), true],
    [{ _tag: "Unavailable" }, true],
    [{ code: "RPC_UNAVAILABLE" }, true],
    ["unavailable", true],
    [new Error("boom"), false],
    [null, false],
    [42, false],
  ])("isUnavailable(%s) → %s", (error, expected) => {
    expect(isUnavailable(error)).toBe(expected);
  });
});
