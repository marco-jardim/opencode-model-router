import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAgentOptions } from "../../src/router/agent-options";
import { validateConfig } from "../../src/router/config";
import { withLegacyPresets } from "../helpers/legacy-presets";

// 2.6.0 removed `fable-effort` from the bundled tiers.json. A user who keeps it copies the 2.5.0 block
// into `presets` of the overrides file; the snapshots below are that block, so they are unchanged from
// when the preset was bundled.
describe("fable-effort preset golden", () => {
  const raw = JSON.parse(readFileSync(join(process.cwd(), "tiers.json"), "utf-8"));
  const base = validateConfig(withLegacyPresets(raw, ["fable-effort"]));

  it("is no longer bundled", () => {
    expect(Object.keys(validateConfig(raw).presets)).not.toContain("fable-effort");
  });

  it("matches the fable-effort preset snapshot", () => {
    expect(base.presets["fable-effort"]).toMatchSnapshot();
  });

  it("matches the assembled agent options snapshot", () => {
    const preset = base.presets["fable-effort"];
    expect(
      Object.fromEntries(
        Object.entries(preset).map(([name, tier]) => [name, buildAgentOptions(tier, name)]),
      ),
    ).toMatchSnapshot();
  });
});
