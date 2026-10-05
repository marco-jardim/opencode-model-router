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
  /** Tracked sessions, at most `maxEntries`. Ghosts (the remembered links of
   *  evicted sessions, at most `maxEntries` more) are not sessions and are not
   *  counted. */
  size(): number;
}

interface Node {
  parents: string[];
  depth: number;
  resolved: boolean;
  plugin: boolean;
  rootSeen: boolean;
  pinned: boolean; // carries evidence a backend walk cannot reproduce: never LRU-evicted
  fresh: boolean; // memo is current: no evidence above it changed since it was computed
  gap?: string; // fresh and incomplete: a missing ancestor to fetch
  via?: string; // the parent that gave the depth (the path a read keeps warm)
  lastTouch: number;
}
// An evicted node's links, kept so the sweep can cross it (QA-1.2-R3-1).
interface Ghost {
  parents: string[];
  lastTouch: number; // the node's last touch: a ghost expires like a node
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
  start: string;
  excess: Set<string>; // complete, with a floor above what its links now derive
  fresh: Set<string>; // finished normally: their values are level-independent
  gaps: Map<string, string>;
  vias: Map<string, string>;
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
  const lru = new Map<string, Node>(); // Map order IS the LRU list (oldest first)
  const pins = new Map<string, Node>(); // pinned nodes, same recency order, own cap
  const kids = new Map<string, Set<string>>(); // parent id -> tracked nodes linking to it
  const get = (id: string): Node | undefined => lru.get(id) ?? pins.get(id);
  const has = (id: string): boolean => lru.has(id) || pins.has(id);
  // Ghosts (QA-1.2-R3-1): the links of evicted nodes, for the sweep only. Climbs
  // never read them, so they cause no lookup and prove no depth. `held` ghosts
  // have a tracked or ghost child; `loose` ones have none and are dropped first
  // when the ghosts together exceed maxEntries. Each map is oldest first.
  const held = new Map<string, Ghost>();
  const loose = new Map<string, Ghost>();
  const ghostKids = new Map<string, Set<string>>(); // parent id -> ghosts linking to it
  const ghostOf = (id: string): Ghost | undefined => held.get(id) ?? loose.get(id);
  const remembered = (id: string): boolean => has(id) || held.has(id) || loose.has(id);
  const walks = new Map<string, Walk>();
  const lookups = new Map<string, Lookup>();
  const failedAt = new Map<string, number>();
  const warned = new Map<string, number>();
  const live = new Set<Walk>(); // every walk, cancelled or not, until it settles
  const strays = new Map<string, Set<Lookup>>(); // detached lookups until they settle, by id
  const strayOrder = new Set<Lookup>(); // the same lookups, oldest first: FIFO-capped at maxEntries
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

  const WARNINGS = {
    lookup: "cannot resolve",
    conflict: "conflicting evidence for",
    evict: "dropping pinned evidence for",
    unlink: "dropping the evicted links of",
  };

  function warn(id: string, kind: keyof typeof WARNINGS, reason: string): void {
    const key = `${kind}:${id}`;
    if (warned.has(key)) return;
    warned.set(key, clock());
    while (warned.size > maxEntries) warned.delete(warned.keys().next().value!);
    const message = `[router] depth: ${WARNINGS[kind]} session ${id}: ${reason}`;
    // An undelivered warning is not remembered, so a later occurrence retries it.
    if (!say(message)) warned.delete(key);
  }

  // `kids` and `ghostKids` map a parent id to the nodes or ghosts linking to it;
  // a ghost moves between `held` and `loose` as its first child comes or its
  // last one goes.
  function index(map: Map<string, Set<string>>, parent: string, kid: string): void {
    let set = map.get(parent);
    if (!set) map.set(parent, set = new Set());
    set.add(kid);
    regroup(parent);
  }

  function unindex(map: Map<string, Set<string>>, parent: string, kid: string): void {
    const set = map.get(parent)!;
    set.delete(kid);
    if (set.size === 0) map.delete(parent);
    regroup(parent);
  }

  function regroup(id: string): void {
    const g = ghostOf(id);
    if (g === undefined) return;
    const [to, from] = kids.has(id) || ghostKids.has(id) ? [held, loose] : [loose, held];
    if (to.has(id)) return;
    from.delete(id);
    to.set(id, g);
  }

  const linkKid = (parent: string, kid: string): void => index(kids, parent, kid);

  // Untracks a node. Its children keep their links and floors; after an eviction
  // or expiry (unlike forget, F4) they lose the frontier memo and so re-resolve
  // the dropped id through the backend instead of trusting a memo that can no
  // longer see conflicts recorded above it. An evicted node with links leaves a
  // ghost; an expired one does not (the sweep found nothing live below it).
  function drop(id: string, why: "evict" | "expire" | "forget"): void {
    const n = get(id)!;
    lru.delete(id);
    pins.delete(id);
    if (why === "evict" && n.parents.length) bury(id, n);
    for (const p of n.parents) unindex(kids, p, id);
    n.fresh = false; // a walk may still hold this object
    if (why !== "forget") for (const kid of kids.get(id) ?? []) get(kid)!.resolved = false;
    invalidate(id);
  }

  // Remembers an evicted node's links, so that the sweep keeps the ancestors of
  // a live node across it (QA-1.2-R3-1). Ghosts are FIFO-capped at maxEntries,
  // loose ones first: no tracked node depends on them. Dropping a held ghost is
  // logged when a pinned node may lie above it: unless an exact read re-fetches
  // the evicted id first, that pinned evidence can then expire while a tracked
  // descendant is still live.
  function bury(id: string, n: Node): void {
    const g: Ghost = { parents: [...n.parents], lastTouch: n.lastTouch }; // a walk may grow n.parents
    loose.set(id, g);
    for (const p of g.parents) index(ghostKids, p, id);
    regroup(id);
    while (held.size + loose.size > maxEntries) {
      const old = (loose.size ? loose : held).keys().next().value!;
      const above = held.has(old) ? pinnedAbove(ghostOf(old)!.parents) : undefined;
      if (above !== undefined) warn(old, "unlink", `more than ${maxEntries} evicted sessions; ${above} may expire`);
      unbury(old);
    }
  }

  // Forgets a ghost: its id is tracked again (its own links take over), was
  // forgotten, expired, or was pushed out of the cap.
  function unbury(id: string): void {
    const g = ghostOf(id);
    if (g === undefined) return;
    held.delete(id);
    loose.delete(id);
    for (const p of g.parents) unindex(ghostKids, p, id);
  }

  // Multi-source BFS over tracked and ghost links, up to MAX_DEPTH_HOPS hops:
  // `hops` (id -> distance, seeded by the caller) gains each remembered ancestor
  // once, at its shortest distance (Map iteration visits entries added during it,
  // in order). Stops early at the first id `stop` accepts.
  function ancestry(hops: Map<string, number>, stop: (id: string) => boolean = () => false): void {
    for (const [id, level] of hops) {
      if (stop(id)) return;
      if (level === MAX_DEPTH_HOPS) continue;
      for (const p of get(id)?.parents ?? ghostOf(id)!.parents) if (!hops.has(p) && remembered(p)) hops.set(p, level + 1);
    }
  }

  // A pinned node within MAX_DEPTH_HOPS above `links`. The probe visits at most
  // PROBE_BUDGET remembered ids (a bounded cost per dropped ghost); past that it
  // reports a pinned node it could not rule out.
  const PROBE_BUDGET = Math.min(FETCH_BUDGET, maxEntries);
  function pinnedAbove(links: string[]): string | undefined {
    let visited = 0;
    let found: string | undefined;
    ancestry(new Map(links.filter(remembered).map((p): [string, number] => [p, 1])), (id) => {
      if (visited++ === PROBE_BUDGET) found = `a pinned session beyond ${PROBE_BUDGET} probed ancestors`;
      else if (get(id)?.pinned) found = `pinned session ${id}`;
      return found !== undefined;
    });
    return found;
  }

  // Marks every tracked descendant of `id` stale. Invariant: a stale node has no
  // fresh non-terminal tracked child, so the walk stops at the first stale node.
  // A fresh terminal (MAX) child can sit under a stale parent: its value can no
  // longer change, so it needs no invalidation.
  function invalidate(id: string): void {
    const queue = [id];
    for (let i = 0; i < queue.length; i++) {
      for (const kid of kids.get(queue[i]) ?? []) {
        const k = get(kid)!;
        if (!k.fresh) continue;
        k.fresh = false;
        queue.push(kid);
      }
    }
  }

  // Evidence on `n` changed in a way that can raise it: its memo and every
  // descendant's memo are stale.
  function changed(id: string, n: Node): void {
    n.fresh = false;
    invalidate(id);
  }

  // The oldest entry other than `protect`, or `protect` when it is the only one.
  function victim(map: Map<string, Node>, protect: string): string {
    const keys = map.keys();
    const first = keys.next().value!;
    if (first !== protect) return first;
    const second = keys.next();
    return second.done ? first : second.value;
  }

  // One cap for every node (QA-1.2-R2-3): size() <= maxEntries. Ordinary nodes
  // (backend-reproducible) go first, oldest first; the node a call has just
  // recorded or read goes last of them, so its ancestors go before it and
  // drop() makes it re-resolve them. It goes at all only when pinned nodes fill
  // the cap, after its answer is computed. A pinned node is dropped, with a
  // warning, only when pinned nodes alone exceed the cap (never the current
  // one). Only adopt() adds a node, and every adopt() is followed by a trim in
  // the same synchronous call; pin() moves a node between the maps.
  function trim(protect: string): void {
    while (lru.size + pins.size > maxEntries && lru.size) drop(victim(lru, protect), "evict");
    while (pins.size > maxEntries) {
      const id = victim(pins, protect);
      warn(id, "evict", `more than ${maxEntries} pinned sessions`);
      drop(id, "evict");
    }
  }

  function pin(id: string, n: Node): void {
    if (n.pinned) return;
    n.pinned = true;
    if (lru.delete(id)) pins.set(id, n);
  }

  function conflict(id: string, n: Node, reason: string): void {
    warn(id, "conflict", reason);
    pin(id, n);
  }

  function makeNode(link: string | null, plugin: boolean): Node {
    return {
      parents: link === null ? [] : [link],
      depth: link === null && !plugin ? 0 : 1,
      resolved: link === null,
      plugin,
      rootSeen: link === null && !plugin,
      pinned: plugin,
      fresh: false,
      lastTouch: clock(),
    };
  }

  // Adds one parent link under the §3 rules.
  function addLink(id: string, n: Node, link: string): void {
    if (n.parents.includes(link)) return;
    if (n.parents.length >= MAX_PARENT_LINKS) {
      n.depth = MAX_DEPTH_HOPS;
      n.resolved = true;
      conflict(id, n, "parent link overflow");
      changed(id, n);
      return;
    }
    if (!n.plugin && (n.rootSeen || n.parents.length)) conflict(id, n, "new parent");
    n.parents.push(link);
    if (get(id) === n) linkKid(link, id);
    n.resolved = false;
    n.depth = Math.max(n.depth, 1);
    changed(id, n);
  }

  function addRoot(id: string, n: Node): void {
    if (n.plugin) return; // v1 producers have no parentID: root evidence is moot
    if (n.parents.length) conflict(id, n, "root after parent");
    else n.rootSeen = true;
  }

  // Two objects for one id (a walk's retained copy and a node re-created after
  // eviction) are merged, never replaced: union of links, max of floors, flags.
  function absorb(id: string, into: Node, from: Node): void {
    if (from.plugin && !into.plugin) {
      into.plugin = true;
      pin(id, into);
      into.depth = Math.max(into.depth, 1);
      changed(id, into);
    }
    if (from.rootSeen) addRoot(id, into);
    for (const p of from.parents) addLink(id, into, p);
    if (from.depth > into.depth) {
      into.depth = from.depth;
      changed(id, into);
    }
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
    (n.pinned ? pins : lru).set(id, n);
    for (const p of n.parents) linkKid(p, id);
    unbury(id); // tracked again: its own links replace the ghost's
    invalidate(id); // children holding `id` as a gap or frontier must re-climb
    for (const walk of live) {
      const copy = walk.learned.get(id);
      if (copy === undefined || copy === n) continue;
      absorb(id, n, copy);
      walk.learned.set(id, n);
    }
  }

  // The tracked object for `id`, merged with this climb's retained copy (an
  // untracked id is only ever known through that copy: adopt() unifies copies).
  function node(id: string, learned: Map<string, Node>): Node {
    const tracked = get(id);
    const copy = learned.get(id);
    if (!tracked) return copy!;
    if (copy && copy !== tracked) absorb(id, tracked, copy);
    learned.set(id, tracked);
    return tracked;
  }

  function applyLink(id: string, link: string | null, source: Source): Node {
    const plugin = source === "plugin";
    const n = get(id);
    if (!n) {
      // Trim only after the floor climb touches this node's ancestors. Trimming
      // here could evict its known parent before deriving the new child's floor.
      const created = makeNode(link, plugin);
      adopt(id, created);
      return created;
    }
    if (plugin && !n.plugin) {
      n.plugin = true;
      pin(id, n);
      n.depth = Math.max(n.depth, 1);
      changed(id, n);
    }
    if (link !== null) addLink(id, n, link);
    else if (!plugin) addRoot(id, n);
    return n;
  }

  // Each climb is synchronous: no event can interleave with its snapshot. It
  // recurses only into stale nodes and stops at fresh memos (and terminals), so
  // a read whose ancestry is unchanged costs O(links of the start).
  function climb(start: string, learned: Map<string, Node>, mode: "floor"): Done | undefined;
  function climb(start: string, learned: Map<string, Node>, mode: "exact"): Climb;
  function climb(start: string, learned: Map<string, Node>, mode: "exact" | "floor"): Climb | undefined {
    const known = (id: string) => has(id) || learned.has(id);
    if (!known(start)) return mode === "exact" ? { kind: "need", id: start } : undefined;
    // A memo cannot see evidence held only by this walk (an evicted copy), so
    // memos are trusted only while every retained node is still tracked.
    let shortcuts = true;
    for (const id of learned.keys()) if (!has(id)) shortcuts = false;
    const vals = new Map<string, number>();
    const complete = new Set<string>();
    const order: string[] = [];
    const excess = new Set<string>();
    const fresh = new Set<string>();
    const gaps = new Map<string, string>();
    const vias = new Map<string, string>();
    const stack: string[] = [];
    const onStack = new Set<string>();
    let stop: { kind: "need"; id: string } | { kind: "cap"; cycle: boolean } | undefined;
    function visit(id: string, level: number): number {
      const seen = vals.get(id);
      if (seen !== undefined) return seen;
      if (onStack.has(id) || level > MAX_DEPTH_HOPS) {
        stop = { kind: "cap", cycle: onStack.has(id) };
        return MAX_DEPTH_HOPS;
      }
      // Retain visited evidence for the duration of this walk. Backend inserts
      // can evict the start (even with a one-entry cache); that must not turn
      // an event-proven child into a fresh backend root. Node references also
      // retain all conflicting links, not merely the last parent answer.
      const n = node(id, learned);
      if (n.depth >= MAX_DEPTH_HOPS) {
        vals.set(id, MAX_DEPTH_HOPS);
        complete.add(id);
        fresh.add(id);
        order.push(id);
        return MAX_DEPTH_HOPS;
      }
      // A walk (exact mode) climbs through incomplete memos rather than jumping to
      // their gap, so it retains every node it depends on (QA-1.2-1).
      if (shortcuts && n.fresh && (n.gap === undefined || mode === "floor")) {
        vals.set(id, n.depth);
        fresh.add(id);
        order.push(id);
        if (n.via !== undefined) vias.set(id, n.via);
        if (n.gap === undefined) complete.add(id);
        else gaps.set(id, n.gap);
        return n.depth;
      }
      stack.push(id);
      onStack.add(id);
      let d = n.depth;
      let ok = true;
      let gap: string | undefined;
      let best = -1;
      let derived = n.parents.length || n.plugin ? 1 : 0; // what the links alone prove
      for (const p of n.parents) {
        if (!known(p)) {
          if (n.resolved) continue; // Absolute memo at a forgotten frontier (F4).
          if (mode === "exact") {
            stop = { kind: "need", id: p };
            return d;
          }
          ok = false;
          gap ??= p;
          continue;
        }
        const via = visit(p, level + 1) + 1;
        if (stop) return d;
        if (via > best) {
          best = via;
          vias.set(id, p);
        }
        derived = Math.max(derived, via);
        d = Math.max(d, via);
        if (!complete.has(p)) {
          ok = false;
          gap ??= gaps.get(p);
        }
      }
      stack.pop();
      onStack.delete(id);
      const floor0 = n.depth;
      d = Math.min(d, MAX_DEPTH_HOPS);
      vals.set(id, d);
      order.push(id);
      if (ok) {
        complete.add(id);
        fresh.add(id);
        // The stored floor exceeds what the (now complete) links prove: it came
        // from evidence no longer tracked, which a backend walk cannot reproduce.
        if (floor0 > Math.min(derived, MAX_DEPTH_HOPS)) excess.add(id);
      } else if (gap !== undefined) {
        gaps.set(id, gap);
        fresh.add(id);
      }
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
    return { kind: "done", depth, vals, complete, order, start, excess, fresh, gaps, vias };
  }

  function touch(id: string, stamp: number): boolean {
    const n = get(id);
    if (!n) return false;
    n.lastTouch = stamp;
    const map = n.pinned ? pins : lru;
    map.delete(id);
    map.set(id, n);
    return true;
  }

  function memoize(r: Done, learned: Map<string, Node>): void {
    const stamp = clock();
    for (const id of r.order) if (!has(id)) adopt(id, node(id, learned));
    for (const id of r.order) {
      const n = get(id)!;
      n.depth = Math.max(n.depth, r.vals.get(id)!);
      if (r.complete.has(id)) n.resolved = true;
      if (r.fresh.has(id)) {
        n.fresh = true;
        n.gap = r.gaps.get(id);
        n.via = r.vias.get(id);
      } else changed(id, n); // a hop-cap floor depends on the level it was seen at
      if (r.excess.has(id)) pin(id, n);
    }
    // Reverse post-order: the start first, ancestors after it; then the start's
    // max path to the root, so a read keeps its whole critical ancestry warm in
    // O(MAX_DEPTH_HOPS) without touching every ancestor.
    for (let i = r.order.length - 1; i >= 0; i--) touch(r.order[i], stamp);
    let next = get(r.start)!.via;
    for (let hop = 0; next !== undefined && hop < MAX_DEPTH_HOPS && touch(next, stamp); hop++) next = get(next)!.via;
    trim(r.start);
  }

  function floor(id: string, learned: Map<string, Node>, reason: string): number | undefined {
    const r = climb(id, learned, "floor");
    if (!r) {
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
      unstray(lookup);
    });
    return lookup;
  }

  function unstray(lookup: Lookup): void {
    strayOrder.delete(lookup);
    const set = strays.get(lookup.id);
    if (set?.delete(lookup) && set.size === 0) strays.delete(lookup.id);
  }

  // A lookup that no walk awaits any more is detached: a late success is still
  // applied as evidence, and forget() can still cancel it. The throttle starts
  // now only if its last walk timed out; one released by forget() leaves no
  // throttle, so the next walk that needs the id starts a fresh lookup.
  // Strays are FIFO-capped (QA-1.2-R2-2): the oldest is cancelled, so its late
  // answer (backend evidence a later lookup reproduces) is discarded rather than
  // left beyond forget()'s reach. Strays never gate admission: a new lookup for
  // the same id waits only for its throttle, so dropping one admits nothing.
  function detach(lookup: Lookup, throttle: boolean): void {
    if (lookups.get(lookup.id) !== lookup) return;
    lookups.delete(lookup.id);
    lookup.detached = true;
    if (throttle) setFailed(lookup.id);
    let stray = strays.get(lookup.id);
    if (!stray) strays.set(lookup.id, stray = new Set());
    stray.add(lookup);
    strayOrder.add(lookup);
    while (strayOrder.size > maxEntries) {
      const oldest = strayOrder.values().next().value!;
      unstray(oldest);
      cancelLookup(oldest);
    }
  }

  function cancelLookup(lookup: Lookup): void {
    lookup.cancelled = true;
    lookup.cancel();
  }

  // A cancelled walk settles its callers with undefined and resumes at once, so
  // its continuation can never issue another lookup. It stays in `live` (and so
  // within reach of forget) until that continuation has returned. Whatever the
  // cause, it releases its lookup: the last walk out detaches it, so no lookup
  // stays in `lookups` without a walk awaiting it.
  function cancelWalk(walk: Walk, timedOut: boolean): void {
    walk.cancelled = true;
    if (walks.get(walk.id) === walk) walks.delete(walk.id);
    const lookup = walk.pending;
    walk.pending = undefined;
    if (lookup && --lookup.waiters === 0) detach(lookup, timedOut);
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
        const r = climb(id, learned, "exact");
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
    memoize(climb(id, learned, "floor")!, learned);
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
      const r = climb(id, learned, "exact");
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
        if (result !== timeout) {
          if (result === undefined) warn(id, "lookup", "lookup was cancelled because the session was forgotten; treating its depth as unknown");
          return result;
        }
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
      if (has(id)) drop(id, "forget");
      unbury(id);
      failedAt.delete(id);
      for (const kind of Object.keys(WARNINGS)) warned.delete(`${kind}:${id}`);
      // Cancelled before the walks, so releasing them below never strays it.
      const lookup = lookups.get(id);
      if (lookup) {
        cancelLookup(lookup);
        lookups.delete(id);
      }
      for (const walk of live) {
        walk.learned.delete(id);
        if (walk.id === id) cancelWalk(walk, false);
      }
      for (const stray of [...strays.get(id) ?? []]) {
        unstray(stray);
        cancelLookup(stray);
      }
    },
    sweep() {
      const now = clock();
      // A node idle for the TTL expires (pinned ones too: accepted residual F2)
      // unless it is an ancestor, within MAX_DEPTH_HOPS, of a node that did not
      // expire. A read touches only its critical path, so this keeps every
      // ancestor whose evidence a live node's depth depends on (an ancestor
      // further away can only confirm MAX), at O(nodes + ghosts + links) per
      // sweep and no cost per read (QA-1.2-R2-1). Ghosts follow the same rule,
      // and the BFS crosses them, so an evicted intermediate does not cut a live
      // node off from its pinned ancestors (QA-1.2-R3-1).
      const hops = new Map<string, number>();
      for (const map of [lru, pins, held, loose]) {
        for (const [id, x] of map) if (now - x.lastTouch < ttlMs) hops.set(id, 0);
      }
      ancestry(hops);
      for (const map of [lru, pins]) for (const id of map.keys()) if (!hops.has(id)) drop(id, "expire");
      for (const id of [...held.keys(), ...loose.keys()]) if (!hops.has(id)) unbury(id);
      for (const id of failedAt.keys()) throttled(id); // drops every expired entry
      for (const [key, stamp] of warned) if (now - stamp >= ttlMs) warned.delete(key);
    },
    size: () => lru.size + pins.size,
  };
}
