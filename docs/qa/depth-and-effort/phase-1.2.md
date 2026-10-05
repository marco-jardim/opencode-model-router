# Phase 1.2 — Depth tracker (M1)

## Pre-flight

- Worktree `D:\git\omr-de-p12`, branch `de/p12` (tracks `origin/de/p12`), clean at `c11e7a8` when task 1.2.1 started.
- Inputs: plan 1.2.2 (fixed API, D1–D3), spike A2; `src/index.ts:241,264–325,344–354,1519–1532`; `src/router/sessions.ts` sweep; SDK `Session.parentID?: string`.
- `DEFAULT_IDLE_TTL_MS` is exported from `src/router/idle-sweep.ts:1` (`60 * 60_000`). `sessions.ts`, `guard/store.ts` and `verify/*` all import it from there, so `depth.ts` does too (`import { DEFAULT_IDLE_TTL_MS } from "./idle-sweep"`).
- `SESSION_LOOKUP_RETRY_MS` is a private `const` in `src/index.ts:241`, so it can't be imported (the tracker must not depend on `index.ts`). `depth.ts` exports its own `DEPTH_LOOKUP_RETRY_MS = 30_000`.

### QA review, round 1 (`0b1dc9f` implementation, `b591032` tests)

- Scoped runs on `de/p12` at `b591032`:
  - `npx vitest run test/unit/depth.test.ts --maxWorkers=50%`: 1 file, 68/68 passed.
  - `npx vitest run --coverage --coverage.include=src/router/depth.ts test/unit/depth.test.ts`: statements 99.22 % (257/259), branches 98.29 % (173/176), functions 100 % (35/35), lines 99.04 % (208/210). Uncovered: `depth.ts:282–283` (the `run()` catch, see QA-1.2-6).
  - `npm run typecheck`: clean.
- Throwaway probes under `test/scratch/` (deleted, not committed) gave these results:
  - Ids `__proto__`, `constructor`, `hasOwnProperty`, `toString`, `valueOf`: exact depths and no spurious lookups. Maps are used throughout.
  - 100 concurrent `depthOf` for different ids sharing A→B→R: 103 `getParent` calls (one per leaf; A, B and R once each). This holds for both synchronous and staggered (0–6 ms) latencies.
  - Hop cap with partly known chains (events n0..n10, backend above): 32 edges → 32; 33 and 40 edges → 32. There are no lookups beyond the needed ids and none on re-ask.
  - Fake timers after the failure, throttle and timeout paths: `getTimerCount() === 0`. There were no `unhandledRejection` events, including with throwing seams.
  - A TTL sweep during an in-flight walk with no re-creation gives the correct depth, and the walk re-inserts the retained nodes.
- Implementer's reported deviations from §2–§6, as assessed:
  - **Trim after the floor memoization** (`depth.ts:102–105`, `204`). This is sound: it keeps the known parent while the new child's floor is derived. A side effect: when `maxEntries` ≤ the chain length, a new node is evicted by its own `record*` call (QA-1.2-2).
  - **Walk-local learned evidence keeps the visited nodes and their conflicting links** (`145–149`, `197`, `279`). This works only partly. It is defeated when `nodes` receives a re-created object for the same id (QA-1.2-1). `forget` clears only the `learned` maps of walks still registered in `walks` (QA-1.2-3).
  - **Reverse post-order cap memoization** (`189–190`). Verified: the stack nodes are appended in reverse, which keeps the ancestor-recency order. Hop floors `33 − L` are ≤ truth, and only MAX is marked complete.
  - **Explicit cancellation promises for `forget`** (`226–230`, `254–255`). Verified: awaiting callers settle promptly, no timers are involved, and there are no rejections. However, walks that were detached by a timeout cannot be reached by `forget` (QA-1.2-3).

## Implementation notes

Task 1.2.1 design for `src/router/depth.ts`. The plan fixes the API; this section is the contract for 1.2.2 and the oracle for the 1.2.3 tests.

### 1. Model and the key decision (adversarial i)

- **Truth** is the largest depth implied by any evidence received (D2: conflicts keep the larger depth).
- The tracker stores **evidence** (parent links), and also a per-node `depth` that is a **monotone floor**: a proven lower bound that never decreases while the node is tracked.
- **Decision: monotone floor + always-climb.** Every `depthOf` re-derives the depth synchronously by climbing *tracked* links (at most 33 levels, all map reads). It goes to the backend only for links that are not tracked. A conflict recorded on any ancestor is therefore seen by every descendant on its next read. No propagation pass or `children` index is needed.
  - *Amended by QA-1.2-7 (`e48fd26`):* each node keeps a memo (`fresh`, `gap`, critical parent `via`). Any evidence change, node creation or removal marks the tracked descendants stale through a parent→children index (stale-only, no values are pushed), and a climb recurses only into stale nodes. Conflicts are still seen by every descendant on its next read.
- **Rejected: eager propagation** (a parent→children index plus a raise/un-resolve BFS). That index has to outlive evicted intermediate nodes or raises get lost, and un-resolution is non-monotone. *Amended by QA-1.2-7:* the true per-call bound is not "≤ 33 Map reads". A read whose ancestry is unchanged costs O(links of the start) for the climb plus O(`MAX_DEPTH_HOPS`) touches of its critical path. After an evidence change, invalidation costs O(fresh descendants) once, and the first climb through the stale region recomputes each stale node once (O(stale nodes × links); per-call memo, never exponential). The 1.2-round-1 perf test (300×32 DAG, 4 parents per node, 37 500 records + 9 600 reads) runs in ≈ 0.3 s (was 17 s).
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

*Amended (QA-1.2-2, QA-1.2-7, QA-1.2-R2-2, QA-1.2-R2-3):* `nodes` is now two maps, `lru` and `pins`, under one `maxEntries` cap. Nodes also carry the memo fields `pinned`, `fresh`, `gap` and `via`. `strays` (FIFO-capped) holds the detached lookups. See §6.

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

*Rewritten for QA-1.2-R2-4. This section describes the code after QA-1.2-2 (`4c9e0d1`), QA-1.2-7 (`e48fd26`), QA-1.2-R2-1 (`50c4491`), QA-1.2-R2-2 (`b1d8d7b`) and QA-1.2-R2-3 (`198d205`).*

- **Two maps, one cap:**
  - Nodes live in two recency-ordered maps (oldest first).
    - `lru` holds *ordinary* nodes. A backend walk can reproduce their evidence, given the shared-source assumption of F6.
    - `pins` holds *pinned* nodes: plugin children, nodes with a recorded conflict, and nodes whose floor exceeds what their complete links prove (`excess`). Their evidence cannot be reproduced from the backend.
  - `size()` counts both maps, and a single `maxEntries` cap covers them, so `size() ≤ maxEntries` after every public call (I13, plan 1.2.2.e). Only `adopt` adds a node, and every `adopt` is trimmed within the same synchronous call. `pin` moves a node between the maps without changing the total, so the cap is never overshot between calls.
  - `trim(protect)` evicts ordinary nodes first, oldest first. `protect` is the node the current call has just recorded or read, and it goes last among them: its ancestors are evicted before it, and it re-resolves them later. It is evicted itself only when pinned nodes fill the whole cap, and only after its answer has been computed.
  - A pinned node is dropped only when pinned nodes alone exceed the cap. The victim is the oldest-touched pinned node other than `protect`, and a `dropping pinned evidence` warning is logged. This logged overflow is the only loss path besides the TTL. Reads touch only their critical path, so the victim can be a non-critical ancestor of a live node.
  - Evicting a node (LRU, TTL or overflow) clears the frontier memo (`resolved`) of its tracked children and marks its descendants stale. They then re-resolve the dropped id through the backend instead of trusting a memo that cannot see later conflicts above it. `forget` keeps the frontier (F4).
- **Touch rules (v):**
  - `touch(x)` sets `lastTouch = now()` and moves `x` to the end of its map. Only `memoize` calls it, and `memoize` runs on every read (`depthOf`, including the fast and failure paths) and every write (`record*`).
  - `memoize` touches the visited nodes in reverse post-order (start first), then the start's critical path (the `via` chain, ≤ `MAX_DEPTH_HOPS`). It does not touch every ancestor. A climb that stops at fresh memos visits only the start, so non-critical ancestors keep older stamps:
    - the LRU may evict an ordinary one, which costs a re-lookup but never gives a lower answer;
    - the TTL keeps every one of them while a descendant is live (`sweep()` below).
  - No other counter exists, so the accounting cannot drift. Placeholders, lookups, walks, strays, `failedAt` and `warned` are not nodes, and a failed lookup of an unknown id creates no node.
- **Ancestor recency is an efficiency property only.** Before QA-1.2-7 it was the correctness argument. Now a read keeps its critical path warm, so a re-read seldom needs a re-lookup. Correctness rests on three rules:
  - pinned nodes are never LRU-evicted;
  - `drop` un-resolves the dropped node's children;
  - `sweep` keeps the ancestors of live nodes.
- **`sweep()`** (QA-1.2-R2-1):
  - A node *survives* if `now - lastTouch < ttlMs`. A future stamp gives a negative difference, so it survives.
  - The sweep keeps every survivor and every tracked ancestor within `MAX_DEPTH_HOPS` hops of a survivor, whatever that ancestor's own stamp. It finds them with a multi-source BFS over the recorded links, where the first visit gives the shortest distance. Every other node is dropped, pinned nodes included (F2).
  - The bound is safe because a survivor's depth depends only on ancestors within 32 hops. Any longer path makes it ≥ 33, which is MAX, and the kept ancestor at hop 32 still has its link, so its floor of ≥ 1 keeps it there.
  - Cost: O(nodes + links) per sweep, which is ≤ `maxEntries × (1 + MAX_PARENT_LINKS)`, and nothing per read. The rejected alternative, refreshing every pinned ancestor on every read, would bring back the O(reachable ancestors) read cost that QA-1.2-7 removed.
  - The sweep also drops `failedAt` entries that no longer throttle, and `warned` entries older than `ttlMs`.
  - Defaults: `ttlMs = DEFAULT_IDLE_TTL_MS`, `maxEntries = 10_000`. Invalid option values fall back to the defaults: `ttlMs` must be finite and > 0, and `maxEntries` must be an integer ≥ 1.
- **Bounded side maps** (QA-1.2-5, QA-1.2-R2-2): `warned`, `failedAt` and the detached lookups (`strays`) are each FIFO-capped at `maxEntries`.
  - A stray beyond the cap is cancelled and its late answer discarded. That answer is backend evidence, so a later lookup reproduces it, and no late answer escapes `forget`.
  - Strays never decide whether a new lookup may start (admission). Per id, at most one *attached* lookup is in flight. If an id still has a stray pending at the backend, a new lookup for it starts only once its throttle lapses: `DEPTH_LOOKUP_RETRY_MS` after the detach, or sooner if `maxEntries` newer failures push it out of the `failedAt` FIFO.
  - So while the backend hangs, one more call per id can start each time its throttle lapses. The seam has no abort, so a cancelled stray's call may stay pending in the backend, but the tracker holds at most `maxEntries` strays.
- **Memoized depth is absolute:**
  - Evicting or forgetting an ancestor leaves a *resolved* descendant's answer unchanged, with no lookup (frontier rule).
  - An *unresolved* descendant looks the missing ancestor up again, as a new lifetime, and keeps its floor if that fails.
  - An evicted descendant is not a node, so it is looked up and never assumed to be a root. If the lookup fails, the answer is `undefined`, not 0.
- **`forget(id)`:**
  - Deletes the node, `failedAt[id]` and both `warned` keys.
  - Cancels and removes `walks[id]`: awaiting callers get `undefined`, and `id` is not re-memoized.
  - Cancels and removes `lookups[id]` and every stray of `id`: the late answers are discarded, and other walks awaiting the attached lookup settle at their floor with no throttle recorded.
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
- **F2 (residual, v1):** a v1 plugin child that is lost to the tracker gets re-resolved through the backend, which reports it as a root. It then reads depth 0, although the truth is ≥ 1. The same applies to every pinned node (conflicts, excess floors), because the backend cannot reproduce its evidence. *Scope after QA-1.2-2, QA-1.2-R2-1 and QA-1.2-R2-3:* a pinned node is never LRU-evicted. It is lost in exactly two ways:
  - (a) **Idle TTL:** neither the node nor any descendant within `MAX_DEPTH_HOPS` hops was touched for `DEFAULT_IDLE_TTL_MS` (60 min). Since R2-1, `sweep` keeps every ancestor of a live node, so a pinned node whose descendants are still read no longer expires.
  - (b) **Logged overflow:** more than `maxEntries` pinned nodes.

  This comes from bounded memory combined with v1 having no parentID. The real fix belongs in Phase 2: pass `toolCtx.sessionID` when creating v1 sessions.
- **F3 (open):** a grader's `parentID` may differ from its creator. Both links are kept and the larger depth wins, without a warning. Spike A2 covered producers only, so graders need confirmation in Phase 2.
- **F4 (residual):** `forget(intermediate)` followed by a conflict above it leaves resolved descendants at their memo (the frontier rule). This is deliberate: `forget` keeps the frontier, so the descendants of a deleted session keep their depth without a lookup.
  - Eviction cannot cause this. `drop()` clears the tracked children's `resolved` on every eviction (LRU, TTL, pinned overflow) and marks the descendants stale, so they re-resolve the dropped id through the backend. The round-2 fuzz found no frontier memo created by eviction.
  - Before QA-1.2-7 this relied on the ancestor-recency invariant, which is now only an efficiency property (§6).
  - The clock cannot cause it either: TTL retention keeps ancestors because their descendants survive, not because of the ancestors' own stamps, and LRU order does not use the clock.
- **F5:** `DEPTH_LOOKUP_RETRY_MS` duplicates the private `SESSION_LOOKUP_RETRY_MS`. Phase 2 can have `index.ts` import it.
- **F6 (residual, accepted — event-vs-backend disagreement, QA-1.2-R2-4):** a conflict is pinned only if the tracker holds both sides at once.
  - If the first side was evicted before the contradicting evidence arrives, the new evidence creates or extends an *ordinary* node. Examples of a first side: a backend root, an event root, or an event link.
  - The node's next eviction leaves only the backend's answer, which may be lower.
  - OpenCode's session events and session.get both read the same session record, and a session's parentID is immutable, so the two sources cannot legitimately disagree; a disagreement is only protected while the tracker holds both sides. Accepted by the orchestrator (0.P rules) as a documented limit.

QA review, round 1 (adversarial, `0b1dc9f` + `b591032`). The repro sequences use the fixture's `getParent`, `now` and `logger` seams.

| id | severity | file:line | description | resolution |
|---|---|---|---|---|
| QA-1.2-1 | critical | `src/router/depth.ts:144,149,197,279` | **A walk's retained evidence is replaced by a poorer re-created node, so an exact depth comes out below truth.** `visit` prefers `nodes.get(id)` over `learned.get(id)` and then overwrites `learned` (149); `memoize` does the same (197). The need path in `depthOf` does not touch the start. If the start or a visited node is evicted (LRU or TTL) during the walk, and another lookup or event re-creates that id, the new object drops the conflicting or plugin links that the walk was holding. The walk then returns, and memoizes, a *complete* depth below the truth. **Repro, default `maxEntries`, `ttlMs: 100`.** Backend: X→P, Y→X, P root, Q→Q1→Q2→root. Sequence: `recordCreated(X,P)`; `recordCreated(X,Q)`; t=99 `depthOf(X)` (`getParent(P)` held); t=100 `sweep()`; `depthOf(Y)` (re-creates X as `[P]`); release P → `depthOf(X) === 1`. Truth is 3, and the control run without the Y walk gives 3. Later reads stay at 1. **Plugin variant (`maxEntries: 2`).** `recordPluginChild(X,C)`; `depthOf(X)` (C held); `recordRoot(Z1)`; `recordRoot(Z2)`; `depthOf(Y)` with Y→X and X→null → `depthOf(X) === 0` for a plugin child. Fix hint: when both objects exist, merge them (links via the `applyLink` rules, max depth, `plugin`/`rootSeen`) rather than replacing; add a regression test. | fixed in `80afc33`: a retained copy and a re-created node are merged (`absorb`: union of links under the §3 rules, max floor, plugin/root flags), a node entering the map takes over every live walk's copy (`adopt`), lookup results carry the recorded node, and a joining caller's snapshot is merged. Tests "QA-1.2-1: …" (TTL repro + control, plugin variant via TTL, root/link merge warnings, floor-raising merge). |
| QA-1.2-2 | critical (extends accepted residual F2) | `src/router/depth.ts:83–85,196–204,292–298` | **Eviction drops non-backend evidence, and re-resolution through the backend then answers below truth.** This is wider than F2, which covers only the TTL path for a v1 child. It applies to LRU too, to evicted *ancestors* that carry conflicting event links, and to self-eviction: `memoize` touches the start first, so a new leaf is the first LRU victim of its own chain. (a) With `maxEntries: 2`: `recordRoot(R)`; `recordCreated(C,R)`; `recordPluginChild(X,C)` evicts X during its own record. `depthOf(X)` then calls `getParent(X)` → null → **0**, which also breaks I6 ("plugin children are never looked up"). (b) With `maxEntries: 4`, backend G→C→X→root: `recordRoot(X)`; C→X; G→C; `depthOf(G)`; then P0←P1←P2; `recordCreated(X,P2)` (X=3). `depthOf(G)` inserts G, which evicts X → **2** (truth 5). With the defaults this is reachable after ≥ 10 000 newer touches since the chain's last read, not only after 60 min idle. Either fix it (for example pin plugin-flagged and conflict-bearing nodes, or keep a bounded tombstone of non-backend floors), or have the owner re-accept F2 with the LRU and ancestor scope. | fixed in `4c9e0d1` (owner decision: fix): pinned map for plugin, conflict and excess-floor nodes, own `maxEntries` cap, logged overflow; eviction clears the children's frontier memo; the current node is never its own trim's victim; I6 holds. Tests "QA-1.2-2: …" (repros (a), (b), self-eviction, conflict above an evicted ancestor, logged overflow, excess pinning, TTL residual). Amended: one-slot walk 12→11 lookups, conflict-node size 1→2, T-lru 3→4 slots. |
| QA-1.2-3 | major | `src/router/depth.ts:273–279,327–339,350–362,236–241` | **A timed-out walk keeps running untracked.** On timeout, `depthOf` removes the walk from `walks` and detaches only its *current* lookup. `run()` continues anyway: after the detached lookup settles it starts *new attached* lookups that no caller awaits. That makes a second concurrent walk for the session, against the acceptance criterion "never more than one backend walk per session concurrently". `forget` cannot reach it: it is absent from `walks`, and `forget` only clears the `learned` maps of registered walks. **Repro (fake timers):** `getParent(X)` and `getParent(P)` held; `depthOf(X,{timeoutMs:10})` → undefined; `forget(X)` → `size()===0`; release X="P" → X is resurrected by the detached lookup's late success (`size()===1`, despite §6 "the late answer is discarded") and `getParent(P)` is issued by the orphan walk; release P → `size()===2`. Fix hint: mark the walk cancelled when its last caller times out (or keep it reachable for `forget`), and drop late successes for forgotten ids. | fixed in `be82886`: walks count their callers and the last timed-out caller cancels the walk, which resumes at once and issues no further lookups; walks stay in `live` and detached lookups in `strays` until they settle, and `forget` cancels both. Tests "QA-1.2-3: …" (repro, late answer without forget, shared deadlines, shared lookup). |
| QA-1.2-4 | minor | `src/router/depth.ts:311,339` | **The timeout floor ignores what the walk has learned (F1).** `floor(id, learned, …)` uses the caller's local `learned` from the initial synchronous climb, not `walk.learned`. Under eviction it returns `undefined` or a weaker floor although the walk has already proven more. **Repro (`maxEntries: 1`):** backend X→P, P→Q, Q held; `depthOf(X,{timeoutMs:10})` → `undefined`, although X ≥ 2 was proven. Fix hint: use `walk.learned` (merged with the local map) on the timeout path. | fixed in `16693de`: the timeout fallback climbs `walk.learned` (a new walk adopts the caller's snapshot, a joining caller merges its own). Tests "QA-1.2-4: …" (repro → 2). |
| QA-1.2-5 | minor | `src/router/depth.ts:72,233,336,367` | **`failedAt` has no cap.** `warned` is FIFO-capped at `maxEntries`, but `failedAt` is bounded only by `sweep()`, which is wired in Phase 2.3 and runs hourly. **Repro (`maxEntries: 10`, backend down):** 1 000 distinct `depthOf` failures, then the backend recovers. All 1 000 ids stay throttled (0 retries), so the 1 000 entries are still held. Fix hint: cap it like `warned`, or drop expired entries on write. | fixed in `e16ea52`: `failedAt` is FIFO-capped at `maxEntries` and an expired entry is dropped when read. Test "QA-1.2-5: …" (1 000 failures, 10 slots). Amended: T-warn lookup counts 3→4 and 4→5. |
| QA-1.2-6 | minor | `src/router/depth.ts:281–283,336,75–81` | **Throwing seams are not contained, and the `run()` catch path is untested** (lines 282–283 uncovered). `depthOf` *rejects* in two cases: when `now()` throws on the timeout path (`Error: clock`), and when `now()` throws inside `record` from a lookup (the catch's `warn` rethrows, so `run()` rejects). A throwing `logger.warn` makes `recordCreated(R,P)` after `recordRoot(R)` throw synchronously. There were no unhandled rejections, because `Promise.race` attaches handlers. This is low risk with `Date.now` and the plugin logger, but the suite's own throwing-`now()` test implies the contract. Fix hint: guard `warn` and the `depthOf` body, and cover 282–283. | fixed in `89018ba`: `now()`, `logger.warn`, rejection reasons and `timeoutMs` getters are contained where they are read (an undelivered warning is retried later). The `run()` and lookup catch-alls (old 282–283, 267–270) were dead after containment and are removed; the containment handlers are covered. Tests "QA-1.2-6: …". Amended: the internal-failure test now expects the contained clock failure to resolve to 0. |
| QA-1.2-7 | minor | `src/router/depth.ts:130–193,196–203` | **The cost per call is O(reachable ancestors), not "≤ 33 Map reads" (§1).** Every `record*` and every `depthOf` re-climbs, and then re-touches (`delete`+`set`), the whole reachable DAG. Measured: single-parent chains with 10 000 nodes, record + read all: 175 ms. A 300-wide, 32-layer DAG with 2 parents per node: 18 600 records in 1.8 s and 0.35 ms per read. The same DAG with 4 parents: 38 400 records in 12.0 s and 1.27 ms per read. This needs systematic conflicting parents, so the impact is low. Fix hint: correct the memo's claim, or skip the climb on record when the node is unchanged. | fixed in `e48fd26`: stale-marking memo + critical-path touches; §1 bound corrected. Tests "QA-1.2-7: …" (300×32, 4 parents, top-down ≈ 0.3 s and bottom-up ≈ 0.2 s, < 2 s bound; conflict above a wide DAG). |

### Round 2

QA review, round 2 (adversarial re-review of `80afc33`, `4c9e0d1`, `be82886`, `16693de`, `e16ea52`, `89018ba`, `e48fd26`; diff `cec9ace..12902a8`). The scratch tests were throwaway files under `test/scratch/`, deleted before this commit. They used three copies of `depth.ts` taken from `0b1dc9f`, `4c9e0d1` and `e48fd26` for bisection.

- Scoped runs at `12902a8`: `npx vitest run test/unit/depth.test.ts --maxWorkers=50%` gives 97/97 passed. `npm run typecheck` is clean.
- Every round-1 repro was re-run with its exact round-1 sequence:

| round-1 id | status | evidence (scratch re-run) |
|---|---|---|
| QA-1.2-1 | resolved | TTL repro: `depthOf(X)` = 3, and so does a re-read. Y = 4. The control run without Y also gives 3. The original plugin variant (`maxEntries: 2`, Z1/Z2 inserts) gives X = 1 and Y = 2, with no `getParent("X")`. |
| QA-1.2-2 | resolved | (a) X = 2 with no `getParent("X")`. (b) G = 5. |
| QA-1.2-3 | resolved | After a timeout and `forget(X)`, a late `X="P"` leaves `size() === 0`. The only call is `[["X"]]` (no orphan `getParent("P")`), and the timer count is 0. |
| QA-1.2-4 | resolved | `maxEntries: 1`, Q held: the timeout returns 2. |
| QA-1.2-5 | resolved | 1 000 failures with 10 slots, then recovery: 990 of 1 000 ids are retried at once. |
| QA-1.2-6 | resolved | A throwing clock on the timeout path → 1. A throwing clock inside a backend record → 1. A throwing logger on root→link does not throw. No `unhandledRejection` occurred in any scratch file. |
| QA-1.2-7 | resolved | 10 000-node chain, record and read: 39 ms (was 175 ms). 300×32 DAG with 2 parents: records 117 ms, 0.003 ms per read (was 1.8 s and 0.35 ms). With 4 parents: records 207 ms, 0.003 ms per read (was 12.0 s and 1.27 ms). |

- **Fuzz** of the new mechanisms: 5 configurations × 400 seeds × 160–200 operations, against an oracle that takes the union of all evidence. The backend is consistent with the first event of each id, conflicts are recorded as one atomic pair, and plugin children are v1 (the backend says root). Both sequential and concurrent `depthOf` were driven. With no eviction, and with LRU caps of 3, 4 and 6, it found **0 failures**:
  - The results match the oracle exactly, except after a logged pinned overflow.
  - Every concurrent result lies within [oracle at start, oracle at end].
  - G2 held: `getParent` was never called for a tracked id (checked in sequential mode).
  - The internal invariants held after every operation: `lru`/`pins` are disjoint, `pinned` matches the map a node is in, the `kids` index is consistent in both directions, and each map stays within its own cap.
  - Stale marking: a stale node has no fresh non-terminal child. Fresh *terminal* (MAX) children of stale parents do occur, and they are harmless (see R2-4).
- **Attacks that held:**
  - Refcount cancellation: a still-awaited walk is never cancelled by another caller's deadline, and a cancelled walk issues no further lookup (it resumes on `stopped` before any `climb`).
  - `waiters` cannot be decremented twice on either the run path or the cancel path.
  - Merge (`absorb`/`adopt`/`node`): a link is never counted twice, because depth is a max over the link union. Plugin flags merge before links, so a plugin copy raises no spurious conflict. All live walks' copies are unified on adoption.
  - Pinned overflow is logged before the drop.
  - Timers are always cleared.
  - The seams are contained.

| id | severity | file:line | description | resolution |
|---|---|---|---|---|
| QA-1.2-R2-1 | critical (extends accepted residual F2; regression from `e48fd26`) | `src/router/depth.ts:467–472,667–670` | **The TTL drops a pinned ancestor that is not on the critical path while its descendants are still read. A later raise above it is then never propagated, so the answer is below the truth.** `memoize` now touches only the start's `via` chain, so a pinned conflict ancestor on a non-critical branch keeps its old `lastTouch` and `sweep()` drops it, even though its parent and child are read regularly. The backend cannot reproduce its evidence (that is why it was pinned), so the re-lookup loses the link, and any later raise above it never reaches the descendants. **Repro (`ttlMs: 100`, backend answers null for everything):** `recordRoot(Q)`; `recordRoot(A)`; `recordCreated(A,Q)` (A is a pinned conflict); chain b0..b4; `recordCreated(X,b4)`; `recordCreated(X,A)` (X = 5, via b4). At t=60 and t=120, `depthOf(X)` and `depthOf(Q)` are called. At t=160 `sweep()` drops A only. Then chain c0..c9 and `recordCreated(Q,c9)` (Q = 10, so the truth is A = 11 and X = 12). Result: `depthOf(X) === 5`, with one `getParent("A")` (→ root) and no warning about the lost evidence. **Bisection:** `4c9e0d1` gives 12; `e48fd26` and HEAD give 5. The §6 claim "Non-critical ancestors may age out first; that costs a re-lookup, never a lower answer" is false for pinned nodes. F2 covers *idle* sessions, but this node is not idle in the round-1 sense, because its descendants are being read. Fix hint: in `sweep()`, keep the upward closure (over `parents`) of every node that survives the TTL. That costs O(nodes + links) per hourly sweep and adds no per-read cost. The other option is to touch pinned ancestors on read. Add the repro as a regression test. | fixed in `50c4491`. `sweep()` keeps every tracked ancestor within `MAX_DEPTH_HOPS` hops of a node that survives the TTL, found by a multi-source BFS over the recorded links. That costs O(nodes + links) per sweep and nothing per read, so the QA-1.2-7 read bound holds. Refreshing the pinned ancestors on every read was rejected because it brings back the O(reachable ancestors) read. Tests "QA-1.2-R2-1: …": the repro gives X = 12 and A = 11 with no lookup, plus the 32-hop bound of the closure. Pre-fix they gave 5, and size 2 instead of 34. |
| QA-1.2-R2-2 | minor | `src/router/depth.ts:111,528–538,520–524` | **`strays` has no cap.** A detached lookup is held until its `getParent` settles, so a backend call that never settles stays reachable for ever. `failedAt` and `warned` are FIFO-capped (QA-1.2-5), but `strays` is not. Each id adds one stray per 30 s window while the backend hangs. **Repro (`maxEntries: 10`, `getParent` never settles):** 1 000 distinct `depthOf(…, {timeoutMs: 1})` → `strays.size === 1000`, while `failedAt` and `warned` are 10 and `walks`, `lookups` and `size()` are 0. (The internal maps were inspected through a `Map` subclass.) Fix hint: FIFO-cap `strays` at `maxEntries` and cancel the evicted lookups. Alternatively, record a bounded per-id "forgotten" generation that a late answer must match, and drop the set. | fixed in `b1d8d7b`. `strays` is FIFO-capped at `maxEntries`, and the oldest stray is cancelled, so its late answer is discarded. Strays never gated admission, so dropping one admits nothing earlier. §6 states the exact per-id bound: one attached lookup, plus one more call per throttle lapse while the backend hangs. Tests "QA-1.2-R2-2: …": the cap with a discarded late answer (pre-fix size 1, not 0), and two strays of one id that `forget` still reaches. |
| QA-1.2-R2-3 | minor | `src/router/depth.ts:200–207,674`; `phase-1.2.md` §7 I13; plan 1.2.2.e | **`size()` is no longer bounded by `maxEntries`.** `lru` and `pins` each have their own `maxEntries` cap, so `size()` can reach 2 × `maxEntries`. **Repro (`maxEntries: 3`):** three `recordPluginChild(pN, null)` and three `recordRoot(rN)` → `size() === 6`. I13 ("`size() ≤ maxEntries` always") and the plan's "memory does not grow past `maxEntries`" no longer hold, and §6 does not say so. Code read, not reproduced: `pin()` reached from `absorb` inside a climb that returns `need` runs with no `trim`, so `pins` can briefly exceed its cap until the next `memoize`. Fix hint: enforce one joint cap (evict from `lru` while `lru.size + pins.size > maxEntries`, and drop pinned nodes only when `lru` is empty). Otherwise amend I13, §6 and the plan text to 2 × `maxEntries`, with an owner decision. | fixed in `198d205` with a single global cap, the preferred option, so I13 and the plan text stand. `size() ≤ maxEntries` now holds. Ordinary nodes are evicted first; the current node goes last, and only when pinned nodes fill the cap. Pinned nodes are dropped, with a warning, only when they alone exceed the cap. `pin()` only moves a node between maps, so the transient overshoot is gone. Tests "QA-1.2-R2-3: …": the repro gives 3, not 6, and the bound holds across a suspended walk and a conflict pin. Amended: the one-slot conflict walk ends at size 1 (was 2); the re-created plugin child uses 3 slots (was 2); the excess-floor test is triggered by `forget(X)`, because an ordinary C can no longer outlive a pinned overflow. |
| QA-1.2-R2-4 | minor | `docs/qa/depth-and-effort/phase-1.2.md` F2, F4, §6, `## Verdict`; `src/router/depth.ts:171–172` | **The residuals are not stated accurately.** (a) F2 "lost only to this idle TTL" omits R2-1: the evidence is also lost when only descendants are read. (b) F4 still says eviction cannot cause it "because of the ancestor-recency invariant", but §6 now downgrades that invariant. The real reason is that `drop()` clears the children's `resolved`. The conclusion still holds: the fuzz found no frontier memo created by eviction. (c) The event-vs-backend disagreement is not recorded anywhere in this report (code read, not reproduced). A conflict is pinned only if the tracker holds both sides at once. If the first side (for example a backend or event root) was LRU-evicted before a contradicting event link arrives, the link creates an unpinned node, and the next eviction loses it to the backend's answer, which may be lower. This is acceptable only because `session.created` and `session.get` share a source; that assumption has to be written down and accepted. (d) The `invalidate` comment says "a stale node has only stale tracked children", but fresh terminal (MAX) children of stale parents occur. This is harmless, because everything below a terminal node is MAX, but the comment is inaccurate. (e) Until this round, `## Verdict` still carried the round-1 text ("QA-1.2-2 needs an owner decision"). Fix hint: amend F2 and F4, add the disagreement residual with its preconditions, and correct the comment. | fixed in `1ae6cfa`. §6 is rewritten for the final code. F2 now names both loss paths. F4 credits `drop()` clearing the frontier rather than ancestor recency. New F6 records the event-vs-backend disagreement, accepted by the orchestrator under the 0.P rules. The `invalidate` comment now states that a stale node has no fresh non-terminal child. `## Verdict` is updated in the resolutions commit. |

### Round 3

QA review, round 3. Under §0.7 this round covers only the fix of the round-2 critical finding, QA-1.2-R2-1 (`50c4491`: the sweep keeps the ancestors of nodes that survive the TTL), and the eviction change it interacts with, QA-1.2-R2-3 (`198d205`: one global cap, ordinary nodes evicted first, pinned nodes dropped with a warning only on pinned overflow). Diff: `cf59700..37f74e9 -- src/router/depth.ts`. The scratch tests were throwaway files under `test/scratch/`, deleted before this commit.

- Scoped run at `37f74e9`: `npx vitest run test/unit/depth.test.ts --maxWorkers=50%` gives 103/103 passed. The QA-1.2-R2-1 regression test is the exact round-2 repro, and it gives 12.
- **Attacks that held:**
  - *Cycles in the sweep traversal.* The BFS enqueues each id at most once (`hops.has(p)`), so A↔B and a self-link both terminate. A cycle stays tracked while a descendant lives, and that descendant reads MAX.
  - *Ancestors beyond 32 hops.* An ancestor whose shortest distance from every survivor is 33 or more can only add to a path of at least 33 edges, so the survivor is MAX anyway. The node at hop 32 keeps its link, and `drop()` un-resolves it, so it re-fetches its parent rather than reading as a root. The test with a 40-edge chain covers this: 34 nodes kept, L = MAX, no lookups.
  - *Sweep cost is linear.* A 312×32 DAG with 4 parents per node (about 10 000 nodes and 40 000 links) sweeps in 12 ms when everything survives, 20 ms when nothing does and 7 ms when only the leaves survive. A 10 000-node chain with one live leaf takes 9 ms and keeps 34 nodes. A fan-in of 10 000 expired children under one root takes 8 ms. `drop()`'s invalidation marks each node stale at most once per sweep, so there is no O(n²) path.
  - *Kept ancestors and the single cap.* `sweep()` only removes nodes, so keeping ancestors can never trigger a trim. `trim`'s first loop evicts from `lru` only. A pinned node therefore leaves only through the TTL rule or the overflow loop, and the overflow loop logs `dropping pinned evidence` before the drop (checked with the pinned set at the cap plus one more plugin child).
  - *Single-cap exactness fuzz.* LRU only, no sweep: 8 ids, a backend that agrees with every event, and v1 plugin children that the backend reads as roots; 300 seeds × 150 operations per cap. The oracle is the union of all evidence. Caps 2, 3, 4, 6 and 100 checked 22 282, 27 392, 28 749, 29 470 and 29 634 reads, with **0 mismatches**. Each seed stopped at its first logged pinned overflow (128 seeds at cap 2, 49 at cap 3, 14 at cap 4). `size() ≤ maxEntries` held after every operation.

| id | severity | file:line | description | resolution |
|---|---|---|---|---|
| QA-1.2-R3-1 | major (incomplete fix of QA-1.2-R2-1; extends accepted residual F2) | `src/router/depth.ts:705–717` (sweep BFS, `if (hops.has(p) \|\| !has(p)) continue;` at 712), `213` (LRU loop of `trim`) | **The sweep's retention BFS walks only tracked links, so an ordinary intermediate that the LRU has evicted cuts it. A pinned ancestor above that intermediate then expires on the TTL while its descendant is still live. Its evidence cannot be reproduced from the backend, so later answers fall below the truth, with no warning.** Under the single cap, an ordinary node that is kept only as an ancestor is never touched (it is off the critical path, or kept by the sweep with its old stamp), so it sits at the head of `lru` and is the first victim of any pressure. With pinned nodes exactly at the cap (no overflow, no warning), every ordinary node is evicted by its own call, so no ordinary intermediate stays tracked at all. **Repro A** (the R2-1 shape; `ttlMs: 100`, `maxEntries: 30`; backend M→A, bᵢ→bᵢ₋₁, everything else null): `recordRoot(Q)`; `recordRoot(A)`; `recordCreated(A,Q)` (A is a pinned conflict); `recordCreated(M,A)`; chain b0..b4; `recordCreated(X,b4)`; `recordCreated(X,M)` (X = 5 via b4). At t=60, `depthOf(X)` = 5 and `depthOf(Q)` = 0; then 22 `recordRoot(Zᵢ)` evict M and nothing else. At t=120, `depthOf(Q)`. At t=150, `sweep()` drops A (size 30 → 29). Then `recordCreated(Q,b4)` makes Q = 5, so the truth is A = 6, M = 7 and X = 8. Result: `depthOf(X)` = 5, `depthOf(M)` = 1, `depthOf(A)` = 0, with lookups of M and A and only the conflict warnings. The control run without the Z roots gives 8, 7 and 6 with no lookups. **Repro B** (no conflict, only v1 plugin evidence; `ttlMs: 100`, `maxEntries: 7`; backend C→U, U→V, M→P, K→S, and P, S, V null): `recordCreated(C,U)` (C has floor 1, U unresolved); `recordPluginChild(P,C)`; `recordCreated(M,P)`; `recordPluginChild(S,M)`; 4 `recordRoot(Zᵢ)` evict M. At t=60, `recordCreated(K,S)` touches only K and S. At t=150, `sweep()` drops P. Result: `depthOf(K)` = 5 (truth 6), S = 4 (5), M = 1 (4) and P = 0 (3), with **no warning at all**. The control run without the Z roots gives 6, 5, 4 and 3. **Window:** the intermediate is evicted (at least `maxEntries` newer ordinary touches, or pinned nodes at the cap), and the sweep runs before any exact read through it. An exact read re-fetches the intermediate and touches the ancestor; a record, a throttled read or a timed-out floor read below it does not. This contradicts §6 ("the TTL keeps every one of them while a descendant is live") and F2 (a). **Fix hint:** let the BFS cross evicted intermediates. For example, `drop(id, true)` writes a bounded `ghosts` entry (evicted id → its parents) when `id` still has a tracked child or a ghost child; the map is FIFO-capped at `maxEntries`, deleted on `adopt`/`forget`, and pruned by the sweep when unreached; the sweep then traverses ghost links as ordinary hops. Add repros A and B as regression tests. Otherwise the orchestrator accepts it as a documented residual, and F2 (a) and §6 state the precondition. | open |

- **Minor and nit observations, accepted — QA round limit (§0.7):**
  - *(minor) Read cost with pinned nodes at the cap.* Every ordinary node is evicted by its own call, so each read re-walks through the backend (at most `FETCH_BUDGET` lookups per read). The answers stay exact (see the fuzz), and the precondition is 10 000 pinned sessions.
  - *(nit) Pinned-overflow victim order.* `memoize` touches the start before its critical path, so the most recently read pinned leaf is dropped before its idle pinned ancestors. The drop is logged, and any victim loses evidence that the backend cannot reproduce.
  - *(nit) Overflow warnings are once per id.* `evict:<id>` warns once per id while the `warned` entry lives, so a pinned node that is re-created and overflows again within the TTL is not logged a second time. This matches the warn-once design (I17).

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
- Phase 2.1: `MAX_DEPTH_HOPS` (32, `depth.ts`) must equal Phase 1.1's `MAX_DELEGATION_DEPTH_LIMIT` (32, `src/router/config.ts`, not merged here). The tracker does not import it (I19). Phase 2.1 pins the equality with a test after both branches merge.

## Verdict

Open findings: 1 (QA-1.2-R3-1, major, is open; every round-1 and round-2 finding is fixed)

- QA round 3 on `37f74e9` (§0.7 scope: the fixes of QA-1.2-R2-1 and QA-1.2-R2-3): 1 major finding, QA-1.2-R3-1, open. The R2-1 fix holds whenever every intermediate is tracked, but an LRU-evicted ordinary intermediate cuts the sweep's retention. Three minor or nit observations are accepted under the QA round limit.
- QA round 1 on `0b1dc9f` + `b591032`: 7 findings (2 critical, 1 major, 4 minor), all resolved (see the round-2 status table).
- QA round 2 on `12902a8`: 4 findings (1 critical: QA-1.2-R2-1; 3 minor: QA-1.2-R2-2..4), all fixed in `50c4491`, `b1d8d7b`, `198d205` and `1ae6cfa`. Under §0.7 every round-2 finding is fixed, whatever its severity. From round 3 on, only `blocking`, `critical` and `major` findings are fixed.
- Accepted residuals: F2 (v1 parentID, Phase 2), F4 (`forget` frontier), F6 (event-vs-backend disagreement, accepted by the orchestrator).
- Scoped runs at `1ae6cfa`:
  - `npx vitest run test/unit/depth.test.ts --maxWorkers=50%`: 103/103 passed.
  - Coverage of `depth.ts`: statements 99.19 %, branches 96.88 %, functions 100 %, lines 100 %.
  - `npm run typecheck`: clean.
