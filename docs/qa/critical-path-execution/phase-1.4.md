# Phase 1.4 — Executor contracts

Worktree `D:\git\omr-cpx-p14`, branch `cpx/p14`, base tag `cpx/p14-base` = `4161324`. Started 2026-10-11 01:36.

## Pre-flight

- [x] Depends on 0.1: merged into `cpx/main` (`4161324`) on the owner's instruction to proceed while the Phase 0.1 QA round-2 follow-ups (`cpx/p01`) finish; the round-2 corrections that bind this phase (QA-0.1-20 attempt counting, QA-0.1-21 prompt assembly, QA-0.1-25 retained signal) were applied in the 1.4.1 memo.
- [x] No in-flight phase writes `src\executor\types.ts`, `vitest.config.ts` or `test\unit\executor-types.test.ts`.
- [x] Worktree created from `cpx/main`, tag set and pushed, `npm ci` ran, `git status` clean.
- [x] `npm run typecheck` green at `4161324`. Scoped baseline: no existing tests own these files (new files; `vitest.config.ts` is a config hub).
- [x] Anchors (explorer `ses_ed6bffcdaffenUaigZQ7rRvObZ`): `vitest.config.ts` ≈18-31 (`MERGED_PER_FILE_MIN`/`MERGED_PER_FILE_GATED`) and ≈65-76 (`thresholds`) hold. In CI the coverage jobs set `OMR_COVERAGE_ARTIFACT=1`, which empties `thresholds`; the enforced gate is the merged per-file check (`scripts/coverage-merge.mjs`) — 1.4.3 must add the executor gate where CI enforces it.
- [x] `smoke:cpx` green (3× at `7b11504`; no host change since).
- [x] `src\executor\types.ts` does not exist yet (this phase creates it).

## Implementation notes

### 1.4.1 contract memo (architect, heavy pin, `ses_ed6bfb8f0ffe32RmMGO7rofhwF`)
# Executor contract (Phase 1.4) — `src/executor/types.ts`

## 0. Problem

Phases 2.2–5.1 build in parallel against one file. Appendix A fixes the data and the transition table (plan 4244-4344), but leaves these open:
- how each transition maps to an attempt outcome, and which outcomes count;
- the phase-gate state machine;
- where the attempt nonce travels and the exact launch-header grammar;
- which module may write which transition;
- how an integration step survives a snapshot (journal rotation);
- several triggers that contradict each other.

This memo closes all of these without adding any `TaskState`, any task transition or any field to Appendix A's data.

## 1. Main design decisions

| # | Question | Options | Choice and why |
|---|---|---|---|
| D-a | Attempt counting | (1) a new `counted` field on `Attempt`; (2) count from the journal; (3) count from `outcome` alone | **(3)**. No schema change, the snapshot alone is enough, and it is testable as a pure function. To make it work, `interrupted` is defined precisely (R6). |
| D-b | Where the nonce travels | (1) inside the brackets; (2) a separate line; (3) the session description | **Same line, after the brackets**: `[plan p:t#n] nonce=<hex>`. D14's bracket token stays byte-exact (ADR 602-604). Recovery reads the nonce from the child's first user message (C7). |
| D-c | Dependencies on a phase gate | (1) synthetic gate tasks; (2) a rule inside the scheduler only; (3) edge endpoint `gate:<phaseId>` | **(3)**. Edges stay the single source of dependencies for 2.3 and 3.1. `:` cannot appear in a task id, so the two can't collide. |
| D-d | Integration-queue state after rotation | (1) a new `LedgerV1.queue` field; (2) rebuild from the snapshot plus git | **(2)**. Tasks in `integrating` plus `slot`, `branch` and `integration.head` are enough for `resume()`. Ancestry in git decides whether to complete or roll back. `IntegrationEntry` is only the payload of `integration-step` events. |
| D-e | Who writes the ledger | (1) the runtime is the only writer and the other modules return effects; (2) one shared `LedgerWriter` plus a transition-ownership table | **(2)**. One process and one lock (2.2.2.e); the writer rejects illegal transitions; the ownership table (§3.3) lets test doubles check each module's boundary. |
| D-f | A launch not confirmed within 30 s | (1) abort it; (2) keep it pending and adopt a late child | **(2)**. This is what gives Appendix A's `ready → running` its live meaning. The old launch is aborted only when a new attempt starts for that task (R4). |

## 2. Appendix A ambiguities resolved (binding)

- **R1. `dispatched → failed` ("host error") contradicts D14 guard 2.** Any throw before confirmation is `lost` and marks the context stale (ADR 622-624). The exception is a *task-class* error raised by the executor's own launch preparation: route, agent or model resolution, prompt validation, or the binding write. That goes to `dispatched → failed` with outcome `failed`, which counts.
- **R2. A lost child closes the attempt that was in flight** (QA-0.1-20). It does not open a new one. This replaces "new attempt record" in ADR D16 (689) and plan 4.2.4.a (3543-3544).
- **R3. Capacity outcomes** (QA-0.1-20). A child execution failure becomes `capacity` when `error.type` is `provider.quota`, `provider.rate-limit` or `provider.internal`, or when an unknown type has status 429 or 529. This holds whether the router's retry hook stopped the retries or the host ended them itself. Every other error is `failed`.
- **R4. Confirmation timeout.** The task goes `dispatched → ready` (attempt `lost`) and the context is marked stale. The launch is not aborted, and the task keeps its slot and leases.
  - If a late `onCreated` arrives while that attempt is still the task's latest and the task is still `ready`, the runtime adopts the child: the binding is written, the attempt is reopened, and the task goes `ready → running` (trigger `adopt`).
  - Once a newer attempt exists, a late child is refused: `onCreated` throws, so the runner interrupts it (v2-client.ts:224-227). Refused children are never bound, so they fail closed.
- **R5. `ready → pending`.** Trigger widened to "a new incoming edge is unsatisfied", which covers `add-tasks` and also the learned edge from `NEED MORE: lease`. That path journals `running → ready` then `ready → pending` in the same batch, and the slot and leases are released.
- **R6. `interrupted`** means the attempt ended without a result for a reason that is not the task's fault and that the executor recognises:
  - its own cancel (abort, a dependency revert, a superseded attempt);
  - the child's `ESCALATE: human` or a stated ambiguity (`NEED MORE:` other than a lease);
  - a `NEED MORE: lease` that added a **new** learned edge.

  A lease request that adds no edge (the holder is not a plan task, the edge already exists, or it would make a cycle) goes `running → failed` (`lease-unresolvable`) and counts.
- **R7. Parent (orchestrator) interrupt.** No transition: launches never use the retained context's `signal` and never forward `progress` (QA-0.1-25; ADR 575-578, 630-632). If the host interrupts a plan child anyway, that is guard 5:
  - `running → ready`, outcome `lost`;
  - `dispatched → ready`, outcome `lost`, context marked stale.
- **R8. Pause stops new work only.** A paused plan or phase launches nothing and dequeues nothing. Children in flight finish and are processed up to `verified`, then wait. No task transition is involved.
- **R9. A dependency revert affects only `ready`, `dispatched` and `running` dependents** (→ `blocked`; any child is cancelled after the fsync). Dependents in `completed`, `verifying`, `verified` or `integrating` continue: the queue's rebase and checks are the safety net. Dependents already `integrated` are re-checked by the phase suite (3.2.4.c, step 4).
- **R10. `blocked` exits only to `ready` (when every dependency is `integrated` or `done`) or to `cancelled`.** There is no `blocked → pending` edge, so a task stays `blocked` while it waits. Blocking spreads transitively: `pending → blocked` when a dependency is `parked` or `blocked` (4.2.1 owns the rule).
- **R11. A culprit revert that can't land** (it conflicts, or its checks fail). The culprit stays `integrated`, because `integrated → parked` is illegal (4340). Instead the phase gate goes `suite-failed`, the phase is paused, and a `critical` `failure` inbox item names the culprit. 3.2's test "the culprit is parked" (3259) should be read as "the phase is paused".
- **R12. QA output that does not parse** (4.2.3.a).
  - First time: `running → failed` (`qa-unparsable`, counts), then `ready` with the parse error as context.
  - Second time: `running → parked` (`qa-unparsable`) with a `failure` inbox item.
  - Output that parses: `running → completed → done`, then `QaLoop.onQaResult`.
- **R13. `Attempt.context` is the feedback the attempt produced** (conflict summary, findings, check output, revert failure, the human's answer). It starts as `""` and is set by an `attempt-context` event. The next prompt's ATTEMPT CONTEXT is the `context` of the most recent attempt whose context is not empty. An answer always attaches to the task's latest attempt; a parked task cannot start a new one, so an answer can't land on the wrong attempt.
- **R14. Plan order is the insertion order of `tasks`.** Task ids must never be integer-like strings (`/^\d+$/`), so `JSON.parse` keeps key order.
- **R15. Re-entering a state is not a transition.** For example, recovery re-running verification on a `verifying` task journals no transition. `canTransition(x, x)` is false for every x.
- **R16. A `qa` task becomes `ready` only while its phase gate is `awaiting-qa`.** This comes on top of its edges.

## 3. Task state machine

### 3.1 `TASK_TRANSITIONS` (47 legal pairs; anything else fails `canTransition` and ledger replay)

Owner codes: **Rt** = ExecutorRuntime, **Q** = IntegrationQueue, **P** = UnattendedPolicy, **Rc** = RecoveryService (a late child adopted while live goes through Rt).

| From | To | Triggers | Attempt effect (same journal batch) | Owner |
|---|---|---|---|---|
| pending | ready | `deps-satisfied` | — | Rt |
| pending | blocked | `dep-parked`, `dep-blocked` | — | P |
| pending | cancelled | `abort` | — | Rt |
| ready | dispatched | `launch` | `attempt-started` (open; `n` = attempts.length+1; nonce; callID) | Rt |
| ready | blocked | `dep-reverted` | — (slot and leases released) | Rt |
| ready | cancelled | `abort` | — | Rt |
| ready | running | `adopt` | `attempt-adopted` (reopens the latest attempt, which is `lost`, when the nonce matches) | Rc / Rt |
| ready | done | `reported-done` (kind `manual` or `preflight` only) | — | Rt |
| ready | pending | `dep-added` (R5) | — (slot and leases released) | Rt |
| dispatched | running | `child-created` | `attempt-child` | Rt |
| dispatched | ready | `launch-lost` | ended `lost` | Rt |
| dispatched | failed | `launch-task-error` (R1) | ended `failed` | Rt |
| dispatched | blocked | `dep-reverted` | ended `interrupted` | Rt |
| dispatched | cancelled | `abort` | ended `interrupted` | Rt |
| running | completed | `child-ended` | ended `succeeded` | Rt |
| running | failed | `child-failed`, `lease-unresolvable`, `qa-unparsable` (1st) | ended `failed` | Rt |
| running | parked | `escalate`, `ambiguity`, `qa-unparsable` (2nd) | ended `interrupted` | P |
| running | ready | `child-lost`, `capacity-stop`, `lease-needed` | ended `lost` / `capacity` / `interrupted` | Rt |
| running | blocked | `dep-reverted` | ended `interrupted` | Rt |
| running | cancelled | `abort` | ended `interrupted` | Rt |
| completed | verifying | `committed` | — | Rt |
| completed | done | `no-changes` | — | Rt |
| completed | failed | `commit-failed` | (stays `succeeded`; counts) | Rt |
| completed | cancelled | `abort` | — | Rt |
| verifying | verified | `verify-pass` | `attempt-verdict` pass | Rt |
| verifying | failed | `verify-fail` | `attempt-verdict` fail/unverifiable, plus `attempt-context` | Rt |
| verifying | cancelled | `abort` | — | Rt |
| verified | integrating | `dequeued` | — | Q |
| verified | cancelled | `abort` | — | Rt |
| integrating | integrated | `fast-forwarded` | `task-integrated` + `integration-head` | Q |
| integrating | conflict | `rebase-conflict` | `attempt-context` | Q |
| integrating | failed | `checks-failed` | `attempt-context` | Q |
| integrating | cancelled | `abort` (only after `resume()` rolled the step back) | — | Q |
| integrated | reverted | `suite-culprit` (after the checked revert is fast-forwarded) | `attempt-context` | Q |
| conflict, failed, reverted | ready | `retry` (counted attempts < `maxAttempts`) | — | Rt |
| conflict, failed, reverted | parked | `exhausted` | — | P |
| parked | ready | `answered` | (answer stored in the latest attempt's `context`) | P |
| blocked | ready | `dep-recovered` (every dependency `integrated` or `done`) | — | P |
| completed, failed, conflict, reverted, parked, blocked | cancelled | `abort` | — | Rt |

Rules:
- Terminal states are `done` and `cancelled`. `integrated` exits only to `reverted`.
- The only edge into `integrated` comes from `integrating`, and the only edge into `integrating` comes from `verified`. So no path reaches `integrated` without `verified` (1.4.4: a breadth-first search with `verified` removed must not reach `integrated` from `pending`).
- Every other state has an exit to `cancelled`.
- Tasks are created `pending`, or `done` through `task-created` (for `doneBefore`; plan 4341, 2.3.6.c).

**fsync before any visible step (D8, 2.2.2.a).** Events are journaled and fsynced before the step that makes them visible:
- `attempt-started` + `ready→dispatched`: before `ChildRunner.run`.
- `attempt-child` + `dispatched→running`: inside `onCreated`, before it returns, so before the child is prompted (v2-client.ts:195-198).
- `ended interrupted` + `→cancelled`/`→blocked`: before `interrupt`.
- `integration-step start` (fast-forward, candidate): before `merge --ff-only`.
- `wake`: before `synthetic`.

### 3.2 What each QA-1.4 focus state looks like

| Situation | Path |
|---|---|
| Restart adoption | `dispatched → running` with a live child; `ready → running` when the nonce matches; dispatched or running with the child neither finished nor active → `ready` (`lost`) |
| Parent interrupt | R7 |
| Abort | every row ending in `cancelled`; `integrating` only after rollback |
| Revert | `integrated → reverted → ready/parked`; dependents per R9; a revert that can't land per R11 |
| Commit failure | `completed → failed` |
| Blocked by a revert | ready, dispatched or running `→ blocked` |
| `done` | `completed → done` (no changes) or `ready → done` (manual or preflight) |

### 3.3 `GATE_TRANSITIONS` (binding; replay checks it like task transitions)

| From | To | Trigger | Owner |
|---|---|---|---|
| pending | suite-running | every non-`qa` task of the phase `integrated` or `done`; `phaseSuite` ≠ `off` | Q |
| pending | awaiting-qa | the same, with `phaseSuite = off` | Q |
| suite-running | awaiting-qa | pass, flaky, or only pre-existing failures | Q |
| suite-running | suite-failed | failure with a culprit | Q |
| suite-failed | pending | culprit reverted and reopened | Q |
| suite-failed | suite-running | rerun after an inbox answer (R11) | Q |
| awaiting-qa | qa-running | a `qa` task of the phase dispatched | Rt |
| awaiting-qa | passed | the phase has no open `qa` task | QaLoop |
| qa-running | awaiting-qa | the `qa` attempt ended lost, capacity or interrupted; or the round cap was reached with blocking findings (phase paused plus a `qa-cap` critical item) | Rt / QaLoop |
| qa-running | pending | fix and re-review tasks created | QaLoop |
| qa-running | passed | zero in-scope findings, or the cap reached with only minor/nit findings left (deferred) | QaLoop |

`passed` is terminal. Gates of phases before `doneBefore` start at `passed` (2.3.6.c). `add-tasks` may target only phases whose gate is `pending`.

### 3.4 `LEDGER_STATUS_TRANSITIONS`

- `compiling` → `awaiting-residue` | `awaiting-approval` | `aborted`
- `awaiting-residue` → `awaiting-approval` | `aborted`
- `awaiting-approval` → `running` (`approve`, or immediately with `approve: auto`) | `aborted`
- `running` → `paused` | `completed` | `aborted`
- `paused` → `running` | `aborted`
- `completed` and `aborted` are terminal.

`completed` means every task is `integrated` or `done` and every gate is `passed`. Landing comes after; `land` is allowed while the plan is `completed`.

## 4. Attempt outcomes, counting and the circuit breaker

| Outcome | Set when | Counts toward `maxAttempts` | Breaker sample |
|---|---|---|---|
| `succeeded` | the child ended normally with a result | yes | yes; a failure sample iff `verdict ∈ {fail, unverifiable}` |
| `failed` | non-capacity execution failure, R1 task error, `lease-unresolvable`, `qa-unparsable` | yes | yes (failure) |
| `interrupted` | R6 | no | no |
| `lost` | unconfirmed or thrown launch (stale context), unrequested interrupt, restart, runner error with no terminal event | no | no |
| `capacity` | R3 | no | no |

```ts
export function countsTowardMaxAttempts(a: Attempt): boolean { return a.outcome === "succeeded" || a.outcome === "failed"; }
export function countedAttempts(t: TaskNode): number { return t.attempts.filter(countsTowardMaxAttempts).length; }
export function hasAttemptsLeft(t: TaskNode, maxAttempts: number): boolean { return countedAttempts(t) < maxAttempts; }
export function isBreakerFailure(a: Attempt): boolean { return a.outcome === "failed" || a.verdict === "fail" || a.verdict === "unverifiable"; }
```

How these combine:
- Conflicts, commit failures, integration-check failures and reverts consume an attempt (`succeeded` counts) but are not breaker failures.
- Flaky suite results are not attempts.
- Breaker input, per phase: counted attempts in `endedAt` order. It trips at `failureRatio` over at least `minAttempts` samples, or at `consecutiveFailures` (4.2.2.c).

## 5. Ledger data (`src/executor/types.ts`; JSON only)

```ts
export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };
export type IsoTime = string;            // UTC "YYYY-MM-DDTHH:mm:ss.sssZ"
export type PlanId = string; export type TaskId = string; export type PhaseId = string;
export type GateRef = `gate:${string}`;  // edge source only: satisfied when phases[id].gate === "passed"

export const LEDGER_SCHEMA = 1 as const;
export const PLAN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,40}$/;                        // Appendix A 4249
export const TASK_ID_PATTERN = /^(?!\d+$)[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;        // R14; no ':', '#', ']', space
export const NONCE_PATTERN = /^[0-9a-f]{32}$/;

export type LedgerStatus = "compiling" | "awaiting-residue" | "awaiting-approval" | "running" | "paused" | "completed" | "aborted";
export type GateState = "pending" | "suite-running" | "suite-failed" | "awaiting-qa" | "qa-running" | "passed";
export type TaskState = "pending" | "ready" | "dispatched" | "running" | "completed" | "verifying" | "verified"
  | "integrating" | "integrated" | "done" | "failed" | "conflict" | "parked" | "blocked" | "reverted" | "cancelled";
export type TaskKind = "preflight" | "task" | "tests" | "qa" | "fix" | "manual";
export type Tier = "fast" | "medium" | "heavy";

export interface PhaseRecord { id: PhaseId; title: string; wave: string; dependsOn: string[]; gate: GateState;
  qaRound: number; paused: boolean; tag: string | null }
export interface LedgerV1 {
  schema: 1; planId: PlanId; planPath: string /* absolute */; planDigest: string /* sha256 hex, 64 */;
  repo: { key: string; toplevel: string; baseBranch: string; baseCommit: string };
  integration: { branch: string /* omr/<planId>/integration */; worktree: string; head: string };
  launcher: "A"; status: LedgerStatus;
  orchestrator: { sessionID: string; boundAt: IsoTime };
  config: ExecutorConfig;                 // resolved at compile, re-snapshotted at approval; slotsDir non-null from approval on
  sharedContext: string;                  // ≤ config.sharedContextChars; contains no slot path
  waves: Array<{ id: string; phases: PhaseId[] }>;
  phases: PhaseRecord[];
  tasks: Record<TaskId, TaskNode>;        // insertion order = plan order (R14)
  edges: Edge[]; inbox: InboxItem[];
  seq: number;                            // seq of the last applied event
}
export interface Footprint { writes: string[]; reads: string[];   // repo-relative, '/'-separated, no '.'/'..', no trailing '/'
  confidence: "explicit" | "ownership" | "inferred" | "unknown";
  sources: Array<"path" | "ownership" | "writes-line" | "llm" | "learned"> }
export interface TaskNode {
  id: TaskId; title: string; phase: PhaseId | null; kind: TaskKind;
  text: string; subtasks: string[];
  route: { line: string; role: string; tier: Tier | null; pin: boolean };
  verify: "required" | "deferred" | "none"; acceptance: string | null;
  footprint: Footprint;
  estimate: { p50: number; p90: number; source: string };   // ms, finite, 0 ≤ p50 ≤ p90
  state: TaskState; attempts: Attempt[];
  slot: string | null; branch: string | null;               // branch = omr/<planId>/t/<encoded taskId>
  integrated: { from: string; to: string } | null;          // the latest integration range
}
export interface Edge { from: TaskId | GateRef; to: TaskId;
  kind: "structural" | "explicit" | "graph" | "contract" | "conflict" | "llm" | "learned";
  confidence: "high" | "medium" | "low"; evidence: string }
export type AttemptOutcome = "succeeded" | "failed" | "interrupted" | "lost" | "capacity";
export type Verdict = "pass" | "fail" | "unverifiable";
export interface Attempt { n: number /* 1-based, = index+1, every attempt */; nonce: string; callID: string | null /* retained router-call id used */;
  childSessionID: string | null; startedAt: IsoTime; endedAt: IsoTime | null;
  outcome: AttemptOutcome | null; verdict: Verdict | null; context: string /* R13 */ }
export type InboxKind = "question" | "failure" | "usage-limit" | "landing" | "flaky" | "qa-cap" | "breaker";
export interface InboxItem { id: string /* "<P>-<n>", P∈{Q,F,U,L,K,R,B} by kind, n unique per plan */; kind: InboxKind;
  severity: "info" | "blocking" | "critical"; taskId: TaskId | null; text: string; options: string[];
  answer: string | null; createdAt: IsoTime }
// Deferred minor/nit findings (4.2.3.d) are stored as {kind:"qa-cap", severity:"info", answer:"deferred"}:
// they persist in the snapshot, are already closed, and trigger no wake.

export interface SlotRecord {                 // marker <executor home>\slots\<slot>.json (2.4.3.a); not part of LedgerV1
  schema: 1; slot: string /* "slot-<n>" | "integration" | "ci" */; path: string; kind: "task" | "integration" | "ci";
  planId: PlanId; repoKey: string;
  state: "creating" | "provisioning" | "ready" | "leased" | "resetting" | "broken" | "retired";
  owner: string | null /* taskId or integration entry id */; commit: string | null;
  managers: string[]; manifests: Record<string, string> /* repo-relative manifest path → sha256 */;
  createdAt: IsoTime; updatedAt: IsoTime }

export type IntegrationStep = "rebase" | "checks" | "fast-forward" | "batch-checks" | "bisect" | "phase-suite"
  | "suite-rerun" | "revert-build" | "revert-checks" | "revert-fast-forward" | "rollback" | "tag" | "land";
export type IntegrationStepResult = "ok" | "conflict" | "failed" | "flaky" | "pre-existing" | "refused" | "rolled-back";
export interface IntegrationEntry { id: string /* "i-<seq of first start>" */;
  kind: "task" | "batch" | "revert" | "phase-suite" | "land"; phaseId: PhaseId | null;
  taskIds: TaskId[]; slot: string | null; baseHead: string; candidate: string | null }

export interface RunCommandRef { script: string; args: string[] }
export interface ExecutorConfig {          // Appendix C 4381-4399; ranges in EXECUTOR_LIMITS
  maxParallel: number;                     // 1–8 (ADR D13 500-504), default 4
  slotsDir: string | null;                 // trusted; null = computed (replaced by the computed path at approval)
  approve: "ask" | "auto"; crossPhase: "gate" | "inferred"; land: "ff-when-clean" | "manual";
  batchMax: number; maxAttempts: number; qaMaxRounds: number;
  integrationChecks: "auto" | RunCommandRef[]; phaseSuite: "auto" | "off" | RunCommandRef[];
  provision: "auto" | Record<string, string[][]>; python: "auto" | string;
  sharedContextChars: number; capacityCooldownMs: number; capacityPauseMs: number; wakeDebounceMs: number;
  circuitBreaker: { failureRatio: number; minAttempts: number; consecutiveFailures: number } }
export const EXECUTOR_DEFAULTS: ExecutorConfig;   // the Appendix C defaults
export const EXECUTOR_LIMITS: { maxParallel: [1, 8]; batchMax: [1, 8]; maxAttempts: [1, 6]; qaMaxRounds: [1, 8];
  sharedContextChars: [0, 60000]; capacityCooldownMs: [10000, 3600000]; capacityPauseMs: [60000, 86400000];
  wakeDebounceMs: [1000, 60000]; failureRatio: [0.1, 1]; minAttempts: [1, 50]; consecutiveFailures: [1, 50] };
```

## 6. `ExecutorEvent` (one per journal line; `seq` strictly +1)

```ts
export type TransitionTrigger = "deps-satisfied" | "dep-parked" | "dep-blocked" | "abort" | "launch" | "dep-reverted" | "adopt"
  | "reported-done" | "dep-added" | "child-created" | "launch-lost" | "launch-task-error" | "child-ended" | "child-failed"
  | "lease-unresolvable" | "qa-unparsable" | "escalate" | "ambiguity" | "child-lost" | "capacity-stop" | "lease-needed"
  | "committed" | "no-changes" | "commit-failed" | "verify-pass" | "verify-fail" | "dequeued" | "fast-forwarded"
  | "rebase-conflict" | "checks-failed" | "suite-culprit" | "retry" | "exhausted" | "answered" | "dep-recovered";
export type WakeReason = "inbox" | "phase-paused" | "plan-completed" | "manual-ready" | "stale-context";  // D15 658-664
export interface LockHolder { pid: number; hostname: string; sessionID: string; startedAt: IsoTime; heartbeatAt: IsoTime }
export type MetricPayload =
  | { name: "idle-with-ready"; fromAt: IsoTime; toAt: IsoTime; ms: number; readyTaskIds: TaskId[]; free: number }
  | { name: "wake"; reason: WakeReason; stateKey: string; result: "sent" | "debounced" | "duplicate" | "failed" }
  | { name: "launch"; taskId: TaskId; attempt: number; agent: string; model: string; provider: string; heavy: boolean }
  | { name: "context-age"; taskId: TaskId; attempt: number; callID: string; capturedAt: IsoTime; ageMs: number;  // D14 guard 4
      result: "confirmed" | "unconfirmed" | "threw" }
  | { name: "capacity"; provider: string; change: "decrease" | "increase" | "pause" | "resume" | "retry-stop";
      from: number; to: number; until: IsoTime | null; errorType: string | null; status: number | null }
  | { name: "counter"; key: string; value: number; labels: Record<string, string> };   // other Appendix D rows
type E<T extends string, P> = { seq: number; at: IsoTime; type: T } & P;
export type ExecutorEvent =
  | E<"ledger-init", { ledger: LedgerV1 }>
  | E<"draft-replaced", { draft: Pick<LedgerV1, "planDigest" | "sharedContext" | "waves" | "phases" | "tasks" | "edges"> }>  // pre-approval statuses only
  | E<"status-changed", { from: LedgerStatus; to: LedgerStatus; reason: string }>
  | E<"plan-approved", { config: ExecutorConfig; by: string }>
  | E<"orchestrator-bound", { sessionID: string; reason: "compile" | "adopt" }>
  | E<"lock-takeover", { reason: string; previous: LockHolder | null; holder: LockHolder }>
  | E<"task-created", { task: TaskNode }>                         // state pending, or done (doneBefore)
  | E<"edge-added", { edge: Edge }>
  | E<"task-transition", { taskId: TaskId; from: TaskState; to: TaskState; trigger: TransitionTrigger; detail: string | null }>
  | E<"attempt-started", { taskId: TaskId; attempt: Attempt }>
  | E<"attempt-child", { taskId: TaskId; n: number; childSessionID: string }>
  | E<"attempt-adopted", { taskId: TaskId; n: number; childSessionID: string }>
  | E<"attempt-ended", { taskId: TaskId; n: number; outcome: AttemptOutcome; endedAt: IsoTime; detail: string | null }>
  | E<"attempt-verdict", { taskId: TaskId; n: number; verdict: Verdict; ref: string | null }>
  | E<"attempt-context", { taskId: TaskId; n: number; context: string }>
  | E<"task-slot", { taskId: TaskId; slot: string | null; branch: string | null }>
  | E<"task-integrated", { taskId: TaskId; from: string; to: string }>
  | E<"integration-head", { head: string }>
  | E<"integration-step", { edge: "start" | "end"; entry: IntegrationEntry; step: IntegrationStep;
      result: IntegrationStepResult | null; detail: string | null; failingIds: string[] }>
  | E<"gate-changed", { phaseId: PhaseId; from: GateState; to: GateState; qaRound: number }>
  | E<"phase-paused", { phaseId: PhaseId; paused: boolean; reason: string }>
  | E<"phase-tagged", { phaseId: PhaseId; tag: string }>
  | E<"inbox-added", { item: InboxItem }>
  | E<"inbox-answered", { id: string; answer: string }>
  | E<"wake", { reason: WakeReason; stateKey: string }>
  | E<"metric", { metric: MetricPayload }>;
export type ExecutorEventInput = DistributiveOmit<ExecutorEvent, "seq" | "at">;  // the store assigns seq; `at` comes from Clock
export const DURABLE_TASK_STATES: readonly TaskState[] = ["dispatched", "running", "completed", "integrating", "integrated", "reverted", "cancelled"];
export function isDurableEvent(e: ExecutorEventInput): boolean;  // false only for "metric" and for task-transition into a non-durable state
```

Replay rules:
- `task-transition.from` must equal the current state, and `canTransition` must hold.
- Gate and status changes are checked against their tables.
- Attempt events must match `n` and open/closed state.
- `ledger-init` appears only at seq 1.

## 7. Constants, guards, prompt grammar, findings

```ts
export const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>>;   // §3.1
export const TRANSITION_TRIGGERS: Readonly<Record<`${TaskState}>${TaskState}`, readonly TransitionTrigger[]>>; // §3.1 rows
export function canTransition(from: TaskState, to: TaskState): boolean;
export const GATE_TRANSITIONS: Readonly<Record<GateState, readonly GateState[]>>; export function canGateTransition(a: GateState, b: GateState): boolean;
export const LEDGER_STATUS_TRANSITIONS: Readonly<Record<LedgerStatus, readonly LedgerStatus[]>>;
export const TERMINAL_TASK_STATES = ["done", "cancelled"] as const;
export const LAUNCH_CONFIRM_TIMEOUT_MS = 30_000;   // D14 guard 1
export const CHILD_END_GRACE_MS = 5_000;           // wait for a terminal session.execution.* event after a runner throw
export const HEAVY_CAP_PER_PROVIDER = 2;           // 3.1.3.a
export function ledgerSchemaOf(v: unknown): number | null;   // lets the store tell "newer" (E_SCHEMA_NEWER) from "invalid"
export function isLedgerV1(v: unknown): v is LedgerV1;
export function isTaskNode(v: unknown): v is TaskNode;
```

**What the guards check.**
- **Every field:** its type and enum; that numbers are finite (no NaN or Infinity); that patterns match.
- **`isLedgerV1`:**
  - `schema === 1`; a newer schema returns `false`;
  - `launcher === "A"`;
  - config values are within `EXECUTOR_LIMITS` (so `maxParallel: 9` fails);
  - each `tasks` key equals its task's `id`;
  - `task.phase` exists in `phases`, and each `phase.wave` exists in `waves`;
  - edge endpoints exist, and a `gate:` source names a real phase;
  - `seq` is an integer ≥ 1.
- **`isTaskNode` cross-field invariants:**
  - `attempts[i].n === i + 1`;
  - exactly one open attempt (`outcome === null`) exists, and it is the last, iff `state ∈ {dispatched, running}`;
  - `slot` is non-null in `dispatched` through `integrating`;
  - `branch` is non-null in `verifying` through `integrating`;
  - `integrated` is non-null when `state === "integrated"`;
  - a manual or preflight task has no attempts.
- **Unknown extra fields** are accepted at every level and survive a round trip: reducers spread objects, nothing is whitelisted.

**Prompt (QA-0.1-21; replaces the 3.1.4.a order at 2898-2905).**

```
prompt      = planContext "\n\n" headerLine "\n\n" taskBlock
planContext = "PLAN CONTEXT\n" ledger.sharedContext     ; byte-identical for every task and attempt of the plan
headerLine  = header " nonce=" nonce
header      = "[plan " planId ":" taskId "#" attempt "]" ; attempt = Attempt.n
```

```ts
export const LAUNCH_HEADER_PATTERN =
  /^\[plan ([a-z0-9][a-z0-9-]{2,40}):((?!\d+\])[A-Za-z0-9][A-Za-z0-9._-]{0,63})#([1-9][0-9]{0,3})\] nonce=([0-9a-f]{32})$/m;
export function formatLaunchHeader(p: { planId: string; taskId: string; attempt: number; nonce: string }): string;
export function parseLaunchHeader(prompt: string): { planId; taskId; attempt; nonce } | null;
```

- The child's first-context fail-closed check (3.1.7.a) refuses every tool call of an unbound child whose prompt matches `LAUNCH_HEADER_PATTERN`.
- `taskBlock` belongs to 3.1.4. It starts with `TASK` and holds: id and title, text, subtasks, `Writes:`/`Reads:`, ENVIRONMENT (slot), the acceptance *criteria rendered as prose*, ATTEMPT CONTEXT (R13), MUST NOT DO, and for `qa` tasks the findings instruction.
- The route line, `VERIFY:` and the `[acceptance]` block are never sent verbatim. The route line selects the agent and model; `root=` becomes the slot; VERIFY and the acceptance block configure `SlotVerifier`.

**Findings format.**

```ts
export type FindingSeverity = "blocking" | "critical" | "major" | "minor" | "nit";
export interface Finding { id: string; severity: FindingSeverity; files: string[] /* repo-relative '/' */; problem: string; fix: string }
export interface FindingsReport { findings: Finding[] }
export const FINDINGS_FORMAT = { type: "object", additionalProperties: false, required: ["findings"], properties: { findings: {
  type: "array", items: { type: "object", additionalProperties: false, required: ["id", "severity", "files", "problem", "fix"],
  properties: { id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" },
    severity: { enum: ["blocking", "critical", "major", "minor", "nit"] },
    files: { type: "array", items: { type: "string", minLength: 1 } },
    problem: { type: "string", minLength: 1 }, fix: { type: "string" } } } } } } as const;
export function isFindingsReport(v: unknown): v is FindingsReport;
// Extraction rule (the instruction in 3.1.4 and QaLoop.parse): the last ```json fenced block of the final answer, else the whole text.
```

Ids for tasks created by QaLoop (deterministic, so recovery stays idempotent):
- fix tasks: `${phaseId}.FIX${round}-${k}`;
- re-review tasks: `${phaseId}.QA${round + 1}`.

## 8. Interfaces

Every method throws `ExecutorError` (a class in types.ts, not ledger data) with
`code: "E_INVALID_INPUT" | "E_PLAN_STATE" | "E_NOT_OWNER" | "E_LEDGER_NOT_FOUND" | "E_EXISTS" | "E_SCHEMA_NEWER" | "E_SCHEMA_INVALID" | "E_SEQ_GAP" | "E_ILLEGAL_TRANSITION" | "E_LOCK_HELD" | "E_LOCK_LOST" | "E_COMPILE" | "E_CYCLE" | "E_RESIDUE" | "E_SLOT_UNAVAILABLE" | "E_SLOT_BROKEN" | "E_PROVISION" | "E_GIT" | "E_IDENTITY" | "E_CAPACITY" | "E_NO_CONTEXT" | "E_LAUNCH_TASK" | "E_DISPOSED"`
and `detail: JsonValue`. A failing `append` leaves memory and disk unchanged.

```ts
export interface LedgerStore {                       // 2.2
  /** pre: no plan dir; isLedgerV1(draft); post: dir, snapshot, journal (ledger-init at seq 1), lock held. err E_EXISTS, E_SCHEMA_INVALID */
  create(draft: LedgerV1, holder: LockHolder): Promise<LedgerWriter>;
  /** Takes the writer lock. err E_LEDGER_NOT_FOUND, E_LOCK_HELD (detail = holder), E_SCHEMA_NEWER, E_SEQ_GAP, E_ILLEGAL_TRANSITION (detail names the event) */
  open(planId: PlanId, holder: LockHolder): Promise<LedgerWriter>;
  /** Only when the lock is stale (dead pid on this host, or heartbeat > 60 s) or the caller is adopting; journals lock-takeover. err E_LOCK_HELD */
  takeover(planId: PlanId, holder: LockHolder, reason: string): Promise<LedgerWriter>;
  /** Lock-free consistent read (retries while snapshot seq ≠ first journal seq). A torn last line is dropped with one warning. */
  read(planId: PlanId): Promise<LedgerV1>;
  list(): Promise<Array<{ planId: PlanId; status: LedgerStatus; toplevel: string; orchestratorSessionID: string; seq: number }>>;
  exportPlan(planId: PlanId): Promise<{ snapshot: LedgerV1; events: ExecutorEvent[] }>;
  /** pre: status completed|aborted; no live writer elsewhere. post: plan dir gone. Returns false when absent. err E_PLAN_STATE, E_LOCK_HELD */
  remove(planId: PlanId): Promise<boolean>;
}
export interface LedgerWriter {
  readonly planId: PlanId; readonly ledger: Readonly<LedgerV1>;
  /** Atomic batch: validates every event against the current ledger, assigns seq and at, writes the lines, fsyncs if any event isDurableEvent.
   *  Resolves after the fsync. err E_ILLEGAL_TRANSITION (nothing written), E_LOCK_LOST, I/O */
  append(events: readonly ExecutorEventInput[]): Promise<Readonly<LedgerV1>>;
  snapshot(): Promise<void>;   // also every 200 events, then rotates the journal
  close(): Promise<void>;      // snapshot, then release the lock; idempotent
}

export interface PlanCompiler {                      // 2.3
  /** Reads the plan (FileSystem) and worktrees (GitRunner). Never writes. post: draft.status is awaiting-residue iff residueRequest.
   *  err E_COMPILE (line), E_CYCLE (minimal cycle), E_INVALID_INPUT (unknown phases/doneBefore) */
  compile(planPath: string, opts: { phases?: PhaseId[]; doneBefore?: PhaseId; config: ExecutorConfig; orchestratorSessionID: string; now: IsoTime }):
    Promise<{ draft: LedgerV1; residueRequest?: { prompt: string; schema: JsonValue; taskIds: TaskId[] }; summary: CompileSummary }>;
  /** Monotone merge, then re-validation. err E_RESIDUE (precise) */
  mergeResidue(draft: LedgerV1, responseText: string): { draft: LedgerV1; summary: CompileSummary };
  /** For router_plan add-tasks. Returns the new nodes and edges plus `reopened` (ready tasks that must go ready→pending). err E_CYCLE, E_INVALID_INPUT */
  addTasks(ledger: LedgerV1, text: string): { tasks: TaskNode[]; edges: Edge[]; reopened: TaskId[] };
  validate(ledger: LedgerV1): Array<{ code: string; message: string; taskIds: TaskId[] }>;   // cycles, ids, paths, concurrency closure
}
export interface CompileSummary { tasks: number; phases: number; edges: number; workMs: number; criticalPathMs: number; width: number;
  expectedMakespanMs: number; manual: TaskId[]; warnings: string[] }

export interface SlotLease { slot: string; path: string; planId: PlanId; owner: string; commit: string }
export interface SlotPool {                          // 2.4
  /** Never waits: a reset, provisioned slot leased to `owner`, or E_SLOT_UNAVAILABLE. Concurrent calls are serialized; never double-leases.
   *  A task that already holds a slot gets the same slot back. err E_SLOT_UNAVAILABLE, E_PROVISION, E_SLOT_BROKEN */
  acquire(planId: PlanId, owner: string, baseCommit: string): Promise<SlotLease>;
  acquireSpecial(planId: PlanId, kind: "integration" | "ci"): Promise<SlotLease>;
  reset(slot: string, commit: string): Promise<void>;        // checkout detached + clean tracked; re-provision on manifest drift
  cleanForChecks(slot: string): Promise<void>;
  release(slot: string): Promise<void>;                      // idempotent
  get(slot: string): Promise<SlotRecord | null>; list(planId?: PlanId): Promise<SlotRecord[]>;
  /** Removes only marked slots of completed/aborted plans, or unknown plans after 7 d; never follows links; reports unmarked dirs */
  gc(isFinished: (planId: PlanId) => Promise<boolean | null>): Promise<{ removed: string[]; reported: string[] }>;
}

export interface IntegrationListener { onIntegrated(taskId: TaskId): void; onConflict(taskId: TaskId): void; onFailed(taskId: TaskId): void;
  onReverted(taskId: TaskId): void; onGate(phaseId: PhaseId, gate: GateState): void; onInbox(item: InboxItem): void }   // called after the fsync
export interface IntegrationQueue {                  // 3.2
  /** pre: each id is verified with slot and branch. Idempotent (an id already queued or integrating is ignored). Does not dequeue while the plan is paused.
   *  Dequeue journals verified→integrating (durable) before any git step. err E_PLAN_STATE, E_DISPOSED */
  enqueue(taskIds: readonly TaskId[]): void;
  /** Must run before the first dequeue after open/recovery. For each integrating task: if its rebased tip is an ancestor of the integration branch → integrated;
   *  otherwise roll back git and keep the task integrating, at the front of the queue. Idempotent. */
  resume(): Promise<{ completed: TaskId[]; rolledBack: TaskId[] }>;
  checkPhase(phaseId: PhaseId): Promise<void>;   // starts the phase suite when §3.3's precondition holds; idempotent
  land(): Promise<{ landed: boolean; inbox: InboxItem | null }>;   // ff-when-clean or manual; never force, never non-ff
  /** Stops dequeuing, rolls back the step in progress, then journals integrating→cancelled. */
  abort(): Promise<void>;
  queued(): readonly TaskId[]; dispose(): Promise<void>;
}

export interface LeaseView { holder(path: string): { taskId: TaskId | null; sessionID: string } | null }
export interface TaskRoute { agent: string; model: { providerID: string; modelID: string; variant: string | null }; provider: string; heavy: boolean }
export interface CapacityView { routeOf(task: TaskNode): TaskRoute; free(provider: string, heavy: boolean): number }
export interface ScheduledTask { taskId: TaskId; route: TaskRoute; bottomLevelMs: number }
export interface Scheduler {                         // 3.1.2; pure, deterministic, never throws for a valid ledger
  /** Tasks that are ready, not manual/preflight, not in inFlight, in an unpaused phase of a running plan, with every edge satisfied
   *  (task source integrated|done; gate source passed), R16, no held predicted write (soft), within free capacity counted down greedily.
   *  Order: bottom level desc, ties by plan order. */
  readySet(ledger: LedgerV1, inFlight: ReadonlySet<TaskId>, leases: LeaseView, capacity: CapacityView): ScheduledTask[];
  promotable(ledger: LedgerV1): { toReady: TaskId[]; unblock: TaskId[] };    // pending→ready and blocked→ready candidates
  manualReady(ledger: LedgerV1): TaskId[];
  /** Returns the learned edge to append, or null if it exists or would make a cycle (then R6: lease-unresolvable) */
  addLearnedEdge(ledger: LedgerV1, holder: TaskId, blocked: TaskId, evidence: string): Edge | null;
}

export interface HostError { type: string; status: number | null; message: string }
export interface ProviderSignal { source: "retry-hook" | "retry-scheduled" | "step-failed" | "execution-failed"; sessionID: string;
  stepKey: string; provider: string; error: HostError; at: IsoTime }
export interface CapacityController {                // 3.1.3 (D13 495-535)
  limit(provider: string): number;                   // 1..maxParallel
  canAcquire(provider: string, heavy: boolean): boolean;
  acquire(provider: string, heavy: boolean, taskId: TaskId, attempt: number): { id: string };   // err E_CAPACITY
  release(token: { id: string }, result: "success" | "other"): void;   // idempotent; growth only after a quiet cooldown
  /** Dedupe per stepKey. The first rate-limit/overload signal of a step halves the limit (floor 1) and holds it for cooldown; quota → pause.
   *  Returns the inbox input for the runtime to raise once per pause. */
  onSignal(s: ProviderSignal): { decreased: boolean; pausedUntil: IsoTime | null; inbox: Omit<InboxItem, "id" | "createdAt" | "answer"> | null };
  /** True only when planChild and (provider paused or the step's first retry signal is older than capacityCooldownMs). */
  shouldStopRetry(i: { sessionID: string; stepKey: string; provider: string; planChild: boolean }): boolean;
  pausedUntil(provider: string): IsoTime | null; snapshot(): JsonValue;
}
export function classifyProviderError(e: Pick<HostError, "type" | "status">): "rate-limit" | "overload" | "quota" | null;  // type decides; unknown 429/529 by status
export function executionFailureOutcome(e: HostError): "capacity" | "failed";   // R3
```

```ts
// ---- TaskLauncher (3.1.5; launcher A only, ADR D14 548-645)
export interface RetainedContextInfo { sessionID: string; callID: string; messageID: string; agent: string;
  capturedAt: IsoTime; epoch: number /* +1 per capture in this process */ }
export type LaunchGate =
  | { ok: true; context: RetainedContextInfo; ageMs: number }
  | { ok: false; reason: "no-context" | "awaiting-first-router-call" /* guard 6 */ | "context-stale" /* guard 2 */ | "disposed";
      wake: { reason: "stale-context"; stateKey: string /* "stale-context:<epoch>" */ } | null /* guard 3 */ };
export interface LaunchRequest { planId: PlanId; taskId: TaskId; attempt: number; nonce: string; orchestratorSessionID: string;
  contextEpoch: number; route: TaskRoute; role: string; grant: string[] /* route `needs` */; workRoot: string /* slot path */;
  prompt: string /* §7 grammar; the header must match (planId, taskId, attempt, nonce) */ }
export interface LaunchHooks {
  /** Called inside onCreated after the binding (role, grant, workRoot) is written and before the child is prompted.
   *  The runtime journals attempt-child + dispatched→running (fsync). A throw aborts the launch → ChildEnd lost(runner-error). */
  onChildCreated(childSessionID: string): Promise<void>;
  /** A child created after the confirmation timeout (R4): "adopt" only if this attempt is still the latest and the task is ready. */
  onLateChild(childSessionID: string): Promise<"adopt" | "refuse">;
}
export type LaunchConfirmation =
  | { kind: "confirmed"; childSessionID: string; latencyMs: number }
  | { kind: "unconfirmed"; reason: "timeout" | "threw"; error: string | null; taskError: boolean /* R1 */ };
export type ChildEnd =
  | { kind: "completed"; childSessionID: string; text: string; endedAt: IsoTime }
  | { kind: "failed"; childSessionID: string; error: HostError; endedAt: IsoTime }
  | { kind: "capacity"; childSessionID: string; error: HostError; endedAt: IsoTime }
  | { kind: "interrupted"; childSessionID: string | null; reason: CancelReason; endedAt: IsoTime }
  | { kind: "lost"; childSessionID: string | null; reason: "unconfirmed" | "unrequested-interrupt" | "runner-error" | "restart"; endedAt: IsoTime };
export type CancelReason = "abort" | "blocked" | "superseded" | "dispose";
export interface LaunchHandle { taskId: TaskId; attempt: number; nonce: string; contextEpoch: number; contextAgeMs: number; startedAt: IsoTime;
  confirmation: Promise<LaunchConfirmation>;   // settles within LAUNCH_CONFIRM_TIMEOUT_MS (Clock)
  completion: Promise<ChildEnd> }              // settles exactly once; never rejects
export interface TaskLauncher {
  /** Pure read of in-memory state. ok only with a capture from `orchestratorSessionID` taken in this process (guard 6) whose epoch is not stale. */
  gate(orchestratorSessionID: string): LaunchGate;
  /** pre: gate ok for req.contextEpoch; the task is dispatched with its open attempt fsynced; the capacity token, slot and leases are held.
   *  Does: the decision row, recordDispatchStart and the D2 in-flight registration (DispatchBookkeeping); then ChildRunner.run with detached:true,
   *  an executor-owned AbortController (combined with the plugin lifetime), explicit agent and model, cwd = workRoot. Emits the context-age metric.
   *  Unconfirmed or threw-before-confirm → markStale(epoch) unless taskError. Classifies the end: runner result → completed; else the terminal
   *  session.execution.* event (waits ≤ CHILD_END_GRACE_MS): failed → executionFailureOutcome; interrupted → `interrupted` if cancel() was called,
   *  else `lost` (guard 5); no event → lost(runner-error). The fallback trigger (D2): a terminal event before the runner settles resolves completion,
   *  with text from HostSessions.context (last assistant message).
   *  err (synchronous, before any host call): E_NO_CONTEXT (gate not ok / epoch mismatch), E_INVALID_INPUT (header mismatch) */
  launch(req: LaunchRequest, hooks: LaunchHooks): LaunchHandle;
  /** Requested interrupt: records the request, aborts the executor-owned signal, HostSessions.interrupt(child) if known. Idempotent. */
  cancel(taskId: TaskId, attempt: number, reason: CancelReason): Promise<void>;
  inFlight(): ReadonlyArray<{ taskId: TaskId; attempt: number; childSessionID: string | null; startedAt: IsoTime }>;
  dispose(): Promise<void>;   // aborts every owned signal; journals nothing (recovery closes those attempts as lost)
}
```

The six D14 guards (619-634) and where the contract expresses them:

| Guard | Expressed by |
|---|---|
| 1. Confirmation | `LAUNCH_CONFIRM_TIMEOUT_MS` and `confirmation` |
| 2. Stale context | `unconfirmed`, then `gate().reason = "context-stale"` and the `launch-lost` row |
| 3. Refresh wake | `gate().wake` with a per-epoch `stateKey` |
| 4. Recorded age | `contextAgeMs` and the `context-age` metric |
| 5. Unexpected interrupt | `ChildEnd.lost("unrequested-interrupt")` |
| 6. After a restart | `"awaiting-first-router-call"` |

The rule "never the retained `signal`, never forward `progress`" is expressed by `ChildRunRequest.detached: true` (§9).

```ts
export interface Waker { wake(reason: WakeReason, stateKey: string): Promise<"sent" | "debounced" | "duplicate" | "failed"> }
// Journals `wake` (durable), then HostSessions.synthetic({…, resume: true}); debounced by wakeDebounceMs; never the same stateKey twice (D15 668-671).

export interface ExecutorRuntime {                   // 3.1.6; consumed by 4.1 (tool/command) and 5.1
  compile(i: { path: string; phases?: PhaseId[]; doneBefore?: PhaseId; sessionID: string }): Promise<{ planId: PlanId; summary: CompileSummary; residuePrompt: string | null }>;
  residue(planId: PlanId, text: string, sessionID: string): Promise<CompileSummary>;
  approve(planId: PlanId, sessionID: string): Promise<void>;          // awaiting-approval → running; config snapshot; slotsDir resolved
  status(planId: PlanId | null, sessionID: string): Promise<string>;  // the full board with Appendix D metrics
  ready(planId: PlanId): Promise<{ launchable: TaskId[]; manual: TaskId[] }>;
  addTasks(planId: PlanId, text: string, sessionID: string): Promise<{ added: TaskId[]; reopened: TaskId[] }>;
  answer(planId: PlanId, inboxId: string, text: string, sessionID: string): Promise<void>;
  done(planId: PlanId, taskId: TaskId, sessionID: string): Promise<void>;   // manual/preflight in ready only; else E_INVALID_INPUT
  pause(planId: PlanId, sessionID: string): Promise<void>; resume(planId: PlanId, sessionID: string): Promise<void>;
  abort(planId: PlanId, sessionID: string): Promise<void>;  // children cancelled after the fsync; queue.abort(); terminal states untouched
  land(planId: PlanId, sessionID: string): Promise<void>; adopt(planId: PlanId, sessionID: string): Promise<void>;
  gc(): Promise<{ removed: string[]; reported: string[] }>; exportPlan(planId: PlanId): Promise<string>;
  purge(planId: PlanId, sessionID: string): Promise<void>;  // completed/aborted only: gc, deleteRefs omr/<planId>/, LedgerStore.remove
  // Host feeds (3.1.7 wiring). Never throw into the host.
  onRouterToolCall(sessionID: string): void;               // refresh after capture; lifts guard 6; re-evaluates the ready set
  onHostEvent(e: HostSessionEvent): void;
  onRetryHook(i: { sessionID: string; stepKey: string; error: HostError }): { stop: boolean };   // stop only for plan children
  onChildEnd(taskId: TaskId, attempt: number, end: ChildEnd): Promise<void>;   // also used by RecoveryService; ignores closed attempts
  planLine(sessionID: string): string | null;              // the Appendix B plan line (+ the stale suffix, 4361-4362)
  start(): Promise<void>; dispose(): Promise<void>;
}
// Every action on a plan whose orchestrator is another live session → E_NOT_OWNER. Wrong status → E_PLAN_STATE.

export interface RecoveryService {                   // 4.2.4 (D16 679-707)
  /** Once per process; only ledgers in running|paused with repo.toplevel === this session's toplevel. Second call is a no-op. */
  recover(): Promise<Array<{ planId: PlanId; actions: ReconcileAction[] }>>;
  /** Takes over a stale lock and journals orchestrator-bound(adopt); the launch gate then waits for that session's first router call. err E_LOCK_HELD */
  adopt(planId: PlanId, sessionID: string): Promise<void>;
}
export interface ReconcileAction { taskId: TaskId; from: TaskState; evidence: "finished" | "alive" | "lost" | "none";
  action: "adopt" | "process-result" | "requeue-lost" | "reverify" | "re-enqueue" | "resume-integration" | "interrupt-orphan" | "none" }
```

Recovery matrix (the ledger state comes first, then the evidence about the latest attempt's child from `HostSessions`):

| Ledger state | Child evidence | Action |
|---|---|---|
| `ready` | alive, latest attempt `lost`, header nonce matches | **Rebind first** (the binding table lives in memory), then `attempt-adopted` + `ready→running` |
| `dispatched` or `running` | finished | `onChildEnd` once (D2 dedupe); a `dispatched` task first goes `→running` |
| `dispatched` or `running` | alive | rebind; `→running` if dispatched; completion arrives through events |
| `dispatched` or `running` | neither finished nor active, or no child recorded | `attempt-ended lost`; reset the slot; `→ready` |
| `completed` | — | commit idempotently, then `→verifying` |
| `verifying` | — | re-run verification (no transition) |
| `verified` | — | re-enqueue |
| `integrating` | — | `queue.resume()` |
| any other state | a live child exists | interrupt the orphan |

Slots are checked against their markers, and `until-integrated` leases are rebuilt for every task that holds a slot.

```ts
export interface UnattendedPolicy {                  // 4.2.2
  /** Dedupe: an open item with the same kind+taskId+text is returned instead. Journals inbox-added (durable); wakes ("inbox", "inbox:<id>") unless closed at creation. */
  raise(i: Omit<InboxItem, "id" | "createdAt" | "answer"> & { answer?: string }): Promise<InboxItem>;
  /** From running (escalate|ambiguity|qa-unparsable) or conflict|failed|reverted (exhausted). post: parked; transitive dependents → blocked
   *  (their in-flight children cancelled); one inbox item. */
  park(taskId: TaskId, cause: "escalate" | "ambiguity" | "qa-unparsable" | "exhausted", text: string): Promise<InboxItem>;
  /** pre: item open. post: inbox-answered; attempt-context on the latest attempt; parked → ready. err E_INVALID_INPUT */
  answer(inboxId: string, text: string): Promise<{ resumed: TaskId | null }>;
  unblock(): Promise<TaskId[]>;                      // blocked → ready where every dependency is integrated|done
  /** Feeds a counted attempt (§4). A trip pauses the phase, raises one critical breaker item and wakes once. */
  recordAttempt(phaseId: PhaseId, a: Attempt): Promise<{ tripped: boolean }>;
}
export interface QaLoop {                            // 4.2.3
  parse(text: string): { ok: true; report: FindingsReport } | { ok: false; error: string };   // pure; extraction rule in §7
  /** pre: the qa task is done; gate qa-running. post: §3.3 (passed | pending with fix and re-review tasks created and edges added, round+1
   *  | cap reached → qa-cap critical item and phase paused); deferred minor/nit findings recorded as closed info items. Fix tasks of one round have disjoint writes. */
  onQaResult(taskId: TaskId, report: FindingsReport): Promise<"passed" | "next-round" | "cap-reached">;
  onAwaitingQa(phaseId: PhaseId): Promise<void>;   // a phase with no qa task → passed
}
```

**Adapters over existing modules.** These are in-process, not I/O, and doubles stand in for them in tests:
- `RouteResolver.route(task): TaskRoute` (the routing kernel);
- `RoleBindings.bind({childSessionID, role, agent, workRoot, grant})` (binding.ts);
- `LeaseService` (2.1, scope `until-integrated`), which provides `LeaseView`;
- `DispatchBookkeeping {decisionRow, recordDispatchStart, registerInFlight, unregisterInFlight}`;
- `SlotVerifier.verify(task, slot, attempt): Promise<{verdict: Verdict; findings: string; ref: string}>`.

## 9. Seams (no real I/O in unit tests)

```ts
export interface Clock { now(): number; iso(ms?: number): IsoTime; setTimer(ms: number, fn: () => void): { readonly id: number };
  clearTimer(h: { readonly id: number }): void; randomHex(bytes: number): string /* the only entropy source (nonce) */ }
export interface ProcessResult { code: number | null; signal: string | null; stdout: string; stderr: string; truncated: boolean; durationMs: number }
export interface ProcOpts { cwd: string; timeoutMs: number; env?: Readonly<Record<string, string>>; stdin?: string; maxOutputBytes?: number; signal?: AbortSignal }
export interface GitRunner { run(args: readonly string[], o: ProcOpts): Promise<ProcessResult> }   // no shell; a non-zero exit is a result; throws only spawn/ETIMEDOUT/EOUTPUT
export interface Spawner { run(command: string, args: readonly string[], o: ProcOpts): Promise<ProcessResult>;   // never a shell
  readonly pid: number; readonly hostname: string; isAlive(pid: number): boolean }                  // lock staleness (2.2.2.e)
export interface FsStat { kind: "file" | "dir" | "symlink" | "junction" | "other"; size: number; mtimeMs: number }
export interface FileSystem {   // errors carry .code (ENOENT, EEXIST, EPERM, EBUSY…); the 2 s EPERM/EBUSY retry belongs to the caller
  readText(p: string): Promise<string>; writeText(p: string, data: string, o?: { exclusive?: boolean; fsync?: boolean }): Promise<void>;
  appendText(p: string, data: string, o: { fsync: boolean }): Promise<void>; rename(a: string, b: string): Promise<void>;
  rm(p: string, o: { recursive: boolean }): Promise<void>; mkdir(p: string): Promise<void>; readdir(p: string): Promise<string[]>;
  lstat(p: string): Promise<FsStat | null>; realpath(p: string): Promise<string>; fsyncDir(p: string): Promise<void> }
export interface HostSessionContext { messages: Array<{ role: "user" | "assistant" | "idle"; text: string | null; outcome: string | null }> }
export type HostSessionEvent =
  | { type: "step.started"; sessionID: string; providerID: string; modelID: string; at: IsoTime }
  | { type: "retry"; sessionID: string; stepKey: string; source: "hook" | "scheduled"; error: HostError; at: IsoTime }
  | { type: "step.failed" | "execution.failed"; sessionID: string; error: HostError; at: IsoTime }
  | { type: "execution.interrupted" | "execution.completed"; sessionID: string; at: IsoTime };
export interface HostSessions {   // O6b/C7: context, interrupt, synthetic; move and get as used in v2-client.ts:129,198
  get(sessionID: string): Promise<{ id: string; parentID: string | null } | null>;
  context(sessionID: string): Promise<HostSessionContext>;
  activity(sessionID: string): Promise<"active" | "inactive" | "unknown">;
  interrupt(sessionID: string): Promise<void>;
  synthetic(i: { sessionID: string; text: string; description: string; metadata: Record<string, JsonValue>; resume: true }): Promise<void>;
  move(sessionID: string, directory: string): Promise<void>;
  onEvent(listener: (e: HostSessionEvent) => void): () => void;
}
export interface ChildRunRequest { parentSessionID: string; prompt: string; agent: string;
  model: { providerID: string; modelID: string; variant: string | null }; cwd: string; signal: AbortSignal /* executor-owned */;
  detached: true;   // QA-0.1-25: the runner must NOT add the retained toolContext.signal and must NOT forward progress, even while that call is active
  onCreated(childSessionID: string): Promise<void>; onConfirmed?(childSessionID: string): Promise<void> }
export interface ChildRunner {
  run(r: ChildRunRequest): Promise<{ sessionID: string; text: string }>;
  dispose(sessionID: string): Promise<void>;
  retainedContext(sessionID: string): RetainedContextInfo | null;   // the newest router-tool capture of that session in this process
  onContextCaptured(listener: (c: RetainedContextInfo) => void): () => void;
}
```

## 10. Serialization rules

- Ledger data, events, markers and the config snapshot hold only `JsonValue`:
  - no functions, Maps, Sets, Dates, `undefined`, `bigint`, NaN or Infinity;
  - times are `IsoTime` strings;
  - durations are integer milliseconds;
  - git ids are lowercase hex.
- Interfaces may take `AbortSignal` and callbacks; those never reach ledger data.
- `JSON.parse(JSON.stringify(x))` deep-equals `x` for every ledger value (1.4.4 checks this on the fuzz corpus).

## 11. Flags for other phases, and plan text that is superseded

1. **v2-client.ts must change in 3.1.5.**
   - Today the runner adds `toolContext.signal` while the retained call is still active (`src/compat/v2-client.ts:115-119`) and forwards `progress` (204-207). `detached: true` must turn both off.
   - Retained contexts carry no capture time and are evicted least-recently-used (249-256). 3.1.5 must add `capturedAt` and an epoch, and must not evict the bound orchestrator's context (or must treat eviction as `no-context` and wake).
2. **Superseded plan text:**
   - 3.1.4.a order (2898-2905) → §7 (QA-0.1-21);
   - "new attempt record of outcome lost" in D16 (689) and 4.2.4.a (3543-3544) → R2;
   - "culprit parked" (3259) → R11.
3. **2.2:** journal rotation deletes old events (2211-2214), but Appendix D metrics need history (4408-4420). Recommendation: keep `metric` and `integration-step` lines in a separate journal that is never rotated away, so `export` stays complete.
4. **Runaway uncounted attempts** (`lost` or `capacity` repeating). Recommendation for 3.1 and 4.2: after 3 consecutive `lost` attempts of one task, pause that task's phase and raise a `failure` item. This uses existing fields only.
5. **No-change completion.** `completed → done` with no changes skips verification (3.1.6.b). Recommendation: when `footprint.writes` is non-empty and `verify` is `required`, treat it as `completed → failed` (trigger `commit-failed`, detail "no changes").
6. **4.2 must pin the source of `HostSessions.activity`.** ADR D16 says "from its active state" but names no API. I did not see one verified in what I read.

## 12. What 1.4.4 must test

- **Transitions:** all 256 (from, to) pairs against §3.1, which has exactly 47 legal pairs, and every legal pair has at least one trigger.
- **Terminal states:** `done` and `cancelled` have no exits; `integrated` exits only to `reverted`.
- **`verified` can't be skipped:** the breadth-first search from §3.1's rules finds no path to `integrated` with `verified` removed.
- **Gate and status tables**, cell by cell.
- **Counting:** `countsTowardMaxAttempts` for each outcome, and `executionFailureOutcome` for quota, 429, 529, an unknown type with 429, and others.
- **Launch header:** `formatLaunchHeader` / `parseLaunchHeader` round trip; integer-like task ids rejected.
- **Guard fuzzing:** at least 200 malformed ledgers rejected (missing fields, wrong types, `schema: 2`, `maxParallel: 9`, broken §7 invariants); unknown extra fields preserved.
- **Findings:** `FINDINGS_FORMAT` and `isFindingsReport`.
- **Test doubles:** one typed double for each interface in §8 and each seam in §9, each used once.


### 1.4.1-A1 Contract addendum (binding; resolves QA-1.4 round 1 at `168a25c`; architect, heavy pin, `ses_ed689bce6ffeVMf77avXeJC2cu`)

**Precedence:** A1 amends memo 1.4.1; where they conflict, A1 wins. It adds no `TaskState`, no task transition and no field to Appendix A's data; it adds one gate edge, event fields, events and interface members.

Event abbreviations: AS `attempt-started`, AC `attempt-child`, AA `attempt-adopted`, AE(o) `attempt-ended`, AV `attempt-verdict`, AX `attempt-context`, TT `task-transition`, TS(s,b) `task-slot` (TS(null) releases the slot, keeps the branch), TF `task-footprint` (new), TI `task-integrated`, IH `integration-head`, ISS/ISE `integration-step` start/end, G `gate-changed`, PP `phase-paused`, IA `inbox-added`, IAn `inbox-answered`.

#### A1-0 Summary

| Finding | Decision |
|---|---|
| QA-1.4-1 (critical) | The gate follows the qa task: G1 on dispatch/adopt, G2 whenever the qa task leaves flight without a parsed result. Snapshot invariant `qa-gate`. Recovery resumes a pending QA result from the stored report. |
| QA-1.4-2 | Every event carries `batch` and `last`; the loader drops a trailing incomplete batch; per-event preconditions in order, whole-ledger invariants only at batch end; in-batch order fixed (A1-2.4). |
| QA-1.4-3 | Open integration entries rebuilt from a never-rotated history journal; `resume()` reconciles the branch tip first, then each entry kind. |
| QA-1.4-4 | `ContextRef {bootID, epoch, callID}` on `ChildRunRequest`, `LaunchRequest`, `LaunchHandle`; mismatch throws `ContextSupersededError` before any host call; `launch-lost`, not stale. |
| QA-1.4-5 | One launch-failure table (A1-5); `taskError` → `reason` enum; `E_LAUNCH_TASK` has producers; `onChildCreated` the single journaling point; `onLateChild` only decides. |
| QA-1.4-6 | Keys carry a per-process `bootID`; every non-ok gate reason except `disposed` has a wake; dedupe source = the plan's `wake` events (history + this writer). |
| QA-1.4-7 | Cap item offers `accept`/`fix`; new gate edge `awaiting-qa → pending` (`cap-fix`, QaLoop); `awaiting-qa → passed` blocked while a cap item is open. |
| QA-1.4-8 | Enumerated invariants with codes via `ledgerViolations()`; new patterns for phase ids, inbox ids, git ids, absolute paths. |
| QA-1.4-10 | Strict position-based `parseLaunchHeader(prompt, sharedContext)`; `sharedContext` may not contain a header-shaped line; loose `looksLikePlanPrompt` only for the fail-closed check. |
| QA-1.4-13 | Slot+leases and token columns on every row (A1-2.4); leases held exactly while `slot !== null`. |
| QA-1.4-14 | `qaUnparsableCount(t)` from the context prefix; the R12 retry never bypasses `maxAttempts`. |
| QA-1.4-16 | Read-only exemption; no signature change. |
| QA-1.4-17 | `ref` journal-only, kept in history; learned footprints get a `task-footprint` event. |
| QA-1.4-18 | History journal + a binding `exportPlan` merge rule. |
| QA-1.4-19 | A draft carries `seq: 1`; `create` enforces it; `draft-replaced` sets `seq` through its own event. |
| QA-1.4-20 | Dequeue only while the plan is running and the task's phase is not paused; abort order: latch, `queue.abort()`, one Rt batch, cancel children. |

#### A1-1 QA gate, rounds, cap and unparsable output (QA-1.4-1, -7, -14)

Rules (replace R12, R16 and memo §3.3 rows):
- **QA1 rounds.** `PhaseRecord.qaRound` is the 1-based current round (compile sets 1); only `qa-next-round` and `cap-fix` change it (+1 each); `gate-changed.qaRound` is the value after the change. Round 1's qa task is the plan's qa task of the phase; round r ≥ 2's is `reviewTaskId(phaseId, r)` = `${phaseId}.QA${r}`; fix tasks from round r findings are `fixTaskId(phaseId, r, k)` = `${phaseId}.FIX${r}-${k}`.
- **QA2** at most one `qa` task outside {done, cancelled} per phase (compile `validate`: `qa-multiple`).
- **QA3 G1 (`qa-dispatched`):** `gate-changed awaiting-qa→qa-running` in the same batch as a qa task's `ready→dispatched` (launch) or `ready→running` (adopt, incl. recovery).
- **QA4 G2 (`qa-requeued`):** `gate-changed qa-running→awaiting-qa` in the same batch as a qa task leaving {dispatched, running} for anything but `completed`: `launch-lost`/`launch-task-error`; `running→failed|parked|ready` (any trigger); `→blocked`. `→cancelled` writes no G2.
- **QA5 parsed result:** Rt writes one batch AE(succeeded), AX(`canonicalFindingsJson(report)`), TT `running→completed` (`child-ended`), TT `completed→done` (`no-changes`), TS(null); gate stays `qa-running`; a qa task never commits; then `QaLoop.onQaResult` writes one batch (A1-1.3). "Result pending" = gate `qa-running` and no qa task of the phase in flight.
- **QA6 R12 restated:** c = `qaUnparsableCount(task)` before this attempt's context. c = 0 → row 16: AE(failed), AX(`QA_UNPARSABLE_CONTEXT_PREFIX + error`), TT `running→failed` (`qa-unparsable`), G2, then the ordinary decision (`failed→ready` iff `hasAttemptsLeft`, else P `failed→parked`). **R12 never bypasses `maxAttempts`.** c ≥ 1 → row 17 by P: AE(**failed**), AX(prefix+error), TT `running→parked` (`qa-unparsable`), TS(null), G2, IA(failure). An answer replaces the latest context (R13), so after an answer the count drops by one and the next unparsable output parks again immediately (intended).
- **QA7 R16:** `readySet` returns a qa task only while its phase gate is `awaiting-qa`; `promotable` may still move it `pending→ready`.
- **QA8 cap:** at the result of round r with any blocking/critical/major finding left: r < `qaMaxRounds` → `qa-next-round`; else `qa-cap`: G `qa-running→awaiting-qa`, PP(true, `"qa-cap"`), IA `{kind:"qa-cap", severity:"critical", taskId:<round-r qa task>, options: r < QA_ROUND_LIMIT ? ["accept","fix"] : ["accept"]}`; while open, `onAwaitingQa` is a no-op.
- **QA9 cap answers** via `UnattendedPolicy.answer` → `QaLoop.onCapAnswer`; trimmed lowercased answer must equal an option else `E_INVALID_INPUT`. `accept`: IAn, one IA per remaining finding `{kind:"qa-cap", severity:"info", answer:"deferred"}`, G `awaiting-qa→passed` (`cap-accepted`), PP(false). `fix`: IAn, G `awaiting-qa→pending` (`cap-fix`, qaRound+1), `task-created` for fix tasks (blocking/critical/major only) and the re-review task, `edge-added`, PP(false); findings from `QaLoop.parse(<round-r qa task>.attempts.at(-1).context)`.

Gate table (replaces memo §3.3; 12 pairs):

| From | To | Trigger(s) | Owner |
|---|---|---|---|
| pending | suite-running | `phase-integrated` | Q |
| pending | awaiting-qa | `phase-integrated` (`phaseSuite = off`) | Q |
| suite-running | awaiting-qa | `suite-passed` | Q |
| suite-running | suite-failed | `suite-culprit-found` | Q |
| suite-failed | pending | `culprit-reverted` | Q |
| suite-failed | suite-running | `suite-rerun` | Q |
| awaiting-qa | qa-running | `qa-dispatched` | Rt, Rc |
| awaiting-qa | passed | `no-open-qa` (no qa task outside {done, cancelled} and no open critical `qa-cap` item naming one of the phase's qa tasks); `cap-accepted` | QL |
| awaiting-qa | pending | `cap-fix` (new) | QL |
| qa-running | awaiting-qa | `qa-requeued`; `qa-cap` | Rt, P, Q (requeued); QL (cap) |
| qa-running | pending | `qa-next-round` | QL |
| qa-running | passed | `qa-clean` (no in-scope findings; at round ≥ 3 only minor/nit, deferred) | QL |

QaLoop batches (order binding): `qa-clean`: IA(deferred)…, G. `qa-next-round`: G (qaRound+1), task-created (fix… then re-review), edge-added…, IA(deferred)…. `qa-cap`: G, PP(true), IA(critical). `cap-accepted`/`cap-fix`: as QA9. `onQaResult` is idempotent: if the gate is no longer `qa-running`, it writes nothing and returns the outcome derived from the ledger.

Recovery additions: gate `qa-running` with no qa task in flight (result pending) → `QaLoop.onQaResult(t, parse(t.attempts.at(-1).context).report)` (t = latest done qa task); gate `awaiting-qa` → `QaLoop.onAwaitingQa(phaseId)`; a lost dispatched/running qa task → the usual row (Rt `onChildEnd(lost "restart")`) plus G2.

```ts
export const GATE_TRANSITIONS: Readonly<Record<GateState, readonly GateState[]>> = {
  pending: ["suite-running", "awaiting-qa"],
  "suite-running": ["awaiting-qa", "suite-failed"],
  "suite-failed": ["pending", "suite-running"],
  "awaiting-qa": ["qa-running", "passed", "pending"],
  "qa-running": ["awaiting-qa", "pending", "passed"],
  passed: [],
};
export type GateTrigger =
  | "phase-integrated" | "suite-passed" | "suite-culprit-found" | "culprit-reverted" | "suite-rerun"
  | "qa-dispatched" | "qa-requeued" | "qa-cap" | "qa-next-round" | "qa-clean" | "no-open-qa" | "cap-accepted" | "cap-fix";
export type GateTransitionKey = `${GateState}>${GateState}`;
export const GATE_TRANSITION_TRIGGERS: Readonly<Partial<Record<GateTransitionKey, readonly GateTrigger[]>>>;  // exactly 12 keys
export type GateOwner = TransitionOwner | "QL";
export const GATE_TRANSITION_OWNERS: Readonly<Partial<Record<GateTransitionKey, readonly GateOwner[]>>>;
export const QA_ROUND_LIMIT = 999;
export const FIX_TASKS_PER_ROUND_LIMIT = 999;
export function fixTaskId(phaseId: PhaseId, round: number, k: number): TaskId;   // E_INVALID_INPUT unless PHASE_ID_PATTERN, 1≤round≤QA_ROUND_LIMIT, 1≤k≤FIX_TASKS_PER_ROUND_LIMIT
export function reviewTaskId(phaseId: PhaseId, round: number): TaskId;            // 2 ≤ round ≤ QA_ROUND_LIMIT
export const QA_UNPARSABLE_CONTEXT_PREFIX = "QA OUTPUT UNPARSABLE: ";
export function qaUnparsableCount(t: TaskNode): number;
export function canonicalFindingsJson(r: FindingsReport): string;  // JSON.stringify({findings: r.findings.map(f => ({id, severity, files, problem, fix}))})
export const QA_CAP_OPTIONS = ["accept", "fix"] as const;
export type QaCapChoice = (typeof QA_CAP_OPTIONS)[number];
export interface QaLoop {
  parse(text: string): { ok: true; report: FindingsReport } | { ok: false; error: string };
  onQaResult(taskId: TaskId, report: FindingsReport): Promise<"passed" | "next-round" | "cap-reached">;
  onAwaitingQa(phaseId: PhaseId): Promise<void>;
  onCapAnswer(inboxId: string, choice: QaCapChoice): Promise<"passed" | "next-round">;
}
```
`gate-changed` gains `trigger: GateTrigger`; per-event check: `from === phase.gate`, `canGateTransition`, trigger listed for the pair, `qaRound === phase.qaRound + (trigger ∈ {qa-next-round, cap-fix} ? 1 : 0)`. `isPhaseRecord`: `1 ≤ qaRound ≤ QA_ROUND_LIMIT`.

#### A1-2 Batch framing, order and resources (QA-1.4-2, -13, -19)

```ts
type E<T extends string, P> = { seq: number; at: IsoTime; batch: number /* seq of the batch's first event */; last: boolean; type: T } & P;
export type ExecutorEventInput = DistributiveOmit<ExecutorEvent, "seq" | "at" | "batch" | "last">;
export type BatchBuilder = (ledger: Readonly<LedgerV1>) => readonly ExecutorEventInput[];
// gate-changed: { phaseId; from; to; trigger: GateTrigger; qaRound }
// integration-step: { edge; entry; step; result; detail; failingIds; closes: boolean }
// + task-footprint: { taskId: TaskId; footprint: Footprint }   (durable)
export interface LedgerWriter {
  readonly planId: PlanId; readonly ledger: Readonly<LedgerV1>;
  /** One batch. A builder runs synchronously inside the writer's serialization against the ledger the batch applies to; must be pure;
   *  [] appends nothing and resolves with the current ledger. Validation per A1-2.2; all lines in one appendText; fsync iff any
   *  isDurableEvent; then the history copy (A1-3). err E_ILLEGAL_TRANSITION (nothing written; detail = {batchIndex, eventIndex|null, codes}),
   *  E_LOCK_LOST, I/O */
  append(batch: readonly ExecutorEventInput[] | BatchBuilder): Promise<Readonly<LedgerV1>>;
  openIntegration(): readonly OpenIntegrationEntry[];
  snapshot(): Promise<void>; close(): Promise<void>;
}
```
All events of a batch share one `at`. The builder form allocates inbox ids (`formatInboxId(kind, nextInboxNumber(ledger))`), entry ids (`i-${ledger.seq + k}`, k = 1-based position of the entry's first ISS) and latest-attempt checks without races.

Load/append rules: (1) torn last line dropped with one warning; (2) framing: `seq` +1; first event of a file and any event after `last: true` has `batch === seq`; others share the previous `batch`; violation → `E_SEQ_GAP`; (3) a final complete line with `last: false` → the whole trailing batch dropped with one warning (`incomplete-batch`); (4) replay event by event with the per-event preconditions; at batch end `ledgerViolations(ledger)` must be `[]` else `E_ILLEGAL_TRANSITION`; whole-ledger invariants never mid-batch; (5) snapshots/rotation only at batch boundaries.

Per-event preconditions:

| Event | Precondition |
|---|---|
| `ledger-init` | `seq === 1`, alone in its batch, `ledger.seq === 1` |
| `draft-replaced` | status ∈ {compiling, awaiting-residue, awaiting-approval} |
| `status-changed` | `from === status`; `canStatusTransition` |
| `plan-approved` | status `awaiting-approval`; `config.slotsDir !== null`; followed in the same batch by `status-changed →running` |
| `task-created` | id absent; state `pending` or `done`; `attempts: []`; `slot === null` |
| `edge-added` | both endpoints exist |
| `task-transition` | `from === state`; `canTransition`; trigger ∈ `TRANSITION_TRIGGERS[key]` |
| `attempt-started` | state `ready`; no open attempt; `n === attempts.length + 1`; open shape; nonce unused by the task |
| `attempt-child` | state `dispatched`; n latest, open, `childSessionID === null` |
| `attempt-adopted` | state `ready`; n latest; its outcome `lost` |
| `attempt-ended` | state ∈ {dispatched, running}; n latest and open |
| `attempt-verdict` | state `verifying`; n latest; outcome `succeeded`; verdict null |
| `attempt-context` | `n === attempts.length ≥ 1` |
| `task-footprint` | new ⊇ old (writes, reads, sources) |
| `task-integrated` | state `integrating` |
| `gate-changed` | A1-1 |
| `phase-paused` | `paused` ≠ current |
| `inbox-added` | id per `INBOX_ID_PATTERN`, prefix = `INBOX_ID_PREFIX[kind]`, n > every existing n |
| `inbox-answered` | item open; critical `qa-cap`: answer ∈ options |

In-batch order and resources (binding). Default order: acquiring TS, TF, `edge-added`; attempt events; subject TT(s); releasing TS; dependents' rows; G; PP; IA/IAn. [G1]/[G2] only for `kind: "qa"`. Leases are held exactly while `task.slot !== null` (acquired with the slot, released with it, rebuilt by recovery from it). "acquire" = `SlotPool.acquire` + leases before the batch (release them if `append` fails); "release" = pool + lease release after the fsync (for a live child being cancelled: after its `completion` settles). Token: "acquire" before the batch, "release(r)" after the fsync, "force" = `acquire(…, {force: true})`.

| # | Row (trigger) | Batch, in order | Slot+leases | Token |
|---|---|---|---|---|
| 1 | pending→ready | TT | — | — |
| 2 | pending→blocked | TT (inside P's park/exhausted batch, or a spread batch) | — | — |
| 3 | pending→cancelled | TT | — | — |
| 4 | ready→dispatched (launch) | [TS(slot)] if changed, AS, TT, [G1] | acquire (or keep) | acquire |
| 4b | launch with task-class prep error (L1) | [TS], AS, TT ready→dispatched, AE(failed), AX(error), TT dispatched→failed (`launch-task-error`) | keep | release(other) |
| 5 | ready→blocked (`dep-reverted`, **Q**) | TT, TS(null) | release | — |
| 6 | ready→cancelled | TT, [TS(null)] | release | — |
| 7 | ready→running (adopt) | AA, TT, [G1] | keep (slot must be non-null, else refuse) | force |
| 8 | ready→done | TT | — | — |
| 9 | ready→pending (`dep-added`) | (task-created…, edge-added… of the same batch), TT, [TS(null)] | release | — |
| 10 | dispatched→running | AC, TT | keep | keep |
| 11 | dispatched→ready (`launch-lost`) | AE(lost), TT, [G2] | keep (R4) | release(other); a late adopt forces |
| 12 | dispatched→failed | AE(failed), AX, TT, [G2] | keep | release(other) |
| 13 | dispatched→blocked (**Q**) | AE(interrupted), TT, TS(null), [G2] | release after settle | release after settle |
| 14 | dispatched→cancelled | AE(interrupted), TT, TS(null) | release after settle | release after settle |
| 15 | running→completed | AE(succeeded), TT. qa: AE, AX(report), TT, TT completed→done (`no-changes`), TS(null) | keep; qa: release | release(success) |
| 16 | running→failed (`child-failed`, `lease-unresolvable`, `qa-unparsable` 1st) | AE(failed), AX, TT, [G2] | keep | release(other) |
| 17 | running→parked (P): escalate/ambiguity AE(interrupted); qa-unparsable 2nd AE(failed) | AE, AX, TT, TS(null), [G2], IA, then TT pending→blocked for each transitive pending dependent | release | release(other) |
| 18 | running→ready (`child-lost`: AE(lost); `capacity-stop`: AE(capacity)) | AE, [AX], TT, [G2] | keep | release(other) |
| 18b | running→ready (`lease-needed`) | AE(interrupted), AX, TT running→ready, TF, edge-added(learned), TT ready→pending (`dep-added`), TS(null), [G2] | release | release(other) |
| 19 | running→blocked (**Q**) | AE(interrupted), TT, TS(null), [G2] | release after settle | release after settle |
| 20 | running→cancelled | AE(interrupted), TT, TS(null) | release after settle | release after settle |
| 21 | completed→verifying | TS(slot, branch), TT | keep | — |
| 22 | completed→done | TT, TS(null) | release | — |
| 23 | completed→failed | AX, TT | keep | — |
| 24 | completed→cancelled | TT, TS(null) | release | — |
| 25 | verifying→verified | AV(pass), TT | keep | — |
| 26 | verifying→failed | AV(fail \| unverifiable), AX, TT | keep | — |
| 27 | verifying→cancelled | TT, TS(null) | release after verification stops | — |
| 28 | verified→integrating (Q) | TT for each task of the entry, ISS(first step) | keep | — |
| 29 | verified→cancelled | TT, TS(null) | release | — |
| 30 | integrating→integrated (Q) | ISE(fast-forward ok, closes), IH, then per task in entry order: TI, TT, TS(null) | release | — |
| 31 | integrating→conflict (Q) | ISE(rebase conflict), AX, TT | keep | — |
| 32 | integrating→failed (Q) | ISE(checks \| batch-checks \| bisect failed), AX, TT | keep | — |
| 33 | integrating→cancelled (Q) | ISE(rollback rolled-back, closes), TT, TS(null) | release | — |
| 34 | integrated→reverted (Q) | ISE(revert-fast-forward ok, closes), IH, AX, TT, then R9 dependents as rows 5/13/19 | — | dependents per 13/19 |
| 35 | conflict\|failed→ready (retry) | TT | keep | — |
| 35b | reverted→ready (retry) | TT | — | — |
| 36 | conflict\|failed\|reverted→parked (P) | TT, [TS(null)], IA, pending dependents→blocked | release | — |
| 37 | parked→ready (P) | IAn, AX(answer), TT | — | — |
| 38 | blocked→ready (P) | TT | — | — |
| 39 | completed\|failed\|conflict\|reverted\|parked\|blocked→cancelled | TT, [TS(null)] | release | — |

ISE `closes: true` when no task of the entry remains `integrating` and the entry has no further step. **Owner changes:** `TRANSITION_OWNERS["ready>blocked" | "dispatched>blocked" | "running>blocked"] = ["Q"]` (a revert and its dependents are one Q batch; Rt cancels the children from `IntegrationListener.onReverted` after the fsync). Retry/exhausted decisions (rows 35-36) are a separate batch right after rows 12, 16, 23, 26, 31, 32, 34; recovery adds: `failed`, `conflict`, `reverted` → apply the retry/exhausted decision (idempotent).

Draft `seq` (QA-1.4-19): `PlanCompiler.compile` returns a draft with `seq: 1`; `LedgerStore.create` rejects any other value (`E_SCHEMA_INVALID`); `ledger-init` = `{seq: 1, batch: 1, last: true, ledger: draft}`. `mergeResidue`'s draft `seq` is ignored: the runtime journals `draft-replaced` (payload excludes `seq`) and `ledger.seq` becomes that event's `seq`.

#### A1-3 Integration resume and the history journal (QA-1.4-3, -18, part of -17)

- `history.jsonl` in the plan dir: append-only, never rotated; byte-identical copies of every main-journal line with `isHistoryEvent` true (`metric`, `integration-step`, `attempt-verdict`, `wake`). The main journal is the authority; a copy is written after it and never for an incomplete batch; at open, history is repaired from the main journal (append every history-class event with `seq` > history's last); rotation requires history synced through the snapshot's `seq`. The store derives `openIntegration()` from history at open and updates it on every append.
- Entry rules (checked at open over history): an entry starts with ISS whose `entry.id === "i-" + seq`; a step's start requires the previous step's end; an end matches the open step; exactly one event per entry has `closes: true` (an end), nothing after it; `kind`, `phaseId`, `baseHead` fixed; `taskIds`, `candidate` may change (latest wins); ISS of `fast-forward`, `revert-fast-forward`, `tag`, `land` carries the target commit in `entry.candidate`.

```ts
export type HistoryEventType = "metric" | "integration-step" | "attempt-verdict" | "wake";
export function isHistoryEvent(e: { type: string }): boolean;
export interface IntegrationEntry { id: string; kind: "task" | "batch" | "revert" | "phase-suite" | "tag" | "land";
  phaseId: PhaseId | null; taskIds: TaskId[]; slot: string | null; baseHead: string; candidate: string | null }
export interface OpenIntegrationEntry { entry: IntegrationEntry; startSeq: number; step: IntegrationStep;
  edge: "start" | "end"; result: IntegrationStepResult | null }
export interface ResumeReport { completed: TaskId[]; rolledBack: TaskId[]; halted: boolean;
  entries: Array<{ id: string; kind: IntegrationEntry["kind"]; action: "completed" | "rolled-back" | "rerun" | "tagged" | "none" }> }
// IntegrationQueue.resume(): Promise<ResumeReport>
```

`resume()` runs once per plan before the first dequeue, whatever the task states (replaces the recovery row "`integrating` → `queue.resume()`"). Step 0 head reconciliation: tip = `rev-parse refs/heads/<integration.branch>`; tip = head → continue; tip ≠ head, head ancestor of tip, and an open entry's open/last step is `fast-forward`/`revert-fast-forward` with `candidate === tip` → complete it (journal the row 30 / 34 batch); otherwise no git action, journal [`status-changed →paused` (`"integration-branch-moved"`), IA(failure, critical)], return `halted: true`. Step 1 open entries oldest first: task/batch with an open rebase/checks/batch-checks/bisect/fast-forward (not landed) → reset the entry's slot, ISE(rollback, rolled-back, closes), tasks still `integrating` to the queue front in entry order (tasks a partial batch already integrated stay integrated); revert → discard the revert slot, ISE(rollback, rolled-back, closes), rerun the revert (gate still `suite-failed`); phase-suite → ISE(rollback, rolled-back, closes), `checkPhase` reruns; tag → ref `omr/<planId>/phase-<id>` at `candidate` → [ISE ok closes, `phase-tagged`], else create it then the same; land → base tip = `candidate` → ISE(land ok, closes), else ISE(land rolled-back, closes) and `land()` again iff status `completed` and `land = ff-when-clean`; any with open rollback → redo it (idempotent), then as above. Recovery: gate `pending` → `queue.checkPhase`; an `integrating` task with no open entry → load error `E_ILLEGAL_TRANSITION` (`integrating-without-entry`).

`exportPlan` (binding): `snapshot` = current ledger; `events` = every history event since seq 1 merged with every event of the current main journal, deduplicated by `seq`, ascending; no lock; torn last lines dropped. Only history-class events are guaranteed back to seq 1.

#### A1-4 Child run pinned to the gated context (QA-1.4-4)

```ts
export interface ContextRef { bootID: string /* 16 lowercase hex, random once per process, owned by ChildRunner */; epoch: number; callID: string }
export interface RetainedContextInfo { sessionID: string; callID: string; messageID: string; agent: string; capturedAt: IsoTime;
  bootID: string; epoch: number }
export interface ChildRunRequest { /* … */ context: ContextRef }   // new, required
export interface ChildRunner { readonly bootID: string; /* … */ }
export class ContextSupersededError extends Error {
  readonly requested: ContextRef; readonly current: ContextRef | null;
  constructor(requested: ContextRef, current: ContextRef | null) { super("retained context superseded"); this.name = "ContextSupersededError";
    this.requested = requested; this.current = current; }
}
export function isContextSupersededError(e: unknown): e is ContextSupersededError;  // by name; survives realm boundaries
// LaunchRequest and LaunchHandle: replace `contextEpoch: number` with `context: ContextRef`.
```
Runner rule (3.1.5): `run()` uses exactly the capture identified by `r.context`; if `retainedContext(parentSessionID)` is null or its (bootID, epoch, callID) differs → reject with `ContextSupersededError` before any host call. Launcher: `launch()` throws `E_NO_CONTEXT` synchronously when `req.context` is not the current capture of `orchestratorSessionID`. `attempt-started.attempt.callID === req.context.callID`. Both outcomes are rows L3/L5: `launch-lost`, `lost`, **not** stale.

#### A1-5 Launch failure table (QA-1.4-5; replaces R1, LaunchHooks, the `launch` doc)

```ts
export type LaunchConfirmation =
  | { kind: "confirmed"; childSessionID: string; latencyMs: number }
  | { kind: "unconfirmed"; reason: "timeout" | "threw" | "superseded" | "task-error" | "hook-failed"; error: string | null };
// ChildEnd "lost".reason: "unconfirmed" | "unrequested-interrupt" | "runner-error" | "restart" | "context-superseded" | "refused"
// MetricPayload "context-age": { …; bootID: string; epoch: number; callID; capturedAt; ageMs;
//   result: "confirmed" | "timeout" | "threw" | "superseded" | "task-error" | "hook-failed" }
export interface LaunchHooks {
  /** Late child. Pure decision, journals nothing: "adopt" iff this attempt is the latest, its outcome lost, task ready, plan not aborted. */
  onLateChild(childSessionID: string): Promise<"adopt" | "refuse">;
  /** The single journaling point for a created child (in time or adopted late), inside onCreated after RoleBindings.bind and before the
   *  child is prompted. Rt appends with a builder: dispatched with this attempt open → [AC, TT child-created]; ready with this attempt
   *  latest and lost → [AA, TT adopt, G1] + forced token; anything else → throw (refuse). A throw makes the runner interrupt the child. */
  onChildCreated(childSessionID: string): Promise<void>;
}
// TaskLauncher.launch err (synchronous, before any host call): E_NO_CONTEXT, E_LAUNCH_TASK, E_DISPOSED. markStale only for "timeout" and "threw".
// formatLaunchHeader and formatLaunchPrompt throw E_LAUNCH_TASK (replacing E_INVALID_INPUT).
// CapacityController.acquire(provider, heavy, taskId, attempt, opts?: { force: true }) — force never throws E_CAPACITY (adopt only).
```
Rt launch step (3.1.6; Rt journals every row, the launcher never journals): choose from `readySet` with `gate()` ok; acquire token, slot, leases; prepare route, nonce, n, prompt; append row 4 with a builder (returns [] if the task is no longer `ready`, n changed, or a qa gate is not `awaiting-qa` — then release what was acquired); if an older launch of the task has not settled (R4) `cancel(old, "superseded")`; `launch()`. `completion` always goes to `onChildEnd`, which processes only the latest open attempt (incl. adopted).

| # | Failure point | Confirmation | `completion` | Batch (row) | Outcome | Stale | Journaled by |
|---|---|---|---|---|---|---|---|
| L1 | prep throws `E_LAUNCH_TASK` (route/agent/model, prompt/header render) | — | — | 4b | failed (counts) | no | Rt launch step |
| L2 | `launch()` throws `E_LAUNCH_TASK` (header/prompt mismatch, unknown agent, bad workRoot) | — | — | 12 | failed (counts) | no | Rt launch step |
| L3 | `launch()` throws `E_NO_CONTEXT` | — | — | 11 | lost | no | Rt launch step |
| L4 | `launch()` throws `E_DISPOSED` | — | — | none; recovery `lost("restart")` | lost | no | Rc via Rt |
| L5 | runner rejects `ContextSupersededError` | unconfirmed/superseded | lost/context-superseded | 11 | lost | no | Rt |
| L6 | runner rejects before `onCreated` | unconfirmed/threw | lost/runner-error | 11 | lost | **yes** | Rt |
| L7 | no `onCreated` within 30 s | unconfirmed/timeout | later: interrupted/superseded, lost/unconfirmed, or the adopted child's end | 11 | lost | **yes** | Rt |
| L8 | in time; `RoleBindings.bind` throws | unconfirmed/task-error | lost/refused | 12 | failed (counts) | no | Rt |
| L9 | in time; `onChildCreated` throws | unconfirmed/hook-failed | lost/refused | 11 (on `E_LOCK_LOST` nothing; runtime disposes) | lost | no | Rt |
| L10 | in time; ok | confirmed | the child's end | 10 inside `onChildCreated` | — | — | Rt (hook) |
| L11 | late; refused or bind/`onChildCreated` throws | — | lost/refused, ignored | none | stays lost | — | — |
| L12 | late; adopted | — | the child's end for the reopened attempt | 7 inside `onChildCreated` | — | — | Rt (hook) |
| L13 | confirmed; runner throws, no terminal event within `CHILD_END_GRACE_MS` | — | lost/runner-error | 18 (`child-lost`) | lost | no | `Rt.onChildEnd` |
| L14 | confirmed; `execution.interrupted` without `cancel` (R7) | — | lost/unrequested-interrupt | 18 (`child-lost`) | lost | no | `Rt.onChildEnd` |
| L15 | confirmed; `execution.failed` | — | failed or capacity (R3) | 16 or 18 (`capacity-stop`) | failed / capacity | no | `Rt.onChildEnd` |
| L16 | `cancel()` (abort, blocked, superseded) | — | interrupted/<reason>, ignored | none (journaled before `cancel`) | — | — | — |
| L17 | `dispose` | — | interrupted/dispose, ignored | none; recovery `lost("restart")` | lost | no | Rc via Rt |

R1 restated: task-class errors are exactly L1, L2, L8 (`failed`, counts); every other pre-confirmation failure is `lost`; only L6 and L7 mark the context stale.

#### A1-6 Wake keys and dedupe (QA-1.4-6)

```ts
export type LaunchGate =
  | { ok: true; context: RetainedContextInfo; ageMs: number }
  | { ok: false; reason: "disposed"; wake: null }
  | { ok: false; reason: "no-context" | "awaiting-first-router-call" | "context-stale"; wake: { reason: "stale-context"; stateKey: string } };
```
Keys: `context-stale` → `stale-context:<bootID>:<epoch>`; `no-context` (a capture existed in this process and is gone) → `no-context:<bootID>:<orchestratorSessionID>:<lastEpoch>`; `awaiting-first-router-call` (no capture of the bound session in this process yet) → `await-router-call:<bootID>:<orchestratorSessionID>`. Rt calls `Waker.wake(g.wake.reason, g.wake.stateKey)` iff `g.ok === false`, `g.wake !== null` and the ready set computed as if the gate were ok is non-empty. Dedupe source: the `stateKey` of every `wake` event of the plan (history loaded at open + this writer since). A key is burned when its `wake` event is journaled (before `synthetic`, D8). `debounced` journals nothing. `failed` burns the key; Rt may retry the same situation at most twice, ≥ `wakeDebounceMs` apart, with keys `<key>#2`, `<key>#3`. `inbox:<id>` keys are plan-unique already.

#### A1-7 Guards and invariants (QA-1.4-8, -10)

```ts
export const PHASE_ID_PATTERN = /^(?!.*\.\.)(?!.*\.$)(?!.*\.lock$)[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
export const WAVE_ID_PATTERN = PHASE_ID_PATTERN;
export const GIT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const ABSOLUTE_PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+|\/)/;
export const INBOX_ID_PREFIX: Readonly<Record<InboxKind, string>> =
  { question: "Q", failure: "F", "usage-limit": "U", landing: "L", flaky: "K", "qa-cap": "R", breaker: "B" };
export const INBOX_ID_PATTERN = /^([QFULKRB])-([1-9][0-9]{0,8})$/;
export function formatInboxId(kind: InboxKind, n: number): string;
export function nextInboxNumber(l: Pick<LedgerV1, "inbox">): number;   // 1 + max n across all prefixes
export interface LedgerViolation { code: string; at: string /* JSON path */ }
export function ledgerViolations(v: unknown): LedgerViolation[];      // isLedgerV1(v) === (ledgerViolations(v).length === 0)
```
Existing invariant codes: `shape`, `schema`, `config-limits`, `task-key`, `task-phase`, `phase-wave`, `edge-endpoint`, `seq`, `attempt-n`, `open-attempt`, `slot-required`, `branch-required`, `integrated-missing`, `manual-attempts`, `shared-context-length`, `shared-context-slot-path`.
New in `isTaskNode`: `attempt-ended-pair` (`(outcome === null) === (endedAt === null)`, `endedAt ≥ startedAt`); `verdict-unsucceeded` (verdict ≠ null ⇒ outcome `succeeded`); `nonce-duplicate`; `running-without-child` (state `running` ⇒ latest attempt `childSessionID !== null`); `slot-forbidden` (`slot === null` in pending, blocked, parked, done, cancelled, integrated, reverted); `git-id` (`integrated.from/to`); `qa-without-phase` (`kind "qa"` ⇒ `phase !== null`).
New in `isLedgerV1`: `path-not-absolute` (`planPath`, `repo.toplevel`, `integration.worktree`, non-null `config.slotsDir`); `git-id` (`repo.baseCommit`, `integration.head`); `phase-id`/`phase-duplicate`; `wave-id`/`wave-duplicate`; `wave-membership` (every `wave.phases[i]` exists with `phase.wave === wave.id`; every phase listed in exactly one wave, its own); `phase-depends` (entries exist, not self); `slots-dir-unresolved` (status ∈ {running, paused, completed} ⇒ `config.slotsDir !== null`); `inbox-id`/`inbox-duplicate` (pattern, prefix per kind, ids and numeric parts unique); `inbox-task` (non-null `taskId` exists); `shared-context-header` (no line of `sharedContext` matches `LAUNCH_HEADER_PATTERN`); `qa-multiple-open` (QA2); `qa-round` (1 ≤ qaRound ≤ QA_ROUND_LIMIT); `qa-gate` (status ≠ aborted, for each phase P: (a) a qa task of P in {dispatched, running} ⇒ `P.gate === "qa-running"`; (b) `P.gate === "qa-running"` ⇒ exactly one qa task of P in flight, or every qa task of P ∈ {done, cancelled} with at least one `done`).

```ts
/** Strict, at the fixed position: prompt starts with "PLAN CONTEXT\n" + sharedContext + "\n\n", the next line matches
 *  LAUNCH_HEADER_PATTERN in full and is followed by "\n\n". Recovery (C7) uses this with ledger.sharedContext. */
export function parseLaunchHeader(prompt: string, sharedContext: string): LaunchHeaderFields | null;
/** Loose: any line matches. Only for the 3.1.7.a fail-closed check (over-matching fails closed). */
export function looksLikePlanPrompt(prompt: string): boolean;
/** §7 grammar. E_LAUNCH_TASK if sharedContext has a header-shaped line or taskBlock does not start with "TASK". */
export function formatLaunchPrompt(sharedContext: string, header: LaunchHeaderFields, taskBlock: string): string;
```
Memo §7 regex fix: the task-id lookahead is `(?!\d+#)` (as in types.ts since `168a25c`); consumers import the exported pattern.

#### A1-8 Minor findings

- **QA-1.4-16:** `ExecutorRuntime.status`, `ready`, `exportPlan`, `planLine` are read-only: never `E_NOT_OWNER`, any status incl. completed/aborted, signatures unchanged; `status` uses its `sessionID` only to pick the plan when `planId` is null.
- **QA-1.4-17:** `attempt-verdict.ref` stays journal-only (no `Attempt` field; survives rotation through history). New durable event `task-footprint {taskId, footprint}` (owner Rt, only in row 18b), monotone (writes, reads, sources only grow; the learned path added to `writes`, `"learned"` to `sources`; `confidence` unchanged).
- **QA-1.4-20 queue gating:** dequeue only while `status === "running"` and the task's phase is null or not paused (a queued task of a paused phase is skipped but keeps its position; a batch takes only dequeueable tasks; `checkPhase` starts a suite only under the same condition; `resume()` runs in running and paused, starting no new step except A1-3's reruns). **Abort order:** (1) in-memory latch (no launch, enqueue or promotion); (2) `await queue.abort()` (stop dequeuing, roll back the step in progress, journal one batch with row 33 events; other open entries closed `rolled-back`; on throw log and continue); (3) one Rt builder batch: rows 3, 6, 14, 20, 24, 27, 29, 39 for every task not in {done, cancelled, integrated, integrating}, then `status-changed →aborted` last; (4) after the fsync `launcher.cancel(t, n, "abort")` for every launch in flight incl. unsettled lost ones; resources released as each completion settles. Gates and inbox untouched.

#### A1-9 `UnattendedPolicy` doc changes

`answer`: a critical `qa-cap` item goes to `QaLoop.onCapAnswer` (answer must be an option). `park`: blocks only **pending** transitive dependents (a dependent of an un-integrated task cannot be ready or in flight, R9/R10); drop "their in-flight children cancelled".

#### A1-10 Memo edits (applied by reference)

§1 D-d → "rebuild from the snapshot, the history journal's open integration entries, and git (A1-3)"; R1 → A1-5; R4 → adoption journaled only in `onChildCreated` (L12); R12 → QA6; R16 → QA7; §3.1 → add the A1-2.4 table, `dep-reverted` owners → Q; §3.3 → A1-1 gate table; §5 → new constants, `qaRound` 1-based; §6 → framing, changed events, `task-footprint`, `isHistoryEvent`, replay rules A1-2; §7 → A1-7; §8 → `LedgerWriter`, `IntegrationQueue.resume`, `CapacityController.acquire`, `QaLoop`, `LaunchHooks`, `LaunchConfirmation`, `ChildEnd`, `LaunchGate`, `LaunchRequest`/`LaunchHandle`; recovery matrix → A1-1, A1-2 corollary, A1-3; §9 → `ChildRunRequest.context`, `ChildRunner.bootID`, `ContextSupersededError`; §11.3 resolved by A1-3.

#### A1-11 Tests 1.4.4 must add

Gate table cell by cell (12 legal pairs, each with trigger and owner; `awaiting-qa>pending` legal; `passed` no exits). `ledgerViolations`: one fuzz case per new code asserting that code; `isLedgerV1 ⇔ []`; extra fields survive. `fixTaskId`/`reviewTaskId` match `TASK_ID_PATTERN` for sampled phase ids at the limits; `fixTaskId` throws beyond them. `formatInboxId`/`nextInboxNumber` per kind. `qaUnparsableCount`; `canonicalFindingsJson` round trip through `parse`. Strict `parseLaunchHeader` rejects a header-shaped line inside the shared context and accepts the fixed position; `looksLikePlanPrompt` loose; `formatLaunchPrompt` round trip; `formatLaunchHeader` throws `E_LAUNCH_TASK` (update the existing test). `isContextSupersededError` on a plain object with that `name`. `isDurableEvent(task-footprint) === true`; `isHistoryEvent` for the four types. Typed doubles for the changed interfaces, incl. `BatchBuilder` use in the `LedgerWriter` double.

#### A1-12 Consumer follow-ups (handoffs)

2.3 `validate` codes `qa-multiple`, `shared-context-header`; 3.1.4 renders through `formatLaunchPrompt`; 3.1.5 adds `bootID` and the context pin in v2-client; 4.2.2 routes `qa-cap` answers; the 3.2 test "a revert that conflicts: the culprit is parked" reads as R11 ("the phase is paused").

### 1.4.1-A2 Contract addendum (binding; QA-1.4 round 2 at `2c15732`; implementer `ses_ed62869d2ffe0QW14CTDMv12W8`)

**Precedence:** A2 amends A1; A3 amends A2-2.

- **A2-1 (QA-1.4-21) suite batches.** The gate change into `suite-running` and the suite's ISS are one Q batch; the suite's closing ISE and the gate change out of `suite-running` (`suite-passed` / `suite-culprit-found`) are one batch; the same holds for `suite-rerun`. `checkPhase` on gate `suite-running` with no open phase-suite entry **with `phaseId` = this phase** means "start the suite, no gate event" (journals the ISS only); this covers every rollback by `resume()`, running or paused. Recovery row: gate `suite-running`, no open entry → `checkPhase`. The runtime calls `checkPhase` when a paused plan resumes (`status-changed paused→running`).
- **A2-2 (QA-1.4-22) lease seam.** Superseded by A3.
- **A2-3 (QA-1.4-24) row 4b for a qa task.** The batch writes G1 (`awaiting-qa→qa-running`, `qa-dispatched`, Rt) then G2 (`qa-running→awaiting-qa`, `qa-requeued`, Rt); each `from` equals the gate at that point; the gate ends where it started.
- **A2-4 (QA-1.4-25) load rules.** Batch-framing rules (2) and (3) apply to the main journal only; history is checked for strictly increasing `seq` and a torn last line only; `read()` and `open()` both drop a trailing incomplete batch.
- **A2-5 (QA-1.4-26) `resume()` step 0.** Writes `status-changed running→paused` only when the plan is `running`; always raises the inbox item.
- **A2-6 (QA-1.4-27) attempt end time.** The runtime journals `attempt-ended.endedAt = max(end.endedAt, attempt.startedAt)`; `startedAt` is never rewritten.
- **A2-7.** `LedgerWriter.wakeKeys()` is built from history at open and updated on every append (A1-6 rules copied into the `Waker` doc); `GATE_TRIGGER_OWNERS` refines the pair owners (`qa-requeued` → Rt, P, Q; `qa-cap` → QL); `RESERVED_TASK_IDS` (`constructor`, `toString`, `__proto__`, `hasOwnProperty`, `valueOf`, `prototype`) are rejected; maps keyed by task id use own-property lookups.

### 1.4.1-A3 Lease seam (binding; QA-1.4 round 3 at `4a79bfa`; replaces A2-2)

- **Identity (QA-1.4-32).** `leaseTaskRef(planId, taskId)` = `${planId}:${taskId}` (unique per process; neither grammar allows `:`); `leaseHolderID(planId, taskId)` = `plan:${planId}:${taskId}`. Every task lease is held by `{holderID: leaseHolderID, tree: slot path, isChild: true, taskRef: leaseTaskRef, scope: "until-integrated"}`; a plan child joins through the 2.1 guard with its own holderID, the same taskRef and scope, and tree = slot path (re-entrant, same owner).
- **Seam (QA-1.4-33).** `LeaseService` is per plan over the ONE process-wide Phase 1.3 registry and never calls `registry.restore`. `acquireTask({taskId, tree, writes})`: `[]` → ok with no registry call; else one atomic `acquireWrite(holder, writes)`; `held | unknown-target` → `held` with the holders the registry names (at least one). `rebuild(tasks)` at open/takeover after slots are resolved: `releaseTask` every task of the plan, then re-acquire for every task with `slot !== null` and writes; touches no holder outside the plan; returns the tasks it could not re-take (the runtime raises one inbox item each). `LeaseView.holder(path)` returns `LeaseHolderInfo {planId|null, taskId|null, holderID}`; a holder of another plan or none is "not a plan task" under R6 (`lease-unresolvable`).
- **Release callers (QA-1.4-34).** `releaseTask` runs after the fsync of every batch that writes `TS(null)` for the task, by the module that wrote it (A1-2.4 release column): Rt rows 6, 9, 14, 15qa, 18b, 20, 22, 24, 27, 29, 39 (abort included); Q rows 5, 13, 19, 30, 33; P rows 17, 36; for a live child being cancelled, after its completion settles. **Rt acquires** the leases before the row-4 batch and releases them if `append` fails or the builder returns `[]`.

## Findings

### Round 1 (heavy reviewer `ses_ed6996549ffefS1pVZWovl66Uf`, at `168a25c`) — 20 findings (1 critical, 8 major, 9 minor, 2 nit)

QA-1.4-1 (critical) a QA task retried or answered could never be relaunched (gate stuck in `qa-running`); -2 (major) "atomic batch" undeliverable without framing; -3 (major) only `integrating` tasks resumed after rotation; -4 (major) child run not pinned to the gated context; -5 (major) contradictory launch-failure rules; -6 (major) wake keys collide across restarts; -7 (major) QA round cap had no exit; -8 (major) guards missed invariants; -9 (major) the `src/executor/**` coverage gate not enforced in CI; -10 header parse position; -11 vacuous fuzz; -12 memo lookahead wrong; -13 slot/lease/token per row; -14 R12 counting; -15 mutable defaults; -16 `sessionID` on read-only calls; -17 verdict ref and learned footprints; -18 `exportPlan` history; -19 (nit) draft `seq`; -20 (nit) queue gating and abort order.

### Round 2 (heavy reviewer `ses_ed63c87ceffenj8X7FV7VMe6oM`, at `2c15732`) — 11 findings (2 major, 5 minor, 4 nit)

`types.ts` matches A1. New: QA-1.4-21 (major) a phase could stay in `suite-running` forever; -22 (major) no lease seam; -23 wake-key dedupe source; -24 row 4b gate sequence for qa tasks; -25 load rules for history; -26 `resume()` halt in a paused plan; -27 attempt end before start; -28 (nit) oracle git ids; -29 (nit) per-trigger gate owners; -30 (nit) coverage script function drift; -31 (nit) reserved task ids.

### Round 3 (heavy reviewer `ses_ed620333fffehkY719rxxYFjHT`, at `4a79bfa`; majors only) — 3 major

QA-1.4-21 fixed; QA-1.4-22 partial: QA-1.4-32 (major) task refs not unique across plans; -33 (major) `rebuild` as `restore` would wipe other plans' leases, and the seam lacked tree and holder identity; -34 (major) release callers contradicted A1-2.4. Recorded minors: "every holder listed" vs the registry's single named holder and non-atomic per-path calls (settled by A3); A2-2 "the launcher acquires" (settled by A3: Rt); null `sessionID` vs `string` holders (settled by `LeaseHolderInfo`); A2-1 rollback wording and per-phase entry (settled in A2-1 above); (nit) un-pausing a single phase is not a `checkPhase` trigger (unreachable today; handoff to 3.2).

## Fixes

- Round 1: contract addendum A1 (architect `ses_ed689bce6ffeVMf77avXeJC2cu`) implemented in `types.ts` with oracle-based fuzzing (implementer `ses_ed660b574ffevqpAdgIXaKssb8`, `2c15732`); coverage gate: `scripts\coverage-gate.ts` + prefix entries with function thresholds in `scripts\coverage-merge.mjs`, `src/executor/` gated 90/90/90 in the CI `coverage-merge` job (implementer `ses_ed6608221ffeua0J1HDSAmtpRA`, `ed9cb6e`).
- Round 2: A2 (implementer `ses_ed62869d2ffe0QW14CTDMv12W8`, `4a79bfa`).
- Round 3: A3 (implementer `ses_ed60f86b6ffeO9x7NbgT755Iqx`, `6071f54`).
- Verification (orchestrator shell, `6071f54`): executor-types 214 + coverage-merge 20 tests green; typecheck 0; types.ts coverage 99.31/99.63/100/100 (at `4a79bfa`).

## Deferred findings

- None open in this phase. Consumer follow-ups below.

## Handoffs

- A1-12: 2.3 `validate` codes `qa-multiple`, `shared-context-header`; 3.1.4 renders through `formatLaunchPrompt`; 3.1.5 adds `bootID` and the context pin in v2-client; 4.2.2 routes `qa-cap` answers; the 3.2 test "a revert that conflicts: the culprit is parked" reads as R11.
- A3: 2.1 binds plan children with `taskRef = leaseTaskRef(planId, taskId)`, `scope: "until-integrated"`, tree = slot path; 3.1 implements `LeaseService` over the Phase 1.3 registry and raises one inbox item per `rebuild` failure; 3.2 considers un-pausing a single phase as a `checkPhase` trigger.
- `engines` allows Node 22.0–22.17, where the coverage-merge `.ts` imports need type stripping (≥ 22.18): pre-existing, outside this phase.

## Verdict

PASS after QA round 3 (majors QA-1.4-32/33/34 fixed in `6071f54`; no round 4 by rule).