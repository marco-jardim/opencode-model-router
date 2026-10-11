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
/** Phase id grammar (A1-7): also a valid git ref component, no "..", no trailing ".", no ".lock" suffix. */
export const PHASE_ID_PATTERN = /^(?!.*\.\.)(?!.*\.$)(?!.*\.lock$)[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
/** Wave id grammar (A1-7): the same as a phase id. */
export const WAVE_ID_PATTERN = PHASE_ID_PATTERN;
/** A full git object id, SHA-1 or SHA-256, lowercase hex (A1-7). */
export const GIT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** An absolute path: drive letter, UNC or POSIX root (A1-7). */
export const ABSOLUTE_PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+|\/)/;

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
  /** 1-based current QA round (compile sets 1); only `qa-next-round` and `cap-fix` change it (+1 each). */
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

/** Id prefix per inbox kind (A1-7): ids are "<P>-<n>". */
export const INBOX_ID_PREFIX: Readonly<Record<InboxKind, string>> =
  { question: "Q", failure: "F", "usage-limit": "U", landing: "L", flaky: "K", "qa-cap": "R", breaker: "B" };
/** Inbox id grammar (A1-7): prefix letter, "-", a positive integer without leading zeros. */
export const INBOX_ID_PATTERN = /^([QFULKRB])-([1-9][0-9]{0,8})$/;

/** `"<P>-<n>"` for `kind`; throws E_INVALID_INPUT unless `n` is an integer in 1..999999999. */
export function formatInboxId(kind: InboxKind, n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 999_999_999) {
    throw new ExecutorError("E_INVALID_INPUT", "inbox number out of range", { kind, n });
  }
  return `${INBOX_ID_PREFIX[kind]}-${n}`;
}

/** 1 + the largest numeric part across all inbox ids of every prefix (1 for an empty inbox; malformed ids are ignored). */
export function nextInboxNumber(l: Pick<LedgerV1, "inbox">): number {
  let max = 0;
  for (const item of l.inbox) {
    const m = INBOX_ID_PATTERN.exec(item.id);
    if (m !== null && m[2] !== undefined) max = Math.max(max, Number(m[2]));
  }
  return max + 1;
}

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

/**
 * Payload of `integration-step` events only (D-d, A1-3); the queue is rebuilt from the snapshot, the history journal's open
 * entries and git. `kind`, `phaseId` and `baseHead` are fixed for the entry; `taskIds` and `candidate` may change (latest wins).
 * A step of `fast-forward`, `revert-fast-forward`, `tag` or `land` carries its target commit in `candidate`.
 */
export interface IntegrationEntry {
  /** "i-<seq of first start>". */
  id: string;
  kind: "task" | "batch" | "revert" | "phase-suite" | "tag" | "land";
  phaseId: PhaseId | null;
  taskIds: TaskId[];
  slot: string | null;
  baseHead: string;
  candidate: string | null;
}

/** An integration entry whose `closes` end has not been journaled yet, as derived from the history journal (A1-3). */
export interface OpenIntegrationEntry {
  entry: IntegrationEntry;
  /** `seq` of the entry's first start. */
  startSeq: number;
  /** The entry's latest step. */
  step: IntegrationStep;
  edge: "start" | "end";
  result: IntegrationStepResult | null;
}

/** What `IntegrationQueue.resume()` did (A1-3). `halted` is true when the integration branch moved unexpectedly (plan paused). */
export interface ResumeReport {
  completed: TaskId[];
  rolledBack: TaskId[];
  halted: boolean;
  entries: Array<{
    id: string;
    kind: IntegrationEntry["kind"];
    action: "completed" | "rolled-back" | "rerun" | "tagged" | "none";
  }>;
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
  // The three `*>blocked` rows are Q: a revert and its dependents are one Q batch (A1-2).
  "ready>dispatched": ["Rt"], "ready>blocked": ["Q"], "ready>cancelled": ["Rt"], "ready>running": ["Rc", "Rt"],
  "ready>done": ["Rt"], "ready>pending": ["Rt"],
  "dispatched>running": ["Rt"], "dispatched>ready": ["Rt"], "dispatched>failed": ["Rt"], "dispatched>blocked": ["Q"],
  "dispatched>cancelled": ["Rt"],
  "running>completed": ["Rt"], "running>failed": ["Rt"], "running>parked": ["P"], "running>ready": ["Rt"],
  "running>blocked": ["Q"], "running>cancelled": ["Rt"],
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

/** Phase-gate state machine (A1-1; 12 legal pairs); replay checks it like task transitions. `passed` is terminal. */
export const GATE_TRANSITIONS: Readonly<Record<GateState, readonly GateState[]>> = {
  pending: ["suite-running", "awaiting-qa"],
  "suite-running": ["awaiting-qa", "suite-failed"],
  "suite-failed": ["pending", "suite-running"],
  "awaiting-qa": ["qa-running", "passed", "pending"],
  "qa-running": ["awaiting-qa", "pending", "passed"],
  passed: [],
};

/** Why a gate changed; one per `gate-changed` event (A1-1). */
export type GateTrigger =
  | "phase-integrated" | "suite-passed" | "suite-culprit-found" | "culprit-reverted" | "suite-rerun"
  | "qa-dispatched" | "qa-requeued" | "qa-cap" | "qa-next-round" | "qa-clean" | "no-open-qa" | "cap-accepted" | "cap-fix";

/** Key of a legal gate transition: `"<from>><to>"`. */
export type GateTransitionKey = `${GateState}>${GateState}`;

/** Triggers allowed per legal gate pair (A1-1): exactly the 12 keys of `GATE_TRANSITIONS`. */
export const GATE_TRANSITION_TRIGGERS: Readonly<Partial<Record<GateTransitionKey, readonly GateTrigger[]>>> = {
  "pending>suite-running": ["phase-integrated"],
  "pending>awaiting-qa": ["phase-integrated"],
  "suite-running>awaiting-qa": ["suite-passed"],
  "suite-running>suite-failed": ["suite-culprit-found"],
  "suite-failed>pending": ["culprit-reverted"],
  "suite-failed>suite-running": ["suite-rerun"],
  "awaiting-qa>qa-running": ["qa-dispatched"],
  "awaiting-qa>passed": ["no-open-qa", "cap-accepted"],
  "awaiting-qa>pending": ["cap-fix"],
  "qa-running>awaiting-qa": ["qa-requeued", "qa-cap"],
  "qa-running>pending": ["qa-next-round"],
  "qa-running>passed": ["qa-clean"],
};

/** Module that may journal a gate change: a task owner or `QL` (QaLoop). */
export type GateOwner = TransitionOwner | "QL";

/** Who writes each legal gate transition (A1-1). */
export const GATE_TRANSITION_OWNERS: Readonly<Partial<Record<GateTransitionKey, readonly GateOwner[]>>> = {
  "pending>suite-running": ["Q"],
  "pending>awaiting-qa": ["Q"],
  "suite-running>awaiting-qa": ["Q"],
  "suite-running>suite-failed": ["Q"],
  "suite-failed>pending": ["Q"],
  "suite-failed>suite-running": ["Q"],
  "awaiting-qa>qa-running": ["Rt", "Rc"],
  "awaiting-qa>passed": ["QL"],
  "awaiting-qa>pending": ["QL"],
  "qa-running>awaiting-qa": ["Rt", "P", "Q", "QL"],
  "qa-running>pending": ["QL"],
  "qa-running>passed": ["QL"],
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
      name: "context-age"; taskId: TaskId; attempt: number; bootID: string; epoch: number; callID: string; capturedAt: IsoTime;
      ageMs: number; // D14 guard 4
      result: "confirmed" | "timeout" | "threw" | "superseded" | "task-error" | "hook-failed";
    }
  | {
      name: "capacity"; provider: string; change: "decrease" | "increase" | "pause" | "resume" | "retry-stop";
      from: number; to: number; until: IsoTime | null; errorType: string | null; status: number | null;
    }
  | { name: "counter"; key: string; value: number; labels: Record<string, string> }; // other Appendix D rows

/** `Omit` applied to each member of a union (plain `Omit` collapses a discriminated union). */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * Batch framing (A1-2): `batch` is the `seq` of the batch's first event, `last` marks its final event. The first event of a file and any
 * event after `last: true` has `batch === seq`; the others share the previous `batch`. A trailing batch without `last: true` is dropped at load.
 */
type E<T extends string, P> = { seq: number; at: IsoTime; batch: number; last: boolean; type: T } & P;

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
  | E<"task-footprint", { taskId: TaskId; footprint: Footprint }> // durable; monotone (A1-8), owner Rt, row 18b only
  | E<"integration-step", {
      edge: "start" | "end"; entry: IntegrationEntry; step: IntegrationStep;
      result: IntegrationStepResult | null; detail: string | null; failingIds: string[];
      /** True on the one end event that finishes the entry (A1-3). */
      closes: boolean;
    }>
  | E<"gate-changed", { phaseId: PhaseId; from: GateState; to: GateState; trigger: GateTrigger; qaRound: number }>
  | E<"phase-paused", { phaseId: PhaseId; paused: boolean; reason: string }>
  | E<"phase-tagged", { phaseId: PhaseId; tag: string }>
  | E<"inbox-added", { item: InboxItem }>
  | E<"inbox-answered", { id: string; answer: string }>
  | E<"wake", { reason: WakeReason; stateKey: string }>
  | E<"metric", { metric: MetricPayload }>;

/** An event as callers submit it: the store assigns `seq`, `batch` and `last`, the Clock supplies `at` (§6, A1-2). */
export type ExecutorEventInput = DistributiveOmit<ExecutorEvent, "seq" | "at" | "batch" | "last">;

/** A batch computed against the ledger it applies to; runs synchronously inside the writer's serialization and must be pure (A1-2). */
export type BatchBuilder = (ledger: Readonly<LedgerV1>) => readonly ExecutorEventInput[];

/** False only for `metric` and for a `task-transition` into a non-durable state; true means fsync (§6, D8). */
export function isDurableEvent(e: ExecutorEventInput): boolean {
  if (e.type === "metric") return false;
  if (e.type === "task-transition") return DURABLE_TASK_STATES.includes(e.to);
  return true;
}

/** Event types copied to the never-rotated `history.jsonl` (A1-3). */
export type HistoryEventType = "metric" | "integration-step" | "attempt-verdict" | "wake";
const HISTORY_EVENT_TYPES: readonly string[] = ["metric", "integration-step", "attempt-verdict", "wake"];

/** True for the four history-class event types (A1-3). */
export function isHistoryEvent(e: { type: string }): boolean {
  return HISTORY_EVENT_TYPES.includes(e.type);
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

/** Types and enums of an `ExecutorConfig`, ignoring numeric ranges (those are `config-limits`). */
function isConfigShape(v: unknown): v is ExecutorConfig {
  if (!isRec(v)) return false;
  if (!isNum(v.maxParallel) || !isNum(v.batchMax) || !isNum(v.maxAttempts) || !isNum(v.qaMaxRounds)) return false;
  if (!isStrOrNull(v.slotsDir)) return false;
  if (v.approve !== "ask" && v.approve !== "auto") return false;
  if (v.crossPhase !== "gate" && v.crossPhase !== "inferred") return false;
  if (v.land !== "ff-when-clean" && v.land !== "manual") return false;
  if (!(v.integrationChecks === "auto" || isRunCommandRefs(v.integrationChecks))) return false;
  if (!(v.phaseSuite === "auto" || v.phaseSuite === "off" || isRunCommandRefs(v.phaseSuite))) return false;
  if (!(v.provision === "auto" ||
    (isRec(v.provision) && Object.values(v.provision).every((m) => Array.isArray(m) && m.every(isStrArr))))) return false;
  if (!isStr(v.python)) return false;
  if (!isNum(v.sharedContextChars) || !isNum(v.capacityCooldownMs) || !isNum(v.capacityPauseMs) || !isNum(v.wakeDebounceMs)) {
    return false;
  }
  const cb = v.circuitBreaker;
  return isRec(cb) && isNum(cb.failureRatio) && isNum(cb.minAttempts) && isNum(cb.consecutiveFailures);
}

/** True iff every numeric field of a shape-valid config is within `EXECUTOR_LIMITS` (integers where the field is a count). */
function configWithinLimits(c: ExecutorConfig): boolean {
  const L = EXECUTOR_LIMITS;
  return inRange(c.maxParallel, L.maxParallel, true) && inRange(c.batchMax, L.batchMax, true) &&
    inRange(c.maxAttempts, L.maxAttempts, true) && inRange(c.qaMaxRounds, L.qaMaxRounds, true) &&
    inRange(c.sharedContextChars, L.sharedContextChars, true) && inRange(c.capacityCooldownMs, L.capacityCooldownMs, true) &&
    inRange(c.capacityPauseMs, L.capacityPauseMs, true) && inRange(c.wakeDebounceMs, L.wakeDebounceMs, true) &&
    inRange(c.circuitBreaker.failureRatio, L.failureRatio, false) && inRange(c.circuitBreaker.minAttempts, L.minAttempts, true) &&
    inRange(c.circuitBreaker.consecutiveFailures, L.consecutiveFailures, true);
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

/** Task states that hold no slot (A1-7 `slot-forbidden`): the slot is released on entering them. */
const SLOT_FORBIDDEN_STATES: readonly TaskState[] =
  ["pending", "blocked", "parked", "done", "cancelled", "integrated", "reverted"];

/** One violated invariant: a stable `code` and the JSON path `at` of the offending value (A1-7). */
export interface LedgerViolation {
  code: string;
  /** JSON path, e.g. `$.tasks.T1.slot`. */
  at: string;
}

/** Types, enums, finite numbers and patterns of a task node; no cross-field invariants. */
function isTaskShape(v: unknown): v is TaskNode {
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
  return integ === null || (isRec(integ) && isStr(integ.from) && isStr(integ.to));
}

/** Cross-field invariants of a shape-valid task node, as violations at path `at` (A1-7). */
function taskInvariantViolations(t: TaskNode, at: string): LedgerViolation[] {
  const out: LedgerViolation[] = [];
  const add = (code: string, sub: string): void => { out.push({ code, at: `${at}${sub}` }); };
  const attempts = t.attempts;
  if (!attempts.every((a, i) => a.n === i + 1)) add("attempt-n", ".attempts");
  const open = attempts.filter((a) => a.outcome === null).length;
  const last = attempts[attempts.length - 1];
  if (t.state === "dispatched" || t.state === "running") {
    if (open !== 1 || last?.outcome !== null) add("open-attempt", ".attempts");
  } else if (open !== 0) add("open-attempt", ".attempts");
  if (SLOT_REQUIRED_STATES.includes(t.state) && t.slot === null) add("slot-required", ".slot");
  if (SLOT_FORBIDDEN_STATES.includes(t.state) && t.slot !== null) add("slot-forbidden", ".slot");
  if (BRANCH_REQUIRED_STATES.includes(t.state) && t.branch === null) add("branch-required", ".branch");
  if (t.state === "integrated" && t.integrated === null) add("integrated-missing", ".integrated");
  if (t.integrated !== null && !(GIT_ID_PATTERN.test(t.integrated.from) && GIT_ID_PATTERN.test(t.integrated.to))) {
    add("git-id", ".integrated");
  }
  if ((t.kind === "manual" || t.kind === "preflight") && attempts.length > 0) add("manual-attempts", ".attempts");
  attempts.forEach((a, i) => {
    if ((a.outcome === null) !== (a.endedAt === null) || (a.endedAt !== null && Date.parse(a.endedAt) < Date.parse(a.startedAt))) {
      add("attempt-ended-pair", `.attempts[${i}]`);
    }
    if (a.verdict !== null && a.outcome !== "succeeded") add("verdict-unsucceeded", `.attempts[${i}].verdict`);
  });
  if (new Set(attempts.map((a) => a.nonce)).size !== attempts.length) add("nonce-duplicate", ".attempts");
  if (t.state === "running" && last !== undefined && last.childSessionID === null) add("running-without-child", ".attempts");
  if (t.kind === "qa" && t.phase === null) add("qa-without-phase", ".phase");
  return out;
}

/** Every violation of a task node at path `at`: `shape` alone when the shape is wrong, else the cross-field invariants. */
function taskViolations(v: unknown, at: string): LedgerViolation[] {
  return isTaskShape(v) ? taskInvariantViolations(v, at) : [{ code: "shape", at }];
}

/**
 * Guard for a task node (§7, A1-7): types, enums, finite numbers, patterns, plus the cross-field invariants
 * (`attempt-n`, `open-attempt`, `slot-required`, `slot-forbidden`, `branch-required`, `integrated-missing`, `git-id`,
 * `manual-attempts`, `attempt-ended-pair`, `verdict-unsucceeded`, `nonce-duplicate`, `running-without-child`,
 * `qa-without-phase`). Unknown extra fields are accepted.
 */
export function isTaskNode(v: unknown): v is TaskNode {
  return taskViolations(v, "$").length === 0;
}

function isPhaseShape(v: unknown): v is PhaseRecord {
  return isRec(v) && isStr(v.id) && isStr(v.title) && isStr(v.wave) && isStrArr(v.dependsOn) &&
    isOneOf(GATE_STATES, v.gate) && isInt(v.qaRound) && isBool(v.paused) && isStrOrNull(v.tag);
}

function isInboxItem(v: unknown): v is InboxItem {
  return isRec(v) && isStr(v.id) &&
    isOneOf(["question", "failure", "usage-limit", "landing", "flaky", "qa-cap", "breaker"] as const, v.kind) &&
    isOneOf(["info", "blocking", "critical"] as const, v.severity) && isStrOrNull(v.taskId) && isStr(v.text) &&
    isStrArr(v.options) && isStrOrNull(v.answer) && isIso(v.createdAt);
}

const EDGE_KINDS = ["structural", "explicit", "graph", "contract", "conflict", "llm", "learned"] as const;
const CONFIDENCES = ["high", "medium", "low"] as const;

/** QA2/`qa-gate` checks over the tasks of one shape-valid ledger (A1-1, A1-7). */
function qaViolations(phases: readonly PhaseRecord[], tasks: Record<string, TaskNode>, status: LedgerStatus, out: LedgerViolation[]): void {
  const all = Object.values(tasks);
  phases.forEach((p, i) => {
    const qa = all.filter((t) => t.kind === "qa" && t.phase === p.id);
    const live = qa.filter((t) => t.state !== "done" && t.state !== "cancelled");
    if (live.length > 1) out.push({ code: "qa-multiple-open", at: `$.phases[${i}]` });
    if (status === "aborted") return;
    const inFlight = qa.filter((t) => t.state === "dispatched" || t.state === "running");
    if (inFlight.length > 0 && p.gate !== "qa-running") out.push({ code: "qa-gate", at: `$.phases[${i}].gate` });
    if (p.gate === "qa-running") {
      const settled = inFlight.length === 0 && qa.length > 0 && live.length === 0 && qa.some((t) => t.state === "done");
      if (inFlight.length !== 1 && !settled) out.push({ code: "qa-gate", at: `$.phases[${i}].gate` });
    }
  });
}

/**
 * Every violated invariant of a candidate ledger (A1-7), each with a stable `code` and the JSON path `at`; `[]` means a valid version-1 ledger.
 * `shape` marks a wrong type, enum, pattern or non-finite number (checks that depend on that part are skipped). Codes: `shape`, `schema`,
 * `config-limits`, `task-key`, `task-phase`, `phase-wave`, `edge-endpoint`, `seq`, the task codes of `isTaskNode`, `shared-context-length`,
 * `shared-context-slot-path`, `shared-context-header`, `path-not-absolute`, `git-id`, `phase-id`, `phase-duplicate`, `wave-id`,
 * `wave-duplicate`, `wave-membership`, `phase-depends`, `slots-dir-unresolved`, `inbox-id`, `inbox-duplicate`, `inbox-task`,
 * `qa-multiple-open`, `qa-round`, `qa-gate`. A newer `schema` is a violation (use `ledgerSchemaOf` to tell). Unknown extra fields are accepted.
 */
export function ledgerViolations(v: unknown): LedgerViolation[] {
  const out: LedgerViolation[] = [];
  const add = (code: string, at: string): void => { out.push({ code, at }); };
  if (!isRec(v)) return [{ code: "shape", at: "$" }];
  if (v.schema !== LEDGER_SCHEMA) add("schema", "$.schema");
  if (v.launcher !== "A") add("shape", "$.launcher");
  if (!isStr(v.planId) || !PLAN_ID_PATTERN.test(v.planId)) add("shape", "$.planId");
  if (!isStr(v.planPath)) add("shape", "$.planPath");
  else if (!ABSOLUTE_PATH_PATTERN.test(v.planPath)) add("path-not-absolute", "$.planPath");
  if (!isStr(v.planDigest) || !/^[0-9a-f]{64}$/.test(v.planDigest)) add("shape", "$.planDigest");

  const repo = v.repo;
  if (!isRec(repo) || !isStr(repo.key) || !isStr(repo.toplevel) || !isStr(repo.baseBranch) || !isStr(repo.baseCommit)) {
    add("shape", "$.repo");
  } else {
    if (!ABSOLUTE_PATH_PATTERN.test(repo.toplevel)) add("path-not-absolute", "$.repo.toplevel");
    if (!GIT_ID_PATTERN.test(repo.baseCommit)) add("git-id", "$.repo.baseCommit");
  }
  const integ = v.integration;
  if (!isRec(integ) || !isStr(integ.branch) || !isStr(integ.worktree) || !isStr(integ.head)) {
    add("shape", "$.integration");
  } else {
    if (!ABSOLUTE_PATH_PATTERN.test(integ.worktree)) add("path-not-absolute", "$.integration.worktree");
    if (!GIT_ID_PATTERN.test(integ.head)) add("git-id", "$.integration.head");
  }
  const status = isOneOf(LEDGER_STATUSES, v.status) ? v.status : null;
  if (status === null) add("shape", "$.status");
  const orch = v.orchestrator;
  if (!isRec(orch) || !isStr(orch.sessionID) || !isIso(orch.boundAt)) add("shape", "$.orchestrator");
  if (!isInt(v.seq)) add("shape", "$.seq");
  else if (v.seq < 1) add("seq", "$.seq");

  const config = isConfigShape(v.config) ? v.config : null;
  if (config === null) add("shape", "$.config");
  else {
    if (!configWithinLimits(config)) add("config-limits", "$.config");
    if (config.slotsDir !== null) {
      if (!ABSOLUTE_PATH_PATTERN.test(config.slotsDir)) add("path-not-absolute", "$.config.slotsDir");
    } else if (status === "running" || status === "paused" || status === "completed") add("slots-dir-unresolved", "$.config.slotsDir");
  }
  if (!isStr(v.sharedContext)) add("shape", "$.sharedContext");
  else {
    if (config !== null && v.sharedContext.length > config.sharedContextChars) add("shared-context-length", "$.sharedContext");
    if (config !== null && config.slotsDir !== null && config.slotsDir.length > 0 && v.sharedContext.includes(config.slotsDir)) {
      add("shared-context-slot-path", "$.sharedContext");
    }
    if (hasHeaderShapedLine(v.sharedContext)) add("shared-context-header", "$.sharedContext");
  }

  // waves
  const waves: Array<{ id: string; phases: string[] }> = [];
  if (!Array.isArray(v.waves)) add("shape", "$.waves");
  else {
    v.waves.forEach((w: unknown, i) => {
      if (!isRec(w) || !isStr(w.id) || !isStrArr(w.phases)) { add("shape", `$.waves[${i}]`); return; }
      if (!WAVE_ID_PATTERN.test(w.id)) add("wave-id", `$.waves[${i}].id`);
      if (waves.some((o) => o.id === w.id)) add("wave-duplicate", `$.waves[${i}].id`);
      waves.push({ id: w.id, phases: w.phases });
    });
  }
  // phases
  const phases: PhaseRecord[] = [];
  const wavesOk = Array.isArray(v.waves) && waves.length === v.waves.length;
  if (!Array.isArray(v.phases)) add("shape", "$.phases");
  else {
    v.phases.forEach((p: unknown, i) => {
      if (!isPhaseShape(p)) { add("shape", `$.phases[${i}]`); return; }
      if (!PHASE_ID_PATTERN.test(p.id)) add("phase-id", `$.phases[${i}].id`);
      if (phases.some((o) => o.id === p.id)) add("phase-duplicate", `$.phases[${i}].id`);
      if (p.qaRound < 1 || p.qaRound > QA_ROUND_LIMIT) add("qa-round", `$.phases[${i}].qaRound`);
      phases.push(p);
    });
  }
  const phasesOk = Array.isArray(v.phases) && phases.length === v.phases.length;
  const phaseIds = new Set<string>(phases.map((p) => p.id));
  if (wavesOk) {
    const waveIds = new Set<string>(waves.map((w) => w.id));
    phases.forEach((p, i) => { if (!waveIds.has(p.wave)) add("phase-wave", `$.phases[${i}].wave`); });
  }
  phases.forEach((p, i) => {
    if (p.dependsOn.some((d) => d === p.id || !phaseIds.has(d))) add("phase-depends", `$.phases[${i}].dependsOn`);
  });
  if (wavesOk && phasesOk) {
    waves.forEach((w, i) => {
      if (w.phases.some((id) => phases.find((p) => p.id === id)?.wave !== w.id)) add("wave-membership", `$.waves[${i}].phases`);
    });
    phases.forEach((p, i) => {
      if (waves.filter((w) => w.phases.includes(p.id)).length !== 1) add("wave-membership", `$.phases[${i}].wave`);
    });
  }

  // tasks
  const tasks: Record<string, TaskNode> = {};
  let tasksOk = false;
  if (!isRec(v.tasks)) add("shape", "$.tasks");
  else {
    tasksOk = true;
    for (const key of Object.keys(v.tasks)) {
      const t: unknown = v.tasks[key];
      const tv = taskViolations(t, `$.tasks.${key}`);
      out.push(...tv);
      if (tv.some((x) => x.code === "shape")) { tasksOk = false; continue; }
      if (!isTaskShape(t)) { tasksOk = false; continue; }
      tasks[key] = t;
      if (t.id !== key) add("task-key", `$.tasks.${key}`);
      if (t.phase !== null && !phaseIds.has(t.phase)) add("task-phase", `$.tasks.${key}.phase`);
    }
  }
  if (tasksOk && phasesOk && status !== null) qaViolations(phases, tasks, status, out);

  // edges
  if (!Array.isArray(v.edges)) add("shape", "$.edges");
  else {
    v.edges.forEach((e: unknown, i) => {
      if (!isRec(e) || !isStr(e.from) || !isStr(e.to) || !isStr(e.evidence) || !isOneOf(EDGE_KINDS, e.kind) ||
        !isOneOf(CONFIDENCES, e.confidence)) { add("shape", `$.edges[${i}]`); return; }
      if (isRec(v.tasks)) {
        if (!hasOwn(v.tasks, e.to)) add("edge-endpoint", `$.edges[${i}].to`);
        if (e.from.startsWith("gate:")) {
          if (!phaseIds.has(e.from.slice("gate:".length))) add("edge-endpoint", `$.edges[${i}].from`);
        } else if (!hasOwn(v.tasks, e.from)) add("edge-endpoint", `$.edges[${i}].from`);
      }
    });
  }

  // inbox
  if (!Array.isArray(v.inbox)) add("shape", "$.inbox");
  else {
    const ids = new Set<string>();
    const nums = new Set<string>();
    v.inbox.forEach((item: unknown, i) => {
      if (!isInboxItem(item)) { add("shape", `$.inbox[${i}]`); return; }
      const m = INBOX_ID_PATTERN.exec(item.id);
      if (m === null || m[1] !== INBOX_ID_PREFIX[item.kind]) add("inbox-id", `$.inbox[${i}].id`);
      const num = m?.[2] ?? "";
      if (ids.has(item.id) || (num !== "" && nums.has(num))) add("inbox-duplicate", `$.inbox[${i}].id`);
      ids.add(item.id);
      if (num !== "") nums.add(num);
      if (item.taskId !== null && isRec(v.tasks) && !hasOwn(v.tasks, item.taskId)) add("inbox-task", `$.inbox[${i}].taskId`);
    });
  }
  return out;
}

/**
 * Guard for a version-1 ledger (§7, A1-7): true iff `ledgerViolations(v)` is empty. A newer `schema` returns false
 * (use `ledgerSchemaOf` to tell). Unknown extra fields are accepted.
 */
export function isLedgerV1(v: unknown): v is LedgerV1 {
  return ledgerViolations(v).length === 0;
}

/**
 * Prompt grammar (QA-0.1-21): `prompt = planContext "\n\n" headerLine "\n\n" taskBlock`,
 * `planContext = "PLAN CONTEXT\n" ledger.sharedContext`, `headerLine = header " nonce=" nonce`,
 * `header = "[plan " planId ":" taskId "#" attempt "]"` with attempt = `Attempt.n` (D-b). `taskBlock` belongs to 3.1.4.
 * The child's first-context fail-closed check (3.1.7.a) refuses every tool call of an unbound child whose prompt matches.
 * Consumers must import this pattern; never re-derive it (the memo's old task-id lookahead was wrong, QA-1.4-12).
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

/** Renders `[plan <planId>:<taskId>#<attempt>] nonce=<nonce>`; throws E_LAUNCH_TASK when the result would not match `LAUNCH_HEADER_PATTERN`. */
export function formatLaunchHeader(p: LaunchHeaderFields): string {
  const line = `[plan ${p.planId}:${p.taskId}#${p.attempt}] nonce=${p.nonce}`;
  const m = LAUNCH_HEADER_PATTERN.exec(line);
  if (!Number.isInteger(p.attempt) || m === null || m[0] !== line) {
    throw new ExecutorError("E_LAUNCH_TASK", "launch header fields do not match the launch header grammar", {
      planId: p.planId, taskId: p.taskId, attempt: p.attempt, nonce: p.nonce,
    });
  }
  return line;
}

/** True iff some line of `text` is shaped like a launch header (the multiline pattern). */
function hasHeaderShapedLine(text: string): boolean {
  return LAUNCH_HEADER_PATTERN.test(text);
}

/**
 * Strict, at the fixed position (A1-7): the prompt starts with `"PLAN CONTEXT\n" + sharedContext + "\n\n"`, the next line matches
 * `LAUNCH_HEADER_PATTERN` in full and is followed by `"\n\n"`. Anything else is null, including a `sharedContext` that itself has a
 * header-shaped line. Recovery (C7) uses this with `ledger.sharedContext`.
 */
export function parseLaunchHeader(prompt: string, sharedContext: string): LaunchHeaderFields | null {
  if (hasHeaderShapedLine(sharedContext)) return null;
  const prefix = `PLAN CONTEXT\n${sharedContext}\n\n`;
  if (!prompt.startsWith(prefix)) return null;
  const rest = prompt.slice(prefix.length);
  const end = rest.indexOf("\n\n");
  if (end < 0) return null;
  const line = rest.slice(0, end);
  const m = LAUNCH_HEADER_PATTERN.exec(line);
  if (m === null || m[0] !== line) return null;
  const [, planId, taskId, attempt, nonce] = m;
  if (planId === undefined || taskId === undefined || attempt === undefined || nonce === undefined) return null;
  return { planId, taskId, attempt: Number(attempt), nonce };
}

/** Loose: any line matches. Only for the 3.1.7.a fail-closed check (over-matching fails closed). */
export function looksLikePlanPrompt(prompt: string): boolean {
  return hasHeaderShapedLine(prompt);
}

/**
 * §7 grammar: `"PLAN CONTEXT\n" + sharedContext + "\n\n" + headerLine + "\n\n" + taskBlock`.
 * Throws E_LAUNCH_TASK when `sharedContext` has a header-shaped line, the header fields are invalid, or `taskBlock` does not start with "TASK".
 */
export function formatLaunchPrompt(sharedContext: string, header: LaunchHeaderFields, taskBlock: string): string {
  if (hasHeaderShapedLine(sharedContext)) {
    throw new ExecutorError("E_LAUNCH_TASK", "shared context contains a launch-header-shaped line");
  }
  if (!taskBlock.startsWith("TASK")) {
    throw new ExecutorError("E_LAUNCH_TASK", 'task block must start with "TASK"');
  }
  return `PLAN CONTEXT\n${sharedContext}\n\n${formatLaunchHeader(header)}\n\n${taskBlock}`;
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

// ---- QA rounds (A1-1)

/** Highest QA round a phase can reach (A1-1). */
export const QA_ROUND_LIMIT = 999;
/** Highest fix-task index within one round (A1-1). */
export const FIX_TASKS_PER_ROUND_LIMIT = 999;
/** Prefix of the `Attempt.context` a qa attempt gets when its output does not parse (QA6). */
export const QA_UNPARSABLE_CONTEXT_PREFIX = "QA OUTPUT UNPARSABLE: ";
/** Answers a critical `qa-cap` item offers; `fix` is withheld at `QA_ROUND_LIMIT` (QA8). */
export const QA_CAP_OPTIONS = ["accept", "fix"] as const;
export type QaCapChoice = (typeof QA_CAP_OPTIONS)[number];

function isIntIn(v: number, lo: number, hi: number): boolean {
  return Number.isInteger(v) && v >= lo && v <= hi;
}

/** Id of fix task `k` created from the findings of round `round`: `${phaseId}.FIX${round}-${k}`. Throws E_INVALID_INPUT outside the limits. */
export function fixTaskId(phaseId: PhaseId, round: number, k: number): TaskId {
  if (!PHASE_ID_PATTERN.test(phaseId) || !isIntIn(round, 1, QA_ROUND_LIMIT) || !isIntIn(k, 1, FIX_TASKS_PER_ROUND_LIMIT)) {
    throw new ExecutorError("E_INVALID_INPUT", "invalid fix task id inputs", { phaseId, round, k });
  }
  return `${phaseId}.FIX${round}-${k}`;
}

/** Id of the qa task of round `round` >= 2: `${phaseId}.QA${round}`. Throws E_INVALID_INPUT outside the limits. */
export function reviewTaskId(phaseId: PhaseId, round: number): TaskId {
  if (!PHASE_ID_PATTERN.test(phaseId) || !isIntIn(round, 2, QA_ROUND_LIMIT)) {
    throw new ExecutorError("E_INVALID_INPUT", "invalid review task id inputs", { phaseId, round });
  }
  return `${phaseId}.QA${round}`;
}

/** How many attempts of `t` ended with unparsable QA output: those whose context starts with `QA_UNPARSABLE_CONTEXT_PREFIX` (QA6). */
export function qaUnparsableCount(t: TaskNode): number {
  return t.attempts.filter((a) => a.context.startsWith(QA_UNPARSABLE_CONTEXT_PREFIX)).length;
}

/** The report stored in a qa attempt's context: `JSON.stringify({findings: [...]})` with the keys in schema order. */
export function canonicalFindingsJson(r: FindingsReport): string {
  return JSON.stringify({
    findings: r.findings.map((f) => ({ id: f.id, severity: f.severity, files: f.files, problem: f.problem, fix: f.fix })),
  });
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

/** `ExecutorConfig` with every writable property (and the nested circuit breaker) read-only (QA-1.4-15). */
export type ReadonlyExecutorConfig = Readonly<Omit<ExecutorConfig, "circuitBreaker">> & {
  readonly circuitBreaker: Readonly<ExecutorConfig["circuitBreaker"]>;
};

/** A fresh, mutable copy of the Appendix C defaults; edit this, never `EXECUTOR_DEFAULTS` (QA-1.4-15). */
export function executorDefaults(): ExecutorConfig {
  return { ...EXECUTOR_DEFAULTS, circuitBreaker: { ...EXECUTOR_DEFAULTS.circuitBreaker } };
}

/** Appendix C defaults (plan 4381-4399). Frozen and typed read-only: use `executorDefaults()` for a mutable copy. */
export const EXECUTOR_DEFAULTS: ReadonlyExecutorConfig = Object.freeze({
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
  /** pre: no plan dir; isLedgerV1(draft) and `draft.seq === 1`; post: dir, snapshot, journal (ledger-init `{seq: 1, batch: 1, last: true}`), lock held.
   *  err E_EXISTS, E_SCHEMA_INVALID (including any other draft seq) */
  create(draft: LedgerV1, holder: LockHolder): Promise<LedgerWriter>;
  /** Takes the writer lock. err E_LEDGER_NOT_FOUND, E_LOCK_HELD (detail = holder), E_SCHEMA_NEWER, E_SEQ_GAP, E_ILLEGAL_TRANSITION (detail names the event) */
  open(planId: PlanId, holder: LockHolder): Promise<LedgerWriter>;
  /** Only when the lock is stale (dead pid on this host, or heartbeat > 60 s) or the caller is adopting; journals lock-takeover. err E_LOCK_HELD */
  takeover(planId: PlanId, holder: LockHolder, reason: string): Promise<LedgerWriter>;
  /** Lock-free consistent read (retries while snapshot seq != first journal seq). A torn last line is dropped with one warning. */
  read(planId: PlanId): Promise<LedgerV1>;
  list(): Promise<Array<{ planId: PlanId; status: LedgerStatus; toplevel: string; orchestratorSessionID: string; seq: number }>>;
  /** snapshot = current ledger; events = every history event since seq 1 merged with every event of the current main journal, deduplicated
   *  by `seq`, ascending (A1-3). No lock; torn last lines dropped. Only history-class events are guaranteed back to seq 1. */
  exportPlan(planId: PlanId): Promise<{ snapshot: LedgerV1; events: ExecutorEvent[] }>;
  /** pre: status completed|aborted; no live writer elsewhere. post: plan dir gone. Returns false when absent. err E_PLAN_STATE, E_LOCK_HELD */
  remove(planId: PlanId): Promise<boolean>;
}

/** The one writer of a plan's ledger (D-e): validates, sequences and persists event batches. */
export interface LedgerWriter {
  readonly planId: PlanId;
  readonly ledger: Readonly<LedgerV1>;
  /** One atomic batch. A builder runs synchronously inside the writer's serialization against the ledger the batch applies to and must be pure;
   *  `[]` appends nothing and resolves with the current ledger. Validation per A1-2 (per-event preconditions in order; `ledgerViolations` at
   *  batch end). Events share one `at`; `seq`, `batch` and `last` are assigned; all lines go in one appendText; fsync iff any event
   *  isDurableEvent; then the history copy (A1-3). Resolves after the fsync.
   *  err E_ILLEGAL_TRANSITION (nothing written; detail = {batchIndex, eventIndex|null, codes}), E_LOCK_LOST, I/O */
  append(batch: readonly ExecutorEventInput[] | BatchBuilder): Promise<Readonly<LedgerV1>>;
  /** Integration entries still open in the history journal (A1-3); updated on every append. */
  openIntegration(): readonly OpenIntegrationEntry[];
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
  /** pre: each id is verified with slot and branch. Idempotent (an id already queued or integrating is ignored).
   *  Dequeue only while `status === "running"` and the task's phase is null or not paused (A1-8): a queued task of a paused phase is
   *  skipped but keeps its position, and a batch takes only dequeueable tasks.
   *  Dequeue journals verified->integrating (durable) before any git step. err E_PLAN_STATE, E_DISPOSED */
  enqueue(taskIds: readonly TaskId[]): void;
  /** Runs once per plan before the first dequeue, whatever the task states, in running and paused (A1-3); starts no new step except its reruns.
   *  Step 0 reconciles the integration branch tip with `integration.head` (complete a fast-forward that landed, else pause and halt);
   *  step 1 handles each open history entry oldest first by kind (rollback and requeue, rerun the revert, rerun the suite, tag, land).
   *  Idempotent. */
  resume(): Promise<ResumeReport>;
  /** Starts the phase suite when §3.3's precondition holds and the plan is running with the phase not paused; idempotent. */
  checkPhase(phaseId: PhaseId): Promise<void>;
  /** ff-when-clean or manual; never force, never non-ff. */
  land(): Promise<{ landed: boolean; inbox: InboxItem | null }>;
  /** Stops dequeuing, rolls back the step in progress, journals one batch with the row-33 events (integrating->cancelled) and closes the other
   *  open entries `rolled-back` (A1-8 abort order, step 2). */
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
  /** err E_CAPACITY. `opts.force` never throws E_CAPACITY (late-child adoption only, A1-5). */
  acquire(provider: string, heavy: boolean, taskId: TaskId, attempt: number, opts?: { force: true }): { id: string };
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

/** Identity of one retained capture (A1-4): the process, the capture counter and the router call. */
export interface ContextRef {
  /** 16 lowercase hex, random once per process, owned by `ChildRunner`. */
  bootID: string;
  epoch: number;
  callID: string;
}

/** The newest router-tool capture of a session in this process (§9). */
export interface RetainedContextInfo {
  sessionID: string;
  callID: string;
  messageID: string;
  agent: string;
  capturedAt: IsoTime;
  bootID: string;
  /** +1 per capture in this process. */
  epoch: number;
}

/** Thrown (rejected) by `ChildRunner.run` when the pinned capture is no longer the current one (A1-4, rows L5/L3). */
export class ContextSupersededError extends Error {
  readonly requested: ContextRef;
  readonly current: ContextRef | null;
  constructor(requested: ContextRef, current: ContextRef | null) {
    super("retained context superseded");
    this.name = "ContextSupersededError";
    this.requested = requested;
    this.current = current;
  }
}

/** True for a `ContextSupersededError`, by name, so it survives realm and module boundaries (A1-4). */
export function isContextSupersededError(e: unknown): e is ContextSupersededError {
  return typeof e === "object" && e !== null && (e as { name?: unknown }).name === "ContextSupersededError";
}

/**
 * Launch gate (A1-6). `disposed` has no wake; every other non-ok reason has one. Keys:
 * `context-stale` -> `stale-context:<bootID>:<epoch>`; `no-context` (a capture existed in this process and is gone) ->
 * `no-context:<bootID>:<orchestratorSessionID>:<lastEpoch>`; `awaiting-first-router-call` (guard 6) ->
 * `await-router-call:<bootID>:<orchestratorSessionID>`. The runtime wakes iff not ok, `wake !== null` and the ready set
 * computed as if the gate were ok is non-empty.
 */
export type LaunchGate =
  | { ok: true; context: RetainedContextInfo; ageMs: number }
  | { ok: false; reason: "disposed"; wake: null }
  | {
      ok: false;
      reason: "no-context" | "awaiting-first-router-call" | "context-stale";
      wake: { reason: "stale-context"; stateKey: string };
    };

export interface LaunchRequest {
  planId: PlanId;
  taskId: TaskId;
  attempt: number;
  nonce: string;
  orchestratorSessionID: string;
  /** The gated capture; `attempt-started.attempt.callID === context.callID` (A1-4). */
  context: ContextRef;
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
  /** Late child. Pure decision, journals nothing: "adopt" iff this attempt is the latest, its outcome lost, the task ready and the plan not aborted. */
  onLateChild(childSessionID: string): Promise<"adopt" | "refuse">;
  /** The single journaling point for a created child (in time or adopted late), inside onCreated after RoleBindings.bind and before the
   *  child is prompted. Rt appends with a builder: dispatched with this attempt open -> [AC, TT child-created]; ready with this attempt
   *  latest and lost -> [AA, TT adopt, G1] + forced token; anything else -> throw (refuse). A throw makes the runner interrupt the child. */
  onChildCreated(childSessionID: string): Promise<void>;
}

/** Why a launch was not confirmed (A1-5): "timeout" and "threw" mark the context stale; "task-error" is R1 (counts). */
export type LaunchConfirmation =
  | { kind: "confirmed"; childSessionID: string; latencyMs: number }
  | { kind: "unconfirmed"; reason: "timeout" | "threw" | "superseded" | "task-error" | "hook-failed"; error: string | null };

export type CancelReason = "abort" | "blocked" | "superseded" | "dispose";

export type ChildEnd =
  | { kind: "completed"; childSessionID: string; text: string; endedAt: IsoTime }
  | { kind: "failed"; childSessionID: string; error: HostError; endedAt: IsoTime }
  | { kind: "capacity"; childSessionID: string; error: HostError; endedAt: IsoTime }
  | { kind: "interrupted"; childSessionID: string | null; reason: CancelReason; endedAt: IsoTime }
  | {
      kind: "lost"; childSessionID: string | null;
      reason: "unconfirmed" | "unrequested-interrupt" | "runner-error" | "restart" | "context-superseded" | "refused";
      endedAt: IsoTime;
    };

export interface LaunchHandle {
  taskId: TaskId;
  attempt: number;
  nonce: string;
  context: ContextRef;
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
  /** pre: gate ok and `req.context` is the current capture of `orchestratorSessionID`; the task is dispatched with its open attempt fsynced; the capacity token, slot and leases are held.
   *  Does: the decision row, recordDispatchStart and the D2 in-flight registration (DispatchBookkeeping); then ChildRunner.run with detached:true,
   *  `context: req.context`, an executor-owned AbortController (combined with the plugin lifetime), explicit agent and model, cwd = workRoot.
   *  Emits the context-age metric. The launcher never journals (Rt does, A1-5). markStale only for "timeout" and "threw". Classifies the end:
   *  runner result -> completed; else the terminal session.execution.* event (waits <= CHILD_END_GRACE_MS): failed -> executionFailureOutcome;
   *  interrupted -> `interrupted` if cancel() was called, else `lost` (guard 5); no event -> lost(runner-error). The fallback trigger (D2): a
   *  terminal event before the runner settles resolves completion, with text from HostSessions.context (last assistant message).
   *  err (synchronous, before any host call): E_NO_CONTEXT (gate not ok / context is not the current capture), E_LAUNCH_TASK (header or prompt
   *  mismatch, unknown agent, bad workRoot), E_DISPOSED */
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
 * Exemption (A1-8, QA-1.4-16): `status`, `ready`, `exportPlan` and `planLine` are read-only: never E_NOT_OWNER, any status
 * including completed/aborted; `status` uses its `sessionID` only to pick the plan when `planId` is null.
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
  /** Order (A1-8): (1) in-memory latch (no launch, enqueue or promotion); (2) `await queue.abort()` (on a throw: log and continue);
   *  (3) one Rt builder batch cancelling every task not in {done, cancelled, integrated, integrating}, then `status-changed -> aborted` last;
   *  (4) after the fsync `launcher.cancel(t, n, "abort")` for every launch in flight, including unsettled lost ones. Terminal states, gates and inbox untouched. */
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
  /** From running (escalate|ambiguity|qa-unparsable) or conflict|failed|reverted (exhausted). post: parked; transitive **pending** dependents
   *  -> blocked (a dependent of an un-integrated task cannot be ready or in flight, R9/R10); one inbox item. */
  park(taskId: TaskId, cause: "escalate" | "ambiguity" | "qa-unparsable" | "exhausted", text: string): Promise<InboxItem>;
  /** pre: item open. post: inbox-answered; attempt-context on the latest attempt; parked -> ready. A critical `qa-cap` item goes to
   *  `QaLoop.onCapAnswer` instead (the answer must be one of its options). err E_INVALID_INPUT */
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
  /** pre: the qa task is done; gate qa-running. post: A1-1 gate table (passed | pending with fix and re-review tasks created and edges added, round+1
   *  | cap reached -> qa-cap critical item and phase paused); deferred minor/nit findings recorded as closed info items. Fix tasks of one round have
   *  disjoint writes. Idempotent: if the gate is no longer qa-running it writes nothing and returns the outcome derived from the ledger. */
  onQaResult(taskId: TaskId, report: FindingsReport): Promise<"passed" | "next-round" | "cap-reached">;
  /** A phase with no open qa task (outside done/cancelled) and no open critical qa-cap item naming one of its qa tasks -> passed; otherwise a no-op. */
  onAwaitingQa(phaseId: PhaseId): Promise<void>;
  /** Answer of a critical `qa-cap` item: `accept` (defer the remaining findings, awaiting-qa -> passed) or `fix` (awaiting-qa -> pending, round+1,
   *  fix and re-review tasks). The trimmed, lowercased answer must equal an option, else E_INVALID_INPUT. */
  onCapAnswer(inboxId: string, choice: QaCapChoice): Promise<"passed" | "next-round">;
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
  /**
   * The gated capture this run is pinned to (A1-4): `run()` uses exactly this capture; when
   * `retainedContext(parentSessionID)` is null or its (bootID, epoch, callID) differs, it rejects with
   * `ContextSupersededError` before any host call.
   */
  context: ContextRef;
  onCreated(childSessionID: string): Promise<void>;
  onConfirmed?(childSessionID: string): Promise<void>;
}
export interface ChildRunner {
  /** 16 lowercase hex, random once per process (A1-4). */
  readonly bootID: string;
  run(r: ChildRunRequest): Promise<{ sessionID: string; text: string }>;
  dispose(sessionID: string): Promise<void>;
  /** The newest router-tool capture of that session in this process. */
  retainedContext(sessionID: string): RetainedContextInfo | null;
  onContextCaptured(listener: (c: RetainedContextInfo) => void): () => void;
}
