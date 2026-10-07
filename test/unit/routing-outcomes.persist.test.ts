import { afterEach, describe, it, expect, vi } from "vitest";
import { basename, dirname, join, resolve } from "node:path";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import {
  compactStamp,
  createFlusher,
  createPersister,
  nodePersistFs,
  nodeScheduler,
  parseLogLine,
  renameWithRetry,
  resolveOutcomesDir,
} from "../../src/routing/outcomes/persist";
import { acquireOutcomes } from "../../src/routing/outcomes/index";
import { emptyTokenSample } from "../../src/routing/outcomes/cost";
import { createOutcomeStore } from "../../src/routing/outcomes/store";
import { summarize, renderMarkdown } from "../../src/routing/outcomes/stats";
import {
  DECISIONS_FILE,
  DECISIONS_ROTATED_RE,
  DEFAULT_OUTCOMES_DIRNAME,
  OUTCOMES_CORRUPT_PREFIX,
  OUTCOMES_CORRUPT_RE,
  OUTCOMES_FILE,
  OUTCOMES_SCHEMA_ID,
  OUTCOMES_TMP_PREFIX,
  STALE_TMP_MS,
  makeKey,
} from "../../src/routing/outcomes/types";
import type {
  DecisionRow,
  FlushScheduler,
  LogRow,
  OutcomeLogger,
  OutcomeSnapshot,
  PersistDeps,
  PersistFs,
  PersistStat,
  RefusalRow,
  VerdictRow,
  WriteResult,
} from "../../src/routing/outcomes/types";

const T0 = Date.UTC(2026, 9, 6, 12, 0, 0);
const KEY = makeKey("implement", { origin: "router", id: "medium" }, "anthropic", "claude-sonnet-5-5");
const KEY_B = makeKey("search", { origin: "host", id: "explore" }, "anthropic", "claude-haiku-4-5");
const PID = 4242;

// ---------------------------------------------------------------------------
// Helpers: clock, in-memory fs, logger, rows
// ---------------------------------------------------------------------------

function clock(start = T0) {
  let t = start;
  return {
    now: () => t,
    set(value: number) {
      t = value;
    },
    advance(ms: number) {
      t += ms;
    },
  };
}

type Hook = (...args: string[]) => void | Promise<void>;

function fsError(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}

interface MemFile {
  text: string;
  mtimeMs: number;
}

/** Quarantined copies (`outcomes.corrupt.<stamp>-<pid>.json`) present in a mem fs, oldest first. */
function corruptCopies(files: Map<string, MemFile>): string[] {
  return [...files.keys()].filter((p) => OUTCOMES_CORRUPT_RE.test(basename(p))).sort();
}

function createMemFs(now: () => number) {
  const files = new Map<string, MemFile>();
  const dirs = new Set<string>();
  const touched: Array<{ op: string; path: string }> = [];
  const hooks: { [K in keyof PersistFs]?: Hook } = {};

  const fs: PersistFs = {
    async createExclusive(path, data) {
      await hooks.createExclusive?.(path, data);
      if (files.has(path)) return false;
      files.set(path, { text: data, mtimeMs: now() });
      return true;
    },
    async mkdirp(dir) {
      touched.push({ op: "mkdirp", path: dir });
      await hooks.mkdirp?.(dir);
      dirs.add(dir);
    },
    async readText(path) {
      touched.push({ op: "readText", path });
      await hooks.readText?.(path);
      return files.get(path)?.text ?? null;
    },
    async writeDurable(path, data) {
      touched.push({ op: "writeDurable", path });
      await hooks.writeDurable?.(path, data);
      files.set(path, { text: data, mtimeMs: now() });
    },
    async appendText(path, data) {
      touched.push({ op: "appendText", path });
      await hooks.appendText?.(path, data);
      const existing = files.get(path);
      files.set(path, { text: (existing?.text ?? "") + data, mtimeMs: now() });
    },
    async rename(from, to) {
      touched.push({ op: "rename", path: from });
      await hooks.rename?.(from, to);
      const source = files.get(from);
      if (!source) throw fsError("ENOENT", `no such file: ${from}`);
      files.set(to, source);
      files.delete(from);
    },
    async unlink(path) {
      touched.push({ op: "unlink", path });
      await hooks.unlink?.(path);
      files.delete(path);
    },
    async stat(path): Promise<PersistStat | null> {
      touched.push({ op: "stat", path });
      await hooks.stat?.(path);
      const file = files.get(path);
      return file ? { size: Buffer.byteLength(file.text, "utf8"), mtimeMs: file.mtimeMs } : null;
    },
    async readdir(dir) {
      touched.push({ op: "readdir", path: dir });
      await hooks.readdir?.(dir);
      return [...files.keys()].filter((p) => dirname(p) === dir).map((p) => basename(p));
    },
  };
  return { fs, files, dirs, touched, hooks };
}

/** Make `op` throw `code` the next `times` calls, then behave normally. */
function failTimes(hooks: { [K in keyof PersistFs]?: Hook }, op: keyof PersistFs, code: string, times: number) {
  let left = times;
  hooks[op] = () => {
    if (left > 0) {
      left -= 1;
      throw fsError(code);
    }
  };
}

function makeLogger() {
  return { warn: vi.fn<OutcomeLogger["warn"]>(), info: vi.fn<NonNullable<OutcomeLogger["info"]>>() };
}

function setup(dirName = "omr-persist-test") {
  const c = clock();
  const mem = createMemFs(c.now);
  const logger = makeLogger();
  const sleeps: number[] = [];
  const dir = join(tmpdir(), dirName);
  const deps: PersistDeps = {
    fs: mem.fs,
    now: c.now,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    logger,
    pid: PID,
  };
  return { c, mem, logger, sleeps, dir, deps };
}

function snapshotOf(...verdicts: Array<"pass" | "fail">): OutcomeSnapshot {
  const store = createOutcomeStore({ now: () => T0 });
  verdicts.forEach((v, i) => store.recordVerdict(KEY, v, { attemptID: `a${i}`, step: "dispatch" }));
  return store.snapshot();
}

const ts = (i: number) => new Date(T0 + i * 1000).toISOString();

function verdictRow(i: number, partial: Partial<VerdictRow> = {}): VerdictRow {
  return {
    v: 1,
    kind: "verdict",
    ts: ts(i),
    sessionID: "s1",
    decisionID: `d${i}`,
    childSessionID: `c${i}`,
    attemptID: `c${i}:0`,
    key: KEY,
    verdict: "pass",
    step: "dispatch",
    ...partial,
  };
}

function refusalRow(i: number): RefusalRow {
  return { v: 1, kind: "refusal", ts: ts(i), sessionID: "s1", decisionID: null, childSessionID: `c${i}`, attemptID: `c${i}:0`, key: KEY, step: "retry" };
}

function decisionRow(i: number, partial: Partial<DecisionRow> = {}): DecisionRow {
  return {
    v: 1,
    kind: "decision",
    ts: ts(i),
    sessionID: "s1",
    decisionID: `d${i}`,
    mode: "shadow",
    childSessionID: null,
    facts: { class: "implement", risk: "low", scope: "file", needs: ["edit", "test"], confidence: 0.8, source: "heuristic" },
    chosen: { key: KEY, agent: "medium", origin: "router", model: "anthropic/claude-sonnet-5-5", variant: "default" },
    best: { key: KEY_B, agent: "explore", origin: "host", model: "anthropic/claude-haiku-4-5", variant: "default" },
    switched: false,
    pinned: false,
    unit: "ratio",
    costs: { [KEY]: 1, [KEY_B]: 0.25 },
    confidence: 0.7,
    reason: "cheaper tier is enough",
    step: "dispatch",
    resume: false,
    ...partial,
  };
}

const tick = () => new Promise<void>((done) => setImmediate(done));

function deferred() {
  let resolveFn: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolveFn = done;
  });
  return { promise, resolve: resolveFn };
}

// ---------------------------------------------------------------------------
// resolveOutcomesDir
// ---------------------------------------------------------------------------

describe("resolveOutcomesDir (D15)", () => {
  const env = { tmpdir: join(tmpdir(), "omr-env"), homedir: join(tmpdir(), "omr-home") };
  const fallback = join(env.tmpdir, DEFAULT_OUTCOMES_DIRNAME);

  it("unset or blank → the scorecard directory under the tmpdir", () => {
    for (const configured of [null, undefined, "", "   "]) expect(resolveOutcomesDir(configured, env)).toBe(fallback);
    expect(resolveOutcomesDir(null, { tmpdir: tmpdir(), homedir: homedir() })).toBe(join(tmpdir(), "opencode-model-router-trajectory"));
  });

  it("~ resolves against the home directory", () => {
    expect(resolveOutcomesDir("~", env)).toBe(env.homedir);
    expect(resolveOutcomesDir("~/outcomes", env)).toBe(join(env.homedir, "outcomes"));
    expect(resolveOutcomesDir("~/outcomes/x", env)).toBe(join(env.homedir, "outcomes", "x"));
    // Only Windows treats interior backslashes as separators; POSIX preserves them as filename characters.
    expect(resolveOutcomesDir("~\\outcomes\\x", env)).toBe(join(env.homedir, "outcomes\\x"));
  });

  it("an absolute path is normalised; `~name` is not a home reference", () => {
    const abs = join(resolve("omr-abs"), "..", "omr-abs", "dir");
    expect(resolveOutcomesDir(abs, env)).toBe(resolve("omr-abs", "dir"));
    expect(resolveOutcomesDir("~other", env)).toBe(join(fallback, "~other"));
  });

  it("a relative path resolves against the default directory, never the process cwd", () => {
    expect(resolveOutcomesDir("custom/dir", env)).toBe(join(fallback, "custom", "dir"));
    expect(resolveOutcomesDir("  sub  ", env)).toBe(join(fallback, "sub"));
    expect(resolveOutcomesDir("custom", env).startsWith(process.cwd())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// renameWithRetry
// ---------------------------------------------------------------------------

describe("renameWithRetry (Windows sharing violations)", () => {
  it("retries EPERM/EBUSY/EACCES with the documented delays, then succeeds", async () => {
    const sleeps: number[] = [];
    for (const code of ["EPERM", "EBUSY", "EACCES"]) {
      sleeps.length = 0;
      let left = 3;
      const fs = {
        rename: async () => {
          if (left-- > 0) throw fsError(code);
        },
      };
      await renameWithRetry(fs, "a", "b", async (ms) => void sleeps.push(ms));
      expect(sleeps).toEqual([15, 30, 60]);
    }
  });

  it("gives up after the last delay and throws the last error", async () => {
    const sleeps: number[] = [];
    const rename = vi.fn(async () => {
      throw fsError("EPERM");
    });
    await expect(renameWithRetry({ rename }, "a", "b", async (ms) => void sleeps.push(ms))).rejects.toMatchObject({ code: "EPERM" });
    expect(rename).toHaveBeenCalledTimes(6);
    expect(sleeps).toEqual([15, 30, 60, 120, 240]);
  });

  it("any other error code is thrown at once", async () => {
    const sleeps: number[] = [];
    const rename = vi.fn(async () => {
      throw fsError("ENOSPC");
    });
    await expect(renameWithRetry({ rename }, "a", "b", async (ms) => void sleeps.push(ms))).rejects.toMatchObject({ code: "ENOSPC" });
    await expect(renameWithRetry({ rename: async () => { throw new Error("no code"); } }, "a", "b", async () => undefined)).rejects.toThrow("no code");
    expect(sleeps).toEqual([]);
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it("custom delays are honoured", async () => {
    const sleeps: number[] = [];
    const rename = vi.fn(async () => {
      throw fsError("EBUSY");
    });
    await expect(renameWithRetry({ rename }, "a", "b", async (ms) => void sleeps.push(ms), [1, 2])).rejects.toBeDefined();
    expect(sleeps).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// saveSnapshot / load
// ---------------------------------------------------------------------------

describe("persister: saveSnapshot (atomic write)", () => {
  it("N5: exhausted EPERM on a confirmed read-only target disables further snapshots", async () => {
    const { mem, deps, dir, sleeps } = setup();
    const persister = createPersister(dir, deps);
    await persister.saveSnapshot(snapshotOf("pass"));
    const originalStat = mem.fs.stat;
    mem.fs.stat = async (path) => {
      const value = await originalStat(path);
      return value === null ? null : { ...value, mode: 0o444 };
    };
    failTimes(mem.hooks, "rename", "EPERM", 6);
    expect(await persister.saveSnapshot(snapshotOf("fail"))).toMatchObject({ ok: false, readOnly: true, code: "EPERM" });
    expect(sleeps).toEqual([15, 30, 60, 120, 240]);
    const writes = mem.touched.length;
    expect(await persister.saveSnapshot(snapshotOf("pass"))).toMatchObject({ ok: false, readOnly: true });
    expect(mem.touched).toHaveLength(writes);
    expect(await persister.appendRows([verdictRow(1)])).toEqual({ ok: true });
  });
  it("writes a deterministic envelope through a temp file and leaves no temp behind", async () => {
    const { mem, deps, dir, c } = setup();
    const persister = createPersister(dir, deps);
    const snapshot = snapshotOf("pass", "fail");
    expect(await persister.saveSnapshot(snapshot)).toEqual({ ok: true });

    const written = mem.files.get(join(dir, OUTCOMES_FILE));
    expect(written).toBeDefined();
    const parsed = JSON.parse(written?.text ?? "null") as Record<string, unknown>;
    expect(parsed).toEqual({ schema: OUTCOMES_SCHEMA_ID, version: 1, savedAt: new Date(T0).toISOString(), entries: snapshot.entries });
    expect(written?.text.endsWith("\n")).toBe(true);
    expect([...mem.files.keys()]).toEqual([join(dir, OUTCOMES_FILE)]);
    const writes = mem.touched.filter((t) => t.op === "writeDurable");
    expect(writes).toHaveLength(1);
    expect(basename(writes[0]?.path ?? "")).toBe(`${OUTCOMES_TMP_PREFIX}${PID}-1`);

    const first = written?.text;
    c.advance(0);
    await persister.saveSnapshot(snapshot);
    expect(mem.files.get(join(dir, OUTCOMES_FILE))?.text).toBe(first);
    expect(basename(mem.touched.filter((t) => t.op === "writeDurable")[1]?.path ?? "")).toBe(`${OUTCOMES_TMP_PREFIX}${PID}-2`);
  });

  it("creates the directory on save, never on load", async () => {
    const { mem, deps, dir } = setup();
    const persister = createPersister(dir, deps);
    await persister.load();
    await persister.readRows();
    expect(mem.touched.some((t) => t.op === "mkdirp")).toBe(false);
    await persister.saveSnapshot(snapshotOf("pass"));
    expect(mem.dirs.has(dir)).toBe(true);
  });

  it("a crash mid-write leaves the previous outcomes.json intact and removes the temp file", async () => {
    const { mem, deps, dir, logger } = setup();
    const persister = createPersister(dir, deps);
    await persister.saveSnapshot(snapshotOf("pass"));
    const before = mem.files.get(join(dir, OUTCOMES_FILE))?.text;

    mem.hooks.writeDurable = (path, data) => {
      mem.files.set(path, { text: data.slice(0, 20), mtimeMs: 0 }); // a torn temp file
      throw fsError("ENOSPC", "disk full");
    };
    const result = await persister.saveSnapshot(snapshotOf("pass", "pass", "pass"));
    expect(result).toEqual({ ok: false, error: "disk full", code: "ENOSPC" });
    expect(mem.files.get(join(dir, OUTCOMES_FILE))?.text).toBe(before);
    expect([...mem.files.keys()]).toEqual([join(dir, OUTCOMES_FILE)]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("rename failing with EPERM six times: ok false, old content intact, temp removed, all five delays slept", async () => {
    const { mem, deps, dir, sleeps } = setup();
    const persister = createPersister(dir, deps);
    await persister.saveSnapshot(snapshotOf("pass"));
    const before = mem.files.get(join(dir, OUTCOMES_FILE))?.text;
    failTimes(mem.hooks, "rename", "EPERM", 6);
    const result = await persister.saveSnapshot(snapshotOf("fail", "fail"));
    expect(result).toMatchObject({ ok: false, code: "EPERM" });
    expect(sleeps).toEqual([15, 30, 60, 120, 240]);
    expect(mem.files.get(join(dir, OUTCOMES_FILE))?.text).toBe(before);
    expect([...mem.files.keys()]).toEqual([join(dir, OUTCOMES_FILE)]);
  });

  it("EPERM twice then success: ok, slept [15, 30], new content in place", async () => {
    const { mem, deps, dir, sleeps } = setup();
    const persister = createPersister(dir, deps);
    failTimes(mem.hooks, "rename", "EPERM", 2);
    expect(await persister.saveSnapshot(snapshotOf("pass"))).toEqual({ ok: true });
    expect(sleeps).toEqual([15, 30]);
    expect([...mem.files.keys()]).toEqual([join(dir, OUTCOMES_FILE)]);
    const loaded = await persister.load({ quarantine: false });
    expect(loaded.status).toBe("ok");
  });

  it("custom renameRetryDelaysMs and a failing mkdir are reported, never thrown", async () => {
    const { mem, deps, dir, sleeps } = setup();
    const persister = createPersister(dir, deps, { renameRetryDelaysMs: [7] });
    failTimes(mem.hooks, "rename", "EBUSY", 5);
    expect((await persister.saveSnapshot(snapshotOf("pass"))).ok).toBe(false);
    expect(sleeps).toEqual([7]);

    mem.hooks.mkdirp = () => {
      throw fsError("EACCES", "denied");
    };
    expect(await persister.saveSnapshot(snapshotOf("pass"))).toEqual({ ok: false, error: "denied", code: "EACCES" });
    expect(await persister.appendRows([verdictRow(1)])).toEqual({ ok: false, error: "denied", code: "EACCES" });
  });

  it("QA-1.3-7: a non-finite clock falls back to Date.now() instead of failing the write", async () => {
    const { deps, dir, c, mem } = setup();
    const persister = createPersister(dir, deps);
    c.set(Number.NaN);
    const before = Date.now();
    expect(await persister.saveSnapshot(snapshotOf("pass"))).toEqual({ ok: true });
    const saved = JSON.parse(mem.files.get(join(dir, OUTCOMES_FILE))?.text ?? "null") as { savedAt: string };
    expect(Date.parse(saved.savedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(saved.savedAt)).toBeLessThanOrEqual(Date.now());
  });
});

describe("persister: load", () => {
  it("a missing file is an empty store, not an error", async () => {
    const { mem, deps, dir, logger } = setup();
    const result = await createPersister(dir, deps).load();
    expect(result).toEqual({ status: "missing", snapshot: { version: 1, entries: {} }, dropped: 0, savedAt: null, message: null });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(mem.touched.filter((t) => t.op === "writeDurable" || t.op === "rename" || t.op === "unlink")).toEqual([]);
  });

  it("save → load round trip returns the snapshot and savedAt", async () => {
    const { deps, dir } = setup();
    const persister = createPersister(dir, deps);
    const snapshot = snapshotOf("pass", "pass", "fail");
    await persister.saveSnapshot(snapshot);
    const loaded = await createPersister(dir, deps).load();
    expect(loaded.status).toBe("ok");
    expect(loaded.snapshot).toEqual(snapshot);
    expect(loaded.dropped).toBe(0);
    expect(loaded.savedAt).toBe(new Date(T0).toISOString());
    expect(loaded.message).toBeNull();
  });

  it("corrupted JSON → fresh store, one warning, file quarantined, next save writes fresh", async () => {
    const { mem, deps, dir, logger } = setup();
    const path = join(dir, OUTCOMES_FILE);
    mem.files.set(path, { text: '{"schema": "opencode-model-router.outcomes", "vers', mtimeMs: 1 });
    const persister = createPersister(dir, deps);
    const loaded = await persister.load();
    expect(loaded.status).toBe("corrupt");
    expect(loaded.snapshot).toEqual({ version: 1, entries: {} });
    expect(loaded.message).toContain(resolve(path));
    expect(loaded.message).toContain("invalid JSON");
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[0]).toBe("[router] outcome store corrupted; starting fresh");
    expect(logger.warn.mock.calls[0]?.[1]).toMatchObject({ path });
    expect(mem.files.has(path)).toBe(false);
    const copies = corruptCopies(mem.files);
    expect(copies).toHaveLength(1);
    expect(basename(copies[0] ?? "")).toBe(`${OUTCOMES_CORRUPT_PREFIX}${compactStamp(T0)}-${PID}.json`);
    expect(mem.files.get(copies[0] ?? "")?.text).toContain('"vers');

    expect(await persister.saveSnapshot(snapshotOf("pass"))).toEqual({ ok: true });
    expect((await createPersister(dir, deps).load()).status).toBe("ok");
    expect(mem.files.get(copies[0] ?? "")?.text).toContain('"vers');
  });

  it.each([
    ["version 0", JSON.stringify({ schema: OUTCOMES_SCHEMA_ID, version: 0, entries: {} })],
    ["a missing entries object", JSON.stringify({ schema: OUTCOMES_SCHEMA_ID, version: 1 })],
    ["an empty file", ""],
    ["a truncated file", '{"schema": "opencode-model-router.outcomes", "version": 1, "entries": {'],
  ])("QA-1.3-11: %s is corrupt: quarantined, and the next save may write", async (_name, text) => {
    const { mem, deps, dir } = setup();
    mem.files.set(join(dir, OUTCOMES_FILE), { text, mtimeMs: 1 });
    const persister = createPersister(dir, deps);
    const loaded = await persister.load();
    expect(loaded.status).toBe("corrupt");
    expect(corruptCopies(mem.files)).toHaveLength(1);
    expect(mem.files.has(join(dir, OUTCOMES_FILE))).toBe(false);
    expect((await persister.saveSnapshot(snapshotOf("pass"))).ok).toBe(true);
  });

  it.each([
    ["a wrong schema", JSON.stringify({ schema: "other", version: 1, entries: {} })],
    ["another tool's JSON object", JSON.stringify({ name: "package", version: "1.0.0" })],
    ["a JSON array", "[1, 2, 3]"],
    ["a JSON string", '"hello"'],
    ["null", "null"],
    ["a string version", JSON.stringify({ schema: OUTCOMES_SCHEMA_ID, version: "1", entries: {} })],
    ["a fractional version", JSON.stringify({ schema: OUTCOMES_SCHEMA_ID, version: 1.5, entries: {} })],
    ["a missing version", JSON.stringify({ schema: OUTCOMES_SCHEMA_ID, entries: {} })],
  ])("QA-1.3-11: %s is not ours: read-only, never quarantined, never overwritten", async (_name, text) => {
    const { mem, deps, dir, logger } = setup();
    const path = join(dir, OUTCOMES_FILE);
    mem.files.set(path, { text, mtimeMs: 1 });
    const persister = createPersister(dir, deps);
    const loaded = await persister.load();
    expect(loaded.status).toBe("unsupported-version");
    expect(loaded.message).toContain(resolve(path));
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(mem.files.get(path)?.text).toBe(text);
    expect(corruptCopies(mem.files)).toEqual([]);
    expect(await persister.saveSnapshot(snapshotOf("pass"))).toEqual({ ok: false, error: "unrecognized outcome store on disk", readOnly: true });
    expect(mem.files.get(path)?.text).toBe(text);
    expect(mem.touched.some((t) => t.op === "writeDurable" || t.op === "rename" || t.op === "unlink")).toBe(false);
  });

  it("QA-1.3-11: a UTF-8 BOM in front of a valid store is tolerated", async () => {
    const { mem, deps, dir } = setup();
    const snapshot = snapshotOf("pass", "fail");
    await createPersister(dir, deps).saveSnapshot(snapshot);
    const path = join(dir, OUTCOMES_FILE);
    mem.files.set(path, { text: "\uFEFF" + (mem.files.get(path)?.text ?? ""), mtimeMs: 2 });
    const loaded = await createPersister(dir, deps).load();
    expect(loaded.status).toBe("ok");
    expect(loaded.snapshot).toEqual(snapshot);
    expect(corruptCopies(mem.files)).toEqual([]);
  });

  it("QA-1.3-11: quarantine names are unique per quarantine (same millisecond, same pid) and only the newest copies are kept", async () => {
    const { mem, deps, dir } = setup();
    const path = join(dir, OUTCOMES_FILE);
    for (let i = 0; i < 6; i++) {
      mem.files.set(path, { text: `garbage ${i}`, mtimeMs: 1 });
      expect((await createPersister(dir, deps).load()).status).toBe("corrupt"); // the clock never moves
    }
    const copies = corruptCopies(mem.files);
    expect(copies).toHaveLength(3);
    expect(copies.map((p) => mem.files.get(p)?.text)).toEqual(["garbage 3", "garbage 4", "garbage 5"]);
    expect(new Set(copies).size).toBe(3);
  });

  it("quarantine: false (the CLI) reports corruption but leaves the file where it is", async () => {
    const { mem, deps, dir, logger } = setup();
    const path = join(dir, OUTCOMES_FILE);
    mem.files.set(path, { text: "not json", mtimeMs: 1 });
    mem.files.set(join(dir, `${OUTCOMES_TMP_PREFIX}1-1`), { text: "x", mtimeMs: 0 });
    const loaded = await createPersister(dir, deps).load({ quarantine: false });
    expect(loaded.status).toBe("corrupt");
    expect(mem.files.get(path)?.text).toBe("not json");
    expect(mem.files.has(join(dir, `${OUTCOMES_TMP_PREFIX}1-1`))).toBe(true);
    expect(mem.touched.filter((t) => t.op === "rename" || t.op === "unlink" || t.op === "writeDurable")).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("a quarantine that fails is logged and the load still reports corruption", async () => {
    const { mem, deps, dir, logger } = setup();
    mem.files.set(join(dir, OUTCOMES_FILE), { text: "garbage", mtimeMs: 1 });
    failTimes(mem.hooks, "rename", "ENOSPC", 1);
    const loaded = await createPersister(dir, deps).load();
    expect(loaded.status).toBe("corrupt");
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(mem.files.get(join(dir, OUTCOMES_FILE))?.text).toBe("garbage");
  });

  it("invalid entries are dropped with a warning and the load stays ok", async () => {
    const { mem, deps, dir, logger } = setup();
    const snapshot = snapshotOf("pass");
    const envelope = { schema: OUTCOMES_SCHEMA_ID, version: 1, savedAt: "2026-10-06T12:00:00.000Z", entries: { ...snapshot.entries, "bad key": {}, [KEY_B]: { nope: true } } };
    mem.files.set(join(dir, OUTCOMES_FILE), { text: JSON.stringify(envelope), mtimeMs: 1 });
    const loaded = await createPersister(dir, deps).load();
    expect(loaded.status).toBe("ok");
    expect(loaded.dropped).toBe(2);
    expect(loaded.message).toContain("2 invalid entries dropped");
    expect(loaded.message).toContain(resolve(join(dir, OUTCOMES_FILE)));
    expect(Object.keys(loaded.snapshot.entries)).toEqual([KEY]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("an unsupported (newer) version is never overwritten", async () => {
    const { mem, deps, dir, logger } = setup();
    const path = join(dir, OUTCOMES_FILE);
    const newer = JSON.stringify({ schema: OUTCOMES_SCHEMA_ID, version: 2, entries: { anything: 1 } });
    mem.files.set(path, { text: newer, mtimeMs: 1 });
    const persister = createPersister(dir, deps);
    const loaded = await persister.load();
    expect(loaded.status).toBe("unsupported-version");
    expect(loaded.snapshot).toEqual({ version: 1, entries: {} });
    expect(loaded.message).toContain(resolve(path));
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(corruptCopies(mem.files)).toEqual([]);

    expect(await persister.saveSnapshot(snapshotOf("pass"))).toEqual({ ok: false, error: "unsupported outcome store version on disk", readOnly: true });
    expect(mem.files.get(path)?.text).toBe(newer);
    expect(mem.touched.some((t) => t.op === "writeDurable")).toBe(false);
    // decision rows are still appended: they live in a different file
    expect((await persister.appendRows([verdictRow(1)])).ok).toBe(true);
  });

  it("an unreadable store (EACCES after the retries) disables saves instead of overwriting it", async () => {
    const { mem, deps, dir, logger, sleeps } = setup();
    const path = join(dir, OUTCOMES_FILE);
    mem.files.set(path, { text: "{}", mtimeMs: 1 });
    mem.hooks.readText = () => {
      throw fsError("EACCES", "denied");
    };
    const persister = createPersister(dir, deps);
    const loaded = await persister.load();
    expect(loaded.status).toBe("corrupt");
    expect(loaded.message).toContain("denied");
    expect(sleeps).toEqual([15, 30, 60, 120, 240]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect((await persister.saveSnapshot(snapshotOf("pass"))).ok).toBe(false);
    expect(mem.files.get(path)?.text).toBe("{}");
  });

  it("a read that succeeds after a transient EBUSY is a normal load", async () => {
    const { mem, deps, dir, sleeps } = setup();
    await createPersister(dir, deps).saveSnapshot(snapshotOf("pass"));
    failTimes(mem.hooks, "readText", "EBUSY", 2);
    expect((await createPersister(dir, deps).load()).status).toBe("ok");
    expect(sleeps).toEqual([15, 30]);
  });

  it("a load never throws, whatever the fs does", async () => {
    const { mem, deps, dir } = setup();
    mem.hooks.stat = () => {
      throw new Error("stat exploded");
    };
    mem.hooks.readdir = () => {
      throw new Error("readdir exploded");
    };
    const result = await createPersister(dir, deps).load();
    expect(result.status).toBe("missing");
  });

  it("quarantine mode removes stale temp files only (older than one hour), never anything else", async () => {
    const { mem, deps, dir, c } = setup();
    const stale = join(dir, `${OUTCOMES_TMP_PREFIX}9-1`);
    const fresh = join(dir, `${OUTCOMES_TMP_PREFIX}9-2`);
    const other = join(dir, "notes.txt");
    mem.files.set(stale, { text: "x", mtimeMs: c.now() - STALE_TMP_MS - 1 });
    mem.files.set(fresh, { text: "x", mtimeMs: c.now() - STALE_TMP_MS + 60_000 });
    mem.files.set(other, { text: "x", mtimeMs: 0 });
    await createPersister(dir, deps).load({ quarantine: false });
    expect(mem.files.has(stale)).toBe(true);
    await createPersister(dir, deps).load({ quarantine: true });
    expect(mem.files.has(stale)).toBe(false);
    expect(mem.files.has(fresh)).toBe(true);
    expect(mem.files.has(other)).toBe(true);
  });

  it("warns once when another process rewrote outcomes.json between our load and our save (last writer wins)", async () => {
    const { mem, deps, dir, logger, c } = setup();
    const persister = createPersister(dir, deps);
    await persister.saveSnapshot(snapshotOf("pass"));
    await persister.load();
    const path = join(dir, OUTCOMES_FILE);
    c.advance(5000);
    mem.files.set(path, { text: mem.files.get(path)?.text ?? "", mtimeMs: c.now() });
    await persister.saveSnapshot(snapshotOf("pass", "pass"));
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[0]).toContain("another process wrote outcomes.json");
    c.advance(5000);
    mem.files.set(path, { text: mem.files.get(path)?.text ?? "", mtimeMs: c.now() });
    await persister.saveSnapshot(snapshotOf("pass"));
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("no foreign-writer warning for our own writes", async () => {
    const { deps, dir, logger, c } = setup();
    const persister = createPersister(dir, deps);
    await persister.load();
    for (let i = 0; i < 3; i++) {
      c.advance(1000);
      await persister.saveSnapshot(snapshotOf("pass"));
    }
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Decision log
// ---------------------------------------------------------------------------

describe("persister: decisions.jsonl", () => {
  it("QA-G-C8: re-stats just before rotation and leaves a new small live file alone", async () => {
    const { mem, deps, dir } = setup();
    const live = join(dir, DECISIONS_FILE);
    const persister = createPersister(dir, deps, { maxBytes: 100 });
    await persister.appendRows([verdictRow(1)]);
    mem.hooks.readdir = () => {
      mem.files.set(live, { text: "\n", mtimeMs: T0 }); // another rotator has replaced the file
    };
    await persister.appendRows([verdictRow(2)]);
    expect(mem.touched.filter((t) => t.op === "rename")).toEqual([]);
    delete mem.hooks.readdir;
    expect((await persister.readRows()).rows).toEqual([verdictRow(2)]);
  });
  it("appends one JSON line per row with a single appendText call per batch", async () => {
    const { mem, deps, dir } = setup();
    const persister = createPersister(dir, deps);
    expect(await persister.appendRows([])).toEqual({ ok: true });
    expect(mem.touched).toEqual([]);
    const rows: LogRow[] = [decisionRow(1), verdictRow(2), refusalRow(3)];
    expect(await persister.appendRows(rows)).toEqual({ ok: true });
    expect(mem.touched.filter((t) => t.op === "appendText")).toHaveLength(1);
    const text = mem.files.get(join(dir, DECISIONS_FILE))?.text ?? "";
    expect(text.split("\n")).toHaveLength(4);
    expect(text.endsWith("\n")).toBe(true);
    const read = await persister.readRows();
    expect(read.rows).toEqual(rows);
    expect(read.skipped).toBe(0);
    expect(read.files).toEqual([join(dir, DECISIONS_FILE)]);
  });

  it("rotates when the live log would pass maxBytes: timestamped generations, oldest pruned, rows stay in order", async () => {
    const { mem, deps, dir, c } = setup();
    const persister = createPersister(dir, deps, { maxBytes: 200, maxGenerations: 2 });
    const rows = Array.from({ length: 6 }, (_, i) => verdictRow(i));
    for (const row of rows) {
      await persister.appendRows([row]);
      c.advance(1);
    }
    const names = [...mem.files.keys()].map((p) => basename(p)).sort();
    const rotated = names.filter((n) => DECISIONS_ROTATED_RE.test(n));
    expect(rotated).toHaveLength(2);
    expect(names).toContain(DECISIONS_FILE);
    for (const name of rotated) expect(name).toMatch(new RegExp(`^decisions\\.\\d{8}T\\d{9}Z-${PID}\\.jsonl$`));
    const read = await persister.readRows();
    expect(read.rows.map((r) => (r.kind === "verdict" ? r.attemptID : ""))).toEqual(["c3:0", "c4:0", "c5:0"]);
    expect(read.files.map((p) => basename(p))).toEqual([...rotated, DECISIONS_FILE]);
    expect(read.skipped).toBe(0);
  });

  it("generation names stay unique and ordered even when the clock never moves or goes backwards", async () => {
    const { mem, deps, dir, c } = setup();
    const persister = createPersister(dir, deps, { maxBytes: 100, maxGenerations: 10 });
    for (let i = 0; i < 5; i++) {
      await persister.appendRows([verdictRow(i)]);
      if (i === 3) c.set(T0 - 60_000);
    }
    const rotated = [...mem.files.keys()].map((p) => basename(p)).filter((n) => DECISIONS_ROTATED_RE.test(n)).sort();
    expect(rotated).toHaveLength(4);
    expect(new Set(rotated).size).toBe(4);
    const read = await persister.readRows();
    expect(read.rows.map((r) => (r.kind === "verdict" ? r.attemptID : ""))).toEqual(["c0:0", "c1:0", "c2:0", "c3:0", "c4:0"]);
  });

  it("QA-1.3-10: readRows reports the oldest row timestamp and how many rotated generations it read", async () => {
    const { deps, dir } = setup();
    const persister = createPersister(dir, deps, { maxBytes: 300, maxGenerations: 5 });
    expect(await persister.readRows()).toMatchObject({ oldestTs: null, generations: 0 });
    await persister.appendRows([verdictRow(5)]);
    expect(await persister.readRows()).toMatchObject({ oldestTs: ts(5), generations: 0 });
    for (const i of [9, 3, 7, 1, 8]) await persister.appendRows([verdictRow(i)]); // rows are not in timestamp order
    const read = await persister.readRows();
    expect(read.generations).toBeGreaterThanOrEqual(2);
    expect(read.generations).toBe(read.files.length - 1);
    expect(read.oldestTs).toBe(ts(1));
    // pruned history is gone: the oldest *retained* row moves forward
    const pruning = createPersister(join(dir, "pruning"), deps, { maxBytes: 100, maxGenerations: 1 });
    for (const i of [1, 2, 3, 4]) await pruning.appendRows([verdictRow(i)]);
    const pruned = await pruning.readRows();
    expect(pruned.generations).toBe(1);
    expect(pruned.oldestTs).toBe(ts(3));
  });

  it("never rotates an empty live file, so one oversized batch is written whole", async () => {
    const { mem, deps, dir } = setup();
    const persister = createPersister(dir, deps, { maxBytes: 50 });
    await persister.appendRows([verdictRow(1), verdictRow(2), verdictRow(3)]);
    expect([...mem.files.keys()]).toEqual([join(dir, DECISIONS_FILE)]);
    expect((await persister.readRows()).rows).toHaveLength(3);
  });

  it("maxGenerations 0 keeps only the live file", async () => {
    const { mem, deps, dir } = setup();
    const persister = createPersister(dir, deps, { maxBytes: 100, maxGenerations: 0 });
    for (let i = 0; i < 3; i++) await persister.appendRows([verdictRow(i)]);
    expect([...mem.files.keys()]).toEqual([join(dir, DECISIONS_FILE)]);
    expect((await persister.readRows()).rows).toHaveLength(1);
  });

  it("a torn last line after a crash and invalid lines are skipped and counted", async () => {
    const { mem, deps, dir } = setup();
    const persister = createPersister(dir, deps);
    await persister.appendRows([verdictRow(1), verdictRow(2)]);
    await mem.fs.appendText(join(dir, DECISIONS_FILE), `{"v":1,"kind":"verdict","ts":"2026-10`);
    let read = await persister.readRows();
    expect(read.rows).toHaveLength(2);
    expect(read.skipped).toBe(1);

    await mem.fs.appendText(join(dir, DECISIONS_FILE), `\n\n{"v":2,"kind":"verdict"}\r\n${JSON.stringify(verdictRow(9))}\r\n   \n`);
    read = await persister.readRows();
    expect(read.rows.map((r) => r.kind)).toEqual(["verdict", "verdict", "verdict"]);
    expect(read.skipped).toBe(2);
  });

  it("QA-1.3-9: a torn last line does not swallow the next batch (d3 survives)", async () => {
    const { mem, deps, dir } = setup();
    const persister = createPersister(dir, deps);
    const live = join(dir, DECISIONS_FILE);
    await persister.appendRows([verdictRow(1), verdictRow(2)]);
    const whole = JSON.stringify(verdictRow(99));
    await mem.fs.appendText(live, whole.slice(0, whole.length - 25)); // crash mid-line: no trailing newline
    await persister.appendRows([verdictRow(3)]);
    await persister.appendRows([verdictRow(4), verdictRow(5)]);
    const read = await persister.readRows();
    expect(read.rows.map((r) => (r.kind === "verdict" ? r.attemptID : ""))).toEqual(["c1:0", "c2:0", "c3:0", "c4:0", "c5:0"]);
    expect(read.skipped).toBe(1); // only the torn fragment
  });

  it("QA-1.3-9: the first batch of a (re)created live file has no leading newline, batches after it do", async () => {
    const { mem, deps, dir } = setup();
    const persister = createPersister(dir, deps, { maxBytes: 400, maxGenerations: 1 });
    const live = join(dir, DECISIONS_FILE);
    await persister.appendRows([verdictRow(1)]);
    expect(mem.files.get(live)?.text.startsWith("{")).toBe(true);
    await persister.appendRows([verdictRow(2)]); // rotates (would pass maxBytes): the new live file starts clean
    expect(mem.files.get(live)?.text.startsWith("{")).toBe(true);
    expect((await persister.readRows()).rows).toHaveLength(2);
    const small = createPersister(join(dir, "other"), deps);
    await small.appendRows([verdictRow(1)]);
    await small.appendRows([verdictRow(2)]);
    expect(mem.files.get(join(dir, "other", DECISIONS_FILE))?.text.split("\n").filter((l) => l !== "")).toHaveLength(2);
    expect(mem.files.get(join(dir, "other", DECISIONS_FILE))?.text).not.toContain("\n\n"); // QA-2.4-R2-10: no blank line between batches
  });

  it("QA-2.4-R2-10: two flush batches leave no blank line; a torn last line, or a file another writer touched, is still handled", async () => {
    const { mem, deps, dir } = setup();
    const live = join(dir, DECISIONS_FILE);
    const persister = createPersister(dir, deps);
    await persister.appendRows([verdictRow(1), verdictRow(2)]);
    await persister.appendRows([verdictRow(3)]);
    await persister.appendRows([verdictRow(4)]);
    expect(mem.files.get(live)?.text).toBe([1, 2, 3, 4].map((i) => `${JSON.stringify(verdictRow(i))}\n`).join(""));
    // a restart over a file that ends with a newline: still no blank line (the end is looked at once)
    const restarted = createPersister(dir, deps);
    await restarted.appendRows([verdictRow(5)]);
    expect(mem.files.get(live)?.text).not.toContain("\n\n");
    expect(mem.files.get(live)?.text.endsWith(`${JSON.stringify(verdictRow(5))}\n`)).toBe(true);
    // another writer left a fragment after this persister's last append: the next batch starts on a fresh line
    await mem.fs.appendText(live, `{"v":1,"kind":"verdict","ts":"2026-10`);
    await restarted.appendRows([verdictRow(6)]);
    const read = await restarted.readRows();
    expect(read.rows.map((r) => (r.kind === "verdict" ? r.attemptID : ""))).toEqual(["c1:0", "c2:0", "c3:0", "c4:0", "c5:0", "c6:0"]);
    expect(read.skipped).toBe(1);
  });

  it("readRows on a missing directory is empty and an unreadable generation is skipped with a warning", async () => {
    const { mem, deps, dir, logger } = setup();
    const persister = createPersister(dir, deps, { maxBytes: 100, maxGenerations: 5 });
    expect(await persister.readRows()).toEqual({ rows: [], skipped: 0, files: [], oldestTs: null, generations: 0 });
    for (let i = 0; i < 3; i++) await persister.appendRows([verdictRow(i)]);
    mem.hooks.readText = (path) => {
      if (DECISIONS_ROTATED_RE.test(basename(path))) throw fsError("EIO", "bad sector");
    };
    const read = await persister.readRows();
    expect(read.rows.map((r) => (r.kind === "verdict" ? r.attemptID : ""))).toEqual(["c2:0"]); // only the live file is readable
    expect(logger.warn).toHaveBeenCalledTimes(2);
    mem.hooks.readdir = () => {
      throw new Error("gone");
    };
    expect(await persister.readRows()).toEqual({ rows: [], skipped: 0, files: [], oldestTs: null, generations: 0 });
  });

  it("an ENOENT while rotating (another process rotated first) is ignored and the append proceeds", async () => {
    const { mem, deps, dir, logger } = setup();
    const persister = createPersister(dir, deps, { maxBytes: 100 });
    await persister.appendRows([verdictRow(1)]);
    mem.hooks.rename = () => {
      throw fsError("ENOENT");
    };
    expect(await persister.appendRows([verdictRow(2)])).toEqual({ ok: true });
    expect(logger.warn).not.toHaveBeenCalled();
    expect((await persister.readRows()).rows).toHaveLength(2);
  });

  it("a rotation that fails is logged and the rows still land in the live file", async () => {
    const { mem, deps, dir, logger } = setup();
    const persister = createPersister(dir, deps, { maxBytes: 100 });
    await persister.appendRows([verdictRow(1)]);
    mem.hooks.rename = () => {
      throw fsError("ENOSPC");
    };
    expect(await persister.appendRows([verdictRow(2)])).toEqual({ ok: true });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect((await persister.readRows()).rows).toHaveLength(2);
  });

  it("an append error is a failed WriteResult, not an exception", async () => {
    const { mem, deps, dir } = setup();
    const persister = createPersister(dir, deps);
    mem.hooks.appendText = () => {
      throw fsError("EIO", "write failed");
    };
    expect(await persister.appendRows([verdictRow(1)])).toEqual({ ok: false, error: "write failed", code: "EIO" });
  });

  it("compactStamp matches the rotated-name pattern", () => {
    expect(compactStamp(Date.UTC(2026, 9, 6, 12, 0, 0, 123))).toBe("20261006T120000123Z");
    expect(DECISIONS_ROTATED_RE.test(`decisions.${compactStamp(T0)}-7.jsonl`)).toBe(true);
    expect(DECISIONS_ROTATED_RE.test("decisions.jsonl")).toBe(false);
  });
});

describe("parseLogLine", () => {
  it.each(["none", "grader", "deterministic"] as const)("retains audit detection %s and nullable finite capabilities", (effective) => {
    const row = decisionRow(1, { detection: { effective, claimed: "deterministic" }, capability: { pick: 2, dispatched: null } });
    expect(parseLogLine(JSON.stringify(row))).toEqual(row);
    expect(parseLogLine(JSON.stringify(decisionRow(2)))).toEqual(decisionRow(2));
  });

  it("drops malformed audit metadata without discarding the decision", () => {
    const row = decisionRow(1);
    for (const bad of [null, "none", {}, { effective: "unknown" }]) {
      expect(parseLogLine(JSON.stringify({ ...row, detection: bad }))).toEqual(row);
    }
    expect(parseLogLine(JSON.stringify({ ...row, detection: { effective: "none", claimed: "unknown" } })))
      .toEqual({ ...row, detection: { effective: "none" } });
    for (const bad of [null, [], {}, { pick: "2", dispatched: 1 }, { pick: 2, dispatched: false }]) {
      expect(parseLogLine(JSON.stringify({ ...row, capability: bad }))).toEqual(row);
    }
    // JSON can encode a number that overflows the reader to Infinity.
    expect(parseLogLine(JSON.stringify({ ...row, capability: { pick: "overflow", dispatched: 1 } }).replace('"overflow"', '1e400'))).toEqual(row);
  });
  const roundTrip = (row: LogRow) => parseLogLine(JSON.stringify(row));

  it("accepts every row kind and returns an equal clean copy", () => {
    for (const row of [decisionRow(1), decisionRow(2, { best: null, childSessionID: "c9", unit: "usd", mode: "enforce", switched: true, pinned: true, resume: true }), verdictRow(3), verdictRow(4, { decisionID: null, verdict: "unverifiable", step: "variant" }), refusalRow(5)]) {
      expect(roundTrip(row)).toEqual(row);
    }
  });

  it("drops non-number cost values but keeps the row; ignores unknown extra fields", () => {
    const raw = { ...decisionRow(1), costs: { [KEY]: 1.5, [KEY_B]: null, other: "x", nan: Number.NaN }, futureField: { a: 1 } };
    const parsed = parseLogLine(JSON.stringify(raw));
    expect(parsed).not.toBeNull();
    expect(parsed?.kind === "decision" ? parsed.costs : null).toEqual({ [KEY]: 1.5 });
    expect(parsed).not.toHaveProperty("futureField");
  });

  it("keeps a well-formed classifier trace on a decision row (2.2) and drops a malformed one without losing the row", () => {
    const trace = {
      routeLines: { count: 2, conflict: true, edgeOnly: false },
      backend: { id: "host", status: "disagree", latencyMs: 12, label: "debug", disagrees: true as const },
      backendSkipped: "credentials" as const,
      argmin: decisionRow(9).chosen, // A27
    };
    expect(roundTrip(decisionRow(1, { trace }))).toEqual(decisionRow(1, { trace }));
    expect(roundTrip(decisionRow(2, { trace: { routeLines: { count: 0, conflict: false, edgeOnly: false }, backend: null } }))?.kind).toBe("decision");
    const noTrace = roundTrip(decisionRow(3));
    expect(noTrace).not.toHaveProperty("trace");
    for (const bad of [{ routeLines: { count: "1" } }, { routeLines: { count: 1, conflict: false, edgeOnly: false }, backend: { id: 1 } }, "x"]) {
      const parsed = parseLogLine(JSON.stringify({ ...decisionRow(4), trace: bad }));
      expect(parsed?.kind).toBe("decision");
      expect(parsed).not.toHaveProperty("trace");
    }
  });

  const base = (): Record<string, unknown> => JSON.parse(JSON.stringify(decisionRow(1))) as Record<string, unknown>;
  const verdictBase = (): Record<string, unknown> => JSON.parse(JSON.stringify(verdictRow(1))) as Record<string, unknown>;
  const mutate = (source: () => Record<string, unknown>, change: (r: Record<string, unknown>) => void): string => {
    const r = source();
    change(r);
    return JSON.stringify(r);
  };
  const facts = (r: Record<string, unknown>) => r.facts as Record<string, unknown>;
  const chosen = (r: Record<string, unknown>) => r.chosen as Record<string, unknown>;
  const best = (r: Record<string, unknown>) => r.best as Record<string, unknown>;

  it.each([
    ["not JSON", "{"],
    ["a JSON array", "[]"],
    ["a JSON string", '"x"'],
    ["null", "null"],
    ["v = 2", mutate(base, (r) => void (r.v = 2))],
    ["an unknown kind", mutate(base, (r) => void (r.kind = "other"))],
    ["a bad ts", mutate(base, (r) => void (r.ts = "yesterday"))],
    ["a numeric ts", mutate(base, (r) => void (r.ts = 5))],
    ["a missing sessionID", mutate(base, (r) => void delete r.sessionID)],
    ["an unknown step", mutate(base, (r) => void (r.step = "explore"))],
    ["an unknown mode (static writes nothing)", mutate(base, (r) => void (r.mode = "static"))],
    ["an unknown unit", mutate(base, (r) => void (r.unit = "eur"))],
    ["a non-boolean switched", mutate(base, (r) => void (r.switched = "no"))],
    ["a non-boolean pinned", mutate(base, (r) => void (r.pinned = 0))],
    ["a non-boolean resume", mutate(base, (r) => void delete r.resume)],
    ["a null confidence", mutate(base, (r) => void (r.confidence = null))],
    ["a missing reason", mutate(base, (r) => void delete r.reason)],
    ["a numeric decisionID", mutate(base, (r) => void (r.decisionID = 5))],
    ["a numeric childSessionID", mutate(base, (r) => void (r.childSessionID = 5))],
    ["missing facts", mutate(base, (r) => void delete r.facts)],
    ["facts.needs not an array", mutate(base, (r) => void (facts(r).needs = "edit"))],
    ["facts.needs with a number", mutate(base, (r) => void (facts(r).needs = ["edit", 1]))],
    ["facts.confidence null", mutate(base, (r) => void (facts(r).confidence = null))],
    ["facts.class numeric", mutate(base, (r) => void (facts(r).class = 1))],
    ["facts.source missing", mutate(base, (r) => void delete facts(r).source)],
    ["an invalid chosen.key", mutate(base, (r) => void (chosen(r).key = "garbage"))],
    ["a missing chosen", mutate(base, (r) => void delete r.chosen)],
    ["an invalid chosen.origin", mutate(base, (r) => void (chosen(r).origin = "plugin"))],
    ["an invalid best.key", mutate(base, (r) => void (best(r).key = "a|b"))],
    ["a non-object best", mutate(base, (r) => void (r.best = 7))],
    ["costs not an object", mutate(base, (r) => void (r.costs = [1, 2]))],
    ["verdict: an unknown verdict", mutate(verdictBase, (r) => void (r.verdict = "maybe"))],
    ["verdict: an invalid key", mutate(verdictBase, (r) => void (r.key = "x"))],
    ["verdict: a missing attemptID", mutate(verdictBase, (r) => void delete r.attemptID)],
    ["verdict: a missing childSessionID", mutate(verdictBase, (r) => void delete r.childSessionID)],
    ["verdict: a numeric decisionID", mutate(verdictBase, (r) => void (r.decisionID = 1))],
  ])("rejects %s", (_name, line) => {
    expect(parseLogLine(line)).toBeNull();
  });

  it("accepts a decision with a null best and a refusal with a null decisionID", () => {
    expect(parseLogLine(mutate(base, (r) => void (r.best = null)))).not.toBeNull();
    expect(roundTrip(refusalRow(1))).toEqual(refusalRow(1));
    // QA-2.1-3: the optional marker survives; anything but "pass" is dropped
    expect(roundTrip({ ...refusalRow(1), overrides: "pass" })).toEqual({ ...refusalRow(1), overrides: "pass" });
    expect(parseLogLine(JSON.stringify({ ...refusalRow(1), overrides: "fail" }))).toEqual(refusalRow(1));
  });
});

// ---------------------------------------------------------------------------
// Coexistence with the scorecard writer
// ---------------------------------------------------------------------------

describe("coexistence with *.scorecard.log (D15)", () => {
  it("never opens, renames, deletes or lists scorecard files, whatever load/save/rotate/prune do", async () => {
    const { mem, deps, dir } = setup();
    const scorecards = [join(dir, "ses_1.scorecard.log"), join(dir, "ses_2.scorecard.log"), join(dir, "decisions.scorecard.log")];
    scorecards.forEach((p, i) => mem.files.set(p, { text: `scorecard ${i}\nline two\n`, mtimeMs: 1 }));
    const before = scorecards.map((p) => mem.files.get(p)?.text);

    const persister = createPersister(dir, deps, { maxBytes: 150, maxGenerations: 1 });
    await persister.load({ quarantine: true });
    await persister.load({ quarantine: false });
    await persister.saveSnapshot(snapshotOf("pass"));
    for (let i = 0; i < 8; i++) await persister.appendRows([verdictRow(i)]);
    const read = await persister.readRows();

    expect(scorecards.map((p) => mem.files.get(p)?.text)).toEqual(before);
    expect(read.files.some((f) => f.endsWith(".scorecard.log"))).toBe(false);
    expect(read.rows.length).toBeGreaterThan(0);
    const ops = mem.touched.filter((t) => t.op !== "readdir" && t.op !== "mkdirp");
    expect(ops.filter((t) => t.path.endsWith(".scorecard.log"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The real node fs
// ---------------------------------------------------------------------------

describe("nodePersistFs and a real directory", { timeout: 60_000 }, () => {
  const made: string[] = [];
  afterEach(async () => {
    while (made.length > 0) await rm(made.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "omr-outcomes-fs-"));
    made.push(dir);
    return dir;
  }

  it("B8 handoff: real flusher disk round-trip keeps the numerical never-down audit", async () => {
    const dir = await tempDir();
    const logger = makeLogger();
    const deps: PersistDeps = { fs: nodePersistFs(), now: Date.now, sleep: async () => undefined, logger, pid: process.pid };
    const persister = createPersister(dir, deps);
    const flusher = createFlusher(createOutcomeStore(), persister, { now: Date.now, scheduler: nodeScheduler(), logger });
    const base = decisionRow(1);
    const row = decisionRow(1, {
      facts: { ...base.facts, risk: "high" },
      detection: { effective: "none", claimed: "deterministic" },
      capability: { pick: 2, dispatched: 2 },
    });
    flusher.enqueue(row);
    flusher.enqueue(decisionRow(2)); // pre-A34 rows remain readable and are not audited
    await flusher.dispose();
    const disk = await createPersister(dir, deps).readRows();
    expect(disk.rows).toEqual([row, decisionRow(2)]);
    const table = summarize(null, disk.rows, { since: null, until: null });
    expect(table.neverDown).toEqual({ below: 0, recorded: 1 });
    const audit = renderMarkdown(table).split("\n").find((line) => line.includes("D9 never-down"));
    expect(audit).toContain("0 of 1 recorded");
    expect(audit).not.toContain("n/a");
  });

  it("implements the PersistFs contract (ENOENT mappings, durable write, rename over an existing file)", async () => {
    const dir = await tempDir();
    const fs = nodePersistFs();
    const file = join(dir, "sub", "a.txt");
    expect(await fs.readText(file)).toBeNull();
    expect(await fs.stat(file)).toBeNull();
    expect(await fs.readdir(join(dir, "missing"))).toEqual([]);
    await fs.unlink(file); // ENOENT is not an error
    await fs.mkdirp(join(dir, "sub"));
    await fs.mkdirp(join(dir, "sub")); // idempotent
    await fs.writeDurable(file, "one");
    await fs.appendText(file, "+two");
    expect(await fs.readText(file)).toBe("one+two");
    expect((await fs.stat(file))?.size).toBe(7);
    const other = join(dir, "sub", "b.txt");
    await fs.writeDurable(other, "replacement");
    await fs.rename(other, file);
    expect(await fs.readText(file)).toBe("replacement");
    expect(await fs.readdir(join(dir, "sub"))).toEqual(["a.txt"]);
    await expect(fs.rename(join(dir, "nope"), join(dir, "x"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("a real persister saves, loads, appends, rotates and reads back", async () => {
    const dir = join(await tempDir(), "nested", "outcomes");
    const logger = makeLogger();
    const deps: PersistDeps = { fs: nodePersistFs(), now: Date.now, sleep: async () => undefined, logger, pid: process.pid };
    const persister = createPersister(dir, deps, { maxBytes: 400, maxGenerations: 2 });
    const snapshot = snapshotOf("pass", "fail");
    expect(await persister.saveSnapshot(snapshot)).toEqual({ ok: true });
    expect(await persister.saveSnapshot(snapshot)).toEqual({ ok: true }); // rename over the existing file
    expect((await persister.load()).snapshot).toEqual(snapshot);
    for (let i = 0; i < 12; i++) await persister.appendRows([verdictRow(i)]);
    const names = await readdir(dir);
    expect(names.filter((n) => DECISIONS_ROTATED_RE.test(n)).length).toBeLessThanOrEqual(2);
    expect(names.some((n) => n.startsWith(OUTCOMES_TMP_PREFIX))).toBe(false);
    const read = await persister.readRows();
    expect(read.skipped).toBe(0);
    expect(read.rows.length).toBeGreaterThan(0);
    const ids = read.rows.map((r) => (r.kind === "verdict" ? Number(r.attemptID.slice(1, -2)) : -1));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(logger.warn).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(join(dir, OUTCOMES_FILE), "utf8")).schema).toBe(OUTCOMES_SCHEMA_ID);
    expect((await stat(join(dir, DECISIONS_FILE))).size).toBeGreaterThan(0);
    await writeFile(join(dir, OUTCOMES_FILE), "{broken", "utf8");
    expect((await persister.load()).status).toBe("corrupt");
    expect((await readdir(dir)).some((n) => OUTCOMES_CORRUPT_RE.test(n))).toBe(true);
  });

  it("nodeScheduler timers are unref'd so they never keep the process alive", () => {
    const scheduler = nodeScheduler();
    const fn = vi.fn();
    const handle = scheduler.setTimer(fn, 60_000) as NodeJS.Timeout;
    expect(handle.hasRef()).toBe(false);
    scheduler.clearTimer(handle);
    expect(fn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Flusher
// ---------------------------------------------------------------------------

interface ManualTimer {
  readonly fn: () => void;
  readonly ms: number;
  cleared: boolean;
  fired: boolean;
}

function manualScheduler() {
  const timers: ManualTimer[] = [];
  const scheduler: FlushScheduler = {
    setTimer(fn, ms) {
      const timer: ManualTimer = { fn, ms, cleared: false, fired: false };
      timers.push(timer);
      return timer;
    },
    clearTimer(handle) {
      (handle as ManualTimer).cleared = true;
    },
  };
  const pending = () => timers.filter((t) => !t.cleared && !t.fired);
  async function fireNext(): Promise<void> {
    const timer = pending()[0];
    if (!timer) throw new Error("no pending timer");
    timer.fired = true;
    timer.fn();
    await tick();
  }
  return { scheduler, timers, pending, fireNext };
}

function fakePersister() {
  const saves: OutcomeSnapshot[] = [];
  const appends: LogRow[][] = [];
  const gate: { save: Promise<void> | null; append: Promise<void> | null } = { save: null, append: null };
  const results: { save: WriteResult; append: WriteResult } = { save: { ok: true }, append: { ok: true } };
  const persister = {
    async saveSnapshot(snapshot: OutcomeSnapshot): Promise<WriteResult> {
      saves.push(snapshot);
      if (gate.save) await gate.save;
      return results.save;
    },
    async appendRows(rows: readonly LogRow[]): Promise<WriteResult> {
      appends.push([...rows]);
      if (gate.append) await gate.append;
      return results.append;
    },
  };
  return { persister, saves, appends, gate, results };
}

function flusherSetup(options: Parameters<typeof createFlusher>[3] = {}) {
  const c = clock();
  const store = createOutcomeStore({ now: c.now });
  const sched = manualScheduler();
  const fake = fakePersister();
  const logger = makeLogger();
  const flusher = createFlusher(store, fake.persister, { now: c.now, scheduler: sched.scheduler, logger }, options);
  let n = 0;
  const mutate = () => store.recordVerdict(KEY, "pass", { attemptID: `m${n++}`, step: "dispatch" });
  return { c, store, sched, fake, logger, flusher, mutate };
}

describe("flusher: coalescing and throttling (D15)", () => {
  it("enqueue does no I/O and no await: it only queues the row and arms one zero-delay timer", () => {
    const { flusher, sched, fake } = flusherSetup();
    flusher.enqueue(decisionRow(1));
    flusher.enqueue(decisionRow(2));
    expect(flusher.pendingRows).toBe(2);
    expect(fake.saves).toHaveLength(0);
    expect(fake.appends).toHaveLength(0);
    expect(sched.pending()).toHaveLength(1);
    expect(sched.timers[0]?.ms).toBe(0);
  });

  it("10 synchronous requestFlush calls → 1 timer, 1 saveSnapshot, 1 appendRows", async () => {
    const { flusher, sched, fake, mutate } = flusherSetup();
    mutate();
    flusher.enqueue(decisionRow(1));
    const requests = Array.from({ length: 10 }, () => flusher.requestFlush());
    expect(sched.timers).toHaveLength(1);
    await sched.fireNext();
    await Promise.all(requests);
    expect(fake.saves).toHaveLength(1);
    expect(fake.appends).toHaveLength(1);
    expect(fake.appends[0]).toHaveLength(1);
    expect(sched.timers).toHaveLength(1);
  });

  it("5 requests during an in-flight flush → exactly one follow-up, minIntervalMs later", async () => {
    const { flusher, sched, fake, mutate, store } = flusherSetup();
    mutate();
    void flusher.requestFlush();
    const hold = deferred();
    fake.gate.save = hold.promise;
    await sched.fireNext(); // flush starts and blocks inside saveSnapshot
    expect(fake.saves).toHaveLength(1);
    for (let i = 0; i < 5; i++) {
      mutate();
      void flusher.requestFlush();
    }
    expect(sched.timers).toHaveLength(1);
    fake.gate.save = null;
    hold.resolve();
    await tick();
    expect(sched.pending()).toHaveLength(1);
    expect(sched.pending()[0]?.ms).toBe(30_000);
    expect(sched.timers).toHaveLength(2);
    await sched.fireNext();
    expect(fake.saves).toHaveLength(2);
    expect(fake.saves[1]?.entries[KEY]?.counts.pass).toBe(6);
    expect(sched.timers).toHaveLength(2);
    expect(store.revision).toBe(6);
  });

  it("throttles: a request 10 s after a flush waits for the remaining 20 s", async () => {
    const { flusher, sched, c, mutate } = flusherSetup();
    mutate();
    void flusher.requestFlush();
    await sched.fireNext();
    c.advance(10_000);
    mutate();
    void flusher.requestFlush();
    expect(sched.pending()[0]?.ms).toBe(20_000);
    c.advance(60_000);
    mutate();
    // already armed: no second timer
    void flusher.requestFlush();
    expect(sched.pending()).toHaveLength(1);
  });

  it("nothing to write → no timer; the snapshot is written only when the revision moved", async () => {
    const { flusher, sched, fake, mutate } = flusherSetup();
    await flusher.requestFlush();
    expect(sched.timers).toHaveLength(0);
    flusher.enqueue(decisionRow(1));
    await sched.fireNext();
    expect(fake.saves).toHaveLength(0);
    expect(fake.appends).toHaveLength(1);
    mutate();
    void flusher.requestFlush();
    await sched.fireNext();
    expect(fake.saves).toHaveLength(1);
  });

  it("rows are appended in batches of at most batchRows", async () => {
    const { flusher, sched, fake } = flusherSetup({ batchRows: 1000 });
    for (let i = 0; i < 2500; i++) flusher.enqueue(verdictRow(i));
    await sched.fireNext();
    expect(fake.appends.map((b) => b.length)).toEqual([1000, 1000, 500]);
    expect(flusher.pendingRows).toBe(0);
  });

  it("requestFlush resolves once the flusher is quiescent", async () => {
    const { flusher, sched, mutate } = flusherSetup();
    mutate();
    let done = false;
    void flusher.requestFlush().then(() => void (done = true));
    await tick();
    expect(done).toBe(false);
    await sched.fireNext();
    await tick();
    expect(done).toBe(true);
  });

  it("the writtenRevision is the one read before the snapshot: a mutation during the save triggers a follow-up", async () => {
    const { flusher, sched, fake, mutate } = flusherSetup();
    mutate();
    void flusher.requestFlush();
    const hold = deferred();
    fake.gate.save = hold.promise;
    await sched.fireNext();
    mutate(); // lands while the first snapshot is being written
    fake.gate.save = null;
    hold.resolve();
    await tick();
    expect(sched.pending()).toHaveLength(1);
    await sched.fireNext();
    expect(fake.saves).toHaveLength(2);
    await tick();
    expect(sched.pending()).toHaveLength(0);
  });

  it("a flusher created on a non-empty store does not rewrite what was already loaded", async () => {
    const c = clock();
    const store = createOutcomeStore({ now: c.now });
    store.recordVerdict(KEY, "pass", { attemptID: "a", step: "dispatch" });
    const sched = manualScheduler();
    const fake = fakePersister();
    const flusher = createFlusher(store, fake.persister, { now: c.now, scheduler: sched.scheduler, logger: makeLogger() });
    await flusher.requestFlush();
    expect(sched.timers).toHaveLength(0);
  });
});

describe("flusher: failures, drops, flushNow, dispose", () => {
  it("N7: snapshot and log failures have independent warning and recovery streaks", async () => {
    const { flusher, fake, logger, mutate } = flusherSetup();
    fake.results.save = { ok: false, error: "snapshot denied" };
    fake.results.append = { ok: false, error: "append denied" };
    mutate();
    flusher.enqueue(verdictRow(1));
    await flusher.flushNow();
    await flusher.flushNow();
    expect(logger.warn).toHaveBeenCalledTimes(2);
    fake.results.save = { ok: true };
    await flusher.flushNow();
    expect(logger.info).toHaveBeenCalledWith("[router] outcome persistence recovered", { what: "snapshot" });
    fake.results.save = { ok: false, error: "snapshot denied again" };
    mutate();
    await flusher.flushNow();
    expect(logger.warn).toHaveBeenCalledTimes(3);
    fake.results.append = { ok: true };
    await flusher.flushNow();
    expect(logger.info).toHaveBeenCalledWith("[router] outcome persistence recovered", { what: "decision log" });
    fake.results.save = { ok: true };
    await flusher.dispose();
  });
  it("a failing snapshot warns once per streak, keeps retrying, and logs one info on recovery", async () => {
    const { flusher, sched, fake, logger, mutate } = flusherSetup();
    fake.results.save = { ok: false, error: "disk full", code: "ENOSPC" };
    mutate();
    void flusher.requestFlush();
    await sched.fireNext();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(sched.pending()).toHaveLength(1);
    expect(sched.pending()[0]?.ms).toBe(30_000);
    await sched.fireNext();
    await sched.fireNext();
    expect(fake.saves).toHaveLength(3);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
    fake.results.save = { ok: true };
    await sched.fireNext();
    expect(logger.info).toHaveBeenCalledTimes(1);
    await tick();
    expect(sched.pending()).toHaveLength(0);
  });

  it("QA-1.3-2: 1000 requestFlush calls with a failing save all resolve when the attempt finishes (no leaked waiters)", async () => {
    const { flusher, sched, fake, logger, mutate } = flusherSetup();
    fake.results.save = { ok: false, error: "disk full", code: "ENOSPC" };
    mutate();
    const requests = Array.from({ length: 1000 }, () => flusher.requestFlush());
    expect(sched.timers).toHaveLength(1);
    let resolved = 0;
    for (const r of requests) void r.then(() => void resolved++);
    await tick();
    expect(resolved).toBe(0);
    await sched.fireNext();
    await tick();
    expect(resolved).toBe(1000); // the attempt failed, the callers are released anyway
    expect(fake.saves).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    // the retry is one unref'd timer at the throttle interval, and requests made later wait for *that* attempt
    expect(sched.pending()).toHaveLength(1);
    expect(sched.pending()[0]?.ms).toBe(30_000);
    const later = Array.from({ length: 1000 }, () => flusher.requestFlush());
    expect(sched.pending()).toHaveLength(1);
    await sched.fireNext();
    await Promise.all(later);
    expect(fake.saves).toHaveLength(2);
    expect(sched.pending()).toHaveLength(1); // still failing: one retry timer, never a pile of them
  });

  it("QA-1.3-2: requests made while a flush is running are released by the next attempt, not the running one", async () => {
    const { flusher, sched, fake, mutate } = flusherSetup();
    mutate();
    void flusher.requestFlush();
    const hold = deferred();
    fake.gate.save = hold.promise;
    await sched.fireNext();
    mutate();
    let released = false;
    void flusher.requestFlush().then(() => void (released = true));
    fake.gate.save = null;
    hold.resolve();
    await tick();
    expect(released).toBe(false); // the running attempt started before this request
    expect(sched.pending()).toHaveLength(1);
    await sched.fireNext();
    await tick();
    expect(released).toBe(true);
    expect(fake.saves).toHaveLength(2);
  });

  it("QA-1.3-2: enqueue arms a flush without creating a promise or a waiter", async () => {
    const { flusher, sched, fake } = flusherSetup();
    const NativePromise = Promise;
    let created = 0;
    class CountingPromise<T> extends NativePromise<T> {
      constructor(executor: (resolve: (value: T | PromiseLike<T>) => void, reject: (reason?: unknown) => void) => void) {
        super(executor);
        created += 1;
      }
    }
    vi.stubGlobal("Promise", CountingPromise);
    try {
      for (let i = 0; i < 100; i++) flusher.enqueue(verdictRow(i));
    } finally {
      vi.unstubAllGlobals();
    }
    expect(created).toBe(0);
    expect(sched.timers).toHaveLength(1);
    await sched.fireNext();
    expect(fake.appends.flat()).toHaveLength(100);
  });

  it("QA-1.3-2: a read-only store is not pending work: one warning, no retry timer, rows still flow", async () => {
    const { mem, deps, dir, logger } = setup();
    const path = join(dir, OUTCOMES_FILE);
    const newer = JSON.stringify({ schema: OUTCOMES_SCHEMA_ID, version: 2, entries: {} });
    mem.files.set(path, { text: newer, mtimeMs: 1 });
    const persister = createPersister(dir, deps);
    expect((await persister.load()).status).toBe("unsupported-version");
    logger.warn.mockClear();

    const store = createOutcomeStore({ now: deps.now });
    const sched = manualScheduler();
    const flusher = createFlusher(store, persister, { now: deps.now, scheduler: sched.scheduler, logger });
    store.recordVerdict(KEY, "pass", { attemptID: "a", step: "dispatch" });
    flusher.enqueue(verdictRow(1));
    await sched.fireNext();
    await tick();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(sched.pending()).toHaveLength(0); // no permanent retry timer
    expect(mem.files.get(path)?.text).toBe(newer);
    expect((await persister.readRows()).rows).toHaveLength(1);

    // later changes neither arm a timer nor leave a waiter behind; rows still do
    store.recordVerdict(KEY, "pass", { attemptID: "b", step: "dispatch" });
    await flusher.requestFlush();
    expect(sched.pending()).toHaveLength(0);
    flusher.enqueue(verdictRow(2));
    expect(sched.pending()).toHaveLength(1);
    await sched.fireNext();
    await tick();
    expect((await persister.readRows()).rows).toHaveLength(2);
    expect(sched.pending()).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("QA-1.3-3: the flush delay is clamped to [0, minIntervalMs] and a clock that went back a day resets the window", async () => {
    const { flusher, sched, c, mutate } = flusherSetup();
    mutate();
    void flusher.requestFlush();
    await sched.fireNext(); // flush ends at T0
    await tick();
    c.set(T0 - 86_400_000);
    mutate();
    void flusher.requestFlush();
    expect(sched.pending()).toHaveLength(1);
    expect(sched.pending()[0]?.ms).toBe(30_000); // not 30 s + one day
    await sched.fireNext();
    await tick();
    // the clock jumping far ahead never makes the delay negative or larger than the interval
    c.set(T0 + 10 * 86_400_000);
    mutate();
    void flusher.requestFlush();
    expect(sched.pending()[0]?.ms).toBe(0);
    await sched.fireNext();
    await tick();
    c.advance(12_000);
    mutate();
    void flusher.requestFlush();
    expect(sched.pending()[0]?.ms).toBe(18_000);
  });

  it("QA-1.3-3: a non-finite clock never produces a NaN delay", async () => {
    const { flusher, sched, c, mutate } = flusherSetup();
    mutate();
    void flusher.requestFlush();
    await sched.fireNext();
    await tick();
    c.set(Number.NaN);
    mutate();
    void flusher.requestFlush();
    const ms = sched.pending()[0]?.ms ?? Number.NaN;
    expect(Number.isFinite(ms)).toBe(true);
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(ms).toBeLessThanOrEqual(30_000);
  });

  it("a failed append puts the batch back at the front, trims to maxQueuedRows and warns about the drops", async () => {
    const { flusher, sched, fake, logger } = flusherSetup({ maxQueuedRows: 5, batchRows: 3 });
    fake.results.append = { ok: false, error: "io" };
    for (let i = 0; i < 5; i++) flusher.enqueue(verdictRow(i));
    await sched.fireNext();
    expect(fake.appends).toHaveLength(1);
    expect(flusher.pendingRows).toBe(5);
    flusher.enqueue(verdictRow(5));
    flusher.enqueue(verdictRow(6));
    expect(flusher.pendingRows).toBe(5);
    fake.results.append = { ok: true };
    await sched.fireNext();
    const written = fake.appends.slice(1).flat();
    expect(written.map((r) => (r.kind === "verdict" ? r.attemptID : ""))).toEqual(["c2:0", "c3:0", "c4:0", "c5:0", "c6:0"]);
    const dropWarnings = logger.warn.mock.calls.filter((c) => String(c[0]).includes("dropped"));
    expect(dropWarnings).toHaveLength(1);
    expect(dropWarnings[0]?.[1]).toEqual({ dropped: 2 });
  });

  it("the queue drops its oldest rows beyond maxQueuedRows (default 5000)", () => {
    const { flusher } = flusherSetup();
    for (let i = 0; i < 5100; i++) flusher.enqueue(verdictRow(i));
    expect(flusher.pendingRows).toBe(5000);
  });

  it("an unexpected rejection inside a flush is contained and reported", async () => {
    const { flusher, sched, fake, logger, mutate } = flusherSetup();
    fake.persister.saveSnapshot = async () => {
      throw new Error("kaboom");
    };
    mutate();
    void flusher.requestFlush();
    await sched.fireNext();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0]?.[1]?.error)).toContain("kaboom");
  });

  it("a scheduler that throws never makes enqueue throw", () => {
    const c = clock();
    const store = createOutcomeStore({ now: c.now });
    const logger = makeLogger();
    const scheduler: FlushScheduler = {
      setTimer() {
        throw new Error("no timers");
      },
      clearTimer() {
        throw new Error("no timers");
      },
    };
    const flusher = createFlusher(store, fakePersister().persister, { now: c.now, scheduler, logger });
    expect(() => flusher.enqueue(verdictRow(1))).not.toThrow();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(flusher.pendingRows).toBe(1);
  });

  it("flushNow bypasses the throttle, cancels the pending timer and writes immediately", async () => {
    const { flusher, sched, fake, mutate, c } = flusherSetup();
    mutate();
    void flusher.requestFlush();
    await sched.fireNext();
    c.advance(1000);
    mutate();
    flusher.enqueue(decisionRow(1));
    expect(sched.pending()[0]?.ms).toBe(29_000);
    await flusher.flushNow();
    expect(sched.pending()).toHaveLength(0);
    expect(fake.saves).toHaveLength(2);
    expect(fake.appends).toHaveLength(1);
    expect(flusher.pendingRows).toBe(0);
  });

  it("flushNow waits for an in-flight flush before running its own", async () => {
    const { flusher, sched, fake, mutate } = flusherSetup();
    mutate();
    void flusher.requestFlush();
    const hold = deferred();
    fake.gate.save = hold.promise;
    await sched.fireNext();
    mutate();
    let finished = false;
    const pending = flusher.flushNow().then(() => void (finished = true));
    await tick();
    expect(finished).toBe(false);
    expect(fake.saves).toHaveLength(1);
    fake.gate.save = null;
    hold.resolve();
    await pending;
    expect(fake.saves).toHaveLength(2);
    expect(sched.pending()).toHaveLength(0);
  });

  it("dispose flushes, cancels timers, drops later rows and is idempotent", async () => {
    const { flusher, sched, fake, mutate } = flusherSetup();
    mutate();
    flusher.enqueue(decisionRow(1));
    const waiter = flusher.requestFlush();
    await Promise.all([flusher.dispose(), flusher.dispose()]);
    await waiter;
    expect(fake.saves).toHaveLength(1);
    expect(fake.appends).toHaveLength(1);
    expect(sched.pending()).toHaveLength(0);
    flusher.enqueue(decisionRow(2));
    expect(flusher.pendingRows).toBe(0);
    mutate();
    await flusher.requestFlush();
    await flusher.dispose();
    expect(fake.saves).toHaveLength(1);
    expect(sched.pending()).toHaveLength(0);
  });

  it("QA-1.3-1: a flush waits for deps.ready and takes its snapshot only afterwards", async () => {
    const c = clock();
    const store = createOutcomeStore({ now: c.now });
    const sched = manualScheduler();
    const fake = fakePersister();
    const gate = deferred();
    const flusher = createFlusher(store, fake.persister, { now: c.now, scheduler: sched.scheduler, logger: makeLogger(), ready: gate.promise });
    store.recordVerdict(KEY, "pass", { attemptID: "a", step: "dispatch" });
    void flusher.requestFlush();
    await sched.fireNext();
    expect(fake.saves).toHaveLength(0);
    // the "load" merges disk evidence while the flush is parked
    const disk = createOutcomeStore({ now: c.now });
    disk.recordVerdict(KEY, "pass", { attemptID: "d", step: "dispatch" });
    store.fromSnapshot(disk.snapshot(), { mode: "merge" });
    gate.resolve();
    await tick();
    expect(fake.saves).toHaveLength(1);
    expect(fake.saves[0]?.entries[KEY]?.counts.pass).toBe(2);
  });

  it("dispose after a failing flush still cancels the retry timer", async () => {
    const { flusher, sched, fake, mutate } = flusherSetup();
    fake.results.save = { ok: false, error: "nope" };
    mutate();
    await flusher.dispose();
    expect(sched.pending()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Two processes on one directory (QA-1.3-4): disk + (memory − baseline), never plain memory over it
// ---------------------------------------------------------------------------

describe("foreign writers (QA-1.3-4)", () => {
  function twoProcesses() {
    const base = setup("omr-foreign");
    const make = (pid: number) => {
      const deps: PersistDeps = { ...base.deps, pid };
      const store = createOutcomeStore({ now: base.c.now });
      const persister = createPersister(base.dir, deps);
      const sched = manualScheduler();
      const flusher = createFlusher(store, persister, { now: base.c.now, scheduler: sched.scheduler, logger: base.logger });
      let n = 0;
      const record = (verdict: "pass" | "fail") => store.recordVerdict(KEY, verdict, { attemptID: `p${pid}-${n++}`, step: "dispatch" });
      return { store, persister, flusher, record, sched };
    };
    const a = make(1);
    const b = make(2);
    const onDisk = async () => (await createPersister(base.dir, base.deps).load({ quarantine: false })).snapshot.entries[KEY];
    return { ...base, a, b, onDisk };
  }

  it("QA-G-C1: interleaved writers retain all ten passes, even with identical mtimes", async () => {
    const { a, b, mem, onDisk, logger } = twoProcesses();
    await a.persister.load();
    await b.persister.load();
    for (let i = 0; i < 5; i++) a.record("pass");
    await a.flusher.flushNow();
    for (let i = 0; i < 3; i++) b.record("pass");
    let entered!: () => void;
    let release!: () => void;
    const writing = new Promise<void>((resolve) => { entered = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    mem.hooks.writeDurable = async () => { entered(); await hold; };
    const bFlush = b.flusher.flushNow();
    await writing; // B has read/merged, but not yet renamed its snapshot.
    a.record("pass");
    a.record("pass");
    await a.flusher.flushNow(); // must not overwrite B's in-flight transaction
    await a.flusher.flushNow(); // bounded failure, log only once
    expect(logger.warn.mock.calls.filter(([message]) => message.includes("snapshot write failed"))).toHaveLength(1);
    release();
    await bFlush;
    delete mem.hooks.writeDurable;
    await a.flusher.flushNow(); // pending snapshot absorbs B then saves all ten
    expect((await onDisk())?.counts.pass).toBe(10);
    await a.flusher.dispose();
    await b.flusher.dispose();
  });

  it("A saves 5 passes, B saves 3 fails, A saves again: the disk keeps B's fails and A's new passes", async () => {
    const { a, b, c, onDisk, logger } = twoProcesses();
    await a.persister.load();
    await b.persister.load();
    for (let i = 0; i < 5; i++) a.record("pass");
    await a.flusher.flushNow();
    expect((await onDisk())?.counts).toMatchObject({ pass: 5, fail: 0 });

    c.advance(1000);
    for (let i = 0; i < 3; i++) b.record("fail");
    await b.flusher.flushNow(); // B notices A's write: it merges instead of overwriting
    expect((await onDisk())?.counts).toMatchObject({ pass: 5, fail: 3 });
    expect(b.store.snapshot().entries[KEY]?.counts).toMatchObject({ pass: 5, fail: 3 });

    c.advance(1000);
    for (let i = 0; i < 2; i++) a.record("pass");
    await a.flusher.flushNow(); // A notices B's write
    const disk = await onDisk();
    expect(disk?.counts).toMatchObject({ pass: 7, fail: 3 });
    expect(disk?.beta.alpha).toBeCloseTo(7, 3);
    expect(disk?.beta.beta).toBeCloseTo(3, 3);
    expect(a.store.snapshot().entries[KEY]?.counts).toMatchObject({ pass: 7, fail: 3 });

    // B is stale until its next write, which brings in A's two passes (and nothing is counted twice)
    c.advance(1000);
    b.record("fail");
    await b.flusher.flushNow();
    expect((await onDisk())?.counts).toMatchObject({ pass: 7, fail: 4 });
    c.advance(1000);
    await a.flusher.flushNow(); // clean: nothing to write, nothing to merge
    a.record("pass");
    await a.flusher.flushNow();
    expect((await onDisk())?.counts).toMatchObject({ pass: 8, fail: 4 });
    expect(logger.warn.mock.calls.filter((call) => String(call[0]).includes("another process writes"))).toHaveLength(2); // once per process
  });

  it("QA-1.3-16: outcomes.json deleted, a fresh process writes 1 fail, A saves: the disk has A's 3 fails plus the new one", async () => {
    const { a, b, c, mem, dir, onDisk } = twoProcesses();
    await a.persister.load();
    for (let i = 0; i < 3; i++) a.record("fail");
    await a.flusher.flushNow();
    expect((await onDisk())?.counts).toMatchObject({ fail: 3 });

    mem.files.delete(join(dir, OUTCOMES_FILE)); // reset by hand / restored backup / cleaner
    c.advance(1000);
    await b.persister.load(); // a fresh process starts from nothing
    b.record("fail");
    await b.flusher.flushNow();
    expect((await onDisk())?.counts).toMatchObject({ fail: 1 });

    c.advance(1000);
    a.record("pass"); // A is dirty again
    await a.flusher.flushNow(); // disk (1 fail) is below A's baseline (3 fails): a new lineage, absorbed whole
    expect((await onDisk())?.counts).toMatchObject({ pass: 1, fail: 4 });
    expect(a.store.snapshot().entries[KEY]?.counts).toMatchObject({ pass: 1, fail: 4 });
  });

  it("cost statistics merge exactly while under the cap (attempt-weighted means)", async () => {
    const { a, b, c, onDisk } = twoProcesses();
    const tokens = { ...emptyTokenSample(), input: 100, output: 10 };
    const attempt = (who: typeof a, id: string, cost: number) => who.store.recordStep(KEY, { attemptID: id, cost, pricing: "priced", tokens, final: true });
    await a.persister.load();
    await b.persister.load();
    attempt(a, "a1", 0.1);
    attempt(a, "a2", 0.3);
    await a.flusher.flushNow();
    c.advance(1000);
    attempt(b, "b1", 0.5);
    attempt(b, "b2", 0.7);
    await b.flusher.flushNow();
    c.advance(1000);
    attempt(a, "a3", 0.9);
    await a.flusher.flushNow();
    const cost = (await onDisk())?.cost;
    expect(cost?.measuredUSD.n).toBe(5);
    expect(cost?.measuredUSD.mean).toBeCloseTo(0.5, 12);
    expect(cost?.tokens.n).toBe(5);
    expect(cost?.tokens.input).toBeCloseTo(100, 12);
  });

  it("QA-1.3-17: past the cap, A 100 × $1 and B 40 × $0.10 end at ≈ 0.50 (the delta is combined in one step, not clamped first)", async () => {
    const { a, b, c, onDisk } = twoProcesses();
    const tokens = { ...emptyTokenSample(), input: 100, output: 10 };
    const attempt = (who: typeof a, id: string, cost: number) => who.store.recordStep(KEY, { attemptID: id, cost, pricing: "priced", tokens, final: true });
    await a.persister.load();
    for (let i = 0; i < 100; i++) attempt(a, `a${i}`, 1);
    await a.flusher.flushNow();
    expect((await onDisk())?.cost.measuredUSD).toEqual({ mean: 1, n: 100 });

    c.advance(1000);
    const loadedB = await b.persister.load(); // B starts from A's file…
    b.store.fromSnapshot(loadedB.snapshot, { mode: "merge" });
    for (let i = 0; i < 40; i++) attempt(b, `b${i}`, 0.1); // …and adds 40 cheap attempts: EWMA, n = 140
    await b.flusher.flushNow();
    const diskMean = 0.1 + 0.9 * 0.98 ** 40;
    expect((await onDisk())?.cost.measuredUSD.mean).toBeCloseTo(diskMean, 9);

    c.advance(1000);
    a.record("pass"); // A is dirty again, with no new cost samples
    await a.flusher.flushNow();
    const cost = (await onDisk())?.cost.measuredUSD;
    expect(cost?.n).toBe(140);
    expect(cost?.mean).toBeCloseTo(diskMean, 9);
    expect(cost?.mean).toBeGreaterThan(0.49);
    expect(cost?.mean).toBeLessThan(0.51); // the old clamp-then-merge gave 0.714
  });

  it("an unchanged file is checked under the lock without merging or warning", async () => {
    const { a, mem, logger, c } = twoProcesses();
    await a.persister.load();
    a.record("pass");
    await a.flusher.flushNow();
    c.advance(1000);
    a.record("pass");
    const readsBefore = mem.touched.filter((t) => t.op === "readText").length;
    await a.flusher.flushNow();
    expect(mem.touched.filter((t) => t.op === "readText").length).toBe(readsBefore + 1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("readForeignWrites: null until someone else writes, then the file and the baseline to diff against", async () => {
    const { a, b, c, deps, dir } = twoProcesses();
    const unchanged = { status: "unchanged" };
    expect(await a.persister.readForeignWrites()).toEqual(unchanged); // never loaded: nothing to compare with
    await a.persister.load();
    expect(await a.persister.readForeignWrites()).toEqual(unchanged);
    b.record("pass");
    c.advance(1000);
    await b.persister.saveSnapshot(b.store.snapshot());
    const foreign = await a.persister.readForeignWrites();
    expect(foreign).toEqual({ status: "merge", baseline: { version: 1, entries: {} }, disk: b.store.snapshot() });
    expect(await a.persister.readForeignWrites()).toEqual(unchanged); // already handled
    // after our own save the baseline is what we wrote
    a.record("fail");
    await a.persister.saveSnapshot(a.store.snapshot());
    expect(await a.persister.readForeignWrites()).toEqual(unchanged);
    c.advance(1000);
    await createPersister(dir, { ...deps, pid: 9 }).saveSnapshot(snapshotOf("pass", "pass"));
    expect(await a.persister.readForeignWrites()).toMatchObject({ status: "merge", baseline: a.store.snapshot() });
  });

  it("QA-1.3-18: a foreign change that cannot be read skips the save (nothing is overwritten blind) and is picked up on the retry", async () => {
    const { a, b, c, mem, dir, onDisk, logger } = twoProcesses();
    await a.persister.load();
    await b.persister.load();
    for (let i = 0; i < 2; i++) a.record("pass");
    await a.flusher.flushNow();
    c.advance(1000);
    const bLoaded = await b.persister.load();
    b.store.fromSnapshot(bLoaded.snapshot, { mode: "merge" });
    for (let i = 0; i < 3; i++) b.record("fail");
    await b.flusher.flushNow();
    const theirs = mem.files.get(join(dir, OUTCOMES_FILE))?.text;
    expect((await onDisk())?.counts).toMatchObject({ pass: 2, fail: 3 });

    // A is dirty; B's write has to be read first, and the read fails
    c.advance(1000);
    a.record("pass");
    let failing = true;
    const writesBefore = mem.touched.filter((t) => t.op === "writeDurable").length;
    mem.hooks.readText = (path) => {
      if (failing && path === join(dir, OUTCOMES_FILE)) throw fsError("EIO", "disk hiccup");
    };
    logger.warn.mockClear();
    await a.flusher.flushNow();
    expect(mem.touched.filter((t) => t.op === "writeDurable").length).toBe(writesBefore); // no write at all this round
    expect(mem.files.get(join(dir, OUTCOMES_FILE))?.text).toBe(theirs); // B's data untouched
    expect(logger.warn).toHaveBeenCalledTimes(2); // the read failure, then the (single) failing-streak report
    expect(a.sched.pending()).toHaveLength(1); // the snapshot is still pending: a retry is armed
    expect(a.flusher.pendingRows).toBe(0);

    // the disk recovers: the change was NOT recorded as seen, so it is merged now and nothing is lost
    failing = false;
    c.advance(1000);
    await a.flusher.flushNow();
    expect((await onDisk())?.counts).toMatchObject({ pass: 3, fail: 3 });
    expect(a.store.snapshot().entries[KEY]?.counts).toMatchObject({ pass: 3, fail: 3 });
  });

  it("QA-1.3-18: a stat failure also skips the save", async () => {
    const { a, mem, c, dir } = twoProcesses();
    await a.persister.load();
    a.record("pass");
    await a.flusher.flushNow();
    c.advance(1000);
    a.record("pass");
    const before = mem.files.get(join(dir, OUTCOMES_FILE))?.text;
    mem.hooks.stat = (path) => {
      if (path === join(dir, OUTCOMES_FILE)) throw fsError("EIO", "stat failed");
    };
    await a.flusher.flushNow();
    expect(mem.files.get(join(dir, OUTCOMES_FILE))?.text).toBe(before);
    delete mem.hooks.stat;
    c.advance(1000);
    await a.flusher.flushNow();
    expect(JSON.parse(mem.files.get(join(dir, OUTCOMES_FILE))?.text ?? "null").entries[KEY].counts.pass).toBe(2);
  });

  it("QA-1.3-18: an unparseable foreign file is moved aside BEFORE the save, once, and the save then goes through", async () => {
    const { a, mem, c, dir, logger } = twoProcesses();
    await a.persister.load();
    a.record("pass");
    await a.flusher.flushNow();
    const path = join(dir, OUTCOMES_FILE);
    c.advance(1000);
    mem.files.set(path, { text: '{"schema": "opencode-model-router.outcomes", "vers', mtimeMs: c.now() }); // a torn write by someone else
    a.record("pass");
    mem.touched.length = 0;
    logger.warn.mockClear();
    await a.flusher.flushNow();

    const ops = mem.touched.filter((t) => t.op === "rename" || t.op === "writeDurable");
    expect(ops[0]).toEqual({ op: "rename", path }); // the quarantine move of outcomes.json comes first…
    expect(ops.findIndex((t) => t.op === "writeDurable")).toBeGreaterThan(0); // …then the temp write
    const copies = corruptCopies(mem.files);
    expect(copies).toHaveLength(1);
    expect(mem.files.get(copies[0] ?? "")?.text).toContain('"vers');
    expect(JSON.parse(mem.files.get(path)?.text ?? "null").entries[KEY].counts.pass).toBe(2);
    expect(logger.warn.mock.calls.filter((call) => String(call[0]).includes("unreadable outcomes.json"))).toHaveLength(1);

    // handled: no repeat on the next save
    c.advance(1000);
    a.record("pass");
    logger.warn.mockClear();
    await a.flusher.flushNow();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(corruptCopies(mem.files)).toHaveLength(1);
  });

  it("a foreign file that is unreadable is replaced (with a warning); one that is not ours is never overwritten", async () => {
    const { a, mem, dir, c, logger } = twoProcesses();
    await a.persister.load();
    a.record("pass");
    await a.flusher.flushNow();
    const path = join(dir, OUTCOMES_FILE);

    c.advance(1000);
    mem.files.set(path, { text: "{ torn", mtimeMs: c.now() });
    a.record("pass");
    await a.flusher.flushNow();
    expect(logger.warn.mock.calls.some((call) => String(call[0]).includes("unreadable outcomes.json"))).toBe(true);
    expect(corruptCopies(mem.files)).toHaveLength(1); // moved aside, not just overwritten
    expect(JSON.parse(mem.files.get(path)?.text ?? "null").entries[KEY].counts.pass).toBe(2);

    c.advance(1000);
    const theirs = JSON.stringify({ schema: "someone-else", version: 1 });
    mem.files.set(path, { text: theirs, mtimeMs: c.now() });
    a.record("pass");
    await a.flusher.flushNow();
    expect(mem.files.get(path)?.text).toBe(theirs); // refused
    expect(await a.persister.saveSnapshot(a.store.snapshot())).toMatchObject({ ok: false, readOnly: true });
  });

  it("a removed file is simply recreated", async () => {
    const { a, mem, dir, c, onDisk } = twoProcesses();
    await a.persister.load();
    a.record("pass");
    await a.flusher.flushNow();
    mem.files.delete(join(dir, OUTCOMES_FILE));
    c.advance(1000);
    a.record("pass");
    await a.flusher.flushNow();
    expect((await onDisk())?.counts.pass).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// acquireOutcomes: one store and one writer per process (A3)
// ---------------------------------------------------------------------------

describe("acquireOutcomes (A3)", () => {
  const held: Array<{ release(): Promise<void> }> = [];
  let counter = 0;
  afterEach(async () => {
    while (held.length > 0) await (held.pop() as { release(): Promise<void> }).release();
  });

  function acquireSetup(prefix = "omr-acquire") {
    const base = setup(`${prefix}-${process.pid}-${counter++}`);
    const sched = manualScheduler();
    const acquire = (tuning: { halfLifeDays?: number; maxEffectiveSamples?: number } = {}, dir = base.dir) => {
      const bundle = acquireOutcomes({ dir, tuning, logger: base.logger, deps: base.deps, scheduler: sched.scheduler });
      held.push(bundle);
      return bundle;
    };
    return { ...base, sched, acquire };
  }

  it("two acquisitions of the same directory (case-different on win32) share one store, persister and flusher", () => {
    const { acquire, dir } = acquireSetup();
    const a = acquire();
    const b = acquire({}, process.platform === "win32" ? dir.toUpperCase() : dir);
    expect(b).not.toBe(a);
    expect(b.store).toBe(a.store);
    expect(b.persister).toBe(a.persister);
    expect(b.flusher).toBe(a.flusher);
    expect(b.ready).toBe(a.ready);
  });

  it("different directories get different bundles", () => {
    const { acquire, dir } = acquireSetup();
    const a = acquire();
    const b = acquire({}, join(dir, "other"));
    expect(b.store).not.toBe(a.store);
    expect(b.flusher).not.toBe(a.flusher);
  });

  it("the last release disposes once; earlier releases (and repeated releases of one holder) do not", async () => {
    const { acquire, mem, sched } = acquireSetup();
    const a = acquire();
    const b = acquire();
    await a.ready;
    a.store.recordVerdict(KEY, "pass", { attemptID: "x", step: "dispatch" });
    await a.release();
    await a.release(); // idempotent per holder: still one reference outstanding
    expect(mem.touched.filter((t) => t.op === "writeDurable")).toHaveLength(0);
    b.flusher.enqueue(decisionRow(1));
    expect(b.flusher.pendingRows).toBe(1);

    await b.release();
    expect(mem.touched.filter((t) => t.op === "writeDurable")).toHaveLength(1);
    expect(mem.touched.filter((t) => t.op === "appendText")).toHaveLength(1);
    expect(b.flusher.pendingRows).toBe(0);
    b.flusher.enqueue(decisionRow(2)); // disposed: dropped
    expect(b.flusher.pendingRows).toBe(0);
    await b.release();
    expect(sched.pending()).toHaveLength(0);
    expect(mem.touched.filter((t) => t.op === "writeDurable")).toHaveLength(1);
  });

  it("acquiring again after the last release builds a fresh bundle", async () => {
    const { acquire } = acquireSetup();
    const a = acquire();
    await a.release();
    const b = acquire();
    expect(b.store).not.toBe(a.store);
  });

  it("QA-1.3-1: a re-acquire while the previous release is still flushing sees the flushed file (no lost update)", async () => {
    const { acquire, deps, dir, mem } = acquireSetup();
    const a = acquire();
    await a.ready;
    for (let i = 0; i < 4; i++) a.store.recordVerdict(KEY, "pass", { attemptID: `p${i}`, step: "dispatch" });
    const closing = a.release(); // deliberately not awaited
    const b = acquire();
    expect(b.store).not.toBe(a.store);
    b.store.recordVerdict(KEY, "fail", { attemptID: "f1", step: "dispatch" });
    const loaded = await b.ready;
    expect(loaded.status).toBe("ok"); // it saw a's final write
    await closing;
    await b.release();
    const disk = await createPersister(dir, deps).load({ quarantine: false });
    expect(disk.status).toBe("ok");
    expect(disk.snapshot.entries[KEY]?.counts).toMatchObject({ pass: 4, fail: 1 });
    expect(mem.touched.filter((t) => t.op === "writeDurable")).toHaveLength(2);
  });

  it("QA-1.3-1: repeated release/acquire cycles chain their closes in order", async () => {
    const { acquire, deps, dir } = acquireSetup();
    let bundle = acquire();
    for (let i = 0; i < 5; i++) {
      bundle.store.recordVerdict(KEY, "pass", { attemptID: `c${i}`, step: "dispatch" });
      const next = (void bundle.release(), acquire());
      bundle = next;
    }
    await bundle.release();
    const disk = await createPersister(dir, deps).load({ quarantine: false });
    expect(disk.snapshot.entries[KEY]?.counts.pass).toBe(5);
  });

  it("loads the disk snapshot into the store and merges records made before the load finished", async () => {
    const { acquire, deps, dir } = acquireSetup();
    await createPersister(dir, deps).saveSnapshot(snapshotOf("pass", "pass"));
    const bundle = acquire();
    bundle.store.recordVerdict(KEY, "fail", { attemptID: "early", step: "dispatch" });
    const result = await bundle.ready;
    expect(result.status).toBe("ok");
    const counts = bundle.store.snapshot().entries[KEY]?.counts;
    expect(counts).toMatchObject({ pass: 2, fail: 1 });
    expect(bundle.store.posterior(KEY).n).toBeCloseTo(3, 9);
  });

  it("a corrupted store → fresh usable store, one warning, quarantined file; the later save writes a fresh file after the load", async () => {
    const { acquire, mem, dir, logger, deps } = acquireSetup();
    mem.files.set(join(dir, OUTCOMES_FILE), { text: "{{{ corrupt", mtimeMs: 1 });
    const bundle = acquire();
    bundle.store.recordVerdict(KEY, "pass", { attemptID: "a", step: "dispatch" });
    void bundle.flusher.requestFlush();
    const result = await bundle.ready;
    expect(result.status).toBe("corrupt");
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(bundle.store.keys()).toEqual([KEY]);
    await bundle.release();
    expect(corruptCopies(mem.files).map((p) => mem.files.get(p)?.text)).toEqual(["{{{ corrupt"]);
    const reloaded = await createPersister(dir, deps).load({ quarantine: false });
    expect(reloaded.status).toBe("ok");
    expect(Object.keys(reloaded.snapshot.entries)).toEqual([KEY]);
  });

  it("the last caller's tuning wins and the change is logged", async () => {
    const { acquire, logger } = acquireSetup();
    const a = acquire({ maxEffectiveSamples: 50 });
    for (let i = 0; i < 30; i++) a.store.recordVerdict(KEY, "pass", { attemptID: `v${i}`, step: "dispatch" });
    expect(a.store.posterior(KEY).n).toBeCloseTo(30, 9);
    acquire({ maxEffectiveSamples: 10 });
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(a.store.posterior(KEY).n).toBeCloseTo(10, 9);
    acquire({ maxEffectiveSamples: 10 });
    expect(logger.info).toHaveBeenCalledTimes(1);
  });
});
