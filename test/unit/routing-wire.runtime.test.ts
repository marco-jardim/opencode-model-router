/**
 * The engine runtime's `dispose()` (Phase 2.4, QA-2.4-17): when it resolves, every store reference the runtime ever took is released and the
 * final flush of the decision log has completed, including a release that was started earlier without anyone waiting for it (a hot reload
 * to `static`, another outcomes directory).
 */
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateConfig } from "../../src/router/config";
import type { RouterConfig } from "../../src/router/config";
import { DECISIONS_FILE, acquireOutcomes, makeKey } from "../../src/routing/outcomes";
import type { AcquireOutcomesOptions, DecisionRow, OutcomesBundle } from "../../src/routing/outcomes";
import { createEngineRuntime } from "../../src/routing/wire/runtime";

const shipped: Record<string, unknown> = JSON.parse(readFileSync(join(__dirname, "../../tiers.json"), "utf-8"));
const KEY = makeKey("implement", { origin: "router", id: "medium" }, "anthropic", "claude-sonnet-5-5");

function cfgOf(routing: Record<string, unknown>): RouterConfig {
  return validateConfig({ ...structuredClone(shipped), activePreset: "anthropic", routing });
}

function row(id: string): DecisionRow {
  const choice = { key: KEY, agent: "medium", origin: "router" as const, model: "anthropic/claude-sonnet-5-5", variant: "default" };
  return {
    v: 1, kind: "decision", ts: "2026-10-06T12:00:00.000Z", sessionID: "s1", decisionID: id, mode: "shadow", childSessionID: null,
    facts: { class: "implement", risk: "low", scope: "single", needs: ["edit"], confidence: 0.9, source: "rules" },
    chosen: choice, best: choice, switched: false, pinned: false, unit: "ratio", costs: { [KEY]: 5 }, confidence: 0.8, reason: "kept:best-is-chosen", step: "dispatch", resume: false,
  };
}

describe("createEngineRuntime.dispose (QA-2.4-17)", () => {
  let dir: string;
  let store: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "runtime-dispose-"));
    store = join(dir, "store");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

  const logger = () => ({ warn: vi.fn() });
  const decisionIDs = (): string[] =>
    existsSync(join(store, DECISIONS_FILE))
      ? readFileSync(join(store, DECISIONS_FILE), "utf-8").split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { decisionID: string }).decisionID)
      : [];

  function runtimeOver(cfg: RouterConfig, log: ReturnType<typeof logger>, acquire?: (options: AcquireOutcomesOptions) => OutcomesBundle) {
    return createEngineRuntime({ loadConfig: () => cfg, listAgents: async () => [], listModels: async () => [], logger: log, ...(acquire === undefined ? {} : { acquire }) });
  }

  it("the runtime holds the last reference: dispose resolves only after the final flush, and the queued rows are on disk", async () => {
    const cfg = cfgOf({ engine: "shadow", outcomes: { path: store } });
    const runtime = runtimeOver(cfg, logger());
    const prepared = await runtime.prepare(cfg);
    expect(prepared).not.toBeNull();
    prepared!.enqueue(row("A1"));
    prepared!.enqueue(row("A2"));
    await runtime.dispose();
    expect(decisionIDs()).toEqual(["A1", "A2"]); // nothing is left in memory
    await runtime.dispose(); // idempotent
    expect(await runtime.prepare(cfg)).toBeNull(); // and a disposed runtime takes no new reference
  });

  it("waits for a release that a hot reload to static started earlier, however long its flush takes", async () => {
    const shadow = cfgOf({ engine: "shadow", outcomes: { path: store } });
    const off = cfgOf({ engine: "static" });
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    let finished = false;
    const acquire = (options: AcquireOutcomesOptions): OutcomesBundle => {
      const real = acquireOutcomes(options);
      return { ...real, release: async () => { await gate; await real.release(); finished = true; } };
    };
    const runtime = runtimeOver(shadow, logger(), acquire);
    const prepared = await runtime.prepare(shadow);
    prepared!.enqueue(row("B1"));
    expect(await runtime.prepare(off)).toBeNull(); // hot reload to static: the old store is released in the background, parked on the gate
    let resolved = false;
    const disposing = runtime.dispose().then(() => { resolved = true; });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(resolved).toBe(false); // before the fix this had already resolved, with the flush still pending
    expect(finished).toBe(false);
    open();
    await disposing;
    expect(finished).toBe(true);
    expect(decisionIDs()).toEqual(["B1"]);
  });

  it("waits for the releases of a moved outcomes directory too", async () => {
    const first = cfgOf({ engine: "shadow", outcomes: { path: store } });
    const second = cfgOf({ engine: "shadow", outcomes: { path: join(dir, "store2") } });
    const releases: string[] = [];
    const acquire = (options: AcquireOutcomesOptions): OutcomesBundle => {
      const real = acquireOutcomes(options);
      return { ...real, release: async () => { await new Promise((resolve) => setTimeout(resolve, 25)); await real.release(); releases.push(options.dir); } };
    };
    const runtime = runtimeOver(first, logger(), acquire);
    (await runtime.prepare(first))!.enqueue(row("C1"));
    (await runtime.prepare(second))!.enqueue(row("C2")); // the first directory is released in the background
    await runtime.dispose();
    expect(releases.sort()).toEqual([store, join(dir, "store2")].sort());
    expect(decisionIDs()).toEqual(["C1"]);
  });

  it("another holder keeps the store alive: only this runtime's reference goes, the other still flushes", async () => {
    const cfg = cfgOf({ engine: "shadow", outcomes: { path: store } });
    const other = acquireOutcomes({ dir: store, tuning: {}, logger: { warn: () => undefined } });
    try {
      const runtime = runtimeOver(cfg, logger());
      (await runtime.prepare(cfg))!.enqueue(row("D1"));
      await runtime.dispose();
      other.flusher.enqueue(row("D2")); // still usable: the bundle was not disposed under it
      await other.flusher.flushNow();
      expect(decisionIDs().sort()).toEqual(["D1", "D2"]);
    } finally {
      await other.release();
    }
  });

  it("a release that fails is logged, never thrown, and dispose still resolves", async () => {
    const cfg = cfgOf({ engine: "shadow", outcomes: { path: store } });
    const log = logger();
    const acquire = (options: AcquireOutcomesOptions): OutcomesBundle => {
      const real = acquireOutcomes(options);
      return { ...real, release: async () => { await real.release(); throw new Error("disk went away"); } };
    };
    const runtime = runtimeOver(cfg, log, acquire);
    await runtime.prepare(cfg);
    await expect(runtime.dispose()).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith("[router] routing: releasing the outcome store failed", { error: "disk went away" });
  });
});
