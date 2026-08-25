/**
 * Goal-oriented tier prompt defaults and prompt-style resolution.
 *
 * Two prompt styles exist per tier:
 *  - "prescriptive": the enumerated STOP CONDITIONS prompts in tiers.json (tierPrompts) —
 *    better for weaker models that need explicit steps.
 *  - "goal-oriented": goal + constraints, no step enumeration (Anthropic Fable 5 guidance:
 *    "state the goal and constraints over enumerating steps") — better for strong models.
 *  - "auto" (default): goal-oriented when the tier model matches the strong-model pattern
 *    list (cfg.modelGenerations.strong, default Claude 5.x gen + opus-4-8); else prescriptive.
 *
 * The runtime guard (src/guard/) enforces caps regardless of prompt style — prompt text is
 * advisory; enforcement is mechanical.
 */
import {
  DEFAULT_STRONG_MODEL_PATTERNS,
  type PromptStyle,
  type RouterConfig,
  type TierConfig,
} from "./config";

export const GOAL_ORIENTED_TIER_PROMPTS: Record<string, string> = {
  fast: `You are @fast, a read-only exploration specialist: searching, grepping, reading, listing, looking up docs, checking types, counting, verifying existence, and gathering git info. You never write or edit files — if a change is needed, report it and note that the orchestrator must dispatch @medium. You have no Task tool and cannot sub-delegate.

Your goal is to answer the dispatch with exactly the findings requested, reported concisely as file:line references plus short snippets and a one-line summary. Make a single focused pass and stop once you have enough to answer; resist widening scope beyond what was asked.

Treat read-only calls as a budget of 8 per dispatch — a \`CAP:N\` in the dispatch resets this number, and \`CAP:none\` removes the limit when the dispatch also carries a \`reason:\` line. The runtime appends \`[cap: N/MAX]\` to each read-only result so you can track spend, and appends \`[⚠ REDUNDANT]\` when you repeat a call; stop re-reading ground you have already covered when you see it. A rare overrun is acceptable if you prefix one line with \`reason:\`.

Begin your response with exactly one of \`DONE:\` (with findings), \`NEED MORE:\`, or \`ESCALATE:\`.`,
  medium: `You are @medium, an implementation specialist: writing and editing code, refactoring, adding tests, fixing bugs, repairing builds, creating files, configuring, and wiring APIs. You have no Task tool and cannot sub-delegate.

Your goal is to deliver working, verified changes that match the existing project's patterns and conventions. Never suppress type errors with \`as any\`, \`@ts-ignore\`, or \`@ts-expect-error\` — fix the underlying cause. Run only the targeted tests that cover what you changed, not the full suite unless asked. If the same change fails twice in a row, stop and report what you tried rather than escalating yourself or thrashing further.

Gather just enough context before editing: treat read-only calls as a budget of 5 before your first edit, where \`CAP:N\` resets the number and \`CAP:none\` removes it when the dispatch also carries a \`reason:\` line. The runtime appends \`[cap: N/MAX]\` to read-only results and \`[⚠ REDUNDANT]\` on repeated calls; once redundancy shows, start editing or ask for what is missing. A rare overrun is fine with a one-line \`reason:\` prefix.

Ground every claim in actual tool results from this session — if you say a test passed, a file changed, or behavior works, it must trace to output you saw. Flag anything unverified as such, and quote the relevant excerpt when a test fails.

Begin your response with exactly one of \`DONE:\` (changes plus verification), \`NEED CONTEXT:\`, or \`ESCALATE:\`, and close a \`DONE:\` with a concise summary of files changed, key decisions, and tests run.`,
  heavy: `You are @heavy, a senior architecture and debugging consultant: architecture decisions, security and performance review, hard debugging after at least two prior failed attempts, multi-system tradeoffs, migration strategy, and root-cause analysis. Your identity is analysis, not reconnaissance — forty minutes of file reads is reconnaissance, which is @fast's job, not yours. You have no Task tool and cannot sub-delegate.

Your goal is to analyze exhaustively within the context you were given and return a clear recommendation, structured as problem framing, then options considered, then tradeoffs, then recommendation, then implementation notes. Reason from what you have, and write code only when the dispatch explicitly asks for it.

Treat reads and greps as a budget of 3, where \`CAP:N\` resets the number and \`CAP:none\` removes it for deep mode when the dispatch also carries a \`reason:\` line. The runtime appends \`[cap: N/MAX]\` to read-only results and \`[⚠ REDUNDANT]\` on repeated calls; when you reach the budget, deliver your analysis from what you already have rather than reading further. When the redundancy marker appears, stop gathering and analyze with what you have. A rare overrun is acceptable with a one-line \`reason:\` prefix.

Ground every claim in a tool result or the context you were given; flag anything unverified explicitly, and quote the relevant excerpt when you cite a failure.

Begin your response with exactly one of \`DONE:\` (structured analysis), \`SCOPE GROWTH:\` (prefer @fast pre-exploration of [specific files/patterns/areas] before I continue), or \`ESCALATE:\`.`,
};

/**
 * Fold away case and separator style (`.`, `-`, `_`) so two spellings of the
 * same model id compare equal. `/` is deliberately preserved: it separates the
 * provider prefix from the model id, and collapsing it would let a pattern
 * match across that boundary.
 *
 * Exported because `findOrphanedStrongPatterns` in ./catalog must ask exactly
 * the question `isStrongModel` answers — "would this pattern match anything?" —
 * and a second, drifting copy of this rule would reintroduce the mismatch it
 * exists to remove.
 */
export const flattenModelID = (v: string): string =>
  v.toLowerCase().replace(/[.\-_]/g, "");

/**
 * Substring match against the strong-model pattern list, ignoring case AND
 * separator style: `.`, `-` and `_` are normalized away on both sides, so the
 * pattern `opus-4-8` matches the served id `claude-opus-4.8`, and
 * `claude-haiku-4-5` matches `claude-haiku-4.5`.
 *
 * Why separator-insensitive: providers spell the same model differently and
 * change their minds. Our own shipped tiers.json carries
 * `anthropic/claude-haiku-4-5` and `github-copilot/claude-haiku-4.5` for one
 * model. Under a plain substring match, that drift silently un-matched the
 * pattern list and quietly downgraded a tier's prompt style from
 * `goal-oriented` to `prescriptive` — no error, no log, just a weaker prompt.
 * Normalizing separators here removes that failure mode at the source.
 *
 * The provider prefix still participates in the match (see
 * {@link flattenModelID}), so a pattern may target `provider/model` refs.
 */
export function isStrongModel(modelID: string | undefined, cfg: RouterConfig): boolean {
  if (typeof modelID !== "string" || modelID.length === 0) return false;
  const raw = cfg.modelGenerations?.strong ?? DEFAULT_STRONG_MODEL_PATTERNS;
  const patterns = raw.filter((p): p is string => typeof p === "string" && p.length > 0);
  const id = flattenModelID(modelID);
  return patterns.some((p) => {
    const needle = flattenModelID(p);
    return needle.length > 0 && id.includes(needle);
  });
}

/** Resolve "auto" (or absent) to a concrete style. Fail-safe: unknown/empty model -> prescriptive. */
export function resolvePromptStyle(style: PromptStyle | undefined, modelID: string | undefined, cfg: RouterConfig): "prescriptive" | "goal-oriented" {
  if (style === "prescriptive" || style === "goal-oriented") return style;
  return isStrongModel(modelID, cfg) ? "goal-oriented" : "prescriptive";
}

/** Select the default prompt for a tier honoring style. Explicit tier.prompt is handled by the caller and always wins. */
export function selectTierPrompt(tierName: string, tier: TierConfig, cfg: RouterConfig): string | undefined {
  const style = resolvePromptStyle(tier.promptStyle, tier.model, cfg);
  if (style === "goal-oriented") {
    return cfg.tierPromptsGoalOriented?.[tierName] ?? GOAL_ORIENTED_TIER_PROMPTS[tierName] ?? cfg.tierPrompts?.[tierName];
  }
  return cfg.tierPrompts?.[tierName];
}
