import { describe, it, expect } from "vitest";
import { applyRouteLine, parseRouteLine } from "../../src/routing/classify/route-line";
import type { RouteLine, TaskFacts } from "../../src/routing/classify/types";

const base: TaskFacts = {
  class: "search",
  risk: "low",
  scope: "single",
  needs: [],
  confidence: 0.8,
  source: "rules",
};

describe("parseRouteLine", () => {
  it("returns no line and the text untouched when there is no route marker", () => {
    const text = "grep for foo\nand report";
    expect(parseRouteLine(text)).toEqual({ line: null, count: 0, stripped: text });
  });

  it("a bare [route] parses with every field absent, pin false, and is stripped", () => {
    const parsed = parseRouteLine("[route]\ngrep for foo");
    expect(parsed.line).toEqual({ pin: false, ignored: [] });
    expect(parsed.count).toBe(1);
    expect(parsed.stripped).toBe("grep for foo");
  });

  it.each([
    ["[route class=design]", { class: "design" }],
    ["[route risk=high]", { risk: "high" }],
    ["[route scope=repo]", { scope: "repo" }],
    ["[route needs=shell,edit]", { needs: ["shell", "edit"] }],
    ["[route d=grader]", { detection: "grader" }],
    ["[route d=none]", { detection: "none" }],
    ["[route pin]", { pin: true }],
  ] as const)("%s parses one field", (text, expected) => {
    const parsed = parseRouteLine(text);
    expect(parsed.line).toMatchObject(expected);
    expect(parsed.line?.ignored).toEqual([]);
  });

  it("tolerates spacing, case and order: [route  risk = high   class=implement ]", () => {
    const parsed = parseRouteLine("[route  risk = high   class=implement ]");
    expect(parsed.line).toMatchObject({ risk: "high", class: "implement" });
    expect(parseRouteLine("[ROUTE CLASS=Debug Scope=MULTI]").line).toMatchObject({
      class: "debug",
      scope: "multi",
    });
    expect(parseRouteLine("  [route class=review]  ").line).toMatchObject({ class: "review" });
  });

  it("trailing commas and semicolons on values are tolerated", () => {
    expect(parseRouteLine("[route class=implement, risk=high;]").line).toMatchObject({
      class: "implement",
      risk: "high",
    });
  });

  it("unknown fields and invalid values are ignored and listed", () => {
    const parsed = parseRouteLine("[route foo=bar class=banana risk=high pin=maybe scope]");
    expect(parsed.line).toMatchObject({ risk: "high", pin: false });
    expect(parsed.line?.class).toBeUndefined();
    expect(parsed.line?.ignored).toEqual(["foo", "class", "pin", "scope"]);
  });

  it("a duplicate key keeps the first value and lists dup:<key>", () => {
    const parsed = parseRouteLine("[route class=debug class=design]");
    expect(parsed.line?.class).toBe("debug");
    expect(parsed.line?.ignored).toEqual(["dup:class"]);
  });

  it("needs: invalid tokens are dropped, the rest unique and in NEEDS order", () => {
    expect(parseRouteLine("[route needs=shell,,banana]").line?.needs).toEqual(["shell"]);
    expect(parseRouteLine("[route needs=external_dir,edit,shell,edit]").line?.needs).toEqual([
      "shell",
      "edit",
      "external_dir",
    ]);
  });

  it("needs with no valid token is absent and ignored", () => {
    const parsed = parseRouteLine("[route needs=banana]");
    expect(parsed.line?.needs).toBeUndefined();
    expect(parsed.line?.ignored).toEqual(["needs"]);
  });

  it("d=deterministic is a valid detection; d=bogus is ignored", () => {
    expect(parseRouteLine("[route class=implement d=deterministic]").line?.detection).toBe("deterministic");
    const bogus = parseRouteLine("[route class=implement d=bogus]");
    expect(bogus.line?.detection).toBeUndefined();
    expect(bogus.line?.ignored).toContain("d");
  });

  it("pin: bare, true/yes/1 are true; false/no/0 are false", () => {
    expect(parseRouteLine("[route pin]").line?.pin).toBe(true);
    for (const v of ["true", "yes", "1"]) expect(parseRouteLine(`[route pin=${v}]`).line?.pin).toBe(true);
    for (const v of ["false", "no", "0"]) expect(parseRouteLine(`[route pin=${v}]`).line?.pin).toBe(false);
    expect(parseRouteLine("[route class=design]").line?.pin).toBe(false);
  });

  it("a mention inside a sentence or backticks is text, not a route line", () => {
    const sentence = "Use a [route class=design] line when needed";
    expect(parseRouteLine(sentence)).toEqual({ line: null, count: 0, stripped: sentence });
    const ticks = "write `[route class=design]` on its own line";
    expect(parseRouteLine(ticks).line).toBeNull();
    const fenced = "```\n[route class=design]\n```";
    expect(parseRouteLine(fenced).count).toBe(1);
  });

  it("only the first route line is parsed; every one is counted and stripped", () => {
    const text = "[route class=design]\ndo the thing\n[route class=debug risk=high]\nmore";
    const parsed = parseRouteLine(text);
    expect(parsed.count).toBe(2);
    expect(parsed.line?.class).toBe("design");
    expect(parsed.stripped).toBe("do the thing\nmore");
  });

  it("CRLF text keeps every other byte", () => {
    const text = "first\r\n[route class=design]\r\nsecond\r\n\r\nthird\r\n";
    expect(parseRouteLine(text).stripped).toBe("first\r\nsecond\r\n\r\nthird\r\n");
    expect(parseRouteLine("a\r[route risk=low]\rb").stripped).toBe("a\rb");
  });

  it("a route line as the last line, without a terminator", () => {
    const parsed = parseRouteLine("do the thing\n[route class=search]");
    expect(parsed.stripped).toBe("do the thing\n");
    expect(parsed.line?.class).toBe("search");
    expect(parseRouteLine("[route class=search]").stripped).toBe("");
  });

  it("non-string input does not throw", () => {
    expect(parseRouteLine(undefined as unknown as string)).toEqual({ line: null, count: 0, stripped: "" });
  });
});

describe("applyRouteLine", () => {
  const line = (fields: Partial<RouteLine>): RouteLine => ({ pin: false, ignored: [], ...fields });

  it("a class override sets confidence 0.9 and source route-line", () => {
    const facts = applyRouteLine(base, line({ class: "design" }));
    expect(facts).toMatchObject({ class: "design", confidence: 0.9, source: "route-line" });
  });

  it("a class with d= makes the source plan", () => {
    const facts = applyRouteLine(base, line({ class: "implement", detection: "grader" }));
    expect(facts).toMatchObject({ class: "implement", confidence: 0.9, source: "plan" });
  });

  it("risk may be raised but never lowered", () => {
    expect(applyRouteLine({ ...base, risk: "high" }, line({ risk: "low" })).risk).toBe("high");
    expect(applyRouteLine({ ...base, risk: "medium" }, line({ risk: "low" })).risk).toBe("medium");
    expect(applyRouteLine(base, line({ risk: "high" })).risk).toBe("high");
  });

  it("scope overrides", () => {
    expect(applyRouteLine({ ...base, scope: "repo" }, line({ scope: "single" })).scope).toBe("single");
  });

  it("needs are unioned with the base and the class's implied needs, in NEEDS order", () => {
    const facts = applyRouteLine(
      { ...base, needs: ["edit"] },
      line({ class: "debug", needs: ["external_dir", "shell"] }),
    );
    expect(facts.needs).toEqual(["shell", "edit", "external_dir"]);
    expect(applyRouteLine(base, line({ class: "mechanical" })).needs).toEqual(["edit"]);
  });

  it("network implies shell", () => {
    expect(applyRouteLine(base, line({ needs: ["network"] })).needs).toEqual(["shell", "network"]);
  });

  it("without a valid class the base class, confidence and source stay", () => {
    const facts = applyRouteLine(base, line({ risk: "high", detection: "grader" }));
    expect(facts).toMatchObject({ class: "search", confidence: 0.8, source: "rules", risk: "high" });
  });

  it("does not mutate the base", () => {
    const before = JSON.stringify(base);
    applyRouteLine(base, line({ class: "design", needs: ["shell"] }));
    expect(JSON.stringify(base)).toBe(before);
  });
});
