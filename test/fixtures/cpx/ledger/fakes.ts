// Seams for the ledger store tests: an injected clock (no fixed sleeps), a process-info stub and an interceptable FileSystem.
import type { Clock, FileSystem, FsStat } from "../../../../src/executor/types.js";
import type { LedgerProcessInfo } from "../../../../src/executor/ledger.js";

/** Timers with a delay of at least this many ms are held until `fire()` (heartbeats); shorter ones are retry sleeps and run at once. */
const HELD_MIN_MS = 1_000;

/**
 * A manual clock. `now` only moves with `advance`/`set`; retry sleeps (short timers) resolve immediately without real waiting;
 * the heartbeat timer is held until the test calls `fire()`.
 */
export class FakeClock implements Clock {
  private ms: number;
  private nextId = 1;
  private readonly held = new Map<number, () => void>();
  private rand = 0;
  /** Delays of every short sleep requested (a retry that slept shows up here). */
  readonly sleeps: number[] = [];

  constructor(startIso = "2026-10-11T00:00:00.000Z") {
    this.ms = Date.parse(startIso);
  }

  now(): number {
    return this.ms;
  }
  iso(ms?: number): string {
    return new Date(ms ?? this.ms).toISOString();
  }
  advance(ms: number): void {
    this.ms += ms;
  }
  set(ms: number): void {
    this.ms = ms;
  }
  setTimer(ms: number, fn: () => void): { readonly id: number } {
    const id = this.nextId++;
    if (ms >= HELD_MIN_MS) {
      this.held.set(id, fn);
    } else {
      this.sleeps.push(ms);
      this.ms += ms;
      queueMicrotask(fn);
    }
    return { id };
  }
  clearTimer(h: { readonly id: number }): void {
    this.held.delete(h.id);
  }
  randomHex(bytes: number): string {
    this.rand += 1;
    return this.rand.toString(16).padStart(bytes * 2, "0");
  }
  /** Number of held (heartbeat) timers. */
  heldCount(): number {
    return this.held.size;
  }
  /** Runs every held timer once. */
  fire(): void {
    const fns = [...this.held.values()];
    this.held.clear();
    for (const fn of fns) fn();
  }
}

/** A `LedgerProcessInfo` with a controllable set of live pids. */
export class FakeProc implements LedgerProcessInfo {
  readonly alive = new Set<number>();
  constructor(readonly pid: number, readonly hostname: string) {
    this.alive.add(pid);
  }
  isAlive(pid: number): boolean {
    return this.alive.has(pid);
  }
}

export type FsOpName = "readText" | "writeText" | "appendText" | "rename" | "rm" | "mkdir" | "readdir" | "lstat" | "realpath" | "fsyncDir";

export interface FsCall {
  op: FsOpName;
  path: string;
  /** Second path of `rename`; the data of `writeText`/`appendText`. */
  data?: string;
  fsync?: boolean;
}

/**
 * Called before every operation reaches `inner`. It may throw (the operation fails), never settle (the process is meant to be
 * killed here) or return `{ writePartial }` for a text write: that many characters are written to the real file, then the hook
 * is awaited again via `afterPartial` (typically a hang).
 */
export type FsInterceptor = (call: FsCall) => Promise<void | { writePartial: number }> | void | { writePartial: number };

export function interceptFs(inner: FileSystem, before: FsInterceptor, afterPartial?: (call: FsCall) => Promise<void>): FileSystem {
  const gate = async (call: FsCall, writer?: (partial: string) => Promise<void>): Promise<void> => {
    const r = await before(call);
    if (r !== undefined && writer !== undefined && call.data !== undefined) {
      await writer(call.data.slice(0, r.writePartial));
      if (afterPartial !== undefined) await afterPartial(call);
    }
  };
  return {
    async readText(p) {
      await gate({ op: "readText", path: p });
      return inner.readText(p);
    },
    async writeText(p, data, o) {
      await gate({ op: "writeText", path: p, data, fsync: o?.fsync === true }, (part) => inner.writeText(p, part, o));
      return inner.writeText(p, data, o);
    },
    async appendText(p, data, o) {
      await gate({ op: "appendText", path: p, data, fsync: o.fsync }, (part) => inner.appendText(p, part, { fsync: false }));
      return inner.appendText(p, data, o);
    },
    async rename(a, b) {
      await gate({ op: "rename", path: a, data: b });
      return inner.rename(a, b);
    },
    async rm(p, o) {
      await gate({ op: "rm", path: p });
      return inner.rm(p, o);
    },
    async mkdir(p) {
      await gate({ op: "mkdir", path: p });
      return inner.mkdir(p);
    },
    async readdir(p) {
      await gate({ op: "readdir", path: p });
      return inner.readdir(p);
    },
    async lstat(p): Promise<FsStat | null> {
      await gate({ op: "lstat", path: p });
      return inner.lstat(p);
    },
    async realpath(p) {
      await gate({ op: "realpath", path: p });
      return inner.realpath(p);
    },
    async fsyncDir(p) {
      await gate({ op: "fsyncDir", path: p });
      return inner.fsyncDir(p);
    },
  };
}

/** An error with a Node-style `code`. */
export function fsError(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}
