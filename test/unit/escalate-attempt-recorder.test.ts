// Phase 2.3: the delegate ladder's attempt recorder. Temp directories only; the real trajectory directory is never touched.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyDelegation,
  createAttemptRecorder,
  describeAttempt,
  type AttemptRecord,
} from "../../src/escalate/attempt-recorder";
import type { AttemptPlan } from "../../src/escalate/resume";
import { lastStepContext, lookupDispatch, resetDispatchRegistry } from "../../src/router/sessions";
import { createIngest, ingestSettings, resetIngestState } from "../../src/routing/outcomes/ingest";
import type { RouterConfig } from "../../src/router/config";
import {
  acquireOutcomes,
  nodePersistDeps,
  type AcquireOutcomesOptions,
  type DecisionRow,
  type FlushScheduler,
  type OutcomesBundle,
} from "../../src/routing/outcomes";

const T0 = Date.UTC(2026, 9, 6, 12, 0, 0);
const dirs: string[] = [];

function config(routing: RouterConfig["routing"] | undefined, outcomesDir?: string): RouterConfig {
  const tier = (model: string, variant: string, costRatio: number) => ({ model, variant, costRatio, description: "t", whenToUse: ["t"] });
  return {
    activePreset: "p",
    presets: { p: { fast: tier("anthropic/claude-sonnet-5-5", "low", 1), medium: tier("anthropic/claude-sonnet-5-5", "medium", 5) } },
    rules: [],
    defaultTier: "fast",
    ...(routing === undefined ? {} : { routing: { ...routing, ...(outcomesDir === undefined ? {} : { outcomes: { path: outcomesDir } }) } }),
  } as RouterConfig;
}

const FACTS = { class: "implement", risk: "medium", scope: "single", needs: [] as string[], confidence: 0.9, source: "rules" };

function plan(over: Partial<AttemptPlan> = {}): AttemptPlan {
  return {
    step: "variant", tier: "fast", agent: "fast",
    model: { providerID: "anthropic", modelID: "claude-sonnet-5-5", variant: "medium" },
    variant: "medium", ...over,
  };
}

function attempt(over: Partial<AttemptRecord> = {}): AttemptRecord {
  return { childSessionID: "c1", parentSessionID: "root", plan: plan(), facts: FACTS, acceptance: "grader", resumed: true, ...over };
}

interface Harness {
  readonly warnings: string[];
  readonly logger: { warn(message: string): void };
  readonly timers: Array<{ fn: () => void; ms: number }>;
  readonly bundles: OutcomesBundle[];
  readonly outcomes: string;
  readonly acquire: (options: AcquireOutcomesOptions) => OutcomesBundle;
  rows(): Promise<DecisionRow[]>;
}

function harness(): Harness {
  const outcomes = mkdtempSync(join(tmpdir(), "omr-attempts-"));
  dirs.push(outcomes);
  const warnings: string[] = [];
  const timers: Harness["timers"] = [];
  const bundles: OutcomesBundle[] = [];
  const logger = { warn: (message: string) => { warnings.push(message); } };
  const scheduler: FlushScheduler = {
    setTimer(fn, ms) { const slot = { fn, ms }; timers.push(slot); return slot; },
    clearTimer() { /* never fires in these tests */ },
  };
  const acquire = (options: AcquireOutcomesOptions): OutcomesBundle => {
    const bundle = acquireOutcomes({ ...options, deps: { ...nodePersistDeps(logger), now: () => T0 }, scheduler });
    bundles.push(bundle);
    return bundle;
  };
  return {
    warnings, logger, timers, bundles, outcomes, acquire,
    async rows() {
      const bundle = bundles[0];
      if (bundle === undefined) throw new Error("no bundle");
      await bundle.flusher.flushNow();
      return (await bundle.persister.readRows()).rows.filter((row): row is DecisionRow => row.kind === "decision");
    },
  };
}

beforeEach(() => { resetDispatchRegistry(); resetIngestState(); });
afterEach(() => {
  resetDispatchRegistry();
  resetIngestState();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe("createAttemptRecorder", () => {
  it("registers a pending resume before execution, but enqueues its row only once identity is confirmed", async () => {
    const h = harness();
    const recorder = createAttemptRecorder({ host: "v2", config: () => config({ engine: "shadow" }, h.outcomes), logger: h.logger, acquire: h.acquire });
    try {
      const confirm = recorder.record(attempt(), true);
      const decisionID = lookupDispatch("c1")?.decisionID;
      expect(decisionID).toBeTruthy();
      expect(await h.rows()).toEqual([]);
      confirm();
      confirm();
      expect(await h.rows()).toMatchObject([{ decisionID, resume: true }]);
    } finally {
      await recorder.dispose();
    }
  });

  it("a rejected resume followed by a fresh child has no phantom resume row", async () => {
    const h = harness();
    const recorder = createAttemptRecorder({ host: "v2", config: () => config({ engine: "shadow" }, h.outcomes), logger: h.logger, acquire: h.acquire });
    try {
      recorder.record(attempt(), true); // early registration is never confirmed by the host
      recorder.record(attempt({ childSessionID: "fresh", resumed: false }));
      expect(await h.rows()).toMatchObject([{ childSessionID: "fresh", resume: false }]);
      expect(await h.rows()).toHaveLength(1);
    } finally {
      await recorder.dispose();
    }
  });

  it("registers the attempt under its step label and writes one decision row when the engine is live", async () => {
    const h = harness();
    const recorder = createAttemptRecorder({ host: "v2", config: () => config({ engine: "shadow" }, h.outcomes), logger: h.logger, acquire: h.acquire, now: () => T0 });
    try {
      expect(recorder.engineLive()).toBe(true);
      recorder.record(attempt({
        plan: plan({ resumeBasis: { resume: true, reason: "under-threshold", tokens: 1_500, budget: 1_000_000, threshold: 600_000 }, costRatio: 5 }),
      }));
      expect(lookupDispatch("c1")).toMatchObject({ step: "variant", agent: "fast", tier: "fast", variant: "medium", model: "anthropic/claude-sonnet-5-5", parentSessionID: "root", acceptance: "grader" });
      const rows = await h.rows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: "decision", mode: "shadow", step: "variant", resume: true, childSessionID: "c1", sessionID: "root",
        switched: false, pinned: false, best: null, unit: "ratio", costs: {}, confidence: 0.9,
        chosen: { agent: "fast", origin: "router", model: "anthropic/claude-sonnet-5-5", variant: "medium" },
      });
      expect(rows[0]!.decisionID).toBe(lookupDispatch("c1")?.decisionID);
      expect(rows[0]!.reason).toBe("ladder variant on fast; resumed child; D11 under-threshold (tokens=1500 budget=1000000 threshold=600000); rung costRatio 5");
    } finally {
      await recorder.dispose();
    }
  });

  it("engine static: the attempt is registered (the ladder reads its step context) but nothing is acquired or written", async () => {
    const h = harness();
    const recorder = createAttemptRecorder({ host: "v2", config: () => config({}, h.outcomes), logger: h.logger, acquire: h.acquire });
    expect(recorder.engineLive()).toBe(false);
    recorder.record(attempt());
    expect(lookupDispatch("c1")).toMatchObject({ step: "variant", decisionID: null });
    expect(lastStepContext("c1")).toBeNull();
    expect(h.bundles).toHaveLength(0);
    expect(readdirSync(h.outcomes)).toEqual([]);
    await recorder.dispose();
  });

  it("a delegation whose model did not resolve is registered with a null model and writes no row", async () => {
    const h = harness();
    const recorder = createAttemptRecorder({ host: "v2", config: () => config({ engine: "advise" }, h.outcomes), logger: h.logger, acquire: h.acquire });
    recorder.record(attempt({ plan: { step: "dispatch", tier: "fast", agent: "fast" }, resumed: false }));
    expect(lookupDispatch("c1")).toMatchObject({ model: null, step: "dispatch" });
    expect(h.bundles).toHaveLength(0);
    await recorder.dispose();
  });

  it("every attempt of one child is a new registration with its own attempt id and decision id", async () => {
    const h = harness();
    const recorder = createAttemptRecorder({ host: "v2", config: () => config({ engine: "enforce" }, h.outcomes), logger: h.logger, acquire: h.acquire });
    try {
      const ids: Array<[string, string | null]> = [];
      for (const step of ["dispatch", "variant", "retry", "escalate"] as const) {
        recorder.record(attempt({ plan: plan({ step }), resumed: step !== "dispatch" }));
        const record = lookupDispatch("c1");
        ids.push([record!.attemptId, record!.decisionID]);
      }
      expect(new Set(ids.map(([attemptId]) => attemptId)).size).toBe(4);
      expect(new Set(ids.map(([, decisionID]) => decisionID)).size).toBe(4);
      const rows = await h.rows();
      expect(rows.map((r) => [r.step, r.resume, r.mode])).toEqual([["dispatch", false, "enforce"], ["variant", true, "enforce"], ["retry", true, "enforce"], ["escalate", true, "enforce"]]);
    } finally {
      await recorder.dispose();
    }
  });

  it("an engine switched back to static releases the bundle at the next sweep and records again when it returns", async () => {
    const h = harness();
    let current = config({ engine: "shadow" }, h.outcomes);
    const recorder = createAttemptRecorder({ host: "v2", config: () => current, logger: h.logger, acquire: h.acquire });
    try {
      recorder.record(attempt());
      expect(h.bundles).toHaveLength(1);
      current = config({}, h.outcomes);
      recorder.sweep();
      recorder.record(attempt({ childSessionID: "c2" }));
      expect(h.bundles).toHaveLength(1); // static: nothing acquired
      current = config({ engine: "shadow" }, h.outcomes);
      recorder.record(attempt({ childSessionID: "c3" }));
      expect(h.bundles).toHaveLength(2); // a fresh holder
    } finally {
      await recorder.dispose();
    }
  });

  it("a failing acquire is logged and never thrown; the registry entry is kept", async () => {
    const h = harness();
    const recorder = createAttemptRecorder({
      host: "v2", config: () => config({ engine: "shadow" }, h.outcomes), logger: { warn: (m: string) => { h.warnings.push(m); } },
      acquire: () => { throw new Error("disk full"); },
    });
    expect(() => recorder.record(attempt())).not.toThrow();
    expect(h.warnings.some((w) => w.includes("registering an attempt failed"))).toBe(true);
    expect(lookupDispatch("c1")).toBeDefined();
    await expect(recorder.dispose()).resolves.toBeUndefined();
  });

  it("a throwing config reader degrades to not-live, and dispose is idempotent and stops recording", async () => {
    const h = harness();
    const logger = { warn: (m: string) => { h.warnings.push(m); } };
    const broken = createAttemptRecorder({ host: "v2", config: () => { throw new Error("config gone"); }, logger });
    expect(broken.engineLive()).toBe(false);
    expect(h.warnings.some((w) => w.includes("reading the routing settings failed"))).toBe(true);
    const recorder = createAttemptRecorder({ host: "v2", config: () => config({ engine: "shadow" }, h.outcomes), logger, acquire: h.acquire });
    await recorder.dispose();
    await recorder.dispose();
    recorder.record(attempt());
    expect(h.bundles).toHaveLength(0);
  });

  it("v1 hosts have no settings: nothing is ever written", () => {
    const h = harness();
    const recorder = createAttemptRecorder({ host: "v1", config: () => config({ engine: "shadow" }, h.outcomes), logger: h.logger, acquire: h.acquire });
    expect(recorder.engineLive()).toBe(false);
    recorder.record(attempt());
    expect(h.bundles).toHaveLength(0);
  });
});

describe("QA-2.3-11: the configuration of the delegation decides", () => {
  it("record() and engineLive() use the runner's active config, not the recorder's own", async () => {
    const h = harness();
    const live = config({ engine: "shadow" }, h.outcomes);
    const off = config({}, h.outcomes);
    const recorder = createAttemptRecorder({ host: "v2", config: () => off, logger: h.logger, acquire: h.acquire, now: () => T0 });
    try {
      expect(recorder.engineLive()).toBe(false);
      expect(recorder.engineLive(live)).toBe(true);
      recorder.record(attempt({ childSessionID: "hot", config: live }));
      expect(lookupDispatch("hot")?.outcomes).toBe(true);
      expect(await h.rows()).toHaveLength(1);
      const reverse = createAttemptRecorder({ host: "v2", config: () => live, logger: h.logger, acquire: h.acquire });
      reverse.record(attempt({ childSessionID: "cold", config: off }));
      expect(lookupDispatch("cold")?.outcomes).toBe(false);
      expect(h.bundles).toHaveLength(1); // the second recorder acquired nothing
      await reverse.dispose();
    } finally {
      await recorder.dispose();
    }
  });
});

describe("describeAttempt", () => {
  it("states the step, the child, the D11 numbers and a runner override", () => {
    expect(describeAttempt(attempt({ resumed: false, plan: plan({ step: "escalate", tier: "medium", fresh: "effort-path", resumeBasis: { resume: true, reason: "under-threshold", tokens: null, budget: 10, threshold: 6 } }) })))
      .toBe("ladder escalate on medium; fresh child; D11 under-threshold (budget=10 threshold=6); runner: fresh (effort-path)");
    expect(describeAttempt(attempt({ resumed: false, plan: plan({ step: "dispatch" }) }))).toBe("ladder dispatch on fast; fresh child");
  });
});

describe("classifyDelegation", () => {
  it("returns the rules facts and the detection depth of the acceptance block, never calling a backend", async () => {
    const warnings: string[] = [];
    const result = await classifyDelegation(config({}), "v2", "Fix the failing unit test in src/a.ts", "[acceptance]\ncheck: testsPass\n[/acceptance]", { warn: (m) => { warnings.push(m); } });
    expect(result).not.toBeNull();
    expect(result?.facts.source).not.toMatch(/host|openai|typesafe/);
    expect(result?.facts.confidence).toBeGreaterThanOrEqual(0);
    expect(warnings).toEqual([]);
  });

  it("never throws: a broken config yields null and a warning", async () => {
    const warnings: string[] = [];
    const broken = { get routing(): never { throw new Error("boom"); } } as unknown as RouterConfig;
    await expect(classifyDelegation(broken, "v2", "task", undefined, { warn: (m) => { warnings.push(m); } })).resolves.toBeNull();
    expect(warnings.some((w) => w.includes("classifying the delegation failed"))).toBe(true);
  });
});

describe("QA-2.3-6: attempts registered while ingestion is off are not scored by another instance", () => {
  it("a static recorder marks its attempts; a shadow ingest (another location's plugin instance) skips them and still sees the context", async () => {
    const h = harness();
    const staticRecorder = createAttemptRecorder({ host: "v2", config: () => config({}, h.outcomes), logger: h.logger, acquire: h.acquire });
    const shadowConfig = config({ engine: "shadow" }, h.outcomes);
    const shadowRecorder = createAttemptRecorder({ host: "v2", config: () => shadowConfig, logger: h.logger, acquire: h.acquire, now: () => T0 });
    const ingest = createIngest({ settings: () => ingestSettings(shadowConfig, "v2"), logger: h.logger, acquire: h.acquire, now: () => T0 });
    try {
      staticRecorder.record(attempt({ childSessionID: "off-1", plan: plan({ agent: "fast", tier: "fast" }) }));
      shadowRecorder.record(attempt({ childSessionID: "on-1", plan: plan({ agent: "medium", tier: "medium" }) }));
      expect(lookupDispatch("off-1")?.outcomes).toBe(false);
      expect(lookupDispatch("on-1")?.outcomes).toBe(true);
      for (const child of ["off-1", "on-1"]) {
        await ingest.onStepEnded({
          id: `step-${child}`, type: "session.step.ended",
          data: { sessionID: child, assistantMessageID: `m-${child}`, finish: "stop", cost: 0, tokens: { input: 700, output: 50, reasoning: 0, cache: { read: 0, write: 0 } } },
        });
        ingest.onVerdict(child, "pass");
        ingest.onFalseRefusal(child);
        ingest.onExecutionEnded(child);
      }
      const bundle = h.bundles[0]!;
      const keys = bundle.store.keys();
      expect(keys).toHaveLength(1);
      expect(keys[0]).toContain("router:medium"); // only the attempt registered with ingestion on
      expect(keys.some((key) => key.includes("router:fast"))).toBe(false);
      // The marked attempt left no verdict or refusal row either; its decision row was never written.
      const rows = (await (async () => { await bundle.flusher.flushNow(); return (await bundle.persister.readRows()).rows; })());
      expect(rows.filter((row) => row.kind !== "decision" && "childSessionID" in row && row.childSessionID === "off-1")).toEqual([]);
      expect(rows.filter((row) => row.kind === "decision").map((row) => row.kind === "decision" && row.childSessionID)).toEqual(["on-1"]);
      // The context bookkeeping is independent of ingestion: both children's contexts are known to the ladder.
      expect(lastStepContext("off-1")).toBe(750);
      expect(lastStepContext("on-1")).toBe(750);
    } finally {
      await ingest.dispose();
      await staticRecorder.dispose();
      await shadowRecorder.dispose();
    }
  });

  it("a record registered without the field (a 2.2 dispatch) is scoreable", () => {
    const h = harness();
    const recorder = createAttemptRecorder({ host: "v2", config: () => config({ engine: "shadow" }, h.outcomes), logger: h.logger, acquire: h.acquire });
    recorder.record(attempt());
    expect(lookupDispatch("c1")?.outcomes).toBe(true);
  });
});
