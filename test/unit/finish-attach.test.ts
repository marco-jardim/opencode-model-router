/**
 * Phase 2.1 (task 2.1.8): the finish attach channel of the legacy plugin (src/index.ts). The v2 adapter calls it once at setup
 * to obtain the finish API; on Claude Code v1 nothing calls it and the hooks object is unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Hooks } from "@opencode-ai/plugin";
import ModelRouterPlugin from "../../src/index";
import { ADOPTION_REFUSED, isAdoptionRefused, ROUTER_FINISH_ATTACH, type FinishApi, type FinishAttach, type HeldSink, type PersistedRecord } from "../../src/compat/background";
import { invalidateConfigCache } from "../../src/router/config";
import { CLAIM_REFRESH_MS, CLAIM_STALE_MS, claimPendingSession, MAX_ENTRIES_PER_SESSION } from "../../src/verify/pending";
import { removeDirWhenReleased } from "../helpers/remove-dir";

vi.mock("../../src/verify/reference", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/verify/reference")>()),
  gcStaleReferences: async () => ({ removed: [], kept: [], failed: [] }),
}));

const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
let home = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "omr-finish-attach-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  invalidateConfigCache();
});

afterEach(async () => {
  for (const key of ["HOME", "USERPROFILE"] as const) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  invalidateConfigCache();
  await removeDirWhenReleased(home);
});

async function load(host: "v1" | "v2"): Promise<Hooks> {
  return ModelRouterPlugin({
    directory: home,
    worktree: home,
    project: {},
    serverUrl: new URL("http://localhost"),
    $: () => undefined,
    ...(host === "v2" ? { routerHost: "v2" } : {}),
    client: { session: { get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id } }) } },
  } as unknown as Parameters<typeof ModelRouterPlugin>[0]);
}

function attachOf(hooks: Hooks): FinishAttach {
  const attach: unknown = Reflect.get(hooks, ROUTER_FINISH_ATTACH);
  if (typeof attach !== "function") throw new Error("the plugin exposes no finish attach channel");
  return (deps) => attach(deps) as FinishApi | undefined;
}

const sink: HeldSink = { verdict: async () => undefined };

/** The call ids of the adopted `inflight` records; undefined for "nothing to adopt", "refused" for a refusal (QA-2.1-34). */
function adoptedCallIDs(result: ReturnType<FinishApi["adopt"]>): unknown[] | "refused" | undefined {
  if (result === undefined) return undefined;
  if (isAdoptionRefused(result)) return "refused";
  return result.inflight.map((r) => r.callID);
}

describe("finish attach channel", () => {
  it("is the registered symbol router.finishDispatch.attach", () => {
    expect(ROUTER_FINISH_ATTACH).toBe(Symbol.for("router.finishDispatch.attach"));
  });

  it("on v2 is a non-enumerable, non-writable property that never shows up in the hooks' keys or a copy", async () => {
    const hooks = await load("v2");
    const descriptor = Object.getOwnPropertyDescriptor(hooks, ROUTER_FINISH_ATTACH);
    expect(descriptor).toBeDefined();
    expect(descriptor?.enumerable).toBe(false);
    expect(descriptor?.writable).toBe(false);
    expect(Object.getOwnPropertySymbols(Object.assign({}, hooks))).not.toContain(ROUTER_FINISH_ATTACH);
  });

  it("on v1 the channel does not exist: the hooks object is exactly the legacy one", async () => {
    const hooks = await load("v1");
    expect(Object.getOwnPropertyDescriptor(hooks, ROUTER_FINISH_ATTACH)).toBeUndefined();
    expect(Reflect.get(hooks, ROUTER_FINISH_ATTACH)).toBeUndefined();
    expect(Object.getOwnPropertySymbols(hooks)).not.toContain(ROUTER_FINISH_ATTACH);
    expect(Object.keys(hooks)).not.toContain("finish");
  });

  it("on v2 returns the finish API with every member the adapter uses", async () => {
    const api = attachOf(await load("v2"))({ host: "v2", held: sink });
    if (api === undefined) throw new Error("v2 attach returned no finish API");
    for (const member of [
      "verificationFor", "canHold", "reserveHeld", "releaseHeld", "finish", "reload", "adopt",
      // Round 2: QA-2.1-16, QA-2.1-21, QA-2.1-31, QA-2.1-17.
      "recreateJournal", "idle", "settleHeldDirect", "dispatchOf",
    ] as const) {
      expect(typeof api[member], member).toBe("function");
    }
    expect(typeof api.journal.append).toBe("function");
    expect(typeof api.journal.hasProcessed).toBe("function");
    expect(typeof api.captureDelta).toBe("function");
    // Nothing runs yet: idle at once; an unknown call has no dispatch data; an unknown handle is ignored.
    await expect(api.idle()).resolves.toBeUndefined();
    expect(api.dispatchOf("never-seen")).toBeUndefined();
    expect(() => api.settleHeldDirect("ses_parent", "vrf_000000000000000000000000", { verdict: "PASS" })).not.toThrow();
  });

  it("QA-2.1-27: the journal reloads with the configured enforcement.verify.pendingTtlMs, not the 1 h default", async () => {
    const savedXdg = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(home, ".local", "state");
    try {
      const { overridePath } = await import("../../src/router/config");
      mkdirSync(dirname(overridePath()), { recursive: true });
      writeFileSync(overridePath(), JSON.stringify({ enforcement: { verify: { pendingTtlMs: 4 * 3_600_000 } } }), "utf-8");
      invalidateConfigCache();
      // An in-flight record two hours old: past the default TTL, within the configured one.
      const journal = join(home, ".local", "state", "opencode-model-router", "pending.jsonl");
      mkdirSync(dirname(journal), { recursive: true });
      const at = Date.now() - 2 * 3_600_000;
      writeFileSync(journal, `${JSON.stringify({ v: 1, kind: "inflight", key: "k-ttl\u0000c-ttl", callID: "c-ttl", parentSessionID: "ses_ttl", childSessionID: "k-ttl", at })}\n`);
      const api = attachOf(await load("v2"))({ host: "v2", held: sink });
      if (api === undefined) throw new Error("no finish API");
      await api.reload();
      expect(adoptedCallIDs(api.adopt("ses_ttl"))).toEqual(["c-ttl"]);
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = savedXdg;
    }
  });

  it("QA-2.1-19: two plugin instances of one process: the live owner's first inflight write claims the session; the other never adopts it while the owner lives, and keeps the records", async () => {
    const savedXdg = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(home, ".local", "state");
    try {
      const ownerHooks = await load("v2");
      const owner = attachOf(ownerHooks)({ host: "v2", held: sink });
      if (owner === undefined) throw new Error("no finish API");
      await owner.journal.append({
        v: 1, kind: "inflight", key: "k-two\u0000c-two", callID: "c-two", parentSessionID: "ses_two", childSessionID: "k-two", at: Date.now(),
      }, { fsync: true });
      const claim = join(home, ".local", "state", "opencode-model-router", "pending.claims", "ses_two");
      expect(existsSync(claim)).toBe(true);
      const otherHooks = await load("v2");
      const other = attachOf(otherHooks)({ host: "v2", held: sink });
      if (other === undefined) throw new Error("no finish API");
      await other.reload();
      // Same pid, another live instance token: refused (QA-2.1-34: told apart from "nothing to adopt"), and the dormant
      // records stay for a later adoption.
      expect(other.adopt("ses_two")).toBe(ADOPTION_REFUSED);
      expect(other.adopt("ses_two")).toBe(ADOPTION_REFUSED);
      // The owner disposes (its claims and its token go): now the other instance adopts the very same records.
      await (ownerHooks as { dispose?: () => Promise<void> }).dispose?.();
      expect(adoptedCallIDs(other.adopt("ses_two"))).toEqual(["c-two"]);
      // Handed over once.
      expect(other.adopt("ses_two")).toBeUndefined();
      await (otherHooks as { dispose?: () => Promise<void> }).dispose?.();
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = savedXdg;
    }
  });

  it("DF-1-10 two plugin instances in separately loaded module copies of one process: the second never adopts the live owner's session; it does once the owner disposes", async () => {
    const savedXdg = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(home, ".local", "state");
    try {
      const ownerHooks = await load("v2");
      const owner = attachOf(ownerHooks)({ host: "v2", held: sink });
      if (owner === undefined) throw new Error("no finish API");
      await owner.journal.append({
        v: 1, kind: "inflight", key: "k-copy\u0000c-copy", callID: "c-copy", parentSessionID: "ses_copy", childSessionID: "k-copy", at: Date.now(),
      }, { fsync: true });
      // A second booted location: the host loads the plugin module again (own module-level state, own live-token set).
      vi.resetModules();
      const copy = await import("../../src/index");
      const otherHooks = await copy.default({
        directory: home, worktree: home, project: {}, serverUrl: new URL("http://localhost"), $: () => undefined, routerHost: "v2",
        client: { session: { get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id } }) } },
      } as unknown as Parameters<typeof ModelRouterPlugin>[0]);
      const other = attachOf(otherHooks)({ host: "v2", held: sink });
      if (other === undefined) throw new Error("no finish API");
      await other.reload();
      // The owner's beat file marks it live to the other copy: refused, and the records stay dormant. The refusal is the
      // copy's own sentinel (a separately loaded module), so it is checked with the shared predicate, not by identity.
      expect(isAdoptionRefused(other.adopt("ses_copy"))).toBe(true);
      expect(isAdoptionRefused(other.adopt("ses_copy"))).toBe(true);
      // The owner disposes (claims released, beat removed): restart recovery still takes the very same records over.
      await (ownerHooks as { dispose?: () => Promise<void> }).dispose?.();
      expect(adoptedCallIDs(other.adopt("ses_copy"))).toEqual(["c-copy"]);
      await (otherHooks as { dispose?: () => Promise<void> }).dispose?.();
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = savedXdg;
    }
  });

  it("QA-2.1-34: a claim of another live pid is refused while fresh and taken over once older than CLAIM_STALE_MS (a reused pid never refreshes it)", async () => {
    const savedXdg = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(home, ".local", "state");
    try {
      const stateDir = join(home, ".local", "state", "opencode-model-router");
      mkdirSync(join(stateDir, "pending.claims"), { recursive: true });
      writeFileSync(join(stateDir, "pending.jsonl"), `${JSON.stringify({
        v: 1, kind: "inflight", key: "k-reused\u0000c-reused", callID: "c-reused", parentSessionID: "ses_reused", childSessionID: "k-reused", at: Date.now(),
      })}\n`);
      // The crashed owner's claim; its pid now belongs to a live, unrelated process (the parent of this one).
      const claim = join(stateDir, "pending.claims", "ses_reused");
      writeFileSync(claim, `${JSON.stringify({ pid: process.ppid, token: "crashed-owner", at: Date.now() })}\n`);
      const hooks = await load("v2");
      const api = attachOf(hooks)({ host: "v2", held: sink });
      if (api === undefined) throw new Error("no finish API");
      await api.reload();
      // Fresh: a distinct refusal (not "nothing to adopt"), and the records stay dormant.
      expect(api.adopt("ses_reused")).toBe(ADOPTION_REFUSED);
      expect(api.adopt("ses_nothing")).toBeUndefined();
      // Nobody re-stamped it for longer than the stale age: the retry takes it over and adopts the very same records.
      writeFileSync(claim, `${JSON.stringify({ pid: process.ppid, token: "crashed-owner", at: Date.now() - CLAIM_STALE_MS - 1_000 })}\n`);
      expect(adoptedCallIDs(api.adopt("ses_reused"))).toEqual(["c-reused"]);
      expect(JSON.parse(readFileSync(claim, "utf8"))).toMatchObject({ pid: process.pid });
      await (hooks as { dispose?: () => Promise<void> }).dispose?.();
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = savedXdg;
    }
  });

  it("QA-2.1-34: the live owner re-stamps its claim every CLAIM_REFRESH_MS (fake clock), so it never goes stale; dispose gives it back", async () => {
    const savedXdg = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(home, ".local", "state");
    try {
      const claimsDir = join(home, ".local", "state", "opencode-model-router", "pending.claims");
      const claim = join(claimsDir, "ses_fresh");
      const hooks = await load("v2");
      const owner = attachOf(hooks)({ host: "v2", held: sink });
      if (owner === undefined) throw new Error("no finish API");
      const t0 = Date.now();
      // Only the clock and the interval timers are faked: the journal's file I/O stays real.
      vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], now: t0 });
      try {
        await owner.journal.append({
          v: 1, kind: "inflight", key: "k-fresh\u0000c-fresh", callID: "c-fresh", parentSessionID: "ses_fresh", childSessionID: "k-fresh", at: t0,
        }, { fsync: true });
        const stampedAt = (): unknown => (JSON.parse(readFileSync(claim, "utf8")) as { at?: unknown }).at;
        expect(stampedAt()).toBe(t0);
        vi.advanceTimersByTime(CLAIM_REFRESH_MS - 1);
        expect(stampedAt()).toBe(t0);
        vi.advanceTimersByTime(1);
        expect(stampedAt()).toBe(t0 + CLAIM_REFRESH_MS);
        // Three stale ages later the claim is as fresh as the last refresh: another live process is still refused.
        vi.advanceTimersByTime(3 * CLAIM_STALE_MS - CLAIM_REFRESH_MS);
        expect(stampedAt()).toBe(t0 + 3 * CLAIM_STALE_MS);
        expect(claimPendingSession(claimsDir, "ses_fresh", { pid: process.ppid, now: Date.now() + 1, isAlive: () => true, token: "other-process" })).toBe(false);
      } finally {
        vi.useRealTimers();
      }
      await (hooks as { dispose?: () => Promise<void> }).dispose?.();
      expect(existsSync(claim)).toBe(false);
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = savedXdg;
    }
  });

  it("QA-2.1-33: two plugin instances on one journal: one instance's recreate writes the other's live records too, each once", async () => {
    const savedXdg = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(home, ".local", "state");
    try {
      const journalPath = join(home, ".local", "state", "opencode-model-router", "pending.jsonl");
      const inflight = (id: string): PersistedRecord => ({
        v: 1, kind: "inflight", key: `k-${id}\u0000c-${id}`, callID: `c-${id}`, parentSessionID: `ses_${id}`, childSessionID: `k-${id}`, at: 1_000,
      });
      const aHooks = await load("v2");
      const a = attachOf(aHooks)({ host: "v2", held: sink });
      const bHooks = await load("v2");
      const b = attachOf(bHooks)({ host: "v2", held: sink });
      if (a === undefined || b === undefined) throw new Error("no finish API");
      expect(typeof a.setAdapterSnapshot).toBe("function");
      // Each adapter's live attempts (what the v2 adapter registers at attach).
      a.setAdapterSnapshot?.(() => [inflight("a")]);
      b.setAdapterSnapshot?.(() => [inflight("b")]);
      await a.journal.append(inflight("a"), { fsync: true });
      await b.journal.append(inflight("b"), { fsync: true });
      rmSync(journalPath);
      // Only the first instance notices and recreates, from its own memory.
      await a.recreateJournal([inflight("a")]);
      const callIDs = readFileSync(journalPath, "utf8").split("\n").filter((l) => l !== "").map((l) => (JSON.parse(l) as PersistedRecord).callID);
      expect([...callIDs].sort()).toEqual(["c-a", "c-b"]);
      await (aHooks as { dispose?: () => Promise<void> }).dispose?.();
      await (bHooks as { dispose?: () => Promise<void> }).dispose?.();
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = savedXdg;
    }
  });

  it("on v2 an unknown call has no verification and a session without a pending slot problem can hold", async () => {
    const api = attachOf(await load("v2"))({ host: "v2", held: sink });
    expect(api?.verificationFor("never-seen")).toBeUndefined();
    expect(api?.canHold("ses_parent")).toBe(true);
    const handle = api?.reserveHeld("ses_parent", "call-1");
    expect(handle).toMatch(/^vrf_[0-9a-f]{24}$/);
  });

  it("QA-2.1-14: on v2 releaseHeld gives a reservation back at once: the session's slots are free again", async () => {
    const api = attachOf(await load("v2"))({ host: "v2", held: sink });
    if (api === undefined) throw new Error("v2 attach returned no finish API");
    const handles: string[] = [];
    for (let i = 0; i < MAX_ENTRIES_PER_SESSION; i += 1) {
      const handle = api.reserveHeld("ses_release", `call-${i}`);
      if (handle === undefined) throw new Error(`reservation ${i} refused`);
      handles.push(handle);
    }
    // Every slot of the session is reserved: no further hold until one is given back.
    expect(api.canHold("ses_release")).toBe(false);
    expect(api.reserveHeld("ses_release", "call-full")).toBeUndefined();
    for (const handle of handles) api.releaseHeld(handle);
    const first = handles[0];
    if (first !== undefined) api.releaseHeld(first); // idempotent
    expect(api.canHold("ses_release")).toBe(true);
    expect(api.reserveHeld("ses_release", "call-again")).toMatch(/^vrf_[0-9a-f]{24}$/);
  });

  it("v1 is inert: one notice per process naming every configured v2-only key (QA-2.1-12), no finish channel, no journal file", async () => {
    vi.resetModules();
    const config = await import("../../src/router/config");
    const fresh = await import("../../src/index");
    mkdirSync(dirname(config.overridePath()), { recursive: true });
    writeFileSync(
      config.overridePath(),
      JSON.stringify({ routing: { background: { mode: "auto", minPredictedMs: 1000 }, leases: { mode: "enforce", run: "refuse" } } }),
      "utf-8",
    );
    config.invalidateConfigCache();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const boot = () => fresh.default({
        directory: home, worktree: home, project: {}, serverUrl: new URL("http://localhost"), $: () => undefined,
        client: { session: { get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id } }) } },
      } as unknown as Parameters<typeof ModelRouterPlugin>[0]);
      const first = await boot();
      // QA-2.1-32: "requires" for one feature, "require" for leases or for both.
      const notices = () => warn.mock.calls.map((c) => c.join(" ")).filter((line) => /\brequires? OpenCode v2; ignored/.test(line));
      const afterFirst = notices();
      // AGENTS.md: a v2-only feature logs at most one notice per process on v1, whatever the number of keys.
      expect(afterFirst).toHaveLength(1);
      for (const key of ["routing.background.mode", "routing.background.minPredictedMs", "routing.leases.mode", "routing.leases.run"]) {
        expect(afterFirst[0]).toContain(key);
      }
      // QA-2.1-32: the notice names both configured features.
      expect(afterFirst[0]).toContain("[router] background dispatch and leases require OpenCode v2; ignored: ");
      expect(Reflect.get(first, ROUTER_FINISH_ATTACH)).toBeUndefined();
      await boot(); // a second plugin instance of the same process says nothing more
      expect(notices()).toEqual(afterFirst);
      expect(existsSync(join(home, "outcomes", "pending.jsonl"))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it("QA-2.1-32: on v1 with only routing.leases.* set, the one notice speaks of leases, not of background dispatch", async () => {
    vi.resetModules();
    const config = await import("../../src/router/config");
    const fresh = await import("../../src/index");
    mkdirSync(dirname(config.overridePath()), { recursive: true });
    writeFileSync(config.overridePath(), JSON.stringify({ routing: { leases: { mode: "off" } } }), "utf-8");
    config.invalidateConfigCache();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const boot = () => fresh.default({
        directory: home, worktree: home, project: {}, serverUrl: new URL("http://localhost"), $: () => undefined,
        client: { session: { get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id } }) } },
      } as unknown as Parameters<typeof ModelRouterPlugin>[0]);
      await boot();
      await boot();
      const notices = warn.mock.calls.map((c) => c.join(" ")).filter((line) => line.includes("OpenCode v2; ignored"));
      expect(notices).toEqual([expect.stringContaining("[router] leases require OpenCode v2; ignored: routing.leases.mode")]);
      expect(notices[0]).not.toContain("background dispatch");
    } finally {
      warn.mockRestore();
    }
  });

  it("on v1 with only routing.executor.* set, the one notice names the plan executor, not background dispatch", async () => {
    vi.resetModules();
    const config = await import("../../src/router/config");
    const fresh = await import("../../src/index");
    mkdirSync(dirname(config.overridePath()), { recursive: true });
    writeFileSync(config.overridePath(), JSON.stringify({ routing: { executor: { approve: "auto" } } }), "utf-8");
    config.invalidateConfigCache();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const boot = () => fresh.default({
        directory: home, worktree: home, project: {}, serverUrl: new URL("http://localhost"), $: () => undefined,
        client: { session: { get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id } }) } },
      } as unknown as Parameters<typeof ModelRouterPlugin>[0]);
      await boot();
      await boot();
      const notices = warn.mock.calls.map((c) => c.join(" ")).filter((line) => line.includes("OpenCode v2; ignored"));
      expect(notices).toEqual([expect.stringContaining("[router] the plan executor requires OpenCode v2; ignored: routing.executor.approve")]);
      expect(notices[0]).not.toContain("background dispatch");
    } finally {
      warn.mockRestore();
    }
  });

  it("on v1 with executor and background keys, the one notice names both features and lists every key", async () => {
    vi.resetModules();
    const config = await import("../../src/router/config");
    const fresh = await import("../../src/index");
    mkdirSync(dirname(config.overridePath()), { recursive: true });
    writeFileSync(
      config.overridePath(),
      JSON.stringify({ routing: { background: { mode: "auto" }, executor: { approve: "auto" } } }),
      "utf-8",
    );
    config.invalidateConfigCache();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await fresh.default({
        directory: home, worktree: home, project: {}, serverUrl: new URL("http://localhost"), $: () => undefined,
        client: { session: { get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id } }) } },
      } as unknown as Parameters<typeof ModelRouterPlugin>[0]);
      const notices = warn.mock.calls.map((c) => c.join(" ")).filter((line) => line.includes("OpenCode v2; ignored"));
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain("[router] background dispatch and the plan executor require OpenCode v2; ignored: ");
      expect(notices[0]).toContain("routing.background.mode");
      expect(notices[0]).toContain("routing.executor.approve");
    } finally {
      warn.mockRestore();
    }
  });

  it("on v2 the journal accepts appends and has processed nothing yet", async () => {
    const api = attachOf(await load("v2"))({ host: "v2", held: sink });
    if (api === undefined) throw new Error("no finish API");
    expect(api.journal.hasProcessed("ses_c\u0000call")).toBe(false);
    await expect(api.journal.append({ v: 1, kind: "forget", session: "ses_x", at: 1 })).resolves.toBeUndefined();
  });
});
