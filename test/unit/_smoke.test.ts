import { describe, it, expect } from "vitest";

// Proves the Vitest runner + TS/ESM resolution works end-to-end.
// This is the Phase 0.1 infrastructure smoke (not a real-OpenCode smoke).
describe("vitest runner smoke", () => {
  it("evaluates a trivial assertion", () => {
    expect(1 + 1).toBe(2);
  });

  it("supports async tests", async () => {
    const v = await Promise.resolve("ok");
    expect(v).toBe("ok");
  });
});
