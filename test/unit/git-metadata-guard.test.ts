import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { join, resolve, win32 } from "node:path";
import { GIT_METADATA_PATCH_UNREADABLE, gitMetadataWriteRefusal, type SessionGitDirectories } from "../../src/router/git-metadata-guard";
import { toolTargets, writeTargetTexts } from "../../src/router/tool-paths";
import { canonicalAuthorityPath } from "../../src/routing/roles/work-root";
import {
  GIT_METADATA_PATHS, ORDINARY_PATHS, WRITE_TOOLS, gitMetadataFixture, writeCall, type GitMetadataFixture,
} from "../helpers/git-metadata-fixture";

const REFUSED = /^\[router\] Refused: writing git metadata \(.+\) is not allowed for delegated agents\.$/;
const UNRESOLVED = /^\[router\] Refused: the router could not resolve .+ \(fail closed\)/;
const NO_GIT: SessionGitDirectories = { directories: [], checkout: undefined };
const enoent = (path: string): Error => Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });

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

  it("a bare repository holding its own worktree: everything of it but the checkout's own files is refused", () => {
    const refused = ["../config", "../hooks/pre-commit", "../HEAD", "../worktrees/main/HEAD", "../objects/x", join(fx.proj, "config"),
      join(fx.projAdmin, "HEAD"), join(fx.projMain, "..", "hooks", "post-checkout")];
    for (const path of refused) {
      for (const tool of WRITE_TOOLS) {
        expect(gitMetadataWriteRefusal(tool, writeCall(tool, path, join(fx.projMain, "a.ts")), fx.projMain), `${tool} ${path}`).toMatch(REFUSED);
      }
    }
    // `..` through a directory that does not exist: win32 collapses it as text (refused as metadata), POSIX fails closed.
    expect(gitMetadataWriteRefusal("write", { filePath: "sub/../../hooks/post-checkout" }, fx.projMain)).toMatch(/^\[router\] Refused: /);
    for (const path of ["a.ts", "src/new/b.ts", join(fx.projMain, "a.ts"), ".gitattributes"]) {
      for (const tool of WRITE_TOOLS) {
        expect(gitMetadataWriteRefusal(tool, writeCall(tool, path, join(fx.projMain, "a.ts")), fx.projMain), `${tool} ${path}`).toBeUndefined();
      }
    }
  });

  it("`..` after a directory link: both the kernel's and the host's reading are checked", (ctx) => {
    mkdirSync(join(fx.repo, "a", "b"), { recursive: true });
    if (!fx.link(join(fx.repo, "a", "b"), join(fx.repo, "d")) || !fx.link(join(fx.repo, ".git"), join(fx.repo, "lnk"))) ctx.skip();
    // POSIX: `d/..` is `a` for the kernel, so the written path resolves to `a/lnk/hooks/x`; the host's `path.resolve` writes
    // `lnk/hooks/x`, i.e. `.git/hooks/x`. win32 collapses `..` as text for both.
    for (const path of ["d/../lnk/hooks/x", "d/../lnk/config", join(fx.repo, "d", "..", "lnk", "hooks", "x")]) {
      for (const tool of WRITE_TOOLS) expect(gitMetadataWriteRefusal(tool, writeCall(tool, path, join(fx.repo, "src", "a.ts")), fx.repo), `${tool} ${path}`).toMatch(REFUSED);
    }
    expect(gitMetadataWriteRefusal("write", { filePath: "d/../src/a.ts" }, fx.repo)).toBeUndefined();
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
  const deps = { platform: "win32" as const, realpath: volume.realpath, lstat: volume.lstat, gitDirectories: () => NO_GIT };

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

/**
 * A POSIX volume simulated with the kernel's link-first resolution: `/r/lnk -> /r/.git`, `/r/d -> /r/a/b`. Link targets are
 * absolute and canonical.
 */
function posixLinkVolume() {
  const dirs = new Set(["/r", "/r/.git", "/r/.git/hooks", "/r/a", "/r/a/b", "/r/src"]);
  const links = new Map([["/r/lnk", "/r/.git"], ["/r/d", "/r/a/b"]]);
  const walk = (path: string, followLast: boolean): string => {
    let current = "";
    const parts = path.split("/").filter((part) => part !== "" && part !== ".");
    for (const [index, part] of parts.entries()) {
      if (part === "..") { current = current.slice(0, current.lastIndexOf("/")); continue; }
      const next = `${current}/${part}`;
      const link = links.get(next);
      if (link !== undefined && (followLast || index < parts.length - 1)) current = link;
      else if (dirs.has(next) || link !== undefined) current = next;
      else throw enoent(path);
    }
    return current === "" ? "/" : current;
  };
  return { realpath: (path: string) => walk(path, true), lstat: (path: string): unknown => walk(path, false) };
}

describe("gitMetadataWriteRefusal: `..` after a link on POSIX (kernel vs host reading)", () => {
  const volume = posixLinkVolume();
  const deps = { platform: "linux" as const, ...volume, gitDirectories: () => NO_GIT };

  it("the written path alone resolves outside .git; the host's textual reading lands in it and is refused", () => {
    // The kernel's reading only: `d/..` is `/r/a`, so `.git` is never named.
    expect(canonicalAuthorityPath("d/../lnk/hooks/x", "/r", { platform: "linux", ...volume })).toBe("/r/a/lnk/hooks/x");
    for (const path of ["d/../lnk/hooks/x", "d/../lnk/config", "/r/d/../lnk/hooks/pre-commit", "src/../d/../lnk/hooks/x"]) {
      for (const tool of WRITE_TOOLS) expect(gitMetadataWriteRefusal(tool, writeCall(tool, path, "/r/src/a.ts"), "/r", deps), `${tool} ${path}`).toMatch(REFUSED);
    }
  });

  it("a link the kernel follows into .git is refused too, and ordinary paths through links pass", () => {
    expect(gitMetadataWriteRefusal("write", { filePath: "lnk/hooks/x" }, "/r", deps)).toMatch(REFUSED);
    expect(gitMetadataWriteRefusal("write", { filePath: "d/x.ts" }, "/r", deps)).toBeUndefined();
    expect(gitMetadataWriteRefusal("write", { filePath: "d/../src/a.ts" }, "/r", deps)).toBeUndefined();
  });
});

/** A win32 share simulated (no links): `\\srv\share\proj` with `src` and `.git`; every filesystem call is recorded. */
function shareVolume() {
  const names = ["\\\\srv\\share\\proj", "\\\\srv\\share\\proj\\src", "\\\\srv\\share\\proj\\src\\a.ts", "\\\\srv\\share\\proj\\.git",
    "\\\\srv\\share\\proj\\.git\\hooks"];
  const byKey = new Map(names.map((name) => [name.toLowerCase(), name]));
  const calls: string[] = [];
  const realpath = (path: string): string => {
    calls.push(path);
    const found = byKey.get(win32.resolve(path).toLowerCase());
    if (found === undefined) throw enoent(path);
    return found;
  };
  return { calls, realpath, lstat: (path: string): unknown => realpath(path) };
}

describe("gitMetadataWriteRefusal: a project on a UNC share", () => {
  const BASE = "\\\\srv\\share\\proj";

  it("paths inside the session's own share directory resolve; .git there is refused; no call leaves that directory", () => {
    const volume = shareVolume();
    const deps = { platform: "win32" as const, realpath: volume.realpath, lstat: volume.lstat, gitDirectories: () => NO_GIT };
    for (const path of ["src/a.ts", "src\\new\\b.ts", `${BASE}\\src\\a.ts`, "//srv/share/proj/src/a.ts", "src/../src/a.ts"]) {
      for (const tool of WRITE_TOOLS) expect(gitMetadataWriteRefusal(tool, writeCall(tool, path, `${BASE}\\src\\a.ts`), BASE, deps), `${tool} ${path}`).toBeUndefined();
    }
    for (const path of [".git/config", `${BASE}\\.git\\hooks\\x`, "src/../.git/config"]) {
      expect(gitMetadataWriteRefusal("edit", { filePath: path }, BASE, deps), path).toMatch(REFUSED);
    }
    expect(volume.calls.length).toBeGreaterThan(0);
    for (const call of volume.calls) expect(win32.resolve(call).toLowerCase().startsWith(BASE.toLowerCase()), call).toBe(true);
  });

  it("any other UNC path, a device path, or a path climbing out of the share directory fails closed with no filesystem call", () => {
    const volume = shareVolume();
    const deps = { platform: "win32" as const, realpath: volume.realpath, lstat: volume.lstat, gitDirectories: () => NO_GIT };
    for (const path of ["\\\\other\\share\\x.ts", "\\\\srv\\share\\elsewhere\\x.ts", "..\\sibling\\x.ts", "\\\\?\\UNC\\srv\\share\\proj\\x.ts",
      "\\\\.\\pipe\\x", "\\\\?\\C:\\x.ts", "\\x.ts", "C:x.ts"]) {
      expect(gitMetadataWriteRefusal("write", { filePath: path }, BASE, deps), path).toMatch(UNRESOLVED);
    }
    expect(volume.calls).toEqual([]);
  });

  it("the role normalisation (no uncRoot) still refuses every UNC path", () => {
    const volume = shareVolume();
    expect(canonicalAuthorityPath("src/a.ts", BASE, { platform: "win32", realpath: volume.realpath, lstat: volume.lstat })).toBeUndefined();
    expect(canonicalAuthorityPath(`${BASE}\\src\\a.ts`, "C:\\r", { platform: "win32", realpath: volume.realpath, lstat: volume.lstat })).toBeUndefined();
    expect(volume.calls).toEqual([]);
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

  it("reads every patch text key (a superset of the lease targets, which read only the host's text)", () => {
    const args = { patchText: "*** Add File: a.ts", patch: "*** Add File: .git/hooks/x", input: "not a patch" };
    expect(writeTargetTexts("apply_patch", args)).toEqual(["a.ts", ".git/hooks/x"]);
    expect(toolTargets("apply_patch", args, resolve("/work")).paths).toEqual([resolve("/work", "a.ts")]);
    expect(gitMetadataWriteRefusal("apply_patch", args, fx.repo)).toMatch(REFUSED);
    // The host's own text decides readability: an unreadable first string fails closed whatever the other keys hold.
    expect(writeTargetTexts("apply_patch", { patchText: "", patch: "*** Add File: a.ts" })).toBeUndefined();
  });

  it("#161: another key's text with a header it cannot read fails closed; one with no header stays ignored", () => {
    for (const secondary of ["*** Add File: .git/hooks/x\n*** Update File:", "  *** Delete File:   \r\n", "*** Move to:"]) {
      const args = { patchText: "*** Add File: a.ts", input: secondary };
      expect(writeTargetTexts("apply_patch", args), JSON.stringify(secondary)).toBeUndefined();
      expect(gitMetadataWriteRefusal("apply_patch", args, fx.repo), JSON.stringify(secondary)).toBe(GIT_METADATA_PATCH_UNREADABLE);
      // The lease targets read the host's text only.
      expect(toolTargets("apply_patch", args, resolve("/work")).paths).toEqual([resolve("/work", "a.ts")]);
    }
    const ignored = { patchText: "*** Add File: a.ts", patch_text: "*** Begin Patch\n--- a/x\n+++ b/x\n*** End Patch", input: "" };
    expect(writeTargetTexts("apply_patch", ignored)).toEqual(["a.ts"]);
    expect(gitMetadataWriteRefusal("apply_patch", ignored, fx.repo)).toBeUndefined();
  });

  it("is undefined for an unreadable patch (toolTargets keeps its path arguments) and empty for other tools", () => {
    const args = { patchText: "--- a/x\n+++ b/x\n", filePath: "c.ts" };
    expect(writeTargetTexts("apply_patch", args)).toBeUndefined();
    expect(toolTargets("apply_patch", args, resolve("/work")).paths).toEqual([resolve("/work", "c.ts")]);
    expect(writeTargetTexts("read", { filePath: ".git/config" })).toEqual([]);
  });
});
