import { DEFAULT_IDLE_TTL_MS } from "./idle-sweep";

export const MAX_DEPTH_HOPS = 32;
export const DEPTH_LOOKUP_RETRY_MS = 30_000;
export const DEFAULT_DEPTH_TIMEOUT_MS = 2_000;
export const DEFAULT_DEPTH_MAX_ENTRIES = 10_000;
const MAX_PARENT_LINKS = 4;
const FETCH_BUDGET = 2 * (MAX_DEPTH_HOPS + 1);

export interface DepthTrackerSeams {
  getParent(sessionID: string): Promise<string | null>;
  now(): number;
  logger: { warn(msg: string): void };
}

export interface DepthTracker {
  recordRoot(sessionID: string): void;
  recordCreated(sessionID: string, parentID: string | null): void;
  recordPluginChild(sessionID: string, creatorID: string | null): void;
  depthOf(sessionID: string, opts?: { timeoutMs?: number }): Promise<number | undefined>;
  forget(sessionID: string): void;
  sweep(): void;
  size(): number;
}

interface Node {
  parents: string[];
  depth: number;
  resolved: boolean;
  plugin: boolean;
  rootSeen: boolean;
  lastTouch: number;
}
type LookupResult = { ok: true; node: Node } | { ok: false; reason: string };
interface Lookup {
  id: string;
  promise: Promise<LookupResult>;
  detached: boolean;
  cancelled: boolean;
  waiters: number; // walks currently awaiting this lookup
  cancel(): void;
}
interface Walk {
  id: string;
  promise: Promise<number | undefined>;
  learned: Map<string, Node>;
  pending?: Lookup;
  cancelled: boolean;
  waiters: number; // depthOf callers currently awaiting this walk
  stopped: Promise<undefined>;
  stop(): void;
}
interface Done {
  kind: "done";
  depth: number;
  vals: Map<string, number>;
  complete: Set<string>;
  order: string[];
}
type Climb = Done | { kind: "need"; id: string };
type Source = "event" | "backend" | "plugin";
const validId = (id: unknown): id is string => typeof id === "string" && id !== "";
const MAX_TIMER_MS = 2_147_483_647;

/** Rejection reasons come from the backend seam and may not be printable. */
function describe(e: unknown): string {
  try {
    return e instanceof Error ? String(e.message) : String(e);
  } catch {
    return "unprintable rejection";
  }
}

/** Options come from JavaScript callers; a throwing getter means "default". */
function timeoutOf(options: { timeoutMs?: number } | undefined): number {
  try {
    const t = options?.timeoutMs;
    return typeof t === "number" && Number.isFinite(t) && t > 0 ? Math.min(t, MAX_TIMER_MS) : DEFAULT_DEPTH_TIMEOUT_MS;
  } catch {
    return DEFAULT_DEPTH_TIMEOUT_MS;
  }
}

/** Evidence and monotone floors are per tracker, never shared between plugins. */
export function createDepthTracker(
  seams: DepthTrackerSeams,
  opts: { ttlMs?: number; maxEntries?: number } = {},
): DepthTracker {
  const ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs! > 0 ? opts.ttlMs! : DEFAULT_IDLE_TTL_MS;
  const maxEntries = Number.isInteger(opts.maxEntries) && opts.maxEntries! >= 1
    ? opts.maxEntries! : DEFAULT_DEPTH_MAX_ENTRIES;
  const nodes = new Map<string, Node>();
  const walks = new Map<string, Walk>();
  const lookups = new Map<string, Lookup>();
  const failedAt = new Map<string, number>();
  const warned = new Map<string, number>();
  const live = new Set<Walk>(); // every walk, cancelled or not, until it settles
  const strays = new Map<string, Set<Lookup>>(); // detached lookups until they settle
  let lastNow = 0;

  // Seams are contained where they are called, so no state change is ever cut
  // short by a throwing clock or logger and no public method throws or rejects.
  function clock(): number {
    try {
      const t = seams.now();
      if (typeof t === "number" && Number.isFinite(t)) lastNow = t;
    } catch {
      return lastNow;
    }
    return lastNow;
  }

  function say(message: string): boolean {
    try {
      seams.logger.warn(message);
      return true;
    } catch {
      return false;
    }
  }

  function warn(id: string, kind: "lookup" | "conflict", reason: string): void {
    const key = `${kind}:${id}`;
    if (warned.has(key)) return;
    warned.set(key, clock());
    while (warned.size > maxEntries) warned.delete(warned.keys().next().value!);
    const message = `[router] depth: ${kind === "lookup" ? "cannot resolve" : "conflicting evidence for"} session ${id}: ${reason}`;
    // An undelivered warning is not remembered, so a later occurrence retries it.
    if (!say(message)) warned.delete(key);
  }

  function trimLRU(): void {
    while (nodes.size > maxEntries) nodes.delete(nodes.keys().next().value!);
  }

  function makeNode(link: string | null, plugin: boolean): Node {
    return {
      parents: link === null ? [] : [link],
      depth: link === null && !plugin ? 0 : 1,
      resolved: link === null,
      plugin,
      rootSeen: link === null && !plugin,
      lastTouch: clock(),
    };
  }

  // Adds one parent link under the §3 rules.
  function addLink(id: string, n: Node, link: string): void {
    if (n.parents.includes(link)) return;
    if (n.parents.length >= MAX_PARENT_LINKS) {
      n.depth = MAX_DEPTH_HOPS;
      n.resolved = true;
      warn(id, "conflict", "parent link overflow");
      return;
    }
    if (!n.plugin && (n.rootSeen || n.parents.length)) warn(id, "conflict", "new parent");
    n.parents.push(link);
    n.resolved = false;
    n.depth = Math.max(n.depth, 1);
  }

  function addRoot(id: string, n: Node): void {
    if (n.plugin) return; // v1 producers have no parentID: root evidence is moot
    if (n.parents.length) warn(id, "conflict", "root after parent");
    else n.rootSeen = true;
  }

  // Two objects for one id (a walk's retained copy and a node re-created after
  // eviction) are merged, never replaced: union of links, max of floors, flags.
  function absorb(id: string, into: Node, from: Node): void {
    if (from.plugin && !into.plugin) {
      into.plugin = true;
      into.depth = Math.max(into.depth, 1);
    }
    if (from.rootSeen) addRoot(id, into);
    for (const p of from.parents) addLink(id, into, p);
    into.depth = Math.max(into.depth, from.depth);
    into.lastTouch = Math.max(into.lastTouch, from.lastTouch);
  }

  function mergeInto(map: Map<string, Node>, id: string, n: Node): void {
    const mine = map.get(id);
    if (!mine) map.set(id, n);
    else if (mine !== n) absorb(id, mine, n);
  }

  // A node entering the map takes over every copy a live walk still holds, so
  // neither side can lose evidence and later readers see the union at once.
  function adopt(id: string, n: Node): void {
    nodes.set(id, n);
    for (const walk of live) {
      const copy = walk.learned.get(id);
      if (copy === undefined || copy === n) continue;
      absorb(id, n, copy);
      walk.learned.set(id, n);
    }
  }

  // The tracked object for `id`, merged with this climb's retained copy.
  function node(id: string, learned: Map<string, Node>): Node | undefined {
    const tracked = nodes.get(id);
    const copy = learned.get(id);
    if (tracked && copy && tracked !== copy) absorb(id, tracked, copy);
    const n = tracked ?? copy;
    if (n) learned.set(id, n);
    return n;
  }

  function applyLink(id: string, link: string | null, source: Source): Node {
    const plugin = source === "plugin";
    const n = nodes.get(id);
    if (!n) {
      // Trim only after the floor climb touches this node's ancestors. Trimming
      // here could evict its known parent before deriving the new child's floor.
      const created = makeNode(link, plugin);
      adopt(id, created);
      return created;
    }
    if (plugin) {
      n.plugin = true;
      if (link === null) n.depth = Math.max(n.depth, 1);
    }
    if (link !== null) addLink(id, n, link);
    else if (!plugin) addRoot(id, n);
    return n;
  }

  // Each climb is synchronous: no event can interleave with its snapshot.
  function climb(start: string, learned: Map<string, Node>, mode: "exact" | "floor"): Climb | undefined {
    const known = (id: string) => nodes.has(id) || learned.has(id);
    if (!known(start)) return mode === "exact" ? { kind: "need", id: start } : undefined;
    const vals = new Map<string, number>();
    const complete = new Set<string>();
    const order: string[] = [];
    const stack: string[] = [];
    let stop: { kind: "need"; id: string } | { kind: "cap"; cycle: boolean } | undefined;
    function visit(id: string, level: number): number {
      if (vals.has(id)) return vals.get(id)!;
      if (stack.includes(id) || level > MAX_DEPTH_HOPS) {
        stop = { kind: "cap", cycle: stack.includes(id) };
        return MAX_DEPTH_HOPS;
      }
      // Retain visited evidence for the duration of this walk. Backend inserts
      // can evict the start (even with a one-entry cache); that must not turn
      // an event-proven child into a fresh backend root. Node references also
      // retain all conflicting links, not merely the last parent answer.
      const n = node(id, learned)!;
      let d = n.depth;
      if (d >= MAX_DEPTH_HOPS) {
        vals.set(id, MAX_DEPTH_HOPS);
        complete.add(id);
        order.push(id);
        return MAX_DEPTH_HOPS;
      }
      stack.push(id);
      let ok = true;
      for (const p of n.parents) {
        if (!known(p)) {
          if (n.resolved) continue; // Absolute memo at an evicted frontier.
          if (mode === "exact") {
            stop = { kind: "need", id: p };
            return d;
          }
          ok = false;
          continue;
        }
        d = Math.max(d, visit(p, level + 1) + 1);
        if (stop) return d;
        ok = ok && complete.has(p);
      }
      stack.pop();
      d = Math.min(d, MAX_DEPTH_HOPS);
      vals.set(id, d);
      if (ok) complete.add(id);
      order.push(id);
      return d;
    }
    let depth = visit(start, 0);
    if (stop?.kind === "need") return stop;
    if (stop?.kind === "cap") {
      depth = MAX_DEPTH_HOPS;
      for (const [level, id] of stack.entries()) {
        const d = stop.cycle ? MAX_DEPTH_HOPS : Math.min(MAX_DEPTH_HOPS, MAX_DEPTH_HOPS + 1 - level);
        vals.set(id, d);
        if (d === MAX_DEPTH_HOPS) complete.add(id);
      }
      // Preserve reverse post-order touching even when a climb hits the cap.
      order.push(...stack.slice().reverse());
    }
    return { kind: "done", depth, vals, complete, order };
  }

  function memoize(r: Done, learned: Map<string, Node>): void {
    for (const id of r.order.slice().reverse()) {
      const n = node(id, learned)!;
      if (!nodes.has(id)) adopt(id, n);
      n.depth = Math.max(n.depth, r.vals.get(id)!);
      if (r.complete.has(id)) n.resolved = true;
      n.lastTouch = clock();
      nodes.delete(id);
      nodes.set(id, n);
    }
    trimLRU();
  }

  function floor(id: string, learned: Map<string, Node>, reason: string): number | undefined {
    const r = climb(id, learned, "floor");
    if (!r || r.kind !== "done") {
      warn(id, "lookup", reason);
      return undefined;
    }
    memoize(r, learned);
    if (!r.complete.has(id)) warn(id, "lookup", reason);
    return r.depth;
  }

  function throttled(id: string): boolean {
    const stamp = failedAt.get(id);
    if (stamp === undefined) return false;
    const age = clock() - stamp;
    if (age >= 0 && age < DEPTH_LOOKUP_RETRY_MS) return true;
    failedAt.delete(id); // Expired entries go at lookup time, not only on sweep().
    return false;
  }

  // The blocklist is FIFO-capped like `warned`: the oldest throttle goes first.
  function setFailed(id: string): void {
    failedAt.delete(id);
    failedAt.set(id, clock());
    while (failedAt.size > maxEntries) failedAt.delete(failedAt.keys().next().value!);
  }

  function startLookup(id: string): Lookup {
    let cancel!: () => void;
    const cancelled = new Promise<LookupResult>((resolve) => {
      cancel = () => resolve({ ok: false, reason: "forgotten" });
    });
    const lookup: Lookup = { id, promise: cancelled, detached: false, cancelled: false, waiters: 0, cancel };
    lookups.set(id, lookup);
    function fail(reason: string): LookupResult {
      if (!lookup.detached && !lookup.cancelled) setFailed(id);
      return { ok: false, reason };
    }
    const request = Promise.resolve().then(() => seams.getParent(id)).then((raw): LookupResult => {
      if (lookup.cancelled) return fail("forgotten");
      if (raw !== null && !validId(raw)) return fail("malformed answer");
      failedAt.delete(id);
      return { ok: true, node: record(id, raw, "backend") };
    }, (e: unknown) => fail(describe(e)));
    lookup.promise = Promise.race([request, cancelled]).finally(() => {
      if (lookups.get(id) === lookup) lookups.delete(id);
      const stray = strays.get(id);
      if (stray?.delete(lookup) && stray.size === 0) strays.delete(id);
    });
    return lookup;
  }

  // A lookup that no walk awaits any more is detached: the throttle starts now,
  // a late success is still applied as evidence, and forget() can still cancel it.
  function detach(lookup: Lookup): void {
    if (lookups.get(lookup.id) !== lookup) return;
    lookups.delete(lookup.id);
    lookup.detached = true;
    setFailed(lookup.id);
    let stray = strays.get(lookup.id);
    if (!stray) strays.set(lookup.id, stray = new Set());
    stray.add(lookup);
  }

  function cancelLookup(lookup: Lookup): void {
    lookup.cancelled = true;
    lookup.cancel();
  }

  // A cancelled walk settles its callers with undefined and resumes at once, so
  // its continuation can never issue another lookup. It stays in `live` (and so
  // within reach of forget) until that continuation has returned.
  function cancelWalk(walk: Walk, timedOut: boolean): void {
    walk.cancelled = true;
    if (walks.get(walk.id) === walk) walks.delete(walk.id);
    const lookup = walk.pending;
    walk.pending = undefined;
    if (lookup && --lookup.waiters === 0 && timedOut) detach(lookup);
    walk.stop();
  }

  function startWalk(id: string, learned: Map<string, Node>): Walk {
    let stop!: () => void;
    const stopped = new Promise<undefined>((resolve) => { stop = () => resolve(undefined); });
    const walk: Walk = { id, promise: stopped, learned, cancelled: false, waiters: 0, stopped, stop };
    walks.set(id, walk);
    live.add(walk);
    walk.promise = run(walk);
    return walk;
  }

  async function run(walk: Walk): Promise<number | undefined> {
    const { id, learned } = walk;
    let fetches = 0;
    try {
      for (;;) {
        const r = climb(id, learned, "exact")!;
        if (r.kind === "done") {
          memoize(r, learned);
          return r.depth;
        }
        if (throttled(r.id) && !lookups.has(r.id)) return floor(id, learned, "throttled");
        if (++fetches > FETCH_BUDGET) {
          warn(id, "lookup", "fetch budget");
          return MAX_DEPTH_HOPS;
        }
        const lookup = lookups.get(r.id) ?? startLookup(r.id);
        walk.pending = lookup;
        lookup.waiters++;
        const result = await Promise.race([lookup.promise, walk.stopped]);
        if (walk.cancelled || result === undefined) return undefined;
        walk.pending = undefined;
        lookup.waiters--;
        if (!result.ok) return floor(id, learned, result.reason);
        mergeInto(learned, r.id, result.node);
      }
    } finally {
      live.delete(walk);
      if (walks.get(id) === walk) walks.delete(id);
    }
  }

  function record(id: string, link: string | null, source: Source): Node {
    const n = applyLink(id, link, source);
    const learned = new Map<string, Node>([[id, n]]);
    memoize(climb(id, learned, "floor") as Done, learned);
    return n;
  }

  return {
    recordRoot(id) {
      if (validId(id)) record(id, null, "event");
    },
    recordCreated(id, parent) {
      if (!validId(id)) return;
      if (parent == null || parent === "") record(id, null, "event");
      else if (validId(parent)) record(id, parent, "event");
    },
    recordPluginChild(id, creator) {
      if (validId(id)) record(id, validId(creator) && creator !== id ? creator : null, "plugin");
    },
    async depthOf(id, options) {
      if (!validId(id)) return undefined;
      const learned = new Map<string, Node>();
      const r = climb(id, learned, "exact")!;
      if (r.kind === "done") {
        memoize(r, learned);
        return r.depth;
      }
      if (throttled(r.id) && !lookups.has(r.id)) return floor(id, learned, `throttled at ${r.id}`);
      let walk = walks.get(id);
      if (!walk) walk = startWalk(id, learned);
      else for (const [known, n] of learned) mergeInto(walk.learned, known, n);
      walk.waiters++;
      const t = timeoutOf(options);
      const timeout = Symbol("timeout");
      let timer!: ReturnType<typeof setTimeout>;
      const deadline = new Promise<typeof timeout>((resolve) => {
        timer = setTimeout(() => resolve(timeout), t);
        timer.unref?.();
      });
      try {
        const result = await Promise.race([walk.promise, deadline]);
        walk.waiters--;
        if (result !== timeout) return result;
        // Shared callers keep independent deadlines; the last one out cancels.
        if (walk.waiters === 0 && !walk.cancelled) cancelWalk(walk, true);
        // F1 fallback: everything the walk has learned so far, not only the
        // caller's starting snapshot.
        return floor(id, walk.learned, `timed out after ${t} ms`);
      } finally {
        clearTimeout(timer);
      }
    },
    forget(id) {
      if (!validId(id)) return;
      nodes.delete(id);
      failedAt.delete(id);
      warned.delete(`lookup:${id}`);
      warned.delete(`conflict:${id}`);
      for (const walk of live) {
        walk.learned.delete(id);
        if (walk.id === id) cancelWalk(walk, false);
      }
      const lookup = lookups.get(id);
      if (lookup) {
        cancelLookup(lookup);
        lookups.delete(id);
      }
      for (const stray of strays.get(id) ?? []) cancelLookup(stray);
      strays.delete(id);
    },
    sweep() {
      const now = clock();
      for (const [id, n] of nodes) if (now - n.lastTouch >= ttlMs) nodes.delete(id);
      for (const id of failedAt.keys()) throttled(id); // drops every expired entry
      for (const [key, stamp] of warned) if (now - stamp >= ttlMs) warned.delete(key);
    },
    size: () => nodes.size,
  };
}
