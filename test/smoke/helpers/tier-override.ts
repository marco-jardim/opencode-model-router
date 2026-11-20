/** Preset the smoke model override defines and activates; it exists only in the overrides file. */
export const SMOKE_PRESET = "smoke-model-override";

/**
 * Overrides-file content that moves every tier to `model`: a dedicated preset whose tiers carry ONLY
 * `model`, made the active preset.
 *
 * A fresh preset rather than a patch of the bundled one: the loader deep-merges (siblings survive, keys
 * cannot be deleted), so patching the bundled preset would carry its Anthropic-only `variant`/`effort`
 * along to a non-Anthropic model. The previous fixture suppressed them with `variant: ""`, but the tier
 * validator requires a non-empty variant id (test/unit/config.validate.test.ts, QA-1.1-26), so that value
 * invalidated the WHOLE layer: the loader dropped it with a console warning and every tier silently stayed
 * on the bundled Anthropic models. test/unit/smoke-tier-override.test.ts pins this shape against the real
 * validator on every `npm test`.
 */
export function smokeTierOverride(model: string): Record<string, unknown> {
  const tier = { model };
  return {
    activePreset: SMOKE_PRESET,
    presets: { [SMOKE_PRESET]: { fast: tier, medium: tier, heavy: tier } },
  };
}
