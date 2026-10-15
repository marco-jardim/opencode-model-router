# Phase 4.2 — Unattended operation, QA loop and restart recovery

Plan: `D:\git\omr-cpx-main\docs\plans\critical-path-execution-plan.md` (Phase 4.2). Worktree `D:\git\omr-cpx-p42`, branch
`cpx/p42`, base `cpx/p42-base` = `5653701`.

## Pre-flight

- §0.9 checklist: worktree clean at `5653701`, `npm ci` done, typecheck green on `cpx/main` (Wave 3 merged: 3.1 `4623f8d`,
  3.2 `a29d473`, post-merge fix `63ecca4`).
- Recon (explorer `ses_ecccabd8bffet9xY1F1RBGzA4z`): ADR 0007 C7/C12/C13/C14, D2/D8/D15/D16/D18; phase-1.4 A1 QA8/QA9,
  A1-3, A1-7/A1-8, A2, A3; the `UnattendedPolicy`/`QaLoop`/`RecoveryService` interfaces (`src\executor\types.ts`
  :1746-1793); runtime call sites; queue `resume()`; ledger lock rules; compat completion path. Findings: the three
  4.2 modules do not exist; `ExecutorRuntime` never calls `queue.resume()`; executor children are not journaled by the
  compat layer, so nothing re-feeds them after a restart.
- Open checks V1-V8 answered by explorer `ses_eccbc6084ffe07nts2rDft3vMF` (see memo §11).

## Implementation notes

Design memo 4.2.1 (architect `ses_eccc700eeffe8LmzTqTOW9jS0T`, [tier:heavy]; first pass plus an amendment after V1-V8),
binding for 4.2.2-4.2.6. Code anchors are at `5653701`.

### 0. Conflicts between the plan text and the binding addenda (the addendum wins)

| # | Plan text | Binding text | Decision |
|---|---|---|---|
| X1 | 4.2.4.a: open every running ledger | `types.ts:1756`: running or paused; `start()` ranks running first | recover running and paused ledgers |
| X2 | 4.2.4.a / ADR D16: a lost child gets a new attempt of outcome lost | R2 (phase-1.4 `:46`): close the in-flight attempt `lost`, open none; `attempt-adopted` needs the latest attempt closed `lost` (`:895`) | close attempt n as `lost`; the next launch opens n+1 (row 4); lost is uncounted |
| X3 | 4.2.4.a: `integrating` -> `IntegrationQueue.resume()` | A1-3 (`:974`): `resume()` once per plan before the first dequeue | `resume-integration` is reported only; the runtime calls `resume()` once per activation (§9) |
| X4 | 4.2.3.a: unparsable QA output retried once, then an inbox item | QA6 (`:798`): first unparsable output is a counted failure, retried only if attempts are left (else parked exhausted); a later one parks `qa-unparsable` (the runtime already does this, `runtime.ts:1599-1607`) | QA6 |
| X5 | 4.2.3.d: at the cap the gate passes; 4.2.2.c: the breaker is the only unattended stop | QA8/QA9 (`:800-801`): at the cap the gate goes `qa-running→awaiting-qa`, phase paused with a critical `qa-cap` item; passes only on `accept`; other bound pauses: lost streak (`runtime.ts:1518`), `resume()` step 0 (A2-5) | the breaker is the only failure-rate stop; the QA cap is a second phase stop; EXECUTOR.md lists every stop |
| X6 | 4.2.2.b: its dependents become blocked | A1-9 (`:1089`): only pending transitive dependents | pending dependents only |
| X7 | 4.2.3.c: fix tasks for every finding in rounds 1-2 | QA9: a cap `fix` answer creates fix tasks for blocking/critical/major only | when `qaMaxRounds ≤ 2`, a cap-fix at round 1-2 fixes blocking/critical/major only |
| X8 | — | round r = `qaMaxRounds ≤ 2` with only minor/nit findings is not covered | `qa-clean`: gate passes, minor/nit recorded deferred |
| X9 | write paths `D:\git\omr-cpx-main\src\…` | route line `root=D:\git\omr-cpx-p42` | write in p42 |
| X10 | `ESCALATE: human` | `classifyChildText` matches any first-line `^ESCALATE:` (`runtime.ts:249`) | keep it: an executor child has no other escalation target |

### 1. Inbox (U1-U6)

- **U1 Kinds and severities:** escalate, ambiguity → `question`/blocking; qa-unparsable, exhausted, lost-streak, lease
  rebuild failure → `failure`/blocking; breaker → `breaker`/critical; QA cap → `qa-cap`/critical; deferred finding →
  `qa-cap`/info, closed at creation. info = never waited on; blocking = a task waits; critical = a phase or the plan is
  paused.
- **U2 `raise`:** one builder batch; an open item with the same kind+taskId+text is returned and nothing is written;
  otherwise `inbox-added` with `formatInboxId(kind, nextInboxNumber(ledger))` allocated inside the builder; after the
  fsync wake `("inbox", "inbox:<id>")` except for items closed at creation; the waker dedupes through the history
  `wakeKeys` (A2-7), so a restart never wakes twice for one item.
- **U3 Text bound:** first `INBOX_TEXT_MAX = 4000` characters then `…`; dedupe compares the bounded text.
- **U4 `answer(inboxId, text)`:** the item must exist and be open, else `E_INVALID_INPUT`.
  - critical `qa-cap`: choice = `text.trim().toLowerCase()` must be in `item.options` (else `E_INVALID_INPUT`, nothing
    written); call `qa.onCapAnswer(id, choice)`; return `{resumed: null}`.
  - task `parked`: row 37 in one batch: `inbox-answered`, `attempt-context(answer)` on the latest attempt (replaces its
    context, R13), `parked→ready` (`answered`); return `{resumed: taskId}`.
  - breaker item: `inbox-answered`, then `phase-paused(false)` if the phase is paused and no other critical item is open
    on it; any answer text resumes; options `[]`.
  - anything else: `inbox-answered` only.
  - an exhausted task gets no fresh attempt count: each answer buys exactly one more attempt.
- **U5 Detection, first line only** (`runtime.ts:245-251`): `ESCALATE:` → escalate; `NEED MORE: lease <path>` → lease
  request (row 18b, never parks); `NEED MORE:`, `NEED CONTEXT:`, `SCOPE GROWTH:` → ambiguity. A QA task's findings are
  parsed first: output that parses is a result even if its first line is a status word. The item text is the whole
  child text, bounded; the answer reaches the relaunch through `attempt-context`.
- **U6 Counting:** escalate and ambiguity close the attempt `interrupted` (row 17): uncounted, not fed to the breaker. A
  second unparsable QA output closes it `failed` (counted); `park` feeds it to `recordAttempt` itself.

### 2. Parking and blocking propagation (P1-P5)

- **P1** From `running`: escalate, ambiguity, qa-unparsable → row 17. From `conflict`/`failed`/`reverted`: exhausted → row
  36. Any other state: write nothing, return the task's open item.
- **P2 Batch order** (rows `:927`, `:948`): row 17 = attempt-ended, attempt-context, `running→parked`, slot cleared, gate
  requeue (QA tasks), inbox-added, then `pending→blocked` per dependent; row 36 = `→parked`, slot cleared if set,
  inbox-added, dependents. Dependents = transitive closure over dependency edges, pending only; direct ones get
  `dep-parked`, deeper `dep-blocked`; breadth-first, sorted by id per level.
- **P3** After the fsync, only if the batch cleared the slot: `LeaseService.releaseTask(taskId)` (idempotent); the runtime
  returns the slot to the pool and releases the token. A relaunch re-acquires through row 4.
- **P4** Parking pauses neither the phase nor the plan.
- **P5 `unblock()`:** one batch, `blocked→ready` (`dep-recovered`) for every blocked task whose dependencies are all
  `integrated` or `done`. Called from `runtime.ts:871` and at the end of recovery. Answering a parked task does not
  unblock its dependents; they wait until it integrates.

### 3. Circuit breaker (B1-B6)

- **B1 Samples** (amended after V8; `types.ts:547-561`): attempts of the phase's tasks with `endedAt` later than the
  `createdAt` of the phase's newest breaker item (all if none), where `countsTowardMaxAttempts(a)` (outcome `succeeded`
  or `failed`). **Failure** = `isBreakerFailure(a)`: outcome `failed`, or verdict `fail`/`unverifiable` (a succeeded
  attempt that failed verification is a counted failure). **Success** = outcome `succeeded` with verdict `pass`; or
  `succeeded` with no verdict when it is the latest attempt and the task is `done`/`verified`/`integrating`/`integrated`.
  **Excluded:** verification still pending; row 23 "no changes" (succeeded, no verdict, task `failed`); flaky = a `flaky`
  item for the task created between `a.startedAt` and the next attempt's start. Ordered by `endedAt`, then (taskId, n).
  Pure function of the ledger: a restart rebuilds it exactly.
- **B2 Math:** N samples, F failures, C trailing run of failures (a success resets to 0). Trip when
  `(N ≥ minAttempts && F ≥ failureRatio·N − 1e-9) || C ≥ consecutiveFailures`. Defaults 0.4/5/3: 2/5 trips, 1/4 no,
  5/13 no, 3 in a row trips at N = 3; the epsilon makes 6/15 trip (`0.4*15 = 6.000000000000001`).
- **B3 `recordAttempt(phaseId, a)`:** find the task by the attempt's nonce; evaluate only when that attempt is a
  failure. If it trips, the phase is not paused and no breaker item is open for it: one batch `phase-paused(true,
  "breaker")` + `{kind:"breaker", severity:"critical", taskId, text:"phase X circuit breaker: F/N failed …, C
  consecutive", options:[]}` + one wake. Returns `{tripped: true}` only when this call wrote the trip.
- **B4** A paused phase launches and dequeues nothing new; in-flight children finish and are processed but cannot trip it
  again.
- **B5 Feeds** (amended): evaluated only when a failure settles. 4.2.5 makes sure `recordAttempt` runs after every batch
  that settles a breaker failure: rows 4b and 12 (launch-task-error), row 16 (`runtime.ts:1541`), row 17 qa-unparsable
  (policy, U6), row 26 (verdict fail/unverifiable). No success feeds. Integration-stage failures (rows 31, 32, 34) are
  the queue's. Recovery evaluates each phase once at activation (§8 step 8).
- **B6** After a breaker answer the window restarts at the trip time.

### 4. QA loop (Q1-Q9)

- **Q1 `parse(text)`** (pure): last ```` ```json ```` fenced block, else the whole text (`types.ts:1150-1151`);
  `JSON.parse` then `isFindingsReport` (`:1185`); `{ok:false, error}` bounded to 500 characters.
- **Q2** Unparsable output is the runtime's and `park`'s (X4); `QaLoop` writes nothing for it.
- **Q3 Scope:** round r ≤ 2 fixes all findings; from round 3 only blocking/critical/major; minor/nit from round 3 on are
  deferred: one `qa-cap` info item each, closed at creation, `answer:"deferred"`, text `deferred <sev> <id>: <problem>
  [files]`.
- **Q4 Decision table** (r = `phase.qaRound`, max = `qaMaxRounds`):

  | Findings | r ≤ 2, r < max | r ≥ 3, r < max | r ≥ max |
  |---|---|---|---|
  | none | passed (`qa-clean`) | passed | passed |
  | only minor/nit | next-round (fix all) | passed + deferred | passed + deferred (X8) |
  | any blocking/critical/major | next-round (fix all) | next-round (fix b/c/m, defer minor/nit) | cap-reached (QA8) |

  Batch orders (`:820`): `qa-clean` = deferred items, then the gate; `qa-next-round` = gate (qaRound+1), `task-created`
  fix tasks then the re-review task, `edge-added`, deferred items; `qa-cap` = gate, `phase-paused(true)`, the critical
  item, then one wake.
- **Q5 Grouping by file:** normalise paths (`\`→`/`, strip leading `./`; absolute or `..` → file-less); union-find over
  shared files; each component = one fix task with writes = union of its files (disjoint by construction); components
  sorted by smallest path, numbered k = 1..; file-less findings = one extra fix task with `writes: []`, depending on the
  round's other fix tasks (leases on demand via `NEED MORE: lease`); more than 999 components → overflow merged into the
  last.
- **Q6 Fix tasks:** id `fixTaskId(phaseId, r, k)` (`${phaseId}.FIX${r}-${k}`), `kind:"fix"`, `phase: phaseId`; route line
  and acceptance copied from the phase's `X.Y.FIX` template when present, else `class=implement d=deterministic
  tier=medium pin` with the phase's `root` and no acceptance; body = the group's findings in canonical JSON.
- **Q7 Re-review:** id `reviewTaskId(phaseId, r+1)`, `kind:"qa"`, route line copied from the round-r QA task
  (`class=review d=none tier=heavy pin`); depends on every fix task of the round; body includes the previous round's
  findings; the gate is then `pending` and the existing machinery drives integrate → suite → awaiting-qa → dispatched.
- **Q8 Idempotency:** write only if the gate is `qa-running`, `qaRound === r` and `taskId` is round r's QA task; else
  return the outcome from the ledger (gate `passed` → "passed"; `qaRound > r` → "next-round"; an open critical `qa-cap`
  item naming the task → "cap-reached"). Deterministic ids + `task-created` requires absence.
- **Q9 Cap:** answers follow QA9 exactly; findings re-read with `parse(<round-r qa>.attempts.at(-1).context)`; options
  `["accept","fix"]` while r < `QA_ROUND_LIMIT` (`types.ts:1192`). Without a human the loop ends within `qaMaxRounds`.
  `onAwaitingQa` passes the gate (`no-open-qa`) only when no QA task of the phase is outside done/cancelled and no open
  critical `qa-cap` item names one of them. Cap-fix writes no deferred items.

### 5. Reconciliation (amended after V1)

**R1 Evidence** for attempt n with nonce ν, using only `HostSessions.get`, `context`, `activity`, `interrupt`
(`types.ts:1880, 1896-1906`), rules in order:
1. **tracked:** ν is in `launcher.inFlight()` of this process → never reconciled; report `alive`, action `none`.
2. No recorded child id → `none` (a `dispatched` attempt never has one: child id and `dispatched→running` share row 10).
3. `get(c) === null` → `lost`.
4. Header check: the first user message of `context(c)` parsed strictly as a launch header must name (planId, taskId,
   n, ν), else `mismatch` (`parentID` not checked).
5. Last message `idle` → `finished`; mapped to a `ChildEnd` with the runtime's L12 mapper; result = last assistant message.
6. Otherwise `activity(c)`: `active` → `alive`; `inactive` → `lost` (C12); `unknown` → `unknown` (always on v2 today,
   the adapter's `activity` is a stub, `v2-hooks.ts:3627-3655`). Reported as `alive` + `probation`; `mismatch` as `lost`
   + `mismatch`.

**R1a Probation** (unknown child): adopt, register its session, force the capacity token, start a liveness watch. Proof
of life = any host event for c, or a change in `context(c)` (message count or last message) seen by a poll every
`RECOVERY_POLL_MS` = 10 s (a slow poll stays as a backstop). Last message becomes `idle` → process the result. No sign
of life before `RECOVERY_LIVENESS_MS` = 60 s: `interrupt(c)` (not-found / not-busy = success; other errors retried each
poll, after 5 failures one blocking failure item and the task keeps waiting), reset the slot's contents (R4), feed
`onChildEnd(lost, "restart")` → row 18, uncounted. Never relaunched while its child is unconfirmed.

**Matrix — states that can have a child** (a tracked attempt is always `none`; `ready` rows = latest attempt closed
`lost`, slot set, child recorded):

| Ledger state | finished | alive | unknown | lost | none | mismatch |
|---|---|---|---|---|---|---|
| `ready` (latest `lost`, slot, child) | adopt + process: row 7 (attempt-adopted, `ready→running`, gate if QA; force token), then the end → row 15/16/17/18b; count per resulting row | adopt: row 7, register; no count | adopt on probation: row 7 + watch | none (scheduler relaunches) | none | interrupt c if its header names this plan; then none |
| `ready`, other | none (result ignored) | interrupt c (orphan) | interrupt c (orphan) | none | none | as above |
| `dispatched` | — | — | — | — | requeue-lost: reset slot contents, row 11 (attempt-ended `lost "restart"`, `dispatched→ready` `launch-lost`, gate requeue if QA); slot and leases kept; uncounted; a late child carrying ν is adopted (L12) or interrupted if already relaunched | — |
| `running` | process-result: the end → row 15/16/17/18b | adopt: no batch; register, force token | adopt on probation, no batch | requeue-lost: reset, row 18 (`lost "restart"`); uncounted | treated as lost | interrupt c if its header names this plan, then requeue-lost (row 18) |

**Orphans** (interrupted, no journal entry): the recorded child of any closed, non-adopted attempt with outcome
`lost`/`capacity`/`interrupted`, whose context does not end `idle` and whose header names this plan. Other plans'
sessions are never interrupted.

**States without an expected child:** `completed` → reverify (commit-and-verify with D11); `verifying` → reverify (rerun
the verifier; the verdict event is written once); `verified` → re-enqueue after `resume()`; `integrating` → report only
(A1-3); `failed`/`conflict`/`reverted` → the retry or exhausted decision (A1-2 `:953`); `pending`, `blocked`, `parked`,
`done`, `cancelled`, `integrated` → none. Per-phase gate recovery: `qa-running` with no QA task in flight →
`onQaResult(latest done QA task, parse(ctx).report)`; `awaiting-qa` → `onAwaitingQa`; `pending` or `suite-running`
with no open entry → `checkPhase` (covered by `resume()`).

- **R2 Slot markers:** missing or foreign marker with an open attempt → requeue-lost, then a separate batch clearing the
  slot of the now `ready` task (legal, V6), then release slot and leases; in `completed`/`verifying`/`verified` →
  re-provision the slot from the task branch.
- **R3** folded into R1a.
- **R4 Slot reset** (`reset --hard HEAD` + `clean -fd`, keeping ignored files) before the requeue batch; idempotent.
- **R5** Recovery feeds the runtime's existing handlers (late child creation, `onChildEnd`, retry decision,
  commit-and-verify); it never writes task rows itself.

### 6. Locks and adopt (amended after V3)

- **L1** Evidence gathering is read-only; writes, slot resets and interrupts only while holding the plan's lock.
- **L2 Start:** `open` is exclusive and never takes over. For each running/paused plan `recover()` reported eligible
  (same toplevel): `open`; on `E_LOCK_HELD`, `takeover(planId, holder(orchestratorSessionID), RECOVER_TAKEOVER_REASON =
  "recover")`. The store accepts only stale holders (same host dead pid, or heartbeat older than 60 s); a live holder
  → skipped and logged, nothing interrupted. Plans from another toplevel: `open` as in 3.1, no takeover. A live pid with
  a stale heartbeat is taken over; fencing (`E_LOCK_LOST` on the old writer's next append) covers it.
- **L3 `recovery.adopt(planId, sessionID)`:** read the ledger (toplevel must match, status not terminal, else
  `E_PLAN_STATE`); `open`, on `E_LOCK_HELD` `takeover(…, "adopt")` (stale holder, or this process's own pid+host); a live
  holder elsewhere → `E_LOCK_HELD`; append `orchestrator-bound(adopt)`; close the writer; the runtime reopens (existing
  fallback `runtime.ts:2539-2544`) and activates the plan.
- **L4** After an adopt the launch gate holds new launches until the new session's first router call; recovery feeds
  are not launches.
- **L5** Toplevel equality: real path, `/` separators, case-folded on win32.
- **L6** `recover()` is latched: once per process.

### 7. Duplicate-prevention invariants (D1-D12)

- **D1** One driver per plan: exclusive `open`; takeover only for stale holders or a same-process adopt; the old writer
  then fails with `E_LOCK_LOST`; every external step follows its fsynced batch.
- **D2** Every write is a builder batch that re-checks the task's state and attempt n.
- **D3** Ends are processed only for open attempts (`runtime.ts:1450`).
- **D4** Only the scheduler launches, from `ready` with a new nonce; recovery never opens an attempt.
- **D5** A child is adopted only through row 7, row 10, or a `running` task with no batch, and only on an exact header
  match. No children scan.
- **D6** A task with a recorded child is relaunched only after the child is finished, inactive, gone, or interrupted after
  probation; a `dispatched` task is requeued at once (C12); a late child is adopted (L12) or interrupted.
- **D7** `resume()` once per activation before any dequeue; it completes or rolls back each open entry idempotently; the
  queue dedupes `enqueue`.
- **D8** Inbox dedupe; ids allocated in builders; wake keys from history.
- **D9** Deterministic QA task ids; `task-created` requires absence; `onQaResult` checks the gate.
- **D10** The breaker is derived from the ledger; `phase-paused` requires a change, so it never trips twice.
- **D11 Commit idempotency** (fixes V4): every task commit carries the trailer `Omr-Attempt:
  <planId>/<taskId>/<n>/<nonce>`; on a clean tree, if the slot's HEAD carries this attempt's trailer, that commit is used.
- **D12** Launches the launcher tracks in this process are never reconciled.

### 8. File-by-file API

**`src/executor/unattended.ts` (4.2.2)**
```ts
export interface UnattendedDeps { writer: LedgerWriter; leases: LeaseService; waker: Waker; qa: QaLoop; clock: Clock; log: Log }
export function createUnattendedPolicy(d: UnattendedDeps): UnattendedPolicy;
export const INBOX_TEXT_MAX = 4000;
export function boundInboxText(s: string): string;
export function parkItemKind(cause: ParkCause): { kind: InboxKind; severity: "blocking" };
export function pendingDependentsClosure(l: Readonly<LedgerV1>, taskId: TaskId): Array<{ id: TaskId; trigger: "dep-parked" | "dep-blocked" }>;
export function breakerSamples(l: Readonly<LedgerV1>, phaseId: PhaseId): Array<{ taskId: TaskId; n: number; endedAt: IsoTime; failure: boolean }>;
export function breakerTrips(s: ReturnType<typeof breakerSamples>, c: ExecutorConfig["circuitBreaker"]):
  { tripped: boolean; reason: "ratio" | "consecutive" | null; failures: number; attempts: number; consecutive: number };
```

**`src/executor/qa-loop.ts` (4.2.3)** — builds its inbox events with `formatInboxId`/`nextInboxNumber`; does not import
`unattended.ts`.
```ts
export interface QaLoopDeps { writer: LedgerWriter; waker: Waker; clock: Clock; log: Log }
export function createQaLoop(d: QaLoopDeps): QaLoop;
export function extractFindingsText(text: string): string;
export function normalizeFindingPath(p: string): string | null;
export function groupFindings(f: readonly Finding[]): Array<{ writes: string[]; findings: Finding[] }>;
export type QaDecision = { kind: "clean"; deferred: Finding[] } | { kind: "next-round"; groups: ReturnType<typeof groupFindings>; deferred: Finding[] } | { kind: "cap"; remaining: Finding[] };
export function decideRound(r: FindingsReport, round: number, qaMaxRounds: number): QaDecision;
```

**`src/executor/recovery.ts` (4.2.4)**
```ts
export const RECOVERY_LIVENESS_MS = 60_000;
export const RECOVERY_POLL_MS = 10_000;
export const RECOVER_TAKEOVER_REASON = "recover";
export type RecoveryHost = Pick<HostSessions, "get" | "context" | "activity" | "interrupt">;
export type ChildEvidence = "finished" | "alive" | "unknown" | "lost" | "mismatch";
export interface ReconcileFeed extends ReconcileAction {
  n: number | null; childSessionID: string | null;
  context: HostSessionContext | null;
  probation: { deadlineAt: number; pollMs: number } | null;
  mismatch: boolean; orphans: string[]; slotValid: boolean | null;
}
export interface RecoveryEngine extends RecoveryService {
  /** Classification only; no writes, interrupts or resets. Called with the plan's lock held. */
  reconcile(l: Readonly<LedgerV1>, tracked: ReadonlySet<string /* nonce */>): Promise<ReconcileFeed[]>;
}
export interface RecoveryDeps { store: LedgerStore; host: RecoveryHost; toplevel: string; holder(sessionID: string): LockHolder;
  slotMarker(slotPath: string): Promise<{ planId: PlanId; taskId: TaskId } | null>; clock: Clock; log: Log;
  livenessMs?: number; pollMs?: number }
export function createRecoveryService(d: RecoveryDeps): RecoveryEngine;
export function classifyChild(info: { id: string; parentID: string | null } | null, ctx: HostSessionContext | null,
  activity: "active" | "inactive" | "unknown", expect: { planId: PlanId; taskId: TaskId; n: number; nonce: string }): ChildEvidence;
export function sameToplevel(a: string, b: string): boolean;
```
`recover()` = eligibility check + read-only `reconcile` of each eligible plan, returns the report. `adopt()` follows L3.

**`src/executor/runtime.ts` (4.2.5, the only required write)**
- `RuntimeDeps.recovery` becomes `(RecoveryService & Partial<Pick<RecoveryEngine, "reconcile">>) | null`.
- Export `realCollaborators({ queue, clock, log })`: builds `createQaLoop` first, then `createUnattendedPolicy({…, qa})`,
  then the queue (no production assembly exists before 5.1, V7).
- `start()`: subscribe host events → `recover()` → for each entry `open`, or `takeover("recover")` for eligible plans only
  (L2) → `attach`.
- `recoverPlan(p)` on every activation of an existing ledger (start, adopt, promotion of a passive plan); `p.recovering`
  makes `schedule` a no-op until it finishes: (1) slot markers + `leases.rebuild` (one item per failure); (2) `feeds =
  reconcile(ledger, tracked nonces)`; (3) interrupt orphans (best effort); (4) `resumeIntegration(p)` (§9); (5) apply
  feeds in task-id order per the matrix, each requeue-lost after its slot reset, start R1a watches; (6) retry decisions
  for failed/conflict/reverted; (7) gate recovery; (8) breaker evaluation per phase with a failure in its window; (9)
  `enqueue(verified)`; (10) `policy.unblock()`; (11) clear `p.recovering`, `schedule`.
- Liveness watch: `p.probation: Map<sessionID, {taskId, n, deadlineAt, lastSig, interruptFails}>`; `onHostEvent` marks a
  session alive; the poll timer runs R1a; `dispose` clears timers.
- D11: `commitTaskInSlot` (`runtime.ts:305-311`) adds the trailer to every commit; on a clean tree read `git log -1
  --format=%B` in the slot: this attempt's trailer → `{changed: true, commit: HEAD}`, else the current `{changed:false}`
  path. A leftover `index.lock` in the slot's gitdir is removed once and the commit retried, only while the plan lock is
  held. Fallback if a 3.x test pins the exact message: a pre-commit ref `refs/omr/<planId>/pre/<taskId>/<n>` = HEAD
  (extend `purge` to delete it).
- After every `policy.park`, return the slot to the pool. Add the missing breaker feeds of B5.

**`src/compat/background.ts`:** no change (executor children are not in the in-flight journal, `v2-hooks.ts:2037-2039`).
A 4.2.6 test asserts a restored child's end has no compat-side effect; only if it fails, add a guard ignoring end events
of untracked sessions whose first prompt `looksLikePlanPrompt`.

**`src/compat/v2-hooks.ts`:** not in 4.2.5's write set. A real `activity` (host session status) is an improvement handed
to 5.1 with an ADR C-check of the status API; `children(parent)` is not needed.

### 9. `queue.resume()` (amended after V5)

One call site, `resumeIntegration(p)`, on every activation, approve included (lanes are latched until `resume()`
succeeds, `queue.ts:660, 1804-1833, 1855, 2687-2692`). Approve path: after the `plan-approved` + `→running` batch, before
the first `schedule`. Existing ledger: step 4 of `recoverPlan`. Sets `p.integrationResumed = report?.halted !== true`
(a double resolving `undefined` is tolerated). A halt (A2-5) pauses the plan with an item; a user `resume` calls
`resumeIntegration` again while `integrationResumed` is false. **Handoff to 5.1:** create `omr/<plan>/integration` and
the integration slot immediately before this call on the approve path; until then 4.2.6 fixtures create the branch.
**Fallback:** if a 3.x test breaks because of the approve-path call, limit it to recovery/adopt/promotion and hand the
approve path to 5.1.

### 10. Tests (4.2.6)

- **unattended:** `raise` (dedupe, ids by prefix, no wake for closed items, one wake across a reopen); `park` (every cause
  from every legal state; illegal state → no write; dependents diamond/chain/non-pending untouched; independent task
  still ready; QA gate requeue; release only after the fsync and not when `append` fails); `answer` (`parked→ready` with
  context; `E_INVALID_INPUT` for a closed item or bad option; case/whitespace; `qa-cap` routing; breaker unpause; an
  exhausted task gets exactly one more attempt); `unblock`; breaker table (1/5 no, 2/5 trip, 1/4 no, three in a row, a
  success resets, flaky excluded, 6/15 trips, 5/13 no, trips once while paused, identical after a rebuild, window after
  an answer, a succeeded attempt with verdict fail counts).
- **qa-loop:** `parse` (last fence wins, no fence, bad JSON, each schema violation, bounded error, round trip); grouping
  (fuzz: disjoint writes; deterministic k; file-less task; normalisation; >999 merge); every Q4 cell for `qaMaxRounds`
  1-4; route copy with/without `X.Y.FIX`; re-review route line; batch orders; idempotency; `onAwaitingQa`; accept/fix
  answers incl. `QA_ROUND_LIMIT`; termination with an always-major reviewer.
- **recovery:** every matrix cell incl. R2; `classifyChild` (get null; mismatch per header field; idle; active, inactive,
  unknown); tracked nonces excluded; orphans never include other plans' headers; a double feed (host event + C7) processed
  once; eligibility (toplevel mismatch, terminal status, second `recover()`); locks (stale dead-pid → takeover "recover";
  live holder → skipped, no interrupts; foreign toplevel → no takeover); `adopt` (stale, live other `E_LOCK_HELD`, same
  pid, journals `orchestrator-bound`, launch gate); lease rebuild failure → one item.
- **runtime harness (`executor-recovery.test.ts`):** probation (host event proves life; poll-seen context change proves
  life; idle during probation → processed once; deadline → interrupt, row 18 uncounted, relaunch only after the interrupt
  resolved; failing interrupt → no relaunch, one item after 5 failures); D11 (crash after commit before row 21 →
  `verifying` with that commit; clean tree without the trailer → old path; a retry on the old branch is not mistaken for
  this attempt's commit); approve-path `resume()` (once before the first `schedule`; halted → paused, item, no launches;
  user `resume` calls it again); same-process adopt (tracked launches untouched, processed once); breaker evaluated at
  activation after a missed feed; background: a restored child's end has no compat-side effect.
- **integration restart (`executor-recovery-restart.test.ts`):** a long-lived host simulator storing sessions on disk; the
  plugin host as a real Node child process killed at a signalled point; fake `activity` returns "unknown" with injected
  `livenessMs` 1500 / `pollMs` 200 (variant: active/inactive); children: an alive child emits events → adopted; a dead
  child → probation runs out → interrupted → relaunched; a child finished during the downtime → processed. Kill points
  K1 (after the integration entry's start event is fsynced, before the fast-forward), K2 (after `update-ref`, before the
  entry's end event), K3 (after `git commit` in a slot, before row 21). Compare with an uninterrupted control run: same
  final task states and integrated set; counted attempts equal (only uncounted `lost` may differ); each task launched once
  per counted attempt; no duplicate commits on the integration branch; same tip tree hash and commit subjects (trailers
  carry random nonces, so ids differ).
- 4.2.6.a handoff: the exact EXECUTOR.md text of "Unattended operation", "QA loop" and "Recovery" (every stop listed, X5).

### 11. Resolved checks

- **V1:** `HostSessions` has get/context/activity/interrupt/synthetic/move/onEvent; no `children`, no `abort`; the v2
  adapter's `activity` is a stub returning "unknown" → R1, R1a, the matrix, D5, D6, the 5.1 improvement handoff.
- **V2:** trigger union `background.ts:1371-1377`; executor-owned attempts settle only on `runner` (`:1697-1708`); no
  compat-side record after a restart → no `recovered` trigger, only a test guard.
- **V3:** `open` never takes over (`ledger.ts:2019-2023, 1739-1749`); stale rule `:1701-1708`; adopt exception
  `:1833-1836` → L2, L3, D1.
- **V4:** work loss confirmed (`runtime.ts:305-311, 1683-1708`) → D11.
- **V5:** lanes latched on `resumed`; `enqueue` before `resume()` just queues → §9.
- **V6:** `ready` with or without a slot is legal (`types.ts:791-796, 834-835`; `ledger.ts:428-433`) → R2.
- **V7:** no production call of `createExecutorRuntime` (tests only) → `realCollaborators`; 4.2.5 writes `runtime.ts`
  (`background.ts` only as a contingency).
- **V8:** `countsTowardMaxAttempts` = succeeded|failed; `hasAttemptsLeft` = counted < max; `isBreakerFailure` = failed or
  verdict fail/unverifiable (`types.ts:547-561`) → B1, B5.

### 12. Risks and order

- Probation waits up to 60 s per in-flight child after a restart until v2 has a real `activity` (5.1 handoff).
  *Resolved 2026-10-15 (Phase 6.1):* the host still has no plugin-readable activity signal (`activity` stays `unknown`),
  but a `running` child is now requeued at once only when its recorded launcher process is provably dead on this host
  and no tool call was in flight (ADR 0007 D16, host contract `C16/D16`); every other case keeps the probation.
- A hung previous holder's long-silent live child may be interrupted: wasted, never counted or duplicated; an interrupt
  that cannot reach another server process keeps the task waiting with an item.
- A late child after a `dispatched` requeue could briefly share the slot until the L12 interrupt (C12 makes it unlikely).
- The approve-path `resume()` and the commit trailer may break 3.x tests; §9 and D11 fallbacks cover them.
- Plans from another toplevel that 3.1's `start()` attaches with `open` are not reconciled (5.1 fixes the process's
  toplevel).
- The breaker trips easily (2 failures in 5): the plan's choice, documented.
- Order: 4.2.2 ∥ 4.2.3 ∥ 4.2.4 → 4.2.5 → 4.2.6 → QA.

## Findings

| Round | Reviewer | Commit | Findings | Status |
|---|---|---|---|---|
| 1 | `ses_ecc765d40ffe0lJJ0ISC0Mbh2h` | `55f6ab2` | 8 major (QA-4.2-1 v2 host preamble makes every child `mismatch`; -2 no real end state; -3 queue never disposed; -4 ends lost during a same-process adopt; -5 unrelated answer resumes a park; -6 rejected `resume()` silently disables integration; -7 adopt of an awaiting-approval plan; -8 post-child systemic failures invisible to the breaker), 10 minor (-9..-18), 3 nits | fixed in `d468a6f` |
| 2 | `ses_ecc3eb284ffelBWobgS3Eu9eL3` | `d468a6f` | 3 major (-19 `isCommitFailure` state-dependent, `maxAttempts=1` never trips; -20 R2 re-provisions an earlier attempt's commit; -21 foreignness by absence from `recover()`), 5 minor (-22..-26), 3 nits (-27..-29); `runtime.ts` 84.27 branches | fixed in `4dd943d`; -21 partial (→ -30) |
| 3 (bounded, §0.7) | `ses_ecc19be2affe4S8VCo2sgAY2n2` | `4dd943d` | -19, -20 fixed; -21 partial; 1 major (QA-4.2-30 an omitted `RuntimeDeps.toplevel` made foreign plans active, regression from `d468a6f`); 8 minor (-31..-38) | -30 fixed in `48db549`; coverage `fbb18a3`; minors deferred |
| 3 re-check | `ses_ecc19be2affe4S8VCo2sgAY2n2` | `fbb18a3` | -30 closed; new tests and skip lists hold; no blocking/critical/major; 5 minor (-39..-43) | minors deferred |

## Fixes

- Round 1 `d468a6f`: v2 host preamble stripped before the R1 header match (-1); `finished` only on an adapter-reported
  end, memo R1 rule 5 (-2); queue disposed on close (-3); re-attach barrier for a same-process adopt (-4); park-item
  answers (-5); a rejected `queue.resume()` pauses the plan with one critical item (-6); **A-4.2-1** no adopt before
  approval (-7); **A-4.2-2** commit failures feed the breaker (-8); default fix tasks run as `implementer` (-11);
  case/prefix-folded fix groups (-12); slot lost before commit fails and retries (-13); `breaker-fed` markers at
  activation (-14); the probation interrupt's own end is `lost "restart"` (-15); lease-held tasks (-16); passive foreign
  plans (-17); adopted children re-bound (-18); **X11** strict breaker ratio; gate-aware `unblock` (`edgeSatisfied`).
- Round 2 `4dd943d`: commit failures counted in any later state (-19); attempt trailer checked before R2 re-provisions
  (-20); foreignness by the plan's toplevel (-21); `breaker-fed` markers for commit and qa-unparsable failures (-22);
  required `bindings` with eviction (-23); a real end racing the probation interrupt is processed (-24); a failed adopt
  re-attaches (-25); a held task leaves the hold on a vanished slot and its item names the hold (-26); one shared
  child-end rule, `childHistoryEnd` (-27); an `idle` without an outcome is no end (-28); one history export per
  attachment (-29).
- Round 3 `48db549`: `RuntimeDeps.toplevel` required (-30); held-slot, eviction and re-attach tests.
- Round 3 `fbb18a3`: `runtime.ts` coverage tests, no source change.

## Coverage

Orchestrator runs on 2026-10-13 at `fbb18a3`: executor/plan set (45 files) 3038 passed / 3 skipped; the 4 runtime test
files green 3 runs in a row; `tsc --noEmit` clean. Branches/lines: `runtime.ts` 93.17/97.49 (85.95 branches at
`4dd943d`), `qa-loop.ts` 93.26/99.13, `recovery.ts` 92.43/98.77, `unattended.ts` 93.44/100; per-file gate for
`src\executor\**` 90. Accepted defensive arms are listed at the end of `test\unit\executor-runtime-coverage-a.test.ts`
and `-b.test.ts` (A-4.2-3).

- Deviations: the 4.2.3/4.2.4 implementers ran the full `test` script through `router_run`, against plan §0; the 3.2
  heartbeat test `createRepoLockFactory` "a re-armed heartbeat keeps beating on every period"
  (`test\unit\executor-integrate-queue.test.ts`) failed once under 12 workers with coverage and passed at 8 (observed,
  not a 4.2 change).

## Deferred findings

- QA-4.2-31 (r3 minor): a held task whose slot record vanished while its leases are held elsewhere loses the hold and
  gets a misleading "restore the task branch" item; fails closed, stuck until a restart.
- QA-4.2-32 (r3 minor): the trailer search uses `log --all` but re-provisions from the branch tip; restrict it to the
  task branch (also bounds the history walk).
- QA-4.2-33 (r3 minor): the takeover gate in `start` still uses `recoverable`; a same-repo plan with a stale lock is not
  attached until adopt or restart.
- QA-4.2-34 (r3 minor): the qa-unparsable park marker is not added to `p.fed`; one extra harmless evaluation.
- QA-4.2-35 (r3 minor): `reattachAfterFailedAdopt` attaches without the foreign flag; consistency only.
- QA-4.2-36 (r3 minor): `RecoveryDeps.toplevel` and `RuntimeDeps.toplevel` are two sources of truth; derive one from the
  other (5.1 assembly).
- QA-4.2-37 (r3 minor, pre-existing): compile and approve never check foreignness; a plan file in another repo runs here.
- QA-4.2-38 (r3 minor): a cancelled commit failure drops out of the breaker window.
- QA-4.2-39 (re-check minor): `executor-runtime-coverage.test.ts` keeps a stale skip list (arms now covered by `-a`) and
  an unused `mk` harness.
- QA-4.2-40 (re-check minor): `adoptChild` re-binds a child the attempt does not record before probation drops the
  watch; guard on `a.childSessionID === child` and invert the `-b` assertion (the real engine cannot produce the feed).
- QA-4.2-41 (re-check minor): some negative assertions follow a fixed `pause(20|50)` and can pass vacuously on a slow
  runner; await `runtime.settled()` where no child is live.
- QA-4.2-42 (re-check minor): `sameToplevel` uses plain `realpathSync`, so an 8.3 short-name toplevel would mark this
  repository's plans foreign (fail-closed); use `realpathSync.native`.
- QA-4.2-43 (re-check minor): skip lists cite raw line numbers; cite function names.

## Handoffs

- 5.1 registration: register `router_plan` (with the approve getter), `/plan`, help `plan:true` and the instructions
  provider. Assemble via `realCollaborators` with the required `bindings` and `toplevel`, and derive
  RecoveryDeps.toplevel from the same value (-36).
- 5.1 approve path: `validateSlotsDir` at approve. Create `omr/<plan>/integration` and its slot before `resume()`.
- 5.1 leases: `LeaseRegistryPort.holderOf` → `planHolderOf(<plan toplevel>, path)`.
- 5.1 sessions: a real v2 `activity`. Adopt refuses a live bound session. Adopt and approve are root-only. Rebuild from
  the ledger at start. Kick the queue on a user pause or unpause.
- 5.1 revert: a reverted culprit retries on its old branch.
- 5.1 docs: the EXECUTOR.md "Unattended operation" / "QA loop" / "Recovery" sections, updated for X11 (strict ratio
  `F > ratio·N`, consecutive `C ≥ n`), A-4.2-1 and A-4.2-2.

## Plan amendments

- **A-4.2-1** (QA-4.2-7): adopt refuses `awaiting-residue` and `awaiting-approval` plans.
- **A-4.2-2** (QA-4.2-8, -19): commit failures, and "no changes" with declared writes, are breaker failures
  (`isCommitFailure`).
- **X11** (round 1, strict breaker ratio): the ratio rule is strict, `F > ratio·N`; consecutive stays `C ≥ n` (amends
  memo B2).
- **R1 rule 5** (QA-4.2-2): "finished" counts only from an adapter-reported end.
- **A-4.2-3** (round 3, `fbb18a3`): uncovered defensive arms in `runtime.ts` are accepted, as listed at the end of
  `test\unit\executor-runtime-coverage-a.test.ts` and `-b.test.ts`; the per-file gate is met regardless.

## Verdict

Done at `fbb18a3`: three heavy QA rounds plus a bounded round-3 re-check, every blocking/critical/major finding fixed,
minors dispositioned. Merged into `cpx/main`.
