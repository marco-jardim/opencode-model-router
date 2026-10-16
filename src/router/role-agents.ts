/**
 * Role agent registration on OpenCode v2 (issue #84, plan P2.1 T2.1.1).
 *
 * In roles mode (`routing.delegation: "roles"`, v2 only) the router registers every enabled role
 * of the role table as a router-defined agent with the role's MAX policy: deny-by-default, only
 * the role's actions under their host names, `execute`/`subagent`/`task`/`delegate`/`shell`
 * denied explicitly, the read-only tiers' sensitive-read asks, and `external_directory` allowed
 * only for the repository's worktree roots (listed at registration), configured work roots and
 * the trusted executor slots root, with the executor home denied after every allow.
 * The definitions carry the plugin-agent marker, so the v2 adapter publishes them like
 * #81 plugin agents (inherited denies only) and `protectedAgent()` holds for each of them (P-19):
 * the router's evaluate and context hooks then enforce the policy under a granting parent too.
 *
 * Nothing here runs on v1 or in tiers mode: {@link registerRoleAgents} returns before touching
 * anything (I1/I8). A failure while resolving or building the roles registers no role agent at
 * all (fail closed); tier agents are never touched.
 */
import { lstatSync, realpathSync, statSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import { resolveExecutorHome } from "../executor/paths";
import { resolveActiveTiers, resolveRolesRouting, resolveRouting, slotsDirProblem, type RouterConfig, type TierConfig } from "./config";
import { GIT_TOOL_NAMES, gitEnvironment, gitExecutable, hardeningArgs, inheritedSafeDirectoryArgs, spawnBounded, workRootGuards } from "./git-tools";
import { positiveBudget, REFUSAL_CAP, ROUTE_BUDGET_RAISE_MAX, TIER_GUARD_BUDGET } from "./guard-profile";
import { PLUGIN_AGENT, pluginAgentMarker, pluginAgentPolicy, type PluginAgentMarker } from "./plugin-agents";
import { CONTEXT7_DOC_TOOLS, permissionMatches, type PermissionMap } from "./read-only";
import { isApprovalValid, type RepoApproval } from "../routing/roles/approvals";
import { ACTION_CLASS, HOST_NATIVE_ROLE_NAMES, resolveRoleTable, SHIPPED_ROLE_SPECS, type AuthorityAction, type RoleSpec, type RoleTable } from "./roles";
import { workRootGlobIndex, workRootProblem } from "./roles-config";
import { locationOutsideWorkRoots } from "./work-roots";

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
 * charge, plus {@link ROLE_STEPS_MARGIN}. QA-G-A3-6: the top budget is never below
 * {@link TIER_GUARD_BUDGET}, the budget a tier the role has no budget for can get
 * (`roleGuardProfile`'s fallback), so the guard still stops before the host's step limit.
 */
export function roleAgentSteps(spec: Pick<RoleSpec, "budget">): number {
  const budgets = Object.values(spec.budget).map((n) => positiveBudget(n) ?? TIER_GUARD_BUDGET);
  const top = Math.max(budgets.length > 0 ? Math.max(...budgets) : TIER_GUARD_BUDGET, TIER_GUARD_BUDGET);
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
 * (local roles only; a bare `*` is never written), then `externalDirectoryDeny` after every allow
 * and the {@link ROLE_DENIED_ACTIONS} denies;
 * the `read` rules are rebuilt by the plugin-agent policy with the sensitive-read asks after the
 * grant (a role without `read` gets `read: { "*": "deny" }`).
 */
export function roleMaxPermission(
  spec: Pick<RoleSpec, "authority">,
  opts: { context7: boolean; externalDirectory: readonly string[]; externalDirectoryDeny?: readonly string[] },
): PermissionMap {
  const own: PermissionMap = { "*": "deny" };
  for (const name of roleHostActions(spec, opts)) own[name] = "allow";
  const patterns = roleHasLocalActions(spec)
    ? [...new Set(opts.externalDirectory)].filter((pattern) => pattern !== "" && !/^[*?]+$/.test(pattern))
    : [];
  const denied = [...new Set(opts.externalDirectoryDeny ?? [])].filter((pattern) => pattern !== "");
  if (patterns.length > 0 || denied.length > 0) {
    // Drop overlapping keys from the allows too: updating a key would retain its earlier insertion order.
    own.external_directory = Object.fromEntries([
      ...patterns.filter((pattern) => !denied.includes(pattern)).map((pattern) => [pattern, "allow" as const]),
      ...denied.map((pattern) => [pattern, "deny" as const]),
    ]);
  }
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
  opts: { context7: boolean; externalDirectory: readonly string[]; externalDirectoryDeny?: readonly string[] },
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
 * prints them (hardened git: no hooks, no fsmonitor, no global/system config). The user's
 * system/global `safe.directory` values are passed back as `-c safe.directory=…` pairs
 * (QA-G-A2-2-1), so a repository trusted that way is not refused as "dubious ownership". Throws
 * when git fails, so the caller registers no worktree rule.
 */
export async function listWorktrees(directory: string): Promise<string[]> {
  const started = performance.now();
  // QA-62F-4: the executable is chosen outside the listed directory's work root, like the executor-home lookup.
  const executable = gitExecutable(workRootGuards(directory));
  const trusted = await inheritedSafeDirectoryArgs(executable, WORKTREE_LIST_TIMEOUT_MS);
  const result = await spawnBounded(executable, [...hardeningArgs(), ...trusted, "worktree", "list", "--porcelain"], directory, {
    env: gitEnvironment(), timeoutMs: Math.max(1, WORKTREE_LIST_TIMEOUT_MS - (performance.now() - started)), maxBytes: 1024 * 1024,
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
 * The `external_directory` allow pattern of one approved repository (cross-repo Phase 4, SD-P4-15):
 * `<path><sep>*` built like {@link worktreeRootPattern}, but only when the stored path still is its
 * own canonical long form (`realpathSync.native(path)` equals `path` as text, case-insensitive on
 * win32: a moved, replaced or junctioned folder gets no pattern) and both forms pass the P1.1 rules
 * ({@link workRootProblem}). Undefined, with the reason, otherwise: fail closed. No git.
 */
export function approvedRootPattern(path: string, realpath: Realpath = nativeRealpath): { pattern?: string; problem?: string } {
  const problem = workRootProblem(path);
  if (problem !== undefined) return { problem };
  let canonical: string;
  try {
    canonical = realpath(path);
  } catch {
    return { problem: "does not resolve to a directory" };
  }
  const same = process.platform === "win32" ? canonical.toLowerCase() === path.toLowerCase() : canonical === path;
  if (!same) return { problem: `resolves to ${canonical}, not the approved path` };
  const after = workRootProblem(canonical);
  return after === undefined ? { pattern: join(canonical, "*") } : { problem: `canonical form ${canonical} ${after}` };
}

/** Executor directories may not exist yet; only ENOENT permits using a canonical parent and the literal basename. */
function executorDirectoryRoot(path: string, realpath: Realpath, requireSame = true): { root?: string; problem?: string } {
  const problem = workRootProblem(path);
  if (problem !== undefined) return { problem };
  if (workRootGlobIndex(path) !== -1) return { problem: "must be a literal directory, not a glob" };
  let canonical: string;
  try {
    canonical = realpath(path);
    const same = process.platform === "win32" ? canonical.toLowerCase() === path.toLowerCase() : canonical === path;
    if (requireSame && !same) return { problem: `resolves to ${canonical}, not the configured path` };
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      return { problem: "does not resolve to a directory" };
    }
    const api = /^[A-Za-z]:[\\/]/.test(path) ? win32 : posix;
    try {
      canonical = api.join(realpath(api.dirname(path)), api.basename(path));
    } catch {
      return { problem: "parent does not resolve to a directory" };
    }
  }
  const after = workRootProblem(canonical);
  if (after !== undefined) return { problem: `canonical form ${canonical} ${after}` };
  if (workRootGlobIndex(canonical) !== -1) return { problem: "canonical directory contains a glob character" };
  return { root: canonical };
}

/** D6: reject overlap with non-slot worktrees, but existing executor worktrees must not block future slots. */
function executorSlotsRootPattern(path: string, worktrees: readonly string[], realpath: Realpath): { pattern?: string; problem?: string } {
  const problem = slotsDirProblem(path);
  if (problem !== undefined) return { problem };
  const canonical = executorDirectoryRoot(path, realpath);
  if (canonical.root === undefined) return { problem: canonical.problem };
  const after = slotsDirProblem(canonical.root);
  if (after !== undefined) return { problem: `canonical form ${canonical.root} ${after}` };
  for (const [index, worktree] of worktrees.entries()) {
    let root: string;
    try {
      root = realpath(worktree);
    } catch {
      // Git can retain deleted (even locked) linked worktrees. Only a missing entry is harmless;
      // an existing path without a canonical form, and the main checkout, must still fail closed.
      if (index > 0) {
        try {
          lstatSync(worktree);
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
        }
      }
      return { problem: `worktree ${worktree} has no canonical long form` };
    }
    // Executor worktrees live at <root>/<plan>/slot-N, integration or ci.
    // Never exempt the first (main) checkout, or ordinary non-slot descendants.
    const relative = dirKey(root).slice(dirKey(canonical.root).length + 1);
    if (index > 0 && isOrContains(canonical.root, root) && /^[^/]+\/(?:slot-[1-9]\d{0,2}|integration|ci)$/.test(relative)) continue;
    if ([path, canonical.root].some((slots) => [worktree, root].some((tree) => isOrContains(slots, tree) || isOrContains(tree, slots)))) {
      return { problem: `is inside or an ancestor of worktree ${worktree}` };
    }
  }
  return { pattern: join(canonical.root, "*") };
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
  const globAt = workRootGlobIndex(entry);
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
  parents: readonly string[] = [],
  approved: readonly string[] = [],
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
  // P1.6: one `<parent><sep>*` per `routing.repoParents` entry; the host's `*` crosses separators, so it covers every depth.
  const parentDirs: string[] = [...parents];
  for (const parent of parents) {
    const result = workRootPattern(`${parent.replace(/[\\/]+$/, "")}/*`, realpath);
    if (result.pattern === undefined) problems.push(`routing.repoParents entry ${parent} ${result.problem ?? "is not usable"}; not granted`);
    else {
      add(result.pattern);
      parentDirs.push(result.pattern.replace(/[\\/]?\*$/, ""));
    }
  }
  // Cross-repo Phase 4 (SD-P4-15): one `<path><sep>*` per approved repository, only with parents (I9); the caller passes
  // approvals already checked for expiry and exclusion ({@link approvedRootsInForce}). Phase 4 QA (m3): never one that is or
  // contains a parent (text or canonical form): its rule would be wider than the parents, and admission refuses it anyway.
  if (parents.length > 0) {
    for (const path of approved) {
      const result = approvedRootPattern(path, realpath);
      if (result.pattern === undefined) {
        problems.push(`approved repository ${path} ${result.problem ?? "is not usable"}; not granted`);
        continue;
      }
      const approvedDir = result.pattern.replace(/[\\/]?\*$/, "");
      const held = parentDirs.find((dir) => dir.trim() !== "" && (isOrContains(path, dir) || isOrContains(approvedDir, dir)));
      if (held !== undefined) problems.push(`approved repository ${path} is or contains routing.repoParents entry ${held}; not granted`);
      else add(result.pattern);
    }
  }
  return { patterns, problems };
}

/** Comparison form of a directory for the parent checks: `/` separators, no trailing one, case-folded on win32. Text only. */
function dirKey(p: string): string {
  const unified = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? unified.toLowerCase() : unified;
}

/** Whether directory `outer` is directory `inner` or contains it ({@link dirKey} forms; a filesystem root contains all). */
function isOrContains(outer: string, inner: string): boolean {
  const o = dirKey(outer);
  const i = dirKey(inner);
  return o === "" || o === i || i.startsWith(`${o}/`);
}

/** One store entry as registration sees it (cross-repo Phase 4): read without git. */
export type ApprovedRoot = Pick<RepoApproval, "path" | "approvedAt" | "lastUsedAt">;

/**
 * The approved repository paths registration may grant (SD-P4-15): none without `routing.repoParents` (I9); otherwise each
 * approval that has not expired ({@link isApprovalValid} with `routing.repoApprovalDays`) and whose path text no
 * `routing.repoExclude` glob matches (exclusion wins over an approval) and that is not, and does not contain, a
 * `routing.repoParents` entry (Phase 4 QA m3: text, case-insensitive on win32; such an approval would be granted wider than
 * the parents). Excluded and parent-holding ones are reported in `problems`; expired ones are dropped silently. No filesystem
 * access, no git.
 */
export function approvedRootsInForce(
  approved: readonly ApprovedRoot[],
  routing: { readonly repoParents: readonly string[]; readonly repoExclude: readonly string[]; readonly repoApprovalDays: number },
  now: number,
): { paths: string[]; problems: string[] } {
  const paths: string[] = [];
  const problems: string[] = [];
  if (routing.repoParents.length === 0) return { paths, problems };
  for (const entry of approved) {
    if (typeof entry.path !== "string" || entry.path === "") continue;
    if (!isApprovalValid(entry, routing.repoApprovalDays, now)) continue;
    const held = routing.repoParents.find((parent) => parent.trim() !== "" && isOrContains(entry.path, parent));
    if (held !== undefined) {
      problems.push(`approved repository ${entry.path} is or contains routing.repoParents entry ${held}; not granted`);
      continue;
    }
    const forms = process.platform === "win32" && entry.path.includes("/") ? [entry.path, entry.path.replace(/\//g, "\\")] : [entry.path];
    const excluded = routing.repoExclude.find((glob) => glob.trim() !== "" && forms.some((form) => permissionMatches(form, glob)));
    if (excluded !== undefined) problems.push(`approved repository ${entry.path} is excluded by routing.repoExclude (${excluded}); not granted`);
    else if (!paths.includes(entry.path)) paths.push(entry.path);
  }
  return { paths, problems };
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
  /** `external_directory` deny patterns written after every allow. */
  readonly externalDirectoryDenied: readonly string[];
  /** True when registration failed and no role agent was registered. */
  readonly failed: boolean;
}

const NONE: RoleRegistration = Object.freeze({
  registered: Object.freeze([]), removed: Object.freeze([]), replaced: Object.freeze([]), externalDirectory: Object.freeze([]),
  externalDirectoryDenied: Object.freeze([]), failed: false,
});

export interface RoleRegistrationOptions {
  /** The context7 MCP server is configured (its documentation tools become direct tools). */
  context7: boolean;
  /**
   * The project directory: its repository's worktrees are listed. When `routing.workRoots` is set and the directory lies
   * outside every entry (`locationOutsideWorkRoots`), the executor slots root is not granted (QA-5.1-5) and the
   * executor-home lookup runs only when worktrees were listed, to deny the home their allows cover (QA-62F-1).
   */
  directory: string;
  /** The host's own agents at setup (name → seed definition); a removed #81 entry falls back to it. */
  seed: Readonly<Record<string, Record<string, unknown>>>;
  /** Logs `message` once per `key`. */
  warn: (key: string, message: string) => void;
  /**
   * Cross-repo Phase 4 (SD-P4-15): the entries of the repository approvals store, read without git. Each one in force
   * ({@link approvedRootsInForce}) whose path is still its own canonical form gets a `<path><sep>*` rule. Absent: none.
   */
  approvedRoots?: readonly ApprovedRoot[];
  /** Injection points (tests). */
  listWorktrees?: (directory: string) => Promise<string[]>;
  resolveTable?: (cfg: RouterConfig, host: "v1" | "v2", opts: { context7?: boolean }) => RoleTable;
  realpath?: Realpath;
  /** Replaces the executor-home lookup; its result is still canonicalized before granting slots access. */
  executorHome?: (directory: string) => Promise<string>;
  /**
   * G-16: false when the plan executor cannot run on this platform (the caller asks `executorPlatformSupported`): the
   * executor is treated as disabled, so no executor-home lookup runs and no slots root is granted. Absent: true.
   */
  executorPlatform?: boolean;
  /** Clock in epoch ms for the approval expiry; default `Date.now`. */
  now?: () => number;
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
  // QA-P21-1-9: tiers mode returns before anything is resolved, so no resolution error can touch the agent map (I1).
  if (cfg.routing?.delegation !== "roles") return NONE;
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
  let externalDirectoryDenied: string[] = [];
  try {
    table = (opts.resolveTable ?? resolveRoleTable)(cfg, "v2", { context7: opts.context7 });
    const tiers = resolveActiveTiers(cfg);
    const hasLocalActions = [...table.roles.values()].some(roleHasLocalActions);
    let worktrees: string[] = [];
    let worktreeListingProblem: string | undefined;
    // G-12: the worktrees are listed whatever `routing.workRoots` contains (a glob for later-created worktrees must not
    // drop the existing ones). Outside every configured work root the executor home is still denied when worktrees were
    // listed or the listing failed (QA-62F-1, QA-62F-9); only the executor slots-root grant is skipped there.
    const outside = locationOutsideWorkRoots(opts.directory, routing.workRoots, process.platform, opts.realpath ?? nativeRealpath);
    if (hasLocalActions) {
      try {
        worktrees = await (opts.listWorktrees ?? listWorktrees)(opts.directory);
      } catch (error) {
        worktreeListingProblem = errorText(error);
        opts.warn("roles:worktrees", `${PREFIX}the repository's worktrees could not be listed (${errorText(error)}); role agents get no worktree external_directory rule`);
      }
    }
    const approved = approvedRootsInForce(opts.approvedRoots ?? [], routing, (opts.now ?? Date.now)());
    const found = externalDirectoryPatterns(worktrees, routing.workRoots, opts.realpath ?? nativeRealpath, routing.repoParents, approved.paths);
    for (const problem of [...approved.problems, ...found.problems]) opts.warn(`roles:external:${problem}`, `${PREFIX}${problem}`);
    externalDirectory = found.patterns;
    // slotsDir is trusted here: the project-controlled value was stripped before the config merge (D18).
    const executorRouting = resolveRouting(cfg, "v2");
    const slotsDir = executorRouting.executor.slotsDir;
    const executorEnabled = opts.executorPlatform !== false
      && executorRouting.leases.mode === "enforce" && cfg.enforcement?.verify?.require !== "never";
    const executorProblems: Array<readonly [key: string, message: string]> = [];
    // QA-62F-1, QA-62F-9: outside every work root, listed worktrees or configured roots can still cover the executor
    // home in the git common directory, even when listing failed. Resolve the home (one read-only, guarded rev-parse)
    // and deny it there; the slots-root grant below stays inside the work roots only.
    if (executorEnabled && table.roles.size > 0 && (!outside || worktrees.length > 0 || worktreeListingProblem !== undefined)) {
      const realpath = opts.realpath ?? nativeRealpath;
      const homeDirectory = worktrees[0] ?? opts.directory;
      let home: string | undefined;
      try {
        const resolved = await (opts.executorHome ?? resolveExecutorHome)(homeDirectory);
        const canonical = executorDirectoryRoot(resolved, realpath, false);
        if (canonical.root === undefined) throw new Error(canonical.problem ?? "has no canonical long form");
        home = canonical.root;
        externalDirectoryDenied = [join(home, "*")];
      } catch (error) {
        const problem = errorText(error);
        // D7: Git's non-repository diagnostic means there is no executor to grant or protect. Other failures
        // (including other exit-128 errors such as dubious ownership) still fail closed with one warning.
        let notRepository = /(?:^|:\s*)(?:fatal:\s*)?not a git repository\b/i.test(problem);
        if (!notRepository && opts.executorHome === undefined) {
          // A missing/non-directory cwd prevents Git from starting, so it cannot emit its non-repository diagnostic.
          // Only probe native lookups: an injected resolver may model a repository without creating it on disk.
          try {
            notRepository = !statSync(homeDirectory).isDirectory();
          } catch (directoryError) {
            notRepository = directoryError instanceof Error && "code" in directoryError
              && (directoryError.code === "ENOENT" || directoryError.code === "ENOTDIR");
          }
        }
        if (!notRepository) {
          executorProblems.push(["roles:executor-home", `${PREFIX}the executor home could not be resolved (${problem}); the executor home is not denied and role agents get no slots external_directory rule`]);
        }
      }
      // An unresolved home cannot be protected by a final deny: do not grant the slots root either (D6).
      if (!outside && home !== undefined && hasLocalActions && (slotsDir !== null || process.platform === "win32")) {
        // Match create.ts's location toplevel, not Git's first (main) worktree on another drive.
        let toplevel: string | undefined;
        try {
          const directory = realpath(opts.directory);
          for (const worktree of worktrees) {
            try {
              const tree = realpath(worktree);
              if (isOrContains(tree, directory) && tree.length > (toplevel?.length ?? 0)) toplevel = tree;
            } catch { /* Unresolved entries cannot select a drive; the slots overlap check still fails closed. */ }
          }
        } catch { /* A missing canonical location cannot select a default drive. */ }
        const drive = /^([A-Za-z]):[\\/]/.exec(toplevel ?? "");
        const root = slotsDir ?? (drive === null ? undefined : `${drive[1]}:\\.omr-slots`);
        const slots = worktreeListingProblem !== undefined
          ? { problem: `the worktree listing failed (${worktreeListingProblem})` }
          : root === undefined
          ? { problem: "the repository toplevel is not on a drive-letter path" }
          : executorSlotsRootPattern(root, worktrees, realpath);
        if (slots.pattern === undefined) {
          executorProblems.push(["roles:executor-slots", `${PREFIX}executor slots root ${root ?? "(default)"} ${slots.problem ?? "is not usable"}; not granted`]);
        } else if (!externalDirectory.includes(slots.pattern)) {
          externalDirectory.push(slots.pattern);
        }
      }
    }
    built = new Map();
    for (const [name, spec] of table.roles) {
      const floor = tiers[spec.tierRange.floor];
      if (floor === undefined) throw new Error(`role ${name}: floor tier ${spec.tierRange.floor} is not in the active preset`);
      built.set(name, buildRoleAgentDefinition(spec, floor, { context7: opts.context7, externalDirectory, externalDirectoryDeny: externalDirectoryDenied }));
    }
    // Registration failure already emits its single notice; executor warnings apply only to registered definitions.
    for (const [key, message] of executorProblems) opts.warn(key, message);
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
    externalDirectoryDenied: Object.freeze([...externalDirectoryDenied]),
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
