# Phase 2.1 — Background-first dispatch with completion-time guarantees

Worktree `D:\git\omr-cpx-p21`, branch `cpx/p21`, base tag `cpx/p21-base` = `558e5b8`. Started 2026-10-11 06:17.

## Pre-flight

- [x] Depends on: merged into `cpx/main` (Wave 1 merges `12d42b7`, `6d310eb`, `d4d731b`, `a9e32c1`; 0.1 final `915b96a`).
- [x] Worktree from `cpx/main` at `558e5b8` (tag `cpx/p21-base`, pushed), `npm ci`, clean; typecheck green; `smoke:cpx` 52/52 and `smoke:keyless`/`smoke:v1` = baseline at `915b96a`.
- [x] Anchors and task list (explorer `ses_ed5b8fcf1ffekca1nfk7hM00V2`): no write-set overlap between Wave-2 phases; within 2.1, `src\index.ts` (2.1.4 then 2.1.6) and `docs-drift.test.ts` (2.1.2 then 2.1.7) are sequential.
- [x] Drifted anchors (re-located): v2-hooks forced foreground ≈1575-1576/≈1640/≈1667, running ack ≈1782, event loop ≈1871-1905; `src\index.ts` execute.before ≈2250, execute.after ≈2425, `assembleSystemPrompt` call ≈3159; `reference.ts` `gcStaleReferences` ≈2021.

## Implementation notes

### 2.1.1 design memo (architect, heavy pin, `ses_ed5b6a4e0ffeR7pqBu38YEzi89`)

Orchestrator decisions (binding):
- §15.1: `src\router\git-tools.ts` joins the 2.1.5 Writes (export `nearestRepository`, the `repositoryIdentity` adapter, git-search filtering in `inspectGit`).
- §15.4: a FAIL verdict posts the foreground-equivalent text (output + findings): one finish path.
- §15.5: the depth banner stays on the ack. §15.2, §15.3, §15.6, §15.7 accepted as written (plan amendment A-2.1-1 at merge).

# Phase 2.1 — design memo (2.1.1)

**Precedence.** The Wave-1 handoffs override the plan where they conflict: 1.1 Handoffs, 1.2 Handoffs, 1.3 §5 and Handoffs, 1.4 A3. Every conflict is listed in §15.

## 0. Problem framing (code at `cpx/p21`)

- **P1/P2 – every routed dispatch is forced to the foreground.**
  - `nativeArgs` adds `background: false` whenever `verifying || foreground` (`src\compat\v2-hooks.ts:83-88`).
  - `roleForeground` is set for every routed role dispatch (`:1576`, `:1640`), and `nativeArgs` is applied at `:1667`.
- **P3 – a call the user moves to the background loses every guarantee.**
  - `execute.after` returns early on `status === "running"`. At most it appends "This subagent is still running. Its result has not been verified…" (`:1782-1797`).
  - The legacy `tool.execute.after` (`:1810-1815`) never runs for that dispatch, so it gets no verification, no budget or authority signals, and no deferred registration.
- **Role annotations need the result.**
  - `roleAfterCall` (`:1683-1735`) computes budget and authority notices only when `!running` (`:1701-1718`).
  - Its `finish()` calls `evictCall(end.sessionID, end.id)` even for a running ack (`:1729`). This is a hazard once role dispatches can start in the background (§4.2).
- **Turn state.** It rides in a trailing `user` tail (`:1501-1508`, Phase 1.2). The system prompt must stay byte-stable (ADR D4).
- **Event loop** (`:1855-1916`):
  - `session.step.ended|failed` end in `continue` (`:1865-1869`), so later branches never see them.
  - Execution end only reaches ingest (`:1890`) and the legacy `session.idle` translation (`:1907-1908`).
  - Synthetic posts exist today only with `resume: false` (`:1319`, `:1899`).
- **Multiple instances.** Every plugin instance in one process may receive the same hook event. Routing dedupes with a process-wide `handledCalls` set (`src\routing\wire\dispatch.ts:358-365`). Background processing needs the same protection.

## 1. Options and recommendation

| Topic | Options | Recommendation |
|---|---|---|
| Where guarantees run | (a) annotate at the ack; (b) rewrite the host completion; (c) a completion processor keyed by child | (c), as ADR D2 requires. (a) has nothing to annotate yet, and (b) breaks the cache. |
| How the adapter reaches the legacy finish code | (a) duplicate the logic in v2-hooks; (b) an attach symbol on the legacy hooks object, the same pattern as `ROUTER_TURN_STATE_ATTACH` (`src\index.ts:3378`, `src\compat\turn-state.ts:21`) | (b). The symbol lives in `src\compat\background.ts`, never in `main` (QA-1.2-1; `main-exports.test.ts`). |
| When the hold handle exists | (a) at completion; (b) reserved at the ack | (b). The placeholder is a pure function of the handle and must be in place before any completion can reach a request. |
| Held state across a restart | (a) memory only; (b) persisted hold records | (b). Without it the original completion reappears after a restart: a leak. |
| Background non-held dispatches across a restart | (a) forget them; (b) persist in-flight records and wake the parent once if the child was lost | (b). Otherwise the protocol rule "end the turn — the router wakes you" breaks after a restart (C12: no completion is delivered). |
| Which parents get background | (a) any session; (b) root sessions only | (b). Annotations travel in the turn-state tail, which is root-only (D4). A child parent keeps today's behaviour. |
| FAIL verdict content | (a) findings only (plan wording); (b) the same text the foreground path shows | (b), one finish path (§15.4). Orchestrator to confirm. |

## 2. Module APIs

### 2.1 `src\compat\background.ts` (new; no side effects at load)

```ts
import type { DurationEstimate } from "../routing/outcomes/durations";
import type { Holder, LeaseRegistry, LeaseScope } from "../router/leases";

export const COMPLETION_SETTLE_MS = 2000;
export const MAX_LIVE_ATTEMPTS = 1000;          // 2.1.3.b
export const MAX_CALL_RECORDS = 1000;
export const MAX_EARLY_ENDS = 200;             // = timings MAX_UNBOUND_OUTCOMES (timings.ts:46)
export const EARLY_END_TTL_MS = 10 * 60_000;   // = UNBOUND_OUTCOME_TTL_MS (timings.ts:48)
export const MAX_PROCESSED_KEYS = 5000;        // = MAX_SEEN_EVENT_IDS (timings.ts:35)
export const ATTEMPT_SWEEP_AGE_MS = 6 * 3600_000; // = OPEN_START_TTL_MS (timings.ts:33)
export const MAX_COMPLETED_PER_PARENT = 32, MAX_COMPLETED_PARENTS = 1000;
export const MAX_HOLDS_PER_PARENT = 256, MAX_HOLDS_GLOBAL = 10_000;

/** Attach channel: the legacy plugin (index.ts) defines it non-enumerable on its hooks object; v2-hooks calls it once at setup. */
export const ROUTER_FINISH_ATTACH: unique symbol = Symbol.for("router.finishDispatch.attach");
export type FinishAttach = (deps: { host: "v2"; held: HeldSink }) => FinishApi | undefined;

// ---- D1 policy -------------------------------------------------------------------------------
export type BackgroundMode = "auto" | "model" | "off";
export interface BackgroundInput {
  mode: BackgroundMode;
  explicit: boolean | undefined;     // only a boolean `background` argument counts
  verifying: boolean;                // TASK_VERIFICATION (v2-hooks.ts:1652)
  verificationMode: "required" | "deferred" | "none"; // FinishApi.verificationFor(callID)
  roleRouted: boolean;               // today's roleForeground (routed.role !== undefined, :1640)
  estimate: DurationEstimate | undefined;
  minPredictedMs: number;            // routing.background.minPredictedMs
  minSamples: number;                // DURATION_MIN_SAMPLES (durations.ts:34)
  acceptance: { testsPass: boolean; buildPasses: boolean };
  planTask: boolean;                 // seam; false in 2.1 (launcher A bypasses execute.before, D14)
  holdingAvailable: boolean;         // HeldResults.available && FinishApi.canHold(parent) && holds under cap
  parentIsRoot: boolean;
  liveCount: number;                 // InFlightRegistry.liveCount()
}
export type BackgroundReason = "off" | "model-unset" | "child-parent" | "cap" | "explicit"
  | "explicit-no-holding" | "estimate" | "acceptance" | "plan-task" | "no-holding" | "short" | "prior";
export interface BackgroundDecision { background: boolean | undefined; hold: boolean; reason: BackgroundReason }
export function decideBackground(input: BackgroundInput): BackgroundDecision;   // §6; pure

// ---- in-flight registry ----------------------------------------------------------------------
export type AttemptState = "decided" | "acknowledged" | "child-ended" | "processing" | "annotated"
  | "held" | "verdict" | "released" | "foreground" | "cancelled" | "closed-unknown";
export interface CallRecord {
  callID: string; parentSessionID: string; agent: string; role?: string; description: string;
  verifying: boolean; verificationMode: "required" | "deferred" | "none";
  decision: BackgroundDecision; resumeOf?: string; at: number;
}
export interface Attempt extends CallRecord {
  key: string;                       // `${childSessionID}\u0000${callID}` (§10)
  childSessionID: string; state: AttemptState; userBackgrounded: boolean;
  hold?: { handle: string };
  ackAt?: number; endedAt?: number; outcome?: "succeeded" | "failed" | "interrupted" | "unknown";
  annotations: string[]; pendingShown: boolean; waitedOnce: boolean; shownInTurn?: number;
}
export interface EndFact { outcome: "succeeded" | "failed" | "interrupted"; eventID: string; at: number }
export interface InFlightRegistry {
  /** execute.before (subagent). false: another instance claimed this callID (process-wide set, like claimCall). */
  decide(rec: CallRecord): boolean;
  acknowledge(callID: string, child: string, ack: { userBackgrounded: boolean; hold?: { handle: string } }): Attempt | undefined;
  foreground(callID: string, child: string | null): void;  // completed (non-running) result: terminal for the processor
  cancel(callID: string): void;                            // error / null child / onCallFinished
  byChild(child: string): Attempt | undefined;             // the newest attempt of the child
  byCall(callID: string): CallRecord | Attempt | undefined;
  noteEarlyEnd(child: string, end: EndFact): void;         // end before the ack; bounded, TTL
  takeEarlyEnd(child: string): EndFact | undefined;
  listForParent(parent: string): readonly Attempt[];
  liveCount(): number;
  forgetSession(sessionID: string): void;
  sweep(now: number): readonly Attempt[];                  // open > ATTEMPT_SWEEP_AGE_MS → closed-unknown
}
export function createInFlightRegistry(deps: { now(): number; logger: Logger }): InFlightRegistry;

// ---- completion processor --------------------------------------------------------------------
export type Trigger =
  | { kind: "end-event"; outcome: EndFact["outcome"]; eventID: string; at: number }
  | { kind: "completion"; state: "completed" | "error" | "cancelled"; body: string | undefined; at: number }
  | { kind: "early-end"; end: EndFact }
  | { kind: "recovery"; outcome: EndFact["outcome"] | "lost"; text: string | undefined; at: number }
  | { kind: "runner"; status: EndFact["outcome"]; text: string; at: number };   // 3.1 (launcher A)
export interface CompletionDeps {
  finish: FinishApi["finish"];
  readChildResult(child: string): Promise<{ outcome?: EndFact["outcome"]; text?: string } | undefined>; // ctx.session.context (C7/O1)
  roleCompletion(a: Attempt, text: string): Promise<string[]>;   // the !running half of roleAfterCall (§4.2)
  releaseLeases(holderID: string): void;
  held: HeldResults; persist: InflightJournal; now(): number; logger: Logger;
}
export interface CompletedLine { child: string; label: string; text: string /* annotations or "router guarantees pending" */ }
export interface CompletionProcessor {
  process(childSessionID: string, trigger: Trigger): Promise<void>;          // once per attempt; never throws
  settled(childSessionID: string, timeoutMs: number): Promise<boolean>;
  completedFor(parent: string): readonly CompletedLine[];                    // sync, for the "completed" provider
  endTurn(parent: string): void;                                             // root execution end: drop lines already shown
  forgetSession(sessionID: string): void;
}
export function createCompletionProcessor(reg: InFlightRegistry, deps: CompletionDeps): CompletionProcessor;

// ---- held results (only when available) ------------------------------------------------------
export type HeldVerdict = { verdict: "PASS" | "FAIL" | "UNVERIFIABLE"; text: string; reason?: string };
export interface HeldSink { verdict(handle: string, v: HeldVerdict): Promise<void> }
export interface HeldResults extends HeldSink {
  readonly available: boolean;      // context AND compaction hooks registered AND ctx.session.synthetic is a function
  hold(rec: { handle: string; parentSessionID: string; childSessionID: string; callID: string }): Promise<void>; // fsync append, then active
  isHeld(child: string): boolean;   // true until the verdict entry is posted
  placeholder(handle: string, child: string): string;                        // pure (§7.1)
  applyText(sessionID: string, text: string): string;                        // the matcher (§7.2)
  apply<M>(sessionID: string, messages: readonly M[]): M[] | undefined;      // copies; undefined = unchanged
  refusal(sessionID: string, tool: string, args: unknown): string | undefined; // resume / Code Mode refusal (§7.4)
  heldFor(parent: string): readonly { handle: string; child: string; label: string; status: string }[];
  forgetSession(sessionID: string): void;
  restore(records: readonly PersistedRecord[]): void;
}
export function createHeldResults(deps: { synthetic: SyntheticFn; journal: InflightJournal; available: boolean; logger: Logger }): HeldResults;

// ---- leases (process-wide registry over Phase 1.3) ---------------------------------------------
export function acquireLeaseRegistry(opts: { runMode: "annotate" | "refuse"; seams: LeaseSeams; snapshotPath: string; logger: Logger }):
  { registry: LeaseRegistry; onRelease(cb: () => void): () => void; notifyReleased(): void; release(): Promise<void> }; // ref-counted
export interface LeaseGuard {
  before(e: { sessionID: string; tool: string; args: unknown; callID: string }): Promise<{ refuse?: string; runNote?: string }>;
  afterSearch(e: { sessionID: string; tool: "glob" | "grep"; result: unknown }): { result: unknown; note?: string } | undefined;
  releaseChild(child: string): void;   // until-complete only; until-integrated retained (leases.ts §5)
  waitTreeFree(tree: string, owner: { producer: string; taskRef?: string }, deadlineMs: number, signal: AbortSignal):
    Promise<{ waitedMs: number; holders: string[]; fileCount: number }>;
}
export function createLeaseGuard(deps: {
  registry: LeaseRegistry; sessionKind(sid: string): Promise<"root" | "child">; sessionDir(sid: string): Promise<string>;
  gitRootOf(dir: string): string | undefined; holderLabel(holderID: string): string;
  planTaskOf(sid: string): { planId: string; taskId: string; slot: string } | undefined; // seam; undefined in 2.1
  events: { onRelease(cb: () => void): () => void };
}): LeaseGuard;
```

### 2.2 The finish attach (`src\index.ts`, 2.1.4.a)

```ts
export interface FinishInput {
  callID: string; parentSessionID: string; childSessionID: string;
  outputText: string;                       // child's final text (defanged for role children, as :1776-1778)
  status: "succeeded" | "failed" | "interrupted" | "unknown";
  mode: "foreground" | "background"; heldHandle?: string; endedAt: number;
  delta?: DispatchDelta;                    // verify/dispatch.ts change set computed at child end (2.1.4.b)
}
export type FinishResult = {
  outputText: string;                       // what the foreground path writes into output.output
  suffix: string;                           // outputText minus the child's text (router lines only)
  verification: { kind: "none" } | { kind: "deferred"; handle: string } | { kind: "held"; handle: string }
              | { kind: "required"; verdict: "PASS" | "FAIL" | "UNVERIFIABLE" };
  metadata: Record<string, unknown>;
};
export interface FinishApi {
  verificationFor(callID: string): { mode: "required" | "deferred" | "none"; acceptance: { testsPass: boolean; buildPasses: boolean } } | undefined;
  canHold(parentSessionID: string): boolean;                // a pending slot exists (MAX_ENTRIES_PER_SESSION/GLOBAL, pending.ts:399-400)
  reserveHeld(parentSessionID: string, callID: string): string | undefined;  // pending.reserveHandle
  finish(input: FinishInput): Promise<FinishResult>;
}
```

- The legacy `tool.execute.after` becomes "build `FinishInput` from `(input, output)` → `finish` → write `output.output`/metadata". Foreground bytes stay identical.
- `finish` with `heldHandle`:
  1. registers the pending entry with that handle in state `held`;
  2. starts the **same required gate the foreground path runs**, without awaiting it;
  3. returns `{kind: "held"}`;
  4. on settle, calls `HeldSink.verdict(handle, {verdict, text: <foreground-equivalent output + suffix>})`.
- `finish` with `mode: "background"` and a deferred DoD registers the handle. The footer goes into `suffix`, which the processor shows in the "completed" section.
- `finish` is invoked inside `within(hookContextFor(attempt))`: a host context synthesized from `{sessionID: parent, callID, agent}`.

### 2.3 `src\verify\pending.ts` (2.1.4.c)

- `PendingState = "unverified" | "verifying" | "verified" | "held"`.
- Transitions:
  - `held → verifying` (claim);
  - `verifying → verified` (terminal; fires `onVerdict`);
  - a retryable settle on a held entry goes back to `held` (not `unverified`), up to `BACKGROUND_MAX_ATTEMPTS` (`:444`), then UNVERIFIABLE.
- `PendingEntry.hold?: { childSessionID; callID }`. `listPending` excludes `hold` entries; the "held" provider shows them. New `listHeld(sessionID)`.
- Held entries are **never evicted by caps** (`EvictionCause` session-cap, global-cap, weight-cap). They still count toward the caps.
- TTL on a held entry → settle UNVERIFIABLE ("verification did not finish within pendingTtlMs") → posted.
- New API:
  - `reserveHandle(sessionID): string | undefined`;
  - `register` is idempotent on `dispatchID`: same `dispatchID` → `{ok: true, handle: <existing>}`;
  - `findByDispatch(dispatchID)`;
  - options `onVerdict?(entry, result)` and `persist?: PendingJournal` (passed only when `ctx.routerHost === "v2"`);
  - `restore(records, {now})`.
- Persisted fields per plan: handle, session, DoD, change set, serialized reference, risk, description, state, createdAt (§11).

### 2.4 `src\verify\reference.ts`

- `serializeReference(ref: DispatchReference)` and `deserializeReference(json)` (`DispatchReference` at `:811`). They carry commit, tracked and untracked digests, and links.
- `keepReferences(keys: Iterable<string>)`:
  - marks the reloaded `omr-ref-<pid>-<suffix>` dirs (`REF_DIR_PATTERN` `:887`) active and heartbeats them under the new pid;
  - `gcStaleReferences` (`:2021`) skips kept dirs.
- The start-time GC (`REFERENCE_GC_START_DELAY_MS = 45_000`, `src\verify\wiring.ts:340`) awaits the reload promise (bounded 10 s) before it scans.
- A reference that cannot be re-materialized is marked `approximate`. A missing commit makes the entry `unverifiable` with reason `reference commit <sha> no longer exists`.

### 2.5 `src\verify\wiring.ts`

- `deferredFinish` (`DeferredFinishInput` `:390`) accepts `delta?: DispatchDelta`, computed by `verify/dispatch.ts` `captureDelta(callID, child)` at child end (2.1.4.b).
- Dep `leaseGate?: Pick<LeaseGuard, "waitTreeFree">`. It is absent on v1 and when `routing.leases.mode: "off"`. Before any plugin verification run in tree T:
  1. call `waitTreeFree(T, {producer, taskRef}, gateBudgetMs, signal)`;
  2. if holders remain at the deadline, run anyway and add the existing caveat (`applyDispatchCaveats` / `concurrentDispatchesCaveat`, `:183-235`).
- `export function preemptBackgroundVerification(): Promise<void>`:
  - iterates a module-level set of live wirings;
  - each aborts its in-flight 2.4.5 background-queue run (the QA-2.4-5 path, `:1402-1410`, `:2139`) and resolves when it settled;
  - held required runs are **not** preempted, because a parent waits on them. Handoff to 3.2.

### 2.6 Config (2.1.2), `src\router\config.ts`

| Key | Type | Default | Validation |
|---|---|---|---|
| `routing.background.mode` | `"auto"\|"model"\|"off"` | `"auto"` | enum |
| `routing.background.minPredictedMs` | int | 45000 | 0–3600000 |
| `routing.leases.mode` | `"enforce"\|"off"` | `"enforce"` | enum |
| `routing.leases.run` | `"annotate"\|"refuse"` | `"annotate"` | enum |

- Values go through `ROUTING_DEFAULTS`/`resolveRouting`; an invalid value warns and falls back to the default.
- `export function configuredV2OnlyKeys(raw): string[]` lists the keys the user configured. `index.ts` (2.1.4) logs `[router] <key> requires OpenCode v2; ignored` once per key per process when `ctx.routerHost !== "v2"`.

### 2.7 `src\routing\wire\dispatch.ts` (2.1.5)

- `DispatchRouter.decisionOf(callID): { role; class; scope; tier; model } | undefined`. Under `static`, class and scope are `"unknown"` (1.1 handoff).
- The role path's foreground assumption (task-cited ≈1048; plan ≈1764-1769 on main) reads the decision instead of assuming foreground.
- `MAX_ANNOTATED_CHILDREN` (`:368`) goes from 256 to 1024 (≥ `MAX_LIVE_ATTEMPTS`). Background children collect budget and authority annotations for hours before `takeSubagentAnnotations` (`:394`).

### 2.8 `src\router\protocol.ts` (2.1.6)

- Signature becomes `assembleSystemPrompt(cfg, model, enfOn, host: "v1" | "v2" = "v1")`. `buildRolesProtocol` gets the same block.
- Call site `src\index.ts:3159` passes `isV2Host ? "v2" : "v1"`.
- The block, v2 only. Lines 1–3 are emitted when `background.mode !== "off"`; line 4 when `leases.mode === "enforce"`; nothing otherwise:

```
## Background dispatches
- After a background dispatch, continue any independent work; when none remains, end the turn — the router wakes you. Never poll or sleep.
- A held result is not usable until its verdict arrives. Never report a task done while dispatches are listed in flight.
- A lease refusal is resolved by waiting for the holder, not by retrying.
```

Adding the same block to both protocols keeps the roles ≤ tiers byte-length pin (`roles-protocol.golden.test.ts` ≈85).

## 3. Dispatch state machine (per attempt; key §10)

```
decided ─execute.after running──────────▶ acknowledged ─trigger*──▶ child-ended ─▶ processing ─┬─(no hold)─▶ annotated ─parent turn end after first render─▶ released
   │                                         │                                                └─(hold)───▶ held ─settle─▶ verdict ─synthetic posted─▶ released†
   ├─execute.after completed (not running)─▶ foreground   (legacy finish ran in-line; the processor never runs; leases and timing only)
   ├─error / null child / onCallFinished───▶ cancelled
   └─(any open state) 6 h sweep | lost at restart ─▶ closed-unknown (hold → verdict UNVERIFIABLE, posted)
* trigger = end-event | completion seen in the parent's context (C2) | early-end | recovery | runner (3.1)
† the placeholder stays for the session's life (C4: history keeps the original)
```

## 4. Data flow per host event (v2 only; `registerV2Hooks`)

### 4.1 Startup (inside `registerV2Hooks`, before the hooks register)

1. `acquireTimingRecorder({dir: resolveOutcomesDir(…), now, logger, onRow})` whatever `routing.engine` is.
   - Duration model: `createDurationModel(durationSeamsFor(createSideLogs(dir, deps), now))`, `load()` not awaited (until it loads, estimates are `undefined`); `onRow` → `observe(row)` when `row.kind === "dispatch-timing"`.
   - Sweep on an unref'd 5-min interval: `recorder.sweep()`, `inflight.sweep()`, `leases.sweep()`.
2. When `leases.mode === "enforce"`: `acquireLeaseRegistry`. The `repoKeyOf` adapter is `repositoryIdentity` (§15.1). Then `restore(<outcomes>\leases.json, {dropCompleteHolders: true})` (1.3 handoff).
3. Pending reload from `pending.jsonl` (§11). It is **awaited before the context hook registers**, bounded 5 s. On failure it falls back to fail-closed redaction (§12).
4. `attachFinish = legacy[ROUTER_FINISH_ATTACH]`, called once, like `attachTurnState` (`:748`).
5. Register the providers `completed`, `held`, `in-flight` through the attached turn-state registry (§13).
6. Register the context hook and **the compaction hook**. `HeldResults.available` is true only if both registrations and `typeof ctx.session.synthetic === "function"` succeeded.
7. Log `[router] plugin root <realpath>` once (2.1.5.f; QA records the sink).

### 4.2 `execute.before` (`:1540-1674`)

1. Role refusals stay first (`:1557-1574`). **Authority checks run before lease checks** (1.3 handoff).
2. **Held refusal:** `held.refusal(sessionID, tool, args)` for:
   - `subagent` with `sessionID`/`task_id` naming a held child;
   - `execute` whose code contains the id of a held child of this session.
   A refusal is thrown through `refused()` (`:1557-1560`).
3. **Leases:** `leaseGuard.before(...)` for file tools, `router_git_*` and `router_run`, before the legacy hook. A refusal is thrown with `refused()`; a `runNote` is stored as `runNotes.set(event.id, note)` (bounded 1000).
4. The routing block is unchanged (`:1576-1644`), but `roleForeground` becomes an input (`roleRouted`) and no longer forces anything.
5. Inside the `try`, after the legacy hook (`:1650`) and `verifying` (`:1652`):

```ts
const vf = finishApi?.verificationFor(event.id);           // mode + acceptance from the legacy before-hook
const decision = event.tool === "subagent" ? decideBackground({ mode, explicit: typeof args.background === "boolean" ? args.background : undefined,
  verifying, verificationMode: vf?.mode ?? "none", roleRouted: roleForeground, estimate: durations?.estimate({ role, class, scope }),
  minPredictedMs, minSamples: DURATION_MIN_SAMPLES, acceptance: vf?.acceptance ?? NONE, planTask: false,
  holdingAvailable: held.available && finishApi?.canHold(parent) === true, parentIsRoot, liveCount: inflight.liveCount() }) : undefined;
event.input = nativeArgs(event.tool, output.args, original, decision?.background);   // signature: (…, background: boolean | undefined)
// nativeArgs: `...(background === undefined ? {} : { background })` — mode off yields (verifying||roleForeground ? false : undefined) = today
if (decision) inflight.decide({ callID: event.id, parentSessionID, agent, role, description, verifying, verificationMode, decision, resumeOf: resumeID, at });
```

6. After `commit` (`:1673`), for `subagent` only:

```
recordDispatchStart({ callID: event.id, childSessionID: resumeID ?? null, parentSessionID,
  role, class, scope, tier, model, background: event.input.background === true, at })
```

   This follows the 1.1 handoff: it is not called inside `commit`, and a hook-chain rejection (`:1669`) makes no call.

### 4.3 `execute.after` (`:1736-1851`)

1. `dispatchRouter.onCallResult` (`:1739`). Timing: a non-null child calls `bindChild` (plus `setBackground(id, true)` when running); a null child calls `cancelStart`.
2. **Running `subagent` result** with mode ≠ off and a root parent. This step runs **as the first statement, before `roleAfterCall`**, so the hold exists before any completion can be rendered:
   - `hold = verifying && verificationMode === "required" && held.available && canHold`;
   - `handle = hold ? finishApi.reserveHeld(parent, id) : undefined`;
   - `inflight.acknowledge(id, child, {userBackgrounded: decision?.background !== true, hold})`;
   - `await journal.append({kind: "inflight", …}, {fsync: true})`;
   - if held, `await held.hold(…)`, which also fsyncs;
   - if `takeEarlyEnd(child)` returns a fact, call `process(child, {kind: "early-end"})` without awaiting.
3. `roleAfterCall`, running branch: `finish()` must **not** call `evictCall` for a running ack. The processor calls it at completion. Otherwise an auto-backgrounded role child loses its pending binding before its first request (`:1729` vs `:1416-1427`).
4. The ack's text (`:1782-1797`):
   - **off** — byte-identical.
   - **auto/model** — the "not verified" line is replaced by one of:
     - `[router] Running in the background (<child>). Its result is held until verification finishes.` (held);
     - `… Router guarantees apply when it completes.` (not held);
     - `… Its result will arrive unverified; the verdict follows in the router state.` (verifying without holding; user-backgrounded only).
   - The depth banner stays on the ack (§15.5).
5. **Completed `subagent` result:** `inflight.foreground(id, child)`. The legacy path runs in-line as today; drop any `earlyEnds` for that child.
6. `glob`/`grep` from a child session: `leaseGuard.afterSearch` rewrites the result and adds one note line.
7. `router_run`: append `runNotes.get(id)` as a text part, the same way the banner is appended.

### 4.4 `buildContext` (`:1389-1509`) and the compaction hook

1. **First step, before `chat.params` and before `systemAugmenter.augment` (`:1465`, which reads `event.messages`):**
   `const r = held.apply(sid, event.messages); if (r) event.messages = r`.
   Otherwise the advise route hint could be derived from a held output and land in the tail.
2. Defang: in every `<subagent …>` element body (auto/model only), apply `defangRouterLines` (`:164`). This is a pure function and keeps parity with `defangChildResult` (`:1776`).
3. Root sessions, before placing the tail (`:1501`):
   - scan the completion elements `<subagent sessionID="X" state="S"` (text-part prefix, C2);
   - for each X whose attempt is `acknowledged|child-ended`, call `process(X, {kind: "completion", state: S, body})` without awaiting;
   - for attempts with `waitedOnce === false`, set `waitedOnce = true` and `await Promise.race([all settled(X), sleep(COMPLETION_SETTLE_MS − elapsed)])`. **One shared 2000 ms budget per request.** It is never awaited again for the same attempt.
4. The tail is built by `buildTurnState`. An unsettled attempt renders `router guarantees pending`.
5. **Compaction hook:** `event.messages = held.apply(sid, event.messages) ?? event.messages`, with the same matcher (C15; the latest turn is excluded by the host).

### 4.5 `prompt` hook (`:1373-1387`)

- The session is already fetched (`:1374`). If it has no `parentID`: `markRootSession(sid)` and `onRootPrompt(sid, at, messageID)`, not awaited.
- The session-kind cache records "root".

### 4.6 Event loop (`:1855-1916`)

| Event | Added work (before any existing `continue`) |
|---|---|
| `session.created` | No `parentID` → `markRootSession`; the session-kind cache records root or child. |
| `session.step.ended` | Root session: `onRootStep(sid, {input, cacheRead, cacheWrite}, event.id)`. Unregistered session: one lazy `ctx.session.get`, not awaited, memoized → `markRootSession` if it has no parent. Then today's ingest and `continue` (`:1865-1869`). |
| `session.step.failed` | `classifyCapacity({type, status})` (`timings.ts:225`) non-null → `onCapacitySignal(sid, c, at)`. Then the existing line. |
| `session.retry.scheduled` (new) | Same classification → `onCapacitySignal`. |
| `session.execution.succeeded\|failed\|interrupted` | (1) `await recorder.onExecutionOutcome(sid, event.id, outcome, event.created)`. (2) `leaseGuard.releaseChild(sid)` and `notifyReleased()`. (3) Attempt is `acknowledged` → `process(sid, {kind: "end-event", …})`, not awaited. No attempt → `noteEarlyEnd`. The attempt is `foreground`/`decided` → nothing (D2 suppression). (4) Root session → `processor.endTurn(sid)`. Then today's ingest and legacy `session.idle`. |
| `session.deleted` | `inflight.forgetSession`, `processor.forgetSession`, `held.forgetSession` (journal `forget`), `leaseGuard.releaseChild`, and the existing evictions (`:1872-1885`). |

### 4.7 Processor body (`process`, once per attempt)

1. If the attempt key is in `processed` (memory or journal) → return. Otherwise set `state = processing` and create the settle promise.
2. Text:
   - trigger body (completion or runner) when present;
   - otherwise `readChildResult(child)` (C7/O1: the last `assistant` message);
   - if that fails on an end-event trigger, stay `child-ended` and wait for the completion trigger. The context-hook wait covers this.
3. `delta = captureDelta(callID, child)`; then `roleCompletion` (the `!running` half of `roleAfterCall`, `:1701-1718`, plus `discardAuthority`/`markAnnotated`/`catalogFailures.delete`/`evictCall`).
4. `finishApi.finish({mode: "background", status, heldHandle, …})`.
5. `releaseLeases(child)` (idempotent), then append `{kind: "processed"}` to the journal.
6. Not held: `annotations = [roleNotices, suffix]` → `annotated`. Held: `held`; the verdict arrives through `HeldSink`.
7. Failed or interrupted child (no gate, as at `:1756`): held → `verdict(UNVERIFIABLE, text + "[router] not verified: the dispatch ended <state>")`.
8. Any throw → log, mark processed with annotation `router guarantees failed: <reason>`, and settle. Never rethrow.

## 5. Verdict delivery

- `HeldSink.verdict(handle, v)`:
  1. journal `{kind: "posting", handle}`;
  2. `ctx.session.synthetic({sessionID: parent, text, description: "Model router verdict", metadata: {router: {kind: "held-verdict", handle, child}}, resume: true})`;
  3. journal `{kind: "posted"}`;
  4. state `released`.
- Text: `<router-verdict handle="vrf_…" sessionID="<child>" verdict="PASS|FAIL|UNVERIFIABLE">\n<foreground-equivalent text>\n</router-verdict>`. The matcher never touches a part that starts with `<router-verdict `.
- An idle parent wakes once (O6b). A busy parent gets `delivery: "steer"`, which the smoke asserts (D3).

## 6. `decideBackground` (D1)

| # | Condition (first match wins) | `background` | `hold` | reason |
|---|---|---|---|---|
| 1 | mode `off` | `verifying \|\| roleRouted ? false : undefined` | false | off |
| 2 | `!parentIsRoot` | as row 1 | false | child-parent |
| 3 | `liveCount ≥ 1000` | as row 1 | false | cap |
| 4 | explicit `true`, required verifying, no holding | false | false | explicit-no-holding |
| 5 | explicit `true` | true | `verificationMode==="required"` | explicit |
| 6 | explicit `false` | false | false | explicit |
| 7 | mode `model` (unset) | as row 1 | false | model-unset |
| 8 | auto: estimate `source !== "prior"`, `n ≥ minSamples`, `p50 ≥ minPredictedMs` (≥ counts) | true¹ | required | estimate |
| 9 | auto: acceptance `testsPass \|\| buildPasses` | true¹ | required | acceptance |
| 10 | auto: `planTask` | true¹ | required | plan-task |
| 11 | auto, not selected, prior estimate | `verifying ? false : undefined` | false | prior |
| 12 | auto, not selected | `verifying ? false : undefined` | false | short |

¹ If the call is selected but required verification has no holding available, the result is `false` with reason `no-holding`. In auto, a role dispatch with a thin store gets **no key** (role-spikes update ≈706-725).

## 7. Holding: no held output reaches the orchestrator before its verdict

### 7.1 Placeholder (pure, never changes)

`<subagent sessionID="<child>" state="held">held — verdict pending (<vrf_handle>)</subagent>`

### 7.2 Matcher (`applyText`)

- For each held child of the session, find `<subagent sessionID="<child>"` in a text part.
- Part **starts** with it (C2 whole message) → the whole part becomes the placeholder.
- Embedded (O13 compaction record):
  - replace through the matching `</subagent>` only when the known body (persisted digest or child-context text) follows verbatim;
  - otherwise replace **through the end of the part**. Over-redaction is deterministic, so it stays cache-stable.
- `apply` copies messages and parts, never mutates host objects, and returns `undefined` when nothing matched.

### 7.3 Leak paths and how each is closed

| Path | How it is closed |
|---|---|
| Host completion text | Context hook, every request, step 1. |
| Advise route hint derived from messages | The matcher runs before `augment` (`:1465`). |
| Compaction (older turns) | Compaction hook, same matcher (C15). |
| Compaction (latest turn) | Retained `recent` text → substring matcher in the context hook (O13, smoke). |
| Resume | `subagent` with the held child's `sessionID` is refused (D3). |
| Code Mode `execute` naming the held child id | Refused (conservative). |
| Restart | Hold record fsync'd at the ack, before `execute.after` returns. Reload awaited before the context hook registers. Reload failure → fail-closed redaction (§12). |
| Turn-state tail | Only router lines, never output. |
| TUI / `session.export` | Show the original to the **human** (O5). This is not the orchestrator; documented. |
| Residual | Files the child wrote are readable once its leases end at execution end (D7). The guarantee covers the result text. |

### 7.4 Refusal text

`[router] Refused: session <child> is held for verification (<handle>). Its result arrives with the verdict; resume it after that.`

## 8. A user-backgrounded verified call

1. The call starts in the foreground: `verifying` is true, so `nativeArgs` sets `background: false`.
2. The user backgrounds it, and `execute.after` sees `status: "running"` with `verifyingCalls.delete(id) === true` (`:1749`).
3. §4.3 step 2: the handle is reserved, the attempt registered with a hold (if available), and the journal fsync'd.
4. At completion (end event or completion element), the processor reads the child text and computes the delta at child end.
5. `finish({heldHandle})` runs **the same required gate as the foreground path**.
6. The verdict posts the foreground-equivalent text through a synthetic with `resume: true`.
7. Without holding (or for a child parent), the completion is visible, the processor still runs the gate, and the verdict shows in the "completed" section plus late notices.
8. Under `off`: today's notice, no processing.

## 9. Race matrix (every row gets a test: `completion-processor.test.ts` = CP, `v2-background.test.ts` = VB, smoke = SM)

Notation: A = ack, E = end event, M = completion seen by the context hook, V = verdict.

| # | Ordering | Expected | Test |
|---|---|---|---|
| R1 | A→E→M | E processes; M's request awaits `settled` ≤ 2000 ms; annotations in that tail | CP, SM |
| R2 | A→M→E | M processes; E only does timing and lease release | CP |
| R3 | E→A→M | E parked in `earlyEnds`; A processes at once | CP |
| R4 | E, no A (host failed the call) | Early end expires (10 min); nothing processed | CP |
| R5 | Foreground: E→X or X→E (X = `execute.after` completed) | Processor never runs; legacy runs once; leases released at E | CP, VB |
| R6 | User backgrounds mid-run | As R1–R3; verified at completion (§8) | VB |
| R7 | M, processing > 2000 ms | `router guarantees pending`; next request shows annotations; no second wait | CP (fake timers) |
| R8 | Parent interrupt with a background child | Child survives (O4a); in-flight list unchanged | VB |
| R8b | Parent interrupt with a foreground child | `interrupted` E; leases released; no legacy finish | VB |
| R9 | Child failed or interrupted (background) | Processed with outcome; no gate; held → UNVERIFIABLE posted | CP |
| R10 | Resume while held | Refused in `execute.before` | VB |
| R11 | Resume after processed | New attempt key; processed again once | CP |
| R12 | Resume while the previous attempt is open | Previous closed `unknown` (held → UNVERIFIABLE) at the new ack; new attempt owns the next E | CP |
| R13 | Compaction, held completion in an older turn | Compaction hook placeholder | VB |
| R14 | Compaction, held completion in the latest turn | Record text redacted by the substring matcher (O13) | VB, SM |
| R15 | V before the parent renders M | Placeholder applied whenever rendered; verdict entry later | CP |
| R16 | V to a busy parent / an idle parent | Steer delivery / one wake | SM |
| R17 | Restart between decided and A | Host call fails; nothing persisted | VB |
| R18 | Restart between A and E | Child lost (C12): recovery line, one wake per parent; held → UNVERIFIABLE "lost in restart" | `pending-persist`, VB |
| R19 | Restart between E/M and processed | Recovery reads `{type: "idle", outcome}` → processes; registration deduped by callID | `pending-persist` |
| R20 | Restart between processed and V (held) | Reloaded entry re-verified (exact, or approximate); placeholder from the first request | `pending-persist` |
| R21 | Restart between posting and posted | Parent context searched for `metadata.router.handle`; posted only if absent | `pending-persist` |
| R22 | Parent `session.deleted` mid-run | Everything for the session dropped; later E does timing and leases only; held run aborted | CP |
| R23 | Two plugin instances | One claims the callID; one processing | CP |
| R24 | Child never ends | 6 h sweep → `closed-unknown`; timing `unknown`; lease swept by `lastSeenAt` | CP |
| R25 | Duplicate E or duplicate M | No-op | CP |

## 10. Idempotency keys

| Effect | Key | Where checked |
|---|---|---|
| Call claim | `bg:<callID>` | process-wide set, bounded 1000 (like `claimCall`) |
| Processing | `${child}\u0000${callID}` | memory LRU 5000 + journal `processed` |
| Pending registration | `dispatchID = callID` | `register` idempotent |
| Verdict post | handle | journal `posting`/`posted` + synthetic metadata |
| Timing | `event.id` | recorder's seen set |
| Lease release | holderID | registry, idempotent |
| Lost-child wake | `lost:<child>` | per boot |

## 11. Persistence: `<resolveOutcomesDir>\pending.jsonl` (v2 only)

### 11.1 Format

Append-only, one JSON object per line, `"v": 1`. Records:

```jsonc
{"v":1,"kind":"inflight","callID","parent","child","agent","description","verifying","hold":"vrf_…"|null,"dod"?:{…},"at"}
{"v":1,"kind":"ref","callID","reference":{"commit","tracked":{…},"untracked":{…},"links":{…}}}   // when capture resolves
{"v":1,"kind":"processed","callID","child","at"}
{"v":1,"kind":"entry","handle","parent","child","callID","dod","changedFiles":[…]|"unavailable","reference":{…}|null,
       "risk","description","root","cwd","state":"unverified|held","createdAt","dispatchedAt"}
{"v":1,"kind":"state","handle","state":"verifying|verified|held","at","verdict"?}
{"v":1,"kind":"posting"|"posted","handle","at"}
{"v":1,"kind":"tomb","handle"|"callID","cause","at"}
{"v":1,"kind":"forget","session","at"}
```

### 11.2 Writes

- `inflight` and hold appends are fsync'd. Other appends are buffered (flushed ≤ 1 s and at dispose).
- One writer per process.
- Compaction at start: when the file is > 1 MiB or more than half its records are dead, write the live set to `.tmp`, fsync, rename.

### 11.3 Reload rules

- Parse per line; skip a torn or invalid line and unknown `v`; fold by key; `forget` removes a session's records.
- Entries older than `pendingTtlMs` (default `wiring.ts:375`) are dropped. Held entries become UNVERIFIABLE instead.
- Hold records are kept until `forget`, with no TTL.
- Reloaded records stay **dormant** until this process sees the parent session: a hook, an event, or `router_verify` from that session id. Records are never replayed for another session.
- On adoption, take an exclusive claim file `pending.claims\<id>` (`wx`, `{pid, at}`; stale when the pid is dead). This stops two host processes from verifying or posting twice.
- On adoption, `inflight` without `processed` goes to recovery (`ctx.session.context(child)`): finished → process; otherwise lost → wake.
- `keepReferences` is called before the GC.
- Applies only when `ctx.routerHost === "v2"`.
- ADR amendment (orchestrator): DoD and description text are now stored on disk.

## 12. Failure handling

- A processor, provider or matcher throw never fails a request: log once and skip, like the tail at `:1505-1507`.
- A journal append failure at the ack makes the hold unsafe. Release the reserved handle, and the attempt continues as a non-held background dispatch; the not-verified ack text says so.
- Reload failure:
  - set `holdingAvailable = false`;
  - until a retry succeeds, the context hook redacts **every** `<subagent>` element whose child is not known as processed (fail closed; one cache break when the retry succeeds).
- `ctx.session.context` failure → wait for the completion trigger.
- Synthetic failure → retry with backoff 3× (`BACKGROUND_RETRY_BASE_MS`), then keep `posting` for the next start.
- Lease `invalid-holder`: writes fail closed; reads and runs are allowed with one warning.

## 13. Turn-state providers (1.2 handoff: synchronous `render`; `plan` and orders 0–9 reserved)

| Name | Order | `render(sid)` |
|---|---|---|
| `completed` | 30 | `[router] Completed since your last turn:` then `- <role> "<desc>" (<child>): <annotations \| router guarantees pending>` |
| `held` | 40 | `[router] Held for verification — not usable until the verdict:` then `- <role> "<desc>" (<child>) <handle>: <verifying \| waiting for lease held by …>` |
| `in-flight` | 50 | `[router] In flight (background): <n>` then `- <role> "<desc>" (<child>) — <floor(min)> min` then `Do not report the task done while dispatches are listed here.` |

- `late` stays at 10, `pending` at 20, `route-hint` at 90.
- All three render nothing under `off`. Appendix B wins if it fixes other orders or headers.
- "Completed" lines are shown on every request of the turn in which they first render, and dropped at that root's execution end.

## 14. Leases (C9/D7; every v2 child; roots take none)

### 14.1 Holder and context

- Holder: `{holderID: child, tree, isChild: true, scope: "until-complete"}`.
  - `tree = repoKeyOf(dir)?.tree ?? foldKeyPath(realpath(dir))`.
  - `dir` = the session directory (`ctx.session.get(...).location?.directory ?? ctx.location.directory`, as at `:1350`).
- Plan children (A3): `taskRef = leaseTaskRef(planId, taskId)`, `scope: "until-integrated"`, tree = slot path, through the `planTaskOf` seam (filled in by 3.1).
- Root sessions:
  - writes call `acquireWrite({…isChild: false})`, which records nothing and is refused only while a child holds the file;
  - reads, searches and runs are never refused.
- A failed session-kind lookup → root semantics. This never blocks the orchestrator and never clobbers a child's file.
- Targets: `toolTargets(tool, args, dir, {gitRoot})`. `gitRootRequired` means an unknown target. Git pathspecs are built only from `relOnDisk`.

### 14.2 Calls per access

| Access | Call | Outcome |
|---|---|---|
| write | `acquireWrite(holder, paths.length ? paths : null)` | `held` / `unknown-target` / `cap` refuse |
| read | `checkRead(actor, p)` per path | `underEdit` refuses |
| search (host `glob`/`grep`) | `filterSearchResults` in `execute.after` | Kept results plus one note |
| run | `checkRun(actor, cwd)` | `contaminatedBy` → note; `run-refused` → refuse |

### 14.3 Messages (holder = `<role> "<description>" (session <id>)` from the in-flight registry, else `session <id>`)

- Write `held`: `[router] Refused: <path> is being edited by <holder>. Finish without that file, or return \`NEED MORE: lease <path>\`. Do not retry: the lease ends when that session ends.`
- Read `underEdit`: `[router] Refused: <path> is under edit by <holder>. Finish without it, or return \`NEED MORE: lease <path>\`.`
- `unknown-target`: `[router] Refused: this <tool> call names no file the router can check, and <holder> is editing files in this repository. Pass the file path explicitly, or return \`NEED MORE: lease <tree>\`.`
- `cap`: `[router] Refused: too many files are leased (<limit>). Return \`NEED MORE: lease <path>\`.`
- Root write `held`: `[router] Refused: <path> is being edited by <holder>. Wait for that session to end.`
- Run, annotated: exactly `formatRunNote(labels, n)` → `[router] ran while <holder> edits <n> file(s); result may be contaminated`.
- Run, refused (only under `routing.leases.run: "refuse"`): `[router] Refused: router_run in <tree> while <holder> edits <n> file(s) there. Wait for that session to end, or return \`NEED MORE: lease <tree>\`.`
- Search: `[router] <n> result(s) omitted: under edit by <holders>.`

### 14.4 Release and verification deferral

- Release on execution end, interrupt or failure (event loop), on `session.deleted`, and by the 6 h sweep.
- Snapshot to `leases.json`, debounced 1 s, **only while an `until-integrated` holder exists**. This is inert in 2.1.
- Verification deferral (§2.5):
  - the actor is `{holderID: "verify:<handle>", tree, isChild: true, taskRef?}`, so the producer's own task never defers its own check;
  - waiters wake on `notifyReleased`, with a 5 s poll fallback;
  - at the deadline, the run starts with the existing caveat.

## 15. Plan conflicts and amendments

1. **`src\router\git-tools.ts` must join the 2.1.5 writes list.** The `repoKeyOf` adapter `repositoryIdentity` needs `nearestRepository` exported, and git-search filtering inside `inspectGit` lives there (1.3 handoff). Until then, `router_git_*` searches are not filtered.
2. Plan 2.1.3.c says the processor "records the timing outcome". The 1.1 handoff (binding) says the event loop calls `onExecutionOutcome`; the processor does not.
3. The 1.3 handoff asks for `restore` on restart, while 1.4 A3 says `LeaseService` never calls `restore`. Both hold: 2.1 restores the registry-level snapshot (inert until 3.1), and the 3.1 `LeaseService` rebuilds its plan leases.
4. FAIL verdict content: the memo posts the foreground-equivalent text (output + findings). The plan says "findings (FAIL)". Orchestrator to confirm.
5. Depth banner: it stays on the ack, because it is a dispatch-time fact. D2 lists it among the completion annotations; this memo reads the ack as the call's result.
6. Background is enabled for root parents only (D4: the tail is root-only).
7. New and not in the plan: in-flight persistence and the lost-child wake (R18), and `reserveHandle` at the ack.

## 16. `off` byte-identity and v1 inertness

### 16.1 `routing.background.mode: "off"` keeps byte-identical

- `subagent` input: `nativeArgs` behaves as at `:87`.
- The running-ack text (`:1782-1797`).
- Foreground results.
- The system prompt: no background lines.
- `event.messages`: no matcher, no defang.
- No in-flight registration, processing, holds, or rendering by the three providers.

`off` does **not** turn off three things:

- Timing rows: telemetry, not visible to the user (1.1 handoff).
- Leases: controlled by `routing.leases.mode`. With `leases.mode: "off"` too, nothing in the request differs from the pre-phase state.
- v2 pending persistence: the only visible effect is that handles survive a restart (P5).

### 16.2 v1 inertness

1. All hooks are registered in `registerV2Hooks` (loaded by `server.ts` only).
2. `background.ts` and the attach symbol have no load-time effects and are not exported from `main`.
3. The `finishDispatch` extraction is a pure refactor of the legacy after-hook. The goldens, `smoke:v1` and the v1 characterisation golden prove it.
4. Pending `persist`/`hold` are only passed when `ctx.routerHost === "v2"`; the `held` state is only entered through the adapter.
5. `keepReferences` is called only by the v2 reload; the GC with an empty keep set is unchanged.
6. `leaseGate` is absent on v1; `preemptBackgroundVerification` reuses the same abort.
7. `protocol.ts` `host` defaults to `"v1"`.
8. Configured keys log one notice per key per process.

### 16.3 Check before coding (not read; read cap)

- Legacy after-hook and deferred registration lines in `index.ts` (plan ≈2297-2440 / ≈2436 on main).
- `src\routing\wire\dispatch.ts` ≈1048.
- `src\verify\dispatch.ts` delta capture (plan ≈219-238, ≈374-445).
- The compaction-hook event shape (`test\smoke\probe\cpx-probe-plugin.js`).
- `glob`/`grep` result shapes for the filter rewrite.
- Whether `DurationModel.estimate` is synchronous.
- Appendix B layout.
- Whether `runClaimGate` runs every DoD check, including criteria, for reloaded held entries.

## 17. Test matrix (2.1.8)

- **`background-policy.test.ts`**
  - Every combination of mode × explicit (true/false/unset) × source (prior / exact with n ≥ 5) × estimate (below/at/above 45000) × `testsPass` × plan task × holding, plus `verifying`, `roleRouted`, `parentIsRoot` and the cap.
  - `off` deep-equals and JSON-byte-equals the old `nativeArgs`, including key order.
- **`completion-processor.test.ts`**
  - R1–R16, R22–R25.
  - Exactly one `finish` call per attempt.
  - The 2000 ms bound with fake timers.
  - Placeholder identical across 3 requests; PASS posts once and wakes once; FAIL posts the foreground-equivalent text.
  - Memory caps: live 1000, early ends 200, completed buffers 32 per parent / 1000 parents, holds 256 / 10 000.
- **`pending-persist.test.ts`**
  - R17–R21.
  - Restart with 3 open handles → reloaded and verified through `router_verify`.
  - Expired entry dropped; missing commit → `unverifiable`; GC spares kept references; torn last line.
  - Dormant until the session is seen; another session never adopts; claim-file exclusion; approximate reference.
- **`v2-background.test.ts`**
  - Static engine writes a timing row; after 5 rows with p50 ≥ 45 s the next dispatch goes to the background.
  - A user-backgrounded verified call is verified at completion.
  - Leak tests: route hint, compaction older and latest turn, resume, Code Mode, restart.
  - An auto-backgrounded role child binds after the ack (the `evictCall` fix).
  - `off` identical for args, results, system and messages.
  - v1 inert, with one notice per configured key.
- **`v2-leases.test.ts`**
  - Two writers of one file → the second is refused with the holder named.
  - A reader in the same tree is refused; `router_run` is annotated, or refused under `refuse`.
  - In another worktree, both are allowed.
  - Root edits take no lease and never block a child.
  - A grep result is filtered with a count; `router_git_*` without `gitRoot` is an unknown target.
  - Release on end, interrupt and failure; a verification run is deferred, then runs with the caveat.
  - Authority refusal comes before the lease check.
- **`cpx-background.smoke.test.ts`**
  - A background implementer dispatch returns at once, and the next scripted step runs before the child ends.
  - The annotation appears in the next tail.
  - Held completion in the latest turn at compaction (O13).
  - The verdict reaches a busy parent and an idle one.
- **Updates**
  - `v2-hooks.test.ts`.
  - `role-spikes.smoke.test.ts` ≈211-218 (`off` reproduces the old rewrite) and ≈706-725 (`auto` with a thin store adds no background key).

## Findings

### Round 1 (heavy reviewer `ses_ed4d06f56ffeWxa2gPb7xz56cy`, at `bc0a9b4`) — 13 findings (2 critical, 7 major, 4 minor); fixes pending

- QA-2.1-1 (critical): held verdict posted as PASS when the gate gave none (`index.ts:3583`; `finishDispatch` `{kind:"none"}` on read-only skip `:3318-3330` and on any exception `catch {}` `:3430-3432`). Fix: none/deferred/skipped/error → UNVERIFIABLE with reason; add `skipped`/`error` to FinishOutcome; end-to-end tests; remove the empty catch.
- QA-2.1-2 (critical): verdict delivery has no recovery (`background.ts:696-723`, `:785-796`; R21 `posting` never read; restored verified entry dropped `pending.ts:1616` while the hold stays `:978-981`; duplicate posts if `posted` append throws; verdict before hold insertion dropped `:728-735`). Fix: persist verdict text with `posting`; re-post posting-without-posted at adoption after checking parent context `metadata.router.handle`; post even if the journal write fails; never retry synthetic for a journal failure; insert the hold before the fsync or queue verdicts.
- QA-2.1-3 (major): ack failure leaves "held" text without a hold (`v2-hooks.ts:2355-2377`). Fix: set ack text after both writes; on failure drop `attempt.hold`, `pending.releaseHandle`, "will arrive unverified" text.
- QA-2.1-4 (major): reserved handles leak (`releaseHandle` `pending.ts:1714` never called; failed/interrupted `background.ts:1029`, closed-unknown `:1183-1195`). Fix: release on every held attempt ending without a held register; TTL on reservations.
- QA-2.1-5 (major): failed/interrupted children still run the gate (`index.ts:3604`). Fix: status ≠ succeeded → no `finishDispatch`.
- QA-2.1-6 (major): restart recovery incomplete (R18–R20): `recoverInflight` `v2-hooks.ts:2285-2294` assumes succeeded; lost non-held child never wakes the parent; restored held entries never re-verified; `heldTexts` in memory only. Fix: read the child's end state; one `resume:true` wake per lost child; adopt from the event loop too; re-run the gate at adoption; persist child text with the hold.
- QA-2.1-7 (major): `captureDelta(a.callID)` keyed wrongly (`index.ts:3509` vs `task:<parent>:<callID>` `:2323`; `dispatch.ts:493`) and narrower than the observed change set it overwrites (`wiring.ts:1716-1720`). Fix: pass the dispatch id and compute the full delta, or do not override the observed set.
- QA-2.1-8 (major): pending journal fragile; answers the D3 question: nothing in `src` deletes `outcomes`; the default outcomes dir is in `os.tmpdir()` (`routing/outcomes/persist.ts:130`) and test `dispose` removes the home while work is in flight (`test/helpers/v2-bg-host.ts:274-278`); missing file loads as `[]` (`pending.ts:904`); never compacted; reload read twice; `reloadFailed` permanent; compaction hook not fail-closed (`v2-hooks.ts:1216-1225` vs `:1772`); held resumes not refused while reload failed (`:1324`). Fix: durable per-user journal dir; vanished journal = reload failure; compact at start; retry reload; fail closed in compaction; `dispose` waits for in-flight work; remove the mkdirSync workaround.
- QA-2.1-9 (major): `router_verify` can claim a held entry (`pending.ts:1528-1548`, `wiring.ts:2116`). Fix: refuse held entries or join the background run.
- QA-2.1-10 (minor): posted holds lose their placeholder after restart (`pending.ts:978-981`). Restore as inactive placeholders.
- QA-2.1-11 (minor): lease guard: uncached `ctx.session.get` per call (`v2-hooks.ts:986-990`, `background.ts:1401`); child misclassified as root gets root wording; producer's own leases delay its own check (`wiring.ts:1476-1486`). Fix: cache dir + negative cache; child wording when kind unknown; exclude the producer's holder in `waitTreeFree`.
- QA-2.1-12 (minor): `off` still adds the lease line (`protocol.ts`), child-parent user-backgrounded notice, undocumented `[router`→`(router` defang, v1 logs up to 4 notices (AGENTS.md: at most one). Fix docs or code; fold v1 notices into one.
- QA-2.1-13 (minor): bookkeeping leaks (`heldTexts`, `adoptedSessions`, `warned`, claim files/PID reuse, decided-but-unacked records counted live, `PROCESS_CLAIMS` across reloads).

## Fixes
## Deferred findings

## Handoffs

## Verdict
