import { afterEach, expect, it, vi } from "vitest";
import { executorChildRound, forgetExecutorChildRound, publishExecutorChildRound } from "../../src/executor/child-guards";

afterEach(() => { forgetExecutorChildRound("round-copy"); });

it("R3-3. separate module copies share a monotonic round and keep the original cap on resume", async () => {
  publishExecutorChildRound("round-copy", "implementer", 12, false);
  const first = executorChildRound("round-copy")!;
  vi.resetModules();
  const other = await import("../../src/executor/child-guards");
  expect(other.executorChildRound("round-copy")).toEqual(first);
  other.publishExecutorChildRound("round-copy", "implementer", null, true);
  expect(executorChildRound("round-copy")).toEqual({ ...first, round: first.round + 1 });
  other.forgetExecutorChildRound("round-copy");
  expect(executorChildRound("round-copy")).toBeUndefined();
});
