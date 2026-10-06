import { describe, expect, it } from "vitest";
import { ROUTING_TASK_CLASSES } from "../../src/router/config";
import { TASK_CLASSES } from "../../src/routing/classify/types";

describe("ROUTING_TASK_CLASSES (QA-1.1-29)", () => {
  it("is the classifier's TASK_CLASSES, element for element and in order", () => {
    expect([...ROUTING_TASK_CLASSES]).toEqual([...TASK_CLASSES]);
  });
});
