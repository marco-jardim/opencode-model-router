/**
 * Safety-critical: prompt style is advisory wording, cap enforcement is mechanical.
 *
 * The runtime never reads tier prompt text to decide anything. Caps come from
 * `cfg.tierCaps` (falling back to DEFAULT_TIER_CAPS), and the only text
 * `parseCapDirective` inspects is the DISPATCH text — the task prompt sent to the
 * subagent — not the tier system prompt selected by `selectTierPrompt`. These tests
 * pin that separation: identical guard policies, identical cap banners, identical
 * blocking, whichever style a tier resolves to.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildGuardPolicy } from "../../src/guard/enforce";
import { validateConfig } from "../../src/router/config";
import type { PromptStyle, RouterConfig } from "../../src/router/config";
import { selectTierPrompt } from "../../src/router/prompts";
import { createSessionStore } from "../../src/router/sessions";

type TierName = "fast" | "medium" | "heavy";

const TIER_NAMES: TierName[] = ["fast", "medium", "heavy"];

/**
 * Two configs that differ ONLY in resolved prompt style:
 *  - "prescriptive": weak model, style unset (auto -> prescriptive)
 *  - "goal-oriented": strong model, style unset (auto -> goal-oriented)
 * Both carry identical tierCaps and identical enforcement.guard settings.
 */
function configFor(style: PromptStyle | "auto-strong"): RouterConfig {
  const model =
    style === "auto-strong" ? "anthropic/claude-fable-5" : "anthropic/claude-haiku-4-5";
  const promptStyle = style === "auto-strong" ? undefined : style;

  const tier = (name: TierName) => ({
    model,
    description: `${name} tier`,
    whenToUse: ["tests"],
    ...(promptStyle === undefined || promptStyle === "auto" ? {} : { promptStyle }),
  });

  return validateConfig({
    activePreset: "test",
    defaultTier: "fast",
    rules: [],
    tierPrompts: {
      fast: "PRESCRIPTIVE FAST",
      medium: "PRESCRIPTIVE MEDIUM",
      heavy: "PRESCRIPTIVE HEAVY",
    },
    tierCaps: { fast: 3, medium: 2, heavy: 2 },
    enforcement: {
      mode: "advisory",
      guard: {
        budget: 7,
        readDraftCap: 4,
        sameOpRetryCap: 2,
        blockSelfScript: true,
        deliverableFirst: false,
        blockScriptWrites: true,
      },
    },
    presets: {
      test: { fast: tier("fast"), medium: tier("medium"), heavy: tier("heavy") },
    },
  });
}

function dispatch(text: string) {
  return { parts: [{ text }] };
}

/** Every cap banner produced by a fixed sequence of read-only calls. */
function capBanners(cfg: RouterConfig, tier: TierName, dispatchText: string): string[] {
  const store = createSessionStore();
  const sessionID = `ses_${tier}`;
  store.registerFromChatMessage({ agent: tier, sessionID }, dispatch(dispatchText), cfg, TIER_NAMES);

  const calls = [
    { tool: "read", args: { file_path: "a.ts" } },
    { tool: "grep", args: { pattern: "x" } },
    { tool: "read", args: { file_path: "a.ts" } }, // redundant on purpose
    { tool: "read", args: { file_path: "b.ts" } },
    { tool: "edit", args: { file_path: "a.ts" } }, // not read-only: no banner
    { tool: "glob", args: { pattern: "**/*.ts" } },
  ];

  const banners: string[] = [];
  for (const call of calls) {
    const out: Record<string, unknown> = { output: "RESULT" };
    store.recordToolCall({ sessionID, tool: call.tool, args: call.args }, out);
    banners.push(String(out.output));
  }
  return banners;
}

describe("prompt style does not affect guard enforcement", () => {
  const prescriptiveCfg = configFor("prescriptive");
  const goalOrientedCfg = configFor("auto-strong");

  it("the two fixtures really do resolve to different prompt styles", () => {
    // Guards the rest of the file: if this fails the comparisons below are vacuous.
    for (const tier of TIER_NAMES) {
      const prescriptivePrompt = selectTierPrompt(
        tier,
        prescriptiveCfg.presets.test[tier]!,
        prescriptiveCfg,
      );
      const goalOrientedPrompt = selectTierPrompt(
        tier,
        goalOrientedCfg.presets.test[tier]!,
        goalOrientedCfg,
      );

      expect(prescriptivePrompt).toBe(`PRESCRIPTIVE ${tier.toUpperCase()}`);
      expect(goalOrientedPrompt).not.toBe(prescriptivePrompt);
      expect(goalOrientedPrompt).toContain("Your goal is to");
    }
  });

  it.each(TIER_NAMES)(
    "builds the same guard policy for %s under both styles",
    (tier) => {
      expect(buildGuardPolicy(prescriptiveCfg, tier)).toEqual(
        buildGuardPolicy(goalOrientedCfg, tier),
      );
    },
  );

  it.each(TIER_NAMES)(
    "emits identical cap banners for %s under both styles",
    (tier) => {
      const prescriptive = capBanners(prescriptiveCfg, tier, "do the work");
      const goalOriented = capBanners(goalOrientedCfg, tier, "do the work");

      expect(goalOriented).toEqual(prescriptive);
      // Sanity: the sequence actually exercised the cap and redundancy paths.
      expect(prescriptive.join("\n")).toContain("REDUNDANT");
      expect(prescriptive.join("\n")).toContain("CAP REACHED");
    },
  );

  it.each(TIER_NAMES)(
    "honors a CAP:N dispatch directive identically for %s under both styles",
    (tier) => {
      // parseCapDirective reads the DISPATCH text, never the tier system prompt,
      // so the override lands the same way under either style.
      const prescriptive = capBanners(prescriptiveCfg, tier, "tight lookup CAP:1");
      const goalOriented = capBanners(goalOrientedCfg, tier, "tight lookup CAP:1");

      expect(goalOriented).toEqual(prescriptive);
      expect(prescriptive[0]).toContain("[cap: 1/1]");
    },
  );

  it("a CAP directive inside tier prompt text is never parsed as an override", () => {
    // The goal-oriented prompts literally contain the strings "CAP:N" and
    // "CAP:none". If enforcement ever read the tier prompt, this would change caps.
    const promptWithCapText = selectTierPrompt(
      "fast",
      goalOrientedCfg.presets.test.fast!,
      goalOrientedCfg,
    );
    expect(promptWithCapText).toContain("CAP:none");

    const banners = capBanners(goalOrientedCfg, "fast", "plain dispatch with no directive");
    // Still the configured tierCaps.fast = 3, not "none".
    expect(banners[0]).toContain("[cap: 1/3]");
  });

  it("keeps guard modules decoupled from router prompt text", () => {
    const guardDir = join(process.cwd(), "src", "guard");
    const imports = readdirSync(guardDir)
      .filter((file) => file.endsWith(".ts"))
      .flatMap((file) => {
        const content = readFileSync(join(guardDir, file), "utf-8");
        return content.split(/\r?\n/).filter((line) => /^\s*import\b/.test(line));
      })
      .join("\n");

    expect(imports).not.toContain("router/prompts");
    expect(imports).not.toContain("router\\prompts");
  });
});
