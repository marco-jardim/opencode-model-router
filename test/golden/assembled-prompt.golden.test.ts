import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { validateConfig } from "../../src/router/config";
import { assembleSystemPrompt } from "../../src/router/protocol";
import type { RouterConfig } from "../../src/index";

describe("assembled-prompt golden", () => {
  const raw = JSON.parse(
    readFileSync(join(process.cwd(), "tiers.json"), "utf-8"),
  );
  const base = validateConfig(raw);

  const modelCases: Array<{ label: string; modelID: string | undefined }> = [
    { label: "claude", modelID: "anthropic/claude-sonnet-4-6" },
    { label: "openai", modelID: "openai/gpt-5" },
    { label: "undefined", modelID: undefined },
  ];

  for (const preset of ["anthropic", "openai"]) {
    if (!base.presets[preset]) continue;

    for (const { label, modelID } of modelCases) {
      it(`assembled-prompt-${preset}-model-${label}`, () => {
        const cfg: RouterConfig = {
          ...base,
          activePreset: preset,
          activeMode: undefined,
        };
        expect(assembleSystemPrompt(cfg, modelID)).toMatchSnapshot(
          `assembled-prompt-${preset}-model-${label}`,
        );
      });
    }
  }

  // --- enforcement-on golden snapshots (new — GA-1 safe: only appended when enforcementOn=true) ---
  for (const { preset, modelID } of [
    { preset: "anthropic", modelID: "anthropic/claude-sonnet-4-6" },
    { preset: "openai", modelID: "openai/gpt-5" },
  ]) {
    if (!base.presets[preset]) continue;
    it(`assembled-prompt-${preset}-enforcement-on`, () => {
      const cfg: RouterConfig = {
        ...base,
        activePreset: preset,
        activeMode: undefined,
      };
      expect(assembleSystemPrompt(cfg, modelID, true)).toMatchSnapshot(
        `assembled-prompt-${preset}-enforcement-on`,
      );
    });
  }

  // --- GA-1 guard: default param must be byte-identical to enforcementOn=false ---
  it("default param is byte-identical to assembleSystemPrompt(cfg, m, false)", () => {
    const cfg: RouterConfig = { ...base, activePreset: "anthropic", activeMode: undefined };
    const m = "anthropic/claude-sonnet-4-6";
    expect(assembleSystemPrompt(cfg, m)).toBe(assembleSystemPrompt(cfg, m, false));
  });

  // --- [acceptance] presence: off=absent, on=present ---
  it("off output does NOT contain [acceptance]; enforcement-on output DOES", () => {
    const cfg: RouterConfig = { ...base, activePreset: "anthropic", activeMode: undefined };
    const m = "anthropic/claude-sonnet-4-6";
    expect(assembleSystemPrompt(cfg, m)).not.toContain("[acceptance]");
    expect(assembleSystemPrompt(cfg, m, true)).toContain("[acceptance]");
  });
});
