/**
 * DF-1-1: a plugin instance the v2 host loads in a location outside every configured `routing.workRoots` entry starts nothing
 * that runs git in that location's repository (the start-up reference GC), and says so in one info line. Without work roots
 * (and on v1) the GC starts as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ModelRouterPlugin from "../../src/index";
import { invalidateConfigCache, overridePath } from "../../src/router/config";
import { REFERENCE_GC_START_DELAY_MS } from "../../src/verify/wiring";
import { removeDirWhenReleased } from "../helpers/remove-dir";

const gc = vi.hoisted(() => vi.fn(async (root: string, deps: unknown) => {
  void root;
  void deps;
  return { removed: [], kept: [], failed: [] };
}));
vi.mock("../../src/verify/reference", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/verify/reference")>()),
  gcStaleReferences: gc,
}));

const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
let home = "";

beforeEach(() => {
  // The long form of the temp path: `routing.workRoots` drops an entry with an 8.3 short-name component.
  home = realpathSync.native(mkdtempSync(join(tmpdir(), "omr-work-roots-")));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.XDG_STATE_HOME = join(home, ".local", "state");
  gc.mockClear();
  invalidateConfigCache();
});

afterEach(async () => {
  vi.useRealTimers();
  for (const key of ["HOME", "USERPROFILE", "XDG_STATE_HOME"] as const) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  invalidateConfigCache();
  await removeDirWhenReleased(home);
});

function configure(routing: Record<string, unknown>): void {
  mkdirSync(dirname(overridePath()), { recursive: true });
  writeFileSync(overridePath(), JSON.stringify({ routing }), "utf-8");
  invalidateConfigCache();
}

async function start(directory: string, host: "v1" | "v2"): Promise<{ infos: string[]; dispose: () => Promise<void> }> {
  mkdirSync(directory, { recursive: true });
  const infos: string[] = [];
  const log = async (req: { body: { level: string; message: string } }): Promise<unknown> => {
    if (req.body.level === "info") infos.push(req.body.message);
    return {};
  };
  const hooks = await ModelRouterPlugin({
    directory,
    worktree: directory,
    project: {},
    serverUrl: new URL("http://localhost"),
    $: () => undefined,
    ...(host === "v2" ? { routerHost: "v2" } : {}),
    client: { app: { log }, session: { get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id } }) } },
  } as unknown as Parameters<typeof ModelRouterPlugin>[0]);
  return { infos, dispose: async () => (hooks as { dispose?: () => Promise<void> }).dispose?.() };
}

async function gcRanAfterDelay(): Promise<boolean> {
  await vi.advanceTimersByTimeAsync(REFERENCE_GC_START_DELAY_MS + 10_000);
  for (let i = 0; i < 20 && gc.mock.calls.length === 0; i += 1) await vi.advanceTimersByTimeAsync(1_000);
  return gc.mock.calls.length > 0;
}

describe("DF-1-1: start-up side effects outside routing.workRoots", () => {
  it("DF-1-1 v2, location outside the configured work roots: no reference GC, one info line naming the skip", async () => {
    configure({ workRoots: [join(home, "plan")] });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const outside = join(home, "elsewhere");
    const plugin = await start(outside, "v2");
    try {
      expect(await gcRanAfterDelay()).toBe(false);
      const skips = plugin.infos.filter((m) => m.includes("outside routing.workRoots"));
      expect(skips).toHaveLength(1);
      expect(skips[0]).toContain(outside);
      expect(skips[0]).toContain("reference GC is skipped");
    } finally {
      // Real timers for the teardown: a bounded wait in dispose must be able to fire.
      vi.useRealTimers();
      await plugin.dispose();
    }
  });

  it("DF-1-1 v2, location inside a configured work root: the reference GC runs in it, no skip line", async () => {
    configure({ workRoots: [join(home, "plan")] });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const inside = join(home, "plan", "repo");
    const plugin = await start(inside, "v2");
    try {
      expect(await gcRanAfterDelay()).toBe(true);
      expect(gc.mock.calls[0]?.[0]).toBe(inside);
      expect(plugin.infos.filter((m) => m.includes("outside routing.workRoots"))).toEqual([]);
    } finally {
      // Real timers for the teardown: a bounded wait in dispose must be able to fire.
      vi.useRealTimers();
      await plugin.dispose();
    }
  });

  it("DF-1-1 v2 without routing.workRoots: unchanged, the reference GC runs wherever the location is", async () => {
    configure({});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const plugin = await start(join(home, "elsewhere"), "v2");
    try {
      expect(await gcRanAfterDelay()).toBe(true);
      expect(plugin.infos.filter((m) => m.includes("outside routing.workRoots"))).toEqual([]);
    } finally {
      // Real timers for the teardown: a bounded wait in dispose must be able to fire.
      vi.useRealTimers();
      await plugin.dispose();
    }
  });

  it("DF-1-1 v1 (feature-frozen): work roots change nothing, the reference GC runs", async () => {
    configure({ workRoots: [join(home, "plan")] });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const plugin = await start(join(home, "elsewhere"), "v1");
    try {
      expect(await gcRanAfterDelay()).toBe(true);
      expect(plugin.infos.filter((m) => m.includes("outside routing.workRoots"))).toEqual([]);
    } finally {
      // Real timers for the teardown: a bounded wait in dispose must be able to fire.
      vi.useRealTimers();
      await plugin.dispose();
    }
  });
});
