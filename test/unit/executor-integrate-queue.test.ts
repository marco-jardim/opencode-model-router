import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeClock, FakeProc } from "../fixtures/cpx/ledger/fakes.js";
import { removeDirWhenReleased } from "../helpers/remove-dir.js";

// The real ledger store fsyncs every durable batch; on Windows a long scenario takes seconds of wall time. Nothing below waits on
// wall time for a decision (the queue sees only the FakeClock); the budget only bounds how long a hung test may run.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
import { ExecutorError } from "../../src/executor/types";
import { createRepoLockFactory } from "../../src/executor/integrate/queue";
import { createPhaseSuiteRunner } from "../../src/executor/integrate/phase-suite";
import {
  AX_MAX_CHARS,
  BackgroundRuns,
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
  phaseIntegrated,
  pickBatch,
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

  it("takes over a lock file of a dead pid on the same host (counter reason dead-pid)", async () => {
    const env = await lockEnv();
    const file = env.file("repo-C");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ pid: 99, hostname: "h", planId: "other", entryId: null, heartbeatAt: new FakeClock().now() }), "utf8");
    const factory = createRepoLockFactory({ stateRoot: env.root, clock: new FakeClock(), pid: 10, hostname: "h", isPidAlive: pid => pid !== 99 });
    const lock = await factory.acquire("repo-C", holder(), new AbortController().signal);
    expect((lock as { takeover?: string | null }).takeover).toBe("dead-pid");
    const content = JSON.parse(await readFile(file, "utf8")) as { pid: number };
    expect(content.pid).toBe(10);
    await lock.release();
  });

  it("takes over a stale lock of a live foreign holder (counter reason stale)", async () => {
    const env = await lockEnv();
    const file = env.file("repo-D");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ pid: 99, hostname: "elsewhere", planId: "other", entryId: null, heartbeatAt: new FakeClock().now() }), "utf8");
    const factory = createRepoLockFactory({ stateRoot: env.root, clock: new FakeClock(), pid: 10, hostname: "h", isPidAlive: () => true, staleMs: -1 });
    const lock = await factory.acquire("repo-D", holder(), new AbortController().signal);
    expect((lock as { takeover?: string | null }).takeover).toBe("stale");
    await lock.release();
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

  it("an unparsable lock file counts as infinitely old and is taken over as stale", async () => {
    const env = await lockEnv();
    await foreignLock(env, "repo-H", "{{ not json");
    const f = createRepoLockFactory({ stateRoot: env.root, clock: new FakeClock(), pid: 10, hostname: "h", isPidAlive: () => true });
    const lock = await f.acquire("repo-H", holder(), new AbortController().signal);
    expect((lock as { takeover?: string | null }).takeover).toBe("stale");
    await lock.release();
  });

  it("lock files that parse to the wrong shape are taken over as stale", async () => {
    const env = await lockEnv();
    const f = createRepoLockFactory({ stateRoot: env.root, clock: new FakeClock(), pid: 10, hostname: "h", isPidAlive: () => true });
    for (const [i, text] of ["null", JSON.stringify({ pid: "x", hostname: "h", heartbeatAt: 1 }), JSON.stringify({ pid: 1, hostname: 2, heartbeatAt: 1 })].entries()) {
      await foreignLock(env, `repo-shape-${i}`, text);
      const lock = await f.acquire(`repo-shape-${i}`, holder(), new AbortController().signal);
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

  /** The heartbeat rewrites the file in place; a read can land between truncate and write, so retry until it parses. */
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
  async cleanForChecks(): Promise<void> {}
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
class LockDouble implements RepoLockFactory {
  held = false;
  acquires = 0;
  constructor(private readonly w: World) {}
  async acquire(): Promise<RepoLock> {
    if (this.held) this.w.violations.push("I3: repo lock re-entered");
    this.held = true;
    this.acquires++;
    const ctl = new AbortController();
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
  get ledger(): Readonly<LedgerV1> {
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
      suite: this.suite, lander: this.lander, listener: this.listener, locks: this.locks, guard: this.guard, clock: this.clock, logger: this.logger,
      settle: (id, release) => { this.settled.push(id); void release(); },
      history: { steps: async () => (await this.store.exportPlan(PLAN_ID)).events.filter(isStep) },
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
  async until(pred: () => boolean, what = "condition", deadlineMs = 90_000): Promise<void> {
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
    expect(env.ledger.inbox[0]?.text).toContain("(missing)");
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
      // p1 has no tasks, so it is integrated and resume starts its suite. p2 is `suite-running` with no open entry (the A2-1
      // recovery row) but paused, so resume leaves it alone until the test unpauses it.
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
    env.igit.readRef = async (cwd, ref) => cwd === TOPLEVEL ? Promise.reject(new Error("no ref")) : real(cwd, ref); // base unreadable
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
    expect(env.suite.reverts[0]?.regression).toMatchObject({ ids: ["test:T2"], files: [], commands: [] });
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
    expect(env.pool.released).toContain("slot-d2");
    expect(env.leases.released).toEqual(expect.arrayContaining(["D1", "D2"]));
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
    env.igit.readRef = async (cwd, ref) => cwd === TOPLEVEL ? Promise.reject(new Error("no ref")) : real(cwd, ref);
    await env.queue.land();
    expect(env.lander.landCalls).toHaveLength(2);
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

const passRes: CommandRunResult = { verdict: "pass", ids: [], files: [], idsUnparsed: false, output: "", durationMs: 1, error: null };
function failRes(ids: string[], files: string[], over: Partial<CommandRunResult> = {}): CommandRunResult {
  return { verdict: "fail", ids, files, idsUnparsed: false, output: "red", durationMs: 1, error: null, ...over };
}
function errRes(reason: "spawn" | "preempted" | "interrupted" | "prepare"): CommandRunResult {
  return { verdict: "error", ids: [], files: [], idsUnparsed: false, output: "", durationMs: 1, error: { reason, message: `${reason} (scripted)` } };
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
    return this.script(req.commit, mode, this.calls.length);
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
      e.checks.script = commit => e.w.tasksAt(commit).includes(culprit) ? failRes([`test:${culprit}`], [`t/${culprit}.test.ts`]) : passRes;
      const j = new JournalSpy("phase-suite");
      e.checks.journal = j;
      const v = await e.runner.run(e.request(c), j);
      expect(v).toMatchObject({ kind: "culprit", range: { taskId: culprit }, ids: [`test:${culprit}`], files: [`t/${culprit}.test.ts`] });
      if (v.kind !== "culprit") return;
      expect(v.range).toEqual(c.ranges[pos - 1]);
      const probes = e.checks.calls.filter(x => x.commit !== c.tip && x.commit !== e.w.base);
      expect(probes.length).toBeLessThanOrEqual(5); // maxRangeProbes(6)
      expect(e.checks.calls.filter(x => x.commit === c.tip)).toHaveLength(3); // full + 2 reruns
      expect(e.checks.calls.filter(x => x.commit === e.w.base)).toHaveLength(1);
      expect(e.checks.calls.slice(1).every(x => Array.isArray(x.mode) && x.mode[0] === `t/${culprit}.test.ts`)).toBe(true);
      expect(j.log.filter(x => x === "start:bisect")).toHaveLength(probes.length + 1); // + the memo step
      expect(j.open).toBe("bisect");
      expect(j.counters).toEqual([{ key: "integration.bisect.probes", value: probes.length }]);
      expect(j.writes.every(x => x === `slot:${slotPath("ci")}`)).toBe(true);
      expect(e.w.violations).toEqual([]);
    });
  }

  it("flaky: the two reruns pass -> flaky ids, no base run, no bisect; the second rerun stays open for the queue", async () => {
    const e = runnerEnv();
    const c = e.chain(3);
    e.checks.script = (_commit, _mode, n) => n === 1 ? failRes(["test:T2"], ["t/T2.test.ts"]) : passRes;
    const j = new JournalSpy("phase-suite");
    e.checks.journal = j;
    expect(await e.runner.run(e.request(c), j)).toEqual({ kind: "flaky", ids: ["test:T2"] });
    expect(e.checks.calls).toHaveLength(3);
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
    e.checks.script = commit => {
      const ids = ["test:old"];
      if (e.w.tasksAt(commit).includes("T3")) ids.push("test:new");
      return failRes(ids, ids.map(i => `t/${i}.ts`));
    };
    const j = new JournalSpy("phase-suite");
    e.checks.journal = j;
    const v = await e.runner.run(e.request(c), j);
    expect(v).toMatchObject({ kind: "culprit", range: { taskId: "T3" }, ids: ["test:new"] });
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
