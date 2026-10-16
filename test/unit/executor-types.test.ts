// test/unit/executor-types.test.ts
// Phase 1.4 task 1.4.4: unit tests for the cross-phase executor contract in src/executor/types.ts (memo §12).
import { describe, expect, it } from "vitest";
import { GUARD_CUMULATIVE_MULTIPLIER } from "../../src/router/guard-profile";
import {
  ABSOLUTE_PATH_PATTERN,
  ATTEMPT_OUTCOMES,
  BUDGET_RESUMES,
  CHILD_END_GRACE_MS,
  ContextSupersededError,
  DURABLE_TASK_STATES,
  EXECUTOR_DEFAULTS,
  EXECUTOR_LIMITS,
  ExecutorError,
  FINDINGS_FORMAT,
  FIX_TASKS_PER_ROUND_LIMIT,
  GATE_STATES,
  GATE_TRANSITIONS,
  GATE_TRANSITION_OWNERS,
  GATE_TRANSITION_TRIGGERS,
  GATE_TRIGGER_OWNERS,
  RESERVED_TASK_IDS,
  isTaskId,
  leaseHolderID,
  leaseTaskRef,
  GIT_ID_PATTERN,
  HEAVY_CAP_PER_PROVIDER,
  INBOX_ID_PATTERN,
  INBOX_ID_PREFIX,
  PHASE_ID_PATTERN,
  QA_CAP_OPTIONS,
  QA_ROUND_LIMIT,
  QA_UNPARSABLE_CONTEXT_PREFIX,
  WAVE_ID_PATTERN,
  canonicalFindingsJson,
  executorDefaults,
  fixTaskId,
  formatInboxId,
  formatLaunchPrompt,
  isContextSupersededError,
  isHistoryEvent,
  ledgerViolations,
  looksLikePlanPrompt,
  nextInboxNumber,
  qaUnparsableCount,
  reviewTaskId,
  LAUNCH_CONFIRM_TIMEOUT_MS,
  LAUNCH_HEADER_PATTERN,
  LEDGER_SCHEMA,
  LEDGER_STATUSES,
  LEDGER_STATUS_TRANSITIONS,
  NONCE_PATTERN,
  ORCHESTRATOR_SHELL_RE,
  PLAN_ID_PATTERN,
  TASK_ID_PATTERN,
  TASK_KINDS,
  TASK_STATES,
  TASK_TRANSITIONS,
  TERMINAL_TASK_STATES,
  TRANSITION_OWNERS,
  TRANSITION_TRIGGERS,
  VERDICTS,
  WIP_TRAILER,
  canGateTransition,
  canStatusTransition,
  canTransition,
  classifyProviderError,
  countedAttempts,
  countsTowardMaxAttempts,
  executionFailureOutcome,
  formatLaunchHeader,
  hasAttemptsLeft,
  isAttemptResumedEvent,
  isBreakerFailure,
  isDurableEvent,
  isFindingsReport,
  isLedgerV1,
  isTaskNode,
  ledgerSchemaOf,
  parseLaunchHeader,
} from "../../src/executor/types";
import { classifyCapacity } from "../../src/routing/outcomes";
import type {
  Attempt,
  AttemptOutcome,
  BatchBuilder,
  ContextRef,
  GateOwner,
  GateTransitionKey,
  GateTrigger,
  InboxKind,
  OpenIntegrationEntry,
  PhaseRecord,
  LaunchConfirmation,
  LaunchGate,
  LaunchHooks,
  ResumeReport,
  CapacityController,
  CapacityView,
  ChildEnd,
  ChildRunRequest,
  ChildRunner,
  Clock,
  DispatchBookkeeping,
  Edge,
  ExpandInput,
  ExecutorConfig,
  ExecutorEventInput,
  ExecutorRuntime,
  FileSystem,
  FindingsReport,
  GateState,
  GitRunner,
  HostError,
  HostSessions,
  InboxItem,
  IntegrationListener,
  IntegrationQueue,
  LaunchHandle,
  LaunchRequest,
  LeaseHolderInfo,
  LeaseService,
  LeaseView,
  LedgerStatus,
  LedgerStore,
  LedgerV1,
  LedgerWriter,
  LockHolder,
  PlanCompiler,
  CompileSummary,
  ProcessResult,
  QaLoop,
  RecoveryService,
  RetainedContextInfo,
  RoleBindings,
  RouteResolver,
  Scheduler,
  SlotLease,
  SlotPool,
  SlotRecord,
  SlotVerifier,
  Spawner,
  TaskLauncher,
  TaskNode,
  TaskRoute,
  TaskState,
  TransitionKey,
  TransitionOwner,
  TransitionTrigger,
  UnattendedPolicy,
  Verdict,
  Waker,
} from "../../src/executor/types";

// ---------------------------------------------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------------------------------------------

const NONCE = "0123456789abcdef0123456789abcdef";
const T0 = "2026-10-11T00:00:00.000Z";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

/** A distinct valid nonce per attempt number (QA-1.4-8: the fixture must satisfy `nonce-duplicate`). */
function nonceFor(n: number): string {
  return Math.max(0, Math.trunc(n)).toString(16).padStart(32, "0");
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function attempt(n: number, outcome: AttemptOutcome | null, verdict: Verdict | null = null, patch: Partial<Attempt> = {}): Attempt {
  return {
    n, nonce: nonceFor(n), callID: null, childSessionID: null, startedAt: T0, endedAt: outcome === null ? null : T0,
    outcome, verdict, context: "", ...patch,
  };
}

function taskNode(id: string, patch: Partial<TaskNode> = {}): TaskNode {
  return {
    id, title: `Task ${id}`, phase: "p1", kind: "task", text: "do it", subtasks: ["sub"],
    route: { line: "task: do it", role: "implementer", tier: "fast", pin: false },
    verify: "required", acceptance: null,
    footprint: { writes: ["src/a.ts"], reads: ["README.md"], confidence: "explicit", sources: ["path"] },
    estimate: { p50: 10, p90: 20, source: "default" },
    state: "pending", attempts: [], slot: null, branch: null, integrated: null,
    ...patch,
  };
}

function buildLedger(): LedgerV1 {
  const config: ExecutorConfig = clone(EXECUTOR_DEFAULTS);
  config.slotsDir = "C:/slots";
  return {
    schema: 1,
    planId: "plan-one",
    planPath: "C:/repo/PLAN.md",
    planDigest: "ab".repeat(32),
    repo: { key: "repo-key", toplevel: "C:/repo", baseBranch: "main", baseCommit: SHA_C },
    integration: { branch: "omr/plan-one/integration", worktree: "C:/slots/integration", head: SHA_C },
    launcher: "A",
    status: "running",
    orchestrator: { sessionID: "ses-0", boundAt: T0 },
    config,
    sharedContext: "shared notes",
    waves: [{ id: "w1", phases: ["p1"] }],
    phases: [{ id: "p1", title: "Phase 1", wave: "w1", dependsOn: [], gate: "pending", qaRound: 1, paused: false, tag: null }],
    tasks: {
      T1: taskNode("T1", {
        state: "integrated", slot: null, branch: "omr/plan-one/t/T1", acceptance: "criteria",
        attempts: [attempt(1, "succeeded", "pass", { callID: "call-1", childSessionID: "ses-1" })],
        integrated: { from: SHA_A, to: SHA_B },
      }),
      T2: taskNode("T2", {
        state: "running", slot: "slot-2",
        attempts: [attempt(1, "failed"), attempt(2, null, null, { childSessionID: "ses-2" })],
      }),
      T3: taskNode("T3"),
      M1: taskNode("M1", { kind: "manual", state: "ready", phase: null }),
    },
    edges: [
      { from: "T1", to: "T3", kind: "structural", confidence: "high", evidence: "order" },
      { from: "gate:p1", to: "T3", kind: "explicit", confidence: "medium", evidence: "gate" },
    ],
    inbox: [{ id: "Q-1", kind: "question", severity: "blocking", taskId: "T2", text: "?", options: ["a", "b"], answer: null, createdAt: T0 }],
    seq: 5,
  };
}

type Path = Array<string | number>;
interface WalkNode { path: Path; value: unknown; parentIsArray: boolean }

function isObj(v: unknown): v is object {
  return typeof v === "object" && v !== null;
}

function walk(value: unknown, path: Path, parentIsArray: boolean, out: WalkNode[]): void {
  out.push({ path, value, parentIsArray });
  if (Array.isArray(value)) value.forEach((c, i) => walk(c, [...path, i], true, out));
  else if (isObj(value)) for (const k of Object.keys(value)) walk(Reflect.get(value, k), [...path, k], false, out);
}

function child(cur: unknown, key: string | number): unknown {
  if (!isObj(cur)) throw new Error(`bad path at ${String(key)}`);
  return Reflect.get(cur, key);
}

function parentOf(root: unknown, path: Path): object {
  let cur: unknown = root;
  for (const k of path.slice(0, -1)) cur = child(cur, k);
  if (!isObj(cur)) throw new Error("bad parent");
  return cur;
}

function setAt(root: unknown, path: Path, value: unknown): void {
  const last = path[path.length - 1];
  if (last === undefined) throw new Error("empty path");
  Reflect.set(parentOf(root, path), last, value);
}

function deleteAt(root: unknown, path: Path): void {
  const last = path[path.length - 1];
  if (last === undefined) throw new Error("empty path");
  Reflect.deleteProperty(parentOf(root, path), last);
}

function dotted(p: string): Path {
  return p.split(".").map((s) => (/^\d+$/.test(s) ? Number(s) : s));
}

const NULLABLE_KEYS = new Set([
  "slotsDir", "phase", "acceptance", "slot", "branch", "tag", "callID", "childSessionID", "endedAt", "taskId", "answer",
  "outcome", "verdict", "tier", "integrated",
]);

function wrongValues(v: unknown, path: Path): unknown[] {
  const key = path[path.length - 1];
  const joined = path.join(".");
  if (joined === "config.integrationChecks" || joined === "config.phaseSuite") return [null, 123, true, {}];
  if (joined === "config.provision") return [null, 123, true, []];
  const nul: unknown[] = typeof key === "string" && NULLABLE_KEYS.has(key) ? [] : [null];
  if (v === null) return [5, true, [], { x: 1 }];
  if (typeof v === "string") return [...nul, 123, true, [], {}];
  if (typeof v === "number") return [...nul, "1", true, [], {}, Number.NaN, Number.POSITIVE_INFINITY];
  if (typeof v === "boolean") return [...nul, "true", 0, 1, []];
  if (Array.isArray(v)) return [...nul, "x", 1, {}, true];
  return [...nul, "x", 1, [], true];
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)] as T;
}

function taskOf(l: LedgerV1, id: string): TaskNode {
  const t = l.tasks[id];
  if (t === undefined) throw new Error(`no task ${id}`);
  return t;
}

function attemptOf(t: TaskNode, i: number): Attempt {
  const a = t.attempts[i];
  if (a === undefined) throw new Error(`no attempt ${i}`);
  return a;
}

function phaseOf(l: LedgerV1, i = 0): PhaseRecord {
  const p = l.phases[i];
  if (p === undefined) throw new Error(`no phase ${i}`);
  return p;
}

function codesOf(v: unknown): Set<string> {
  return new Set(ledgerViolations(v).map((x) => x.code));
}

function shuffled<T>(items: readonly T[], rng: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const x = a[i] as T;
    a[i] = a[j] as T;
    a[j] = x;
  }
  return a;
}

// ---------------------------------------------------------------------------------------------------------------
// Constants and lists
// ---------------------------------------------------------------------------------------------------------------

describe("constants and enumerations", () => {
  it("lists every enum value once", () => {
    expect(TASK_STATES).toHaveLength(16);
    expect(new Set(TASK_STATES).size).toBe(16);
    expect(GATE_STATES).toHaveLength(6);
    expect(new Set(GATE_STATES).size).toBe(6);
    expect(LEDGER_STATUSES).toHaveLength(7);
    expect(new Set(LEDGER_STATUSES).size).toBe(7);
    expect([...TASK_KINDS]).toEqual(["preflight", "task", "tests", "qa", "fix", "manual"]);
    expect([...ATTEMPT_OUTCOMES]).toEqual(["succeeded", "failed", "interrupted", "lost", "capacity"]);
    expect([...VERDICTS]).toEqual(["pass", "fail", "unverifiable"]);
  });

  it("QA-PDF21-2-18: every budget round of an attempt fits the guard's cumulative ceiling, and one more would not", () => {
    // The first launch plus BUDGET_RESUMES resumes, each with a full per-dispatch budget, stay within budget × multiplier.
    for (const budget of [1, 25, 50]) {
      const cumulative = budget * GUARD_CUMULATIVE_MULTIPLIER;
      expect((BUDGET_RESUMES + 1) * budget).toBeLessThanOrEqual(cumulative);
      expect((BUDGET_RESUMES + 2) * budget).toBeGreaterThan(cumulative);
    }
  });

  it("exposes the documented numeric constants and patterns", () => {
    expect(LEDGER_SCHEMA).toBe(1);
    expect(LAUNCH_CONFIRM_TIMEOUT_MS).toBe(30_000);
    expect(CHILD_END_GRACE_MS).toBe(5_000);
    expect(HEAVY_CAP_PER_PROVIDER).toBe(2);
    expect(BUDGET_RESUMES).toBe(GUARD_CUMULATIVE_MULTIPLIER - 1);
    expect(WIP_TRAILER).toBe("Omr-Wip");
    expect(ORCHESTRATOR_SHELL_RE.test("Plan (ORCHESTRATOR SHELL)")).toBe(true);
    expect(ORCHESTRATOR_SHELL_RE.test("orchestrator shell")).toBe(false);
    expect(PLAN_ID_PATTERN.test("abc")).toBe(true);
    expect(PLAN_ID_PATTERN.test("ab")).toBe(false);
    expect(PLAN_ID_PATTERN.test("a".repeat(41))).toBe(true);
    expect(PLAN_ID_PATTERN.test("a".repeat(42))).toBe(false);
    expect(PLAN_ID_PATTERN.test("-abc")).toBe(false);
    expect(PLAN_ID_PATTERN.test("Abc")).toBe(false);
    expect(NONCE_PATTERN.test(NONCE)).toBe(true);
    expect(NONCE_PATTERN.test(NONCE.toUpperCase())).toBe(false);
    expect(NONCE_PATTERN.test(NONCE.slice(1))).toBe(false);
  });

  it("task ids are never integer-like and carry no ':', '#', ']' or space", () => {
    for (const ok of ["T1", "1.4.4", "p1.FIX1-2", "a", "1a", "A_b-c.d", "a".repeat(64)]) expect(TASK_ID_PATTERN.test(ok)).toBe(true);
    for (const bad of ["1", "42", "0123", "", "a:b", "a#b", "a]b", "a b", "-a", ".a", "_a", "a".repeat(65)]) {
      expect(TASK_ID_PATTERN.test(bad)).toBe(false);
    }
  });

  it("task ids that collide with Object.prototype names are reserved (QA-1.4-31)", () => {
    const reserved = ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf", "prototype"];
    for (const id of reserved) {
      expect(RESERVED_TASK_IDS.has(id), id).toBe(true);
      expect(isTaskId(id), id).toBe(false);
      expect(isTaskNode({ ...taskNode("T1"), id }), id).toBe(false);
    }
    for (const ok of ["T1", "constructors", "toString2", "value"]) {
      expect(isTaskId(ok), ok).toBe(true);
    }
    expect(isTaskId(5)).toBe(false);
    expect(isTaskNode(taskNode("T1"))).toBe(true);
  });

  it("a `__proto__` key in tasks stays an own entry and is reported, not interpreted", () => {
    const l = JSON.parse(JSON.stringify({ ...LEDGER, tasks: {} })) as LedgerV1;
    Object.defineProperty(l.tasks, "__proto__", { value: taskNode("T1"), enumerable: true, configurable: true, writable: true });
    expect(isLedgerV1(l)).toBe(false);
    expect(ledgerViolations(l).some((v) => v.code === "task-key")).toBe(true);
    expect(Object.getPrototypeOf(l.tasks)).toBe(Object.prototype);
  });

  it("EXECUTOR_DEFAULTS sit within EXECUTOR_LIMITS and are frozen", () => {
    const L = EXECUTOR_LIMITS;
    const D = EXECUTOR_DEFAULTS;
    const within = (v: number, r: readonly [number, number]) => v >= r[0] && v <= r[1];
    expect(within(D.maxParallel, L.maxParallel)).toBe(true);
    expect(within(D.batchMax, L.batchMax)).toBe(true);
    expect(within(D.maxAttempts, L.maxAttempts)).toBe(true);
    expect(within(D.qaMaxRounds, L.qaMaxRounds)).toBe(true);
    expect(within(D.sharedContextChars, L.sharedContextChars)).toBe(true);
    expect(within(D.capacityCooldownMs, L.capacityCooldownMs)).toBe(true);
    expect(within(D.capacityPauseMs, L.capacityPauseMs)).toBe(true);
    expect(within(D.wakeDebounceMs, L.wakeDebounceMs)).toBe(true);
    expect(within(D.circuitBreaker.failureRatio, L.failureRatio)).toBe(true);
    expect(within(D.circuitBreaker.minAttempts, L.minAttempts)).toBe(true);
    expect(within(D.circuitBreaker.consecutiveFailures, L.consecutiveFailures)).toBe(true);
    expect(Object.isFrozen(D)).toBe(true);
    expect(Object.isFrozen(D.circuitBreaker)).toBe(true);
    expect(D.slotsDir).toBeNull();
    expect(D.maxParallel).toBe(4);
    expect(D.maxAttempts).toBe(3);
  });

  it("every limit range is ordered", () => {
    for (const r of Object.values(EXECUTOR_LIMITS)) expect(r[0]).toBeLessThanOrEqual(r[1]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// §3 Task state machine
// ---------------------------------------------------------------------------------------------------------------

const ALL_TRIGGERS: readonly TransitionTrigger[] = [
  "deps-satisfied", "dep-parked", "dep-blocked", "abort", "launch", "dep-reverted", "adopt", "reported-done", "dep-added",
  "child-created", "launch-lost", "launch-task-error", "child-ended", "child-failed", "lease-unresolvable", "qa-unparsable",
  "escalate", "ambiguity", "budget-cap", "child-lost", "capacity-stop", "lease-needed", "committed", "no-changes", "commit-failed",
  "verify-pass", "verify-fail", "dequeued", "fast-forwarded", "rebase-conflict", "checks-failed", "suite-culprit", "retry",
  "exhausted", "answered", "dep-recovered",
];
const ALL_OWNERS: readonly TransitionOwner[] = ["Rt", "Q", "P", "Rc"];

interface Pair { from: TaskState; to: TaskState; key: TransitionKey }
const ALL_PAIRS: Pair[] = TASK_STATES.flatMap((from) => TASK_STATES.map((to) => ({ from, to, key: `${from}>${to}` as TransitionKey })));

describe("task state machine (§3.1)", () => {
  const legal = ALL_PAIRS.filter((p) => canTransition(p.from, p.to));
  const illegal = ALL_PAIRS.filter((p) => !canTransition(p.from, p.to));

  it("covers all 256 (from, to) pairs with exactly 47 legal", () => {
    expect(ALL_PAIRS).toHaveLength(256);
    expect(legal).toHaveLength(47);
    expect(illegal).toHaveLength(209);
    expect(Object.values(TASK_TRANSITIONS).reduce((n, row) => n + row.length, 0)).toBe(47);
    for (const s of TASK_STATES) expect(new Set(TASK_TRANSITIONS[s]).size).toBe(TASK_TRANSITIONS[s].length);
  });

  it("every legal pair has at least one trigger and an owner; illegal pairs have neither", () => {
    for (const p of legal) {
      const triggers = TRANSITION_TRIGGERS[p.key];
      const owners = TRANSITION_OWNERS[p.key];
      expect(triggers, p.key).toBeDefined();
      expect(triggers?.length ?? 0, p.key).toBeGreaterThanOrEqual(1);
      expect(owners, p.key).toBeDefined();
      expect(owners?.length ?? 0, p.key).toBeGreaterThanOrEqual(1);
      for (const t of triggers ?? []) expect(ALL_TRIGGERS, `${p.key} ${t}`).toContain(t);
      for (const o of owners ?? []) expect(ALL_OWNERS, `${p.key} ${o}`).toContain(o);
      expect(new Set(triggers).size).toBe(triggers?.length);
    }
    for (const p of illegal) {
      expect(TRANSITION_TRIGGERS[p.key], p.key).toBeUndefined();
      expect(TRANSITION_OWNERS[p.key], p.key).toBeUndefined();
    }
  });

  it("the trigger and owner tables have exactly the 47 legal keys, and every trigger is used", () => {
    const legalKeys = legal.map((p) => p.key).sort();
    expect(Object.keys(TRANSITION_TRIGGERS).sort()).toEqual(legalKeys);
    expect(Object.keys(TRANSITION_OWNERS).sort()).toEqual(legalKeys);
    const used = new Set(Object.values(TRANSITION_TRIGGERS).flatMap((t) => t ?? []));
    expect([...used].sort()).toEqual([...ALL_TRIGGERS].sort());
  });

  it("the three *>blocked rows are owned by the queue only (A1-2)", () => {
    for (const key of ["ready>blocked", "dispatched>blocked", "running>blocked"] as const) {
      expect(TRANSITION_OWNERS[key], key).toEqual(["Q"]);
      expect(TRANSITION_TRIGGERS[key], key).toEqual(["dep-reverted"]);
    }
    expect(TRANSITION_OWNERS["pending>blocked"]).toEqual(["P"]);
  });

  it("re-entering a state is never a transition", () => {
    for (const s of TASK_STATES) expect(canTransition(s, s), s).toBe(false);
  });

  it("matches hand-picked legal and illegal pairs", () => {
    const yes: Array<[TaskState, TaskState]> = [
      ["pending", "ready"], ["ready", "dispatched"], ["ready", "pending"], ["ready", "done"], ["dispatched", "running"],
      ["running", "completed"], ["completed", "verifying"], ["completed", "done"], ["verifying", "verified"],
      ["verified", "integrating"], ["integrating", "integrated"], ["integrated", "reverted"], ["failed", "ready"],
      ["parked", "ready"], ["blocked", "ready"], ["reverted", "parked"],
    ];
    const no: Array<[TaskState, TaskState]> = [
      ["pending", "integrated"], ["pending", "running"], ["ready", "verified"], ["running", "verified"],
      ["completed", "integrated"], ["verifying", "integrating"], ["verified", "integrated"], ["verified", "done"],
      ["integrated", "done"], ["integrated", "ready"], ["done", "ready"], ["cancelled", "ready"], ["done", "cancelled"],
      ["failed", "running"], ["blocked", "parked"], ["parked", "blocked"],
    ];
    for (const [a, b] of yes) expect(canTransition(a, b), `${a}>${b}`).toBe(true);
    for (const [a, b] of no) expect(canTransition(a, b), `${a}>${b}`).toBe(false);
  });

  it("terminal states: done and cancelled have no exits; integrated only leaves to reverted", () => {
    expect([...TERMINAL_TASK_STATES].sort()).toEqual(["cancelled", "done"]);
    for (const s of TERMINAL_TASK_STATES) {
      expect(TASK_TRANSITIONS[s]).toEqual([]);
      for (const to of TASK_STATES) expect(canTransition(s, to), `${s}>${to}`).toBe(false);
    }
    expect([...TASK_TRANSITIONS.integrated]).toEqual(["reverted"]);
    for (const to of TASK_STATES) expect(canTransition("integrated", to)).toBe(to === "reverted");
    // Every non-terminal, non-integrated state has at least one exit; no other state is a dead end.
    for (const s of TASK_STATES) {
      if (s === "done" || s === "cancelled") continue;
      expect(TASK_TRANSITIONS[s].length, s).toBeGreaterThan(0);
    }
  });

  it("only integrating -> integrated reaches integrated, and only verified -> integrating reaches integrating", () => {
    const into = (target: TaskState) => legal.filter((p) => p.to === target).map((p) => p.from);
    expect(into("integrated")).toEqual(["integrating"]);
    expect(into("integrating")).toEqual(["verified"]);
    expect(into("verified")).toEqual(["verifying"]);
    expect(into("verifying")).toEqual(["completed"]);
  });

  function reachable(start: TaskState, removed: ReadonlySet<TaskState>): Set<TaskState> {
    const seen = new Set<TaskState>([start]);
    const queue: TaskState[] = [start];
    while (queue.length > 0) {
      const cur = queue.shift() as TaskState;
      for (const next of TASK_TRANSITIONS[cur]) {
        if (removed.has(next) || seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    return seen;
  }

  it("BFS: integrated is reachable from pending only through verified", () => {
    expect(reachable("pending", new Set()).has("integrated")).toBe(true);
    expect(reachable("pending", new Set<TaskState>(["verified"])).has("integrated")).toBe(false);
    expect(reachable("pending", new Set<TaskState>(["verified"])).has("integrating")).toBe(false);
    // Every state on the verified chain is a cut vertex; `dispatched` is not (ready -> running adopts a child).
    for (const s of ["ready", "running", "completed", "verifying", "verified", "integrating"] as const) {
      expect(reachable("pending", new Set<TaskState>([s])).has("integrated"), `without ${s}`).toBe(false);
    }
    expect(reachable("pending", new Set<TaskState>(["dispatched"])).has("integrated")).toBe(true);
    // Starting anywhere other than the chain, integrated stays unreachable without verified.
    for (const s of ["failed", "conflict", "parked", "blocked", "reverted"] as const) {
      expect(reachable(s, new Set<TaskState>(["verified"])).has("integrated"), s).toBe(false);
    }
  });

  it("BFS: every state is reachable from pending; terminal states are reachable too", () => {
    const all = reachable("pending", new Set());
    for (const s of TASK_STATES) expect(all.has(s), s).toBe(true);
    // From integrated only integrated and what reverted leads to are reachable.
    // Reverting loops back into the whole machine.
    expect(reachable("integrated", new Set()).size).toBe(16);
    expect(reachable("done", new Set())).toEqual(new Set<TaskState>(["done"]));
    expect(reachable("cancelled", new Set())).toEqual(new Set<TaskState>(["cancelled"]));
  });

  it("durable task states are the fsynced ones and all are real states", () => {
    expect([...DURABLE_TASK_STATES]).toEqual(["dispatched", "running", "completed", "integrating", "integrated", "reverted", "cancelled"]);
    for (const s of DURABLE_TASK_STATES) expect(TASK_STATES).toContain(s);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// §3.3 / §3.4 gate and status machines
// ---------------------------------------------------------------------------------------------------------------

describe("gate state machine (§3.3), cell by cell", () => {
  const legal: Record<GateState, GateState[]> = {
    pending: ["suite-running", "awaiting-qa"],
    "suite-running": ["awaiting-qa", "suite-failed"],
    "suite-failed": ["pending", "suite-running"],
    "awaiting-qa": ["qa-running", "passed", "pending"],
    "qa-running": ["awaiting-qa", "pending", "passed"],
    passed: [],
  };

  const ALL_GATE_TRIGGERS: readonly GateTrigger[] = [
    "phase-integrated", "suite-passed", "suite-culprit-found", "culprit-reverted", "suite-rerun", "qa-dispatched",
    "qa-requeued", "qa-cap", "qa-next-round", "qa-clean", "no-open-qa", "cap-accepted", "cap-fix",
  ];
  const ALL_GATE_OWNERS: readonly GateOwner[] = ["Rt", "Q", "P", "Rc", "QL"];
  /** A1-1 table, written out independently of the source constants: [from, to, triggers, owners]. */
  const EXPECTED_ROWS: Array<[GateState, GateState, GateTrigger[], GateOwner[]]> = [
    ["pending", "suite-running", ["phase-integrated"], ["Q"]],
    ["pending", "awaiting-qa", ["phase-integrated"], ["Q"]],
    ["suite-running", "awaiting-qa", ["suite-passed"], ["Q"]],
    ["suite-running", "suite-failed", ["suite-culprit-found"], ["Q"]],
    ["suite-failed", "pending", ["culprit-reverted"], ["Q"]],
    ["suite-failed", "suite-running", ["suite-rerun"], ["Q"]],
    ["awaiting-qa", "qa-running", ["qa-dispatched"], ["Rt", "Rc"]],
    ["awaiting-qa", "passed", ["no-open-qa", "cap-accepted"], ["QL"]],
    ["awaiting-qa", "pending", ["cap-fix"], ["QL"]],
    ["qa-running", "awaiting-qa", ["qa-requeued", "qa-cap"], ["Rt", "P", "Q", "QL"]],
    ["qa-running", "pending", ["qa-next-round"], ["QL"]],
    ["qa-running", "passed", ["qa-clean"], ["QL"]],
  ];

  it("has exactly the 12 A1-1 rows, each with its triggers and owners; illegal cells have neither", () => {
    expect(EXPECTED_ROWS).toHaveLength(12);
    const keys = EXPECTED_ROWS.map(([a, b]) => `${a}>${b}`).sort();
    expect(Object.keys(GATE_TRANSITION_TRIGGERS).sort()).toEqual(keys);
    expect(Object.keys(GATE_TRANSITION_OWNERS).sort()).toEqual(keys);
    for (const [a, b, triggers, owners] of EXPECTED_ROWS) {
      const key = `${a}>${b}` as GateTransitionKey;
      expect(canGateTransition(a, b), key).toBe(true);
      expect(GATE_TRANSITION_TRIGGERS[key], key).toEqual(triggers);
      expect(GATE_TRANSITION_OWNERS[key], key).toEqual(owners);
      for (const t of triggers) expect(ALL_GATE_TRIGGERS).toContain(t);
      for (const o of owners) expect(ALL_GATE_OWNERS).toContain(o);
    }
    for (const a of GATE_STATES) {
      for (const b of GATE_STATES) {
        if (canGateTransition(a, b)) continue;
        expect(GATE_TRANSITION_TRIGGERS[`${a}>${b}` as GateTransitionKey], `${a}>${b}`).toBeUndefined();
        expect(GATE_TRANSITION_OWNERS[`${a}>${b}` as GateTransitionKey], `${a}>${b}`).toBeUndefined();
      }
    }
    const used = new Set(Object.values(GATE_TRANSITION_TRIGGERS).flatMap((t) => t ?? []));
    expect([...used].sort()).toEqual([...ALL_GATE_TRIGGERS].sort());
  });

  it("awaiting-qa > pending is legal (cap-fix, QaLoop) and passed has no exits", () => {
    expect(canGateTransition("awaiting-qa", "pending")).toBe(true);
    expect(GATE_TRANSITION_TRIGGERS["awaiting-qa>pending"]).toEqual(["cap-fix"]);
    expect(GATE_TRANSITION_OWNERS["awaiting-qa>pending"]).toEqual(["QL"]);
    for (const b of GATE_STATES) expect(canGateTransition("passed", b), b).toBe(false);
  });

  it("GATE_TRIGGER_OWNERS covers every trigger and refines the pair owners (QA-1.4-29)", () => {
    expect(Object.keys(GATE_TRIGGER_OWNERS).sort()).toEqual([...ALL_GATE_TRIGGERS].sort());
    expect(GATE_TRIGGER_OWNERS["qa-requeued"]).toEqual(["Rt", "P", "Q"]);
    expect(GATE_TRIGGER_OWNERS["qa-cap"]).toEqual(["QL"]);
    for (const [a, b, triggers, owners] of EXPECTED_ROWS) {
      const union = new Set(triggers.flatMap((t) => GATE_TRIGGER_OWNERS[t]));
      expect([...union].sort(), `${a}>${b}`).toEqual([...owners].sort());
      for (const t of triggers) {
        for (const o of GATE_TRIGGER_OWNERS[t]) expect(owners, `${t}:${o}`).toContain(o);
      }
    }
  });

  it("row 4b of a qa task writes G1 then G2 as a legal chain that returns to the phase's gate (QA-1.4-24)", () => {
    const start: GateState = "awaiting-qa";
    const batch: Array<{ from: GateState; to: GateState; trigger: GateTrigger; owner: GateOwner }> = [
      { from: "awaiting-qa", to: "qa-running", trigger: "qa-dispatched", owner: "Rt" },
      { from: "qa-running", to: "awaiting-qa", trigger: "qa-requeued", owner: "Rt" },
    ];
    let gate: GateState = start;
    for (const e of batch) {
      expect(e.from, e.trigger).toBe(gate); // the replay check `from === phase.gate`
      expect(canGateTransition(e.from, e.to), e.trigger).toBe(true);
      expect(GATE_TRANSITION_TRIGGERS[`${e.from}>${e.to}` as GateTransitionKey], e.trigger).toContain(e.trigger);
      expect(GATE_TRIGGER_OWNERS[e.trigger], e.trigger).toContain(e.owner);
      gate = e.to;
    }
    expect(gate).toBe(start);
    // Writing only G2 (or only G1) would be illegal against the phase's gate.
    expect(canGateTransition("awaiting-qa", "awaiting-qa")).toBe(false);
  });

  it("matches the expected 6x6 table", () => {
    let legalCount = 0;
    for (const a of GATE_STATES) {
      for (const b of GATE_STATES) {
        const expected = legal[a].includes(b);
        expect(canGateTransition(a, b), `${a}>${b}`).toBe(expected);
        if (expected) legalCount++;
      }
    }
    expect(legalCount).toBe(12);
    expect(GATE_STATES.length * GATE_STATES.length).toBe(36);
  });

  it("passed is terminal and no state re-enters itself", () => {
    expect(GATE_TRANSITIONS.passed).toEqual([]);
    for (const s of GATE_STATES) expect(canGateTransition(s, s), s).toBe(false);
  });
});

describe("ledger status machine (§3.4), cell by cell", () => {
  const legal: Record<LedgerStatus, LedgerStatus[]> = {
    compiling: ["awaiting-residue", "awaiting-approval", "aborted"],
    "awaiting-residue": ["awaiting-approval", "aborted"],
    "awaiting-approval": ["running", "aborted"],
    running: ["paused", "completed", "aborted"],
    paused: ["running", "aborted"],
    completed: [],
    aborted: [],
  };

  it("matches the expected 7x7 table", () => {
    let legalCount = 0;
    for (const a of LEDGER_STATUSES) {
      for (const b of LEDGER_STATUSES) {
        const expected = legal[a].includes(b);
        expect(canStatusTransition(a, b), `${a}>${b}`).toBe(expected);
        if (expected) legalCount++;
      }
    }
    expect(legalCount).toBe(12);
    expect(LEDGER_STATUSES.length * LEDGER_STATUSES.length).toBe(49);
  });

  it("completed and aborted are terminal; no status re-enters itself", () => {
    expect(LEDGER_STATUS_TRANSITIONS.completed).toEqual([]);
    expect(LEDGER_STATUS_TRANSITIONS.aborted).toEqual([]);
    for (const s of LEDGER_STATUSES) expect(canStatusTransition(s, s), s).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// §4 Attempt counting
// ---------------------------------------------------------------------------------------------------------------

describe("attempt counting (§4)", () => {
  it("countsTowardMaxAttempts is true only for succeeded and failed", () => {
    const expected: Record<AttemptOutcome, boolean> = {
      succeeded: true, failed: true, interrupted: false, lost: false, capacity: false,
    };
    for (const o of ATTEMPT_OUTCOMES) expect(countsTowardMaxAttempts(attempt(1, o)), o).toBe(expected[o]);
    expect(countsTowardMaxAttempts(attempt(1, null))).toBe(false);
  });

  it("countedAttempts ignores interrupted, lost, capacity and open attempts", () => {
    const t = taskNode("T9", {
      attempts: [
        attempt(1, "capacity"), attempt(2, "failed"), attempt(3, "lost"), attempt(4, "interrupted"),
        attempt(5, "succeeded"), attempt(6, null),
      ],
    });
    expect(countedAttempts(t)).toBe(2);
    expect(countedAttempts(taskNode("T8"))).toBe(0);
    expect(countedAttempts(taskNode("T7", { attempts: [attempt(1, "capacity"), attempt(2, "lost")] }))).toBe(0);
  });

  it("hasAttemptsLeft is true while counted < maxAttempts", () => {
    const t = taskNode("T9", { attempts: [attempt(1, "failed"), attempt(2, "capacity"), attempt(3, "failed")] });
    expect(countedAttempts(t)).toBe(2);
    expect(hasAttemptsLeft(t, 3)).toBe(true);
    expect(hasAttemptsLeft(t, 2)).toBe(false);
    expect(hasAttemptsLeft(t, 1)).toBe(false);
    expect(hasAttemptsLeft(taskNode("T8"), 1)).toBe(true);
    expect(hasAttemptsLeft(taskNode("T8"), 0)).toBe(false);
  });

  it("isBreakerFailure: a failed attempt, or a fail/unverifiable verdict", () => {
    expect(isBreakerFailure(attempt(1, "failed"))).toBe(true);
    expect(isBreakerFailure(attempt(1, "failed", "pass"))).toBe(true);
    expect(isBreakerFailure(attempt(1, "succeeded", "fail"))).toBe(true);
    expect(isBreakerFailure(attempt(1, "succeeded", "unverifiable"))).toBe(true);
    expect(isBreakerFailure(attempt(1, "succeeded", "pass"))).toBe(false);
    expect(isBreakerFailure(attempt(1, "succeeded"))).toBe(false);
    expect(isBreakerFailure(attempt(1, "interrupted"))).toBe(false);
    expect(isBreakerFailure(attempt(1, "lost"))).toBe(false);
    expect(isBreakerFailure(attempt(1, "capacity"))).toBe(false);
    expect(isBreakerFailure(attempt(1, null))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// §8 provider errors
// ---------------------------------------------------------------------------------------------------------------

describe("provider error classification (R3)", () => {
  const cases: Array<{ type: string; status: number | null; klass: "rate-limit" | "overload" | "quota" | null }> = [
    { type: "provider.rate-limit", status: null, klass: "rate-limit" },
    { type: "provider.rate-limit", status: 429, klass: "rate-limit" },
    { type: "provider.rate-limit", status: 500, klass: "rate-limit" },
    { type: "provider.rate-limit", status: 529, klass: "rate-limit" },
    { type: "provider.internal", status: 529, klass: "overload" },
    { type: "provider.internal", status: null, klass: null },
    { type: "provider.internal", status: 500, klass: null },
    { type: "provider.internal", status: 429, klass: "rate-limit" },
    { type: "provider.quota", status: null, klass: "quota" },
    { type: "provider.quota", status: 429, klass: "quota" },
    { type: "provider.quota", status: 402, klass: "quota" },
    { type: "unknown", status: 429, klass: "rate-limit" },
    { type: "unknown", status: 529, klass: "overload" },
    { type: "something.else", status: 429, klass: "rate-limit" },
    { type: "", status: 529, klass: "overload" },
    { type: "unknown", status: 500, klass: null },
    { type: "unknown", status: 400, klass: null },
    { type: "unknown", status: 0, klass: null },
    { type: "unknown", status: null, klass: null },
    { type: "provider.auth", status: 401, klass: null },
    { type: "Provider.Quota", status: null, klass: null },
  ];

  it.each(cases)("classifies $type / $status as $klass", ({ type, status, klass }) => {
    expect(classifyProviderError({ type, status })).toBe(klass);
  });

  it.each(cases)("executionFailureOutcome for $type / $status", ({ type, status, klass }) => {
    const e: HostError = { type, status, message: "boom" };
    expect(executionFailureOutcome(e)).toBe(klass === null ? "failed" : "capacity");
  });

  it("ignores the message", () => {
    expect(executionFailureOutcome({ type: "unknown", status: null, message: "429 rate limit exceeded" })).toBe("failed");
  });

  it("provider.internal is overload only with status 529; other statuses are a counted failure (QA-0.1-30)", () => {
    expect(classifyProviderError({ type: "provider.internal", status: 529 })).toBe("overload");
    expect(executionFailureOutcome({ type: "provider.internal", status: 529, message: "x" })).toBe("capacity");
    expect(executionFailureOutcome({ type: "provider.internal", status: 500, message: "x" })).toBe("failed");
    expect(executionFailureOutcome({ type: "provider.internal", status: null, message: "x" })).toBe("failed");
  });

  it("agrees with the Phase 1.1 timing classifier (classifyCapacity) on a shared {type, status} table (QA-0.1-30)", () => {
    const toTiming = { "rate-limit": "rate-limit", overload: "overload", quota: "usage-limit" } as const;
    for (const { type, status } of cases) {
      const executor = classifyProviderError({ type, status });
      expect(classifyCapacity({ type, status })).toBe(executor === null ? null : toTiming[executor]);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// §7 Launch header
// ---------------------------------------------------------------------------------------------------------------

const SHARED = "shared notes";
/** A prompt with `line` at the strict fixed position. */
function promptOf(line: string, shared: string = SHARED): string {
  return `PLAN CONTEXT\n${shared}\n\n${line}\n\nTASK\nDo the thing.`;
}

describe("launch header", () => {
  it("renders the documented line", () => {
    expect(formatLaunchHeader({ planId: "plan-one", taskId: "T1", attempt: 2, nonce: NONCE })).toBe(`[plan plan-one:T1#2] nonce=${NONCE}`);
  });

  it("round-trips planId, taskId, attempt and nonce", () => {
    const planIds = ["abc", "plan-one", "a".repeat(41), "0ab"];
    const taskIds = ["T1", "1.4.4", "p1.FIX1-2", "1a", "A_b-c.d", "a".repeat(64)];
    const attempts = [1, 2, 9, 10, 99, 1000, 9999];
    for (const planId of planIds) {
      for (const taskId of taskIds) {
        for (const attemptN of attempts) {
          const fields = { planId, taskId, attempt: attemptN, nonce: NONCE };
          const header = formatLaunchHeader(fields);
          expect(parseLaunchHeader(promptOf(header), SHARED)).toEqual(fields);
          expect(parseLaunchHeader(formatLaunchPrompt(SHARED, fields, "TASK\nbody"), SHARED)).toEqual(fields);
          expect(LAUNCH_HEADER_PATTERN.test(header)).toBe(true);
        }
      }
    }
  });

  it("finds the header line at the fixed position of a full prompt", () => {
    const fields = { planId: "plan-one", taskId: "T2", attempt: 3, nonce: NONCE };
    expect(parseLaunchHeader(promptOf(formatLaunchHeader(fields)), SHARED)).toEqual(fields);
    // an empty and a multi-line shared context
    expect(parseLaunchHeader(promptOf(formatLaunchHeader(fields), ""), "")).toEqual(fields);
    const multi = "line one\n\nline two\n";
    expect(parseLaunchHeader(promptOf(formatLaunchHeader(fields), multi), multi)).toEqual(fields);
  });

  it("returns null when there is no header or the header is malformed", () => {
    const bad = (line: string) => parseLaunchHeader(promptOf(line), SHARED);
    expect(parseLaunchHeader("", SHARED)).toBeNull();
    expect(parseLaunchHeader("no header here", SHARED)).toBeNull();
    expect(parseLaunchHeader(`PLAN CONTEXT\n${SHARED}\n\n`, SHARED)).toBeNull();
    expect(bad("no header here")).toBeNull();
    expect(bad(`[plan plan-one:T1#0] nonce=${NONCE}`)).toBeNull();
    expect(bad(`[plan plan-one:T1#10000] nonce=${NONCE}`)).toBeNull();
    expect(bad(`[plan plan-one:T1#1] nonce=${NONCE.toUpperCase()}`)).toBeNull();
    expect(bad(`[plan plan-one:T1#1] nonce=${NONCE.slice(1)}`)).toBeNull();
    expect(bad(`[plan PLAN:T1#1] nonce=${NONCE}`)).toBeNull();
    expect(bad(`[plan plan-one:T1#1] nonce=${NONCE} trailing`)).toBeNull();
    expect(bad(`[plan plan-one:T 1#1] nonce=${NONCE}`)).toBeNull();
    // a single newline after a valid header does not end the header line
    expect(parseLaunchHeader(`PLAN CONTEXT\n${SHARED}\n\n[plan plan-one:T1#1] nonce=${NONCE}\nTASK`, SHARED)).toBeNull();
  });

  it("strict parsing is position based: a header-shaped line elsewhere or a different shared context is not a header", () => {
    const fields = { planId: "plan-one", taskId: "T1", attempt: 1, nonce: NONCE };
    const line = formatLaunchHeader(fields);
    const other = { ...fields, nonce: "f".repeat(32) };
    // header-shaped line inside the shared context, real header after it
    const forged = `PLAN CONTEXT\n${formatLaunchHeader(other)}\n\n${line}\n\nTASK\nx`;
    expect(parseLaunchHeader(forged, formatLaunchHeader(other))).toBeNull();
    // the same prompt read with the ledger's real shared context finds no header at the fixed position
    expect(parseLaunchHeader(forged, SHARED)).toBeNull();
    // header only in the task block
    expect(parseLaunchHeader(`PLAN CONTEXT\n${SHARED}\n\nTASK\n${line}`, SHARED)).toBeNull();
    // wrong prefix
    expect(parseLaunchHeader(`${line}\n\nTASK`, SHARED)).toBeNull();
    expect(parseLaunchHeader(promptOf(line).replace("PLAN CONTEXT", "CONTEXT"), SHARED)).toBeNull();
  });

  it("looksLikePlanPrompt is loose: any header-shaped line matches", () => {
    const line = formatLaunchHeader({ planId: "plan-one", taskId: "T1", attempt: 1, nonce: NONCE });
    expect(looksLikePlanPrompt(promptOf(line))).toBe(true);
    expect(looksLikePlanPrompt(`anything\n${line}\nelse`)).toBe(true);
    expect(looksLikePlanPrompt(line)).toBe(true);
    expect(looksLikePlanPrompt("")).toBe(false);
    expect(looksLikePlanPrompt("[plan plan-one:T1#1] nonce=short")).toBe(false);
    expect(looksLikePlanPrompt(`prefix ${line}`)).toBe(false);
  });

  it("formatLaunchPrompt renders the §7 grammar and refuses a forged shared context or a task block without TASK", () => {
    const fields = { planId: "plan-one", taskId: "T1", attempt: 2, nonce: NONCE };
    const prompt = formatLaunchPrompt(SHARED, fields, "TASK\nT1 body");
    expect(prompt).toBe(`PLAN CONTEXT\n${SHARED}\n\n[plan plan-one:T1#2] nonce=${NONCE}\n\nTASK\nT1 body`);
    expect(parseLaunchHeader(prompt, SHARED)).toEqual(fields);
    const codeOf = (fn: () => unknown): string | undefined => {
      try {
        fn();
      } catch (e) {
        return e instanceof ExecutorError ? e.code : "other";
      }
      return undefined;
    };
    expect(codeOf(() => formatLaunchPrompt(`x\n${formatLaunchHeader(fields)}\ny`, fields, "TASK"))).toBe("E_LAUNCH_TASK");
    expect(codeOf(() => formatLaunchPrompt(SHARED, fields, "Do it"))).toBe("E_LAUNCH_TASK");
    expect(codeOf(() => formatLaunchPrompt(SHARED, fields, ""))).toBe("E_LAUNCH_TASK");
    expect(codeOf(() => formatLaunchPrompt(SHARED, { ...fields, attempt: 0 }, "TASK"))).toBe("E_LAUNCH_TASK");
  });

  it("rejects integer-like task ids", () => {
    for (const taskId of ["1", "42", "0123", "9999999"]) {
      expect(() => formatLaunchHeader({ planId: "plan-one", taskId, attempt: 1, nonce: NONCE }), taskId).toThrow(ExecutorError);
      expect(parseLaunchHeader(promptOf(`[plan plan-one:${taskId}#1] nonce=${NONCE}`), SHARED), taskId).toBeNull();
    }
  });

  it("the exported pattern keeps the corrected task-id lookahead (QA-1.4-12: consumers import it)", () => {
    expect(LAUNCH_HEADER_PATTERN.source).toContain("(?!\\d+#)");
    expect(LAUNCH_HEADER_PATTERN.test(`[plan plan-one:1a#1] nonce=${NONCE}`)).toBe(true);
    expect(LAUNCH_HEADER_PATTERN.test(`[plan plan-one:12#1] nonce=${NONCE}`)).toBe(false);
  });

  it("formatLaunchHeader throws ExecutorError E_LAUNCH_TASK on invalid fields", () => {
    const base = { planId: "plan-one", taskId: "T1", attempt: 1, nonce: NONCE };
    const bad = [
      { ...base, planId: "ab" },
      { ...base, planId: "Plan-one" },
      { ...base, planId: "a".repeat(42) },
      { ...base, planId: "" },
      { ...base, taskId: "" },
      { ...base, taskId: "a:b" },
      { ...base, taskId: "a#b" },
      { ...base, taskId: "a b" },
      { ...base, taskId: "a]b" },
      { ...base, taskId: "a".repeat(65) },
      { ...base, attempt: 0 },
      { ...base, attempt: -1 },
      { ...base, attempt: 1.5 },
      { ...base, attempt: 10000 },
      { ...base, attempt: Number.NaN },
      { ...base, attempt: Number.POSITIVE_INFINITY },
      { ...base, nonce: "" },
      { ...base, nonce: NONCE.toUpperCase() },
      { ...base, nonce: NONCE.slice(1) },
      { ...base, nonce: `${NONCE}0` },
      { ...base, nonce: "z".repeat(32) },
      { ...base, taskId: `T1#1] nonce=${NONCE}\n[plan plan-one:T1` },
      { ...base, planId: "abc\ndef" },
    ];
    for (const fields of bad) {
      let caught: unknown;
      try {
        formatLaunchHeader(fields);
      } catch (e) {
        caught = e;
      }
      expect(caught, JSON.stringify(fields)).toBeInstanceOf(ExecutorError);
      const err = caught as ExecutorError;
      expect(err.code).toBe("E_LAUNCH_TASK");
      expect(err.name).toBe("ExecutorError");
      expect(err).toBeInstanceOf(Error);
      expect(err.detail).toMatchObject({ planId: fields.planId, taskId: fields.taskId });
    }
  });
});

describe("ExecutorError", () => {
  it("carries code, message and detail (default null)", () => {
    const e = new ExecutorError("E_LOCK_HELD", "held");
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("E_LOCK_HELD");
    expect(e.message).toBe("held");
    expect(e.detail).toBeNull();
    const f = new ExecutorError("E_SEQ_GAP", "gap", { expected: 3, got: 5 });
    expect(f.detail).toEqual({ expected: 3, got: 5 });
  });

  it("supports the stale-base contract code", () => {
    expect(new ExecutorError("E_STALE_BASE", "base moved").code).toBe("E_STALE_BASE");
  });
});

describe("attempt-resumed event guard", () => {
  const event = { type: "attempt-resumed", taskId: "T2", n: 2, resumes: 1, at: T0, seq: 6, batch: 6, last: true };

  it("accepts a well-formed journal event", () => {
    expect(isAttemptResumedEvent(event)).toBe(true);
    expect(isAttemptResumedEvent(clone(event))).toBe(true);
    expect(isDurableEvent({ type: "attempt-resumed", taskId: "T2", n: 2, resumes: 1 })).toBe(true);
  });

  it("rejects malformed fields and missing required fields", () => {
    for (const key of Object.keys(event)) {
      const missing: Record<string, unknown> = { ...event };
      delete missing[key];
      expect(isAttemptResumedEvent(missing), `missing ${key}`).toBe(false);
    }
    for (const patch of [
      { type: "attempt-ended" }, { taskId: "constructor" }, { taskId: 1 },
      { n: 0 }, { n: 1.5 }, { n: "2" }, { resumes: 0 }, { resumes: -1 },
      { resumes: 1.5 }, { resumes: "1" }, { resumes: Number.NaN }, { resumes: Number.POSITIVE_INFINITY },
      { at: "yesterday" }, { seq: 0 }, { batch: 0 }, { last: "true" },
    ]) expect(isAttemptResumedEvent({ ...event, ...patch }), JSON.stringify(patch)).toBe(false);
    for (const value of [null, undefined, [], "attempt-resumed"]) expect(isAttemptResumedEvent(value)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Guards: isLedgerV1 / isTaskNode / ledgerSchemaOf
// ---------------------------------------------------------------------------------------------------------------

describe("ledger guards", () => {
  it("accepts a valid ledger built by the helper (and its JSON round trip)", () => {
    const l = buildLedger();
    expect(isLedgerV1(l)).toBe(true);
    expect(isLedgerV1(clone(l))).toBe(true);
    expect(ledgerSchemaOf(l)).toBe(1);
  });

  it("accepts attempts with and without the optional resumes counter", () => {
    const l = buildLedger();
    const a = attemptOf(taskOf(l, "T2"), 1);
    expect(a.resumes).toBeUndefined();
    expect(isLedgerV1(l)).toBe(true);
    for (const resumes of [0, 1, BUDGET_RESUMES]) {
      a.resumes = resumes;
      expect(isLedgerV1(l)).toBe(true);
    }
    delete a.resumes;
    expect(isLedgerV1(l)).toBe(true);
  });

  it("accepts the defaults config, explicit command refs and a provision record", () => {
    const l = clone(buildLedger());
    l.config.integrationChecks = [{ script: "typecheck", args: [] }, { script: "test-files", args: ["a.test.ts"] }];
    l.config.phaseSuite = "off";
    l.config.provision = { npm: [["install"], ["run", "build"]] };
    l.config.python = "python3";
    expect(isLedgerV1(l)).toBe(true);
    l.config.phaseSuite = [{ script: "test", args: [] }];
    expect(isLedgerV1(l)).toBe(true);
  });

  it("accepts every limit boundary and rejects one step outside", () => {
    const L = EXECUTOR_LIMITS;
    const set = (key: string, v: number): LedgerV1 => {
      const l = buildLedger();
      const root: unknown = clone(l);
      if (key.startsWith("circuitBreaker.")) setAt(root, ["config", "circuitBreaker", key.slice(15)], v);
      else setAt(root, ["config", key], v);
      return root as LedgerV1;
    };
    const rows: Array<[string, readonly [number, number], number]> = [
      ["maxParallel", L.maxParallel, 1], ["batchMax", L.batchMax, 1], ["maxAttempts", L.maxAttempts, 1],
      ["qaMaxRounds", L.qaMaxRounds, 1], ["capacityCooldownMs", L.capacityCooldownMs, 1],
      ["capacityPauseMs", L.capacityPauseMs, 1], ["wakeDebounceMs", L.wakeDebounceMs, 1],
      ["circuitBreaker.minAttempts", L.minAttempts, 1], ["circuitBreaker.consecutiveFailures", L.consecutiveFailures, 1],
      ["circuitBreaker.failureRatio", L.failureRatio, 0.01],
    ];
    for (const [key, r, step] of rows) {
      expect(isLedgerV1(set(key, r[0])), `${key} min`).toBe(true);
      expect(isLedgerV1(set(key, r[1])), `${key} max`).toBe(true);
      expect(isLedgerV1(set(key, r[0] - step)), `${key} below`).toBe(false);
      expect(isLedgerV1(set(key, r[1] + step)), `${key} above`).toBe(false);
    }
    // sharedContextChars: 0 is legal only with an empty shared context.
    const zero: unknown = clone(buildLedger());
    setAt(zero, ["config", "sharedContextChars"], 0);
    setAt(zero, ["sharedContext"], "");
    expect(isLedgerV1(zero)).toBe(true);
    setAt(zero, ["config", "sharedContextChars"], 60001);
    expect(isLedgerV1(zero)).toBe(false);
  });

  it("ledgerSchemaOf reads the numeric schema of any record", () => {
    expect(ledgerSchemaOf({ schema: 2 })).toBe(2);
    expect(ledgerSchemaOf({ schema: 1 })).toBe(1);
    expect(ledgerSchemaOf({ schema: 0 })).toBe(0);
    expect(ledgerSchemaOf({ schema: 1.5 })).toBe(1.5);
    expect(ledgerSchemaOf({ schema: "2" })).toBeNull();
    expect(ledgerSchemaOf({ schema: Number.NaN })).toBeNull();
    expect(ledgerSchemaOf({ schema: Number.POSITIVE_INFINITY })).toBeNull();
    expect(ledgerSchemaOf({})).toBeNull();
    expect(ledgerSchemaOf(null)).toBeNull();
    expect(ledgerSchemaOf(undefined)).toBeNull();
    expect(ledgerSchemaOf([1])).toBeNull();
    expect(ledgerSchemaOf("schema")).toBeNull();
    expect(ledgerSchemaOf(7)).toBeNull();
  });

  it("a newer schema is rejected by isLedgerV1 but readable by ledgerSchemaOf", () => {
    const l: unknown = clone(buildLedger());
    setAt(l, ["schema"], 2);
    expect(isLedgerV1(l)).toBe(false);
    expect(ledgerSchemaOf(l)).toBe(2);
  });

  it("rejects non-records", () => {
    for (const v of [null, undefined, 0, 1, "ledger", true, [], [buildLedger()], () => undefined]) expect(isLedgerV1(v)).toBe(false);
  });

  // Hand-written semantic mutations: each breaks exactly one rule.
  const SEMANTIC: Array<[string, (l: unknown) => void]> = [];
  const sem = (name: string, path: string, value: unknown) => SEMANTIC.push([`${name}: ${path}`, (l) => setAt(l, dotted(path), value)]);
  const semDel = (name: string, path: string) => SEMANTIC.push([`${name}: delete ${path}`, (l) => deleteAt(l, dotted(path))]);
  for (const v of [2, 0, -1, "1", 1.5, null, true]) sem("schema", "schema", v);
  for (const v of ["B", "a", "", null, 1]) sem("launcher", "launcher", v);
  for (const v of ["AB", "a", "ab", "-abc", "abc def", "a".repeat(42), "", "Plan-one", null, 7]) sem("planId", "planId", v);
  for (const v of ["ab".repeat(31), "ab".repeat(33), "AB".repeat(32), "zz".repeat(32), "", 7, null]) sem("planDigest", "planDigest", v);
  for (const v of ["unknown", "Running", "", null, 3]) sem("status", "status", v);
  for (const v of [9, 0, -1, 1.5, 100, "4", null, Number.NaN]) sem("maxParallel", "config.maxParallel", v);
  for (const v of [0, 9, 1.5]) sem("batchMax", "config.batchMax", v);
  for (const v of [0, 7, 2.5]) sem("maxAttempts", "config.maxAttempts", v);
  for (const v of [0, 9]) sem("qaMaxRounds", "config.qaMaxRounds", v);
  for (const v of [9999, 3600001]) sem("capacityCooldownMs", "config.capacityCooldownMs", v);
  for (const v of [59999, 86400001]) sem("capacityPauseMs", "config.capacityPauseMs", v);
  for (const v of [999, 60001]) sem("wakeDebounceMs", "config.wakeDebounceMs", v);
  for (const v of [0.09, 1.01, Number.NaN]) sem("failureRatio", "config.circuitBreaker.failureRatio", v);
  for (const v of [0, 51]) sem("minAttempts", "config.circuitBreaker.minAttempts", v);
  for (const v of [0, 51]) sem("consecutiveFailures", "config.circuitBreaker.consecutiveFailures", v);
  for (const v of ["maybe", "", null]) sem("approve", "config.approve", v);
  for (const v of ["both", "", null]) sem("crossPhase", "config.crossPhase", v);
  for (const v of ["force", "", null]) sem("land", "config.land", v);
  sem("integrationChecks", "config.integrationChecks", [{ script: "x" }]);
  sem("integrationChecks", "config.integrationChecks", [{ script: 1, args: [] }]);
  sem("integrationChecks", "config.integrationChecks", ["x"]);
  sem("phaseSuite", "config.phaseSuite", "on");
  sem("phaseSuite", "config.phaseSuite", [{ script: "x", args: [1] }]);
  sem("provision", "config.provision", { npm: ["install"] });
  sem("provision", "config.provision", { npm: [[1]] });
  sem("provision", "config.provision", { npm: "install" });
  sem("provision", "config.provision", "manual");
  for (const v of ["2026-10-11", "2026-10-11T00:00:00Z", "2026-10-11T00:00:00.0Z", "not a date", "2026-13-45T00:00:00.000Z", "2026-10-11T00:00:00.000+00:00", 1.7e12, null]) {
    sem("boundAt", "orchestrator.boundAt", v);
  }
  sem("sharedContext too long", "sharedContext", "x".repeat(12001));
  sem("sharedContext carries slotsDir", "sharedContext", "look in C:/slots/slot-1");
  for (const v of [0, -1, 1.5, "5", null, Number.NaN, Number.POSITIVE_INFINITY]) sem("seq", "seq", v);
  sem("phase unknown wave", "phases.0.wave", "w9");
  sem("phase bad gate", "phases.0.gate", "closed");
  for (const v of [-1, 1.5, "0"]) sem("qaRound", "phases.0.qaRound", v);
  sem("waves not an array", "waves", {});
  sem("task phase unknown", "tasks.T3.phase", "p9");
  sem("edge to unknown", "edges.0.to", "T99");
  sem("edge from unknown", "edges.0.from", "T99");
  sem("edge from unknown gate", "edges.1.from", "gate:p9");
  sem("edge bad kind", "edges.0.kind", "magic");
  sem("edge bad confidence", "edges.0.confidence", "certain");
  sem("inbox bad kind", "inbox.0.kind", "memo");
  sem("inbox bad severity", "inbox.0.severity", "fatal");
  sem("inbox bad createdAt", "inbox.0.createdAt", "yesterday");
  sem("task key mismatch", "tasks.T3.id", "T4");
  for (const v of ["12", "a:b", "a#b", "a b", "a]b", "", "-a", "a".repeat(65)]) sem("task id", "tasks.T3.id", v);
  // isTaskNode cross-field invariants, seen through the ledger.
  sem("attempt n off by one", "tasks.T2.attempts.1.n", 3);
  sem("attempt n zero", "tasks.T2.attempts.0.n", 0);
  sem("attempt n fractional", "tasks.T2.attempts.0.n", 1.5);
  sem("running without open attempt", "tasks.T2.attempts.1.outcome", "failed");
  sem("pending with open attempt", "tasks.T2.state", "ready");
  sem("running without slot", "tasks.T2.slot", null);
  for (const st of ["dispatched", "completed", "verifying", "verified", "integrating"]) {
    SEMANTIC.push([`state ${st} without slot`, (l) => {
      setAt(l, ["tasks", "T2", "state"], st);
      setAt(l, ["tasks", "T2", "slot"], null);
      setAt(l, ["tasks", "T2", "branch"], "b");
      if (st !== "dispatched") {
        setAt(l, ["tasks", "T2", "attempts", 1, "outcome"], "succeeded");
        setAt(l, ["tasks", "T2", "attempts", 1, "endedAt"], T0);
      }
    }]);
  }
  for (const st of ["verifying", "verified", "integrating"]) {
    SEMANTIC.push([`state ${st} without branch`, (l) => {
      setAt(l, ["tasks", "T2", "state"], st);
      setAt(l, ["tasks", "T2", "attempts", 1, "outcome"], "succeeded");
      setAt(l, ["tasks", "T2", "attempts", 1, "endedAt"], T0);
    }]);
  }
  sem("integrated without range", "tasks.T1.integrated", null);
  sem("integrated range wrong type", "tasks.T1.integrated", { from: 1, to: "b" });
  sem("manual with attempts", "tasks.M1.attempts", [attempt(1, "failed")]);
  SEMANTIC.push(["preflight with attempts", (l) => {
    setAt(l, ["tasks", "M1", "kind"], "preflight");
    setAt(l, ["tasks", "M1", "attempts"], [attempt(1, "failed")]);
  }]);
  sem("estimate p50 > p90", "tasks.T3.estimate", { p50: 30, p90: 20, source: "s" });
  sem("estimate negative", "tasks.T3.estimate", { p50: -1, p90: 20, source: "s" });
  sem("estimate infinite", "tasks.T3.estimate", { p50: 1, p90: Number.POSITIVE_INFINITY, source: "s" });
  sem("estimate NaN", "tasks.T3.estimate", { p50: Number.NaN, p90: 1, source: "s" });
  for (const p of ["/abs", "a/../b", "a//b", "a\\b", "./a", "a/", "", "..", "a/./b"]) sem("footprint path", "tasks.T3.footprint.writes", [p]);
  sem("footprint read path", "tasks.T3.footprint.reads", ["../x"]);
  sem("footprint confidence", "tasks.T3.footprint.confidence", "sure");
  sem("footprint source", "tasks.T3.footprint.sources", ["guess"]);
  sem("route tier", "tasks.T3.route.tier", "ultra");
  sem("verify", "tasks.T3.verify", "maybe");
  sem("kind", "tasks.T3.kind", "chore");
  sem("state", "tasks.T3.state", "limbo");
  sem("attempt nonce short", "tasks.T1.attempts.0.nonce", NONCE.slice(1));
  sem("attempt nonce upper", "tasks.T1.attempts.0.nonce", NONCE.toUpperCase());
  sem("attempt startedAt", "tasks.T1.attempts.0.startedAt", "soon");
  sem("attempt endedAt", "tasks.T1.attempts.0.endedAt", "later");
  sem("attempt outcome", "tasks.T1.attempts.0.outcome", "won");
  sem("attempt verdict", "tasks.T1.attempts.0.verdict", "great");
  semDel("config", "config");
  semDel("tasks", "tasks");
  semDel("edges", "edges");
  semDel("inbox", "inbox");

  it(`rejects each of ${SEMANTIC.length} hand-written invariant violations`, () => {
    expect(SEMANTIC.length).toBeGreaterThanOrEqual(100);
    const accepted: string[] = [];
    for (const [name, apply] of SEMANTIC) {
      const l: unknown = clone(buildLedger());
      apply(l);
      if (isLedgerV1(l)) accepted.push(name);
    }
    expect(accepted).toEqual([]);
  });

  it("isTaskNode accepts a node in every state when its invariants hold", () => {
    for (const state of TASK_STATES) {
      const inFlight = state === "dispatched" || state === "running";
      const slotHeld = !["pending", "blocked", "parked", "done", "cancelled", "integrated", "reverted"].includes(state);
      const node = taskNode("T5", {
        state, slot: slotHeld ? "slot-1" : null, branch: "omr/plan-one/t/T5",
        attempts: inFlight ? [attempt(1, null, null, { childSessionID: "ses-5" })] : [attempt(1, "succeeded", "pass")],
        integrated: state === "integrated" ? { from: SHA_A, to: SHA_B } : null,
      });
      expect(isTaskNode(node), state).toBe(true);
    }
    for (const kind of TASK_KINDS) expect(isTaskNode(taskNode("T5", { kind, attempts: [] })), kind).toBe(true);
    expect(isTaskNode(taskNode("T5", { route: { line: "l", role: "r", tier: null, pin: true } }))).toBe(true);
  });

  it("isTaskNode rejects the cross-field violations directly", () => {
    const bad: TaskNode[] = [
      taskNode("T5", { state: "running", slot: "s", attempts: [] }),
      taskNode("T5", { state: "running", slot: "s", attempts: [attempt(1, null), attempt(2, null)] }),
      taskNode("T5", { state: "running", slot: "s", attempts: [attempt(1, null), attempt(2, "failed")] }),
      taskNode("T5", { state: "dispatched", slot: null, attempts: [attempt(1, null)] }),
      taskNode("T5", { state: "ready", attempts: [attempt(1, null)] }),
      taskNode("T5", { state: "failed", attempts: [attempt(2, "failed")] }),
      taskNode("T5", { state: "verified", slot: "s", branch: null, attempts: [attempt(1, "succeeded")] }),
      taskNode("T5", { state: "integrated", slot: "s", branch: "b", integrated: null }),
      taskNode("T5", { kind: "manual", attempts: [attempt(1, "failed")] }),
      taskNode("T5", { kind: "preflight", attempts: [attempt(1, "failed")] }),
      taskNode("1"),
      taskNode("T5", { estimate: { p50: 5, p90: 1, source: "s" } }),
    ];
    for (const n of bad) expect(isTaskNode(n), JSON.stringify(n)).toBe(false);
    for (const v of [null, undefined, 0, "T1", [], true]) expect(isTaskNode(v)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Guard fuzzing (seeded)
// ---------------------------------------------------------------------------------------------------------------

describe("ledgerViolations: one rejection row per invariant code (A1-7, QA-1.4-8)", () => {
  const header = `[plan plan-one:T1#1] nonce=${NONCE}`;
  const addQa = (l: LedgerV1, id: string, patch: Partial<TaskNode>): void => {
    l.tasks[id] = taskNode(id, { kind: "qa", ...patch });
  };

  const ROWS: Array<[code: string, name: string, apply: (l: LedgerV1) => void]> = [
    // codes that existed before A1
    ["shape", "wrong type", (l) => { Reflect.set(l, "planId", 7); }],
    ["shape", "launcher", (l) => { Reflect.set(l, "launcher", "B"); }],
    ["shape", "config missing", (l) => { Reflect.deleteProperty(l, "config"); }],
    ["schema", "newer schema", (l) => { Reflect.set(l, "schema", 2); }],
    ["config-limits", "maxParallel 9", (l) => { l.config.maxParallel = 9; }],
    ["config-limits", "fractional batchMax", (l) => { l.config.batchMax = 1.5; }],
    ["task-key", "key differs from id", (l) => { taskOf(l, "T3").id = "T4"; }],
    ["task-phase", "unknown phase", (l) => { taskOf(l, "T3").phase = "p9"; }],
    ["phase-wave", "unknown wave", (l) => { phaseOf(l).wave = "w9"; }],
    ["edge-endpoint", "unknown target", (l) => { const e = l.edges[0]; if (e) e.to = "T99"; }],
    ["edge-endpoint", "unknown gate", (l) => { const e = l.edges[1]; if (e) e.from = "gate:p9"; }],
    ["seq", "zero", (l) => { l.seq = 0; }],
    ["attempt-n", "off by one", (l) => { attemptOf(taskOf(l, "T2"), 1).n = 3; }],
    ["open-attempt", "running task without open attempt", (l) => {
      const a = attemptOf(taskOf(l, "T2"), 1);
      a.outcome = "failed";
      a.endedAt = T0;
    }],
    ["open-attempt", "ready task with an open attempt", (l) => { taskOf(l, "T2").state = "ready"; }],
    ["slot-required", "running without slot", (l) => { taskOf(l, "T2").slot = null; }],
    ["branch-required", "verifying without branch", (l) => {
      const t = taskOf(l, "T2");
      t.state = "verifying";
      const a = attemptOf(t, 1);
      a.outcome = "succeeded";
      a.endedAt = T0;
    }],
    ["integrated-missing", "integrated without range", (l) => { taskOf(l, "T1").integrated = null; }],
    ["manual-attempts", "manual task with attempts", (l) => { taskOf(l, "M1").attempts = [attempt(1, "failed")]; }],
    ["shared-context-length", "too long", (l) => { l.sharedContext = "x".repeat(12001); }],
    ["shared-context-slot-path", "carries slotsDir", (l) => { l.sharedContext = "see C:/slots/slot-1"; }],
    // codes added by A1-7 in isTaskNode
    ["attempt-ended-pair", "closed attempt without endedAt", (l) => { attemptOf(taskOf(l, "T1"), 0).endedAt = null; }],
    ["attempt-ended-pair", "open attempt with endedAt", (l) => { attemptOf(taskOf(l, "T2"), 1).endedAt = T0; }],
    ["attempt-ended-pair", "endedAt before startedAt", (l) => { attemptOf(taskOf(l, "T1"), 0).endedAt = "2026-10-10T23:59:59.999Z"; }],
    ["verdict-unsucceeded", "verdict on a failed attempt", (l) => { attemptOf(taskOf(l, "T2"), 0).verdict = "pass"; }],
    ["verdict-unsucceeded", "verdict on an open attempt", (l) => { attemptOf(taskOf(l, "T2"), 1).verdict = "fail"; }],
    ["nonce-duplicate", "same nonce twice", (l) => { const t = taskOf(l, "T2"); attemptOf(t, 1).nonce = attemptOf(t, 0).nonce; }],
    ["running-without-child", "running, latest attempt has no child", (l) => { attemptOf(taskOf(l, "T2"), 1).childSessionID = null; }],
    ["slot-forbidden", "pending task holds a slot", (l) => { taskOf(l, "T3").slot = "slot-9"; }],
    ["slot-forbidden", "integrated task holds a slot", (l) => { taskOf(l, "T1").slot = "slot-1"; }],
    ["git-id", "short from", (l) => { taskOf(l, "T1").integrated = { from: "abc", to: SHA_B }; }],
    ["git-id", "upper-case to", (l) => { taskOf(l, "T1").integrated = { from: SHA_A, to: SHA_B.toUpperCase() }; }],
    ["qa-without-phase", "qa task without a phase", (l) => { const t = taskOf(l, "T3"); t.kind = "qa"; t.phase = null; }],
    // codes added by A1-7 in isLedgerV1
    ["path-not-absolute", "planPath", (l) => { l.planPath = "docs/PLAN.md"; }],
    ["path-not-absolute", "repo.toplevel", (l) => { l.repo.toplevel = "repo"; }],
    ["path-not-absolute", "integration.worktree", (l) => { l.integration.worktree = "slots/integration"; }],
    ["path-not-absolute", "config.slotsDir", (l) => { l.config.slotsDir = "slots"; }],
    ["git-id", "repo.baseCommit", (l) => { l.repo.baseCommit = "c0ffee"; }],
    ["git-id", "integration.head", (l) => { l.integration.head = SHA_C.toUpperCase(); }],
    ["phase-id", "double dot", (l) => { phaseOf(l).id = "a..b"; }],
    ["phase-id", "trailing dot", (l) => { phaseOf(l).id = "p1."; }],
    ["phase-id", ".lock suffix", (l) => { phaseOf(l).id = "p1.lock"; }],
    ["phase-duplicate", "same id twice", (l) => { l.phases.push({ ...phaseOf(l) }); }],
    ["wave-id", "space", (l) => { const w = l.waves[0]; if (w) w.id = "w 1"; }],
    ["wave-duplicate", "same id twice", (l) => { const w = l.waves[0]; if (w) l.waves.push({ ...w }); }],
    ["wave-membership", "phase listed in no wave", (l) => { const w = l.waves[0]; if (w) w.phases = []; }],
    ["wave-membership", "phase listed in two waves", (l) => { l.waves.push({ id: "w2", phases: ["p1"] }); }],
    ["wave-membership", "wave lists an unknown phase", (l) => { l.waves.push({ id: "w2", phases: ["p9"] }); }],
    ["phase-depends", "self dependency", (l) => { phaseOf(l).dependsOn = ["p1"]; }],
    ["phase-depends", "unknown dependency", (l) => { phaseOf(l).dependsOn = ["p9"]; }],
    ["slots-dir-unresolved", "running with slotsDir null", (l) => { l.config.slotsDir = null; }],
    ["inbox-id", "unknown prefix", (l) => { const i = l.inbox[0]; if (i) i.id = "X-1"; }],
    ["inbox-id", "prefix of another kind", (l) => { const i = l.inbox[0]; if (i) i.id = "F-1"; }],
    ["inbox-id", "leading zero", (l) => { const i = l.inbox[0]; if (i) i.id = "Q-01"; }],
    ["inbox-duplicate", "same id twice", (l) => { const i = l.inbox[0]; if (i) l.inbox.push({ ...i }); }],
    ["inbox-duplicate", "same number, other prefix", (l) => { const i = l.inbox[0]; if (i) l.inbox.push({ ...i, id: "F-1", kind: "failure" }); }],
    ["inbox-task", "unknown task", (l) => { const i = l.inbox[0]; if (i) i.taskId = "T99"; }],
    ["shared-context-header", "header-shaped line", (l) => { l.sharedContext = `notes\n${header}\nmore`; }],
    ["qa-multiple-open", "two open qa tasks", (l) => { addQa(l, "QA-a", {}); addQa(l, "QA-b", {}); }],
    ["qa-round", "zero", (l) => { phaseOf(l).qaRound = 0; }],
    ["qa-round", "above the limit", (l) => { phaseOf(l).qaRound = QA_ROUND_LIMIT + 1; }],
    ["qa-gate", "in-flight qa task but gate pending", (l) => { taskOf(l, "T2").kind = "qa"; }],
    ["qa-gate", "qa-running without any qa task", (l) => { phaseOf(l).gate = "qa-running"; }],
    ["qa-gate", "qa-running with only cancelled qa tasks", (l) => {
      phaseOf(l).gate = "qa-running";
      addQa(l, "QA-a", { state: "cancelled" });
    }],
    ["qa-gate", "qa-running with a pending qa task", (l) => {
      phaseOf(l).gate = "qa-running";
      addQa(l, "QA-a", {});
    }],
  ];

  it("a valid ledger has no violations", () => {
    expect(ledgerViolations(buildLedger())).toEqual([]);
  });

  it.each(ROWS)("%s: %s", (code, _name, apply) => {
    const l = clone(buildLedger());
    apply(l);
    const violations = ledgerViolations(l);
    expect(violations.map((v) => v.code)).toContain(code);
    for (const v of violations) expect(v.at.startsWith("$"), v.at).toBe(true);
    expect(isLedgerV1(l)).toBe(false);
  });

  it("covers every A1-7 code at least once", () => {
    const covered = new Set(ROWS.map((r) => r[0]));
    for (const code of [
      "shape", "schema", "config-limits", "task-key", "task-phase", "phase-wave", "edge-endpoint", "seq", "attempt-n", "open-attempt",
      "slot-required", "branch-required", "integrated-missing", "manual-attempts", "shared-context-length", "shared-context-slot-path",
      "attempt-ended-pair", "verdict-unsucceeded", "nonce-duplicate", "running-without-child", "slot-forbidden", "git-id",
      "qa-without-phase", "path-not-absolute", "phase-id", "phase-duplicate", "wave-id", "wave-duplicate", "wave-membership",
      "phase-depends", "slots-dir-unresolved", "inbox-id", "inbox-duplicate", "inbox-task", "shared-context-header",
      "qa-multiple-open", "qa-round", "qa-gate",
    ]) expect(covered.has(code), code).toBe(true);
  });

  it("reports precise paths", () => {
    const l = clone(buildLedger());
    taskOf(l, "T3").slot = "slot-9";
    expect(ledgerViolations(l)).toEqual([{ code: "slot-forbidden", at: "$.tasks.T3.slot" }]);
    const m = clone(buildLedger());
    m.planPath = "rel";
    expect(ledgerViolations(m)).toEqual([{ code: "path-not-absolute", at: "$.planPath" }]);
  });

  it("accepts the legitimate neighbours of each rule", () => {
    const ok: Array<[string, (l: LedgerV1) => void]> = [
      ["qa task in flight with gate qa-running", (l) => { taskOf(l, "T2").kind = "qa"; phaseOf(l).gate = "qa-running"; }],
      ["qa-running with a settled done qa task", (l) => {
        phaseOf(l).gate = "qa-running";
        addQa(l, "QA-a", { state: "done" });
        addQa(l, "QA-b", { state: "cancelled" });
      }],
      ["aborted plan with qa-running gate and a cancelled qa task", (l) => {
        l.status = "aborted";
        phaseOf(l).gate = "qa-running";
        addQa(l, "QA-a", { state: "cancelled" });
      }],
      ["one open qa task next to a done one", (l) => { addQa(l, "QA-a", { state: "done" }); addQa(l, "QA-b", {}); }],
      ["compiling plan with slotsDir null", (l) => { l.status = "compiling"; l.config.slotsDir = null; }],
      ["awaiting-approval plan with slotsDir null", (l) => { l.status = "awaiting-approval"; l.config.slotsDir = null; }],
      ["UNC, POSIX and backslash absolute paths", (l) => {
        l.planPath = "\\\\server\\share\\PLAN.md";
        l.repo.toplevel = "/home/me/repo";
        l.integration.worktree = "D:\\slots\\integration";
      }],
      ["64-hex (sha256) git ids", (l) => { l.repo.baseCommit = "d".repeat(64); l.integration.head = "e".repeat(64); }],
      ["dependent phase", (l) => {
        l.phases.push({ id: "p2", title: "Phase 2", wave: "w1", dependsOn: ["p1"], gate: "pending", qaRound: 2, paused: true, tag: "t" });
        const w = l.waves[0];
        if (w) w.phases.push("p2");
      }],
      ["inbox ids of several prefixes with distinct numbers", (l) => {
        l.inbox.push({ ...INBOX_SAMPLE, id: "F-2", kind: "failure" }, { ...INBOX_SAMPLE, id: "R-3", kind: "qa-cap" });
      }],
      ["a reverted task without a slot", (l) => { taskOf(l, "T3").state = "reverted"; }],
      ["a failed task keeping its slot", (l) => { const t = taskOf(l, "T3"); t.state = "failed"; t.slot = "slot-3"; }],
    ];
    for (const [name, apply] of ok) {
      const l = clone(buildLedger());
      apply(l);
      expect(ledgerViolations(l), name).toEqual([]);
      expect(isLedgerV1(l), name).toBe(true);
    }
  });

  it("isLedgerV1(v) === (ledgerViolations(v).length === 0) for valid and invalid values", () => {
    const samples: unknown[] = [buildLedger(), null, 1, [], {}, { schema: 1 }, ...ROWS.map(([, , apply]) => { const l = clone(buildLedger()); apply(l); return l; })];
    for (const s of samples) expect(isLedgerV1(s)).toBe(ledgerViolations(s).length === 0);
  });

  it("non-records report a single shape violation at the root", () => {
    for (const v of [null, undefined, 3, "x", []]) expect(ledgerViolations(v)).toEqual([{ code: "shape", at: "$" }]);
  });
});

const INBOX_SAMPLE: InboxItem = { id: "Q-1", kind: "question", severity: "info", taskId: null, text: "t", options: [], answer: null, createdAt: T0 };

describe("patterns, ids and QA helpers (A1-1, A1-7)", () => {
  it("PHASE_ID_PATTERN / WAVE_ID_PATTERN", () => {
    expect(WAVE_ID_PATTERN).toBe(PHASE_ID_PATTERN);
    for (const ok of ["p1", "1", "A", "a.b", "a-b_c", "lock", "a".repeat(40), "9".repeat(40)]) expect(PHASE_ID_PATTERN.test(ok), ok).toBe(true);
    for (const bad of ["", ".a", "-a", "_a", "a..b", "a.", "a.lock", "a".repeat(41), "a b", "a/b", "a:b", "a\\b", "a\nb"]) {
      expect(PHASE_ID_PATTERN.test(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("GIT_ID_PATTERN and ABSOLUTE_PATH_PATTERN", () => {
    for (const ok of ["a".repeat(40), "0".repeat(64), SHA_A]) expect(GIT_ID_PATTERN.test(ok)).toBe(true);
    for (const bad of ["", "a".repeat(39), "a".repeat(41), "a".repeat(63), "a".repeat(65), "A".repeat(40), "g".repeat(40)]) {
      expect(GIT_ID_PATTERN.test(bad), String(bad.length)).toBe(false);
    }
    for (const ok of ["C:/x", "C:\\x", "c:/", "\\\\srv\\share", "\\\\srv\\share\\x", "/usr", "/"]) expect(ABSOLUTE_PATH_PATTERN.test(ok), ok).toBe(true);
    for (const bad of ["", "x", "./a", "../a", "C:", "C:x", "\\\\srv", "\\a", "a/b"]) expect(ABSOLUTE_PATH_PATTERN.test(bad), bad).toBe(false);
  });

  it("INBOX_ID_PREFIX, INBOX_ID_PATTERN and formatInboxId per kind", () => {
    const kinds: InboxKind[] = ["question", "failure", "usage-limit", "landing", "flaky", "qa-cap", "breaker"];
    expect(Object.keys(INBOX_ID_PREFIX).sort()).toEqual([...kinds].sort());
    expect(kinds.map((k) => INBOX_ID_PREFIX[k]).join("")).toBe("QFULKRB");
    for (const kind of kinds) {
      const id = formatInboxId(kind, 12);
      expect(id).toBe(`${INBOX_ID_PREFIX[kind]}-12`);
      const m = INBOX_ID_PATTERN.exec(id);
      expect(m?.[1]).toBe(INBOX_ID_PREFIX[kind]);
      expect(m?.[2]).toBe("12");
    }
    expect(formatInboxId("breaker", 999_999_999)).toBe("B-999999999");
    for (const ok of ["Q-1", "F-10", "B-999999999"]) expect(INBOX_ID_PATTERN.test(ok), ok).toBe(true);
    for (const bad of ["Q-0", "Q-01", "X-1", "Q-", "q-1", "Q-1000000000", "Q1", "Q-1 ", "-1", ""]) expect(INBOX_ID_PATTERN.test(bad), bad).toBe(false);
    for (const n of [0, -1, 1.5, 1_000_000_000, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => formatInboxId("question", n), String(n)).toThrow(ExecutorError);
    }
  });

  it("nextInboxNumber is 1 + the largest number across all prefixes", () => {
    const item = (id: string): InboxItem => ({ ...INBOX_SAMPLE, id });
    expect(nextInboxNumber({ inbox: [] })).toBe(1);
    expect(nextInboxNumber({ inbox: [item("Q-1")] })).toBe(2);
    expect(nextInboxNumber({ inbox: [item("Q-1"), item("F-5"), item("R-3")] })).toBe(6);
    expect(nextInboxNumber({ inbox: [item("B-40"), item("Q-2")] })).toBe(41);
    expect(nextInboxNumber({ inbox: [item("garbage"), item("Q-3")] })).toBe(4);
    expect(nextInboxNumber(buildLedger())).toBe(2);
  });

  it("fixTaskId / reviewTaskId match TASK_ID_PATTERN at the limits and throw beyond them", () => {
    expect(QA_ROUND_LIMIT).toBe(999);
    expect(FIX_TASKS_PER_ROUND_LIMIT).toBe(999);
    const phases = ["p", "A", "1", "9".repeat(40), "a".repeat(40), "a-".repeat(20), "x.y-z_1", "p1"];
    for (const p of phases) {
      expect(PHASE_ID_PATTERN.test(p), p).toBe(true);
      for (const round of [1, 2, 998, 999]) {
        for (const k of [1, 2, 999]) {
          const id = fixTaskId(p, round, k);
          expect(id).toBe(`${p}.FIX${round}-${k}`);
          expect(TASK_ID_PATTERN.test(id), id).toBe(true);
        }
      }
      for (const round of [2, 3, 999]) {
        const id = reviewTaskId(p, round);
        expect(id).toBe(`${p}.QA${round}`);
        expect(TASK_ID_PATTERN.test(id), id).toBe(true);
      }
    }
    const code = (fn: () => unknown): string | undefined => {
      try {
        fn();
      } catch (e) {
        return e instanceof ExecutorError ? e.code : "other";
      }
      return undefined;
    };
    expect(code(() => fixTaskId("p1", 0, 1))).toBe("E_INVALID_INPUT");
    expect(code(() => fixTaskId("p1", 1000, 1))).toBe("E_INVALID_INPUT");
    expect(code(() => fixTaskId("p1", 1, 0))).toBe("E_INVALID_INPUT");
    expect(code(() => fixTaskId("p1", 1, 1000))).toBe("E_INVALID_INPUT");
    expect(code(() => fixTaskId("p1", 1.5, 1))).toBe("E_INVALID_INPUT");
    expect(code(() => fixTaskId("p1", 1, Number.NaN))).toBe("E_INVALID_INPUT");
    for (const bad of ["", "a..b", "p.", "p.lock", "-a", "a".repeat(41), "a b"]) {
      expect(code(() => fixTaskId(bad, 1, 1)), bad).toBe("E_INVALID_INPUT");
      expect(code(() => reviewTaskId(bad, 2)), bad).toBe("E_INVALID_INPUT");
    }
    expect(code(() => reviewTaskId("p1", 1))).toBe("E_INVALID_INPUT");
    expect(code(() => reviewTaskId("p1", 0))).toBe("E_INVALID_INPUT");
    expect(code(() => reviewTaskId("p1", 1000))).toBe("E_INVALID_INPUT");
    expect(code(() => reviewTaskId("p1", 2.5))).toBe("E_INVALID_INPUT");
  });

  it("qaUnparsableCount counts attempts whose context starts with the prefix", () => {
    expect(QA_UNPARSABLE_CONTEXT_PREFIX).toBe("QA OUTPUT UNPARSABLE: ");
    expect(qaUnparsableCount(taskNode("Q1"))).toBe(0);
    const t = taskNode("Q1", {
      attempts: [
        attempt(1, "failed", null, { context: `${QA_UNPARSABLE_CONTEXT_PREFIX}no json` }),
        attempt(2, "failed", null, { context: "an answer replaced the context" }),
        attempt(3, "failed", null, { context: `x ${QA_UNPARSABLE_CONTEXT_PREFIX}not a prefix` }),
        attempt(4, "failed", null, { context: `${QA_UNPARSABLE_CONTEXT_PREFIX}` }),
        attempt(5, null),
      ],
    });
    expect(qaUnparsableCount(t)).toBe(2);
  });

  it("canonicalFindingsJson is stable, schema ordered and parses back to the same report", () => {
    const report: FindingsReport = {
      findings: [
        { id: "F1", severity: "blocking", files: ["src/a.ts", "src/b.ts"], problem: "p1", fix: "f1" },
        { id: "F2", severity: "nit", files: [], problem: "p2 \"quoted\"\n", fix: "" },
      ],
    };
    const json = canonicalFindingsJson(report);
    expect(json).toBe(JSON.stringify({ findings: report.findings }));
    const parsed: unknown = JSON.parse(json);
    expect(isFindingsReport(parsed)).toBe(true);
    expect(parsed).toEqual(report);
    expect(canonicalFindingsJson(parsed as FindingsReport)).toBe(json);
    // key order is the schema's, whatever order the input had
    const shuffledKeys: FindingsReport = {
      findings: [{ fix: "f", problem: "p", files: ["a"], severity: "major", id: "Z" }],
    };
    expect(Object.keys((JSON.parse(canonicalFindingsJson(shuffledKeys)) as { findings: object[] }).findings[0] as object))
      .toEqual(["id", "severity", "files", "problem", "fix"]);
    expect(canonicalFindingsJson({ findings: [] })).toBe('{"findings":[]}');
  });

  it("QA_CAP_OPTIONS offers accept and fix", () => {
    expect([...QA_CAP_OPTIONS]).toEqual(["accept", "fix"]);
  });
});

describe("context pin and history events (A1-3, A1-4)", () => {
  it("ContextSupersededError carries both refs; isContextSupersededError matches by name", () => {
    const requested: ContextRef = { bootID: BOOT_ID, epoch: 1, callID: "c1" };
    const current: ContextRef = { bootID: BOOT_ID, epoch: 2, callID: "c2" };
    const e = new ContextSupersededError(requested, current);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("ContextSupersededError");
    expect(e.message).toBe("retained context superseded");
    expect(e.requested).toBe(requested);
    expect(e.current).toBe(current);
    expect(new ContextSupersededError(requested, null).current).toBeNull();
    expect(isContextSupersededError(e)).toBe(true);
    // a plain object from another realm
    expect(isContextSupersededError({ name: "ContextSupersededError", requested, current })).toBe(true);
    const foreign = new Error("x");
    foreign.name = "ContextSupersededError";
    expect(isContextSupersededError(foreign)).toBe(true);
    for (const v of [new Error("x"), { name: "Other" }, {}, "ContextSupersededError", null, undefined, 3, new ExecutorError("E_NO_CONTEXT", "m")]) {
      expect(isContextSupersededError(v)).toBe(false);
    }
  });

  it("isHistoryEvent is true for exactly the four history types", () => {
    for (const type of ["metric", "integration-step", "attempt-verdict", "wake"]) expect(isHistoryEvent({ type }), type).toBe(true);
    for (const type of [
      "ledger-init", "draft-replaced", "status-changed", "plan-approved", "orchestrator-bound", "lock-takeover", "task-created",
      "edge-added", "task-transition", "attempt-started", "attempt-child", "attempt-adopted", "attempt-ended", "attempt-context",
      "task-slot", "task-footprint", "task-integrated", "integration-head", "gate-changed", "phase-paused", "phase-tagged",
      "inbox-added", "inbox-answered", "", "Wake",
    ]) expect(isHistoryEvent({ type }), type).toBe(false);
  });

  it("task-footprint is durable; the context-age metric is not", () => {
    const e: ExecutorEventInput = { type: "task-footprint", taskId: "T2", footprint: { writes: [], reads: [], confidence: "unknown", sources: [] } };
    expect(isDurableEvent(e)).toBe(true);
    const m: ExecutorEventInput = {
      type: "metric",
      metric: {
        name: "context-age", taskId: "T3", attempt: 1, bootID: BOOT_ID, epoch: 1, callID: "c", capturedAt: T0, ageMs: 5, result: "superseded",
      },
    };
    expect(isDurableEvent(m)).toBe(false);
  });

  it("launch failure vocabularies are the A1-5 ones (compile-time and runtime)", () => {
    const reasons: LaunchConfirmation[] = (["timeout", "threw", "superseded", "task-error", "hook-failed"] as const)
      .map((reason) => ({ kind: "unconfirmed", reason, error: null }));
    expect(reasons).toHaveLength(5);
    const lost: ChildEnd[] = (["unconfirmed", "unrequested-interrupt", "runner-error", "restart", "context-superseded", "refused"] as const)
      .map((reason) => ({ kind: "lost", childSessionID: null, reason, endedAt: T0 }));
    expect(new Set(lost.map((l) => (l.kind === "lost" ? l.reason : ""))).size).toBe(6);
    const gates: LaunchGate[] = [
      { ok: true, context: CONTEXT_INFO, ageMs: 0 },
      { ok: false, reason: "disposed", wake: null },
      { ok: false, reason: "no-context", wake: { reason: "stale-context", stateKey: `no-context:${BOOT_ID}:ses-0:1` } },
      { ok: false, reason: "awaiting-first-router-call", wake: { reason: "stale-context", stateKey: `await-router-call:${BOOT_ID}:ses-0` } },
      { ok: false, reason: "context-stale", wake: { reason: "stale-context", stateKey: `stale-context:${BOOT_ID}:1` } },
    ];
    // every non-ok reason except `disposed` has a wake
    for (const g of gates) if (!g.ok) expect(g.wake === null, g.reason).toBe(g.reason === "disposed");
    const hooks: LaunchHooks = { onLateChild: async () => "adopt", onChildCreated: async () => undefined };
    expect(typeof hooks.onChildCreated).toBe("function");
  });
});

describe("EXECUTOR_DEFAULTS is read-only by type and executorDefaults() returns a fresh mutable copy (QA-1.4-15)", () => {
  type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
  type WritableKeys<T> = { [K in keyof T]-?: Equals<{ [P in K]: T[P] }, { -readonly [P in K]: T[P] }> extends true ? K : never }[keyof T];

  it("has no writable property, top level or nested (compile-time)", () => {
    const top: [WritableKeys<typeof EXECUTOR_DEFAULTS>] extends [never] ? true : false = true;
    const nested: [WritableKeys<typeof EXECUTOR_DEFAULTS.circuitBreaker>] extends [never] ? true : false = true;
    expect(top && nested).toBe(true);
  });

  it("returns an equal, unfrozen copy each call; editing it never touches the constant", () => {
    const a = executorDefaults();
    const b = executorDefaults();
    expect(a).toEqual(EXECUTOR_DEFAULTS);
    expect(a).not.toBe(b);
    expect(a.circuitBreaker).not.toBe(b.circuitBreaker);
    expect(a.circuitBreaker).not.toBe(EXECUTOR_DEFAULTS.circuitBreaker);
    expect(Object.isFrozen(a)).toBe(false);
    expect(Object.isFrozen(a.circuitBreaker)).toBe(false);
    a.maxParallel = 8;
    a.circuitBreaker.failureRatio = 1;
    a.slotsDir = "C:/slots";
    expect(b.maxParallel).toBe(4);
    expect(b.circuitBreaker.failureRatio).toBe(0.4);
    expect(EXECUTOR_DEFAULTS.maxParallel).toBe(4);
    expect(EXECUTOR_DEFAULTS.circuitBreaker.failureRatio).toBe(0.4);
    expect(EXECUTOR_DEFAULTS.slotsDir).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// QA-1.4-11: seeded generator of WELL-TYPED but inconsistent nodes, checked against an independent oracle.
// The oracle below restates the memo/A1 invariants directly; it never calls the guards under test.
// ---------------------------------------------------------------------------------------------------------------

const ORACLE_TASK_CODES = [
  "attempt-n", "open-attempt", "slot-required", "slot-forbidden", "branch-required", "integrated-missing", "git-id", "manual-attempts",
  "attempt-ended-pair", "verdict-unsucceeded", "nonce-duplicate", "running-without-child", "qa-without-phase",
] as const;

function oracleTaskCodes(t: TaskNode): Set<string> {
  const out = new Set<string>();
  const A = t.attempts;
  const flying = t.state === "dispatched" || t.state === "running";
  const openAt = A.flatMap((a, i) => (a.outcome === null ? [i] : []));
  if (A.some((a, i) => a.n !== i + 1)) out.add("attempt-n");
  if (flying ? !(openAt.length === 1 && openAt[0] === A.length - 1) : openAt.length > 0) out.add("open-attempt");
  const holdsSlot = ["dispatched", "running", "completed", "verifying", "verified", "integrating"];
  // QA-PDF21-3 amends A1-7: a parked task may keep the slot whose work could not be saved.
  const noSlot = ["pending", "blocked", "done", "cancelled", "integrated", "reverted"];
  if (holdsSlot.includes(t.state) && t.slot === null) out.add("slot-required");
  if (noSlot.includes(t.state) && t.slot !== null) out.add("slot-forbidden");
  if (["verifying", "verified", "integrating"].includes(t.state) && t.branch === null) out.add("branch-required");
  if (t.state === "integrated" && t.integrated === null) out.add("integrated-missing");
  if (t.integrated !== null) {
    // SHA-1 (40) or SHA-256 (64) lowercase hex (A1-7), written independently of GIT_ID_PATTERN.
    const hexId = (s: string): boolean => (s.length === 40 || s.length === 64) && /^[0-9a-f]+$/.test(s);
    if (!hexId(t.integrated.from) || !hexId(t.integrated.to)) out.add("git-id");
  }
  if ((t.kind === "manual" || t.kind === "preflight") && A.length > 0) out.add("manual-attempts");
  for (const a of A) {
    if ((a.outcome !== null) !== (a.endedAt !== null) || (a.endedAt !== null && a.endedAt < a.startedAt)) out.add("attempt-ended-pair");
    if (a.verdict !== null && a.outcome !== "succeeded") out.add("verdict-unsucceeded");
  }
  const nonces = A.map((a) => a.nonce);
  if (nonces.some((n, i) => nonces.indexOf(n) !== i)) out.add("nonce-duplicate");
  const latest = A[A.length - 1];
  if (t.state === "running" && latest !== undefined && latest.childSessionID === null) out.add("running-without-child");
  if (t.kind === "qa" && t.phase === null) out.add("qa-without-phase");
  return out;
}

function oracleQaCodes(l: LedgerV1): Set<string> {
  const out = new Set<string>();
  const settled = (t: TaskNode): boolean => t.state === "done" || t.state === "cancelled";
  for (const p of l.phases) {
    const qa = Object.values(l.tasks).filter((t) => t.kind === "qa" && t.phase === p.id);
    if (qa.filter((t) => !settled(t)).length > 1) out.add("qa-multiple-open");
    if (l.status === "aborted") continue;
    const flying = qa.filter((t) => t.state === "dispatched" || t.state === "running");
    if (flying.length > 0 && p.gate !== "qa-running") out.add("qa-gate");
    if (p.gate === "qa-running") {
      const resultPending = flying.length === 0 && qa.length > 0 && qa.every(settled) && qa.some((t) => t.state === "done");
      if (flying.length !== 1 && !resultPending) out.add("qa-gate");
    }
  }
  return out;
}

/** A node whose invariants all hold, shaped by `state` and `kind`. */
function genConsistentTask(rng: () => number, id: string, state: TaskState, wantedKind: TaskNode["kind"]): TaskNode {
  const flying = state === "dispatched" || state === "running";
  const kind = (wantedKind === "manual" || wantedKind === "preflight") && flying ? "task" : wantedKind;
  const attempts: Attempt[] = [];
  if (kind !== "manual" && kind !== "preflight") {
    const closed = Math.floor(rng() * 3);
    for (let i = 1; i <= closed; i++) {
      const outcome = pick(rng, ATTEMPT_OUTCOMES);
      const verdict = outcome === "succeeded" && rng() < 0.7 ? pick(rng, VERDICTS) : null;
      attempts.push(attempt(i, outcome, verdict, { childSessionID: rng() < 0.5 ? `ses-${i}` : null }));
    }
    if (flying) {
      const child = state === "running" || rng() < 0.5 ? `ses-${closed + 1}` : null;
      attempts.push(attempt(closed + 1, null, null, { childSessionID: child }));
    }
  }
  const slotRequired = ["dispatched", "running", "completed", "verifying", "verified", "integrating"].includes(state);
  const slotForbidden = ["pending", "blocked", "parked", "done", "cancelled", "integrated", "reverted"].includes(state);
  const branchRequired = ["verifying", "verified", "integrating"].includes(state);
  return taskNode(id, {
    kind, state, attempts,
    slot: slotRequired ? "slot-1" : slotForbidden ? null : rng() < 0.5 ? "slot-1" : null,
    branch: branchRequired || rng() < 0.5 ? `omr/plan-one/t/${id}` : null,
    integrated: state === "integrated" || rng() < 0.3
      ? (rng() < 0.4 ? { from: SHA_A.repeat(2).slice(0, 64), to: SHA_B.repeat(2).slice(0, 64) } : { from: SHA_A, to: SHA_B })
      : null,
  });
}

type Mutation = (t: TaskNode, rng: () => number) => void;
const lastAttempt = (t: TaskNode): Attempt | undefined => t.attempts[t.attempts.length - 1];
const MUTATIONS: Mutation[] = [
  (t) => { t.slot = t.slot === null ? "slot-7" : null; },
  (t) => { t.branch = t.branch === null ? "b" : null; },
  (t, rng) => { t.state = pick(rng, TASK_STATES); },
  (t) => { const a = t.attempts[0]; if (a) a.n += 1; },
  (t) => { const a = lastAttempt(t); if (a) a.endedAt = a.endedAt === null ? T0 : null; },
  (t) => { const a = lastAttempt(t); if (a) a.outcome = a.outcome === null ? "failed" : null; },
  (t) => { const a = t.attempts[0]; if (a) a.verdict = "fail"; },
  (t) => { const a = lastAttempt(t); if (a) a.childSessionID = null; },
  (t) => { const a = t.attempts[1]; const first = t.attempts[0]; if (a && first) a.nonce = first.nonce; },
  (t) => { const a = t.attempts[0]; if (a) a.endedAt = "2020-01-01T00:00:00.000Z"; },
  (t) => { t.attempts.push(attempt(t.attempts.length + 1, null)); },
  (t) => { t.integrated = t.integrated === null ? { from: SHA_A, to: SHA_B } : null; },
  (t) => { t.integrated = { from: "xyz", to: SHA_B }; },
  (t) => { t.integrated = { from: SHA_A, to: SHA_B.toUpperCase() }; },
  (t) => { t.integrated = { from: "a".repeat(64), to: "b".repeat(64) }; }, // SHA-256 ids are valid
  (t) => { t.integrated = { from: "a".repeat(63), to: "b".repeat(64) }; },
  (t) => { t.integrated = { from: "a".repeat(41), to: SHA_B }; },
  (t, rng) => { t.kind = pick(rng, TASK_KINDS); },
  (t) => { t.attempts = []; },
];

describe("oracle-checked fuzzing of well-typed task nodes (QA-1.4-11)", () => {
  it("the guards agree with an independent invariant oracle on 1500 seeded task nodes (accept and reject)", () => {
    const rng = mulberry32(0x11a1);
    const seen = new Set<string>();
    let accepted = 0;
    let rejected = 0;
    for (let i = 0; i < 1500; i++) {
      const node = genConsistentTask(rng, "T9", pick(rng, TASK_STATES), pick(rng, TASK_KINDS));
      const mutations = rng() < 0.35 ? 0 : 1 + Math.floor(rng() * 2);
      for (let m = 0; m < mutations; m++) pick(rng, MUTATIONS)(node, rng);
      // qa tasks are placed without a phase so that the ledger-level qa rules stay out of this oracle
      if (node.kind === "qa") node.phase = null;

      const expected = oracleTaskCodes(node);
      const l = clone(buildLedger());
      l.tasks["T9"] = clone(node);
      const actual = codesOf(l);
      expect([...actual].sort(), JSON.stringify(node)).toEqual([...expected].sort());
      expect(isTaskNode(clone(node)), JSON.stringify(node)).toBe(expected.size === 0);
      expect(isLedgerV1(l)).toBe(expected.size === 0);
      for (const c of expected) seen.add(c);
      if (expected.size === 0) accepted++;
      else rejected++;
    }
    expect(accepted).toBeGreaterThanOrEqual(200);
    expect(rejected).toBeGreaterThanOrEqual(500);
    expect([...seen].sort()).toEqual([...ORACLE_TASK_CODES].sort());
  });

  it("the qa-gate and qa-multiple-open rules agree with the oracle on 500 seeded phase/qa-task combinations", () => {
    const rng = mulberry32(0x9a7e);
    const seen = new Set<string>();
    let clean = 0;
    for (let i = 0; i < 500; i++) {
      const l = clone(buildLedger());
      l.status = pick(rng, ["running", "paused", "aborted", "completed"] as const);
      phaseOf(l).gate = pick(rng, GATE_STATES);
      const count = Math.floor(rng() * 4);
      for (let k = 0; k < count; k++) {
        const id = `QA-${k}`;
        l.tasks[id] = genConsistentTask(rng, id, pick(rng, TASK_STATES), "qa");
      }
      const expected = oracleQaCodes(l);
      expect([...codesOf(l)].sort(), JSON.stringify(l.tasks)).toEqual([...expected].sort());
      expect(isLedgerV1(l)).toBe(expected.size === 0);
      for (const c of expected) seen.add(c);
      if (expected.size === 0) clean++;
    }
    expect(clean).toBeGreaterThanOrEqual(60);
    expect([...seen].sort()).toEqual(["qa-gate", "qa-multiple-open"]);
  });

  it("the oracle itself flags every hand-built violation (sanity check of the oracle)", () => {
    const base = taskNode("T9", { state: "running", slot: "s", attempts: [attempt(1, null, null, { childSessionID: "c" })] });
    expect([...oracleTaskCodes(base)]).toEqual([]);
    const bad = clone(base);
    bad.slot = null;
    expect([...oracleTaskCodes(bad)]).toEqual(["slot-required"]);
  });
});

describe("ledger guard fuzzing (seeded PRNG)", () => {
  const base = buildLedger();

  it("rejects >= 200 structural mutations: wrong type / missing field at every path", () => {
    const rng = mulberry32(0x14a4);
    const nodes: WalkNode[] = [];
    walk(clone(base), [], false, nodes);
    const accepted: string[] = [];
    let total = 0;

    for (const n of nodes) {
      if (n.path.length === 0) continue;
      const label = n.path.join(".");
      // Wrong types: up to three PRNG-chosen candidates per path.
      for (const bad of shuffled(wrongValues(n.value, n.path), rng).slice(0, 3)) {
        const l: unknown = clone(base);
        setAt(l, n.path, bad);
        total++;
        if (isLedgerV1(l)) accepted.push(`${label} := ${String(bad)}`);
      }
      // Missing field: object keys only; entries of the task map are removable without breaking the guard.
      const inTaskMap = n.path.length === 2 && n.path[0] === "tasks";
      if (!n.parentIsArray && !inTaskMap) {
        const l: unknown = clone(base);
        deleteAt(l, n.path);
        total++;
        if (isLedgerV1(l)) accepted.push(`delete ${label}`);
      }
    }
    expect(nodes.length).toBeGreaterThan(150);
    expect(total).toBeGreaterThanOrEqual(200);
    expect(accepted).toEqual([]);
  });

  it("rejects 60 ledgers with a random non-empty subset of top-level keys removed", () => {
    const rng = mulberry32(0xbeef);
    const keys = Object.keys(base);
    let rejected = 0;
    for (let i = 0; i < 60; i++) {
      const l: unknown = clone(base);
      const drop = shuffled(keys, rng).slice(0, 1 + Math.floor(rng() * keys.length));
      for (const k of drop) deleteAt(l, [k]);
      expect(isLedgerV1(l), drop.join(",")).toBe(false);
      rejected++;
    }
    expect(rejected).toBe(60);
  });

  it("rejects 40 ledgers corrupted by two simultaneous mutations", () => {
    const rng = mulberry32(0x5eed);
    const nodes: WalkNode[] = [];
    walk(clone(base), [], false, nodes);
    const paths = nodes.filter((n) => n.path.length > 0);
    for (let i = 0; i < 40; i++) {
      const a = paths[Math.floor(rng() * paths.length)] as WalkNode;
      const b = paths[Math.floor(rng() * paths.length)] as WalkNode;
      const l: unknown = clone(base);
      // Both mutations are guaranteed wrong, so any combination stays invalid.
      const wa = shuffled(wrongValues(a.value, a.path), rng)[0];
      setAt(l, a.path, wa);
      // The second path may no longer exist after the first mutation (a replaced ancestor); skip then.
      try {
        setAt(l, b.path, shuffled(wrongValues(b.value, b.path), rng)[0]);
      } catch (e) {
        expect((e as Error).message).toMatch(/bad (path|parent)/);
      }
      expect(isLedgerV1(l), `${a.path.join(".")} + ${b.path.join(".")}`).toBe(false);
    }
  });

  it("accepts unknown extra fields at every object level and preserves them through JSON", () => {
    const nodes: WalkNode[] = [];
    walk(clone(base), [], false, nodes);
    // The task map's keys are task ids, not fields: extras go on its members, not on the map itself.
    const objects = nodes.filter((n) => isObj(n.value) && !Array.isArray(n.value) && !(n.path.length === 1 && n.path[0] === "tasks"));
    expect(objects.length).toBeGreaterThan(25);

    const extra = { nested: [1, { a: null }], flag: true };
    for (const o of objects) {
      const l: unknown = clone(base);
      const target = o.path.length === 0 ? l : o.path.reduce<unknown>((cur, k) => child(cur, k), l);
      if (!isObj(target)) throw new Error("not an object");
      Reflect.set(target, "x-extra", extra);
      expect(isLedgerV1(l), `extra at ${o.path.join(".") || "<root>"}`).toBe(true);
      const round: unknown = JSON.parse(JSON.stringify(l));
      expect(round).toEqual(l);
      expect(isLedgerV1(round)).toBe(true);
      const roundTarget = o.path.reduce<unknown>((cur, k) => child(cur, k), round);
      expect(Reflect.get(roundTarget as object, "x-extra")).toEqual(extra);
    }

    // All extras at once.
    const all: unknown = clone(base);
    for (const o of objects) {
      const target = o.path.reduce<unknown>((cur, k) => child(cur, k), all);
      Reflect.set(target as object, "x-extra", extra);
    }
    expect(isLedgerV1(all)).toBe(true);
    const roundAll: unknown = JSON.parse(JSON.stringify(all));
    expect(roundAll).toEqual(all);
    expect(isLedgerV1(roundAll)).toBe(true);
    // And an extra fails nothing about ledgerSchemaOf.
    expect(ledgerSchemaOf(roundAll)).toBe(1);
  });

  it("an extra field on a task node does not defeat isTaskNode", () => {
    const n: unknown = { ...taskNode("T5"), future: { a: 1 } };
    expect(isTaskNode(n)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------------------------------------------

describe("FINDINGS_FORMAT / isFindingsReport", () => {
  const finding = { id: "p1.FIX1-1", severity: "major", files: ["src/a.ts"], problem: "bug", fix: "patch it" };

  it("declares the strict schema", () => {
    expect(FINDINGS_FORMAT.type).toBe("object");
    expect(FINDINGS_FORMAT.additionalProperties).toBe(false);
    expect([...FINDINGS_FORMAT.required]).toEqual(["findings"]);
    const item = FINDINGS_FORMAT.properties.findings.items;
    expect(item.additionalProperties).toBe(false);
    expect([...item.required]).toEqual(["id", "severity", "files", "problem", "fix"]);
    expect([...item.properties.severity.enum]).toEqual(["blocking", "critical", "major", "minor", "nit"]);
    expect(Object.keys(item.properties).sort()).toEqual([...item.required].sort());
  });

  it("the id pattern in the schema agrees with the guard", () => {
    const re = new RegExp(FINDINGS_FORMAT.properties.findings.items.properties.id.pattern);
    for (const id of ["a", "A1", "p1.FIX1-1", "p1.QA2", "1", "a_b", "a".repeat(64), "a".repeat(65), "", "-a", ".a", "a b", "a:b", "a/b"]) {
      const viaGuard = isFindingsReport({ findings: [{ ...finding, id }] });
      expect(viaGuard, id).toBe(re.test(id));
    }
  });

  it("accepts valid reports", () => {
    expect(isFindingsReport({ findings: [] })).toBe(true);
    expect(isFindingsReport({ findings: [finding] })).toBe(true);
    for (const severity of ["blocking", "critical", "major", "minor", "nit"]) {
      expect(isFindingsReport({ findings: [{ ...finding, severity }] }), severity).toBe(true);
    }
    expect(isFindingsReport({ findings: [{ ...finding, files: [], fix: "" }] })).toBe(true);
    const report: FindingsReport = { findings: [{ id: "x1", severity: "nit", files: ["a/b.ts", "c.md"], problem: "p", fix: "f" }] };
    expect(isFindingsReport(report)).toBe(true);
    expect(isFindingsReport(JSON.parse(JSON.stringify(report)))).toBe(true);
  });

  it("rejects unknown properties at both levels", () => {
    expect(isFindingsReport({ findings: [], extra: 1 })).toBe(false);
    expect(isFindingsReport({ findings: [{ ...finding, extra: 1 }] })).toBe(false);
    expect(isFindingsReport({ findings: [finding], summary: "ok" })).toBe(false);
  });

  it("rejects a bad severity", () => {
    for (const severity of ["Major", "high", "", "info", "blocker", 3, null, undefined]) {
      expect(isFindingsReport({ findings: [{ ...finding, severity }] }), String(severity)).toBe(false);
    }
  });

  it("rejects other malformed shapes", () => {
    const bad: unknown[] = [
      null, undefined, 0, "findings", [], [finding], {}, { findings: null }, { findings: {} }, { findings: "x" },
      { findings: [null] }, { findings: ["x"] }, { findings: [[]] },
      { findings: [{ ...finding, id: "" }] }, { findings: [{ ...finding, id: 7 }] },
      { findings: [{ ...finding, files: "src/a.ts" }] }, { findings: [{ ...finding, files: [""] }] },
      { findings: [{ ...finding, files: [1] }] },
      { findings: [{ ...finding, problem: "" }] }, { findings: [{ ...finding, problem: 1 }] },
      { findings: [{ ...finding, fix: 1 }] },
      { findings: [{ id: "a", severity: "nit", files: [], problem: "p" }] },
      { findings: [{ severity: "nit", files: [], problem: "p", fix: "" }] },
      { findings: [finding, { ...finding, severity: "bad" }] },
    ];
    for (const v of bad) expect(isFindingsReport(v), JSON.stringify(v)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------------------------

describe("isDurableEvent (§6)", () => {
  it("metric events are not durable", () => {
    const e: ExecutorEventInput = { type: "metric", metric: { name: "counter", key: "k", value: 1, labels: {} } };
    expect(isDurableEvent(e)).toBe(false);
    const w: ExecutorEventInput = { type: "metric", metric: { name: "wake", reason: "inbox", stateKey: "s", result: "sent" } };
    expect(isDurableEvent(w)).toBe(false);
  });

  it("task-transition is durable iff the target state is durable", () => {
    for (const to of TASK_STATES) {
      const e: ExecutorEventInput = { type: "task-transition", taskId: "T1", from: "pending", to, trigger: "deps-satisfied", detail: null };
      const expected = ["dispatched", "running", "completed", "integrating", "integrated", "reverted", "cancelled"].includes(to);
      expect(isDurableEvent(e), to).toBe(expected);
    }
  });

  it("every other event type is durable", () => {
    const ledger = buildLedger();
    const events: ExecutorEventInput[] = [
      { type: "ledger-init", ledger },
      { type: "status-changed", from: "running", to: "paused", reason: "r" },
      { type: "plan-approved", config: ledger.config, by: "ses-0" },
      { type: "orchestrator-bound", sessionID: "ses-0", reason: "compile" },
      { type: "task-created", task: taskNode("T9") },
      { type: "edge-added", edge: { from: "T1", to: "T3", kind: "learned", confidence: "low", evidence: "e" } },
      { type: "attempt-started", taskId: "T2", attempt: attempt(1, null) },
      { type: "attempt-child", taskId: "T2", n: 1, childSessionID: "ses-1" },
      { type: "attempt-ended", taskId: "T2", n: 1, outcome: "failed", endedAt: T0, detail: null },
      { type: "attempt-verdict", taskId: "T2", n: 1, verdict: "pass", ref: null },
      { type: "task-slot", taskId: "T2", slot: null, branch: null },
      { type: "task-integrated", taskId: "T1", from: "a", to: "b" },
      { type: "integration-head", head: "abc" },
      { type: "task-footprint", taskId: "T2", footprint: { writes: ["src/b.ts"], reads: [], confidence: "explicit", sources: ["learned"] } },
      {
        type: "integration-step", edge: "start", step: "rebase", result: null, detail: null, failingIds: [], closes: false,
        entry: { id: "i-6", kind: "task", phaseId: "p1", taskIds: ["T1"], slot: null, baseHead: SHA_A, candidate: null },
      },
      { type: "gate-changed", phaseId: "p1", from: "pending", to: "awaiting-qa", trigger: "phase-integrated", qaRound: 1 },
      { type: "phase-paused", phaseId: "p1", paused: true, reason: "r" },
      { type: "phase-tagged", phaseId: "p1", tag: "t" },
      { type: "inbox-added", item: { id: "Q-2", kind: "question", severity: "info", taskId: null, text: "t", options: [], answer: null, createdAt: T0 } },
      { type: "inbox-answered", id: "Q-1", answer: "yes" },
      { type: "wake", reason: "inbox", stateKey: "inbox:Q-1" },
    ];
    for (const e of events) expect(isDurableEvent(e), e.type).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Typed test doubles: one per interface and seam, each instantiated and called once.
// The object literals are the compile-time contract check: a missing, extra or mistyped member fails `tsc`.
// ---------------------------------------------------------------------------------------------------------------

function tracker() {
  const calls: string[] = [];
  const hit = <T>(name: string, value: T): T => {
    calls.push(name);
    return value;
  };
  return { calls, hit };
}

const LEDGER = buildLedger();
const HOLDER: LockHolder = { pid: 1, hostname: "host", sessionID: "ses-0", startedAt: T0, heartbeatAt: T0 };
const ROUTE: TaskRoute = {
  agent: "implementer", model: { providerID: "anthropic", modelID: "m1", variant: null }, provider: "anthropic", heavy: false,
};
const SUMMARY: CompileSummary = {
  tasks: 1, phases: 1, edges: 0, workMs: 1, criticalPathMs: 1, width: 1, expectedMakespanMs: 1, manual: [], warnings: [],
};
const LEASE: SlotLease = { slot: "slot-1", path: "C:/slots/slot-1", planId: "plan-one", owner: "T1", commit: "c0ffee" };
const SLOT_RECORD: SlotRecord = {
  schema: 1, slot: "slot-1", path: "C:/slots/slot-1", kind: "task", planId: "plan-one", repoKey: "repo-key", state: "ready",
  owner: null, commit: null, managers: [], manifests: {}, createdAt: T0, updatedAt: T0,
};
const INBOX_ITEM: InboxItem = { id: "Q-1", kind: "question", severity: "info", taskId: null, text: "t", options: [], answer: null, createdAt: T0 };
const BOOT_ID = "0123456789abcdef";
const CONTEXT_REF: ContextRef = { bootID: BOOT_ID, epoch: 1, callID: "call-1" };
const REQUEST: LaunchRequest = {
  planId: "plan-one", taskId: "T3", attempt: 1, nonce: NONCE, orchestratorSessionID: "ses-0", context: CONTEXT_REF, route: ROUTE,
  role: "implementer", grant: [], workRoot: "C:/slots/slot-1",
  prompt: formatLaunchPrompt("shared notes", { planId: "plan-one", taskId: "T3", attempt: 1, nonce: NONCE }, "TASK\nT3"),
};
const CONTEXT_INFO: RetainedContextInfo = {
  sessionID: "ses-0", callID: "call-1", messageID: "m-1", agent: "orchestrator", capturedAt: T0, bootID: BOOT_ID, epoch: 1,
};
const OPEN_ENTRY: OpenIntegrationEntry = {
  entry: { id: "i-7", kind: "task", phaseId: "p1", taskIds: ["T1"], slot: "integration", baseHead: SHA_A, candidate: null },
  startSeq: 7, step: "rebase", edge: "start", result: null,
};
const PROC: ProcessResult = { code: 0, signal: null, stdout: "", stderr: "", truncated: false, durationMs: 1 };
const HOST_ERROR: HostError = { type: "provider.rate-limit", status: 429, message: "slow down" };
const EDGE: Edge = { from: "T1", to: "T3", kind: "learned", confidence: "low", evidence: "e" };

describe("typed test doubles for every interface", () => {
  it("keeps child resume, launch resume and restored expansion fields optional", () => {
    const child: ChildRunRequest = {
      parentSessionID: "ses-0", prompt: "TASK", agent: "implementer", model: ROUTE.model,
      cwd: LEASE.path, signal: new AbortController().signal, detached: true, context: CONTEXT_REF,
      onCreated: async () => undefined,
    };
    expect(child.resumeSessionID).toBeUndefined();
    const resumedChild: ChildRunRequest = { ...child, resumeSessionID: "ses-1" };
    expect(resumedChild.resumeSessionID).toBe("ses-1");

    expect(REQUEST.resume).toBeUndefined();
    const resumedLaunch: LaunchRequest = { ...REQUEST, resume: { childSessionID: "ses-1" } };
    expect(resumedLaunch.resume?.childSessionID).toBe("ses-1");

    const expansion: ExpandInput = {
      ledger: LEDGER, taskId: "T3", attempt: 2, nonce: NONCE, slot: LEASE,
      env: { worktrees: [], longPaths: true },
    };
    expect(expansion.restored).toBeUndefined();
    const restoredExpansion: import("../../src/executor/expand").ExpandInput = {
      ...expansion, restored: { attempt: 1, files: 2 },
    };
    expect(restoredExpansion.restored).toEqual({ attempt: 1, files: 2 });

    const cause: Parameters<UnattendedPolicy["park"]>[1] = "budget-cap";
    expect(cause).toBe("budget-cap");
  });

  it("LedgerStore", async () => {
    const { calls, hit } = tracker();
    const writer = {} as LedgerWriter;
    const store: LedgerStore = {
      create: async () => hit("create", writer),
      open: async () => hit("open", writer),
      takeover: async () => hit("takeover", writer),
      read: async () => hit("read", LEDGER),
      list: async () => hit("list", [{ planId: "plan-one", status: "running" as const, toplevel: "C:/repo", orchestratorSessionID: "ses-0", seq: 5 }]),
      exportPlan: async () => hit("exportPlan", { snapshot: LEDGER, events: [] }),
      remove: async () => hit("remove", true),
    };
    expect(await store.create(LEDGER, HOLDER)).toBe(writer);
    expect(await store.open("plan-one", HOLDER)).toBe(writer);
    expect(await store.takeover("plan-one", HOLDER, "stale")).toBe(writer);
    expect(await store.read("plan-one")).toBe(LEDGER);
    expect((await store.list())[0]?.seq).toBe(5);
    expect((await store.exportPlan("plan-one")).events).toEqual([]);
    expect(await store.remove("plan-one")).toBe(true);
    expect(calls).toEqual(["create", "open", "takeover", "read", "list", "exportPlan", "remove"]);
  });

  it("LedgerWriter", async () => {
    const { calls, hit } = tracker();
    const writer: LedgerWriter = {
      planId: "plan-one",
      ledger: LEDGER,
      append: async (batch) => {
        // A builder runs against the current ledger; a plain array is taken as is.
        const events = typeof batch === "function" ? batch(LEDGER) : batch;
        return hit(`append:${events.length}`, LEDGER);
      },
      openIntegration: () => hit("openIntegration", [OPEN_ENTRY]),
      wakeKeys: () => hit("wakeKeys", new Set(["inbox:i1", "stale-context:b1:1"])),
      snapshot: async () => hit("snapshot", undefined),
      close: async () => hit("close", undefined),
    };
    expect(writer.planId).toBe("plan-one");
    expect(await writer.append([{ type: "integration-head", head: SHA_A }])).toBe(LEDGER);
    const builder: BatchBuilder = (l) => [{ type: "integration-head", head: l.integration.head }, { type: "phase-tagged", phaseId: "p1", tag: "t" }];
    expect(await writer.append(builder)).toBe(LEDGER);
    expect(await writer.append(() => [])).toBe(LEDGER);
    expect(writer.openIntegration()).toEqual([OPEN_ENTRY]);
    expect(writer.wakeKeys().has("inbox:i1")).toBe(true);
    expect(writer.wakeKeys().has("inbox:i2")).toBe(false);
    await writer.snapshot();
    await writer.close();
    expect(calls).toEqual(["append:1", "append:2", "append:0", "openIntegration", "wakeKeys", "wakeKeys", "snapshot", "close"]);
  });

  it("PlanCompiler", async () => {
    const { calls, hit } = tracker();
    const compiler: PlanCompiler = {
      compile: async () => hit("compile", { draft: LEDGER, summary: SUMMARY }),
      mergeResidue: () => hit("mergeResidue", { draft: LEDGER, summary: SUMMARY }),
      addTasks: () => hit("addTasks", { tasks: [], edges: [EDGE], reopened: [] }),
      validate: () => hit("validate", [{ code: "E", message: "m", taskIds: ["T1"] }]),
    };
    expect((await compiler.compile("PLAN.md", { config: EXECUTOR_DEFAULTS, orchestratorSessionID: "ses-0", now: T0 })).summary).toBe(SUMMARY);
    expect(compiler.mergeResidue(LEDGER, "{}").draft).toBe(LEDGER);
    expect(compiler.addTasks(LEDGER, "text").edges).toEqual([EDGE]);
    expect(compiler.validate(LEDGER)[0]?.code).toBe("E");
    expect(calls).toEqual(["compile", "mergeResidue", "addTasks", "validate"]);
  });

  it("SlotPool", async () => {
    const { calls, hit } = tracker();
    const pool: SlotPool = {
      acquire: async () => hit("acquire", LEASE),
      acquireSpecial: async () => hit("acquireSpecial", LEASE),
      reset: async () => hit("reset", undefined),
      noteCommit: async () => hit("noteCommit", undefined),
      cleanForChecks: async () => hit("cleanForChecks", { drifted: false }),
      release: async () => hit("release", undefined),
      get: async () => hit("get", SLOT_RECORD),
      list: async () => hit("list", [SLOT_RECORD]),
      gc: async () => hit("gc", { removed: [], reported: [] }),
    };
    expect(await pool.acquire("plan-one", "T1", "c0ffee")).toBe(LEASE);
    expect(await pool.acquireSpecial("plan-one", "ci")).toBe(LEASE);
    await pool.reset("slot-1", "c0ffee");
    await pool.noteCommit("slot-1", "c0ffee");
    expect(await pool.cleanForChecks("slot-1")).toEqual({ drifted: false });
    await pool.release("slot-1");
    expect(await pool.get("slot-1")).toBe(SLOT_RECORD);
    expect(await pool.list()).toEqual([SLOT_RECORD]);
    expect(await pool.gc(async () => null)).toEqual({ removed: [], reported: [] });
    expect(calls).toEqual(["acquire", "acquireSpecial", "reset", "noteCommit", "cleanForChecks", "release", "get", "list", "gc"]);
  });

  it("IntegrationListener", () => {
    const { calls, hit } = tracker();
    const listener: IntegrationListener = {
      onIntegrated: () => void hit("onIntegrated", 0),
      onConflict: () => void hit("onConflict", 0),
      onFailed: () => void hit("onFailed", 0),
      onReverted: () => void hit("onReverted", 0),
      onGate: () => void hit("onGate", 0),
      onInbox: () => void hit("onInbox", 0),
    };
    listener.onIntegrated("T1");
    listener.onConflict("T1");
    listener.onFailed("T1");
    listener.onReverted("T1");
    listener.onGate("p1", "passed");
    listener.onInbox(INBOX_ITEM);
    expect(calls).toEqual(["onIntegrated", "onConflict", "onFailed", "onReverted", "onGate", "onInbox"]);
  });

  it("IntegrationQueue", async () => {
    const { calls, hit } = tracker();
    const queue: IntegrationQueue = {
      enqueue: () => void hit("enqueue", 0),
      resume: async () => hit("resume", { completed: [], rolledBack: [], halted: false, entries: [] }),
      checkPhase: async () => hit("checkPhase", undefined),
      land: async () => hit("land", { landed: true, inbox: null }),
      abort: async () => hit("abort", undefined),
      queued: () => hit("queued", ["T1"]),
      dispose: async () => hit("dispose", undefined),
    };
    queue.enqueue(["T1"]);
    const report: ResumeReport = await queue.resume();
    expect(report).toEqual({ completed: [], rolledBack: [], halted: false, entries: [] });
    await queue.checkPhase("p1");
    expect((await queue.land()).landed).toBe(true);
    await queue.abort();
    expect(queue.queued()).toEqual(["T1"]);
    await queue.dispose();
    expect(calls).toEqual(["enqueue", "resume", "checkPhase", "land", "abort", "queued", "dispose"]);
  });

  it("leaseTaskRef / leaseHolderID are unique per plan and task (QA-1.4-32/-33)", () => {
    expect(leaseTaskRef("plan-one", "T1")).toBe("plan-one:T1");
    expect(leaseHolderID("plan-one", "T1")).toBe("plan:plan-one:T1");
    // The same task id in two plans gives different refs and holder ids.
    expect(leaseTaskRef("plan-one", "T1")).not.toBe(leaseTaskRef("plan-two", "T1"));
    expect(leaseHolderID("plan-one", "T1")).not.toBe(leaseHolderID("plan-two", "T1"));
    // Neither id grammar allows ':' so the separator is unambiguous.
    expect(isTaskId("T:1")).toBe(false);
  });

  it("LeaseView / LeaseService, CapacityView and Scheduler", () => {
    const { calls, hit } = tracker();
    // A stateful per-plan LeaseService double over one shared registry (QA-1.4-22/-32/-33): all-or-nothing acquire,
    // release by taskRef (idempotent), rebuild that never touches a holder outside the plan.
    type Held = { planId: string | null; taskId: string | null; holderID: string; taskRef: string; tree: string };
    const registry = new Map<string, Held>();
    let acquireWriteCalls = 0;
    const makeLeases = (planId: string): LeaseService => {
      const releaseTask = (taskId: string): void => {
        const ref = leaseTaskRef(planId, taskId);
        for (const [p, h] of [...registry]) if (h.taskRef === ref) registry.delete(p);
      };
      const info = (h: Held): LeaseHolderInfo => ({ planId: h.planId, taskId: h.taskId, holderID: h.holderID });
      const acquireTask: LeaseService["acquireTask"] = ({ taskId, tree, writes }) => {
        if (writes.length === 0) return { ok: true };
        acquireWriteCalls++;
        const ref = leaseTaskRef(planId, taskId);
        const holders = writes.flatMap((p) => {
          const h = registry.get(p);
          return h !== undefined && h.taskRef !== ref ? [info(h)] : [];
        });
        if (holders.length > 0) return { ok: false, reason: "held", holders };
        for (const p of writes) registry.set(p, { planId, taskId, holderID: leaseHolderID(planId, taskId), taskRef: ref, tree });
        return { ok: true };
      };
      return {
        planId,
        holder: (path) => {
          hit("holder", undefined);
          const h = registry.get(path);
          return h === undefined ? null : info(h);
        },
        acquireTask,
        releaseTask,
        rebuild: (tasks) => {
          for (const t of tasks) releaseTask(t.id);
          const failed: Array<{ taskId: string; holders: LeaseHolderInfo[] }> = [];
          for (const t of tasks) {
            if (t.slot === null || t.tree === null || t.footprint.writes.length === 0) continue;
            const r = acquireTask({ taskId: t.id, tree: t.tree, writes: t.footprint.writes });
            if (!r.ok && r.reason === "held") failed.push({ taskId: t.id, holders: r.holders });
          }
          return failed;
        },
      };
    };
    const leases = makeLeases("plan-one");
    const view: LeaseView = leases;
    expect(leases.planId).toBe("plan-one");
    expect(leases.acquireTask({ taskId: "T1", tree: "C:/slots/slot-1", writes: ["src/a.ts", "src/b.ts"] })).toEqual({ ok: true });
    expect(leases.acquireTask({ taskId: "T1", tree: "C:/slots/slot-1", writes: ["src/a.ts"] })).toEqual({ ok: true });
    expect(leases.acquireTask({ taskId: "T2", tree: "C:/slots/slot-2", writes: ["src/b.ts", "src/c.ts"] })).toEqual({
      ok: false, reason: "held", holders: [{ planId: "plan-one", taskId: "T1", holderID: "plan:plan-one:T1" }],
    });
    expect(registry.has("src/c.ts")).toBe(false);
    leases.releaseTask("T1");
    leases.releaseTask("T1");
    expect(registry.size).toBe(0);
    // acquireTask with no writes makes no registry call.
    const callsBefore = acquireWriteCalls;
    expect(leases.acquireTask({ taskId: "T9", tree: "C:/slots/slot-9", writes: [] })).toEqual({ ok: true });
    expect(acquireWriteCalls).toBe(callsBefore);
    expect(registry.size).toBe(0);
    // rebuild keeps holders outside the plan (another plan, an ad-hoc child) and re-takes this plan's slot leases.
    const other = makeLeases("plan-two");
    expect(other.acquireTask({ taskId: "T3", tree: "C:/slots/other", writes: ["src/other.ts"] })).toEqual({ ok: true });
    registry.set("src/adhoc.ts", { planId: null, taskId: null, holderID: "ses-adhoc", taskRef: "adhoc", tree: "C:/repo" });
    leases.acquireTask({ taskId: "T4", tree: "C:/slots/slot-4", writes: ["src/stale.ts"] });
    const notRetaken = leases.rebuild([
      { id: "T3", slot: "s1", tree: "C:/slots/s1", footprint: { ...taskNode("T3").footprint, writes: ["src/z.ts"] } },
      { id: "T4", slot: null, tree: null, footprint: { ...taskNode("T4").footprint, writes: ["src/y.ts"] } },
      { id: "T5", slot: "s2", tree: "C:/slots/s2", footprint: { ...taskNode("T5").footprint, writes: ["src/other.ts"] } },
    ]);
    expect([...registry.keys()].sort()).toEqual(["src/adhoc.ts", "src/other.ts", "src/z.ts"]);
    expect(registry.get("src/other.ts")?.taskRef).toBe("plan-two:T3");
    expect(registry.get("src/adhoc.ts")?.holderID).toBe("ses-adhoc");
    expect(notRetaken).toEqual([
      { taskId: "T5", holders: [{ planId: "plan-two", taskId: "T3", holderID: "plan:plan-two:T3" }] },
    ]);
    registry.clear();
    registry.set("src/a.ts", { planId: "plan-one", taskId: "T1", holderID: "ses-1", taskRef: "plan-one:T1", tree: "C:/slots/slot-1" });
    const capacity: CapacityView = {
      routeOf: () => hit("routeOf", ROUTE),
      free: () => hit("free", 2),
    };
    const scheduler: Scheduler = {
      readySet: () => hit("readySet", [{ taskId: "T3", route: ROUTE, bottomLevelMs: 10 }]),
      promotable: () => hit("promotable", { toReady: ["T3"], unblock: [] }),
      manualReady: () => hit("manualReady", ["M1"]),
      addLearnedEdge: () => hit("addLearnedEdge", EDGE),
    };
    expect(view.holder("src/a.ts")).toEqual({ planId: "plan-one", taskId: "T1", holderID: "ses-1" });
    expect(capacity.routeOf(taskNode("T3"))).toBe(ROUTE);
    expect(capacity.free("anthropic", false)).toBe(2);
    expect(scheduler.readySet(LEDGER, new Set<string>(), leases, capacity)[0]?.taskId).toBe("T3");
    expect(scheduler.promotable(LEDGER).toReady).toEqual(["T3"]);
    expect(scheduler.manualReady(LEDGER)).toEqual(["M1"]);
    expect(scheduler.addLearnedEdge(LEDGER, "T1", "T3", "e")).toBe(EDGE);
    expect(calls).toEqual(["holder", "routeOf", "free", "readySet", "promotable", "manualReady", "addLearnedEdge"]);
  });

  it("CapacityController", () => {
    const { calls, hit } = tracker();
    const controller: CapacityController = {
      limit: () => hit("limit", 4),
      canAcquire: () => hit("canAcquire", true),
      acquire: () => hit("acquire", { id: "tok-1" }),
      release: () => void hit("release", 0),
      onSignal: () => hit("onSignal", { decreased: true, pausedUntil: null, inbox: null }),
      shouldStopRetry: () => hit("shouldStopRetry", false),
      pausedUntil: () => hit("pausedUntil", null),
      snapshot: () => hit("snapshot", { anthropic: 4 }),
    };
    expect(controller.limit("anthropic")).toBe(4);
    expect(controller.canAcquire("anthropic", false)).toBe(true);
    const token = controller.acquire("anthropic", false, "T1", 1);
    controller.acquire("anthropic", false, "T1", 2, { force: true });
    controller.release(token, "success");
    expect(controller.onSignal({
      source: "retry-hook", sessionID: "ses-1", stepKey: "k", provider: "anthropic", error: HOST_ERROR, at: T0,
    }).decreased).toBe(true);
    expect(controller.shouldStopRetry({ sessionID: "ses-1", stepKey: "k", provider: "anthropic", planChild: true })).toBe(false);
    expect(controller.pausedUntil("anthropic")).toBeNull();
    expect(controller.snapshot()).toEqual({ anthropic: 4 });
    expect(calls).toEqual(["limit", "canAcquire", "acquire", "acquire", "release", "onSignal", "shouldStopRetry", "pausedUntil", "snapshot"]);
  });

  it("TaskLauncher", async () => {
    const { calls, hit } = tracker();
    const end: ChildEnd = { kind: "completed", childSessionID: "ses-1", text: "done", endedAt: T0 };
    const handle: LaunchHandle = {
      taskId: "T3", attempt: 1, nonce: NONCE, context: CONTEXT_REF, contextAgeMs: 0, startedAt: T0,
      confirmation: Promise.resolve({ kind: "confirmed", childSessionID: "ses-1", latencyMs: 1 }),
      completion: Promise.resolve(end),
    };
    const launcher: TaskLauncher = {
      gate: () => hit("gate", { ok: true as const, context: CONTEXT_INFO, ageMs: 0 }),
      launch: () => hit("launch", handle),
      cancel: async () => hit("cancel", undefined),
      inFlight: () => hit("inFlight", [{ taskId: "T3", attempt: 1, childSessionID: null, startedAt: T0 }]),
      dispose: async () => hit("dispose", undefined),
    };
    expect(launcher.gate("ses-0").ok).toBe(true);
    const h = launcher.launch(REQUEST, { onChildCreated: async () => undefined, onLateChild: async () => "refuse" });
    expect(await h.confirmation).toEqual({ kind: "confirmed", childSessionID: "ses-1", latencyMs: 1 });
    expect(await h.completion).toBe(end);
    await launcher.cancel("T3", 1, "abort");
    expect(launcher.inFlight()).toHaveLength(1);
    await launcher.dispose();
    expect(calls).toEqual(["gate", "launch", "cancel", "inFlight", "dispose"]);
  });

  it("Waker", async () => {
    const { calls, hit } = tracker();
    const waker: Waker = { wake: async () => hit("wake", "sent" as const) };
    expect(await waker.wake("inbox", "inbox:Q-1")).toBe("sent");
    expect(calls).toEqual(["wake"]);
  });

  it("ExecutorRuntime", async () => {
    const { calls, hit } = tracker();
    const runtime: ExecutorRuntime = {
      compile: async () => hit("compile", { planId: "plan-one", summary: SUMMARY, residuePrompt: null }),
      residue: async () => hit("residue", SUMMARY),
      approve: async () => hit("approve", undefined),
      status: async () => hit("status", "board"),
      ready: async () => hit("ready", { launchable: ["T3"], manual: ["M1"] }),
      addTasks: async () => hit("addTasks", { added: [], reopened: [] }),
      answer: async () => hit("answer", undefined),
      done: async () => hit("done", undefined),
      pause: async () => hit("pause", undefined),
      resume: async () => hit("resume", undefined),
      abort: async () => hit("abort", undefined),
      land: async () => hit("land", undefined),
      adopt: async () => hit("adopt", undefined),
      gc: async () => hit("gc", { removed: [], reported: [] }),
      exportPlan: async () => hit("exportPlan", "{}"),
      purge: async () => hit("purge", undefined),
      onRouterToolCall: () => void hit("onRouterToolCall", 0),
      onHostEvent: () => void hit("onHostEvent", 0),
      onRetryHook: () => hit("onRetryHook", { stop: false }),
      onChildEnd: async () => hit("onChildEnd", undefined),
      planLine: () => hit("planLine", null),
      start: async () => hit("start", undefined),
      dispose: async () => hit("dispose", undefined),
    };
    expect((await runtime.compile({ path: "PLAN.md", sessionID: "ses-0" })).planId).toBe("plan-one");
    expect(await runtime.residue("plan-one", "{}", "ses-0")).toBe(SUMMARY);
    await runtime.approve("plan-one", "ses-0");
    expect(await runtime.status(null, "ses-0")).toBe("board");
    expect((await runtime.ready("plan-one")).launchable).toEqual(["T3"]);
    expect(await runtime.addTasks("plan-one", "text", "ses-0")).toEqual({ added: [], reopened: [] });
    await runtime.answer("plan-one", "Q-1", "yes", "ses-0");
    await runtime.done("plan-one", "M1", "ses-0");
    await runtime.pause("plan-one", "ses-0");
    await runtime.resume("plan-one", "ses-0");
    await runtime.abort("plan-one", "ses-0");
    await runtime.land("plan-one", "ses-0");
    await runtime.adopt("plan-one", "ses-0");
    expect(await runtime.gc()).toEqual({ removed: [], reported: [] });
    expect(await runtime.exportPlan("plan-one")).toBe("{}");
    await runtime.purge("plan-one", "ses-0");
    runtime.onRouterToolCall("ses-0");
    runtime.onHostEvent({ type: "execution.completed", sessionID: "ses-1", at: T0 });
    expect(runtime.onRetryHook({ sessionID: "ses-1", stepKey: "k", error: HOST_ERROR })).toEqual({ stop: false });
    await runtime.onChildEnd("T3", 1, { kind: "interrupted", childSessionID: null, reason: "abort", endedAt: T0 });
    expect(runtime.planLine("ses-0")).toBeNull();
    await runtime.start();
    await runtime.dispose();
    expect(calls).toHaveLength(23);
    expect(new Set(calls).size).toBe(23);
  });

  it("RecoveryService", async () => {
    const { calls, hit } = tracker();
    const recovery: RecoveryService = {
      recover: async () => hit("recover", [{ planId: "plan-one", actions: [{ taskId: "T2", from: "running" as const, evidence: "lost" as const, action: "requeue-lost" as const }] }]),
      adopt: async () => hit("adopt", undefined),
    };
    expect((await recovery.recover())[0]?.actions[0]?.action).toBe("requeue-lost");
    await recovery.adopt("plan-one", "ses-0");
    expect(calls).toEqual(["recover", "adopt"]);
  });

  it("UnattendedPolicy", async () => {
    const { calls, hit } = tracker();
    const policy: UnattendedPolicy = {
      raise: async () => hit("raise", INBOX_ITEM),
      park: async () => hit("park", INBOX_ITEM),
      answer: async () => hit("answer", { resumed: "T2" }),
      unblock: async () => hit("unblock", ["T3"]),
      recordAttempt: async () => hit("recordAttempt", { tripped: false }),
    };
    expect(await policy.raise({ kind: "question", severity: "info", taskId: null, text: "t", options: [] })).toBe(INBOX_ITEM);
    expect(await policy.park("T2", "escalate", "why")).toBe(INBOX_ITEM);
    expect(await policy.answer("Q-1", "yes")).toEqual({ resumed: "T2" });
    expect(await policy.unblock()).toEqual(["T3"]);
    expect(await policy.recordAttempt("p1", attempt(1, "failed"))).toEqual({ tripped: false });
    expect(calls).toEqual(["raise", "park", "answer", "unblock", "recordAttempt"]);
  });

  it("QaLoop", async () => {
    const { calls, hit } = tracker();
    const qa: QaLoop = {
      parse: () => hit("parse", { ok: true as const, report: { findings: [] } }),
      onQaResult: async () => hit("onQaResult", "passed" as const),
      onAwaitingQa: async () => hit("onAwaitingQa", undefined),
      onCapAnswer: async (_id, choice) => hit("onCapAnswer", choice === "accept" ? ("passed" as const) : ("next-round" as const)),
    };
    expect(qa.parse("```json\n{\"findings\":[]}\n```")).toEqual({ ok: true, report: { findings: [] } });
    expect(await qa.onQaResult("p1.QA1", { findings: [] })).toBe("passed");
    await qa.onAwaitingQa("p1");
    expect(await qa.onCapAnswer("R-1", "accept")).toBe("passed");
    expect(calls).toEqual(["parse", "onQaResult", "onAwaitingQa", "onCapAnswer"]);
  });

  it("RouteResolver, RoleBindings, DispatchBookkeeping and SlotVerifier", async () => {
    const { calls, hit } = tracker();
    const resolver: RouteResolver = { route: () => hit("route", ROUTE) };
    const bindings: RoleBindings = { bind: () => void hit("bind", 0) };
    const bookkeeping: DispatchBookkeeping = {
      decisionRow: () => void hit("decisionRow", 0),
      recordDispatchStart: () => void hit("recordDispatchStart", 0),
      registerInFlight: () => void hit("registerInFlight", 0),
      unregisterInFlight: () => void hit("unregisterInFlight", 0),
    };
    const verifier: SlotVerifier = { verify: async () => hit("verify", { verdict: "pass" as const, findings: "", ref: "r" }) };
    expect(resolver.route(taskNode("T3"))).toBe(ROUTE);
    bindings.bind({ childSessionID: "ses-1", role: "implementer", agent: "implementer", workRoot: "C:/slots/slot-1", grant: [] });
    bookkeeping.decisionRow(REQUEST);
    bookkeeping.recordDispatchStart(REQUEST, T0);
    bookkeeping.registerInFlight("T3", 1, null);
    bookkeeping.unregisterInFlight("T3", 1);
    expect((await verifier.verify(taskNode("T3"), LEASE, attempt(1, "succeeded"))).verdict).toBe("pass");
    expect(calls).toEqual(["route", "bind", "decisionRow", "recordDispatchStart", "registerInFlight", "unregisterInFlight", "verify"]);
  });
});

describe("typed test doubles for every seam", () => {
  it("Clock", () => {
    const { calls, hit } = tracker();
    const clock: Clock = {
      now: () => hit("now", Date.parse(T0)),
      iso: () => hit("iso", T0),
      setTimer: () => hit("setTimer", { id: 1 }),
      clearTimer: () => void hit("clearTimer", 0),
      randomHex: () => hit("randomHex", NONCE),
    };
    expect(clock.now()).toBe(Date.parse(T0));
    expect(clock.iso()).toBe(T0);
    const timer = clock.setTimer(10, () => undefined);
    clock.clearTimer(timer);
    expect(NONCE_PATTERN.test(clock.randomHex(16))).toBe(true);
    expect(calls).toEqual(["now", "iso", "setTimer", "clearTimer", "randomHex"]);
  });

  it("GitRunner and Spawner", async () => {
    const { calls, hit } = tracker();
    const git: GitRunner = { run: async () => hit("git.run", PROC) };
    const spawner: Spawner = {
      run: async () => hit("spawner.run", PROC),
      pid: 4242,
      hostname: "host",
      isAlive: () => hit("isAlive", true),
    };
    expect(await git.run(["status"], { cwd: "C:/repo", timeoutMs: 1000 })).toBe(PROC);
    expect(await spawner.run("node", ["-v"], { cwd: "C:/repo", timeoutMs: 1000 })).toBe(PROC);
    expect(spawner.pid).toBe(4242);
    expect(spawner.hostname).toBe("host");
    expect(spawner.isAlive(4242)).toBe(true);
    expect(calls).toEqual(["git.run", "spawner.run", "isAlive"]);
  });

  it("FileSystem", async () => {
    const { calls, hit } = tracker();
    const fs: FileSystem = {
      readText: async () => hit("readText", "text"),
      writeText: async () => hit("writeText", undefined),
      appendText: async () => hit("appendText", undefined),
      rename: async () => hit("rename", undefined),
      rm: async () => hit("rm", undefined),
      mkdir: async () => hit("mkdir", undefined),
      readdir: async () => hit("readdir", ["a"]),
      lstat: async () => hit("lstat", { kind: "file" as const, size: 1, mtimeMs: 2 }),
      realpath: async () => hit("realpath", "C:/repo"),
      fsyncDir: async () => hit("fsyncDir", undefined),
    };
    expect(await fs.readText("a")).toBe("text");
    await fs.writeText("a", "x", { exclusive: true, fsync: true });
    await fs.appendText("a", "x", { fsync: false });
    await fs.rename("a", "b");
    await fs.rm("b", { recursive: false });
    await fs.mkdir("d");
    expect(await fs.readdir("d")).toEqual(["a"]);
    expect(await fs.lstat("a")).toEqual({ kind: "file", size: 1, mtimeMs: 2 });
    expect(await fs.realpath("a")).toBe("C:/repo");
    await fs.fsyncDir("d");
    expect(calls).toEqual(["readText", "writeText", "appendText", "rename", "rm", "mkdir", "readdir", "lstat", "realpath", "fsyncDir"]);
  });

  it("HostSessions", async () => {
    const { calls, hit } = tracker();
    const sessions: HostSessions = {
      get: async () => hit("get", { id: "ses-1", parentID: null }),
      context: async () => hit("context", { messages: [{ role: "assistant" as const, text: "hi", outcome: null }] }),
      activity: async () => hit("activity", "active" as const),
      interrupt: async () => hit("interrupt", undefined),
      synthetic: async () => hit("synthetic", undefined),
      move: async () => hit("move", undefined),
      onEvent: () => hit("onEvent", () => undefined),
    };
    expect(await sessions.get("ses-1")).toEqual({ id: "ses-1", parentID: null });
    expect((await sessions.context("ses-1")).messages).toHaveLength(1);
    expect(await sessions.activity("ses-1")).toBe("active");
    await sessions.interrupt("ses-1");
    await sessions.synthetic({ sessionID: "ses-0", text: "wake", description: "d", metadata: { a: 1, b: ["x", null] }, resume: true });
    await sessions.move("ses-1", "C:/repo");
    const off = sessions.onEvent(() => undefined);
    off();
    expect(calls).toEqual(["get", "context", "activity", "interrupt", "synthetic", "move", "onEvent"]);
  });

  it("ChildRunner", async () => {
    const { calls, hit } = tracker();
    const runner: ChildRunner = {
      bootID: BOOT_ID,
      run: async () => hit("run", { sessionID: "ses-1", text: "done" }),
      dispose: async () => hit("dispose", undefined),
      retainedContext: () => hit("retainedContext", CONTEXT_INFO),
      onContextCaptured: () => hit("onContextCaptured", () => undefined),
    };
    const controller = new AbortController();
    const result = await runner.run({
      parentSessionID: "ses-0", prompt: REQUEST.prompt, agent: "implementer", model: ROUTE.model, cwd: "C:/slots/slot-1",
      signal: controller.signal, detached: true, context: CONTEXT_REF, onCreated: async () => undefined,
    });
    expect(runner.bootID).toBe(BOOT_ID);
    expect(result).toEqual({ sessionID: "ses-1", text: "done" });
    await runner.dispose("ses-1");
    expect(runner.retainedContext("ses-0")).toBe(CONTEXT_INFO);
    runner.onContextCaptured(() => undefined)();
    expect(calls).toEqual(["run", "dispose", "retainedContext", "onContextCaptured"]);
  });
});
