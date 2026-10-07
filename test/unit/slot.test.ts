import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { open as fsOpen, unlink as fsUnlink, utimes as fsUtimes } from "node:fs/promises";
import { createRequire } from "node:module";
import { hostname, tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  acquireSlot,
  exitReleaseFailures,
  isPidAlive,
  machineClockFrom,
  nextBackoffMs,
  reapClaimPath,
  SLOT_DEFAULTS,
  releaseAllSlotsSync,
  withSlot,
  type FileSnapshot,
  type SlotDeps,
  type SlotHandle,
  type SlotResult,
} from "../../src/verify/slot";

// Every test uses its own slot dir, never the real shared one, so parallel runs
// cannot interfere. Timing constants are scaled down through the deps seam.
const SLOT_TS = resolve(__dirname, "../../src/verify/slot.ts");
const HOLDER = resolve(__dirname, "../fixtures/slot/holder.mjs");
const dirs: string[] = [];
const children: ChildProcess[] = [];
const handles: SlotHandle[] = [];
/** JS build of slot.ts for the child processes (Node 20 has no type stripping). */
let slotJs = "";

beforeAll(async () => {
  slotJs = join(freshDir(), "slot.mjs");
  writeFileSync(slotJs, await buildSlotJs(SLOT_TS));
});

function fnOf(mod: unknown, name: string): ((...args: unknown[]) => unknown) | undefined {
  if (typeof mod !== "object" || mod === null) return undefined;
  const f: unknown = (mod as Record<string, unknown>)[name];
  return typeof f === "function" ? (f as (...args: unknown[]) => unknown) : undefined;
}
function codeOf(out: unknown): string {
  const code: unknown = typeof out === "object" && out !== null ? (out as Record<string, unknown>).code : undefined;
  if (typeof code !== "string") throw new Error("transform returned no code");
  return code;
}
/**
 * The real slot.ts as plain JS (QA-1.4-23; no direct `vite` devDependency needed):
 * 1. vite, resolved from vitest's own location (vitest always depends on it, also
 *    under a strict pnpm layout): `transformWithOxc` (vite 8), else
 *    `transformWithEsbuild` (vite 6 and 7);
 * 2. else Node's built-in `module.stripTypeScriptTypes` (Node 22.13+).
 */
async function buildSlotJs(file: string): Promise<string> {
  const src = readFileSync(file, "utf8");
  const tried: string[] = [];
  try {
    const fromVitest = createRequire(createRequire(import.meta.url).resolve("vitest/package.json"));
    const vite: unknown = await import(pathToFileURL(fromVitest.resolve("vite")).href);
    const oxc = fnOf(vite, "transformWithOxc");
    if (oxc) return codeOf(await oxc(src, file, { lang: "ts" }));
    const esbuild = fnOf(vite, "transformWithEsbuild");
    if (esbuild) return codeOf(await esbuild(src, file, { loader: "ts" }));
    tried.push("vite has neither transformWithOxc nor transformWithEsbuild");
  } catch (e) {
    tried.push(`vite: ${String(e)}`);
  }
  const strip = fnOf(await import("node:module"), "stripTypeScriptTypes");
  if (strip) return String(strip(src));
  throw new Error(`cannot build slot.ts for the child processes: ${tried.join("; ")}`);
}

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "omr-slot-"));
  dirs.push(d);
  return d;
}
function fast(dir: string, extra: SlotDeps = {}): SlotDeps {
  return { dir, heartbeatMs: 100, staleMs: 1_000, corruptGraceMs: 200, backoffMinMs: 20, backoffMaxMs: 100, unlinkRetryMs: 5, ...extra };
}
/**
 * An observer that must confirm by watching: its looks come one wake-up (up to
 * backoffMaxMs, 100 ms) plus one attempt apart, so the gap rule (2 heartbeats)
 * needs a heartbeat of at least 5 x backoffMaxMs to hold under CPU load (QA-1.4-30).
 */
const WATCHER_HEARTBEAT_MS = 500;
const meta = { cwd: "/x", command: "vitest" };
function held(r: SlotResult): SlotHandle {
  if ("busy" in r) throw new Error("expected a slot, got busy");
  handles.push(r);
  return r;
}
function writeLock(path: string, over: Record<string, unknown>, ageMs = 0): void {
  writeFileSync(path, JSON.stringify({ pid: process.pid, hostname: hostname(), token: "other", startedAt: 0, cwd: "", command: "", ...over }));
  if (ageMs) setAge(path, ageMs);
}
function tokenAt(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const v: unknown = JSON.parse(readFileSync(path, "utf8"));
  return typeof v === "object" && v !== null && "token" in v ? String(v.token) : undefined;
}
function setAge(path: string, ageMs: number): void {
  const t = new Date(Date.now() - ageMs);
  utimesSync(path, t, t);
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitUntil(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await sleep(10);
  }
}
/** The default read of slot.ts, for seams that wrap it. */
async function realRead(path: string): Promise<FileSnapshot> {
  const fh = await fsOpen(path, "r");
  try {
    const st = await fh.stat();
    return { text: await fh.readFile("utf8"), mtimeMs: st.mtimeMs, size: st.size };
  } finally {
    await fh.close();
  }
}
/** Claim files (`slot-<i>.lock.reap-<hash>`) present in `dir`. */
function claimsIn(dir: string): string[] {
  return readdirSync(dir).filter((n) => n.includes(".reap-"));
}
/** A PID that is not running now (Windows reuses PIDs quickly, so check it). */
async function deadPid(): Promise<number> {
  for (;;) {
    const r = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
    const pid = Number(r.stdout.toString());
    for (let i = 0; i < 50 && isPidAlive(pid); i++) await sleep(20);
    if (!isPidAlive(pid)) return pid;
  }
}
function killHard(child: ChildProcess): void {
  if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)]);
  else child.kill("SIGKILL");
}
interface Holder {
  child: ChildProcess;
  /** Resolves with the first stdout line matching `want`, or "EXIT <stdout> <stderr>" if the child exits first. */
  waitFor(want: RegExp): Promise<string>;
  exit: Promise<number | null>;
}
function runHolder(cfg: Record<string, unknown>): Holder {
  const child = spawn(process.execPath, [HOLDER, slotJs, JSON.stringify(cfg)], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  const lines: string[] = [];
  let buf = "";
  let err = "";
  let exited = false;
  const wake: Array<() => void> = [];
  const poke = () => {
    for (const w of wake.splice(0)) w();
  };
  child.stdout!.on("data", (d: Buffer) => {
    buf += d.toString();
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      lines.push(buf.slice(0, i).trim());
      buf = buf.slice(i + 1);
    }
    poke();
  });
  child.stderr!.on("data", (d: Buffer) => (err += d.toString()));
  const exit = new Promise<number | null>((res) =>
    child.on("exit", (c) => {
      exited = true;
      poke();
      res(c);
    }),
  );
  const waitFor = (want: RegExp) =>
    new Promise<string>((res) => {
      const check = () => {
        const hit = lines.find((l) => want.test(l));
        if (hit !== undefined) res(hit);
        else if (exited) res(`EXIT ${lines.join("|")} ${err}`);
        else wake.push(check);
      };
      check();
    });
  return { child, waitFor, exit };
}
/** Start children behind a barrier: each loads the module, prints READY, then waits for the go file. */
async function startTogether(dir: string, cfgs: Array<Record<string, unknown>>): Promise<Holder[]> {
  const go = join(dir, "go");
  const hs = cfgs.map((c) => runHolder({ ...c, go }));
  expect(await Promise.all(hs.map((h) => h.waitFor(/^READY$/)))).toEqual(cfgs.map(() => "READY"));
  writeFileSync(go, "");
  return hs;
}

afterEach(async () => {
  for (const h of handles.splice(0)) await h.release();
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) killHard(c);
});
afterAll(() => {
  // A hard-killed child may still hold a lock or ticket for a moment (EBUSY/EPERM on Windows):
  // retry, and never let one busy directory strand the rest (omr-slot-* leaked otherwise).
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // Best effort: a directory still busy after the retries is left to the OS temp cleanup.
    }
  }
});

function intervals(log: string): Array<[number, number]> {
  const enter = new Map<string, number>();
  const out: Array<[number, number]> = [];
  for (const l of readFileSync(log, "utf8").trim().split("\n")) {
    const [id, kind, t] = l.split(" ");
    if (kind === "enter") enter.set(id, Number(t));
    else out.push([enter.get(id)!, Number(t)]);
  }
  return out;
}
function maxOverlap(iv: Array<[number, number]>): number {
  const ev = iv.flatMap(([a, b]) => [[a, 1], [b, -1]] as Array<[number, number]>).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let cur = 0;
  let max = 0;
  for (const [, d] of ev) max = Math.max(max, (cur += d));
  return max;
}

async function cycleSix(dir: string, max: number, holdMs: number): Promise<void> {
  const log = join(dir, "log.txt");
  writeFileSync(log, "");
  const hs = await startTogether(
    dir,
    Array.from({ length: 6 }, (_, i) => ({ dir, max, waitMs: 20_000, holdMs, log, id: `p${i}`, mode: "cycle", deps: { backoffMinMs: 10, backoffMaxMs: 60 } })),
  );
  const codes = await Promise.all(hs.map((h) => h.exit));
  expect(codes).toEqual([0, 0, 0, 0, 0, 0]);
  const iv = intervals(log);
  expect(iv).toHaveLength(6);
  expect(maxOverlap(iv)).toBeLessThanOrEqual(max);
  if (max === 2) expect(maxOverlap(iv)).toBe(2); // the second slot is actually used
}

describe("slot: multi-process exclusion", () => {
  it.each([
    [1, 150],
    [2, 500],
  ])("max=%i: never more than max holders across 6 processes (hold %i ms)", async (max, holdMs) => {
    await cycleSix(freshDir(), max, holdMs);
  }, 30_000);

  it("a crashed holder (hard kill) is reclaimed by a waiter that was already waiting, within the backoff window", async () => {
    const dir = freshDir();
    const h = runHolder({ dir, max: 1, waitMs: 1_000, mode: "hang" });
    expect(await h.waitFor(/^(HELD|BUSY)$/)).toBe("HELD");
    expect(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir))).toEqual({ busy: true });
    // The waiter starts first (production backoff 250 ms -> 2 s) and is in backoff when the holder dies.
    const waiting = acquireSlot({ max: 1, waitMs: 10_000, meta }, { dir });
    await sleep(700);
    killHard(h.child);
    await h.exit;
    const t0 = Date.now();
    held(await waiting);
    expect(Date.now() - t0).toBeLessThan(3_000);
  }, 20_000);

  it("the heartbeat timer is unref'd: a holder exits on its own and the exit hook frees the slot", async () => {
    const dir = freshDir();
    const h = runHolder({ dir, max: 1, waitMs: 1_000, mode: "exit", deps: { heartbeatMs: 50 } });
    expect(await h.waitFor(/^(HELD|BUSY)$/)).toBe("HELD");
    expect(await h.exit).toBe(0);
    expect(existsSync(join(dir, "slot-0.lock"))).toBe(false);
  }, 15_000);
});

describe("slot: stale detection", () => {
  it("a live but unrelated PID whose heartbeat stopped is reclaimed only after the stale threshold", async () => {
    const dir = freshDir();
    writeLock(join(dir, "slot-0.lock"), { pid: process.pid }); // live PID, fresh mtime, not ours
    const t0 = Date.now();
    held(await acquireSlot({ max: 1, waitMs: 5_000, meta }, fast(dir, { staleMs: 600, heartbeatMs: WATCHER_HEARTBEAT_MS })));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(500);
  }, 20_000);

  it("a long hold (3x the stale threshold) keeps its slot because the heartbeat is fresh", async () => {
    const dir = freshDir();
    const deps = fast(dir, { staleMs: 2_000, heartbeatMs: 100 });
    const a = held(await acquireSlot({ max: 1, waitMs: 0, meta }, deps));
    expect(await acquireSlot({ max: 1, waitMs: 6_000, meta }, deps)).toEqual({ busy: true });
    await a.release();
    held(await acquireSlot({ max: 1, waitMs: 0, meta }, deps));
  }, 15_000);

  it("a foreign host lock is never judged by PID: fresh heartbeat kept, old heartbeat reclaimed after confirmation", async () => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    writeLock(p, { hostname: "some-other-host", pid: await deadPid() });
    const deps = fast(dir, { staleMs: 5_000, heartbeatMs: WATCHER_HEARTBEAT_MS });
    expect(await acquireSlot({ max: 1, waitMs: 400, meta }, deps)).toEqual({ busy: true });
    setAge(p, 6_000);
    // One look is not enough: the same (token, mtime) must be seen for 2 heartbeats (2 x 500 ms, plus the slack).
    expect(await acquireSlot({ max: 1, waitMs: 0, meta }, deps)).toEqual({ busy: true });
    const t0 = Date.now();
    held(await acquireSlot({ max: 1, waitMs: 5_000, meta }, deps));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(950);
  }, 20_000);

  it("same host + dead PID is stale immediately, even with a fresh heartbeat", async () => {
    const dir = freshDir();
    writeLock(join(dir, "slot-0.lock"), { pid: await deadPid() });
    held(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir, { staleMs: 60_000 })));
  });

  it.each([["empty", ""], ["corrupt", "{not json"], ["wrong shape", '{"pid":"x"}']])("a %s lock file is stale (after the write grace)", async (_n, body) => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    writeFileSync(p, body);
    const deps = fast(dir, { corruptGraceMs: 300, heartbeatMs: WATCHER_HEARTBEAT_MS });
    expect(await acquireSlot({ max: 1, waitMs: 0, meta }, deps)).toEqual({ busy: true });
    const t0 = Date.now();
    held(await acquireSlot({ max: 1, waitMs: 5_000, meta }, deps));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
  }, 20_000);
});

describe("slot: clock changes and suspend/resume (QA-1.4-1, QA-1.4-8)", () => {
  it("production defaults: a live holder whose file looks 31 s old (resume from sleep) or a waiter whose clock jumped +31 s does not reap it", async () => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    held(await acquireSlot({ max: 1, waitMs: 0, meta }, { dir }));
    setAge(p, 31_000);
    expect(await acquireSlot({ max: 1, waitMs: 0, meta }, { dir })).toEqual({ busy: true });
    expect(await acquireSlot({ max: 1, waitMs: 0, meta }, { dir, now: () => Date.now() + 31_000 })).toEqual({ busy: true });
    expect(existsSync(p)).toBe(true);
  });

  it("a live holder keeps its slot against a waiting observer with an aged file or a stepped clock", async () => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    held(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir, { heartbeatMs: 100 })));
    const mine = tokenAt(p);
    setAge(p, 31_000);
    // The observer confirms over 2 of its heartbeats (2 x 500 ms); the holder beats every 100 ms.
    const observer = fast(dir, { heartbeatMs: 500, staleMs: 1_000 });
    expect(await acquireSlot({ max: 1, waitMs: 1_500, meta }, observer)).toEqual({ busy: true });
    expect(await acquireSlot({ max: 1, waitMs: 1_500, meta }, { ...observer, now: () => Date.now() + 31_000 })).toEqual({ busy: true });
    expect(tokenAt(p)).toBe(mine);
  }, 10_000);

  it("a lock whose mtime is in the future (clock stepped back) is reclaimed once seen unchanged for staleMs of monotonic time", async () => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    writeLock(p, { hostname: "some-other-host" });
    const future = new Date(Date.now() + 3_600_000);
    utimesSync(p, future, future);
    const t0 = Date.now();
    held(await acquireSlot({ max: 1, waitMs: 5_000, meta }, fast(dir, { staleMs: 600, heartbeatMs: WATCHER_HEARTBEAT_MS })));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(550);
  }, 20_000);

  it("the wait deadline is monotonic: wall-clock steps neither cut a wait short nor extend it", async () => {
    const dir = freshDir();
    held(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir)));
    // The observers confirm staleness over 2 x 1 s, longer than the wait: only the deadline ends it.
    let calls = 0;
    const forward = () => Date.now() + (calls++ > 1 ? 3_600_000 : 0);
    let t0 = Date.now();
    expect(await acquireSlot({ max: 1, waitMs: 600, meta }, fast(dir, { heartbeatMs: 1_000, now: forward }))).toEqual({ busy: true });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(550);
    calls = 0;
    const backward = () => Date.now() - (calls++ > 1 ? 3_600_000 : 0);
    t0 = Date.now();
    expect(await acquireSlot({ max: 1, waitMs: 600, meta }, fast(dir, { heartbeatMs: 1_000, now: backward }))).toEqual({ busy: true });
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});

describe("slot: observations never mix clock origins (QA-1.4-27)", () => {
  /** A clock that reads 0 at `startedAt` (a `performance.now()` time), like Bun's per-process hrtime. */
  const sinceStart = (startedAt: number) => () => performance.now() - startedAt;
  /** The views of the one observation sidecar in `dir`. */
  function viewsIn(dir: string): unknown[] {
    const seen = readdirSync(dir).filter((n) => n.includes(".seen-"));
    expect(seen).toHaveLength(1);
    const rec: unknown = JSON.parse(readFileSync(join(dir, seen[0]!), "utf8"));
    const views: unknown = typeof rec === "object" && rec !== null ? (rec as Record<string, unknown>).views : undefined;
    if (!Array.isArray(views)) throw new Error("no views in the sidecar");
    return views;
  }

  it("observers whose clocks are 8 s apart never add up each other's looks: a live holder is not reaped (b1)", async () => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    // Production heartbeat (5 s): the looks below all come before the holder's first heartbeat.
    const h = held(await acquireSlot({ max: 1, waitMs: 0, meta }, { dir }));
    const t0 = Date.now();
    const mine = tokenAt(p);
    // A +31 s wall step (NTP, a VM resume) makes the file look old to both observers.
    const stepped = () => Date.now() + 31_000;
    const y: SlotDeps = { dir, now: stepped, mono: () => performance.now() };
    const o: SlotDeps = { dir, now: stepped, mono: () => performance.now() + 8_000 };
    const at = (ms: number) => sleep(Math.max(0, t0 + ms - Date.now()));
    await at(200);
    expect(await acquireSlot({ max: 1, waitMs: 0, meta }, y)).toEqual({ busy: true });
    await at(3_000);
    expect(await acquireSlot({ max: 1, waitMs: 0, meta }, y)).toEqual({ busy: true });
    await at(4_400);
    // On one record, O's clock would see a 9.4 s gap (no restart) and count 4.2 s + 8 s = 12.2 s
    // since Y's first look: 2 heartbeats plus the 2 s slack.
    expect(await acquireSlot({ max: 1, waitMs: 0, meta }, o)).toEqual({ busy: true });
    expect(tokenAt(p)).toBe(mine);
    expect(h.lost).toBe(false);
    expect(viewsIn(dir)).toHaveLength(2);
  }, 15_000);

  it.each([
    ["8 s apart", (): Array<() => number> => [() => performance.now(), () => performance.now() + 8_000]],
    [
      "reading 0 at their own start, 1.5 s apart (Bun's hrtime)",
      (): Array<() => number> => {
        const s = performance.now();
        return [sinceStart(s - 3_000), sinceStart(s - 1_500)];
      },
    ],
  ])("two observers whose clocks are %s each reclaim a hung lock on their own view, and only one holds it (b3)", async (_n, clocks) => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    writeLock(p, { pid: process.pid, token: "hung" }, 60_000);
    const [ma, mb] = clocks();
    const base = fast(dir, { heartbeatMs: WATCHER_HEARTBEAT_MS, staleMs: 1_000 });
    const deps: SlotDeps[] = [
      { ...base, mono: ma },
      { ...base, mono: mb },
    ];
    // They alternate, each looking every 400 ms (< 2 heartbeats): on one shared record each look
    // would restart the other's witness (a gap, or a stamp from the future), for ever.
    const t0 = Date.now();
    let r: SlotResult = { busy: true };
    for (let i = 0; "busy" in r && Date.now() - t0 < 10_000; i++) {
      if (i > 0) await sleep(200);
      r = await acquireSlot({ max: 1, waitMs: 0, meta }, deps[i % 2]);
    }
    const winner = held(r);
    const owner = tokenAt(p);
    expect(owner).not.toBe("hung");
    for (let k = 0; k < 6; k++) {
      await sleep(200);
      expect(await acquireSlot({ max: 1, waitMs: 0, meta }, deps[k % 2])).toEqual({ busy: true });
    }
    expect(tokenAt(p)).toBe(owner);
    expect(winner.lost).toBe(false);
  }, 20_000);

  it("the default clock: hrtime as is where it reads the uptime (Node), else anchored to the uptime (Bun), so every process reads one machine clock", () => {
    // Simulated machine time T (ms since boot), and an uptime in whole seconds (the coarsest runtime).
    let T = 3_600_123;
    const up = () => Math.floor(T / 1_000) * 1_000;
    const nodeHr = () => T + 2;
    expect(machineClockFrom(nodeHr, up)).toBe(nodeHr);
    // Bun: hrtime counts from the process start; A started 5 s ago, B 13 s ago (8 s apart).
    const startA = T - 5_000;
    const startB = T - 13_000;
    const a = machineClockFrom(() => T - startA, up);
    const b = machineClockFrom(() => T - startB, up);
    let prev = -Infinity;
    for (let k = 0; k < 400; k++, T += 7) {
      const va = a();
      const vb = b();
      expect(va).toBeGreaterThanOrEqual(prev); // never goes back
      prev = va;
      expect(va).toBeLessThanOrEqual(T); // each sample is a lower bound
      expect(T - va).toBeLessThan(1_000 + 7);
      expect(Math.abs(va - vb)).toBeLessThan(1_000);
    }
    // Once a tick has been seen, both are within one sampling step of the machine time.
    expect(T - a()).toBeLessThanOrEqual(7);
    expect(Math.abs(a() - b())).toBeLessThanOrEqual(7);
  });

  it("fresh processes with Bun-like clocks share one view through the default clock; raw per-process clocks get one view each", async () => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    writeLock(p, { pid: process.pid, token: "hung" }, 60_000);
    const s = performance.now();
    const uptime = () => performance.now() + 3_600_000; // a boot clock, as the OS uptime
    const deps = (mono: () => number) => fast(dir, { heartbeatMs: WATCHER_HEARTBEAT_MS, staleMs: 1_000, mono });
    for (const ago of [500, 8_500, 20_000]) {
      expect(await acquireSlot({ max: 1, waitMs: 0, meta }, deps(machineClockFrom(sinceStart(s - ago), uptime)))).toEqual({ busy: true });
    }
    expect(viewsIn(dir)).toHaveLength(1);
    for (const ago of [500, 8_500]) expect(await acquireSlot({ max: 1, waitMs: 0, meta }, deps(sinceStart(s - ago)))).toEqual({ busy: true });
    expect(viewsIn(dir)).toHaveLength(3);
  });
});

describe("slot: shared observations outlive a call and a process (QA-1.4-21)", () => {
  it("fresh processes that each look once with waitMs 0 reclaim a lock whose owner is not provably dead, once unchanged for staleMs", async () => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    // A hung holder: live PID on this host (or a reused one), fresh mtime, no more heartbeats.
    writeLock(p, { pid: process.pid, token: "hung" });
    const planted = Date.now();
    const deps = { heartbeatMs: 1_000, staleMs: 3_000 }; // the looks must be less than 2 heartbeats minus both looks' slacks (2 x 1 s - 2 x 200 ms = 1.6 s) apart
    const out: Array<{ r: string; at: number }> = [];
    for (let i = 0; i < 5; i++) {
      await sleep(Math.max(0, planted + i * 900 - Date.now()));
      const at = Date.now() - planted;
      const h = runHolder({ dir, max: 1, waitMs: 0, mode: "exit", deps });
      const r = await h.waitFor(/^(HELD|BUSY)$/);
      await h.exit;
      out.push({ r, at });
    }
    const first = out.findIndex((x) => x.r === "HELD");
    // Looks before staleMs (children 0-2 start by 1.8 s) are busy; one of the last two takes it.
    expect(first, JSON.stringify(out)).toBeGreaterThanOrEqual(3);
    expect(out.slice(0, first).every((x) => x.r === "BUSY"), JSON.stringify(out)).toBe(true);
    expect(existsSync(p)).toBe(false); // the child that took it released it at exit
  }, 20_000);

  it("one process calling with waitMs 0 less often than the padded gap limit (2 heartbeats minus both slacks) still reclaims it: the background watch confirms", async () => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    writeLock(p, { pid: process.pid, token: "hung" });
    const t0 = Date.now();
    const deps = fast(dir, { heartbeatMs: 200, staleMs: 1_000 }); // a gap over 2 x 200 ms - 2 x 40 ms slack = 320 ms restarts the witness
    let r: SlotResult = { busy: true };
    let calls = 0;
    while ("busy" in r && Date.now() - t0 < 8_000) {
      if (calls++ > 0) await sleep(600); // every call comes after a gap: calls alone never confirm
      r = await acquireSlot({ max: 1, waitMs: 0, meta }, deps);
    }
    held(r);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_000);
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(tokenAt(p)).not.toBe("hung");
  }, 15_000);

  it("after a gap in the looks (all processes frozen while every clock ran), an old lock must be witnessed for 2 heartbeats again (QA-1.4-1)", async () => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    writeLock(p, { pid: process.pid, token: "frozen-holder" }, 60_000);
    let skew = 0;
    const deps = fast(dir, { heartbeatMs: 500, staleMs: 1_000, now: () => Date.now() + skew, mono: () => performance.now() + skew });
    expect(await acquireSlot({ max: 1, waitMs: 0, meta }, deps)).toEqual({ busy: true });
    skew += 60_000; // a 60 s Modern Standby: the holder could not run, the wall clock and QPC did
    expect(await acquireSlot({ max: 1, waitMs: 0, meta }, deps)).toEqual({ busy: true });
    expect(tokenAt(p)).toBe("frozen-holder");
    const t0 = Date.now();
    held(await acquireSlot({ max: 1, waitMs: 5_000, meta }, deps));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
  }, 20_000);
});

describe("slot: release", () => {
  it("release is idempotent and stops the heartbeat: the released handle's own lock is never touched again (QA-1.4-10)", async () => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    let touches = 0;
    const utimes = async (path: string, t: Date) => {
      if (path === p) touches++;
      await fsUtimes(path, t, t);
    };
    const a = held(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir, { heartbeatMs: 30, utimes })));
    await waitUntil(() => touches >= 2); // the heartbeat does run
    const own = readFileSync(p, "utf8");
    await a.release();
    await a.release();
    expect(existsSync(p)).toBe(false);
    // Put the released handle's *own* lock back, aged: a heartbeat still running would refresh it.
    writeFileSync(p, own);
    setAge(p, 10_000);
    const before = statSync(p).mtimeMs;
    const count = touches;
    await sleep(250); // more than 3 heartbeats
    expect(statSync(p).mtimeMs).toBe(before);
    expect(touches).toBe(count);
    rmSync(p);
  });

  it("release after the slot was reclaimed as stale does not delete the new owner's file", async () => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    const a = held(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir, { heartbeatMs: 1_000_000 })));
    setAge(p, 10_000);
    const b = held(await acquireSlot({ max: 1, waitMs: 5_000, meta }, fast(dir, { staleMs: 1_000, heartbeatMs: WATCHER_HEARTBEAT_MS })));
    const owner = readFileSync(p, "utf8");
    await a.release();
    expect(readFileSync(p, "utf8")).toBe(owner);
    await b.release();
    expect(existsSync(p)).toBe(false);
  }, 20_000);

  it("EBUSY/EPERM on unlink is retried; a persistent failure is not treated as success", async () => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    const { unlink } = await import("node:fs/promises");
    let fails = 2;
    const flaky = async (path: string) => {
      if (path === p && fails-- > 0) throw Object.assign(new Error("busy"), { code: fails % 2 ? "EBUSY" : "EPERM" });
      await unlink(path);
    };
    const a = held(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir, { unlink: flaky })));
    await a.release();
    expect(existsSync(p)).toBe(false);

    const warns: string[] = [];
    const never = async (path: string) => {
      if (path === p) throw Object.assign(new Error("locked"), { code: "EPERM" });
      await unlink(path);
    };
    const b = held(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir, { unlink: never, unlinkRetries: 2, logger: { warn: (m) => warns.push(m) } })));
    await b.release();
    expect(existsSync(p)).toBe(true);
    expect(warns.some((w) => w.includes("could not delete"))).toBe(true);
    expect(warns.some((w) => w.includes("release incomplete"))).toBe(true);
    // Still ours and still held: another acquirer is busy until it goes stale.
    expect(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir))).toEqual({ busy: true });
  });

  it("every exit path releases: success, throw, abort", async () => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    const deps = fast(dir);
    expect(await withSlot({ max: 1, waitMs: 0, meta }, async () => 7, deps)).toEqual({ value: 7 });
    expect(existsSync(p)).toBe(false);
    await expect(withSlot({ max: 1, waitMs: 0, meta }, async () => { throw new Error("boom"); }, deps)).rejects.toThrow("boom");
    expect(existsSync(p)).toBe(false);
    const ac = new AbortController();
    await expect(
      withSlot({ max: 1, waitMs: 0, meta, signal: ac.signal }, async () => {
        ac.abort();
        throw ac.signal.reason;
      }, deps),
    ).rejects.toBeDefined();
    expect(existsSync(p)).toBe(false);
  });
});

describe("slot: claims replace the time-leased reap lock (QA-1.4-2, QA-1.4-11)", () => {
  it("a crashed reaper's claim (dead PID) is cleared and the dead lock reaped at once", async () => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    writeLock(p, { pid: await deadPid(), token: "dead-holder" });
    writeLock(reapClaimPath(p, "dead-holder"), { pid: await deadPid(), token: "dead-reaper", command: "reap" });
    held(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir)));
    expect(claimsIn(dir)).toEqual([]);
  });

  it("a live claimer's claim survives one look and a stepped clock; it is inert only once seen unchanged for staleMs, whatever its wall age (QA-1.4-20)", async () => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    writeLock(p, { pid: await deadPid(), token: "dead-holder" });
    const claim = reapClaimPath(p, "dead-holder");
    // Its mtime says 60 s old: that no longer shortens anything.
    writeLock(claim, { pid: process.ppid, token: "live-claimer", command: "reap" }, 60_000);
    // One heartbeat for every look: a view's padded gap rule (QA-1.4-34) needs its writers' slacks to fit in 2 heartbeats.
    // claimHoldMaxMs 1 s: a claimed delete must fit in it even in a loaded worker (QA-1.4-35).
    const deps = fast(dir, { claimHoldMaxMs: 1_000, heartbeatMs: WATCHER_HEARTBEAT_MS });
    const t0 = Date.now();
    expect(await acquireSlot({ max: 1, waitMs: 0, meta }, deps)).toEqual({ busy: true });
    expect(await acquireSlot({ max: 1, waitMs: 0, meta }, { ...deps, now: () => Date.now() + 10_500 })).toEqual({ busy: true });
    expect(existsSync(claim)).toBe(true);
    // Inert: unchanged for staleMs (1 s here) since its first sighting above, witnessed for 2 x claimHoldMaxMs
    // (each plus the view's slack). The +10.5 s look has another origin, so it has its own view.
    held(await acquireSlot({ max: 1, waitMs: 10_000, meta }, deps));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(950);
    expect(claimsIn(dir)).toEqual([]);
  }, 20_000);

  it("the claim-hold deadline is re-checked after the re-read, right before the unlink (QA-1.4-20)", async () => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    writeLock(p, { pid: await deadPid(), token: "dead-holder" });
    let unlinks = 0;
    const unlink = async (path: string) => {
      if (path === p) unlinks++;
      await fsUnlink(path);
    };
    // The re-read under the claim outlasts claimHoldMaxMs (100 ms): the reaper must not delete after it.
    const read = async (path: string) => {
      const snap = await realRead(path);
      if (path === p && claimsIn(dir).length > 0) await sleep(120);
      return snap;
    };
    const warns: string[] = [];
    const deps = fast(dir, { claimHoldMaxMs: 100, read, unlink, logger: { warn: (m) => warns.push(m) } });
    expect(await acquireSlot({ max: 1, waitMs: 0, meta }, deps)).toEqual({ busy: true });
    expect(unlinks).toBe(0);
    expect(tokenAt(p)).toBe("dead-holder");
    expect(warns.some((w) => w.includes("claim held too long"))).toBe(true);
  });

  it("a claim is held only after a readable re-read shows its token; an unconfirmed one deletes nothing and, past its owner's drop fence, is left to the inert rule (QA-1.4-26)", async () => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    writeLock(p, { pid: await deadPid(), token: "dead-holder" });
    let scanner = true;
    const read = async (path: string) => {
      if (scanner && path.includes(".reap-")) throw Object.assign(new Error("scanner"), { code: "EBUSY" });
      return realRead(path);
    };
    // claimHoldMaxMs 1 s (drop fence 1.5 s): a claimed delete must fit in it even in a loaded worker (QA-1.4-35).
    const deps = fast(dir, { read, claimHoldMaxMs: 1_000, unlinkRetries: 2, heartbeatMs: WATCHER_HEARTBEAT_MS });
    expect(await acquireSlot({ max: 1, waitMs: 0, meta }, deps)).toEqual({ busy: true });
    expect(tokenAt(p)).toBe("dead-holder");
    expect(existsSync(reapClaimPath(p, "dead-holder"))).toBe(true); // ours, but never confirmed
    // Its owner drops it at a readable look within 1.5 x claimHoldMaxMs (QA-1.4-29); after that it is any claim.
    await sleep(1_700);
    scanner = false;
    const t0 = Date.now();
    held(await acquireSlot({ max: 1, waitMs: 10_000, meta }, deps));
    // Inert once witnessed for 2 x claimHoldMaxMs + the slacks (2.2 s) from its first readable sighting; with
    // claimHoldMaxMs at 1 s that, not staleMs, decides. 900 ms still separates "inert" from "dropped at once".
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    expect(claimsIn(dir)).toEqual([]);
  }, 20_000);

  it("a reaper held inside its claim by EBUSY retries keeps it against a waiter whose clock jumped (P3)", async () => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    writeLock(p, { pid: await deadPid(), token: "dead-holder" });
    let blocking = true;
    const stuck = async (path: string) => {
      if (path === p && blocking) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      await fsUnlink(path);
    };
    const a = acquireSlot({ max: 1, waitMs: 5_000, meta }, fast(dir, { unlink: stuck, unlinkRetryMs: 40 }));
    await waitUntil(() => claimsIn(dir).length === 1);
    expect(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir, { now: () => Date.now() + 10_500 }))).toEqual({ busy: true });
    blocking = false;
    held(await a);
    expect(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir))).toEqual({ busy: true });
    expect(claimsIn(dir)).toEqual([]);
  }, 20_000);

  it("6 processes against a planted dead lock: never two holders", async () => {
    const dir = freshDir();
    writeLock(join(dir, "slot-0.lock"), { pid: await deadPid(), token: "planted" });
    await cycleSix(dir, 1, 150);
    expect(claimsIn(dir)).toEqual([]);
  }, 30_000);

  it("6 processes against a planted dead lock plus a crashed reaper's claim and legacy reap/tombstone files", async () => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    writeLock(p, { pid: await deadPid(), token: "planted" });
    writeLock(reapClaimPath(p, "planted"), { pid: await deadPid(), token: "dead-reaper", command: "reap" }, 11_000);
    writeFileSync(`${p}.reap`, "legacy");
    writeFileSync(`${p}.reap.dead-0`, "tombstone");
    await cycleSix(dir, 1, 150);
    expect(claimsIn(dir)).toEqual([]);
  }, 30_000);
});

describe("slot: release never fails the caller (QA-1.4-4, QA-1.4-6, QA-1.4-17)", () => {
  const eio = async (path: string) => {
    if (/slot-\d+\.lock$/.test(path)) throw Object.assign(new Error("io"), { code: "EIO" });
    await fsUnlink(path);
  };

  it("release never rejects and does not cache a failure; withSlot keeps fn's value and error", async () => {
    const dir = freshDir();
    const warns: string[] = [];
    const a = held(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir, { unlink: eio, logger: { warn: (m) => warns.push(m) } })));
    await expect(a.release()).resolves.toBeUndefined();
    await expect(a.release()).resolves.toBeUndefined();
    expect(warns.some((w) => w.includes("release incomplete"))).toBe(true);

    let breakReads = false;
    const read = async (path: string) => {
      if (breakReads) throw Object.assign(new Error("io"), { code: "EIO" });
      return realRead(path);
    };
    const b = held(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(freshDir(), { read })));
    breakReads = true;
    await expect(b.release()).resolves.toBeUndefined();
    breakReads = false;

    expect(await withSlot({ max: 1, waitMs: 0, meta }, async () => 42, fast(freshDir(), { unlink: eio }))).toEqual({ value: 42 });
    await expect(
      withSlot({ max: 1, waitMs: 0, meta }, async () => { throw new Error("boom"); }, fast(freshDir(), { unlink: eio })),
    ).rejects.toThrow("boom");
  });

  it("transient sharing violations on the lock and claim files during release are retried, and the file is deleted", async () => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    let busyReads = 0;
    const read = async (path: string) => {
      if (busyReads > 0 && (path === p || path.includes(".reap-"))) {
        busyReads--;
        throw Object.assign(new Error("busy"), { code: "EBUSY" });
      }
      return realRead(path);
    };
    const warns: string[] = [];
    const a = held(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir, { read, logger: { warn: (m) => warns.push(m) } })));
    busyReads = 4;
    await a.release();
    expect(existsSync(p)).toBe(false);
    expect(claimsIn(dir)).toEqual([]);
    expect(warns).toEqual([]);
    held(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir)));
  });

  it("a release that cannot read its lock keeps the slot, warns, and deletes it in the background later", async () => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    let locked = false;
    const read = async (path: string) => {
      if (locked && path === p) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      return realRead(path);
    };
    const warns: string[] = [];
    const a = held(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir, { read, unlinkRetries: 2, logger: { warn: (m) => warns.push(m) } })));
    locked = true;
    await a.release();
    expect(existsSync(p)).toBe(true);
    expect(warns.some((w) => w.includes("release incomplete"))).toBe(true);
    expect(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir))).toEqual({ busy: true });
    locked = false;
    await waitUntil(() => !existsSync(p));
    held(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir)));
  }, 20_000);

  it("the owner's release drops its own claim that a scanner kept it from confirming, at the next readable look, so the slot is free at once (QA-1.4-29)", async () => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    let scanUntil = 0;
    const read = async (path: string) => {
      if (path.includes(".reap-") && Date.now() < scanUntil) throw Object.assign(new Error("scanner"), { code: "EBUSY" });
      return realRead(path);
    };
    const a = held(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir, { read, heartbeatMs: WATCHER_HEARTBEAT_MS })));
    // Longer than the claim's re-read retries (5 ms x 2^i, 315 ms): the release's claim stays unconfirmed.
    scanUntil = Date.now() + 600;
    const t0 = Date.now();
    await a.release();
    // Without the drop, the claim (live PID) would block the slot until inert: 2 x claimHoldMaxMs = 10 s.
    await waitUntil(() => !existsSync(p) && claimsIn(dir).length === 0, 4_000);
    expect(Date.now() - t0).toBeLessThan(4_000);
    held(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir)));
  }, 20_000);

  it("a heartbeat tick in flight when release starts never touches the file afterwards", async () => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    let arm = false;
    let gate: () => void = () => undefined;
    let started: () => void = () => undefined;
    const tickStarted = new Promise<void>((r) => (started = r));
    const read = async (path: string) => {
      if (arm && path === p) {
        arm = false;
        started();
        await new Promise<void>((r) => (gate = r));
      }
      return realRead(path);
    };
    let touches = 0;
    const utimes = async (path: string, t: Date) => {
      touches++;
      await fsUtimes(path, t, t);
    };
    const a = held(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir, { heartbeatMs: 50, read, utimes })));
    arm = true;
    await tickStarted;
    const before = touches;
    const releasing = a.release();
    gate();
    await releasing;
    await sleep(200);
    expect(touches).toBe(before);
    expect(existsSync(p)).toBe(false);
  });

  it("the exit hook follows the claim protocol: it deletes its own file and leaves one a live reaper has claimed", async () => {
    const dir = freshDir();
    const p0 = join(dir, "slot-0.lock");
    const p1 = join(dir, "slot-1.lock");
    const deps = fast(dir, { heartbeatMs: 1_000_000 });
    held(await acquireSlot({ max: 2, waitMs: 0, meta }, deps));
    held(await acquireSlot({ max: 2, waitMs: 0, meta }, deps));
    const foreign = reapClaimPath(p1, tokenAt(p1)!);
    writeLock(foreign, { pid: process.ppid, token: "reaper", command: "reap" });
    const failures = exitReleaseFailures;
    releaseAllSlotsSync();
    expect(existsSync(p0)).toBe(false);
    expect(existsSync(p1)).toBe(true);
    expect(claimsIn(dir)).toEqual([foreign.slice(dir.length + 1)]);
    expect(exitReleaseFailures).toBe(failures);
    rmSync(foreign);
  });

  it("the exit hook drops this process's unconfirmed claim only within its drop fence; past it the claim is left to the inert rule (QA-1.4-32)", async () => {
    for (const past of [false, true]) {
      const dir = freshDir();
      const p = join(dir, "slot-0.lock");
      writeLock(p, { pid: await deadPid(), token: "dead-holder" });
      let shift = 0;
      let lockReads = 0;
      const mono = () => performance.now() + shift;
      const read = async (path: string) => {
        if (path === p) lockReads++;
        if (path.includes(".reap-")) throw Object.assign(new Error("scanner"), { code: "EBUSY" });
        return realRead(path);
      };
      const deps = fast(dir, { read, mono, claimHoldMaxMs: 100, unlinkRetries: 2 });
      expect(await acquireSlot({ max: 1, waitMs: 0, meta }, deps)).toEqual({ busy: true });
      const claim = reapClaimPath(p, "dead-holder");
      expect(existsSync(claim)).toBe(true); // ours, never confirmed
      // The seam clock decides the fence: far before it, or far past it.
      shift = past ? 1_000_000 : -1_000_000;
      releaseAllSlotsSync();
      expect(existsSync(claim)).toBe(past);
      // End the background watch (QA-1.4-38): move the seam clock past its end, let one poll see it, then no more reads.
      shift = 1_000_000;
      await sleep(300);
      lockReads = 0;
      await sleep(400);
      expect(lockReads).toBe(0);
      if (existsSync(claim)) rmSync(claim);
    }
  }, 20_000);

  it("a look within 2 heartbeats but past the padded gap limit (2 heartbeats minus both slacks) restarts the witness (QA-1.4-34)", async () => {
    // heartbeat 500 ms: maxGap 1 s, each look's slack 100 ms, so the padded limit is 800 ms.
    const run = async (step: number) => {
      const dir = freshDir();
      const p = join(dir, "slot-0.lock");
      writeLock(p, { pid: process.pid, token: "hung" }); // a live PID: not provably dead
      let shift = 0;
      // Frozen clocks (QA-1.4-39): only the shift moves them, so the gaps are exactly the step whatever the load.
      const wall0 = Date.now();
      const mono0 = performance.now();
      const deps = fast(dir, { heartbeatMs: WATCHER_HEARTBEAT_MS, staleMs: 1_000, now: () => wall0 + shift, mono: () => mono0 + shift });
      const out: string[] = [];
      for (let i = 0; i < 8; i++) {
        shift = i * step;
        const r = await acquireSlot({ max: 1, waitMs: 0, meta }, deps);
        out.push("busy" in r ? "BUSY" : "HELD");
        if (!("busy" in r)) {
          await r.release();
          break;
        }
      }
      shift += 1_000_000; // past any background watch's end
      await sleep(300);
      return out;
    };
    const within = await run(700); // inside the padded limit: the looks accumulate
    expect(within.at(-1), JSON.stringify(within)).toBe("HELD");
    const beyond = await run(900); // inside 2 heartbeats, past the padded limit: every look restarts
    expect(beyond.every((x) => x === "BUSY"), JSON.stringify(beyond)).toBe(true);
  }, 20_000);
});

describe("slot: fairness between processes (QA-1.4-9)", () => {
  it("a process that re-acquires in a tight loop cannot starve a waiter: FIFO tickets hand the slot over", async () => {
    const dir = freshDir();
    const log = join(dir, "log.txt");
    const stop = join(dir, "stop");
    writeFileSync(log, "");
    const a = runHolder({ dir, max: 1, waitMs: 20_000, holdMs: 150, log, id: "a", mode: "loop", stop });
    await waitUntil(() => readFileSync(log, "utf8").includes("exit"), 10_000); // A is cycling
    const t0 = Date.now();
    // Production backoff (250 ms -> 2 s): without fairness this poll almost never lands in A's gap.
    const r = await acquireSlot({ max: 1, waitMs: 5_000, meta }, { dir });
    const waited = Date.now() - t0;
    const now = () => performance.timeOrigin + performance.now();
    appendFileSync(log, `b enter ${now()}\n`);
    await sleep(100);
    appendFileSync(log, `b exit ${now()}\n`);
    await held(r).release();
    writeFileSync(stop, "");
    expect(await a.exit).toBe(0);
    expect(waited).toBeLessThan(5_000);
    expect(maxOverlap(intervals(log))).toBe(1);
  }, 30_000);

  it("a live older ticket makes a non-waiting caller defer even with a free slot; dead tickets, or ones not refreshed for 2 heartbeats, do not (QA-1.4-24)", async () => {
    const dir = freshDir();
    const ticket = (over: Record<string, unknown>) => {
      const p = join(dir, `wait-${String(1).padStart(15, "0")}-${randomUUID()}.ticket`);
      writeLock(p, { command: "wait", ...over });
      return p;
    };
    // A 500 ms heartbeat (ticket TTL 1 s): the live ticket stays live under CPU load (QA-1.4-33).
    const deps = fast(dir, { heartbeatMs: WATCHER_HEARTBEAT_MS, staleMs: 5_000 });
    const live = ticket({ pid: process.ppid, token: "w-live" });
    expect(await acquireSlot({ max: 1, waitMs: 0, meta }, deps)).toEqual({ busy: true });
    await held(await acquireSlot({ max: 2, waitMs: 0, meta }, deps)).release(); // 1 ticket ahead < max 2
    // Not refreshed for 2 heartbeats (1 s here) though younger than staleMs (5 s): dead, whatever its (live) PID.
    setAge(live, 1_500);
    await held(await acquireSlot({ max: 1, waitMs: 0, meta }, deps)).release();
    expect(existsSync(live)).toBe(false);
    const dead = ticket({ pid: await deadPid(), token: "w-dead" });
    await held(await acquireSlot({ max: 1, waitMs: 0, meta }, deps)).release();
    expect(existsSync(dead)).toBe(false);
    expect(readdirSync(dir).filter((n) => n.endsWith(".ticket"))).toEqual([]);
  }, 20_000);

  it("a waiter heartbeats its ticket while a slow attempt runs, so the others keep deferring to it (QA-1.4-24)", async () => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    const holder = held(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir, { heartbeatMs: 200 })));
    // Ticket TTL = 2 heartbeats = 400 ms, while each of the waiter's attempts takes over 1 s.
    const slow = async (path: string) => {
      if (path === p) await sleep(1_000);
      return realRead(path);
    };
    const waiting = acquireSlot({ max: 1, waitMs: 10_000, meta }, fast(dir, { heartbeatMs: 200, read: slow }));
    await waitUntil(() => readdirSync(dir).some((n) => n.endsWith(".ticket")));
    let ticketDeletes = 0;
    const unlink = async (path: string) => {
      if (path.endsWith(".ticket")) ticketDeletes++;
      await fsUnlink(path);
    };
    for (let i = 0; i < 8; i++) {
      expect(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir, { heartbeatMs: 200, unlink }))).toEqual({ busy: true });
      await sleep(150);
    }
    expect(ticketDeletes).toBe(0);
    await holder.release();
    held(await waiting);
  }, 20_000);
});

describe("slot: the holder learns that it lost the slot (QA-1.4-7)", () => {
  it.each([
    ["taken over by another token", (p: string) => writeLock(p, { token: "intruder" })],
    ["deleted", (p: string) => rmSync(p)],
  ])("lock %s: lost becomes true, onLost runs once, one warning; release leaves the path alone", async (_n, steal) => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    const warns: string[] = [];
    let calls = 0;
    const a = held(
      await acquireSlot({ max: 1, waitMs: 0, meta, onLost: () => calls++ }, fast(dir, { heartbeatMs: 50, logger: { warn: (m) => warns.push(m) } })),
    );
    expect(a.lost).toBe(false);
    steal(p);
    const after = tokenAt(p);
    await waitUntil(() => a.lost);
    await sleep(200);
    expect(calls).toBe(1);
    expect(warns.filter((w) => w.includes("slot lost"))).toHaveLength(1);
    await a.release();
    expect(tokenAt(p)).toBe(after);
  }, 20_000);
});

describe("slot: waiting", () => {
  it("waitMs=0 returns busy immediately", async () => {
    const dir = freshDir();
    held(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir)));
    const t0 = Date.now();
    expect(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir))).toEqual({ busy: true });
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it("an abort while waiting resolves busy promptly and leaks no timers", async () => {
    const dir = freshDir();
    held(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir, { heartbeatMs: 1_000_000 })));
    const timers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    const before = timers();
    const ac = new AbortController();
    const p = acquireSlot({ max: 1, waitMs: 60_000, meta, signal: ac.signal }, { dir, backoffMinMs: 2_000, backoffMaxMs: 2_000 });
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    ac.abort();
    expect(await p).toEqual({ busy: true });
    expect(Date.now() - t0).toBeLessThan(100);
    expect(timers()).toBeLessThanOrEqual(before);
    expect(await acquireSlot({ max: 1, waitMs: 1_000, meta, signal: AbortSignal.abort() }, fast(dir))).toEqual({ busy: true });
  }, 20_000);

  it("no busy-wait: a long wait wakes up a bounded number of times (exponential backoff)", async () => {
    const dir = freshDir();
    held(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir, { heartbeatMs: 1_000_000 })));
    let wakes = 0;
    // Plan values scaled by 1/10: 25 ms -> 200 ms over a 1 s wait (10 s at real scale).
    const r = await acquireSlot({ max: 1, waitMs: 1_000, meta }, { dir, backoffMinMs: 25, backoffMaxMs: 200, onAttempt: () => wakes++ });
    expect(r).toEqual({ busy: true });
    expect(wakes).toBeGreaterThan(2);
    expect(wakes).toBeLessThan(20);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])("a non-finite waitMs (%s) counts as 0: one attempt, then busy (QA-1.4-31)", async (waitMs) => {
    const dir = freshDir();
    held(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir, { heartbeatMs: 1_000_000 })));
    let wakes = 0;
    const t0 = Date.now();
    expect(await acquireSlot({ max: 1, waitMs, meta }, fast(dir, { onAttempt: () => wakes++ }))).toEqual({ busy: true });
    expect(wakes).toBe(1);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(readdirSync(dir).filter((n) => n.endsWith(".ticket"))).toEqual([]);
  });

  it("the production constants are the plan values: heartbeat 5 s, stale 30 s, backoff 250 ms -> 2 s (QA-1.4-15)", () => {
    expect(SLOT_DEFAULTS).toMatchObject({ heartbeatMs: 5_000, staleMs: 30_000, backoffMinMs: 250, backoffMaxMs: 2_000 });
  });

  it("backoff jitter never goes below the floor nor above the cap (QA-1.4-16)", async () => {
    const { backoffMinMs: lo, backoffMaxMs: hi } = SLOT_DEFAULTS;
    for (let k = 0; k < 12; k++) {
      for (const r of [0, 0.25, 0.5, 0.75, 0.999999]) {
        const d = nextBackoffMs(k, r, lo, hi);
        expect(d).toBeGreaterThanOrEqual(lo);
        expect(d).toBeLessThanOrEqual(hi);
      }
    }
    expect([nextBackoffMs(0, 0, lo, hi), nextBackoffMs(0, 0.999999, lo, hi), nextBackoffMs(1, 0, lo, hi), nextBackoffMs(3, 0, lo, hi)]).toEqual([250, 375, 500, 2_000]);
    // The wait loop uses it: with random = 0 no wake-up comes earlier than its backoff step, and no
    // sleep it asks for exceeds the cap. The wait is long and ended by an abort once 3 attempts are
    // stamped, so a loaded runner still sees 2 gaps (a short waitMs gave it only one attempt).
    const floor = 100;
    const cap = 800;
    const dir = freshDir();
    held(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir, { heartbeatMs: 1_000_000 })));
    const stamps: number[] = [];
    const ac = new AbortController();
    const sleeps: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      // Only the timers armed between the first and the third attempt: the loop's backoff sleeps.
      if (stamps.length >= 1 && stamps.length < 3) sleeps.push(ms ?? 0);
      return realSetTimeout(fn, ms);
    }) as typeof setTimeout);
    let r: Awaited<ReturnType<typeof acquireSlot>> | undefined;
    try {
      r = await acquireSlot(
        { max: 1, waitMs: 20_000, meta, signal: ac.signal },
        {
          dir,
          backoffMinMs: floor,
          backoffMaxMs: cap,
          random: () => 0,
          onAttempt: () => {
            stamps.push(performance.now());
            if (stamps.length >= 3) ac.abort();
          },
        },
      );
    } finally {
      spy.mockRestore();
    }
    expect(r).toEqual({ busy: true });
    expect(stamps).toHaveLength(3);
    // Wall-clock gaps: load only lengthens them, so the floor side is deterministic (5 ms timer slack).
    expect(stamps[1]! - stamps[0]!).toBeGreaterThanOrEqual(nextBackoffMs(0, 0, floor, cap) - 5);
    expect(stamps[2]! - stamps[1]!).toBeGreaterThanOrEqual(nextBackoffMs(1, 0, floor, cap) - 5);
    // The sleeps the loop asked for: exactly the two backoff steps, each within [floor, cap].
    expect(sleeps).toEqual([nextBackoffMs(0, 0, floor, cap), nextBackoffMs(1, 0, floor, cap)]);
    for (const ms of sleeps) {
      expect(ms).toBeGreaterThanOrEqual(floor);
      expect(ms).toBeLessThanOrEqual(cap);
    }
  }, 30_000);
});

describe("slot: unwritable temp dir", () => {
  it("falls back to an in-process semaphore with the same API and logs once", async () => {
    const base = freshDir();
    const file = join(base, "not-a-dir");
    writeFileSync(file, "");
    const dir = join(file, "verify-slots"); // mkdir under a file fails (ENOTDIR/ENOENT)
    const warns: string[] = [];
    const deps: SlotDeps = { dir, logger: { warn: (m) => warns.push(m) } };
    const a = held(await acquireSlot({ max: 1, waitMs: 0, meta }, deps));
    expect(await acquireSlot({ max: 1, waitMs: 0, meta }, deps)).toEqual({ busy: true });
    const waiting = acquireSlot({ max: 1, waitMs: 2_000, meta }, deps);
    await a.release();
    await a.release();
    const b = held(await waiting);
    const ac = new AbortController();
    const aborted = acquireSlot({ max: 1, waitMs: 5_000, meta, signal: ac.signal }, deps);
    ac.abort();
    expect(await aborted).toEqual({ busy: true });
    expect(await acquireSlot({ max: 1, waitMs: 50, meta }, deps)).toEqual({ busy: true });
    await b.release();
    held(await acquireSlot({ max: 1, waitMs: 0, meta }, deps));
    expect(warns.filter((w) => w.includes("in-process"))).toHaveLength(1);
  }, 20_000);

  it.each(["EPERM", "EBUSY"])(
    "a transient %s on the probe delete is not a verdict: exclusion with another process holds, no fallback, no leaked probe (QA-1.4-3)",
    async (code) => {
      const dir = freshDir();
      const h = runHolder({ dir, max: 1, waitMs: 1_000, mode: "hang" });
      expect(await h.waitFor(/^(HELD|BUSY)$/)).toBe("HELD");
      const warns: string[] = [];
      let probeDeletes = 0;
      const flaky = async (path: string) => {
        if (path.includes(".probe-") && probeDeletes++ === 0) throw Object.assign(new Error("scanner"), { code });
        await fsUnlink(path);
      };
      const deps = fast(dir, { unlink: flaky, logger: { warn: (m) => warns.push(m) } });
      expect(await acquireSlot({ max: 1, waitMs: 0, meta }, deps)).toEqual({ busy: true });
      expect(await acquireSlot({ max: 1, waitMs: 0, meta }, deps)).toEqual({ busy: true });
      expect(warns).toEqual([]);
      expect(probeDeletes).toBe(2); // one transient failure and its retry; then the verdict is memoized
      expect(readdirSync(dir).filter((n) => n.startsWith(".probe-"))).toEqual([]);
      killHard(h.child);
      await h.exit;
    },
    15_000,
  );

  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  it.skipIf(isRoot)("a read-only TEMP/TMPDIR (the default slot dir) falls back to the in-process semaphore and logs once (QA-1.4-12)", async () => {
    const ro = freshDir();
    const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
    const user = process.env.USERDOMAIN && process.env.USERNAME ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : userInfo().username;
    if (process.platform === "win32") {
      // Non-elevated works: deny this user write (add file / add subdir) on the dir and its children.
      const r = spawnSync("icacls", [ro, "/deny", `${user}:(OI)(CI)(W)`], { encoding: "utf8" });
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    } else chmodSync(ro, 0o555);
    try {
      process.env.TEMP = ro;
      process.env.TMP = ro;
      process.env.TMPDIR = ro;
      expect(tmpdir()).toBe(ro);
      const warns: string[] = [];
      const deps: SlotDeps = { logger: { warn: (m) => warns.push(m) } };
      const a = held(await acquireSlot({ max: 1, waitMs: 0, meta }, deps));
      expect(await acquireSlot({ max: 1, waitMs: 0, meta }, deps)).toEqual({ busy: true });
      await a.release();
      held(await acquireSlot({ max: 1, waitMs: 0, meta }, deps));
      expect(warns.filter((w) => w.includes("in-process"))).toHaveLength(1);
      expect(existsSync(join(ro, "opencode-model-router"))).toBe(false);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      if (process.platform === "win32") {
        const r = spawnSync("icacls", [ro, "/remove:d", user], { encoding: "utf8" });
        expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
      } else chmodSync(ro, 0o755);
    }
  });
});

describe("slot: file-system errors never reject (QA-1.4-22)", () => {
  it("a slot dir removed by a temp cleaner is re-created at use time, silently, on every path", async () => {
    const dir = join(freshDir(), "verify-slots");
    const warns: string[] = [];
    const deps = fast(dir, { logger: { warn: (m) => warns.push(m) } });
    await held(await acquireSlot({ max: 1, waitMs: 0, meta }, deps)).release();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    await held(await acquireSlot({ max: 1, waitMs: 0, meta }, deps)).release();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    await held(await acquireSlot({ max: 1, waitMs: 500, meta }, deps)).release(); // the ticket path re-creates it too
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    expect(await withSlot({ max: 1, waitMs: 0, meta }, async () => 7, deps)).toEqual({ value: 7 });
    expect(warns).toEqual([]);
  });

  it("an unexpected error (EIO) resolves busy with one warning; a dir that cannot be re-created is probed again", async () => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    writeLock(p, { pid: process.ppid, token: "other" });
    const read = async (path: string) => {
      if (path === p) throw Object.assign(new Error("io"), { code: "EIO" });
      return realRead(path);
    };
    const warns: string[] = [];
    const deps = fast(dir, { read, logger: { warn: (m) => warns.push(m) } });
    expect(await acquireSlot({ max: 1, waitMs: 0, meta }, deps)).toEqual({ busy: true });
    expect(await acquireSlot({ max: 1, waitMs: 300, meta }, deps)).toEqual({ busy: true });
    expect(warns.filter((w) => w.includes("file-system error"))).toHaveLength(1);

    // A file where the dir was: mkdir cannot re-create it. Busy now, and the next call probes
    // again and falls back like an unwritable dir.
    const gone = join(freshDir(), "verify-slots");
    const warns2: string[] = [];
    const deps2 = fast(gone, { logger: { warn: (m) => warns2.push(m) } });
    await held(await acquireSlot({ max: 1, waitMs: 0, meta }, deps2)).release();
    rmSync(gone, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    writeFileSync(gone, "");
    expect(await acquireSlot({ max: 1, waitMs: 0, meta }, deps2)).toEqual({ busy: true });
    held(await acquireSlot({ max: 1, waitMs: 0, meta }, deps2));
    expect(warns2.filter((w) => w.includes("in-process"))).toHaveLength(1);
  });

  it("an error after the exclusive create removes the new lock before busy is returned; if that fails too, this process's next look reaps it at once (QA-1.4-28)", async () => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    let failReads = 0;
    const read = async (path: string) => {
      if (path === p && failReads > 0) {
        failReads--;
        throw Object.assign(new Error("too many open files"), { code: "EMFILE" });
      }
      return realRead(path);
    };
    const warns: string[] = [];
    const deps = fast(dir, { read, logger: { warn: (m) => warns.push(m) } });
    failReads = 1; // the creator's re-read
    expect(await acquireSlot({ max: 1, waitMs: 0, meta }, deps)).toEqual({ busy: true });
    expect(warns.filter((w) => w.includes("file-system error"))).toHaveLength(1);
    expect(existsSync(p)).toBe(false);
    expect(claimsIn(dir)).toEqual([]);
    await held(await acquireSlot({ max: 1, waitMs: 0, meta }, deps)).release();

    failReads = 2; // the re-read, and the re-read under the claim that would remove it
    expect(await acquireSlot({ max: 1, waitMs: 0, meta }, deps)).toEqual({ busy: true });
    expect(tokenAt(p)).toBeDefined(); // left behind, with this process's live PID
    // Fresh, live PID, never witnessed: only its creator knows it is nobody's, and reaps it at once.
    held(await acquireSlot({ max: 1, waitMs: 0, meta }, deps));
    expect(claimsIn(dir)).toEqual([]);
  });
});

describe("slot: housekeeping (QA-1.4-25)", () => {
  it("removes orphaned probe, observation, legacy and claim files older than 1 h, and nothing that is young or still guards a victim", async () => {
    const dir = freshDir();
    const p0 = join(dir, "slot-0.lock");
    const p1 = join(dir, "slot-1.lock");
    const aged = (path: string, body: string) => {
      writeFileSync(path, body);
      setAge(path, 2 * 3_600_000);
      return path;
    };
    const claimBody = (over: Record<string, unknown>) =>
      JSON.stringify({ pid: process.ppid, hostname: hostname(), token: randomUUID(), startedAt: 0, cwd: "", command: "reap", ...over });
    const gone = [
      aged(join(dir, `.probe-${randomUUID()}`), ""),
      aged(`${p0}.seen-${"a".repeat(32)}`, "{}"),
      aged(`${p0}.reap`, "legacy"),
      aged(`${p0}.reap.dead-0`, "tombstone"),
      aged(reapClaimPath(p0, "gone-token"), claimBody({ target: "slot-0.lock", victim: "gone-token" })), // its victim is gone
      aged(reapClaimPath(p0, "corrupt:1:0"), ""), // empty: never held by anyone
    ];
    writeLock(p1, { pid: process.ppid, token: "v1" });
    const kept = [
      aged(reapClaimPath(p1, "v1"), claimBody({ target: "slot-1.lock", victim: "v1" })), // still guards v1
      aged(reapClaimPath(p0, "old-format"), claimBody({})), // says nothing about what it guards
      join(dir, `.probe-${randomUUID()}`),
      reapClaimPath(p0, "young"),
    ];
    writeFileSync(kept[2]!, "");
    writeFileSync(kept[3]!, claimBody({ target: "slot-0.lock", victim: "young" }));
    const warns: string[] = [];
    held(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir, { logger: { warn: (m) => warns.push(m) } })));
    expect(gone.filter((f) => existsSync(f))).toEqual([]);
    expect(kept.filter((f) => !existsSync(f))).toEqual([]);
    expect(existsSync(p1)).toBe(true);
    expect(warns).toEqual([]);
  });
});
