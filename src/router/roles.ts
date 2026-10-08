import { DETECTIONS, type Detection } from "../routing/classify/types";
import { resolveActiveTiers, type Preset, type RouterConfig } from "./config";
import { GIT_TOOL_NAMES } from "./git-tools";
import { pluginAgentPolicy, type PluginAgentConfig } from "./plugin-agents";
import { CONTEXT7_DOC_TOOLS, permissionMatches, permissionRules, type PermissionMap } from "./read-only";
import { AUTHORITY_ACTIONS, narrowRoleSpec, type RolesIssue } from "./roles-config";

export type RoleKind =
  | "explore"
  | "research"
  | "run"
  | "implement"
  | "review"
  | "design"
  | "general";

export type AuthorityAction =
  | "read"
  | "glob"
  | "grep"
  | "router_git"
  | "router_run"
  | "edit"
  | "webfetch"
  | "websearch"
  | "context7"
  | "execute";

export interface RoleSpec {
  agent: string;
  kind: RoleKind;
  description: string;
  prompt: string;
  authority: {
    mode: "fixed" | "dynamic";
    allow: readonly AuthorityAction[];
    deny: readonly AuthorityAction[];
  };
  tierRange: { floor: string; ceiling: string };
  assurance: Detection;
  guard: "reader" | "producer";
  budget: Readonly<Record<string, number>>;
  enabled: boolean;
}

export interface RolesRoutingConfig {
  delegation: "tiers" | "roles";
  workRoots: readonly string[];
}

export interface ExplorationConfig {
  rate: number;
  requireDetection: "deterministic";
}

export interface RunConfig {
  scripts: readonly string[];
  commands: Readonly<
    Record<string, { argv: readonly string[]; args?: readonly string[] }>
  >;
  timeoutMs: number;
}

// ---------------------------------------------------------------------------
// Separation rule (I4): action classes and the validator
// ---------------------------------------------------------------------------

export type ActionClass = "local" | "exec" | "write" | "egress";

/** Class of each role action (plan §2.2). `execute` (Code Mode) is egress: its inner calls are never checked. */
export const ACTION_CLASS: Readonly<Record<AuthorityAction, ActionClass>> = Object.freeze({
  read: "local",
  glob: "local",
  grep: "local",
  router_git: "local",
  router_run: "exec",
  edit: "write",
  webfetch: "egress",
  websearch: "egress",
  context7: "egress",
  execute: "egress",
});

/** Host action names of the local class; `external_directory` counts as local (§2.2, R4). */
const HOST_LOCAL: ReadonlySet<string> = new Set(["read", "glob", "grep", "list", "lsp", "skill", "external_directory", "router_git", ...GIT_TOOL_NAMES]);
const HOST_WRITE: ReadonlySet<string> = new Set(["edit", "write", "patch", "multiedit", "apply_patch"]);
const HOST_EXEC: ReadonlySet<string> = new Set(["router_run"]);
/** Host actions that reach neither repository data nor the network. */
const HOST_NEUTRAL: ReadonlySet<string> = new Set(["todowrite", "todoread", "question"]);

/**
 * Class of an action or host tool name. Anything not known to be local, exec, write or
 * neutral is egress: `shell`/`bash`, MCP tools (`context7_*`, `brave_*`, …), `execute`,
 * `subagent`/`task`/`delegate`, and unknown names (fail closed).
 */
export function classifyAction(name: string): ActionClass | "neutral" {
  const n = name.toLowerCase();
  if (Object.hasOwn(ACTION_CLASS, n)) return ACTION_CLASS[n as AuthorityAction];
  if (HOST_LOCAL.has(n)) return "local";
  if (HOST_EXEC.has(n)) return "exec";
  if (HOST_WRITE.has(n)) return "write";
  if (HOST_NEUTRAL.has(n)) return "neutral";
  return "egress";
}

/** Why a grant violates the separation rule (local, exec or write together with egress), or undefined. */
export function separationProblem(actions: Iterable<string>): string | undefined {
  const near: string[] = [];
  const far: string[] = [];
  for (const action of actions) {
    const cls = classifyAction(action);
    if (cls === "egress") far.push(action);
    else if (cls !== "neutral") near.push(action);
  }
  if (near.length === 0 || far.length === 0) return undefined;
  return `grants local/exec/write (${near.join(", ")}) together with egress (${far.join(", ")}): separation rule I4`;
}

/** Stands for every tool name the router cannot list (MCP servers added later): egress. */
const UNLISTED_TOOL_PROBE = "mcp_unlisted_tool";
const PROBE_ACTIONS: readonly string[] = [...new Set([
  ...AUTHORITY_ACTIONS, ...HOST_LOCAL, ...HOST_WRITE, ...HOST_EXEC, ...HOST_NEUTRAL,
  "shell", "bash", "browser", "subagent", "task", "delegate", "codesearch", ...CONTEXT7_DOC_TOOLS, "brave_web_search",
  UNLISTED_TOOL_PROBE,
])];

/**
 * Action names a permission map can grant (allow or ask). Over-approximates: an action counts
 * as granted when some allow/ask rule matches it and no later blanket (`*` resource) deny does.
 * A wildcard key also grants every probe it matches, and its own (unknown, so egress) name.
 */
export function grantedActions(permission: PermissionMap): string[] {
  const rules = permissionRules(permission);
  const candidates = new Set([...PROBE_ACTIONS, ...rules.map((r) => r.action)]);
  const granted: string[] = [];
  for (const name of candidates) {
    const hit = rules.some((rule, i) => rule.effect !== "deny" && permissionMatches(name, rule.action)
      && !rules.slice(i + 1).some((later) => later.effect === "deny" && later.resource === "*" && permissionMatches(name, later.action)));
    if (hit) granted.push(name);
  }
  return granted;
}

/**
 * Separation check of a #81 plugin agent, over the policy the router would publish for it
 * on v2. `context7` defaults to true (the read-only base then grants the context7 tools).
 */
export function pluginAgentSeparationProblem(entry: unknown, context7 = true): string | undefined {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return "is not an agent definition";
  let permission: PermissionMap;
  try {
    permission = pluginAgentPolicy(entry as Pick<PluginAgentConfig, "readOnly" | "allowTools" | "permission">, { context7, host: "v2" }).permission;
  } catch {
    return "has a permission policy that cannot be evaluated";
  }
  return separationProblem(grantedActions(permission));
}

// ---------------------------------------------------------------------------
// Shipped role specs (plan §2.2 as amended by R6)
// ---------------------------------------------------------------------------

const ROLE_KINDS: readonly RoleKind[] = ["explore", "research", "run", "implement", "review", "design", "general"];
const CANONICAL_TIERS: readonly string[] = ["fast", "medium", "heavy"];

/** Work-root rule (§2.2, R3/R4) carried by every shipped role prompt. */
export const WORK_ROOT_RULE =
  "Work root: work only inside this dispatch's work root, named in ENVIRONMENT or by `root=`; without one it is the session directory. Paths anywhere else are denied. If you have `router_run`, pass `cwd` = the work root.";
/** Return contract carried by every shipped role prompt. */
export const RETURN_CONTRACT =
  "Return: start with `DONE:`, `NEED MORE:` or `ESCALATE:`, then the result with evidence as `file:line`.";
/** Producer roles: a denied edit is an authority escalation, never a diff in prose. */
export const EDIT_DENIED_RULE = "If `edit` is denied return `ESCALATE: authority`; never deliver a diff as text.";

const LOCAL: readonly AuthorityAction[] = ["read", "glob", "grep", "router_git"];

function freezeSpec(spec: RoleSpec): RoleSpec {
  return Object.freeze({
    ...spec,
    authority: Object.freeze({
      mode: spec.authority.mode,
      allow: Object.freeze([...spec.authority.allow]),
      deny: Object.freeze([...spec.authority.deny]),
    }),
    tierRange: Object.freeze({ ...spec.tierRange }),
    budget: Object.freeze({ ...spec.budget }),
  });
}

function role(
  agent: string,
  kind: RoleKind,
  mode: "fixed" | "dynamic",
  allow: readonly AuthorityAction[],
  range: readonly [floor: string, ceiling: string],
  assurance: Detection,
  guard: "reader" | "producer",
  budget: Record<string, number>,
  description: string,
  intro: readonly string[],
): RoleSpec {
  return freezeSpec({
    agent,
    kind,
    description,
    prompt: [...intro, WORK_ROOT_RULE, RETURN_CONTRACT].join("\n"),
    // The deny list is the complement of the allow list, so `execute` is denied to every role.
    authority: { mode, allow, deny: AUTHORITY_ACTIONS.filter((a) => !allow.includes(a)) },
    tierRange: { floor: range[0], ceiling: range[1] },
    assurance,
    guard,
    budget,
    enabled: true,
  });
}

/**
 * The shipped role agents (v2, `routing.delegation: "roles"`). They live in code, not in
 * tiers.json: authority must never come from a file that is deep-merged with user layers, and
 * a new top-level tiers.json key would change tiers mode (I1). Users narrow them through
 * `roleAgents` (global layer only). Implementer and general default to `none`: the effective
 * assurance is the weaker of the route-line claim and the prompt's `[acceptance]` block, so the
 * role never claims more than the dispatch proves (§2.1).
 */
export const SHIPPED_ROLE_SPECS: readonly RoleSpec[] = Object.freeze([
  role("explorer", "explore", "fixed", LOCAL, ["fast", "medium"], "none", "reader", { fast: 30, medium: 40 },
    "Read-only codebase exploration: finds files, symbols and facts in the work root.",
    ["You are explorer, a read-only code explorer. Find files, symbols and facts with read, glob, grep and router_git. Never edit, run commands or use the web; report findings, not plans."]),
  role("researcher", "research", "fixed", ["webfetch", "websearch", "context7"], ["fast", "medium"], "none", "reader", { fast: 30, medium: 40 },
    "Web and library documentation research (webfetch, websearch, context7); no local file access.",
    ["You are researcher. Answer from the web and library documentation with webfetch, websearch and context7. You have no local file access and cannot edit or run anything. Cite every source by URL (in place of `file:line`) and mark unverified claims."]),
  role("runner", "run", "fixed", [...LOCAL, "router_run"], ["fast", "medium"], "deterministic", "reader", { fast: 25, medium: 40 },
    "Runs the repository's checks (tests, typecheck, lint, build) with router_run and reports the results; never edits.",
    ["You are runner. Run the requested checks with router_run (package scripts or configured commands) and read files only to explain failures. Never edit. Report each run's exit code and quote the failing output."]),
  role("implementer", "implement", "dynamic", [...LOCAL, "edit", "router_run"], ["fast", "heavy"], "none", "producer", { fast: 40, medium: 80, heavy: 120 },
    "Implements a scoped change in the work root; runs checks when the task needs them.",
    ["You are implementer. Make the requested change with edit, minimal and in scope; read before you edit. Run checks with router_run only when you have it. If another action is needed, return `ESCALATE: authority` naming it.", EDIT_DENIED_RULE]),
  role("reviewer", "review", "fixed", [...LOCAL, "router_run"], ["heavy", "heavy"], "none", "reader", { heavy: 120 },
    "Read-only senior review: defects, risks and regressions, confirmed with router_run where a run settles them.",
    ["You are reviewer, a read-only senior reviewer. Find defects, risks and regressions; confirm a claim with router_run when a run settles it. Never edit. Rank findings by severity."]),
  role("architect", "design", "fixed", LOCAL, ["medium", "heavy"], "none", "reader", { medium: 80, heavy: 120 },
    "Read-only design analysis: framing, options, tradeoffs and a recommendation.",
    ["You are architect, a read-only design consultant. From the given context and the code, return the problem framing, options, tradeoffs and a recommendation. Never edit or run anything."]),
  role("general", "general", "dynamic", [...LOCAL, "edit", "router_run"], ["fast", "heavy"], "none", "producer", { fast: 40, medium: 80, heavy: 120 },
    "General-purpose work in the work root; its authority follows the task's needs (local, edit, router_run).",
    ["You are general. Do the task with the tools you are granted. If an action you need is not granted, return `ESCALATE: authority` naming it.", EDIT_DENIED_RULE]),
]);

/**
 * Every problem of a role spec. Always: kind, mode, actions, `execute` allowed or not denied
 * (R6/P-6), the separation rule (I4), tier range, assurance, guard, budget. `shipped` adds the
 * prompt contract, the work-root rule, a complete allow/deny partition and budgets per tier.
 */
export function roleSpecProblems(spec: RoleSpec, opts: { shipped?: boolean } = {}): string[] {
  const p: string[] = [];
  if (!ROLE_KINDS.includes(spec.kind)) p.push(`kind ${String(spec.kind)} is not a role kind`);
  if (typeof spec.description !== "string" || spec.description.trim() === "") p.push("description is empty");
  if (typeof spec.prompt !== "string" || spec.prompt.trim() === "") p.push("prompt is empty");
  const { mode, allow, deny } = spec.authority;
  if (mode !== "fixed" && mode !== "dynamic") p.push(`authority.mode ${String(mode)} is not fixed|dynamic`);
  const unknown = [...allow, ...deny].filter((a) => !AUTHORITY_ACTIONS.includes(a));
  if (unknown.length > 0) p.push(`unknown actions: ${unknown.join(", ")}`);
  const both = allow.filter((a) => deny.includes(a));
  if (both.length > 0) p.push(`actions both allowed and denied: ${both.join(", ")}`);
  if (allow.includes("execute")) p.push("allows execute (Code Mode inner calls are never permission-checked, R6/P-6)");
  if (!deny.includes("execute")) p.push("does not deny execute (R6/P-6)");
  const separation = separationProblem(allow);
  if (separation !== undefined) p.push(separation);
  const { floor, ceiling } = spec.tierRange;
  if (typeof floor !== "string" || floor === "" || typeof ceiling !== "string" || ceiling === "") p.push("tierRange needs a floor and a ceiling");
  if (!DETECTIONS.includes(spec.assurance)) p.push(`assurance ${String(spec.assurance)} is not ${DETECTIONS.join("|")}`);
  if (spec.guard !== "reader" && spec.guard !== "producer") p.push(`guard ${String(spec.guard)} is not reader|producer`);
  const budget = Object.entries(spec.budget);
  if (budget.length === 0) p.push("has no budget");
  for (const [tier, n] of budget) if (!(typeof n === "number" && Number.isFinite(n) && n > 0)) p.push(`budget.${tier} must be > 0`);
  if (typeof spec.enabled !== "boolean") p.push("enabled must be a boolean");
  if (opts.shipped === true) {
    const open = AUTHORITY_ACTIONS.filter((a) => !allow.includes(a) && !deny.includes(a));
    if (open.length > 0) p.push(`neither allows nor denies ${open.join(", ")}`);
    for (const marker of ["`DONE:`", "`NEED MORE:`", "`ESCALATE:`", "`file:line`"]) {
      if (!spec.prompt.includes(marker)) p.push(`prompt lacks ${marker}`);
    }
    if (!spec.prompt.includes(WORK_ROOT_RULE)) p.push("prompt lacks the work-root rule");
    if (allow.includes("edit") && !spec.prompt.includes(EDIT_DENIED_RULE)) p.push("prompt lacks the edit-denied rule");
    const lo = CANONICAL_TIERS.indexOf(floor);
    const hi = CANONICAL_TIERS.indexOf(ceiling);
    if (lo === -1 || hi === -1 || lo > hi) p.push(`tierRange ${floor}..${ceiling} is not inside ${CANONICAL_TIERS.join("..")}`);
    else {
      const want = CANONICAL_TIERS.slice(lo, hi + 1).join(",");
      const got = Object.keys(spec.budget).join(",");
      if (got !== want) p.push(`budget tiers ${got} differ from the range ${want}`);
    }
  }
  return p;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface RoleTable {
  /** Enabled role agents by name (frozen). */
  readonly roles: ReadonlyMap<string, RoleSpec>;
  /** Notices: clamps, narrowing issues, dropped or replacing #81 agents, invalid roles. */
  readonly issues: readonly RolesIssue[];
  /** #81 `agents` with a shipped role name that fail the separation rule: not to be registered in roles mode. */
  readonly droppedAgents: readonly string[];
  /** #81 `agents` with a shipped role name that pass it: they replace the shipped role. */
  readonly replacedRoles: readonly string[];
}

function freezeMap<K, V>(map: Map<K, V>): ReadonlyMap<K, V> {
  const readOnly = (): never => {
    throw new TypeError("the role table is read-only");
  };
  Object.defineProperties(map, { set: { value: readOnly }, delete: { value: readOnly }, clear: { value: readOnly } });
  return Object.freeze(map);
}

const EMPTY_TABLE: RoleTable = Object.freeze({
  roles: freezeMap(new Map<string, RoleSpec>()),
  issues: Object.freeze([]),
  droppedAgents: Object.freeze([]),
  replacedRoles: Object.freeze([]),
});

/** Tier names of a preset from cheapest to dearest: by `costRatio` when every tier has one, else as listed. */
function tierOrder(preset: Preset): string[] {
  const names = Object.keys(preset);
  const costs = names.map((n) => (preset[n] as { costRatio?: unknown } | undefined)?.costRatio);
  if (!costs.every((c) => typeof c === "number" && Number.isFinite(c))) return names;
  return names.map((n, i) => ({ n, c: costs[i] as number, i })).sort((a, b) => a.c - b.c || a.i - b.i).map((x) => x.n);
}

/**
 * The shipped range placed on the active preset, narrowing only: a range whose tiers all exist
 * is kept; otherwise it shrinks to the preset's tiers inside it on the fast..heavy scale.
 * Undefined when no tier of the preset lies inside it.
 */
function placeRange(range: RoleSpec["tierRange"], order: readonly string[]): RoleSpec["tierRange"] | undefined {
  const f = order.indexOf(range.floor);
  const c = order.indexOf(range.ceiling);
  if (f !== -1 && c !== -1) return f <= c ? { floor: range.floor, ceiling: range.ceiling } : undefined;
  const lo = CANONICAL_TIERS.indexOf(range.floor);
  const hi = CANONICAL_TIERS.indexOf(range.ceiling);
  if (lo === -1 || hi === -1) return undefined;
  const inside = order.filter((t) => {
    const k = CANONICAL_TIERS.indexOf(t);
    return k >= lo && k <= hi;
  });
  const first = inside[0];
  const last = inside[inside.length - 1];
  return first === undefined || last === undefined ? undefined : { floor: first, ceiling: last };
}

/**
 * The role table for a host, with its notices. Empty on v1 and unless `routing.delegation` is
 * `roles`. Otherwise: each shipped spec (an invalid one is skipped, fail closed), placed on the
 * active preset's tiers, narrowed by `roleAgents.<name>`, re-validated (I4), disabled roles
 * left out. A #81 `agents` entry with a role name replaces the role when it passes the
 * separation rule, else it is dropped and the shipped role stays (tiers mode/v1: untouched).
 */
export function resolveRoleTable(
  cfg: RouterConfig,
  host: "v1" | "v2",
  opts: { context7?: boolean; shipped?: readonly RoleSpec[] } = {},
): RoleTable {
  if (host !== "v2" || cfg.routing?.delegation !== "roles") return EMPTY_TABLE;
  const shipped = opts.shipped ?? SHIPPED_ROLE_SPECS;
  const order = tierOrder(resolveActiveTiers(cfg));
  const custom = cfg.roleAgents ?? {};
  const agents: Record<string, unknown> = cfg.agents ?? {};
  const roles = new Map<string, RoleSpec>();
  const issues: RolesIssue[] = [];
  const droppedAgents: string[] = [];
  const replacedRoles: string[] = [];
  const names = new Set(shipped.map((s) => s.agent));
  for (const name of Object.keys(custom)) {
    if (!names.has(name)) issues.push({ path: `roleAgents.${name}`, message: `roleAgents.${name} is not a shipped role agent (${[...names].join("|")}); ignored` });
  }
  for (const spec of shipped) {
    const base = `roleAgents.${spec.agent}`;
    const invalid = roleSpecProblems(spec, { shipped: true });
    if (invalid.length > 0) {
      issues.push({ path: base, message: `shipped role ${spec.agent} is invalid (${invalid.join("; ")}); not registered` });
      continue;
    }
    if (Object.hasOwn(agents, spec.agent)) {
      const problem = pluginAgentSeparationProblem(agents[spec.agent], opts.context7 ?? true);
      if (problem !== undefined) {
        droppedAgents.push(spec.agent);
        issues.push({ path: `agents.${spec.agent}`, message: `agents.${spec.agent} ${problem}; dropped in roles mode, the shipped role agent is kept` });
      } else {
        replacedRoles.push(spec.agent);
        issues.push({ path: `agents.${spec.agent}`, message: `agents.${spec.agent} replaces the shipped role agent ${spec.agent} in roles mode` });
        continue;
      }
    }
    const placed = placeRange(spec.tierRange, order);
    if (placed === undefined) {
      issues.push({ path: `${base}.tierRange`, message: `role ${spec.agent}: no tier of preset ${cfg.activePreset} lies inside ${spec.tierRange.floor}..${spec.tierRange.ceiling}; role disabled` });
      continue;
    }
    if (placed.floor !== spec.tierRange.floor || placed.ceiling !== spec.tierRange.ceiling) {
      issues.push({ path: `${base}.tierRange`, message: `role ${spec.agent}: preset ${cfg.activePreset} lacks part of ${spec.tierRange.floor}..${spec.tierRange.ceiling}; using ${placed.floor}..${placed.ceiling}` });
    }
    const narrowed = narrowRoleSpec({ ...spec, tierRange: placed }, Object.hasOwn(custom, spec.agent) ? custom[spec.agent] : undefined, order);
    issues.push(...narrowed.issues);
    if (!narrowed.spec.enabled) continue;
    // Narrowing cannot create a violation; validate anyway (I4).
    const problems = roleSpecProblems(narrowed.spec);
    if (problems.length > 0) {
      issues.push({ path: base, message: `role ${spec.agent} after customisation is invalid (${problems.join("; ")}); not registered` });
      continue;
    }
    roles.set(spec.agent, freezeSpec(narrowed.spec));
  }
  return Object.freeze({
    roles: freezeMap(roles),
    issues: Object.freeze(issues),
    droppedAgents: Object.freeze(droppedAgents),
    replacedRoles: Object.freeze(replacedRoles),
  });
}

/** Resolves the role table for a host. Empty on v1 and in `tiers` mode. */
export function resolveRoles(cfg: RouterConfig, host: "v1" | "v2"): ReadonlyMap<string, RoleSpec> {
  return resolveRoleTable(cfg, host).roles;
}
