// Branch-coverage top-up for src/executor/slots/pool.ts: refusal paths, damaged records and platform twins.
import { posix, win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitOps, StatusEntry } from "../../src/executor/git";
import { assertSafeSlotDir, createSlotPool, defaultSlotsDir, gcSlots, markerPath } from "../../src/executor/slots/pool";
import { detectManagers } from "../../src/executor/slots/provision";
import type { Detection, Provisioner } from "../../src/executor/slots/provision";
import { ExecutorError, GIT_ID_PATTERN, type Clock, type FileSystem, type FsStat, type SlotRecord } from "../../src/executor/types";

// ---------------------------------------------------------------------------------------------------------------
// Fakes (the same seams as executor-slots.test.ts)
// ---------------------------------------------------------------------------------------------------------------

const PLAN = "p-20261010-abc123";
const TOP = "D:\\repo\\main";
const HOME = "D:\\omr-home";
const MARKERS = "D:\\omr-home\\markers";
const SLOTS = `D:\\omr-slots\\${PLAN}`;
const C1 = "1".repeat(40);
const C2 = "2".repeat(40);
const slotPath = (slot: string, dir = SLOTS): string => win32.join(dir, slot);

type Node = "dir" | "junction" | "symlink" | { text: string };

function errno(code: string, p: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${p}`), { code });
}

function key(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

interface MemFs extends FileSystem {
  nodes: Map<string, Node>;
  removed: Array<{ path: string; recursive: boolean }>;
  /** Paths whose rm fails: the error thrown and the number of failures left. */
  rmFailures: Map<string, { error: unknown; times: number }>;
  put(path: string, text: string): void;
  dir(path: string): void;
  text(path: string): string | null;
}

/** `posix`: realpath answers with forward slashes, as a POSIX file system does (keep POSIX test paths lower-case). */
function memFs(o: { posix?: boolean } = {}): MemFs {
  const nodes = new Map<string, Node>();
  const removed: MemFs["removed"] = [];
  const rmFailures: MemFs["rmFailures"] = new Map();
  const parentOf = (k: string): string => k.split("/").slice(0, -1).join("/");
  const children = (k: string): string[] => [...nodes.keys()].filter(c => parentOf(c) === k);
  const ensureParents = (k: string): void => {
    for (let up = parentOf(k); up !== "" && !nodes.has(up); up = parentOf(up)) nodes.set(up, "dir");
  };
  const fs: MemFs = {
    nodes, removed, rmFailures,
    put(path, text) { ensureParents(key(path)); nodes.set(key(path), { text }); },
    dir(path) { ensureParents(key(path)); nodes.set(key(path), "dir"); },
    text(path) { const n = nodes.get(key(path)); return n !== undefined && typeof n === "object" ? n.text : null; },
    async readText(p) {
      const n = nodes.get(key(p));
      if (n === undefined || typeof n === "string") throw errno("ENOENT", p);
      return n.text;
    },
    async writeText(p, data, o) {
      if (o?.exclusive === true && nodes.has(key(p))) throw errno("EEXIST", p);
      nodes.set(key(p), { text: data });
    },
    async appendText(p, data) {
      const n = nodes.get(key(p));
      nodes.set(key(p), { text: `${n !== undefined && typeof n === "object" ? n.text : ""}${data}` });
    },
    async rename(a, b) {
      const n = nodes.get(key(a));
      if (n === undefined) throw errno("ENOENT", a);
      nodes.delete(key(a));
      nodes.set(key(b), n);
    },
    async rm(p, o) {
      const k = key(p);
      const failing = rmFailures.get(k);
      if (failing !== undefined && failing.times > 0) {
        failing.times -= 1;
        throw failing.error;
      }
      const n = nodes.get(k);
      if (n === undefined) throw errno("ENOENT", p);
      removed.push({ path: p, recursive: o.recursive });
      if (o.recursive && n === "dir") {
        for (const c of [...nodes.keys()]) if (c.startsWith(`${k}/`)) nodes.delete(c);
      } else if (n === "dir" && children(k).length > 0) {
        throw errno("ENOTEMPTY", p);
      }
      nodes.delete(k);
    },
    async mkdir(p) {
      if (nodes.has(key(p))) throw errno("EEXIST", p);
      nodes.set(key(p), "dir");
    },
    async readdir(p) {
      const k = key(p);
      if (!nodes.has(k)) throw errno("ENOENT", p);
      return children(k).map(c => c.split("/").at(-1) ?? "");
    },
    async lstat(p): Promise<FsStat | null> {
      const n = nodes.get(key(p));
      if (n === undefined) return null;
      if (typeof n === "string") return { kind: n, size: 0, mtimeMs: 0 };
      return { kind: "file", size: n.text.length, mtimeMs: 0 };
    },
    async realpath(p) { return o.posix === true ? key(p) : key(p).replace(/\//g, "\\"); },
    async fsyncDir() { /* nothing to flush */ },
  };
  return fs;
}

/** Time moves only by `setTimer` (a timer fires at once and advances the clock by its delay) and `tick`. */
function autoClock(start = Date.parse("2026-10-11T00:00:00.000Z")): Clock & { tick(ms: number): void; slept: number[] } {
  let now = start;
  let id = 0;
  let rand = 0;
  const slept: number[] = [];
  return {
    slept,
    now: () => now,
    iso: (ms) => new Date(ms ?? now).toISOString(),
    setTimer(ms, fn) { slept.push(ms); now += ms; queueMicrotask(fn); return { id: ++id }; },
    clearTimer() { /* auto timers have already fired */ },
    randomHex(bytes) { rand += 1; return rand.toString(16).padStart(bytes * 2, "0"); },
    tick(ms) { now += ms; },
  };
}

const unused = async (): Promise<never> => { throw new Error("not used by the pool"); };

interface FakeGit extends GitOps {
  log: string[];
  heads: Map<string, string>;
  files: Record<string, string>;
  status: StatusEntry[];
  topHead: string;
  fail: Map<string, { error: Error; times: number }>;
  badPointers: Set<string>;
  preview: (slot: string, keep: readonly string[]) => string[];
  links: string[];
  worktrees: Map<string, string>;
}

function fakeGit(fs: MemFs): FakeGit {
  const maybeFail = (op: string): void => {
    const f = g.fail.get(op);
    if (f !== undefined && f.times > 0) { f.times -= 1; throw f.error; }
  };
  const g: FakeGit = {
    planId: PLAN, log: [], heads: new Map(), files: { "requirements.txt": "pytest\n" }, status: [], topHead: C1,
    fail: new Map(), badPointers: new Set(), preview: () => [], links: [], worktrees: new Map(),
    version: unused, checkRefFormat: unused, addAll: unused,
    async worktreeList() {
      return [...g.worktrees.entries()].map(([path, locked]) => ({ path: path.replace(/\//g, "\\"), head: null, branch: null, locked }));
    },
    async cleanPreview(slot, keep) { return g.preview(slot, keep); },
    async lsFiles() { return Object.keys(g.files); },
    async trackedLinks() { return [...g.links]; }, commit: unused, rebaseOnto: unused,
    rebaseAbort: unused, cherryPick: unused, revert: unused, mergeFfOnly: unused, isAncestor: unused, tag: unused,
    deleteRefs: unused, branchForce: unused,
    async verifySlotPointers(slot) {
      maybeFail("verifySlotPointers");
      if (g.badPointers.has(key(slot)) || await fs.lstat(slot) === null) {
        throw new ExecutorError("E_SLOT_BROKEN", `slot ${slot}: .git is missing`, { slot });
      }
      return { gitdir: `${TOP}\\.git\\worktrees\\x`, common: `${TOP}\\.git` };
    },
    async worktreeAdd(path, commit, lockReason) {
      maybeFail("worktreeAdd");
      g.log.push(`add ${key(path)}`);
      g.worktrees.set(key(path), lockReason);
      g.badPointers.delete(key(path));
      fs.dir(path);
      for (const [rel, text] of Object.entries(g.files)) fs.put(win32.join(path, ...rel.split("/")), text);
      g.heads.set(key(path), commit);
    },
    async worktreeRemove(path, lockReason) {
      maybeFail("worktreeRemove");
      g.log.push(`remove ${key(path)}`);
      const held = g.worktrees.get(key(path));
      if (held !== undefined && held !== lockReason) throw new ExecutorError("E_GIT", "worktree is locked by someone else", { op: "worktree remove" });
      g.worktrees.delete(key(path));
    },
    async checkoutDetach(slot, commit) { maybeFail("checkoutDetach"); g.log.push(`checkout ${key(slot)} ${commit.slice(0, 2)}`); g.heads.set(key(slot), commit); },
    async cleanTracked(slot) { maybeFail("cleanTracked"); g.log.push(`clean ${key(slot)}`); },
    async cleanForChecks(slot) { maybeFail("cleanForChecks"); g.log.push(`cleanForChecks ${key(slot)}`); },
    async statusPorcelain() { return g.status; },
    async revParse(cwd, rev) {
      if (rev === "HEAD") return key(cwd) === key(TOP) ? g.topHead : g.heads.get(key(cwd)) ?? g.topHead;
      if (GIT_ID_PATTERN.test(rev)) return rev;
      throw new ExecutorError("E_GIT", `unknown revision ${rev}`, { op: "rev-parse", code: 128, stderr: "" });
    },
    async diffNames() { return Object.keys(g.files); },
  };
  return g;
}

interface FakeProvisioner extends Provisioner {
  calls: Array<{ slot: string; managers: string[]; fresh: boolean }>;
  error: unknown;
}

function fakeProvisioner(fs: FileSystem): FakeProvisioner {
  const p: FakeProvisioner = {
    calls: [], error: null,
    detect: (slot, tracked) => detectManagers(slot, tracked, fs, { provision: "auto", python: "auto" }),
    async provision(slot: string, d: Detection, o: { fresh: boolean; signal?: AbortSignal }) {
      p.calls.push({ slot, managers: [...d.managers], fresh: o.fresh });
      if (p.error !== null) throw p.error;
    },
  };
  return p;
}

interface Harness {
  pool: ReturnType<typeof createSlotPool>;
  fs: MemFs; git: FakeGit; clock: ReturnType<typeof autoClock>; prov: FakeProvisioner; warnings: string[];
  marker(slot: string): SlotRecord;
}

function harness(o: { maxParallel?: number; fs?: MemFs; logger?: boolean } = {}): Harness {
  const fs = o.fs ?? memFs();
  const git = fakeGit(fs);
  const clock = autoClock();
  const prov = fakeProvisioner(fs);
  const warnings: string[] = [];
  const pool = createSlotPool({
    planId: PLAN, repoKey: "repo-key", toplevel: TOP, slotsDir: SLOTS, markersDir: MARKERS, executorHome: HOME,
    maxParallel: o.maxParallel ?? 4, git, fs, clock, provisioner: prov, platform: "win32",
    // The ledger's integration head (a valid id), so special-slot tests exercise their own refusal paths.
    integrationHead: () => C1,
    ...(o.logger === false ? {} : { logger: { warn: (m: string) => { warnings.push(m); } } }),
  });
  const marker = (slot: string): SlotRecord => {
    const text = fs.text(markerPath(MARKERS, PLAN, slot));
    if (text === null) throw new Error(`no marker for ${slot}`);
    return JSON.parse(text) as SlotRecord;
  };
  return { pool, fs, git, clock, prov, warnings, marker };
}

/** A marker body the guard accepts, for `slot` in `state`. */
function record(slot: string, more: Partial<SlotRecord> = {}): SlotRecord {
  return {
    schema: 1, slot, path: slotPath(slot), kind: slot === "integration" ? "integration" : slot === "ci" ? "ci" : "task",
    planId: PLAN, repoKey: "repo-key", state: "ready", owner: null, commit: C1, managers: [], manifests: {},
    createdAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:00:00.000Z", ...more,
  };
}

afterEach(() => {
  const registry: unknown = Reflect.get(globalThis, Symbol.for("omr.executor.slots"));
  if (registry instanceof Map) registry.clear();
});

const PLAN_MARKERS = win32.join(MARKERS, PLAN);
const markerFile = (slot: string): string => win32.join(PLAN_MARKERS, `${slot}.json`);

function gcDeps(fs: MemFs, git: FakeGit, clock: Clock, logger?: { warn(m: string): void }) {
  return {
    repoKey: "repo-key", toplevel: TOP, slotsDir: SLOTS, markersDir: MARKERS, executorHome: HOME, git, fs, clock,
    platform: "win32" as const, ...(logger === undefined ? {} : { logger }),
  };
}

/** A slot gc can retire: a marker, its folder and the worktree entry locked by the executor. */
function seedRetirable(fs: MemFs, git: FakeGit, slot: string): void {
  fs.put(markerFile(slot), `${JSON.stringify(record(slot))}\n`);
  fs.dir(slotPath(slot));
  git.worktrees.set(key(slotPath(slot)), `omr-executor slot ${PLAN}/${slot}: managed by the model-router executor; remove with router_plan action=gc`);
}

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------------

describe("pure helpers: POSIX shapes", () => {
  it("markerPath joins a POSIX markers directory with POSIX separators", () => {
    expect(markerPath("/omr-home/markers", PLAN, "slot-3")).toBe(`/omr-home/markers/${PLAN}/slot-3.json`);
    expect(markerPath("/omr-home/markers", PLAN, "ci")).toBe(posix.join("/omr-home/markers", PLAN, "ci.json"));
  });

  it("assertSafeSlotDir accepts a POSIX slot under its slots directory and refuses a sibling", () => {
    expect(() => assertSafeSlotDir(`/omr-slots/${PLAN}/slot-1`, "slot-1", `/omr-slots/${PLAN}`, "linux")).not.toThrow();
    expect(() => assertSafeSlotDir(`/omr-slots/other/slot-1`, "slot-1", `/omr-slots/${PLAN}`, "linux")).toThrow(/parent is not slotsDir/);
  });

  it("defaultSlotsDir needs a drive letter", () => {
    expect(defaultSlotsDir("E:\\work\\repo", PLAN)).toBe(`E:\\.omr-slots\\${PLAN}`);
    expect(() => defaultSlotsDir("/work/repo", PLAN)).toThrow(/not on a drive-letter path/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// gcSlots: damaged markers, marker directory cleanup, default platform
// ---------------------------------------------------------------------------------------------------------------

describe("gcSlots edges", () => {
  it("reports marker files that are not regular, too large in size or in bytes, or not a slot record", async () => {
    const fs = memFs();
    const git = fakeGit(fs);
    fs.dir(markerFile("slot-1"));
    fs.put(markerFile("slot-2"), "x".repeat(70_000));
    // 40 000 UTF-16 units (the size the port reports) but 80 000 UTF-8 bytes.
    fs.put(markerFile("slot-3"), "\u00e9".repeat(40_000));
    fs.put(markerFile("slot-4"), JSON.stringify({ schema: 2 }));
    fs.put(win32.join(PLAN_MARKERS, "notes.txt"), "ignored");
    const r = await gcSlots(gcDeps(fs, git, autoClock()), async () => true);
    expect(r.removed).toEqual([]);
    expect(r.reported).toEqual(expect.arrayContaining([
      `${markerFile("slot-1")}: not a regular file (dir)`,
      `${markerFile("slot-2")}: larger than 65536 bytes`,
      `${markerFile("slot-3")}: larger than 65536 bytes`,
      `${markerFile("slot-4")}: not a slot record`,
    ]));
    expect(r.reported.some(line => line.includes("notes.txt"))).toBe(false);
  });

  it("uses the host platform when none is given", async () => {
    const fs = memFs();
    const { platform: _platform, ...deps } = gcDeps(fs, fakeGit(fs), autoClock());
    await expect(gcSlots(deps, async () => true)).resolves.toEqual({ removed: [], reported: [] });
  });

  it("reports a marker that vanished between collection and retirement, and deletes nothing", async () => {
    const fs = memFs();
    const git = fakeGit(fs);
    seedRetirable(fs, git, "slot-1");
    const r = await gcSlots(gcDeps(fs, git, autoClock()), async () => {
      await fs.rm(markerFile("slot-1"), { recursive: false });
      return true;
    });
    expect(r.removed).toEqual([]);
    expect(r.reported).toContain(`${slotPath("slot-1")}: marker is missing`);
    expect(await fs.lstat(slotPath("slot-1"))).not.toBeNull();
  });

  it.each([
    ["an Error with a non-string code", Object.assign(new Error("odd failure"), { code: 42 }), "odd failure"],
    ["a thrown string", "directory busy", "directory busy"],
  ])("warns when the emptied marker directory cannot be removed (%s)", async (_name, error, text) => {
    const fs = memFs();
    const git = fakeGit(fs);
    const warnings: string[] = [];
    seedRetirable(fs, git, "slot-1");
    fs.rmFailures.set(key(PLAN_MARKERS), { error, times: 1 });
    const r = await gcSlots(gcDeps(fs, git, autoClock(), { warn: (m) => { warnings.push(m); } }), async () => true);
    expect(r.removed).toEqual([slotPath("slot-1")]);
    expect(await fs.lstat(slotPath("slot-1"))).toBeNull();
    expect(await fs.lstat(markerFile("slot-1"))).toBeNull();
    expect(warnings).toEqual([`could not remove the marker directory ${PLAN_MARKERS}: ${text}`]);
  });

  it("gives up a busy slot folder once the gc deadline would pass, leaving the marker retired", async () => {
    const fs = memFs();
    const git = fakeGit(fs);
    const clock = autoClock();
    seedRetirable(fs, git, "slot-1");
    fs.rmFailures.set(key(slotPath("slot-1")), { error: errno("EBUSY", slotPath("slot-1")), times: 10 });
    const r = await gcSlots(gcDeps(fs, git, clock), async () => true, { deadline: clock.now() + 1 });
    expect(r.removed).toEqual([]);
    expect(r.reported).toContain(`${slotPath("slot-1")}: EBUSY: ${slotPath("slot-1")}`);
    expect(JSON.parse(fs.text(markerFile("slot-1")) ?? "{}")).toMatchObject({ state: "retired" });
  });

  it("reports a marker that cannot be deleted once its slot folder is gone", async () => {
    const fs = memFs();
    const git = fakeGit(fs);
    seedRetirable(fs, git, "slot-1");
    fs.rmFailures.set(key(markerFile("slot-1")), { error: errno("EINVAL", markerFile("slot-1")), times: 1 });
    const r = await gcSlots(gcDeps(fs, git, autoClock()), async () => true);
    expect(r.removed).toEqual([]);
    expect(r.reported).toContain(`${slotPath("slot-1")}: EINVAL: ${markerFile("slot-1")}`);
    expect(await fs.lstat(slotPath("slot-1"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The pool
// ---------------------------------------------------------------------------------------------------------------

const sidecar = (slot: string, extension: string): string => markerFile(slot).replace(/\.json$/, `.${extension}`);

describe("SlotPool on a POSIX host", () => {
  it("validates a POSIX slots directory and snapshots .venv/bin and node_modules/.bin executables", async () => {
    const fs = memFs({ posix: true });
    const git = fakeGit(fs);
    git.files = {
      "package.json": JSON.stringify({ name: "x" }), "package-lock.json": "l", "requirements.txt": "pytest\n",
      ".venv/bin/python": "py", "node_modules/.bin/vitest": "js", "node_modules/.bin/tools/inner": "",
    };
    const pool = createSlotPool({
      planId: PLAN, repoKey: "repo-key", toplevel: "/repo/main", slotsDir: `/omr-slots/${PLAN}`, markersDir: "/omr-home/markers",
      executorHome: "/omr-home", maxParallel: 2, git, fs, clock: autoClock(), provisioner: fakeProvisioner(fs), platform: "linux",
      integrationHead: () => C1,
    });
    await pool.open();
    const lease = await pool.acquire(PLAN, "task-1", C1);
    expect(lease.path).toBe(`/omr-slots/${PLAN}/slot-1`);
    const bins = JSON.parse(fs.text(`/omr-home/markers/${PLAN}/slot-1.bins`) ?? "null") as Array<{ path: string }>;
    expect(bins.map(b => b.path).sort()).toEqual([`${lease.path}/.venv/bin/python`, `${lease.path}/node_modules/.bin/vitest`]);
  });
});

describe("SlotPool open: sidecars and markers", () => {
  it.each([
    ["not arrays", "{}", "{}"],
    ["arrays with an empty item or a non-record", JSON.stringify(["ok", ""]), JSON.stringify([1])],
    ["arrays with a newline or an empty path", JSON.stringify(["a\nb"]), JSON.stringify([{ path: "", size: 1, mtimeMs: 1 }])],
  ])("ignores .produced and .bins sidecars that are %s, with a warning each", async (_name, producedText, binsText) => {
    const h = harness();
    h.fs.put(markerFile("slot-1"), JSON.stringify(record("slot-1", { managers: ["pip"] })));
    h.fs.put(sidecar("slot-1", "produced"), producedText);
    h.fs.put(sidecar("slot-1", "bins"), binsText);
    await h.pool.open();
    expect(h.warnings).toEqual([
      "slot slot-1: no usable .produced file; build outputs are not kept by a clean",
      "slot slot-1: no usable .bins file; router_run falls back to PATH for this slot",
    ]);
  });

  it("warns about a sidecar that is a directory and one that cannot be read", async () => {
    const fs = memFs();
    fs.put(markerFile("slot-1"), JSON.stringify(record("slot-1", { managers: ["pip"] })));
    fs.dir(sidecar("slot-1", "produced"));
    fs.put(sidecar("slot-1", "bins"), "[]");
    const read = fs.readText.bind(fs);
    fs.readText = async (p) => { if (key(p) === key(sidecar("slot-1", "bins"))) throw errno("EACCES", p); return read(p); };
    const h = harness({ fs });
    await h.pool.open();
    expect(h.warnings).toEqual([
      `ignoring ${sidecar("slot-1", "produced")}: not a regular file of at most 65536 bytes`,
      "slot slot-1: no usable .produced file; build outputs are not kept by a clean",
      `could not read ${sidecar("slot-1", "bins")}: EACCES: ${sidecar("slot-1", "bins")}`,
      "slot slot-1: no usable .bins file; router_run falls back to PATH for this slot",
    ]);
  });

  it("lists task slots by number, then integration, then ci", async () => {
    const h = harness();
    for (const slot of ["ci", "slot-2", "integration", "slot-1"]) h.fs.put(markerFile(slot), JSON.stringify(record(slot)));
    await h.pool.open();
    expect((await h.pool.list()).map(r => r.slot)).toEqual(["slot-1", "slot-2", "integration", "ci"]);
  });

  it("rethrows a slots directory that cannot be created", async () => {
    const fs = memFs();
    fs.mkdir = async (p) => { throw errno("EACCES", p); };
    const h = harness({ fs });
    await expect(h.pool.open()).rejects.toMatchObject({ code: "EACCES" });
  });
});

describe("SlotPool acquire edges", () => {
  function seedReady(h: Harness, slot: string, more: Partial<SlotRecord> = {}): void {
    h.fs.put(markerFile(slot), JSON.stringify(record(slot, more)));
    h.fs.dir(slotPath(slot));
    h.git.heads.set(key(slotPath(slot)), more.commit ?? C1);
  }

  it("picks the least recently used ready slot (an unparsable time counts as oldest), then the lowest number", async () => {
    const h = harness();
    h.git.files = { "README.md": "x" };
    seedReady(h, "slot-3", { updatedAt: "2026-10-10T00:00:00.000Z" });
    seedReady(h, "slot-2", { updatedAt: "2026-10-10T00:00:00.000Z" });
    seedReady(h, "slot-1", { updatedAt: "2026-10-10T05:00:00.000Z" });
    seedReady(h, "slot-4", { updatedAt: "not a date" });
    await h.pool.open();
    expect((await h.pool.acquire(PLAN, "a", C2)).slot).toBe("slot-4");
    expect((await h.pool.acquire(PLAN, "b", C2)).slot).toBe("slot-2");
    expect((await h.pool.acquire(PLAN, "c", C2)).slot).toBe("slot-3");
    expect((await h.pool.acquire(PLAN, "d", C2)).slot).toBe("slot-1");
  });

  it("a reset whose checkout leaves HEAD behind fails twice and breaks the slot", async () => {
    const h = harness();
    h.git.files = { "README.md": "x" };
    await h.pool.open();
    await h.pool.acquire(PLAN, "task-1", C1);
    await h.pool.release("slot-1");
    h.git.checkoutDetach = async () => { /* HEAD stays where it was */ };
    await expect(h.pool.acquire(PLAN, "task-2", C2)).rejects.toMatchObject({
      code: "E_SLOT_BROKEN", message: expect.stringContaining(`HEAD of slot-1 is ${C1}, expected ${C2}`),
    });
    expect(h.marker("slot-1").state).toBe("broken");
    expect(h.warnings.some(w => w.startsWith("reset of slot-1 failed"))).toBe(true);
  });

  it("a detection too large for the marker breaks the slot", async () => {
    const h = harness();
    const files: Record<string, string> = { "requirements.txt": "pytest\n" };
    for (let i = 0; i < 1000; i++) files[`d${String(i).padStart(4, "0")}/requirements.txt`] = "x\n";
    h.git.files = files;
    await h.pool.open();
    await expect(h.pool.acquire(PLAN, "task-1", C1)).rejects.toMatchObject({
      code: "E_SLOT_BROKEN", message: expect.stringContaining("the marker of slot-1 would exceed 65536 bytes"),
    });
    expect(h.marker("slot-1")).toMatchObject({ state: "broken", owner: null, manifests: {} });
  });

  it("refuses a task slot whose marker is broken but still names the owner", async () => {
    const h = harness();
    h.fs.put(markerFile("slot-1"), JSON.stringify(record("slot-1", { state: "broken", owner: "task-1" })));
    await h.pool.open();
    await expect(h.pool.acquire(PLAN, "task-1", C1)).rejects.toMatchObject({
      code: "E_SLOT_BROKEN", message: expect.stringContaining("slot slot-1 is broken"),
    });
  });

  it("refuses a special slot leased by another owner, and one whose marker has no commit", async () => {
    const h = harness();
    h.fs.put(markerFile("integration"), JSON.stringify(record("integration", { state: "leased", owner: "someone-else" })));
    h.fs.put(markerFile("ci"), JSON.stringify(record("ci", { state: "leased", owner: "ci", commit: null })));
    await h.pool.open();
    await expect(h.pool.acquireSpecial(PLAN, "integration")).rejects.toMatchObject({ code: "E_SLOT_UNAVAILABLE" });
    await expect(h.pool.acquireSpecial(PLAN, "ci")).rejects.toMatchObject({
      code: "E_SLOT_BROKEN", message: expect.stringContaining("slot ci has no commit"),
    });
  });

  it("recreates a retired integration slot whose folder is already gone", async () => {
    const h = harness();
    h.git.files = { "README.md": "x" };
    h.fs.put(markerFile("integration"), JSON.stringify(record("integration", { state: "retired" })));
    await h.pool.open();
    const lease = await h.pool.acquireSpecial(PLAN, "integration");
    expect(lease).toMatchObject({ slot: "integration", owner: "integration", commit: C1, path: slotPath("integration") });
    expect(h.git.log).toEqual([`remove ${key(slotPath("integration"))}`, `add ${key(slotPath("integration"))}`]);
    expect(h.marker("integration")).toMatchObject({ state: "leased", owner: "integration" });
  });

  it("refuses an owner that is not a string", async () => {
    const h = harness();
    await h.pool.open();
    await expect(Reflect.apply(h.pool.acquire, h.pool, [PLAN, 42, C1])).rejects.toMatchObject({
      code: "E_INVALID_INPUT", message: expect.stringContaining("owner must be 1-128 printable characters"),
    });
  });
});

describe("SlotPool reset and cleanForChecks edges", () => {
  async function leased(): Promise<Harness> {
    const h = harness();
    h.git.files = { "README.md": "x" };
    await h.pool.open();
    await h.pool.acquire(PLAN, "task-1", C1);
    return h;
  }

  it("reset finishes an interrupted provisioning of an unowned slot as ready, then resets it to ready", async () => {
    const h = harness();
    h.git.files = { "README.md": "x" };
    h.fs.put(markerFile("slot-1"), JSON.stringify(record("slot-1", { state: "provisioning", owner: null })));
    h.fs.dir(slotPath("slot-1"));
    await h.pool.open();
    await h.pool.reset("slot-1", C2);
    expect(h.marker("slot-1")).toMatchObject({ state: "ready", owner: null, commit: C2 });
    expect(h.git.log).toEqual([`checkout ${key(slotPath("slot-1"))} 22`, `clean ${key(slotPath("slot-1"))}`]);
  });

  it("refuses an unsafe clean candidate", async () => {
    const h = await leased();
    h.git.preview = () => ["../escape"];
    await expect(h.pool.cleanForChecks("slot-1")).rejects.toMatchObject({
      code: "E_SLOT_BROKEN", message: expect.stringContaining("unsafe clean candidate"),
    });
  });

  it("removes an untracked link on a candidate's path inside node_modules and keeps a tracked one", async () => {
    const h = await leased();
    const nm = win32.join(slotPath("slot-1"), "node_modules");
    h.fs.dir(nm);
    h.fs.nodes.set(key(win32.join(nm, "linked")), "junction");
    h.fs.nodes.set(key(win32.join(nm, "kept")), "junction");
    h.git.links = ["node_modules/kept"];
    h.git.preview = () => ["node_modules/linked/inner/", "node_modules/kept"];
    await h.pool.cleanForChecks("slot-1");
    expect(await h.fs.lstat(win32.join(nm, "linked"))).toBeNull();
    expect(await h.fs.lstat(win32.join(nm, "kept"))).not.toBeNull();
    expect(h.git.log.at(-1)).toBe(`cleanForChecks ${key(slotPath("slot-1"))}`);
  });

  it("skips a directory entry that vanished between readdir and lstat", async () => {
    const h = await leased();
    const read = h.fs.readdir.bind(h.fs);
    h.fs.readdir = async (p) => [...await read(p), ...(key(p) === key(slotPath("slot-1")) ? ["ghost"] : [])];
    await h.pool.cleanForChecks("slot-1");
    expect(h.git.log.at(-1)).toBe(`cleanForChecks ${key(slotPath("slot-1"))}`);
  });

  it("refuses a slot folder that became a junction", async () => {
    const h = await leased();
    h.fs.nodes.set(key(slotPath("slot-1")), "junction");
    await expect(h.pool.cleanForChecks("slot-1")).rejects.toMatchObject({
      code: "E_SLOT_BROKEN", message: expect.stringContaining("is not a real directory (junction)"),
    });
  });
});
