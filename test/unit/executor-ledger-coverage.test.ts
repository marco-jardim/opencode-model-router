// Phase 2.2 task 2.2.3 coverage top-up: unit tests of the less travelled branches of the durable ledger store
// (src/executor/ledger.ts). Real files in a temp dir through the FileSystem seam, an injected clock (no fixed sleeps) and an
// injected process table, as in test/unit/executor-ledger.test.ts.
// Not reachable from the public API, so not covered here: `sameStrings` (no caller), the `?? ""` fallbacks of `parseJournal`, the
// non-`ledger-init` guard of `initLedger` (its only caller checks first), a migration that advances the schema (the table is empty),
// `ensureJournal` with no journal (every start rotates into one) and the journal-continues-later check of a snapshot load.
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLedgerStore, createNodeFileSystem, type LedgerStoreDeps } from "../../src/executor/ledger.js";
import {
  ExecutorError,
  type ExecutorEventInput,
  type FileSystem,
  type LedgerStore,
  type LedgerV1,
  type LockHolder,
  type TaskState,
  type TransitionTrigger,
} from "../../src/executor/types.js";
import { PLAN_ID, addTask, buildDraft, clone, eventLine, holderOf, initLine, metric, openAttempt } from "../fixtures/cpx/ledger/builders.js";
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
  const root = await mkdtemp(join(tmpdir(), "omr-ledger-cov-"));
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

function asLedger(v: unknown): LedgerV1 {
  return v as LedgerV1;
}

// ---------------------------------------------------------------------------------------------------------------
// Per-event preconditions (applyEvent)
// ---------------------------------------------------------------------------------------------------------------

describe("per-event preconditions refuse events about a task that does not exist", () => {
  const missing: ExecutorEventInput[] = [
    { type: "attempt-child", taskId: "NOPE", n: 1, childSessionID: "ses-child" },
    { type: "attempt-adopted", taskId: "NOPE", n: 1, childSessionID: "ses-child" },
    { type: "attempt-ended", taskId: "NOPE", n: 1, outcome: "succeeded", endedAt: "2026-10-11T00:00:00.000Z" },
    { type: "attempt-verdict", taskId: "NOPE", n: 1, verdict: "pass" },
  ] as unknown as ExecutorEventInput[];

  for (const input of missing) {
    it(`${input.type} on an unknown task is refused and leaves the ledger unchanged`, async () => {
      const e = await mk();
      const w = await e.store.create(buildDraft(1), e.holder("s1"));
      const err = await failure(w.append([input]));
      expect(err.code).toBe("E_ILLEGAL_TRANSITION");
      expect(err.message).toContain("task-missing");
      expect(w.ledger.seq).toBe(1);
      await w.close();
      expect(asLedger(await e.store.read(PLAN_ID)).seq).toBe(1);
    });
  }

  it("a second attempt-started while the first attempt is still open is attempt-open-exists", async () => {
    const e = await mk();
    const w = await e.store.create(buildDraft(1), e.holder("s1"));
    await w.append([transition("T1", "pending", "ready", "deps-satisfied")]);
    const started = (n: number): ExecutorEventInput => ({ type: "attempt-started", taskId: "T1", attempt: openAttempt(n) });
    const err = await failure(w.append([started(1), started(2)]));
    expect(err.code).toBe("E_ILLEGAL_TRANSITION");
    expect(err.message).toContain("attempt-open-exists");
    expect(w.ledger.tasks.T1?.attempts).toEqual([]);
    expect(w.ledger.seq).toBe(2);
    await w.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Loading: schema gate, listing errors, journal continuity
// ---------------------------------------------------------------------------------------------------------------

/** Plants a plan directory by hand: `events.1.1.jsonl` from `lines` plus optional extra files (name -> content). */
async function plant(home: string, lines: readonly string[], files: Record<string, string> = {}): Promise<string> {
  const dir = join(home, PLAN_ID);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "events.1.1.jsonl"), `${lines.join("\n")}\n`, "utf8");
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text, "utf8");
  return dir;
}

describe("loading", () => {
  it("a snapshot with an older schema and no migration step is E_SCHEMA_INVALID", async () => {
    const e = await mk();
    const draft = buildDraft(1);
    const old = { ...clone(draft), schema: 0 };
    await plant(e.home, [initLine(draft)], { "ledger.1.json": JSON.stringify(old) });
    const err = await failure(e.store.read(PLAN_ID));
    expect(err.code).toBe("E_SCHEMA_INVALID");
    expect(err.message).toContain("no migration from schema 0");
  });

  it("a plan directory that cannot be listed for a reason other than ENOENT surfaces the filesystem error", async () => {
    const root = await newRoot();
    const fs = interceptFs(realFs, (c) => {
      if (c.op === "readdir" && c.path.endsWith(PLAN_ID)) throw fsError("EACCES", "listing denied");
    });
    const e = await mk({ root, fs });
    await plant(e.home, [initLine(buildDraft(1))]);
    await expect(e.store.read(PLAN_ID)).rejects.toMatchObject({ code: "EACCES" });
  });

  it("a writer whose listed snapshot vanished before it was read refuses with E_SEQ_GAP", async () => {
    const root = await newRoot();
    let vanish = false;
    const fs = interceptFs(realFs, (c) => {
      if (vanish && c.op === "readText" && c.path.endsWith("ledger.1.json")) throw fsError("ENOENT");
    });
    const e = await mk({ root, fs });
    const draft = buildDraft(1);
    await plant(e.home, [initLine(draft)], { "ledger.1.json": JSON.stringify(draft) });
    vanish = true;
    const err = await failure(e.store.open(PLAN_ID, e.holder("s1")));
    expect(err.code).toBe("E_SEQ_GAP");
    expect(err.message).toContain("ledger.1.json vanished while loading");
  });

  it("a reader whose listed snapshot keeps vanishing retries, then gives up with E_SEQ_GAP", async () => {
    const root = await newRoot();
    let snapshotReads = 0;
    const fs = interceptFs(realFs, (c) => {
      if (c.op === "readText" && c.path.endsWith("ledger.1.json")) {
        snapshotReads += 1;
        throw fsError("ENOENT");
      }
    });
    const e = await mk({ root, fs });
    const draft = buildDraft(1);
    await plant(e.home, [initLine(draft)], { "ledger.1.json": JSON.stringify(draft) });
    const err = await failure(e.store.read(PLAN_ID));
    expect(err.code).toBe("E_SEQ_GAP");
    expect(err.message).toBe("snapshot and journal never agreed: ledger.1.json vanished while loading");
    expect(snapshotReads).toBe(8);
    expect(e.clock.sleeps).toEqual([5, 10, 15, 20, 25, 30, 35, 40]);
  });

  it("without a warn sink, load warnings (a torn last line) are dropped and the read succeeds", async () => {
    const root = await newRoot();
    const home = join(root, "omr-executor");
    const store = createLedgerStore({ home, clock: new FakeClock(), proc: new FakeProc(100, "host-a") });
    const dir = await plant(home, [initLine(buildDraft(1))]);
    await writeFile(join(dir, "events.1.1.jsonl"), `${initLine(buildDraft(1))}\n{"seq":2,"at`, "utf8");
    const l = await store.read(PLAN_ID);
    expect(l.seq).toBe(1);
    expect(Object.keys(l.tasks)).toEqual(["T1"]);
  });

  it("a journal file whose first line is not the seq its name promises is E_SEQ_GAP", async () => {
    const e = await mk();
    await plant(e.home, [initLine(buildDraft(1))], { "events.2.1.jsonl": `${eventLine(addTask("N3"), 3, 3, true)}\n` });
    const err = await failure(e.store.read(PLAN_ID));
    expect(err.code).toBe("E_SEQ_GAP");
    expect(err.message).toBe("journal events.2.1.jsonl starts at seq 3, expected 2");
  });

  it("a failure whose code is not a string is rethrown as is", async () => {
    const root = await newRoot();
    const odd = Object.assign(new Error("odd failure"), { code: 42 });
    const fs = interceptFs(realFs, (c) => {
      if (c.op === "readdir" && c.path.endsWith(PLAN_ID)) throw odd;
    });
    const e = await mk({ root, fs });
    await plant(e.home, [initLine(buildDraft(1))]);
    await expect(e.store.read(PLAN_ID)).rejects.toBe(odd);
  });

  it("exportPlan of a plan without history.jsonl returns the journal events", async () => {
    const e = await mk();
    const w = await e.store.create(buildDraft(1), e.holder("s1"));
    await w.close();
    expect(await ls(e.dir)).not.toContain("history.jsonl");
    const out = await e.store.exportPlan(PLAN_ID);
    expect(out.snapshot.seq).toBe(1);
    expect(out.events.map((ev) => [ev.seq, ev.type])).toEqual([[1, "ledger-init"]]);
  });

  it("after a lock-takeover an out-of-order history line is a fenced writer's late copy and is dropped", async () => {
    const draft = buildDraft(1);
    const holder = holderOf("s9", 9, "host-z");
    const takeoverEv: ExecutorEventInput = { type: "lock-takeover", reason: "stale", previous: null, holder };
    const m3 = eventLine(metric(3), 3, 3, true);
    const m4 = eventLine(metric(4), 4, 4, true);
    const e = await mk();
    const dir = await plant(e.home, [initLine(draft), eventLine(takeoverEv, 2, 2, true), m3, m4], {
      "history.jsonl": `${m4}\n${m3}\n`,
    });
    const out = await e.store.exportPlan(PLAN_ID);
    expect(out.events.map((ev) => ev.seq)).toEqual([1, 2, 3, 4]);
    // Control: the same disorder without a takeover is corruption.
    await writeFile(join(dir, "events.1.1.jsonl"), `${[initLine(draft), eventLine(metric(2), 2, 2, true), m3, m4].join("\n")}\n`, "utf8");
    const err = await failure(e.store.exportPlan(PLAN_ID));
    expect(err.code).toBe("E_SEQ_GAP");
    expect(err.message).toContain("history history.jsonl: seq 3 follows 4");
  });

  it("a gap in seq between two journal files is E_SEQ_GAP", async () => {
    const e = await mk();
    const draft = buildDraft(1);
    await plant(e.home, [initLine(draft)], { "events.3.1.jsonl": `${eventLine(addTask("N3"), 3, 3, true)}\n` });
    const err = await failure(e.store.read(PLAN_ID));
    expect(err.code).toBe("E_SEQ_GAP");
    expect(err.message).toContain("seq 3 follows 1 across journal files");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Rotation: creating the next journal and deleting the superseded ones
// ---------------------------------------------------------------------------------------------------------------

/** A switchable FileSystem: `hook` sees every call while `sw.on` is set; `hideSnapshots` filters snapshot names out of listings. */
function switchable(sw: { on: boolean; hideSnapshots?: boolean }, hook: FsInterceptor, afterPartial?: (c: FsCall) => Promise<void>): FileSystem {
  const base = interceptFs(realFs, (c) => (sw.on ? hook(c) : undefined), afterPartial);
  return {
    ...base,
    async readdir(p) {
      const names = await base.readdir(p);
      return sw.on && sw.hideSnapshots === true ? names.filter((n) => !/^ledger\.\d+\.json$/.test(n)) : names;
    },
  };
}

const seqsOf = async (file: string): Promise<number[]> => (await readLines(file)).map((l) => (JSON.parse(l) as { seq: number }).seq);

describe("rotation", () => {
  it("after a failed append to a fresh journal, the empty file under the same name is reused", async () => {
    const root = await newRoot();
    const sw = { on: false };
    const fs = switchable(sw, (c) => {
      if (c.op === "appendText" && c.path.endsWith("events.4.1.jsonl")) throw fsError("EIO", "journal write failed");
    });
    const e = await mk({ root, fs, snapshotEvery: 2 });
    const w = await e.store.create(buildDraft(1), e.holder("s1"));
    await w.append([addTask("N2")]);
    await w.append([addTask("N3")]); // second event since the snapshot: rotation to events.4.1
    expect(await ls(e.dir)).toEqual(["events.4.1.jsonl", "history.jsonl", "ledger.1.json", "writer.lock"]);
    sw.on = true;
    await expect(w.append([addTask("N4")])).rejects.toMatchObject({ code: "EIO" });
    sw.on = false;
    const after = await w.append([addTask("N4")]);
    expect(after.seq).toBe(4);
    expect(await ls(e.dir)).toEqual(["events.4.1.jsonl", "history.jsonl", "ledger.1.json", "writer.lock"]);
    expect(await seqsOf(join(e.dir, "events.4.1.jsonl"))).toEqual([4]);
    await w.close();
    expect(asLedger(await e.store.read(PLAN_ID)).tasks.N4?.id).toBe("N4");
    expect(e.warnings).toEqual([]);
  });

  it("the writer's own journal left with a partial batch is replaced by a clean file of the same name", async () => {
    const root = await newRoot();
    const sw = { on: false };
    const fs = switchable(
      sw,
      (c) => (c.op === "appendText" && c.path.endsWith("events.4.1.jsonl") ? { writePartial: 7 } : undefined),
      () => Promise.reject(fsError("EIO", "cut after a partial write")),
    );
    const e = await mk({ root, fs, snapshotEvery: 2 });
    const w = await e.store.create(buildDraft(1), e.holder("s1"));
    await w.append([addTask("N2")]);
    await w.append([addTask("N3")]);
    sw.on = true;
    await expect(w.append([addTask("N4")])).rejects.toMatchObject({ code: "EIO" });
    sw.on = false;
    expect((await readFile(join(e.dir, "events.4.1.jsonl"), "utf8")).length).toBe(7); // a torn tail
    await w.append([addTask("N5")]);
    expect(await seqsOf(join(e.dir, "events.4.1.jsonl"))).toEqual([4]);
    await w.close();
    const read = await e.store.read(PLAN_ID);
    expect(read.seq).toBe(4);
    expect(Object.keys(read.tasks)).toEqual(["T1", "N2", "N3", "N5"]);
  });

  it("a foreign journal with content under the next journal's name is refused with E_SEQ_GAP", async () => {
    const e = await mk();
    const w = await e.store.create(buildDraft(1), e.holder("s1"));
    await w.append([addTask("N2")]);
    await writeFile(join(e.dir, "events.3.1.jsonl"), `${eventLine(addTask("X"), 3, 3, true)}\n`, "utf8");
    const err = await failure(w.snapshot());
    expect(err.code).toBe("E_SEQ_GAP");
    expect(err.message).toContain("journal events.3.1.jsonl already exists with content");
    expect(err.detail).toEqual({ file: "events.3.1.jsonl" });
    expect(await ls(e.dir)).toContain("events.1.1.jsonl"); // the active journal was not replaced
    await w.close();
    expect(await ls(e.dir)).not.toContain("writer.lock");
  });

  it("a failure other than EEXIST while creating the next journal rejects the snapshot", async () => {
    const root = await newRoot();
    const sw = { on: false };
    const fs = switchable(sw, (c) => {
      if (c.op === "writeText" && c.path.endsWith("events.3.1.jsonl")) throw fsError("EACCES", "create denied");
    });
    const e = await mk({ root, fs });
    const w = await e.store.create(buildDraft(1), e.holder("s1"));
    await w.append([addTask("N2")]);
    sw.on = true;
    await expect(w.snapshot()).rejects.toMatchObject({ code: "EACCES" });
    sw.on = false;
    expect(await ls(e.dir)).toEqual(["events.1.1.jsonl", "history.jsonl", "ledger.1.json", "writer.lock"]);
    await w.close();
    expect(await ls(e.dir)).toEqual(["events.1.1.jsonl", "history.jsonl", "ledger.1.json"]);
    expect((await e.store.read(PLAN_ID)).seq).toBe(2);
  });

  it("keeps a journal that starts later in the same epoch and deletes the superseded one", async () => {
    const e = await mk();
    const w = await e.store.create(buildDraft(1), e.holder("s1"));
    await w.append([metric(2), metric(3)]);
    await writeFile(join(e.dir, "events.99.1.jsonl"), "", "utf8");
    await w.snapshot();
    expect(await ls(e.dir)).toEqual(["events.4.1.jsonl", "events.99.1.jsonl", "history.jsonl", "ledger.1.json", "writer.lock"]);
    expect(await seqsOf(join(e.dir, "history.jsonl"))).toEqual([2, 3]);
    await w.close();
    expect(e.warnings).toEqual([]);
  });

  it("when history cannot be verified from the old journals, they are kept with a warning", async () => {
    const root = await newRoot();
    const sw = { on: false };
    const fs = switchable(sw, (c) => {
      if (c.op === "readText" && c.path.endsWith("events.1.1.jsonl")) throw fsError("EIO", "old journal unreadable");
    });
    const e = await mk({ root, fs });
    const w = await e.store.create(buildDraft(1), e.holder("s1"));
    await w.append([metric(2), metric(3)]);
    sw.on = true;
    await w.snapshot();
    sw.on = false;
    expect(await ls(e.dir)).toEqual(["events.1.1.jsonl", "events.4.1.jsonl", "history.jsonl", "ledger.1.json", "writer.lock"]);
    expect(e.warnings).toEqual([`history of ${PLAN_ID} could not be verified, old journals kept: old journal unreadable`]);
    await w.close();
    expect((await e.store.read(PLAN_ID)).seq).toBe(3);
  });

  it("an old journal that vanished before the history check is skipped and the rotation completes", async () => {
    const root = await newRoot();
    const sw = { on: false };
    const fs = switchable(sw, (c) => {
      if (c.op === "readText" && c.path.endsWith("events.1.1.jsonl")) throw fsError("ENOENT", "gone");
    });
    const e = await mk({ root, fs });
    const w = await e.store.create(buildDraft(1), e.holder("s1"));
    await w.append([metric(2), metric(3)]);
    sw.on = true;
    await w.snapshot();
    sw.on = false;
    expect(await ls(e.dir)).toEqual(["events.4.1.jsonl", "history.jsonl", "ledger.1.json", "writer.lock"]);
    expect(await seqsOf(join(e.dir, "history.jsonl"))).toEqual([2, 3]);
    expect(e.warnings).toEqual([]);
    await w.close();
  });

  it("with no snapshot visible in the listing, the history check trusts the journals up to the ledger's seq", async () => {
    const root = await newRoot();
    const sw = { on: false, hideSnapshots: true };
    const fs = switchable(sw, () => undefined);
    const e = await mk({ root, fs });
    const w = await e.store.create(buildDraft(1), e.holder("s1"));
    await w.append([metric(2), metric(3)]);
    sw.on = true;
    await w.snapshot();
    sw.on = false;
    expect(await ls(e.dir)).toEqual(["events.4.1.jsonl", "history.jsonl", "ledger.1.json", "writer.lock"]);
    expect(await seqsOf(join(e.dir, "history.jsonl"))).toEqual([2, 3]);
    expect(e.warnings).toEqual([]);
    await w.close();
    expect((await e.store.read(PLAN_ID)).seq).toBe(3);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Lock records, beat files and the lock-held report
// ---------------------------------------------------------------------------------------------------------------

/** Wraps `base`, letting a test rewrite what `readText` returns and what `lstat` reports. */
function wrapFs(
  base: FileSystem,
  o: { readText?: (path: string, text: string) => string; lstat?: (path: string) => boolean },
): FileSystem {
  const inner = interceptFs(base, () => undefined); // plain closures: safe to spread
  return {
    ...inner,
    async readText(p) {
      const text = await inner.readText(p);
      return o.readText === undefined ? text : o.readText(p, text);
    },
    async lstat(p) {
      return o.lstat !== undefined && o.lstat(p) ? null : inner.lstat(p);
    },
  };
}

interface LockFileJson {
  pid: number;
  hostname: string;
  sessionID: string;
  startedAt: string;
  heartbeatAt: string;
  token: string;
  epoch: number;
}

const readLockFile = async (dir: string): Promise<LockFileJson> =>
  JSON.parse(await readFile(join(dir, "writer.lock"), "utf8")) as LockFileJson;

describe("lock records and beat files", () => {
  it("a lock record with an invalid token or epoch names no holder", async () => {
    const e = await mk();
    const w = await e.store.create(buildDraft(1), e.holder("s1"));
    await w.close();
    const valid = { ...e.holder("s0"), token: "abc-123", epoch: 1 };
    for (const bad of [{ ...valid, token: "not a token!" }, { ...valid, epoch: 0 }, { ...valid, epoch: 1.5 }]) {
      await writeFile(join(e.dir, "writer.lock"), JSON.stringify(bad), "utf8");
      const err = await failure(e.store.open(PLAN_ID, e.holder("s2")));
      expect(err.code).toBe("E_LOCK_HELD");
      expect(err.message).toContain("held by unknown holder");
      expect(err.detail).toBeNull();
    }
    await writeFile(join(e.dir, "writer.lock"), JSON.stringify(valid), "utf8"); // control: the same record with a good token and epoch
    const named = await failure(e.store.open(PLAN_ID, e.holder("s2")));
    expect(named.message).toContain("pid 100 on host-a (session s0)");
  });

  it("a beat file that is not a record, has no string heartbeatAt or an unparsable one does not refresh the holder", async () => {
    const root = await newRoot();
    const clock = new FakeClock();
    const a = await mk({ root, clock, pid: 100, host: "host-a" });
    const b = await mk({ root, clock, pid: 200, host: "host-b" });
    const w = await a.store.create(buildDraft(1), a.holder("s1"));
    const { token } = await readLockFile(a.dir);
    clock.advance(120_000); // the lock's own stamp is now stale
    const beat = join(a.dir, `writer.${token}.beat`);
    for (const text of ["[1]", JSON.stringify({ heartbeatAt: 5 }), JSON.stringify({ heartbeatAt: "not a date" })]) {
      await writeFile(beat, text, "utf8");
      const err = await failure(b.store.open(PLAN_ID, b.holder("s2")));
      expect(err.code).toBe("E_LOCK_HELD");
      expect(err.message).toContain("it is stale, use takeover");
    }
    await writeFile(beat, JSON.stringify({ heartbeatAt: clock.iso() }), "utf8"); // control: a fresh beat keeps the holder live
    const live = await failure(b.store.open(PLAN_ID, b.holder("s2")));
    expect(live.message).not.toContain("stale");
    await w.close();
  });

  it("a torn lock whose mtime cannot be read is never judged stale", async () => {
    const root = await newRoot();
    const sw = { hideLockStat: false };
    const fs = wrapFs(realFs, { lstat: (p) => sw.hideLockStat && p.endsWith("writer.lock") });
    const e = await mk({ root, fs });
    const w = await e.store.create(buildDraft(1), e.holder("s1"));
    await w.close();
    await writeFile(join(e.dir, "writer.lock"), "{ torn", "utf8");
    e.clock.set(Date.parse("2100-01-01T00:00:00.000Z"));
    const control = await failure(e.store.open(PLAN_ID, e.holder("s2")));
    expect(control.message).toContain("held by unknown holder; it is stale, use takeover");
    sw.hideLockStat = true;
    const err = await failure(e.store.open(PLAN_ID, e.holder("s2")));
    expect(err.code).toBe("E_LOCK_HELD");
    expect(err.message).toBe("ledger writer lock is held by unknown holder");
  });

  it("close leaves a lock it can no longer see in place, and still removes its own beat file", async () => {
    const root = await newRoot();
    const sw = { on: false, reads: 0 };
    const fs = switchable(sw, (c) => {
      if (c.op === "readText" && c.path.endsWith("writer.lock") && ++sw.reads >= 2) throw fsError("ENOENT", "lock not visible");
    });
    const e = await mk({ root, fs });
    const w = await e.store.create(buildDraft(1), e.holder("s1"));
    e.clock.fire(); // one heartbeat: writes this holder's beat file
    await w.append([]); // serialised after the beat
    const { token } = await readLockFile(e.dir);
    expect(await ls(e.dir)).toContain(`writer.${token}.beat`);
    sw.on = true;
    await w.close(); // the lock check passes (read 1); the release sees no lock (read 2)
    sw.on = false;
    expect(await ls(e.dir)).toEqual(["events.1.1.jsonl", "ledger.1.json", "writer.lock"]);
    expect(e.warnings).toEqual([]);
  });

  it("a heartbeat queued behind close does nothing once the writer is closed", async () => {
    const e = await mk();
    const w = await e.store.create(buildDraft(1), e.holder("s1"));
    expect(e.clock.heldCount()).toBe(1);
    const closing = w.close();
    e.clock.fire(); // the beat is serialised after close
    await closing;
    await w.close(); // serialised after the beat: it has run
    expect(e.clock.heldCount()).toBe(0);
    expect((await ls(e.dir)).some((n) => n.endsWith(".beat"))).toBe(false);
    expect(await ls(e.dir)).toEqual(["events.1.1.jsonl", "ledger.1.json"]);
    expect(e.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Takeover guard
// ---------------------------------------------------------------------------------------------------------------

describe("takeover guard", () => {
  it("a guard that vanishes before it can be judged is reported as a takeover in progress", async () => {
    const root = await newRoot();
    const sw = { on: false };
    const fs = switchable(sw, (c) => {
      if (c.op === "readText" && c.path.endsWith("writer.lock.guard")) throw fsError("ENOENT", "guard gone");
    });
    const e = await mk({ root, fs });
    const w = await e.store.create(buildDraft(1), e.holder("s1"));
    await w.close();
    await writeFile(join(e.dir, "writer.lock.guard"), "other taker", "utf8");
    sw.on = true;
    const err = await failure(e.store.takeover(PLAN_ID, e.holder("s2"), "r"));
    expect(err.code).toBe("E_LOCK_HELD");
    expect(err.message).toBe("another takeover of this ledger is in progress");
  });

  it("a dead breaker's stale break file is removed, and the next takeover breaks the stale guard and wins", async () => {
    const e = await mk();
    const w = await e.store.create(buildDraft(1), e.holder("s1"));
    await w.close();
    await writeFile(join(e.dir, "writer.lock.guard"), "dead taker", "utf8");
    await writeFile(join(e.dir, "writer.lock.guard.break"), "dead breaker", "utf8");
    const guardStat = await realFs.lstat(join(e.dir, "writer.lock.guard"));
    const breakStat = await realFs.lstat(join(e.dir, "writer.lock.guard.break"));
    e.clock.set(Math.max(guardStat?.mtimeMs ?? 0, breakStat?.mtimeMs ?? 0) + 60_000); // both are older than the guard staleness window
    const err = await failure(e.store.takeover(PLAN_ID, e.holder("s2"), "r"));
    expect(err.message).toBe("another takeover of this ledger is in progress");
    expect(await ls(e.dir)).toEqual(["events.1.1.jsonl", "ledger.1.json", "writer.lock.guard"]);
    const t = await e.store.takeover(PLAN_ID, e.holder("s2"), "r");
    expect(t.ledger.seq).toBe(2);
    expect((await ls(e.dir)).filter((n) => n.startsWith("writer.lock"))).toEqual(["writer.lock"]);
    await t.close();
  });

  it("a lock that changed between being judged stale and being replaced is refused", async () => {
    const root = await newRoot();
    const clock = new FakeClock();
    const sw = { on: false, reads: 0 };
    const fs = wrapFs(realFs, {
      readText: (p, text) => (sw.on && p.endsWith("writer.lock") && ++sw.reads === 2 ? `${text} ` : text),
    });
    const a = await mk({ root, clock, pid: 100 });
    const b = await mk({ root, clock, pid: 200, fs });
    const w = await a.store.create(buildDraft(1), a.holder("s1"));
    const before = await readFile(join(a.dir, "writer.lock"), "utf8");
    sw.on = true; // pid 100 is not alive in b's process table: the lock is stale for b
    const err = await failure(b.store.takeover(PLAN_ID, b.holder("s2"), "r"));
    sw.on = false;
    expect(err.code).toBe("E_LOCK_HELD");
    expect(err.message).toContain("it is stale, use takeover");
    expect(await readFile(join(a.dir, "writer.lock"), "utf8")).toBe(before);
    expect(await ls(a.dir)).not.toContain("writer.lock.guard");
    await w.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Opening a plan that has a snapshot but no journal file
// ---------------------------------------------------------------------------------------------------------------

describe("open without a journal file", () => {
  async function plantSnapshotOnly(home: string): Promise<string> {
    const dir = join(home, PLAN_ID);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "ledger.1.json"), JSON.stringify(buildDraft(1)), "utf8");
    return dir;
  }

  it("the writer snapshots under its own epoch and starts a journal", async () => {
    const e = await mk();
    await plantSnapshotOnly(e.home);
    const w = await e.store.open(PLAN_ID, e.holder("s1"));
    const names = await ls(e.dir);
    expect(names).toContain("events.2.2.jsonl");
    expect(names).toContain("ledger.2.json");
    expect(names).not.toContain("ledger.1.json");
    expect((await w.append([addTask("N2")])).seq).toBe(2);
    expect(await seqsOf(join(e.dir, "events.2.2.jsonl"))).toEqual([2]);
    await w.close();
  });

  it("a writer whose start fails is abandoned: the lock is released and no heartbeat stays armed", async () => {
    const root = await newRoot();
    const sw = { on: true };
    const fs = switchable(sw, (c) => {
      if (c.op === "writeText" && c.path.includes("ledger.2.json.tmp-")) throw fsError("EACCES", "snapshot denied");
    });
    const e = await mk({ root, fs });
    await plantSnapshotOnly(e.home);
    await expect(e.store.open(PLAN_ID, e.holder("s1"))).rejects.toMatchObject({ code: "EACCES" });
    expect(e.clock.heldCount()).toBe(0);
    expect(await ls(e.dir)).not.toContain("writer.lock");
    expect((await ls(e.dir)).some((n) => n.includes(".tmp-"))).toBe(false);
    sw.on = false;
    const w = await e.store.open(PLAN_ID, e.holder("s1"));
    expect(w.ledger.seq).toBe(1);
    await w.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The node FileSystem
// ---------------------------------------------------------------------------------------------------------------

describe("createNodeFileSystem", () => {
  it("lstat reports a file, a directory and a link by kind, and null for a missing path", async () => {
    const root = await newRoot();
    const dir = join(root, "d");
    const file = join(root, "f.txt");
    const link = join(root, "l");
    await mkdir(dir);
    await writeFile(file, "abc", "utf8");
    await symlink(dir, link, process.platform === "win32" ? "junction" : "dir");
    expect(await realFs.lstat(file)).toMatchObject({ kind: "file", size: 3 });
    expect((await realFs.lstat(dir))?.kind).toBe("dir");
    expect((await realFs.lstat(link))?.kind).toBe("symlink");
    expect(await realFs.lstat(join(root, "missing"))).toBeNull();
  });

  it("fsyncDir syncs a directory (ignoring what the platform cannot do) and fails on a missing path", async () => {
    const root = await newRoot();
    await expect(realFs.fsyncDir(root)).resolves.toBeUndefined();
    await expect(realFs.fsyncDir(join(root, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// History copies
// ---------------------------------------------------------------------------------------------------------------

/** A FileSystem whose `appendText` to history.jsonl fails while `failing.on` is set. */
function failingHistory(failing: { on: boolean; error: unknown }): FileSystem {
  return interceptFs(realFs, (c) => {
    if (failing.on && c.op === "appendText" && c.path.endsWith("history.jsonl")) throw failing.error;
  });
}

describe("history copies", () => {
  it("a failed history copy (even one rejected with a non-Error) warns, and the next append rewrites history from what it holds", async () => {
    const root = await newRoot();
    const failing = { on: false, error: { toString: () => "history disk said no" } as unknown };
    const e = await mk({ root, fs: failingHistory(failing) });
    const w = await e.store.create(buildDraft(1), e.holder("s1"));
    await w.append([metric(2)]); // seq 2, copied
    failing.on = true;
    await w.append([metric(3)]); // seq 3: the main journal has it, the copy fails
    expect(w.ledger.seq).toBe(3);
    expect(e.warnings).toEqual([`history copy for ${PLAN_ID} failed, will be repaired: history disk said no`]);
    expect((await readLines(join(e.dir, "history.jsonl"))).map((l) => (JSON.parse(l) as { seq: number }).seq)).toEqual([2]);
    failing.on = false;
    await w.append([metric(4)]); // the rewrite keeps seq 2 and adds the pending 3 and 4
    expect((await readLines(join(e.dir, "history.jsonl"))).map((l) => (JSON.parse(l) as { seq: number }).seq)).toEqual([2, 3, 4]);
    await w.close();
    expect(e.warnings).toHaveLength(1);
    expect((await e.store.read(PLAN_ID)).seq).toBe(4);
  });

  it("a failed first history fsync with no history events is repaired by writing an empty history.jsonl", async () => {
    const root = await newRoot();
    const failing = { on: true, error: fsError("EIO", "no history yet") as unknown };
    const e = await mk({ root, fs: failingHistory(failing) });
    const w = await e.store.create(buildDraft(1), e.holder("s1"));
    await w.append([addTask("N2")]); // durable: the history fsync fails
    expect(e.warnings).toEqual([`history copy for ${PLAN_ID} failed, will be repaired: no history yet`]);
    expect(await ls(e.dir)).not.toContain("history.jsonl");
    await w.append([addTask("N3")]); // the repair rewrites history from nothing: an empty file
    expect(await readFile(join(e.dir, "history.jsonl"), "utf8")).toBe("");
    expect(e.warnings).toHaveLength(1);
    await w.close();
  });

  it("an explicit snapshot whose history fsync fails is rejected with that error (strict flush)", async () => {
    const root = await newRoot();
    const failing = { on: false, error: fsError("EIO", "history fsync failed") as unknown };
    const e = await mk({ root, fs: failingHistory(failing) });
    const w = await e.store.create(buildDraft(1), e.holder("s1"));
    await w.append([metric(2), metric(3)]); // non-durable copies: history.jsonl is written but not fsynced
    failing.on = true;
    await expect(w.snapshot()).rejects.toMatchObject({ code: "EIO" });
    expect(e.warnings).toEqual([]);
    expect(await ls(e.dir)).toContain("events.1.1.jsonl"); // no rotation happened
    failing.on = false;
    await w.snapshot(); // the dirty history is rewritten first, then the snapshot and rotation go through
    expect(await ls(e.dir)).toEqual(["events.4.1.jsonl", "history.jsonl", "ledger.1.json", "writer.lock"]);
    expect((await readLines(join(e.dir, "history.jsonl"))).map((l) => (JSON.parse(l) as { seq: number }).seq)).toEqual([2, 3]);
    await w.close();
  });
});
