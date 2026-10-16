// Phase 2.2 QA round 1: the per-turn hint text (QA-2.2-6).
// Phase 1.2 QA round 1 (QA-1.2-6): the augmenter WITH a turn-state registry: the real hint reaches the `route-hint` provider and never the
// system array, early returns clear it, the `R:` line is frozen per session and recomputed on a config / model / agent change.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTurnStateRegistry, type TurnStateRegistry } from "../../src/compat/turn-state";
import { validateConfig, type RouterConfig } from "../../src/router/config";
import { assembleSystemPrompt } from "../../src/router/protocol";
import { resetIngestState } from "../../src/routing/outcomes/ingest";
import { legacyPresets } from "../helpers/legacy-presets";
import { buildHint, createSystemAugmenter, TAXONOMY_TTL_MS } from "../../src/routing/wire/hint";
import { acquireOutcomes, DEFAULT_OUTCOME_TUNING } from "../../src/routing/outcomes";
import { createEngineRuntime } from "../../src/routing/wire/runtime";
import type { Candidate, Decision } from "../../src/routing/engine/types";
import { makeKey } from "../../src/routing/outcomes/types";

const READ_ONLY = [
  { action: "*", resource: "*", effect: "deny" },
  ...["glob", "grep", "read", "webfetch", "websearch"].map((action) => ({ action, resource: "*", effect: "allow" })),
];
const ALLOW_ALL = [{ action: "*", resource: "*", effect: "allow" }];

const choice = (agent: string, variant: string) => ({
  key: makeKey("implement", { origin: "router", id: agent }, "anthropic", "claude-sonnet-5-5", variant),
  agent, origin: "router" as const, model: "anthropic/claude-sonnet-5-5", variant,
});

function target(agent: string, variant: string | null): Candidate {
  return {
    agent: { origin: "router", id: agent }, model: "anthropic/claude-sonnet-5-5", variant, costRatio: 5, rank: 1, tier: agent, source: "tier", grants: [],
  };
}

function decision(over: Partial<Decision> = {}): Decision {
  return {
    chosen: choice("medium", "medium"), best: choice("heavy", "xhigh"), argmin: null, switched: true, pinned: false, confidence: 0.5,
    reasonCode: "switched", reason: "switched: C(best)=5 < (1 − 0.2)·C(chosen)=9 ratio", costs: {}, unit: "ratio", ineligible: {}, target: target("heavy", "xhigh"),
    pickRank: 1,
    ...over,
  };
}

describe("buildHint", () => {
  const descriptions = new Map([["heavy", "Opus for architecture and hard debugging"]]);

  it("names only the class and destination, without live decision numbers or the previous pick", () => {
    const hint = buildHint(decision(), { class: "implement" }, descriptions)!;
    expect(hint).toBe("Route hint: for implement work like this turn, prefer @heavy (Opus for architecture and hard debugging).");
    expect(buildHint(decision({ reason: "different costs: 12345", confidence: 0.99, chosen: choice("fast", "low") }), { class: "implement" }, descriptions)).toBe(hint);
  });

  it("says nothing when nothing would switch, the dispatch is pinned, or there is no target", () => {
    expect(buildHint(decision({ switched: false }), { class: "implement" }, descriptions)).toBeNull();
    expect(buildHint(decision({ pinned: true }), { class: "implement" }, descriptions)).toBeNull();
    expect(buildHint(decision({ target: null }), { class: "implement" }, descriptions)).toBeNull();
    expect(buildHint(decision({ best: null }), { class: "implement" }, descriptions)).toBeNull();
  });

  it("QA-2.2-6: a switch inside the pick's own agent (a variant change) is no hint: 'prefer @medium over @medium' helps nobody", () => {
    expect(buildHint(decision({ best: choice("medium", "high"), target: target("medium", "high") }), { class: "implement" }, descriptions)).toBeNull();
  });

  it("an agent without a description is named alone; a long description is cut to one line and the reason is omitted", () => {
    const plain = buildHint(decision({ target: target("general", null), best: choice("general", "default") }), { class: "debug" }, new Map())!;
    expect(plain).toContain("prefer @general.");
    const long = buildHint(decision({ reason: `${"why ".repeat(200)}\nmore` }), { class: "implement" }, new Map([["heavy", `${"x".repeat(200)}\nsecond line`]]))!;
    expect(long.split("\n")).toHaveLength(1);
    expect(long).not.toContain("why");
    expect(long.length).toBeLessThan(400);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// QA-1.2-6: the augmenter with a turn-state registry (v2), the real classifier, a real outcome store and the real `route-hint` provider.
// ---------------------------------------------------------------------------------------------------------------------

const SEARCH_ASK = "Find all the usages of parseConfig in the repository";
const OTHER_ASK = "Find all the usages of parseOther in the repository";
const HINT_TEXT = /^<router-state>\nRoute hint: for \w+ work like this turn, prefer @explore \(Fast read-only codebase exploration\)\.\n<\/router-state>$/;
const OPUS = "anthropic/claude-opus-5-5";
const SONNET = "anthropic/claude-sonnet-5-5";
const ROLES_TEXT = "## Role Delegation Protocol (MANDATORY)\nroles protocol stand-in";

const SEED_KEYS = {
  searchFast: makeKey("search", { origin: "router", id: "fast" }, "anthropic", "claude-sonnet-5-5", "low"),
  searchExplore: makeKey("search", { origin: "host", id: "explore" }, "anthropic", "claude-haiku-4-5", "default"),
  reconFast: makeKey("recon", { origin: "router", id: "fast" }, "anthropic", "claude-sonnet-5-5", "low"),
  reconExplore: makeKey("recon", { origin: "host", id: "explore" }, "anthropic", "claude-haiku-4-5", "default"),
  implementMedium: makeKey("implement", { origin: "router", id: "medium" }, "anthropic", "claude-sonnet-5-5", "medium"),
};

function rawAgents(): Record<string, unknown>[] {
  const base = { request: { settings: {}, headers: {}, body: {} }, hidden: false };
  return [
    { ...base, id: "build", mode: "primary", permissions: ALLOW_ALL },
    { ...base, id: "orchestrator", mode: "primary", permissions: ALLOW_ALL },
    { ...base, id: "fast", mode: "subagent", model: { providerID: "anthropic", id: "claude-sonnet-5-5", variant: "low" }, permissions: ALLOW_ALL, description: "fast tier" },
    { ...base, id: "medium", mode: "subagent", model: { providerID: "anthropic", id: "claude-sonnet-5-5", variant: "medium" }, permissions: ALLOW_ALL, description: "medium tier" },
    { ...base, id: "heavy", mode: "subagent", model: { providerID: "anthropic", id: "claude-opus-5-5", variant: "xhigh" }, permissions: ALLOW_ALL, description: "heavy tier" },
    { ...base, id: "explore", mode: "subagent", model: { providerID: "anthropic", id: "claude-haiku-4-5" }, permissions: READ_ONLY, description: "Fast read-only codebase exploration" },
  ];
}

function catalog() {
  const variants = (...ids: string[]) => ids.map((id) => ({ id }));
  return [
    { providerID: "anthropic", id: "claude-sonnet-5-5", variants: variants("low", "medium", "high"), limit: { context: 200_000, output: 32_000 }, cost: [] },
    { providerID: "anthropic", id: "claude-opus-5-5", variants: variants("low", "medium", "high", "xhigh"), limit: { context: 200_000, output: 32_000 }, cost: [] },
    { providerID: "anthropic", id: "claude-haiku-5-5", variants: variants("low", "medium", "high"), limit: { context: 200_000, output: 32_000 }, cost: [] },
    { providerID: "anthropic", id: "claude-haiku-4-5", variants: variants("high", "max"), limit: { context: 200_000, output: 32_000 }, cost: [] },
  ];
}

interface Turn { readonly system: string[]; readonly added: Set<string> }
interface RunOptions {
  readonly agent?: string;
  readonly parentModel?: string;
  readonly text?: string;
  readonly sessionID?: string;
  /** Replaces the orchestrator's protocol part (and registers it as router-added unless `added` says otherwise). */
  readonly system?: string[];
  readonly added?: string[];
}
interface Rig {
  readonly registry: TurnStateRegistry;
  readonly clock: { now: number };
  readonly warn: ReturnType<typeof vi.fn>;
  configOf(routing?: Record<string, unknown>): RouterConfig;
  seedEvidence(): void;
  run(cfg: RouterConfig, options?: RunOptions): Promise<Turn>;
}

const bundledTiers = JSON.parse(readFileSync(join(process.cwd(), "tiers.json"), "utf-8")) as Record<string, unknown>;
const cleanups: Array<() => Promise<void>> = [];

async function makeRig(withRegistry: boolean): Promise<Rig> {
  const outcomes = mkdtempSync(join(tmpdir(), "omr-hint-"));
  const warn = vi.fn();
  const logger = { warn };
  const configOf = (routing: Record<string, unknown> = {}): RouterConfig => validateConfig({
    ...bundledTiers,
    activePreset: "anthropic",
    presets: legacyPresets(),
    routing: { engine: "advise", margin: 0.1, roles: { search: ["explore"], recon: ["explore"] }, outcomes: { path: outcomes }, ...routing },
  });
  const bundle = acquireOutcomes({ dir: outcomes, tuning: DEFAULT_OUTCOME_TUNING, logger });
  await bundle.ready;
  const fallback = configOf();
  const runtime = createEngineRuntime({
    loadConfig: () => fallback,
    listAgents: async () => rawAgents(),
    listModels: async () => catalog(),
    logger,
    acquire: () => bundle,
  });
  cleanups.push(async () => {
    await runtime.dispose();
    rmSync(outcomes, { recursive: true, force: true });
  });
  const clock = { now: 1_000_000 };
  const registry = createTurnStateRegistry({ logger });
  const augmenter = createSystemAugmenter({
    runtime,
    getSession: async () => ({ id: "root", agent: "build", model: { providerID: "anthropic", id: "claude-opus-5-5" }, permissions: [{ action: "subagent", resource: "*", effect: "allow" }] }),
    logger,
    now: () => clock.now,
    ...(withRegistry ? { turnState: registry } : {}),
  });
  const record = (key: string, pass: number, fail: number): void => {
    for (let i = 0; i < pass; i++) bundle.store.recordVerdict(key as never, "pass", { attemptID: `${key}:p${i}`, step: "dispatch" });
    for (let i = 0; i < fail; i++) bundle.store.recordVerdict(key as never, "fail", { attemptID: `${key}:f${i}`, step: "dispatch" });
  };
  return {
    registry,
    clock,
    warn,
    configOf,
    seedEvidence() {
      record(SEED_KEYS.searchFast, 0, 20);
      record(SEED_KEYS.searchExplore, 20, 0);
      record(SEED_KEYS.reconFast, 0, 20);
      record(SEED_KEYS.reconExplore, 20, 0);
      record(SEED_KEYS.implementMedium, 3, 1);
    },
    async run(cfg, options = {}) {
      const system = options.system ?? [assembleSystemPrompt(cfg, undefined, false)];
      const added = new Set(options.added ?? system);
      await augmenter.augment({
        sessionID: options.sessionID ?? "root",
        agent: options.agent ?? "build",
        parentModel: options.parentModel ?? OPUS,
        cfg,
        messages: [{ role: "user", content: [{ type: "text", text: options.text ?? SEARCH_ASK }] }],
      }, system, added);
      return { system, added };
    },
  };
}

describe("createSystemAugmenter with a turn-state registry (QA-1.2-6)", () => {
  beforeEach(() => { resetIngestState(); });
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  it("renders the real hint through the route-hint provider and pushes nothing into the system array", async () => {
    const rig = await makeRig(true);
    rig.seedEvidence();
    const cfg = rig.configOf();
    const { system, added } = await rig.run(cfg);
    expect(system).toHaveLength(1);
    expect(system.join("\n")).not.toContain("Route hint: for");
    expect([...added].join("\n")).not.toContain("Route hint: for");
    expect(system[0]).toContain("by class:"); // the R: line is generated in the system part, the hint is not
    expect(rig.registry.buildTurnState("root")).toMatch(HINT_TEXT);
    expect(rig.registry.buildTurnState("another-session")).toBeUndefined();
    expect(rig.warn).not.toHaveBeenCalled();
  });

  it("without a registry the same hint is one extra system part", async () => {
    const rig = await makeRig(false);
    rig.seedEvidence();
    const { system } = await rig.run(rig.configOf());
    expect(system).toHaveLength(2);
    expect(system[1]).toMatch(/^Route hint: for \w+ work like this turn, prefer @explore /);
    expect(rig.registry.buildTurnState("root")).toBeUndefined();
  });

  it("clears the hint of an earlier request when roles, static or shadow mode, or a non-orchestrator request returns early", async () => {
    const early: Array<{ name: string; routing?: Record<string, unknown>; options?: RunOptions }> = [
      { name: "roles protocol", options: { system: [ROLES_TEXT] } },
      { name: "not the orchestrator (no protocol)", options: { system: ["plain system text"], added: [] } },
      { name: "static engine", routing: { engine: "static" } },
      { name: "shadow engine", routing: { engine: "shadow" } },
    ];
    for (const variant of early) {
      const rig = await makeRig(true);
      rig.seedEvidence();
      await rig.run(rig.configOf());
      expect(rig.registry.buildTurnState("root"), `${variant.name}: the first request sets the hint`).toMatch(HINT_TEXT);
      await rig.run(variant.routing === undefined ? rig.configOf() : rig.configOf(variant.routing), variant.options);
      expect(rig.registry.buildTurnState("root"), `${variant.name}: the early return leaves no hint behind`).toBeUndefined();
      expect(rig.warn).not.toHaveBeenCalled();
    }
  });

  it("keeps the generated R: line frozen while outcomes of every kind are recorded and the clock moves past the 60 s memo", async () => {
    const rig = await makeRig(true);
    const cfg = rig.configOf();
    const first = await rig.run(cfg);
    expect(first.system[0]).not.toContain("by class:"); // no evidence yet: the shipped line
    expect(rig.registry.buildTurnState("root")).toBeUndefined();

    rig.seedEvidence(); // passes and failures, across classes
    rig.clock.now += TAXONOMY_TTL_MS + 5_000;
    const second = await rig.run(cfg, { text: OTHER_ASK });
    expect(second.system[0]).toBe(first.system[0]);
    expect(rig.registry.buildTurnState("root"), "fresh evidence still reaches the model through the hint").toMatch(HINT_TEXT);

    rig.clock.now += 10 * TAXONOMY_TTL_MS;
    const third = await rig.run(cfg, { text: SEARCH_ASK });
    expect(third.system[0]).toBe(first.system[0]);
    expect(rig.warn).not.toHaveBeenCalled();
  });

  it("the freeze is what holds the line: without a registry the same evidence moves it once the memo expired", async () => {
    const rig = await makeRig(false);
    const cfg = rig.configOf();
    const first = await rig.run(cfg);
    expect(first.system[0]).not.toContain("by class:");
    rig.seedEvidence();
    rig.clock.now += TAXONOMY_TTL_MS + 5_000;
    const second = await rig.run(cfg, { text: OTHER_ASK });
    expect(second.system[0]).not.toBe(first.system[0]);
    expect(second.system[0]).toContain("by class:");
  });

  describe("recomputes the frozen R: line", () => {
    /** Primes a rig with the shipped line, records evidence (no clock move) and returns the rig and the first turn. */
    async function primed() {
      const rig = await makeRig(true);
      const cfg = rig.configOf();
      const first = await rig.run(cfg);
      expect(first.system[0]).not.toContain("by class:");
      rig.seedEvidence();
      return { rig, cfg, first };
    }

    it("is frozen for the same config object, agent and model (control)", async () => {
      const { rig, cfg, first } = await primed();
      expect((await rig.run(cfg, { text: OTHER_ASK })).system[0]).toBe(first.system[0]);
    });

    it("when the config object identity changes", async () => {
      const { rig, first } = await primed();
      const reloaded = rig.configOf();
      const second = await rig.run(reloaded, { text: OTHER_ASK });
      expect(second.system[0]).not.toBe(first.system[0]);
      expect(second.system[0]).toContain("search→@explore");
      expect(rig.warn).not.toHaveBeenCalled();
    });

    it("when the parent model changes", async () => {
      const { rig, cfg, first } = await primed();
      const second = await rig.run(cfg, { text: OTHER_ASK, parentModel: SONNET });
      expect(second.system[0]).not.toBe(first.system[0]);
      expect(second.system[0]).toContain("by class:");
    });

    it("when the dispatching agent changes", async () => {
      const { rig, cfg, first } = await primed();
      const second = await rig.run(cfg, { text: OTHER_ASK, agent: "orchestrator" });
      expect(second.system[0]).not.toBe(first.system[0]);
      expect(second.system[0]).toContain("by class:");
    });
  });
});
