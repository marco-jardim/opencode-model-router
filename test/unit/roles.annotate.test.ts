import { beforeEach, describe, expect, test } from "vitest";
import {
  MAX_ANNOTATED_CHILDREN,
  MAX_ANNOTATIONS_PER_CHILD,
  annotateSubagentResult,
  resetDispatchRouting,
  takeSubagentAnnotations,
} from "../../src/routing/wire/dispatch";

describe("subagent annotation seam", () => {
  beforeEach(() => resetDispatchRouting());

  test("records and is consumed once", () => {
    annotateSubagentResult("budget", "c1", "a");
    annotateSubagentResult("authority", "c1", "b");
    expect(takeSubagentAnnotations("c1")).toEqual([
      { kind: "budget", text: "a" },
      { kind: "authority", text: "b" },
    ]);
    expect(takeSubagentAnnotations("c1")).toEqual([]);
    expect(takeSubagentAnnotations("unknown")).toEqual([]);
  });

  test("is bounded per child and in children", () => {
    for (let i = 0; i < MAX_ANNOTATIONS_PER_CHILD + 3; i++) annotateSubagentResult("budget", "c", String(i));
    const kept = takeSubagentAnnotations("c");
    expect(kept).toHaveLength(MAX_ANNOTATIONS_PER_CHILD);
    expect(kept[0]?.text).toBe("3");

    for (let i = 0; i < MAX_ANNOTATED_CHILDREN + 1; i++) annotateSubagentResult("authority", `k${i}`, "x");
    expect(takeSubagentAnnotations("k0")).toEqual([]);
    expect(takeSubagentAnnotations(`k${MAX_ANNOTATED_CHILDREN}`)).toHaveLength(1);
  });
});
