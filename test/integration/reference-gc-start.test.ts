/**
 * 2.1.5b: the REAL plugin factory sweeps stale reference dirs exactly once after start,
 * fire-and-forget, and a rejecting GC is logged rather than thrown.
 *
 * QA-2.1-11: the sweep is deferred by REFERENCE_GC_START_DELAY_MS on an unref'd timer, so plugin
 * start never spawns a git child in the project directory (on Windows its cwd handle made the
 * caller's rmdir of that directory fail with EBUSY), and plugin dispose cancels it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ModelRouterPlugin from "../../src/index";
import { invalidateConfigCache } from "../../src/router/config";
import { REFERENCE_GC_START_DELAY_MS } from "../../src/verify/wiring";

const gc = vi.hoisted(() => ({ calls: [] as string[], rejects: false }));
vi.mock("../../src/verify/reference", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/verify/reference")>()),
  gcStaleReferences: (root: string) => {
    gc.calls.push(root);
    return gc.rejects ? Promise.reject(new Error("gc exploded")) : Promise.resolve({ removed: [], kept: [], failed: [] });
  },
}));

describe("reference GC at plugin start", () => {
  let dir: string;
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mrgc-"));
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    invalidateConfigCache();
    gc.calls = []; gc.rejects = false;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    for (const key of ["HOME", "USERPROFILE"] as const) {
      if (saved[key] !== undefined) process.env[key] = saved[key];
      else delete process.env[key];
    }
    invalidateConfigCache();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const ctx = (logs: unknown[]) => ({
    directory: dir, worktree: dir, project: {}, serverUrl: new URL("http://localhost"), $: () => {},
    client: { app: { log: async (opts: unknown) => { logs.push(opts); return {}; } }, session: {} },
  });
  const start = (logs: unknown[]) => ModelRouterPlugin(ctx(logs) as unknown as Parameters<typeof ModelRouterPlugin>[0]);

  it("runs nothing at start, then calls gcStaleReferences once with the plugin directory, and logs a rejection", async () => {
    gc.rejects = true;
    const logs: unknown[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(start(logs)).resolves.toBeDefined();
      await vi.advanceTimersByTimeAsync(REFERENCE_GC_START_DELAY_MS - 1);
      expect(gc.calls).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(gc.calls).toEqual([dir]);
      await vi.waitFor(() => expect(JSON.stringify(logs) + warn.mock.calls.flat().join(" ")).toContain("reference GC failed"));
    } finally {
      warn.mockRestore();
    }
    await vi.advanceTimersByTimeAsync(10 * REFERENCE_GC_START_DELAY_MS);
    expect(gc.calls).toEqual([dir]);
  });

  it("the project directory can be removed right after start, and plugin dispose cancels the pending GC", async () => {
    const hooks = await start([]);
    // The start spawned no git child in `dir`, so nothing holds it.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    expect(fs.existsSync(dir)).toBe(false);
    fs.mkdirSync(dir);
    await hooks.dispose?.();
    await vi.advanceTimersByTimeAsync(2 * REFERENCE_GC_START_DELAY_MS);
    expect(gc.calls).toEqual([]);
  });
});
