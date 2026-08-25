/**
 * Golden pins for both prompt styles, per tier. The prescriptive side is pinned
 * as it comes out of `selectTierPrompt` (not straight off the config object), so
 * a regression in style resolution moves a snapshot instead of passing silently.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { validateConfig } from "../../src/router/config";
import type { PromptStyle, RouterConfig } from "../../src/router/config";
import { GOAL_ORIENTED_TIER_PROMPTS, selectTierPrompt } from "../../src/router/prompts";

type TierName = "fast" | "medium" | "heavy";

const TIER_NAMES: TierName[] = ["fast", "medium", "heavy"];

const cfg: RouterConfig = validateConfig(
  JSON.parse(readFileSync(join(process.cwd(), "tiers.json"), "utf-8")),
);

function resolve(tier: TierName, promptStyle: PromptStyle): string | undefined {
  const base = cfg.presets.anthropic![tier]!;
  return selectTierPrompt(tier, { ...base, promptStyle }, cfg);
}

describe("prompt style golden snapshots", () => {
  it.each(TIER_NAMES)("pins the goal-oriented %s prompt", (tier) => {
    expect(GOAL_ORIENTED_TIER_PROMPTS[tier]).toMatchSnapshot();
  });

  it.each(TIER_NAMES)("pins the prescriptive %s prompt", (tier) => {
    expect(resolve(tier, "prescriptive")).toMatchSnapshot();
  });

  it.each(TIER_NAMES)("goal-oriented resolution matches the built-in for %s", (tier) => {
    // tiers.json ships no tierPromptsGoalOriented, so the built-in is what a
    // strong-model tier actually receives.
    expect(resolve(tier, "goal-oriented")).toBe(GOAL_ORIENTED_TIER_PROMPTS[tier]);
  });

  it.each(TIER_NAMES)("prescriptive resolution matches cfg.tierPrompts for %s", (tier) => {
    expect(resolve(tier, "prescriptive")).toBe(cfg.tierPrompts?.[tier]);
  });
});
