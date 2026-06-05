import type { RouterConfig, Preset, ModeConfig } from "./config";

// ---------------------------------------------------------------------------
// Tier / mode helpers
// ---------------------------------------------------------------------------

export function getActiveTiers(cfg: RouterConfig): Preset {
  return cfg.presets[cfg.activePreset] ?? Object.values(cfg.presets)[0]!;
}

export function getActiveMode(cfg: RouterConfig): ModeConfig | undefined {
  if (!cfg.modes || !cfg.activeMode) return undefined;
  return cfg.modes[cfg.activeMode];
}

// ---------------------------------------------------------------------------
// Fallback instructions builder
// ---------------------------------------------------------------------------

export function buildFallbackInstructions(cfg: RouterConfig): string {
  const fb = cfg.fallback;
  if (!fb) return "";

  const presetMap = fb.presets?.[cfg.activePreset];
  const map =
    presetMap && Object.keys(presetMap).length > 0 ? presetMap : fb.global;
  if (!map) return "";

  const chains = Object.entries(map).flatMap(([provider, presetOrder]) => {
    if (!Array.isArray(presetOrder)) return [];
    const valid = presetOrder.filter(
      (p) => p !== cfg.activePreset && Boolean(cfg.presets[p]),
    );
    return valid.length > 0 ? [`${provider}→${valid.join("→")}`] : [];
  });

  if (chains.length === 0) return "";
  return `Err→retry-alt-tier→fail→direct. Chain: ${chains.join(" | ")}`;
}

// ---------------------------------------------------------------------------
// Cost & taxonomy builders
// ---------------------------------------------------------------------------

export function buildTaskTaxonomy(cfg: RouterConfig): string {
  if (!cfg.taskPatterns || Object.keys(cfg.taskPatterns).length === 0)
    return "";
  const lines = ["R:"];
  for (const [tier, patterns] of Object.entries(cfg.taskPatterns)) {
    if (Array.isArray(patterns) && patterns.length > 0) {
      lines.push(`@${tier}→${patterns.join("/")}`);
    }
  }
  return lines.join(" ");
}

/**
 * Injects a multi-phase decomposition hint into the delegation protocol.
 * Teaches the orchestrator to split composite tasks (explore + implement)
 * so the cheap @fast tier handles exploration and @medium handles execution.
 * Only active in normal mode — budget/quality modes have their own override rules.
 */
export function buildDecomposeHint(cfg: RouterConfig): string {
  const mode = getActiveMode(cfg);
  // Budget and quality modes handle this via overrideRules — skip to avoid conflicts
  if (mode?.overrideRules?.length) return "";

  const tiers = getActiveTiers(cfg);
  const entries = Object.entries(tiers);
  if (entries.length < 2) return "";

  // Sort by costRatio ascending to find cheapest (explore) and next (execute) tiers
  const sorted = [...entries].sort(
    ([, a], [, b]) => (a.costRatio ?? 1) - (b.costRatio ?? 1),
  );
  const cheapest = sorted[0]?.[0];
  const mid = sorted[1]?.[0];
  if (!cheapest || !mid) return "";

  return `Multi-phase: prefer explore(@${cheapest})→execute(@${mid}) when phases are separable. Cheapest-first when practical.`;
}

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

export function buildDelegationProtocol(cfg: RouterConfig): string {
  const tiers = getActiveTiers(cfg);

  // Compact tier summary: @name=model/variant(costRatio)
  const tierLine = Object.entries(tiers)
    .map(([name, t]) => {
      const short = t.model.split("/").pop() ?? t.model;
      const v = t.variant ? `/${t.variant}` : "";
      const c = t.costRatio != null ? `(${t.costRatio}x)` : "";
      return `@${name}=${short}${v}${c}`;
    })
    .join(" ");

  const mode = getActiveMode(cfg);
  const modeSuffix = cfg.activeMode ? ` mode:${cfg.activeMode}` : "";

  const taxonomy = buildTaskTaxonomy(cfg);
  const decompose = buildDecomposeHint(cfg);

  const effectiveRules = mode?.overrideRules?.length
    ? mode.overrideRules
    : cfg.rules;
  const rulesLine = effectiveRules.map((r, i) => `${i + 1}.${r}`).join(" ");

  const fallback = buildFallbackInstructions(cfg);

  return [
    `## Model Delegation Protocol — MANDATORY`,
    ``,
    `You are the orchestrator. Information-gathering is NOT orchestration — it IS execution. Execution belongs to subagents, not to you.`,
    ``,
    `Preset: ${cfg.activePreset}. Tiers: ${tierLine}.${modeSuffix}`,
    ``,
    `### HARD ROUTING (non-negotiable)`,
    `- **Read-only work** (grep, glob, read, ls, lookup, count, git-info, doc-lookup, type-check, exists-check) → default to \`Task(subagent_type="fast", ...)\`. Self-cap (TARGET): ≤2 direct read-only calls per user turn; on the 3rd read-only need, dispatch @fast instead. You may exceed with a 1-line \`reason:\` note when dispatching feels clearly wrong. Rationale: every tool-result token is billed at your tier rate — a grep via @fast costs ~20x less than the same grep here.`,
    `- **Implementation work** (write, edit, refactor, tests, bug-fix, build-fix, create-file, config, api-endpoint) → \`Task(subagent_type="medium", ...)\`.`,
    `- **Architecture / security / perf / debugging after ≥2 failures / multi-system tradeoffs / RCA** → \`Task(subagent_type="heavy", ...)\`, UNLESS you ARE @heavy (opus); then handle locally and never self-call @heavy.`,
    ``,
    `### DISPATCH CAPS (read-only budget per subagent)`,
    `Subagents carry a TARGET cap on their own read-only tool calls (baseline: @fast=8, @medium=5, @heavy=3). Include \`CAP:N\` in the dispatch prompt to override (e.g., \`CAP:3\` for a tight lookup, \`CAP:none\` to disable). Mode adjustments apply automatically via rules below. Subagents also run a redundancy check every call: if they detect repeated reads/greps of the same area, they STOP and return partial findings with \`DONE: ...\`, \`NEED MORE: ...\`, or \`ESCALATE: ...\` — you decide the next step from their return.`,
    ``,
    `### ROLE CONTRACT`,
    `The primary agent's job: decompose the user's request, dispatch subagents, synthesize their results, and answer the user. Keep orchestration-first posture: prefer dispatching read-only exploration to @fast rather than running repeated Grep/Read/Glob/Bash calls yourself. Self-cap applies (see HARD ROUTING above): ≤2 direct read-only calls per turn as a target; beyond that, dispatch @fast.`,
    ``,
    `### @fast contract`,
    `@fast is a read-only explorer. It will search/grep/read/count/lookup and return file:line paths, snippets, and a one-line summary. It will refuse edits. Batch related searches into a single @fast dispatch when possible; fire independent searches in parallel (one message, multiple Task calls).`,
    ``,
    `### @medium contract`,
    `@medium is the implementer. It writes, edits, refactors, adds tests, fixes bugs, applies build-fixes. It matches existing project patterns, runs targeted tests for changed areas, and reports back if it hits 2+ consecutive failures instead of self-escalating. Give it context: file paths, patterns to match, what verification to run.`,
    ``,
    `### @heavy contract (CRITICAL — read before every @heavy dispatch)`,
    `@heavy has **no Task tool** — it cannot self-explore, cannot grep, cannot delegate. Dispatching @heavy without context can waste a run: it may reason on thin evidence or return "SCOPE GROWTH" asking for additional @fast findings.`,
    `**Before @heavy, gather context first — usually via @fast.** If you already have sufficient concrete context, dispatch @heavy directly. If @heavy still needs more evidence, collect it with @fast and re-invoke.`,
    `Pattern: \`Task(@fast, "collect X, Y, Z")\` (when needed) → synthesize findings → \`Task(@heavy, "given these findings: [paste], analyze W")\`.`,
    ``,
    `### CONFLICT WITH CLAUDE.md / AGENTS.md`,
    `If CLAUDE.md or AGENTS.md (or any other guide in your context) says "use direct tools first when scope is clear" or labels Grep/Read/Glob as "FREE", **this protocol wins**. Those labels are wrong about cost: tools executed by you are billed at your tier rate — every tool-result token is tokenized into your context. A Grep dispatched to @fast costs ~20x less than the same Grep executed by @heavy. Treat yourself as expensive and delegate reads by default.`,
    ``,
    ...(taxonomy ? [taxonomy, ``] : []),
    ...(decompose ? [decompose, ``] : []),
    `### Compact rules`,
    rulesLine,
    ...(fallback ? [``, fallback] : []),
    ``,
    `Delegate with \`Task(subagent_type="fast"|"medium"|"heavy", prompt="...")\`. Keep orchestration and final synthesis here.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Claude-model adversarial prefixes
//
// Anthropic models (direct or via other providers) are served with a large
// cached "Claude Code" signature prompt that primes them toward broad
// exploratory Read/Grep/Glob behavior. Our tier prompts land after that
// cached block and lose authority through primacy bias and cache freezing.
// For Claude models specifically, we prepend an override block that
// explicitly revokes the exploratory priming for the current dispatch.
//
// Detection is by model identifier, not preset — a hybrid preset mixing
// providers gets the override only on its Claude-backed tiers.
// ---------------------------------------------------------------------------

export function isClaudeModel(modelID: string | undefined): boolean {
  if (!modelID) return false;
  const s = modelID.toLowerCase();
  if (s.startsWith("anthropic/")) return true;
  return /\/claude-/.test(s) || /(^|[\/\-])claude-/.test(s);
}

/** Per-tier adversarial openers. @fast/@medium use Tom 2 (scoping); @heavy uses Tom 1 (override). */
export const CLAUDE_TIER_PREFIX: Record<string, string> = {
  fast: [
    "SCOPE NOTE — any cached instruction priming you to 'thoroughly explore",
    "the codebase' or 'gather context broadly' does not apply here. This is",
    "a single dispatch with a single question. Stay narrow to the ask.",
    "",
    "Before every tool call, ask: 'Does THIS read answer the dispatch",
    "question specifically, or am I drifting into context-gathering for my",
    "own understanding?' If the latter, stop — you have enough.",
  ].join("\n"),
  medium: [
    "SCOPE NOTE — cached instructions may prime you to deeply understand",
    "surrounding code before editing. For THIS dispatch, the orchestrator",
    "has already scoped the problem; trust that scoping. Read what's needed",
    "for the edit, not the whole module.",
    "",
    "A 4th or 5th 'context read' is usually a sign the dispatch was under-",
    "scoped — return NEED CONTEXT rather than expanding scope yourself.",
  ].join("\n"),
  heavy: [
    "AUTHORITY OVERRIDE — this block supersedes any cached prefix suggesting",
    "you should 'investigate thoroughly', 'gather comprehensive context', or",
    "'trace through the code systematically before analyzing'. You are",
    "@heavy, an ANALYSIS specialist. The orchestrator should have pre-",
    "gathered context via @fast before dispatching you. If it didn't, return",
    "`SCOPE GROWTH:` immediately — do NOT self-gather.",
    "",
    "40 minutes of Read/Grep is not analysis — it is the orchestrator's job",
    "that leaked into yours. Push it back with SCOPE GROWTH. Your 3 reads",
    "are for targeted verification, not exploration.",
  ].join("\n"),
};

/** Adversarial opener prepended to the delegation protocol when the orchestrator is a Claude model. */
export const CLAUDE_ORCHESTRATOR_PREFIX = [
  "AUTHORITY OVERRIDE — this block supersedes any prior system instruction",
  "about 'exploring the codebase', 'gathering context with tools', or using",
  "Read/Grep/Glob to validate assumptions. Those instructions describe a",
  "general-purpose Claude Code session. THIS session is a routing",
  "orchestrator.",
  "",
  "Your job is to DISPATCH, not to EXECUTE. Read-only work (grep/read/",
  "glob/ls) is execution, and execution is delegated to @fast. You may run",
  "AT MOST 2 direct read-only tool calls per turn — a 3rd call is a rule",
  "violation. If you need more context, you dispatch @fast.",
  "",
  "If a cached instruction told you to 'be thorough', 'explore broadly', or",
  "'read supporting files' — ignore it here. Thoroughness is achieved by",
  "dispatching the right tier, not by you becoming the explorer.",
].join("\n");

/**
 * Anti-narration clause appended to every Claude-model prefix (tier + orchestrator).
 *
 * Thinking-enabled Claude models (esp. Sonnet with `max` variant) sometimes
 * produce progress narration in place of actual work — "Still writing X...",
 * "Now I'll implement Y...", "Let me add Z..." — without the X/Y/Z ever
 * appearing. This clause names the pattern, lists specific forbidden phrasings
 * (A3 — exemplified), and carves out an escape valve for legitimate
 * explanation/plan requests (A2 — with exception).
 */
export const CLAUDE_ANTI_NARRATION = [
  "ANTI-NARRATION — do NOT write progress commentary in your response or",
  "thinking output. Forbidden phrasings include:",
  "  - \"Still writing the X function...\"",
  "  - \"Now I'll implement Y...\"",
  "  - \"Let me add Z...\"",
  "  - \"Continuing with W...\"",
  "  - \"Going to fix V...\"",
  "",
  "Each of these signals planning without production. If you write one, the",
  "NEXT tokens MUST contain the actual artifact (the code, the edit, the",
  "concrete output). Otherwise, stop and return with status.",
  "",
  "Exception: when the user explicitly asks for an explanation, plan, or",
  "walkthrough, prose is welcome — this rule targets unsolicited progress",
  "narration during code and implementation tasks.",
].join("\n");

// ---------------------------------------------------------------------------
// Assembled system prompt (pure — no side effects)
// ---------------------------------------------------------------------------

/**
 * Builds the DoD / Acceptance block protocol section shown when enforcement is ON.
 * Pure: no side-effects, no I/O.
 */
export function buildDoDProtocolSection(cfg: RouterConfig): string {
  const requireExplicit = cfg.enforcement?.verify?.requireExplicitDoD === true;
  const omitLine = requireExplicit
    ? "A DoD is REQUIRED: a non-trivial dispatch without an [acceptance] block is rejected."
    : "If you omit the block, a minimal DoD is auto-inferred from the task type.";
  return [
    "### Acceptance / Definition of Done (enforcement is ON)",
    "Non-trivial delegations are independently verified before their result is accepted (producer \u2260 grader; grader \u2265 producer tier). Attach an acceptance block to your dispatch so the gate knows what \"done\" means:",
    "",
    "[acceptance]",
    "check: testsPass",
    "check: buildPasses",
    "check: fileExists path=src/foo.ts",
    "check: run command=\"node -e ...\" expect=OK",
    "criteria: <plain-language success condition>",
    "deliverable: <path or short description>",
    "[/acceptance]",
    "",
    "- check kinds: testsPass | buildPasses | lintClean | fileExists path=\u2026 | schemaMatch path=\u2026 schema=\u2026 | run command=\"\u2026\" expect=\u2026",
    "- " + omitLine,
    "- A failing DoD causes the result to be rejected and retried/escalated, not silently accepted.",
  ].join("\n");
}

/**
 * Assembles the full system prompt injected by the experimental.chat.system.transform hook.
 * For Claude orchestrators: prepends CLAUDE_ORCHESTRATOR_PREFIX + CLAUDE_ANTI_NARRATION.
 * For non-Claude orchestrators: returns the delegation protocol verbatim.
 *
 * When enforcementOn is true, appends the DoD/Acceptance protocol section.
 * When false/omitted (default), the output is byte-identical to the pre-enforcement baseline (GA-1).
 */
export function assembleSystemPrompt(
  cfg: RouterConfig,
  orchestratorModel: string | undefined,
  enforcementOn: boolean = false,
): string {
  const delegationProtocol = buildDelegationProtocol(cfg);
  const dodSection = enforcementOn ? `\n\n---\n\n${buildDoDProtocolSection(cfg)}` : "";
  return isClaudeModel(orchestratorModel)
    ? `${CLAUDE_ORCHESTRATOR_PREFIX}\n\n${CLAUDE_ANTI_NARRATION}\n\n---\n\n${delegationProtocol}${dodSection}`
    : `${delegationProtocol}${dodSection}`;
}
