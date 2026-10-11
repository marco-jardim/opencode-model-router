import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLeaseRegistry,
  formatRunNote,
  keyOf,
  type Holder,
  type HolderInput,
  type LeaseOptions,
  type LeaseRegistry,
  type LeaseSeams,
  type LeaseSnapshot,
  type PathKey,
  type Unkeyable,
} from "../../src/router/leases";
import { removeDirWhenReleased } from "../helpers/remove-dir";

const win = process.platform === "win32";
const SIX_H = 6 * 60 * 60 * 1000;
const NUL = "\u0000";

function pick<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) throw new Error(`no item at ${index}`);
  return value;
}

function asKey(result: PathKey | Unkeyable): PathKey {
  if ("unkeyable" in result) throw new Error(`unexpectedly unkeyable: ${result.unkeyable}`);
  return result;
}

function asUnkeyable(result: PathKey | Unkeyable): string {
  if (!("unkeyable" in result)) throw new Error(`unexpectedly keyable: ${result.logical}`);
  return result.unkeyable;
}

// ---------------------------------------------------------------------------------------------------------------------
// A virtual filesystem and repository map (host independent: platform "linux" paths, fake realpath).
// ---------------------------------------------------------------------------------------------------------------------

type RepoTree = { repo: string; tree: string };

function fakeFs(dirs: readonly string[], links: Record<string, string> = {}) {
  const exist = new Set(dirs);
  const calls: string[] = [];
  return {
    calls,
    realpath(p: string): string {
      calls.push(p);
      const link = links[p];
      if (link !== undefined) return link;
      if (exist.has(p)) return p;
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
    },
  };
}

function repoMap(trees: readonly RepoTree[], fold: (text: string) => string = (text) => text) {
  return (dir: string): RepoTree | undefined => {
    const d = fold(dir.replace(/\\/g, "/"));
    let best: RepoTree | undefined;
    for (const entry of trees) {
      const tree = fold(entry.tree);
      if ((d === tree || d.startsWith(`${tree}/`)) && (best === undefined || tree.length > best.tree.length)) {
        best = { repo: entry.repo, tree };
      }
    }
    return best;
  };
}

const VIRTUAL_DIRS = ["/", "/w1", "/w1/src", "/w2", "/w2/src", "/s1", "/s1/src", "/out", "/out/src"];
const VIRTUAL_TREES: RepoTree[] = [
  { repo: "R", tree: "/w1" },
  { repo: "R", tree: "/w2" },
  { repo: "S", tree: "/s1" },
];

interface Rig {
  reg: LeaseRegistry;
  fs: ReturnType<typeof fakeFs>;
  clock: { now: number };
  seams: LeaseSeams;
}

function rig(opts: Partial<LeaseOptions> = {}, links: Record<string, string> = {}): Rig {
  const fs = fakeFs(VIRTUAL_DIRS, links);
  const clock = { now: 1_000 };
  const seams: LeaseSeams = { realpath: (p) => fs.realpath(p), repoKeyOf: repoMap(VIRTUAL_TREES), now: () => clock.now };
  const reg = createLeaseRegistry(seams, { runMode: "annotate", platform: "linux", ...opts });
  return { reg, fs, clock, seams };
}

const child = (holderID: string, tree: string, extra: Partial<HolderInput> = {}): HolderInput => ({
  holderID,
  tree,
  isChild: true,
  scope: "until-complete",
  ...extra,
});
const A = child("A", "/w1");
const B = child("B", "/w1");
const C = child("C", "/w2");
const ROOT: HolderInput = { holderID: "root", tree: "/w1", isChild: false, scope: "until-complete" };
const actor = (h: HolderInput) => ({ holderID: h.holderID, tree: h.tree, isChild: h.isChild });
const X = "/w1/src/x.ts";
const REL_X_KEY = `r:R${NUL}src/x.ts`;

/** A rig in which child A holds `/w1/src/x.ts`. */
function holdingX(opts: Partial<LeaseOptions> = {}): Rig {
  const r = rig(opts);
  expect(r.reg.acquireWrite(A, X)).toEqual({ ok: true, leased: [X], reentrant: [], unkeyed: [] });
  return r;
}

const holderA = { holderID: "A", tree: "/w1", isChild: true, scope: "until-complete", acquiredAt: 1_000 };

// ---------------------------------------------------------------------------------------------------------------------
// Normalization against the real filesystem.
// ---------------------------------------------------------------------------------------------------------------------

function shortNameOf(path: string): string {
  // execSync runs `cmd.exe /d /s /c "<command>"`, which keeps the quotes around the path (execFileSync would re-escape them).
  return execSync(`for %A in ("${path}") do @echo %~sA`, { encoding: "utf8", windowsHide: true }).trim();
}

describe("keyOf on the real filesystem", () => {
  let root = "";
  let repoDir = "";
  let srcDir = "";
  let file = "";
  let longDir = "";
  let link = "";
  let outsideDir = "";
  let seams: LeaseSeams;
  const fold = (text: string): string => {
    const slashed = text.replace(/\\/g, "/");
    return win ? slashed.toLowerCase() : slashed;
  };

  beforeAll(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "omr-leases-")));
    repoDir = join(root, "Repo");
    srcDir = join(repoDir, "Src");
    longDir = join(repoDir, "longdirectoryname");
    outsideDir = join(root, "outside");
    file = join(srcDir, "A.ts");
    mkdirSync(srcDir, { recursive: true });
    mkdirSync(longDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(file, "a");
    writeFileSync(join(longDir, "B.ts"), "b");
    writeFileSync(join(outsideDir, "o.ts"), "o");
    link = join(root, "linkToSrc");
    symlinkSync(srcDir, link, "junction");
    seams = {
      realpath: (p) => realpathSync.native(p),
      repoKeyOf: repoMap([{ repo: "R", tree: repoDir }], fold),
      now: () => 0,
    };
  }, 20_000);

  afterAll(async () => {
    await removeDirWhenReleased(root);
  }, 30_000);

  const expectedLogical = () => `r:R${NUL}${win ? "src/a.ts" : "Src/A.ts"}`;

  it("keys an existing file inside a repository by repository and relative path", () => {
    const key = asKey(keyOf(file, root, seams));
    expect(key.logical).toBe(expectedLogical());
    expect(key.repo).toBe("R");
    expect(key.tree).toBe(fold(repoDir));
    expect(key.rel).toBe(win ? "src/a.ts" : "Src/A.ts");
    expect(key.physical).toBe(fold(file));
    expect(key.display).toBe(file);
  });

  const spellings: [string, () => string][] = [
    ["forward slashes", () => file.replace(/\\/g, "/")],
    ["a relative `..` segment", () => `${srcDir}${win ? "\\" : "/"}x${win ? "\\" : "/"}..${win ? "\\" : "/"}A.ts`],
    ["a `.` segment", () => `${srcDir}${win ? "\\" : "/"}.${win ? "\\" : "/"}A.ts`],
    ["a junction to the directory", () => join(link, "A.ts")],
    ["a doubled separator", () => `${srcDir}${win ? "\\\\" : "//"}A.ts`],
  ];
  for (const [name, spell] of spellings) {
    it(`gives one key for ${name}`, () => {
      const key = asKey(keyOf(spell(), root, seams));
      expect(key.logical).toBe(expectedLogical());
      expect(key.physical).toBe(fold(file));
    });
  }

  const winSpellings: [string, () => string][] = [
    ["upper case", () => file.toUpperCase()],
    ["lower case", () => file.toLowerCase()],
    ["a trailing dot", () => `${file}.`],
    ["several trailing dots and spaces", () => `${file}. . `],
    ["a trailing space", () => `${file} `],
    ["an NTFS stream", () => `${file}:zone`],
    ["an NTFS stream with a type", () => `${file}:zone:$DATA`],
    ["a trailing dot on a directory", () => `${srcDir}.\\A.ts`],
    ["the extended-length prefix", () => `\\\\?\\${file}`],
    ["the extended-length prefix and forward slashes", () => `\\\\?\\${file.replace(/\\/g, "/")}`],
    ["a junction in upper case with a stream", () => `${join(link, "A.ts").toUpperCase()}:s`],
  ];
  for (const [name, spell] of winSpellings) {
    it.runIf(win)(`gives one key for ${name}`, () => {
      const key = asKey(keyOf(spell(), root, seams));
      expect(key.logical).toBe(expectedLogical());
      expect(key.physical).toBe(fold(file));
    });
  }

  it("resolves a relative path against the base", () => {
    expect(asKey(keyOf(join("Src", "A.ts"), repoDir, seams)).logical).toBe(expectedLogical());
    expect(asKey(keyOf(join("..", "Src", "A.ts"), join(repoDir, "other"), seams)).logical).toBe(expectedLogical());
  });

  it.runIf(win)("unwraps an extended-length base", () => {
    expect(asKey(keyOf("Src\\A.ts", `\\\\?\\${repoDir}`, seams)).logical).toBe(expectedLogical());
  });

  it.runIf(win)("gives one key for the 8.3 name of an existing directory", (ctx) => {
    const short = shortNameOf(longDir);
    if (short.toLowerCase() === longDir.toLowerCase()) ctx.skip();
    const viaShort = asKey(keyOf(join(short, "B.ts"), root, seams));
    const viaLong = asKey(keyOf(join(longDir, "b.ts"), root, seams));
    expect(viaShort.logical).toBe(viaLong.logical);
    expect(viaShort.physical).toBe(viaLong.physical);
    expect(viaShort.logical).toBe(`r:R${NUL}longdirectoryname/b.ts`);
  });

  it("keys a file that does not exist yet by its existing ancestor", () => {
    const fresh = asKey(keyOf(join(srcDir, "New", "Deep.ts"), root, seams));
    expect(fresh.logical).toBe(`r:R${NUL}${win ? "src/new/deep.ts" : "Src/New/Deep.ts"}`);
    const viaLink = asKey(keyOf(join(link, "New", "Deep.ts"), root, seams));
    expect(viaLink.logical).toBe(fresh.logical);
  });

  it("puts a file outside every repository in the x: key space without colliding with a repository file", () => {
    const outside = asKey(keyOf(join(outsideDir, "o.ts"), root, seams));
    expect(outside.logical).toBe(`x:${fold(join(outsideDir, "o.ts"))}`);
    expect(outside.tree).toBeNull();
    expect(outside.repo).toBeNull();
    expect(outside.rel).toBeNull();
    const inside = asKey(keyOf(file, root, seams));
    expect(outside.logical).not.toBe(inside.logical);
    // a nonexistent path whose ancestors exist only outside the repository
    expect(asKey(keyOf(join(root, "nope", "deep", "f.ts"), root, seams)).logical).toMatch(/^x:/);
  });

  it("collides two holders only on the identical physical file outside a repository", () => {
    const reg = createLeaseRegistry(seams, { runMode: "annotate" });
    const o = join(outsideDir, "o.ts");
    expect(reg.acquireWrite(child("A", root), o).ok).toBe(true);
    const held = reg.acquireWrite(child("B", root), o.replace(/\\/g, "/"));
    expect(held.ok).toBe(false);
    if (!held.ok && held.reason === "held") {
      expect(pick(held.holders, 0).holderID).toBe("A");
      expect(held.key.startsWith("x:")).toBe(true);
    } else throw new Error("expected held");
    // a repository file of the same base name does not collide with it
    expect(reg.acquireWrite(child("B", root), join(srcDir, "o.ts")).ok).toBe(true);
    // a read of the identical physical file outside the repository is refused, a sibling is not
    expect(reg.checkRead(child("C", root), o).ok).toBe(false);
    expect(reg.checkRead(child("C", root), join(outsideDir, "other.ts"))).toEqual({ ok: true });
  });

  it("enforces conflicts across spellings through the registry", () => {
    const reg = createLeaseRegistry(seams, { runMode: "annotate" });
    expect(reg.acquireWrite(child("A", repoDir), file).ok).toBe(true);
    const viaLink = reg.acquireWrite(child("B", repoDir), join(link, "A.ts"));
    expect(viaLink).toMatchObject({ ok: false, reason: "held" });
    expect(reg.checkRead(child("B", repoDir), join(link, "A.ts"))).toMatchObject({ ok: false, reason: "underEdit" });
    const run = reg.checkRun(child("B", repoDir), link);
    expect(run).toMatchObject({ ok: true, contaminatedBy: [{ holderID: "A" }], fileCount: 1 });
    expect(reg.checkRun(child("B", repoDir), outsideDir)).toEqual({ ok: true });
  });

  it("treats a thrown, malformed or non-containing repository answer as outside the repository", () => {
    const base = { realpath: seams.realpath, now: seams.now };
    const physical = fold(file);
    const thrown = keyOf(file, root, { ...base, repoKeyOf: () => { throw new Error("boom"); } });
    expect(asKey(thrown).logical).toBe(`x:${physical}`);
    const malformed = keyOf(file, root, { ...base, repoKeyOf: () => ({ repo: 1, tree: 2 }) as unknown as RepoTree });
    expect(asKey(malformed).logical).toBe(`x:${physical}`);
    const elsewhere = keyOf(file, root, { ...base, repoKeyOf: () => ({ repo: "R", tree: "/elsewhere" }) });
    expect(asKey(elsewhere).logical).toBe(`x:${physical}`);
    const prefixOnly = keyOf(file, root, { ...base, repoKeyOf: () => ({ repo: "R", tree: `${fold(srcDir)}/A` }) });
    expect(asKey(prefixOnly).logical).toBe(`x:${physical}`);
  });

  it("gives the tree itself the empty relative path", () => {
    const base = { realpath: seams.realpath, now: seams.now };
    const same = keyOf(file, root, { ...base, repoKeyOf: () => ({ repo: "R", tree: fold(file) }) });
    expect(asKey(same)).toMatchObject({ rel: "", logical: `r:R${NUL}`, tree: fold(file) });
    const slashed = keyOf(file, root, { ...base, repoKeyOf: () => ({ repo: "R", tree: `${fold(file)}/` }) });
    expect(asKey(slashed)).toMatchObject({ rel: "" });
  });

  describe("unkeyable inputs", () => {
    for (const [name, value] of [
      ["undefined", undefined],
      ["null", null],
      ["a number", 5],
      ["an object", {}],
      ["an array", ["a"]],
    ] as [string, unknown][]) {
      it(`rejects ${name}`, () => {
        expect(keyOf(value, root, seams)).toEqual({ unkeyable: "not a string" });
      });
    }

    it("rejects an empty or blank path and a NUL", () => {
      expect(keyOf("", root, seams)).toEqual({ unkeyable: "empty path" });
      expect(keyOf("  \t", root, seams)).toEqual({ unkeyable: "empty path" });
      expect(keyOf(`${file}${NUL}x`, root, seams)).toEqual({ unkeyable: "NUL in path" });
    });

    it("rejects a relative path without an absolute base", () => {
      expect(keyOf("a.ts", "relative/base", seams)).toEqual({ unkeyable: "relative path without an absolute base" });
      expect(keyOf("a.ts", 5 as unknown as string, seams)).toEqual({ unkeyable: "relative path without an absolute base" });
      expect(asKey(keyOf(file, "relative/base", seams)).logical).toBe(expectedLogical());
    });

    it.runIf(win)("rejects drive-relative and device forms", () => {
      expect(keyOf("C:foo.ts", root, seams)).toEqual({ unkeyable: "drive-relative path" });
      expect(keyOf("\\\\.\\C:\\x.ts", root, seams)).toEqual({ unkeyable: "device path" });
      expect(keyOf("\\\\.\\pipe\\x", root, seams)).toEqual({ unkeyable: "device path" });
      expect(keyOf("\\\\?\\Volume{1234}\\x.ts", root, seams)).toEqual({ unkeyable: "device path" });
      expect(keyOf("\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\x", root, seams)).toEqual({ unkeyable: "device path" });
      expect(keyOf("x.ts", "\\\\.\\C:\\", seams)).toEqual({ unkeyable: "device path" });
    });

    it.runIf(win)("rejects a path segment that is empty once stream and trailing dots are stripped", () => {
      expect(keyOf(`${srcDir}\\...\\a.ts`, root, seams)).toEqual({ unkeyable: "empty path segment" });
      expect(keyOf(`${srcDir}\\:stream`, root, seams)).toEqual({ unkeyable: "empty path segment" });
    });

    it.runIf(win)("rejects an 8.3-looking name in the part that does not exist, but keeps look-alikes", () => {
      const reason = "8.3 short name in a missing path";
      expect(keyOf(join(srcDir, "PROGRA~1", "x.ts"), root, seams)).toEqual({ unkeyable: reason });
      expect(keyOf(join(srcDir, "MARQUI~1.TXT"), root, seams)).toEqual({ unkeyable: reason });
      expect(keyOf(join(srcDir, "progra~12.js"), root, seams)).toEqual({ unkeyable: reason });
      expect(asKey(keyOf(join(srcDir, "toolong~1.ts"), root, seams)).logical).toMatch(/^r:R/);
      expect(asKey(keyOf(join(srcDir, "a~b.ts"), root, seams)).logical).toMatch(/^r:R/);
      expect(asKey(keyOf(join(srcDir, "x~1.json"), root, seams)).logical).toMatch(/^r:R/);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Normalization with a virtual filesystem (both platform rule sets, any host).
// ---------------------------------------------------------------------------------------------------------------------

describe("keyOf with virtual path rules", () => {
  const mk = (dirs: readonly string[], links: Record<string, string> = {}): LeaseSeams => {
    const fs = fakeFs(dirs, links);
    return { realpath: (p) => fs.realpath(p), repoKeyOf: () => undefined, now: () => 0 };
  };

  it("keeps case and treats backslash as an ordinary name character on posix rules", () => {
    const seams = mk(["/", "/w1"]);
    const upper = asKey(keyOf("/W1/A.ts", "/", seams, "linux"));
    const lower = asKey(keyOf("/w1/a.ts", "/", seams, "linux"));
    expect(upper.physical).not.toBe(lower.physical);
    expect(lower.physical).toBe("/w1/a.ts");
    expect(asKey(keyOf("a.ts", "/w1", seams, "linux")).display).toBe("/w1/a.ts");
    expect(asKey(keyOf("/w1/./x/../a.ts/", "/", seams, "linux")).physical).toBe("/w1/a.ts");
  });

  it("does not interpret win32 forms on posix rules", () => {
    const seams = mk(["/"]);
    expect(keyOf("C:foo", "/w1", seams, "linux")).not.toHaveProperty("unkeyable", "drive-relative path");
    expect(keyOf("a:b", "/w1", seams, "linux")).not.toHaveProperty("unkeyable");
  });

  it("folds case and separators on win32 rules, and expands links of existing segments", () => {
    const seams = mk(["C:\\", "C:\\Repo", "C:\\Repo\\Src"], { "C:\\Link": "C:\\Repo\\Src" });
    const direct = asKey(keyOf("C:\\Repo\\Src\\A.ts", "C:\\", seams, "win32"));
    for (const raw of [
      "c:/repo/src/a.ts",
      "C:\\REPO\\SRC\\x\\..\\A.TS.",
      "C:\\Repo\\Src\\A.ts ",
      "C:\\Repo\\Src\\A.ts:zone",
      "\\\\?\\C:\\Repo\\Src\\A.ts",
      "C:\\Link\\A.ts",
      "//?/C:/Repo/Src/A.ts",
    ]) {
      expect(asKey(keyOf(raw, "C:\\", seams, "win32")).physical, raw).toBe(direct.physical);
    }
    expect(direct.physical).toBe("c:/repo/src/a.ts");
    expect(direct.logical).toBe("x:c:/repo/src/a.ts");
  });

  it("unwraps an extended UNC path and keeps a UNC root", () => {
    const seams = mk([]);
    expect(asKey(keyOf("\\\\?\\UNC\\Host\\Share\\Dir\\F.ts", "C:\\", seams, "win32")).physical).toBe("//host/share/dir/f.ts");
    expect(asKey(keyOf("\\\\Host\\Share\\Dir\\F.ts", "C:\\", seams, "win32")).physical).toBe("//host/share/dir/f.ts");
  });

  it("rejects win32 unkeyable forms on any host", () => {
    const seams = mk(["C:\\"]);
    expect(keyOf("C:foo", "C:\\", seams, "win32")).toEqual({ unkeyable: "drive-relative path" });
    expect(keyOf("\\\\.\\C:\\x", "C:\\", seams, "win32")).toEqual({ unkeyable: "device path" });
    expect(keyOf("C:\\Missing\\PROGRA~1\\x", "C:\\", seams, "win32")).toEqual({ unkeyable: "8.3 short name in a missing path" });
    expect(keyOf("C:\\a\\...\\x", "C:\\", seams, "win32")).toEqual({ unkeyable: "empty path segment" });
    expect(keyOf("rel", "rel", seams, "win32")).toEqual({ unkeyable: "relative path without an absolute base" });
  });

  it("strips a trailing slash a link target carries, but keeps a root", () => {
    const posix = mk(["/", "/w1"], { "/lnk": "/w1/" });
    expect(asKey(keyOf("/lnk", "/", posix, "linux")).physical).toBe("/w1");
    expect(asKey(keyOf("/", "/", posix, "linux")).physical).toBe("/");
    const winSeams = mk(["C:\\"], { "C:\\drive": "C:\\", "C:\\share": "\\\\host\\share\\" });
    expect(asKey(keyOf("C:\\drive", "C:\\", winSeams, "win32")).physical).toBe("c:/");
    expect(asKey(keyOf("C:\\share", "C:\\", winSeams, "win32")).physical).toBe("//host/share/");
  });

  it("rejects a real path that turns into a device form", () => {
    const seams = mk(["C:\\"], { "C:\\odd": "\\\\.\\Device\\X" });
    expect(keyOf("C:\\odd", "C:\\", seams, "win32")).toEqual({ unkeyable: "device path" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The conflict matrix.
// ---------------------------------------------------------------------------------------------------------------------

describe("conflict matrix (child A holds /w1/src/x.ts)", () => {
  describe("write", () => {
    it("refuses a second child writer, naming the holder", () => {
      const { reg } = holdingX();
      expect(reg.acquireWrite(B, X)).toEqual({
        ok: false,
        reason: "held",
        holders: [holderA],
        path: X,
        key: REL_X_KEY,
      });
    });

    it("refuses the same relative path in another worktree of the repository", () => {
      const { reg } = holdingX();
      const result = reg.acquireWrite(C, "/w2/src/x.ts");
      expect(result).toMatchObject({ ok: false, reason: "held", path: "/w2/src/x.ts", key: REL_X_KEY });
      if (result.ok || result.reason !== "held") throw new Error("expected held");
      expect(pick(result.holders, 0).holderID).toBe("A");
    });

    it("allows another file in the same tree", () => {
      const { reg } = holdingX();
      expect(reg.acquireWrite(B, "/w1/src/y.ts")).toEqual({ ok: true, leased: ["/w1/src/y.ts"], reentrant: [], unkeyed: [] });
    });

    it("allows the same relative path in another repository", () => {
      const { reg } = holdingX();
      expect(reg.acquireWrite(child("S1", "/s1"), "/s1/src/x.ts").ok).toBe(true);
    });

    it("refuses a root writer while a child holds the file, in any tree of the repository", () => {
      const { reg } = holdingX();
      const sameTree = reg.acquireWrite(ROOT, X);
      expect(sameTree).toMatchObject({ ok: false, reason: "held", key: REL_X_KEY });
      if (sameTree.ok || sameTree.reason !== "held") throw new Error("expected held");
      expect(sameTree.holders).toEqual([holderA]);
      const otherTree = reg.acquireWrite({ ...ROOT, tree: "/w2" }, "/w2/src/x.ts");
      expect(otherTree).toMatchObject({ ok: false, reason: "held", path: "/w2/src/x.ts" });
    });

    it("lets a root write another file and records nothing for it", () => {
      const { reg } = holdingX();
      const before = reg.snapshot();
      expect(reg.acquireWrite(ROOT, "/w1/src/y.ts")).toEqual({ ok: true, leased: [], reentrant: [], unkeyed: [] });
      expect(reg.snapshot()).toEqual(before);
    });

    it("lets a root write with an unknown target and an unkeyable path, listing the latter", () => {
      const { reg } = holdingX();
      expect(reg.acquireWrite(ROOT, null)).toEqual({ ok: true, leased: [], reentrant: [], unkeyed: [] });
      expect(reg.acquireWrite(ROOT, ["", "/w1/src/y.ts"])).toEqual({ ok: true, leased: [], reentrant: [], unkeyed: [""] });
    });

    it("refuses a root array write when any file is held", () => {
      const { reg } = holdingX();
      expect(reg.acquireWrite(ROOT, ["/w1/src/y.ts", X])).toMatchObject({ ok: false, reason: "held", path: X });
    });
  });

  describe("write with an unknown target", () => {
    it("is refused while another holder leases a file in the tree", () => {
      const { reg } = holdingX();
      expect(reg.acquireWrite(B, null)).toEqual({ ok: false, reason: "unknown-target", holders: [holderA] });
      expect(reg.acquireWrite(B, [])).toEqual({ ok: false, reason: "unknown-target", holders: [holderA] });
    });

    it("is refused for an unkeyable path, and for a mix where the keyable part is free", () => {
      const { reg } = holdingX();
      expect(reg.acquireWrite(B, "")).toMatchObject({ ok: false, reason: "unknown-target" });
      expect(reg.acquireWrite(B, ["/w1/src/y.ts", `a${NUL}b`])).toMatchObject({ ok: false, reason: "unknown-target" });
      expect(reg.acquireWrite(B, "/w1/src/y.ts")).toMatchObject({ ok: true });
    });

    it("is allowed in another tree, and lists the unkeyed paths", () => {
      const { reg } = holdingX();
      expect(reg.acquireWrite(C, null)).toEqual({ ok: true, leased: [], reentrant: [], unkeyed: [] });
      expect(reg.acquireWrite(C, ["", "/w2/src/z.ts"])).toEqual({
        ok: true,
        leased: ["/w2/src/z.ts"],
        reentrant: [],
        unkeyed: [""],
      });
    });

    it("is allowed when no other holder leases anything in the tree, and ignores the holder's own leases", () => {
      const { reg } = rig();
      expect(reg.acquireWrite(A, null)).toMatchObject({ ok: true });
      expect(reg.acquireWrite(A, X)).toMatchObject({ ok: true });
      expect(reg.acquireWrite(A, null)).toMatchObject({ ok: true });
    });

    it("is allowed for a holder whose tree is outside every repository", () => {
      const { reg } = holdingX();
      expect(reg.acquireWrite(child("O", "/out"), null)).toMatchObject({ ok: true });
      expect(reg.acquireWrite(child("O", "/out"), [5] as unknown as string[])).toMatchObject({ ok: true, unkeyed: ["5"] });
    });

    it("records non-string array entries as unkeyed", () => {
      const { reg } = rig();
      expect(reg.acquireWrite(A, [7, "/w1/src/y.ts"] as unknown as string[])).toEqual({
        ok: true,
        leased: ["/w1/src/y.ts"],
        reentrant: [],
        unkeyed: ["7"],
      });
    });
  });

  describe("read", () => {
    it("refuses a child reader of the held file", () => {
      const { reg } = holdingX();
      expect(reg.checkRead(actor(B), X)).toEqual({ ok: false, reason: "underEdit", holders: [holderA], path: X });
    });

    it("resolves a relative path against the reader's tree", () => {
      const { reg } = holdingX();
      expect(reg.checkRead(actor(B), "src/x.ts")).toMatchObject({ ok: false, reason: "underEdit", path: X });
    });

    it("allows the same relative path in another worktree (a different physical file)", () => {
      const { reg } = holdingX();
      expect(reg.checkRead(actor(C), "/w2/src/x.ts")).toEqual({ ok: true });
      expect(reg.checkRead(actor(C), "src/x.ts")).toEqual({ ok: true });
    });

    it("allows another file, the holder itself, unkeyable paths and root readers", () => {
      const { reg } = holdingX();
      expect(reg.checkRead(actor(B), "/w1/src/y.ts")).toEqual({ ok: true });
      expect(reg.checkRead(actor(A), X)).toEqual({ ok: true });
      expect(reg.checkRead(actor(B), "")).toEqual({ ok: true });
      expect(reg.checkRead(actor(ROOT), X)).toEqual({ ok: true });
      expect(reg.checkRead(actor({ ...ROOT, tree: "/w2" }), "/w2/src/x.ts")).toEqual({ ok: true });
    });

    it("refuses only the identical physical file when the lease sits outside any repository", () => {
      const { reg } = rig();
      reg.acquireWrite(A, "/out/src/f.ts");
      expect(reg.checkRead(actor(B), "/out/src/f.ts")).toMatchObject({ ok: false, reason: "underEdit" });
      expect(reg.checkRead(actor(B), "/out/src/g.ts")).toEqual({ ok: true });
    });

    it("refuses the physical file reached through a link", () => {
      const { reg } = rig({}, { "/lnk": "/w1/src" });
      reg.acquireWrite(A, X);
      expect(reg.checkRead(actor(B), "/lnk/x.ts")).toMatchObject({ ok: false, reason: "underEdit" });
    });
  });

  describe("search", () => {
    it("omits the held file, keeps the rest in order and counts what it left out", () => {
      const { reg } = holdingX();
      const paths = ["/w1/src/b.ts", X, "src/c.ts", "src/x.ts", "/w2/src/x.ts", ""];
      const result = reg.filterSearchResults(actor(B), "/w1", paths);
      expect(result).toEqual({
        kept: ["/w1/src/b.ts", "src/c.ts", "/w2/src/x.ts", ""],
        omitted: 2,
        holders: [holderA],
      });
      expect(paths).toHaveLength(6);
    });

    it("keeps the same relative path when the search runs in another worktree", () => {
      const { reg } = holdingX();
      expect(reg.filterSearchResults(actor(C), "/w2", ["src/x.ts", "src/y.ts"])).toEqual({
        kept: ["src/x.ts", "src/y.ts"],
        omitted: 0,
        holders: [],
      });
    });

    it("lists each holder of omitted entries once, in first-seen order", () => {
      const { reg } = holdingX();
      reg.acquireWrite(B, "/w1/src/y.ts");
      const result = reg.filterSearchResults(actor(C), "/w1", ["src/y.ts", "src/x.ts", "src/y.ts", "src/z.ts"]);
      expect(result.kept).toEqual(["src/z.ts"]);
      expect(result.omitted).toBe(3);
      expect(result.holders.map((holder) => holder.holderID)).toEqual(["B", "A"]);
    });

    it("never filters for a root reader", () => {
      const { reg } = holdingX();
      expect(reg.filterSearchResults(actor(ROOT), "/w1", [X, "src/y.ts"])).toEqual({
        kept: [X, "src/y.ts"],
        omitted: 0,
        holders: [],
      });
    });

    it("takes a fast path without touching the filesystem when nothing foreign is leased", () => {
      const { reg, fs } = rig();
      const paths = ["src/a.ts", "src/b.ts"];
      const none = reg.filterSearchResults(actor(B), "/w1", paths);
      expect(none).toEqual({ kept: paths, omitted: 0, holders: [] });
      expect(none.kept).not.toBe(paths);
      reg.acquireWrite(B, "/w1/src/own.ts");
      fs.calls.length = 0;
      expect(reg.filterSearchResults(actor(B), "/w1", [...paths, "src/own.ts"])).toMatchObject({ omitted: 0 });
      expect(fs.calls).toEqual([]);
    });

    it("does not take the fast path once another holder leases a file", () => {
      const { reg, fs } = rig();
      reg.acquireWrite(B, "/w1/src/own.ts");
      reg.acquireWrite(A, X);
      fs.calls.length = 0;
      reg.filterSearchResults(actor(B), "/w1", ["src/a.ts"]);
      expect(fs.calls.length).toBeGreaterThan(0);
    });

    it("canonicalises each directory once per call", () => {
      const { reg, fs } = holdingX();
      const paths = Array.from({ length: 40 }, (_, index) => `src/file${index}.ts`);
      fs.calls.length = 0;
      expect(reg.filterSearchResults(actor(B), "/w1", [...paths, ...paths])).toMatchObject({ omitted: 0 });
      const seen = new Set(fs.calls);
      expect(fs.calls.length).toBe(seen.size);
    });

    it("applies the same rule as checkRead to outside-repository leases", () => {
      const { reg } = rig();
      reg.acquireWrite(A, "/out/src/f.ts");
      const result = reg.filterSearchResults(actor(B), "/out", ["src/f.ts", "src/g.ts"]);
      expect(result.kept).toEqual(["src/g.ts"]);
      expect(result.omitted).toBe(1);
    });
  });

  describe("router_run", () => {
    it("annotates a child run in the tree under edit", () => {
      const { reg } = holdingX({ runMode: "annotate" });
      expect(reg.checkRun(actor(B), "/w1")).toEqual({ ok: true, contaminatedBy: [holderA], fileCount: 1 });
    });

    it("refuses a child run in the tree under edit when the mode is refuse", () => {
      const { reg } = holdingX({ runMode: "refuse" });
      expect(reg.checkRun(actor(B), "/w1")).toEqual({ ok: false, reason: "run-refused", holders: [holderA], fileCount: 1 });
    });

    it("annotates a root run even under refuse", () => {
      const { reg } = holdingX({ runMode: "refuse" });
      expect(reg.checkRun(actor(ROOT), "/w1")).toEqual({ ok: true, contaminatedBy: [holderA], fileCount: 1 });
    });

    it("allows a run in another tree, outside any repository, or by the only holder", () => {
      for (const runMode of ["annotate", "refuse"] as const) {
        const { reg } = holdingX({ runMode });
        expect(reg.checkRun(actor(C), "/w2")).toEqual({ ok: true });
        expect(reg.checkRun(actor(B), "/out")).toEqual({ ok: true });
        expect(reg.checkRun(actor(A), "/w1")).toEqual({ ok: true });
        expect(reg.checkRun(actor(B), "")).toEqual({ ok: true });
        expect(reg.checkRun(actor(B), "/s1")).toEqual({ ok: true });
      }
    });

    it("resolves the run directory against the runner's tree and accepts a subdirectory", () => {
      const { reg } = holdingX();
      expect(reg.checkRun(actor(B), "src")).toMatchObject({ ok: true, contaminatedBy: [{ holderID: "A" }] });
      expect(reg.checkRun(actor(B), "/w1/src")).toMatchObject({ ok: true, contaminatedBy: [{ holderID: "A" }] });
    });

    it("counts the files of every other holder in the tree", () => {
      const { reg } = holdingX({ runMode: "refuse" });
      reg.acquireWrite(A, "/w1/src/x2.ts");
      reg.acquireWrite(B, "/w1/src/y.ts");
      const result = reg.checkRun(actor(C), "/w1");
      expect(result).toMatchObject({ ok: false, reason: "run-refused", fileCount: 3 });
      if (result.ok) throw new Error("expected refusal");
      expect(result.holders.map((holder) => holder.holderID)).toEqual(["A", "B"]);
    });
  });

  describe("root edits first", () => {
    it("lets a child read, search and run afterwards", () => {
      const { reg } = rig({ runMode: "refuse" });
      expect(reg.acquireWrite(ROOT, X)).toEqual({ ok: true, leased: [], reentrant: [], unkeyed: [] });
      expect(reg.checkRead(actor(B), X)).toEqual({ ok: true });
      expect(reg.checkRun(actor(B), "/w1")).toEqual({ ok: true });
      expect(reg.filterSearchResults(actor(B), "/w1", [X])).toEqual({ kept: [X], omitted: 0, holders: [] });
      expect(reg.acquireWrite(B, X)).toMatchObject({ ok: true, leased: [X] });
    });
  });

  describe("re-entrancy and arrays", () => {
    it("re-acquiring keeps the stamp and does not count against the cap", () => {
      const { reg, clock } = rig({ cap: 2 });
      expect(reg.acquireWrite(A, [X, "/w1/src/y.ts"])).toMatchObject({ ok: true, leased: [X, "/w1/src/y.ts"] });
      clock.now = 5_000;
      expect(reg.acquireWrite(A, [X, "/w1/src/y.ts"])).toEqual({
        ok: true,
        leased: [],
        reentrant: [X, "/w1/src/y.ts"],
        unkeyed: [],
      });
      expect(pick(reg.snapshot().holders, 0).acquiredAt).toBe(1_000);
      expect(reg.snapshot().leases).toHaveLength(2);
    });

    it("keeps the first stamp when the holder takes another file later", () => {
      const { reg, clock } = rig();
      reg.acquireWrite(A, X);
      clock.now = 9_000;
      reg.acquireWrite(A, "/w1/src/y.ts");
      expect(pick(reg.snapshot().holders, 0).acquiredAt).toBe(1_000);
    });

    it("is all-or-nothing for an array that hits a held file", () => {
      const { reg } = holdingX();
      const before = reg.snapshot();
      expect(reg.acquireWrite(B, ["/w1/src/y.ts", "/w1/src/z.ts", X])).toMatchObject({ ok: false, reason: "held", path: X });
      expect(reg.snapshot()).toEqual(before);
      expect(reg.acquireWrite(C, "/w2/src/y.ts")).toMatchObject({ ok: true });
    });

    it("leases a file given in two spellings once", () => {
      const { reg } = rig();
      expect(reg.acquireWrite(A, [X, "/w1/src/../src/x.ts", "/w1/src/./x.ts"])).toEqual({
        ok: true,
        leased: [X],
        reentrant: [],
        unkeyed: [],
      });
    });

    it("mixes new and re-entrant files in one call", () => {
      const { reg } = holdingX();
      expect(reg.acquireWrite(A, [X, "/w1/src/y.ts"])).toEqual({
        ok: true,
        leased: ["/w1/src/y.ts"],
        reentrant: [X],
        unkeyed: [],
      });
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Holder validation.
// ---------------------------------------------------------------------------------------------------------------------

describe("holder validation", () => {
  const invalid = (value: unknown): string => {
    const { reg } = rig();
    const result = reg.acquireWrite(value as HolderInput, X);
    if (result.ok || result.reason !== "invalid-holder") throw new Error(`expected invalid-holder, got ${JSON.stringify(result)}`);
    expect(reg.snapshot().leases).toEqual([]);
    return result.message;
  };

  it("rejects a holder that is not an object", () => {
    for (const value of [null, undefined, "A", 5, ["A"]]) expect(invalid(value)).toBe("holder must be an object");
  });

  it("rejects a bad holderID, tree, isChild or scope", () => {
    expect(invalid({ ...A, holderID: "" })).toBe("holderID must be a non-empty string");
    expect(invalid({ ...A, holderID: "   " })).toBe("holderID must be a non-empty string");
    expect(invalid({ ...A, holderID: 5 })).toBe("holderID must be a non-empty string");
    expect(invalid({ ...A, tree: "" })).toBe("tree must be a non-empty string");
    expect(invalid({ ...A, tree: undefined })).toBe("tree must be a non-empty string");
    expect(invalid({ ...A, isChild: "yes" })).toBe("isChild must be a boolean");
    expect(invalid({ ...A, isChild: undefined })).toBe("isChild must be a boolean");
    expect(invalid({ ...A, scope: "forever" })).toBe("scope must be until-complete or until-integrated");
    expect(invalid({ ...A, scope: undefined })).toBe("scope must be until-complete or until-integrated");
  });

  it("rejects a bad taskRef and an until-integrated lease without one", () => {
    expect(invalid({ ...A, taskRef: "" })).toBe("taskRef must be a non-empty string");
    expect(invalid({ ...A, taskRef: "  " })).toBe("taskRef must be a non-empty string");
    expect(invalid({ ...A, taskRef: 3 })).toBe("taskRef must be a non-empty string");
    expect(invalid({ ...A, scope: "until-integrated" })).toBe("an until-integrated lease requires a taskRef");
    expect(invalid({ ...A, scope: "until-integrated", taskRef: "" })).toBe("taskRef must be a non-empty string");
  });

  it("rejects a later call that changes tree, scope, taskRef or isChild; the first record wins", () => {
    const { reg } = rig();
    const first = child("P", "/w1", { scope: "until-integrated", taskRef: "T1" });
    expect(reg.acquireWrite(first, X).ok).toBe(true);
    const variants: HolderInput[] = [
      { ...first, tree: "/w2" },
      { ...first, scope: "until-complete" },
      { ...first, taskRef: "T2" },
      { ...first, isChild: false },
    ];
    for (const variant of variants) {
      const result = reg.acquireWrite(variant, "/w1/src/y.ts");
      expect(result).toMatchObject({ ok: false, reason: "invalid-holder", message: expect.stringMatching(/already recorded/) });
    }
    const noTask = child("P", "/w1", { scope: "until-integrated" });
    expect(reg.acquireWrite(noTask, "/w1/src/y.ts")).toMatchObject({ ok: false, reason: "invalid-holder" });
    expect(reg.acquireWrite(first, "/w1/src/y.ts")).toMatchObject({ ok: true });
    expect(reg.snapshot().leases).toHaveLength(2);
  });

  it("validates registry options", () => {
    const seams = rig().seams;
    const make = (opts: unknown) => () => createLeaseRegistry(seams, opts as LeaseOptions);
    expect(make({ runMode: "other" })).toThrow(TypeError);
    expect(make({})).toThrow(TypeError);
    expect(make(null)).toThrow(TypeError);
    expect(make({ runMode: "annotate", cap: 0 })).toThrow(TypeError);
    expect(make({ runMode: "annotate", cap: -1 })).toThrow(TypeError);
    expect(make({ runMode: "annotate", cap: 1.5 })).toThrow(TypeError);
    expect(make({ runMode: "annotate", cap: "3" })).toThrow(TypeError);
    expect(make({ runMode: "annotate", cap: Number.MAX_SAFE_INTEGER + 2 })).toThrow(TypeError);
    expect(make({ runMode: "refuse", cap: 1 })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Scopes, sweep, cap.
// ---------------------------------------------------------------------------------------------------------------------

describe("scopes", () => {
  const I = child("I", "/w1", { scope: "until-integrated", taskRef: "T1" });

  it("release ends until-complete leases, idempotently, and frees the file", () => {
    const { reg } = holdingX({ runMode: "refuse" });
    reg.acquireWrite(A, "/w1/src/y.ts");
    expect(reg.release("A")).toEqual({ released: 2, retained: 0 });
    expect(reg.release("A")).toEqual({ released: 0, retained: 0 });
    expect(reg.release("nobody")).toEqual({ released: 0, retained: 0 });
    expect(reg.acquireWrite(B, X)).toMatchObject({ ok: true });
    expect(reg.checkRun(actor(C), "/w1")).toMatchObject({ ok: false, reason: "run-refused", fileCount: 1 });
    expect(reg.release("B")).toEqual({ released: 1, retained: 0 });
    expect(reg.checkRun(actor(C), "/w1")).toEqual({ ok: true });
    expect(reg.snapshot()).toMatchObject({ holders: [], leases: [] });
  });

  it("release keeps until-integrated leases; releaseTask ends them", () => {
    const { reg } = rig();
    reg.acquireWrite(I, [X, "/w1/src/y.ts"]);
    expect(reg.release("I")).toEqual({ released: 0, retained: 2 });
    expect(reg.acquireWrite(B, X)).toMatchObject({ ok: false, reason: "held" });
    expect(reg.releaseTask("T1")).toEqual({ released: 2, holders: ["I"] });
    expect(reg.acquireWrite(B, X)).toMatchObject({ ok: true });
    expect(reg.releaseTask("T1")).toEqual({ released: 0, holders: [] });
    expect(reg.releaseTask("never")).toEqual({ released: 0, holders: [] });
  });

  it("releaseTask ends every holder of the task, whatever their scope, and leaves other tasks alone", () => {
    const { reg } = rig();
    reg.acquireWrite(child("P1", "/w1", { taskRef: "T" }), X);
    reg.acquireWrite(child("P2", "/w1", { scope: "until-integrated", taskRef: "T" }), "/w1/src/y.ts");
    reg.acquireWrite(child("Q", "/w1", { scope: "until-integrated", taskRef: "U" }), "/w1/src/z.ts");
    expect(reg.releaseTask("T")).toEqual({ released: 2, holders: ["P1", "P2"] });
    expect(reg.snapshot().leases.map((lease) => lease.holderID)).toEqual(["Q"]);
  });

  it("forgets the task of a holder that was released", () => {
    const { reg } = rig();
    reg.acquireWrite(child("P1", "/w1", { taskRef: "T" }), X);
    reg.acquireWrite(child("P2", "/w1", { taskRef: "T" }), "/w1/src/y.ts");
    reg.release("P1");
    expect(reg.releaseTask("T")).toEqual({ released: 1, holders: ["P2"] });
    reg.acquireWrite(child("P3", "/w1", { taskRef: "T" }), X);
    reg.release("P3");
    expect(reg.releaseTask("T")).toEqual({ released: 0, holders: [] });
  });

  it("keeps the tree counters right when a holder holds files in several trees", () => {
    const { reg } = rig({ runMode: "refuse" });
    reg.acquireWrite(A, [X, "/w1/src/y.ts", "/s1/src/z.ts"]);
    expect(reg.checkRun(actor(C), "/w1")).toMatchObject({ ok: false, fileCount: 2 });
    expect(reg.checkRun(actor(C), "/s1")).toMatchObject({ ok: false, fileCount: 1 });
    reg.release("A");
    expect(reg.checkRun(actor(C), "/w1")).toEqual({ ok: true });
    expect(reg.checkRun(actor(C), "/s1")).toEqual({ ok: true });
  });

  it("does not count a holder's leases outside any repository in a tree", () => {
    const { reg } = rig({ runMode: "refuse" });
    reg.acquireWrite(A, "/out/src/f.ts");
    expect(reg.checkRun(actor(B), "/out")).toEqual({ ok: true });
    expect(reg.release("A")).toEqual({ released: 1, retained: 0 });
  });
});

describe("sweep", () => {
  it("keeps a holder 6 h - 1 ms old and releases one 6 h old", () => {
    const { reg, clock } = holdingX();
    clock.now = 1_000 + SIX_H - 1;
    expect(reg.sweep()).toEqual({ released: 0, holders: [] });
    expect(reg.acquireWrite(B, X)).toMatchObject({ ok: false, reason: "held" });
    clock.now = 1_000 + SIX_H;
    expect(reg.sweep()).toEqual({ released: 1, holders: ["A"] });
    expect(reg.acquireWrite(B, X)).toMatchObject({ ok: true });
    expect(reg.sweep()).toEqual({ released: 0, holders: [] });
  });

  it("never sweeps a future stamp or an until-integrated holder", () => {
    const { reg, clock } = rig();
    clock.now = 50_000;
    reg.acquireWrite(A, X);
    reg.acquireWrite(child("I", "/w1", { scope: "until-integrated", taskRef: "T" }), "/w1/src/y.ts");
    clock.now = 1_000;
    expect(reg.sweep()).toEqual({ released: 0, holders: [] });
    clock.now = 50_000 + 10 * SIX_H;
    expect(reg.sweep()).toEqual({ released: 1, holders: ["A"] });
    expect(reg.snapshot().leases.map((lease) => lease.holderID)).toEqual(["I"]);
  });

  it("honours a custom age, allows zero, and falls back to 6 h for an invalid one", () => {
    const custom = rig({ sweepAgeMs: 100 });
    custom.reg.acquireWrite(A, X);
    custom.clock.now = 1_099;
    expect(custom.reg.sweep().released).toBe(0);
    custom.clock.now = 1_100;
    expect(custom.reg.sweep().released).toBe(1);

    const zero = rig({ sweepAgeMs: 0 });
    zero.reg.acquireWrite(A, X);
    expect(zero.reg.sweep()).toEqual({ released: 1, holders: ["A"] });

    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "5" as unknown as number]) {
      const r = rig({ sweepAgeMs: bad });
      r.reg.acquireWrite(A, X);
      r.clock.now = 1_000 + SIX_H - 1;
      expect(r.reg.sweep().released).toBe(0);
      r.clock.now = 1_000 + SIX_H;
      expect(r.reg.sweep().released).toBe(1);
    }
  });
});

describe("cap", () => {
  it("refuses beyond the cap with the limit and the held count, changing nothing", () => {
    const { reg } = rig({ cap: 3 });
    expect(reg.acquireWrite(A, ["/w1/src/a.ts", "/w1/src/b.ts", "/w1/src/c.ts"]).ok).toBe(true);
    const before = reg.snapshot();
    expect(reg.acquireWrite(B, "/w1/src/d.ts")).toEqual({ ok: false, reason: "cap", limit: 3, held: 3 });
    expect(reg.snapshot()).toEqual(before);
  });

  it("is all-or-nothing when an array would cross the cap", () => {
    const { reg } = rig({ cap: 3 });
    reg.acquireWrite(A, ["/w1/src/a.ts", "/w1/src/b.ts"]);
    expect(reg.acquireWrite(B, ["/w1/src/c.ts", "/w1/src/d.ts"])).toEqual({ ok: false, reason: "cap", limit: 3, held: 2 });
    expect(reg.snapshot().leases).toHaveLength(2);
    expect(reg.snapshot().holders.map((holder) => holder.holderID)).toEqual(["A"]);
    expect(reg.acquireWrite(B, "/w1/src/c.ts")).toMatchObject({ ok: true });
  });

  it("sweeps once and succeeds when that frees room", () => {
    const { reg, clock } = rig({ cap: 2 });
    reg.acquireWrite(A, ["/w1/src/a.ts", "/w1/src/b.ts"]);
    expect(reg.acquireWrite(B, "/w1/src/c.ts")).toMatchObject({ ok: false, reason: "cap" });
    clock.now = 1_000 + SIX_H;
    expect(reg.acquireWrite(B, "/w1/src/c.ts")).toEqual({ ok: true, leased: ["/w1/src/c.ts"], reentrant: [], unkeyed: [] });
    expect(reg.snapshot().holders.map((holder) => holder.holderID)).toEqual(["B"]);
  });

  it("sweeps, then refuses with the post-sweep count when it is still not enough", () => {
    const { reg, clock } = rig({ cap: 2 });
    reg.acquireWrite(A, "/w1/src/a.ts");
    clock.now = 1_000 + SIX_H - 1;
    reg.acquireWrite(C, "/w2/src/b.ts");
    clock.now = 1_000 + SIX_H;
    expect(reg.acquireWrite(B, ["/w1/src/c.ts", "/w1/src/d.ts"])).toEqual({ ok: false, reason: "cap", limit: 2, held: 1 });
    expect(reg.snapshot().holders.map((holder) => holder.holderID)).toEqual(["C"]);
  });

  it("defaults to 10 000 leases", () => {
    const { reg } = rig();
    const paths = Array.from({ length: 10_000 }, (_, index) => `/w1/src/f${index}.ts`);
    const filled = reg.acquireWrite(A, paths);
    expect(filled.ok).toBe(true);
    if (!filled.ok) throw new Error("expected ok");
    expect(filled.leased).toHaveLength(10_000);
    expect(reg.acquireWrite(B, "/w1/src/extra.ts")).toEqual({ ok: false, reason: "cap", limit: 10_000, held: 10_000 });
    expect(reg.acquireWrite(A, paths.slice(0, 5))).toMatchObject({ ok: true, leased: [] });
    expect(reg.acquireWrite(A, "/w1/src/extra.ts")).toMatchObject({ ok: false, reason: "cap" });
  });

  it("does not record a holder whose only attempt was refused by the cap", () => {
    const { reg } = rig({ cap: 1 });
    reg.acquireWrite(A, X);
    reg.acquireWrite(B, "/w1/src/y.ts");
    expect(reg.snapshot().holders.map((holder) => holder.holderID)).toEqual(["A"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Snapshot and restore.
// ---------------------------------------------------------------------------------------------------------------------

describe("snapshot and restore", () => {
  function populated(opts: Partial<LeaseOptions> = {}): Rig {
    const r = rig(opts);
    r.reg.acquireWrite(A, [X, "/w1/src/y.ts"]);
    r.clock.now = 2_000;
    r.reg.acquireWrite(child("I", "/w2", { scope: "until-integrated", taskRef: "T1" }), "/w2/src/z.ts");
    r.reg.acquireWrite(child("O", "/out"), "/out/src/f.ts");
    r.clock.now = 3_000;
    return r;
  }

  it("round-trips through JSON into a fresh registry", () => {
    const { reg, clock } = populated();
    const snap = JSON.parse(JSON.stringify(reg.snapshot())) as LeaseSnapshot;
    expect(snap.version).toBe(1);
    expect(snap.takenAt).toBe(3_000);
    expect(snap.holders.map((holder) => holder.holderID)).toEqual(["A", "I", "O"]);
    expect(snap.leases).toHaveLength(4);
    expect(pick(snap.leases, 0)).toEqual({ logical: REL_X_KEY, physical: X, tree: "/w1", holderID: "A", display: X });
    const outside = snap.leases.find((lease) => lease.holderID === "O");
    expect(outside).toEqual({ logical: "x:/out/src/f.ts", physical: "/out/src/f.ts", tree: null, holderID: "O", display: "/out/src/f.ts" });

    const second = rig({ runMode: "refuse" });
    second.clock.now = clock.now;
    expect(second.reg.restore(snap)).toEqual({ ok: true, leases: 4 });
    expect(second.reg.snapshot()).toEqual(snap);
    expect(second.fs.calls).toEqual([]);
  });

  it("rebuilds every index so the restored registry behaves like the original", () => {
    const { reg } = populated();
    const second = rig({ runMode: "refuse" });
    second.reg.restore(reg.snapshot());
    expect(second.reg.acquireWrite(B, X)).toMatchObject({ ok: false, reason: "held" });
    expect(second.reg.checkRead(actor(B), X)).toMatchObject({ ok: false, reason: "underEdit" });
    expect(second.reg.checkRun(actor(B), "/w1")).toMatchObject({ ok: false, reason: "run-refused", fileCount: 2 });
    expect(second.reg.releaseTask("T1")).toEqual({ released: 1, holders: ["I"] });
    expect(second.reg.release("A")).toEqual({ released: 2, retained: 0 });
    expect(second.reg.release("O")).toEqual({ released: 1, retained: 0 });
    expect(second.reg.snapshot().leases).toEqual([]);
  });

  it("returns copies, so editing a snapshot does not touch the registry", () => {
    const { reg } = populated();
    const snap = reg.snapshot();
    pick(snap.holders, 0).tree = "/elsewhere";
    expect(pick(reg.snapshot().holders, 0).tree).toBe("/w1");
    expect(reg.checkRead(actor(B), X)).toMatchObject({ ok: false, holders: [{ tree: "/w1" }] });
  });

  it("replaces the state of the registry it restores into", () => {
    const { reg } = populated();
    const snap = reg.snapshot();
    const other = rig();
    other.reg.acquireWrite(child("W", "/w1"), "/w1/src/w.ts");
    expect(other.reg.restore(snap)).toEqual({ ok: true, leases: 4 });
    expect(other.reg.snapshot().holders.map((holder) => holder.holderID)).toEqual(["A", "I", "O"]);
    expect(other.reg.acquireWrite(B, "/w1/src/w.ts")).toMatchObject({ ok: true });
    expect(other.reg.restore({ version: 1, takenAt: 0, holders: [], leases: [] })).toEqual({ ok: true, leases: 0 });
    expect(other.reg.snapshot().leases).toEqual([]);
  });

  const corruptions: [string, (s: LeaseSnapshot) => unknown][] = [
    ["null", () => null],
    ["a string", () => "snapshot"],
    ["an array", () => []],
    ["version 2", (s) => ({ ...s, version: 2 })],
    ["a missing version", (s) => ({ holders: s.holders, leases: s.leases, takenAt: s.takenAt })],
    ["a string takenAt", (s) => ({ ...s, takenAt: "now" })],
    ["a NaN takenAt", (s) => ({ ...s, takenAt: Number.NaN })],
    ["holders that are not an array", (s) => ({ ...s, holders: {} })],
    ["leases that are not an array", (s) => ({ ...s, leases: "none" })],
    ["a holder that is not an object", (s) => ({ ...s, holders: [null] })],
    ["a holder with an empty id", (s) => ({ ...s, holders: [{ ...pick(s.holders, 0), holderID: "" }] })],
    ["a root holder", (s) => ({ ...s, holders: [{ ...pick(s.holders, 0), isChild: false }] })],
    ["an until-integrated holder without taskRef", (s) => ({ ...s, holders: [{ ...pick(s.holders, 0), scope: "until-integrated" }] })],
    ["a holder without acquiredAt", (s) => ({ ...s, holders: [{ holderID: "A", tree: "/w1", isChild: true, scope: "until-complete" }] })],
    ["a holder with a non-finite acquiredAt", (s) => ({ ...s, holders: [{ ...pick(s.holders, 0), acquiredAt: Number.POSITIVE_INFINITY }] })],
    ["a duplicate holder", (s) => ({ ...s, holders: [pick(s.holders, 0), pick(s.holders, 0)] })],
    ["a lease that is not an object", (s) => ({ ...s, leases: [7] })],
    ["a lease without a logical key", (s) => ({ ...s, leases: [{ ...pick(s.leases, 0), logical: "" }] })],
    ["a lease with a numeric logical key", (s) => ({ ...s, leases: [{ ...pick(s.leases, 0), logical: 5 }] })],
    ["a lease without a physical path", (s) => ({ ...s, leases: [{ ...pick(s.leases, 0), physical: undefined }] })],
    ["a lease without a display path", (s) => ({ ...s, leases: [{ ...pick(s.leases, 0), display: 5 }] })],
    ["a lease with a numeric tree", (s) => ({ ...s, leases: [{ ...pick(s.leases, 0), tree: 5 }] })],
    ["a lease without a holderID", (s) => ({ ...s, leases: [{ ...pick(s.leases, 0), holderID: undefined }] })],
    ["a lease of an unknown holder", (s) => ({ ...s, leases: [{ ...pick(s.leases, 0), holderID: "ghost" }] })],
    ["a duplicate lease", (s) => ({ ...s, leases: [pick(s.leases, 0), pick(s.leases, 0)] })],
  ];
  for (const [name, corrupt] of corruptions) {
    it(`rejects ${name} and leaves the state unchanged`, () => {
      const { reg } = populated();
      const before = reg.snapshot();
      const result = reg.restore(corrupt(before));
      expect(result).toMatchObject({ ok: false, reason: "invalid-snapshot" });
      if (result.ok) throw new Error("expected rejection");
      expect(result.message.length).toBeGreaterThan(0);
      expect(reg.snapshot()).toEqual(before);
      expect(reg.acquireWrite(B, X)).toMatchObject({ ok: false, reason: "held" });
    });
  }

  it("rejects a snapshot that exceeds the cap, and accepts one exactly at it", () => {
    const { reg } = populated();
    const snap = reg.snapshot();
    const small = rig({ cap: 3 });
    expect(small.reg.restore(snap)).toMatchObject({ ok: false, reason: "invalid-snapshot", message: expect.stringMatching(/cap of 3/) });
    expect(small.reg.snapshot().leases).toEqual([]);
    expect(rig({ cap: 4 }).reg.restore(snap)).toEqual({ ok: true, leases: 4 });
  });

  it("restores a taskRef-less holder with no leases", () => {
    const { reg } = rig();
    const snap: LeaseSnapshot = {
      version: 1,
      takenAt: 1,
      holders: [{ holderID: "A", tree: "/w1", isChild: true, scope: "until-complete", acquiredAt: 0 }],
      leases: [],
    };
    expect(reg.restore(snap)).toEqual({ ok: true, leases: 0 });
    expect(reg.release("A")).toEqual({ released: 0, retained: 0 });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// formatRunNote.
// ---------------------------------------------------------------------------------------------------------------------

describe("formatRunNote", () => {
  const holder = (holderID: string): Holder => ({ ...holderA, holderID, scope: "until-complete" });

  it("renders the exact note for one holder", () => {
    expect(formatRunNote([holder("A")], 3)).toBe("[router] ran while A edits 3 file(s); result may be contaminated");
  });

  it("joins holder ids with a comma and a space, accepting Holder objects and plain ids", () => {
    expect(formatRunNote([holder("A"), "B", holder("C")], 1)).toBe(
      "[router] ran while A, B, C edits 1 file(s); result may be contaminated",
    );
  });

  it("matches what checkRun reports", () => {
    const { reg } = holdingX();
    const run = reg.checkRun(actor(B), "/w1");
    if (!run.ok || !("contaminatedBy" in run)) throw new Error("expected a contaminated run");
    expect(formatRunNote(run.contaminatedBy, run.fileCount)).toBe(
      "[router] ran while A edits 1 file(s); result may be contaminated",
    );
  });
});
