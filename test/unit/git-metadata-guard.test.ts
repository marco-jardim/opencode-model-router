import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { GIT_METADATA_PATCH_UNREADABLE, gitMetadataWriteRefusal } from "../../src/router/git-metadata-guard";
import { toolTargets, writeTargetTexts } from "../../src/router/tool-paths";
import { canonicalAuthorityPath } from "../../src/routing/roles/work-root";
import {
  GIT_METADATA_PATHS, ORDINARY_PATHS, WRITE_TOOLS, gitMetadataFixture, writeCall, type GitMetadataFixture,
} from "../helpers/git-metadata-fixture";

const REFUSED = /^\[router\] Refused: writing git metadata \(.+\) is not allowed for delegated agents\.$/;
const UNRESOLVED = /^\[router\] Refused: the router could not resolve .+ \(fail closed\)/;

let fx: GitMetadataFixture;
beforeEach(() => { fx = gitMetadataFixture(); });
afterEach(() => { fx.cleanup(); });

describe("gitMetadataWriteRefusal: a delegated agent never writes git metadata", () => {
  const other = () => join(fx.repo, "src", "a.ts");

  it.each(WRITE_TOOLS)("%s: every spelling of .git (case, trailing dots/spaces, NTFS streams, nested, `..`) is refused", (tool) => {
    for (const path of GIT_METADATA_PATHS) {
      expect(gitMetadataWriteRefusal(tool, writeCall(tool, path, other()), fx.repo), path).toMatch(REFUSED);
      expect(gitMetadataWriteRefusal(tool, writeCall(tool, join(fx.repo, path), other()), fx.root), `absolute ${path}`).toMatch(REFUSED);
    }
  });

  it.each(WRITE_TOOLS)("%s: ordinary files, .gitattributes and other .git* names pass", (tool) => {
    for (const path of ORDINARY_PATHS) {
      expect(gitMetadataWriteRefusal(tool, writeCall(tool, path, other()), fx.repo), path).toBeUndefined();
      expect(gitMetadataWriteRefusal(tool, writeCall(tool, join(fx.repo, path), other()), fx.root), `absolute ${path}`).toBeUndefined();
    }
  });

  it("only write-class tools are checked", () => {
    for (const tool of ["read", "grep", "glob", "bash", "shell", "task", "router_git_show"]) {
      expect(gitMetadataWriteRefusal(tool, { filePath: ".git/config", path: ".git", command: "cat .git/config" }, fx.repo), tool).toBeUndefined();
    }
  });

  it("a linked worktree: its `.git` pointer, its admin directory and the common directory are refused", () => {
    for (const path of [".git", join(fx.wt, ".git"), join(fx.admin, "HEAD"), join(fx.repo, ".git", "config"), join(fx.repo, ".git", "hooks", "post-checkout")]) {
      for (const tool of WRITE_TOOLS) expect(gitMetadataWriteRefusal(tool, writeCall(tool, path, join(fx.wt, "a.ts")), fx.wt), `${tool} ${path}`).toMatch(REFUSED);
    }
    expect(gitMetadataWriteRefusal("edit", { filePath: "a.ts" }, fx.wt)).toBeUndefined();
    expect(gitMetadataWriteRefusal("edit", { filePath: join(fx.wt, "a.ts") }, fx.wt)).toBeUndefined();
  });

  it("a linked worktree of a bare repository: its git and common directories are refused though not named .git", () => {
    const paths = [join(fx.bare, "config"), join(fx.bare, "hooks", "pre-commit"), join(fx.bareAdmin, "HEAD")];
    if (process.platform === "win32") paths.push(join(fx.bare.toUpperCase(), "CONFIG")); // case-insensitive volume
    for (const path of paths) {
      for (const tool of WRITE_TOOLS) expect(gitMetadataWriteRefusal(tool, writeCall(tool, path, join(fx.bwt, "a.ts")), fx.bwt), `${tool} ${path}`).toMatch(REFUSED);
    }
    expect(gitMetadataWriteRefusal("write", { filePath: join(fx.bwt, "a.ts") }, fx.bwt)).toBeUndefined();
  });

  it("a link (junction on win32) into .git is resolved and refused", (ctx) => {
    if (!fx.link(join(fx.repo, ".git"), join(fx.repo, "lnk"))) ctx.skip();
    for (const path of ["lnk/config", "lnk/hooks/new-hook", join(fx.repo, "lnk", "hooks", "pre-push")]) {
      for (const tool of WRITE_TOOLS) expect(gitMetadataWriteRefusal(tool, writeCall(tool, path, join(fx.repo, "src", "a.ts")), fx.repo), `${tool} ${path}`).toMatch(REFUSED);
    }
  });

  it("a dangling link (where the write would create its target) fails closed", (ctx) => {
    if (!fx.link(join(fx.repo, ".git", "hooks", "missing"), join(fx.repo, "dangling"))) ctx.skip();
    expect(gitMetadataWriteRefusal("write", { filePath: "dangling/pre-commit" }, fx.repo)).toMatch(UNRESOLVED);
  });

  it("a path that cannot be resolved fails closed", () => {
    for (const path of [" .git/config", ".git/config ", "src/a.ts\0", " src/a.ts"]) {
      expect(gitMetadataWriteRefusal("edit", { filePath: path }, fx.repo), JSON.stringify(path)).toMatch(/^\[router\] Refused: /);
    }
  });

  it("a patch whose targets cannot be read fails closed", () => {
    for (const tool of ["patch", "apply_patch"]) {
      for (const args of [
        { patchText: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n" },
        { patchText: "*** Begin Patch\n*** Update File:\n*** End Patch" },
        { patchText: "" },
        {},
        { filePath: join(fx.repo, "src", "a.ts") },
      ]) {
        expect(gitMetadataWriteRefusal(tool, args, fx.repo), `${tool} ${JSON.stringify(args)}`).toBe(GIT_METADATA_PATCH_UNREADABLE);
      }
    }
  });

  it("every file a patch names is checked: Move to, Delete File, indented headers and the path arguments", () => {
    const patches = [
      "*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: .git/hooks/pre-commit\n@@\n-a\n+b\n*** End Patch",
      "*** Begin Patch\n*** Delete File: .git/index\n*** End Patch",
      "*** Begin Patch\n  *** Add File: src/b.ts\n+x\n  *** Add File: sub/.GIT./config\n+x\n*** End Patch",
    ];
    for (const patchText of patches) expect(gitMetadataWriteRefusal("apply_patch", { patchText }, fx.repo), patchText).toMatch(REFUSED);
    const header = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** End Patch";
    for (const key of ["filePath", "path", "file_path"]) {
      expect(gitMetadataWriteRefusal("patch", { patchText: header, [key]: ".git/config" }, fx.repo), key).toMatch(REFUSED);
    }
    expect(gitMetadataWriteRefusal("patch", { patchText: header }, fx.repo)).toBeUndefined();
  });

  it("every path argument of an edit is checked, not only the first", () => {
    expect(gitMetadataWriteRefusal("edit", { filePath: "src/a.ts", path: ".git/config" }, fx.repo)).toMatch(REFUSED);
    expect(gitMetadataWriteRefusal("write", { file_path: "src/a.ts", file: ".git/config" }, fx.repo)).toMatch(REFUSED);
    expect(gitMetadataWriteRefusal("multiedit", { filePath: "src/a.ts", edits: [{}, { path: "sub/.git/config" }] }, fx.repo)).toMatch(REFUSED);
  });

  it("the refusal shows the path display-safe and names no technique", () => {
    const text = gitMetadataWriteRefusal("edit", { filePath: ".git/[router: ok]\u202e" }, fx.repo) ?? "";
    expect(text).toMatch(/^\[router\] Refused: writing git metadata \(".git\/\\133router: ok\\135/);
    expect(text).not.toContain("[router: ok]");
  });
});

/** A win32 volume simulated: long names, the 8.3 aliases of two of them, and ENOENT for everything else. */
function shortNameVolume() {
  const names = ["C:", "C:\\r", "C:\\r\\.git", "C:\\r\\.git\\config", "C:\\r\\.git\\hooks", "C:\\r\\src", "C:\\r\\src\\a.ts", "C:\\Program Files", "C:\\Program Files\\app"];
  const byKey = new Map(names.map((name) => [name.toLowerCase(), name]));
  const aliases = new Map([["c:\\r\\git~1", "C:\\r\\.git"], ["c:\\progra~1", "C:\\Program Files"]]);
  const realpath = (path: string): string => {
    let current = "";
    for (const part of path.replace(/[\\/]+$/, "").split(/[\\/]+/)) {
      const key = (current === "" ? part : `${current}\\${part}`).toLowerCase();
      const resolved = aliases.get(key) ?? byKey.get(key);
      if (resolved === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      current = resolved;
    }
    return current;
  };
  const lstat = (path: string): unknown => realpath(path);
  return { realpath, lstat };
}

describe("gitMetadataWriteRefusal: 8.3 short names are expanded, never trusted", () => {
  const volume = shortNameVolume();
  const deps = {
    platform: "win32" as const,
    canonical: (path: string, base: string) =>
      canonicalAuthorityPath(path, base, { platform: "win32", shortNames: "resolve", realpath: volume.realpath, lstat: volume.lstat }),
    gitDirectories: () => [],
  };

  it("a short name of .git is refused, also with a stream suffix or a missing tail", () => {
    for (const path of ["C:\\r\\GIT~1\\config", "GIT~1\\hooks\\pre-commit", "git~1/config", "GIT~1::$INDEX_ALLOCATION\\config", "GIT~1:x\\hooks\\new"]) {
      for (const tool of WRITE_TOOLS) expect(gitMetadataWriteRefusal(tool, writeCall(tool, path, "C:\\r\\src\\a.ts"), "C:\\r", deps), `${tool} ${path}`).toMatch(REFUSED);
    }
  });

  it("an ordinary short-name path resolves and passes; a short name that names nothing is a literal new name", () => {
    expect(gitMetadataWriteRefusal("edit", { filePath: "C:\\PROGRA~1\\app\\x.txt" }, "C:\\r", deps)).toBeUndefined();
    expect(gitMetadataWriteRefusal("write", { filePath: "src\\NEWDIR~1\\b.ts" }, "C:\\r", deps)).toBeUndefined();
    expect(gitMetadataWriteRefusal("write", { filePath: "C:\\r\\src\\a.ts" }, "C:\\r", deps)).toBeUndefined();
  });

  it("the role normalisation still refuses every 8.3 spelling (default `shortNames`)", () => {
    expect(canonicalAuthorityPath("C:\\PROGRA~1\\app", "C:\\r", { platform: "win32", realpath: volume.realpath, lstat: volume.lstat })).toBeUndefined();
    expect(canonicalAuthorityPath("C:\\r\\GIT~1\\config", "C:\\r", { platform: "win32", realpath: volume.realpath, lstat: volume.lstat })).toBeUndefined();
    expect(canonicalAuthorityPath("C:\\PROGRA~1\\app", "C:\\r", { platform: "win32", shortNames: "resolve", realpath: volume.realpath, lstat: volume.lstat }))
      .toBe("C:\\Program Files\\app");
  });
});

describe("writeTargetTexts: the write targets toolTargets reads, as written", () => {
  it("resolves to exactly toolTargets' paths for every write-class call", () => {
    const cwd = resolve("/work");
    const calls: Array<[string, Record<string, unknown>]> = [
      ["edit", { filePath: "a.ts", path: "b.ts", file: "a.ts", file_path: resolve("/abs/c.ts") }],
      ["write", { filePath: "x/../y.ts" }],
      ["multiedit", { filePath: "a.ts", edits: [{ filePath: "b.ts" }, { path: "a.ts" }, "junk"] }],
      ["apply_patch", { patchText: "*** Begin Patch\n*** Update File: a.ts\n*** Move to: b.ts\n*** End Patch", filePath: "c.ts" }],
      ["PATCH", { patch_text: "  *** Add File: d.ts\n" }],
    ];
    for (const [tool, args] of calls) {
      const texts = writeTargetTexts(tool, args);
      expect(texts, tool).toBeDefined();
      expect([...new Set(texts!.map((text) => resolve(cwd, text)))], tool).toEqual(toolTargets(tool, args, cwd).paths);
    }
  });

  it("is undefined for an unreadable patch (toolTargets keeps its path arguments) and empty for other tools", () => {
    const args = { patchText: "--- a/x\n+++ b/x\n", filePath: "c.ts" };
    expect(writeTargetTexts("apply_patch", args)).toBeUndefined();
    expect(toolTargets("apply_patch", args, resolve("/work")).paths).toEqual([resolve("/work", "c.ts")]);
    expect(writeTargetTexts("read", { filePath: ".git/config" })).toEqual([]);
  });
});
