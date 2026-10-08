/**
 * Role agent registration on OpenCode v2 (issue #84, plan P2.1 T2.1.1).
 *
 * In roles mode (`routing.delegation: "roles"`, v2 only) the router registers every enabled role
 * of the role table as a router-defined agent with the role's MAX policy: deny-by-default, only
 * the role's actions under their host names, `execute`/`subagent`/`task`/`delegate`/`shell`
 * denied explicitly, the read-only tiers' sensitive-read asks, and `external_directory` allowed
 * only for the repository's worktree roots (listed at registration) and the `routing.workRoots`
 * patterns. The definitions carry the plugin-agent marker, so the v2 adapter publishes them like
 * #81 plugin agents (inherited denies only) and `protectedAgent()` holds for each of them (P-19):
 * the router's evaluate and context hooks then enforce the policy under a granting parent too.
 *
 * Nothing here runs on v1 or in tiers mode: {@link registerRoleAgents} returns before touching
 * anything (I1/I8). A failure while resolving or building the roles registers no role agent at
 * all (fail closed); tier agents are never touched.
 */
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { resolveActiveTiers, resolveRolesRouting, type RouterConfig, type TierConfig } from "./config";
import { GIT_TOOL_NAMES, gitEnvironment, gitExecutable, hardeningArgs, spawnBounded } from "./git-tools";
import { positiveBudget, REFUSAL_CAP, ROUTE_BUDGET_RAISE_MAX, TIER_GUARD_BUDGET } from "./guard-profile";
import { PLUGIN_AGENT, pluginAgentMarker, pluginAgentPolicy, type PluginAgentMarker } from "./plugin-agents";
import { CONTEXT7_DOC_TOOLS, type PermissionMap } from "./read-only";
import { ACTION_CLASS, HOST_NATIVE_ROLE_NAMES, resolveRoleTable, SHIPPED_ROLE_SPECS, type AuthorityAction, type RoleSpec, type RoleTable } from "./roles";
import { workRootProblem } from "./roles-config";

/**
 * Steps above the largest guard budget a role dispatch can reach. The guard's `NEED MORE: budget`
 * must fire before the host's step limit (P-4): a limit of N leaves N-1 tool-capable steps, one
 * step is the final text-only answer after the budget stop, and three are headroom.
 */
export const ROLE_STEPS_MARGIN = 5;

/** Host actions no role agent is ever granted, listed as explicit denies (R6/P-6, §2.2). */
export const ROLE_DENIED_ACTIONS: readonly string[] = Object.freeze(["execute", "subagent", "task", "delegate", "shell"]);

/** Host-native agent names dispatched in roles mode under a role agent's name (P-7, spike S9). */
export const ROLE_AGENT_ALIASES: Readonly<Record<string, string>> = Object.freeze({ explore: "explorer" });

/**
 * The host `steps` limit of a role agent: the largest guard budget any dispatch of the role can
 * get (the role's top tier budget raised by a route-line `budget=` up to
 * {@link ROUTE_BUDGET_RAISE_MAX}×), plus {@link REFUSAL_CAP} refused calls the guard does not
 * charge, plus {@link ROLE_STEPS_MARGIN}.
 */
export function roleAgentSteps(spec: Pick<RoleSpec, "budget">): number {
  const budgets = Object.values(spec.budget).map((n) => positiveBudget(n) ?? TIER_GUARD_BUDGET);
  const top = budgets.length > 0 ? Math.max(...budgets) : TIER_GUARD_BUDGET;
  return ROUTE_BUDGET_RAISE_MAX * top + REFUSAL_CAP + ROLE_STEPS_MARGIN;
}

/** Host action (tool) names one role action stands for; `execute` stands for none. */
function hostNames(action: AuthorityAction, context7: boolean): readonly string[] {
  switch (action) {
    case "router_git": return GIT_TOOL_NAMES;
    case "context7": return context7 ? CONTEXT7_DOC_TOOLS : [];
    case "execute": return [];
    default: return [action];
  }
}

/**
 * The host action names a role's max policy allows, in the role's order: `read`, `glob`, `grep`,
 * `edit`, `webfetch`, `websearch` and `router_run` as named, `router_git` as every
 * `router_git_*` tool (P-12), `context7` as the documentation tools only when the context7 MCP
 * server is configured, `execute` never.
 */
export function roleHostActions(spec: Pick<RoleSpec, "authority">, opts: { context7: boolean }): string[] {
  const out: string[] = [];
  for (const action of spec.authority.allow) {
    for (const name of hostNames(action, opts.context7)) if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** True when a role has an action of the local class, the only class `external_directory` belongs to (§2.2). */
export function roleHasLocalActions(spec: Pick<RoleSpec, "authority">): boolean {
  return spec.authority.allow.some((action) => ACTION_CLASS[action] === "local");
}

/**
 * A role's max permission policy (v2 action names, ordered, last match wins): `* deny` first,
 * then an allow per {@link roleHostActions}, then `external_directory` allows for `externalDirectory`
 * (local roles only; a bare `*` is never written), then the {@link ROLE_DENIED_ACTIONS} denies;
 * the `read` rules are rebuilt by the plugin-agent policy with the sensitive-read asks after the
 * grant (a role without `read` gets `read: { "*": "deny" }`).
 */
export function roleMaxPermission(
  spec: Pick<RoleSpec, "authority">,
  opts: { context7: boolean; externalDirectory: readonly string[] },
): PermissionMap {
  const own: PermissionMap = { "*": "deny" };
  for (const name of roleHostActions(spec, opts)) own[name] = "allow";
  const patterns = roleHasLocalActions(spec)
    ? [...new Set(opts.externalDirectory)].filter((pattern) => pattern !== "" && !/^[*?]+$/.test(pattern))
    : [];
  if (patterns.length > 0) own.external_directory = Object.fromEntries(patterns.map((pattern) => [pattern, "allow" as const]));
  for (const action of ROLE_DENIED_ACTIONS) own[action] = "deny";
  return pluginAgentPolicy({ permission: own }, { context7: opts.context7, host: "v2" }).permission;
}

/** The plugin-agent marker of a role agent definition: `role` names the role. */
export interface RoleAgentMarker extends PluginAgentMarker {
  role: string;
}

/** The role a definition was registered for, or undefined (tier agents, #81 plugin agents, host agents). */
export function roleAgentOf(definition: unknown): string | undefined {
  const marker = pluginAgentMarker(definition) as Partial<RoleAgentMarker> | undefined;
  return typeof marker?.role === "string" ? marker.role : undefined;
}

function validModel(model: unknown): model is string {
  return typeof model === "string" && model.indexOf("/") >= 1;
}

/**
 * The host `agent.<name>` definition of a role agent (the v1 config shape the v2 adapter
 * translates): the floor tier's model and variant as registered fallback (P-1, spike S1: a
 * model-less child would inherit the parent's model), the role prompt verbatim, the role's max
 * policy, `steps` per {@link roleAgentSteps}, mode `subagent`, and the plugin-agent marker.
 */
export function buildRoleAgentDefinition(
  spec: RoleSpec,
  floor: Pick<TierConfig, "model" | "variant">,
  opts: { context7: boolean; externalDirectory: readonly string[] },
): Record<string, unknown> {
  if (!validModel(floor.model)) throw new Error(`role ${spec.agent}: floor tier ${spec.tierRange.floor} has no provider/model reference`);
  const steps = roleAgentSteps(spec);
  const definition: Record<string, unknown> = {
    model: floor.model,
    mode: "subagent",
    description: spec.description,
    prompt: spec.prompt,
    steps,
    maxSteps: steps,
    ...(floor.variant ? { variant: floor.variant } : {}),
    permission: roleMaxPermission(spec, opts),
  };
  const marker: RoleAgentMarker = { tier: spec.tierRange.floor, readOnly: !spec.authority.allow.includes("edit"), role: spec.agent };
  Object.defineProperty(definition, PLUGIN_AGENT, { value: marker, enumerable: false, configurable: true });
  return definition;
}

// ---------------------------------------------------------------------------
// external_directory: worktree roots and routing.workRoots (§2.2, R4, P-11, spike S11)
// ---------------------------------------------------------------------------

/** Worktree paths of `git worktree list --porcelain` output; bare entries carry no working tree. */
export function parseWorktreeList(stdout: string): string[] {
  const out: string[] = [];
  for (const block of stdout.replace(/\r\n/g, "\n").split(/\n\s*\n/)) {
    const lines = block.split("\n");
    const head = lines.find((line) => line.startsWith("worktree "));
    if (head === undefined || lines.includes("bare")) continue;
    const path = head.slice("worktree ".length);
    if (path !== "" && !out.includes(path)) out.push(path);
  }
  return out;
}

const WORKTREE_LIST_TIMEOUT_MS = 10_000;

/**
 * The worktree paths of the repository `directory` belongs to, as `git worktree list --porcelain`
 * prints them (hardened git: no hooks, no fsmonitor, no global/system config). Throws when git
 * fails, so the caller registers no worktree rule.
 */
export async function listWorktrees(directory: string): Promise<string[]> {
  const result = await spawnBounded(gitExecutable(), [...hardeningArgs(), "worktree", "list", "--porcelain"], directory, {
    env: gitEnvironment(), timeoutMs: WORKTREE_LIST_TIMEOUT_MS, maxBytes: 1024 * 1024,
  });
  if (result.code !== 0 || result.truncated) {
    throw new Error(`git worktree list failed (exit ${String(result.code)}${result.truncated ? ", output truncated" : ""}): ${result.stderr.toString("utf8").trim()}`);
  }
  return parseWorktreeList(result.output.toString("utf8"));
}

type Realpath = (path: string) => string;
const nativeRealpath: Realpath = (path) => realpathSync.native(path);

function sep(): string {
  return process.platform === "win32" ? "\\" : "/";
}

/**
 * The `external_directory` allow pattern of one existing worktree root: its canonical long form
 * (`realpathSync.native`) followed by `<sep>*`, the shape spike S11 proved; undefined when the
 * root does not resolve or its canonical form still fails the P1.1 rules (an 8.3 component, …).
 */
export function worktreeRootPattern(root: string, realpath: Realpath = nativeRealpath): string | undefined {
  let canonical: string;
  try {
    canonical = realpath(root);
  } catch {
    return undefined;
  }
  return workRootProblem(canonical) === undefined ? join(canonical, "*") : undefined;
}

/**
 * The `external_directory` allow pattern of one `routing.workRoots` entry (P-11): the static
 * directory before the first wildcard in its canonical long form, then the glob tail verbatim
 * (`D:/git/omr-rta-*` → `D:\git\omr-rta-*`); an entry without a wildcard is a root (`<root>\*`).
 * Undefined, with the reason, when the entry or its canonical form fails the P1.1 rules or the
 * static directory does not exist: fail closed, never a wider pattern.
 */
export function workRootPattern(entry: string, realpath: Realpath = nativeRealpath): { pattern?: string; problem?: string } {
  const problem = workRootProblem(entry);
  if (problem !== undefined) return { problem };
  const globAt = entry.search(/[*?[\]{}]/);
  if (globAt === -1) {
    const pattern = worktreeRootPattern(entry, realpath);
    return pattern === undefined ? { problem: "does not resolve to a directory in canonical long form" } : { pattern };
  }
  const prefix = entry.slice(0, globAt);
  const cut = Math.max(prefix.lastIndexOf("/"), prefix.lastIndexOf("\\"));
  const directory = prefix.slice(0, cut + 1);
  const tail = entry.slice(cut + 1);
  let canonical: string;
  try {
    canonical = realpath(directory);
  } catch {
    return { problem: `static directory ${directory} does not exist` };
  }
  const pattern = /[\\/]$/.test(canonical) ? canonical + tail : canonical + sep() + tail;
  const after = workRootProblem(pattern);
  return after === undefined ? { pattern } : { problem: `canonical form ${pattern} ${after}` };
}

/**
 * Every `external_directory` allow pattern of the role max policies: the worktree roots listed at
 * registration, then the `routing.workRoots` patterns; duplicates dropped, a bare `*` never.
 */
export function externalDirectoryPatterns(
  worktrees: readonly string[],
  workRoots: readonly string[],
  realpath: Realpath = nativeRealpath,
): { patterns: string[]; problems: string[] } {
  const patterns: string[] = [];
  const problems: string[] = [];
  const add = (pattern: string) => {
    if (!/^[*?]+$/.test(pattern) && !patterns.includes(pattern)) patterns.push(pattern);
  };
  for (const root of worktrees) {
    const pattern = worktreeRootPattern(root, realpath);
    if (pattern === undefined) problems.push(`worktree ${root} has no canonical long form; not granted`);
    else add(pattern);
  }
  for (const entry of workRoots) {
    const result = workRootPattern(entry, realpath);
    if (result.pattern === undefined) problems.push(`routing.workRoots entry ${entry} ${result.problem ?? "is not usable"}; not granted`);
    else add(result.pattern);
  }
  return { patterns, problems };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export interface RoleRegistration {
  /** Role agents written into the agent map. */
  readonly registered: readonly string[];
  /** #81 agents with a role name removed (dropped by the table, or every one on failure). */
  readonly removed: readonly string[];
  /** #81 agents with a role name kept in place of the shipped role. */
  readonly replaced: readonly string[];
  /** `external_directory` allow patterns written into local roles. */
  readonly externalDirectory: readonly string[];
  /** True when registration failed and no role agent was registered. */
  readonly failed: boolean;
}

const NONE: RoleRegistration = Object.freeze({
  registered: Object.freeze([]), removed: Object.freeze([]), replaced: Object.freeze([]), externalDirectory: Object.freeze([]), failed: false,
});

export interface RoleRegistrationOptions {
  /** The context7 MCP server is configured (its documentation tools become direct tools). */
  context7: boolean;
  /** The project directory: its repository's worktrees are listed. */
  directory: string;
  /** The host's own agents at setup (name → seed definition); a removed #81 entry falls back to it. */
  seed: Readonly<Record<string, Record<string, unknown>>>;
  /** Logs `message` once per `key`. */
  warn: (key: string, message: string) => void;
  /** Injection points (tests). */
  listWorktrees?: (directory: string) => Promise<string[]>;
  resolveTable?: (cfg: RouterConfig, host: "v1" | "v2", opts: { context7?: boolean }) => RoleTable;
  realpath?: Realpath;
}

const PREFIX = "roles mode (OpenCode v2 only): ";

/** Removes a router-built agent: the host seed comes back when the name is a host agent. */
function remove(agents: Record<string, Record<string, unknown>>, name: string, seed: RoleRegistrationOptions["seed"]): void {
  if (Object.hasOwn(seed, name)) agents[name] = JSON.parse(JSON.stringify(seed[name])) as Record<string, unknown>;
  else delete agents[name];
}

/**
 * Registers the role agents into `agents` (the v1-shaped `agent` map the v2 adapter's agent
 * transform publishes). v2 only, and only when `routing.delegation` is `roles`; otherwise returns
 * at once without reading anything else (I1). Uses the role table with the real context7 flag:
 * every enabled role is written under its name (a host-native one such as `general` is replaced,
 * {@link HOST_NATIVE_ROLE_NAMES}); a #81 agent the table drops is removed (overwritten by the
 * role); one that replaces a role is left as built. All-or-nothing: when resolution or a
 * definition throws, no role agent is registered, every #81 agent with a role name is removed
 * (its separation cannot be checked) and one notice is logged; tier agents are untouched.
 */
export async function registerRoleAgents(
  agents: Record<string, Record<string, unknown>>,
  cfg: RouterConfig,
  opts: RoleRegistrationOptions,
): Promise<RoleRegistration> {
  let routing: ReturnType<typeof resolveRolesRouting>;
  try {
    routing = resolveRolesRouting(cfg, "v2");
  } catch (error) {
    return fail(agents, opts, error);
  }
  if (routing.delegation !== "roles") return NONE;
  let built: Map<string, Record<string, unknown>>;
  let table: RoleTable;
  let externalDirectory: string[] = [];
  try {
    table = (opts.resolveTable ?? resolveRoleTable)(cfg, "v2", { context7: opts.context7 });
    const tiers = resolveActiveTiers(cfg);
    let worktrees: string[] = [];
    if ([...table.roles.values()].some(roleHasLocalActions)) {
      try {
        worktrees = await (opts.listWorktrees ?? listWorktrees)(opts.directory);
      } catch (error) {
        opts.warn("roles:worktrees", `${PREFIX}the repository's worktrees could not be listed (${errorText(error)}); role agents get no worktree external_directory rule`);
      }
    }
    const found = externalDirectoryPatterns(worktrees, routing.workRoots, opts.realpath ?? nativeRealpath);
    for (const problem of found.problems) opts.warn(`roles:external:${problem}`, `${PREFIX}${problem}`);
    externalDirectory = found.patterns;
    built = new Map();
    for (const [name, spec] of table.roles) {
      const floor = tiers[spec.tierRange.floor];
      if (floor === undefined) throw new Error(`role ${name}: floor tier ${spec.tierRange.floor} is not in the active preset`);
      built.set(name, buildRoleAgentDefinition(spec, floor, { context7: opts.context7, externalDirectory }));
    }
  } catch (error) {
    return fail(agents, opts, error);
  }
  const removed: string[] = [];
  for (const name of table.droppedAgents) {
    if (built.has(name)) continue; // overwritten below
    if (pluginAgentMarker(agents[name]) !== undefined) {
      remove(agents, name, opts.seed);
      removed.push(name);
    }
  }
  for (const [name, definition] of built) {
    if (table.droppedAgents.includes(name)) removed.push(name);
    if (Object.hasOwn(opts.seed, name) && !HOST_NATIVE_ROLE_NAMES.includes(name)) {
      opts.warn(`roles:host-agent:${name}`, `${PREFIX}host agent ${name} is replaced by the router's role agent ${name}`);
    }
    agents[name] = definition;
  }
  return Object.freeze({
    registered: Object.freeze([...built.keys()]),
    removed: Object.freeze(removed),
    replaced: Object.freeze([...table.replacedRoles]),
    externalDirectory: Object.freeze([...externalDirectory]),
    failed: false,
  });
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+\s*/g, " ");
}

function fail(agents: Record<string, Record<string, unknown>>, opts: RoleRegistrationOptions, error: unknown): RoleRegistration {
  const removed: string[] = [];
  for (const spec of SHIPPED_ROLE_SPECS) {
    const name = spec.agent;
    if (pluginAgentMarker(agents[name]) === undefined) continue;
    remove(agents, name, opts.seed);
    removed.push(name);
  }
  opts.warn("roles:registration-failed", `${PREFIX}role agent registration failed (${errorText(error)}); no role agent is registered`);
  return Object.freeze({ ...NONE, removed: Object.freeze(removed), failed: true });
}

/**
 * The role agent a `subagent` call naming `agent` is aliased to (P-7: `explore` → `explorer`), or
 * undefined. Only in roles mode on v2 and only when the target is a registered role agent
 * (`registered(name)`); tiers mode and v1 never alias (I1).
 */
export function roleAgentAlias(agent: unknown, cfg: RouterConfig, registered: (name: string) => boolean): string | undefined {
  if (typeof agent !== "string" || !Object.hasOwn(ROLE_AGENT_ALIASES, agent)) return undefined;
  if (cfg.routing?.delegation !== "roles") return undefined;
  const target = ROLE_AGENT_ALIASES[agent]!;
  return registered(target) ? target : undefined;
}
