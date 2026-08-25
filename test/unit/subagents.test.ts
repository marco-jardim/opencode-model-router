import { describe, it, expect } from "vitest";
import {
  resolveSubagentOverrides,
  mergeSubagentOverride,
} from "../../src/router/subagents";
import type { Preset } from "../../src/router/config";

const tiers: Preset = {
  fast: { model: "github-copilot/gpt-5.6-luna", costRatio: 1 },
  medium: { model: "github-copilot/claude-sonnet-5", costRatio: 5 },
  heavy: {
    model: "github-copilot/claude-opus-5",
    variant: "high",
    costRatio: 20,
  },
};

describe("resolveSubagentOverrides", () => {
  it("is a no-op when no map is configured (opt-in)", () => {
    expect(resolveSubagentOverrides({ tiers })).toEqual({});
    expect(resolveSubagentOverrides({ subagentTiers: {}, tiers })).toEqual({});
  });

  it("maps an agent to its tier's model", () => {
    expect(
      resolveSubagentOverrides({
        subagentTiers: { ContextScout: "fast" },
        tiers,
      }),
    ).toEqual({
      ContextScout: { model: "github-copilot/gpt-5.6-luna", variant: undefined },
    });
  });

  it("carries the tier's variant through", () => {
    const out = resolveSubagentOverrides({
      subagentTiers: { SecurityReviewer: "heavy" },
      tiers,
    });
    expect(out.SecurityReviewer).toEqual({
      model: "github-copilot/claude-opus-5",
      variant: "high",
    });
  });

  it("skips a tier that the active preset does not define", () => {
    expect(
      resolveSubagentOverrides({
        subagentTiers: { Foo: "ultra", ContextScout: "fast" },
        tiers,
      }),
    ).toEqual({
      ContextScout: { model: "github-copilot/gpt-5.6-luna", variant: undefined },
    });
  });

  it("never rewrites the plugin's own tier agents", () => {
    expect(
      resolveSubagentOverrides({
        subagentTiers: { fast: "heavy", medium: "heavy" },
        tiers,
      }),
    ).toEqual({});
  });

  it("skips an agent already registered as a non-subagent", () => {
    const out = resolveSubagentOverrides({
      subagentTiers: { Architect: "heavy", CodeReviewer: "medium" },
      tiers,
      existingAgents: {
        Architect: { mode: "primary" },
        CodeReviewer: { mode: "subagent" },
      },
    });
    expect(Object.keys(out)).toEqual(["CodeReviewer"]);
  });

  it("applies when an existing entry declares no mode", () => {
    const out = resolveSubagentOverrides({
      subagentTiers: { DocWriter: "medium" },
      tiers,
      existingAgents: { DocWriter: { description: "docs" } },
    });
    expect(out.DocWriter?.model).toBe("github-copilot/claude-sonnet-5");
  });

  it("ignores malformed entries without throwing", () => {
    const out = resolveSubagentOverrides({
      subagentTiers: {
        A: "",
        "": "fast",
        C: undefined as unknown as string,
        D: 3 as unknown as string,
        Good: "fast",
      },
      tiers,
    });
    expect(Object.keys(out)).toEqual(["Good"]);
  });

  it("skips a tier whose model is missing or empty", () => {
    const broken: Preset = {
      fast: { model: "" },
      medium: { model: "m" },
    };
    const out = resolveSubagentOverrides({
      subagentTiers: { A: "fast", B: "medium" },
      tiers: broken,
    });
    expect(Object.keys(out)).toEqual(["B"]);
  });
});

describe("mergeSubagentOverride", () => {
  it("creates an entry when the agent has no existing config", () => {
    expect(
      mergeSubagentOverride(undefined, { model: "m", variant: undefined }),
    ).toEqual({ model: "m" });
  });

  it("preserves unrelated fields on an existing entry", () => {
    const out = mergeSubagentOverride(
      { description: "keep me", mode: "subagent", maxSteps: 40 },
      { model: "m", variant: undefined },
    );
    expect(out).toEqual({
      description: "keep me",
      mode: "subagent",
      maxSteps: 40,
      model: "m",
    });
  });

  it("overwrites a previously pinned model", () => {
    const out = mergeSubagentOverride(
      { model: "github-copilot/gpt-5.6-luna" },
      { model: "github-copilot/claude-sonnet-5", variant: undefined },
    );
    expect(out.model).toBe("github-copilot/claude-sonnet-5");
  });

  it("sets the variant when the tier has one", () => {
    expect(
      mergeSubagentOverride({}, { model: "m", variant: "high" }),
    ).toEqual({ model: "m", variant: "high" });
  });

  it("clears an inherited variant when the tier has none", () => {
    const out = mergeSubagentOverride(
      { model: "old", variant: "max" },
      { model: "new", variant: undefined },
    );
    expect(out).toEqual({ model: "new" });
    expect("variant" in out).toBe(false);
  });

  it("ignores a non-object existing entry", () => {
    expect(
      mergeSubagentOverride("nonsense", { model: "m", variant: undefined }),
    ).toEqual({ model: "m" });
  });
});
