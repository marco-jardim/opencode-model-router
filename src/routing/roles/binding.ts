/**
 * Child-session binding (plan §2.4, §2.5; spikes S2, amendments P-2 and R7; invariants I5, I9).
 *
 * A role dispatch registers a pending entry in `execute.before` (keyed by parent session + callID) with a
 * router-generated nonce ({@link newDispatchNonce}); P2.1 appends {@link nonceTitleSuffix} to the `subagent`
 * description and {@link noncePromptLine} as the LAST line of its prompt. The child session binds lazily, at its
 * first context hook (or permission evaluation), from `session.get(child)`: parentID, agent, title, first
 * message.
 *
 * Decision (one per child, process-wide; R7: no nonce → unknown):
 * - no parentID/agent, or a failed lookup → unknown, not cached (the next hook retries);
 * - markers are read only at their anchors: the title's trailing ` [nonce <n>]` suffix and the prompt's last
 *   non-empty line `OMR_NONCE=<n>` (quoted marker syntax anywhere else is plain text). Both present and
 *   different → unknown; none → unknown;
 * - the nonce names a live entry of the child's parent and agent that no other child has claimed → exact (the
 *   entry is claimed: one dispatch binds at most one child); a retired, unregistered, foreign or claimed nonce →
 *   unknown. Two identical parallel dispatches therefore each bind exactly by their own nonce.
 * Every caller sees the decision ∩ its own role max (`maxOf(agent)`, required), then the separation rule (I4:
 * egress dropped when mixed) and the work-root rule (I9: no `router_run` without an absolute work root). An
 * unknown binding is max ∩ local, whatever `policy.grantFor` would give. Never a union. The `intersection` kind
 * stays in the contract but is never produced under R7.
 *
 * Lifetimes: a pending entry lives until `evictCall(parent, callID)` (the parent's call completed,
 * `execute.after`), at most {@link PENDING_TTL_MS} (checked on access) and {@link PENDING_MAX} entries (oldest
 * evicted). Nonces of removed entries stay retired for the TTL and are never reused. A decision is cached per
 * child until `evict(childSessionID)` or `evict(parentSessionID)` (`session.deleted`; deleted sessions are
 * tombstoned for the TTL, so an in-flight lookup never stores a binding to them), LRU-bounded by
 * {@link BOUND_MAX}; a resume returns the cached binding with its widened grant.
 *
 * Residual (accepted): a child that lost both own markers but whose anchors carry a live, unclaimed sibling's nonce binds to it (unguessable UUID).
 *
 * State lives on `globalThis` under a versioned `Symbol.for` key, so every copy of this module in the process
 * (two plugin instances) shares one registry and one decision per child; a foreign value there is replaced.
 */

import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { AuthorityAction } from "../../router/roles";
import { GRANT_NOTES, type DispatchGrant } from "./policy";

export interface PendingDispatch {
  parentSessionID: string;
  callID: string;
  agent: string;
  description: string;
  /** Router-generated per-dispatch nonce ({@link newDispatchNonce}): 16–128 of `A-Z a-z 0-9 _ -`, else refused. */
  nonce: string;
  grant: DispatchGrant;
  /** Call budget of the dispatch: finite and > 0, otherwise the entry is refused. */
  budget: number;
  decisionID: string | null;
  registeredAt: number;
}

export type SessionLookup = (
  id: string,
) => Promise<{ parentID?: string; agent?: string; title?: string; firstText?: string } | undefined>;

export interface Binding {
  childSessionID: string;
  /** `intersection` is part of the contract but never produced under R7 (ambiguity → unknown). */
  kind: "exact" | "intersection" | "unknown";
  grant: DispatchGrant;
  /** callIDs of the pending dispatches that matched. */
  candidates: readonly string[];
  decisionID: string | null;
  /** Call budget of the matched dispatch. null (unknown binding) means the role's default budget — never unlimited. */
  budget: number | null;
}

export interface BindOptions {
  /**
   * The role max (allow − deny) of an agent. Every grant is intersected with it; `execute` is never part of
   * it. Undefined, a throw, or a missing option → no action at all (fail closed).
   */
  maxOf(agent: string): Iterable<AuthorityAction> | undefined;
}

/** Pending entries live at most 30 min (§2.5); retired nonces and deleted sessions are remembered as long. */
export const PENDING_TTL_MS = 30 * 60 * 1000;
/** Pending entries kept at most; the oldest is evicted first. */
export const PENDING_MAX = 512;
/** Bound children kept at most (least recently used evicted first). */
export const BOUND_MAX = 4096;
const RETIRED_MAX = 1024;
const DELETED_MAX = 4096;

/** A valid dispatch nonce. */
export const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
/** The title marker: only a trailing suffix counts. */
const TITLE_MARKER = / \[nonce ([A-Za-z0-9_-]{16,128})\]$/;
/** The prompt marker: only the whole last non-empty line counts. */
const PROMPT_MARKER = /^OMR_NONCE=([A-Za-z0-9_-]{16,128})$/;

/** The local action class (§2.2). */
export const LOCAL_ACTIONS: readonly AuthorityAction[] = Object.freeze(["read", "glob", "grep", "router_git"]);
const EGRESS: ReadonlySet<AuthorityAction> = new Set<AuthorityAction>(["webfetch", "websearch", "context7", "execute"]);
/** Canonical order; anything else in a grant is dropped (an unknown name never grants). */
const ACTION_ORDER: readonly AuthorityAction[] = [
  "read", "glob", "grep", "router_git", "router_run", "edit", "webfetch", "websearch", "context7", "execute",
];
const NO_ACTIONS: ReadonlySet<AuthorityAction> = new Set<AuthorityAction>();

/** Notes a binding can carry (exact texts, shared with the runtime and the tests). */
export const BINDING_NOTES = {
  unknown:
    // QA-G-A1-4 (R8(4)): a request from an unknown binding is dropped on resume, so the note never points at the ladder.
    "binding unknown: this session could not be matched to its dispatch; local actions only, no work root, no router_run — authority is not widened for it: dispatch a fresh task",
  lookupFailed: "binding unknown: session lookup failed",
  noParent: "binding unknown: the session lookup reported no parent or agent",
  noNonce: "binding unknown: this session carries no dispatch nonce",
  foreignNonce: "binding unknown: the dispatch named by this session's nonce is not pending for its parent and agent",
  markers: "binding unknown: the session's title and first message name different dispatch nonces",
  claimed: "binding unknown: the dispatch named by this session's nonce is already bound to another session",
  beyondMax: (actions: readonly AuthorityAction[]): string => `outside the role max, dropped: ${actions.join(", ")}`,
  noWorkRoot: "router_run and edit need a bound work root (root=) — not granted",
  separation: GRANT_NOTES.separation,
  widened: (actions: readonly AuthorityAction[]): string => `authority widened on resume: ${actions.join(", ")}`,
  notBound: "no binding for this session: nothing widened",
} as const;

/** A fresh, unguessable per-dispatch nonce (never a provider tool-call id); matches {@link NONCE_PATTERN}. */
export function newDispatchNonce(): string {
  return randomUUID();
}

/** Title suffix carrying a dispatch nonce (P-2); P2.1 appends it to the `subagent` description. */
export function nonceTitleSuffix(nonce: string): string {
  return ` [nonce ${nonce}]`;
}

/** Prompt line carrying a dispatch nonce (P-2); P2.1 appends it as the LAST line of the `subagent` prompt. */
export function noncePromptLine(nonce: string): string {
  return `OMR_NONCE=${nonce}`;
}

// ---------------------------------------------------------------------------
// Process-wide registry
// ---------------------------------------------------------------------------

interface PendingSlot {
  entry: PendingDispatch;
  /** Start of the TTL: the entry's registeredAt, never later than the moment it was stored. */
  start: number;
  /** The child bound exactly to this dispatch. */
  claimedBy: string | undefined;
}

interface BoundSlot {
  binding: Binding;
  parentSessionID: string | undefined;
  agent: string | undefined;
}

/** A cacheable decision always knows the child's parent and agent; a retryable one may not. */
type Decision =
  | { binding: Binding; parentSessionID: string; agent: string; cacheable: true }
  | { binding: Binding; parentSessionID: string | undefined; agent: string | undefined; cacheable: false };

interface Inflight {
  promise: Promise<Decision>;
  token: object;
}

interface Registry {
  readonly version: 2;
  readonly pending: Map<string, PendingSlot>;
  readonly bound: Map<string, BoundSlot>;
  readonly inflight: Map<string, Inflight>;
  /** nonce → retiredAt */
  readonly retired: Map<string, number>;
  /** deleted session → deletedAt */
  readonly deleted: Map<string, number>;
}

/** Versioned: a copy of another registry layout uses another key instead of fighting over this one. */
const REGISTRY_KEY = Symbol.for("opencode-model-router.role-binding@2");

function isRegistry(value: unknown): value is Registry {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Partial<Registry>;
  return r.version === 2 && r.pending instanceof Map && r.bound instanceof Map
    && r.inflight instanceof Map && r.retired instanceof Map && r.deleted instanceof Map;
}

function registry(): Registry {
  const existing: unknown = Reflect.get(globalThis, REGISTRY_KEY);
  if (isRegistry(existing)) return existing;
  const created: Registry = {
    version: 2, pending: new Map(), bound: new Map(), inflight: new Map(), retired: new Map(), deleted: new Map(),
  };
  Reflect.set(globalThis, REGISTRY_KEY, created);
  return created;
}

function pendingKey(parentSessionID: string, callID: string): string {
  return JSON.stringify([parentSessionID, callID]);
}

/** Inserts at the newest position and drops the oldest entries beyond `max`. */
function remember<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  for (const oldest of map.keys()) {
    if (map.size <= max) break;
    map.delete(oldest);
  }
}

function removePending(reg: Registry, key: string, slot: PendingSlot, now: number): void {
  reg.pending.delete(key);
  remember(reg.retired, slot.entry.nonce, now, RETIRED_MAX);
}

/** Drops expired pending entries (their nonces retire), expired retired nonces and deleted-session tombstones. */
function prune(reg: Registry, now: number): void {
  for (const [key, slot] of reg.pending) if (now - slot.start >= PENDING_TTL_MS) removePending(reg, key, slot, now);
  for (const [nonce, at] of reg.retired) if (now - at >= PENDING_TTL_MS) reg.retired.delete(nonce);
  for (const [id, at] of reg.deleted) if (now - at >= PENDING_TTL_MS) reg.deleted.delete(id);
}

function isDeleted(reg: Registry, id: string, now: number): boolean {
  const at = reg.deleted.get(id);
  return at !== undefined && now - at < PENDING_TTL_MS;
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

function ordered(actions: Iterable<AuthorityAction>): Set<AuthorityAction> {
  const have = new Set<AuthorityAction>(actions);
  return new Set(ACTION_ORDER.filter((a) => have.has(a)));
}

/** An absolute work root, or null (undefined, "", relative or NUL-carrying roots never grant). */
function rootOrNull(root: unknown): string | null {
  return typeof root === "string" && root !== "" && !root.includes("\0") && isAbsolute(root) ? root : null;
}

/** The role max of `agent` from the caller's options: never `execute`; anything invalid → nothing. */
function maxFor(opts: BindOptions | undefined, agent: string | undefined): ReadonlySet<AuthorityAction> {
  if (agent === undefined || typeof opts?.maxOf !== "function") return NO_ACTIONS;
  try {
    const max = opts.maxOf(agent);
    if (max === undefined || max === null) return NO_ACTIONS;
    const set = ordered(max);
    set.delete("execute");
    return set;
  } catch {
    return NO_ACTIONS;
  }
}

/** ∩ max first, then the separation rule, then the work-root rule. Only removes. */
function restrict(
  actions: Iterable<AuthorityAction>,
  notes: readonly string[],
  workRoot: unknown,
  max: ReadonlySet<AuthorityAction>,
  reportBeyond = true,
): DispatchGrant {
  const all = ordered(actions);
  const kept = new Set([...all].filter((a) => max.has(a)));
  const root = rootOrNull(workRoot);
  const extra: string[] = [];
  const beyond = [...all].filter((a) => !max.has(a));
  if (beyond.length > 0 && reportBeyond) extra.push(BINDING_NOTES.beyondMax(beyond));
  const list = [...kept];
  if (list.some((a) => EGRESS.has(a)) && list.some((a) => !EGRESS.has(a))) {
    for (const a of EGRESS) kept.delete(a);
    extra.push(BINDING_NOTES.separation);
  }
  if (root === null && kept.delete("router_run")) extra.push(BINDING_NOTES.noWorkRoot);
  return { actions: kept, notes: [...new Set([...notes, ...extra])], workRoot: root };
}

function copyGrant(grant: DispatchGrant): DispatchGrant {
  return { actions: ordered(grant.actions), notes: [...grant.notes], workRoot: grant.workRoot };
}

/**
 * A caller's view of a stored decision. Decisions are stored unrestricted (only the work root is coerced at
 * registration), so no caller's max ever shapes another caller's view: each view is the decision ∩ the
 * caller's own max, then the separation and work-root rules.
 */
function view(binding: Binding, max: ReadonlySet<AuthorityAction>): Binding {
  const { actions, notes, workRoot } = binding.grant;
  return {
    ...binding,
    grant: restrict(actions, notes, workRoot, max, binding.kind !== "unknown"),
    candidates: [...binding.candidates],
  };
}

function exact(childSessionID: string, entry: PendingDispatch): Binding {
  return {
    childSessionID, kind: "exact", grant: copyGrant(entry.grant),
    candidates: [entry.callID], decisionID: entry.decisionID, budget: entry.budget,
  };
}

/** Unknown: the local class, narrowed by every view to max ∩ local (I9) — never derived from a dispatch grant. */
function unknown(childSessionID: string, cause: string): Binding {
  return {
    childSessionID,
    kind: "unknown",
    grant: { actions: ordered(LOCAL_ACTIONS), notes: [BINDING_NOTES.unknown, cause], workRoot: null },
    candidates: [],
    decisionID: null,
    budget: null,
  };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function titleNonce(title: unknown): string | undefined {
  return typeof title === "string" ? TITLE_MARKER.exec(title.trimEnd())?.[1] : undefined;
}

function promptNonce(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const last = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "").pop();
  return last === undefined ? undefined : PROMPT_MARKER.exec(last)?.[1];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The unrestricted decision; callers only ever see it through {@link view}. */
async function decide(childSessionID: string, getSession: SessionLookup): Promise<Decision> {
  let session: Awaited<ReturnType<SessionLookup>>;
  try {
    session = await getSession(childSessionID);
  } catch {
    session = undefined;
  }
  if (typeof session !== "object" || session === null) {
    return { binding: unknown(childSessionID, BINDING_NOTES.lookupFailed), parentSessionID: undefined, agent: undefined, cacheable: false };
  }
  const parent = text(session.parentID);
  const agent = text(session.agent);
  if (parent === undefined || agent === undefined) {
    return { binding: unknown(childSessionID, BINDING_NOTES.noParent), parentSessionID: parent, agent, cacheable: false };
  }
  const out = (binding: Binding): Decision => ({ binding, parentSessionID: parent, agent, cacheable: true });
  const fromTitle = titleNonce(session.title);
  const fromPrompt = promptNonce(session.firstText);
  if (fromTitle !== undefined && fromPrompt !== undefined && fromTitle !== fromPrompt) {
    return out(unknown(childSessionID, BINDING_NOTES.markers));
  }
  const nonce = fromPrompt ?? fromTitle;
  if (nonce === undefined) return out(unknown(childSessionID, BINDING_NOTES.noNonce));
  const reg = registry();
  prune(reg, Date.now());
  // Live nonces are unique and never retired (registerPending refuses both), so a retired, unregistered or
  // forged nonce finds no slot.
  const slot = [...reg.pending.values()].find((s) => s.entry.nonce === nonce);
  if (slot === undefined || slot.entry.parentSessionID !== parent || slot.entry.agent !== agent) {
    return out(unknown(childSessionID, BINDING_NOTES.foreignNonce));
  }
  if (slot.claimedBy !== undefined && slot.claimedBy !== childSessionID) {
    return out(unknown(childSessionID, BINDING_NOTES.claimed));
  }
  slot.claimedBy = childSessionID;
  return out(exact(childSessionID, slot.entry));
}

function validEntry(entry: PendingDispatch): boolean {
  return typeof entry === "object" && entry !== null && text(entry.parentSessionID) !== undefined
    && text(entry.callID) !== undefined && text(entry.agent) !== undefined
    && typeof entry.nonce === "string" && NONCE_PATTERN.test(entry.nonce)
    && typeof entry.grant === "object" && entry.grant !== null && entry.grant.actions instanceof Set
    && typeof entry.budget === "number" && Number.isFinite(entry.budget) && entry.budget > 0;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * Registers a dispatch, keyed by parent + callID. Refused (no-op): invalid entries (empty ids, a nonce outside
 * {@link NONCE_PATTERN}, a non-Set grant, a budget that is not finite and > 0), a deleted parent, a retired
 * nonce, a nonce another live dispatch holds, an entry already older than the TTL. The grant is copied (a later
 * mutation cannot widen it) and a work root that is not an absolute path becomes null. Re-registering a key
 * replaces the entry; a changed nonce retires the old one and resets the claim.
 */
export function registerPending(entry: PendingDispatch): void {
  if (!validEntry(entry)) return;
  const reg = registry();
  const now = Date.now();
  prune(reg, now);
  const key = pendingKey(entry.parentSessionID, entry.callID);
  const previous = reg.pending.get(key);
  if (isDeleted(reg, entry.parentSessionID, now) || reg.retired.has(entry.nonce)) return;
  if ([...reg.pending].some(([k, s]) => k !== key && s.entry.nonce === entry.nonce)) return;
  const start = Number.isFinite(entry.registeredAt) ? Math.min(entry.registeredAt, now) : now;
  if (now - start >= PENDING_TTL_MS) {
    remember(reg.retired, entry.nonce, now, RETIRED_MAX);
    return;
  }
  const keepClaim = previous !== undefined && previous.entry.nonce === entry.nonce;
  if (previous !== undefined && !keepClaim) remember(reg.retired, previous.entry.nonce, now, RETIRED_MAX);
  const grant: DispatchGrant = { ...copyGrant(entry.grant), workRoot: rootOrNull(entry.grant.workRoot) };
  const stored: PendingDispatch = Object.freeze({ ...entry, grant });
  remember(reg.pending, key, { entry: stored, start, claimedBy: keepClaim ? previous.claimedBy : undefined }, Infinity);
  for (const [oldestKey, oldest] of reg.pending) {
    if (reg.pending.size <= PENDING_MAX) break;
    removePending(reg, oldestKey, oldest, now);
  }
}

/**
 * Binds a child session to its dispatch (rules in the module comment) and returns the binding ∩ this
 * caller's max. One decision per child: a cached binding is returned as is (with any widening), and
 * concurrent calls — from any plugin instance — share one lookup and one decision. Never throws.
 */
export async function bind(childSessionID: string, getSession: SessionLookup, opts: BindOptions): Promise<Binding> {
  const reg = registry();
  const cached = reg.bound.get(childSessionID);
  if (cached) {
    remember(reg.bound, childSessionID, cached, BOUND_MAX);
    return view(cached.binding, maxFor(opts, cached.agent));
  }
  const running = reg.inflight.get(childSessionID);
  if (running) {
    const shared = await running.promise;
    return view(shared.binding, maxFor(opts, shared.agent));
  }
  const token = {};
  const promise = decide(childSessionID, getSession);
  reg.inflight.set(childSessionID, { promise, token });
  try {
    const decision = await promise;
    const latest = registry();
    const now = Date.now();
    // An evict() of the child or its parent while the lookup ran: the decision is returned, never stored.
    if (latest.inflight.get(childSessionID)?.token === token && decision.cacheable
      && !isDeleted(latest, childSessionID, now) && !isDeleted(latest, decision.parentSessionID, now)) {
      const { binding, parentSessionID, agent } = decision;
      remember(latest.bound, childSessionID, { binding, parentSessionID, agent }, BOUND_MAX);
    }
    return view(decision.binding, maxFor(opts, decision.agent));
  } finally {
    const latest = registry();
    if (latest.inflight.get(childSessionID)?.token === token) latest.inflight.delete(childSessionID);
  }
}

/** The cached binding of a child ∩ the caller's max, or undefined when it is not bound. No lookup. */
export function currentBinding(childSessionID: string, opts: BindOptions): Binding | undefined {
  const slot = registry().bound.get(childSessionID);
  return slot ? view(slot.binding, maxFor(opts, slot.agent)) : undefined;
}

/**
 * Widens the grant of a bound child (the authority ladder's resume path) and returns the new grant. The
 * stored grant is first narrowed to `max`, then only actions inside `max` are added: never `execute`,
 * `router_run` and `edit` only with a work root (QA-G-B-2), nothing across the separation rule. `max` undefined → nothing is added
 * and nothing stored; an unbound child gets an empty grant.
 */
export function widen(
  childSessionID: string,
  actions: readonly AuthorityAction[],
  max: Iterable<AuthorityAction>,
): DispatchGrant {
  const reg = registry();
  const slot = reg.bound.get(childSessionID);
  if (!slot) return { actions: new Set<AuthorityAction>(), notes: [BINDING_NOTES.notBound], workRoot: null };
  if (max === undefined || max === null) return copyGrant(slot.binding.grant);
  const allowed = ordered(max);
  allowed.delete("execute");
  const before = restrict(slot.binding.grant.actions, slot.binding.grant.notes, slot.binding.grant.workRoot, allowed);
  const next = new Set(before.actions);
  const notes = [...before.notes];
  const added: AuthorityAction[] = [];
  for (const action of ordered(actions)) {
    if (next.has(action) || !allowed.has(action)) continue;
    // QA-G-B-2 (R7 null-root contract, I3): no write and no run without a bound work root.
    if ((action === "router_run" || action === "edit") && before.workRoot === null) {
      notes.push(BINDING_NOTES.noWorkRoot);
      continue;
    }
    const egress = EGRESS.has(action);
    if ([...next].some((a) => EGRESS.has(a) !== egress)) {
      notes.push(BINDING_NOTES.separation);
      continue;
    }
    next.add(action);
    added.push(action);
  }
  if (added.length > 0) notes.push(BINDING_NOTES.widened(added));
  const grant: DispatchGrant = { actions: ordered(next), notes: [...new Set(notes)], workRoot: before.workRoot };
  remember(reg.bound, childSessionID, { ...slot, binding: { ...slot.binding, grant } }, BOUND_MAX);
  return copyGrant(grant);
}

/** The parent's `subagent` call completed (`execute.after`): drops that one pending entry; its nonce retires. */
export function evictCall(parentSessionID: string, callID: string): void {
  const reg = registry();
  const key = pendingKey(parentSessionID, callID);
  const slot = reg.pending.get(key);
  if (slot) removePending(reg, key, slot, Date.now());
}

/**
 * A session was deleted (`session.deleted`): drops its binding and in-flight decision, and — when it is a
 * parent — its pending entries (nonces retire) and its children's bindings. The id is tombstoned for the TTL,
 * so neither a running lookup nor a later registration can attach anything to it.
 */
export function evict(sessionID: string): void {
  const reg = registry();
  const now = Date.now();
  remember(reg.deleted, sessionID, now, DELETED_MAX);
  for (const [key, slot] of reg.pending) if (slot.entry.parentSessionID === sessionID) removePending(reg, key, slot, now);
  reg.bound.delete(sessionID);
  for (const [child, slot] of reg.bound) if (slot.parentSessionID === sessionID) reg.bound.delete(child);
  reg.inflight.delete(sessionID);
}

/** Sizes of the registry (observability and tests). */
export function bindingRegistrySize(): { pending: number; bound: number; retired: number; deleted: number } {
  const reg = registry();
  return { pending: reg.pending.size, bound: reg.bound.size, retired: reg.retired.size, deleted: reg.deleted.size };
}

/** Test only: forgets a child's cached decision as an LRU eviction would (no tombstone, claims kept). */
export function dropBindingCacheForTests(childSessionID: string): void {
  registry().bound.delete(childSessionID);
}

/** Test only: empties the process-wide registry. */
export function resetBindingRegistryForTests(): void {
  const reg = registry();
  reg.pending.clear();
  reg.bound.clear();
  reg.inflight.clear();
  reg.retired.clear();
  reg.deleted.clear();
}
