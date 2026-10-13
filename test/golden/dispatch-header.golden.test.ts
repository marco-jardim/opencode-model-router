import { describe, expect, it } from "vitest";
import { buildDispatchHeader, buildRoleDispatchHeader } from "../../src/router/dispatch-header";

/**
 * Golden pins of the router dispatch headers (P2g, OD6): the tier header text is unchanged by the role header's shared
 * location paragraphs, and the role header's exact bytes for a read-only role, a located editing role, and an exact resume.
 */
describe("dispatch header golden", () => {
  it("tier @fast cap 8 (unchanged text)", () => {
    expect(buildDispatchHeader({ tier: "fast", cap: 8, projectDirectory: "D:\\git\\opencode-model-router" })).toBe(
      [
        "[router] You are @fast. Execute this dispatch yourself; do not route it to another tier, and do not ask to be re-dispatched.",
        "Working directory: D:\\git\\opencode-model-router. You are already there — do not ask permission to read or write inside it.",
        "Tool names mentioned in this dispatch are descriptive and vary by provider; your own tool schema is the authority on what you can do. Never refuse or hand back work because a named tool looks unfamiliar or missing — attempt it, and if you cannot finish, name the specific step that failed.",
        'An empty result is a result. Search tools honour .gitignore, so a "no matches" answer inside an ignored path means the filter applied, not that your tools are broken; use a shell ripgrep with --no-ignore there before concluding anything is absent.',
        "Read-only budget: 8 calls. The runtime appends [cap: N/MAX] and [⚠ REDUNDANT] to results. Reading a different region of a file you have already opened is NOT a redundant read.",
        "CAP:8",
        "To change the budget, put CAP:N or CAP:none accompanied by a reason: line in the dispatch.",
        "A hand-back with zero tool calls is recorded as a false refusal.",
      ].join("\n\n"),
    );
  });

  it("explorer with the work root only (reads only)", () => {
    expect(buildRoleDispatchHeader({ agent: "explorer", workRoot: "D:\\git\\app-a", edits: false })).toBe(
      "[router] You are @explorer. Execute this dispatch yourself.\n\n"
        + "Working directory: D:\\git\\app-a. You are already there — do not ask permission to read inside it.\n\n"
        + "---\n\n",
    );
  });

  it("implementer located with working set and parents", () => {
    expect(buildRoleDispatchHeader({
      agent: "implementer",
      workRoot: "D:\\git\\app-a",
      edits: true,
      location: { name: "app-a", branch: "feat/login", head: "3f2c1a9d5e7b0000000000000000000000000000" },
      workingSet: [{ name: "app-a", branch: "feat/login" }, { name: "lib-b", branch: "main" }, { name: "lib-c", branch: null }],
      readParents: ["D:\\git", "D:\\work"],
    })).toBe(
      "[router] You are @implementer. Execute this dispatch yourself.\n\n"
        + "Working directory: D:\\git\\app-a (repository app-a, branch feat/login at 3f2c1a9). You are already there — do not ask permission to read or write inside it.\n\n"
        + "Repositories in this session: app-a (feat/login), lib-b (main), lib-c (detached). You may read any repository below D:\\git, D:\\work; you edit and run only in your working directory.\n\n"
        + "---\n\n",
    );
  });

  it("implementer exact resume", () => {
    expect(buildRoleDispatchHeader({
      agent: "implementer",
      workRoot: "D:\\git\\app-a",
      edits: true,
      location: { name: "app-a", branch: "feat/login", head: "3f2c1a9d5e7b0000000000000000000000000000" },
      workingSet: [{ name: "app-a", branch: "feat/login" }, { name: "lib-b", branch: "main" }],
      readParents: ["D:\\git"],
      exactResume: true,
    })).toBe(
      "[router] You are @implementer. Execute this dispatch yourself.\n\n"
        + "Working directory: D:\\git\\app-a (repository app-a, branch feat/login). You are already there — do not ask permission to read or write inside it.\n\n"
        + "Repositories in this session: app-a (feat/login), lib-b (main). You may read any repository below D:\\git; you edit and run only in your working directory.\n\n"
        + "---\n\n",
    );
  });
});
