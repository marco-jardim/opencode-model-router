import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthorityAction } from "../../src/router/roles";
import * as binding from "../../src/routing/roles/binding";
import {
  BINDING_NOTES,
  BOUND_MAX,
  LOCAL_ACTIONS,
  PENDING_MAX,
  PENDING_TTL_MS,
  bind,
  bindingRegistrySize,
  currentBinding,
  evict,
  noncePromptLine,
  nonceTitleSuffix,
  registerPending,
  resetBindingRegistryForTests,
  widen,
  type Binding,
  type PendingDispatch,
  type SessionLookup,
} from "../../src/routing/roles/binding";
import type { DispatchGrant } from "../../src/routing/roles/policy";

const PARENT = "ses_parent";
const ROOT = "D:\\git\\omr-rta-p16";
const OTHER_ROOT = "D:\\git\\omr-rta-p15";
const LOCAL: AuthorityAction[] = ["read", "glob", "grep", "router_git"];

let clock = 1_000_000_000;

beforeEach(() => {
  resetBindingRegistryForTests();
  clock = 1_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function grant(actions: readonly AuthorityAction[], workRoot: string | null = ROOT, notes: string[] = []): DispatchGrant {
  return { actions: new Set(actions), notes, workRoot };
}

function pending(callID: string, over: Partial<PendingDispatch> = {}): PendingDispatch {
  return {
    parentSessionID: PARENT,
    callID,
    agent: "implementer",
    description: "task",
    nonce: callID,
    grant: grant([...LOCAL, "edit"]),
    budget: 80,
    decisionID: `dec_${callID}`,
    registeredAt: clock,
    ...over,
  };
}

type Session = Awaited<ReturnType<SessionLookup>>;

function lookup(over: Partial<NonNullable<Session>> = {}) {
  return vi.fn<SessionLookup>(async () => ({
    parentID: PARENT,
    agent: "implementer",
    title: "task",
    firstText: "You are a subagent spawned by another session.",
    ...over,
  }));
}

function actions(b: { grant: DispatchGrant } | DispatchGrant): AuthorityAction[] {
  return [...("grant" in b ? b.grant.actions : b.actions)];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("bind: exact, intersection, unknown", () => {
  it("binds the only pending dispatch exactly, with its grant, budget and decision", async () => {
    registerPending(pending("call_A", { grant: grant([...LOCAL, "edit", "router_run"], ROOT, ["note A"]) }));
    const b = await bind("ses_child", lookup());
    expect(b).toEqual({
      childSessionID: "ses_child",
      kind: "exact",
      grant: { actions: new Set([...LOCAL, "router_run", "edit"]), notes: ["note A"], workRoot: ROOT },
      candidates: ["call_A"],
      decisionID: "dec_call_A",
      budget: 80,
    } satisfies Binding);
  });

  it("two identical parallel dispatches → intersection: actions ∩, notes merged, shared root kept, smallest budget", async () => {
    registerPending(pending("call_A", { grant: grant([...LOCAL, "edit", "router_run"], ROOT, ["a", "shared"]), budget: 80 }));
    registerPending(pending("call_B", { grant: grant(["read", "grep", "edit", "router_run"], ROOT, ["b", "shared"]), budget: 40 }));
    const first = await bind("ses_child1", lookup());
    const second = await bind("ses_child2", lookup());
    for (const b of [first, second]) {
      expect(b.kind).toBe("intersection");
      expect(actions(b)).toEqual(["read", "grep", "router_run", "edit"]);
      expect(b.grant.workRoot).toBe(ROOT);
      expect(b.grant.notes).toEqual([BINDING_NOTES.intersection(2), "a", "shared", "b"]);
      expect(b.candidates).toEqual(["call_A", "call_B"]);
      expect(b.budget).toBe(40);
      expect(b.decisionID).toBeNull();
    }
  });

  it("keeps a decision id every candidate shares; a non-finite budget is ignored, none left → null", async () => {
    registerPending(pending("call_A", { decisionID: "dec", budget: Number.NaN }));
    registerPending(pending("call_B", { decisionID: "dec", budget: 30 }));
    const b = await bind("ses_child", lookup());
    expect(b.decisionID).toBe("dec");
    expect(b.budget).toBe(30);
    resetBindingRegistryForTests();
    registerPending(pending("call_C", { budget: Number.POSITIVE_INFINITY }));
    registerPending(pending("call_D", { budget: Number.NaN }));
    expect((await bind("ses_other", lookup())).budget).toBeNull();
    resetBindingRegistryForTests();
    registerPending(pending("call_E", { budget: Number.NaN }));
    expect((await bind("ses_third", lookup())).budget).toBeNull();
  });

  it("candidates with different work roots → workRoot null, and router_run goes with it (I9)", async () => {
    registerPending(pending("call_A", { grant: grant([...LOCAL, "edit", "router_run"], ROOT) }));
    registerPending(pending("call_B", { grant: grant([...LOCAL, "edit", "router_run"], OTHER_ROOT) }));
    const b = await bind("ses_child", lookup());
    expect(b.kind).toBe("intersection");
    expect(b.grant.workRoot).toBeNull();
    expect(actions(b)).toEqual([...LOCAL, "edit"]);
    expect(b.grant.notes).toContain(BINDING_NOTES.noWorkRoot);
  });

  it("the nonce in the title or the first message binds exactly (P-2)", async () => {
    registerPending(pending("call_A", { grant: grant([...LOCAL]) }));
    registerPending(pending("call_B", { grant: grant([...LOCAL, "edit"]) }));
    const byTitle = await bind("ses_b", lookup({ title: `task${nonceTitleSuffix("call_B")}` }));
    expect(byTitle.kind).toBe("exact");
    expect(byTitle.candidates).toEqual(["call_B"]);
    expect(actions(byTitle)).toEqual([...LOCAL, "edit"]);
    const byPrompt = await bind("ses_a", lookup({ firstText: `You are a subagent.\n${noncePromptLine("call_A")}` }));
    expect(byPrompt.kind).toBe("exact");
    expect(byPrompt.candidates).toEqual(["call_A"]);
    expect(nonceTitleSuffix("x")).toBe(" [nonce x]");
    expect(noncePromptLine("x")).toBe("OMR_NONCE=x");
  });

  it("matches a nonce as a whole token only", async () => {
    registerPending(pending("c1", { grant: grant(["read"]) }));
    registerPending(pending("c12", { grant: grant(["read", "edit"]) }));
    const b = await bind("ses_child", lookup({ title: "resume c12." }));
    expect(b.kind).toBe("exact");
    expect(b.candidates).toEqual(["c12"]);
    const neither = await bind("ses_child2", lookup({ title: "c1x and xc12" }));
    expect(neither.kind).toBe("intersection");
    expect(actions(neither)).toEqual(["read"]);
  });

  it("an empty nonce never matches", async () => {
    registerPending(pending("call_A", { nonce: "" }));
    registerPending(pending("call_B", { nonce: "  " }));
    const b = await bind("ses_child", lookup({ title: "task   " }));
    expect(b.kind).toBe("intersection");
    evict("call_A");
    evict("call_B");
    expect(bindingRegistrySize()).toMatchObject({ pending: 0, retired: 0 }); // nothing to remember
  });

  it("two candidates' nonces both named → intersection over all candidates", async () => {
    registerPending(pending("call_A", { grant: grant([...LOCAL, "edit"]) }));
    registerPending(pending("call_B", { grant: grant(["read"]) }));
    registerPending(pending("call_C", { grant: grant(["read", "glob"]) }));
    const b = await bind("ses_child", lookup({ title: "call_A", firstText: "call_B" }));
    expect(b.kind).toBe("intersection");
    expect(b.candidates).toEqual(["call_A", "call_B", "call_C"]);
    expect(actions(b)).toEqual(["read"]);
  });

  it("agent or parent mismatch → unknown; a session without a parent → unknown", async () => {
    registerPending(pending("call_A"));
    expect((await bind("ses_1", lookup({ agent: "general" }))).kind).toBe("unknown");
    expect((await bind("ses_2", lookup({ parentID: "ses_other" }))).kind).toBe("unknown");
    const root = await bind("ses_3", lookup({ parentID: undefined }));
    expect(root.kind).toBe("unknown");
    expect(root.grant.notes).toEqual([BINDING_NOTES.unknown, BINDING_NOTES.noCandidate]);
    expect((await bind("ses_4", lookup({ agent: "" }))).kind).toBe("unknown");
    expect(currentBinding("ses_3")?.kind).toBe("unknown");
  });

  it("unknown → local only, no work root, no candidates, a note naming router_request_authority", async () => {
    const b = await bind("ses_child", lookup());
    expect(b).toEqual({
      childSessionID: "ses_child",
      kind: "unknown",
      grant: { actions: new Set(LOCAL), notes: [BINDING_NOTES.unknown, BINDING_NOTES.noCandidate], workRoot: null },
      candidates: [],
      decisionID: null,
      budget: null,
    });
    expect(BINDING_NOTES.unknown).toContain("router_request_authority");
  });

  it("unknown takes fallback ∩ local: iterable, per-agent function, throw or undefined → nothing", async () => {
    const one = await bind("ses_1", lookup(), { localFallback: ["read", "edit", "webfetch"] });
    expect(actions(one)).toEqual(["read"]);
    const seen: Array<string | undefined> = [];
    const two = await bind("ses_2", lookup({ agent: "researcher" }), {
      localFallback: (agent) => {
        seen.push(agent);
        return agent === "researcher" ? ["webfetch", "websearch"] : LOCAL;
      },
    });
    expect(seen).toEqual(["researcher"]);
    expect(actions(two)).toEqual([]);
    const three = await bind("ses_3", lookup(), { localFallback: () => { throw new Error("boom"); } });
    expect(actions(three)).toEqual([]);
    const four = await bind("ses_4", lookup(), { localFallback: () => undefined });
    expect(actions(four)).toEqual([]);
    expect(LOCAL_ACTIONS).toEqual(LOCAL);
  });

  it("a failed lookup → unknown, not cached: the next hook retries", async () => {
    registerPending(pending("call_A"));
    const throwing = vi.fn<SessionLookup>(async () => { throw new Error("host down"); });
    const failed = await bind("ses_child", throwing);
    expect(failed.kind).toBe("unknown");
    expect(failed.grant.notes).toEqual([BINDING_NOTES.unknown, BINDING_NOTES.lookupFailed]);
    expect(currentBinding("ses_child")).toBeUndefined();
    const missing = await bind("ses_child", vi.fn<SessionLookup>(async () => undefined), { localFallback: (agent) => (agent === undefined ? ["read"] : LOCAL) });
    expect(actions(missing)).toEqual(["read"]);
    const syncThrow = (() => { throw new Error("sync"); }) as unknown as SessionLookup;
    expect((await bind("ses_child", syncThrow)).kind).toBe("unknown");
    const ok = await bind("ses_child", lookup());
    expect(ok.kind).toBe("exact");
  });

  it("normalises a malformed grant: never router_run without a root, never egress with local", async () => {
    registerPending(pending("call_A", { grant: grant(["read", "webfetch", "router_run", "bogus" as AuthorityAction], null) }));
    const b = await bind("ses_child", lookup());
    expect(actions(b)).toEqual(["read"]);
    expect(b.grant.notes).toEqual([BINDING_NOTES.separation, BINDING_NOTES.noWorkRoot]);
  });
});

describe("lifetimes and eviction", () => {
  it("binding after the parent call completed → unknown, even with a newer sibling pending", async () => {
    registerPending(pending("call_A", { grant: grant([...LOCAL, "edit"]) }));
    evict("call_A"); // execute.after of the parent's subagent call
    const none = await bind("ses_none", lookup());
    expect(none.kind).toBe("unknown");
    expect(actions(none)).toEqual(LOCAL);
    registerPending(pending("call_B", { grant: grant([...LOCAL, "edit", "router_run"]) }));
    for (const [id, over] of [
      ["ses_title", { title: `task${nonceTitleSuffix("call_A")}` }],
      ["ses_prompt", { firstText: noncePromptLine("call_A") }],
      ["ses_bare", { firstText: "continue call_A please" }],
      ["ses_unregistered", { title: `task${nonceTitleSuffix("call_never")}` }],
    ] as const) {
      const b = await bind(id, lookup(over));
      expect(b.kind, id).toBe("unknown");
      expect(b.grant.notes, id).toEqual([BINDING_NOTES.unknown, BINDING_NOTES.foreignNonce]);
      expect(b.grant.workRoot, id).toBeNull();
    }
    // A nonce-less child cannot be told apart: the count rule applies.
    expect((await bind("ses_plain", lookup())).candidates).toEqual(["call_B"]);
  });

  it("a nonce of another parent's pending dispatch → unknown", async () => {
    registerPending(pending("call_A"));
    registerPending(pending("call_X", { parentSessionID: "ses_other_parent" }));
    expect((await bind("ses_1", lookup({ firstText: "OMR_NONCE=call_X" }))).kind).toBe("unknown");
    expect((await bind("ses_2", lookup({ firstText: "see call_X" }))).kind).toBe("unknown");
  });

  it("parent deleted: its pending entries and its children's bindings go; others stay", async () => {
    registerPending(pending("call_A"));
    registerPending(pending("call_O", { parentSessionID: "ses_other" }));
    const before = await bind("ses_child", lookup({ title: "task [nonce call_A]" }));
    expect(before.kind).toBe("exact");
    const other = await bind("ses_other_child", lookup({ parentID: "ses_other" }));
    expect(other.kind).toBe("exact");
    evict(PARENT); // session.deleted of the parent
    expect(currentBinding("ses_child")).toBeUndefined();
    expect(currentBinding("ses_other_child")?.kind).toBe("exact");
    expect(bindingRegistrySize().pending).toBe(1);
    expect((await bind("ses_child", lookup({ title: "task [nonce call_A]" }))).kind).toBe("unknown");
    expect((await bind("ses_new", lookup())).kind).toBe("unknown");
  });

  it("the same child resumed twice gets the cached binding with its widened grant, one lookup", async () => {
    registerPending(pending("call_A", { grant: grant(LOCAL) }));
    const get = lookup();
    const first = await bind("ses_child", get);
    expect(first.kind).toBe("exact");
    evict("call_A"); // the first run completed
    expect(actions(widen("ses_child", ["edit"]))).toEqual([...LOCAL, "edit"]);
    registerPending(pending("call_B", { grant: grant(["read"]) })); // an unrelated later dispatch
    for (let resume = 0; resume < 2; resume++) {
      const again = await bind("ses_child", get);
      expect(again.kind).toBe("exact");
      expect(again.candidates).toEqual(["call_A"]);
      expect(actions(again)).toEqual([...LOCAL, "edit"]);
      expect(again.grant.notes).toEqual([BINDING_NOTES.widened(["edit"])]);
    }
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("evict(child) on session.deleted drops the binding; the next bind decides again", async () => {
    registerPending(pending("call_A"));
    await bind("ses_child", lookup());
    evict("ses_child");
    expect(currentBinding("ses_child")).toBeUndefined();
    const get = lookup();
    await bind("ses_child", get);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("an evict while the lookup runs returns the decision without caching it", async () => {
    registerPending(pending("call_A"));
    const gate = deferred<Session>();
    const pendingBind = bind("ses_child", () => gate.promise);
    evict("ses_child");
    gate.resolve({ parentID: PARENT, agent: "implementer", title: "task" });
    expect((await pendingBind).kind).toBe("exact");
    expect(currentBinding("ses_child")).toBeUndefined();
  });

  it("expires pending entries after 30 min (checked on access) and remembers their nonces for 30 min more", async () => {
    registerPending(pending("call_A"));
    clock += PENDING_TTL_MS - 1;
    expect((await bind("ses_1", lookup())).kind).toBe("exact");
    clock += 1;
    expect((await bind("ses_2", lookup())).kind).toBe("unknown");
    expect(bindingRegistrySize()).toMatchObject({ pending: 0, retired: 1 });
    registerPending(pending("call_B"));
    expect((await bind("ses_3", lookup({ firstText: "call_A" }))).kind).toBe("unknown");
    clock += PENDING_TTL_MS;
    registerPending(pending("call_C"));
    expect(bindingRegistrySize()).toMatchObject({ pending: 1, retired: 1 }); // call_A forgotten, call_B retired
  });

  it("a future registeredAt cannot extend the TTL; a non-finite one means now; an expired one is refused", async () => {
    registerPending(pending("call_F", { registeredAt: clock + 10 * PENDING_TTL_MS }));
    registerPending(pending("call_N", { registeredAt: Number.NaN, agent: "general" }));
    clock += PENDING_TTL_MS;
    expect(bindingRegistrySize().pending).toBe(2);
    expect((await bind("ses_1", lookup())).kind).toBe("unknown");
    expect((await bind("ses_2", lookup({ agent: "general" }))).kind).toBe("unknown");
    registerPending(pending("call_old", { registeredAt: clock - PENDING_TTL_MS }));
    expect(bindingRegistrySize().pending).toBe(0);
    registerPending(pending("call_new"));
    expect((await bind("ses_3", lookup({ firstText: "call_old" }))).kind).toBe("unknown");
  });

  it("bounds the pending registry: the oldest entry goes first and its nonce is remembered", async () => {
    for (let i = 0; i <= PENDING_MAX; i++) registerPending(pending(`call_${i}`, { parentSessionID: `ses_p${i}` }));
    expect(bindingRegistrySize().pending).toBe(PENDING_MAX);
    expect((await bind("ses_0", lookup({ parentID: "ses_p0" }))).kind).toBe("unknown");
    expect((await bind("ses_1", lookup({ parentID: "ses_p1" }))).kind).toBe("exact");
    // Re-registering a dispatch moves it to the newest position and un-retires its nonce.
    registerPending(pending("call_0", { parentSessionID: "ses_p0" }));
    expect(bindingRegistrySize().pending).toBe(PENDING_MAX);
    expect((await bind("ses_0b", lookup({ parentID: "ses_p0", firstText: "OMR_NONCE=call_0" }))).kind).toBe("exact");
  });

  it("bounds the retired nonces", () => {
    for (let i = 0; i < 1100; i++) {
      registerPending(pending(`call_${i}`));
      evict(`call_${i}`);
    }
    expect(bindingRegistrySize()).toMatchObject({ pending: 0, retired: 1024 });
  });

  it("bounds the bound children, least recently used first", async () => {
    registerPending(pending("call_A"));
    const get = lookup();
    for (let i = 0; i < BOUND_MAX; i++) await bind(`ses_${i}`, get);
    await bind("ses_0", get); // touch: now the most recent
    await bind("ses_extra", get);
    expect(bindingRegistrySize().bound).toBe(BOUND_MAX);
    expect(currentBinding("ses_0")).toBeDefined();
    expect(currentBinding("ses_1")).toBeUndefined();
  });

  it("ignores invalid entries and copies the grant (a later mutation cannot widen)", async () => {
    registerPending(pending("", {}));
    registerPending(pending("call_X", { parentSessionID: "" }));
    registerPending(pending("call_Y", { agent: "" }));
    registerPending({ ...pending("call_Z"), grant: { actions: ["read"] as unknown as Set<AuthorityAction>, notes: [], workRoot: null } });
    registerPending(null as unknown as PendingDispatch);
    registerPending({ ...pending("call_W"), nonce: 5 as unknown as string });
    registerPending({ ...pending("call_V"), grant: null as unknown as DispatchGrant });
    expect(bindingRegistrySize().pending).toBe(0);
    const set = new Set<AuthorityAction>(["read"]);
    registerPending(pending("call_A", { grant: { actions: set, notes: [], workRoot: ROOT } }));
    set.add("edit");
    expect(actions(await bind("ses_child", lookup()))).toEqual(["read"]);
  });

  it("returns copies: mutating a returned binding changes nothing", async () => {
    registerPending(pending("call_A", { grant: grant(["read"]) }));
    const b = await bind("ses_child", lookup());
    (b.grant.actions as Set<AuthorityAction>).add("edit");
    (b.candidates as string[]).push("call_evil");
    const peek = currentBinding("ses_child")!;
    expect(actions(peek)).toEqual(["read"]);
    expect(peek.candidates).toEqual(["call_A"]);
    (peek.grant.actions as Set<AuthorityAction>).add("edit");
    expect(actions((await bind("ses_child", lookup())))).toEqual(["read"]);
  });
});

describe("widen", () => {
  it("an unbound child gets an empty grant and nothing is stored", () => {
    expect(widen("ses_nobody", ["edit"])).toEqual({ actions: new Set(), notes: [BINDING_NOTES.notBound], workRoot: null });
    expect(currentBinding("ses_nobody")).toBeUndefined();
  });

  it("adds only inside the max, never execute, router_run only with a root, never across the separation rule", async () => {
    registerPending(pending("call_A", { grant: grant(["read"], ROOT) }));
    await bind("ses_child", lookup());
    const max: AuthorityAction[] = [...LOCAL, "edit", "router_run", "execute"];
    const g = widen("ses_child", ["edit", "router_run", "execute", "webfetch", "grep"], max);
    expect(actions(g)).toEqual(["read", "grep", "router_run", "edit"]);
    expect(g.notes).toEqual([BINDING_NOTES.widened(["grep", "router_run", "edit"])]);
    const unbounded = widen("ses_child", ["webfetch", "edit"]);
    expect(actions(unbounded)).toEqual(["read", "grep", "router_run", "edit"]);
    expect(unbounded.notes).toContain(BINDING_NOTES.separation);
    expect(actions(currentBinding("ses_child")!)).toEqual(["read", "grep", "router_run", "edit"]);
  });

  it("never adds router_run to a binding without a work root (unknown)", async () => {
    const unknownChild = await bind("ses_child", lookup());
    expect(unknownChild.kind).toBe("unknown");
    const g = widen("ses_child", ["router_run", "edit"]);
    expect(actions(g)).toEqual([...LOCAL, "edit"]);
    expect(g.workRoot).toBeNull();
    expect(g.notes).toContain(BINDING_NOTES.noWorkRoot);
    expect(currentBinding("ses_child")!.kind).toBe("unknown");
  });

  it("keeps an egress grant egress-only", async () => {
    registerPending(pending("call_R", { agent: "researcher", grant: grant(["webfetch"], null) }));
    await bind("ses_r", lookup({ agent: "researcher" }));
    const g = widen("ses_r", ["read", "websearch"]);
    expect(actions(g)).toEqual(["webfetch", "websearch"]);
    expect(g.notes).toEqual([BINDING_NOTES.separation, BINDING_NOTES.widened(["websearch"])]);
    expect(actions(widen("ses_r", ["webfetch"]))).toEqual(["webfetch", "websearch"]);
  });
});

describe("process-wide registry", () => {
  it("two plugin instances share one registry and one decision", async () => {
    vi.resetModules();
    const other = await import("../../src/routing/roles/binding");
    expect(other.bind).not.toBe(binding.bind);
    binding.registerPending(pending("call_A", { grant: grant([...LOCAL, "edit"]) }));
    const gate = deferred<Session>();
    const slow = vi.fn<SessionLookup>(() => gate.promise);
    const fast = lookup({ agent: "general" });
    const fromA = binding.bind("ses_child", slow);
    const fromB = other.bind("ses_child", fast);
    gate.resolve({ parentID: PARENT, agent: "implementer", title: "task" });
    const [a, b] = await Promise.all([fromA, fromB]);
    expect(a).toEqual(b);
    expect(a.kind).toBe("exact");
    expect(slow).toHaveBeenCalledTimes(1);
    expect(fast).not.toHaveBeenCalled();
    expect(other.currentBinding("ses_child")).toEqual(a);
    other.evict("ses_child");
    expect(binding.currentBinding("ses_child")).toBeUndefined();
  });

  it("replaces a foreign value under the registry key", async () => {
    Reflect.set(globalThis, Symbol.for("opencode-model-router.role-binding"), { version: 1, pending: {} });
    registerPending(pending("call_A"));
    expect((await bind("ses_child", lookup())).kind).toBe("exact");
    Reflect.set(globalThis, Symbol.for("opencode-model-router.role-binding"), null);
    expect(bindingRegistrySize()).toEqual({ pending: 0, bound: 0, retired: 0 });
  });
});

// ---------------------------------------------------------------------------
// Property test (I5): random interleavings, seeded, no dependency
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const AGENT_MAX: Readonly<Record<string, readonly AuthorityAction[]>> = {
  implementer: [...LOCAL, "router_run", "edit"],
  general: [...LOCAL, "router_run", "edit"],
  researcher: ["webfetch", "websearch", "context7"],
};
const AGENTS = Object.keys(AGENT_MAX);
const ORDER: readonly AuthorityAction[] = [...LOCAL, "router_run", "edit", "webfetch", "websearch", "context7", "execute"];

interface SimDispatch {
  callID: string;
  parent: string;
  agent: string;
  grant: DispatchGrant;
  budget: number;
  decisionID: string;
  registeredAt: number;
  live: boolean;
}

interface SimChild {
  id: string;
  dispatch: SimDispatch;
  mode: "title" | "first" | "none";
  gate?: ReturnType<typeof deferred<Session>>;
  results: Array<Binding | undefined>;
  lookups: number;
  cached?: Binding;
  ownLiveAtDecision?: boolean;
}

function sortActions(set: Iterable<AuthorityAction>): AuthorityAction[] {
  const have = new Set(set);
  return ORDER.filter((a) => have.has(a));
}

function expectedBinding(child: SimChild, dispatches: readonly SimDispatch[], now: number): Omit<Binding, "grant"> & { actions: AuthorityAction[]; workRoot: string | null } {
  const live = dispatches.filter((d) => d.live && now - d.registeredAt < PENDING_TTL_MS);
  const candidates = live.filter((d) => d.parent === child.dispatch.parent && d.agent === child.dispatch.agent);
  const base = { childSessionID: child.id };
  const unknownResult = () => ({
    ...base, kind: "unknown" as const, candidates: [], decisionID: null, budget: null, workRoot: null,
    actions: LOCAL.filter((a) => AGENT_MAX[child.dispatch.agent]!.includes(a)),
  });
  const fromSet = (set: SimDispatch[], kind: "exact" | "intersection") => {
    let acts = sortActions(set[0]!.grant.actions);
    for (const d of set.slice(1)) acts = acts.filter((a) => d.grant.actions.has(a));
    const root = set.every((d) => d.grant.workRoot === set[0]!.grant.workRoot) ? set[0]!.grant.workRoot : null;
    if (root === null) acts = acts.filter((a) => a !== "router_run");
    return {
      ...base, kind, candidates: set.map((d) => d.callID), workRoot: root, actions: acts,
      decisionID: set.every((d) => d.decisionID === set[0]!.decisionID) ? set[0]!.decisionID : null,
      budget: Math.min(...set.map((d) => d.budget)),
    };
  };
  if (child.mode !== "none") {
    const own = candidates.find((d) => d.callID === child.dispatch.callID);
    return own ? fromSet([own], "exact") : unknownResult();
  }
  if (candidates.length === 1) return fromSet(candidates, "exact");
  if (candidates.length >= 2) return fromSet(candidates, "intersection");
  return unknownResult();
}

async function drain(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function runInterleaving(seed: number, steps: number): Promise<number> {
  const rand = mulberry32(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
  const dispatches: SimDispatch[] = [];
  const children: SimChild[] = [];
  const byCall = new Map<string, SimDispatch>();
  let checked = 0;
  const fallback = (agent: string | undefined) => (agent === undefined ? [] : AGENT_MAX[agent]);

  const check = (child: SimChild, got: Binding) => {
    // Independent properties first.
    const cands = got.candidates.map((id) => byCall.get(id)!);
    for (const c of cands) {
      expect(c.parent).toBe(child.dispatch.parent);
      expect(c.agent).toBe(child.dispatch.agent);
      for (const a of got.grant.actions) expect(c.grant.actions.has(a), `${a} ⊄ ${c.callID}`).toBe(true); // ⊆ every candidate: never a union
    }
    const roots = new Set(cands.map((c) => c.grant.workRoot));
    if (roots.size > 1) expect(got.grant.workRoot).toBeNull();
    if (roots.size === 1) expect([...roots][0] === got.grant.workRoot || got.grant.workRoot === null).toBe(true);
    if (got.kind === "unknown") {
      expect(got.candidates).toEqual([]);
      expect(got.grant.workRoot).toBeNull();
      for (const a of got.grant.actions) expect(LOCAL.includes(a) && AGENT_MAX[child.dispatch.agent]!.includes(a)).toBe(true);
    } else {
      expect(got.candidates.length).toBeGreaterThan(0);
    }
    if (got.grant.actions.has("router_run")) expect(got.grant.workRoot).not.toBeNull();
    // I5: a child carrying its nonce, or whose own dispatch was still pending, never gets more than its own grant.
    if (child.mode !== "none" || child.ownLiveAtDecision) {
      const own = child.dispatch.grant.actions;
      for (const a of got.grant.actions) {
        expect(got.kind === "unknown" || own.has(a), `${child.id} got ${a} beyond its own dispatch`).toBe(true);
      }
    }
    checked++;
  };

  for (let step = 0; step < steps; step++) {
    const roll = rand();
    if (roll < 0.25 || dispatches.length === 0) {
      const agent = pick(AGENTS);
      const max = AGENT_MAX[agent]!;
      const d: SimDispatch = {
        callID: `call_${seed}_${dispatches.length}`,
        parent: pick(["ses_p1", "ses_p2"]),
        agent,
        grant: { actions: new Set(max.filter(() => rand() < 0.6)), notes: [`n${dispatches.length % 3}`], workRoot: pick([ROOT, OTHER_ROOT, null]) },
        budget: 10 + Math.floor(rand() * 110),
        decisionID: pick(["dec_shared", `dec_${dispatches.length}`]),
        registeredAt: clock,
        live: true,
      };
      dispatches.push(d);
      byCall.set(d.callID, d);
      registerPending({
        parentSessionID: d.parent, callID: d.callID, agent: d.agent, description: "task", nonce: d.callID,
        grant: d.grant, budget: d.budget, decisionID: d.decisionID, registeredAt: d.registeredAt,
      });
    } else if (roll < 0.5) {
      const dispatch = pick(dispatches);
      const mode = pick(["title", "first", "none"] as const);
      const child: SimChild = { id: `ses_c${seed}_${children.length}`, dispatch, mode, results: [], lookups: 0, gate: deferred<Session>() };
      children.push(child);
      const lookupFn: SessionLookup = () => { child.lookups++; return child.gate!.promise; };
      const calls = rand() < 0.3 ? 2 : 1; // a second plugin hook asking at the same time
      for (let i = 0; i < calls; i++) {
        const index = child.results.push(undefined) - 1;
        void bind(child.id, lookupFn, { localFallback: fallback }).then((b) => { child.results[index] = b; });
      }
    } else if (roll < 0.7) {
      const waiting = children.filter((c) => c.gate !== undefined);
      if (waiting.length === 0) continue;
      const child = pick(waiting);
      const want = expectedBinding(child, dispatches, clock);
      child.ownLiveAtDecision = child.dispatch.live && clock - child.dispatch.registeredAt < PENDING_TTL_MS;
      const gate = child.gate!;
      child.gate = undefined;
      gate.resolve({
        parentID: child.dispatch.parent,
        agent: child.dispatch.agent,
        title: child.mode === "title" ? `task${nonceTitleSuffix(child.dispatch.callID)}` : "task",
        firstText: child.mode === "first" ? `You are a subagent.\n${noncePromptLine(child.dispatch.callID)}` : "You are a subagent.",
      });
      await drain();
      expect(child.lookups).toBe(1);
      const [first, ...rest] = child.results;
      expect(first).toBeDefined();
      for (const other of rest) expect(other).toEqual(first);
      const { actions: wantActions, workRoot, ...wantRest } = want;
      expect({ ...first!, grant: undefined }).toEqual({ ...wantRest, grant: undefined });
      expect(sortActions(first!.grant.actions)).toEqual(wantActions);
      expect(first!.grant.workRoot).toBe(workRoot);
      check(child, first!);
      child.cached = first;
    } else if (roll < 0.85) {
      const live = dispatches.filter((d) => d.live);
      if (live.length === 0) continue;
      const d = pick(live);
      d.live = false;
      evict(d.callID);
    } else if (roll < 0.88) {
      const parent = pick(["ses_p1", "ses_p2"]);
      for (const d of dispatches) if (d.parent === parent) d.live = false;
      for (const c of children) if (c.dispatch.parent === parent) c.cached = undefined;
      evict(parent);
    } else if (roll < 0.95) {
      clock += rand() < 0.1 ? PENDING_TTL_MS : 1_000 + Math.floor(rand() * 120_000);
    } else {
      const decided = children.filter((c) => c.cached !== undefined && c.gate === undefined);
      if (decided.length === 0) continue;
      const child = pick(decided);
      const again = await bind(child.id, () => { throw new Error("a cached binding needs no lookup"); });
      expect(again).toEqual(child.cached);
    }
  }
  // Release whatever is still waiting, so no promise outlives the run.
  for (const child of children) child.gate?.resolve(undefined);
  await drain();
  return checked;
}

describe("property: binding ambiguity never widens authority (I5)", () => {
  it("holds over random interleavings of dispatches, children, completions, deletions and time", async () => {
    let checked = 0;
    for (let seed = 1; seed <= 300; seed++) {
      resetBindingRegistryForTests();
      checked += await runInterleaving(seed, 80);
    }
    expect(checked).toBeGreaterThan(1000);
  }, 60_000);
});
