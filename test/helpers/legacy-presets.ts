/**
 * Presets as they shipped in tiers.json 2.5.0 (`git show v2.5.0:tiers.json`), byte-identical in content
 * and key order. 2.6.0 removed `hybrid-2` and `fable-effort` from the bundled file and changed the values
 * of `anthropic` and `hybrid` (owner decision). Tests that exercise generic behaviour (effort bump,
 * escalation, engine decisions, protocol text) through one of these presets define it here, as a user
 * would in `presets` of opencode-model-router.overrides.jsonc, so their coverage does not depend on
 * what the bundled file ships.
 */

const EXPLORE_USES = [
  "Codebase exploration and search",
  "Simple file reads and listing",
  "Grep/glob operations",
  "Quick lookups and research",
];

const IMPLEMENT_USES = ["Feature implementation", "Refactoring", "Writing tests", "Bug fixes"];

const DESIGN_USES = [
  "Architecture decisions",
  "Complex debugging (after 2+ failures)",
  "Security review",
  "Performance optimization",
];

/** The 2.5.0 `fable-effort` preset: one model, three efforts. */
export const FABLE_EFFORT_2_5_0 = {
  fast: {
    readOnly: true,
    model: "anthropic/claude-fable-5-1",
    effort: "low",
    costRatio: 1,
    description:
      "Fable 5 at low effort for exploration, search, and simple reads (token-spend ratios are estimates; same model across tiers preserves prompt cache)",
    steps: 30,
    whenToUse: [...EXPLORE_USES],
  },
  medium: {
    model: "anthropic/claude-fable-5-1",
    effort: "high",
    costRatio: 3,
    description:
      "Fable 5 at high effort for implementation and standard coding (costRatio is an estimated token-spend multiplier, not a price difference)",
    steps: 50,
    whenToUse: [...IMPLEMENT_USES],
  },
  heavy: {
    model: "anthropic/claude-fable-5-1",
    effort: "xhigh",
    costRatio: 6,
    description:
      "Fable 5 at xhigh effort for architecture, complex debugging, and security (costRatio is an estimated token-spend multiplier, not a price difference)",
    steps: 120,
    whenToUse: [...DESIGN_USES],
  },
};

/** The 2.5.0 `hybrid-2` preset: GPT-6 Luna Fast, Sonnet 5.5 xhigh, Opus 5.5 xhigh. */
export const HYBRID_2_2_5_0 = {
  fast: {
    readOnly: true,
    model: "openai/gpt-6-luna-fast",
    variant: "medium",
    costRatio: 1,
    description: "GPT 6 Luna (medium) for exploration, search, and simple reads",
    steps: 30,
    whenToUse: [...EXPLORE_USES],
  },
  medium: {
    model: "anthropic/claude-sonnet-5-5",
    variant: "xhigh",
    effort: "xhigh",
    costRatio: 5,
    description: "Claude Sonnet (xhigh) for implementation and standard coding",
    steps: 50,
    whenToUse: [...IMPLEMENT_USES],
  },
  heavy: {
    model: "anthropic/claude-opus-5-5",
    variant: "xhigh",
    effort: "xhigh",
    costRatio: 20,
    description: "Claude Opus 5.5 xhigh for architecture, complex debugging, and security",
    steps: 120,
    whenToUse: [...DESIGN_USES],
  },
};

/** The 2.5.0 `anthropic` preset: Haiku 5.5 low, Sonnet 5.5 medium, Opus 5.5 xhigh. */
export const ANTHROPIC_2_5_0 = {
  fast: {
    readOnly: true,
    model: "anthropic/claude-haiku-5-5",
    variant: "low",
    effort: "low",
    costRatio: 1,
    description: "Haiku 5.5 low for exploration, search, and simple reads",
    steps: 30,
    whenToUse: [...EXPLORE_USES],
  },
  medium: {
    model: "anthropic/claude-sonnet-5-5",
    variant: "medium",
    effort: "medium",
    costRatio: 5,
    description: "Sonnet 5.5 medium for implementation, refactoring, and tests",
    steps: 50,
    whenToUse: ["Feature implementation", "Refactoring", "Writing tests", "Code review", "Bug fixes"],
  },
  heavy: {
    model: "anthropic/claude-opus-5-5",
    variant: "xhigh",
    effort: "xhigh",
    costRatio: 20,
    description: "Opus 5.5 xhigh for architecture, complex debugging, and security",
    steps: 120,
    whenToUse: [...DESIGN_USES],
  },
};

/** Deep copies, so a test that mutates its preset cannot leak into another. */
export function legacyPresets(): {
  anthropic: typeof ANTHROPIC_2_5_0;
  "hybrid-2": typeof HYBRID_2_2_5_0;
  "fable-effort": typeof FABLE_EFFORT_2_5_0;
} {
  return structuredClone({
    anthropic: ANTHROPIC_2_5_0,
    "hybrid-2": HYBRID_2_2_5_0,
    "fable-effort": FABLE_EFFORT_2_5_0,
  });
}

/**
 * `raw` (a parsed tiers.json) with the named 2.5.0 presets put back, as an override's `presets` block
 * would: added when the name is gone, replaced wholesale when it still exists (`anthropic`).
 */
export function withLegacyPresets<T extends { presets: Record<string, unknown> }>(
  raw: T,
  names: ReadonlyArray<keyof ReturnType<typeof legacyPresets>>,
): T {
  const legacy = legacyPresets();
  const presets = { ...raw.presets };
  for (const name of names) presets[name] = legacy[name];
  return { ...raw, presets };
}
