import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createLeaseRegistry, type HolderInput } from "../../src/router/leases";
import { applyPatchHeaderPaths, toolTargets, WRITE_CLASS } from "../../src/router/tool-paths";

const win = process.platform === "win32";
const CWD = resolve("/work/proj");
const p = (...segments: string[]): string => resolve(CWD, ...segments);
const ABS = resolve("/elsewhere/abs.ts");
const NONE = { access: "none", paths: [], roots: [] };
/** A drive-less rooted path: win32 returns it unchanged (the registry decides), POSIX resolves it. */
const rooted = (text: string): string => (win ? text : resolve(text));

describe("toolTargets: read and write tools", () => {
  it("read: the path key, resolved lexically against cwd", () => {
    expect(toolTargets("read", { path: "a.ts" }, CWD)).toEqual({ access: "read", paths: [p("a.ts")], roots: [] });
    expect(toolTargets("read", { path: "./src/../b.ts" }, CWD).paths).toEqual([p("b.ts")]);
    expect(toolTargets("read", { path: ABS }, CWD).paths).toEqual([ABS]);
  });

  it("read: every non-empty string among filePath, path, file, file_path is a target (QA-1.3-4)", () => {
    expect(toolTargets("read", { filePath: "a", path: "b", file: "c", file_path: "d" }, CWD).paths).toEqual([p("a"), p("b"), p("c"), p("d")]);
    expect(toolTargets("read", { path: "b", file: "c" }, CWD).paths).toEqual([p("b"), p("c")]);
    expect(toolTargets("read", { file: "c" }, CWD).paths).toEqual([p("c")]);
    expect(toolTargets("read", { file_path: "d" }, CWD).paths).toEqual([p("d")]);
    expect(toolTargets("read", { filePath: "", path: "b" }, CWD).paths).toEqual([p("b")]);
    expect(toolTargets("read", { filePath: 5, path: null, file: "c" }, CWD).paths).toEqual([p("c")]);
    expect(toolTargets("read", { path: "a", filePath: "./a" }, CWD).paths).toEqual([p("a")]);
  });

  it("write and edit: conflicting path keys give both targets (QA-1.3-4)", () => {
    for (const tool of ["write", "edit"]) {
      expect(toolTargets(tool, { path: "A.ts", filePath: "B.ts" }, CWD).paths).toEqual([p("B.ts"), p("A.ts")]);
    }
  });

  it("multiedit: conflicting keys at the top level and in each edits[i] give every target (QA-1.3-4)", () => {
    const result = toolTargets(
      "multiedit",
      { path: "A", filePath: "B", edits: [{ path: "C", file_path: "D" }, { filePath: "B", file: "E" }] },
      CWD,
    );
    expect(result.paths).toEqual([p("B"), p("A"), p("C"), p("D"), p("E")]);
  });

  it("read: no usable path gives an empty list (a read of nothing)", () => {
    expect(toolTargets("read", {}, CWD)).toEqual({ access: "read", paths: [], roots: [] });
    expect(toolTargets("read", { path: "" }, CWD).paths).toEqual([]);
    expect(toolTargets("read", { path: 5 }, CWD).paths).toEqual([]);
    expect(toolTargets("read", { path: ["a.ts"] }, CWD).paths).toEqual([]);
  });

  it("lower-cases the tool name", () => {
    expect(toolTargets("READ", { path: "a" }, CWD).access).toBe("read");
    expect(toolTargets("Apply_Patch", { patchText: "*** Add File: a.ts" }, CWD).paths).toEqual([p("a.ts")]);
    expect(toolTargets("ROUTER_RUN", {}, CWD).access).toBe("run");
  });

  for (const tool of ["write", "edit"]) {
    it(`${tool}: a write of the path key`, () => {
      expect(toolTargets(tool, { filePath: "src/a.ts", content: "x" }, CWD)).toEqual({
        access: "write",
        paths: [p("src/a.ts")],
        roots: [],
      });
      expect(toolTargets(tool, { path: "b.ts" }, CWD).paths).toEqual([p("b.ts")]);
      expect(toolTargets(tool, { file: "c.ts" }, CWD).paths).toEqual([p("c.ts")]);
    });

    it(`${tool}: ignores edits[] (only multiedit has them)`, () => {
      expect(toolTargets(tool, { path: "a", edits: [{ path: "b" }] }, CWD).paths).toEqual([p("a")]);
    });
  }

  it("a write-class tool with no extractable target is a write of nothing", () => {
    for (const tool of WRITE_CLASS) {
      for (const args of [undefined, null, "text", 5, [], {}, { path: "" }, { path: 7 }, { edits: [] }]) {
        expect(toolTargets(tool, args, CWD), `${tool} ${JSON.stringify(args)}`).toEqual({ access: "write", paths: [], roots: [] });
      }
    }
  });

  describe("multiedit", () => {
    it("takes the top-level path and each edits[i] path, first-seen order, deduped", () => {
      const result = toolTargets(
        "multiedit",
        { filePath: "a.ts", edits: [{ path: "b.ts" }, { filePath: "a.ts" }, { file: "c.ts" }, { path: "./b.ts" }] },
        CWD,
      );
      expect(result).toEqual({ access: "write", paths: [p("a.ts"), p("b.ts"), p("c.ts")], roots: [] });
    });

    it("works without a top-level path", () => {
      expect(toolTargets("multiedit", { edits: [{ path: "x.ts" }, { path: "y.ts" }] }, CWD).paths).toEqual([p("x.ts"), p("y.ts")]);
    });

    it("ignores an edits value that is not an array and items that are not objects", () => {
      expect(toolTargets("multiedit", { path: "a", edits: "b" }, CWD).paths).toEqual([p("a")]);
      expect(toolTargets("multiedit", { path: "a", edits: { path: "b" } }, CWD).paths).toEqual([p("a")]);
      expect(toolTargets("multiedit", { path: "a", edits: [null, "b", 3, [], undefined, { path: 4 }, {}] }, CWD).paths).toEqual([p("a")]);
    });
  });

  describe("patch and apply_patch", () => {
    const CRLF = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+export const a = 1;",
      "*** Update File: src/old.ts",
      "@@",
      "-a",
      "+b",
      "*** Update File: src/from.ts",
      "*** Move to: src/to.ts",
      "@@",
      "*** Delete File: src/gone.ts",
      "*** End Patch",
    ].join("\r\n");

    for (const tool of ["apply_patch", "patch"]) {
      it(`${tool}: Add, Update, Delete and Update+Move (both paths) with CRLF line endings`, () => {
        expect(toolTargets(tool, { patchText: CRLF }, CWD)).toEqual({
          access: "write",
          paths: [p("src/new.ts"), p("src/old.ts"), p("src/from.ts"), p("src/to.ts"), p("src/gone.ts")],
          roots: [],
        });
        expect(toolTargets(tool, { patchText: CRLF.replace(/\r\n/g, "\n") }, CWD).paths).toHaveLength(5);
      });

      it(`${tool}: takes each header kind on its own`, () => {
        expect(toolTargets(tool, { patchText: "*** Add File: a.ts" }, CWD).paths).toEqual([p("a.ts")]);
        expect(toolTargets(tool, { patchText: "*** Update File: b.ts\n@@" }, CWD).paths).toEqual([p("b.ts")]);
        expect(toolTargets(tool, { patchText: "*** Delete File: c.ts\n" }, CWD).paths).toEqual([p("c.ts")]);
        expect(toolTargets(tool, { patchText: "*** Move to: d.ts" }, CWD).paths).toEqual([p("d.ts")]);
      });
    }

    it("trims header paths, keeps absolute ones and dedupes in order of appearance", () => {
      const text = `*** Add File:   spaced.ts  \n*** Update File: ${ABS}\n*** Delete File: spaced.ts\n*** Add File: ./spaced.ts`;
      expect(toolTargets("apply_patch", { patchText: text }, CWD).paths).toEqual([p("spaced.ts"), ABS]);
    });

    it("ignores lines that are not headers; a header with leading blanks IS one (as the v2 host parses it)", () => {
      const text = "  *** Add File: indented.ts\n+*** Add File: added.ts\n*** Add Files: x.ts\n\t*** Update File: tabbed.ts\n*** Add File: ok.ts";
      expect(toolTargets("apply_patch", { patchText: text }, CWD).paths).toEqual([p("indented.ts"), p("tabbed.ts"), p("ok.ts")]);
    });

    it("an empty header or a patch with no header is an unknown target: a write of nothing (QA-1.3-3)", () => {
      const unknown = { access: "write", paths: [], roots: [] };
      for (const tool of ["apply_patch", "patch"]) {
        expect(toolTargets(tool, { patchText: "*** Add File: " }, CWD), tool).toEqual(unknown);
        expect(toolTargets(tool, { patchText: "*** Add File:\n*** Add File: ok.ts" }, CWD), tool).toEqual(unknown);
        expect(toolTargets(tool, { patchText: "*** Update File:   \r\n*** Move to: b.ts" }, CWD), tool).toEqual(unknown);
        expect(toolTargets(tool, { patchText: "--- a/x\n+++ b/x\n@@\n-a\n+b" }, CWD), tool).toEqual(unknown);
        expect(toolTargets(tool, { patchText: "" }, CWD), tool).toEqual(unknown);
      }
    });

    it("reads patchText, patch_text, patch, input: the first string wins, even when empty (QA-1.3-3)", () => {
      for (const key of ["patchText", "patch_text", "patch", "input"]) {
        expect(toolTargets("apply_patch", { [key]: "*** Add File: k.ts" }, CWD).paths, key).toEqual([p("k.ts")]);
      }
      expect(toolTargets("apply_patch", { input: "*** Add File: i.ts", patch: "*** Add File: b.ts" }, CWD).paths).toEqual([p("b.ts")]);
      expect(toolTargets("apply_patch", { patch: "*** Add File: b.ts", patch_text: "*** Add File: t.ts" }, CWD).paths).toEqual([p("t.ts")]);
      expect(toolTargets("apply_patch", { patch_text: "", input: "*** Add File: i.ts" }, CWD).paths).toEqual([]);
    });

    it("reads patchText first, then patch; a string patchText wins even when empty", () => {
      expect(toolTargets("apply_patch", { patch: "*** Add File: b.ts" }, CWD).paths).toEqual([p("b.ts")]);
      expect(toolTargets("apply_patch", { patchText: "*** Add File: a.ts", patch: "*** Add File: b.ts" }, CWD).paths).toEqual([p("a.ts")]);
      expect(toolTargets("apply_patch", { patchText: "", patch: "*** Add File: b.ts" }, CWD).paths).toEqual([]);
      expect(toolTargets("apply_patch", { patchText: 5, patch: "*** Add File: b.ts" }, CWD).paths).toEqual([p("b.ts")]);
      expect(toolTargets("apply_patch", { patchText: null, patch: ["x"] }, CWD).paths).toEqual([]);
    });

    it("also takes filePath, path and file_path like the host, after the header paths (QA-1.3-32)", () => {
      for (const tool of ["apply_patch", "patch"]) {
        expect(toolTargets(tool, { path: "a.ts" }, CWD), tool).toEqual({ access: "write", paths: [p("a.ts")], roots: [] });
        expect(toolTargets(tool, { filePath: "f", path: "g", file_path: "h" }, CWD).paths, tool).toEqual([p("f"), p("g"), p("h")]);
        expect(
          toolTargets(tool, { patchText: "*** Add File: x.ts", filePath: "f", path: "x.ts" }, CWD).paths,
          tool,
        ).toEqual([p("x.ts"), p("f")]);
        // `file` is not a host patch key.
        expect(toolTargets(tool, { file: "c.ts" }, CWD).paths, tool).toEqual([]);
        expect(toolTargets(tool, { path: "" }, CWD).paths, tool).toEqual([]);
      }
    });

    it("applyPatchHeaderPaths on non-object arguments is empty and does not throw", () => {
      for (const args of [undefined, null, "*** Add File: a", 5, true, [], {}, { patchText: {} }]) {
        expect(applyPatchHeaderPaths(args)).toEqual([]);
      }
      expect(applyPatchHeaderPaths({ patchText: "*** Add File:  a.ts \r\n*** Move to: b.ts\r\n" })).toEqual(["a.ts", "b.ts"]);
      // v1 frozen: the dispatch.ts parser still ignores indented headers and the host-only keys.
      expect(applyPatchHeaderPaths({ patchText: "  *** Add File: indented.ts\n*** Add File: ok.ts" })).toEqual(["ok.ts"]);
      expect(applyPatchHeaderPaths({ input: "*** Add File: a.ts", patch_text: "*** Add File: b.ts" })).toEqual([]);
    });
  });
});

describe("toolTargets: search tools", () => {
  for (const tool of ["list", "grep"]) {
    it(`${tool}: path ?? cwd`, () => {
      expect(toolTargets(tool, { pattern: "x" }, CWD)).toEqual({ access: "search", paths: [], roots: [CWD] });
      expect(toolTargets(tool, { path: "src" }, CWD).roots).toEqual([p("src")]);
      expect(toolTargets(tool, { path: ABS }, CWD).roots).toEqual([ABS]);
      expect(toolTargets(tool, { path: "" }, CWD).roots).toEqual([CWD]);
      expect(toolTargets(tool, { path: 3 }, CWD).roots).toEqual([CWD]);
      expect(toolTargets(tool, { filePath: "ignored" }, CWD).roots).toEqual([CWD]);
    });
  }

  describe("glob", () => {
    it("searches path ?? cwd for a relative pattern", () => {
      expect(toolTargets("glob", {}, CWD)).toEqual({ access: "search", paths: [], roots: [CWD] });
      expect(toolTargets("glob", { pattern: "**/*.ts" }, CWD).roots).toEqual([CWD]);
      expect(toolTargets("glob", { pattern: "src/*.ts", path: "sub" }, CWD).roots).toEqual([p("sub")]);
      expect(toolTargets("glob", { pattern: "" }, CWD).roots).toEqual([CWD]);
      expect(toolTargets("glob", { pattern: 5 }, CWD).roots).toEqual([CWD]);
      expect(toolTargets("glob", { pattern: ".." }, CWD).roots).toEqual([CWD]);
    });

    it("adds the static prefix of an absolute pattern", () => {
      const other = rooted("/other/dir");
      expect(toolTargets("glob", { pattern: "/other/dir/**/*.ts" }, CWD).roots).toEqual([CWD, other]);
      expect(toolTargets("glob", { pattern: "/other/dir/file.ts" }, CWD).roots).toEqual([CWD, other]);
      expect(toolTargets("glob", { pattern: "/other/dir/sub/*/x.ts" }, CWD).roots).toEqual([CWD, rooted("/other/dir/sub")]);
      expect(toolTargets("glob", { pattern: "/other/d{a,b}/x" }, CWD).roots).toEqual([CWD, rooted("/other")]);
    });

    it("anchors an absolute pattern with no static directory at the filesystem root", () => {
      const fsRoot = rooted("/");
      expect(toolTargets("glob", { pattern: "/**" }, CWD).roots).toEqual([CWD, fsRoot]);
      expect(toolTargets("glob", { pattern: "/file.ts" }, CWD).roots).toEqual([CWD, fsRoot]);
      expect(toolTargets("glob", { pattern: "/" }, CWD).roots).toEqual([CWD, fsRoot]);
    });

    it("adds the prefix of a pattern that starts with .., resolved against the search root", () => {
      expect(toolTargets("glob", { pattern: "../sibling/*.ts" }, CWD).roots).toEqual([CWD, p("../sibling")]);
      expect(toolTargets("glob", { pattern: "../*.ts" }, CWD).roots).toEqual([CWD, p("..")]);
      expect(toolTargets("glob", { pattern: "../../x/**" }, CWD).roots).toEqual([CWD, p("../../x")]);
      expect(toolTargets("glob", { pattern: "../x/file.ts" }, CWD).roots).toEqual([CWD, p("../x")]);
      expect(toolTargets("glob", { pattern: "../(a)/x" }, CWD).roots).toEqual([CWD, p("..")]);
      expect(toolTargets("glob", { pattern: "../!n/x" }, CWD).roots).toEqual([CWD, p("..")]);
      // A backslash counts as a separator on every platform (fail-safe over-approximation): on POSIX it may be a glob escape,
      // and `..\/sibling` (an escaped `/`) must not hide a `..` that leaves the root.
      expect(toolTargets("glob", { pattern: "..\\win\\*.ts" }, CWD).roots).toEqual([CWD, p("../win")]);
      expect(toolTargets("glob", { pattern: "..\\/sibling/*.ts" }, CWD).roots).toEqual([CWD, p("../sibling")]);
      expect(toolTargets("glob", { pattern: "../sibling/*.ts", path: "sub" }, CWD).roots).toEqual([p("sub"), p("sibling")]);
    });

    it("dedupes a prefix equal to the search root", () => {
      expect(toolTargets("glob", { pattern: `${CWD.replace(/\\/g, "/")}/*.ts` }, CWD).roots).toEqual([CWD]);
    });

    it.runIf(win)("anchors a drive-letter pattern at its drive", () => {
      expect(toolTargets("glob", { pattern: "C:\\proj\\*.ts" }, CWD).roots).toEqual([CWD, resolve("C:/proj")]);
      expect(toolTargets("glob", { pattern: "C:/*.ts" }, CWD).roots).toEqual([CWD, resolve("C:/")]);
    });

    it("does not anchor a relative pattern whose .. stays inside the search root", () => {
      expect(toolTargets("glob", { pattern: "src/../x/*.ts" }, CWD).roots).toEqual([CWD]);
      expect(toolTargets("glob", { pattern: "./a/b/../../x/**" }, CWD).roots).toEqual([CWD]);
    });

    it("anchors a pattern that reaches outside through a .. in the middle (QA-1.3-14)", () => {
      expect(toolTargets("glob", { pattern: "src/../../w1/**" }, CWD).roots).toEqual([CWD, p("../w1")]);
      expect(toolTargets("glob", { pattern: "./../w1/**" }, CWD).roots).toEqual([CWD, p("../w1")]);
      expect(toolTargets("glob", { pattern: "a/b/../../../w1/x.ts" }, CWD).roots).toEqual([CWD, p("../w1")]);
      expect(toolTargets("glob", { pattern: "src/../../*.ts" }, CWD).roots).toEqual([CWD, p("..")]);
      expect(toolTargets("glob", { pattern: "src/../../w1/**", path: "sub" }, CWD).roots).toEqual([p("sub"), p("w1")]);
    });

    it("drops wildcard segments before resolving .., so the root covers the widest reading (QA-1.3-24)", () => {
      // `**` may match nothing (../../w1) or one directory (../w1): both readings are roots.
      expect(toolTargets("glob", { pattern: "**/../../w1/**" }, CWD).roots).toEqual([CWD, p("../../w1"), p("../w1")]);
      expect(toolTargets("glob", { pattern: "*/../../w1/x.ts" }, CWD).roots).toEqual([CWD, p("../../w1"), p("../w1")]);
      expect(toolTargets("glob", { pattern: "{a,b}/../../w1/**" }, CWD).roots).toEqual([CWD, p("../../w1"), p("../w1")]);
      expect(toolTargets("glob", { pattern: "src/*/../../w1/*.ts" }, CWD).roots).toEqual([CWD, p("../w1")]);
      expect(toolTargets("glob", { pattern: "**/../x/**" }, CWD).roots).toEqual([CWD, p("../x")]);
      // A wildcard after the last .. still ends the static prefix.
      expect(toolTargets("glob", { pattern: "../a/*/b/x" }, CWD).roots).toEqual([CWD, p("../a")]);
      // A pattern that stays inside the root is not anchored, wildcards or not.
      expect(toolTargets("glob", { pattern: "a/**/b/../c/*.ts" }, CWD).roots).toEqual([CWD]);
    });
  });
});

describe("toolTargets: run and shell tools", () => {
  it("router_run: the cwd argument ?? cwd", () => {
    expect(toolTargets("router_run", { script: "test" }, CWD)).toEqual({ access: "run", paths: [], roots: [CWD] });
    expect(toolTargets("router_run", { script: "test", cwd: "pkg" }, CWD).roots).toEqual([p("pkg")]);
    expect(toolTargets("router_run", { cwd: ABS }, CWD).roots).toEqual([ABS]);
    expect(toolTargets("router_run", { cwd: "" }, CWD).roots).toEqual([CWD]);
    expect(toolTargets("router_run", { cwd: 4 }, CWD).roots).toEqual([CWD]);
  });

  it("shell: no access, uncovered, workdir ?? cwd", () => {
    expect(toolTargets("shell", { command: "ls" }, CWD)).toEqual({ access: "none", paths: [], roots: [CWD], uncovered: "shell" });
    expect(toolTargets("shell", { workdir: "sub" }, CWD)).toEqual({ access: "none", paths: [], roots: [p("sub")], uncovered: "shell" });
    expect(toolTargets("shell", { workdir: 1 }, CWD).roots).toEqual([CWD]);
  });

  it("execute: no access, uncovered, no roots", () => {
    expect(toolTargets("execute", { code: "1" }, CWD)).toEqual({ access: "none", paths: [], roots: [], uncovered: "execute" });
    expect(toolTargets("execute", null, CWD)).toEqual({ access: "none", paths: [], roots: [], uncovered: "execute" });
  });

  it("anything else touches nothing", () => {
    for (const tool of ["bash", "webfetch", "task", "todowrite", "", "router_plan", "read2", "router_unknown"]) {
      expect(toolTargets(tool, { path: "a.ts", cwd: "x" }, CWD), tool).toEqual(NONE);
    }
  });
});

/** The repository top level is the session directory. */
const GIT = { gitRoot: CWD };

describe("toolTargets: router_git_* tools", () => {
  describe("paths are relative to the repository top level (QA-1.3-1)", () => {
    const TOP = resolve("/work/repo");
    const WORK = resolve(TOP, "packages/app");
    const top = (...segments: string[]): string => resolve(TOP, ...segments);

    it("resolves a path against gitRoot when the work root is below the top level", () => {
      const opts = { gitRoot: TOP };
      expect(toolTargets("router_git_blame", { path: "packages/app/a.ts" }, WORK, opts)).toEqual({
        access: "read",
        paths: [resolve(WORK, "a.ts")],
        roots: [],
      });
      expect(toolTargets("router_git_diff", { path: "packages/app/src" }, WORK, opts)).toEqual({
        access: "search",
        paths: [],
        roots: [resolve(WORK, "src")],
      });
      expect(toolTargets("router_git_status", { path: "other" }, WORK, opts).roots).toEqual([top("other")]);
      expect(toolTargets("router_git_ls_files", { path: "other/x" }, WORK, opts).roots).toEqual([top("other/x")]);
    });

    it("without a path the search tools cover the top level, not the work root (QA-1.3-23)", () => {
      const opts = { gitRoot: TOP };
      expect(toolTargets("router_git_status", {}, WORK, opts)).toEqual({ access: "search", paths: [], roots: [TOP] });
      expect(toolTargets("router_git_ls_files", { path: 3 }, WORK, opts).roots).toEqual([TOP]);
      expect(toolTargets("router_git_diff", { path: "" }, WORK, opts).roots).toEqual([TOP]);
      expect(toolTargets("router_git_blame", {}, WORK, opts)).toEqual({ access: "read", paths: [], roots: [] });
    });

    it("an absolute path stays as it is", () => {
      expect(toolTargets("router_git_blame", { path: ABS }, WORK, { gitRoot: TOP }).paths).toEqual([ABS]);
    });

    it("sets no gitRootRequired flag when gitRoot is given, and none for history-only tools", () => {
      expect(toolTargets("router_git_blame", { path: "a" }, WORK, { gitRoot: TOP })).not.toHaveProperty("gitRootRequired");
      expect(toolTargets("router_git_log", { path: "a" }, WORK)).toEqual(NONE);
      expect(toolTargets("router_git_diff", { ref: "a..b" }, WORK)).toEqual(NONE);
    });

    it("has no concrete target and flags gitRootRequired when gitRoot is absent or not absolute (QA-1.3-23)", () => {
      for (const opts of [undefined, {}, { gitRoot: "" }, { gitRoot: "rel/top" }, { gitRoot: 5 as unknown as string }]) {
        expect(toolTargets("router_git_blame", { path: "a.ts" }, WORK, opts)).toEqual({
          access: "read",
          paths: [],
          roots: [],
          gitRootRequired: true,
        });
        expect(toolTargets("router_git_status", { path: "d" }, WORK, opts)).toEqual({
          access: "search",
          paths: [],
          roots: [],
          gitRootRequired: true,
        });
        expect(toolTargets("router_git_diff", {}, WORK, opts)).toEqual({
          access: "search",
          paths: [],
          roots: [],
          gitRootRequired: true,
        });
      }
    });

    it("other tools resolve against cwd and never carry the flag", () => {
      expect(toolTargets("read", { path: "a.ts" }, WORK, { gitRoot: TOP }).paths).toEqual([resolve(WORK, "a.ts")]);
      expect(toolTargets("grep", { path: "src" }, WORK)).not.toHaveProperty("gitRootRequired");
    });
  });

  describe("router_git_blame", () => {
    it("a blame without a ref reads the working-tree file", () => {
      expect(toolTargets("router_git_blame", { path: "a.ts" }, CWD, GIT)).toEqual({ access: "read", paths: [p("a.ts")], roots: [] });
      expect(toolTargets("router_git_blame", { path: "a.ts", ref: "" }, CWD, GIT).access).toBe("read");
      expect(toolTargets("router_git_blame", { path: "a.ts", ref: "   " }, CWD, GIT).access).toBe("read");
      expect(toolTargets("router_git_blame", { path: "a.ts", ref: 5 }, CWD, GIT).access).toBe("read");
      expect(toolTargets("router_git_blame", { path: "a.ts", ref: null }, CWD, GIT).access).toBe("read");
    });

    it("a blame at a ref reads committed content only", () => {
      expect(toolTargets("router_git_blame", { path: "a.ts", ref: "HEAD~1" }, CWD)).toEqual(NONE);
      expect(toolTargets("router_git_blame", { path: "a.ts", ref: " v1 " }, CWD)).toEqual(NONE);
    });

    it("uses only the path key; no path is a read of nothing", () => {
      expect(toolTargets("router_git_blame", {}, CWD, GIT)).toEqual({ access: "read", paths: [], roots: [] });
      expect(toolTargets("router_git_blame", { filePath: "a.ts" }, CWD, GIT).paths).toEqual([]);
      expect(toolTargets("router_git_blame", { path: "" }, CWD, GIT).paths).toEqual([]);
    });
  });

  describe("router_git_diff (a diff against the working tree reads it; commit-to-commit and --cached do not)", () => {
    it("no ref: working tree against the index, a search of path ?? cwd", () => {
      expect(toolTargets("router_git_diff", {}, CWD, GIT)).toEqual({ access: "search", paths: [], roots: [CWD] });
      expect(toolTargets("router_git_diff", { path: "src" }, CWD, GIT).roots).toEqual([p("src")]);
      expect(toolTargets("router_git_diff", { mode: "stat" }, CWD, GIT).access).toBe("search");
      expect(toolTargets("router_git_diff", { mode: "name-only" }, CWD, GIT).access).toBe("search");
    });

    it("a single ref compares a commit with the working tree: a search", () => {
      expect(toolTargets("router_git_diff", { ref: "main" }, CWD, GIT)).toEqual({ access: "search", paths: [], roots: [CWD] });
      expect(toolTargets("router_git_diff", { ref: " HEAD " }, CWD, GIT).access).toBe("search");
      expect(toolTargets("router_git_diff", { ref: "HEAD~2", path: "pkg" }, CWD, GIT).roots).toEqual([p("pkg")]);
    });

    it("an empty, blank or non-string ref counts as absent", () => {
      expect(toolTargets("router_git_diff", { ref: "" }, CWD).access).toBe("search");
      expect(toolTargets("router_git_diff", { ref: "  " }, CWD).access).toBe("search");
      expect(toolTargets("router_git_diff", { ref: 5 }, CWD).access).toBe("search");
      expect(toolTargets("router_git_diff", { ref: ["a..b"] }, CWD).access).toBe("search");
    });

    it("a range is commit against commit: none", () => {
      expect(toolTargets("router_git_diff", { ref: "a..b" }, CWD)).toEqual(NONE);
      expect(toolTargets("router_git_diff", { ref: "a...b" }, CWD)).toEqual(NONE);
      expect(toolTargets("router_git_diff", { ref: "  main..HEAD  ", path: "x" }, CWD)).toEqual(NONE);
    });

    it('mode "cached" is index against HEAD or the ref: none', () => {
      expect(toolTargets("router_git_diff", { mode: "cached" }, CWD)).toEqual(NONE);
      expect(toolTargets("router_git_diff", { mode: "cached", ref: "main" }, CWD)).toEqual(NONE);
      expect(toolTargets("router_git_diff", { mode: "cached", path: "src" }, CWD)).toEqual(NONE);
      expect(toolTargets("router_git_diff", { mode: "CACHED" }, CWD).access).toBe("search");
    });
  });

  for (const tool of ["router_git_status", "router_git_ls_files"]) {
    it(`${tool}: a search of path ?? cwd`, () => {
      expect(toolTargets(tool, {}, CWD, GIT)).toEqual({ access: "search", paths: [], roots: [CWD] });
      expect(toolTargets(tool, { path: "pkg" }, CWD, GIT).roots).toEqual([p("pkg")]);
    });
  }

  for (const tool of ["router_git_log", "router_git_show"]) {
    it(`${tool}: history only, none`, () => {
      expect(toolTargets(tool, { path: "a.ts", ref: "HEAD" }, CWD)).toEqual(NONE);
      expect(toolTargets(tool, undefined, CWD)).toEqual(NONE);
    });
  }
});

describe("toolTargets: arguments and cwd that are not what they should be", () => {
  const KINDS: [string, unknown][] = [
    ["undefined", undefined],
    ["null", null],
    ["a string", "path"],
    ["a number", 7],
    ["a boolean", true],
    ["an array", [{ path: "a.ts" }]],
    ["an empty object", {}],
  ];
  const TOOLS = [
    "read", "write", "edit", "multiedit", "patch", "apply_patch", "list", "grep", "glob", "router_run",
    "router_git_blame", "router_git_diff", "router_git_status", "router_git_ls_files", "router_git_log",
    "router_git_show", "shell", "execute", "other",
  ];

  it("treats non-object arguments as empty for every tool", () => {
    for (const tool of TOOLS) {
      const baseline = toolTargets(tool, {}, CWD);
      for (const [name, args] of KINDS) expect(toolTargets(tool, args, CWD), `${tool} with ${name}`).toEqual(baseline);
    }
  });

  it("drops relative paths when cwd is not absolute, keeps absolute ones", () => {
    for (const cwd of ["relative/dir", "", "."]) {
      expect(toolTargets("read", { path: "a.ts" }, cwd).paths).toEqual([]);
      expect(toolTargets("read", { path: ABS }, cwd).paths).toEqual([ABS]);
      expect(toolTargets("write", { path: "a.ts" }, cwd)).toEqual({ access: "write", paths: [], roots: [] });
      expect(toolTargets("multiedit", { path: ABS, edits: [{ path: "rel.ts" }] }, cwd).paths).toEqual([ABS]);
      expect(toolTargets("apply_patch", { patchText: `*** Add File: rel.ts\n*** Add File: ${ABS}` }, cwd).paths).toEqual([ABS]);
      expect(toolTargets("grep", {}, cwd).roots).toEqual([]);
      expect(toolTargets("grep", { path: ABS }, cwd).roots).toEqual([ABS]);
      expect(toolTargets("grep", { path: "sub" }, cwd).roots).toEqual([]);
      expect(toolTargets("router_run", {}, cwd).roots).toEqual([]);
      expect(toolTargets("router_run", { cwd: ABS }, cwd).roots).toEqual([ABS]);
      expect(toolTargets("shell", {}, cwd)).toEqual({ access: "none", paths: [], roots: [], uncovered: "shell" });
      expect(toolTargets("router_git_blame", { path: "a.ts" }, cwd)).toEqual({ access: "read", paths: [], roots: [], gitRootRequired: true });
      expect(toolTargets("router_git_blame", { path: "a.ts" }, cwd, { gitRoot: ABS }).paths).toEqual([resolve(ABS, "a.ts")]);
    }
  });

  it("drops a relative glob prefix when there is no absolute base", () => {
    const result = toolTargets("glob", { pattern: "../x/*.ts" }, "relative");
    expect(result).toEqual({ access: "search", paths: [], roots: [] });
    expect(toolTargets("glob", { pattern: "/other/*.ts" }, "relative").roots).toEqual([rooted("/other")]);
  });

  it("treats a cwd that is not a string as empty", () => {
    expect(toolTargets("read", { path: "a.ts" }, undefined as unknown as string).paths).toEqual([]);
    expect(toolTargets("read", { path: ABS }, 5 as unknown as string).paths).toEqual([ABS]);
  });

  it("returns none for a tool that is not a string", () => {
    for (const tool of [undefined, null, 5, {}, ["read"]]) {
      expect(toolTargets(tool as unknown as string, { path: "a.ts" }, CWD)).toEqual(NONE);
    }
  });

  it("dedupes in first-seen order across spellings of one path", () => {
    const result = toolTargets(
      "multiedit",
      { path: "z.ts", edits: [{ path: "a.ts" }, { path: "./z.ts" }, { path: "sub/../a.ts" }, { path: "m.ts" }, { path: "a.ts" }] },
      CWD,
    );
    expect(result.paths).toEqual([p("z.ts"), p("a.ts"), p("m.ts")]);
  });
});

describe("toolTargets never throws", () => {
  const boom = (): never => {
    throw new Error("boom");
  };
  const hostile = (): Record<string, unknown> => {
    const target: Record<string, unknown> = {};
    for (const key of ["filePath", "path", "file", "edits", "patchText", "patch", "pattern", "cwd", "workdir", "ref", "mode"]) {
      Object.defineProperty(target, key, { get: boom, enumerable: true });
    }
    return target;
  };
  const TOOLS = [
    "read", "write", "edit", "multiedit", "patch", "apply_patch", "list", "grep", "glob", "router_run",
    "router_git_blame", "router_git_diff", "router_git_status", "router_git_ls_files", "router_git_log",
    "router_git_show", "shell", "execute", "other",
  ];

  it("survives a getter that throws: a write-class tool stays a write, the rest is none", () => {
    for (const tool of TOOLS) {
      const result = toolTargets(tool, hostile(), CWD);
      if (WRITE_CLASS.has(tool)) expect(result, tool).toEqual({ access: "write", paths: [], roots: [] });
      else if (tool === "router_git_status" || tool === "router_git_ls_files") {
        // No gitRoot: no concrete target, flagged, before any argument is read.
        expect(result, tool).toEqual({ access: "search", paths: [], roots: [], gitRootRequired: true });
      }
      else if (tool === "execute" || tool === "router_git_log" || tool === "router_git_show" || tool === "other") {
        expect(result.paths, tool).toEqual([]);
      } else expect(result, tool).toEqual(NONE);
    }
  });

  it("survives a proxy that throws on every access, and a revoked proxy", () => {
    const trap = new Proxy({}, { get: boom, has: boom, ownKeys: boom, getOwnPropertyDescriptor: boom });
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    for (const args of [trap, revocable.proxy]) {
      for (const tool of TOOLS) {
        expect(() => toolTargets(tool, args, CWD), tool).not.toThrow();
      }
      expect(toolTargets("write", args, CWD)).toEqual({ access: "write", paths: [], roots: [] });
      expect(toolTargets("read", args, CWD)).toEqual(NONE);
    }
  });

  it("survives a path value whose toString would throw (it is ignored as a non-string)", () => {
    const evil = { toString: boom };
    expect(toolTargets("read", { path: evil }, CWD)).toEqual({ access: "read", paths: [], roots: [] });
  });
});

describe.runIf(win)("QA-1.3-19: device-prefixed and drive-less rooted paths reach the registry unchanged", () => {
  const registry = () => {
    const dirs = new Set(["C:\\", "C:\\r", "C:\\Other"]);
    return createLeaseRegistry(
      {
        realpath: (path: string): string => {
          if (dirs.has(path)) return path;
          throw new Error(`ENOENT: ${path}`);
        },
        repoKeyOf: (dir: string) => (/^c:[\\/]r(?:[\\/]|$)/i.test(dir) ? { repo: "R", tree: "C:/r" } : undefined),
        now: () => 1_000,
      },
      { runMode: "annotate", platform: "win32" },
    );
  };
  const owner: HolderInput = { holderID: "A", tree: "C:\\r", isChild: true, scope: "until-complete" };
  const other: HolderInput = { ...owner, holderID: "B" };

  it("returns the spellings unchanged", () => {
    expect(toolTargets("write", { path: "\\??\\C:\\r\\x.ts" }, "C:\\r").paths).toEqual(["\\??\\C:\\r\\x.ts"]);
    expect(toolTargets("write", { path: "\\\\?\\C:\\r\\x.ts" }, "C:\\r").paths).toEqual(["\\\\?\\C:\\r\\x.ts"]);
    expect(toolTargets("write", { path: "\\\\.\\C:\\r\\x.ts" }, "C:\\r").paths).toEqual(["\\\\.\\C:\\r\\x.ts"]);
    expect(toolTargets("write", { path: "\\r\\x.ts" }, "C:\\r").paths).toEqual(["\\r\\x.ts"]);
    expect(toolTargets("write", { path: "\\r\\x.ts" }, "relative").paths).toEqual(["\\r\\x.ts"]);
    expect(toolTargets("write", { path: "x.ts" }, "C:\\r").paths).toEqual(["C:\\r\\x.ts"]);
  });

  it("a write through either spelling is refused while a foreign child holds the file", () => {
    const reg = registry();
    expect(reg.acquireWrite(owner, "C:\\r\\x.ts")).toMatchObject({ ok: true, leased: ["C:\\r\\x.ts"] });
    for (const spelling of ["\\??\\C:\\r\\x.ts", "\\\\?\\C:\\r\\x.ts", "\\\\.\\C:\\r\\x.ts"]) {
      const targets = toolTargets("write", { path: spelling }, "C:\\r");
      expect(reg.acquireWrite(other, targets.paths), spelling).toMatchObject({ ok: false, reason: "held" });
    }
    const rooted = toolTargets("write", { path: "\\r\\x.ts" }, "C:\\r");
    expect(reg.acquireWrite(other, rooted.paths)).toMatchObject({ ok: false, reason: "unknown-target" });
    expect(reg.acquireWrite(other, toolTargets("write", { path: "y.ts" }, "C:\\r").paths)).toMatchObject({ ok: true });
  });
});

describe("WRITE_CLASS", () => {
  it("equals WRITE_TOOLS in src/verify/dispatch.ts", () => {
    const source = readFileSync(fileURLToPath(new URL("../../src/verify/dispatch.ts", import.meta.url)), "utf8");
    const declaration = /const WRITE_TOOLS = new Set\(\[([^\]]*)\]\)/.exec(source);
    if (declaration === null) throw new Error("WRITE_TOOLS declaration not found in src/verify/dispatch.ts");
    const names = [...(declaration[1] ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
    expect(names.length).toBeGreaterThan(0);
    expect([...WRITE_CLASS].sort()).toEqual([...names].sort());
    expect([...WRITE_CLASS].sort()).toEqual(["apply_patch", "edit", "multiedit", "patch", "write"]);
  });

  it("makes every member a write", () => {
    for (const tool of WRITE_CLASS) expect(toolTargets(tool, {}, CWD).access).toBe("write");
  });
});
