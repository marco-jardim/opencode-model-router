# Phase 2.3 — Plugin wiring for both features

Branch `de/p23` (worktree `D:\git\omr-de-p23`, base `b318faa`). Issues #66 (depth) and #67 (effort bump).
This file holds the 2.3.1 wiring design. All line numbers refer to `b318faa`. After an earlier step has
shifted the lines, re-anchor on the quoted code. The plan's binding text is §1.7 A1–A15.

## Pre-flight

A15 requires every handoff addressed to 2.3 in `phase-0P.md` and `phase-1.*`/`phase-2.*` to be listed here.
"Step N" means a step in the Implementation notes below.

| # | Source | Handoff | Disposition |
|---|---|---|---|
| P1 | 0P Handoffs | A1 per-call banner channel and tests | Applied in steps 2 (v1 map), 3 (delegate), 5 (v2 symbol + bridge map) and 7 (tests) |
| P2 | 0P | A2 recording | Applied in step 2 (D4 record, decision N3) |
| P3 | 0P | A3 host seam (`src\v2.ts`) and bridge test | Applied in step 1 (seam) and step 6 (bridge test) |
| P4 | 0P | A3 host-level proof (Spike A2 rig) | Applied in step 8 |
| P5 | 0P | A4 bridge translation | Applied in step 5 |
| P6 | 0P | A7 both grader creation points | Applied in step 4 |
| P7 | 0P | A8 explicit clear in the outer `finally` | Applied in step 6 |
| P8 | 0P | A11 order and `/bypass` | Applied in steps 2 and 3, decisions N7 and N11 |
| P9 | 0P Deferred | Bridge registration precedence (`v2-hooks.ts:125–135`) | Applied in step 5 |
| P10 | 1.1 Deferred | "the v2 key translation is 2.3" | Applied in step 5 (same as P9) |
| P11 | 1.1 → 1.2/2.1 | `resolveDepthLimit` read per call; the state-file mode is not validated | Applied in step 2 (per-call seam, N2). An invalid mode is already handled by the guard (2.1) |
| P12 | 1.2 Handoffs | Phase 2 owner: F2 (a lost plugin child re-resolves as root) | Accepted residual, no change (Findings F5) |
| P13 | 1.2 | F3: a grader's `parentID` may differ from its creator | Applied in step 4: the depth creator is separate from the backend parent; native-path graders stay unparented (N6) |
| P14 | 1.2 | F5: `DEPTH_LOOKUP_RETRY_MS` duplicates `SESSION_LOOKUP_RETRY_MS` | Applied in step 1 |
| P15 | 1.2 Deferred | sweep in `createIdleTtlSweeper`; `recordRoot` from backend answers; `session.created` → `recordCreated`; producer/grader → `recordPluginChild`; `forget` on deletion | Applied in steps 1, 3 and 4 |
| P16 | 1.3 To 2.3 | Wire `action.effort`; test that the scorecard effort equals the applied effort (QA-1.3-1) | Applied in step 6 |
| P17 | 1.3 | One config snapshot; never rebuild the policy in the loop | Applied in step 6 (N9) |
| P18 | 1.3 | A4: an explicit native key wins over its alias | Applied in step 5 |
| P19 | 1.3 | Explicit precedence against host option keys | Applied, decision N10 |
| P20 | 1.3 | Key order | No change needed: the store copies keys from `buildAgentOptions`, and the bridge keeps native key positions (step 5) |
| P21 | 1.3 Deferred | QA-1.3-1 → 2.3.5.b | Applied in step 6 |
| P22 | 1.3 Deferred | Build the options with `buildAgentOptions({ ...tier, effort })` | Already applied in 2.2 (`effort-override.ts:81`); step 6 only calls `set` |
| P23 | 1.3 Deferred | `set` refuses above `effortCeilingFor` | Already applied in 2.2 (`effort-override.ts:76–80`) |
| P24 | 2.1 #1 | One guard: live `cfg`, caller's tier, no trivial downgrade, `.mode` | Applied in step 2 |
| P25 | 2.1 #2 | Before-hook placement; D4 on block; banner through the A1 channel | Applied in step 2 (v1) and step 5 (v2) |
| P26 | 2.1 #3 | `delegate`: check before any session; skip under bypass; banner on every return | Applied in step 3 |
| P27 | 2.1 #4 | Result shapes | Applied in steps 2 and 3: branch on `block`, then `banner`, never on `mode` |
| P28 | 2.1 #5 | Concurrency/cost assertions through the factory | Applied in step 7 |
| P29 | 2.1 #6 | One logger adapter; one warning per cause through the factory | Applied in step 1 (`routerWarn`) and step 7 |
| P30 | 2.1 Deferred | All wiring, D4, `/bypass`, v2 refusal; no trivial input | Applied in steps 1–5 |
| P31 | 2.2 #1 | One store with the plugin logger; the same adapter for `applyEffortOverride` | Applied in step 6 |
| P32 | 2.2 #2 | `set` in `registerProducer`; exact `tierName`; same snapshot; once per producer | Applied in step 6 |
| P33 | 2.2 #3 | `clear` at all three exits, before `disposeChildSession` | Applied in step 6 |
| P34 | 2.2 #4 | `chat.params` in its own `try`; host-seam target; decide `/bypass` | Applied in step 6 and N11 |
| P35 | 2.2 #5 | Title/grader/orchestrator untouched; exact key; clear on every exit; no `options` key | Applied in steps 6 and 7 |
| P36 | 2.2 Deferred | Host-level proof is a gate | Applied in step 8 |
| P37 | 2.2 Deferred | Provider acceptance unverified; no variant fallback; key docs | Deferred by plan (see Deferred) |
| P38 | Plan, 2.3 pre-flight | Re-run Spike A's assertion against the current bridge | Applied in step 5 (unit test) and step 8 (E2 on real hosts) |

### Host-level proof — PASS (2026-10-05)

Tested source: `bc5205e48b990aded2030b9b2f9372b0c9cbdd23`; binaries: v1 **1.18.19**,
v2 **2.0.22**. Retained rig: `C:\Users\Marquinho\AppData\Local\Temp\Claude\p23-host-proof\`.
`hashes.json` records rig-source SHA-256; `provenance.json` records all **31,448** copied
plugin/dependency files against the worktree, with **zero differences** before the proof run.
A recheck after the smoke comparison found only the source worktree's mutable
`node_modules/.vite/vitest/.../results.json` had changed; all plugin source and runtime
dependencies still matched. See `provenance-recheck.json` and `provenance-recheck.log`.
The original Spike A2 directory was not modified. Initial copy anomalies and unsuccessful
fixture runs remain archived. All requests used an isolated project, fake keys and a local
scripted Anthropic Messages stub; this does not establish upstream provider acceptance.

| Scenario | v1 | v2 | Captured evidence |
|---|---|---|---|
| E1 effort bump | PASS | PASS | Producer `output_config.effort`: `low` → `medium`; two grader calls, first fails and second passes; title/grader/orchestrator effort absent |
| E2 enforced foreground | PASS | PASS | Child's next request contains exact D5 error, `is_error: true`; root continues to `ok`, exit 0 |
| E2 enforced background | Not applicable | PASS | Native `subagent` input `background: true`; exact D5 error and continued turn |
| E2 enforced resume | PASS | PASS | Captured `task_id` / `sessionID` matches a previously created child; exact D5 error and continued turn |
| E3 advisory foreground | PASS | PASS | Nested dispatch completed; full guard banner exactly once at the end of the captured tool result |
| E3 advisory background | Not applicable | PASS | Native input `background: true`; result output/metadata `status: "running"`; full banner exactly once in HTTP tool-result content and structured output |
| E3 advisory resume | PASS | PASS | Resumed existing child; full banner exactly once for the resume call; v2 resumes the caller's own child |
| E4 bump disabled | PASS | PASS | Producer effort `low` → `low` on both hosts |

E1 debug scorecards on both hosts: `final_tier=fast@medium`, `attempts=2`,
`escalations=0`, `verdict=PASS`, `method=checker`. Model-visible delegate output was
`CHILD_DONE` followed by `[router ✓ verified: checker]`, without a scorecard.
`scorecards.json` retains the debug text and paths. Both E4 scorecards report
`final_tier=fast`, `attempts=2`, `escalations=0`, `verdict=PASS`.

V2 E3 foreground first returned `No tool named "subagent" is currently available.`
Adding explicit `general` subagent permission enabled the tool but revealed a separate
host cap. The second captured child tool result was:

```json
{"error":{"type":"tool.execution","message":"Subagent depth limit reached (1). Increase \"experimental.subagent_depth\" to allow nested subagents."},"content":[]}
```

It had `is_error: true` and no advisory banner. Root session:
`ses_ef46743cbffeCodsMuxQtKMSx8`; child: `ses_ef46740bbffeoLe4wWnzVyWJm2`;
call: `toolu_proof_1791195922290`. The fixture used top-level `subagent_depth: 4`,
which lifted v1's cap but did not lift v2's `experimental.subagent_depth` cap.
The follow-up sets **`experimental.subagent_depth: 4` on v2**, plus an explicit
`general` agent permission allowing `subagent`. The router's own
`enforcement.maxDelegationDepth` remains **1**. On OpenCode 2, nested dispatches are
additionally limited by the host's `experimental.subagent_depth` (default 1);
raising only the router limit or the v1 top-level key does not lift that host cap.
These unsuccessful fixture attempts are retained, not counted as product defects.

Two additional fixture corrections were needed in the follow-up:

- V2 background results expose `status: "running"` in `result.output` and
  `result.metadata`, not an XML `state="running"` attribute. The report checks those
  linked after-hook fields and the captured HTTP content; both output channels have
  the full banner exactly once. Call: `toolu_proof_1791196319166`.
- V2 only permits resuming a direct child of the caller. The initial sibling-resume
  attempt is archived under `v2-sibling-resume-attempt/`. The accepted fixture first
  creates root → caller → leaf, then resumes the same caller to resume its leaf.
  Caller: `ses_ef45fe746ffeci3QQddNXnl6RS`; leaf:
  `ses_ef45fe70cffexaflSar7DiFGen`; resume call: `toolu_proof_1791196406666`.
  Parent IDs and the reused session ID are asserted, not inferred from the banner.

Assertions and raw evidence: `report.mjs`, `final-verdicts.json`, `REPORT.md`,
`captures.jsonl`, `hooks.jsonl`, per-scenario stdout/stderr and archived attempts.
`node report.mjs` and `node finalize.mjs` re-evaluated all retained accepted captures:
**14/14 scenario/host combinations passed**, with exit 0 and a final `ok` on every run.
Earlier verdicts, including the XML-shaped background assertion failure, remain archived.

Requested smoke commands were run from this worktree with isolated environment:

- `npm run smoke:keyless`, v1 bin directory first on PATH: **FAIL**, 8 passed / 1 failed.
  `deferred-catalog.smoke.test.ts:305`: `'ghost-model-9' never appeared in the opencode log.`;
  `turn statuses: 500, 500`; log and stderr fields empty. Registration and subagent-tier
  files passed. Full output: `smoke-keyless.log`.
- `npm run smoke:v2`, `OPENCODE_V2_BIN` set to the requested 2.0.22 binary:
  **PASS**, 2/2 tests. Full output: `smoke-v2.log`.

#### Smoke regression check — not a Phase 2.3 regression

Ran **only** `test/smoke/deferred-catalog.smoke.test.ts`, using
`RUN_OC_SMOKE_KEYLESS=1`, `--config vitest.smoke.config.ts`, and v1 **1.18.19** first
on PATH. Each branch was tested twice under the original isolated wrapper, then twice
with only `XDG_DATA_HOME` unset (other isolated environment paths retained).

| Source | Original wrapper, rounds 1 / 2 | Log-path control, rounds 1 / 2 |
|---|---|---|
| `de/main` — `b318faa515891ca1f1d66400e9137bf6f014f277` | FAIL / FAIL | PASS / PASS |
| `de/p23` — `bc5205e48b990aded2030b9b2f9372b0c9cbdd23` | FAIL / FAIL | PASS / PASS |

**Cause:** the test reads `<homeDir>/.local/share/opencode/log` (lines 102–121),
but its child inherits `XDG_DATA_HOME` (line 197). The scratch smoke wrapper had set
that variable, redirecting the real log to `<case>/data/opencode/log/opencode.log`.
All four failing comparison runs actually contain the expected `level=WARN`
`ghost-model-9` entry at line 25 of that real log. The original p23 lane's log also
contains it at line 26 of `smoke-env/data/opencode/log/opencode.log`.
Thus the warning was emitted; the test was looking in a different directory.

The server-side 500 is the test's deliberately nonexistent model, which the test
explicitly does not assert (lines 263–282), not a Phase 2.3 hook exception:

```text
ProviderModelNotFoundError: Model not found: no-such-provider/no-such-model.
    at <anonymous> (B:/~BUN/root/chunk-yxwqt1sp.js:439:90378)
    at SessionPrompt.getModel (B:/~BUN/root/chunk-mp12mgys.js:1096:11490)
    at SessionPrompt.getModel (definition) (B:/~BUN/root/chunk-mp12mgys.js:1096:908)
    at SessionPrompt.run (B:/~BUN/root/chunk-mp12mgys.js:1096:15306)
```

No responsible Phase 2.3 commit or new throwing router path was found; no commit bisect
was needed because the failure reproduces before Phase 2.3 and disappears on both
branches with the environment-only control. No repository code or tests were changed.
Evidence: `smoke-comparison/summary.json`, `smoke-logpath-control/summary.json`,
per-case `vitest.log`, retained actual server logs, `smoke-diagnosis.json` and
`SMOKE-DIAGNOSIS.md` (full original error stack included).

The **host-level proof gate is satisfied**. The original keyless lane's 8/9 result is
retained above rather than rewritten as a fresh 9/9 run; its sole failing file now
passes twice on p23 with the corrected wrapper environment. The v2 lane remains 2/2.
Cleanup at `2026-10-05T07:33:31.5420501-03:00` found no rig processes, v1 smoke servers,
or listeners on the five recorded stub ports. `cleanup.json` records an unrelated
Context7 process whose parent PID matched an old host PID; it was not killed.

## Implementation notes

### Decisions (binding for 2.3.2–2.3.6)

- **N1 — Construction.** Each plugin instance gets:
  - one `routerWarn = { warn: (m: string) => logger.warn(m) }` adapter, shared by tracker, guard, store and
    `applyEffortOverride` (2.1 #6, 2.2 #1);
  - one `depthTracker` (step 1);
  - one `depthGuard` (step 2);
  - one `effortOverrides` (step 6).

  Each object is built in the step that first uses it.
- **N2 — Config snapshot for the guard.**
  - The `limit` and `mode` seams read the factory's live `let cfg` on every call (2.1 #1). This is the binding
    `guardBeforeCall` and the task branch (`:1106`) use, and `/preset`, `/budget` and `/tiers` reassign it.
  - The `delegate` path uses the same seams, not its `activeCfg`. One guard instance then answers one mode and
    one limit for both dispatch paths, and the `task` hot path adds no `loadConfig` per tool call.
  - `activeCfg` stays the effort snapshot (N9).
- **N3 — D4 recording is unconditional on a depth block.** The record is not gated by `isSubagent`.
  - An enforced block means `depth + 1 > max ≥ 1`, so the tracker has proved that the caller is a child, which is
    stronger evidence than `isSubagent`.
  - The detector keys on the child id (`index.ts:1240–1245`).
  - `recordToolEvent` creates trajectory state through `ensureState` (`trajectory.ts:188–190`), which
    `sweepIdleStores` TTL-sweeps. It writes nothing model-visible; dumps stay gated by
    `MODEL_ROUTER_TRAJECTORY_DEBUG`.
  - The record is wrapped in `try` so that it can never lose the refusal.
- **N4 — Seeding (D2/A2).** Only authoritative answers seed the tracker:
  - a fresh `lookupRootSession` success: root → `recordRoot`, child → `recordCreated(id, parentID)`;
  - a memo hit of `true` → `recordRoot`. This refreshes a TTL-swept root at no backend cost; the memo holds only
    authoritative answers.
  - `session.created` → `recordCreated(id, parentID || null)`.

  Never seeded:
  - `resolveIsRootSession`'s `?? true` (`:281–282`);
  - the lookup's `catch`.

  `getParent` short-circuits `sessionRootMemo.get(id) === true` → `null`. An orchestrator therefore never pays a
  second call. A `false` memo carries no parent id, so it falls through to the backend.
- **N5 — Banner position.** The banner never enters the grader input.
  - v1 `task`: appended at the A1 point in `tool.execute.after`, before the `isSubagent` branch, so the
    verification text (forcing note, accepted suffix, footer) still comes last. The gate then parses the
    **pre-banner** output (step 2).
  - `delegate`: inserted after the producer text and before the accepted suffix or deferred footer; appended last
    on router-only returns.
  - v2: the bridge appends it after the legacy text, as A1 says literally (Findings F2).
  - A banner and a deferred footer can co-occur in advisory mode for router-created unparented sessions:
    depth tracking retains their plugin pin (depth ≥ 1), while the backend can prove them root for deferral
    once they are no longer registered as producers/graders. A surviving session resumed after failed
    disposal is one such case. The v1 native-task result keeps the banner before the deferred footer,
    which stays last. This pre-existing root-classification gap is not changed by Phase 2.3.
- **N6 — Native-path grader creator.** The native-task gate uses
  `buildGateDeps(undefined, gateGraderSessions, verification, gateDeadline, false, orchestratorSessionID || null)`
  (A7, QA-0.P-R2-9). The caller is used only as the depth creator. The native-path grader remains
  unparented at the backend, preserving v2.0.0 behaviour on both hosts. Delegate-path and `router_verify`
  graders retain their existing parent arguments; depth tracking does not change backend parentage (F1).
- **N7 — `/bypass`.**
  - The before-hook keeps `if (bypassed) return;` first (A11).
  - `delegate` skips only the depth guard when bypassed (A11, QA-0.P-R2-8); the ladder still runs.
- **N8 — `forget` only on `session.deleted`.** The tracker never forgets at producer cleanup: a disposal that
  fails, followed by a `task_id` resume, must keep the pinned plugin depth.
- **N9 — Effort snapshot.**
  - `set` receives `getActiveTiers(activeCfg)[tier]`, from the same `activeCfg` as `tierModel(activeCfg, tier)`
    (`:637`) and `buildEscalatePolicy(activeCfg)` (`:566`).
  - The policy is built once (`:566`). Agent, model and variant sent to the producer stay unchanged (2.3.5.d).
- **N10 — Host option precedence.** The override always wins. `applyEffortOverride` overwrites the key over the
  registered agent options (v1 `output.options`) and over the v2 per-turn merge (`v2-hooks.ts:214–215`, which only
  fills absent keys). It is gated by agent and model identity, so only the router's own producer is affected.
- **N11 — `chat.params` ignores `/bypass` for the effort.**
  - The store holds entries only for the `delegate` ladder, which `/bypass` does not stop (N7).
  - Skipping the bump mid-ladder would make attempt N depend on when the toggle happened.
  - Clearing at all three exits already bounds the effect.
  - Tested in step 6.

### Step 1 — `feat(router): construct the depth tracker and seed it` (Refs #66)

**Files:** `src\compat\child-session.ts`, `src\v2.ts`, `src\index.ts`.

- **`child-session.ts`**
  - After `:5`, add
    `export const DEPTH_BANNER = Symbol.for("opencode-model-router.depth-banner");`, with a doc comment: "an
    advisory depth banner for this call; the v2 bridge delivers it".
  - In `RouterPluginInput` (`:25–27`), add `/** Set only by src/v2.ts; absent = v1 host (A3). */ routerHost?: "v2";`.
- **`v2.ts`:** after `routerChildRunner: runtime.childRunner,` (`:19`), add `routerHost: "v2" as const,`.
- **`index.ts`**
  - **Import (after `:101`):** `import { createDepthTracker, DEPTH_LOOKUP_RETRY_MS } from "./router/depth";`.
  - **F5:** at `:241`, `const SESSION_LOOKUP_RETRY_MS = DEPTH_LOOKUP_RETRY_MS;`. The value stays 30 000.
  - **Construction:** after `const logger = createPluginLogger(ctx.client);` (`:362`), add `routerWarn` (N1) and
    `const depthTracker = createDepthTracker({ getParent, now: () => Date.now(), logger: routerWarn })`, where
    `getParent` is:

    ```ts
    async (id) => {
      if (sessionRootMemo.get(id) === true) return null;          // N4
      const res: any = await ctx.client.session.get({ path: { id } });
      if (!res || res.error || !res.data) throw new Error("session.get returned no session data");
      const p = res.data.parentID;
      return typeof p === "string" && p !== "" ? p : null;
    }
    ```

    This matches the response handling of `lookupRootSession` (`:300–306`).
  - **Sweep:** after `() => changedFileStore.sweep(),` (`:348`), add `() => depthTracker.sweep(),`. The tracker is
    declared below, as in the existing `sweepVerification` precedent (`:349–351`).
  - **`lookupRootSession` (N4)**
    - At `:292`, `if (!memo) sessionStore.markChildSession(sessionID);` becomes
      `if (!memo) sessionStore.markChildSession(sessionID); else depthTracker.recordRoot(sessionID);`.
    - After `:313`, add
      `if (isRoot) depthTracker.recordRoot(sessionID); else depthTracker.recordCreated(sessionID, parentID as string);`.
    - Leave `catch` (`:315–324`) and `:281–282` untouched.
  - **`session.deleted`:** after `sessionStore.unregister(id);` (`:1499`), add `depthTracker.forget(id);`.
  - **`session.created` (`:1519–1533`):** when `typeof info?.id === "string"`, call
    `depthTracker.recordCreated(info.id, typeof info.parentID === "string" && info.parentID !== "" ? info.parentID : null)`
    in its own `try`. The existing `markChildSession` branch stays unchanged after it. On v2 this arrives through
    the bridge's translation (`v2-hooks.ts:357–358`), so the bridge needs no code. That translation spreads the
    event data, which carries `parentID` when the host sends it; the existing v2 child marking relies on the same
    field. Step 5 pins this with a test.

**Tests:** create `test\integration\depth-guard-wiring.test.ts`. Model its fake ctx on `ladder-wiring.test.ts:27–62`
and add `session.get` and `vi.fn` counters. Pin:

- plugin start makes no `session.get`;
- one root `system.transform` makes exactly one `session.get`, and seeding adds none;
- `session.created`/`session.deleted` events make no backend call.

### Step 2 — `feat(router): refuse task dispatches past the delegation depth` (Refs #66)

**Files:** `src\index.ts`.

- **Imports:** `DEPTH_BANNER` (`:3`), `resolveDepthLimit` (the config list `:6–16`), and
  `import { createDepthGuard } from "./router/depth-guard";`.
- **Guard:** after the tracker, use the 2.1 #1 code verbatim, with `limit: () => resolveDepthLimit(cfg)` and
  `logger: routerWarn`:

  ```ts
  mode: (sid) => resolveEnforcementMode({ config: cfg,
    tier: (typeof sid === "string" ? sessionStore.getTier(sid) : null) ?? undefined, env: process.env }).mode
  ```

  There is no `isTrivial` (A1).
- **Banner state (v1):**
  - `const depthBanners = new Map<string, string>()` (≤ 1 000, FIFO via `delete` + `set`, then evict
    `keys().next()`);
  - `const warnedNoCallID = new Set<string>()` (≤ 1 000).
- **`stashDepthBanner(input, output, banner)`**
  - If `ctx.routerHost === "v2"`, run `try { output[DEPTH_BANNER] = banner } catch {}` and return (the bridge
    delivers).
  - Otherwise, if `callID` is a non-empty string, store under `${input.sessionID}:${input.callID}`.
  - Otherwise, emit once per session:
    `logger.warn("[router] delegation depth: task call without callID in session <sid>; advisory banner not delivered")`.
- **Before-hook (A11):** insert right after `if (bypassed) return;` (`:1100`), before `observeEdit` (`:1103`):

  ```ts
  if (input?.tool === "task") {
    const depth = await depthGuard.checkDispatch(input.sessionID);   // never rejects (2.1)
    if (depth.block) {
      try { if (typeof input.sessionID === "string") trajectoryStore.recordToolEvent(input.sessionID,
        { tool: input.tool, readOnly: READ_ONLY_TOOLS.has(input.tool), blocked: true }); } catch { /* N3 */ }
      throw new Error(depth.message);                                 // D5 text, before any store write
    }
    if (depth.banner) stashDepthBanner(input, output, depth.banner);
  }
  ```

  Only `task` is guarded here. `delegate` guards itself (step 3), and guarding it here would deliver its banner
  twice. On v2, `subagent` arrives as `task` (`legacyToolName`).
- **After-hook (A1, N5):** insert after the `changedFileStore.record` block (`:1258–1260`), before
  `if (sid && sessionStore.isSubagent(sid)…` (`:1262`):
  - declare `let unbannered: { output: unknown } | undefined;`;
  - if `input?.tool === "task"` and the key `${sid}:${input.callID}` is in `depthBanners`, then `delete` it, set
    `unbannered = { output: output.output }`, and set `output.output` (inside `try`) to the trimmed text, a blank
    line and the banner, or to the banner alone when the text is empty.
  - At `:1297`, `parseTaskResult(output)` becomes
    `parseTaskResult(unbannered ? { ...output, output: unbannered.output } : output)`.
- **`session.deleted`:** also delete every `depthBanners` key that starts with `${id}:`.
- **Existing tests:** run the full suite. A fake client with no `session.get` now rejects the first depth lookup
  of a task caller that was never seeded, which logs one "cannot resolve" warning and allows the call.
  - If an existing test fails **only** for that reason (an extra `session.get` or that warning), add
    `session: { get: async ({ path }) => ({ data: { id: path.id } }) }` to that test's fake client. Do not touch
    its assertions.
  - Any other failure: stop and report it.

**Tests** (`depth-guard-wiring.test.ts`). Every case runs in `enforced` (`MODEL_ROUTER_ENFORCE=1`) **and**
`advisory` (the bundled default). Advisory asserts the banner exactly once and no throw.

- The root is seeded by its transform, then `task` → allowed, and `session.get` stays at 1 (P28).
- Child C (seeded by `session.created(C, O)`) calls `task`:
  - **enforced:** it throws `depthLimitMessage(1, 1)`. The output has no `TASK_VERIFICATION` and `args.prompt` is
    unchanged (no header or repair). Wrap these with `vi.mock(…, importOriginal)` spies:
    `createVerificationWiring().startDispatch` and `prepareVerification`, and the
    `createChangedFileStore()` methods `observeEdit`/`record`/`clear`. None of them was called for that call.
  - **D4:** O's after-hook for C's hand-back runs, with output `task_id: C` + `<task_result>I cannot dispatch;
    handing back.</task_result>` and `metadata.sessionId: C`. It has **no** `FALSE-REFUSAL SUSPECT`. As a
    control, the same hand-back without the refused call **is** flagged.
- `maxDelegationDepth: 2` (written with `overridePath()`, pattern `router-command.test.ts:101–102`): depth 1 is
  allowed with no banner; depth 2 is refused or bannered.
- `maxDelegationDepth: null` → an unseeded child's `task` makes no `session.get`, gets no banner and does not
  throw. `MODEL_ROUTER_ENFORCE=0` behaves the same.
- Backend failure (`session.get` rejects) → allowed, and exactly one `cannot resolve` warning over two calls
  (`vi.spyOn(console, "warn")`; the fake has no `app.log`).
- Out of order: C's `task` comes before `session.created(C, O)`. The backend walk resolves depth 1; the later
  event adds no `conflicting evidence` warning.
- Fail-open root: C's transform lookup rejects (so it injects), then `session.get` resolves `parentID: O`. C's
  `task` is still refused or bannered: the fail-open result never seeded C as a root.
- `task_id` resume (`args.task_id` set): from C → refused or bannered; from O → allowed.
- Banner plus an existing advisory guard on the same call: a tier-registered subagent (`chat.message`,
  `agent: "fast"`) repeats an identical `task` call, so the same-op retry guard (`sameOpRetryCap: 1`) fires in
  advisory. Both the depth banner and the Layer-1 note appear once each. If that guard does not fire on `task`,
  use any guard that `guard-before-wiring.test.ts` drives on the same call, and record the choice.
- Non-`isSubagent` caller: C is known only through the backend walk. The banner is delivered and the D4 record
  happens.
- Never twice: the same after-hook input twice → the banner appears only in the first.
- A failed call: the before-hook stashes and the host never calls the after-hook. A later call with a new
  `callID` gets only its own banner.
- No `callID` → no banner and exactly one warning per session.
- The grader prompt (`body.system` set) never contains `GUARD:delegation_depth`.
- `/bypass on` → nothing is refused, no banner, no `session.get`.

### Step 3 — `feat(router): guard the delegate tool and record its producers` (Refs #66)

**Files:** `src\index.ts`.

- **`delegate` `execute`:** between `let deferredOwnsBaseline = false;` (`:547`) and `try {` (`:548`):

  ```ts
  const depth = bypassed ? undefined : await depthGuard.checkDispatch(toolCtx?.sessionID);   // N7
  if (depth?.block) return depth.message!;                                                  // A2, no session yet
  const withDepthBanner = (text: string): string => {
    if (!depth?.banner) return text;
    const t = text.trimEnd();
    return t ? `${t}\n\n${depth.banner}` : depth.banner;
  };
  ```

- **Return paths (N5):**
  - `:855–858` → `withDepthBanner(…)`;
  - `:863` → `withDepthBanner("[router] delegate failed: could not create …")`;
  - `:869` → `appendRouterFooter(withDepthBanner(producerText), attempt.deferredFooter)`;
  - `:893` → `withDepthBanner(producerText) + buildAcceptedSuffix(…)`;
  - `:903–908` → `withDepthBanner(…)`;
  - `:915` → `withDepthBanner("[router] delegate failed (fail-closed): …")`.

  Without a banner every string stays byte-identical.
- **`registerProducer`:** after `producerSessions.push(sid);` (`:611`), add
  `depthTracker.recordPluginChild(sid, toolCtx?.sessionID ?? null);`. It never throws, and it runs on both hosts:
  on v1 after `session.create`, on v2 in `onCreated`.

**Tests** (`depth-guard-wiring.test.ts`, both modes; `MODEL_ROUTER_VERIFIED_DELEGATE=1`):

- `delegate` from C (enforced) → returns the D5 text; `session.create` is not called and no grader runs.
- Advisory → the banner appears once at the end of an accepted, unmet or fail-closed result.
- A root `delegate` → no banner, and the output is byte-identical to one with `maxDelegationDepth: null`.
- `execute(args, undefined)` → the producer is created without `parentID`. Inside the fake producer prompt, call
  `hooks["tool.execute.before"]({ tool: "task", sessionID: producerSid, callID: "x" }, { args: {} })`: it throws
  `depthLimitMessage(1, 1)` (or banners) with **no** `session.get` for the producer.
- `/bypass on` → `delegate` from C runs the ladder, with no refusal and no banner.

### Step 4 — `feat(verify): record grader sessions as delegation children` (Refs #66)

**Files:** `src\verify\wiring.ts` (the only edit to that file), `src\index.ts`.

- **`wiring.ts`**
  - In the deps type, after `logger?:` (`:971`), add
    `/** 2.3.3 (A7): each grader id, before its first prompt. */ onChildSessionCreated?: (sessionID: string, creatorSessionID: string | null) => void;`.
  - Add a helper next to `disposeChildSession`:
    `const notifyChildCreated = (sid, creator) => { try { deps.onChildSessionCreated?.(sid, creator); } catch (error) { logger.warn("[verify] child-session hook failed", { error: errorText(error) }); } };`.
  - Call it with the separate depth creator after `inFlight?.add(sessionID);` in the `childRunner` `onCreated`
    and after `inFlight?.add(sid);` on the native path. `dispatchGrader` defaults that creator to
    `parentSessionID ?? null`; `buildGateDeps` can supply the caller independently of its backend parent.
- **`index.ts`**
  - In the `createVerificationWiring` deps (`:372–378`), add
    `onChildSessionCreated: (sid, creator) => depthTracker.recordPluginChild(sid, creator),`.
  - The native-task gate keeps `undefined` as the backend parent and passes `orchestratorSessionID || null`
    as the separate depth creator (N6).

**Tests** (`depth-guard-wiring.test.ts`, both modes):

- Delegate path: the fake grader prompt calls `task` from the grader sid. It is refused or bannered with no
  `session.get` for the grader.
- Native path with `maxDelegationDepth: 2`: C (depth 1) dispatches `task`, which is allowed. During the gate, its
  grader's `task` is refused or bannered (depth 2: QA-0.P-R2-9). The grader's `session.create` carries
  `body: {}` with no `parentID`; depth uses C without changing the host session tree.
- Host lifecycle facts do not replace pinned plugin depth, even when the backend parent is absent (F3).

### Step 5 — `feat(compat): deliver depth refusals and banners through the v2 bridge` (Refs #66 #67)

**Files:** `src\compat\v2-hooks.ts`.

- **Import:** add `DEPTH_BANNER` (`:8`).
- **State:** after `:89`, add `const depthBanners = new Map<string, string>();`.
- **`execute.before`:** after the legacy call (`:288–290`):

  ```ts
  const banner = (output as Record<PropertyKey, unknown>)[DEPTH_BANNER];
  if (typeof banner === "string") {
    depthBanners.delete(event.id);
    depthBanners.set(event.id, banner);
    while (depthBanners.size > 1000) depthBanners.delete(depthBanners.keys().next().value!);
  }
  ```

  The refusal path needs no code: the legacy `throw` rejects this hook before `verifyingCalls`, `nativeArgs` or the
  banner run, and Spike A2 (A9) proved that hosts render it as an `is_error` tool result.
- **`execute.after` (`:302–339`)**
  - First, take `const banner = depthBanners.get(event.id); depthBanners.delete(event.id);`, so a failed or
    non-completed call drops it.
  - **Running branch:** `notices = [verifying ? <existing notice> : none, banner]`. If there is none, `return`;
    otherwise join them with `"\n\n"` and use the joined text where the existing `notice` was.
  - **Completed branch:** replace `if (output.output === text) return;` with:
    - `const changed = output.output !== text; if (!changed && banner === undefined) return;`
    - `routed = changed ? translateAdded(text, output.output) : text`;
    - `final` = `routed` with `"\n\n" + banner` appended (trim the end first);
    - use `final` wherever `translateAdded(text, output.output)` is used today (`:333, 335, 337`).
  - Without a banner the output is byte-identical.
- **A4 (`:128–134`):** build `normalized = { ...options }`. Then fill
  `reasoningEffort ← reasoning_effort`, `reasoningSummary ← reasoning_summary` and
  `thinking ← { type: "enabled", budgetTokens: budget_tokens }`, each only when the alias is defined and
  `normalized[native] === undefined`. Then `agentOptions.set(name, normalized)`.

**Tests** (`test\unit\v2-hooks.test.ts`, both modes, through the real factory with `routerHost: "v2"` and a fake
`ctx.client.session.get`):

- Refusal: `toolHooks["execute.before"]` rejects with the D5 text for foreground, `background: true`, and
  `sessionID` (resume) from C. `event.input` is unchanged, and a following completed `execute.after` for that id
  adds nothing.
- Advisory: the banner is delivered once for a completed result, once for a `running` (background) result, and
  `execute.after` called twice delivers it once. A `failed` result → no banner, and a later replay of the id gets
  none.
- A v2 `session.created` (`{ sessionID: C, parentID: O }`) seeds the tracker: C is refused with no
  `session.get(C)`.
- A v2 grader: `runtime.childRunner.run` → `onCreated(g)`. `g`'s `task` is refused or bannered with no
  `session.get(g)`.
- A4: `{ reasoningEffort: "low", reasoning_effort: "high" }` → `"low"`; `{ reasoning_effort: "high" }` →
  `reasoningEffort: "high"`. The existing case `:78–101` passes unchanged.

### Step 6 — `feat(escalate): apply the bumped effort to ladder retries` (Refs #67)

**Files:** `src\index.ts`.

- **Imports:** `EffortLevel` (the type import at `:17`) and
  `import { applyEffortOverride, createEffortOverrideStore } from "./escalate/effort-override";`.
- **Store:** after the guard, `const effortOverrides = createEffortOverrideStore({ logger: routerWarn });`.
- **Signature (`:591–593`):** `runProducerAttempt(tier: string, forcingNote: string | null, effort?: EffortLevel)`.
- **`registerProducer`:** after the step-3 line, add:

  ```ts
  if (effort !== undefined) {
    const tierCfg = getActiveTiers(activeCfg)[tier];
    if (tierCfg) effortOverrides.set(sid, tier, tierCfg, effort);
  }
  ```

  `set` never throws (`effort-override.ts:52–104`).
- **Clears (A8), each before `disposeChildSession`:**
  - deferred path: `effortOverrides.clear(producerSid);` between `:719` and `:720`;
  - per-attempt cleanup: between `:845` and `:848`;
  - outer `finally` (`:921–924`): `effortOverrides.clear(sid);` before `await disposeChildSession(sid);`.
- **`session.deleted`:** also call `effortOverrides.clear(id)`.
- **Loop:**
  - `let effort: EffortLevel | undefined;` next to `let forcing` (`:579`);
  - `:861` → `runProducerAttempt(tier, forcing, effort)`;
  - after `forcing = …` (`:911`) → `effort = action.effort;`. This is `undefined` on escalate, as in
    `ladder.ts:194/204`.
- **`chat.params` (`:980–993`)**
  - Replace the empty `catch` with a logged one, once per instance: a new `let warnedGraderParams = false` near
    `:404`, then `logger.warn("[verify] grader temperature not applied", { error: scrubText(String(error)) })`.
    The `try` body is unchanged.
  - Then add a second, independent block:

    ```ts
    try {
      if (input && typeof input === "object")
        applyEffortOverride(effortOverrides, input, ctx.routerHost === "v2" ? output : output?.options, routerWarn);
    } catch (error) {
      logger.warn("[router] effort override not applied", { error: scrubText(String(error)) });
    }
    ```

    There is no `bypassed` check (N11).

**Tests:**

- **`test\integration\ladder-effort-wiring.test.ts`** (new). It uses `activePreset: "fable-effort"` (bumpable
  `fast`, A5) through an override, and reads the model from `getActiveTiers(loadConfig()).fast`.
  - The fake producer and grader prompts call `hooks["chat.params"]` with
    `{ sessionID, agent, model: { providerID, id } }` and `{ options: {} }`.
  - Failing first attempt: attempt 1 → `{}`; attempt 2 →
    `{ effort: <buildAgentOptions({ ...fast, effort: "medium" }).effort> }`, exactly. The grader, the
    orchestrator (`agent: "build"`) and `agent: "title"` on the producer sid → unchanged.
  - Escalation: attempt 3 (`medium`) → `{}`.
  - Attempts and cost: the defaults stop after three attempts with "cost ceiling exceeded" (A14), identical
    with `effortBump: false`.
  - Scorecard: `<tmp>/opencode-model-router-trajectory/<sid>.delegate.log` holds `final_tier=fast@medium`, the
    effort applied to that sid (QA-1.3-1).
  - Wrap `createEffortOverrideStore` (`vi.mock`, `importOriginal`). `size() === 0` after success, unmet
    (failure), `delegateTimeoutMs` timeout, a producer prompt rejecting with `AbortError`, the deferred path (as
    in `deferred-verification.test.ts`), and a `prepareVerification` throw (outer `finally`).
    `clear(sid)` is called before `disposeChildSession(sid)` (`invocationCallOrder`).
  - `anthropic` preset (variants, A5) → plain retry, no override.
  - `/bypass on` → the retry is still bumped (N11).
- **`ladder-wiring.test.ts` (extension):** CASE A/B/C rerun with `fable-effort` and
  `enforcement.escalate.effortBump: false`. Producer bodies are exactly `{ model, agent, parts }`, as today, and
  every `chat.params` output deep-equals its input.
- **`v2-hooks.test.ts`:** a v2 producer `context` event on the retry → `event.options.effort` is bumped, and
  `"options" in event.options === false`. A `V2_GRADER_AGENT` event's temperature handling is unchanged.

### Step 7 — `test(router): cover the depth and effort wiring end to end` (Refs #66 #67)

**Files:** tests only.

- **`depth-guard-wiring.test.ts`:** fill any gap left in the matrix below. Add:
  - 50 concurrent `task` calls from an unseeded C → one walk: exactly 2 `session.get` calls (C, then O);
  - a `session.get` that never settles, with fake timers past `DEFAULT_DEPTH_TIMEOUT_MS` → allowed, one warning;
  - `session.deleted(C)` during C's pending lookup → allowed, one warning (2.1 #6).
- **Unchanged suites:** run with no `-u`:
  - the protocol golden snapshot and prompt-measurement suites;
  - the registration and agent-list tests (`fable-effort-preset.test.ts`, the `config`-hook suites).

  Then run `npm run typecheck`, the full suite, `npm run smoke:keyless` (v1 1.18.19 first on `PATH`) and
  `npm run smoke:v2` (`OPENCODE_V2_BIN`, A10).

### 2.3.6 test map (plan list + A1/A3/A7/A11)

| Plan test | File | Step |
|---|---|---|
| Root allowed, no extra backend call | depth-guard-wiring | 1, 2 |
| Depth-1 `task` refused; no dispatch, reference or changed-file state; recorded; no false refusal | depth-guard-wiring | 2 |
| `delegate` from depth 1 refused, no session | depth-guard-wiring | 3 |
| `maxDelegationDepth: 2` | depth-guard-wiring | 2 |
| `null` → no guard, no lookup | depth-guard-wiring | 2 |
| Backend failure → allowed, one warning | depth-guard-wiring | 2, 7 |
| Producer without `toolCtx.sessionID` → depth 1, its `task` refused | depth-guard-wiring | 3 |
| Graders recorded as children (v1, v2; A7) | depth-guard-wiring / v2-hooks | 4, 5 |
| `task_id` resume refused or allowed | depth-guard-wiring / v2-hooks | 2, 5 |
| Same through the v2 bridge, incl. background | v2-hooks | 5 |
| Out-of-order `session.created` | depth-guard-wiring | 2 |
| Fail-open root never seeds | depth-guard-wiring | 2 |
| A1: banner + advisory guard; failed call; non-`isSubagent`; never twice | depth-guard-wiring / v2-hooks | 2, 5 |
| A11: `/bypass` on both paths | depth-guard-wiring | 2, 3 |
| Effort: retry bumped; first, grader, orchestrator and title untouched | ladder-effort-wiring | 6 |
| Escalation → none; non-bumpable → none; attempts and cost unchanged; scorecard `tier@effort` | ladder-effort-wiring | 6 |
| Cleared on success, failure, timeout, abort and deferred (`size` 0, A8) | ladder-effort-wiring | 6 |
| `effortBump: false` identical | ladder-wiring | 6 |
| v2 `chat.params` bridge; no `options` key; grader temperature (A3) | v2-hooks | 6 |
| Protocol golden, measurements, agent list unchanged | existing suites | 7 |

Every depth row runs in `enforced` and `advisory` (A1).

### Step 8 — host-level proof (A3 gate; evidence recorded here, no code)

1. **Copy the rig.** Copy `rig.mjs`, `observer-v1.mjs`, `observer-v2\` and `report.mjs` from
   `C:\Users\Marquinho\AppData\Local\Temp\Claude\spike-b\spike-a2\` to `…\Temp\Claude\p23-proof\`. Leave out
   captures, `router-copy\`, `v1\` and `v2\`. Record `Get-FileHash -Algorithm SHA256` for every copied file,
   before and after the edits.
2. **Edit the copy only.**
   - **Plugin:** a scenario `P23` unshifts `D:\git\omr-de-p23` into `plugin`/`plugins`, as R5 does with
     `router-copy`. That package's `server.ts` → `src\v2.ts`, and its main → `src\index.ts`.
   - **Observer:** make the observer log-only, so that it never throws. Record how.
   - **Project override:** preset `p23` on the stub model, with `fast: { effort: "low" }` and no variant;
     `experimental.verifiedDelegateTool: true`.
     - First confirm that the tier is bumpable:
       `npx tsx -e "import {effortCeilingFor} from './src/router/agent-options'; console.log(effortCeilingFor({model:'anthropic/claude-sonnet-4-5',effort:'low'}))"`.
     - If that prints `null`, use `anthropic/claude-opus-4-7`, which was captured in the Spike B extension.
   - **Stub:**
     - A request whose `system` contains the opening of `GRADER_SYSTEM` (`src\verify\checker.ts:86`) is a grader.
       The first grader of a run replies `{"pass":false,"reasons":["scripted first-attempt failure"]}`; later
       graders pass.
     - `CALL_DELEGATE` sends `delegate` with `{ tier: "fast", task: "CHILD_DONE",
       acceptance: "[acceptance]\ncriteria: the reply says CHILD_DONE\n[/acceptance]" }`.
     - `CALL_TASK_NEST` and `CALL_TASK_BG` follow the existing scripts.
3. **E1 — effort (v1 1.18.19 and v2 2.0.22, `enforcement.mode: "advisory"`).** Assert from the captures:
   - exactly two producer requests (user text contains `CHILD_DONE`, not a grader);
   - the one without the forcing note carries `output_config.effort: "low"`, and the one with it carries
     `"medium"`;
   - no grader, title or root request carries `"medium"`;
   - the final tool result has `[router ✓ verified`, and the run exits 0.
4. **E2 — depth through the loaded router (v2 required; v1 with the R4-permitted agent if it runs).**
   - `enforcement.mode: "enforced"`, `CALL_TASK_NEST`: the child's next request holds an `is_error: true`
     tool_result that starts `[router] DELEGATION DEPTH LIMIT`. Repeat with the child dispatching `CALL_TASK_BG`
     and a resume. Exit 0.
   - Advisory: the child's `running`/completed result contains `[⚠ GUARD:delegation_depth]` exactly once.
5. **Record in `## Verdict`:** commands, binaries, exit codes, hashes, and the per-request excerpts (role →
   effort).

## Findings

All of these are design-time items. None is open.

- **F1 — decided (N6).**
  - **Change:** native-path graders are pinned at the caller's depth plus one, but stay unparented at the
    backend as in v2.0.0. This applies to native-task verification on either host.
  - **Effects:** no backend-parent change, so no new claims about session-tree placement, Layer-1 visibility
    through `session.created`, or title-request suppression.
  - **Handoff withdrawn:** no parentage change to announce in the 3.1 CHANGELOG.
- **F2 — accepted.** The banner's position differs by host.
  - On v1 it comes before the verification text. On v2 it comes after it (the bridge appends, as A1 says
    literally).
  - The banner is never graded on either host. It can co-occur with a deferred footer for router-created
    unparented sessions in advisory mode (N5).
  - Tests assert "exactly once"; the v1 unparented-session regression also pins banner-before-footer order
    and the footer as the last text. V2 still appends its banner after legacy verification text.
- **F3 — expected.** An unseeded task caller costs one `session.get` per session. Fake clients without `get`
  produce one warning. Step 2 gives the rule for adjusting fixtures.
- **F4 — accepted.**
  - If a v1 task call fails, the after-hook is (unverified) never called, so its banner entry stays. It is
    bounded by FIFO 1 000, purged on `session.deleted`, and keyed per `callID`, so it can never reach another
    call.
  - On v2 the bridge drops it on any non-completed status.
- **F5 — accepted residual (1.2 F2).** Pinned plugin evidence expires with the idle TTL. A plugin child without
  a backend `parentID` can then re-resolve as a root. This includes producers created without a caller and
  the usual native-path graders (N6), not only producers. Producers are disposed per attempt; graders are
  disposed after their prompt and bounded by `graderTimeoutMs`, far below the 60-minute
  `DEFAULT_IDLE_TTL_MS`. Normal live grading therefore stays within the pin's lifetime; a surviving grader
  or producer resumed after idle expiry still has the residual risk (for example after failed disposal).

### QA 2.3 review (2026-10-05, adversarial, `origin/de/main..6601202`)

Reviewed `744ef0d`…`6601202`. Scoped suites: 12 files / 207 tests pass, `vitest related src/index.ts`
29 files / 514 tests pass, `npm run typecheck` clean. Scratch tests for QA-2.3-1 and QA-2.3-2 were run
under `test\scratch\` and deleted; their failure output is quoted below.

| ID | Severity | File:line | Description | Resolution |
|---|---|---|---|---|
| QA-2.3-1 | major | `src\compat\v2-hooks.ts:332–353` | **On v2, a bannered completed `subagent` result loses the host's envelope and its session id.** For `subagent` the bridge takes `text` from `structured.output` (`:332–333`). With a banner and an unchanged legacy output it no longer returns early. It rebuilds `content` as `structured.output + banner` (`:341–348`) and drops the host's text part. Host evidence (`p23-host-proof\hooks.jsonl`, scenario `v2-E3-fg`): the root's unbannered result keeps `content: "<subagent sessionID=\"ses_ef4613dc6ffeUhO45A8djOxFd7\" state=\"completed\">\nok\n</subagent>"`. The caller's bannered result (call `toolu_proof_1791196316260`) reaches the model as `"ok\n\n[⚠ GUARD:delegation_depth] …"` (`captures.jsonl`; also `v2-E3-resume-setup` and `v2-E3-resume`). Scratch reproduction with that host shape: `expected 'ok\n\n[⚠ GUARD:delegation_depth] this…' to contain 'sessionID="leaf"'`. With the bundled default (advisory), every completed nested dispatch on v2 hides the child's session id, which is the resume handle, and its completion state. The proof did not see this because its resume fixture scripts the id from captures, and the unit fixture sets `content` equal to the structured output (`test\unit\v2-hooks.test.ts:160–163`). Verification-changed outputs take the same rebuild path. That predates 2.3 (inferred from code, not host-verified). Fix direction: when `!changed`, append the banner as an extra text part to the original `content`, as the running branch does (`:323–327`), and to `structured.output`. Add a unit case with host-shaped content. | Fixed in `593dfe4`: retain all host content, envelope/session ID and attachments; place translated verification additions around it and append the banner once. Host-shaped fixtures cover unchanged and verification-modified results. |
| QA-2.3-2 | minor | `src\index.ts:611–612`, `:1385` | **A `delegate` refusal is not D4-recorded, so the hand-back after it can be flagged as a false refusal.** The task path records every depth block unconditionally (N3, `:1194–1203`). The `delegate` path returns the D5 text, and only the generic after-hook records a tool event, and only for `isSubagent` callers (`:1385`). Scenario (enforced): C's transform lookup fails (fail-open: C gets the protocol and is not marked as a child). Later, `session.get(C)` returns `parentID: O`. C's `delegate` is refused, and C hands back. O's task after-hook then prepends `FALSE-REFUSAL SUSPECT`. Scratch: `expected '[router] FALSE-REFUSAL SUSPECT — this…' not to contain 'FALSE-REFUSAL SUSPECT'`. This needs a transient backend failure followed by recovery; the task path is covered. Fix direction: record `{ tool: "delegate", readOnly: false, blocked: true }` for `toolCtx.sessionID` inside a `try` before returning the D5 text. A double count for `isSubagent` callers is harmless, because the detector only tests for 0. | Fixed in `6f757a6`: best-effort blocked delegate event before returning D5. Regression reproduces fail-open transform/recovered backend and includes an untouched-child false-refusal control. |
| QA-2.3-3 | minor | `docs\qa\depth-and-effort\phase-2.3.md:222–225, 441, 447–449, 656–663` | **The design memo contradicts the shipped grader correction.** N6, step 4, the step-4 test text (`body.parentID === C`) and F1 all say the v1 native-path grader becomes a backend child of the caller. F1 also hands the effects (session tree, Layer-1 visibility, title request) to the 3.1 CHANGELOG. The code keeps it unparented and passes the caller only as the depth creator (`src\index.ts:1505–1506`, `src\verify\wiring.ts:1214, 1250, 1257`), and the test asserts this (`test\integration\depth-guard-wiring.test.ts:483–496`). The code conforms to plan A7 (creator only) and keeps the v2.0.0 backend `parentID`, so the correction holds. The memo is stale. Consequence for F5: native graders are now the usual plugin child without a backend parent, so F5's premise ("producers are disposed per attempt") does not cover them. The exposure is still bounded: `graderTimeoutMs` is far below `DEFAULT_IDLE_TTL_MS` (60 min, `src\router\idle-sweep.ts:1`). Fix: amend N6, step 4, F1 and F5, and withdraw F1 from the 3.1 handoff. | Fixed in `5df60e1`: corrected P13, N6, step 4, F1 and F5; backend parentage unchanged, caller used only for depth; CHANGELOG handoff withdrawn. |
| QA-2.3-4 | nit | `src\index.ts:1071–1075` (and `:1081–1082`) | **The grader-temperature `catch` can now throw into a session.** It was empty and could not throw. It now evaluates `scrubText(String(error))` and calls `logger.warn`. A thrown value with no primitive conversion (for example `Object.create(null)`) makes `String(error)` throw out of `chat.params`. This is contrived, because the `try` touches only host objects. The second `catch` is unreachable, because `applyEffortOverride` never throws. Fix: use a non-throwing describe helper (as `src\router\depth-guard.ts:13–19` does), or guard the log. | Fixed in `2b480f3`: non-throwing scrubbed formatter plus guarded diagnostic sinks in both catches. V1/v2 regressions throw `Object.create(null)` and also exercise a failing logger while the effort override still applies. |
| QA-2.3-5 | nit | `docs\qa\depth-and-effort\phase-2.3.md:220–221`; `src\index.ts:1441` | **N5's claim "a banner and a deferred footer cannot co-occur" is false for plugin children without a backend parent.** For these, the tracker holds depth ≥ 1 (`recordPluginChild`), while `isProvenRootCaller` trusts the backend's missing `parentID` and returns true. Examples: a v1 producer created without `toolCtx.sessionID`, or a v1 native-path grader (agent `build`, with a `task` tool, per the host-proof roles) dispatching a deferred `task` in advisory. The footer stays last, so the output is still well formed. Deferral for a depth-1 caller is itself a pre-2.3 classification gap. Code reading only, no test. | Fixed in `60e45c9`: corrected N5/F2; integration tests resume unparented producers/graders surviving disposal, assert one banner before one deferred footer, footer last, and a pending entry. |

#### Round 1 resolution verification (2026-10-05)

All five findings are resolved. Verification after `60e45c9`:

- Requested scoped run: `npx vitest run test/integration/depth-guard-wiring.test.ts test/integration/ladder-effort-wiring.test.ts test/integration/ladder-wiring.test.ts test/unit/v2-hooks.test.ts test/golden test/unit/prompt-measurement.test.ts --maxWorkers=50%` — **12 files / 215 tests passed**.
- Related run: `npx vitest related src/index.ts src/compat/v2-hooks.ts --run --maxWorkers=50%` — **29 files passed / 3 skipped; 522 tests passed / 55 skipped**. No failures; this was not the full suite.
- `npm run typecheck` and `git diff --check` — **passed**.
- Targeted per-finding runs also passed: v2 hooks 60 tests; depth wiring 58 tests after QA-2.3-2 and 60 after QA-2.3-5; ladder effort wiring 26 tests.
- The first QA-2.3-5 test run failed deferred registration because its result fixture omitted the returned child session ID. Adding host-style `task_id` / `metadata.sessionId` fixed the fixture; the rerun and both final suites passed.
- `protocol.ts`, `sessions.ts`, `tiers.json`, golden snapshots and prompt-measurement tests are unchanged. No new host-level proof was run; these resolutions are covered by the unit/integration runs above.

Attacks that held (no finding):

- **Enforced refusal from depth ≥ 1:** v1/v2 foreground, v2 background, `task_id`/`sessionID` resume, a producer
  without `parentID` (plugin pin), graders (both creation points), an out-of-order `session.created`, a
  fail-open root (never seeded), a session forgotten mid-walk and a hung lookup (fail-open by D2).
- **Exemptions by design (A1, A11):** `/bypass` and a caller tier with `perTier: "off"` disable the guard.
- **Refusal side effects:** a refusal leaves no `startDispatch`, `TASK_VERIFICATION`, prompt repair, header,
  `observeEdit`, `verifyingCalls` or banner entry.
- **G2:** a root is seeded by its transform and its memo hit re-seeds it for free (`getParent` short-circuits
  `sessionRootMemo === true`), so a dispatching orchestrator pays no lookup. Concurrent `task` calls share one
  walk.
- **Effort override scope:** keyed by producer sid, `agent === tierName` and model identity. The title, grader,
  orchestrator and other producers are untouched. It is cleared on every exit, including a `startDispatch`
  throw inside `registerProducer` on both hosts, the deferred path and the outer `finally`, and it is never set
  when `effortBump` is false.
- **v2 bridge:** A4 native-over-alias precedence holds. The banner is never delivered twice, is dropped on
  non-completed results and is FIFO-bounded.
- **Memory:** every new map and set is bounded (1 000 or 10 000) and purged on `session.deleted`.

## Deferred by plan

- **3.1 (docs):**
  - the A1 wording (warned in advisory, refused in enforced);
  - the A4 `Fixed` entry and key names (QA-1.3-9);
  - the A5 preset table;
  - A14;
  - the D11 limits, including `/bypass` (A11);
  - F1;
  - N11.
- **3.2:** 3.2.1(c)/(d) with the versioned `test\smoke\helpers\scripted-provider.ts`. The v2 legs are local
  evidence (A3).
- **Unverified (A5):** provider-side acceptance of bumped values. The per-prompt `variant` fallback is not built
  (A3).
- **Implementer/orchestrator DoD:** coverage ≥ 95 % of new code, and the capped full suite after the merge.

## Handoffs

- **To 2.3.2–2.3.6 (@medium):** steps 1–7, one commit each, in order. The tree must be green after each step.
  Steps 1–3 are 2.3.2, step 4 is 2.3.3, step 5 is 2.3.4, step 6 is 2.3.5 and step 7 is 2.3.6.
- **To the 2.3 owner (DoD gate):** step 8, recorded in `## Verdict` before merge.
- **To QA 2.3:**
  - attack F1–F5;
  - the `getParent` memo short-circuit (N4);
  - the unconditional D4 record (N3);
  - the pre-banner parse at `:1297` (N5).
- **To 3.1:** F1, F2 and N11, plus the deferred items above.
- **To 3.2:** reuse the step-8 copy as the base of `scripted-provider.ts`.
- **To 3.1 (from QA 2.3):**
  - **Withdraw F1** (QA-2.3-3). Native-path graders keep the v2.0.0 backend parent (none on v1). Only the
    depth record uses the caller. There is no session-tree or title change to announce.
  - **The OpenCode 2 host has its own nesting cap**, `experimental.subagent_depth` (default 1), independent of
    the router. Captured error: `Subagent depth limit reached (1). Increase "experimental.subagent_depth" to
    allow nested subagents.`
    - On v2 the effective nesting limit is the lower of that cap and `enforcement.maxDelegationDepth`.
      Raising only the router key, or only a top-level `subagent_depth`, does not allow nested dispatch on v2.
    - The proof rig also set top-level `subagent_depth: 4` to lift a v1 1.18.19 host cap (`REPORT.md`). Its
      default and its documentation upstream are unverified.
    - v2's `general` agent needs an explicit `subagent` permission to dispatch at all (`No tool named
      "subagent" is currently available`).
    - v2 resumes only a direct child of the caller.
  - **Exemptions:**
    - the caller tier's `enforcement.perTier` value applies to the depth guard (A1). `perTier: "off"` disables
      it for that caller, as `MODEL_ROUTER_ENFORCE=0` disables it everywhere.
    - `/bypass` disables it on both paths (A11).
    - the effort bump ignores `/bypass` (N11).
  - **Refusal shapes:** a refused `delegate` returns the D5 text as a normal tool result; a refused `task` is
    an `is_error` tool result.
  - **v1 graders** run on the default `build` agent, which has `task` (host-proof roles). They are
    depth-limited at creator depth + 1.
- **To 3.2 (from QA 2.3):**
  - **Smoke:**
    - Assert the model-visible v2 envelope on a bannered completed result: the HTTP `tool_result` must still
      contain `<subagent sessionID=` (QA-2.3-1).
    - Use host-shaped fixtures, where `content` (the envelope) differs from `result.output.output`.
    - v2 background results carry `status: "running"` in `result.output`/`metadata`, not an XML attribute.
    - The v2 fixture needs `experimental.subagent_depth` plus an explicit `general` `subagent` permission;
      the v1 fixture needs top-level `subagent_depth`.
    - `deferred-catalog.smoke.test.ts:102–121` reads `<home>/.local/share/opencode/log`, but its child
      inherits `XDG_DATA_HOME` (`:197`). Either honour that variable or unset it in the test (A12 isolation).
  - **Mutation candidates** (suggested, not executed in this review):
    - Expected killed by the current suites:
      - removing `effortOverrides.clear` from the outer `finally` (ladder-effort `size() === 0` after a
        `prepareVerification` throw);
      - swapping the v1/v2 `chat.params` target;
      - parsing the bannered output at `index.ts:1420`;
      - removing the bridge's `depthBanners.delete`;
      - removing the `getParent` memo short-circuit (G2 counts).
    - Expected to survive today:
      - rebuilding instead of appending in the bridge's banner-only completed branch (QA-2.3-1);
      - any `delegate`-path D4 change (QA-2.3-2).

## Verdict

Design complete. It is ready for step 1. The host-level proof (step 8) is pending.

**QA 2.3 (2026-10-05): pending fixes.** QA-2.3-1 (major), QA-2.3-2 (minor), QA-2.3-3 (minor, docs),
QA-2.3-4 (nit) and QA-2.3-5 (nit) are open. No critical finding:

- no enforced-mode bypass was found for a known-deep caller;
- the override reached no wrong session;
- a refusal left no dispatch state;
- the golden and prompt-measurement suites, and every suite related to `src\index.ts`, pass with no `-u`.

The host-level proof above stands. QA-2.3-1 was found in its own retained captures.
