// Phase 2.2 task 2.2.3: unit tests of the durable ledger store (src/executor/ledger.ts). Real files in a temp dir through the
// FileSystem seam, an injected clock (no fixed sleeps) and an injected process table. The crash points live in
// test/integration/executor-ledger-crash.test.ts.
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLedgerStore,
  createNodeClock,
  createNodeFileSystem,
  type LedgerStoreDeps,
} from "../../src/executor/ledger.js";
import {
  ExecutorError,
  type ExecutorEvent,
  type ExecutorEventInput,
  type FileSystem,
  type LedgerStore,
  type LedgerV1,
  type LedgerWriter,
  type LockHolder,
  type TaskState,
  type TransitionTrigger,
} from "../../src/executor/types.js";
import {
  PLAN_ID,
  T0,
  addTask,
  buildDraft,
  clone,
  eventLine,
  holderOf,
  initLine,
  metric,
  openAttempt,
  taskNode,
} from "../fixtures/cpx/ledger/builders.js";
import { FakeClock, FakeProc, fsError, interceptFs, type FsCall, type FsInterceptor } from "../fixtures/cpx/ledger/fakes.js";
import { removeDirWhenReleased } from "../helpers/remove-dir.js";

// ---------------------------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------------------------

const roots: string[] = [];

afterEach(async () => {
  for (const r of roots.splice(0)) await removeDirWhenReleased(r, { deadlineMs: 20_000 });
}, 60_000);

interface Env {
  root: string;
  home: string;
  dir: string;
  clock: FakeClock;
  proc: FakeProc;
  warnings: string[];
  store: LedgerStore;
  holder(sessionID: string): LockHolder;
}

interface EnvOpts {
  root?: string;
  pid?: number;
  host?: string;
  clock?: FakeClock;
  fs?: FileSystem;
  snapshotEvery?: number;
  staleMs?: number;
  heartbeatMs?: number;
}

async function newRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omr-ledger-unit-"));
  roots.push(root);
  return root;
}

/** One simulated process: own pid, own warnings, sharing `root` (and optionally the clock) with other envs. */
async function mk(o: EnvOpts = {}): Promise<Env> {
  const root = o.root ?? (await newRoot());
  const home = join(root, "omr-executor");
  const clock = o.clock ?? new FakeClock();
  const proc = new FakeProc(o.pid ?? 100, o.host ?? "host-a");
  const warnings: string[] = [];
  const deps: LedgerStoreDeps = {
    home,
    clock,
    proc,
    warn: (m) => {
      warnings.push(m);
    },
    heartbeatMs: o.heartbeatMs ?? 10_000,
    staleMs: o.staleMs ?? 60_000,
    snapshotEvery: o.snapshotEvery ?? 200,
    ...(o.fs === undefined ? {} : { fs: o.fs }),
  };
  return {
    root,
    home,
    dir: join(home, PLAN_ID),
    clock,
    proc,
    warnings,
    store: createLedgerStore(deps),
    holder: (sessionID) => holderOf(sessionID, proc.pid, proc.hostname, clock.iso()),
  };
}

const realFs = createNodeFileSystem();

const ls = async (dir: string): Promise<string[]> => (await readdir(dir)).sort();
const readJson = async (file: string): Promise<unknown> => JSON.parse(await readFile(file, "utf8")) as unknown;
const readLines = async (file: string): Promise<string[]> => (await readFile(file, "utf8")).split("\n").filter((l) => l !== "");

function transition(taskId: string, from: TaskState, to: TaskState, trigger: TransitionTrigger): ExecutorEventInput {
  return { type: "task-transition", taskId, from, to, trigger, detail: null };
}

async function failure(p: Promise<unknown>): Promise<ExecutorError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ExecutorError) return e;
    throw e;
  }
  throw new Error("expected an ExecutorError, but the call resolved");
}

/** A promise gate: `reached` resolves when the code under test arrives, `open()` lets it continue. */
function gate(): { reached: Promise<void>; markReached(): void; wait: Promise<void>; open(): void } {
  let markReached = (): void => undefined;
  let open = (): void => undefined;
  const reached = new Promise<void>((r) => {
    markReached = r;
  });
  const wait = new Promise<void>((r) => {
    open = r;
  });
  return { reached, markReached, wait, open };
}

/** Plants a plan directory by hand: `events.1.jsonl` from `lines` (+ raw `tail`), an optional snapshot. Returns the plan dir. */
async function plant(
  home: string,
  lines: readonly string[],
  extra: { tail?: string; snapshot?: unknown; snapshotRaw?: string } = {},
): Promise<string> {
  const dir = join(home, PLAN_ID);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "events.1.jsonl"), `${lines.join("\n")}\n${extra.tail ?? ""}`, "utf8");
  if (extra.snapshot !== undefined) await writeFile(join(dir, "ledger.json"), JSON.stringify(extra.snapshot), "utf8");
  if (extra.snapshotRaw !== undefined) await writeFile(join(dir, "ledger.json"), extra.snapshotRaw, "utf8");
  return dir;
}

function asLedger(v: unknown): LedgerV1 {
  return v as LedgerV1;
}

// ---------------------------------------------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------------------------------------------

describe("round trip", () => {
  it("a 500-task ledger survives create, a 500-event batch, close, read and reopen unchanged", async () => {
    const e = await mk();
    const draft = buildDraft(500);
    const w = await e.store.create(draft, e.holder("s1"));
    expect(w.ledger).toEqual(draft);
    const ids = Object.keys(draft.tasks);
    expect(ids).toHaveLength(500);
    const after = await w.append(ids.map((id) => transition(id, "pending", "ready", "deps-satisfied")));
    expect(after.seq).toBe(501);
    expect(Object.values(after.tasks).every((t) => t.state === "ready")).toBe(true);
    await w.close();

    const read = await e.store.read(PLAN_ID);
    expect(read).toEqual(after);
    expect(Object.keys(read.tasks)).toEqual(ids); // plan order (R14) survives the JSON round trip

    const again = await e.store.open(PLAN_ID, e.holder("s2"));
    expect(again.ledger).toEqual(after);
    await again.close();

    const exported = await e.store.exportPlan(PLAN_ID);
    expect(exported.snapshot).toEqual(after);
    expect((await e.store.list()).map((p) => [p.planId, p.status, p.seq])).toEqual([[PLAN_ID, "running", 501]]);
    expect(e.warnings).toEqual([]);
  });

  it("create refuses a second plan with the same id, an invalid draft and a draft whose seq is not 1", async () => {
    const e = await mk();
    const w = await e.store.create(buildDraft(1), e.holder("s1"));
    expect((await failure(e.store.create(buildDraft(1), e.holder("s2")))).code).toBe("E_EXISTS");
    await w.close();
    const bad = clone(buildDraft(1));
    bad.seq = 2;
    expect((await failure(e.store.create(bad, e.holder("s1")))).code).toBe("E_SCHEMA_INVALID");
    const broken = { ...buildDraft(1), status: "bogus" } as unknown as LedgerV1;
    expect((await failure(e.store.create(broken, e.holder("s1")))).code).toBe("E_SCHEMA_INVALID");
    expect((await failure(e.store.create(buildDraft(1, "../evil"), e.holder("s1")))).code).toBe("E_SCHEMA_INVALID");
  });

  it("a plan id that is not a path segment is refused by every entry point", async () => {
    const e = await mk();
    for (const id of ["../x", "", "a/b", "A"]) {
      expect((await failure(e.store.read(id))).code).toBe("E_INVALID_INPUT");
      expect((await failure(e.store.open(id, e.holder("s")))).code).toBe("E_INVALID_INPUT");
      expect((await failure(e.store.remove(id))).code).toBe("E_INVALID_INPUT");
    }
  });

  it("an unknown plan is E_LEDGER_NOT_FOUND; list is empty without a home and ignores strays", async () => {
    const e = await mk();
    expect(await e.store.list()).toEqual([]);
    expect((await failure(e.store.read(PLAN_ID))).code).toBe("E_LEDGER_NOT_FOUND");
    expect((await failure(e.store.open(PLAN_ID, e.holder("s")))).code).toBe("E_LEDGER_NOT_FOUND");
    expect((await failure(e.store.takeover(PLAN_ID, e.holder("s"), "r"))).code).toBe("E_LEDGER_NOT_FOUND");
    expect((await failure(e.store.exportPlan(PLAN_ID))).code).toBe("E_LEDGER_NOT_FOUND");
    expect(await e.store.remove(PLAN_ID)).toBe(false);
    await mkdir(join(e.home, "slots"), { recursive: true });
    await mkdir(join(e.home, "not a plan id"), { recursive: true });
    await mkdir(join(e.home, "p-empty-dir"), { recursive: true }); // a plan dir without any ledger file: skipped
    await writeFile(join(e.home, "p-corrupt"), "x", "utf8"); // a file, not a plan dir
    expect(await e.store.list()).toEqual([]);
  });

  it("list reports every readable plan and skips (with a warning) an unreadable one", async () => {
    const e = await mk();
    const a = await e.store.create(buildDraft(1, "plan-a"), e.holder("s1"));
    const b = await e.store.create(buildDraft(2, "plan-b"), e.holder("s1"));
    await a.close();
    await b.close();
    await mkdir(join(e.home, "plan-c"), { recursive: true });
    await writeFile(join(e.home, "plan-c", "events.1.jsonl"), "not json at all\nnot json either\n", "utf8");
    const rows = await e.store.list();
    expect(rows.map((r) => r.planId)).toEqual(["plan-a", "plan-b"]);
    expect(rows[0]).toEqual({ planId: "plan-a", status: "running", toplevel: "C:/repo", orchestratorSessionID: "ses-0", seq: 1 });
    expect(e.warnings.some((m) => m.includes("plan-c") && m.includes("unreadable"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Snapshot cadence and rotation
// ---------------------------------------------------------------------------------------------------------------

describe("snapshot cadence and journal rotation", () => {
  it("snapshots every N events and rotates: the new journal exists, the old one is deleted", async () => {
    const e = await mk({ snapshotEvery: 5 });
    const w = await e.store.create(buildDraft(1), e.holder("s1"));
    expect(await ls(e.dir)).toEqual(["events.1.jsonl", "ledger.json", "writer.lock"]);
    for (let i = 2; i <= 5; i++) await w.append([addTask(`N${i}`)]);
    // Four events since the last snapshot: no rotation yet.
    expect(await ls(e.dir)).toEqual(["events.1.jsonl", "history.jsonl", "ledger.json", "writer.lock"]);
    expect(asLedger(await readJson(join(e.dir, "ledger.json"))).seq).toBe(1);

    await w.append([addTask("N6")]); // the fifth event since the snapshot
    expect(await ls(e.dir)).toEqual(["events.7.jsonl", "history.jsonl", "ledger.json", "writer.lock"]);
    expect(asLedger(await readJson(join(e.dir, "ledger.json"))).seq).toBe(6);
    expect(await readLines(join(e.dir, "events.7.jsonl"))).toEqual([]);

    for (let i = 7; i <= 11; i++) await w.append([addTask(`N${i}`)]);
    expect(await ls(e.dir)).toEqual(["events.12.jsonl", "history.jsonl", "ledger.json", "writer.lock"]);
    expect(asLedger(await readJson(join(e.dir, "ledger.json"))).seq).toBe(11);
    expect(await e.store.read(PLAN_ID)).toEqual(w.ledger);
    expect(e.warnings).toEqual([]);
  });

  it("counts events, not batches: one 3-event batch against snapshotEvery 3 snapshots at once", async () => {
    const e = await mk({ snapshotEvery: 3 });
    const w = await e.store.create(buildDraft(1), e.holder("s1"));
    await w.append([addTask("A"), addTask("B"), addTask("C")]);
    expect(await ls(e.dir)).toEqual(["events.5.jsonl", "history.jsonl", "ledger.json", "writer.lock"]);
    expect(asLedger(await readJson(join(e.dir, "ledger.json"))).seq).toBe(4);
  });

  it("frames a batch: seq +1, batch = first seq, last only on the final event, one shared `at`", async () => {
    const e = await mk();
    const w = await e.store.create(buildDraft(1), e.holder("s1"));
    await w.append([addTask("A"), addTask("B"), addTask("C")]);
    await w.append([metric(1)]);
    const lines = (await readLines(join(e.dir, "events.1.jsonl"))).map((l) => JSON.parse(l) as ExecutorEvent);
    expect(lines.map((l) => [l.seq, l.batch, l.last])).toEqual([
      [1, 1, true],
      [2, 2, false],
      [3, 2, false],
      [4, 2, true],
      [5, 5, true],
    ]);
    expect(new Set(lines.slice(1, 4).map((l) => l.at)).size).toBe(1);
  });

  it("an explicit snapshot() persists the current seq, is a no-op when nothing changed, and close() snapshots and releases the lock", async () => {
    const e = await mk();
    const w = await e.store.create(buildDraft(1), e.holder("s1"));
    await w.snapshot(); // nothing new since create
    expect(await ls(e.dir)).toEqual(["events.1.jsonl", "ledger.json", "writer.lock"]);
    await w.append([addTask("A")]);
    await w.snapshot();
    expect(await ls(e.dir)).toEqual(["events.3.jsonl", "history.jsonl", "ledger.json", "writer.lock"]);
    expect(asLedger(await readJson(join(e.dir, "ledger.json"))).seq).toBe(2);
    await w.append([addTask("B")]);
    await w.close();
    expect(await ls(e.dir)).toEqual(["events.4.jsonl", "history.jsonl", "ledger.json"]);
    expect(asLedger(await readJson(join(e.dir, "ledger.json"))).seq).toBe(3);
    await w.close(); // idempotent
  });

  it.each([
    ["before the snapshot is renamed into place", (c: FsCall) => c.op === "rename" && /ledger\.json\.tmp-/.test(c.path)],
    ["after the rename, before the new journal exists", (c: FsCall) => c.op === "writeText" && /events\.4\.jsonl$/.test(c.path)],
    ["when the old journal is deleted", (c: FsCall) => c.op === "rm" && /events\.1\.jsonl$/.test(c.path)],
  ])("a concurrent reader sees a consistent ledger while the writer is paused in rotation: %s", async (_name, pausesAt) => {
    const g = gate();
    let armed = false;
    const hook: FsInterceptor = async (call) => {
      if (armed && pausesAt(call)) {
        g.markReached();
        await g.wait;
      }
    };
    const root = await newRoot();
    const w = await mk({ root, snapshotEvery: 2, fs: interceptFs(realFs, hook) });
    const reader = await mk({ root, pid: 200 });
    const writer = await w.store.create(buildDraft(1), w.holder("s1"));
    armed = true;
    await writer.append([addTask("T8")]);
    const pending = writer.append([addTask("T9")]); // the second event since the snapshot: rotation starts
    await g.reached;
    // The writer is stuck mid-rotation, holding the lock; the reader still gets every fsynced event, without any lock.
    const seen = await reader.store.read(PLAN_ID);
    expect(seen.seq).toBe(3);
    expect(Object.keys(seen.tasks)).toEqual(["T1", "T8", "T9"]);
    expect((await reader.store.exportPlan(PLAN_ID)).snapshot.seq).toBe(3);
    expect(reader.warnings).toEqual([]);
    g.open();
    await pending;
    expect(await reader.store.read(PLAN_ID)).toEqual(writer.ledger);
    expect(await ls(w.dir)).toEqual(["events.4.jsonl", "history.jsonl", "ledger.json", "writer.lock"]);
  });

  it("a reader whose snapshot and journal listing disagree retries and then succeeds", async () => {
    const root = await newRoot();
    const w = await mk({ root });
    const writer = await w.store.create(buildDraft(1), w.holder("s1"));
    await writer.append([addTask("A")]);
    await writer.append([addTask("B")]);
    let rotated = false;
    const hook: FsInterceptor = async (call) => {
      // After the reader has read the old snapshot and listed events.1.jsonl, the writer rotates under it.
      if (!rotated && call.op === "readText" && /events\.\d+\.jsonl$/.test(call.path)) {
        rotated = true;
        await writer.snapshot();
      }
    };
    const reader = await mk({ root, pid: 200, clock: w.clock, fs: interceptFs(realFs, hook) });
    const seen = await reader.store.read(PLAN_ID);
    expect(seen).toEqual(writer.ledger);
    expect(seen.seq).toBe(3);
    expect(rotated).toBe(true);
    expect(w.clock.sleeps).toEqual([5]); // exactly one retry, through the injected clock
  });

  it("a reader that never sees a consistent state gives up with E_SEQ_GAP after its retries", async () => {
    const root = await newRoot();
    const w = await mk({ root });
    const writer = await w.store.create(buildDraft(1), w.holder("s1"));
    await writer.append([addTask("A")]);
    const hook: FsInterceptor = (call) => {
      if (call.op === "readText" && /events\.\d+\.jsonl$/.test(call.path)) throw fsError("ENOENT");
    };
    const reader = await mk({ root, pid: 200, clock: w.clock, fs: interceptFs(realFs, hook) });
    const err = await failure(reader.store.read(PLAN_ID));
    expect(err.code).toBe("E_SEQ_GAP");
    expect(err.message).toMatch(/never agreed/);
    expect(w.clock.sleeps).toEqual([5, 10, 15, 20, 25, 30, 35, 40]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Load errors
// ---------------------------------------------------------------------------------------------------------------

describe("load errors", () => {
  const init = (): string => initLine(buildDraft(2));
  const created = (id: string, seq: number): string => eventLine(addTask(id), seq, seq, true);

  it("a torn last line is dropped with one warning; open then heals it by snapshot and rotation", async () => {
    const e = await mk();
    const half = created("T3", 3).slice(0, 25);
    const dir = await plant(e.home, [init(), created("T2x", 2)], { tail: half });
    const ledger = await e.store.read(PLAN_ID);
    expect(ledger.seq).toBe(2);
    expect(Object.keys(ledger.tasks)).toEqual(["T1", "T2", "T2x"]);
    expect(e.warnings).toEqual(["events.1.jsonl: torn last line dropped"]);

    const w = await e.store.open(PLAN_ID, e.holder("s1"));
    expect(w.ledger.seq).toBe(2);
    // Appending to the torn file would glue bytes onto the torn tail: the open rotated to a fresh journal.
    expect(await ls(dir)).toEqual(["events.3.jsonl", "history.jsonl", "ledger.json", "writer.lock"]);
    await w.append([addTask("T3")]);
    await w.close();
    expect((await e.store.read(PLAN_ID)).seq).toBe(3);
  });

  it("a terminated last line that does not parse is also torn", async () => {
    const e = await mk();
    await plant(e.home, [init(), created("A", 2), "{\"seq\":3,\"at\":"]);
    expect((await e.store.read(PLAN_ID)).seq).toBe(2);
    expect(e.warnings).toEqual(["events.1.jsonl: torn last line dropped"]);
  });

  it("a last line that parses but is not an event envelope is torn too", async () => {
    const e = await mk();
    await plant(e.home, [init(), created("A", 2), "{\"hello\":1}"]);
    expect((await e.store.read(PLAN_ID)).seq).toBe(2);
    expect(e.warnings).toEqual(["events.1.jsonl: torn last line dropped"]);
  });

  it("a trailing batch without its last event is dropped whole with one warning", async () => {
    const e = await mk();
    await plant(e.home, [
      init(),
      eventLine(addTask("A"), 2, 2, false),
      eventLine(addTask("B"), 3, 2, false),
    ]);
    const ledger = await e.store.read(PLAN_ID);
    expect(ledger.seq).toBe(1);
    expect(Object.keys(ledger.tasks)).toEqual(["T1", "T2"]);
    expect(e.warnings).toHaveLength(1);
    expect(e.warnings[0]).toMatch(/incomplete trailing batch dropped \(2 events, incomplete-batch\)/);
  });

  it("a seq gap is E_SEQ_GAP", async () => {
    const e = await mk();
    await plant(e.home, [init(), created("A", 2), created("C", 4)]);
    const err = await failure(e.store.read(PLAN_ID));
    expect(err.code).toBe("E_SEQ_GAP");
    expect(err.message).toMatch(/seq 4 follows 2/);
    expect((await failure(e.store.open(PLAN_ID, e.holder("s")))).code).toBe("E_SEQ_GAP");
    expect(await ls(join(e.home, PLAN_ID))).toEqual(["events.1.jsonl"]); // the failed open released its lock
  });

  it.each([
    ["a garbled line in the middle", (): string[] => [init(), "garbage", created("B", 3)]],
    ["a non-envelope line in the middle", (): string[] => [init(), "[1,2]", created("B", 3)]],
    ["a wrong batch number", (): string[] => [init(), eventLine(addTask("A"), 2, 1, true)]],
    ["a batch that does not follow a closed batch", (): string[] => [init(), eventLine(addTask("A"), 2, 2, false), eventLine(addTask("B"), 3, 3, true)]],
    ["a first event whose batch is not its seq", (): string[] => [JSON.stringify({ ...JSON.parse(init()), batch: 2 })]],
  ])("corruption is E_SEQ_GAP: %s", async (_name, lines) => {
    const e = await mk();
    await plant(e.home, lines());
    expect((await failure(e.store.read(PLAN_ID))).code).toBe("E_SEQ_GAP");
  });

  it("a journal that does not start at seq 1 and has no snapshot is E_SEQ_GAP", async () => {
    const e = await mk();
    const dir = join(e.home, PLAN_ID);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "events.5.jsonl"), `${created("A", 5)}\n`, "utf8");
    expect((await failure(e.store.read(PLAN_ID))).code).toBe("E_SEQ_GAP");
  });

  it("a journal that does not begin with a lone ledger-init is E_SEQ_GAP; an empty journal is E_LEDGER_NOT_FOUND", async () => {
    const e = await mk();
    await plant(e.home, [eventLine(addTask("A"), 1, 1, true)]);
    expect((await failure(e.store.read(PLAN_ID))).code).toBe("E_SEQ_GAP");
    const e2 = await mk();
    const dir = join(e2.home, PLAN_ID);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "events.1.jsonl"), "", "utf8");
    expect((await failure(e2.store.read(PLAN_ID))).code).toBe("E_LEDGER_NOT_FOUND");
  });

  it("an illegal transition is E_ILLEGAL_TRANSITION and names the event", async () => {
    const e = await mk();
    // T1 is pending: "ready -> dispatched" has the wrong `from`.
    await plant(e.home, [init(), eventLine(transition("T1", "ready", "dispatched", "launch"), 2, 2, true)]);
    const err = await failure(e.store.read(PLAN_ID));
    expect(err.code).toBe("E_ILLEGAL_TRANSITION");
    expect(err.detail).toEqual({ event: { seq: 2, batch: 2, type: "task-transition" }, codes: ["transition-from-mismatch"] });
    expect((await failure(e.store.open(PLAN_ID, e.holder("s")))).code).toBe("E_ILLEGAL_TRANSITION");
    expect(await ls(join(e.home, PLAN_ID))).toEqual(["events.1.jsonl"]);
  });

  it("a wrong trigger, a missing task and a batch that ends in an invalid ledger are all E_ILLEGAL_TRANSITION", async () => {
    const e1 = await mk();
    await plant(e1.home, [init(), eventLine(transition("T1", "pending", "ready", "launch"), 2, 2, true)]);
    expect((await failure(e1.store.read(PLAN_ID))).detail).toMatchObject({ codes: ["transition-trigger"] });

    const e2 = await mk();
    await plant(e2.home, [init(), eventLine(transition("NOPE", "pending", "ready", "deps-satisfied"), 2, 2, true)]);
    expect((await failure(e2.store.read(PLAN_ID))).detail).toMatchObject({ codes: ["task-missing"] });

    // A slot on a pending task: a legal event on its own, but the ledger is invalid at the batch end.
    const e3 = await mk();
    await plant(e3.home, [init(), eventLine({ type: "task-slot", taskId: "T1", slot: "slot-1", branch: null }, 2, 2, true)]);
    const err = await failure(e3.store.read(PLAN_ID));
    expect(err.code).toBe("E_ILLEGAL_TRANSITION");
    expect(err.message).toMatch(/leaves the ledger invalid|is illegal/);
    expect((err.detail as { codes: string[] }).codes.some((c) => c.startsWith("slot-forbidden@"))).toBe(true);
  });

  // Regression (2.2.FIX): a multi-event batch still in the live journal, not covered by a snapshot, must load. The file-boundary
  // check in `loadMain` once ran for every line and rejected such a journal with E_SEQ_GAP.
  it("a multi-event batch in the live journal loads (planted file)", async () => {
    const e = await mk();
    await plant(e.home, [init(), eventLine(addTask("A"), 2, 2, false), eventLine(addTask("B"), 3, 2, true)]);
    const ledger = await e.store.read(PLAN_ID);
    expect(ledger.seq).toBe(3);
    expect(Object.keys(ledger.tasks)).toEqual(["T1", "T2", "A", "B"]);
  });

  it("a multi-event batch appended by a live writer is readable before the next snapshot", async () => {
    const root = await newRoot();
    const w = await mk({ root });
    const reader = await mk({ root, pid: 200 });
    const writer = await w.store.create(buildDraft(1), w.holder("s1"));
    await writer.append([addTask("A"), addTask("B")]);
    expect((await reader.store.read(PLAN_ID)).seq).toBe(3);
  });

  it("a ledger-init in the middle of a journal is illegal", async () => {
    const e = await mk();
    await plant(e.home, [init(), initLine(buildDraft(2)).replace('"seq":1,"at"', '"seq":2,"at"').replace('"batch":1', '"batch":2')]);
    const err = await failure(e.store.read(PLAN_ID));
    expect(err.code).toBe("E_ILLEGAL_TRANSITION");
  });

  it("a ledger-init whose ledger is not at seq 1 is illegal", async () => {
    const e = await mk();
    const draft = buildDraft(1);
    draft.seq = 7;
    await plant(e.home, [initLine(draft)]);
    expect((await failure(e.store.read(PLAN_ID))).code).toBe("E_ILLEGAL_TRANSITION");
  });

  it("a newer schema is E_SCHEMA_NEWER, in the snapshot and in the journal's ledger-init", async () => {
    const e1 = await mk();
    const newer = { ...buildDraft(2), schema: 2 };
    await plant(e1.home, [init()], { snapshot: newer });
    const err = await failure(e1.store.read(PLAN_ID));
    expect(err.code).toBe("E_SCHEMA_NEWER");
    expect(err.detail).toEqual({ schema: 2 });
    expect((await failure(e1.store.open(PLAN_ID, e1.holder("s")))).code).toBe("E_SCHEMA_NEWER");

    const e2 = await mk();
    await plant(e2.home, [JSON.stringify({ seq: 1, at: T0, batch: 1, last: true, type: "ledger-init", ledger: newer })]);
    expect((await failure(e2.store.read(PLAN_ID))).code).toBe("E_SCHEMA_NEWER");
  });

  it("an older schema without a migration, invalid JSON and an invalid ledger are E_SCHEMA_INVALID", async () => {
    const e1 = await mk();
    await plant(e1.home, [init()], { snapshot: { ...buildDraft(2), schema: 0 } });
    const err = await failure(e1.store.read(PLAN_ID));
    expect(err.code).toBe("E_SCHEMA_INVALID");
    expect(err.message).toMatch(/no migration from schema 0/);

    const e2 = await mk();
    await plant(e2.home, [init()], { snapshotRaw: "{not json" });
    expect((await failure(e2.store.read(PLAN_ID))).code).toBe("E_SCHEMA_INVALID");

    const e3 = await mk();
    await plant(e3.home, [init()], { snapshot: { ...buildDraft(2), status: "bogus" } });
    const bad = await failure(e3.store.read(PLAN_ID));
    expect(bad.code).toBe("E_SCHEMA_INVALID");
    expect(Array.isArray(bad.detail)).toBe(true);

    const e4 = await mk();
    await plant(e4.home, [JSON.stringify({ seq: 1, at: T0, batch: 1, last: true, type: "ledger-init", ledger: { schema: 1 } })]);
    expect((await failure(e4.store.read(PLAN_ID))).code).toBe("E_SCHEMA_INVALID");
  });

  it("snapshot and journal that disagree are E_SEQ_GAP for the writer", async () => {
    const e = await mk();
    const snap = buildDraft(2);
    snap.seq = 5;
    // The journal continues at seq 2, but the snapshot says 5 and no later file covers it.
    const dir = await plant(e.home, [init(), created("A", 2)], { snapshot: snap });
    await writeFile(join(dir, "events.9.jsonl"), `${created("Z", 9)}\n`, "utf8");
    expect((await failure(e.store.open(PLAN_ID, e.holder("s")))).code).toBe("E_SEQ_GAP");
  });

  it("a journal that ends inside a batch before the next journal starts is E_SEQ_GAP", async () => {
    const e = await mk();
    const dir = await plant(e.home, [init(), eventLine(addTask("A"), 2, 2, false)]);
    await writeFile(join(dir, "events.3.jsonl"), `${created("B", 3)}\n`, "utf8");
    const snap = buildDraft(2);
    snap.seq = 1;
    await writeFile(join(dir, "ledger.json"), JSON.stringify(snap), "utf8");
    expect((await failure(e.store.read(PLAN_ID))).code).toBe("E_SEQ_GAP");
  });

  it("unknown extra fields are preserved through load, append, snapshot and reload", async () => {
    const e = await mk();
    const draft = clone(buildDraft(2)) as LedgerV1 & Record<string, unknown>;
    draft.futureField = { nested: [1, 2, { deep: true }] };
    (draft.tasks.T1 as unknown as Record<string, unknown>).futureTaskField = "keep me";
    const extraEvent = { ...JSON.parse(created("A", 2)) as Record<string, unknown>, futureEventField: 42 };
    const dir = await plant(e.home, [JSON.stringify({ seq: 1, at: T0, batch: 1, last: true, type: "ledger-init", ledger: draft }), JSON.stringify(extraEvent)]);

    const first = await e.store.read(PLAN_ID);
    expect((first as unknown as Record<string, unknown>).futureField).toEqual({ nested: [1, 2, { deep: true }] });
    expect((first.tasks.T1 as unknown as Record<string, unknown>).futureTaskField).toBe("keep me");

    const w = await e.store.open(PLAN_ID, e.holder("s1"));
    await w.append([addTask("B")]);
    await w.close();
    const snapshot = (await readJson(join(dir, "ledger.json"))) as Record<string, unknown>;
    expect(snapshot.futureField).toEqual({ nested: [1, 2, { deep: true }] });
    expect(snapshot.seq).toBe(3);
    const again = await e.store.read(PLAN_ID);
    expect((again as unknown as Record<string, unknown>).futureField).toEqual({ nested: [1, 2, { deep: true }] });
    expect(Object.keys(again.tasks)).toEqual(["T1", "T2", "A", "B"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Lock
// ---------------------------------------------------------------------------------------------------------------

describe("writer lock", () => {
  it("a second writer is refused with the holder's info", async () => {
    const root = await newRoot();
    const a = await mk({ root, pid: 100 });
    const b = await mk({ root, pid: 200, clock: a.clock });
    b.proc.alive.add(100);
    const w = await a.store.create(buildDraft(1), a.holder("session-a"));
    const err = await failure(b.store.open(PLAN_ID, b.holder("session-b")));
    expect(err.code).toBe("E_LOCK_HELD");
    expect(err.message).toContain("pid 100 on host-a (session session-a)");
    expect(err.message).not.toMatch(/stale/);
    expect(err.detail).toMatchObject({ pid: 100, hostname: "host-a", sessionID: "session-a", startedAt: T0 });
    // takeover of a live, fresh lock is refused as well
    expect((await failure(b.store.takeover(PLAN_ID, b.holder("session-b"), "impatient"))).code).toBe("E_LOCK_HELD");
    // the holder is untouched
    await w.append([addTask("A")]);
    expect((await readJson(join(a.dir, "writer.lock")) as LockHolder).sessionID).toBe("session-a");
    expect(await ls(a.dir)).not.toContain("writer.lock.guard");
  });

  it("the first writer's create refuses a plan being created elsewhere", async () => {
    const e = await mk();
    await mkdir(e.dir, { recursive: true });
    await writeFile(join(e.dir, "writer.lock"), "{}", "utf8");
    // dir exists -> E_EXISTS comes first; create never overwrites
    expect((await failure(e.store.create(buildDraft(1), e.holder("s")))).code).toBe("E_EXISTS");
  });

  it("stale by dead pid: open names it stale, takeover succeeds and is journaled", async () => {
    const root = await newRoot();
    const a = await mk({ root, pid: 100 });
    const b = await mk({ root, pid: 200, clock: a.clock });
    const w = await a.store.create(buildDraft(1), a.holder("session-a"));
    await w.append([addTask("A")]);
    // process 100 dies without releasing the lock (it is not in b's process table)
    const err = await failure(b.store.open(PLAN_ID, b.holder("session-b")));
    expect(err.code).toBe("E_LOCK_HELD");
    expect(err.message).toMatch(/it is stale, use takeover/);

    const tw = await b.store.takeover(PLAN_ID, b.holder("session-b"), "owner crashed");
    expect(tw.ledger.seq).toBe(3);
    const { events } = await b.store.exportPlan(PLAN_ID);
    const takeover = events.find((x) => x.type === "lock-takeover");
    expect(takeover).toBeDefined();
    if (takeover === undefined || takeover.type !== "lock-takeover") throw new Error("no lock-takeover event");
    expect(takeover.seq).toBe(3);
    expect(takeover.reason).toBe("owner crashed");
    expect(takeover.previous).toMatchObject({ pid: 100, sessionID: "session-a" });
    expect(takeover.holder).toMatchObject({ pid: 200, sessionID: "session-b" });
    expect((await readJson(join(b.dir, "writer.lock")) as LockHolder).sessionID).toBe("session-b");
    expect(await ls(b.dir)).not.toContain("writer.lock.guard");
    await tw.close();
  });

  it("the old writer is fenced after a takeover: E_LOCK_LOST on append, snapshot and heartbeat; close leaves the new lock alone", async () => {
    const root = await newRoot();
    const a = await mk({ root, pid: 100 });
    const b = await mk({ root, pid: 200, clock: a.clock });
    const old = await a.store.create(buildDraft(1), a.holder("session-a"));
    const fresh = await b.store.takeover(PLAN_ID, b.holder("session-b"), "adopt after hang");
    expect((await failure(old.append([addTask("late")]))).code).toBe("E_LOCK_LOST");
    expect((await failure(old.append([addTask("later")]))).code).toBe("E_LOCK_LOST"); // stays lost
    expect((await failure(old.snapshot())).code).toBe("E_LOCK_LOST");
    await old.close(); // does not throw and does not delete the new holder's lock
    expect((await readJson(join(b.dir, "writer.lock")) as LockHolder).sessionID).toBe("session-b");
    expect(Object.keys((await b.store.read(PLAN_ID)).tasks)).toEqual(["T1"]);
    await fresh.close();
  });

  it("stale by heartbeat: refused while fresh, taken over once the heartbeat is older than staleMs; heartbeats keep it fresh", async () => {
    const root = await newRoot();
    const clock = new FakeClock();
    const a = await mk({ root, pid: 100, clock });
    const other = await mk({ root, pid: 300, host: "host-b", clock });
    const w = await a.store.create(buildDraft(1), a.holder("session-a"));
    expect(clock.heldCount()).toBe(1); // the heartbeat timer, armed on the injected clock

    clock.advance(59_000);
    expect((await failure(other.store.takeover(PLAN_ID, other.holder("session-b"), "r"))).code).toBe("E_LOCK_HELD");
    // a heartbeat at t+59s refreshes the lock
    clock.fire();
    await w.append([]); // serialised after the heartbeat
    expect((await readJson(join(a.dir, "writer.lock")) as LockHolder).heartbeatAt).toBe(clock.iso());
    expect(clock.heldCount()).toBe(1); // re-armed
    clock.advance(59_000); // 118 s after the start, 59 s after the heartbeat
    expect((await failure(other.store.takeover(PLAN_ID, other.holder("session-b"), "r"))).code).toBe("E_LOCK_HELD");
    clock.advance(2_000); // 61 s after the last heartbeat; different host: no pid check, only the heartbeat counts
    const err = await failure(other.store.open(PLAN_ID, other.holder("session-b")));
    expect(err.message).toMatch(/stale/);
    const tw = await other.store.takeover(PLAN_ID, other.holder("session-b"), "silent for 61 s");
    expect(tw.ledger.seq).toBe(2);
    expect((await failure(w.append([addTask("late")]))).code).toBe("E_LOCK_LOST");
    await tw.close();
  });

  it("an unparsable heartbeat time counts as stale on a foreign host", async () => {
    const root = await newRoot();
    const a = await mk({ root, pid: 100 });
    const other = await mk({ root, pid: 300, host: "host-b", clock: a.clock });
    await a.store.create(buildDraft(1), a.holder("session-a"));
    const lock = (await readJson(join(a.dir, "writer.lock"))) as LockHolder;
    await writeFile(join(a.dir, "writer.lock"), JSON.stringify({ ...lock, heartbeatAt: "yesterday" }), "utf8");
    const tw = await other.store.takeover(PLAN_ID, other.holder("session-b"), "bad heartbeat");
    await tw.close();
  });

  it("a takeover with an `adopt` reason replaces a live lock", async () => {
    const root = await newRoot();
    const a = await mk({ root, pid: 100 });
    const b = await mk({ root, pid: 200, clock: a.clock });
    b.proc.alive.add(100);
    const w = await a.store.create(buildDraft(1), a.holder("session-a"));
    const tw = await b.store.takeover(PLAN_ID, b.holder("session-b"), "adopt: new orchestrator");
    expect((await readJson(join(b.dir, "writer.lock")) as LockHolder).sessionID).toBe("session-b");
    expect((await failure(w.append([addTask("late")]))).code).toBe("E_LOCK_LOST");
    await tw.close();
  });

  it("two simultaneous takeovers: exactly one wins, the other is refused", async () => {
    const root = await newRoot();
    const a = await mk({ root, pid: 100 });
    const b = await mk({ root, pid: 200, clock: a.clock });
    const c = await mk({ root, pid: 300, clock: a.clock });
    await a.store.create(buildDraft(1), a.holder("session-a"));
    const results = await Promise.allSettled([
      b.store.takeover(PLAN_ID, b.holder("session-b"), "race"),
      c.store.takeover(PLAN_ID, c.holder("session-c"), "race"),
    ]);
    const won = results.filter((r): r is PromiseFulfilledResult<LedgerWriter> => r.status === "fulfilled");
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0]?.reason as ExecutorError).code).toBe("E_LOCK_HELD");
    const holder = (await readJson(join(a.dir, "writer.lock"))) as LockHolder;
    expect([200, 300]).toContain(holder.pid);
    await won[0]?.value.close();
  });

  it("a leftover takeover guard blocks a taker until it is older than 15 s", async () => {
    const root = await newRoot();
    const a = await mk({ root, pid: 100 });
    const b = await mk({ root, pid: 200, clock: a.clock });
    await a.store.create(buildDraft(1), a.holder("session-a"));
    await writeFile(join(a.dir, "writer.lock.guard"), "{}", "utf8");
    const guardMtime = Date.now();
    a.clock.set(guardMtime); // the guard was just written
    const err = await failure(b.store.takeover(PLAN_ID, b.holder("session-b"), "r"));
    expect(err.code).toBe("E_LOCK_HELD");
    expect(err.message).toMatch(/another takeover/);
    a.clock.set(guardMtime + 16_000);
    const tw = await b.store.takeover(PLAN_ID, b.holder("session-b"), "r");
    expect(await ls(a.dir)).not.toContain("writer.lock.guard");
    await tw.close();
  });

  it("a stale guard that is re-claimed by someone else in between still refuses", async () => {
    const root = await newRoot();
    const a = await mk({ root, pid: 100 });
    let claimed = false;
    let claims = 0;
    const hook: FsInterceptor = async (call) => {
      // The second exclusive create of the guard (after the stale one was removed) loses to another taker.
      if (call.op === "writeText" && /writer\.lock\.guard$/.test(call.path)) {
        claims++;
        if (claims === 2) {
          claimed = true;
          await realFs.writeText(call.path, "{}", { exclusive: true });
        }
      }
    };
    const b = await mk({ root, pid: 200, clock: a.clock, fs: interceptFs(realFs, hook) });
    await a.store.create(buildDraft(1), a.holder("session-a"));
    await writeFile(join(a.dir, "writer.lock.guard"), "{}", "utf8");
    a.clock.set(Date.now() + 60_000);
    const err = await failure(b.store.takeover(PLAN_ID, b.holder("session-b"), "r"));
    expect(err.code).toBe("E_LOCK_HELD");
    expect(claimed).toBe(true);
  });

  it("a torn lock file names no holder and is stale once its mtime is older than staleMs", async () => {
    const root = await newRoot();
    const a = await mk({ root, pid: 100 });
    const b = await mk({ root, pid: 200, clock: a.clock });
    const w = await a.store.create(buildDraft(1), a.holder("session-a"));
    await w.close();
    await writeFile(join(a.dir, "writer.lock"), "{\"pid\":10", "utf8");
    a.clock.set(Date.now());
    const fresh = await failure(b.store.open(PLAN_ID, b.holder("session-b")));
    expect(fresh.message).toContain("unknown holder");
    expect(fresh.message).not.toMatch(/stale/);
    expect((await failure(b.store.takeover(PLAN_ID, b.holder("session-b"), "r"))).code).toBe("E_LOCK_HELD");
    a.clock.set(Date.now() + 61_000);
    expect((await failure(b.store.open(PLAN_ID, b.holder("session-b")))).message).toMatch(/stale/);
    const tw = await b.store.takeover(PLAN_ID, b.holder("session-b"), "torn lock");
    expect(tw.ledger.seq).toBe(2);
    await tw.close();
  });

  it("a lock file of the wrong shape names no holder", async () => {
    const root = await newRoot();
    const a = await mk({ root, pid: 100 });
    const w = await a.store.create(buildDraft(1), a.holder("session-a"));
    await w.close();
    for (const text of ["[1]", "\"str\"", JSON.stringify({ pid: "x", hostname: "h", sessionID: "s", startedAt: T0, heartbeatAt: T0 }),
      JSON.stringify({ pid: 1, hostname: "h", sessionID: "s", startedAt: 5, heartbeatAt: T0 })]) {
      await writeFile(join(a.dir, "writer.lock"), text, "utf8");
      expect((await failure(a.store.open(PLAN_ID, a.holder("s2")))).message).toContain("unknown holder");
    }
  });

  it("readers are never blocked: read, list and exportPlan work while a writer holds the lock and is stuck mid-append", async () => {
    const g = gate();
    const hook: FsInterceptor = async (call) => {
      if (call.op === "appendText" && /events\.1\.jsonl$/.test(call.path) && (call.data ?? "").includes("\"T9\"")) {
        g.markReached();
        await g.wait;
      }
    };
    const root = await newRoot();
    const w = await mk({ root, fs: interceptFs(realFs, hook) });
    const reader = await mk({ root, pid: 200, clock: w.clock });
    const writer = await w.store.create(buildDraft(1), w.holder("session-a"));
    await writer.append([addTask("T8")]);
    const pending = writer.append([addTask("T9")]);
    await g.reached; // the writer holds the lock and is inside its append
    expect((await reader.store.read(PLAN_ID)).seq).toBe(2); // the fsynced state; the stuck batch is not visible
    expect((await reader.store.list()).map((p) => p.seq)).toEqual([2]);
    expect((await reader.store.exportPlan(PLAN_ID)).snapshot.seq).toBe(2);
    g.open();
    await pending;
    expect((await reader.store.read(PLAN_ID)).seq).toBe(3);
    await writer.close();
  });

  it("remove: only completed or aborted plans, never under a live writer, a stale lock is cleared", async () => {
    const root = await newRoot();
    const a = await mk({ root, pid: 100 });
    const b = await mk({ root, pid: 200, clock: a.clock });
    b.proc.alive.add(100);
    const w = await a.store.create(buildDraft(1), a.holder("session-a"));
    expect((await failure(b.store.remove(PLAN_ID))).code).toBe("E_LOCK_HELD"); // live writer elsewhere
    await w.append([{ type: "status-changed", from: "running", to: "completed", reason: "done" }]);
    expect((await failure(b.store.remove(PLAN_ID))).code).toBe("E_LOCK_HELD");
    b.proc.alive.delete(100); // the writer died with the lock still on disk
    expect(await b.store.remove(PLAN_ID)).toBe(true);
    expect(await readdir(b.home)).toEqual([]);
    expect(await b.store.remove(PLAN_ID)).toBe(false);
  });

  it("remove refuses a running plan with E_PLAN_STATE and releases its own lock", async () => {
    const e = await mk();
    const w = await e.store.create(buildDraft(1), e.holder("s1"));
    await w.close();
    const err = await failure(e.store.remove(PLAN_ID));
    expect(err.code).toBe("E_PLAN_STATE");
    expect(err.detail).toEqual({ planId: PLAN_ID, status: "running" });
    expect(await ls(e.dir)).not.toContain("writer.lock");
  });

  it("remove deletes a half-created plan directory (no ledger) and an aborted plan", async () => {
    const e = await mk();
    await mkdir(e.dir, { recursive: true });
    expect(await e.store.remove(PLAN_ID)).toBe(true);
    const w = await e.store.create(buildDraft(1), e.holder("s1"));
    await w.append([{ type: "status-changed", from: "running", to: "aborted", reason: "stop" }]);
    await w.close();
    expect(await e.store.remove(PLAN_ID)).toBe(true);
  });

  it("remove surfaces a corrupt plan instead of deleting it", async () => {
    const e = await mk();
    await plant(e.home, [initLine(buildDraft(1)), "garbage", eventLine(addTask("A"), 3, 3, true)]);
    expect((await failure(e.store.remove(PLAN_ID))).code).toBe("E_SEQ_GAP");
    expect(await ls(e.dir)).toEqual(["events.1.jsonl"]);
  });

  it("takeover is journaled in the history copy of the plan's events only through the main journal (export merges both)", async () => {
    const root = await newRoot();
    const a = await mk({ root, pid: 100 });
    const b = await mk({ root, pid: 200, clock: a.clock });
    const w = await a.store.create(buildDraft(1), a.holder("session-a"));
    await w.append([metric(1)]);
    const tw = await b.store.takeover(PLAN_ID, b.holder("session-b"), "dead");
    const { events } = await b.store.exportPlan(PLAN_ID);
    expect(events.map((x) => x.type)).toEqual(["metric", "lock-takeover"]);
    await tw.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Production seams (real clock, real process table, real files)
// ---------------------------------------------------------------------------------------------------------------

describe("production defaults", () => {
  it("createNodeClock: now/iso/randomHex, timers fire and clear, and an unref'd timer never keeps the process alive", async () => {
    const c = createNodeClock();
    expect(Math.abs(c.now() - Date.now())).toBeLessThan(5_000);
    expect(c.iso(0)).toBe("1970-01-01T00:00:00.000Z");
    expect(c.iso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const a = c.randomHex(4);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(c.randomHex(4)).not.toBe(a);
    // The timer callback is awaited, not slept on.
    await new Promise<void>((resolve) => {
      const h = c.setTimer(1, resolve);
      expect(h.id).toBeGreaterThan(0);
    });
    let fired = false;
    const h = c.setTimer(5_000, () => {
      fired = true;
    });
    c.clearTimer(h);
    c.clearTimer(h); // clearing twice is harmless
    expect(fired).toBe(false);
  });

  it("a store built with only `home` works on the real clock, real files and real process table, and takes over from a dead pid", async () => {
    const root = await newRoot();
    const home = join(root, "omr-executor");
    const store = createLedgerStore({ home });
    const me: LockHolder = holderOf("real-1", process.pid, hostname());
    const w = await store.create(buildDraft(2), me);
    await w.append([addTask("A")]);
    expect((await store.read(PLAN_ID)).seq).toBe(2);
    // Our own pid is alive: a second open is refused and not called stale.
    const held = await failure(store.open(PLAN_ID, holderOf("real-2", process.pid, hostname())));
    expect(held.code).toBe("E_LOCK_HELD");
    expect(held.message).not.toMatch(/stale/);
    await w.close();

    // A pid that was alive a moment ago and is gone now, on this host.
    const dead = spawnSync(process.execPath, ["-e", "0"]);
    const deadPid = dead.pid;
    expect(deadPid).toBeGreaterThan(0);
    const w2 = await store.open(PLAN_ID, holderOf("dead-owner", deadPid, hostname()));
    await w2.append([addTask("B")]);
    // w2 is "crashed": its lock names a dead pid.
    const stale = await failure(store.open(PLAN_ID, me));
    expect(stale.message).toMatch(/stale/);
    const w3 = await store.takeover(PLAN_ID, me, "owner pid is gone");
    expect(Object.keys(w3.ledger.tasks)).toEqual(["T1", "T2", "A", "B"]);
    await w3.close();
  });

  it("the node FileSystem: exclusive create, append, rm, readdir, lstat kinds and fsyncDir", async () => {
    const root = await newRoot();
    const p = join(root, "f.txt");
    await realFs.mkdir(join(root, "sub", "deep"));
    await realFs.writeText(p, "a", { exclusive: true, fsync: true });
    await expect(realFs.writeText(p, "b", { exclusive: true })).rejects.toMatchObject({ code: "EEXIST" });
    await realFs.appendText(p, "b", { fsync: true });
    await realFs.appendText(p, "c", { fsync: false });
    await realFs.writeText(join(root, "g.txt"), "plain");
    expect(await realFs.readText(p)).toBe("abc");
    expect((await realFs.readdir(root)).sort()).toEqual(["f.txt", "g.txt", "sub"]);
    expect((await realFs.lstat(p))?.kind).toBe("file");
    expect((await realFs.lstat(join(root, "sub")))?.kind).toBe("dir");
    expect(await realFs.lstat(join(root, "missing"))).toBeNull();
    expect(await realFs.realpath(root)).toBeTruthy();
    await realFs.fsyncDir(root);
    await realFs.fsyncDir(join(root, "missing-dir")).then(
      () => undefined,
      (e: unknown) => {
        expect((e as { code?: string }).code).toBe("ENOENT");
      },
    );
    await realFs.rm(p, { recursive: false });
    await realFs.rm(join(root, "sub"), { recursive: true });
    await realFs.rm(join(root, "never-existed"), { recursive: false });
    expect((await realFs.readdir(root)).sort()).toEqual(["g.txt"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Replay of every event type: per-event preconditions, batch-end invariants, atomic failure
// ---------------------------------------------------------------------------------------------------------------

const SHA1 = "a".repeat(40);
const SHA2 = "b".repeat(40);

/** A running ledger with a task in each interesting state and two phases (p1 pending, p2 awaiting-qa). */
function richDraft(): LedgerV1 {
  const d = buildDraft(0);
  d.waves = [{ id: "w1", phases: ["p1", "p2"] }];
  d.phases = [
    { id: "p1", title: "Phase 1", wave: "w1", dependsOn: [], gate: "pending", qaRound: 1, paused: false, tag: null },
    { id: "p2", title: "Phase 2", wave: "w1", dependsOn: [], gate: "awaiting-qa", qaRound: 1, paused: false, tag: null },
  ];
  const ended = { endedAt: T0, outcome: "succeeded" as const };
  d.tasks = {
    A: taskNode("A"),
    B: taskNode("B", { state: "ready" }),
    D: taskNode("D", { state: "dispatched", slot: "slot-d", attempts: [openAttempt(1)] }),
    R: taskNode("R", { state: "running", slot: "slot-r", attempts: [{ ...openAttempt(1), childSessionID: "ses-r" }] }),
    V: taskNode("V", {
      state: "verifying",
      slot: "slot-v",
      branch: `omr/${PLAN_ID}/t/V`,
      attempts: [{ ...openAttempt(1), ...ended }],
    }),
    L: taskNode("L", { state: "ready", attempts: [{ ...openAttempt(1), endedAt: T0, outcome: "lost" }] }),
    I: taskNode("I", {
      state: "integrating",
      slot: "slot-i",
      branch: `omr/${PLAN_ID}/t/I`,
      attempts: [{ ...openAttempt(1), ...ended, verdict: "pass" }],
    }),
  };
  d.edges = [{ from: "A", to: "B", kind: "structural", confidence: "high", evidence: "order" }];
  return d;
}

type Batch = ExecutorEventInput[] | ((l: Readonly<LedgerV1>) => ExecutorEventInput[]);

const entryOf = (id: string, over: Partial<{ kind: "task" | "batch"; taskIds: string[]; candidate: string | null }> = {}) => ({
  id,
  kind: over.kind ?? ("task" as const),
  phaseId: "p1",
  taskIds: over.taskIds ?? ["I"],
  slot: "slot-i",
  baseHead: SHA1,
  candidate: over.candidate ?? null,
});

function step(
  edge: "start" | "end",
  id: string,
  stepName: "rebase" | "checks" | "fast-forward",
  over: { result?: "ok" | "failed" | null; closes?: boolean; kind?: "task" | "batch"; taskIds?: string[]; candidate?: string | null } = {},
): ExecutorEventInput {
  return {
    type: "integration-step",
    edge,
    entry: entryOf(id, over),
    step: stepName,
    result: over.result === undefined ? (edge === "end" ? "ok" : null) : over.result,
    detail: null,
    failingIds: [],
    closes: over.closes ?? false,
  };
}

const inboxItem = (id: string, kind: "question" | "failure" | "qa-cap", extra: Partial<{ severity: "info" | "blocking" | "critical"; options: string[] }> = {}) => ({
  id,
  kind,
  severity: extra.severity ?? ("blocking" as const),
  taskId: null,
  text: "text",
  options: extra.options ?? [],
  answer: null,
  createdAt: T0,
});

const gateChange = (
  phaseId: string,
  from: "pending" | "awaiting-qa" | "qa-running" | "suite-running",
  to: "pending" | "awaiting-qa" | "qa-running" | "suite-running" | "passed",
  trigger: "phase-integrated" | "qa-dispatched" | "qa-next-round" | "qa-clean" | "cap-fix" | "qa-cap" | "qa-requeued",
  qaRound: number,
): ExecutorEventInput => ({ type: "gate-changed", phaseId, from, to, trigger, qaRound });

const ILLEGAL: Array<[string, Batch, string]> = [
  ["status-from-mismatch", [{ type: "status-changed", from: "paused", to: "running", reason: "x" }], "status-from-mismatch"],
  ["status-illegal", [{ type: "status-changed", from: "running", to: "awaiting-approval", reason: "x" }], "status-illegal"],
  [
    "draft-replaced-status",
    [{ type: "draft-replaced", draft: { planDigest: "cd".repeat(32), sharedContext: "", waves: [], phases: [], tasks: {}, edges: [] } }],
    "draft-replaced-status",
  ],
  ["approve-status", [{ type: "plan-approved", config: buildDraft(0).config, by: "user" }], "approve-status"],
  ["task-exists", [addTask("A")], "task-exists"],
  ["task-created-state", [{ type: "task-created", task: taskNode("N", { state: "running" }) }], "task-created-state"],
  ["task-created-attempts", [{ type: "task-created", task: taskNode("N", { attempts: [openAttempt(1)] }) }], "task-created-attempts"],
  ["task-created-slot", [{ type: "task-created", task: taskNode("N", { slot: "s" }) }], "task-created-slot"],
  ["edge-endpoint", [{ type: "edge-added", edge: { from: "NOPE", to: "A", kind: "explicit", confidence: "high", evidence: "x" } }], "edge-endpoint"],
  ["edge-endpoint (gate)", [{ type: "edge-added", edge: { from: "gate:zzz", to: "A", kind: "explicit", confidence: "high", evidence: "x" } }], "edge-endpoint"],
  ["task-missing", [transition("NOPE", "pending", "ready", "deps-satisfied")], "task-missing"],
  ["transition-from-mismatch", [transition("A", "ready", "dispatched", "launch")], "transition-from-mismatch"],
  ["transition-illegal", [transition("A", "pending", "running", "adopt")], "transition-illegal"],
  ["transition-trigger", [transition("A", "pending", "ready", "launch")], "transition-trigger"],
  ["attempt-started-state", [{ type: "attempt-started", taskId: "A", attempt: openAttempt(1) }], "attempt-started-state"],
  ["attempt-started on a missing task", [{ type: "attempt-started", taskId: "NOPE", attempt: openAttempt(1) }], "task-missing"],
  ["attempt-n", [{ type: "attempt-started", taskId: "B", attempt: openAttempt(5) }], "attempt-n"],
  ["attempt-open-shape", [{ type: "attempt-started", taskId: "B", attempt: { ...openAttempt(1), context: "x" } }], "attempt-open-shape"],
  ["attempt-nonce-reused", [{ type: "attempt-started", taskId: "L", attempt: { ...openAttempt(2), nonce: openAttempt(1).nonce } }], "attempt-nonce-reused"],
  ["attempt-child-state", [{ type: "attempt-child", taskId: "R", n: 1, childSessionID: "x" }], "attempt-child-state"],
  ["attempt-child-target", [{ type: "attempt-child", taskId: "D", n: 2, childSessionID: "x" }], "attempt-child-target"],
  ["attempt-adopted-state", [{ type: "attempt-adopted", taskId: "D", n: 1, childSessionID: "x" }], "attempt-adopted-state"],
  ["attempt-adopted-target", [{ type: "attempt-adopted", taskId: "B", n: 1, childSessionID: "x" }], "attempt-adopted-target"],
  ["attempt-ended-state", [{ type: "attempt-ended", taskId: "B", n: 1, outcome: "failed", endedAt: T0, detail: null }], "attempt-ended-state"],
  ["attempt-ended-target", [{ type: "attempt-ended", taskId: "R", n: 2, outcome: "failed", endedAt: T0, detail: null }], "attempt-ended-target"],
  ["attempt-verdict-state", [{ type: "attempt-verdict", taskId: "R", n: 1, verdict: "pass", ref: null }], "attempt-verdict-state"],
  ["attempt-verdict-target", [{ type: "attempt-verdict", taskId: "V", n: 2, verdict: "pass", ref: null }], "attempt-verdict-target"],
  ["attempt-context-target", [{ type: "attempt-context", taskId: "R", n: 5, context: "x" }], "attempt-context-target"],
  ["attempt-context on a missing task", [{ type: "attempt-context", taskId: "NOPE", n: 1, context: "x" }], "task-missing"],
  ["task-slot on a missing task", [{ type: "task-slot", taskId: "NOPE", slot: null, branch: null }], "task-missing"],
  ["task-footprint on a missing task", [{ type: "task-footprint", taskId: "NOPE", footprint: taskNode("x").footprint }], "task-missing"],
  ["task-integrated on a missing task", [{ type: "task-integrated", taskId: "NOPE", from: SHA1, to: SHA2 }], "task-missing"],
  [
    "footprint-not-monotone",
    [{ type: "task-footprint", taskId: "A", footprint: { ...taskNode("A").footprint, writes: [] } }],
    "footprint-not-monotone",
  ],
  ["task-integrated-state", [{ type: "task-integrated", taskId: "R", from: SHA1, to: SHA2 }], "task-integrated-state"],
  ["gate-from-mismatch", [gateChange("p2", "pending", "awaiting-qa", "phase-integrated", 1)], "gate-from-mismatch"],
  ["gate-illegal", [gateChange("p2", "awaiting-qa", "suite-running", "phase-integrated", 1)], "gate-illegal"],
  ["gate-trigger", [gateChange("p2", "awaiting-qa", "qa-running", "qa-clean", 1)], "gate-trigger"],
  ["gate-qa-round", [gateChange("p2", "awaiting-qa", "pending", "cap-fix", 1)], "gate-qa-round"],
  ["gate phase-missing", [gateChange("zzz", "pending", "awaiting-qa", "phase-integrated", 1)], "phase-missing"],
  ["phase-paused phase-missing", [{ type: "phase-paused", phaseId: "zzz", paused: true, reason: "x" }], "phase-missing"],
  ["phase-paused-unchanged", [{ type: "phase-paused", phaseId: "p1", paused: false, reason: "x" }], "phase-paused-unchanged"],
  ["phase-tagged phase-missing", [{ type: "phase-tagged", phaseId: "zzz", tag: "t" }], "phase-missing"],
  ["inbox-id (wrong prefix)", [{ type: "inbox-added", item: inboxItem("F-1", "question") }], "inbox-id"],
  ["inbox-id (malformed)", [{ type: "inbox-added", item: inboxItem("Q-01", "question") }], "inbox-id"],
  ["inbox-missing", [{ type: "inbox-answered", id: "Q-9", answer: "x" }], "inbox-missing"],
  ["unknown-event-type", [{ type: "from-the-future" } as unknown as ExecutorEventInput], "unknown-event-type"],
  ["ledger-init-not-first", [{ type: "ledger-init", ledger: buildDraft(1) }], "ledger-init-not-first"],
  ["entry-not-open (end)", (l) => [step("end", `i-${l.seq + 1}`, "rebase")], "entry-not-open"],
  ["entry-id-mismatch", [step("start", "i-999", "rebase")], "entry-id-mismatch"],
  ["closes-on-start", (l) => [step("start", `i-${l.seq + 1}`, "rebase", { closes: true })], "closes-on-start"],
  [
    "entry-fixed-field-changed",
    (l) => [step("start", `i-${l.seq + 1}`, "rebase"), step("end", `i-${l.seq + 1}`, "rebase", { kind: "batch" })],
    "entry-fixed-field-changed",
  ],
  [
    "step-start-before-end",
    (l) => [step("start", `i-${l.seq + 1}`, "rebase"), step("start", `i-${l.seq + 1}`, "checks")],
    "step-start-before-end",
  ],
  [
    "end-without-matching-start",
    (l) => [step("start", `i-${l.seq + 1}`, "rebase"), step("end", `i-${l.seq + 1}`, "checks")],
    "end-without-matching-start",
  ],
  [
    "closes-on-start (second start)",
    (l) => [step("start", `i-${l.seq + 1}`, "rebase"), step("end", `i-${l.seq + 1}`, "rebase"), step("start", `i-${l.seq + 1}`, "checks", { closes: true })],
    "closes-on-start",
  ],
];

describe("replay: every precondition refuses an illegal event and writes nothing", () => {
  it.each(ILLEGAL)("%s", async (_name, batch, code) => {
    const e = await mk();
    const w = await e.store.create(richDraft(), e.holder("s1"));
    const before = { ledger: clone(w.ledger), journal: await readFile(join(e.dir, "events.1.jsonl"), "utf8") };
    const err = await failure(w.append(batch));
    expect(err.code).toBe("E_ILLEGAL_TRANSITION");
    expect((err.detail as { codes: string[] }).codes).toEqual([code]);
    expect(err.message).toContain(code);
    expect(w.ledger).toEqual(before.ledger);
    expect(await readFile(join(e.dir, "events.1.jsonl"), "utf8")).toBe(before.journal);
    // And the writer is still usable.
    await w.append([addTask("after")]);
    expect(w.ledger.seq).toBe(2);
  });

  it("a bad event later in a batch discards the whole batch", async () => {
    const e = await mk();
    const w = await e.store.create(richDraft(), e.holder("s1"));
    const err = await failure(w.append([addTask("good"), addTask("A")]));
    expect((err.detail as { batchIndex: number; eventIndex: number }).eventIndex).toBe(1);
    expect(w.ledger.tasks.good).toBeUndefined();
    expect(w.ledger.seq).toBe(1);
  });

  it("a batch that leaves the ledger invalid names the batch-end codes and writes nothing", async () => {
    const e = await mk();
    const w = await e.store.create(richDraft(), e.holder("s1"));
    const err = await failure(w.append([transition("A", "pending", "ready", "deps-satisfied"), transition("A", "ready", "dispatched", "launch")]));
    expect(err.message).toMatch(/leaves the ledger invalid/);
    const detail = err.detail as { eventIndex: number | null; codes: string[] };
    expect(detail.eventIndex).toBeNull();
    expect(detail.codes.some((c) => c.startsWith("open-attempt@"))).toBe(true);
    expect(detail.codes.some((c) => c.startsWith("slot-required@"))).toBe(true);
    expect(w.ledger.tasks.A?.state).toBe("pending");
  });

  it("a second inbox item must have a greater number than every existing one", async () => {
    const e = await mk();
    const w = await e.store.create(richDraft(), e.holder("s1"));
    await w.append([{ type: "inbox-added", item: inboxItem("Q-5", "question") }]);
    const err = await failure(w.append([{ type: "inbox-added", item: inboxItem("F-3", "failure") }]));
    expect((err.detail as { codes: string[] }).codes).toEqual(["inbox-id-not-increasing"]);
    await w.append([{ type: "inbox-added", item: inboxItem("F-6", "failure") }]);
    expect(w.ledger.inbox.map((i) => i.id)).toEqual(["Q-5", "F-6"]);
  });

  it("an answer to a critical qa-cap item must be one of its options; an item is answered once", async () => {
    const e = await mk();
    const w = await e.store.create(richDraft(), e.holder("s1"));
    await w.append([{ type: "inbox-added", item: inboxItem("R-1", "qa-cap", { severity: "critical", options: ["accept", "fix"] }) }]);
    const bad = await failure(w.append([{ type: "inbox-answered", id: "R-1", answer: "shrug" }]));
    expect((bad.detail as { codes: string[] }).codes).toEqual(["inbox-answer-option"]);
    await w.append([{ type: "inbox-answered", id: "R-1", answer: "fix" }]);
    const twice = await failure(w.append([{ type: "inbox-answered", id: "R-1", answer: "accept" }]));
    expect((twice.detail as { codes: string[] }).codes).toEqual(["inbox-already-answered"]);
    expect(w.ledger.inbox[0]?.answer).toBe("fix");
  });
});

describe("replay: legal lifecycles are applied, persisted and reloaded identically", () => {
  it("every task-level event type, through dispatch, run, verify and integration", async () => {
    const e = await mk();
    const w = await e.store.create(richDraft(), e.holder("s1"));
    // pending -> ready
    await w.append([transition("A", "pending", "ready", "deps-satisfied")]);
    // dispatch: attempt, slot and the durable transition are one batch
    await w.append([
      { type: "attempt-started", taskId: "A", attempt: openAttempt(1) },
      { type: "task-slot", taskId: "A", slot: "slot-a", branch: `omr/${PLAN_ID}/t/A` },
      transition("A", "ready", "dispatched", "launch"),
    ]);
    await w.append([{ type: "attempt-child", taskId: "A", n: 1, childSessionID: "ses-a" }]);
    await w.append([transition("A", "dispatched", "running", "child-created")]);
    await w.append([
      { type: "attempt-ended", taskId: "A", n: 1, outcome: "succeeded", endedAt: T0, detail: null },
      transition("A", "running", "completed", "child-ended"),
    ]);
    await w.append([{ type: "attempt-context", taskId: "A", n: 1, context: "feedback" }, transition("A", "completed", "verifying", "committed")]);
    await w.append([{ type: "attempt-verdict", taskId: "A", n: 1, verdict: "pass", ref: "r1" }]);
    await w.append([transition("A", "verifying", "verified", "verify-pass")]);
    await w.append((l) => [
      step("start", `i-${l.seq + 1}`, "rebase"),
      transition("A", "verified", "integrating", "dequeued"),
    ]);
    const entryId = `i-${w.ledger.seq - 1}`;
    expect(w.openIntegration().map((o) => [o.entry.id, o.step, o.edge, o.result])).toEqual([[entryId, "rebase", "start", null]]);
    await w.append([step("end", entryId, "rebase"), step("start", entryId, "fast-forward", { candidate: SHA2 })]);
    await w.append([
      step("end", entryId, "fast-forward", { candidate: SHA2, closes: true }),
      { type: "task-integrated", taskId: "A", from: SHA1, to: SHA2 },
      { type: "integration-head", head: SHA2 },
      { type: "task-slot", taskId: "A", slot: null, branch: `omr/${PLAN_ID}/t/A` },
      transition("A", "integrating", "integrated", "fast-forwarded"),
    ]);
    expect(w.openIntegration()).toEqual([]);
    const a = w.ledger.tasks.A;
    expect(a?.state).toBe("integrated");
    expect(a?.integrated).toEqual({ from: SHA1, to: SHA2 });
    expect(a?.attempts[0]).toMatchObject({ outcome: "succeeded", verdict: "pass", context: "feedback", childSessionID: "ses-a" });
    expect(w.ledger.integration.head).toBe(SHA2);

    // the adopted-attempt path: a lost attempt continues when its late child shows up
    await w.append([
      { type: "attempt-adopted", taskId: "L", n: 1, childSessionID: "ses-late" },
      { type: "task-slot", taskId: "L", slot: "slot-l", branch: null },
      transition("L", "ready", "running", "adopt"),
    ]);
    expect(w.ledger.tasks.L).toMatchObject({ state: "running" });
    expect(w.ledger.tasks.L?.attempts[0]).toMatchObject({ outcome: null, endedAt: null, childSessionID: "ses-late" });

    // dispatched -> ready again, footprint growth, edge between a gate and a task
    await w.append([
      { type: "attempt-ended", taskId: "D", n: 1, outcome: "lost", endedAt: T0, detail: null },
      { type: "task-slot", taskId: "D", slot: null, branch: null },
      transition("D", "dispatched", "ready", "launch-lost"),
    ]);
    await w.append([{ type: "task-footprint", taskId: "B", footprint: { ...taskNode("B").footprint, writes: ["src/a.ts", "src/b.ts"], reads: ["README.md", "x.md"] } }]);
    await w.append([{ type: "edge-added", edge: { from: "gate:p1", to: "B", kind: "explicit", confidence: "low", evidence: "e" } }]);
    expect(w.ledger.tasks.B?.footprint.writes).toEqual(["src/a.ts", "src/b.ts"]);
    expect(w.ledger.edges).toHaveLength(2);

    await w.close();
    expect(await e.store.read(PLAN_ID)).toEqual(w.ledger);
  });

  it("plan-level events: status, orchestrator, phases and gates, inbox, wake and metric", async () => {
    const e = await mk();
    const draft = richDraft();
    delete draft.tasks.I; // an integrating task would make a reopen demand an open integration entry
    const w = await e.store.create(draft, e.holder("s1"));
    await w.append([{ type: "orchestrator-bound", sessionID: "ses-new", reason: "adopt" }]);
    expect(w.ledger.orchestrator.sessionID).toBe("ses-new");
    await w.append([{ type: "status-changed", from: "running", to: "paused", reason: "user" }]);
    await w.append([{ type: "status-changed", from: "paused", to: "running", reason: "user" }]);
    await w.append([{ type: "phase-paused", phaseId: "p1", paused: true, reason: "r" }, { type: "phase-tagged", phaseId: "p1", tag: "v1" }]);
    expect(w.ledger.phases[0]).toMatchObject({ paused: true, tag: "v1" });
    await w.append([gateChange("p2", "awaiting-qa", "pending", "cap-fix", 2)]);
    await w.append([gateChange("p2", "pending", "awaiting-qa", "phase-integrated", 2)]);
    await w.append([{ type: "gate-changed", phaseId: "p2", from: "awaiting-qa", to: "passed", trigger: "no-open-qa", qaRound: 2 }]);
    expect(w.ledger.phases[1]).toMatchObject({ gate: "passed", qaRound: 2 });
    await w.append([gateChange("p1", "pending", "awaiting-qa", "phase-integrated", 1)]);
    await w.append([gateChange("p1", "awaiting-qa", "pending", "cap-fix", 2)]);
    expect(w.ledger.phases[0]).toMatchObject({ gate: "pending", qaRound: 2 });
    await w.append([
      { type: "inbox-added", item: inboxItem("Q-1", "question") },
      { type: "inbox-answered", id: "Q-1", answer: "yes" },
    ]);
    expect(w.ledger.inbox[0]?.answer).toBe("yes");
    await w.append([{ type: "wake", reason: "inbox", stateKey: "k-1" }, metric(1), { type: "wake", reason: "manual-ready", stateKey: "k-2" }]);
    expect([...w.wakeKeys()].sort()).toEqual(["k-1", "k-2"]);

    await w.close();
    expect(await e.store.read(PLAN_ID)).toEqual(w.ledger);
    const again = await e.store.open(PLAN_ID, e.holder("s2"));
    // the wake keys are rebuilt from the history journal
    expect([...again.wakeKeys()].sort()).toEqual(["k-1", "k-2"]);
    await again.close();
  });

  it("draft-replaced and plan-approved before the plan runs", async () => {
    const e = await mk();
    const draft = buildDraft(2);
    draft.status = "awaiting-approval";
    draft.config.slotsDir = null;
    const w = await e.store.create(draft, e.holder("s1"));
    const replaced = clone(buildDraft(3));
    await w.append([
      {
        type: "draft-replaced",
        draft: {
          planDigest: "cd".repeat(32),
          sharedContext: "new context",
          waves: replaced.waves,
          phases: replaced.phases,
          tasks: replaced.tasks,
          edges: replaced.edges,
        },
      },
    ]);
    expect(Object.keys(w.ledger.tasks)).toEqual(["T1", "T2", "T3"]);
    expect(w.ledger.sharedContext).toBe("new context");

    // approval without the status change that follows it is refused at the batch end
    const approved = { ...w.ledger.config, slotsDir: "C:/slots" };
    const half = await failure(w.append([{ type: "plan-approved", config: approved, by: "user" }]));
    expect((half.detail as { codes: string[] }).codes).toEqual(["plan-approved-without-running"]);
    // a null slotsDir is refused at the event
    const nullDir = await failure(w.append([{ type: "plan-approved", config: { ...approved, slotsDir: null }, by: "user" }]));
    expect((nullDir.detail as { codes: string[] }).codes).toEqual(["approve-slots-dir"]);

    await w.append([
      { type: "plan-approved", config: approved, by: "user" },
      { type: "status-changed", from: "awaiting-approval", to: "running", reason: "approved" },
    ]);
    expect(w.ledger.status).toBe("running");
    expect(w.ledger.config.slotsDir).toBe("C:/slots");
    await w.close();
    expect((await e.store.read(PLAN_ID)).config.slotsDir).toBe("C:/slots");
  });

  it("a builder sees the ledger the batch applies to; an empty batch or builder writes nothing", async () => {
    const e = await mk();
    const w = await e.store.create(buildDraft(1), e.holder("s1"));
    const seen: number[] = [];
    await w.append((l) => {
      seen.push(l.seq);
      return [addTask("A")];
    });
    await w.append((l) => {
      seen.push(l.seq);
      return [addTask(`B${l.seq}`)];
    });
    expect(seen).toEqual([1, 2]);
    const journal = await readFile(join(e.dir, "events.1.jsonl"), "utf8");
    expect(await w.append([])).toBe(w.ledger);
    expect(await w.append(() => [])).toBe(w.ledger);
    expect(await readFile(join(e.dir, "events.1.jsonl"), "utf8")).toBe(journal);
  });

  it("concurrent appends are serialised in call order", async () => {
    const e = await mk();
    const w = await e.store.create(buildDraft(1), e.holder("s1"));
    await Promise.all([w.append([addTask("A")]), w.append([addTask("B")]), w.append([addTask("C")])]);
    expect(Object.keys(w.ledger.tasks)).toEqual(["T1", "A", "B", "C"]);
    expect(w.ledger.seq).toBe(4);
  });

  it("an event that cannot be serialised is E_INVALID_INPUT and writes nothing", async () => {
    const e = await mk();
    const w = await e.store.create(buildDraft(1), e.holder("s1"));
    const bad = { type: "metric", metric: { name: "counter", key: "k", value: 1n, labels: {} } } as unknown as ExecutorEventInput;
    const err = await failure(w.append([metric(1), bad]));
    expect(err.code).toBe("E_INVALID_INPUT");
    expect(err.detail).toEqual({ eventIndex: 1 });
    expect(w.ledger.seq).toBe(1);
  });

  it("an append after close is E_DISPOSED", async () => {
    const e = await mk();
    const w = await e.store.create(buildDraft(1), e.holder("s1"));
    await w.close();
    expect((await failure(w.append([addTask("A")]))).code).toBe("E_DISPOSED");
    expect((await failure(w.snapshot())).code).toBe("E_DISPOSED");
  });

  it("an integrating task without an open integration entry cannot be reopened", async () => {
    const e = await mk();
    const w = await e.store.create(richDraft(), e.holder("s1"));
    await w.close();
    const err = await failure(e.store.open(PLAN_ID, e.holder("s2")));
    expect(err.code).toBe("E_ILLEGAL_TRANSITION");
    expect(err.detail).toEqual({ taskId: "I", codes: ["integrating-without-entry"] });
    expect(await ls(e.dir)).not.toContain("writer.lock");
  });

  it("open integration entries and wake keys survive a close/open cycle through history.jsonl", async () => {
    const e = await mk();
    const w = await e.store.create(richDraft(), e.holder("s1"));
    await w.append([step("start", "i-2", "rebase", { taskIds: ["I"] }), { type: "wake", reason: "inbox", stateKey: "w1" }]);
    expect(w.openIntegration()).toHaveLength(1);
    await w.close();
    const again = await e.store.open(PLAN_ID, e.holder("s2"));
    expect(again.openIntegration().map((o) => [o.entry.id, o.entry.taskIds, o.step, o.edge])).toEqual([["i-2", ["I"], "rebase", "start"]]);
    expect([...again.wakeKeys()]).toEqual(["w1"]);
    await again.append([step("end", "i-2", "rebase"), step("start", "i-2", "checks", { taskIds: ["I", "I2"].slice(0, 1) })]);
    expect(again.openIntegration()[0]).toMatchObject({ step: "checks", edge: "start", result: null });
    await again.close();
    const { events } = await e.store.exportPlan(PLAN_ID);
    expect(events.map((x) => x.type)).toEqual(["integration-step", "wake", "integration-step", "integration-step"]);
    expect(events.map((x) => x.seq)).toEqual([2, 3, 4, 5]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Injected I/O faults
// ---------------------------------------------------------------------------------------------------------------

/** An interceptor that is switched on after the plan was created, so `create` itself is never faulted. */
function armable(fn: (call: FsCall) => ReturnType<FsInterceptor>): { hook: FsInterceptor; arm(): void; disarm(): void } {
  let armed = false;
  return {
    hook: (call) => (armed ? fn(call) : undefined),
    arm: () => {
      armed = true;
    },
    disarm: () => {
      armed = false;
    },
  };
}

const isSnapshotTmp = (p: string): boolean => /ledger\.json\.tmp-/.test(p);

describe("faults: journal, history, snapshot, heartbeat", () => {
  it("a failed journal write changes nothing in memory; the next append rotates past the torn bytes", async () => {
    let failNext = false;
    const hook: FsInterceptor = (call) => {
      if (failNext && call.op === "appendText" && /events\.\d+\.jsonl$/.test(call.path)) {
        failNext = false;
        return { writePartial: 12 };
      }
      return undefined;
    };
    const e = await mk({
      fs: interceptFs(realFs, hook, () => {
        throw fsError("EIO", "disk gone");
      }),
    });
    const w = await e.store.create(buildDraft(1), e.holder("s1"));
    await w.append([addTask("A")]);
    failNext = true;
    const err = await w.append([addTask("B")]).then(
      () => null,
      (x: unknown) => x as { code?: string },
    );
    expect(err?.code).toBe("EIO");
    expect(w.ledger.seq).toBe(2);
    expect(w.ledger.tasks.B).toBeUndefined();
    expect((await readFile(join(e.dir, "events.1.jsonl"), "utf8")).endsWith("\n")).toBe(false); // torn tail on disk

    await w.append([addTask("C")]);
    expect(await ls(e.dir)).toEqual(["events.3.jsonl", "history.jsonl", "ledger.json", "writer.lock"]);
    const seen = await e.store.read(PLAN_ID);
    expect(Object.keys(seen.tasks)).toEqual(["T1", "A", "C"]);
    expect(seen.seq).toBe(3);
    expect(e.warnings).toEqual([]);
  });

  it("a failed history copy is warned about and repaired by the next append; the main journal stays authoritative", async () => {
    let failures = 1;
    const f = armable((call) => {
      if (failures > 0 && call.op === "appendText" && /history\.jsonl$/.test(call.path)) {
        failures--;
        throw fsError("EIO");
      }
      return undefined;
    });
    const e = await mk({ fs: interceptFs(realFs, f.hook) });
    const w = await e.store.create(buildDraft(1), e.holder("s1"));
    f.arm();
    await w.append([metric(1)]);
    expect(e.warnings).toHaveLength(1);
    expect(e.warnings[0]).toMatch(/history copy for plan-one failed, will be repaired/);
    await w.append([metric(2)]);
    const lines = (await readLines(join(e.dir, "history.jsonl"))).map((l) => (JSON.parse(l) as ExecutorEvent).seq);
    expect(lines).toEqual([2, 3]);
    expect((await ls(e.dir)).filter((n) => n.includes(".tmp-"))).toEqual([]);
    const exported = (await e.store.exportPlan(PLAN_ID)).events;
    expect(exported.map((x) => [x.seq, x.type])).toEqual([[1, "ledger-init"], [2, "metric"], [3, "metric"]]);
  });

  it("a snapshot that fails inside append is only warned about, its temp file is removed, and it is retried by the next append", async () => {
    let failures = 1;
    const f = armable((call) => {
      if (failures > 0 && call.op === "rename" && isSnapshotTmp(call.path)) {
        failures--;
        throw fsError("EIO");
      }
      return undefined;
    });
    const e = await mk({ snapshotEvery: 2, fs: interceptFs(realFs, f.hook) });
    const w = await e.store.create(buildDraft(1), e.holder("s1"));
    f.arm();
    await w.append([addTask("A")]);
    await w.append([addTask("B")]); // the second event: snapshot fails
    expect(e.warnings).toHaveLength(1);
    expect(e.warnings[0]).toMatch(/snapshot of plan-one at seq 3 failed, will retry: EIO/);
    expect((await ls(e.dir)).filter((n) => n.includes(".tmp-"))).toEqual([]);
    expect(asLedger(await readJson(join(e.dir, "ledger.json"))).seq).toBe(1);
    await w.append([addTask("C")]); // retried
    expect(asLedger(await readJson(join(e.dir, "ledger.json"))).seq).toBe(4);
    expect(await ls(e.dir)).toEqual(["events.5.jsonl", "history.jsonl", "ledger.json", "writer.lock"]);
  });

  it("an explicit snapshot failure is thrown; a temp file that cannot be removed is warned about", async () => {
    const f = armable((call) => {
      if (call.op === "rename" && isSnapshotTmp(call.path)) throw fsError("EIO");
      if (call.op === "rm" && isSnapshotTmp(call.path)) throw fsError("EACCES");
      return undefined;
    });
    const e = await mk({ fs: interceptFs(realFs, f.hook) });
    const w = await e.store.create(buildDraft(1), e.holder("s1"));
    await w.append([addTask("A")]);
    f.arm();
    expect(((await w.snapshot().then(() => null, (x: unknown) => x)) as { code: string }).code).toBe("EIO");
    expect(e.warnings.some((m) => m.includes("could not remove temp file") && m.includes("EACCES"))).toBe(true);
    f.disarm();
    await w.snapshot(); // the writer is still healthy
    expect(asLedger(await readJson(join(e.dir, "ledger.json"))).seq).toBe(2);
  });

  it.each([["EBUSY"], ["EPERM"]])("a snapshot rename that fails with %s is retried through the clock and then succeeds", async (code) => {
    let failures = 2;
    const f = armable((call) => {
      if (failures > 0 && call.op === "rename" && isSnapshotTmp(call.path)) {
        failures--;
        throw fsError(code);
      }
      return undefined;
    });
    const e = await mk({ fs: interceptFs(realFs, f.hook) });
    const w = await e.store.create(buildDraft(1), e.holder("s1"));
    await w.append([addTask("A")]);
    f.arm();
    await w.snapshot();
    expect(e.clock.sleeps).toEqual([10, 20]);
    expect(asLedger(await readJson(join(e.dir, "ledger.json"))).seq).toBe(2);
  });

  it("a rename that stays busy gives up after the 2 s budget with a backoff capped at 200 ms", async () => {
    const f = armable((call) => {
      if (call.op === "rename" && isSnapshotTmp(call.path)) throw fsError("EBUSY");
      return undefined;
    });
    const e = await mk({ fs: interceptFs(realFs, f.hook) });
    const w = await e.store.create(buildDraft(1), e.holder("s1"));
    await w.append([addTask("A")]);
    f.arm();
    const err = (await w.snapshot().then(() => null, (x: unknown) => x)) as { code: string };
    expect(err.code).toBe("EBUSY");
    expect(e.clock.sleeps.slice(0, 6)).toEqual([10, 20, 40, 80, 160, 200]);
    expect(Math.max(...e.clock.sleeps)).toBe(200);
    expect(e.clock.sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(2_000);
    expect((await ls(e.dir)).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  it("an old journal that cannot be listed or deleted only leaves superseded files behind", async () => {
    const f = armable((call) => {
      if (call.op === "readdir") throw fsError("EIO");
      return undefined;
    });
    const e = await mk({ fs: interceptFs(realFs, f.hook) });
    const w = await e.store.create(buildDraft(1), e.holder("s1"));
    await w.append([addTask("A")]);
    f.arm();
    await w.snapshot();
    expect(e.warnings.some((m) => m.startsWith("could not list "))).toBe(true);
    expect(await ls(e.dir)).toContain("events.1.jsonl"); // superseded, never read
    expect(await ls(e.dir)).toContain("events.3.jsonl");
    f.disarm();
    expect((await e.store.read(PLAN_ID)).seq).toBe(2);

    const e2 = await mk({
      fs: interceptFs(realFs, (call) => {
        if (call.op === "rm" && /events\.1\.jsonl$/.test(call.path)) throw fsError("EACCES");
        return undefined;
      }),
    });
    const w2 = await e2.store.create(buildDraft(1), e2.holder("s1"));
    await w2.append([addTask("A")]);
    await w2.snapshot();
    expect(e2.warnings.some((m) => m.startsWith("could not delete old journal events.1.jsonl"))).toBe(true);
    expect((await e2.store.read(PLAN_ID)).seq).toBe(2);
  });

  it("a failed heartbeat is warned about and re-armed; a temp lock that cannot be removed is warned about too", async () => {
    const f = armable((call) => {
      if (call.op === "rename" && /writer\.lock\.tmp-/.test(call.path)) throw fsError("EIO");
      if (call.op === "rm" && /writer\.lock\.tmp-/.test(call.path)) throw fsError("EACCES");
      return undefined;
    });
    const e = await mk({ fs: interceptFs(realFs, f.hook) });
    const w = await e.store.create(buildDraft(1), e.holder("s1"));
    expect(e.clock.heldCount()).toBe(1);
    f.arm();
    e.clock.fire();
    await w.append([]);
    expect(e.warnings.some((m) => m.includes("heartbeat of plan-one failed"))).toBe(true);
    expect(e.warnings.some((m) => m.includes("could not remove temp lock"))).toBe(true);
    expect(e.clock.heldCount()).toBe(1); // re-armed
    f.disarm();
    e.clock.fire();
    await w.append([]);
    expect((await readJson(join(e.dir, "writer.lock"))) as LockHolder).toMatchObject({ sessionID: "s1" });
    await w.close();
    expect(e.clock.heldCount()).toBe(0); // close disarms the heartbeat
  });

  it("the heartbeat of a fenced writer fails once and is not re-armed", async () => {
    const root = await newRoot();
    const a = await mk({ root, pid: 100 });
    const b = await mk({ root, pid: 200, clock: a.clock });
    const old = await a.store.create(buildDraft(1), a.holder("s1"));
    const fresh = await b.store.takeover(PLAN_ID, b.holder("s2"), "gone");
    expect(a.clock.heldCount()).toBe(2);
    a.clock.fire();
    await fresh.append([]);
    await expect(old.append([])).rejects.toMatchObject({ code: "E_LOCK_LOST" });
    expect(a.warnings.some((m) => m.includes("heartbeat of plan-one failed"))).toBe(true);
    expect(a.clock.heldCount()).toBe(1); // only the new owner's heartbeat
    await fresh.close();
  });

  it("a missing lock file means the lock is lost", async () => {
    const e = await mk();
    const w = await e.store.create(buildDraft(1), e.holder("s1"));
    await realFs.rm(join(e.dir, "writer.lock"), { recursive: false });
    const err = await failure(w.append([addTask("A")]));
    expect(err.code).toBe("E_LOCK_LOST");
    expect(err.detail).toBeNull();
  });

  it("close() throws a snapshot failure but still releases the lock and disposes the writer", async () => {
    const f = armable((call) => {
      if (call.op === "rename" && isSnapshotTmp(call.path)) throw fsError("EIO");
      return undefined;
    });
    const e = await mk({ fs: interceptFs(realFs, f.hook) });
    const w = await e.store.create(buildDraft(1), e.holder("s1"));
    await w.append([addTask("A")]);
    f.arm();
    await expect(w.close()).rejects.toMatchObject({ code: "EIO" });
    expect(await ls(e.dir)).not.toContain("writer.lock");
    expect((await failure(w.append([addTask("B")]))).code).toBe("E_DISPOSED");
    f.disarm();
    expect((await e.store.read(PLAN_ID)).seq).toBe(2); // nothing lost: the journal carries it
  });

  it("close() warns when the lock file cannot be removed", async () => {
    const f = armable((call) => {
      if (call.op === "rm" && /writer\.lock$/.test(call.path)) throw fsError("EACCES");
      return undefined;
    });
    const e = await mk({ fs: interceptFs(realFs, f.hook) });
    const w = await e.store.create(buildDraft(1), e.holder("s1"));
    f.arm();
    await w.close();
    expect(e.warnings.some((m) => m.includes("could not release the lock of plan-one"))).toBe(true);
  });
});

describe("faults: create, open and takeover", () => {
  it("a create that fails removes the half-created plan directory; if that fails too it says so", async () => {
    const e = await mk({
      fs: interceptFs(realFs, (call) => {
        if (call.op === "rename" && isSnapshotTmp(call.path)) throw fsError("EIO");
        return undefined;
      }),
    });
    await expect(e.store.create(buildDraft(1), e.holder("s1"))).rejects.toMatchObject({ code: "EIO" });
    expect(await readdir(e.home)).toEqual([]);

    const e2 = await mk({
      fs: interceptFs(realFs, (call) => {
        if (call.op === "rename" && isSnapshotTmp(call.path)) throw fsError("EIO");
        if (call.op === "rm" && /plan-one$/.test(call.path)) throw fsError("EACCES");
        return undefined;
      }),
    });
    await expect(e2.store.create(buildDraft(1), e2.holder("s1"))).rejects.toMatchObject({ code: "EIO" });
    expect(e2.warnings.some((m) => m.includes("could not remove the half-created plan directory"))).toBe(true);
  });

  it("a create that loses the race for the lock file reports E_EXISTS; any other lock error is passed through", async () => {
    const root = await newRoot();
    const e = await mk({
      root,
      fs: interceptFs(realFs, async (call) => {
        if (call.op === "mkdir" && /plan-one$/.test(call.path)) {
          // Another creator got there between the existence check and our mkdir.
          await realFs.mkdir(call.path);
          await realFs.writeText(join(call.path, "writer.lock"), "{}", { exclusive: true });
        }
      }),
    });
    expect((await failure(e.store.create(buildDraft(1), e.holder("s1")))).code).toBe("E_EXISTS");

    const e2 = await mk({
      fs: interceptFs(realFs, (call) => {
        if (call.op === "writeText" && /writer\.lock$/.test(call.path)) throw fsError("EIO");
        return undefined;
      }),
    });
    await expect(e2.store.create(buildDraft(1), e2.holder("s1"))).rejects.toMatchObject({ code: "EIO" });
  });

  it("takeover passes through a guard I/O error, and a guard that vanishes mid-way is a takeover in progress", async () => {
    const root = await newRoot();
    const a = await mk({ root, pid: 100 });
    await (await a.store.create(buildDraft(1), a.holder("s1"))).close();
    const b = await mk({
      root,
      pid: 200,
      clock: a.clock,
      fs: interceptFs(realFs, (call) => {
        if (call.op === "writeText" && /writer\.lock\.guard$/.test(call.path)) throw fsError("EIO");
        return undefined;
      }),
    });
    await expect(b.store.takeover(PLAN_ID, b.holder("s2"), "r")).rejects.toMatchObject({ code: "EIO" });

    let first = true;
    const c = await mk({
      root,
      pid: 300,
      clock: a.clock,
      fs: interceptFs(realFs, async (call) => {
        if (call.op === "writeText" && /writer\.lock\.guard$/.test(call.path) && first) {
          first = false;
          await realFs.writeText(call.path, "{}", { exclusive: true }); // someone else holds the guard...
        }
        if (call.op === "lstat" && /writer\.lock\.guard$/.test(call.path)) {
          await realFs.rm(call.path, { recursive: false }); // ...and releases it before we look
        }
      }),
    });
    const err = await failure(c.store.takeover(PLAN_ID, c.holder("s3"), "r"));
    expect(err.code).toBe("E_LOCK_HELD");
    expect(err.message).toMatch(/another takeover/);
  });

  it("takeover works when the previous writer released its lock; the event records no previous holder", async () => {
    const root = await newRoot();
    const a = await mk({ root, pid: 100 });
    const b = await mk({ root, pid: 200, clock: a.clock });
    await (await a.store.create(buildDraft(1), a.holder("s1"))).close();
    const tw = await b.store.takeover(PLAN_ID, b.holder("s2"), "no lock to take");
    const ev = (await b.store.exportPlan(PLAN_ID)).events.find((x) => x.type === "lock-takeover");
    expect(ev?.type === "lock-takeover" ? ev.previous : "missing").toBeNull();
    await tw.close();
  });

  it("an open removes leftover temp files and warns about one it cannot remove", async () => {
    const root = await newRoot();
    const a = await mk({ root, pid: 100 });
    await (await a.store.create(buildDraft(1), a.holder("s1"))).close();
    for (const n of ["ledger.json.tmp-1-aa", "writer.lock.tmp-1-bb", "history.jsonl.tmp-1-cc", "ledger.json.tmp-1-stuck"]) {
      await writeFile(join(a.dir, n), "partial", "utf8");
    }
    const b = await mk({
      root,
      pid: 200,
      clock: a.clock,
      fs: interceptFs(realFs, (call) => {
        if (call.op === "rm" && /tmp-1-stuck$/.test(call.path)) throw fsError("EACCES");
        return undefined;
      }),
    });
    const w = await b.store.open(PLAN_ID, b.holder("s2"));
    expect((await ls(a.dir)).filter((n) => n.includes(".tmp-"))).toEqual(["ledger.json.tmp-1-stuck"]);
    expect(b.warnings.some((m) => m.startsWith("could not remove leftover ledger.json.tmp-1-stuck"))).toBe(true);
    await w.close();
  });

  it("a failed open warns when its own lock cannot be released", async () => {
    const root = await newRoot();
    const a = await mk({ root, pid: 100 });
    await plant(a.home, [initLine(buildDraft(1)), "garbage", eventLine(addTask("A"), 3, 3, true)]);
    const b = await mk({
      root,
      pid: 200,
      clock: a.clock,
      fs: interceptFs(realFs, (call) => {
        if (call.op === "rm" && /writer\.lock$/.test(call.path)) throw fsError("EACCES");
        return undefined;
      }),
    });
    expect((await failure(b.store.open(PLAN_ID, b.holder("s2")))).code).toBe("E_SEQ_GAP");
    expect(b.warnings.some((m) => m.startsWith("could not release the lock in "))).toBe(true);
  });

  it("an open of a plan that has no snapshot yet writes one", async () => {
    const e = await mk();
    const dir = await plant(e.home, [initLine(buildDraft(2))]);
    expect(await ls(dir)).toEqual(["events.1.jsonl"]);
    const w = await e.store.open(PLAN_ID, e.holder("s1"));
    expect(await ls(dir)).toEqual(["events.2.jsonl", "history.jsonl", "ledger.json", "writer.lock"]);
    expect(asLedger(await readJson(join(dir, "ledger.json"))).seq).toBe(1);
    await w.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// History journal
// ---------------------------------------------------------------------------------------------------------------

describe("history journal", () => {
  const readSeqs = async (file: string): Promise<number[]> => (await readLines(file)).map((l) => (JSON.parse(l) as ExecutorEvent).seq);

  /** A writer that appended two metrics and then "crashed" (never closed); its lock names a pid the next process does not know. */
  async function crashedWithMetrics(): Promise<{ root: string; a: Env; b: Env }> {
    const root = await newRoot();
    const a = await mk({ root, pid: 100 });
    const b = await mk({ root, pid: 200, clock: a.clock });
    const w = await a.store.create(buildDraft(1), a.holder("s1"));
    await w.append([metric(1)]);
    await w.append([metric(2)]);
    return { root, a, b };
  }

  it("a torn history tail is rewritten from the main journal on open", async () => {
    const { a, b } = await crashedWithMetrics();
    const file = join(a.dir, "history.jsonl");
    const lines = await readLines(file);
    await writeFile(file, `${lines[0] as string}\n${(lines[1] as string).slice(0, 20)}`, "utf8");
    const w = await b.store.takeover(PLAN_ID, b.holder("s2"), "crash");
    expect(await readSeqs(file)).toEqual([2, 3]);
    expect((await readFile(file, "utf8")).endsWith("\n")).toBe(true);
    await w.close();
  });

  it("history that lost its tail is completed from the main journal on open", async () => {
    const { a, b } = await crashedWithMetrics();
    const file = join(a.dir, "history.jsonl");
    await writeFile(file, "", "utf8");
    const w = await b.store.takeover(PLAN_ID, b.holder("s2"), "crash");
    expect(await readSeqs(file)).toEqual([2, 3]);
    await w.close();
  });

  it("history events beyond the ledger's seq are dropped on open", async () => {
    const { a, b } = await crashedWithMetrics();
    const file = join(a.dir, "history.jsonl");
    const ahead = eventLine(metric(9), 99, 99, true);
    await writeFile(file, `${await readFile(file, "utf8")}${ahead}\n`, "utf8");
    const w = await b.store.takeover(PLAN_ID, b.holder("s2"), "crash");
    expect(await readSeqs(file)).toEqual([2, 3]);
    await w.close();
  });

  it("a history journal whose seq does not increase is E_SEQ_GAP", async () => {
    const { a, b } = await crashedWithMetrics();
    await writeFile(join(a.dir, "history.jsonl"), `${eventLine(metric(1), 3, 3, true)}\n${eventLine(metric(2), 2, 2, true)}\n`, "utf8");
    expect((await failure(b.store.takeover(PLAN_ID, b.holder("s2"), "crash"))).code).toBe("E_SEQ_GAP");
    expect((await failure(b.store.exportPlan(PLAN_ID))).code).toBe("E_SEQ_GAP");
  });

  it("a history whose integration entries are inconsistent is E_ILLEGAL_TRANSITION on open", async () => {
    const root = await newRoot();
    const a = await mk({ root, pid: 100 });
    const b = await mk({ root, pid: 200, clock: a.clock });
    const w = await a.store.create(buildDraft(1), a.holder("s1"));
    await w.append([metric(1)]);
    await writeFile(join(a.dir, "history.jsonl"), `${eventLine(step("end", "i-2", "rebase"), 2, 2, true)}\n`, "utf8");
    const err = await failure(b.store.takeover(PLAN_ID, b.holder("s2"), "crash"));
    expect(err.code).toBe("E_ILLEGAL_TRANSITION");
    expect((err.detail as { codes: string[] }).codes).toEqual(["entry-not-open"]);
  });

  it("export merges history and journal by seq and keeps history events back to seq 2 across rotations", async () => {
    const e = await mk({ snapshotEvery: 3 });
    const w = await e.store.create(buildDraft(1), e.holder("s1"));
    for (let i = 1; i <= 4; i++) await w.append([metric(i), addTask(`A${i}`)]);
    expect(await ls(e.dir)).not.toContain("events.1.jsonl");
    const { snapshot, events } = await e.store.exportPlan(PLAN_ID);
    expect(snapshot.seq).toBe(9);
    const seqs = events.map((x) => x.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(events.filter((x) => x.type === "metric").map((x) => x.seq)).toEqual([2, 4, 6, 8]);
    await w.close();
  });
});
