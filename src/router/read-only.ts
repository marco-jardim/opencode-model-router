import type { TierConfig } from "./config";
import { GIT_TOOL_NAMES } from "./git-tools";
import { randomUUID } from "node:crypto";
import { SENSITIVE_PERMISSION_GLOBS, SENSITIVE_PERMISSION_EXCEPTIONS } from "./sensitive-paths";

export type PermissionEffect = "allow" | "deny" | "ask";
export type PermissionMap = Record<string, PermissionEffect | Record<string, PermissionEffect>>;
export interface PermissionRule { action: string; resource: string; effect: PermissionEffect }

/** Reviewed host shape, not a call into the plugin's bundled SDK pretending to
 * describe the running host. Unknown shapes take the conservative branch. */
const KNOWN_HOST_DEFAULTS: readonly PermissionRule[] = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "external_directory", resource: "*", effect: "ask" },
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "read", resource: "*.env.example", effect: "allow" },
];
export const READ_ONLY_CANARIES = ["shell", "bash", "edit", "write", "patch", "execute", "subagent", "task", "webfetch", "websearch", "browser",
  `router_readonly_canary_${randomUUID()}`];

/** Mirrors host v2.0.22 Permission.evaluate + util/wildcard.ts: last match,
 * slash normalization, ? and *, dotall, Windows case folding, default ask. */
export function permissionMatches(input: string, pattern: string): boolean {
  let escaped = pattern.replaceAll("\\", "/").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?";
  return new RegExp(`^${escaped}$`, process.platform === "win32" ? "si" : "s").test(input.replaceAll("\\", "/"));
}

export function evaluatePermission(rules: readonly PermissionRule[], action: string, resource: string): PermissionEffect {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i]!;
    if (permissionMatches(action, rule.action) && permissionMatches(resource, rule.resource)) return rule.effect;
  }
  return "ask";
}

/** No provenance API distinguishes a newly appended host default from a user
 * grant. While readOnly is true, neither can widen the policy's action surface.
 * Resource overrides on permitted actions and inherited denies survive.
 * Inherited asks cannot create auto-approvable capabilities outside that set. */
export function publishReadOnlyPermissions(name: string, policy: readonly PermissionRule[], inherited: readonly PermissionRule[], warn: (message: string) => void): PermissionRule[] {
  const recognised = KNOWN_HOST_DEFAULTS.every((rule, i) => inherited[i]?.action === rule.action
    && inherited[i]?.resource === rule.resource && inherited[i]?.effect === rule.effect);
  const tail = inherited.slice(recognised ? KNOWN_HOST_DEFAULTS.length : 0);
  const allowed = new Set(policy.filter(rule => rule.effect === "allow" && rule.action !== "*").map(rule => rule.action));
  // Keep P1's rejection of non-explicit allows: projecting a drifted host's
  // '* allow' onto read would overwrite the policy's sensitive-path asks.
  const projectable = tail.filter(rule => rule.effect !== "allow" || allowed.has(rule.action));
  const safe = projectable.flatMap(rule => rule.effect === "deny" ? [rule]
    : [...allowed].filter(action => permissionMatches(action, rule.action)).map(action => ({ ...rule, action })));
  if (!recognised) warn(`host default permissions not recognised for ${name}`);
  if (tail.some(rule => rule.effect !== "deny" && !allowed.has(rule.action))) warn(`inherited grant dropped for ${name}`);
  // Check the final projected list, including policy rules, with last-match semantics.
  const candidate = [...policy, ...safe];
  const resources = new Set(["*", "src/file.ts", "echo probe", ...tail.map(rule => rule.resource)]);
  const breached = READ_ONLY_CANARIES.some(action => [...resources].some(resource => evaluatePermission(candidate, action, resource) !== "deny"));
  if (breached) {
    warn(`read-only permission canary failed for ${name}; inherited grants restricted`);
    return [{ action: "*", resource: "*", effect: "deny" }, ...candidate.filter(rule => rule.effect === "deny"
      || (rule.action !== "*" && !READ_ONLY_CANARIES.some(action => permissionMatches(action, rule.action))))];
  }
  return candidate;
}
// MCP effective names are <sanitized-server>_<sanitized-tool>; hyphens survive
// sanitization on both hosts. Never allow context7_* (future tools may write).
export const CONTEXT7_DOC_TOOLS = ["context7_resolve-library-id", "context7_query-docs", "context7_get-library-docs"];

export function isReadOnlyTier(name: string, tier: Pick<TierConfig, "readOnly">): boolean {
  return tier.readOnly ?? name === "fast";
}

export function readOnlyPermissions(context7 = false): PermissionMap {
  return {
    "*": "deny",
    read: { "*": "allow", ...Object.fromEntries(SENSITIVE_PERMISSION_GLOBS.map(pattern => [pattern, "ask" as const])),
      ...Object.fromEntries(SENSITIVE_PERMISSION_EXCEPTIONS.map(pattern => [pattern, "allow" as const])) },
    glob: "allow", grep: "allow", external_directory: "allow",
    ...Object.fromEntries([...GIT_TOOL_NAMES, ...(context7 ? CONTEXT7_DOC_TOOLS : [])].map(name => [name, "allow" as const])),
  };
}

/** Move overridden keys to the end: permissions are ordered, not plain spread-merged. */
export function mergePermissions(base: PermissionMap, user: PermissionMap | PermissionEffect = {}): PermissionMap {
  const result = { ...base };
  for (const [action, rule] of Object.entries(typeof user === "string" ? { "*": user } : user)) {
    const old = result[action];
    delete result[action];
    if (typeof old === "object" && typeof rule === "object") {
      const resources = { ...old };
      for (const [resource, effect] of Object.entries(rule)) { delete resources[resource]; resources[resource] = effect; }
      result[action] = resources;
    } else result[action] = rule;
  }
  return result;
}

export function permissionRules(permission: PermissionMap): PermissionRule[] {
  return Object.entries(permission).flatMap(([action, rule]) => typeof rule === "string"
    ? [{ action, resource: "*", effect: rule }]
    : Object.entries(rule).map(([resource, effect]) => ({ action, resource, effect })));
}

/** Legacy SDKs expose tools booleans as well as a narrower permission type. */
export function legacyReadOnlyTools(permission: PermissionMap): Record<string, boolean> {
  return Object.fromEntries(Object.entries(permission).map(([action, rule]) => [action,
    typeof rule === "string" ? rule !== "deny" : Object.values(rule).some(effect => effect !== "deny")]));
}
