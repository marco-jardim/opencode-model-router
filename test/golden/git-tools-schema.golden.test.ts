/**
 * Golden (3b.3, SD-3b-1, SD-3b-10): the router_git_* tool schemas. Without a `root` resolver every tool's argument keys,
 * argument descriptions and description are today's, byte for byte (v1 freeze, I9); with one, `root` is declared (the host
 * strips undeclared keys) and the description gains one fixed sentence.
 */
import { describe, expect, it } from "vitest";
import { GIT_OPERATIONS, gitTools, type GitRootResolver } from "../../src/router/git-tools";

const DESCRIPTION = (operation: string) => `Read-only git ${operation} in the session repository. No shell, helpers, arbitrary options or writes. Output is bounded to 64 KiB and 15 seconds. Paths are literal and repository-relative.`;
const SUFFIX = " Role agents may set root to inspect another repository they may read (its absolute top-level path, or its name below routing.repoParents).";

const DESCRIPTIONS: Record<string, string> = {
  router_git_status: "Read-only git status in the session repository. No shell, helpers, arbitrary options or writes. Output is bounded to 64 KiB and 15 seconds. Paths are literal and repository-relative.",
  router_git_log: "Read-only git log in the session repository. No shell, helpers, arbitrary options or writes. Output is bounded to 64 KiB and 15 seconds. Paths are literal and repository-relative.",
  router_git_diff: "Read-only git diff in the session repository. No shell, helpers, arbitrary options or writes. Output is bounded to 64 KiB and 15 seconds. Paths are literal and repository-relative.",
  router_git_show: "Read-only git show in the session repository. No shell, helpers, arbitrary options or writes. Output is bounded to 64 KiB and 15 seconds. Paths are literal and repository-relative.",
  router_git_blame: "Read-only git blame in the session repository. No shell, helpers, arbitrary options or writes. Output is bounded to 64 KiB and 15 seconds. Paths are literal and repository-relative.",
  router_git_ls_files: "Read-only git ls-files in the session repository. No shell, helpers, arbitrary options or writes. Output is bounded to 64 KiB and 15 seconds. Paths are literal and repository-relative.",
};

const KEYS: Record<string, string[]> = {
  router_git_status: ["path"],
  router_git_log: ["path", "ref", "limit"],
  router_git_diff: ["path", "ref", "mode"],
  router_git_show: ["path", "ref"],
  router_git_blame: ["path", "ref"],
  router_git_ls_files: ["path"],
};

const PATH = "Literal repository-relative path; required for blame";
const REF = "Ref or diff range, at most 200 characters; never an option";
const SHOW_REF = "One commit or annotated tag pointing to a commit; ranges require log or diff";
const ROOT = "Another repository to inspect, read-only: its absolute top-level path, or its name below routing.repoParents; path is then relative to it";

type Args = Record<string, { description?: string; safeParse(value: unknown): { success: boolean } }>;
type Tools = Record<string, { description: string; args: Args }>;

/** Keys, argument descriptions and the description of every tool, as the host is given them. */
function shape(tools: Tools) {
  return Object.fromEntries(Object.entries(tools).map(([name, definition]) => [name, {
    description: definition.description,
    keys: Object.keys(definition.args),
    described: Object.fromEntries(Object.entries(definition.args).map(([key, schema]) => [key, schema.description ?? null])),
  }]));
}

function expected(configured: boolean) {
  return Object.fromEntries(GIT_OPERATIONS.map(operation => {
    const name = `router_git_${operation}`;
    const keys = [...KEYS[name]!, ...(configured ? ["root"] : [])];
    const described: Record<string, string | null> = { path: PATH };
    if (keys.includes("ref")) described.ref = operation === "show" ? SHOW_REF : REF;
    if (keys.includes("limit")) described.limit = null;
    if (keys.includes("mode")) described.mode = null;
    if (configured) described.root = ROOT;
    return [name, { description: `${DESCRIPTIONS[name]!}${configured ? SUFFIX : ""}`, keys, described }];
  }));
}

const resolveRoot: GitRootResolver = async () => ({ ok: false, reason: "unused" });

describe("router_git_* schema golden (3b.3)", () => {
  it("pins the tool names and today's descriptions", () => {
    expect(Object.keys(gitTools())).toEqual(Object.keys(DESCRIPTIONS));
    for (const operation of GIT_OPERATIONS) {
      expect(DESCRIPTIONS[`router_git_${operation}`]).toBe(DESCRIPTION(operation.replaceAll("_", "-")));
    }
  });

  it("without a root resolver, keys and descriptions are today's (I9, v1 freeze)", () => {
    expect(shape(gitTools() as unknown as Tools)).toEqual(expected(false));
    expect(shape(gitTools({ dispatchRepository: process.cwd() }) as unknown as Tools)).toEqual(expected(false));
    expect(shape(gitTools({ resolveWorkRoot: () => ({ role: false }) }) as unknown as Tools)).toEqual(expected(false));
    for (const definition of Object.values(gitTools() as unknown as Tools)) {
      expect(definition.args).not.toHaveProperty("root");
      expect(definition.description).not.toContain("root");
    }
  });

  it("with a root resolver, declares root last and appends the fixed sentence (SD-3b-1)", () => {
    const tools = gitTools({ resolveWorkRoot: () => ({ role: false }), resolveRoot }) as unknown as Tools;
    expect(shape(tools)).toEqual(expected(true));
    for (const definition of Object.values(tools)) {
      expect(definition.description.endsWith(SUFFIX)).toBe(true);
      expect(definition.args.root!.safeParse(undefined).success).toBe(true);
      expect(definition.args.root!.safeParse("D:\\git\\lib").success).toBe(true);
      expect(definition.args.root!.safeParse(1).success).toBe(false);
    }
  });
});
