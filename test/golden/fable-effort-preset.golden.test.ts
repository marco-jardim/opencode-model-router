import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAgentOptions } from "../../src/router/agent-options";
import { validateConfig } from "../../src/router/config";

describe("fable-effort preset golden", () => {
  const raw = JSON.parse(readFileSync(join(process.cwd(), "tiers.json"), "utf-8"));
  const base = validateConfig(raw);

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
