# Phase 1.2 — Depth tracker (M1)

## Pre-flight

- Worktree `D:\git\omr-de-p12`, branch `de/p12` (tracks `origin/de/p12`), clean at `c11e7a8` when task 1.2.1 started.
- Inputs: plan 1.2.2 (fixed API, D1–D3), spike A2; `src/index.ts:241,264–325,344–354,1519–1532`; `src/router/sessions.ts` sweep; SDK `Session.parentID?: string`.
- `DEFAULT_IDLE_TTL_MS` is exported from `src/router/idle-sweep.ts:1` (`60 * 60_000`). `sessions.ts`, `guard/store.ts` and `verify/*` all import it from there, so `depth.ts` does too (`import { DEFAULT_IDLE_TTL_MS } from "./idle-sweep"`).
- `SESSION_LOOKUP_RETRY_MS` is a private `const` in `src/index.ts:241`, so it can't be imported (the tracker must not depend on `index.ts`). `depth.ts` exports its own `DEPTH_LOOKUP_RETRY_MS = 30_000`.

## Implementation notes

Task 1.2.1 design for `src/router/depth.ts`. The plan fixes the API; this section is the contract for 1.2.2 and the oracle for the 1.2.3 tests.

### 1. Model and the key decision (adversarial i)

- **Truth** is the largest depth implied by any evidence received (D2: conflicts keep the larger depth).
- The tracker stores **evidence** (parent links), and also a per-node `depth` that is a **monotone floor**: a proven lower bound that never decreases while the node is tracked.
- **Decision: monotone floor + always-climb.** Every `depthOf` re-derives the depth synchronously by climbing *tracked* links (at most 33 levels, all map reads). It goes to the backend only for links that are not tracked. A conflict recorded on any ancestor is therefore seen by every descendant on its next read. No propagation pass or `children` index is needed.
- **Rejected: eager propagation** (a parent→children index plus a raise/un-resolve BFS). That index has to outlive evicted intermediate nodes or raises get lost, and un-resolution is non-monotone. The climb costs ≤ 33 Map reads per call, which is negligible at one call per delegation.
- **Memoization:** every node visited by a climb gets its floor raised, and it is marked `resolved` when the climb was complete. The memo acts as the absolute base only at the **frontier**: a resolved node whose parent is no longer tracked is used as-is, with no lookup (§6). So "stops at the first ancestor with known depth" holds for *backend* walking: `getParent` is never called on or beyond a tracked node.
- Everything runs on one JS thread. State changes are synchronous, each climb is atomic, and `await` happens only at lookup boundaries.

### 2. Constants and data structures

```ts
export const MAX_DEPTH_HOPS = 32;
export const DEPTH_LOOKUP_RETRY_MS = 30_000;            // mirrors index.ts:241
export const DEFAULT_DEPTH_TIMEOUT_MS = 2_000;
export const DEFAULT_DEPTH_MAX_ENTRIES = 10_000;
const MAX_PARENT_LINKS = 4;                              // conflict overflow → MAX (fail closed)
const FETCH_BUDGET = 2 * (MAX_DEPTH_HOPS + 1);           // lookups per walk; exceeded → MAX
interface Node {
  parents: string[];  // distinct links; [] = anchor (proven root, or plugin floor)
  depth: number;      // floor, integer 0..MAX_DEPTH_HOPS, never decreases
  resolved: boolean;  // last full climb had no missing link; reset to false only when a link is added
  plugin: boolean;    // set by recordPluginChild: root evidence is ignored silently
  rootSeen: boolean;  // authoritative root evidence received (for the conflict warning)
  lastTouch: number;  // seams.now() at last touch
}
type LookupResult = { ok: true; parent: string | null } | { ok: false; reason: string };
interface Lookup { id: string; promise: Promise<LookupResult>; detached: boolean; cancelled: boolean }
interface Walk { id: string; promise: Promise<number | undefined>; pending?: Lookup; cancelled: boolean }
nodes: Map<string, Node>      // Map order IS the LRU list (oldest first); size() === nodes.size
walks: Map<string, Walk>      // ≤1 in-flight depthOf per queried id
lookups: Map<string, Lookup>  // ≤1 attached in-flight getParent per id
failedAt: Map<string, number> // throttle, keyed by the id whose getParent failed/timed out
warned: Map<string, number>   // keys "lookup:<id>" | "conflict:<id>" → stamp; capped at maxEntries (FIFO)
```

**Complete nodes vs placeholders (G2, vi, vii).**
- Every entry in `nodes` is *complete*: its own links are known from root evidence, a parentID, a backend answer, or a plugin anchor.
- A **placeholder** is an id that only appears in someone's `parents`. It is not a node, it is not counted by `size()`, it is never assumed to be a root, and it adds nothing until it is looked up.
- `getParent(id)` is called only when all four hold:
  - (a) `id` is not a node;
  - (b) a climb needs it, either as the queried id or as a link of an *unresolved* node;
  - (c) no lookup is attached for it (otherwise the caller joins that lookup);
  - (d) it is not throttled.
- Consequences:
  - A tracked id is never looked up.
  - The one successful lookup starts its tracked lifetime.
  - Failed retries happen at most once per 30 s.
  - A plugin child is a node from `recordPluginChild` on, so `getParent(child)` never happens while it is tracked. With a null creator it is an anchor and causes no lookups at all.
  - With an untracked creator `C`, only `getParent(C)` can occur. That is the caller's own lookup, which can never report the child as a root.

### 3. Recording evidence — `applyLink(id, link, src)`, then a floor climb

Input normalisation (never throw):
- An invalid `sessionID` (non-string or `""`) makes the call a no-op.
- `recordCreated` `parentID`:
  - `null`, `undefined` or `""` → root evidence;
  - non-empty string → link;
  - any other type → the call is ignored.
- `recordPluginChild` `creatorID`:
  - non-empty string ≠ `sessionID` → link (`src = plugin`);
  - anything else → plugin anchor.
- `recordRoot` → root evidence.

| Existing node | Evidence | Effect | Warn (`conflict:<id>`, once) |
|---|---|---|---|
| absent | root | `{parents:[], depth:0, resolved:true, rootSeen:true}` | – |
| absent | plugin anchor | `{parents:[], depth:1, resolved:true, plugin:true}` | – |
| absent | link P | `{parents:[P], depth:1, resolved:false, plugin: src==="plugin"}` | – |
| anchor, !plugin | root | `rootSeen = true` | – |
| has parents, !plugin | root | **ignored** (keep links; their depth ≥ 1 > 0 is the larger one) | yes |
| plugin | root (event/backend) | ignored (v1 producers have no parentID) | – |
| any | plugin anchor | `plugin = true; depth = max(depth, 1)` | – |
| P already linked | link P | no-op (`plugin ||= src==="plugin"`) | – |
| anchor (root or plugin) | link P | push P; `resolved=false`; `depth=max(depth,1)` | only if `rootSeen && !plugin && src!=="plugin"` |
| has parents, P new | link P | push P; `resolved=false` | if `src!=="plugin" && !node.plugin` |
| `parents.length === MAX_PARENT_LINKS` | new link | `depth = MAX; resolved = true` (terminal) | yes |

- "Keep the larger" is never an overwrite. Links accumulate, and the climb takes the max over all of them.
- A self-link (`P === id`) is stored and the climb reports a cycle (→ MAX).
- New nodes are appended (most recent), then `trimLRU()`. `applyLink` never touches an existing node; `memoize` does all touching.
- After `applyLink`, every `record*` runs `memoize(climb(id, ∅, "floor"))`. That is how "known parent ⇒ parent+1 immediately" works: the floor climb yields `max(1, depth(P)+1)` and sets `resolved` iff the chain is complete. It also re-touches the chain (§6).

### 4. The synchronous climb

```
climb(start, learned: Map<id, string|null>, mode: "exact"|"floor") →
  { kind:"done", depth, vals, complete:Set, order:id[] } | { kind:"need", id } | undefined (floor, start unknown)
known(x)  = nodes.has(x) || learned.has(x)
links(x)  = nodes.get(x)?.parents ?? (learned.get(x) == null ? [] : [learned.get(x)])
floor0(x) = nodes.get(x)?.depth ?? (learned.get(x) === null ? 0 : 1)
visit(x, level):                                  // recursion depth ≤ 34, so recursion is fine
  if vals.has(x) return vals.get(x)
  if stack.includes(x) throw CAP(cycle) ; if level > MAX_DEPTH_HOPS throw CAP(hops)
  d = floor0(x); if d >= MAX { vals[x]=MAX; complete+=x; order.push(x); return MAX }  // terminal
  stack.push(x); ok = true; n = nodes.get(x)
  for p of links(x):
    if !known(p):
      if n?.resolved: continue                    // frontier: absolute memo, no lookup (§6)
      if mode === "exact": throw NEED(p)
      ok = false; continue                        // floor mode: missing link adds nothing
    d = max(d, visit(p, level+1) + 1); ok &&= complete.has(p)
  stack.pop(); d = min(d, MAX); vals[x] = d; if ok complete+=x; order.push(x); return d
top: if !known(start): return mode==="exact" ? need(start) : undefined
     try { return done(visit(start, 0)) }
     catch NEED(p) → need(p)
     catch CAP → for stack[L] (start is L=0): vals = cycle ? MAX : min(MAX, MAX_DEPTH_HOPS+1-L),
                 complete iff vals===MAX, append to order; return done(MAX)
memoize(r, skip?): for x of reverse(r.order)      // start first, root last (§6)
     if x===skip continue; n = nodes.get(x) ?? createFrom(learned[x]); n.depth = max(n.depth, r.vals[x])
     if r.complete.has(x) n.resolved = true; touch(x)
   then trimLRU()
```

### 5. depthOf, walks and lookups

```
depthOf(id, opts):
  if !validId(id) return undefined
  t = (isFinite(opts?.timeoutMs) && opts.timeoutMs > 0) ? opts.timeoutMs : DEFAULT_DEPTH_TIMEOUT_MS
  r = climb(id, ∅, "exact"); if done → memoize(r); return r.depth        // no timer, no backend call
  if throttled(r.id) && !lookups.has(r.id) → return settleFloor(id, ∅, `throttled at ${r.id}`)
  w = walks.get(id) ?? startWalk(id)                                      // join (single flight)
  timer = setTimeout(resolve TIMEOUT, t); timer.unref?.()
  try { v = await Promise.race([w.promise, timeoutPromise]); if v !== TIMEOUT return v
        if walks.get(id) === w: walks.delete(id)          // later callers start fresh
        L = w.pending; if L && !L.detached: L.detached = true
            if lookups.get(L.id) === L: lookups.delete(L.id); failedAt.set(L.id, now())
        return settleFloor(id, ∅, `timed out after ${t} ms`) }
  finally { clearTimeout(timer) }
startWalk(id): w = {id, cancelled:false}; walks.set(id, w); w.promise = run(w); return w
async run(w):                                             // NEVER rejects
  learned = new Map(); fetches = 0
  try loop:
    r = climb(w.id, learned, "exact")
    if done → memoize(r); return r.depth
    if throttled(r.id) && !lookups.has(r.id) → return settleFloor(w.id, learned, "throttled")
    if ++fetches > FETCH_BUDGET → warnOnce(w.id, "fetch budget"); return MAX   // not memoized
    L = lookups.get(r.id) ?? startLookup(r.id); w.pending = L
    res = await L.promise; w.pending = undefined
    if w.cancelled return undefined                       // forget(w.id) mid-walk (§6)
    if !res.ok → return settleFloor(w.id, learned, res.reason)
    learned.set(r.id, res.parent)
  catch e → warnOnce(w.id, "internal"); return undefined
  finally if walks.get(w.id) === w: walks.delete(w.id)    // synchronous, before the promise settles
startLookup(id): L = {id, detached:false, cancelled:false}; lookups.set(id, L)
  L.promise = Promise.resolve().then(() => seams.getParent(id))   // a sync throw becomes a rejection
    .then(raw => { if L.cancelled return fail("forgotten")
        p = raw === null ? null : (typeof raw === "string" && raw !== "") ? raw : INVALID
        if p === INVALID return fail("malformed answer")           // never inferred as root
        failedAt.delete(id); applyLink(id, p, "backend"); return {ok:true, parent:p} },
      e => fail(message(e)))
    .catch(() => fail("internal"))
    .finally(() => { if lookups.get(id) === L: lookups.delete(id) })
  fail(reason): if !L.detached && !L.cancelled: failedAt.set(id, now()); return {ok:false, reason}
settleFloor(id, learned, reason): r = climb(id, learned, "floor"); if !r return warnOnce(id, reason), undefined
  memoize(r); if !r.complete.has(id) warnOnce(id, reason); return r.depth
throttled(x) = failedAt.has(x) && 0 <= now() - failedAt.get(x) < DEPTH_LOOKUP_RETRY_MS
warnOnce(id, why): key "lookup:"+id; once per key; logger.warn(`[router] depth: cannot resolve session ${id}: ${why}`)
```

- **What `depthOf` returns:**
  - an invalid id → `undefined`;
  - chain complete (in memory or after a walk) → exact depth;
  - failure, timeout or throttle → the start's **floor** if anything is known about it, otherwise `undefined`;
  - cycle or > 32 edges → `MAX_DEPTH_HOPS`;
  - lookup budget exceeded → `MAX_DEPTH_HOPS` (not memoized).
- **Floor-only sessions:**
  - A plugin anchor answers its floor (≥ 1) synchronously.
  - An unresolved node first tries to complete. If that fails it answers its floor, never `undefined` and never less than the floor.
  - Rationale: floor ≤ truth, so a refusal based on it is always correct, and it never allows more than `undefined` would. This refines the plan's "returns undefined on timeout/error" (see F1).
- **(ii) A stale in-flight walk cannot poison later calls:**
  - A timeout detaches the walk and its pending lookup from the maps, and sets the throttle at the moment of the timeout.
  - When a detached lookup settles late: a success is applied (it is valid evidence and monotone); a failure changes no throttle or warning.
  - The next eligible call starts a fresh lookup.
- **(iii) Mid-walk events:**
  - `run` re-climbs after every `await`, and its result comes from one synchronous climb over the *current* state.
  - A conflicting backend answer goes through `applyLink`, so the larger depth wins and a warning is emitted.
  - If an event fills the gap and the lookup then fails, `settleFloor` finds the chain complete and returns the exact depth without warning.
- **(iv) Throttling never hides a recovered backend:**
  - `failedAt` is written only when an attached lookup fails or at a timeout.
  - A success deletes it, and nothing refreshes it.
  - The first call at `failedAt + 30 000` or later issues a lookup. A clock going backwards counts as not throttled.
- **Rejections and timers:**
  - Lookup and walk promises never reject (every chain ends in `.catch`), so a timed-out walk cannot cause an unhandled rejection.
  - The only timers are the per-call ones, cleared in `finally` and `unref`'d. The sync fast path and the throttled path create no timer.

### 6. Eviction, touch, forget

- **Touch rules (v):**
  - `touch(x)` sets `lastTouch = now()` and does `nodes.delete(x); nodes.set(x, n)`. It is called only by `memoize`.
  - `memoize` runs on every read (`depthOf`, including the fast and failure paths) and every write (`record*`).
  - It touches in reverse post-order: the start first, ancestors after it, roots last.
  - `trimLRU()` evicts `nodes.keys().next()` while `size > maxEntries`.
  - No other counter exists, so accounting cannot drift. Placeholders, lookups, walks, `failedAt` and `warned` are not nodes. A failed lookup of an unknown id creates no node.
- **Ancestor-recency invariant:** after every public call, each tracked link `C → P` has `P` later in the LRU order than `C`, and `P.lastTouch ≥ C.lastTouch`. As a result:
  - LRU and TTL evict descendants no later than their ancestors.
  - An intermediate node is never evicted while a descendant that climbs through it is still tracked, except via `forget`, cycles, or a non-monotone `now()` (F4).
- **`sweep()`:**
  - Deletes nodes with `now - lastTouch >= ttlMs`. Future stamps give a negative difference and are kept.
  - Drops `failedAt` entries that are no longer throttling, and `warned` entries older than `ttlMs`.
  - Defaults: `ttlMs = DEFAULT_IDLE_TTL_MS`, `maxEntries = 10_000`. Invalid option values fall back to the defaults: `ttlMs` must be finite and > 0; `maxEntries` must be an integer ≥ 1.
- **Memoized depth is absolute:**
  - Evicting or forgetting an ancestor leaves a *resolved* descendant's answer unchanged, with no lookup (frontier rule).
  - An *unresolved* descendant looks the missing ancestor up again, as a new lifetime, and keeps its floor if that fails.
  - An evicted descendant is not a node, so it is looked up and never assumed to be a root. If the lookup fails, the answer is `undefined`, not 0.
- **`forget(id)`:**
  - Deletes the node, `failedAt[id]` and both `warned` keys.
  - Cancels and removes `walks[id]`: awaiting callers get `undefined`, and `id` is not re-memoized.
  - Cancels and removes `lookups[id]`: the late answer is discarded, and other walks awaiting it settle at their floor with no throttle recorded.
  - Descendants keep their links to `id` and their floors.
  - `forget` is not a tombstone: later evidence re-creates the node.

### 7. Invariants → tests (1.2.3)

| # | Invariant | Proving test(s) |
|---|---|---|
| I1 | Invalid ids or args never throw. Record calls become no-ops, `depthOf` gives `undefined`, `size()` is unchanged. | T-input: `""`, `undefined`, numbers, objects for every method |
| I2 | A tracked node's depth never decreases. | T-mono: root after child, `recordCreated(id, null)` after link, backend null after link |
| I3 | Conflicts raise descendants (adversarial i). | T-conflict-raise: `recordRoot(X)`, `C→X` gives 1; chain R→Q→P gives P=2; `recordCreated(X,P)` → `depthOf(C)===4`, one warning, 0 lookups |
| I4 | Out-of-order events resolve correctly. | T-ooo: G(C), C(R), `recordRoot(R)` → G=2, C=1, 0 lookups |
| I5 | Known parent ⇒ parent+1 immediately; unknown parent ⇒ lazy resolution. | T-created-known; T-created-unknown (lookup of P only) |
| I6 | G2: no lookup for tracked ids; plugin children are never looked up; a null creator causes no lookups. | T-g2: count `getParent` per id across repeated `depthOf`; T-plugin-v1: backend would say root but `getParent(child)` is never called and the answer is ≥ 1 |
| I7 | Single flight per queried id and per looked-up id. | T-flight: 5× `depthOf(X)` gives 1 call per id; `depthOf(X)` and `depthOf(Y)` sharing ancestor A give `getParent(A)` once |
| I8 | Cycles and > 32 hops give MAX, and the walked path is memoized. | T-cycle (A↔B, self-parent, backend loop); T-hops (chain of 33 edges → 32; chain of 40 → 32) |
| I9 | A timeout returns the floor or `undefined` at `t`, warns once per id, leaves no unhandled rejection, and no pending timers. | T-timeout (fake timers, `unhandledRejection` spy, timer count 0) |
| I10 | The throttle window is exactly 30 s, and a late failure does not extend it. | T-throttle: t0 failure; t0+29 999 → no call; t0+30 000 → call and recovery; T-late-fail |
| I11 | A stale in-flight walk does not poison later calls. | T-detach: hung `getParent`, timeout, then a call after the window issues a fresh lookup; late success applied, late failure ignored |
| I12 | A mid-walk event gives a consistent result. | T-midwalk: event during `await`; conflicting backend answer → larger + warn; failing lookup with the gap filled → exact, no warn |
| I13 | The LRU bound holds without drift. | T-lru: `size() ≤ maxEntries` always; reads don't grow size; leaf evicted before ancestors |
| I14 | TTL sweep follows the stated rules. | T-ttl: idle ≥ ttl evicted, future stamp kept, ancestors kept as long as descendants are |
| I15 | Memoized depth is absolute; an evicted id is looked up again. | T-absolute: evict an ancestor → same depth, 0 lookups; evicted leaf with failing lookup → `undefined` (not 0) |
| I16 | Plugin children follow D3. | T-plugin: creator d → d+1; creator null or unknown → 1; never 0 after root evidence; no warning |
| I17 | Each conflict warns once per node; warnings are bounded. | T-warn: root→parent, two parents, link overflow → MAX |
| I18 | `forget` semantics hold. | T-forget: mid-walk forget; descendants unchanged; no resurrection from a cancelled lookup |
| I19 | The tracker does not depend on `index.ts`. | T-imports: `depth.ts` imports only `./idle-sweep` |

## Findings

- **F1 (decision):** on failure, timeout or throttle, `depthOf` returns the known floor and returns `undefined` only when nothing is known. The plan text says "undefined". The floor is ≤ truth and never more permissive than `undefined`. QA should assert against this memo.
- **F2 (residual, v1):** a v1 plugin child that stays idle ≥ `DEFAULT_IDLE_TTL_MS` (60 min) is evicted. The backend then reports it as a root, so it gets depth 0 although the truth is ≥ 1. This comes from bounded memory combined with v1 having no parentID. The real fix belongs in Phase 2: pass `toolCtx.sessionID` when creating v1 sessions.
- **F3 (open):** a grader's `parentID` may differ from its creator. Both links are kept and the larger depth wins, without a warning. Spike A2 covered producers only, so graders need confirmation in Phase 2.
- **F4 (residual):** `forget(intermediate)` followed by a conflict above it leaves resolved descendants at their memo. Eviction cannot cause this, because of the ancestor-recency invariant. A clock going backwards could weaken TTL ordering; LRU ordering does not depend on the clock.
- **F5:** `DEPTH_LOOKUP_RETRY_MS` duplicates the private `SESSION_LOOKUP_RETRY_MS`. Phase 2 can have `index.ts` import it.

## Deferred by plan

- Wiring `sweep()` into `createIdleTtlSweeper` (Phase 2.3).
- Guard refusal and warn-once per caller (D1/D2).
- Feeding `recordRoot` from backend answers.
- `session.created` → `recordCreated`.
- Producer/grader → `recordPluginChild`.
- `forget` on deletion.

## Handoffs

- 1.2.2 (@medium): implement `src/router/depth.ts` exactly as in §2–§6. No design decisions are left open.
- 1.2.3 (QA): T-* tests per §7. Attack I3, I6, I10–I12 and I15 first.
- Phase 2 owner: F2, F3, F5.

## Verdict

1.2.1 DESIGN READY. Implementation and verification are pending in 1.2.2 and 1.2.3.
