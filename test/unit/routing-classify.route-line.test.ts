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
    expect(parseRouteLine(text)).toEqual({ line: null, count: 0, stripped: text, conflict: false, edgeOnly: true });
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
    expect(parseRouteLine(sentence)).toMatchObject({ line: null, count: 0, stripped: sentence });
    const ticks = "write `[route class=design]` on its own line";
    expect(parseRouteLine(ticks).line).toBeNull();
    const fenced = "```\n[route class=design]\n```";
    expect(parseRouteLine(fenced)).toMatchObject({ line: null, count: 0, stripped: fenced });
  });

  it("every route line is counted and stripped; differing lines conflict (details in the QA-1.2-2 block)", () => {
    const text = "[route class=design]\ndo the thing\n[route class=debug risk=high]\nmore";
    const parsed = parseRouteLine(text);
    expect(parsed.count).toBe(2);
    expect(parsed.conflict).toBe(true);
    expect(parsed.line?.class).toBeUndefined();
    expect(parsed.stripped).toBe("do the thing\nmore");
    const same = parseRouteLine("[route class=design]\ndo the thing\n[route class=design]\nmore");
    expect(same.line?.class).toBe("design");
    expect(same.stripped).toBe("do the thing\nmore");
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
    expect(parseRouteLine(undefined as unknown as string)).toMatchObject({ line: null, count: 0, stripped: "" });
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

describe("parseRouteLine — smuggling defences (QA-1.2-2)", () => {
  const ROUTE = "[route class=design risk=high pin d=none]";

  it("does not recognise (or strip) a route line inside a ``` or ~~~ fence", () => {
    for (const fence of ["```", "~~~", "````", "~~~~~"]) {
      const text = `intro\n${fence}\n${ROUTE}\n${fence}\noutro`;
      const parsed = parseRouteLine(text);
      expect(parsed.line, fence).toBeNull();
      expect(parsed.count).toBe(0);
      expect(parsed.stripped).toBe(text);
    }
    const withInfo = "```text\n[route class=design]\n```";
    expect(parseRouteLine(withInfo).stripped).toBe(withInfo);
  });

  it("a closing fence must be at least as long as the opener, and of the same character", () => {
    const shortCloser = "````\n[route class=design]\n```\n[route class=debug]\n````\nafter";
    expect(parseRouteLine(shortCloser).count).toBe(0);
    const wrongChar = "```\n[route class=design]\n~~~\n[route class=debug]\n```\nafter";
    expect(parseRouteLine(wrongChar).count).toBe(0);
    const longerCloser = "```\n[route class=design]\n`````\n[route class=debug]";
    const parsed = parseRouteLine(longerCloser);
    expect(parsed.count).toBe(1);
    expect(parsed.line?.class).toBe("debug");
  });

  it("an unclosed fence runs to the end of the text", () => {
    const text = "task\n```\nsome log\n[route class=design]\nmore log";
    const parsed = parseRouteLine(text);
    expect(parsed.count).toBe(0);
    expect(parsed.stripped).toBe(text);
  });

  it("a route line after a closed fence is recognised again; inline triple backticks do not open a fence", () => {
    const text = "```\ncode\n```\n[route class=debug]";
    expect(parseRouteLine(text)).toMatchObject({ count: 1, stripped: "```\ncode\n```\n" });
    const inline = "use ```x``` here\n[route class=debug]";
    expect(parseRouteLine(inline).count).toBe(1);
  });

  it("does not recognise lines indented four or more columns, or quoted with >", () => {
    for (const line of [`    ${ROUTE}`, `\t${ROUTE}`, `  \t${ROUTE}`, `> ${ROUTE}`, `  > ${ROUTE}`, `>${ROUTE}`]) {
      const text = `before\n${line}\nafter`;
      const parsed = parseRouteLine(text);
      expect(parsed.count, JSON.stringify(line)).toBe(0);
      expect(parsed.stripped).toBe(text);
    }
    expect(parseRouteLine(`   ${ROUTE}`).count).toBe(1);
    expect(parseRouteLine(`\u00a0${ROUTE}`).count).toBe(0);
  });

  it("a very long line is never a route line", () => {
    const long = "[route class=design " + "needs=shell ".repeat(100) + "]";
    expect(long.length).toBeGreaterThan(500);
    expect(parseRouteLine(long)).toMatchObject({ line: null, count: 0, stripped: long });
  });

  it("identical route lines are not a conflict; the first is used", () => {
    const parsed = parseRouteLine("[route class=design pin]\nx\n[route class=design pin]");
    expect(parsed).toMatchObject({ count: 2, conflict: false });
    expect(parsed.line).toMatchObject({ class: "design", pin: true });
    expect(parsed.stripped).toBe("x\n");
  });

  it("differing route lines conflict: neither d nor pin applies, contradicted fields fall back to the rules", () => {
    const parsed = parseRouteLine(
      "[route class=search risk=low scope=single needs=shell pin d=grader]\nwork\n[route class=design risk=low pin d=none]",
    );
    expect(parsed.conflict).toBe(true);
    expect(parsed.count).toBe(2);
    expect(parsed.stripped).toBe("work\n");
    expect(parsed.line?.class).toBeUndefined(); // contradicted
    expect(parsed.line?.risk).toBe("low"); // same in both
    expect(parsed.line?.scope).toBe("single"); // only the first has it
    expect(parsed.line?.needs).toEqual(["shell"]);
    expect(parsed.line?.pin).toBe(false);
    expect(parsed.line?.detection).toBeUndefined();
    expect(parsed.line?.ignored).toEqual(
      expect.arrayContaining(["conflict", "conflict:class", "conflict:d", "conflict:pin"]),
    );
  });

  it("a second line that only adds pin or d is still a conflict and cannot pin", () => {
    const parsed = parseRouteLine("[route class=debug]\n[route class=debug pin d=none]");
    expect(parsed.conflict).toBe(true);
    expect(parsed.line).toMatchObject({ class: "debug", pin: false });
    expect(parsed.line?.detection).toBeUndefined();
  });

  it("a conflict leaves applyRouteLine with the rules class when the class is contradicted", () => {
    const parsed = parseRouteLine("[route class=design]\n[route class=search]");
    const facts = applyRouteLine(base, parsed.line!);
    expect(facts).toMatchObject({ class: "search", confidence: 0.8, source: "rules" });
  });

  it("reports whether every route line sits on the first or last non-empty line", () => {
    expect(parseRouteLine("[route class=debug]\nbody\nmore").edgeOnly).toBe(true);
    expect(parseRouteLine("\n\nbody\nmore\n[route class=debug]\n\n").edgeOnly).toBe(true);
    expect(parseRouteLine("body\n[route class=debug]\nmore").edgeOnly).toBe(false);
    expect(parseRouteLine("[route class=debug]\nbody\n[route class=debug]").edgeOnly).toBe(true);
    expect(parseRouteLine("[route class=debug]\nbody\n[route class=debug]\nmore").edgeOnly).toBe(false);
    expect(parseRouteLine("no directive here").edgeOnly).toBe(true);
  });
});
describe("parseRouteLine — spaces around the commas of needs (QA-1.2-14)", () => {
  it.each([
    "[route needs=shell, edit]",
    "[route needs=shell ,edit]",
    "[route needs = shell , edit]",
    "[route needs=shell,  edit]",
    "[route needs=shell,\tedit]",
  ])("%s -> shell, edit", (text) => {
    const parsed = parseRouteLine(text);
    expect(parsed.line?.needs).toEqual(["shell", "edit"]);
    expect(parsed.line?.ignored).toEqual([]);
  });

  it("three items and NEEDS order", () => {
    expect(parseRouteLine("[route needs=external_dir, edit , shell]").line?.needs).toEqual([
      "shell",
      "edit",
      "external_dir",
    ]);
  });

  it("a comma before the next field does not swallow it", () => {
    const parsed = parseRouteLine("[route needs=shell, class=debug risk=high]");
    expect(parsed.line).toMatchObject({ needs: ["shell"], class: "debug", risk: "high" });
    expect(parsed.line?.ignored).toEqual([]);
    const spaced = parseRouteLine("[route class=debug, needs=shell, edit, risk=high]");
    expect(spaced.line).toMatchObject({ needs: ["shell", "edit"], class: "debug", risk: "high" });
  });

  it("an invalid word in the list is dropped, the valid ones stay", () => {
    expect(parseRouteLine("[route needs=shell, banana, edit]").line?.needs).toEqual(["shell", "edit"]);
  });
});
describe("parseRouteLine — positions: edges (QA-1.2-2 handoff to 2.2)", () => {
  const edges = { positions: "edges" } as const;

  it("recognises the first and the last non-empty line and nothing in between", () => {
    const first = parseRouteLine("\n[route class=debug]\nbody\nmore\n", edges);
    expect(first).toMatchObject({ count: 1, stripped: "\nbody\nmore\n" });
    const last = parseRouteLine("body\nmore\n[route class=debug]\n\n", edges);
    expect(last).toMatchObject({ count: 1, stripped: "body\nmore\n\n" });
  });

  it("a route line in the middle stays in the prompt and is not applied", () => {
    const text = "body\n[route class=design pin d=none]\nmore";
    const parsed = parseRouteLine(text, edges);
    expect(parsed).toMatchObject({ line: null, count: 0, stripped: text, conflict: false });
    expect(parseRouteLine(text).count).toBe(1); // default: anywhere
  });

  it("a smuggled middle line cannot conflict with, or be mistaken for, the real one", () => {
    const text = "[route class=search]\nsome quoted issue text\n[route class=design pin]\nmore text";
    const parsed = parseRouteLine(text, edges);
    expect(parsed).toMatchObject({ count: 1, conflict: false, edgeOnly: true });
    expect(parsed.line).toMatchObject({ class: "search", pin: false });
    expect(parsed.stripped).toBe("some quoted issue text\n[route class=design pin]\nmore text");
  });

  it("a single-line prompt is both first and last", () => {
    expect(parseRouteLine("[route class=debug]", edges)).toMatchObject({ count: 1, stripped: "" });
  });
});
describe("parseRouteLine — positions: first (A22)", () => {
  const first = { positions: "first" } as const;

  it("recognises only the first non-empty line", () => {
    const parsed = parseRouteLine("\n  \n[route class=debug]\nbody", first);
    expect(parsed).toMatchObject({ count: 1, stripped: "\n  \nbody" });
    expect(parsed.line?.class).toBe("debug");
  });

  it("a route line last, or anywhere after the first non-empty line, is text", () => {
    for (const text of ["body\n[route class=design pin]", "body\nmore\n[route class=design pin]\n", "x\n\n[route class=design]\ny"]) {
      const parsed = parseRouteLine(text, first);
      expect(parsed, text).toMatchObject({ line: null, count: 0, stripped: text });
    }
  });

  it("a smuggled second line cannot conflict with the real first one: it is not recognised", () => {
    const text = "[route class=search]\nquoted issue\n[route class=design pin d=none]";
    const parsed = parseRouteLine(text, first);
    expect(parsed).toMatchObject({ count: 1, conflict: false, stripped: "quoted issue\n[route class=design pin d=none]" });
    expect(parsed.line).toMatchObject({ class: "search", pin: false });
  });

  it("a text whose first non-empty line is not a route line has none at all", () => {
    expect(parseRouteLine("Fix it.\n[route class=debug]", first).line).toBeNull();
  });

  it("the parser's own default stays `any`", () => {
    expect(parseRouteLine("body\n[route class=debug]").count).toBe(1);
  });
});