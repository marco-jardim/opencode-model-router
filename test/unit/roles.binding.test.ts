import { isAbsolute, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthorityAction, RoleSpec } from "../../src/router/roles";
import * as authority from "../../src/routing/roles/authority";
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
  dropBindingCacheForTests,
  evict,
  evictCall,
  newDispatchNonce,
  noncePromptLine,
  nonceTitleSuffix,
  registerPending,
  resetBindingRegistryForTests,
  widen,
  type BindOptions,
  type Binding,
  type PendingDispatch,
  type SessionLookup,
} from "../../src/routing/roles/binding";
import type { DispatchGrant } from "../../src/routing/roles/policy";

const PARENT = "ses_parent";
const ROOT = resolve("/git/omr-rta-p16");
const OTHER_ROOT = resolve("/git/omr-rta-p15");
const LOCAL: AuthorityAction[] = ["read", "glob", "grep", "router_git"];
const EGRESS: AuthorityAction[] = ["webfetch", "websearch", "context7"];
const ALL: AuthorityAction[] = [...LOCAL, "router_run", "edit", ...EGRESS, "execute"];
const MAX: Readonly<Record<string, readonly AuthorityAction[]>> = {
  implementer: [...LOCAL, "router_run", "edit"],
  general: [...LOCAL, "router_run", "edit"],
  researcher: EGRESS,
  explorer: LOCAL,
};
const OPTS: BindOptions = { maxOf: (agent) => MAX[agent] };

let clock = 1_000_000_000;

beforeEach(() => {
  resetBindingRegistryForTests();
  authority.resetAuthorityForTests();
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
    nonce: `nonce_${callID}`,
    grant: grant([...LOCAL, "edit"]),
    budget: 80,
    decisionID: `dec_${callID}`,
    registeredAt: clock,
    ...over,
  };
}

type Session = Awaited<ReturnType<SessionLookup>>;

function session(over: Partial<NonNullable<Session>> = {}): NonNullable<Session> {
  return { parentID: PARENT, agent: "implementer", title: "task", firstText: "You are a subagent spawned by another session.", ...over };
}

/** A child carrying the router's markers of `nonce` in its title and first message. */
function marked(nonce: string, over: Partial<NonNullable<Session>> = {}): NonNullable<Session> {
  return session({ title: `task${nonceTitleSuffix(nonce)}`, firstText: `You are a subagent.\n${noncePromptLine(nonce)}`, ...over });
}

function lookup(value: Session = session()) {
  return vi.fn<SessionLookup>(async () => value);
}

function acts(b: { grant: DispatchGrant } | DispatchGrant): AuthorityAction[] {
  return [...("grant" in b ? b.grant.actions : b.actions)];
}

function deferred<T>() {
  let resolveFn!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolveFn = r; });
  return { promise, resolve: resolveFn };
}

describe("bind: marker nonces (P-2, QA-P16-1-2)", () => {
  it("binds exactly by the router's markers, ∩ the role max, and claims the dispatch", async () => {
    registerPending(pending("call_A", { grant: grant([...LOCAL, "edit", "router_run"], ROOT, ["note A"]) }));
    const b = await bind("ses_child", lookup(marked("nonce_call_A")), OPTS);
    expect(b).toEqual({
      childSessionID: "ses_child",
      kind: "exact",
      grant: { actions: new Set([...LOCAL, "router_run", "edit"]), notes: ["note A"], workRoot: ROOT },
      candidates: ["call_A"],
      decisionID: "dec_call_A",
      budget: 80,
    } satisfies Binding);
    const second = await bind("ses_impostor", lookup(marked("nonce_call_A")), OPTS);
    expect(second.kind).toBe("unknown");
    expect(second.grant.notes).toEqual([BINDING_NOTES.unknown, BINDING_NOTES.claimed]);
  });

  it("uses the title's marker when the first message has none, and the first message's alone", async () => {
    registerPending(pending("call_A"));
    registerPending(pending("call_B"));
    expect((await bind("ses_a", lookup(session({ title: `task${nonceTitleSuffix("nonce_call_A")}`, firstText: undefined })), OPTS)).candidates)
      .toEqual(["call_A"]);
    expect((await bind("ses_b", lookup(session({ firstText: noncePromptLine("nonce_call_B") })), OPTS)).candidates)
      .toEqual(["call_B"]);
  });

  it("a bare nonce token is not a marker: no marker → unknown when the dispatches are nonce-bound", async () => {
    registerPending(pending("call_A"));
    const b = await bind("ses_child", lookup(session({ title: "resume nonce_call_A", firstText: "see nonce_call_A" })), OPTS);
    expect(b.kind).toBe("unknown");
    expect(b.grant.notes).toEqual([BINDING_NOTES.unknown, BINDING_NOTES.noNonce]);
  });

  it("QA-P16-1-1: a marker-free child is never bound by counting to a nonce-bound dispatch", async () => {
    registerPending(pending("call_A", { grant: grant(LOCAL) }));
    evictCall(PARENT, "call_A"); // the child's own dispatch completed
    registerPending(pending("call_B", { grant: grant([...LOCAL, "edit", "router_run"]) }));
    const b = await bind("ses_plain", lookup(), OPTS);
    expect(b.kind).toBe("unknown");
    expect(acts(b)).toEqual(LOCAL);
    expect(b.grant.notes).toEqual([BINDING_NOTES.unknown, BINDING_NOTES.noNonce]);
  });

  it("title and first message disagreeing → unknown; several markers → unknown", async () => {
    registerPending(pending("call_A"));
    registerPending(pending("call_B"));
    const disagree = await bind("ses_1", lookup(marked("nonce_call_A", { title: `t${nonceTitleSuffix("nonce_call_B")}` })), OPTS);
    expect(disagree.grant.notes).toEqual([BINDING_NOTES.unknown, BINDING_NOTES.markers]);
    const sibling = await bind("ses_2", lookup(marked("nonce_call_A", {
      firstText: `quoting ${noncePromptLine("nonce_call_B")}\n${noncePromptLine("nonce_call_A")}`, title: "task",
    })), OPTS);
    expect(sibling.grant.notes).toEqual([BINDING_NOTES.unknown, BINDING_NOTES.markers]);
    const forged = await bind("ses_3", lookup(marked("nonce_call_A", { title: `t [nonce forged] [nonce nonce_call_A]` })), OPTS);
    expect(forged.grant.notes).toEqual([BINDING_NOTES.unknown, BINDING_NOTES.markers]);
    expect((await bind("ses_4", lookup(marked("nonce_call_A")), OPTS)).kind).toBe("exact");
  });

  it("a retired, unregistered, foreign-parent or foreign-agent marker → unknown", async () => {
    registerPending(pending("call_A"));
    evictCall(PARENT, "call_A");
    registerPending(pending("call_B"));
    registerPending(pending("call_X", { parentSessionID: "ses_other" }));
    registerPending(pending("call_G", { agent: "general" }));
    for (const nonce of ["nonce_call_A", "nonce_never", "nonce_call_X", "nonce_call_G"]) {
      const b = await bind(`ses_${nonce}`, lookup(marked(nonce)), OPTS);
      expect(b.kind, nonce).toBe("unknown");
      expect(b.grant.notes, nonce).toEqual([BINDING_NOTES.unknown, BINDING_NOTES.foreignNonce]);
    }
  });

  it("the claimer re-deciding after a cache loss binds exactly again; the claim survives", async () => {
    registerPending(pending("call_A"));
    const get = lookup(marked("nonce_call_A"));
    expect((await bind("ses_child", get, OPTS)).kind).toBe("exact");
    dropBindingCacheForTests("ses_child");
    expect((await bind("ses_child", get, OPTS)).kind).toBe("exact");
    expect(get).toHaveBeenCalledTimes(2);
    expect((await bind("ses_other", lookup(marked("nonce_call_A")), OPTS)).kind).toBe("unknown");
  });

  it("a marker with a live unclaimed nonce-less sibling → intersection with it", async () => {
    registerPending(pending("call_A", { grant: grant([...LOCAL, "edit"]) }));
    registerPending(pending("call_N", { nonce: "", grant: grant(["read", "edit"]) }));
    const b = await bind("ses_child", lookup(marked("nonce_call_A")), OPTS);
    expect(b.kind).toBe("intersection");
    expect(b.candidates).toEqual(["call_A", "call_N"]);
    expect(acts(b)).toEqual(["read", "edit"]);
  });
});

describe("bind: nonce-less counting (QA-P16-1-1)", () => {
  it("one unclaimed nonce-less dispatch → exact and claimed; the next marker-free child gets nothing", async () => {
    registerPending(pending("call_N", { nonce: "" }));
    const get = lookup();
    expect((await bind("ses_1", get, OPTS)).kind).toBe("exact");
    const next = await bind("ses_2", lookup(), OPTS);
    expect(next.grant.notes).toEqual([BINDING_NOTES.unknown, BINDING_NOTES.claimed]);
    dropBindingCacheForTests("ses_1");
    expect((await bind("ses_1", get, OPTS)).candidates).toEqual(["call_N"]);
  });

  it("a claimed nonce-less entry stays in the pool: the real child gets an intersection, never another entry", async () => {
    registerPending(pending("call_D", { nonce: "", grant: grant(["read"]) }));
    await bind("ses_late", lookup(), OPTS); // a late child claims call_D
    registerPending(pending("call_G", { nonce: "", grant: grant([...LOCAL, "edit"]) }));
    const real = await bind("ses_real", lookup(), OPTS);
    expect(real.kind).toBe("intersection");
    expect(real.candidates).toEqual(["call_D", "call_G"]);
    expect(acts(real)).toEqual(["read"]);
    expect((await bind("ses_late", lookup(), OPTS)).candidates).toEqual(["call_D"]);
  });

  it("two nonce-less dispatches → intersection: actions ∩, notes merged, shared root and decision kept, smallest budget", async () => {
    registerPending(pending("call_A", { nonce: "", grant: grant([...LOCAL, "edit", "router_run"], ROOT, ["a", "shared"]), budget: 80, decisionID: "dec" }));
    registerPending(pending("call_B", { nonce: "", grant: grant(["read", "grep", "edit", "router_run"], ROOT, ["b", "shared"]), budget: 40, decisionID: "dec" }));
    const b = await bind("ses_child", lookup(), OPTS);
    expect(b.kind).toBe("intersection");
    expect(acts(b)).toEqual(["read", "grep", "router_run", "edit"]);
    expect(b.grant.workRoot).toBe(ROOT);
    expect(b.grant.notes).toEqual([BINDING_NOTES.intersection(2), "a", "shared", "b"]);
    expect(b.candidates).toEqual(["call_A", "call_B"]);
    expect(b.budget).toBe(40);
    expect(b.decisionID).toBe("dec");
  });

  it("different work roots → workRoot null and router_run goes with it; different decisions → null", async () => {
    registerPending(pending("call_A", { nonce: "", grant: grant([...LOCAL, "router_run"], ROOT) }));
    registerPending(pending("call_B", { nonce: "", grant: grant([...LOCAL, "router_run"], OTHER_ROOT) }));
    const b = await bind("ses_child", lookup(), OPTS);
    expect(b.grant.workRoot).toBeNull();
    expect(acts(b)).toEqual(LOCAL);
    expect(b.grant.notes).toContain(BINDING_NOTES.noWorkRoot);
    expect(b.decisionID).toBeNull();
  });

  it("mixed nonce-bound and nonce-less dispatches: a marker-free child → unknown", async () => {
    registerPending(pending("call_A"));
    registerPending(pending("call_N", { nonce: "" }));
    expect((await bind("ses_child", lookup(), OPTS)).grant.notes).toEqual([BINDING_NOTES.unknown, BINDING_NOTES.noNonce]);
  });

  it("no dispatch at all → unknown = max ∩ local, no root, no budget", async () => {
    expect(await bind("ses_child", lookup(), OPTS)).toEqual({
      childSessionID: "ses_child",
      kind: "unknown",
      grant: { actions: new Set(LOCAL), notes: [BINDING_NOTES.unknown, BINDING_NOTES.noCandidate], workRoot: null },
      candidates: [],
      decisionID: null,
      budget: null,
    });
    expect(BINDING_NOTES.unknown).toContain("router_request_authority");
  });
});

describe("bind: the role max bounds every grant (QA-P16-1-3)", () => {
  it("exact and intersection grants are ∩ the max; on a mixed grant the role's own side survives", async () => {
    registerPending(pending("call_I", { grant: grant([...LOCAL, "edit", "webfetch", "execute"]) }));
    const impl = await bind("ses_i", lookup(marked("nonce_call_I")), OPTS);
    expect(acts(impl)).toEqual([...LOCAL, "edit"]);
    expect(impl.grant.notes).toEqual([BINDING_NOTES.beyondMax(["webfetch", "execute"])]);
    registerPending(pending("call_R", { agent: "researcher", grant: grant(["read", "grep", "webfetch"], null) }));
    const res = await bind("ses_r", lookup(marked("nonce_call_R", { agent: "researcher" })), OPTS);
    expect(acts(res)).toEqual(["webfetch"]);
  });

  it("unknown = max ∩ local: nothing for a researcher", async () => {
    expect(acts(await bind("ses_r", lookup(session({ agent: "researcher" })), OPTS))).toEqual([]);
    expect(acts(await bind("ses_e", lookup(session({ agent: "explorer" })), OPTS))).toEqual(LOCAL);
  });

  it("a max that is undefined, throws, is missing or holds execute fails closed", async () => {
    registerPending(pending("call_A", { grant: grant([...LOCAL, "edit"]) }));
    expect(acts(await bind("ses_1", lookup(marked("nonce_call_A")), { maxOf: () => undefined }))).toEqual([]);
    expect(acts(await bind("ses_1", lookup(), { maxOf: () => { throw new Error("boom"); } }))).toEqual([]);
    expect(acts(await bind("ses_1", lookup(), undefined as unknown as BindOptions))).toEqual([]);
    expect(acts(await bind("ses_1", lookup(), { maxOf: () => null as unknown as undefined }))).toEqual([]);
    expect(acts(await bind("ses_1", lookup(), { maxOf: () => [...LOCAL, "edit"] }))).toEqual([...LOCAL, "edit"]);
    registerPending(pending("call_X", { grant: grant(["read", "execute"]) }));
    expect(acts(await bind("ses_x", lookup(marked("nonce_call_X")), { maxOf: () => ALL }))).toEqual(["read"]);
  });

  it("each caller sees the shared decision ∩ its own max; a permissive first caller widens nobody", async () => {
    registerPending(pending("call_A", { agent: "explorer", grant: grant([...LOCAL, "edit"]) }));
    const gate = deferred<Session>();
    const permissive = bind("ses_child", () => gate.promise, { maxOf: () => ALL });
    const strict = bind("ses_child", lookup(), OPTS);
    gate.resolve(marked("nonce_call_A", { agent: "explorer" }));
    expect(acts(await permissive)).toEqual([...LOCAL, "edit"]);
    expect(acts(await strict)).toEqual(LOCAL);
    expect(acts((await bind("ses_child", lookup(), OPTS)))).toEqual(LOCAL);
    expect(acts(currentBinding("ses_child", OPTS)!)).toEqual(LOCAL);
    expect(acts(currentBinding("ses_child", { maxOf: () => ["read"] })!)).toEqual(["read"]);
    expect(currentBinding("ses_nobody", OPTS)).toBeUndefined();
  });
});

describe("bind: lookups (QA-P16-1-10)", () => {
  it("a failed lookup or one without parent or agent → unknown, never cached: the next hook retries", async () => {
    registerPending(pending("call_A"));
    const failures: SessionLookup[] = [
      async () => { throw new Error("host down"); },
      (() => { throw new Error("sync"); }) as unknown as SessionLookup,
      async () => undefined,
      async () => session({ parentID: undefined }),
      async () => session({ agent: "" }),
    ];
    for (const failing of failures) {
      const b = await bind("ses_child", failing, OPTS);
      expect(b.kind).toBe("unknown");
      expect(currentBinding("ses_child", OPTS)).toBeUndefined();
    }
    expect((await bind("ses_x", async () => undefined, OPTS)).grant).toEqual({
      actions: new Set(), notes: [BINDING_NOTES.unknown, BINDING_NOTES.lookupFailed], workRoot: null,
    });
    expect((await bind("ses_y", async () => session({ parentID: undefined }), OPTS)).grant.notes)
      .toEqual([BINDING_NOTES.unknown, BINDING_NOTES.noParent]);
    expect((await bind("ses_child", lookup(marked("nonce_call_A")), OPTS)).kind).toBe("exact");
  });
});

describe("registration", () => {
  it("newDispatchNonce is a fresh UUID", () => {
    const a = newDispatchNonce();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(newDispatchNonce()).not.toBe(a);
    expect(nonceTitleSuffix("x")).toBe(" [nonce x]");
    expect(noncePromptLine("x")).toBe("OMR_NONCE=x");
  });

  it("refuses invalid entries, including a budget that is not finite and > 0 (QA-P16-1-14)", () => {
    for (const bad of [
      pending("", {}), pending("call", { parentSessionID: "" }), pending("call", { agent: "" }),
      { ...pending("call"), grant: { actions: ["read"] as unknown as Set<AuthorityAction>, notes: [], workRoot: null } },
      null as unknown as PendingDispatch, { ...pending("call"), nonce: 5 as unknown as string },
      { ...pending("call"), grant: null as unknown as DispatchGrant },
      pending("call", { budget: Number.NaN }), pending("call", { budget: Number.POSITIVE_INFINITY }), pending("call", { budget: 0 }),
      pending("call", { budget: "80" as unknown as number }),
    ]) registerPending(bad);
    expect(bindingRegistrySize().pending).toBe(0);
  });

  it("a work root that is not an absolute path becomes null and takes router_run with it (QA-P16-1-8)", async () => {
    for (const [i, root] of (["", undefined, "relative/root", `${ROOT}\0x`, 42] as unknown[]).entries()) {
      registerPending(pending(`call_${i}`, { grant: { actions: new Set<AuthorityAction>([...LOCAL, "router_run"]), notes: [], workRoot: root as string } }));
      const b = await bind(`ses_${i}`, lookup(marked(`nonce_call_${i}`)), OPTS);
      expect(b.grant.workRoot, String(root)).toBeNull();
      expect(acts(b), String(root)).toEqual(LOCAL);
    }
  });

  it("copies the grant: a later mutation of the caller's set cannot widen it", async () => {
    const set = new Set<AuthorityAction>(["read"]);
    registerPending(pending("call_A", { grant: { actions: set, notes: [], workRoot: ROOT } }));
    set.add("edit");
    const b = await bind("ses_child", lookup(marked("nonce_call_A")), OPTS);
    expect(acts(b)).toEqual(["read"]);
    (b.grant.actions as Set<AuthorityAction>).add("edit");
    (b.candidates as string[]).push("call_evil");
    expect(acts(currentBinding("ses_child", OPTS)!)).toEqual(["read"]);
    expect(currentBinding("ses_child", OPTS)!.candidates).toEqual(["call_A"]);
  });

  it("never un-retires a nonce and refuses a nonce another live dispatch holds (QA-P16-1-5)", async () => {
    registerPending(pending("call_A"));
    evictCall(PARENT, "call_A");
    registerPending(pending("call_A2", { nonce: "nonce_call_A" }));
    expect(bindingRegistrySize().pending).toBe(0);
    expect((await bind("ses_old", lookup(marked("nonce_call_A")), OPTS)).kind).toBe("unknown");
    registerPending(pending("call_B"));
    registerPending(pending("call_C", { nonce: "nonce_call_B" }));
    expect(bindingRegistrySize().pending).toBe(1);
  });

  it("re-registering a key: the same nonce keeps the claim, a new nonce retires the old one and resets it", async () => {
    registerPending(pending("call_A"));
    await bind("ses_child", lookup(marked("nonce_call_A")), OPTS);
    registerPending(pending("call_A", { grant: grant(LOCAL) }));
    expect((await bind("ses_other", lookup(marked("nonce_call_A")), OPTS)).grant.notes).toContain(BINDING_NOTES.claimed);
    registerPending(pending("call_A", { nonce: "nonce_fresh" }));
    expect((await bind("ses_old", lookup(marked("nonce_call_A")), OPTS)).grant.notes).toContain(BINDING_NOTES.foreignNonce);
    expect((await bind("ses_new", lookup(marked("nonce_fresh")), OPTS)).kind).toBe("exact");
  });

  it("evicts a call by (parent, callID) only: a reused call id under another parent stays (QA-P16-1-5)", async () => {
    registerPending(pending("call_1"));
    registerPending(pending("call_1", { parentSessionID: "ses_p2", nonce: "nonce_p2" }));
    evictCall(PARENT, "call_1");
    evictCall(PARENT, "call_missing");
    expect(bindingRegistrySize().pending).toBe(1);
    expect((await bind("ses_c", lookup(marked("nonce_p2", { parentID: "ses_p2" })), OPTS)).kind).toBe("exact");
  });
});

describe("lifetimes and eviction", () => {
  it("evict(parent): its entries and its children's bindings go, the parent is tombstoned (QA-P16-1-7)", async () => {
    registerPending(pending("call_A"));
    registerPending(pending("call_O", { parentSessionID: "ses_other" }));
    await bind("ses_child", lookup(marked("nonce_call_A")), OPTS);
    await bind("ses_other_child", lookup(marked("nonce_call_O", { parentID: "ses_other" })), OPTS);
    evict(PARENT);
    expect(currentBinding("ses_child", OPTS)).toBeUndefined();
    expect(currentBinding("ses_other_child", OPTS)?.kind).toBe("exact");
    expect(bindingRegistrySize()).toMatchObject({ pending: 1, deleted: 1 });
    registerPending(pending("call_late"));
    expect(bindingRegistrySize().pending).toBe(1);
  });

  it("an in-flight lookup never stores a binding to a deleted parent or child", async () => {
    registerPending(pending("call_A"));
    registerPending(pending("call_B"));
    const gate = deferred<Session>();
    const late = bind("ses_child", () => gate.promise, OPTS);
    evict(PARENT);
    gate.resolve(marked("nonce_call_A"));
    expect((await late).kind).toBe("unknown");
    expect(currentBinding("ses_child", OPTS)).toBeUndefined();
    registerPending(pending("call_C", { parentSessionID: "ses_p2" }));
    const gate2 = deferred<Session>();
    const deleted = bind("ses_gone", () => gate2.promise, OPTS);
    evict("ses_gone");
    gate2.resolve(marked("nonce_call_C", { parentID: "ses_p2" }));
    expect((await deleted).kind).toBe("exact");
    expect(currentBinding("ses_gone", OPTS)).toBeUndefined();
    await bind("ses_gone", lookup(marked("nonce_call_C", { parentID: "ses_p2" })), OPTS);
    expect(currentBinding("ses_gone", OPTS)).toBeUndefined();
  });

  it("the same child resumed twice gets the cached binding with its widened grant, one lookup", async () => {
    registerPending(pending("call_A", { grant: grant(LOCAL) }));
    const get = lookup(marked("nonce_call_A"));
    await bind("ses_child", get, OPTS);
    evictCall(PARENT, "call_A");
    expect(acts(widen("ses_child", ["edit"], MAX.implementer!))).toEqual([...LOCAL, "edit"]);
    for (let resume = 0; resume < 2; resume++) {
      const again = await bind("ses_child", get, OPTS);
      expect(again.kind).toBe("exact");
      expect(acts(again)).toEqual([...LOCAL, "edit"]);
      expect(again.grant.notes).toEqual([BINDING_NOTES.widened(["edit"])]);
    }
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("expires pending entries after 30 min; retired nonces and tombstones are forgotten after 30 min more", async () => {
    registerPending(pending("call_A"));
    evict("ses_deleted");
    clock += PENDING_TTL_MS - 1;
    expect((await bind("ses_1", lookup(marked("nonce_call_A")), OPTS)).kind).toBe("exact");
    clock += 1;
    expect((await bind("ses_2", lookup(marked("nonce_call_A")), OPTS)).kind).toBe("unknown");
    expect(bindingRegistrySize()).toEqual({ pending: 0, bound: 2, retired: 1, deleted: 0 }); // a foreign-nonce unknown is final
    clock += PENDING_TTL_MS;
    registerPending(pending("call_B"));
    expect(bindingRegistrySize()).toMatchObject({ pending: 1, retired: 0 });
  });

  it("a future registeredAt cannot extend the TTL; a non-finite one means now; an expired one is refused", async () => {
    registerPending(pending("call_F", { registeredAt: clock + 10 * PENDING_TTL_MS }));
    registerPending(pending("call_N", { registeredAt: Number.NaN }));
    clock += PENDING_TTL_MS;
    expect((await bind("ses_1", lookup(marked("nonce_call_F")), OPTS)).kind).toBe("unknown");
    expect((await bind("ses_2", lookup(marked("nonce_call_N")), OPTS)).kind).toBe("unknown");
    registerPending(pending("call_old", { registeredAt: clock - PENDING_TTL_MS }));
    expect(bindingRegistrySize().pending).toBe(0);
    registerPending(pending("call_again", { nonce: "nonce_call_old" }));
    expect(bindingRegistrySize().pending).toBe(0);
  });

  it("bounds the pending registry: the oldest entry goes first and its nonce retires", async () => {
    for (let i = 0; i <= PENDING_MAX; i++) registerPending(pending(`call_${i}`));
    expect(bindingRegistrySize().pending).toBe(PENDING_MAX);
    expect((await bind("ses_0", lookup(marked("nonce_call_0")), OPTS)).grant.notes).toContain(BINDING_NOTES.foreignNonce);
    expect((await bind("ses_1", lookup(marked("nonce_call_1")), OPTS)).kind).toBe("exact");
  });

  it("bounds the retired nonces and the tombstones", () => {
    for (let i = 0; i < 1100; i++) {
      registerPending(pending(`call_${i}`));
      evictCall(PARENT, `call_${i}`);
    }
    for (let i = 0; i < 4200; i++) evict(`ses_${i}`);
    expect(bindingRegistrySize()).toMatchObject({ pending: 0, retired: 1024, deleted: 4096 });
  });

  it("bounds the bound children, least recently used first", async () => {
    registerPending(pending("call_N", { nonce: "", agent: "explorer" }));
    const get = lookup(session({ agent: "explorer" }));
    for (let i = 0; i < BOUND_MAX; i++) await bind(`ses_${i}`, get, OPTS);
    await bind("ses_0", get, OPTS);
    await bind("ses_extra", get, OPTS);
    expect(bindingRegistrySize().bound).toBe(BOUND_MAX);
    expect(currentBinding("ses_0", OPTS)).toBeDefined();
    expect(currentBinding("ses_1", OPTS)).toBeUndefined();
  });
});

describe("widen", () => {
  it("an unbound child gets an empty grant and nothing is stored", () => {
    expect(widen("ses_nobody", ["edit"], ALL)).toEqual({ actions: new Set(), notes: [BINDING_NOTES.notBound], workRoot: null });
    expect(currentBinding("ses_nobody", OPTS)).toBeUndefined();
  });

  it("without a max nothing is added and nothing stored", async () => {
    registerPending(pending("call_A", { grant: grant(["read"]) }));
    await bind("ses_child", lookup(marked("nonce_call_A")), OPTS);
    expect(acts(widen("ses_child", ["edit"], undefined as unknown as AuthorityAction[]))).toEqual(["read"]);
    expect(acts(widen("ses_child", ["edit"], null as unknown as AuthorityAction[]))).toEqual(["read"]);
    expect(acts(currentBinding("ses_child", OPTS)!)).toEqual(["read"]);
  });

  it("adds only inside the max, never execute, router_run only with a root, never across the separation rule", async () => {
    registerPending(pending("call_A", { grant: grant(["read"], ROOT) }));
    await bind("ses_child", lookup(marked("nonce_call_A")), OPTS);
    const g = widen("ses_child", ["edit", "router_run", "execute", "webfetch", "grep"], [...ALL]);
    expect(acts(g)).toEqual(["read", "grep", "router_run", "edit"]);
    expect(g.notes).toEqual([BINDING_NOTES.separation, BINDING_NOTES.widened(["grep", "router_run", "edit"])]);
    const narrowed = widen("ses_child", ["glob"], ["read", "glob"]);
    expect(acts(narrowed)).toEqual(["read", "glob"]);
    expect(narrowed.notes).toContain(BINDING_NOTES.beyondMax(["grep", "router_run", "edit"]));
  });

  it("never adds router_run to a binding without a work root (unknown)", async () => {
    expect((await bind("ses_child", lookup(), OPTS)).kind).toBe("unknown");
    const g = widen("ses_child", ["router_run", "edit"], MAX.implementer!);
    expect(acts(g)).toEqual([...LOCAL, "edit"]);
    expect(g.workRoot).toBeNull();
    expect(g.notes).toContain(BINDING_NOTES.noWorkRoot);
  });

  it("keeps an egress grant egress-only", async () => {
    registerPending(pending("call_R", { agent: "researcher", grant: grant(["webfetch"], null) }));
    await bind("ses_r", lookup(marked("nonce_call_R", { agent: "researcher" })), OPTS);
    const g = widen("ses_r", ["read", "websearch"], [...EGRESS, "read"]);
    expect(acts(g)).toEqual(["webfetch", "websearch"]);
    expect(g.notes).toEqual([BINDING_NOTES.separation, BINDING_NOTES.widened(["websearch"])]);
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
    const fast = lookup(session({ agent: "general" }));
    const fromA = binding.bind("ses_child", slow, OPTS);
    const fromB = other.bind("ses_child", fast, OPTS);
    gate.resolve(marked("nonce_call_A"));
    const [a, b] = await Promise.all([fromA, fromB]);
    expect(a).toEqual(b);
    expect(a.kind).toBe("exact");
    expect(slow).toHaveBeenCalledTimes(1);
    expect(fast).not.toHaveBeenCalled();
    other.evict("ses_child");
    expect(binding.currentBinding("ses_child", OPTS)).toBeUndefined();
  });

  it("replaces a foreign or older-version value under the registry key", async () => {
    const key = Symbol.for("opencode-model-router.role-binding");
    Reflect.set(globalThis, key, { version: 1, pending: new Map(), bound: new Map(), inflight: new Map(), retired: new Map() });
    registerPending(pending("call_A"));
    expect((await bind("ses_child", lookup(marked("nonce_call_A")), OPTS)).kind).toBe("exact");
    Reflect.set(globalThis, key, null);
    expect(bindingRegistrySize()).toEqual({ pending: 0, bound: 0, retired: 0, deleted: 0 });
  });
});

// ---------------------------------------------------------------------------
// Property (I5, QA-P16-1-6): random interleavings, seeded, no dependency, no restated decision rules.
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

const AGENTS = ["implementer", "general", "researcher"] as const;
const SPECS: ReadonlyMap<string, RoleSpec> = new Map(AGENTS.map((agent) => [agent, {
  agent, kind: agent === "researcher" ? "research" : agent === "general" ? "general" : "implement",
  description: agent, prompt: agent,
  authority: { mode: agent === "researcher" ? "fixed" : "dynamic", allow: [...MAX[agent]!], deny: [] },
  tierRange: { floor: "fast", ceiling: "heavy" }, assurance: "none", guard: "producer", budget: {}, enabled: true,
} satisfies RoleSpec]));
const EGRESS_SET = new Set<AuthorityAction>([...EGRESS, "execute"]);

interface SimDispatch {
  parent: string;
  callID: string;
  agent: string;
  nonce: string;
  grant: DispatchGrant;
  registeredAt: number;
  live: boolean;
  spawned: boolean;
}

interface SimChild {
  id: string;
  dispatch: SimDispatch;
  session: NonNullable<Session>;
  /** The router's own marker survived in the title or the first message. */
  carriesOwn: boolean;
  /** Another dispatch's or a forged marker was planted in the text. */
  injected: boolean;
  gate?: ReturnType<typeof deferred<Session>>;
  waiting: Array<{ max: readonly AuthorityAction[]; result?: Binding }>;
  /** Actions any widening of this child may have added (requested ∩ max). */
  widened: Set<AuthorityAction>;
  decided: boolean;
  /** Registrations at the child's last decision (a cached binding is judged against them). */
  snapshot: Map<string, SimDispatch>;
}

interface Stats {
  checked: number; exact: number; intersection: number; unknown: number;
  cleanLive: number; cleanExact: number; widened: number; residual: number;
}

function absoluteRoot(root: unknown): string | null {
  return typeof root === "string" && root !== "" && !root.includes("\0") && isAbsolute(root) ? root : null;
}

async function drain(): Promise<void> {
  await new Promise<void>((done) => setImmediate(done));
}

async function runInterleaving(seed: number, steps: number, stats: Stats, nonceless: boolean): Promise<void> {
  const noncelessRun = nonceless;
  const rand = mulberry32(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
  const subset = <T>(list: readonly T[], p: number): T[] => list.filter(() => rand() < p);
  const generation: Record<string, number> = { p1: 0, p2: 0 };
  const parentOf = (slot: string) => `ses_${slot}_${generation[slot]}`;
  const dispatches: SimDispatch[] = [];
  const children: SimChild[] = [];
  const registered = new Map<string, SimDispatch>(); // (parent, callID) → current dispatch

  const ownLive = (d: SimDispatch) => d.live && clock - d.registeredAt < PENDING_TTL_MS && registered.get(`${d.parent}|${d.callID}`) === d;

  const check = (child: SimChild, got: Binding, callerMax: readonly AuthorityAction[], ownLiveAtDecision: boolean, snapshot: Map<string, SimDispatch>) => {
    const max = new Set(callerMax);
    for (const a of got.grant.actions) {
      expect(max.has(a), `${child.id}: ${a} beyond the caller's max`).toBe(true);
      expect(a).not.toBe("execute");
    }
    const actions = [...got.grant.actions];
    expect(actions.some((a) => EGRESS_SET.has(a)) && actions.some((a) => !EGRESS_SET.has(a)), "separation").toBe(false);
    if (got.grant.actions.has("router_run")) expect(absoluteRoot(got.grant.workRoot)).not.toBeNull();
    // Never a union: ⊆ every candidate's registered grant; work root shared or null.
    const cands = got.candidates.map((id) => snapshot.get(`${child.dispatch.parent}|${id}`)!);
    for (const c of cands) {
      expect(c, `${child.id}: candidate ${String(c)} not registered`).toBeDefined();
      for (const a of got.grant.actions) if (!child.widened.has(a)) expect(c.grant.actions.has(a), `${a} ⊄ ${c.callID}`).toBe(true);
    }
    const roots = new Set(cands.map((c) => absoluteRoot(c.grant.workRoot)));
    if (roots.size > 1) expect(got.grant.workRoot).toBeNull();
    if (roots.size === 1) expect([[...roots][0], null]).toContain(got.grant.workRoot);
    // I5: a child gets nothing beyond its own dispatch (unknown: beyond max ∩ local), plus what was widened.
    // Guaranteed whenever the router's own marker reached the child (P2.1 always writes both); for a
    // marker-less child without planted markers when no nonce-less dispatch exists; and for a marker-less
    // child whose own dispatch is still pending — unless a sibling's marker was planted in a nonce-bound child
    // that lost its own. The rest (a planted marker in a marker-less child, or the nonce-less counting
    // fallback after the child's own dispatch ended) is indistinguishable by design: the documented residual.
    const base = got.kind === "unknown" ? new Set(LOCAL.filter((a) => max.has(a))) : child.dispatch.grant.actions;
    const guaranteed = child.carriesOwn
      || (!child.injected && !noncelessRun)
      || (ownLiveAtDecision && !(child.dispatch.nonce !== "" && child.injected));
    if (guaranteed) {
      for (const a of got.grant.actions) {
        expect(base.has(a) || child.widened.has(a), `I5: ${child.id} (${got.kind}) got ${a} beyond its own dispatch`).toBe(true);
      }
    } else {
      stats.residual++;
    }
    if (got.kind === "unknown") {
      expect(got.candidates).toEqual([]);
      expect(got.grant.workRoot).toBeNull();
      for (const a of got.grant.actions) expect(LOCAL.includes(a) || child.widened.has(a)).toBe(true);
    }
    stats.checked++;
    stats[got.kind]++;
  };

  const register = () => {
    const slot = pick(["p1", "p2"]);
    const agent = pick(AGENTS);
    const max = MAX[agent]!;
    const extra = rand() < 0.15 ? [pick(ALL)] : [];
    const d: SimDispatch = {
      parent: parentOf(slot),
      callID: `call_${Math.floor(rand() * 6)}`, // call ids are reused across parents and after completion
      agent,
      nonce: nonceless && rand() < 0.25 ? "" : newDispatchNonce(),
      grant: grant([...subset(max, 0.6), ...extra], pick([ROOT, OTHER_ROOT, null, "", "relative/root"]) as string | null),
      registeredAt: clock,
      live: true,
      spawned: false,
    };
    const key = `${d.parent}|${d.callID}`;
    const previous = registered.get(key);
    if (previous) previous.live = false;
    registered.set(key, d);
    dispatches.push(d);
    registerPending({
      parentSessionID: d.parent, callID: d.callID, agent: d.agent, description: "task", nonce: d.nonce,
      grant: d.grant, budget: 10 + Math.floor(rand() * 100), decisionID: null, registeredAt: d.registeredAt,
    });
  };

  const spawn = () => {
    const free = dispatches.filter((d) => !d.spawned);
    if (free.length === 0) return;
    const d = pick(free);
    d.spawned = true;
    const others = dispatches.filter((o) => o !== d && o.nonce !== "");
    let title = "task";
    let first: string | undefined = "You are a subagent.";
    let inTitle = false;
    let inFirst = false;
    if (d.nonce !== "") {
      const where = pick(["title", "first", "both"] as const);
      inTitle = where !== "first";
      inFirst = where !== "title";
      if (inTitle) title += nonceTitleSuffix(d.nonce);
      if (inFirst) first += `\n${noncePromptLine(d.nonce)}`;
    }
    let injected = false;
    const inject = (marker: string) => {
      injected = true;
      if (rand() < 0.5) title += ` ${marker}`;
      else first = `${marker}\n${first}`;
    };
    if (others.length > 0 && rand() < 0.2) inject(rand() < 0.5 ? nonceTitleSuffix(pick(others).nonce).trim() : noncePromptLine(pick(others).nonce));
    if (rand() < 0.1) inject(noncePromptLine(`forged-${Math.floor(rand() * 1e6)}`));
    if (rand() < 0.1) {
      first = undefined; // the lookup did not return the first message
      inFirst = false;
    }
    const child: SimChild = {
      id: `ses_c${seed}_${children.length}`, dispatch: d, carriesOwn: inTitle || inFirst, injected,
      session: { parentID: d.parent, agent: d.agent, title, firstText: first },
      waiting: [], widened: new Set(), decided: false, snapshot: new Map(),
    };
    children.push(child);
    startBind(child);
  };

  const startBind = (child: SimChild) => {
    child.gate = deferred<Session>();
    const gate = child.gate;
    const callers = rand() < 0.3 ? 2 : 1;
    for (let i = 0; i < callers; i++) {
      const role = MAX[child.dispatch.agent]!;
      const max = i === 0 && rand() < 0.15 ? ALL : i === 1 ? subset(role, 0.7) : role;
      const entry: SimChild["waiting"][number] = { max };
      child.waiting.push(entry);
      void bind(child.id, () => gate.promise, { maxOf: () => max }).then((b) => { entry.result = b; });
    }
  };

  const release = async () => {
    const waiting = children.filter((c) => c.gate !== undefined);
    if (waiting.length === 0) return;
    const child = pick(waiting);
    const live = ownLive(child.dispatch);
    const snapshot = new Map(registered);
    const gate = child.gate!;
    child.gate = undefined;
    gate.resolve(rand() < 0.05 ? undefined : child.session);
    await drain();
    const [first, ...rest] = child.waiting;
    for (const w of child.waiting) {
      expect(w.result, `${child.id} unresolved`).toBeDefined();
      check(child, w.result!, w.max, live, snapshot);
    }
    for (const w of rest) {
      expect(w.result!.kind).toBe(first!.result!.kind);
      expect(w.result!.candidates).toEqual(first!.result!.candidates);
    }
    const clean = child.carriesOwn && !child.injected;
    if (clean && live && !child.decided && !nonceless && first!.result!.grant.notes[1] !== BINDING_NOTES.lookupFailed) {
      stats.cleanLive++;
      if (first!.result!.kind === "exact") {
        expect(first!.result!.candidates).toEqual([child.dispatch.callID]);
        stats.cleanExact++;
      }
    }
    child.snapshot = snapshot;
    child.waiting = [];
    child.decided = true;
  };

  const rebind = async () => {
    const decided = children.filter((c) => c.decided && c.gate === undefined);
    if (decided.length === 0) return;
    const child = pick(decided);
    const live = ownLive(child.dispatch);
    let looked = false;
    const got = await bind(child.id, async () => { looked = true; return child.session; }, { maxOf: () => MAX[child.dispatch.agent] });
    if (looked) child.snapshot = new Map(registered); // a re-decision is judged against today's registrations
    check(child, got, MAX[child.dispatch.agent]!, live, child.snapshot);
  };

  const widenSome = () => {
    const decided = children.filter((c) => c.decided);
    if (decided.length === 0) return;
    const child = pick(decided);
    const max = MAX[child.dispatch.agent]!;
    const asked = subset(ALL, 0.3);
    const g = widen(child.id, asked, max);
    for (const a of asked) if (max.includes(a)) child.widened.add(a);
    for (const a of g.actions) expect(max.includes(a)).toBe(true);
    stats.widened++;
  };

  const ladder = () => {
    const decided = children.filter((c) => c.decided && c.dispatch.agent !== "researcher");
    if (decided.length === 0) return;
    const child = pick(decided);
    const deps: authority.AuthorityDeps = {
      roleOf: () => SPECS.get(child.dispatch.agent),
      dispatchOf: () => ({ parentSessionID: child.dispatch.parent, callID: child.dispatch.callID }),
      roles: () => SPECS,
    };
    const result = authority.requestAuthority(child.id, { actions: subset(ALL, 0.3), reason: "need" }, deps);
    for (const a of result.recorded) child.widened.add(a);
    if (rand() < 0.8) authority.markAnnotated(child.id, child.dispatch.callID);
    const consumed = authority.consumeAuthority(child.id, deps, { afterCall: rand() < 0.9 ? child.dispatch.callID : "call_other" });
    if (consumed) for (const a of consumed.grant.actions) expect(MAX[child.dispatch.agent]!.includes(a)).toBe(true);
  };

  for (let step = 0; step < steps; step++) {
    const roll = rand();
    if (roll < 0.22 || dispatches.length === 0) register();
    else if (roll < 0.42) spawn();
    else if (roll < 0.62) await release();
    else if (roll < 0.72) {
      const live = dispatches.filter((d) => d.live);
      if (live.length > 0) {
        const d = pick(live);
        d.live = false;
        evictCall(d.parent, d.callID);
      }
    } else if (roll < 0.74) {
      const slot = pick(["p1", "p2"]);
      const parent = parentOf(slot);
      for (const d of dispatches) if (d.parent === parent) d.live = false;
      evict(parent);
      generation[slot]!++;
    } else if (roll < 0.76) {
      const decided = children.filter((c) => c.decided);
      if (decided.length > 0) evict(pick(decided).id);
    } else if (roll < 0.8) {
      const decided = children.filter((c) => c.decided);
      if (decided.length > 0) dropBindingCacheForTests(pick(decided).id);
    } else if (roll < 0.86) await rebind();
    else if (roll < 0.9) widenSome();
    else if (roll < 0.94) ladder();
    else clock += rand() < 0.1 ? PENDING_TTL_MS : 1_000 + Math.floor(rand() * 120_000);
  }
  for (const child of children) child.gate?.resolve(undefined);
  await drain();
}

describe("property: binding ambiguity never widens authority (I5)", () => {
  it("holds over random interleavings: markers, forgeries, disagreement, cache loss, call-id reuse, widening", async () => {
    const stats: Stats = { checked: 0, exact: 0, intersection: 0, unknown: 0, cleanLive: 0, cleanExact: 0, widened: 0, residual: 0 };
    for (let seed = 1; seed <= 400; seed++) {
      resetBindingRegistryForTests();
      authority.resetAuthorityForTests();
      await runInterleaving(seed, 90, stats, seed % 2 === 0);
    }
    expect(stats.checked).toBeGreaterThan(2000);
    expect(stats.exact).toBeGreaterThan(200);
    expect(stats.intersection).toBeGreaterThan(20);
    expect(stats.unknown).toBeGreaterThan(200);
    expect(stats.widened).toBeGreaterThan(100);
    // Non-vacuity: a clean child of a pending dispatch binds exactly (only a planted-marker theft can stop it).
    expect(stats.cleanLive).toBeGreaterThan(100);
    expect(stats.cleanExact / stats.cleanLive).toBeGreaterThan(0.9);
    // The unguaranteed cases stay a small share; they exist because the generator also plants markers in
    // marker-less children and runs the nonce-less counting fallback after a child's own dispatch ended.
    // Half the seeds run the nonce-less fallback, which dominates this share.
    expect(stats.residual).toBeGreaterThan(0);
    expect(stats.residual).toBeLessThan(stats.checked / 5);
  }, 120_000);
});

it("LOCAL_ACTIONS is the local class", () => {
  expect(LOCAL_ACTIONS).toEqual(LOCAL);
});
