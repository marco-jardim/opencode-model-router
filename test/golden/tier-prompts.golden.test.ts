import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { validateConfig } from "../../src/router/config";

// Pins the bundled per-tier subagent prompts. The snapshot guards the full
// prompt text against accidental edits; the explicit assertions below pin the
// progress-claim grounding clause, which is deliberately present on medium and
// heavy and deliberately absent on fast (fast is read-only and reports
// findings, not progress).
describe("tier prompts golden", () => {
  const cfg = validateConfig(
    JSON.parse(readFileSync(join(process.cwd(), "tiers.json"), "utf-8")),
  );

  it("tier-prompt-medium", () => {
    expect(cfg.tierPrompts?.medium).toMatchSnapshot("tier-prompt-medium");
  });

  it("tier-prompt-heavy", () => {
    expect(cfg.tierPrompts?.heavy).toMatchSnapshot("tier-prompt-heavy");
  });

  it("medium grounds progress claims in tool results", () => {
    expect(cfg.tierPrompts?.medium).toContain(
      "Before reporting progress, audit each claim against a tool result from this session.",
    );
  });

  it("heavy grounds progress claims in tool results or given context", () => {
    expect(cfg.tierPrompts?.heavy).toContain(
      "audit each claim against a tool result or the context",
    );
  });

  it("fast carries no progress-claim grounding clause", () => {
    expect(cfg.tierPrompts?.fast).not.toContain("Before reporting progress");
  });
});
