import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyEffortOverride, createEffortOverrideStore, EFFORT_OVERRIDE_KEYS,
  type EffortOverrideStore,
} from "../../src/escalate/effort-override";
import * as agentOptions from "../../src/router/agent-options";
import { EFFORT_LEVELS, type EffortLevel, type TierConfig } from "../../src/router/config";

const openai: TierConfig = { model: "openai/gpt-5", effort: "low" };
const claude: TierConfig = { model: "anthropic/claude-fable-5-1", effort: "low" };
const producer = { sessionID: "producer", agent: "fast", model: { providerID: "openai", id: "gpt-5" } };

function setup(maxEntries?: number) {
  const logger = { warn: vi.fn<(msg: string) => void>() };
  const store = createEffortOverrideStore({ maxEntries, logger });
  store.set("producer", "fast", openai, "medium");
  return { store, logger };
}

afterEach(() => {
  agentOptions.resetAgentOptionsEffortWarnings();
  vi.restoreAllMocks();
});

describe("per-session effort overrides", () => {
  it("exports only the builder's native effort keys", () => {
    expect(EFFORT_OVERRIDE_KEYS).toEqual(["effort", "reasoningEffort"]);
  });

  it("changes only OpenAI effort and removes the legacy alias, idempotently", () => {
    const { store, logger } = setup();
    const nested = { budgetTokens: 1024 };
    const target = { reasoningEffort: "low", reasoning_effort: "low", effort: "unrelated",
      reasoningSummary: "auto", thinking: nested, temperature: 0.4 };
    for (let i = 0; i < 5; i++) applyEffortOverride(store, producer, target, logger);
    expect(target).toEqual({ reasoningEffort: "medium", effort: "unrelated",
      reasoningSummary: "auto", thinking: nested, temperature: 0.4 });
    expect(target.thinking).toBe(nested);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("writes Claude effort without deleting unrelated OpenAI keys", () => {
    const { store, logger } = setup();
    store.set("producer", "fast", claude, "high");
    const target = { effort: "low", reasoning_effort: "low", options: { keep: true } };
    applyEffortOverride(store, { ...producer, model: { providerID: "anthropic", id: "claude-fable-5-1" } }, target, logger);
    expect(target).toEqual({ effort: "high", reasoning_effort: "low", options: { keep: true } });
  });

  it.each([
    {}, { ...producer, sessionID: 1 }, { ...producer, sessionID: "other" },
    { ...producer, agent: "title" }, { ...producer, agent: {} },
    { ...producer, sessionID: "Producer" }, { ...producer, agent: "Fast" },
    { sessionID: producer.sessionID, model: { ...producer.model, modelID: "gpt-5", variant: "default" } },
    { ...producer, model: undefined }, { ...producer, model: null }, { ...producer, model: "openai/gpt-5" },
    { ...producer, model: {} }, { ...producer, model: { providerID: "azure", id: "gpt-5" } },
    { ...producer, model: { providerID: "openai", id: 5 } },
    { ...producer, model: { providerID: "openai", id: "gpt-4" } },
    { ...producer, model: { providerID: "openai", id: "gpt-5", modelID: "other" } },
  ])("leaves target unchanged for a non-producer input %j", (input) => {
    const { store, logger } = setup();
    const target = { reasoningEffort: "low", nested: { keep: true } };
    const before = structuredClone(target);
    applyEffortOverride(store, input, target, logger);
    applyEffortOverride(store, input, undefined, logger);
    expect(target).toEqual(before);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([
    { providerID: "openai", id: "gpt-5" },
    { providerID: "openai", modelID: "gpt-5" },
    { providerID: "openai", modelID: null, id: "gpt-5" },
    { providerID: "openai", id: "gpt-5", variant: "default" },
    { providerID: "openai", id: "different", modelID: "gpt-5", variant: "default" },
  ])("matches host model shape %j", (model) => {
    const { store, logger } = setup();
    const target = {};
    applyEffortOverride(store, { ...producer, model }, target, logger);
    expect(target).toEqual({ reasoningEffort: "medium" });
  });

  it.each([
    { providerID: "openai", id: "gpt-5" },
    { providerID: "openai", modelID: "gpt-5" },
    { providerID: "OPENAI", modelID: "GPT-5" },
  ])("matches mixed-case tier identity against host model %j", (model) => {
    const { store, logger } = setup();
    store.set("producer", "fast", { ...openai, model: "OpenAI/GPT-5" }, "medium");
    const target = {};
    applyEffortOverride(store, { ...producer, model }, target, logger);
    expect(target).toEqual({ reasoningEffort: "medium" });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("splits nested model identities only at the first slash", () => {
    const { store, logger } = setup();
    store.set("producer", "fast", { model: "openrouter/anthropic/claude-sonnet-4.5", effort: "low" }, "high");
    const target = {};
    applyEffortOverride(store, { ...producer, model: { providerID: "openrouter", modelID: "anthropic/claude-sonnet-4.5" } }, target, logger);
    expect(target).toEqual({ effort: "high" });
  });

  it("never creates a missing target and warns once per live session entry", () => {
    const { store, logger } = setup(2);
    for (const target of [undefined, null, 1, "bad", false, () => {}]) {
      applyEffortOverride(store, producer, target, logger);
    }
    expect(logger.warn).toHaveBeenCalledTimes(1);
    store.set("other", "fast", openai, "high");
    applyEffortOverride(store, { ...producer, sessionID: "other" }, undefined, logger);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    const target = {};
    applyEffortOverride(store, producer, target, logger);
    expect(target).toEqual({ reasoningEffort: "medium" });
    store.clear("producer");
    store.set("producer", "fast", openai, "high");
    applyEffortOverride(store, producer, undefined, logger);
    expect(logger.warn).toHaveBeenCalledTimes(3);
    store.set("third", "fast", openai, "high");
    store.set("other", "fast", openai, "high");
    logger.warn.mockClear();
    applyEffortOverride(store, { ...producer, sessionID: "other" }, undefined, logger);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it.each([
    Object.freeze({}),
    Object.defineProperty({}, "reasoningEffort", { get() { throw new Error("getter"); } }),
    Object.defineProperty({}, "reasoningEffort", { set() { throw new Error("setter"); } }),
    Object.defineProperty({}, "reasoning_effort", { value: "low", configurable: false }),
  ])("logs unwritable targets without throwing (%#)", (target) => {
    const { store, logger } = setup();
    for (let i = 0; i < 10; i++) {
      expect(() => applyEffortOverride(store, producer, target, logger)).not.toThrow();
    }
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("reports an applied native key with failed alias deletion distinctly, once", () => {
    const { store, logger } = setup();
    const target = Object.defineProperty({ reasoningEffort: "low" }, "reasoning_effort", {
      value: "low", configurable: false, enumerable: true,
    });
    for (let i = 0; i < 10; i++) applyEffortOverride(store, producer, target, logger);
    expect(target).toEqual({ reasoningEffort: "medium", reasoning_effort: "low" });
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(
      "Applied native effort override for producer, but failed to remove reasoning_effort alias",
    ));
    for (let i = 0; i < 10; i++) applyEffortOverride(store, producer, Object.freeze({}), logger);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenLastCalledWith(expect.stringContaining("Failed to apply effort override"));
  });

  it("bounds failure warning latches to live entries and resets them after clear or eviction", () => {
    const { store, logger } = setup(1);
    const target = Object.freeze({});
    for (const sessionID of ["producer", "other", "producer"]) {
      store.set(sessionID, "fast", openai, "high");
      logger.warn.mockClear();
      for (let i = 0; i < 10; i++) applyEffortOverride(store, { ...producer, sessionID }, target, logger);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(store.size()).toBe(1);
    }
    store.clear("producer");
    store.set("producer", "fast", openai, "high");
    logger.warn.mockClear();
    applyEffortOverride(store, producer, target, logger);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("catches throwing input getters and malformed input", () => {
    const { store, logger } = setup();
    const input = { ...producer, get model() { throw new Error("getter"); } };
    for (let i = 0; i < 10; i++) {
      expect(() => applyEffortOverride(store, input, {}, logger)).not.toThrow();
    }
    expect(() => applyEffortOverride(store, null as unknown as typeof producer, {}, logger)).not.toThrow();
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("does not throw even when warning delivery fails", () => {
    const logger = { warn: vi.fn(() => { throw new Error("logger"); }) };
    const store = createEffortOverrideStore({ logger });
    expect(() => store.set("", "fast", openai, "medium")).not.toThrow();
    store.set("producer", "fast", openai, "medium");
    expect(() => applyEffortOverride(store, producer, Object.freeze({}), logger)).not.toThrow();
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it.each(["__proto__", "constructor", "toString"])("sets, applies and clears prototype-key session and agent %s", (id) => {
    const before = Object.getOwnPropertyDescriptors(Object.prototype);
    const logger = { warn: vi.fn() };
    const store = createEffortOverrideStore({ logger });
    store.set(id, id, openai, "high");
    expect(store.has(id)).toBe(true);
    expect(store.size()).toBe(1);
    const input = { ...producer, sessionID: id, agent: id };
    const target = {};
    applyEffortOverride(store, input, target, logger);
    expect(target).toEqual({ reasoningEffort: "high" });
    store.clear(id);
    expect(store.has(id)).toBe(false);
    expect(store.size()).toBe(0);
    const clearedTarget = {};
    applyEffortOverride(store, input, clearedTarget, logger);
    expect(clearedTarget).toEqual({});
    expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(before);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("clear removes overrides, and unknown ids and foreign stores are no-ops", () => {
    const { store, logger } = setup();
    store.clear("missing");
    expect(store.size()).toBe(1);
    store.clear("producer");
    expect(store.has("producer")).toBe(false);
    expect(store.size()).toBe(0);
    const target = {};
    applyEffortOverride(store, producer, target, logger);
    applyEffortOverride({} as unknown as EffortOverrideStore, producer, target, logger);
    expect(target).toEqual({});
  });

  it.each([
    ["", "fast", openai, "medium"], [" ", "fast", openai, "medium"],
    [null, "fast", openai, "medium"], [1, "fast", openai, "medium"],
    ["bad", "", openai, "medium"], ["bad", {}, openai, "medium"],
    ["bad", "fast", null, "medium"], ["bad", "fast", "tier", "medium"],
    ["bad", "fast", {}, "medium"], ["bad", "fast", { model: 1 }, "medium"],
    ["bad", "fast", { model: " " }, "medium"],
    ["bad", "fast", { model: "gpt-5", effort: "low" }, "medium"],
    ["bad", "fast", { model: "/gpt-5", effort: "low" }, "medium"],
    ["bad", "fast", { model: "openai/", effort: "low" }, "medium"],
    ["bad", "fast", openai, "ultra"], ["bad", "fast", openai, null],
  ])("refuses invalid arguments (%#)", (id, name, tier, effort) => {
    const logger = { warn: vi.fn() };
    const store = createEffortOverrideStore({ logger });
    store.set(id as unknown as string, name as unknown as string, tier as unknown as TierConfig, effort as unknown as EffortLevel);
    expect(store.size()).toBe(0);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it.each([
    { tier: openai, effort: "xhigh" }, { tier: openai, effort: "max" },
    { tier: { ...openai, variant: "default" }, effort: "medium" },
    { tier: { model: openai.model }, effort: "medium" },
    { tier: { ...openai, reasoning: { effort: "low" } }, effort: "medium" },
    { tier: { model: "anthropic/claude-sonnet-4-5", effort: "low", thinking: { budgetTokens: 8000 } }, effort: "high" },
    { tier: { model: "google/gemini-3.7-flash", effort: "low" }, effort: "medium" },
  ] as { tier: TierConfig; effort: EffortLevel }[])("refuses an unbumpable tier or effort above its ceiling (%#)", ({ tier, effort }) => {
    const { store, logger } = setup();
    store.set("refused", "fast", tier, effort);
    expect(store.has("refused")).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it.each([
    Object.setPrototypeOf({ ...openai }, { reasoning: { effort: "low" } }),
    Object.setPrototypeOf({ model: "anthropic/claude-sonnet-4-5", effort: "low" }, { thinking: { budgetTokens: 8000 } }),
    Object.defineProperty({ ...openai }, "variant", { value: "high", enumerable: false }),
    Object.defineProperty({ ...openai }, "reasoning", { value: { effort: "low" }, enumerable: false }),
    Object.setPrototypeOf({ ...openai }, { variant: "high" }),
  ] satisfies TierConfig[])("honours inherited and non-enumerable ceiling fields (%#)", (tier) => {
    const { store, logger } = setup();
    expect(agentOptions.effortCeilingFor(tier)).toBeNull();
    store.set("producer", "fast", tier, "high");
    expect(store.has("producer")).toBe(false);
    expect(store.size()).toBe(0);
    const target = {};
    const separator = tier.model.indexOf("/");
    applyEffortOverride(store, { ...producer, model: {
      providerID: tier.model.slice(0, separator), id: tier.model.slice(separator + 1),
    } }, target, logger);
    expect(target).toEqual({});
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("exceeds the tier ceiling"));
  });

  it.each([
    { tier: { ...openai, reasoning: { effort: "low" } }, effort: "medium" },
    { tier: openai, effort: "xhigh" },
    { tier: { ...openai, model: "gpt-5" }, effort: "medium" },
    { tier: openai, effort: "ultra" },
  ])("clears a previous override when a re-set is refused (%#)", ({ tier, effort }) => {
    const { store, logger } = setup();
    store.set("producer", "fast", openai, "high");
    store.set("producer", "fast", tier as TierConfig, effort as EffortLevel);
    expect(store.has("producer")).toBe(false);
    const target = { reasoningEffort: "low" };
    applyEffortOverride(store, producer, target, logger);
    expect(target).toEqual({ reasoningEffort: "low" });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("clears a previous override when the builder throws or returns no effort keys", () => {
    const { store, logger } = setup();
    const builder = vi.spyOn(agentOptions, "buildAgentOptions").mockImplementation(() => {
      throw new Error("builder");
    });
    store.set("producer", "fast", openai, "high");
    expect(store.has("producer")).toBe(false);
    builder.mockRestore();
    store.set("producer", "fast", openai, "high");
    vi.spyOn(agentOptions, "buildAgentOptions").mockReturnValue({});
    store.set("producer", "fast", openai, "medium");
    expect(store.has("producer")).toBe(false);
    const target = { reasoningEffort: "low" };
    applyEffortOverride(store, producer, target, logger);
    expect(target).toEqual({ reasoningEffort: "low" });
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("refuses empty builder output and catches builder/getter failures", () => {
    const { store, logger } = setup();
    const builder = vi.spyOn(agentOptions, "buildAgentOptions").mockReturnValue({ reasoningSummary: "auto" });
    store.set("empty", "fast", openai, "medium");
    expect(store.has("empty")).toBe(false);
    builder.mockImplementation(() => { throw new Error("builder"); });
    store.set("throws", "fast", openai, "medium");
    store.set("getter", "fast", { get model(): string { throw new Error("model getter"); } }, "medium");
    expect(store.size()).toBe(1);
    expect(logger.warn).toHaveBeenCalledTimes(3);
  });

  it.each([
    { model: "anthropic/claude-sonnet-4-5", effort: "low", reasoning: { summary: "auto" } },
    { ...claude, thinking: { budgetTokens: 8000 } },
    { model: "anthropic/claude-sonnet-4-5", effort: "low", thinking: { budgetTokens: 0 } },
  ] satisfies TierConfig[])("routes builder warnings to the injected logger, once (%#)", (tier) => {
    const consoleWarning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { store, logger } = setup();
    store.set("producer", "fast", tier, "high");
    store.set("producer", "fast", tier, "high");
    expect(store.has("producer")).toBe(true);
    expect(consoleWarning).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("tier fast:"));
  });

  it("computes once, snapshots the tier, and re-setting replaces and refreshes age", async () => {
    const { store, logger } = setup(2);
    const builder = vi.spyOn(agentOptions, "buildAgentOptions");
    const tier = { ...openai };
    store.set("second", "fast", openai, "medium");
    store.set("producer", "fast", tier, "high");
    tier.model = claude.model;
    for (let i = 0; i < 5; i++) {
      const target = {};
      applyEffortOverride(store, producer, target, logger);
      expect(target).toEqual({ reasoningEffort: "high" });
    }
    expect(builder).toHaveBeenCalledTimes(2);
    expect(builder).toHaveBeenLastCalledWith({ ...openai, effort: "high" }, "fast", {
      warn: expect.any(Function), flush: expect.any(Function),
    });
    await builder.mock.calls.at(-1)?.[2]?.flush();
    store.set("third", "fast", openai, "medium");
    expect(store.has("second")).toBe(false);
    expect(store.has("producer")).toBe(true);
    expect(store.size()).toBe(2);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("second"));
  });

  it("reads each tier field once and keeps accessor model identity coherent", () => {
    const { store, logger } = setup();
    const reads = new Map<PropertyKey, number>();
    const tier = new Proxy<TierConfig>({ ...claude, variant: undefined, thinking: undefined, reasoning: undefined }, {
      get(target, key, receiver): unknown {
        const count = (reads.get(key) ?? 0) + 1;
        reads.set(key, count);
        if (key === "model") return count === 1 ? claude.model : openai.model;
        return Reflect.get(target, key, receiver);
      },
    });
    store.set("producer", "fast", tier, "max");
    expect(Object.fromEntries(reads)).toEqual({ model: 1, effort: 1, variant: 1, thinking: 1, reasoning: 1 });
    const target = {};
    applyEffortOverride(store, { ...producer, model: { providerID: "anthropic", id: "claude-fable-5-1" } }, target, logger);
    expect(target).toEqual({ effort: "max" });
    const foreignTarget = {};
    applyEffortOverride(store, producer, foreignTarget, logger);
    expect(foreignTarget).toEqual({});
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("evicts the oldest on overflow", () => {
    const { store, logger } = setup(2);
    store.set("second", "fast", openai, "medium");
    store.set("third", "fast", openai, "medium");
    expect(store.has("producer")).toBe(false);
    expect(store.has("second")).toBe(true);
    expect(store.has("third")).toBe(true);
    expect(store.size()).toBe(2);
    const target = {};
    applyEffortOverride(store, producer, target, logger);
    expect(target).toEqual({});
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("producer"));
  });

  it("leaves service prefixes to the plugin logger", () => {
    const consoleWarning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logger = { warn: (message: string) => console.warn(`[model-router] ${message}`) };
    const store = createEffortOverrideStore({ maxEntries: 1, logger });
    store.set("first", "fast", openai, "medium");
    store.set("second", "fast", openai, "medium");
    expect(consoleWarning).toHaveBeenCalledExactlyOnceWith("[model-router] Evicted oldest effort override for first");
  });

  it("prefixes builder and refusal warnings on the default console logger", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = createEffortOverrideStore();
    store.set("producer", "fast", { ...claude, reasoning: { summary: "auto" } }, "high");
    expect(store.has("producer")).toBe(true);
    expect(warning).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^\[model-router\] tier fast:/));
    store.set("producer", "fast", openai, "max");
    expect(store.has("producer")).toBe(false);
    expect(warning).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenLastCalledWith("[model-router] Effort override for producer exceeds the tier ceiling; override refused");
  });

  it("defaults to 1000 entries and prefixed console warnings", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = createEffortOverrideStore();
    for (let i = 0; i <= 1000; i++) store.set(String(i), "fast", openai, "medium");
    expect(store.size()).toBe(1000);
    expect(store.has("0")).toBe(false);
    expect(warning).toHaveBeenCalledExactlyOnceWith("[model-router] Evicted oldest effort override for 0");
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid capacity %s", (maxEntries) => {
    const logger = { warn: vi.fn() };
    const store = createEffortOverrideStore({ maxEntries, logger });
    for (let i = 0; i <= 1000; i++) store.set(String(i), "fast", openai, "medium");
    expect(store.size()).toBe(1000);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});

// Same provider-qualified families and option combinations as effort-ceiling.test.ts.
const models = [
  "openai/gpt-5", "OpenAI/GPT-5", "azure/gpt-5", "github-copilot/gpt-5", "azure/o3",
  "github-copilot/claude-sonnet-5", "openrouter/anthropic/claude-sonnet-4.5", "Anthropic/Claude-Sonnet-4-5",
  "anthropic/claude-fable-5.1", "anthropic/claude-fable-5-1", "anthropic/claude-opus-5-5",
  "anthropic/claude-opus-5-5-20260101", "anthropic/claude-fable-5-1[1m]", "anthropic/claude-sonnet-4-5",
  "google-vertex-anthropic/claude-sonnet-4-5@20250929", "google-vertex-anthropic/claude-opus-5-5@20260101",
];
const thinkingConfigs: TierConfig["thinking"][] = [undefined, {}, { budgetTokens: 0 }, { budgetTokens: 8000 }];
const reasoningConfigs: TierConfig["reasoning"][] = [undefined, {}, { effort: "low" }, { summary: "auto" }];
const fixtures = models.flatMap((model) => thinkingConfigs.flatMap((thinking) =>
  reasoningConfigs.flatMap((reasoning) => EFFORT_LEVELS.flatMap((effort) => {
    const tier: TierConfig = { model, effort, thinking, reasoning };
    const ceiling = agentOptions.effortCeilingFor(tier);
    return ceiling === null ? [] : [{ tier, ceiling }];
  })),
));

describe("native builder agreement", () => {
  it.each(fixtures)("applies exactly the builder effort keys (%#)", ({ tier, ceiling }) => {
    const consoleWarning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { store, logger } = setup();
    const separator = tier.model.indexOf("/");
    // Registration consumes expected builder notices before steady-state bumps.
    agentOptions.buildAgentOptions(tier, "fast", { warn: vi.fn(), flush: () => Promise.resolve() });
    for (const effort of EFFORT_LEVELS.filter((level) => agentOptions.effortRank(level) <= agentOptions.effortRank(ceiling))) {
      store.set("producer", "fast", tier, effort);
      const expected = agentOptions.buildAgentOptions({ ...tier, effort }, "fast");
      const keys = Object.fromEntries(EFFORT_OVERRIDE_KEYS.filter((key) => Object.hasOwn(expected, key)).map((key) => [key, expected[key]]));
      const target = {};
      applyEffortOverride(store, { ...producer, model: { providerID: tier.model.slice(0, separator).toLowerCase(), id: tier.model.slice(separator + 1).toLowerCase() } }, target, logger);
      expect(target).toEqual(keys);
      expect(Object.values(target)).toEqual([effort]);
    }
    expect(consoleWarning).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
