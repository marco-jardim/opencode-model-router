// Phase 2.1 (M6): telemetry ingestion into the outcome store. Temp directories only: every outcomes directory
// is a fresh mkdtemp under the OS temp dir, injected through the settings; the real trajectory directory and
// ~/.config/opencode are never touched.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  acquireOutcomes,
  DEFAULT_OUTCOME_TUNING,
  makeKey,
  nodePersistDeps,
  summarize,
  type AcquireOutcomesOptions,
  type FlushScheduler,
  type OutcomeKey,
  type OutcomesBundle,
  type Verdict,
} from "../../src/routing/outcomes";
import {
  createCatalogPricing,
  createIngest,
  resetCatalogPricing,
  ingestSettings,
  resetIngestState,
  SEEN_EVENT_CAP,
  type Ingest,
  type IngestEvent,
  type IngestSettings,
  type PricingLookup,
} from "../../src/routing/outcomes/ingest";
import {
  awaitExecutionEnd,
  dispatchCount,
  forgetDispatch,
  forgetDispatchesOf,
  lastStepContext,
  lookupDispatch,
  MAX_DISPATCH_RECORDS,
  noteExecutionEnded,
  noteStepContext,
  rememberDispatch,
  resetDispatchRegistry,
  sweepDispatches,
  touchDispatch,
  type DispatchInput,
} from "../../src/router/sessions";
import type { RouterConfig } from "../../src/router/config";

const T0 = Date.UTC(2026, 9, 6, 12, 0, 0);
const MEDIUM_KEY = makeKey("implement", { origin: "router", id: "medium" }, "anthropic", "claude-sonnet-5-5", "medium");

const dirs: string[] = [];
const disposers: Array<() => Promise<void>> = [];

interface Harness {
  readonly dir: string;
  readonly clock: { t: number };
  readonly warnings: string[];
  readonly timers: Array<{ fn: () => void; ms: number; cleared: boolean }>;
  readonly bundles: OutcomesBundle[];
  settings: IngestSettings | null;
  make(overrides?: { pricing?: PricingLookup; settings?: () => IngestSettings | null }): Ingest;
  store(): OutcomesBundle["store"];
  rows(): Promise<Array<Record<string, unknown>>>;
}

function harness(settingsOverride: Partial<IngestSettings> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "omr-ingest-"));
  dirs.push(dir);
  const clock = { t: T0 };
  const warnings: string[] = [];
  const timers: Harness["timers"] = [];
  const bundles: OutcomesBundle[] = [];
  const logger = { warn: (message: string, extra?: Record<string, unknown>) => { warnings.push(`${message} ${JSON.stringify(extra ?? {})}`); } };
  const scheduler: FlushScheduler = {
    setTimer(fn, ms) { const slot = { fn, ms, cleared: false }; timers.push(slot); return slot; },
    clearTimer(handle) { (handle as { cleared: boolean }).cleared = true; },
  };
  const acquire = (options: AcquireOutcomesOptions): OutcomesBundle => {
    const bundle = acquireOutcomes({ ...options, deps: { ...nodePersistDeps(logger), now: () => clock.t }, scheduler });
    bundles.push(bundle);
    return bundle;
  };
  const h: Harness = {
    dir, clock, warnings, timers, bundles,
    settings: {
      engine: "shadow",
      minClassConfidence: 0.7,
      outcomesDir: dir,
      tuning: DEFAULT_OUTCOME_TUNING,
      routerAgentIds: new Set(["fast", "medium", "heavy"]),
      ...settingsOverride,
    },
    make(overrides = {}) {
      const ingest = createIngest({
        settings: overrides.settings ?? (() => h.settings),
        logger,
        now: () => clock.t,
        acquire,
        ...(overrides.pricing ? { pricing: overrides.pricing } : {}),
      });
      disposers.push(() => ingest.dispose());
      return ingest;
    },
    store() {
      const bundle = bundles[0];
      if (bundle === undefined) throw new Error("no outcomes bundle was acquired");
      return bundle.store;
    },
    async rows() {
      const bundle = bundles[0];
      if (bundle === undefined) throw new Error("no outcomes bundle was acquired");
      await bundle.flusher.flushNow();
      return (await bundle.persister.readRows()).rows as unknown as Array<Record<string, unknown>>;
    },
  };
  return h;
}

const FACTS = { class: "implement", risk: "medium", scope: "file", needs: [] as string[], confidence: 0.9, source: "rules" };

function dispatch(child: string, over: Partial<DispatchInput> = {}): void {
  rememberDispatch(child, {
    facts: FACTS,
    agent: "medium",
    model: "anthropic/claude-sonnet-5-5",
    variant: "medium",
    tier: "medium",
    acceptance: "grader",
    parentSessionID: "root",
    ...over,
  }, T0);
}

function step(id: string, sessionID: string, over: { finish?: string; cost?: number; input?: number; output?: number } = {}): IngestEvent {
  return {
    id,
    type: "session.step.ended",
    data: {
      sessionID,
      assistantMessageID: `m-${id}`,
      finish: over.finish ?? "tool-calls",
      rawFinish: "stop",
      cost: over.cost ?? 0.01,
      tokens: { input: over.input ?? 1000, output: over.output ?? 100, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  };
}

const PRICED: PricingLookup = async () => [{ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }];
const EMPTY_PRICING: PricingLookup = async () => [];
const ZERO_PRICING: PricingLookup = async () => [{ input: 0, output: 0, cache: { read: 0, write: 0 } }];

beforeEach(() => {
  resetDispatchRegistry();
  resetIngestState();
});

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  resetDispatchRegistry();
  resetIngestState();
});

describe("dispatch registry (2.1.1)", () => {
  it("remembers, looks up and forgets a child; a re-registration starts the next attempt", () => {
    expect(lookupDispatch("c1")).toBeUndefined();
    dispatch("c1");
    const first = lookupDispatch("c1");
    expect(first).toMatchObject({ agent: "medium", model: "anthropic/claude-sonnet-5-5", variant: "medium", tier: "medium", parentSessionID: "root", attemptIndex: 0, attemptId: expect.stringMatching(/^c1:0:[0-9a-f]{8}-\d+$/), step: "dispatch", decisionID: null });
    dispatch("c1");
    expect(lookupDispatch("c1")).toMatchObject({ attemptIndex: 1, attemptId: expect.stringMatching(/^c1:1:[0-9a-f]{8}-\d+$/) });
    rememberDispatch("c1", { facts: FACTS, agent: "medium", model: null, attemptId: "custom", decisionID: "d-9", step: "variant" }, T0);
    expect(lookupDispatch("c1")).toMatchObject({ attemptIndex: 2, attemptId: "custom", decisionID: "d-9", step: "variant", model: null, variant: null });
    expect(forgetDispatch("c1")).toBe(true);
    expect(forgetDispatch("c1")).toBe(false);
    expect(lookupDispatch("c1")).toBeUndefined();
  });

  it("QA-2.1-1: default attempt ids never repeat in the process, even when the index restarts after an eviction", () => {
    const seen = new Set<string>();
    for (let round = 0; round < 3; round++) {
      dispatch("c1");
      seen.add(lookupDispatch("c1")!.attemptId);
      expect(lookupDispatch("c1")!.attemptIndex).toBe(0);
      forgetDispatch("c1"); // eviction: the next registration starts at index 0 again
    }
    dispatch("c1");
    dispatch("c1");
    seen.add(lookupDispatch("c1")!.attemptId);
    expect(seen.size).toBe(4);
    // an explicit id is kept verbatim
    rememberDispatch("c1", { facts: FACTS, agent: "medium", model: null, attemptId: "mine" }, T0);
    expect(lookupDispatch("c1")!.attemptId).toBe("mine");
  });

  it("QA-2.1-R2-2 (P5): default attempt ids differ across process restarts (a fresh module load)", async () => {
    const idsOf = async (): Promise<string[]> => {
      vi.resetModules();
      const fresh = await import("../../src/router/sessions");
      return [0, 1, 2].map(() => fresh.rememberDispatch("c1", { facts: FACTS, agent: "medium", model: null }, T0).attemptId);
    };
    const first = await idsOf();
    const second = await idsOf(); // same child, same indices, same sequence numbers as a restarted process would have
    expect(new Set([...first, ...second]).size).toBe(6);
    expect(first.map((id) => id.replace(/:[0-9a-f]{8}-/, ":x-"))).toEqual(second.map((id) => id.replace(/:[0-9a-f]{8}-/, ":x-")));
  });

  it("sweeps entries idle for the TTL, honours touches and never evicts future stamps", () => {
    rememberDispatch("old", { facts: FACTS, agent: "medium", model: null }, T0);
    rememberDispatch("touched", { facts: FACTS, agent: "medium", model: null }, T0);
    rememberDispatch("future", { facts: FACTS, agent: "medium", model: null }, T0 + 10 * 3_600_000);
    touchDispatch("touched", T0 + 3_000_000);
    expect(sweepDispatches(T0 + 3_599_999)).toBe(0);
    expect(sweepDispatches(T0 + 3_600_000)).toBe(1);
    expect(lookupDispatch("old")).toBeUndefined();
    expect(lookupDispatch("touched")).toBeDefined();
    expect(sweepDispatches(T0 + 3_600_000 + 3_000_000)).toBe(1);
    expect(lookupDispatch("future")).toBeDefined();
  });

  it("forgets every child of an orchestrator and stays bounded", () => {
    rememberDispatch("a", { facts: FACTS, agent: "medium", model: null, parentSessionID: "p1" }, T0);
    rememberDispatch("b", { facts: FACTS, agent: "medium", model: null, parentSessionID: "p1" }, T0);
    rememberDispatch("c", { facts: FACTS, agent: "medium", model: null, parentSessionID: "p2" }, T0);
    expect(forgetDispatchesOf("p1").map((r) => r.childSessionID).sort()).toEqual(["a", "b"]);
    expect(dispatchCount()).toBe(1);
    resetDispatchRegistry();
    for (let i = 0; i < MAX_DISPATCH_RECORDS + 25; i++) rememberDispatch(`k${i}`, { facts: FACTS, agent: "medium", model: null }, T0);
    expect(dispatchCount()).toBe(MAX_DISPATCH_RECORDS);
    expect(lookupDispatch("k0")).toBeUndefined();
    expect(lookupDispatch(`k${MAX_DISPATCH_RECORDS + 24}`)).toBeDefined();
  });
});

describe("ingest settings (§1.2: static writes nothing)", () => {
  const cfg = (routing?: Record<string, unknown>): RouterConfig => ({ activePreset: "anthropic", presets: { anthropic: {
    fast: { model: "anthropic/claude-sonnet-5-5", variant: "low", costRatio: 1 },
    medium: { model: "anthropic/claude-sonnet-5-5", variant: "medium", costRatio: 5 },
  } }, ...(routing ? { routing } : {}) } as unknown as RouterConfig);

  it("is null without a routing block, for engine static, and on v1 whatever the engine says", () => {
    expect(ingestSettings(cfg(), "v2")).toBeNull();
    expect(ingestSettings(cfg({ engine: "static" }), "v2")).toBeNull();
    expect(ingestSettings(cfg({ engine: "shadow" }), "v1")).toBeNull();
    expect(ingestSettings(undefined, "v2")).toBeNull();
  });

  it("resolves engine, threshold, directory, tuning and the router agent ids for shadow/advise/enforce", () => {
    const dir = join(tmpdir(), "omr-ingest-settings-never-created");
    for (const engine of ["shadow", "advise", "enforce"] as const) {
      const settings = ingestSettings(cfg({ engine, minClassConfidence: 0.8, outcomes: { path: dir, halfLifeDays: 7, maxEffectiveSamples: 20 } }), "v2");
      expect(settings).toMatchObject({ engine, minClassConfidence: 0.8, outcomesDir: dir, tuning: { halfLifeDays: 7, maxEffectiveSamples: 20 } });
      expect([...(settings?.routerAgentIds ?? [])].sort()).toEqual(["fast", "medium"]);
    }
    expect(existsSync(dir)).toBe(false);
  });

  it("caches per config object", () => {
    const c = cfg({ engine: "shadow" });
    expect(ingestSettings(c, "v2")).toBe(ingestSettings(c, "v2"));
  });
});

describe("step ingestion (2.1.2)", () => {
  it("ignores a step event for an unknown session and acquires nothing", async () => {
    const h = harness();
    const ingest = h.make({ pricing: PRICED });
    await ingest.onStepEnded(step("e1", "ghost"));
    await ingest.onStepEnded({ id: "e2", type: "session.text.ended", data: { sessionID: "ghost" } });
    await ingest.onStepEnded({ id: "e3", type: "session.step.ended", data: "not an object" });
    expect(h.bundles).toHaveLength(0);
    expect(readdirSync(h.dir)).toEqual([]);
  });

  it("records cost and tokens of a registered child, folding the attempt on its final step", async () => {
    const h = harness();
    const ingest = h.make({ pricing: PRICED });
    dispatch("c1");
    await ingest.onStepEnded(step("e1", "c1", { cost: 0.01, input: 1000, output: 100, finish: "tool-calls" }));
    expect(h.store().cost(MEDIUM_KEY).steps.n).toBe(0); // folded only on the final step
    await ingest.onStepEnded(step("e2", "c1", { cost: 0.02, input: 2000, output: 300, finish: "stop" }));
    expect(h.store().cost(MEDIUM_KEY).steps.n).toBe(0); // QA-2.1-6: the final step waits for the end of the execution
    ingest.onExecutionEnded("c1");
    const cost = h.store().cost(MEDIUM_KEY);
    expect(cost.measuredUSD.n).toBe(1);
    expect(cost.measuredUSD.mean).toBeCloseTo(0.03, 9);
    expect(cost.tokens).toMatchObject({ n: 1, input: 3000, output: 400 });
    expect(cost.steps).toMatchObject({ n: 1, mean: 2 });
    expect(cost.finalMessageTokens.mean).toBe(300);
    expect(h.store().keys()).toEqual([MEDIUM_KEY]);
  });

  it("D6/A1: cost 0 with an empty or all-zero catalog price is unknown, tokens are kept", async () => {
    for (const pricing of [EMPTY_PRICING, ZERO_PRICING, async () => undefined]) {
      resetDispatchRegistry();
      resetIngestState();
      const h = harness();
      const ingest = h.make({ pricing });
      dispatch("c1");
      await ingest.onStepEnded(step("e1", "c1", { cost: 0, input: 5340, output: 5, finish: "stop" }));
      ingest.onExecutionEnded("c1");
      const cost = h.store().cost(MEDIUM_KEY);
      expect(cost.measuredUSD.n).toBe(0);
      expect(cost.unpricedAttempts).toBe(1);
      expect(cost.tokens).toMatchObject({ n: 1, input: 5340, output: 5 });
      await ingest.dispose();
    }
  });

  it("keeps a priced model's zero and an unpriced model's positive host cost", async () => {
    const h = harness();
    const priced = h.make({ pricing: PRICED });
    dispatch("c1");
    await priced.onStepEnded(step("e1", "c1", { cost: 0, finish: "stop" }));
    priced.onExecutionEnded("c1");
    expect(h.store().cost(MEDIUM_KEY).measuredUSD).toMatchObject({ n: 1, mean: 0 });
    const unpriced = h.make({ pricing: EMPTY_PRICING });
    dispatch("c2", { facts: { ...FACTS, class: "debug" } });
    await unpriced.onStepEnded(step("e2", "c2", { cost: 0.5, finish: "stop" }));
    unpriced.onExecutionEnded("c2");
    const key = makeKey("debug", { origin: "router", id: "medium" }, "anthropic", "claude-sonnet-5-5", "medium");
    expect(h.store().cost(key).measuredUSD).toMatchObject({ n: 1, mean: 0.5 });
  });

  it("uses the catalog lookup the adapter supplies: one load, cached by provider/model", async () => {
    const h = harness();
    let loads = 0;
    const pricing = createCatalogPricing(async () => {
      loads += 1;
      return [
        { providerID: "anthropic", id: "claude-sonnet-5-5", cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }] },
        { providerID: "opencode-go", id: "gpt-6-luna", cost: [{ input: 0.1, output: 0.5 }] },
      ];
    }, { now: () => h.clock.t });
    const ingest = h.make({ pricing });
    dispatch("c1");
    dispatch("c2", { agent: "fast", model: "opencode-go/gpt-6-luna", variant: null });
    await ingest.onStepEnded(step("e1", "c1", { cost: 0, finish: "stop" }));
    await ingest.onStepEnded(step("e2", "c2", { cost: 0, finish: "stop" }));
    ingest.onExecutionEnded("c1");
    ingest.onExecutionEnded("c2");
    expect(loads).toBe(1);
    expect(h.store().cost(MEDIUM_KEY).unpricedAttempts).toBe(1);
    const luna = makeKey("implement", { origin: "router", id: "fast" }, "opencode-go", "gpt-6-luna", null);
    expect(h.store().cost(luna).measuredUSD).toMatchObject({ n: 1, mean: 0 }); // priced model: its 0 is a measurement
  });

  it("keys host agents under origin host", async () => {
    const h = harness();
    const ingest = h.make({ pricing: PRICED });
    dispatch("c1", { agent: "explore", model: "anthropic/claude-haiku-4-5", variant: null, facts: { ...FACTS, class: "search" } });
    await ingest.onStepEnded(step("e1", "c1", { finish: "stop" }));
    ingest.onExecutionEnded("c1");
    expect(h.store().keys()).toEqual([makeKey("search", { origin: "host", id: "explore" }, "anthropic", "claude-haiku-4-5", null)]);
  });

  it("splits a model reference that carries its own variant", async () => {
    const h = harness();
    const ingest = h.make({ pricing: PRICED });
    dispatch("c1", { model: "anthropic/claude-sonnet-5-5#high", variant: null });
    await ingest.onStepEnded(step("e1", "c1", { finish: "stop" }));
    ingest.onExecutionEnded("c1");
    expect(h.store().keys()).toEqual([makeKey("implement", { origin: "router", id: "medium" }, "anthropic", "claude-sonnet-5-5", "high")]);
  });

  it("does not record a child whose model was not resolved, and warns once", async () => {
    const h = harness();
    const ingest = h.make({ pricing: PRICED });
    dispatch("c1", { model: null });
    await ingest.onStepEnded(step("e1", "c1"));
    await ingest.onStepEnded(step("e2", "c1"));
    ingest.onVerdict("c1", "pass");
    expect(h.bundles).toHaveLength(0);
    expect(h.warnings.filter((w) => w.includes("not recorded"))).toHaveLength(1);
  });

  it("a resumed child starts a new attempt: the open one is folded and nothing is counted twice", async () => {
    const h = harness();
    const ingest = h.make({ pricing: PRICED });
    dispatch("c1");
    await ingest.onStepEnded(step("e1", "c1", { cost: 0.01, finish: "tool-calls" }));
    dispatch("c1"); // resume: attempt c1:1
    await ingest.onStepEnded(step("e2", "c1", { cost: 0.04, finish: "stop" }));
    ingest.onExecutionEnded("c1");
    const cost = h.store().cost(MEDIUM_KEY);
    expect(cost.steps.n).toBe(2); // two attempts folded
    expect(cost.measuredUSD.n).toBe(2);
    expect(cost.measuredUSD.mean).toBeCloseTo(0.025, 9); // (0.01 + 0.04) / 2, each step once
    ingest.onVerdict("c1", "pass");
    expect(h.store().snapshot().entries[MEDIUM_KEY]?.counts.pass).toBe(1); // scored on the current attempt only
  });

  it("an event loop error is logged, and the next event is still ingested", async () => {
    const h = harness();
    let calls = 0;
    const ingest = h.make({ pricing: async () => { calls += 1; if (calls === 1) throw new Error("catalog exploded"); return [{ input: 3, output: 15 }]; } });
    dispatch("c1");
    await expect(ingest.onStepEnded(step("e1", "c1", { finish: "tool-calls" }))).resolves.toBeUndefined();
    expect(h.warnings.some((w) => w.includes("session.step.ended failed") && w.includes("catalog exploded"))).toBe(true);
    await ingest.onStepEnded(step("e2", "c1", { finish: "stop", cost: 0.02 }));
    ingest.onExecutionEnded("c1");
    expect(h.store().cost(MEDIUM_KEY).measuredUSD.n).toBe(1);
  });

  it("D6 holds with no pricing lookup at all and a non-numeric cost never poisons the mean", async () => {
    const h = harness();
    const ingest = h.make();
    dispatch("c1");
    const bad = step("e1", "c1", { finish: "stop" });
    (bad.data as { cost: unknown }).cost = "free";
    await ingest.onStepEnded(bad);
    ingest.onExecutionEnded("c1");
    const cost = h.store().cost(MEDIUM_KEY);
    expect(cost.measuredUSD.n).toBe(0);
    expect(cost.tokens.n).toBe(1);
  });
});

describe("duplicate delivery (A3, S3b)", () => {
  it("counts the same event id once when two plugin instances both receive it", async () => {
    const h = harness();
    const a = h.make({ pricing: PRICED });
    const b = h.make({ pricing: PRICED });
    dispatch("c1");
    const event = step("evt-1", "c1", { finish: "stop", cost: 0.02 });
    await Promise.all([a.onStepEnded(event), b.onStepEnded(event)]);
    await b.onStepEnded(event);
    a.onExecutionEnded("c1");
    const cost = h.store().cost(MEDIUM_KEY);
    expect(cost.steps).toMatchObject({ n: 1, mean: 1 });
    expect(cost.measuredUSD).toMatchObject({ n: 1 });
    expect(cost.measuredUSD.mean).toBeCloseTo(0.02, 9);
    // the instance that dropped the duplicate never needed a bundle; once it records something it shares
    // the process-wide store and writer of the first one (A3)
    expect(h.bundles).toHaveLength(1);
    dispatch("c2");
    await b.onStepEnded(step("evt-3", "c2", { finish: "stop", cost: 0.01 }));
    b.onExecutionEnded("c2");
    expect(h.bundles).toHaveLength(2);
    expect(h.bundles[1]!.store).toBe(h.bundles[0]!.store);
    expect(h.bundles[1]!.flusher).toBe(h.bundles[0]!.flusher);
    expect(h.store().cost(MEDIUM_KEY).steps.n).toBe(2);
  });

  it("an instance with a static engine does not consume the event another instance records", async () => {
    const h = harness();
    const stat = h.make({ settings: () => null, pricing: PRICED });
    const live = h.make({ pricing: PRICED });
    dispatch("c1");
    const event = step("evt-2", "c1", { finish: "stop" });
    await stat.onStepEnded(event);
    await live.onStepEnded(event);
    live.onExecutionEnded("c1");
    expect(h.store().cost(MEDIUM_KEY).steps.n).toBe(1);
  });

  it("QA-2.1-2 (probe P4): a slow pricing lookup on one instance does not cost another instance the duplicate it needs", async () => {
    const h = harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow: PricingLookup = async () => { await gate; return [{ input: 3, output: 15 }]; };
    const a = h.make({ pricing: slow });
    const b = h.make({ pricing: PRICED });
    dispatch("c1");
    const first = step("p4-1", "c1", { finish: "tool-calls", cost: 0.01, output: 100 });
    const last = step("p4-2", "c1", { finish: "stop", cost: 0.02, output: 333 });
    const aLoop = (async () => { await a.onStepEnded(first); await a.onStepEnded(last); })();
    await b.onStepEnded(first);
    await b.onStepEnded(last);
    release();
    await aLoop;
    b.onExecutionEnded("c1");
    const cost = h.store().cost(MEDIUM_KEY);
    expect(cost.steps).toMatchObject({ n: 1, mean: 2 }); // both steps of the attempt, each once
    expect(cost.finalMessageTokens.mean).toBe(333);
    expect(cost.measuredUSD.mean).toBeCloseTo(0.03, 9);
  });

  it("QA-2.1-8: the same event id is recorded once per outcomes directory", async () => {
    const one = harness();
    const two = harness();
    const a = one.make({ pricing: PRICED });
    const b = two.make({ pricing: PRICED });
    dispatch("c1");
    const event = step("shared-id", "c1", { finish: "stop", cost: 0.02 });
    await a.onStepEnded(event);
    await b.onStepEnded(event);
    await a.onStepEnded(event);
    a.onExecutionEnded("c1");
    b.onExecutionEnded("c1");
    expect(one.store().cost(MEDIUM_KEY).steps.n).toBe(1);
    expect(two.store().cost(MEDIUM_KEY).steps.n).toBe(1);
    expect(one.store()).not.toBe(two.store());
  });

  it("falls back to a content key when an event carries no id, and the LRU stays bounded", async () => {
    const h = harness();
    const a = h.make({ pricing: PRICED });
    const b = h.make({ pricing: PRICED });
    dispatch("c1");
    const event = step("", "c1", { finish: "stop" });
    await a.onStepEnded(event);
    await b.onStepEnded(event);
    a.onExecutionEnded("c1");
    expect(h.store().cost(MEDIUM_KEY).steps.n).toBe(1);
    expect(SEEN_EVENT_CAP).toBeGreaterThanOrEqual(1000);
  });
});

describe("verdicts and false refusals (D4, C5)", () => {
  it("pass, fail and unverifiable: Beta, counters and rows", async () => {
    const h = harness();
    const ingest = h.make({ pricing: PRICED });
    for (const [child, verdict] of [["p", "pass"], ["f", "fail"], ["u", "unverifiable"]] as Array<[string, Verdict]>) {
      dispatch(child, { decisionID: `d-${child}` });
      ingest.onVerdict(child, verdict);
    }
    const entry = h.store().snapshot().entries[MEDIUM_KEY];
    expect(entry?.counts).toMatchObject({ pass: 1, fail: 1, falseRefusals: 0 });
    // unverifiable updates nothing in the store…
    expect(h.store().posterior(MEDIUM_KEY).n).toBeGreaterThan(0);
    const rows = await h.rows();
    // …but is still a row (1.3 handoff).
    expect(rows.filter((r) => r.kind === "verdict").map((r) => [r.childSessionID, r.verdict, r.decisionID, r.sessionID, r.key]).sort())
      .toEqual([["f", "fail", "d-f", "root", MEDIUM_KEY], ["p", "pass", "d-p", "root", MEDIUM_KEY], ["u", "unverifiable", "d-u", "root", MEDIUM_KEY]].sort());
  });

  it("a repeated verdict enqueues one row and moves the Beta once", async () => {
    const h = harness();
    const ingest = h.make();
    dispatch("c1");
    ingest.onVerdict("c1", "pass");
    ingest.onVerdict("c1", "pass");
    expect(h.store().snapshot().entries[MEDIUM_KEY]?.counts.pass).toBe(1);
    expect((await h.rows()).filter((r) => r.kind === "verdict")).toHaveLength(1);
  });

  it("an unverifiable verdict that is replaced later by a pass still scores the attempt", async () => {
    const h = harness();
    const ingest = h.make();
    dispatch("c1");
    ingest.onVerdict("c1", "unverifiable");
    expect(h.store().snapshot().entries[MEDIUM_KEY]?.counts.pass ?? 0).toBe(0);
    ingest.onVerdict("c1", "pass");
    expect(h.store().snapshot().entries[MEDIUM_KEY]?.counts.pass).toBe(1);
    expect((await h.rows()).filter((r) => r.kind === "verdict")).toHaveLength(2);
  });

  it("a false refusal is a failure of the key", async () => {
    const h = harness();
    const ingest = h.make();
    dispatch("c1", { decisionID: "d-1" });
    ingest.onFalseRefusal("c1");
    const entry = h.store().snapshot().entries[MEDIUM_KEY];
    expect(entry?.counts).toMatchObject({ pass: 0, fail: 0, falseRefusals: 1 });
    expect(entry?.beta.alpha).toBe(0);
    expect(entry?.beta.beta).toBeGreaterThan(0);
    const refusal = (await h.rows()).filter((r) => r.kind === "refusal");
    expect(refusal).toHaveLength(1);
    expect(refusal[0]).toMatchObject({ childSessionID: "c1", attemptID: expect.stringMatching(/^c1:0:[0-9a-f]{8}-\d+$/), key: MEDIUM_KEY, decisionID: "d-1", step: "dispatch" });
  });

  it("refusal before the verdict: the verdict does not score the attempt a second time, and writes no row", async () => {
    const h = harness();
    const ingest = h.make();
    dispatch("c1");
    ingest.onFalseRefusal("c1");
    ingest.onVerdict("c1", "pass");
    expect(h.store().snapshot().entries[MEDIUM_KEY]?.counts).toMatchObject({ pass: 0, fail: 0, falseRefusals: 1 });
    expect((await h.rows()).map((r) => r.kind)).toEqual(["refusal"]);
  });

  it("QA-2.1-3: a verdict the store did not take (the attempt was scored already) writes no row", async () => {
    const h = harness();
    const ingest = h.make();
    dispatch("c1");
    dispatch("c2");
    ingest.onVerdict("c1", "fail");
    ingest.onVerdict("c1", "pass"); // the store keeps the first terminal signal
    ingest.onVerdict("c1", "unverifiable"); // scored: nothing to say
    ingest.onVerdict("c2", "unverifiable");
    ingest.onVerdict("c2", "unverifiable");
    const rows = await h.rows();
    expect(rows.map((r) => [r.childSessionID, r.verdict])).toEqual([["c1", "fail"], ["c2", "unverifiable"]]);
    expect(h.store().snapshot().entries[MEDIUM_KEY]?.counts).toMatchObject({ pass: 0, fail: 1 });
  });

  it("QA-2.1-3 (probe P3): pass then refusal: the refusal row overrides the pass, and routing:stats agrees with the store", async () => {
    const h = harness();
    const ingest = h.make();
    dispatch("c1"); // no decision id: stats counts refusals without a decision row (QA-1.3-13), as 2.2-less runs have none
    ingest.onVerdict("c1", "pass");
    ingest.onFalseRefusal("c1");
    const rows = await h.rows();
    expect(rows.map((r) => [r.kind, r.overrides ?? null])).toEqual([["verdict", null], ["refusal", "pass"]]);
    const counts = h.store().snapshot().entries[MEDIUM_KEY]?.counts;
    expect(counts).toMatchObject({ pass: 0, fail: 1, falseRefusals: 1 });
    const table = summarize(h.store(), (await h.bundles[0]!.persister.readRows()).rows, { since: null, until: null });
    const cell = table.byKey.find((row) => row.key === MEDIUM_KEY);
    expect(cell).toMatchObject({ pass: counts!.pass, fail: counts!.fail, falseRefusals: counts!.falseRefusals, passRate: { num: 0, den: 1, rate: 0 } });
  });

  it("QA-2.1-3: fail then refusal is one fail and one refusal in the rows, as in the store", async () => {
    const h = harness();
    const ingest = h.make();
    dispatch("c1");
    ingest.onVerdict("c1", "fail");
    ingest.onFalseRefusal("c1");
    await h.rows(); // flush
    const table = summarize(h.store(), (await h.bundles[0]!.persister.readRows()).rows, { since: null, until: null });
    const counts = h.store().snapshot().entries[MEDIUM_KEY]?.counts;
    expect(counts).toMatchObject({ pass: 0, fail: 1, falseRefusals: 1 });
    expect(table.byKey.find((row) => row.key === MEDIUM_KEY)).toMatchObject({ pass: 0, fail: 1, falseRefusals: 1 });
  });

  it("QA-2.1-9: a repeated false refusal on one attempt reaches neither the store nor the log", async () => {
    const h = harness();
    const ingest = h.make();
    dispatch("c1");
    ingest.onFalseRefusal("c1");
    ingest.onFalseRefusal("c1");
    ingest.onFalseRefusal("c1");
    expect(h.store().snapshot().entries[MEDIUM_KEY]?.counts.falseRefusals).toBe(1);
    expect((await h.rows()).filter((r) => r.kind === "refusal")).toHaveLength(1);
    dispatch("c1"); // a new attempt of the same child is a new refusal
    ingest.onFalseRefusal("c1");
    expect(h.store().snapshot().entries[MEDIUM_KEY]?.counts.falseRefusals).toBe(2);
  });

  it("refusal after a pass converts the pass into a failure (QA-1.3-6)", () => {
    const h = harness();
    const ingest = h.make();
    dispatch("c1");
    ingest.onVerdict("c1", "pass");
    ingest.onFalseRefusal("c1");
    const entry = h.store().snapshot().entries[MEDIUM_KEY];
    expect(entry?.counts).toMatchObject({ pass: 0, fail: 1, falseRefusals: 1 });
    expect(entry?.beta.alpha).toBeCloseTo(0, 9);
  });

  it("QA-2.1-1: a child re-registered after a TTL eviction is scored again; a refusal on the new attempt leaves the old pass alone", () => {
    const h = harness();
    const ingest = h.make();
    dispatch("c1");
    ingest.onVerdict("c1", "pass");
    h.clock.t = T0 + 61 * 60_000;
    ingest.sweep();
    expect(lookupDispatch("c1")).toBeUndefined();
    rememberDispatch("c1", { facts: FACTS, agent: "medium", model: "anthropic/claude-sonnet-5-5", variant: "medium", parentSessionID: "root" }, h.clock.t);
    expect(lookupDispatch("c1")!.attemptIndex).toBe(0);
    ingest.onVerdict("c1", "fail");
    let entry = h.store().snapshot().entries[MEDIUM_KEY];
    expect(entry?.counts).toMatchObject({ pass: 1, fail: 1 });
    expect(entry?.beta.alpha).toBeGreaterThan(0);
    ingest.onFalseRefusal("c1");
    entry = h.store().snapshot().entries[MEDIUM_KEY];
    expect(entry?.counts).toMatchObject({ pass: 1, fail: 1, falseRefusals: 1 });
  });

  it("scores a ladder attempt under its step kind", () => {
    const h = harness();
    const ingest = h.make();
    dispatch("c1", { step: "variant" });
    ingest.onVerdict("c1", "pass");
    expect(h.store().snapshot().entries[MEDIUM_KEY]?.counts).toMatchObject({ pass: 1, variantPass: 1 });
  });

  it("ignores signals for unregistered children", () => {
    const h = harness();
    const ingest = h.make();
    ingest.onVerdict("ghost", "pass");
    ingest.onFalseRefusal("ghost");
    expect(h.bundles).toHaveLength(0);
    expect(readdirSync(h.dir)).toEqual([]);
  });
});

describe("class confidence gate (phase 1.2 handoff)", () => {
  it("records nothing, and writes no row, for a class below routing.minClassConfidence", async () => {
    const h = harness();
    const ingest = h.make({ pricing: PRICED });
    dispatch("low", { facts: { ...FACTS, confidence: 0.69 } });
    await ingest.onStepEnded(step("e1", "low", { finish: "stop" }));
    ingest.onVerdict("low", "fail");
    ingest.onFalseRefusal("low");
    expect(h.bundles).toHaveLength(0);
    expect(readdirSync(h.dir)).toEqual([]);
    // the dispatch is still known: a later, trusted dispatch of the same child is recorded
    dispatch("low", { facts: { ...FACTS, confidence: 0.7 } });
    await ingest.onStepEnded(step("e2", "low", { finish: "stop" }));
    ingest.onExecutionEnded("low");
    expect(h.store().keys()).toEqual([MEDIUM_KEY]);
  });

  it("never records the unknown class, however confident, and uses the registered class only", async () => {
    const h = harness();
    const ingest = h.make({ pricing: PRICED });
    dispatch("u", { facts: { ...FACTS, class: "unknown", confidence: 1 } });
    await ingest.onStepEnded(step("e1", "u", { finish: "stop" }));
    ingest.onVerdict("u", "pass");
    expect(h.bundles).toHaveLength(0);
    // a backend label is not part of the facts the registry carries: the key always uses facts.class
    dispatch("k", { facts: { ...FACTS, class: "review" } });
    ingest.onVerdict("k", "pass");
    expect(h.store().keys()).toEqual([makeKey("review", { origin: "router", id: "medium" }, "anthropic", "claude-sonnet-5-5", "medium")]);
  });

  it("honours a hot-reloaded threshold", () => {
    const h = harness();
    const ingest = h.make();
    dispatch("c1", { facts: { ...FACTS, confidence: 0.8 } });
    h.settings = { ...h.settings!, minClassConfidence: 0.9 };
    ingest.onVerdict("c1", "pass");
    expect(h.bundles).toHaveLength(0);
    h.settings = { ...h.settings, minClassConfidence: 0.8 };
    ingest.onVerdict("c1", "pass");
    expect(h.store().keys()).toHaveLength(1);
  });
});

describe("engine static (§1.2): nothing is written", () => {
  it("every handler is a no-op: no bundle, no store, no files", async () => {
    const h = harness();
    h.settings = null;
    const ingest = h.make({ pricing: PRICED });
    dispatch("c1");
    await ingest.onStepEnded(step("e1", "c1", { finish: "stop" }));
    ingest.onVerdict("c1", "pass");
    ingest.onFalseRefusal("c1");
    ingest.onSessionGone("c1");
    ingest.requestFlush();
    ingest.sweep();
    await ingest.dispose();
    expect(h.bundles).toHaveLength(0);
    expect(h.timers).toHaveLength(0);
    expect(readdirSync(h.dir)).toEqual([]);
  });

  it("an engine switched to static at runtime stops recording", async () => {
    const h = harness();
    const ingest = h.make({ pricing: PRICED });
    dispatch("c1");
    ingest.onVerdict("c1", "pass");
    h.settings = null;
    ingest.onVerdict("c1", "fail");
    await ingest.onStepEnded(step("e1", "c1", { finish: "stop" }));
    const entry = h.store().snapshot().entries[MEDIUM_KEY];
    expect(entry?.counts).toMatchObject({ pass: 1, fail: 0 });
    expect(entry?.cost.tokens.n).toBe(0);
  });
});

describe("registry lifetime", () => {
  it("TTL eviction stops ingestion", async () => {
    const h = harness();
    const ingest = h.make({ pricing: PRICED });
    dispatch("c1");
    await ingest.onStepEnded(step("e1", "c1", { finish: "stop" }));
    ingest.onExecutionEnded("c1");
    expect(h.store().cost(MEDIUM_KEY).steps.n).toBe(1);
    dispatch("c2");
    h.clock.t = T0 + 61 * 60_000;
    ingest.sweep();
    expect(lookupDispatch("c2")).toBeUndefined();
    await ingest.onStepEnded(step("e2", "c2", { finish: "stop" }));
    ingest.onVerdict("c2", "pass");
    expect(h.store().cost(MEDIUM_KEY).steps.n).toBe(1);
    expect(h.store().snapshot().entries[MEDIUM_KEY]?.counts.pass).toBe(0);
  });

  it("a step refreshes the child's idle stamp, so a long-running child survives the sweep", async () => {
    const h = harness();
    const ingest = h.make({ pricing: PRICED });
    dispatch("c1");
    h.clock.t = T0 + 50 * 60_000;
    await ingest.onStepEnded(step("e1", "c1", { finish: "tool-calls" }));
    h.clock.t = T0 + 90 * 60_000;
    ingest.sweep();
    expect(lookupDispatch("c1")).toBeDefined();
  });

  it("sweep folds an attempt that stopped without a final step", async () => {
    const h = harness();
    const ingest = h.make({ pricing: PRICED });
    dispatch("c1");
    await ingest.onStepEnded(step("e1", "c1", { finish: "tool-calls", cost: 0.02 }));
    expect(h.store().cost(MEDIUM_KEY).steps.n).toBe(0);
    h.clock.t = T0 + 31 * 60_000;
    touchDispatch("c1", h.clock.t);
    ingest.sweep();
    expect(h.store().cost(MEDIUM_KEY).steps.n).toBe(1);
  });

  it("onSessionGone folds the child's open attempt, forgets it, and ignores later steps", async () => {
    const h = harness();
    const ingest = h.make({ pricing: PRICED });
    dispatch("c1");
    await ingest.onStepEnded(step("e1", "c1", { finish: "tool-calls", cost: 0.02 }));
    ingest.onSessionGone("c1");
    expect(lookupDispatch("c1")).toBeUndefined();
    expect(h.store().cost(MEDIUM_KEY).steps.n).toBe(1);
    await ingest.onStepEnded(step("e2", "c1", { finish: "stop" }));
    expect(h.store().cost(MEDIUM_KEY).steps.n).toBe(1);
  });

  it("an orchestrator's deletion forgets and folds its children", async () => {
    const h = harness();
    const ingest = h.make({ pricing: PRICED });
    dispatch("c1", { parentSessionID: "root" });
    dispatch("c2", { parentSessionID: "other" });
    await ingest.onStepEnded(step("e1", "c1", { finish: "tool-calls" }));
    ingest.onSessionGone("root");
    expect(lookupDispatch("c1")).toBeUndefined();
    expect(lookupDispatch("c2")).toBeDefined();
    expect(h.store().cost(MEDIUM_KEY).steps.n).toBe(1);
  });
});

describe("attempt lifecycle (QA-2.1-6)", () => {
  const failedStep = (id: string, sessionID: string, data: Record<string, unknown>): IngestEvent => ({ id, type: "session.step.failed", data: { sessionID, assistantMessageID: `m-${id}`, ...data } });

  it("a non-tool-calls finish only sets the final output: the attempt stays open until the execution ends", async () => {
    const h = harness();
    const ingest = h.make({ pricing: PRICED });
    dispatch("c1");
    await ingest.onStepEnded(step("e1", "c1", { finish: "tool-calls", cost: 0.01, output: 10 }));
    await ingest.onStepEnded(step("e2", "c1", { finish: "length", cost: 0.01, output: 50 }));
    await ingest.onStepEnded(step("e3", "c1", { finish: "stop", cost: 0.01, output: 300 }));
    expect(h.store().cost(MEDIUM_KEY).steps.n).toBe(0);
    ingest.onExecutionEnded("c1");
    const cost = h.store().cost(MEDIUM_KEY);
    expect(cost.steps).toMatchObject({ n: 1, mean: 3 });
    expect(cost.finalMessageTokens).toMatchObject({ n: 1, mean: 300 }); // the last step, not the cut-off one
    expect(cost.measuredUSD.mean).toBeCloseTo(0.03, 9);
  });

  it("the end of an execution folds an attempt that never produced a final message", async () => {
    const h = harness();
    const ingest = h.make({ pricing: PRICED });
    dispatch("c1");
    await ingest.onStepEnded(step("e1", "c1", { finish: "tool-calls", cost: 0.02 }));
    ingest.onExecutionEnded("c1");
    const cost = h.store().cost(MEDIUM_KEY);
    expect(cost.steps).toMatchObject({ n: 1, mean: 1 });
    expect(cost.finalMessageTokens.n).toBe(0);
    // a step that arrives after the end belongs to a closed attempt
    await ingest.onStepEnded(step("e2", "c1", { finish: "stop" }));
    ingest.onExecutionEnded("c1");
    expect(h.store().cost(MEDIUM_KEY).steps.n).toBe(1);
  });

  it("ignores an execution end for a child that is not registered", () => {
    const h = harness();
    const ingest = h.make();
    ingest.onExecutionEnded("ghost");
    expect(h.bundles).toHaveLength(0);
  });

  it.each([
    { name: "a sweep after the idle limit", end: (ingest: Ingest, h: Harness) => { h.clock.t = T0 + 31 * 60_000; touchDispatch("c1", h.clock.t); ingest.sweep(); } },
    { name: "the child's session deletion", end: (ingest: Ingest) => { ingest.onSessionGone("c1"); } },
    { name: "a resume (the next attempt of the child)", end: async (ingest: Ingest) => { dispatch("c1"); await ingest.onStepEnded(step("e9", "c1", { finish: "tool-calls" })); } },
    { name: "dispose", end: async (ingest: Ingest) => { await ingest.dispose(); } },
  ])("a held final step is not lost when the end event never comes: $name", async ({ end }) => {
    const h = harness();
    const ingest = h.make({ pricing: PRICED });
    dispatch("c1");
    await ingest.onStepEnded(step("e1", "c1", { finish: "tool-calls", cost: 0.01, output: 10 }));
    await ingest.onStepEnded(step("e2", "c1", { finish: "stop", cost: 0.02, output: 300 }));
    expect(h.store().cost(MEDIUM_KEY).steps.n).toBe(0);
    await end(ingest, h);
    const cost = h.store().cost(MEDIUM_KEY);
    expect(cost.steps.n).toBeGreaterThanOrEqual(1);
    expect(cost.finalMessageTokens).toMatchObject({ n: 1, mean: 300 });
    expect(cost.measuredUSD.mean).toBeCloseTo(0.03, 9);
  });

  it("records the cost and tokens of a failed step when it has them, and nothing when it has neither", async () => {
    const h = harness();
    const ingest = h.make({ pricing: PRICED });
    dispatch("c1");
    await ingest.onStepEnded(step("e1", "c1", { finish: "tool-calls", cost: 0.01 }));
    await ingest.onStepEnded(failedStep("f0", "c1", { error: { message: "boom" } })); // nothing measured
    await ingest.onStepEnded(failedStep("f1", "c1", { cost: 0.03, tokens: { input: 500, output: 20, reasoning: 0, cache: { read: 0, write: 0 } } }));
    ingest.onExecutionEnded("c1");
    const cost = h.store().cost(MEDIUM_KEY);
    expect(cost.steps).toMatchObject({ n: 1, mean: 2 });
    expect(cost.measuredUSD.mean).toBeCloseTo(0.04, 9);
    expect(cost.tokens).toMatchObject({ input: 1500, output: 120 });
    expect(cost.finalMessageTokens.n).toBe(0); // a failed step is never a final message
  });
});

describe("hung catalog through the ingest (QA-2.1-R2-4)", () => {
  it("one list() call, one bounded wait, then later steps take no time at all", async () => {
    const h = harness();
    let lists = 0;
    const pricing = createCatalogPricing(() => { lists += 1; return new Promise<never>(() => {}); }, { now: () => h.clock.t, loadTimeoutMs: 25 });
    const ingest = h.make({ pricing });
    for (let i = 0; i < 4; i++) dispatch(`c${i}`);
    const first = performance.now();
    await ingest.onStepEnded(step("s0", "c0", { finish: "tool-calls" }));
    expect(performance.now() - first).toBeGreaterThanOrEqual(20);
    h.clock.t += 120_000;
    const later = performance.now();
    for (let i = 1; i < 4; i++) await ingest.onStepEnded(step(`s${i}`, `c${i}`, { finish: "tool-calls", cost: 0.01 }));
    expect(performance.now() - later).toBeLessThan(15);
    expect(lists).toBe(1);
    // the steps were recorded, as unpriced
    for (let i = 0; i < 4; i++) ingest.onExecutionEnded(`c${i}`);
    expect(h.store().cost(MEDIUM_KEY).steps.n).toBe(4);
  });
});

describe("shared held steps (QA-2.1-R2-1, QA-2.1-R2-8)", () => {
  const heldScenario = async (otherSettings: IngestSettings | null) => {
    const h = harness();
    const a = h.make({ pricing: PRICED });
    const other = h.make({ pricing: PRICED, settings: () => otherSettings });
    dispatch("c1");
    await a.onStepEnded(step("e1", "c1", { finish: "tool-calls", cost: 0.01, output: 10 }));
    await a.onStepEnded(step("e2", "c1", { finish: "stop", cost: 0.02, output: 300 }));
    expect(h.store().cost(MEDIUM_KEY).steps.n).toBe(0);
    h.clock.t = T0 + 31 * 60_000; // the held step is idle long enough for any sweep
    touchDispatch("c1", h.clock.t);
    other.sweep();
    return { h, a, other };
  };

  it.each([
    { name: "a static instance", settings: () => null },
    { name: "an instance that writes to another directory", settings: () => ({ engine: "shadow", minClassConfidence: 0.7, outcomesDir: join(tmpdir(), "omr-ingest-elsewhere-never-created"), tuning: DEFAULT_OUTCOME_TUNING, routerAgentIds: new Set(["medium"]) } satisfies IngestSettings) },
  ])("$name sweeping does not drop or settle another instance's held final step", async ({ settings }) => {
    const { h, a } = await heldScenario(settings());
    expect(h.store().cost(MEDIUM_KEY).steps.n).toBe(0); // still held, not settled by the stranger
    a.onExecutionEnded("c1"); // the owner ends the attempt: nothing was lost
    const cost = h.store().cost(MEDIUM_KEY);
    expect(cost.steps).toMatchObject({ n: 1, mean: 2 });
    expect(cost.finalMessageTokens).toMatchObject({ n: 1, mean: 300 });
  });

  it("an instance that can reach the store settles it at the idle limit; the owner then finds nothing left and folds nothing twice", async () => {
    const h = harness();
    const a = h.make({ pricing: PRICED });
    const b = h.make({ pricing: PRICED }); // same directory
    dispatch("c1");
    await a.onStepEnded(step("e1", "c1", { finish: "stop", cost: 0.02, output: 300 }));
    h.clock.t = T0 + 31 * 60_000;
    touchDispatch("c1", h.clock.t);
    b.sweep();
    expect(h.store().cost(MEDIUM_KEY).steps.n).toBe(1);
    a.sweep(); // stale ownership keys are dropped, nothing is recorded again
    await a.dispose();
    expect(h.store().cost(MEDIUM_KEY).steps.n).toBe(1);
  });
});

describe("a registration that changes while its step waits for pricing (QA-2.1-R2-11)", () => {
  it("skips the step instead of giving it to the new attempt", async () => {
    const h = harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ingest = h.make({ pricing: async () => { await gate; return [{ input: 3, output: 15 }]; } });
    dispatch("c1");
    const waiting = ingest.onStepEnded(step("e1", "c1", { finish: "stop", cost: 0.05 }));
    dispatch("c1"); // resumed while the old attempt's last step is still waiting
    release();
    await waiting;
    ingest.onExecutionEnded("c1");
    expect(h.bundles).toHaveLength(0); // nothing was recorded for either attempt, and no bundle was needed
    // the new attempt records normally
    await ingest.onStepEnded(step("e2", "c1", { finish: "stop", cost: 0.02 }));
    ingest.onExecutionEnded("c1");
    expect(h.store().cost(MEDIUM_KEY)).toMatchObject({ steps: { n: 1, mean: 1 } });
    expect(h.store().cost(MEDIUM_KEY).measuredUSD.mean).toBeCloseTo(0.02, 9);
  });
});

describe("ingestion switched off at runtime (QA-2.1-11)", () => {
  it.each(["sweep", "requestFlush"] as const)("%s releases the bundle once the settings resolve to null, and the data is flushed", async (trigger) => {
    const h = harness();
    const ingest = h.make({ pricing: PRICED });
    dispatch("c1");
    await ingest.onStepEnded(step("e1", "c1", { finish: "stop", cost: 0.02 }));
    h.settings = null;
    ingest[trigger]();
    await vi.waitFor(() => expect(existsSync(join(h.dir, "outcomes.json"))).toBe(true)); // the last holder's release flushed
    expect(h.store().cost(MEDIUM_KEY).steps.n).toBe(1); // the held final step was folded first
    // later signals do nothing while off
    dispatch("c2");
    ingest.onVerdict("c2", "pass");
    expect(h.bundles).toHaveLength(1);
    // and recording resumes with a fresh holder when it is switched back on
    h.settings = { engine: "shadow", minClassConfidence: 0.7, outcomesDir: h.dir, tuning: DEFAULT_OUTCOME_TUNING, routerAgentIds: new Set(["medium"]) };
    ingest.onVerdict("c2", "pass");
    expect(h.bundles).toHaveLength(2);
  });
});

describe("unkeyable warnings (QA-2.1-12)", () => {
  it("warns once per model reference, not per child", () => {
    const h = harness();
    const ingest = h.make();
    for (const child of ["a", "b", "c"]) dispatch(child, { model: null, agent: "ghost" });
    dispatch("d", { model: null, agent: "other" });
    for (const child of ["e", "f"]) dispatch(child, { model: "not-a-reference", agent: "ghost" });
    for (const child of ["a", "b", "c", "d", "e", "f"]) ingest.onVerdict(child, "pass");
    ingest.onVerdict("a", "pass");
    expect(h.warnings.filter((w) => w.includes("not recorded"))).toHaveLength(3);
    expect(h.bundles).toHaveLength(0);
  });
});

describe("flush scheduling (D15)", () => {
  it("coalesces many rows and many requests into one scheduled flush, written on the timer", async () => {
    const h = harness();
    const ingest = h.make({ pricing: PRICED });
    for (let i = 0; i < 20; i++) {
      dispatch(`c${i}`);
      ingest.onVerdict(`c${i}`, i % 2 === 0 ? "pass" : "fail");
      ingest.requestFlush();
    }
    ingest.onSessionGone("c0");
    expect(h.timers).toHaveLength(1);
    // nothing has been written on the signal path
    expect(existsSync(join(h.dir, "decisions.jsonl"))).toBe(false);
    expect(existsSync(join(h.dir, "outcomes.json"))).toBe(false);
    h.timers[0]!.fn();
    await h.bundles[0]!.flusher.flushNow();
    expect(existsSync(join(h.dir, "outcomes.json"))).toBe(true);
    expect((await h.bundles[0]!.persister.readRows()).rows.filter((r) => r.kind === "verdict")).toHaveLength(20);
    expect(h.timers.length).toBeLessThanOrEqual(2);
  });

  it("requestFlush before any recorded signal does nothing", () => {
    const h = harness();
    const ingest = h.make();
    ingest.requestFlush();
    expect(h.bundles).toHaveLength(0);
    expect(h.timers).toHaveLength(0);
  });

  it("dispose flushes what is pending and releases the bundle", async () => {
    const h = harness();
    const ingest = h.make();
    dispatch("c1");
    ingest.onVerdict("c1", "pass");
    await ingest.dispose();
    expect(existsSync(join(h.dir, "outcomes.json"))).toBe(true);
    // idempotent, and later signals are ignored
    await ingest.dispose();
    ingest.onVerdict("c1", "fail");
    expect(h.bundles).toHaveLength(1);
  });

  it("follows a changed outcomes directory", () => {
    const h = harness();
    const ingest = h.make();
    dispatch("c1");
    ingest.onVerdict("c1", "pass");
    const second = mkdtempSync(join(tmpdir(), "omr-ingest-"));
    dirs.push(second);
    h.settings = { ...h.settings!, outcomesDir: second };
    dispatch("c2");
    ingest.onVerdict("c2", "pass");
    expect(h.bundles.map((b) => b.dir)).toEqual([h.dir, second]);
  });
});

describe("catalog pricing lookup", () => {
  it("shares one in-flight load, serves a loaded table at once, and reloads in the background after the TTL", async () => {
    const clock = { t: T0 };
    let loads = 0;
    const lookup = createCatalogPricing(async () => { loads += 1; return [{ providerID: "p", id: "m", cost: [{ input: loads, output: 2 }] }]; }, { now: () => clock.t, ttlMs: 1000 });
    const results = await Promise.all([lookup("p", "m"), lookup("p", "m"), lookup("p", "other")]);
    expect(loads).toBe(1);
    expect(results[0]).toEqual([{ input: 1, output: 2 }]);
    expect(results[2]).toBeUndefined();
    await lookup("p", "m");
    expect(loads).toBe(1);
    clock.t += 1000;
    // stale-while-revalidate: the old table answers immediately, the reload runs behind it
    expect(await lookup("p", "m")).toEqual([{ input: 1, output: 2 }]);
    await vi.waitFor(() => expect(loads).toBe(2));
    expect(await lookup("p", "m")).toEqual([{ input: 2, output: 2 }]);
  });

  it("a failed load is logged once, treated as unpriced, and retried after the back-off", async () => {
    const clock = { t: T0 };
    const warnings: string[] = [];
    let loads = 0;
    const lookup = createCatalogPricing(async () => { loads += 1; if (loads === 1) throw new Error("no catalog"); return [{ providerID: "p", id: "m", cost: [{ input: 1, output: 2 }] }]; }, {
      now: () => clock.t, retryMs: 5000, logger: { warn: (m) => { warnings.push(m); } },
    });
    expect(await lookup("p", "m")).toBeUndefined();
    expect(await lookup("p", "m")).toBeUndefined();
    expect(loads).toBe(1);
    expect(warnings).toHaveLength(1);
    clock.t += 5000;
    expect(await lookup("p", "m")).toEqual([{ input: 1, output: 2 }]);
  });

  it("QA-2.1-2: lookups with the same cache key share one table and one load, process-wide; other keys do not", async () => {
    let loadsA = 0;
    let loadsB = 0;
    let loadsC = 0;
    const entry = [{ providerID: "p", id: "m", cost: [{ input: 1, output: 2 }] }];
    const a = createCatalogPricing(async () => { loadsA += 1; return entry; }, { cacheKey: "/project" });
    const b = createCatalogPricing(async () => { loadsB += 1; return entry; }, { cacheKey: "/project" });
    const c = createCatalogPricing(async () => { loadsC += 1; return entry; }, { cacheKey: "/other" });
    await Promise.all([a("p", "m"), b("p", "m"), c("p", "m")]);
    await b("p", "m");
    expect([loadsA, loadsB, loadsC]).toEqual([1, 0, 1]);
    // a lookup created after a reset starts from an empty cache
    resetCatalogPricing();
    let loadsD = 0;
    const d = createCatalogPricing(async () => { loadsD += 1; return entry; }, { cacheKey: "/project" });
    await d("p", "m");
    expect(loadsD).toBe(1);
  });

  it("QA-2.1-5: a catalog that never answers costs one bounded wait, then lookups answer unpriced at once", async () => {
    const clock = { t: T0 };
    const warnings: string[] = [];
    let loads = 0;
    const lookup = createCatalogPricing(() => { loads += 1; return new Promise<never>(() => {}); }, {
      now: () => clock.t, loadTimeoutMs: 20, retryMs: 5000, logger: { warn: (m) => { warnings.push(m); } },
    });
    const started = performance.now();
    expect(await lookup("p", "m")).toBeUndefined();
    expect(performance.now() - started).toBeGreaterThanOrEqual(15);
    const second = performance.now();
    expect(await lookup("p", "m")).toBeUndefined();
    expect(performance.now() - second).toBeLessThan(15);
    expect(loads).toBe(1);
    expect(warnings).toHaveLength(1);
    // QA-2.1-R2-4: the hung load stays pending; no second list() starts behind it, whatever the back-off says, and
    // nobody waits for it again
    clock.t += 60_000;
    const third = performance.now();
    expect(await lookup("p", "m")).toBeUndefined();
    expect(performance.now() - third).toBeLessThan(15);
    expect(loads).toBe(1);
  });

  it("QA-2.1-R2-4: after one timeout no lookup waits again until a load succeeds, even when later loads are slow too", async () => {
    const clock = { t: T0 };
    let loads = 0;
    let resolveSecond!: (models: Array<{ providerID: string; id: string; cost: unknown }>) => void;
    const lookup = createCatalogPricing(() => {
      loads += 1;
      if (loads === 1) return Promise.reject(new Error("first load fails"));
      return new Promise((resolve) => { resolveSecond = resolve; });
    }, { now: () => clock.t, loadTimeoutMs: 20, retryMs: 5000 });
    expect(await lookup("p", "m")).toBeUndefined(); // the first load fails at once
    clock.t += 5000;
    const slow = performance.now();
    expect(await lookup("p", "m")).toBeUndefined(); // a second load starts and is slow: this waits once, up to the timeout
    expect(performance.now() - slow).toBeGreaterThanOrEqual(15);
    expect(loads).toBe(2);
    clock.t += 60_000;
    const after = performance.now();
    expect(await lookup("p", "m")).toBeUndefined();
    expect(performance.now() - after).toBeLessThan(15);
    resolveSecond([{ providerID: "p", id: "m", cost: [{ input: 1, output: 2 }] }]);
    await vi.waitFor(async () => { expect(await lookup("p", "m")).toEqual([{ input: 1, output: 2 }]); });
    expect(loads).toBe(2);
  });

  it("QA-2.1-5: an abort releases a waiting lookup at once, without cancelling the shared load", async () => {
    const abort = new AbortController();
    let resolveList!: (models: Array<{ providerID: string; id: string; cost: unknown }>) => void;
    const lookup = createCatalogPricing(() => new Promise((resolve) => { resolveList = resolve; }), { signal: abort.signal, loadTimeoutMs: 60_000 });
    const waiting = lookup("p", "m");
    abort.abort();
    expect(await waiting).toBeUndefined();
    expect(await lookup("p", "m")).toBeUndefined(); // already aborted: no wait at all
    resolveList([{ providerID: "p", id: "m", cost: [{ input: 1, output: 2 }] }]);
    await vi.waitFor(async () => { expect(await lookup("p", "m")).toEqual([{ input: 1, output: 2 }]); });
  });
});
describe("throughput", () => {
  it("ingests 1 000 step events in under 100 ms", async () => {
    const h = harness();
    let loads = 0;
    const pricing = createCatalogPricing(async () => { loads += 1; return [{ providerID: "anthropic", id: "claude-sonnet-5-5", cost: [{ input: 3, output: 15 }] }]; }, { now: () => h.clock.t });
    const ingest = h.make({ pricing });
    for (let i = 0; i < 10; i++) dispatch(`c${i}`);
    // warm up: acquire the bundle and load the catalog outside the measured window
    await ingest.onStepEnded(step("warm", "c0", { finish: "tool-calls" }));
    const events: IngestEvent[] = [];
    for (let i = 0; i < 1000; i++) events.push(step(`bulk-${i}`, `c${i % 10}`, { finish: i % 50 === 49 ? "stop" : "tool-calls" }));
    const started = performance.now();
    for (const event of events) await ingest.onStepEnded(event);
    const elapsed = performance.now() - started;
    expect(loads).toBe(1);
    expect(elapsed).toBeLessThan(100);
    for (let i = 0; i < 10; i++) ingest.onExecutionEnded(`c${i}`);
    expect(h.store().keys()).toEqual([MEDIUM_KEY as OutcomeKey]);
    expect(h.store().cost(MEDIUM_KEY).tokens.n).toBeGreaterThan(0);
  });
});

describe("last-step context for the delegate ladder (Phase 2.3, D11)", () => {
  function stepWithTokens(id: string, sessionID: string, tokens: { input: number; output: number; cache?: { read?: number; write?: number } }): IngestEvent {
    return {
      id,
      type: "session.step.ended",
      data: { sessionID, assistantMessageID: `m-${id}`, finish: "tool-calls", cost: 0.01, tokens: { reasoning: 0, cache: { read: 0, write: 0 }, ...tokens } },
    };
  }

  it("keeps input + cache.read + cache.write + output of the largest step, readable once the execution end was seen (QA-2.3-2)", async () => {
    const h = harness();
    const ingest = h.make({ pricing: PRICED });
    dispatch("c1");
    expect(lastStepContext("c1")).toBeNull();
    await ingest.onStepEnded(stepWithTokens("t1", "c1", { input: 1000, output: 100, cache: { read: 400, write: 50 } }));
    // steps recorded, no execution end yet: the final, largest step may still be queued, so the number is not trusted
    expect(lastStepContext("c1")).toBeNull();
    ingest.onExecutionEnded("c1");
    expect(lastStepContext("c1")).toBe(1550);
  });

  it("is noted in every engine mode: the settings gate (static) does not apply and nothing is written", async () => {
    const h = harness();
    h.settings = null; // routing.engine static
    const ingest = h.make({ pricing: PRICED });
    dispatch("c1");
    await ingest.onStepEnded(stepWithTokens("t1", "c1", { input: 2000, output: 500 }));
    ingest.onExecutionEnded("c1");
    expect(lastStepContext("c1")).toBe(2500);
    expect(h.bundles).toHaveLength(0);
    expect(readdirSync(h.dir)).toEqual([]);
  });

  it("an execution end of an unregistered session is ignored, and so are an unregistered session's and a failed step", async () => {
    const h = harness();
    const ingest = h.make({ pricing: PRICED });
    await ingest.onStepEnded(stepWithTokens("t1", "ghost", { input: 10, output: 1 }));
    ingest.onExecutionEnded("ghost");
    expect(lastStepContext("ghost")).toBeNull();
    dispatch("c1");
    await ingest.onStepEnded({ id: "f1", type: "session.step.failed", data: { sessionID: "c1", cost: 0.01, tokens: { input: 9000, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } } });
    ingest.onExecutionEnded("c1");
    expect(lastStepContext("c1")).toBeNull(); // ended, but no step was noted
  });

  it("the largest step of a registration wins, so a duplicate delivery of an older step cannot lower it", async () => {
    const h = harness();
    const ingest = h.make({ pricing: PRICED });
    dispatch("c1");
    await ingest.onStepEnded(stepWithTokens("t1", "c1", { input: 1000, output: 100 }));
    await ingest.onStepEnded(stepWithTokens("t2", "c1", { input: 3000, output: 200 }));
    await ingest.onStepEnded(stepWithTokens("t1-again", "c1", { input: 1000, output: 100 }));
    ingest.onExecutionEnded("c1");
    expect(lastStepContext("c1")).toBe(3200);
  });

  it("a re-registration (a resume or a ladder attempt) starts from null and not ended", async () => {
    const h = harness();
    const ingest = h.make({ pricing: PRICED });
    dispatch("c1");
    await ingest.onStepEnded(stepWithTokens("t1", "c1", { input: 5000, output: 100 }));
    ingest.onExecutionEnded("c1");
    expect(lastStepContext("c1")).toBe(5100);
    dispatch("c1"); // the same child, next attempt
    expect(lastStepContext("c1")).toBeNull();
    await ingest.onStepEnded(stepWithTokens("t2", "c1", { input: 6000, output: 100 }));
    expect(lastStepContext("c1")).toBeNull(); // the first execution's end does not count for this registration
    ingest.onExecutionEnded("c1");
    expect(lastStepContext("c1")).toBe(6100);
  });

  it("ignores malformed token payloads, and noteStepContext ignores non-finite, negative and unknown input", async () => {
    const h = harness();
    const ingest = h.make({ pricing: PRICED });
    dispatch("c1");
    await ingest.onStepEnded({ id: "t1", type: "session.step.ended", data: { sessionID: "c1", cost: 0, tokens: { input: "many", output: 1 } } });
    await ingest.onStepEnded({ id: "t2", type: "session.step.ended", data: { sessionID: "c1", cost: 0 } });
    ingest.onExecutionEnded("c1");
    expect(lastStepContext("c1")).toBeNull();
    noteStepContext("c1", Number.NaN);
    noteStepContext("c1", -1);
    noteStepContext("ghost", 10);
    expect(lastStepContext("c1")).toBeNull();
    expect(lastStepContext("ghost")).toBeNull();
    noteStepContext("c1", 0);
    expect(lastStepContext("c1")).toBe(0);
  });

  it("noting a step or an end refreshes the idle stamp, so a long-running child is not swept", () => {
    dispatch("c1");
    noteStepContext("c1", 10, T0 + 3_000_000);
    expect(sweepDispatches(T0 + 3_000_000 + 60_000, 3_600_000)).toBe(0);
    dispatch("c2");
    noteExecutionEnded("c2", T0 + 3_000_000);
    expect(sweepDispatches(T0 + 3_000_000 + 60_000, 3_600_000)).toBe(0);
    expect(lookupDispatch("c1")).toBeDefined();
    expect(lookupDispatch("c2")).toBeDefined();
  });
});

describe("awaitExecutionEnd (QA-2.3-2): the runner's bounded, abortable barrier", () => {
  it("resolves true at once when the end was already seen, false for an unregistered child", async () => {
    dispatch("c1");
    noteExecutionEnded("c1");
    await expect(awaitExecutionEnd("c1", 1_000)).resolves.toBe(true);
    await expect(awaitExecutionEnd("ghost", 1_000)).resolves.toBe(false);
  });

  it("resolves true when the end arrives while waiting, and the context is then readable", async () => {
    dispatch("c1");
    noteStepContext("c1", 321);
    const waiting = awaitExecutionEnd("c1", 5_000);
    expect(lastStepContext("c1")).toBeNull();
    noteExecutionEnded("c1");
    await expect(waiting).resolves.toBe(true);
    expect(lastStepContext("c1")).toBe(321);
  });

  it("times out with false and leaves the child unread (fresh start)", async () => {
    vi.useFakeTimers();
    try {
      dispatch("c1");
      noteStepContext("c1", 321);
      const waiting = awaitExecutionEnd("c1", 1_000);
      await vi.advanceTimersByTimeAsync(999);
      let settled = false;
      void waiting.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      await expect(waiting).resolves.toBe(false);
      expect(lastStepContext("c1")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("an abort ends the wait with false, an already aborted signal does not wait at all, and no timer is left behind", async () => {
    vi.useFakeTimers();
    try {
      dispatch("c1");
      const controller = new AbortController();
      const waiting = awaitExecutionEnd("c1", 60_000, controller.signal);
      controller.abort();
      await expect(waiting).resolves.toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      await expect(awaitExecutionEnd("c1", 60_000, controller.signal)).resolves.toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a registration that is replaced or forgotten releases the waiter with false", async () => {
    dispatch("c1");
    const replaced = awaitExecutionEnd("c1", 60_000);
    dispatch("c1");
    await expect(replaced).resolves.toBe(false);
    const forgotten = awaitExecutionEnd("c1", 60_000);
    forgetDispatch("c1");
    await expect(forgotten).resolves.toBe(false);
    dispatch("c2");
    const reset = awaitExecutionEnd("c2", 60_000);
    resetDispatchRegistry();
    await expect(reset).resolves.toBe(false);
  });

  it("a non-positive timeout does not wait", async () => {
    dispatch("c1");
    await expect(awaitExecutionEnd("c1", 0)).resolves.toBe(false);
  });
});