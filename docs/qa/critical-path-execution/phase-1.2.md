# Phase 1.2 — Cache-stable turn state

Worktree `D:\git\omr-cpx-p12`, branch `cpx/p12`, base tag `cpx/p12-base` = `4161324`. Started 2026-10-11 01:36.

## Pre-flight

- [x] Depends on 0.1: merged into `cpx/main` (`4161324`) on the owner's instruction to proceed while the 0.1 round-2 follow-ups finish. Binding new evidence from that follow-up (QA-0.1-17, C6 `all` variant at `6e9b645`): the plugin cannot put a 1-hour TTL on the tools breakpoint (`$.tools[17]` stays the host's 5-minute marker; the context event's `tools` has no cache field), so a 1-hour system/message marker would follow a 5-minute one — an order the provider documents as invalid. **D5 is withdrawn on v2.0.26** (amendment A-0.1-3, pending in `cpx/main`): 1.2.3 and 1.2.5.b/c are not applicable.
- [x] No in-flight phase writes this phase's files (`src\index.ts`, `src\routing\wire\hint.ts`, `src\compat\v2-hooks.ts`, `src\router\config.ts`, `docs\CONFIG_REFERENCE.md`, `docs\VERIFICATION.md`, `docs\OPENCODE_V2.md`, `test\unit\docs-drift.test.ts`, `test\golden\`, `test\unit\v2-hooks.test.ts`). Phase 1.1 edits `docs\ROUTING_ENGINE.md` (the 1.2 → 1.1 handoff text is applied there).
- [x] Worktree from `cpx/main`, tag pushed, `npm ci`, clean; typecheck green; scoped baseline (0.P) green.
- [x] Anchors (explorer `ses_ed6bffcdaffenUaigZQ7rRvObZ`) hold: `src\index.ts` system assembly ≈3026-3043, pending block ≈3055-3062 (`listPending` 3057, `buildPendingListBlock` 3058, push 3059), late notices ≈3065-3072 (`takeNotices` 3067), `router_verify` ≈1913-1921; `hint.ts` `buildHint` ≈58-65, protocol loop ≈206-211, advise `hintFor` ≈212, `system.push(hint)` ≈215; `v2-hooks.ts` `buildContext` ≈1363, system identity remap ≈1422-1443, message shape ≈1445-1472; `config.ts` `ROUTING_DEFAULTS` ≈3024-3042, `resolveRouting` ≈3120.
- [x] Goldens: only `test\golden\__snapshots__\assembled-prompt.golden.test.ts.snap` (≈46, 60, 181, 195) mentions `vrf_…`/"listed in the prompt" — protocol text, not the pending/late/hint blocks. All existing snapshots stay byte-identical (re-grep with the exact block strings before 1.2.6).
- [x] `smoke:cpx` green (3× at `7b11504`).

## Implementation notes

### 1.2.1 design memo (architect, heavy pin, `ses_ed6a5075dffec4ZbHlYgWIDbLW`)

**Problem.** On v2 the system array changes between turns, so the cached prefix misses: the pending list (`index.ts:3059`), late notices (`:3068`; `takeNotices` marks them delivered, so a failed request loses them), the advise route hint (`hint.ts:212-216`, memoised on the user text), and the generated `R:` line (recomputed every 60 s from the outcome store, `hint.ts:41`, `:120-139`, spliced into the protocol part `:206-211`). `v2-hooks.ts:1422-1443` keeps host parts by identity and rebuilds router parts; any change in router part count or text shifts everything after it.

**D5 withdrawn — consequences.** 1.2.3 not applicable (no `routing.promptCache.ttl`, no CONFIG_REFERENCE row, no drift pin; 1.2.6.c covers only docs). 1.2.5.b = "never change a system part's identity, order or text", no exception (nothing copies the last system part). 1.2.5.c not applicable; the second clause of the 1.2.5 criteria is dropped and `config.ts` leaves 1.2.5's Reads. O11 gate not applicable. QA focus "TTL before O11" becomes "any `ttl`/`ttlSeconds`, or any `cache` on a system part, set by the router". Smoke bullet 3 becomes "no block carries `ttl`; system blocks (including the host's markers) are byte-identical across requests". The cache hint is created by one parameterless function returning a fresh `{type:"ephemeral"}`; no TTL type exists in `turn-state.ts`. `hasActivity` stays (1.2.2.c), unused for caching.

**Shape.**
```
v2-hooks (adapter) ── creates TurnStateRegistry(logger, translate=v2Instructions)
   ├─ injects it as ctx.routerTurnState into the legacy plugin (same channel as routerHost/routerAgents)
   ├─ passes it to createSystemAugmenter({..., turnState})
   └─ buildContext: legacy transform → augment → system remap (unchanged) → Instructions-from block (unchanged)
                    → if root: tail = buildTurnState(sid); event.messages = placeTurnState(event.messages, tail)
index.ts  ── registers providers "late"(10), "pending"(20); on the root path sets output[TURN_STATE_ROOT]=true
hint.ts   ── registers provider "route-hint"(90); no system push when turnState is present; freezes the R: line per session
```

**`src/compat/turn-state.ts` (1.2.2)** — no side effects at load (importing on v1 does nothing).
```ts
export const TURN_STATE_MAX_CHARS = 6000;
export const PLAN_PROVIDER_NAME = "plan";              // reserved; order 0..9 reserved for it
export const TURN_STATE_ROOT: unique symbol = Symbol("router.turnState.root");
export interface TurnStateProvider { name: string; order: number; render(sid: string): string | undefined; active?(sid: string): boolean }
export interface TurnStateRegistry {
  registerTurnStateProvider(p: TurnStateProvider): () => void;
  buildTurnState(sid: string): string | undefined;
  hasActivity(sid: string): boolean;
}
export function createTurnStateRegistry(deps: { logger: { warn(m: string, meta?: object): void }; translate?: (t: string) => string }): TurnStateRegistry;
export function placeTurnState<M>(messages: readonly M[], tail: string | undefined, makeTail: (text: string) => M): M[] | undefined;
```
- Registration: `name` non-empty string, `order` finite, else throw; duplicate name throws; unregister idempotent and removes only its own registration (object identity); providers sorted by `(order, name)`.
- `buildTurnState`: (1) each provider's `render` in try/catch; a throw logged once per provider name per registry as `[router] turn state: provider "<name>" failed; section skipped` (error scrubbed), provider skipped. (2) Non-string or empty after `translate(s).trim()` skipped. (3) No sections → `undefined`. (4) `body = sections.join("\n\n")`, `out = "<router-state>\n" + body + "\n</router-state>"`. (5) `out.length <= 6000` (UTF-16 units; wrapper and overflow line count) → return. (6) Else drop whole body lines from the end (and trailing blank lines of the kept part), keeping the longest prefix for which `wrapper + kept + "\n" + overflow` fits; overflow = `… N more lines` (U+2026; N = non-blank dropped lines), plus ` (router_plan action=status)` only when a provider named `plan` is registered and `active(sid) === true`. Worst case: wrapper + overflow only. Lines never cut by character.
- `hasActivity(sid)`: any provider's `active?.(sid) === true`; a throw counts as false (same once-per-name log).
- `placeTurnState` (pure): `tail === undefined` → `undefined` (leave `event.messages` alone). Else `next = messages.slice()`; walk `i` from the last message down; find the last part `j` with `type === "text"`, string `text`, non-empty; on the first hit copy the part as `{ ...part, cache: { type: "ephemeral" } }`, build `content = m.content.slice()` with `content[j]` replaced, `next[i] = Object.assign(Object.create(Object.getPrototypeOf(m)), m, { content })` (the idiom of `v2-hooks.ts:1467-1468`), stop (this walk is the O12 rule). No text part anywhere → tail added, no hint. `next.push(makeTail(tail))`. Host messages, content arrays and parts are never mutated; the tail never gets a hint; exactly one router hint per request; no hint left on earlier messages.

**Providers (1.2.4).** `index.ts` at plugin init: `const turnState = isV2Host ? ctx.routerTurnState : undefined;` (`isV2Host` as at `:3029`). Only when defined:
- `late` (order 10): `render(sid)`: `background === undefined` → undefined; else add `background.takeNotices(sid)` to `lateBuffer`, return `buildLateNoticeBlock(lateBuffer.list(sid))`; `active` = buffer non-empty; background checked at render time (config reload respected).
- `pending` (order 20): `render(sid)` = `buildPendingListBlock(pending.listPending(sid, { verifying: background !== undefined }))` (same args as `:3057`); `active` = list non-empty.
- `lateBuffer`: `Map<sid, Map<handle, notice>>` first-seen order; repeated handle replaces text in place; cap 50 notices/session (oldest dropped), 100 sessions LRU (as `hint.ts:45,181`); buffers before building the block (a builder throw loses nothing).
- Transform (`:3043-3072`): after `push(systemPrompt)` and `poll()`: on v2 with a registry set `output[TURN_STATE_ROOT] = true` and nothing else; otherwise lines 3055-3072 moved verbatim into the `else` (no refactor). The flag is reached only on the root path (after the guard ≈2986 and the child return ≈3000-3016, graders via ≈2996).
- Retention (`router_verify` ≈1926-1940): after `verifyHandles` resolves, `lateBuffer?.release(sessionID, report.handles)` for every handle the report answers (pass, fail, unverifiable, unknown/expired); a throw or argument error releases nothing; scoped to the calling session (R6 ≈1934-1935). If the report has no structured handle list, add `handles: readonly string[]` (additive; `report.text` unchanged). v1 keeps one-time delivery.
- `hint.ts`: optional `turnState?: TurnStateRegistry`; when present register `route-hint` (order 90) `render: sid => routeHints.get(sid)` (LRU 100); `augment` starts with `routeHints.delete(input.sessionID)` before the `try` (early returns ≈191-203 leave no stale hint); at ≈213-216 with `turnState` set `routeHints.set(sid, hint)` and push nothing, without it keep today's push (existing hint tests green). `augment` runs before `buildTurnState`, so `render` stays synchronous. Update the module header (≈8-10, ≈16-19).
- **1.2.4.d (new; needed for the acceptance criterion "no router system part changes between turns"):** with `turnState` present, freeze the `R:` line per session: per-session `{memoKey, cfg, line}`, reused while `memoKey` and the `cfg` object are unchanged (`loadConfig` keeps identity, `v2-hooks.ts:1354`), LRU 100. Fresh routing evidence still reaches the model via the route hint in the tail; enforce mode decides at dispatch. Accepted cache breaks (documented): config/env change (`enfOn` ≈3027), agent catalog refresh (`rolesNow()`), model switch.

**Context hook (1.2.5).** Create the registry at adapter setup with `translate: v2Instructions` (router text was translated before, ≈1443); inject as `routerTurnState` next to `routerAgents`; pass to the augmenter. Lines 1422-1443 unchanged (no `cache` on any system part, no copy, no reorder). After ≈1472:
```ts
if (output[TURN_STATE_ROOT] === true && event.messages !== undefined) {
  try { const placed = placeTurnState(event.messages, turnState.buildTurnState(String(event.sessionID)), tailMessage);
        if (placed !== undefined) event.messages = placed; }
  catch (e) { warnTurnStateOnce(e); }   // never fails the request (≈1487-1490 rethrows otherwise)
}
```
Assign a new array (never push in place). `tailMessage(text)` = `{ role: "user", content: [{ type: "text", text }] }`, no `id` (or the fixed `"router-state"` if the type requires one; no clock, no random). Children, graders and role sessions never get the flag (no tail, no hint, 1.2.5.d); the context hook fires only for primary requests (≈1413). Check that `runtime?.applyChildSystem` (≈1444) does nothing for root sessions.

**Determinism.** Nothing pushed into `output.system` on v2 may depend on a clock or on store state that changes during a session. Ages only in the tail, `floor(ms/60000)` minutes from an injected `now`; no absolute timestamps, session ids or random values in the tail. If `buildPendingListBlock` prints finer than minutes, add an option whose default keeps today's text (v1 unchanged). Order `(order, name)`.

**v1 proof.** (1) v1 calls `experimental.chat.system.transform`; `context` is registered only via `ctx.session.hook` (v2-only). (2) `isV2Host` false and no `ctx.routerTurnState` on v1 → nothing registered/buffered. (3) v1 runs the `else` branch = lines 3055-3072 byte for byte. (4) `lateBuffer?.release` no-op on v1; `report.text` unchanged. (5) `hint.ts` is v2-only (`host: "v2"` ≈128; only caller `v2-hooks.ts:1439`; confirm with `rg "createSystemAugmenter|systemAugmenter" src`). (6) `turn-state.ts` has no load-time side effects. (7) Shared block builders unchanged or with default-preserving options. (8) Enforced by a new v1 characterisation snapshot, the existing goldens, `npm run smoke:v1`.

**Goldens.** All existing snapshots byte-identical. New: **v1 characterisation** `test\golden\v1-system-transform.golden.test.ts` (today's v1 `output.system` with 2 pending entries and 1 late notice) — the first, test-only commit of 1.2.4, recorded from the code before the change. **v2** `test\golden\v2-turn-state.golden.test.ts` (1.2.6): (a) full tail with late, pending, route hint; (b) overflow without plan activity, (c) with a fake active `plan` provider; (d) messages after the hook when the last real message is user text, (e) a tool result (O12), (f) empty state (array untouched); (g) `event.system` texts for a root session in advise mode (no hint, no pending part).

**Tests (1.2.7).** `turn-state.test.ts`: provider order incl. name tie-break; `undefined` for no state; exactly 6000 and 6001 chars (wrapper included); overflow with and without plan activity; throwing provider logged once across two builds; throwing `active`; duplicate names; unregister and stale unregister; `translate` before the bound; every `placeTurnState` case incl. no text anywhere and empty text parts. `v2-turn-state.test.ts` with deep-frozen host messages: pending 0 → 2 → 1 (`event.system` deep-equal, host parts identical by reference, tail differs); empty state → same `event.messages` reference; route hint in the tail, not in the system array; children/graders/role sessions get no tail/hint; exactly one router `cache` per request, never on the tail; O12; a late notice on two turns, gone after `router_verify` returns its handle, kept for a different handle and on a throw; a provider throw does not stop the request; no `ttlSeconds` anywhere and no `cache` on any system part; recording an outcome or moving `now` 2 minutes leaves `event.system` unchanged. `v2-hooks.test.ts`: update assertions expecting the hint/blocks in `event.system`. Smoke `cpx-cache-prefix.smoke.test.ts`: request N+1 equals request N through N's last real message except N's `cache_control` on it; N's tail absent from N+1; one request whose last real message is a tool result; no `ttl` on any block; total `cache_control` markers ≤ 4.

**Rejected options.** Root detection by a second `session.get` (extra RPC, can disagree with `graderSessions`) or by protocol-text heuristic (`hint.ts:192-196`); a module-singleton registry (duplicate names on re-init, test leaks); late retention by changing `takeNotices` to peek (changes v1); moving the `R:` line to the tail (the protocol stays in the system array; goldens pin it).

**Unconfirmed inputs (implementers check):** Appendix B layout (if it defines extra headers it wins; bound and overflow stay); C5 probe tail shape and consecutive `user` messages accepted; host markers + router hint ≤ 4 breakpoints (C6 showed 4 host markers incl. the message one — the router hint replaces the host's message marker, observed in C5 `userHint`); whether `pending.ts` prints ages; whether the verify report exposes handles.

## Findings

## Fixes

## Deferred findings

## Handoffs

## Verdict
