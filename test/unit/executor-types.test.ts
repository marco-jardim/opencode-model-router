// test/unit/executor-types.test.ts
// Phase 1.4 task 1.4.4: unit tests for the cross-phase executor contract in src/executor/types.ts (memo §12).
import { describe, expect, it } from "vitest";
import {
  ATTEMPT_OUTCOMES,
  CHILD_END_GRACE_MS,
  DURABLE_TASK_STATES,
  EXECUTOR_DEFAULTS,
  EXECUTOR_LIMITS,
  ExecutorError,
  FINDINGS_FORMAT,
  GATE_STATES,
  GATE_TRANSITIONS,
  HEAVY_CAP_PER_PROVIDER,
  LAUNCH_CONFIRM_TIMEOUT_MS,
  LAUNCH_HEADER_PATTERN,
  LEDGER_SCHEMA,
  LEDGER_STATUSES,
  LEDGER_STATUS_TRANSITIONS,
  NONCE_PATTERN,
  PLAN_ID_PATTERN,
  TASK_ID_PATTERN,
  TASK_KINDS,
  TASK_STATES,
  TASK_TRANSITIONS,
  TERMINAL_TASK_STATES,
  TRANSITION_OWNERS,
  TRANSITION_TRIGGERS,
  VERDICTS,
  canGateTransition,
  canStatusTransition,
  canTransition,
  classifyProviderError,
  countedAttempts,
  countsTowardMaxAttempts,
  executionFailureOutcome,
  formatLaunchHeader,
  hasAttemptsLeft,
  isBreakerFailure,
  isDurableEvent,
  isFindingsReport,
  isLedgerV1,
  isTaskNode,
  ledgerSchemaOf,
  parseLaunchHeader,
} from "../../src/executor/types";
import type {
  Attempt,
  AttemptOutcome,
  CapacityController,
  CapacityView,
  ChildEnd,
  ChildRunner,
  Clock,
  DispatchBookkeeping,
  Edge,
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
    n, nonce: NONCE, callID: null, childSessionID: null, startedAt: T0, endedAt: outcome === null ? null : T0,
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
    repo: { key: "repo-key", toplevel: "C:/repo", baseBranch: "main", baseCommit: "c0ffee" },
    integration: { branch: "omr/plan-one/integration", worktree: "C:/slots/integration", head: "c0ffee" },
    launcher: "A",
    status: "running",
    orchestrator: { sessionID: "ses-0", boundAt: T0 },
    config,
    sharedContext: "shared notes",
    waves: [{ id: "w1", phases: ["p1"] }],
    phases: [{ id: "p1", title: "Phase 1", wave: "w1", dependsOn: ["p0"], gate: "pending", qaRound: 0, paused: false, tag: null }],
    tasks: {
      T1: taskNode("T1", {
        state: "integrated", slot: "slot-1", branch: "omr/plan-one/t/T1", acceptance: "criteria",
        attempts: [attempt(1, "succeeded", "pass", { callID: "call-1", childSessionID: "ses-1" })],
        integrated: { from: "aaa", to: "bbb" },
      }),
      T2: taskNode("T2", { state: "running", slot: "slot-2", attempts: [attempt(1, "failed", "fail"), attempt(2, null)] }),
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

function randomJson(rng: () => number, depth: number): unknown {
  const pick = Math.floor(rng() * (depth > 2 ? 4 : 6));
  switch (pick) {
    case 0: return null;
    case 1: return rng() < 0.5;
    case 2: return Math.floor(rng() * 1000) - 500;
    case 3: return `s${Math.floor(rng() * 1e6).toString(36)}`;
    case 4: return Array.from({ length: Math.floor(rng() * 4) }, () => randomJson(rng, depth + 1));
    default: {
      const o: Record<string, unknown> = {};
      const n = Math.floor(rng() * 5);
      for (let i = 0; i < n; i++) o[`k${Math.floor(rng() * 30)}`] = randomJson(rng, depth + 1);
      return o;
    }
  }
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

  it("exposes the documented numeric constants and patterns", () => {
    expect(LEDGER_SCHEMA).toBe(1);
    expect(LAUNCH_CONFIRM_TIMEOUT_MS).toBe(30_000);
    expect(CHILD_END_GRACE_MS).toBe(5_000);
    expect(HEAVY_CAP_PER_PROVIDER).toBe(2);
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
  "escalate", "ambiguity", "child-lost", "capacity-stop", "lease-needed", "committed", "no-changes", "commit-failed",
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
    "awaiting-qa": ["qa-running", "passed"],
    "qa-running": ["awaiting-qa", "pending", "passed"],
    passed: [],
  };

  it("matches the expected 6x6 table", () => {
    let legalCount = 0;
    for (const a of GATE_STATES) {
      for (const b of GATE_STATES) {
        const expected = legal[a].includes(b);
        expect(canGateTransition(a, b), `${a}>${b}`).toBe(expected);
        if (expected) legalCount++;
      }
    }
    expect(legalCount).toBe(11);
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
    { type: "provider.internal", status: null, klass: "overload" },
    { type: "provider.internal", status: 500, klass: "overload" },
    { type: "provider.internal", status: 429, klass: "overload" },
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
});

// ---------------------------------------------------------------------------------------------------------------
// §7 Launch header
// ---------------------------------------------------------------------------------------------------------------

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
          expect(parseLaunchHeader(header)).toEqual(fields);
          expect(LAUNCH_HEADER_PATTERN.test(header)).toBe(true);
        }
      }
    }
  });

  it("finds the header line inside a full prompt", () => {
    const fields = { planId: "plan-one", taskId: "T2", attempt: 3, nonce: NONCE };
    const prompt = `PLAN CONTEXT\nshared\n\n${formatLaunchHeader(fields)}\n\nTASK\nDo the thing.`;
    expect(parseLaunchHeader(prompt)).toEqual(fields);
  });

  it("returns null when there is no header or the header is malformed", () => {
    expect(parseLaunchHeader("")).toBeNull();
    expect(parseLaunchHeader("no header here")).toBeNull();
    expect(parseLaunchHeader(`[plan plan-one:T1#0] nonce=${NONCE}`)).toBeNull();
    expect(parseLaunchHeader(`[plan plan-one:T1#10000] nonce=${NONCE}`)).toBeNull();
    expect(parseLaunchHeader(`[plan plan-one:T1#1] nonce=${NONCE.toUpperCase()}`)).toBeNull();
    expect(parseLaunchHeader(`[plan plan-one:T1#1] nonce=${NONCE.slice(1)}`)).toBeNull();
    expect(parseLaunchHeader(`[plan PLAN:T1#1] nonce=${NONCE}`)).toBeNull();
    expect(parseLaunchHeader(`[plan plan-one:T1#1] nonce=${NONCE} trailing`)).toBeNull();
    expect(parseLaunchHeader(`[plan plan-one:T 1#1] nonce=${NONCE}`)).toBeNull();
  });

  it("rejects integer-like task ids", () => {
    for (const taskId of ["1", "42", "0123", "9999999"]) {
      expect(() => formatLaunchHeader({ planId: "plan-one", taskId, attempt: 1, nonce: NONCE }), taskId).toThrow(ExecutorError);
      expect(parseLaunchHeader(`[plan plan-one:${taskId}#1] nonce=${NONCE}`), taskId).toBeNull();
    }
  });

  it("formatLaunchHeader throws ExecutorError E_INVALID_INPUT on invalid fields", () => {
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
      expect(err.code).toBe("E_INVALID_INPUT");
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
      const node = taskNode("T5", {
        state, slot: "slot-1", branch: "omr/plan-one/t/T5",
        attempts: inFlight ? [attempt(1, null)] : [attempt(1, "succeeded", "pass")],
        integrated: state === "integrated" ? { from: "a", to: "b" } : null,
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

  it("rejects 100 random JSON values and 40 ledgers corrupted by two simultaneous mutations", () => {
    const rng = mulberry32(0x5eed);
    for (let i = 0; i < 100; i++) expect(isLedgerV1(randomJson(rng, 0)), String(i)).toBe(false);

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
      { type: "gate-changed", phaseId: "p1", from: "pending", to: "awaiting-qa", qaRound: 0 },
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
const REQUEST: LaunchRequest = {
  planId: "plan-one", taskId: "T3", attempt: 1, nonce: NONCE, orchestratorSessionID: "ses-0", contextEpoch: 1, route: ROUTE,
  role: "implementer", grant: [], workRoot: "C:/slots/slot-1",
  prompt: formatLaunchHeader({ planId: "plan-one", taskId: "T3", attempt: 1, nonce: NONCE }),
};
const CONTEXT_INFO: RetainedContextInfo = { sessionID: "ses-0", callID: "call-1", messageID: "m-1", agent: "orchestrator", capturedAt: T0, epoch: 1 };
const PROC: ProcessResult = { code: 0, signal: null, stdout: "", stderr: "", truncated: false, durationMs: 1 };
const HOST_ERROR: HostError = { type: "provider.rate-limit", status: 429, message: "slow down" };
const EDGE: Edge = { from: "T1", to: "T3", kind: "learned", confidence: "low", evidence: "e" };

describe("typed test doubles for every interface", () => {
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
      append: async () => hit("append", LEDGER),
      snapshot: async () => hit("snapshot", undefined),
      close: async () => hit("close", undefined),
    };
    expect(writer.planId).toBe("plan-one");
    expect(await writer.append([{ type: "integration-head", head: "abc" }])).toBe(LEDGER);
    await writer.snapshot();
    await writer.close();
    expect(calls).toEqual(["append", "snapshot", "close"]);
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
      cleanForChecks: async () => hit("cleanForChecks", undefined),
      release: async () => hit("release", undefined),
      get: async () => hit("get", SLOT_RECORD),
      list: async () => hit("list", [SLOT_RECORD]),
      gc: async () => hit("gc", { removed: [], reported: [] }),
    };
    expect(await pool.acquire("plan-one", "T1", "c0ffee")).toBe(LEASE);
    expect(await pool.acquireSpecial("plan-one", "ci")).toBe(LEASE);
    await pool.reset("slot-1", "c0ffee");
    await pool.cleanForChecks("slot-1");
    await pool.release("slot-1");
    expect(await pool.get("slot-1")).toBe(SLOT_RECORD);
    expect(await pool.list()).toEqual([SLOT_RECORD]);
    expect(await pool.gc(async () => null)).toEqual({ removed: [], reported: [] });
    expect(calls).toEqual(["acquire", "acquireSpecial", "reset", "cleanForChecks", "release", "get", "list", "gc"]);
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
      resume: async () => hit("resume", { completed: [], rolledBack: [] }),
      checkPhase: async () => hit("checkPhase", undefined),
      land: async () => hit("land", { landed: true, inbox: null }),
      abort: async () => hit("abort", undefined),
      queued: () => hit("queued", ["T1"]),
      dispose: async () => hit("dispose", undefined),
    };
    queue.enqueue(["T1"]);
    expect(await queue.resume()).toEqual({ completed: [], rolledBack: [] });
    await queue.checkPhase("p1");
    expect((await queue.land()).landed).toBe(true);
    await queue.abort();
    expect(queue.queued()).toEqual(["T1"]);
    await queue.dispose();
    expect(calls).toEqual(["enqueue", "resume", "checkPhase", "land", "abort", "queued", "dispose"]);
  });

  it("LeaseView / LeaseService, CapacityView and Scheduler", () => {
    const { calls, hit } = tracker();
    const leases: LeaseService = { holder: () => hit("holder", { taskId: "T1", sessionID: "ses-1" }) };
    const view: LeaseView = leases;
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
    expect(view.holder("src/a.ts")).toEqual({ taskId: "T1", sessionID: "ses-1" });
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
    controller.release(token, "success");
    expect(controller.onSignal({
      source: "retry-hook", sessionID: "ses-1", stepKey: "k", provider: "anthropic", error: HOST_ERROR, at: T0,
    }).decreased).toBe(true);
    expect(controller.shouldStopRetry({ sessionID: "ses-1", stepKey: "k", provider: "anthropic", planChild: true })).toBe(false);
    expect(controller.pausedUntil("anthropic")).toBeNull();
    expect(controller.snapshot()).toEqual({ anthropic: 4 });
    expect(calls).toEqual(["limit", "canAcquire", "acquire", "release", "onSignal", "shouldStopRetry", "pausedUntil", "snapshot"]);
  });

  it("TaskLauncher", async () => {
    const { calls, hit } = tracker();
    const end: ChildEnd = { kind: "completed", childSessionID: "ses-1", text: "done", endedAt: T0 };
    const handle: LaunchHandle = {
      taskId: "T3", attempt: 1, nonce: NONCE, contextEpoch: 1, contextAgeMs: 0, startedAt: T0,
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
    };
    expect(qa.parse("```json\n{\"findings\":[]}\n```")).toEqual({ ok: true, report: { findings: [] } });
    expect(await qa.onQaResult("p1.QA1", { findings: [] })).toBe("passed");
    await qa.onAwaitingQa("p1");
    expect(calls).toEqual(["parse", "onQaResult", "onAwaitingQa"]);
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
      run: async () => hit("run", { sessionID: "ses-1", text: "done" }),
      dispose: async () => hit("dispose", undefined),
      retainedContext: () => hit("retainedContext", CONTEXT_INFO),
      onContextCaptured: () => hit("onContextCaptured", () => undefined),
    };
    const controller = new AbortController();
    const result = await runner.run({
      parentSessionID: "ses-0", prompt: REQUEST.prompt, agent: "implementer", model: ROUTE.model, cwd: "C:/slots/slot-1",
      signal: controller.signal, detached: true, onCreated: async () => undefined,
    });
    expect(result).toEqual({ sessionID: "ses-1", text: "done" });
    await runner.dispose("ses-1");
    expect(runner.retainedContext("ses-0")).toBe(CONTEXT_INFO);
    runner.onContextCaptured(() => undefined)();
    expect(calls).toEqual(["run", "dispose", "retainedContext", "onContextCaptured"]);
  });
});
