import { createHash } from "node:crypto";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createV2Observations, type ServiceObservationData } from "../../src/compat/v2-observations";
import { attachSlotObservations, detachSlotObservations } from "../../src/executor/observations";
import { servicePairs } from "../helpers/service-observations";
import { FakeClock, FakeProc } from "../fixtures/cpx/ledger/fakes.js";
import { removeDirWhenReleased } from "../helpers/remove-dir.js";

// The real ledger store fsyncs every durable batch; on Windows a long scenario takes seconds of wall time. Nothing below waits on
// wall time for a decision (the queue sees only the FakeClock); the budget only bounds how long a hung test may run.
// 60 s per test and hook: a hang fails fast instead of blocking the file (an await that never settles; a microtask busy loop
// would starve the timer too, so the idle-lane guard below bounds ledger reads directly).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import { ExecutorError } from "../../src/executor/types";
import { createRepoLockFactory } from "../../src/executor/integrate/queue";
import { createPhaseSuiteRunner, fileOfSuiteId } from "../../src/executor/integrate/phase-suite";
import {
  AX_MAX_CHARS,
  BackgroundRuns,
  createIntegrationChecks,
  DETAIL_MAX_BYTES,
  OUTPUT_TAIL_BYTES,
  type ResolvedCommand,
  type RunResolver,
  type CheckRequest,
  type CheckResult,
  type CheckSelection,
  type CommandRunRequest,
  type CommandRunResult,
  type CreateRefOutcome,
  type IntegrateGit,
  type IntegrationChecks,
  type Logger,
  type NameStatus,
  type WriteGuard,
  type WritePurpose,
} from "../../src/executor/integrate/checks";
import type { Conflict, GitOps, StatusEntry, WorktreeEntry } from "../../src/executor/git";
import { createLedgerStore } from "../../src/executor/ledger.js";
import {
  PREEMPT_LIMIT,
  createIntegrationQueue,
  type LandInspection,
  type LandOutcome,
  type LandRefusal,
  type LandRequest,
  type Lander,
  type PhaseSuiteRunner,
  type LockWaitInfo,
  type RepoLock,
  type RepoLockFactory,
  type RepoLockWithTakeover,
  type RevertRequest,
  type RevertVerdict,
  type StepJournal,
  type TaskRange,
  type SuiteResolution,
  type SuiteRunRequest,
  type SuiteVerdict,
  type TagOutcome,
  clipText,
  encodeDetail,
  entryIdAt,
  latestStartDetail,
  parseDetail,
  phaseBase,
  phaseHasOwnTasks,
  phaseIntegrated,
  pickBatch,
  dependentPhases,
  tailBytes,
  type IntegrationStepEvent,
} from "../../src/executor/integrate/queue";
import type {
  BatchBuilder,
  ExecutorEvent,
  ExecutorEventInput,
  GateState,
  InboxItem,
  IntegrationEntry,
  IntegrationListener,
  IntegrationQueue,
  IntegrationStep,
  IsoTime,
  JsonValue,
  LeaseService,
  LedgerV1,
  LedgerWriter,
  RunCommandRef,
  SlotLease,
  SlotPool,
  SlotRecord,
  TaskState,
} from "../../src/executor/types";
import { PLAN_ID, buildDraft, holderOf, openAttempt, taskNode } from "../fixtures/cpx/ledger/builders.js";

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------------

const T0 = "2026-10-12T00:00:00.000Z" as IsoTime;

function entry(over: Partial<IntegrationEntry> & { id: string }): IntegrationEntry {
  return { kind: "task", phaseId: "P1", taskIds: ["t1"], slot: "s1", baseHead: "base", candidate: null, ...over };
}

let seqCounter = 0;
function stepEvent(e: IntegrationEntry, over: Partial<IntegrationStepEvent> = {}): IntegrationStepEvent {
  seqCounter++;
  return {
    type: "integration-step", edge: "start", entry: e, step: "rebase", result: null, detail: "{}", failingIds: [], closes: false,
    seq: seqCounter, at: T0, batch: seqCounter, last: true, ...over,
  };
}

/** A ledger with only the fields phaseIntegrated/phaseHasOwnTasks read (phases, tasks). */
function miniLedger(phases: Array<{ id: string; dependsOn: string[] }>,
  tasks: Array<{ id: string; phase: string | null; kind: string; state: TaskState }>): LedgerV1 {
  return {
    phases: phases.map(p => ({ ...p, title: p.id, wave: "w1", gate: "pending" as GateState, qaRound: 1, paused: false, tag: null })),
    tasks: Object.fromEntries(tasks.map(t => [t.id, t])),
  } as unknown as LedgerV1;
}

describe("QA-3.2-19: a phase with no task of its own", () => {
  it("phaseHasOwnTasks is false for a qa-only or empty phase and true with a non-qa task", () => {
    const l = miniLedger([{ id: "P1", dependsOn: [] }, { id: "P2", dependsOn: ["P1"] }, { id: "P3", dependsOn: [] }],
      [{ id: "t1", phase: "P1", kind: "task", state: "verified" }, { id: "q2", phase: "P2", kind: "qa", state: "pending" }]);
    expect(phaseHasOwnTasks(l, "P1")).toBe(true);
    expect(phaseHasOwnTasks(l, "P2")).toBe(false);
    expect(phaseHasOwnTasks(l, "P3")).toBe(false);
  });

  it("phaseIntegrated of a qa-only phase waits for every phase it depends on (not true at plan start)", () => {
    const tasks = [{ id: "t1", phase: "P1", kind: "task", state: "verified" as TaskState },
      { id: "t3", phase: "P3", kind: "task", state: "integrated" as TaskState },
      { id: "q2", phase: "P2", kind: "qa", state: "pending" as TaskState }];
    const phases = [{ id: "P1", dependsOn: [] }, { id: "P3", dependsOn: [] }, { id: "P2", dependsOn: ["P1", "P3"] }];
    expect(phaseIntegrated(miniLedger(phases, tasks), "P2")).toBe(false);
    const done = tasks.map(t => t.id === "t1" ? { ...t, state: "integrated" as TaskState } : t);
    expect(phaseIntegrated(miniLedger(phases, done), "P2")).toBe(true);
    // No dependency and no task: integrated (nothing to wait for); an unknown phase never is.
    expect(phaseIntegrated(miniLedger([{ id: "P9", dependsOn: [] }], []), "P9")).toBe(true);
    expect(phaseIntegrated(miniLedger([], []), "P9")).toBe(false);
  });

  it("phaseIntegrated follows chains of task-less phases and is cycle-safe", () => {
    const phases = [{ id: "A", dependsOn: ["B"] }, { id: "B", dependsOn: ["C"] }, { id: "C", dependsOn: [] }];
    expect(phaseIntegrated(miniLedger(phases, [{ id: "c", phase: "C", kind: "task", state: "running" }]), "A")).toBe(false);
    expect(phaseIntegrated(miniLedger(phases, [{ id: "c", phase: "C", kind: "task", state: "done" }]), "A")).toBe(true);
    const cyc = [{ id: "A", dependsOn: ["B"] }, { id: "B", dependsOn: ["A"] }];
    expect(phaseIntegrated(miniLedger(cyc, []), "A")).toBe(false);
  });
});

describe("queue pure helpers", () => {
  it("PREEMPT_LIMIT is 3 (M38)", () => {
    expect(PREEMPT_LIMIT).toBe(3);
  });

  it("entryIdAt names the entry after the k-th event of the next batch (M1)", () => {
    const l = { seq: 41 } as Pick<LedgerV1, "seq"> as LedgerV1;
    expect(entryIdAt(l, 0)).toBe("i-42");
    expect(entryIdAt(l, 2)).toBe("i-44");
  });

  it("clipText keeps short text and clips long text with an ellipsis at the limit", () => {
    expect(clipText("abc")).toBe("abc");
    const long = "x".repeat(AX_MAX_CHARS + 10);
    const out = clipText(long);
    expect(out.length).toBe(AX_MAX_CHARS);
    expect(out.endsWith("\u2026")).toBe(true);
    expect(clipText("abcdef", 4)).toBe("abc\u2026");
  });

  it("tailBytes keeps the last bytes and never leaves a split multibyte character", () => {
    expect(tailBytes("hello", 10)).toBe("hello");
    expect(tailBytes("hello world", 5)).toBe("world");
    const out = tailBytes("\u20ac".repeat(10), 7); // 3-byte characters: 7 bytes cut inside one
    expect(out).not.toContain("\uFFFD");
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(7);
  });

  it("parseDetail returns objects only", () => {
    expect(parseDetail('{"v":1}')).toEqual({ v: 1 });
    expect(parseDetail("[1]")).toBeNull();
    expect(parseDetail("7")).toBeNull();
    expect(parseDetail("not json")).toBeNull();
    expect(parseDetail("")).toBeNull();
    expect(parseDetail(null)).toBeNull();
    expect(parseDetail(undefined)).toBeNull();
  });

  it("encodeDetail (M34) keeps small detail verbatim", () => {
    expect(JSON.parse(encodeDetail({ v: 1, from: "a", to: "b" }))).toEqual({ v: 1, from: "a", to: "b" });
  });

  it("encodeDetail keeps only the last OUTPUT_TAIL_BYTES of `output`", () => {
    const output = "A".repeat(OUTPUT_TAIL_BYTES * 2) + "END";
    const parsed = JSON.parse(encodeDetail({ v: 1, output })) as { output: string };
    expect(Buffer.byteLength(parsed.output, "utf8")).toBeLessThanOrEqual(OUTPUT_TAIL_BYTES);
    expect(parsed.output.endsWith("END")).toBe(true);
  });

  it("encodeDetail caps the JSON at DETAIL_MAX_BYTES, truncating the big arrays and flagging `truncated`", () => {
    const files = Array.from({ length: 5000 }, (_, i) => `src/some/long/path/number-${i}.ts`);
    const text = encodeDetail({ v: 1, files, idsUnparsed: false, durationMs: 1, output: "o" });
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(DETAIL_MAX_BYTES);
    const parsed = JSON.parse(text) as { files: string[]; truncated?: boolean };
    expect(parsed.truncated).toBe(true);
    expect(parsed.files.length).toBeLessThanOrEqual(20);
  });

  it("encodeDetail falls back to a stub when nothing it knows how to shrink is large", () => {
    const text = encodeDetail({ v: 1, reason: "r", unknownBlob: "z".repeat(DETAIL_MAX_BYTES * 2) });
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(DETAIL_MAX_BYTES);
    expect(JSON.parse(text)).toEqual({ v: 1, truncated: true, reason: "r" });
  });

  it("encodeDetail empties a big object-valued field it knows (ours/theirs) and flags `truncated`", () => {
    const ours = { "src/a.ts": [{ sha: "a".repeat(40), subject: "s".repeat(DETAIL_MAX_BYTES * 2) }] };
    const text = encodeDetail({ v: 1, taskId: "T1", paths: ["src/a.ts"], truncated: false, ours, theirs: {} });
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(DETAIL_MAX_BYTES);
    const parsed = JSON.parse(text) as { ours: Record<string, unknown>; truncated: boolean; paths: string[] };
    expect(parsed.ours).toEqual({});
    expect(parsed.truncated).toBe(true);
    expect(parsed.paths).toEqual(["src/a.ts"]);
  });

  it("encodeDetail trims an oversized output to 1 KiB before it shrinks the arrays", () => {
    const text = encodeDetail({ v: 1, output: "o".repeat(OUTPUT_TAIL_BYTES), files: Array.from({ length: 4000 }, (_, i) => `file-number-${i}.ts`) });
    const parsed = JSON.parse(text) as { output: string; files: string[] };
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(DETAIL_MAX_BYTES);
    expect(Buffer.byteLength(parsed.output, "utf8")).toBeLessThanOrEqual(1024);
    expect(parsed.files.length).toBeLessThanOrEqual(20);
  });

  it("encodeDetail fits once the last array it knows (extraFiles) is cut", () => {
    const extraFiles = Array.from({ length: 3000 }, (_, i) => `src/extra/file-number-${i}.ts`);
    const text = encodeDetail({ v: 1, base: "b", candidate: "c", extraFiles });
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(DETAIL_MAX_BYTES);
    const parsed = JSON.parse(text) as { extraFiles: string[]; truncated: boolean; base: string; candidate: string };
    expect(parsed.extraFiles).toEqual(extraFiles.slice(0, 20));
    expect(parsed).toMatchObject({ truncated: true, base: "b", candidate: "c" });
  });

  it("encodeDetail's last-resort stub carries no reason when the detail had none", () => {
    const text = encodeDetail({ v: 1, unknownBlob: "z".repeat(DETAIL_MAX_BYTES * 2) });
    expect(JSON.parse(text)).toEqual({ v: 1, truncated: true });
  });

  it("phaseBase is the baseHead of the earliest task/batch start of the phase (M23)", () => {
    const steps = [
      stepEvent(entry({ id: "i-1", kind: "task", baseHead: "b1" })),
      stepEvent(entry({ id: "i-1", kind: "task", baseHead: "b1" }), { edge: "end", result: "ok" }),
      stepEvent(entry({ id: "i-9", kind: "batch", baseHead: "b2" })),
      stepEvent(entry({ id: "i-10", kind: "task", phaseId: "P2", baseHead: "other" })),
    ];
    expect(phaseBase(steps, "P1")).toBe("b1");
    expect(phaseBase(steps, "P2")).toBe("other");
    expect(phaseBase(steps, "P3")).toBeNull();
  });

  it("phaseBase ignores non task/batch entries and end edges", () => {
    const steps = [
      stepEvent(entry({ id: "i-1", kind: "revert", baseHead: "r" })),
      stepEvent(entry({ id: "i-2", kind: "task", baseHead: "t" }), { edge: "end", result: "ok" }),
    ];
    expect(phaseBase(steps, "P1")).toBeNull();
  });

  it("phaseBase keeps the lowest seq even when the history is not in seq order", () => {
    const late = stepEvent(entry({ id: "i-1", kind: "task", baseHead: "late" }));
    const early = stepEvent(entry({ id: "i-2", kind: "task", baseHead: "early" }));
    expect(phaseBase([late, early], "P1")).toBe("late"); // seqCounter: late < early
    expect(phaseBase([{ ...early, seq: 1 }, { ...late, seq: 5 }], "P1")).toBe("early");
    expect(phaseBase([{ ...late, seq: 5 }, { ...early, seq: 1 }], "P1")).toBe("early");
  });

  it("latestStartDetail is null when the newest start edge carries no parsable detail", () => {
    const e = entry({ id: "i-7" });
    const steps = [stepEvent(e, { detail: JSON.stringify({ v: 1, n: 1 }) }), stepEvent(e, { detail: "not json" })];
    expect(latestStartDetail(steps, "i-7")).toBeNull();
  });

  it("latestStartDetail returns the parsed detail of the newest start edge of the entry", () => {
    const e = entry({ id: "i-5" });
    const steps = [
      stepEvent(e, { detail: JSON.stringify({ v: 1, n: 1 }) }),
      stepEvent(e, { edge: "end", result: "ok", detail: JSON.stringify({ v: 1, n: 2 }) }),
      stepEvent(e, { step: "checks", detail: JSON.stringify({ v: 1, n: 3 }) }),
      stepEvent(entry({ id: "i-6" }), { detail: JSON.stringify({ v: 1, n: 4 }) }),
    ];
    expect(latestStartDetail(steps, "i-5")).toEqual({ v: 1, n: 3 });
    expect(latestStartDetail(steps, "i-none")).toBeNull();
  });
});

describe("pickBatch (M16, A1-8) and phaseIntegrated (M20)", () => {
  function ledgerWith(states: Record<string, { state: TaskState; phase?: string; branch?: string | null }>, batchMax = 4): LedgerV1 {
    const l = buildDraft(0);
    l.config.batchMax = batchMax;
    l.phases.push({ id: "p2", title: "Phase 2", wave: "w1", dependsOn: [], gate: "pending", qaRound: 1, paused: false, tag: null });
    for (const [id, s] of Object.entries(states)) {
      l.tasks[id] = taskNode(id, { state: s.state, phase: s.phase ?? "p1", branch: s.branch === undefined ? `b-${id}` : s.branch, slot: `s-${id}` });
    }
    return l;
  }

  it("is empty when nothing is dequeueable", () => {
    const l = ledgerWith({ A: { state: "running" } });
    expect(pickBatch(l, ["A", "missing"], 4)).toEqual([]);
    expect(pickBatch(l, [], 4)).toEqual([]);
  });

  it("a single dequeueable task never waits for a batch to fill", () => {
    const l = ledgerWith({ A: { state: "verified" } });
    expect(pickBatch(l, ["A"], 4)).toEqual(["A"]);
  });

  it("batches the following dequeueable tasks of the same phase up to batchMax, in queue order", () => {
    const l = ledgerWith({ A: { state: "verified" }, B: { state: "verified" }, C: { state: "verified" }, D: { state: "verified" },
      E: { state: "verified" } });
    expect(pickBatch(l, ["A", "B", "C", "D", "E"], 4)).toEqual(["A", "B", "C", "D"]);
    expect(pickBatch(l, ["A", "B", "C", "D", "E"], 2)).toEqual(["A", "B"]);
  });

  it("batchMax = 1 disables batching", () => {
    const l = ledgerWith({ A: { state: "verified" }, B: { state: "verified" } }, 1);
    expect(pickBatch(l, ["A", "B"], 1)).toEqual(["A"]);
  });

  it("does not mix phases and skips non-verified, branchless and paused-phase tasks", () => {
    const l = ledgerWith({ A: { state: "verified" }, B: { state: "verified", phase: "p2" }, C: { state: "integrating" },
      D: { state: "verified", branch: null }, E: { state: "verified" } });
    expect(pickBatch(l, ["A", "B", "C", "D", "E"], 4)).toEqual(["A", "E"]);
    const p1 = l.phases.find(p => p.id === "p1");
    if (p1 === undefined) throw new Error("phase p1");
    p1.paused = true;
    expect(pickBatch(l, ["A", "B", "C", "D", "E"], 4)).toEqual(["B"]);
  });

  it("batchMax below 1 or fractional is floored and clamped to at least 1", () => {
    const l = ledgerWith({ A: { state: "verified" }, B: { state: "verified" }, C: { state: "verified" } });
    expect(pickBatch(l, ["A", "B", "C"], 0)).toEqual(["A"]);
    expect(pickBatch(l, ["A", "B", "C"], 2.9)).toEqual(["A", "B"]);
  });

  it("tasks outside any phase batch together and are never held by a paused phase", () => {
    const l = ledgerWith({ A: { state: "verified" }, B: { state: "verified" }, C: { state: "verified" } });
    for (const id of ["A", "B"]) { const t = l.tasks[id]; if (t !== undefined) t.phase = null; }
    const p1 = l.phases.find(p => p.id === "p1");
    if (p1 === undefined) throw new Error("phase p1");
    p1.paused = true;
    expect(pickBatch(l, ["A", "C", "B"], 4)).toEqual(["A", "B"]);
  });

  it("a phase with no non-qa task is integrated once every phase it depends on is; a dependency cycle never is (QA-3.2-19)", () => {
    const l = ledgerWith({ A: { state: "verified" } });
    l.tasks.Q = taskNode("Q", { state: "pending", kind: "qa", phase: "p2" });
    const p2 = l.phases.find(p => p.id === "p2");
    if (p2 === undefined) throw new Error("phase p2");
    p2.dependsOn = ["p1"];
    expect(phaseHasOwnTasks(l, "p2")).toBe(false);
    expect(phaseHasOwnTasks(l, "p1")).toBe(true);
    expect(phaseIntegrated(l, "p2")).toBe(false); // p1's A is only verified
    l.tasks.A = taskNode("A", { state: "integrated", phase: "p1", integrated: { from: "a".repeat(40), to: "b".repeat(40) } });
    expect(phaseIntegrated(l, "p2")).toBe(true);
    l.phases.push({ id: "p3", title: "Phase 3", wave: "w1", dependsOn: ["p4"], gate: "pending", qaRound: 1, paused: false, tag: null },
      { id: "p4", title: "Phase 4", wave: "w1", dependsOn: ["p3"], gate: "pending", qaRound: 1, paused: false, tag: null });
    expect(phaseIntegrated(l, "p3")).toBe(false);
  });

  it("dependentPhases lists the transitive dependents once, in plan order, without the inputs", () => {
    const l = ledgerWith({});
    const p2 = l.phases.find(p => p.id === "p2");
    if (p2 === undefined) throw new Error("phase p2");
    p2.dependsOn = ["p1"];
    l.phases.push({ id: "p3", title: "Phase 3", wave: "w1", dependsOn: ["p2", "p1"], gate: "pending", qaRound: 1, paused: false, tag: null },
      { id: "p4", title: "Phase 4", wave: "w1", dependsOn: [], gate: "pending", qaRound: 1, paused: false, tag: null });
    expect(dependentPhases(l, ["p1"])).toEqual(["p2", "p3"]);
    expect(dependentPhases(l, ["p2"])).toEqual(["p3"]);
    expect(dependentPhases(l, ["p4"])).toEqual([]);
    expect(dependentPhases(l, [])).toEqual([]);
  });

  it("phaseIntegrated needs every non-qa task integrated, done or cancelled", () => {
    const l = ledgerWith({ A: { state: "integrated" }, B: { state: "cancelled" }, C: { state: "done" } });
    expect(phaseIntegrated(l, "p1")).toBe(true);
    l.tasks.D = taskNode("D", { state: "verified" });
    expect(phaseIntegrated(l, "p1")).toBe(false);
    l.tasks.D = taskNode("D", { state: "pending", kind: "qa" });
    expect(phaseIntegrated(l, "p1")).toBe(true);
    expect(phaseIntegrated(l, "p2")).toBe(true); // a known phase with no tasks
    expect(phaseIntegrated(l, "nope")).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Test doubles (listener, leases, logger, write guard, lander)
// ---------------------------------------------------------------------------------------------------------------

class ListenerSpy implements IntegrationListener {
  readonly calls: string[] = [];
  readonly inbox: InboxItem[] = [];
  onIntegrated(id: string): void { this.calls.push(`integrated:${id}`); }
  onConflict(id: string): void { this.calls.push(`conflict:${id}`); }
  onFailed(id: string): void { this.calls.push(`failed:${id}`); }
  onReverted(id: string): void { this.calls.push(`reverted:${id}`); }
  onGate(p: string, gate: GateState): void { this.calls.push(`gate:${p}:${gate}`); }
  onInbox(item: InboxItem): void { this.inbox.push(item); this.calls.push(`inbox:${item.id}`); }
}

class LeaseSpy implements LeaseService {
  readonly planId = "plan-one";
  readonly released: string[] = [];
  holder(): null { return null; }
  acquireTask(): { ok: true } { return { ok: true }; }
  releaseTask(id: string): void { this.released.push(id); }
  rebuild(): [] { return []; }
}

class LoggerSpy implements Logger {
  readonly warnings: string[] = [];
  warn(m: string): void { this.warnings.push(m); }
}

/** Write guard that records every git-write cwd with its purpose (I4/I5 evidence) and can refuse. */
class GuardSpy implements WriteGuard {
  readonly calls: Array<{ cwd: string; purpose: WritePurpose }> = [];
  async assertWriteCwd(cwd: string, purpose: WritePurpose): Promise<void> {
    this.calls.push({ cwd, purpose });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// M5: repo lock (I3)
// ---------------------------------------------------------------------------------------------------------------

const lockRoots: string[] = [];
afterEach(async () => {
  for (const r of lockRoots.splice(0)) await removeDirWhenReleased(r, { deadlineMs: 20_000 });
});

async function lockEnv(): Promise<{ root: string; file(repoKey: string): string }> {
  const root = await mkdtemp(join(tmpdir(), "omr-integrate-lock-"));
  lockRoots.push(root);
  return {
    root,
    file: key => join(root, "repos", createHash("sha256").update(key, "utf8").digest("hex"), "integration.lock"),
  };
}

function holder(entryId: string | null = null): { planId: string; entryId: string | null } {
  return { planId: "plan-one", entryId };
}

describe("createRepoLockFactory: round-2 paths (side files, wait report, verify)", () => {
  async function writeLock(env: { file(repoKey: string): string }, key: string, content: string): Promise<string> {
    const file = env.file(key);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
    return file;
  }
  const exists = (p: string): Promise<boolean> => readFile(p, "utf8").then(() => true, () => false);
  async function waitFor(pred: () => boolean): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (!pred() && Date.now() < deadline) await realPause(5);
  }

  it("acquire removes crashed side files of its own pid and of dead same-host pids, and keeps the rest", async () => {
    const env = await lockEnv();
    const file = env.file("repo-side");
    await mkdir(dirname(file), { recursive: true });
    const names = {
      ownTmp: `${file}.10.1.aa.tmp`, deadStale: `${file}.99.2.bb.stale`, liveTmp: `${file}.77.3.cc.tmp`,
      notPid: `${file}.xyz.4.dd.tmp`, otherSuffix: `${file}.99.5.ee.bak`,
    };
    for (const n of Object.values(names)) await writeFile(n, "x", "utf8");
    const f = createRepoLockFactory({ stateRoot: env.root, clock: new FakeClock(), pid: 10, hostname: "h", isPidAlive: pid => pid === 77 });
    const lock = await f.acquire("repo-side", holder(), new AbortController().signal);
    expect(await exists(names.ownTmp)).toBe(false);
    expect(await exists(names.deadStale)).toBe(false);
    expect(await exists(names.liveTmp)).toBe(true);
    expect(await exists(names.notPid)).toBe(true);
    expect(await exists(names.otherSuffix)).toBe(true);
    await lock.release();
  });

  it("an unparsable holder is reported once (no pid, host or age) and taken over as stale at the second poll", async () => {
    const env = await lockEnv();
    const clock = new FakeClock();
    await writeLock(env, "repo-garbage", "{{ not json");
    const reports: Array<Record<string, unknown>> = [];
    const f = createRepoLockFactory({ stateRoot: env.root, clock, pid: 10, hostname: "h", isPidAlive: () => true, waitReportMs: 0 });
    const acquiring = f.acquire("repo-garbage", holder(), new AbortController().signal, r => { reports.push({ ...r }); });
    await waitFor(() => reports.length > 0 && clock.heldCount() > 0);
    expect(reports).toEqual([expect.objectContaining({ pid: null, hostname: null, planId: null, heartbeatAgeMs: null })]);
    clock.fire(); // the poll sleep: same bytes, same verdict -> compare-and-delete, then create
    const lock = await acquiring;
    expect((lock as RepoLockWithTakeover).takeover).toBe("stale");
    expect(reports).toHaveLength(1);
    expect(JSON.parse(await readFile(env.file("repo-garbage"), "utf8"))).toMatchObject({ pid: 10 });
    await lock.release();
  });

  it("a wait report that throws never breaks the wait; the lock is taken once the holder is gone", async () => {
    const env = await lockEnv();
    const clock = new FakeClock();
    const file = await writeLock(env, "repo-report", JSON.stringify({ pid: 99, hostname: "elsewhere", planId: "other", entryId: "i-4", heartbeatAt: clock.now() }));
    const reports: Array<Record<string, unknown>> = [];
    const f = createRepoLockFactory({ stateRoot: env.root, clock, pid: 10, hostname: "h", isPidAlive: () => true, waitReportMs: 0 });
    const acquiring = f.acquire("repo-report", holder(), new AbortController().signal, r => {
      reports.push({ ...r });
      throw new Error("report sink down");
    });
    await waitFor(() => reports.length > 0 && clock.heldCount() > 0);
    await unlink(file);
    clock.fire();
    const lock = await acquiring;
    expect(reports).toEqual([expect.objectContaining({ pid: 99, hostname: "elsewhere", planId: "other", heartbeatAgeMs: 0 })]);
    expect((lock as RepoLockWithTakeover).takeover).toBeNull();
    await lock.release();
  });

  it("verify(): true while the file is ours; false and lost once it is gone; false after release", async () => {
    const env = await lockEnv();
    const f = createRepoLockFactory({ stateRoot: env.root, clock: new FakeClock(), pid: 10, hostname: "h", isPidAlive: () => true });
    const lock = await f.acquire("repo-verify", holder(), new AbortController().signal);
    expect(await lock.verify?.()).toBe(true);
    expect(lock.lost.aborted).toBe(false);
    await unlink(env.file("repo-verify"));
    expect(await lock.verify?.()).toBe(false);
    expect(lock.lost.aborted).toBe(true);
    expect(await lock.verify?.()).toBe(false); // already lost: no read
    await lock.release();
    const other = await f.acquire("repo-verify-2", holder(), new AbortController().signal);
    await other.release();
    expect(await other.verify?.()).toBe(false);
    expect(other.lost.aborted).toBe(false);
  });

  it("verify(): a lock file rewritten with another token is a loss; an unreadable one is not", async () => {
    const env = await lockEnv();
    const clock = new FakeClock();
    const f = createRepoLockFactory({ stateRoot: env.root, clock, pid: 10, hostname: "h", isPidAlive: () => true });
    const a = await f.acquire("repo-token", holder(), new AbortController().signal);
    const fileA = env.file("repo-token");
    const mine = JSON.parse(await readFile(fileA, "utf8")) as Record<string, unknown>;
    await writeFile(fileA, JSON.stringify({ ...mine, token: "someone-else" }), "utf8");
    expect(await a.verify?.()).toBe(false);
    expect(a.lost.aborted).toBe(true);
    await a.release();
    expect(JSON.parse(await readFile(fileA, "utf8"))).toMatchObject({ token: "someone-else" }); // not ours: left alone
    const b = await f.acquire("repo-dir", holder(), new AbortController().signal);
    const fileB = env.file("repo-dir");
    await unlink(fileB);
    await mkdir(fileB); // reads now fail with EISDIR: not proof of a loss
    expect(await b.verify?.()).toBe(true);
    expect(b.lost.aborted).toBe(false);
    await b.release();
  });
});

describe("createRepoLockFactory (M5, I3)", () => {
  it("acquire writes the lock file and release removes it", async () => {
    const env = await lockEnv();
    const factory = createRepoLockFactory({ stateRoot: env.root, clock: new FakeClock(), pid: 10, hostname: "h", isPidAlive: () => true });
    const lock = await factory.acquire("repo-A", holder("i-1"), new AbortController().signal);
    const content = JSON.parse(await readFile(env.file("repo-A"), "utf8")) as { pid: number; hostname: string; entryId: string | null };
    expect(content).toMatchObject({ pid: 10, hostname: "h", entryId: "i-1" });
    expect(lock.lost.aborted).toBe(false);
    await lock.release();
    await expect(readFile(env.file("repo-A"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await lock.release(); // idempotent
  });

  it("two factories on one repo.key serialize: the mutex is never re-entered (I3)", async () => {
    const env = await lockEnv();
    const clock = new FakeClock();
    const a = createRepoLockFactory({ stateRoot: env.root, clock, pid: 10, hostname: "h", isPidAlive: () => true });
    const b = createRepoLockFactory({ stateRoot: env.root, clock, pid: 10, hostname: "h", isPidAlive: () => true });
    const events: string[] = [];
    let inside = 0;
    let maxInside = 0;
    const run = async (name: string, f: typeof a): Promise<void> => {
      const lock = await f.acquire("repo-B", holder(), new AbortController().signal);
      inside++;
      maxInside = Math.max(maxInside, inside);
      events.push(`${name}:in`);
      await Promise.resolve();
      await Promise.resolve();
      events.push(`${name}:out`);
      inside--;
      await lock.release();
    };
    await Promise.all([run("a", a), run("b", b)]);
    expect(maxInside).toBe(1);
    expect(events).toEqual(["a:in", "a:out", "b:in", "b:out"]);
  });

  it("different repo keys do not block each other", async () => {
    const env = await lockEnv();
    const f = createRepoLockFactory({ stateRoot: env.root, clock: new FakeClock(), pid: 10, hostname: "h", isPidAlive: () => true });
    const l1 = await f.acquire("k1", holder(), new AbortController().signal);
    const l2 = await f.acquire("k2", holder(), new AbortController().signal);
    await l1.release();
    await l2.release();
  });

  /** Acquires while firing the poll timer: a takeover needs the same verdict at two polls (QA-3.2-4). Returns the polls fired. */
  async function acquirePolling(f: RepoLockFactory, key: string, clock: FakeClock, h = holder()): Promise<{ lock: RepoLock; fired: number }> {
    let done = false;
    let fired = 0;
    const p = f.acquire(key, h, new AbortController().signal).finally(() => { done = true; });
    const deadline = Date.now() + 20_000;
    while (!done && Date.now() < deadline) {
      await realPause(5);
      if (!done && clock.heldCount() > 0) {
        fired++;
        clock.fire();
      }
    }
    return { lock: await p, fired };
  }

  it("takes over a lock file of a dead pid on the same host (counter reason dead-pid) after a second poll", async () => {
    const env = await lockEnv();
    const file = env.file("repo-C");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ pid: 99, hostname: "h", planId: "other", entryId: null, heartbeatAt: new FakeClock().now() }), "utf8");
    const clock = new FakeClock();
    const factory = createRepoLockFactory({ stateRoot: env.root, clock, pid: 10, hostname: "h", isPidAlive: pid => pid !== 99 });
    const { lock, fired } = await acquirePolling(factory, "repo-C", clock);
    expect(fired).toBeGreaterThanOrEqual(1);
    expect((lock as { takeover?: string | null }).takeover).toBe("dead-pid");
    const content = JSON.parse(await readFile(file, "utf8")) as { pid: number };
    expect(content.pid).toBe(10);
    await lock.release();
  });

  it("takes over a stale lock of a live holder on another host (counter reason stale) after a second poll", async () => {
    const env = await lockEnv();
    const file = env.file("repo-D");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ pid: 99, hostname: "elsewhere", planId: "other", entryId: null, heartbeatAt: new FakeClock().now() }), "utf8");
    const clock = new FakeClock();
    const factory = createRepoLockFactory({ stateRoot: env.root, clock, pid: 10, hostname: "h", isPidAlive: () => true, staleMs: -1 });
    const { lock } = await acquirePolling(factory, "repo-D", clock);
    expect((lock as { takeover?: string | null }).takeover).toBe("stale");
    await lock.release();
  });

  it("QA-3.2-4: a live holder on the same host is never taken over, however old its heartbeat", async () => {
    const env = await lockEnv();
    const clock = new FakeClock();
    await foreignLock(env, "repo-live", JSON.stringify({ pid: 99, hostname: "h", planId: "other", entryId: null, heartbeatAt: clock.now() - 10_000_000 }));
    const f = createRepoLockFactory({ stateRoot: env.root, clock, pid: 10, hostname: "h", isPidAlive: () => true, staleMs: 1 });
    const ctl = new AbortController();
    let settled = false;
    const waiting = f.acquire("repo-live", holder(), ctl.signal);
    void waiting.then(() => { settled = true; }, () => { settled = true; });
    for (let i = 0; i < 4; i++) {
      await realPause(20);
      clock.advance(1_000);
      clock.fire();
    }
    await realPause(20);
    expect(settled).toBe(false);
    ctl.abort();
    await expect(waiting).rejects.toMatchObject({ code: "E_DISPOSED" });
    expect(JSON.parse(await readFile(env.file("repo-live"), "utf8"))).toMatchObject({ pid: 99 });
  });

  it("QA-3.2-4: our own pid in a leftover file (this process holds the mutex) is a dead holder", async () => {
    const env = await lockEnv();
    const clock = new FakeClock();
    await foreignLock(env, "repo-own", JSON.stringify({ pid: 10, hostname: "h", planId: "old", entryId: null, heartbeatAt: clock.now() }));
    const f = createRepoLockFactory({ stateRoot: env.root, clock, pid: 10, hostname: "h", isPidAlive: () => true });
    const { lock } = await acquirePolling(f, "repo-own", clock);
    expect((lock as { takeover?: string | null }).takeover).toBe("dead-pid");
    await lock.release();
  });

  it("QA-3.2-4: a stale holder that heartbeats between the two polls is not taken over", async () => {
    const env = await lockEnv();
    const clock = new FakeClock();
    const file = await foreignLock(env, "repo-beat", JSON.stringify({ pid: 99, hostname: "elsewhere", planId: "o", entryId: null, heartbeatAt: 1 }));
    const f = createRepoLockFactory({ stateRoot: env.root, clock, pid: 10, hostname: "h", isPidAlive: () => true, staleMs: 1 });
    const ctl = new AbortController();
    let settled = false;
    const waiting = f.acquire("repo-beat", holder(), ctl.signal);
    void waiting.then(() => { settled = true; }, () => { settled = true; });
    await realPause(30);
    // The holder beats (new bytes): the first poll's verdict does not carry over, the next poll starts again.
    await writeFile(file, JSON.stringify({ pid: 99, hostname: "elsewhere", planId: "o", entryId: null, heartbeatAt: 2 }), "utf8");
    clock.fire();
    await realPause(30);
    expect(settled).toBe(false);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ heartbeatAt: 2 });
    ctl.abort();
    await expect(waiting).rejects.toMatchObject({ code: "E_DISPOSED" });
  });

  it("QA-3.2-4: a taker never removes a lock another taker created after its judgement (compare-and-delete)", async () => {
    const env = await lockEnv();
    const clock = new FakeClock();
    const file = await foreignLock(env, "repo-race", JSON.stringify({ pid: 99, hostname: "h", planId: "o", entryId: null, heartbeatAt: 1 }));
    const winner = JSON.stringify({ pid: 55, hostname: "h", planId: "w", entryId: "i-w", heartbeatAt: 2 });
    let asked = 0;
    const f = createRepoLockFactory({ stateRoot: env.root, clock, pid: 10, hostname: "h", isPidAlive: pid => {
      if (pid !== 99) return true;
      // Second judgement of the dead holder: another process takes the lock over right now (new bytes, live pid 55).
      if (++asked === 2) writeFileSync(file, winner, "utf8");
      return false;
    } });
    const ctl = new AbortController();
    let settled = false;
    const waiting = f.acquire("repo-race", holder(), ctl.signal);
    void waiting.then(() => { settled = true; }, () => { settled = true; });
    for (let i = 0; i < 3; i++) {
      await realPause(30);
      clock.fire();
    }
    await realPause(30);
    expect(asked).toBeGreaterThanOrEqual(2);
    expect(settled).toBe(false);
    expect(await readFile(file, "utf8")).toBe(winner);
    ctl.abort();
    await expect(waiting).rejects.toMatchObject({ code: "E_DISPOSED" });
    expect(await readFile(file, "utf8")).toBe(winner);
  });

  it("an aborted wait rejects with E_DISPOSED and leaves the holder alone", async () => {
    const env = await lockEnv();
    const f = createRepoLockFactory({ stateRoot: env.root, clock: new FakeClock(), pid: 10, hostname: "h", isPidAlive: () => true });
    const first = await f.acquire("repo-E", holder(), new AbortController().signal);
    const ctl = new AbortController();
    const waiting = f.acquire("repo-E", holder(), ctl.signal);
    ctl.abort();
    await expect(waiting).rejects.toMatchObject({ code: "E_DISPOSED" });
    await first.release();
    // the key is free again
    const again = await f.acquire("repo-E", holder(), new AbortController().signal);
    await again.release();
  });

  async function foreignLock(env: { file(repoKey: string): string }, key: string, content: string): Promise<string> {
    const file = env.file(key);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
    return file;
  }

  it("a live foreign holder is waited for; aborting the wait rejects with E_DISPOSED and frees the mutex", async () => {
    const env = await lockEnv();
    const clock = new FakeClock();
    await foreignLock(env, "repo-F", JSON.stringify({ pid: 99, hostname: "elsewhere", planId: "other", entryId: null, heartbeatAt: clock.now() }));
    const f = createRepoLockFactory({ stateRoot: env.root, clock, pid: 10, hostname: "h", isPidAlive: () => true });
    const ctl = new AbortController();
    const waiting = f.acquire("repo-F", holder(), ctl.signal);
    let settled = false;
    void waiting.then(() => { settled = true; }, () => { settled = true; });
    await realPause(30);
    expect(settled).toBe(false);
    ctl.abort();
    await expect(waiting).rejects.toMatchObject({ code: "E_DISPOSED" });
    // the in-process mutex was released: a second attempt reaches the file again instead of queueing behind the first
    const ctl2 = new AbortController();
    const second = f.acquire("repo-F", holder(), ctl2.signal);
    await realPause(30);
    ctl2.abort();
    await expect(second).rejects.toMatchObject({ code: "E_DISPOSED" });
  });

  it("a waiter retries after its timer fires and takes the file once the holder removed it", async () => {
    const env = await lockEnv();
    const clock = new FakeClock();
    const file = await foreignLock(env, "repo-G", JSON.stringify({ pid: 99, hostname: "elsewhere", planId: "other", entryId: null, heartbeatAt: clock.now() }));
    const f = createRepoLockFactory({ stateRoot: env.root, clock, pid: 10, hostname: "h", isPidAlive: () => true });
    const waiting = f.acquire("repo-G", holder("i-7"), new AbortController().signal);
    await realPause(30);
    await unlink(file);
    clock.fire();
    const lock = await waiting;
    expect((lock as { takeover?: string | null }).takeover).toBeNull();
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ pid: 10, entryId: "i-7" });
    await lock.release();
  });

  it("QA-3.2-4: one unparsable read is never a takeover; a file that stays unparsable across two polls is taken over as stale", async () => {
    const env = await lockEnv();
    const clock = new FakeClock();
    const file = await foreignLock(env, "repo-H", "{{ not json");
    const f = createRepoLockFactory({ stateRoot: env.root, clock, pid: 10, hostname: "h", isPidAlive: () => true });
    let settled = false;
    const waiting = f.acquire("repo-H", holder(), new AbortController().signal);
    void waiting.then(() => { settled = true; }, () => { settled = true; });
    await realPause(30);
    expect(settled).toBe(false); // the first poll only notes it
    expect(await readFile(file, "utf8")).toBe("{{ not json");
    clock.fire();
    const lock = await waiting;
    expect((lock as { takeover?: string | null }).takeover).toBe("stale");
    await lock.release();
  });

  it("QA-3.2-4: an unparsable read that a writer completes before the next poll is waited for, not taken over", async () => {
    const env = await lockEnv();
    const clock = new FakeClock();
    const file = await foreignLock(env, "repo-H2", "");
    const f = createRepoLockFactory({ stateRoot: env.root, clock, pid: 10, hostname: "h", isPidAlive: () => true });
    const ctl = new AbortController();
    let settled = false;
    const waiting = f.acquire("repo-H2", holder(), ctl.signal);
    void waiting.then(() => { settled = true; }, () => { settled = true; });
    await realPause(30);
    await writeFile(file, JSON.stringify({ pid: 99, hostname: "h", planId: "o", entryId: null, heartbeatAt: clock.now() }), "utf8");
    clock.fire();
    await realPause(30);
    expect(settled).toBe(false);
    ctl.abort();
    await expect(waiting).rejects.toMatchObject({ code: "E_DISPOSED" });
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ pid: 99 });
  });

  it("lock files that parse to the wrong shape are taken over as stale once they stay so at the next poll", async () => {
    const env = await lockEnv();
    const clock = new FakeClock();
    const f = createRepoLockFactory({ stateRoot: env.root, clock, pid: 10, hostname: "h", isPidAlive: () => true });
    for (const [i, text] of ["null", JSON.stringify({ pid: "x", hostname: "h", heartbeatAt: 1 }), JSON.stringify({ pid: 1, hostname: 2, heartbeatAt: 1 })].entries()) {
      await foreignLock(env, `repo-shape-${i}`, text);
      const { lock } = await acquirePolling(f, `repo-shape-${i}`, clock);
      expect((lock as { takeover?: string | null }).takeover).toBe("stale");
      await lock.release();
    }
  });

  it("an lock file without planId and entryId still parses; a live same-host foreign pid is waited for", async () => {
    const env = await lockEnv();
    const clock = new FakeClock();
    await foreignLock(env, "repo-I", JSON.stringify({ pid: 99, hostname: "h", heartbeatAt: clock.now() }));
    const f = createRepoLockFactory({ stateRoot: env.root, clock, pid: 10, hostname: "h", isPidAlive: () => true });
    const ctl = new AbortController();
    const waiting = f.acquire("repo-I", holder(), ctl.signal);
    await realPause(30);
    ctl.abort();
    await expect(waiting).rejects.toMatchObject({ code: "E_DISPOSED" });
  });

  it("a filesystem error other than EEXIST rejects and frees the mutex", async () => {
    const env = await lockEnv();
    await writeFile(join(env.root, "repos"), "not a directory", "utf8");
    const f = createRepoLockFactory({ stateRoot: env.root, clock: new FakeClock(), pid: 10, hostname: "h", isPidAlive: () => true });
    await expect(f.acquire("repo-J", holder(), new AbortController().signal)).rejects.toThrow();
    const other = await lockEnv();
    const g = createRepoLockFactory({ stateRoot: other.root, clock: new FakeClock(), pid: 10, hostname: "h", isPidAlive: () => true });
    const lock = await g.acquire("repo-J", holder(), new AbortController().signal);
    await lock.release();
  });

  it("release leaves a lock file that now belongs to another holder, and still frees the mutex", async () => {
    const env = await lockEnv();
    const clock = new FakeClock();
    const f = createRepoLockFactory({ stateRoot: env.root, clock, pid: 10, hostname: "h", isPidAlive: () => true });
    const lock = await f.acquire("repo-K", holder(), new AbortController().signal);
    const file = env.file("repo-K");
    await writeFile(file, JSON.stringify({ pid: 77, hostname: "h", planId: "x", entryId: null, heartbeatAt: clock.now() }), "utf8");
    await lock.release();
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ pid: 77 });
    await unlink(file);
    const again = await f.acquire("repo-K", holder(), new AbortController().signal);
    await again.release();
  });

  it("release tolerates a lock file that is already gone", async () => {
    const env = await lockEnv();
    const f = createRepoLockFactory({ stateRoot: env.root, clock: new FakeClock(), pid: 10, hostname: "h", isPidAlive: () => true });
    const lock = await f.acquire("repo-L", holder(), new AbortController().signal);
    await unlink(env.file("repo-L"));
    await expect(lock.release()).resolves.toBeUndefined();
    const again = await f.acquire("repo-L", holder(), new AbortController().signal);
    await again.release();
  });

  /**
   * Reads the lock file's heartbeatAt. The heartbeat renames a complete side file over the lock (QA-3.2-4), so a read never
   * sees it partial; the retry only rides out a transient sharing error of the rename on Windows.
   */
  async function heartbeatOf(file: string): Promise<number> {
    for (let i = 0; i < 400; i++) {
      try {
        return (JSON.parse(await readFile(file, "utf8")) as { heartbeatAt: number }).heartbeatAt;
      } catch {
        await realPause(5);
      }
    }
    throw new Error("the lock file never parsed");
  }

  it("the heartbeat timer refreshes heartbeatAt and re-arms itself; release disarms it", async () => {
    const env = await lockEnv();
    const clock = new FakeClock();
    const f = createRepoLockFactory({ stateRoot: env.root, clock, pid: 10, hostname: "h", isPidAlive: () => true });
    const lock = await f.acquire("repo-M", holder("i-3"), new AbortController().signal);
    const file = env.file("repo-M");
    const first = await heartbeatOf(file);
    expect(clock.heldCount()).toBe(1);
    clock.advance(5_000);
    clock.fire();
    const deadline = Date.now() + 20_000;
    while (await heartbeatOf(file) === first && Date.now() < deadline) await realPause(5);
    expect(await heartbeatOf(file)).toBe(first + 5_000);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ pid: 10, entryId: "i-3" });
    while (clock.heldCount() === 0 && Date.now() < deadline) await realPause(5);
    expect(clock.heldCount()).toBe(1);
    expect(lock.lost.aborted).toBe(false);
    await lock.release();
    expect(clock.heldCount()).toBe(0);
  });

  it("a heartbeat that finds the file owned by another process marks the lock lost and stops beating", async () => {
    const env = await lockEnv();
    const clock = new FakeClock();
    const f = createRepoLockFactory({ stateRoot: env.root, clock, pid: 10, hostname: "h", isPidAlive: () => true });
    const lock = await f.acquire("repo-N", holder(), new AbortController().signal);
    await writeFile(env.file("repo-N"), JSON.stringify({ pid: 77, hostname: "h", planId: "x", entryId: null, heartbeatAt: clock.now() }), "utf8");
    clock.fire();
    const deadline = Date.now() + 20_000;
    while (!lock.lost.aborted && Date.now() < deadline) await realPause(5);
    expect(lock.lost.aborted).toBe(true);
    expect(clock.heldCount()).toBe(0);
    await lock.release();
  });

  it("a heartbeat that cannot read the file (removed under it) marks the lock lost", async () => {
    const env = await lockEnv();
    const clock = new FakeClock();
    const f = createRepoLockFactory({ stateRoot: env.root, clock, pid: 10, hostname: "h", isPidAlive: () => true });
    const lock = await f.acquire("repo-O", holder(), new AbortController().signal);
    await unlink(env.file("repo-O"));
    clock.fire();
    const deadline = Date.now() + 20_000;
    while (!lock.lost.aborted && Date.now() < deadline) await realPause(5);
    expect(lock.lost.aborted).toBe(true);
    await lock.release();
  });

  it("a re-armed heartbeat keeps beating on every period", async () => {
    const env = await lockEnv();
    const clock = new FakeClock();
    const f = createRepoLockFactory({ stateRoot: env.root, clock, pid: 10, hostname: "h", isPidAlive: () => true });
    const lock = await f.acquire("repo-S", holder(), new AbortController().signal);
    const file = env.file("repo-S");
    const t0 = await heartbeatOf(file);
    const deadline = Date.now() + 20_000;
    for (const k of [1, 2]) {
      clock.advance(1_000);
      clock.fire();
      while (await heartbeatOf(file) !== t0 + 1_000 * k && Date.now() < deadline) await realPause(5);
      expect(await heartbeatOf(file)).toBe(t0 + 1_000 * k);
      while (clock.heldCount() === 0 && Date.now() < deadline) await realPause(5);
      expect(clock.heldCount()).toBe(1);
    }
    expect(lock.lost.aborted).toBe(false);
    await lock.release();
  });

  it("a heartbeat that fires in the same tick as release does nothing", async () => {
    const env = await lockEnv();
    const clock = new FakeClock();
    const f = createRepoLockFactory({ stateRoot: env.root, clock, pid: 10, hostname: "h", isPidAlive: () => true });
    const box: { lock: RepoLock | null; releasing: Promise<void> | null } = { lock: null, releasing: null };
    // Held before the lock's own heartbeat, so fire() runs it first: the beat that follows sees `released`.
    clock.setTimer(5_000, () => { box.releasing = box.lock?.release() ?? null; });
    box.lock = await f.acquire("repo-R", holder(), new AbortController().signal);
    clock.fire();
    await box.releasing;
    await realPause(20);
    await expect(readFile(env.file("repo-R"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(box.lock.lost.aborted).toBe(false);
    expect(clock.heldCount()).toBe(0);
  });

  it("a dead holder's file removed by someone else between the two polls: acquired without a takeover", async () => {
    const env = await lockEnv();
    const clock = new FakeClock();
    const file = await foreignLock(env, "repo-Q", JSON.stringify({ pid: 99, hostname: "h", planId: "x", entryId: null, heartbeatAt: clock.now() }));
    let asked = 0;
    const f = createRepoLockFactory({ stateRoot: env.root, clock, pid: 10, hostname: "h", isPidAlive: pid => {
      asked++;
      if (pid === 99 && asked === 1) unlinkSync(file); // the dead holder's file is removed by someone else first
      return pid !== 99;
    } });
    const { lock } = await acquirePolling(f, "repo-Q", clock, holder("i-2"));
    expect((lock as { takeover?: string | null }).takeover).toBeNull();
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ pid: 10, entryId: "i-2" });
    await lock.release();
  });

  it("the takeover's file vanishing between the second judgement and the rename is tolerated (no takeover counted)", async () => {
    const env = await lockEnv();
    const clock = new FakeClock();
    const file = await foreignLock(env, "repo-Q2", JSON.stringify({ pid: 99, hostname: "h", planId: "x", entryId: null, heartbeatAt: clock.now() }));
    let asked = 0;
    const f = createRepoLockFactory({ stateRoot: env.root, clock, pid: 10, hostname: "h", isPidAlive: pid => {
      if (pid === 99 && ++asked === 2) unlinkSync(file);
      return pid !== 99;
    } });
    const { lock } = await acquirePolling(f, "repo-Q2", clock, holder("i-3"));
    expect((lock as { takeover?: string | null }).takeover).toBeNull();
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ pid: 10, entryId: "i-3" });
    await lock.release();
  });

  it("a takeover rename that fails for another reason rejects, and a lock path that is a directory rejects the next acquire", async () => {
    const env = await lockEnv();
    const clock = new FakeClock();
    const file = await foreignLock(env, "repo-T", JSON.stringify({ pid: 99, hostname: "h", planId: "x", entryId: null, heartbeatAt: clock.now() }));
    let asked = 0;
    const f = createRepoLockFactory({ stateRoot: env.root, clock, pid: 10, hostname: "h", isPidAlive: pid => {
      if (pid === 99 && ++asked === 2) {
        unlinkSync(file);
        mkdirSync(file); // the path is now a directory: the takeover cannot move or read it, never ENOENT
      }
      return pid !== 99;
    } });
    const errP = f.acquire("repo-T", holder(), new AbortController().signal).then(() => null, (e: unknown) => e as { code?: string });
    await realPause(30);
    clock.fire();
    const err = await errP;
    expect(err?.code).toBeDefined();
    expect(err?.code).not.toBe("ENOENT");
    // the mutex was freed: the next acquire reaches the file, finds a directory it cannot read, and rejects too
    const again = await f.acquire("repo-T", holder(), new AbortController().signal).then(() => null, (e: unknown) => e as { code?: string });
    expect(again?.code).toBeDefined();
    expect(again?.code).not.toBe("ENOENT");
  });

  it("QA-3.2-27: a heartbeat interleaved with release() leaves no lock file (nor side file) behind", async () => {
    const env = await lockEnv();
    const clock = new FakeClock();
    const f = createRepoLockFactory({ stateRoot: env.root, clock, pid: 10, hostname: "h", isPidAlive: () => true });
    const file = env.file("repo-beat-release");
    for (let i = 0; i < 6; i++) {
      const lock = await f.acquire("repo-beat-release", holder(), new AbortController().signal);
      clock.fire(); // a beat starts: read, side file, rename
      for (let k = 0; k < i; k++) await Promise.resolve(); // release lands at a different point of the beat each round
      await lock.release(); // waits for that beat, then compare-and-delete
      await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readdir(dirname(file))).filter(n => n.endsWith(".tmp") || n.endsWith(".stale"))).toEqual([]);
    }
  });

  it("QA-3.2-33: a long wait is reported once with the holder's pid, host, plan, heartbeat age and the file", async () => {
    const env = await lockEnv();
    const clock = new FakeClock();
    const file = await foreignLock(env, "repo-wait", JSON.stringify({ pid: 99, hostname: "elsewhere", planId: "other", entryId: null, heartbeatAt: clock.now() }));
    const f = createRepoLockFactory({ stateRoot: env.root, clock, pid: 10, hostname: "h", isPidAlive: () => true, waitReportMs: 2_000 });
    const reports: LockWaitInfo[] = [];
    const ctl = new AbortController();
    const waiting = f.acquire("repo-wait", holder(), ctl.signal, info => { reports.push(info); });
    void waiting.catch(() => undefined);
    for (let i = 0; i < 6; i++) {
      await realPause(20);
      clock.advance(1_000);
      clock.fire();
    }
    await realPause(20);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ file, pid: 99, hostname: "elsewhere", planId: "other" });
    expect(reports[0]?.heartbeatAgeMs ?? 0).toBeGreaterThanOrEqual(2_000);
    ctl.abort();
    await expect(waiting).rejects.toMatchObject({ code: "E_DISPOSED" });
  });

  it("nit: crash-leftover side files of this pid or a dead pid are removed at acquire; a live pid's are kept", async () => {
    const env = await lockEnv();
    const file = env.file("repo-sides");
    await mkdir(dirname(file), { recursive: true });
    for (const side of [".10.1.aa.tmp", ".99.2.bb.stale", ".55.3.cc.tmp"]) await writeFile(file + side, "x", "utf8");
    const f = createRepoLockFactory({ stateRoot: env.root, clock: new FakeClock(), pid: 10, hostname: "h", isPidAlive: pid => pid === 55 });
    const lock = await f.acquire("repo-sides", holder(), new AbortController().signal);
    const left = (await readdir(dirname(file))).filter(n => n !== "integration.lock").sort();
    expect(left).toEqual(["integration.lock.55.3.cc.tmp"]);
    await lock.release();
  });

  it("release disarms the pending heartbeat timer", async () => {
    const env = await lockEnv();
    const clock = new FakeClock();
    const f = createRepoLockFactory({ stateRoot: env.root, clock, pid: 10, hostname: "h", isPidAlive: () => true });
    const lock = await f.acquire("repo-P", holder(), new AbortController().signal);
    expect(clock.heldCount()).toBe(1);
    await lock.release();
    expect(clock.heldCount()).toBe(0);
    clock.fire(); // nothing left to fire
    expect(lock.lost.aborted).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Harness: a simulated git world, the real 2.2 LedgerStore in a temp dir, doubles for everything else.
// Invariants I1-I5 are evaluated after EVERY appended batch (CrashWriter.append) and at the end of each test.
// ---------------------------------------------------------------------------------------------------------------

const TOPLEVEL = "C:/repo";
const WT = "C:/slots/integration";
const INT_REF = `refs/heads/omr/${PLAN_ID}/integration`;
const MAIN_REF = "refs/heads/main";
const hex = (n: number): string => n.toString(16).padStart(40, "0");
const slotPath = (slot: string): string => `C:/slots/${slot}`;

class CrashError extends Error {
  override readonly name = "CrashError" as const;
}

interface SimCommit { sha: string; parent: string | null; adds: string | null; removes: string | null }

class World {
  readonly base = hex(1);
  readonly commits = new Map<string, SimCommit>();
  readonly branches = new Map<string, string>();
  readonly slotCommit = new Map<string, string>();
  readonly passed = new Set<string>();
  readonly reflog: Array<{ from: string | null; to: string }> = [];
  readonly violations: string[] = [];
  readonly writes: Array<{ op: string; cwd: string }> = [];
  readonly checkLog: Array<{ candidate: string; slot: string; base: string; extraIds: string[] | null }> = [];
  readonly bad = new Set<string>();
  /** Every event durably appended by any process of this world, in order. */
  readonly journal: ExecutorEventInput[] = [];
  readonly conflictOnHead = new Set<string>();
  readonly conflictOnMate = new Set<string>();
  checkScript: CheckResult[] = [];
  checkGate: Promise<void> | null = null;
  afterCheck: (() => void) | null = null;
  iwtHead: string = this.base;
  landed = false;
  dead = false;
  crashAt: "before-branchForce" | "after-branchForce" | null = null;
  /** Crash only at the n-th (1-based) move of the integration branch. */
  crashOnForce: number | null = null;
  casFails = false;
  ffRefused = false;
  openStep: () => boolean = () => true;
  private counter = 100;

  constructor() {
    this.commits.set(this.base, { sha: this.base, parent: null, adds: null, removes: null });
    this.branches.set(INT_REF, this.base);
    this.branches.set(MAIN_REF, this.base);
  }

  commit(parent: string | null, adds: string | null, removes: string | null = null): SimCommit {
    const c: SimCommit = { sha: hex(++this.counter), parent, adds, removes };
    this.commits.set(c.sha, c);
    return c;
  }

  addTask(id: string, slot: string): string {
    const tip = this.commit(this.base, id).sha;
    this.branches.set(`refs/heads/omr/${PLAN_ID}/t/${id}`, tip);
    this.slotCommit.set(slot, tip);
    return tip;
  }

  /** Oldest first, ending at `sha`. */
  chain(sha: string): SimCommit[] {
    const out: SimCommit[] = [];
    let cur: string | null = sha;
    while (cur !== null) {
      const c = this.commits.get(cur);
      if (c === undefined) throw new Error(`unknown commit ${cur}`);
      out.unshift(c);
      cur = c.parent;
    }
    return out;
  }

  /** Task ids present in the tree at `sha` (adds minus reverts), in landing order. */
  tasksAt(sha: string): string[] {
    const set: string[] = [];
    for (const c of this.chain(sha)) {
      if (c.adds !== null) set.push(c.adds);
      if (c.removes !== null) {
        const i = set.indexOf(c.removes);
        if (i >= 0) set.splice(i, 1);
      }
    }
    return set;
  }

  isAncestor(a: string, b: string): boolean {
    return this.chain(b).some(c => c.sha === a);
  }

  tip(): string {
    return this.branches.get(INT_REF) ?? "";
  }

  /** `task-integrated` events per task across every process (exactly one per task is the no-double-integration rule). */
  integratedCount(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const ev of this.journal) if (ev.type === "task-integrated") out[ev.taskId] = (out[ev.taskId] ?? 0) + 1;
    return out;
  }

  guardCrash(point: "before-branchForce" | "after-branchForce"): void {
    if (this.dead) throw new CrashError("crash (dead)");
    if (this.crashAt === point && (this.crashOnForce === null || this.reflog.length + (point === "before-branchForce" ? 1 : 0) === this.crashOnForce)) {
      this.dead = true;
      throw new CrashError(`crash at ${point}`);
    }
  }

  /** A git write: allowed only while a journaled step is open (I4) and never in the owner checkout (I5). */
  write(op: string, cwd: string): void {
    if (this.dead) throw new CrashError("crash (dead)");
    this.writes.push({ op, cwd });
    if (!this.openStep()) this.violations.push(`I4: ${op} in ${cwd} outside ISS..ISE`);
    if (cwd === TOPLEVEL) this.violations.push(`I5: ${op} wrote in the owner checkout`);
  }

  /** I1, I2, I5 over the current state; I3 and I4 are recorded where they happen. */
  invariants(): void {
    const tip = this.tip();
    if (tip !== this.base && !this.passed.has(tip)) this.violations.push(`I1: branch tip ${tip} was never checked`);
    for (const r of this.reflog) {
      if (r.from !== null && !this.isAncestor(r.from, r.to)) this.violations.push(`I2: ${r.from} -> ${r.to} is not ancestor->descendant`);
    }
    if (!this.landed && this.branches.get(MAIN_REF) !== this.base) this.violations.push("I5: owner base branch moved without land");
  }
}

class UnexpectedCall extends Error {
  override readonly name = "UnexpectedCall" as const;
}
function unexpected(op: string): never {
  throw new UnexpectedCall(`unexpected call: ${op}`);
}

class GitDouble implements GitOps {
  readonly planId = PLAN_ID;
  constructor(private readonly w: World) {}
  async version(): Promise<string> { return unexpected("version"); }
  async checkRefFormat(): Promise<void> { return unexpected("checkRefFormat"); }
  async verifySlotPointers(): Promise<{ gitdir: string; common: string }> { return unexpected("verifySlotPointers"); }
  async worktreeAdd(): Promise<void> { return unexpected("worktreeAdd"); }
  async worktreeRemove(): Promise<void> { return unexpected("worktreeRemove"); }
  async worktreeList(): Promise<WorktreeEntry[]> { return unexpected("worktreeList"); }
  async checkoutDetach(): Promise<void> { return unexpected("checkoutDetach"); }
  async cleanTracked(): Promise<void> { return unexpected("cleanTracked"); }
  async cleanForChecks(): Promise<void> { return unexpected("cleanForChecks"); }
  async cleanPreview(): Promise<string[]> { return unexpected("cleanPreview"); }
  async lsFiles(): Promise<string[]> { return unexpected("lsFiles"); }
  async trackedLinks(): Promise<string[]> { return unexpected("trackedLinks"); }
  async statusPorcelain(): Promise<StatusEntry[]> { return []; }
  async addAll(): Promise<void> { return unexpected("addAll"); }
  async commit(): Promise<string> { return unexpected("commit"); }
  async revParse(cwd: string, rev: string): Promise<string> {
    if (rev === "HEAD" && cwd === WT) return this.w.iwtHead;
    if (this.w.commits.has(rev)) return rev;
    throw new Error(`unknown rev ${rev}`);
  }
  async diffNames(): Promise<string[]> { return unexpected("diffNames"); }
  async rebaseOnto(slot: string, onto: string): Promise<{ ok: true; head: string } | Conflict> {
    this.w.write("rebaseOnto", slot);
    const id = slot.slice("C:/slots/".length);
    const at = this.w.slotCommit.get(id);
    const task = at === undefined ? null : this.w.commits.get(at)?.adds ?? null;
    if (task === null) throw new Error(`slot ${id} does not hold a task commit`);
    const head = this.w.tip();
    if (onto === head && this.w.conflictOnHead.has(task)) return { ok: false, conflicts: [`src/${task}.ts`] };
    if (onto !== head && this.w.conflictOnMate.has(task)) return { ok: false, conflicts: [`src/${task}.ts`] };
    const c = this.w.commit(onto, task);
    this.w.slotCommit.set(id, c.sha);
    return { ok: true, head: c.sha };
  }
  async rebaseAbort(slot: string): Promise<void> { this.w.write("rebaseAbort", slot); }
  async cherryPick(): Promise<{ ok: true; head: string } | Conflict> { return unexpected("cherryPick"); }
  async revert(_slot: string, _commit: string, _message: string): Promise<{ ok: true; head: string } | Conflict> { return unexpected("revert"); }
  async mergeFfOnly(cwd: string, commit: string): Promise<{ ok: boolean; head: string }> {
    this.w.write("mergeFfOnly", cwd);
    if (this.w.ffRefused || !this.w.isAncestor(this.w.iwtHead, commit)) return { ok: false, head: this.w.iwtHead };
    this.w.iwtHead = commit;
    return { ok: true, head: commit };
  }
  async isAncestor(a: string, b: string): Promise<boolean> { return this.w.isAncestor(a, b); }
  async tag(): Promise<void> { return unexpected("tag"); }
  async deleteRefs(): Promise<string[]> { return unexpected("deleteRefs"); }
  async branchForce(name: string, commit: string, expectedOld: string | null): Promise<void> {
    this.w.guardCrash("before-branchForce");
    this.w.write("branchForce", WT);
    const ref = `refs/heads/${name}`;
    const cur = this.w.branches.get(ref) ?? null;
    if (this.w.casFails || cur !== expectedOld) throw new Error(`compare-and-swap of ${name} failed`);
    if (!this.w.passed.has(commit)) this.w.violations.push(`I1: branchForce to unchecked ${commit}`);
    if (cur !== null && !this.w.isAncestor(cur, commit)) this.w.violations.push(`I2: branchForce ${cur} -> ${commit} not a fast-forward`);
    this.w.branches.set(ref, commit);
    this.w.reflog.push({ from: cur, to: commit });
    this.w.guardCrash("after-branchForce");
  }
}

class IntegrateGitDouble implements IntegrateGit {
  constructor(private readonly w: World) {}
  async diffNameStatus(): Promise<NameStatus[]> { return []; }
  async logPaths(): Promise<Array<{ sha: string; subject: string }>> { return [{ sha: "a".repeat(40), subject: "touches the same lines" }]; }
  async revList(_cwd: string, from: string, to: string): Promise<string[]> {
    const shas = this.w.chain(to).map(c => c.sha);
    const at = shas.indexOf(from);
    return at >= 0 ? shas.slice(at + 1) : shas;
  }
  async createRef(): Promise<CreateRefOutcome> { return unexpected("createRef"); }
  async mergeBase(): Promise<string> { return this.w.base; }
  async isAncestor(_cwd: string, a: string, b: string): Promise<boolean> { return this.w.isAncestor(a, b); }
  async showFile(): Promise<string | null> { return null; }
  async subject(): Promise<string> { return "subject"; }
  async readRef(_cwd: string, ref: string): Promise<string | null> { return this.w.branches.get(ref) ?? null; }
  async ignoredAt(): Promise<string[]> { return []; }
  async revertAbort(cwd: string): Promise<void> { this.w.write("revertAbort", cwd); }
}

class PoolDouble implements SlotPool {
  readonly released: string[] = [];
  readonly resets: Array<{ slot: string; commit: string }> = [];
  constructor(private readonly w: World) {}
  private lease(slot: string): SlotLease {
    return { slot, path: slotPath(slot), planId: PLAN_ID, owner: "", commit: this.w.slotCommit.get(slot) ?? "" };
  }
  async acquire(): Promise<SlotLease> { return unexpected("acquire"); }
  async acquireSpecial(_planId: string, kind: "integration" | "ci"): Promise<SlotLease> { return this.lease(kind); }
  async reset(slot: string, commit: string): Promise<void> {
    this.w.write(`reset:${slot}`, slotPath(slot));
    this.resets.push({ slot, commit });
    this.w.slotCommit.set(slot, commit);
    if (slot === "integration") this.w.iwtHead = commit;
  }
  async noteCommit(): Promise<void> {}
  async cleanForChecks(): Promise<{ drifted: boolean }> { return { drifted: false }; }
  /** Called synchronously at the start of every release (test hook). */
  onRelease: ((slot: string) => void) | null = null;
  async release(slot: string): Promise<void> {
    this.released.push(slot);
    this.onRelease?.(slot);
  }
  async get(slot: string): Promise<SlotRecord | null> {
    return { schema: 1, slot, path: slotPath(slot), kind: slot === "integration" ? "integration" : slot === "ci" ? "ci" : "task", planId: PLAN_ID,
      repoKey: "repo-key", state: "leased", owner: null, commit: this.w.slotCommit.get(slot) ?? null, managers: [], manifests: {},
      createdAt: T0, updatedAt: T0 };
  }
  async list(): Promise<SlotRecord[]> { return []; }
  async gc(): Promise<{ removed: string[]; reported: string[] }> { return { removed: [], reported: [] }; }
}

const PASS: CheckResult = { verdict: "pass", components: [], flakyIds: [], note: null, durationMs: 1 };
function errorResult(reason: "spawn" | "preempted" | "interrupted" | "prepare"): CheckResult {
  return { verdict: "error", reason, message: `${reason} (scripted)`, components: [], durationMs: 1 };
}

class ChecksDouble implements IntegrationChecks {
  constructor(private readonly w: World) {}
  async prepare(): Promise<void> {}
  async select(): Promise<CheckSelection> { return { typecheck: null, tests: [], extras: [] }; }
  async run(req: CheckRequest): Promise<CheckResult> {
    this.w.checkLog.push({ candidate: req.candidate, slot: req.slot.slot, base: req.base, extraIds: req.extra?.ids ?? null });
    if (this.w.dead) throw new CrashError("crash (dead)");
    if (this.w.checkGate !== null) {
      await Promise.race([this.w.checkGate, new Promise<void>(resolve => req.signal.addEventListener("abort", () => resolve(), { once: true }))]);
      if (req.signal.aborted) return errorResult("interrupted");
    }
    this.w.afterCheck?.();
    const scripted = this.w.checkScript.shift();
    if (scripted !== undefined) {
      if (scripted.verdict === "pass") this.w.passed.add(req.candidate);
      return scripted;
    }
    const bad = this.w.tasksAt(req.candidate).filter(t => this.w.bad.has(t));
    if (bad.length > 0) {
      return { verdict: "fail", components: [], failingIds: bad.map(t => `test:${t}`), failingFiles: bad.map(t => `t/${t}.test.ts`), flakyIds: [],
        output: "boom", durationMs: 1 };
    }
    this.w.passed.add(req.candidate);
    return PASS;
  }
  async runCommands(_req: CommandRunRequest): Promise<CommandRunResult> { return unexpected("runCommands"); }
}

class SuiteDouble implements PhaseSuiteRunner {
  resolution: SuiteResolution = { kind: "none" };
  onRun: ((req: SuiteRunRequest) => SuiteVerdict) | null = null;
  revertScript: RevertVerdict[] = [];
  readonly runs: SuiteRunRequest[] = [];
  readonly reverts: RevertRequest[] = [];
  constructor(private readonly w: World) {}
  async resolve(): Promise<SuiteResolution> { return this.resolution; }
  /** When set, every run waits for it before returning its verdict. */
  runGate: Promise<void> | null = null;
  async run(req: SuiteRunRequest, _j: StepJournal): Promise<SuiteVerdict> {
    this.runs.push(req);
    if (this.runGate !== null) await this.runGate;
    return this.onRun === null ? { kind: "passed" } : this.onRun(req);
  }
  async revert(req: RevertRequest, j: StepJournal): Promise<RevertVerdict> {
    this.reverts.push(req);
    const scripted = this.revertScript.shift();
    if (scripted !== undefined) return scripted;
    await j.assertWriteCwd(req.slot.path, "integration");
    this.w.write("revert", req.slot.path);
    const c = this.w.commit(req.head, null, req.culprit.taskId);
    this.w.passed.add(c.sha);
    return { kind: "ok", revertHead: c.sha, reverted: [req.culprit.taskId] };
  }
  preemptBackground(): boolean { return false; }
}

class LanderDouble implements Lander {
  inspectResult: LandInspection;
  landOutcome: LandOutcome | null = null;
  tagOutcome: TagOutcome | null = null;
  readonly tags = new Map<string, string>();
  readonly landCalls: LandRequest[] = [];
  readonly inspectCalls: LandRequest[] = [];
  constructor(private readonly w: World) {
    this.inspectResult = { ok: true, baseTip: w.base, noop: false };
  }
  tagName(planId: string, phaseId: string): string { return `omr/${planId}/phase/${phaseId}`; }
  /** Called synchronously at the start of every tag (test hook). */
  onTag: (() => void) | null = null;
  async tag(req: { cwd: string; name: string; commit: string }): Promise<TagOutcome> {
    this.onTag?.();
    this.w.write("tag", req.cwd);
    if (this.tagOutcome !== null) return this.tagOutcome;
    const at = this.tags.get(req.name);
    if (at === undefined) { this.tags.set(req.name, req.commit); return "created"; }
    return at === req.commit ? "exists-same" : { kind: "exists-other", at };
  }
  async inspect(req: LandRequest): Promise<LandInspection> { this.inspectCalls.push(req); return this.inspectResult; }
  async fastForward(req: LandRequest): Promise<LandOutcome> {
    this.landCalls.push(req);
    if (this.landOutcome !== null) return this.landOutcome;
    const from = this.w.branches.get(MAIN_REF) ?? "";
    this.w.branches.set(MAIN_REF, req.candidate);
    this.w.landed = true;
    return { kind: "landed", from, to: req.candidate };
  }
  commands(req: LandRequest, refusal: LandRefusal): string[] {
    return [`git -C "${req.toplevel}" status # ${refusal.reason}`];
  }
}

/** I3: the repo lock is never taken while held. */
type OnLockWait = Parameters<RepoLockFactory["acquire"]>[3];

class LockDouble implements RepoLockFactory {
  held = false;
  acquires = 0;
  /** Test hook run at the start of every acquire with the queue's wait reporter and signal; a throw fails the acquire. */
  beforeAcquire: ((onWait: OnLockWait, signal: AbortSignal | undefined) => Promise<void> | void) | null = null;
  /** The `lost` controller of every lock handed out, newest last (tests fire them). */
  readonly lostCtls: AbortController[] = [];
  constructor(private readonly w: World) {}
  async acquire(_repoKey?: string, _holder?: unknown, signal?: AbortSignal, onWait?: OnLockWait): Promise<RepoLock> {
    await this.beforeAcquire?.(onWait, signal);
    if (this.held) this.w.violations.push("I3: repo lock re-entered");
    this.held = true;
    this.acquires++;
    const ctl = new AbortController();
    this.lostCtls.push(ctl);
    return { lost: ctl.signal, release: async () => { this.held = false; } };
  }
}

/** The real writer plus: invariant checks after each batch, and "the process dies right after durable append k". */
class CrashWriter implements LedgerWriter {
  appends = 0;
  /** Appends whose promise has not settled yet (the harness waits for 0 before it looks at side effects). */
  inflight = 0;
  crashAfter: number | null = null;
  /**
   * One-shot hook run synchronously at the queue's next read of `ledger` (the tests read `inner.ledger`, so only the queue
   * triggers it). Used to land a kick at an exact point of a lane loop (lost wake-up regression).
   */
  onNextRead: (() => void) | null = null;
  /** Append attempts so far (rejected ones included). */
  attempts = 0;
  /** When it returns an error for the n-th (1-based) attempt, that append rejects with it and never reaches the store. */
  rejectOn: ((n: number) => Error | null) | null = null;
  constructor(readonly inner: LedgerWriter, private readonly w: World) {}
  get planId(): string { return this.inner.planId; }
  /** Reads of `ledger` by the queue (the tests read `inner.ledger`): an idle lane must not keep reading. */
  reads = 0;
  get ledger(): Readonly<LedgerV1> {
    this.reads++;
    const hook = this.onNextRead;
    if (hook !== null) {
      this.onNextRead = null;
      hook();
    }
    return this.inner.ledger;
  }
  async append(batch: readonly ExecutorEventInput[] | BatchBuilder): Promise<Readonly<LedgerV1>> {
    if (this.w.dead) throw new CrashError("crash (dead)");
    this.attempts++;
    const rejected = this.rejectOn?.(this.attempts) ?? null;
    if (rejected !== null) throw rejected;
    this.inflight++;
    try {
      let built: readonly ExecutorEventInput[] = [];
      const builder: BatchBuilder = l => {
        built = typeof batch === "function" ? batch(l) : batch;
        return built;
      };
      const next = await this.inner.append(builder);
      // Durable from here on: the journal of every process of this world (the main journal rotates at close()).
      this.w.journal.push(...built);
      this.appends++;
      this.w.invariants();
      if (this.crashAfter !== null && this.appends === this.crashAfter) {
        this.w.dead = true;
        throw new CrashError(`crash after append ${this.appends}`);
      }
      return next;
    } finally {
      this.inflight--;
    }
  }
  openIntegration(): ReturnType<LedgerWriter["openIntegration"]> { return this.inner.openIntegration(); }
  wakeKeys(): ReturnType<LedgerWriter["wakeKeys"]> { return this.inner.wakeKeys(); }
  snapshot(): Promise<void> { return this.inner.snapshot(); }
  close(): Promise<void> { return this.inner.close(); }
}

function isStep(ev: ExecutorEvent): ev is IntegrationStepEvent {
  return ev.type === "integration-step";
}

const liveEnvs: Array<{ env: Env; root: string }> = [];
afterEach(async () => {
  for (const { env, root } of liveEnvs.splice(0)) {
    await env.close();
    await removeDirWhenReleased(root, { deadlineMs: 20_000 });
  }
});

const tick = (): Promise<void> => new Promise<void>(resolve => setImmediate(resolve));
const realPause = (ms: number): Promise<void> => new Promise<void>(resolve => setTimeout(resolve, ms));

interface SetupOpts {
  tasks?: number;
  batchMax?: number;
  resume?: boolean;
  mutate?: (l: LedgerV1, w: World) => void;
}

class Env {
  readonly w = new World();
  readonly clock = new FakeClock();
  readonly proc = new FakeProc(100, "host-a");
  readonly git = new GitDouble(this.w);
  readonly igit = new IntegrateGitDouble(this.w);
  readonly pool = new PoolDouble(this.w);
  readonly checks = new ChecksDouble(this.w);
  readonly suite = new SuiteDouble(this.w);
  readonly lander = new LanderDouble(this.w);
  readonly locks = new LockDouble(this.w);
  readonly listener = new ListenerSpy();
  readonly leases = new LeaseSpy();
  readonly logger = new LoggerSpy();
  readonly guard = new GuardSpy();
  /** Task ids the queue handed to `settle` (live tasks released by a revert). */
  readonly settled: string[] = [];
  /** M1: the slots the queue gave back through `releaseSlot`, as `<task>:<slot>`. */
  readonly slotReleases: string[] = [];
  /** A real lock factory instead of the LockDouble (takes effect at the next open/restart). */
  locksOverride: RepoLockFactory | null = null;
  /** Integration-step events of an earlier history, served before the store's (read at the queue's first load). */
  historyExtra: IntegrationStepEvent[] = [];
  store!: ReturnType<typeof createLedgerStore>;
  writer!: CrashWriter;
  queue!: IntegrationQueue;

  async open(first: boolean, draft: LedgerV1 | null): Promise<void> {
    const holder = holderOf("s1", 100, "host-a", this.clock.iso());
    const inner = first && draft !== null ? await this.store.create(draft, holder) : await this.store.open(PLAN_ID, holder);
    this.writer = new CrashWriter(inner, this.w);
    this.w.openStep = () => this.writer.openIntegration().some(o => o.edge === "start");
    this.queue = createIntegrationQueue({
      planId: PLAN_ID, writer: this.writer, git: this.git, igit: this.igit, pool: this.pool, leases: this.leases, checks: this.checks,
      suite: this.suite, lander: this.lander, listener: this.listener, locks: this.locksOverride ?? this.locks, guard: this.guard, clock: this.clock, logger: this.logger,
      settle: (id, release) => { this.settled.push(id); void release(); },
      // M1: the runtime's saved release, as `<task>:<slot>`; the pool double releases the slot behind it.
      releaseSlot: async (id, slot) => { this.slotReleases.push(`${id}:${slot}`); await this.pool.release(slot); },
      history: { steps: async () => [...this.historyExtra, ...(await this.store.exportPlan(PLAN_ID)).events.filter(isStep)] },
    });
  }

  /** Closes the current writer (the "process" is gone) and brings up a new queue over the same ledger and git world. */
  async restart(): Promise<void> {
    await this.close();
    this.w.dead = false;
    this.w.crashAt = null;
    this.w.crashOnForce = null;
    this.locks.held = false;
    await this.open(false, null);
  }

  /** The test's view of the ledger; bypasses `CrashWriter.onNextRead` so only queue reads trigger the hook. */
  get ledger(): Readonly<LedgerV1> { return this.writer.inner.ledger; }
  state(id: string): TaskState | "missing" { return this.ledger.tasks[id]?.state ?? "missing"; }
  phase(id = "p1"): LedgerV1["phases"][number] {
    const p = this.ledger.phases.find(x => x.id === id);
    if (p === undefined) throw new Error(`no phase ${id}`);
    return p;
  }

  /** "kind:step:edge[/result]" per integration-step event of the history. */
  async steps(kind?: IntegrationEntry["kind"]): Promise<string[]> {
    const events = (await this.store.exportPlan(PLAN_ID)).events.filter(isStep);
    return events.filter(e => kind === undefined || e.entry.kind === kind)
      .map(e => `${e.entry.kind}:${e.step}:${e.edge}${e.result === null ? "" : `/${e.result}`}`);
  }

  async events(): Promise<ExecutorEvent[]> {
    return (await this.store.exportPlan(PLAN_ID)).events;
  }

  /**
   * Waits until `pred` holds with no append in flight, stably over a few event-loop turns. Between two appends the queue only
   * awaits doubles (microtasks), so "no append in flight for 3 turns" means the post-batch work (listener calls, releases,
   * the next kick) has run. The wall-clock deadline only bounds a hung test; the real ledger fsyncs are slow on Windows.
   */
  async until(pred: () => boolean, what = "condition", deadlineMs = 50_000): Promise<void> {
    const deadline = Date.now() + deadlineMs;
    for (;;) {
      let stable = pred() && this.writer.inflight === 0;
      for (let i = 0; stable && i < 3; i++) {
        await tick();
        stable = pred() && this.writer.inflight === 0;
      }
      if (stable) return;
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${what}; states ${JSON.stringify(Object.values(this.ledger.tasks).map(t => `${t.id}:${t.state}`))}`);
      }
      await realPause(1);
    }
  }

  /** Lets the lanes run for a while (negative assertions: "nothing happens"). */
  async settle(): Promise<void> {
    for (let i = 0; i < 25; i++) {
      await realPause(1);
      while (this.writer.inflight > 0) await realPause(1);
    }
  }

  /** Disposes the queue and closes the writer (releases the store's files); idempotent; safe before open(). */
  async close(): Promise<void> {
    if (this.queue !== undefined) await this.queue.dispose().catch(() => undefined);
    if (this.writer !== undefined) await this.writer.close().catch(() => undefined);
  }

  /** The state of the world is quiet: nothing integrating and no entry open. */
  quiet(): boolean {
    return this.writer.openIntegration().length === 0 && !Object.values(this.ledger.tasks).some(t => t.state === "integrating");
  }

  /** Final-state fingerprint that does not depend on sha values. */
  async signature(): Promise<{ chain: string[]; states: Record<string, string>; integratedEvents: Record<string, number>; gate: string; status: string }> {
    const states: Record<string, string> = {};
    for (const t of Object.values(this.ledger.tasks)) states[t.id] = t.state;
    // Counted from every durable batch of every process: `task-integrated` is not history-class, so the store's export loses
    // the ones before a restart (close() snapshots and rotates the main journal).
    const integratedEvents = this.w.integratedCount();
    return { chain: this.w.tasksAt(this.w.tip()), states, integratedEvents, gate: this.phase().gate, status: this.ledger.status };
  }

  /** Re-enqueues what an owner would: every task still `verified` after a restart. */
  requeueVerified(): void {
    const ids = Object.values(this.ledger.tasks).filter(t => t.state === "verified").map(t => t.id);
    if (ids.length > 0) this.queue.enqueue(ids);
  }

  assertInvariants(): void {
    this.w.invariants();
    expect(this.w.violations).toEqual([]);
  }
}

async function setup(o: SetupOpts = {}): Promise<Env> {
  const env = new Env();
  const root = await mkdtemp(join(tmpdir(), "omr-integrate-queue-"));
  liveEnvs.push({ env, root });
  env.store = createLedgerStore({
    home: join(root, "omr-executor"), clock: env.clock, proc: env.proc, warn: () => undefined, heartbeatMs: 10_000, staleMs: 60_000,
    snapshotEvery: 200,
  });
  const draft = buildDraft(0);
  draft.edges = [];
  draft.config.batchMax = o.batchMax ?? 4;
  draft.integration = { branch: `omr/${PLAN_ID}/integration`, worktree: WT, head: env.w.base };
  draft.repo = { ...draft.repo, toplevel: TOPLEVEL, baseBranch: "main", baseCommit: env.w.base };
  const closed = { ...openAttempt(1), endedAt: T0 as IsoTime, outcome: "succeeded" as const, verdict: "pass" as const };
  for (let i = 1; i <= (o.tasks ?? 1); i++) {
    const id = `T${i}`;
    const slot = `slot-${i}`;
    env.w.addTask(id, slot);
    draft.tasks[id] = taskNode(id, { state: "verified", slot, branch: `omr/${PLAN_ID}/t/${id}`, attempts: [closed] });
  }
  o.mutate?.(draft, env.w);
  await env.open(true, draft);
  if (o.resume !== false) await env.queue.resume();
  return env;
}

/**
 * A1-3a orphans through legal journaled steps only (the store refuses a hand-made `integrating` task without an entry):
 * the entry pauses on 3 check errors (M13a), process 2 rolls it back while paused (closes `rolled-back`; the requeue lives
 * only in memory), process 3 starts with the tasks `integrating` and no open entry. Returns process 3, not yet resumed.
 */
async function orphanEnv(tasks: number, batchMax: number): Promise<Env> {
  const env = await setup({ tasks, batchMax });
  env.w.checkScript.push(errorResult("spawn"), errorResult("spawn"), errorResult("spawn"));
  env.queue.enqueue(Array.from({ length: tasks }, (_, i) => `T${i + 1}`));
  await env.until(() => env.ledger.status === "paused", "M13a pause");
  await env.restart();
  const first = await env.queue.resume();
  expect(first.entries.map(e => e.action)).toEqual(["rolled-back"]);
  expect(env.writer.openIntegration()).toEqual([]);
  await env.restart();
  for (let i = 1; i <= tasks; i++) expect(env.state(`T${i}`)).toBe("integrating");
  expect(env.writer.openIntegration()).toEqual([]);
  return env;
}

describe("harness sanity", () => {
  it("builds a world, resumes cleanly and records no violation", async () => {
    const env = await setup({ tasks: 2 });
    expect(env.state("T1")).toBe("verified");
    expect(env.queue.queued()).toEqual([]);
    env.assertInvariants();
    await env.queue.dispose();
  });
});

describe("G8 intrinsic integration and phase-suite service observations", () => {
  async function observedEntry(mode: "off" | "on" | "throw", tasks: number, preparationMs = 100, waitMs = 300) {
    const env = await setup({ tasks });
    const lines: string[] = [], calls: string[] = [];
    const sink = createV2Observations({ write: line => { lines.push(line); } });
    if (mode === "throw") sink.record = () => { throw new Error("observer failed"); };
    attachSlotObservations(mode === "off" ? undefined : sink, env.clock, env.writer);
    let now = 0;
    const monotonic = vi.spyOn(performance, "now").mockImplementation(() => now);
    const poolReset = env.pool.reset.bind(env.pool);
    vi.spyOn(env.pool, "reset").mockImplementation(async (slot, commit) => {
      calls.push(`reset:${slot}`); now += preparationMs; await poolReset(slot, commit);
    });
    const special = env.pool.acquireSpecial.bind(env.pool);
    vi.spyOn(env.pool, "acquireSpecial").mockImplementation(async (plan, kind) => {
      calls.push(`special:${kind}`); now += preparationMs * 2; return special(plan, kind);
    });
    const rebase = env.git.rebaseOnto.bind(env.git);
    const git: GitOps = env.git;
    // These three doubles model only the actual git process. executor-git.test.ts separately exercises the real
    // GitOps preparation/cleanup seams, so a pointer/config/reset delay cannot hide inside these stand-ins.
    vi.spyOn(git, "rebaseOnto").mockImplementation(async (slot, onto, _upstream, observation) => {
      const service = observation?.start("service", "rebase");
      try { calls.push("rebase"); now += 7; return await rebase(slot, onto); }
      finally { service?.end("pass"); }
    });
    const merge = env.git.mergeFfOnly.bind(env.git);
    vi.spyOn(git, "mergeFfOnly").mockImplementation(async (slot, commit, observation) => {
      const service = observation?.start("service", "merge");
      try { calls.push("merge"); now += 5; return await merge(slot, commit); }
      finally { service?.end("pass"); }
    });
    const cas = env.git.branchForce.bind(env.git);
    vi.spyOn(git, "branchForce").mockImplementation(async (branch, commit, old, observation) => {
      const service = observation?.start("service", "cas");
      try { calls.push("cas"); now += 3; return await cas(branch, commit, old); }
      finally { service?.end("pass"); }
    });
    const revParse = env.git.revParse.bind(env.git);
    vi.spyOn(env.git, "revParse").mockImplementation(async (path, rev) => {
      if (rev === "HEAD" && path.startsWith("C:/slots/")) return env.w.slotCommit.get(path.slice("C:/slots/".length)) ?? "";
      return revParse(path, rev);
    });
    const igit: IntegrateGit = env.igit;
    vi.spyOn(igit, "showFile").mockImplementation(async (_cwd, _commit, path) => {
      now += preparationMs;
      return path === "package.json" ? JSON.stringify({ scripts: { typecheck: "tsc" } }) : null;
    });
    const command: ResolvedCommand = { file: "node", args: ["check.js"], label: "mandatory-check", source: "run-command", ref: null };
    const resolver: RunResolver = { resolve: async () => ({ ok: true, command }) };
    const background = new BackgroundRuns();
    const checks = createIntegrationChecks({ ledger: () => env.ledger, pool: env.pool, git: env.git, igit,
      clock: env.clock, logger: env.logger, guard: env.guard, resolver, background,
      preemptForeground: async () => { calls.push("preempt"); now += waitMs; },
      acquire: async () => {
        calls.push("slot-acquire"); now += waitMs;
        return { lost: false, release: async () => { calls.push("slot-release"); now += 200; } };
      },
      spawn: async (_command, options) => {
        calls.push(options.lowPriority ? "suite-command" : "check-command");
        const durationMs = options.lowPriority ? 13 : 11;
        now += durationMs;
        return { exitCode: 0, timedOut: false, stdout: "", stderr: "", durationMs };
      },
    });
    vi.spyOn(env.checks, "run").mockImplementation(async req => {
      const result = await checks.run(req);
      if (result.verdict === "pass") env.w.passed.add(req.candidate);
      return result;
    });
    const suite = createPhaseSuiteRunner({ checks, igit, git: env.git, pool: env.pool, clock: env.clock,
      logger: env.logger, resolver, background });
    vi.spyOn(env.suite, "resolve").mockResolvedValue({ kind: "runs", commands: [command] });
    vi.spyOn(env.suite, "run").mockImplementation(suite.run);
    env.locks.beforeAcquire = () => { calls.push("repo-lock"); now += waitMs; };
    try {
      const ids = Array.from({ length: tasks }, (_, i) => `T${i + 1}`);
      env.queue.enqueue(ids);
      await env.until(() => ids.every(id => env.state(id) === "integrated") && env.phase().gate === "awaiting-qa" && env.quiet());
      env.assertInvariants();
      await env.queue.dispose();
      const signature = await env.signature();
      const steps = await env.steps();
      sink.close();
      return { signature, steps, calls, rows: mode === "on" ? servicePairs(lines) : [],
        writes: env.w.writes, releases: env.pool.released, listeners: env.listener.calls, elapsed: now };
    } finally {
      await env.queue.dispose();
      detachSlotObservations(env.clock, env.writer);
      sink.close(); monotonic.mockRestore();
    }
  }

  it.each([1, 2])("off/on/throwing parity through the real queue, checks and phase runner (%s tasks)", async tasks => {
    const off = await observedEntry("off", tasks);
    for (const mode of ["on", "throw"] as const) {
      const observed = await observedEntry(mode, tasks);
      const { rows, ...effects } = observed;
      const { rows: _offRows, ...offEffects } = off;
      expect(effects).toEqual(offEffects);
      if (mode !== "on") continue;
      const ends = rows.filter(r => r.action === "end" && r.spanKind === "service");
      expect(ends.map(r => [r.component, r.stage, r.durationMs])).toEqual([
        ...Array.from({ length: tasks }, () => ["rebase", "rebase", 7]),
        ["checks", "command", 11], ["fast-forward", "merge", 5], ["fast-forward", "cas", 3], ["phase-suite", "command", 13],
      ]);
      const entry = ends.filter(r => r.component !== "phase-suite");
      expect(new Set(entry.map(r => r.entryId)).size).toBe(1);
      for (const row of entry) {
        expect(row).toMatchObject({ planId: PLAN_ID, phaseId: "p1", taskIds: Array.from({ length: tasks }, (_, i) => `T${i + 1}`), result: "pass" });
        expect(row.candidate).toMatch(/^[0-9a-f]{40}$/);
        expect(row.entryId).toMatch(/^i-/);
      }
      expect(ends.at(-1)).toMatchObject({ planId: PLAN_ID, phaseId: "p1", taskIds: [], result: "pass" });
      expect(ends.at(-1)?.entryId).not.toBe(entry[0]?.entryId);
      expect(rows.some(r => r.spanKind === "service-prep" && r.stage === "ci-slot")).toBe(true);
      expect(rows.some(r => r.spanKind === "service-wait" && r.stage === "background-lane")).toBe(true);
      expect(rows.some(r => r.spanKind === "service-wait" && r.stage === "repo-lock")).toBe(true);
    }
  });

  it("excludes delayed checkout/provisioning and verification-slot waits from checks AND suite service", async () => {
    const baseline = await observedEntry("on", 2, 0, 0);
    const prep = await observedEntry("on", 2, 1_000, 0);
    const wait = await observedEntry("on", 2, 0, 5_000);
    const intrinsic = (rows: ServiceObservationData[]) => rows.filter(r => r.action === "end" && r.spanKind === "service")
      .map(r => [r.component, r.stage, r.durationMs]);
    expect(intrinsic(prep.rows)).toEqual(intrinsic(baseline.rows));
    expect(intrinsic(wait.rows)).toEqual(intrinsic(baseline.rows));
    expect(prep.elapsed).toBeGreaterThan(baseline.elapsed + 1_000);
    expect(wait.elapsed).toBeGreaterThan(baseline.elapsed + 5_000);
    for (const component of ["checks", "phase-suite"] as const) {
      expect(wait.rows).toContainEqual(expect.objectContaining({ component, spanKind: "service-wait", action: "end", stage: "verification-slot",
        durationMs: component === "checks" ? 10_000 : 5_000 }));
      expect(prep.rows.some(r => r.component === component && r.spanKind === "service-prep" && r.durationMs >= 1_000)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Task entry rows: clean, conflict, failed
// ---------------------------------------------------------------------------------------------------------------

describe("task entry (rows 28-32)", () => {
  it("single task, clean rebase: fast-forwards to the checked commit (row-30 order)", async () => {
    const env = await setup({ tasks: 1 });
    env.queue.enqueue(["T1"]);
    await env.until(() => env.state("T1") === "integrated" && env.quiet());
    expect(await env.steps("task")).toEqual([
      "task:rebase:start", "task:rebase:end/ok", "task:checks:start", "task:checks:end/ok", "task:fast-forward:start", "task:fast-forward:end/ok",
    ]);
    const t1 = env.ledger.tasks.T1;
    expect(t1?.integrated?.from).toBe(env.w.base);
    expect(env.ledger.integration.head).toBe(env.w.tip());
    expect(t1?.integrated?.to).toBe(env.w.tip());
    expect(env.w.passed.has(env.w.tip())).toBe(true);
    expect(env.w.reflog).toHaveLength(1);
    expect(t1?.slot).toBeNull();
    expect(env.pool.released).toContain("slot-1");
    expect(env.leases.released).toEqual(["T1"]);
    expect(env.listener.calls).toContain("integrated:T1");
    expect(env.locks.held).toBe(false);
    expect(env.w.writes.some(x => x.op === "mergeFfOnly" && x.cwd === WT)).toBe(true);
    env.assertInvariants();
    await env.queue.dispose();
  });

  it("the whole phase integrated opens the gate: no suite -> awaiting-qa", async () => {
    const env = await setup({ tasks: 1 });
    env.queue.enqueue(["T1"]);
    await env.until(() => env.phase().gate === "awaiting-qa");
    expect(env.listener.calls).toContain("gate:p1:awaiting-qa");
    env.assertInvariants();
    await env.queue.dispose();
  });

  it("conflict with the head: task -> conflict with the paths, slot kept, branch unchanged", async () => {
    const env = await setup({ tasks: 1 });
    env.w.conflictOnHead.add("T1");
    env.queue.enqueue(["T1"]);
    await env.until(() => env.state("T1") === "conflict" && env.quiet());
    expect(await env.steps("task")).toEqual(["task:rebase:start", "task:rebase:end/conflict"]);
    const ev = (await env.events()).filter(isStep).find(e => e.edge === "end");
    expect(JSON.parse(ev?.detail ?? "{}")).toMatchObject({ taskId: "T1", paths: ["src/T1.ts"], truncated: false });
    const ctx = env.ledger.tasks.T1?.attempts[0]?.context ?? "";
    expect(ctx).toContain("conflicted in 1 path");
    expect(ctx).toContain("src/T1.ts");
    expect(env.w.tip()).toBe(env.w.base);
    expect(env.pool.released).not.toContain("slot-1");
    expect(env.leases.released).toEqual([]);
    expect(env.listener.calls).toContain("conflict:T1");
    expect(env.w.checkLog).toHaveLength(0);
    env.assertInvariants();
    await env.queue.dispose();
  });

  it("failing checks: task -> failed with failing ids, branch unchanged", async () => {
    const env = await setup({ tasks: 1 });
    env.w.bad.add("T1");
    env.queue.enqueue(["T1"]);
    await env.until(() => env.state("T1") === "failed" && env.quiet());
    expect(await env.steps("task")).toEqual(["task:rebase:start", "task:rebase:end/ok", "task:checks:start", "task:checks:end/failed"]);
    const end = (await env.events()).filter(isStep).find(e => e.step === "checks" && e.edge === "end");
    expect(end?.failingIds).toEqual(["test:T1"]);
    expect(end?.closes).toBe(true);
    expect(env.ledger.tasks.T1?.attempts[0]?.context).toContain("Integration checks failed for T1");
    expect(env.w.tip()).toBe(env.w.base);
    expect(env.w.reflog).toHaveLength(0);
    expect(env.listener.calls).toContain("failed:T1");
    expect(env.pool.released).not.toContain("slot-1");
    env.assertInvariants();
    await env.queue.dispose();
  });

  it("flaky ids in a passing check still integrate", async () => {
    const env = await setup({ tasks: 1 });
    env.w.checkScript.push({ verdict: "pass", components: [], flakyIds: ["test:flaky"], note: null, durationMs: 1 });
    env.queue.enqueue(["T1"]);
    await env.until(() => env.state("T1") === "integrated");
    env.assertInvariants();
    await env.queue.dispose();
  });

  it("a passing check with note no-checks integrates", async () => {
    const env = await setup({ tasks: 1 });
    env.w.checkScript.push({ verdict: "pass", components: [], flakyIds: [], note: "no-checks", durationMs: 1 });
    env.queue.enqueue(["T1"]);
    await env.until(() => env.state("T1") === "integrated");
    env.assertInvariants();
    await env.queue.dispose();
  });

  it("serial tasks integrate in queue order, each rebased onto the previous head", async () => {
    const env = await setup({ tasks: 3, batchMax: 1 });
    env.queue.enqueue(["T1", "T2", "T3"]);
    await env.until(() => ["T1", "T2", "T3"].every(id => env.state(id) === "integrated") && env.quiet());
    expect(env.w.tasksAt(env.w.tip())).toEqual(["T1", "T2", "T3"]);
    expect(env.w.reflog).toHaveLength(3);
    const base1 = env.ledger.tasks.T2?.integrated?.from;
    expect(base1).toBe(env.ledger.tasks.T1?.integrated?.to);
    env.assertInvariants();
    await env.queue.dispose();
  });

  it("enqueue ignores unknown, not-verified and already queued ids; queued() lists the rest", async () => {
    const env = await setup({ tasks: 2, resume: false });
    env.queue.enqueue(["nope", "T1", "T1", "T2"]);
    expect(env.queue.queued()).toEqual(["T1", "T2"]);
    expect(env.logger.warnings.some(w => w.includes("ignoring enqueue of nope"))).toBe(true);
    await env.queue.dispose();
  });

  it("nothing is dequeued before resume() and nothing while the plan is paused", async () => {
    const env = await setup({ tasks: 1, resume: false });
    env.queue.enqueue(["T1"]);
    await env.settle();
    expect(env.state("T1")).toBe("verified");
    await env.queue.resume();
    await env.until(() => env.state("T1") === "integrated");
    await env.queue.dispose();
  });

  it("a task of a paused phase keeps its position and is skipped (A1-8)", async () => {
    const env = await setup({ tasks: 2, batchMax: 1, mutate: l => { const p = l.phases[0]; if (p !== undefined) p.paused = true; } });
    env.queue.enqueue(["T1", "T2"]);
    await env.settle();
    expect(env.state("T1")).toBe("verified");
    expect(env.queue.queued()).toEqual(["T1", "T2"]);
    await env.queue.dispose();
  });

  it("an idle lane (only paused-phase work queued) exits and makes a bounded number of ledger reads until a state change", async () => {
    const env = await setup({ tasks: 2, batchMax: 1, mutate: l => { const p = l.phases[0]; if (p !== undefined) p.paused = true; } });
    const r0 = env.writer.reads;
    env.queue.enqueue(["T1", "T2"]);
    env.queue.enqueue(["T1"]); // a kick while the lanes run sets `wanted`: at most one more pass per lane
    // Microtask turns only: a lane re-kick loop (QA-3.2 round 2 hang) would keep reading here instead of starving the test.
    for (let i = 0; i < 500; i++) await Promise.resolve();
    expect(env.writer.reads - r0).toBeLessThan(40);
    await env.settle();
    const r1 = env.writer.reads;
    await env.settle();
    expect(env.writer.reads).toBe(r1); // idle: no reads at all
    expect(env.queue.queued()).toEqual(["T1", "T2"]);
    // A state change plus a kick wakes it: the unpaused phase's tasks integrate.
    await env.writer.append([{ type: "phase-paused", phaseId: "p1", paused: false, reason: "unpause" }]);
    env.queue.enqueue([]);
    await env.until(() => env.state("T2") === "integrated" && env.quiet(), "both integrated after the unpause");
    env.assertInvariants();
  });

  it("enqueue and checkPhase after dispose reject with E_DISPOSED, and no journal line is written afterwards", async () => {
    const env = await setup({ tasks: 1 });
    await env.queue.dispose();
    const seq = env.ledger.seq;
    let code: unknown = null;
    try {
      env.queue.enqueue(["T1"]);
    } catch (e) {
      code = (e as { code?: unknown }).code;
    }
    expect(code).toBe("E_DISPOSED");
    await expect(env.queue.checkPhase("p1")).rejects.toMatchObject({ code: "E_DISPOSED" });
    await expect(env.queue.land()).rejects.toMatchObject({ code: "E_DISPOSED" });
    await expect(env.queue.resume()).rejects.toMatchObject({ code: "E_DISPOSED" });
    await expect(env.queue.abort()).rejects.toMatchObject({ code: "E_DISPOSED" });
    expect(env.queue.queued()).toEqual([]);
    expect(env.ledger.seq).toBe(seq);
    await env.queue.dispose(); // idempotent
  });
});

// ---------------------------------------------------------------------------------------------------------------
// QA-3.2 round 1 regressions (task entries, resume step 0, abort, illegal transitions)
// ---------------------------------------------------------------------------------------------------------------

describe("QA-3.2 round 1: task entries and resume", () => {
  it("QA-3.2-13: a check that fails while abort() fires is interrupted: no failed transition, no onFailed, task cancelled", async () => {
    const env = await setup({ tasks: 1 });
    env.w.bad.add("T1");
    let aborting: Promise<void> | null = null;
    env.w.afterCheck = () => {
      env.w.afterCheck = null;
      aborting = env.queue.abort();
    };
    env.queue.enqueue(["T1"]);
    await env.until(() => aborting !== null, "abort fired");
    await aborting;
    expect(env.state("T1")).toBe("cancelled");
    expect(env.listener.calls.filter(c => c.startsWith("failed:"))).toEqual([]);
    expect(env.w.journal.some(e => e.type === "task-transition" && e.to === "failed")).toBe(false);
    expect(env.writer.openIntegration()).toEqual([]);
    env.assertInvariants();
  });

  it("QA-3.2-18: an illegal transition pauses with a text that asks for a restart (resume() of this queue is latched)", async () => {
    const env = await setup({ tasks: 1 });
    const at = env.writer.attempts + 1;
    env.writer.rejectOn = n => n === at ? new ExecutorError("E_ILLEGAL_TRANSITION", "scripted rejection", null) : null;
    env.queue.enqueue(["T1"]);
    await env.until(() => env.ledger.status === "paused", "paused");
    const item = env.ledger.inbox[env.ledger.inbox.length - 1];
    expect(item?.severity).toBe("critical");
    expect(item?.text).toContain("restart the executor");
    expect(item?.text).not.toContain("The plan is paused; resume() reconciles.");
    expect(env.state("T1")).toBe("verified");
  });

  it("QA-3.2-9: resume() step 0 with git unable to run is an infrastructure halt, never 'moved'; a later resume() goes on", async () => {
    const env = await setup({ tasks: 1, resume: false });
    const real = env.igit.readRef.bind(env.igit);
    let calls = 0;
    env.igit.readRef = async (cwd, ref) => {
      calls++;
      throw new Error(`spawn git ENOENT (${cwd} ${ref})`);
    };
    const r = await env.queue.resume();
    expect(r.halted).toBe(true);
    expect(calls).toBe(3); // CHECK_TRIES reads before it gives up
    expect(env.ledger.status).toBe("paused");
    const item = env.ledger.inbox[env.ledger.inbox.length - 1];
    expect(item?.severity).toBe("critical");
    expect(item?.text).toContain("infrastructure");
    expect(item?.text).not.toContain("no journaled fast-forward explains it");
    env.igit.readRef = real;
    const again = await env.queue.resume();
    expect(again.halted).toBe(false);
    env.assertInvariants();
  });

  it("QA-3.2-9: resume() step 0 with the integration branch missing halts naming the ref and the 5.1 handoff", async () => {
    const env = await setup({ tasks: 1, resume: false });
    env.w.branches.delete(INT_REF);
    const r = await env.queue.resume();
    expect(r.halted).toBe(true);
    const item = env.ledger.inbox[env.ledger.inbox.length - 1];
    expect(item?.text).toContain(INT_REF);
    expect(item?.text).toContain("5.1");
    expect(item?.text).toContain("does not exist");
  });

  it("QA-3.2-9: the integration branch is read in repo.toplevel, not in the integration worktree", async () => {
    const env = await setup({ tasks: 1, resume: false });
    const cwds: string[] = [];
    const real = env.igit.readRef.bind(env.igit);
    env.igit.readRef = async (cwd, ref) => { cwds.push(`${cwd}|${ref}`); return real(cwd, ref); };
    await env.queue.resume();
    env.queue.enqueue(["T1"]);
    await env.until(() => env.state("T1") === "integrated" && env.quiet());
    expect(cwds.length).toBeGreaterThan(0);
    expect(cwds.every(c => c.startsWith(`${TOPLEVEL}|`))).toBe(true);
    env.assertInvariants();
  });

  it("QA-3.2-9: a task branch git cannot read pauses the plan (infrastructure) and keeps the task queued; a missing branch drops it", async () => {
    const env = await setup({ tasks: 2, batchMax: 1 });
    const real = env.igit.readRef.bind(env.igit);
    env.igit.readRef = async (cwd, ref) => {
      if (ref.endsWith("/t/T1")) throw new Error("git died");
      return real(cwd, ref);
    };
    env.queue.enqueue(["T1"]);
    await env.until(() => env.ledger.status === "paused", "paused");
    expect(env.state("T1")).toBe("verified");
    expect(env.queue.queued()).toEqual(["T1"]);
    const item = env.ledger.inbox[env.ledger.inbox.length - 1];
    expect(item?.severity).toBe("critical");
    expect(item?.text).toContain("could not read its branches");
    // The missing-branch case (ref absent, git fine) is a blocking item and drops the task.
    env.igit.readRef = real;
    env.w.branches.delete(`refs/heads/omr/${PLAN_ID}/t/T2`);
    await unpause(env);
    env.queue.enqueue(["T2"]);
    await env.until(() => env.state("T1") === "integrated" && env.ledger.inbox.some(i => i.severity === "blocking"), "T1 integrated, T2 dropped");
    expect(env.queue.queued()).toEqual([]);
    expect(env.ledger.inbox.find(i => i.severity === "blocking")?.text).toContain("does not exist");
    env.assertInvariants();
  });

});

/** The owner unpauses the plan; the stalled poll (M36) notices it at its next 5 s tick or at the next enqueue/checkPhase. */
async function unpause(env: Env): Promise<void> {
  await env.writer.append([{ type: "status-changed", from: "paused", to: "running", reason: "unpause" }]);
  env.clock.advance(5_000);
  env.clock.fire();
}

// ---------------------------------------------------------------------------------------------------------------
// Batches (M16-M18)
// ---------------------------------------------------------------------------------------------------------------

describe("batches of 4 (M17, M18)", () => {
  const cases: Array<{ name: string; bad: string[]; maxChecks: number }> = [
    { name: "0 failing", bad: [], maxChecks: 1 },
    { name: "1 failing (position 1)", bad: ["T1"], maxChecks: 7 },
    { name: "1 failing (position 3)", bad: ["T3"], maxChecks: 7 },
    { name: "1 failing (position 4)", bad: ["T4"], maxChecks: 7 },
    { name: "2 failing (positions 2 and 4)", bad: ["T2", "T4"], maxChecks: 7 },
    { name: "2 failing (positions 1 and 2)", bad: ["T1", "T2"], maxChecks: 7 },
  ];
  for (const c of cases) {
    it(`${c.name}: exact culprits, innocents integrated, checks <= 2n-1`, async () => {
      const env = await setup({ tasks: 4, batchMax: 4 });
      for (const b of c.bad) env.w.bad.add(b);
      env.queue.enqueue(["T1", "T2", "T3", "T4"]);
      await env.until(() => ["T1", "T2", "T3", "T4"].every(id => env.state(id) === "integrated" || env.state(id) === "failed") && env.quiet());
      for (const id of ["T1", "T2", "T3", "T4"]) {
        expect(env.state(id), id).toBe(c.bad.includes(id) ? "failed" : "integrated");
      }
      expect(env.w.tasksAt(env.w.tip())).toEqual(["T1", "T2", "T3", "T4"].filter(id => !c.bad.includes(id)));
      expect(env.w.checkLog.length).toBeLessThanOrEqual(c.maxChecks);
      // every failed task has the exact failing id on its ISE
      const ends = (await env.events()).filter(isStep).filter(e => e.edge === "end" && e.result === "failed" && e.entry.kind !== "phase-suite");
      const withIds = ends.filter(e => e.failingIds.length > 0 && e.closes !== undefined);
      for (const b of c.bad) expect(withIds.some(e => e.failingIds.includes(`test:${b}`)), b).toBe(true);
      env.assertInvariants();
      await env.queue.dispose();
    });
  }

  it("culprit at position 2 of 4 costs exactly 4 checks", async () => {
    const env = await setup({ tasks: 4, batchMax: 4 });
    env.w.bad.add("T2");
    env.queue.enqueue(["T1", "T2", "T3", "T4"]);
    await env.until(() => env.state("T4") === "integrated" && env.quiet());
    expect(env.w.checkLog).toHaveLength(4);
    expect(env.state("T2")).toBe("failed");
    env.assertInvariants();
    await env.queue.dispose();
  });

  it("a clean batch of 4 is one check and one fast-forward; one row-30 closes the entry", async () => {
    const env = await setup({ tasks: 4, batchMax: 4 });
    env.queue.enqueue(["T1", "T2", "T3", "T4"]);
    await env.until(() => env.state("T4") === "integrated" && env.quiet());
    expect(env.w.checkLog).toHaveLength(1);
    expect(env.w.reflog).toHaveLength(1);
    expect(await env.steps("batch")).toEqual([
      "batch:rebase:start", "batch:rebase:end/ok", "batch:batch-checks:start", "batch:batch-checks:end/ok", "batch:fast-forward:start",
      "batch:fast-forward:end/ok",
    ]);
    expect(env.w.checkLog[0]?.slot).toBe("slot-4"); // checks run in the slot of the last task
    env.assertInvariants();
    await env.queue.dispose();
  });

  it("a batch never exceeds batchMax; the rest is a second entry", async () => {
    const env = await setup({ tasks: 3, batchMax: 2 });
    env.queue.enqueue(["T1", "T2", "T3"]);
    await env.until(() => env.state("T3") === "integrated" && env.quiet());
    const kinds = (await env.events()).filter(isStep).filter(e => e.edge === "start" && e.step === "rebase").map(e => e.entry.kind);
    expect(kinds).toEqual(["batch", "task"]);
    env.assertInvariants();
    await env.queue.dispose();
  });

  it("M17: a conflict with a batch-mate defers the task; it is not blamed and integrates afterwards", async () => {
    const env = await setup({ tasks: 3, batchMax: 4 });
    env.w.conflictOnMate.add("T2");
    env.queue.enqueue(["T1", "T2", "T3"]);
    await env.until(() => ["T1", "T2", "T3"].every(id => env.state(id) === "integrated") && env.quiet());
    expect(env.w.tasksAt(env.w.tip())).toEqual(["T1", "T3", "T2"]);
    expect(env.listener.calls.filter(c => c.startsWith("conflict:"))).toEqual([]);
    expect(env.w.checkLog).toHaveLength(2);
    env.assertInvariants();
    await env.queue.dispose();
  });

  it("a batch task conflicting with the head is terminal for that task only; the others integrate", async () => {
    const env = await setup({ tasks: 3, batchMax: 4 });
    env.w.conflictOnHead.add("T1");
    env.queue.enqueue(["T1", "T2", "T3"]);
    await env.until(() => env.state("T3") === "integrated" && env.quiet());
    expect(env.state("T1")).toBe("conflict");
    expect(env.state("T2")).toBe("integrated");
    expect(env.w.tasksAt(env.w.tip())).toEqual(["T2", "T3"]);
    env.assertInvariants();
    await env.queue.dispose();
  });
});

describe("post-rebase checkout reuse", () => {
  it("does not retry/reset a failed prepare while immutable reads still hold the slot cwd", async () => {
    const env = await setup();
    let releaseShow!: () => void, releaseDiff!: () => void;
    const showGate = new Promise<void>(resolve => { releaseShow = resolve; });
    const diffGate = new Promise<void>(resolve => { releaseDiff = resolve; });
    const igit: IntegrateGit = env.igit;
    vi.spyOn(igit, "showFile").mockImplementation(async (_cwd, _commit, path) => {
      if (path === "package.json") throw new Error("show failed");
      await showGate;
      return null;
    });
    vi.spyOn(env.igit, "diffNameStatus").mockImplementation(async () => { await diffGate; return []; });
    const clean = vi.spyOn(env.pool, "cleanForChecks").mockRejectedValue(new Error("prepare failed"));
    const reset = vi.spyOn(env.pool, "reset");
    const checks = createIntegrationChecks({ ledger: () => env.ledger, pool: env.pool, git: env.git, igit: env.igit,
      clock: env.clock, logger: env.logger, guard: env.guard, background: new BackgroundRuns(),
      resolver: { resolve: async () => { throw new Error("unexpected resolve"); } },
      spawn: async () => { throw new Error("unexpected spawn"); },
    });
    const completed: CheckResult[] = [];
    const run = vi.spyOn(env.checks, "run").mockImplementation(async req => {
      const result = await checks.run(req);
      completed.push(result);
      return result;
    });
    env.queue.enqueue(["T1"]);
    try {
      await env.until(() => clean.mock.calls.length > 0);
      // stack() resets the slot before its rebase; no further reset (a retry) may start while the reads hold the cwd.
      const resetsBeforeFailure = reset.mock.calls.length;
      expect(completed).toEqual([]);
      expect(run).toHaveBeenCalledTimes(1);
      releaseShow();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(completed).toEqual([]);
      expect(run).toHaveBeenCalledTimes(1);
      expect(reset).toHaveBeenCalledTimes(resetsBeforeFailure);
    } finally { releaseShow(); releaseDiff(); }
    await env.until(() => env.ledger.status === "paused");
    expect(completed).toHaveLength(3);
    for (const result of completed) expect(result).toMatchObject({ verdict: "error", reason: "prepare", message: expect.stringContaining("prepare failed") });
    expect(env.w.tip()).toBe(env.w.base);
    env.assertInvariants();
    await env.queue.dispose();
  });

  it.each([1, 4])("offers reuse for the same slot and candidate just rebased by the queue (%s tasks)", async tasks => {
    const env = await setup({ tasks });
    const run = vi.spyOn(env.checks, "run");
    const ids = Array.from({ length: tasks }, (_, i) => `T${i + 1}`);
    env.queue.enqueue(ids);
    await env.until(() => ids.every(id => env.state(id) === "integrated") && env.quiet());
    expect(run).toHaveBeenCalledTimes(1);
    const req = run.mock.calls[0]![0];
    expect(req.reuseCheckout).toBe(true);
    expect(req.slot.slot).toBe(`slot-${tasks}`);
    expect(req.candidate).toBe(env.w.slotCommit.get(req.slot.slot));
    env.assertInvariants();
  });

  it.each(["spawn", "preempted"] as const)("consumes checkout reuse before a %s retry", async reason => {
    const env = await setup();
    const run = vi.spyOn(env.checks, "run");
    env.w.checkScript.push(errorResult(reason));
    env.queue.enqueue(["T1"]);
    await env.until(() => env.state("T1") === "integrated" && env.quiet());
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]![0].reuseCheckout).toBe(true);
    expect(run.mock.calls[1]![0]).not.toHaveProperty("reuseCheckout");
    env.assertInvariants();
  });

  it("does not offer reuse after a rebase abort leaves the slot away from the stacked candidate", async () => {
    const env = await setup({ tasks: 2 });
    const run = vi.spyOn(env.checks, "run");
    env.w.conflictOnMate.add("T2");
    env.queue.enqueue(["T1", "T2"]);
    await env.until(() => env.state("T2") === "integrated" && env.quiet());
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]![0]).not.toHaveProperty("reuseCheckout");
    expect(run.mock.calls[1]![0].reuseCheckout).toBe(true); // a fresh successful stack of the deferred task
    env.assertInvariants();
  });

  it("never offers checkout reuse to bisect checks from halve, but permits a freshly restacked remainder", async () => {
    const env = await setup({ tasks: 4 });
    const requests: Array<{ step: IntegrationStep | undefined; req: CheckRequest }> = [];
    const run = env.checks.run.bind(env.checks);
    vi.spyOn(env.checks, "run").mockImplementation(async req => {
      requests.push({ step: env.writer.openIntegration().find(o => o.entry.kind === "batch")?.step, req });
      return run(req);
    });
    env.w.bad.add("T2");
    env.queue.enqueue(["T1", "T2", "T3", "T4"]);
    await env.until(() => env.state("T4") === "integrated" && env.quiet());
    expect(requests[0]).toMatchObject({ step: "batch-checks", req: { reuseCheckout: true } });
    const probes = requests.filter(r => r.step === "bisect");
    expect(probes).toHaveLength(2);
    for (const { req } of probes) expect(req).not.toHaveProperty("reuseCheckout");
    expect(requests.at(-1)).toMatchObject({ step: "batch-checks", req: { reuseCheckout: true } });
    env.assertInvariants();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// M13a / M13b / M36 / M7: infrastructure errors and halts
// ---------------------------------------------------------------------------------------------------------------

describe("infrastructure (M13a, M13b, M36)", () => {
  it("3 tries then pause: status paused, critical inbox, entry open, branch unchanged", async () => {
    const env = await setup({ tasks: 1 });
    env.w.checkScript.push(errorResult("spawn"), errorResult("spawn"), errorResult("spawn"));
    env.queue.enqueue(["T1"]);
    await env.until(() => env.ledger.status === "paused");
    expect(env.w.checkLog).toHaveLength(3);
    expect(env.ledger.inbox.some(i => i.severity === "critical" && i.kind === "failure")).toBe(true);
    expect(env.state("T1")).toBe("integrating");
    expect(env.writer.openIntegration()).toHaveLength(1);
    expect(env.w.tip()).toBe(env.w.base);
    expect(env.listener.inbox).toHaveLength(1);
    env.assertInvariants();
    await env.queue.dispose();
  });

  it("M36: once the plan runs again the stalled entry is rolled back (reason stalled), requeued and integrated", async () => {
    const env = await setup({ tasks: 1 });
    env.w.checkScript.push(errorResult("spawn"), errorResult("spawn"), errorResult("spawn"));
    env.queue.enqueue(["T1"]);
    await env.until(() => env.ledger.status === "paused");
    await env.writer.append([{ type: "status-changed", from: "paused", to: "running", reason: "unpause" }]);
    env.clock.fire(); // the stalled poll timer
    await env.until(() => env.state("T1") === "integrated" && env.quiet());
    const rb = (await env.events()).filter(isStep).find(e => e.step === "rollback" && e.edge === "start");
    expect(JSON.parse(rb?.detail ?? "{}")).toMatchObject({ reason: "stalled" });
    env.assertInvariants();
    await env.queue.dispose();
  });

  it("QA-3.2-3: a pause (M13a) or a halt (M13b) releases the repo lock", async () => {
    const env = await setup({ tasks: 2, batchMax: 1 });
    env.w.checkScript.push(errorResult("spawn"), errorResult("spawn"), errorResult("spawn"));
    env.queue.enqueue(["T1"]);
    await env.until(() => env.ledger.status === "paused", "paused");
    expect(env.locks.held).toBe(false);
    await unpause(env);
    await env.until(() => env.state("T1") === "integrated" && env.quiet(), "T1 integrated after the unpause");
    expect(env.locks.held).toBe(false);
    env.w.casFails = true;
    env.queue.enqueue(["T2"]);
    await env.until(() => env.ledger.status === "paused", "halted");
    expect(env.locks.held).toBe(false);
    expect(env.w.violations).toEqual([]);
  });

  it("QA-3.2-3: two plans on one repository: a paused plan does not block the other plan's lane (real lock factory)", async () => {
    const env = await setup({ tasks: 1, resume: false });
    const root = await mkdtemp(join(tmpdir(), "omr-integrate-lock2-"));
    lockRoots.push(root);
    const factory = createRepoLockFactory({ stateRoot: root, clock: env.clock, pid: 100, hostname: "host-a", isPidAlive: () => true });
    env.locksOverride = factory;
    await env.restart();
    await env.queue.resume();
    env.w.checkScript.push(errorResult("spawn"), errorResult("spawn"), errorResult("spawn"));
    env.queue.enqueue(["T1"]);
    await env.until(() => env.ledger.status === "paused", "paused");
    // The second plan's queue on the same repo.key takes the lock for its own entry while this plan is paused.
    const other = await Promise.race([
      factory.acquire(env.ledger.repo.key, { planId: "plan-two", entryId: null }, new AbortController().signal),
      realPause(10_000).then(() => null),
    ]);
    expect(other).not.toBeNull();
    await other?.release();
    await unpause(env);
    await env.until(() => env.state("T1") === "integrated" && env.quiet(), "T1 integrated after the unpause");
    env.assertInvariants();
  });

  it("QA-3.2-3: abort() while the lane waits for the repo lock ends the wait (the lane's wait is cancellable)", async () => {
    const env = await setup({ tasks: 1 });
    let release!: () => void;
    const blocked = new Promise<RepoLock>((_resolve, reject) => {
      release = () => reject(new ExecutorError("E_DISPOSED", "wait aborted", null));
    });
    const waits: AbortSignal[] = [];
    const locks: RepoLockFactory = env.locks;
    locks.acquire = async (_key, _holder, signal) => {
      waits.push(signal);
      if (waits.length === 1) {
        signal.addEventListener("abort", () => release(), { once: true });
        return blocked;
      }
      return { lost: new AbortController().signal, release: async () => undefined };
    };
    env.queue.enqueue(["T1"]);
    await env.until(() => waits.length === 1, "lane waiting");
    await env.queue.abort();
    expect(waits[0]?.aborted).toBe(true);
    expect(env.state("T1")).toBe("verified");
    expect(env.writer.openIntegration()).toEqual([]);
  });

  it("QA-3.2-4: a lost repo lock halts before the next git write (no merge, no CAS)", async () => {
    const env = await setup({ tasks: 1 });
    const lost = new AbortController();
    env.locks.acquire = async () => ({ lost: lost.signal, release: async () => undefined });
    env.w.afterCheck = () => { lost.abort(); };
    env.queue.enqueue(["T1"]);
    await env.until(() => env.ledger.status === "paused", "halted");
    expect(env.w.writes.some(w => w.op === "mergeFfOnly" || w.op === "branchForce")).toBe(false);
    expect(env.w.tip()).toBe(env.w.base);
    expect(env.ledger.inbox[env.ledger.inbox.length - 1]?.text).toContain("lock");
    expect(env.state("T1")).toBe("integrating");
    env.assertInvariants();
  });

  it("QA-3.2-5: both lanes stalled at once: each lane's entry is kept and rolled back after the unpause", async () => {
    const env = await setup({ tasks: 2, batchMax: 1, mutate: l => {
      l.phases.push({ id: "p2", title: "Phase 2", wave: "w1", dependsOn: [], gate: "pending", qaRound: 1, paused: false, tag: null });
      l.waves[0]?.phases.push("p2"); // a phase must be listed by its wave (valid draft)
      const t2 = l.tasks.T2;
      if (t2 !== undefined) t2.phase = "p2";
    } });
    let openGate!: () => void;
    env.suite.runGate = new Promise<void>(r => { openGate = r; });
    env.suite.resolution = { kind: "runs", commands: [] };
    let suiteErr = true;
    env.suite.onRun = () => suiteErr ? { kind: "error", reason: "spawn", message: "suite spawn failed" } : { kind: "passed" };
    env.queue.enqueue(["T1"]);
    await env.until(() => env.state("T1") === "integrated" && env.suite.runs.length === 1, "suite running");
    env.w.checkScript.push(errorResult("spawn"), errorResult("spawn"), errorResult("spawn"));
    env.queue.enqueue(["T2"]);
    await env.until(() => env.ledger.status === "paused", "serial paused");
    openGate();
    await env.until(() => env.writer.openIntegration().length === 2 && env.ledger.inbox.filter(i => i.severity === "critical").length === 2, "both stalled");
    suiteErr = false;
    env.suite.runGate = null;
    await unpause(env);
    await env.until(() => env.state("T2") === "integrated" && env.phase("p1").gate === "awaiting-qa" && env.quiet(), "both rolled back and redone");
    const rbs = (await env.events()).filter(isStep).filter(e => e.step === "rollback" && e.edge === "start").map(e => e.entry.kind);
    expect(rbs.sort()).toEqual(["phase-suite", "task"]);
    env.assertInvariants();
  });

  it("QA-3.2-21: a stalled sub-batch is rolled back to the tip of the task owning the slot, not the batch's last task", async () => {
    const env = await setup({ tasks: 3, batchMax: 4 });
    env.w.conflictOnMate.add("T2");
    env.w.checkScript.push(PASS, errorResult("spawn"), errorResult("spawn"), errorResult("spawn"));
    env.queue.enqueue(["T1", "T2", "T3"]);
    await env.until(() => env.ledger.status === "paused", "paused on T2's checks");
    expect([env.state("T1"), env.state("T2"), env.state("T3")]).toEqual(["integrated", "integrating", "integrated"]);
    const t2Tip = env.w.branches.get(`refs/heads/omr/${PLAN_ID}/t/T2`);
    const t3Tip = env.w.branches.get(`refs/heads/omr/${PLAN_ID}/t/T3`);
    const before = env.pool.resets.length;
    await unpause(env);
    await env.until(() => env.state("T2") === "integrated" && env.quiet(), "T2 integrated");
    expect(env.pool.resets[before]).toEqual({ slot: "slot-2", commit: t2Tip });
    expect(env.pool.resets.slice(before).some(r => r.slot === "slot-2" && r.commit === t3Tip)).toBe(false);
    env.assertInvariants();
  });

  it("a preempted check does not count toward the 3 tries", async () => {
    const env = await setup({ tasks: 1 });
    env.w.checkScript.push(errorResult("preempted"), errorResult("preempted"), errorResult("preempted"), errorResult("preempted"));
    env.queue.enqueue(["T1"]);
    await env.until(() => env.state("T1") === "integrated");
    expect(env.w.checkLog.length).toBe(5);
    expect(env.ledger.status).toBe("running");
    env.assertInvariants();
    await env.queue.dispose();
  });

  it("a task cancelled outside the queue is never dequeued; the other task integrates", async () => {
    const env = await setup({ tasks: 2, batchMax: 1 });
    // A cancelled task holds no slot (the ledger refuses `slot-forbidden`), so the slot goes in the same batch.
    await env.writer.append([
      { type: "task-transition", taskId: "T1", from: "verified", to: "cancelled", trigger: "abort", detail: null },
      { type: "task-slot", taskId: "T1", slot: null, branch: `omr/${PLAN_ID}/t/T1` },
    ]);
    env.queue.enqueue(["T1", "T2"]);
    expect(env.queue.queued()).toEqual(["T2"]);
    await env.until(() => env.state("T2") === "integrated" && env.quiet());
    expect(env.state("T1")).toBe("cancelled");
    expect(env.w.integratedCount()).toEqual({ T2: 1 });
    expect(env.logger.warnings.some(w => w.includes("ignoring enqueue of T1"))).toBe(true);
    env.assertInvariants();
    await env.queue.dispose();
  });

  it("CAS failure on the branch halts (M13b): paused, critical inbox, branch unchanged, I1 holds", async () => {
    const env = await setup({ tasks: 1 });
    env.w.casFails = true;
    env.queue.enqueue(["T1"]);
    await env.until(() => env.ledger.status === "paused");
    expect(env.w.tip()).toBe(env.w.base);
    expect(env.ledger.inbox.some(i => i.severity === "critical" && i.text.includes("compare-and-swap"))).toBe(true);
    expect(env.state("T1")).toBe("integrating");
    expect((await env.steps("task")).slice(-1)).toEqual(["task:fast-forward:end/refused"]);
    env.assertInvariants();
    await env.queue.dispose();
  });

  it("a refused merge --ff-only halts", async () => {
    const env = await setup({ tasks: 1 });
    env.w.ffRefused = true;
    env.queue.enqueue(["T1"]);
    await env.until(() => env.ledger.status === "paused");
    expect(env.ledger.inbox.some(i => i.text.includes("--ff-only"))).toBe(true);
    expect(env.w.tip()).toBe(env.w.base);
    env.assertInvariants();
    await env.queue.dispose();
  });

  it("a branch that moved during the checks halts before any write to it", async () => {
    const env = await setup({ tasks: 1 });
    env.w.afterCheck = () => {
      const stray = env.w.commit(env.w.base, null);
      env.w.passed.add(stray.sha);
      env.w.branches.set(INT_REF, stray.sha);
    };
    env.queue.enqueue(["T1"]);
    await env.until(() => env.ledger.status === "paused");
    expect(env.ledger.inbox.some(i => i.text.includes("not at the journaled head"))).toBe(true);
    expect(env.w.writes.some(x => x.op === "branchForce")).toBe(false);
    env.assertInvariants();
    await env.queue.dispose();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Phase suite, revert, gates (4.3-4.5)
// ---------------------------------------------------------------------------------------------------------------

const RUNS: SuiteResolution = {
  kind: "runs",
  commands: [{ label: "tests", file: "node", args: ["t/run.js"], source: "package-script", ref: null }],
};

function culpritOf(taskId: string, ids: string[] = [`test:${taskId}`]): (req: SuiteRunRequest) => SuiteVerdict {
  return req => {
    const range = req.ranges.find(r => r.taskId === taskId);
    if (range === undefined) return { kind: "passed" };
    return { kind: "culprit", range: { ...range }, ids, files: [`t/${taskId}.test.ts`] };
  };
}

async function suiteEnv(tasks: number, onRun: (req: SuiteRunRequest) => SuiteVerdict): Promise<Env> {
  const env = await setup({ tasks, batchMax: 1 });
  env.suite.resolution = RUNS;
  env.suite.onRun = onRun;
  env.queue.enqueue(Array.from({ length: tasks }, (_, i) => `T${i + 1}`));
  return env;
}

describe("phase suite and revert", () => {
  it("culprit at position 3 of 6: revert checked then fast-forwarded, culprit reverted, gate back to pending (row-34 order)", async () => {
    const env = await suiteEnv(6, culpritOf("T3"));
    await env.until(() => env.state("T3") === "reverted" && env.phase().gate === "pending" && env.quiet(), "revert completion");
    expect(env.suite.runs).toHaveLength(1);
    expect(env.suite.runs[0]?.ranges.map(r => r.taskId)).toEqual(["T1", "T2", "T3", "T4", "T5", "T6"]);
    expect(env.suite.reverts).toHaveLength(1);
    expect(env.suite.reverts[0]?.culprit.taskId).toBe("T3");
    expect(env.suite.reverts[0]?.slot.slot).toBe("integration");
    expect(env.suite.reverts[0]?.regression.ids).toEqual(["test:T3"]);
    expect(env.w.tasksAt(env.w.tip())).toEqual(["T1", "T2", "T4", "T5", "T6"]);
    const last = env.w.reflog[env.w.reflog.length - 1];
    expect(last?.to).toBe(env.w.tip());
    expect(env.w.passed.has(env.w.tip())).toBe(true);
    expect(await env.steps("phase-suite")).toEqual(["phase-suite:phase-suite:start", "phase-suite:phase-suite:end/failed"]);
    expect(await env.steps("revert")).toEqual([
      "revert:revert-build:start", "revert:revert-build:end/ok", "revert:revert-fast-forward:start", "revert:revert-fast-forward:end/ok",
    ]);
    expect(env.ledger.integration.head).toBe(env.w.tip());
    expect(env.ledger.tasks.T3?.attempts[0]?.context).toContain("Reverted from the integration branch");
    const gates = env.listener.calls.filter(c => c.startsWith("gate:"));
    expect(gates).toEqual(["gate:p1:suite-running", "gate:p1:suite-failed", "gate:p1:pending"]);
    expect(env.listener.calls).toContain("reverted:T3");
    expect(env.locks.held).toBe(false);
    env.assertInvariants();
    await env.queue.dispose();
  });

  it("the suite passing opens the QA gate and starts no revert", async () => {
    const env = await suiteEnv(2, () => ({ kind: "passed" }));
    await env.until(() => env.phase().gate === "awaiting-qa" && env.quiet());
    expect(env.suite.reverts).toHaveLength(0);
    expect(await env.steps("phase-suite")).toEqual(["phase-suite:phase-suite:start", "phase-suite:phase-suite:end/ok"]);
    expect(env.listener.calls.filter(c => c.startsWith("gate:"))).toEqual(["gate:p1:suite-running", "gate:p1:awaiting-qa"]);
    env.assertInvariants();
    await env.queue.dispose();
  });

  it("flaky suite failure: inbox note (K-), gate opens, no revert, branch untouched", async () => {
    const env = await suiteEnv(2, () => ({ kind: "flaky", ids: ["test:T2"] }));
    await env.until(() => env.phase().gate === "awaiting-qa" && env.quiet());
    const tipBefore = env.w.tip();
    expect(env.ledger.inbox.map(i => i.id)).toEqual(["K-1"]);
    expect(env.ledger.inbox[0]).toMatchObject({ kind: "flaky", severity: "info" });
    expect(await env.steps("phase-suite")).toEqual(["phase-suite:phase-suite:start", "phase-suite:phase-suite:end/flaky"]);
    expect(env.suite.reverts).toHaveLength(0);
    expect(env.w.tip()).toBe(tipBefore);
    expect(env.w.tasksAt(tipBefore)).toEqual(["T1", "T2"]);
    env.assertInvariants();
    await env.queue.dispose();
  });

  it("pre-existing failures (fail at the phase base) are not bisected: info note and the gate opens", async () => {
    const env = await suiteEnv(2, () => ({ kind: "pre-existing", ids: ["test:old"] }));
    await env.until(() => env.phase().gate === "awaiting-qa" && env.quiet());
    expect(env.ledger.inbox[0]).toMatchObject({ kind: "failure", severity: "info" });
    expect(env.ledger.inbox[0]?.text).toContain("test:old");
    expect(await env.steps("phase-suite")).toEqual(["phase-suite:phase-suite:start", "phase-suite:phase-suite:end/pre-existing"]);
    expect(env.suite.reverts).toHaveLength(0);
    env.assertInvariants();
    await env.queue.dispose();
  });

  it("an unattributable failure pauses the phase with a critical inbox item; no revert", async () => {
    const env = await suiteEnv(2, () => ({ kind: "unattributed", ids: ["test:x"], reason: "no-base" }));
    await env.until(() => env.phase().paused && env.quiet());
    expect(env.ledger.inbox[0]).toMatchObject({ kind: "failure", severity: "critical" });
    expect(env.suite.reverts).toHaveLength(0);
    expect(env.w.tasksAt(env.w.tip())).toEqual(["T1", "T2"]);
    env.assertInvariants();
    await env.queue.dispose();
  });

  for (const [reason, says] of [["base-unparsed", "could not be parsed"], ["outside", "outside the phase's task ranges"], ["no-base", "no recorded base"],
    ["base-overlap", "cannot be probed apart"]] as const) {
    it(`an unattributed verdict (${reason}) names its reason in the critical item and pauses the phase`, async () => {
      const env = await suiteEnv(1, () => ({ kind: "unattributed", ids: ["test:x"], reason }));
      await env.until(() => env.phase().paused && env.quiet());
      expect(env.ledger.inbox[0]?.text).toContain(says);
      expect(env.ledger.inbox[0]?.text).toContain(`(${reason})`);
      expect(env.phase().gate).toBe("suite-running");
      expect(env.suite.reverts).toHaveLength(0);
      expect(env.w.tasksAt(env.w.tip())).toEqual(["T1"]);
      env.assertInvariants();
    });
  }

  it("a suite that cannot run (error) pauses the plan (M13a) and leaves the entry open", async () => {
    const env = await suiteEnv(1, () => ({ kind: "error", reason: "spawn", message: "no node" }));
    await env.until(() => env.ledger.status === "paused");
    expect(env.writer.openIntegration().map(o => o.entry.kind)).toEqual(["phase-suite"]);
    expect(env.ledger.inbox.some(i => i.severity === "critical")).toBe(true);
    env.assertInvariants();
    await env.queue.dispose();
  });

  it("a refused suite resolution pauses the phase (suite-unresolvable)", async () => {
    const env = await setup({ tasks: 1, batchMax: 1 });
    env.suite.resolution = { kind: "refused", reason: "script test-files is not allowlisted", ref: { script: "test-files", args: [] } };
    env.queue.enqueue(["T1"]);
    await env.until(() => env.phase().paused);
    expect(env.ledger.inbox[0]?.text).toContain("test-files");
    expect(env.suite.runs).toHaveLength(0);
    env.assertInvariants();
    await env.queue.dispose();
  });

  it("revert that conflicts: culprit parked (stays integrated), phase paused, branch unchanged, gate stays suite-failed", async () => {
    const env = await suiteEnv(4, culpritOf("T2"));
    env.suite.revertScript.push({ kind: "conflict", at: hex(999), paths: ["src/T2.ts"] });
    await env.until(() => env.phase().paused && env.quiet(), "revert-conflict pause");
    const tip = env.w.tip();
    expect(env.state("T2")).toBe("integrated");
    expect(env.phase().gate).toBe("suite-failed");
    expect(env.w.tasksAt(tip)).toEqual(["T1", "T2", "T3", "T4"]);
    expect(env.w.reflog).toHaveLength(4);
    expect(await env.steps("revert")).toEqual(["revert:revert-build:start", "revert:revert-build:end/conflict"]);
    const item = env.ledger.inbox.find(i => i.taskId === "T2");
    expect(item).toMatchObject({ kind: "failure", severity: "critical" });
    expect(item?.text).toContain("git -C");
    expect(item?.text).toContain("src/T2.ts");
    env.assertInvariants();

    // unpause -> M25: no revert entry pending, so the suite is rerun (suite-rerun) and now passes
    env.suite.onRun = () => ({ kind: "passed" });
    await env.writer.append([{ type: "phase-paused", phaseId: "p1", paused: false, reason: "unpause" }]);
    await env.queue.checkPhase("p1");
    await env.until(() => env.phase().gate === "awaiting-qa" && env.quiet(), "suite rerun");
    expect(env.suite.runs).toHaveLength(2);
    expect(env.w.tip()).toBe(tip);
    env.assertInvariants();
    await env.queue.dispose();
  });

  it("a revert whose checks still fail (insufficient): branch unchanged, phase paused", async () => {
    const env = await suiteEnv(3, culpritOf("T2"));
    env.suite.revertScript.push({ kind: "failed", ids: ["test:T3"], files: ["t/T3.test.ts"], output: "still red" });
    await env.until(() => env.phase().paused && env.quiet());
    expect(env.state("T2")).toBe("integrated");
    expect(env.w.tasksAt(env.w.tip())).toEqual(["T1", "T2", "T3"]);
    expect(env.ledger.inbox.find(i => i.taskId === "T2")?.text).toContain("did not make the integration checks pass");
    expect((await env.steps("revert")).slice(-1)).toEqual(["revert:revert-build:end/failed"]);
    env.assertInvariants();
    await env.queue.dispose();
  });

  it("a revert runner error pauses the plan and leaves the revert entry open", async () => {
    const env = await suiteEnv(2, culpritOf("T1"));
    env.suite.revertScript.push({ kind: "error", reason: "spawn", message: "no git" });
    await env.until(() => env.ledger.status === "paused");
    expect(env.writer.openIntegration().map(o => o.entry.kind)).toEqual(["revert"]);
    expect(env.w.tasksAt(env.w.tip())).toEqual(["T1", "T2"]);
    env.assertInvariants();
    await env.queue.dispose();
  });

  it("checkPhase is idempotent and starts nothing when the plan is not running or the phase is paused", async () => {
    const env = await setup({ tasks: 1, batchMax: 1, resume: true });
    env.suite.resolution = RUNS;
    await env.queue.checkPhase("p1"); // gate pending but the phase has an unintegrated task
    await env.queue.checkPhase("nope");
    expect(env.suite.runs).toHaveLength(0);
    await env.writer.append([{ type: "phase-paused", phaseId: "p1", paused: true, reason: "test" }]);
    await env.queue.checkPhase("p1");
    expect(env.suite.runs).toHaveLength(0);
    env.assertInvariants();
    await env.queue.dispose();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Tag (4.6) and land (4.7)
// ---------------------------------------------------------------------------------------------------------------

describe("tag entry", () => {
  const passedGate = (l: LedgerV1): void => { const p = l.phases[0]; if (p !== undefined) p.gate = "passed"; };

  it("a passed phase without a tag gets tagged once (phase-tagged), tag at the integration head", async () => {
    const env = await setup({ tasks: 0, mutate: passedGate });
    await env.until(() => env.phase().tag !== null && env.quiet());
    expect(env.phase().tag).toBe(`omr/${PLAN_ID}/phase/p1`);
    expect(env.lander.tags.get(`omr/${PLAN_ID}/phase/p1`)).toBe(env.w.base);
    expect(await env.steps("tag")).toEqual(["tag:tag:start", "tag:tag:end/ok"]);
    await env.queue.checkPhase("p1");
    expect(await env.steps("tag")).toHaveLength(2);
    env.assertInvariants();
    await env.queue.dispose();
  });

  it("a tag that exists elsewhere is never moved: info inbox, tag stays null", async () => {
    const env = await setup({ tasks: 0, resume: false, mutate: passedGate });
    env.lander.tags.set(`omr/${PLAN_ID}/phase/p1`, hex(777));
    await env.queue.resume();
    await env.until(() => env.ledger.inbox.length === 1 && env.quiet());
    expect(env.phase().tag).toBeNull();
    expect(env.lander.tags.get(`omr/${PLAN_ID}/phase/p1`)).toBe(hex(777));
    expect(await env.steps("tag")).toEqual(["tag:tag:start", "tag:tag:end/refused"]);
    env.assertInvariants();
    await env.queue.dispose();
  });

  it("tag errors retry 3 times then pause the plan", async () => {
    const env = await setup({ tasks: 0, resume: false, mutate: passedGate });
    env.lander.tagOutcome = { kind: "error", message: "ref locked" };
    await env.queue.resume();
    await env.until(() => env.ledger.status === "paused");
    expect((await env.steps("tag")).filter(s => s === "tag:tag:start")).toHaveLength(3);
    expect(env.phase().tag).toBeNull();
    env.assertInvariants();
    await env.queue.dispose();
  });
});

describe("land (4.7)", () => {
  const completed = (l: LedgerV1): void => { l.status = "completed"; l.config.land = "ff-when-clean"; };

  it("rejects with E_PLAN_STATE unless the plan is completed", async () => {
    const env = await setup({ tasks: 0 });
    await expect(env.queue.land()).rejects.toMatchObject({ code: "E_PLAN_STATE" });
    await env.queue.dispose();
  });

  it("clean + ancestor: fast-forwards the base branch, journals land start/ok, nothing else changes", async () => {
    const env = await setup({ tasks: 0, mutate: completed });
    const r = await env.queue.land();
    expect(r).toEqual({ landed: true, inbox: null });
    expect(env.lander.landCalls).toHaveLength(1);
    expect(env.lander.landCalls[0]).toMatchObject({ toplevel: TOPLEVEL, baseBranch: "main", candidate: env.w.base });
    expect(await env.steps("land")).toEqual(["land:land:start", "land:land:end/ok"]);
    expect(env.w.landed).toBe(true);
    env.assertInvariants();
    await env.queue.dispose();
  });

  it("is idempotent: a second land() with the base branch at the head journals nothing", async () => {
    const env = await setup({ tasks: 0, mutate: completed });
    await env.queue.land();
    const seq = env.ledger.seq;
    // the lander double moved main to the candidate (== base here); make the head differ to prove the check is real
    expect(await env.queue.land()).toEqual({ landed: true, inbox: null });
    expect(env.ledger.seq).toBe(seq);
    expect(env.lander.landCalls).toHaveLength(1);
    await env.queue.dispose();
  });

  const refusals: Array<{ name: string; refusal: LandRefusal }> = [
    { name: "dirty", refusal: { reason: "dirty", paths: ["README.md"] } },
    { name: "diverged", refusal: { reason: "diverged", baseTip: hex(555) } },
    { name: "not checked out", refusal: { reason: "not-checked-out", head: "feature" } },
    { name: "ignored overwrite", refusal: { reason: "ignored-overwrite", paths: ["dist/out.js"] } },
    { name: "toplevel mismatch", refusal: { reason: "toplevel-mismatch", actual: "C:/elsewhere" } },
    { name: "base missing", refusal: { reason: "base-missing" } },
  ];
  for (const c of refusals) {
    it(`${c.name} (inspect): blocking landing item with commands, no fast-forward, nothing changes`, async () => {
      const env = await setup({ tasks: 0, mutate: completed });
      env.lander.inspectResult = { ok: false, refusal: c.refusal, baseTip: hex(1) };
      const mainBefore = env.w.branches.get(MAIN_REF);
      const r = await env.queue.land();
      expect(r.landed).toBe(false);
      expect(r.inbox).toMatchObject({ kind: "landing", severity: "blocking" });
      expect(r.inbox?.text).toContain(c.refusal.reason);
      expect(r.inbox?.text).toContain("git -C");
      expect(env.lander.landCalls).toHaveLength(0);
      expect(env.w.branches.get(MAIN_REF)).toBe(mainBefore);
      expect(await env.steps("land")).toEqual(["land:land:start", "land:land:end/refused"]);
      expect(env.ledger.status).toBe("completed");
      expect(env.listener.inbox).toHaveLength(1);
      env.assertInvariants();
      await env.queue.dispose();
    });
  }

  it("a refusal discovered by fastForward itself gets the same treatment", async () => {
    const env = await setup({ tasks: 0, mutate: completed });
    env.lander.landOutcome = { kind: "refused", refusal: { reason: "dirty", paths: ["a"] } };
    const r = await env.queue.land();
    expect(r.landed).toBe(false);
    expect(r.inbox?.kind).toBe("landing");
    expect(env.w.landed).toBe(false);
    await env.queue.dispose();
  });

  it("a lander error becomes a blocking item with the manual command", async () => {
    const env = await setup({ tasks: 0, mutate: completed });
    env.lander.landOutcome = { kind: "error", message: "index.lock exists" };
    const r = await env.queue.land();
    expect(r.landed).toBe(false);
    expect(r.inbox?.text).toContain("index.lock exists");
    expect(r.inbox?.text).toContain("merge --ff-only");
    await env.queue.dispose();
  });

  it("manual mode: info landing item with the command, the lander is never asked", async () => {
    const env = await setup({ tasks: 0, mutate: (l) => { l.status = "completed"; l.config.land = "manual"; } });
    const r = await env.queue.land();
    expect(r.landed).toBe(false);
    expect(r.inbox).toMatchObject({ kind: "landing", severity: "info" });
    expect(r.inbox?.text).toContain("merge --ff-only");
    expect(env.lander.inspectCalls).toHaveLength(0);
    expect(env.lander.landCalls).toHaveLength(0);
    await env.queue.dispose();
  });

  it("a moved integration branch refuses with a critical item and lands nothing", async () => {
    const env = await setup({ tasks: 0, mutate: completed });
    env.w.branches.set(INT_REF, hex(888));
    env.w.commits.set(hex(888), { sha: hex(888), parent: env.w.base, adds: null, removes: null });
    const r = await env.queue.land();
    expect(r.landed).toBe(false);
    expect(r.inbox).toMatchObject({ kind: "failure", severity: "critical" });
    expect(env.lander.inspectCalls).toHaveLength(0);
    await env.queue.dispose();
  });

  it("concurrent land() calls share one entry", async () => {
    const env = await setup({ tasks: 0, mutate: completed });
    const [a, b] = await Promise.all([env.queue.land(), env.queue.land()]);
    expect(a).toEqual(b);
    expect(env.lander.landCalls).toHaveLength(1);
    await env.queue.dispose();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// resume() (4.8) and abort() (4.9)
// ---------------------------------------------------------------------------------------------------------------

describe("resume (A1-3, A2-5, M31)", () => {
  const strayCommit = (w: World): string => {
    const c = w.commit(null, null);
    w.passed.add(c.sha);
    return c.sha;
  };

  it("halts on a moved branch with no journaled fast-forward explaining it: paused, critical inbox, nothing changed", async () => {
    const env = await setup({ tasks: 1, resume: false });
    env.w.branches.set(INT_REF, strayCommit(env.w));
    const report = await env.queue.resume();
    expect(report.halted).toBe(true);
    expect(env.ledger.status).toBe("paused");
    expect(env.ledger.inbox).toHaveLength(1);
    expect(env.ledger.inbox[0]).toMatchObject({ kind: "failure", severity: "critical" });
    expect(env.ledger.integration.head).toBe(env.w.base);
    expect(await env.steps()).toEqual([]);
    env.queue.enqueue(["T1"]);
    await env.settle();
    expect(env.state("T1")).toBe("verified");
    await env.queue.dispose();
  });

  it("a branch that moved while the plan was already paused: no status event, still one inbox item (A2-5)", async () => {
    const env = await setup({ tasks: 0, resume: false, mutate: l => { l.status = "paused"; } });
    env.w.branches.set(INT_REF, strayCommit(env.w));
    const report = await env.queue.resume();
    expect(report.halted).toBe(true);
    expect(env.ledger.status).toBe("paused");
    expect((await env.events()).filter(e => e.type === "status-changed")).toEqual([]);
    expect(env.ledger.inbox).toHaveLength(1);
    await env.queue.dispose();
  });

  it("a missing branch also halts", async () => {
    const env = await setup({ tasks: 0, resume: false });
    env.w.branches.delete(INT_REF);
    const report = await env.queue.resume();
    expect(report.halted).toBe(true);
    // QA-3.2-9 wording: the missing ref is named precisely, with the 5.1 handoff.
    expect(env.ledger.inbox[0]?.text).toContain(`The integration branch ref ${INT_REF} does not exist`);
    await env.queue.dispose();
  });

  it("an orphan (A1-3a: integrating, last entry closed rolled-back) is requeued by step 2 and integrated once", async () => {
    const env = await orphanEnv(1, 1);
    const report = await env.queue.resume();
    expect(report.rolledBack).toEqual(["T1"]);
    expect(report.entries).toEqual([]);
    expect(report.halted).toBe(false);
    await env.writer.append([{ type: "status-changed", from: "paused", to: "running", reason: "unpause" }]);
    env.queue.enqueue([]); // wakes the lanes
    await env.until(() => env.state("T1") === "integrated" && env.quiet());
    expect(env.w.integratedCount()).toEqual({ T1: 1 });
    env.assertInvariants();
  });

  it("is idempotent: a second resume() returns the same report and journals nothing", async () => {
    const env = await setup({ tasks: 1, resume: false });
    const a = await env.queue.resume();
    const seq = env.ledger.seq;
    const b = await env.queue.resume();
    expect(b).toBe(a);
    expect(env.ledger.seq).toBe(seq);
    await env.queue.dispose();
  });

  it("resume on a clean plan reports nothing and starts nothing", async () => {
    const env = await setup({ tasks: 2, resume: false });
    expect(await env.queue.resume()).toEqual({ completed: [], rolledBack: [], halted: false, entries: [] });
    expect(await env.steps()).toEqual([]);
    await env.queue.dispose();
  });

  it("a paused plan: resume rolls the open entry back (closed) but starts no new step until the plan runs again", async () => {
    const env = await setup({ tasks: 1 });
    env.w.checkScript.push(errorResult("spawn"), errorResult("spawn"), errorResult("spawn"));
    env.queue.enqueue(["T1"]);
    await env.until(() => env.ledger.status === "paused");
    await env.restart();
    const report = await env.queue.resume();
    expect(report.entries).toEqual([expect.objectContaining({ kind: "task", action: "rolled-back" })]);
    expect(env.writer.openIntegration()).toEqual([]);
    expect(env.state("T1")).toBe("integrating");
    const starts = (await env.steps("task")).filter(s => s === "task:rebase:start").length;
    await env.settle();
    expect((await env.steps("task")).filter(s => s === "task:rebase:start")).toHaveLength(starts);
    await env.writer.append([{ type: "status-changed", from: "paused", to: "running", reason: "unpause" }]);
    env.queue.enqueue([]); // wakes the lanes
    await env.until(() => env.state("T1") === "integrated" && env.quiet());
    env.assertInvariants();
    await env.queue.dispose();
  });

  it("a fast-forward that landed before the crash is completed (row 30), not repeated", async () => {
    const env = await setup({ tasks: 1 });
    env.w.crashAt = "after-branchForce";
    env.queue.enqueue(["T1"]);
    await env.until(() => env.w.dead);
    expect(env.state("T1")).toBe("integrating");
    expect(env.w.tip()).not.toBe(env.w.base);
    await env.restart();
    const report = await env.queue.resume();
    expect(report.completed).toEqual(["T1"]);
    expect(env.state("T1")).toBe("integrated");
    expect(env.ledger.integration.head).toBe(env.w.tip());
    expect(env.w.reflog).toHaveLength(1);
    expect((await env.signature()).integratedEvents).toEqual({ T1: 1 });
    env.assertInvariants();
    await env.queue.dispose();
  });
});

describe("abort (4.9)", () => {
  it("rolls back the step in flight in one row-33 batch: task cancelled, slot and lease released, queue emptied", async () => {
    const env = await setup({ tasks: 2, batchMax: 1 });
    env.w.checkGate = new Promise<void>(() => undefined); // the first check never finishes
    env.queue.enqueue(["T1", "T2"]);
    await env.until(() => env.w.checkLog.length === 1);
    const first = env.queue.abort();
    expect(env.queue.abort()).toBe(first);
    await first;
    expect(env.state("T1")).toBe("cancelled");
    expect(env.state("T2")).toBe("verified");
    expect(env.writer.openIntegration()).toEqual([]);
    expect((await env.steps("task")).slice(-4)).toEqual([
      "task:checks:start", "task:checks:end/rolled-back", "task:rollback:start", "task:rollback:end/rolled-back",
    ]);
    expect(env.pool.released).toContain("slot-1");
    expect(env.leases.released).toContain("T1");
    expect(env.queue.queued()).toEqual([]);
    expect(env.w.tip()).toBe(env.w.base);
    expect(env.locks.held).toBe(false);
    let code: unknown = null;
    try {
      env.queue.enqueue(["T2"]);
    } catch (e) {
      code = (e as { code?: unknown }).code;
    }
    expect(code).toBe("E_PLAN_STATE");
    env.assertInvariants();
    await env.queue.dispose();
  });

  it("orphans are cancelled in the same batch; gates and inbox are untouched", async () => {
    const env = await orphanEnv(2, 4);
    const inbox = env.ledger.inbox.map(i => i.id);
    const gate = env.phase().gate;
    env.pool.released.length = 0;
    env.leases.released.length = 0;
    const seqBefore = env.ledger.seq;
    await env.queue.abort();
    expect(env.state("T1")).toBe("cancelled");
    expect(env.state("T2")).toBe("cancelled");
    expect(env.ledger.inbox.map(i => i.id)).toEqual(inbox);
    expect(env.phase().gate).toBe(gate);
    expect(env.writer.openIntegration()).toEqual([]);
    const ends = (await env.events()).filter(isStep).filter(e => e.seq > seqBefore && e.edge === "end" && e.step === "rollback");
    expect(ends).toHaveLength(2); // one synthetic task entry per orphan
    expect(ends.every(e => e.entry.kind === "task" && e.closes)).toBe(true);
    expect(new Set(ends.map(e => e.batch)).size).toBe(1); // the single row-33 batch
    const cancels = env.w.journal.filter(e => e.type === "task-transition" && e.to === "cancelled");
    expect(cancels).toHaveLength(2);
    expect(env.pool.released.sort()).toEqual(["slot-1", "slot-2"]);
    expect(env.leases.released.sort()).toEqual(["T1", "T2"]);
    env.assertInvariants();
    await env.queue.dispose();
  });

  it("abort with nothing in flight writes no integration step", async () => {
    const env = await setup({ tasks: 1 });
    await env.queue.abort();
    expect(await env.steps()).toEqual([]);
    expect(env.state("T1")).toBe("verified");
    await env.queue.dispose();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// M4 lanes: a kick that lands while a lane loop is exiting is never lost (lost wake-up regression)
// ---------------------------------------------------------------------------------------------------------------
//
// The gap: a lane loop finds nothing to do and returns, but its running flag is cleared only in the `.finally` reaction,
// which is queued when the loop's promise settles. A kick that runs in between used to see the lane "running" and do
// nothing, stranding the work queued with it. Both tests land the kick exactly there: the hook fires at the queue's first
// ledger read after the lane's last job (the loop's own `laneOpen()` on the iteration that finds nothing) and queues the
// kick as a microtask, which runs after the loop returned (same synchronous run) and before the `.finally` (queued later).

describe("lanes (M4): no lost wake-up", () => {
  it("serial: an enqueue landing after the loop found nothing to do, before it cleared its running flag, still integrates", async () => {
    const env = await setup({ tasks: 1, resume: false, mutate: l => {
      const p = l.phases[0];
      if (p !== undefined) p.gate = "passed"; // resume queues a tag entry: the serial lane's only job
      const t = l.tasks.T1;
      if (t !== undefined) t.phase = null; // outside the phase; enqueued only by the hook
    } });
    let fired = false;
    // After `lander.tag` the tag job reads the ledger no more (closing batch, lock release), so the next queue read is the
    // serial loop's `laneOpen()` on its exit iteration.
    env.lander.onTag = () => {
      env.lander.onTag = null;
      env.writer.onNextRead = () => {
        queueMicrotask(() => {
          env.queue.enqueue(["T1"]);
          fired = true;
        });
      };
    };
    await env.queue.resume();
    await env.until(() => fired, "the hook", 20_000);
    await env.until(() => env.state("T1") === "integrated" && env.quiet(), "T1 integrated after a kick in the serial exit gap", 20_000);
    expect(env.phase().tag).not.toBeNull();
    expect(env.queue.queued()).toEqual([]);
    expect(env.w.integratedCount()).toEqual({ T1: 1 });
    env.assertInvariants();
  });

  it("background: a suite queued after the loop found no suite, before it cleared its running flag, still runs", async () => {
    const env = await setup({ tasks: 0, resume: false, mutate: l => {
      // p1's only task is settled (cancelled), so it is integrated and resume starts its suite (a phase with no task of its
      // own skips the suite, QA-3.2-19). p2 is `suite-running` with no open entry (the A2-1 recovery row) but paused, so
      // resume leaves it alone until the test unpauses it.
      l.tasks.D = taskNode("D", { state: "cancelled" });
      l.phases.push({ id: "p2", title: "Phase 2", wave: "w1", dependsOn: [], gate: "suite-running", qaRound: 1, paused: true, tag: null });
      l.waves[0]?.phases.push("p2");
    } });
    env.suite.resolution = RUNS;
    let release!: () => void;
    env.suite.runGate = new Promise<void>(resolve => { release = resolve; });
    let fired = false;
    // runSuite's `finally` releases `ci` after the closing batch; the next queue read is the background loop's `laneOpen()`
    // on its exit iteration. checkPhase(p2) (suite-running, no open entry) queues the suite and kicks synchronously.
    env.pool.onRelease = slot => {
      if (slot !== "ci") return;
      env.pool.onRelease = null;
      env.writer.onNextRead = () => {
        queueMicrotask(() => {
          void env.queue.checkPhase("p2");
          fired = true;
        });
      };
    };
    await env.queue.resume();
    await env.until(() => env.suite.runs.length === 1, "the p1 suite to start", 20_000);
    await env.writer.append([{ type: "phase-paused", phaseId: "p2", paused: false, reason: "unpause" }]);
    release();
    await env.until(() => fired, "the hook", 20_000);
    await env.until(() => env.phase("p2").gate === "awaiting-qa" && env.quiet(), "the p2 suite after a kick in the background exit gap", 20_000);
    expect(env.phase("p1").gate).toBe("awaiting-qa");
    expect(env.suite.runs.map(r => r.phaseId)).toEqual(["p1", "p2"]);
    env.assertInvariants();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Crash harness: the process dies right after durable append k (k = 1..N), or between the git ref writes; a new queue
// resumes and must reach the same final state with exactly one task-integrated per task (I1-I5 hold throughout).
// ---------------------------------------------------------------------------------------------------------------

interface Scenario { name: string; tasks: number; batchMax: number; bad?: string[]; suite?: boolean }
const SCENARIOS: Scenario[] = [
  { name: "two serial tasks", tasks: 2, batchMax: 1 },
  { name: "batch of 3 with a failing task (halving)", tasks: 3, batchMax: 4, bad: ["T2"] },
  { name: "suite culprit then revert", tasks: 3, batchMax: 1, suite: true },
];

type Crash = { afterAppend: number } | { at: "before-branchForce" | "after-branchForce" } | null;

async function crashRun(s: Scenario, crash: Crash): Promise<{ sig: Awaited<ReturnType<Env["signature"]>>; appends: number; crashed: boolean }> {
  const env = await setup({ tasks: s.tasks, batchMax: s.batchMax });
  for (const b of s.bad ?? []) env.w.bad.add(b);
  if (s.suite === true) {
    env.suite.resolution = RUNS;
    env.suite.onRun = culpritOf("T2");
  }
  const ids = Array.from({ length: s.tasks }, (_, i) => `T${i + 1}`);
  const settled = (): boolean => {
    if (s.suite === true) return env.state("T2") === "reverted";
    if (!ids.every(id => ["integrated", "failed", "conflict"].includes(env.state(id)))) return false;
    // when the whole phase integrated, wait for the gate to open so the fingerprint is stable
    return !ids.every(id => env.state(id) === "integrated") || env.phase().gate === "awaiting-qa";
  };
  const finished = (): boolean => settled() && env.quiet();
  const before = env.writer.appends;
  if (crash !== null && "afterAppend" in crash) env.writer.crashAfter = before + crash.afterAppend;
  if (crash !== null && "at" in crash) env.w.crashAt = crash.at;
  env.queue.enqueue(ids);
  await env.until(() => env.w.dead || finished(), `crash or completion of ${s.name}`);
  const crashed = env.w.dead;
  if (crashed) {
    await env.restart();
    await env.queue.resume();
    env.requeueVerified();
    await env.until(finished, `completion of ${s.name} after the restart`);
  }
  const sig = await env.signature();
  env.assertInvariants();
  const appends = env.writer.appends - before;
  await env.close(); // a sweep opens many stores: release each one's files now (afterEach removes the dirs)
  return { sig, appends, crashed };
}

describe("restart after every journaled step", () => {
  for (const s of SCENARIOS) {
    it(`${s.name}: crash after each append k reaches the uncrashed final state`, async () => {
      const ref = await crashRun(s, null);
      expect(ref.crashed).toBe(false);
      expect(ref.appends).toBeGreaterThan(3);
      for (const [id, n] of Object.entries(ref.sig.integratedEvents)) expect(n, `${id} integrated once`).toBe(1);
      for (let k = 1; k <= ref.appends; k++) {
        const run = await crashRun(s, { afterAppend: k });
        expect(run.sig, `${s.name}: crash after append ${k}`).toEqual(ref.sig);
      }
    }, 600_000);
  }

  for (const at of ["before-branchForce", "after-branchForce"] as const) {
    it(`two serial tasks: crash ${at.replace("-", " ")} reaches the same final state`, async () => {
      const ref = await crashRun(SCENARIOS[0] as Scenario, null);
      const run = await crashRun(SCENARIOS[0] as Scenario, { at });
      expect(run.crashed).toBe(true);
      expect(run.sig).toEqual(ref.sig);
    }, 180_000);
  }

  it("suite culprit then revert: crash around the revert fast-forward reaches the same final state", async () => {
    const s = SCENARIOS[2] as Scenario;
    const ref = await crashRun(s, null);
    // The branch is moved 3 times for the tasks and a 4th time by the revert fast-forward: crash only the 4th move.
    for (const at of ["before-branchForce", "after-branchForce"] as const) {
      const env = await setup({ tasks: s.tasks, batchMax: s.batchMax });
      env.suite.resolution = RUNS;
      env.suite.onRun = culpritOf("T2");
      env.w.crashAt = at;
      env.w.crashOnForce = 4;
      env.queue.enqueue(["T1", "T2", "T3"]);
      await env.until(() => env.w.dead, `crash ${at} of the revert fast-forward`);
      expect(env.state("T2")).toBe("integrated");
      await env.restart();
      await env.queue.resume();
      await env.until(() => env.state("T2") === "reverted" && env.quiet());
      expect(await env.signature()).toEqual(ref.sig);
      env.assertInvariants();
      await env.queue.dispose();
    }
  }, 180_000);
});

// ---------------------------------------------------------------------------------------------------------------
// Rejected appends (M7) and unexpected lane errors (M13a)
// ---------------------------------------------------------------------------------------------------------------

function throwsCode(fn: () => void): unknown {
  try {
    fn();
  } catch (e) {
    return (e as { code?: unknown }).code;
  }
  return null;
}

describe("rejected appends stop both lanes (M7)", () => {
  it("E_LOCK_LOST: the queue disposes itself, makes no git call, warns nobody and rejects later calls", async () => {
    const env = await setup({ tasks: 1 });
    const target = env.writer.attempts + 1;
    env.writer.rejectOn = n => n === target ? new ExecutorError("E_LOCK_LOST", "ledger lock lost", null) : null;
    env.queue.enqueue(["T1"]);
    await env.until(() => env.writer.attempts >= target, "the rejected append");
    await env.settle();
    expect(env.w.writes).toEqual([]);
    expect(env.logger.warnings).toEqual([]);
    expect(env.listener.calls).toEqual([]);
    expect(env.state("T1")).toBe("verified");
    expect(env.ledger.status).toBe("running");
    expect(env.queue.queued()).toEqual([]);
    expect(throwsCode(() => env.queue.enqueue(["T1"]))).toBe("E_DISPOSED");
    await expect(env.queue.checkPhase("p1")).rejects.toMatchObject({ code: "E_DISPOSED" });
    expect(env.locks.held).toBe(false);
    env.assertInvariants();
  });

  it("E_ILLEGAL_TRANSITION: warns, pauses the plan with a critical inbox item and stops the lanes", async () => {
    const env = await setup({ tasks: 1 });
    const target = env.writer.attempts + 1;
    env.writer.rejectOn = n => n === target ? new ExecutorError("E_ILLEGAL_TRANSITION", "batch refused by the ledger", null) : null;
    env.queue.enqueue(["T1"]);
    await env.until(() => env.ledger.status === "paused", "the bug pause");
    expect(env.logger.warnings.some(w => w.includes("illegal transition rejected"))).toBe(true);
    expect(env.ledger.inbox).toHaveLength(1);
    expect(env.ledger.inbox[0]).toMatchObject({ kind: "failure", severity: "critical" });
    expect(env.ledger.inbox[0]?.text).toContain("Integration queue bug");
    expect(env.ledger.inbox[0]?.text).toContain("batch refused by the ledger");
    const pause = (await env.events()).find(e => e.type === "status-changed" && e.to === "paused");
    expect(pause).toMatchObject({ reason: "integration-bug" });
    // both lanes are stopped: a later enqueue starts nothing
    env.queue.enqueue(["T1"]);
    await env.settle();
    expect(env.state("T1")).toBe("verified");
    expect(await env.steps()).toEqual([]);
    expect(env.w.writes).toEqual([]);
    env.assertInvariants();
  });

  it("E_ILLEGAL_TRANSITION whose pause batch is rejected too: warns and leaves the status alone", async () => {
    const env = await setup({ tasks: 1 });
    const target = env.writer.attempts + 1;
    env.writer.rejectOn = n => n === target ? new ExecutorError("E_ILLEGAL_TRANSITION", "first", null)
      : n === target + 1 ? new Error("second") : null;
    env.queue.enqueue(["T1"]);
    await env.until(() => env.logger.warnings.some(w => w.includes("could not pause after an illegal transition")), "the second warning");
    expect(env.logger.warnings.some(w => w.includes("second"))).toBe(true);
    expect(env.ledger.status).toBe("running");
    expect(env.ledger.inbox).toEqual([]);
    expect(await env.steps()).toEqual([]);
  });

  it("any other rejected append stops the lanes with a lane-error warning and changes nothing", async () => {
    const env = await setup({ tasks: 2, batchMax: 1 });
    const target = env.writer.attempts + 1;
    env.writer.rejectOn = n => n === target ? new Error("disk full") : null;
    env.queue.enqueue(["T1", "T2"]);
    await env.until(() => env.logger.warnings.some(w => w.includes("lane error: disk full")), "the lane error");
    await env.settle();
    expect(env.ledger.status).toBe("running");
    expect(env.state("T1")).toBe("verified");
    expect(env.state("T2")).toBe("verified");
    expect(await env.steps()).toEqual([]);
    expect(env.ledger.inbox).toEqual([]);
  });
});

describe("unexpected lane errors (M13a) and stalled entries (M36)", () => {
  it.each([false, true])("durably retains bounded sanitized rebase diagnostics (cleanup failed: %s) without weakening the critical pause", async cleanupFailed => {
    const env = await setup({ tasks: 2, batchMax: 1 });
    const original = { op: "rebase", code: 1,
      stderr: `${"\0\\\"é".repeat(5000)} initiating failure https://first-user:initial-secret@example.test/repo?token=initial-token` };
    const cleanup = { op: "rebase --abort", code: 128,
      stderr: `${"\0\\\"é".repeat(5000)} cleanup failure https://second-user:cleanup-secret@example.test/repo?password=cleanup-token` };
    env.git.rebaseOnto = async () => {
      throw new ExecutorError("E_GIT", "git rebase failed: https://message-user:message-secret@example.test/repo?token=message-token",
        cleanupFailed ? { original, cleanup } : original);
    };
    env.queue.enqueue(["T1", "T2"]);
    await env.until(() => env.ledger.status === "paused", "the infrastructure pause");
    const events = await env.events(); // Exported from the real store, not just the queue's in-memory history.
    const refused = events.filter(isStep).find(e => e.step === "rebase" && e.edge === "end" && e.result === "refused");
    const expectedOriginal = { op: "rebase", code: 1, stderr: expect.stringContaining("initiating failure https://example.test/repo?token=***") };
    const expectedCleanup = { op: "rebase --abort", code: 128, stderr: expect.stringContaining("cleanup failure https://example.test/repo?password=***") };
    expect(parseDetail(refused?.detail)).toMatchObject({ v: 1, reason: "error",
      message: "git rebase failed: https://example.test/repo?token=***",
      error: { code: "E_GIT", detail: cleanupFailed ? { original: expectedOriginal, cleanup: expectedCleanup } : expectedOriginal },
    });
    expect(Buffer.byteLength(refused?.detail ?? "", "utf8")).toBeLessThanOrEqual(DETAIL_MAX_BYTES);
    expect(JSON.stringify(events)).not.toMatch(/first-user|initial-secret|initial-token|second-user|cleanup-secret|cleanup-token|message-user|message-secret|message-token/);
    expect(refused?.closes).toBe(false);
    expect(events.find(e => e.type === "status-changed" && e.to === "paused")).toMatchObject({ reason: "integration-infrastructure" });
    expect(env.ledger.inbox).toHaveLength(1);
    expect(env.ledger.inbox[0]).toMatchObject({ kind: "failure", severity: "critical" });
    expect(env.ledger.inbox[0]?.text).toContain("https://example.test/repo?token=***");
    expect(env.state("T1")).toBe("integrating");
    expect(env.state("T2")).toBe("verified");
    expect(env.writer.openIntegration()).toHaveLength(1);
    expect(env.w.tip()).toBe(env.w.base);
    expect(env.w.checkLog).toEqual([]);
    env.clock.fire();
    await env.settle();
    expect(env.state("T2")).toBe("verified");
    expect(env.writer.openIntegration()).toHaveLength(1);
    expect((await env.steps("task")).some(s => s.includes("rollback"))).toBe(false);
    env.assertInvariants();
  });

  it("diagnostic-key redaction survives collisions and prototype names in the durable refusal", async () => {
    const env = await setup({ tasks: 1 });
    const first = "https://fake-credential-user:fake-credential-pass@example.test/repo?token=fake-credential-token";
    const second = "https://fake-credential-other:fake-credential-other-pass@example.test/repo?token=fake-credential-other-token";
    const clean = "https://example.test/repo?token=***";
    const original = { op: "rebase", code: 1, stderr: `initiating failure ${first}`,
      remotes: { [first]: "first remote", [second]: "second remote", [`${clean}#2`]: "third remote" } };
    const detail = {
      original, shared: original,
      cleanup: { op: "rebase --abort", code: 128, error: `cleanup failure ${second}` },
      ["__proto__"]: [{ [first]: `prototype diagnostic ${second}` }],
      constructor: "constructor diagnostic", prototype: "prototype diagnostic", toString: "toString diagnostic",
    };
    env.git.rebaseOnto = async () => { throw new ExecutorError("E_GIT", "keyed diagnostic", detail); };
    env.queue.enqueue(["T1"]);
    await env.until(() => env.ledger.status === "paused", "the infrastructure pause");
    const events = await env.events();
    const refused = events.filter(isStep).find(e => e.step === "rebase" && e.edge === "end" && e.result === "refused");
    expect(parseDetail(refused?.detail)).toMatchObject({ reason: "error", message: "keyed diagnostic", error: {
      code: "E_GIT", detail: {
        original: { op: "rebase", code: 1, stderr: `initiating failure ${clean}`,
          remotes: { [clean]: "first remote", [`${clean}#2`]: "second remote", [`${clean}#2#2`]: "third remote" } },
        shared: { op: "rebase", code: 1, stderr: `initiating failure ${clean}` },
        cleanup: { op: "rebase --abort", code: 128, error: `cleanup failure ${clean}` },
        ["__proto__"]: [{ [clean]: `prototype diagnostic ${clean}` }],
        constructor: "constructor diagnostic", prototype: "prototype diagnostic", toString: "toString diagnostic",
      },
    } });
    expect(JSON.stringify(events)).not.toContain("fake-credential-");
    expect(Buffer.byteLength(refused?.detail ?? "", "utf8")).toBeLessThanOrEqual(DETAIL_MAX_BYTES);
    expect(refused?.closes).toBe(false);
    expect(events.find(e => e.type === "status-changed" && e.to === "paused")).toMatchObject({ reason: "integration-infrastructure" });
    expect(env.ledger.inbox[0]).toMatchObject({ kind: "failure", severity: "critical" });
    expect(env.state("T1")).toBe("integrating");
    expect(env.writer.openIntegration()).toHaveLength(1);
    expect(env.w.tip()).toBe(env.w.base);
    expect(env.w.checkLog).toEqual([]);
    env.assertInvariants();
  });

  it("diagnostic-key clipping redacts before bounding escaped property names", async () => {
    const env = await setup({ tasks: 1 });
    const key = `${"\0\\\"é".repeat(5000)} https://fake-credential-user:${"fake-credential-pass".repeat(500)}@example.test/repo?token=fake-credential-token`;
    const detail = { op: "rebase", code: 1, [key]: "remote failure" };
    env.git.rebaseOnto = async () => { throw new ExecutorError("E_GIT", "large keyed diagnostic", detail); };
    env.queue.enqueue(["T1"]);
    await env.until(() => env.ledger.status === "paused", "the infrastructure pause");
    const events = await env.events();
    const refused = events.filter(isStep).find(e => e.step === "rebase" && e.result === "refused");
    expect(parseDetail(refused?.detail)).toMatchObject({ reason: "error", message: "large keyed diagnostic", error: {
      code: "E_GIT", detail: { op: "rebase", code: 1 },
    } });
    expect(refused?.detail).toContain("https://example.test/repo?token=***");
    expect(refused?.detail).toContain("remote failure");
    expect(JSON.stringify(events)).not.toContain("fake-credential-");
    expect(Buffer.byteLength(refused?.detail ?? "", "utf8")).toBeLessThan(4096);
    expect(env.ledger.inbox[0]).toMatchObject({ kind: "failure", severity: "critical" });
    expect(env.state("T1")).toBe("integrating");
    expect(env.writer.openIntegration()).toHaveLength(1);
    env.assertInvariants();
  });

  it.each(["oversized", "excessive-keys", "excessive-items", "cyclic", "throwing-toJSON"])("%s diagnostic detail cannot overflow the journal or prevent the critical pause", async kind => {
    const env = await setup({ tasks: 1 });
    const detail: Record<string, JsonValue> = {};
    if (kind === "cyclic") detail.self = detail;
    else if (kind === "throwing-toJSON") Object.defineProperty(detail, "toJSON", { value: () => { throw new Error("fake-credential-unavailable"); } });
    else if (kind === "excessive-keys") for (let n = 0; n < 1000; n++) detail[`item${n}`] = n;
    else if (kind === "excessive-items") detail.items = Array.from({ length: 1000 }, (_, n) => n);
    else detail.items = Array.from({ length: 100 }, () => `${"x".repeat(3000)} https://alice:secret@example.test/repo?token=private`);
    env.git.rebaseOnto = async () => { throw new ExecutorError("E_GIT", "unexpected diagnostic", detail); };
    env.queue.enqueue(["T1"]);
    await env.until(() => env.ledger.status === "paused", "the infrastructure pause");
    const refused = (await env.events()).filter(isStep).find(e => e.step === "rebase" && e.result === "refused");
    expect(parseDetail(refused?.detail)).toMatchObject({ reason: "error", message: "unexpected diagnostic", error: {
      code: "E_GIT", detail: kind === "oversized" ? { truncated: true, tail: expect.stringContaining("https://example.test/repo?token=***") }
        : { unavailable: true },
    } });
    expect(Buffer.byteLength(refused?.detail ?? "", "utf8")).toBeLessThanOrEqual(DETAIL_MAX_BYTES);
    expect(refused?.detail).not.toMatch(/alice|secret|private|fake-credential-/);
    expect(env.ledger.inbox[0]).toMatchObject({ kind: "failure", severity: "critical" });
    expect(env.state("T1")).toBe("integrating");
    expect(env.writer.openIntegration()).toHaveLength(1);
    env.assertInvariants();
  });

  it("a throw inside a rebase journals the refusal, pauses with a critical item; once running again the entry is rolled back and integrates", async () => {
    const env = await setup({ tasks: 1 });
    const real = env.git.rebaseOnto.bind(env.git);
    env.git.rebaseOnto = async () => { throw new Error("git exploded"); };
    env.queue.enqueue(["T1"]);
    await env.until(() => env.ledger.status === "paused", "the infrastructure pause");
    expect(env.logger.warnings.some(w => w.includes("lane error: git exploded"))).toBe(true);
    expect((await env.steps("task")).slice(-1)).toEqual(["task:rebase:end/refused"]);
    expect(env.ledger.inbox[0]).toMatchObject({ kind: "failure", severity: "critical" });
    expect(env.ledger.inbox[0]?.text).toContain("git exploded");
    expect(env.state("T1")).toBe("integrating");
    expect(env.writer.openIntegration()).toHaveLength(1);
    // the stalled poll while still paused does nothing and re-arms itself (the later poll proves it)
    env.clock.fire();
    await env.settle();
    expect(env.writer.openIntegration()).toHaveLength(1);
    expect((await env.steps("task")).some(s => s.includes("rollback"))).toBe(false);
    // running again: the poll rolls the entry back (reason stalled), requeues and integrates it
    env.git.rebaseOnto = real;
    await env.writer.append([{ type: "status-changed", from: "paused", to: "running", reason: "unpause" }]);
    env.clock.fire();
    await env.until(() => env.state("T1") === "integrated" && env.quiet(), "the stalled entry to integrate");
    const rb = (await env.events()).filter(isStep).find(e => e.step === "rollback" && e.edge === "start");
    expect(JSON.parse(rb?.detail ?? "{}")).toMatchObject({ reason: "stalled", of: null });
    expect(env.w.integratedCount()).toEqual({ T1: 1 });
    env.assertInvariants();
  });

  it("a runner that throws inside the phase suite pauses the plan; once running again the stalled suite entry is rolled back and rerun", async () => {
    const env = await setup({ tasks: 1, batchMax: 1 });
    env.suite.resolution = RUNS;
    env.suite.run = async () => { throw new Error("runner exploded"); };
    env.queue.enqueue(["T1"]);
    await env.until(() => env.ledger.status === "paused", "the suite pause");
    expect((await env.steps("phase-suite")).slice(-1)).toEqual(["phase-suite:phase-suite:end/refused"]);
    expect(env.ledger.inbox[0]?.text).toContain("runner exploded");
    expect(env.phase().gate).toBe("suite-running");
    env.suite.run = async () => ({ kind: "passed" });
    await env.writer.append([{ type: "status-changed", from: "paused", to: "running", reason: "unpause" }]);
    env.clock.fire();
    await env.until(() => env.phase().gate === "awaiting-qa" && env.quiet(), "the suite rerun after the stalled rollback");
    const steps = await env.steps("phase-suite");
    expect(steps).toContain("phase-suite:rollback:start");
    expect(steps).toContain("phase-suite:rollback:end/rolled-back");
    expect(steps.slice(-1)).toEqual(["phase-suite:phase-suite:end/ok"]);
    env.assertInvariants();
  });

  it("a check run reporting `interrupted` stops the lane quietly: no pause, no refusal row, the entry stays open", async () => {
    const env = await setup({ tasks: 1 });
    env.w.checkScript.push(errorResult("interrupted"));
    env.queue.enqueue(["T1"]);
    await env.until(() => env.w.checkLog.length === 1, "the check");
    await env.settle();
    expect(env.ledger.status).toBe("running");
    expect(env.logger.warnings).toEqual([]);
    expect(env.writer.openIntegration().map(o => `${o.step}:${o.edge}`)).toEqual(["checks:start"]);
    expect(env.ledger.inbox).toEqual([]);
    env.assertInvariants();
  });
});

describe("the journal handed to the suite runner", () => {
  it("starts and ends steps of the open entry, buffers counters, guards writes and refuses a second open step", async () => {
    const env = await setup({ tasks: 1, batchMax: 1 });
    env.suite.resolution = RUNS;
    const box: { j: StepJournal | null } = { j: null };
    const seen: Record<string, unknown> = {};
    env.suite.run = async (req, j) => {
      box.j = j;
      seen.kind = j.entry.kind;
      seen.id = j.entry.id;
      seen.aborted = j.signal.aborted;
      seen.startWhileOpen = await j.start("bisect", { v: 1, base: req.base ?? "", candidate: req.commit, tasks: [] }).catch((e: unknown) => (e as { code?: unknown }).code);
      await j.assertWriteCwd(req.slot.path, "slot");
      j.counter("integration.bisect.probes", 2, { kind: "halves" });
      await j.end("ok", { v: 1, files: [], idsUnparsed: false, durationMs: 1, output: "" });
      // nothing is open now: the runner may start a fresh step and leave it closed
      await j.start("bisect", { v: 1, base: req.base ?? "", candidate: req.commit, tasks: [] }, { candidate: req.commit });
      await j.end("ok", { v: 1, verdict: "pass", probes: 1 });
      return { kind: "passed" };
    };
    env.queue.enqueue(["T1"]);
    await env.until(() => env.phase().gate === "awaiting-qa" && env.quiet(), "the suite to close");
    expect(seen).toMatchObject({ kind: "phase-suite", aborted: false, startWhileOpen: "E_INVALID_INPUT" });
    expect(String(seen.id)).toMatch(/^i-\d+$/);
    expect(env.guard.calls).toContainEqual({ cwd: slotPath("ci"), purpose: "slot" });
    expect(env.w.journal.some(e => e.type === "metric" && JSON.stringify(e.metric).includes("integration.bisect.probes"))).toBe(true);
    // the runner closed its last step; the queue reopens the suite step to close the entry (never closed by the runner)
    expect(await env.steps("phase-suite")).toEqual([
      "phase-suite:phase-suite:start", "phase-suite:phase-suite:end/ok", "phase-suite:bisect:start", "phase-suite:bisect:end/ok",
      "phase-suite:phase-suite:start", "phase-suite:phase-suite:end/ok",
    ]);
    const closing = (await env.events()).filter(isStep).filter(e => e.entry.kind === "phase-suite" && e.edge === "end").map(e => e.closes);
    expect(closing).toEqual([false, false, true]);
    await env.queue.dispose();
    await expect(box.j?.assertWriteCwd("C:/slots/ci", "slot")).rejects.toMatchObject({ code: "E_DISPOSED" });
    env.assertInvariants();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Task entry edge cases, lock takeover counter, enqueue guards
// ---------------------------------------------------------------------------------------------------------------

describe("task entry edge cases", () => {
  it("a task whose branch does not resolve is dropped with a blocking inbox item; nothing is journaled", async () => {
    const env = await setup({ tasks: 1 });
    const real = env.igit.readRef.bind(env.igit);
    env.igit.readRef = async (cwd, ref) => ref.includes("/t/T1") ? null : real(cwd, ref);
    env.queue.enqueue(["T1"]);
    await env.until(() => env.ledger.inbox.length === 1, "the inbox item");
    expect(env.ledger.inbox[0]).toMatchObject({ kind: "failure", severity: "blocking", taskId: "T1" });
    expect(env.ledger.inbox[0]?.text).toContain("Integration could not read task T1");
    expect(env.queue.queued()).toEqual([]);
    expect(env.state("T1")).toBe("verified");
    expect(await env.steps()).toEqual([]);
    expect(env.listener.inbox).toHaveLength(1);
    expect(env.w.writes).toEqual([]);
    env.assertInvariants();
  });

  it("a conflict in more than 20 paths lists the first 20, flags the detail truncated and tolerates a failing log read", async () => {
    const env = await setup({ tasks: 1 });
    const paths = Array.from({ length: 25 }, (_, i) => `src/p${i}.ts`);
    env.git.rebaseOnto = async () => ({ ok: false, conflicts: paths });
    env.igit.logPaths = async () => { throw new Error("log failed"); };
    env.queue.enqueue(["T1"]);
    await env.until(() => env.state("T1") === "conflict" && env.quiet());
    const end = (await env.events()).filter(isStep).find(e => e.edge === "end" && e.step === "rebase");
    const detail = JSON.parse(end?.detail ?? "{}") as { paths: string[]; truncated: boolean; ours: Record<string, unknown[]>; theirs: Record<string, unknown[]> };
    expect(detail.paths).toEqual(paths.slice(0, 20));
    expect(detail.truncated).toBe(true);
    expect(Object.values(detail.ours).every(v => v.length === 0)).toBe(true);
    expect(Object.values(detail.theirs).every(v => v.length === 0)).toBe(true);
    const ctx = env.ledger.tasks.T1?.attempts[0]?.context ?? "";
    expect(ctx).toContain("conflicted in 25 path(s)");
    expect(ctx).toContain("(5 more paths not shown)");
    env.assertInvariants();
  });

  it("an integration worktree that is not at the head is reset to it before the merge (I1 path unchanged)", async () => {
    const env = await setup({ tasks: 1 });
    env.w.iwtHead = env.w.commit(null, null).sha;
    env.queue.enqueue(["T1"]);
    await env.until(() => env.state("T1") === "integrated" && env.quiet());
    expect(env.pool.resets).toContainEqual({ slot: "integration", commit: env.w.base });
    expect(env.w.tasksAt(env.w.tip())).toEqual(["T1"]);
    env.assertInvariants();
  });

  it("a worktree whose HEAD cannot be read is reset to the head as well", async () => {
    const env = await setup({ tasks: 1 });
    const real = env.git.revParse.bind(env.git);
    env.git.revParse = async (cwd, rev) => {
      if (cwd === WT && rev === "HEAD") throw new Error("no HEAD");
      return real(cwd, rev);
    };
    env.queue.enqueue(["T1"]);
    await env.until(() => env.state("T1") === "integrated" && env.quiet());
    expect(env.pool.resets).toContainEqual({ slot: "integration", commit: env.w.base });
    env.assertInvariants();
  });

  it("a slot release that fails is logged and the task still integrates", async () => {
    const env = await setup({ tasks: 1 });
    env.pool.release = async () => { throw new Error("slot busy"); };
    env.queue.enqueue(["T1"]);
    await env.until(() => env.state("T1") === "integrated" && env.quiet());
    expect(env.logger.warnings.some(w => w.includes("slot release failed: slot busy"))).toBe(true);
    expect(env.leases.released).toEqual(["T1"]);
    env.assertInvariants();
  });

  it("a listener that throws is logged and does not disturb the lane", async () => {
    const env = await setup({ tasks: 2, batchMax: 1 });
    env.listener.onIntegrated = () => { throw new Error("listener broke"); };
    env.queue.enqueue(["T1", "T2"]);
    await env.until(() => env.state("T1") === "integrated" && env.state("T2") === "integrated" && env.quiet());
    expect(env.logger.warnings.filter(w => w.includes("listener threw: listener broke"))).toHaveLength(2);
    env.assertInvariants();
  });

  it("a repo lock taken over from a dead or stale holder is counted (integration.lock.takeover)", async () => {
    const env = await setup({ tasks: 2, batchMax: 1 });
    const gone = new AbortController();
    let n = 0;
    env.locks.acquire = async () => {
      env.locks.held = true;
      n++;
      const lock: RepoLockWithTakeover = {
        lost: gone.signal, takeover: n === 1 ? "dead-pid" : "stale", release: async () => { env.locks.held = false; },
      };
      return lock;
    };
    env.queue.enqueue(["T1", "T2"]);
    await env.until(() => env.state("T1") === "integrated" && env.state("T2") === "integrated" && env.quiet());
    const counters = env.w.journal.filter(e => e.type === "metric" && JSON.stringify(e.metric).includes("integration.lock.takeover"))
      .map(e => (e.type === "metric" && "labels" in e.metric ? JSON.stringify(e.metric.labels) : ""));
    expect(counters).toEqual(['{"reason":"dead-pid"}', '{"reason":"stale"}']);
    expect(env.locks.held).toBe(false);
    env.assertInvariants();
  });

  it("a task already in flight is neither queued again nor warned about", async () => {
    const env = await setup({ tasks: 1 });
    let open!: () => void;
    env.w.checkGate = new Promise<void>(resolve => { open = resolve; });
    env.queue.enqueue(["T1"]);
    await env.until(() => env.w.checkLog.length === 1, "the check in flight");
    env.queue.enqueue(["T1"]);
    expect(env.queue.queued()).toEqual([]);
    expect(env.logger.warnings).toEqual([]);
    open();
    await env.until(() => env.state("T1") === "integrated" && env.quiet());
    expect(env.w.integratedCount()).toEqual({ T1: 1 });
    env.assertInvariants();
  });

  it("a requeued orphan is not queued again by the owner's enqueue", async () => {
    const env = await orphanEnv(1, 1);
    await env.queue.resume();
    env.queue.enqueue(["T1"]);
    expect(env.logger.warnings.some(w => w.includes("ignoring enqueue"))).toBe(false);
    expect(env.queue.queued()).toEqual(["T1"]);
  });

  it("enqueue on a plan that is neither running nor paused is E_PLAN_STATE", async () => {
    const env = await setup({ tasks: 0, mutate: l => { l.status = "completed"; } });
    expect(throwsCode(() => env.queue.enqueue(["T1"]))).toBe("E_PLAN_STATE");
  });

  it("checkPhase after abort resolves without doing anything", async () => {
    const env = await setup({ tasks: 0 });
    await env.queue.abort();
    const seq = env.ledger.seq;
    await expect(env.queue.checkPhase("p1")).resolves.toBeUndefined();
    expect(env.ledger.seq).toBe(seq);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// resume (4.8): rollback git edge cases, open revert / tag / land / suite entries
// ---------------------------------------------------------------------------------------------------------------

async function pausedTaskEnv(): Promise<Env> {
  const env = await setup({ tasks: 1 });
  env.w.checkScript.push(errorResult("spawn"), errorResult("spawn"), errorResult("spawn"));
  env.queue.enqueue(["T1"]);
  await env.until(() => env.ledger.status === "paused", "M13a pause");
  await env.restart();
  return env;
}

async function lastRollbackEnd(env: Env): Promise<Record<string, unknown>> {
  const end = (await env.events()).filter(isStep).filter(e => e.step === "rollback" && e.edge === "end").pop();
  return JSON.parse(end?.detail ?? "{}") as Record<string, unknown>;
}

describe("resume rollback git (4.8 table)", () => {
  it("a slot that no longer exists is rolled back without a reset", async () => {
    const env = await pausedTaskEnv();
    env.pool.get = async () => null;
    const resets = env.pool.resets.length;
    const report = await env.queue.resume();
    expect(report.entries).toEqual([expect.objectContaining({ kind: "task", action: "rolled-back" })]);
    expect(report.rolledBack).toEqual(["T1"]);
    expect(await lastRollbackEnd(env)).toEqual({ v: 1, reset: null });
    expect(env.pool.resets).toHaveLength(resets);
    expect(env.writer.openIntegration()).toEqual([]);
    env.assertInvariants();
  });

  it("a failing rebase --abort and an unreadable task branch are tolerated: rolled back, no reset", async () => {
    const env = await pausedTaskEnv();
    env.git.rebaseAbort = async () => { throw new Error("abort failed"); };
    const real = env.igit.readRef.bind(env.igit);
    env.igit.readRef = async (cwd, ref) => ref.includes("/t/") ? null : real(cwd, ref);
    const resets = env.pool.resets.length;
    const report = await env.queue.resume();
    expect(report.entries).toEqual([expect.objectContaining({ kind: "task", action: "rolled-back" })]);
    expect(await lastRollbackEnd(env)).toEqual({ v: 1, reset: null });
    expect(env.pool.resets).toHaveLength(resets);
    env.assertInvariants();
  });

  it("a readable task branch resets the slot to the task tip and records it", async () => {
    const env = await pausedTaskEnv();
    const resets = env.pool.resets.length;
    await env.queue.resume();
    const tip = env.w.branches.get(`refs/heads/omr/${PLAN_ID}/t/T1`);
    expect(await lastRollbackEnd(env)).toEqual({ v: 1, reset: tip });
    expect(env.pool.resets.slice(resets)).toEqual([{ slot: "slot-1", commit: tip }]);
  });
});

describe("resume of open revert entries (M25, M31)", () => {
  async function revertErrorEnv(): Promise<Env> {
    const env = await suiteEnv(2, culpritOf("T1"));
    env.suite.revertScript.push({ kind: "error", reason: "spawn", message: "no git" });
    await env.until(() => env.ledger.status === "paused", "the revert pause");
    expect(env.writer.openIntegration().map(o => o.entry.kind)).toEqual(["revert"]);
    return env;
  }

  const unpause = { type: "status-changed", from: "paused", to: "running", reason: "unpause" } as const;

  it("is rolled back, journaled as a rerun with the same culprit and ids, and completed once the plan runs", async () => {
    const env = await revertErrorEnv();
    const headBefore = env.ledger.integration.head;
    await env.restart();
    const report = await env.queue.resume();
    expect(report.entries).toEqual([expect.objectContaining({ kind: "revert", action: "rerun" })]);
    expect(env.writer.openIntegration().map(o => `${o.entry.kind}:${o.step}`)).toEqual(["revert:revert-build"]);
    expect(env.pool.resets).toContainEqual({ slot: "integration", commit: headBefore });
    await env.writer.append([unpause]);
    env.queue.enqueue([]); // wakes the lanes
    await env.until(() => env.state("T1") === "reverted" && env.phase().gate === "pending" && env.quiet(), "the rerun revert");
    expect(await env.steps("revert")).toEqual([
      "revert:revert-build:start", "revert:revert-build:end/refused", "revert:rollback:start", "revert:rollback:end/rolled-back",
      "revert:revert-build:start", "revert:revert-build:end/ok", "revert:revert-fast-forward:start", "revert:revert-fast-forward:end/ok",
    ]);
    expect(env.suite.reverts).toHaveLength(2);
    expect(env.suite.reverts[1]?.culprit.taskId).toBe("T1");
    expect(env.suite.reverts[1]?.regression.ids).toEqual(["test:T1"]);
    expect(env.suite.reverts[1]?.regression.commands).toEqual(RUNS.kind === "runs" ? RUNS.commands : []);
    expect(env.w.writes.some(x => x.op === "revertAbort")).toBe(true);
    expect(env.w.tasksAt(env.w.tip())).toEqual(["T2"]);
    env.assertInvariants();
  });

  it("a resolver that fails while journaling the rerun leaves the revert without commands but still runs it", async () => {
    const env = await revertErrorEnv();
    await env.restart();
    env.suite.resolve = async () => { throw new Error("resolver down"); };
    const report = await env.queue.resume();
    expect(report.entries).toEqual([expect.objectContaining({ kind: "revert", action: "rerun" })]);
    await env.writer.append([unpause]);
    env.queue.enqueue([]);
    await env.until(() => env.state("T1") === "reverted" && env.quiet(), "the rerun revert");
    expect(env.suite.reverts[1]?.regression.commands).toEqual([]);
    env.assertInvariants();
  });

  it("a second resume() does not journal the same rerun again", async () => {
    const env = await revertErrorEnv();
    await env.restart();
    const first = await env.queue.resume();
    const seq = env.ledger.seq;
    expect(await env.queue.resume()).toBe(first);
    expect(env.ledger.seq).toBe(seq);
  });

  it("abort rolls an open revert entry back through the integration slot and keeps the culprit integrated", async () => {
    const env = await revertErrorEnv();
    await env.queue.abort();
    expect(env.writer.openIntegration()).toEqual([]);
    expect((await env.steps("revert")).slice(-2)).toEqual(["revert:rollback:start", "revert:rollback:end/rolled-back"]);
    expect(env.w.writes.some(x => x.op === "revertAbort")).toBe(true);
    expect(env.pool.resets).toContainEqual({ slot: "integration", commit: env.ledger.integration.head });
    expect(env.state("T1")).toBe("integrated");
    expect(await lastRollbackEnd(env)).toEqual({ v: 1, reset: env.ledger.integration.head });
    env.assertInvariants();
  });
});

describe("resume of open tag, land and suite entries", () => {
  const passedGate = (l: LedgerV1): void => { const p = l.phases[0]; if (p !== undefined) p.gate = "passed"; };
  const unpause = { type: "status-changed", from: "paused", to: "running", reason: "unpause" } as const;
  const tagName = `omr/${PLAN_ID}/phase/p1`;

  async function tagErrorEnv(): Promise<Env> {
    const env = await setup({ tasks: 0, resume: false, mutate: passedGate });
    env.lander.tagOutcome = { kind: "error", message: "ref locked" };
    await env.queue.resume();
    await env.until(() => env.ledger.status === "paused", "the tag pause");
    expect(env.writer.openIntegration().map(o => o.entry.kind)).toEqual(["tag"]);
    return env;
  }

  it("a tag entry left open by tag errors is retried on resume and tags the phase", async () => {
    const env = await tagErrorEnv();
    await env.restart();
    env.lander.tagOutcome = null;
    const report = await env.queue.resume();
    expect(report.entries).toEqual([expect.objectContaining({ kind: "tag", action: "tagged" })]);
    expect(env.phase().tag).toBe(tagName);
    expect(env.lander.tags.get(tagName)).toBe(env.w.base);
    expect((await env.steps("tag")).slice(-1)).toEqual(["tag:tag:end/ok"]);
    expect(env.writer.openIntegration()).toEqual([]);
    env.assertInvariants();
  });

  it("a retried tag that exists elsewhere ends the entry with an info item and no tag", async () => {
    const env = await tagErrorEnv();
    await env.restart();
    env.lander.tagOutcome = null;
    env.lander.tags.set(tagName, hex(777));
    const report = await env.queue.resume();
    expect(report.entries).toEqual([expect.objectContaining({ kind: "tag", action: "none" })]);
    expect(env.phase().tag).toBeNull();
    expect(env.ledger.inbox.at(-1)).toMatchObject({ kind: "failure", severity: "info" });
    expect(env.writer.openIntegration()).toEqual([]);
  });

  it("a tag entry whose stalled rollback was cut short is rolled back on resume, and the phase is tagged afterwards", async () => {
    const env = await tagErrorEnv();
    await env.writer.append([unpause]);
    env.writer.crashAfter = env.writer.appends + 1; // dies right after ISS(rollback)
    env.clock.fire(); // the stalled poll
    await env.until(() => env.w.dead, "the crash in the stalled rollback");
    expect(env.writer.openIntegration().map(o => `${o.entry.kind}:${o.step}:${o.edge}`)).toEqual(["tag:rollback:start"]);
    await env.restart();
    env.lander.tagOutcome = null;
    const report = await env.queue.resume();
    expect(report.entries).toEqual([expect.objectContaining({ kind: "tag", action: "none" })]);
    await env.until(() => env.phase().tag === tagName && env.quiet(), "the tag after the rollback");
    const steps = await env.steps("tag");
    expect(steps).toContain("tag:rollback:end/rolled-back");
    expect(steps.slice(-1)).toEqual(["tag:tag:end/ok"]);
    env.assertInvariants();
  });

  const advanced = (landed: boolean) => (l: LedgerV1, w: World): void => {
    l.status = "completed";
    l.config.land = "ff-when-clean";
    const c = w.commit(w.base, "X");
    w.passed.add(c.sha);
    w.branches.set(INT_REF, c.sha);
    w.iwtHead = c.sha;
    l.integration.head = c.sha;
    if (landed) {
      w.branches.set(MAIN_REF, c.sha);
      w.landed = true;
    }
  };

  it("a land entry whose base branch already holds the candidate is completed, not repeated", async () => {
    const env = await setup({ tasks: 0, mutate: advanced(true) });
    env.writer.crashAfter = env.writer.appends + 1; // dies right after ISS(land)
    await expect(env.queue.land()).rejects.toThrow("crash after append");
    await env.restart();
    const report = await env.queue.resume();
    expect(report.entries).toEqual([expect.objectContaining({ kind: "land", action: "completed" })]);
    expect(await env.steps("land")).toEqual(["land:land:start", "land:land:end/ok"]);
    expect(env.lander.landCalls).toEqual([]);
    expect(env.writer.openIntegration()).toEqual([]);
    env.assertInvariants();
  });

  it("a land entry whose base branch lags is rolled back and landed again", async () => {
    const env = await setup({ tasks: 0, mutate: advanced(false) });
    env.writer.crashAfter = env.writer.appends + 1;
    await expect(env.queue.land()).rejects.toThrow("crash after append");
    await env.restart();
    const report = await env.queue.resume();
    expect(report.entries).toEqual([expect.objectContaining({ kind: "land", action: "rerun" })]);
    await env.until(() => env.lander.landCalls.length === 1 && env.quiet(), "the second land");
    expect(await env.steps("land")).toEqual(["land:land:start", "land:land:end/rolled-back", "land:land:start", "land:land:end/ok"]);
    expect(env.w.landed).toBe(true);
    env.assertInvariants();
  });

  it("in manual mode a lagging land entry is rolled back and the lander is never asked", async () => {
    const env = await setup({ tasks: 0, mutate: (l, w) => { advanced(false)(l, w); l.config.land = "manual"; } });
    env.writer.crashAfter = env.writer.appends + 1;
    await expect(env.queue.land()).rejects.toThrow("crash after append");
    await env.restart();
    const real = env.igit.readRef.bind(env.igit);
    // Base unreadable (git error on the base ref only; the integration branch is read in the toplevel too since QA-3.2-9).
    env.igit.readRef = async (cwd, ref) => ref === MAIN_REF ? Promise.reject(new Error("no ref")) : real(cwd, ref);
    const report = await env.queue.resume();
    expect(report.entries).toEqual([expect.objectContaining({ kind: "land", action: "rerun" })]);
    await env.settle();
    expect(env.lander.landCalls).toEqual([]);
    expect(env.writer.openIntegration()).toEqual([]);
  });

  it("an open phase-suite entry of a running plan is rolled back and rerun after a restart", async () => {
    const env = await setup({ tasks: 1, batchMax: 1 });
    env.suite.resolution = RUNS;
    const real = env.suite.run.bind(env.suite);
    env.suite.run = async (_req, j) => {
      await new Promise<void>(resolve => j.signal.addEventListener("abort", () => resolve(), { once: true }));
      return { kind: "interrupted", by: "dispose" };
    };
    env.queue.enqueue(["T1"]);
    await env.until(() => env.writer.openIntegration().some(o => o.entry.kind === "phase-suite"), "the suite entry");
    await env.restart();
    env.suite.run = real;
    const report = await env.queue.resume();
    expect(report.entries).toEqual([expect.objectContaining({ kind: "phase-suite", action: "rerun" })]);
    await env.until(() => env.phase().gate === "awaiting-qa" && env.quiet(), "the rerun suite");
    const steps = await env.steps("phase-suite");
    expect(steps).toContain("phase-suite:phase-suite:end/rolled-back");
    expect(steps).toContain("phase-suite:rollback:end/rolled-back");
    expect(steps.slice(-1)).toEqual(["phase-suite:phase-suite:end/ok"]);
    env.assertInvariants();
  });

  it("an open phase-suite entry of a paused plan is only rolled back", async () => {
    const env = await setup({ tasks: 1, batchMax: 1 });
    env.suite.resolution = RUNS;
    env.suite.run = async () => ({ kind: "error", reason: "spawn", message: "no node" });
    env.queue.enqueue(["T1"]);
    await env.until(() => env.ledger.status === "paused", "the suite pause");
    await env.restart();
    const report = await env.queue.resume();
    expect(report.entries).toEqual([expect.objectContaining({ kind: "phase-suite", action: "rolled-back" })]);
    expect(env.writer.openIntegration()).toEqual([]);
    expect(env.phase().gate).toBe("suite-running");
    env.assertInvariants();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// checkPhase gates (4.3), culprit bookkeeping, dependents of a reverted task
// ---------------------------------------------------------------------------------------------------------------

describe("checkPhase and suite gates", () => {
  const gateAt = (gate: "suite-running" | "suite-failed") => (l: LedgerV1): void => {
    const p = l.phases[0];
    if (p !== undefined) p.gate = gate;
  };

  it("a resolution that turns `none` between checkPhase and the run opens the QA gate from the lane without a suite entry", async () => {
    const env = await setup({ tasks: 1, batchMax: 1 });
    const answers: SuiteResolution[] = [RUNS, { kind: "none" }];
    env.suite.resolve = async () => answers.shift() ?? { kind: "none" };
    env.queue.enqueue(["T1"]);
    await env.until(() => env.phase().gate === "awaiting-qa" && env.quiet(), "the gate to open");
    expect(env.suite.runs).toHaveLength(0);
    expect(await env.steps("phase-suite")).toEqual([]);
    expect(env.listener.calls).toContain("gate:p1:awaiting-qa");
    expect(env.listener.calls).not.toContain("gate:p1:suite-running");
    env.assertInvariants();
  });

  it("a resolution that turns refused between checkPhase and the run pauses the phase with the reason", async () => {
    const env = await setup({ tasks: 1, batchMax: 1 });
    const answers: SuiteResolution[] = [RUNS, { kind: "refused", reason: "scripts vanished", ref: null }];
    env.suite.resolve = async () => answers.shift() ?? { kind: "none" };
    env.queue.enqueue(["T1"]);
    await env.until(() => env.phase().paused && env.quiet(), "the phase pause");
    expect(env.ledger.inbox[0]).toMatchObject({ kind: "failure", severity: "critical" });
    expect(env.ledger.inbox[0]?.text).toContain("scripts vanished");
    expect(env.phase().gate).toBe("pending");
    expect(env.suite.runs).toHaveLength(0);
    env.assertInvariants();
  });

  it("a gate left suite-running with no entry is run again without announcing suite-running (A2-1)", async () => {
    const env = await setup({ tasks: 0, resume: false, mutate: gateAt("suite-running") });
    env.suite.resolution = RUNS;
    await env.queue.resume();
    await env.until(() => env.phase().gate === "awaiting-qa" && env.quiet(), "the suite to close");
    expect(env.suite.runs).toHaveLength(1);
    expect(env.suite.runs[0]?.base).toBeNull();
    expect(env.listener.calls.filter(c => c.startsWith("gate:"))).toEqual(["gate:p1:awaiting-qa"]);
    expect(await env.steps("phase-suite")).toEqual(["phase-suite:phase-suite:start", "phase-suite:phase-suite:end/ok"]);
    env.assertInvariants();
  });

  it("a gate left suite-failed with no suite in the history reruns the suite", async () => {
    const env = await setup({ tasks: 0, resume: false, mutate: gateAt("suite-failed") });
    env.suite.resolution = RUNS;
    await env.queue.resume();
    await env.until(() => env.phase().gate === "awaiting-qa" && env.quiet(), "the rerun to close");
    expect(env.suite.runs).toHaveLength(1);
    expect(env.suite.reverts).toHaveLength(0);
    expect(env.listener.calls.filter(c => c.startsWith("gate:"))).toEqual(["gate:p1:suite-running", "gate:p1:awaiting-qa"]);
    env.assertInvariants();
  });

  it("a resolver that fails after the culprit is found does not block the revert: it gets the commands the runner used", async () => {
    const env = await setup({ tasks: 2, batchMax: 1 });
    env.suite.onRun = culpritOf("T2");
    let calls = 0;
    env.suite.resolve = async () => {
      calls++;
      if (calls === 3) throw new Error("resolver down");
      return RUNS;
    };
    env.queue.enqueue(["T1", "T2"]);
    await env.until(() => env.state("T2") === "reverted" && env.phase().gate === "pending" && env.quiet(), "the revert");
    expect(calls).toBe(3);
    expect(env.suite.reverts[0]?.regression.commands).toEqual(RUNS.kind === "runs" ? RUNS.commands : []);
    env.assertInvariants();
  });

  it("a crash between the culprit suite closing and the revert entry: resume rebuilds the revert from the history (M25)", async () => {
    const env = await setup({ tasks: 2, batchMax: 1 });
    env.suite.onRun = culpritOf("T2");
    let calls = 0;
    let crashAt = 3; // the resolver call right after the closing batch of the failed suite
    env.suite.resolve = async () => {
      calls++;
      if (calls === crashAt) {
        env.w.dead = true;
        throw new CrashError("crash after the suite closed");
      }
      if (crashAt < 0) throw new Error("resolver down after the restart"); // the history rebuild then runs without commands
      return RUNS;
    };
    env.queue.enqueue(["T1", "T2"]);
    await env.until(() => env.w.dead && env.phase().gate === "suite-failed", "the crash");
    const suiteTip = env.w.tip();
    expect(env.writer.openIntegration()).toEqual([]);
    expect(env.suite.reverts).toHaveLength(0);
    await env.restart();
    crashAt = -1;
    await env.queue.resume();
    await env.until(() => env.state("T2") === "reverted" && env.phase().gate === "pending" && env.quiet(), "the rebuilt revert");
    expect(env.suite.reverts).toHaveLength(1);
    expect(env.suite.reverts[0]).toMatchObject({ suiteCommit: suiteTip, head: suiteTip });
    expect(env.suite.reverts[0]?.culprit.taskId).toBe("T2");
    // QA-3.2-24: the failing files come back from the closing suite step's detail; the commands stay empty (resolver down).
    expect(env.suite.reverts[0]?.regression).toMatchObject({ ids: ["test:T2"], files: ["t/T2.test.ts"], commands: [] });
    expect(env.w.tasksAt(env.w.tip())).toEqual(["T1"]);
    env.assertInvariants();
  });

  it("tasks that depend on a reverted task are blocked; a live one is settled, its slot and lease released", async () => {
    // The dependents start `pending` (a valid draft); they become ready / running through journaled transitions once T1 is
    // integrated, while the phase suite of p1 is held.
    const env = await setup({ tasks: 2, batchMax: 1, mutate: l => {
      l.phases.push({ id: "p2", title: "Phase 2", wave: "w1", dependsOn: [], gate: "pending", qaRound: 1, paused: false, tag: null });
      l.waves[0]?.phases.push("p2");
      l.tasks.D1 = taskNode("D1", { phase: "p2" });
      l.tasks.D2 = taskNode("D2", { phase: "p2" });
      l.edges.push({ from: "T1", to: "D1", kind: "structural", confidence: "high", evidence: "order" },
        { from: "T1", to: "D2", kind: "structural", confidence: "high", evidence: "order" });
    } });
    env.suite.resolution = RUNS;
    env.suite.onRun = culpritOf("T1");
    let release!: () => void;
    env.suite.runGate = new Promise<void>(resolve => { release = resolve; });
    env.queue.enqueue(["T1", "T2"]);
    await env.until(() => env.suite.runs.length === 1, "the held suite");
    expect(env.state("T1")).toBe("integrated");
    await env.writer.append([
      { type: "task-transition", taskId: "D1", from: "pending", to: "ready", trigger: "deps-satisfied", detail: null },
      { type: "task-transition", taskId: "D2", from: "pending", to: "ready", trigger: "deps-satisfied", detail: null },
    ]);
    await env.writer.append([
      { type: "attempt-started", taskId: "D2", attempt: openAttempt(1) },
      { type: "task-transition", taskId: "D2", from: "ready", to: "dispatched", trigger: "launch", detail: null },
      { type: "task-slot", taskId: "D2", slot: "slot-d2", branch: `omr/${PLAN_ID}/t/D2` },
    ]);
    await env.writer.append([
      { type: "attempt-child", taskId: "D2", n: 1, childSessionID: "ses-child-d2" },
      { type: "task-transition", taskId: "D2", from: "dispatched", to: "running", trigger: "child-created", detail: null },
    ]);
    expect(env.state("D1")).toBe("ready");
    expect(env.state("D2")).toBe("running");
    expect(env.ledger.tasks.D2?.attempts.map(a => a.outcome)).toEqual([null]);
    // the live dependent's slot release fails: logged, its lease is still released
    env.pool.onRelease = slot => { if (slot === "slot-d2") throw new Error("d2 slot busy"); };
    release();
    await env.until(() => env.state("T1") === "reverted" && env.phase().gate === "pending" && env.quiet(), "the revert");
    expect(env.state("D1")).toBe("blocked");
    expect(env.state("D2")).toBe("blocked");
    const blocked = env.w.journal.filter(e => e.type === "task-transition" && e.to === "blocked");
    expect(blocked.map(e => (e.type === "task-transition" ? `${e.taskId}:${e.from}:${e.trigger}` : ""))).toEqual(["D1:ready:dep-reverted", "D2:running:dep-reverted"]);
    expect(env.ledger.tasks.D2?.slot).toBeNull();
    // the in-flight attempt of the live dependent is ended in the row-34 batch (a blocked task holds no open attempt)
    expect(env.ledger.tasks.D2?.attempts.map(a => a.outcome)).toEqual(["interrupted"]);
    expect(env.ledger.tasks.D1?.attempts).toEqual([]);
    expect(env.settled).toEqual(["D2"]);
    expect(env.logger.warnings.some(w => w.includes("slot release failed: d2 slot busy"))).toBe(true);
    expect(env.pool.released).toContain("slot-d2");
    expect(env.leases.released).toEqual(expect.arrayContaining(["D1", "D2"]));
    env.assertInvariants();
  });

  it("M1: a blocked dependent's slot goes back through the runtime's saved release, never pool.release directly", async () => {
    const env = await setup({ tasks: 2, batchMax: 1, mutate: l => {
      l.phases.push({ id: "p2", title: "Phase 2", wave: "w1", dependsOn: [], gate: "pending", qaRound: 1, paused: false, tag: null });
      l.waves[0]?.phases.push("p2");
      l.tasks.D2 = taskNode("D2", { phase: "p2" });
      l.edges.push({ from: "T1", to: "D2", kind: "structural", confidence: "high", evidence: "order" });
    } });
    env.suite.resolution = RUNS;
    env.suite.onRun = culpritOf("T1");
    let release!: () => void;
    env.suite.runGate = new Promise<void>(resolve => { release = resolve; });
    env.queue.enqueue(["T1", "T2"]);
    await env.until(() => env.suite.runs.length === 1, "the held suite");
    await env.writer.append([{ type: "task-transition", taskId: "D2", from: "pending", to: "ready", trigger: "deps-satisfied", detail: null }]);
    await env.writer.append([
      { type: "attempt-started", taskId: "D2", attempt: openAttempt(1) },
      { type: "task-transition", taskId: "D2", from: "ready", to: "dispatched", trigger: "launch", detail: null },
      { type: "task-slot", taskId: "D2", slot: "slot-d2", branch: `omr/${PLAN_ID}/t/D2` },
    ]);
    release();
    await env.until(() => env.state("T1") === "reverted" && env.phase().gate === "pending" && env.quiet(), "the revert");
    expect(env.state("D2")).toBe("blocked");
    expect(env.settled).toEqual(["D2"]);
    // The queue handed the slot to the runtime's saved release; the pool double saw only that release behind it.
    expect(env.slotReleases).toEqual(["D2:slot-d2"]);
    expect(env.pool.released.filter(s => s === "slot-d2")).toHaveLength(1);
    env.assertInvariants();
  });
});

describe("land failure modes", () => {
  const completed = (l: LedgerV1): void => { l.status = "completed"; l.config.land = "ff-when-clean"; };

  it("an inspect that throws is a blocking item with the error, and the entry closes refused", async () => {
    const env = await setup({ tasks: 0, mutate: completed });
    env.lander.inspect = async () => { throw new Error("inspect boom"); };
    const r = await env.queue.land();
    expect(r.landed).toBe(false);
    expect(r.inbox).toMatchObject({ kind: "landing", severity: "blocking" });
    expect(r.inbox?.text).toContain("inspect boom");
    expect(await env.steps("land")).toEqual(["land:land:start", "land:land:end/refused"]);
    expect(env.lander.landCalls).toEqual([]);
    env.assertInvariants();
  });

  it("a fastForward that throws is reported as a lander error with the manual command", async () => {
    const env = await setup({ tasks: 0, mutate: completed });
    env.lander.fastForward = async () => { throw new Error("ff boom"); };
    const r = await env.queue.land();
    expect(r.landed).toBe(false);
    expect(r.inbox?.text).toContain("ff boom");
    expect(r.inbox?.text).toContain("merge --ff-only");
    env.assertInvariants();
  });

  it("a lander whose command hints throw still yields the refusal item, without commands", async () => {
    const env = await setup({ tasks: 0, mutate: completed });
    env.lander.inspectResult = { ok: false, refusal: { reason: "dirty", paths: ["a.txt"] }, baseTip: hex(1) };
    env.lander.commands = () => { throw new Error("no hints"); };
    const r = await env.queue.land();
    expect(r.landed).toBe(false);
    expect(r.inbox).toMatchObject({ kind: "landing", severity: "blocking" });
    expect(r.inbox?.text).toContain("dirty");
    expect(r.inbox?.text).not.toContain("git -C");
    expect(env.logger.warnings.some(w => w.includes("lander.commands threw: no hints"))).toBe(true);
  });

  it("a land recorded ok is repeated when the base branch no longer points at the head", async () => {
    const env = await setup({ tasks: 0, mutate: completed });
    expect(await env.queue.land()).toEqual({ landed: true, inbox: null });
    env.w.branches.set(MAIN_REF, hex(9));
    expect(await env.queue.land()).toEqual({ landed: true, inbox: null });
    expect(env.lander.landCalls).toHaveLength(2);
    expect(await env.steps("land")).toHaveLength(4);
    env.assertInvariants();
  });

  it("a land whose base ref cannot be read is not taken for done", async () => {
    const env = await setup({ tasks: 0, mutate: completed });
    await env.queue.land();
    const real = env.igit.readRef.bind(env.igit);
    // Only the base branch read fails (git error). The integration branch is read in the toplevel too since QA-3.2-9, so a
    // cwd-wide failure would now hit that read as well (covered by the next test).
    env.igit.readRef = async (cwd, ref) => ref === MAIN_REF ? Promise.reject(new Error("no ref")) : real(cwd, ref);
    await env.queue.land();
    expect(env.lander.landCalls).toHaveLength(2);
  });

  it("QA-3.2-9: a land whose integration branch git cannot read ends refused with an item; nothing escapes, nothing lands", async () => {
    const env = await setup({ tasks: 0, mutate: completed });
    env.igit.readRef = async () => { throw new Error("spawn git EAGAIN"); };
    const r = await env.queue.land();
    expect(r.landed).toBe(false);
    expect(r.inbox?.text).toContain("could not read");
    expect(env.lander.landCalls).toHaveLength(0);
    expect(await env.steps("land")).toEqual(["land:land:start", "land:land:end/refused"]);
    env.assertInvariants();
  });
});

describe("abort edge cases", () => {
  it("a rollback git failure is logged; the entry is still closed and the task cancelled", async () => {
    const env = await setup({ tasks: 1 });
    env.w.checkScript.push(errorResult("spawn"), errorResult("spawn"), errorResult("spawn"));
    env.queue.enqueue(["T1"]);
    await env.until(() => env.ledger.status === "paused", "M13a pause");
    env.pool.reset = async () => { throw new Error("reset failed"); };
    await env.queue.abort();
    expect(env.logger.warnings.some(w => w.includes("failed: reset failed"))).toBe(true);
    expect(env.state("T1")).toBe("cancelled");
    expect(env.writer.openIntegration()).toEqual([]);
    expect(await lastRollbackEnd(env)).toEqual({ v: 1, reset: null });
    expect(env.pool.released).toContain("slot-1");
    expect(env.locks.held).toBe(false);
  });

  it("a slot release that fails during abort is logged and the lease is still released", async () => {
    const env = await orphanEnv(1, 1);
    env.pool.release = async () => { throw new Error("slot busy"); };
    await env.queue.abort();
    expect(env.logger.warnings.some(w => w.includes("slot release failed: slot busy"))).toBe(true);
    expect(env.leases.released).toContain("T1");
    expect(env.state("T1")).toBe("cancelled");
  });

  it("abort stops a suite in flight and journals nothing for it as a verdict", async () => {
    const env = await setup({ tasks: 1, batchMax: 1 });
    env.suite.resolution = RUNS;
    env.suite.run = async (_req, j) => {
      await new Promise<void>(resolve => j.signal.addEventListener("abort", () => resolve(), { once: true }));
      return { kind: "interrupted", by: "abort" };
    };
    env.queue.enqueue(["T1"]);
    await env.until(() => env.writer.openIntegration().some(o => o.entry.kind === "phase-suite"), "the suite entry");
    await env.queue.abort();
    expect(env.writer.openIntegration()).toEqual([]);
    expect((await env.steps("phase-suite")).slice(-2)).toEqual(["phase-suite:rollback:start", "phase-suite:rollback:end/rolled-back"]);
    expect(env.phase().gate).toBe("suite-running");
    env.assertInvariants();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// More lane, tag, abort and resume edges
// ---------------------------------------------------------------------------------------------------------------

describe("lane, tag, abort and resume edges", () => {
  const passedGate = (l: LedgerV1): void => { const p = l.phases[0]; if (p !== undefined) p.gate = "passed"; };

  it("checkPhase while the tag entry is in flight does not queue a second tag", async () => {
    const env = await setup({ tasks: 0, resume: false, mutate: passedGate });
    let open!: () => void;
    const gate = new Promise<void>(resolve => { open = resolve; });
    const real = env.lander.tag.bind(env.lander);
    env.lander.tag = async req => { await gate; return real(req); };
    await env.queue.resume();
    await env.until(() => env.writer.openIntegration().some(o => o.entry.kind === "tag"), "the tag entry");
    await env.queue.checkPhase("p1");
    await env.queue.checkPhase("p1");
    open();
    await env.until(() => env.phase().tag !== null && env.quiet(), "the tag");
    expect(await env.steps("tag")).toEqual(["tag:tag:start", "tag:tag:end/ok"]);
    env.assertInvariants();
  });

  it("a ci slot that cannot be released is logged after the suite closed", async () => {
    const env = await setup({ tasks: 1, batchMax: 1 });
    env.suite.resolution = RUNS;
    env.pool.release = async slot => { if (slot === "ci") throw new Error("ci busy"); };
    env.queue.enqueue(["T1"]);
    await env.until(() => env.phase().gate === "awaiting-qa" && env.quiet() && env.logger.warnings.length > 0, "the suite and the warning");
    expect(env.logger.warnings.some(w => w.includes("ci release failed: ci busy"))).toBe(true);
    env.assertInvariants();
  });

  it("resume halts when the ancestry check on a moved branch throws", async () => {
    const env = await setup({ tasks: 0, resume: false });
    const stray = env.w.commit(null, null);
    env.w.passed.add(stray.sha);
    env.w.branches.set(INT_REF, stray.sha);
    env.igit.isAncestor = async () => { throw new Error("no git"); };
    const report = await env.queue.resume();
    expect(report.halted).toBe(true);
    expect(env.ledger.status).toBe("paused");
    expect(env.ledger.inbox).toHaveLength(1);
  });

  it("abort tolerates a failing revert --abort and still resets the integration slot", async () => {
    const env = await suiteEnv(2, culpritOf("T1"));
    env.suite.revertScript.push({ kind: "error", reason: "spawn", message: "no git" });
    await env.until(() => env.ledger.status === "paused", "the revert pause");
    env.igit.revertAbort = async () => { throw new Error("revert --abort failed"); };
    await env.queue.abort();
    expect(env.writer.openIntegration()).toEqual([]);
    expect(env.logger.warnings.some(w => w.includes("rollback of"))).toBe(false);
    expect(await lastRollbackEnd(env)).toEqual({ v: 1, reset: env.ledger.integration.head });
    expect(env.pool.resets).toContainEqual({ slot: "integration", commit: env.ledger.integration.head });
    env.assertInvariants();
  });

  it("abort rolls back a suite in the background lane and a task in the serial lane in one pass", async () => {
    const env = await setup({ tasks: 2, batchMax: 1, mutate: l => {
      l.phases.push({ id: "p2", title: "Phase 2", wave: "w1", dependsOn: [], gate: "pending", qaRound: 1, paused: false, tag: null });
      l.waves[0]?.phases.push("p2");
      const t = l.tasks.T2;
      if (t !== undefined) t.phase = "p2";
    } });
    env.suite.resolution = RUNS;
    env.suite.run = async (_req, j) => {
      await new Promise<void>(resolve => j.signal.addEventListener("abort", () => resolve(), { once: true }));
      return { kind: "interrupted", by: "abort" };
    };
    env.queue.enqueue(["T1"]);
    await env.until(() => env.writer.openIntegration().some(o => o.entry.kind === "phase-suite"), "the suite entry");
    env.w.checkGate = new Promise<void>(() => undefined);
    env.queue.enqueue(["T2"]);
    await env.until(() => env.w.checkLog.length === 2, "the second check");
    expect(env.writer.openIntegration().map(o => o.entry.kind).sort()).toEqual(["phase-suite", "task"]);
    await env.queue.abort();
    expect(env.writer.openIntegration()).toEqual([]);
    expect(env.state("T1")).toBe("integrated");
    expect(env.state("T2")).toBe("cancelled");
    expect(env.pool.released).toContain("slot-2");
    expect(env.leases.released).toContain("T2");
    env.assertInvariants();
  });

  it("a journal call after a rejected append is refused: the lanes are stopped", async () => {
    const env = await setup({ tasks: 1, batchMax: 1 });
    env.suite.resolution = RUNS;
    const seen: Record<string, unknown> = {};
    env.suite.run = async (_req, j) => {
      await j.end("ok", { v: 1, files: [], idsUnparsed: false, durationMs: 1, output: "" });
      const target = env.writer.attempts + 1;
      env.writer.rejectOn = n => n === target ? new Error("append refused") : null;
      seen.start = await j.start("bisect", { v: 1, base: "", candidate: "", tasks: [] }).then(() => "ok", (e: unknown) => (e as Error).message);
      seen.guard = await j.assertWriteCwd("C:/slots/ci", "slot").then(() => "ok", (e: unknown) => (e as Error).name);
      return { kind: "interrupted", by: "abort" };
    };
    env.queue.enqueue(["T1"]);
    await env.until(() => seen.guard !== undefined, "the journal calls");
    expect(seen).toEqual({ start: "append refused", guard: "LaneStop" });
    await env.settle();
    expect(env.ledger.status).toBe("running");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Rarely taken arms: serial lane
// ---------------------------------------------------------------------------------------------------------------

describe("serial lane: rare arms", () => {
  it("a non-Error rejection from git is reported with its text", async () => {
    const env = await setup({ tasks: 1 });
    env.git.rebaseOnto = () => Promise.reject("plain failure");
    env.queue.enqueue(["T1"]);
    await env.until(() => env.ledger.status === "paused", "the pause");
    expect(env.logger.warnings.some(w => w.includes("lane error: plain failure"))).toBe(true);
    expect(env.ledger.inbox[0]?.text).toContain("plain failure");
    env.assertInvariants();
  });

  it("a slot record that vanishes between the rebase and the checks pauses without a refusal row (no step open)", async () => {
    const env = await setup({ tasks: 1 });
    const real = env.pool.get.bind(env.pool);
    let calls = 0;
    env.pool.get = async slot => (++calls === 2 ? null : real(slot));
    env.queue.enqueue(["T1"]);
    await env.until(() => env.ledger.status === "paused", "the pause");
    expect((await env.steps("task")).slice(-1)).toEqual(["task:rebase:end/ok"]);
    expect(env.ledger.inbox[0]?.text).toContain("slot not found");
    expect(env.w.checkLog).toEqual([]);
    env.assertInvariants();
  });

  it("a slot record with an owner and no commit is used as is", async () => {
    const env = await setup({ tasks: 1 });
    const real = env.pool.get.bind(env.pool);
    env.pool.get = async slot => {
      const r = await real(slot);
      return r === null ? null : { ...r, owner: "ses-owner", commit: null };
    };
    env.queue.enqueue(["T1"]);
    await env.until(() => env.state("T1") === "integrated" && env.quiet());
    expect(env.w.checkLog.map(c => c.slot)).toEqual(["slot-1"]);
    env.assertInvariants();
  });

  it("abort while a batch is being rebased stops before the next task and rolls the entry back", async () => {
    const env = await setup({ tasks: 2, batchMax: 4 });
    const real = env.git.rebaseOnto.bind(env.git);
    const box: { aborting: Promise<void> | null } = { aborting: null };
    let calls = 0;
    env.git.rebaseOnto = async (slot, onto) => {
      calls++;
      if (box.aborting === null) box.aborting = env.queue.abort();
      return real(slot, onto);
    };
    env.queue.enqueue(["T1", "T2"]);
    await env.until(() => box.aborting !== null, "the abort");
    await box.aborting;
    expect(calls).toBe(1);
    expect(env.state("T1")).toBe("cancelled");
    expect(env.state("T2")).toBe("cancelled");
    expect((await env.steps("batch")).slice(-3)).toEqual(["batch:rebase:end/rolled-back", "batch:rollback:start", "batch:rollback:end/rolled-back"]);
    expect(env.w.tip()).toBe(env.w.base);
    expect(env.w.checkLog).toEqual([]);
    env.assertInvariants();
  });

  it("a git error raised while abort is under way is logged, not turned into a pause", async () => {
    const env = await setup({ tasks: 1 });
    const box: { aborting: Promise<void> | null } = { aborting: null };
    env.git.rebaseOnto = async () => {
      box.aborting = env.queue.abort();
      throw new Error("rebase died during abort");
    };
    env.queue.enqueue(["T1"]);
    await env.until(() => box.aborting !== null, "the abort");
    await box.aborting;
    expect(env.ledger.status).toBe("running");
    expect(env.ledger.inbox).toEqual([]);
    expect(env.state("T1")).toBe("cancelled");
    expect(env.logger.warnings.some(w => w.includes("rebase died during abort"))).toBe(true);
    expect(env.writer.openIntegration()).toEqual([]);
    env.assertInvariants();
  });

  it("checks that fail without ids, files or output still blame the task, with a one-line context", async () => {
    const env = await setup({ tasks: 1 });
    env.w.checkScript.push({ verdict: "fail", components: [], failingIds: [], failingFiles: [], flakyIds: [], output: "", durationMs: 1 });
    env.queue.enqueue(["T1"]);
    await env.until(() => env.state("T1") === "failed" && env.quiet());
    const ctx = env.ledger.tasks.T1?.attempts[0]?.context ?? "";
    expect(ctx.startsWith("Integration checks failed for T1")).toBe(true);
    expect(ctx).not.toContain("\n");
    const end = (await env.events()).filter(isStep).find(e => e.step === "checks" && e.edge === "end");
    expect(end?.failingIds).toEqual([]);
    expect(end?.closes).toBe(true);
    env.assertInvariants();
  });

  it("an integration branch deleted during the checks halts naming the missing ref and moves nothing", async () => {
    const env = await setup({ tasks: 1 });
    env.w.afterCheck = () => { env.w.branches.delete(INT_REF); };
    env.queue.enqueue(["T1"]);
    await env.until(() => env.ledger.status === "paused", "the halt");
    // QA-3.2-9 wording: the missing ref is named precisely.
    expect(env.ledger.inbox[0]?.text).toContain(`The integration branch ref ${INT_REF} does not exist`);
    expect(env.w.writes.some(x => x.op === "branchForce" || x.op === "mergeFfOnly")).toBe(false);
    expect((await env.steps("task")).slice(-1)).toEqual(["task:fast-forward:end/refused"]);
    // (no assertInvariants: the world's I1 check reads a missing branch as the tip "", which this test deleted on purpose)
  });

  it("a requeued entry of a paused phase waits until the phase is unpaused", async () => {
    const env = await orphanEnv(1, 1);
    await env.queue.resume();
    await env.writer.append([{ type: "phase-paused", phaseId: "p1", paused: true, reason: "test" }]);
    await env.writer.append([{ type: "status-changed", from: "paused", to: "running", reason: "unpause" }]);
    env.queue.enqueue([]);
    await env.settle();
    expect(env.state("T1")).toBe("integrating");
    expect(env.queue.queued()).toEqual(["T1"]);
    await env.writer.append([{ type: "phase-paused", phaseId: "p1", paused: false, reason: "unpause" }]);
    env.queue.enqueue([]);
    await env.until(() => env.state("T1") === "integrated" && env.quiet(), "the requeued entry");
    expect(env.w.integratedCount()).toEqual({ T1: 1 });
    env.assertInvariants();
  });

  it("tasks without attempts get no attempt context on conflict or failure, and still change state", async () => {
    const env = await setup({ tasks: 2, batchMax: 1, mutate: l => {
      for (const id of ["T1", "T2"]) { const t = l.tasks[id]; if (t !== undefined) t.attempts = []; }
    } });
    env.w.conflictOnHead.add("T1");
    env.w.bad.add("T2");
    env.queue.enqueue(["T1", "T2"]);
    await env.until(() => env.state("T1") === "conflict" && env.state("T2") === "failed" && env.quiet(), "both decided");
    expect(env.w.journal.some(e => e.type === "attempt-context")).toBe(false);
    expect(env.listener.calls).toEqual(expect.arrayContaining(["conflict:T1", "failed:T2"]));
    expect(env.w.tip()).toBe(env.w.base);
    env.assertInvariants();
  });

  it("concurrent resume() calls share one run", async () => {
    const env = await setup({ tasks: 1, resume: false });
    const a = env.queue.resume();
    const b = env.queue.resume();
    expect(b).toBe(a);
    expect(await b).toEqual({ completed: [], rolledBack: [], halted: false, entries: [] });
  });

  it("a stalled poll that fires in the same tick as dispose does nothing", async () => {
    const env = await setup({ tasks: 1 });
    const box: { disposing: Promise<void> | null } = { disposing: null };
    env.clock.setTimer(5_000, () => { box.disposing = env.queue.dispose(); }); // held before the stalled poll timer
    env.w.checkScript.push(errorResult("spawn"), errorResult("spawn"), errorResult("spawn"));
    env.queue.enqueue(["T1"]);
    await env.until(() => env.ledger.status === "paused", "the pause");
    await env.writer.append([{ type: "status-changed", from: "paused", to: "running", reason: "unpause" }]);
    const seq = env.ledger.seq;
    env.clock.fire();
    await box.disposing;
    await env.settle();
    expect(env.ledger.seq).toBe(seq);
    expect(env.writer.openIntegration()).toHaveLength(1);
    expect(env.state("T1")).toBe("integrating");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Rarely taken arms: suite, revert and checkPhase
// ---------------------------------------------------------------------------------------------------------------

describe("suite and revert: rare arms", () => {
  it("journal.end with nothing open is refused; the queue still closes the suite", async () => {
    const env = await setup({ tasks: 1, batchMax: 1 });
    env.suite.resolution = RUNS;
    const seen: { second: unknown } = { second: null };
    env.suite.run = async (_req, j) => {
      await j.end("ok", { v: 1, files: [], idsUnparsed: false, durationMs: 1, output: "" });
      seen.second = await j.end("ok", { v: 1, files: [], idsUnparsed: false, durationMs: 1, output: "" })
        .then(() => "ok", (e: unknown) => (e as { code?: unknown }).code);
      return { kind: "passed" };
    };
    env.queue.enqueue(["T1"]);
    await env.until(() => env.phase().gate === "awaiting-qa" && env.quiet(), "the gate");
    expect(seen.second).toBe("E_INVALID_INPUT");
    expect(await env.steps("phase-suite")).toEqual([
      "phase-suite:phase-suite:start", "phase-suite:phase-suite:end/ok", "phase-suite:phase-suite:start", "phase-suite:phase-suite:end/ok",
    ]);
    env.assertInvariants();
  });

  it("an unattributed failure outside the phase ranges records `last-passes` and pauses the phase", async () => {
    const env = await suiteEnv(1, () => ({ kind: "unattributed", ids: ["test:x"], reason: "outside" }));
    await env.until(() => env.phase().paused && env.quiet(), "the phase pause");
    const end = (await env.events()).filter(isStep).find(e => e.entry.kind === "phase-suite" && e.edge === "end");
    expect(JSON.parse(end?.detail ?? "{}")).toMatchObject({ verdict: "fail", outside: "last-passes" });
    expect(env.ledger.inbox[0]?.text).toContain("(outside)");
    expect(env.suite.reverts).toEqual([]);
    env.assertInvariants();
  });

  it("a culprit that names no task of the plan starts no revert entry", async () => {
    const env = await suiteEnv(1, req => ({ kind: "culprit", range: { taskId: "ghost", from: req.base ?? hex(1), to: req.commit }, ids: ["test:x"], files: [] }));
    await env.until(() => env.phase().gate === "suite-failed" && env.quiet(), "the failed gate");
    await env.settle();
    expect(env.suite.reverts).toEqual([]);
    expect(await env.steps("revert")).toEqual([]);
    expect(env.state("T1")).toBe("integrated");
    env.assertInvariants();
  });

  const unpause = { type: "status-changed", from: "paused", to: "running", reason: "unpause" } as const;

  it("a revert runner that ended its build step as failed: the queue opens revert-checks and closes it failed", async () => {
    const env = await suiteEnv(2, culpritOf("T1"));
    env.suite.revert = async (_req, j) => {
      await j.end("failed", { v: 1, reason: "scripted" });
      return { kind: "failed", ids: ["test:T2"], files: ["t/T2.test.ts"], output: "still red" };
    };
    await env.until(() => env.phase().paused && env.quiet(), "the insufficient revert");
    expect(await env.steps("revert")).toEqual(["revert:revert-build:start", "revert:revert-build:end/failed", "revert:revert-checks:start", "revert:revert-checks:end/failed"]);
    const start = (await env.events()).filter(isStep).find(e => e.step === "revert-checks" && e.edge === "start");
    expect(JSON.parse(start?.detail ?? "{}")).toMatchObject({ candidate: start?.entry.baseHead });
    expect(env.state("T1")).toBe("integrated");
    env.assertInvariants();
  });

  it("a revert runner that ended its step before a conflict: the queue reopens revert-build to close it", async () => {
    const env = await suiteEnv(2, culpritOf("T1"));
    env.suite.revert = async (_req, j) => {
      await j.end("conflict", { v: 1, reason: "scripted" });
      return { kind: "conflict", at: hex(999), paths: ["src/T1.ts"] };
    };
    await env.until(() => env.phase().paused && env.quiet(), "the revert conflict");
    expect(await env.steps("revert")).toEqual(["revert:revert-build:start", "revert:revert-build:end/conflict", "revert:revert-build:start", "revert:revert-build:end/conflict"]);
    env.assertInvariants();
  });

  it("a revert runner that ended its step before an error: pause without a second refusal row", async () => {
    const env = await suiteEnv(2, culpritOf("T1"));
    env.suite.revert = async (_req, j) => {
      await j.end("refused", { v: 1, reason: "scripted" });
      return { kind: "error", reason: "spawn", message: "no git" };
    };
    await env.until(() => env.ledger.status === "paused", "the pause");
    expect(await env.steps("revert")).toEqual(["revert:revert-build:start", "revert:revert-build:end/refused"]);
    expect(env.ledger.inbox.at(-1)?.text).toContain("no git");
    env.assertInvariants();
  });

  it("a revert runner that closed its checks itself: the queue goes straight to the fast-forward", async () => {
    const env = await suiteEnv(2, culpritOf("T1"));
    env.suite.revert = async (req, j) => {
      await j.assertWriteCwd(req.slot.path, "integration");
      env.w.write("revert", req.slot.path);
      const c = env.w.commit(req.head, null, req.culprit.taskId);
      env.w.passed.add(c.sha);
      await j.end("ok", { v: 1, revertHead: c.sha, reverted: [req.culprit.taskId] });
      return { kind: "ok", revertHead: c.sha, reverted: [req.culprit.taskId] };
    };
    await env.until(() => env.state("T1") === "reverted" && env.quiet(), "the revert");
    expect(await env.steps("revert")).toEqual(["revert:revert-build:start", "revert:revert-build:end/ok", "revert:revert-fast-forward:start", "revert:revert-fast-forward:end/ok"]);
    expect(env.w.tasksAt(env.w.tip())).toEqual(["T2"]);
    env.assertInvariants();
  });

  it("checkPhase queues nothing while the suite runs or while its revert waits behind a busy serial lane", async () => {
    const env = await setup({ tasks: 2, batchMax: 1, mutate: l => {
      l.phases.push({ id: "p2", title: "Phase 2", wave: "w1", dependsOn: [], gate: "pending", qaRound: 1, paused: false, tag: null });
      l.waves[0]?.phases.push("p2");
      const t = l.tasks.T2;
      if (t !== undefined) t.phase = "p2";
    } });
    env.suite.resolution = RUNS;
    env.suite.onRun = culpritOf("T1");
    let releaseSuite!: () => void;
    env.suite.runGate = new Promise<void>(resolve => { releaseSuite = resolve; });
    env.queue.enqueue(["T1"]);
    await env.until(() => env.suite.runs.length === 1, "the held p1 suite");
    await env.queue.checkPhase("p1"); // suite-running with its entry open: nothing queued
    let openChecks!: () => void;
    env.w.checkGate = new Promise<void>(resolve => { openChecks = resolve; });
    env.queue.enqueue(["T2"]);
    await env.until(() => env.w.checkLog.length === 2, "T2's check in flight");
    env.suite.runGate = null;
    releaseSuite();
    await env.until(() => env.phase("p1").gate === "suite-failed", "the culprit");
    await env.queue.checkPhase("p1"); // suite-failed with the revert pending: nothing queued
    await env.queue.checkPhase("p1");
    openChecks();
    await env.until(() => env.state("T1") === "reverted" && env.state("T2") === "integrated" && env.quiet(), "both lanes");
    expect(env.suite.reverts).toHaveLength(1);
    expect(env.suite.runs.filter(r => r.phaseId === "p1")).toHaveLength(1);
    env.assertInvariants();
  });

  it("a suite queued for a phase that is paused before it runs is skipped until the phase is unpaused", async () => {
    const env = await setup({ tasks: 2, batchMax: 1, mutate: l => {
      l.phases.push({ id: "p2", title: "Phase 2", wave: "w1", dependsOn: [], gate: "pending", qaRound: 1, paused: false, tag: null });
      l.waves[0]?.phases.push("p2");
      const t = l.tasks.T2;
      if (t !== undefined) t.phase = "p2";
    } });
    env.suite.resolution = RUNS;
    let releaseSuite!: () => void;
    env.suite.runGate = new Promise<void>(resolve => { releaseSuite = resolve; });
    env.queue.enqueue(["T1"]);
    await env.until(() => env.suite.runs.length === 1, "the held p1 suite");
    env.queue.enqueue(["T2"]);
    await env.until(() => env.state("T2") === "integrated" && env.writer.inflight === 0, "T2");
    await env.writer.append([{ type: "phase-paused", phaseId: "p2", paused: true, reason: "test" }]);
    env.suite.runGate = null;
    releaseSuite();
    await env.until(() => env.phase("p1").gate === "awaiting-qa" && env.quiet(), "the p1 suite");
    await env.settle();
    expect(env.phase("p2").gate).toBe("pending");
    expect(env.suite.runs.map(r => r.phaseId)).toEqual(["p1"]);
    await env.writer.append([{ type: "phase-paused", phaseId: "p2", paused: false, reason: "unpause" }]);
    await env.queue.checkPhase("p2");
    await env.until(() => env.phase("p2").gate === "awaiting-qa" && env.quiet(), "the p2 suite");
    expect(env.suite.runs.map(r => r.phaseId)).toEqual(["p1", "p2"]);
    env.assertInvariants();
  });

  it("unpause after a revert error pause: the stalled revert entry is rolled back and its rerun completes", async () => {
    const env = await suiteEnv(2, culpritOf("T1"));
    env.suite.revertScript.push({ kind: "error", reason: "spawn", message: "no git" });
    await env.until(() => env.ledger.status === "paused", "the revert pause");
    await env.writer.append([unpause]);
    env.clock.fire(); // the stalled poll
    await env.until(() => env.state("T1") === "reverted" && env.phase().gate === "pending" && env.quiet(), "the rerun revert");
    const steps = await env.steps("revert");
    expect(steps).toContain("revert:rollback:end/rolled-back");
    expect(steps.slice(-1)).toEqual(["revert:revert-fast-forward:end/ok"]);
    env.assertInvariants();
  });
});

describe("dispose while a closing batch is in flight: the batch lands, nothing after it runs", () => {
  /** Calls dispose() as the k-th next append starts; that append still lands. */
  function disposeOnAppend(env: Env, k: number): { disposing: Promise<void> | null } {
    const target = env.writer.attempts + k;
    const box: { disposing: Promise<void> | null } = { disposing: null };
    env.writer.rejectOn = n => {
      if (n === target) box.disposing = env.queue.dispose();
      return null;
    };
    return box;
  }

  it("row 30: the task is integrated in the ledger but no slot, lease or listener call follows", async () => {
    const env = await setup({ tasks: 1 });
    const box = disposeOnAppend(env, 6); // open, rebase end, checks start, checks end, ff start, row 30
    env.queue.enqueue(["T1"]);
    await env.until(() => box.disposing !== null, "dispose");
    await box.disposing;
    expect(env.state("T1")).toBe("integrated");
    expect(env.pool.released).toEqual([]);
    expect(env.leases.released).toEqual([]);
    expect(env.listener.calls).toEqual([]);
    expect(env.phase().gate).toBe("pending");
    env.assertInvariants();
  });

  it("row 31: the conflict lands without an onConflict call", async () => {
    const env = await setup({ tasks: 1 });
    env.w.conflictOnHead.add("T1");
    const box = disposeOnAppend(env, 2); // open, row 31
    env.queue.enqueue(["T1"]);
    await env.until(() => box.disposing !== null, "dispose");
    await box.disposing;
    expect(env.state("T1")).toBe("conflict");
    expect(env.listener.calls).toEqual([]);
    env.assertInvariants();
  });

  it("row 32: the failure lands without an onFailed call", async () => {
    const env = await setup({ tasks: 1 });
    env.w.bad.add("T1");
    const box = disposeOnAppend(env, 4); // open, rebase end, checks start, row 32
    env.queue.enqueue(["T1"]);
    await env.until(() => box.disposing !== null, "dispose");
    await box.disposing;
    expect(env.state("T1")).toBe("failed");
    expect(env.listener.calls).toEqual([]);
    env.assertInvariants();
  });

  it("a halt: the pause and its inbox item land, the listener is not told and no stalled poll is armed", async () => {
    const env = await setup({ tasks: 1 });
    env.w.casFails = true;
    const box = disposeOnAppend(env, 6); // open, rebase end, checks start, checks end, ff start, halt
    env.queue.enqueue(["T1"]);
    await env.until(() => box.disposing !== null, "dispose");
    await box.disposing;
    expect(env.ledger.status).toBe("paused");
    expect(env.ledger.inbox).toHaveLength(1);
    expect(env.listener.inbox).toEqual([]);
    // even with the plan running again, no stalled poll rolls the entry back after dispose
    await env.writer.append([{ type: "status-changed", from: "paused", to: "running", reason: "unpause" }]);
    env.clock.fire();
    await env.settle();
    expect(env.writer.openIntegration()).toHaveLength(1);
    expect((await env.steps("task")).some(s => s.includes("rollback"))).toBe(false);
    env.assertInvariants();
  });

  it("a suite close: the gate opens in the ledger but the listener only heard suite-running", async () => {
    const env = await setup({ tasks: 1, batchMax: 1 });
    env.suite.resolution = RUNS;
    const box = disposeOnAppend(env, 8); // 6 for T1, then the suite's open and close
    env.queue.enqueue(["T1"]);
    await env.until(() => box.disposing !== null, "dispose");
    await box.disposing;
    expect(env.phase().gate).toBe("awaiting-qa");
    expect(env.listener.calls.filter(c => c.startsWith("gate:"))).toEqual(["gate:p1:suite-running"]);
    env.assertInvariants();
  });
});

describe("concurrent checkPhase calls", () => {
  it("two calls on an integrated phase without a suite open the gate once and notify once", async () => {
    const env = await setup({ tasks: 0, resume: false });
    await Promise.all([env.queue.checkPhase("p1"), env.queue.checkPhase("p1")]);
    expect(env.phase().gate).toBe("awaiting-qa");
    expect((await env.events()).filter(e => e.type === "gate-changed")).toHaveLength(1);
    expect(env.listener.calls.filter(c => c === "gate:p1:awaiting-qa")).toHaveLength(1);
  });

  it("two calls on an integrated phase with a suite queue it twice; the second run is skipped by the gate guard", async () => {
    // The phase needs a task of its own (settled), or it skips the suite (QA-3.2-19).
    const env = await setup({ tasks: 0, resume: false, mutate: l => { l.tasks.D = taskNode("D", { state: "cancelled" }); } });
    env.suite.resolution = RUNS;
    await Promise.all([env.queue.checkPhase("p1"), env.queue.checkPhase("p1")]);
    await env.queue.resume();
    await env.until(() => env.phase().gate === "awaiting-qa" && env.quiet(), "the suite");
    await env.settle();
    expect(env.suite.runs).toHaveLength(1);
    expect(await env.steps("phase-suite")).toEqual(["phase-suite:phase-suite:start", "phase-suite:phase-suite:end/ok"]);
    env.assertInvariants();
  });

  it("two calls on a suite-failed phase without history queue two reruns; only one runs", async () => {
    const env = await setup({ tasks: 0, resume: false, mutate: l => { const p = l.phases[0]; if (p !== undefined) p.gate = "suite-failed"; } });
    env.suite.resolution = RUNS;
    await Promise.all([env.queue.checkPhase("p1"), env.queue.checkPhase("p1")]);
    await env.queue.resume();
    await env.until(() => env.phase().gate === "awaiting-qa" && env.quiet(), "the rerun");
    await env.settle();
    expect(env.suite.runs).toHaveLength(1);
    env.assertInvariants();
  });

  it("a requeued task that was cancelled meanwhile is dropped from the queue without an entry", async () => {
    const env = await orphanEnv(1, 1);
    await env.queue.resume();
    expect(env.queue.queued()).toEqual(["T1"]);
    await env.writer.append([
      { type: "task-transition", taskId: "T1", from: "integrating", to: "cancelled", trigger: "abort", detail: null },
      { type: "task-slot", taskId: "T1", slot: null, branch: `omr/${PLAN_ID}/t/T1` },
    ]);
    await env.writer.append([{ type: "status-changed", from: "paused", to: "running", reason: "unpause" }]);
    const seq = env.ledger.seq;
    env.queue.enqueue([]);
    await env.settle();
    expect(env.queue.queued()).toEqual([]);
    expect(env.ledger.seq).toBe(seq);
    expect(env.w.integratedCount()).toEqual({});
    env.assertInvariants();
  });
});

describe("QA-3.2-15 / QA-3.2-16: tags after completion, row-34 batch with an in-flight qa dependent", () => {
  const passed = (l: LedgerV1): void => { const p = l.phases[0]; if (p !== undefined) p.gate = "passed"; };

  it("QA-3.2-15: a phase that passed but is untagged when the plan completed is still tagged", async () => {
    const env = await setup({ tasks: 0, resume: false, mutate: l => { passed(l); l.status = "completed"; } });
    await env.queue.resume();
    await env.until(() => env.phase().tag !== null && env.quiet(), "tagged");
    expect(env.phase().tag).toBe(`omr/${PLAN_ID}/phase/p1`);
    expect(env.ledger.status).toBe("completed");
    env.assertInvariants();
  });

  it("QA-3.2-15: a tag entry rolled back by the stalled poll comes due again and is tagged", async () => {
    const env = await setup({ tasks: 0, resume: false, mutate: passed });
    env.lander.tagOutcome = { kind: "error", message: "git tag failed" };
    await env.queue.resume();
    await env.until(() => env.ledger.status === "paused" && env.quiet() === false, "tag stalled");
    env.lander.tagOutcome = null;
    await unpause(env);
    await env.until(() => env.phase().tag !== null && env.quiet(), "tagged after the unpause");
    expect((await env.steps("tag")).filter(s => s === "tag:rollback:start")).toHaveLength(1);
    env.assertInvariants();
  });

  it("QA-3.2-16: the row-34 batch ends an in-flight qa dependent at max(now, startedAt) and writes its G2 gate event", async () => {
    const future = "2026-12-31T00:00:00.000Z" as IsoTime;
    // A valid draft (Q pending, p2 pending and listed by its wave); Q gets in flight through journaled batches while the p1
    // suite is held, as the dependents test does. p2 has no task of its own, so resume opens its QA gate (QA-3.2-19).
    const env = await setup({ tasks: 1, batchMax: 1, mutate: l => {
      l.phases.push({ id: "p2", title: "Phase 2", wave: "w1", dependsOn: [], gate: "pending", qaRound: 1, paused: false, tag: null });
      l.waves[0]?.phases.push("p2");
      l.tasks.Q = taskNode("Q", { kind: "qa", phase: "p2" });
      l.edges.push({ from: "T1", to: "Q", kind: "structural", confidence: "high", evidence: "order" });
    } });
    expect(env.phase("p2").gate).toBe("awaiting-qa");
    env.suite.resolution = RUNS;
    env.suite.onRun = culpritOf("T1");
    let release!: () => void;
    env.suite.runGate = new Promise<void>(resolve => { release = resolve; });
    env.queue.enqueue(["T1"]);
    await env.until(() => env.suite.runs.length === 1, "the held suite");
    await env.writer.append([{ type: "task-transition", taskId: "Q", from: "pending", to: "ready", trigger: "deps-satisfied", detail: null }]);
    // The attempt starts in the future of the queue's clock: endedAt must not precede it (A2-6).
    await env.writer.append([
      { type: "attempt-started", taskId: "Q", attempt: { ...openAttempt(1), startedAt: future } },
      { type: "task-transition", taskId: "Q", from: "ready", to: "dispatched", trigger: "launch", detail: null },
      { type: "task-slot", taskId: "Q", slot: "slot-q", branch: `omr/${PLAN_ID}/t/Q` },
      { type: "gate-changed", phaseId: "p2", from: "awaiting-qa", to: "qa-running", trigger: "qa-dispatched", qaRound: 1 },
    ]);
    await env.writer.append([
      { type: "attempt-child", taskId: "Q", n: 1, childSessionID: "ses-child-q" },
      { type: "task-transition", taskId: "Q", from: "dispatched", to: "running", trigger: "child-created", detail: null },
    ]);
    expect(env.state("Q")).toBe("running");
    expect(env.phase("p2").gate).toBe("qa-running");
    release();
    await env.until(() => env.state("T1") === "reverted" && env.phase().gate === "pending" && env.quiet(), "revert completion");
    expect(env.ledger.status).toBe("running"); // the row-34 batch was accepted (no illegal-transition pause)
    expect(env.state("Q")).toBe("blocked");
    expect(env.phase("p2").gate).toBe("awaiting-qa");
    expect(env.ledger.tasks.Q?.attempts[0]?.endedAt).toBe(future);
    const g2 = env.w.journal.find(e => e.type === "gate-changed" && e.phaseId === "p2" && e.trigger === "qa-requeued");
    expect(g2).toMatchObject({ from: "qa-running", to: "awaiting-qa" });
    expect(env.settled).toEqual(["Q"]);
    env.assertInvariants();
  });
});

describe("QA-3.2 round 2", () => {
  const okLock = (): RepoLock => ({ lost: new AbortController().signal, release: async () => undefined });

  /** A culprit verdict for T1 whose file list is far over DETAIL_MAX_BYTES, so encodeDetail truncates it (m1). */
  const manyFiles = Array.from({ length: 2000 }, (_, i) => `t/some/very/long/directory/name/number-${i}.test.ts`);
  const hugeCulprit = (req: SuiteRunRequest): SuiteVerdict => {
    const r = req.ranges.find(x => x.taskId === "T1");
    return r === undefined ? { kind: "passed" } : { kind: "culprit", range: { ...r }, ids: ["test:T1"], files: manyFiles };
  };

  it("m1: a truncated suite closing detail rebuilds the revert from history with files: [] (the whole command runs)", async () => {
    const env = await setup({ tasks: 1, batchMax: 1 });
    env.suite.resolution = RUNS;
    // The process dies right after the culprit batch, before the revert entry opens.
    env.suite.onRun = req => { env.writer.crashAfter = env.writer.appends + 1; return hugeCulprit(req); };
    env.queue.enqueue(["T1"]);
    await env.until(() => env.w.dead, "the crash after the culprit batch");
    env.suite.onRun = null;
    await env.restart();
    const closing = (await env.events()).filter(isStep).find(e => e.entry.kind === "phase-suite" && e.closes);
    expect(parseDetail(closing?.detail)).toMatchObject({ truncated: true });
    await env.queue.resume();
    await env.until(() => env.state("T1") === "reverted" && env.quiet(), "the revert rebuilt from history");
    expect(env.suite.reverts).toHaveLength(1);
    expect(env.suite.reverts[0]?.regression).toMatchObject({ ids: ["test:T1"], files: [] });
    env.assertInvariants();
  });

  it("m1: a truncated revert-build start detail gives the resume rerun of the revert files: []", async () => {
    const env = await setup({ tasks: 1, batchMax: 1 });
    env.suite.resolution = RUNS;
    env.suite.onRun = hugeCulprit;
    const realRevert = env.suite.revert.bind(env.suite);
    let crashed = false;
    // The process dies inside the first revert build (its revert-build step stays open).
    env.suite.revert = async (req, j) => {
      if (!crashed) {
        crashed = true;
        env.w.dead = true;
        throw new CrashError("crash while building the revert");
      }
      return realRevert(req, j);
    };
    env.queue.enqueue(["T1"]);
    await env.until(() => crashed && env.w.dead, "the crash in the revert build");
    env.suite.onRun = null;
    await env.restart();
    const start = (await env.events()).filter(isStep).find(e => e.entry.kind === "revert" && e.step === "revert-build" && e.edge === "start");
    expect(parseDetail(start?.detail)).toMatchObject({ truncated: true });
    const report = await env.queue.resume();
    expect(report.entries).toEqual([expect.objectContaining({ kind: "revert", action: "rerun" })]);
    await env.until(() => env.state("T1") === "reverted" && env.quiet(), "the rerun revert");
    expect(env.suite.reverts).toHaveLength(1);
    expect(env.suite.reverts[0]?.regression).toMatchObject({ ids: ["test:T1"], files: [] });
    env.assertInvariants();
  });

  it("QA-3.2-24: a revert rebuilt from history after a restart carries the failing files", async () => {
    const env = await setup({ tasks: 1, batchMax: 1 });
    env.suite.resolution = RUNS;
    const culprit = culpritOf("T1");
    // The process dies right after the culprit batch, before the revert entry opens.
    env.suite.onRun = req => { env.writer.crashAfter = env.writer.appends + 1; return culprit(req); };
    env.queue.enqueue(["T1"]);
    await env.until(() => env.w.dead, "the crash after the culprit batch");
    expect(env.phase().gate).toBe("suite-failed");
    expect(env.suite.reverts).toHaveLength(0);
    env.suite.onRun = null;
    await env.restart();
    await env.queue.resume();
    await env.until(() => env.state("T1") === "reverted" && env.quiet(), "the revert rebuilt from history");
    expect(env.suite.reverts[0]?.regression).toMatchObject({ ids: ["test:T1"], files: ["t/T1.test.ts"] });
    env.assertInvariants();
  });

  it("QA-3.2-25: after two reverts the retry still replays the original change (journaled first upstream)", async () => {
    let F = "";
    let C1 = "";
    let R1 = "";
    let C1b = "";
    let R2 = "";
    const env = await setup({ tasks: 1, resume: false, mutate: (l, w) => {
      F = w.base;
      C1 = w.branches.get(`refs/heads/omr/${PLAN_ID}/t/T1`) ?? ""; // integrated as is (no rebase)
      R1 = w.commit(C1, null, "T1").sha; // first revert
      C1b = w.commit(R1, "T1").sha; // the first retry landed as C1''+fix1'
      R2 = w.commit(C1b, null, "T1").sha; // second revert = head
      const X1 = w.commit(C1, "T1").sha; // retry branches built on the old task branch
      const X2 = w.commit(X1, "T1").sha;
      w.branches.set(`refs/heads/omr/${PLAN_ID}/t/T1`, X2);
      w.slotCommit.set("slot-1", X2);
      w.branches.set(INT_REF, R2);
      w.passed.add(R2);
      l.integration.head = R2;
    } });
    const t1: IntegrationEntry = { id: "i-800", kind: "task", phaseId: "p1", taskIds: ["T1"], slot: "slot-1", baseHead: F, candidate: null };
    const t2: IntegrationEntry = { id: "i-820", kind: "task", phaseId: "p1", taskIds: ["T1"], slot: "slot-1", baseHead: R1, candidate: null };
    const rv1: IntegrationEntry = { id: "i-810", kind: "revert", phaseId: "p1", taskIds: ["T1"], slot: "integration", baseHead: C1, candidate: R1 };
    const rv2: IntegrationEntry = { id: "i-830", kind: "revert", phaseId: "p1", taskIds: ["T1"], slot: "integration", baseHead: C1b, candidate: R2 };
    const revertFf = (e: IntegrationEntry, from: string, to: string): IntegrationStepEvent[] => [
      stepEvent(e, { step: "revert-fast-forward", edge: "start", detail: JSON.stringify({ v: 1, from: e.baseHead, to: e.candidate, culprit: { taskId: "T1", from, to }, suiteCommit: e.baseHead }) }),
      stepEvent(e, { step: "revert-fast-forward", edge: "end", result: "ok", closes: true, detail: "{}" }),
    ];
    env.historyExtra = [
      stepEvent(t1, { step: "rebase", edge: "start", detail: JSON.stringify({ v: 1, onto: F, tasks: [{ taskId: "T1", tip: C1, upstream: F }] }) }),
      ...revertFf(rv1, F, C1),
      stepEvent(t2, { step: "rebase", edge: "start", detail: JSON.stringify({ v: 1, onto: R1, tasks: [{ taskId: "T1", tip: C1, upstream: F }] }) }),
      ...revertFf(rv2, R1, C1b),
    ];
    const upstreams: string[] = [];
    const g: GitOps = env.git;
    const real = env.git.rebaseOnto.bind(env.git);
    g.rebaseOnto = async (cwd, onto, upstream) => { upstreams.push(upstream); return real(cwd, onto); };
    env.igit.mergeBase = async () => C1; // merge-base(R2, X2) = C1: the latest revert's range alone would keep C1 and drop it
    await env.queue.resume();
    env.queue.enqueue(["T1"]);
    await env.until(() => env.state("T1") === "integrated" && env.quiet(), "T1 re-integrated");
    expect(upstreams).toEqual([F]);
    env.assertInvariants();
  });

  it("QA-3.2-28: a lock lost before the checks stops before their slot prepare", async () => {
    const env = await setup({ tasks: 1 });
    const lost = new AbortController();
    env.locks.acquire = async () => ({ lost: lost.signal, release: async () => undefined });
    const g: GitOps = env.git;
    const real = env.git.rebaseOnto.bind(env.git);
    g.rebaseOnto = async (cwd, onto, upstream) => { const r = await real(cwd, onto); lost.abort(); void upstream; return r; };
    env.queue.enqueue(["T1"]);
    await env.until(() => env.ledger.status === "paused", "halted");
    expect(env.w.checkLog).toEqual([]);
    expect(env.ledger.inbox[env.ledger.inbox.length - 1]?.text).toContain("lock");
    env.assertInvariants();
  });

  it("QA-3.2-28: right before the CAS the lock file is re-read; a replaced file halts with no branchForce", async () => {
    const env = await setup({ tasks: 1 });
    let verified = 0;
    env.locks.acquire = async () => ({ lost: new AbortController().signal, release: async () => undefined,
      verify: async () => { verified++; return false; } });
    env.queue.enqueue(["T1"]);
    await env.until(() => env.ledger.status === "paused", "halted");
    expect(verified).toBe(1);
    expect(env.w.writes.some(w => w.op === "branchForce")).toBe(false);
    expect(env.w.tip()).toBe(env.w.base);
    env.assertInvariants();
  });

  it("QA-3.2-29: a stalled entry whose rollback fails stays stalled and is rolled back at the next poll", async () => {
    const env = await setup({ tasks: 1 });
    env.w.checkScript.push(errorResult("spawn"), errorResult("spawn"), errorResult("spawn"));
    env.queue.enqueue(["T1"]);
    await env.until(() => env.ledger.status === "paused", "paused");
    const realReset = env.pool.reset.bind(env.pool);
    let fail = true;
    env.pool.reset = async (slot, commit) => {
      if (fail) {
        fail = false;
        throw new Error("reset failed");
      }
      return realReset(slot, commit);
    };
    await unpause(env);
    await env.until(() => !fail && env.writer.inflight === 0, "the failed rollback");
    await env.settle();
    expect(env.state("T1")).toBe("integrating");
    env.clock.advance(5_000);
    env.clock.fire(); // the next poll
    await env.until(() => env.state("T1") === "integrated" && env.quiet(), "rolled back and integrated");
    env.assertInvariants();
  });

  it("QA-3.2-30: a completed plan's failing tag is rolled back, retried with backoff, then given up with one item", async () => {
    const env = await setup({ tasks: 0, resume: false, mutate: l => { l.status = "completed"; const p = l.phases[0]; if (p !== undefined) p.gate = "passed"; } });
    env.lander.tagOutcome = { kind: "error", message: "git tag failed" };
    const tagStarts = (): number => env.w.journal.filter(e => e.type === "integration-step" && e.step === "tag" && e.edge === "start").length;
    await env.queue.resume();
    // Round 1 runs at resume; rounds 2-4 are the backoff retries (TAG_RETRY_LIMIT = 3), each fired by the clock.
    for (let round = 1; round <= 4; round++) {
      await env.until(() => tagStarts() === 3 * round && env.quiet(), `tag round ${round}`);
      await env.settle();
      env.clock.advance(1_000_000);
      env.clock.fire();
    }
    await env.until(() => env.quiet() && env.ledger.inbox.length > 0, "given up");
    await env.settle();
    expect((await env.steps("tag")).filter(s => s === "tag:tag:start")).toHaveLength(4 * 3);
    expect(env.ledger.inbox).toHaveLength(1);
    expect(env.ledger.inbox[0]?.text).toContain("stops retrying");
    expect(env.ledger.inbox[0]?.text).not.toContain("unpause");
    expect(env.ledger.status).toBe("completed");
    expect(env.phase().tag).toBeNull();
  });

  it("QA-3.2-31: a phase with no task of its own is woken when the phase it depends on integrates", async () => {
    const env = await setup({ tasks: 1, mutate: l => {
      l.phases.push({ id: "p2", title: "Phase 2", wave: "w1", dependsOn: ["p1"], gate: "pending", qaRound: 1, paused: false, tag: null });
      l.waves[0]?.phases.push("p2");
    } });
    expect(env.phase("p2").gate).toBe("pending");
    env.queue.enqueue(["T1"]);
    await env.until(() => env.phase("p2").gate === "awaiting-qa" && env.quiet(), "p2 woken");
    expect(env.phase("p1").gate).toBe("awaiting-qa");
    env.assertInvariants();
  });

  it("QA-3.2-32: a task cancelled while its entry waits for the repo lock is dropped, never integrated", async () => {
    const env = await setup({ tasks: 2, batchMax: 1 });
    let open!: () => void;
    const gate = new Promise<void>(resolve => { open = resolve; });
    let waiting = false;
    env.locks.acquire = async () => {
      if (!waiting) {
        waiting = true;
        await gate;
      }
      return okLock();
    };
    env.queue.enqueue(["T1", "T2"]);
    await env.until(() => waiting, "the lane waits for the lock");
    await env.writer.append([
      { type: "task-transition", taskId: "T1", from: "verified", to: "cancelled", trigger: "abort", detail: null },
      { type: "task-slot", taskId: "T1", slot: null, branch: `omr/${PLAN_ID}/t/T1` },
    ]);
    open();
    await env.until(() => env.state("T2") === "integrated" && env.quiet(), "T2 integrated");
    expect(env.state("T1")).toBe("cancelled");
    expect(env.w.integratedCount()).toEqual({ T2: 1 });
    expect(env.w.journal.some(e => JSON.stringify(e).includes("integration.dequeue.skipped"))).toBe(true);
    env.assertInvariants();
  });

  it("QA-3.2-33: a long lock wait posts one blocking item; an acquire error pauses with an item and keeps the task", async () => {
    const env = await setup({ tasks: 2, batchMax: 1 });
    const realAcquire = env.locks.acquire.bind(env.locks);
    const locks: RepoLockFactory = env.locks;
    locks.acquire = async (_k, _h, _s, onWait) => {
      onWait?.({ file: "C:/state/repos/x/integration.lock", pid: 7, hostname: "hx", planId: "p9", heartbeatAgeMs: 120_000, waitedMs: 300_000 });
      return okLock();
    };
    env.queue.enqueue(["T1"]);
    await env.until(() => env.state("T1") === "integrated" && env.quiet(), "T1 integrated");
    const waitItem = env.ledger.inbox.find(i => i.text.includes("C:/state/repos/x/integration.lock"));
    expect(waitItem?.severity).toBe("blocking");
    expect(waitItem?.text).toContain("pid 7");
    locks.acquire = async () => { throw new Error("EACCES on the lock directory"); };
    env.queue.enqueue(["T2"]);
    await env.until(() => env.ledger.status === "paused", "paused");
    expect(env.ledger.inbox[env.ledger.inbox.length - 1]?.text).toContain("could not be taken");
    expect(env.queue.queued()).toEqual(["T2"]);
    locks.acquire = async () => realAcquire();
    await unpause(env);
    await env.until(() => env.state("T2") === "integrated" && env.quiet(), "T2 integrated after the unpause");
    env.assertInvariants();
  });

  it("QA-3.2-34: a rejected append releases the repo lock; abort() clears a poll armed by an infrastructure pause", async () => {
    const env = await setup({ tasks: 2, batchMax: 1 });
    const at = env.writer.attempts + 1;
    env.writer.rejectOn = n => n === at ? new ExecutorError("E_ILLEGAL_TRANSITION", "scripted", null) : null;
    env.queue.enqueue(["T1"]);
    await env.until(() => env.ledger.status === "paused", "paused");
    expect(env.locks.held).toBe(false);

    const env2 = await setup({ tasks: 1 });
    const real = env2.igit.readRef.bind(env2.igit);
    env2.igit.readRef = async (cwd, ref) => { if (ref.endsWith("/t/T1")) throw new Error("git died"); return real(cwd, ref); };
    env2.queue.enqueue(["T1"]);
    await env2.until(() => env2.ledger.status === "paused", "infrastructure pause");
    const armed = env2.clock.heldCount();
    await env2.queue.abort();
    expect(env2.clock.heldCount()).toBeLessThan(armed);
  });

  it("QA-3.2-35: a base branch that already contains the landed head counts as landed (no second land)", async () => {
    const env = await setup({ tasks: 0, mutate: l => { l.status = "completed"; l.config.land = "ff-when-clean"; } });
    expect(await env.queue.land()).toEqual({ landed: true, inbox: null });
    env.w.branches.set(MAIN_REF, env.w.commit(env.ledger.integration.head, null).sha); // the owner committed on top
    expect(await env.queue.land()).toEqual({ landed: true, inbox: null });
    expect(env.lander.landCalls).toHaveLength(1);
    expect(await env.steps("land")).toHaveLength(2);
  });

  it("QA-3.2-36: abort() between the checks and the merge: no merge, no CAS, the task is cancelled", async () => {
    const env = await setup({ tasks: 1 });
    let armed = false;
    let aborting: Promise<void> | null = null;
    env.w.afterCheck = () => { armed = true; };
    const real = env.igit.readRef.bind(env.igit);
    env.igit.readRef = async (cwd, ref) => {
      if (armed && ref === INT_REF && aborting === null) aborting = env.queue.abort();
      return real(cwd, ref);
    };
    env.queue.enqueue(["T1"]);
    await env.until(() => aborting !== null, "abort fired");
    await aborting;
    expect(env.w.writes.some(w => w.op === "mergeFfOnly" || w.op === "branchForce")).toBe(false);
    expect(env.state("T1")).toBe("cancelled");
    expect(env.w.tip()).toBe(env.w.base);
    env.assertInvariants();
  });

  it("QA-3.2-36: a suite verdict returned after abort() writes no gate, pause or inbox event", async () => {
    const env = await setup({ tasks: 1, batchMax: 1 });
    env.suite.resolution = RUNS;
    const culprit = culpritOf("T1");
    let aborting: Promise<void> | null = null;
    env.suite.onRun = req => { aborting = env.queue.abort(); return culprit(req); };
    env.queue.enqueue(["T1"]);
    await env.until(() => aborting !== null, "abort fired");
    await aborting;
    expect(env.phase().gate).toBe("suite-running");
    expect(env.listener.calls).not.toContain("gate:p1:suite-failed");
    expect(env.suite.reverts).toHaveLength(0);
    expect(env.ledger.inbox).toEqual([]);
    expect(env.writer.openIntegration()).toEqual([]);
  });

  it("nit: a suite that is off on a suite-running gate points to phaseSuite", async () => {
    const env = await setup({ tasks: 0, resume: false, mutate: l => { const p = l.phases[0]; if (p !== undefined) p.gate = "suite-running"; } });
    env.suite.resolution = { kind: "off" };
    await env.queue.resume();
    await env.until(() => env.phase().paused && env.quiet(), "phase paused");
    expect(env.ledger.inbox[env.ledger.inbox.length - 1]?.text).toContain("phaseSuite");
  });

  it("nit: resume() step 0 whose ancestry check cannot run halts as infrastructure, not as moved", async () => {
    const env = await setup({ tasks: 0, resume: false });
    env.w.branches.set(INT_REF, env.w.commit(env.w.base, null).sha);
    env.igit.isAncestor = async () => { throw new Error("git died"); };
    const r = await env.queue.resume();
    expect(r.halted).toBe(true);
    const text = env.ledger.inbox[env.ledger.inbox.length - 1]?.text ?? "";
    expect(text).toContain("infrastructure");
    expect(text).not.toContain("no journaled fast-forward explains it");
  });

  it("nit: a task branch with no common ancestor (merge-base exit 1) is a blocking item, not an infrastructure pause", async () => {
    const env = await setup({ tasks: 1 });
    env.igit.mergeBase = async () => { throw new ExecutorError("E_GIT", "git merge-base failed (exit 1)", { op: "merge-base", code: 1, stderr: "" }); };
    env.queue.enqueue(["T1"]);
    await env.until(() => env.ledger.inbox.length > 0, "the item");
    await env.settle();
    expect(env.ledger.status).toBe("running");
    expect(env.ledger.inbox[0]).toMatchObject({ severity: "blocking" });
    expect(env.ledger.inbox[0]?.text).toContain("no common ancestor");
    expect(env.queue.queued()).toEqual([]);
  });
});

describe("QA-3.2-10: re-integrating a reverted task", () => {
  it("a reverted task whose commit lies below the merge base (ff without rebase) is rebased from its reverted range's from", async () => {
    let F = "";
    let C1 = "";
    let R = "";
    const env = await setup({ tasks: 1, resume: false, mutate: (l, w) => {
      F = w.base;
      C1 = w.branches.get(`refs/heads/omr/${PLAN_ID}/t/T1`) ?? ""; // fast-forwarded as is: the task commit is on the branch
      R = w.commit(C1, null, "T1").sha; // the revert commit is the integration head
      const X = w.commit(C1, "T1").sha; // the retry branch: the old task branch plus a fix
      w.branches.set(`refs/heads/omr/${PLAN_ID}/t/T1`, X);
      w.slotCommit.set("slot-1", X);
      w.branches.set(INT_REF, R);
      w.passed.add(R);
      l.integration.head = R;
    } });
    const rv: IntegrationEntry = { id: "i-900", kind: "revert", phaseId: "p1", taskIds: ["T1"], slot: "integration", baseHead: C1, candidate: R };
    env.historyExtra = [
      stepEvent(rv, { step: "revert-fast-forward", edge: "start", detail: JSON.stringify({ v: 1, from: C1, to: R, culprit: { taskId: "T1", from: F, to: C1 }, suiteCommit: C1 }) }),
      stepEvent(rv, { step: "revert-fast-forward", edge: "end", result: "ok", closes: true, detail: JSON.stringify({ v: 1, from: C1, to: R }) }),
    ];
    const upstreams: string[] = [];
    const g: GitOps = env.git;
    const real = env.git.rebaseOnto.bind(env.git);
    g.rebaseOnto = async (cwd, onto, upstream) => { upstreams.push(upstream); return real(cwd, onto); };
    env.igit.mergeBase = async () => C1; // merge-base(R, X) = C1: rebasing from it would replay only the fix
    await env.queue.resume();
    env.queue.enqueue(["T1"]);
    await env.until(() => env.state("T1") === "integrated" && env.quiet(), "T1 re-integrated");
    expect(upstreams).toEqual([F]);
    env.assertInvariants();
  });

  it("a retry branch built on the reverted head (it contains the revert) keeps the merge base", async () => {
    let C1 = "";
    let R = "";
    const env = await setup({ tasks: 1, resume: false, mutate: (l, w) => {
      C1 = w.branches.get(`refs/heads/omr/${PLAN_ID}/t/T1`) ?? "";
      R = w.commit(C1, null, "T1").sha;
      const X = w.commit(R, "T1").sha; // rebuilt from the current head: the original change is redone in X
      w.branches.set(`refs/heads/omr/${PLAN_ID}/t/T1`, X);
      w.slotCommit.set("slot-1", X);
      w.branches.set(INT_REF, R);
      w.passed.add(R);
      l.integration.head = R;
    } });
    const rv: IntegrationEntry = { id: "i-901", kind: "revert", phaseId: "p1", taskIds: ["T1"], slot: "integration", baseHead: C1, candidate: R };
    env.historyExtra = [
      stepEvent(rv, { step: "revert-fast-forward", edge: "start", detail: JSON.stringify({ v: 1, from: C1, to: R, culprit: { taskId: "T1", from: env.w.base, to: C1 }, suiteCommit: C1 }) }),
      stepEvent(rv, { step: "revert-fast-forward", edge: "end", result: "ok", closes: true, detail: JSON.stringify({ v: 1, from: C1, to: R }) }),
    ];
    const upstreams: string[] = [];
    const g: GitOps = env.git;
    const real = env.git.rebaseOnto.bind(env.git);
    g.rebaseOnto = async (cwd, onto, upstream) => { upstreams.push(upstream); return real(cwd, onto); };
    env.igit.mergeBase = async () => R;
    await env.queue.resume();
    env.queue.enqueue(["T1"]);
    await env.until(() => env.state("T1") === "integrated" && env.quiet(), "T1 re-integrated");
    expect(upstreams).toEqual([R]);
    env.assertInvariants();
  });
});

describe("QA-3.2-2: a suite state is never left without a run", () => {
  for (const gate of ["suite-running", "suite-failed"] as const) {
    it(`gate ${gate} while the suite resolves to none: phase paused, critical item, gate unchanged; restored tests + unpause run it`, async () => {
      const env = await setup({ tasks: 0, resume: false, mutate: l => { const p = l.phases[0]; if (p !== undefined) p.gate = gate; } });
      env.suite.resolution = { kind: "none" };
      await env.queue.resume();
      await env.until(() => env.phase().paused && env.quiet(), "phase paused");
      await env.settle();
      expect(env.phase().gate).toBe(gate);
      const item = env.ledger.inbox[env.ledger.inbox.length - 1];
      expect(item?.severity).toBe("critical");
      expect(item?.text).toContain('"none"');
      expect(item?.text).toContain(env.ledger.integration.head);
      expect(item?.text).toContain(gate);
      expect((await env.events()).some(e => e.type === "gate-changed")).toBe(false);
      expect(env.suite.runs).toHaveLength(0);
      env.suite.resolution = RUNS;
      await env.writer.append([{ type: "phase-paused", phaseId: "p1", paused: false, reason: "unpause" }]);
      await env.queue.checkPhase("p1");
      await env.until(() => env.phase().gate === "awaiting-qa" && env.quiet(), "the suite ran");
      expect(env.suite.runs).toHaveLength(1);
      env.assertInvariants();
    });
  }
});

describe("tag and land: rare arms", () => {
  const passedGate = (l: LedgerV1): void => { const p = l.phases[0]; if (p !== undefined) p.gate = "passed"; };

  it("a lander.tag that throws counts as a failed try; after 3 the plan pauses and the tag stays unset", async () => {
    const env = await setup({ tasks: 0, resume: false, mutate: passedGate });
    let tries = 0;
    env.lander.tag = async () => { tries++; throw new Error("tag spawn failed"); };
    await env.queue.resume();
    await env.until(() => env.ledger.status === "paused", "the tag pause");
    expect(tries).toBe(3);
    const refusals = (await env.events()).filter(isStep).filter(e => e.step === "tag" && e.edge === "end").map(e => JSON.parse(e.detail ?? "{}") as { n: number; message: string });
    expect(refusals.map(r => r.n)).toEqual([1, 2, 3]);
    expect(refusals.every(r => r.message === "tag spawn failed")).toBe(true);
    expect(env.ledger.inbox.at(-1)?.text).toContain("tag spawn failed");
    expect(env.phase().tag).toBeNull();
    env.assertInvariants();
  });

  it("a tag that already exists at the same commit counts as tagged", async () => {
    const env = await setup({ tasks: 0, resume: false, mutate: passedGate });
    env.lander.tags.set(`omr/${PLAN_ID}/phase/p1`, env.w.base);
    await env.queue.resume();
    await env.until(() => env.phase().tag !== null && env.quiet(), "the tag");
    const end = (await env.events()).filter(isStep).find(e => e.step === "tag" && e.edge === "end");
    expect(JSON.parse(end?.detail ?? "{}")).toEqual({ v: 1, outcome: "exists-same" });
    env.assertInvariants();
  });

  it("land with the integration branch missing refuses with `(missing)` and lands nothing", async () => {
    const env = await setup({ tasks: 0, mutate: l => { l.status = "completed"; l.config.land = "ff-when-clean"; } });
    env.w.branches.delete(INT_REF);
    const r = await env.queue.land();
    expect(r.landed).toBe(false);
    expect(r.inbox).toMatchObject({ kind: "failure", severity: "critical" });
    expect(r.inbox?.text).toContain("(missing)");
    expect(env.lander.inspectCalls).toEqual([]);
    expect(env.w.landed).toBe(false);
  });
});

describe("resume: rare arms (4.8)", () => {
  const twoPhases = (l: LedgerV1): void => {
    l.phases.push({ id: "p2", title: "Phase 2", wave: "w1", dependsOn: [], gate: "pending", qaRound: 1, paused: false, tag: null });
    l.waves[0]?.phases.push("p2");
    const t = l.tasks.T2;
    if (t !== undefined) t.phase = "p2";
  };
  const parkUntilAbort = async (_req: SuiteRunRequest, j: StepJournal): Promise<SuiteVerdict> => {
    await new Promise<void>(resolve => j.signal.addEventListener("abort", () => resolve(), { once: true }));
    return { kind: "interrupted", by: "dispose" };
  };

  it("an aborted plan: resume reports nothing, journals nothing and latches nothing", async () => {
    const env = await setup({ tasks: 0, resume: false, mutate: l => { l.status = "aborted"; } });
    const seq = env.ledger.seq;
    expect(await env.queue.resume()).toEqual({ completed: [], rolledBack: [], halted: false, entries: [] });
    expect(env.ledger.seq).toBe(seq);
    expect(env.locks.acquires).toBe(0);
  });

  it("a plan that is not running yet: resume is E_PLAN_STATE", async () => {
    const env = await setup({ tasks: 0, resume: false, mutate: l => { l.status = "awaiting-approval"; } });
    await expect(env.queue.resume()).rejects.toMatchObject({ code: "E_PLAN_STATE" });
    expect(env.locks.acquires).toBe(0);
  });

  it("a branch moved ahead of the head with no journaled fast-forward to that commit halts", async () => {
    const env = await setup({ tasks: 1, resume: false });
    const ahead = env.w.commit(env.w.base, null);
    env.w.passed.add(ahead.sha);
    env.w.branches.set(INT_REF, ahead.sha);
    const report = await env.queue.resume();
    expect(report.halted).toBe(true);
    expect(env.ledger.status).toBe("paused");
    expect(env.ledger.inbox[0]?.text).toContain(ahead.sha);
    expect(env.ledger.integration.head).toBe(env.w.base);
    expect(env.w.writes).toEqual([]);
  });

  it("a serial and a background entry open at a restart are both rolled back, oldest first, then redone", async () => {
    const env = await setup({ tasks: 2, batchMax: 1, mutate: twoPhases });
    env.suite.resolution = RUNS;
    env.suite.run = parkUntilAbort;
    env.queue.enqueue(["T1"]);
    await env.until(() => env.writer.openIntegration().some(o => o.entry.kind === "phase-suite"), "the parked p1 suite");
    env.w.checkGate = new Promise<void>(() => undefined);
    env.queue.enqueue(["T2"]);
    await env.until(() => env.w.checkLog.length === 2, "T2's check in flight");
    expect(env.writer.openIntegration().map(o => o.entry.kind).sort()).toEqual(["phase-suite", "task"]);
    await env.restart();
    env.w.checkGate = null;
    env.suite.run = async () => ({ kind: "passed" });
    const report = await env.queue.resume();
    expect(report.entries.map(e => `${e.kind}:${e.action}`)).toEqual(["phase-suite:rerun", "task:rolled-back"]);
    expect(report.rolledBack).toEqual(["T2"]);
    await env.until(() => env.state("T2") === "integrated" && env.phase("p1").gate === "awaiting-qa" && env.phase("p2").gate === "awaiting-qa"
      && env.quiet(), "both redone");
    env.assertInvariants();
  });

  it("a revert rebuilt from the history before resume() is not confused with the open entries resume rolls back", async () => {
    const env = await setup({ tasks: 2, batchMax: 1, mutate: twoPhases });
    env.suite.resolution = RUNS;
    env.suite.onRun = culpritOf("T1");
    let releaseSuite!: () => void;
    env.suite.runGate = new Promise<void>(resolve => { releaseSuite = resolve; });
    let crash = true;
    let resolves = 0;
    env.suite.resolve = async () => {
      resolves++;
      if (crash && resolves === 3) { // right after the closing batch of the failed p1 suite
        env.w.dead = true;
        throw new CrashError("crash after the suite closed");
      }
      return RUNS;
    };
    env.queue.enqueue(["T1"]);
    await env.until(() => env.suite.runs.length === 1, "the held p1 suite");
    env.w.checkGate = new Promise<void>(() => undefined);
    env.queue.enqueue(["T2"]);
    await env.until(() => env.w.checkLog.length === 2, "T2's check in flight");
    env.suite.runGate = null;
    releaseSuite();
    await env.until(() => env.w.dead && env.phase("p1").gate === "suite-failed", "the crash");
    expect(env.writer.openIntegration().map(o => o.entry.kind)).toEqual(["task"]);
    await env.restart();
    crash = false;
    env.w.checkGate = null;
    await env.queue.checkPhase("p1"); // before resume: rebuilds the pending revert from the history (M25)
    const report = await env.queue.resume();
    expect(report.entries.map(e => `${e.kind}:${e.action}`)).toEqual(["task:rolled-back"]);
    await env.until(() => env.state("T1") === "reverted" && env.state("T2") === "integrated" && env.phase("p1").gate === "pending"
      && env.quiet(), "the revert and T2");
    expect(env.suite.reverts).toHaveLength(1);
    expect(env.suite.reverts[0]?.culprit.taskId).toBe("T1");
    env.assertInvariants();
  });

  it("requeued groups are ordered by entry start; a paused phase's orphan waits while a later entry integrates", async () => {
    const env = await setup({ tasks: 2, batchMax: 1, mutate: twoPhases });
    env.w.checkScript.push(errorResult("spawn"), errorResult("spawn"), errorResult("spawn"));
    env.queue.enqueue(["T1"]);
    await env.until(() => env.ledger.status === "paused", "T1's M13a pause");
    await env.restart();
    await env.queue.resume(); // rolls T1's entry back; the requeue lives only in this process
    await env.restart();
    const report = await env.queue.resume(); // T1 is an orphan now
    expect(report.rolledBack).toEqual(["T1"]);
    await env.writer.append([{ type: "phase-paused", phaseId: "p1", paused: true, reason: "test" }]);
    await env.writer.append([{ type: "status-changed", from: "paused", to: "running", reason: "unpause" }]);
    env.w.checkScript.push(errorResult("spawn"), errorResult("spawn"), errorResult("spawn"));
    env.queue.enqueue(["T2"]);
    await env.until(() => env.ledger.status === "paused", "T2's M13a pause");
    await env.writer.append([{ type: "status-changed", from: "paused", to: "running", reason: "unpause" }]);
    env.clock.fire(); // the stalled poll: T2's entry is rolled back and requeued next to T1's orphan group
    await env.until(() => env.state("T2") === "integrated" && env.writer.openIntegration().length === 0 && env.writer.inflight === 0, "T2");
    expect(env.state("T1")).toBe("integrating");
    expect(env.queue.queued()).toEqual(["T1"]);
    await env.writer.append([{ type: "phase-paused", phaseId: "p1", paused: false, reason: "unpause" }]);
    env.queue.enqueue([]);
    await env.until(() => env.state("T1") === "integrated" && env.quiet(), "T1");
    expect(env.w.integratedCount()).toEqual({ T1: 1, T2: 1 });
    env.assertInvariants();
  });

  it("a land redone after resume that cannot even start is logged", async () => {
    const env = await setup({ tasks: 0, mutate: (l, w) => {
      l.status = "completed";
      l.config.land = "ff-when-clean";
      const c = w.commit(w.base, "X");
      w.passed.add(c.sha);
      w.branches.set(INT_REF, c.sha);
      w.iwtHead = c.sha;
      l.integration.head = c.sha;
    } });
    env.writer.crashAfter = env.writer.appends + 1; // dies right after ISS(land)
    await expect(env.queue.land()).rejects.toThrow("crash after append");
    await env.restart();
    const realAcquire = env.locks.acquire.bind(env.locks);
    let acquires = 0;
    env.locks.acquire = async () => {
      acquires++;
      if (acquires === 2) throw new Error("lock dir gone"); // the land that resume starts
      return realAcquire();
    };
    const report = await env.queue.resume();
    expect(report.entries).toEqual([expect.objectContaining({ kind: "land", action: "rerun" })]);
    await env.until(() => env.logger.warnings.some(w => w.includes("land after resume failed: lock dir gone")), "the warning");
    // A completed plan has no pause to take: the acquire error goes to land()'s caller, no infrastructure item (QA-3.2-33
    // applies to a running lane only).
    expect(env.ledger.inbox).toEqual([]);
    expect(env.lander.landCalls).toEqual([]);
    expect(await env.steps("land")).toEqual(["land:land:start", "land:land:end/rolled-back"]);
  });

  it("abort before resume closes an entry that crashed in its rollback step without a second rollback start", async () => {
    const env = await setup({ tasks: 0, resume: false, mutate: l => { const p = l.phases[0]; if (p !== undefined) p.gate = "passed"; } });
    env.lander.tagOutcome = { kind: "error", message: "ref locked" };
    await env.queue.resume();
    await env.until(() => env.ledger.status === "paused", "the tag pause");
    await env.writer.append([{ type: "status-changed", from: "paused", to: "running", reason: "unpause" }]);
    env.writer.crashAfter = env.writer.appends + 1; // dies right after ISS(rollback)
    env.clock.fire();
    await env.until(() => env.w.dead, "the crash in the stalled rollback");
    await env.restart();
    await env.queue.abort();
    expect(env.writer.openIntegration()).toEqual([]);
    expect((await env.steps("tag")).slice(-2)).toEqual(["tag:rollback:start", "tag:rollback:end/rolled-back"]);
    expect((await env.steps("tag")).filter(s => s === "tag:rollback:start")).toHaveLength(1);
    expect(await lastRollbackEnd(env)).toEqual({ v: 1, reset: null });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Round 2: dequeue reads (QA-3.2-9), lock wait and lock errors (QA-3.2-33), re-check after the lock wait (QA-3.2-32)
// ---------------------------------------------------------------------------------------------------------------

type LockWait = Parameters<NonNullable<OnLockWait>>[0];
const unpauseEv = { type: "status-changed", from: "paused", to: "running", reason: "unpause" } as const;

describe("dequeue: branch reads, merge-base and the repo lock (round 2)", () => {
  it("merge-base exit 1 (no common ancestor) is a blocking owner repair, not an infrastructure pause", async () => {
    const env = await setup({ tasks: 1 });
    env.igit.mergeBase = async () => { throw new ExecutorError("E_GIT", "git merge-base exited 1", { code: 1 }); };
    env.queue.enqueue(["T1"]);
    await env.until(() => env.ledger.inbox.length === 1, "the blocking item");
    expect(env.ledger.inbox[0]).toMatchObject({ kind: "failure", severity: "blocking", taskId: "T1" });
    expect(env.ledger.inbox[0]?.text).toContain("has no common ancestor with the integration head");
    expect(env.ledger.status).toBe("running");
    expect(env.queue.queued()).toEqual([]);
    expect(await env.steps()).toEqual([]);
    env.assertInvariants();
  });

  it("a merge-base that cannot run is retried 3 times, then pauses with the task kept queued; the poll retries once running", async () => {
    const env = await setup({ tasks: 1 });
    const real = env.igit.mergeBase.bind(env.igit);
    let fails = 0;
    // a git exit other than 1 is infrastructure too; so is a non-Error rejection (reported with its text)
    env.igit.mergeBase = () => {
      fails++;
      return Promise.reject(fails === 1 ? new ExecutorError("E_GIT", "git merge-base exited 128", { code: 128 }) : "spawn EAGAIN");
    };
    env.queue.enqueue(["T1"]);
    await env.until(() => env.ledger.status === "paused", "the infrastructure pause");
    expect(fails).toBe(3);
    expect(env.ledger.inbox[0]).toMatchObject({ kind: "failure", severity: "critical" });
    expect(env.ledger.inbox[0]?.text).toContain("could not read its branches 3 times");
    expect(env.ledger.inbox[0]?.text).toContain("spawn EAGAIN");
    expect(env.queue.queued()).toEqual(["T1"]);
    expect(await env.steps()).toEqual([]);
    env.igit.mergeBase = real;
    env.clock.fire(); // still paused: the poll does nothing
    await env.settle();
    expect(env.state("T1")).toBe("verified");
    await env.writer.append([unpauseEv]);
    env.clock.fire();
    await env.until(() => env.state("T1") === "integrated" && env.quiet(), "the retried dequeue");
    env.assertInvariants();
  });

  it("a requeued group whose branch cannot be read is put back at the head of the queue", async () => {
    const env = await orphanEnv(1, 1);
    await env.queue.resume();
    await env.writer.append([unpauseEv]);
    const real = env.igit.readRef.bind(env.igit);
    env.igit.readRef = async (cwd, ref) => {
      if (ref.includes("/t/")) throw new Error("git: cannot lock ref");
      return real(cwd, ref);
    };
    env.queue.enqueue([]);
    await env.until(() => env.ledger.status === "paused", "the infrastructure pause");
    expect(env.queue.queued()).toEqual(["T1"]);
    expect(env.state("T1")).toBe("integrating");
    env.igit.readRef = real;
    await env.writer.append([unpauseEv]);
    env.clock.fire();
    await env.until(() => env.state("T1") === "integrated" && env.quiet(), "T1");
    expect(env.w.integratedCount()).toEqual({ T1: 1 });
    env.assertInvariants();
  });

  it("a repo lock that cannot be taken while running pauses with an item; the task stays queued and integrates later", async () => {
    const env = await setup({ tasks: 1 });
    env.locks.beforeAcquire = () => { throw new Error("EACCES: lock dir"); };
    env.queue.enqueue(["T1"]);
    await env.until(() => env.ledger.status === "paused", "the lock pause");
    expect(env.ledger.inbox[0]).toMatchObject({ kind: "failure", severity: "critical" });
    expect(env.ledger.inbox[0]?.text).toContain("could not be taken (EACCES: lock dir)");
    expect(env.queue.queued()).toEqual(["T1"]);
    expect(await env.steps()).toEqual([]);
    expect(env.logger.warnings.filter(w => w.includes("lane error"))).toEqual([]);
    env.locks.beforeAcquire = null;
    await env.writer.append([unpauseEv]);
    env.clock.fire();
    await env.until(() => env.state("T1") === "integrated" && env.quiet(), "T1");
    env.assertInvariants();
  });

  it("a requeued group whose lock cannot be taken is put back too", async () => {
    const env = await orphanEnv(1, 1);
    await env.queue.resume();
    await env.writer.append([unpauseEv]);
    env.locks.beforeAcquire = () => { throw new Error("EACCES: lock dir"); };
    env.queue.enqueue([]);
    await env.until(() => env.ledger.status === "paused", "the lock pause");
    expect(env.queue.queued()).toEqual(["T1"]);
    env.locks.beforeAcquire = null;
    await env.writer.append([unpauseEv]);
    env.clock.fire();
    await env.until(() => env.state("T1") === "integrated" && env.quiet(), "T1");
    env.assertInvariants();
  });

  it("resume() of a paused plan whose repo lock cannot be taken rejects with the error and journals nothing", async () => {
    const env = await setup({ tasks: 1, resume: false, mutate: l => { l.status = "paused"; } });
    env.locks.beforeAcquire = () => { throw new Error("EACCES: lock dir"); };
    const seq = env.ledger.seq;
    await expect(env.queue.resume()).rejects.toThrow("EACCES: lock dir");
    expect(env.ledger.seq).toBe(seq);
    expect(env.ledger.inbox).toEqual([]);
  });

  it("a long lock wait is reported once as a blocking item naming the holder (or an unreadable file)", async () => {
    const env = await setup({ tasks: 2, batchMax: 1 });
    const infos: LockWait[] = [
      { file: "C:/state/repos/x/integration.lock", pid: null, hostname: null, planId: null, heartbeatAgeMs: null, waitedMs: 600_000 },
      { file: "C:/state/repos/x/integration.lock", pid: 4242, hostname: null, planId: null, heartbeatAgeMs: 61_000, waitedMs: 1_200_000 },
    ];
    env.locks.beforeAcquire = onWait => {
      const info = infos.shift();
      if (info !== undefined) onWait?.(info);
    };
    env.queue.enqueue(["T1", "T2"]);
    await env.until(() => env.state("T1") === "integrated" && env.state("T2") === "integrated" && env.ledger.inbox.length === 2 && env.quiet(), "both");
    const texts = env.ledger.inbox.map(i => i.text);
    expect(env.ledger.inbox.every(i => i.kind === "failure" && i.severity === "blocking")).toBe(true);
    expect(texts[0]).toContain("held by an unreadable lock file; last heartbeat unknown ago");
    expect(texts[0]).toContain("waited 10 min");
    expect(texts[1]).toContain("held by pid 4242 on ? (plan ?); last heartbeat 61 s ago");
    expect(env.w.journal.filter(e => e.type === "metric" && JSON.stringify(e.metric).includes("integration.lock.wait"))).toHaveLength(2);
    env.assertInvariants();
  });

  it("a lock wait reported after dispose writes nothing", async () => {
    const env = await setup({ tasks: 1 });
    const box: { onWait: OnLockWait } = { onWait: undefined };
    env.locks.beforeAcquire = onWait => { box.onWait = onWait; };
    env.queue.enqueue(["T1"]);
    await env.until(() => env.state("T1") === "integrated" && env.quiet(), "T1");
    await env.queue.dispose();
    const seq = env.ledger.seq;
    box.onWait?.({ file: "f", pid: 1, hostname: "h", planId: "p", heartbeatAgeMs: 0, waitedMs: 1 });
    await env.settle();
    expect(env.ledger.seq).toBe(seq);
  });

  it("a task cancelled while the lane waited for the repo lock is dropped before any journal line (QA-3.2-32)", async () => {
    const env = await setup({ tasks: 1 });
    env.locks.beforeAcquire = async () => {
      env.locks.beforeAcquire = null;
      await env.writer.append([
        { type: "task-transition", taskId: "T1", from: "verified", to: "cancelled", trigger: "abort", detail: null },
        { type: "task-slot", taskId: "T1", slot: null, branch: `omr/${PLAN_ID}/t/T1` },
      ]);
    };
    env.queue.enqueue(["T1"]);
    await env.until(() => env.logger.warnings.some(w => w.includes("no longer verified after the repo-lock wait")), "the drop");
    await env.settle();
    expect(await env.steps()).toEqual([]);
    expect(env.state("T1")).toBe("cancelled");
    expect(env.queue.queued()).toEqual([]);
    expect(env.locks.held).toBe(false);
    expect(env.w.writes).toEqual([]);
    env.assertInvariants();
  });

  it("a batch member cancelled during the lock wait is dropped; the rest integrates as a task entry", async () => {
    const env = await setup({ tasks: 2, batchMax: 4 });
    env.locks.beforeAcquire = async () => {
      env.locks.beforeAcquire = null;
      await env.writer.append([
        { type: "task-transition", taskId: "T2", from: "verified", to: "cancelled", trigger: "abort", detail: null },
        { type: "task-slot", taskId: "T2", slot: null, branch: `omr/${PLAN_ID}/t/T2` },
      ]);
    };
    env.queue.enqueue(["T1", "T2"]);
    await env.until(() => env.state("T1") === "integrated" && env.quiet(), "T1");
    expect(env.state("T2")).toBe("cancelled");
    expect(await env.steps("task")).toContain("task:fast-forward:end/ok");
    expect(await env.steps("batch")).toEqual([]);
    expect(env.w.journal.some(e => e.type === "metric" && JSON.stringify(e.metric).includes("integration.dequeue.skipped"))).toBe(true);
    expect(env.w.tasksAt(env.w.tip())).toEqual(["T1"]);
    env.assertInvariants();
  });

  it("abort fired while the lane read the branches: the cancellable lock wait ends at once and no entry is opened", async () => {
    const env = await setup({ tasks: 1 });
    const real = env.igit.mergeBase.bind(env.igit);
    const box: { aborting: Promise<void> | null } = { aborting: null };
    env.igit.mergeBase = async () => {
      if (box.aborting === null) box.aborting = env.queue.abort();
      return real();
    };
    let sawAborted: boolean | null = null;
    env.locks.beforeAcquire = (_onWait, signal) => {
      if (sawAborted === null) sawAborted = signal?.aborted ?? false;
      if (signal?.aborted === true) throw new ExecutorError("E_DISPOSED", "repo lock wait aborted", null);
    };
    env.queue.enqueue(["T1"]);
    await env.until(() => box.aborting !== null, "the abort");
    await box.aborting;
    expect(sawAborted).toBe(true);
    expect(await env.steps()).toEqual([]);
    expect(env.state("T1")).toBe("verified");
    expect(env.logger.warnings.filter(w => w.includes("lane error"))).toEqual([]);
    expect(env.ledger.status).toBe("running");
  });

  it("a suite that closes during an infrastructure pause leaves the retry poll armed for the queued task", async () => {
    const env = await setup({ tasks: 2, batchMax: 1, mutate: l => {
      l.phases.push({ id: "p2", title: "Phase 2", wave: "w1", dependsOn: [], gate: "pending", qaRound: 1, paused: false, tag: null });
      l.waves[0]?.phases.push("p2");
      const t = l.tasks.T2;
      if (t !== undefined) t.phase = "p2";
    } });
    env.suite.resolution = RUNS;
    let releaseSuite!: () => void;
    env.suite.runGate = new Promise<void>(resolve => { releaseSuite = resolve; });
    env.queue.enqueue(["T1"]);
    await env.until(() => env.suite.runs.length === 1, "the held p1 suite");
    env.locks.beforeAcquire = () => { throw new Error("EIO: lock dir"); };
    env.queue.enqueue(["T2"]);
    await env.until(() => env.ledger.status === "paused", "the lock pause");
    env.suite.runGate = null;
    releaseSuite();
    await env.until(() => env.phase("p1").gate === "awaiting-qa" && env.writer.inflight === 0, "the p1 suite closes during the pause");
    env.locks.beforeAcquire = null;
    await env.writer.append([unpauseEv]);
    env.clock.fire(); // the poll armed by the pause must still be there
    await env.until(() => env.state("T2") === "integrated" && env.quiet(), "T2");
    env.assertInvariants();
  });

  it("checkPhase on a queue stopped by a rejected append does nothing and arms no poll", async () => {
    const env = await setup({ tasks: 1 });
    const target = env.writer.attempts + 1;
    env.writer.rejectOn = n => n === target ? new Error("disk full") : null;
    env.queue.enqueue(["T1"]);
    await env.until(() => env.logger.warnings.some(w => w.includes("disk full")), "the stop");
    env.writer.rejectOn = null;
    const seq = env.ledger.seq;
    await env.queue.checkPhase("p1");
    env.clock.fire();
    await env.settle();
    expect(env.ledger.seq).toBe(seq);
    expect(env.state("T1")).toBe("verified");
  });

  it("check components are journaled in the detail, and the tests component's scope labels the counter", async () => {
    const env = await setup({ tasks: 1 });
    env.w.checkScript.push({ verdict: "pass", flakyIds: ["test:f"], note: null, durationMs: 5, components: [
      { name: "typecheck", label: "tsc", exitCode: 0, timedOut: false, durationMs: 2, scope: "full", flakyIds: [] },
      { name: "tests", label: "vitest", exitCode: 0, timedOut: false, durationMs: 3, scope: "spec", flakyIds: ["test:f"] },
    ] });
    env.queue.enqueue(["T1"]);
    await env.until(() => env.state("T1") === "integrated" && env.quiet(), "T1");
    const end = (await env.events()).filter(isStep).find(e => e.step === "checks" && e.edge === "end");
    const detail = JSON.parse(end?.detail ?? "{}") as { components: Array<{ name: string; scope: string; flakyIds: string[] }>; flakyIds: string[] };
    expect(detail.components.map(c => `${c.name}:${c.scope}`)).toEqual(["typecheck:full", "tests:spec"]);
    expect(detail.flakyIds).toEqual(["test:f"]);
    const counter = env.w.journal.find(e => e.type === "metric" && JSON.stringify(e.metric).includes("\"integration.checks\""));
    expect(JSON.stringify(counter)).toContain("\"scope\":\"spec\"");
    env.assertInvariants();
  });
});

describe("fast-forward: read errors, abort windows, lock re-check (round 2)", () => {
  it("an integration branch that cannot be read before the fast-forward is an infrastructure pause; the poll redoes the entry", async () => {
    const env = await setup({ tasks: 1 });
    const real = env.igit.readRef.bind(env.igit);
    let failTip = true;
    env.igit.readRef = async (cwd, ref) => {
      if (failTip && ref === INT_REF) throw new Error("fatal: index.lock exists");
      return real(cwd, ref);
    };
    env.queue.enqueue(["T1"]);
    await env.until(() => env.ledger.status === "paused", "the pause");
    expect((await env.steps("task")).slice(-1)).toEqual(["task:fast-forward:end/refused"]);
    const end = (await env.events()).filter(isStep).filter(e => e.step === "fast-forward" && e.edge === "end").pop();
    expect(JSON.parse(end?.detail ?? "{}")).toMatchObject({ reason: "git" });
    expect(env.ledger.inbox[0]?.text).toContain("could not be read before the fast-forward");
    expect(env.w.writes.some(x => x.op === "mergeFfOnly" || x.op === "branchForce")).toBe(false);
    failTip = false;
    await env.writer.append([unpauseEv]);
    env.clock.fire();
    await env.until(() => env.state("T1") === "integrated" && env.quiet(), "the redone entry");
    expect(await env.steps("task")).toContain("task:rollback:end/rolled-back");
    env.assertInvariants();
  });

  it("abort while the integration worktree is being prepared: no merge, no CAS; the entry is rolled back (QA-3.2-36)", async () => {
    const env = await setup({ tasks: 1 });
    const real = env.git.revParse.bind(env.git);
    const box: { aborting: Promise<void> | null } = { aborting: null };
    env.git.revParse = async (cwd, rev) => {
      if (cwd === WT && box.aborting === null) box.aborting = env.queue.abort();
      return real(cwd, rev);
    };
    env.queue.enqueue(["T1"]);
    await env.until(() => box.aborting !== null, "the abort");
    await box.aborting;
    expect(env.w.writes.some(x => x.op === "mergeFfOnly" || x.op === "branchForce")).toBe(false);
    expect(env.w.tip()).toBe(env.w.base);
    expect(env.state("T1")).toBe("cancelled");
    expect((await env.steps("task")).slice(-3)).toEqual(["task:fast-forward:end/rolled-back", "task:rollback:start", "task:rollback:end/rolled-back"]);
    env.assertInvariants();
  });

  it("abort during the merge: the CAS never runs and the branch stays at the head (QA-3.2-36)", async () => {
    const env = await setup({ tasks: 1 });
    const real = env.git.mergeFfOnly.bind(env.git);
    const box: { aborting: Promise<void> | null } = { aborting: null };
    env.git.mergeFfOnly = async (cwd, commit) => {
      box.aborting = env.queue.abort();
      return real(cwd, commit);
    };
    env.queue.enqueue(["T1"]);
    await env.until(() => box.aborting !== null, "the abort");
    await box.aborting;
    expect(env.w.writes.some(x => x.op === "branchForce")).toBe(false);
    expect(env.w.tip()).toBe(env.w.base);
    expect(env.state("T1")).toBe("cancelled");
    expect(env.writer.openIntegration()).toEqual([]);
    env.assertInvariants();
  });

  it("a lock whose file re-read before the CAS is no longer ours halts, even if its release then fails (QA-3.2-28)", async () => {
    const env = await setup({ tasks: 1 });
    const lost = new AbortController();
    let verified = 0;
    let releases = 0;
    env.locks.acquire = async () => ({
      lost: lost.signal,
      release: async () => { releases++; throw new Error("unlink EPERM"); },
      verify: async () => { verified++; return false; },
    });
    env.queue.enqueue(["T1"]);
    await env.until(() => env.ledger.status === "paused", "the lock-lost halt");
    expect(verified).toBe(1);
    expect(releases).toBeGreaterThanOrEqual(1);
    expect(env.ledger.inbox[0]?.text).toContain("was lost");
    expect(env.w.writes.some(x => x.op === "branchForce")).toBe(false);
    expect(env.w.writes.some(x => x.op === "mergeFfOnly")).toBe(true);
    expect(env.w.tip()).toBe(env.w.base);
    expect((await env.steps("task")).slice(-1)).toEqual(["task:fast-forward:end/refused"]);
    env.assertInvariants();
  });
});

describe("suite states that cannot run, abort at suite close, revert lock errors (round 2)", () => {
  const gateAt = (gate: "suite-running" | "suite-failed") => (l: LedgerV1): void => {
    const p = l.phases[0];
    if (p !== undefined) p.gate = gate;
  };
  const cases: Array<{ gate: "suite-running" | "suite-failed"; res: SuiteResolution; remedy: string }> = [
    { gate: "suite-running", res: { kind: "off" }, remedy: "approved phaseSuite setting is \"off\"" },
    { gate: "suite-running", res: { kind: "none" }, remedy: "Restore the phase's tests" },
    { gate: "suite-failed", res: { kind: "none" }, remedy: "Restore the phase's tests" },
  ];
  for (const c of cases) {
    it(`a ${c.gate} gate whose suite now resolves to ${c.res.kind} pauses the phase with a remedy; the gate is not moved (QA-3.2-2)`, async () => {
      const env = await setup({ tasks: 0, resume: false, mutate: gateAt(c.gate) });
      env.suite.resolution = c.res;
      await env.queue.resume();
      await env.until(() => env.phase().paused && env.quiet(), "the phase pause");
      expect(env.phase().gate).toBe(c.gate);
      expect(env.ledger.inbox).toHaveLength(1);
      expect(env.ledger.inbox[0]).toMatchObject({ kind: "failure", severity: "critical" });
      expect(env.ledger.inbox[0]?.text).toContain(`resolves to "${c.res.kind}"`);
      expect(env.ledger.inbox[0]?.text).toContain(c.remedy);
      expect(env.suite.runs).toEqual([]);
      expect(await env.steps()).toEqual([]);
      env.assertInvariants();
    });
  }

  for (const reason of ["base-overlap", "base-unparsed"] as const) {
    it(`an unattributed failure (${reason}) pauses the phase and says why`, async () => {
      const env = await suiteEnv(1, () => ({ kind: "unattributed", ids: ["test:x"], reason }));
      await env.until(() => env.phase().paused && env.quiet(), "the phase pause");
      expect(env.ledger.inbox[0]?.text).toContain(`(${reason})`);
      expect(env.suite.reverts).toEqual([]);
      const end = (await env.events()).filter(isStep).find(e => e.entry.kind === "phase-suite" && e.edge === "end");
      expect(JSON.parse(end?.detail ?? "{}")).not.toHaveProperty("outside");
      env.assertInvariants();
    });
  }

  it("abort fired while the suite returned a verdict: no gate move, no inbox; abort closes the entry (QA-3.2-36)", async () => {
    const env = await setup({ tasks: 1, batchMax: 1 });
    env.suite.resolution = RUNS;
    const box: { aborting: Promise<void> | null } = { aborting: null };
    env.suite.run = async () => {
      box.aborting = env.queue.abort();
      return { kind: "passed" };
    };
    env.queue.enqueue(["T1"]);
    await env.until(() => box.aborting !== null, "the abort");
    await box.aborting;
    expect(env.phase().gate).toBe("suite-running");
    expect(env.ledger.inbox).toEqual([]);
    expect(env.writer.openIntegration()).toEqual([]);
    expect((await env.steps("phase-suite")).slice(-3)).toEqual([
      "phase-suite:phase-suite:end/rolled-back", "phase-suite:rollback:start", "phase-suite:rollback:end/rolled-back",
    ]);
    expect(env.listener.calls).not.toContain("gate:p1:awaiting-qa");
    env.assertInvariants();
  });

  it("a revert whose repo lock cannot be taken stays pending behind the pause and runs once the plan runs again", async () => {
    const env = await setup({ tasks: 2, batchMax: 1 });
    env.suite.resolution = RUNS;
    const blame = culpritOf("T1");
    env.suite.onRun = req => {
      env.locks.beforeAcquire = () => { throw new Error("EIO: lock dir"); };
      return blame(req);
    };
    env.queue.enqueue(["T1", "T2"]);
    await env.until(() => env.ledger.status === "paused", "the lock pause");
    expect(env.phase().gate).toBe("suite-failed");
    expect(env.ledger.inbox.at(-1)?.text).toContain("could not be taken (EIO: lock dir)");
    expect(env.suite.reverts).toEqual([]);
    expect(await env.steps("revert")).toEqual([]);
    env.locks.beforeAcquire = null;
    env.suite.onRun = () => ({ kind: "passed" });
    await env.writer.append([unpauseEv]);
    env.clock.fire();
    await env.until(() => env.state("T1") === "reverted" && env.phase().gate === "pending" && env.quiet(), "the revert");
    expect(env.suite.reverts).toHaveLength(1);
    env.assertInvariants();
  });
});

describe("tag entry of a completed plan: bounded retries (QA-3.2-30) and lock errors", () => {
  const completedPassed = (l: LedgerV1): void => {
    l.status = "completed";
    const p = l.phases[0];
    if (p !== undefined) p.gate = "passed";
  };
  const tagName = `omr/${PLAN_ID}/phase/p1`;

  it("keeps failing: each round of 3 tries is rolled back and retried later; after the last round a blocking item gives the command", async () => {
    const env = await setup({ tasks: 0, resume: false, mutate: completedPassed });
    let tries = 0;
    env.lander.tag = async () => { tries++; throw new Error("ref lock busy"); };
    await env.queue.resume();
    for (let round = 1; round <= 4; round++) {
      await env.until(() => tries === 3 * round && env.writer.openIntegration().length === 0, `round ${round}`);
      if (round < 4) env.clock.fire(); // the retry timer
    }
    await env.until(() => env.ledger.inbox.length === 1 && env.quiet(), "the give-up item");
    expect(env.ledger.inbox[0]).toMatchObject({ kind: "failure", severity: "blocking" });
    expect(env.ledger.inbox[0]?.text).toContain("could not be created after 4 rounds of 3 tries (ref lock busy)");
    expect(env.ledger.inbox[0]?.text).toContain(`git -C "${TOPLEVEL}" tag ${tagName}`);
    expect(env.ledger.status).toBe("completed");
    expect(env.phase().tag).toBeNull();
    const rollbacks = (await env.events()).filter(isStep).filter(e => e.step === "rollback" && e.edge === "start");
    expect(rollbacks).toHaveLength(4);
    expect(rollbacks.every(e => (JSON.parse(e.detail ?? "{}") as { reason?: string }).reason === "stalled")).toBe(true);
    env.clock.fire();
    await env.settle();
    expect(tries).toBe(12);
    expect(env.listener.inbox).toHaveLength(1);
  });

  it("a retry round that succeeds tags the phase", async () => {
    const env = await setup({ tasks: 0, resume: false, mutate: completedPassed });
    env.lander.tagOutcome = { kind: "error", message: "ref lock busy" };
    await env.queue.resume();
    await env.until(() => env.writer.openIntegration().length === 0 && env.w.writes.filter(x => x.op === "tag").length === 3, "round 1");
    env.lander.tagOutcome = null;
    env.clock.fire();
    await env.until(() => env.phase().tag === tagName && env.quiet(), "the tag");
    expect(env.ledger.inbox).toEqual([]);
    env.assertInvariants();
  });

  it("dispose cancels a pending tag retry", async () => {
    const env = await setup({ tasks: 0, resume: false, mutate: completedPassed });
    env.lander.tagOutcome = { kind: "error", message: "ref lock busy" };
    await env.queue.resume();
    await env.until(() => env.writer.openIntegration().length === 0 && env.w.writes.filter(x => x.op === "tag").length === 3, "round 1");
    await env.queue.dispose();
    const seq = env.ledger.seq;
    env.clock.fire();
    await env.settle();
    expect(env.w.writes.filter(x => x.op === "tag")).toHaveLength(3);
    expect(env.ledger.seq).toBe(seq);
  });

  it("a running plan's tag whose repo lock cannot be taken stays due and is tagged once the plan runs again", async () => {
    const env = await setup({ tasks: 0, resume: false, mutate: l => { const p = l.phases[0]; if (p !== undefined) p.gate = "passed"; } });
    let acquires = 0;
    env.locks.beforeAcquire = () => {
      acquires++;
      if (acquires === 2) throw new Error("EBUSY: lock dir"); // 1 = resume, 2 = the tag entry
    };
    await env.queue.resume();
    await env.until(() => env.ledger.status === "paused", "the lock pause");
    expect(env.ledger.inbox[0]?.text).toContain("could not be taken (EBUSY: lock dir)");
    expect(await env.steps("tag")).toEqual([]);
    await env.writer.append([unpauseEv]);
    env.clock.fire();
    await env.until(() => env.phase().tag === tagName && env.quiet(), "the tag");
    expect(await env.steps("tag")).toEqual(["tag:tag:start", "tag:tag:end/ok"]);
    env.assertInvariants();
  });
});

describe("land and resume: round-2 rows (QA-3.2-9, -21, -33, -35)", () => {
  const advanced = (l: LedgerV1, w: World): void => {
    l.status = "completed";
    l.config.land = "ff-when-clean";
    const c = w.commit(w.base, "X");
    w.passed.add(c.sha);
    w.branches.set(INT_REF, c.sha);
    w.iwtHead = c.sha;
    l.integration.head = c.sha;
  };

  it("a base branch the owner committed on top of a landed head counts as landed (no new entry)", async () => {
    const env = await setup({ tasks: 0, mutate: advanced });
    expect(await env.queue.land()).toEqual({ landed: true, inbox: null });
    const ownerCommit = env.w.commit(env.ledger.integration.head, null);
    env.w.branches.set(MAIN_REF, ownerCommit.sha);
    const seq = env.ledger.seq;
    expect(await env.queue.land()).toEqual({ landed: true, inbox: null });
    expect(env.ledger.seq).toBe(seq);
    expect(env.lander.landCalls).toHaveLength(1);
  });

  it("a base branch whose ancestry cannot be checked is not taken for landed: land runs again", async () => {
    const env = await setup({ tasks: 0, mutate: advanced });
    await env.queue.land();
    env.w.branches.set(MAIN_REF, env.w.commit(env.ledger.integration.head, null).sha);
    env.igit.isAncestor = async () => { throw new Error("git: bad object"); };
    await env.queue.land();
    expect(env.lander.landCalls).toHaveLength(2);
    expect(await env.steps("land")).toHaveLength(4);
  });

  it("an integration branch that cannot be read at land is a blocking item; nothing is landed and land() can be retried", async () => {
    const env = await setup({ tasks: 0, mutate: advanced });
    const real = env.igit.readRef.bind(env.igit);
    env.igit.readRef = async (cwd, ref) => {
      if (ref === INT_REF) throw new Error("fatal: unable to read refs");
      return real(cwd, ref);
    };
    const r = await env.queue.land();
    expect(r.landed).toBe(false);
    expect(r.inbox).toMatchObject({ kind: "landing", severity: "blocking" });
    expect(r.inbox?.text).toContain("Nothing was landed; retry land() once git runs again");
    expect(env.lander.inspectCalls).toEqual([]);
    expect(await env.steps("land")).toEqual(["land:land:start", "land:land:end/refused"]);
    env.igit.readRef = real;
    expect((await env.queue.land()).landed).toBe(true);
    env.assertInvariants();
  });

  it("a land entry crashed after its start, with the owner already on top of the candidate, is completed by resume", async () => {
    const env = await setup({ tasks: 0, mutate: advanced });
    env.writer.crashAfter = env.writer.appends + 1;
    await expect(env.queue.land()).rejects.toThrow("crash after append");
    env.w.branches.set(MAIN_REF, env.w.commit(env.ledger.integration.head, null).sha);
    env.w.landed = true;
    await env.restart();
    const report = await env.queue.resume();
    expect(report.entries).toEqual([expect.objectContaining({ kind: "land", action: "completed" })]);
    const end = (await env.events()).filter(isStep).filter(e => e.entry.kind === "land" && e.edge === "end").pop();
    expect(JSON.parse(end?.detail ?? "{}")).toEqual({ v: 1, from: env.ledger.integration.head, to: env.ledger.integration.head });
    expect(env.lander.landCalls).toEqual([]);
    env.assertInvariants();
  });

  it("resume of a running plan whose repo lock cannot be taken halts with an item and can be resumed later", async () => {
    const env = await setup({ tasks: 1, resume: false });
    env.locks.beforeAcquire = () => { throw new Error("EROFS: state dir"); };
    const report = await env.queue.resume();
    expect(report.halted).toBe(true);
    expect(env.ledger.status).toBe("paused");
    expect(env.ledger.inbox[0]?.text).toContain("could not be taken (EROFS: state dir)");
    env.locks.beforeAcquire = null;
    const again = await env.queue.resume();
    expect(again.halted).toBe(false);
    await env.writer.append([unpauseEv]);
    env.queue.enqueue(["T1"]);
    await env.until(() => env.state("T1") === "integrated" && env.quiet(), "T1");
    env.assertInvariants();
  });

  it("a batch entry crashed after part of it integrated: its slot now belongs to no task of the entry and is not touched (QA-3.2-21)", async () => {
    const env = await setup({ tasks: 3, batchMax: 4 });
    env.w.conflictOnMate.add("T2"); // T2 is deferred; T1 and T3 integrate first, in slot-3
    env.writer.crashAfter = env.writer.appends + 6; // open, rebase end, checks start, checks end, ff start, row 30 for T1+T3
    env.queue.enqueue(["T1", "T2", "T3"]);
    await env.until(() => env.w.dead, "the crash after the first row 30");
    expect(env.state("T1")).toBe("integrated");
    expect(env.state("T3")).toBe("integrated");
    expect(env.state("T2")).toBe("integrating");
    await env.restart();
    const resets = env.pool.resets.length;
    const report = await env.queue.resume();
    expect(report.entries).toEqual([expect.objectContaining({ kind: "batch", action: "rolled-back" })]);
    expect(report.rolledBack).toEqual(["T2"]);
    expect(await lastRollbackEnd(env)).toEqual({ v: 1, reset: null });
    expect(env.pool.resets.slice(resets).filter(r => r.slot === "slot-3")).toEqual([]);
    env.requeueVerified();
    await env.until(() => env.state("T2") === "integrated" && env.quiet(), "T2");
    expect(env.w.integratedCount()).toEqual({ T1: 1, T2: 1, T3: 1 });
    env.assertInvariants();
  });
});

describe("resume and abort: infrastructure and lost-lock halts (QA-3.2-9, QA-3.2-28)", () => {
  /** Fires the `lost` signal of the newest repo lock at the next slot-record read (the rollback's lease, right before its write). */
  function loseLockAtNextSlotRead(env: Env): void {
    const real = env.pool.get.bind(env.pool);
    let fired = false;
    env.pool.get = async slot => {
      if (!fired) {
        fired = true;
        env.locks.lostCtls[env.locks.lostCtls.length - 1]?.abort();
      }
      return real(slot);
    };
  }

  it("resume halts as infrastructure when the integration branch cannot be read 3 times; a later resume proceeds", async () => {
    const env = await setup({ tasks: 1, resume: false });
    const real = env.igit.readRef.bind(env.igit);
    let reads = 0;
    env.igit.readRef = async (cwd, ref) => {
      if (ref === INT_REF) { reads++; throw new Error("fatal: not a git repository"); }
      return real(cwd, ref);
    };
    const report = await env.queue.resume();
    expect(report.halted).toBe(true);
    expect(reads).toBe(3);
    expect(env.ledger.status).toBe("paused");
    expect(env.ledger.inbox[0]?.text).toContain("could not read refs/heads/");
    expect(env.ledger.inbox[0]?.text).toContain("the branch was not judged");
    expect(await env.steps()).toEqual([]);
    env.igit.readRef = real;
    expect((await env.queue.resume()).halted).toBe(false);
  });

  it("a repo lock lost during a resume rollback halts resume: the entry stays open for the next writer", async () => {
    const env = await setup({ tasks: 1 });
    env.w.checkScript.push(errorResult("spawn"), errorResult("spawn"), errorResult("spawn"));
    env.queue.enqueue(["T1"]);
    await env.until(() => env.ledger.status === "paused", "M13a pause");
    await env.restart();
    loseLockAtNextSlotRead(env);
    const report = await env.queue.resume();
    expect(report.halted).toBe(true);
    expect(report.entries).toEqual([expect.objectContaining({ kind: "task", action: "none" })]);
    expect(env.ledger.inbox.at(-1)?.text).toContain("was lost");
    expect(env.ledger.inbox.at(-1)?.text).toContain("(none)");
    expect(env.writer.openIntegration().map(o => `${o.step}:${o.edge}`)).toEqual(["rollback:start"]);
    expect(env.w.writes.some(x => x.op === "rebaseAbort")).toBe(false);
    expect(env.state("T1")).toBe("integrating");
    expect(env.locks.held).toBe(false);
  });

  it("a repo lock lost during abort's rollbacks stops abort: it rejects and the remaining entries stay open", async () => {
    const env = await orphanEnv(2, 4);
    loseLockAtNextSlotRead(env);
    await expect(env.queue.abort()).rejects.toThrow("repo lock lost during abort");
    expect(env.writer.openIntegration()).toHaveLength(2);
    expect(env.writer.openIntegration().every(o => o.step === "rollback" && o.edge === "start")).toBe(true);
    expect(env.state("T1")).toBe("integrating");
    expect(env.state("T2")).toBe("integrating");
    expect(env.logger.warnings.some(w => w.includes("failed: integration-lock-lost") || w.includes("rollback of"))).toBe(true);
    expect(env.ledger.inbox.at(-1)?.text).toContain("was lost");
    expect(env.locks.held).toBe(false);
  });

  it("dispose during abort's wait for the lanes: abort stops without rolling anything back", async () => {
    const env = await setup({ tasks: 1 });
    env.w.checkGate = new Promise<void>(() => undefined);
    env.queue.enqueue(["T1"]);
    await env.until(() => env.w.checkLog.length === 1, "the check in flight");
    const aborting = env.queue.abort();
    await env.queue.dispose();
    await aborting;
    expect(env.writer.openIntegration()).toHaveLength(1);
    expect(env.state("T1")).toBe("integrating");
    expect((await env.steps("task")).some(s => s.includes("rollback"))).toBe(false);
  });
});

describe("re-integration of a reverted task: the rebase upstream (QA-3.2-10, QA-3.2-25)", () => {
  /** The owner's retry: reverted -> ready -> dispatched -> running -> completed -> verifying -> verified, branch at `tip`. */
  async function reverify(env: Env, id: string, slot: string, tip: string): Promise<void> {
    const branch = `omr/${PLAN_ID}/t/${id}`;
    env.w.branches.set(`refs/heads/${branch}`, tip);
    env.w.slotCommit.set(slot, tip);
    const n = (env.ledger.tasks[id]?.attempts.length ?? 0) + 1;
    const at = env.clock.iso() as IsoTime;
    await env.writer.append([{ type: "task-transition", taskId: id, from: "reverted", to: "ready", trigger: "retry", detail: null }]);
    await env.writer.append([
      { type: "attempt-started", taskId: id, attempt: { ...openAttempt(n), startedAt: at } },
      { type: "task-transition", taskId: id, from: "ready", to: "dispatched", trigger: "launch", detail: null },
      { type: "task-slot", taskId: id, slot, branch },
    ]);
    await env.writer.append([
      { type: "attempt-child", taskId: id, n, childSessionID: `ses-${id}-${n}` },
      { type: "task-transition", taskId: id, from: "dispatched", to: "running", trigger: "child-created", detail: null },
    ]);
    await env.writer.append([
      { type: "attempt-ended", taskId: id, n, outcome: "succeeded", endedAt: at, detail: null },
      { type: "task-transition", taskId: id, from: "running", to: "completed", trigger: "child-ended", detail: null },
    ]);
    await env.writer.append([{ type: "task-transition", taskId: id, from: "completed", to: "verifying", trigger: "committed", detail: null }]);
    await env.writer.append([
      { type: "attempt-verdict", taskId: id, n, verdict: "pass", ref: null },
      { type: "task-transition", taskId: id, from: "verifying", to: "verified", trigger: "verify-pass", detail: null },
    ]);
  }

  interface Shape { base: string; X: string; R: string; root: string }
  const variants: Array<{ name: string; tip: (w: World, s: Shape) => string; mergeBase: (s: Shape) => string; expected: (s: Shape) => string }> = [
    { name: "a retry rebuilt on the head (it contains the revert) keeps the merge base",
      tip: (w, s) => w.commit(s.R, "T1").sha, mergeBase: s => s.R, expected: s => s.R },
    { name: "a retry on the old branch (original change below the merge base) rebases from the first journaled upstream",
      tip: (w, s) => w.commit(s.X, "T1").sha, mergeBase: s => s.X, expected: s => s.base },
    { name: "a retry whose first upstream is not its ancestor rebases from the `from` of the revert below the merge base",
      tip: (w, s) => w.commit(s.root, "T1").sha, mergeBase: s => s.X, expected: s => s.base },
    { name: "a retry with no revert below the merge base keeps the merge base",
      tip: (w, s) => w.commit(s.root, "T1").sha, mergeBase: s => s.root, expected: s => s.root },
  ];
  for (const v of variants) {
    it(v.name, async () => {
      const env = await setup({ tasks: 1, batchMax: 1 });
      env.suite.resolution = RUNS;
      let blame = true;
      env.suite.onRun = req => blame ? culpritOf("T1")(req) : { kind: "passed" };
      env.queue.enqueue(["T1"]);
      await env.until(() => env.state("T1") === "reverted" && env.phase().gate === "pending" && env.quiet(), "the first revert");
      blame = false;
      const R = env.w.tip();
      const X = env.w.chain(R).find(c => c.adds === "T1")?.sha ?? "";
      expect(X).not.toBe("");
      const shape: Shape = { base: env.w.base, X, R, root: env.w.commit(null, null).sha };
      const tip = v.tip(env.w, shape);
      const mb = v.mergeBase(shape);
      env.igit.mergeBase = async () => mb;
      await reverify(env, "T1", "slot-1", tip);
      env.queue.enqueue(["T1"]);
      await env.until(() => env.state("T1") === "integrated" && env.phase().gate === "awaiting-qa" && env.quiet(), "the re-integration");
      const rebase = (await env.events()).filter(isStep).filter(e => e.step === "rebase" && e.edge === "start").pop();
      const detail = JSON.parse(rebase?.detail ?? "{}") as { tasks?: Array<{ taskId: string; tip: string; upstream: string }> };
      expect(detail.tasks).toEqual([{ taskId: "T1", tip, upstream: v.expected(shape) }]);
      expect(env.w.tasksAt(env.w.tip())).toContain("T1");
      env.assertInvariants();
    });
  }

  it("a revert-ancestry read that fails is an infrastructure read error: retried, then the plan pauses with the task queued", async () => {
    const env = await setup({ tasks: 1, batchMax: 1 });
    env.suite.resolution = RUNS;
    let blame = true;
    env.suite.onRun = req => blame ? culpritOf("T1")(req) : { kind: "passed" };
    env.queue.enqueue(["T1"]);
    await env.until(() => env.state("T1") === "reverted" && env.phase().gate === "pending" && env.quiet(), "the first revert");
    blame = false;
    const tip = env.w.commit(env.w.tip(), "T1").sha;
    await reverify(env, "T1", "slot-1", tip);
    const real = env.igit.isAncestor.bind(env.igit);
    env.igit.isAncestor = async () => { throw new Error("git: bad object"); };
    env.queue.enqueue(["T1"]);
    await env.until(() => env.ledger.status === "paused", "the infrastructure pause");
    expect(env.ledger.inbox.at(-1)?.text).toContain("git could not read ancestry of");
    expect(env.queue.queued()).toEqual(["T1"]);
    env.igit.isAncestor = real;
    await env.writer.append([unpauseEv]);
    env.clock.fire();
    await env.until(() => env.state("T1") === "integrated" && env.quiet(), "the re-integration");
    env.assertInvariants();
  });
});

describe("checkPhase guards on open entries (QA-3.2-15)", () => {
  it("a completed plan's passed phase is tagged once, however often checkPhase runs before and during the tag entry", async () => {
    const env = await setup({ tasks: 0, resume: false, mutate: l => {
      l.status = "completed";
      const p = l.phases[0];
      if (p !== undefined) p.gate = "passed";
    } });
    let open!: () => void;
    const gate = new Promise<void>(resolve => { open = resolve; });
    const real = env.lander.tag.bind(env.lander);
    env.lander.tag = async req => { await gate; return real(req); };
    await env.queue.checkPhase("p1"); // before resume: queued, not run
    await env.queue.checkPhase("p1"); // already queued
    await env.queue.resume();
    await env.until(() => env.writer.openIntegration().some(o => o.entry.kind === "tag"), "the tag entry");
    await env.queue.checkPhase("p1"); // the tag entry is open
    open();
    await env.until(() => env.phase().tag !== null && env.quiet(), "the tag");
    await env.queue.checkPhase("p1"); // tagged: nothing
    await env.settle();
    expect(await env.steps("tag")).toEqual(["tag:tag:start", "tag:tag:end/ok"]);
    expect(env.ledger.status).toBe("completed");
    env.assertInvariants();
  });

  it("a suite-running phase with its suite entry open is not queued again", async () => {
    const env = await setup({ tasks: 1, batchMax: 1 });
    env.suite.resolution = RUNS;
    let release!: () => void;
    env.suite.runGate = new Promise<void>(resolve => { release = resolve; });
    env.queue.enqueue(["T1"]);
    await env.until(() => env.suite.runs.length === 1 && env.phase().gate === "suite-running", "the held suite");
    await env.queue.checkPhase("p1");
    await env.queue.checkPhase("p1");
    env.suite.runGate = null;
    release();
    await env.until(() => env.phase().gate === "awaiting-qa" && env.quiet(), "the suite");
    await env.settle();
    expect(env.suite.runs).toHaveLength(1);
    env.assertInvariants();
  });
});

describe("history read failure", () => {
  it("a failed first history read is not cached: the call that needed it rejects, the next call reads again", async () => {
    const env = await setup({ tasks: 0, resume: false });
    let reads = 0;
    const q = createIntegrationQueue({
      planId: PLAN_ID, writer: env.writer, git: env.git, igit: env.igit, pool: env.pool, leases: env.leases, checks: env.checks,
      suite: env.suite, lander: env.lander, listener: env.listener, locks: env.locks, guard: env.guard, clock: env.clock, logger: env.logger,
      settle: (_id, release) => { void release(); },
      releaseSlot: (_id, slot) => env.pool.release(slot),
      history: { steps: async () => {
        reads++;
        if (reads === 1) throw new Error("journal unreadable");
        return (await env.store.exportPlan(PLAN_ID)).events.filter(isStep);
      } },
    });
    try {
      const stray = env.w.commit(null, null);
      env.w.passed.add(stray.sha);
      env.w.branches.set(INT_REF, stray.sha); // resume must journal a halt, which needs the history
      const seq = env.ledger.seq;
      await expect(q.resume()).rejects.toThrow("journal unreadable");
      expect(env.ledger.seq).toBe(seq);
      expect(env.locks.held).toBe(false);
      const report = await q.resume();
      expect(report.halted).toBe(true);
      expect(reads).toBe(2);
      expect(env.ledger.inbox).toHaveLength(1);
    } finally {
      await q.dispose();
    }
  });
});

describe("revert of a task with an in-flight qa dependent (QA4 G2)", () => {
  it("the qa task is blocked, its attempt ended and its phase gate goes qa-running -> awaiting-qa in the row-34 batch", async () => {
    const env = await setup({ tasks: 1, batchMax: 1, mutate: l => {
      l.phases.push({ id: "p2", title: "Phase 2", wave: "w1", dependsOn: [], gate: "qa-running", qaRound: 1, paused: false, tag: null });
      l.waves[0]?.phases.push("p2");
      l.tasks.Q = taskNode("Q", { kind: "qa", phase: "p2", state: "running", slot: "slot-q", branch: null,
        attempts: [{ ...openAttempt(1), childSessionID: "ses-qa" }] });
      l.edges.push({ from: "T1", to: "Q", kind: "structural", confidence: "high", evidence: "order" });
    } });
    env.suite.resolution = RUNS;
    env.suite.onRun = culpritOf("T1");
    env.queue.enqueue(["T1"]);
    await env.until(() => env.state("T1") === "reverted" && env.phase("p1").gate === "pending" && env.quiet(), "the revert");
    expect(env.state("Q")).toBe("blocked");
    expect(env.ledger.tasks.Q?.slot).toBeNull();
    expect(env.ledger.tasks.Q?.attempts.map(a => a.outcome)).toEqual(["interrupted"]);
    expect(env.phase("p2").gate).toBe("awaiting-qa");
    const g = (await env.events()).find(e => e.type === "gate-changed" && e.phaseId === "p2");
    expect(g).toMatchObject({ from: "qa-running", to: "awaiting-qa", trigger: "qa-requeued" });
    expect(env.settled).toEqual(["Q"]);
    env.assertInvariants();
  });
});

describe("the phase suite runs in the ci slot with the resolved commands", () => {
  it("a routing.run.commands entry named test-files (resolved by the RunResolver) is what the queue hands to the ci slot", async () => {
    const env = await setup({ tasks: 1, batchMax: 1 });
    env.suite.resolution = { kind: "runs", commands: [{ label: "test-files", file: "node", args: ["--test", "t/a.test.js"], source: "run-command",
      ref: { script: "test-files", args: ["t/a.test.js"] } }] };
    env.queue.enqueue(["T1"]);
    await env.until(() => env.phase().gate === "awaiting-qa" && env.quiet());
    expect(env.suite.runs).toHaveLength(1);
    expect(env.suite.runs[0]?.slot.slot).toBe("ci");
    expect(env.suite.runs[0]?.commands.map(c => c.label)).toEqual(["test-files"]);
    expect(env.suite.runs[0]?.commit).toBe(env.w.tip());
    expect(env.suite.runs[0]?.base).toBe(env.w.base);
    expect(env.pool.released).toContain("ci");
    const start = (await env.events()).filter(isStep).find(e => e.step === "phase-suite" && e.edge === "start");
    expect(JSON.parse(start?.detail ?? "{}")).toMatchObject({ commands: [{ label: "test-files", ref: { script: "test-files", args: ["t/a.test.js"] } }] });
    expect(env.w.writes.some(x => x.cwd === slotPath("ci"))).toBe(false);
    env.assertInvariants();
    await env.queue.dispose();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The real phase-suite runner (phase-suite.ts) over a scripted command runner
// ---------------------------------------------------------------------------------------------------------------

class JournalSpy implements StepJournal {
  readonly log: string[] = [];
  readonly writes: string[] = [];
  readonly counters: Array<{ key: string; value: number }> = [];
  readonly entry: Readonly<IntegrationEntry> = { id: "i-9", kind: "phase-suite", phaseId: "p1", taskIds: [], slot: "ci", baseHead: hex(1), candidate: hex(1) };
  open: IntegrationStep | null;
  constructor(first: IntegrationStep | null, readonly signal: AbortSignal = new AbortController().signal) {
    this.open = first;
  }
  async start(step: IntegrationStep): Promise<void> {
    if (this.open !== null) throw new Error(`I4: ${step} started while ${this.open} is still open`);
    this.open = step;
    this.log.push(`start:${step}`);
  }
  async end(result: string): Promise<void> {
    if (this.open === null) throw new Error("I4: end without an open step");
    this.log.push(`end:${this.open}/${result}`);
    this.open = null;
  }
  async assertWriteCwd(cwd: string, purpose: WritePurpose): Promise<void> {
    this.writes.push(`${purpose}:${cwd}`);
  }
  counter(key: string, value: number): void {
    this.counters.push({ key, value });
  }
}

const passRes: CommandRunResult = { verdict: "pass", ids: [], files: [], idsUnparsed: false, scope: "rerun", output: "", durationMs: 1, error: null };
function failRes(ids: string[], files: string[], over: Partial<CommandRunResult> = {}): CommandRunResult {
  return { verdict: "fail", ids, files, idsUnparsed: false, scope: "rerun", output: "red", durationMs: 1, error: null, ...over };
}
function errRes(reason: "spawn" | "preempted" | "interrupted" | "prepare"): CommandRunResult {
  return { verdict: "error", ids: [], files: [], idsUnparsed: false, scope: "full", output: "", durationMs: 1, error: { reason, message: `${reason} (scripted)` } };
}

type Mode = "full" | string[];
class RunnerChecks extends ChecksDouble {
  journal: JournalSpy | null = null;
  script: (commit: string, mode: Mode, n: number) => CommandRunResult = () => passRes;
  selection: CheckSelection | Error = { typecheck: null, tests: [], extras: [] };
  readonly calls: Array<{ commit: string; mode: Mode; prepare: boolean; priority: string; slot: string }> = [];
  constructor(private readonly world: World) {
    super(world);
  }
  override async select(): Promise<CheckSelection> {
    if (this.selection instanceof Error) throw this.selection;
    return this.selection;
  }
  override async runCommands(req: CommandRunRequest): Promise<CommandRunResult> {
    if (this.journal !== null && this.journal.open === null) this.world.violations.push("I4: runCommands outside a journaled step");
    const mode: Mode = req.mode === "full" ? "full" : [...req.mode.rerun];
    this.calls.push({ commit: req.commit, mode, prepare: req.prepare, priority: req.priority, slot: req.slot.slot });
    const result = this.script(req.commit, mode, this.calls.length);
    return req.mode === "full" ? { ...result, scope: "full" } : result;
  }
}

class RevertGit extends GitDouble {
  readonly reverted: string[] = [];
  conflictAt: string | null = null;
  constructor(private readonly world: World) {
    super(world);
  }
  override async revert(slot: string, commit: string, _message: string): Promise<{ ok: true; head: string } | Conflict> {
    this.world.write("revert", slot);
    if (this.conflictAt === commit) return { ok: false, conflicts: ["src/conflicted.ts"] };
    this.reverted.push(commit);
    const c = this.world.commit(this.world.iwtHead, null, this.world.commits.get(commit)?.adds ?? null);
    this.world.iwtHead = c.sha;
    return { ok: true, head: c.sha };
  }
}

class ResolverDouble implements RunResolver {
  readonly calls: Array<{ ref: RunCommandRef; cwd: string }> = [];
  result: (ref: RunCommandRef) => Awaited<ReturnType<RunResolver["resolve"]>> = ref => ({
    ok: true, command: { label: ref.script, file: "node", args: ref.args, source: "run-command", ref },
  });
  throws: Error | null = null;
  async resolve(ref: RunCommandRef, cwd: string): Promise<Awaited<ReturnType<RunResolver["resolve"]>>> {
    this.calls.push({ ref, cwd });
    if (this.throws !== null) throw this.throws;
    return this.result(ref);
  }
}

const SUITE_CMD: ResolvedCommand = { label: "tests", file: "node", args: ["t/run.js"], source: "package-script", ref: null };

function runnerEnv() {
  const w = new World();
  const checks = new RunnerChecks(w);
  const git = new RevertGit(w);
  const resolver = new ResolverDouble();
  const background = new BackgroundRuns();
  const runner = createPhaseSuiteRunner({ checks, igit: new IntegrateGitDouble(w), git, pool: new PoolDouble(w), resolver, background,
    clock: new FakeClock(), logger: new LoggerSpy() });
  /** n sequential single-commit tasks on top of the base. */
  const chain = (n: number): { ranges: TaskRange[]; tip: string } => {
    const ranges: TaskRange[] = [];
    let prev = w.base;
    for (let i = 1; i <= n; i++) {
      const c = w.commit(prev, `T${i}`);
      ranges.push({ taskId: `T${i}`, from: prev, to: c.sha });
      prev = c.sha;
    }
    return { ranges, tip: prev };
  };
  const ci: SlotLease = { slot: "ci", path: slotPath("ci"), planId: PLAN_ID, owner: "", commit: "" };
  const request = (c: { ranges: TaskRange[]; tip: string }, base: string | null = w.base): SuiteRunRequest => ({
    planId: PLAN_ID, phaseId: "p1", commit: c.tip, base, ranges: c.ranges, commands: [SUITE_CMD], slot: ci,
  });
  return { w, checks, git, resolver, background, runner, chain, request, ci };
}

describe("phase-suite runner: run (M21-M24)", () => {
  it("a passing suite: one full background run in the ci slot, nothing else", async () => {
    const e = runnerEnv();
    const c = e.chain(3);
    const j = new JournalSpy("phase-suite");
    e.checks.journal = j;
    expect(await e.runner.run(e.request(c), j)).toEqual({ kind: "passed" });
    expect(e.checks.calls).toEqual([{ commit: c.tip, mode: "full", prepare: true, priority: "background", slot: "ci" }]);
    expect(j.log).toEqual([]);
    expect(j.open).toBe("phase-suite");
    expect(e.w.violations).toEqual([]);
  });

  for (let pos = 1; pos <= 6; pos++) {
    it(`culprit at position ${pos} of 6: found with the regression ids, probes within the bound, base and tip never re-probed`, async () => {
      const e = runnerEnv();
      const c = e.chain(6);
      const culprit = `T${pos}`;
      // Ids as readResult/observeFull produce them (`<file> > <name>`), with the file runCommands reports for them: the
      // same mapping the runner applies (fileOfSuiteId), so the regression's file is in the probe set (file-scoped bisect).
      const id = `t/${culprit}.test.ts > ${culprit} works`;
      const file = fileOfSuiteId(e.ci.path, id);
      e.checks.script = commit => e.w.tasksAt(commit).includes(culprit) ? failRes([id], [file]) : passRes;
      const j = new JournalSpy("phase-suite");
      e.checks.journal = j;
      const v = await e.runner.run(e.request(c), j);
      expect(v).toMatchObject({ kind: "culprit", range: { taskId: culprit }, ids: [id], files: [file] });
      if (v.kind !== "culprit") return;
      expect(v.range).toEqual(c.ranges[pos - 1]);
      const probes = e.checks.calls.filter(x => x.commit !== c.tip && x.commit !== e.w.base);
      expect(probes.length).toBeLessThanOrEqual(5); // maxRangeProbes(6)
      expect(e.checks.calls.filter(x => x.commit === c.tip)).toHaveLength(3); // full + 2 reruns (no green full: they failed)
      // QA-3.2-23: the base runs the FULL commands once; reruns and probes run the regression's files only.
      expect(e.checks.calls.filter(x => x.commit === e.w.base).map(x => x.mode)).toEqual(["full"]);
      expect(e.checks.calls.slice(1).filter(x => x.commit !== e.w.base)
        .every(x => Array.isArray(x.mode) && x.mode.length === 1 && x.mode[0] === file)).toBe(true);
      expect(j.log.filter(x => x === "start:bisect")).toHaveLength(probes.length + 1); // + the memo step
      expect(j.open).toBe("bisect");
      expect(j.counters).toEqual([{ key: "integration.bisect.probes", value: probes.length }]);
      expect(j.writes.every(x => x === `slot:${slotPath("ci")}`)).toBe(true);
      expect(e.w.violations).toEqual([]);
    });
  }

  it("flaky: the two reruns pass and a green full run agrees -> flaky ids, no base run, no bisect; the second rerun stays open", async () => {
    const e = runnerEnv();
    const c = e.chain(3);
    e.checks.script = (_commit, _mode, n) => n === 1 ? failRes(["test:T2"], ["t/T2.test.ts"]) : passRes;
    const j = new JournalSpy("phase-suite");
    e.checks.journal = j;
    expect(await e.runner.run(e.request(c), j)).toEqual({ kind: "flaky", ids: ["test:T2"] });
    // QA-3.2-23: full, rerun 1, rerun 2, then one green FULL run at the suite commit (in the second rerun's step).
    expect(e.checks.calls.map(x => `${x.commit === c.tip ? "tip" : x.commit}:${x.mode === "full" ? "full" : "rerun"}`))
      .toEqual(["tip:full", "tip:rerun", "tip:rerun", "tip:full"]);
    expect(j.log.some(x => x.includes("bisect"))).toBe(false);
    expect(j.open).toBe("suite-rerun");
  });

  it("an id that reproduces in only one rerun is not flaky: the suite continues to the base run", async () => {
    const e = runnerEnv();
    const c = e.chain(2);
    // call 1 = full run (fails), call 2 = first rerun (fails), call 3 = second rerun (passes): reproduced once is enough
    e.checks.script = (commit, _mode, n) => n === 3 ? passRes : e.w.tasksAt(commit).includes("T2") ? failRes(["test:T2"], ["t/T2.test.ts"]) : passRes;
    const j = new JournalSpy("phase-suite");
    e.checks.journal = j;
    const v = await e.runner.run(e.request(c), j);
    expect(v).toMatchObject({ kind: "culprit", range: { taskId: "T2" }, ids: ["test:T2"] });
    expect(e.checks.calls.length).toBeGreaterThan(3);
  });

  it("pre-existing: the same ids fail at the phase base -> not bisected", async () => {
    const e = runnerEnv();
    const c = e.chain(4);
    e.checks.script = () => failRes(["test:old"], ["t/old.test.ts"]);
    const j = new JournalSpy("phase-suite");
    e.checks.journal = j;
    expect(await e.runner.run(e.request(c), j)).toEqual({ kind: "pre-existing", ids: ["test:old"] });
    expect(e.checks.calls).toHaveLength(4); // full, 2 reruns, base
    expect(j.log.some(x => x.includes("bisect"))).toBe(false);
    expect(j.open).toBe("suite-rerun"); // the base step stays open
  });

  it("mixed: only the ids that do not fail at the base are blamed and bisected", async () => {
    const e = runnerEnv();
    const c = e.chain(4);
    // Ids as runCommands reports them (`<file> > <name>`), each mapping (fileOfSuiteId) to its own file; a rerun runs only
    // the files it names, as the real runner does: the pre-existing `old` fails wherever its file runs.
    const oldId = "t/old.test.ts > old";
    const newId = "t/new.test.ts > new";
    const fileOf = (id: string): string => fileOfSuiteId(e.ci.path, id);
    e.checks.script = (commit, mode) => {
      const ids = [oldId];
      if (e.w.tasksAt(commit).includes("T3")) ids.push(newId);
      const ran = mode === "full" ? ids : ids.filter(i => mode.includes(fileOf(i)));
      return ran.length === 0 ? passRes : failRes(ran, ran.map(fileOf));
    };
    const j = new JournalSpy("phase-suite");
    e.checks.journal = j;
    const v = await e.runner.run(e.request(c), j);
    // Probes run only the regression's own file (its file is not among the base-failing ones): a pre-existing failure
    // never makes a probe fail (QA-3.2-26 fail closed would otherwise blame the first range).
    expect(v).toEqual({ kind: "culprit", range: c.ranges[2], ids: [newId], files: [fileOf(newId)] });
    const probes = e.checks.calls.filter(x => x.commit !== c.tip && x.commit !== e.w.base);
    expect(probes.length).toBeGreaterThan(0);
    expect(probes.every(x => Array.isArray(x.mode) && x.mode.join() === fileOf(newId))).toBe(true);
  });

  it("mixed in one file: a regression whose only file also fails at the base cannot be isolated -> unattributed, nobody blamed", async () => {
    const e = runnerEnv();
    const c = e.chain(4);
    // test:old and test:new live in the same file, which already fails at the base.
    e.checks.script = commit => {
      const ids = ["test:old"];
      if (e.w.tasksAt(commit).includes("T3")) ids.push("test:new");
      return failRes(ids, ["t/shared.test.ts"]);
    };
    const j = new JournalSpy("phase-suite");
    e.checks.journal = j;
    expect(await e.runner.run(e.request(c), j)).toEqual({ kind: "unattributed", ids: ["test:new"], reason: "base-overlap" });
    expect(e.checks.calls.filter(x => x.commit !== c.tip && x.commit !== e.w.base)).toEqual([]); // no probe
    expect(j.open).toBe("bisect"); // the memo step
  });

  it("no phase base: unattributed (no-base) with the reproduced ids, nothing bisected", async () => {
    const e = runnerEnv();
    const c = e.chain(2);
    e.checks.script = () => failRes(["test:x"], ["t/x.test.ts"]);
    const j = new JournalSpy("phase-suite");
    e.checks.journal = j;
    expect(await e.runner.run(e.request(c, null), j)).toEqual({ kind: "unattributed", ids: ["test:x"], reason: "no-base" });
    expect(e.checks.calls).toHaveLength(3);
    expect(j.open).toBe("bisect"); // the memo step
  });

  it("a failure that exists only past the last range is unattributed (outside)", async () => {
    const e = runnerEnv();
    const c = e.chain(3);
    const extra = e.w.commit(c.tip, null); // a commit that belongs to no task
    e.checks.script = commit => commit === extra.sha ? failRes(["test:x"], ["t/x.test.ts"]) : passRes;
    const j = new JournalSpy("phase-suite");
    e.checks.journal = j;
    const v = await e.runner.run(e.request({ ranges: c.ranges, tip: extra.sha }), j);
    expect(v).toEqual({ kind: "unattributed", ids: ["test:x"], reason: "outside" });
  });

  it("a range whose `to` is not in the phase chain is unattributed (outside), not an error", async () => {
    const e = runnerEnv();
    const c = e.chain(2);
    e.checks.script = commit => e.w.tasksAt(commit).length > 0 ? failRes(["test:x"], ["t/x.test.ts"]) : passRes; // passes at the base
    const j = new JournalSpy("phase-suite");
    e.checks.journal = j;
    const ranges = [...c.ranges, { taskId: "T9", from: c.tip, to: hex(31337) }];
    expect(await e.runner.run(e.request({ ranges, tip: c.tip }), j)).toEqual({ kind: "unattributed", ids: ["test:x"], reason: "outside" });
  });

  it("an unparsed failure runs the full commands in reruns and probes (no id filter)", async () => {
    const e = runnerEnv();
    const c = e.chain(3);
    e.checks.script = commit => e.w.tasksAt(commit).includes("T2") ? failRes([], [], { idsUnparsed: true }) : passRes;
    const j = new JournalSpy("phase-suite");
    e.checks.journal = j;
    const v = await e.runner.run(e.request(c), j);
    expect(v).toMatchObject({ kind: "culprit", range: { taskId: "T2" }, ids: [], files: [] });
    expect(e.checks.calls.every(x => x.mode === "full")).toBe(true);
  });

  it("an unparsed failure whose reruns pass is flaky with no ids", async () => {
    const e = runnerEnv();
    const c = e.chain(2);
    e.checks.script = (_commit, _mode, n) => n === 1 ? failRes([], [], { idsUnparsed: true }) : passRes;
    const j = new JournalSpy("phase-suite");
    e.checks.journal = j;
    expect(await e.runner.run(e.request(c), j)).toEqual({ kind: "flaky", ids: [] });
  });

  it("three errors close the step refused three times and return error with nothing left open (M13a)", async () => {
    const e = runnerEnv();
    const c = e.chain(1);
    e.checks.script = () => errRes("spawn");
    const j = new JournalSpy("phase-suite");
    e.checks.journal = j;
    expect(await e.runner.run(e.request(c), j)).toMatchObject({ kind: "error", reason: "spawn" });
    expect(j.log).toEqual(["end:phase-suite/refused", "start:phase-suite", "end:phase-suite/refused", "start:phase-suite", "end:phase-suite/refused"]);
    expect(j.open).toBeNull();
    expect(e.checks.calls).toHaveLength(3);
  });

  it("preempted attempts do not use the try budget (M38)", async () => {
    const e = runnerEnv();
    const c = e.chain(1);
    e.checks.script = (_commit, _mode, n) => n <= 5 ? errRes("preempted") : passRes;
    const j = new JournalSpy("phase-suite");
    e.checks.journal = j;
    expect(await e.runner.run(e.request(c), j)).toEqual({ kind: "passed" });
    expect(e.checks.calls).toHaveLength(6);
    expect(j.open).toBe("phase-suite");
  });

  it("an aborted or disposed signal returns interrupted without running anything", async () => {
    for (const by of ["abort", "dispose"] as const) {
      const e = runnerEnv();
      const c = e.chain(1);
      const ctl = new AbortController();
      ctl.abort(by === "dispose" ? "dispose" : undefined);
      const j = new JournalSpy("phase-suite", ctl.signal);
      expect(await e.runner.run(e.request(c), j)).toEqual({ kind: "interrupted", by });
      expect(e.checks.calls).toHaveLength(0);
    }
  });

  it("an interrupted command result ends the run as interrupted and journals nothing more", async () => {
    const e = runnerEnv();
    const c = e.chain(1);
    e.checks.script = () => errRes("interrupted");
    const j = new JournalSpy("phase-suite");
    expect(await e.runner.run(e.request(c), j)).toMatchObject({ kind: "interrupted" });
    expect(j.log).toEqual([]);
  });

  it("preemptBackground delegates to the registered background runs", () => {
    const e = runnerEnv();
    const ctl = new AbortController();
    e.background.register(ctl, 1);
    expect(e.runner.preemptBackground()).toBe(true);
    expect(ctl.signal.aborted).toBe(true);
    expect(e.runner.preemptBackground()).toBe(false);
  });
});

describe("phase-suite runner: revert (M26)", () => {
  function revertEnv(rangeCommits = 1) {
    const e = runnerEnv();
    const pre = e.chain(2);
    // the culprit T3 lands `rangeCommits` commits; the last one adds nothing (a follow-up fix by the same task)
    let prev = pre.tip;
    const shas: string[] = [];
    for (let i = 0; i < rangeCommits; i++) {
      const c = e.w.commit(prev, i === 0 ? "T3" : null);
      shas.push(c.sha);
      prev = c.sha;
    }
    const after = e.w.commit(prev, "T4");
    e.w.iwtHead = after.sha;
    e.w.branches.set(INT_REF, after.sha);
    const culprit: TaskRange = { taskId: "T3", from: pre.tip, to: prev };
    const slot: SlotLease = { slot: "integration", path: WT, planId: PLAN_ID, owner: "", commit: after.sha };
    const req = (): RevertRequest => ({
      planId: PLAN_ID, phaseId: "p1", culprit, suiteCommit: after.sha, head: after.sha,
      regression: { ids: ["test:T3"], files: ["t/T3.test.ts"], commands: [SUITE_CMD] }, slot,
    });
    return { ...e, shas, culprit, after, req };
  }

  it("builds the revert in the integration slot, newest commit first, then checks it with the regression as extra; ok leaves revert-checks open", async () => {
    const e = revertEnv(2);
    e.w.bad.add("T3");
    const j = new JournalSpy("revert-build");
    const v = await e.runner.revert(e.req(), j);
    expect(v.kind).toBe("ok");
    if (v.kind !== "ok") return;
    expect(e.git.reverted).toEqual([...e.shas].reverse());
    expect(v.reverted).toEqual([...e.shas].reverse());
    expect(v.revertHead).toBe(e.w.iwtHead);
    expect(e.w.tasksAt(v.revertHead)).toEqual(["T1", "T2", "T4"]);
    expect(e.w.checkLog).toEqual([{ candidate: v.revertHead, slot: "integration", base: e.after.sha, extraIds: ["test:T3"] }]);
    expect(e.w.passed.has(v.revertHead)).toBe(true);
    expect(j.log).toEqual(["end:revert-build/ok", "start:revert-checks"]);
    expect(j.open).toBe("revert-checks");
    expect(j.writes[0]).toBe(`integration:${WT}`);
    expect(e.w.violations).toEqual([]);
  });

  it("a revert that conflicts returns the conflicting commit and paths, runs no checks, leaves revert-build open", async () => {
    const e = revertEnv(2);
    e.git.conflictAt = e.shas[0] ?? "";
    const j = new JournalSpy("revert-build");
    const v = await e.runner.revert(e.req(), j);
    expect(v).toEqual({ kind: "conflict", at: e.shas[0], paths: ["src/conflicted.ts"] });
    expect(e.w.checkLog).toHaveLength(0);
    expect(j.open).toBe("revert-build");
    expect(e.git.reverted).toEqual([e.shas[1]]); // the newest one was reverted before the older conflicted
  });

  it("checks that still fail: failed with the failing ids, and the revert commit is never marked as checked (I1)", async () => {
    const e = revertEnv();
    e.w.bad.add("T3");
    e.w.bad.add("T4"); // another regression the revert does not fix
    const j = new JournalSpy("revert-build");
    const v = await e.runner.revert(e.req(), j);
    expect(v).toMatchObject({ kind: "failed", ids: ["test:T4"], files: ["t/T4.test.ts"] });
    expect(e.w.passed.size).toBe(0);
    expect(j.open).toBe("revert-checks");
  });

  it("an empty range has nothing to revert: three prepare errors, no git write, nothing left open", async () => {
    const e = revertEnv();
    const r = e.req();
    r.culprit = { ...r.culprit, to: r.culprit.from };
    const j = new JournalSpy("revert-build");
    const v = await e.runner.revert(r, j);
    expect(v).toMatchObject({ kind: "error", reason: "prepare" });
    expect(e.git.reverted).toEqual([]);
    expect(j.open).toBeNull();
  });

  it("an interrupted revert returns interrupted", async () => {
    const e = revertEnv();
    const ctl = new AbortController();
    ctl.abort();
    const v = await e.runner.revert(e.req(), new JournalSpy("revert-build", ctl.signal));
    expect(v).toEqual({ kind: "interrupted", by: "abort" });
    expect(e.git.reverted).toEqual([]);
  });
});

describe("phase-suite runner: resolve (M21)", () => {
  function ledgerFor(phaseSuite: LedgerV1["config"]["phaseSuite"]): LedgerV1 {
    const l = buildDraft(0);
    l.config.phaseSuite = phaseSuite;
    l.integration = { ...l.integration, worktree: WT };
    return l;
  }
  const testFiles: RunCommandRef = { script: "test-files", args: ["t/a.test.js"] };

  it("off -> off; an empty list -> none", async () => {
    const e = runnerEnv();
    expect(await e.runner.resolve(ledgerFor("off"), "p1", hex(2))).toEqual({ kind: "off" });
    expect(await e.runner.resolve(ledgerFor([]), "p1", hex(2))).toEqual({ kind: "none" });
  });

  it("a phaseSuite entry naming a routing.run.commands entry (test-files) is resolved by the RunResolver in the integration worktree", async () => {
    const e = runnerEnv();
    const r = await e.runner.resolve(ledgerFor([testFiles]), "p1", hex(2));
    expect(e.resolver.calls).toEqual([{ ref: testFiles, cwd: WT }]);
    expect(r).toEqual({ kind: "runs", commands: [{ label: "test-files", file: "node", args: ["t/a.test.js"], source: "run-command", ref: testFiles }] });
  });

  it("several entries resolve in order; the first refusal refuses the whole suite with its ref", async () => {
    const e = runnerEnv();
    const second: RunCommandRef = { script: "not-allowed", args: [] };
    e.resolver.result = ref => ref.script === "not-allowed" ? { ok: false, reason: "script not allowlisted" }
      : { ok: true, command: { label: ref.script, file: "node", args: ref.args, source: "run-command", ref } };
    const r = await e.runner.resolve(ledgerFor([testFiles, second]), "p1", hex(2));
    expect(r).toEqual({ kind: "refused", reason: "script not allowlisted", ref: second });
  });

  it("a throwing resolver refuses with the error message", async () => {
    const e = runnerEnv();
    e.resolver.throws = new Error("resolver exploded");
    expect(await e.runner.resolve(ledgerFor([testFiles]), "p1", hex(2))).toEqual({ kind: "refused", reason: "resolver exploded", ref: testFiles });
  });

  it("auto: the node/pytest test commands of the commit; none when there are no tests; a failing selection refuses", async () => {
    const e = runnerEnv();
    e.checks.selection = { typecheck: null, tests: [{ framework: "node", full: SUITE_CMD }], extras: [] };
    expect(await e.runner.resolve(ledgerFor("auto"), "p1", hex(2))).toEqual({ kind: "runs", commands: [SUITE_CMD] });
    e.checks.selection = { typecheck: SUITE_CMD, tests: [], extras: [SUITE_CMD] };
    expect(await e.runner.resolve(ledgerFor("auto"), "p1", hex(2))).toEqual({ kind: "none" });
    e.checks.selection = new Error("cannot read package.json");
    const refused = await e.runner.resolve(ledgerFor("auto"), "p1", hex(2));
    expect(refused).toMatchObject({ kind: "refused", ref: null });
    expect(refused.kind === "refused" ? refused.reason : "").toContain("cannot read package.json");
  });
});
