/**
 * Phase 2.1 (task 2.1.8): the finish attach channel of the legacy plugin (src/index.ts). The v2 adapter calls it once at setup
 * to obtain the finish API; on Claude Code v1 nothing calls it and the hooks object is unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Hooks } from "@opencode-ai/plugin";
import ModelRouterPlugin from "../../src/index";
import { ROUTER_FINISH_ATTACH, type FinishApi, type FinishAttach, type HeldSink } from "../../src/compat/background";
import { invalidateConfigCache } from "../../src/router/config";
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
    for (const member of ["verificationFor", "canHold", "reserveHeld", "finish", "reload", "adopt"] as const) {
      expect(typeof api[member], member).toBe("function");
    }
    expect(typeof api.journal.append).toBe("function");
    expect(typeof api.journal.hasProcessed).toBe("function");
    expect(typeof api.captureDelta).toBe("function");
  });

  it("on v2 an unknown call has no verification and a session without a pending slot problem can hold", async () => {
    const api = attachOf(await load("v2"))({ host: "v2", held: sink });
    expect(api?.verificationFor("never-seen")).toBeUndefined();
    expect(api?.canHold("ses_parent")).toBe(true);
    const handle = api?.reserveHeld("ses_parent", "call-1");
    expect(handle).toMatch(/^vrf_[0-9a-f]{24}$/);
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
      const notices = () => warn.mock.calls.map((c) => c.join(" ")).filter((line) => line.includes("requires OpenCode v2; ignored"));
      const afterFirst = notices();
      // AGENTS.md: a v2-only feature logs at most one notice per process on v1, whatever the number of keys.
      expect(afterFirst).toHaveLength(1);
      for (const key of ["routing.background.mode", "routing.background.minPredictedMs", "routing.leases.mode", "routing.leases.run"]) {
        expect(afterFirst[0]).toContain(key);
      }
      expect(Reflect.get(first, ROUTER_FINISH_ATTACH)).toBeUndefined();
      await boot(); // a second plugin instance of the same process says nothing more
      expect(notices()).toEqual(afterFirst);
      expect(existsSync(join(home, "outcomes", "pending.jsonl"))).toBe(false);
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
