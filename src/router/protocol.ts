import type { RouterConfig, Preset, ModeConfig } from "./config";
import type { RoleKind, RoleSpec } from "./roles";
import { ROLE_MENU_INTENT, ROUTER_BUDGET_NOTE_PREFIX } from "./prompts";
// The leaf module, not `protocol-line.ts`: that one imports this file (QA-P22-1-11).
import { generateRolesTaxonomy } from "../routing/engine/roles-taxonomy";

// ---------------------------------------------------------------------------
// Roles protocol (OpenCode v2, `routing.delegation: "roles"`; plan #84 §2.1–§2.5, T2.2.1)
// ---------------------------------------------------------------------------

/**
 * First line of {@link buildRolesProtocol}. Deliberately not {@link DELEGATION_PROTOCOL_HEADING}: the engine's
 * context hook (`src/routing/wire/hint.ts`) rewrites only the tiers protocol (tier `R:` line, route-line paragraph,
 * per-turn hint), so it never touches the roles text.
 */
export const ROLES_PROTOCOL_HEADING = "## Role Delegation Protocol (MANDATORY)";

/** Menu order: the shipped role order by kind; agents of one kind by name. */
const ROLE_MENU_ORDER: readonly RoleKind[] = ["explore", "research", "run", "implement", "review", "design", "general"];
const LOCAL_ACTIONS: ReadonlySet<string> = new Set(["read", "glob", "grep", "router_git"]);

/** A role's authority in plain words, from its allow list: dynamic roles get `edit`/`router_run` only on demand. */
function roleAuthorityWords(spec: RoleSpec): string {
  const allow: readonly string[] = spec.authority.allow;
  const held: string[] = allow.some((a) => LOCAL_ACTIONS.has(a)) ? ["read"] : [];
  const onDemand: string[] = [];
  for (const action of ["edit", "router_run"]) {
    if (allow.includes(action)) (spec.authority.mode === "dynamic" ? onDemand : held).push(action);
  }
  for (const action of ["webfetch", "websearch", "context7"]) if (allow.includes(action)) held.push(action);
  const words = [held.join(", "), onDemand.length > 0 ? `${onDemand.join(" and ")} on demand` : ""].filter((w) => w !== "");
  return words.length > 0 ? words.join("; ") : "none";
}

/**
 * The orchestrator's delegation protocol on OpenCode v2 roles mode, in place of {@link buildDelegationProtocol}
 * (which advertises the tiers, their models and the tier rules). It names the enabled role agents of `roles` only,
 * never a tier or a model: the router picks both per dispatch and always sets the per-call model.
 *
 * Cache-stable: the text depends on `routing.delegation` and the role table only (agents, kinds, allow lists,
 * authority mode), in a fixed order; nothing per turn (no clock, counter, session id, preset, model or evidence).
 *
 * "" outside roles mode and when no role is enabled, so a caller that falls back to the tiers protocol on "" keeps
 * tiers mode and v1 byte-identical (I1/I8).
 */
export function buildRolesProtocol(cfg: RouterConfig, roles: ReadonlyMap<string, RoleSpec>): string {
  if (cfg.routing?.delegation !== "roles") return "";
  const enabled = [...roles.values()]
    .filter((spec) => spec.enabled === true && ROLE_MENU_ORDER.includes(spec.kind))
    .sort((a, b) => ROLE_MENU_ORDER.indexOf(a.kind) - ROLE_MENU_ORDER.indexOf(b.kind) || (a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0));
  if (enabled.length === 0) return "";
  const agentOf = (kind: RoleKind): string | undefined => enabled.find((spec) => spec.kind === kind)?.agent;
  const menu = enabled.map((spec) => `- ${spec.agent}: ${ROLE_MENU_INTENT[spec.kind]} Authority: ${roleAuthorityWords(spec)}.`);
  const taxonomy = generateRolesTaxonomy(new Map(enabled.map((spec) => [spec.agent, spec] as const)));
  const researcher = agentOf("research");
  const editor = agentOf("implement") ?? agentOf("general");
  const runner = agentOf("run");
  const compose = researcher !== undefined && editor !== undefined
    ? ` Compose: ${researcher} first, then paste its findings into the ${editor} dispatch.`
    : "";
  // QA-P22-1-8: a tier agent is the exception for a command `router_run` refuses, never the default.
  const rawShell = runner !== undefined
    ? `Only when \`${runner}\` refuses a command that is not on its allowlist, ask the user or dispatch a tier agent explicitly.`
    : `For a command, ask the user or dispatch a tier agent explicitly.`;
  return [
    ROLES_PROTOCOL_HEADING,
    ``,
    `You are the orchestrator: delegate execution to role agents with \`subagent(agent="<role>", prompt="...")\` and answer the user yourself. Reading, searching and running commands are execution; you may make about 2 direct read-only calls per turn for a lookup that settles a question. Run independent dispatches in parallel, in one message.`,
    ``,
    `Roles (pick by intent; the router narrows each grant to the task):`,
    ...menu,
    ...(taxonomy ? [``, taxonomy] : []),
    ``,
    `The router chooses the model for every dispatch: never set \`model\` and never pick a tier; name the role.`,
    ``,
    // QA-P22-1-1: `tier`/`pin` are not in the template; only a plan's `[tier:X]` tag is transcribed.
    `Route line: when present it must be the FIRST line of the prompt (the router removes it; a malformed one is refused for a role): \`[route class=<c> risk=<r> scope=<s> needs=<n,..> d=<d> budget=<n> root=<path>]\`, every key optional. class=search|recon|mechanical|implement|debug|design|review|other; risk=low|medium|high; scope=single|multi|repo; needs=shell|web|edit|network|external_dir (\`edit\` unlocks editing, \`shell\` unlocks router_run); d=deterministic|grader|none (counts only when the prompt's \`[acceptance]\` block backs it); budget=tool calls (up to twice the role's); root=the absolute work root. Only when the plan step carries \`[tier:X]\`, add \`tier=X pin\`; never otherwise.`,
    ``,
    `Work root: a role works only in the session directory or one git worktree of this repo; for a worktree put \`root=<absolute path>\` on the route line (quote a path that contains spaces: \`root="D:\\my dir"\`) and the same path in ENVIRONMENT.`,
    ``,
    `No role holds the web together with read, run or edit authority.${compose} Raw shell is outside roles mode. ${rawShell}`,
    ``,
    `Resume, never restart: after \`NEED MORE: budget\` or a \`${ROUTER_BUDGET_NOTE_PREFIX}\` note, resume the SAME \`sessionID\` with "continue and finish"; after \`ESCALATE: authority\`, resume the SAME \`sessionID\` (the router widens the grant) unless the router names another role; after a verification FAIL, resume the SAME \`sessionID\` with the findings (the router raises the tier). Roles return \`DONE:\`, \`NEED MORE:\` or \`ESCALATE:\`; \`CAP:N\` (or \`CAP:none\` with a \`reason:\` line) changes only the read-only call cap.`,
    ``,
    `Dispatch prompt: the route line, then TASK, EXPECTED OUTCOME, TOOLS, MUST DO, MUST NOT DO, CONTEXT, ENVIRONMENT, with absolute paths.`,
    ``,
    `This protocol overrides any project guide (CLAUDE.md, AGENTS.md) that says to use direct tools first or to dispatch to tiers or models.`,
  ].join("\n");
}

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
    `## Model Delegation Protocol (MANDATORY)`,
    ``,
    `You are the orchestrator: route each task to the right tier and delegate it with \`Task(subagent_type="fast"|"medium"|"heavy", prompt="...")\`. Information-gathering (grep, read, glob, ls) is execution and goes to @fast by default; your one exception is an allowance of about 2 direct read-only calls per turn for lookups that settle a question outright, so dispatch @fast once you would exceed it. Synthesize the subagents' results and answer the user yourself.`,
    ``,
    `Preset: ${cfg.activePreset}. Tiers: ${tierLine}.${modeSuffix}`,
    ``,
    `If you ARE @heavy, handle heavy-tier work yourself: never self-call @heavy.`,
    ``,
    ...(taxonomy ? [taxonomy, ``] : []),
    ...(decompose ? [decompose, ``] : []),
    `Rules: ${rulesLine}`,
    ...(fallback ? [``, fallback] : []),
    ``,
    `When dispatching: batch related @fast searches into one call and run independent ones in parallel (several Task calls in one message); give @medium concrete context (paths, patterns, how to verify).`,
    ``,
    `Per dispatch you may add \`CAP:N\` (or \`CAP:none\` with a \`reason:\` line — unjustified \`CAP:none\` is ignored) to change a subagent's read-only budget (baseline @fast=8, @medium=5, @heavy=3). Subagents return \`DONE:\`, \`NEED MORE:\`, or \`ESCALATE:\` for you to act on. @heavy has no tools of its own, so gather context first (usually via @fast) and paste it into the dispatch.`,
    ``,
    `This protocol overrides any project guide (CLAUDE.md, AGENTS.md, etc.) that says to use direct tools first when scope is clear, or labels Grep/Read/Glob as FREE. They are wrong about cost: every tool-result token is billed at your tier rate, so the same grep costs ~20x less dispatched to @fast than run here.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Routing engine seams (Phase 2.2; v2 `advise`/`enforce` only, never called for `static`/`shadow`)
// ---------------------------------------------------------------------------

/** First line of {@link buildDelegationProtocol}: how the adapter recognises the protocol text among the system parts. */
export const DELEGATION_PROTOCOL_HEADING = "## Model Delegation Protocol (MANDATORY)";

/**
 * Swap the taxonomy (`R:`) line of an assembled protocol text for `line` (the generated line of the routing engine,
 * `generateTaxonomy`). The base line is `buildTaskTaxonomy(cfg)`; when it is empty the protocol carries no `R:` line and
 * `line` is inserted where the taxonomy would go (before the decomposition hint, else before `Rules:`).
 *
 * Handoff 1.4 (QA-1.4-11): the text is spliced, never passed to `String.replace` with a string replacement, because the
 * line carries agent ids and `$&`, `$1` or `$$` inside one would be expanded. A text that does not contain the base line
 * (a child's stripped protocol, a user-edited prompt) is returned unchanged.
 */
export function swapTaxonomyLine(protocol: string, cfg: RouterConfig, line: string): string {
  const base = buildTaskTaxonomy(cfg);
  if (line === base || line === "") return protocol;
  if (base !== "") {
    const at = protocol.indexOf(base);
    return at < 0 ? protocol : protocol.slice(0, at) + line + protocol.slice(at + base.length);
  }
  for (const anchor of [buildDecomposeHint(cfg), "Rules: "]) {
    if (anchor === "") continue;
    const at = protocol.indexOf(`\n${anchor}`);
    if (at >= 0) return `${protocol.slice(0, at + 1)}${line}\n\n${protocol.slice(at + 1)}`;
  }
  return protocol;
}

/**
 * The paragraph `advise` and `enforce` append to the delegation protocol (D13, A22): the optional first-line route
 * directive, the `pin` flag, and how to read the per-turn hint. It never asks the orchestrator to pick a model
 * (§0.10.11): the engine writes models itself. `static` and `shadow` never receive it (the text stays byte-identical).
 */
export function buildRouteLineProtocol(mode: "advise" | "enforce"): string {
  return [
    "Routing line (optional): when the FIRST line of a dispatch prompt is `[route class=<c> risk=<r> scope=<s> needs=<n,..> pin]`, the router reads it as the description of the work and removes it before the subagent sees it. Values: class = search|recon|mechanical|implement|debug|design|review|other; risk = low|medium|high; scope = single|multi|repo; needs = shell|web|edit|network|external_dir. Every field is optional and an unknown value is ignored. A route line anywhere but the first line is plain text.",
    "Add the bare flag `pin` when a plan tag or policy mandates the tier (a `[tier:X]` step, a QA review): a pinned dispatch is never switched.",
    mode === "enforce"
      ? "The router may start a dispatch on another agent than the one you name when recorded outcomes show it is cheaper or safer for that kind of work."
      : "The router does not change your dispatches; a `Route hint` line, when present, shows where recorded outcomes suggest sending the next one.",
    "Treat a `Route hint` as advice: follow it when it fits the task.",
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

/**
 * Claude models that only accept adaptive thinking: a manually supplied
 * thinking budget (and `{"type": "disabled"}`) is rejected. The list mirrors
 * the catalogue entries carrying `rejects_disabled_thinking` in
 * claude-code-wire-compat's 2.1.280 profile. Neighbours are deliberately not
 * covered: `claude-opus-5` and `claude-mythos-5` still accept a budget.
 */
const ADAPTIVE_ONLY_CLAUDE_MODELS = [
  "claude-opus-5-5",
  "claude-fable-5",
  "claude-fable-5-1",
  "claude-mythos-5-1",
];

export function isAdaptiveOnlyClaudeModel(modelID: string | undefined): boolean {
  if (!modelID || !isClaudeModel(modelID)) return false;
  // Same family matching as isClaudeModel, plus dots folded to dashes so a
  // provider re-spelling (`claude-fable-5.1`) lands on the catalogue id. The
  // id must end at the model name, optionally followed by a date stamp
  // (`-YYYYMMDD`, or the Vertex `@YYYYMMDD` form) and a bracketed tag (`[1m]`),
  // so `claude-opus-5` never matches `claude-opus-5-5` and vice versa.
  const s = modelID.toLowerCase().replace(/\./g, "-");
  return ADAPTIVE_ONLY_CLAUDE_MODELS.some((id) =>
    new RegExp(`(^|[\\/\\-])${id}([-@]\\d{8})?(\\[[^\\]]*\\])?$`).test(s),
  );
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
 * Description of the `delegate` tool. It is not parsed as dispatch text, so it shows the literal,
 * working `VERIFY:required` form (QA-2.3-3).
 */
export const DELEGATE_TOOL_DESCRIPTION =
  "Delegate a task to a tier subagent (fast | medium | heavy). Required-mode delegations and DoDs without testsPass are verified independently (deterministic checks, or a grader at >= the producer tier in a fresh session) before return: an accepted result on PASS, an honest 'unmet' status on FAIL. A DoD containing testsPass is deferred by default as a whole (its build, lint, run and criteria checks too) and returns UNVERIFIED with a `[router] unverified \u00b7 vrf_\u2026` footer, a risk level and a handle; verify it with router_verify, or put `VERIFY:required` in the task for a synchronous gate. Optionally pass an [acceptance]...[/acceptance] block to define the Definition of Done.";

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
    "Non-trivial delegations are verified independently (producer \u2260 grader; grader \u2265 producer tier). Required-mode delegations and DoDs without testsPass are gated before return; a DoD containing testsPass defers by default as a whole (its build, lint, run and criteria checks too) and returns unverified with a `[router] unverified \u00b7 vrf_\u2026` footer, a risk level and a handle. Attach an acceptance block to your dispatch so the gate knows what \"done\" means:",
    "",
    "[acceptance]",
    "check: testsPass",
    "check: buildPasses",
    "check: fileExists path=src/foo.ts",
    "check: run command=\"node verify.js\" expect=OK",
    "criteria: <plain-language success condition>",
    "deliverable: <path or short description>",
    "[/acceptance]",
    "",
    "- check kinds: testsPass | buildPasses | lintClean | fileExists path=\u2026 | schemaMatch path=\u2026 schema=\u2026 | run command=\"\u2026\" expect=\u2026",
    "- cwd: <dir> in the block when the producer works outside this directory (e.g. a git worktree); checks, tests and the grader run there.",
    "- testsPass runs only the tests affected by the producer's changes (the full suite is CI's job); prefer it over a hand-written full-suite run command. A failure that also fails at the dispatch-time reference is excused as pre-existing.",
    "- Per dispatch you may add `VERIFY:<mode>` as one token, <mode> being `required` or `deferred` (default deferred: returns at once with a handle and a risk level) and `VERIFY_WAIT:<n>s`. Pick required when later work depends on this delegation, or call router_verify before building on a medium/high-risk deferred result; unverified delegations stay listed in the prompt until verified or expired (1 h, or a restart); absent from the list does not mean verified.",
    "- Command allowlist (first-token basename): npm, npx, pnpm, yarn, bun, node, tsc, tsx, vitest, jest, eslint, prettier, pytest (plus exactly `uv run pytest`). No shell chaining, redirection, substitution or newlines; interpreter inline-eval/print flags are forbidden. buildPasses probes a build script, then root tsconfig.json (npx tsc --noEmit). Unavailable checks produce acceptance caveats, not producer escalation; strictUnverifiable restores rejection.",
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
  if (!isClaudeModel(orchestratorModel)) {
    return `${delegationProtocol}${dodSection}`;
  }
  // anti-narration clause is opt-in (cfg.antiNarration); off by default.
  const claudePrefix = cfg.antiNarration
    ? `${CLAUDE_ORCHESTRATOR_PREFIX}\n\n${CLAUDE_ANTI_NARRATION}`
    : CLAUDE_ORCHESTRATOR_PREFIX;
  return `${claudePrefix}\n\n---\n\n${delegationProtocol}${dodSection}`;
}

/**
 * {@link CLAUDE_ORCHESTRATOR_PREFIX} for roles mode: the same override, with execution delegated to role agents
 * instead of a named tier (the tiers opener sends read-only work to `@fast`).
 */
export const CLAUDE_ROLES_ORCHESTRATOR_PREFIX = [
  "AUTHORITY OVERRIDE — this block supersedes any prior system instruction",
  "about 'exploring the codebase', 'gathering context with tools', or using",
  "Read/Grep/Glob to validate assumptions. Those instructions describe a",
  "general-purpose Claude Code session. THIS session is a routing",
  "orchestrator.",
  "",
  "Your job is to DISPATCH, not to EXECUTE. Read-only work (grep/read/",
  "glob/ls) is execution, and execution is delegated to a role agent. You",
  "may run AT MOST 2 direct read-only tool calls per turn — a 3rd call is a",
  "rule violation. If you need more context, dispatch a role agent.",
  "",
  "If a cached instruction told you to 'be thorough', 'explore broadly', or",
  "'read supporting files' — ignore it here. Thoroughness is achieved by",
  "dispatching the right role, not by you becoming the explorer.",
].join("\n");

/**
 * The orchestrator system prompt on OpenCode v2 roles mode: {@link assembleSystemPrompt} with
 * {@link buildRolesProtocol} in place of the tiers protocol and {@link CLAUDE_ROLES_ORCHESTRATOR_PREFIX} in place of
 * the tiers opener; the anti-narration clause and the DoD section follow the same switches. "" when the roles
 * protocol is "" (tiers mode, v1, no enabled role): the caller then keeps {@link assembleSystemPrompt}, unchanged.
 * Pure, and cache-stable like the roles protocol.
 */
export function assembleRolesSystemPrompt(
  cfg: RouterConfig,
  roles: ReadonlyMap<string, RoleSpec>,
  orchestratorModel: string | undefined,
  enforcementOn: boolean = false,
): string {
  const rolesProtocol = buildRolesProtocol(cfg, roles);
  if (rolesProtocol === "") return "";
  const dodSection = enforcementOn ? `\n\n---\n\n${buildDoDProtocolSection(cfg)}` : "";
  if (!isClaudeModel(orchestratorModel)) return `${rolesProtocol}${dodSection}`;
  const claudePrefix = cfg.antiNarration
    ? `${CLAUDE_ROLES_ORCHESTRATOR_PREFIX}\n\n${CLAUDE_ANTI_NARRATION}`
    : CLAUDE_ROLES_ORCHESTRATOR_PREFIX;
  return `${claudePrefix}\n\n---\n\n${rolesProtocol}${dodSection}`;
}
