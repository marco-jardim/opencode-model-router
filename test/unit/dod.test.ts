import { describe, it, expect } from "vitest";
import {
  summarizeDispatch,
  normalizeDoD,
  parseAcceptanceBlock,
  parseDoDFromDispatch,
  parseDoDFromAnnotation,
  inferDoD,
  isCheckable,
  type DoD,
} from "../../src/verify/dod";

// ---------------------------------------------------------------------------
// summarizeDispatch
// ---------------------------------------------------------------------------

describe("summarizeDispatch", () => {
  it("returns empty string for empty input", () => {
    expect(summarizeDispatch("")).toBe("");
  });

  it("returns empty string for whitespace-only multi-line input", () => {
    expect(summarizeDispatch("   \n  \n  ")).toBe("");
  });

  it("returns first non-empty line, trimmed", () => {
    expect(summarizeDispatch("\n\n  hello world  \nline2")).toBe("hello world");
  });

  it("collapses internal whitespace", () => {
    expect(summarizeDispatch("  foo   bar   baz  ")).toBe("foo bar baz");
  });

  it("slices to 120 chars max", () => {
    const long = "ab ".repeat(50); // >150 chars with spaces
    const result = summarizeDispatch(long);
    expect(result.length).toBeLessThanOrEqual(120);
  });

  it("single line input", () => {
    expect(summarizeDispatch("hello")).toBe("hello");
  });

  it("uses the first non-empty line from multi-line", () => {
    expect(summarizeDispatch("\n\nfirst\nsecond")).toBe("first");
  });

  it("tab characters are collapsed", () => {
    expect(summarizeDispatch("\thello\tworld")).toBe("hello world");
  });
});

// ---------------------------------------------------------------------------
// normalizeDoD
// ---------------------------------------------------------------------------

describe("normalizeDoD", () => {
  it("derives deterministic when checks present (overrides kind:none)", () => {
    const d: DoD = {
      kind: "none",
      checks: [{ kind: "buildPasses", command: "tsc" }],
      criteria: [],
      deliverable: null,
      source: "explicit",
    };
    expect(normalizeDoD(d).kind).toBe("deterministic");
  });

  it("derives checker when only criteria present (overrides kind:deterministic)", () => {
    const d: DoD = {
      kind: "deterministic",
      checks: [],
      criteria: ["the task is done"],
      deliverable: null,
      source: "explicit",
    };
    expect(normalizeDoD(d).kind).toBe("checker");
  });

  it("derives none when both empty (overrides kind:deterministic)", () => {
    const d: DoD = {
      kind: "deterministic",
      checks: [],
      criteria: [],
      deliverable: null,
      source: "explicit",
    };
    expect(normalizeDoD(d).kind).toBe("none");
  });

  it("defaults checks and criteria to empty arrays when missing at runtime", () => {
    const d = JSON.parse('{"kind":"none","deliverable":null,"source":"none"}') as DoD;
    const result = normalizeDoD(d);
    expect(Array.isArray(result.checks)).toBe(true);
    expect(result.checks).toHaveLength(0);
    expect(Array.isArray(result.criteria)).toBe(true);
    expect(result.criteria).toHaveLength(0);
  });

  it("normalizes non-string deliverable to null", () => {
    const d = JSON.parse(
      '{"kind":"none","checks":[],"criteria":[],"deliverable":42,"source":"none"}',
    ) as DoD;
    expect(normalizeDoD(d).deliverable).toBeNull();
  });

  it("trims whitespace from deliverable", () => {
    const d: DoD = {
      kind: "none",
      checks: [],
      criteria: [],
      deliverable: "  some/path  ",
      source: "explicit",
    };
    expect(normalizeDoD(d).deliverable).toBe("some/path");
  });

  it("empty string deliverable => null", () => {
    const d: DoD = {
      kind: "none",
      checks: [],
      criteria: [],
      deliverable: "",
      source: "explicit",
    };
    expect(normalizeDoD(d).deliverable).toBeNull();
  });

  it("whitespace-only deliverable => null", () => {
    const d: DoD = {
      kind: "none",
      checks: [],
      criteria: [],
      deliverable: "   ",
      source: "explicit",
    };
    expect(normalizeDoD(d).deliverable).toBeNull();
  });

  it("preserves source", () => {
    const d: DoD = {
      kind: "none",
      checks: [],
      criteria: [],
      deliverable: null,
      source: "annotation",
    };
    expect(normalizeDoD(d).source).toBe("annotation");
  });

  it("kind:none with checks present => deterministic (non-vacuous)", () => {
    const d: DoD = {
      kind: "none",
      checks: [{ kind: "testsPass" }],
      criteria: [],
      deliverable: null,
      source: "inferred",
    };
    expect(normalizeDoD(d).kind).toBe("deterministic");
  });
});

// ---------------------------------------------------------------------------
// parseAcceptanceBlock / parseDoDFromDispatch (Mode A)
// ---------------------------------------------------------------------------

describe("parseDoDFromDispatch", () => {
  const wrap = (inner: string, tag = "acceptance"): string =>
    `[${tag}]\n${inner}\n[/${tag}]`;

  it("returns null when opening tag is missing", () => {
    expect(parseDoDFromDispatch("no tags here\n[/acceptance]")).toBeNull();
  });

  it("returns null when closing tag is missing", () => {
    expect(parseDoDFromDispatch("[acceptance]\nsome content")).toBeNull();
  });

  it("returns null when both tags are missing", () => {
    expect(parseDoDFromDispatch("no tags at all")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseDoDFromDispatch("")).toBeNull();
  });

  it("empty block => kind none, isCheckable false", () => {
    const result = parseDoDFromDispatch("[acceptance]\n[/acceptance]");
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("none");
    expect(isCheckable(result!)).toBe(false);
  });

  it("source is 'explicit' for parseDoDFromDispatch", () => {
    const result = parseDoDFromDispatch("[acceptance]\n[/acceptance]");
    expect(result!.source).toBe("explicit");
  });

  it("parses check: run with quoted command and expect", () => {
    const text = wrap('check: run command="npm run build" expect="Build succeeded"');
    const result = parseDoDFromDispatch(text);
    expect(result).not.toBeNull();
    expect(result!.checks).toHaveLength(1);
    const c = result!.checks[0];
    expect(c.kind).toBe("run");
    expect(c.command).toBe("npm run build");
    expect(c.expect).toBe("Build succeeded");
  });

  it("quoted value containing spaces is parsed correctly", () => {
    const text = wrap('check: run command="npx vitest run --reporter=verbose" expect="all tests passed"');
    const result = parseDoDFromDispatch(text);
    expect(result!.checks[0].command).toBe("npx vitest run --reporter=verbose");
    expect(result!.checks[0].expect).toBe("all tests passed");
  });

  it("parses check: fileExists with path", () => {
    const text = wrap("check: fileExists path=src/index.ts");
    const result = parseDoDFromDispatch(text);
    expect(result!.checks[0].kind).toBe("fileExists");
    expect(result!.checks[0].path).toBe("src/index.ts");
  });

  it("parses check: schemaMatch with path and bare schema", () => {
    const text = wrap("check: schemaMatch path=out.json schema={type:object}");
    const result = parseDoDFromDispatch(text);
    expect(result!.checks[0].kind).toBe("schemaMatch");
    expect(result!.checks[0].path).toBe("out.json");
    expect(result!.checks[0].schema).toBe("{type:object}");
  });

  it("parses check: schemaMatch with quoted schema", () => {
    const text = wrap('check: schemaMatch path=out.json schema="inline schema"');
    const result = parseDoDFromDispatch(text);
    expect(result!.checks[0].schema).toBe("inline schema");
  });

  it("parses check: testsPass bare", () => {
    const text = wrap("check: testsPass");
    const result = parseDoDFromDispatch(text);
    expect(result!.checks[0].kind).toBe("testsPass");
    expect(result!.checks[0].command).toBeUndefined();
  });

  it("parses check: buildPasses bare", () => {
    const text = wrap("check: buildPasses");
    const result = parseDoDFromDispatch(text);
    expect(result!.checks[0].kind).toBe("buildPasses");
  });

  it("parses check: lintClean bare", () => {
    const text = wrap("check: lintClean");
    const result = parseDoDFromDispatch(text);
    expect(result!.checks[0].kind).toBe("lintClean");
  });

  it("skips unknown check kind line", () => {
    const text = wrap("check: unknownKind foo=bar\ncheck: buildPasses");
    const result = parseDoDFromDispatch(text);
    expect(result!.checks).toHaveLength(1);
    expect(result!.checks[0].kind).toBe("buildPasses");
  });

  it("unknown key in check is silently ignored", () => {
    const text = wrap("check: run command=foo unknownKey=bar");
    const result = parseDoDFromDispatch(text);
    expect(result!.checks[0].kind).toBe("run");
    expect(result!.checks[0].command).toBe("foo");
  });

  it("repeated criteria directives accumulate", () => {
    const text = wrap("criteria: first\ncriteria: second\ncriteria: third");
    const result = parseDoDFromDispatch(text);
    expect(result!.criteria).toEqual(["first", "second", "third"]);
    expect(result!.kind).toBe("checker");
  });

  it("criteria: with empty text is ignored", () => {
    const text = wrap("criteria:\ncriteria: valid");
    const result = parseDoDFromDispatch(text);
    expect(result!.criteria).toEqual(["valid"]);
  });

  it("deliverable last-wins", () => {
    const text = wrap("deliverable: first.txt\ndeliverable: second.txt");
    const result = parseDoDFromDispatch(text);
    expect(result!.deliverable).toBe("second.txt");
  });

  it("deliverable empty line clears to null", () => {
    const text = wrap("deliverable: first.txt\ndeliverable:");
    const result = parseDoDFromDispatch(text);
    expect(result!.deliverable).toBeNull();
  });

  it("explicit kind: none with checks present => normalizeDoD forces deterministic", () => {
    const text = wrap("kind: none\ncheck: buildPasses command=tsc");
    const result = parseDoDFromDispatch(text);
    expect(result!.kind).toBe("deterministic");
  });

  it("explicit kind: checker is recorded (when consistent)", () => {
    const text = wrap("kind: checker\ncriteria: done");
    const result = parseDoDFromDispatch(text);
    expect(result!.kind).toBe("checker");
  });

  it("invalid kind directive value is ignored; kind derived from checks", () => {
    const text = wrap("kind: totally_invalid\ncheck: buildPasses");
    const result = parseDoDFromDispatch(text);
    expect(result!.kind).toBe("deterministic");
  });

  it("blank lines inside block are ignored", () => {
    const text = "[acceptance]\n\n\ncheck: lintClean\n\n[/acceptance]";
    const result = parseDoDFromDispatch(text);
    expect(result!.checks).toHaveLength(1);
  });

  it("unknown directive lines are ignored", () => {
    const text = wrap("random: stuff here\ncheck: buildPasses");
    const result = parseDoDFromDispatch(text);
    expect(result!.checks).toHaveLength(1);
  });

  it("tags are case-insensitive", () => {
    const text = "[ACCEPTANCE]\ncheck: buildPasses\n[/ACCEPTANCE]";
    const result = parseDoDFromDispatch(text);
    expect(result).not.toBeNull();
    expect(result!.checks).toHaveLength(1);
  });

  it("surrounding whitespace on tags is accepted", () => {
    const text = "  [acceptance]  \ncheck: buildPasses\n  [/acceptance]  ";
    const result = parseDoDFromDispatch(text);
    expect(result).not.toBeNull();
  });

  it("[dod]/[/dod] alias works", () => {
    const text = wrap('check: testsPass command="npm test"', "dod");
    const result = parseDoDFromDispatch(text);
    expect(result).not.toBeNull();
    expect(result!.checks[0].kind).toBe("testsPass");
    expect(result!.checks[0].command).toBe("npm test");
  });

  it("[dod] opening with [/dod] closing works (alias)", () => {
    const text = "[dod]\ncheck: buildPasses\n[/dod]";
    const result = parseDoDFromDispatch(text);
    expect(result).not.toBeNull();
    expect(result!.checks[0].kind).toBe("buildPasses");
  });

  it("multiple checks parsed in order", () => {
    const text = wrap("check: buildPasses command=tsc\ncheck: testsPass command=jest");
    const result = parseDoDFromDispatch(text);
    expect(result!.checks).toHaveLength(2);
    expect(result!.checks[0].kind).toBe("buildPasses");
    expect(result!.checks[1].kind).toBe("testsPass");
    expect(result!.kind).toBe("deterministic");
  });

  it("checks + criteria coexist; kind is deterministic", () => {
    const text = wrap("check: buildPasses\ncriteria: all good");
    const result = parseDoDFromDispatch(text);
    expect(result!.kind).toBe("deterministic");
    expect(result!.checks).toHaveLength(1);
    expect(result!.criteria).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// parseDoDFromAnnotation (Mode B)
// ---------------------------------------------------------------------------

describe("parseDoDFromAnnotation", () => {
  it("source is 'annotation'", () => {
    const result = parseDoDFromAnnotation("[acceptance]\n[/acceptance]");
    expect(result!.source).toBe("annotation");
  });

  it("returns null when no tags", () => {
    expect(parseDoDFromAnnotation("no tags")).toBeNull();
  });

  it("parses checks correctly with annotation source", () => {
    const text = '[acceptance]\ncheck: testsPass command="npm test"\n[/acceptance]';
    const result = parseDoDFromAnnotation(text);
    expect(result!.source).toBe("annotation");
    expect(result!.checks[0].kind).toBe("testsPass");
    expect(result!.checks[0].command).toBe("npm test");
  });

  it("uses [dod] alias with annotation source", () => {
    const result = parseDoDFromAnnotation("[dod]\ncriteria: shipped\n[/dod]");
    expect(result!.source).toBe("annotation");
    expect(result!.criteria).toEqual(["shipped"]);
  });
});

// ---------------------------------------------------------------------------
// parseAcceptanceBlock (direct, source parameter)
// ---------------------------------------------------------------------------

describe("parseAcceptanceBlock", () => {
  it("default source is explicit", () => {
    const result = parseAcceptanceBlock("[acceptance]\n[/acceptance]");
    expect(result!.source).toBe("explicit");
  });

  it("explicit source parameter is preserved", () => {
    const result = parseAcceptanceBlock("[acceptance]\n[/acceptance]", "inferred");
    expect(result!.source).toBe("inferred");
  });
});

// ---------------------------------------------------------------------------
// inferDoD
// ---------------------------------------------------------------------------

describe("inferDoD", () => {
  const fullHints = {
    buildCommand: "npx tsc --noEmit",
    testCommand: "npm test",
    lintCommand: "npm run lint",
    declaredPath: "src/foo.ts",
  };

  it("impl: both commands => 2 deterministic checks (buildPasses + testsPass) with commands set", () => {
    const result = inferDoD("implement the new feature", "medium", fullHints);
    expect(result.kind).toBe("deterministic");
    expect(result.checks).toHaveLength(2);
    expect(result.checks[0].kind).toBe("buildPasses");
    expect(result.checks[0].command).toBe("npx tsc --noEmit");
    expect(result.checks[1].kind).toBe("testsPass");
    expect(result.checks[1].command).toBe("npm test");
  });

  it("bugfix: both commands => buildPasses + testsPass", () => {
    const result = inferDoD("fix the broken auth flow", "medium", fullHints);
    expect(result.kind).toBe("deterministic");
    expect(result.checks).toHaveLength(2);
    expect(result.checks[0].kind).toBe("buildPasses");
    expect(result.checks[1].kind).toBe("testsPass");
  });

  it("bugfix keyword 'regression' => buildPasses + testsPass", () => {
    const result = inferDoD("fix the regression in routing", "medium", fullHints);
    expect(result.checks[0].kind).toBe("buildPasses");
    expect(result.checks[1].kind).toBe("testsPass");
  });

  it("refactor + lintCommand => buildPasses + lintClean", () => {
    const result = inferDoD("refactor the router module", "medium", fullHints);
    expect(result.kind).toBe("deterministic");
    expect(result.checks).toHaveLength(2);
    expect(result.checks[0].kind).toBe("buildPasses");
    expect(result.checks[0].command).toBe("npx tsc --noEmit");
    expect(result.checks[1].kind).toBe("lintClean");
    expect(result.checks[1].command).toBe("npm run lint");
  });

  it("refactor without buildCommand => only lintClean", () => {
    const result = inferDoD("refactor this module", "medium", {
      buildCommand: null,
      testCommand: null,
      lintCommand: "eslint .",
    });
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].kind).toBe("lintClean");
  });

  it("refactor without lintCommand => only buildPasses", () => {
    const result = inferDoD("refactor this module", "medium", {
      buildCommand: "tsc",
      testCommand: null,
      lintCommand: null,
    });
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].kind).toBe("buildPasses");
  });

  it("writeFile + declaredPath => fileExists check with path set", () => {
    const result = inferDoD("write the config file", "medium", fullHints);
    expect(result.kind).toBe("deterministic");
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].kind).toBe("fileExists");
    expect(result.checks[0].path).toBe("src/foo.ts");
  });

  it("generate keyword + declaredPath => writeFile => fileExists", () => {
    const result = inferDoD("generate the output schema", "medium", {
      declaredPath: "out/schema.json",
    });
    expect(result.checks[0].kind).toBe("fileExists");
    expect(result.checks[0].path).toBe("out/schema.json");
  });

  it("writeFile keyword without declaredPath falls through (no fileExists check)", () => {
    const result = inferDoD("write this function body", "medium", {
      buildCommand: "tsc",
      testCommand: "npm test",
      declaredPath: null,
    });
    // "function" matches impl pattern; gets buildPasses + testsPass
    expect(result.checks.every((c) => c.kind !== "fileExists")).toBe(true);
    expect(result.checks.some((c) => c.kind === "buildPasses")).toBe(true);
  });

  it("test category: testsPass with testCommand", () => {
    const result = inferDoD("write spec files for the module", "medium", {
      testCommand: "npm test",
      buildCommand: null,
      declaredPath: null,
    });
    expect(result.kind).toBe("deterministic");
    expect(result.checks[0].kind).toBe("testsPass");
    expect(result.checks[0].command).toBe("npm test");
  });

  it("test category: 'coverage' keyword => testsPass", () => {
    const result = inferDoD("improve coverage for auth module", "medium", {
      testCommand: "jest --coverage",
      buildCommand: null,
    });
    expect(result.checks[0].kind).toBe("testsPass");
  });

  it("no commands discoverable => checker fallback (non-vacuous, kind never 'none')", () => {
    const result = inferDoD("fix the bug", "medium", {
      buildCommand: null,
      testCommand: null,
      lintCommand: null,
    });
    expect(result.kind).toBe("checker");
    expect(result.criteria.length).toBeGreaterThan(0);
    expect(isCheckable(result)).toBe(true);
  });

  it("unknown category => checker fallback with summarized criteria", () => {
    const result = inferDoD("review this document carefully", "medium", {
      buildCommand: null,
      testCommand: null,
    });
    expect(result.kind).toBe("checker");
    expect(result.criteria.length).toBeGreaterThan(0);
    expect(isCheckable(result)).toBe(true);
  });

  it("checker fallback criteria uses summarized dispatch text", () => {
    const result = inferDoD("review this carefully", "medium", {
      buildCommand: null,
      testCommand: null,
    });
    expect(result.criteria[0]).toBe("review this carefully");
  });

  it("checker fallback with empty dispatch => uses default message", () => {
    const result = inferDoD("", "medium", { buildCommand: null, testCommand: null });
    expect(result.criteria[0]).toBe(
      "the delegated task is completed as described in the dispatch",
    );
  });

  it("source is always 'inferred'", () => {
    expect(inferDoD("implement something", "fast", fullHints).source).toBe("inferred");
    expect(inferDoD("review doc", "heavy", {}).source).toBe("inferred");
  });

  it("does not throw on any tier value", () => {
    expect(() => inferDoD("fix bug", "unknown_tier_value", fullHints)).not.toThrow();
    expect(() => inferDoD("fix bug", "", fullHints)).not.toThrow();
    expect(() => inferDoD("fix bug", "   ", fullHints)).not.toThrow();
  });

  it("deliverable is set from declaredPath when provided", () => {
    const result = inferDoD("implement feature", "medium", fullHints);
    expect(result.deliverable).toBe("src/foo.ts");
  });

  it("deliverable is null when declaredPath not provided", () => {
    const result = inferDoD("implement feature", "medium", {
      buildCommand: "tsc",
      testCommand: null,
      declaredPath: null,
    });
    expect(result.deliverable).toBeNull();
  });

  it("deliverable is null when declaredPath is whitespace-only", () => {
    const result = inferDoD("implement feature", "medium", {
      buildCommand: "tsc",
      testCommand: null,
      declaredPath: "   ",
    });
    expect(result.deliverable).toBeNull();
  });

  it("impl with only buildCommand => 1 check (buildPasses)", () => {
    const result = inferDoD("add a new endpoint", "medium", {
      buildCommand: "tsc",
      testCommand: null,
    });
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].kind).toBe("buildPasses");
  });

  it("impl with only testCommand => 1 check (testsPass)", () => {
    const result = inferDoD("create a helper function", "medium", {
      buildCommand: null,
      testCommand: "vitest",
    });
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].kind).toBe("testsPass");
  });
});

// ---------------------------------------------------------------------------
// isCheckable
// ---------------------------------------------------------------------------

describe("isCheckable", () => {
  it("true when kind deterministic and checks present", () => {
    const d: DoD = {
      kind: "deterministic",
      checks: [{ kind: "buildPasses" }],
      criteria: [],
      deliverable: null,
      source: "explicit",
    };
    expect(isCheckable(d)).toBe(true);
  });

  it("true when kind checker and criteria present", () => {
    const d: DoD = {
      kind: "checker",
      checks: [],
      criteria: ["done"],
      deliverable: null,
      source: "explicit",
    };
    expect(isCheckable(d)).toBe(true);
  });

  it("false when kind is none", () => {
    const d: DoD = {
      kind: "none",
      checks: [],
      criteria: [],
      deliverable: null,
      source: "none",
    };
    expect(isCheckable(d)).toBe(false);
  });

  it("false for empty block result", () => {
    const result = parseDoDFromDispatch("[acceptance]\n[/acceptance]");
    expect(isCheckable(result!)).toBe(false);
  });

  it("false when kind is not none but checks and criteria are both empty", () => {
    // Un-normalized DoD (shouldn't happen after normalizeDoD but isCheckable is defensive)
    const d: DoD = {
      kind: "deterministic",
      checks: [],
      criteria: [],
      deliverable: null,
      source: "explicit",
    };
    expect(isCheckable(d)).toBe(false);
  });

  it("true for inferred checker result with summarized criteria", () => {
    const result = inferDoD("review this carefully", "medium", {
      buildCommand: null,
      testCommand: null,
    });
    expect(isCheckable(result)).toBe(true);
  });
});
