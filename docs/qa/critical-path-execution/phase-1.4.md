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

## Findings

## Fixes

## Deferred findings

## Handoffs

## Verdict
