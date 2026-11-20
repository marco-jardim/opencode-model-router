import { invalidateConfigCache, loadConfig, resolveActiveTiers } from "../../../src/router/config";

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

/**
 * What the plugin will resolve for `projectDir` when the host runs with `home` as its home directory (the private
 * `keyedSmokeEnv()` home): the active preset and the model of every tier, through the real loader.
 *
 * Lets a live smoke fail FAST and by name when the override does not take effect (an invalid layer dropped, a
 * `/preset` state file in `home` that outranks `activePreset`, a project override the walk does not find) instead of
 * after a multi-minute `opencode run` that dies on `Model not found: anthropic/…`. The process env is restored.
 */
export function effectiveTierModels(
  projectDir: string,
  home: string,
): { activePreset: string; models: Record<string, string | undefined>; warnings: string[] } {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const warn = console.warn;
  const warnings: string[] = [];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
  try {
    invalidateConfigCache();
    const cfg = loadConfig(projectDir);
    const tiers = resolveActiveTiers(cfg);
    const models = Object.fromEntries(["fast", "medium", "heavy"].map((name) => [name, tiers[name]?.model]));
    return { activePreset: cfg.activePreset, models, warnings };
  } finally {
    console.warn = warn;
    for (const key of ["HOME", "USERPROFILE"] as const) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    invalidateConfigCache();
  }
}
