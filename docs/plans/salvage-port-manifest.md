# Wave 0 Manifest — Salvage Port Reconnaissance

**Produced:** 2026-08-18
**Master at recon time:** `f55c46d`
**Salvage branch:** `salvage-local-work` @ `eec22f9`
**Merge base:** `b8bef975bdf23e41d90ce2b82944c5e9be231fde`

This manifest is the committed output of Wave 0 (tasks T0.1–T0.6). It fixes the final owned-path
lists, the Wave 1 concurrency shape, where deferred integrations land, the R1 guard value, and the
bucket (c) status. Later phases re-verify what can age; they do not re-litigate what is fixed here.

---

## 1. R1 guard — `activePreset` (T0.3)

Verbatim, `tiers.json:2`:

```json
  "activePreset": "anthropic",
```

The global DoD asserts this value is unchanged at every wave close. The R1 assertion test lands in a
**new** test file (`test/unit/preset-guard.test.ts`, Phase 3A owned) rather than in
`test/unit/config.validate.test.ts`, because that file is touched by in-flight PR #25 (see §6).

`tiers.json` has **no top-level `enforcement` key**. Top-level keys today: `activePreset`,
`activeMode`, `tierCaps`, `tierPrompts`, `presets`, `taskPatterns`, `modes`, `fallback`, `rules`,
`defaultTier`.

## 2. Bucket (c) status (T0.5)

**OPEN — PR #28** (`refactor/verify-wiring`, lucashungaro, opened 2026-08-18T22:44Z). Checked
2026-08-18. `src/verify/wiring.ts` does not exist on master. Bucket (b) (catalog/discovery):
**unopened**. **Wave 3 gate: closed.** Wave 3 does not begin until #28 merges (21-day timeout per
plan).

## 3. Contingency ruling — S1 and S2 both need `index.ts` (T0.1, T0.2)

Reconnaissance confirmed the plan's pre-authorised contingency fires:

- **S1 (path scoping):** the producer's cwd is not reachable at check time on master. The
  `Delegation` literal (`src/index.ts:610`), the artefact object (`:599-605`) and `buildGateDeps`
  (`:438-449`, hardcodes `cwd: ctx.directory` at `:442`) carry no producer cwd. Full integration
  requires `src/index.ts` (capture + threading) and `src/verify/gate.ts` (`Delegation.cwd`,
  `resolveBaseDir` seam — salvage `gate.ts:161`).
- **S2 (idle sweep):** the salvage wiring point is the `"chat.message"` hook top
  (`src/index.ts:725` on master; salvage called `sweepIdleStores()` there), inside `index.ts`.

**Ruling (pre-authorised, recorded, not asked):** Wave 1 lands pure modules, store methods and
tests with **no `index.ts` edits and no behaviour change**. Wave 2 (Phase 4) absorbs both
integrations plus the time-box.

## 4. Final owned paths per phase

| Phase | Wave | Owned paths | Touches `index.ts`? |
|---|---|---|---|
| P1 — path scoping | 1 | `src/verify/paths.ts`, `src/verify/deterministic.ts`, `src/verify/checker.ts`, `test/unit/cwd-scoping.test.ts` | **No** |
| P2 — idle-TTL eviction | 1 | `src/router/idle-sweep.ts`, `src/guard/store.ts`, `src/router/sessions.ts`, `src/telemetry/trajectory.ts`, `src/verify/dispatch.ts`, `test/unit/store-eviction.test.ts` | **No** |
| P3A — grounding clause | 1 | `tiers.json` (tierPrompts only), `test/unit/preset-guard.test.ts`, golden snapshots (at serialisation point only) | **No** |
| P3B — enforcement block | 1 → **HELD** | `tiers.json` (enforcement key), `src/router/config.ts`, `docs/CONFIG_REFERENCE.md`, `test/unit/config.validate.test.ts` | No |
| P4 — time-box + deferred wiring | 2 → **GATED** | `src/index.ts`, `src/verify/gate.ts`, `src/verify/dispatch.ts`, one new integration test file | **Yes** (runs alone) |
| P5 — effort | 3 | per plan | via serialisation point |
| P6 — prompt styles | 3 | per plan | via serialisation point |
| P7 — resume | 3 | per plan | via serialisation point |

Notes:

- P2 gains `src/telemetry/trajectory.ts` and `src/verify/dispatch.ts` relative to the plan draft:
  the store inventory (§7) found four sessionID-keyed stores, including `trajectoryStore`
  (`src/telemetry/trajectory.ts`, **no eviction path at all today**) and `changedFileStore`
  (`src/verify/dispatch.ts`). Neither file is touched by any open PR (§6), and Phase 4 owns
  `dispatch.ts` only in Wave 2, so per-wave ownership is respected.
- P1's `deterministic.ts` wiring is reachable without `index.ts`: `resolveAgainst(deps.cwd, …)` in
  `fileExists`/`schemaMatch`/`npmScriptMissing` is behaviour-neutral today because `deps.cwd` is
  `ctx.directory` (index.ts:442). Producer-cwd threading arrives in Phase 4.
- P1's `checker.ts` change (optional `workingDir` forwarded to the grader request) is additive and
  inert until Phase 4 passes it. It stays in P1 so Wave 2's `index.ts` diff stays minimal.

## 5. Wave 1 concurrency

**P1, P2 and P3A run fully in parallel** — owned paths are disjoint, none touches `index.ts`, none
touches a file any open PR touches. Golden snapshots are regenerated once, at the Wave 1
serialisation point, by a single agent (P3A's clause is the only expected prompt change).

## 6. In-flight third-party PRs — collision map (T0.5 + file-list check)

Checked 2026-08-18. lucashungaro opened four PRs on 2026-08-18; #13 and #19 remain open.

| PR | Files touched | Collides with |
|---|---|---|
| #28 (bucket c) | `src/index.ts`, `src/verify/wiring.ts`, `test/unit/wiring.test.ts` | **Phase 4** — the grader `session.prompt` call site (index.ts:419, inside `dispatchGrader`) is inside the region #28 extracts. Wave 3 gate. |
| #27 | `src/router/config.ts` | **Phase 3B** — splits `validateConfig` into per-section validators; 3B extends the same function. |
| #26 | `src/commands/output.ts`, `src/index.ts`, `test/unit/commands-output.test.ts` | **Phase 4** (index.ts). |
| #25 | `src/router/config.ts`, `test/unit/config.validate.test.ts`, `src/index.ts`, `src/router/subagents.ts`, docs | **Phase 3B** and **Phase 4**. |
| #19 | grader temperature | informational — 3B's shipped `graderTemperature: 0` may resolve the impasse; finding recorded for the maintainer. |
| #13 | model naming | none. |

**Ruling:** Phases 1, 2, 3A are unaffected and proceed. **3B is HELD** and **Phase 4 is GATED** —
both are direct collisions with third-party PRs in flight, which is a stop-and-ask condition under
Directive 3. The question goes to the maintainer once, batched, at the Wave 1 serialisation point
(options: merge/land Lucas's PRs first, or 3B/P4 proceed and Lucas rebases). Not decided alone.

## 7. Store inventory (T0.2) — Phase 2 scope

| # | Store | File | Eviction today | 40c9b94 covers it? |
|---|---|---|---|---|
| 1 | `guardStore` (`states`, `pendingNotes`) | `src/guard/store.ts:12-13` | `clear(sid)` — called only for plugin-created producer sids (index.ts:634) | No — backend sessions only |
| 2 | `sessionStore` (`subagentSessionIDs`, `subagentCapState`) | `src/router/sessions.ts:164-165` | `unregister(sid)` — same limitation (index.ts:629) | No |
| 3 | `trajectoryStore` | `src/telemetry/trajectory.ts:145-149` | **none — pure leak** | No |
| 4 | `changedFileStore` (`bySession`) | `src/verify/dispatch.ts:44-51` | `clear(sid)` (index.ts:627, 866, 885) | No |

Sessions registered via `registerFromChatMessage` (ordinary subagent dispatches) are never cleaned
from any store — that is the leak Phase 2 closes. `40c9b94`'s `disposeChildSession` is backend-only
(abort+delete via `ctx.client.session`), idempotent, and does not touch these maps, so TTL sweep
and disposal cannot double-delete JS state; `Map.delete` on a missing key is a no-op regardless.

Salvage API to port (`src/router/idle-sweep.ts`): `DEFAULT_IDLE_TTL_MS = 3_600_000`,
`IDLE_SWEEP_THROTTLE_MS = 300_000`, `createIdleTtlSweeper(sweepers, throttleMs?) → (nowMs?) =>
boolean`. No timers; opportunistic. Deferred wiring (Phase 4): `sweepIdleStores()` at the top of
the `"chat.message"` hook, try/caught.

## 8. Phase 3B defaults table (T0.3) — current effective defaults, from code

3B may ship **only** these values; any field whose default cannot be established ships nothing.
The salvage branch's block (`mode: "enforced"`, `guard.budget: 50`, `guard.readDraftCap: 5`,
`verify.require: "whenDoDPresent"`) is **not** behaviourally invariant and must not be copied.

| Field | Default | Read at |
|---|---|---|
| `mode` | `"advisory"` | `src/router/enforcement.ts:36` |
| `envGate` | `"MODEL_ROUTER_ENFORCE"` | `enforcement.ts:17` |
| `guard.budget` | `25` | `src/guard/enforce.ts:35` |
| `guard.readDraftCap` | `3` | `enforce.ts:36` |
| `guard.sameOpRetryCap` | `1` | `enforce.ts:37` |
| `guard.blockSelfScript` | `true` | `enforce.ts:38` |
| `guard.deliverableFirst` | `true` | `enforce.ts:39` |
| `guard.blockScriptWrites` | `false` | `enforce.ts:40` |
| `verify.minGraderTier` | `null` | `src/index.ts:449` |
| `verify.require` | *undefined — no default; do not ship* | `src/index.ts:451,829` |
| `verify.graderTemperature` | `0` | `src/index.ts:718` |
| `verify.requireExplicitDoD` | `false` | `src/router/protocol.ts:245` |
| `escalate.ladder` | `["fast","medium","heavy"]` | `src/escalate/ladder.ts:179` |
| `escalate.floorTier` | `null` | `ladder.ts:180` |
| `escalate.maxAttemptsPerTier` | `1` | `ladder.ts:181` |
| `escalate.maxTotalAttempts` | `4` | `ladder.ts:182` |
| `escalate.costCeiling.multiple` | `4` | `ladder.ts:183` |
| `proportional.trivialBypass` | `true` | `src/guard/enforce.ts:79` |
| `verify.graderPolicy`, `proportional.trivialClassifier`, `escalate.costCeiling.base` | *validated but never read — do not ship* | — |

## 9. Phase 4 insertion points (T0.4) — recorded for Wave 2

- Producer prompt: `src/index.ts:582-589` (inside `try/catch` at `:581-597`); timeout folds into
  the existing catch (one failed attempt). `disposeChildSession(producerSid)` at `:640` already
  fires unconditionally.
- Grader prompt: `src/index.ts:419-426` inside `dispatchGrader`; existing `finally` at `:433-436`
  already disposes. **This region is being extracted by PR #28** — hence the Phase 4 gate.
- SDK cancellation is real: `session.abort` → `POST /session/{id}/abort`; backend distinguishes
  `MessageAbortedError`. Phase 4's abandonment criterion ("timeout that cannot cancel") does not
  fire.
- Salvage reference: `RouterTimeoutError`, `withTimeout` (Promise.race), `DEFAULT_DELEGATE_PROMPT_TIMEOUT_MS = 600_000`
  (`enforcement.verify.delegateTimeoutMs`), `DEFAULT_GRADER_PROMPT_TIMEOUT_MS = 60_000`
  (`verify.graderTimeoutMs`), `DEFAULT_GATE_BUDGET_MS = 90_000` (`verify.gateBudgetMs`,
  accept-on-timeout with a router note). Phase 4 re-derives policy against the plan's
  honest-`unmet` requirement rather than copying the salvage accept-on-timeout gate behaviour
  without scrutiny.

## 10. Base drift (T0.6)

`src/guard/store.ts`, `src/router/sessions.ts`, `src/verify/deterministic.ts`,
`src/verify/checker.ts`: **zero commits on master since the merge base** — the salvage diffs
(+51/+124/+172/+34) port as clean overlays; no upstream drift to reconcile.

## 11. Deferred integration landing spots

| Deferred item | Lands in |
|---|---|
| `Delegation.cwd` + `resolveBaseDir` seam in `gate.ts`; producer-cwd capture in `index.ts`; `buildGateDeps` routerDir | Phase 4 (Wave 2) |
| `sweepIdleStores()` wiring in the `chat.message` hook | Phase 4 (Wave 2) |
| `enforcement.verify.delegateTimeoutMs` field shipped in tiers.json | Phase 4 (T4.4) — contingent on 3B's disposition |
| Wave 1 modules explicitly permitted callerless until Wave 2 | `paths.ts` (called by deterministic.ts immediately, inert), `idle-sweep.ts` (unit-tested, wired in Wave 2) |
