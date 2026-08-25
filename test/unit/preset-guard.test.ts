import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

// GUARD, not a regression detector. `activePreset` in the bundled tiers.json is
// the default every user inherits on install. A merge that flips it — e.g. a
// local experiment preset committed by accident, or an automerge resolving a
// tiers.json conflict in favour of the wrong side — silently repoints every
// tier at different models with no other visible symptom. This test fails loudly
// on that class of change and is expected to pass on every legitimate commit.
describe("bundled preset guard", () => {
  const raw = JSON.parse(
    readFileSync(join(process.cwd(), "tiers.json"), "utf-8"),
  ) as { activePreset?: unknown };

  it("ships with the anthropic preset active", () => {
    expect(raw.activePreset).toBe("anthropic");
  });
});
