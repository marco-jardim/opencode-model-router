import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSideLogs, nodePersistDeps } from "../../src/routing/outcomes/persist";
import { summarizeCacheShare } from "../../src/routing/outcomes/stats";
import { MAX_ROOT_SESSIONS, createTimingRecorder } from "../../src/routing/outcomes/timings";
import type { TimingLogger, TimingRecorder } from "../../src/routing/outcomes/timings";
import type { OrchestratorTurnRow, SideLogs, StatsWindow } from "../../src/routing/outcomes/types";
import { removeDirWhenReleased } from "../helpers/remove-dir";

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
const OPEN_WINDOW: StatsWindow = { since: null, until: null };

interface CapturingLogger extends TimingLogger {
  readonly warns: Array<{ message: string; extra: Record<string, unknown> | undefined }>;
}

function capturingLogger(): CapturingLogger {
  const warns: CapturingLogger["warns"] = [];
  return {
    warns,
    warn: (message, extra) => {
      warns.push({ message, extra });
    },
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

function recorder(sideLogs?: SideLogs): TimingRecorder {
  return createTimingRecorder({ dir, now, logger, ...(sideLogs ? { sideLogs } : {}) });
}

/** Rows straight off the disk, read synchronously: whatever is there when the recorder call returned. */
function turnRows(): OrchestratorTurnRow[] {
  const path = join(dir, "turns.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(line => line !== "")
    .map(line => JSON.parse(line) as OrchestratorTurnRow);
}

function tokens(input: number, cacheRead: number, cacheWrite: number) {
  return { input, cacheRead, cacheWrite };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omr-turns-"));
  clockNow = NOW;
  logger = capturingLogger();
});

afterEach(async () => {
  await removeDirWhenReleased(dir);
}, 15_000);

describe("orchestrator turns: aggregation", () => {
  it("a turn boundary at the prompt event closes the turn with its step sums", async () => {
    const rec = recorder();
    rec.markRootSession("root");
    rec.onRootStep("root", tokens(100, 900, 50));
    await rec.onRootPrompt("root", NOW);
    expect(turnRows()).toEqual([
      {
        kind: "orchestrator-turn",
        v: 1,
        ts: new Date(NOW).toISOString(),
        sessionID: "root",
        turn: 1,
        steps: 1,
        input: 100,
        cacheRead: 900,
        cacheWrite: 50,
      },
    ]);
  });

  it("multi-step turns sum their steps; steps after the prompt belong to the next turn", async () => {
    const rec = recorder();
    rec.markRootSession("root");
    rec.onRootStep("root", tokens(10, 100, 1));
    rec.onRootStep("root", tokens(20, 200, 2));
    rec.onRootStep("root", tokens(30, 300, 3));
    await rec.onRootPrompt("root", NOW);
    rec.onRootStep("root", tokens(5, 50, 0));
    rec.onRootStep("root", tokens(5, 50, 0));
    await rec.onRootPrompt("root", NOW + 1);
    expect(turnRows().map(r => [r.turn, r.steps, r.input, r.cacheRead, r.cacheWrite])).toEqual([
      [1, 3, 60, 600, 6],
      [2, 2, 10, 100, 0],
    ]);
  });

  it("DF-1-5: a root run's end closes its turn with the step sums, though a background dispatch start is still open", async () => {
    const rec = recorder();
    rec.markRootSession("root");
    rec.recordDispatchStart({
      callID: "call-1", childSessionID: null, parentSessionID: "root", role: "implementer", class: "implement", scope: "single",
      tier: "medium", model: "anthropic/claude-sonnet-4-5", background: true, at: NOW,
    });
    rec.bindChild("call-1", "child-1"); // the child keeps running: no outcome, the start stays open
    rec.onRootStep("root", tokens(10, 100, 1));
    rec.onRootStep("root", tokens(20, 200, 2));
    rec.onRootStep("root", tokens(30, 300, 3));
    await rec.onRootExecutionEnd("root", "run-1"); // no prompt hook: the kickoff run ends
    expect(turnRows().map(r => [r.sessionID, r.turn, r.steps, r.input, r.cacheRead, r.cacheWrite])).toEqual([["root", 1, 3, 60, 600, 6]]);
    await rec.onRootExecutionEnd("root", "run-2"); // no step since: nothing is written
    expect(turnRows()).toHaveLength(1);
    rec.onRootStep("root", tokens(5, 50, 0)); // the synthetic wake-up run
    await rec.onRootExecutionEnd("root", "run-1"); // a seen event id: ignored, the step stays in the open turn
    expect(turnRows()).toHaveLength(1);
    await rec.onRootExecutionEnd("root", "run-3");
    expect(turnRows().map(r => [r.turn, r.steps, r.input, r.cacheRead, r.cacheWrite])).toEqual([
      [1, 3, 60, 600, 6],
      [2, 1, 5, 50, 0],
    ]);
  });

  it("DF-1-5: the run end of a child or of an unknown session writes no row and leaves the root's turn open", async () => {
    const rec = recorder();
    rec.markRootSession("root");
    rec.onRootStep("root", tokens(1, 2, 3));
    expect(rec.onRootStep("child-1", tokens(7, 7, 7))).toBe(false); // not a root
    await rec.onRootExecutionEnd("child-1", "c-1");
    await rec.onRootExecutionEnd("never-seen", "c-2");
    expect(turnRows()).toEqual([]);
    await rec.onRootExecutionEnd("root");
    expect(turnRows().map(r => [r.sessionID, r.turn, r.steps, r.input, r.cacheRead, r.cacheWrite])).toEqual([["root", 1, 1, 1, 2, 3]]);
  });

  // QA-DF1-24: the prompt boundary and the run-end boundary of DF-1-5 meet. Each closes the steps counted so far; a boundary with
  // no step since writes nothing, so neither order loses a step or writes a row twice. The recorder sees events in arrival order:
  // if the event loop lags and a run's last step event is handled after the next prompt, that step opens the next turn, so the
  // run's steps are split over two rows (the sums stay whole; the run-end of that run then closes the row holding the late step).
  const sums = () => turnRows().map(r => [r.turn, r.steps, r.input, r.cacheRead, r.cacheWrite]);

  it("QA-DF1-24 (DF-1-5): a prompt before the root run end closes the turn; the run end then writes no second row and no step is lost", async () => {
    const rec = recorder();
    rec.markRootSession("root");
    rec.onRootStep("root", tokens(10, 100, 1));
    rec.onRootStep("root", tokens(20, 200, 2));
    await rec.onRootPrompt("root", NOW); // the next prompt is handled before the run's end event
    expect(sums()).toEqual([[1, 2, 30, 300, 3]]);
    await rec.onRootExecutionEnd("root", "run-1"); // no step since the prompt: nothing to close
    expect(sums()).toEqual([[1, 2, 30, 300, 3]]);
    rec.onRootStep("root", tokens(5, 50, 0)); // the prompted run
    await rec.onRootExecutionEnd("root", "run-2");
    expect(sums()).toEqual([[1, 2, 30, 300, 3], [2, 1, 5, 50, 0]]);
  });

  it("QA-DF1-24 (DF-1-5): a prompt after the root run end writes no second row; the next turn's steps are kept", async () => {
    const rec = recorder();
    rec.markRootSession("root");
    rec.onRootStep("root", tokens(10, 100, 1));
    await rec.onRootExecutionEnd("root", "run-1");
    expect(sums()).toEqual([[1, 1, 10, 100, 1]]);
    await rec.onRootPrompt("root", NOW + 1); // no step since the run end: nothing to close
    expect(sums()).toEqual([[1, 1, 10, 100, 1]]);
    rec.onRootStep("root", tokens(2, 20, 0));
    rec.onRootStep("root", tokens(3, 30, 0));
    await rec.onRootPrompt("root", NOW + 2);
    await rec.onRootExecutionEnd("root", "run-2"); // after the prompt that closed the turn: nothing
    expect(sums()).toEqual([[1, 1, 10, 100, 1], [2, 2, 5, 50, 0]]);
  });

  it("QA-DF1-24 (DF-1-5): a run's step handled after the next prompt (event loop lag) splits that run over two rows, sums whole (documented)", async () => {
    const rec = recorder();
    rec.markRootSession("root");
    rec.onRootStep("root", tokens(10, 100, 1));
    await rec.onRootPrompt("root", NOW); // arrives before the run's last step event is handled
    rec.onRootStep("root", tokens(20, 200, 2)); // run 1's late step: counted in the open turn
    await rec.onRootExecutionEnd("root", "run-1");
    expect(sums()).toEqual([[1, 1, 10, 100, 1], [2, 1, 20, 200, 2]]);
    const all = turnRows();
    expect(all.reduce((n, r) => n + r.steps, 0)).toBe(2); // no step lost, none counted twice
  });

  it("each row is on disk when onRootPrompt returns", async () => {
    const rec = recorder();
    rec.markRootSession("root");
    rec.onRootStep("root", tokens(1, 2, 3));
    expect(turnRows()).toEqual([]); // nothing is written before the boundary
    await rec.onRootPrompt("root", NOW);
    expect(turnRows()).toHaveLength(1);
    rec.onRootStep("root", tokens(1, 2, 3));
    await rec.onRootPrompt("root", NOW);
    expect(turnRows()).toHaveLength(2);
  });

  it("a prompt without steps writes no row and does not advance the turn number", async () => {
    const rec = recorder();
    rec.markRootSession("root");
    await rec.onRootPrompt("root", NOW);
    await rec.onRootPrompt("root", NOW + 1);
    expect(existsSync(join(dir, "turns.jsonl"))).toBe(false);
    rec.onRootStep("root", tokens(1, 1, 1));
    await rec.onRootPrompt("root", NOW + 2);
    expect(turnRows().map(r => r.turn)).toEqual([1]);
  });

  it("turn numbers are per session", async () => {
    const rec = recorder();
    rec.markRootSession("a");
    rec.markRootSession("b");
    rec.onRootStep("a", tokens(1, 0, 0));
    rec.onRootStep("b", tokens(2, 0, 0));
    await rec.onRootPrompt("a", NOW);
    rec.onRootStep("a", tokens(1, 0, 0));
    await rec.onRootPrompt("a", NOW);
    await rec.onRootPrompt("b", NOW);
    expect(turnRows().map(r => [r.sessionID, r.turn, r.input])).toEqual([
      ["a", 1, 1],
      ["a", 2, 1],
      ["b", 1, 2],
    ]);
  });

  it("marking a root again keeps its open turn", async () => {
    const rec = recorder();
    rec.markRootSession("root");
    rec.onRootStep("root", tokens(7, 0, 0));
    rec.markRootSession("root");
    rec.onRootStep("root", tokens(8, 0, 0));
    await rec.onRootPrompt("root", NOW);
    expect(turnRows().map(r => [r.turn, r.steps, r.input])).toEqual([[1, 2, 15]]);
  });

  it("the rows round-trip through the side-log reader", async () => {
    const rec = recorder();
    rec.markRootSession("root");
    rec.onRootStep("root", tokens(11, 22, 33));
    await rec.onRootPrompt("root", NOW);
    const read = await createSideLogs(dir, nodePersistDeps(logger)).readTurns();
    expect(read.skipped).toBe(0);
    expect(read.rows).toEqual(turnRows());
  });

  it("a step that arrives while the row is being appended counts for the next turn", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const written: OrchestratorTurnRow[] = [];
    const rec = recorder(
      fakeSideLogs({
        appendTurns: async rows => {
          await gate;
          written.push(...rows);
          return { ok: true };
        },
      }),
    );
    rec.markRootSession("root");
    rec.onRootStep("root", tokens(1, 0, 0));
    const closing = rec.onRootPrompt("root", NOW);
    rec.onRootStep("root", tokens(100, 0, 0)); // during the append
    release();
    await closing;
    await rec.onRootPrompt("root", NOW + 1);
    expect(written.map(r => [r.turn, r.steps, r.input])).toEqual([
      [1, 1, 1],
      [2, 1, 100],
    ]);
  });
});

describe("orchestrator turns: token edge cases", () => {
  it("zero-token steps count as steps and the stats share does not divide by zero", async () => {
    const rec = recorder();
    rec.markRootSession("root");
    rec.onRootStep("root", tokens(0, 0, 0));
    rec.onRootStep("root", tokens(0, 0, 0));
    await rec.onRootPrompt("root", NOW);
    const rows = turnRows();
    expect(rows.map(r => [r.steps, r.input, r.cacheRead, r.cacheWrite])).toEqual([[2, 0, 0, 0]]);
    expect(summarizeCacheShare(rows, OPEN_WINDOW)).toBeNull();
  });

  it("a zero-token turn is left out of the share, the others stay", async () => {
    const rec = recorder();
    rec.markRootSession("root");
    rec.onRootStep("root", tokens(0, 0, 0));
    await rec.onRootPrompt("root", NOW);
    rec.onRootStep("root", tokens(100, 300, 0));
    await rec.onRootPrompt("root", NOW);
    const share = summarizeCacheShare(turnRows(), OPEN_WINDOW);
    expect(share).toEqual({ p50: 0.75, p10: 0.75, turns: 1 });
    expect(Number.isNaN(share?.p50)).toBe(false);
  });

  it("cache-write-only turns have a share of 0", async () => {
    const rec = recorder();
    rec.markRootSession("root");
    rec.onRootStep("root", tokens(0, 0, 500));
    await rec.onRootPrompt("root", NOW);
    const rows = turnRows();
    expect(rows.map(r => [r.input, r.cacheRead, r.cacheWrite])).toEqual([[0, 0, 500]]);
    expect(summarizeCacheShare(rows, OPEN_WINDOW)).toEqual({ p50: 0, p10: 0, turns: 1 });
  });

  it("invalid counters (negative, NaN, infinite) count as 0", async () => {
    const rec = recorder();
    rec.markRootSession("root");
    rec.onRootStep("root", tokens(-5, Number.NaN, Number.POSITIVE_INFINITY));
    rec.onRootStep("root", tokens(4, 6, 8));
    await rec.onRootPrompt("root", NOW);
    expect(turnRows().map(r => [r.steps, r.input, r.cacheRead, r.cacheWrite])).toEqual([[2, 4, 6, 8]]);
  });

  it("the share of several turns uses nearest-rank p50 and p10", async () => {
    const rec = recorder();
    rec.markRootSession("root");
    for (const read of [0, 100, 300, 900]) {
      rec.onRootStep("root", tokens(100, read, 0));
      await rec.onRootPrompt("root", NOW);
    }
    // shares: 0, 0.5, 0.75, 0.9 -> p50 = rank 2, p10 = rank 1
    expect(summarizeCacheShare(turnRows(), OPEN_WINDOW)).toEqual({ p50: 0.5, p10: 0, turns: 4 });
  });
});

describe("orchestrator turns: root sessions only", () => {
  it("steps and prompts of a session that was never marked (a child session) are ignored", async () => {
    const rec = recorder();
    rec.markRootSession("root");
    rec.onRootStep("child", tokens(999, 999, 999));
    await rec.onRootPrompt("child", NOW);
    await rec.sweep(NOW);
    expect(existsSync(join(dir, "turns.jsonl"))).toBe(false);
    rec.onRootStep("root", tokens(1, 2, 3));
    await rec.onRootPrompt("root", NOW);
    expect(turnRows().map(r => r.sessionID)).toEqual(["root"]);
    expect(turnRows()[0]?.input).toBe(1);
  });

  it("a child that becomes known later is still excluded unless it is marked", async () => {
    const rec = recorder();
    rec.onRootStep("late-root", tokens(5, 5, 5)); // before the mark: lost, not queued
    rec.markRootSession("late-root");
    rec.onRootStep("late-root", tokens(1, 1, 1));
    await rec.onRootPrompt("late-root", NOW);
    expect(turnRows().map(r => [r.steps, r.input])).toEqual([[1, 1]]);
  });

  it("remembers at most MAX_ROOT_SESSIONS roots: the oldest is forgotten", async () => {
    const rec = recorder();
    for (let i = 0; i <= MAX_ROOT_SESSIONS; i++) rec.markRootSession(`r-${i}`);
    rec.onRootStep("r-0", tokens(1, 0, 0)); // evicted: ignored
    rec.onRootStep("r-1", tokens(2, 0, 0));
    await rec.flush();
    expect(turnRows().map(r => [r.sessionID, r.input])).toEqual([["r-1", 2]]);
  });

  it("marking an already known root refreshes its recency", async () => {
    const rec = recorder();
    for (let i = 0; i < MAX_ROOT_SESSIONS; i++) rec.markRootSession(`r-${i}`);
    rec.markRootSession("r-0"); // now the most recent
    rec.markRootSession("extra"); // evicts r-1
    rec.onRootStep("r-0", tokens(1, 0, 0));
    rec.onRootStep("r-1", tokens(2, 0, 0));
    await rec.flush();
    expect(turnRows().map(r => r.sessionID)).toEqual(["r-0"]);
  });
});

describe("orchestrator turns: flush and sweep", () => {
  it("sweep flushes only turns idle for the idle time (QA-1.1-4)", async () => {
    const rec = createTimingRecorder({ dir, now, logger, turnIdleMs: 60_000 });
    rec.markRootSession("busy");
    rec.markRootSession("idle");
    rec.onRootStep("idle", tokens(1, 2, 3));
    clockNow = NOW + 50_000;
    rec.onRootStep("busy", tokens(4, 5, 6));
    clockNow = NOW + 70_000;
    await rec.sweep();
    expect(turnRows().map(r => r.sessionID)).toEqual(["idle"]);
    clockNow = NOW + 110_000;
    await rec.sweep();
    expect(turnRows().map(r => r.sessionID)).toEqual(["idle", "busy"]);
  });

  it("a sweep in the middle of a turn, more steps, then a prompt give one row", async () => {
    const rec = recorder();
    rec.markRootSession("root");
    rec.onRootStep("root", tokens(1, 1, 1));
    clockNow = NOW + 5_000;
    await rec.sweep();
    rec.onRootStep("root", tokens(1, 1, 1));
    clockNow = NOW + 10_000;
    await rec.sweep();
    rec.onRootStep("root", tokens(1, 1, 1));
    await rec.onRootPrompt("root", clockNow);
    expect(turnRows().map(r => [r.turn, r.steps])).toEqual([[1, 3]]);
  });

  it("flushes every open turn, in one call, and numbers the next turn after it", async () => {
    const rec = recorder();
    rec.markRootSession("a");
    rec.markRootSession("b");
    rec.markRootSession("idle");
    rec.onRootStep("a", tokens(1, 2, 3));
    rec.onRootStep("b", tokens(4, 5, 6));
    rec.onRootStep("b", tokens(4, 5, 6));
    await rec.flush();
    expect(turnRows().map(r => [r.sessionID, r.turn, r.steps, r.input, r.cacheRead, r.cacheWrite])).toEqual([
      ["a", 1, 1, 1, 2, 3],
      ["b", 1, 2, 8, 10, 12],
    ]);

    await rec.flush(); // nothing open any more
    expect(turnRows()).toHaveLength(2);

    rec.onRootStep("a", tokens(9, 9, 9));
    await rec.onRootPrompt("a", NOW + 2);
    expect(turnRows().map(r => [r.sessionID, r.turn])).toEqual([["a", 1], ["b", 1], ["a", 2]]);
  });

  it("defaults the time to the clock", async () => {
    const rec = recorder();
    rec.markRootSession("a");
    rec.onRootStep("a", tokens(1, 0, 0));
    clockNow = NOW + 5_000;
    await rec.flush();
    expect(turnRows()[0]?.ts).toBe(new Date(NOW + 5_000).toISOString());
  });
});

describe("orchestrator turns: failures and independence", () => {
  it("a failing turns append is logged once and the row dropped; the recorder never throws", async () => {
    let calls = 0;
    const rec = recorder(
      fakeSideLogs({
        appendTurns: async () => {
          calls += 1;
          return { ok: false, error: "read-only file system" };
        },
      }),
    );
    rec.markRootSession("root");
    for (let i = 0; i < 3; i++) {
      rec.onRootStep("root", tokens(1, 1, 1));
      await expect(rec.onRootPrompt("root", NOW)).resolves.toBeUndefined();
    }
    expect(calls).toBe(3);
    expect(logger.warns).toHaveLength(1);
    expect(logger.warns[0]?.extra).toMatchObject({ kind: "turns", error: "read-only file system" });
  });

  it("static engine: turns and timings are recorded with nothing but a directory and a clock", async () => {
    // Constructed the way phase 2.1 does it. `routing.engine: "static"` has no way in: the options carry no config.
    const rec = createTimingRecorder({ dir, now });
    rec.markRootSession("root");
    rec.onRootStep("root", tokens(10, 90, 0));
    await rec.onRootPrompt("root", NOW);
    expect(turnRows()).toHaveLength(1);
    expect(readdirSync(dir)).toEqual(["turns.jsonl"]); // no outcomes.json, decisions.jsonl or lock
  });
});
