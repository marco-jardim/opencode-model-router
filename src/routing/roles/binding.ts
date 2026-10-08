/**
 * Child-session binding (plan §2.4, §2.5; spikes S2 and amendment P-2; invariants I5, I9).
 *
 * A role dispatch registers a pending entry in `execute.before` (keyed by parent session + callID); the
 * child session binds lazily, at its first context hook (or permission evaluation), from
 * `session.get(child)`: parentID, agent, title and first message text.
 *
 * Decision (one per child, process-wide):
 * 1. candidates = live pending entries with the child's parentID and agent (registration order);
 * 2. exactly one candidate's nonce appears in the child's title or first text → exact (P-2: preferred key);
 * 3. the child carries a router nonce (marker or a retired dispatch's nonce) that matches no candidate →
 *    unknown: its own dispatch is no longer pending, so no other dispatch may lend it a grant;
 * 4. exactly one candidate → exact; two or more → intersection (actions ∩, notes merged, work root kept only
 *    when every candidate shares it, budget = the smallest); none, or a failed lookup → unknown: local
 *    actions ∩ the caller's fallback (the role max), no work root, a note naming `router_request_authority`.
 * Never a union. Every produced grant is normalised, which only removes actions: no `router_run` without a
 * work root (I9), no egress together with local/exec/write (I4).
 *
 * Lifetimes: a pending entry lives until `evict(callID)` (the parent's call completed, `execute.after`), at
 * most {@link PENDING_TTL_MS} (checked on access), and at most {@link PENDING_MAX} entries (oldest evicted).
 * A decision is cached per child until `evict(childSessionID)` (`session.deleted`) or the parent's deletion,
 * LRU-bounded by {@link BOUND_MAX}; a resume returns the cached binding with its widened grant. A failed lookup
 * is not cached (the next hook retries).
 *
 * State lives on `globalThis` under a `Symbol.for` key, so every copy of this module in the process (two
 * plugin instances) shares one registry and one decision per child; a foreign value there is replaced.
 */

import type { AuthorityAction } from "../../router/roles";
import type { DispatchGrant } from "./policy";

export interface PendingDispatch {
  parentSessionID: string;
  callID: string;
  agent: string;
  description: string;
  /** Router-inserted per-dispatch nonce (P-2). */
  nonce: string;
  grant: DispatchGrant;
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
  /** Call budget of the matched dispatch; the smallest one for an intersection; null when unknown. */
  budget: number | null;
}

export interface BindOptions {
  /**
   * Actions an unknown binding may keep. Always intersected with the local class, so the result is
   * `fallback ∩ local`: pass the role max of the child's agent to get I9's "max ∩ local". A function gets
   * the agent reported by the session lookup (undefined when the lookup failed); a throw or `undefined`
   * yields no action. Default: the local class — role callers must pass the max, since the default
   * exceeds the max of a role without local actions (`researcher`).
   */
  localFallback?:
    | Iterable<AuthorityAction>
    | ((agent: string | undefined) => Iterable<AuthorityAction> | undefined);
}

/** Pending entries live at most 30 min (§2.5). */
export const PENDING_TTL_MS = 30 * 60 * 1000;
/** Pending entries kept at most; the oldest is evicted first. */
export const PENDING_MAX = 512;
/** Bound children kept at most (least recently used evicted first). */
export const BOUND_MAX = 4096;
/** Nonces of completed, expired or evicted dispatches remembered at most (same TTL as pending entries). */
const RETIRED_MAX = 1024;

/** The local action class (§2.2). */
export const LOCAL_ACTIONS: readonly AuthorityAction[] = Object.freeze(["read", "glob", "grep", "router_git"]);
const EGRESS: ReadonlySet<AuthorityAction> = new Set<AuthorityAction>(["webfetch", "websearch", "context7", "execute"]);
/** Canonical order; anything else in a grant is dropped (an unknown name never grants). */
const ACTION_ORDER: readonly AuthorityAction[] = [
  "read", "glob", "grep", "router_git", "router_run", "edit", "webfetch", "websearch", "context7", "execute",
];

/** Notes a binding can carry (exact texts, shared with the runtime and the tests). */
export const BINDING_NOTES = {
  unknown:
    "binding unknown: this session could not be matched to its dispatch; local actions only, no work root, no router_run — call `router_request_authority` to ask for more",
  lookupFailed: "binding unknown: session lookup failed",
  noCandidate: "binding unknown: no pending dispatch of this parent and agent",
  foreignNonce: "binding unknown: the dispatch named by this session's nonce is not pending",
  intersection: (count: number): string =>
    `binding ambiguous between ${count} dispatches: the grant is their intersection`,
  noWorkRoot: "router_run needs a bound work root (root=) — not granted",
  separation: "egress dropped: a grant never mixes local, exec or write actions with egress (separation rule)",
  widened: (actions: readonly AuthorityAction[]): string => `authority widened on resume: ${actions.join(", ")}`,
  notBound: "no binding for this session: nothing widened",
} as const;

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
const TOKEN_CHAR = /[A-Za-z0-9_-]/;

// ---------------------------------------------------------------------------
// Process-wide registry
// ---------------------------------------------------------------------------

interface PendingSlot {
  entry: PendingDispatch;
  /** Start of the TTL: the entry's registeredAt, never later than the moment it was stored. */
  start: number;
}

interface BoundSlot {
  binding: Binding;
  parentSessionID: string | undefined;
}

interface Decision {
  binding: Binding;
  parentSessionID: string | undefined;
  cacheable: boolean;
}

interface Inflight {
  promise: Promise<Decision>;
  token: object;
}

interface Registry {
  readonly version: 1;
  readonly pending: Map<string, PendingSlot>;
  readonly bound: Map<string, BoundSlot>;
  readonly inflight: Map<string, Inflight>;
  /** nonce → retiredAt */
  readonly retired: Map<string, number>;
}

const REGISTRY_KEY = Symbol.for("opencode-model-router.role-binding");

function isRegistry(value: unknown): value is Registry {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Partial<Registry>;
  return r.version === 1 && r.pending instanceof Map && r.bound instanceof Map
    && r.inflight instanceof Map && r.retired instanceof Map;
}

function registry(): Registry {
  const existing: unknown = Reflect.get(globalThis, REGISTRY_KEY);
  if (isRegistry(existing)) return existing;
  const created: Registry = { version: 1, pending: new Map(), bound: new Map(), inflight: new Map(), retired: new Map() };
  Reflect.set(globalThis, REGISTRY_KEY, created);
  return created;
}

function pendingKey(parentSessionID: string, callID: string): string {
  return JSON.stringify([parentSessionID, callID]);
}

function retire(reg: Registry, nonce: string, now: number): void {
  if (nonce.trim() === "") return;
  reg.retired.delete(nonce);
  reg.retired.set(nonce, now);
  for (const oldest of reg.retired.keys()) {
    if (reg.retired.size <= RETIRED_MAX) break;
    reg.retired.delete(oldest);
  }
}

/** Drops expired pending entries (their nonces retire) and expired tombstones. */
function prune(reg: Registry, now: number): void {
  for (const [key, slot] of reg.pending) {
    if (now - slot.start >= PENDING_TTL_MS) {
      reg.pending.delete(key);
      retire(reg, slot.entry.nonce, now);
    }
  }
  for (const [nonce, at] of reg.retired) if (now - at >= PENDING_TTL_MS) reg.retired.delete(nonce);
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

function ordered(actions: Iterable<AuthorityAction>): Set<AuthorityAction> {
  const have = new Set<AuthorityAction>(actions);
  return new Set(ACTION_ORDER.filter((a) => have.has(a)));
}

function copyGrant(grant: DispatchGrant): DispatchGrant {
  return { actions: ordered(grant.actions), notes: [...grant.notes], workRoot: grant.workRoot };
}

function dedupe(notes: readonly string[]): string[] {
  return [...new Set(notes)];
}

/** Removes what a grant may never hold; never adds. */
function normalize(actions: Iterable<AuthorityAction>, notes: readonly string[], workRoot: string | null): DispatchGrant {
  const kept = ordered(actions);
  const extra: string[] = [];
  const list = [...kept];
  if (list.some((a) => EGRESS.has(a)) && list.some((a) => !EGRESS.has(a))) {
    for (const a of EGRESS) kept.delete(a);
    extra.push(BINDING_NOTES.separation);
  }
  if (workRoot === null && kept.delete("router_run")) extra.push(BINDING_NOTES.noWorkRoot);
  return { actions: kept, notes: dedupe([...notes, ...extra]), workRoot };
}

function cloneBinding(binding: Binding): Binding {
  return { ...binding, grant: copyGrant(binding.grant), candidates: [...binding.candidates] };
}

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function exact(childSessionID: string, entry: PendingDispatch): Binding {
  const grant = normalize(entry.grant.actions, entry.grant.notes, entry.grant.workRoot);
  return {
    childSessionID, kind: "exact", grant, candidates: [entry.callID],
    decisionID: entry.decisionID, budget: finiteOrNull(entry.budget),
  };
}

function intersection(childSessionID: string, entries: readonly PendingDispatch[]): Binding {
  const [first, ...rest] = entries as [PendingDispatch, ...PendingDispatch[]];
  const actions = new Set(first.grant.actions);
  for (const entry of rest) for (const a of [...actions]) if (!entry.grant.actions.has(a)) actions.delete(a);
  const sharedRoot = entries.every((e) => e.grant.workRoot === first.grant.workRoot);
  const sharedDecision = entries.every((e) => e.decisionID === first.decisionID);
  const budgets = entries.map((e) => e.budget).filter((b) => Number.isFinite(b));
  const notes = [BINDING_NOTES.intersection(entries.length), ...entries.flatMap((e) => e.grant.notes)];
  return {
    childSessionID,
    kind: "intersection",
    grant: normalize(actions, notes, sharedRoot ? first.grant.workRoot : null),
    candidates: entries.map((e) => e.callID),
    decisionID: sharedDecision ? first.decisionID : null,
    budget: budgets.length > 0 ? Math.min(...budgets) : null,
  };
}

function unknown(childSessionID: string, agent: string | undefined, opts: BindOptions, cause: string): Binding {
  let fallback: Iterable<AuthorityAction> | undefined;
  try {
    const option = opts.localFallback ?? LOCAL_ACTIONS;
    fallback = typeof option === "function" ? option(agent) : option;
  } catch {
    fallback = undefined;
  }
  const allowed = new Set<AuthorityAction>(fallback ?? []);
  return {
    childSessionID,
    kind: "unknown",
    grant: { actions: ordered(LOCAL_ACTIONS.filter((a) => allowed.has(a))), notes: [BINDING_NOTES.unknown, cause], workRoot: null },
    candidates: [],
    decisionID: null,
    budget: null,
  };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** `token` occurs in `text` with no token character right before or after it. */
function mentions(text: string, token: string): boolean {
  if (token.trim() === "") return false;
  for (let at = text.indexOf(token); at !== -1; at = text.indexOf(token, at + 1)) {
    const before = at === 0 ? "" : text.charAt(at - 1);
    const after = text.charAt(at + token.length);
    if (!TOKEN_CHAR.test(before) && !TOKEN_CHAR.test(after)) return true;
  }
  return false;
}

function markedNonces(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(NONCE_MARKER)) found.add((match[1] ?? match[2])!);
  return found;
}

async function decide(childSessionID: string, getSession: SessionLookup, opts: BindOptions): Promise<Decision> {
  let session: Awaited<ReturnType<SessionLookup>>;
  try {
    session = await getSession(childSessionID);
  } catch {
    session = undefined;
  }
  if (session === undefined || session === null || typeof session !== "object") {
    return { binding: unknown(childSessionID, undefined, opts, BINDING_NOTES.lookupFailed), parentSessionID: undefined, cacheable: false };
  }
  const parent = typeof session.parentID === "string" && session.parentID !== "" ? session.parentID : undefined;
  const agent = typeof session.agent === "string" && session.agent !== "" ? session.agent : undefined;
  const text = [session.title, session.firstText].filter((t): t is string => typeof t === "string").join("\n");
  const reg = registry();
  prune(reg, Date.now());
  const decided = (binding: Binding): Decision => ({ binding, parentSessionID: parent, cacheable: true });

  const candidates: PendingDispatch[] = [];
  if (parent !== undefined && agent !== undefined) {
    for (const { entry } of reg.pending.values()) {
      if (entry.parentSessionID === parent && entry.agent === agent) candidates.push(entry);
    }
  }
  const named = candidates.filter((c) => mentions(text, c.nonce));
  if (named.length === 1) return decided(exact(childSessionID, named[0]!));
  if (named.length === 0) {
    const markers = markedNonces(text);
    const retired = [...reg.retired.keys()].some((nonce) => mentions(text, nonce));
    const pendingElsewhere = [...reg.pending.values()].some(({ entry }) => markers.has(entry.nonce) || mentions(text, entry.nonce));
    if (markers.size > 0 || retired || pendingElsewhere) {
      return decided(unknown(childSessionID, agent, opts, BINDING_NOTES.foreignNonce));
    }
  }
  if (candidates.length === 1) return decided(exact(childSessionID, candidates[0]!));
  if (candidates.length >= 2) return decided(intersection(childSessionID, candidates));
  return decided(unknown(childSessionID, agent, opts, BINDING_NOTES.noCandidate));
}

function store(reg: Registry, childSessionID: string, slot: BoundSlot): void {
  reg.bound.delete(childSessionID);
  reg.bound.set(childSessionID, slot);
  for (const oldest of reg.bound.keys()) {
    if (reg.bound.size <= BOUND_MAX) break;
    reg.bound.delete(oldest);
  }
}

function validEntry(entry: PendingDispatch): boolean {
  const text = (value: unknown): boolean => typeof value === "string" && value !== "";
  return typeof entry === "object" && entry !== null && text(entry.parentSessionID) && text(entry.callID)
    && text(entry.agent) && typeof entry.nonce === "string" && typeof entry.grant === "object"
    && entry.grant !== null && entry.grant.actions instanceof Set;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * Registers a dispatch, keyed by parent + callID (a re-registration replaces the entry). The grant is copied,
 * so a caller mutating its set later cannot widen it. Invalid entries and entries already older than the TTL
 * are ignored.
 */
export function registerPending(entry: PendingDispatch): void {
  if (!validEntry(entry)) return;
  const reg = registry();
  const now = Date.now();
  prune(reg, now);
  const start = Number.isFinite(entry.registeredAt) ? Math.min(entry.registeredAt, now) : now;
  if (now - start >= PENDING_TTL_MS) {
    retire(reg, entry.nonce, now);
    return;
  }
  const key = pendingKey(entry.parentSessionID, entry.callID);
  const stored: PendingDispatch = Object.freeze({ ...entry, grant: copyGrant(entry.grant) });
  reg.pending.delete(key);
  reg.pending.set(key, { entry: stored, start });
  reg.retired.delete(entry.nonce);
  for (const [oldestKey, oldest] of reg.pending) {
    if (reg.pending.size <= PENDING_MAX) break;
    reg.pending.delete(oldestKey);
    retire(reg, oldest.entry.nonce, now);
  }
}

/**
 * Binds a child session to its dispatch (rules in the module comment). One decision per child: a cached
 * binding is returned as is (with any widening), and concurrent calls — from any plugin instance — share one
 * lookup and one decision. Ambiguous → intersection; unknown → local ∩ fallback. Never throws.
 */
export async function bind(childSessionID: string, getSession: SessionLookup, opts: BindOptions = {}): Promise<Binding> {
  const reg = registry();
  const cached = reg.bound.get(childSessionID);
  if (cached) {
    store(reg, childSessionID, cached);
    return cloneBinding(cached.binding);
  }
  const running = reg.inflight.get(childSessionID);
  if (running) return cloneBinding((await running.promise).binding);
  const token = {};
  const promise = decide(childSessionID, getSession, opts);
  reg.inflight.set(childSessionID, { promise, token });
  try {
    const decision = await promise;
    const latest = registry();
    // An evict() while the lookup ran removed the in-flight token: the decision is returned, not cached.
    if (latest.inflight.get(childSessionID)?.token === token && decision.cacheable) {
      store(latest, childSessionID, { binding: decision.binding, parentSessionID: decision.parentSessionID });
    }
    return cloneBinding(decision.binding);
  } finally {
    const latest = registry();
    if (latest.inflight.get(childSessionID)?.token === token) latest.inflight.delete(childSessionID);
  }
}

/** The cached binding of a child (a copy), or undefined when it is not bound. No lookup. */
export function currentBinding(childSessionID: string): Binding | undefined {
  const slot = registry().bound.get(childSessionID);
  return slot ? cloneBinding(slot.binding) : undefined;
}

/**
 * Widens the grant of a bound child with `actions` (the authority ladder's resume path) and returns the new
 * grant. Only adds: `max`, when given, bounds the added actions (authority.ts always passes the role max);
 * `execute` is never added, `router_run` only with a work root, and nothing of the other side of the
 * separation rule is added to a grant. An unbound child gets an empty grant and nothing is stored.
 */
export function widen(
  childSessionID: string,
  actions: readonly AuthorityAction[],
  max?: Iterable<AuthorityAction>,
): DispatchGrant {
  const reg = registry();
  const slot = reg.bound.get(childSessionID);
  if (!slot) return { actions: new Set<AuthorityAction>(), notes: [BINDING_NOTES.notBound], workRoot: null };
  const allowed = max === undefined ? undefined : new Set<AuthorityAction>(max);
  const before = slot.binding.grant;
  const next = new Set(before.actions);
  const notes = [...before.notes];
  const added: AuthorityAction[] = [];
  for (const action of ordered(actions)) {
    if (next.has(action) || action === "execute" || (allowed !== undefined && !allowed.has(action))) continue;
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
  const grant: DispatchGrant = { actions: ordered(next), notes: dedupe(notes), workRoot: before.workRoot };
  store(reg, childSessionID, { ...slot, binding: { ...slot.binding, grant } });
  return copyGrant(grant);
}

/**
 * Drops binding state for an id: a callID (the parent's call completed) removes its pending entries; a
 * session id removes that child's binding and in-flight decision, and — when it is a parent — its pending
 * entries and its children's bindings. Removed dispatches' nonces are remembered for the TTL.
 */
export function evict(sessionOrCallID: string): void {
  const reg = registry();
  const now = Date.now();
  for (const [key, slot] of reg.pending) {
    if (slot.entry.callID === sessionOrCallID || slot.entry.parentSessionID === sessionOrCallID) {
      reg.pending.delete(key);
      retire(reg, slot.entry.nonce, now);
    }
  }
  reg.bound.delete(sessionOrCallID);
  for (const [child, slot] of reg.bound) if (slot.parentSessionID === sessionOrCallID) reg.bound.delete(child);
  reg.inflight.delete(sessionOrCallID);
}

/** Sizes of the registry (observability and tests). */
export function bindingRegistrySize(): { pending: number; bound: number; retired: number } {
  const reg = registry();
  return { pending: reg.pending.size, bound: reg.bound.size, retired: reg.retired.size };
}

/** Test only: empties the process-wide registry. */
export function resetBindingRegistryForTests(): void {
  const reg = registry();
  reg.pending.clear();
  reg.bound.clear();
  reg.inflight.clear();
  reg.retired.clear();
}
