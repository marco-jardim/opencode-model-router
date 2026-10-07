/**
 * Seam-driven branch tests for src/verify/slot.ts: the error and edge paths that
 * the multi-process suite (slot.test.ts) cannot reach cheaply. Everything runs in
 * this process, against a fresh temp dir per test, with a frozen `mono` unless a
 * test needs time to pass. The fs/promises functions that slot.ts calls directly
 * (readFile, writeFile, open, mkdir, readdir, stat) are wrapped by a mock whose
 * `fail` hook can reject chosen calls; everything else goes to the real module.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  acquireSlot,
  exitReleaseFailures,
  reapClaimPath,
  releaseAllSlotsSync,
  withSlot,
  type FileSnapshot,
  type SlotDeps,
  type SlotHandle,
  type SlotResult,
} from "../../src/verify/slot";

type Fail = (op: string, path: string, flag: unknown) => { err: unknown } | undefined;
const H = vi.hoisted(() => ({ fail: undefined as Fail | undefined }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  function gate<A extends unknown[], R>(op: string, f: (...a: A) => Promise<R>): (...a: A) => Promise<R> {
    return (...a: A) => {
      const r = H.fail?.(op, String(a[0]), a[1]);
      return r ? Promise.reject(r.err) : f(...a);
    };
  }
  return {
    ...real,
    readFile: gate("readFile", real.readFile),
    writeFile: gate("writeFile", real.writeFile),
    open: gate("open", real.open),
    mkdir: gate("mkdir", real.mkdir),
    readdir: gate("readdir", real.readdir),
    stat: gate("stat", real.stat),
  };
});

const HOST = "h-branches";
const ME = 4242;
const DEAD = 999_999;
const MONO = 1_000_000;
const meta = { cwd: "/x", command: "vitest" };

const dirs: string[] = [];
const handles: SlotHandle[] = [];
let warns: string[] = [];

afterEach(async () => {
  H.fail = undefined;
  try {
    for (const h of handles.splice(0)) await h.release();
  } finally {
    warns = [];
    // Retry a busy entry (EBUSY/EPERM on Windows); one stuck directory must not strand the rest.
    for (const d of dirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {
        // Best effort: left to the OS temp cleanup.
      }
    }
  }
});

function fresh(): string {
  const d = mkdtempSync(join(tmpdir(), "omr-slotb-"));
  dirs.push(d);
  return d;
}
const lockOf = (dir: string, i = 0) => join(dir, `slot-${i}.lock`);
const err = (code: string) => Object.assign(new Error(code), { code });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitUntil(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await sleep(5);
  }
}
/** The default read of slot.ts, without the mocked module. */
async function syncRead(path: string): Promise<FileSnapshot> {
  const st = statSync(path);
  return { text: readFileSync(path, "utf8"), mtimeMs: st.mtimeMs, size: st.size };
}
async function realUnlink(path: string): Promise<void> {
  unlinkSync(path);
}
function deps(dir: string, extra: SlotDeps = {}): SlotDeps {
  return {
    dir,
    logger: { warn: (m: string) => void warns.push(m) },
    hostname: HOST,
    pid: ME,
    isPidAlive: (p) => p !== DEAD,
    mono: () => MONO,
    heartbeatMs: 1_000,
    staleMs: 5_000,
    corruptGraceMs: 200,
    claimHoldMaxMs: 5_000,
    backoffMinMs: 1,
    backoffMaxMs: 5,
    unlinkRetries: 1,
    unlinkRetryMs: 1,
    read: syncRead,
    unlink: realUnlink,
    ...extra,
  };
}
const opts = (waitMs = 0, extra: { max?: number; signal?: AbortSignal; onLost?: () => void } = {}) => ({ max: 1, waitMs, meta, ...extra });
function held(r: SlotResult): SlotHandle {
  if ("busy" in r) throw new Error("expected a slot, got busy");
  handles.push(r);
  return r;
}
function plant(path: string, over: Record<string, unknown>, ageMs = 0): void {
  writeFileSync(path, JSON.stringify({ pid: ME, hostname: HOST, token: "other", startedAt: 0, cwd: "", command: "", ...over }));
  if (ageMs) {
    const t = new Date(Date.now() - ageMs);
    utimesSync(path, t, t);
  }
}
function tokenAt(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const v: unknown = JSON.parse(readFileSync(path, "utf8"));
  return typeof v === "object" && v !== null && "token" in v ? String(v.token) : undefined;
}
/** The observation sidecar of a slot lock with identity `id`, as slot.ts names it. */
function seenOf(lock: string, id: string): string {
  return `${lock}.seen-${createHash("sha256").update(`${basename(lock)}\n${id}\n${HOST}`).digest("hex").slice(0, 32)}`;
}
const ticketName = (startedAt: number) => `wait-${String(startedAt).padStart(15, "0")}-${randomUUID()}.ticket`;
const count = (msg: string) => warns.filter((w) => w.includes(msg)).length;
const BUSY = { busy: true };

describe("slot branches: lock and sidecar parsing", () => {
  it("a lock holding non-object JSON is corrupt; missing startedAt/cwd/command default and the lock is still judged", async () => {
    const dir = fresh();
    const p = lockOf(dir);
    writeFileSync(p, "null");
    expect(await acquireSlot(opts(), deps(dir))).toEqual(BUSY); // corrupt and young: kept
    writeFileSync(p, JSON.stringify({ pid: DEAD, hostname: HOST, token: "t1" }));
    held(await acquireSlot(opts(), deps(dir)));
    expect(tokenAt(p)).not.toBe("t1");
  });

  it("malformed observation sidecars (non-object, no key, bad views) restart the record", async () => {
    const dir = fresh();
    const p = lockOf(dir);
    plant(p, { token: "live" });
    const seen = seenOf(p, "live");
    for (const text of ["null", JSON.stringify({ key: 1, views: [] }), JSON.stringify({ key: "x", views: [null, { boot: 1 }, 3] })]) {
      writeFileSync(seen, text);
      expect(await acquireSlot(opts(), deps(dir))).toEqual(BUSY);
      const rec: unknown = JSON.parse(readFileSync(seen, "utf8"));
      expect(rec).toMatchObject({ key: expect.stringContaining("live@"), views: [expect.any(Object)] });
    }
  });
});

describe("slot branches: observation and sidecar I/O is advisory", () => {
  it("a failing sidecar read warns once per dir (coded or not); a transient one is silent", async () => {
    const eio = fresh();
    plant(lockOf(eio), { token: "live" });
    H.fail = (op, path) => (op === "readFile" && path.includes(".seen-") ? { err: err("EIO") } : undefined);
    expect(await acquireSlot(opts(), deps(eio))).toEqual(BUSY);
    expect(await acquireSlot(opts(), deps(eio))).toEqual(BUSY);
    expect(count("observation I/O failed")).toBe(1);

    const busy = fresh();
    plant(lockOf(busy), { token: "live" });
    H.fail = (op, path) => (op === "readFile" && path.includes(".seen-") ? { err: err("EBUSY") } : undefined);
    expect(await acquireSlot(opts(), deps(busy))).toEqual(BUSY);
    expect(count("observation I/O failed")).toBe(1);

    const odd = fresh();
    plant(lockOf(odd), { token: "live" });
    H.fail = (op, path) => (op === "readFile" && path.includes(".seen-") ? { err: "boom" } : undefined);
    expect(await acquireSlot(opts(), deps(odd))).toEqual(BUSY);
    expect(count("observation I/O failed")).toBe(2);
  });

  it("a failing sidecar write warns unless it is ENOENT or transient", async () => {
    const a = fresh();
    plant(lockOf(a), { token: "live" });
    H.fail = (op, path) => (op === "writeFile" && path.includes(".seen-") ? { err: err("EIO") } : undefined);
    expect(await acquireSlot(opts(), deps(a))).toEqual(BUSY);
    expect(count("observation I/O failed")).toBe(1);

    const b = fresh();
    plant(lockOf(b), { token: "live" });
    for (const code of ["EBUSY", "ENOENT"]) {
      H.fail = (op, path) => (op === "writeFile" && path.includes(".seen-") ? { err: err(code) } : undefined);
      expect(await acquireSlot(opts(), deps(b))).toEqual(BUSY);
    }
    expect(count("observation I/O failed")).toBe(1);
  });

  it("a failing sidecar delete after a reap warns unless transient; the slot is granted either way", async () => {
    const a = fresh();
    plant(lockOf(a), { pid: DEAD, token: "dead" });
    const failSeen = (code: string) => async (path: string) => {
      if (path.includes(".seen-")) throw err(code);
      unlinkSync(path);
    };
    held(await acquireSlot(opts(), deps(a, { unlink: failSeen("EIO") })));
    expect(count("observation I/O failed")).toBe(1);

    const b = fresh();
    plant(lockOf(b), { pid: DEAD, token: "dead" });
    held(await acquireSlot(opts(), deps(b, { unlink: failSeen("EBUSY") })));
    expect(count("observation I/O failed")).toBe(1);
  });
});

describe("slot branches: reaping under claims", () => {
  it("a lock that stays unreadable after a failed create is left alone", async () => {
    const dir = fresh();
    const p = lockOf(dir);
    plant(p, { pid: DEAD, token: "dead" });
    const read = async (path: string) => {
      if (path === p) throw err("EBUSY");
      return syncRead(path);
    };
    expect(await acquireSlot(opts(), deps(dir, { read }))).toEqual(BUSY);
    expect(tokenAt(p)).toBe("dead");
  });

  it("a new lock whose re-read stays unreadable (a scanner) is trusted: the heartbeat re-checks it", async () => {
    const dir = fresh();
    const p = lockOf(dir);
    let scans = 2; // the re-read and its one retry (unlinkRetries: 1)
    const read = async (path: string) => {
      if (path === p && scans-- > 0) throw err("EBUSY");
      return syncRead(path);
    };
    const h = held(await acquireSlot(opts(), deps(dir, { read })));
    expect(scans).toBe(0);
    expect(existsSync(p)).toBe(true);
    await h.release();
    expect(existsSync(p)).toBe(false);
  });

  it("a claimer past its hold deadline deletes nothing and does not drop its claim late", async () => {
    const dir = fresh();
    const p = lockOf(dir);
    plant(p, { pid: DEAD, token: "dead" });
    let t = MONO;
    expect(await acquireSlot(opts(), deps(dir, { mono: () => (t += 10_000) }))).toEqual(BUSY);
    expect(tokenAt(p)).toBe("dead");
    expect(count("claim held too long")).toBeGreaterThanOrEqual(2);
    expect(existsSync(reapClaimPath(p, "dead"))).toBe(true);
  });

  it("an unlink that reports ENOENT counts as gone; an uncoded unlink failure is a failed delete", async () => {
    const dir = fresh();
    const p = lockOf(dir);
    plant(p, { pid: DEAD, token: "dead" });
    let mode: unknown = err("ENOENT");
    const unlink = async (path: string) => {
      if (path === p) throw mode;
      unlinkSync(path);
    };
    expect(await acquireSlot(opts(), deps(dir, { unlink }))).toEqual(BUSY);
    expect(tokenAt(p)).toBe("dead");
    mode = "boom";
    expect(await acquireSlot(opts(), deps(dir, { unlink }))).toEqual(BUSY);
    expect(count("could not delete lock file")).toBe(1);
    expect(tokenAt(p)).toBe("dead");
  });

  it("a claim create that fails with ENOENT is gone; any other error propagates to busy", async () => {
    const a = fresh();
    plant(lockOf(a), { pid: DEAD, token: "dead" });
    H.fail = (op, path, flag) => (op === "open" && flag === "wx" && path.includes(".reap-") ? { err: err("ENOENT") } : undefined);
    expect(await acquireSlot(opts(), deps(a))).toEqual(BUSY);
    expect(warns).toEqual([]);

    const b = fresh();
    plant(lockOf(b), { pid: DEAD, token: "dead" });
    H.fail = (op, path, flag) => (op === "open" && flag === "wx" && path.includes(".reap-") ? { err: err("EIO") } : undefined);
    expect(await acquireSlot(opts(), deps(b))).toEqual(BUSY);
    expect(count("file-system error, reporting busy")).toBe(1);
  });

  it("a claim path that is taken but gone when read is free: both rounds end contended", async () => {
    const dir = fresh();
    const p = lockOf(dir);
    plant(p, { pid: DEAD, token: "dead" });
    H.fail = (op, path, flag) => (op === "open" && flag === "wx" && path.includes(".reap-") ? { err: err("EEXIST") } : undefined);
    expect(await acquireSlot(opts(), deps(dir))).toEqual(BUSY);
    expect(tokenAt(p)).toBe("dead");
  });

  it("a dead claimer's claim that cannot be deleted leaves the target alone", async () => {
    const dir = fresh();
    const p = lockOf(dir);
    plant(p, { pid: DEAD, token: "dead" });
    const claim = reapClaimPath(p, "dead");
    plant(claim, { pid: DEAD, token: "c1", command: "reap", target: "slot-0.lock", victim: "dead" });
    const unlink = async (path: string) => {
      if (path === claim) throw err("EIO");
      unlinkSync(path);
    };
    expect(await acquireSlot(opts(), deps(dir, { unlink }))).toEqual(BUSY);
    expect(tokenAt(p)).toBe("dead");
    expect(tokenAt(claim)).toBe("c1");
  });

  it("a corrupt claim is judged by the corrupt grace and is not inert at first sight", async () => {
    const dir = fresh();
    const p = lockOf(dir);
    plant(p, { pid: DEAD, token: "dead" });
    const claim = reapClaimPath(p, "dead");
    writeFileSync(claim, "garbage");
    expect(await acquireSlot(opts(), deps(dir))).toEqual(BUSY);
    expect(readFileSync(claim, "utf8")).toBe("garbage");
  });

  it("an unconfirmed own claim whose drop fails stays remembered, and is dropped at a later look", async () => {
    const dir = fresh();
    const p = lockOf(dir);
    plant(p, { pid: DEAD, token: "dead" });
    const claim = reapClaimPath(p, "dead");
    const scanned = async (path: string) => {
      if (path === claim) throw err("EBUSY");
      return syncRead(path);
    };
    expect(await acquireSlot(opts(), deps(dir, { read: scanned }))).toEqual(BUSY);
    expect(existsSync(claim)).toBe(true);

    const unlink = async (path: string) => {
      if (path === claim) throw err("EIO");
      unlinkSync(path);
    };
    expect(await acquireSlot(opts(), deps(dir, { unlink }))).toEqual(BUSY);
    expect(count("could not delete lock file")).toBe(1);
    expect(existsSync(claim)).toBe(true);

    held(await acquireSlot(opts(), deps(dir)));
    expect(tokenAt(p)).not.toBe("dead");
  });

  it("this process's stray lock is recognised only by its token: a corrupt or foreign file there is judged normally", async () => {
    const dir = fresh();
    const p = lockOf(dir);
    H.fail = undefined;
    const broken = async (path: string) => {
      if (path.startsWith(p)) throw err("EIO");
      return syncRead(path);
    };
    // The re-read after the create fails, and so does the claim that would remove the new lock.
    expect(await acquireSlot(opts(), deps(dir, { read: broken }))).toEqual(BUSY);
    expect(existsSync(p)).toBe(true);
    writeFileSync(p, "garbage");
    expect(await acquireSlot(opts(), deps(dir))).toEqual(BUSY);
    plant(p, { token: "foreign" });
    expect(await acquireSlot(opts(), deps(dir))).toEqual(BUSY);
    expect(tokenAt(p)).toBe("foreign");
  });
});

describe("slot branches: waiter tickets", () => {
  it("a ticket that vanishes before it is read, or is unreadable, or is corrupt, is judged accordingly", async () => {
    const gone = fresh();
    writeFileSync(join(gone, ticketName(1)), "{}");
    const vanishing = async (path: string) => {
      if (path.endsWith(".ticket")) throw err("ENOENT");
      return syncRead(path);
    };
    held(await acquireSlot(opts(), deps(gone, { read: vanishing })));

    const scanned = fresh();
    writeFileSync(join(scanned, ticketName(1)), "{}");
    const locked = async (path: string) => {
      if (path.endsWith(".ticket")) throw err("EBUSY");
      return syncRead(path);
    };
    expect(await acquireSlot(opts(), deps(scanned, { read: locked }))).toEqual(BUSY);
    expect(existsSync(lockOf(scanned))).toBe(false);

    const corrupt = fresh();
    const t = join(corrupt, ticketName(1));
    writeFileSync(t, "garbage");
    expect(await acquireSlot(opts(), deps(corrupt, { corruptGraceMs: 30_000 }))).toEqual(BUSY);
    const old = new Date(Date.now() - 60_000);
    utimesSync(t, old, old);
    held(await acquireSlot(opts(), deps(corrupt, { corruptGraceMs: 30_000 })));
    expect(existsSync(t)).toBe(false);
  });

  it("a dead ticket that cannot be deleted warns once (ENOENT is silent) and the caller still tries", async () => {
    const a = fresh();
    const t = join(a, ticketName(1));
    plant(t, { pid: DEAD, command: "wait" });
    const failTicket = (e: unknown) => async (path: string) => {
      if (path.endsWith(".ticket")) throw e;
      unlinkSync(path);
    };
    held(await acquireSlot(opts(), deps(a, { unlink: failTicket(err("EIO")) })));
    expect(count("waiter ticket I/O failed")).toBe(1);

    const b = fresh();
    plant(join(b, ticketName(1)), { pid: DEAD, command: "wait" });
    held(await acquireSlot(opts(), deps(b, { unlink: failTicket(err("ENOENT")) })));
    expect(count("waiter ticket I/O failed")).toBe(1);
  });

  it("many live tickets: the per-process sightings map is bounded", async () => {
    const dir = fresh();
    for (let i = 0; i < 260; i++) plant(join(dir, ticketName(1 + i)), { command: "wait", token: `t${i}` });
    held(await acquireSlot(opts(0, { max: 300 }), deps(dir)));
  });

  it("an unlistable dir lets the caller try, and says so once per dir", async () => {
    const a = fresh();
    H.fail = (op, path) => (op === "readdir" && path === a ? { err: "boom" } : undefined);
    held(await acquireSlot(opts(), deps(a)));
    await handles.splice(0)[0]?.release();
    held(await acquireSlot(opts(), deps(a)));
    expect(count("waiter ticket I/O failed")).toBe(1);

    const b = fresh();
    H.fail = (op, path) => (op === "readdir" && path === b ? { err: err("EIO") } : undefined);
    held(await acquireSlot(opts(), deps(b)));
    expect(count("waiter ticket I/O failed")).toBe(2);
  });

  it("a ticket write that finds the name taken is fine; any other failure warns and the caller still tries", async () => {
    const a = fresh();
    H.fail = (op, path) => (op === "writeFile" && path.endsWith(".ticket") ? { err: err("EEXIST") } : undefined);
    held(await acquireSlot(opts(1_000), deps(a)));
    expect(warns).toEqual([]);

    const b = fresh();
    H.fail = (op, path) => (op === "writeFile" && path.endsWith(".ticket") ? { err: err("EIO") } : undefined);
    held(await acquireSlot(opts(1_000), deps(b)));
    expect(count("waiter ticket I/O failed")).toBe(1);
  });

  it("a ticket that cannot be deleted at the end of the wait is reported", async () => {
    const dir = fresh();
    const unlink = async (path: string) => {
      if (path.endsWith(".ticket")) throw "boom";
      unlinkSync(path);
    };
    held(await acquireSlot(opts(1_000), deps(dir, { unlink })));
    expect(count("could not delete file")).toBe(1);
  });

  it("ticket refresh failures: ENOENT re-creates the ticket, other errors warn, a refresh in flight at the end is awaited", async () => {
    const a = fresh();
    plant(lockOf(a), { token: "live" });
    const ac = new AbortController();
    let attempts = 0;
    const utimes = async (path: string) => {
      if (path.endsWith(".ticket")) throw err("ENOENT");
    };
    const r = await acquireSlot(opts(60_000, { signal: ac.signal }), deps(a, { utimes, mono: () => performance.now(), onAttempt: () => void (++attempts >= 3 && ac.abort()) }));
    expect(r).toEqual(BUSY);
    expect(readdirSync(a).filter((n) => n.endsWith(".ticket"))).toEqual([]);

    const b = fresh();
    plant(lockOf(b), { token: "live" });
    const ac2 = new AbortController();
    let calls = 0;
    const slowFail = (path: string) =>
      new Promise<void>((_, reject) => {
        if (!path.endsWith(".ticket")) return reject(err("EINVAL"));
        calls++;
        if (calls === 1) {
          ac2.abort();
          setTimeout(() => reject(err("ENOENT")), 30);
        } else reject(err("EIO"));
      });
    const r2 = await acquireSlot(opts(60_000, { signal: ac2.signal }), deps(b, { utimes: slowFail, heartbeatMs: 10, backoffMinMs: 10, backoffMaxMs: 10, mono: () => performance.now() }));
    expect(r2).toEqual(BUSY);
    expect(readdirSync(b).filter((n) => n.endsWith(".ticket"))).toEqual([]);

    const c = fresh();
    plant(lockOf(c), { token: "live" });
    const warned = count("waiter ticket I/O failed");
    const ac3 = new AbortController();
    let n3 = 0;
    const eio = async (path: string) => {
      if (path.endsWith(".ticket")) throw err("EIO");
    };
    const r3 = await acquireSlot(opts(60_000, { signal: ac3.signal }), deps(c, { utimes: eio, mono: () => performance.now(), onAttempt: () => void (++n3 >= 3 && ac3.abort()) }));
    expect(r3).toEqual(BUSY);
    expect(count("waiter ticket I/O failed")).toBe(warned + 1);
  });
});

describe("slot branches: exit-time release", () => {
  it("covers a held lock that is gone, foreign, a directory, or whose dir is gone", async () => {
    releaseAllSlotsSync(); // nothing left over from earlier tests
    const before = exitReleaseFailures;
    const gone = fresh();
    held(await acquireSlot(opts(), deps(gone)));
    unlinkSync(lockOf(gone));
    releaseAllSlotsSync();
    expect(readdirSync(gone).filter((n) => n.includes(".reap-"))).toEqual([]);
    expect(exitReleaseFailures).toBe(before);

    const foreign = fresh();
    held(await acquireSlot(opts(), deps(foreign)));
    plant(lockOf(foreign), { token: "foreign" });
    releaseAllSlotsSync();
    expect(tokenAt(lockOf(foreign))).toBe("foreign");

    const isDir = fresh();
    held(await acquireSlot(opts(), deps(isDir)));
    unlinkSync(lockOf(isDir));
    mkdirSync(lockOf(isDir));
    releaseAllSlotsSync();
    expect(exitReleaseFailures).toBe(before + 1);
    expect(readdirSync(isDir).filter((n) => n.includes(".reap-"))).toEqual([]);
    rmSync(lockOf(isDir), { recursive: true, maxRetries: 10, retryDelay: 200 });

    const noDir = fresh();
    held(await acquireSlot(opts(), deps(noDir)));
    rmSync(noDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    releaseAllSlotsSync();
    expect(exitReleaseFailures).toBe(before + 2);
  });

  it("while the async release holds its claim, the exit hook deletes the lock and the claim itself", async () => {
    const dir = fresh();
    const p = lockOf(dir);
    let unblock: (() => void) | undefined;
    let blocked = false;
    const unlink = (path: string) =>
      path === p && !blocked
        ? new Promise<void>((r) => {
            blocked = true;
            unblock = r;
          })
        : realUnlink(path);
    const h = await acquireSlot(opts(), deps(dir, { unlink }));
    if ("busy" in h) throw new Error("busy");
    const releasing = h.release();
    await waitUntil(() => blocked);
    releaseAllSlotsSync();
    expect(existsSync(p)).toBe(false);
    expect(readdirSync(dir).filter((n) => n.includes(".reap-"))).toEqual([]);
    unblock?.();
    await releasing;
  });

  it("the exit hook skips a vanished ticket and reports one it cannot delete", async () => {
    releaseAllSlotsSync();
    const before = exitReleaseFailures;
    for (const replaceWithDir of [false, true]) {
      const dir = fresh();
      plant(lockOf(dir), { token: "live" });
      const ac = new AbortController();
      let n = 0;
      const onAttempt = () => {
        if (++n !== 2) return;
        const t = readdirSync(dir).find((x) => x.endsWith(".ticket"));
        if (t === undefined) throw new Error("no ticket");
        unlinkSync(join(dir, t));
        if (replaceWithDir) mkdirSync(join(dir, t));
        releaseAllSlotsSync();
        ac.abort();
      };
      expect(await acquireSlot(opts(60_000, { signal: ac.signal }), deps(dir, { onAttempt, mono: () => performance.now() }))).toEqual(BUSY);
      expect(exitReleaseFailures).toBe(before + (replaceWithDir ? 1 : 0));
    }
  });
});

describe("slot branches: heartbeat and release", () => {
  it("heartbeat utimes failures: warned once, transient retried, uncoded tolerated, ENOENT is a loss", async () => {
    const dir = fresh();
    let mode: unknown = err("EIO");
    let calls = 0;
    let lostCalls = 0;
    const utimes = async () => {
      calls++;
      if (mode !== undefined) throw mode;
    };
    const h = held(await acquireSlot(opts(0, { onLost: () => void lostCalls++ }), deps(dir, { heartbeatMs: 10, utimes })));
    await waitUntil(() => calls >= 3);
    expect(count("heartbeat failed")).toBe(1);
    mode = err("EBUSY");
    let mark = calls;
    await waitUntil(() => calls >= mark + 4);
    mode = "boom";
    mark = calls;
    await waitUntil(() => calls >= mark + 2);
    mode = undefined; // a success resets the once-only warning
    mark = calls;
    await waitUntil(() => calls >= mark + 1);
    mode = err("ENOENT");
    await waitUntil(() => h.lost);
    expect(lostCalls).toBe(1);
    expect(count("slot lost")).toBe(1);
  });

  it("a release that begins while the heartbeat waits to retry, or while utimes fails, never touches the file again", async () => {
    const a = fresh();
    let ha: SlotHandle | undefined;
    let first = true;
    const retryThenRelease = async () => {
      if (first) {
        first = false;
        setTimeout(() => void ha?.release(), 5);
      }
      throw err("EBUSY");
    };
    ha = held(await acquireSlot(opts(), deps(a, { heartbeatMs: 10, unlinkRetries: 3, unlinkRetryMs: 40, utimes: retryThenRelease })));
    await waitUntil(() => !first);
    await ha.release();
    expect(existsSync(lockOf(a))).toBe(false);
    expect(ha.lost).toBe(false);

    const b = fresh();
    let hb: SlotHandle | undefined;
    let released: Promise<void> | undefined;
    const releaseThenGone = async () => {
      released ??= hb?.release();
      throw err("ENOENT");
    };
    hb = held(await acquireSlot(opts(), deps(b, { heartbeatMs: 10, utimes: releaseThenGone })));
    await waitUntil(() => released !== undefined);
    await released;
    expect(hb.lost).toBe(false);
    expect(existsSync(lockOf(b))).toBe(false);
  });

  it("a heartbeat whose read throws is logged, uncoded errors included", async () => {
    const dir = fresh();
    const p = lockOf(dir);
    let broken = false;
    const read = async (path: string) => {
      if (broken && path === p) throw "boom";
      return syncRead(path);
    };
    const h = held(await acquireSlot(opts(), deps(dir, { heartbeatMs: 10, read })));
    broken = true;
    await waitUntil(() => count("heartbeat failed") >= 1);
    broken = false;
    expect(h.lost).toBe(false);
  });

  it("a release that throws is retried; a file found gone by the heartbeat meanwhile ends the release, not as a loss", async () => {
    const dir = fresh();
    const p = lockOf(dir);
    let lockReads = 0;
    const read = async (path: string) => {
      if (path === p) lockReads++;
      return syncRead(path);
    };
    const h = held(await acquireSlot(opts(), deps(dir, { heartbeatMs: 20, read })));
    H.fail = (op, path, flag) => (op === "open" && flag === "wx" && path.includes(".reap-") ? { err: "boom" } : undefined);
    await h.release();
    expect(count("release failed")).toBe(1);
    expect(count("release incomplete")).toBe(1);
    unlinkSync(p);
    // The heartbeat reads the lock every tick until it finds it gone while the release is deferred; then it stops.
    let settled = -1;
    for (let i = 0; i < 100 && settled !== lockReads; i++) {
      settled = lockReads;
      await sleep(100);
    }
    expect(lockReads).toBe(settled);
    expect(h.lost).toBe(false);
    expect(count("release gave up")).toBe(0);
  });
});

describe("slot branches: waiting, watching and the dir", () => {
  it("an abort seen after an attempt: a granted slot is given back, a busy one is reported busy", async () => {
    const a = fresh();
    const ac = new AbortController();
    expect(await acquireSlot(opts(0, { signal: ac.signal }), deps(a, { onAttempt: () => ac.abort() }))).toEqual(BUSY);
    expect(existsSync(lockOf(a))).toBe(false);

    const b = fresh();
    plant(lockOf(b), { token: "live" });
    const ac2 = new AbortController();
    expect(await acquireSlot(opts(1_000, { signal: ac2.signal }), deps(b, { onAttempt: () => ac2.abort() }))).toEqual(BUSY);
  });

  it("withSlot reports busy without running fn", async () => {
    const dir = fresh();
    plant(lockOf(dir), { token: "live" });
    let ran = false;
    expect(await withSlot(opts(), async () => (ran = true), deps(dir))).toEqual(BUSY);
    expect(ran).toBe(false);
  });

  it("the background watch keeps looking through an unreadable lock and logs a failing look", async () => {
    const dir = fresh();
    const p = lockOf(dir);
    plant(p, { hostname: "elsewhere", token: "far" }, 3_600_000);
    let n = 0;
    const read = async (path: string) => {
      if (path === p) {
        n++;
        if (n === 2) throw err("EBUSY");
        if (n >= 3) throw "boom";
      }
      return syncRead(path);
    };
    expect(await acquireSlot(opts(), deps(dir, { heartbeatMs: 10, read }))).toEqual(BUSY);
    await waitUntil(() => count("background reclaim failed") === 1);
    expect(n).toBe(3);
  });

  it("an unwritable dir degrades to the in-process semaphore, whose release hands over to a waiter", async () => {
    const dir = fresh();
    H.fail = (op, path) => (op === "mkdir" && path === dir ? { err: err("EROFS") } : undefined);
    const h1 = held(await acquireSlot(opts(), deps(dir)));
    const second = acquireSlot(opts(10_000), deps(dir));
    await sleep(20); // let the second caller queue behind the first
    await h1.release();
    held(await second);
    expect(count("in-process semaphore")).toBe(1);
  });

  it("uncoded errors from the dir probe and from re-creating the dir resolve busy with a warning", async () => {
    const a = fresh();
    H.fail = (op, path) => (op === "mkdir" && path === a ? { err: "boom" } : undefined);
    expect(await acquireSlot(opts(), deps(a))).toEqual(BUSY);
    expect(count("file-system error, reporting busy")).toBe(1);

    H.fail = undefined;
    const b = fresh();
    const h = held(await acquireSlot(opts(), deps(b)));
    await h.release();
    rmSync(b, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    H.fail = (op, path) => (op === "mkdir" && path === b ? { err: "boom" } : undefined);
    expect(await acquireSlot(opts(), deps(b))).toEqual(BUSY);
    expect(count("could not re-create the slot dir")).toBe(1);
  });

  it("housekeeping survives stat and unlink failures and leaves an unreadable claim alone", async () => {
    const dir = fresh();
    const probe = (tag: string) => {
      const name = `.probe-${randomUUID()}`;
      writeFileSync(join(dir, name), tag);
      return name;
    };
    const statEio = probe("a");
    const statGone = probe("b");
    const statBusy = probe("c");
    const unlinkEio = probe("d");
    const unlinkGone = probe("e");
    const claim = `slot-0.lock.reap-${"a".repeat(32)}`;
    writeFileSync(join(dir, claim), "{}");
    const old = new Date(Date.now() - 2 * 3_600_000);
    for (const n of [unlinkEio, unlinkGone, claim]) utimesSync(join(dir, n), old, old);
    H.fail = (op, path) => {
      if (op !== "stat") return undefined;
      const n = basename(path);
      if (n === statEio) return { err: err("EIO") };
      if (n === statGone) return { err: err("ENOENT") };
      if (n === statBusy) return { err: err("EBUSY") };
      return undefined;
    };
    const unlink = async (path: string) => {
      const n = basename(path);
      if (n === unlinkEio) throw err("EIO");
      if (n === unlinkGone) throw err("ENOENT");
      unlinkSync(path);
    };
    const read = async (path: string) => {
      if (basename(path) === claim) throw err("EBUSY");
      return syncRead(path);
    };
    held(await acquireSlot(opts(), deps(dir, { unlink, read })));
    expect(count("housekeeping I/O failed")).toBe(1);
    for (const n of [statEio, statGone, statBusy, unlinkEio, unlinkGone, claim]) expect(existsSync(join(dir, n))).toBe(true);
  });
});
