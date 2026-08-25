import { describe, it, expect } from "vitest";
import { stripJsonc, parseJsonc } from "../../src/router/jsonc";

describe("parseJsonc", () => {
  it("removes line and block comments", () => {
    expect(
      parseJsonc(`{
        // a line comment
        "a": 1, /* inline block */ "b": 2
        /* multi
           line */
      }`),
    ).toEqual({ a: 1, b: 2 });
  });

  it("removes trailing commas in objects and arrays", () => {
    expect(parseJsonc(`{ "a": [1, 2, 3,], "b": 2, }`)).toEqual({
      a: [1, 2, 3],
      b: 2,
    });
  });

  it("drops a trailing comma even when a comment sits before the closer", () => {
    expect(parseJsonc(`{ "a": 1, /* note */ }`)).toEqual({ a: 1 });
  });

  it("preserves //, /* and , that appear inside strings", () => {
    expect(
      parseJsonc(
        `{ "url": "https://x/y", "note": "a, b", "p": "/* not a comment */" }`,
      ),
    ).toEqual({ url: "https://x/y", note: "a, b", p: "/* not a comment */" });
  });

  it("handles escaped quotes inside strings", () => {
    expect(parseJsonc(`{ "q": "she said \\"hi\\" // still in string" }`)).toEqual({
      q: 'she said "hi" // still in string',
    });
  });

  it("passes plain JSON through unchanged", () => {
    expect(parseJsonc(`{"a":1,"b":[2,3]}`)).toEqual({ a: 1, b: [2, 3] });
  });

  it("throws on genuinely invalid JSON", () => {
    expect(() => parseJsonc("{ nope ")).toThrow();
  });

  it("throws on an unterminated block comment after a complete value", () => {
    expect(() => parseJsonc(`{"a":1} /* never closed`)).toThrow(
      /unterminated block comment/,
    );
  });

  it("still accepts a terminated comment after a complete value", () => {
    expect(parseJsonc(`{"a":1} /* fine */`)).toEqual({ a: 1 });
  });
});

describe("stripJsonc", () => {
  it("leaves a non-trailing comma intact", () => {
    expect(stripJsonc(`{"a":1, "b":2}`)).toBe(`{"a":1, "b":2}`);
  });

  it("keeps newlines when removing line comments", () => {
    expect(stripJsonc("a // c\nb")).toBe("a \nb");
  });
});
