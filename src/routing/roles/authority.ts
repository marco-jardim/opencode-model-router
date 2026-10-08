/**
 * Authority ladder (plan §2.5, R6): the `router_request_authority` tool definition and its state. P2.1
 * registers the tool for dynamic role agents and wires the dependencies (role lookup by child session,
 * binding lookup); nothing is registered here.
 *
 * - Not a role child, or a fixed role → refused (fixed authority is never widened), naming the role to use.
 * - Dynamic role: actions inside the role max (allow − deny; `execute` never) are recorded per child and the
 *   child is told to stop with `ESCALATE: authority`; actions outside it are refused, naming the role that
 *   has them (egress → `researcher`, edit → `implementer`, …); `router_run` without a bound work root is
 *   refused (I9); actions already granted are reported as such.
 * - A replay (every recorded action requested again) changes nothing and returns the same text.
 * - Resume: `consumeAuthority(child)` applies recorded ∩ the CURRENT role max through binding.ts `widen`,
 *   which bounds it by the max again; the record is cleared. Requests never widen beyond the max.
 *
 * State lives on `globalThis` under a `Symbol.for` key (one state for every plugin instance in the process).
 */

import { tool } from "@opencode-ai/plugin";
import type { AuthorityAction, RoleSpec } from "../../router/roles";
import { currentBinding, widen as widenBinding, type Binding } from "./binding";
import type { DispatchGrant } from "./policy";

export const AUTHORITY_TOOL_NAME = "router_request_authority";

export interface AuthorityDeps {
  /** Role of a child session; undefined → not a role child. */
  roleOf(childSessionID: string): RoleSpec | undefined;
  /** The child's binding. Default: binding.ts `currentBinding`. */
  bindingOf?(childSessionID: string): Binding | undefined;
  /** The resume path's widening. Default: binding.ts `widen`. */
  widen?(childSessionID: string, actions: readonly AuthorityAction[], max: Iterable<AuthorityAction>): DispatchGrant;
  /** Enabled roles, to name the role to use in a refusal. Default: the shipped role names. */
  roles?(): ReadonlyMap<string, RoleSpec>;
}

export interface AuthorityRequest {
  actions: readonly string[];
  reason: string;
}

export interface AuthorityRefusal {
  action: string;
  reason: string;
}

export interface AuthorityResult {
  /** recorded: something is on record for this request; granted: all already granted; refused: nothing usable. */
  status: "recorded" | "granted" | "refused";
  /** Actions of this request now on record (sorted). */
  recorded: readonly AuthorityAction[];
  /** Actions of this request already in the child's grant. */
  granted: readonly AuthorityAction[];
  refused: readonly AuthorityRefusal[];
  /** True when every recorded action was already on record (state unchanged). */
  replay: boolean;
  text: string;
}

/** Children with a request kept at most (oldest first out). */
export const AUTHORITY_REQUESTS_MAX = 512;
const REASONS_MAX = 8;
const REASON_CHARS = 500;

const ACTIONS: readonly AuthorityAction[] = [
  "read", "glob", "grep", "router_git", "router_run", "edit", "webfetch", "websearch", "context7", "execute",
];
const LOCAL: ReadonlySet<AuthorityAction> = new Set<AuthorityAction>(["read", "glob", "grep", "router_git"]);
const EGRESS: ReadonlySet<AuthorityAction> = new Set<AuthorityAction>(["webfetch", "websearch", "context7", "execute"]);
const WRITE_ALIASES: ReadonlySet<string> = new Set(["write", "patch", "multiedit", "apply_patch"]);
const SHELL_ALIASES: ReadonlySet<string> = new Set(["shell", "bash", "network"]);
const REQUESTABLE = ACTIONS.filter((a) => a !== "execute").join(", ");

/** Roles that hold an action, preferred first (§2.2 table). */
const PREFERRED: Readonly<Record<"local" | "exec" | "write" | "egress", readonly string[]>> = {
  local: ["explorer", "architect"],
  exec: ["runner", "implementer", "general"],
  write: ["implementer", "general"],
  egress: ["researcher"],
};

/** Refusal reasons (exact texts, shared with the tests). */
export const AUTHORITY_TEXT = {
  notRole: "router_request_authority is only for role agents",
  fixed: (agent: string): string => `${agent} has a fixed authority that is never widened`,
  execute: "`execute` (Code Mode) is never granted to role agents — dispatch a tier agent explicitly",
  shell: "raw shell is outside roles mode — request `router_run` for repository scripts, or dispatch a tier agent explicitly",
  unknown: `unknown action; requestable: ${REQUESTABLE}`,
  noWorkRoot: "router_run needs a work root bound to this dispatch (root=) — return `ESCALATE: authority` so the parent re-dispatches with root=",
  outside: (agent: string, role: string | undefined): string => role === undefined
    ? `outside ${agent}'s authority and no role grants it — dispatch a tier agent explicitly`
    : `outside ${agent}'s authority — dispatch \`${role}\` for it`,
} as const;

// ---------------------------------------------------------------------------
// Process-wide state
// ---------------------------------------------------------------------------

interface RequestRecord {
  actions: Set<AuthorityAction>;
  reasons: string[];
}

interface AuthorityState {
  readonly version: 1;
  readonly requests: Map<string, RequestRecord>;
}

const STATE_KEY = Symbol.for("opencode-model-router.role-authority");

function state(): AuthorityState {
  const existing: unknown = Reflect.get(globalThis, STATE_KEY);
  if (typeof existing === "object" && existing !== null
    && (existing as Partial<AuthorityState>).version === 1
    && (existing as Partial<AuthorityState>).requests instanceof Map) {
    return existing as AuthorityState;
  }
  const created: AuthorityState = { version: 1, requests: new Map() };
  Reflect.set(globalThis, STATE_KEY, created);
  return created;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sorted(actions: Iterable<AuthorityAction>): AuthorityAction[] {
  const have = new Set(actions);
  return ACTIONS.filter((a) => have.has(a));
}

/** The role max: allow − deny, known actions only, never `execute` (P-6). */
export function roleMax(role: RoleSpec): ReadonlySet<AuthorityAction> {
  const denied = new Set<string>(role.authority.deny);
  const allowed = new Set<string>(role.authority.allow);
  return new Set(ACTIONS.filter((a) => a !== "execute" && allowed.has(a) && !denied.has(a)));
}

function classOf(action: AuthorityAction): keyof typeof PREFERRED {
  if (LOCAL.has(action)) return "local";
  if (EGRESS.has(action)) return "egress";
  return action === "edit" ? "write" : "exec";
}

/** The role to use for an action: the preferred enabled role holding it, else any enabled one. */
export function roleFor(action: AuthorityAction, roles?: ReadonlyMap<string, RoleSpec>): string | undefined {
  if (action === "execute") return undefined;
  const preferred = PREFERRED[classOf(action)];
  if (roles === undefined) return preferred[0];
  const holds = (spec: RoleSpec | undefined): spec is RoleSpec => spec !== undefined && spec.enabled && roleMax(spec).has(action);
  for (const name of preferred) if (holds(roles.get(name))) return name;
  for (const spec of roles.values()) if (holds(spec)) return spec.agent;
  return undefined;
}

type Parsed = { kind: "action"; action: AuthorityAction } | { kind: "refused"; reason: string };

function parseAction(raw: string): Parsed {
  const name = raw.trim().toLowerCase();
  const known = ACTIONS.find((a) => a === name);
  if (known !== undefined) return { kind: "action", action: known };
  if (name.startsWith("router_git_")) return { kind: "action", action: "router_git" };
  if (name.startsWith("context7_")) return { kind: "action", action: "context7" };
  if (WRITE_ALIASES.has(name)) return { kind: "action", action: "edit" };
  if (SHELL_ALIASES.has(name)) return { kind: "refused", reason: AUTHORITY_TEXT.shell };
  return { kind: "refused", reason: AUTHORITY_TEXT.unknown };
}

function cleanReason(reason: string): string {
  return reason.replace(/\s+/g, " ").trim().slice(0, REASON_CHARS);
}

function compose(recorded: readonly AuthorityAction[], granted: readonly AuthorityAction[],
  refused: readonly AuthorityRefusal[], status: AuthorityResult["status"]): string {
  const parts: string[] = [];
  if (recorded.length > 0) {
    const list = recorded.join(", ");
    parts.push(`Authority request recorded: ${list}. Stop now and return \`ESCALATE: authority\` naming ${list} and why; the parent resumes this task with the wider grant.`);
  }
  if (granted.length > 0) parts.push(`Already granted: ${granted.join(", ")}.`);
  if (refused.length > 0) parts.push(`Refused: ${refused.map((r) => `${r.action} (${r.reason})`).join("; ")}.`);
  if (status === "granted") parts.push("Continue with your current grant.");
  if (status === "refused") {
    parts.push("Nothing was recorded; do not repeat this request. Continue with your current grant, or return `ESCALATE: authority` naming the role to use.");
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * Handles one `router_request_authority` call from a child session (rules in the module comment). Throws
 * only when a dependency throws (the tool reports that as an error, nothing recorded).
 */
export function requestAuthority(childSessionID: string, input: AuthorityRequest, deps: AuthorityDeps): AuthorityResult {
  const refused: AuthorityRefusal[] = [];
  const requested: AuthorityAction[] = [];
  for (const raw of input.actions) {
    const parsed = parseAction(raw);
    if (parsed.kind === "refused") refused.push({ action: raw, reason: parsed.reason });
    else if (!requested.includes(parsed.action)) requested.push(parsed.action);
  }
  const role = deps.roleOf(childSessionID);
  const roles = deps.roles?.();
  const done = (recorded: AuthorityAction[], granted: AuthorityAction[], replay: boolean): AuthorityResult => {
    const status = recorded.length > 0 ? "recorded" : granted.length > 0 && refused.length === 0 ? "granted" : "refused";
    return { status, recorded, granted, refused, replay, text: compose(recorded, granted, refused, status) };
  };
  if (role === undefined) {
    for (const action of sorted(requested)) refused.push({ action, reason: AUTHORITY_TEXT.notRole });
    return done([], [], false);
  }
  const max = roleMax(role);
  const fixed = role.authority.mode === "fixed";
  const binding = (deps.bindingOf ?? currentBinding)(childSessionID);
  const grant = binding?.grant;
  const inside: AuthorityAction[] = [];
  const granted: AuthorityAction[] = [];
  for (const action of sorted(requested)) {
    if (action === "execute") refused.push({ action, reason: AUTHORITY_TEXT.execute });
    else if (grant?.actions.has(action)) granted.push(action);
    else if (!max.has(action)) refused.push({ action, reason: AUTHORITY_TEXT.outside(role.agent, roleFor(action, roles)) });
    else if (fixed) refused.push({ action, reason: AUTHORITY_TEXT.fixed(role.agent) });
    else if (action === "router_run" && (grant?.workRoot ?? null) === null) refused.push({ action, reason: AUTHORITY_TEXT.noWorkRoot });
    else inside.push(action);
  }
  if (inside.length === 0) return done([], granted, false);
  const { requests } = state();
  const record = requests.get(childSessionID);
  const replay = record !== undefined && inside.every((a) => record.actions.has(a));
  if (!replay) {
    const next: RequestRecord = record ?? { actions: new Set(), reasons: [] };
    for (const action of inside) next.actions.add(action);
    const reason = cleanReason(input.reason);
    if (reason !== "" && !next.reasons.includes(reason) && next.reasons.length < REASONS_MAX) next.reasons.push(reason);
    requests.delete(childSessionID);
    requests.set(childSessionID, next);
    for (const oldest of requests.keys()) {
      if (requests.size <= AUTHORITY_REQUESTS_MAX) break;
      requests.delete(oldest);
    }
  }
  return done(inside, granted, replay);
}

/** The child's recorded, unconsumed request (for the parent's annotation), or undefined. */
export function requestedAuthority(childSessionID: string): { actions: readonly AuthorityAction[]; reasons: readonly string[] } | undefined {
  const record = state().requests.get(childSessionID);
  return record ? { actions: sorted(record.actions), reasons: [...record.reasons] } : undefined;
}

/**
 * Resume path (P2.1, `execute.before` of a resume of `childSessionID`): applies the recorded actions ∩ the
 * current role max to the child's binding and clears the record. Undefined when nothing is recorded, when the
 * child is no longer a dynamic role (record dropped) or when it is not bound yet (record kept: bind first).
 */
export function consumeAuthority(childSessionID: string, deps: AuthorityDeps):
  { grant: DispatchGrant; widened: readonly AuthorityAction[] } | undefined {
  const { requests } = state();
  const record = requests.get(childSessionID);
  if (record === undefined) return undefined;
  const role = deps.roleOf(childSessionID);
  if (role === undefined || role.authority.mode === "fixed") {
    requests.delete(childSessionID);
    return undefined;
  }
  const binding = (deps.bindingOf ?? currentBinding)(childSessionID);
  if (binding === undefined) return undefined;
  const max = roleMax(role);
  const actions = sorted(record.actions).filter((a) => max.has(a));
  const grant = (deps.widen ?? widenBinding)(childSessionID, actions, max);
  requests.delete(childSessionID);
  return { grant, widened: sorted(grant.actions).filter((a) => !binding.grant.actions.has(a)) };
}

/** Drops a session's authority state (`session.deleted`). */
export function evictAuthority(sessionID: string): void {
  state().requests.delete(sessionID);
}

/** Test only: empties the process-wide authority state. */
export function resetAuthorityForTests(): void {
  state().requests.clear();
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
}

/**
 * The `router_request_authority` tool. The child is the calling session (`context.sessionID`). Never throws
 * into the session: invalid arguments and dependency errors are reported, nothing is recorded.
 */
export function authorityTool(deps: AuthorityDeps) {
  const inputSchema = tool.schema.object({
    actions: tool.schema.array(tool.schema.string().min(1).max(64)).min(1).max(16),
    reason: tool.schema.string().min(1).max(2000),
  }).strict();
  return tool({
    description: "Ask for an action your role may use but this dispatch was not granted (for example `edit` or `router_run`). "
      + "If your role allows it, the request is recorded and you must stop and return `ESCALATE: authority`; the parent resumes you with the wider grant. "
      + "Otherwise the reply names the role to use. Never repeat a refused request.",
    args: {
      actions: tool.schema.array(tool.schema.string()).describe(`Actions needed: ${REQUESTABLE}`),
      reason: tool.schema.string().describe("Why the task needs them, in one or two sentences"),
    },
    async execute(input, context) {
      try {
        return requestAuthority(context.sessionID, inputSchema.parse(input), deps).text;
      } catch (error) {
        return `[${AUTHORITY_TOOL_NAME}] error: ${errorText(error)}`;
      }
    },
  });
}
