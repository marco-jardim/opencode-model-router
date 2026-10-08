import type { Detection } from "../routing/classify/types";
import type { RouterConfig } from "./config";

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

/**
 * Resolves the role table for a host. Empty on v1 and in `tiers` mode.
 * Stub: T1.1.3 fills it in.
 */
export function resolveRoles(
  _cfg: RouterConfig,
  _host: "v1" | "v2",
): ReadonlyMap<string, RoleSpec> {
  return new Map<string, RoleSpec>();
}
