import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveActiveTiers, validateConfig, type RouterConfig } from "../../src/router/config";
import { presetTierOrder, resolveRoleTable } from "../../src/router/roles";
import { roleTierOrder } from "../../src/routing/engine/ladders";

const bundled = JSON.parse(readFileSync(join(process.cwd(), "tiers.json"), "utf-8")) as { presets: Record<string, unknown> };

const tier = (m: string, costRatio?: number) => ({
  model: `anthropic/${m}`,
  description: m,
  whenToUse: ["x"],
  ...(costRatio === undefined ? {} : { costRatio }),
});

function custom(tiers: Record<string, ReturnType<typeof tier>>): RouterConfig {
  return validateConfig({
    activePreset: "anthropic",
    presets: { anthropic: tiers },
    rules: ["r1"],
    defaultTier: Object.keys(tiers)[0],
    routing: { delegation: "roles" },
  });
}

describe("one tier order for role ranges and role ladders (plan R7)", () => {
  it("roleTierOrder equals presetTierOrder on every bundled preset", () => {
    const names = Object.keys(bundled.presets);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const cfg = validateConfig({ ...bundled, activePreset: name });
      const expected = presetTierOrder(resolveActiveTiers(cfg));
      expect(roleTierOrder(cfg), name).toEqual(expected);
      expect(roleTierOrder(cfg, {} as never), name).toEqual(expected);
    }
  });

  it("agrees on a preset with a non-canonical tier name", () => {
    const cfg = custom({ fast: tier("fast", 1), mini: tier("mini", 2), medium: tier("medium", 3), heavy: tier("heavy", 4) });
    expect(roleTierOrder(cfg)).toEqual(["fast", "mini", "medium", "heavy"]);
    expect(roleTierOrder(cfg)).toEqual(presetTierOrder(resolveActiveTiers(cfg)));
    // the role ranges are placed on that same order
    const explorer = resolveRoleTable(cfg, "v2").roles.get("explorer")!;
    const order = roleTierOrder(cfg);
    expect(order.indexOf(explorer.tierRange.floor)).toBeLessThanOrEqual(order.indexOf(explorer.tierRange.ceiling));
    expect(Object.keys(explorer.budget).every((t) => order.includes(t))).toBe(true);
  });

  it("stays consistent on a cost-inverted preset, where roles are disabled", () => {
    const cfg = custom({ fast: tier("fast", 20), medium: tier("medium", 5), heavy: tier("heavy", 1) });
    expect(roleTierOrder(cfg)).toEqual(["heavy", "medium", "fast"]);
    expect(roleTierOrder(cfg)).toEqual(presetTierOrder(resolveActiveTiers(cfg)));
    expect([...resolveRoleTable(cfg, "v2").roles.keys()]).toEqual(["reviewer"]);
  });
});
