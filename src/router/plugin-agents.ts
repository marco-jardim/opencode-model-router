import type { Preset, TierConfig } from "./config";
import {
  evaluatePermission, legacyReadOnlyTools, mergePermissions, permissionMatches, permissionRules, readOnlyPermissions,
  type PermissionEffect, type PermissionMap, type PermissionRule,
} from "./read-only";
import { SENSITIVE_PERMISSION_EXCEPTIONS, SENSITIVE_PERMISSION_GLOBS } from "./sensitive-paths";

/**
 * A subagent defined in the router config (`agents.<name>` in tiers.json or the
 * global override) instead of the host's opencode.json (#81). Its model and
 * variant always follow `tier` in the active preset; its mode is always
 * `subagent`; its permissions are always published by the router.
 */
export interface PluginAgentConfig {
  /** Tier of the active preset whose model/variant the agent runs on. */
  tier: string;
  description: string;
  /** System prompt. Used verbatim (never rewritten for the host vocabulary). */
  prompt?: string;
  /** Turn budget. Defaults to the tier's `steps`. */
  steps?: number;
  /** Reuse the #77 read-only policy (deny-by-default, sensitive-read asks). */
  readOnly?: boolean;
  /** Exact or wildcard actions allowed on top of the policy (MCP tools, webfetch, …). */
  allowTools?: string[];
  /**
   * v1-style permission object, canonical v2 action names (`shell`,
   * `subagent`; `bash`/`task` are accepted aliases). Each action maps to an
   * effect or to an ordered `{ pattern: effect }` object; `{ effect: [patterns] }`
   * is accepted too and normalised to the former.
   */
  permission?: PermissionMap;
}

export interface PluginAgentIssue {
  /** Config key path, e.g. `agents.reviewer.tier`. */
  path: string;
  message: string;
  /** The agent concerned; absent when the whole block is. */
  name?: string;
}

/** The v2 grader's agent id (mirrors `V2_GRADER_AGENT`; a unit test pins the two together). */
export const GRADER_AGENT_NAME = "model-router-grader";

/**
 * Names a plugin agent may never take, besides every tier of the active preset:
 * the router's conventional tiers, the grader, and the host's primary/hidden agents.
 */
export const RESERVED_AGENT_NAMES: readonly string[] = [
  "fast", "medium", "heavy", GRADER_AGENT_NAME, "build", "plan", "title", "summary", "compaction",
];

/**
 * Actions a plugin agent's `allowTools` may never match. Shell, edits, code execution and delegation
 * are what makes an agent read-only or not; `read` carries the sensitive-path asks. They belong in
 * `permission`. `multiedit`/`apply_patch` are edit tools (the v1 host maps legacy edit tools to the
 * `edit` permission); `execute` is Code Mode; `delegate` is the router's delegation tool. On v2 a
 * `permission` key naming an edit tool only narrows it and `edit` decides; a key that allows what
 * `edit` denies gets a config notice ({@link editToolKeyNotices}, QA-G-A2-2 round 2).
 */
export const POLICY_ACTIONS: readonly string[] = [
  "shell", "bash", "edit", "write", "patch", "multiedit", "apply_patch", "execute", "subagent", "task", "delegate", "read",
];

/** The capabilities a read-only agent's own `permission` may never ask for (only deny). */
const HARD_ACTIONS: readonly string[] = POLICY_ACTIONS.filter((action) => action !== "read");

const ENTRY_KEYS = new Set(["tier", "description", "prompt", "steps", "readOnly", "allowTools", "permission"]);
const EFFECTS = new Set<string>(["allow", "deny", "ask"]);
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const UNSAFE_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const ACTION_ALIASES: Readonly<Record<string, string>> = { bash: "shell", task: "subagent" };
const V1_ACTIONS: Readonly<Record<string, string>> = { shell: "bash", subagent: "task" };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isEffect(v: unknown): v is PermissionEffect {
  return typeof v === "string" && EFFECTS.has(v);
}

type Checked<T> = { ok: true; value: T } | { ok: false; issue: PluginAgentIssue };
const fail = <T>(path: string, message: string): Checked<T> => ({ ok: false, issue: { path, message } });

/** Insert `key` last, keeping order meaningful (last match wins on both hosts). */
function putLast<T>(target: Record<string, T>, key: string, value: T): void {
  delete target[key];
  target[key] = value;
}

/**
 * Normalise a `permission` object: aliases resolved to the v2 names, the
 * `{ effect: [patterns] }` form flattened, insertion order preserved.
 */
export function normalizePermission(value: unknown, path: string): Checked<PermissionMap> {
  if (!isPlainObject(value)) return fail(path, "must be an object of action rules");
  const out: PermissionMap = {};
  for (const [rawAction, rule] of Object.entries(value)) {
    const at = `${path}.${rawAction}`;
    if (rawAction === "" || rawAction === "__proto__") return fail(at, "is not a valid action");
    const action = ACTION_ALIASES[rawAction] ?? rawAction;
    let normalized: PermissionEffect | Record<string, PermissionEffect>;
    if (typeof rule === "string") {
      if (!isEffect(rule)) return fail(at, "must be allow, deny or ask");
      normalized = rule;
    } else if (isPlainObject(rule)) {
      const keys = Object.keys(rule);
      const grouped = keys.length > 0 && keys.every((key) => EFFECTS.has(key) && Array.isArray(rule[key]));
      const resources: Record<string, PermissionEffect> = {};
      if (grouped) {
        for (const [effect, patterns] of Object.entries(rule)) {
          for (const pattern of patterns as unknown[]) {
            if (typeof pattern !== "string" || pattern === "" || pattern === "__proto__") return fail(`${at}.${effect}`, "must list non-empty patterns");
            putLast(resources, pattern, effect as PermissionEffect);
          }
        }
      } else {
        for (const [pattern, effect] of Object.entries(rule)) {
          if (pattern === "" || pattern === "__proto__") return fail(at, "has an invalid pattern");
          if (!isEffect(effect)) return fail(`${at}.${pattern}`, "must be allow, deny or ask");
          putLast(resources, pattern, effect);
        }
      }
      if (Object.keys(resources).length === 0) return fail(at, "must not be empty");
      normalized = resources;
    } else {
      return fail(at, "must be allow, deny, ask or an object of patterns");
    }
    const previous = out[action];
    if (isPlainObject(previous) && typeof normalized === "object") {
      const merged = { ...previous };
      for (const [pattern, effect] of Object.entries(normalized)) putLast(merged, pattern, effect);
      putLast<PermissionMap[string]>(out, action, merged);
    } else {
      putLast(out, action, normalized);
    }
  }
  return { ok: true, value: out };
}

/** Validate one `agents.<name>` entry; never throws. */
export function validatePluginAgent(
  name: string,
  entry: unknown,
  ctx: { activePreset: string; tiers: Preset },
): Checked<PluginAgentConfig> {
  const at = `agents.${name}`;
  if (!NAME_PATTERN.test(name) || UNSAFE_NAMES.has(name)) {
    return fail(at, "invalid agent name (letters, digits, '.', '_' and '-', at most 64 characters, starting with a letter or digit)");
  }
  if (RESERVED_AGENT_NAMES.includes(name) || Object.hasOwn(ctx.tiers, name)) {
    return fail(at, `'${name}' is reserved (a router tier, the grader, or a host primary/hidden agent)`);
  }
  if (!isPlainObject(entry)) return fail(at, "must be an object");
  for (const key of Object.keys(entry)) {
    if (ENTRY_KEYS.has(key)) continue;
    return fail(`${at}.${key}`, ["model", "variant", "mode"].includes(key)
      ? "is not configurable: the model and variant follow the tier, and the mode is always subagent"
      : "unknown key");
  }
  const { tier, description, prompt, steps, readOnly, allowTools, permission } = entry;
  if (typeof tier !== "string" || tier === "") return fail(`${at}.tier`, "must be a non-empty tier name");
  if (!Object.hasOwn(ctx.tiers, tier)) {
    return fail(`${at}.tier`, `tier '${tier}' is not defined by the active preset '${ctx.activePreset}'; agent skipped`);
  }
  if (typeof description !== "string" || description.trim() === "") return fail(`${at}.description`, "must be a non-empty string");
  if (prompt !== undefined && typeof prompt !== "string") return fail(`${at}.prompt`, "must be a string");
  if (steps !== undefined && (typeof steps !== "number" || !Number.isInteger(steps) || steps < 1)) {
    return fail(`${at}.steps`, "must be a positive integer");
  }
  if (readOnly !== undefined && typeof readOnly !== "boolean") return fail(`${at}.readOnly`, "must be a boolean");
  let tools: string[] | undefined;
  if (allowTools !== undefined) {
    if (!Array.isArray(allowTools)) return fail(`${at}.allowTools`, "must be an array of tool names");
    tools = [];
    for (const [i, tool] of allowTools.entries()) {
      if (typeof tool !== "string" || tool === "" || tool === "__proto__") return fail(`${at}.allowTools[${i}]`, "must be a non-empty tool name");
      // A leading wildcard (`*_*`, `?x`) matches tools the router cannot enumerate, including future host tools.
      if (tool[0] === "*" || tool[0] === "?") return fail(`${at}.allowTools[${i}]`, `'${tool}' starts with a wildcard; name the tool or a prefix such as 'context7_*'`);
      const hit = POLICY_ACTIONS.find((action) => permissionMatches(action, tool));
      if (hit !== undefined) return fail(`${at}.allowTools[${i}]`, `'${tool}' matches '${hit}'; shell, edit, delegation and read rules belong in 'permission'`);
      tools.push(tool);
    }
  }
  let rules: PermissionMap | undefined;
  if (permission !== undefined) {
    const checked = normalizePermission(permission, `${at}.permission`);
    if (!checked.ok) return checked;
    rules = checked.value;
  }
  if (readOnly !== true && rules === undefined) {
    return fail(at, "needs readOnly: true or an explicit permission (a plugin agent never inherits the host's allow-all defaults)");
  }
  if (readOnly === true && rules !== undefined) {
    for (const rule of permissionRules(rules)) {
      if (rule.effect === "allow") {
        return fail(`${at}.permission.${rule.action}`, "a readOnly agent's permission may only add deny or ask rules; grant tools with allowTools");
      }
      if (rule.effect === "ask" && HARD_ACTIONS.some((action) => permissionMatches(action, rule.action))) {
        return fail(`${at}.permission.${rule.action}`, "a readOnly agent may never ask for shell, edit or delegation");
      }
    }
  }
  return {
    ok: true,
    value: {
      tier, description,
      ...(prompt === undefined ? {} : { prompt }),
      ...(steps === undefined ? {} : { steps }),
      ...(readOnly === undefined ? {} : { readOnly }),
      ...(tools === undefined ? {} : { allowTools: tools }),
      ...(rules === undefined ? {} : { permission: rules }),
    },
  };
}

/**
 * Validate a merged `agents` block against the active preset. Never throws: a
 * bad entry is left out and reported; the other entries are kept (#80).
 * `undefined` in → `undefined` out, so a config without the block is unchanged.
 */
export function sanitizePluginAgents(
  raw: unknown,
  ctx: { activePreset: string; tiers: Preset },
): { agents: Record<string, PluginAgentConfig> | undefined; issues: PluginAgentIssue[] } {
  const issues: PluginAgentIssue[] = [];
  if (raw === undefined) return { agents: undefined, issues };
  if (!isPlainObject(raw)) {
    issues.push({ path: "agents", message: "must be an object mapping agent names to definitions; ignored" });
    return { agents: undefined, issues };
  }
  const agents: Record<string, PluginAgentConfig> = {};
  for (const [name, entry] of Object.entries(raw)) {
    const checked = validatePluginAgent(name, entry, ctx);
    if (checked.ok) {
      agents[name] = checked.value;
      issues.push(...editToolKeyNotices(name, checked.value));
    } else {
      issues.push({ ...checked.issue, name });
    }
  }
  return { agents, issues };
}

/** The host edit tools whose permission the OpenCode v2 host checks as `edit`. */
const EDIT_TOOL_KEYS: readonly string[] = ["write", "patch", "multiedit", "apply_patch"];

/**
 * QA-G-A2-2 (round 2, nit 2): notices (the agent is kept) for `permission` keys that name an edit tool (`write`, `patch`,
 * `multiedit`, `apply_patch`, or a pattern matching one but not `edit` itself) and allow or ask for a resource the agent's
 * own `edit` rules deny. On OpenCode v2 the host checks `edit` for these tools, and the router's catalog filter keeps one
 * only when `edit` is not denied: such a key can only narrow (a deny of the tool's own name removes it), never grant.
 */
function editToolKeyNotices(name: string, entry: PluginAgentConfig): PluginAgentIssue[] {
  if (entry.permission === undefined) return [];
  const rules = permissionRules(pluginAgentPolicy(entry, { context7: false, host: "v2" }).permission);
  const notices: PluginAgentIssue[] = [];
  for (const [key, rule] of Object.entries(entry.permission)) {
    if (permissionMatches("edit", key) || !EDIT_TOOL_KEYS.some((tool) => permissionMatches(tool, key))) continue;
    const grants = typeof rule === "string" ? [["*", rule] as const] : Object.entries(rule);
    const dropped = grants.some(([resource, effect]) => effect !== "deny" && evaluatePermission(rules, "edit", resource) === "deny");
    if (!dropped) continue;
    notices.push({
      name, path: `agents.${name}.permission.${key}`,
      message: "on OpenCode v2 the host checks `edit` for these tools: this key can only narrow them (a deny removes the tool), "
        + "`edit` decides; it allows or asks for something the agent's `edit` rules deny, so the tool is not offered there. Grant `edit` instead",
    });
  }
  return notices;
}

/**
 * The ask rules that protect sensitive paths reachable through one read grant
 * of `resource`, placed right after it. Never wider than the grant itself:
 * - `*`/`**`: every sensitive glob asks, the documented exceptions keep the grant's effect;
 * - an exact path: asks when it is sensitive (unless it is an exception);
 * - any other wildcard: the sensitive globs are denied at that position instead
 *   (an intersection the host's matcher can express is not computed; deny is only ever stricter).
 */
function sensitiveRulesFor(resource: string, effect: PermissionEffect): Array<[string, PermissionEffect]> {
  if (resource === "*" || resource === "**") {
    return [
      ...SENSITIVE_PERMISSION_GLOBS.map((glob): [string, PermissionEffect] => [glob, "ask"]),
      ...(effect === "allow" ? SENSITIVE_PERMISSION_EXCEPTIONS.map((glob): [string, PermissionEffect] => [glob, "allow"]) : []),
    ];
  }
  if (!/[*?]/.test(resource)) {
    const sensitive = SENSITIVE_PERMISSION_GLOBS.some((glob) => permissionMatches(resource, glob))
      && !SENSITIVE_PERMISSION_EXCEPTIONS.some((glob) => permissionMatches(resource, glob));
    return sensitive && effect === "allow" ? [[resource, "ask"]] : [];
  }
  return SENSITIVE_PERMISSION_GLOBS.map((glob): [string, PermissionEffect] => [glob, "deny"]);
}

/**
 * Every rule that applies to `read`, in order, with the sensitive-path rules
 * interleaved right after each grant. Interleaving (rather than appending all
 * asks at the end) keeps a later deny a deny: an ask placed after it would
 * turn it into a prompt that `--auto` answers.
 */
function readBlock(rules: readonly PermissionRule[]): Record<string, PermissionEffect> {
  const block: Record<string, PermissionEffect> = {};
  for (const rule of rules) {
    if (!permissionMatches("read", rule.action)) continue;
    putLast(block, rule.resource, rule.effect);
    if (rule.effect === "deny") continue;
    for (const [resource, effect] of sensitiveRulesFor(rule.resource, rule.effect)) putLast(block, resource, effect);
  }
  return block;
}

export interface PluginAgentPolicy {
  /** Ordered permission map in the host's vocabulary (v1: `bash`/`task`). */
  permission: PermissionMap;
}

/**
 * The permission policy published for a plugin agent.
 * - readOnly: the #77 read-only map, then `allowTools`, then the agent's own
 *   (deny/ask-only) rules.
 * - explicit: `* deny` first, then `allowTools`, then the agent's rules; the
 *   `read` rules are rebuilt last with the sensitive-path asks re-applied after
 *   every read grant (see {@link readBlock}).
 */
export function pluginAgentPolicy(
  entry: Pick<PluginAgentConfig, "readOnly" | "allowTools" | "permission">,
  opts: { context7: boolean; host: "v1" | "v2" },
): PluginAgentPolicy {
  const tools: PermissionMap = Object.fromEntries((entry.allowTools ?? []).map((tool) => [tool, "allow" as const]));
  const own = entry.permission ?? {};
  let permission: PermissionMap;
  if (entry.readOnly === true) {
    permission = mergePermissions(mergePermissions(readOnlyPermissions(opts.context7), tools), own);
  } else {
    const merged = mergePermissions(mergePermissions({ "*": "deny" }, tools), own);
    const block = readBlock(permissionRules(merged));
    permission = { ...merged };
    delete permission.read;
    permission.read = block;
  }
  return { permission: opts.host === "v1" ? toV1Actions(permission) : permission };
}

/** Rename the v2 actions to the v1 host's (`shell` → `bash`, `subagent` → `task`), keeping order. */
export function toV1Actions(permission: PermissionMap): PermissionMap {
  const out: PermissionMap = {};
  for (const [action, rule] of Object.entries(permission)) {
    const name = V1_ACTIONS[action] ?? action;
    const previous = out[name];
    if (isPlainObject(previous) && typeof rule === "object") {
      const merged = { ...previous };
      for (const [pattern, effect] of Object.entries(rule)) putLast(merged, pattern, effect);
      putLast<PermissionMap[string]>(out, name, merged);
    } else {
      putLast(out, name, rule);
    }
  }
  return out;
}

/** Marks an `agent.<name>` definition the router built from the `agents` block. */
export const PLUGIN_AGENT = Symbol.for("opencode-model-router.plugin-agent");

export interface PluginAgentMarker {
  tier: string;
  readOnly: boolean;
  /** v1 only: the opencode.json entry the definition was merged with, if any. */
  hostEntry?: Record<string, unknown>;
}

export function pluginAgentMarker(definition: unknown): PluginAgentMarker | undefined {
  if (!isPlainObject(definition)) return undefined;
  const marker = (definition as Record<PropertyKey, unknown>)[PLUGIN_AGENT];
  return isPlainObject(marker) ? marker as unknown as PluginAgentMarker : undefined;
}

/**
 * The host `agent.<name>` definition of a plugin agent (v1 config shape; the v2
 * adapter translates it). Model and variant come from the active tier; a tier
 * without a variant leaves none behind.
 */
export function buildPluginAgentDefinition(
  entry: PluginAgentConfig,
  tier: Pick<TierConfig, "model" | "variant" | "steps">,
  opts: { context7: boolean; host: "v1" | "v2" },
): Record<string, unknown> {
  const policy = pluginAgentPolicy(entry, opts);
  // Legacy `tools` booleans never carry `allowTools` (QA-81-5): the v1 host maps legacy `write|edit|patch`
  // tools to the `edit` permission, and the permission rules already grant every allowTools entry.
  const { allowTools: _granted, ...withoutGrants } = entry;
  const legacy = pluginAgentPolicy(withoutGrants, opts).permission;
  const steps = entry.steps ?? tier.steps;
  const definition: Record<string, unknown> = {
    model: tier.model,
    mode: "subagent",
    description: entry.description,
    ...(entry.prompt === undefined ? {} : { prompt: entry.prompt }),
    ...(steps === undefined ? {} : { steps, maxSteps: steps }),
    ...(tier.variant ? { variant: tier.variant } : {}),
    permission: policy.permission,
    tools: legacyReadOnlyTools(legacy),
  };
  const marker: PluginAgentMarker = { tier: entry.tier, readOnly: entry.readOnly === true };
  Object.defineProperty(definition, PLUGIN_AGENT, { value: marker, enumerable: false, configurable: true });
  return definition;
}

/**
 * v1 precedence, matching what the v2 host does on its own: an opencode.json
 * `agent.<name>` entry wins for every field it sets; its permission rules are
 * placed after the router's (last match wins) and its `tools` over the router's.
 */
export function mergeHostAgentEntry(
  definition: Record<string, unknown>,
  hostEntry: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...definition };
  for (const [key, value] of Object.entries(hostEntry)) {
    if (value === undefined) continue;
    if (key === "permission" && isPlainObject(value) && isPlainObject(definition.permission)) {
      merged.permission = mergePermissions(definition.permission as PermissionMap, value as PermissionMap);
    } else if (key === "tools" && isPlainObject(value) && isPlainObject(definition.tools)) {
      merged.tools = { ...definition.tools, ...value };
    } else {
      merged[key] = value;
    }
  }
  const marker = pluginAgentMarker(definition);
  if (marker) Object.defineProperty(merged, PLUGIN_AGENT, { value: { ...marker, hostEntry }, enumerable: false, configurable: true });
  return merged;
}
