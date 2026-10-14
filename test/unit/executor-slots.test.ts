import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runArgv } from "../../src/verify/exec";
import type { GitOps, StatusEntry } from "../../src/executor/git";
import { assertSafeSlotDir, createSlotPool, defaultSlotsDir, gcSlots, isSlotRecord, markerPath, slotLockReason, SLOT_NAME_PATTERN, SLOT_SWEEP_MAX_ENTRIES, UNKNOWN_PLAN_GC_AGE_MS } from "../../src/executor/slots/pool";
import { applySlotEnv, registerSlot, slotEnvFor, unregisterSlot } from "../../src/executor/slots/env";
import { detectManagers, SLOT_SWEEP_MAX_ENTRIES as PROVISION_SWEEP_MAX_ENTRIES } from "../../src/executor/slots/provision";
import type { Detection, Provisioner } from "../../src/executor/slots/provision";
import { ExecutorError, GIT_ID_PATTERN, type Clock, type ExecutorConfig, type FileSystem, type FsStat, type SlotRecord } from "../../src/executor/types";

// ---------------------------------------------------------------------------------------------------------------
// Fakes: file system, clock, git, provisioner
// ---------------------------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------------------------
// Slot environment: platform variants, PATH key handling (the registry is process-wide: every test cleans up)
// ---------------------------------------------------------------------------------------------------------------

describe("slot environment: platform variants", () => {
  // A lower-case, non-existent root: its registry key and a lower-case cwd compare equal on every platform, so the
  // POSIX layout can be asked for while running on Windows.
  const ENV_ROOT = process.platform === "win32" ? "c:\\omr-env-variants\\slot" : "/omr-env-variants/slot";
  afterEach(() => { unregisterSlot(ENV_ROOT); });

  it("lays out a Python slot with the POSIX venv directory and a Node slot with node_modules/.bin", () => {
    registerSlot({ root: ENV_ROOT, managers: ["uv", "pnpm"] });
    const both = slotEnvFor(ENV_ROOT, "linux");
    expect(both?.root).toBe(ENV_ROOT);
    expect(both?.set).toEqual({ VIRTUAL_ENV: `${ENV_ROOT}/.venv` });
    expect(both?.prependPath).toEqual([`${ENV_ROOT}/.venv/bin`, `${ENV_ROOT}/node_modules/.bin`]);
    expect(both?.unset).toEqual(["PYTHONPATH", "PYTHONHOME", "NODE_PATH", "UV_PROJECT_ENVIRONMENT"]);

    registerSlot({ root: ENV_ROOT, managers: ["npm"] });
    const node = slotEnvFor(ENV_ROOT, "linux");
    expect(node?.set).toEqual({});
    expect(node?.prependPath).toEqual([`${ENV_ROOT}/node_modules/.bin`]);

    registerSlot({ root: ENV_ROOT, managers: [] });
    expect(slotEnvFor(ENV_ROOT, "linux")).toMatchObject({ set: {}, prependPath: [] });
  });

  it("uses the Windows layout for the same slot when asked for win32", () => {
    registerSlot({ root: ENV_ROOT, managers: ["pip"] });
    const env = slotEnvFor(ENV_ROOT, "win32");
    expect(env?.prependPath).toEqual([win32.join(ENV_ROOT, ".venv", "Scripts")]);
    expect(env?.set).toEqual({ VIRTUAL_ENV: win32.join(ENV_ROOT, ".venv") });
  });

  it("forgets an unregistered slot and ignores one it never knew", () => {
    registerSlot({ root: ENV_ROOT, managers: ["pip"] });
    expect(slotEnvFor(ENV_ROOT, "linux")).not.toBeNull();
    unregisterSlot(ENV_ROOT);
    unregisterSlot(ENV_ROOT);
    expect(slotEnvFor(ENV_ROOT, "linux")).toBeNull();
  });

  it("applySlotEnv returns the very same object without a slot, and leaves PATH alone when nothing is prepended", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/bin", PYTHONPATH: "/elsewhere" };
    expect(applySlotEnv(env, null, "linux")).toBe(env);
    const out = applySlotEnv(env, { root: "/s", set: {}, prependPath: [], unset: ["PYTHONPATH"], bins: [] }, "linux");
    expect(out).not.toBe(env);
    expect(out).toEqual({ PATH: "/bin" });
    expect(env["PYTHONPATH"]).toBe("/elsewhere");
  });

  it("applySlotEnv on POSIX is case-sensitive and joins PATH with a colon", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", pythonpath: "keep", PYTHONPATH: "drop", virtual_env: "keep" };
    const out = applySlotEnv(env, { root: "/s", set: { VIRTUAL_ENV: "/s/.venv" }, prependPath: ["/s/.venv/bin", "/s/node_modules/.bin"], unset: ["PYTHONPATH"], bins: [] }, "linux");
    expect(out).toEqual({ PATH: "/s/.venv/bin:/s/node_modules/.bin:/usr/bin", pythonpath: "keep", virtual_env: "keep", VIRTUAL_ENV: "/s/.venv" });
  });

  // POSIX names are case-sensitive: a `Path` variable that precedes `PATH` is left alone and never read as the search path.
  it("D1: applySlotEnv on POSIX prepends to the PATH variable, not to a differently-cased Path", () => {
    const env: NodeJS.ProcessEnv = { Path: "keep", PATH: "/usr/bin" };
    const out = applySlotEnv(env, { root: "/s", set: {}, prependPath: ["/s/node_modules/.bin"], unset: [], bins: [] }, "linux");
    expect(out).toEqual({ Path: "keep", PATH: "/s/node_modules/.bin:/usr/bin" });
  });

  it("applySlotEnv on win32 matches names case-insensitively and keeps a single PATH key", () => {
    const env: NodeJS.ProcessEnv = { pythonpath: "drop", Virtual_Env: "old", Path: "C:\\Windows", PATH: "C:\\Windows", Other: "x" };
    const out = applySlotEnv(env, { root: "C:\\s", set: { VIRTUAL_ENV: "C:\\s\\.venv" }, prependPath: ["C:\\s\\.venv\\Scripts"], unset: ["PYTHONPATH"], bins: [] }, "win32");
    expect(Object.keys(out).filter(k => k.toLowerCase() === "path")).toHaveLength(1);
    expect(Object.entries(out).find(([k]) => k.toLowerCase() === "path")?.[1]).toBe("C:\\s\\.venv\\Scripts;C:\\Windows");
    expect(out["VIRTUAL_ENV"]).toBe("C:\\s\\.venv");
    expect(Object.keys(out).filter(k => k.toLowerCase() === "virtual_env")).toEqual(["VIRTUAL_ENV"]);
    expect(Object.keys(out).filter(k => k.toLowerCase() === "pythonpath")).toEqual([]);
    expect(out["Other"]).toBe("x");
  });

  it("applySlotEnv creates PATH when there is none, and ignores an empty one", () => {
    const slot = { root: "/s", set: {}, prependPath: ["/s/node_modules/.bin"], unset: [], bins: [] };
    expect(applySlotEnv({}, slot, "linux")).toEqual({ PATH: "/s/node_modules/.bin" });
    expect(applySlotEnv({ PATH: "" }, slot, "linux")).toEqual({ PATH: "/s/node_modules/.bin" });
    expect(applySlotEnv({ Path: "" }, { ...slot, prependPath: ["C:\\s\\node_modules\\.bin"] }, "win32")).toEqual({ Path: "C:\\s\\node_modules\\.bin" });
  });
});

const PLAN = "p-20261010-abc123";
const TOP = "D:\\repo\\main";
const HOME = "D:\\omr-home";
const MARKERS = "D:\\omr-home\\markers";
const SLOTS = `D:\\omr-slots\\${PLAN}`;
const C1 = "1".repeat(40);
const C2 = "2".repeat(40);
const C3 = "3".repeat(40);
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
  /** junction/symlink key -> target path. */
  targets: Map<string, string>;
  removed: Array<{ path: string; recursive: boolean }>;
  /** Paths whose rm fails: error code and the number of failures left (Infinity for always). */
  rmFailures: Map<string, { code: string; times: number }>;
  /** Text of every marker temp file written, in order. */
  markerWrites: string[];
  put(path: string, text: string): void;
  dir(path: string): void;
  text(path: string): string | null;
}

function memFs(): MemFs {
  const nodes = new Map<string, Node>();
  const targets = new Map<string, string>();
  const removed: MemFs["removed"] = [];
  const rmFailures: MemFs["rmFailures"] = new Map();
  const markerWrites: string[] = [];
  const parentOf = (k: string): string => k.split("/").slice(0, -1).join("/");
  const children = (k: string): string[] => [...nodes.keys()].filter(c => parentOf(c) === k);
  /** Test seeding behaves like `mkdir -p`: every missing ancestor becomes a directory. */
  const ensureParents = (k: string): void => {
    for (let up = parentOf(k); up !== "" && !nodes.has(up); up = parentOf(up)) nodes.set(up, "dir");
  };
  const fs: MemFs = {
    nodes, targets, removed, rmFailures, markerWrites,
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
      if (p.endsWith(".tmp")) markerWrites.push(data);
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
        throw errno(failing.code, p);
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
      targets.delete(k);
    },
    async mkdir(p) {
      if (nodes.has(key(p))) throw errno("EEXIST", p);
      nodes.set(key(p), "dir");
    },
    async readdir(p) {
      const k = key(p);
      const n = nodes.get(k);
      if (n === undefined) throw errno("ENOENT", p);
      return children(k).map(c => c.split("/").at(-1) ?? "");
    },
    async lstat(p): Promise<FsStat | null> {
      const n = nodes.get(key(p));
      if (n === undefined) return null;
      if (typeof n === "string") return { kind: n, size: 0, mtimeMs: 0 };
      return { kind: "file", size: n.text.length, mtimeMs: 0 };
    },
    async realpath(p) {
      const parts = key(p).split("/");
      let acc = "";
      for (let i = 0; i < parts.length; i++) {
        acc = i === 0 ? (parts[0] ?? "") : `${acc}/${parts[i]}`;
        const target = targets.get(acc);
        if (target !== undefined) return [key(target), ...parts.slice(i + 1)].join("/").replace(/\//g, "\\");
      }
      return key(p).replace(/\//g, "\\");
    },
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
  /** Files of the checkout, written into every added worktree; the tracked list is its keys. */
  files: Record<string, string>;
  status: StatusEntry[];
  topHead: string;
  /** op -> error thrown by the next `times` calls. */
  fail: Map<string, { error: Error; times: number }>;
  badPointers: Set<string>;
  cleanKeeps: string[][];
  /** keep lists of every cleanTracked (reset) and cleanPreview call. */
  resetKeeps: string[][];
  previewKeeps: string[][];
  /** What `git clean -ndx` lists (slot-relative paths), per call; a function sees the slot and the keep list. */
  preview: (slot: string, keep: readonly string[]) => string[];
  /** Tracked links of the index. */
  links: string[];
  /** Admin entries of the added worktrees: key(path) -> lock reason. Seed it for folders that were not added through the fake. */
  worktrees: Map<string, string>;
}

function fakeGit(fs: MemFs): FakeGit {
  const maybeFail = (op: string): void => {
    const f = g.fail.get(op);
    if (f !== undefined && f.times > 0) { f.times -= 1; throw f.error; }
  };
  const g: FakeGit = {
    planId: PLAN, log: [], heads: new Map(), files: { "requirements.txt": "pytest\n" }, status: [], topHead: C1,
    fail: new Map(), badPointers: new Set(), cleanKeeps: [], resetKeeps: [], previewKeeps: [],
    preview: () => [], links: [], worktrees: new Map(),
    version: unused, checkRefFormat: unused, addAll: unused,
    async worktreeList() {
      return [...g.worktrees.entries()].map(([path, locked]) => ({ path: path.replace(/\//g, "\\"), head: null, branch: null, locked }));
    },
    async cleanPreview(slot, keep) { g.previewKeeps.push([...keep]); return g.preview(slot, keep); },
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
      g.log.push(`remove ${key(path)}`);
      const held = g.worktrees.get(key(path));
      if (held !== undefined && held !== lockReason) throw new ExecutorError("E_GIT", "worktree is locked by someone else", { op: "worktree remove" });
      g.worktrees.delete(key(path));
    },
    async checkoutDetach(slot, commit) { maybeFail("checkoutDetach"); g.log.push(`checkout ${key(slot)} ${commit.slice(0, 2)}`); g.heads.set(key(slot), commit); },
    async cleanTracked(slot, keep) { maybeFail("cleanTracked"); g.log.push(`clean ${key(slot)}`); g.resetKeeps.push([...keep]); },
    async cleanForChecks(slot, keep) { maybeFail("cleanForChecks"); g.log.push(`cleanForChecks ${key(slot)}`); g.cleanKeeps.push([...keep]); },
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
  /** The AbortSignal each provision call received. */
  signals: Array<AbortSignal | undefined>;
  error: Error | null;
  /** When set, provision waits for it. */
  gate: Promise<void> | null;
}

function fakeProvisioner(fs: FileSystem, config: Pick<ExecutorConfig, "provision" | "python"> = { provision: "auto", python: "auto" }): FakeProvisioner {
  const p: FakeProvisioner = {
    calls: [], error: null, gate: null, signals: [],
    detect: (slot, tracked) => detectManagers(slot, tracked, fs, config),
    async provision(slot: string, d: Detection, o: { fresh: boolean; signal?: AbortSignal }) {
      p.calls.push({ slot, managers: [...d.managers], fresh: o.fresh });
      p.signals.push(o.signal);
      if (p.gate !== null) await p.gate;
      if (p.error !== null) throw p.error;
    },
  };
  return p;
}

interface Harness {
  pool: ReturnType<typeof createSlotPool>;
  fs: MemFs; git: FakeGit; clock: ReturnType<typeof autoClock>; prov: FakeProvisioner;
  provisioned: string[]; warnings: string[];
  states(slot: string): string[];
  marker(slot: string): SlotRecord;
}

function harness(o: { maxParallel?: number; fs?: MemFs; config?: Pick<ExecutorConfig, "provision" | "python"> } = {}): Harness {
  const fs = o.fs ?? memFs();
  const git = fakeGit(fs);
  const clock = autoClock();
  const prov = fakeProvisioner(fs, o.config);
  const provisioned: string[] = [];
  const warnings: string[] = [];
  const pool = createSlotPool({
    planId: PLAN, repoKey: "repo-key", toplevel: TOP, slotsDir: SLOTS, markersDir: MARKERS, executorHome: HOME,
    maxParallel: o.maxParallel ?? 4, git, fs, clock, provisioner: prov, platform: "win32",
    logger: { warn: (m) => { warnings.push(m); } }, onProvision: (slot, managers) => { provisioned.push(`${slot}:${managers.join(",")}`); },
  });
  const read = (slot: string): SlotRecord => {
    const text = fs.text(markerPath(MARKERS, PLAN, slot));
    if (text === null) throw new Error(`no marker for ${slot}`);
    return JSON.parse(text) as SlotRecord;
  };
  return {
    pool, fs, git, clock, prov, provisioned, warnings, marker: read,
    states: (slot) => fs.markerWrites.map(t => JSON.parse(t) as SlotRecord).filter(r => r.slot === slot).map(r => r.state),
  };
}

afterEach(() => {
  const registry: unknown = Reflect.get(globalThis, Symbol.for("omr.executor.slots"));
  if (registry instanceof Map) registry.clear();
});

// ---------------------------------------------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------------------------------------------

describe("SlotPool lifecycle", () => {
  it("creates, provisions and leases a slot, writing a marker for every state", async () => {
    const h = harness();
    await h.pool.open();
    const lease = await h.pool.acquire(PLAN, "task-1", C1);
    expect(lease).toEqual({ slot: "slot-1", path: slotPath("slot-1"), planId: PLAN, owner: "task-1", commit: C1 });
    expect(h.states("slot-1")).toEqual(["creating", "provisioning", "leased"]);
    expect(h.git.log).toEqual([`add ${key(slotPath("slot-1"))}`]);
    expect(h.prov.calls).toEqual([{ slot: slotPath("slot-1"), managers: ["pip"], fresh: false }]);
    expect(h.provisioned).toEqual(["slot-1:pip"]);
    const rec = h.marker("slot-1");
    expect(rec).toMatchObject({ schema: 1, kind: "task", state: "leased", owner: "task-1", commit: C1, managers: ["pip"], repoKey: "repo-key" });
    expect(Object.keys(rec.manifests)).toEqual(["requirements.txt"]);
    expect(isSlotRecord(rec)).toBe(true);
    expect(await h.fs.lstat(SLOTS)).not.toBeNull();
  });

  it("registers the slot environment once it is usable and drops it when released slots are retired", async () => {
    const h = harness();
    await h.pool.open();
    const lease = await h.pool.acquire(PLAN, "task-1", C1);
    const env = slotEnvFor(lease.path, "win32");
    expect(env?.set["VIRTUAL_ENV"]).toBe(win32.join(lease.path, ".venv"));
    expect(slotEnvFor(slotPath("slot-2"), "win32")).toBeNull();
  });

  it("a slot without a package manager is leased without provisioning", async () => {
    const h = harness();
    h.git.files = { "README.md": "x" };
    await h.pool.open();
    await h.pool.acquire(PLAN, "task-1", C1);
    expect(h.prov.calls).toHaveLength(0);
    expect(h.marker("slot-1").managers).toEqual([]);
    expect(slotEnvFor(slotPath("slot-1"), "win32")).toBeNull();
  });

  it("release moves leased to ready and is idempotent", async () => {
    const h = harness();
    await h.pool.open();
    await h.pool.acquire(PLAN, "task-1", C1);
    await h.pool.release("slot-1");
    expect(h.marker("slot-1")).toMatchObject({ state: "ready", owner: null });
    const writes = h.fs.markerWrites.length;
    await h.pool.release("slot-1");
    await h.pool.release("slot-1");
    await h.pool.release("slot-9");
    expect(h.fs.markerWrites.length).toBe(writes);
    expect((await h.pool.get("slot-1"))?.state).toBe("ready");
    expect(await h.pool.get("slot-9")).toBeNull();
  });

  it("notifies task-slot release only after durability, never on failure, no-op, special slots or unsubscribe", async () => {
    const h = harness();
    await h.pool.open();
    const lease = await h.pool.acquire(PLAN, "task-1", C1);
    const special = await h.pool.acquireSpecial(PLAN, "integration");
    let flushed = false;
    const notifications: boolean[] = [];
    h.pool.onTaskSlotReleased?.(() => { throw new Error("subscriber failed"); });
    const off = h.pool.onTaskSlotReleased?.(() => { notifications.push(flushed); });
    const fsync = h.fs.fsyncDir.bind(h.fs);
    h.fs.fsyncDir = async () => { throw new Error("flush failed"); };
    await expect(h.pool.release(lease.slot)).rejects.toThrow("flush failed");
    expect(notifications).toEqual([]);
    expect(await h.pool.get(lease.slot)).toMatchObject({ state: "leased" });
    h.fs.fsyncDir = async path => {
      expect(notifications).toEqual([]);
      await fsync(path);
      flushed = true;
    };
    await h.pool.release(lease.slot);
    expect(notifications).toEqual([true]);
    h.fs.fsyncDir = fsync;
    await h.pool.release(lease.slot);
    await h.pool.release("slot-9");
    await h.pool.release(special.slot);
    expect(notifications).toEqual([true]);
    off?.();
    const again = await h.pool.acquire(PLAN, "task-2", C1);
    await h.pool.release(again.slot);
    expect(notifications).toEqual([true]);
    h.pool.close();
  });

  it("reuses a ready slot through resetting without reinstalling", async () => {
    const h = harness();
    await h.pool.open();
    await h.pool.acquire(PLAN, "task-1", C1);
    await h.pool.release("slot-1");
    const lease = await h.pool.acquire(PLAN, "task-2", C2);
    expect(lease).toMatchObject({ slot: "slot-1", owner: "task-2", commit: C2 });
    expect(h.states("slot-1").slice(3)).toEqual(["ready", "resetting", "leased"]);
    expect(h.git.log).toEqual([`add ${key(slotPath("slot-1"))}`, `checkout ${key(slotPath("slot-1"))} 22`, `clean ${key(slotPath("slot-1"))}`]);
    expect(h.prov.calls).toHaveLength(1);
    expect(h.provisioned).toHaveLength(1);
  });

  it("prefers the ready slot already at the requested commit", async () => {
    const h = harness();
    await h.pool.open();
    const a = await h.pool.acquire(PLAN, "a", C1);
    const b = await h.pool.acquire(PLAN, "b", C2);
    await h.pool.release(a.slot);
    await h.pool.release(b.slot);
    const again = await h.pool.acquire(PLAN, "c", C2);
    expect(again.slot).toBe(b.slot);
  });

  it("returns the same slot to the same owner", async () => {
    const h = harness();
    await h.pool.open();
    const first = await h.pool.acquire(PLAN, "task-1", C1);
    const second = await h.pool.acquire(PLAN, "task-1", C1);
    expect(second).toEqual(first);
    expect(await h.pool.list()).toHaveLength(1);
    expect(h.prov.calls).toHaveLength(1);
  });

  it("reset moves a leased slot to another commit and re-provisions on drift", async () => {
    const h = harness();
    await h.pool.open();
    await h.pool.acquire(PLAN, "task-1", C1);
    await h.pool.reset("slot-1", C2);
    expect(h.states("slot-1").slice(3)).toEqual(["resetting", "leased"]);
    expect(h.marker("slot-1")).toMatchObject({ state: "leased", commit: C2, owner: "task-1" });
    expect(h.prov.calls).toHaveLength(1);
    h.git.files["requirements.txt"] = "pytest==9\n";
    h.fs.put(win32.join(slotPath("slot-1"), "requirements.txt"), "pytest==9\n");
    const before = h.marker("slot-1").manifests;
    await h.pool.reset("slot-1", C3);
    expect(h.prov.calls).toHaveLength(2);
    expect(h.prov.calls[1]).toMatchObject({ fresh: true, managers: ["pip"] });
    expect(h.states("slot-1").slice(5)).toEqual(["resetting", "provisioning", "leased"]);
    expect(h.marker("slot-1").manifests).not.toEqual(before);
  });

  it("reset retries once after a delay and then reports the slot as held by a process", async () => {
    const h = harness();
    await h.pool.open();
    await h.pool.acquire(PLAN, "task-1", C1);
    h.git.fail.set("checkoutDetach", { error: Object.assign(new Error("EBUSY"), { code: "EBUSY" }), times: 1 });
    await h.pool.reset("slot-1", C2);
    expect(h.clock.slept).toContain(2000);
    expect(h.marker("slot-1").state).toBe("leased");
    h.git.fail.set("checkoutDetach", { error: Object.assign(new Error("EBUSY"), { code: "EBUSY" }), times: 5 });
    await expect(h.pool.reset("slot-1", C3)).rejects.toMatchObject({ code: "E_SLOT_BROKEN", message: expect.stringContaining("held by a running process") });
    expect(h.marker("slot-1")).toMatchObject({ state: "broken", owner: null });
    expect(slotEnvFor(slotPath("slot-1"), "win32")).toBeNull();
  });

  it("reset refuses a slot that is not leased, an unknown slot and a bad commit", async () => {
    const h = harness();
    await h.pool.open();
    await h.pool.acquire(PLAN, "task-1", C1);
    await h.pool.release("slot-1");
    await expect(h.pool.reset("slot-1", C2)).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
    await expect(h.pool.reset("slot-7", C2)).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
    await expect(h.pool.reset("slot-1", "HEAD")).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
    await expect(h.pool.reset("../x", C2)).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
  });

  it("a dirty slot after reset breaks it", async () => {
    const h = harness();
    await h.pool.open();
    await h.pool.acquire(PLAN, "task-1", C1);
    h.git.status = [{ xy: "??", path: "stray.txt", orig: null }];
    await expect(h.pool.reset("slot-1", C2)).rejects.toMatchObject({ code: "E_SLOT_BROKEN" });
    expect(h.marker("slot-1").state).toBe("broken");
  });

  it("cleanForChecks keeps the dependency directories of the slot's managers", async () => {
    const cases: Array<[Record<string, string>, string[]]> = [
      [{ "requirements.txt": "x" }, ["/.venv"]],
      [{ "package.json": "{}", "pnpm-lock.yaml": "l" }, ["node_modules"]],
      [{ "package.json": "{}", "pnpm-lock.yaml": "l", "requirements.txt": "x" }, ["node_modules", "/.venv"]],
      [{ "package.json": "{}", "yarn.lock": "l", ".yarnrc.yml": "nodeLinker: pnp\n" }, ["node_modules", "/.yarn", "/.pnp.*"]],
      [{ "README.md": "x" }, []],
    ];
    for (const [files, keep] of cases) {
      const h = harness();
      h.git.files = files;
      await h.pool.open();
      await h.pool.acquire(PLAN, "t", C1);
      await h.pool.cleanForChecks("slot-1");
      expect(h.git.cleanKeeps).toEqual([keep]);
      expect(h.marker("slot-1").state).toBe("leased");
    }
  });

  it("cleanForChecks re-provisions when a manifest changed and refuses a slot that is not leased", async () => {
    const h = harness();
    await h.pool.open();
    await h.pool.acquire(PLAN, "t", C1);
    h.fs.put(win32.join(slotPath("slot-1"), "requirements.txt"), "changed\n");
    await h.pool.cleanForChecks("slot-1");
    expect(h.prov.calls).toHaveLength(2);
    expect(h.prov.calls[1]?.fresh).toBe(true);
    await h.pool.release("slot-1");
    await expect(h.pool.cleanForChecks("slot-1")).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
    await expect(h.pool.cleanForChecks("slot-5")).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
  });

  it("cleanForChecks sweeps links that are not tracked and leaves the dependency directories", async () => {
    const h = harness();
    await h.pool.open();
    await h.pool.acquire(PLAN, "t", C1);
    const s = slotPath("slot-1");
    h.fs.dir(win32.join(s, "node_modules"));
    h.fs.nodes.set(key(win32.join(s, "node_modules", "inner-link")), "junction");
    h.fs.nodes.set(key(win32.join(s, "stray-link")), "junction");
    h.fs.targets.set(key(win32.join(s, "stray-link")), "D:\\elsewhere");
    await h.pool.cleanForChecks("slot-1");
    expect(h.fs.removed).toContainEqual({ path: win32.join(s, "stray-link"), recursive: false });
    expect(h.fs.removed.some(r => key(r.path).includes("inner-link"))).toBe(false);
  });

  it("a failing provision breaks the slot, keeps E_PROVISION and frees the slot number for a retry", async () => {
    const h = harness();
    await h.pool.open();
    h.prov.error = new ExecutorError("E_PROVISION", "pip install failed", {});
    await expect(h.pool.acquire(PLAN, "t", C1)).rejects.toMatchObject({ code: "E_PROVISION" });
    expect(h.marker("slot-1")).toMatchObject({ state: "broken", owner: null });
    expect(h.states("slot-1")).toEqual(["creating", "provisioning", "broken"]);
    expect(slotEnvFor(slotPath("slot-1"), "win32")).toBeNull();
  });

  it("a git failure while creating is reported as E_SLOT_BROKEN", async () => {
    const h = harness();
    await h.pool.open();
    h.git.fail.set("worktreeAdd", { error: new ExecutorError("E_GIT", "worktree add failed", { op: "worktree add", code: 128, stderr: "" }), times: 1 });
    await expect(h.pool.acquire(PLAN, "t", C1)).rejects.toMatchObject({ code: "E_SLOT_BROKEN" });
    expect(h.marker("slot-1").state).toBe("broken");
  });

  it("a broken slot is retired and replaced when the pool is full", async () => {
    const h = harness({ maxParallel: 1 });
    await h.pool.open();
    h.prov.error = new Error("boom");
    await expect(h.pool.acquire(PLAN, "t", C1)).rejects.toMatchObject({ code: "E_SLOT_BROKEN" });
    h.prov.error = null;
    const lease = await h.pool.acquire(PLAN, "u", C1);
    expect(lease.slot).toBe("slot-2");
    expect(h.marker("slot-2")).toMatchObject({ state: "leased", owner: "u" });
    expect(h.marker("slot-1")).toMatchObject({ state: "retired", owner: null });
    expect(slotEnvFor(slotPath("slot-1"), "win32")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Concurrency, special slots, input validation, open()
// ---------------------------------------------------------------------------------------------------------------

describe("QA-5.1-22: gc-only handle and the purge's empty plan directory", () => {
  it("open({ create: false }) creates no directory, never leases, and gcs a missing slotsDir to nothing", async () => {
    const h = harness();
    await h.pool.open({ create: false });
    expect(await h.fs.lstat(SLOTS)).toBeNull();
    await expect(h.pool.acquire(PLAN, "task-1", C1)).rejects.toMatchObject({ code: "E_PLAN_STATE" });
    expect(await h.pool.gc(async () => true)).toEqual({ removed: [], reported: [] });
    expect(await h.fs.lstat(SLOTS)).toBeNull();
    expect(await h.pool.removeEmptyDir()).toBe(true);
    expect(await h.fs.lstat(SLOTS)).toBeNull();
  });

  it("a gc-only handle collects a finished plan's slots; removeEmptyDir then removes the empty slotsDir", async () => {
    const live = harness();
    await live.pool.open();
    const lease = await live.pool.acquire(PLAN, "task-1", C1);
    await live.pool.release(lease.slot);
    live.pool.close();
    // The gc-only handle works on the same repository: the same files AND the same git, whose worktree list names the
    // slot as locked by the executor (retireSlot deletes nothing git does not list that way).
    const pool = createSlotPool({
      planId: PLAN, repoKey: "repo-key", toplevel: TOP, slotsDir: SLOTS, markersDir: MARKERS, executorHome: HOME,
      maxParallel: 4, git: live.git, fs: live.fs, clock: live.clock, provisioner: live.prov, platform: "win32",
    });
    await pool.open({ create: false });
    expect(await live.fs.lstat(SLOTS)).not.toBeNull();
    const out = await pool.gc(async (id) => id === PLAN);
    expect(out).toEqual({ removed: [slotPath("slot-1")], reported: [] });
    expect(await pool.list()).toEqual([]);
    expect(await pool.removeEmptyDir()).toBe(true);
    expect(await live.fs.lstat(SLOTS)).toBeNull();
  });

  it("removeEmptyDir keeps a slotsDir that still holds a slot of the plan", async () => {
    const h = harness();
    await h.pool.open();
    await h.pool.acquire(PLAN, "task-1", C1);
    expect(await h.pool.removeEmptyDir()).toBe(false);
    expect(await h.fs.lstat(SLOTS)).not.toBeNull();
  });
});

describe("SlotPool concurrency", () => {
  it("8 acquires on 4 slots: 4 succeed with distinct slots, 4 are refused as unavailable", async () => {
    const h = harness({ maxParallel: 4 });
    await h.pool.open();
    let open: () => void = () => undefined;
    h.prov.gate = new Promise<void>(resolve => { open = resolve; });
    const attempts = Array.from({ length: 8 }, (_, n) => h.pool.acquire(PLAN, `owner-${n + 1}`, C1));
    const settled = Promise.allSettled(attempts);
    await new Promise<void>(resolve => { setImmediate(resolve); });
    open();
    const results = await settled;
    const ok = results.filter((r): r is PromiseFulfilledResult<Awaited<(typeof attempts)[number]>> => r.status === "fulfilled");
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(4);
    expect(refused).toHaveLength(4);
    expect(new Set(ok.map(r => r.value.slot)).size).toBe(4);
    expect(ok.map(r => r.value.owner)).toEqual(["owner-1", "owner-2", "owner-3", "owner-4"]);
    for (const r of refused) {
      expect(r.reason).toMatchObject({ code: "E_SLOT_UNAVAILABLE" });
      expect(JSON.stringify((r.reason as ExecutorError).detail)).toContain("owner-1");
    }
    expect((await h.pool.list()).map(s => s.slot)).toEqual(["slot-1", "slot-2", "slot-3", "slot-4"]);
  });

  it("after one release the next waiting acquire succeeds", async () => {
    const h = harness({ maxParallel: 1 });
    await h.pool.open();
    const first = await h.pool.acquire(PLAN, "a", C1);
    await expect(h.pool.acquire(PLAN, "b", C1)).rejects.toMatchObject({ code: "E_SLOT_UNAVAILABLE" });
    await h.pool.release(first.slot);
    await expect(h.pool.acquire(PLAN, "b", C1)).resolves.toMatchObject({ slot: "slot-1", owner: "b" });
  });

  it("two concurrent acquires by one owner share a slot", async () => {
    const h = harness();
    await h.pool.open();
    const [a, b] = await Promise.all([h.pool.acquire(PLAN, "same", C1), h.pool.acquire(PLAN, "same", C1)]);
    expect(a).toEqual(b);
    expect(await h.pool.list()).toHaveLength(1);
  });
});

describe("SlotPool special slots", () => {
  it("leases integration and ci slots at the toplevel HEAD and reuses them through reset", async () => {
    const h = harness({ maxParallel: 1 });
    await h.pool.open();
    h.git.topHead = C2;
    const integration = await h.pool.acquireSpecial(PLAN, "integration");
    expect(integration).toEqual({ slot: "integration", path: slotPath("integration"), planId: PLAN, owner: "integration", commit: C2 });
    expect(await h.pool.acquireSpecial(PLAN, "integration")).toEqual(integration);
    const ci = await h.pool.acquireSpecial(PLAN, "ci");
    expect(ci.slot).toBe("ci");
    expect(h.marker("integration").kind).toBe("integration");
    expect(h.marker("ci").kind).toBe("ci");
    await h.pool.acquire(PLAN, "task", C1);
    await h.pool.release("integration");
    await h.pool.acquireSpecial(PLAN, "integration");
    // A special slot is claimed as `resetting`, then re-saved at its current HEAD before the reset runs.
    expect(h.states("integration")).toEqual(["creating", "provisioning", "leased", "ready", "resetting", "resetting", "leased"]);
  });

  it("recreates a broken special slot", async () => {
    const h = harness();
    await h.pool.open();
    h.prov.error = new Error("boom");
    await expect(h.pool.acquireSpecial(PLAN, "ci")).rejects.toMatchObject({ code: "E_SLOT_BROKEN" });
    expect(h.marker("ci").state).toBe("broken");
    h.prov.error = null;
    const lease = await h.pool.acquireSpecial(PLAN, "ci");
    expect(lease.slot).toBe("ci");
    expect(h.marker("ci")).toMatchObject({ state: "leased", owner: "ci" });
    expect(h.git.log).toContain(`remove ${key(slotPath("ci"))}`);
  });

  it("a broken special slot whose marker changed on disk is not retired", async () => {
    const h = seeded([record("ci", { state: "broken", owner: "ci" })], [slotPath("ci")]);
    await h.pool.open();
    h.fs.put(markerPath(MARKERS, PLAN, "ci"), JSON.stringify(record("ci", { state: "broken", owner: "ci", path: slotPath("ci", "D:\\omr-slots\\other") })));
    await expect(h.pool.acquireSpecial(PLAN, "ci")).rejects.toThrow(/marker changed while collecting/);
    expect(h.git.log).not.toContain(`remove ${key(slotPath("ci"))}`);
  });

  it("rejects unknown kinds and another plan's id", async () => {
    const h = harness();
    await h.pool.open();
    await expect(h.pool.acquireSpecial(PLAN, "slot-1" as "ci")).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
    await expect(h.pool.acquireSpecial("p-20261010-other1", "ci")).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
  });
});

describe("SlotPool input validation and open()", () => {
  it("rejects bad arguments and a pool that is not open", async () => {
    const h = harness();
    await expect(h.pool.acquire(PLAN, "t", C1)).rejects.toMatchObject({ code: "E_PLAN_STATE" });
    await expect(h.pool.gc(async () => true)).rejects.toMatchObject({ code: "E_PLAN_STATE" });
    await h.pool.open();
    await h.pool.open();
    await expect(h.pool.acquire("p-20261010-other1", "t", C1)).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
    await expect(h.pool.acquire(PLAN, "t", "abc")).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
    await expect(h.pool.acquire(PLAN, "", C1)).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
    await expect(h.pool.acquire(PLAN, "x".repeat(129), C1)).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
    await expect(h.pool.acquire(PLAN, "tab\there", C1)).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
    await expect(h.pool.release("../x")).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
    await expect(h.pool.list("Bad Plan")).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
  });

  function poolAt(slotsDir: string, over: { toplevel?: string; maxParallel?: number; fs?: MemFs } = {}) {
    const fs = over.fs ?? memFs();
    return createSlotPool({
      planId: PLAN, repoKey: "repo-key", toplevel: over.toplevel ?? TOP, slotsDir, markersDir: MARKERS, executorHome: HOME,
      maxParallel: over.maxParallel ?? 4, git: fakeGit(fs), fs, clock: autoClock(), provisioner: fakeProvisioner(fs), platform: "win32",
    });
  }

  it.each([
    ["empty", ""], ["a drive root", "D:\\"], ["a relative path", "slots"], ["a UNC path", "\\\\host\\share\\slots"],
    ["a dot segment", "D:\\omr-slots\\..\\x"], ["inside the repository", "D:\\repo\\main\\slots"], ["above the repository", "D:\\repo"],
  ])("refuses a slotsDir that is %s", async (_label, dir) => {
    await expect(poolAt(dir).open()).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
  });

  it("refuses a non-positive maxParallel", async () => {
    await expect(poolAt(SLOTS, { maxParallel: 0 }).open()).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
  });

  it("refuses a slotsDir that is a file, a link, or claimed by another plan", async () => {
    const asFile = memFs();
    asFile.put(SLOTS, "x");
    await expect(poolAt(SLOTS, { fs: asFile }).open()).rejects.toMatchObject({ code: "E_SLOT_UNAVAILABLE" });
    const linked = memFs();
    linked.dir("D:\\omr-slots");
    linked.dir(SLOTS);
    linked.targets.set(key("D:\\omr-slots"), "D:\\elsewhere");
    await expect(poolAt(SLOTS, { fs: linked }).open()).rejects.toMatchObject({ code: "E_SLOT_UNAVAILABLE", message: expect.stringContaining("link") });
    const claimed = memFs();
    const other = "p-20261010-other1";
    const rec = record("slot-1", { planId: other, path: slotPath("slot-1") });
    claimed.put(markerPath(MARKERS, other, "slot-1"), JSON.stringify(rec));
    await expect(poolAt(SLOTS, { fs: claimed }).open()).rejects.toMatchObject({ code: "E_SLOT_UNAVAILABLE", message: expect.stringContaining(other) });
  });

  it("default slotsDir is on the repository drive and needs a drive letter", () => {
    expect(defaultSlotsDir("D:\\repo\\main", PLAN)).toBe(`D:\\.omr-slots\\${PLAN}`);
    expect(defaultSlotsDir("c:/repo", PLAN)).toBe(`c:\\.omr-slots\\${PLAN}`);
    expect(() => defaultSlotsDir("/home/a/repo", PLAN)).toThrow(/drive-letter/);
    expect(() => defaultSlotsDir("D:\\repo", "BAD")).toThrow(/invalid plan id/);
  });

  it("list of another plan reads that plan's markers", async () => {
    const fs = memFs();
    const other = "p-20261010-other1";
    fs.put(markerPath(MARKERS, other, "slot-2"), JSON.stringify(record("slot-2", { planId: other, path: slotPath("slot-2", `D:\\omr-slots\\${other}`) })));
    fs.put(markerPath(MARKERS, other, "slot-1"), JSON.stringify(record("slot-1", { planId: other, path: slotPath("slot-1", `D:\\omr-slots\\${other}`) })));
    const h = harness({ fs });
    await h.pool.open();
    expect((await h.pool.list(other)).map(r => r.slot)).toEqual(["slot-1", "slot-2"]);
    expect(await h.pool.list()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Repair of interrupted stages
// ---------------------------------------------------------------------------------------------------------------

function record(slot: string, over: Partial<SlotRecord> = {}): SlotRecord {
  const iso = autoClock().iso();
  return {
    schema: 1, slot, path: slotPath(slot), kind: slot === "integration" ? "integration" : slot === "ci" ? "ci" : "task",
    planId: PLAN, repoKey: "repo-key", state: "creating", owner: "t1", commit: C1, managers: [], manifests: {},
    createdAt: iso, updatedAt: iso, ...over,
  };
}

function seeded(recs: SlotRecord[], dirs: string[] = [], maxParallel?: number): Harness {
  const fs = memFs();
  for (const r of recs) fs.put(markerPath(MARKERS, r.planId, r.slot), JSON.stringify(r));
  for (const d of dirs) {
    fs.dir(d);
    fs.put(win32.join(d, "requirements.txt"), "pytest\n");
  }
  return harness({ fs, ...(maxParallel === undefined ? {} : { maxParallel }) });
}

describe("SlotPool claims that meet a changed slot", () => {
  it("a slot released to ready between the claim and the work is claimed again for the same owner", async () => {
    const h = seeded([record("slot-1", { state: "ready", owner: "t1", commit: C1, managers: ["pip"] })], [slotPath("slot-1")]);
    await h.pool.open();
    const lease = await h.pool.acquire(PLAN, "t1", C3);
    expect(lease).toMatchObject({ slot: "slot-1", owner: "t1", commit: C3 });
    // The seeded record carries no manifest digests, so the reset also finds drift and provisions again.
    expect(h.states("slot-1")).toEqual(["resetting", "provisioning", "leased"]);
    expect(h.git.log).toEqual([`checkout ${key(slotPath("slot-1"))} 33`, `clean ${key(slotPath("slot-1"))}`]);
    expect(h.marker("slot-1")).toMatchObject({ state: "leased", owner: "t1", commit: C3 });
  });

  it("a slot that is broken when the work starts is reported as broken, not leased", async () => {
    const h = seeded([record("slot-1", { state: "broken", owner: "t1", managers: ["pip"] })], [slotPath("slot-1")]);
    await h.pool.open();
    await expect(h.pool.acquire(PLAN, "t1", C1)).rejects.toMatchObject({ code: "E_SLOT_BROKEN", message: expect.stringContaining("slot-1 is broken") });
    expect(h.marker("slot-1").state).toBe("broken");
    expect(h.prov.calls).toHaveLength(0);
    expect(h.git.log).toEqual([]);
    expect(slotEnvFor(slotPath("slot-1"), "win32")).toBeNull();
  });
});

describe("SlotPool broken slots", () => {
  it("a failed install breaks the slot in memory even when the broken marker cannot be written", async () => {
    const h = harness();
    await h.pool.open();
    h.prov.error = new Error("install exploded");
    const realWrite = h.fs.writeText.bind(h.fs);
    h.fs.writeText = async (p, data, o) => {
      if (/"state":\s*"broken"/.test(data)) throw errno("ENOSPC", p);
      return realWrite(p, data, o);
    };
    await expect(h.pool.acquire(PLAN, "t1", C1)).rejects.toMatchObject({ code: "E_SLOT_BROKEN" });
    expect(h.warnings.some(w => w.includes("could not write the broken marker of slot-1"))).toBe(true);
    // The marker on disk still says provisioning, but the pool no longer hands the slot out.
    expect(h.marker("slot-1").state).toBe("provisioning");
    expect(await h.pool.get("slot-1")).toMatchObject({ state: "broken", owner: null });
    expect(slotEnvFor(slotPath("slot-1"), "win32")).toBeNull();
  });

  it("with every slot taken, the longest broken one is retired and its number is not reused", async () => {
    const older = autoClock().iso(Date.parse("2026-10-10T00:00:00.000Z"));
    const h = seeded([
      record("slot-1", { state: "broken", owner: null }),
      record("slot-2", { state: "broken", owner: null, updatedAt: older }),
    ], [slotPath("slot-1"), slotPath("slot-2")], 2);
    await h.pool.open();
    const lease = await h.pool.acquire(PLAN, "t3", C1);
    expect(lease.slot).toBe("slot-3");
    expect(h.marker("slot-2")).toMatchObject({ state: "retired", owner: null });
    expect(h.marker("slot-1").state).toBe("broken");
  });

  it("broken slots of equal age are retired in slot order", async () => {
    const h = seeded([
      record("slot-2", { state: "broken", owner: null }),
      record("slot-1", { state: "broken", owner: null }),
    ], [slotPath("slot-1"), slotPath("slot-2")], 2);
    await h.pool.open();
    const lease = await h.pool.acquire(PLAN, "t3", C1);
    expect(lease.slot).toBe("slot-3");
    expect(h.marker("slot-1").state).toBe("retired");
    expect(h.marker("slot-2").state).toBe("broken");
  });

  it("folders without a marker are never adopted: with every slot number taken on disk, acquire reports E_SLOT_UNAVAILABLE", async () => {
    const h = harness();
    for (let n = 1; n <= 999; n++) h.fs.dir(slotPath(`slot-${n}`));
    await h.pool.open();
    await expect(h.pool.acquire(PLAN, "t1", C1)).rejects.toMatchObject({ code: "E_SLOT_UNAVAILABLE" });
    expect(h.git.log).toEqual([]);
    expect(await h.pool.list()).toEqual([]);
  });

  it("with every slot taken and none broken, acquire reports E_SLOT_UNAVAILABLE", async () => {
    const h = seeded([
      record("slot-1", { state: "leased", owner: "t1" }),
      record("slot-2", { state: "leased", owner: "t2" }),
    ], [slotPath("slot-1"), slotPath("slot-2")], 2);
    await h.pool.open();
    await expect(h.pool.acquire(PLAN, "t3", C1)).rejects.toMatchObject({ code: "E_SLOT_UNAVAILABLE" });
  });
});

describe("SlotPool repair", () => {
  it("creating, directory missing: adds the worktree again and provisions fresh", async () => {
    const h = seeded([record("slot-1", { state: "creating" })]);
    await h.pool.open();
    const lease = await h.pool.acquire(PLAN, "t1", C1);
    expect(lease.slot).toBe("slot-1");
    expect(h.git.log).toEqual([`remove ${key(slotPath("slot-1"))}`, `add ${key(slotPath("slot-1"))}`]);
    expect(h.prov.calls[0]?.fresh).toBe(true);
    expect(h.marker("slot-1").state).toBe("leased");
  });

  it("creating, worktree already fine: goes on to provisioning without adding", async () => {
    const h = seeded([record("slot-1", { state: "creating" })], [slotPath("slot-1")]);
    await h.pool.open();
    await h.pool.acquire(PLAN, "t1", C1);
    // QA-2.4-13: the half-made checkout is brought to the recorded commit before provisioning.
    expect(h.git.log).toEqual([`checkout ${key(slotPath("slot-1"))} 11`, `clean ${key(slotPath("slot-1"))}`]);
    expect(h.states("slot-1")).toEqual(["provisioning", "leased"]);
  });

  it("creating, empty half-made directory: removes it and adds again", async () => {
    const h = seeded([record("slot-1", { state: "creating" })]);
    h.fs.dir(slotPath("slot-1"));
    h.git.badPointers.add(key(slotPath("slot-1")));
    await h.pool.open();
    await h.pool.acquire(PLAN, "t1", C1);
    expect(h.fs.removed).toContainEqual({ path: slotPath("slot-1"), recursive: true });
    expect(h.git.log).toEqual([`remove ${key(slotPath("slot-1"))}`, `add ${key(slotPath("slot-1"))}`]);
    expect(h.warnings.some(w => w.includes("half created"))).toBe(true);
    expect(h.marker("slot-1").state).toBe("leased");
  });

  it("creating, non-empty directory with bad pointers: retires it, wipes it and creates it again", async () => {
    const h = seeded([record("slot-1", { state: "creating" })]);
    h.fs.dir(slotPath("slot-1"));
    h.fs.put(win32.join(slotPath("slot-1"), "junk.txt"), "x");
    h.git.badPointers.add(key(slotPath("slot-1")));
    h.git.worktrees.set(key(slotPath("slot-1")), slotLockReason(PLAN, "slot-1"));
    await h.pool.open();
    await h.pool.acquire(PLAN, "t1", C1);
    expect(h.fs.text(win32.join(slotPath("slot-1"), "junk.txt"))).toBeNull();
    expect(h.states("slot-1")).toContain("retired");
    expect(h.git.log).toContain(`add ${key(slotPath("slot-1"))}`);
    expect(h.marker("slot-1")).toMatchObject({ state: "leased", owner: "t1" });
  });

  // QA-2.4-3: a folder git does not list as locked by the executor for this slot is never wiped.
  it("creating, non-empty directory git does not list as ours: nothing is deleted and the slot breaks", async () => {
    const h = seeded([record("slot-1", { state: "creating" })]);
    h.fs.dir(slotPath("slot-1"));
    h.fs.put(win32.join(slotPath("slot-1"), "precious.txt"), "keep");
    h.git.badPointers.add(key(slotPath("slot-1")));
    await h.pool.open();
    await expect(h.pool.acquire(PLAN, "t1", C1)).rejects.toMatchObject({ code: "E_SLOT_BROKEN" });
    expect(h.fs.text(win32.join(slotPath("slot-1"), "precious.txt"))).toBe("keep");
    h.git.worktrees.set(key(slotPath("slot-1")), "somebody else's lock");
    expect(h.fs.removed.some(r => key(r.path) === key(slotPath("slot-1")))).toBe(false);
  });

  // QA-2.4-12
  it("a special slot folder without a marker is never adopted", async () => {
    const h = harness();
    h.fs.dir(slotPath("integration"));
    await h.pool.open();
    await expect(h.pool.acquireSpecial(PLAN, "integration")).rejects.toMatchObject({ code: "E_SLOT_UNAVAILABLE" });
    expect(h.git.log).toEqual([]);
  });

  it("creating, directory is a file or a link: broken", async () => {
    for (const kind of ["file", "junction"] as const) {
      const h = seeded([record("slot-1", { state: "creating" })]);
      if (kind === "file") h.fs.put(slotPath("slot-1"), "x");
      else h.fs.nodes.set(key(slotPath("slot-1")), "junction");
      await h.pool.open();
      await expect(h.pool.acquire(PLAN, "t1", C1)).rejects.toMatchObject({ code: "E_SLOT_BROKEN" });
      expect(h.marker("slot-1").state).toBe("broken");
    }
  });

  it("resetting, directory gone after the pointers were verified: broken, naming the missing directory", async () => {
    const h = seeded([record("slot-1", { state: "resetting", managers: ["pip"] })]);
    h.git.verifySlotPointers = async () => ({ gitdir: `${TOP}\\.git\\worktrees\\x`, common: `${TOP}\\.git` });
    await h.pool.open();
    await expect(h.pool.acquire(PLAN, "t1", C1)).rejects.toMatchObject({
      code: "E_SLOT_BROKEN", message: expect.stringContaining("is not a real directory (missing)"),
    });
    expect(h.marker("slot-1").state).toBe("broken");
  });

  it("provisioning: installs again from scratch", async () => {
    const h = seeded([record("slot-1", { state: "provisioning" })], [slotPath("slot-1")]);
    await h.pool.open();
    await h.pool.acquire(PLAN, "t1", C1);
    expect(h.prov.calls).toEqual([{ slot: slotPath("slot-1"), managers: ["pip"], fresh: true }]);
    expect(h.marker("slot-1")).toMatchObject({ state: "leased", managers: ["pip"] });
  });

  it("provisioning with a broken worktree is broken", async () => {
    const h = seeded([record("slot-1", { state: "provisioning" })], [slotPath("slot-1")]);
    h.git.badPointers.add(key(slotPath("slot-1")));
    await h.pool.open();
    await expect(h.pool.acquire(PLAN, "t1", C1)).rejects.toMatchObject({ code: "E_SLOT_BROKEN" });
    expect(h.marker("slot-1").state).toBe("broken");
  });

  it("resetting: runs the reset again at the recorded commit", async () => {
    const h = seeded([record("slot-1", { state: "resetting", commit: C2 })], [slotPath("slot-1")]);
    await h.pool.open();
    const lease = await h.pool.acquire(PLAN, "t1", C3);
    expect(lease).toMatchObject({ slot: "slot-1", commit: C2 });
    expect(h.git.log).toEqual([`checkout ${key(slotPath("slot-1"))} 22`, `clean ${key(slotPath("slot-1"))}`]);
    expect(h.marker("slot-1").state).toBe("leased");
  });

  it("leased and ready markers survive a restart: the same owner gets its slot, a new owner resets a ready one", async () => {
    const h = seeded([
      record("slot-1", { state: "leased", owner: "t1", managers: ["pip"] }),
      record("slot-2", { state: "ready", owner: null, commit: C1 }),
    ], [slotPath("slot-1"), slotPath("slot-2")]);
    await h.pool.open();
    expect(slotEnvFor(slotPath("slot-1"), "win32")?.set["VIRTUAL_ENV"]).toBeDefined();
    expect(await h.pool.acquire(PLAN, "t1", C1)).toMatchObject({ slot: "slot-1" });
    expect(h.states("slot-1")).toEqual([]);
    expect(await h.pool.acquire(PLAN, "t2", C3)).toMatchObject({ slot: "slot-2", commit: C3 });
    expect(h.marker("slot-2")).toMatchObject({ state: "leased", owner: "t2" });
  });

  it("ignores unreadable markers and markers of another repository, and never reuses their slot numbers", async () => {
    const h = seeded([record("slot-2", { repoKey: "someone-else" })]);
    h.fs.put(markerPath(MARKERS, PLAN, "slot-1"), "{ not json");
    await h.pool.open();
    expect(await h.pool.list()).toEqual([]);
    expect(h.warnings.length).toBeGreaterThanOrEqual(2);
    const lease = await h.pool.acquire(PLAN, "t", C1);
    expect(lease.slot).toBe("slot-3");
  });

  it("an unreadable integration marker blocks that special slot", async () => {
    const h = seeded([]);
    h.fs.put(markerPath(MARKERS, PLAN, "integration"), "{ not json");
    await h.pool.open();
    await expect(h.pool.acquireSpecial(PLAN, "integration")).rejects.toMatchObject({ code: "E_SLOT_UNAVAILABLE" });
    await expect(h.pool.acquireSpecial(PLAN, "ci")).resolves.toMatchObject({ slot: "ci" });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// GC
// ---------------------------------------------------------------------------------------------------------------

describe("SlotPool sidecars, stages and gc locking (QA-2.4-25 to QA-2.4-29)", () => {
  const sidecar = (slot: string, extension: string): string => markerPath(MARKERS, PLAN, slot).replace(/\.json$/, `.${extension}`);

  it("QA-2.4-25: the produced-keep list is written beside the marker, restored by open() and kept by the next reset", async () => {
    const h = harness();
    h.git.preview = () => ["foo.egg-info/"];
    await h.pool.open();
    const lease = await h.pool.acquire(PLAN, "t1", C1);
    expect(JSON.parse(h.fs.text(sidecar(lease.slot, "produced")) ?? "null")).toEqual(["/foo.egg-info"]);
    await h.pool.release(lease.slot);

    const again = harness({ fs: h.fs });
    await again.pool.open();
    await again.pool.acquire(PLAN, "t2", C1);
    expect(again.git.resetKeeps[0]).toContain("/foo.egg-info");
    expect(again.git.previewKeeps[0]).toContain("/foo.egg-info");
  });

  it("QA-2.4-25: a retired slot, and a slot without managers, lose the produced list", async () => {
    const h = harness();
    h.git.preview = () => ["foo.egg-info/"];
    await h.pool.open();
    const lease = await h.pool.acquire(PLAN, "t1", C1);
    await h.pool.release(lease.slot);
    await h.pool.gc(async () => true);
    expect(h.fs.text(sidecar(lease.slot, "produced"))).toBeNull();
    expect(h.fs.text(sidecar(lease.slot, "bins"))).toBeNull();

    const bare = seeded([record("slot-1", { state: "ready", owner: null, managers: [] })], [slotPath("slot-1")]);
    bare.fs.put(sidecar("slot-1", "produced"), JSON.stringify(["/stale"]));
    await bare.pool.open();
    expect(bare.fs.text(sidecar("slot-1", "produced"))).toBeNull();
    await bare.pool.acquire(PLAN, "t2", C1);
    expect(bare.git.resetKeeps[0]).not.toContain("/stale");
  });

  it("QA-2.4-27: the executables found after provisioning are recorded, written beside the marker and restored", async () => {
    const h = harness();
    const original = h.prov.provision.bind(h.prov);
    h.prov.provision = async (slot, detection, o) => {
      await original(slot, detection, o);
      h.fs.put(win32.join(slot, ".venv", "Scripts", "python.exe"), "exe");
    };
    await h.pool.open();
    const lease = await h.pool.acquire(PLAN, "t1", C1);
    const exe = { path: win32.join(lease.path, ".venv", "Scripts", "python.exe"), size: 3, mtimeMs: 0 };
    expect(slotEnvFor(lease.path, "win32")?.bins).toEqual([exe]);
    expect(JSON.parse(h.fs.text(sidecar(lease.slot, "bins")) ?? "null")).toEqual([exe]);
    await h.pool.release(lease.slot);

    unregisterSlot(lease.path);
    const again = harness({ fs: h.fs });
    await again.pool.open();
    expect(slotEnvFor(lease.path, "win32")?.bins).toEqual([exe]);
  });

  it("QA-2.4-27: a slot without a usable .bins file registers no executables and warns", async () => {
    const h = seeded([record("slot-1", { state: "ready", owner: null, managers: ["pip"] })], [slotPath("slot-1")]);
    h.fs.put(sidecar("slot-1", "bins"), "{ not json");
    await h.pool.open();
    expect(slotEnvFor(slotPath("slot-1"), "win32")?.bins).toEqual([]);
    expect(h.warnings.some(w => w.includes(".bins"))).toBe(true);
  });

  it("QA-2.4-31: on win32 only .exe and .com files are recorded", async () => {
    const h = harness();
    const original = h.prov.provision.bind(h.prov);
    h.prov.provision = async (slot, detection, o) => {
      await original(slot, detection, o);
      for (const name of ["python.exe", "tool.com", "pip.cmd", "activate.bat", "Activate.ps1", "exe"]) h.fs.put(win32.join(slot, ".venv", "Scripts", name), "x");
    };
    await h.pool.open();
    const lease = await h.pool.acquire(PLAN, "t1", C1);
    const paths = (slotEnvFor(lease.path, "win32")?.bins ?? []).map(b => win32.basename(b.path)).sort();
    expect(paths).toEqual(["python.exe", "tool.com"]);
  });

  it("QA-2.4-31: on win32 node_modules\\.bin is not recorded, however many shims it holds", async () => {
    const h = harness();
    h.git.files = { "package.json": "{}\n", "package-lock.json": "{}\n" };
    const original = h.prov.provision.bind(h.prov);
    h.prov.provision = async (slot, detection, o) => {
      await original(slot, detection, o);
      for (let n = 0; n < 600; n++) h.fs.put(win32.join(slot, "node_modules", ".bin", `shim-${n}.exe`), "x");
    };
    await h.pool.open();
    const lease = await h.pool.acquire(PLAN, "t1", C1);
    expect(h.prov.calls[0]?.managers).toContain("npm");
    expect(slotEnvFor(lease.path, "win32")?.bins).toEqual([]);
    expect(JSON.parse(h.fs.text(sidecar(lease.slot, "bins")) ?? "null")).toEqual([]);
  });

  it("QA-2.4-31: a large .bins list is not written, the slot still leases and router_run falls back to PATH", async () => {
    const h = harness();
    const original = h.prov.provision.bind(h.prov);
    h.prov.provision = async (slot, detection, o) => {
      await original(slot, detection, o);
      for (let n = 0; n < 600; n++) h.fs.put(win32.join(slot, ".venv", "Scripts", `a-rather-long-tool-name-${String(n).padStart(4, "0")}.exe`), "x");
    };
    await h.pool.open();
    const lease = await h.pool.acquire(PLAN, "t1", C1);
    expect(lease.slot).toBe("slot-1");
    expect(h.fs.text(sidecar(lease.slot, "bins"))).toBeNull();
    expect(slotEnvFor(lease.path, "win32")?.bins).toEqual([]);
    expect(h.warnings.some(w => w.includes(".bins") && w.includes("exceed"))).toBe(true);
    expect(h.marker(lease.slot).state).toBe("leased");
  });

  it("QA-2.4-31: a large produced list is not written but is kept in memory for the next clean", async () => {
    const h = harness();
    h.git.preview = () => Array.from({ length: 600 }, (_, n) => `${"build-output-directory-".padEnd(120, "x")}${String(n).padStart(4, "0")}/`);
    await h.pool.open();
    const lease = await h.pool.acquire(PLAN, "t1", C1);
    expect(h.fs.text(sidecar(lease.slot, "produced"))).toBeNull();
    expect(h.warnings.some(w => w.includes(".produced") && w.includes("exceed"))).toBe(true);
    await h.pool.release(lease.slot);
    await h.pool.acquire(PLAN, "t2", C1);
    expect(h.git.resetKeeps[0]).toContain(`/${"build-output-directory-".padEnd(120, "x")}0599`);
  });

  it("a clean candidate whose parent directory is already gone is skipped by the link sweep (no leftover entries)", async () => {
    const h = harness();
    h.git.preview = () => ["gone/deep/file.txt"];
    await h.pool.open();
    const first = await h.pool.acquire(PLAN, "t1", C1);
    await h.pool.release(first.slot);
    await expect(h.pool.acquire(PLAN, "t2", C1)).resolves.toMatchObject({ slot: first.slot });
  });

  it("a reset to a commit without any manifest drops the install records of the slot", async () => {
    const h = harness();
    await h.pool.open();
    const lease = await h.pool.acquire(PLAN, "t1", C1);
    expect(h.fs.text(sidecar(lease.slot, "bins"))).not.toBeNull();
    h.git.files = { "README.md": "docs\n" };
    await h.pool.reset(lease.slot, C2);
    expect(h.prov.calls).toHaveLength(1);
    expect(h.fs.text(sidecar(lease.slot, "bins"))).toBeNull();
    expect(h.fs.text(sidecar(lease.slot, "produced"))).toBeNull();
    expect(h.marker(lease.slot).managers).toEqual([]);
  });

  it("QA-2.4-28: provisioning and the pool share one sweep cap", () => {
    expect(SLOT_SWEEP_MAX_ENTRIES).toBe(2_000_000);
    expect(PROVISION_SWEEP_MAX_ENTRIES).toBe(SLOT_SWEEP_MAX_ENTRIES);
  });

  it("QA-2.4-26: gc of an unfinished plan does not wait for a slot that is busy", async () => {
    const h = harness();
    let open!: () => void;
    h.prov.gate = new Promise<void>(resolve => { open = resolve; });
    await h.pool.open();
    const acquiring = h.pool.acquire(PLAN, "t1", C1);
    for (let n = 0; n < 200 && h.prov.calls.length === 0; n++) await new Promise<void>(resolve => { setTimeout(resolve, 0); });
    expect(h.prov.calls).toHaveLength(1);
    await expect(h.pool.gc(async () => false)).resolves.toEqual({ removed: [], reported: [] });
    open();
    await expect(acquiring).resolves.toMatchObject({ slot: "slot-1" });
  });
});

describe("SlotPool gc", () => {
  async function leased(h: Harness, owner = "t1"): Promise<string> {
    await h.pool.open();
    const lease = await h.pool.acquire(PLAN, owner, C1);
    await h.pool.release(lease.slot);
    return lease.path;
  }

  it("removes the slots of a finished plan: directory, worktree entry, marker and marker directory", async () => {
    const h = harness();
    const path = await leased(h);
    const out = await h.pool.gc(async () => true);
    expect(out).toEqual({ removed: [path], reported: [] });
    expect(await h.fs.lstat(path)).toBeNull();
    expect(h.git.log).toContain(`remove ${key(path)}`);
    expect(await h.fs.lstat(markerPath(MARKERS, PLAN, "slot-1"))).toBeNull();
    expect(await h.fs.lstat(win32.join(MARKERS, PLAN))).toBeNull();
    expect(await h.fs.lstat(SLOTS)).not.toBeNull();
    expect(await h.pool.get("slot-1")).toBeNull();
    expect(slotEnvFor(path, "win32")).toBeNull();
  });

  it("keeps the slots of a plan that is still running", async () => {
    const h = harness();
    const path = await leased(h);
    expect(await h.pool.gc(async () => false)).toEqual({ removed: [], reported: [] });
    expect(await h.fs.lstat(path)).not.toBeNull();
  });

  it("an unknown plan is collected only after seven days", async () => {
    const h = harness();
    const path = await leased(h);
    h.clock.tick(UNKNOWN_PLAN_GC_AGE_MS - 1);
    expect((await h.pool.gc(async () => null)).removed).toEqual([]);
    h.clock.tick(1);
    expect((await h.pool.gc(async () => null)).removed).toEqual([path]);
  });

  it("reports a plan whose state cannot be determined and leaves it alone", async () => {
    const h = harness();
    const path = await leased(h);
    const out = await h.pool.gc(async () => { throw new Error("plan store unreadable"); });
    expect(out.removed).toEqual([]);
    expect(out.reported).toEqual([expect.stringContaining("plan store unreadable")]);
    expect(await h.fs.lstat(path)).not.toBeNull();
  });

  it("reports unmarked entries and never touches them", async () => {
    const h = harness();
    await leased(h);
    h.fs.dir(win32.join(SLOTS, "stray"));
    h.fs.put(win32.join(SLOTS, "stray", "keep.txt"), "x");
    h.fs.put(win32.join(SLOTS, "notes.txt"), "x");
    const out = await h.pool.gc(async () => true);
    expect(out.removed).toHaveLength(1);
    expect([...out.reported].sort()).toEqual([`${win32.join(SLOTS, "notes.txt")}: unmarked`, `${win32.join(SLOTS, "stray")}: unmarked`]);
    expect(h.fs.text(win32.join(SLOTS, "stray", "keep.txt"))).toBe("x");
    expect(h.fs.removed.every(r => !key(r.path).includes("stray") && !key(r.path).includes("notes"))).toBe(true);
  });

  it("also collects the markers of other plans of the same repository, and skips other repositories", async () => {
    const h = harness();
    await leased(h);
    const other = "p-20261010-other1";
    // That plan's default slots directory (<repo drive>:\.omr-slots\<planId>), which GC trusts for its markers.
    const dir = defaultSlotsDir(TOP, other);
    const mine = record("slot-1", { planId: other, path: slotPath("slot-1", dir), state: "ready", owner: null });
    const foreign = record("slot-2", { planId: other, path: slotPath("slot-2", dir), repoKey: "other-repo" });
    h.fs.put(markerPath(MARKERS, other, "slot-1"), JSON.stringify(mine));
    h.fs.put(markerPath(MARKERS, other, "slot-2"), JSON.stringify(foreign));
    h.fs.dir(dir);
    h.fs.dir(slotPath("slot-1", dir));
    h.fs.dir(slotPath("slot-2", dir));
    h.git.worktrees.set(key(slotPath("slot-1", dir)), slotLockReason(other, "slot-1"));
    const out = await h.pool.gc(async (planId) => planId === other);
    expect(out.removed).toEqual([slotPath("slot-1", dir)]);
    expect(await h.fs.lstat(slotPath("slot-2", dir))).not.toBeNull();
    expect(await h.fs.lstat(markerPath(MARKERS, other, "slot-2"))).not.toBeNull();
  });

  it("reports invalid markers: broken JSON and a record in the wrong file", async () => {
    const h = harness();
    await h.pool.open();
    h.fs.put(markerPath(MARKERS, PLAN, "slot-4"), "{ not json");
    h.fs.put(markerPath(MARKERS, PLAN, "slot-5"), JSON.stringify(record("slot-6", { path: slotPath("slot-6") })));
    const out = await h.pool.gc(async () => true);
    expect(out.removed).toEqual([]);
    expect(out.reported).toHaveLength(2);
    expect(out.reported.join("\n")).toContain("not valid JSON");
    expect(out.reported.join("\n")).toContain("does not match");
  });

  describe("forged markers", () => {
    const gcWith = async (rec: SlotRecord, setup: (fs: MemFs, git: FakeGit) => void) => {
      const h = harness();
      await h.pool.open();
      h.fs.put(markerPath(MARKERS, PLAN, rec.slot), JSON.stringify(rec));
      setup(h.fs, h.git);
      const out = await h.pool.gc(async () => true);
      return { h, out };
    };
    const precious = (fs: MemFs, dir: string): void => {
      fs.dir(dir);
      fs.put(win32.join(dir, "gold.txt"), "keep");
    };

    /** gcSlots on its own, with `slotsDir` as the one trusted parent (so the later guards are reached). */
    const gcStandalone = async (rec: SlotRecord, slotsDir: string, setup: (fs: MemFs) => void) => {
      const h = harness();
      h.fs.put(markerPath(MARKERS, PLAN, rec.slot), JSON.stringify(rec));
      setup(h.fs);
      const out = await gcSlots(
        { repoKey: "repo-key", toplevel: TOP, slotsDir, markersDir: MARKERS, executorHome: HOME, git: h.git, fs: h.fs, clock: h.clock, platform: "win32" },
        async () => true,
      );
      return { h, out };
    };

    it("refuses a path whose basename is not the slot name", async () => {
      const other = `${SLOTS}\\slot-8`;
      const { h, out } = await gcWith(record("slot-9", { path: other, state: "ready", owner: null }), fs => precious(fs, other));
      expect(out.removed).toEqual([]);
      expect(out.reported[0]).toMatch(/slot-9\.json: refusing slot dir .*name differs from the slot/);
      expect(h.fs.text(`${other}\\gold.txt`)).toBe("keep");
      const { h: h2, out: out2 } = await gcWith(record("slot-9", { path: "D:\\Windows", state: "ready", owner: null }), fs => precious(fs, "D:\\Windows"));
      expect(out2.removed).toEqual([]);
      expect(out2.reported[0]).toMatch(/slot-9\.json: (refusing slot dir|parent is not a known slots directory)/);
      expect(h2.fs.text("D:\\Windows\\gold.txt")).toBe("keep");
    });

    it("refuses a slot directly under a drive root (slotsDir is a drive root)", async () => {
      const { h, out } = await gcStandalone(record("slot-9", { path: "D:\\slot-9", state: "ready", owner: null }), "D:\\", fs => precious(fs, "D:\\slot-9"));
      expect(out.removed).toEqual([]);
      expect(out.reported[0]).toContain("filesystem root");
      expect(h.fs.text("D:\\slot-9\\gold.txt")).toBe("keep");
      const viaPool = await gcWith(record("slot-9", { path: "D:\\slot-9", state: "ready", owner: null }), fs => precious(fs, "D:\\slot-9"));
      expect(viaPool.out.removed).toEqual([]);
      expect(viaPool.h.fs.text("D:\\slot-9\\gold.txt")).toBe("keep");
    });

    it("refuses a path inside the repository", async () => {
      const dir = "D:\\repo\\main\\slots";
      const inside = `${dir}\\slot-9`;
      const { h, out } = await gcStandalone(record("slot-9", { path: inside, state: "ready", owner: null }), dir, fs => precious(fs, inside));
      expect(out.removed).toEqual([]);
      expect(out.reported[0]).toContain("inside the repository");
      expect(h.fs.text(`${inside}\\gold.txt`)).toBe("keep");
    });

    it("refuses a relative path and a path with a dot segment", async () => {
      for (const path of ["slot-9", `${SLOTS}\\..\\${PLAN}\\slot-9`]) {
        const { out } = await gcWith(record("slot-9", { path, state: "ready", owner: null }), () => undefined);
        expect(out.removed).toEqual([]);
        expect(out.reported[0]).toMatch(/slot-9\.json: (refusing slot dir|parent is not a known slots directory)/);
      }
      const { out } = await gcStandalone(record("slot-9", { path: `${SLOTS}\\.\\slot-9`, state: "ready", owner: null }), SLOTS, () => undefined);
      expect(out.removed).toEqual([]);
      expect(out.reported[0]).toMatch(/refusing slot dir|not a known slots directory/);
    });

    it("refuses a slot directory that is a junction and leaves its target alone", async () => {
      const { h, out } = await gcWith(record("slot-9", { path: slotPath("slot-9"), state: "ready", owner: null }), (fs) => {
        precious(fs, "D:\\precious");
        fs.nodes.set(key(slotPath("slot-9")), "junction");
        fs.targets.set(key(slotPath("slot-9")), "D:\\precious");
      });
      expect(out.removed).toEqual([]);
      expect(out.reported[0]).toContain("not a real directory (junction)");
      expect(h.fs.text("D:\\precious\\gold.txt")).toBe("keep");
      expect(h.fs.removed.some(r => key(r.path) === key(slotPath("slot-9")))).toBe(false);
      expect(h.marker("slot-9").state).toBe("retired");
    });

    // Regression: gc validated a marker's path against the marker's own parent, so a forged marker outside slotsDir passed.
    it("a marker naming a directory outside the pool's slotsDir is not deleted (memo 9.2: 'path outside slotsDir')", async () => {
      const outside = "E:\\other\\slot-9";
      const { h, out } = await gcWith(record("slot-9", { path: outside, state: "ready", owner: null }), (fs, git) => {
        precious(fs, outside);
        git.badPointers.add(key(outside));
      });
      expect(out.removed).toEqual([]);
      expect(h.fs.text(`${outside}\\gold.txt`)).toBe("keep");
    });
  });

  it("unlinks a junction inside a slot without walking it", async () => {
    const h = harness();
    const path = await leased(h);
    h.fs.dir("D:\\precious");
    h.fs.put("D:\\precious\\gold.txt", "keep");
    h.fs.dir(win32.join(path, "sub"));
    h.fs.nodes.set(key(win32.join(path, "sub", "link")), "junction");
    h.fs.nodes.set(key(win32.join(path, "symlink")), "symlink");
    h.fs.targets.set(key(win32.join(path, "sub", "link")), "D:\\precious");
    h.fs.targets.set(key(win32.join(path, "symlink")), "D:\\precious");
    const out = await h.pool.gc(async () => true);
    expect(out.removed).toEqual([path]);
    expect(h.fs.text("D:\\precious\\gold.txt")).toBe("keep");
    expect(h.fs.removed).toContainEqual({ path: win32.join(path, "sub", "link"), recursive: false });
    expect(h.fs.removed).toContainEqual({ path: win32.join(path, "symlink"), recursive: false });
    expect(h.fs.removed.some(r => key(r.path).startsWith("d:/precious"))).toBe(false);
  });

  it("a directory that resolves outside its slot stops the sweep and the delete", async () => {
    const h = harness();
    const path = await leased(h);
    h.fs.dir(win32.join(path, "sub"));
    h.fs.dir("D:\\precious");
    h.fs.put("D:\\precious\\gold.txt", "keep");
    h.fs.targets.set(key(win32.join(path, "sub")), "D:\\precious");
    const out = await h.pool.gc(async () => true);
    expect(out.removed).toEqual([]);
    expect(out.reported[0]).toContain("resolves outside its slot");
    expect(h.fs.text("D:\\precious\\gold.txt")).toBe("keep");
    expect(await h.fs.lstat(path)).not.toBeNull();
  });

  it("EBUSY on the slot directory is retried with backoff and then the slot stays retired", async () => {
    const h = harness();
    const path = await leased(h);
    h.fs.rmFailures.set(key(path), { code: "EBUSY", times: Number.POSITIVE_INFINITY });
    h.clock.slept.length = 0;
    const out = await h.pool.gc(async () => true);
    expect(out.removed).toEqual([]);
    expect(out.reported[0]).toContain("EBUSY");
    expect(h.clock.slept.length).toBeGreaterThanOrEqual(3);
    expect(h.clock.slept.slice(0, 3)).toEqual([...h.clock.slept.slice(0, 3)].sort((a, b) => a - b));
    expect(new Set(h.clock.slept).size).toBe(h.clock.slept.length);
    expect(h.marker("slot-1").state).toBe("retired");
    expect(h.git.log).not.toContain(`remove ${key(path)}`);
    h.fs.rmFailures.clear();
    const again = await h.pool.gc(async () => true);
    expect(again.removed).toEqual([path]);
    expect(await h.fs.lstat(markerPath(MARKERS, PLAN, "slot-1"))).toBeNull();
  });

  // Regression: gc only unregistered the slot environment when the marker was missing, not when left `retired` (memo section 6).
  it("a slot left `retired` by a failed gc is no longer registered for slotEnvFor", async () => {
    const h = harness();
    const path = await leased(h);
    h.fs.rmFailures.set(key(path), { code: "EBUSY", times: Number.POSITIVE_INFINITY });
    await h.pool.gc(async () => true);
    expect(h.marker("slot-1").state).toBe("retired");
    expect(slotEnvFor(path, "win32")).toBeNull();
  });

  it("a directory that is still there after rm leaves the marker retired", async () => {
    const h = harness();
    const path = await leased(h);
    const realRm = h.fs.rm;
    h.fs.rm = async (p, o) => { if (key(p) === key(path)) return; await realRm(p, o); };
    const out = await h.pool.gc(async () => true);
    expect(out.removed).toEqual([]);
    expect(out.reported[0]).toContain("still present after removal");
    expect(h.marker("slot-1").state).toBe("retired");
  });

  // QA-2.4-3: the entry is dropped by path + lock reason even when the pointers were invalid.
  it("invalid git pointers: the directory is removed, the worktree entry is dropped by path and lock reason, and it is reported", async () => {
    const h = harness();
    const path = await leased(h);
    h.git.badPointers.add(key(path));
    const out = await h.pool.gc(async () => true);
    expect(out.removed).toEqual([path]);
    expect(out.reported[0]).toContain("git pointers were invalid");
    expect(h.git.log).toContain(`remove ${key(path)}`);
    expect(h.git.worktrees.size).toBe(0);
    expect(await h.fs.lstat(path)).toBeNull();
  });

  // QA-2.4-3
  it("deletes nothing when git does not list the folder locked with this slot's reason", async () => {
    const h = harness();
    const path = await leased(h);
    h.fs.put(win32.join(path, "gold.txt"), "keep");
    h.git.worktrees.set(key(path), "somebody else's lock");
    const unlisted = await h.pool.gc(async () => true);
    expect(unlisted.removed).toEqual([]);
    expect(unlisted.reported[0]).toContain("nothing was deleted");
    h.git.worktrees.delete(key(path));
    const none = await h.pool.gc(async () => true);
    expect(none.removed).toEqual([]);
    expect(none.reported[0]).toContain("nothing was deleted");
    expect(h.fs.text(win32.join(path, "gold.txt"))).toBe("keep");
    expect(h.marker("slot-1").state).toBe("retired");
  });

  // QA-2.4-3
  it("requires the trusted slots folder to be the real one", async () => {
    const h = harness();
    const path = await leased(h);
    h.fs.targets.set(key(SLOTS), "D:\\elsewhere");
    const out = await h.pool.gc(async () => true);
    expect(out.removed).toEqual([]);
    expect(out.reported[0]).toContain("resolves through a link");
    expect(await h.fs.lstat(path)).not.toBeNull();
  });

  // QA-2.4-3
  it("removes a link planted at the slot's .git during the sweep", async () => {
    const h = harness();
    const path = await leased(h);
    h.fs.nodes.set(key(win32.join(path, ".git")), "junction");
    h.fs.targets.set(key(win32.join(path, ".git")), "D:\\precious");
    const out = await h.pool.gc(async () => true);
    expect(out.removed).toEqual([path]);
    expect(h.fs.removed).toContainEqual({ path: win32.join(path, ".git"), recursive: false });
  });

  // QA-2.4-3
  it("still drops the worktree entry, keyed by path and lock reason, once the folder is already gone", async () => {
    const h = harness();
    const path = await leased(h);
    await h.fs.rm(path, { recursive: true });
    const out = await h.pool.gc(async () => true);
    expect(out.removed).toEqual([path]);
    expect(h.git.log).toContain(`remove ${key(path)}`);
    expect(h.git.worktrees.size).toBe(0);
  });

  it("a gc deadline in the past collects nothing", async () => {
    const h = harness();
    const path = await leased(h);
    const out = await gcSlots(
      { repoKey: "repo-key", toplevel: TOP, slotsDir: SLOTS, markersDir: MARKERS, executorHome: HOME, git: h.git, fs: h.fs, clock: h.clock, platform: "win32" },
      async () => true, { deadline: h.clock.now() - 1 },
    );
    expect(out.removed).toEqual([]);
    expect(out.reported[0]).toContain("gc deadline reached");
    expect(await h.fs.lstat(path)).not.toBeNull();
  });

  it("works standalone, without an open pool", async () => {
    const h = harness();
    const path = await leased(h);
    const out = await gcSlots(
      { repoKey: "repo-key", toplevel: TOP, slotsDir: SLOTS, markersDir: MARKERS, executorHome: HOME, git: h.git, fs: h.fs, clock: h.clock, platform: "win32" },
      async () => true,
    );
    expect(out.removed).toEqual([path]);
  });

  it("still collects from the explicit slotsDir when the repository has no drive-letter default", async () => {
    const h = harness();
    const path = await leased(h);
    const out = await gcSlots(
      { repoKey: "repo-key", toplevel: "\\\\server\\share\\repo", slotsDir: SLOTS, markersDir: MARKERS, executorHome: HOME, git: h.git, fs: h.fs, clock: h.clock, platform: "win32" },
      async () => true,
    );
    expect(out.removed).toEqual([path]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------------------------
// Phase 2.4 QA round 1, batch A
// ---------------------------------------------------------------------------------------------------------------

describe("SlotPool QA round 1 (git.ts / pool.ts)", () => {
  const settle = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

  // QA-2.4-1
  it("sweeps exactly the paths git clean lists, whatever their depth or name: a nested node_modules junction goes", async () => {
    const h = harness();
    await h.pool.open();
    const lease = await h.pool.acquire(PLAN, "t1", C1);
    h.fs.dir("D:\\precious");
    h.fs.put("D:\\precious\\keep.txt", "keep");
    h.fs.dir(win32.join(lease.path, "tools"));
    h.fs.dir(win32.join(lease.path, "tools", "node_modules"));
    h.fs.nodes.set(key(win32.join(lease.path, "tools", "node_modules", "x")), "junction");
    h.fs.targets.set(key(win32.join(lease.path, "tools", "node_modules", "x")), "D:\\precious");
    h.fs.dir(win32.join(lease.path, "pkg"));
    h.fs.nodes.set(key(win32.join(lease.path, "pkg", "node_modules")), "junction");
    h.fs.targets.set(key(win32.join(lease.path, "pkg", "node_modules")), "D:\\precious");
    h.git.preview = () => ["tools/node_modules/", "pkg/node_modules/"];
    await h.pool.cleanForChecks(lease.slot);
    expect(h.fs.removed).toContainEqual({ path: win32.join(lease.path, "tools", "node_modules", "x"), recursive: false });
    expect(h.fs.removed).toContainEqual({ path: win32.join(lease.path, "pkg", "node_modules"), recursive: false });
    expect(h.fs.removed.some((r) => key(r.path).startsWith("d:/precious"))).toBe(false);
    expect(h.fs.text("D:\\precious\\keep.txt")).toBe("keep");
    expect(h.git.log).toContain(`cleanForChecks ${key(lease.path)}`);
  });

  // QA-2.4-1
  it("a reset sweeps what the reset clean lists before cleaning", async () => {
    const h = harness();
    await h.pool.open();
    const lease = await h.pool.acquire(PLAN, "t1", C1);
    h.fs.dir("D:\\precious");
    h.fs.dir(win32.join(lease.path, "tools"));
    h.fs.dir(win32.join(lease.path, "tools", "node_modules"));
    h.fs.nodes.set(key(win32.join(lease.path, "tools", "node_modules", "x")), "junction");
    h.fs.targets.set(key(win32.join(lease.path, "tools", "node_modules", "x")), "D:\\precious");
    h.git.preview = () => ["tools/node_modules/"];
    await h.pool.reset(lease.slot, C2);
    expect(h.fs.removed).toContainEqual({ path: win32.join(lease.path, "tools", "node_modules", "x"), recursive: false });
    expect(h.git.log.indexOf(`clean ${key(lease.path)}`)).toBeGreaterThan(h.git.log.indexOf(`checkout ${key(lease.path)} 22`));
  });

  it("a tracked link that the clean lists is left alone, an untracked one is removed", async () => {
    const h = harness();
    await h.pool.open();
    const lease = await h.pool.acquire(PLAN, "t1", C1);
    h.fs.dir("D:\\precious");
    for (const name of ["tracked-link", "stray-link"]) {
      h.fs.nodes.set(key(win32.join(lease.path, name)), "junction");
      h.fs.targets.set(key(win32.join(lease.path, name)), "D:\\precious");
    }
    h.git.links = ["tracked-link"];
    h.git.preview = () => ["tracked-link", "stray-link"];
    await h.pool.cleanForChecks(lease.slot);
    expect(h.fs.removed).toContainEqual({ path: win32.join(lease.path, "stray-link"), recursive: false });
    expect(h.fs.removed).not.toContainEqual({ path: win32.join(lease.path, "tracked-link"), recursive: false });
  });

  // QA-2.4-2
  it("refuses a slot that resolves through a link before any sweep or clean", async () => {
    const h = harness();
    await h.pool.open();
    const lease = await h.pool.acquire(PLAN, "t1", C1);
    h.fs.targets.set(key(lease.path), "D:\\elsewhere");
    await expect(h.pool.cleanForChecks(lease.slot)).rejects.toMatchObject({ code: "E_SLOT_BROKEN", message: expect.stringContaining("resolves through a link") });
    expect(h.git.log.some((l) => l.startsWith("cleanForChecks"))).toBe(false);
  });

  // QA-2.4-14
  it("keeps what provisioning produced (egg-info) in cleanForChecks and in a reset clean", async () => {
    const h = harness();
    h.git.preview = () => ["foo.egg-info/", "odd[1]/"];
    await h.pool.open();
    const lease = await h.pool.acquire(PLAN, "t1", C1);
    const expected = ["/.venv", "/foo.egg-info", "/odd\\[1\\]"];
    await h.pool.cleanForChecks(lease.slot);
    expect(h.git.cleanKeeps.at(-1)).toEqual(expected);
    await h.pool.release(lease.slot);
    await h.pool.acquire(PLAN, "t2", C2);
    expect(h.git.resetKeeps.at(-1)).toEqual(expected);
  });

  // QA-2.4-7
  it("a gc that collects this plan closes the pool and aborts provisioning in flight", async () => {
    const h = harness();
    await h.pool.open();
    let open: () => void = () => undefined;
    h.prov.gate = new Promise<void>((resolve) => { open = resolve; });
    const acquiring = h.pool.acquire(PLAN, "t1", C1).then(() => null, (error: unknown) => error);
    for (let n = 0; n < 50 && h.prov.calls.length === 0; n++) await settle();
    expect(h.prov.calls).toHaveLength(1);
    const signal = h.prov.signals[0];
    expect(signal?.aborted).toBe(false);
    const collecting = h.pool.gc(async () => true);
    await settle();
    expect(signal?.aborted).toBe(true);
    await expect(h.pool.acquire(PLAN, "t2", C1)).rejects.toMatchObject({ code: "E_PLAN_STATE" });
    h.prov.error = new Error("provisioning of slot-1 was aborted");
    open();
    expect(await acquiring).not.toBeNull();
    const out = await collecting;
    expect(out.removed).toEqual([slotPath("slot-1")]);
  });

  // QA-2.4-7
  it("a gc of an unfinished plan neither closes the pool nor aborts anything", async () => {
    const h = harness();
    await h.pool.open();
    await h.pool.acquire(PLAN, "t1", C1);
    await h.pool.gc(async () => false);
    expect(h.prov.signals[0]?.aborted).toBe(false);
    await expect(h.pool.acquire(PLAN, "t2", C2)).resolves.toMatchObject({ slot: "slot-2" });
  });

  // QA-2.4-21
  it("blames a running process only for transient filesystem codes", async () => {
    const h = harness();
    await h.pool.open();
    await h.pool.acquire(PLAN, "task-1", C1);
    h.git.fail.set("checkoutDetach", { error: new Error("boom"), times: 2 });
    const error: unknown = await h.pool.reset("slot-1", C3).then(() => null, (e: unknown) => e);
    expect(error).toMatchObject({ code: "E_SLOT_BROKEN" });
    expect(String((error as Error).message)).toContain("reset of slot-1 failed: boom");
    expect(String((error as Error).message)).not.toContain("held by a running process");
  });
});

describe("slot name, marker path, lock reason and safe dir", () => {
  it.each(["slot-1", "slot-12", "slot-999", "integration", "ci"])("accepts %s", name => { expect(SLOT_NAME_PATTERN.test(name)).toBe(true); });
  it.each(["slot-0", "slot-01", "slot-1000", "SLOT-1", "slot-1/..", "slot-", "ci2", "", "integration "])("rejects %j", name => { expect(SLOT_NAME_PATTERN.test(name)).toBe(false); });

  it("builds marker paths and rejects bad ids", () => {
    expect(markerPath("D:\\m", PLAN, "slot-1")).toBe(`D:\\m\\${PLAN}\\slot-1.json`);
    expect(() => markerPath("D:\\m", "../x", "slot-1")).toThrow(ExecutorError);
    expect(() => markerPath("D:\\m", PLAN, "../slot-1")).toThrow(ExecutorError);
  });

  it("lock reasons are printable ASCII without quotes or backslashes", () => {
    const reason = slotLockReason(PLAN, "slot-1");
    expect(reason).toMatch(/^[\x20\x21\x23-\x5b\x5d-\x7e]{1,200}$/);
    expect(reason).toContain(`${PLAN}/slot-1`);
  });

  it("assertSafeSlotDir accepts a direct child of slotsDir only", () => {
    expect(() => assertSafeSlotDir(`${SLOTS}\\slot-1`, "slot-1", SLOTS, "win32")).not.toThrow();
    expect(() => assertSafeSlotDir(`${SLOTS.toUpperCase()}\\slot-1`, "slot-1", SLOTS, "win32")).not.toThrow();
    const bad: Array<[string, string, string]> = [
      [`${SLOTS}\\slot-2`, "slot-1", SLOTS], [`${SLOTS}\\sub\\slot-1`, "slot-1", SLOTS], [`D:\\other\\slot-1`, "slot-1", SLOTS],
      [`${SLOTS}\\..\\slot-1`, "slot-1", SLOTS], ["slot-1", "slot-1", SLOTS], [`${SLOTS}\\slot-1`, "slot-1", "D:\\"],
      [`D:\\slot-1`, "slot-1", "D:\\"], [`${SLOTS}\\slot-1`, "../slot-1", SLOTS], [`${SLOTS}\\slot-1`, "slot-1", "relative"],
      ["", "slot-1", SLOTS], [`${SLOTS}\\slot-1\\.`, "slot-1", SLOTS],
    ];
    for (const [path, slot, dir] of bad) expect(() => assertSafeSlotDir(path, slot, dir, "win32"), `${path} | ${slot} | ${dir}`).toThrow(ExecutorError);
  });

  it("assertSafeSlotDir works for POSIX paths too", () => {
    expect(() => assertSafeSlotDir("/var/slots/slot-1", "slot-1", "/var/slots", "linux")).not.toThrow();
    expect(() => assertSafeSlotDir("/slot-1", "slot-1", "/", "linux")).toThrow(/filesystem root/);
    expect(() => assertSafeSlotDir("/var/Slots/slot-1", "slot-1", "/var/slots", "linux")).toThrow(/parent is not slotsDir/);
  });

  it("isSlotRecord accepts a record and rejects every malformed field", () => {
    const good = record("slot-1", { managers: ["pip"], manifests: { "requirements.txt": "a".repeat(64) } });
    expect(isSlotRecord(good)).toBe(true);
    expect(isSlotRecord(record("integration", { owner: null, commit: null }))).toBe(true);
    const mutations: Array<Record<string, unknown>> = [
      { schema: 2 }, { slot: "slot-0" }, { slot: "ci" }, { path: "" }, { path: 5 }, { kind: "ci" }, { planId: "Bad" }, { repoKey: "" },
      { state: "dead" }, { owner: "tab\t" }, { owner: 5 }, { commit: "abc" }, { managers: "pip" }, { managers: [""] },
      { manifests: { a: "short" } }, { manifests: [] }, { createdAt: 1 }, { updatedAt: "x".repeat(41) },
    ];
    for (const m of mutations) expect(isSlotRecord({ ...good, ...m }), JSON.stringify(m)).toBe(false);
    for (const v of [null, "x", [], 5]) expect(isSlotRecord(v)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// slotEnvFor, applySlotEnv and the verify/exec merge (real directories, real child processes)
// ---------------------------------------------------------------------------------------------------------------

describe("SlotPool check-cleanup failures", () => {
  it.each([
    ["git clean", "cleanForChecks", new ExecutorError("E_GIT", "clean failed", { op: "clean", code: 1, stderr: "" })],
    ["pointer verification", "verifySlotPointers", new ExecutorError("E_SLOT_BROKEN", "slot .git is missing", {})],
  ] as Array<[string, string, ExecutorError]>)("a failing %s is reported as E_SLOT_BROKEN and leaves the leased slot with its owner", async (_name, op, error) => {
    const h = harness();
    await h.pool.open();
    await h.pool.acquire(PLAN, "task-1", C1);
    h.git.fail.set(op, { error, times: 1 });
    await expect(h.pool.cleanForChecks("slot-1")).rejects.toMatchObject({ code: "E_SLOT_BROKEN" });
    // Only the stage states (creating, provisioning, resetting) break a slot; a lease stays with its owner.
    expect(h.marker("slot-1")).toMatchObject({ state: "leased", owner: "task-1" });
    expect(slotEnvFor(slotPath("slot-1"), "win32")).not.toBeNull();
    await h.pool.cleanForChecks("slot-1");
    // The failed attempt never reached the git clean log line (it threw first); the retry did.
    expect(h.git.log.filter(l => l.startsWith("cleanForChecks"))).toHaveLength(1);
  });

  it("keeps the original error message of a non-ExecutorError failure in the wrapped error", async () => {
    const h = harness();
    await h.pool.open();
    await h.pool.acquire(PLAN, "task-1", C1);
    h.git.fail.set("cleanForChecks", { error: Object.assign(new Error("disk on fire"), { code: "EIO" }), times: 1 });
    await expect(h.pool.cleanForChecks("slot-1")).rejects.toMatchObject({
      code: "E_SLOT_BROKEN", message: expect.stringContaining("slot slot-1: disk on fire"),
    });
  });
});

describe("slot environment", () => {
  const WIN = process.platform === "win32";
  const P = process.platform;
  let base = "";
  let slotA = "";
  let slotB = "";
  let outside = "";
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "omr-slotenv-"));
    slotA = join(base, "slot-1");
    slotB = join(base, "slot-10");
    outside = join(base, "outside");
    mkdirSync(join(slotA, "sub", "deep"), { recursive: true });
    mkdirSync(slotB);
    mkdirSync(outside);
    for (const name of ["PYTHONPATH", "PYTHONHOME", "NODE_PATH", "UV_PROJECT_ENVIRONMENT"]) saved[name] = process.env[name];
  });
  afterAll(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(base, { recursive: true, force: true });
  });

  const real = (p: string): string => realpathSync.native(p);

  it("is inert while no slot is registered", () => {
    expect(slotEnvFor(slotA, P)).toBeNull();
    const env = { PATH: "x", PYTHONPATH: "y" };
    expect(applySlotEnv(env, null, P)).toBe(env);
  });

  it("applies inside a registered slot, in nested paths, and not outside or in a sibling with the same prefix", () => {
    registerSlot({ root: slotA, managers: ["pip", "pnpm"] });
    const venv = join(real(slotA), ".venv");
    const env = slotEnvFor(slotA, P);
    expect(env?.root).toBe(real(slotA));
    expect(env?.set).toEqual({ VIRTUAL_ENV: venv });
    expect(env?.prependPath).toEqual([join(venv, WIN ? "Scripts" : "bin"), join(real(slotA), "node_modules", ".bin")]);
    expect(slotEnvFor(join(slotA, "sub", "deep"), P)?.root).toBe(real(slotA));
    expect(slotEnvFor(join(slotA, "sub", "deep", "missing"), P)).toBeNull();
    expect(slotEnvFor(slotB, P)).toBeNull();
    expect(slotEnvFor(outside, P)).toBeNull();
    expect(slotEnvFor(base, P)).toBeNull();
  });

  it.skipIf(!WIN)("matches paths that differ only in case or separators on Windows", () => {
    registerSlot({ root: slotA, managers: ["pip"] });
    expect(slotEnvFor(slotA.toUpperCase(), "win32")).not.toBeNull();
    expect(slotEnvFor(join(slotA, "sub").toLowerCase().replace(/\\/g, "/"), "win32")).not.toBeNull();
    expect(slotEnvFor(slotB.toUpperCase(), "win32")).toBeNull();
  });

  it("gives each slot its own environment and forgets an unregistered one", () => {
    registerSlot({ root: slotA, managers: ["pip"] });
    registerSlot({ root: slotB, managers: ["npm"] });
    const a = slotEnvFor(slotA, P);
    const b = slotEnvFor(slotB, P);
    expect(a?.set["VIRTUAL_ENV"]).toBeDefined();
    expect(b?.set).toEqual({});
    expect(b?.prependPath).toEqual([join(real(slotB), "node_modules", ".bin")]);
    expect(JSON.stringify(a)).not.toContain("slot-10");
    expect(JSON.stringify(b)).not.toContain(join(real(slotA), ".venv"));
    registerSlot({ root: slotA, managers: [] });
    expect(slotEnvFor(slotA, P)).toMatchObject({ set: {}, prependPath: [] });
    unregisterSlot(slotA);
    expect(slotEnvFor(slotA, P)).toBeNull();
    expect(slotEnvFor(slotB, P)).not.toBeNull();
  });

  it("removes PYTHONPATH, PYTHONHOME, NODE_PATH and UV_PROJECT_ENVIRONMENT and puts the slot first on PATH", () => {
    registerSlot({ root: slotA, managers: ["uv", "yarn"] });
    const s = slotEnvFor(slotA, P);
    const out = applySlotEnv(
      { PATH: "C:\\tools", PYTHONPATH: "p", PYTHONHOME: "h", NODE_PATH: "n", UV_PROJECT_ENVIRONMENT: "u", VIRTUAL_ENV: "old", KEEP: "1" },
      s, P,
    );
    const sep = WIN ? ";" : ":";
    expect(out["PYTHONPATH"]).toBeUndefined();
    expect(out["PYTHONHOME"]).toBeUndefined();
    expect(out["NODE_PATH"]).toBeUndefined();
    expect(out["UV_PROJECT_ENVIRONMENT"]).toBeUndefined();
    expect(out["KEEP"]).toBe("1");
    expect(out["VIRTUAL_ENV"]).toBe(join(real(slotA), ".venv"));
    expect((out["PATH"] ?? "").split(sep)[0]).toContain(".venv");
    expect((out["PATH"] ?? "").endsWith(`${sep}C:\\tools`)).toBe(true);
  });

  it("is case-insensitive for names on Windows only, and keeps the existing PATH key", () => {
    registerSlot({ root: slotA, managers: ["pip"] });
    const s = slotEnvFor(slotA, P);
    const win = applySlotEnv({ Path: "C:\\tools", pythonpath: "p", Virtual_Env: "old" }, s, "win32");
    expect(Object.keys(win).sort()).toEqual(["Path", "VIRTUAL_ENV"]);
    expect(win["Path"]?.endsWith(";C:\\tools")).toBe(true);
    const posix = applySlotEnv({ PATH: "/bin", pythonpath: "p", PYTHONPATH: "q" }, s, "linux");
    expect(posix["pythonpath"]).toBe("p");
    expect(posix["PYTHONPATH"]).toBeUndefined();
    const dup = applySlotEnv({ Path: "C:\\a", PATH: "C:\\a" }, s, "win32");
    expect(Object.keys(dup).filter(k => k.toLowerCase() === "path")).toHaveLength(1);
    const none = applySlotEnv({}, s, "win32");
    expect(none["PATH"]).toBe(s?.prependPath.join(";"));
  });

  it("never mutates the environment it is given", () => {
    registerSlot({ root: slotA, managers: ["pip"] });
    const env = { PATH: "x", PYTHONPATH: "y" };
    const out = applySlotEnv(env, slotEnvFor(slotA, P), P);
    expect(out).not.toBe(env);
    expect(env).toEqual({ PATH: "x", PYTHONPATH: "y" });
  });

  const probe = "console.log(JSON.stringify({ py: process.env.PYTHONPATH ?? null, home: process.env.PYTHONHOME ?? null, venv: process.env.VIRTUAL_ENV ?? null, path: process.env.PATH ?? process.env.Path ?? '' }))";

  async function child(cwd: string, env?: Record<string, string>): Promise<{ py: string | null; home: string | null; venv: string | null; path: string }> {
    const r = await runArgv(process.execPath, ["-e", probe], { cwd, timeoutMs: 30_000, ...(env === undefined ? {} : { env }) });
    expect(r.code, r.stderr).toBe(0);
    return JSON.parse(r.stdout) as { py: string | null; home: string | null; venv: string | null; path: string };
  }

  it("verify/exec runs a child in a slot with the slot environment, and unchanged outside", async () => {
    process.env["PYTHONPATH"] = "C:\\main-checkout";
    process.env["PYTHONHOME"] = "C:\\main-python";
    registerSlot({ root: slotA, managers: ["pip"] });
    const inside = await child(slotA);
    expect(inside.py).toBeNull();
    expect(inside.home).toBeNull();
    expect(inside.venv).toBe(join(real(slotA), ".venv"));
    expect(inside.path.startsWith(join(real(slotA), ".venv", WIN ? "Scripts" : "bin"))).toBe(true);
    const nested = await child(join(slotA, "sub", "deep"));
    expect(nested.venv).toBe(join(real(slotA), ".venv"));
    const outsideEnv = await child(outside);
    expect(outsideEnv).toMatchObject({ py: "C:\\main-checkout", home: "C:\\main-python", venv: process.env["VIRTUAL_ENV"] ?? null });
    expect(outsideEnv.path).not.toContain(".venv");
  });

  it("explicit run options win over the slot environment", async () => {
    registerSlot({ root: slotA, managers: ["pip"] });
    process.env["PYTHONPATH"] = "C:\\main-checkout";
    const out = await child(slotA, { PYTHONPATH: "explicit", VIRTUAL_ENV: "explicit-venv" });
    expect(out.py).toBe("explicit");
    expect(out.venv).toBe("explicit-venv");
    expect(out.home).toBeNull();
  });
});
