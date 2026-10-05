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
type LookupResult = { ok: true; parent: string | null } | { ok: false; reason: string };
interface Lookup {
  id: string;
  promise: Promise<LookupResult>;
  detached: boolean;
  cancelled: boolean;
  cancel(): void;
}
interface Walk {
  id: string;
  promise: Promise<number | undefined>;
  learned: Map<string, Node>;
  pending?: Lookup;
  cancelled: boolean;
  cancel(): void;
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

  function warn(id: string, kind: "lookup" | "conflict", reason: string): void {
    const key = `${kind}:${id}`;
    if (warned.has(key)) return;
    warned.set(key, seams.now());
    while (warned.size > maxEntries) warned.delete(warned.keys().next().value!);
    seams.logger.warn(`[router] depth: ${kind === "lookup" ? "cannot resolve" : "conflicting evidence for"} session ${id}: ${reason}`);
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
      lastTouch: seams.now(),
    };
  }

  function applyLink(id: string, link: string | null, source: Source): void {
    const n = nodes.get(id);
    const plugin = source === "plugin";
    if (!n) {
      // Trim only after the floor climb touches this node's ancestors. Trimming
      // here could evict its known parent before deriving the new child's floor.
      nodes.set(id, makeNode(link, plugin));
      return;
    }
    if (plugin) n.plugin = true;
    if (link === null) {
      if (plugin) n.depth = Math.max(n.depth, 1);
      else if (!n.plugin) {
        if (n.parents.length) warn(id, "conflict", "root after parent");
        else n.rootSeen = true;
      }
      return;
    }
    if (n.parents.includes(link)) return;
    if (n.parents.length === MAX_PARENT_LINKS) {
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
      const n = nodes.get(id) ?? learned.get(id)!;
      // Retain visited evidence for the duration of this walk. Backend inserts
      // can evict the start (even with a one-entry cache); that must not turn
      // an event-proven child into a fresh backend root. Node references also
      // retain all conflicting links, not merely the last parent answer.
      learned.set(id, n);
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
      const n = nodes.get(id) ?? learned.get(id)!;
      n.depth = Math.max(n.depth, r.vals.get(id)!);
      if (r.complete.has(id)) n.resolved = true;
      n.lastTouch = seams.now();
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
    const age = seams.now() - stamp;
    return age >= 0 && age < DEPTH_LOOKUP_RETRY_MS;
  }

  function startLookup(id: string): Lookup {
    let cancel!: () => void;
    const cancelled = new Promise<LookupResult>((resolve) => {
      cancel = () => resolve({ ok: false, reason: "forgotten" });
    });
    const lookup: Lookup = { id, promise: cancelled, detached: false, cancelled: false, cancel };
    lookups.set(id, lookup);
    function fail(reason: string): LookupResult {
      if (!lookup.detached && !lookup.cancelled) failedAt.set(id, seams.now());
      return { ok: false, reason };
    }
    const request = Promise.resolve().then(() => seams.getParent(id)).then((raw): LookupResult => {
      if (lookup.cancelled) return fail("forgotten");
      if (raw !== null && !validId(raw)) return fail("malformed answer");
      failedAt.delete(id);
      record(id, raw, "backend");
      return { ok: true, parent: raw };
    }, (e: unknown) => fail(e instanceof Error ? e.message : String(e)))
      .catch((e: unknown) => {
        warn(id, "lookup", `internal lookup failure: ${String(e)}`);
        return fail("internal");
      });
    lookup.promise = Promise.race([request, cancelled]).finally(() => {
      if (lookups.get(id) === lookup) lookups.delete(id);
    });
    return lookup;
  }

  function startWalk(id: string): Walk {
    let cancel!: () => void;
    const cancelled = new Promise<undefined>((resolve) => { cancel = () => resolve(undefined); });
    const learned = new Map<string, Node>();
    const walk: Walk = { id, promise: cancelled, learned, cancelled: false, cancel };
    walks.set(id, walk);
    async function run(): Promise<number | undefined> {
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
          const result = await lookup.promise;
          walk.pending = undefined;
          if (walk.cancelled) return undefined;
          if (!result.ok) return floor(id, learned, result.reason);
          learned.set(r.id, nodes.get(r.id) ?? makeNode(result.parent, false));
        }
      } catch (e) {
        warn(id, "lookup", `internal walk failure: ${String(e)}`);
        return undefined;
      } finally {
        if (walks.get(id) === walk) walks.delete(id);
      }
    }
    walk.promise = Promise.race([run(), cancelled]);
    return walk;
  }

  function record(id: string, link: string | null, source: Source): void {
    if (!validId(id)) return;
    applyLink(id, link, source);
    const learned = new Map<string, Node>();
    const r = climb(id, learned, "floor");
    if (r?.kind === "done") memoize(r, learned);
  }

  return {
    recordRoot(id) { record(id, null, "event"); },
    recordCreated(id, parent) {
      if (parent == null || parent === "") record(id, null, "event");
      else if (validId(parent)) record(id, parent, "event");
    },
    recordPluginChild(id, creator) {
      record(id, validId(creator) && creator !== id ? creator : null, "plugin");
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
      const walk = walks.get(id) ?? startWalk(id);
      const t = Number.isFinite(options?.timeoutMs) && options!.timeoutMs! > 0
        ? options!.timeoutMs! : DEFAULT_DEPTH_TIMEOUT_MS;
      const timeout = Symbol("timeout");
      let timer!: ReturnType<typeof setTimeout>;
      const deadline = new Promise<typeof timeout>((resolve) => {
        timer = setTimeout(() => resolve(timeout), t);
        timer.unref?.();
      });
      try {
        const result = await Promise.race([walk.promise, deadline]);
        if (result !== timeout) return result;
        if (walks.get(id) === walk) walks.delete(id);
        const lookup = walk.pending;
        if (lookup && !lookup.detached) {
          lookup.detached = true;
          if (lookups.get(lookup.id) === lookup) {
            lookups.delete(lookup.id);
            failedAt.set(lookup.id, seams.now());
          }
        }
        return floor(id, learned, `timed out after ${t} ms`);
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
      for (const active of walks.values()) active.learned.delete(id);
      const walk = walks.get(id);
      if (walk) {
        walk.cancelled = true;
        walk.cancel();
        walks.delete(id);
      }
      const lookup = lookups.get(id);
      if (lookup) {
        lookup.cancelled = true;
        lookup.cancel();
        lookups.delete(id);
      }
    },
    sweep() {
      const now = seams.now();
      for (const [id, n] of nodes) if (now - n.lastTouch >= ttlMs) nodes.delete(id);
      for (const id of failedAt.keys()) if (!throttled(id)) failedAt.delete(id);
      for (const [key, stamp] of warned) if (now - stamp >= ttlMs) warned.delete(key);
    },
    size: () => nodes.size,
  };
}
