import { describe, it, expect } from "vitest";
import { detectNarration } from "../../src/index";

describe("detectNarration golden", () => {
  it("short string under 20 chars", () => {
    expect(detectNarration("short")).toMatchSnapshot();
  });

  it("still writing the parser", () => {
    expect(detectNarration("Still writing the parser...")).toMatchSnapshot();
  });

  it("now i'll implement the handler", () => {
    expect(
      detectNarration("Now I'll implement the handler and then continue"),
    ).toMatchSnapshot();
  });

  it("let me check the file", () => {
    expect(detectNarration("Let me check the file")).toMatchSnapshot();
  });

  it("clean technical sentence no narration", () => {
    expect(
      detectNarration(
        "The function takes a string and returns a boolean value.",
      ),
    ).toMatchSnapshot();
  });

  it("multiple narration phrases exercises 5-item cap", () => {
    expect(
      detectNarration(
        "Still writing the parser... Now I'll implement the handler and then " +
          "Let me add the type definitions. I'll now create the test file. " +
          "Going to fix the error in line 23. Continuing with the refactor.",
      ),
    ).toMatchSnapshot();
  });
});
