import { describe, expect, it } from "vitest";
import { createGuardStore } from "../../src/guard/store";
import type { GuardPolicy } from "../../src/guard/guards";
import { createIdleTtlSweeper } from "../../src/router/idle-sweep";
import { createSessionStore } from "../../src/router/sessions";
import { createTrajectoryStore } from "../../src/telemetry/trajectory";
import { createChangedFileStore } from "../../src/verify/dispatch";

const MINUTE_MS = 60_000;
const TTL_MS = 60 * MINUTE_MS;

function createClock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

type SessionStore = ReturnType<typeof createSessionStore>;
type RouterConfigArg = Parameters<SessionStore["registerFromChatMessage"]>[2];

function routerConfig(): RouterConfigArg {
  return {
    activePreset: "default",
    presets: {},
    rules: [],
    defaultTier: "fast",
    tierCaps: { fast: 8, medium: 5, heavy: 3 },
    taskPatterns: { fast: ["search"], medium: ["implement"], heavy: ["architecture"] },
  };
}

function guardPolicy(): GuardPolicy {
  return {
    budget: 8,
    readDraftCap: 3,
    sameOpRetryCap: 2,
    blockSelfScript: false,
    deliverableFirst: false,
  };
}

function registerSession(store: SessionStore, sessionID: string, cfg = routerConfig()) {
  return store.registerFromChatMessage(
    { agent: "fast", sessionID },
    { parts: [{ text: "search for references" }] },
    cfg,
    ["fast", "medium", "heavy"],
  );
}

function createStores(clock = createClock()) {
  return {
    clock,
    sessions: createSessionStore({ now: clock.now }),
    guard: createGuardStore({ now: clock.now }),
    trajectory: createTrajectoryStore({ now: clock.now }),
    changedFiles: createChangedFileStore({ now: clock.now }),
  };
}

describe("session-keyed store idle-TTL eviction", () => {
  it("sweeps idle sessions from sessions, guard, trajectory, and changed-file stores", () => {
    const { clock, sessions, guard, trajectory, changedFiles } = createStores();
    const policy = guardPolicy();

    registerSession(sessions, "s1");
    guard.ensure("s1", policy);
    guard.setPendingNote("s1", "pending");
    trajectory.ensure("s1", "fast");
    changedFiles.record("s1", "write", { filePath: "a.ts" });

    clock.advance(TTL_MS + 1);
    sessions.sweep();
    guard.sweep();
    trajectory.sweep();
    changedFiles.sweep();

    expect(sessions.isSubagent("s1")).toBe(false);
    expect(sessions.getTier("s1")).toBeNull();
    expect(guard.get("s1")).toBeUndefined();
    expect(guard.takePendingNote("s1")).toBeUndefined();
    expect(trajectory.get("s1")).toBeUndefined();
    expect(changedFiles.get("s1")).toEqual([]);
  });

  it("refreshes TTL when a session is touched", () => {
    const { clock, sessions, guard, trajectory, changedFiles } = createStores();
    const policy = guardPolicy();

    registerSession(sessions, "s1");
    guard.ensure("s1", policy);
    trajectory.ensure("s1", "fast");
    changedFiles.record("s1", "write", { filePath: "a.ts" });

    clock.advance(59 * MINUTE_MS);
    sessions.recordToolCall({ sessionID: "s1", tool: "read", args: { filePath: "a.ts" } }, {});
    guard.ensure("s1", policy);
    trajectory.recordToolEvent("s1", { tool: "read", readOnly: true });
    changedFiles.record("s1", "edit", { filePath: "a.ts" });

    clock.advance(2 * MINUTE_MS);
    sessions.sweep();
    guard.sweep();
    trajectory.sweep();
    changedFiles.sweep();

    expect(sessions.isSubagent("s1")).toBe(true);
    expect(guard.get("s1")).toBeDefined();
    expect(trajectory.get("s1")).toBeDefined();
    expect(changedFiles.get("s1")).toEqual([{ path: "a.ts", status: "written" }]);
  });

  it("survives the sweep when a long tool call refreshed the TTL at its start", () => {
    // A tool call that outlives the TTL used to let a concurrent session's
    // sweep evict the caller mid-call, after which recordToolCall's `!state`
    // early return silently dropped cap enforcement for the rest of the
    // session. touchIfTracked at tool.execute.before closes that window.
    const { clock, sessions } = createStores();

    registerSession(sessions, "s1");
    clock.advance(59 * MINUTE_MS);

    // tool.execute.before for a still-tracked session.
    expect(sessions.touchIfTracked("s1")).toBe(true);

    clock.advance(2 * MINUTE_MS);
    sessions.sweep();

    expect(sessions.isSubagent("s1")).toBe(true);
    expect(sessions.getTier("s1")).not.toBeNull();
  });

  it("does not create a lastTouch entry for an untracked session", () => {
    const { clock, sessions } = createStores();

    // No registration: touchIfTracked must be a no-op, not an orphan entry.
    expect(sessions.touchIfTracked("never-seen")).toBe(false);

    clock.advance(61 * MINUTE_MS);
    sessions.sweep();
    expect(sessions.isSubagent("never-seen")).toBe(false);
  });

  it("resumes after eviction as a fresh session", () => {
    const { clock, sessions } = createStores();
    const cfg = routerConfig();

    registerSession(sessions, "s1", cfg);
    sessions.recordToolCall({ sessionID: "s1", tool: "read", args: { filePath: "a.ts" } }, {});
    clock.advance(TTL_MS + 1);
    sessions.sweep();
    expect(sessions.isSubagent("s1")).toBe(false);

    registerSession(sessions, "s1", cfg);
    const outputRef: Record<string, unknown> = {};
    sessions.recordToolCall(
      { sessionID: "s1", tool: "read", args: { filePath: "a.ts" } },
      outputRef,
    );

    expect(sessions.isSubagent("s1")).toBe(true);
    // Fresh budget: the call counter and the redundancy fingerprints both reset.
    expect(outputRef.output).toContain("[cap: 1/8]");
    expect(outputRef.output).not.toContain("REDUNDANT");
  });

  it("bounds churn by evicting sessions outside the TTL window", () => {
    const { clock, sessions, guard, trajectory, changedFiles } = createStores();
    const policy = guardPolicy();
    const registeredIDs: string[] = [];

    for (let i = 0; i < 500; i += 1) {
      const sid = `s${i}`;
      registeredIDs.push(sid);
      registerSession(sessions, sid);
      guard.ensure(sid, policy);
      trajectory.ensure(sid, "fast");
      changedFiles.record(sid, "write", { filePath: `${sid}.ts` });
      clock.advance(10_000);
    }

    sessions.sweep();
    guard.sweep();
    trajectory.sweep();
    changedFiles.sweep();

    const withinTtl = Math.floor(TTL_MS / 10_000) + 1;
    const sessionSurvivors = registeredIDs.filter((sid) => sessions.isSubagent(sid));
    const guardSurvivors = registeredIDs.filter((sid) => guard.get(sid) !== undefined);
    const trajectorySurvivors = registeredIDs.filter((sid) => trajectory.get(sid) !== undefined);
    const changedFileSurvivors = registeredIDs.filter((sid) => changedFiles.get(sid).length > 0);

    expect(sessionSurvivors.length).toBeLessThanOrEqual(withinTtl);
    expect(guardSurvivors.length).toBeLessThanOrEqual(withinTtl);
    expect(trajectorySurvivors.length).toBeLessThanOrEqual(withinTtl);
    expect(changedFileSurvivors.length).toBeLessThanOrEqual(withinTtl);
  });

  it("treats calls on evicted sessions as graceful no-ops until re-register", () => {
    const { clock, sessions, guard, trajectory, changedFiles } = createStores();
    const policy = guardPolicy();

    registerSession(sessions, "s1");
    guard.ensure("s1", policy);
    trajectory.ensure("s1", "fast");
    changedFiles.record("s1", "write", { filePath: "a.ts" });
    clock.advance(TTL_MS + 1);
    sessions.sweep();
    guard.sweep();
    trajectory.sweep();
    changedFiles.sweep();

    const outputRef: Record<string, unknown> = {};
    sessions.recordToolCall({ sessionID: "s1", tool: "read", args: { filePath: "a.ts" } }, outputRef);
    expect(outputRef.output).toBeUndefined();
    expect(sessions.getTier("s1")).toBeNull();
    expect(guard.get("s1")).toBeUndefined();
    expect(trajectory.get("s1")).toBeUndefined();
    expect(changedFiles.get("s1")).toEqual([]);

    // JS-level idempotence: evicting an already-evicted session must not throw.
    expect(() => {
      sessions.unregister("s1");
      guard.clear("s1");
      trajectory.evict("s1");
      changedFiles.clear("s1");
    }).not.toThrow();
  });

  it("sweeps an empty store without error", () => {
    const { sessions, guard, trajectory, changedFiles } = createStores();

    expect(() => {
      sessions.sweep();
      guard.sweep();
      trajectory.sweep();
      changedFiles.sweep();
    }).not.toThrow();
  });

  it("never evicts a session whose lastTouch is in the future (clock skew)", () => {
    const clock = createClock(10 * TTL_MS);
    const { sessions, guard, trajectory, changedFiles } = createStores(clock);
    const policy = guardPolicy();

    registerSession(sessions, "s1");
    guard.ensure("s1", policy);
    trajectory.ensure("s1", "fast");
    changedFiles.record("s1", "write", { filePath: "a.ts" });

    // Sweep with a "now" far BEHIND the recorded stamps — a negative idle delta.
    expect(() => {
      sessions.sweep(0);
      guard.sweep(0);
      trajectory.sweep(0);
      changedFiles.sweep(0);
    }).not.toThrow();

    expect(sessions.isSubagent("s1")).toBe(true);
    expect(guard.get("s1")).toBeDefined();
    expect(trajectory.get("s1")).toBeDefined();
    expect(changedFiles.get("s1")).toEqual([{ path: "a.ts", status: "written" }]);
  });
});

describe("idle-TTL sweep coordinator", () => {
  it("throttles sweeps to at most once per five minutes", () => {
    const calls: string[] = [];
    const sweeper = createIdleTtlSweeper([
      () => calls.push("sessions"),
      () => calls.push("guard"),
      () => calls.push("trajectory"),
    ]);

    expect(sweeper(0)).toBe(true);
    expect(sweeper(4 * MINUTE_MS)).toBe(false);
    expect(sweeper(5 * MINUTE_MS)).toBe(true);
    expect(calls).toEqual(["sessions", "guard", "trajectory", "sessions", "guard", "trajectory"]);
  });

  it("honours a custom throttle window", () => {
    const calls: string[] = [];
    const sweeper = createIdleTtlSweeper([() => calls.push("x")], MINUTE_MS);

    expect(sweeper(0)).toBe(true);
    expect(sweeper(59_999)).toBe(false);
    expect(sweeper(MINUTE_MS)).toBe(true);
    expect(calls).toEqual(["x", "x"]);
  });

  it("isolates a throwing sweeper: others still run and nothing propagates", () => {
    const calls: string[] = [];
    const sweeper = createIdleTtlSweeper([
      () => calls.push("before"),
      () => {
        calls.push("boom");
        throw new Error("sweeper exploded");
      },
      () => calls.push("after"),
    ]);

    let result: boolean | undefined;
    expect(() => {
      result = sweeper(0);
    }).not.toThrow();
    expect(result).toBe(true);
    expect(calls).toEqual(["before", "boom", "after"]);

    // The throttle window is still consumed after a throwing sweep.
    expect(sweeper(MINUTE_MS)).toBe(false);
  });
});
