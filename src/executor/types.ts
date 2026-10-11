// src/executor/types.ts
// The single cross-phase executor contract (Phase 1.4, memo 1.4.1 in docs/qa/critical-path-execution/phase-1.4.md).
// Ledger data (JSON only), the task/gate/status state machines, the event union, the guards, the launch-header
// grammar, the findings format and every interface other executor modules are built against. No I/O: the only
// runtime code is small, pure and dependency-free (canTransition, counting, guards, header, classification).

// ---------------------------------------------------------------------------------------------------------------
// §5 Ledger data
// ---------------------------------------------------------------------------------------------------------------

/** JSON-only value: everything the ledger and its journal may hold (§5). */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };
/** UTC "YYYY-MM-DDTHH:mm:ss.sssZ" (§5). */
export type IsoTime = string;
export type PlanId = string;
export type TaskId = string;
export type PhaseId = string;
/** Edge source only: satisfied when `phases[id].gate === "passed"` (D-c, §5). */
export type GateRef = `gate:${string}`;

/** Ledger schema version this build reads and writes (§5). */
export const LEDGER_SCHEMA = 1 as const;
/** Plan id grammar (Appendix A 4249, §5). */
export const PLAN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,40}$/;
/** Task id grammar: never integer-like (R14); contains no ':', '#', ']' or space (§5). */
export const TASK_ID_PATTERN = /^(?!\d+$)[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Attempt nonce: 128 random bits as lowercase hex (§5). */
export const NONCE_PATTERN = /^[0-9a-f]{32}$/;

export type LedgerStatus =
  | "compiling" | "awaiting-residue" | "awaiting-approval" | "running" | "paused" | "completed" | "aborted";
export type GateState = "pending" | "suite-running" | "suite-failed" | "awaiting-qa" | "qa-running" | "passed";
export type TaskState =
  | "pending" | "ready" | "dispatched" | "running" | "completed" | "verifying" | "verified"
  | "integrating" | "integrated" | "done" | "failed" | "conflict" | "parked" | "blocked" | "reverted" | "cancelled";
export type TaskKind = "preflight" | "task" | "tests" | "qa" | "fix" | "manual";
export type Tier = "fast" | "medium" | "heavy";

export interface PhaseRecord {
  id: PhaseId;
  title: string;
  wave: string;
  dependsOn: string[];
  gate: GateState;
  qaRound: number;
  paused: boolean;
  tag: string | null;
}

export interface LedgerV1 {
  schema: 1;
  planId: PlanId;
  /** Absolute path of the plan file. */
  planPath: string;
  /** sha256 hex, 64 chars. */
  planDigest: string;
  repo: { key: string; toplevel: string; baseBranch: string; baseCommit: string };
  /** `branch` is `omr/<planId>/integration`. */
  integration: { branch: string; worktree: string; head: string };
  launcher: "A";
  status: LedgerStatus;
  orchestrator: { sessionID: string; boundAt: IsoTime };
  /** Resolved at compile, re-snapshotted at approval; `slotsDir` is non-null from approval on. */
  config: ExecutorConfig;
  /** At most `config.sharedContextChars` characters; contains no slot path. */
  sharedContext: string;
  waves: Array<{ id: string; phases: PhaseId[] }>;
  phases: PhaseRecord[];
  /** Insertion order = plan order (R14). */
  tasks: Record<TaskId, TaskNode>;
  edges: Edge[];
  inbox: InboxItem[];
  /** `seq` of the last applied event. */
  seq: number;
}

export interface Footprint {
  /** Repo-relative, '/'-separated, no '.'/'..' segments, no trailing '/'. */
  writes: string[];
  reads: string[];
  confidence: "explicit" | "ownership" | "inferred" | "unknown";
  sources: Array<"path" | "ownership" | "writes-line" | "llm" | "learned">;
}

export interface TaskNode {
  id: TaskId;
  title: string;
  phase: PhaseId | null;
  kind: TaskKind;
  text: string;
  subtasks: string[];
  route: { line: string; role: string; tier: Tier | null; pin: boolean };
  verify: "required" | "deferred" | "none";
  acceptance: string | null;
  footprint: Footprint;
  /** Milliseconds, finite, 0 <= p50 <= p90. */
  estimate: { p50: number; p90: number; source: string };
  state: TaskState;
  attempts: Attempt[];
  slot: string | null;
  /** `omr/<planId>/t/<encoded taskId>`. */
  branch: string | null;
  /** The latest integration range. */
  integrated: { from: string; to: string } | null;
}

export interface Edge {
  from: TaskId | GateRef;
  to: TaskId;
  kind: "structural" | "explicit" | "graph" | "contract" | "conflict" | "llm" | "learned";
  confidence: "high" | "medium" | "low";
  evidence: string;
}

export type AttemptOutcome = "succeeded" | "failed" | "interrupted" | "lost" | "capacity";
export type Verdict = "pass" | "fail" | "unverifiable";

export interface Attempt {
  /** 1-based, = index + 1, for every attempt. */
  n: number;
  nonce: string;
  /** Retained router-call id used for the launch. */
  callID: string | null;
  childSessionID: string | null;
  startedAt: IsoTime;
  endedAt: IsoTime | null;
  outcome: AttemptOutcome | null;
  verdict: Verdict | null;
  /** The feedback this attempt produced (R13); starts as "". */
  context: string;
}

export type InboxKind = "question" | "failure" | "usage-limit" | "landing" | "flaky" | "qa-cap" | "breaker";

/**
 * `id` is "<P>-<n>" with P in {Q,F,U,L,K,R,B} by kind and n unique per plan.
 * Deferred minor/nit findings (4.2.3.d) are stored as `{kind:"qa-cap", severity:"info", answer:"deferred"}`:
 * they persist in the snapshot, are already closed, and trigger no wake.
 */
export interface InboxItem {
  id: string;
  kind: InboxKind;
  severity: "info" | "blocking" | "critical";
  taskId: TaskId | null;
  text: string;
  options: string[];
  answer: string | null;
  createdAt: IsoTime;
}

/** Marker `<executor home>\slots\<slot>.json` (2.4.3.a); not part of `LedgerV1` (§5). */
export interface SlotRecord {
  schema: 1;
  /** "slot-<n>" | "integration" | "ci". */
  slot: string;
  path: string;
  kind: "task" | "integration" | "ci";
  planId: PlanId;
  repoKey: string;
  state: "creating" | "provisioning" | "ready" | "leased" | "resetting" | "broken" | "retired";
  /** A task id or an integration entry id. */
  owner: string | null;
  commit: string | null;
  managers: string[];
  /** Repo-relative manifest path -> sha256. */
  manifests: Record<string, string>;
  createdAt: IsoTime;
  updatedAt: IsoTime;
}

export type IntegrationStep =
  | "rebase" | "checks" | "fast-forward" | "batch-checks" | "bisect" | "phase-suite"
  | "suite-rerun" | "revert-build" | "revert-checks" | "revert-fast-forward" | "rollback" | "tag" | "land";
export type IntegrationStepResult = "ok" | "conflict" | "failed" | "flaky" | "pre-existing" | "refused" | "rolled-back";

/** Payload of `integration-step` events only (D-d); the queue is rebuilt from the snapshot plus git. */
export interface IntegrationEntry {
  /** "i-<seq of first start>". */
  id: string;
  kind: "task" | "batch" | "revert" | "phase-suite" | "land";
  phaseId: PhaseId | null;
  taskIds: TaskId[];
  slot: string | null;
  baseHead: string;
  candidate: string | null;
}

/** A package script plus arguments, run through the allowlisted runner. */
export interface RunCommandRef {
  script: string;
  args: string[];
}

/** Executor configuration (Appendix C 4381-4399); ranges in `EXECUTOR_LIMITS`. */
export interface ExecutorConfig {
  /** 1-8 (ADR D13 500-504), default 4. */
  maxParallel: number;
  /** Trusted; null = computed (replaced by the computed path at approval). */
  slotsDir: string | null;
  approve: "ask" | "auto";
  crossPhase: "gate" | "inferred";
  land: "ff-when-clean" | "manual";
  batchMax: number;
  maxAttempts: number;
  qaMaxRounds: number;
  integrationChecks: "auto" | RunCommandRef[];
  phaseSuite: "auto" | "off" | RunCommandRef[];
  provision: "auto" | Record<string, string[][]>;
  python: "auto" | string;
  sharedContextChars: number;
  capacityCooldownMs: number;
  capacityPauseMs: number;
  wakeDebounceMs: number;
  circuitBreaker: { failureRatio: number; minAttempts: number; consecutiveFailures: number };
}

/** Inclusive ranges for the numeric `ExecutorConfig` fields (Appendix C, §5). */
export const EXECUTOR_LIMITS: {
  maxParallel: [1, 8]; batchMax: [1, 8]; maxAttempts: [1, 6]; qaMaxRounds: [1, 8];
  sharedContextChars: [0, 60000]; capacityCooldownMs: [10000, 3600000]; capacityPauseMs: [60000, 86400000];
  wakeDebounceMs: [1000, 60000]; failureRatio: [0.1, 1]; minAttempts: [1, 50]; consecutiveFailures: [1, 50];
} = {
  maxParallel: [1, 8], batchMax: [1, 8], maxAttempts: [1, 6], qaMaxRounds: [1, 8],
  sharedContextChars: [0, 60000], capacityCooldownMs: [10000, 3600000], capacityPauseMs: [60000, 86400000],
  wakeDebounceMs: [1000, 60000], failureRatio: [0.1, 1], minAttempts: [1, 50], consecutiveFailures: [1, 50],
};

// ---------------------------------------------------------------------------------------------------------------
// §3 State machines (data) and §4 attempt counting
// ---------------------------------------------------------------------------------------------------------------

/** Every `TaskState`, in memo order. */
export const TASK_STATES: readonly TaskState[] = [
  "pending", "ready", "dispatched", "running", "completed", "verifying", "verified",
  "integrating", "integrated", "done", "failed", "conflict", "parked", "blocked", "reverted", "cancelled",
];
/** Every `GateState`, in memo order. */
export const GATE_STATES: readonly GateState[] = [
  "pending", "suite-running", "suite-failed", "awaiting-qa", "qa-running", "passed",
];
/** Every `LedgerStatus`, in memo order. */
export const LEDGER_STATUSES: readonly LedgerStatus[] = [
  "compiling", "awaiting-residue", "awaiting-approval", "running", "paused", "completed", "aborted",
];
export const TASK_KINDS: readonly TaskKind[] = ["preflight", "task", "tests", "qa", "fix", "manual"];
export const ATTEMPT_OUTCOMES: readonly AttemptOutcome[] = ["succeeded", "failed", "interrupted", "lost", "capacity"];
export const VERDICTS: readonly Verdict[] = ["pass", "fail", "unverifiable"];

/** Terminal task states: nothing leaves them (§3.1 rules). */
export const TERMINAL_TASK_STATES = ["done", "cancelled"] as const;

/** Why a task transition happened; one per `task-transition` event (§6). */
export type TransitionTrigger =
  | "deps-satisfied" | "dep-parked" | "dep-blocked" | "abort" | "launch" | "dep-reverted" | "adopt"
  | "reported-done" | "dep-added" | "child-created" | "launch-lost" | "launch-task-error" | "child-ended" | "child-failed"
  | "lease-unresolvable" | "qa-unparsable" | "escalate" | "ambiguity" | "child-lost" | "capacity-stop" | "lease-needed"
  | "committed" | "no-changes" | "commit-failed" | "verify-pass" | "verify-fail" | "dequeued" | "fast-forwarded"
  | "rebase-conflict" | "checks-failed" | "suite-culprit" | "retry" | "exhausted" | "answered" | "dep-recovered";

/** Key of a legal task transition: `"<from>><to>"`. */
export type TransitionKey = `${TaskState}>${TaskState}`;

/** The 47 legal task transitions (§3.1); anything else fails `canTransition` and ledger replay. */
export const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  pending: ["ready", "blocked", "cancelled"],
  ready: ["dispatched", "blocked", "cancelled", "running", "done", "pending"],
  dispatched: ["running", "ready", "failed", "blocked", "cancelled"],
  running: ["completed", "failed", "parked", "ready", "blocked", "cancelled"],
  completed: ["verifying", "done", "failed", "cancelled"],
  verifying: ["verified", "failed", "cancelled"],
  verified: ["integrating", "cancelled"],
  integrating: ["integrated", "conflict", "failed", "cancelled"],
  integrated: ["reverted"],
  done: [],
  failed: ["ready", "parked", "cancelled"],
  conflict: ["ready", "parked", "cancelled"],
  parked: ["ready", "cancelled"],
  blocked: ["ready", "cancelled"],
  reverted: ["ready", "parked", "cancelled"],
  cancelled: [],
};

/**
 * Triggers allowed per legal pair (§3.1 rows). Exactly the 47 keys of `TASK_TRANSITIONS`; an illegal pair has
 * no key. The row's attempt effect and journal batch are described in the memo, not encoded here.
 */
export const TRANSITION_TRIGGERS: Readonly<Partial<Record<TransitionKey, readonly TransitionTrigger[]>>> = {
  "pending>ready": ["deps-satisfied"],
  "pending>blocked": ["dep-parked", "dep-blocked"],
  "pending>cancelled": ["abort"],
  "ready>dispatched": ["launch"],
  "ready>blocked": ["dep-reverted"],
  "ready>cancelled": ["abort"],
  "ready>running": ["adopt"],
  "ready>done": ["reported-done"],
  "ready>pending": ["dep-added"],
  "dispatched>running": ["child-created"],
  "dispatched>ready": ["launch-lost"],
  "dispatched>failed": ["launch-task-error"],
  "dispatched>blocked": ["dep-reverted"],
  "dispatched>cancelled": ["abort"],
  "running>completed": ["child-ended"],
  "running>failed": ["child-failed", "lease-unresolvable", "qa-unparsable"],
  "running>parked": ["escalate", "ambiguity", "qa-unparsable"],
  "running>ready": ["child-lost", "capacity-stop", "lease-needed"],
  "running>blocked": ["dep-reverted"],
  "running>cancelled": ["abort"],
  "completed>verifying": ["committed"],
  "completed>done": ["no-changes"],
  "completed>failed": ["commit-failed"],
  "completed>cancelled": ["abort"],
  "verifying>verified": ["verify-pass"],
  "verifying>failed": ["verify-fail"],
  "verifying>cancelled": ["abort"],
  "verified>integrating": ["dequeued"],
  "verified>cancelled": ["abort"],
  "integrating>integrated": ["fast-forwarded"],
  "integrating>conflict": ["rebase-conflict"],
  "integrating>failed": ["checks-failed"],
  "integrating>cancelled": ["abort"],
  "integrated>reverted": ["suite-culprit"],
  "conflict>ready": ["retry"],
  "failed>ready": ["retry"],
  "reverted>ready": ["retry"],
  "conflict>parked": ["exhausted"],
  "failed>parked": ["exhausted"],
  "reverted>parked": ["exhausted"],
  "parked>ready": ["answered"],
  "blocked>ready": ["dep-recovered"],
  "failed>cancelled": ["abort"],
  "conflict>cancelled": ["abort"],
  "reverted>cancelled": ["abort"],
  "parked>cancelled": ["abort"],
  "blocked>cancelled": ["abort"],
};

/** Module that may journal a transition (§3.1 owner codes): Rt runtime, Q queue, P unattended policy, Rc recovery. */
export type TransitionOwner = "Rt" | "Q" | "P" | "Rc";

/** Who writes each legal transition (D-e, §3.1); lets test doubles check each module's boundary. */
export const TRANSITION_OWNERS: Readonly<Partial<Record<TransitionKey, readonly TransitionOwner[]>>> = {
  "pending>ready": ["Rt"], "pending>blocked": ["P"], "pending>cancelled": ["Rt"],
  "ready>dispatched": ["Rt"], "ready>blocked": ["Rt"], "ready>cancelled": ["Rt"], "ready>running": ["Rc", "Rt"],
  "ready>done": ["Rt"], "ready>pending": ["Rt"],
  "dispatched>running": ["Rt"], "dispatched>ready": ["Rt"], "dispatched>failed": ["Rt"], "dispatched>blocked": ["Rt"],
  "dispatched>cancelled": ["Rt"],
  "running>completed": ["Rt"], "running>failed": ["Rt"], "running>parked": ["P"], "running>ready": ["Rt"],
  "running>blocked": ["Rt"], "running>cancelled": ["Rt"],
  "completed>verifying": ["Rt"], "completed>done": ["Rt"], "completed>failed": ["Rt"], "completed>cancelled": ["Rt"],
  "verifying>verified": ["Rt"], "verifying>failed": ["Rt"], "verifying>cancelled": ["Rt"],
  "verified>integrating": ["Q"], "verified>cancelled": ["Rt"],
  "integrating>integrated": ["Q"], "integrating>conflict": ["Q"], "integrating>failed": ["Q"],
  "integrating>cancelled": ["Q"],
  "integrated>reverted": ["Q"],
  "conflict>ready": ["Rt"], "failed>ready": ["Rt"], "reverted>ready": ["Rt"],
  "conflict>parked": ["P"], "failed>parked": ["P"], "reverted>parked": ["P"],
  "parked>ready": ["P"], "blocked>ready": ["P"],
  "failed>cancelled": ["Rt"], "conflict>cancelled": ["Rt"], "reverted>cancelled": ["Rt"], "parked>cancelled": ["Rt"],
  "blocked>cancelled": ["Rt"],
};

/** True iff `from -> to` is a legal task transition; re-entering a state is not a transition (R15). */
export function canTransition(from: TaskState, to: TaskState): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

/** Phase-gate state machine (§3.3); replay checks it like task transitions. `passed` is terminal. */
export const GATE_TRANSITIONS: Readonly<Record<GateState, readonly GateState[]>> = {
  pending: ["suite-running", "awaiting-qa"],
  "suite-running": ["awaiting-qa", "suite-failed"],
  "suite-failed": ["pending", "suite-running"],
  "awaiting-qa": ["qa-running", "passed"],
  "qa-running": ["awaiting-qa", "pending", "passed"],
  passed: [],
};

/** True iff `a -> b` is a legal gate transition (§3.3). */
export function canGateTransition(a: GateState, b: GateState): boolean {
  return GATE_TRANSITIONS[a].includes(b);
}

/** Plan status machine (§3.4); `completed` and `aborted` are terminal. */
export const LEDGER_STATUS_TRANSITIONS: Readonly<Record<LedgerStatus, readonly LedgerStatus[]>> = {
  compiling: ["awaiting-residue", "awaiting-approval", "aborted"],
  "awaiting-residue": ["awaiting-approval", "aborted"],
  "awaiting-approval": ["running", "aborted"],
  running: ["paused", "completed", "aborted"],
  paused: ["running", "aborted"],
  completed: [],
  aborted: [],
};

/** True iff `a -> b` is a legal plan status transition (§3.4). */
export function canStatusTransition(a: LedgerStatus, b: LedgerStatus): boolean {
  return LEDGER_STATUS_TRANSITIONS[a].includes(b);
}

/** Task states that survive a crash and so are journaled with an fsync (§6). */
export const DURABLE_TASK_STATES: readonly TaskState[] =
  ["dispatched", "running", "completed", "integrating", "integrated", "reverted", "cancelled"];

/** Attempts that consume `maxAttempts`: `succeeded` and `failed` only (§4, R6, QA-0.1-20). */
export function countsTowardMaxAttempts(a: Attempt): boolean {
  return a.outcome === "succeeded" || a.outcome === "failed";
}
/** Number of attempts of `t` that count toward `maxAttempts` (§4). */
export function countedAttempts(t: TaskNode): number {
  return t.attempts.filter(countsTowardMaxAttempts).length;
}
/** True while `t` may start another counted attempt (§4). */
export function hasAttemptsLeft(t: TaskNode, maxAttempts: number): boolean {
  return countedAttempts(t) < maxAttempts;
}
/** Circuit-breaker failure sample: a failed attempt, or a fail/unverifiable verdict (§4). */
export function isBreakerFailure(a: Attempt): boolean {
  return a.outcome === "failed" || a.verdict === "fail" || a.verdict === "unverifiable";
}

// ---------------------------------------------------------------------------------------------------------------
// §6 ExecutorEvent
// ---------------------------------------------------------------------------------------------------------------

/** Why the orchestrator is woken with a synthetic message (D15 658-664). */
export type WakeReason = "inbox" | "phase-paused" | "plan-completed" | "manual-ready" | "stale-context";

/** Writer-lock holder (2.2). */
export interface LockHolder {
  pid: number;
  hostname: string;
  sessionID: string;
  startedAt: IsoTime;
  heartbeatAt: IsoTime;
}

/** Appendix D metric rows carried by `metric` events. */
export type MetricPayload =
  | { name: "idle-with-ready"; fromAt: IsoTime; toAt: IsoTime; ms: number; readyTaskIds: TaskId[]; free: number }
  | { name: "wake"; reason: WakeReason; stateKey: string; result: "sent" | "debounced" | "duplicate" | "failed" }
  | { name: "launch"; taskId: TaskId; attempt: number; agent: string; model: string; provider: string; heavy: boolean }
  | {
      name: "context-age"; taskId: TaskId; attempt: number; callID: string; capturedAt: IsoTime; ageMs: number; // D14 guard 4
      result: "confirmed" | "unconfirmed" | "threw";
    }
  | {
      name: "capacity"; provider: string; change: "decrease" | "increase" | "pause" | "resume" | "retry-stop";
      from: number; to: number; until: IsoTime | null; errorType: string | null; status: number | null;
    }
  | { name: "counter"; key: string; value: number; labels: Record<string, string> }; // other Appendix D rows

/** `Omit` applied to each member of a union (plain `Omit` collapses a discriminated union). */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type E<T extends string, P> = { seq: number; at: IsoTime; type: T } & P;

/** One journal line; `seq` is strictly +1 per line (§6). */
export type ExecutorEvent =
  | E<"ledger-init", { ledger: LedgerV1 }>
  // pre-approval statuses only
  | E<"draft-replaced", { draft: Pick<LedgerV1, "planDigest" | "sharedContext" | "waves" | "phases" | "tasks" | "edges"> }>
  | E<"status-changed", { from: LedgerStatus; to: LedgerStatus; reason: string }>
  | E<"plan-approved", { config: ExecutorConfig; by: string }>
  | E<"orchestrator-bound", { sessionID: string; reason: "compile" | "adopt" }>
  | E<"lock-takeover", { reason: string; previous: LockHolder | null; holder: LockHolder }>
  // state pending, or done (doneBefore)
  | E<"task-created", { task: TaskNode }>
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
  | E<"integration-step", {
      edge: "start" | "end"; entry: IntegrationEntry; step: IntegrationStep;
      result: IntegrationStepResult | null; detail: string | null; failingIds: string[];
    }>
  | E<"gate-changed", { phaseId: PhaseId; from: GateState; to: GateState; qaRound: number }>
  | E<"phase-paused", { phaseId: PhaseId; paused: boolean; reason: string }>
  | E<"phase-tagged", { phaseId: PhaseId; tag: string }>
  | E<"inbox-added", { item: InboxItem }>
  | E<"inbox-answered", { id: string; answer: string }>
  | E<"wake", { reason: WakeReason; stateKey: string }>
  | E<"metric", { metric: MetricPayload }>;

/** An event as callers submit it: the store assigns `seq`, the Clock supplies `at` (§6). */
export type ExecutorEventInput = DistributiveOmit<ExecutorEvent, "seq" | "at">;

/** False only for `metric` and for a `task-transition` into a non-durable state; true means fsync (§6, D8). */
export function isDurableEvent(e: ExecutorEventInput): boolean {
  if (e.type === "metric") return false;
  if (e.type === "task-transition") return DURABLE_TASK_STATES.includes(e.to);
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// §7 Constants, guards, launch header, findings
// ---------------------------------------------------------------------------------------------------------------

/** A launch not confirmed within this long is `lost` (D14 guard 1, D-f). */
export const LAUNCH_CONFIRM_TIMEOUT_MS = 30_000;
/** Wait for a terminal `session.execution.*` event after a runner throw. */
export const CHILD_END_GRACE_MS = 5_000;
/** Concurrent heavy-tier children per provider (3.1.3.a). */
export const HEAVY_CAP_PER_PROVIDER = 2;

/** Codes of `ExecutorError` (§8). */
export type ExecutorErrorCode =
  | "E_INVALID_INPUT" | "E_PLAN_STATE" | "E_NOT_OWNER" | "E_LEDGER_NOT_FOUND" | "E_EXISTS" | "E_SCHEMA_NEWER"
  | "E_SCHEMA_INVALID" | "E_SEQ_GAP" | "E_ILLEGAL_TRANSITION" | "E_LOCK_HELD" | "E_LOCK_LOST" | "E_COMPILE"
  | "E_CYCLE" | "E_RESIDUE" | "E_SLOT_UNAVAILABLE" | "E_SLOT_BROKEN" | "E_PROVISION" | "E_GIT" | "E_IDENTITY"
  | "E_CAPACITY" | "E_NO_CONTEXT" | "E_LAUNCH_TASK" | "E_DISPOSED";

/** Error every executor interface method throws; not ledger data (§8). A failing `append` leaves memory and disk unchanged. */
export class ExecutorError extends Error {
  readonly code: ExecutorErrorCode;
  readonly detail: JsonValue;
  constructor(code: ExecutorErrorCode, message: string, detail: JsonValue = null) {
    super(message);
    this.name = "ExecutorError";
    this.code = code;
    this.detail = detail;
  }
}

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isStr(v: unknown): v is string {
  return typeof v === "string";
}
function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}
function isBool(v: unknown): v is boolean {
  return typeof v === "boolean";
}
function isStrArr(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isStr);
}
function isOneOf<T extends string>(set: readonly T[], v: unknown): v is T {
  return typeof v === "string" && (set as readonly string[]).includes(v);
}
function hasOwn(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}
const ISO_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
function isIso(v: unknown): v is IsoTime {
  return typeof v === "string" && ISO_TIME_PATTERN.test(v) && Number.isFinite(Date.parse(v));
}
function isStrOrNull(v: unknown): v is string | null {
  return v === null || isStr(v);
}
function inRange(v: unknown, r: readonly [number, number], integer: boolean): v is number {
  if (typeof v !== "number" || !Number.isFinite(v) || (integer && !Number.isInteger(v))) return false;
  return v >= r[0] && v <= r[1];
}
function isRepoPath(v: unknown): v is string {
  if (!isStr(v) || v.length === 0 || v.includes("\\") || v.startsWith("/")) return false;
  return v.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/** The numeric `schema` of an unknown ledger value, or null; lets the store tell "newer" (E_SCHEMA_NEWER) from "invalid" (§7). */
export function ledgerSchemaOf(v: unknown): number | null {
  if (!isRec(v)) return null;
  const s = v.schema;
  return typeof s === "number" && Number.isFinite(s) ? s : null;
}

function isRunCommandRefs(v: unknown): boolean {
  return Array.isArray(v) && v.every((r) => isRec(r) && isStr(r.script) && isStrArr(r.args));
}

function isExecutorConfig(v: unknown): v is ExecutorConfig {
  if (!isRec(v)) return false;
  const L = EXECUTOR_LIMITS;
  if (!inRange(v.maxParallel, L.maxParallel, true)) return false;
  if (!isStrOrNull(v.slotsDir)) return false;
  if (v.approve !== "ask" && v.approve !== "auto") return false;
  if (v.crossPhase !== "gate" && v.crossPhase !== "inferred") return false;
  if (v.land !== "ff-when-clean" && v.land !== "manual") return false;
  if (!inRange(v.batchMax, L.batchMax, true)) return false;
  if (!inRange(v.maxAttempts, L.maxAttempts, true)) return false;
  if (!inRange(v.qaMaxRounds, L.qaMaxRounds, true)) return false;
  if (!(v.integrationChecks === "auto" || isRunCommandRefs(v.integrationChecks))) return false;
  if (!(v.phaseSuite === "auto" || v.phaseSuite === "off" || isRunCommandRefs(v.phaseSuite))) return false;
  if (!(v.provision === "auto" ||
    (isRec(v.provision) && Object.values(v.provision).every((m) => Array.isArray(m) && m.every(isStrArr))))) return false;
  if (!isStr(v.python)) return false;
  if (!inRange(v.sharedContextChars, L.sharedContextChars, true)) return false;
  if (!inRange(v.capacityCooldownMs, L.capacityCooldownMs, true)) return false;
  if (!inRange(v.capacityPauseMs, L.capacityPauseMs, true)) return false;
  if (!inRange(v.wakeDebounceMs, L.wakeDebounceMs, true)) return false;
  const cb = v.circuitBreaker;
  return isRec(cb) && inRange(cb.failureRatio, L.failureRatio, false) && inRange(cb.minAttempts, L.minAttempts, true) &&
    inRange(cb.consecutiveFailures, L.consecutiveFailures, true);
}

function isFootprint(v: unknown): v is Footprint {
  return isRec(v) && Array.isArray(v.writes) && v.writes.every(isRepoPath) && Array.isArray(v.reads) &&
    v.reads.every(isRepoPath) && isOneOf(["explicit", "ownership", "inferred", "unknown"] as const, v.confidence) &&
    Array.isArray(v.sources) &&
    v.sources.every((s) => isOneOf(["path", "ownership", "writes-line", "llm", "learned"] as const, s));
}

function isAttempt(v: unknown): v is Attempt {
  return isRec(v) && isInt(v.n) && v.n >= 1 && isStr(v.nonce) && NONCE_PATTERN.test(v.nonce) && isStrOrNull(v.callID) &&
    isStrOrNull(v.childSessionID) && isIso(v.startedAt) && (v.endedAt === null || isIso(v.endedAt)) &&
    (v.outcome === null || isOneOf(ATTEMPT_OUTCOMES, v.outcome)) &&
    (v.verdict === null || isOneOf(VERDICTS, v.verdict)) && isStr(v.context);
}

const SLOT_REQUIRED_STATES: readonly TaskState[] = ["dispatched", "running", "completed", "verifying", "verified", "integrating"];
const BRANCH_REQUIRED_STATES: readonly TaskState[] = ["verifying", "verified", "integrating"];

/**
 * Shape guard for a task node (§7): types, enums, finite numbers, patterns, plus the cross-field invariants
 * (`attempts[i].n === i+1`; one open attempt, the last, iff dispatched/running; slot, branch and `integrated`
 * presence by state; no attempts on manual/preflight tasks). Unknown extra fields are accepted.
 */
export function isTaskNode(v: unknown): v is TaskNode {
  if (!isRec(v)) return false;
  if (!isStr(v.id) || !TASK_ID_PATTERN.test(v.id) || !isStr(v.title)) return false;
  if (!isStrOrNull(v.phase) || !isOneOf(TASK_KINDS, v.kind) || !isStr(v.text) || !isStrArr(v.subtasks)) return false;
  const r = v.route;
  if (!isRec(r) || !isStr(r.line) || !isStr(r.role) || !(r.tier === null || isOneOf(["fast", "medium", "heavy"] as const, r.tier)) ||
    !isBool(r.pin)) return false;
  if (!isOneOf(["required", "deferred", "none"] as const, v.verify) || !isStrOrNull(v.acceptance)) return false;
  if (!isFootprint(v.footprint)) return false;
  const est = v.estimate;
  if (!isRec(est) || !isNum(est.p50) || !isNum(est.p90) || est.p50 < 0 || est.p50 > est.p90 || !isStr(est.source)) return false;
  if (!isOneOf(TASK_STATES, v.state) || !Array.isArray(v.attempts) || !v.attempts.every(isAttempt)) return false;
  if (!isStrOrNull(v.slot) || !isStrOrNull(v.branch)) return false;
  const integ = v.integrated;
  if (!(integ === null || (isRec(integ) && isStr(integ.from) && isStr(integ.to)))) return false;

  const attempts: Attempt[] = v.attempts;
  if (!attempts.every((a, i) => a.n === i + 1)) return false;
  const open = attempts.filter((a) => a.outcome === null).length;
  const inFlight = v.state === "dispatched" || v.state === "running";
  if (inFlight) {
    if (open !== 1 || attempts[attempts.length - 1]?.outcome !== null) return false;
  } else if (open !== 0) return false;
  if (SLOT_REQUIRED_STATES.includes(v.state) && v.slot === null) return false;
  if (BRANCH_REQUIRED_STATES.includes(v.state) && v.branch === null) return false;
  if (v.state === "integrated" && integ === null) return false;
  if ((v.kind === "manual" || v.kind === "preflight") && attempts.length > 0) return false;
  return true;
}

function isPhaseRecord(v: unknown): v is PhaseRecord {
  return isRec(v) && isStr(v.id) && isStr(v.title) && isStr(v.wave) && isStrArr(v.dependsOn) &&
    isOneOf(GATE_STATES, v.gate) && isInt(v.qaRound) && v.qaRound >= 0 && isBool(v.paused) && isStrOrNull(v.tag);
}

function isInboxItem(v: unknown): v is InboxItem {
  return isRec(v) && isStr(v.id) &&
    isOneOf(["question", "failure", "usage-limit", "landing", "flaky", "qa-cap", "breaker"] as const, v.kind) &&
    isOneOf(["info", "blocking", "critical"] as const, v.severity) && isStrOrNull(v.taskId) && isStr(v.text) &&
    isStrArr(v.options) && isStrOrNull(v.answer) && isIso(v.createdAt);
}

/**
 * Shape guard for a version-1 ledger (§7): every field's type, enum, pattern and finiteness, config within
 * `EXECUTOR_LIMITS`, and the cross-references (task keys, phases, waves, edge endpoints, `seq` >= 1). A newer
 * `schema` returns false (use `ledgerSchemaOf` to tell). Unknown extra fields are accepted.
 */
export function isLedgerV1(v: unknown): v is LedgerV1 {
  if (!isRec(v) || v.schema !== LEDGER_SCHEMA || v.launcher !== "A") return false;
  if (!isStr(v.planId) || !PLAN_ID_PATTERN.test(v.planId) || !isStr(v.planPath)) return false;
  if (!isStr(v.planDigest) || !/^[0-9a-f]{64}$/.test(v.planDigest)) return false;
  const repo = v.repo;
  if (!isRec(repo) || !isStr(repo.key) || !isStr(repo.toplevel) || !isStr(repo.baseBranch) || !isStr(repo.baseCommit)) return false;
  const integ = v.integration;
  if (!isRec(integ) || !isStr(integ.branch) || !isStr(integ.worktree) || !isStr(integ.head)) return false;
  if (!isOneOf(LEDGER_STATUSES, v.status)) return false;
  const orch = v.orchestrator;
  if (!isRec(orch) || !isStr(orch.sessionID) || !isIso(orch.boundAt)) return false;
  if (!isExecutorConfig(v.config)) return false;
  const config: ExecutorConfig = v.config;
  if (!isStr(v.sharedContext) || v.sharedContext.length > config.sharedContextChars) return false;
  if (config.slotsDir !== null && config.slotsDir.length > 0 && v.sharedContext.includes(config.slotsDir)) return false;
  if (!isInt(v.seq) || v.seq < 1) return false;

  if (!Array.isArray(v.waves) || !v.waves.every((w) => isRec(w) && isStr(w.id) && isStrArr(w.phases))) return false;
  const waveIds = new Set<string>((v.waves as Array<{ id: string }>).map((w) => w.id));
  if (!Array.isArray(v.phases) || !v.phases.every(isPhaseRecord)) return false;
  const phases: PhaseRecord[] = v.phases;
  const phaseIds = new Set<string>(phases.map((p) => p.id));
  if (phases.some((p) => !waveIds.has(p.wave))) return false;

  if (!isRec(v.tasks)) return false;
  const tasks = v.tasks;
  for (const key of Object.keys(tasks)) {
    const t = tasks[key];
    if (!isTaskNode(t) || t.id !== key) return false;
    if (t.phase !== null && !phaseIds.has(t.phase)) return false;
  }

  if (!Array.isArray(v.edges)) return false;
  for (const e of v.edges as unknown[]) {
    if (!isRec(e) || !isStr(e.from) || !isStr(e.to) || !isStr(e.evidence)) return false;
    if (!isOneOf(["structural", "explicit", "graph", "contract", "conflict", "llm", "learned"] as const, e.kind)) return false;
    if (!isOneOf(["high", "medium", "low"] as const, e.confidence)) return false;
    if (!hasOwn(tasks, e.to)) return false;
    if (e.from.startsWith("gate:")) {
      if (!phaseIds.has(e.from.slice("gate:".length))) return false;
    } else if (!hasOwn(tasks, e.from)) return false;
  }
  return Array.isArray(v.inbox) && v.inbox.every(isInboxItem);
}

/**
 * Prompt grammar (QA-0.1-21): `prompt = planContext "\n\n" headerLine "\n\n" taskBlock`,
 * `planContext = "PLAN CONTEXT\n" ledger.sharedContext`, `headerLine = header " nonce=" nonce`,
 * `header = "[plan " planId ":" taskId "#" attempt "]"` with attempt = `Attempt.n` (D-b). `taskBlock` belongs to 3.1.4.
 * The child's first-context fail-closed check (3.1.7.a) refuses every tool call of an unbound child whose prompt matches.
 */
export const LAUNCH_HEADER_PATTERN =
  /^\[plan ([a-z0-9][a-z0-9-]{2,40}):((?!\d+#)[A-Za-z0-9][A-Za-z0-9._-]{0,63})#([1-9][0-9]{0,3})\] nonce=([0-9a-f]{32})$/m;

/** The four fields a launch header carries (§7). */
export interface LaunchHeaderFields {
  planId: string;
  taskId: string;
  attempt: number;
  nonce: string;
}

/** Renders `[plan <planId>:<taskId>#<attempt>] nonce=<nonce>`; throws E_INVALID_INPUT when the result would not match `LAUNCH_HEADER_PATTERN`. */
export function formatLaunchHeader(p: LaunchHeaderFields): string {
  const line = `[plan ${p.planId}:${p.taskId}#${p.attempt}] nonce=${p.nonce}`;
  const m = LAUNCH_HEADER_PATTERN.exec(line);
  if (!Number.isInteger(p.attempt) || m === null || m[0] !== line) {
    throw new ExecutorError("E_INVALID_INPUT", "launch header fields do not match the launch header grammar", {
      planId: p.planId, taskId: p.taskId, attempt: p.attempt, nonce: p.nonce,
    });
  }
  return line;
}

/** The first launch header line found in `prompt` (any line, multiline match), or null. */
export function parseLaunchHeader(prompt: string): LaunchHeaderFields | null {
  const m = LAUNCH_HEADER_PATTERN.exec(prompt);
  if (m === null) return null;
  const [, planId, taskId, attempt, nonce] = m;
  if (planId === undefined || taskId === undefined || attempt === undefined || nonce === undefined) return null;
  return { planId, taskId, attempt: Number(attempt), nonce };
}

export type FindingSeverity = "blocking" | "critical" | "major" | "minor" | "nit";
export interface Finding {
  id: string;
  severity: FindingSeverity;
  /** Repo-relative, '/'-separated. */
  files: string[];
  problem: string;
  fix: string;
}
export interface FindingsReport {
  findings: Finding[];
}

/**
 * JSON schema of the QA findings report (§7). Extraction rule (the instruction in 3.1.4 and `QaLoop.parse`):
 * the last ```json fenced block of the final answer, else the whole text.
 * Ids of QaLoop-created tasks are deterministic (idempotent recovery): fix `${phaseId}.FIX${round}-${k}`,
 * re-review `${phaseId}.QA${round + 1}`.
 */
export const FINDINGS_FORMAT = {
  type: "object", additionalProperties: false, required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["id", "severity", "files", "problem", "fix"],
        properties: {
          id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" },
          severity: { enum: ["blocking", "critical", "major", "minor", "nit"] },
          files: { type: "array", items: { type: "string", minLength: 1 } },
          problem: { type: "string", minLength: 1 },
          fix: { type: "string" },
        },
      },
    },
  },
} as const;

const FINDING_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FINDING_KEYS: readonly string[] = ["id", "severity", "files", "problem", "fix"];

function isFinding(v: unknown): v is Finding {
  return isRec(v) && Object.keys(v).every((k) => FINDING_KEYS.includes(k)) && isStr(v.id) && FINDING_ID_PATTERN.test(v.id) &&
    isOneOf(["blocking", "critical", "major", "minor", "nit"] as const, v.severity) &&
    Array.isArray(v.files) && v.files.every((f) => isStr(f) && f.length > 0) &&
    isStr(v.problem) && v.problem.length > 0 && isStr(v.fix);
}

/** True iff `v` validates against `FINDINGS_FORMAT` (additional properties rejected, as the schema says). */
export function isFindingsReport(v: unknown): v is FindingsReport {
  return isRec(v) && Object.keys(v).every((k) => k === "findings") && Array.isArray(v.findings) && v.findings.every(isFinding);
}

// ---------------------------------------------------------------------------------------------------------------
// §8 Provider errors (R3)
// ---------------------------------------------------------------------------------------------------------------

/** A host error as the executor sees it. */
export interface HostError {
  type: string;
  status: number | null;
  message: string;
}

/**
 * Capacity class of a provider error (R3): the `type` decides (`provider.rate-limit`, `provider.internal` -> overload,
 * `provider.quota`); any other type falls back to its status (429 -> rate-limit, 529 -> overload); else null.
 */
export function classifyProviderError(e: Pick<HostError, "type" | "status">): "rate-limit" | "overload" | "quota" | null {
  switch (e.type) {
    case "provider.rate-limit": return "rate-limit";
    case "provider.internal": return "overload";
    case "provider.quota": return "quota";
    default:
      if (e.status === 429) return "rate-limit";
      if (e.status === 529) return "overload";
      return null;
  }
}

/** Outcome of a child execution failure (R3): capacity when `classifyProviderError` says so, else `failed`. */
export function executionFailureOutcome(e: HostError): "capacity" | "failed" {
  return classifyProviderError(e) === null ? "failed" : "capacity";
}

/** Appendix C defaults (plan 4381-4399). Frozen: copy before editing. */
export const EXECUTOR_DEFAULTS: ExecutorConfig = Object.freeze({
  maxParallel: 4,
  slotsDir: null,
  approve: "ask",
  crossPhase: "gate",
  land: "ff-when-clean",
  batchMax: 4,
  maxAttempts: 3,
  qaMaxRounds: 3,
  integrationChecks: "auto",
  phaseSuite: "auto",
  provision: "auto",
  python: "auto",
  sharedContextChars: 12000,
  capacityCooldownMs: 120000,
  capacityPauseMs: 900000,
  wakeDebounceMs: 5000,
  circuitBreaker: Object.freeze({ failureRatio: 0.4, minAttempts: 5, consecutiveFailures: 3 }),
});

// ---------------------------------------------------------------------------------------------------------------
// §8 Interfaces. Every method throws `ExecutorError`.
// ---------------------------------------------------------------------------------------------------------------

/** Ledger persistence (2.2): snapshot plus journal under one writer lock. */
export interface LedgerStore {
  /** pre: no plan dir; isLedgerV1(draft); post: dir, snapshot, journal (ledger-init at seq 1), lock held. err E_EXISTS, E_SCHEMA_INVALID */
  create(draft: LedgerV1, holder: LockHolder): Promise<LedgerWriter>;
  /** Takes the writer lock. err E_LEDGER_NOT_FOUND, E_LOCK_HELD (detail = holder), E_SCHEMA_NEWER, E_SEQ_GAP, E_ILLEGAL_TRANSITION (detail names the event) */
  open(planId: PlanId, holder: LockHolder): Promise<LedgerWriter>;
  /** Only when the lock is stale (dead pid on this host, or heartbeat > 60 s) or the caller is adopting; journals lock-takeover. err E_LOCK_HELD */
  takeover(planId: PlanId, holder: LockHolder, reason: string): Promise<LedgerWriter>;
  /** Lock-free consistent read (retries while snapshot seq != first journal seq). A torn last line is dropped with one warning. */
  read(planId: PlanId): Promise<LedgerV1>;
  list(): Promise<Array<{ planId: PlanId; status: LedgerStatus; toplevel: string; orchestratorSessionID: string; seq: number }>>;
  exportPlan(planId: PlanId): Promise<{ snapshot: LedgerV1; events: ExecutorEvent[] }>;
  /** pre: status completed|aborted; no live writer elsewhere. post: plan dir gone. Returns false when absent. err E_PLAN_STATE, E_LOCK_HELD */
  remove(planId: PlanId): Promise<boolean>;
}

/** The one writer of a plan's ledger (D-e): validates, sequences and persists event batches. */
export interface LedgerWriter {
  readonly planId: PlanId;
  readonly ledger: Readonly<LedgerV1>;
  /** Atomic batch: validates every event against the current ledger, assigns seq and at, writes the lines, fsyncs if any event isDurableEvent.
   *  Resolves after the fsync. err E_ILLEGAL_TRANSITION (nothing written), E_LOCK_LOST, I/O */
  append(events: readonly ExecutorEventInput[]): Promise<Readonly<LedgerV1>>;
  /** Also every 200 events, then rotates the journal. */
  snapshot(): Promise<void>;
  /** Snapshot, then release the lock; idempotent. */
  close(): Promise<void>;
}

/** Counts and critical-path figures of a compiled plan (2.3). */
export interface CompileSummary {
  tasks: number;
  phases: number;
  edges: number;
  workMs: number;
  criticalPathMs: number;
  width: number;
  expectedMakespanMs: number;
  manual: TaskId[];
  warnings: string[];
}

/** Plan text -> draft ledger (2.3). */
export interface PlanCompiler {
  /** Reads the plan (FileSystem) and worktrees (GitRunner). Never writes. post: draft.status is awaiting-residue iff residueRequest.
   *  err E_COMPILE (line), E_CYCLE (minimal cycle), E_INVALID_INPUT (unknown phases/doneBefore) */
  compile(planPath: string, opts: {
    phases?: PhaseId[]; doneBefore?: PhaseId; config: ExecutorConfig; orchestratorSessionID: string; now: IsoTime;
  }): Promise<{ draft: LedgerV1; residueRequest?: { prompt: string; schema: JsonValue; taskIds: TaskId[] }; summary: CompileSummary }>;
  /** Monotone merge, then re-validation. err E_RESIDUE (precise) */
  mergeResidue(draft: LedgerV1, responseText: string): { draft: LedgerV1; summary: CompileSummary };
  /** For router_plan add-tasks. Returns the new nodes and edges plus `reopened` (ready tasks that must go ready->pending). err E_CYCLE, E_INVALID_INPUT */
  addTasks(ledger: LedgerV1, text: string): { tasks: TaskNode[]; edges: Edge[]; reopened: TaskId[] };
  /** Cycles, ids, paths, concurrency closure. */
  validate(ledger: LedgerV1): Array<{ code: string; message: string; taskIds: TaskId[] }>;
}

/** A leased work slot (2.4). */
export interface SlotLease {
  slot: string;
  path: string;
  planId: PlanId;
  owner: string;
  commit: string;
}

/** Pool of provisioned git worktrees (2.4). */
export interface SlotPool {
  /** Never waits: a reset, provisioned slot leased to `owner`, or E_SLOT_UNAVAILABLE. Concurrent calls are serialized; never double-leases.
   *  A task that already holds a slot gets the same slot back. err E_SLOT_UNAVAILABLE, E_PROVISION, E_SLOT_BROKEN */
  acquire(planId: PlanId, owner: string, baseCommit: string): Promise<SlotLease>;
  acquireSpecial(planId: PlanId, kind: "integration" | "ci"): Promise<SlotLease>;
  /** Checkout detached + clean tracked; re-provision on manifest drift. */
  reset(slot: string, commit: string): Promise<void>;
  cleanForChecks(slot: string): Promise<void>;
  /** Idempotent. */
  release(slot: string): Promise<void>;
  get(slot: string): Promise<SlotRecord | null>;
  list(planId?: PlanId): Promise<SlotRecord[]>;
  /** Removes only marked slots of completed/aborted plans, or unknown plans after 7 d; never follows links; reports unmarked dirs */
  gc(isFinished: (planId: PlanId) => Promise<boolean | null>): Promise<{ removed: string[]; reported: string[] }>;
}

/** Called after the fsync of the corresponding journal batch. */
export interface IntegrationListener {
  onIntegrated(taskId: TaskId): void;
  onConflict(taskId: TaskId): void;
  onFailed(taskId: TaskId): void;
  onReverted(taskId: TaskId): void;
  onGate(phaseId: PhaseId, gate: GateState): void;
  onInbox(item: InboxItem): void;
}

/** Serial rebase/check/fast-forward queue, phase suite and landing (3.2). */
export interface IntegrationQueue {
  /** pre: each id is verified with slot and branch. Idempotent (an id already queued or integrating is ignored). Does not dequeue while the plan is paused.
   *  Dequeue journals verified->integrating (durable) before any git step. err E_PLAN_STATE, E_DISPOSED */
  enqueue(taskIds: readonly TaskId[]): void;
  /** Must run before the first dequeue after open/recovery. For each integrating task: if its rebased tip is an ancestor of the integration branch -> integrated;
   *  otherwise roll back git and keep the task integrating, at the front of the queue. Idempotent. */
  resume(): Promise<{ completed: TaskId[]; rolledBack: TaskId[] }>;
  /** Starts the phase suite when §3.3's precondition holds; idempotent. */
  checkPhase(phaseId: PhaseId): Promise<void>;
  /** ff-when-clean or manual; never force, never non-ff. */
  land(): Promise<{ landed: boolean; inbox: InboxItem | null }>;
  /** Stops dequeuing, rolls back the step in progress, then journals integrating->cancelled. */
  abort(): Promise<void>;
  queued(): readonly TaskId[];
  dispose(): Promise<void>;
}

/** Who holds a path lease (2.1, scope `until-integrated`). */
export interface LeaseView {
  holder(path: string): { taskId: TaskId | null; sessionID: string } | null;
}
export interface TaskRoute {
  agent: string;
  model: { providerID: string; modelID: string; variant: string | null };
  provider: string;
  heavy: boolean;
}
export interface CapacityView {
  routeOf(task: TaskNode): TaskRoute;
  free(provider: string, heavy: boolean): number;
}
export interface ScheduledTask {
  taskId: TaskId;
  route: TaskRoute;
  bottomLevelMs: number;
}

/** Critical-path scheduler (3.1.2); pure, deterministic, never throws for a valid ledger. */
export interface Scheduler {
  /** Tasks that are ready, not manual/preflight, not in inFlight, in an unpaused phase of a running plan, with every edge satisfied
   *  (task source integrated|done; gate source passed), R16, no held predicted write (soft), within free capacity counted down greedily.
   *  Order: bottom level desc, ties by plan order. */
  readySet(ledger: LedgerV1, inFlight: ReadonlySet<TaskId>, leases: LeaseView, capacity: CapacityView): ScheduledTask[];
  /** pending->ready and blocked->ready candidates. */
  promotable(ledger: LedgerV1): { toReady: TaskId[]; unblock: TaskId[] };
  manualReady(ledger: LedgerV1): TaskId[];
  /** Returns the learned edge to append, or null if it exists or would make a cycle (then R6: lease-unresolvable) */
  addLearnedEdge(ledger: LedgerV1, holder: TaskId, blocked: TaskId, evidence: string): Edge | null;
}

/** A provider signal as the capacity controller sees it (3.1.3). */
export interface ProviderSignal {
  source: "retry-hook" | "retry-scheduled" | "step-failed" | "execution-failed";
  sessionID: string;
  stepKey: string;
  provider: string;
  error: HostError;
  at: IsoTime;
}

/** Adaptive per-provider concurrency (3.1.3, D13 495-535). */
export interface CapacityController {
  /** 1..maxParallel */
  limit(provider: string): number;
  canAcquire(provider: string, heavy: boolean): boolean;
  /** err E_CAPACITY */
  acquire(provider: string, heavy: boolean, taskId: TaskId, attempt: number): { id: string };
  /** Idempotent; growth only after a quiet cooldown. */
  release(token: { id: string }, result: "success" | "other"): void;
  /** Dedupe per stepKey. The first rate-limit/overload signal of a step halves the limit (floor 1) and holds it for cooldown; quota -> pause.
   *  Returns the inbox input for the runtime to raise once per pause. */
  onSignal(s: ProviderSignal): {
    decreased: boolean; pausedUntil: IsoTime | null; inbox: Omit<InboxItem, "id" | "createdAt" | "answer"> | null;
  };
  /** True only when planChild and (provider paused or the step's first retry signal is older than capacityCooldownMs). */
  shouldStopRetry(i: { sessionID: string; stepKey: string; provider: string; planChild: boolean }): boolean;
  pausedUntil(provider: string): IsoTime | null;
  snapshot(): JsonValue;
}

// ---- TaskLauncher (3.1.5; launcher A only, ADR D14 548-645)

/** The newest router-tool capture of a session in this process (§9). */
export interface RetainedContextInfo {
  sessionID: string;
  callID: string;
  messageID: string;
  agent: string;
  capturedAt: IsoTime;
  /** +1 per capture in this process. */
  epoch: number;
}

export type LaunchGate =
  | { ok: true; context: RetainedContextInfo; ageMs: number }
  | {
      ok: false;
      /** "awaiting-first-router-call" is guard 6, "context-stale" is guard 2. */
      reason: "no-context" | "awaiting-first-router-call" | "context-stale" | "disposed";
      /** Guard 3: the refresh wake, keyed "stale-context:<epoch>". */
      wake: { reason: "stale-context"; stateKey: string } | null;
    };

export interface LaunchRequest {
  planId: PlanId;
  taskId: TaskId;
  attempt: number;
  nonce: string;
  orchestratorSessionID: string;
  contextEpoch: number;
  route: TaskRoute;
  role: string;
  /** Route `needs`. */
  grant: string[];
  /** Slot path. */
  workRoot: string;
  /** §7 grammar; the header must match (planId, taskId, attempt, nonce). */
  prompt: string;
}

export interface LaunchHooks {
  /** Called inside onCreated after the binding (role, grant, workRoot) is written and before the child is prompted.
   *  The runtime journals attempt-child + dispatched->running (fsync). A throw aborts the launch -> ChildEnd lost(runner-error). */
  onChildCreated(childSessionID: string): Promise<void>;
  /** A child created after the confirmation timeout (R4): "adopt" only if this attempt is still the latest and the task is ready. */
  onLateChild(childSessionID: string): Promise<"adopt" | "refuse">;
}

export type LaunchConfirmation =
  | { kind: "confirmed"; childSessionID: string; latencyMs: number }
  /** `taskError` is R1: a task-class error of the executor's own launch preparation. */
  | { kind: "unconfirmed"; reason: "timeout" | "threw"; error: string | null; taskError: boolean };

export type CancelReason = "abort" | "blocked" | "superseded" | "dispose";

export type ChildEnd =
  | { kind: "completed"; childSessionID: string; text: string; endedAt: IsoTime }
  | { kind: "failed"; childSessionID: string; error: HostError; endedAt: IsoTime }
  | { kind: "capacity"; childSessionID: string; error: HostError; endedAt: IsoTime }
  | { kind: "interrupted"; childSessionID: string | null; reason: CancelReason; endedAt: IsoTime }
  | {
      kind: "lost"; childSessionID: string | null;
      reason: "unconfirmed" | "unrequested-interrupt" | "runner-error" | "restart"; endedAt: IsoTime;
    };

export interface LaunchHandle {
  taskId: TaskId;
  attempt: number;
  nonce: string;
  contextEpoch: number;
  contextAgeMs: number;
  startedAt: IsoTime;
  /** Settles within LAUNCH_CONFIRM_TIMEOUT_MS (Clock). */
  confirmation: Promise<LaunchConfirmation>;
  /** Settles exactly once; never rejects. */
  completion: Promise<ChildEnd>;
}

/** Starts and cancels plan children through the retained router-call context (3.1.5). */
export interface TaskLauncher {
  /** Pure read of in-memory state. ok only with a capture from `orchestratorSessionID` taken in this process (guard 6) whose epoch is not stale. */
  gate(orchestratorSessionID: string): LaunchGate;
  /** pre: gate ok for req.contextEpoch; the task is dispatched with its open attempt fsynced; the capacity token, slot and leases are held.
   *  Does: the decision row, recordDispatchStart and the D2 in-flight registration (DispatchBookkeeping); then ChildRunner.run with detached:true,
   *  an executor-owned AbortController (combined with the plugin lifetime), explicit agent and model, cwd = workRoot. Emits the context-age metric.
   *  Unconfirmed or threw-before-confirm -> markStale(epoch) unless taskError. Classifies the end: runner result -> completed; else the terminal
   *  session.execution.* event (waits <= CHILD_END_GRACE_MS): failed -> executionFailureOutcome; interrupted -> `interrupted` if cancel() was called,
   *  else `lost` (guard 5); no event -> lost(runner-error). The fallback trigger (D2): a terminal event before the runner settles resolves completion,
   *  with text from HostSessions.context (last assistant message).
   *  err (synchronous, before any host call): E_NO_CONTEXT (gate not ok / epoch mismatch), E_INVALID_INPUT (header mismatch) */
  launch(req: LaunchRequest, hooks: LaunchHooks): LaunchHandle;
  /** Requested interrupt: records the request, aborts the executor-owned signal, HostSessions.interrupt(child) if known. Idempotent. */
  cancel(taskId: TaskId, attempt: number, reason: CancelReason): Promise<void>;
  inFlight(): ReadonlyArray<{ taskId: TaskId; attempt: number; childSessionID: string | null; startedAt: IsoTime }>;
  /** Aborts every owned signal; journals nothing (recovery closes those attempts as lost). */
  dispose(): Promise<void>;
}

/**
 * Journals `wake` (durable), then HostSessions.synthetic({..., resume: true}); debounced by wakeDebounceMs;
 * never the same stateKey twice (D15 668-671).
 */
export interface Waker {
  wake(reason: WakeReason, stateKey: string): Promise<"sent" | "debounced" | "duplicate" | "failed">;
}

/**
 * The executor's public surface, consumed by 4.1 (tool/command) and 5.1 (3.1.6).
 * Every action on a plan whose orchestrator is another live session -> E_NOT_OWNER. Wrong status -> E_PLAN_STATE.
 */
export interface ExecutorRuntime {
  compile(i: { path: string; phases?: PhaseId[]; doneBefore?: PhaseId; sessionID: string }):
    Promise<{ planId: PlanId; summary: CompileSummary; residuePrompt: string | null }>;
  residue(planId: PlanId, text: string, sessionID: string): Promise<CompileSummary>;
  /** awaiting-approval -> running; config snapshot; slotsDir resolved. */
  approve(planId: PlanId, sessionID: string): Promise<void>;
  /** The full board with Appendix D metrics. */
  status(planId: PlanId | null, sessionID: string): Promise<string>;
  ready(planId: PlanId): Promise<{ launchable: TaskId[]; manual: TaskId[] }>;
  addTasks(planId: PlanId, text: string, sessionID: string): Promise<{ added: TaskId[]; reopened: TaskId[] }>;
  answer(planId: PlanId, inboxId: string, text: string, sessionID: string): Promise<void>;
  /** manual/preflight in ready only; else E_INVALID_INPUT */
  done(planId: PlanId, taskId: TaskId, sessionID: string): Promise<void>;
  pause(planId: PlanId, sessionID: string): Promise<void>;
  resume(planId: PlanId, sessionID: string): Promise<void>;
  /** Children cancelled after the fsync; queue.abort(); terminal states untouched. */
  abort(planId: PlanId, sessionID: string): Promise<void>;
  land(planId: PlanId, sessionID: string): Promise<void>;
  adopt(planId: PlanId, sessionID: string): Promise<void>;
  gc(): Promise<{ removed: string[]; reported: string[] }>;
  exportPlan(planId: PlanId): Promise<string>;
  /** completed/aborted only: gc, deleteRefs omr/<planId>/, LedgerStore.remove */
  purge(planId: PlanId, sessionID: string): Promise<void>;
  // Host feeds (3.1.7 wiring). Never throw into the host.
  /** Refresh after capture; lifts guard 6; re-evaluates the ready set. */
  onRouterToolCall(sessionID: string): void;
  onHostEvent(e: HostSessionEvent): void;
  /** stop only for plan children */
  onRetryHook(i: { sessionID: string; stepKey: string; error: HostError }): { stop: boolean };
  /** Also used by RecoveryService; ignores closed attempts. */
  onChildEnd(taskId: TaskId, attempt: number, end: ChildEnd): Promise<void>;
  /** The Appendix B plan line (+ the stale suffix, 4361-4362). */
  planLine(sessionID: string): string | null;
  start(): Promise<void>;
  dispose(): Promise<void>;
}

/** What recovery decided for one task (4.2.4; the matrix is in the memo §8). */
export interface ReconcileAction {
  taskId: TaskId;
  from: TaskState;
  evidence: "finished" | "alive" | "lost" | "none";
  action: "adopt" | "process-result" | "requeue-lost" | "reverify" | "re-enqueue" | "resume-integration" | "interrupt-orphan" | "none";
}

/** Restart recovery and orchestrator adoption (4.2.4, D16 679-707). */
export interface RecoveryService {
  /** Once per process; only ledgers in running|paused with repo.toplevel === this session's toplevel. Second call is a no-op. */
  recover(): Promise<Array<{ planId: PlanId; actions: ReconcileAction[] }>>;
  /** Takes over a stale lock and journals orchestrator-bound(adopt); the launch gate then waits for that session's first router call. err E_LOCK_HELD */
  adopt(planId: PlanId, sessionID: string): Promise<void>;
}

/** Unattended-run policy: inbox, parking, answers, the circuit breaker (4.2.2). */
export interface UnattendedPolicy {
  /** Dedupe: an open item with the same kind+taskId+text is returned instead. Journals inbox-added (durable); wakes ("inbox", "inbox:<id>") unless closed at creation. */
  raise(i: Omit<InboxItem, "id" | "createdAt" | "answer"> & { answer?: string }): Promise<InboxItem>;
  /** From running (escalate|ambiguity|qa-unparsable) or conflict|failed|reverted (exhausted). post: parked; transitive dependents -> blocked
   *  (their in-flight children cancelled); one inbox item. */
  park(taskId: TaskId, cause: "escalate" | "ambiguity" | "qa-unparsable" | "exhausted", text: string): Promise<InboxItem>;
  /** pre: item open. post: inbox-answered; attempt-context on the latest attempt; parked -> ready. err E_INVALID_INPUT */
  answer(inboxId: string, text: string): Promise<{ resumed: TaskId | null }>;
  /** blocked -> ready where every dependency is integrated|done. */
  unblock(): Promise<TaskId[]>;
  /** Feeds a counted attempt (§4). A trip pauses the phase, raises one critical breaker item and wakes once. */
  recordAttempt(phaseId: PhaseId, a: Attempt): Promise<{ tripped: boolean }>;
}

/** QA rounds: parse findings, create fix and re-review tasks, close the gate (4.2.3). */
export interface QaLoop {
  /** Pure; extraction rule in §7. */
  parse(text: string): { ok: true; report: FindingsReport } | { ok: false; error: string };
  /** pre: the qa task is done; gate qa-running. post: §3.3 (passed | pending with fix and re-review tasks created and edges added, round+1
   *  | cap reached -> qa-cap critical item and phase paused); deferred minor/nit findings recorded as closed info items. Fix tasks of one round have disjoint writes. */
  onQaResult(taskId: TaskId, report: FindingsReport): Promise<"passed" | "next-round" | "cap-reached">;
  /** A phase with no qa task -> passed. */
  onAwaitingQa(phaseId: PhaseId): Promise<void>;
}

// Adapters over existing modules (§8): in-process, not I/O; doubles stand in for them in tests.

/** The routing kernel as the executor sees it. */
export interface RouteResolver {
  route(task: TaskNode): TaskRoute;
}
/** binding.ts: binds a child session to a role, grant and work root. */
export interface RoleBindings {
  bind(i: { childSessionID: string; role: string; agent: string; workRoot: string; grant: string[] }): void;
}
/** Path leases of scope `until-integrated` (2.1); provides `LeaseView`. */
export type LeaseService = LeaseView;
/** Dispatch bookkeeping the launcher drives around a launch (D2): decision row, dispatch start, in-flight registry. */
export interface DispatchBookkeeping {
  decisionRow(req: LaunchRequest): void;
  recordDispatchStart(req: LaunchRequest, startedAt: IsoTime): void;
  registerInFlight(taskId: TaskId, attempt: number, childSessionID: string | null): void;
  unregisterInFlight(taskId: TaskId, attempt: number): void;
}
/** Deterministic verification of a task in its slot. */
export interface SlotVerifier {
  verify(task: TaskNode, slot: SlotLease, attempt: Attempt): Promise<{ verdict: Verdict; findings: string; ref: string }>;
}

// ---------------------------------------------------------------------------------------------------------------
// §9 Seams (no real I/O in unit tests)
// ---------------------------------------------------------------------------------------------------------------

/** Time and entropy; `randomHex` is the only entropy source (nonce). */
export interface Clock {
  now(): number;
  iso(ms?: number): IsoTime;
  setTimer(ms: number, fn: () => void): { readonly id: number };
  clearTimer(h: { readonly id: number }): void;
  randomHex(bytes: number): string;
}

export interface ProcessResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
}
export interface ProcOpts {
  cwd: string;
  timeoutMs: number;
  env?: Readonly<Record<string, string>>;
  stdin?: string;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}
/** No shell; a non-zero exit is a result; throws only spawn/ETIMEDOUT/EOUTPUT. */
export interface GitRunner {
  run(args: readonly string[], o: ProcOpts): Promise<ProcessResult>;
}
/** Never a shell. `pid`/`hostname`/`isAlive` serve lock staleness (2.2.2.e). */
export interface Spawner {
  run(command: string, args: readonly string[], o: ProcOpts): Promise<ProcessResult>;
  readonly pid: number;
  readonly hostname: string;
  isAlive(pid: number): boolean;
}
export interface FsStat {
  kind: "file" | "dir" | "symlink" | "junction" | "other";
  size: number;
  mtimeMs: number;
}
/** Errors carry `.code` (ENOENT, EEXIST, EPERM, EBUSY...); the 2 s EPERM/EBUSY retry belongs to the caller. */
export interface FileSystem {
  readText(p: string): Promise<string>;
  writeText(p: string, data: string, o?: { exclusive?: boolean; fsync?: boolean }): Promise<void>;
  appendText(p: string, data: string, o: { fsync: boolean }): Promise<void>;
  rename(a: string, b: string): Promise<void>;
  rm(p: string, o: { recursive: boolean }): Promise<void>;
  mkdir(p: string): Promise<void>;
  readdir(p: string): Promise<string[]>;
  lstat(p: string): Promise<FsStat | null>;
  realpath(p: string): Promise<string>;
  fsyncDir(p: string): Promise<void>;
}

export interface HostSessionContext {
  messages: Array<{ role: "user" | "assistant" | "idle"; text: string | null; outcome: string | null }>;
}
export type HostSessionEvent =
  | { type: "step.started"; sessionID: string; providerID: string; modelID: string; at: IsoTime }
  | { type: "retry"; sessionID: string; stepKey: string; source: "hook" | "scheduled"; error: HostError; at: IsoTime }
  | { type: "step.failed" | "execution.failed"; sessionID: string; error: HostError; at: IsoTime }
  | { type: "execution.interrupted" | "execution.completed"; sessionID: string; at: IsoTime };

/** O6b/C7: context, interrupt, synthetic; `move` and `get` as used in v2-client.ts:129,198. */
export interface HostSessions {
  get(sessionID: string): Promise<{ id: string; parentID: string | null } | null>;
  context(sessionID: string): Promise<HostSessionContext>;
  activity(sessionID: string): Promise<"active" | "inactive" | "unknown">;
  interrupt(sessionID: string): Promise<void>;
  synthetic(i: {
    sessionID: string; text: string; description: string; metadata: Record<string, JsonValue>; resume: true;
  }): Promise<void>;
  move(sessionID: string, directory: string): Promise<void>;
  onEvent(listener: (e: HostSessionEvent) => void): () => void;
}

export interface ChildRunRequest {
  parentSessionID: string;
  prompt: string;
  agent: string;
  model: { providerID: string; modelID: string; variant: string | null };
  cwd: string;
  /** Executor-owned. */
  signal: AbortSignal;
  /** QA-0.1-25: the runner must NOT add the retained toolContext.signal and must NOT forward progress, even while that call is active. */
  detached: true;
  onCreated(childSessionID: string): Promise<void>;
  onConfirmed?(childSessionID: string): Promise<void>;
}
export interface ChildRunner {
  run(r: ChildRunRequest): Promise<{ sessionID: string; text: string }>;
  dispose(sessionID: string): Promise<void>;
  /** The newest router-tool capture of that session in this process. */
  retainedContext(sessionID: string): RetainedContextInfo | null;
  onContextCaptured(listener: (c: RetainedContextInfo) => void): () => void;
}
