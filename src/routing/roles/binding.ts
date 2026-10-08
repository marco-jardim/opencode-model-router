/**
 * Child-session binding (plan §2.4, §2.5; spikes S2, amendments P-2 and R7; invariants I5, I9).
 *
 * A role dispatch registers a pending entry in `execute.before` (keyed by parent session + callID) with a
 * router-generated nonce ({@link newDispatchNonce}) that P2.1 writes into the child's description
 * ({@link nonceTitleSuffix}) and prompt ({@link noncePromptLine}). The child session binds lazily, at its first
 * context hook (or permission evaluation), from `session.get(child)`: parentID, agent, title, first message.
 *
 * Decision (one per child, process-wide; only marker nonces count, never bare tokens):
 * - no parentID/agent, or a failed lookup → unknown, not cached (the next hook retries);
 * - markers: the first message's markers are preferred, the title's are used when it has none; both present
 *   and different → unknown. Exactly one marked nonce, naming a live entry of the child's parent and agent
 *   that no other child has claimed → exact (the entry is claimed: one dispatch binds at most one child);
 *   intersection with them instead while live nonce-less entries of that parent and agent exist. Several,
 *   retired, foreign, unregistered or claimed markers → unknown;
 * - no marker: unknown when any live entry of the parent and agent carries a nonce; otherwise (nonce-less
 *   entries only) the entry this child claimed before → exact; one entry → exact and claimed (unknown when
 *   another child claimed it); several (claimed or not) → intersection; none → unknown.
 * Every grant is ∩ the role max (`maxOf(agent)`, required), then the separation rule (I4: egress dropped when
 * mixed) and the work-root rule (I9: no `router_run` without an absolute work root). Unknown = max ∩ local.
 * Never a union. Each caller's view is ∩ its own max, so no caller's options widen another caller's view.
 *
 * Lifetimes: a pending entry lives until `evictCall(parent, callID)` (the parent's call completed,
 * `execute.after`), at most {@link PENDING_TTL_MS} (checked on access) and {@link PENDING_MAX} entries (oldest
 * evicted). Nonces of removed entries stay retired for the TTL and are never reused. A decision is cached per
 * child until `evict(childSessionID)` or `evict(parentSessionID)` (`session.deleted`; deleted sessions are
 * tombstoned for the TTL, so an in-flight lookup never stores a binding to them), LRU-bounded by
 * {@link BOUND_MAX}; a resume returns the cached binding with its widened grant.
 *
 * Residual (documented, P2.1 obligation): the nonce-less counting path is safe only for a child deciding while
 * its own dispatch is pending; in roles mode every dispatch must carry a router nonce.
 *
 * State lives on `globalThis` under a `Symbol.for` key, so every copy of this module in the process (two
 * plugin instances) shares one registry and one decision per child; a foreign value there is replaced.
 */

import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { AuthorityAction } from "../../router/roles";
import type { DispatchGrant } from "./policy";

export interface PendingDispatch {
  parentSessionID: string;
  callID: string;
  agent: string;
  description: string;
  /** Router-generated per-dispatch nonce ({@link newDispatchNonce}); "" only for the nonce-less counting path. */
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
  kind: "exact" | "intersection" | "unknown";
  grant: DispatchGrant;
  /** callIDs of the pending dispatches that matched. */
  candidates: readonly string[];
  decisionID: string | null;
  /**
   * Call budget of the matched dispatch; the smallest one for an intersection. null (unknown binding) means
   * the role's default budget — never unlimited.
   */
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
    "binding unknown: this session could not be matched to its dispatch; local actions only, no work root, no router_run — call `router_request_authority` to ask for more",
  lookupFailed: "binding unknown: session lookup failed",
  noParent: "binding unknown: the session lookup reported no parent or agent",
  noCandidate: "binding unknown: no pending dispatch of this parent and agent",
  noNonce: "binding unknown: this session carries no dispatch nonce, and its parent's dispatches of this agent are nonce-bound",
  foreignNonce: "binding unknown: the dispatch named by this session's nonce is not pending for its parent and agent",
  markers: "binding unknown: the session carries several or disagreeing dispatch nonces",
  claimed: "binding unknown: the dispatch named by this session's nonce is already bound to another session",
  intersection: (count: number): string =>
    `binding ambiguous between ${count} dispatches: the grant is their intersection`,
  beyondMax: (actions: readonly AuthorityAction[]): string => `outside the role max, dropped: ${actions.join(", ")}`,
  noWorkRoot: "router_run needs a bound work root (root=) — not granted",
  separation: "egress dropped: a grant never mixes local, exec or write actions with egress (separation rule)",
  widened: (actions: readonly AuthorityAction[]): string => `authority widened on resume: ${actions.join(", ")}`,
  notBound: "no binding for this session: nothing widened",
} as const;

/** A fresh, unguessable per-dispatch nonce (never a provider tool-call id). */
export function newDispatchNonce(): string {
  return randomUUID();
}

/** Title suffix carrying a dispatch nonce (P-2); P2.1 appends it to the `subagent` description. */
export function nonceTitleSuffix(nonce: string): string {
  return ` [nonce ${nonce}]`;
}

/** Prompt line carrying a dispatch nonce (P-2); P2.1 appends it to the `subagent` prompt. */
export function noncePromptLine(nonce: string): string {
  return `OMR_NONCE=${nonce}`;
}

/** Both nonce markers; group 1 or 2 is the nonce. */
const NONCE_MARKER = /\[nonce ([^\]\s]{1,128})\]|OMR_NONCE=([^\s\][)(<>"'`,;]{1,128})/g;

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

const REGISTRY_KEY = Symbol.for("opencode-model-router.role-binding");

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

function retire(reg: Registry, nonce: string, now: number): void {
  if (nonce !== "") remember(reg.retired, nonce, now, RETIRED_MAX);
}

function removePending(reg: Registry, key: string, slot: PendingSlot, now: number): void {
  reg.pending.delete(key);
  retire(reg, slot.entry.nonce, now);
}

/** Drops expired pending entries (their nonces retire), expired retired nonces and deleted-session tombstones. */
function prune(reg: Registry, now: number): void {
  for (const [key, slot] of reg.pending) if (now - slot.start >= PENDING_TTL_MS) removePending(reg, key, slot, now);
  for (const [nonce, at] of reg.retired) if (now - at >= PENDING_TTL_MS) reg.retired.delete(nonce);
  for (const [id, at] of reg.deleted) if (now - at >= PENDING_TTL_MS) reg.deleted.delete(id);
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

function intersection(childSessionID: string, entries: readonly PendingDispatch[]): Binding {
  const [first, ...rest] = entries as [PendingDispatch, ...PendingDispatch[]];
  const actions = ordered(first.grant.actions);
  for (const entry of rest) for (const a of [...actions]) if (!entry.grant.actions.has(a)) actions.delete(a);
  const sharedRoot = entries.every((e) => e.grant.workRoot === first.grant.workRoot);
  const sharedDecision = entries.every((e) => e.decisionID === first.decisionID);
  const notes = [BINDING_NOTES.intersection(entries.length), ...entries.flatMap((e) => e.grant.notes)];
  return {
    childSessionID,
    kind: "intersection",
    grant: { actions, notes: [...new Set(notes)], workRoot: sharedRoot ? first.grant.workRoot : null },
    candidates: entries.map((e) => e.callID),
    decisionID: sharedDecision ? first.decisionID : null,
    budget: Math.min(...entries.map((e) => e.budget)),
  };
}

/** Unknown: the local class, narrowed by every view to max ∩ local (I9). */
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

function markers(text: unknown): Set<string> {
  const found = new Set<string>();
  if (typeof text !== "string") return found;
  for (const match of text.matchAll(NONCE_MARKER)) found.add((match[1] ?? match[2])!);
  return found;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
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
  const reg = registry();
  prune(reg, Date.now());
  const out = (binding: Binding): Decision => ({ binding, parentSessionID: parent, agent, cacheable: true });
  const sameRole = [...reg.pending.values()].filter((s) => s.entry.parentSessionID === parent && s.entry.agent === agent);
  const mine = (s: PendingSlot): boolean => s.claimedBy === undefined || s.claimedBy === childSessionID;
  // Claimed nonce-less entries stay in the pool: a late child that claimed one must not push that
  // dispatch's real child onto another entry (more entries → a narrower intersection, never a wrong exact).
  const nonceless = sameRole.filter((s) => s.entry.nonce === "");

  const fromTitle = markers(session.title);
  const fromPrompt = markers(session.firstText);
  if (fromTitle.size > 0 && fromPrompt.size > 0 && !sameSet(fromTitle, fromPrompt)) {
    return out(unknown(childSessionID, BINDING_NOTES.markers));
  }
  const marked = fromPrompt.size > 0 ? fromPrompt : fromTitle;
  if (marked.size > 1) return out(unknown(childSessionID, BINDING_NOTES.markers));
  if (marked.size === 1) {
    const nonce = [...marked][0]!;
    // Live nonces are unique and never retired (registerPending refuses both), so a retired, unregistered or
    // forged nonce finds no slot.
    const slot = [...reg.pending.values()].find((s) => s.entry.nonce === nonce);
    if (slot === undefined || slot.entry.parentSessionID !== parent || slot.entry.agent !== agent) {
      return out(unknown(childSessionID, BINDING_NOTES.foreignNonce));
    }
    if (!mine(slot)) return out(unknown(childSessionID, BINDING_NOTES.claimed));
    if (nonceless.length > 0) return out(intersection(childSessionID, [slot.entry, ...nonceless.map((s) => s.entry)]));
    slot.claimedBy = childSessionID;
    return out(exact(childSessionID, slot.entry));
  }
  if (sameRole.some((s) => s.entry.nonce !== "")) return out(unknown(childSessionID, BINDING_NOTES.noNonce));
  const claimed = nonceless.find((s) => s.claimedBy === childSessionID);
  if (claimed !== undefined) return out(exact(childSessionID, claimed.entry));
  if (nonceless.length === 1) {
    const only = nonceless[0]!;
    if (!mine(only)) return out(unknown(childSessionID, BINDING_NOTES.claimed));
    only.claimedBy = childSessionID;
    return out(exact(childSessionID, only.entry));
  }
  if (nonceless.length >= 2) return out(intersection(childSessionID, nonceless.map((s) => s.entry)));
  return out(unknown(childSessionID, BINDING_NOTES.noCandidate));
}

function isDeleted(reg: Registry, id: string, now: number): boolean {
  const at = reg.deleted.get(id);
  return at !== undefined && now - at < PENDING_TTL_MS;
}

function validEntry(entry: PendingDispatch): boolean {
  return typeof entry === "object" && entry !== null && text(entry.parentSessionID) !== undefined
    && text(entry.callID) !== undefined && text(entry.agent) !== undefined && typeof entry.nonce === "string"
    && typeof entry.grant === "object" && entry.grant !== null && entry.grant.actions instanceof Set
    && typeof entry.budget === "number" && Number.isFinite(entry.budget) && entry.budget > 0;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * Registers a dispatch, keyed by parent + callID. Refused (no-op): invalid entries (empty ids, a non-Set grant,
 * a budget that is not finite and > 0), a deleted parent, a retired nonce, a nonce another live dispatch
 * holds, an entry already older than the TTL. The grant is copied (a later mutation cannot widen it) and a
 * work root that is not an absolute path becomes null. Re-registering a key replaces the entry; a changed
 * nonce retires the old one and resets the claim.
 */
export function registerPending(entry: PendingDispatch): void {
  if (!validEntry(entry)) return;
  const reg = registry();
  const now = Date.now();
  prune(reg, now);
  const key = pendingKey(entry.parentSessionID, entry.callID);
  const previous = reg.pending.get(key);
  if (isDeleted(reg, entry.parentSessionID, now) || reg.retired.has(entry.nonce)) return;
  if (entry.nonce !== "" && [...reg.pending].some(([k, s]) => k !== key && s.entry.nonce === entry.nonce)) return;
  const start = Number.isFinite(entry.registeredAt) ? Math.min(entry.registeredAt, now) : now;
  if (now - start >= PENDING_TTL_MS) {
    retire(reg, entry.nonce, now);
    return;
  }
  const keepClaim = previous !== undefined && previous.entry.nonce === entry.nonce;
  if (previous !== undefined && !keepClaim) retire(reg, previous.entry.nonce, now);
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
 * `router_run` only with a work root, nothing across the separation rule. `max` undefined → nothing is added
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
    if (action === "router_run" && before.workRoot === null) {
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
