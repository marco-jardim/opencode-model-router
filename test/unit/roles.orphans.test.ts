import { afterEach, describe, expect, it } from "vitest";
import { readRoleOrphans, recordRoleOrphan, resetRoleOrphansForTests, ROLE_ORPHANS_MAX, takeRoleBindingLookupNotice } from "../../src/routing/roles/orphans";

afterEach(() => resetRoleOrphansForTests());

describe("process-wide role orphan observations", () => {
  it("gives binding lookup failures their own process-once notice, independent of refusals", () => {
    expect(takeRoleBindingLookupNotice()).toBe(true);
    expect(takeRoleBindingLookupNotice()).toBe(false);
    expect(recordRoleOrphan("child", "refused")).toBe(true);
    expect(takeRoleBindingLookupNotice()).toBe(false);
    resetRoleOrphansForTests();
    expect(recordRoleOrphan("other", "refused")).toBe(true);
    expect(takeRoleBindingLookupNotice()).toBe(true);
    expect(takeRoleBindingLookupNotice()).toBe(false);
  });

  it("remembers both actions per child and offers a notice only on the first refusal", () => {
    expect(recordRoleOrphan("child", "lost", 1)).toBe(false);
    expect(recordRoleOrphan("child", "refused", 2)).toBe(true);
    expect(recordRoleOrphan("child", "refused", 3)).toBe(false);
    expect(recordRoleOrphan("other", "refused", 4)).toBe(false);
    expect(readRoleOrphans()).toEqual({
      records: [{ child: "child", lost: 1, refused: 3 }, { child: "other", refused: 4 }],
      counters: { refused: 3, lost: 1 }, noticed: true,
    });
  });

  it("bounds child records while retaining process counters and returns detached snapshots", () => {
    for (let i = 0; i <= ROLE_ORPHANS_MAX; i++) recordRoleOrphan(`child-${i}`, "lost", i);
    const snapshot = readRoleOrphans();
    expect(snapshot.records).toHaveLength(ROLE_ORPHANS_MAX);
    expect(snapshot.records[0]?.child).toBe("child-1");
    expect(snapshot.counters.lost).toBe(ROLE_ORPHANS_MAX + 1);
    recordRoleOrphan("child-1", "refused", 1000);
    expect(snapshot.noticed).toBe(false);
    expect(snapshot.counters.refused).toBe(0);
    expect(snapshot.records[0]?.refused).toBeUndefined();
  });

  it("uses the versioned global registry and replaces a foreign value", () => {
    const key = Symbol.for("opencode-model-router.role-orphans@1");
    Reflect.set(globalThis, key, { version: 0 });
    expect(recordRoleOrphan("child", "refused")).toBe(true);
    const shared: unknown = Reflect.get(globalThis, key);
    recordRoleOrphan("child", "lost");
    expect(Reflect.get(globalThis, key)).toBe(shared);
    expect(readRoleOrphans().counters).toEqual({ refused: 1, lost: 1 });
  });
});
