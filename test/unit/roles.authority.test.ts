import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthorityAction, RoleKind, RoleSpec } from "../../src/router/roles";
import * as authority from "../../src/routing/roles/authority";
import {
  AUTHORITY_REQUESTS_MAX,
  AUTHORITY_TEXT,
  AUTHORITY_TOOL_NAME,
  authorityTool,
  consumeAuthority,
  evictAuthority,
  requestAuthority,
  requestedAuthority,
  resetAuthorityForTests,
  roleFor,
  roleMax,
  type AuthorityDeps,
} from "../../src/routing/roles/authority";
import {
  BINDING_NOTES,
  bind,
  currentBinding,
  evict,
  registerPending,
  resetBindingRegistryForTests,
  type Binding,
  type SessionLookup,
} from "../../src/routing/roles/binding";
import type { DispatchGrant } from "../../src/routing/roles/policy";

const PARENT = "ses_parent";
const ROOT = "D:\\git\\omr-rta-p16";
const LOCAL: AuthorityAction[] = ["read", "glob", "grep", "router_git"];
const ALL: AuthorityAction[] = [...LOCAL, "router_run", "edit", "webfetch", "websearch", "context7", "execute"];

function spec(agent: string, kind: RoleKind, mode: "fixed" | "dynamic", allow: AuthorityAction[], extra: Partial<RoleSpec> = {}): RoleSpec {
  return {
    agent, kind, description: agent, prompt: agent,
    authority: { mode, allow, deny: ALL.filter((a) => !allow.includes(a)) },
    tierRange: { floor: "fast", ceiling: "heavy" }, assurance: "none", guard: "producer", budget: {}, enabled: true,
    ...extra,
  };
}

const EXPLORER = spec("explorer", "explore", "fixed", LOCAL);
const RESEARCHER = spec("researcher", "research", "fixed", ["webfetch", "websearch", "context7"]);
const RUNNER = spec("runner", "run", "fixed", [...LOCAL, "router_run"]);
const IMPLEMENTER = spec("implementer", "implement", "dynamic", [...LOCAL, "edit", "router_run"]);
const GENERAL = spec("general", "general", "dynamic", [...LOCAL, "edit", "router_run"]);
const ROLES = new Map<string, RoleSpec>([EXPLORER, RESEARCHER, RUNNER, IMPLEMENTER, GENERAL].map((r) => [r.agent, r]));

beforeEach(() => {
  resetBindingRegistryForTests();
  resetAuthorityForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function grant(actions: AuthorityAction[], workRoot: string | null = ROOT): DispatchGrant {
  return { actions: new Set(actions), notes: [], workRoot };
}

/** Registers one dispatch and binds `child` to it through binding.ts. */
async function bound(child: string, role: RoleSpec, g: DispatchGrant | null): Promise<Binding> {
  if (g !== null) {
    registerPending({
      parentSessionID: PARENT, callID: `call_${child}`, agent: role.agent, description: "task", nonce: `call_${child}`,
      grant: g, budget: 80, decisionID: null, registeredAt: Date.now(),
    });
  }
  const lookup: SessionLookup = async () => ({ parentID: PARENT, agent: role.agent, title: `task [nonce call_${child}]` });
  return bind(child, lookup, { localFallback: () => roleMax(role) });
}

function deps(roleByChild: Record<string, RoleSpec | undefined>, extra: Partial<AuthorityDeps> = {}): AuthorityDeps {
  return { roleOf: (child) => roleByChild[child], roles: () => ROLES, ...extra };
}

describe("requestAuthority", () => {
  it("inside the role max: recorded, and the child is told to stop with ESCALATE: authority", async () => {
    await bound("ses_i", IMPLEMENTER, grant(LOCAL));
    const result = requestAuthority("ses_i", { actions: ["edit"], reason: "the fix needs a file change" }, deps({ ses_i: IMPLEMENTER }));
    expect(result).toMatchObject({ status: "recorded", recorded: ["edit"], granted: [], refused: [], replay: false });
    expect(result.text).toBe(
      "Authority request recorded: edit. Stop now and return `ESCALATE: authority` naming edit and why; the parent resumes this task with the wider grant.",
    );
    expect(requestedAuthority("ses_i")).toEqual({ actions: ["edit"], reasons: ["the fix needs a file change"] });
  });

  it("a replay is idempotent; a wider request adds to the record", async () => {
    await bound("ses_i", IMPLEMENTER, grant(LOCAL));
    const d = deps({ ses_i: IMPLEMENTER });
    const first = requestAuthority("ses_i", { actions: ["edit"], reason: "why" }, d);
    const again = requestAuthority("ses_i", { actions: ["edit", "edit"], reason: "a different reason" }, d);
    expect(again).toEqual({ ...first, replay: true });
    expect(requestedAuthority("ses_i")).toEqual({ actions: ["edit"], reasons: ["why"] });
    const wider = requestAuthority("ses_i", { actions: ["router_run", "edit"], reason: "  run   the tests  " }, d);
    expect(wider).toMatchObject({ status: "recorded", recorded: ["router_run", "edit"], replay: false });
    expect(requestedAuthority("ses_i")).toEqual({ actions: ["router_run", "edit"], reasons: ["why", "run the tests"] });
    expect(requestAuthority("ses_i", { actions: ["router_run", "edit"], reason: "x" }, d)).toEqual({ ...wider, replay: true });
  });

  it("outside the role max: refused naming the right role, nothing recorded", async () => {
    await bound("ses_i", IMPLEMENTER, grant(LOCAL));
    const result = requestAuthority("ses_i", { actions: ["webfetch", "context7"], reason: "docs" }, deps({ ses_i: IMPLEMENTER }));
    expect(result.status).toBe("refused");
    expect(result.refused).toEqual([
      { action: "webfetch", reason: AUTHORITY_TEXT.outside("implementer", "researcher") },
      { action: "context7", reason: AUTHORITY_TEXT.outside("implementer", "researcher") },
    ]);
    expect(result.text).toContain("dispatch `researcher` for it");
    expect(result.text).toContain("Nothing was recorded; do not repeat this request.");
    expect(requestedAuthority("ses_i")).toBeUndefined();
    const noResearcher = new Map(ROLES);
    noResearcher.set("researcher", { ...RESEARCHER, enabled: false });
    const lone = requestAuthority("ses_i", { actions: ["websearch"], reason: "x" }, deps({ ses_i: IMPLEMENTER }, { roles: () => noResearcher }));
    expect(lone.refused).toEqual([{ action: "websearch", reason: AUTHORITY_TEXT.outside("implementer", undefined) }]);
    const noRoles = requestAuthority("ses_i", { actions: ["webfetch"], reason: "x" }, { roleOf: () => IMPLEMENTER });
    expect(noRoles.refused[0]!.reason).toBe(AUTHORITY_TEXT.outside("implementer", "researcher"));
  });

  it("a mixed request records the inside part and refuses the rest", async () => {
    await bound("ses_g", GENERAL, grant(LOCAL));
    const result = requestAuthority("ses_g", { actions: ["websearch", "edit", "read"], reason: "x" }, deps({ ses_g: GENERAL }));
    expect(result).toMatchObject({ status: "recorded", recorded: ["edit"], granted: ["read"] });
    expect(result.refused).toEqual([{ action: "websearch", reason: AUTHORITY_TEXT.outside("general", "researcher") }]);
    expect(result.text).toBe(
      "Authority request recorded: edit. Stop now and return `ESCALATE: authority` naming edit and why; the parent resumes this task with the wider grant."
        + " Already granted: read."
        + ` Refused: websearch (${AUTHORITY_TEXT.outside("general", "researcher")}).`,
    );
  });

  it("a fixed role is refused (never widened), naming the role that has the action", async () => {
    await bound("ses_e", EXPLORER, null); // unknown binding: max ∩ local
    const d = deps({ ses_e: EXPLORER, ses_r: RUNNER });
    const edit = requestAuthority("ses_e", { actions: ["edit", "router_run"], reason: "x" }, d);
    expect(edit.status).toBe("refused");
    expect(edit.refused).toEqual([
      { action: "router_run", reason: AUTHORITY_TEXT.outside("explorer", "runner") },
      { action: "edit", reason: AUTHORITY_TEXT.outside("explorer", "implementer") },
    ]);
    await bound("ses_r", RUNNER, null);
    const run = requestAuthority("ses_r", { actions: ["router_run"], reason: "x" }, d);
    expect(run.refused).toEqual([{ action: "router_run", reason: AUTHORITY_TEXT.fixed("runner") }]);
    expect(requestedAuthority("ses_r")).toBeUndefined();
    const has = requestAuthority("ses_e", { actions: ["read"], reason: "x" }, d);
    expect(has).toMatchObject({ status: "granted", granted: ["read"], refused: [] });
    expect(has.text).toBe("Already granted: read. Continue with your current grant.");
  });

  it("execute is never requestable, even when a custom role lists it", async () => {
    const custom = spec("custom", "general", "dynamic", [...LOCAL, "execute"]);
    await bound("ses_c", custom, grant(LOCAL));
    const result = requestAuthority("ses_c", { actions: ["execute"], reason: "x" }, deps({ ses_c: custom }));
    expect(result.refused).toEqual([{ action: "execute", reason: AUTHORITY_TEXT.execute }]);
    expect(requestedAuthority("ses_c")).toBeUndefined();
  });

  it("a session that is not a role child is refused", () => {
    const result = requestAuthority("ses_x", { actions: ["edit", "nope"], reason: "x" }, deps({}));
    expect(result.status).toBe("refused");
    expect(result.refused).toEqual([
      { action: "nope", reason: AUTHORITY_TEXT.unknown },
      { action: "edit", reason: AUTHORITY_TEXT.notRole },
    ]);
  });

  it("router_run needs a bound work root: refused for an unknown or unbound child, recorded with a root", async () => {
    await bound("ses_u", IMPLEMENTER, null);
    expect(currentBinding("ses_u")?.kind).toBe("unknown");
    const d = deps({ ses_u: IMPLEMENTER, ses_none: IMPLEMENTER, ses_ok: IMPLEMENTER });
    expect(requestAuthority("ses_u", { actions: ["router_run"], reason: "x" }, d).refused)
      .toEqual([{ action: "router_run", reason: AUTHORITY_TEXT.noWorkRoot }]);
    expect(requestAuthority("ses_none", { actions: ["router_run", "edit"], reason: "x" }, d))
      .toMatchObject({ status: "recorded", recorded: ["edit"], refused: [{ action: "router_run", reason: AUTHORITY_TEXT.noWorkRoot }] });
    await bound("ses_ok", IMPLEMENTER, grant([...LOCAL, "edit"]));
    expect(requestAuthority("ses_ok", { actions: ["router_run"], reason: "x" }, d).recorded).toEqual(["router_run"]);
  });

  it("maps aliases and refuses unknown names and raw shell", async () => {
    await bound("ses_i", IMPLEMENTER, grant(LOCAL));
    const result = requestAuthority("ses_i", {
      actions: ["write", "router_git_status", "context7_query-docs", "bash", "frobnicate", " EDIT ", "multiedit"],
      reason: "x",
    }, deps({ ses_i: IMPLEMENTER }));
    expect(result.recorded).toEqual(["edit"]);
    expect(result.granted).toEqual(["router_git"]);
    expect(result.refused).toEqual([
      { action: "bash", reason: AUTHORITY_TEXT.shell },
      { action: "frobnicate", reason: AUTHORITY_TEXT.unknown },
      { action: "context7", reason: AUTHORITY_TEXT.outside("implementer", "researcher") },
    ]);
  });

  it("keeps reasons short and few; a blank reason is not stored", async () => {
    await bound("ses_i", IMPLEMENTER, grant(LOCAL));
    const d = deps({ ses_i: IMPLEMENTER });
    requestAuthority("ses_i", { actions: ["edit"], reason: "   " }, d);
    expect(requestedAuthority("ses_i")!.reasons).toEqual([]);
    requestAuthority("ses_i", { actions: ["router_run"], reason: "y".repeat(900) }, d);
    expect(requestedAuthority("ses_i")!.reasons).toEqual(["y".repeat(500)]);
  });

  it("caps the number of reasons per child", async () => {
    const d = deps({ ses_i: IMPLEMENTER });
    await bound("ses_i", IMPLEMENTER, grant([])); // empty grant: every local action is requestable
    const asks: AuthorityAction[] = [...LOCAL, "edit", "router_run"];
    for (const [i, action] of asks.entries()) requestAuthority("ses_i", { actions: [action], reason: `r${i}` }, d);
    evict("ses_i");
    const bigger = spec("big", "general", "dynamic", [...LOCAL, "edit", "router_run", "webfetch", "websearch", "context7"]);
    await bound("ses_i", bigger, grant([], ROOT));
    const d2 = deps({ ses_i: bigger });
    for (const [i, action] of (["webfetch", "websearch", "context7"] as AuthorityAction[]).entries()) {
      requestAuthority("ses_i", { actions: [action], reason: `s${i}` }, d2);
    }
    expect(requestedAuthority("ses_i")!.reasons).toHaveLength(8);
  });

  it("bounds the children on record, oldest first", () => {
    const d: AuthorityDeps = { roleOf: () => IMPLEMENTER, bindingOf: () => undefined };
    for (let i = 0; i <= AUTHORITY_REQUESTS_MAX; i++) requestAuthority(`ses_${i}`, { actions: ["edit"], reason: "x" }, d);
    expect(requestedAuthority("ses_0")).toBeUndefined();
    expect(requestedAuthority("ses_1")).toBeDefined();
    expect(requestedAuthority(`ses_${AUTHORITY_REQUESTS_MAX}`)).toBeDefined();
  });
});

describe("consumeAuthority (resume)", () => {
  it("widens within the max, clears the record, and the resumed child keeps the wider grant", async () => {
    await bound("ses_i", IMPLEMENTER, grant(LOCAL));
    const d = deps({ ses_i: IMPLEMENTER });
    requestAuthority("ses_i", { actions: ["edit", "router_run"], reason: "x" }, d);
    evict("call_ses_i"); // the parent's call completed with ESCALATE: authority
    const consumed = consumeAuthority("ses_i", d)!;
    expect(consumed.widened).toEqual(["router_run", "edit"]);
    expect([...consumed.grant.actions]).toEqual([...LOCAL, "router_run", "edit"]);
    expect(consumed.grant.notes).toContain(BINDING_NOTES.widened(["router_run", "edit"]));
    expect(requestedAuthority("ses_i")).toBeUndefined();
    const resumed = await bind("ses_i", async () => { throw new Error("cached"); });
    expect(resumed.kind).toBe("exact");
    expect([...resumed.grant.actions]).toEqual([...LOCAL, "router_run", "edit"]);
    expect(consumeAuthority("ses_i", d)).toBeUndefined();
  });

  it("never widens beyond the current max (a narrowed role drops what it no longer allows)", async () => {
    await bound("ses_i", IMPLEMENTER, grant(LOCAL));
    requestAuthority("ses_i", { actions: ["edit"], reason: "x" }, deps({ ses_i: IMPLEMENTER }));
    const narrowed = spec("implementer", "implement", "dynamic", LOCAL);
    const consumed = consumeAuthority("ses_i", deps({ ses_i: narrowed }))!;
    expect(consumed.widened).toEqual([]);
    expect(consumed.grant.actions.has("edit")).toBe(false);
    expect(requestedAuthority("ses_i")).toBeUndefined();
  });

  it("drops the record of a child that is no longer a dynamic role; keeps it while the child is unbound", async () => {
    const d: AuthorityDeps = { roleOf: () => IMPLEMENTER, bindingOf: () => undefined };
    requestAuthority("ses_a", { actions: ["edit"], reason: "x" }, d);
    expect(consumeAuthority("ses_a", d)).toBeUndefined();
    expect(requestedAuthority("ses_a")).toBeDefined();
    expect(consumeAuthority("ses_a", { roleOf: () => EXPLORER })).toBeUndefined();
    expect(requestedAuthority("ses_a")).toBeUndefined();
    requestAuthority("ses_b", { actions: ["edit"], reason: "x" }, d);
    expect(consumeAuthority("ses_b", { roleOf: () => undefined })).toBeUndefined();
    expect(requestedAuthority("ses_b")).toBeUndefined();
    expect(consumeAuthority("ses_nothing", d)).toBeUndefined();
  });

  it("passes the role max to the injected widen", () => {
    const current: Binding = {
      childSessionID: "ses_i", kind: "exact", grant: grant(LOCAL), candidates: ["call"], decisionID: null, budget: 80,
    };
    const widen = vi.fn((_child: string, actions: readonly AuthorityAction[]) => grant([...LOCAL, ...actions]));
    const d: AuthorityDeps = { roleOf: () => IMPLEMENTER, bindingOf: () => current, widen };
    requestAuthority("ses_i", { actions: ["edit"], reason: "x" }, d);
    const consumed = consumeAuthority("ses_i", d)!;
    expect(widen).toHaveBeenCalledWith("ses_i", ["edit"], roleMax(IMPLEMENTER));
    expect(consumed.widened).toEqual(["edit"]);
  });

  it("evictAuthority drops a child's record", () => {
    const d: AuthorityDeps = { roleOf: () => IMPLEMENTER, bindingOf: () => undefined };
    requestAuthority("ses_a", { actions: ["edit"], reason: "x" }, d);
    evictAuthority("ses_a");
    expect(requestedAuthority("ses_a")).toBeUndefined();
  });
});

describe("roleMax and roleFor", () => {
  it("roleMax = allow − deny, known actions only, never execute", () => {
    const odd = spec("odd", "general", "dynamic", [...LOCAL, "execute", "edit", "bogus" as AuthorityAction]);
    expect([...roleMax({ ...odd, authority: { ...odd.authority, deny: ["edit"] } })]).toEqual(LOCAL);
  });

  it("names the preferred enabled role, else any enabled role holding the action", () => {
    expect(roleFor("webfetch")).toBe("researcher");
    expect(roleFor("edit")).toBe("implementer");
    expect(roleFor("router_run")).toBe("runner");
    expect(roleFor("read")).toBe("explorer");
    expect(roleFor("execute", ROLES)).toBeUndefined();
    const custom = new Map<string, RoleSpec>([["web", spec("web", "research", "fixed", ["websearch"])]]);
    expect(roleFor("websearch", custom)).toBe("web");
    expect(roleFor("webfetch", custom)).toBeUndefined();
    const noRunner = new Map(ROLES);
    noRunner.set("runner", { ...RUNNER, enabled: false });
    expect(roleFor("router_run", noRunner)).toBe("implementer");
  });
});

describe("router_request_authority tool", () => {
  const context = (sessionID: string) => ({
    sessionID, messageID: "msg", agent: "implementer", directory: ROOT, worktree: ROOT,
    abort: new AbortController().signal, metadata: () => undefined, ask: async () => undefined,
  });

  it("defines the tool with a strict argument schema and answers for the calling session", async () => {
    await bound("ses_i", IMPLEMENTER, grant(LOCAL));
    const t = authorityTool(deps({ ses_i: IMPLEMENTER }));
    expect(AUTHORITY_TOOL_NAME).toBe("router_request_authority");
    expect(t.description).toContain("ESCALATE: authority");
    expect(Object.keys(t.args)).toEqual(["actions", "reason"]);
    type Execute = (args: unknown, ctx: ReturnType<typeof context>) => Promise<unknown>;
    const run = (args: unknown, session = "ses_i") => (t.execute as unknown as Execute)(args, context(session));
    expect(await run({ actions: ["edit"], reason: "x" })).toMatch(/^Authority request recorded: edit\./);
    expect(requestedAuthority("ses_i")?.actions).toEqual(["edit"]);
    for (const bad of [{ actions: [], reason: "x" }, { actions: ["edit"], reason: "x", extra: 1 }, { actions: "edit", reason: "x" }, { actions: ["edit"] }]) {
      expect(String(await run(bad))).toMatch(/^\[router_request_authority\] error: /);
    }
    const throwing = authorityTool({ roleOf: () => { throw new Error("roles\nunavailable"); } });
    expect(await (throwing.execute as unknown as Execute)({ actions: ["edit"], reason: "x" }, context("ses_t")))
      .toBe("[router_request_authority] error: roles unavailable");
    const odd = authorityTool({ roleOf: () => { throw "plain"; } });
    expect(await (odd.execute as unknown as Execute)({ actions: ["edit"], reason: "x" }, context("ses_t")))
      .toBe("[router_request_authority] error: plain");
    expect(requestedAuthority("ses_t")).toBeUndefined();
  });
});

describe("process-wide state", () => {
  it("two plugin instances share one authority state", async () => {
    vi.resetModules();
    const other = await import("../../src/routing/roles/authority");
    expect(other.requestAuthority).not.toBe(authority.requestAuthority);
    const d: AuthorityDeps = { roleOf: () => IMPLEMENTER, bindingOf: () => undefined };
    authority.requestAuthority("ses_a", { actions: ["edit"], reason: "x" }, d);
    expect(other.requestedAuthority("ses_a")).toEqual({ actions: ["edit"], reasons: ["x"] });
    expect(other.requestAuthority("ses_a", { actions: ["edit"], reason: "x" }, d).replay).toBe(true);
    other.evictAuthority("ses_a");
    expect(authority.requestedAuthority("ses_a")).toBeUndefined();
  });

  it("replaces a foreign value under the state key", () => {
    Reflect.set(globalThis, Symbol.for("opencode-model-router.role-authority"), { version: 2, requests: new Map() });
    requestAuthority("ses_a", { actions: ["edit"], reason: "x" }, { roleOf: () => IMPLEMENTER, bindingOf: () => undefined });
    expect(requestedAuthority("ses_a")?.actions).toEqual(["edit"]);
    Reflect.set(globalThis, Symbol.for("opencode-model-router.role-authority"), "junk");
    expect(requestedAuthority("ses_a")).toBeUndefined();
  });
});
