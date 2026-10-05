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

QA review, round 1 (adversarial, `0b1dc9f` + `b591032`). The repro sequences use the fixture's `getParent`, `now` and `logger` seams.

| id | severity | file:line | description | resolution |
|---|---|---|---|---|
| QA-1.2-1 | critical | `src/router/depth.ts:144,149,197,279` | **A walk's retained evidence is replaced by a poorer re-created node, so an exact depth comes out below truth.** `visit` prefers `nodes.get(id)` over `learned.get(id)` and then overwrites `learned` (149); `memoize` does the same (197). The need path in `depthOf` does not touch the start. If the start or a visited node is evicted (LRU or TTL) during the walk, and another lookup or event re-creates that id, the new object drops the conflicting or plugin links that the walk was holding. The walk then returns, and memoizes, a *complete* depth below the truth. **Repro, default `maxEntries`, `ttlMs: 100`.** Backend: X→P, Y→X, P root, Q→Q1→Q2→root. Sequence: `recordCreated(X,P)`; `recordCreated(X,Q)`; t=99 `depthOf(X)` (`getParent(P)` held); t=100 `sweep()`; `depthOf(Y)` (re-creates X as `[P]`); release P → `depthOf(X) === 1`. Truth is 3, and the control run without the Y walk gives 3. Later reads stay at 1. **Plugin variant (`maxEntries: 2`).** `recordPluginChild(X,C)`; `depthOf(X)` (C held); `recordRoot(Z1)`; `recordRoot(Z2)`; `depthOf(Y)` with Y→X and X→null → `depthOf(X) === 0` for a plugin child. Fix hint: when both objects exist, merge them (links via the `applyLink` rules, max depth, `plugin`/`rootSeen`) rather than replacing; add a regression test. | open |
| QA-1.2-2 | critical (extends accepted residual F2) | `src/router/depth.ts:83–85,196–204,292–298` | **Eviction drops non-backend evidence, and re-resolution through the backend then answers below truth.** This is wider than F2, which covers only the TTL path for a v1 child. It applies to LRU too, to evicted *ancestors* that carry conflicting event links, and to self-eviction: `memoize` touches the start first, so a new leaf is the first LRU victim of its own chain. (a) With `maxEntries: 2`: `recordRoot(R)`; `recordCreated(C,R)`; `recordPluginChild(X,C)` evicts X during its own record. `depthOf(X)` then calls `getParent(X)` → null → **0**, which also breaks I6 ("plugin children are never looked up"). (b) With `maxEntries: 4`, backend G→C→X→root: `recordRoot(X)`; C→X; G→C; `depthOf(G)`; then P0←P1←P2; `recordCreated(X,P2)` (X=3). `depthOf(G)` inserts G, which evicts X → **2** (truth 5). With the defaults this is reachable after ≥ 10 000 newer touches since the chain's last read, not only after 60 min idle. Either fix it (for example pin plugin-flagged and conflict-bearing nodes, or keep a bounded tombstone of non-backend floors), or have the owner re-accept F2 with the LRU and ancestor scope. | open |
| QA-1.2-3 | major | `src/router/depth.ts:273–279,327–339,350–362,236–241` | **A timed-out walk keeps running untracked.** On timeout, `depthOf` removes the walk from `walks` and detaches only its *current* lookup. `run()` continues anyway: after the detached lookup settles it starts *new attached* lookups that no caller awaits. That makes a second concurrent walk for the session, against the acceptance criterion "never more than one backend walk per session concurrently". `forget` cannot reach it: it is absent from `walks`, and `forget` only clears the `learned` maps of registered walks. **Repro (fake timers):** `getParent(X)` and `getParent(P)` held; `depthOf(X,{timeoutMs:10})` → undefined; `forget(X)` → `size()===0`; release X="P" → X is resurrected by the detached lookup's late success (`size()===1`, despite §6 "the late answer is discarded") and `getParent(P)` is issued by the orphan walk; release P → `size()===2`. Fix hint: mark the walk cancelled when its last caller times out (or keep it reachable for `forget`), and drop late successes for forgotten ids. | open |
| QA-1.2-4 | minor | `src/router/depth.ts:311,339` | **The timeout floor ignores what the walk has learned (F1).** `floor(id, learned, …)` uses the caller's local `learned` from the initial synchronous climb, not `walk.learned`. Under eviction it returns `undefined` or a weaker floor although the walk has already proven more. **Repro (`maxEntries: 1`):** backend X→P, P→Q, Q held; `depthOf(X,{timeoutMs:10})` → `undefined`, although X ≥ 2 was proven. Fix hint: use `walk.learned` (merged with the local map) on the timeout path. | open |
| QA-1.2-5 | minor | `src/router/depth.ts:72,233,336,367` | **`failedAt` has no cap.** `warned` is FIFO-capped at `maxEntries`, but `failedAt` is bounded only by `sweep()`, which is wired in Phase 2.3 and runs hourly. **Repro (`maxEntries: 10`, backend down):** 1 000 distinct `depthOf` failures, then the backend recovers. All 1 000 ids stay throttled (0 retries), so the 1 000 entries are still held. Fix hint: cap it like `warned`, or drop expired entries on write. | open |
| QA-1.2-6 | minor | `src/router/depth.ts:281–283,336,75–81` | **Throwing seams are not contained, and the `run()` catch path is untested** (lines 282–283 uncovered). `depthOf` *rejects* in two cases: when `now()` throws on the timeout path (`Error: clock`), and when `now()` throws inside `record` from a lookup (the catch's `warn` rethrows, so `run()` rejects). A throwing `logger.warn` makes `recordCreated(R,P)` after `recordRoot(R)` throw synchronously. There were no unhandled rejections, because `Promise.race` attaches handlers. This is low risk with `Date.now` and the plugin logger, but the suite's own throwing-`now()` test implies the contract. Fix hint: guard `warn` and the `depthOf` body, and cover 282–283. | open |
| QA-1.2-7 | minor | `src/router/depth.ts:130–193,196–203` | **The cost per call is O(reachable ancestors), not "≤ 33 Map reads" (§1).** Every `record*` and every `depthOf` re-climbs, and then re-touches (`delete`+`set`), the whole reachable DAG. Measured: single-parent chains with 10 000 nodes, record + read all: 175 ms. A 300-wide, 32-layer DAG with 2 parents per node: 18 600 records in 1.8 s and 0.35 ms per read. The same DAG with 4 parents: 38 400 records in 12.0 s and 1.27 ms per read. This needs systematic conflicting parents, so the impact is low. Fix hint: correct the memo's claim, or skip the climb on record when the node is unchanged. | open |

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

pending fixes

- QA round 1 on `0b1dc9f` + `b591032`: 7 open findings (2 critical, 1 major, 4 minor). Tests, coverage and typecheck are green.
- 1.2.1 was DESIGN READY. QA-1.2-2 needs an owner decision: fix it, or widen the accepted residual F2.
