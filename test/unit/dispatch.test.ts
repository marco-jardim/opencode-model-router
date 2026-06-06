import { describe, it, expect } from "vitest";
import {
  extractChangedFile,
  createChangedFileStore,
  parseTaskResult,
  buildDelegationDoD,
  tierModel,
  shouldVerifyTask,
  buildForcingNote,
  buildAcceptedSuffix,
} from "../../src/verify/dispatch";
import type { RouterConfig } from "../../src/router/config";

const cfg = {
  activePreset: "p",
  presets: {
    p: {
      fast: {
        model: "anthropic/claude-haiku-4-5",
        description: "f",
        whenToUse: [],
      },
      weird: { model: "noslash", description: "w", whenToUse: [] },
      empty: { model: "anthropic/", description: "e", whenToUse: [] },
    },
  },
  rules: [],
  defaultTier: "fast",
} as unknown as RouterConfig;

describe("extractChangedFile", () => {
  it("write tool with filePath => written", () => {
    expect(extractChangedFile("write", { filePath: "a.ts" })).toEqual({
      path: "a.ts",
      status: "written",
    });
  });
  it("edit tool with path => modified", () => {
    expect(extractChangedFile("edit", { path: "b.ts" })).toEqual({
      path: "b.ts",
      status: "modified",
    });
  });
  it("patch and multiedit => modified", () => {
    expect(extractChangedFile("patch", { file: "c.ts" })?.status).toBe("modified");
    expect(extractChangedFile("multiedit", { filePath: "d.ts" })?.status).toBe(
      "modified",
    );
  });
  it("non-write tool => null", () => {
    expect(extractChangedFile("read", { filePath: "a.ts" })).toBeNull();
  });
  it("write without a path => null", () => {
    expect(extractChangedFile("write", {})).toBeNull();
    expect(extractChangedFile("write", undefined)).toBeNull();
  });
});

describe("createChangedFileStore", () => {
  it("records edits per session and dedupes by path", () => {
    const s = createChangedFileStore();
    s.record("S1", "edit", { path: "x.ts" });
    s.record("S1", "edit", { path: "x.ts" });
    s.record("S1", "write", { filePath: "y.ts" });
    const files = s.get("S1");
    expect(files).toHaveLength(2);
    expect(files.find((f) => f.path === "y.ts")?.status).toBe("written");
  });
  it("'written' is sticky over a later 'modified'", () => {
    const s = createChangedFileStore();
    s.record("S1", "write", { filePath: "x.ts" });
    s.record("S1", "edit", { path: "x.ts" });
    expect(s.get("S1")).toEqual([{ path: "x.ts", status: "written" }]);
  });
  it("a later write upgrades a prior modified to written", () => {
    const s = createChangedFileStore();
    s.record("S1", "edit", { path: "x.ts" });
    s.record("S1", "write", { filePath: "x.ts" });
    expect(s.get("S1")).toEqual([{ path: "x.ts", status: "written" }]);
  });
  it("isolates sessions and clears", () => {
    const s = createChangedFileStore();
    s.record("S1", "write", { filePath: "x.ts" });
    s.record("S2", "write", { filePath: "z.ts" });
    expect(s.get("S2")).toEqual([{ path: "z.ts", status: "written" }]);
    s.clear("S1");
    expect(s.get("S1")).toEqual([]);
    expect(s.get("S2")).toHaveLength(1);
  });
  it("ignores non-write tools", () => {
    const s = createChangedFileStore();
    s.record("S1", "read", { filePath: "x.ts" });
    expect(s.get("S1")).toEqual([]);
  });
});

describe("parseTaskResult", () => {
  it("extracts wrapped text and child session id", () => {
    const r = parseTaskResult({
      output: "<task_result>\nDONE: built it\n</task_result>",
      metadata: { sessionId: "ses_child", parentSessionId: "ses_parent" },
    });
    expect(r.finalReturnText).toBe("DONE: built it");
    expect(r.childSessionID).toBe("ses_child");
  });
  it("falls back to the whole output when no wrapper, null id when no metadata", () => {
    const r = parseTaskResult({ output: "  plain text  " });
    expect(r.finalReturnText).toBe("plain text");
    expect(r.childSessionID).toBeNull();
  });
  it("supports the sessionID metadata spelling and is case-insensitive", () => {
    const r = parseTaskResult({
      output: "<TASK_RESULT>hi</TASK_RESULT>",
      metadata: { sessionID: "ses_x" },
    });
    expect(r.finalReturnText).toBe("hi");
    expect(r.childSessionID).toBe("ses_x");
  });
  it("non-string output => empty text", () => {
    expect(parseTaskResult({ output: 123 }).finalReturnText).toBe("");
    expect(parseTaskResult(undefined).finalReturnText).toBe("");
  });
});

describe("buildDelegationDoD", () => {
  it("an explicit [acceptance] block in the prompt wins (source=explicit)", () => {
    const dod = buildDelegationDoD({
      prompt: "do it\n[acceptance]\ncriteria: it works\n[/acceptance]",
    });
    expect(dod.source).toBe("explicit");
    expect(dod.criteria).toContain("it works");
  });
  it("the acceptance arg is parsed before the prompt", () => {
    const dod = buildDelegationDoD({
      prompt: "ignored",
      acceptance: "[acceptance]\ncheck: testsPass\n[/acceptance]",
    });
    expect(dod.source).toBe("explicit");
    expect(dod.kind).toBe("deterministic");
  });
  it("no block => non-vacuous auto-inference (source=inferred)", () => {
    const dod = buildDelegationDoD(
      { prompt: "fix the failing bug in parser" },
      { testCommand: "npm test" },
    );
    expect(dod.source).toBe("inferred");
    expect(dod.kind).toBe("deterministic");
    expect(dod.checks.some((c) => c.kind === "testsPass")).toBe(true);
  });
  it("no block, no hints => checker DoD with criteria", () => {
    const dod = buildDelegationDoD({ prompt: "explain the architecture" });
    expect(dod.source).toBe("inferred");
    expect(dod.kind).toBe("checker");
    expect(dod.criteria.length).toBeGreaterThan(0);
  });
});

describe("tierModel", () => {
  it("splits provider/model", () => {
    expect(tierModel(cfg, "fast")).toEqual({
      providerID: "anthropic",
      modelID: "claude-haiku-4-5",
    });
  });
  it("unknown tier => null", () => {
    expect(tierModel(cfg, "nope")).toBeNull();
  });
  it("model without a usable slash => null", () => {
    expect(tierModel(cfg, "weird")).toBeNull();
    expect(tierModel(cfg, "empty")).toBeNull();
  });
});

describe("shouldVerifyTask", () => {
  it("tool !== 'task' => false", () => {
    expect(shouldVerifyTask("delegate", "enforced", undefined)).toBe(false);
  });
  it("tool === 'task' & mode === 'off' => false", () => {
    expect(shouldVerifyTask("task", "off", undefined)).toBe(false);
  });
  it("tool === 'task' & mode !== 'off' & require === 'never' => false", () => {
    expect(shouldVerifyTask("task", "advisory", "never")).toBe(false);
  });
  it("tool === 'task' & mode === 'enforced' & require undefined => true", () => {
    expect(shouldVerifyTask("task", "enforced", undefined)).toBe(true);
  });
  it("tool === 'task' & mode === 'advisory' & require === 'always' => true", () => {
    expect(shouldVerifyTask("task", "advisory", "always")).toBe(true);
  });
  it("tool === 'task' & require === 'whenDoDPresent' => true", () => {
    expect(shouldVerifyTask("task", "enforced", "whenDoDPresent")).toBe(true);
  });
});

describe("buildForcingNote", () => {
  it("with reasons contains NOT ACCEPTED, bullet items, and NEXT:", () => {
    const note = buildForcingNote(["a", "b"]);
    expect(note).toContain("NOT ACCEPTED");
    expect(note).toContain("- a");
    expect(note).toContain("- b");
    expect(note).toContain("NEXT:");
  });
  it("empty reasons contains fallback message", () => {
    expect(buildForcingNote([])).toContain("(no reasons provided)");
  });
});

describe("buildAcceptedSuffix", () => {
  it("returns the expected suffix string", () => {
    expect(buildAcceptedSuffix("deterministic")).toBe(
      "\n\n[router \u2713 accepted: deterministic]",
    );
  });
});
