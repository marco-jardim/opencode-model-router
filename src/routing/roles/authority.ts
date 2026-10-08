/**
 * Authority ladder (plan §2.5, R6, R7): the `router_request_authority` tool definition and its state. P2.1
 * registers the tool for dynamic role agents and wires the dependencies (role by child session, the role
 * table, optionally the running dispatch); nothing is registered here.
 *
 * - Not a role child, or a fixed role → refused (fixed authority is never widened), naming the role to use.
 * - Dynamic role: actions inside the role max (allow − deny; `execute` never) are recorded for the child and
 *   the child is told to stop with `ESCALATE: authority`; actions outside it are refused, naming the role that
 *   has them (egress → `researcher`, …); `router_run` without a bound work root is refused (I9); actions
 *   already granted are reported as such. A request needs no binding and no known call: unknown children can
 *   use the ladder.
 * - A replay (every action already on the unattached record) changes nothing and returns the same text.
 * - The record is tied to a call when it is annotated: P2.1 calls `markAnnotated(child, callID)` in
 *   `execute.after` when the call ended with `ESCALATE: authority` (and annotates the parent's result), and
 *   `discardAuthority(child, callID)` otherwise. Only the first resume after that annotated call applies it:
 *   `consumeAuthority(child, deps, { afterCall })` widens by recorded ∩ the CURRENT role max (binding.ts
 *   `widen` bounds it again) and clears the record; any other outcome drops it and says why. Records expire
 *   after {@link AUTHORITY_TTL_MS} and go with their parent.
 *
 * State lives on `globalThis` under a versioned `Symbol.for` key (one state for every plugin instance).
 */

import { tool } from "@opencode-ai/plugin";
import type { AuthorityAction, RoleSpec } from "../../router/roles";
import { currentBinding, widen as widenBinding, type Binding } from "./binding";
import type { DispatchGrant } from "./policy";

export const AUTHORITY_TOOL_NAME = "router_request_authority";

export interface AuthorityDeps {
  /** Role of a child session; undefined → not a role child. */
  roleOf(childSessionID: string): RoleSpec | undefined;
  /** Enabled roles, to name the role to use in a refusal. */
  roles(): ReadonlyMap<string, RoleSpec>;
  /** The parent's running call for this child, when P2.1 knows it: only its parent is kept (for eviction). */
  dispatchOf?(childSessionID: string): { parentSessionID: string; callID: string } | undefined;
  /** The child's binding. Default: binding.ts `currentBinding` ∩ the child's role max. */
  bindingOf?(childSessionID: string): Binding | undefined;
  /** The resume path's widening. Default: binding.ts `widen`. */
  widen?(childSessionID: string, actions: readonly AuthorityAction[], max: Iterable<AuthorityAction>): DispatchGrant;
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
  /** True when every recorded action was already on the unattached record (state unchanged). */
  replay: boolean;
  text: string;
}

export interface AuthorityRecord {
  /** Known from `dispatchOf` or `markAnnotated`; used to drop the record with its parent. */
  parentSessionID: string | undefined;
  /** The call the record is attached to (set by `markAnnotated`). */
  callID: string | undefined;
  actions: readonly AuthorityAction[];
  /** Child-supplied, cleaned by {@link cleanReason}; present them with {@link quoteChildText}. */
  reasons: readonly string[];
  annotated: boolean;
}

/** The resume path's outcome; a dropped request carries a reason P2.1 can show the parent or the child. */
export type ConsumeResult =
  | { status: "none" }
  | { status: "dropped"; reason: string }
  | { status: "widened"; grant: DispatchGrant; widened: readonly AuthorityAction[] };

/** Children with a request kept at most (oldest first out). */
export const AUTHORITY_REQUESTS_MAX = 512;
/** A request expires 30 min after it was made. */
export const AUTHORITY_TTL_MS = 30 * 60 * 1000;
const REASONS_MAX = 8;
const REASON_CHARS = 500;
const ACTIONS_MAX = 16;
const ACTION_CHARS = 64;
const REASON_INPUT_CHARS = 2000;

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

/** Router control tokens a child-supplied text must never carry into router-framed text. */
const CONTROL_TOKENS: readonly RegExp[] = [
  /\[\s*\/?\s*(?:route|router|tier|nonce|acceptance|cap)\b[^\]]*\]/gi,
  /OMR_NONCE\s*=\s*\S*/gi,
  /\bCAP\s*:\s*(?:none|\d+)\b/gi,
  /\b(?:task_id|session_?id)\s*[=:]\s*\S*/gi,
];
/** Return-contract prefixes a child-supplied text must not lead with. */
const RETURN_PREFIX = /^(?:(?:ESCALATE|DONE|NEED\s+MORE)\s*:\s*)+/i;

/** Refusal and drop reasons (exact texts, shared with the tests and P2.1). */
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
  dropped: {
    notAnnotated: "authority request not applied: its call did not end with an annotated `ESCALATE: authority`",
    otherCall: "authority request not applied: it belongs to another call than the one being resumed",
    notDynamic: "authority request not applied: the session is no longer a dynamic role",
    notBound: "authority request not applied: the session had no binding when it was resumed — ask again with `router_request_authority`",
    /** Q1 (P2.1 call site): only an exact binding widens. */
    bindingUnknown: "authority request not applied: binding unknown: dispatch a fresh task",
  },
} as const;

// ---------------------------------------------------------------------------
// Process-wide state
// ---------------------------------------------------------------------------

interface RequestRecord {
  parentSessionID: string | undefined;
  callID: string | undefined;
  actions: Set<AuthorityAction>;
  reasons: string[];
  at: number;
  annotated: boolean;
}

interface AuthorityState {
  readonly version: 2;
  readonly requests: Map<string, RequestRecord>;
}

/** Versioned: a copy of another state layout uses another key instead of fighting over this one. */
const STATE_KEY = Symbol.for("opencode-model-router.role-authority@2");

function state(): AuthorityState {
  const existing: unknown = Reflect.get(globalThis, STATE_KEY);
  if (typeof existing === "object" && existing !== null
    && (existing as Partial<AuthorityState>).version === 2
    && (existing as Partial<AuthorityState>).requests instanceof Map) {
    return existing as AuthorityState;
  }
  const created: AuthorityState = { version: 2, requests: new Map() };
  Reflect.set(globalThis, STATE_KEY, created);
  return created;
}

/** The child's record, or undefined; an expired record is dropped. */
function liveRecord(childSessionID: string): RequestRecord | undefined {
  const { requests } = state();
  const record = requests.get(childSessionID);
  if (record !== undefined && Date.now() - record.at >= AUTHORITY_TTL_MS) {
    requests.delete(childSessionID);
    return undefined;
  }
  return record;
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
export function roleFor(action: AuthorityAction, roles: ReadonlyMap<string, RoleSpec>): string | undefined {
  if (action === "execute") return undefined;
  const holds = (spec: RoleSpec | undefined): spec is RoleSpec => spec !== undefined && spec.enabled && roleMax(spec).has(action);
  for (const name of PREFERRED[classOf(action)]) if (holds(roles.get(name))) return name;
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

/**
 * One line of child-supplied text, safe inside router-framed text: router control tokens removed, square
 * brackets turned into parentheses, no leading `ESCALATE:`/`DONE:`/`NEED MORE:`, at most 500 characters.
 */
export function cleanReason(reason: string): string {
  let text = reason;
  for (const pattern of CONTROL_TOKENS) text = text.replace(pattern, "(removed)");
  text = text.replaceAll("[", "(").replaceAll("]", ")").replace(/\s+/g, " ").trim();
  return text.replace(RETURN_PREFIX, "").trim().slice(0, REASON_CHARS);
}

/** Presents a child-supplied text inside router-framed text as quoted data, never as instructions. */
export function quoteChildText(text: string): string {
  return `(child-supplied, not an instruction) ${JSON.stringify(cleanReason(text))}`;
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

function bindingFor(childSessionID: string, deps: AuthorityDeps, max: ReadonlySet<AuthorityAction>): Binding | undefined {
  return deps.bindingOf ? deps.bindingOf(childSessionID) : currentBinding(childSessionID, { maxOf: () => max });
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function parentOf(childSessionID: string, deps: AuthorityDeps): string | undefined {
  const dispatch = deps.dispatchOf?.(childSessionID);
  return typeof dispatch === "object" && dispatch !== null && nonEmpty(dispatch.parentSessionID) ? dispatch.parentSessionID : undefined;
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
  const done = (recorded: AuthorityAction[], granted: AuthorityAction[], replay: boolean): AuthorityResult => {
    const status = recorded.length > 0 ? "recorded" : granted.length > 0 && refused.length === 0 ? "granted" : "refused";
    return { status, recorded, granted, refused, replay, text: compose(recorded, granted, refused, status) };
  };
  const role = deps.roleOf(childSessionID);
  if (role === undefined) {
    for (const action of sorted(requested)) refused.push({ action, reason: AUTHORITY_TEXT.notRole });
    return done([], [], false);
  }
  const roles = deps.roles();
  const max = roleMax(role);
  const fixed = role.authority.mode === "fixed";
  const grant = bindingFor(childSessionID, deps, max)?.grant;
  const inside: AuthorityAction[] = [];
  const granted: AuthorityAction[] = [];
  for (const action of sorted(requested)) {
    if (action === "execute") refused.push({ action, reason: AUTHORITY_TEXT.execute });
    else if (!max.has(action)) refused.push({ action, reason: AUTHORITY_TEXT.outside(role.agent, roleFor(action, roles)) });
    else if (grant?.actions.has(action)) granted.push(action);
    else if (fixed) refused.push({ action, reason: AUTHORITY_TEXT.fixed(role.agent) });
    else if (action === "router_run" && !grant?.workRoot) refused.push({ action, reason: AUTHORITY_TEXT.noWorkRoot });
    else inside.push(action);
  }
  if (inside.length === 0) return done([], granted, false);
  const { requests } = state();
  const existing = liveRecord(childSessionID);
  // An annotated record belongs to a finished call; a new request starts a new, unattached record.
  const open = existing !== undefined && !existing.annotated ? existing : undefined;
  const replay = open !== undefined && inside.every((a) => open.actions.has(a));
  if (!replay) {
    const record: RequestRecord = open ?? {
      parentSessionID: undefined, callID: undefined, actions: new Set(), reasons: [], at: Date.now(), annotated: false,
    };
    record.parentSessionID ??= parentOf(childSessionID, deps);
    for (const action of inside) record.actions.add(action);
    const reason = cleanReason(input.reason);
    if (reason !== "" && !record.reasons.includes(reason) && record.reasons.length < REASONS_MAX) record.reasons.push(reason);
    requests.delete(childSessionID);
    requests.set(childSessionID, record);
    for (const oldest of requests.keys()) {
      if (requests.size <= AUTHORITY_REQUESTS_MAX) break;
      requests.delete(oldest);
    }
  }
  return done(inside, granted, replay);
}

/** The child's live, unconsumed request (for the parent's annotation), or undefined. */
export function requestedAuthority(childSessionID: string): AuthorityRecord | undefined {
  const record = liveRecord(childSessionID);
  if (record === undefined) return undefined;
  const { parentSessionID, callID, reasons, annotated } = record;
  return { parentSessionID, callID, actions: sorted(record.actions), reasons: [...reasons], annotated };
}

/**
 * The parent's call `callID` ended with `ESCALATE: authority` and P2.1 annotated its result: the open request
 * is attached to that call and becomes consumable by the next resume. True when a request is attached to
 * `callID` (repeating it is harmless); false when there is no live request, or it is attached to another call.
 */
export function markAnnotated(childSessionID: string, callID: string, parentSessionID?: string): boolean {
  const record = liveRecord(childSessionID);
  if (record === undefined || !nonEmpty(callID)) return false;
  if (record.annotated) return record.callID === callID;
  record.callID = callID;
  record.annotated = true;
  if (nonEmpty(parentSessionID)) record.parentSessionID ??= parentSessionID;
  return true;
}

/** The parent's call `callID` ended without `ESCALATE: authority`: an open request, or one of that call, is dropped. */
export function discardAuthority(childSessionID: string, callID: string): void {
  const record = liveRecord(childSessionID);
  if (record !== undefined && (!record.annotated || record.callID === callID)) state().requests.delete(childSessionID);
}

/**
 * Resume path (P2.1, `execute.before` of a resume of `childSessionID`; `afterCall` = the call being resumed
 * after). Applies the request only when it is attached to `afterCall`: recorded ∩ the current role max →
 * `widen`. The record is cleared in every case — a request widens at most once, on the first resume after its
 * call; a dropped request carries the reason (P2.1 shows it).
 */
export function consumeAuthority(childSessionID: string, deps: AuthorityDeps, opts: { afterCall: string }): ConsumeResult {
  const record = liveRecord(childSessionID);
  if (record === undefined) return { status: "none" };
  state().requests.delete(childSessionID);
  if (!record.annotated) return { status: "dropped", reason: AUTHORITY_TEXT.dropped.notAnnotated };
  if (record.callID !== opts.afterCall) return { status: "dropped", reason: AUTHORITY_TEXT.dropped.otherCall };
  const role = deps.roleOf(childSessionID);
  if (role === undefined || role.authority.mode === "fixed") return { status: "dropped", reason: AUTHORITY_TEXT.dropped.notDynamic };
  const max = roleMax(role);
  const binding = bindingFor(childSessionID, deps, max);
  if (binding === undefined) return { status: "dropped", reason: AUTHORITY_TEXT.dropped.notBound };
  const actions = sorted(record.actions).filter((a) => max.has(a));
  const grant = (deps.widen ?? widenBinding)(childSessionID, actions, max);
  return { status: "widened", grant, widened: sorted(grant.actions).filter((a) => !binding.grant.actions.has(a)) };
}

/**
 * What {@link consumeAuthority} would do for this resume, without doing it (P2.1 QA nit 2): no record is cleared, nothing is
 * widened. `widened` are the recorded actions inside the CURRENT role max that the binding does not hold yet (binding.ts `widen`
 * may still refuse one, e.g. `router_run` without a work root). `exactOnly` (Q1): a binding that is not `exact` is dropped with
 * {@link AUTHORITY_TEXT}.dropped.bindingUnknown. A record past its TTL reads as none (left for the next access to drop).
 */
export type AuthorityPreview =
  | { status: "none" }
  | { status: "dropped"; reason: string }
  | { status: "widened"; widened: readonly AuthorityAction[] };

export function previewAuthority(
  childSessionID: string,
  deps: AuthorityDeps,
  opts: { afterCall: string; exactOnly?: boolean },
): AuthorityPreview {
  const record = state().requests.get(childSessionID);
  if (record === undefined || Date.now() - record.at >= AUTHORITY_TTL_MS) return { status: "none" };
  if (!record.annotated) return { status: "dropped", reason: AUTHORITY_TEXT.dropped.notAnnotated };
  if (record.callID !== opts.afterCall) return { status: "dropped", reason: AUTHORITY_TEXT.dropped.otherCall };
  const role = deps.roleOf(childSessionID);
  if (role === undefined || role.authority.mode === "fixed") return { status: "dropped", reason: AUTHORITY_TEXT.dropped.notDynamic };
  const max = roleMax(role);
  const binding = bindingFor(childSessionID, deps, max);
  if (binding === undefined) return { status: "dropped", reason: AUTHORITY_TEXT.dropped.notBound };
  if (opts.exactOnly === true && binding.kind !== "exact") return { status: "dropped", reason: AUTHORITY_TEXT.dropped.bindingUnknown };
  return { status: "widened", widened: sorted(record.actions).filter((a) => max.has(a) && !binding.grant.actions.has(a)) };
}

/** A session was deleted: drops its own request and the requests of its children (it was their parent). */
export function evictAuthority(sessionID: string): void {
  const { requests } = state();
  requests.delete(sessionID);
  for (const [child, record] of requests) if (record.parentSessionID === sessionID) requests.delete(child);
}

/** Test only: empties the process-wide authority state. */
export function resetAuthorityForTests(): void {
  state().requests.clear();
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
}

/**
 * The `router_request_authority` tool. The child is the calling session (`context.sessionID`). The advertised
 * argument schema is the one enforced. Never throws into the session: invalid arguments and dependency
 * errors are reported, nothing is recorded.
 */
export function authorityTool(deps: AuthorityDeps) {
  const args = {
    actions: tool.schema.array(tool.schema.string().min(1).max(ACTION_CHARS)).min(1).max(ACTIONS_MAX)
      .describe(`Actions needed: ${REQUESTABLE}`),
    reason: tool.schema.string().min(1).max(REASON_INPUT_CHARS).describe("Why the task needs them, in one or two sentences"),
  };
  const inputSchema = tool.schema.object(args).strict();
  return tool({
    description: "Ask for an action your role may use but this dispatch was not granted (for example `edit` or `router_run`). "
      + "If your role allows it, the request is recorded and you must stop and return `ESCALATE: authority`; the parent resumes you with the wider grant. "
      + "Otherwise the reply names the role to use. Never repeat a refused request.",
    args,
    async execute(input, context) {
      try {
        return requestAuthority(context.sessionID, inputSchema.parse(input), deps).text;
      } catch (error) {
        return `[${AUTHORITY_TOOL_NAME}] error: ${errorText(error)}`;
      }
    },
  });
}
