/**
 * Pure presentation layer for the slash commands.
 *
 * Every function here is config/data in, markdown string out. No fs, no env,
 * no state writes, no mutation of the config it is handed. The
 * `command.execute.before` handlers in `src/index.ts` do the deciding and the
 * persisting, then call these to render the result.
 *
 * The split exists because the command bodies used to interleave three
 * different jobs — work out what the user asked for, persist it, and describe
 * what happened — which made the output impossible to test without a state
 * file on disk and a plugin instance to hang it off.
 */
import type { RouterConfig, ModeConfig } from "../router/config";
import { getActiveTiers } from "../router/protocol";
import { resolvePromptStyle } from "../router/prompts";
import type { Catalog, ModelIssue } from "../router/catalog";

/** `/tiers` */
export function buildTiersOutput(cfg: RouterConfig): string {
  const tiers = getActiveTiers(cfg);
  const lines: string[] = [
    `# Model Delegation Tiers`,
    `Active preset: **${cfg.activePreset}**\n`,
  ];

  for (const [name, tier] of Object.entries(tiers)) {
    const thinkingStr = tier.thinking
      ? ` | thinking: ${tier.thinking.budgetTokens} tokens`
      : tier.reasoning
        ? ` | reasoning: effort=${tier.reasoning.effort}`
        : "";
    // The auto rule flips strong models to goal-oriented silently, so show the
    // style the dispatch actually resolves to. An explicit `tier.prompt` wins
    // outright (src/index.ts: `tier.prompt ?? selectTierPrompt(...)`).
    const explicitStyle =
      tier.promptStyle === "prescriptive" || tier.promptStyle === "goal-oriented";
    const promptStr = tier.prompt
      ? " | prompt: custom"
      : ` | prompt: ${resolvePromptStyle(tier.promptStyle, tier.model, cfg)} (${
          explicitStyle ? "explicit" : "auto"
        })`;
    lines.push(`## @${name} -> \`${tier.model}\`${thinkingStr}${promptStr}`);
    if (tier.description) lines.push(tier.description);
    lines.push(`Steps: ${tier.steps ?? "default"}`);
    const whenToUse = tier.whenToUse ?? [];
    lines.push(whenToUse.length ? `Use when: ${whenToUse.join(", ")}\n` : "");
  }

  lines.push("## Delegation Rules");
  cfg.rules.forEach((r) => lines.push(`- ${r}`));
  lines.push(`\nDefault tier: @${cfg.defaultTier}`);
  lines.push(`\nAvailable presets: ${Object.keys(cfg.presets).join(", ")}`);
  lines.push(`Switch with: \`/preset <name>\``);
  lines.push(`Edit \`tiers.json\` to customize.`);

  return lines.join("\n");
}

/** `/preset` with no argument. */
export function buildPresetList(cfg: RouterConfig): string {
  const lines = ["# Available Presets\n"];
  for (const [name, tiers] of Object.entries(cfg.presets)) {
    const active = name === cfg.activePreset ? " <- active" : "";
    const models = Object.entries(tiers)
      .map(([tier, t]) => `${tier}: ${t.model.split("/").pop()}`)
      .join(", ");
    lines.push(`- **${name}**${active}: ${models}`);
  }
  lines.push(`\nSwitch with: \`/preset <name>\``);
  return lines.join("\n");
}

/**
 * `/preset <name>` after the switch has been persisted. Takes the resolved
 * name, so the caller owns resolution and this only describes the outcome.
 */
export function buildPresetSwitched(cfg: RouterConfig, name: string): string {
  const tiers = cfg.presets[name]!;
  const models = Object.entries(tiers)
    .map(([tier, t]) => `  @${tier} -> ${t.model}`)
    .join("\n");
  return [
    `Preset switched to **${name}**.`,
    "",
    models,
    "",
    "Selection is now persisted in ~/.config/opencode/opencode-model-router.state.json.",
    "Restart OpenCode for subagent model registration to take effect.",
    "System prompt delegation rules update immediately.",
  ].join("\n");
}

/** `/preset <name>` where the name resolves to nothing. */
export function buildUnknownPreset(cfg: RouterConfig, requested: string): string {
  return `Unknown preset: "${requested}". Available: ${Object.keys(cfg.presets).join(", ")}`;
}

/** `/budget` when tiers.json defines no modes at all. */
export function buildNoModes(): string {
  return 'No modes configured in tiers.json. Add a "modes" section to enable budget mode.';
}

/** `/budget` with no argument. */
export function buildBudgetList(cfg: RouterConfig): string {
  const modes = cfg.modes ?? {};
  const currentMode = cfg.activeMode || "normal";
  const lines = ["# Routing Modes\n"];
  for (const [name, mode] of Object.entries(modes)) {
    const active = name === currentMode ? " <- active" : "";
    lines.push(
      `- **${name}**${active}: ${mode.description} (default tier: @${mode.defaultTier})`,
    );
  }
  lines.push(`\nSwitch with: \`/budget <mode>\``);
  return lines.join("\n");
}

/** `/budget <mode>` after the switch has been persisted. */
export function buildBudgetSwitched(mode: ModeConfig, name: string): string {
  return [
    `Routing mode switched to **${name}**.`,
    "",
    mode.description,
    `Default tier: @${mode.defaultTier}`,
    ...(mode.overrideRules?.length
      ? ["", "Active rules:", ...mode.overrideRules.map((r) => `- ${r}`)]
      : []),
    "",
    "Mode change takes effect immediately on the next message.",
  ].join("\n");
}

/** `/budget <mode>` where the mode is not configured. */
export function buildUnknownMode(
  modes: Record<string, ModeConfig>,
  requested: string,
): string {
  return `Unknown mode: "${requested}". Available: ${Object.keys(modes).join(", ")}`;
}

/** `/bypass`, rendered from the resulting state rather than the argument. */
export function buildBypassMessage(bypassed: boolean): string {
  const status = bypassed ? "ON" : "OFF";
  const desc = bypassed
    ? "Model-router is **bypassed**. Delegation protocol, cap enforcement, and narration detection are disabled. The model will run without routing rules until you run `/bypass off` or restart OpenCode."
    : "Model-router is **active**. Delegation protocol and all enforcement rules are in effect.";
  return `# Bypass: ${status}\n\n${desc}`;
}

/** `/router enforce <mode>` after the mode has been persisted. */
export function buildEnforceSet(mode: "off" | "advisory" | "enforced"): string {
  const desc =
    mode === "off"
      ? "Hard-block guard disabled (default routing behaviour)."
      : mode === "advisory"
        ? "Guard evaluates and surfaces banners but never hard-blocks."
        : "Guard hard-blocks subagent tool calls that violate budget / redundancy / self-script policy.";
  return [
    `Enforcement mode set to **${mode}** and persisted.`,
    "",
    desc,
    "",
    "Note: the `MODEL_ROUTER_ENFORCE` env var, when set to `0` or `1`, overrides this setting.",
  ].join("\n");
}

/** `/router enforce` with a missing or unrecognized mode. */
export function buildEnforceStatus(current: string): string {
  return [
    `Current enforcement mode: **${current}**`,
    "",
    "Usage: `/router enforce <off|advisory|enforced>`",
  ].join("\n");
}

/**
 * Everything `/router overrides` needs to know about the filesystem, resolved
 * by the caller so this stays pure.
 */
export interface OverridesView {
  globalPath: string;
  globalPresent: boolean;
  /** The project file that was found, or the default create-location. */
  localPath: string;
  localPresent: boolean;
  /** False when localPath is a suggestion rather than a file that was found. */
  localFound: boolean;
  activePreset: string;
}

/** `/router overrides` */
export function buildOverridesOutput(v: OverridesView): string {
  const mark = (present: boolean) => (present ? "present" : "absent");
  const localNote = v.localFound
    ? ""
    : ` _(create at \`${v.localPath}\`; the project file is searched upward from the working dir to the repo root)_`;
  return [
    `# Model Router — config overrides`,
    "",
    "Config is loaded lowest→highest priority; each layer deep-merges over the previous one:",
    "",
    "1. bundled `tiers.json` (defaults)",
    `2. global — \`${v.globalPath}\` _(${mark(v.globalPresent)})_`,
    `3. project — \`${v.localPath}\` _(${mark(v.localPresent)})_${localNote}`,
    "",
    `Active preset: **${v.activePreset}**. Run \`/tiers\` to see the effective models after merging.`,
    "",
    "Create either file to customize models/tiers/presets without editing the cached `tiers.json`. Objects merge recursively; arrays and scalars are replaced.",
  ].join("\n");
}

/** Bare `/router`. */
export function buildRouterHelp(current: string): string {
  return [
    `# Model Router`,
    `Enforcement: **${current}**`,
    "",
    "Commands:",
    "- `/router enforce <off|advisory|enforced>` — set hard-block enforcement (persisted)",
    "- `/router overrides` — show the global + project override file paths and precedence",
    "- `/router models [provider]` — list valid model ids from your configured providers",
    "- `/tiers`, `/preset`, `/budget`, `/bypass`, `/annotate-plan`",
  ].join("\n");
}

/**
 * `/router models [provider]`. Takes the catalog the caller fetched, so a
 * failed or unavailable fetch is a null here rather than an exception path.
 */
export function buildModelsOutput(
  catalog: Catalog | null,
  filter: string,
  orphanedStrongPatterns: string[] = [],
): string {
  // Orphan patterns are pure config analysis, so they are appended to EVERY
  // return path — including the catalog-unavailable ones, where the warning is
  // just as valid.
  const suffix =
    orphanedStrongPatterns.length > 0
      ? "\n\n" +
        formatOrphanedStrongPatterns(orphanedStrongPatterns)
      : "";
  if (!catalog) {
    return (
      "Model catalog unavailable — could not query opencode's providers." + suffix
    );
  }
  if (catalog.providers.length === 0) {
    return "No providers are configured/authenticated in opencode." + suffix;
  }
  const f = filter.trim().toLowerCase();
  const providers = f
    ? catalog.providers.filter((p) => p.id.toLowerCase() === f)
    : catalog.providers;
  if (providers.length === 0) {
    return (
      `No configured provider matches \`${filter.trim()}\`. Available: ${catalog.providers
        .map((p) => p.id)
        .join(", ")}.` + suffix
    );
  }

  const lines: string[] = ["# Model Router — available models", ""];
  for (const p of providers) {
    const name = p.name && p.name !== p.id ? ` (${p.name})` : "";
    const def = p.defaultModel ? ` — default: \`${p.id}/${p.defaultModel}\`` : "";
    lines.push(`## ${p.id}${name}${def}`);
    const sorted = [...p.models].sort((a, b) => a.id.localeCompare(b.id));
    if (sorted.length === 0) {
      lines.push("- _(no models)_");
    } else {
      for (const m of sorted) {
        const flag = m.status && m.status !== "active" ? ` _(${m.status})_` : "";
        lines.push(`- \`${p.id}/${m.id}\`${flag}`);
      }
    }
    lines.push("");
  }
  lines.push(
    "Paste any id above into an overrides file (`/router overrides` shows where).",
  );
  return lines.join("\n") + suffix;
}

/**
 * Render strong-model patterns that match no model the configured providers
 * serve (see `findOrphanedStrongPatterns`). Only ever user-authored patterns:
 * shipped defaults are not reported. Report-only — the router never edits the
 * user's pattern list.
 */
export function formatOrphanedStrongPatterns(patterns: string[]): string {
  return [
    "⚠ **Strong-model patterns matching no model your providers serve:**",
    ...patterns.map((p) => `- \`${p}\``),
    "",
    "You set these in `modelGenerations.strong`, so they decide nothing here and tiers on `promptStyle: auto` resolve without them. Matching already ignores case and separator style, so `opus-4-8` finds `opus-4.8` — a pattern listed above is absent, not merely spelled differently. Fix or drop it in your overrides file (`/router overrides`).",
  ].join("\n");
}

/** Render model-validation issues for the active preset as a markdown block. */
export function formatModelIssues(issues: ModelIssue[]): string {
  const lines: string[] = ["⚠ **Model issues in the active preset:**"];
  for (const it of issues) {
    const what =
      it.kind === "provider-unknown" || it.kind === "fallback-provider-unknown"
        ? `provider \`${it.providerId}\` is not configured/authenticated` +
          (it.kind === "fallback-provider-unknown"
            ? " — this fallback chain can never fire"
            : "")
        : it.kind === "fallback-preset-unknown"
          ? `chain entry \`${it.chainTarget}\` is not a defined preset and is silently dropped`
          : it.kind === "model-deprecated"
            ? `\`${it.ref}\` is **deprecated**`
            : `\`${it.ref}\` was not found`;
    // Fallback issues are keyed by the chain's provider, not by a tier.
    const where =
      it.scope === "fallback" ? `${it.tier}[${it.providerId}]` : `@${it.tier}`;
    let line = `- ${where}: ${what}.`;
    if (it.suggestions.length > 0) {
      line += ` Try: ${it.suggestions.map((s) => `\`${s}\``).join(", ")}.`;
    }
    lines.push(line);
  }
  lines.push(
    "",
    "Set a replacement in your overrides file (`/router overrides`), then re-run `/router`.",
  );
  return lines.join("\n");
}
