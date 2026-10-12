// Shared builders for the ledger store tests (unit and crash). No filesystem, clock or process access at module load.
import {
  EXECUTOR_DEFAULTS,
  type Attempt,
  type ExecutorConfig,
  type ExecutorEvent,
  type ExecutorEventInput,
  type LedgerV1,
  type LockHolder,
  type TaskNode,
} from "../../../../src/executor/types.js";

export const PLAN_ID = "plan-one";
export const T0 = "2026-10-11T00:00:00.000Z";
const SHA = "c".repeat(40);

export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export function nonceFor(n: number): string {
  return Math.max(0, Math.trunc(n)).toString(16).padStart(32, "0");
}

export function taskNode(id: string, patch: Partial<TaskNode> = {}): TaskNode {
  return {
    id,
    title: `Task ${id}`,
    phase: "p1",
    kind: "task",
    text: "do it",
    subtasks: ["sub"],
    route: { line: "task: do it", role: "implementer", tier: "fast", pin: false },
    verify: "required",
    acceptance: null,
    footprint: { writes: ["src/a.ts"], reads: ["README.md"], confidence: "explicit", sources: ["path"] },
    estimate: { p50: 10, p90: 20, source: "default" },
    state: "pending",
    attempts: [],
    slot: null,
    branch: null,
    integrated: null,
    ...patch,
  };
}

export function openAttempt(n: number): Attempt {
  return { n, nonce: nonceFor(n), callID: null, childSessionID: null, startedAt: T0, endedAt: null, outcome: null, verdict: null, context: "" };
}

/** A valid running ledger at seq 1 with `taskCount` pending tasks T1..Tn (plus a chain of structural edges). */
export function buildDraft(taskCount = 3, planId = PLAN_ID): LedgerV1 {
  const config: ExecutorConfig = clone(EXECUTOR_DEFAULTS);
  config.slotsDir = "C:/slots";
  const tasks: Record<string, TaskNode> = {};
  const edges: LedgerV1["edges"] = [];
  for (let i = 1; i <= taskCount; i++) {
    tasks[`T${i}`] = taskNode(`T${i}`);
    if (i > 1) edges.push({ from: `T${i - 1}`, to: `T${i}`, kind: "structural", confidence: "high", evidence: "order" });
  }
  return {
    schema: 1,
    planId,
    planPath: "C:/repo/PLAN.md",
    planDigest: "ab".repeat(32),
    repo: { key: "repo-key", toplevel: "C:/repo", baseBranch: "main", baseCommit: SHA },
    integration: { branch: `omr/${planId}/integration`, worktree: "C:/slots/integration", head: SHA },
    launcher: "A",
    status: "running",
    orchestrator: { sessionID: "ses-0", boundAt: T0 },
    config,
    sharedContext: "shared notes",
    waves: [{ id: "w1", phases: ["p1"] }],
    phases: [{ id: "p1", title: "Phase 1", wave: "w1", dependsOn: [], gate: "pending", qaRound: 1, paused: false, tag: null }],
    tasks,
    edges,
    inbox: [],
    seq: 1,
  };
}

export function holderOf(sessionID: string, pid: number, hostname: string, nowIso: string = T0): LockHolder {
  return { pid, hostname, sessionID, startedAt: nowIso, heartbeatAt: nowIso };
}

/** A durable, always-legal event adding task `id`. */
export function addTask(id: string): ExecutorEventInput {
  return { type: "task-created", task: taskNode(id) };
}

/** A non-durable, history-class event. */
export function metric(n: number): ExecutorEventInput {
  return { type: "metric", metric: { name: "counter", key: `k${n}`, value: n, labels: {} } };
}

/** The `ledger-init` journal line for `draft` (seq 1). */
export function initLine(draft: LedgerV1, at: string = T0): string {
  const e: ExecutorEvent = { seq: 1, at, batch: 1, last: true, type: "ledger-init", ledger: draft };
  return JSON.stringify(e);
}

/** A journal line for `input` as the store would write it. */
export function eventLine(input: ExecutorEventInput, seq: number, batch: number, last: boolean, at: string = T0): string {
  return JSON.stringify({ ...input, seq, at, batch, last });
}
