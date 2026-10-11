import { describe, expect, it } from "vitest";
import { buildDispatchHeader } from "../../src/router/dispatch-header";
import { validateConfig } from "../../src/router/config";

const input = { tier: "fast", cap: 8, projectDirectory: "D:\\git\\opencode-model-router" };
const expected = `[router] You are @fast. Execute this dispatch yourself; do not route it to another tier, and do not ask to be re-dispatched.

Working directory: D:\\git\\opencode-model-router. You are already there — do not ask permission to read or write inside it.

Tool names mentioned in this dispatch are descriptive and vary by provider; your own tool schema is the authority on what you can do. Never refuse or hand back work because a named tool looks unfamiliar or missing — attempt it, and if you cannot finish, name the specific step that failed.

An empty result is a result. Search tools honour .gitignore, so a "no matches" answer inside an ignored path means the filter applied, not that your tools are broken; use a shell ripgrep with --no-ignore there before concluding anything is absent.

Read-only budget: 8 calls. The runtime appends [cap: N/MAX] and [⚠ REDUNDANT] to results. Reading a different region of a file you have already opened is NOT a redundant read.

CAP:8

To change the budget, put CAP:N or CAP:none accompanied by a reason: line in the dispatch.

A hand-back with zero tool calls is recorded as a false refusal.`;

describe("buildDispatchHeader", () => {
  it("renders the full numeric-cap header without a trailing newline", () => {
    expect(buildDispatchHeader(input)).toBe(expected);
    expect(buildDispatchHeader(input).endsWith("\n")).toBe(false);
  });

  it("renders the uncapped variant", () => {
    expect(buildDispatchHeader({ ...input, cap: "none" })).toBe(
      expected.replace("Read-only budget: 8 calls.", "Read-only budget: uncapped for this dispatch.").replace("CAP:8", "CAP:none"),
    );
  });

  it.each([undefined, ""])("omits the whole cwd paragraph for %s", (projectDirectory) => {
    expect(buildDispatchHeader({ ...input, projectDirectory })).toBe(
      expected.split("\n\n").filter((paragraph) => !paragraph.startsWith("Working directory:")).join("\n\n"),
    );
  });

  it.each(["fast", "medium", "heavy", "custom"])("identifies @%s without provider-specific tool names", (tier) => {
    const header = buildDispatchHeader({ ...input, tier });
    expect(header.startsWith(`[router] You are @${tier}.`)).toBe(true);
    expect(header).not.toMatch(/\b(?:Grep|Glob|Bash)\b/);
    expect(header).not.toMatch(/\bRead\b(?!-only budget)/);
  });
});

describe("buildDispatchHeader cross-repo lines (P1.7)", () => {
  const cwdLine = "Working directory: D:\\git\\opencode-model-router. You are already there — do not ask permission to read or write inside it.";
  const location = { name: "app-a", branch: "feat/login", head: "3f2c1a9d5e7b0000000000000000000000000000" };

  it("is byte-identical with empty or absent cross-repo inputs", () => {
    expect(buildDispatchHeader({ ...input, location: undefined, workingSet: [], readParents: [] })).toBe(expected);
    expect(buildDispatchHeader({ ...input, workingSet: undefined, readParents: undefined })).toBe(expected);
  });

  it("names the repository, branch and 7-character head in the working-directory paragraph", () => {
    expect(buildDispatchHeader({ ...input, location })).toBe(expected.replace(
      cwdLine,
      "Working directory: D:\\git\\opencode-model-router (repository app-a, branch feat/login at 3f2c1a9). You are already there — do not ask permission to read or write inside it.",
    ));
  });

  it("says detached for a null branch and drops the head clause for a null head", () => {
    expect(buildDispatchHeader({ ...input, location: { ...location, branch: null } })).toContain("(repository app-a, branch detached at 3f2c1a9). You are");
    expect(buildDispatchHeader({ ...input, location: { ...location, head: null } })).toContain("(repository app-a, branch feat/login). You are");
  });

  it("adds the repositories paragraph right after the working directory for a working set and parents", () => {
    const header = buildDispatchHeader({
      ...input,
      location,
      workingSet: [{ name: "app-a", branch: "feat/login" }, { name: "lib-b", branch: "main" }, { name: "lib-c", branch: null }],
      readParents: ["D:\\git", "D:\\work"],
    });
    const paragraphs = header.split("\n\n");
    expect(paragraphs[1]).toMatch(/^Working directory: .*\(repository app-a/);
    expect(paragraphs[2]).toBe(
      "Repositories in this session: app-a (feat/login), lib-b (main), lib-c (detached). You may read any repository below D:\\git, D:\\work; you edit and run only in your working directory.",
    );
    expect(paragraphs).toHaveLength(expected.split("\n\n").length + 1);
  });

  it("leaves out the first sentence for parents only", () => {
    expect(buildDispatchHeader({ ...input, readParents: ["D:\\git"] })).toBe(expected.replace(
      cwdLine,
      `${cwdLine}\n\nYou may read any repository below D:\\git; you edit and run only in your working directory.`,
    ));
  });

  it("leaves out the 'below' clause for a working set only", () => {
    expect(buildDispatchHeader({ ...input, workingSet: [{ name: "lib-b", branch: "main" }] })).toBe(expected.replace(
      cwdLine,
      `${cwdLine}\n\nRepositories in this session: lib-b (main). You edit and run only in your working directory.`,
    ));
  });
});

describe("dispatchHeader config validation", () => {
  const base = { activePreset: "test", presets: { test: { fast: { model: "test/model" } } }, rules: [], defaultTier: "fast" };
  it.each([undefined, true, false])("accepts %s", (dispatchHeader) => {
    expect(validateConfig({ ...base, dispatchHeader }).dispatchHeader).toBe(dispatchHeader);
  });
  it.each([null, 0, "false", {}, []])("rejects %j", (dispatchHeader) => {
    expect(() => validateConfig({ ...base, dispatchHeader })).toThrow("tiers.json: 'dispatchHeader' must be a boolean");
  });
});
