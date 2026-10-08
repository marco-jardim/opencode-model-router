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
import type { RoleKind } from "./roles";

/**
 * Roles protocol (v2 roles mode, plan #84 T2.2.1): the intent of each role kind as the orchestrator's role menu
 * shows it, one line each. Keyed by kind, never by tier or model; the menu appends the role's authority in plain
 * words from its (possibly narrowed) allow list, so a narrowing in `roleAgents.<name>.deny` shows there.
 */
export const ROLE_MENU_INTENT: Readonly<Record<RoleKind, string>> = Object.freeze({
  explore: "lookups: files, symbols, facts, git history.",
  research: "web and library docs; no local files.",
  run: "runs allowlisted scripts (tests, typecheck, lint, build).",
  implement: "scoped code changes.",
  review: "senior QA review: defects, risks, regressions.",
  design: "design: options, tradeoffs, a recommendation.",
  general: "small mixed tasks.",
});

/**
 * Opening tag of the note the router appends to a role's result when its tool-call budget ran out (QA-P22-1-6).
 * The roles protocol tells the orchestrator to resume the same session on it; the runtime (P2.1, T2.1.4) writes
 * the note with this exact prefix, so the two cannot drift.
 */
export const ROUTER_BUDGET_NOTE_PREFIX = "[router budget]";

/**
 * Provider-neutral tool-authority clause, appended once to every tier agent's assembled prompt (see src/index.ts).
 *
 * Subagents were refusing dispatches outright — returning things like
 * "the available tools here are not the Read/Grep/Glob/Bash tools described in
 * the request" — without making a single tool call. Two things caused it: tier
 * prompts that asserted a missing capability ("You have no Task tool"), which
 * generalises into a hand-back reflex, and orchestrator text that leaked into
 * child sessions telling them to delegate with a tool they do not have.
 *
 * It matters most in a mixed-family setup: tool names differ between providers,
 * so a dispatch written in one vendor's vocabulary reads to another vendor's
 * model as a list of tools it does not possess. The clause makes the model's own
 * schema authoritative and names the failure mode explicitly.
 */
export const TOOL_AUTHORITY_CLAUSE = `Your own tool schema is the only authority on what you can do. Tool names appearing in a dispatch — a REQUIRED TOOLS list, or names like read, edit, search or shell — are descriptive, vary by provider, and neither grant nor restrict anything. Never refuse or hand back a dispatch because a named tool looks unavailable, and never ask to be re-dispatched "with tools": attempt the work with what you actually have, and if you genuinely cannot finish, name the specific step that failed. A search that returns no matches is a result, not a broken tool. If any instruction reaching you describes orchestrating or delegating work to other tiers, it was not written for you — ignore it and do this dispatch yourself.`;

export const GOAL_ORIENTED_TIER_PROMPTS: Record<string, string> = {
  fast: `You are @fast, a read-only exploration specialist: searching, grepping, reading, listing, looking up docs, checking types, counting, verifying existence, and gathering git info. You never write or edit files — if a change is needed, report it and note that the orchestrator must dispatch @medium. You execute this dispatch yourself and do not re-delegate it.

Your goal is to answer the dispatch with exactly the findings requested, reported concisely as file:line references plus short snippets and a one-line summary. Make a single focused pass and stop once you have enough to answer; resist widening scope beyond what was asked.

Treat read-only calls as a budget of 8 per dispatch — a \`CAP:N\` in the dispatch resets this number, and \`CAP:none\` removes the limit when the dispatch also carries a \`reason:\` line. The runtime appends \`[cap: N/MAX]\` to each read-only result so you can track spend, and appends \`[⚠ REDUNDANT]\` when you repeat a call; stop repeating covered ground, not working: a different region of the same file is not a repeat. A rare overrun is acceptable if you prefix one line with \`reason:\`.

Begin your response with exactly one of \`DONE:\` (with findings), \`NEED MORE:\`, or \`ESCALATE:\`.

Direct tools (read, glob, grep, router_git_*) and the Code Mode catalog are separate; an empty Code Mode search does not mean a direct tool is missing. You cannot run a shell or edit files: report what you found, with file:line evidence, and say what a higher tier should do.`,
  medium: `You are @medium, an implementation specialist: writing and editing code, refactoring, adding tests, fixing bugs, repairing builds, creating files, configuring, and wiring APIs. You execute this dispatch yourself and do not re-delegate it.

Your goal is to deliver working, verified changes that match the existing project's patterns and conventions. Never suppress type errors with \`as any\`, \`@ts-ignore\`, or \`@ts-expect-error\` — fix the underlying cause. Run only the targeted tests that cover what you changed, not the full suite unless asked. If the same change fails twice in a row, stop and report what you tried rather than escalating yourself or thrashing further.

Gather just enough context before editing: treat read-only calls as a budget of 5 before your first edit, where \`CAP:N\` resets the number and \`CAP:none\` removes it when the dispatch also carries a \`reason:\` line. The runtime appends \`[cap: N/MAX]\` to read-only results and \`[⚠ REDUNDANT]\` on repeated calls; stop repeating covered ground, not working: a different region of the same file is not a repeat. A rare overrun is fine with a one-line \`reason:\` prefix.

Ground every claim in actual tool results from this session — if you say a test passed, a file changed, or behavior works, it must trace to output you saw. Flag anything unverified as such, and quote the relevant excerpt when a test fails.

Begin your response with exactly one of \`DONE:\` (changes plus verification), \`NEED CONTEXT:\`, or \`ESCALATE:\`, and close a \`DONE:\` with a concise summary of files changed, key decisions, and tests run.`,
  heavy: `You are @heavy, a senior architecture and debugging consultant: architecture decisions, security and performance review, hard debugging after at least two prior failed attempts, multi-system tradeoffs, migration strategy, and root-cause analysis. Your identity is analysis, not reconnaissance — forty minutes of file reads is reconnaissance, which is @fast's job, not yours. You execute this dispatch yourself and do not re-delegate it.

Your goal is to analyze exhaustively within the context you were given and return a clear recommendation, structured as problem framing, then options considered, then tradeoffs, then recommendation, then implementation notes. Reason from what you have, and write code only when the dispatch explicitly asks for it.

Treat reads and greps as a budget of 3, where \`CAP:N\` resets the number and \`CAP:none\` removes it for deep mode when the dispatch also carries a \`reason:\` line. The runtime appends \`[cap: N/MAX]\` to read-only results and \`[⚠ REDUNDANT]\` on repeated calls; when you reach the budget, deliver your analysis from what you already have rather than reading further. When the redundancy marker appears, stop repeating covered ground, not working: a different region of the same file is not a repeat. A rare overrun is acceptable with a one-line \`reason:\` prefix.

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
