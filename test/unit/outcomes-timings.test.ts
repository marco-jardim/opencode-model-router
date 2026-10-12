import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDurationModel } from "../../src/routing/outcomes/durations";
import { createSideLogs, nodePersistDeps, nodePersistFs } from "../../src/routing/outcomes/persist";
import {
  DEFAULT_TURN_IDLE_MS,
  MAX_OPEN_STARTS,
  MAX_ROOT_SESSIONS,
  MAX_SEEN_EVENT_IDS,
  MAX_UNBOUND_OUTCOMES,
  OPEN_START_TTL_MS,
  UNBOUND_OUTCOME_TTL_MS,
  acquireTimingRecorder,
  classifyCapacity,
  createTimingRecorder,
} from "../../src/routing/outcomes/timings";
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
  // Open starts are keyed by callID: a test that names only the child gets a call of its own.
  const callID = overrides.callID ?? (overrides.childSessionID === undefined || overrides.childSessionID === null ? "call-1" : `call-${overrides.childSessionID}`);
  return {
    childSessionID: "child-1",
    parentSessionID: "root-1",
    callID,
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
    expect(MAX_UNBOUND_OUTCOMES).toBe(200);
    expect(UNBOUND_OUTCOME_TTL_MS).toBe(10 * 60 * 1000);
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

  it("an end event id for an unknown child is not consumed (QA-1.1-3)", async () => {
    const rec = recorder();
    await rec.onExecutionOutcome("late", "evt-1", "succeeded", NOW);
    rec.recordDispatchStart(startInput({ childSessionID: "late" }));
    await rec.onExecutionOutcome("late", "evt-1", "succeeded", NOW + 5);
    expect(timingRows().map(r => r.childSessionID)).toEqual(["late"]);
    await rec.onExecutionOutcome("late", "evt-1", "succeeded", NOW + 9); // now it is consumed
    expect(timingRows()).toHaveLength(1);
  });

  it("an empty event id is never deduped", async () => {
    const rec = recorder();
    rec.recordDispatchStart(startInput());
    await rec.onExecutionOutcome("child-1", "", "succeeded", NOW + 1);
    rec.recordDispatchStart(startInput({ at: NOW + 2 }));
    await rec.onExecutionOutcome("child-1", "", "succeeded", NOW + 3);
    expect(timingRows()).toHaveLength(2);
  });

  it("a second start for an open child under ANOTHER callID closes the first as unknown at the new start once it is confirmed (QA-1.1-2, QA-1.1-18)", async () => {
    const rec = recorder();
    rec.recordDispatchStart(startInput({ at: NOW, callID: "first" }));
    rec.recordDispatchStart(startInput({ at: NOW + 1_000, callID: "second" }));
    await rec.flush();
    expect(timingRows()).toEqual([]); // not confirmed yet: the older call is still open
    rec.bindChild("second", "child-1"); // the host's result named the child
    await rec.flush(); // the older row is written in the background
    expect(timingRows()).toHaveLength(1);
    expect(timingRows()[0]).toMatchObject({ callID: "first", outcome: "unknown", startedAt: NOW, endedAt: NOW + 1_000, durationMs: 1_000 });
    await rec.onExecutionOutcome("child-1", "evt-1", "succeeded", NOW + 2_000);
    expect(timingRows()).toHaveLength(2);
    expect(timingRows()[1]).toMatchObject({ callID: "second", outcome: "succeeded", startedAt: NOW + 1_000, durationMs: 1_000 });
  });

  it("the unknown row of a replaced start is excluded from estimates", async () => {
    const rec = recorder();
    rec.recordDispatchStart(startInput({ at: NOW, callID: "first" }));
    rec.recordDispatchStart(startInput({ at: NOW + 1_000, callID: "second" }));
    rec.bindChild("second", "child-1");
    await rec.flush();
    const rows = timingRows();
    const model = createDurationModel({ readTimings: () => Array.from({ length: 6 }, () => rows[0] as DispatchTimingRow), now }, { minSamples: 1 });
    await model.load();
    expect(model.estimate({ role: "implementer", class: "implement", scope: "file" }).source).toBe("prior");
  });

  it("a second start with the SAME callID is a no-op", async () => {
    const rec = recorder();
    rec.recordDispatchStart(startInput({ at: NOW, callID: "same" }));
    rec.recordDispatchStart(startInput({ at: NOW + 1_000, callID: "same" }));
    await rec.flush();
    expect(timingRows()).toEqual([]);
    await rec.onExecutionOutcome("child-1", "evt-1", "succeeded", NOW + 2_000);
    expect(timingRows()).toHaveLength(1);
    expect(timingRows()[0]).toMatchObject({ callID: "same", startedAt: NOW, durationMs: 2_000 });
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
    const written: string[] = [];
    const sideLogs = fakeSideLogs({
      appendTimings: async rows => {
        for (const row of rows) written.push(row.childSessionID);
        return { ok: true };
      },
    });
    const rec = recorder({ sideLogs });
    rec.recordDispatchStart(startInput({ childSessionID: "first" }));
    await rec.onExecutionOutcome("first", "evt-first", "succeeded", NOW + 1);
    // Ids are consumed by deliveries that found a start: close MAX_SEEN_EVENT_IDS other dispatches.
    for (let i = 0; i < MAX_SEEN_EVENT_IDS; i++) {
      rec.recordDispatchStart(startInput({ childSessionID: `c-${i}` }));
      await rec.onExecutionOutcome(`c-${i}`, `evt-${i}`, "succeeded", NOW);
    }
    // "evt-first" has been pushed out: a new open start is closed by that id again.
    rec.recordDispatchStart(startInput({ childSessionID: "second", at: NOW }));
    await rec.onExecutionOutcome("second", "evt-first", "succeeded", NOW + 2);
    expect(written).toHaveLength(MAX_SEEN_EVENT_IDS + 2);
    expect(written[0]).toBe("first");
    expect(written.at(-1)).toBe("second");
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

describe("timing recorder: keyed by callID (QA-1.1-1)", () => {
  it("a start known only by its call id is closed through bindChild", async () => {
    const rec = recorder();
    rec.recordDispatchStart(startInput({ callID: "call-x", childSessionID: null }));
    rec.bindChild("call-x", "child-x");
    await rec.onExecutionOutcome("child-x", "evt-1", "succeeded", NOW + 800);
    expect(timingRows()).toHaveLength(1);
    expect(timingRows()[0]).toMatchObject({ callID: "call-x", childSessionID: "child-x", durationMs: 800 });
  });

  it("an outcome before the child is bound is remembered and applied by bindChild (QA-1.1-18)", async () => {
    const rec = recorder();
    rec.recordDispatchStart(startInput({ callID: "call-x", childSessionID: null }));
    await rec.onExecutionOutcome("child-x", "evt-1", "succeeded", NOW + 1_500);
    expect(timingRows()).toEqual([]); // no start for the child yet: nothing written now
    rec.bindChild("call-x", "child-x");
    await rec.flush();
    expect(timingRows()).toHaveLength(1);
    expect(timingRows()[0]).toMatchObject({ callID: "call-x", childSessionID: "child-x", durationMs: 1_500, outcome: "succeeded" });
    await rec.onExecutionOutcome("child-x", "evt-1", "succeeded", NOW + 2_000); // the same end again: ignored
    await rec.flush();
    expect(timingRows()).toHaveLength(1);
  });

  it("an outcome older than the start is not applied to it", async () => {
    const rec = recorder();
    await rec.onExecutionOutcome("child-x", "evt-old", "succeeded", NOW - 5_000); // belongs to an earlier dispatch
    rec.recordDispatchStart(startInput({ callID: "call-x", childSessionID: null, at: NOW }));
    rec.bindChild("call-x", "child-x");
    await rec.flush();
    expect(timingRows()).toEqual([]);
    await rec.onExecutionOutcome("child-x", "evt-new", "failed", NOW + 10);
    expect(timingRows()).toMatchObject([{ callID: "call-x", outcome: "failed", durationMs: 10 }]);
  });

  it("remembered outcomes are bounded in number and age", async () => {
    const rec = recorder();
    for (let i = 0; i < MAX_UNBOUND_OUTCOMES + 5; i++) await rec.onExecutionOutcome(`c-${i}`, `evt-${i}`, "succeeded", NOW + 1);
    rec.recordDispatchStart(startInput({ callID: "call-0", childSessionID: null }));
    rec.bindChild("call-0", "c-0"); // the oldest was pushed out
    rec.recordDispatchStart(startInput({ callID: "call-last", childSessionID: null }));
    rec.bindChild("call-last", `c-${MAX_UNBOUND_OUTCOMES + 4}`);
    await rec.flush();
    expect(timingRows().map(r => r.callID)).toEqual(["call-last"]);
    await rec.onExecutionOutcome("late", "evt-late", "succeeded", NOW + 1);
    clockNow = NOW + UNBOUND_OUTCOME_TTL_MS + 1;
    rec.recordDispatchStart(startInput({ callID: "call-late", childSessionID: null, at: NOW }));
    rec.bindChild("call-late", "late"); // expired
    await rec.flush();
    expect(timingRows().map(r => r.callID)).toEqual(["call-last"]);
  });

  it("foreground resume: the child's end arrives before the result binds it (QA-1.1-18)", async () => {
    const rec = recorder();
    rec.recordDispatchStart(startInput({ callID: "call-1", childSessionID: "child-r", at: NOW }));
    await rec.onExecutionOutcome("child-r", "evt-1", "succeeded", NOW + 1_000);
    expect(timingRows()).toHaveLength(1);
    // Resume of the same child: the router binds only at the result.
    clockNow = NOW + 5_000;
    rec.recordDispatchStart(startInput({ callID: "call-2", childSessionID: null, at: NOW + 5_000 }));
    await rec.onExecutionOutcome("child-r", "evt-2", "succeeded", NOW + 7_000); // ends before the result
    rec.bindChild("call-2", "child-r");
    await rec.flush();
    expect(timingRows().map(r => [r.callID, r.durationMs, r.outcome])).toEqual([
      ["call-1", 1_000, "succeeded"],
      ["call-2", 2_000, "succeeded"],
    ]);
  });

  it("a rejected resume of a live child leaves the live call alone (QA-1.1-18)", async () => {
    const rec = recorder();
    rec.recordDispatchStart(startInput({ callID: "call-1", childSessionID: "child-r", at: NOW }));
    rec.recordDispatchStart(startInput({ callID: "call-2", childSessionID: "child-r", at: NOW + 100 })); // the resume
    rec.cancelStart("call-2"); // the host rejected it (execute.after without a child)
    await rec.flush();
    expect(timingRows()).toEqual([]); // the live call was not closed
    await rec.onExecutionOutcome("child-r", "evt-1", "succeeded", NOW + 900);
    expect(timingRows()).toMatchObject([{ callID: "call-1", durationMs: 900, outcome: "succeeded" }]);
  });

  it("a confirmed newer call closes the older open one as unknown at its start; an outcome closes the oldest first", async () => {
    const rec = recorder();
    rec.recordDispatchStart(startInput({ callID: "call-1", childSessionID: "child-r", at: NOW }));
    rec.recordDispatchStart(startInput({ callID: "call-2", childSessionID: "child-r", at: NOW + 100 }));
    await rec.onExecutionOutcome("child-r", "evt-1", "succeeded", NOW + 300); // two open: the oldest closes
    expect(timingRows().map(r => r.callID)).toEqual(["call-1"]);
    rec.recordDispatchStart(startInput({ callID: "call-3", childSessionID: "child-r", at: NOW + 400 }));
    rec.bindChild("call-3", "child-r"); // result: call-2 ended without an outcome of its own
    await rec.flush();
    expect(timingRows().map(r => [r.callID, r.outcome, r.durationMs])).toEqual([
      ["call-1", "succeeded", 300],
      ["call-2", "unknown", 300],
    ]);
    await rec.onExecutionOutcome("child-r", "evt-2", "succeeded", NOW + 900);
    expect(timingRows().map(r => r.callID)).toEqual(["call-1", "call-2", "call-3"]);
  });

  it("binding a call to a second child leaves the first child's other call alone", async () => {
    const rec = recorder();
    rec.recordDispatchStart(startInput({ callID: "call-1", childSessionID: "child-a", at: NOW }));
    rec.recordDispatchStart(startInput({ callID: "call-2", childSessionID: "child-a", at: NOW + 10 }));
    rec.bindChild("call-2", "child-b"); // call-2 turned out to run another child
    await rec.onExecutionOutcome("child-a", "evt-1", "succeeded", NOW + 50);
    await rec.onExecutionOutcome("child-b", "evt-2", "succeeded", NOW + 60);
    expect(timingRows().map(r => [r.callID, r.childSessionID])).toEqual([
      ["call-1", "child-a"],
      ["call-2", "child-b"],
    ]);
  });

  it("bindChild is re-callable: the last child wins and the earlier one no longer finds the call", async () => {
    const rec = recorder();
    rec.recordDispatchStart(startInput({ callID: "call-x", childSessionID: null }));
    rec.bindChild("call-x", "child-old");
    rec.bindChild("call-x", "child-new");
    await rec.onExecutionOutcome("child-old", "evt-1", "succeeded", NOW + 1);
    expect(timingRows()).toEqual([]);
    await rec.onExecutionOutcome("child-new", "evt-2", "succeeded", NOW + 2);
    expect(timingRows().map(r => r.childSessionID)).toEqual(["child-new"]);
  });

  it("bindChild for an unknown or closed call is ignored", async () => {
    const rec = recorder();
    rec.bindChild("nobody", "child-x");
    rec.recordDispatchStart(startInput({ callID: "call-x", childSessionID: "child-x" }));
    await rec.onExecutionOutcome("child-x", "evt-1", "succeeded", NOW + 1);
    rec.bindChild("call-x", "child-y");
    await rec.onExecutionOutcome("child-y", "evt-2", "succeeded", NOW + 2);
    expect(timingRows()).toHaveLength(1);
    expect(logger.warns).toEqual([]);
  });

  it("cancelStart drops a rejected call without a row", async () => {
    const rec = recorder();
    rec.recordDispatchStart(startInput({ callID: "call-x", childSessionID: null }));
    rec.cancelStart("call-x");
    rec.bindChild("call-x", "child-x");
    await rec.onExecutionOutcome("child-x", "evt-1", "succeeded", NOW + 1);
    await rec.sweep(NOW + OPEN_START_TTL_MS * 2);
    expect(existsSync(join(dir, "timings.jsonl"))).toBe(false);
    rec.cancelStart("call-x"); // a second cancel, and one for an unknown call, are fine
    rec.cancelStart("never");
    expect(logger.warns).toEqual([]);
  });

  it("cancelStart of a bound call frees its child", async () => {
    const rec = recorder();
    rec.recordDispatchStart(startInput({ callID: "call-x", childSessionID: "child-x" }));
    rec.cancelStart("call-x");
    await rec.onExecutionOutcome("child-x", "evt-1", "succeeded", NOW + 1);
    expect(existsSync(join(dir, "timings.jsonl"))).toBe(false);
  });

  it("setBackground changes the flag of the open call before the row is written", async () => {
    const rec = recorder();
    rec.recordDispatchStart(startInput({ callID: "call-x", childSessionID: "child-x", background: false }));
    rec.setBackground("call-x", true);
    rec.setBackground("ghost", true);
    await rec.onExecutionOutcome("child-x", "evt-1", "succeeded", NOW + 1);
    expect(timingRows()[0]?.background).toBe(true);
  });

  it("a capacity signal reaches the call through its bound child", async () => {
    const rec = recorder();
    rec.recordDispatchStart(startInput({ callID: "call-x", childSessionID: null }));
    rec.onCapacitySignal("child-x", "rate-limit", NOW); // not bound yet: remembered, applied at the bind
    rec.bindChild("call-x", "child-x");
    rec.onCapacitySignal("child-x", "overload", NOW + 1);
    await rec.onExecutionOutcome("child-x", "evt-1", "failed", NOW + 2);
    expect(timingRows()[0]?.capacity).toBe("overload");
  });

  it("a fresh foreground dispatch keeps the capacity seen before its result binds the child (QA-1.1-27)", async () => {
    const rec = recorder();
    rec.recordDispatchStart(startInput({ callID: "call-x", childSessionID: null, at: NOW }));
    rec.onCapacitySignal("child-c", "rate-limit", NOW + 100);
    await rec.onExecutionOutcome("child-c", "evt-1", "failed", NOW + 200);
    expect(timingRows()).toEqual([]);
    rec.bindChild("call-x", "child-c");
    await rec.flush();
    expect(timingRows()).toMatchObject([{ callID: "call-x", childSessionID: "child-c", outcome: "failed", capacity: "rate-limit", durationMs: 200 }]);
  });

  it("background fan-out: capacity and outcomes follow the child even when the binds come in swapped order (QA-1.1-27)", async () => {
    const rec = recorder();
    rec.recordDispatchStart(startInput({ callID: "call-a", childSessionID: null, at: NOW, background: true }));
    rec.recordDispatchStart(startInput({ callID: "call-b", childSessionID: null, at: NOW + 1, background: true }));
    rec.onCapacitySignal("child-a", "overload", NOW + 50);
    rec.onCapacitySignal("child-b", "usage-limit", NOW + 60);
    await rec.onExecutionOutcome("child-b", "evt-b", "failed", NOW + 300);
    await rec.onExecutionOutcome("child-a", "evt-a", "failed", NOW + 400);
    rec.bindChild("call-b", "child-b");
    rec.bindChild("call-a", "child-a");
    await rec.flush();
    const rows = timingRows().map(r => [r.callID, r.childSessionID, r.capacity, r.durationMs]);
    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual(["call-a", "child-a", "overload", 400]);
    expect(rows).toContainEqual(["call-b", "child-b", "usage-limit", 299]);
  });

  it("a capacity signal older than the start is not applied to it (QA-1.1-27)", async () => {
    const rec = recorder();
    rec.onCapacitySignal("child-c", "overload", NOW - 5_000); // belongs to an earlier dispatch
    rec.recordDispatchStart(startInput({ callID: "call-x", childSessionID: null, at: NOW }));
    rec.bindChild("call-x", "child-c");
    await rec.onExecutionOutcome("child-c", "evt-1", "succeeded", NOW + 10);
    expect(timingRows()[0]?.capacity).toBeNull();
  });

  it("resume of a finished child linked at start: the row is written at the outcome and a later bind is ignored (QA-1.1-27)", async () => {
    const rec = recorder();
    rec.recordDispatchStart(startInput({ callID: "call-y", childSessionID: "child-c", at: NOW }));
    await rec.onExecutionOutcome("child-c", "evt-1", "succeeded", NOW + 500);
    expect(timingRows()).toMatchObject([{ callID: "call-y", childSessionID: "child-c", durationMs: 500 }]);
    rec.bindChild("call-y", "child-c"); // the call is closed: ignored
    await rec.flush();
    expect(timingRows()).toHaveLength(1);
    expect(logger.warns).toEqual([]);
  });

  it("a start that never got a child writes no row when swept", async () => {
    const rec = recorder();
    rec.recordDispatchStart(startInput({ callID: "call-x", childSessionID: null }));
    await rec.sweep(NOW + OPEN_START_TTL_MS + 1);
    expect(existsSync(join(dir, "timings.jsonl"))).toBe(false);
    rec.bindChild("call-x", "child-x"); // it is gone
    await rec.onExecutionOutcome("child-x", "evt-1", "succeeded", NOW + OPEN_START_TTL_MS + 2);
    expect(existsSync(join(dir, "timings.jsonl"))).toBe(false);
  });

  it("evicting a bound start also forgets its child", async () => {
    const rec = recorder();
    for (let i = 0; i <= MAX_OPEN_STARTS; i++) rec.recordDispatchStart(startInput({ childSessionID: `c-${i}` }));
    rec.onCapacitySignal("c-0", "overload", NOW);
    await rec.onExecutionOutcome("c-0", "evt-0", "succeeded", NOW + 1);
    expect(existsSync(join(dir, "timings.jsonl"))).toBe(false);
  });
});

describe("timing recorder: clamped rows (QA-1.1-9)", () => {
  it("an end before the start is written as unknown with duration 0", async () => {
    const rec = recorder();
    rec.recordDispatchStart(startInput({ at: NOW }));
    await rec.onExecutionOutcome("child-1", "evt-1", "succeeded", NOW - 9_000);
    expect(timingRows()[0]).toMatchObject({ outcome: "unknown", durationMs: 0, startedAt: NOW, endedAt: NOW });
  });

  it("a negative timestamp falls back to the clock like a non-finite one", async () => {
    clockNow = NOW + 50;
    const rec = recorder();
    rec.recordDispatchStart(startInput({ at: -5 }));
    expect(await rec.flush()).toBeUndefined();
    await rec.onExecutionOutcome("child-1", "evt-1", "succeeded", NOW + 60);
    expect(timingRows()[0]?.startedAt).toBe(NOW + 50);
  });

  it("a forward clock jump of more than 6 h (a suspended machine) closes running dispatches as unknown", async () => {
    const rec = recorder();
    rec.recordDispatchStart(startInput({ at: NOW }));
    clockNow = NOW + OPEN_START_TTL_MS + 60_000;
    await rec.sweep();
    expect(timingRows().map(r => r.outcome)).toEqual(["unknown"]);
  });
});

describe("timing recorder: label validation reaches the recorder (QA-1.1-5, QA-1.1-19)", () => {
  it("a label with spaces is written as unknown: the row is kept, the free text is not", async () => {
    const rec = recorder();
    rec.recordDispatchStart(startInput({ role: "some free text" }));
    await rec.onExecutionOutcome("child-1", "evt-1", "succeeded", NOW + 1);
    expect(timingRows()).toHaveLength(1);
    expect(timingRows()[0]?.role).toBe("unknown");
    expect(readFileSync(join(dir, "timings.jsonl"), "utf8")).not.toContain("free text");
    expect(logger.warns).toEqual([]);
  });

  it.each([
    ["a bracketed context suffix", "anthropic/claude-opus-5-5[1m]"],
    ["a Vertex version", "google-vertex-anthropic/claude-sonnet-5@20250101"],
    ["a Bedrock version", "amazon-bedrock/anthropic.claude-sonnet-5-v1:0"],
    ["a variant tag", "anthropic/claude-sonnet-5-5#low"],
  ])("keeps %s in the model label", async (_name, model) => {
    const rec = recorder();
    rec.recordDispatchStart(startInput({ model }));
    await rec.onExecutionOutcome("child-1", "evt-1", "succeeded", NOW + 1);
    expect(timingRows()).toHaveLength(1);
    expect(timingRows()[0]?.model).toBe(model);
    expect(logger.warns).toEqual([]);
  });

  it("an empty tier, class, scope or model, and an over-long role, become unknown", async () => {
    const rec = recorder();
    rec.recordDispatchStart(startInput({ tier: "", class: "", scope: "", model: "", role: "r".repeat(300) }));
    await rec.onExecutionOutcome("child-1", "evt-1", "succeeded", NOW + 1);
    expect(timingRows()[0]).toMatchObject({ tier: "unknown", class: "unknown", scope: "unknown", model: "unknown", role: "unknown" });
    expect(logger.warns).toEqual([]);
  });

  it("a session id with a space stays strict: the side log refuses the row", async () => {
    const rec = recorder();
    rec.recordDispatchStart(startInput({ parentSessionID: "root 1" }));
    await rec.onExecutionOutcome("child-1", "evt-1", "succeeded", NOW + 1);
    expect(existsSync(join(dir, "timings.jsonl"))).toBe(false);
    expect(logger.warns).toHaveLength(1);
  });
});

describe("timing recorder: turns (QA-1.1-4, QA-1.1-15)", () => {
  const step = { input: 10, cacheRead: 20, cacheWrite: 30 };

  it("the idle sweep skips a root that has an open dispatch start (QA-1.1-20)", async () => {
    const rec = recorder();
    rec.markRootSession("root-1");
    rec.markRootSession("root-2");
    rec.onRootStep("root-1", step);
    rec.onRootStep("root-2", step);
    rec.recordDispatchStart(startInput({ parentSessionID: "root-1", at: NOW }));
    await rec.sweep(NOW + DEFAULT_TURN_IDLE_MS + 1);
    expect(turnRows().map(r => r.sessionID)).toEqual(["root-2"]); // root-1 waits for its child
    await rec.onExecutionOutcome("child-1", "evt-1", "succeeded", NOW + 10);
    await rec.sweep(NOW + DEFAULT_TURN_IDLE_MS + 2);
    expect(turnRows().map(r => r.sessionID)).toEqual(["root-2", "root-1"]);
  });

  it("the idle sweep flushes the turn once the start TTL closed the dispatch", async () => {
    const rec = recorder();
    rec.markRootSession("root-1");
    rec.onRootStep("root-1", step);
    rec.recordDispatchStart(startInput({ parentSessionID: "root-1", at: NOW }));
    await rec.sweep(NOW + OPEN_START_TTL_MS + 1);
    expect(timingRows().map(r => r.outcome)).toEqual(["unknown"]);
    expect(turnRows().map(r => r.sessionID)).toEqual(["root-1"]);
  });

  it("flush waits for an append an unawaited outcome started (QA-1.1-25)", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolveGate => {
      release = resolveGate;
    });
    const written: string[] = [];
    const sideLogs = fakeSideLogs({
      appendTimings: async rows => {
        await gate;
        for (const row of rows) written.push(row.childSessionID);
        return { ok: true };
      },
    });
    const rec = recorder({ sideLogs });
    rec.recordDispatchStart(startInput());
    void rec.onExecutionOutcome("child-1", "evt-1", "succeeded", NOW + 1); // nobody awaits it
    const flushed = rec.flush();
    let done = false;
    void flushed.then(() => {
      done = true;
    });
    await new Promise<void>(resolveTick => setTimeout(resolveTick, 10));
    expect(done).toBe(false);
    release();
    await flushed;
    expect(written).toEqual(["child-1"]);
  });

  it("flush waits for the turn row an unawaited prompt started (QA-1.1-25)", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolveGate => {
      release = resolveGate;
    });
    let appended = 0;
    const sideLogs = fakeSideLogs({
      appendTurns: async rows => {
        await gate;
        appended += rows.length;
        return { ok: true };
      },
    });
    const rec = recorder({ sideLogs });
    rec.markRootSession("root-1");
    rec.onRootStep("root-1", step);
    void rec.onRootPrompt("root-1", NOW);
    const flushed = rec.flush();
    release();
    await flushed;
    expect(appended).toBe(1);
  });

  it("sweep leaves a turn that still receives steps open; the prompt then writes one row", async () => {
    const rec = recorder();
    rec.markRootSession("root-1");
    expect(rec.onRootStep("root-1", step)).toBe(true);
    clockNow = NOW + 60_000;
    await rec.sweep();
    expect(turnRows()).toEqual([]);
    clockNow = NOW + 120_000;
    expect(rec.onRootStep("root-1", step)).toBe(true);
    expect(rec.onRootStep("root-1", step)).toBe(true);
    await rec.sweep();
    expect(turnRows()).toEqual([]);
    await rec.onRootPrompt("root-1", clockNow);
    expect(turnRows()).toHaveLength(1);
    expect(turnRows()[0]).toMatchObject({ sessionID: "root-1", turn: 1, steps: 3, input: 30, cacheRead: 60, cacheWrite: 90 });
  });

  it("sweep flushes a turn idle for at least turnIdleMs", async () => {
    const rec = recorder();
    rec.markRootSession("root-1");
    rec.onRootStep("root-1", step);
    clockNow = NOW + DEFAULT_TURN_IDLE_MS - 1;
    await rec.sweep();
    expect(turnRows()).toEqual([]);
    clockNow = NOW + DEFAULT_TURN_IDLE_MS;
    await rec.sweep();
    expect(turnRows()).toHaveLength(1);
    await rec.sweep();
    expect(turnRows()).toHaveLength(1); // nothing left to flush
  });

  it("turnIdleMs is configurable", async () => {
    const rec = createTimingRecorder({ dir, now, logger, turnIdleMs: 1_000 });
    rec.markRootSession("root-1");
    rec.onRootStep("root-1", step);
    clockNow = NOW + 1_000;
    await rec.sweep();
    expect(turnRows()).toHaveLength(1);
  });

  it("flush and dispose write every open turn whatever its idle time", async () => {
    const rec = recorder();
    rec.markRootSession("a");
    rec.markRootSession("b");
    rec.onRootStep("a", step);
    rec.onRootStep("b", step);
    await rec.flush();
    expect(turnRows().map(r => r.sessionID).sort()).toEqual(["a", "b"]);
    rec.onRootStep("a", step);
    await rec.dispose();
    expect(turnRows().map(r => `${r.sessionID}:${r.turn}`).sort()).toEqual(["a:1", "a:2", "b:1"]);
  });

  it("onRootStep says whether the step was counted; isRootSession tells the tracked roots", () => {
    const rec = recorder();
    expect(rec.isRootSession("root-1")).toBe(false);
    expect(rec.onRootStep("root-1", step)).toBe(false);
    rec.markRootSession("root-1");
    expect(rec.isRootSession("root-1")).toBe(true);
    expect(rec.onRootStep("root-1", step, "evt-1")).toBe(true);
    expect(rec.onRootStep("root-1", step, "evt-1")).toBe(false);
  });

  it("a duplicate step event counts once", async () => {
    const rec = recorder();
    rec.markRootSession("root-1");
    rec.onRootStep("root-1", step, "step-1");
    rec.onRootStep("root-1", step, "step-1");
    rec.onRootStep("root-1", step, "step-2");
    await rec.onRootPrompt("root-1", NOW);
    expect(turnRows()).toHaveLength(1);
    expect(turnRows()[0]?.steps).toBe(2);
  });

  it("a step event id for a session that is not a root is not consumed", async () => {
    const rec = recorder();
    expect(rec.onRootStep("root-1", step, "step-1")).toBe(false);
    rec.markRootSession("root-1");
    expect(rec.onRootStep("root-1", step, "step-1")).toBe(true);
  });

  it("a duplicate prompt event closes the turn once", async () => {
    const rec = recorder();
    rec.markRootSession("root-1");
    rec.onRootStep("root-1", step);
    await rec.onRootPrompt("root-1", NOW, "prompt-1");
    rec.onRootStep("root-1", step);
    await rec.onRootPrompt("root-1", NOW, "prompt-1"); // the same event again: ignored, the new step stays in the open turn
    expect(turnRows()).toHaveLength(1);
    await rec.onRootPrompt("root-1", NOW, "prompt-2");
    expect(turnRows().map(r => r.turn)).toEqual([1, 2]);
  });

  it("every step refreshes the recency of its root: the least recently used root is the one evicted", () => {
    const rec = recorder();
    for (let i = 0; i < MAX_ROOT_SESSIONS; i++) rec.markRootSession(`root-${i}`);
    rec.onRootStep("root-0", step); // root-0 is now the most recent
    rec.markRootSession("extra"); // evicts root-1
    expect(rec.isRootSession("root-0")).toBe(true);
    expect(rec.isRootSession("root-1")).toBe(false);
    expect(rec.isRootSession("extra")).toBe(true);
  });

  it("a root evicted with a turn in progress still writes that turn", async () => {
    const rec = recorder();
    rec.markRootSession("root-0");
    rec.onRootStep("root-0", step);
    for (let i = 1; i <= MAX_ROOT_SESSIONS; i++) rec.markRootSession(`root-${i}`);
    await rec.flush();
    expect(turnRows().map(r => r.sessionID)).toEqual(["root-0"]);
  });
});

describe("timing recorder: shared per directory (QA-1.1-3)", () => {
  const step = { input: 10, cacheRead: 20, cacheWrite: 30 };
  const holders: Array<{ release(): Promise<void> }> = [];
  afterEach(async () => {
    for (const holder of holders.splice(0)) await holder.release();
  });
  const acquire = (extra: { dir?: string; onRow?: (row: DispatchTimingRow | OrchestratorTurnRow) => void } = {}) => {
    const holder = acquireTimingRecorder({ dir: extra.dir ?? dir, now, logger, ...(extra.onRow === undefined ? {} : { onRow: extra.onRow }) });
    holders.push(holder);
    return holder;
  };

  it("two acquirers of one directory share state: one turn row, whoever closes the turn", async () => {
    const a = acquire();
    const b = acquire();
    a.markRootSession("root-1");
    expect(b.isRootSession("root-1")).toBe(true);
    b.markRootSession("root-1");
    a.onRootStep("root-1", step, "step-1");
    b.onRootStep("root-1", step, "step-1"); // the same host event, delivered to both plugin instances
    await a.onRootPrompt("root-1", NOW, "prompt-1");
    await b.onRootPrompt("root-1", NOW, "prompt-1");
    expect(turnRows()).toHaveLength(1);
    expect(turnRows()[0]).toMatchObject({ steps: 1, turn: 1 });
  });

  it("a dispatch started through one acquirer is closed once through the other", async () => {
    const a = acquire();
    const b = acquire();
    a.recordDispatchStart(startInput({ callID: "call-x", childSessionID: null }));
    b.bindChild("call-x", "child-x");
    await Promise.all([a.onExecutionOutcome("child-x", "evt-1", "succeeded", NOW + 5), b.onExecutionOutcome("child-x", "evt-1", "succeeded", NOW + 5)]);
    expect(timingRows()).toHaveLength(1);
  });

  it("different directories (and the same directory spelled differently) are told apart correctly", async () => {
    const other = mkdtempSync(join(tmpdir(), "omr-timings-other-"));
    try {
      const a = acquire();
      const b = acquire({ dir: other });
      const c = acquire({ dir: join(dir, "..", dir.split(/[\\/]/).pop() ?? "") });
      a.markRootSession("root-1");
      expect(b.isRootSession("root-1")).toBe(false);
      expect(c.isRootSession("root-1")).toBe(true);
      await b.release();
    } finally {
      await removeDirWhenReleased(other);
    }
  });

  it("release: only the last holder flushes; the recorder is then gone from the registry", async () => {
    const a = acquire();
    const b = acquire();
    a.markRootSession("root-1");
    a.onRootStep("root-1", step);
    await a.release();
    await a.release(); // idempotent
    expect(turnRows()).toEqual([]);
    await b.release();
    expect(turnRows()).toHaveLength(1);
    const again = acquire();
    expect(again.isRootSession("root-1")).toBe(false); // a fresh recorder
  });

  it("onRow observes the rows of the shared recorder until its holder releases", async () => {
    const seen: string[] = [];
    const a = acquire({ onRow: row => seen.push(row.kind) });
    const b = acquire();
    b.recordDispatchStart(startInput());
    await b.onExecutionOutcome("child-1", "evt-1", "succeeded", NOW + 1);
    expect(seen).toEqual(["dispatch-timing"]);
    await a.release();
    b.recordDispatchStart(startInput({ at: NOW + 5 }));
    await b.onExecutionOutcome("child-1", "evt-2", "succeeded", NOW + 6);
    expect(seen).toEqual(["dispatch-timing"]);
  });

  it("a later acquirer with other settings is told once, at info; the first caller's settings apply (QA-1.1-24)", () => {
    const infos: Logged[] = [];
    const infoLogger: TimingLogger = {
      warn: () => undefined,
      info: (message, extra) => {
        infos.push({ message, extra });
      },
    };
    const first = acquireTimingRecorder({ dir, now, logger: infoLogger, turnIdleMs: 1_000 });
    holders.push(first);
    holders.push(acquireTimingRecorder({ dir, now, logger: infoLogger, turnIdleMs: 1_000 })); // identical: silent
    expect(infos).toEqual([]);
    holders.push(acquireTimingRecorder({ dir, now, logger: infoLogger, turnIdleMs: 5_000 }));
    holders.push(acquireTimingRecorder({ dir, now: () => NOW + 1, logger: infoLogger }));
    expect(infos).toHaveLength(1);
    expect(infos[0]?.extra).toEqual({ dir });
  });

  it("a later acquirer with a different clock or logger is told too, on that logger (QA-1.1-24)", () => {
    const infos: Logged[] = [];
    holders.push(acquire());
    holders.push(
      acquireTimingRecorder({
        dir,
        now,
        logger: {
          warn: () => undefined,
          info: (message, extra) => {
            infos.push({ message, extra });
          },
        },
      }),
    );
    expect(infos).toHaveLength(1);
  });

  it("a later acquirer that passes nothing different, or whose logger has no info, is silent", () => {
    holders.push(acquire());
    expect(() => holders.push(acquireTimingRecorder({ dir, now, logger: { warn: () => undefined }, turnIdleMs: 9 }))).not.toThrow();
    holders.push(acquireTimingRecorder({ dir, now }));
    expect(logger.warns).toEqual([]);
  });

  it("a throwing observer does not stop the write or the other observers", async () => {
    const seen: string[] = [];
    acquire({
      onRow: () => {
        throw new Error("observer broke");
      },
    });
    acquire({ onRow: row => seen.push(row.kind) });
    const rec = acquire();
    rec.recordDispatchStart(startInput());
    await rec.onExecutionOutcome("child-1", "evt-1", "succeeded", NOW + 1);
    expect(timingRows()).toHaveLength(1);
    expect(seen).toEqual(["dispatch-timing"]);
  });
});

describe("timing recorder: shared across module copies (DF-1.1-2)", () => {
  type TimingsModule = typeof import("../../src/routing/outcomes/timings");
  const step = { input: 10, cacheRead: 20, cacheWrite: 30 };
  const REGISTRY_KEY = Symbol.for("opencode-model-router.timings.registry.v1");
  const holders: Array<{ release(): Promise<void> }> = [];

  // The host loads the plugin once per booted location: each load is a distinct module instance in one process.
  async function loadCopy(): Promise<TimingsModule> {
    vi.resetModules();
    return await import("../../src/routing/outcomes/timings");
  }

  afterEach(async () => {
    for (const holder of holders.splice(0)) await holder.release();
    delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY];
  });

  it("two module copies share one recorder per directory: one root run yields one turn row, numbering never restarts", async () => {
    const copyA = await loadCopy();
    const copyB = await loadCopy();
    expect(copyB).not.toBe(copyA);
    expect(copyB.acquireTimingRecorder).not.toBe(copyA.acquireTimingRecorder);
    const a = copyA.acquireTimingRecorder({ dir, now, logger });
    const b = copyB.acquireTimingRecorder({ dir, now, logger });
    holders.push(a, b);

    a.markRootSession("root-1");
    expect(b.isRootSession("root-1")).toBe(true); // one recorder, not two
    b.markRootSession("root-1");
    a.onRootStep("root-1", step, "step-1");
    b.onRootStep("root-1", step, "step-1"); // the same host event, delivered to both copies
    await a.onRootPrompt("root-1", NOW, "prompt-1");
    await b.onRootPrompt("root-1", NOW, "prompt-1");
    expect(turnRows()).toHaveLength(1);
    expect(turnRows()[0]).toMatchObject({ steps: 1, turn: 1 });

    b.onRootStep("root-1", step, "step-2");
    a.onRootStep("root-1", step, "step-2");
    await b.onRootPrompt("root-1", NOW + 1, "prompt-2");
    await a.onRootPrompt("root-1", NOW + 1, "prompt-2");
    expect(turnRows().map(row => row.turn)).toEqual([1, 2]);
  });

  it("holders of different copies share one refcount: releasing one keeps the other working", async () => {
    const copyA = await loadCopy();
    const copyB = await loadCopy();
    const a = copyA.acquireTimingRecorder({ dir, now, logger });
    const b = copyB.acquireTimingRecorder({ dir, now, logger });
    holders.push(a, b);
    a.markRootSession("root-1");
    a.onRootStep("root-1", step);
    await a.release();
    expect(turnRows()).toEqual([]); // not the last holder: no flush yet
    expect(b.isRootSession("root-1")).toBe(true);
    await b.release();
    expect(turnRows()).toHaveLength(1);
    const again = copyA.acquireTimingRecorder({ dir, now, logger });
    holders.push(again);
    expect(again.isRootSession("root-1")).toBe(false); // the registry entry is gone: a fresh recorder
  });

  it("replaces a foreign value in the process-wide slot", async () => {
    (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY] = { not: "a map" };
    const copy = await loadCopy();
    const holder = copy.acquireTimingRecorder({ dir, now, logger });
    holders.push(holder);
    holder.markRootSession("root-1");
    expect(holder.isRootSession("root-1")).toBe(true);
    expect((globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY]).toBeInstanceOf(Map);
  });
});

describe("classifyCapacity (QA-1.1-8; ADR 0007 D6 and D13)", () => {
  it.each([
    [{ type: "provider.rate-limit", status: 429 }, "rate-limit"],
    [{ type: "provider.rate-limit" }, "rate-limit"],
    [{ type: "provider.internal", status: 529 }, "overload"],
    [{ type: "provider.internal", status: 500 }, null],
    [{ type: "provider.internal" }, null],
    [{ type: "provider.quota", status: 429 }, "usage-limit"],
    [{ type: "provider.quota" }, "usage-limit"],
    [{ type: "provider.something-new", status: 429 }, "rate-limit"],
    [{ type: "provider.something-new", status: 529 }, "overload"],
    [{ type: "provider.something-new", status: 500 }, null],
    [{ type: "provider.something-new" }, null],
    [{ status: 429 }, "rate-limit"],
    [{ status: 529 }, "overload"],
    [{ type: null, status: null }, null],
    [{}, null],
  ] as const)("%j → %s", (error, expected) => {
    expect(classifyCapacity(error)).toBe(expected);
  });

  it("the type decides over the status", () => {
    expect(classifyCapacity({ type: "provider.quota", status: 529 })).toBe("usage-limit");
    expect(classifyCapacity({ type: "provider.rate-limit", status: 529 })).toBe("rate-limit");
  });
});

describe("timing recorder: independent of routing.engine", () => {
  it("takes no engine input and creates no store, decision log or snapshot", async () => {
    // The way phase 2.1 constructs it: from a directory and a clock. A config whose engine is `static` has nothing to give it.
    const config = { routing: { engine: "static" as const } };
    expect(config.routing.engine).toBe("static");
    const rec = createTimingRecorder({ dir, now });
    expect(Object.keys(rec).sort()).toEqual(
      [
        "bindChild",
        "cancelStart",
        "dispose",
        "flush",
        "isRootSession",
        "markRootSession",
        "onCapacitySignal",
        "onExecutionOutcome",
        "onRootExecutionEnd",
        "onRootPrompt",
        "onRootStep",
        "recordDispatchStart",
        "setBackground",
        "sweep",
      ].sort(),
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
    expect(specifiers).toEqual(["./persist", "./types", "./types", "node:path"]);
    const code = source.split("\n").filter(l => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");
    expect(code).not.toMatch(/engine/i);
  });
});
