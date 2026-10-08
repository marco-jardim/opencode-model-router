/**
 * Validation of the roles-and-assurance configuration keys (issue #84, plan P1.1).
 *
 * Every sanitiser here is total: a bad value never throws. It drops only the key or entry it
 * belongs to and reports a {@link RolesIssue}, so a typo in `roleAgents.reviewer.budget` can
 * never cost a layer or the whole `routing` block (the #80 lesson, applied to the new keys only).
 * The caller turns issues into config notices.
 */

import type { AuthorityAction, ExplorationConfig, RoleSpec, RunConfig } from "./roles";

export interface RolesIssue {
  /** Config path of the offending key or entry, e.g. `routing.run.commands.build`. */
  path: string;
  message: string;
}

export interface Sanitized<T> {
  value: T | undefined;
  issues: RolesIssue[];
}

export const DELEGATION_MODES = ["tiers", "roles"] as const;
export type DelegationMode = (typeof DELEGATION_MODES)[number];

export const EXPLORATION_MAX_RATE = 0.2;
export const DEFAULT_RUN_SCRIPTS: readonly string[] = ["test", "typecheck", "lint", "build"];
/**
 * Default `routing.run.commands` (#84, P1.3 handoff): package.json scripts take no caller
 * arguments, so a scoped test run needs a command entry. `npm run test -- <files>` goes through
 * router_run's hardened npm path (npm-cli.js of the node install, pinned script shell). The
 * patterns admit `test/...` paths and `--maxWorkers=N` only; confinement (no `..` segment, no
 * absolute or drive path, option-like leads `-`/`@`/`+` only against a pattern with the same
 * lead) is enforced by router_run itself (P1.3). A user `routing.run.commands` replaces it.
 */
export const DEFAULT_RUN_COMMANDS: RunConfig["commands"] = Object.freeze({
  "test-files": Object.freeze({
    argv: Object.freeze(["npm", "run", "test", "--"]),
    args: Object.freeze(["test/*", "--maxWorkers=*"]),
  }),
});
export const DEFAULT_RUN_TIMEOUT_MS = 600_000;
export const RUN_TIMEOUT_BOUNDS = { min: 1_000, max: 3_600_000 } as const;
export const ROLES_V1_NOTICE = "roles delegation requires OpenCode v2; using tiers";

const AUTHORITY_ACTION_LIST = [
  "read", "glob", "grep", "router_git", "router_run", "edit", "webfetch", "websearch", "context7", "execute",
] as const satisfies readonly AuthorityAction[];
type MissingActions = Exclude<AuthorityAction, (typeof AUTHORITY_ACTION_LIST)[number]>;
const _allActionsListed: [MissingActions] extends [never] ? true : never = true;
void _allActionsListed;
export const AUTHORITY_ACTIONS: readonly AuthorityAction[] = AUTHORITY_ACTION_LIST;

/** Customisable fields of a role agent. `codeModeAllow` was removed (R6); it is reported, not read. */
export interface RoleAgentCustomisation {
  enabled?: boolean;
  description?: string;
  prompt?: string;
  tierRange?: { floor?: string; ceiling?: string };
  budget?: Record<string, number>;
  deny?: AuthorityAction[];
}

const FORBIDDEN_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*(?::[A-Za-z0-9_.-]+)*$/;
const MAX_DESCRIPTION = 1_000;
const MAX_PROMPT = 20_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function show(v: unknown): string {
  let s: string;
  try {
    s = typeof v === "string" ? JSON.stringify(v) : (JSON.stringify(v) ?? String(v));
  } catch {
    s = `<${typeof v}>`;
  }
  return s.length <= 60 ? s : `${s.slice(0, 59)}…`;
}

export function sanitizeDelegation(value: unknown): Sanitized<DelegationMode> {
  if (value === undefined) return { value: undefined, issues: [] };
  const hit = DELEGATION_MODES.find((m) => m === value);
  if (hit !== undefined) return { value: hit, issues: [] };
  return {
    value: undefined,
    issues: [{ path: "routing.delegation", message: `routing.delegation must be tiers|roles (got ${show(value)}); using tiers` }],
  };
}

export function sanitizeExploration(value: unknown): Sanitized<Partial<ExplorationConfig>> {
  const issues: RolesIssue[] = [];
  if (value === undefined) return { value: undefined, issues };
  if (!isRecord(value)) {
    issues.push({ path: "routing.exploration", message: `routing.exploration must be an object (got ${show(value)}); ignored` });
    return { value: undefined, issues };
  }
  const out: Partial<ExplorationConfig> = { requireDetection: "deterministic" };
  const rate = value.rate;
  if (rate !== undefined) {
    if (typeof rate === "number" && Number.isFinite(rate) && rate >= 0 && rate <= EXPLORATION_MAX_RATE) out.rate = rate;
    else {
      issues.push({
        path: "routing.exploration.rate",
        message: `routing.exploration.rate must be a number from 0 to ${EXPLORATION_MAX_RATE} (got ${show(rate)}); using 0`,
      });
    }
  }
  if (value.requireDetection !== undefined && value.requireDetection !== "deterministic") {
    issues.push({
      path: "routing.exploration.requireDetection",
      message: `routing.exploration.requireDetection is fixed to "deterministic" (got ${show(value.requireDetection)}); ignored`,
    });
  }
  return { value: out, issues };
}

export function sanitizeRun(value: unknown): Sanitized<Partial<RunConfig>> {
  const issues: RolesIssue[] = [];
  if (value === undefined) return { value: undefined, issues };
  if (!isRecord(value)) {
    issues.push({ path: "routing.run", message: `routing.run must be an object (got ${show(value)}); ignored` });
    return { value: undefined, issues };
  }
  const out: { scripts?: string[]; commands?: RunConfig["commands"]; timeoutMs?: number } = {};

  if (value.scripts !== undefined) {
    if (!Array.isArray(value.scripts)) {
      issues.push({ path: "routing.run.scripts", message: `routing.run.scripts must be an array of script names (got ${show(value.scripts)}); using the defaults` });
    } else {
      const scripts: string[] = [];
      value.scripts.forEach((s: unknown, i) => {
        if (typeof s === "string" && SCRIPT_NAME.test(s) && !FORBIDDEN_NAMES.has(s)) {
          if (!scripts.includes(s)) scripts.push(s);
        } else {
          issues.push({ path: `routing.run.scripts[${i}]`, message: `routing.run.scripts[${i}] is not a valid script name (got ${show(s)}); entry dropped` });
        }
      });
      out.scripts = scripts;
    }
  }

  if (value.commands !== undefined) {
    if (!isRecord(value.commands)) {
      issues.push({ path: "routing.run.commands", message: `routing.run.commands must be an object (got ${show(value.commands)}); ignored` });
    } else {
      const commands: Record<string, { argv: readonly string[]; args?: readonly string[] }> = {};
      for (const [name, entry] of Object.entries(value.commands)) {
        const path = `routing.run.commands.${name}`;
        if (!COMMAND_NAME.test(name) || FORBIDDEN_NAMES.has(name)) {
          issues.push({ path, message: `${path}: the command name is not valid; entry dropped` });
          continue;
        }
        if (!isRecord(entry)) {
          issues.push({ path, message: `${path} must be an object with argv (got ${show(entry)}); entry dropped` });
          continue;
        }
        const argv = entry.argv;
        if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a): a is string => typeof a === "string" && a !== "")) {
          issues.push({ path: `${path}.argv`, message: `${path}.argv must be a non-empty array of non-empty strings; entry dropped` });
          continue;
        }
        const cmd: { argv: readonly string[]; args?: readonly string[] } = { argv: [...argv] };
        if (entry.args !== undefined) {
          if (Array.isArray(entry.args) && entry.args.every((a): a is string => typeof a === "string")) {
            cmd.args = [...entry.args];
          } else {
            issues.push({ path: `${path}.args`, message: `${path}.args must be an array of strings; args ignored` });
          }
        }
        commands[name] = cmd;
      }
      out.commands = commands;
    }
  }

  if (value.timeoutMs !== undefined) {
    const t = value.timeoutMs;
    if (typeof t === "number" && Number.isInteger(t) && t >= RUN_TIMEOUT_BOUNDS.min && t <= RUN_TIMEOUT_BOUNDS.max) out.timeoutMs = t;
    else {
      issues.push({
        path: "routing.run.timeoutMs",
        message: `routing.run.timeoutMs must be an integer from ${RUN_TIMEOUT_BOUNDS.min} to ${RUN_TIMEOUT_BOUNDS.max} (got ${show(t)}); using ${DEFAULT_RUN_TIMEOUT_MS}`,
      });
    }
  }
  return { value: out, issues };
}

/** True when `name` may be run by `router_run`: a listed script, or any `test:*` script. */
export function isRunScriptAllowed(name: string, scripts: readonly string[]): boolean {
  return scripts.includes(name) || /^test:[A-Za-z0-9_.:-]+$/.test(name);
}

/**
 * Why `entry` is not an acceptable work root, or undefined. An entry needs an absolute static
 * prefix with at least one real path segment (so `*`, `/**`, `D:/**` are refused) in its
 * canonical long form: a segment like `PROGRA~1` is an 8.3 short name that can alias another
 * directory (R6/P-11).
 */
export function workRootProblem(entry: string): string | undefined {
  if (entry === "") return "is empty";
  const globAt = entry.search(/[*?[\]{}]/);
  const prefix = globAt === -1 ? entry : entry.slice(0, globAt);
  const normalised = prefix.replace(/\\/g, "/");
  let rest: string;
  if (/^[A-Za-z]:\//.test(normalised)) rest = normalised.slice(3);
  else if (/^\/\/[^/]+\/[^/]+/.test(normalised)) rest = normalised.replace(/^\/\/[^/]+\/[^/]+/, "");
  else if (normalised.startsWith("/") && !normalised.startsWith("//")) rest = normalised.slice(1);
  else return "has no absolute static prefix";
  // A segment cut by the first glob character is not static: `/a/b*` has static prefix `/a/`.
  const segments = rest.split("/");
  if (globAt !== -1) segments.pop();
  const real = segments.filter((s) => s !== "");
  if (real.length === 0) return "has no static directory before its first wildcard";
  const all = entry.split(/[\\/]/);
  if (all.some((s) => s === ".." || s === ".")) return "contains a . or .. segment";
  // Every segment, wildcard ones and those after the first wildcard included (QA-P11-1-6).
  if (all.some((s) => /~\d/.test(s))) return "contains an 8.3 short-name component; use the long form of the path";
  return undefined;
}

export function sanitizeWorkRoots(value: unknown): Sanitized<string[]> {
  const issues: RolesIssue[] = [];
  if (value === undefined) return { value: undefined, issues };
  if (!Array.isArray(value)) {
    issues.push({ path: "routing.workRoots", message: `routing.workRoots must be an array of absolute globs (got ${show(value)}); ignored` });
    return { value: undefined, issues };
  }
  const out: string[] = [];
  value.forEach((entry: unknown, i) => {
    const path = `routing.workRoots[${i}]`;
    if (typeof entry !== "string") {
      issues.push({ path, message: `${path} must be a string (got ${show(entry)}); entry dropped` });
      return;
    }
    const problem = workRootProblem(entry);
    if (problem !== undefined) {
      issues.push({ path, message: `${path} ${show(entry)} ${problem}; entry dropped` });
      return;
    }
    if (!out.includes(entry)) out.push(entry);
  });
  return { value: out, issues };
}

export function sanitizeRoleAgents(value: unknown): Sanitized<Record<string, RoleAgentCustomisation>> {
  const issues: RolesIssue[] = [];
  if (value === undefined) return { value: undefined, issues };
  if (!isRecord(value)) {
    issues.push({ path: "roleAgents", message: `roleAgents must be an object (got ${show(value)}); ignored` });
    return { value: undefined, issues };
  }
  const out: Record<string, RoleAgentCustomisation> = {};
  for (const [name, raw] of Object.entries(value)) {
    const base = `roleAgents.${name}`;
    if (!AGENT_NAME.test(name) || name.includes("..") || FORBIDDEN_NAMES.has(name)) {
      issues.push({ path: base, message: `${base}: the agent name is not valid; entry dropped` });
      continue;
    }
    if (!isRecord(raw)) {
      issues.push({ path: base, message: `${base} must be an object (got ${show(raw)}); entry dropped` });
      continue;
    }
    const c: RoleAgentCustomisation = {};
    for (const key of Object.keys(raw)) {
      if (!["enabled", "description", "prompt", "tierRange", "budget", "deny"].includes(key)) {
        issues.push({
          path: `${base}.${key}`,
          message: key === "codeModeAllow"
            ? `${base}.codeModeAllow is not supported (removed); ignored`
            : `${base}.${key} is not a customisable field; ignored`,
        });
      }
    }
    if (raw.enabled !== undefined) {
      if (typeof raw.enabled === "boolean") c.enabled = raw.enabled;
      else issues.push({ path: `${base}.enabled`, message: `${base}.enabled must be a boolean (got ${show(raw.enabled)}); ignored` });
    }
    for (const [key, max] of [["description", MAX_DESCRIPTION], ["prompt", MAX_PROMPT]] as const) {
      const v = raw[key];
      if (v === undefined) continue;
      if (typeof v === "string" && v.trim() !== "" && v.length <= max) c[key] = v;
      else issues.push({ path: `${base}.${key}`, message: `${base}.${key} must be a non-empty string of at most ${max} characters; ignored` });
    }
    if (raw.tierRange !== undefined) {
      const tr = raw.tierRange;
      const range: { floor?: string; ceiling?: string } = {};
      if (isRecord(tr)) {
        for (const k of ["floor", "ceiling"] as const) {
          const v = tr[k];
          if (v === undefined) continue;
          if (typeof v === "string" && v !== "") range[k] = v;
          else issues.push({ path: `${base}.tierRange.${k}`, message: `${base}.tierRange.${k} must be a tier name (got ${show(v)}); ignored` });
        }
        if (range.floor !== undefined || range.ceiling !== undefined) c.tierRange = range;
      } else {
        issues.push({ path: `${base}.tierRange`, message: `${base}.tierRange must be an object (got ${show(tr)}); ignored` });
      }
    }
    if (raw.budget !== undefined) {
      if (isRecord(raw.budget)) {
        const budget: Record<string, number> = {};
        for (const [k, v] of Object.entries(raw.budget)) {
          if (FORBIDDEN_NAMES.has(k)) continue;
          if (typeof v === "number" && Number.isFinite(v) && v > 0) budget[k] = v;
          else issues.push({ path: `${base}.budget.${k}`, message: `${base}.budget.${k} must be a number > 0 (got ${show(v)}); entry dropped` });
        }
        c.budget = budget;
      } else {
        issues.push({ path: `${base}.budget`, message: `${base}.budget must be an object (got ${show(raw.budget)}); ignored` });
      }
    }
    if (raw.deny !== undefined) {
      if (Array.isArray(raw.deny)) {
        const deny: AuthorityAction[] = [];
        for (const a of raw.deny as unknown[]) {
          const hit = AUTHORITY_ACTIONS.find((x) => x === a);
          if (hit === undefined) issues.push({ path: `${base}.deny`, message: `${base}.deny entry ${show(a)} is not an action (${AUTHORITY_ACTIONS.join("|")}); entry dropped` });
          else if (!deny.includes(hit)) deny.push(hit);
        }
        c.deny = deny;
      } else {
        issues.push({ path: `${base}.deny`, message: `${base}.deny must be an array of actions (got ${show(raw.deny)}); ignored` });
      }
    }
    out[name] = c;
  }
  return { value: out, issues };
}

/**
 * Applies a user's customisation to a shipped spec. Narrowing only: the tier range stays inside
 * the shipped one (clamped, with an issue), `deny` can only remove actions, `enabled: true` cannot
 * revive a disabled role, and a budget is within (0, 2 x shipped]. `tierOrder` lists tier names
 * from cheapest to dearest. Never mutates `spec`.
 */
export function narrowRoleSpec(
  spec: RoleSpec,
  custom: RoleAgentCustomisation | undefined,
  tierOrder: readonly string[],
): { spec: RoleSpec; issues: RolesIssue[] } {
  const issues: RolesIssue[] = [];
  if (custom === undefined) return { spec, issues };
  const base = `roleAgents.${spec.agent}`;
  const next: RoleSpec = {
    ...spec,
    authority: { ...spec.authority, allow: [...spec.authority.allow], deny: [...spec.authority.deny] },
    tierRange: { ...spec.tierRange },
    budget: { ...spec.budget },
  };

  if (custom.enabled === false) next.enabled = false;
  else if (custom.enabled === true && !spec.enabled) {
    issues.push({ path: `${base}.enabled`, message: `${base}.enabled: true cannot enable a role that is disabled by default; ignored` });
  }
  if (custom.description !== undefined) next.description = custom.description;
  if (custom.prompt !== undefined) next.prompt = custom.prompt;

  if (custom.tierRange !== undefined) {
    const lo = tierOrder.indexOf(spec.tierRange.floor);
    const hi = tierOrder.indexOf(spec.tierRange.ceiling);
    if (lo === -1 || hi === -1) {
      issues.push({ path: `${base}.tierRange`, message: `${base}.tierRange: the shipped range is not in the active preset; ignored` });
    } else {
      const resolve = (key: "floor" | "ceiling"): number | undefined => {
        const name = custom.tierRange?.[key];
        if (name === undefined) return undefined;
        const idx = tierOrder.indexOf(name);
        if (idx === -1) {
          issues.push({ path: `${base}.tierRange.${key}`, message: `${base}.tierRange.${key} ${show(name)} is not a tier (${tierOrder.join("|")}); ignored` });
          return undefined;
        }
        const clamped = Math.min(Math.max(idx, lo), hi);
        if (clamped !== idx) {
          issues.push({
            path: `${base}.tierRange.${key}`,
            message: `${base}.tierRange.${key} ${show(name)} is outside the shipped range ${spec.tierRange.floor}..${spec.tierRange.ceiling}; clamped to ${tierOrder[clamped]}`,
          });
        }
        return clamped;
      };
      const f = resolve("floor") ?? lo;
      const c = resolve("ceiling") ?? hi;
      if (f > c) {
        issues.push({ path: `${base}.tierRange`, message: `${base}.tierRange floor is above its ceiling; ignored` });
      } else {
        next.tierRange = { floor: tierOrder[f]!, ceiling: tierOrder[c]! };
      }
    }
  }

  if (custom.deny !== undefined && custom.deny.length > 0) {
    const denied = new Set(custom.deny);
    next.authority = {
      ...next.authority,
      allow: next.authority.allow.filter((a) => !denied.has(a)),
      deny: [...new Set([...next.authority.deny, ...custom.deny])],
    };
  }

  if (custom.budget !== undefined) {
    const budget: Record<string, number> = { ...spec.budget };
    for (const [k, v] of Object.entries(custom.budget)) {
      const shipped = Object.hasOwn(spec.budget, k) ? spec.budget[k] : undefined;
      if (shipped === undefined) {
        issues.push({ path: `${base}.budget.${k}`, message: `${base}.budget.${k} is not a budget of this role; entry dropped` });
        continue;
      }
      if (v > 2 * shipped) {
        issues.push({ path: `${base}.budget.${k}`, message: `${base}.budget.${k} ${v} is above twice the shipped ${shipped}; clamped to ${2 * shipped}` });
        budget[k] = 2 * shipped;
      } else budget[k] = v;
    }
    next.budget = budget;
  }
  return { spec: next, issues };
}

/** Every issue of the new keys in a merged raw config (`routing` + root `roleAgents`). */
export function collectRolesIssues(rawRouting: unknown, rawRoleAgents: unknown): RolesIssue[] {
  const r = isRecord(rawRouting) ? rawRouting : {};
  return [
    ...sanitizeDelegation(r.delegation).issues,
    ...sanitizeExploration(r.exploration).issues,
    ...sanitizeRun(r.run).issues,
    ...sanitizeWorkRoots(r.workRoots).issues,
    ...sanitizeRoleAgents(rawRoleAgents).issues,
  ];
}
