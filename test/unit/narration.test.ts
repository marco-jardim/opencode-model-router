import { describe, it, expect } from "vitest";
import { detectNarration } from "../../src/guard/narration";

describe("detectNarration", () => {
  it("returns [] for text shorter than 20 chars", () => {
    expect(detectNarration("still writing")).toEqual([]);
    expect(detectNarration("")).toEqual([]);
  });

  it("returns [] when no narration patterns match (but text is long enough)", () => {
    expect(detectNarration("The quick brown fox jumped over the lazy dog.")).toEqual([]);
  });

  it("detects a single narration phrase", () => {
    const out = detectNarration("Still writing the parser implementation now.");
    expect(out.length).toBe(1);
    expect(out[0]?.toLowerCase()).toContain("still writing the parser");
  });

  it("detects multiple distinct patterns", () => {
    const text =
      "Still writing the parser. Let me create the module afterwards.";
    const out = detectNarration(text);
    expect(out.length).toBeGreaterThan(1);
  });

  it("dedupes repeated identical phrases (case-insensitive)", () => {
    const text = "Let me write the parser. Let me write the parser again.";
    const out = detectNarration(text);
    const lowered = out.map((s) => s.toLowerCase());
    expect(new Set(lowered).size).toBe(lowered.length);
    expect(lowered.filter((s) => s === "let me write the parser").length).toBe(1);
  });

  it("caps the result at 5 entries", () => {
    const text = [
      "Still writing the parser",
      "now implementing the cache",
      "Let me create the module",
      "I'll refactor the helper",
      "going to build the tool",
      "continuing with the cleanup",
    ].join(". ");
    const out = detectNarration(text);
    expect(out.length).toBe(5);
  });
});
