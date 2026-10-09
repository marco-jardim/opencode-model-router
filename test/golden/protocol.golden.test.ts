import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { validateConfig } from "../../src/router/config";
import { buildDelegationProtocol } from "../../src/router/protocol";
import type { RouterConfig } from "../../src/index";
import { withLegacyPresets } from "../helpers/legacy-presets";

describe("protocol golden", () => {
  // 2.6.0 dropped `hybrid-2` and `fable-effort` from the bundled tiers.json. Their 2.5.0 blocks are put back here, as a user's
  // `presets` override would, so the `protocol-hybrid-2` and `protocol-fable-effort` snapshots stay pinned byte for byte.
  const raw = withLegacyPresets(
    JSON.parse(readFileSync(join(process.cwd(), "tiers.json"), "utf-8")),
    ["hybrid-2", "fable-effort"],
  );
  const base = validateConfig(raw);

  for (const preset of Object.keys(base.presets)) {
    it(`protocol-${preset}`, () => {
      const cfg: RouterConfig = {
        ...base,
        activePreset: preset,
        activeMode: undefined,
      };
      expect(buildDelegationProtocol(cfg)).toMatchSnapshot(
        `protocol-${preset}`,
      );
    });
  }

  for (const m of Object.keys(base.modes ?? {})) {
    it(`protocol-anthropic-mode-${m}`, () => {
      const cfg: RouterConfig = {
        ...base,
        activePreset: "anthropic",
        activeMode: m,
      };
      expect(buildDelegationProtocol(cfg)).toMatchSnapshot(
        `protocol-anthropic-mode-${m}`,
      );
    });
  }
});
