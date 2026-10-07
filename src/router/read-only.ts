import type { TierConfig } from "./config";
import { GIT_TOOL_NAMES } from "./git-tools";

export type PermissionEffect = "allow" | "deny" | "ask";
export type PermissionMap = Record<string, PermissionEffect | Record<string, PermissionEffect>>;
export interface PermissionRule { action: string; resource: string; effect: PermissionEffect }
// MCP effective names are <sanitized-server>_<sanitized-tool>; hyphens survive
// sanitization on both hosts. Never allow context7_* (future tools may write).
export const CONTEXT7_DOC_TOOLS = ["context7_resolve-library-id", "context7_query-docs", "context7_get-library-docs"];

export function isReadOnlyTier(name: string, tier: Pick<TierConfig, "readOnly">): boolean {
  return tier.readOnly ?? name === "fast";
}

export function readOnlyPermissions(context7 = false): PermissionMap {
  return {
    "*": "deny",
    read: { "*": "allow", "*.env": "ask", "*.env.*": "ask", "*.env.example": "allow", "*.pem": "ask", "*.key": "ask",
      "id_*": "ask", "*/id_*": "ask", "*\\id_*": "ask", ".npmrc": "ask", "*/.npmrc": "ask", "*\\.npmrc": "ask",
      ".netrc": "ask", "*/.netrc": "ask", "*\\.netrc": "ask" },
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
