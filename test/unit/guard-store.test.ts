import { describe, it, expect } from "vitest";
import { createGuardStore } from "../../src/guard/store";
import type { GuardPolicy } from "../../src/guard/guards";

const basePolicy: GuardPolicy = {
  budget: 10,
  readDraftCap: 5,
  sameOpRetryCap: 2,
  blockSelfScript: true,
  deliverableFirst: false,
};

describe("createGuardStore", () => {
  it("ensure() creates a new state on first call", () => {
    const store = createGuardStore();
    const state = store.ensure("s1", basePolicy);
    expect(state).toBeDefined();
    expect(state.budget).toBe(10);
    expect(state.toolCallCount).toBe(0);
  });

  it("ensure() returns the same instance on subsequent calls", () => {
    const store = createGuardStore();
    const first = store.ensure("s1", basePolicy);
    const second = store.ensure("s1", { ...basePolicy, budget: 99 });
    expect(first).toBe(second); // same reference, second call ignored
    expect(second.budget).toBe(10); // original budget unchanged
  });

  it("get() returns undefined before ensure()", () => {
    const store = createGuardStore();
    expect(store.get("unknown")).toBeUndefined();
  });

  it("get() returns state after ensure()", () => {
    const store = createGuardStore();
    store.ensure("s1", basePolicy);
    expect(store.get("s1")).toBeDefined();
  });

  it("setPendingNote / takePendingNote round-trips", () => {
    const store = createGuardStore();
    store.setPendingNote("s1", "my advisory note");
    expect(store.takePendingNote("s1")).toBe("my advisory note");
  });

  it("takePendingNote clears the note after first take", () => {
    const store = createGuardStore();
    store.setPendingNote("s1", "note");
    store.takePendingNote("s1");
    expect(store.takePendingNote("s1")).toBeUndefined();
  });

  it("takePendingNote returns undefined when no note set", () => {
    const store = createGuardStore();
    expect(store.takePendingNote("s1")).toBeUndefined();
  });

  it("clear() removes state and pending note", () => {
    const store = createGuardStore();
    store.ensure("s1", basePolicy);
    store.setPendingNote("s1", "note");
    store.clear("s1");
    expect(store.get("s1")).toBeUndefined();
    expect(store.takePendingNote("s1")).toBeUndefined();
  });

  it("two different sessionIDs are isolated — state", () => {
    const store = createGuardStore();
    const s1 = store.ensure("s1", basePolicy);
    const s2 = store.ensure("s2", { ...basePolicy, budget: 20 });
    expect(s1).not.toBe(s2);
    expect(s1.budget).toBe(10);
    expect(s2.budget).toBe(20);
  });

  it("two different sessionIDs are isolated — pending notes", () => {
    const store = createGuardStore();
    store.setPendingNote("s1", "note-1");
    expect(store.takePendingNote("s2")).toBeUndefined();
    expect(store.takePendingNote("s1")).toBe("note-1");
  });

  it("clear() on one session does not affect the other", () => {
    const store = createGuardStore();
    store.ensure("s1", basePolicy);
    store.ensure("s2", basePolicy);
    store.clear("s1");
    expect(store.get("s1")).toBeUndefined();
    expect(store.get("s2")).toBeDefined();
  });
});
