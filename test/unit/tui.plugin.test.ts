/**
 * #90 P1.3: the v2 TUI entry (`src/tui/plugin.ts`) against a fake host context. `@opentui/solid` is the real
 * `solid-js/universal` renderer (`createRenderer`) over a fake node tree, so every `insert` is a real render effect and
 * the tree changes as the host's would; `solid-js` is its reactive (browser) build, so signals drive the views as on
 * the host. Timers are fake: the effort channel's pulls run only when a test advances the clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A node of the fake host tree (what `@opentui/solid` renderables are to the reconciler). */
interface FakeNode {
  readonly tag: string;
  readonly props: Record<string, unknown>;
  readonly children: FakeNode[];
  parent: FakeNode | undefined;
  text: string;
}

/** The node API `createRenderer` drives, plus fault switches for error-isolation tests. */
const tree = vi.hoisted(() => {
  const faults = { textInsert: false, boxCreate: false };
  const make = (tag: string, text = ""): FakeNode => ({ tag, props: {}, children: [], parent: undefined, text });
  const detach = (node: FakeNode): void => {
    const parent = node.parent;
    if (parent === undefined) return;
    const index = parent.children.indexOf(node);
    if (index >= 0) parent.children.splice(index, 1);
    node.parent = undefined;
  };
  return {
    faults,
    createElement: (tag: string): FakeNode => {
      if (faults.boxCreate && tag === "box") throw new Error("box create failed");
      return make(tag);
    },
    createTextNode: (value: string | number): FakeNode => make("#text", String(value)),
    isTextNode: (node: FakeNode): boolean => node.tag === "#text",
    replaceText: (node: FakeNode, value: string): void => {
      node.text = value;
    },
    insertNode: (parent: FakeNode, node: FakeNode, anchor?: FakeNode): void => {
      if (faults.textInsert && parent.tag === "text") throw new Error("text insert failed");
      detach(node);
      const index = anchor === undefined ? -1 : parent.children.indexOf(anchor);
      if (index >= 0) parent.children.splice(index, 0, node);
      else parent.children.push(node);
      node.parent = parent;
    },
    removeNode: (parent: FakeNode, node: FakeNode): void => {
      if (node.parent === parent) detach(node);
    },
    setProperty: (node: FakeNode, name: string, value: unknown): void => {
      node.props[name] = value;
    },
    getParentNode: (node: FakeNode): FakeNode | undefined => node.parent,
    getFirstChild: (node: FakeNode): FakeNode | undefined => node.children[0],
    getNextSibling: (node: FakeNode | undefined): FakeNode | undefined => {
      const parent = node?.parent;
      return parent === undefined || node === undefined ? undefined : parent.children[parent.children.indexOf(node) + 1];
    },
  };
});

vi.mock("solid-js", async () => {
  // Under Node `solid-js` resolves to its server build, where signals never update: load the reactive build.
  const browserBuild: string = "../../node_modules/solid-js/dist/solid.js";
  return import(/* @vite-ignore */ browserBuild);
});

vi.mock("@opentui/solid", async () => {
  // The real `solid-js/universal` renderer over the fake tree. Its build imports bare `solid-js`, which Node would bind
  // to the server build (a second, non-reactive Solid): evaluate it with the reactive build above injected instead.
  const solid = await import("solid-js");
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../../node_modules/solid-js/universal/dist/universal.js", import.meta.url), "utf8");
  const header = /^import \{ ([\w, ]+) \} from 'solid-js';\r?\n/;
  const footer = /\r?\nexport \{ createRenderer \};\s*$/;
  const names = header.exec(source)?.[1];
  if (names === undefined || !footer.test(source)) throw new Error("unexpected solid-js/universal build");
  const body = source.replace(header, "").replace(footer, "\n");
  const make: unknown = new Function(
    "solid",
    `"use strict";\nconst { ${names} } = solid;\n${body}\nreturn createRenderer;`,
  )(solid);
  if (typeof make !== "function") throw new Error("solid-js/universal has no createRenderer");
  const renderer: unknown = make(tree);
  if (typeof renderer !== "object" || renderer === null) throw new Error("createRenderer returned no renderer");
  return {
    createElement: Reflect.get(renderer, "createElement"),
    insert: Reflect.get(renderer, "insert"),
    setProp: Reflect.get(renderer, "setProp"),
  };
});

import { createEffect, createRoot, createSignal } from "solid-js";
import plugin, {
  appliedOf,
  BACKOFF_MAX_MS,
  BACKOFF_START_MS,
  CALL_TIMEOUT_MS,
  COMPOSER_SLOT,
  effortWithVariant,
  FAILURE_COOLDOWN_MS,
  FOOTER_SLOT,
  isUnavailable,
  locationKey,
  MODEL_SYNC_MAX,
  NO_OWNER_NOTICE,
  POLL_INTERVAL_MS,
  PULL_STATE_MAX,
  QUICK_REPULLS,
  STATUS_PLUGIN_ID,
  SYNCED_MAX,
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
  HostTheme,
  PromptFooterInput,
} from "../../src/tui/host-types";
import { displayWidth } from "../../src/tui/status-model";

// ── fake tree reads ───────────────────────────────────────────────────────────────────────────────────────────────

function isFakeNode(value: unknown): value is FakeNode {
  return typeof value === "object" && value !== null && "tag" in value && "children" in value && "props" in value;
}

function boxOf(view: unknown): FakeNode {
  if (!isFakeNode(view) || view.tag !== "box") throw new Error("a slot render must return a box");
  return view;
}

/** The `text` children the box currently holds (it holds nothing else). */
function textNodes(view: unknown): FakeNode[] {
  const children = boxOf(view).children;
  expect(children.every((child) => child.tag === "text")).toBe(true);
  return [...children];
}

function rowsOf(view: unknown): string[] {
  return textNodes(view).map((node) => node.children.map((child) => child.text).join(""));
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
/** GA-5: the toast names the effect, not an unreproduced cause. */
const OWNER_WARNING = "model-router status: render has no Solid owner: the views are static (no live updates)";
/** G3 is opt-in (A12): the options that turn the running-delegates rows on. */
const G3_ON = Object.freeze({ runningRow: true });

/** A host rpc failure as the client rethrows it: a plain `{ type, message }` (P13-1). */
function rpcFailure(type: string, message: string): { type: string; message: string } {
  return { type, message };
}

function childSession(id: string, extra: Partial<HostSession> = {}): HostSession {
  return { id, parentID: ROOT, agent: "explore", model: { ...SONNET, variant: "low" }, time: { created: 2 }, ...extra };
}

interface CallOptions {
  readonly location?: unknown;
  readonly signal?: AbortSignal;
}

interface FakeInit {
  options?: unknown;
  rpc?: boolean;
  renderer?: HostRenderer;
  theme?: HostTheme;
}

function fakeHost(init: FakeInit = {}) {
  const [sessions, setSessions] = createSignal<Record<string, HostSession>>({
    [ROOT]: { id: ROOT, agent: "build", model: { ...OPUS }, time: { created: 1 } },
  });
  const [messages, setMessages] = createSignal<Record<string, readonly HostMessage[]>>({});
  const [statuses, setStatuses] = createSignal<Record<string, HostSessionStatus>>({});
  const [current, setCurrent] = createSignal<HostCurrentModel | undefined>({ providerID: OPUS.providerID, modelID: OPUS.id });
  const answers = new Map<string, unknown>();
  const effortOf = vi.fn(
    async (input: { sessionID: string }, _options?: CallOptions): Promise<unknown> => answers.get(input.sessionID) ?? {},
  );
  const rpc = vi.fn((_definition: HostRpcDefinition): unknown => ({ effortOf }));
  const sync = vi.fn(async (_sessionID: string): Promise<void> => undefined);
  const modelList = vi.fn((_location?: unknown): readonly HostModelInfo[] | undefined => MODELS);
  const modelSync = vi.fn(async (_location?: unknown): Promise<void> => undefined);
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
    theme: init.theme ?? { textMuted: "muted" },
    client: init.rpc === false ? {} : { rpc },
    data: {
      session: {
        get: (id) => sessions()[id],
        family: (id) => Object.keys(sessions()).filter((other) => rootOf(other) === rootOf(id)),
        status: (id) => statuses()[id] ?? "idle",
        message: { list: (id) => messages()[id] ?? [], sync },
      },
      location: { model: { list: modelList, sync: modelSync } },
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
    modelList,
    modelSync,
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

/** Renders like the host: inside a Solid owner (a root standing in for the plugin boundary component). */
function mount(render: () => unknown): Mounted {
  let dispose = (): void => undefined;
  const view = createRoot((disposeRoot) => {
    dispose = disposeRoot;
    return render();
  });
  teardown.push(() => dispose());
  return { view, rows: () => rowsOf(view), dispose: () => dispose() };
}

function footerInput(sessionID: () => string | undefined): PromptFooterInput {
  return {
    get sessionID() {
      return sessionID();
    },
    mode: "normal",
    showDetails: false,
  };
}

function composerInput(sessionID: () => string): ComposerTopInput {
  return {
    get sessionID() {
      return sessionID();
    },
  };
}

function mountFooter(claims: readonly HostSlotClaim[], sessionID: () => string | undefined): Mounted {
  const claim = claimFor(claims, FOOTER_SLOT);
  return mount(() => claim.render(footerInput(sessionID)));
}

function mountComposer(claims: readonly HostSlotClaim[], sessionID: () => string): Mounted {
  const claim = claimFor(claims, COMPOSER_SLOT);
  return mount(() => claim.render(composerInput(sessionID)));
}

const tick = (ms = 0): Promise<unknown> => vi.advanceTimersByTimeAsync(ms);

async function microtasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function warnings(): string[] {
  return vi.mocked(console.warn).mock.calls.map((call) => String(call[0]));
}

function pullsOf(fake: Fake, sessionID: string): number {
  return fake.effortOf.mock.calls.filter(([input]) => input.sessionID === sessionID).length;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  for (const step of teardown.splice(0).reverse()) step();
  tree.faults.textInsert = false;
  tree.faults.boxCreate = false;
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

  it("appends to prompt.footer.status and session.composer.top by default (the composer claim serves G2)", () => {
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
    [{ footer: false, childView: false }, []],
    [{ footer: false }, [COMPOSER_SLOT]],
    [{ footer: false, childView: false, runningRow: true }, [COMPOSER_SLOT]],
    [{ childView: false }, [FOOTER_SLOT]],
    [{ childView: false, runningRow: true }, [FOOTER_SLOT, COMPOSER_SLOT]],
    [{ runningRow: true }, [FOOTER_SLOT, COMPOSER_SLOT]],
    [{ runningRow: false }, [FOOTER_SLOT, COMPOSER_SLOT]],
    [{ childView: false, runningRow: false }, [FOOTER_SLOT]],
  ])("options %j claim %j", (options, expected) => {
    const fake = fakeHost({ options });
    start(fake);
    expect(fake.claims.map((claim) => claim.append)).toEqual(expected);
  });

  it("shows one warning toast for invalid options, also on the console, and keeps the defaults", () => {
    const fake = fakeHost({ options: { footer: "yes", maxRows: 99, colour: 1 } });
    start(fake);
    const notice =
      'model-router status: invalid TUI options ("footer" must be true or false; "maxRows" must be an integer from 1 to 20; unknown keys "colour"); using defaults for those keys';
    expect(fake.toast).toHaveBeenCalledTimes(1);
    expect(fake.toast).toHaveBeenCalledWith({ message: notice, variant: "warning" });
    // The host swallows plugin console output: the toast is the visible channel, the console a second sink.
    expect(warnings()).toEqual([notice]);
    expect(fake.claims.map((claim) => claim.append)).toEqual([FOOTER_SLOT, COMPOSER_SLOT]);
  });

  it("shows no options toast for valid options", () => {
    const fake = fakeHost({ options: { maxRows: 2, footer: false } });
    start(fake);
    expect(fake.toast).not.toHaveBeenCalled();
    expect(warnings()).toEqual([]);
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

  it("registers the composer claim when the footer claim throws, and disposes it exactly once (P13-10)", () => {
    const claims: HostSlotClaim[] = [];
    const disposers: Array<ReturnType<typeof vi.fn>> = [];
    const cleanup = plugin.setup({
      ui: {
        slot: (claim) => {
          if (claim.append === FOOTER_SLOT) throw new Error("footer slot gone");
          claims.push(claim);
          const dispose = vi.fn();
          disposers.push(dispose);
          return dispose;
        },
      },
    });
    expect(claims.map((claim) => claim.append)).toEqual([COMPOSER_SLOT]);
    cleanup();
    cleanup();
    expect(disposers).toHaveLength(1);
    expect(disposers[0]).toHaveBeenCalledTimes(1);
    expect(warnings()).toEqual(["model-router status: slot prompt.footer.status failed: footer slot gone"]);
  });
});

describe("G1 main footer (A3)", () => {
  it("shows effort default in a root session without a selected variant", () => {
    const fake = fakeHost();
    start(fake);
    const footer = mountFooter(fake.claims, () => ROOT);
    expect(footer.rows()).toEqual(["effort default"]);
    expect(boxOf(footer.view).props.flexDirection).toBe("column");
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
    expect(boxOf(footer.view).children).toEqual([]);
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
    expect(fake.effortOf).toHaveBeenCalledWith({ sessionID: ROOT }, { signal: expect.any(AbortSignal) });
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

  it("forgets a session whose message sync failed, so the next view syncs it again (P13-6)", async () => {
    const fake = fakeHost({ rpc: false });
    fake.sync.mockRejectedValueOnce(rpcFailure("rpc.internal", "offline"));
    fake.addSession(childSession(CHILD));
    start(fake);
    const view = mountComposer(fake.claims, () => CHILD);
    await microtasks();
    expect(fake.sync).toHaveBeenCalledTimes(1);
    expect(view.rows()).toEqual(["explore · Claude Sonnet 4 · low"]);
    mountComposer(fake.claims, () => CHILD);
    await microtasks();
    expect(fake.sync).toHaveBeenCalledTimes(2);
    mountComposer(fake.claims, () => CHILD);
    await microtasks();
    expect(fake.sync).toHaveBeenCalledTimes(2);
    expect(warnings()).toEqual([]);
  });

  it(`remembers at most ${SYNCED_MAX} synced sessions (P13-6)`, async () => {
    const fake = fakeHost({ rpc: false });
    const ids = Array.from({ length: SYNCED_MAX + 1 }, (_, index) => `ses_${index}`);
    for (const id of ids) fake.addSession(childSession(id));
    start(fake);
    for (const id of ids) mountComposer(fake.claims, () => id);
    await microtasks();
    expect(fake.sync).toHaveBeenCalledTimes(SYNCED_MAX + 1);
    mountComposer(fake.claims, () => ids[SYNCED_MAX] ?? "");
    await microtasks();
    expect(fake.sync).toHaveBeenCalledTimes(SYNCED_MAX + 1);
    mountComposer(fake.claims, () => ids[0] ?? "");
    await microtasks();
    expect(fake.sync).toHaveBeenCalledTimes(SYNCED_MAX + 2);
    expect(fake.sync).toHaveBeenLastCalledWith("ses_0");
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
    expect(fake.effortOf).toHaveBeenCalledWith({ sessionID: CHILD }, { signal: expect.any(AbortSignal) });
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

  it("passes the session's location to the rpc call and to the model list (P13-3)", async () => {
    const location = { directory: "/work/child", workspaceID: "wrk_1" };
    const fake = fakeHost();
    fake.addSession(childSession(CHILD, { location }));
    start(fake);
    mountComposer(fake.claims, () => CHILD);
    expect(fake.modelList).toHaveBeenCalledWith(location);
    await tick(0);
    expect(fake.effortOf).toHaveBeenCalledWith({ sessionID: CHILD }, { location, signal: expect.any(AbortSignal) });
  });

  it("passes no location when the session has none (P13-3)", async () => {
    const fake = fakeHost();
    fake.addSession(childSession(CHILD));
    start(fake);
    mountComposer(fake.claims, () => CHILD);
    expect(fake.modelList.mock.calls.length).toBeGreaterThan(0);
    expect(fake.modelList.mock.calls.every((call) => call.length === 0)).toBe(true);
    await tick(0);
    expect(Object.keys(fake.effortOf.mock.calls[0]?.[1] ?? {})).toEqual(["signal"]);
    await microtasks();
    expect(fake.modelSync).not.toHaveBeenCalled();
  });

  it("falls back to the default model list while a location's list is not loaded, and syncs it once (R2-1)", async () => {
    const location = { directory: "/work/child", workspaceID: "wrk_1" };
    const fake = fakeHost();
    fake.modelList.mockImplementation((at) => (at === undefined ? MODELS : undefined));
    fake.addSession(childSession(CHILD, { location }));
    fake.addSession(childSession("ses_twin", { location: { ...location } }));
    start(fake);
    const view = mountComposer(fake.claims, () => CHILD);
    expect(view.rows()).toEqual(["explore · Claude Sonnet 4 · low"]);
    expect(fake.modelList).toHaveBeenCalledWith(location);
    expect(fake.modelList).toHaveBeenCalledWith();
    expect(fake.modelSync).not.toHaveBeenCalled();
    await microtasks();
    expect(fake.modelSync).toHaveBeenCalledTimes(1);
    expect(fake.modelSync).toHaveBeenCalledWith(location);
    // Same directory and workspace: the same location key, no second sync.
    mountComposer(fake.claims, () => "ses_twin");
    await microtasks();
    expect(fake.modelSync).toHaveBeenCalledTimes(1);
  });

  it("forgets a location whose model sync failed, so the next view syncs it again (R2-1)", async () => {
    const location = { directory: "/work/child" };
    const fake = fakeHost({ rpc: false });
    fake.modelList.mockImplementation((at) => (at === undefined ? MODELS : undefined));
    fake.modelSync.mockRejectedValueOnce(rpcFailure("rpc.internal", "offline"));
    fake.addSession(childSession(CHILD, { location }));
    start(fake);
    mountComposer(fake.claims, () => CHILD);
    await microtasks();
    expect(fake.modelSync).toHaveBeenCalledTimes(1);
    mountComposer(fake.claims, () => CHILD);
    await microtasks();
    expect(fake.modelSync).toHaveBeenCalledTimes(2);
    mountComposer(fake.claims, () => CHILD);
    await microtasks();
    expect(fake.modelSync).toHaveBeenCalledTimes(2);
    expect(warnings()).toEqual([]);
  });

  it(`remembers at most ${MODEL_SYNC_MAX} synced locations (R2-1)`, async () => {
    const fake = fakeHost({ rpc: false });
    fake.modelList.mockImplementation((at) => (at === undefined ? MODELS : undefined));
    const ids = Array.from({ length: MODEL_SYNC_MAX + 1 }, (_, index) => `ses_${index}`);
    for (const id of ids) fake.addSession(childSession(id, { location: { directory: `/work/${id}` } }));
    start(fake);
    for (const id of ids) mountComposer(fake.claims, () => id);
    await microtasks();
    expect(fake.modelSync).toHaveBeenCalledTimes(MODEL_SYNC_MAX + 1);
    mountComposer(fake.claims, () => ids[MODEL_SYNC_MAX] ?? "");
    await microtasks();
    expect(fake.modelSync).toHaveBeenCalledTimes(MODEL_SYNC_MAX + 1);
    mountComposer(fake.claims, () => ids[0] ?? "");
    await microtasks();
    expect(fake.modelSync).toHaveBeenCalledTimes(MODEL_SYNC_MAX + 2);
    expect(fake.modelSync).toHaveBeenLastCalledWith({ directory: "/work/ses_0" });
  });

  it.each([
    [{ directory: "/a", workspaceID: "w" }, '["/a","w"]'],
    [{ directory: "/a", workspaceID: "w", extra: 1 }, '["/a","w"]'],
    [{ directory: "/a" }, '["/a",null]'],
    [{}, "[null,null]"],
    ["not a location", "[null,null]"],
  ])("locationKey(%j) → %s (R2-1)", (location, expected) => {
    expect(locationKey(location)).toBe(expected);
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

  it("shows nothing in a child session when childView is off, while an opted-in G3 keeps working", () => {
    const fake = fakeHost({ options: { childView: false, ...G3_ON } });
    fake.addSession(childSession(CHILD));
    fake.setStatus(CHILD, "running");
    start(fake);
    expect(mountComposer(fake.claims, () => CHILD).rows()).toEqual([]);
    expect(mountComposer(fake.claims, () => ROOT).rows()).toEqual(["explore · Claude Sonnet 4 · low"]);
  });

  it("names a delegate without an agent by its session title, else subagent, as the running row does (GA-7)", () => {
    const fake = fakeHost({ options: G3_ON });
    const bare = { parentID: ROOT, model: { ...SONNET, variant: "low" }, time: { created: 2 } };
    fake.addSession({ id: CHILD, ...bare, title: "Fix the parser" });
    fake.addSession({ id: "ses_bare", ...bare, title: " " });
    start(fake);
    expect(mountComposer(fake.claims, () => CHILD).rows()).toEqual(["Fix the parser · Claude Sonnet 4 · low"]);
    expect(mountComposer(fake.claims, () => "ses_bare").rows()).toEqual(["subagent · Claude Sonnet 4 · low"]);
    // The same sessions in G3: the same agent labels.
    fake.setStatus(CHILD, "running");
    fake.setStatus("ses_bare", "running");
    expect(mountComposer(fake.claims, () => ROOT).rows()).toEqual([
      "subagent · Claude Sonnet 4 · low",
      "Fix the parser · Claude Sonnet 4 · low",
    ]);
    // A message's agent still wins over the fallback.
    fake.addMessage(CHILD, { id: "m1", type: "assistant", agent: "review", model: { ...SONNET }, time: { created: 3 } });
    expect(mountComposer(fake.claims, () => CHILD).rows()).toEqual(["review · Claude Sonnet 4 · default"]);
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

  it("is opt-in: with the default options a root session shows no rows while delegates run; G1 and G2 still show (A12)", async () => {
    const fake = fakeHost();
    fake.addSession(childA);
    fake.addSession(childB);
    fake.setStatus("ses_a", "running");
    fake.setStatus("ses_b", "running");
    start(fake);
    expect(fake.claims.map((claim) => claim.append)).toEqual([FOOTER_SLOT, COMPOSER_SLOT]);
    const view = mountComposer(fake.claims, () => ROOT);
    expect(view.rows()).toEqual([]);
    expect(boxOf(view.view).children).toEqual([]);
    expect(mountFooter(fake.claims, () => ROOT).rows()).toEqual(["effort default"]);
    expect(mountComposer(fake.claims, () => "ses_a").rows()).toEqual(["explore · Claude Sonnet 4 · low"]);
    await tick(0);
    await microtasks();
    expect(view.rows()).toEqual([]);
    // The root's composer view pulls and syncs nothing for the delegates: only the footer (root) and ses_a's own view.
    expect(fake.effortOf.mock.calls.map(([input]) => input.sessionID).sort()).toEqual(["ses_a", ROOT]);
    expect(fake.sync.mock.calls).toEqual([["ses_a"]]);
  });

  it("shows the rows with runningRow: true and keeps G1 and G2 as by default", () => {
    const fake = fakeHost({ options: G3_ON });
    fake.addSession(childA);
    fake.setStatus("ses_a", "running");
    start(fake);
    expect(fake.claims.map((claim) => claim.append)).toEqual([FOOTER_SLOT, COMPOSER_SLOT]);
    expect(mountComposer(fake.claims, () => ROOT).rows()).toEqual(["explore · Claude Sonnet 4 · low"]);
    expect(mountFooter(fake.claims, () => ROOT).rows()).toEqual(["effort default"]);
    expect(mountComposer(fake.claims, () => "ses_a").rows()).toEqual(["explore · Claude Sonnet 4 · low"]);
  });

  it("adds a row while a child runs and removes it when the child is idle", () => {
    const fake = fakeHost({ options: G3_ON });
    fake.addSession(childB);
    fake.addSession(childA);
    start(fake);
    const view = mountComposer(fake.claims, () => ROOT);
    expect(view.rows()).toEqual([]);
    expect(boxOf(view.view).children).toEqual([]);
    fake.setStatus("ses_b", "running");
    expect(view.rows()).toEqual(["review · GPT-5 · high"]);
    fake.setStatus("ses_a", "running");
    expect(view.rows()).toEqual(["explore · Claude Sonnet 4 · low", "review · GPT-5 · high"]);
    fake.setStatus("ses_a", "idle");
    expect(view.rows()).toEqual(["review · GPT-5 · high"]);
    fake.setStatus("ses_b", "idle");
    expect(view.rows()).toEqual([]);
    expect(boxOf(view.view).children).toEqual([]);
  });

  it("detaches a removed row and builds a new node when a row comes back (P13-9)", () => {
    const fake = fakeHost({ options: G3_ON });
    fake.addSession(childA);
    fake.setStatus("ses_a", "running");
    start(fake);
    const view = mountComposer(fake.claims, () => ROOT);
    const [first] = textNodes(view.view);
    expect(first?.parent).toBe(boxOf(view.view));
    fake.setStatus("ses_a", "idle");
    expect(first?.parent).toBeUndefined();
    fake.setStatus("ses_a", "running");
    const [again] = textNodes(view.view);
    expect(again).toBeDefined();
    expect(again).not.toBe(first);
    expect(view.rows()).toEqual(["explore · Claude Sonnet 4 · low"]);
  });

  it("shows at most maxRows rows, then +k more, and pulls only the shown children", async () => {
    const fake = fakeHost({ options: { maxRows: 2, ...G3_ON } });
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
    const fake = fakeHost({ options: G3_ON });
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
    const fake = fakeHost({ options: G3_ON });
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

  it("uses the root session's location for the model list (P13-3)", () => {
    const location = { directory: "/work/root" };
    const fake = fakeHost({ options: G3_ON });
    fake.addSession({ id: ROOT, agent: "build", model: { ...OPUS }, time: { created: 1 }, location });
    fake.addSession(childA);
    fake.setStatus("ses_a", "running");
    start(fake);
    expect(mountComposer(fake.claims, () => ROOT).rows()).toEqual(["explore · Claude Sonnet 4 · low"]);
    expect(fake.modelList).toHaveBeenCalledWith(location);
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
    // An answer with an effort from the start: the plain cadence, no quick re-pulls (GA-2, tested below).
    fake.answers.set(CHILD, { effort: "max", providerID: SONNET.providerID, modelID: SONNET.id });
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

  it("keeps the 5 s debounce across a running → idle → running flip that closes the poller (P13-5)", async () => {
    const fake = fakeHost({ options: G3_ON });
    fake.addSession(childSession("ses_a"));
    fake.setStatus("ses_a", "running");
    start(fake);
    const view = mountComposer(fake.claims, () => ROOT);
    await tick(0);
    expect(fake.effortOf).toHaveBeenCalledTimes(1);
    fake.setStatus("ses_a", "idle");
    expect(view.rows()).toEqual([]);
    await microtasks();
    expect(vi.getTimerCount()).toBe(0);
    await tick(1_000);
    fake.setStatus("ses_a", "running");
    expect(view.rows()).toEqual(["explore · Claude Sonnet 4 · low"]);
    await tick(POLL_INTERVAL_MS - 1_001);
    expect(fake.effortOf).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(fake.effortOf).toHaveBeenCalledTimes(2);
  });

  it("shows the last answer at once when a running → idle → running flip within 1 s reopens the poller (GA-1)", async () => {
    const fake = fakeHost({ options: G3_ON });
    fake.addSession(childSession("ses_a"));
    fake.setStatus("ses_a", "running");
    fake.answers.set("ses_a", { effort: "medium", variant: "low", providerID: SONNET.providerID, modelID: SONNET.id });
    start(fake);
    const view = mountComposer(fake.claims, () => ROOT);
    await tick(0);
    expect(view.rows()).toEqual(["explore · Claude Sonnet 4 · medium (low)"]);
    fake.setStatus("ses_a", "idle");
    expect(view.rows()).toEqual([]);
    await microtasks();
    expect(vi.getTimerCount()).toBe(0); // the poller closed
    await tick(500);
    fake.setStatus("ses_a", "running");
    // No new pull yet (debounced to 5 s since the last one), and the row already shows the channel's answer.
    expect(view.rows()).toEqual(["explore · Claude Sonnet 4 · medium (low)"]);
    expect(fake.effortOf).toHaveBeenCalledTimes(1);
  });

  it("shows the last answer at once when a G2 view is reopened within 5 s (GA-1)", async () => {
    const fake = fakeHost();
    fake.addSession(childSession(CHILD));
    fake.answers.set(CHILD, { effort: "medium", variant: "low", providerID: SONNET.providerID, modelID: SONNET.id });
    start(fake);
    const first = mountComposer(fake.claims, () => CHILD);
    await tick(0);
    expect(first.rows()).toEqual(["explore · Claude Sonnet 4 · medium (low)"]);
    first.dispose();
    await microtasks();
    expect(vi.getTimerCount()).toBe(0);
    await tick(POLL_INTERVAL_MS - 1_000);
    const again = mountComposer(fake.claims, () => CHILD);
    expect(again.rows()).toEqual(["explore · Claude Sonnet 4 · medium (low)"]);
    expect(fake.effortOf).toHaveBeenCalledTimes(1);
    await tick(1_000);
    expect(fake.effortOf).toHaveBeenCalledTimes(2);
    expect(again.rows()).toEqual(["explore · Claude Sonnet 4 · medium (low)"]);
  });

  it("keeps no answer across a reopen after a failure: the reopened view shows the fallback (GA-1)", async () => {
    const fake = fakeHost();
    fake.addSession(childSession(CHILD));
    fake.setStatus(CHILD, "running");
    fake.answers.set(CHILD, { effort: "max", providerID: SONNET.providerID, modelID: SONNET.id });
    start(fake);
    const first = mountComposer(fake.claims, () => CHILD);
    await tick(0);
    expect(first.rows()).toEqual(["explore · Claude Sonnet 4 · max"]);
    fake.effortOf.mockRejectedValue(rpcFailure("rpc.internal", "m"));
    await tick(POLL_INTERVAL_MS);
    expect(first.rows()).toEqual(["explore · Claude Sonnet 4 · low"]);
    first.dispose();
    await microtasks();
    expect(mountComposer(fake.claims, () => CHILD).rows()).toEqual(["explore · Claude Sonnet 4 · low"]);
    expect(fake.effortOf).toHaveBeenCalledTimes(2);
  });

  it("re-pulls a running session's answer without an effort after 1 s, until one has an effort (GA-2)", async () => {
    const fake = fakeHost();
    fake.addSession(childSession(CHILD));
    fake.setStatus(CHILD, "running");
    start(fake);
    const view = mountComposer(fake.claims, () => CHILD);
    await tick(0);
    expect(fake.effortOf).toHaveBeenCalledTimes(1);
    expect(view.rows()).toEqual(["explore · Claude Sonnet 4 · low"]);
    fake.answers.set(CHILD, { effort: "max", providerID: SONNET.providerID, modelID: SONNET.id });
    await tick(BACKOFF_START_MS - 1);
    expect(fake.effortOf).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(fake.effortOf).toHaveBeenCalledTimes(2);
    expect(view.rows()).toEqual(["explore · Claude Sonnet 4 · max"]);
    // An effort was seen: a later answer without one waits for the 5 s poll.
    fake.answers.delete(CHILD);
    await tick(POLL_INTERVAL_MS - 1);
    expect(fake.effortOf).toHaveBeenCalledTimes(2);
    await tick(1);
    expect(fake.effortOf).toHaveBeenCalledTimes(3);
    await tick(BACKOFF_START_MS);
    expect(fake.effortOf).toHaveBeenCalledTimes(3);
    await tick(POLL_INTERVAL_MS - BACKOFF_START_MS);
    expect(fake.effortOf).toHaveBeenCalledTimes(4);
  });

  it(`stops the quick re-pulls of a running session that never reports an effort after ${QUICK_REPULLS} (GA-2)`, async () => {
    const fake = fakeHost();
    fake.addSession(childSession(CHILD));
    fake.setStatus(CHILD, "running");
    start(fake);
    const view = mountComposer(fake.claims, () => CHILD);
    await tick(0);
    expect(fake.effortOf).toHaveBeenCalledTimes(1);
    for (let quick = 1; quick <= QUICK_REPULLS; quick++) {
      await tick(BACKOFF_START_MS - 1);
      expect(fake.effortOf).toHaveBeenCalledTimes(quick);
      await tick(1);
      expect(fake.effortOf).toHaveBeenCalledTimes(quick + 1);
    }
    // Then the 5 s poll only.
    await tick(POLL_INTERVAL_MS - 1);
    expect(fake.effortOf).toHaveBeenCalledTimes(QUICK_REPULLS + 1);
    await tick(1);
    expect(fake.effortOf).toHaveBeenCalledTimes(QUICK_REPULLS + 2);
    await tick(BACKOFF_START_MS);
    expect(fake.effortOf).toHaveBeenCalledTimes(QUICK_REPULLS + 2);
    // The count is kept with the pull state: a reopened view starts no new quick re-pulls.
    view.dispose();
    await microtasks();
    mountComposer(fake.claims, () => CHILD);
    await tick(POLL_INTERVAL_MS - BACKOFF_START_MS - 1);
    expect(fake.effortOf).toHaveBeenCalledTimes(QUICK_REPULLS + 2);
    await tick(1);
    expect(fake.effortOf).toHaveBeenCalledTimes(QUICK_REPULLS + 3);
    await tick(BACKOFF_START_MS);
    expect(fake.effortOf).toHaveBeenCalledTimes(QUICK_REPULLS + 3);
    expect(warnings()).toEqual([]);
  });

  it(`keeps the pull state of the last ${PULL_STATE_MAX} sessions only (P13-5)`, async () => {
    const fake = fakeHost();
    const ids = Array.from({ length: PULL_STATE_MAX + 1 }, (_, index) => `ses_${index}`);
    for (const id of ids) fake.addSession(childSession(id));
    start(fake);
    const views = ids.map((id) => mountComposer(fake.claims, () => id));
    await tick(0);
    expect(fake.effortOf).toHaveBeenCalledTimes(PULL_STATE_MAX + 1);
    for (const view of views) view.dispose();
    await microtasks();
    await tick(1_000);
    // ses_1 first: opening the forgotten ses_0 adds a state and evicts the then-oldest one.
    mountComposer(fake.claims, () => "ses_1");
    mountComposer(fake.claims, () => "ses_0");
    await tick(0);
    expect(pullsOf(fake, "ses_0")).toBe(2);
    expect(pullsOf(fake, "ses_1")).toBe(1);
    await tick(POLL_INTERVAL_MS - 1_000);
    expect(pullsOf(fake, "ses_1")).toBe(2);
  });

  it("retries rpc.unavailable with backoff 1 s, 2 s, 4 s … 30 s, without warning (P13-1)", async () => {
    const fake = fakeHost();
    fake.addSession(childSession(CHILD));
    fake.effortOf.mockRejectedValue(rpcFailure("rpc.unavailable", "x"));
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

  it("falls back to the message variant for 30 s after another rpc failure, warning its message once (P13-1)", async () => {
    const fake = fakeHost();
    fake.addSession(childSession(CHILD));
    fake.setStatus(CHILD, "running");
    fake.answers.set(CHILD, { effort: "max", providerID: SONNET.providerID, modelID: SONNET.id });
    start(fake);
    const view = mountComposer(fake.claims, () => CHILD);
    await tick(0);
    expect(view.rows()).toEqual(["explore · Claude Sonnet 4 · max"]);
    fake.effortOf.mockRejectedValue(rpcFailure("rpc.internal", "m"));
    await tick(POLL_INTERVAL_MS);
    expect(fake.effortOf).toHaveBeenCalledTimes(2);
    expect(view.rows()).toEqual(["explore · Claude Sonnet 4 · low"]);
    await tick(FAILURE_COOLDOWN_MS - 1);
    expect(fake.effortOf).toHaveBeenCalledTimes(2);
    await tick(1);
    expect(fake.effortOf).toHaveBeenCalledTimes(3);
    expect(warnings()).toEqual(["model-router status: effort channel failed: m"]);
    fake.effortOf.mockResolvedValue({ effort: "max", providerID: SONNET.providerID, modelID: SONNET.id });
    await tick(FAILURE_COOLDOWN_MS);
    expect(fake.effortOf).toHaveBeenCalledTimes(4);
    expect(view.rows()).toEqual(["explore · Claude Sonnet 4 · max"]);
  });

  it("names an rpc failure without a message by its type (P13-1)", async () => {
    const fake = fakeHost();
    fake.addSession(childSession(CHILD));
    fake.effortOf.mockRejectedValue({ type: "rpc.method_not_found", message: "" });
    start(fake);
    mountComposer(fake.claims, () => CHILD);
    await tick(0);
    expect(warnings()).toEqual(["model-router status: effort channel failed: rpc.method_not_found"]);
  });

  it("aborts a call after 10 s and retries it like rpc.unavailable (P13-4)", async () => {
    const fake = fakeHost();
    fake.addSession(childSession(CHILD));
    const signals: AbortSignal[] = [];
    fake.effortOf.mockImplementation((_input, options) => {
      if (options?.signal !== undefined) signals.push(options.signal);
      return new Promise<unknown>(() => undefined);
    });
    start(fake);
    mountComposer(fake.claims, () => CHILD);
    await tick(0);
    expect(fake.effortOf).toHaveBeenCalledTimes(1);
    await tick(CALL_TIMEOUT_MS - 1);
    expect(signals[0]?.aborted).toBe(false);
    await tick(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(fake.effortOf).toHaveBeenCalledTimes(1);
    await tick(BACKOFF_START_MS);
    expect(fake.effortOf).toHaveBeenCalledTimes(2);
    expect(warnings()).toEqual([]);
  });

  it("aborts the call in flight when its poller closes (P13-4)", async () => {
    const fake = fakeHost();
    fake.addSession(childSession(CHILD));
    const signals: AbortSignal[] = [];
    fake.effortOf.mockImplementation((_input, options) => {
      if (options?.signal !== undefined) signals.push(options.signal);
      return new Promise<unknown>(() => undefined);
    });
    start(fake);
    const view = mountComposer(fake.claims, () => CHILD);
    await tick(0);
    expect(vi.getTimerCount()).toBe(1);
    view.dispose();
    await microtasks();
    expect(signals[0]?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await tick(60_000);
    expect(fake.effortOf).toHaveBeenCalledTimes(1);
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
      'model-router status: invalid TUI options (unknown keys "bogus"); using defaults for those keys',
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

  it("colours every row with the theme's muted text colour and never wraps it (P13-7)", () => {
    const fake = fakeHost({ options: G3_ON });
    fake.addSession(childSession("ses_a"));
    fake.addSession(childSession("ses_b"));
    fake.setStatus("ses_a", "running");
    fake.setStatus("ses_b", "running");
    start(fake);
    const view = mountComposer(fake.claims, () => ROOT);
    expect(textNodes(view.view).map((node) => node.props.fg)).toEqual(["muted", "muted"]);
    expect(textNodes(view.view).map((node) => node.props.wrapMode)).toEqual(["none", "none"]);
    const footer = mountFooter(fake.claims, () => ROOT);
    expect(textNodes(footer.view).map((node) => node.props.wrapMode)).toEqual(["none"]);
  });

  it("renders statically and warns once when a slot renders outside any Solid owner (P13-2)", async () => {
    const fake = fakeHost();
    fake.addSession(childSession(CHILD));
    start(fake);
    const footer = claimFor(fake.claims, FOOTER_SLOT).render(footerInput(() => ROOT));
    expect(rowsOf(footer)).toEqual(["effort default"]);
    expect(textNodes(footer).map((node) => [node.props.wrapMode, node.props.fg])).toEqual([["none", "muted"]]);
    const child = claimFor(fake.claims, COMPOSER_SLOT).render(composerInput(() => CHILD));
    expect(rowsOf(child)).toEqual(["explore · Claude Sonnet 4 · low"]);
    // Shown once as a toast (the host swallows console output), across both renders; the console is a second sink.
    expect(fake.toast).toHaveBeenCalledTimes(1);
    expect(fake.toast).toHaveBeenCalledWith({ message: OWNER_WARNING, variant: "warning" });
    expect(warnings()).toEqual([OWNER_WARNING]);
    expect(NO_OWNER_NOTICE).toBe(OWNER_WARNING.replace("model-router status: ", ""));
    fake.setCurrent({ providerID: OPUS.providerID, modelID: OPUS.id, variant: "high" });
    expect(rowsOf(footer)).toEqual(["effort default"]);
    await tick(60_000);
    expect(fake.effortOf).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("renders G1 and G2 but no G3 rows without a Solid owner, even with runningRow on (R2-2)", () => {
    const fake = fakeHost({ options: G3_ON });
    fake.addSession(childSession(CHILD));
    fake.setStatus(CHILD, "running");
    start(fake);
    const composer = claimFor(fake.claims, COMPOSER_SLOT);
    const root = composer.render(composerInput(() => ROOT));
    expect(boxOf(root).children).toEqual([]);
    expect(rowsOf(composer.render(composerInput(() => CHILD)))).toEqual(["explore · Claude Sonnet 4 · low"]);
    expect(rowsOf(claimFor(fake.claims, FOOTER_SLOT).render(footerInput(() => ROOT)))).toEqual(["effort default"]);
    expect(warnings()).toEqual([OWNER_WARNING]);
    expect(fake.toast).toHaveBeenCalledTimes(1);
    // With an owner, the same root shows the running delegate.
    expect(mountComposer(fake.claims, () => ROOT).rows()).toEqual(["explore · Claude Sonnet 4 · low"]);
  });

  it("shows the options and owner notices as one toast each, in that order", () => {
    const fake = fakeHost({ options: { bogus: 1 } });
    start(fake);
    claimFor(fake.claims, FOOTER_SLOT).render(footerInput(() => ROOT));
    claimFor(fake.claims, FOOTER_SLOT).render(footerInput(() => ROOT));
    expect(fake.toast.mock.calls).toEqual([
      [{ message: 'model-router status: invalid TUI options (unknown keys "bogus"); using defaults for those keys', variant: "warning" }],
      [{ message: OWNER_WARNING, variant: "warning" }],
    ]);
  });

  it("writes the owner notice to the console when the host has no toast", () => {
    const claims: HostSlotClaim[] = [];
    teardown.push(
      plugin.setup({
        ui: {
          slot: (claim) => {
            claims.push(claim);
            return undefined;
          },
        },
      }),
    );
    expect(() => claimFor(claims, FOOTER_SLOT).render(footerInput(() => ROOT))).not.toThrow();
    expect(warnings()).toEqual([OWNER_WARNING]);
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

  it("renders an empty box and warns once when data.session.get throws without a Solid owner (C-3)", () => {
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
    const composer = claimFor(fake.claims, COMPOSER_SLOT);
    let child: unknown;
    let root: unknown;
    expect(() => {
      child = composer.render(composerInput(() => CHILD));
      root = composer.render(composerInput(() => ROOT));
    }).not.toThrow();
    expect(boxOf(child).children).toEqual([]);
    expect(boxOf(root).children).toEqual([]);
    // The owner notice, then one failure warning for the area across both renders.
    expect(warnings()).toEqual([OWNER_WARNING, "model-router status: composer view failed: store gone"]);
    expect(fake.toast).toHaveBeenCalledTimes(1);
  });

  it("returns undefined and warns once when the box cannot be created, with or without a Solid owner (C-3)", () => {
    const fake = fakeHost();
    fake.addSession(childSession(CHILD));
    start(fake);
    tree.faults.boxCreate = true;
    const composer = claimFor(fake.claims, COMPOSER_SLOT);
    let owned: unknown = null;
    let again: unknown = null;
    expect(() => {
      owned = mount(() => composer.render(composerInput(() => CHILD))).view;
      again = mount(() => composer.render(composerInput(() => CHILD))).view;
    }).not.toThrow();
    expect(owned).toBeUndefined();
    expect(again).toBeUndefined();
    expect(warnings()).toEqual(["model-router status: composer view failed: box create failed"]);
    // Without an owner: the static view fails the same way, reported once for its own area.
    let unowned: unknown = null;
    expect(() => {
      unowned = claimFor(fake.claims, FOOTER_SLOT).render(footerInput(() => ROOT));
    }).not.toThrow();
    expect(unowned).toBeUndefined();
    expect(warnings()).toEqual([
      "model-router status: composer view failed: box create failed",
      OWNER_WARNING,
      "model-router status: footer view failed: box create failed",
    ]);
    tree.faults.boxCreate = false;
    expect(mountComposer(fake.claims, () => CHILD).rows()).toEqual(["explore · Claude Sonnet 4 · low"]);
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

  it("disposes a row's root when building the row fails (P13-14)", () => {
    const [muted, setMuted] = createSignal("muted");
    let reads = 0;
    const fake = fakeHost({
      theme: {
        get textMuted(): unknown {
          reads++;
          return muted();
        },
      },
    });
    fake.addSession(childSession(CHILD));
    start(fake);
    tree.faults.textInsert = true;
    const view = mountComposer(fake.claims, () => CHILD);
    tree.faults.textInsert = false;
    expect(view.rows()).toEqual([]);
    expect(warnings()).toEqual(["model-router status: composer view failed: text insert failed"]);
    expect(reads).toBeGreaterThan(0);
    const before = reads;
    setMuted("other");
    expect(reads).toBe(before);
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
    const fake = fakeHost({ options: G3_ON });
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

  it("aborts the call in flight and drops its answer on cleanup", async () => {
    const fake = running();
    let answer: (value: unknown) => void = () => undefined;
    const signals: AbortSignal[] = [];
    fake.effortOf.mockImplementation(
      (_input, options) =>
        new Promise<unknown>((resolve) => {
          if (options?.signal !== undefined) signals.push(options.signal);
          answer = resolve;
        }),
    );
    const cleanup = start(fake);
    const view = mountComposer(fake.claims, () => CHILD);
    await tick(0);
    cleanup();
    expect(signals[0]?.aborted).toBe(true);
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
    ["{ type: rpc.unavailable }", rpcFailure("rpc.unavailable", "x"), true],
    ["{ type: rpc.unavailable, data }", { type: "rpc.unavailable", message: "x", data: { id: "opencode-model-router.effort" } }, true],
    ["{ type: rpc.internal }", rpcFailure("rpc.internal", "m"), false],
    ["{ type: rpc.method_not_found }", rpcFailure("rpc.method_not_found", "no such method"), false],
    // R2-3: a string `type` decides alone; the text heuristics apply only without one.
    ["{ type: rpc.internal, message mentions unavailable }", rpcFailure("rpc.internal", "upstream unavailable"), false],
    ["{ type: service.unavailable }", rpcFailure("service.unavailable", "down"), false],
    ["{ type: 42, message mentions unavailable }", { type: 42, message: "rpc unavailable" }, true],
    ["Error(rpc.unavailable)", new Error("rpc.unavailable"), true],
    ["Error named RpcUnavailableError", Object.assign(new Error("not registered"), { name: "RpcUnavailableError" }), true],
    ["{ _tag: Unavailable }", { _tag: "Unavailable" }, true],
    ["{ code: RPC_UNAVAILABLE }", { code: "RPC_UNAVAILABLE" }, true],
    ["the string unavailable", "unavailable", true],
    ["Error(boom)", new Error("boom"), false],
    ["null", null, false],
    ["42", 42, false],
  ])("isUnavailable(%s) → %s", (_label, error, expected) => {
    expect(isUnavailable(error)).toBe(expected);
  });
});
