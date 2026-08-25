import { describe, it, expect } from "vitest";
import {
  createTrajectory,
  recordToolEvent,
  setStopReason,
  trajectoryMetrics,
  dumpTrajectory,
  createTrajectoryStore,
} from "../../src/telemetry/trajectory";

// ---------------------------------------------------------------------------
// createTrajectory
// ---------------------------------------------------------------------------

describe("createTrajectory", () => {
  it("initialises all counters to zero and all nullables to null/false when no tier given", () => {
    const s = createTrajectory("s1");
    expect(s.sessionID).toBe("s1");
    expect(s.tier).toBeNull();
    expect(s.toolCallCount).toBe(0);
    expect(s.readCount).toBe(0);
    expect(s.execCount).toBe(0);
    expect(s.selfScriptCount).toBe(0);
    expect(s.redundantCount).toBe(0);
    expect(s.blockedCount).toBe(0);
    expect(s.deliverableExecuted).toBe(false);
    expect(s.ttfa).toBeNull();
    expect(s.stopReason).toBeNull();
    expect(s.dodSource).toBeNull();
    expect(s.verdict).toBeNull();
    expect(s.verifyMethod).toBeNull();
    expect(s.graderTier).toBeNull();
    expect(s.attempts).toBe(0);
    expect(s.escalations).toBe(0);
    expect(s.finalTier).toBeNull();
    expect(s.costUnits).toBe(0);
    expect(s.dispatches).toBe(1);
  });

  it("records tier when explicitly provided", () => {
    const s = createTrajectory("s2", "fast");
    expect(s.tier).toBe("fast");
  });

  it("tier is null when explicitly passed null", () => {
    const s = createTrajectory("s3", null);
    expect(s.tier).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// recordToolEvent
// ---------------------------------------------------------------------------

describe("recordToolEvent", () => {
  it("increments toolCallCount and readCount for a readOnly event; ttfa stays null", () => {
    const s = createTrajectory("s1");
    recordToolEvent(s, { tool: "grep", readOnly: true });
    expect(s.toolCallCount).toBe(1);
    expect(s.readCount).toBe(1);
    expect(s.execCount).toBe(0);
    expect(s.ttfa).toBeNull();
  });

  it("increments toolCallCount and execCount for a producing event; sets ttfa on first", () => {
    const s = createTrajectory("s1");
    recordToolEvent(s, { tool: "write", readOnly: false });
    expect(s.toolCallCount).toBe(1);
    expect(s.execCount).toBe(1);
    expect(s.readCount).toBe(0);
    expect(s.ttfa).toBe(1);
  });

  it("ttfa is set to the 1-based index of the first producing call and never overwritten", () => {
    const s = createTrajectory("s1");
    // call 1: read-only — no ttfa
    recordToolEvent(s, { tool: "grep", readOnly: true });
    // call 2: first producing — ttfa = 2
    recordToolEvent(s, { tool: "write", readOnly: false });
    expect(s.ttfa).toBe(2);
    // call 3: second producing — ttfa must remain 2
    recordToolEvent(s, { tool: "bash", readOnly: false });
    expect(s.ttfa).toBe(2);
    expect(s.execCount).toBe(2);
  });

  it("blocked call still increments toolCallCount and blockedCount", () => {
    const s = createTrajectory("s1");
    recordToolEvent(s, { tool: "bash", readOnly: false, blocked: true });
    expect(s.toolCallCount).toBe(1);
    expect(s.blockedCount).toBe(1);
  });

  it("non-blocked call does not increment blockedCount", () => {
    const s = createTrajectory("s1");
    recordToolEvent(s, { tool: "bash", readOnly: false });
    expect(s.blockedCount).toBe(0);
  });

  it("selfScript=true increments selfScriptCount", () => {
    const s = createTrajectory("s1");
    recordToolEvent(s, { tool: "write", readOnly: false, selfScript: true });
    expect(s.selfScriptCount).toBe(1);
  });

  it("selfScript absent — selfScriptCount stays 0", () => {
    const s = createTrajectory("s1");
    recordToolEvent(s, { tool: "write", readOnly: false });
    expect(s.selfScriptCount).toBe(0);
  });

  it("redundant=true increments redundantCount", () => {
    const s = createTrajectory("s1");
    recordToolEvent(s, { tool: "grep", readOnly: true, redundant: true });
    expect(s.redundantCount).toBe(1);
  });

  it("redundant absent — redundantCount stays 0", () => {
    const s = createTrajectory("s1");
    recordToolEvent(s, { tool: "grep", readOnly: true });
    expect(s.redundantCount).toBe(0);
  });

  it("deliverable=true sets deliverableExecuted", () => {
    const s = createTrajectory("s1");
    expect(s.deliverableExecuted).toBe(false);
    recordToolEvent(s, { tool: "write", readOnly: false, deliverable: true });
    expect(s.deliverableExecuted).toBe(true);
  });

  it("deliverable absent — deliverableExecuted stays false", () => {
    const s = createTrajectory("s1");
    recordToolEvent(s, { tool: "write", readOnly: false });
    expect(s.deliverableExecuted).toBe(false);
  });

  it("explicit producing=true overrides readOnly=true (counts in both readCount and execCount)", () => {
    const s = createTrajectory("s1");
    recordToolEvent(s, { tool: "read", readOnly: true, producing: true });
    expect(s.readCount).toBe(1);
    expect(s.execCount).toBe(1);
    expect(s.ttfa).toBe(1);
  });

  it("explicit producing=false overrides readOnly=false (not counted in execCount)", () => {
    const s = createTrajectory("s1");
    recordToolEvent(s, { tool: "bash", readOnly: false, producing: false });
    expect(s.execCount).toBe(0);
    expect(s.ttfa).toBeNull();
    expect(s.toolCallCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// setStopReason
// ---------------------------------------------------------------------------

describe("setStopReason", () => {
  it("sets reason when null", () => {
    const s = createTrajectory("s1");
    setStopReason(s, "cap");
    expect(s.stopReason).toBe("cap");
  });

  it("is set-once — subsequent calls are ignored", () => {
    const s = createTrajectory("s1");
    setStopReason(s, "first");
    setStopReason(s, "second");
    expect(s.stopReason).toBe("first");
  });
});

// ---------------------------------------------------------------------------
// trajectoryMetrics
// ---------------------------------------------------------------------------

describe("trajectoryMetrics", () => {
  it("returns the expected set of snake_case keys", () => {
    const s = createTrajectory("s1");
    const m = trajectoryMetrics(s);
    expect(Object.keys(m).sort()).toEqual(
      [
        "ttfa",
        "read_exec_ratio",
        "self_script_count",
        "deliverable_executed",
        "tool_call_count",
        "stop_reason",
        "dod_source",
        "verdict",
        "verify_method",
        "grader_tier",
        "attempts",
        "escalations",
        "final_tier",
        "cost_units",
        "dispatches",
      ].sort(),
    );
  });

  it("read_exec_ratio is 0 when both readCount and execCount are 0", () => {
    const s = createTrajectory("s1");
    expect(trajectoryMetrics(s).read_exec_ratio).toBe(0);
  });

  it("read_exec_ratio equals readCount when execCount is 0 but readCount > 0", () => {
    const s = createTrajectory("s1");
    recordToolEvent(s, { tool: "grep", readOnly: true });
    recordToolEvent(s, { tool: "grep", readOnly: true });
    expect(trajectoryMetrics(s).read_exec_ratio).toBe(2);
  });

  it("read_exec_ratio is readCount/execCount when execCount > 0", () => {
    const s = createTrajectory("s1");
    recordToolEvent(s, { tool: "grep", readOnly: true });
    recordToolEvent(s, { tool: "grep", readOnly: true });
    recordToolEvent(s, { tool: "write", readOnly: false });
    expect(trajectoryMetrics(s).read_exec_ratio).toBe(2); // 2/1
  });

  it("reflects accumulated state correctly", () => {
    const s = createTrajectory("s1", "heavy");
    recordToolEvent(s, { tool: "write", readOnly: false, deliverable: true });
    setStopReason(s, "done");
    const m = trajectoryMetrics(s);
    expect(m.ttfa).toBe(1);
    expect(m.deliverable_executed).toBe(true);
    expect(m.tool_call_count).toBe(1);
    expect(m.stop_reason).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// dumpTrajectory
// ---------------------------------------------------------------------------

describe("dumpTrajectory", () => {
  it("returns a string prefixed with [trajectory <sessionID>] containing JSON metrics", () => {
    const s = createTrajectory("my-session");
    const d = dumpTrajectory(s);
    expect(d.startsWith("[trajectory my-session] ")).toBe(true);
    expect(d).toContain("tool_call_count");
  });

  it("is a single line (no embedded newlines)", () => {
    const s = createTrajectory("s1");
    expect(dumpTrajectory(s)).not.toContain("\n");
  });

  it("emits nothing to stdout/stderr (pure — returns string only)", () => {
    const s = createTrajectory("s1");
    const original = console.log;
    const calls: unknown[] = [];
    console.log = (...a: unknown[]) => calls.push(a);
    dumpTrajectory(s);
    console.log = original;
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// createTrajectoryStore
// ---------------------------------------------------------------------------

describe("createTrajectoryStore", () => {
  it("ensure creates a new trajectory when session is absent", () => {
    const store = createTrajectoryStore();
    const s = store.ensure("s1", "fast");
    expect(s.sessionID).toBe("s1");
    expect(s.tier).toBe("fast");
  });

  it("ensure returns the existing trajectory on subsequent calls", () => {
    const store = createTrajectoryStore();
    const s1 = store.ensure("s1");
    const s2 = store.ensure("s1");
    expect(s1).toBe(s2);
  });

  it("get returns undefined for an unknown session", () => {
    const store = createTrajectoryStore();
    expect(store.get("unknown")).toBeUndefined();
  });

  it("get returns the trajectory after ensure", () => {
    const store = createTrajectoryStore();
    store.ensure("s1");
    expect(store.get("s1")).toBeDefined();
  });

  it("recordToolEvent creates session if absent and records event", () => {
    const store = createTrajectoryStore();
    store.recordToolEvent("s1", { tool: "write", readOnly: false });
    const s = store.get("s1");
    expect(s?.toolCallCount).toBe(1);
    expect(s?.execCount).toBe(1);
  });

  it("recordToolEvent accumulates on existing session", () => {
    const store = createTrajectoryStore();
    store.ensure("s1");
    store.recordToolEvent("s1", { tool: "grep", readOnly: true });
    store.recordToolEvent("s1", { tool: "write", readOnly: false });
    expect(store.get("s1")?.toolCallCount).toBe(2);
  });

  it("recordResume increments dispatch count on an existing session", () => {
    const store = createTrajectoryStore();
    store.ensure("s1");
    store.recordResume("s1");
    expect(store.get("s1")?.dispatches).toBe(2);
  });

  it("recordResume counts a dispatch without counting an escalation, attempt or cost", () => {
    const store = createTrajectoryStore();
    const before = store.ensure("resume-is-dispatch", "fast");
    recordToolEvent(before, { tool: "write", readOnly: false });
    const beforeEscalations = before.escalations;
    const beforeAttempts = before.attempts;
    const beforeCostUnits = before.costUnits;

    store.recordResume("resume-is-dispatch", "fast");

    const after = store.get("resume-is-dispatch");
    expect(after?.dispatches).toBe(2);
    expect(after?.escalations).toBe(beforeEscalations);
    expect(after?.attempts).toBe(beforeAttempts);
    expect(after?.costUnits).toBe(beforeCostUnits);
    expect(after?.toolCallCount).toBe(1);
  });

  it("recordResume ensure-creates unknown sessions, then counts the resume as dispatch 2", () => {
    const store = createTrajectoryStore();
    store.recordResume("missing");

    // ensureState starts brand-new trajectories at dispatch 1; recordResume then
    // bumps for the resumed dispatch that caused creation.
    expect(store.get("missing")?.dispatches).toBe(2);
  });

  it("setStopReason is a no-op for an unknown session (does not throw)", () => {
    const store = createTrajectoryStore();
    expect(() => store.setStopReason("unknown", "cap")).not.toThrow();
  });

  it("setStopReason sets reason on a known session", () => {
    const store = createTrajectoryStore();
    store.ensure("s1");
    store.setStopReason("s1", "cap");
    expect(store.get("s1")?.stopReason).toBe("cap");
  });

  it("dump returns null for an unknown session", () => {
    const store = createTrajectoryStore();
    expect(store.dump("unknown")).toBeNull();
  });

  it("dump returns a trajectory string for a known session", () => {
    const store = createTrajectoryStore();
    store.ensure("s1");
    const d = store.dump("s1");
    expect(d).not.toBeNull();
    expect(d).toContain("[trajectory s1]");
  });

  it("each store instance has isolated state", () => {
    const a = createTrajectoryStore();
    const b = createTrajectoryStore();
    a.ensure("s1");
    expect(b.get("s1")).toBeUndefined();
  });
});
