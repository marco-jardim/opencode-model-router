import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDurationModel } from "../../src/routing/outcomes/durations";
import { createSideLogs, nodePersistDeps, nodePersistFs } from "../../src/routing/outcomes/persist";
import { MAX_OPEN_STARTS, MAX_SEEN_EVENT_IDS, OPEN_START_TTL_MS, createTimingRecorder } from "../../src/routing/outcomes/timings";
import type { DispatchStartInput, TimingLogger, TimingRecorder } from "../../src/routing/outcomes/timings";
import type { DispatchTimingRow, OrchestratorTurnRow, SideLogs } from "../../src/routing/outcomes/types";
import { removeDirWhenReleased } from "../helpers/remove-dir";

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);

interface Logged {
  readonly message: string;
  readonly extra: Record<string, unknown> | undefined;
}

interface CapturingLogger extends TimingLogger {
  readonly warns: Logged[];
  readonly debugs: Logged[];
}

function capturingLogger(): CapturingLogger {
  const warns: Logged[] = [];
  const debugs: Logged[] = [];
  return {
    warns,
    debugs,
    warn: (message, extra) => {
      warns.push({ message, extra });
    },
    debug: (message, extra) => {
      debugs.push({ message, extra });
    },
  };
}

function startInput(overrides: Partial<DispatchStartInput> = {}): DispatchStartInput {
  return {
    childSessionID: "child-1",
    parentSessionID: "root-1",
    callID: "call-1",
    role: "implementer",
    class: "implement",
    scope: "file",
    tier: "medium",
    model: "anthropic/claude-sonnet-5-5",
    background: false,
    at: NOW,
    ...overrides,
  };
}

function fakeSideLogs(overrides: Partial<SideLogs> = {}): SideLogs {
  return {
    dir: "fake",
    timingsPath: "fake/timings.jsonl",
    turnsPath: "fake/turns.jsonl",
    appendTimings: async () => ({ ok: true }),
    appendTurns: async () => ({ ok: true }),
    readTimings: async () => ({ rows: [], skipped: 0, newer: 0, files: [] }),
    readTurns: async () => ({ rows: [], skipped: 0, newer: 0, files: [] }),
    ...overrides,
  };
}

let dir: string;
let clockNow: number;
let logger: CapturingLogger;

const now = (): number => clockNow;

function recorder(overrides: { sideLogs?: SideLogs; logger?: TimingLogger; dir?: string } = {}): TimingRecorder {
  return createTimingRecorder({ dir: overrides.dir ?? dir, now, logger: overrides.logger ?? logger, ...(overrides.sideLogs ? { sideLogs: overrides.sideLogs } : {}) });
}

function lines(file: string): string[] {
  const path = join(dir, file);
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(line => line !== "") : [];
}

/** Rows straight off the disk, read synchronously: whatever is there when the recorder call returned. */
function timingRows(): DispatchTimingRow[] {
  return lines("timings.jsonl").map(line => JSON.parse(line) as DispatchTimingRow);
}

function turnRows(): OrchestratorTurnRow[] {
  return lines("turns.jsonl").map(line => JSON.parse(line) as OrchestratorTurnRow);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omr-timings-"));
  clockNow = NOW;
  logger = capturingLogger();
});

afterEach(async () => {
  await removeDirWhenReleased(dir);
}, 15_000);

describe("timing recorder: constants", () => {
  it("documents its bounds", () => {
    expect(MAX_OPEN_STARTS).toBe(1000);
    expect(OPEN_START_TTL_MS).toBe(6 * 60 * 60 * 1000);
  });
});

describe("timing recorder: start then outcome", () => {
  it("appends one row with the right duration and labels", async () => {
    const rec = recorder();
    rec.recordDispatchStart(startInput({ background: true }));
    clockNow = NOW + 5_000;
    await rec.onExecutionOutcome("child-1", "evt-1", "succeeded", NOW + 4_200);
    expect(timingRows()).toEqual([
      {
        kind: "dispatch-timing",
        v: 1,
        ts: new Date(NOW + 5_000).toISOString(),
        parentSessionID: "root-1",
        childSessionID: "child-1",
        callID: "call-1",
        role: "implementer",
        class: "implement",
        scope: "file",
        tier: "medium",
        model: "anthropic/claude-sonnet-5-5",
        background: true,
        startedAt: NOW,
        endedAt: NOW + 4_200,
        durationMs: 4_200,
        outcome: "succeeded",
        capacity: null,
      },
    ]);
    expect(logger.warns).toEqual([]);
  });

  it.each(["succeeded", "failed", "interrupted", "unknown"] as const)("records the %s outcome", async outcome => {
    const rec = recorder();
    rec.recordDispatchStart(startInput());
    await rec.onExecutionOutcome("child-1", "evt", outcome, NOW + 10);
    expect(timingRows().map(r => r.outcome)).toEqual([outcome]);
  });

  it("each row is on disk when the recorder call returns", async () => {
    const rec = recorder();
    rec.recordDispatchStart(startInput({ childSessionID: "a" }));
    rec.recordDispatchStart(startInput({ childSessionID: "b" }));
    await rec.onExecutionOutcome("a", "e-a", "succeeded", NOW + 1);
    expect(timingRows().map(r => r.childSessionID)).toEqual(["a"]);
    await rec.onExecutionOutcome("b", "e-b", "failed", NOW + 2);
    expect(timingRows().map(r => r.childSessionID)).toEqual(["a", "b"]);
  });

  it("the rows round-trip through the side-log reader", async () => {
    const rec = recorder();
    rec.recordDispatchStart(startInput());
    await rec.onExecutionOutcome("child-1", "evt-1", "succeeded", NOW + 3_000);
    const read = await createSideLogs(dir, nodePersistDeps(logger)).readTimings();
    expect(read.skipped).toBe(0);
    expect(read.rows).toEqual(timingRows());
  });

  it("clock skew: an outcome before the start gives duration 0", async () => {
    const rec = recorder();
    rec.recordDispatchStart(startInput({ at: NOW }));
    await rec.onExecutionOutcome("child-1", "evt-1", "succeeded", NOW - 9_000);
    const [only] = timingRows();
    expect(only?.durationMs).toBe(0);
    expect(only?.endedAt).toBe(NOW);
    expect(only?.startedAt).toBe(NOW);
  });

  it("a non-finite timestamp falls back to the clock", async () => {
    clockNow = NOW + 100;
    const rec = recorder();
    rec.recordDispatchStart(startInput({ at: Number.NaN }));
    clockNow = NOW + 700;
    await rec.onExecutionOutcome("child-1", "evt-1", "succeeded", Number.POSITIVE_INFINITY);
    const [only] = timingRows();
    expect(only?.startedAt).toBe(NOW + 100);
    expect(only?.endedAt).toBe(NOW + 700);
    expect(only?.durationMs).toBe(600);
  });

  it("a non-finite clock reading falls back to the wall clock for the row timestamp", async () => {
    const rec = createTimingRecorder({ dir, now: () => Number.NaN, logger });
    rec.recordDispatchStart(startInput());
    await rec.onExecutionOutcome("child-1", "evt-1", "succeeded", NOW + 1);
    const [only] = timingRows();
    expect(Number.isFinite(Date.parse(only?.ts ?? ""))).toBe(true);
  });
});

describe("timing recorder: outcome without a start", () => {
  it("writes no row and logs exactly one debug line", async () => {
    const rec = recorder();
    await rec.onExecutionOutcome("ghost", "evt-1", "succeeded", NOW);
    await rec.onExecutionOutcome("ghost-2", "evt-2", "failed", NOW);
    expect(existsSync(join(dir, "timings.jsonl"))).toBe(false);
    expect(logger.debugs).toHaveLength(1);
    expect(logger.debugs[0]?.extra).toEqual({ childSessionID: "ghost" });
    expect(logger.warns).toEqual([]);
  });

  it("works without a debug logger", async () => {
    const rec = createTimingRecorder({ dir, now, logger: { warn: () => undefined } });
    await expect(rec.onExecutionOutcome("ghost", "evt-1", "succeeded", NOW)).resolves.toBeUndefined();
    expect(existsSync(join(dir, "timings.jsonl"))).toBe(false);
  });

  it("works without any logger", async () => {
    const rec = createTimingRecorder({ dir, now });
    rec.recordDispatchStart(startInput());
    await rec.onExecutionOutcome("child-1", "evt-1", "succeeded", NOW + 1);
    await rec.onExecutionOutcome("nobody", "evt-2", "succeeded", NOW + 1);
    expect(timingRows()).toHaveLength(1);
  });
});

describe("timing recorder: duplicates and double outcomes", () => {
  it("two outcomes for the same child give one row", async () => {
    const rec = recorder();
    rec.recordDispatchStart(startInput());
    await rec.onExecutionOutcome("child-1", "evt-1", "succeeded", NOW + 10);
    await rec.onExecutionOutcome("child-1", "evt-2", "failed", NOW + 20);
    expect(timingRows()).toHaveLength(1);
    expect(timingRows()[0]?.outcome).toBe("succeeded");
  });

  it("two concurrent outcomes for the same child give one row", async () => {
    const rec = recorder();
    rec.recordDispatchStart(startInput());
    await Promise.all([
      rec.onExecutionOutcome("child-1", "evt-1", "succeeded", NOW + 10),
      rec.onExecutionOutcome("child-1", "evt-2", "failed", NOW + 20),
    ]);
    expect(timingRows()).toHaveLength(1);
  });

  it("a repeated event id is ignored and leaves the open start alone", async () => {
    const rec = recorder();
    rec.recordDispatchStart(startInput({ childSessionID: "a" }));
    rec.recordDispatchStart(startInput({ childSessionID: "b" }));
    await rec.onExecutionOutcome("a", "evt-1", "succeeded", NOW + 10);
    await rec.onExecutionOutcome("b", "evt-1", "succeeded", NOW + 20); // same event id: consumed by the first delivery
    expect(timingRows().map(r => r.childSessionID)).toEqual(["a"]);
    await rec.onExecutionOutcome("b", "evt-2", "succeeded", NOW + 30); // b is still open
    expect(timingRows().map(r => r.childSessionID)).toEqual(["a", "b"]);
  });

  it("an event id consumed by an outcome without a start stays consumed", async () => {
    const rec = recorder();
    await rec.onExecutionOutcome("late", "evt-1", "succeeded", NOW);
    rec.recordDispatchStart(startInput({ childSessionID: "late" }));
    await rec.onExecutionOutcome("late", "evt-1", "succeeded", NOW + 5);
    expect(timingRows()).toEqual([]);
  });

  it("an empty event id is never deduped", async () => {
    const rec = recorder();
    rec.recordDispatchStart(startInput());
    await rec.onExecutionOutcome("child-1", "", "succeeded", NOW + 1);
    rec.recordDispatchStart(startInput({ at: NOW + 2 }));
    await rec.onExecutionOutcome("child-1", "", "succeeded", NOW + 3);
    expect(timingRows()).toHaveLength(2);
  });

  it("a second start for an open child keeps the first start", async () => {
    const rec = recorder();
    rec.recordDispatchStart(startInput({ at: NOW, callID: "first" }));
    rec.recordDispatchStart(startInput({ at: NOW + 1_000, callID: "second" }));
    await rec.onExecutionOutcome("child-1", "evt-1", "succeeded", NOW + 2_000);
    const [only] = timingRows();
    expect(timingRows()).toHaveLength(1);
    expect(only?.callID).toBe("first");
    expect(only?.durationMs).toBe(2_000);
  });

  it("the same child can start again once its timing is closed", async () => {
    const rec = recorder();
    rec.recordDispatchStart(startInput({ at: NOW }));
    await rec.onExecutionOutcome("child-1", "evt-1", "succeeded", NOW + 10);
    rec.recordDispatchStart(startInput({ at: NOW + 100 }));
    await rec.onExecutionOutcome("child-1", "evt-2", "succeeded", NOW + 400);
    expect(timingRows().map(r => r.durationMs)).toEqual([10, 300]);
  });

  it("remembers at most MAX_SEEN_EVENT_IDS event ids (the oldest is forgotten)", async () => {
    const rec = recorder();
    rec.recordDispatchStart(startInput({ childSessionID: "first" }));
    await rec.onExecutionOutcome("first", "evt-first", "succeeded", NOW + 1);
    for (let i = 0; i < MAX_SEEN_EVENT_IDS; i++) await rec.onExecutionOutcome(`ghost-${i}`, `evt-${i}`, "succeeded", NOW);
    // "evt-first" has been pushed out: a new open start is closed by that id again.
    rec.recordDispatchStart(startInput({ childSessionID: "second", at: NOW }));
    await rec.onExecutionOutcome("second", "evt-first", "succeeded", NOW + 2);
    expect(timingRows().map(r => r.childSessionID)).toEqual(["first", "second"]);
  });
});

describe("timing recorder: open start bound", () => {
  it("1001 open starts evict the oldest, which then gets no row", async () => {
    const rec = recorder();
    for (let i = 0; i <= MAX_OPEN_STARTS; i++) rec.recordDispatchStart(startInput({ childSessionID: `c-${i}` }));
    await rec.onExecutionOutcome("c-0", "evt-0", "succeeded", NOW + 1);
    expect(existsSync(join(dir, "timings.jsonl"))).toBe(false);
    expect(logger.debugs).toHaveLength(1);
    await rec.onExecutionOutcome("c-1", "evt-1", "succeeded", NOW + 1);
    await rec.onExecutionOutcome(`c-${MAX_OPEN_STARTS}`, "evt-last", "succeeded", NOW + 1);
    expect(timingRows().map(r => r.childSessionID)).toEqual(["c-1", `c-${MAX_OPEN_STARTS}`]);
  });

  it("exactly 1000 open starts evict nothing", async () => {
    const rec = recorder();
    for (let i = 0; i < MAX_OPEN_STARTS; i++) rec.recordDispatchStart(startInput({ childSessionID: `c-${i}` }));
    await rec.onExecutionOutcome("c-0", "evt-0", "succeeded", NOW + 1);
    expect(timingRows().map(r => r.childSessionID)).toEqual(["c-0"]);
  });

  it("a repeated start refreshes the recency: the next-oldest is evicted instead", async () => {
    const rec = recorder();
    for (let i = 0; i < MAX_OPEN_STARTS; i++) rec.recordDispatchStart(startInput({ childSessionID: `c-${i}` }));
    rec.recordDispatchStart(startInput({ childSessionID: "c-0" })); // c-0 is now the most recent
    rec.recordDispatchStart(startInput({ childSessionID: "extra" })); // evicts c-1
    await rec.onExecutionOutcome("c-1", "evt-1", "succeeded", NOW + 1);
    expect(timingRows()).toEqual([]);
    await rec.onExecutionOutcome("c-0", "evt-0", "succeeded", NOW + 1);
    expect(timingRows().map(r => r.childSessionID)).toEqual(["c-0"]);
  });
});

describe("timing recorder: sweep", () => {
  it("closes a start older than 6 h as unknown and excludes it from estimates", async () => {
    const rec = recorder();
    rec.recordDispatchStart(startInput({ at: NOW }));
    clockNow = NOW + OPEN_START_TTL_MS + 1;
    await rec.sweep();
    const rows = timingRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: "unknown",
      startedAt: NOW,
      endedAt: NOW + OPEN_START_TTL_MS + 1,
      durationMs: OPEN_START_TTL_MS + 1,
      capacity: null,
    });

    // five such rows still leave the estimator on its prior
    const model = createDurationModel({ readTimings: () => Array.from({ length: 5 }, () => rows[0] as DispatchTimingRow), now }, { minSamples: 1 });
    await model.load();
    expect(model.estimate({ role: "implementer", class: "implement", scope: "file" }).source).toBe("prior");
  });

  it("a start of exactly 6 h stays open; a fresh one is untouched", async () => {
    const rec = recorder();
    rec.recordDispatchStart(startInput({ childSessionID: "edge", at: NOW }));
    rec.recordDispatchStart(startInput({ childSessionID: "fresh", at: NOW + OPEN_START_TTL_MS }));
    await rec.sweep(NOW + OPEN_START_TTL_MS);
    expect(existsSync(join(dir, "timings.jsonl"))).toBe(false);
    await rec.sweep(NOW + OPEN_START_TTL_MS + 1);
    expect(timingRows().map(r => r.childSessionID)).toEqual(["edge"]);
    await rec.onExecutionOutcome("fresh", "evt-f", "succeeded", NOW + OPEN_START_TTL_MS + 10);
    expect(timingRows().map(r => r.childSessionID)).toEqual(["edge", "fresh"]);
  });

  it("a swept start gets no second row from a late outcome", async () => {
    const rec = recorder();
    rec.recordDispatchStart(startInput());
    await rec.sweep(NOW + OPEN_START_TTL_MS + 1);
    await rec.onExecutionOutcome("child-1", "evt-1", "succeeded", NOW + OPEN_START_TTL_MS + 2);
    expect(timingRows()).toHaveLength(1);
    expect(timingRows()[0]?.outcome).toBe("unknown");
  });

  it("sweeps many stale starts in one append; rows are on disk when it returns", async () => {
    const rec = recorder();
    for (let i = 0; i < 20; i++) rec.recordDispatchStart(startInput({ childSessionID: `c-${i}` }));
    await rec.sweep(NOW + OPEN_START_TTL_MS + 5);
    expect(timingRows()).toHaveLength(20);
  });

  it("carries the latest capacity of a swept start", async () => {
    const rec = recorder();
    rec.recordDispatchStart(startInput());
    rec.onCapacitySignal("child-1", "usage-limit", NOW + 5);
    await rec.sweep(NOW + OPEN_START_TTL_MS + 1);
    expect(timingRows()[0]?.capacity).toBe("usage-limit");
  });

  it("with nothing to do writes nothing", async () => {
    const rec = recorder();
    await rec.sweep();
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("timing recorder: capacity", () => {
  it("a row with a capacity class round-trips and is excluded from estimates", async () => {
    const rec = recorder();
    rec.recordDispatchStart(startInput());
    rec.onCapacitySignal("child-1", "overload", NOW + 5);
    await rec.onExecutionOutcome("child-1", "evt-1", "succeeded", NOW + 900);
    const read = await createSideLogs(dir, nodePersistDeps(logger)).readTimings();
    expect(read.rows).toHaveLength(1);
    expect(read.rows[0]).toMatchObject({ capacity: "overload", outcome: "succeeded", durationMs: 900 });

    const model = createDurationModel({ readTimings: () => Array.from({ length: 6 }, () => read.rows[0] as DispatchTimingRow), now }, { minSamples: 1 });
    await model.load();
    expect(model.estimate({ role: "implementer", class: "implement", scope: "file" }).source).toBe("prior");
  });

  it.each(["rate-limit", "overload", "usage-limit"] as const)("round-trips %s", async capacity => {
    const rec = recorder();
    rec.recordDispatchStart(startInput());
    rec.onCapacitySignal("child-1", capacity, NOW);
    await rec.onExecutionOutcome("child-1", "evt-1", "failed", NOW + 1);
    const read = await createSideLogs(dir, nodePersistDeps(logger)).readTimings();
    expect(read.rows[0]?.capacity).toBe(capacity);
  });

  it("the latest signal wins", async () => {
    const rec = recorder();
    rec.recordDispatchStart(startInput());
    rec.onCapacitySignal("child-1", "rate-limit", NOW);
    rec.onCapacitySignal("child-1", "overload", NOW + 1);
    await rec.onExecutionOutcome("child-1", "evt-1", "failed", NOW + 2);
    expect(timingRows()[0]?.capacity).toBe("overload");
  });

  it("a signal for an unknown or already closed child is ignored", async () => {
    const rec = recorder();
    rec.onCapacitySignal("ghost", "rate-limit", NOW);
    rec.recordDispatchStart(startInput());
    await rec.onExecutionOutcome("child-1", "evt-1", "succeeded", NOW + 1);
    rec.onCapacitySignal("child-1", "rate-limit", NOW + 2);
    rec.recordDispatchStart(startInput({ at: NOW + 3 }));
    await rec.onExecutionOutcome("child-1", "evt-2", "succeeded", NOW + 4);
    expect(timingRows().map(r => r.capacity)).toEqual([null, null]);
    expect(logger.warns).toEqual([]);
  });
});

describe("timing recorder: never throws", () => {
  it("a side-log append that reports failure is logged once per kind and the row dropped", async () => {
    let calls = 0;
    const sideLogs = fakeSideLogs({
      appendTimings: async () => {
        calls += 1;
        return { ok: false, error: "disk full", code: "ENOSPC" };
      },
    });
    const rec = recorder({ sideLogs });
    for (const id of ["a", "b", "c"]) {
      rec.recordDispatchStart(startInput({ childSessionID: id }));
      await expect(rec.onExecutionOutcome(id, `evt-${id}`, "succeeded", NOW + 1)).resolves.toBeUndefined();
    }
    expect(calls).toBe(3); // never retried, never coalesced
    expect(logger.warns).toHaveLength(1);
    expect(logger.warns[0]?.extra).toMatchObject({ kind: "timings", error: "disk full" });
  });

  it("a side-log append that rejects is contained and logged once", async () => {
    const sideLogs = fakeSideLogs({
      appendTimings: () => Promise.reject(new Error("boom")),
      appendTurns: () => {
        throw new Error("sync boom");
      },
    });
    const rec = recorder({ sideLogs });
    rec.recordDispatchStart(startInput({ childSessionID: "a" }));
    rec.recordDispatchStart(startInput({ childSessionID: "b" }));
    await expect(rec.onExecutionOutcome("a", "e-a", "succeeded", NOW + 1)).resolves.toBeUndefined();
    await expect(rec.onExecutionOutcome("b", "e-b", "succeeded", NOW + 1)).resolves.toBeUndefined();
    rec.markRootSession("root");
    rec.onRootStep("root", { input: 1, cacheRead: 0, cacheWrite: 0 });
    await expect(rec.onRootPrompt("root", NOW)).resolves.toBeUndefined();
    await expect(rec.sweep(NOW + OPEN_START_TTL_MS * 2)).resolves.toBeUndefined();
    expect(logger.warns.length).toBeGreaterThanOrEqual(1);
    expect(logger.warns.every(w => w.extra?.kind === "internal")).toBe(true);
    expect(new Set(logger.warns.map(w => w.extra?.kind)).size).toBe(1); // one warning per kind
    expect(logger.warns).toHaveLength(1);
  });

  it("a non-Error rejection is reported by its text", async () => {
    const sideLogs = fakeSideLogs({ appendTimings: () => Promise.reject("plain string failure") });
    const rec = recorder({ sideLogs });
    rec.recordDispatchStart(startInput());
    await expect(rec.onExecutionOutcome("child-1", "evt-1", "succeeded", NOW + 1)).resolves.toBeUndefined();
    expect(logger.warns).toHaveLength(1);
    expect(logger.warns[0]?.extra).toEqual({ kind: "internal", error: "plain string failure" });
  });

  it("a sweep whose append fails is contained and the stale start is not retried", async () => {
    let calls = 0;
    const sideLogs = fakeSideLogs({
      appendTimings: async () => {
        calls += 1;
        throw new Error("sweep append failed");
      },
    });
    const rec = recorder({ sideLogs });
    rec.recordDispatchStart(startInput());
    await expect(rec.sweep(NOW + OPEN_START_TTL_MS + 1)).resolves.toBeUndefined();
    await expect(rec.sweep(NOW + OPEN_START_TTL_MS + 2)).resolves.toBeUndefined();
    expect(calls).toBe(1);
    expect(logger.warns.map(w => w.extra?.kind)).toEqual(["internal"]);
  });

  it("a missing event id (not a string) is treated as not deduplicable", async () => {
    const rec = recorder();
    rec.recordDispatchStart(startInput());
    await rec.onExecutionOutcome("child-1", undefined as unknown as string, "succeeded", NOW + 1);
    expect(timingRows()).toHaveLength(1);
  });

  it("a real side log whose filesystem fails to append reports a dropped row, not an error", async () => {
    const fs = { ...nodePersistFs(), appendText: () => Promise.reject(Object.assign(new Error("EIO: injected"), { code: "EIO" })) };
    const sideLogs = createSideLogs(dir, { ...nodePersistDeps(logger), fs });
    const rec = recorder({ sideLogs });
    rec.recordDispatchStart(startInput());
    await expect(rec.onExecutionOutcome("child-1", "evt-1", "succeeded", NOW + 1)).resolves.toBeUndefined();
    expect(logger.warns.map(w => w.extra?.kind)).toEqual(["timings"]);
    expect(timingRows()).toEqual([]);
  });

  it("an unwritable directory (a file in the way) is contained", async () => {
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a directory");
    const rec = recorder({ dir: join(blocker, "inside") });
    rec.recordDispatchStart(startInput());
    await expect(rec.onExecutionOutcome("child-1", "evt-1", "succeeded", NOW + 1)).resolves.toBeUndefined();
    expect(logger.warns.map(w => w.extra?.kind)).toEqual(["timings"]);
  });

  it("a throwing logger does not reach the caller", async () => {
    const throwing: TimingLogger = {
      warn: () => {
        throw new Error("logger broke");
      },
      debug: () => {
        throw new Error("debug broke");
      },
    };
    const sideLogs = fakeSideLogs({ appendTimings: async () => ({ ok: false, error: "nope" }) });
    const rec = recorder({ sideLogs, logger: throwing });
    rec.recordDispatchStart(startInput());
    await expect(rec.onExecutionOutcome("child-1", "evt-1", "succeeded", NOW + 1)).resolves.toBeUndefined();
    await expect(rec.onExecutionOutcome("ghost", "evt-2", "succeeded", NOW + 1)).resolves.toBeUndefined();
  });

  it("malformed input to any entry point is contained", async () => {
    const rec = recorder();
    expect(() => rec.recordDispatchStart(null as unknown as DispatchStartInput)).not.toThrow();
    rec.markRootSession("root");
    expect(() => rec.onRootStep("root", null as unknown as { input: number; cacheRead: number; cacheWrite: number })).not.toThrow();
    expect(logger.warns.length).toBeGreaterThanOrEqual(1);
  });

  it("a failing append does not stop later rows from being written once the disk recovers", async () => {
    let healthy = false;
    const real = createSideLogs(dir, nodePersistDeps(logger));
    const sideLogs = fakeSideLogs({
      appendTimings: rows => (healthy ? real.appendTimings(rows) : Promise.resolve({ ok: false, error: "down" })),
    });
    const rec = recorder({ sideLogs });
    rec.recordDispatchStart(startInput({ childSessionID: "lost" }));
    await rec.onExecutionOutcome("lost", "e1", "succeeded", NOW + 1);
    healthy = true;
    rec.recordDispatchStart(startInput({ childSessionID: "kept" }));
    await rec.onExecutionOutcome("kept", "e2", "succeeded", NOW + 1);
    expect(timingRows().map(r => r.childSessionID)).toEqual(["kept"]);
  });
});

describe("timing recorder: independent of routing.engine", () => {
  it("takes no engine input and creates no store, decision log or snapshot", async () => {
    // The way phase 2.1 constructs it: from a directory and a clock. A config whose engine is `static` has nothing to give it.
    const config = { routing: { engine: "static" as const } };
    expect(config.routing.engine).toBe("static");
    const rec = createTimingRecorder({ dir, now });
    expect(Object.keys(rec).sort()).toEqual(
      ["markRootSession", "onCapacitySignal", "onExecutionOutcome", "onRootPrompt", "onRootStep", "recordDispatchStart", "sweep"].sort(),
    );

    rec.recordDispatchStart(startInput());
    await rec.onExecutionOutcome("child-1", "evt-1", "succeeded", NOW + 1_500);
    rec.markRootSession("root-1");
    rec.onRootStep("root-1", { input: 10, cacheRead: 20, cacheWrite: 30 });
    await rec.onRootPrompt("root-1", NOW + 2_000);

    expect(timingRows()).toHaveLength(1);
    expect(turnRows()).toHaveLength(1);
    expect(readdirSync(dir).sort()).toEqual(["timings.jsonl", "turns.jsonl"]);
  });

  it("the module imports nothing but the side-log persistence and the shared types", () => {
    const source = readFileSync(fileURLToPath(new URL("../../src/routing/outcomes/timings.ts", import.meta.url)), "utf8");
    const specifiers = [...source.matchAll(/^import[^;]*?from\s+"([^"]+)";/gm)].map(m => m[1]).sort();
    expect(specifiers).toEqual(["./persist", "./types", "./types"]);
    const code = source.split("\n").filter(l => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");
    expect(code).not.toMatch(/engine/i);
  });
});
