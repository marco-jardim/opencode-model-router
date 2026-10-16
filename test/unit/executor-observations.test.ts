import { describe, expect, it, vi } from "vitest";
import { checkV2ObservationStream, createV2Observations } from "../../src/compat/v2-observations";
import { createNodeClock } from "../../src/executor/ledger";
import { attachSlotObservations, detachSlotObservations, observeSchedulerLedger, observeSlotPool } from "../../src/executor/observations";
import type { LedgerWriter } from "../../src/executor/types";
import { buildDraft, taskNode } from "../fixtures/cpx/ledger/builders";

function writer(planId = "plan-one", parent = "parent"): LedgerWriter {
  const ledger = buildDraft(0, planId);
  ledger.orchestrator.sessionID = parent;
  ledger.tasks.T1 = taskNode("T1", { slot: "slot-1" });
  const unexpected = async (): Promise<never> => { throw new Error("diagnostics must not use the writer"); };
  return { planId, ledger, append: unexpected, snapshot: unexpected, close: unexpected,
    openIntegration: () => { throw new Error("diagnostic query"); }, wakeKeys: () => { throw new Error("diagnostic query"); } };
}

describe("executor physical-slot observation plumbing", () => {
  it("off and detached never evaluate slot or ledger projections", () => {
    const clock = createNodeClock(), w = writer();
    const make = vi.fn(() => { throw new Error("must stay lazy"); });
    attachSlotObservations(undefined, clock, w);
    observeSlotPool(clock, w.planId, "slot-state", make);
    observeSchedulerLedger(undefined, new Proxy(w.ledger, { get: make }), "ledger");
    expect(make).not.toHaveBeenCalled();
    const sink = createV2Observations({ write() {} });
    attachSlotObservations(sink, clock, w);
    detachSlotObservations(clock, w);
    observeSlotPool(clock, w.planId, "slot-state", make);
    expect(make).not.toHaveBeenCalled();
  });

  it("scopes lazy pools by executor clock and plan, follows reattachment, and projects task.slot", async () => {
    const clock = createNodeClock(), otherClock = createNodeClock(), lines: string[] = [];
    const sink = createV2Observations({ write: line => { lines.push(line); } });
    const old = writer(), next = writer("plan-one", "adopter"), otherPlan = writer("plan-two", "other");
    attachSlotObservations(sink, clock, old);
    attachSlotObservations(sink, clock, otherPlan);
    observeSlotPool(otherClock, old.planId, "wrong-clock", () => null);
    observeSlotPool(clock, "unknown", "wrong-plan", () => null);
    observeSlotPool(clock, old.planId, "before", () => ({ slot: "slot-1" }));
    attachSlotObservations(sink, clock, next);
    detachSlotObservations(clock, old); // A stale attachment cannot remove its replacement's port.
    observeSlotPool(clock, next.planId, "after", () => ({ slot: "slot-1" }));
    observeSlotPool(clock, otherPlan.planId, "other", () => null);
    observeSchedulerLedger(sink, next.ledger, "ledger");
    detachSlotObservations(clock, next);
    detachSlotObservations(clock, otherPlan);
    await sink.close();
    const rows = checkV2ObservationStream(lines);
    expect(rows.map(r => r.family === "scheduler" ? [r.action, r.planId, r.parentSessionID] : [])).toEqual([
      ["before", "plan-one", "parent"], ["after", "plan-one", "adopter"], ["other", "plan-two", "other"], ["ledger", "plan-one", "adopter"],
    ]);
    expect(rows.at(-1)).toMatchObject({ state: { tasks: [{ id: "T1", slot: "slot-1" }] } });
    expect(lines.join("")).not.toContain("C:/");
  });

  it("contains projection and observer failures without changing pool callers", () => {
    const clock = createNodeClock(), w = writer();
    const sink = createV2Observations({ write() {} });
    attachSlotObservations(sink, clock, w);
    expect(() => observeSlotPool(clock, w.planId, "slot-state", () => { throw new Error("projection failed"); })).not.toThrow();
    expect(sink.counts().failed).toBe(1);
    sink.record = () => { throw new Error("observer failed"); };
    expect(() => observeSlotPool(clock, w.planId, "slot-state", () => null)).not.toThrow();
    detachSlotObservations(clock, w);
  });

  it("invalidates a legacy/path-shaped ledger slot instead of leaking it or reporting no slot", async () => {
    const w = writer(), lines: string[] = [];
    w.ledger.tasks.T1!.slot = "D:\\private\\slot-1";
    const sink = createV2Observations({ write: line => { lines.push(line); } });
    expect(() => observeSchedulerLedger(sink, w.ledger, "ledger")).not.toThrow();
    await sink.close();
    expect(sink.counts().failed).toBe(1);
    expect(lines.join("")).not.toContain("private");
    expect(() => checkV2ObservationStream(lines)).toThrow();
  });
});
